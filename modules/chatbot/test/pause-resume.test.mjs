// pause-resume — ข้อความที่ลูกค้าพิมพ์ระหว่าง AI พัก 15 นาที (คนเพิ่งตอบ) ต้องได้คำตอบหนึ่งครั้ง
// เมื่อหมดเวลาพัก ถ้ายังไม่มีใครตอบ (Bug 4, 2026-09-28)
//
// ของเดิม: ข้อความชุดนั้นถูกกลืนเป็น silent_by_design|operator_active ตลอดไป — ก.ย. 2026
// FB 133 ช่วงพัก 17 ช่วงไม่มีใครตอบเลย + LINE 7 ช่วง ทั้งที่นโยบายเจ้าของ 2 ก.ย. คือ
// "ตอบจากคอนโซลหรือ Business Suite → AI พัก 15 นาทีแล้วกลับมา"
//
// เทสต์ใช้นาฬิกาจริงตัวเดียว (ด่าน clock-hygiene) แล้ว "ย้อนเวลาทั้งห้อง" ด้วยการเลื่อน
// created_at ของข้อความถอยหลัง 20 นาที = ช่วงพักจบไปแล้ว 5 นาที ข้อความค้างอยู่ในช่วงพัก
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPERATOR_PAUSE_MS, pauseAiForHumanReply } from "../src/aiPausePolicy.mjs";
import { heldPausePartsForTurn } from "../src/pauseHeld.mjs";
import {
  PAUSE_RESUME_AUDIT_ACTION, PAUSE_RESUME_LANE, PAUSE_RESUME_LOOKBACK_MS, PAUSE_RESUME_SETTING,
  findPauseResume, pauseResumeEnabled,
} from "../src/pauseResume.mjs";
import { createApp } from "../src/server.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, lineFetchStub, promptText } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {} };
const SHIFT_MS = 20 * 60_000;
const HUMAN = "chompoo";
const FIRST_TEXT = "สนใจคลาส AI สำหรับผู้บริหารค่ะ";
const HUMAN_REPLY = "สวัสดีค่ะ ชมพู่ทีมงานพี่ง้วงเองนะคะ ยินดีดูแลค่ะ";
const PENDING = "รอบหน้าเปิดวันไหนคะ";
const PENDING_2 = "เรียนออนไลน์ได้ไหมคะ";
const REPLY = "ขอบคุณที่รอนะคะ สนใจคลาสแบบไหนเป็นพิเศษคะ";

// Hermes สองบท: ร่างคำตอบ (นับ + hook ได้) / scorer (ไม่นับ)
function hermesStub({ onDraft = null } = {}) {
  const drafts = [];
  const fn = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const system = body.messages?.[0]?.role === "system" ? promptText(body.messages[0].content) : "";
    const isScorer = system.includes("ระบบวิเคราะห์ความสนใจซื้อ");
    if (!isScorer) {
      drafts.push(body);
      await onDraft?.(body);
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: isScorer ? "{}" : REPLY } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    };
  };
  fn.drafts = drafts;
  return fn;
}

function makeApp(t, { onDraft = null } = {}) {
  const config = testConfig();
  const db = memoryDb();
  const hermesFetch = hermesStub({ onDraft });
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {} },
    logger: silent,
  });
  t.after(() => { app.pauseResume.stop(); db.close(); });
  return { app, db, hermesFetch, lineFetch };
}

const pushes = (lineFetch) => lineFetch.sends.filter((call) => call.url.endsWith("/v2/bot/message/push"));
const replies = (lineFetch) => lineFetch.sends.filter((call) => call.url.endsWith("/v2/bot/message/reply"));
const resumeAudits = (db) => db.listAudit(200).filter((row) => row.action === PAUSE_RESUME_AUDIT_ACTION);
// ก้อนข้อความของเทิร์นปัจจุบันที่โมเดลเห็น (แถว user สุดท้ายของคำขอร่าง)
const currentTurn = (draft) => promptText(draft.messages.filter((message) => message.role === "user").at(-1)?.content);
const count = (text, needle) => text.split(needle).length - 1;

// ลูกค้าทัก → แอดมินตอบเองจากคอนโซล (AI พัก 15 นาที) → ลูกค้าพิมพ์ต่อระหว่างพัก (AI เงียบตามกติกา)
// → เวลาผ่านไป 20 นาที ไม่มีใครตอบ
async function pausedRoom(app, db, customerId, { pending = [PENDING], msgType = "text", expire = true } = {}) {
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "in", content: FIRST_TEXT });
  db.insertMessage({ customerId, direction: "out", content: HUMAN_REPLY, operator: HUMAN });
  pauseAiForHumanReply(db, customerId);
  const during = [];
  for (const text of pending) {
    db.insertMessage({ customerId, direction: "in", msgType, content: text });
    if (msgType === "text") during.push(await app.pipeline.handleInboundText({ customerId, text, replyToken: "rt-pause" }));
  }
  if (expire) {
    db.raw.prepare("UPDATE messages SET created_at = created_at - ? WHERE customer_id = ?").run(SHIFT_MS, customerId);
    db.setOperatorActiveUntil(customerId, Date.now() - SHIFT_MS + OPERATOR_PAUSE_MS);
  }
  return during;
}

test("หมดเวลาพัก + ข้อความค้างที่ไม่มีใครตอบ -> AI ตอบหนึ่งครั้งด้วยบริบทเต็ม แล้วไม่ตอบซ้ำ", async (t) => {
  const { app, db, hermesFetch, lineFetch } = makeApp(t);
  const during = await pausedRoom(app, db, "U-resume", { pending: [PENDING, PENDING_2] });
  // พฤติกรรมเดิมที่ยังต้องอยู่: ระหว่างพัก AI ไม่แทรกคน
  assert.deepEqual(during.map((verdict) => verdict.suppressed), ["operator_active", "operator_active"]);
  assert.equal(lineFetch.sends.length, 0);

  const first = await app.pauseResume.runOnce();
  assert.equal(first.results.length, 1);
  assert.equal(first.results[0].outcome, "sent");
  assert.ok(pushes(lineFetch).length >= 1, "ไม่มี reply token แล้ว — ต้องส่งแบบ push");
  assert.equal(replies(lineFetch).length, 0);
  const seen = JSON.stringify(hermesFetch.drafts.at(-1).messages);
  assert.match(seen, new RegExp(PENDING, "u"), "ข้อความค้างต้องเป็นเทิร์นปัจจุบัน");
  assert.match(seen, new RegExp(PENDING_2, "u"), "ข้อความค้างทุกข้อความต้องเข้าเทิร์นเดียวกัน");
  assert.match(seen, /แอดมินทีมงานพิมพ์เอง/u, "โมเดลต้องเห็นคำตอบของคนในประวัติ");
  const audits = resumeAudits(db);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].target, "U-resume");
  assert.match(audits[0].detail, /2 ข้อความ → sent/u);
  assert.doesNotMatch(audits[0].detail, new RegExp(PENDING, "u"), "audit ห้ามเก็บข้อความลูกค้า");

  const sendsAfter = lineFetch.sends.length;
  const draftsAfter = hermesFetch.drafts.length;
  const second = await app.pauseResume.runOnce();
  assert.equal(second.results[0].skipped, "answered");
  assert.equal(lineFetch.sends.length, sendsAfter, "รอบถัดไปห้ามตอบซ้ำ");
  assert.equal(hermesFetch.drafts.length, draftsAfter, "รอบถัดไปห้ามเสียเงินคิดซ้ำ");
  assert.equal(resumeAudits(db).length, 1);
});

test("คนตอบเองแล้ว (ระหว่างพักหรือหลังพัก) -> AI ไม่ตอบ", async (t) => {
  const { app, db, lineFetch } = makeApp(t);
  await pausedRoom(app, db, "U-human");
  // แอดมินตอบข้อความค้างเอง = เริ่มพักรอบใหม่
  db.insertMessage({ customerId: "U-human", direction: "out", content: "เปิดรอบหน้าวันเสาร์นี้ค่ะ", operator: HUMAN });
  pauseAiForHumanReply(db, "U-human");
  const whilePaused = await app.pauseResume.runOnce();
  assert.equal(whilePaused.checked, 0, "ห้องที่ยังพักอยู่ไม่ใช่งานของตัวกวาด");
  // พักรอบใหม่หมดอายุ — ข้อความล่าสุดคือคำตอบของคน ไม่มีอะไรค้าง
  db.setOperatorActiveUntil("U-human", Date.now() - 1_000);
  const expired = await app.pauseResume.runOnce();
  assert.equal(expired.results[0].skipped, "answered");
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(resumeAudits(db).length, 0);
});

test("ลูกค้าพิมพ์ใหม่ระหว่างที่ตัวกวาดกำลังคิด -> คำตอบเดียวที่ครอบทุกข้อความ", async (t) => {
  let armed = false;
  let raceTurn = null;
  let appRef = null;
  let dbRef = null;
  const RACE_TEXT = "ขอรายละเอียดคลาสเสาร์นี้ด้วยค่ะ";
  const { app, db, hermesFetch, lineFetch } = makeApp(t, {
    onDraft: () => {
      if (!armed) return;
      armed = false;
      dbRef.insertMessage({ customerId: "U-race", direction: "in", content: RACE_TEXT });
      raceTurn = appRef.pipeline.handleInboundText({ customerId: "U-race", text: RACE_TEXT, replyToken: "rt-race" });
    },
  });
  appRef = app;
  dbRef = db;
  await pausedRoom(app, db, "U-race");
  armed = true;
  const result = await app.pauseResume.runOnce();
  assert.ok(raceTurn, "ข้อความใหม่ต้องเข้ามาระหว่างตัวกวาดคิด");
  const raceVerdict = await raceTurn;
  assert.equal(result.results[0].outcome, "suppressed:merged_forward", "ร่างของตัวกวาดต้องถูกยกไปรวมกับก้อนใหม่");
  assert.equal(raceVerdict.sent, true);
  assert.equal(pushes(lineFetch).length, 0, "ตัวกวาดต้องไม่ส่งอะไรออกไปเอง");
  assert.equal(replies(lineFetch).length, 1, "ลูกค้าได้คำตอบเดียว");
  const turn = currentTurn(hermesFetch.drafts.at(-1));
  assert.equal(count(turn, PENDING), 1, "คำตอบเดียวนั้นต้องครอบข้อความที่ค้างระหว่างพัก — ครั้งเดียว ไม่ซ้ำจากก้อนที่ยกมา");
  assert.equal(count(turn, RACE_TEXT), 1);
  const audits = resumeAudits(db).map((row) => row.detail);
  assert.equal(audits.length, 1, "ก้อนที่ยกมามีชุดค้างอยู่แล้ว เทิร์นปกติต้องไม่รวมซ้ำ");
  assert.match(audits[0], /merged_forward/u);
  // รอบถัดไป: ตอบแล้ว ไม่มีอะไรค้าง
  const sends = lineFetch.sends.length;
  await app.pauseResume.runOnce();
  assert.equal(lineFetch.sends.length, sends);
});

test("ลูกค้าพิมพ์ต่อหลังหมดเวลาพัก (ก่อนรอบกวาด) -> เทิร์นปกติรวมข้อความค้างเข้าไป ตอบครั้งเดียว", async (t) => {
  const { app, db, hermesFetch, lineFetch } = makeApp(t);
  await pausedRoom(app, db, "U-after");
  const AFTER_TEXT = "สรุปว่าเปิดรอบไหนบ้างคะ";
  db.insertMessage({ customerId: "U-after", direction: "in", content: AFTER_TEXT });
  const swept = await app.pauseResume.runOnce();
  assert.equal(swept.results[0].skipped, "after_pause", "ลูกค้าพิมพ์ต่อแล้ว = เส้นตอบปกติเป็นเจ้าของ");
  assert.equal(lineFetch.sends.length, 0);
  const verdict = await app.pipeline.handleInboundText({ customerId: "U-after", text: AFTER_TEXT, replyToken: "rt-after" });
  assert.equal(verdict.sent, true);
  // ของเดิม: ประวัติตัดแถวลูกค้าท้ายห้องทิ้งหมด ข้อความระหว่างพักจึงหายจากสายตาโมเดล
  const turn = currentTurn(hermesFetch.drafts.at(-1));
  assert.match(turn, /ลูกค้าส่งมา 2 ข้อความติดกัน/u);
  assert.equal(count(turn, PENDING), 1, "ข้อความค้างระหว่างพักต้องอยู่ในเทิร์นนี้");
  assert.equal(count(turn, AFTER_TEXT), 1);
  assert.match(resumeAudits(db)[0].detail, /1 ข้อความ → รวมเข้าเทิร์นที่ลูกค้าพิมพ์ต่อ/u);
  await app.pauseResume.runOnce();
  assert.equal(replies(lineFetch).length, 1);
  assert.equal(pushes(lineFetch).length, 0, "ตัวกวาดต้องไม่ตอบชุดเดิมซ้ำ");
  // เทิร์นถัดไปไม่รวมซ้ำ (ชุดนั้นถูกตอบแล้ว)
  const NEXT_TEXT = "ขอบคุณค่ะ";
  db.insertMessage({ customerId: "U-after", direction: "in", content: NEXT_TEXT });
  await app.pipeline.handleInboundText({ customerId: "U-after", text: NEXT_TEXT, replyToken: "rt-next" });
  assert.equal(count(currentTurn(hermesFetch.drafts.at(-1)), PENDING), 0);
  assert.equal(resumeAudits(db).length, 1);
});

test("ก้อนที่มาถึงระหว่างพักแต่ถูกประมวลผลหลังหมดเวลา (debounce คร่อมเส้น) -> ไม่ซ้ำข้อความ", async (t) => {
  const { app, db, hermesFetch } = makeApp(t);
  const LATE = "ฮัลโหลค่ะ";
  await pausedRoom(app, db, "U-cross", { pending: [PENDING, LATE] });
  // เทิร์นของ LATE ถูกประมวลผลหลังหมดเวลาพักพอดี — webhook บันทึกแถวไว้ตั้งแต่ระหว่างพัก
  const verdict = await app.pipeline.handleInboundText({ customerId: "U-cross", text: LATE, replyToken: "rt-cross" });
  assert.equal(verdict.sent, true);
  const turn = currentTurn(hermesFetch.drafts.at(-1));
  assert.equal(count(turn, PENDING), 1);
  assert.equal(count(turn, LATE), 1, "แถวของก้อนปัจจุบันห้ามถูกนับเป็นข้อความค้างซ้ำ");
});

test("สวิตช์ปิด = เทิร์นปกติเหมือนเดิมทุกไบต์ (ไม่รวมข้อความค้าง)", async (t) => {
  const { app, db, hermesFetch } = makeApp(t);
  await pausedRoom(app, db, "U-off-switch");
  db.setSetting(PAUSE_RESUME_SETTING, "off");
  const AFTER_TEXT = "สรุปว่าเปิดรอบไหนบ้างคะ";
  db.insertMessage({ customerId: "U-off-switch", direction: "in", content: AFTER_TEXT });
  await app.pipeline.handleInboundText({ customerId: "U-off-switch", text: AFTER_TEXT, replyToken: "rt-off" });
  const turn = currentTurn(hermesFetch.drafts.at(-1));
  assert.equal(turn, AFTER_TEXT, "ปิดสวิตช์แล้วต้องได้เทิร์นแบบเดิมเป๊ะ");
  assert.equal(resumeAudits(db).length, 0);
  assert.deepEqual(heldPausePartsForTurn(db, { customerId: "U-off-switch", incoming: [AFTER_TEXT], logger: silent }), []);
});

test("ห้องที่ไม่เคยพัก -> ตัวอ่านข้อความค้างไม่แตะอะไรเลย และเทิร์นเหมือนเดิม", async (t) => {
  const { app, db, hermesFetch } = makeApp(t);
  const reads = [];
  const spy = { ...db, getSetting: (key) => { reads.push(key); return db.getSetting(key); } };
  db.upsertCustomer("U-plain", {});
  db.insertMessage({ customerId: "U-plain", direction: "in", content: FIRST_TEXT });
  assert.deepEqual(heldPausePartsForTurn(spy, { customerId: "U-plain", incoming: [FIRST_TEXT], logger: silent }), []);
  assert.deepEqual(reads, [], "ห้องที่ไม่มีช่วงพักต้องจบที่แถวลูกค้า ไม่อ่านสวิตช์/ข้อความ");
  await app.pipeline.handleInboundText({ customerId: "U-plain", text: FIRST_TEXT, replyToken: "rt-plain" });
  assert.equal(currentTurn(hermesFetch.drafts.at(-1)), FIRST_TEXT);
});

test("AI ปิดรายห้อง / NEEDS_HUMAN / DND / เส้นเงิน -> ไม่ตอบ", async (t) => {
  const { app, db, hermesFetch, lineFetch } = makeApp(t);
  await pausedRoom(app, db, "U-off");
  db.setAiEnabled("U-off", false, "manual");
  await pausedRoom(app, db, "U-needs");
  db.setNeedsHuman("U-needs", "human_requested", "ลูกค้าขอคุยกับคน");
  await pausedRoom(app, db, "U-dnd");
  db.setDoNotDisturb("U-dnd", true);
  await pausedRoom(app, db, "U-money");
  db.markMoneySeen("U-money");
  const drafts = hermesFetch.drafts.length;
  const result = await app.pauseResume.runOnce();
  const skipped = Object.fromEntries((result.results || []).map((row) => [row.customerId, row.skipped]));
  assert.equal(skipped["U-money"], "money_line");
  assert.equal(result.checked, 1, "AI ปิด / NEEDS_HUMAN / DND ไม่ถูกหยิบมาตรวจเลย");
  const at = Date.now();
  assert.equal(findPauseResume(db, db.getCustomer("U-off"), at).reason, "ai_off");
  assert.equal(findPauseResume(db, db.getCustomer("U-needs"), at).reason, "needs_human");
  assert.equal(findPauseResume(db, db.getCustomer("U-dnd"), at).reason, "dnd");
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(hermesFetch.drafts.length, drafts);
  assert.equal(resumeAudits(db).length, 0);
});

test("AI ถูกสลับปิด-เปิดหลังข้อความค้าง -> ไม่ตอบย้อนหลัง (controlGate กติกาข้อ 3)", async (t) => {
  const { app, db, lineFetch } = makeApp(t);
  await pausedRoom(app, db, "U-toggle");
  db.setAiEnabled("U-toggle", false, "manual");
  db.addAudit({ operator: HUMAN, action: "ai_toggle", target: "U-toggle", detail: "off" });
  db.setAiEnabled("U-toggle", true);
  db.addAudit({ operator: HUMAN, action: "ai_toggle", target: "U-toggle", detail: "on" });
  const result = await app.pauseResume.runOnce();
  assert.equal(result.results[0].skipped, "ai_switched");
  assert.equal(lineFetch.sends.length, 0);
});

test("สวิตช์ pause_resume_answer: ค่าเริ่มต้นเปิด, off ปิดทันที, facebook = เฉพาะห้อง FB, อ่านพัง = ปิด", async (t) => {
  const { app, db, lineFetch } = makeApp(t);
  assert.equal(pauseResumeEnabled(db), true, "ไม่มีแถวใน settings = เปิด");
  await pausedRoom(app, db, "U-switch");
  db.setSetting(PAUSE_RESUME_SETTING, "off");
  assert.deepEqual(await app.pauseResume.runOnce(), { skipped: "disabled" });
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(pauseResumeEnabled({ getSetting: () => { throw new Error("db locked"); } }), false);
  // "facebook" = เฉพาะห้อง Facebook (ห้อง LINE แอดมินอาจตอบต่อใน OA Manager ที่ระบบมองไม่เห็น)
  db.setSetting(PAUSE_RESUME_SETTING, "facebook");
  const lineOnly = await app.pauseResume.runOnce();
  assert.equal(lineOnly.results[0].skipped, "channel_off");
  const fbRoom = { ...db.getCustomer("U-switch"), channel_id: "facebook" };
  assert.equal(findPauseResume(db, fbRoom, Date.now()).ok, true, "ห้อง Facebook ยังได้รับคำตอบ");
  assert.equal(lineFetch.sends.length, 0);
  db.setSetting(PAUSE_RESUME_SETTING, "on");
  const result = await app.pauseResume.runOnce();
  assert.equal(result.results[0].outcome, "sent");
});

test("AI หยุดทั้งระบบ / ระบบกำลังปิด -> ไม่แตะห้องใดเลย", async (t) => {
  const { app, db, hermesFetch, lineFetch } = makeApp(t);
  await pausedRoom(app, db, "U-global");
  const drafts = hermesFetch.drafts.length;
  db.setSetting("ai_paused", "1");
  assert.deepEqual(await app.pauseResume.runOnce(), { skipped: "ai_paused" });
  db.setSetting("ai_paused", "0");
  app.setDraining(true);
  assert.deepEqual(await app.pauseResume.runOnce(), { skipped: "draining" });
  app.setDraining(false);
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(hermesFetch.drafts.length, drafts);
});

test("ยังพักอยู่ / พักหมดนานเกินสองชั่วโมง / ช่วงพักที่ไม่ได้เริ่มจากคนตอบ -> ไม่ตอบ", async (t) => {
  const { app, db, lineFetch } = makeApp(t);
  await pausedRoom(app, db, "U-still", { expire: false });
  assert.equal(findPauseResume(db, db.getCustomer("U-still"), Date.now()).reason, "still_paused");

  await pausedRoom(app, db, "U-old");
  const oldShift = PAUSE_RESUME_LOOKBACK_MS + 60 * 60_000;
  db.raw.prepare("UPDATE messages SET created_at = created_at - ? WHERE customer_id = ?").run(oldShift, "U-old");
  db.setOperatorActiveUntil("U-old", Date.now() - SHIFT_MS - oldShift + OPERATOR_PAUSE_MS);
  assert.equal(findPauseResume(db, db.getCustomer("U-old"), Date.now()).reason, "pause_too_old");

  // พักจากเหตุอื่น (escalation / สงสัยตอบนอกระบบ): ข้อความล่าสุดฝั่งเราเป็นของ AI ไม่ใช่คน
  db.upsertCustomer("U-system", {});
  db.insertMessage({ customerId: "U-system", direction: "in", content: FIRST_TEXT });
  db.insertMessage({ customerId: "U-system", direction: "out", content: REPLY, agentMode: "ai" });
  db.insertMessage({ customerId: "U-system", direction: "in", content: PENDING });
  db.raw.prepare("UPDATE messages SET created_at = created_at - ? WHERE customer_id = ?").run(SHIFT_MS, "U-system");
  db.setOperatorActiveUntil("U-system", Date.now() - 60_000);

  const result = await app.pauseResume.runOnce();
  const skipped = Object.fromEntries(result.results.map((row) => [row.customerId, row.skipped]));
  assert.equal(skipped["U-system"], "last_reply_not_human");
  assert.equal(skipped["U-still"], undefined, "ห้องที่ยังพักไม่ถูกหยิบ");
  assert.equal(skipped["U-old"], undefined, "ห้องเก่าเกินหน้าต่างไม่ถูกหยิบ");
  assert.equal(lineFetch.sends.length, 0);
});

test("ข้อความค้างเป็นคีย์เวิร์ดกิจกรรม หรือไม่ใช่ข้อความ (สติกเกอร์/รูป) -> ไม่ตอบ", async (t) => {
  const { app, db, lineFetch } = makeApp(t);
  await pausedRoom(app, db, "U-tag", { pending: ["#horeca"], msgType: "text" });
  await pausedRoom(app, db, "U-sticker", { pending: ["[sticker]"], msgType: "sticker" });
  const result = await app.pauseResume.runOnce();
  const skipped = Object.fromEntries(result.results.map((row) => [row.customerId, row.skipped]));
  assert.equal(skipped["U-tag"], "campaign_keyword");
  assert.equal(skipped["U-sticker"], "no_text");
  assert.equal(lineFetch.sends.length, 0);
});

test("ส่งไปแล้วแต่บันทึกหาย (โปรเซสตายกลางทาง) -> รั้วใน proactive_attempts กันส่งซ้ำหลังรีสตาร์ต", async (t) => {
  const { app, db, lineFetch } = makeApp(t);
  await pausedRoom(app, db, "U-fence");
  const first = await app.pauseResume.runOnce();
  assert.equal(first.results[0].outcome, "sent");
  const sends = lineFetch.sends.length;
  // จำลองบันทึกขาออกหาย: ข้อความล่าสุดกลับเป็นของลูกค้าเหมือนยังไม่มีใครตอบ
  db.raw.prepare("DELETE FROM messages WHERE customer_id = ? AND direction = 'out' AND operator = ''").run("U-fence");
  assert.equal(findPauseResume(db, db.getCustomer("U-fence"), Date.now()).ok, true);
  const again = await app.pauseResume.runOnce();
  assert.equal(again.results[0].skipped, "delivery_fenced");
  assert.equal(lineFetch.sends.length, sends);
  const attempt = db.getProactiveAttempt("U-fence", PAUSE_RESUME_LANE);
  assert.equal(attempt.status, "settled");
});

test("Facebook: หน้าต่าง 24 ชม. ปิด = ไม่ตอบ (ส่งไม่ได้ตามกติกา Meta)", async (t) => {
  const { app, db } = makeApp(t);
  await pausedRoom(app, db, "U-fb");
  const customer = { ...db.getCustomer("U-fb"), channel_id: "facebook" };
  const closed = { ...db, withinFacebookWindow: () => false };
  assert.equal(findPauseResume(closed, customer, Date.now()).reason, "fb_window_closed");
  const open = { ...db, withinFacebookWindow: () => true };
  assert.equal(findPauseResume(open, customer, Date.now()).ok, true);
});

test("ต่อสายเข้าเซิร์ฟเวอร์: มีตัวกวาดพร้อม start/stop และไม่เดินเองตอนสร้าง app", async (t) => {
  const { app } = makeApp(t);
  assert.equal(app.pauseResume.running, false, "createApp ห้าม arm timer เอง (main เป็นคน start)");
  assert.equal(app.pauseResume.start(), true);
  assert.equal(app.pauseResume.running, true);
  assert.equal(app.pauseResume.start(), false, "start ซ้ำต้องไม่ซ้อน timer");
  app.pauseResume.stop();
  assert.equal(app.pauseResume.running, false);
  const server = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
  const shutdown = readFileSync(new URL("../src/shutdown.mjs", import.meta.url), "utf8");
  assert.match(server, /app\.pauseResume\.start\(\)/u);
  assert.match(shutdown, /app\.pauseResume\?\.stop\(\)/u);
});

test("กฎเหล็ก inbound_turn_outcomes: ตัวกวาดและตัวอ่านข้อความค้างห้ามอ่านบัญชีเทิร์นแล้วเรียกไปป์ไลน์", () => {
  const codeOf = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  for (const file of ["pauseResume.mjs", "pauseHeld.mjs"]) {
    const code = codeOf(file);
    assert.doesNotMatch(code, /inbound_turn_outcomes|InboundTurn/u, file);
    assert.doesNotMatch(code, /sendBubbles|pushMessage/u, `${file} ต้องไม่ส่งข้อความเอง`);
  }
  assert.match(codeOf("pauseResume.mjs"), /pipeline\.respondToBurst/u, "ตัวกวาดต้องตอบผ่านไปป์ไลน์ปกติ");
});
