// teach-review-api.test.mjs — เฟส 3 ฝั่งเซิร์ฟเวอร์: กล่องตรวจ, จอสอน, Step 0
//
// สิ่งที่ไฟล์นี้ต้องกัน (ทั้งหมดเป็นความล้มเหลวที่เคยเกิดจริงในระบบนี้มาแล้ว):
//   1. แฟล็กปิดแล้วเส้นทางยัง "มีอยู่" — ต้อง 404 ไม่ใช่ 403 (403 แปลว่ามีของแต่คุณห้ามดู)
//   2. คำแก้ค้าง 138 แถวที่ไม่มีหน้าไหนอ่าน — กล่องตรวจต้องเห็นทั้งคำแก้และร่างที่ตัวกรองกัน
//   3. สอนแล้วยังโผล่ซ้ำ — รุ่นสมองที่อ้างคำแก้ใบนั้นแล้วต้องทำให้มันหายจากกล่อง
//   4. Step 0 โกหกในทิศที่สบายใจ — เทิร์นที่ไม่ได้ใช้สมองต้องเขียนว่า "อ่านจากตารางเดิม"
//   5. ข้อความที่คนพิมพ์ค้างอยู่ใน teach_json หลังเผยแพร่ (PDPA §5 ข้อ 3)
//
// ยิง HTTP จริง เพราะด่านของจริงอยู่ที่ handler ไม่ใช่ที่หน้าเว็บ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { READ_FROM_LEGACY_TABLES } from "../src/consoleTeachApi.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const QUIET = { warn() {}, debug() {}, log() {} };
const SECRET = "teach-review-console-secret-0123456789";
const PASSWORD = "teach-review-pass-1234";
const TODAY = todayInBangkok(Date.now());
const CUSTOMER = "U-teach-review-001";

async function boot(t, { teach = true, versioned = true } = {}) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SECRET,
    KNOWLEDGE_VERSIONED: versioned ? "true" : "false",
    TEACH_ENABLED: teach ? "true" : "false",
  });
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.upsertCustomer(CUSTOMER, { displayName: "ลูกค้าทดสอบ" });
  db.addKnowledge({ title: "ที่จอดรถและการเดินทาง", content: "จอดฟรี 2 ชั่วโมงที่อาคาร B", updatedBy: "ngoung" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  const imported = importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  assert.equal(imported.created, true, "ต้องนำเข้าสมองรุ่นแรกได้ก่อนเริ่มเทสต์");

  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

function send(server, method, path, body, headers = {}) {
  return httpRequest(server, {
    method, path,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });
}
const post = (server, path, body, headers) => send(server, "POST", path, body, headers);
const get = (server, path, headers = {}) => httpRequest(server, { path, headers });

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, `ล็อกอิน ${username} ต้องผ่าน — ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}
const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });
const rowById = (rows, id) => rows.find((row) => row.id === id) ?? null;

/* --------------------------------- ด่านแฟล็ก --------------------------------- */

test("แฟล็กปิด = เส้นทางกล่องตรวจต้องเหมือนไม่มีอยู่จริง (404 ไม่ใช่ 403)", async (t) => {
  const { app } = await boot(t, { teach: false });
  const owner = await login(app.server, "ngoung");
  for (const path of ["/console/api/teach/review", "/console/api/teach/session?source=correction&ref=x",
    "/console/api/teach/why?messageId=x"]) {
    const res = await get(app.server, path, auth(owner));
    assert.equal(res.status, 404, `${path} ต้องตอบ 404 ตอนแฟล็กปิด — ได้ ${res.status}`);
  }
  const me = await get(app.server, "/console/api/me", auth(owner));
  assert.equal(me.json.features.teach, false, "แฟล็กปิด = เมนูต้องไม่ขึ้น");
});

test("แฟล็กเปิดแล้วเมนูขึ้นทั้งเจ้าของและทีมงาน — กล่องตรวจเป็นงานประจำวันของทีม", async (t) => {
  const { app } = await boot(t);
  for (const username of ["ngoung", "chompoo"]) {
    const session = await login(app.server, username);
    const me = await get(app.server, "/console/api/me", auth(session));
    assert.equal(me.json.features.teach, true, `${username} ต้องเห็นเมนูกล่องตรวจ`);
    const review = await get(app.server, "/console/api/teach/review", auth(session));
    assert.equal(review.status, 200, `${username} ต้องอ่านกล่องตรวจได้ — ${review.text}`);
  }
});

/* ------------------------------ แหล่งของกล่องตรวจ ------------------------------ */

test("กล่องตรวจเห็นคำแก้ของทีม และร่างที่ตัวกรองกันไว้เพราะตัวเลขนอกตารางราคา", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const taught = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ",
  });
  const blocked = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "คลาสนี้ลดเหลือ 9,500 บาทค่ะ", humanFinal: "",
  });
  // ร่างที่โดนบล็อกด้วยเรื่องอื่น (ไม่มีตัวเลข) ยังอยู่ในคิวคำแก้เดิม ไม่ต้องมาซ้ำในกล่องนี้
  const other = db.addCorrection({ customerId: CUSTOMER, aiDraft: "รับรองว่าดีที่สุดค่ะ", humanFinal: "" });

  const res = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.equal(res.status, 200);
  const rows = res.json.rows;
  const correctionRow = rowById(rows, `correction:${taught}`);
  assert.ok(correctionRow, "คำแก้ของทีมต้องอยู่ในกล่อง");
  assert.equal(correctionRow.source, "correction");
  assert.equal(correctionRow.actions.teach, true, "คำแก้ข้อเท็จจริงต้องกดสอนได้");
  assert.match(correctionRow.detail, /จอดฟรี 4 ชั่วโมง/u);

  const guardRow = rowById(rows, `correction:${blocked}`);
  assert.ok(guardRow, "ร่างที่ตัวกรองกันเพราะตัวเลขต้องอยู่ในกล่อง");
  assert.equal(guardRow.source, "guard_block");
  assert.equal(guardRow.risk, "red", "เรื่องราคาเป็นสีแดงเสมอ");
  assert.equal(guardRow.ownerOnly, true);
  assert.ok(guardRow.amounts.includes("9,500"), `ต้องบอกตัวเลขที่กันไว้ — ${JSON.stringify(guardRow.amounts)}`);

  assert.equal(rowById(rows, `correction:${other}`), null, "ร่างที่ไม่เกี่ยวกับราคาต้องไม่มาซ้ำในกล่องนี้");
});

test("คำแก้เก่าที่ต่างเพียง marker ไม่ขึ้นคิว และ API สอนไม่ได้", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({
    customerId: CUSTOMER,
    aiDraft: "ส่งรายละเอียดให้แล้วค่ะ [IMAGE:ai-stage-ladder]",
    humanFinal: "ส่งรายละเอียดให้แล้วค่ะ",
  });

  const review = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.equal(rowById(review.json.rows, `correction:${correctionId}`), null,
    "เก็บหลักฐานเก่าไว้ได้ แต่ต้องไม่แสดงว่าเป็นบทเรียน");

  const session = await get(app.server,
    `/console/api/teach/session?source=correction&ref=${correctionId}`, auth(owner));
  assert.equal(session.status, 409);
  assert.match(session.json.error, /ไม่มีการแก้เนื้อความ/u);

  const directTeach = await post(app.server, "/console/api/knowledge", {
    title: "ความรู้ที่ไม่ควรถูกสร้าง", content: "ห้ามใช้คำแก้ปลอมเป็นหลักฐาน",
    teach: { source: "correction", correctionRef: correctionId, correctText: "ข้อความใหม่" },
  }, auth(owner));
  assert.equal(directTeach.status, 400, directTeach.text);
  assert.match(directTeach.json.error, /ใช้สอนสมองไม่ได้/u);
  assert.equal(db.getCorrection(correctionId).taught_version_id, "", "ห้ามผูกว่าเคยสอน");

  const approve = await post(app.server, `/console/api/corrections/${correctionId}/decide`,
    { action: "approve" }, auth(owner));
  assert.equal(approve.status, 409, approve.text);
  assert.equal(db.getCorrection(correctionId).status, "candidate", "ห้ามเปลี่ยนเป็นอนุมัติหลอก ๆ");

  const draftOnlyId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "ร่างที่ยังรอทีมแก้", humanFinal: "" });
  const draftSession = await get(app.server,
    `/console/api/teach/session?source=correction&ref=${draftOnlyId}`, auth(owner));
  assert.equal(draftSession.status, 200, "ร่างว่างยังเปิดเพื่อเตรียมแก้ได้");
  const blankTeach = await post(app.server, "/console/api/knowledge", {
    title: "ห้ามสอนจากร่างว่าง", content: "ยังไม่มีคำตอบที่ทีมยืนยัน",
    teach: { source: "correction", correctionRef: draftOnlyId, correctText: "ข้อความที่ caller แนบเอง" },
  }, auth(owner));
  assert.equal(blankTeach.status, 400, blankTeach.text);
  const blankApprove = await post(app.server, `/console/api/corrections/${draftOnlyId}/decide`,
    { action: "approve" }, auth(owner));
  assert.equal(blankApprove.status, 409, blankApprove.text);
  assert.equal(db.getCorrection(draftOnlyId).status, "candidate");
});

test("จอสอนรับ provenance ระบบแบบปิด แยกจาก human decision reason", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "ร่างที่ระบบกันไว้", humanFinal: "",
    sourceReason: "system:followup_compliance_block:banned_word",
  });
  const res = await get(app.server,
    `/console/api/teach/session?source=guard_block&ref=${correctionId}`, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.draftLabel, "ร่างของลูกแพร:");
  assert.deepEqual(res.json.provenance, {
    recorded: true,
    label: "ที่มาร่างของระบบ: ด่านตรวจข้อความติดตาม (คำต้องห้าม)",
  });
  assert.equal(res.json.humanDecisionReason, "", "system provenance is not a human decision reason");
  assert.equal(JSON.stringify(res.json.provenance).includes("system:"), false, "closed code stays internal");
});

test("กล่องตรวจเห็นข้อเสนอการเรียนรู้ และของหมดอายุจากผลตรวจของรุ่นที่ใช้อยู่", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  db.createLearningCandidate({
    runId: "run-1", dayKey: "2026-09-03", clusterKey: "parking", kind: "correction",
    title: "ที่จอดรถกี่ชั่วโมง", proposedContent: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
  });
  // รอบที่ผ่านไปแล้วแต่ยังเปิดรับ = L03 บล็อก — ตัวตรวจหาเจอตั้งแต่เฟส 1b แต่ไม่มีใครเห็น
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2020-01-10", classKey: "onsite", label: "รอบเก่า", product: "AI Agent for Business", status: "open", capacity: 15 },
  ]));
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });

  const res = await get(app.server, "/console/api/teach/review", auth(owner));
  const rows = res.json.rows;
  assert.ok(rows.some((row) => row.source === "learning"), "ข้อเสนอการเรียนรู้ต้องอยู่ในกล่อง");
  const lints = rows.filter((row) => row.source === "lint");
  assert.ok(lints.length >= 1, `ของหมดอายุต้องอยู่ในกล่อง — ${JSON.stringify(rows.map((r) => r.source))}`);
  // รอบที่ผ่านไปแล้วแต่ยังเปิดรับ = L03 (แถวที่ยกมาจากตารางเดิมได้สิทธิ์ grandfather จึงเป็น "เตือน"
  // ไม่ใช่ "ต้องแก้" — กล่องตรวจต้องแสดงทั้งสองระดับ ไม่งั้นของค้างจะไม่มีวันถูกเก็บ)
  assert.ok(lints.some((row) => /ผ่านไปแล้วแต่ยังเปิดรับสมัคร/u.test(row.title)),
    `ต้องเห็นรอบที่ผ่านไปแล้ว — ${JSON.stringify(lints.map((r) => r.title))}`);
});

test("สอนแล้วต้องหายจากกล่อง และกลับมาเองถ้ารุ่นนั้นถูกปัดตก", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ",
  });
  const before = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.ok(rowById(before.json.rows, `correction:${correctionId}`), "ก่อนสอนต้องอยู่ในกล่อง");

  const written = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId, reasonChips: ["wrong_fact"], correctText: "จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ" },
  }, auth(owner));
  assert.equal(written.status, 200, written.text);

  const after = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.equal(rowById(after.json.rows, `correction:${correctionId}`), null, "สอนแล้วต้องหายจากกล่อง");
});

test("รุ่นที่ถูกปัดตก = ยังไม่มีใครสอนของชิ้นนั้นจริง คำแก้ต้องกลับมาในกล่องเอง", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  // หนี้ความรู้ทำให้รุ่นค้างเป็น "รอรับทราบ" ซึ่งเป็นสถานะเดียวที่ปัดตกได้จริง
  db.addKnowledge({ title: "โปรเก่า", content: "รุ่นก่อนลดเหลือ 9,500 บาท", updatedBy: "ngoung" });
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  const correctionId = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "จอดฟรี 4 ชั่วโมงค่ะ",
  });
  const written = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId },
  }, auth(owner));
  assert.equal(written.status, 409, written.text);
  const versionId = written.json.brain.versionId;
  assert.equal(db.getCorrection(correctionId).taught_version_id, versionId, "ค้างอยู่ก็นับว่าส่งแล้ว");
  const gone = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.equal(rowById(gone.json.rows, `correction:${correctionId}`), null);

  const discard = await post(app.server, `/console/api/brain/versions/${versionId}/discard`, {}, auth(owner));
  assert.equal(discard.status, 200, discard.text);
  const back = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.ok(rowById(back.json.rows, `correction:${correctionId}`), "รุ่นถูกปัดตก = คำแก้ต้องกลับมาในกล่อง");
});

test('ปุ่ม "ไม่ต้องสอน" ปิดคำแก้พร้อมเหตุผล และไม่โผล่กลับมาอีก', async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "เคสเฉพาะของลูกค้ารายนี้",
  });
  const res = await post(app.server, `/console/api/corrections/${correctionId}/decide`,
    { action: "reject", reason: "เป็นเคสเฉพาะราย ไม่ใช่กติกาของร้าน" }, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.equal(db.getCorrection(correctionId).status, "rejected");
  assert.match(db.getCorrection(correctionId).reason, /เคสเฉพาะราย/u);
  const review = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.equal(rowById(review.json.rows, `correction:${correctionId}`), null, "ปัดตกแล้วต้องไม่โผล่ในกล่องอีก");
});

/* ---------------------------------- จอสอน ---------------------------------- */

test("จอสอนตั้งต้นจากคำแก้: จัดชนิด แสดงการ์ดที่น่าจะเกี่ยว และไม่คัดลอกข้อความลูกค้ามาเลย", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "ที่จอดรถและการเดินทาง จอดฟรี 4 ชั่วโมงค่ะ",
  });
  const res = await get(app.server,
    `/console/api/teach/session?source=correction&ref=${correctionId}`, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.proposal.kind, "fact");
  assert.equal(res.json.proposal.risk, "green");
  assert.equal(res.json.proposal.writable, true);
  assert.ok(res.json.related.some((card) => card.title === "ที่จอดรถและการเดินทาง"),
    `ต้องเจอการ์ดที่พูดเรื่องเดียวกัน — ${JSON.stringify(res.json.related)}`);
  assert.ok(res.json.chips.length >= 6, "ต้องส่งชิปเหตุผลครบให้จอเลือก");
});

test("จอสอนยกระดับเป็นสีแดงเมื่อข้อความมีเรื่องเงิน และบอกคำที่ทำให้ยกระดับ", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, "/console/api/teach/plan", {
    chips: ["wrong_fact"], title: "ส่วนลดศิษย์เก่า", correctText: "ศิษย์เก่าลดพิเศษเหลือ 15,900 บาทค่ะ",
  }, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.proposal.kind, "price", "ชิปบอกว่าเป็นข้อเท็จจริง แต่เนื้อเป็นราคา -> ต้องยกระดับ");
  assert.equal(res.json.proposal.risk, "red");
  assert.ok(res.json.proposal.escalatedBy.length > 0, "ต้องบอกคำที่ทำให้ยกระดับ");
  assert.match(res.json.proposal.splitHint, /แยกเป็นสองใบ/u);
});

test("จอสอนบล็อกข้อความที่มีข้อมูลส่วนบุคคลของลูกค้า ไม่ว่าชิปจะบอกว่าอะไร", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, "/console/api/teach/plan", {
    chips: ["wrong_fact"], title: "ติดต่อคุณเอ", correctText: "โทรหาลูกค้าที่ 0812345678 ได้เลยค่ะ",
  }, auth(owner));
  assert.equal(res.json.proposal.blocked, true);
  assert.equal(res.json.proposal.writable, false);
  assert.match(res.json.proposal.blockReason, /ข้อมูลที่อาจระบุตัวบุคคล/u);
});

test("ชิปที่ยังสอนจากจอนี้ไม่ได้ ต้องบอกเหตุผลตรง ๆ ไม่ใช่เงียบ", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, "/console/api/teach/plan", {
    chips: ["should_handoff"], correctText: "เคสนี้ควรส่งให้คนดูแลต่อ",
  }, auth(owner));
  assert.equal(res.json.proposal.writable, false);
  assert.match(res.json.proposal.notWritableWhy, /golden turns|คลังตัวอย่าง/u);
});

/* ------------------------------- Step 0 ซื่อสัตย์ ------------------------------- */

test("Step 0: เทิร์นที่ไม่ได้ผูกกับรุ่นสมอง ต้องเขียนว่าอ่านจากตารางเดิม", async (t) => {
  const { app, db } = await boot(t, { versioned: false });
  const owner = await login(app.server, "ngoung");
  const messageId = db.insertMessage({
    customerId: CUSTOMER, direction: "out", content: "จอดฟรี 2 ชั่วโมงค่ะ", agentMode: "ai",
  });
  const res = await get(app.server, `/console/api/teach/why?messageId=${messageId}`, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.why.brain.known, false);
  assert.equal(res.json.why.brain.label, READ_FROM_LEGACY_TABLES);
  assert.match(res.json.why.brain.why, /ยังอ่านคลังความรู้และตารางราคาโดยตรง/u);
  assert.ok(res.json.why.unknown.length >= 1, "ต้องเขียนสิ่งที่ระบบไม่รู้ไว้บนหน้าเดียวกัน");
});

test("Step 0: เทิร์นที่ผูกกับรุ่นสมองจริง ต้องบอกรุ่นและแหล่งที่ป้อนคำตอบ", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const live = db.getBrainPointer("live");
  const messageId = db.insertMessage({
    customerId: CUSTOMER, direction: "out", content: "จอดฟรี 2 ชั่วโมงค่ะ",
    agentMode: "ai", brainVersionId: live.version_id,
  });
  const res = await get(app.server, `/console/api/teach/why?messageId=${messageId}`, auth(owner));
  assert.equal(res.json.why.brain.known, true);
  assert.equal(res.json.why.brain.label, `รุ่นสมอง ${live.seq}`);
  assert.ok(res.json.why.brain.sources.some((source) => source.kind === "fact" && source.count > 0),
    `ต้องบอกแหล่งที่ป้อนคำตอบ — ${JSON.stringify(res.json.why.brain.sources)}`);
  assert.ok(res.json.why.unknown.some((line) => /ไม่รู้ว่าโมเดลหยิบการ์ดใบไหน/u.test(line)),
    "ต้องพูดตรง ๆ ว่าไม่รู้ว่าโมเดลใช้การ์ดใบไหน");
});

test("Step 0: ข้อความที่คนตอบเอง ต้องไม่ถูกอ้างว่าเป็นคำตอบของ AI", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const messageId = db.insertMessage({
    customerId: CUSTOMER, direction: "out", content: "เดี๋ยวทีมงานติดต่อกลับนะคะ",
    operator: "chompoo", agentMode: "operator_ai_off",
  });
  const res = await get(app.server, `/console/api/teach/why?messageId=${messageId}`, auth(owner));
  assert.equal(res.json.why.route.answeredBy, "คน");
  assert.equal(res.json.why.route.operator, "chompoo");
  assert.equal(res.json.why.brain.known, false);
});

/* ============ รอบตรวจที่สอง: การจับคู่การ์ด และตารางราคา ============ */

// ข้อ 6: ตัวจับคู่เดิมตัดคำด้วยช่องว่าง ซึ่งภาษาไทยไม่มี — ประโยคที่พูดเรื่องเดียวกัน
// แต่ใช้คำต่างกันเล็กน้อยจึงไม่แมตช์อะไรเลย แล้วหน้าจอยืนยันว่า "ไม่พบการ์ดที่พูดเรื่องเดียวกัน"
test("การ์ดที่น่าจะเกี่ยวต้องเจอ แม้ข้อความจะไม่มีช่องว่างและใช้คำต่างกัน", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  db.addKnowledge({ title: "ที่จอดรถและการเดินทาง", content: "จอดฟรี 2 ชั่วโมงที่อาคาร B เดินจากบีทีเอส 5 นาที", updatedBy: "ngoung" });
  const res = await post(app.server, "/console/api/teach/plan", {
    chips: ["wrong_fact"], title: "", correctText: "ที่จอดรถของอาคารบีจอดฟรีได้สี่ชั่วโมงนะคะ",
  }, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.related.length >= 1,
    `ต้องเจอการ์ดที่พูดเรื่องที่จอดรถ — ${JSON.stringify(res.json.related)}`);
  assert.ok(res.json.related.some((card) => /ที่จอดรถ/u.test(card.title)));
});

test("ไม่มีการ์ดไหนใกล้เคียงเลย ต้องบอกว่าระบบหาไม่เจอ ไม่ใช่ยืนยันว่าไม่มี", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, "/console/api/teach/plan", {
    chips: ["wrong_fact"], title: "", correctText: "เรื่องที่ไม่เคยมีใครเขียนไว้เลยสักใบ",
  }, auth(owner));
  assert.equal(res.status, 200);
  assert.equal(res.json.searchIsWeak, true, "ต้องบอกว่าผลการค้นอ่อน");
});

test("การ์ดที่น่าจะเกี่ยวต้องส่งเนื้อหาเดิมมาด้วย จอสอนจึงแสดงของที่จะถูกแทนที่ได้", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "ที่จอดรถจอดฟรี 4 ชั่วโมงค่ะ",
  });
  const res = await get(app.server, `/console/api/teach/session?source=correction&ref=${correctionId}`, auth(owner));
  const card = res.json.related.find((row) => row.title === "ที่จอดรถและการเดินทาง");
  assert.ok(card, `ต้องเจอการ์ด — ${JSON.stringify(res.json.related)}`);
  assert.equal(card.content, "จอดฟรี 2 ชั่วโมงที่อาคาร B", "ต้องส่งเนื้อหาเดิมมาให้แก้");
  assert.equal(card.chars, "จอดฟรี 2 ชั่วโมงที่อาคาร B".length);
});

// ข้อ 7: สอนเรื่องราคาได้ทางเดียวคือ "เพิ่ม" — ชื่อเดิมตัน 409 ชื่อคล้ายกันได้ราคาสองแถว
test("จอสอนต้องรู้จักตารางราคาปัจจุบัน เพื่อให้เลือกแก้ของเดิมได้", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: "ลดเหลือ 15,900 บาท" });
  const res = await get(app.server, `/console/api/teach/session?source=correction&ref=${correctionId}`, auth(owner));
  assert.ok(Array.isArray(res.json.prices), "ต้องส่งตารางราคามาด้วย");
  assert.ok(res.json.prices.some((row) => row.label === "AI Agent for Business"));
});

test("ชื่อรายการราคาที่ต่างกันแค่ช่องว่าง/ตัวพิมพ์ ต้องถูกปฏิเสธ ไม่ใช่ได้ราคาสองแถว", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, "/console/api/prices",
    { label: "ai agent  for business", amount: 21900 }, auth(owner));
  assert.equal(res.status, 409, `ต้องกันชื่อที่ซ้ำแบบใกล้เคียง — ${res.text}`);
  assert.match(res.json.error, /มีรายการนี้อยู่แล้ว/u);
});

// ข้อ 9: กดส่งซ้ำ (เน็ตอืด/กดสองที) ต้องไม่ได้การ์ดสองใบ
test("ส่งซ้ำด้วยกุญแจเดิมภายในไม่กี่นาที ต้องถูกปฏิเสธว่าเป็นการส่งซ้ำ", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: "จอดฟรี 4 ชั่วโมง" });
  const body = {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teachKey: "teach-key-abc123",
    teach: { source: "correction", correctionRef: correctionId },
  };
  const first = await post(app.server, "/console/api/knowledge", body, auth(owner));
  assert.equal(first.status, 200, first.text);
  const second = await post(app.server, "/console/api/knowledge", body, auth(owner));
  assert.equal(second.status, 409, `ครั้งที่สองต้องถูกปฏิเสธ — ${second.text}`);
  assert.match(second.json.error, /ส่งไปแล้ว/u);
  assert.equal(db.listKnowledge().filter((row) => row.title === "ที่จอดรถ (แก้แล้ว)").length, 1,
    "ต้องมีการ์ดใบเดียว");
});

/* ============ รอบตรวจที่สอง: กล่องตรวจต้องพูดความจริง ============ */

// ข้อ 10: "สอนแล้ว" เดิมอนุมานจากรุ่นล่าสุด 80 ใบ — พอมีรุ่นครบ 80 ใบ คำแก้ที่สอนไปแล้ว
// จะโผล่กลับมาเองทั้งหมด แล้วคนจะสอนซ้ำโดยไม่รู้ตัว
test("สอนแล้วต้องถูกบันทึกไว้บนแถวคำแก้ ไม่ใช่อนุมานจากรุ่นล่าสุดไม่กี่ใบ", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "จอดฟรี 4 ชั่วโมงค่ะ",
  });
  const written = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (แก้แล้ว)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId },
  }, auth(owner));
  assert.equal(written.status, 200, written.text);
  assert.ok(db.getCorrection(correctionId).taught_version_id, "แถวคำแก้ต้องจำไว้ว่าสอนไปแล้ว");

  // รุ่นใหม่อีกหลายใบ ไม่ทำให้ของที่สอนไปแล้วโผล่กลับมา
  for (let i = 0; i < 3; i += 1) {
    await post(app.server, "/console/api/knowledge",
      { title: `ความรู้เพิ่ม ${i}`, content: `เนื้อหา ${i}` }, auth(owner));
  }
  const review = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.equal(rowById(review.json.rows, `correction:${correctionId}`), null,
    "สอนแล้วต้องไม่กลับมาไม่ว่าจะมีรุ่นใหม่อีกกี่ใบ");
});

// ข้อ 11: ทีมงานกดสอน = คำขอเข้าคิว แต่แถวเดิมยังกดส่งซ้ำได้เรื่อย ๆ
test("ทีมงานสอนแล้วแถวต้องบอกว่าส่งให้พี่ง้วงแล้ว และกดสอนซ้ำไม่ได้", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const correctionId = db.addCorrection({
    customerId: CUSTOMER, aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ", humanFinal: "จอดฟรี 4 ชั่วโมงค่ะ",
  });
  const queued = await post(app.server, "/console/api/knowledge", {
    title: "ที่จอดรถ (ชมพู่เสนอ)", content: "จอดฟรี 4 ชั่วโมงที่อาคาร B",
    teach: { source: "correction", correctionRef: correctionId },
  }, auth(staff));
  assert.equal(queued.status, 202, queued.text);

  const review = await get(app.server, "/console/api/teach/review", auth(staff));
  const row = rowById(review.json.rows, `correction:${correctionId}`);
  assert.ok(row, "แถวยังต้องอยู่ให้เห็นสถานะ");
  assert.equal(row.actions.teach, false, "กดสอนซ้ำไม่ได้");
  assert.match(row.pendingNote || "", /ส่งให้พี่ง้วงแล้ว รออนุมัติ/u);
});

// ข้อ 12: รายการตัดที่ 60 ใบโดยไม่มีหน้าถัดไป และตัวนับบนชิปนับจากชุดที่ถูกตัดแล้ว
test("รายการยาวต้องบอกจำนวนจริง มีหน้าถัดไป และของค้างต้องไม่ถูกเบียดหาย", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2020-01-10", classKey: "onsite", label: "รอบเก่า", product: "AI Agent for Business", status: "open", capacity: 15 },
  ]));
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  for (let i = 0; i < 80; i += 1) {
    db.addCorrection({ customerId: CUSTOMER, aiDraft: `ร่าง ${i}`, humanFinal: `คำแก้ ${i}` });
  }
  const res = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.ok(res.json.total >= 80, `ต้องบอกจำนวนจริงทั้งหมด — ${res.json.total}`);
  assert.equal(res.json.hasMore, true, "ต้องบอกว่ายังมีต่อ");
  assert.ok(res.json.rows.some((row) => row.source === "lint"),
    "ของค้างในสมองต้องมีที่นั่งของตัวเอง ไม่ถูกคำแก้ 80 ใบเบียดหาย");
  const second = await get(app.server,
    `/console/api/teach/review?cursor=${encodeURIComponent(res.json.cursor)}`, auth(owner));
  assert.ok(second.json.rows.length > 0, "หน้าถัดไปต้องมีของ");
  assert.equal(second.json.rows.some((row) => res.json.rows.some((first) => first.id === row.id)), false,
    "หน้าถัดไปต้องไม่ซ้ำกับหน้าแรก");
});

// ข้อ 13: สองคนเปิดแถวเดียวกัน คนหนึ่งปัดตกไปแล้ว อีกคนยังสอนต่อได้เงียบ ๆ
test("เปิดจอสอนของเรื่องที่ถูกตัดสินไปแล้ว ต้องบอกว่าใครตัดสินและเมื่อไร", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const correctionId = db.addCorrection({ customerId: CUSTOMER, aiDraft: "x", humanFinal: "y" });
  db.updateCorrection(correctionId, { status: "rejected", decidedBy: "chompoo", reason: "เคสเฉพาะราย" });
  const res = await get(app.server,
    `/console/api/teach/session?source=correction&ref=${correctionId}`, auth(owner));
  assert.equal(res.status, 409, `ต้องปฏิเสธ — ${res.text}`);
  assert.match(res.json.error, /ถูกตัดสินไปแล้ว/u);
  assert.match(res.json.error, /chompoo/u, "ต้องบอกว่าใครตัดสิน");
});

// ข้อ 14: แถว PDPA ชี้ไปที่ปุ่มที่ไม่มีอยู่จริง
test("แถวที่ต้องให้ช่างทำ ต้องบอกตรง ๆ และมีปุ่มแจ้งช่างที่ทำงานจริง", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const live = db.getBrainPointer("live");
  const revId = JSON.parse(live.manifest_json).revIds[0];
  db.redactBrainRev(revId, { customerHash: "x".repeat(32), reason: "ลูกค้าขอให้ลบ" });
  const res = await get(app.server, "/console/api/teach/review", auth(owner));
  const row = res.json.rows.find((one) => one.source === "redaction");
  assert.ok(row, `ต้องเห็นแถวการ์ดที่ถูกลบ — ${JSON.stringify(res.json.rows.map((r) => r.source))}`);
  assert.match(row.blockedWhy, /ช่าง/u, "ต้องบอกตรง ๆ ว่าเรื่องนี้ต้องให้ช่างทำ");
  assert.equal(row.goTo, undefined, "ต้องไม่ชี้ไปหน้าที่ไม่มีปุ่มให้กด");
  assert.equal(row.actions.report, true, "ต้องมีปุ่มแจ้งช่าง");

  const sent = await post(app.server, "/console/api/teach/report",
    { rowId: row.id, note: "การ์ดถูกลบตามคำขอลูกค้า" }, auth(owner));
  assert.equal(sent.status, 200, sent.text);
  assert.ok(db.listAudit(10).some((entry) => entry.action === "teach_engineer_report"),
    "ต้องมีร่องรอยว่าแจ้งไปแล้ว");
});

test("ตัวนับบนชิปกรองต้องนับจากของทั้งหมด ไม่ใช่จากหน้าที่โหลดมา", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  for (let i = 0; i < 80; i += 1) {
    db.addCorrection({ customerId: CUSTOMER, aiDraft: `ร่าง ${i}`, humanFinal: `คำแก้ ${i}` });
  }
  const res = await get(app.server, "/console/api/teach/review", auth(owner));
  assert.ok(res.json.counts, "ต้องส่งตัวนับของทั้งชุดมาด้วย");
  assert.equal(res.json.counts.mine, 80, `คำแก้ต้องนับครบ 80 — ${JSON.stringify(res.json.counts)}`);
  assert.equal(res.json.counts.all, res.json.total);
});
