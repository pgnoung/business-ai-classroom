// brain-version-console.test.mjs — ประวัติรุ่นสมอง + ปุ่มของเจ้าของ (เฟส 1b)
//
// ข้อที่ต้องกันให้ได้: ปุ่ม "ย้อนกลับ" และ "เลื่อนขั้นรุ่นทดลอง" ต้องเขียนตารางเดิมตามด้วย
// จนถึง P2 runtime ยังอ่านตารางเดิม — ปุ่มที่ขยับแค่ pointer คือปุ่มที่หน้าจอบอกว่าย้อนแล้ว
// แต่ลูกค้ายังได้ยินของเดิมทุกคำ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { brainParityReport } from "../src/brain/parity.mjs";
import { collectCurrentSourceCards } from "../src/brain/sources.mjs";
import { appendCardRevisions, BRAIN_CODE_CONTRACT } from "../src/brain/import.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const QUIET = { warn() {}, debug() {}, log() {} };
const SECRET = "brain-version-console-secret-0123456789";
const PASSWORD = "brain-version-console-pass-1234";
const TODAY = todayInBangkok(Date.now());

async function boot(t, { debt = false } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, KNOWLEDGE_VERSIONED: "true" });
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.addKnowledge({ title: "แคตตาล็อกคลาส", content: "คลาส AI Agent for Business สอนสด", updatedBy: "ngoung" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบสอนสด มกราคม", product: "AI Agent for Business", status: "open", capacity: 15 },
  ]));
  if (debt) db.addKnowledge({ title: "โปรเก่า", content: "รุ่นก่อนลดเหลือ 9,500 บาท", updatedBy: "ngoung" });
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

// เฟส 1b ปิดทางเผยแพร่ด้วยสิทธิ์ที่มอบมา จึงไม่มีเส้นทางผู้ใช้ที่ผลิตรุ่นทดลองได้เลย —
// กลไก canary ยังต้องถูกต้องเพราะ P2 จะเปิดใช้ เทสต์จึงสร้างรุ่นทดลองผ่าน store ตรง ๆ
function seedCanary(db, { title, content, by = "chompoo", delegated = true }) {
  return db.brainTransaction(() => {
    const live = db.getBrainPointer("live");
    db.raw.exec("SAVEPOINT seed_canary");
    const row = db.addKnowledge({ title, content, updatedBy: by });
    const cards = collectCurrentSourceCards(db, { logger: QUIET });
    db.raw.exec("ROLLBACK TO seed_canary");
    db.raw.exec("RELEASE seed_canary");
    const { revIds } = appendCardRevisions(db, cards, { createdBy: by, createdAt: Date.now() });
    const version = db.createBrainVersion({
      parentId: live.version_id, label: `${title} (รุ่นทดลอง)`, status: "draft", revIds,
      codeContract: BRAIN_CODE_CONTRACT, createdBy: by,
      teach: { source: "console", kind: "knowledge_add", delegated },
      gateReport: { verdict: "pass", kind: "test", findings: [] },
    });
    db.setBrainVersionStatus(version.version_id, "validated");
    db.setBrainPointer("canary", version.version_id, { changedBy: by });
    return { versionId: version.version_id, entryId: row.id };
  });
}

function assertParity(db, where) {
  const report = brainParityReport(db, { todayIso: TODAY, logger: QUIET });
  assert.equal(report.ok, true, `${where}: parity ต้องตรง — ${report.reason} ${JSON.stringify(report.mismatches)}`);
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

/* ------------------------------ ก. ประวัติรุ่น ------------------------------ */

test("ประวัติรุ่น: เห็นลำดับ ป้าย ใคร เมื่อไร ผลด่าน และรุ่นที่ใช้งานอยู่", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  await post(app.server, "/console/api/knowledge", { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));

  const res = await get(app.server, "/console/api/brain/versions", auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.enabled, true);
  assert.equal(res.json.canManage, true);
  assert.equal(res.json.versions.length, 2);
  const [newest, first] = res.json.versions;
  assert.equal(newest.seq, 2);
  assert.equal(newest.pointer, "live");
  assert.equal(newest.verdict, "pass");
  assert.equal(newest.createdBy, "ngoung");
  assert.ok(newest.label.includes("ที่จอดรถ"), `ป้ายต้องบอกว่ารุ่นนี้แก้อะไร — ${newest.label}`);
  // เฟส 3 เพิ่ม G5/G8 เข้าบันได — แฟล็กปิดอยู่ก็ยังต้องบันทึกว่ามันเป็น "ไม่เกี่ยวกับการแก้นี้"
  // ไม่ใช่หายไปจากรายงาน (เจ้าของต้องรู้ว่ามีตาข่ายอยู่แต่ยังไม่ได้เปิด)
  assert.deepEqual(newest.gates.map((gate) => gate.id), ["G0", "G1", "G2", "G3", "G4", "G5", "G8"],
    "ต้องเก็บผลทั้ง 7 ด่านไว้");
  assert.equal(first.pointer, null);
  assert.equal(first.status, "retired");
  assert.ok(Array.isArray(res.json.findings.live), "ต้องส่งผลตรวจของรุ่นที่ใช้งานอยู่มาด้วย");
  db.close;
});

test("ทีมงานอ่านประวัติได้ แต่กดปุ่มของเจ้าของไม่ได้", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const list = await get(app.server, "/console/api/brain/versions", auth(staff));
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.canManage, false);

  const live = db.getBrainPointer("live");
  const promote = await post(app.server,
    `/console/api/brain/versions/${live.version_id}/promote`, {}, auth(staff));
  assert.equal(promote.status, 403);
  const delegation = await get(app.server, "/console/api/brain/delegation", auth(staff));
  assert.equal(delegation.status, 403, "ทีมงานต้องไม่เห็นแม้แต่หน้าตั้งค่าสิทธิ์");
});

/* --------------------- ข. เลื่อนขั้นรุ่นทดลอง -> ตารางเดิมต้องตาม --------------------- */

test("เลื่อนขั้นรุ่นทดลองเป็นใช้งานจริง: ตารางเดิมถูกเขียนตาม และ parity ยังตรง", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const { versionId } = seedCanary(db, { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" });
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), false, "ก่อนเลื่อนขั้นต้องยังไม่ถึงลูกค้า");

  const promote = await post(app.server, `/console/api/brain/versions/${versionId}/promote`, {}, auth(owner));
  assert.equal(promote.status, 200, promote.text);
  assert.equal(db.getBrainPointer("live").version_id, versionId);
  assert.equal(db.getBrainPointer("canary"), null, "เลื่อนขั้นแล้วต้องไม่ค้างเป็นรุ่นทดลองอีก");
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), true,
    "เลื่อนขั้นแล้วตารางเดิมต้องมีของจริง ไม่ใช่แค่ pointer ขยับ");
  assertParity(db, "หลังเลื่อนขั้น");
});

test("รุ่นทดลองที่แตกมาจากรุ่นเก่า เลื่อนขั้นไม่ได้ — ของที่แก้ทีหลังต้องไม่หาย", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const { versionId } = seedCanary(db, { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" });
  // เจ้าของแก้ของอย่างอื่นทับไปก่อน -> live ขยับ รุ่นทดลองกลายเป็นของเก่า
  await post(app.server, "/console/api/prices", { label: "Early Bird", amount: 12900 }, auth(owner));

  const promote = await post(app.server, `/console/api/brain/versions/${versionId}/promote`, {}, auth(owner));
  assert.equal(promote.status, 409, promote.text);
  assert.match(promote.json.error, /หายไป/u);
  assert.equal(db.getApprovedPrice("Early Bird")?.amount, 12900, "ของที่เจ้าของแก้ต้องยังอยู่");
  assertParity(db, "หลังปฏิเสธการเลื่อนขั้นรุ่นเก่า");
});

/* ------------------------------- ค. ย้อนกลับ ------------------------------- */

test("ย้อนกลับทั้งใบ: pointer กลับไปรุ่นก่อน และตารางเดิมกลับตามครบทุกส่วน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const firstVersion = db.getBrainPointer("live").version_id;
  const rulesBefore = db.getSetting(PRODUCT_RULES_KEY);

  await post(app.server, "/console/api/knowledge", { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  await post(app.server, "/console/api/prices", { label: "Early Bird", amount: 12900 }, auth(owner));
  await post(app.server, "/console/api/settings/product-rules",
    { rules: "กติกาใหม่ที่พิมพ์ผิดไปทั้งย่อหน้า" }, auth(owner));
  assert.equal(db.listKnowledge().length, 2);
  assert.equal(db.getApprovedPrice("Early Bird")?.amount, 12900);

  const rollback = await post(app.server, `/console/api/brain/versions/${firstVersion}/rollback`, {}, auth(owner));
  assert.equal(rollback.status, 200, rollback.text);
  assert.equal(db.getBrainPointer("live").version_id, firstVersion);
  assert.equal(db.getSetting(PRODUCT_RULES_KEY), rulesBefore, "กติกาสินค้าต้องกลับเป็นของเดิม");
  assert.equal(db.getApprovedPrice("Early Bird"), null, "ราคาที่เพิ่งเพิ่มต้องหายไปจากตารางที่ guard อ่าน");
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), false, "ความรู้ที่เพิ่งเพิ่มต้องถูกปิด");
  assert.equal(db.listKnowledge().length, 1);
  assertParity(db, "หลังย้อนกลับ");
  assert.equal(db.getBrainVersion(rollback.json.rolledFrom).status, "rolled_back");
});

test("ย้อนกลับแล้วแก้ใหม่ต่อได้ทันที — id ของแถวความรู้เดิมไม่เปลี่ยน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const original = db.listKnowledge()[0];
  const firstVersion = db.getBrainPointer("live").version_id;

  await post(app.server, `/console/api/knowledge/${original.id}`,
    { content: "คลาส AI Agent for Business สอนสดที่กรุงเทพ" }, auth(owner));
  await post(app.server, `/console/api/brain/versions/${firstVersion}/rollback`, {}, auth(owner));

  const restored = db.getKnowledge(original.id);
  assert.ok(restored, "id เดิมต้องยังอยู่ ไม่ใช่แถวใหม่ (audit/artifact อ้าง id นี้)");
  assert.equal(restored.content, original.content);
  assertParity(db, "หลังย้อนกลับแล้วอ่านซ้ำ");

  const again = await post(app.server, `/console/api/knowledge/${original.id}`,
    { content: "คลาส AI Agent for Business รอบใหม่" }, auth(owner));
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.brain.outcome, "live");
  assertParity(db, "แก้ต่อหลังย้อนกลับ");
});

/* ------------------------------- ง. รับทราบ ------------------------------- */

test("รับทราบหนี้ที่ค้าง -> รุ่นที่รออยู่ถูกใช้งานจริง และครั้งต่อไปไม่ถามซ้ำ", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");

  const pending = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  assert.equal(pending.json?.brain?.outcome, "needs_ack", pending.text);
  const versionId = pending.json.brain.versionId;

  const ack = await post(app.server, `/console/api/brain/versions/${versionId}/ack`, {}, auth(owner));
  assert.equal(ack.status, 200, ack.text);
  assert.equal(db.getBrainPointer("live").version_id, versionId);
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), true, "รับทราบแล้วของต้องถึงลูกค้าจริง");
  assertParity(db, "หลังรับทราบ");

  // ครั้งต่อไปต้องผ่านเลย: หนี้ก้อนเดิมถูกรับทราบไปแล้ว ack ถูกสืบทอดข้ามรุ่น
  const next = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ 2", content: "จอดต่อได้อีก 2 ชั่วโมง" }, auth(owner));
  assert.equal(next.status, 200, next.text);
  assert.equal(next.json.brain.outcome, "live");
  assertParity(db, "การเขียนถัดไปหลังรับทราบ");
});

/* ------------------------------ จ. มอบสิทธิ์ ------------------------------ */

test("มอบสิทธิ์สีเขียวจากคอนโซล: ตั้งได้ไม่เกิน 90 วัน ชนิดสีแดงถูกปฏิเสธ ยกเลิกได้", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");

  const tooLong = await post(app.server, "/console/api/brain/delegation",
    { roles: ["operator"], kinds: ["fact"], days: 120 }, auth(owner));
  assert.equal(tooLong.status, 400, tooLong.text);

  const red = await post(app.server, "/console/api/brain/delegation",
    { roles: ["operator"], kinds: ["price"], days: 30 }, auth(owner));
  assert.equal(red.status, 400, red.text);
  assert.match(red.json.error, /พี่ง้วงกดเองเสมอ/u);

  const ok = await post(app.server, "/console/api/brain/delegation",
    { roles: ["operator"], kinds: ["fact"], days: 90 }, auth(owner));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.delegation.active, true);
  assert.ok(ok.json.delegation.expiresAt > Date.now());
  assert.ok(db.listAudit().some((row) => row.action === "brain_delegation_set"));

  const revoke = await post(app.server, "/console/api/brain/delegation", { roles: [], kinds: [], days: 0 }, auth(owner));
  assert.equal(revoke.status, 200, revoke.text);
  assert.equal(revoke.json.delegation.active, false);
});

/* ------- ฉ. กู้แถวที่ถูกลบถาวร ต้องได้ "ที่นั่งเดิม" ในตาราง ไม่ใช่แค่ id เดิม ------- */

// ลำดับความรู้ใน prompt คือ ORDER BY created_at ASC, rowid ASC — สองรายการที่ created_at
// เท่ากันจะสลับที่กันทันทีถ้าใบหนึ่งได้ rowid ใหม่ที่ท้ายตาราง = คนละ prompt ทั้งที่เนื้อหาเท่าเดิม
test("ย้อนกลับหลังแถวถูกลบถาวร: กู้กลับด้วย rowid เดิม ลำดับใน prompt ไม่สลับ", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  // สองใบที่ created_at เท่ากันเป๊ะ — ตัวตัดสินลำดับเหลือ rowid อย่างเดียว
  const a = db.addKnowledge({ title: "ก ใบแรก", content: "เนื้อหาใบแรก", updatedBy: "ngoung" });
  const b = db.addKnowledge({ title: "ข ใบสอง", content: "เนื้อหาใบสอง", updatedBy: "ngoung" });
  db.raw.exec(`UPDATE knowledge_entries SET created_at = 1700000000000 WHERE id IN ('${a.id}','${b.id}')`);
  const rowidA = db.raw.prepare("SELECT rowid AS r FROM knowledge_entries WHERE id = ?").get(a.id).r;
  // แถวที่ถูกเขียนตรงเข้าฐานต้องถูกยกเข้าสมองก่อน ไม่งั้นด่านกันการเขียนทับ drift จะปฏิเสธ
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });

  // ยกเข้าสมองเป็นรุ่นใหม่ แล้วจำรุ่นนั้นไว้เป็นจุดย้อนกลับ
  await post(app.server, "/console/api/settings/product-rules", { rules: "กติกาที่ปรับถ้อยคำ" }, auth(owner));
  const anchor = db.getBrainPointer("live").version_id;
  const orderBefore = db.listActiveKnowledge().map((row) => row.id);
  assertParity(db, "ก่อนลบถาวร");

  // เดินหน้าอีกหนึ่งรุ่น แล้วลบแถว ก ถาวร (จำลอง prune/แก้ฐานตรง ๆ)
  await post(app.server, "/console/api/knowledge", { title: "ค ใบสาม", content: "เนื้อหาใบสาม" }, auth(owner));
  db.raw.exec(`DELETE FROM knowledge_entries WHERE id = '${a.id}'`);

  const rollback = await post(app.server, `/console/api/brain/versions/${anchor}/rollback`, {}, auth(owner));
  assert.equal(rollback.status, 200, rollback.text);
  const restored = db.raw.prepare("SELECT rowid AS r, title FROM knowledge_entries WHERE id = ?").get(a.id);
  assert.ok(restored, "แถวที่ถูกลบถาวรต้องถูกกู้กลับ");
  assert.equal(restored.r, rowidA, "ต้องได้ rowid เดิม ไม่ใช่ที่นั่งใหม่ท้ายตาราง");
  assert.deepEqual(
    db.listActiveKnowledge().map((row) => row.id),
    orderBefore,
    "ลำดับที่ฉีดเข้า prompt ต้องเหมือนเดิมทุกใบ",
  );
  assert.ok(orderBefore.indexOf(a.id) < orderBefore.indexOf(b.id), "เทสต์ต้องวัดคู่ที่ created_at เท่ากันจริง");
  assertParity(db, "หลังกู้แถวที่ถูกลบถาวร");
});

test("ที่นั่งเดิมถูกแถวอื่นยึดไปแล้ว: ต้องล้มเสียงดังและไม่แตะของเดิมเลย", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const a = db.addKnowledge({ title: "ก ใบแรก", content: "เนื้อหาใบแรก", updatedBy: "ngoung" });
  const rowidA = db.raw.prepare("SELECT rowid AS r FROM knowledge_entries WHERE id = ?").get(a.id).r;
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });

  await post(app.server, "/console/api/settings/product-rules", { rules: "กติกาที่ปรับถ้อยคำ" }, auth(owner));
  const anchor = db.getBrainPointer("live").version_id;
  await post(app.server, "/console/api/knowledge", { title: "ค ใบสาม", content: "เนื้อหาใบสาม" }, auth(owner));

  // ลบ ก ถาวร แล้วให้แถวอื่นมานั่งที่ rowid เดิม
  db.raw.exec(`DELETE FROM knowledge_entries WHERE id = '${a.id}'`);
  db.raw.prepare(
    `INSERT INTO knowledge_entries (rowid, id, title, content, active, updated_by, created_at, updated_at)
     VALUES (?, 'squatter', 'แถวที่มายึดที่นั่ง', 'x', 1, 'x', 1, 1)`,
  ).run(rowidA);
  const rulesBefore = db.getSetting(PRODUCT_RULES_KEY);
  const liveBefore = db.getBrainPointer("live").version_id;

  const rollback = await post(app.server, `/console/api/brain/versions/${anchor}/rollback`, {}, auth(owner));
  assert.equal(rollback.status, 409, `ต้องปฏิเสธ ไม่ใช่กู้ผิดที่แล้วเงียบ — ${rollback.text}`);
  assert.match(rollback.json.error, /ที่นั่งเดิมในตาราง/u);
  assert.equal(db.getSetting(PRODUCT_RULES_KEY), rulesBefore, "ธุรกรรมต้องถูกยกเลิกทั้งก้อน");
  assert.equal(db.getBrainPointer("live").version_id, liveBefore, "pointer ต้องไม่ขยับ");
});
