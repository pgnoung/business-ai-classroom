// coaching-brake.test.mjs — เบรกการสอนยาวแล้วพาไปขาย (คำสั่งพี่ง้วง 2026-09-28)
//
// สิ่งที่ด่านนี้ล็อก:
//   1. ตัวจับ: คำขอความรู้/วิธีทำ/ไอเดียหารายได้/คุยเล่น = เบรก · คำถามเรื่องคลาส/เงิน/รอบ/ทีมงาน = ไม่แตะ
//   2. ระดับไต่ตามรอบที่วนสอน (1 → 2 → 3) และหยุดนับทันทีที่ลูกค้าคุยเรื่องเรา/คนจริงเข้ามา
//   3. เทิร์นที่มีเจ้าของอยู่แล้ว (ส่งไม้ต่อ งาน project ขอบคุณ ปุ่ม ห้องที่มีเงิน) ห้ามมีเสียงที่สอง
//   4. ถ้อยคำไม่มีคำเรื่องเงินเลยสักบรรทัด และไม่สั่งสวนกับด่านกันคำสั่งสวนกันเดิม
//   5. ปิดสวิตช์ หรือเทิร์นที่ไม่ใช่การขอเรียนฟรี = พรอมต์ที่ส่งถึงโมเดลเหมือนเดิมทุกไบต์
// ข้อความลูกค้าทุกบรรทัดในไฟล์นี้เป็นประโยคสังเคราะห์ ไม่ได้คัดลอกจากแชทจริง
import test from "node:test";
import assert from "node:assert/strict";
import {
  aboutOurOffer, assessCoachingTurn, COACHING_BRAKE_MODE_KEY, coachingBrakeDirective, coachingBrakeMode,
  coachingBrakeRule, freeHelpStreak, isFreeHelpAsk, isTeachingReply, TEACHING_REPLY_MIN_CHARS,
} from "../src/coachingBrake.mjs";
import { baseRules } from "../src/pipeline.mjs";
import {
  classifyPriceDirectives, ordersBannedPhrases, PRICE_MENTION, withPriceDirectiveCapture,
} from "../src/priceDirectives.mjs";
import { createApp } from "../src/server.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const user = (content) => ({ role: "user", content });
const bot = (content) => ({ role: "assistant", content });

// คำตอบสอนยาวแบบที่เกิดจริง (สังเคราะห์): ยาวเกินเกณฑ์ และไม่มีสะพานกลับหาคลาสเลย
const LONG_TEACHING = "ลองวางคำสั่งเป็นขั้นแบบนี้ค่ะ\n"
  + "🔹 บอกบทบาทของ AI ให้ชัดว่าเป็นผู้ช่วยด้านไหน\n".repeat(6)
  + "🔹 ระบุกลุ่มคนอ่าน น้ำเสียง และความยาวที่ต้องการทุกครั้ง\n".repeat(6)
  + "ถ้ายังไม่ตรง ให้บอกว่าตรงไหนยังไม่ใช่และอยากได้แบบไหนแทนนะคะ";
// คำตอบสั้นที่มีสะพานสู่คลาสแล้ว (พฤติกรรมที่ต้องการหลังเบรก)
const SHORT_BRIDGED = "หลักคือบอกบทบาทและผลลัพธ์ที่ต้องการให้ชัดค่ะ เรื่องนี้พี่ง้วงพาทำจริงในคลาส AI Agent for Business นะคะ\nอยากใช้กับงานแบบไหนคะ?";

/* ------------------------------- ตัวจับ ------------------------------- */

test("ขอความรู้/วิธีทำ/ไอเดีย/คุยเล่น = คำขอเรียนฟรี", () => {
  for (const text of [
    "ChatGPT กับ Claude ต่างกันยังไง อันไหนดีกว่าคะ",
    "สอนเขียน prompt ทำรูปสินค้าให้สวยหน่อยค่ะ",
    "สอนเขียน prompt ให้ได้รูปสินค้าสวย ๆ แบบมืออาชีพหน่อยค่ะ",
    "ช่วยสอนวิธีตั้งค่า GPT ของตัวเองหน่อยครับ",
    "อยากหารายได้เสริมจาก AI ต้องเริ่มยังไงดีคะ",
    "อยากมีรายได้เสริมค่ะ",
    "วันนี้ทานข้าวหรือยังคะ",
    "ใช้ AI แล้วเจนรูปไม่ได้ตามที่คิดเลย",
    "ขอตัวอย่างแคปชั่นขายครีมหน่อยค่ะ",
    "AI Agent คืออะไรครับ",
  ]) {
    assert.equal(isFreeHelpAsk(text), true, text);
    assert.equal(aboutOurOffer(text), false, text);
  }
});

test("คุยเรื่องคลาส เงิน รอบเรียน สถานที่ หรือทีมงาน = เทิร์นของกติกาเดิม ไม่ใช่คำขอเรียนฟรี", () => {
  for (const text of [
    "คลาสนี้สอนอะไรบ้างคะ",
    "มีสอนเรื่องการเขียน prompt ไหมคะ",
    "มี สอนวิธีใช้ ChatGPT ไหมคะ",
    "สอนเขียน prompt ได้ไหมคะ",
    "ราคาเท่าไหร่คะ",
    "ค่าเรียนแพงไหมครับ",
    "เรียนที่ไหนครับ มีที่จอดรถไหม",
    "รอบหน้าเรียนวันไหนคะ",
    "ขอคุยกับทีมงานหน่อยครับ",
    "สนใจ in-house ให้พนักงานครับ",
    "มันคืออะไรคะ",
    "ขอรายละเอียดหน่อยค่ะ",
  ]) {
    assert.equal(aboutOurOffer(text), true, text);
    assert.equal(isFreeHelpAsk(text), false, text);
  }
});

test("คำตอบรับ/ขอบคุณ/ลิงก์ล้วน ไม่ใช่คำขอเรียนฟรี (ลิงก์ที่มี ?si= ไม่นับเป็นคำถาม)", () => {
  for (const text of ["ครับ", "ค่ะ", "โอเคค่ะ", "ขอบคุณค่ะ", "https://youtu.be/abc?si=xyz", "   "]) {
    assert.equal(isFreeHelpAsk(text), false, JSON.stringify(text));
  }
});

test("คำตอบสอนยาว = ยาวถึงเกณฑ์และไม่มีสะพานกลับหาคลาส", () => {
  assert.ok([...LONG_TEACHING].length >= TEACHING_REPLY_MIN_CHARS);
  assert.equal(isTeachingReply(LONG_TEACHING), true);
  assert.equal(isTeachingReply(`${LONG_TEACHING}\nเรื่องนี้พี่ง้วงพาทำจริงในคลาสค่ะ`), false, "มีสะพานสู่คลาสแล้ว = ขั้นตอนขาย");
  assert.equal(isTeachingReply(SHORT_BRIDGED), false);
  assert.equal(isTeachingReply("สั้น ๆ ค่ะ"), false);
});

test("นับรอบวนสอน: ไต่ตามรอบ หยุดเมื่อคุยเรื่องเรา และหยุดเมื่อทีมงานคนจริงเข้ามา", () => {
  const loop = [user("ช่วยสอนเขียน prompt หน่อยค่ะ"), bot(LONG_TEACHING), user("แล้วถ้าจะทำรูปโปรโมตต้องสั่งยังไงคะ"), bot(LONG_TEACHING)];
  assert.equal(freeHelpStreak([]), 0);
  assert.equal(freeHelpStreak(loop.slice(0, 2)), 1);
  assert.equal(freeHelpStreak(loop), 2);
  assert.equal(freeHelpStreak([...loop, user("คลาสนี้เรียนวันไหนคะ"), bot("รอบใกล้สุดวันเสาร์ค่ะ")]), 0, "คุยเรื่องคลาส = รีเซ็ต");
  assert.equal(freeHelpStreak([...loop.slice(0, 2), user("ขอสอนต่ออีกนิดค่ะ"), bot("[แอดมินทีมงานพิมพ์เอง] เดี๋ยวแอดมินช่วยดูให้ค่ะ")]), 0, "ทีมงานคนจริงตอบ = ไม่นับ");
  assert.equal(freeHelpStreak([user("ทำร้านอาหารค่ะ"), bot(SHORT_BRIDGED)]), 0, "เล่าโจทย์แล้วเราตอบสั้นพร้อมสะพาน = ขั้นตอนขาย ไม่ใช่วงสอน");
  // ประวัติที่จบด้วยข้อความลูกค้าที่ยังไม่ได้ตอบ = หยุดนับทันที (ไม่พึ่งผู้เรียกให้ตัดแถวท้าย)
  assert.equal(freeHelpStreak([...loop, user("อีกข้อค่ะ ช่วยหน่อย")]), 0, "รอบท้ายที่เรายังไม่ตอบ = ไม่นับ และไม่เดาต่อ");
});

test("ระดับ 1 → 2 → 3 ตามรอบที่ลูกค้าขอเรียนฟรีติดกัน", () => {
  const first = assessCoachingTurn({ text: "ChatGPT กับ Claude ต่างกันยังไงคะ", history: [] });
  assert.deepEqual([first.level, first.reason], [1, "free_help_ask"]);
  const second = assessCoachingTurn({ text: "แล้ว Gemini ล่ะคะ ใช้ยังไง", history: [user("ChatGPT กับ Claude ต่างกันยังไงคะ"), bot(SHORT_BRIDGED)] });
  assert.deepEqual([second.level, second.reason], [2, "free_help_loop"]);
  const third = assessCoachingTurn({
    text: "ขอตัวอย่าง prompt อีกอันได้ไหมคะ",
    history: [user("ChatGPT กับ Claude ต่างกันยังไงคะ"), bot(SHORT_BRIDGED), user("แล้ว Gemini ล่ะคะ ใช้ยังไง"), bot(SHORT_BRIDGED)],
  });
  assert.equal(third.level, 3);
  const capped = assessCoachingTurn({
    text: "ขออีกอันค่ะ ช่วยหน่อย",
    history: [user("สอนหน่อย"), bot(LONG_TEACHING), user("อีกนิดค่ะ ช่วยหน่อย"), bot(LONG_TEACHING), user("ขอเพิ่มอีกหน่อย"), bot(LONG_TEACHING)],
  });
  assert.equal(capped.level, 3, "เพดานระดับ 3");
});

test("ประโยคบอกเล่าในวงสอน: นับต่อเมื่อรอบก่อนเราสอนยาว · ถ้ารอบก่อนเราตอบสั้นพร้อมสะพาน = ขั้นค้นหาโจทย์ปกติ", () => {
  const afterTeaching = assessCoachingTurn({
    text: "ลงเฟซบุ๊กกับติ๊กต็อกค่ะ",
    history: [user("อยากทำคอนเทนต์ให้คนติดตาม ทำยังไงดีคะ"), bot(LONG_TEACHING)],
  });
  assert.deepEqual([afterTeaching.level, afterTeaching.reason], [2, "teaching_loop_statement"]);
  const afterBridge = assessCoachingTurn({
    text: "ทำร้านเบเกอรี่ค่ะ",
    history: [user("AI ช่วยทำคอนเทนต์ได้ไหมคะ"), bot(SHORT_BRIDGED)],
  });
  assert.equal(afterBridge.level, 0, "ตอบคำถามเรื่องความเหมาะของเรา = ขั้นตอนขาย ห้ามเบรก");
  const discovery = assessCoachingTurn({ text: "ทำงานบัญชีค่ะ", history: [bot("อยากนำ AI ไปช่วยงานอะไรเป็นอย่างแรกคะ?")] });
  assert.equal(discovery.level, 0, "เล่าโจทย์ตอบคำถามเรา = ไม่ใช่คำขอเรียนฟรี");
});

test("ตอบรับข้อเสนอ 'ทำให้เพิ่ม' ในวงสอน = ยังนับเป็นวงสอน · ตอบรับข้อเสนอทั่วไป = ไม่แตะ", () => {
  const history = [user("ช่วยวางแผนทำคอนเทนต์หน่อยค่ะ"), bot(`${LONG_TEACHING}\nอยากให้ลูกแพรวางแผน 30 วันให้ไหมคะ?`)];
  const accepted = assessCoachingTurn({ text: "ได้เลยค่ะ", history, continuation: { action: "continue_previous_offer" } });
  assert.deepEqual([accepted.level, accepted.reason], [2, "accepted_free_help_offer"]);
  const plainAck = assessCoachingTurn({ text: "ได้เลยค่ะ", history: [bot("อยากดู outline ไหมคะ?")], continuation: { action: "continue_previous_offer" } });
  assert.equal(plainAck.level, 0);
  assert.equal(assessCoachingTurn({ text: "ค่ะ", history }).level, 0, "รับทราบเฉย ๆ ไม่ใช่การขอเพิ่ม");
});

test("ปิดเรื่อง/ขอบคุณ/ขอไปลองก่อน หลังวงสอน = ของกติกาดูแลเดิม ไม่เบรกซ้อน (เว้นแต่ถามคำถามใหม่มาด้วย)", () => {
  const history = [user("สอนเขียน prompt หน่อยค่ะ"), bot(LONG_TEACHING)];
  for (const text of ["ขอบคุณสำหรับคำแนะนำค่ะ", "ขอบคุณค่ะ ขอไปลองก่อนนะคะ", "เดี๋ยวจะลองทำตามดูก่อนนะคะ", "โอเคค่ะ เข้าใจแล้ว", "ไว้ว่าง ๆ จะมาทักใหม่นะคะ"]) {
    const result = assessCoachingTurn({ text, history });
    assert.deepEqual([result.level, result.reason], [0, "closing_statement"], text);
  }
  assert.equal(isFreeHelpAsk("ขอบคุณสำหรับคำแนะนำค่ะ"), false, "คำนาม 'คำแนะนำ' ไม่ใช่การขอให้แนะนำ");
  assert.equal(assessCoachingTurn({ text: "ขอบคุณค่ะ แล้ว Gemini ใช้ยังไงคะ", history }).level, 2, "ขอบคุณแล้วถามต่อ = ยังเป็นวงสอน");
});

test("เทิร์นที่มีเจ้าของอยู่แล้ว ห้ามมีเสียงที่สอง", () => {
  const text = "อยากหารายได้เสริมจาก AI ต้องเริ่มยังไงคะ";
  assert.equal(assessCoachingTurn({ text }).level, 1, "ตัวอย่างนี้ต้องเบรกได้ถ้าไม่มีเจ้าของ");
  for (const [extra, reason] of [
    [{ closingTurn: true }, "closing_turn"],
    [{ careMode: "pause" }, "care_mode"],
    [{ projectOpportunity: "in_house_training" }, "project_opportunity"],
    [{ presetButton: { fromPresetButton: true } }, "preset_button"],
    [{ presetButton: { fromPresetButton: true, typedAlongside: false } }, "preset_button"],
    [{ paymentSeen: true }, "payment_seen"],
    [{ intent: "document_presale" }, "document_presale"],
  ]) {
    const result = assessCoachingTurn({ text, ...extra });
    assert.deepEqual([result.level, result.reason], [0, reason], reason);
  }
  assert.equal(assessCoachingTurn({ text: "ChatGPT ต่างจาก Claude ยังไง แล้วคลาสราคาเท่าไหร่คะ" }).reason, "about_our_offer", "ถามเงินมาด้วย = จังหวะราคาเป็นเจ้าของ");
  // กดปุ่มแล้วพิมพ์คำถามเองมาด้วย = ตัดสินจากข้อความจริง (แบบเดียวกับ detectHandoffHint ในไปป์ไลน์)
  assert.equal(assessCoachingTurn({ text, presetButton: { fromPresetButton: true, typedAlongside: true } }).level, 1);
});

/* ------------------------------- ถ้อยคำ ------------------------------- */

const ALL_LEVELS = [1, 2, 3].map((level) => coachingBrakeRule({ level }));
// คำสั่งสวนทางที่ด่านกันคำสั่งสวนกันแบนไว้ (ห้ามกลับมาด้วยถ้อยคำไหน)
const COUNTER_ORDERS = ["ห้ามปิดท้ายด้วยคำถามใด ๆ", "ห้ามสำรวจโจทย์เพิ่ม", "ห้ามเสนอเส้นทาง/ขั้นถัดไป", "ไม่ต้องสำรวจโจทย์เพิ่ม", "ไม่ต้องเสนอเส้นทาง"];

test("ระดับ 0 = ไม่มีคำสั่งเลย (สตริงว่าง)", () => {
  assert.equal(coachingBrakeRule({ level: 0 }), "");
  assert.equal(coachingBrakeRule(null), "");
});

test("ถ้อยคำทุกระดับไม่มีคำเรื่องเงิน ไม่สั่งวลีต้องห้าม และไม่สั่งสวนทาง", () => {
  for (const [index, rule] of ALL_LEVELS.entries()) {
    for (const line of rule.split("\n")) {
      assert.equal(PRICE_MENTION.test(line), false, `ระดับ ${index + 1} มีคำเรื่องเงิน: ${line}`);
      assert.deepEqual(ordersBannedPhrases(line), [], `ระดับ ${index + 1} สั่งวลีต้องห้าม: ${line}`);
    }
    for (const phrase of COUNTER_ORDERS) assert.ok(!rule.includes(phrase), `ระดับ ${index + 1} มีคำสั่งสวนทาง "${phrase}"`);
  }
});

test("ถ้อยคำมีทางออกให้โมเดล มีสะพานสู่คลาส มีงบความยาว และคุมน้ำเสียง high-end", () => {
  for (const [index, rule] of ALL_LEVELS.entries()) {
    const level = index + 1;
    assert.match(rule, new RegExp(`ระดับ ${level}/3`, "u"));
    assert.match(rule, /ให้ข้ามกติกาชุดนี้ทั้งหมดแล้วตอบตามปกติ/u, "ต้องมีทางออกเมื่อจริง ๆ แล้วเป็นคำถามเรื่องคลาส");
    assert.match(rule, /คลาส/u, "ต้องพาไปหาคลาส");
    assert.match(rule, /ห้ามขึ้นต้นด้วยการปฏิเสธ/u);
    assert.match(rule, /ไม่เสนอทำชิ้นต่อไปให้อีก/u, "ข้อเสนอทำให้เพิ่มคือกลไกที่ทำให้วนสอน");
    assert.match(rule, /บับเบิล/u);
    // คำสั่งพี่ง้วง 13 ก.ย.: ลงท้ายด้วยคำถามเบา ๆ หนึ่งข้อ (เทิร์นขอบคุณ/ปิดเรื่องไม่ผ่านตัวเบรกเลย)
    assert.match(rule, /คำถามเบา ๆ หนึ่งข้อ/u, `ระดับ ${level} ต้องสั่งให้ปิดด้วยคำถามเบา ๆ หนึ่งข้อ`);
    // บรรทัดเลื่อนจังหวะราคา (13 ก.ย.) สั่ง "ห้ามเสนอคลาสเกินกว่าที่เขาถาม" + "ถามเฉพาะเมื่อจำเป็น" แทบทุกเทิร์น —
    // ต้องประกาศลำดับตรง ๆ ไม่ปล่อยให้พรอมต์ก้อนเดียวสั่งสองทาง
    assert.match(rule, /ชุดนี้มาก่อนข้อที่ให้ตอบแค่เท่าที่ถามโดยไม่เสนอคลาส และข้อที่ให้ถามเฉพาะเมื่อขาดข้อมูลจำเป็น \(ถ้ามี\)/u);
  }
  assert.match(ALL_LEVELS[0], /ประมาณ 350–450 ตัวอักษร ไม่เกิน 3 บับเบิลสั้น ๆ/u);
  assert.match(ALL_LEVELS[1], /ประมาณ 300–400 ตัวอักษร ไม่เกิน 3 บับเบิลสั้น ๆ/u);
  assert.match(ALL_LEVELS[2], /ประมาณ 200–300 ตัวอักษร ไม่เกิน 2 บับเบิล/u);
  // กติกา 15 ก.ย. "ยังไม่รู้เป้าหมาย อย่าฟันธงคลาสจาก Stage" ต้องไม่ปิดสะพาน: บอกว่าสอนอยู่ในคลาสไหน ≠ ฟันธงให้เรียน
  assert.match(ALL_LEVELS[0], /ไม่ใช่การฟันธงว่าเขาต้องเรียนคลาสนั้น จึงทำได้แม้ยังไม่รู้เป้าหมายของเขา/u);
  assert.match(ALL_LEVELS[1], /คลาสออนไลน์ฟรีตามคลังความรู้ \(ถ้ามี — ใช้ลิงก์ตามคลังเท่านั้น ห้ามแต่งเอง\)/u);
  assert.match(ALL_LEVELS[2], /ไม่สอน ไม่อธิบายต่อ/u);
});

test("ประกอบกับ baseRules แล้วด่านกันคำสั่งสวนกันยังเขียว: ไม่มีบรรทัดเงินไร้ข้าง ไม่มีสองข้างชนกัน", () => {
  const stranger = { line_user_id: "U-brake", known_name: "", last_score: null, price_deferred_at: 0, price_quoted_at: 0, known_context_at: 0, price_pivot_deferred_at: 0 };
  for (const [currentText, history] of [
    ["ChatGPT กับ Claude ต่างกันยังไงคะ", []],
    ["อยากหารายได้เสริมจาก AI ค่ะ", [bot("อยากนำ AI ไปช่วยงานอะไรเป็นอย่างแรกคะ?")]],
    ["ขอตัวอย่าง prompt อีกอันได้ไหมคะ", [user("สอนหน่อยค่ะ"), bot(LONG_TEACHING), user("อีกนิดค่ะ ช่วยหน่อย"), bot(LONG_TEACHING)]],
  ]) {
    const assessment = assessCoachingTurn({ text: currentText, history });
    assert.ok(assessment.level >= 1, currentText);
    const captured = withPriceDirectiveCapture(() => `${baseRules("general", [], { customer: stranger, currentText, history })}\n${coachingBrakeRule(assessment)}`);
    const { bySide, unclassified } = classifyPriceDirectives(captured);
    assert.deepEqual(unclassified, [], `บรรทัดพูดเรื่องเงินโดยไม่มีข้าง: ${currentText}`);
    assert.ok(!(bySide.defer.length && bySide.quote.length), `คำสั่งราคาสองข้างชนกัน: ${currentText}`);
    assert.ok(!(bySide.promo.length && bySide.no_promo.length), `คำสั่งโปรฯ สองข้างชนกัน: ${currentText}`);
    // ด่านราคาไม่เห็นคำสั่ง "เสนอคลาส vs ห้ามเสนอคลาส" (ไม่มีคำเรื่องเงิน) — ล็อกลำดับที่ประกาศไว้แทน
    // (withPriceDirectiveCapture คืน { text, directives } — ต้องอ่าน .text)
    assert.match(captured.text, /ห้ามเสนอคลาส/u, "บรรทัด 'ห้ามเสนอคลาส…' ของ 13 ก.ย. หายไปจากฉากคนแปลกหน้า — ถ้าตั้งใจแก้/ถอด ให้ทบทวน PRECEDENCE ใน coachingBrake.mjs แล้วแก้เทสต์นี้ตาม");
    assert.match(captured.text, /ลำดับในเทิร์นนี้: ชุดนี้มาก่อนข้อที่ให้ตอบแค่เท่าที่ถามโดยไม่เสนอคลาส/u, currentText);
  }
});

test("ตอบรับข้อเสนอ 'ทำให้เพิ่ม' + กติกาต่อข้อเสนอเดิม: พรอมต์ก้อนเดียวบอกขอบเขตชัด ไม่สั่งสองทาง", () => {
  const stranger = { line_user_id: "U-brake-offer", known_name: "", last_score: null, price_deferred_at: 0, price_quoted_at: 0, known_context_at: 0, price_pivot_deferred_at: 0 };
  const history = [user("อยากทำช่อง TikTok เรื่องอาหาร ช่วยแนะนำแนวทางหน่อยค่ะ"), bot(`${LONG_TEACHING}\nอยากให้ลูกแพรวางตาราง 30 วันให้ไหมคะ?`)];
  const continuation = { isShortAck: true, action: "continue_previous_offer", offerText: "อยากให้ลูกแพรวางตาราง 30 วันให้ไหมคะ?", offerHasMoney: false };
  const assessment = assessCoachingTurn({ text: "ได้ค่ะ", history, continuation });
  assert.deepEqual([assessment.level, assessment.reason], [2, "accepted_free_help_offer"]);
  const captured = withPriceDirectiveCapture(() => `${baseRules("general", [], { customer: stranger, currentText: "ได้ค่ะ", continuation, history })}\n${coachingBrakeRule(assessment)}`);
  assert.match(captured.text, /ทำสิ่งนั้นต่อทันที/u, "กติกาต่อข้อเสนอเดิมยังอยู่ (ไม่ได้ถูกถอด)");
  assert.match(captured.text, /ขอบเขตของการ "ทำสิ่งนั้นต่อทันที" ในเทิร์นนี้ และเป็นข้อยกเว้นเดียวของข้อห้ามสอนหรือทำงานให้ในชุดนี้/u);
  const { bySide, unclassified } = classifyPriceDirectives(captured);
  assert.deepEqual(unclassified, []);
  assert.ok(!(bySide.defer.length && bySide.quote.length));
});

/* ------------------------------- สวิตช์ ------------------------------- */

test("สวิตช์: ไม่มีค่า = on · off = ปิด (ไม่สนตัวพิมพ์/ช่องว่าง) · อ่านพัง = off", () => {
  const dbWith = (value) => ({ getSetting: (key) => (key === COACHING_BRAKE_MODE_KEY ? value : null) });
  assert.equal(coachingBrakeMode(dbWith(null)), "on");
  assert.equal(coachingBrakeMode(dbWith("on")), "on");
  assert.equal(coachingBrakeMode(dbWith(" OFF ")), "off");
  assert.equal(coachingBrakeMode(dbWith("off")), "off");
  assert.equal(coachingBrakeMode(dbWith("maybe")), "on", "ค่าอื่นไม่ปิด — ปิดได้ด้วย off เท่านั้น");
  assert.equal(coachingBrakeMode({ getSetting() { throw new Error("db down"); } }), "off");
});

test("จุดเรียกของไปป์ไลน์: ปิด = ว่าง · เปิด = คำสั่ง · ตัวประเมินพัง = ว่างพร้อมเตือน ไม่โยน error", () => {
  const warnings = [];
  const infos = [];
  const logger = { info: (m) => infos.push(m), warn: (m) => warnings.push(m) };
  const on = { getSetting: () => null };
  const off = { getSetting: () => "off" };
  const text = "สอนเขียน prompt หน่อยค่ะ";
  assert.equal(coachingBrakeDirective({ db: off, text, logger }), "");
  const directive = coachingBrakeDirective({ db: on, text, logger, customerId: "U-x" });
  assert.match(directive, /ระดับ 1\/3/u);
  assert.match(infos.at(-1), /coaching brake level=1 reason=free_help_ask customer=U-x/u);
  assert.equal(coachingBrakeDirective({ db: on, text: "ราคาเท่าไหร่คะ", logger }), "");
  const poisonedText = { toString() { throw new Error("broken text"); } };
  assert.equal(coachingBrakeDirective({ db: on, text: poisonedText, logger }), "");
  assert.match(warnings.at(-1), /coaching brake ประเมินไม่สำเร็จ/u);
});

/* --------------------------- ไปป์ไลน์จริง (stub) --------------------------- */

function world({ mode = null } = {}) {
  const db = memoryDb();
  if (mode) db.setSetting(COACHING_BRAKE_MODE_KEY, mode);
  const hermesFetch = hermesFetchStub("รับทราบค่ะ เรื่องนี้พี่ง้วงพาทำในคลาสนะคะ อยากใช้กับงานแบบไหนคะ?");
  const app = createApp({
    config: testConfig({ HISTORY_TURNS: "12" }), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  let seq = 0;
  // เว็บฮุกบันทึกข้อความขาเข้าก่อนถึงไปป์ไลน์เสมอ — เทสต์ต้องทำแบบเดียวกัน ไม่งั้นประวัติไม่มีฝั่งลูกค้า
  const send = async (customerId, text) => {
    db.upsertCustomer(customerId, {});
    db.insertMessage({ id: `in:brake-${customerId}-${seq += 1}`, customerId, direction: "in", msgType: "text", content: text });
    await app.pipeline.handleInboundText({ customerId, text, replyToken: "rt" });
  };
  const prompts = () => hermesFetch.calls
    .filter((call) => Array.isArray(call.body?.messages))
    .map((call) => JSON.stringify(call.body.messages));
  return { db, send, prompts };
}

test("ไปป์ไลน์: เทิร์นขอเรียนฟรีได้คำสั่งเบรก และไต่ระดับตามรอบที่ลูกค้าขอติดกัน", async () => {
  const w = world();
  try {
    await w.send("U-brake-loop", "ChatGPT กับ Claude ต่างกันยังไงคะ");
    await w.send("U-brake-loop", "แล้ว Gemini ใช้ยังไงคะ");
    await w.send("U-brake-loop", "ขอตัวอย่าง prompt อีกอันได้ไหมคะ");
    const prompts = w.prompts().slice(-3);
    assert.equal(prompts.length, 3);
    assert.match(prompts[0], /จังหวะเบรกการสอนยาว \(ระดับ 1\/3\)/u);
    assert.match(prompts[1], /จังหวะเบรกการสอนยาว \(ระดับ 2\/3\)/u);
    assert.match(prompts[2], /จังหวะเบรกการสอนยาว \(ระดับ 3\/3\)/u);
    // พรอมต์จริงที่มีคำสั่ง "ห้ามเสนอคลาส…" จากกติกาอื่น ต้องมีบรรทัดลำดับของตัวเบรกเสมอ
    for (const prompt of prompts) {
      if (/ห้ามเสนอคลาส/u.test(prompt)) assert.match(prompt, /ลำดับในเทิร์นนี้: ชุดนี้มาก่อน/u);
    }
  } finally { w.db.close(); }
});

// เทิร์นที่ไม่ใช่การขอเรียนฟรีต้องได้พรอมต์เดียวกันทุกไบต์ ไม่ว่าสวิตช์จะเปิดหรือปิด —
// คำตอบของโมเดลเป็น stub คงที่ ประวัติของสองโลกจึงเหมือนกันทุกเทิร์น
const NON_COACHING_TURNS = [
  "สนใจคลาส AI Agent for Business ค่ะ",
  "คลาสนี้สอนอะไรบ้างคะ",
  "ราคาเท่าไหร่คะ",
  "รอบไหนยังว่างบ้างคะ",
  "ทำงานบัญชีค่ะ",
  "ครับ",
  "ขอบคุณค่ะ",
];

test("ไปป์ไลน์: เทิร์นที่ไม่ใช่การขอเรียนฟรี = พรอมต์เหมือนเดิมทุกไบต์ทั้งเปิดและปิดสวิตช์", async () => {
  const on = world();
  const off = world({ mode: "off" });
  try {
    for (const text of NON_COACHING_TURNS) {
      await on.send("U-brake-same", text);
      await off.send("U-brake-same", text);
    }
    const a = on.prompts();
    const b = off.prompts();
    assert.equal(a.length, NON_COACHING_TURNS.length, "ทุกเทิร์นต้องถึงโมเดล ไม่งั้นด่านนี้วัดของน้อยกว่าที่คิด");
    assert.deepEqual(a, b);
    for (const prompt of a) assert.doesNotMatch(prompt, /จังหวะเบรกการสอนยาว/u);
  } finally { on.db.close(); off.db.close(); }
});

test("ไปป์ไลน์: ปิดสวิตช์แล้วเทิร์นขอเรียนฟรีไม่มีคำสั่งเบรกเลย · เปิดแล้วต่างกันเฉพาะบล็อกเบรก", async () => {
  const on = world({ mode: "on" });
  const off = world({ mode: "off" });
  try {
    const text = "อยากหารายได้เสริมจาก AI ต้องเริ่มยังไงดีคะ";
    await on.send("U-brake-switch", text);
    await off.send("U-brake-switch", text);
    const [withBrake] = on.prompts();
    const [withoutBrake] = off.prompts();
    assert.doesNotMatch(withoutBrake, /จังหวะเบรกการสอนยาว/u);
    const block = JSON.stringify(`\n${coachingBrakeRule({ level: 1 })}`).slice(1, -1);
    assert.equal(withBrake.split(block).length, 2, "บล็อกเบรกต้องมีครั้งเดียว");
    assert.equal(withBrake.replace(block, ""), withoutBrake, "ถอดบล็อกเบรกออกแล้วต้องได้พรอมต์เดิมทุกไบต์");
  } finally { on.db.close(); off.db.close(); }
});

test("ไปป์ไลน์: คำรับสั้นจริงหลังคำตอบสอนยาวที่ค้างข้อเสนอ = resolver จริงต่อข้อเสนอ + เบรกกำหนดขอบเขตในพรอมต์เดียวกัน", async () => {
  const w = world();
  try {
    const id = "U-brake-offer-e2e";
    w.db.upsertCustomer(id, {});
    w.db.insertMessage({ id: "in:brake-offer-seed", customerId: id, direction: "in", msgType: "text", content: "อยากทำช่อง TikTok เรื่องอาหาร ช่วยแนะนำแนวทางหน่อยค่ะ" });
    w.db.insertMessage({ id: "out:brake-offer-seed", customerId: id, direction: "out", msgType: "text", agentMode: "ai", content: `${LONG_TEACHING}\nอยากให้ลูกแพรวางตาราง 30 วันให้ไหมคะ?` });
    await w.send(id, "ได้ค่ะ");
    const prompt = w.prompts().find((item) => /จังหวะเบรกการสอนยาว/u.test(item));
    assert.ok(prompt, "คำรับสั้นหลังวงสอนที่ค้างข้อเสนอต้องโดนเบรก");
    assert.match(prompt, /จังหวะเบรกการสอนยาว \(ระดับ 2\/3\)/u);
    assert.match(prompt, /ลูกค้าเพิ่งตอบรับข้อเสนอล่าสุดของเรา/u, "resolver จริงต้องอ่านเป็นการตอบรับข้อเสนอ");
    assert.match(prompt, /ขอบเขตของการ \\"ทำสิ่งนั้นต่อทันที\\" ในเทิร์นนี้/u, "ต้องบอกขอบเขตในพรอมต์เดียวกัน");
  } finally { w.db.close(); }
});

test("ไปป์ไลน์: ห้องที่มีเงินแล้ว (ผู้เรียน) ถามวิธีใช้ = ไม่เบรก ช่วยเต็มที่ตามเดิม", async () => {
  const w = world();
  try {
    w.db.upsertCustomer("U-brake-paid", {});
    w.db.markMoneySeen("U-brake-paid");
    await w.send("U-brake-paid", "ต้องตั้งค่า GPT ยังไงก่อนวันเรียนคะ ช่วยแนะนำหน่อย");
    const [prompt] = w.prompts();
    assert.ok(prompt, "ต้องถึงโมเดล");
    assert.doesNotMatch(prompt, /จังหวะเบรกการสอนยาว/u);
  } finally { w.db.close(); }
});
