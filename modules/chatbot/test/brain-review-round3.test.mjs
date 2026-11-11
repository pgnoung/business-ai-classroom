// brain-review-round3.test.mjs — ข้อที่รีวิวรอบสามจับได้ (เฟส 1b)
//
// ส่วนใหญ่เป็น "โค้ดถูกแล้วแต่ไม่มีเทสต์" — ของที่ลบทิ้งได้โดยชุดเทสต์ไม่ร้อง คือของที่
// วันหนึ่งจะถูกลบทิ้งจริงโดยไม่มีใครรู้ตัว
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { brainParityReport } from "../src/brain/parity.mjs";
import { knowledgeDigest } from "../src/learningDigest.mjs";
import { runBrainLints } from "../src/brain/lint.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const QUIET = { warn() {}, debug() {}, log() {} };
const SECRET = "brain-round3-console-secret-0123456789";
const PASSWORD = "brain-round3-pass-1234";
const TODAY = todayInBangkok(Date.now());

async function boot(t, { versioned = true, debt = false, seed = null } = {}) {
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
  if (debt) db.addKnowledge({ title: "โปรเก่า", content: "เคยลดเหลือ 9,500 บาท", updatedBy: "ngoung" });
  if (seed) seed(db);
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

function assertParity(db, where) {
  const report = brainParityReport(db, { todayIso: TODAY, logger: QUIET });
  assert.equal(report.ok, true, `${where}: parity ต้องตรง — ${report.reason} ${JSON.stringify(report.mismatches)}`);
}

const send = (server, method, path, body, headers = {}) => httpRequest(server, {
  method, path,
  headers: { "content-type": "application/json", ...headers },
  body: body === undefined ? null : JSON.stringify(body),
});
const post = (server, path, body, headers) => send(server, "POST", path, body, headers);
const get = (server, path, headers = {}) => httpRequest(server, { path, headers });

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}
const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

/* ---- 1: เส้น diff ต้องมีทั้งด่านแฟล็กและด่านสิทธิ์ ---- */

test("เส้นเทียบรุ่น: ทีมงานเรียกไม่ได้ และแฟล็กปิดก็เรียกไม่ได้ (คอมไพล์สองสมองต่อครั้ง)", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const live = db.getBrainPointer("live").version_id;
  const denied = await get(app.server, `/console/api/brain/versions/${live}/diff`, auth(staff));
  assert.equal(denied.status, 403, `ทีมงานต้องเรียกไม่ได้ — ${denied.status} ${denied.text}`);

  const off = await boot(t, { versioned: false });
  const owner = await login(off.app.server, "ngoung");
  const liveOff = off.db.getBrainPointer("live").version_id;
  const refused = await get(off.app.server, `/console/api/brain/versions/${liveOff}/diff`, auth(owner));
  assert.equal(refused.status, 409, `แฟล็กปิดต้องเรียกไม่ได้ — ${refused.status} ${refused.text}`);
  assert.match(refused.json.error, /แฟล็กสมองยังปิดอยู่/u);
});

/* ---- 2: GET ต้องไม่เขียนอะไร ---- */

test("GET ประวัติรุ่นต้องไม่เขียนอะไรลงฐานเลย แม้จะมีรุ่นที่ควรถูกกวาด", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");
  // สร้างรุ่นที่รอรับทราบ แล้วทำให้มันล้าสมัยด้วยการเขียนของอย่างอื่นทับ
  const queued = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  await post(app.server, `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  const proposed = db.listBrainVersions(50).find((row) => row.status === "proposed");
  assert.ok(proposed);
  // ทำให้รุ่นนั้น "ล้าสมัยจริง" ก่อน — ไม่งั้นตัวกวาดไม่มีอะไรให้ทำ แล้วเทสต์จะผ่านทั้งที่
  // GET ยังกวาดอยู่ (เทสต์ที่ผ่านเพราะไม่มีอะไรเกิดขึ้น ไม่ได้กันอะไรเลย)
  db.addKnowledge({ title: "แทรก", content: "ของที่เพิ่มตรง", updatedBy: "ngoung" });
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  assert.notEqual(db.getBrainPointer("live").version_id, proposed.parent_id, "รุ่นที่รออยู่ต้องล้าสมัยแล้ว");
  const auditBefore = db.listAudit().length;

  const listed = await get(app.server, "/console/api/brain/versions", auth(owner));
  assert.equal(listed.status, 200, listed.text);
  assert.equal(db.getBrainVersion(proposed.version_id).status, "proposed", "GET ต้องไม่เปลี่ยนสถานะรุ่น");
  assert.equal(db.listAudit().length, auditBefore, "GET ต้องไม่เขียนแถว audit");
});

/* ---- 3: รูป payload ของคิวตอนแฟล็กปิด ต้องเท่ากับ base เป๊ะ ---- */

test("แฟล็กปิด: คีย์ของ publish request ต้องเป็นชุดเดิมเป๊ะ ไม่มีฟิลด์ใหม่ปน", async (t) => {
  const { app } = await boot(t, { versioned: false });
  const staff = await login(app.server, "chompoo");
  const owner = await login(app.server, "ngoung");
  const queued = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  assert.equal(queued.status, 202, queued.text);

  const listed = await get(app.server, "/console/api/publish-requests?status=pending", auth(owner));
  const row = listed.json.requests[0];
  assert.deepEqual(Object.keys(row).sort(), [
    "body", "createdAt", "decidedAt", "decidedBy", "decisionNote", "id", "kind",
    "method", "proposedBy", "result", "route", "status", "summary",
  ], "ชุดคีย์ต้องเท่ากับ base — ฟิลด์ใหม่ต้องโผล่เฉพาะเมื่อมีของจริงให้รอ");
  assert.equal(row.status, "pending");
});

/* ---- 4: แถวที่หายไประหว่างทาง ---- */

test("แก้ความรู้ที่เพิ่งถูกลบไป: ตอบไม่พบ ไม่ใช่ 200 ที่ entry ว่าง และไม่ทิ้ง audit หลอก", async (t) => {
  for (const versioned of [false, true]) {
    const { app, db } = await boot(t, { versioned });
    const owner = await login(app.server, "ngoung");
    const row = db.listKnowledge()[0];
    const auditBefore = db.listAudit().length;
    // จำลองการแข่ง: แถวหายไปหลังจาก handler อ่านเจอแล้ว
    const realUpdate = db.updateKnowledge.bind(db);
    db.updateKnowledge = () => null;

    const res = await post(app.server, `/console/api/knowledge/${row.id}`, { content: "เนื้อใหม่" }, auth(owner));
    db.updateKnowledge = realUpdate;
    assert.equal(res.status, 404, `แฟล็ก=${versioned}: ต้องตอบไม่พบ — ${res.status} ${res.text}`);
    assert.match(res.json.error, /ไม่พบความรู้รายการนี้/u);
    assert.equal(db.listAudit().length, auditBefore, "ไม่มีอะไรถูกแก้ = ต้องไม่มีแถว audit");
  }
});

/* ---- 6: คำขอที่ค้างต้องหลุดจาก pending_ack เมื่อถูกตัดสิน ---- */

test("คำขอที่ค้างรอรับทราบ: กดอนุมัติซ้ำแล้วต้องจบเป็น failed ไม่ใช่ค้าง pending_ack ตลอดกาล", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");
  const queued = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  const first = await post(app.server,
    `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  assert.equal(first.json.request.status, "pending_ack", first.text);

  const second = await post(app.server,
    `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.applied, false);
  const row = db.getPublishRequest(queued.json.requestId);
  assert.equal(row.awaiting_version_id, "", "ตัดสินแล้วต้องไม่ถือเลขรุ่นไว้อีก");
  const listed = await get(app.server, "/console/api/publish-requests?status=decided", auth(owner));
  assert.equal(listed.json.requests[0].status, "failed", `ต้องจบเป็น failed — ${listed.text}`);
  assert.equal(listed.json.requests[0].awaitingVersionId, undefined);
});

/* ---- 7: การกวาดรุ่นที่ล้าสมัย ---- */

test("รุ่นที่รออยู่แต่ live เดินไปแล้ว: ถูกปิดให้เองพร้อมปลดคำขอในคิวเป็น failed", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");
  const queued = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  await post(app.server, `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  const proposed = db.listBrainVersions(50).find((row) => row.status === "proposed");
  const first = db.getBrainPointer("live").version_id;

  // เจ้าของย้อนรุ่น = live ขยับ รุ่นที่รออยู่กลายเป็นของที่ใช้ไม่ได้อีก
  db.addKnowledge({ title: "แทรก", content: "ของที่เพิ่มตรง", updatedBy: "ngoung" });
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });
  assert.notEqual(db.getBrainPointer("live").version_id, first);

  // เส้นที่มีด่านครบเป็นตัวกวาด (ไม่ใช่ GET) — ยิงปุ่มปัดตกของรุ่นอื่นเพื่อให้การกวาดเดิน
  const other = db.listBrainVersions(50).find((row) => row.status === "retired");
  await post(app.server, `/console/api/brain/versions/${other.version_id}/reject`, {}, auth(owner));

  assert.equal(db.getBrainVersion(proposed.version_id).status, "rejected", "รุ่นที่ล้าสมัยต้องถูกปิดให้เอง");
  assert.equal(db.getPublishRequest(queued.json.requestId).status, "failed", "คำขอที่ผูกไว้ต้องถูกปลด");
  assert.match(db.getPublishRequest(queued.json.requestId).decision_note, /ส่งใหม่ได้เลย/u);
});

/* ---- 13: liveOnly ของสองเส้นการเรียนรู้ ---- */

test("liveOnly: ทั้งสองเส้นของการเรียนรู้ต้องถูกปฏิเสธเมื่อสมองยังมีข้อค้าง ไม่ใช่ค้างเป็นรุ่นรอ", async (t) => {
  // ต้องมีความรู้ที่ระบบเรียนมาจริงอยู่ก่อน วาล์วนิรภัยถึงจะมีอะไรให้ปิด (ไม่งั้นผลคือ unchanged)
  const { app, db } = await boot(t, {
    debt: true,
    seed: (d) => d.addKnowledge({
      title: "ที่เรียนมา", content: "จอดฟรี 2 ชั่วโมง", updatedBy: "ngoung", source: "learning_digest",
    }),
  });
  const owner = await login(app.server, "ngoung");
  const learningRun = db.createLearningRun({ dayKey: "2026-09-03" });
  const candidate = db.createLearningCandidate({
    runId: learningRun.id, dayKey: "2026-09-03", clusterKey: "parking",
    title: "ที่จอดรถ", proposedContent: "จอดฟรี 4 ชั่วโมง", knowledgeDigest: knowledgeDigest(db),
  });
  const versionsBefore = db.listBrainVersions(50).length;

  const approve = await post(app.server, `/console/api/learning/${candidate.id}/decide`,
    { action: "approve" }, auth(owner));
  assert.equal(approve.status, 409, `ต้องถูกปฏิเสธทันที — ${approve.status} ${approve.text}`);
  assert.equal(approve.json.brain.outcome, "blocked");
  assert.match(approve.json.error, /ต้องมีผลทันทีเท่านั้น/u);
  assert.equal(db.getLearningCandidate(candidate.id).status, "proposed", "คิวข้อเสนอต้องไม่ถูกปิด");

  const rolled = await post(app.server, "/console/api/learning/rollback-week",
    { confirm: "ROLLBACK" }, auth(owner));
  assert.equal(rolled.status, 409, `ต้องถูกปฏิเสธทันทีเช่นกัน — ${rolled.status} ${rolled.text}`);
  assert.equal(rolled.json.brain.outcome, "blocked");

  assert.equal(db.listBrainVersions(50).length, versionsBefore, "ต้องไม่เหลือรุ่นรอรับทราบไว้เลย");
  assertParity(db, "หลังปฏิเสธเส้น liveOnly");
});

/* ---- 14: สายเลือดของแถวความรู้ต้องเดินทางไปกับการ์ด ---- */

test("กู้แถวความรู้ที่มาจากข้อเสนอการเรียนรู้: source/provenance/version ต้องกลับมาครบ", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const learningRun = db.createLearningRun({ dayKey: "2026-09-03" });
  const candidate = db.createLearningCandidate({
    runId: learningRun.id, dayKey: "2026-09-03", clusterKey: "parking",
    title: "ที่จอดรถ", proposedContent: "จอดฟรี 4 ชั่วโมง", knowledgeDigest: knowledgeDigest(db),
  });
  const approved = await post(app.server, `/console/api/learning/${candidate.id}/decide`,
    { action: "approve" }, auth(owner));
  assert.equal(approved.status, 200, approved.text);
  const learned = db.getKnowledge(approved.json.entry.id);
  assert.equal(learned.source, "learning_digest");
  const anchor = db.getBrainPointer("live").version_id;

  // เดินหน้าอีกรุ่น แล้วลบแถวถาวร (จำลอง prune/แก้ฐานตรง) ก่อนย้อนกลับ
  await post(app.server, "/console/api/prices", { label: "Early Bird", amount: 12900 }, auth(owner));
  db.raw.exec(`DELETE FROM knowledge_entries WHERE id = '${learned.id}'`);
  const back = await post(app.server, `/console/api/brain/versions/${anchor}/rollback`, {}, auth(owner));
  assert.equal(back.status, 200, back.text);

  const restored = db.getKnowledge(learned.id);
  assert.ok(restored, "แถวต้องถูกกู้กลับ");
  assert.equal(restored.source, "learning_digest", "ที่มาต้องไม่กลายเป็นของที่ระบบสร้างเอง");
  assert.equal(JSON.parse(restored.provenance_json).candidateId, candidate.id, "provenance ต้องกลับมาครบ");
  assert.equal(restored.version, learned.version);
  assertParity(db, "หลังกู้แถวที่มาจากการเรียนรู้");
});

/* ---- 15: ตัวฉายต้องไม่แตะแถวที่ไม่ได้เปลี่ยน ---- */

test("ย้อนรุ่น: แถวที่เนื้อไม่เปลี่ยน ต้องไม่ถูกเขียนทับ (updated_at/updated_by คงเดิม)", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const untouched = db.listKnowledge()[0];
  const before = db.raw.prepare("SELECT updated_at, updated_by FROM knowledge_entries WHERE id = ?").get(untouched.id);
  const anchor = db.getBrainPointer("live").version_id;

  await post(app.server, "/console/api/prices", { label: "Early Bird", amount: 12900 }, auth(owner));
  const back = await post(app.server, `/console/api/brain/versions/${anchor}/rollback`, {}, auth(owner));
  assert.equal(back.status, 200, back.text);

  const after = db.raw.prepare("SELECT updated_at, updated_by FROM knowledge_entries WHERE id = ?").get(untouched.id);
  assert.deepEqual(after, before, "แถวที่ไม่ได้เปลี่ยนต้องไม่ถูกแตะ — ประวัติว่าใครแก้เมื่อไรคือข้อมูล");
  assert.equal(back.json.projected.knowledgeUpserted, 0, "ต้องไม่มีแถวความรู้ไหนถูกเขียนเลย");
});

/* ---- 16: ข้อความปฏิเสธต้องเรียกการ์ดด้วยชื่อที่คนอ่านออก ---- */

test("ข้อความปฏิเสธต้องบอกหัวข้อของความรู้ ไม่ใช่ fact:<uuid>", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, "/console/api/knowledge",
    { title: "โปรลับของทีม", content: "ลดเหลือ 12,345 บาท" }, auth(owner));
  assert.equal(res.status, 409, res.text);
  assert.match(res.json.error, /โปรลับของทีม/u, `ต้องบอกหัวข้อ — ${res.json.error}`);
  assert.doesNotMatch(res.json.error, /fact:[0-9a-f]{8}/u, "ห้ามโผล่ id ดิบ");
});

/* ---- 17: การ์ดที่ถูกปิด — L15 ยังเตือน ส่วนกฎเนื้อหาอื่นเงียบ ---- */

test("การ์ดที่ถูกปิด: L02/L12/L16 เงียบ แต่ L15 ยังเตือนพร้อมธง offCard", () => {
  const dirty = { title: "ของเสีย", content: "ลดเหลือ 9,500 บาท (Mock) โทร 0812345678 เเล้ว" };
  const cardOf = (inject) => ({
    itemId: "fact:1", kind: "fact", key: "fact:1", scope: {}, inject, priority: 50,
    body: { kind: "fact", ...dirty, channel_id: null, source_created_at: 0, source_rowid: 0 },
    provenance: { source: "console" }, validUntil: null,
  });
  const on = runBrainLints({ cards: [cardOf("pin")], bundle: { guardTables: { approvedAmounts: [] } }, mode: "gate" });
  for (const code of ["L02", "L12", "L16", "L15"]) {
    assert.ok(on.some((f) => f.code === code), `เปิดอยู่ต้องฟ้อง ${code}`);
  }

  const off = runBrainLints({ cards: [cardOf("never")], bundle: { guardTables: { approvedAmounts: [] } }, mode: "gate" });
  for (const code of ["L02", "L12", "L16"]) {
    assert.equal(off.filter((f) => f.code === code).length, 0, `ปิดแล้วต้องไม่ฟ้อง ${code}`);
  }
  const pii = off.find((f) => f.code === "L15");
  assert.ok(pii, "L15 ต้องยังเห็น เพราะเนื้อยังถูกเก็บอยู่ในฐาน");
  assert.equal(pii.severity, "warn");
  assert.equal(pii.offCard, true);
});

/* ---- 12: ผลตรวจที่แผงแสดง ต้องใช้ allowlist ตัวที่ด่านใช้จริง ---- */

test("แผงรุ่นสมอง: เติมช่องทางของร้านแล้ว ข้อค้างของใบนั้นต้องหายจากผลตรวจทันที", async (t) => {
  const { app, db } = await boot(t, {
    seed: (d) => d.addKnowledge({ title: "ช่องทางติดต่อ", content: "ทัก LINE id: pngoungshop", updatedBy: "ngoung" }),
  });
  const owner = await login(app.server, "ngoung");

  const before = await get(app.server, "/console/api/brain/versions", auth(owner));
  assert.ok(before.json.findings.live.some((f) => f.code === "L15"),
    `ก่อนยกเว้นต้องเห็นข้อค้าง — ${JSON.stringify(before.json.findings.live)}`);

  const allow = await post(app.server, "/console/api/brain/lint-allowlist",
    { values: ["pngoungshop"] }, auth(owner));
  assert.equal(allow.status, 200, allow.text);

  const after = await get(app.server, "/console/api/brain/versions", auth(owner));
  assert.equal(after.json.findings.live.filter((f) => f.code === "L15").length, 0,
    "แผงต้องอ่าน allowlist ตัวที่ด่านใช้จริง ไม่ใช่ค่าที่แช่ไว้ตอนนำเข้า");
});
