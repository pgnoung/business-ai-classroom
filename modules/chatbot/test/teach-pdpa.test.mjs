// teach-pdpa.test.mjs — teach_json ต้องไม่กลายเป็นที่เก็บข้อมูลลูกค้าชุดที่สอง
//
// แบบแปลน §5 PDPA:
//   ข้อ 2 — การ์ดที่เกิดจากคำแก้ของลูกค้ารายหนึ่ง เก็บได้แค่ `customer_hash` ไม่ใช่ id ดิบ
//   ข้อ 3 — `teach_json.correct_text` ถูกล้างตอนเผยแพร่ เหลือแค่ card ref
//
// ทำไมต้องมีเทสต์: teach_json เป็นคอลัมน์ JSON บนตาราง brain_versions ซึ่ง **ไม่มี**
// คอลัมน์ผูกลูกค้า มันจึงอยู่นอกขอบเขตของ test/pdpa-cascade.test.mjs โดยโครงสร้าง —
// ถ้าไม่มีไฟล์นี้ การเผลอเก็บข้อความลูกค้าลง JSON ก้อนนี้จะไม่มีด่านไหนจับได้เลย
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import {
  sanitizeTeachContext, teachCustomerHash, teachJsonAfterPublish,
} from "../src/brain/teach.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const QUIET = { warn() {}, debug() {}, log() {} };
const SECRET = "teach-pdpa-console-secret-0123456789";
const PASSWORD = "teach-pdpa-pass-1234";
const TODAY = todayInBangkok(Date.now());
const CUSTOMER = "U8fe803f1234567890abcdef01234567";
const CORRECT_TEXT = "จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ";

async function boot(t) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SECRET, KNOWLEDGE_VERSIONED: "true", TEACH_ENABLED: "true",
  });
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.upsertCustomer(CUSTOMER, { displayName: "คุณเอ" });
  db.addKnowledge({ title: "ที่จอดรถและการเดินทาง", content: "จอดฟรี 2 ชั่วโมงที่อาคาร B", updatedBy: "ngoung" });
  db.setApprovedPrice("AI Agent for Business", 19900);
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

function post(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}
const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });
const teachOf = (db, versionId) => JSON.parse(db.getBrainVersion(versionId).teach_json || "{}");

test("เจ้าของกดสอน = เผยแพร่ทันที -> correct_text ต้องหายไปแล้ว เหลือแค่ตัวชี้การ์ด", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: CORRECT_TEXT });

  const res = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId, reasonChips: ["wrong_fact"], correctText: CORRECT_TEXT },
  }, auth(owner));
  assert.equal(res.status, 200, res.text);

  const live = db.getBrainPointer("live");
  const teach = teachOf(db, live.version_id);
  assert.equal(teach.correct_text, undefined, "เผยแพร่แล้วต้องไม่เหลือข้อความที่คนพิมพ์");
  assert.equal(teach.correct_text_cleared, true, "ต้องบันทึกไว้ว่าล้างแล้ว ไม่ใช่หายไปเฉย ๆ");
  assert.ok(teach.card_ref, "ต้องเหลือตัวชี้การ์ดไว้ให้ตามรอยได้");
  assert.equal(teach.correction_ref, correctionId, "ตัวชี้คำแก้เก็บได้ (เป็น id ไม่ใช่เนื้อความ)");
  assert.equal(teach.customer_hash, teachCustomerHash(CUSTOMER), "ต้องเก็บ hash ไม่ใช่ id ดิบ");
  const raw = db.getBrainVersion(live.version_id).teach_json;
  assert.ok(!raw.includes(CUSTOMER), "id ของลูกค้าต้องไม่อยู่ใน teach_json");
  assert.ok(!raw.includes("คุณเอ"), "ชื่อลูกค้าต้องไม่อยู่ใน teach_json");
});

test("ทีมงานสอน = เข้าคิว ยังไม่เผยแพร่ -> ข้อความยังอยู่จนกว่าเจ้าของจะอนุมัติ แล้วจึงถูกล้าง", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: CORRECT_TEXT });

  const queued = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (ชมพู่เสนอ)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId, correctText: CORRECT_TEXT },
  }, auth(staff));
  assert.equal(queued.status, 202, `ทีมงานต้องได้คิวขออนุมัติ — ${queued.text}`);

  const approve = await post(app.server,
    `/console/api/publish-requests/${queued.json.requestId}/approve`, {}, auth(owner));
  assert.equal(approve.status, 200, approve.text);

  const live = db.getBrainPointer("live");
  const teach = teachOf(db, live.version_id);
  assert.equal(teach.correct_text, undefined, "อนุมัติแล้ว = เผยแพร่แล้ว ข้อความต้องถูกล้าง");
  assert.equal(teach.correction_ref, correctionId);
});

test("รุ่นที่ยังไม่ถึงลูกค้า (รอรับทราบ) เก็บข้อความไว้ได้ แล้วถูกล้างตอนกดรับทราบ", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  // "หนี้ความรู้" ที่ทำให้ด่านต้องขอ ack: การ์ดเดิมมีตัวเลขที่ไม่อยู่ในตารางราคา
  db.addKnowledge({ title: "โปรเก่า", content: "รุ่นก่อนลดเหลือ 9,500 บาท", updatedBy: "ngoung" });
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: CORRECT_TEXT });

  const res = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId, correctText: CORRECT_TEXT },
  }, auth(owner));
  assert.equal(res.status, 409, `ต้องค้างเป็นรุ่นรอรับทราบ — ${res.text}`);
  const versionId = res.json.brain.versionId;
  assert.equal(teachOf(db, versionId).correct_text, CORRECT_TEXT,
    "ยังไม่ถึงลูกค้า = ข้อความยังต้องอยู่ ไม่งั้นคนกดอนุมัติจะมองไม่เห็นว่ากำลังอนุมัติอะไร");

  const acked = await post(app.server, `/console/api/brain/versions/${versionId}/ack`, {}, auth(owner));
  assert.equal(acked.status, 200, acked.text);
  const teach = teachOf(db, versionId);
  assert.equal(teach.correct_text, undefined, "รับทราบแล้ว = เผยแพร่แล้ว ต้องล้างข้อความ");
  assert.equal(teach.correct_text_cleared, true);
});

test("customer_hash ที่หน้าเว็บส่งมาเองถูกทิ้งเสมอ — id ดิบเข้าช่องนี้ไม่ได้", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: CORRECT_TEXT });
  const res = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: {
      source: "correction", correctionRef: correctionId,
      customer_hash: CUSTOMER, customerHash: CUSTOMER,
    },
  }, auth(owner));
  assert.equal(res.status, 200, res.text);
  const raw = db.getBrainVersion(db.getBrainPointer("live").version_id).teach_json;
  assert.ok(!raw.includes(CUSTOMER), "id ดิบที่ส่งมาในช่อง hash ต้องไม่ถูกเก็บ");
  assert.ok(raw.includes(teachCustomerHash(CUSTOMER)), "ต้องใช้ hash ที่คำนวณฝั่งเซิร์ฟเวอร์แทน");
});

test("บันทึก human_final ไม่แตะ candidate ที่ถูกสอนไปแล้ว", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "" });
  db.setCorrectionTaughtVersion(correctionId, "brain-version-already-taught");
  const res = await post(app.server, "/console/api/teach/correction-final", {
    source: "guard_block", ref: correctionId, humanFinal: CORRECT_TEXT,
  }, auth(owner));
  assert.equal(res.status, 409, res.text);
  assert.equal(db.getCorrection(correctionId).human_final, "", "ต้อง reject ก่อนเขียน historical candidate");
});

test("DB guard: setCorrectionFinal ไม่เขียน candidate ที่มี taught_version_id", () => {
  const db = memoryDb();
  db.upsertCustomer(CUSTOMER, {});
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "ร่างเดิม", humanFinal: "" });
  db.setCorrectionTaughtVersion(correctionId, "already-taught");
  assert.equal(db.setCorrectionFinal(correctionId, "คำแก้ใหม่"), false);
  assert.equal(db.getCorrection(correctionId).human_final, "");
  db.close();
});

/* ------------------------------ ทะเบียนฟิลด์ (unit) ------------------------------ */

test("ทะเบียนของ teach_json ทิ้งทุกอย่างที่ไม่ได้อยู่ในรายการ", async () => {
  const out = sanitizeTeachContext({
    source: "correction",
    correctionRef: "abc-123",
    customerMessage: "สวัสดีค่ะ อยากถามเรื่องที่จอดรถ",   // ข้อความลูกค้า — ต้องไม่มีช่องให้
    customerName: "คุณเอ",
    lineUserId: CUSTOMER,
    reasonChips: ["wrong_fact", "ไม่มีชิปนี้"],
    correctText: CORRECT_TEXT,
    risk: "green",
  });
  assert.deepEqual(Object.keys(out).sort(), ["correct_text", "correction_ref", "reason_chips", "risk", "source"]);
  assert.deepEqual(out.reason_chips, ["wrong_fact"], "ชิปที่ไม่มีในทะเบียนต้องถูกทิ้ง");
  assert.equal(JSON.stringify(out).includes(CUSTOMER), false);
  assert.equal(JSON.stringify(out).includes("คุณเอ"), false);
});

test("teachJsonAfterPublish คืน object ใหม่ ไม่แก้ของเดิม และเหลือตัวชี้การ์ดไว้", async () => {
  const before = Object.freeze({
    source: "correction", correction_ref: "abc", correct_text: CORRECT_TEXT, touched: ["fact:1"],
  });
  const after = teachJsonAfterPublish(before, { cardRefs: ["fact:1"] });
  assert.equal(before.correct_text, CORRECT_TEXT, "ของเดิมต้องไม่ถูกแก้");
  assert.equal(after.correct_text, undefined);
  assert.equal(after.card_ref, "fact:1");
  assert.equal(after.correction_ref, "abc");
});

test("hash ของลูกค้าเป็นค่าคงที่ต่อ id เดียวกัน และไม่ใช่ id ดิบ", async () => {
  const hash = teachCustomerHash(CUSTOMER);
  assert.equal(hash, teachCustomerHash(CUSTOMER));
  assert.notEqual(hash, CUSTOMER);
  assert.match(hash, /^[0-9a-f]{32}$/u);
  assert.notEqual(hash, teachCustomerHash("U-someone-else"));
  assert.equal(teachCustomerHash(""), "");
});

/* ================= รอบตรวจที่สอง (adversarial review 2026-09-03) ================= */

// ข้อ 1: correct_text ถูกเก็บโดยไม่มีด่านฝั่งเซิร์ฟเวอร์ — ตัวจัดชนิดที่ /teach/plan เป็น
// คำแนะนำ ไม่ใช่ด่าน คนที่ยิง API ตรง ๆ (หรือหน้าเว็บที่แข่งกับตัวเอง) ข้ามมันได้ทั้งหมด
test("ข้อความที่มีข้อมูลส่วนบุคคลถูกปฏิเสธที่เซิร์ฟเวอร์ ไม่ใช่แค่ที่หน้าจอ", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: "y" });
  const res = await post(app.server, "/console/api/knowledge", {
    title: "ติดต่อกลับ", content: "ลูกค้าจอดรถได้ 4 ชั่วโมง",
    teach: {
      source: "correction", correctionRef: correctionId,
      correctText: "โทรกลับที่เบอร์ 0812345678 หรืออีเมล somchai@example.com ได้เลยค่ะ",
    },
  }, auth(owner));
  assert.equal(res.status, 400, `ต้องปฏิเสธทั้งคำขอ — ${res.text}`);
  assert.match(res.json.error, /ข้อมูลที่อาจระบุตัวบุคคล/u);
  const raw = db.getBrainVersion(db.getBrainPointer("live").version_id).teach_json;
  assert.ok(!raw.includes("0812345678"), "เบอร์โทรต้องไม่ถูกเก็บไว้ที่ไหนเลย");
});

// ข้อ 2: จอสอนเติมคำตอบที่เขียนถึงลูกค้าคนหนึ่งมาให้ แล้วไม่มีใครตรวจว่าในนั้นมีชื่อเขาไหม
test("ชื่อของลูกค้าในห้องนั้นทำให้การ์ดถูกปฏิเสธ พร้อมบอกว่าติดคำไหน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  db.upsertCustomer(CUSTOMER, { displayName: "Somchai P" });
  db.setKnownName(CUSTOMER, "คุณสมชาย");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: "y" });
  const res = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ", content: "คุณสมชาย จอดฟรีได้ 4 ชั่วโมงนะคะ",
    teach: { source: "correction", correctionRef: correctionId, correctText: "คุณสมชาย จอดฟรีได้ 4 ชั่วโมงนะคะ" },
  }, auth(owner));
  assert.equal(res.status, 400, `ต้องปฏิเสธเพราะมีชื่อลูกค้าอยู่ในความรู้ — ${res.text}`);
  assert.match(res.json.error, /ชื่อของลูกค้า/u);
});

// ข้อ 3: publish_requests.body_json เก็บ payload ดิบไว้ตลอดกาล รวมทั้ง id ที่ sanitize ทิ้ง
test("คำขอที่ทีมงานส่งเข้าคิว ต้องถูกกรองก่อนเขียนแถว และถูกล้างข้อความเมื่อตัดสินแล้ว", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: CORRECT_TEXT });
  const queued = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (ชมพู่เสนอ)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: {
      source: "correction", correctionRef: correctionId, correctText: CORRECT_TEXT,
      lineUserId: CUSTOMER, customerName: "คุณสมชาย", customer_hash: CUSTOMER,
    },
  }, auth(staff));
  assert.equal(queued.status, 202, queued.text);
  const row = db.getPublishRequest(queued.json.requestId);
  assert.ok(!row.body_json.includes(CUSTOMER), `id ดิบต้องไม่ถูกเก็บในคิว — ${row.body_json}`);
  assert.ok(!row.body_json.includes("คุณสมชาย"), "ชื่อลูกค้าต้องไม่ถูกเก็บในคิว");

  const approve = await post(app.server, `/console/api/publish-requests/${queued.json.requestId}/approve`, {}, auth(owner));
  assert.equal(approve.status, 200, approve.text);
  const settled = db.getPublishRequest(queued.json.requestId);
  assert.ok(!settled.body_json.includes(CORRECT_TEXT),
    "ตัดสินแล้ว = ข้อความที่คนพิมพ์หมดหน้าที่ ต้องถูกล้างออกจากแถวคำขอด้วย");
  assert.ok(!String(settled.result_json || "").includes(CORRECT_TEXT),
    "ผลลัพธ์ที่เก็บไว้ก็ต้องไม่มีข้อความนั้น");
});

// ข้อ 4a: ล้าง correct_text ทุกทางที่รุ่นจบชีวิต ไม่ใช่เฉพาะทางที่ถึงลูกค้า
test("รุ่นที่ถูกปัดตกต้องถูกล้างข้อความด้วย ไม่ใช่ค้างอยู่ตลอดกาล", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  db.addKnowledge({ title: "โปรเก่า", content: "รุ่นก่อนลดเหลือ 9,500 บาท", updatedBy: "ngoung" });
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: CORRECT_TEXT });
  const res = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId, correctText: CORRECT_TEXT },
  }, auth(owner));
  assert.equal(res.status, 409, res.text);
  const versionId = res.json.brain.versionId;
  const discard = await post(app.server, `/console/api/brain/versions/${versionId}/discard`, {}, auth(owner));
  assert.equal(discard.status, 200, discard.text);
  assert.equal(teachOf(db, versionId).correct_text, undefined, "ปัดตกแล้วต้องไม่เหลือข้อความ");
  assert.equal(teachOf(db, versionId).correct_text_cleared, true);
});

// ข้อ 4b: สิทธิ์ให้ลืมต้องไปถึง teach_json ด้วย — pdpa-cascade มองคอลัมน์ JSON ไม่เห็น
test("ลบลูกค้าตามคำขอ = teach_json ของทุกรุ่นต้องไม่เหลือร่องรอยของคนนั้น", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: CORRECT_TEXT });
  const res = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId, correctText: CORRECT_TEXT },
  }, auth(owner));
  assert.equal(res.status, 200, res.text);
  const versionId = db.getBrainPointer("live").version_id;
  assert.ok(teachOf(db, versionId).customer_hash, "ก่อนลบต้องมี hash อยู่");

  db.resetCustomer(CUSTOMER, { forget: true, forgetReason: "owner_pdpa_request" });
  const teach = teachOf(db, versionId);
  assert.equal(teach.customer_hash, undefined, "ลืมแล้วต้องไม่เหลือ hash");
  assert.equal(teach.correction_ref, undefined, "ลืมแล้วต้องไม่เหลือตัวชี้คำแก้ที่ถูกลบไปแล้ว");
  assert.equal(teach.correct_text, undefined);
  assert.ok(teach.card_ref, "ตัวชี้การ์ดยังต้องอยู่ — ความรู้ของธุรกิจไม่ได้ถูกลบไปด้วย");
});

// ข้อ 4c: hash ต้องมีกุญแจ ไม่งั้นย้อนกลับได้ด้วย dictionary ของ id ที่รู้อยู่แล้ว
test("hash ของลูกค้าใช้กุญแจ — เครื่องคนละกุญแจให้คนละค่า", async () => {
  const { teachCustomerHash: hashOf } = await import("../src/brain/teach.mjs");
  const a = hashOf(CUSTOMER, "secret-one");
  const b = hashOf(CUSTOMER, "secret-two");
  assert.notEqual(a, b, "กุญแจต่างกันต้องได้ค่าต่างกัน");
  assert.notEqual(a, hashOf(CUSTOMER, ""), "มีกุญแจกับไม่มีกุญแจต้องไม่ใช่ค่าเดียวกัน");
  assert.match(a, /^[0-9a-f]{32}$/u);
});
