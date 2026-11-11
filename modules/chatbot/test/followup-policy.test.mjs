// followup-policy.test.mjs — รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 · นโยบายทักตามที่เจนเคาะ: ต้นทุนต่ำสุด + ขายดีที่สุด + บริการดีที่สุด)
// ไม่ทัก: ปฏิเสธ/ไม่สนใจ/ไม่ต้อง/รู้สึกโดนตื๊อ/ดูแลใจ/ปิดห้อง/เงินตึง · ขอเวลาคิด = ทักครั้งเดียววันถัดไป/วันที่ 3 · รอปรึกษาคน = วันที่ 2–3
// · รอเงินเดือน = วันที่ 3–7 · เงียบเฉย ๆ = เรื่องที่ค้างได้ไม่เกินสองครั้ง (ห่าง ≥20 ชม. ครั้งที่สองเปลี่ยนมุม/ขยับเรื่อง) · ไม่มีประโยคกว้าง ๆ
// ข้อความลูกค้าและลูกแพรทุกบรรทัดเป็นประโยคสังเคราะห์ (ถอดความจากรูปเคสจริง ไม่ใช่ข้อความจริง)
import test from "node:test";
import assert from "node:assert/strict";
import { pickFollowupThread, SECOND_TOUCH_MIN_GAP_MS, stripGenericFollowup, GENERIC_FOLLOWUP_EXAMPLES, threadRuleLines, THREAD_KINDS,
  FOLLOWUP_THREAD_PATTERNS } from "../src/followupThread.mjs";
import { followupStopOf, followupStopSignal, FOLLOWUP_SIGNAL_PATTERNS } from "../src/replyEngineV3/stage.mjs";
import { FACEBOOK_STAGE_SCHEDULE, STAGE_SCHEDULE, threadStepPlan } from "../src/stagedFollowups.mjs";
import { inQuietHours } from "../src/followupEngine.mjs";
import { FB_MESSAGING_WINDOW_MS } from "../src/db.mjs";
import { poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ROUNDS = Object.freeze([
  { date: "2026-10-10", classKey: "basic", label: "Classroom AI Agent for Business", product: "AI Agent for Business", fileStatus: "open" },
  { date: "2026-10-17", classKey: "basic", label: "Classroom AI Agent for Business", product: "AI Agent for Business", fileStatus: "open" },
  { date: "2026-10-24", classKey: "advance", label: "Classroom AI Agent Workflow Automation", product: "AI Agent Workflow Automation", fileStatus: "open" },
  { date: "2026-11-14", classKey: "basic", label: "Classroom AI Agent for Business", product: "AI Agent for Business", fileStatus: "open" },
]);
let at = 1_000_000;
const cust = (text, extra = {}) => ({ role: "user", admin: false, proactive: false, media: false, text, meta: null, at: at += 60_000, ...extra });
const bot = (text, stage = "", extra = {}) => ({ role: "assistant", admin: false, proactive: false, media: false, text,
  meta: stage ? { engine: "v3", stage, stageReason: extra.reason || "x", modifiers: extra.modifiers || [], ...(extra.stop ? { followupStop: extra.stop } : {}) } : null,
  at: at += 60_000 });
const admin = (text) => ({ role: "assistant", admin: true, proactive: false, media: false, text, meta: null, at: at += 60_000 });
const fu = (text) => ({ role: "assistant", admin: false, proactive: true, media: false, text, meta: null, at: at += 60_000 });
const CARD = "📌 AI Agent for Business\nราคาปกติ 19,900 บาท\nโปรโมชั่น Early Bird 12,900 บาท/ท่าน";
const LADDER = "สวัสดีค่ะ ลูกแพรเป็นผู้ช่วยของพี่ง้วงค่ะ\nไม่ทราบว่าเคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ?\n1️⃣ ยังไม่เคยใช้เลย\n2️⃣ เคยลองเล่นนิดหน่อย";
const pricedRoom = () => [cust("ค่าเรียนเท่าไหร่คะ"), bot(`ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, "PRICE")];
const pick = (rows, extra = {}) => pickFollowupThread({ rows, rounds: ROUNDS, ...extra });

/* ------------------------------ สัญญาณจากข้อความลูกค้า ------------------------------ */

test("สัญญาณ: ขอเวลาคิด = defer · รอคน/รอเงินเดือน = waiting · ลาเอง = goodbye · คำรับเฉย ๆ/ยังถาม = ไม่มีสัญญาณ", () => {
  for (const text of ["ขอคิดดูก่อนนะคะ", "ขอดูก่อนค่ะ", "ไว้ก่อนนะคะ", "ขอบคุณค่ะ เดี๋ยวดูก่อน", "ขอไปคิดก่อน เดี๋ยวทักมาใหม่", "ขอบคุณข้อมูลค่ะ สนใจอยู่ค่ะ",
    "เดี๋ยวขอดูวันว่างก่อนค่ะ", "ขอเช็คตารางก่อนนะคะ", "ยังไม่สะดวกช่วงนี้ค่ะ", "ไว้รอบหน้านะคะ", "สนใจค่ะ แต่ขอคิดดูก่อน", "เดี๋ยวติดต่อกลับค่ะ"]) {
    assert.equal(followupStopSignal(text), "defer", text);
  }
  for (const text of ["ขอปรึกษาแฟนก่อนนะคะ", "ขอถามที่บ้านก่อนค่ะ", "รอหัวหน้าอนุมัติก่อนครับ", "รอเงินเดือนออกก่อนนะคะ", "สนใจค่ะ แต่ขอปรึกษาสามีก่อน", "ขอรอเงินเข้าก่อนนะคะ"]) {
    assert.equal(followupStopSignal(text), "waiting", text);
  }
  for (const text of ["ขอบคุณค่ะ", "ขอบคุณมากครับ 🙏", "บายค่ะ", "ไม่มีแล้วค่ะ ขอบคุณค่ะ", "ขอบคุณสำหรับข้อมูลค่ะ"]) assert.equal(followupStopSignal(text), "goodbye", text);
  for (const text of ["ok ครับ", "ได้ค่ะ", "โอเคค่ะ", "ค่ะ", "สนใจค่ะ", "ขอดูรอบหน่อยค่ะ", "ไม่ต้องรีบตอบนะคะ เดี๋ยวดูรอบให้", "ไว้ก่อนนะคะ มีรอบเดือนหน้าไหม",
    "ขอคิดราคาแบบผ่อนได้ไหมคะ", "ขอบคุณค่ะ สนใจรอบ 17", "ปรึกษาสามีแล้ว ตกลงเรียนค่ะ", "แพงไปค่ะ"]) {
    assert.equal(followupStopSignal(text), "", text);
  }
  // หยุดทักเหมือนเดิม
  for (const [text, want] of [["ไม่ต้องค่ะ", "declined"], ["ไม่สนใจค่ะ", "declined"], ["ไม่สนใจ ไว้ก่อนนะคะ", "declined"], ["ไม่มีงบค่ะ", "money_hardship"],
    ["รู้สึกโดนตื๊อเลยค่ะ", "pressure"], ["คุณแม่ป่วยเข้าโรงพยาบาลค่ะ", "crisis"]]) assert.equal(followupStopSignal(text), want, text);
});

test("C5: 'ไม่ใช่คนมีเงินเดือนประจำ' / 'ไม่ใช่คนมีเงินสดเยอะ' ไม่ใช่เงินตึง · 'ไม่ใช่คนมีเงิน' / 'ไม่ใช่คนมีตัง' ยังเป็นเงินตึง", () => {
  assert.equal(followupStopSignal("ผมไม่ใช่คนมีเงินเดือนประจำครับ เป็นเจ้าของร้านเอง สนใจคลาสค่ะ"), "");
  assert.equal(followupStopSignal("ไม่ใช่คนมีเงินสดเยอะ แต่โอนได้ค่ะ"), "");
  assert.equal(followupStopSignal("เราไม่ใช่คนมีเงินนะคะ"), "money_hardship");
  assert.equal(followupStopSignal("เราไม่ใช่คนมีตังนะ"), "money_hardship");
});

test("ป้ายของเทิร์นลา (v3): ขอเวลาคิด/ยังสนใจ = defer · รอปรึกษา = care:waiting · ขอบคุณเฉย ๆ = goodbye", () => {
  const goodbye = { stage: "GOODBYE", reason: "closing_words" };
  assert.equal(followupStopOf(goodbye, "ขอคิดดูก่อนนะคะ"), "defer");
  assert.equal(followupStopOf(goodbye, "ขอบคุณข้อมูลค่ะ สนใจอยู่ค่ะ"), "defer");
  assert.equal(followupStopOf(goodbye, "ขอบคุณค่ะ เดี๋ยวดูก่อน"), "defer");
  assert.equal(followupStopOf({ stage: "GOODBYE", reason: "closing_words_last_bubble" }, "ใช้ ChatGPT ค่ะ\nขอไว้ก่อนนะคะ"), "defer");
  assert.equal(followupStopOf(goodbye, "ขอบคุณค่ะ"), "goodbye");
  assert.equal(followupStopOf(goodbye), "goodbye");
  assert.equal(followupStopOf({ stage: "GOODBYE", reason: "care_moment", care: "waiting" }, "ขอปรึกษาแฟนก่อนค่ะ"), "care:waiting");
  assert.equal(followupStopOf({ stage: "GOODBYE", reason: "care_moment", care: "pressure" }, "รู้สึกโดนตื๊อ"), "care:pressure");
});

/* ------------------------------ หยุด / ทักครั้งเดียว / ทักสองครั้ง ------------------------------ */

test("ไม่ทักเลย: ปฏิเสธ · ไม่ต้อง · รู้สึกโดนตื๊อ · ดูแลใจ · v3 ปิดห้อง · เงินตึง · ลูกค้าลาเอง", () => {
  const base = pricedRoom();
  const cases = [
    [[cust("ไม่สนใจค่ะ"), bot("ไม่เป็นไรเลยค่ะ ขอบคุณที่สนใจนะคะ", "OBJECTION", { stop: "declined" })], "stop:declined"],
    [[cust("ไม่ต้องค่ะ"), bot("ได้เลยค่ะ")], "stop:declined"],
    [[cust("รู้สึกโดนตื๊อเลยค่ะ"), bot("ขอโทษนะคะ ลูกแพรไม่ทักรบกวนแล้วค่ะ", "GOODBYE", { reason: "care_moment", stop: "care:pressure" })], "stop:care:pressure"],
    [[cust("ตกงานอยู่ค่ะ"), bot("เป็นกำลังใจให้นะคะ", "GOODBYE", { reason: "care_moment", stop: "care:crisis" })], "stop:care:crisis"],
    [[cust("กดผิดค่ะ"), bot("ไม่เป็นไรเลยค่ะ", "EXIT", { reason: "wrong_click", stop: "exit:wrong_click" })], "stop:exit:wrong_click"],
    [[cust("ตอนนี้ไม่มีเงินเลยค่ะ"), bot("เข้าใจเลยค่ะ ไว้พร้อมเมื่อไหร่ทักลูกแพรได้นะคะ", "OBJECTION", { stop: "money_hardship" })], "stop:money_hardship"],
    [[cust("ขอบคุณค่ะ"), bot("ยินดีค่ะ ขอให้ขายดีนะคะ", "GOODBYE", { reason: "closing_words", stop: "goodbye" })], "stop:goodbye"],
    [[cust("ขอบคุณมากครับ"), bot("ยินดีค่ะ")], "stop:goodbye"],
  ];
  for (const [tail, want] of cases) assert.equal(pick([...base, ...tail], { priceQuoted: true }).reason, want, tail[0].text);
});

test("ขอเวลาคิดหลังเห็นราคา = ทักครั้งเดียว ข้ามไม้เร็ว (ขั้นถัดไปของบันได) ผูกกับเรื่องที่ค้าง (รอบที่ยังเปิด) · ห้อง v3 เก่าที่ได้ป้ายลา (ไม่มีคีย์ทักตาม) ก็ได้", () => {
  const rows = [...pricedRoom(), cust("ขอคิดดูก่อนนะคะ"), bot("ได้เลยค่ะ ค่อย ๆ คิดได้เลยนะคะ 😊", "GOODBYE", { reason: "closing_words" })];
  const out = pick(rows, { priceQuoted: true });
  assert.equal(out.thread.mode, "defer");
  assert.equal(out.thread.kind, "round_choice");
  assert.deepEqual(out.thread.roundLabels, ["เสาร์ 10 ต.ค.", "เสาร์ 17 ต.ค."]);
  assert.deepEqual({ minStep: out.plan.minStep, questionOnly: out.plan.questionOnly, maxTouches: out.plan.maxTouches }, { minStep: 1, questionOnly: true, maxTouches: 1 });
  assert.match(threadRuleLines(out.thread).join("\n"), /ขอเวลาคิด[^\n]*ครั้งเดียว/u);
  // ทักไปแล้วหนึ่งครั้งในช่วงเงียบนี้ = จบ
  const done = pick(rows, { priceQuoted: true, history: [{ thread: "round_choice", at: rows.at(-1).at + DAY }] });
  assert.deepEqual(done, { thread: null, reason: "thread_already_followed" });
  // ยังไม่ได้ราคา: ข้อเสนอที่ช่วยได้หนึ่งข้อ (ส่งรอบให้ดู) ไม่ใช่คำถามทำความรู้จัก
  const early = pick([cust("สนใจค่ะ"), bot(LADDER, "FIRST_CONTACT"), cust("ขอดูก่อนค่ะ"), bot("ได้เลยค่ะ", "GOODBYE", { reason: "closing_words" })]);
  assert.equal(early.thread.mode, "defer");
  assert.equal(early.thread.kind, "rounds_offer");
});

test("รอปรึกษาคนที่บ้าน/หัวหน้า = เช็กอินครั้งเดียววันที่ 2–3 (สรุปสั้น ๆ ให้ส่งต่อ ไม่ชวนเลือกรอบ) · รอเงินเดือน = ครั้งเดียววันที่ 3–7 ไม่กดดัน", () => {
  const consult = pick([...pricedRoom(), cust("ขอปรึกษาแฟนก่อนนะคะ"), bot("ได้เลยค่ะ ปรึกษากันให้สบายใจนะคะ", "GOODBYE", { reason: "care_moment", stop: "care:waiting" })], { priceQuoted: true });
  assert.equal(consult.thread.kind, "consult");
  assert.equal(consult.thread.who, "แฟน");
  assert.deepEqual({ minOffsetMs: consult.plan.minOffsetMs, maxTouches: consult.plan.maxTouches, questionOnly: consult.plan.questionOnly }, { minOffsetMs: 2 * DAY, maxTouches: 1, questionOnly: true });
  const line = threadRuleLines(consult.thread).join("\n");
  assert.match(line, /สรุป[^\n]*ส่งต่อ/u);
  assert.match(line, /ไม่ชวนเลือกรอบ/u);
  const money = pick([...pricedRoom(), cust("รอเงินเดือนออกก่อนนะคะ"), bot("ได้เลยค่ะ ไม่ต้องรีบนะคะ", "GOODBYE", { reason: "care_moment", stop: "care:waiting" })], { priceQuoted: true });
  assert.equal(money.thread.kind, "money_wait");
  assert.equal(money.plan.minOffsetMs, 3 * DAY);
  assert.match(threadRuleLines(money.thread).join("\n"), /ไม่เร่ง/u);
  assert.doesNotMatch(threadRuleLines(money.thread).join("\n"), /\d{1,3},\d{3}/u);
});

test("เงียบเฉย ๆ (ลูกค้าเคยตอบลูกแพรแล้ว): เรื่องที่ค้างทักได้สองครั้ง — ครั้งที่สองห่าง ≥20 ชม. และขยับเรื่อง (ระดับ→งาน) · ห้องที่ได้ราคาแล้ว = ครั้งเดียว · คัดกรองเดิม→แจ้งราคา", () => {
  // 12 ต.ค. 2026: สองครั้งได้เฉพาะห้องที่ลูกค้าเคยตอบลูกแพร (ห้องที่พิมพ์มาแค่ข้อความแรก = ครั้งเดียว ดูเทสต์แยก)
  const level = [cust("สวัสดีค่ะ"), bot("สวัสดีค่ะ ยินดีที่ทักมานะคะ ทำธุรกิจอะไรอยู่คะ?", "DISCOVERY"), cust("ขายของออนไลน์ค่ะ"), bot(LADDER, "FIRST_CONTACT")];
  const first = pick(level);
  assert.equal(first.thread.kind, "level");
  assert.equal(first.plan.maxTouches, 2);
  const t1 = level.at(-1).at + HOUR;
  const second = pick(level, { history: [{ thread: "level", at: t1 }] });
  assert.equal(second.thread.kind, "work");
  assert.equal(second.thread.touch, 2);
  assert.equal(second.plan.floorAt, t1 + SECOND_TOUCH_MIN_GAP_MS);
  assert.ok(SECOND_TOUCH_MIN_GAP_MS >= 20 * HOUR);
  assert.deepEqual(pick(level, { history: [{ thread: "level", at: t1 }, { thread: "work", at: t1 + DAY }] }), { thread: null, reason: "thread_already_followed" });
  // 12 ต.ค. 2026 (พี่ง้วง "ห้องที่ได้ราคาแล้ว ทักครั้งเดียวในเช้าวันถัดไป"): ห้องเห็นราคาแล้ว = ครั้งเดียว
  const priced = [cust("สนใจค่ะ"), bot("ยินดีค่ะ ทำงานด้านไหนอยู่คะ?", "DISCOVERY"), ...pricedRoom()];
  const p1 = pick(priced, { priceQuoted: true, painPoint: "ตอบแชทไม่ทัน" });
  assert.equal(p1.plan.maxTouches, 1);
  assert.equal(p1.plan.morningAfter, priced.at(-2).at, "เช้าวันถัดไปนับจากข้อความที่ลูกค้าพิมพ์ล่าสุด");
  assert.deepEqual(pick(priced, { priceQuoted: true, painPoint: "ตอบแชทไม่ทัน", history: [{ thread: "round_choice", at: priced.at(-1).at + HOUR }] }),
    { thread: null, reason: "thread_already_followed" });
  // คัดกรองก่อนราคา (ไม้แรกของก่อนแก้กั้นราคาไว้) → ไม้ที่สองแจ้งราคาเลย ไม่ถามข้อที่เบากว่า
  const screen = [cust("สนใจค่ะ"), bot("ยินดีค่ะ ทำงานด้านไหนอยู่คะ?", "DISCOVERY"), cust("ค่าเรียนเท่าไหร่คะ"),
    bot("ยินดีที่สนใจนะคะ ขอถามสั้น ๆ ข้อเดียว ตอบแล้วลูกแพรแจ้งค่าเรียนให้ทันทีเลยค่ะ\nเคยใช้ AI มาประมาณไหนคะ เช่น ยังไม่เคย ลองบ้าง หรือใช้ประจำ?", "SCREEN_PRICE")];
  const s2 = pick(screen, { history: [{ thread: "screen_price", at: screen.at(-1).at + HOUR }] });
  assert.equal(s2.thread.kind, "price_owed");
  assert.match(threadRuleLines(s2.thread).join("\n"), /แจ้งค่าเรียนเลย ไม่ถามพื้นฐานหรือคัดกรองก่อนอีก/u);
  assert.doesNotMatch(threadRuleLines(s2.thread).join("\n"), /ยังไม่บอกตัวเลข|ตอบได้ด้วยคำเดียว/u);
  // ไม่มีมุมใหม่ให้ขยับ = ไม่ทักครั้งที่สอง
  const nothing = [cust("เรียนกี่โมงคะ"), bot("เรียนสด 1 วัน 10:00–17:00 น. ค่ะ อยากให้ช่วยงานด้านไหนก่อนคะ เช่น เอกสาร หรือตอบแชท?", "LOGISTICS")];
  assert.equal(pick(nothing).thread.kind, "work");
  // ห้องที่ลูกค้าพิมพ์มาข้อความเดียวแล้วเงียบ = ครั้งเดียวตลอดอายุห้อง
  assert.deepEqual(pick(nothing, { history: [{ thread: "work", at: nothing.at(-1).at + HOUR }] }), { thread: null, reason: "opening_only_followed" });
});

test("ชวนรอบแบบ 'สนใจรอบเสาร์ที่ 17 ต.ค. ไหมคะ?' = เรื่องเลือกรอบ (ใช้รอบที่ยังเปิดจริง) · 'สนใจคลาสไหนคะ' ไม่ใช่", () => {
  const out = pick([cust("ค่าเรียนเท่าไหร่"), bot(`ค่าเรียน 19,900 บาท โปรโมชั่น 12,900 บาทค่ะ\n\nสนใจรอบเสาร์ที่ 17 ต.ค. ไหมคะ?`, "PRICE")], { priceQuoted: true });
  assert.equal(out.thread.kind, "round_choice");
  assert.deepEqual(out.thread.roundLabels, ["เสาร์ 17 ต.ค."]);
  assert.notEqual(pick([cust("ราคาเท่าไหร่"), bot("มีสองคลาสค่ะ สนใจคลาสไหนคะ?", "PRICE")]).thread?.kind, "round_choice");
});

test("C6: สติกเกอร์/รูปหลังไม้แรกไม่เปิดช่วงเงียบใหม่ — นับครั้งจากข้อความที่ลูกค้าพิมพ์ล่าสุด (ไม่ใช่ anchor ของรูป)", () => {
  const rows = [cust("สวัสดีค่ะ"), bot("ยินดีค่ะ ทำธุรกิจอะไรอยู่คะ?", "DISCOVERY"), cust("ร้านกาแฟค่ะ"), bot(LADDER, "FIRST_CONTACT"), fu("ลูกแพรสรุปคลาสให้ดูนะคะ")];
  const nudgeAt = rows.at(-1).at;
  rows.push(cust("[sticker]", { media: true }));
  const out = pick(rows, { history: [{ thread: "level", at: nudgeAt }], episodeAnchor: rows.at(-1).at });
  assert.equal(out.thread.kind, "work", "ไม่ถามระดับซ้ำ");
  assert.equal(out.thread.touch, 2);
  assert.equal(out.plan.floorAt, nudgeAt + SECOND_TOUCH_MIN_GAP_MS);
});

test("U4: ลูกค้าตอบรับเฉย ๆ แล้วลูกแพรปิดด้วยคำลา = ย้อนหาคำถามที่ค้าง (ห้อง e67a92d5) · ลูกค้าลาเองถึงหยุด", () => {
  const rows = [cust("ได้ครับ"), bot("รอบที่เปิดคือ เสาร์ 17 ต.ค. · เสาร์ 14 พ.ย. สะดวกรอบไหนคะ?", "LOGISTICS"), cust("เป็นออนไซต์ไหมครับ"),
    bot("เรียนสดที่ EZ Space ใกล้ Mega Bangna ค่ะ"), cust("มันจะช่วยธุรกิจผมยังไง"), bot("ช่วยให้ใช้ AI กับงานขายและดูแลลูกค้าเป็นระบบขึ้นค่ะ"), cust("ok ครับ"),
    bot("ได้เลยค่ะ ถ้ามีข้อสงสัยเพิ่มเติมเกี่ยวกับคลาส ทักลูกแพรได้เลยนะคะ 😊")];
  const out = pick(rows);
  assert.equal(out.thread?.kind, "round_choice", JSON.stringify(out));
  assert.deepEqual(out.thread.roundLabels, ["เสาร์ 17 ต.ค.", "เสาร์ 14 พ.ย."]);
  // คำถามย่อยที่ถามตามหลัง (มาเรียนที่สถาบันหรือให้ไปสอน) ลูกค้าตอบพร้อมถามต่อ = เรื่องที่ยังค้างคือรอบ
  const sub = [cust("ได้ครับ"), bot("รอบที่เปิดคือ เสาร์ 17 ต.ค. · เสาร์ 14 พ.ย. สะดวกรอบไหนคะ?", "LOGISTICS"), cust("เป็นออนไซต์ไหมครับ"),
    bot("เรียนสดที่ EZ Space ค่ะ\nสนใจมาเรียนที่สถาบัน หรือให้ไปสอนที่บริษัทคะ?"), cust("สถาบันก็ได้ครับ มันจะช่วยธุรกิจผมยังไง"), bot("ช่วยให้ใช้ AI กับงานขายเป็นระบบขึ้นค่ะ"),
    cust("ok ครับ"), bot("ได้เลยค่ะ ทักลูกแพรได้เลยนะคะ 😊")];
  assert.equal(pick(sub).thread?.kind, "round_choice");
  // ลูกค้าตอบคำถามนั้นไปแล้ว ("เสาร์ 17 ค่ะ") = ไม่ย้อนไปถามซ้ำ
  const answered = [cust("ได้ครับ"), bot("สะดวกรอบไหนคะ เสาร์ 17 ต.ค. หรือ เสาร์ 14 พ.ย.?", "LOGISTICS"), cust("เสาร์ 17 ครับ"), bot("รับทราบค่ะ ทีมงานจะยืนยันที่นั่งให้นะคะ"), cust("ok ครับ"), bot("ยินดีค่ะ ทักลูกแพรได้ตลอดนะคะ")];
  assert.notEqual(pick(answered).thread?.kind, "round_choice");
  const closed = [...rows.slice(0, -2), cust("ขอบคุณครับ"), bot("ยินดีค่ะ ทักลูกแพรได้ตลอดนะคะ 😊")];
  assert.equal(pick(closed).reason, "stop:goodbye");
});

test("U4: ทีมงานพิมพ์คำถามเป็นคนสุดท้าย (AI เปิด หน้าต่างทีมหมด) = ทักต่อจากคำถามของทีม · ทีมปิดห้อง/ไม่ได้ถาม = ไม่ทัก (ห้อง d13f0269)", () => {
  const rows = [admin("สวัสดีค่ะ เคยสร้าง AI เป็นผู้ช่วยส่วนตัวมาก่อนมั้ยคะ ?"), cust("ไม่ค่อยครับ ใช้เป็นที่ปรึกษา"), admin("ปกติใช้ AI ตัวไหนอยู่บ้างคะ"),
    cust("ChatGPT ครับ"), admin("สนใจนำ AI มาช่วยงานธุรกิจส่วนตัว หรืองานประจำคะ")];
  const out = pick(rows);
  assert.equal(out.thread?.kind, "work", JSON.stringify(out));
  assert.equal(out.thread.askedBy, "team");
  assert.match(threadRuleLines(out.thread).join("\n"), /ทีมงานถามไว้ว่า "สนใจนำ AI มาช่วยงานธุรกิจส่วนตัว/u);
  // คำถามที่ขึ้นบรรทัดใหม่กลางประโยค = ประโยคเดียวกัน (ไม่ใช่ "หรือ งานประจำคะ" ลอย ๆ)
  const split = pick([cust("Chat gpt ครับ"), admin("คุณลูกค้าสนใจเริ่มต้นนำ AI เข้ามาช่วยงานในธุรกิจส่วนตัว\nหรือ งานประจำคะ")]);
  assert.equal(split.thread.question, "คุณลูกค้าสนใจเริ่มต้นนำ AI เข้ามาช่วยงานในธุรกิจส่วนตัว หรือ งานประจำคะ");
  assert.equal(split.thread.kind, "work");
  assert.equal(pick([cust("ChatGPT ครับ"), admin("ขอบคุณที่คุยกันนะคะ ยินดีให้บริการค่ะ")]).reason, "stop:operator_closed");
  assert.equal(pick([cust("สนใจค่ะ"), admin("[แอดมินทีมงานพิมพ์เอง] ทีมงานเองค่ะ ขอเช็คคิวให้นะคะ")]).reason, "operator_last");
});

test("U5: เห็นราคาแล้วไม่มีคำถามค้าง = เลือกรอบ/ยังติดเรื่องไหน (ไม่ใช่ทิปเรื่องงาน) · ขั้นสมัคร = คำถามอย่างเดียว ไม้หลัง ครั้งเดียว", () => {
  const rows = [cust("สนใจค่ะ"), bot(LADDER, "FIRST_CONTACT"), cust("3 ค่ะ ขายเสื้อผ้าออนไลน์ ตอบแชทไม่ทัน"), ...pricedRoom(), cust("เรียนกี่โมงถึงกี่โมงคะ"),
    bot("เรียนสด 1 วัน 10:00–17:00 น. มีพักกลางวันค่ะ ที่ EZ Space ใกล้ Mega Bangna ค่ะ", "LOGISTICS")];
  const out = pick(rows, { priceQuoted: true, painPoint: "ตอบแชทลูกค้าร้านเสื้อผ้าไม่ทันช่วงไลฟ์" });
  assert.equal(out.thread.kind, "round_choice");
  assert.equal(out.thread.goal, "");
  const none = pick([...pricedRoom().slice(0, 1), bot(`ค่าเรียนค่ะ\n${CARD}`, "PRICE"), cust("ครับ"), bot("ยินดีค่ะ", "LOGISTICS")], { priceQuoted: true, rounds: [], painPoint: "ทำโพสต์ไม่ทัน" });
  assert.equal(none.thread.kind, "after_price");
  const reg = pick([...pricedRoom(), cust("17 ค่ะ"), bot("รับทราบรอบเสาร์ 17 ต.ค. ค่ะ ทีมงานจะเป็นผู้ยืนยันที่นั่งให้นะคะ\n\nต้องการออกใบเสร็จในนามบุคคลธรรมดาหรือบริษัทคะ?", "LOGISTICS", { reason: "accepted_round_pick" })], { priceQuoted: true });
  assert.equal(reg.thread.registration, true);
  assert.deepEqual({ minStep: reg.plan.minStep, questionOnly: reg.plan.questionOnly, maxTouches: reg.plan.maxTouches }, { minStep: 1, questionOnly: true, maxTouches: 1 });
});

test("U6: ลูกค้าบอกระดับเป็นนัยแล้ว (บันไดยังส่ง) = ทักถามเรื่องงาน ไม่ใช่ไม่ทัก/ไม่ถามระดับซ้ำ · ขอรายละเอียดแล้วได้บันได = ส่งรายละเอียด", () => {
  // 12 ต.ค. 2026: ลูกค้าขอรายละเอียดแล้วได้บันไดแทน = ทักตามส่งรายละเอียดเลย (ไม่ใช่ถามเรื่องงาน)
  for (const first of ["ใช้ AI ประจำอยู่แล้วค่ะ ขอรายละเอียด", "ขอรายละเอียดค่ะ ยังไม่เคยใช้ AI เลย"]) {
    const out = pick([cust(first), bot(LADDER, "FIRST_CONTACT")]);
    assert.equal(out.thread?.kind, "deliver", first);
    assert.equal(out.thread.deliver, "details", first);
  }
  for (const first of ["สนใจค่ะ ใช้ ChatGPT ทำงานทุกวันเลย", "เคยทำ Custom GPT ใช้ในบริษัทแล้วครับ", "ใช้ chatgpt บ้างค่ะ สนใจคลาส"]) {
    const out = pick([cust(first), bot(LADDER, "FIRST_CONTACT")]);
    assert.equal(out.thread?.kind, "work", first);
    assert.equal(out.thread.question, "", first);
    assert.match(threadRuleLines(out.thread).join("\n"), /งานไหนก่อน/u);
  }
  assert.equal(pick([cust("สนใจค่ะ"), bot(LADDER, "FIRST_CONTACT")]).thread.kind, "level");
});

test("คำถามค้างที่เป็นประโยคกว้าง ๆ ('มีอะไรอยากถามเพิ่มไหมคะ') ไม่ใช่เรื่องที่ค้าง", () => {
  const out = pick([cust("เรียนกี่โมงคะ"), bot("เรียนสด 1 วัน 10:00–17:00 น. ค่ะ มีส่วนไหนอยากทราบเพิ่มไหมคะ?", "LOGISTICS")]);
  assert.deepEqual(out, { thread: null, reason: "no_open_thread" });
});

/* ------------------------------ ด่านหลังร่าง (U8/C4) ------------------------------ */

test("U8/C4: ไม่ตัดคำถามที่มีเรื่องจริง (วันเรียน/ค่าเรียน/เนื้อหา/รอบ/ชื่อคลาส) · 'ข้อสงสัย' ล้วน ๆ ไม่ใช่ประโยคกว้าง · ประโยคกว้าง ๆ ยังตัด", () => {
  for (const draft of ["ยังมีตรงไหนที่อยากทราบเพิ่มเรื่องวันเรียนหรือเนื้อหาไหมคะ?", "ตอนนี้ยังมีข้อสงสัยเรื่องวันเรียน ค่าเรียน หรือเนื้อหาตรงไหนไหมคะ",
    "เรื่องวันเรียน ค่าเรียน หรือเนื้อหา มีส่วนไหนที่ยังสงสัยอยู่ไหมคะ?", "มีส่วนไหนที่อยากรู้เพิ่มเกี่ยวกับคลาส AI Agent for Business ไหมคะ?"]) {
    assert.equal(stripGenericFollowup(draft), draft, draft);
  }
  assert.equal(stripGenericFollowup("รอบเสาร์ 17 ต.ค. หรือ 14 พ.ย. สะดวกกว่ากันคะ ไม่ต้องรีบตัดสินใจนะคะ?"), "รอบเสาร์ 17 ต.ค. หรือ 14 พ.ย. สะดวกกว่ากันคะ");
  assert.equal(stripGenericFollowup("ถ้ามีข้อสงสัยบอกลูกแพรได้เลยนะคะ ตอนนี้สนใจคลาสไหนคะ"), "ตอนนี้สนใจคลาสไหนคะ");
  assert.equal(stripGenericFollowup("มีส่วนไหนอยากทราบเพิ่มไหมคะ บอกลูกแพรได้เสมอค่ะ"), "");
  // ตัวอย่างประโยคกว้าง ๆ ที่บอกโมเดลให้เลี่ยง = ตัวที่ด่านหลังร่างตัดจริงทุกตัว
  assert.ok(GENERIC_FOLLOWUP_EXAMPLES.length >= 6);
  for (const phrase of GENERIC_FOLLOWUP_EXAMPLES) assert.equal(stripGenericFollowup(`${phrase}นะคะ`, { needsQuestion: false }), "", phrase);
});

/* ------------------------------ จัดไม้ตามบันได ------------------------------ */

test("จัดไม้: ขอเวลาคิด = ไม้ที่ 2 · รอปรึกษา = ไม้แรกที่ ≥ วันที่ 2 (hot ไม่มี = ไม้ท้ายเลื่อนไปวันที่ 2) · รอเงิน = ≥ วันที่ 3", () => {
  const anchor = Date.UTC(2026, 0, 13, 7, 0, 0); // 14:00 เวลาไทย
  const plan = (mode, extra = {}) => ({ mode, minStep: 0, minOffsetMs: 0, floorAt: 0, ...extra });
  assert.deepEqual(threadStepPlan({ plan: plan("defer", { minStep: 1 }), schedule: STAGE_SCHEDULE.hot, stepIndex: 0, anchorMs: anchor }), { stepIndex: 1, floorAt: 0 });
  assert.deepEqual(threadStepPlan({ plan: plan("defer", { minStep: 1 }), schedule: STAGE_SCHEDULE.warm, stepIndex: 0, anchorMs: anchor }), { stepIndex: 1, floorAt: 0 });
  assert.deepEqual(threadStepPlan({ plan: plan("consult", { minOffsetMs: 2 * DAY }), schedule: STAGE_SCHEDULE.warm, stepIndex: 0, anchorMs: anchor }), { stepIndex: 1, floorAt: 0 });
  assert.deepEqual(threadStepPlan({ plan: plan("consult", { minOffsetMs: 2 * DAY }), schedule: STAGE_SCHEDULE.cold, stepIndex: 0, anchorMs: anchor }), { stepIndex: 2, floorAt: 0 });
  assert.deepEqual(threadStepPlan({ plan: plan("consult", { minOffsetMs: 2 * DAY }), schedule: STAGE_SCHEDULE.hot, stepIndex: 0, anchorMs: anchor }), { stepIndex: 1, floorAt: anchor + 2 * DAY });
  assert.deepEqual(threadStepPlan({ plan: plan("money_wait", { minOffsetMs: 3 * DAY }), schedule: STAGE_SCHEDULE.cold, stepIndex: 0, anchorMs: anchor }), { stepIndex: 3, floorAt: 0 });
  assert.deepEqual(threadStepPlan({ plan: plan("money_wait", { minOffsetMs: 3 * DAY }), schedule: STAGE_SCHEDULE.hot, stepIndex: 0, anchorMs: anchor }), { stepIndex: 1, floorAt: anchor + 3 * DAY });
  assert.deepEqual(threadStepPlan({ plan: plan("normal", { floorAt: anchor + 30 * HOUR }), schedule: STAGE_SCHEDULE.hot, stepIndex: 1, anchorMs: anchor }), { stepIndex: 1, floorAt: anchor + 30 * HOUR });
});

test("Facebook (หน้าต่าง 24 ชม.): ขอเวลาคิด/รอปรึกษา = ทักครั้งเดียวราว +20–22 ชม. หลังข้อความลูกค้า · รอเงินเดือน = ไม่ทัก · ครั้งที่สองของเรื่องเดิม = ราว +20–22 ชม. ห่างครั้งแรก ≥12 ชม. · ไม่เกิน +23 ชม.", () => {
  const bkk = (day, h, m = 0) => Date.UTC(2026, 0, day, h - 7, m);
  const fb = (plan, anchor, schedule = FACEBOOK_STAGE_SCHEDULE.hot, stepIndex = 0) => threadStepPlan({ plan: { minStep: 0, minOffsetMs: 0, floorAt: 0, prevTouchAt: 0, ...plan },
    schedule, stepIndex, anchorMs: anchor, channelId: "facebook", customerId: "facebook:1", lastInboundAt: anchor });
  for (const anchor of [bkk(13, 10), bkk(13, 14), bkk(13, 19, 30), bkk(13, 23, 30), bkk(13, 2), bkk(13, 6)]) {
    for (const mode of ["defer", "consult"]) {
      for (const schedule of Object.values(FACEBOOK_STAGE_SCHEDULE)) {
        const out = fb({ mode, minStep: mode === "defer" ? 1 : 0, minOffsetMs: mode === "consult" ? 2 * DAY : 0 }, anchor, schedule);
        if (out.skip) { assert.equal(out.skip, "fb_window_ends"); continue; }
        assert.equal(out.stepIndex, 0, "คงไม้ปัจจุบัน แล้วรอถึงช่อง +20–22 ชม.");
        assert.ok(out.floorAt >= anchor + 12 * HOUR && out.floorAt <= anchor + 23 * HOUR, `${mode} ${new Date(anchor).toISOString()} → +${((out.floorAt - anchor) / HOUR).toFixed(2)} ชม.`);
        assert.ok(out.floorAt < anchor + FB_MESSAGING_WINDOW_MS && !inQuietHours(out.floorAt));
        if ([bkk(13, 14), bkk(13, 19, 30)].includes(anchor)) assert.ok(out.floorAt >= anchor + 20 * HOUR && out.floorAt <= anchor + 22 * HOUR, "กลางวันปกติ = +20–22 ชม.");
      }
    }
    assert.deepEqual(fb({ mode: "money_wait", minOffsetMs: 3 * DAY }, anchor), { stepIndex: 0, floorAt: 0, skip: "fb_window_ends" }, "รอเงินเดือนบน FB = ไม่ทัก");
  }
  // เงียบเฉย ๆ: ครั้งแรกไม้เร็วเดิม · ครั้งที่สองราว +20–22 ชม. และห่างครั้งแรก ≥12 ชม. (ไม่ใช้กติกา ≥20 ชม. หลังครั้งแรก)
  const anchor = bkk(13, 14);
  assert.deepEqual(fb({ mode: "normal" }, anchor), { stepIndex: 0, floorAt: 0 });
  const second = fb({ mode: "normal", prevTouchAt: anchor + 45 * MIN, floorAt: anchor + 45 * MIN + SECOND_TOUCH_MIN_GAP_MS }, anchor, FACEBOOK_STAGE_SCHEDULE.hot, 1);
  assert.ok(second.floorAt >= anchor + 20 * HOUR && second.floorAt <= anchor + 22 * HOUR, `+${((second.floorAt - anchor) / HOUR).toFixed(2)}`);
  assert.ok(second.floorAt - (anchor + 45 * MIN) >= 12 * HOUR);
  // ลูกค้าพิมพ์ตอนเช้าตรู่ ครั้งแรกตก 09:xx → ไม่มีช่องกลางวันที่ห่าง ≥12 ชม. ก่อนหน้าต่างปิด = ไม่มีครั้งที่สอง
  const early = bkk(13, 8);
  assert.equal(fb({ mode: "normal", prevTouchAt: bkk(13, 9, 10), floorAt: bkk(14, 5, 10) }, early, FACEBOOK_STAGE_SCHEDULE.cold, 1).skip, "fb_window_ends");
  // ขั้นสมัคร = ไม้หลังของบันได FB (อยู่ในหน้าต่างอยู่แล้ว) ไม่เลื่อนไป +20 ชม.
  assert.deepEqual(fb({ mode: "normal", minStep: 1 }, anchor, FACEBOOK_STAGE_SCHEDULE.cold), { stepIndex: 1, floorAt: 0 });
  // LINE ไม่เปลี่ยน
  assert.deepEqual(threadStepPlan({ plan: { mode: "consult", minStep: 0, minOffsetMs: 2 * DAY, floorAt: 0 }, schedule: STAGE_SCHEDULE.hot, stepIndex: 0, anchorMs: anchor, channelId: "default", lastInboundAt: anchor }),
    { stepIndex: 1, floorAt: anchor + 2 * DAY });
});

/* ------------------------------ บรรทัดสั่งงาน + ความเร็ว ------------------------------ */

test("ทุกชนิดเรื่องค้างมีบรรทัดสั่งงานสามบรรทัด · ไม่มีตัวเลขเงิน", () => {
  for (const kind of THREAD_KINDS) {
    const lines = threadRuleLines({ kind, question: "ตอนนี้ทำงานด้านไหนคะ?", roundLabels: ["เสาร์ 17 ต.ค."], goal: "ทำโพสต์ขายของ", priceQuoted: true, who: "แฟน", mode: "normal", touch: 1 });
    assert.equal(lines.length, 3, kind);
    assert.doesNotMatch(lines.join("\n"), /\d{1,3},\d{3}/u, kind);
  }
});

test("ตัวจับใหม่ของตัวทักตามเสร็จไม่เกิน 50 ms กับข้อความยาว 5,000 ตัวอักษร (ช่องว่างยาว/คำซ้ำ)", () => {
  const fill = (unit) => unit.repeat(Math.ceil(5000 / unit.length)).slice(0, 5000);
  const patterns = [...Object.entries(FOLLOWUP_SIGNAL_PATTERNS), ...Object.entries(FOLLOWUP_THREAD_PATTERNS)]
    .flatMap(([name, value]) => (Array.isArray(value) ? value.map((re) => [name, re]) : [[name, value]]));
  for (const [name, re] of patterns) {
    const own = [...new Set(re.source.replace(/\\[pP]\{[^}]*\}|\\[a-zA-Z]|\\./gu, " ").match(/[฀-๿]+|[A-Za-z]{2,}/gu) || [])].slice(0, 24);
    const single = new RegExp(re.source, re.flags.replace(/[gy]/gu, ""));
    for (const input of [fill(" "), fill("\n"), ...own.flatMap((w) => [fill(`${w} `), `${w}${" ".repeat(5000)}x`, fill(w)])]) {
      const t0 = performance.now();
      single.test(input);
      const ms = performance.now() - t0;
      assert.ok(ms < 50, `${name} ${ms.toFixed(0)}ms กับ ${JSON.stringify(input.slice(0, 20))}`);
    }
  }
  for (const word of ["ขอคิดดูก่อน ", "ไว้ก่อน ", "ขอบคุณ ", "สนใจอยู่ ", "รอเงินเดือน ", "ok ", "ปรึกษาแฟน ", "ไม่สนใจ "]) {
    for (const input of [fill(word), `${word}${" ".repeat(5000)}ซ`, `${word}${"\n".repeat(5000)}ซ`]) {
      const t0 = performance.now();
      followupStopSignal(input);
      pickFollowupThread({ rows: [cust(input), bot(input, "DISCOVERY"), cust("ok"), bot(input)], rounds: ROUNDS });
      assert.ok(performance.now() - t0 < 50, JSON.stringify(input.slice(0, 20)));
    }
  }
});
