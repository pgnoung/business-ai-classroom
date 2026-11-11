// reply-closing-question.test.mjs — คำถามปิดท้ายเมื่อมีประโยชน์ต่อการตัดสินใจ
//
// สิ่งที่ด่านนี้ล็อก:
//   1. สวิตช์ settings.reply_closing_question: ไม่มีแถว = on · off = ถ้อยคำเดิมทุกไบต์ · อ่านพัง = off
//   2. เปิดสวิตช์อนุญาตคำถามบริบทจริงได้สูงสุดหนึ่งข้อ; คำตอบ/asset ที่ครบแล้วจบได้ (สามจุด)
//   3. ข้อยกเว้นได้ถ้อยคำเดิมทุกไบต์: ส่งไม้ต่อ · จังหวะดูแล · ลูกค้าปิดบทสนทนา · เทิร์นคัดกรองราคา ·
//      ถูกถามมากไป · ขอเลื่อนการมาเรียน · ห้องรอโอน · คำถามเอกสารก่อนซื้อ
//   4. คงกติกากันขายเกินคำถามของรอบ 13 ก.ย. ไว้ครบ · บรรทัดใหม่ไม่มีคำเรื่องเงิน · ด่านราคาสวนกันยังเขียว
// ข้อความลูกค้าทุกบรรทัดในไฟล์นี้เป็นประโยคสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import {
  customerIsClosing, QUESTION_ENDING, REPLY_CLOSING_QUESTION_KEY, replyClosingQuestionEnabled, replyClosingQuestionMode,
} from "../src/replyClosingQuestion.mjs";
import { closingQuestionTurn } from "../src/conversationStyle.mjs";
import { resolveContinuation } from "../src/continuationResolver.mjs";
import { PRICE_DISCLOSURE_REASONS } from "../src/priceDisclosure.mjs";
import { baseRules } from "../src/pipeline.mjs";
import { classifyPriceDirectives, ordersBannedPhrases, PRICE_MENTION, withPriceDirectiveCapture } from "../src/priceDirectives.mjs";
import { createApp } from "../src/server.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const user = (content) => ({ role: "user", content });
const bot = (content) => ({ role: "assistant", content });
const stranger = (extra = {}) => ({
  line_user_id: "U-cq", known_name: "", last_score: null, price_deferred_at: 0, price_quoted_at: 0,
  known_context_at: 0, price_pivot_deferred_at: 0, ...extra,
});
const DISCOVERY = [bot("ไม่ทราบว่าเคยใช้ AI มาประมาณระดับที่เท่าไหร่แล้วคะ?"), user("ระดับ 3 ค่ะ"), bot("ตอนนี้อยากนำ AI ไปช่วยงานด้านไหนเป็นอย่างแรกคะ?")];
const ON = QUESTION_ENDING.general.on;
const OFF = QUESTION_ENDING.general.off;

/* ------------------------------- สวิตช์ ------------------------------- */

test("สวิตช์: ไม่มีค่า = on · off = ปิด (ไม่สนตัวพิมพ์/ช่องว่าง) · ค่าอื่น = on · อ่านพัง = off", () => {
  const dbWith = (value) => ({ getSetting: (key) => (key === REPLY_CLOSING_QUESTION_KEY ? value : null) });
  assert.equal(replyClosingQuestionMode(dbWith(null)), "on");
  assert.equal(replyClosingQuestionMode(dbWith(undefined)), "on");
  assert.equal(replyClosingQuestionMode(dbWith("off")), "off");
  assert.equal(replyClosingQuestionMode(dbWith("  OFF ")), "off");
  assert.equal(replyClosingQuestionMode(dbWith("on")), "on");
  assert.equal(replyClosingQuestionMode({ getSetting() { throw new Error("db locked"); } }), "off");
  assert.equal(replyClosingQuestionEnabled(dbWith(null)), true);
  assert.equal(replyClosingQuestionEnabled(dbWith("off")), false);
});

/* ------------------------------- ตัวจับการปิดบทสนทนา ------------------------------- */

test("ลูกค้ากำลังปิดบทสนทนา = ขอบคุณ/ขอคิดก่อน/ไม่สะดวก/ไว้ทักใหม่ ที่ไม่มีคำถามใหม่", () => {
  for (const text of [
    "ขอบคุณค่ะ", "ขอบคุณสำหรับข้อมูลนะคะ", "โอเคค่ะ ขอบคุณมากค่ะ", "ขอคิดดูก่อนนะคะ", "ไว้ว่าง ๆ จะทักมาใหม่นะคะ",
    "ช่วงนี้ไม่สะดวกค่ะ", "เดี๋ยวติดต่อกลับนะคะ", "ขอปรึกษาที่บ้านก่อนค่ะ", "ขอไปลองทำดูก่อนนะคะ", "thank you",
    "ไม่เอาแล้วค่ะ", "พอแล้วค่ะ", "ไม่ต้องแล้วครับ", "ยังไม่สนใจค่ะ",
  ]) assert.equal(customerIsClosing(text), true, text);
  for (const text of [
    "ขอบคุณค่ะ แล้วรอบหน้าวันไหนคะ", "สนใจคลาส AI Agent for Business ค่ะ", "ทำร้านกาแฟค่ะ", "โอเคค่ะ เข้าใจแล้ว",
    "ครับ", "", "   ", "https://example.com/x?thanks=1",
  ]) assert.equal(customerIsClosing(text), false, JSON.stringify(text));
});

// คำสั่งพี่ง้วง 28 ก.ย.: "ขอเช็คคิวก่อน" คือเทิร์นปิด — ห้ามปิดท้ายด้วยคำถาม (แม้ลูกค้าจะถามรอบมาในข้อความเดียวกัน
// เขาก็ได้รายการรอบในคำตอบอยู่แล้ว คำถาม "สะดวกรอบไหนคะ" ต่อท้ายคือการจี้)
test("ลูกค้าขอเช็คคิว/วันก่อน = ปิดบทสนทนา ไม่ได้คำถามปิดท้าย", () => {
  for (const text of ["ขอเช็คคิวก่อนนะคะ", "เดี๋ยวดูวันก่อนค่ะ", "ขอเช็คคิวก่อน มีรอบไหนบ้างคะ", "ต้องเช็คตารางก่อนค่ะ"]) {
    assert.equal(customerIsClosing(text), true, text);
    assert.equal(closingQuestionTurn({ closingQuestion: true, text, history: DISCOVERY, disclosure: { mode: "defer" } }), false, text);
  }
  for (const text of ["ช่วยเช็คคิวให้หน่อยได้ไหมคะ", "จองคิวได้ไหม", "มีคิวว่างวันไหนบ้างคะ"]) {
    assert.equal(customerIsClosing(text), false, text);
  }
});

test("closingQuestionTurn: ปิดสวิตช์หรือเทิร์นที่กติกาอื่นเป็นเจ้าของคำลงท้าย = ไม่เปลี่ยน", () => {
  const normal = { closingQuestion: true, text: "รอบหน้าเรียนวันไหนคะ", history: DISCOVERY, disclosure: { mode: "defer" } };
  assert.equal(closingQuestionTurn(normal), true);
  assert.equal(closingQuestionTurn({ ...normal, closingQuestion: false }), false);
  assert.equal(closingQuestionTurn({ ...normal, closingQuestion: "on" }), false, "ต้องเป็น true จริงเท่านั้น");
  assert.equal(closingQuestionTurn({ ...normal, closingTurn: true }), false, "ส่งไม้ต่อ/ปิด AI");
  assert.equal(closingQuestionTurn({ ...normal, disclosure: { mode: "defer", careMode: "close" } }), false, "จังหวะดูแล");
  assert.equal(closingQuestionTurn({ ...normal, disclosure: { mode: "defer", reason: PRICE_DISCLOSURE_REASONS.DEFER_SCREENING } }), false, "คำถามคัดกรองคือคำถามเดียว");
  assert.equal(closingQuestionTurn({ ...normal, text: "ไว้ว่าง ๆ จะทักมาใหม่นะคะ" }), false, "ลูกค้าปิดบทสนทนา");
  assert.equal(closingQuestionTurn({ ...normal, text: "ไม่ต้องถามแล้วค่ะ บอกมาเลย" }), false, "ถูกถามมากไป = ห้ามถามกลับ");
  assert.equal(closingQuestionTurn({ ...normal, text: "ขอเลื่อนไปเรียนรอบหน้าได้ไหมคะ ลูกไม่สบาย" }), false, "ขอเลื่อน = ปิดด้วยความห่วงใย");
});

/* ------------------------------- ถ้อยคำ ------------------------------- */

test("ถ้อยคำใหม่: คำถามเป็นทางเลือกเมื่อจำเป็น ไม่ถามขออนุญาตส่ง asset ซ้ำ และคงท่อนกันถามรัว", () => {
  for (const line of [ON, QUESTION_ENDING.limitation.on]) {
    assert.equal(PRICE_MENTION.test(line), false, line);
    assert.deepEqual(ordersBannedPhrases(line), []);
  }
  assert.match(ON, /หลังตอบหรือส่งข้อมูล\/asset ที่อนุมัติครบแล้ว จบข้อความได้เลย/u);
  assert.match(ON, /ถ้ายังมีข้อมูลที่จำเป็นต่อการช่วยตัดสินใจในขั้นถัดไปจริง ๆ จึงถามได้สูงสุดหนึ่งข้อ/u);
  // 2026-10-03: ไม่ยกประโยคคำถามตัวอย่างตรงตัวแล้ว (โมเดลลอกไปใช้ทุกห้อง = แข็ง)
  assert.match(ON, /ถามจากบริบทจริงด้วยถ้อยคำของตัวเอง \(ไม่ใช้ประโยคคำถามสำเร็จรูปชุดเดิมทุกห้อง\)/u);
  assert.doesNotMatch(ON, /ไม่ทราบว่าตอนนี้อยากนำไปช่วยงานด้านไหนบ้างนะคะ/u);
  assert.match(ON, /ไม่ใช้คำถามขออนุญาตซ้ำเพื่อส่ง Outline\/รีวิว/u);
  assert.match(ON, /ไม่ใช่การเร่งขาย: ห้ามถามกดดันให้ตัดสินใจ \(เช่น "สนใจสมัครไหมคะ"\)/u);
  assert.match(ON, /ห้ามยิงคำถามชุด ห้ามถามซ้ำเรื่องที่ตอบแล้ว และคำถามต้องไม่ใช่แบบฟอร์มคัดกรอง/u);
  assert.match(ON, /ยกเว้นบันไดคัดกรองระดับ AI 5 ข้อ/u);
  assert.match(ON, /ถ้ากติกาอื่นในเทิร์นนี้กำหนดคำถามไว้แล้ว ให้ใช้คำถามนั้นเป็นคำถามเดียว/u);
  assert.match(ON, /ห้ามถามเก็บข้อมูลหรือห้ามคัดกรองเพิ่ม ให้จบหลังตอบแทน/u);
  assert.match(ON, /ถ้าลูกค้าแค่ตอบรับสั้น ๆ \(ครับ\/ค่ะ\/โอเค\) ให้คำตอบรับยังสั้นตามเดิม/u);
  // off = ถ้อยคำของรอบ 58b52385a ทุกตัวอักษร (ย้ายมาไว้ข้างกัน ไม่ได้แก้)
  assert.match(OFF, /^- หลังตอบคำถามล่าสุดแล้ว ถ้าขาดข้อมูลที่จำเป็นจริง ๆ ต่อการช่วยในขั้นถัดไปจึงถามได้หนึ่งข้อ/u);
  assert.match(QUESTION_ENDING.limitation.off, /; ไม่ต้องบังคับถามคำถามชวนก้าวต่อ — /u);
});

/* ------------------------------- ประกอบพรอมต์ ------------------------------- */

const rulesFor = ({ text, history = DISCOVERY, customer = stranger({ known_context_at: 1 }), intent = "general", closingQuestion }) =>
  baseRules(intent, [], { customer, currentText: text, history, ...(closingQuestion === undefined ? {} : { closingQuestion }) });

test("เทิร์นปกติ + เปิดสวิตช์ = บรรทัดใหม่แทนที่บรรทัดเดิม · ค่าเริ่มต้นของ baseRules (ผู้เรียกตรง) = ถ้อยคำเดิมทุกไบต์", () => {
  for (const text of ["คลาส AI Agent for Business เรียนอะไรบ้างคะ", "รอบหน้าเรียนวันไหนคะ", "ทำร้านกาแฟค่ะ", "โอเคค่ะ เข้าใจแล้ว", "ไม่ค่อยมีเวลาเลยค่ะ งานเยอะ"]) {
    const on = rulesFor({ text, closingQuestion: true });
    const off = rulesFor({ text });
    assert.ok(on.includes(ON), `on: ${text}`);
    assert.ok(!on.includes(OFF), `on ต้องไม่มีบรรทัดเดิม: ${text}`);
    assert.ok(on.includes(QUESTION_ENDING.limitation.on));
    assert.ok(off.includes(OFF) && !off.includes(ON), `off: ${text}`);
    assert.equal(off, rulesFor({ text, closingQuestion: false }), "ค่าเริ่มต้นของ baseRules = false");
    // ต่างกันเฉพาะสามท่อนคำถาม
    const back = Object.values(QUESTION_ENDING).reduce((value, pair) => value.split(pair.on).join(pair.off), on);
    assert.equal(back, off, `ต่างเกินท่อนคำถาม: ${text}`);
  }
});

test("เทิร์นตอบรับสั้น (resolver จริง: ไม่มีข้อเสนอค้าง / ค้างข้อเสนอ): บรรทัดตอบรับเดิมอยู่ครบ และคำถามปิดท้ายเป็นทางเลือก ไม่คัดกรอง", () => {
  const plainHistory = [...DISCOVERY, user("ทำร้านกาแฟค่ะ"), bot("คลาสนี้สอนสด 1 วัน พี่ง้วงสอนเอง มีทีม TA ช่วยระหว่าง Workshop ค่ะ 😊")];
  const offerHistory = [...DISCOVERY, user("ทำร้านกาแฟค่ะ"), bot("คลาสนี้เหมาะกับร้านกาแฟค่ะ อยากให้ลูกแพรส่งรายละเอียดรอบเรียนให้ไหมคะ?")];
  for (const [history, expectedAction] of [[plainHistory, "acknowledge_only"], [offerHistory, "continue_previous_offer"]]) {
    const continuation = resolveContinuation({ latestText: "ครับ", history });
    assert.equal(continuation?.action, expectedAction);
    const on = baseRules("general", [], { customer: stranger({ known_context_at: 1 }), currentText: "ครับ", history, continuation, closingQuestion: true });
    const off = baseRules("general", [], { customer: stranger({ known_context_at: 1 }), currentText: "ครับ", history, continuation, closingQuestion: false });
    assert.ok(on.includes(ON), expectedAction);
    if (expectedAction === "acknowledge_only") {
      assert.match(on, /ตอบรับสั้น ๆ อบอุ่นบับเบิลเดียวพอ ห้ามเปิดหัวข้อใหม่ ห้ามถามคำถามคัดกรอง/u, "บรรทัดตอบรับเดิมต้องอยู่ครบ");
    } else {
      assert.match(on, /ลูกค้าเพิ่งตอบรับข้อเสนอล่าสุดของเรา/u);
    }
    assert.match(on, /ถามต่อได้เฉพาะเมื่อมีประเด็นเดิมที่ต้องใช้ตัดสินใจจริง โดยไม่เปิดหัวข้อใหม่และไม่ใช่คำถามคัดกรอง/u, "สองบรรทัดต้องพูดทางเดียวกัน");
    const back = Object.values(QUESTION_ENDING).reduce((value, pair) => value.split(pair.on).join(pair.off), on);
    assert.equal(back, off, `ต่างเกินท่อนคำถาม: ${expectedAction}`);
  }
});

test("คงกติกากันขายเกินคำถามของรอบ 13 ก.ย. ไว้ครบ (เปลี่ยนเฉพาะท่อนคำถามปิดท้าย)", () => {
  const on = rulesFor({ text: "ChatGPT ใช้ทำอะไรได้บ้างคะ", customer: stranger(), closingQuestion: true });
  assert.match(on, /ห้ามเสนอคลาสหรือเล่าคุณค่าเกินกว่าที่เขาถาม/u);
  assert.ok(on.includes(ON));
});

test("ข้อยกเว้นได้พรอมต์เดิมทุกไบต์: ขอบคุณ · ขอคิดก่อน · ไว้ทักใหม่ · ส่งไม้ต่อ · คัดกรองราคา · ถูกถามมากไป · ขอเลื่อน · ห้องรอโอน · เอกสารก่อนซื้อ", () => {
  const cases = [
    { text: "ขอบคุณมากค่ะ" },
    { text: "ขอคิดดูก่อนนะคะ" },
    { text: "ไว้ว่าง ๆ จะทักมาใหม่นะคะ" },
    { text: "ขอบคุณสำหรับข้อมูลนะคะ" },
    { text: "ราคาเท่าไหร่คะ", history: [], customer: stranger() },
    { text: "ไม่ต้องถามแล้วค่ะ บอกมาเลย" },
    { text: "ขอเลื่อนไปเรียนรอบหน้าได้ไหมคะ ลูกไม่สบาย" },
    { text: "โอนแล้วส่งสลิปตรงนี้ได้เลยไหมคะ", customer: stranger({ known_context_at: 1, ai_enabled: 1, deal_status: "awaiting_payment" }) },
    { text: "ออกใบกำกับภาษีได้ไหมคะ", intent: "document_presale" },
    // ลูกค้าบอกว่าถูกถามมากไปเมื่อสองเทิร์นก่อน — ยังไม่ถามจนกว่าเขาจะถามกลับเอง (salesMotion)
    { text: "แล้ว Workshop ทำอะไรบ้างคะ", history: [...DISCOVERY, user("ถามเยอะจัง บอกมาเลยดีกว่าค่ะ"), bot("ได้เลยค่ะ คลาสนี้เหมาะกับงานของคุณลูกค้าค่ะ")] },
  ];
  for (const args of cases) {
    const on = rulesFor({ ...args, closingQuestion: true });
    const off = rulesFor({ ...args, closingQuestion: false });
    assert.equal(on, off, `ต้องเหมือนเดิมทุกไบต์: ${args.text}`);
    assert.ok(!on.includes(ON), args.text);
  }
});

test("เทิร์นแจ้งราคาที่ลูกค้ายังไม่เห็นข้อมูลคลาส: ท่อนคำถามในบรรทัดข้าง quote ถูกสลับ แต่ข้างราคาไม่เปลี่ยน", () => {
  const args = { text: "คลาสนี้ราคาเท่าไหร่คะ", history: [user("ทำร้านกาแฟค่ะ")], customer: stranger({ known_context_at: 1 }) };
  const on = withPriceDirectiveCapture(() => rulesFor({ ...args, closingQuestion: true }));
  const off = withPriceDirectiveCapture(() => rulesFor({ ...args, closingQuestion: false }));
  assert.ok(on.text.includes(QUESTION_ENDING.quote.on), "เทิร์นแจ้งราคาต้องได้ท่อนปิดด้วยคำถามนำ");
  assert.ok(off.text.includes(QUESTION_ENDING.quote.off));
  const sides = (captured) => captured.directives.map((item) => item.side).join(",");
  assert.equal(sides(on), sides(off), "ข้างของคำสั่งเรื่องราคาต้องเหมือนเดิมทุกบรรทัด");
});

test("ด่านกันคำสั่งสวนกัน: เปิดสวิตช์แล้วทุกฉากยังไม่มีบรรทัดเงินไร้ข้าง และไม่มีสองข้างชนกัน", () => {
  for (const args of [
    { text: "คลาสนี้เรียนอะไรบ้างคะ" },
    { text: "คลาสนี้ราคาเท่าไหร่คะ", history: [user("ทำร้านกาแฟค่ะ")] },
    { text: "ราคาเท่าไหร่คะ", history: [], customer: stranger() },
    { text: "แพงไปนิดนึงค่ะ ลดได้ไหม" },
    { text: "อยากให้ไปอบรมพนักงานที่บริษัท 20 คนค่ะ" },
    { text: "ครับ" },
  ]) {
    const captured = withPriceDirectiveCapture(() => rulesFor({ ...args, closingQuestion: true }));
    const { bySide, unclassified } = classifyPriceDirectives(captured);
    assert.deepEqual(unclassified, [], `บรรทัดพูดเรื่องเงินโดยไม่มีข้าง: ${args.text}`);
    assert.ok(!(bySide.defer.length && bySide.quote.length), `คำสั่งราคาสองข้างชนกัน: ${args.text}`);
    assert.ok(!(bySide.promo.length && bySide.no_promo.length), `คำสั่งโปรฯ สองข้างชนกัน: ${args.text}`);
    // ถ้ามีคำสั่ง "ห้ามถามกลับ" ต้องไม่มีคำสั่ง "ปิดท้ายด้วยคำถาม" ในพรอมต์ก้อนเดียวกัน
    if (/ห้ามถามกลับในเทิร์นนี้/u.test(captured.text)) assert.ok(!captured.text.includes(ON), args.text);
  }
});

/* ------------------------------- ไปป์ไลน์จริง (stub) ------------------------------- */

function world({ mode = null } = {}) {
  const db = memoryDb();
  if (mode) db.setSetting(REPLY_CLOSING_QUESTION_KEY, mode);
  const hermesFetch = hermesFetchStub("รับทราบค่ะ อยากใช้ AI กับงานแบบไหนคะ?");
  const app = createApp({
    config: testConfig({ HISTORY_TURNS: "12" }), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  let seq = 0;
  const send = async (customerId, text) => {
    db.upsertCustomer(customerId, {});
    db.insertMessage({ id: `in:cq-${customerId}-${seq += 1}`, customerId, direction: "in", msgType: "text", content: text });
    await app.pipeline.handleInboundText({ customerId, text, replyToken: "rt" });
  };
  const prompts = () => hermesFetch.calls
    .filter((call) => Array.isArray(call.body?.messages))
    .map((call) => JSON.stringify(call.body.messages));
  return { db, send, prompts };
}
const esc = (value) => JSON.stringify(value).slice(1, -1);
const swapBack = (prompt) => Object.values(QUESTION_ENDING).reduce((text, pair) => text.split(esc(pair.on)).join(esc(pair.off)), prompt);

test("ไปป์ไลน์: ไม่มีแถวในตั้งค่า = เปิด · off = พรอมต์เดิม · ต่างกันเฉพาะท่อนคำถาม · เทิร์นปิดบทสนทนาเหมือนเดิมทุกไบต์", async () => {
  const on = world();
  const off = world({ mode: "off" });
  const turns = ["สนใจคลาส AI Agent for Business ค่ะ", "ทำร้านกาแฟค่ะ", "รอบหน้าเรียนวันไหนคะ", "ขอบคุณมากค่ะ", "ขอคิดดูก่อนนะคะ", "ไว้ว่าง ๆ จะทักมาใหม่นะคะ"];
  try {
    for (const text of turns) {
      await on.send("U-cq-pipe", text);
      await off.send("U-cq-pipe", text);
    }
    const a = on.prompts();
    const b = off.prompts();
    assert.equal(a.length, turns.length, "ทุกเทิร์นต้องถึงโมเดล");
    assert.equal(b.length, turns.length);
    for (const [index, prompt] of a.entries()) assert.equal(swapBack(prompt), b[index], `เทิร์น ${turns[index]}`);
    assert.ok(a[0].includes(esc(ON)), "เทิร์นปกติ (ไม่มีแถว) ต้องได้คำถามปิดท้าย");
    assert.ok(!b[0].includes(esc(ON)) && b[0].includes(esc(OFF)), "off = ถ้อยคำเดิม");
    for (const index of [3, 4, 5]) assert.equal(a[index], b[index], `เทิร์นปิดบทสนทนาต้องเหมือนเดิมทุกไบต์: ${turns[index]}`);
  } finally { on.db.close(); off.db.close(); }
});

test("ไปป์ไลน์: อ่านสวิตช์พัง = ถ้อยคำเดิม (ไม่ล้มทั้งเทิร์น)", async () => {
  const w = world();
  const getSetting = w.db.getSetting.bind(w.db);
  w.db.getSetting = (key) => {
    if (key === REPLY_CLOSING_QUESTION_KEY) throw new Error("settings read failed");
    return getSetting(key);
  };
  try {
    await w.send("U-cq-broken", "รอบหน้าเรียนวันไหนคะ");
    const [prompt] = w.prompts();
    assert.ok(prompt, "ต้องถึงโมเดล");
    assert.ok(prompt.includes(esc(OFF)) && !prompt.includes(esc(ON)));
  } finally { w.db.close(); }
});
