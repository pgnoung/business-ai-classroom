// v1.4.47: สวิตช์หยุด AI ทั้งระบบแบบยังรับข้อมูล (cutover เข้า LINE OA จริง — คำสั่งพี่ง้วง 2026-08-22)
//
// ต้องจริง 3 อย่าง: (1) paused = ไม่คิด ไม่ตอบ ไม่ทัก ไม่เสียเงิน (2) แต่ข้อมูลยังเดิน —
// ข้อความถูกบันทึก ชื่อถูกดึง (3) คอนโซลสลับได้ทันทีและชนะ env (kick off ปุ่มเดียว)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  aiPausedForReactiveCustomer, aiPausedNow, AI_PAUSE_SETTING, reactiveCanarySha256,
} from "../src/aiPause.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
// 12:00 เวลาไทย — กลางวันแน่นอน บวกอีก 3 ชม. ก็ยังไม่คร่อม quiet hours ของ staged FU
const NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0);

// `now` ฉีดนาฬิกาให้ฐานข้อมูล สำหรับเทสต์ที่ตรึงเวลาไว้ — ต้องเป็นนาฬิกาตัวเดียวกับที่
// ส่งให้ตัวที่กำลังเทสต์ ไม่งั้นแถวที่ db เขียนกับเวลาที่ประเมินจะอยู่คนละแกน
function makeApp({ configOverrides = {}, now = null } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb(now ? { now } : {});
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermesFetch = hermesFetchStub();
  const lineFetch = lineFetchStub();
  const app = createApp({ config, db, overrides: { hermesFetch, lineFetch, sleep: async () => {} }, logger: silent });
  return { app, db, config, hermesFetch, lineFetch };
}

test("aiPausedNow: env default -> DB override ชนะ -> อ่าน DB พังถือว่าหยุด (fail-safe)", () => {
  const db = memoryDb();
  assert.equal(aiPausedNow({ db, config: { aiPaused: false } }), false);
  assert.equal(aiPausedNow({ db, config: { aiPaused: true } }), true, "env AI_PAUSED=true = หยุด");
  db.setSetting(AI_PAUSE_SETTING, "0");
  assert.equal(aiPausedNow({ db, config: { aiPaused: true } }), false, "คอนโซล kick off ชนะ env");
  db.setSetting(AI_PAUSE_SETTING, "1");
  assert.equal(aiPausedNow({ db, config: { aiPaused: false } }), true);
  assert.equal(aiPausedNow({ db: { getSetting() { throw new Error("db down"); } }, config: { aiPaused: false } }), true, "อ่านไม่ได้ = เงียบไว้ก่อน");
  db.close();
});

test("reactive canary: pause ยกเว้นเฉพาะ customer ที่ hash ตรง; ค่าเสียหรืออ่าน DB พังยังเงียบ", () => {
  const canaryId = "U-reactive-canary";
  const canary = reactiveCanarySha256(canaryId);
  const db = memoryDb();
  const config = { aiPaused: true, aiPausedReactiveCanarySha256: canary };
  assert.equal(aiPausedForReactiveCustomer({ db, config, customerId: canaryId }), false);
  assert.equal(aiPausedForReactiveCustomer({ db, config, customerId: "U-someone-else" }), true);
  assert.equal(aiPausedForReactiveCustomer({ db, config: { ...config, aiPausedReactiveCanarySha256: "bad" }, customerId: canaryId }), true);
  assert.equal(aiPausedForReactiveCustomer({
    db: { getSetting() { throw new Error("db down"); } }, config, customerId: canaryId,
  }), true);
  db.setSetting(AI_PAUSE_SETTING, "0");
  assert.equal(aiPausedForReactiveCustomer({ db, config, customerId: "U-someone-else" }), false);
  db.close();
});

test("paused + reactive canary: ตอบได้เฉพาะ canary ขาเข้า คนอื่นไม่คิดและไม่ส่ง", async () => {
  const canaryId = "U-reactive-canary-live";
  const { app, db, hermesFetch, lineFetch } = makeApp({
    configOverrides: {
      AI_PAUSED: "true",
      AI_PAUSED_REACTIVE_CANARY_SHA256: reactiveCanarySha256(canaryId),
    },
  });
  const allowed = await app.pipeline.handleInboundText({ customerId: canaryId, text: "สนใจคลาส AI ครับ", replyToken: "rt-canary" });
  assert.equal(allowed?.sent, true);
  const blocked = await app.pipeline.handleInboundText({ customerId: "U-not-canary", text: "สนใจคลาส AI ครับ", replyToken: "rt-other" });
  assert.equal(blocked?.suppressed, "ai_paused");
  assert.equal(hermesFetch.calls.length, 1);
  assert.equal(lineFetch.sends.length, 1);
  db.close();
});

test("paused: ข้อความเข้า -> ไม่เรียกโมเดล ไม่ส่ง แต่ข้อมูลยังเดิน (บันทึก/ชื่อ/ลูกค้า)", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp({ configOverrides: { AI_PAUSED: "true" } });
  const customerId = "U-paused-1";
  db.insertMessage({ id: "in:paused-1", customerId, direction: "in", msgType: "text", content: "สวัสดีครับ ผมชื่อสมชายครับ" });
  const result = await app.pipeline.handleInboundText({ customerId, text: "สวัสดีครับ ผมชื่อสมชายครับ", replyToken: "rt" });
  assert.equal(result?.suppressed, "ai_paused");
  assert.equal(hermesFetch.calls.length, 0, "ห้ามเสียเงินคิด");
  assert.equal(lineFetch.sends.length, 0, "ห้ามตอบ");
  assert.ok(db.getCustomer(customerId), "แถวลูกค้าต้องถูกสร้าง");
  assert.equal(db.getCustomer(customerId).ai_enabled, 1, "paused ไม่ใช่การปิด AI รายคน — สถานะรายคนต้องไม่ถูกแตะ");
  db.close();
});

test("kick off จากคอนโซล: setting ai_paused=0 ชนะ env -> ตอบทันที โดยไม่ต้อง restart", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp({ configOverrides: { AI_PAUSED: "true" } });
  const customerId = "U-kickoff";
  const before = await app.pipeline.handleInboundText({ customerId, text: "สนใจคลาส AI ค่ะ", replyToken: "rt1" });
  assert.equal(before?.suppressed, "ai_paused");
  db.setSetting(AI_PAUSE_SETTING, "0"); // = กด kick off ในคอนโซล
  const after = await app.pipeline.handleInboundText({ customerId, text: "สนใจคลาส AI ค่ะ", replyToken: "rt2" });
  assert.equal(after?.sent, true);
  assert.equal(hermesFetch.calls.length, 1);
  assert.equal(lineFetch.sends.length, 1);
  db.close();
});

test("paused: staged follow-up ต้องไม่ทักใคร (skipped ai_paused)", async () => {
  const { app, db } = makeApp({
    configOverrides: { AI_PAUSED: "true", STAGED_FOLLOWUP_TICK_MS: "0" },
    now: () => NOON_BKK,
  });
  const customerId = "U-fu-paused";
  db.upsertCustomer(customerId, { displayName: "ทดสอบ" });
  db.insertMessage({ id: "in:fu-paused", customerId, direction: "in", msgType: "text", content: "สนใจคลาสครับ" });
  db.raw.prepare("UPDATE customers SET last_score=6, followup_enabled=1, marketing_consent=1 WHERE line_user_id=?").run(customerId);
  // ตรึงเวลาประเมิน: Date.now() + 3 ชม. ข้ามเข้า quiet hours ได้ตามเวลาที่บังเอิญรันเทสต์
  const result = await app.stagedFollowups.processCustomer(db.getCustomer(customerId), NOON_BKK + 3 * 3_600_000);
  assert.equal(result?.skipped, "ai_paused");
  db.close();
});

test("paused: urgent mental ยังบันทึก handoff + ปิด AI รายคน แต่ไม่เรียกโมเดล/LINE", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp({ configOverrides: { AI_PAUSED: "true" } });
  const customerId = "U-paused-urgent";
  const result = await app.pipeline.handleInboundText({
    customerId,
    text: "ธุรกิจผมเจ๊งหมดตัว เหนื่อยจนไม่อยากอยู่ต่อแล้ว",
    replyToken: "rt-urgent",
  });
  assert.equal(result?.suppressed, "ai_paused");
  const customer = db.getCustomer(customerId);
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.match(customer.handoff_summary, /urgent_mental/u);
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, "urgent_mental");
  assert.equal(hermesFetch.calls.length, 0);
  assert.equal(lineFetch.sends.length, 0);
  db.close();
});

test("pause ระหว่าง Hermes ร่างคำตอบ -> final boundary ทิ้ง draft และไม่ส่ง LINE", async () => {
  let releaseDraft;
  const draftGate = new Promise((resolve) => { releaseDraft = resolve; });
  const hermesFetch = hermesFetchStub("ยินดีดูแลค่ะ สนใจคลาสไหนเป็นพิเศษคะ", {
    onCall: () => draftGate,
  });
  const lineFetch = lineFetchStub();
  const config = testConfig();
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const app = createApp({ config, db, overrides: { hermesFetch, lineFetch, sleep: async () => {} }, logger: silent });
  const pending = app.pipeline.handleInboundText({ customerId: "U-pause-race", text: "สนใจคลาส AI ครับ", replyToken: "rt" });
  while (hermesFetch.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  db.setSetting(AI_PAUSE_SETTING, "1");
  releaseDraft();
  const result = await pending;
  assert.equal(result?.suppressed, "ai_paused_before_send");
  assert.equal(lineFetch.sends.length, 0);
  db.close();
});

// ---- 2026-08-24: โหมดร่างอย่างเดียว (พี่ง้วงเลือกระหว่าง cutover) ----
import { aiPausedDraftModeOn, AI_PAUSE_DRAFT_SETTING } from "../src/aiPause.mjs";

test("aiPausedDraftModeOn: DB ชนะ env · อ่าน DB พัง = ปิดโหมดร่าง (ไม่คิด ไม่เสียเงิน)", () => {
  const db = memoryDb();
  assert.equal(aiPausedDraftModeOn({ db, config: { aiPausedDraftMode: false } }), false);
  assert.equal(aiPausedDraftModeOn({ db, config: { aiPausedDraftMode: true } }), true);
  db.setSetting(AI_PAUSE_DRAFT_SETTING, "0");
  assert.equal(aiPausedDraftModeOn({ db, config: { aiPausedDraftMode: true } }), false, "DB ปิดชนะ env เปิด");
  db.setSetting(AI_PAUSE_DRAFT_SETTING, "1");
  assert.equal(aiPausedDraftModeOn({ db, config: { aiPausedDraftMode: false } }), true);
  assert.equal(
    aiPausedDraftModeOn({ db: { getSetting() { throw new Error("db down"); } }, config: { aiPausedDraftMode: true } }),
    false, "fail-safe ทิศตรงข้าม pause: อ่านไม่ได้ = ไม่คิด",
  );
  db.close();
});

test("paused + โหมดร่าง: ไม่ส่ง LINE เลย แต่เก็บร่างสุดท้ายเข้า Correction Loop ให้การ์ดเหนือช่องพิมพ์", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp({ configOverrides: { AI_PAUSED: "true" } });
  db.setSetting(AI_PAUSE_DRAFT_SETTING, "1");
  const customerId = "U-paused-draft";
  const result = await app.pipeline.handleInboundText({ customerId, text: "สนใจคลาส AI ครับ", replyToken: "rt" });
  assert.equal(result?.suppressed, "ai_paused_draft_queued");
  assert.ok(hermesFetch.calls.length >= 1, "โหมดร่างต้องคิดจริง (มี model call)");
  assert.equal(lineFetch.sends.length, 0, "ห้ามมีอะไรหลุดถึง LINE เด็ดขาด — รวม loading animation");
  const draft = db.latestPendingDraft(customerId);
  assert.ok(draft, "ต้องมีร่างค้างให้แอดมิน");
  assert.ok(String(draft.ai_draft || "").length > 0);
  db.close();
});

test("paused + โหมดร่างปิด (ค่าเริ่มต้น): เงียบแบบเดิมเป๊ะ ไม่คิด ไม่เสียเงิน", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp({ configOverrides: { AI_PAUSED: "true" } });
  const result = await app.pipeline.handleInboundText({ customerId: "U-paused-silent", text: "สนใจคลาส AI ครับ", replyToken: "rt" });
  assert.equal(result?.suppressed, "ai_paused");
  assert.equal(hermesFetch.calls.length, 0, "ห้ามมี model call ตอนโหมดร่างปิด");
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(db.latestPendingDraft("U-paused-silent"), null);
  db.close();
});

test("kick off แล้ว: โหมดร่างไม่มีผล — ตอบลูกค้าปกติ ไม่เก็บ correction เพิ่ม", async () => {
  const { app, db, lineFetch } = makeApp();
  db.setSetting(AI_PAUSE_DRAFT_SETTING, "1");
  const customerId = "U-live-normal";
  const result = await app.pipeline.handleInboundText({ customerId, text: "สนใจคลาส AI ครับ", replyToken: "rt" });
  assert.ok(!result?.suppressed, `ต้องส่งปกติ (ได้ ${result?.suppressed})`);
  assert.ok(lineFetch.sends.length >= 1, "ต้องส่งถึง LINE");
  db.close();
});

// ---- audit 2026-08-24: ธงเรื่องเงินต้องถาวร (handoff_summary ถูกตัดทิ้งได้) ----
test("money_seen_at: ปักครั้งแรกชนะ · escalate เรื่องเงินปัก · PDPA reset ล้าง", () => {
  const db = memoryDb();
  const id = "U-money-flag";
  db.upsertCustomer(id, { displayName: "ทดสอบ" });
  assert.equal(Number(db.getCustomer(id).money_seen_at), 0);

  db.markMoneySeen(id);
  const first = Number(db.getCustomer(id).money_seen_at);
  assert.ok(first > 0, "ต้องปักธง");
  db.markMoneySeen(id);
  assert.equal(Number(db.getCustomer(id).money_seen_at), first, "เขียนครั้งแรกชนะ ไม่ทับเวลา");

  db.resetCustomer(id);
  assert.equal(Number(db.getCustomer(id).money_seen_at), 0, "test reset = ล้างธงด้วย");
  db.close();
});

test("เอกสารหลังสลิป: ลูกค้าส่งสลิปแล้วถาม 'ออกใบกำกับครับ' ต้องถึงคนจริง (ธงถาวรทำงาน)", async () => {
  const { app, db } = makeApp();
  const id = "U-slip-then-invoice";
  db.upsertCustomer(id, { displayName: "ลูกค้าจ่ายแล้ว" });
  db.markMoneySeen(id); // จำลองผลของสลิป/bank_sent ที่เกิดก่อนหน้า
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "ออกใบกำกับครับ", replyToken: "rt" });
  const customer = db.getCustomer(id);
  assert.ok(
    result?.route === "payment" || customer.state === "NEEDS_HUMAN" || customer.ai_enabled === 0,
    `จ่ายแล้วต้องไม่ให้ AI ตอบเรื่องเอกสารเอง (ได้ ${JSON.stringify(result)})`,
  );
  db.close();
});

test("เคสจริงเต็มเส้น: บอทถามเอกสาร -> ลูกค้าตอบ 'ออกใบกำกับครับ' -> ต้องไม่ถูกปิด AI", async () => {
  const { app, db } = makeApp();
  const id = "U-presale-invoice";
  db.upsertCustomer(id, { displayName: "ลีดใหม่" });
  // จำลองข้อความขาออกล่าสุดของบอท = คำถามเอกสาร (ตรงกับเคสจริง 15:51)
  db.insertMessage({
    customerId: id, direction: "out", msgType: "text", agentMode: "ai", messageClass: "reactive",
    content: "คุณลูกค้า ต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?",
  });
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "ออกใบกำกับครับ", replyToken: "rt" });
  assert.notEqual(result?.route, "payment");
  const customer = db.getCustomer(id);
  assert.notEqual(customer.state, "NEEDS_HUMAN", "ลีดก่อนซื้อต้องไม่ถูกส่งต่อคนเพราะตอบคำถามของบอทเอง");
  assert.equal(customer.ai_enabled, 1);
  db.close();
});

test("คำถามเอกสารจากแอดมินห้ามถูกนับเป็นคำถามของบอท — คำขอใบกำกับยังต้องถึงคน", async () => {
  const { app, db } = makeApp();
  const id = "U-human-doc-question";
  db.upsertCustomer(id, { displayName: "ลีดใหม่" });
  db.insertMessage({
    customerId: id, direction: "out", msgType: "text", agentMode: "ai", messageClass: "reactive",
    content: "คุณลูกค้า ต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?",
  });
  db.insertMessage({
    customerId: id, direction: "out", msgType: "text", operator: "somsak",
    agentMode: "operator_ai_on", messageClass: "reactive",
    content: "ออกเอกสารในนามบริษัทไหมครับ",
  });
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "บริษัทครับ ออกใบกำกับ", replyToken: "rt" });
  const customer = db.getCustomer(id);
  assert.ok(
    result?.route === "payment" || customer.state === "NEEDS_HUMAN" || customer.ai_enabled === 0,
    `คำถามล่าสุดเป็นของคน ต้องคงเส้นส่งต่อ (ได้ ${JSON.stringify(result)})`,
  );
  db.close();
});

test("ไม่มีคำถามเอกสารนำหน้า: 'ออกใบกำกับครับ' ยังเป็นเส้นเงินเหมือนเดิม (ไม่ผ่อนปรนลอย ๆ)", async () => {
  const { app, db } = makeApp();
  const id = "U-no-botq-invoice";
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "ออกใบกำกับครับ", replyToken: "rt" });
  const customer = db.getCustomer(id);
  assert.ok(
    result?.route === "payment" || customer.state === "NEEDS_HUMAN",
    `ต้องคงเส้นเดิมเมื่อบอทไม่ได้ถาม (ได้ ${JSON.stringify(result)})`,
  );
  db.close();
});
