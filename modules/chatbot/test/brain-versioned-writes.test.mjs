// brain-versioned-writes.test.mjs — เฟส 1b: ทุกการเขียนในคอนโซลสร้างเวอร์ชันสมอง
//
// ของศักดิ์สิทธิ์ของไฟล์นี้คือ **parity**: จนกว่าจะถึง P2 runtime ยังอ่านตารางเดิม ดังนั้น
// หลังการเขียนทุกชนิด "เวอร์ชันที่ pointer live ชี้อยู่" ต้องคอมไพล์ออกมาได้ตรงกับสิ่งที่
// เส้นเดิมประกอบจากตารางเดิมทุกไบต์ ไม่ว่าผลของด่านจะเป็นอะไร:
//   - ผ่าน + เจ้าของกด -> ตารางเดิมเปลี่ยน และ live ชี้รุ่นใหม่ที่ตรงกับตารางนั้น
//   - ผ่าน + สิทธิ์ที่มอบมา -> ตารางเดิม "ไม่ขยับ" รุ่นใหม่อยู่ที่ canary, live ยังตรงเหมือนเดิม
//   - ต้องรับทราบ / ถูกบล็อก -> ตารางเดิมไม่ขยับ
//
// ยิง HTTP จริงทั้งไฟล์ ด้วยเหตุผลเดียวกับ owner-only-brain-publishing: ปุ่มที่หายไปจาก
// หน้าเว็บไม่ใช่การป้องกัน และเส้นทางจริงต้องเดินผ่าน handler ตัวเดียวกับที่คิว K เล่นซ้ำ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { brainParityReport } from "../src/brain/parity.mjs";
import { writeBrainDelegation } from "../src/brain/delegation.mjs";
import { createBrainWriteHook, DELEGATED_PUBLISH_CLOSED_MESSAGE } from "../src/brain/writeHook.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";
import { REVIEW_ENTRY_TITLE_MATCH } from "../src/reviewCatalogDoc.mjs";
import { knowledgeDigest } from "../src/learningDigest.mjs";
import { compileBrain } from "../src/brain/compile.mjs";
import { FREECLASS_PATTERNS_KEY } from "../src/db.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const SECRET = "brain-versioned-console-secret-0123456789";
const PASSWORD = "brain-versioned-pass-1234";
const QUIET = { warn() {}, debug() {}, log() {} };
const TODAY = todayInBangkok(Date.now());

async function boot(t, { versioned = true, debt = false } = {}) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SECRET,
    KNOWLEDGE_VERSIONED: versioned ? "true" : "false",
  });
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.addKnowledge({ title: "แคตตาล็อกคลาส", content: "คลาส AI Agent for Business สอนสด", updatedBy: "ngoung" });
  db.addKnowledge({ title: "วิธีสมัคร", content: "ทักแชทแล้วทีมงานส่งลิงก์ให้", updatedBy: "ngoung" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบสอนสด มกราคม", product: "AI Agent for Business", status: "open", capacity: 15 },
  ]));
  // "หนี้ความรู้" ของจริง: แถวที่มีอยู่ก่อนเปิดแฟล็ก แล้วถูกยกเข้าสมองรุ่นแรกไปทั้งอย่างนั้น
  // (ตัวนำเข้าห้ามแก้หรือทิ้งเนื้อหา ไม่งั้นสมองจะได้คนละไบต์กับ prompt วันนี้ทันที)
  if (debt) db.addKnowledge({ title: "โปรเก่า", content: "รุ่นก่อนลดเหลือ 9,500 บาท", updatedBy: "ngoung" });
  const imported = importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  assert.equal(imported.created, true, "ต้องนำเข้าสมองรุ่นแรกได้ก่อนเริ่มเทสต์");
  assertParity(db, "หลังนำเข้า");

  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

// หัวใจของไฟล์: เวอร์ชัน live คอมไพล์แล้วต้องตรงกับตารางเดิม ณ วินาทีนี้ ทุกส่วน
function assertParity(db, where) {
  const report = brainParityReport(db, { todayIso: TODAY, logger: QUIET });
  assert.equal(report.ok, true, `${where}: parity ต้องตรง — ${report.reason} ${JSON.stringify(report.mismatches)}`);
  return report;
}

function livePointer(db) {
  return db.getBrainPointer("live");
}

function send(server, method, path, body, headers = {}) {
  return httpRequest(server, {
    method, path,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });
}
const post = (server, path, body, headers) => send(server, "POST", path, body, headers);
const put = (server, path, body, headers) => send(server, "PUT", path, body, headers);
const del = (server, path, headers = {}) => httpRequest(server, { method: "DELETE", path, headers });

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, `ล็อกอิน ${username} ต้องผ่าน — ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}
const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

/* ---------------- ก. การเขียนทุกชนิดของเจ้าของ -> รุ่นใหม่ + parity ยังตรง ---------------- */

test("การเขียนทุกชนิดของเจ้าของสร้างรุ่นสมองใหม่ ชี้ live และ parity ยังตรงทุกครั้ง", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const startSeq = livePointer(db).seq;
  const knowledgeId = db.listKnowledge()[0].id;

  const steps = [
    ["เพิ่มความรู้", () => post(app.server, "/console/api/knowledge",
      { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner))],
    ["แก้ความรู้", () => post(app.server, `/console/api/knowledge/${knowledgeId}`,
      { content: "คลาส AI Agent for Business สอนสดที่กรุงเทพ" }, auth(owner))],
    ["ปิดสวิตช์ความรู้", () => post(app.server, `/console/api/knowledge/${knowledgeId}`,
      { active: false }, auth(owner))],
    ["เพิ่มราคา", () => post(app.server, "/console/api/prices",
      { label: "Early Bird", amount: 12900 }, auth(owner))],
    ["แก้ราคา", () => post(app.server, `/console/api/prices/${encodeURIComponent("Early Bird")}`,
      { amount: 11900 }, auth(owner))],
    ["ลบราคา", () => del(app.server, `/console/api/prices/${encodeURIComponent("Early Bird")}`, auth(owner))],
    ["กติกาสินค้า", () => post(app.server, "/console/api/settings/product-rules",
      { rules: "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ และเก็บชื่อบริษัทไว้ด้วย" }, auth(owner))],
    ["ลิงก์คลาสฟรี", () => post(app.server, "/console/api/settings/freeclass",
      { patterns: ["https://line.me/freeclass-2026"] }, auth(owner))],
    ["คีย์เวิร์ด #", () => post(app.server, "/console/api/settings/hashtag",
      { enabled: true, businessKeywords: {
        claude10x: {
          seed: "ขอรับไฟล์ Claude Project Setup",
          note: "ไฟล์ที่ผู้ดูแลยืนยัน",
          deliveryText: "รับไฟล์ได้ที่ https://drive.google.com/example",
        },
      } }, auth(owner))],
    ["เพิ่มรอบเรียน", () => post(app.server, "/console/api/class-rounds/round",
      { date: "2099-03-05", label: "รอบสอนสด มีนาคม", product: "AI Agent for Business", capacity: 20 }, auth(owner))],
    ["ลบรอบเรียน", () => post(app.server, "/console/api/class-rounds/round-delete",
      { date: "2099-03-05" }, auth(owner))],
  ];

  let seenVersions = 0;
  for (const [label, run] of steps) {
    const res = await run();
    assert.equal(res.status, 200, `${label} ต้องสำเร็จ — ${res.text}`);
    assert.equal(res.json?.brain?.outcome, "live", `${label} ต้องเผยแพร่เป็นรุ่นใช้งานจริง — ${res.text}`);
    seenVersions += 1;
    // ข้อที่ห้ามพลาด: หลังการเขียนทุกครั้ง สมองรุ่น live ต้องยังตรงกับตารางเดิมทุกไบต์
    assertParity(db, label);
    assert.equal(livePointer(db).version_id, res.json.brain.versionId, `${label}: pointer ต้องชี้รุ่นที่เพิ่งสร้าง`);
  }

  const campaign = JSON.parse(db.getSetting("hashtag_business_keywords")).claude10x;
  assert.equal(campaign.deliveryText, "รับไฟล์ได้ที่ https://drive.google.com/example",
    "versioned write ต้องเก็บ deliveryText โดยไม่ตัดทิ้ง");

  // โหมดสมอง/ข้อความเสริมยังไม่ใช่การ์ด -> ต้องบอกตรง ๆ ว่า "สมองไม่เปลี่ยน" ไม่ใช่แกล้งออกรุ่นใหม่
  const brainSetting = await post(app.server, "/console/api/settings/brain/default",
    { mode: "shared", addendum: "สาขานี้เน้นลูกค้าองค์กร" }, auth(owner));
  assert.equal(brainSetting.status, 200, brainSetting.text);
  assert.equal(brainSetting.json?.brain?.outcome, "unchanged");
  assert.equal(db.getSetting("brain_addendum:default"), "สาขานี้เน้นลูกค้าองค์กร", "ของต้องถูกบันทึกจริง");
  assertParity(db, "โหมดสมอง/addendum");

  assert.equal(livePointer(db).seq, startSeq + seenVersions, "ต้องมีรุ่นใหม่หนึ่งใบต่อการเขียนหนึ่งครั้ง");
  assert.equal(db.listBrainVersions(50).filter((v) => v.pointer === "live").length, 1, "live ต้องมีใบเดียวเสมอ");
});

/* ------------------------- ข. ด่านบล็อก = ของเดิมไม่ขยับเลย ------------------------- */

test("ด่านบล็อก -> ตารางเดิมไม่ถูกแตะ ไม่มีรุ่นใหม่ และข้อความปฏิเสธเป็นภาษาคน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const before = { live: livePointer(db).version_id, count: db.listKnowledge().length };

  const res = await post(app.server, "/console/api/knowledge",
    { title: "โปรลับ", content: "ลูกค้าเก่าลดเหลือ 12,345 บาท" }, auth(owner));

  assert.equal(res.status, 409, `ต้องถูกปฏิเสธ — ${res.text}`);
  assert.equal(res.json?.brain?.outcome, "blocked");
  assert.match(res.json.error, /12,345/u, "ต้องบอกว่าตัวเลขไหนเป็นปัญหา");
  assert.equal(db.listKnowledge().length, before.count, "แถวความรู้ต้องไม่ถูกเขียนเลย");
  assert.equal(livePointer(db).version_id, before.live, "pointer ต้องไม่ขยับ");
  assert.equal(db.listBrainVersions(50).length, 1, "ห้ามเหลือรุ่นขยะไว้ในประวัติ");
  assert.ok(db.listAudit().some((row) => row.action === "brain_write_blocked"), "การถูกบล็อกต้องไม่เงียบ");
  assertParity(db, "หลังถูกบล็อก");
});

/* --------------------- ค. หนี้ความรู้เดิม -> ต้องรับทราบก่อนใช้งาน --------------------- */

test("หนี้ที่มีอยู่ก่อน -> รุ่นถูกเก็บเป็น proposed ตารางเดิมไม่ขยับ จนกว่าเจ้าของจะรับทราบ", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");

  const res = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  assert.equal(res.status, 409, res.text);
  assert.equal(res.json?.brain?.outcome, "needs_ack");
  const versionId = res.json.brain.versionId;
  assert.ok(versionId, "ต้องบอกเลขรุ่นที่รอรับทราบ");
  assert.equal(db.getBrainVersion(versionId).status, "proposed");
  assert.equal(db.getBrainVersion(versionId).pointer, null, "รุ่นที่ยังไม่รับทราบต้องไม่ถูกชี้");
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), false,
    "ตารางเดิมต้องไม่ถูกแตะจนกว่าจะรับทราบ");
  assertParity(db, "ระหว่างรอรับทราบ");
});

/* ----------------------- ง. สิทธิ์ที่มอบให้ทีมงาน -> canary เท่านั้น ----------------------- */

test("ไม่มีสิทธิ์สีเขียว: ทีมงานยังเข้าคิวขออนุมัติเหมือนเดิมทุกอย่าง", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const res = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  assert.equal(res.status, 202, `ต้องเข้าคิว — ${res.text}`);
  assert.equal(db.listBrainVersions(50).length, 1, "คำขอที่ยังไม่อนุมัติต้องไม่สร้างรุ่นสมอง");
  assertParity(db, "คำขอเข้าคิว");
});

test("มอบสิทธิ์ไว้แล้วก็ยังไม่เปิดใช้ในเฟสนี้: ทีมงานตกกลับไปเข้าคิว ไม่ได้รุ่นทดลอง", async (t) => {
  // คำตัดสินของเฟสนี้: รุ่นทดลองยังไม่มีความหมายจนกว่า runtime จะอ่านสมองใน P2
  // ปล่อยให้ทีมงานกดแล้วได้รุ่นทดลอง = บอกว่า "บันทึกแล้ว" กับของที่ไม่มีวันถึงลูกค้าเลย
  const { app, db } = await boot(t);
  writeBrainDelegation(db, { roles: ["operator"], kinds: ["fact"], days: 90, by: "ngoung" });
  const staff = await login(app.server, "chompoo");
  const liveBefore = livePointer(db).version_id;

  const res = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  assert.equal(res.status, 202, `ต้องตกกลับไปเข้าคิวขออนุมัติ — ${res.status} ${res.text}`);
  assert.equal(res.json.queued, true);
  assert.equal(db.getBrainPointer("canary"), null, "ต้องไม่มีเส้นทางผู้ใช้ที่ผลิตรุ่นทดลองได้");
  assert.equal(livePointer(db).version_id, liveBefore, "live ต้องไม่ขยับ");
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), false);
  assertParity(db, "หลังทีมงานส่งคำขอ");
});

test("ถ้ามีการเขียนที่หลุดมาถึง hook ด้วยสิทธิ์ที่มอบมา ต้องปฏิเสธพร้อมบอกทางที่ถูก", async (t) => {
  const { app, db } = await boot(t);
  writeBrainDelegation(db, { roles: ["operator"], kinds: ["fact"], days: 90, by: "ngoung" });
  const staff = db.getOperator("chompoo");
  const hook = createBrainWriteHook({
    db, config: { knowledgeVersioned: true }, logger: { warn() {}, debug() {} },
  });
  const outcome = hook.apply({
    kind: "knowledge_add", operator: staff, username: "chompoo",
    audit: { action: "knowledge_add", target: "", detail: "ที่จอดรถ" },
    apply: () => db.addKnowledge({ title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง", updatedBy: "chompoo" }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.outcome, "delegation_closed");
  assert.equal(outcome.error, DELEGATED_PUBLISH_CLOSED_MESSAGE);
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), false, "ต้องไม่เขียนอะไรเลย");
  assertParity(db, "หลังปฏิเสธสิทธิ์ที่มอบมา");
  app.server.close();
});

test("สิทธิ์สีเขียวครอบราคาไม่ได้ ต่อให้แถว settings ถูกแก้ตรง ๆ", async (t) => {
  const { app, db } = await boot(t);
  const bad = writeBrainDelegation(db, { roles: ["operator"], kinds: ["price"], days: 90, by: "ngoung" });
  assert.equal(bad.ok, false, "โค้ดต้องปฏิเสธการมอบสิทธิ์ชนิดสีแดงตั้งแต่ตอนตั้งค่า");

  // แก้แถว settings ตรง ๆ ให้เหมือนมีคนไปยัดค่าลงฐาน
  db.setSetting("brain_delegation", JSON.stringify({
    roles: ["operator"], kinds: ["price", "fact"], expires_at: Date.now() + 86_400_000, set_by: "attacker",
  }));
  const staff = await login(app.server, "chompoo");
  const res = await post(app.server, "/console/api/prices", { label: "ลับ", amount: 999 }, auth(staff));
  assert.equal(res.status, 202, `ราคาต้องกลับไปเข้าคิวเสมอ — ${res.text}`);
  assert.equal(db.getApprovedPrice("ลับ"), null);
  assertParity(db, "หลังพยายามมอบสิทธิ์ราคา");
});

test("สิทธิ์สีเขียวหมดอายุแล้ว -> กลับไปเป็นคิวขออนุมัติเอง", async (t) => {
  const { app, db } = await boot(t);
  db.setSetting("brain_delegation", JSON.stringify({
    roles: ["operator"], kinds: ["fact"], expires_at: Date.now() - 1_000, set_by: "ngoung",
  }));
  const staff = await login(app.server, "chompoo");
  const res = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  assert.equal(res.status, 202, `หมดอายุแล้วต้อง fail-closed — ${res.text}`);
});

/* ------------------- จ. คิว Package K เดินผ่านด่านเดียวกันกับเจ้าของ ------------------- */

test("คิวขออนุมัติ: อนุมัติแล้วต้องเดินผ่านด่านเดียวกันและได้รุ่นใช้งานจริง", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const queued = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  assert.equal(queued.status, 202, queued.text);
  const approved = await post(app.server,
    `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.applied, true, `ต้องลงมือจริง — ${approved.text}`);
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), true);
  assert.equal(db.listBrainVersions(50).length, 2, "การอนุมัติต้องสร้างรุ่นสมองใหม่หนึ่งใบ");
  assert.equal(livePointer(db).seq, 2);
  assertParity(db, "หลังอนุมัติคำขอ");
});

test("คิวขออนุมัติ: คำขอที่ด่านไม่ผ่าน ต้องจบเป็น 'ทำรายการไม่สำเร็จ' ไม่ใช่เงียบ ๆ ผ่าน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const queued = await post(app.server, "/console/api/knowledge",
    { title: "โปรลับ", content: "ลูกค้าเก่าลดเหลือ 12,345 บาท" }, auth(staff));
  const approved = await post(app.server,
    `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  assert.equal(approved.json.applied, false, `ต้องไม่ถูกนำไปใช้ — ${approved.text}`);
  assert.match(String(approved.json.error || ""), /12,345/u);
  assert.equal(db.listKnowledge().some((row) => row.title === "โปรลับ"), false);
  assertParity(db, "หลังคำขอที่ด่านไม่ผ่าน");
});

/* --------------------------- ฉ. แฟล็กปิด = พฤติกรรมเดิมเป๊ะ --------------------------- */

test("แฟล็กปิด: คอนโซลเขียนตารางเดิมตรง ๆ ไม่มีรุ่นสมองใหม่ ไม่มีด่าน", async (t) => {
  const { app, db } = await boot(t, { versioned: false });
  const owner = await login(app.server, "ngoung");

  const ok = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.brain, undefined, "แฟล็กปิดต้องไม่มีคีย์ brain ใน response");
  assert.equal(db.listBrainVersions(50).length, 1, "แฟล็กปิดต้องไม่สร้างรุ่นใหม่");

  // ตัวเลขที่ด่านจะบล็อก ต้องผ่านได้เหมือนก่อนมีเฟส 1b (แต่ parity จะเตือนตอนบูตแทน)
  const money = await post(app.server, "/console/api/knowledge",
    { title: "โปรลับ", content: "ลูกค้าเก่าลดเหลือ 12,345 บาท" }, auth(owner));
  assert.equal(money.status, 200, money.text);
  assert.equal(db.listKnowledge().some((row) => row.title === "โปรลับ"), true);
  assert.ok(db.listAudit().some((row) => row.action === "knowledge_add"), "audit เดิมต้องยังอยู่ครบ");
});

/* --------------------- ช. ยังไม่เคยนำเข้าสมอง = ทำเหมือนวันนี้ --------------------- */

test("ยังไม่มีเวอร์ชันสมองเลย: เปิดแฟล็กแล้วคอนโซลต้องทำงานเหมือนเดิมทุกอย่าง", async (t) => {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, KNOWLEDGE_VERSIONED: "true" });
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.brain, undefined, "ยังไม่มีสมอง = ทางเดิมล้วน ต้องไม่มีคีย์ brain");
  assert.equal(db.listBrainVersions(50).length, 0);
});

/* ------------------------------ ซ. ค่าที่ตั้งค่าไว้ ------------------------------ */

test("ลิงก์คลาสฟรีที่บันทึกไปกับรุ่นใหม่ ต้องอ่านกลับได้จากตารางเดิมตัวเดียวกัน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, "/console/api/settings/freeclass",
    { patterns: ["https://line.me/freeclass-2026"] }, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(JSON.parse(db.getSetting(FREECLASS_PATTERNS_KEY)), ["https://line.me/freeclass-2026"]);
  assertParity(db, "ลิงก์คลาสฟรี");
});

/* --------------------- ฌ. เขียนทับด้วยค่าเดิม = ไม่ต้องมีรุ่นใหม่ --------------------- */

test("บันทึกค่าเดิมซ้ำ ไม่สร้างรุ่นใหม่ — ประวัติต้องไม่บวมด้วยรุ่นที่ไม่มีอะไรเปลี่ยน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const before = db.listBrainVersions(50).length;

  const same = await post(app.server, "/console/api/settings/product-rules",
    { rules: db.getSetting(PRODUCT_RULES_KEY) }, auth(owner));
  assert.equal(same.status, 200, same.text);
  assert.equal(same.json.brain.outcome, "unchanged");
  assert.equal(db.listBrainVersions(50).length, before, "ค่าเดิมซ้ำต้องไม่ออกรุ่นใหม่");
  assertParity(db, "บันทึกค่าเดิมซ้ำ");
});

/* ------------------- ญ. ข้อมูลตั้งต้นเสียจนอ่านการ์ดไม่ได้ = ปฏิเสธอย่างสุภาพ ------------------- */

test("อ่านข้อมูลตั้งต้นไม่ได้ -> ปฏิเสธพร้อมบอกว่าต้องไปแก้อะไร ไม่ใช่ 500", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  // รอบเรียนสองใบที่เหมือนกันทุกฟิลด์ = แยกเป็นคนละการ์ดไม่ได้ (sources.mjs โยนทิ้ง)
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "ซ้ำ", product: "AI Agent for Business", status: "open", capacity: 15 },
    { date: "2099-01-10", classKey: "onsite", label: "ซ้ำ", product: "AI Agent for Business", status: "open", capacity: 15 },
  ]));

  const res = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  assert.equal(res.status, 409, `ต้องเป็นการปฏิเสธที่อธิบายได้ ไม่ใช่ 500 — ${res.status} ${res.text}`);
  assert.match(res.json.error, /รอบเรียนซ้ำ/u);
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), false, "ตารางเดิมต้องไม่ถูกแตะ");
});

/* ------- ฎ. อีกสองทางที่เขียนคลังความรู้เหมือนกัน ต้องไม่หลุดจากจุดคอขวด ------- */

test("คลังรีวิว (งานประจำวันของทีม) เขียนได้เหมือนเดิม แต่ออกรุ่นสมองและ parity ยังตรง", async (t) => {
  const { app, db } = await boot(t);
  db.addKnowledge({
    title: `${REVIEW_ENTRY_TITLE_MATCH} แยกตามคลาส`,
    content: "วิธีใช้: หยิบรีวิวให้ตรงคลาส\n\n[Classroom : AI Agent For Business]\n- คุณเอ เจ้าของร้าน | รีวิว: https://www.facebook.com/reel/100000000000757\n",
    updatedBy: "ngoung",
  });
  // แถวรีวิวถูกเพิ่มตรงเข้าฐานหลังนำเข้า -> ต้องยกเข้าสมองก่อน ไม่งั้นด่านกัน drift ปฏิเสธ
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  const staff = await login(app.server, "chompoo");
  const owner = await login(app.server, "ngoung");
  assertParity(db, "หลังยกแถวรีวิวเข้าสมอง");
  const seqBefore = livePointer(db).seq;
  const payload = {
    sections: [{
      name: "Classroom : AI Agent For Business",
      items: [{ who: "คุณบี คลินิกความงาม", url: "https://www.facebook.com/share/v/1TstVb02Bb/" }],
    }],
  };

  // ข้อความรีวิวต่อตรงเข้า prompt เหมือนความรู้ใบอื่น — แฟล็กเปิดแล้วจึงใช้ด่านสิทธิ์ชุดเดียวกัน
  const queued = await put(app.server, "/console/api/reviews", payload, auth(staff));
  assert.equal(queued.status, 202, `แฟล็กเปิดแล้วรีวิวของทีมต้องเข้าคิว — ${queued.status} ${queued.text}`);
  const approved = await post(app.server,
    `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  assert.equal(approved.json.applied, true, approved.text);
  assert.equal(livePointer(db).seq, seqBefore + 1, "ต้องออกรุ่นสมองใหม่ ไม่ใช่เขียนตารางเดิมลอย ๆ");
  const saved = db.listKnowledge().find((row) => String(row.title).includes(REVIEW_ENTRY_TITLE_MATCH));
  assert.ok(saved.content.includes("คุณบี คลินิกความงาม"), "ต้องเขียนลงคลังจริง ไม่ใช่แค่ตอบ 200");
  assertParity(db, "หลังบันทึกคลังรีวิว");
});

test("อนุมัติข้อเสนอการเรียนรู้ ก็ต้องออกรุ่นสมองและรักษา parity เหมือนกัน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const learningRun = db.createLearningRun({ dayKey: "2026-09-03" });
  const candidate = db.createLearningCandidate({
    runId: learningRun.id, dayKey: "2026-09-03", clusterKey: "parking",
    title: "ที่จอดรถของสถานที่จัดคลาส",
    proposedContent: "จอดฟรีได้ 4 ชั่วโมง แจ้งชื่อที่เคาน์เตอร์",
    // ด่าน stale_knowledge ของ learningDigest: ข้อเสนอต้องถูกสร้างจากคลังชุดเดียวกับตอนอนุมัติ
    knowledgeDigest: knowledgeDigest(db),
  });
  assert.equal(candidate.status, "proposed", "แถวใหม่ต้องอยู่สถานะรออนุมัติตั้งแต่แรก");
  const seqBefore = livePointer(db).seq;

  const decided = await post(app.server, `/console/api/learning/${candidate.id}/decide`,
    { action: "approve" }, auth(owner));
  assert.equal(decided.status, 200, decided.text);
  assert.equal(decided.json.brain.outcome, "live", decided.text);
  assert.equal(livePointer(db).seq, seqBefore + 1);
  assertParity(db, "หลังอนุมัติข้อเสนอการเรียนรู้");
});

/* ---- ฏ. วาล์วนิรภัย "ย้อนการเรียนรู้ทั้งสัปดาห์" ก็เป็นทางเขียนตระกูลเดียวกัน ---- */

test("ย้อนการเรียนรู้ทั้งสัปดาห์: ออกรุ่นสมองใหม่ที่ไม่มีความรู้ก้อนนั้น และ parity ยังตรง", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");

  // ให้ระบบ "เรียน" มา 3 ก้อนผ่านเส้นจริง (แต่ละก้อนออกหนึ่งรุ่น)
  const learningRun = db.createLearningRun({ dayKey: "2026-09-03" });
  const learned = [];
  for (const [i, title] of ["ที่จอดรถ", "เวลาเปิดปิด", "ทางเข้าอาคาร"].entries()) {
    const candidate = db.createLearningCandidate({
      runId: learningRun.id, dayKey: "2026-09-03", clusterKey: `c${i}`,
      title, proposedContent: `รายละเอียดของ${title}`, knowledgeDigest: knowledgeDigest(db),
    });
    const res = await post(app.server, `/console/api/learning/${candidate.id}/decide`,
      { action: "approve" }, auth(owner));
    assert.equal(res.status, 200, res.text);
    learned.push(res.json.entry.id);
  }
  assertParity(db, "หลังเรียน 3 ก้อน");
  const seqBefore = livePointer(db).seq;

  const rolled = await post(app.server, "/console/api/learning/rollback-week",
    { confirm: "ROLLBACK" }, auth(owner));
  assert.equal(rolled.status, 200, rolled.text);
  assert.equal(rolled.json.deactivated, 3, "ต้องปิดครบทั้งสามก้อน");
  assert.equal(rolled.json.brain?.outcome, "live", `วาล์วนิรภัยต้องมีผลทันที ไม่ใช่รุ่นทดลอง — ${rolled.text}`);
  assert.equal(livePointer(db).seq, seqBefore + 1, "ต้องออกรุ่นสมองใหม่ ไม่ใช่หดตารางเดิมลอย ๆ");

  // รุ่น live ใหม่ต้องไม่ฉีดความรู้สามก้อนนั้นเข้า prompt อีก
  const live = compileBrain(db, livePointer(db).version_id, { todayIso: TODAY, logger: QUIET });
  for (const id of learned) {
    const card = live.cards.find((row) => row.itemId === `fact:${id}`);
    assert.equal(card?.inject, "never", `ความรู้ ${id} ต้องถูกปิดในรุ่นใหม่`);
  }
  assertParity(db, "หลังย้อนการเรียนรู้");
});

test("แฟล็กปิด: ย้อนการเรียนรู้ทั้งสัปดาห์ยังทำงานเหมือนเดิมทุกตัวอักษร", async (t) => {
  const { app, db } = await boot(t, { versioned: false });
  const owner = await login(app.server, "ngoung");
  const learningRun = db.createLearningRun({ dayKey: "2026-09-03" });
  const candidate = db.createLearningCandidate({
    runId: learningRun.id, dayKey: "2026-09-03", clusterKey: "off",
    title: "ที่จอดรถ", proposedContent: "จอดฟรี 4 ชั่วโมง", knowledgeDigest: knowledgeDigest(db),
  });
  await post(app.server, `/console/api/learning/${candidate.id}/decide`, { action: "approve" }, auth(owner));

  const versionsBefore = db.listBrainVersions(50).length;
  const rolled = await post(app.server, "/console/api/learning/rollback-week",
    { confirm: "ROLLBACK" }, auth(owner));
  assert.equal(rolled.status, 200, rolled.text);
  assert.equal(rolled.json.deactivated, 1);
  assert.equal(rolled.json.brain, undefined);
  assert.equal(db.listBrainVersions(50).length, versionsBefore, "แฟล็กปิดต้องไม่ออกรุ่นใหม่");
  assert.ok(db.listAudit().some((row) => row.action === "learning_rollback_week"), "audit เดิมต้องยังอยู่");
});

/* ---- ฐ. เส้นที่เขียน audit เองข้างใน apply ต้องไม่เงียบเมื่อผลไม่ใช่ live ---- */

test("ผลที่ไม่ใช่ live บนเส้นที่มี audit ของตัวเอง ต้องยังเหลือร่องรอยว่าเคยกด", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");

  const res = await post(app.server, "/console/api/settings/hashtag",
    { enabled: true, businessKeywords: { "#online": "สนใจคลาสออนไลน์" } }, auth(owner));
  assert.equal(res.json?.brain?.outcome, "needs_ack", res.text);
  // audit ของเส้นนี้ (สองแถว) ถูกยกเลิกไปพร้อมการเขียน — ต้องมีแถวสรุปผลมาแทน
  assert.equal(db.listAudit().some((row) => row.action === "hashtag_silence_toggle"), false,
    "ของที่ถูกยกเลิกต้องไม่ทิ้ง audit ที่บอกว่าทำสำเร็จ");
  const outcome = db.listAudit().find((row) => row.action === "brain_write_outcome");
  assert.ok(outcome, "ต้องมีแถวบอกว่าเคยกดและผลเป็นอะไร");
  assert.equal(outcome.target, "hashtag_rules");
  assert.match(outcome.detail, /needs_ack/u);
});
