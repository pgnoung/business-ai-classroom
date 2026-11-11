// brain-flag-off.test.mjs — "แฟล็กปิด = เหมือนก่อนมีเฟส 1b ทุกตัวอักษร"
//
// นี่คือคำสัญญาที่ทั้งการ deploy คืนนี้ตั้งอยู่บน: KNOWLEDGE_VERSIONED ปิดโดยค่าเริ่มต้น
// และทางถอยของเฟสนี้คือ "ปิดแฟล็ก" ถ้าคำสัญญานี้ไม่จริงแม้แต่ข้อเดียว ทางถอยก็ไม่มีอยู่จริง
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { knowledgeDigest } from "../src/learningDigest.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const QUIET = { warn() {}, debug() {}, log() {} };
const SECRET = "brain-flag-off-console-secret-0123456789";
const PASSWORD = "brain-flag-off-pass-1234";
const TODAY = todayInBangkok(Date.now());

async function boot(t, { versioned = false } = {}) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SECRET,
    KNOWLEDGE_VERSIONED: versioned ? "true" : "false",
  });
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.addKnowledge({ title: "แคตตาล็อกคลาส", content: "คลาส AI Agent for Business", updatedBy: "ngoung" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบสอนสด", product: "AI Agent for Business", status: "open", capacity: 15 },
  ]));
  // นำเข้าสมองรุ่นแรกไว้ (เหมือนเครื่องจริงคืนนี้: มีรุ่นสมองอยู่แล้ว แต่แฟล็กยังปิด)
  assert.equal(importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY }).created, true);
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

const post = (server, path, body, headers = {}) => httpRequest(server, {
  method: "POST", path,
  headers: { "content-type": "application/json", ...headers },
  body: body === undefined ? null : JSON.stringify(body),
});
const get = (server, path, headers = {}) => httpRequest(server, { path, headers });

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}
const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

/* ---------------- ข้อ 1: ปุ่มของรุ่นสมองต้องปิดตายเมื่อแฟล็กปิด ---------------- */

test("แฟล็กปิด: ปุ่มย้อนกลับ/เลื่อนขั้น/รับทราบ/มอบสิทธิ์ ตอบ 409 และไม่แตะตารางเดิมเลย", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const live = db.getBrainPointer("live");
  const before = {
    pointer: live.version_id,
    knowledge: db.listKnowledge().map((row) => `${row.id}:${row.content}:${row.active}`).sort(),
    prices: JSON.stringify(db.approvedPrices()),
    rules: db.getSetting(PRODUCT_RULES_KEY),
  };

  for (const path of [
    `/console/api/brain/versions/${live.version_id}/rollback`,
    `/console/api/brain/versions/${live.version_id}/promote`,
    `/console/api/brain/versions/${live.version_id}/ack`,
    "/console/api/brain/delegation",
  ]) {
    const res = await post(app.server, path, { roles: ["operator"], kinds: ["fact"], days: 30 }, auth(owner));
    assert.equal(res.status, 409, `${path} ต้องถูกปฏิเสธขณะแฟล็กปิด — ${res.status} ${res.text}`);
    assert.match(res.json.error, /แฟล็กสมองยังปิดอยู่/u);
  }

  assert.equal(db.getBrainPointer("live").version_id, before.pointer, "pointer ต้องไม่ขยับ");
  assert.deepEqual(db.listKnowledge().map((row) => `${row.id}:${row.content}:${row.active}`).sort(), before.knowledge);
  assert.equal(JSON.stringify(db.approvedPrices()), before.prices);
  assert.equal(db.getSetting(PRODUCT_RULES_KEY), before.rules);
  assert.equal(db.getSetting("brain_delegation"), null, "มอบสิทธิ์ขณะแฟล็กปิดไม่ได้");
});

test("แฟล็กปิด: GET ประวัติยังอ่านได้ แต่ไม่คอมไพล์หาผลตรวจ และหน้าเว็บไม่วาดแผง", async (t) => {
  const { app, db } = await boot(t);
  // ใส่หนี้ที่ "ถ้าคอมไพล์จริงจะต้องเห็น" เข้าไปในรุ่น live ก่อน — ไม่งั้นผลว่างเพราะไม่มีอะไรผิด
  // ไม่ใช่เพราะไม่ได้คอมไพล์ แล้วเทสต์จะผ่านทั้งที่โค้ดยังคอมไพล์ทิ้งทุกครั้งที่เปิดหน้า
  db.addKnowledge({ title: "โปรเก่า", content: "เคยลดเหลือ 9,500 บาท", updatedBy: "ngoung" });
  assert.equal(importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY }).created, true);
  const owner = await login(app.server, "ngoung");
  const res = await get(app.server, "/console/api/brain/versions", auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.enabled, false);
  assert.equal(res.json.versions.length, 2, "ประวัติยังอ่านได้");
  assert.deepEqual(res.json.findings, { live: [], canary: [] }, "แฟล็กปิดต้องไม่คอมไพล์สมองทิ้ง");
});

/* ------------- ข้อ 3: response ตอนแฟล็กปิดต้องเป็นรูปเดิมเป๊ะ ไม่มีคีย์ใหม่ ------------- */

test("แฟล็กปิด: ทุก response ต้องไม่มีคีย์ brain ติดไปด้วย และคิวเก็บรูปเดิมลง result_json", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const direct = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  assert.equal(direct.status, 200, direct.text);
  assert.equal(direct.json.brain, undefined, "แฟล็กปิดต้องไม่มีคีย์ brain ใน response");
  assert.ok(direct.json.entry?.id, "รูป response เดิมต้องครบเหมือนเดิม");

  const price = await post(app.server, "/console/api/prices", { label: "Early Bird", amount: 12900 }, auth(owner));
  assert.equal(price.json.brain, undefined);
  const rules = await post(app.server, "/console/api/settings/product-rules", { rules: "กติกาใหม่" }, auth(owner));
  assert.equal(rules.json.brain, undefined);

  // คิว Package K เก็บ payload ลง result_json — ต้องไม่มีฟิลด์ใหม่ปนเข้าไปด้วย
  const queued = await post(app.server, "/console/api/knowledge",
    { title: "ทางเข้า", content: "เข้าทางล็อบบี้ชั้น 1" }, auth(staff));
  assert.equal(queued.status, 202, queued.text);
  const approved = await post(app.server,
    `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  assert.equal(approved.json.applied, true, approved.text);
  const row = db.getPublishRequest(queued.json.requestId);
  const result = JSON.parse(row.result_json);
  assert.equal(result.payload.brain, undefined, "result_json ต้องเป็นรูปเดิมของ base");
  assert.ok(result.payload.entry?.id);
});

/* ------------- ข้อ 2: audit ที่เขียนไม่สำเร็จตอนแฟล็กปิด ต้องยังพังเสียงดัง ------------- */

test("แฟล็กปิด: audit เขียนไม่สำเร็จต้องได้ 500 เหมือนเดิม ไม่ใช่ 200 ที่ไม่มีหลักฐาน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const realAddAudit = db.addAudit.bind(db);
  db.addAudit = (row) => {
    if (row?.action === "price_add") throw new Error("audit table is full");
    return realAddAudit(row);
  };
  t.after(() => { db.addAudit = realAddAudit; });

  const res = await post(app.server, "/console/api/prices", { label: "ทดสอบ", amount: 100 }, auth(owner));
  assert.equal(res.status, 500, `ต้องดังเหมือน base ไม่ใช่กลืนไว้ — ${res.status} ${res.text}`);
});

/* ------------- ข้อ 4: console + nested learning apply must close atomically ------------- */

test("แฟล็กปิด: อนุมัติข้อเสนอการเรียนรู้แล้วต้องไม่มีธุรกรรมค้างเปิดอยู่", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const learningRun = db.createLearningRun({ dayKey: "2026-09-03" });
  const candidate = db.createLearningCandidate({
    runId: learningRun.id, dayKey: "2026-09-03", clusterKey: "parking",
    title: "ที่จอดรถ", proposedContent: "จอดฟรี 4 ชั่วโมง", knowledgeDigest: knowledgeDigest(db),
  });
  // The hook owns BEGIN IMMEDIATE for data + audit. Learning's nested savepoint
  // must close before that outer transaction commits.
  const realExec = db.raw.exec.bind(db.raw);
  const sql = [];
  db.raw.exec = (text) => { sql.push(String(text)); return realExec(text); };
  t.after(() => { db.raw.exec = realExec; });

  const res = await post(app.server, `/console/api/learning/${candidate.id}/decide`,
    { action: "approve" }, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.ok(sql.includes("BEGIN IMMEDIATE"), `ต้องจับ write lock ทันทีเหมือน base — ${JSON.stringify(sql)}`);
  assert.ok(sql.includes("COMMIT"));
  assert.ok(sql.includes("SAVEPOINT learning_apply"));
  assert.ok(sql.includes("RELEASE learning_apply"));
  assert.ok(sql.indexOf("BEGIN IMMEDIATE") < sql.indexOf("SAVEPOINT learning_apply"));
  assert.ok(sql.indexOf("RELEASE learning_apply") < sql.lastIndexOf("COMMIT"));
  assert.equal(db.raw.isTransaction, false, "ธุรกรรมต้องถูกปิดแล้ว");
  assert.equal(db.getLearningCandidate(candidate.id).status, "approved");
});
