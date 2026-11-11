// brain-review-round2.test.mjs — ข้อที่รีวิวรอบสองจับได้ (เฟส 1b)
//
// รวมไว้ไฟล์เดียวเพราะทั้งหมดตอบคำถามเดียวกัน: "ก่อนเปิดแฟล็ก ระบบยังโกหกตรงไหนอยู่บ้าง"
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
import { collectCurrentSourceCards } from "../src/brain/sources.mjs";
import { compileCards, sourceCardToCard } from "../src/brain/compile.mjs";
import { runBrainGates, findingKey } from "../src/brain/gate.mjs";
import { BRAIN_CODE_CONTRACT } from "../src/brain/import.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const QUIET = { warn() {}, debug() {}, log() {} };
const SECRET = "brain-round2-console-secret-0123456789";
const PASSWORD = "brain-round2-pass-1234";
const TODAY = todayInBangkok(Date.now());

async function boot(t, { debt = false, seed = null, notifier = null } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, KNOWLEDGE_VERSIONED: "true" });
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
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      ...(notifier ? { notifier } : {}),
    },
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

/* ---- 18: ตารางเดิมที่ถูกแก้ลับหลัง ต้องไม่ถูกกลืนเข้ารุ่นใหม่เงียบ ๆ ---- */

test("ตารางเดิมถูกแก้ลับหลัง -> การเขียนครั้งถัดไปถูกปฏิเสธ ไม่ใช่กลืน drift เข้ารุ่นใหม่", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  // จำลองสคริปต์/มือที่แก้ฐานตรง ๆ โดยไม่ผ่าน hook (หรือของที่ค้างจากตอนแฟล็กยังปิด)
  db.setApprovedPrice("AI Agent for Business", 21900);
  const before = db.listBrainVersions(50).length;

  const res = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  assert.equal(res.status, 409, `ต้องปฏิเสธ — ${res.status} ${res.text}`);
  assert.match(res.json.error, /สมองไม่ตรงกับตารางเดิม/u);
  assert.equal(db.listBrainVersions(50).length, before, "ต้องไม่ออกรุ่นที่กลืน drift เข้าไป");
  assert.equal(db.listKnowledge().some((row) => row.title === "ที่จอดรถ"), false);
});

/* ---- 19: กุญแจของ ack ต้องแยกรายข้อ ไม่ใช่รับทราบครั้งเดียวเงียบตลอดกาล ---- */

test("รับทราบตัวเลขหนึ่ง ต้องไม่ปิดปากตัวเลขอื่นของกฎเดียวกัน", () => {
  const db = memoryDb();
  db.addKnowledge({ title: "แคตตาล็อก", content: "คลาส AI Agent for Business", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.addKnowledge({ title: "โปรเก่า", content: "เคยลดเหลือ 9,500 บาท", updatedBy: "owner" });

  const gateNow = (acks) => {
    const cards = collectCurrentSourceCards(db, { logger: QUIET }).map(sourceCardToCard);
    const bundle = compileCards({
      cards, versionId: "c", treeSha256: "t", codeContract: BRAIN_CODE_CONTRACT, db, todayIso: TODAY, logger: QUIET,
    });
    return runBrainGates({ cards, bundle, touched: [], inheritedAcks: acks, todayIso: TODAY, previousBundle: bundle });
  };

  const first = gateNow([]);
  assert.equal(first.verdict, "needs_ack");
  const acks = [{ by: "ngoung", at: 1, items: first.needsAck.map(findingKey) }];
  assert.equal(gateNow(acks).verdict, "pass", "รับทราบแล้วต้องไม่ถามซ้ำ");

  // ตัวเลขคนละตัวในการ์ดคนละใบ = ข้อใหม่ ต้องถามใหม่ (เดิม G4:null ใบเดียวปิดปากทุกตัวเลข)
  db.addKnowledge({ title: "โปรอีกใบ", content: "แถมอีก 7,700 บาท", updatedBy: "owner" });
  const second = gateNow(acks);
  assert.equal(second.verdict, "needs_ack", "ตัวเลขใหม่ต้องถามใหม่");
  assert.ok(second.needsAck.some((f) => f.code === "G4" && /7,700/u.test(f.message)),
    `ด่านราคาต้องยังเห็นตัวเลขใหม่ — ${JSON.stringify(second.needsAck.map((f) => f.code))}`);
  db.close();
});

/* ---- 20: เบอร์/ไอดีของร้านเราเอง ต้องแก้ความรู้ใบนั้นได้ ---- */

test("ความรู้ที่มี LINE id ของร้านเอง: เติมเข้ารายการช่องทางของร้านแล้วแก้ได้", async (t) => {
  const { app, db } = await boot(t, {
    seed: (d) => d.addKnowledge({ title: "ช่องทางติดต่อ", content: "ทักไลน์ @pngoungshop ได้เลย", updatedBy: "ngoung" }),
  });
  const owner = await login(app.server, "ngoung");
  const entry = db.listKnowledge().find((row) => row.title === "ช่องทางติดต่อ");

  const blocked = await post(app.server, `/console/api/knowledge/${entry.id}`,
    { content: "ทักไลน์ @pngoungshop ได้ทุกวัน 9-18 น." }, auth(owner));
  assert.equal(blocked.status, 409, `ยังไม่ยกเว้น = ต้องถูกบล็อก — ${blocked.text}`);
  assert.match(blocked.json.error, /ข้อมูลที่อาจระบุตัวบุคคล/u);

  const allow = await post(app.server, "/console/api/brain/lint-allowlist",
    { values: ["@pngoungshop"] }, auth(owner));
  assert.equal(allow.status, 200, allow.text);

  const ok = await post(app.server, `/console/api/knowledge/${entry.id}`,
    { content: "ทักไลน์ @pngoungshop ได้ทุกวัน 9-18 น." }, auth(owner));
  assert.equal(ok.status, 200, `ยกเว้นแล้วต้องแก้ได้ — ${ok.text}`);
  assertParity(db, "หลังยกเว้นช่องทางของร้าน");
});

/* ---- 21: ปิดของเสีย และวาล์วนิรภัย ต้องไม่ถูกบล็อกด้วยของเสียชิ้นนั้นเอง ---- */

test("ปิดความรู้ที่ตัวมันเองมีตัวเลขนอกตาราง ต้องทำได้ (ลบได้อยู่แล้ว ปิดก็ต้องได้)", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");
  const bad = db.listKnowledge().find((row) => row.title === "โปรเก่า");

  const res = await post(app.server, `/console/api/knowledge/${bad.id}`, { active: false }, auth(owner));
  assert.equal(res.status, 200, `การปิดของเสียต้องไม่ถูกบล็อกด้วยของเสียชิ้นนั้น — ${res.text}`);
  assert.equal(db.getKnowledge(bad.id).active, 0);
  assertParity(db, "หลังปิดการ์ดที่มีหนี้");
});

test("ย้อนการเรียนรู้ทั้งสัปดาห์ ต้องไม่ถูกบล็อกด้วยหนี้ของสิ่งที่มันกำลังปิด", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const learningRun = db.createLearningRun({ dayKey: "2026-09-03" });
  const candidate = db.createLearningCandidate({
    runId: learningRun.id, dayKey: "2026-09-03", clusterKey: "promo",
    title: "โปรที่เรียนมาผิด", proposedContent: "ลดเหลือ 8,800 บาท", knowledgeDigest: knowledgeDigest(db),
  });
  // อนุมัติเข้าไปก่อน (มีหนี้ L02 ติดมาด้วย จึงต้องรับทราบ) แล้วค่อยกดวาล์วนิรภัย
  const approve = await post(app.server, `/console/api/learning/${candidate.id}/decide`,
    { action: "approve" }, auth(owner));
  assert.equal(approve.status, 409, `ของที่พาหนี้เข้ามาต้องถูกบล็อกตั้งแต่ตอนอนุมัติ — ${approve.text}`);

  // จำลองว่ามันเข้ามาแล้วจริง (เช่น เข้ามาตอนแฟล็กยังปิด) แล้วยกเข้าสมอง
  db.addKnowledge({
    title: "โปรที่เรียนมาผิด", content: "ลดเหลือ 8,800 บาท", updatedBy: "ngoung", source: "learning_digest",
  });
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY });

  const rolled = await post(app.server, "/console/api/learning/rollback-week",
    { confirm: "ROLLBACK" }, auth(owner));
  assert.equal(rolled.status, 200, `วาล์วนิรภัยต้องกดได้เสมอ — ${rolled.status} ${rolled.text}`);
  assert.equal(rolled.json.deactivated, 1);
  assertParity(db, "หลังกดวาล์วนิรภัย");
});

/* ---- 22: L02b ต้องเป็นบล็อกเมื่อคนเขียนใช้สิทธิ์ที่มอบมา ---- */

test("L02b: การ์ดสีเขียวที่พูดเงื่อนไขเงิน — เตือนเมื่อเจ้าของเขียน แต่บล็อกเมื่อเป็นสิทธิ์ที่มอบมา", () => {
  const db = memoryDb();
  db.addKnowledge({ title: "แคตตาล็อก", content: "คลาส AI Agent for Business", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  const entry = db.addKnowledge({ title: "ศิษย์เก่า", content: "ศิษย์เก่ามีส่วนลดพิเศษ ถามทีมงานได้", updatedBy: "owner" });
  const cards = collectCurrentSourceCards(db, { logger: QUIET }).map(sourceCardToCard);
  const bundle = compileCards({
    cards, versionId: "c", treeSha256: "t", codeContract: BRAIN_CODE_CONTRACT, db, todayIso: TODAY, logger: QUIET,
  });
  const shared = { cards, bundle, touched: [`fact:${entry.id}`], todayIso: TODAY, previousBundle: bundle };

  assert.equal(runBrainGates({ ...shared, delegated: false }).verdict, "pass",
    "เจ้าของเขียนเอง = เตือนอย่างเดียว");
  const delegated = runBrainGates({ ...shared, delegated: true });
  assert.equal(delegated.verdict, "block", "กฎข้อนี้เขียนไว้เองว่าเผยแพร่แบบมอบสิทธิ์ไม่ได้");
  assert.ok(delegated.blocking.some((f) => f.rule === "L02b"));
  db.close();
});

/* ---- 24: needs_ack ต้องปลุกเจ้าของ ---- */

test("needs_ack ต้องส่งแจ้งเตือนหาเจ้าของ ไม่ใช่ค้างเงียบ", async (t) => {
  const fired = [];
  const notifier = { fireLater: (payload) => fired.push(payload), fire: async () => {} };
  const { app } = await boot(t, { debt: true, notifier });
  const owner = await login(app.server, "ngoung");

  const res = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(owner));
  assert.equal(res.json?.brain?.outcome, "needs_ack", res.text);
  const ping = fired.find((row) => row.reason === "brain_needs_ack");
  assert.ok(ping, `ต้องปลุกเจ้าของ — ${JSON.stringify(fired.map((f) => f.reason))}`);
  assert.equal(ping.customerId, "ops:brain");
  assert.match(ping.reasonTextOverride, /รุ่นสมอง 2/u);
});

/* ---- 15/16/17: คำขอที่จบด้วย needs_ack ต้องไม่หาย และรุ่นที่ค้างต้องเห็น/ปัดตกได้ ---- */

test("คิว: คำขอที่จบด้วยรอรับทราบ ต้องค้างเป็น pending_ack แล้วปิดเองเมื่อเจ้าของรับทราบ", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const queued = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  assert.equal(queued.status, 202, queued.text);
  const approved = await post(app.server,
    `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.applied, false);
  assert.equal(approved.json.pendingAck, true, `ต้องไม่จบเป็น failed — ${approved.text}`);
  assert.equal(approved.json.request.status, "pending_ack");
  assert.match(approved.json.request.decisionNote, /รอพี่ง้วงรับทราบรุ่นสมอง 2/u);

  // รุ่นที่รออยู่ต้องส่งข้อค้างมาให้เห็น ไม่ใช่ให้กดรับทราบตาบอด
  const versions = await get(app.server, "/console/api/brain/versions", auth(owner));
  const proposed = versions.json.versions.find((row) => row.status === "proposed");
  assert.ok(proposed, "ต้องเห็นรุ่นที่รออยู่");
  assert.equal(versions.json.pending, 1);
  assert.ok(proposed.findings.length > 0, "ต้องส่งข้อค้างมาด้วย");
  assert.ok(proposed.label.includes("ที่จอดรถ"), `ป้ายต้องบอกว่าแก้อะไร — ${proposed.label}`);

  const ack = await post(app.server, `/console/api/brain/versions/${proposed.versionId}/ack`, {}, auth(owner));
  assert.equal(ack.status, 200, ack.text);
  assert.equal(db.getPublishRequest(queued.json.requestId).status, "approved", "คำขอต้องถูกปิดเองตอนรับทราบ");
  assertParity(db, "หลังรับทราบผ่านคิว");
});

test("รุ่นที่ค้าง: ปัดตกได้ และรุ่นที่แตกจากรุ่นเก่าถูกปิดให้เองพร้อมปลดคำขอในคิว", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const queued = await post(app.server, "/console/api/knowledge",
    { title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง" }, auth(staff));
  await post(app.server, `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, auth(owner));
  const proposed = db.listBrainVersions(50).find((row) => row.status === "proposed");
  assert.ok(proposed);

  // มีรุ่นค้างอยู่ = คำขอใบถัดไปของทีมงานต้องบอกให้เคลียร์ก่อน ไม่ใช่ทิ้งใบแรกเงียบ ๆ
  const second = await post(app.server, "/console/api/knowledge",
    { title: "ทางเข้า", content: "เข้าทางล็อบบี้" }, auth(staff));
  const secondApprove = await post(app.server,
    `/console/api/publish-requests/${encodeURIComponent(second.json.requestId)}/approve`, {}, auth(owner));
  assert.equal(secondApprove.json.applied, false);
  assert.match(String(secondApprove.json.error || secondApprove.json.brain?.outcome || ""), /ค้างอยู่|needs_ack/u);

  const rejected = await post(app.server,
    `/console/api/brain/versions/${proposed.version_id}/reject`, {}, auth(owner));
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(db.getBrainVersion(proposed.version_id).status, "rejected");
  assert.equal(db.getPublishRequest(queued.json.requestId).status, "rejected", "คำขอที่ผูกไว้ต้องถูกปิดด้วย");
  assertParity(db, "หลังปัดตกรุ่นที่ค้าง");
});

/* ---- 26: ย้อน/เดินหน้า ต้องเห็นความต่าง และเดินด่านกับรุ่นเป้าหมาย ---- */

test("ย้อนรุ่น: มีสรุปความต่างให้ดูก่อนกด และเดินหน้ากลับไปรุ่นที่ใหม่กว่าได้", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const first = db.getBrainPointer("live").version_id;
  await post(app.server, "/console/api/prices", { label: "Early Bird", amount: 12900 }, auth(owner));
  const second = db.getBrainPointer("live").version_id;

  const diff = await get(app.server, `/console/api/brain/versions/${first}/diff`, auth(owner));
  assert.equal(diff.status, 200, diff.text);
  assert.ok(diff.json.diff.prices.some((line) => line.includes("Early Bird")), JSON.stringify(diff.json.diff));
  assert.match(diff.json.diff.note, /โหมดสมองและข้อความเสริม/u);

  await post(app.server, `/console/api/brain/versions/${first}/rollback`, {}, auth(owner));
  assert.equal(db.getApprovedPrice("Early Bird"), null);
  assertParity(db, "หลังย้อนกลับ");

  // เดินหน้ากลับไปรุ่นที่ใหม่กว่าได้ (เดิมบล็อกด้วยเงื่อนไข seq น้อยกว่าเท่านั้น)
  const forward = await post(app.server, `/console/api/brain/versions/${second}/rollback`, {}, auth(owner));
  assert.equal(forward.status, 200, `ต้องเดินหน้ากลับไปได้ — ${forward.text}`);
  assert.equal(db.getApprovedPrice("Early Bird")?.amount, 12900);
  assertParity(db, "หลังเดินหน้ากลับ");
});

test("ย้อนไปรุ่นที่วันนี้ไม่ผ่านด่านแล้ว ต้องขอให้รับทราบก่อน ไม่ใช่ปล่อยผ่านเงียบ ๆ", async (t) => {
  const { app, db } = await boot(t, { debt: true });
  const owner = await login(app.server, "ngoung");
  const withDebt = db.getBrainPointer("live").version_id;
  // เคลียร์หนี้แล้วออกรุ่นใหม่ที่สะอาด
  const bad = db.listKnowledge().find((row) => row.title === "โปรเก่า");
  const cleaned = await post(app.server, `/console/api/knowledge/${bad.id}`, { active: false }, auth(owner));
  assert.equal(cleaned.status, 200, cleaned.text);

  const back = await post(app.server, `/console/api/brain/versions/${withDebt}/rollback`, {}, auth(owner));
  assert.equal(back.status, 409, `รุ่นเก่าที่ยังมีหนี้ ต้องถามก่อน — ${back.text}`);
  assert.equal(back.json.needsAck, true);
  assert.ok(back.json.findings.length > 0);

  const confirmed = await post(app.server, `/console/api/brain/versions/${withDebt}/rollback`,
    { ack: true }, auth(owner));
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(db.getBrainPointer("live").version_id, withDebt);
  assertParity(db, "หลังย้อนพร้อมรับทราบ");
});
