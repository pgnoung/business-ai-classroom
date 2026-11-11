// qualify-pipeline — ห้องสีเหลือง "AI off (not qualify)" ที่ประตู AI ของไปป์ไลน์ (คำสั่งพี่ง้วง 5 ต.ค. 2026)
//
// พี่ง้วง: "ถ้าเมื่อไหร่ sense ได้ว่าแชทนั้น ๆ มีศักยภาพขึ้นมา ... ให้กลับมาเปิดสีเขียวเหมือนเดิม
//          — ระบบนี้ reverse ไปมาระหว่างการปิดจากสีเหลืองและไปสีเขียวเท่านั้น ไม่นับการปิดกรณีอื่น ๆ"
//   · สัญญาณซื้อ (ถามราคา/จะสมัคร/แจ้งโอน/ขอจอง) = เปิดเขียวทันทีแล้วตอบในเทิร์นเดียวกัน
//   · ร้องเรียน/ขอคุยกับคน/ขอหยุด = เปิดให้เส้นปลอดภัยเดินครบ (แม่แบบ + ธง + ปิดด้วยเหตุของคน)
//   · คุยเล่น = ยังเหลือง เงียบ ไม่เรียกโมเดล + ปักกุญแจให้ตัวกวาดตรวจซ้ำ
//   · ห้องที่ปิดด้วยเหตุอื่นไม่ถูกแตะเลย
//   · รูปเส้นเงินในห้องเหลือง = ห้องเงินของคน (money_line + ธงเงิน)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  AUDIT_AI_ON_QUALIFIED, NOT_QUALIFIED_REASON, QUALIFY_AUDIT_OPERATOR, qualifyHumanOnKey, qualifyRecheckKey,
  qualifyReleaseKey, qualifyStateKey,
} from "../src/notQualified.mjs";
import { QUALIFY_ANSWER_SKIPPED_FIELD, YELLOW_HELD_AUDIT_ACTION } from "../src/qualifyFastReclaim.mjs";
import { createQualifyAnswerPending } from "../src/qualifyAnswerPending.mjs";
import { setCustomerAiSwitch } from "../src/aiSwitch.mjs";
import { listWaitingRooms } from "../src/waitingRooms.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig, waitFor } from "./helpers.mjs";
import { REVIEW_RECLAIM_PHRASES, STAY_YELLOW_PHRASES } from "./fixtures/qualify-reclaim-phrases.mjs";
import { QUALIFY_SWEEP_MODE_KEY } from "../src/notQualified.mjs";
import { planNotQualifiedRelease } from "../tools/release-not-qualified.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

function makeApp({ imageClassify = null, reply = "ยินดีค่ะ เดี๋ยวลูกแพรเล่ารายละเอียดให้นะคะ" } = {}) {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermesFetch = hermesFetchStub(reply);
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {}, ...(imageClassify ? { imageClassify } : {}) },
    logger: silent,
  });
  return { app, db, hermesFetch, lineFetch };
}

// ห้องที่ตัวกวาดปิดเหลืองไว้ + ประวัติสั้น ๆ · ข้อความใหม่ถูกเขียนลง DB ก่อนเหมือน webhook จริง
function seedYellow(db, id) {
  db.upsertCustomer(id, { displayName: "ลูกค้าทดสอบ" });
  db.insertMessage({ customerId: id, direction: "in", content: "อยากหารายได้เสริมค่ะ" });
  db.insertMessage({ customerId: id, direction: "out", content: "ยินดีค่ะ", agentMode: "ai" });
  db.setAiEnabled(id, false, NOT_QUALIFIED_REASON);
  db.setSetting(qualifyStateKey(id), JSON.stringify({ verdict: "not_qualified", confidence: 0.9, category: "income_seeker_no_budget", reason: "x", lastInboundId: "old", at: 1, mode: "on", offAt: 1 }));
}
function inbound(db, id, text) {
  return db.insertMessage({ customerId: id, direction: "in", content: text });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
const reclaimAudits = (db, id) => db.listAudit().filter((row) => row.action === AUDIT_AI_ON_QUALIFIED && row.target === id);

test("ห้องเหลือง + ถามราคา = เปิดเขียวทันทีแล้วลูกแพรตอบในเทิร์นเดียวกัน · audit fast:money_ask · จดสถานะกันตัดสินซ้ำ", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  seedYellow(db, "U-y-price");
  const message = inbound(db, "U-y-price", "ราคาเท่าไหร่คะ");
  const sends = lineFetch.sends.length;
  const result = await app.pipeline.handleInboundText({ customerId: "U-y-price", text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.ok(lineFetch.sends.length > sends, "ลูกค้าได้คำตอบ");
  assert.ok(hermesFetch.calls.length >= 1, "เส้นตอบปกติ = ลูกแพรคิดคำตอบเอง");
  const room = db.getCustomer("U-y-price");
  assert.equal(room.ai_enabled, 1);
  assert.equal(room.ai_off_reason, "");
  const audits = reclaimAudits(db, "U-y-price");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operator, QUALIFY_AUDIT_OPERATOR);
  assert.equal(audits[0].detail, "fast:money_ask");
  const state = JSON.parse(db.getSetting(qualifyStateKey("U-y-price")));
  assert.equal(state.verdict, "potential");
  assert.equal(state.category, "buying_intent");
  assert.ok(state.confidence > 0.5 && state.confidence < 1, `รีวิวปรปักษ์รอบ 2: ทางลัดไม่ได้ถามโมเดล ห้ามจดมั่นใจ 1.0 (${state.confidence})`);
  assert.equal(state.mode, "fast");
  assert.equal(state.lastInboundId, String(message.id ?? message), "ตัวกวาดไม่จ่ายซ้ำกับข้อความเดิม");
  assert.equal(db.getSetting(qualifyRecheckKey("U-y-price")), null);
  db.close();
});

test("ห้องเหลือง + ร้องเรียน = เส้นปลอดภัยเดินครบ (แม่แบบขออภัย + ธง + ปิดด้วยเหตุ complaint) ไม่กลับไปเหลือง", async () => {
  const { app, db } = makeApp();
  seedYellow(db, "U-y-comp");
  inbound(db, "U-y-comp", "ไม่พอใจมากเลยค่ะ บริการแย่มาก");
  const result = await app.pipeline.handleInboundText({ customerId: "U-y-comp", text: "ไม่พอใจมากเลยค่ะ บริการแย่มาก", replyToken: "rt" });
  assert.equal(result.sent, true, "แม่แบบขออภัยต้องถึงลูกค้า");
  const room = db.getCustomer("U-y-comp");
  assert.equal(room.ai_enabled, 0);
  assert.equal(room.ai_off_reason, "complaint", "ห้องของคนแล้ว ตัวกวาดแตะไม่ได้อีก");
  assert.equal(room.state, "NEEDS_HUMAN");
  assert.equal(reclaimAudits(db, "U-y-comp")[0]?.detail, "fast:safety");
  assert.ok(db.listAudit().some((row) => row.action === "ai_off_complaint" && row.target === "U-y-comp"));
  db.close();
});

test("ห้องเหลือง + ขอคุยกับคนจริง / ขอให้หยุดทัก = ส่งต่อ/ตอบรับตามเส้นเดิม แล้วปิดด้วยเหตุของคน", async () => {
  const { app, db } = makeApp();
  seedYellow(db, "U-y-human");
  inbound(db, "U-y-human", "ขอคุยกับคนจริงค่ะ");
  const human = await app.pipeline.handleInboundText({ customerId: "U-y-human", text: "ขอคุยกับคนจริงค่ะ", replyToken: "rt" });
  assert.equal(human.route, "human_handoff");
  assert.equal(human.sent, true);
  assert.equal(db.getCustomer("U-y-human").ai_off_reason, "human_requested");

  seedYellow(db, "U-y-opt");
  inbound(db, "U-y-opt", "ไม่ต้องทักมาอีกนะคะ รำคาญแล้ว");
  const opt = await app.pipeline.handleInboundText({ customerId: "U-y-opt", text: "ไม่ต้องทักมาอีกนะคะ รำคาญแล้ว", replyToken: "rt" });
  assert.equal(opt.sent, true, "ต้องตอบรับคำขอ ไม่เงียบใส่คนที่หงุดหงิด");
  const room = db.getCustomer("U-y-opt");
  assert.equal(room.do_not_disturb, 1);
  assert.equal(room.ai_off_reason, "optout");
  db.close();
});

test("ห้องเหลือง + คุยเล่น = ยังเหลือง เงียบ ไม่เรียกโมเดล ไม่ส่ง · ปักกุญแจตรวจซ้ำ (ค่าใหม่ทุกข้อความ)", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  seedYellow(db, "U-y-chat");
  const first = inbound(db, "U-y-chat", "ขอบคุณค่ะ 555");
  const calls = hermesFetch.calls.length;
  const sends = lineFetch.sends.length;
  const result = await app.pipeline.handleInboundText({ customerId: "U-y-chat", text: "ขอบคุณค่ะ 555", replyToken: "rt" });
  assert.equal(result.suppressed, "ai_disabled");
  assert.equal(hermesFetch.calls.length, calls);
  assert.equal(lineFetch.sends.length, sends);
  const room = db.getCustomer("U-y-chat");
  assert.equal(room.ai_enabled, 0);
  assert.equal(room.ai_off_reason, NOT_QUALIFIED_REASON);
  assert.equal(reclaimAudits(db, "U-y-chat").length, 0);
  const marker = db.getSetting(qualifyRecheckKey("U-y-chat"));
  assert.match(marker, /^\d+:/u);
  assert.ok(marker.endsWith(String(first.id ?? first)), marker);
  inbound(db, "U-y-chat", "อยากได้งานทำค่ะ");
  await app.pipeline.handleInboundText({ customerId: "U-y-chat", text: "อยากได้งานทำค่ะ", replyToken: "rt2" });
  assert.notEqual(db.getSetting(qualifyRecheckKey("U-y-chat")), marker, "ข้อความใหม่ = ค่าใหม่ (ตัวกวาดลบเฉพาะค่าที่ตัวเองอ่าน)");
  assert.equal(db.getCustomer("U-y-chat").ai_off_reason, NOT_QUALIFIED_REASON);
  db.close();
});

test("ห้องปิดด้วยเหตุอื่น (คน/เงิน/ส่งต่อ) ไม่ถูกแตะ: ถามราคาก็ยังเงียบ ไม่มีกุญแจ ไม่มี audit ของตัวกวาด", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  for (const reason of ["manual", "money_line", "booking_handoff", "customer_handover", "not_a_customer"]) {
    const id = `U-off-${reason}`;
    db.upsertCustomer(id, {});
    db.setAiEnabled(id, false, reason);
    inbound(db, id, "ราคาเท่าไหร่คะ");
    const calls = hermesFetch.calls.length;
    const sends = lineFetch.sends.length;
    const result = await app.pipeline.handleInboundText({ customerId: id, text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
    assert.equal(result.suppressed, "ai_disabled", reason);
    assert.equal(db.getCustomer(id).ai_off_reason, reason, reason);
    assert.equal(db.getSetting(qualifyRecheckKey(id)), null, reason);
    assert.equal(db.getSetting(qualifyStateKey(id)), null, reason);
    assert.equal(reclaimAudits(db, id).length, 0, reason);
    assert.equal(hermesFetch.calls.length, calls, reason);
    assert.equal(lineFetch.sends.length, sends, reason);
  }
  // ห้อง AI เปิดปกติ: ไม่มีกุญแจ/สถานะของตัวกวาดเกิดขึ้นจากการตอบ
  db.upsertCustomer("U-on", {});
  inbound(db, "U-on", "ขอบคุณค่ะ");
  await app.pipeline.handleInboundText({ customerId: "U-on", text: "ขอบคุณค่ะ", replyToken: "rt" });
  assert.equal(db.getSetting(qualifyRecheckKey("U-on")), null);
  assert.equal(db.getSetting(qualifyStateKey("U-on")), null);
  db.close();
});

test("ห้องเหลืองถูกติดป้าย customer จากเส้นอื่น = ด่านป้ายในไปป์ไลน์ทับเป็น customer_handover (ไม่เปิดเขียวแม้ถามราคา)", async () => {
  const { app, db, lineFetch } = makeApp();
  seedYellow(db, "U-y-tag");
  db.addTag("U-y-tag", "customer", "human");
  inbound(db, "U-y-tag", "ราคาเท่าไหร่คะ");
  const sends = lineFetch.sends.length;
  const result = await app.pipeline.handleInboundText({ customerId: "U-y-tag", text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.suppressed, "ai_disabled");
  assert.equal(db.getCustomer("U-y-tag").ai_off_reason, "customer_handover");
  assert.equal(lineFetch.sends.length, sends);
  assert.equal(reclaimAudits(db, "U-y-tag").length, 0);
  db.close();
});

const imageEvent = (userId, id) => ({ type: "message", replyToken: "rt", source: { userId }, message: { type: "image", id } });

test("รูปสลิปในห้องเหลือง = สลับเป็น money_line + ธงเงิน + audit (ห้องเงินของคน ตัวกวาดแตะไม่ได้อีก)", async () => {
  const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => ({ kind: "slip", description: "สลิปโอนเงิน" }) } });
  seedYellow(db, "U-y-slip");
  db.insertMessage({ id: "in:slip-1", customerId: "U-y-slip", direction: "in", msgType: "image", content: "[image] id=slip-1" });
  await app.pipeline.handleEvent(imageEvent("U-y-slip", "slip-1"));
  const room = db.getCustomer("U-y-slip");
  assert.equal(room.ai_enabled, 0);
  assert.equal(room.ai_off_reason, "money_line");
  assert.ok(Number(room.money_seen_at) > 0, "ธงเงินถาวร");
  assert.equal(room.state, "NEEDS_HUMAN");
  const audit = db.listAudit().find((row) => row.action === "ai_off_payment_image" && row.target === "U-y-slip");
  assert.match(audit?.detail || "", /not_qualified/u);
  db.close();
});

test("รูปที่จำแนกได้ว่าไม่ใช่เรื่องเงินในห้องเหลือง = ห้องยังเหลือง (ไม่ปักธงเงิน)", async () => {
  const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => ({ kind: "other", description: "ภาพวิว" }) } });
  seedYellow(db, "U-y-photo");
  db.insertMessage({ id: "in:photo-1", customerId: "U-y-photo", direction: "in", msgType: "image", content: "[image] id=photo-1" });
  await app.pipeline.handleEvent(imageEvent("U-y-photo", "photo-1"));
  const room = db.getCustomer("U-y-photo");
  assert.equal(room.ai_off_reason, NOT_QUALIFIED_REASON);
  assert.equal(Number(room.money_seen_at || 0), 0);
  db.close();
});

/* ------------------------- รีวิวปรปักษ์ 5 ต.ค. — ไปป์ไลน์จริงของห้องสีเหลือง ------------------------- */

// #3/#7: ทุกวลีจากรีวิว (ขอเลขบัญชี/บัตร/จะโอน · ทีม/in-house · ถามรอบ/รายละเอียด · ทวงคำตอบ/กล่าวหา) เปิดเขียวในเทิร์นเดียวกัน
test("#3/#7: ทุกวลีจากรีวิวในห้องเหลือง = เปิดเขียวทันที (audit fast:*) ไม่ตกไปรอโมเดล · คำหางาน/หารายได้ = ยังเหลือง เงียบ", async () => {
  const { app, db, lineFetch } = makeApp();
  for (const [index, text] of REVIEW_RECLAIM_PHRASES.entries()) {
    const id = `U-r-${index}`;
    seedYellow(db, id);
    inbound(db, id, text);
    await app.pipeline.handleInboundText({ customerId: id, text, replyToken: `rt-${index}` });
    const room = db.getCustomer(id);
    assert.notEqual(room.ai_off_reason, NOT_QUALIFIED_REASON, text);
    const audits = reclaimAudits(db, id);
    assert.equal(audits.length, 1, text);
    assert.match(audits[0].detail, /^fast:[a-z_]+$/u, text);
    assert.equal(db.getSetting(qualifyRecheckKey(id)), null, `${text} — ไม่ต้องรอตัวกวาดตรวจซ้ำ`);
  }
  const sends = lineFetch.sends.length;
  for (const [index, text] of STAY_YELLOW_PHRASES.entries()) {
    const id = `U-s-${index}`;
    seedYellow(db, id);
    inbound(db, id, text);
    const result = await app.pipeline.handleInboundText({ customerId: id, text, replyToken: `rt-s-${index}` });
    assert.equal(result.suppressed, "ai_disabled", text);
    assert.equal(db.getCustomer(id).ai_off_reason, NOT_QUALIFIED_REASON, text);
    assert.ok(db.getSetting(qualifyRecheckKey(id)), `${text} — ตัวกวาดตรวจซ้ำ`);
  }
  assert.equal(lineFetch.sends.length, sends, "ห้องที่ยังเหลืองไม่ได้รับข้อความใด");
  db.close();
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ด่าน "ห้ามเปิดทับห้อง NEEDS_HUMAN" ของรอบแรกทำให้ห้องเหลืองเข้มกว่าห้องเขียว — ลีดที่ส่งรูปแล้วถามราคา
// ห้องเขียวตอบ (AI ยังเปิดใน NEEDS_HUMAN) แต่ห้องเหลืองเงียบ และตัวกวาดเปิดให้ไม่ได้ · ตอนนี้ต้องตอบเหมือนห้องเขียว
test("รอบ 2 (#1/#19): ห้องเหลืองที่รอคน (NEEDS_HUMAN, ยัง not_qualified) + ถามราคา = เปิดเขียวแล้วตอบเหมือนห้องเขียว · ร้องเรียน = เส้นปลอดภัยเดินครบ", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  // ห้องเขียวควบคุม: รูปรอตรวจแล้วถามราคา = AI ตอบ
  db.upsertCustomer("U-nh-green", { displayName: "ลูกค้าทดสอบ" });
  db.setNeedsHuman("U-nh-green", "image_review", "ลูกค้าส่งรูป — รอคนตรวจ");
  inbound(db, "U-nh-green", "ราคาเท่าไหร่คะ");
  const greenSends = lineFetch.sends.length;
  await app.pipeline.handleInboundText({ customerId: "U-nh-green", text: "ราคาเท่าไหร่คะ", replyToken: "rt-g" });
  const greenReplies = lineFetch.sends.length - greenSends;
  assert.equal(greenReplies, 1, "ห้องเขียว NEEDS_HUMAN ยังตอบ (ฐานเปรียบเทียบ)");

  seedYellow(db, "U-nh-buy");
  db.setNeedsHuman("U-nh-buy", "image_review", "ลูกค้าส่งรูป — รอคนตรวจ");
  inbound(db, "U-nh-buy", "ราคาเท่าไหร่คะ");
  const calls = hermesFetch.calls.length;
  const sends = lineFetch.sends.length;
  const result = await app.pipeline.handleInboundText({ customerId: "U-nh-buy", text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.ok(hermesFetch.calls.length > calls, "ลูกแพรคิดคำตอบ");
  assert.equal(lineFetch.sends.length - sends, greenReplies, "จำนวนคำตอบเท่าห้องเขียว");
  const room = db.getCustomer("U-nh-buy");
  assert.equal(room.ai_enabled, 1);
  assert.equal(room.ai_off_reason, "");
  assert.equal(reclaimAudits(db, "U-nh-buy")[0]?.detail, "fast:money_ask");

  seedYellow(db, "U-nh-comp");
  db.setNeedsHuman("U-nh-comp", "file_review", "ลูกค้าส่งไฟล์แนบ");
  inbound(db, "U-nh-comp", "ไม่พอใจมากเลยค่ะ บริการแย่มาก");
  const complaint = await app.pipeline.handleInboundText({ customerId: "U-nh-comp", text: "ไม่พอใจมากเลยค่ะ บริการแย่มาก", replyToken: "rt-c" });
  assert.equal(complaint.sent, true, "คำร้องเรียนไม่ถูกกลืนแม้ห้องรอคน");
  assert.equal(db.getCustomer("U-nh-comp").ai_off_reason, "complaint");
  db.close();
});

const fileEvent = (userId, id = "f-1") => ({ type: "message", replyToken: "rt-file", source: { userId }, message: { type: "file", id, fileName: "work.pdf" } });

// #2/#19: ห้องเหลืองของทีม (มีคนตอบมาก่อน) + ไฟล์ = file_review (เหตุของคน) เหมือนห้องเขียว — เดิมค้าง not_qualified
test("#2/#19: ห้องเหลืองที่ทีมเคยตอบ + ไฟล์ = ปิดเป็น file_review + push · ถามราคาต่อ = เงียบ · ขึ้นคิวรอตอบ (เดิมหลุดคิวแล้ว AI ตอบทับ)", async () => {
  const notices = [];
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermesFetch = hermesFetchStub("ยินดีค่ะ");
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(), db, logger: silent,
    overrides: { hermesFetch, lineFetch, sleep: async () => {}, notifier: { fireLater: (n) => notices.push(n), notify: async () => ({ ok: true }) } },
  });
  seedYellow(db, "U-y-file");
  db.insertMessage({ customerId: "U-y-file", direction: "out", content: "ทีมขอเอกสารหน่อยนะคะ", operator: "staff1" });
  await tick();
  db.insertMessage({ id: "in:file-1", customerId: "U-y-file", direction: "in", msgType: "file", content: "[file] work.pdf" });
  const result = await app.pipeline.handleEvent(fileEvent("U-y-file"));
  assert.equal(result.suppressed, "file_review");
  let room = db.getCustomer("U-y-file");
  assert.equal(room.ai_enabled, 0);
  assert.equal(room.ai_off_reason, "file_review", "ห้องของคนแล้ว ตัวกวาดแตะไม่ได้อีก");
  assert.equal(room.state, "NEEDS_HUMAN");
  assert.ok(notices.some((n) => n.reason === "file_review" && n.customerId === "U-y-file"), "ทีมได้ push");
  inbound(db, "U-y-file", "ราคาเท่าไหร่คะ");
  const calls = hermesFetch.calls.length;
  const follow = await app.pipeline.handleInboundText({ customerId: "U-y-file", text: "ราคาเท่าไหร่คะ", replyToken: "rt-2" });
  assert.equal(follow.suppressed, "ai_disabled");
  assert.equal(hermesFetch.calls.length, calls, "AI ไม่ตอบทับห้องที่รอทีมตรวจไฟล์");
  room = db.getCustomer("U-y-file");
  assert.equal(room.ai_off_reason, "file_review");
  assert.equal(reclaimAudits(db, "U-y-file").length, 0);
  assert.ok(listWaitingRooms({ db, now: Date.now() + 10 * 60_000 }).rooms.some((r) => r.id === "U-y-file"), "ขึ้นคิวรอตอบ");

  // ห้องเหลืองที่ไม่มีคนตอบมาก่อน + ไฟล์ = ยังเหลืองแต่รอคน → ขึ้นคิวรอตอบ (#20)
  // รีวิวปรปักษ์รอบ 2 5 ต.ค.: แล้วลูกค้าถามราคา = ตอบเหมือนห้องเขียว (ห้องเขียวลีดที่ส่งไฟล์ AI ยังเปิดอยู่) — เดิมเงียบใส่ลีด
  seedYellow(db, "U-y-file-lead");
  await tick();
  db.insertMessage({ id: "in:file-2", customerId: "U-y-file-lead", direction: "in", msgType: "file", content: "[file] work.pdf" });
  await app.pipeline.handleEvent(fileEvent("U-y-file-lead", "f-2"));
  room = db.getCustomer("U-y-file-lead");
  assert.equal(room.state, "NEEDS_HUMAN");
  assert.equal(room.ai_off_reason, NOT_QUALIFIED_REASON, "ลีดส่งไฟล์ ไม่ใช่ห้องที่ทีมคุยอยู่ = ยังไม่เปลี่ยนเหตุ (ห้องเขียวก็ไม่ปิด AI)");
  assert.ok(listWaitingRooms({ db, now: Date.now() + 10 * 60_000 }).rooms.some((r) => r.id === "U-y-file-lead"));
  inbound(db, "U-y-file-lead", "ราคาเท่าไหร่คะ");
  const leadSends = lineFetch.sends.length;
  const lead = await app.pipeline.handleInboundText({ customerId: "U-y-file-lead", text: "ราคาเท่าไหร่คะ", replyToken: "rt-3" });
  assert.equal(lead.sent, true, JSON.stringify(lead));
  assert.equal(lineFetch.sends.length - leadSends, 1);
  assert.equal(db.getCustomer("U-y-file-lead").ai_enabled, 1);
  db.close();
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค. (repro rv-1-2-19): ลีด (ไม่เคยมีคนตอบ) ส่งไฟล์ / รูปที่โหลดไม่ได้ / เสียงที่ถอดไม่ออก แล้วพิมพ์ข้อความซื้อหรือทวง
// ห้องเหลืองต้องได้คำตอบเท่าห้องเขียวทุกชุด (เดิมห้องเขียวตอบ 1 แต่ห้องเหลืองเงียบ 0 ทั้ง 12 ชุด)
test("รอบ 2 (rv-1-2-19): ลีดห้องเหลือง + ไฟล์/รูป no_file/เสียงถอดไม่ได้ แล้วถามราคา/สมัคร/ขอเลขบัญชี/ทวง = ตอบเท่าห้องเขียวทุกชุด", async () => {
  const run = async ({ yellow, media, text }) => {
    const db = memoryDb();
    db.setApprovedPrice("ราคา-2500", 2500);
    const hermesFetch = hermesFetchStub("ได้เลยค่ะ คอร์สนี้ราคา 2,500 บาทค่ะ");
    const lineFetch = lineFetchStub();
    const app = createApp({
      config: testConfig(), db, logger: silent,
      overrides: {
        hermesFetch, lineFetch, sleep: async () => {}, notifier: { fireLater() {}, notify: async () => ({ ok: true }) },
        imageClassify: { enabled: true, classify: async () => ({ kind: "unknown", reasonCode: "no_file", reason: "no file" }) },
        transcriber: { transcribe: async () => ({ ok: false, reason: "transcriber_error" }) },
      },
    });
    const id = `U-${yellow ? "y" : "g"}-${media}`;
    db.upsertCustomer(id, { displayName: "ลูกค้าทดสอบ" });
    db.insertMessage({ customerId: id, direction: "in", content: "อยากหารายได้เสริมค่ะ" });
    db.insertMessage({ customerId: id, direction: "out", content: "ยินดีค่ะ", agentMode: "ai" });
    if (yellow) {
      db.setAiEnabled(id, false, NOT_QUALIFIED_REASON);
      db.setSetting(qualifyStateKey(id), JSON.stringify({ verdict: "not_qualified", confidence: 0.9, lastInboundId: "x", at: 1, mode: "on", offAt: 1 }));
    }
    await tick();
    const mid = `m-${media}`;
    const type = { file: "file", image: "image", audio: "audio" }[media];
    db.insertMessage({ id: `in:${mid}`, customerId: id, direction: "in", msgType: type, content: media === "file" ? "[file] resume.pdf" : `[${type}] id=${mid}` });
    await app.pipeline.handleEvent({ type: "message", replyToken: "rt-m", source: { userId: id }, message: { type, id: mid, ...(media === "file" ? { fileName: "resume.pdf" } : {}) } });
    await tick();
    inbound(db, id, text);
    const sends = lineFetch.sends.length;
    await app.pipeline.handleInboundText({ customerId: id, text, replyToken: "rt-2" });
    const replies = lineFetch.sends.length - sends;
    db.close();
    return replies;
  };
  for (const media of ["file", "image", "audio"]) {
    for (const text of ["ราคาคอร์สเท่าไหร่คะ", "สนใจสมัครค่ะ", "ขอเลขบัญชีค่ะ จะโอนวันนี้", "ทำไมไม่ตอบคะ"]) {
      const green = await run({ yellow: false, media, text });
      const yellowReplies = await run({ yellow: true, media, text });
      assert.equal(green, 1, `ฐานเขียว ${media} · ${text}`);
      assert.equal(yellowReplies, green, `ห้องเหลืองต้องตอบเท่าห้องเขียว: ${media} · ${text}`);
    }
  }
});

// #9: เปิดเขียวแล้วโมเดลต้องเห็นข้อความที่ลูกค้าพิมพ์ระหว่างเหลือง (เดิมเห็นแค่ข้อความล่าสุด → ตอบผิดบริบท)
const HELD = Object.freeze(["ตอนนี้มีร้านกาแฟสองสาขาค่ะ", "ลูกค้าเยอะจนตอบแชทไม่ทันเลยค่ะ"]);
const draftUserText = (calls, needle) => {
  const call = calls.find((c) => (c.body.messages || []).at(-1)?.role === "user" && String(c.body.messages.at(-1).content).includes(needle));
  return call ? { user: String(call.body.messages.at(-1).content), body: JSON.stringify(call.body) } : null;
};
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

async function yellowWithHeld(app, db, id) {
  seedYellow(db, id);
  await tick(); // คิวรอตอบเทียบ "คำตอบล่าสุด < ข้อความลูกค้าล่าสุด" ระดับมิลลิวินาที — ข้อความค้างต้องอยู่หลังคำตอบเดิมจริง
  for (const text of HELD) {
    inbound(db, id, text);
    const held = await app.pipeline.handleInboundText({ customerId: id, text, replyToken: "rt-h" });
    assert.equal(held.suppressed, "ai_disabled", `${text} ต้องถูกกลืนระหว่างเหลือง (ไม่มีสัญญาณ)`);
  }
}

test("#9 ทางลัด: ห้องเหลืองมีข้อความค้าง 2 ข้อความ แล้วถามราคา = โมเดลเห็นครบ 3 ข้อความ (ครั้งเดียว) + audit นับจำนวน", async () => {
  const { app, db, hermesFetch } = makeApp();
  await yellowWithHeld(app, db, "U-held");
  inbound(db, "U-held", "ราคาเท่าไหร่คะ");
  const result = await app.pipeline.handleInboundText({ customerId: "U-held", text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  const draft = draftUserText(hermesFetch.calls, "ราคาเท่าไหร่คะ");
  assert.ok(draft, "มีคำขอร่างคำตอบ");
  for (const text of [...HELD, "ราคาเท่าไหร่คะ"]) assert.equal(occurrences(draft.body, text), 1, `${text} ต้องอยู่ในคำขอครั้งเดียว`);
  assert.match(draft.user, /3 ข้อความ/u);
  assert.ok(draft.user.indexOf(HELD[0]) < draft.user.indexOf("ราคาเท่าไหร่คะ"), "เรียงเก่า → ใหม่");
  const audit = db.listAudit().find((row) => row.action === YELLOW_HELD_AUDIT_ACTION && row.target === "U-held");
  assert.match(audit?.detail || "", /2 ข้อความ/u);
  assert.doesNotMatch(audit.detail, /ร้านกาแฟ/u, "audit ไม่มีเนื้อความลูกค้า");
  // ห้องเหลืองที่ไม่มีข้อความค้าง = เทิร์นเดิมทุกไบต์ (ข้อความเดียว ไม่มี audit)
  seedYellow(db, "U-noheld");
  inbound(db, "U-noheld", "ราคาเท่าไหร่คะ");
  await app.pipeline.handleInboundText({ customerId: "U-noheld", text: "ราคาเท่าไหร่คะ", replyToken: "rt-n" });
  assert.equal(db.listAudit().filter((row) => row.action === YELLOW_HELD_AUDIT_ACTION && row.target === "U-noheld").length, 0);
  db.close();
});

test("#9 ตัวกวาดเปิดเขียว: answerPending ส่งข้อความล่าสุด + ข้อความค้างระหว่างเหลืองเข้าไปป์ไลน์จริง โมเดลเห็นครบ", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  await yellowWithHeld(app, db, "U-sweep");
  // ตัวกวาดเปิดเขียว (CAS เดียวกับ CAS_ON) — คำตัดสินยังเก็บ offAt
  db.raw.prepare("UPDATE customers SET ai_enabled = 1, ai_off_reason = '' WHERE line_user_id = ?").run("U-sweep");
  const sends = lineFetch.sends.length;
  const answerPending = createQualifyAnswerPending({ db, pipeline: app.pipeline, logger: silent });
  assert.equal(answerPending({ customerId: "U-sweep" }).redispatched, true);
  await waitFor(() => lineFetch.sends.length > sends);
  const draft = draftUserText(hermesFetch.calls, HELD[1]);
  assert.ok(draft);
  assert.equal(occurrences(draft.body, HELD[0]), 1, "ข้อความแรกระหว่างเหลืองอยู่ในเทิร์น");
  assert.equal(occurrences(draft.body, HELD[1]), 1, "ข้อความล่าสุดไม่ซ้ำ");
  db.close();
});

// #21: คนกดเปิดทับห้องเหลืองในคอนโซล = ตอบข้อความที่ค้างผ่านเส้นเดียวกับตัวกวาด (ไปป์ไลน์จริง)
test("#21 คนกดเปิดทับห้องเหลือง (คอนโซล) = ลูกค้าได้คำตอบข้อความที่ค้างครั้งเดียว โมเดลเห็นข้อความระหว่างเหลืองครบ", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  await yellowWithHeld(app, db, "U-human");
  const sends = lineFetch.sends.length;
  const row = setCustomerAiSwitch({ db, customerId: "U-human", enabled: true, operator: "nok", pipeline: app.pipeline, logger: silent });
  assert.equal(row.ai_enabled, 1);
  await waitFor(() => lineFetch.sends.length > sends);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lineFetch.sends.length, sends + 1, "ตอบครั้งเดียว");
  const draft = draftUserText(hermesFetch.calls, HELD[1]);
  assert.ok(draft);
  assert.equal(occurrences(draft.body, HELD[0]), 1);
  assert.ok(db.getSetting(qualifyHumanOnKey("U-human")), "#5 ประทับเวลาคนเปิด");
  assert.ok(db.getSetting(qualifyReleaseKey("U-human")), "หมุดห้ามปิดซ้ำยังอยู่");
  db.close();
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ห้องเหลืองค้างหลายวัน — คนกดเปิดแล้วเคยตอบข้อความเก่าทันที (และซ้ำกับที่ทีมตอบทาง LINE OA Manager)
test("รอบ 2: คนกดเปิดทับห้องเหลืองที่ข้อความค้างเก่ากว่า 24 ชม. = ไม่ตอบย้อนหลัง ห้องขึ้นคิวรอตอบ (ไปป์ไลน์จริง)", async () => {
  const { app, db, lineFetch } = makeApp();
  await yellowWithHeld(app, db, "U-human-stale");
  db.raw.prepare("UPDATE messages SET created_at = created_at - ? WHERE customer_id = ?").run(2 * 86_400_000, "U-human-stale");
  const sends = lineFetch.sends.length;
  const row = setCustomerAiSwitch({ db, customerId: "U-human-stale", enabled: true, operator: "nok", pipeline: app.pipeline, logger: silent });
  assert.equal(row.ai_enabled, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(lineFetch.sends.length, sends, "ไม่ส่งอะไรถึงลูกค้า");
  assert.ok(listWaitingRooms({ db, now: Date.now() }).rooms.some((r) => r.id === "U-human-stale"), "ข้อความค้างอยู่ในคิวรอตอบให้ทีม");
  db.close();
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค. (repro rv10-night-held): ตัวกวาดเปิดเขียวกลางดึกแล้วข้าม answerPending — เช้าลูกค้าพิมพ์ "ว่าไงคะ"
// เดิมห้องเขียวแล้วจึงไม่รวมข้อความระหว่างเหลือง ร่างคำตอบไม่เห็น "มีร้านกาแฟสองสาขา" เลย (เหตุที่ห้องเปิดเขียว)
// ตัวกวาดจด answerSkipped (+offAt) ในสถานะ → เทิร์นแรกของห้องเขียวรวมข้อความค้างครั้งเดียว แล้วลบธง
test("รอบ 2 (rv10-night-held): ตัวกวาดเปิดเขียวแบบข้ามการตอบ (answerSkipped) → เทิร์นถัดไปโมเดลเห็นข้อความระหว่างเหลืองครบครั้งเดียว", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  await yellowWithHeld(app, db, "U-night");
  // ตัวกวาดเปิดเขียว (CAS เดียวกับ CAS_ON) + สถานะรูปที่ applyGreen เขียนเมื่อข้ามการตอบ
  db.raw.prepare("UPDATE customers SET ai_enabled = 1, ai_off_reason = '' WHERE line_user_id = ?").run("U-night");
  db.setSetting(qualifyStateKey("U-night"), JSON.stringify({
    verdict: "potential", confidence: 0.8, category: "has_business_or_job", reason: "มีร้านของตัวเอง", lastInboundId: "x",
    at: Date.now(), mode: "on", offAt: 1, [QUALIFY_ANSWER_SKIPPED_FIELD]: true,
  }));
  await tick();
  inbound(db, "U-night", "ว่าไงคะ");
  const sends = lineFetch.sends.length;
  const result = await app.pipeline.handleInboundText({ customerId: "U-night", text: "ว่าไงคะ", replyToken: "rt-morning" });
  assert.equal(result.sent, true, JSON.stringify(result));
  assert.equal(lineFetch.sends.length - sends, 1);
  const draft = draftUserText(hermesFetch.calls, "ว่าไงคะ");
  assert.ok(draft, "มีคำขอร่างคำตอบ");
  for (const text of [...HELD, "ว่าไงคะ"]) assert.equal(occurrences(draft.body, text), 1, `${text} ต้องอยู่ในคำขอครั้งเดียว`);
  assert.equal(JSON.parse(db.getSetting(qualifyStateKey("U-night")))[QUALIFY_ANSWER_SKIPPED_FIELD], undefined, "ธงถูกลบ");
  assert.match(db.listAudit().find((row) => row.action === YELLOW_HELD_AUDIT_ACTION && row.target === "U-night")?.detail || "", /2 ข้อความ/u);
  // เทิร์นถัดไป = ตอบปกติ ไม่รวมข้อความเก่าซ้ำ
  inbound(db, "U-night", "ขอรายละเอียดคลาสหน่อยค่ะ");
  await app.pipeline.handleInboundText({ customerId: "U-night", text: "ขอรายละเอียดคลาสหน่อยค่ะ", replyToken: "rt-next" });
  const next = draftUserText(hermesFetch.calls, "ขอรายละเอียดคลาสหน่อยค่ะ");
  assert.ok(next);
  assert.doesNotMatch(next.user, /ตอนนี้มีร้านกาแฟสองสาขาค่ะ/u, "ข้อความระหว่างเหลืองไม่ถูกยัดเข้าเทิร์นถัดไปซ้ำ");
  db.close();
});

// รีวิวปรปักษ์รอบ 3 5 ต.ค. (f1-broadcast-freeze): createApp จริง + ตัวกวาดจริง + ไปป์ไลน์จริง บนนาฬิกาเลื่อนได้
// โมเดลปลอมตอบคำตัดสินของตัวกวาดตามที่ตั้ง (ไม่เข้าเกณฑ์ → มีศักยภาพ) และร่างคำตอบลูกค้าตามปกติ
function sweepHermes() {
  let verdict = "not_qualified";
  const fn = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    let content = "ยินดีค่ะ เดี๋ยวลูกแพรเล่ารายละเอียดคลาสให้นะคะ";
    if (body.prompt_cache_key === "lukprae-hermes-qualify") {
      const refs = [...String(body.messages.at(-1).content).matchAll(/^\[(m\d+)\] ลูกค้า/gmu)].map((m) => m[1]);
      content = JSON.stringify(verdict === "not_qualified"
        ? { verdict, confidence: 0.92, category: "unemployed", evidence_ids: refs.slice(0, 2), reason: "ตกงาน" }
        : { verdict, confidence: 0.85, category: "has_business_or_job", evidence_ids: refs.slice(-1), reason: "มีร้านของตัวเอง" });
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }) };
  };
  fn.setVerdict = (value) => { verdict = value; };
  return fn;
}

test("รอบ 3 (f1-broadcast-freeze): บรอดแคสต์ของทีมหลังห้องเหลือง ไม่ทำให้ห้องติดเหลือง — ตรวจซ้ำเปิดเขียว · off คืนห้อง · rollback คืนได้", async () => {
  const BKK = (h, m = 0) => Date.UTC(2026, 9, 5, h - 7, m);
  let clock = BKK(9, 20);
  const now = () => clock;
  const db = memoryDb({ now });
  const hermesFetch = sweepHermes();
  const app = createApp({ config: testConfig(), db, overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {}, now }, logger: silent });
  for (const id of ["U-bc-green", "U-bc-off"]) {
    db.upsertCustomer(id, { displayName: "คุณทดสอบ" });
    db.raw.prepare("UPDATE customers SET last_score = 2 WHERE line_user_id = ?").run(id); // 8 พ.ย. 2026: ปิดเหลืองเฉพาะคะแนนต่ำ
    db.insertMessage({ customerId: id, direction: "in", content: "อยากหารายได้เสริมค่ะ ตอนนี้ตกงานอยู่" });
    clock += 60_000;
    db.insertMessage({ customerId: id, direction: "out", content: "ขอบคุณที่เล่าให้ฟังนะคะ", agentMode: "ai" });
    clock += 60_000;
    db.insertMessage({ customerId: id, direction: "in", content: "มีงานให้ทำที่บ้านไหมคะ ไม่มีเงินเรียนค่ะ" });
    clock += 60_000;
    db.insertMessage({ customerId: id, direction: "out", content: "เข้าใจค่ะ", agentMode: "ai" });
  }
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  clock = BKK(10, 2);
  const slot = await app.qualifySweep.runDue();
  assert.deepEqual(slot.slot.results.map((r) => r.outcome), ["yellow", "yellow"]);
  // 10:30 บรอดแคสต์จากคอนโซล — แถวเดียวกับที่ broadcast.mjs เขียนให้ผู้รับทุกคน
  clock = BKK(10, 30);
  for (const id of ["U-bc-green", "U-bc-off"]) {
    db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: "โปรเดือนตุลา ลด 20% ค่ะ", messageClass: "proactive", operator: "nok", agentMode: "operator_ai_on" });
  }
  assert.deepEqual(planNotQualifiedRelease(db).keep, [], "rollback คืนห้องที่ได้แค่บรอดแคสต์ได้ (เดิมเปลี่ยนเป็น manual)");
  clock = BKK(10, 40);
  const text = "ตอนนี้มีร้านกาแฟสองสาขาแล้วค่ะ ลูกค้าเยอะจนตอบแชทไม่ทันเลย";
  inbound(db, "U-bc-green", text);
  const turn = await app.pipeline.handleInboundText({ customerId: "U-bc-green", text, replyToken: "rt" });
  assert.equal(turn.sent, undefined, "ไม่มีคำหลักทางลัด — ยังเหลืองรอตัวกวาดตรวจซ้ำ");
  hermesFetch.setVerdict("potential");
  clock = BKK(10, 42);
  const recheck = await app.qualifySweep.runDue();
  assert.deepEqual(recheck.rechecks.map((r) => r.outcome), ["green"], "เดิม skipped:human_since_off");
  assert.equal(db.getCustomer("U-bc-green").ai_enabled, 1);
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "off");
  clock = BKK(11, 5);
  assert.equal((await app.qualifySweep.runDue()).released, 1, "สวิตช์ off คืนห้องที่ได้แค่บรอดแคสต์");
  assert.equal(db.getCustomer("U-bc-off").ai_enabled, 1);
  db.close();
});
