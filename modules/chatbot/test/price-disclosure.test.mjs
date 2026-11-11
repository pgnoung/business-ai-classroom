// price-disclosure.test.mjs — พฤติกรรมจริงของจังหวะราคา (คู่กับด่านกันคำสั่งสวนกัน)
//
// ด่านคำสั่งสวนกันพิสูจน์ว่าพรอมต์ "พูดข้างเดียว" ไฟล์นี้พิสูจน์ว่าข้างที่พูดนั้น "ถูกข้าง"
// ตามนโยบายที่พี่ง้วงเคาะ และพิสูจน์ว่าสถานะของห้อง (คัดกรองแล้ว / ได้ราคาแล้ว / รู้จักเขาแล้ว)
// อยู่รอดข้ามหน้าต่างประวัติจริง โดยไม่แขวนอยู่กับสำนวนที่โมเดลเลือกเขียน
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { baseRules } from "../src/pipeline.mjs";
import {
  buildConversationStyleRules, buildWarmthRules, hasQuestionFatigue,
  QUESTION_FATIGUE_BLUNT, QUESTION_FATIGUE_POLITE,
} from "../src/conversationStyle.mjs";
import { buildSalesMotionRules, detectAiLevel, hasRecentFatigue } from "../src/salesMotion.mjs";
import {
  approvedClassAmounts,
  asksAboutMoney,
  decidePriceDisclosure,
  hasDeferredPriceBefore,
  knowsSomethingAboutCustomer,
  outboundCarriesClassPrice,
  priceAlreadyDelivered,
  priceAlreadyStated,
  shouldRecordOnlinePivotDeferral,
  shouldRecordPriceDeferral,
} from "../src/priceDisclosure.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, promptText, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

const stranger = (extra = {}) => ({
  line_user_id: "U-x", known_name: "", last_score: null,
  price_deferred_at: 0, price_quoted_at: 0, known_context_at: 0, price_pivot_deferred_at: 0, ...extra,
});
// สัญญาณมีโครงสร้างจาก scorer ที่มาแทน regex "เล่างานตัวเอง / ตอบบันได / บอกจำนวนคน"
// (scorer เป็นโมเดลที่อ่านบทสนทนาทั้งก้อน จึงเก่งกว่า regex ทุกตัวและรันอยู่ทุกเทิร์นแล้ว)
const SCORED = { painPoint: "งานเอกสารกินเวลาทีมทั้งวัน", personaType: "unknown" };
const rulesFor = (args) => baseRules("pricing", args.flags || [], { customer: stranger(), history: [], ...args });
// ตารางราคาจริงของคลาสรวม — ใช้ชุดเดียวกับตัวกันราคา (multipliableAmounts)
const AMOUNTS = approvedClassAmounts([
  { label: "AI Agent for Business", amount: 19900 },
  { label: "Early Bird", amount: 12900 },
  { label: "ส่วนลดนักเรียนเก่า", amount: 5000 },
]);

/* ---------------- นโยบายข้อ 1: คัดกรองครั้งเดียว ด้วยกรอบประโยชน์ของผู้เรียน ---------------- */

test("คนแปลกหน้าถามราคาครั้งแรก = คัดกรองหนึ่งข้อ ด้วยกรอบ 'ประโยชน์ของผู้เรียน'", () => {
  const rules = rulesFor({ currentText: "ราคาเท่าไหร่คะ" });
  assert.match(rules, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "กรอบเหตุผลต้องเป็นประโยชน์ของผู้เรียน");
  assert.match(rules, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u);
  assert.match(rules, /ห้ามถามมากกว่าหนึ่งข้อเด็ดขาด/u, "คัดกรองได้ข้อเดียวเท่านั้น");
  assert.match(rules, /เรื่องราคาบอกได้เลยค่ะ/u, "ต้องรับรู้คำถามเขาก่อน ห้ามเงียบแล้วย้อนถาม");
});

test("ถ้อยคำกั๊กราคาต้องถูกห้ามชัด ๆ ในเทิร์นคัดกรอง", () => {
  const rules = rulesFor({ currentText: "ราคาเท่าไหร่คะ" });
  for (const banned of ["ขอเช็กก่อน", "รอทีมงาน", "ยังบอกไม่ได้"]) {
    assert.ok(rules.includes(banned), `ต้องระบุถ้อยคำต้องห้าม "${banned}" ให้โมเดลเห็นตรง ๆ`);
  }
  assert.match(rules, /ถ้อยคำต้องห้ามในเทิร์นนี้/u);
  assert.match(rules, /ไม่ใช่กำลังปฏิเสธที่จะบอกราคา/u);
});

/* ---------------- นโยบายข้อ 2: ครั้งที่สอง ห้ามเลี่ยงอีกเด็ดขาด ---------------- */

test("ถามซ้ำครั้งที่สอง = แจ้งราคาทันที ห้ามเลี่ยงอีกเด็ดขาด", () => {
  const rules = rulesFor({
    customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
    currentText: "ราคาเท่าไหร่คะ",
  });
  assert.match(rules, /แจ้งราคาในเทิร์นนี้ทันที ห้ามเลี่ยงอีกเด็ดขาด/u);
  assert.match(rules, /ตอบราคาที่อนุมัติแล้วอย่างมั่นใจ/u);
  assert.doesNotMatch(rules, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u, "ห้ามคัดกรองซ้ำรอบสอง");
  assert.doesNotMatch(rules, /ยังไม่ถึงจังหวะราคา/u);
});

test("เทิร์นที่ลูกค้าตอบคำถามคัดกรองกลับมา (ไม่มีคำเรื่องเงินเลย) ต้องได้ราคา ไม่ใช่คัดกรองซ้ำ", () => {
  const rules = rulesFor({
    customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
    currentText: "ทำสำนักงานบัญชีครับ",
    history: [
      { role: "user", content: "ราคาเท่าไหร่ครับ" },
      { role: "assistant", content: "เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ" },
    ],
  });
  assert.match(rules, /คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ/u);
  assert.doesNotMatch(rules, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u, "ห้ามตกกลับไปกฎห้ามใส่ราคา");
  assert.doesNotMatch(rules, /ยังไม่ถึงจังหวะราคา/u);
  assert.doesNotMatch(rules, /ได้ประโยชน์สูงสุดต่อผู้เรียน จึงขออนุญาตสอบถาม/u, "ห้ามสั่งคัดกรองซ้ำ");
});

// ---- ตรวจปรปักษ์ 2026-09-04 (ข้อ 3/7/12/14): "ยังติดค้างราคาเขาอยู่" เคยผูกกับวลีเดียว
// ที่พรอมต์แค่ "ยกเป็นตัวอย่าง" แล้วร่างยังผ่าน humanizer อีกชั้นก่อนถูกบันทึก
// ถ้าโมเดลเรียบเรียงใหม่ (ซึ่งเป็นเรื่องปกติ) สถานะติดค้างหายทั้งก้อน แล้วลูกค้าที่ถูกคัดกรอง
// ไปแล้วจะไม่ได้ราคาเลยสักครั้ง — สถานะต้องมาจากคอลัมน์ ไม่ใช่จากตัวหนังสือของเราเอง
test("ติดค้างราคา: อ่านจากหมุดถาวร ไม่ใช่จากวลีตัวอย่างในคำตอบของเราเอง", () => {
  const paraphrased = [
    { role: "user", content: "ราคาเท่าไหร่ครับ" },
    // คำตอบคัดกรองที่โมเดล/humanizer เรียบเรียงเอง — ไม่มีวลีตัวอย่างหลงเหลือเลย
    { role: "assistant", content: "เรื่องราคาบอกได้เลยค่ะ ขออนุญาตถามสั้น ๆ ข้อเดียวก่อนนะคะว่าอยากใช้ AI กับงานส่วนไหนคะ" },
  ];
  const decision = decidePriceDisclosure({
    text: "ทำสำนักงานบัญชีครับ",
    history: paraphrased,
    customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
    approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote");
  assert.equal(decision.owed, true, "หมุด price_deferred_at + ยังไม่เคยมี price_quoted_at = ติดค้างอยู่");
  assert.equal(decision.reason, "quote_deferral_owed");

  const rules = rulesFor({
    customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
    currentText: "ทำสำนักงานบัญชีครับ",
    history: paraphrased,
    approvedAmounts: AMOUNTS,
  });
  assert.match(rules, /คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ/u, "คำสั่งเดียวที่บังคับให้มีตัวเลขต้องยังยิงอยู่");
});

test("ราคาถึงมือเขาแล้ว = เลิกติดค้าง (อ่านจากคอลัมน์ price_quoted_at)", () => {
  const decision = decidePriceDisclosure({
    text: "แล้วเรียนวันไหนคะ",
    history: [],
    customer: stranger({ price_deferred_at: 1_700_000_000_000, price_quoted_at: 1_700_000_100_000 }),
    approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote");
  assert.equal(decision.owed, false, "แจ้งราคาไปแล้ว ห้ามสั่ง 'คำตอบนี้ต้องมีราคา' ไปตลอดกาล");
  assert.equal(decision.reason, "quote_already_deferred");
  assert.equal(priceAlreadyDelivered({ customer: { price_quoted_at: 5 } }), true);
});

test("ราคาออกไปแล้วในห้องนี้ = เลิกคุมจังหวะ (เคสจริง: หลังคัดกรองแล้วบอกราคาไปแล้ว)", () => {
  const decision = decidePriceDisclosure({
    text: "ผ่อนได้ไหมคะ",
    history: [{ role: "assistant", content: "คลาสนี้ ปกติ 19,900 บาท/ท่าน ค่ะ" }],
    score: null,
    approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote");
  assert.equal(decision.reason, "quote_price_already_stated");
});

// ---- ตรวจปรปักษ์ 2026-09-04 (ข้อ 13): ตัวอ่าน "เคยแจ้งราคาไปแล้ว" เคยจับเลขหลักพัน
// ที่มีลูกน้ำ *ตัวไหนก็ได้* — social proof / จำนวนที่นั่ง / ค่าธรรมเนียมจิปาถะ ถูกนับหมด
// แล้วลัดวงจรการคัดกรองทิ้งทั้งชุด
test("เลขที่ไม่ใช่ราคาคลาสห้ามถูกนับว่า 'เราแจ้งราคาไปแล้ว'", () => {
  const noise = [
    "พี่ง้วงสอนมาแล้วกว่า 5,000 คนค่ะ",
    "รอบนี้รับ 20 ที่นั่ง เหลืออีก 3 ที่ค่ะ",
    "ค่าจอดรถชั่วโมงละ 40 บาทค่ะ",
    "คลาสเริ่ม 9,000 น. ถึง 17,000 น. ค่ะ",
  ];
  for (const content of noise) {
    assert.equal(
      priceAlreadyStated([{ role: "assistant", content }], AMOUNTS), false,
      `"${content}" ไม่ใช่การแจ้งราคาคลาส`,
    );
  }
  assert.equal(priceAlreadyStated([{ role: "assistant", content: "ปกติ 19,900 บาท/ท่านค่ะ" }], AMOUNTS), true);
  // แถวส่วนลด (5,000) ไม่ใช่ราคาต่อหัว — multipliableAmounts ตัดทิ้งให้แล้ว
  assert.equal(AMOUNTS.has(5000), false, "แถวส่วนลดห้ามถูกนับเป็นราคาต่อหัว");

  // ผลลัพธ์ปลายทาง: คนแปลกหน้าที่เพิ่งได้ยิน social proof ยังต้องถูกคัดกรองตามนโยบายข้อ 1
  const decision = decidePriceDisclosure({
    text: "ราคาเท่าไหร่คะ",
    history: [{ role: "assistant", content: "พี่ง้วงสอนมาแล้วกว่า 5,000 คนค่ะ" }],
    customer: stranger(),
    approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.reason, "defer_cold_stranger_screening");
});

// "ไม่รู้ตารางราคาเลย" ต่างจาก "รู้แล้วว่าว่าง" โดยเจตนา — ผู้เรียกที่ไม่มีตารางอยู่ในมือ
// ต้องล้มไปทาง quote ตามกติกาหัวไฟล์ ไม่ใช่พาห้องที่เคยได้ราคาไปแล้วกลับไปคัดกรองใหม่
// (เคสจริงในคลังเทสต์: บอทตอบ "15,900 บาทค่ะ" ไปแล้ว ลูกค้าถามต่อว่า "มีโปรไหม")
test("ไม่มีตารางราคาส่งมา = ยังต้องรู้ว่า 'เคยแจ้งราคาไปแล้ว' แล้วล้มไปทาง quote", () => {
  const history = [{ role: "assistant", content: "15,900 บาทค่ะ อยากให้สรุปภาพระบบให้ดูไหมคะ?" }];
  assert.equal(priceAlreadyStated(history), true, "ไม่มีตาราง = ใช้รูปทรงของเลขเงินแทน (ล้มไปทาง quote)");
  assert.equal(priceAlreadyStated(history, AMOUNTS), false, "มีตารางแล้ว = จับคู่เป๊ะ 15,900 ไม่อยู่ในตารางชุดนี้");
  const decision = decidePriceDisclosure({ text: "มีโปรไหม", history, score: 0, customer: stranger() });
  assert.equal(decision.mode, "quote", "คนที่เพิ่งได้ตัวเลขไป ห้ามถูกลากกลับไปคัดกรอง");
});

/* ---------------- ลูกค้าที่บอกว่าถูกถามมากไป ---------------- */

// "ขอคำตอบตรง ๆ" ย้ายไปอยู่ชั้นสุภาพแล้ว (ตรวจปรปักษ์ 2026-09-04 รอบที่หก) — ดูเทสต์
// "สองชั้นความหงุดหงิดต้องไม่กินสมาชิกของกันและกัน" ข้างล่าง
test("ลูกค้าบอกว่าถูกถามมากไปแล้วถามราคา = ได้ตัวเลขเสมอ ห้ามคัดกรอง", () => {
  for (const text of ["ไม่ต้องถามแล้ว ราคาเท่าไหร่", "ถามเยอะจัง ค่าเรียนกี่บาท", "ตอบตรง ๆ เลยครับ ราคาเท่าไหร่"]) {
    const decision = decidePriceDisclosure({ text, history: [], score: null });
    assert.equal(decision.mode, "quote", `"${text}" ต้องได้ราคา`);
    const rules = rulesFor({ currentText: text });
    assert.doesNotMatch(rules, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u);
  }
  // ความหงุดหงิดต้องจำข้ามเทิร์นด้วย ไม่ใช่จำแค่ข้อความล่าสุด
  const carried = decidePriceDisclosure({
    text: "ราคาเท่าไหร่",
    history: [{ role: "user", content: "ไม่ต้องถามแล้วครับ" }, { role: "assistant", content: "ได้ค่ะ" }],
    score: null,
  });
  assert.equal(carried.mode, "quote");
});

test("ติดค้างราคา + บอกว่าถูกถามมากไปในเทิร์นเดียวกัน: บรรทัดบังคับราคาต้องไม่หายไปกับชื่อ reason", () => {
  const customer = stranger({ price_deferred_at: 1_700_000_000_000 });
  const decision = decidePriceDisclosure({ text: "ไม่ต้องถามแล้วครับ", history: [], customer, approvedAmounts: AMOUNTS });
  assert.equal(decision.reason, "quote_question_fatigue");
  assert.equal(decision.owed, true, "reason เป็นเรื่องความหงุดหงิด แต่สถานะติดค้างยังจริงอยู่");
  const rules = buildWarmthRules({ text: "ไม่ต้องถามแล้วครับ", history: [], customer, approvedAmounts: AMOUNTS }).join("\n");
  assert.match(rules, /คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ/u);
});

/* ---------------- "เรารู้จักเขาแล้ว" หมายถึงอะไรบ้าง ---------------- */

// 2026-09-04 (Mandate 2): ตัวอ่าน "เรารู้จักเขาแล้ว" เคยเป็น regex ภาษาไทยเขียนมือหกตัว
// (named_class / answered_ladder / told_headcount / told_project_context / told_us_their_work)
// แล้วการตรวจปรปักษ์เจาะได้ทุกรอบ รอบละตัว — ยืนยันแล้วสามรอบติด:
//   · detectAiLevel นับ "ขอถามข้อมูลคลาสหน่อยค่ะ ราคาเท่าไหร่คะ" เป็นการตอบบันไดระดับ AI
//     (คำว่า "ถามข้อมูล" อยู่ในถ้อยคำตัวเลือกระดับ 2) = คนแปลกหน้าได้ราคาตั้งแต่ข้อความแรก
//   · DESCRIBES_OWN_WORK จับ "อยากใช้ AI / อยากได้ระบบ / ปัญหาคือ / ติดปัญหา" ซึ่งเป็น
//     ประโยคเปิดมาตรฐานของลีด AI ทุกคน และไม่ได้บอกอะไรเกี่ยวกับตัวเขาเลย
// ทั้งชุดถูกลบ แล้วแทนด้วยสัญญาณที่มีโครงสร้างอยู่แล้ว
test("รอยรั่วที่ทำให้ regex ทั้งชุดถูกลบ: ประโยคเปิดธรรมดาต้องไม่ใช่ 'เรารู้จักเขาแล้ว'", () => {
  const leaks = [
    // เคยติด detectAiLevel ระดับ 2 ผ่านคำว่า "ถามข้อมูล"
    "ขอถามข้อมูลคลาสหน่อยค่ะ ราคาเท่าไหร่คะ",
    // เคยติด DESCRIBES_OWN_WORK ทั้งสี่ประโยค ทั้งที่ไม่ได้บอกอะไรเกี่ยวกับตัวเขา
    "อยากใช้ AI ครับ ราคาเท่าไหร่",
    "อยากได้ระบบครับ ค่าเรียนเท่าไหร่",
    "ปัญหาคือตอบลูกค้าไม่ทันครับ ราคาเท่าไหร่",
    "ติดปัญหาเรื่องคอนเทนต์ครับ ราคาเท่าไหร่",
    // เคยติด named_class ทั้งที่การเอ่ยชื่อสินค้าไม่ได้บอกอะไรเกี่ยวกับตัวเขา
    "สนใจ AI Agent for Business ค่ะ ราคาเท่าไหร่",
    // เคยติด told_project_context
    // ("ทีมมี 6 คนครับ ราคาเท่าไหร่" ย้ายออกจากรายการนี้แล้ว — ดูเทสต์ผลคัดกรองด้านล่าง:
    //  ตอนนี้ไปป์ไลน์ประกาศ "จำนวนผู้เรียน = 6 ท่าน" ลงพรอมต์ก้อนเดียวกันอยู่แล้ว
    //  การถามคัดกรองซ้ำในพรอมต์ที่เพิ่งประกาศเลขนั้นเอง คือพรอมต์สวนกับตัวเอง)
    "อยากจัดอบรมพนักงาน ราคาเท่าไหร่",
  ];
  for (const text of leaks) {
    assert.equal(knowsSomethingAboutCustomer({ customer: stranger() }), null);
    // ห้ามให้พรอมต์ประกาศ "ระดับการใช้ AI" ที่อ่านมาจากประโยคเปิดสุภาพด้วย — บอทจะข้าม
    // คำถามคัดกรองของตัวเองเพราะเชื่อว่ารู้คำตอบแล้ว (ตัวอ่านระดับเคยจับคำว่า "ถามข้อมูล")
    if (text.includes("ถามข้อมูล")) {
      assert.equal(detectAiLevel(text), null, `"${text}" ไม่ใช่การตอบบันไดระดับ AI`);
    }
    const decision = decidePriceDisclosure({ text, history: [], customer: stranger(), approvedAmounts: AMOUNTS });
    assert.equal(
      decision.reason, "defer_cold_stranger_screening",
      `"${text}" คือคนแปลกหน้าล้วน ๆ ต้องได้คำถามคัดกรองหนึ่งข้อก่อน ไม่ใช่ราคาเต็มชุด`,
    );
  }
});

test("สัญญาณ 'รู้จักเขาแล้ว' ที่เหลืออยู่ ล้วนเป็นสัญญาณมีโครงสร้าง", () => {
  const cases = [
    ["known_name", { knownName: "สมศักดิ์" }],
    ["known_name", { customer: { known_name: "สมศักดิ์" } }],
    ["known_context", { customer: { known_context_at: 1_700_000_000_000 } }],
    ["scored_pain_point", { scoreSignals: SCORED }],
    ["scored_persona", { scoreSignals: { painPoint: "", personaType: "owner_operator" } }],
  ];
  for (const [expected, args] of cases) {
    assert.equal(knowsSomethingAboutCustomer(args), expected, `${expected} ต้องอ่านออก`);
  }
  // persona_type = "unknown" คือค่าที่ parseScorePayload ใส่ให้เมื่อโมเดลแต่งหมวดใหม่เอง
  assert.equal(knowsSomethingAboutCustomer({ scoreSignals: { painPoint: "", personaType: "unknown" } }), null);
  assert.equal(knowsSomethingAboutCustomer({ scoreSignals: null }), null);
  assert.equal(knowsSomethingAboutCustomer({}), null);
});

// 2026-09-04 (ตรวจปรปักษ์รอบที่แปด): ผลคัดกรองที่ไปป์ไลน์ "พิมพ์ลงพรอมต์อยู่แล้วทุกเทิร์น"
// ไม่เคยถูกนับเป็นการรู้จักลูกค้า — พรอมต์ก้อนเดียวจึงประกาศ "ระดับการใช้ AI = 2" พร้อมกับ
// บรรทัด "คนนี้ถามเรื่องราคาเป็นเรื่องแรกโดยที่เรายังไม่รู้จักเขาเลย" แล้วสั่งถามคำถามคัดกรอง
// ที่เขาเพิ่งตอบไปแล้ว — คนละคลาสกับ regex ชุดที่ถูกลบ เพราะนี่คือค่าที่พรอมต์ยืนยันไปแล้ว
test("ตอบบันไดคัดกรองของเราแล้ว = รู้จักเขาแล้ว ห้ามคัดกรองซ้ำ", () => {
  // ตอบเป็น keycap ตามที่คำถามคัดกรองส่งไปให้เลือก (ทรงที่ลูกค้าตอบจริงบ่อยที่สุด)
  const ladder = decidePriceDisclosure({
    text: "ราคาเท่าไหร่คะ",
    history: [{ role: "assistant", content: "ขอถามระดับการใช้ AI ค่ะ" }, { role: "user", content: "2\uFE0F\u20E3" }],
    customer: stranger(), approvedAmounts: AMOUNTS,
  });
  assert.equal(ladder.mode, "quote");
  assert.equal(ladder.reason, "quote_answered_ai_level");

  // และพรอมต์ต้องไม่ประกาศระดับที่อ่านได้ พร้อมกับถามคำถามคัดกรองในก้อนเดียวกัน
  const rules = rulesFor({
    currentText: "ราคาเท่าไหร่คะ",
    history: [{ role: "assistant", content: "ขอถามระดับการใช้ AI ค่ะ" }, { role: "user", content: "2\uFE0F\u20E3" }],
    approvedAmounts: AMOUNTS,
  });
  assert.match(rules, /ระดับการใช้ AI = 2/u, "บรรทัดผลคัดกรองยังต้องอยู่ (โมเดลต้องใช้เลือกคลาส)");
  assert.doesNotMatch(rules, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "คนที่ตอบบันไดแล้วห้ามถูกคัดกรองซ้ำ");
});

test("บอกจำนวนผู้เรียนมาแล้ว = รู้จักเขาแล้ว และพรอมต์ต้องไม่ประกาศเลขพร้อมถามซ้ำ", () => {
  const decision = decidePriceDisclosure({
    text: "ทีมมี 6 คนครับ ราคาเท่าไหร่", history: [], customer: stranger(), approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote");
  assert.equal(decision.reason, "quote_told_learner_count");
  // แกนโปรฯ ยังปิดตามกติกาพี่ง้วง (งานตั้งแต่ 4 ท่านขึ้นไป ทีมผู้ดูแลออกใบเสนอราคาเสมอ)
  assert.equal(decision.withPromo, false, "แจ้งราคาได้ แต่ห้ามยกตารางโปรฯ ของคลาสรวม");
  const rules = rulesFor({ currentText: "ทีมมี 6 คนครับ ราคาเท่าไหร่", approvedAmounts: AMOUNTS });
  assert.match(rules, /จำนวนผู้เรียน = 6 ท่าน/u);
  assert.doesNotMatch(rules, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "พรอมต์ที่เพิ่งประกาศเลข ห้ามถามคัดกรองซ้ำในก้อนเดียวกัน");
});

test("ผลคัดกรองที่แกนโปรฯ ใช้ ต้องเป็นเลขตัวเดียวกับที่พรอมต์พิมพ์ให้โมเดลอ่าน", () => {
  // ฉากดักบั๊ก: เลขอยู่ในประวัติ ไม่ได้อยู่ในเทิร์นปัจจุบัน — ถ้าแกนโปรฯ หดหน้าต่างฝ่ายเดียว
  // พรอมต์ก้อนเดียวจะแบก "อย่าฝืนขายคลาสรวม ให้ประเมิน Private/In-house" คู่กับแม่แบบ
  // "PROMOTION Early Bird 📌" ของคลาสรวม
  const history = [{ role: "user", content: "ทีมมี 6 คนครับ" }, { role: "assistant", content: "รับทราบค่ะ" }];
  const decision = decidePriceDisclosure({
    text: "ราคาเท่าไหร่ครับ", history, score: 6, customer: stranger({ last_score: 6 }), approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.withPromo, false);
  const rules = rulesFor({ currentText: "ราคาเท่าไหร่ครับ", history, customer: stranger({ last_score: 6 }), approvedAmounts: AMOUNTS });
  assert.match(rules, /จำนวนผู้เรียน = 6 ท่าน/u, "บรรทัดผลคัดกรองอ่านเลขจากประวัติ");
  assert.ok(!rules.includes("PROMOTION Early Bird 📌"), "แกนโปรฯ ต้องอ่านเลขตัวเดียวกัน ไม่ใช่หน้าต่างของตัวเอง");

  // ลูกค้าแก้ตัวเองว่ามาคนเดียว = เลขล่าสุดชนะ ทั้งบรรทัดผลคัดกรองและแกนโปรฯ พร้อมกัน
  const corrected = [...history, { role: "user", content: "ขอโทษค่ะ มาคนเดียว 1 คนค่ะ" }, { role: "assistant", content: "ค่ะ" }];
  const after = decidePriceDisclosure({
    text: "ราคาเท่าไหร่ครับ", history: corrected, score: 6, customer: stranger({ last_score: 6 }), approvedAmounts: AMOUNTS,
  });
  assert.equal(after.withPromo, true, "ของเดิมเลข 6 ในหน้าต่างตัดโปรฯ ทิ้งถาวร แม้ลูกค้าจะแก้แล้ว");
});

test("scorer อ่านโจทย์ออกแล้ว = ห้ามคัดกรองซ้ำ", () => {
  const decision = decidePriceDisclosure({
    text: "ราคาเท่าไหร่ครับ", history: [], customer: stranger(), scoreSignals: SCORED, approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote");
  assert.equal(decision.reason, "quote_scored_pain_point");
  const rules = rulesFor({ currentText: "ราคาเท่าไหร่ครับ", history: [], scoreSignals: SCORED });
  assert.match(rules, /ตอบราคาที่อนุมัติแล้วอย่างมั่นใจ/u);
  assert.doesNotMatch(rules, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "คนที่ scorer อ่านโจทย์ออกแล้วห้ามถูกคัดกรอง");
});

/* ---------------- ตัวอ่านคำถามเรื่องเงิน ---------------- */

test("คำเรื่องเงินที่ตัวอ่านเดิมมองไม่เห็น ต้องนับเป็นคำถามเรื่องเงิน", () => {
  for (const text of [
    "ค่าใช้จ่ายประมาณไหนคะ", "ผ่อนได้ไหม", "มัดจำเท่าไร", "ชำระยังไงคะ",
    "มีโปรโมชั่นไหม", "งบประมาณเท่าไหร่ดีคะ", "ขอใบเสนอราคา ราคาเท่าไหร่",
  ]) {
    assert.equal(asksAboutMoney(text), true, `"${text}" ต้องนับเป็นคำถามเรื่องเงิน`);
  }
});

// ---- ตรวจปรปักษ์ 2026-09-04 (ข้อ 4): ของเดิม "ตัดวลีทิ้งแล้วอ่านส่วนที่เหลือ" ซึ่งกลับหัว
// ทั้งสองเคสที่ตั้งใจแก้ — ใบเสนอราคาที่ลูกค้าขอจากเราหายไป ส่วนโจทย์ธุรกิจของเขากลับติด
test("ขอใบเสนอราคาจากเรา = ถามเรื่องเงิน · ราคาของธุรกิจลูกค้าเอง = veto ทั้งข้อความ", () => {
  for (const text of ["ขอใบเสนอราคาหน่อยค่ะ", "รบกวนขอใบเสนอราคาด้วยครับ", "ขอดูใบเสนอราคาก่อนได้ไหมคะ"]) {
    assert.equal(asksAboutMoney(text), true, `"${text}" คือคำขอที่ส่งถึงเรา = คำถามเรื่องเงินเต็มตัว`);
  }
  // ตรวจปรปักษ์ 2026-09-04 (Mandate 2): veto ทั้งข้อความกลืนคำถามจริงเมื่อมีคำเรื่องราคา
  // ของธุรกิจลูกค้าปนอยู่ในประโยคเดียวกัน ผลคือการเลี่ยงไม่ถูกบันทึก แล้วลูกค้าคนนั้น
  // โดนคัดกรองรอบสองในเทิร์นถัดไป — กติกาใหม่: ถามค่าเรียนของเราตรง ๆ ชนะเสมอ
  for (const text of [
    "ค่าเรียนเท่าไหร่คะ พอดีจะทำใบเสนอราคาส่งเจ้านาย",
    "ราคาเท่าไหร่ครับ ผมจะได้ตั้งราคาขายของผมด้วย",
  ]) {
    assert.equal(asksAboutMoney(text), true, `"${text}" มีคำถามค่าเรียนของเราอยู่เต็ม ๆ`);
  }
  // และคู่ตรงข้าม: "ส่ง" เดี่ยว ๆ ถูกตัดออกจากตัวจับคำขอใบเสนอราคาแล้ว
  for (const text of [
    "ผมต้องส่งใบเสนอราคาให้ลูกค้าทุกวันครับ",
    "งานผมคือส่งใบเสนอราคาให้ลูกค้า อยากให้ AI ช่วย",
  ]) {
    assert.equal(asksAboutMoney(text), false, `"${text}" คือภาระงานของเขา ไม่ใช่การขอใบเสนอราคาจากเรา`);
  }
  for (const text of [
    "เอกสาร ทำใบเสนอราคา ครับ", "ตั้งราคาสินค้ายังไงดี", "ผมทำธุรกิจ อยากให้ AI ช่วยคิดราคาให้ลูกค้า",
    // เคสที่ของเดิมพลาด: ตัด "คิดราคา" ทิ้งแล้ว "เท่าไหร่" ค้างอยู่ = อ่านเป็นการถามค่าเรียน
    "อยากให้ AI ช่วยคิดราคาให้ลูกค้า ตั้งเท่าไหร่ถึงจะเหมาะครับ",
    "ที่ร้านผมตั้งราคาขายเองไม่เป็นเลยครับ ควรกี่บาทดี",
    "อยากเอา ai มาช่วยลดงานเอกสารครับ", "ช่วยลดขั้นตอนการทำงานได้ไหมครับ", "AI ช่วยลดต้นทุนได้เยอะเลยใช่ไหม",
  ]) {
    assert.equal(asksAboutMoney(text), false, `"${text}" ไม่ใช่การถามค่าเรียน`);
  }
});

/* ---------------- จังหวะ pivot สอนสด -> ออนไลน์: ลำดับและจุดจบ ---------------- */

const LIVE_LINE = [
  { role: "assistant", content: "โปรโมชั่น Early Bird 12,900 บาท/ท่าน" },
  { role: "user", content: "จองที่นั่งยังไงคะ" },
];

// ตรวจปรปักษ์ 2026-09-04 (Mandate 3): สาขา pivot เคยถูกตรวจ *ก่อน* ความหงุดหงิด
// "ไม่ต้องถามแล้ว ขอราคาคลาสออนไลน์เลยค่ะ" จึงได้คำถามกลับไปอีกหนึ่งข้อ ผิดนโยบายข้อ 4
// และพรอมต์ก้อนเดียวกันสั่งทั้ง "ปิดท้ายด้วยคำถามเดียว" กับ "ห้ามถามกลับในเทิร์นนี้"
test("นโยบายข้อ 4 ชนะจังหวะ pivot: ถูกถามมากไปแล้วขอราคาออนไลน์ ต้องได้ตัวเลข", () => {
  const decision = decidePriceDisclosure({
    text: "ไม่ต้องถามแล้ว ขอราคาคลาสออนไลน์เลยค่ะ",
    history: LIVE_LINE, score: 6, customer: stranger({ last_score: 6 }), approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote", "คนที่บอกว่าถูกถามมากไปต้องได้ตัวเลขเสมอ");
  assert.equal(decision.reason, "quote_question_fatigue");
  assert.equal(decision.onlinePivot, true, "ธงกัน downgrade ต้องยังเดินทางไปกับคำตัดสิน");

  const rules = buildWarmthRules({
    text: "ไม่ต้องถามแล้ว ขอราคาคลาสออนไลน์เลยค่ะ", history: LIVE_LINE, score: 6,
    customer: stranger({ last_score: 6 }), priceDisclosure: decision,
  }).join("\n");
  assert.match(rules, /แจ้งราคาคลาสสอนสดก่อนเป็นหลัก/u, "กัน downgrade ต้องยังอยู่ครบ แต่ต้องมีตัวเลข");
  assert.doesNotMatch(rules, /ยังไม่ต้องใส่ตัวเลขราคาออนไลน์เดี่ยวในเทิร์นนี้/u);
  assert.doesNotMatch(rules, /หรือคลาสออนไลน์ดีคะ/u, "ห้ามยิงคำถามใส่คนที่เพิ่งบอกว่าถูกถามมากไป");
});

// การเลี่ยงด้วยคำถาม "สอนสดหรือออนไลน์ดีคะ" เคยไม่มีจุดจบเลย — ห้องเดียวกันถูกเลี่ยง
// ด้วยคำถามเดิมได้ไม่จำกัดจำนวนครั้ง แม้ลูกค้าจะตอบคำถามนั้นไปแล้ว
test("การเลี่ยงด้วย pivot มีโควตาครั้งเดียว — ครั้งที่สองต้องแจ้งราคา", () => {
  const first = decidePriceDisclosure({
    text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history: LIVE_LINE, score: 6,
    customer: stranger({ last_score: 6 }), approvedAmounts: AMOUNTS,
  });
  assert.equal(first.mode, "defer");
  assert.equal(first.reason, "defer_online_pivot");
  assert.equal(shouldRecordOnlinePivotDeferral(first), true, "เทิร์นนี้ต้องถูกบันทึกว่าเราเลี่ยงไปแล้ว");

  const second = decidePriceDisclosure({
    text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history: LIVE_LINE, score: 6,
    customer: stranger({ last_score: 6, price_pivot_deferred_at: 1_700_000_000_000 }),
    approvedAmounts: AMOUNTS,
  });
  assert.equal(second.mode, "quote", "เลี่ยงไปแล้วหนึ่งครั้ง = ห้ามเลี่ยงอีก");
  assert.equal(second.reason, "quote_online_pivot_asked_again");
  assert.equal(second.onlinePivot, true, "แต่การกัน downgrade ต้องยังอยู่");
  assert.equal(shouldRecordOnlinePivotDeferral(second), false, "เทิร์นที่แจ้งราคาห้ามปักหมุดซ้ำ");
});

// ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า, ข้อ 4): hasDeferredPriceBefore อ่านแต่หมุดคัดกรอง
// ห้องที่ถูกเลี่ยงด้วยคำถาม "สอนสดหรือออนไลน์ดีคะ" แล้วกลับมาถามราคาแบบไม่ pivot
// จึงตกลงสาขาคัดกรอง = ถูกเลี่ยง "รอบที่สอง" ซึ่งคือความล้มเหลวที่พี่ง้วงชี้ชื่อไว้ตรง ๆ
test("หมุด pivot ก็คือการเลี่ยงราคา — ห้องที่ถูกเลี่ยงด้วย pivot ห้ามถูกคัดกรองซ้ำอีกรอบ", () => {
  const customer = stranger({ price_pivot_deferred_at: 1_700_000_000_000 });
  assert.equal(hasDeferredPriceBefore({ customer }), true, "การเลี่ยงคือการเลี่ยง ไม่ว่าจะเลี่ยงด้วยวิธีไหน");

  // เทิร์นถัดไปไม่มีคำว่า "ออนไลน์" จึงไม่เดินเข้าสาขา pivot เลย — ของเดิมตกสาขาคัดกรอง
  const decision = decidePriceDisclosure({
    text: "แล้วราคาเท่าไหร่คะ", history: [], score: null, customer, approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote", "เคยเลี่ยงไปแล้วหนึ่งครั้ง = ห้ามเลี่ยงอีกเด็ดขาด (นโยบายข้อ 2)");
  assert.equal(decision.reason, "quote_deferral_owed");
  assert.equal(decision.deferredBefore, true);
  assert.equal(decision.owed, true, "ยังไม่เคยมีตัวเลขถึงมือเขา = ยังติดค้างอยู่");
  // โควตาสองตัวยังแยกกัน: เทิร์นนี้ไม่ใช่การเลี่ยง จึงห้ามปักหมุดอะไรเพิ่มทั้งสองตัว
  assert.equal(shouldRecordPriceDeferral(decision), false);
  assert.equal(shouldRecordOnlinePivotDeferral(decision), false);
});

// ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า, ข้อ 5): สาขาความหงุดหงิดอยู่หน้าสุดของคำตัดสิน
// โดยไม่มีเงื่อนไขว่าเราเคยถามเขาอะไรเลย และรายการถ้อยคำมี "ขอข้อมูลเลย" ซึ่งเป็นประโยค
// เปิดสุภาพธรรมดา — ทรงเดียวกับ detectAiLevel ที่นับ "ขอถามข้อมูล" เป็นคำตอบบันไดระดับ AI
test("'ขอข้อมูลเลยค่ะ' ของคนแปลกหน้าไม่ใช่ความหงุดหงิด — ต้องมีสถานะว่าเราเคยถามเขาก่อน", () => {
  const opener = "ขอข้อมูลเลยค่ะ ราคาเท่าไหร่";
  const first = decidePriceDisclosure({ text: opener, history: [], score: null, customer: stranger() });
  assert.equal(first.mode, "defer", "ข้อความแรกของคนแปลกหน้าห้ามเปิดประตูราคาด้วยถ้อยคำสุภาพธรรมดา");
  assert.equal(first.reason, "defer_cold_stranger_screening");
  assert.equal(hasQuestionFatigue(opener), false, "ไม่มีประวัติ = ถือว่ายังไม่เคยถาม (ล้มไปทางปลอดภัย)");

  // เราถามเขาไปแล้วจริง = ถ้อยคำเดียวกันกลายเป็นความหงุดหงิดจริง (นโยบายข้อ 4 ยังอยู่ครบ)
  const asked = [
    { role: "user", content: "สนใจค่ะ" },
    { role: "assistant", content: "ไม่ทราบว่าอยากนำ AI ไปช่วยงานส่วนไหนคะ" },
  ];
  assert.equal(hasQuestionFatigue(opener, asked), true);
  const after = decidePriceDisclosure({ text: opener, history: asked, score: null, customer: stranger() });
  assert.equal(after.mode, "quote");
  assert.equal(after.reason, "quote_question_fatigue");

  // ถ้อยคำที่บ่นเรื่องคำถามตรง ๆ ยังใช้ได้ทันทีเหมือนเดิม — ห้ามทำให้นโยบายข้อ 4 อ่อนลง
  for (const blunt of ["ไม่ต้องถามแล้ว ราคาเท่าไหร่", "ถามเยอะจัง ค่าเรียนกี่บาท", "ตอบตรง ๆ เลยครับ ราคาเท่าไหร่"]) {
    const decision = decidePriceDisclosure({ text: blunt, history: [], score: null, customer: stranger() });
    assert.equal(decision.reason, "quote_question_fatigue", `"${blunt}" ต้องยังได้ตัวเลขทันที`);
  }
});

// ตรวจปรปักษ์ 2026-09-04 (รอบที่หก, ข้อ B): การแยกสองชั้นข้างบนถูกลบล้างด้วยสตริงย่อย
//
// ภาษาไทยไม่มีช่องว่างระหว่างคำ "ขอคำตอบตรง ๆ" จึงมี "ตอบตรง ๆ" อยู่ข้างในพอดี และ
// hasQuestionFatigue ตรวจชั้นห้วนก่อนเสมอ = สมาชิกตัวนั้นของชั้นสุภาพเป็นโค้ดตาย
// ผลจริง: คนแปลกหน้าพิมพ์ "ขอคำตอบตรง ๆ" เป็นข้อความแรกแล้วเปิดประตูราคาได้เอง
// ทั้งที่รอบที่แล้วตั้งใจปิดช่องนี้ไปแล้ว (และเทสต์ก็เขียวเพราะมันทดสอบพฤติกรรมที่ผิด)
//
// เทสต์นี้ยืนยัน "ความไม่ทับกัน" ของสองชั้นตรง ๆ ไม่ใช่ยืนยันผลลัพธ์ปลายทางอย่างเดียว —
// การกลับไปใส่ "ตอบตรง ๆ" เปล่า ๆ ในชั้นห้วนจะแดงทันที
test("สองชั้นความหงุดหงิดต้องไม่กินสมาชิกของกันและกัน (ทั้ง conversationStyle และ salesMotion)", () => {
  // ชั้นสุภาพ: เป็นประโยคเปิดธรรมดาได้ ต้องมีสถานะว่าเราเคยถามเขาก่อนเท่านั้นถึงนับ
  const polite = ["ขอคำตอบตรง ๆ", "ขอคำตอบตรง ๆ เลย ราคาเท่าไหร่ครับ", "ขอข้อมูลเลยค่ะ", "อยากได้คำตอบตรง ๆ ค่ะ"];
  // ชั้นห้วน: บ่นเรื่องคำถามด้วยตัวมันเอง ใช้ได้ทันทีแม้เป็นข้อความแรกของคนแปลกหน้า
  const blunt = ["ตอบตรง ๆ เลยครับ", "ไม่ต้องถามแล้ว ราคาเท่าไหร่", "ถามเยอะจัง", "อย่าเพิ่งถามครับ"];
  const asked = [
    { role: "user", content: "สนใจค่ะ" },
    { role: "assistant", content: "ไม่ทราบว่าอยากนำ AI ไปช่วยงานส่วนไหนคะ" },
  ];

  for (const text of polite) {
    assert.equal(QUESTION_FATIGUE_BLUNT.test(text), false, `"${text}" เป็นวลีสุภาพ ห้ามเข้าชั้นห้วน`);
    assert.equal(QUESTION_FATIGUE_POLITE.test(text), true, `"${text}" ต้องอยู่ในชั้นสุภาพ`);
    assert.equal(hasQuestionFatigue(text), false, `"${text}" จากคนแปลกหน้าที่เรายังไม่เคยถาม = ยังไม่ใช่ความหงุดหงิด`);
    assert.equal(hasQuestionFatigue(text, asked), true, `"${text}" หลังเราถามไปแล้ว = ความหงุดหงิดจริง`);
    assert.equal(hasRecentFatigue({ text, history: [] }), false, `salesMotion ต้องอ่านชั้นเดียวกับ conversationStyle — "${text}"`);
    assert.equal(hasRecentFatigue({ text, history: asked }), true, `salesMotion ต้องเปิดตามสถานะเดียวกัน — "${text}"`);
  }
  for (const text of blunt) {
    assert.equal(QUESTION_FATIGUE_BLUNT.test(text), true, `"${text}" ต้องอยู่ในชั้นห้วน`);
    assert.equal(hasQuestionFatigue(text), true, `"${text}" ต้องนับเป็นความหงุดหงิดทันที (นโยบายข้อ 4)`);
    assert.equal(hasRecentFatigue({ text, history: [] }), true, `salesMotion ต้องนับทันทีเช่นกัน — "${text}"`);
  }

  // วลีเฉพาะของฝั่งการขายยังทำงานทันทีเหมือนเดิม (conversationStyle ไม่ต้องรู้จักคำพวกนี้)
  assert.equal(hasRecentFatigue({ text: "ไม่ขายเหรอครับ", history: [] }), true);
  assert.equal(hasQuestionFatigue("ไม่ขายเหรอครับ"), false, "วลีขายไม่ใช่เรื่องของ conversationStyle");

  // คนแปลกหน้าพิมพ์วลีสุภาพพร้อมถามราคา = คัดกรองหนึ่งครั้ง (ไม่ใช่เทราคาทันที)
  const first = decidePriceDisclosure({
    text: "ขอคำตอบตรง ๆ เลย ราคาเท่าไหร่ครับ", history: [], score: null, customer: stranger(),
  });
  assert.equal(first.reason, "defer_cold_stranger_screening");
  // แต่พอเราเคยถามเขาไปแล้ว ถ้อยคำเดิมได้ตัวเลขทันที — โควตาคัดกรองมีครั้งเดียวเสมอ
  const after = decidePriceDisclosure({
    text: "ขอคำตอบตรง ๆ เลย ราคาเท่าไหร่ครับ", history: asked, score: null, customer: stranger(),
  });
  assert.equal(after.reason, "quote_question_fatigue");
});

test("เทิร์นคัดกรองธรรมดาห้ามถูกนับเป็นการเลี่ยงด้วย pivot (หมุดคนละตัว)", () => {
  const screening = decidePriceDisclosure({
    text: "ราคาเท่าไหร่คะ", history: [], customer: stranger(), approvedAmounts: AMOUNTS,
  });
  assert.equal(screening.reason, "defer_cold_stranger_screening");
  assert.equal(shouldRecordOnlinePivotDeferral(screening), false);
  assert.equal(shouldRecordPriceDeferral(screening), true);
});

/* ---------------- แกนที่สอง: ยกโปรโมชั่นได้หรือยัง (withPromo) ---------------- */

// ตรวจปรปักษ์ 2026-09-04 (ข้อ 2): withPromo เคยมีผู้ใช้อยู่คนเดียวใน salesMotion
// ส่วน warmth ยังยัดแม่แบบ "PROMOTION Early Bird 📌" ลงทุกเทิร์นที่แจ้งราคา
// 2026-09-04 รอบสอง: "เอ่ยงาน in-house / บอกจำนวนคน" ไม่ใช่สัญญาณ "เรารู้จักเขาแล้ว" อีกแล้ว
// (ดูบล็อกด้านบน) — แกนราคาจึงต้องเปิดด้วยสัญญาณมีโครงสร้าง ส่วนแกนโปรฯ ยังปิดตามเดิม
// สองแกนนี้เป็นอิสระต่อกันโดยเจตนา: แจ้งราคาเริ่มต้นได้ แต่ห้ามยกตารางโปรฯ ทั้งชุด
test("งาน in-house / ทีม 4 คนขึ้นไป: แจ้งราคาได้ แต่ห้ามยกตารางโปรโมชั่นทั้งชุด", () => {
  const cases = [
    // 2026-09-04 (รอบที่แปด): แกนโปรฯ ไม่มีตัวจับจากถ้อยคำเป็นของตัวเองอีกแล้ว — ทุกเคสงาน
    // project ต้องมาเป็นคำตอบของไปป์ไลน์ (resolveProjectOpportunity: ผ่านด่าน sales policy
    // และ/หรือหมุด opportunity ที่บันทึกไว้) ซึ่งคือค่าที่โปรดักชันส่งมาจริงในฉากพวกนี้
    { name: "in-house", text: "อยากจัดอบรมพนักงาน ราคาเท่าไหร่ครับ", history: [], projectOpportunity: "in_house_training" },
    { name: "ทีม 6 คน", text: "ราคาเท่าไหร่ครับ", history: [{ role: "user", content: "ทีมมี 6 คนครับ" }] },
    // opportunity ค้างใน sales state: เทิร์นนี้ไม่มีคำว่า in-house เลย แต่แกนโปรฯ ต้องปิด
    { name: "opportunity ค้างใน sales state", text: "ราคาเท่าไหร่ครับ", history: [], projectOpportunity: "in_house_training" },
  ];
  for (const { name, text, history, projectOpportunity = null } of cases) {
    const decision = decidePriceDisclosure({
      text, history, customer: stranger(), approvedAmounts: AMOUNTS, scoreSignals: SCORED, projectOpportunity,
    });
    assert.equal(decision.mode, "quote", `${name}: ต้องแจ้งราคาได้`);
    assert.equal(decision.withPromo, false, `${name}: ห้ามยกโปรฯ ทั้งชุด`);
    const rules = buildWarmthRules({ text, history, customer: stranger(), priceDisclosure: decision }).join("\n");
    assert.ok(!rules.includes("PROMOTION Early Bird 📌"), `${name}: แม่แบบโปรฯ ต้องหายไปทั้งท่อน`);
    assert.ok(!rules.includes("(แจ้งราคาปกติก่อน แล้วตามด้วยราคาโปรของคลาสนั้น)"), `${name}: ห้ามสั่งไล่ราคาโปร`);
    assert.match(rules, /ห้ามยกตารางโปรโมชั่นทั้งชุด|งานลักษณะนี้ยังไม่ยกตารางโปรโมชั่น/u);
    assert.match(rules, /ตอนแจ้งราคา ใช้โครงนี้ทั้งก้อนในบอลลูนเดียว/u, "ยังต้องมีแม่แบบแจ้งราคา ไม่ใช่เงียบ");
  }
});

// ตรวจปรปักษ์ 2026-09-04 (รอบที่หก, ข้อ D): แกนโปรฯ ถูกขับด้วยคำที่ไม่มีเจตนาอยู่ในตัว
//
// "บรรยาย" เป็นคำไทยธรรมดาที่แปลว่าอธิบาย/เล่า และมันเคยเป็นตัวเลือกเปล่าของ
// speaker_engagement — ลูกค้าคนเดียวที่พิมพ์คำนี้ครั้งเดียวในห้อง จะถูกตัดโปรโมชั่นทิ้ง
// ทั้งห้องแบบไม่มีวันกลับ (ตัวจับกวาดทั้งหน้าต่างประวัติ) ทั้งที่เขาแค่ขอให้เราอธิบายคลาส
// การกั๊กโปรฯ ที่เจ้าของอยากให้เห็น คือฝั่งที่ผิดของความผิดพลาด
test("คำว่า 'บรรยาย' ที่แปลว่าอธิบาย ต้องไม่ตัดโปรโมชั่นทิ้งทั้งห้อง", () => {
  const history = [
    { role: "user", content: "ช่วยบรรยายรายละเอียดคลาสหน่อยค่ะ" },
    { role: "assistant", content: "ยินดีค่ะ คลาสนี้เหมาะกับเจ้าของกิจการที่อยากเริ่มใช้ AI ค่ะ" },
  ];
  const decision = decidePriceDisclosure({
    text: "ราคาเท่าไหร่คะ", history, score: 6, customer: stranger({ last_score: 6, known_context_at: 1_700_000_000_000 }), approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote");
  assert.equal(decision.withPromo, true, "ขอให้เราอธิบายคลาส ไม่ใช่การจ้างวิทยากร");
  const rules = buildWarmthRules({
    score: 6, text: "ราคาเท่าไหร่คะ", history, customer: stranger({ last_score: 6, known_context_at: 1_700_000_000_000 }), priceDisclosure: decision,
  }).join("\n");
  assert.ok(rules.includes("PROMOTION Early Bird 📌"), "แม่แบบโปรฯ ของคลาสรวมต้องยังอยู่");

  // เจตนาจ้างวิทยากรจริงยังปิดโปรฯ ได้เหมือนเดิม — ความจำข้ามเทิร์นของแกนโปรฯ ต้องไม่หายไป
  // แต่ตอนนี้ความจำนั้นมาจากหมุด opportunity ที่ scorer บันทึกไว้จริง (สิ่งที่ไปป์ไลน์ส่งมา
  // ในเทิร์นถัดจากเทิร์นที่ลูกค้าเอ่ยงาน) ไม่ใช่การกวาดอ่านตัวหนังสือย้อนหลังรอบใหม่ทุกเทิร์น
  const speaker = decidePriceDisclosure({
    text: "ราคาเท่าไหร่คะ",
    history: [
      { role: "user", content: "เชิญไปบรรยายให้พนักงานที่บริษัทหน่อยครับ" },
      { role: "assistant", content: "ยินดีค่ะ" },
    ],
    score: 6,
    customer: stranger({ last_score: 6, known_context_at: 1_700_000_000_000 }),
    approvedAmounts: AMOUNTS,
    projectOpportunity: "speaker_engagement",
  });
  assert.equal(speaker.mode, "quote");
  assert.equal(speaker.withPromo, false, "งานวิทยากร: ทีมผู้ดูแลออกใบเสนอราคาเสมอ ห้ามยกตารางโปรฯ");
});

// 2026-09-04 (ตรวจปรปักษ์รอบที่แปด): ตัวจับงาน project ฉบับ "ไม่มีด่าน policy" ที่แกนโปรฯ
// เคยใช้ กวาดทับทุกเทิร์นของลูกค้าในหน้าต่าง แล้วมีคำเปล่า ๆ อยู่สองคำ — "วิทยากร" ใน
// SPEAKER_INTENT และ "สอนพนักงาน" ใน IN_HOUSE_INTENT ผลคือคำถามก่อนซื้อธรรมดาที่คนไทย
// ถามกันทุกวัน ตัดโปรโมชั่น Early Bird ทิ้งทั้งห้องอย่างถาวร (พูดครั้งเดียวพอ เพราะมันกวาด
// ทั้งหน้าต่าง) ทั้งที่คนพิมพ์คือคนซื้อคลาสรวมปกติที่เจ้าของอยากให้เห็นราคาโปรที่สุด
test("คำถามก่อนซื้อธรรมดาที่มีคำว่า 'วิทยากร' / 'สอนพนักงาน' ต้องไม่ตัดโปรฯ ทิ้งทั้งห้อง", () => {
  const asked = [
    "วิทยากรคือใครคะ",
    "ใครเป็นวิทยากรคะ",
    "คลาสนี้สอนพนักงานออฟฟิศได้ไหมคะ",
    "เทรนทีมที่ยังไม่เคยใช้ AI ได้ไหมคะ",
  ];
  for (const question of asked) {
    const history = [{ role: "user", content: question }, { role: "assistant", content: "ได้ค่ะ" }];
    const decision = decidePriceDisclosure({
      text: "ราคาเท่าไหร่คะ", history, score: 6, customer: stranger({ last_score: 6, known_context_at: 1_700_000_000_000 }), approvedAmounts: AMOUNTS,
    });
    assert.equal(decision.mode, "quote", `"${question}": ต้องแจ้งราคาได้`);
    assert.equal(decision.withPromo, true, `"${question}" คือคำถามก่อนซื้อ ไม่ใช่การสั่งงาน project`);
    const rules = buildWarmthRules({
      score: 6, text: "ราคาเท่าไหร่คะ", history, customer: stranger({ last_score: 6, known_context_at: 1_700_000_000_000 }), priceDisclosure: decision,
    }).join("\n");
    assert.ok(rules.includes("PROMOTION Early Bird 📌"), `"${question}": แม่แบบโปรฯ ของคลาสรวมต้องยังอยู่`);
  }
});

test("ลูกค้าที่มีบริบทจริงและถามราคา ยังได้แม่แบบโปรโมชั่นครบ", () => {
  const rules = buildWarmthRules({
    score: 6, text: "ราคาเท่าไหร่คะ", history: [], customer: stranger({ last_score: 6, known_context_at: 1_700_000_000_000 }),
  }).join("\n");
  assert.ok(rules.includes("PROMOTION Early Bird 📌"));
  assert.ok(rules.includes("(แจ้งราคาปกติก่อน แล้วตามด้วยราคาโปรของคลาสนั้น)"));
});

test("salesMotion ไม่ชวน Early Bird เอง แม้งานนั้นยกโปรฯ ได้", () => {
  const history = [{ role: "user", content: "อยากจัดอบรมพนักงานในบริษัทครับ" }, { role: "assistant", content: "ยินดีค่ะ" }];
  // ชนิดงานมาจากไปป์ไลน์ (ผ่านด่าน sales policy) เหมือนที่โปรดักชันส่งมาจริง —
  // แกนโปรฯ ไม่มีตัวจับจากถ้อยคำเป็นของตัวเองอีกแล้ว (รอบที่แปด)
  const rules = buildSalesMotionRules({
    text: "สนใจครับ", history, leadScore: 9, addressLabel: "คุณเอ", projectOpportunity: "in_house_training",
  }).join("\n");
  assert.ok(!rules.includes("ทราบโปรโมชั่น early bird แล้วหรือยังคะ"), "งาน project ห้ามชวนคุยโปรฯ คลาสรวม");
  const classroom = buildSalesMotionRules({ text: "สนใจครับ", history: [], leadScore: 9, addressLabel: "คุณเอ" }).join("\n");
  assert.ok(!classroom.includes("ทราบโปรโมชั่น early bird แล้วหรือยังคะ"), "คะแนนอย่างเดียวห้ามชวนโปรฯ เอง");
});

/* ---------------- ตัวประกอบตัวที่ห้า: buildConversationStyleRules ---------------- */

// ตรวจปรปักษ์ 2026-09-04 (ข้อ 1): ตัวประกอบตัวนี้ไม่เคยรับพารามิเตอร์จังหวะราคาเลย
// จึงยิงคำสั่งเรื่องราคาเข้าทุกพรอมต์ รวมถึงเทิร์นคัดกรอง
test("จังหวะคัดกรอง: กติกาสไตล์การคุยต้องไม่แอบสั่งเรื่องราคาสวนทาง", () => {
  const rules = buildConversationStyleRules({ text: "ราคาเท่าไหร่คะ", customer: stranger(), history: [] });
  for (const leak of ["ราคานี้คือโปรโมชั่นที่ดีที่สุดแล้ว", "ได้สิทธิ์ราคา Early Bird ตามปกติ", "ให้ตอบราคาเริ่มต้น แล้วเก็บ 4 แกน"]) {
    assert.ok(!rules.includes(leak), `เทิร์นคัดกรองห้ามมีคำสั่ง "${leak}"`);
  }
  // แต่ "ข้อห้าม" ต้องอยู่ครบ — สิ่งที่หายไปคือตัวเลข ไม่ใช่การกำกับพฤติกรรม
  assert.match(rules, /ห้ามพูดว่าจะขอเช็คตัวเลข ขอคุยกับทีมงาน/u);
  assert.match(rules, /ห้ามลูกแพรตีความเทียบชื่อคลาสหรือยืนยันส่วนลดเอง/u);
  assert.match(rules, /ห้ามคำนวณยอดรวมตามจำนวนท่านเอง/u);
});

test("จังหวะที่มีบริบทจริงและถามราคา: กติกาสไตล์การคุยกลับมาครบ", () => {
  const rules = buildConversationStyleRules({
    text: "ราคาเท่าไหร่คะ", customer: stranger({ last_score: 6, known_context_at: 1_700_000_000_000 }), leadScore: 6, history: [],
  });
  for (const kept of ["ราคานี้คือโปรโมชั่นที่ดีที่สุดแล้ว", "ได้สิทธิ์ราคา Early Bird ตามปกติ", "ให้ตอบราคาเริ่มต้น แล้วเก็บ 4 แกน"]) {
    assert.ok(rules.includes(kept), `เทิร์นแจ้งราคาต้องยังมี "${kept}"`);
  }
});

// ตรวจปรปักษ์ 2026-09-04 (รอบที่หก, ข้อ A): บล็อก continue_previous_offer ยัด "ประโยค
// ข้อเสนอของผู้ช่วยเอง" เข้าพรอมต์คำต่อคำ แล้วสั่ง "ทำสิ่งนั้นต่อทันที" แบบไม่มีเงื่อนไข —
// เป็น rules.push() เปล่า ๆ ที่ไม่เคยอ่านคำตัดสินและไม่เคยมีข้าง
test("continuation ที่ค้างเรื่องราคาไว้ ต้องเดินตามคำตัดสินเหมือนคำสั่งเรื่องราคาบรรทัดอื่น", () => {
  const offer = "เดี๋ยวลูกแพรส่งรายละเอียดและราคาคลาสให้นะคะ";
  const continuation = { action: "continue_previous_offer", offerText: offer };
  const history = [{ role: "user", content: "สนใจครับ" }, { role: "assistant", content: offer }];

  // (ก) เทิร์นที่ยังไม่ถึงจังหวะราคา: ข้อเสนอเดิมต้องเดินต่อ แต่ห้ามสั่งให้พูดตัวเลข
  const cold = stranger();
  const deferTurn = buildConversationStyleRules({ text: "ครับ", customer: cold, continuation, history });
  assert.ok(deferTurn.includes(offer), "ข้อเสนอเดิมต้องยังถูกยกมา ไม่ใช่หายไปทั้งบรรทัด");
  assert.match(deferTurn, /แต่เทิร์นนี้ยังไม่ถึงจังหวะราคา/u, "ต้องพูดฝั่งเดียวกับพรอมต์ที่เหลือ");
  assert.match(deferTurn, /ยังไม่ต้องใส่ตัวเลขราคา ส่วนลด หรือโปรโมชั่นในเทิร์นนี้/u);

  // (ข) เทิร์นที่ติดค้างราคาอยู่: ทำข้อเสนอเดิมต่อได้ทั้งก้อน ไม่ต้องมีท่อนเบรก
  const owedCustomer = stranger({ price_deferred_at: 1_700_000_000_000 });
  const quoteTurn = buildConversationStyleRules({
    text: "ครับ", customer: owedCustomer, continuation,
    history: [{ role: "user", content: "ราคาเท่าไหร่ครับ" }, { role: "assistant", content: offer }],
  });
  assert.ok(quoteTurn.includes(offer));
  assert.doesNotMatch(quoteTurn, /แต่เทิร์นนี้ยังไม่ถึงจังหวะราคา/u, "ติดค้างราคาอยู่ = ห้ามเบรกตัวเอง");

  // (ค) ข้อเสนอที่ไม่เกี่ยวกับเงินต้องไม่ถูกลากเข้าแกนราคาเลย
  const poster = { action: "continue_previous_offer", offerText: "เดี๋ยวลูกแพรส่งโปสเตอร์คลาสให้ดูนะคะ" };
  const neutral = buildConversationStyleRules({ text: "ครับ", customer: cold, continuation: poster, history });
  assert.ok(neutral.includes("เดี๋ยวลูกแพรส่งโปสเตอร์คลาสให้ดูนะคะ"));
  assert.doesNotMatch(neutral, /แต่เทิร์นนี้ยังไม่ถึงจังหวะราคา/u, "ส่งโปสเตอร์ไม่ใช่เรื่องราคา ห้ามเบรกเกินจำเป็น");
});

/* ---------------- pivot สอนสด -> ออนไลน์ ---------------- */

// ตรวจปรปักษ์ 2026-09-04 (ข้อ 6): สาขา pivot `return` ก่อนอ่านหมุดคัดกรอง ห้องที่ถูก
// คัดกรองไปแล้วและยังไม่เคยได้ตัวเลขเลย จึงถูกเลี่ยงรอบสอง = ความล้มเหลวที่พี่ง้วงชี้ชื่อไว้
test("pivot ที่เกิดหลังคัดกรองแต่ยังไม่เคยให้ตัวเลข = ต้องแจ้งราคาสอนสด ไม่ใช่เลี่ยงรอบสอง", () => {
  const history = [{ role: "assistant", content: "จองที่นั่งได้เลยค่ะ" }, { role: "user", content: "ขอถามก่อนครับ" }];
  const customer = stranger({ price_deferred_at: 1_700_000_000_000, last_score: 6 });
  const decision = decidePriceDisclosure({
    text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history, score: 6, customer, approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "quote", "เคยคัดกรองแล้วและยังไม่เคยได้ตัวเลข = ห้ามเลี่ยงอีก");
  assert.equal(decision.onlinePivot, true, "ธงกัน downgrade ต้องเดินทางไปกับคำตัดสิน");
  const rules = buildWarmthRules({ score: 6, text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history, customer, priceDisclosure: decision }).join("\n");
  assert.match(rules, /แจ้งราคาคลาสสอนสดก่อนเป็นหลัก/u, "กัน downgrade โดยยังมีตัวเลขอยู่ในคำตอบ");
  assert.match(rules, /ห้ามนำด้วยราคาออนไลน์เดี่ยว ๆ/u);
  assert.doesNotMatch(rules, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u);
});

test("pivot ปกติ (ราคาสอนสดออกไปแล้ว) ยังกัน downgrade แบบเดิมทุกอย่าง", () => {
  const history = [{ role: "assistant", content: "โปรโมชั่น Early Bird 12,900 บาท/ท่าน" }, { role: "user", content: "จองที่นั่งยังไงคะ" }];
  const decision = decidePriceDisclosure({
    text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history, score: 6, customer: stranger({ last_score: 6 }), approvedAmounts: AMOUNTS,
  });
  assert.equal(decision.mode, "defer");
  assert.equal(decision.reason, "defer_online_pivot");
  const rules = buildWarmthRules({ score: 6, text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history, priceDisclosure: decision }).join("\n");
  assert.match(rules, /ยังไม่ต้องใส่ตัวเลขราคาออนไลน์เดี่ยวในเทิร์นนี้/u);
});

test("เทิร์น pivot ห้ามถูกเรียกว่า 'เทิร์นคัดกรอง' ในกติกาการขาย", () => {
  const history = [{ role: "assistant", content: "โปรโมชั่น Early Bird 12,900 บาท/ท่าน" }, { role: "user", content: "จองที่นั่งยังไงคะ" }];
  const rules = buildSalesMotionRules({ text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history, leadScore: 6 }).join("\n");
  assert.ok(!rules.includes("เทิร์นคัดกรองครั้งเดียว"), "pivot ไม่ใช่การคัดกรอง — ถ้าเรียกแบบนั้นโมเดลจะถามซ้ำ");
  assert.match(rules, /ห้ามถามคำถามคัดกรองเพิ่มในเทิร์นนี้/u);
});

/* ---------------- กติกา v1.2.2 ที่หายไปตอนเปลี่ยนโซ่เงื่อนไข ---------------- */

// ตรวจปรปักษ์ 2026-09-04 (ข้อ 11): โซ่ใหม่ปล่อย "ลูกค้าเย็น + จังหวะราคาเปิดแล้ว +
// เทิร์นนี้ไม่ได้ถามเรื่องเงิน" ตกพื้น = พรอมต์ไม่มีคำสั่งเรื่องราคาเลยสักบรรทัด
test("ลูกค้าเย็นที่จังหวะราคาเปิดแล้วแต่ไม่ได้ถามเรื่องเงิน ต้องยังมีคำสั่งเรื่องราคาในพรอมต์", () => {
  const customer = stranger({ price_deferred_at: 1_700_000_000_000, price_quoted_at: 1_700_000_100_000, last_score: 2 });
  const decision = decidePriceDisclosure({ text: "เรียนที่ไหนคะ", history: [], score: 2, customer, approvedAmounts: AMOUNTS });
  assert.equal(decision.mode, "quote");
  const rules = buildWarmthRules({ score: 2, text: "เรียนที่ไหนคะ", history: [], customer, priceDisclosure: decision }).join("\n");
  assert.match(rules, /บอกราคาที่อนุมัติได้เลยอย่างมั่นใจ/u, "กติกา v1.2.2 ฉบับ quote ต้องกลับมา");
  assert.match(rules, /ห้ามยื่นตัวเลขราคาให้เองโดยไม่ถูกถาม/u, "เจตนาเดิมของ v1.2.2 ต้องอยู่ครบ");
  assert.doesNotMatch(rules, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u, "จะกลับไปปิดเรื่องที่เปิดไปแล้วไม่ได้");
});

/* ---------------- ห้าม throw และต้องล้มไปทาง quote ---------------- */

test("ห้าม throw ไม่ว่าจะได้ของพังแค่ไหน", () => {
  const junk = [
    {},
    undefined,
    { text: null, history: null, score: undefined, customer: undefined, knownName: null, inboundFlags: null },
    { text: "ราคาเท่าไหร่", history: [null, 7, { role: "user" }, { content: "x" }], score: "แปด", customer: 5 },
    { text: 12345, history: "ไม่ใช่อาร์เรย์", inboundFlags: "asks_discount", approvedAmounts: "ไม่ใช่ Set" },
  ];
  for (const args of junk) {
    const decision = decidePriceDisclosure(args);
    assert.ok(decision && (decision.mode === "defer" || decision.mode === "quote"), "ต้องคืนคำตัดสินเสมอ");
    assert.equal(typeof decision.reason, "string");
    assert.equal(typeof decision.withPromo, "boolean");
    assert.equal(typeof decision.owed, "boolean");
  }
  assert.doesNotThrow(() => buildWarmthRules({}));
  assert.doesNotThrow(() => buildWarmthRules({ score: null, text: undefined, history: undefined, customer: undefined }));
  assert.doesNotThrow(() => buildConversationStyleRules({}));
  assert.equal(outboundCarriesClassPrice("19,900 บาท", null), false, "ไม่มีตารางราคา = อ่านไม่ออก ห้ามเดา");
});

test("ตัวอ่านสัญญาณพังข้างใน = ล้มไปทาง quote ไม่ใช่คัดกรองซ้ำ", () => {
  // customer ที่ getter ระเบิด = เลียนแบบแถวฐานที่อ่านไม่ได้จริง ๆ
  const exploding = { get price_deferred_at() { throw new Error("db read failed"); } };
  const decision = decidePriceDisclosure({ text: "ราคาเท่าไหร่คะ", history: [], score: null, customer: exploding });
  assert.equal(decision.mode, "quote", "แจ้งราคาเร็วไปหนึ่งเทิร์น ดีกว่าถามคัดกรองซ้ำรอบสอง");
  assert.equal(decision.reason, "error_fail_open");
});

/* ---------------- หมุดถาวร: ปักเฉพาะการคัดกรองเพราะเรื่องเงินเท่านั้น ---------------- */

test("ปักหมุดเฉพาะการคัดกรองเรื่องเงิน — เทิร์นเย็นธรรมดาห้ามปัก", () => {
  assert.equal(shouldRecordPriceDeferral(decidePriceDisclosure({ text: "ราคาเท่าไหร่คะ", history: [], score: null })), true);
  assert.equal(shouldRecordPriceDeferral(decidePriceDisclosure({ text: "มีคลาสอะไรบ้าง", history: [], score: null })), false);
  assert.equal(shouldRecordPriceDeferral(decidePriceDisclosure({ text: "สวัสดีครับ", history: [], score: null })), false);
  assert.equal(shouldRecordPriceDeferral(null), false, "เส้น template ไม่มีคำตัดสิน ห้ามปักหมุด");
  // เคส pivot คุมจังหวะราคาด้วยเหตุผลคนละเรื่อง (ให้ลูกค้าเลือกเส้นก่อน) ห้ามกินโควตาคัดกรอง
  const pivot = decidePriceDisclosure({
    text: "คลาสออนไลน์ ราคาเท่าไหร่คะ",
    history: [{ role: "assistant", content: "Early Bird 12,900 บาท/ท่าน" }],
    score: 6,
    approvedAmounts: AMOUNTS,
  });
  assert.equal(pivot.reason, "defer_online_pivot");
  assert.equal(shouldRecordPriceDeferral(pivot), false);
});

test("หมุดในฐานข้อมูลทั้งสามตัว: เขียนครั้งแรกชนะ และ reset ล้างทิ้ง", () => {
  const db = memoryDb();
  db.upsertCustomer("U-defer", {});
  const markers = [
    ["price_deferred_at", () => db.markPriceDeferred("U-defer")],
    ["price_quoted_at", () => db.markPriceQuoted("U-defer")],
    ["known_context_at", () => db.markCustomerContextKnown("U-defer")],
  ];
  for (const [column, mark] of markers) {
    assert.equal(Number(db.getCustomer("U-defer")[column]), 0, `${column} ต้องเริ่มที่ 0`);
    mark();
    const first = Number(db.getCustomer("U-defer")[column]);
    assert.ok(first > 0, `${column} ต้องถูกปัก`);
    mark();
    assert.equal(Number(db.getCustomer("U-defer")[column]), first, `${column}: เขียนครั้งแรกชนะ ห้ามทับเวลา`);
  }
  db.resetCustomer("U-defer");
  for (const [column] of markers) {
    assert.equal(Number(db.getCustomer("U-defer")[column]), 0, `${column}: reset/PDPA ต้องล้างด้วย`);
  }
  db.close();
});

test("อ่านหมุดได้จากทั้งคอลัมน์และร่องรอยในข้อความ (เข็มขัดเสริม ดันไปทาง quote เท่านั้น)", () => {
  assert.equal(hasDeferredPriceBefore({ customer: { price_deferred_at: 5 } }), true);
  assert.equal(hasDeferredPriceBefore({
    history: [{ role: "assistant", content: "เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามค่ะ" }],
  }), true);
  // ถ้อยคำคัดกรองธรรมดาที่โผล่ในคำตอบเย็น ๆ ทั่วไป ห้ามถูกอ่านเป็นการคัดกรองเรื่องราคา
  // (marker หลวมแบบนี้คือสิ่งที่ทำให้ความพยายามรอบก่อนเทราคาใส่คนที่เพิ่งถามครั้งแรก)
  for (const content of [
    "ตอนนี้มีหลายคลาสให้เลือกเลยค่ะ", "ไม่ทราบว่าทำงานสายอะไรคะ",
    "ขออนุญาตถามเบื้องต้นสักหน่อยนะคะ", "เพื่อให้แนะนำได้ตรงที่สุดค่ะ",
  ]) {
    assert.equal(hasDeferredPriceBefore({ history: [{ role: "assistant", content }] }), false, `"${content}" ไม่ใช่ร่องรอยการคัดกรองราคา`);
  }
});

/* ---------------- ทางเดินจริง ---------------- */

const PACK = [
  "LUKPRAE_BRAIN_PACK_JSON_V1",
  JSON.stringify({ entries: [{ id: "agent", titleTh: "AI Agent for Business", answerTh: "รายละเอียดคลาสค่ะ", tags: ["AI Agent for Business"], questionPatterns: [] }] }),
  "END_LUKPRAE_BRAIN_PACK_JSON_V1",
].join("\n");

// คำตอบคัดกรองของจริงที่โมเดลจะเขียนตามกติกา — มีวลีกรอบ "ประโยชน์ของผู้เรียน" อยู่ในนั้น
const DEFERRAL_REPLY = "เรื่องราคาบอกได้เลยค่ะ เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน "
  + "จึงขออนุญาตสอบถามเบื้องต้นสั้น ๆ หนึ่งข้อ ไม่ทราบว่าอยากนำ AI ไปใช้กับงานส่วนไหนคะ";
// คำตอบคัดกรองฉบับที่ humanizer/โมเดลเรียบเรียงเอง — ไม่มีวลีตัวอย่างหลงเหลือ
const PARAPHRASED_DEFERRAL = "เรื่องราคาบอกได้เลยค่ะ ขออนุญาตถามสั้น ๆ ข้อเดียวก่อนนะคะ "
  + "ไม่ทราบว่าอยากนำ AI ไปช่วยงานส่วนไหนคะ";
const PLAIN_REPLY = "รับทราบค่ะ เดี๋ยวลูกแพรดูให้นะคะ";

function appWithShortHistory({ firstReply = DEFERRAL_REPLY, replies = null, onCall = null, lineFetch = null } = {}) {
  const db = memoryDb();
  db.addKnowledge({ title: "แคตตาล็อกคลาสและราคา", content: "AI Agent for Business 19,900 บาท", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  let call = 0;
  const hermesFetch = hermesFetchStub("", { onCall: async (parsed) => { if (onCall) await onCall(parsed, call); call += 1; } });
  const wrapped = async (url, opts) => {
    const reply = replies ? (replies[call] ?? PLAIN_REPLY) : (call === 0 ? firstReply : PLAIN_REPLY);
    const res = await hermesFetch(url, opts);
    return { ...res, json: async () => ({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 800, completion_tokens: 70 } }) };
  };
  wrapped.calls = hermesFetch.calls;
  const app = createApp({
    // HISTORY_TURNS=2 คือการจำลอง "หน้าต่างประวัติเลื่อนจนร่องรอยข้อความหลุด" ให้เกิดใน
    // ไม่กี่เทิร์น — ของจริงตั้ง 12 แถว และหนึ่งรอบสนทนากินได้ ~5 แถว จึงหลุดได้เหมือนกัน
    config: testConfig({ BRAND_PACK: PACK, HISTORY_TURNS: "2" }),
    db,
    overrides: { hermesFetch: wrapped, lineFetch: lineFetch || lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  // webhook ของจริงบันทึกข้อความขาเข้าก่อนเรียกไปป์ไลน์เสมอ — เทสต์ที่เรียกไปป์ไลน์ตรง ๆ
  // ต้องทำแบบเดียวกัน ไม่งั้นประวัติจะมีแต่ฝั่งบอท แล้วฉากนี้จะวัดของน้อยกว่าที่คิด
  const say = async (id, text, { replyToken = "rt" } = {}) => {
    db.insertMessage({ customerId: id, direction: "in", content: text });
    return app.pipeline.handleInboundText({ customerId: id, text, replyToken });
  };
  return { db, app, hermesFetch: wrapped, say };
}

const systemOf = (call) => promptText(call.body.messages.find((m) => m.role === "system")?.content);

test("ทางเดินจริง: คัดกรองครั้งแรก ปักหมุด แล้วหมุดอยู่รอดแม้ร่องรอยในข้อความจะเลื่อนหลุดประวัติ", async () => {
  const { db, hermesFetch, say } = appWithShortHistory();
  const id = "U-window";
  db.upsertCustomer(id, {});

  await say(id, "ราคาเท่าไหร่คะ");
  const first = systemOf(hermesFetch.calls.at(-1));
  assert.match(first, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "เทิร์นแรกต้องเป็นการคัดกรอง");
  assert.ok(Number(db.getCustomer(id).price_deferred_at) > 0, "ต้องปักหมุดถาวรหลังส่งสำเร็จ");
  assert.ok(
    db.recentTurns(id, 12).some((turn) => String(turn.content).includes("ได้ประโยชน์สูงสุดต่อผู้เรียน")),
    "ร่องรอยในข้อความต้องมีอยู่จริงก่อน ไม่งั้นฉากนี้พิสูจน์เรื่องหน้าต่างประวัติไม่ได้",
  );

  // คุยเรื่องอื่นจนข้อความคัดกรองเลื่อนพ้นหน้าต่างประวัติที่ส่งเข้าพรอมต์
  for (const text of ["ทำสำนักงานบัญชีครับ", "อยู่กรุงเทพครับ", "เรียนที่ไหนครับ", "จอดรถยังไงครับ"]) {
    await say(id, text);
  }
  const historyNow = db.recentTurns(id, 2);
  assert.ok(
    !historyNow.some((turn) => String(turn.content).includes("ได้ประโยชน์สูงสุดต่อผู้เรียน")),
    "ร่องรอยในข้อความต้องหลุดหน้าต่างไปแล้ว — เหลือหมุดถาวรเป็นหลักฐานชิ้นเดียว",
  );

  await say(id, "แล้วราคาเท่าไหร่ครับ");
  const later = systemOf(hermesFetch.calls.at(-1));
  assert.match(later, /แจ้งราคาในเทิร์นนี้ทันที ห้ามเลี่ยงอีกเด็ดขาด/u, "หมุดถาวรต้องยังทำงานหลังประวัติเลื่อนหลุด");
  assert.doesNotMatch(later, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u);
  db.close();
});

test("ทางเดินจริง: เทิร์นถัดจากคัดกรอง (ลูกค้าตอบคำถามกลับมา) ต้องถูกสั่งให้มีราคา", async () => {
  const { db, hermesFetch, say } = appWithShortHistory();
  const id = "U-answer";
  db.upsertCustomer(id, {});
  await say(id, "ค่าเรียนเท่าไหร่คะ");
  await say(id, "ทำสำนักงานบัญชีค่ะ");
  const prompt = systemOf(hermesFetch.calls.at(-1));
  assert.match(prompt, /คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ/u);
  assert.doesNotMatch(prompt, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u);
  assert.doesNotMatch(prompt, /ยังไม่ถึงจังหวะราคา/u);
  db.close();
});

// ---- ข้อ 3/7/12/14 บนทางเดินจริง: คำตอบคัดกรองที่ถูกเรียบเรียงใหม่ (ไม่มีวลีตัวอย่าง)
test("ทางเดินจริง: คำตอบคัดกรองที่ถูกเรียบเรียงใหม่ ต้องยังทำให้เทิร์นถัดไปมีราคา", async () => {
  const { db, hermesFetch, say } = appWithShortHistory({ firstReply: PARAPHRASED_DEFERRAL });
  const id = "U-paraphrase";
  db.upsertCustomer(id, {});
  await say(id, "ค่าเรียนเท่าไหร่คะ");
  assert.ok(
    !db.recentTurns(id, 12).some((turn) => String(turn.content).includes("ได้ประโยชน์สูงสุดต่อผู้เรียน")),
    "ฉากนี้ต้องไม่มีวลีตัวอย่างหลงเหลือเลย ไม่งั้นวัดของผิดข้อ",
  );
  await say(id, "ทำสำนักงานบัญชีค่ะ");
  const prompt = systemOf(hermesFetch.calls.at(-1));
  assert.match(prompt, /คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ/u, "สถานะติดค้างต้องมาจากคอลัมน์ ไม่ใช่จากสำนวน");
  db.close();
});

test("ทางเดินจริง: ราคาที่ส่งถึงลูกค้าจริงต้องปักหมุด price_quoted_at (และเลิกติดค้าง)", async () => {
  const { db, hermesFetch, say } = appWithShortHistory({
    replies: [DEFERRAL_REPLY, "ได้เลยค่ะ คลาสนี้ ปกติ 19,900 บาท/ท่านค่ะ", PLAIN_REPLY],
  });
  const id = "U-quoted";
  db.upsertCustomer(id, {});
  await say(id, "ค่าเรียนเท่าไหร่คะ");
  assert.equal(Number(db.getCustomer(id).price_quoted_at), 0, "เทิร์นคัดกรองยังไม่มีตัวเลข");
  await say(id, "ทำสำนักงานบัญชีค่ะ");
  assert.ok(Number(db.getCustomer(id).price_quoted_at) > 0, "ราคาถึงมือลูกค้าแล้ว ต้องปักหมุด");
  await say(id, "อยู่กรุงเทพค่ะ");
  const prompt = systemOf(hermesFetch.calls.at(-1));
  assert.doesNotMatch(prompt, /คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ/u, "แจ้งราคาไปแล้ว ห้ามสั่งซ้ำไปตลอดกาล");
  db.close();
});

test("ทางเดินจริง: ข้อความที่มีเลขแต่ไม่ใช่ราคาคลาส ห้ามปักหมุดว่าแจ้งราคาแล้ว", async () => {
  const { db, say } = appWithShortHistory({ replies: ["พี่ง้วงสอนมาแล้วกว่า 5,000 คน และรอบนี้รับ 20 ที่นั่งค่ะ"] });
  const id = "U-noise";
  db.upsertCustomer(id, {});
  await say(id, "มีคลาสอะไรบ้างคะ");
  assert.equal(Number(db.getCustomer(id).price_quoted_at), 0, "social proof / จำนวนที่นั่ง ไม่ใช่ราคา");
  db.close();
});

// ---- ข้อ 8: หมุดต้องหมายถึง "เราถามเขาไปแล้วจริง" — ดราฟต์ที่ถูกทิ้งก่อนส่งห้ามปัก
test("ทางเดินจริง: ดราฟต์คัดกรองที่ถูกทิ้งก่อนส่ง ห้ามกินโควตาคัดกรอง", async () => {
  const id = "U-dropped";
  const { db, say, hermesFetch } = appWithShortHistory({
    // แอดมิน takeover ระหว่างที่เรากำลังคิด = ดราฟต์ถูกทิ้งทั้งก้อน ลูกค้าไม่ได้รับอะไรเลย
    onCall: (_parsed, call) => { if (call === 0) db.setAiEnabled(id, false, "manual_takeover"); },
  });
  db.upsertCustomer(id, {});
  const result = await say(id, "ราคาเท่าไหร่คะ");
  assert.equal(result?.suppressed, "ai_disabled_before_send", "ฉากนี้ต้องเป็นเส้น 'ทิ้งดราฟต์ก่อนส่ง' จริง ๆ");
  assert.equal(
    Number(db.getCustomer(id).price_deferred_at), 0,
    "ลูกค้าไม่เคยถูกถามอะไรเลย — ปักหมุดตรงนี้แปลว่าคำตอบแรกที่เขาได้รับจะเป็นราคา",
  );

  // เปิด AI กลับ แล้วเขาถามใหม่: ต้องได้การคัดกรองครั้งแรก ไม่ใช่ราคา
  db.setAiEnabled(id, true, "");
  await say(id, "ราคาเท่าไหร่คะ");
  const prompt = systemOf(hermesFetch.calls.at(-1));
  assert.match(prompt, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u);
  assert.ok(Number(db.getCustomer(id).price_deferred_at) > 0, "รอบที่ส่งสำเร็จจริงถึงจะปักหมุด");
  db.close();
});

/* ---- ตรวจปรปักษ์ 2026-09-04 (รอบที่หก, ข้อ C): ส่งไม่ครบ = ไม่มีหมุดเลยสักตัว ----
 *
 * สาขา `else if (!sendResult.blocked)` ของไปป์ไลน์มีอยู่เพราะ push ล้มกลางลูปได้จริง
 * (โควตาหมด 429 วันที่ 2026-08-15) **หลังบอลลูนแรกถึงมือลูกค้าไปแล้ว** — มันบันทึกทุก
 * บอลลูนที่ส่งได้ลง messages ครบ แต่ข้ามบล็อกปักหมุดทั้งชุด ผลคือคำถามคัดกรองที่ลูกค้า
 * อ่านไปแล้วจริง ๆ ทิ้ง price_deferred_at = 0 ไว้ แล้วเขาถูกคัดกรอง "รอบที่สอง"
 */
// LINE รับ push ก้อนแรก แล้วโควตารายเดือนหมดพอดี (ทรงเดียวกับเคสจริง 2026-08-15)
function quotaDiesAfterFirstPush() {
  let pushes = 0;
  return async (url) => {
    if (String(url).includes("/v2/bot/message/push")) {
      pushes += 1;
      if (pushes > 1) return { ok: false, status: 429, json: async () => ({ message: "monthly limit reached" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

// คำตอบคัดกรองที่แตกเป็นสองบอลลูน — บอลลูนแรกคือตัวคำถามคัดกรองที่ลูกค้าได้อ่านจริง
const DEFERRAL_REPLY_TWO_BUBBLES = "เรื่องราคาบอกได้เลยค่ะ เพื่อให้เลือกคลาสที่เหมาะสม"
  + "และได้ประโยชน์สูงสุดต่อผู้เรียน จึงขออนุญาตสอบถามเบื้องต้นสั้น ๆ หนึ่งข้อนะคะ\n\n"
  + "ไม่ทราบว่าอยากนำ AI ไปใช้กับงานส่วนไหนคะ";

test("ทางเดินจริง: ส่งล้มกลางลูปหลังคำถามคัดกรองถึงมือลูกค้าแล้ว ต้องปักหมุด (ห้ามคัดกรองรอบสอง)", async () => {
  const { db, hermesFetch, say } = appWithShortHistory({
    replies: [DEFERRAL_REPLY_TWO_BUBBLES, PLAIN_REPLY],
    lineFetch: quotaDiesAfterFirstPush(),
  });
  const id = "U-partial";
  db.upsertCustomer(id, {});

  // ไม่มี replyToken = เส้น push ซึ่งเป็นเส้นเดียวที่ทยอยส่งทีละบอลลูนแล้วล้มกลางคันได้
  const result = await say(id, "ราคาเท่าไหร่คะ", { replyToken: "" });
  assert.equal(result.sent, false, "ฉากนี้ต้องเป็นเส้น 'ส่งไม่สำเร็จ' จริง ๆ ไม่งั้นวัดของผิดสาขา");
  assert.equal(result.sendResult.blocked, undefined, "ต้องไม่ใช่การถูกปิดกั้น — ต้องเป็นการล้มกลางลูป");
  assert.equal(result.sendResult.delivered.length, 1, "บอลลูนแรกต้องถึงมือลูกค้าไปแล้วจริง");

  const delivered = db.raw
    .prepare("SELECT content FROM messages WHERE customer_id = ? AND direction = 'out'")
    .all(id);
  assert.equal(delivered.length, 1, "ไปป์ไลน์บันทึกเฉพาะบอลลูนที่ถึงจริง (พฤติกรรมเดิม ต้องไม่เปลี่ยน)");
  assert.match(delivered[0].content, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "สิ่งที่เขาอ่านคือคำถามคัดกรอง");

  assert.ok(
    Number(db.getCustomer(id).price_deferred_at) > 0,
    "ลูกค้าอ่านคำถามคัดกรองไปแล้ว — หมุดต้องตามสิ่งที่เขาได้รับ ไม่ใช่ตามว่าเทิร์นนี้จบสวยหรือเปล่า",
  );

  // และสิ่งที่หมุดนั้นซื้อไว้: คำถามราคาครั้งถัดไปต้องได้ตัวเลข ไม่ใช่คำถามคัดกรองข้อที่สอง
  await say(id, "แล้วราคาเท่าไหร่ครับ");
  const prompt = systemOf(hermesFetch.calls.at(-1));
  assert.match(prompt, /แจ้งราคาในเทิร์นนี้ทันที ห้ามเลี่ยงอีกเด็ดขาด/u);
  assert.doesNotMatch(prompt, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u);
  db.close();
});

test("ทางเดินจริง: ส่งล้มก่อนบอลลูนแรกออกไป ห้ามปักหมุด (ลูกค้าไม่เคยถูกถามอะไรเลย)", async () => {
  let pushes = 0;
  const { db, say } = appWithShortHistory({
    replies: [DEFERRAL_REPLY_TWO_BUBBLES],
    lineFetch: async (url) => {
      if (String(url).includes("/v2/bot/message/push")) {
        pushes += 1;
        return { ok: false, status: 429, json: async () => ({ message: "monthly limit reached" }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  const id = "U-nothing-delivered";
  db.upsertCustomer(id, {});
  const result = await say(id, "ราคาเท่าไหร่คะ", { replyToken: "" });
  assert.equal(result.sent, false);
  assert.equal(pushes, 1, "ต้องพยายามส่งจริงแล้วล้มตั้งแต่ก้อนแรก");
  assert.equal(result.sendResult.delivered.length, 0, "ลูกค้าไม่ได้รับอะไรเลย");
  assert.equal(
    Number(db.getCustomer(id).price_deferred_at), 0,
    "ไม่มีอะไรถึงมือเขา = ห้ามกินโควตาคัดกรอง (กติกาเดียวกับดราฟต์ที่ถูกทิ้งก่อนส่ง)",
  );
  db.close();
});

// Mandate 3 (ตรวจปรปักษ์ 2026-09-04): การเลี่ยงด้วยคำถาม "สอนสดหรือออนไลน์" ไม่เคยถูก
// บันทึกไว้เลย ห้องเดียวกันจึงถูกเลี่ยงด้วยคำถามเดิมได้ตลอดกาล แม้ลูกค้าจะตอบไปแล้ว
test("ทางเดินจริง: เลี่ยงด้วยคำถามสอนสด/ออนไลน์ ต้องปักหมุด แล้วรอบสองได้ราคา", async () => {
  const { db, hermesFetch, say } = appWithShortHistory({ replies: [PLAIN_REPLY, PLAIN_REPLY, PLAIN_REPLY] });
  const id = "U-pivot";
  db.upsertCustomer(id, {});
  // สร้างเส้น "สอนสด" ให้เหมือนของจริง: บอทเคยพิมพ์ราคาสอนสดไปแล้ว
  db.insertMessage({ customerId: id, direction: "out", content: "โปรโมชั่น Early Bird 12,900 บาท/ท่านค่ะ" });
  db.insertMessage({ customerId: id, direction: "in", content: "จองที่นั่งยังไงคะ" });
  db.recordScore(id, 6, JSON.stringify({ score: 6, pain_point: "", persona_type: "unknown" }));

  await say(id, "คลาสออนไลน์ ราคาเท่าไหร่คะ");
  assert.ok(Number(db.getCustomer(id).price_pivot_deferred_at) > 0, "การเลี่ยงต้องถูกบันทึกหลังส่งสำเร็จ");
  const first = systemOf(hermesFetch.calls.at(-1));
  assert.match(first, /ยังไม่ต้องใส่ตัวเลขราคาออนไลน์เดี่ยวในเทิร์นนี้/u, "รอบแรกคือการให้เลือกเส้นก่อน");

  await say(id, "คลาสออนไลน์ ราคาเท่าไหร่คะ");
  const second = systemOf(hermesFetch.calls.at(-1));
  assert.doesNotMatch(second, /ยังไม่ต้องใส่ตัวเลขราคาออนไลน์เดี่ยวในเทิร์นนี้/u, "ถามซ้ำแล้วห้ามเลี่ยงอีก");
  assert.match(second, /แจ้งราคาคลาสสอนสดก่อนเป็นหลัก/u, "แจ้งราคาแต่ยังกัน downgrade ครบ");
  db.close();
});

test("ทางเดินจริง: เทิร์นเย็นที่ไม่ได้ถามเรื่องเงิน ห้ามกินโควตาคัดกรอง", async () => {
  const { db, say } = appWithShortHistory();
  const id = "U-nomoney";
  db.upsertCustomer(id, {});
  await say(id, "สนใจเรียน AI ครับ");
  assert.equal(Number(db.getCustomer(id).price_deferred_at), 0, "เทิร์นเย็นธรรมดาห้ามปักหมุด ไม่งั้นการถามราคาครั้งแรกจริง ๆ จะถูกอ่านเป็นครั้งที่สอง");
  db.close();
});

// 2026-09-04 (ตรวจปรปักษ์รอบที่แปด): ผลคัดกรองอ่านจากหน้าต่างประวัติที่เลื่อนได้เหมือนกัน —
// คนที่ตอบบันไดของเราไปแล้วเมื่อสิบเทิร์นก่อน จะกลายเป็นคนแปลกหน้าอีกครั้งเมื่อคำตอบนั้น
// เลื่อนพ้นหน้าต่าง แล้วโดนคัดกรองรอบสอง ซึ่งคือความล้มเหลวที่พี่ง้วงชี้ชื่อไว้ตรง ๆ
// หมุด known_context_at จึงต้องปักจากผลคัดกรองด้วย ไม่ใช่จาก scorer อย่างเดียว
test("ทางเดินจริง: คนที่ตอบบันไดคัดกรองแล้ว ห้ามกลายเป็นคนแปลกหน้าเมื่อคำตอบเลื่อนหลุดประวัติ", async () => {
  const { db, hermesFetch, say } = appWithShortHistory({ firstReply: PLAIN_REPLY });
  const id = "U-ladder";
  db.upsertCustomer(id, {});
  await say(id, "ระดับ 2 ค่ะ");
  assert.ok(Number(db.getCustomer(id).known_context_at) > 0, "คำตอบบันไดของเราเองต้องถูกปักหมุดถาวร");

  for (const text of ["อยู่กรุงเทพค่ะ", "เรียนที่ไหนคะ", "จอดรถยังไงคะ", "มีที่นั่งไหมคะ"]) {
    await say(id, text);
  }
  assert.ok(
    !db.recentTurns(id, 2).some((turn) => String(turn.content).includes("ระดับ 2")),
    "คำตอบบันไดต้องหลุดหน้าต่างไปแล้ว — เหลือหมุดถาวรเป็นหลักฐานชิ้นเดียว",
  );

  await say(id, "ราคาเท่าไหร่คะ");
  const prompt = systemOf(hermesFetch.calls.at(-1));
  assert.match(prompt, /ตอบราคาที่อนุมัติแล้วอย่างมั่นใจ/u, "คนที่ตอบคำถามเราไปแล้วต้องได้ราคาทันที");
  assert.doesNotMatch(prompt, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "ห้ามคัดกรองซ้ำคนที่ตอบบันไดไปแล้ว");
  db.close();
});

// 2026-09-04 (เคสจริงสองห้องบนโปรดักชัน): ฉากข้างบนใช้ "ระดับ 2 ค่ะ" ซึ่งเป็นรูปที่ตัวอ่าน
// อ่านออกมาตั้งแต่แรก — แต่คำตอบที่ลูกค้าจริงพิมพ์คือ "ยังไม่เคยครับ" / "ไม่เคยครับ"
// ซึ่งเคยคืน null ทั้งคู่ ทั้งเส้นจึงพังเงียบ ๆ ตั้งแต่ต้นทาง: ไม่มีระดับ = ไม่มีหมุด =
// เทิร์นถัดไปเป็นคนแปลกหน้าอีกครั้ง ฉากนี้เดินทางเดินจริงทั้งเส้นเพื่อยืนยันสามอย่างพร้อมกัน
// (อ่านออก / ปักหมุดถาวรในเทิร์นนั้นเลย / เทิร์นถัดไปไม่ถูกคัดกรองซ้ำ)
test("ทางเดินจริง: ตอบบันไดว่า 'ยังไม่เคยครับ' ต้องปักหมุดทันทีและห้ามถูกคัดกรองซ้ำ", async () => {
  const { db, hermesFetch, say } = appWithShortHistory({ firstReply: PLAIN_REPLY });
  const id = "U-never-used";
  db.upsertCustomer(id, {});
  // 15 Sep: a recorded question grounds the short answer.
  db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: "เคยใช้ AI มาบ้างไหมคะ?", operator: "system" });
  await say(id, "ยังไม่เคยครับ");
  assert.ok(
    Number(db.getCustomer(id).known_context_at) > 0,
    "คำตอบบันไดที่ลูกค้าพิมพ์จริงต้องปักหมุดถาวรในเทิร์นเดียวกับที่ตอบ",
  );
  assert.match(
    systemOf(hermesFetch.calls.at(-1)), /ระดับการใช้ AI = 1/u,
    "พรอมต์เทิร์นเดียวกันต้องประกาศระดับที่อ่านได้ ไม่ใช่ 'ยังไม่ทราบระดับ'",
  );

  await say(id, "ราคาเท่าไหร่ครับ");
  const prompt = systemOf(hermesFetch.calls.at(-1));
  assert.match(prompt, /ตอบราคาที่อนุมัติแล้วอย่างมั่นใจ/u, "คนที่ตอบบันไดของเราไปแล้วต้องได้ราคาทันที");
  assert.doesNotMatch(prompt, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "ห้ามขอคัดกรองซ้ำกับคนที่เพิ่งตอบไป");
  db.close();
});

// ---- ข้อ 9/10: สัญญาณ "เรารู้จักเขาแล้ว" ต้องไม่หายไปกับหน้าต่างประวัติ
test("ทางเดินจริง: ลูกค้าที่ scorer อ่านโจทย์ออกแล้ว ห้ามกลายเป็นคนแปลกหน้าอีกครั้ง", async () => {
  const { db, hermesFetch, say } = appWithShortHistory({ firstReply: PLAIN_REPLY });
  const id = "U-context";
  db.upsertCustomer(id, {});
  // 2026-09-04 (Mandate 2): หมุดถาวรปักจาก "ผลของ scorer" ไม่ใช่จากการกวาด regex ทับ
  // ประโยคของลูกค้า — scorer อ่านบทสนทนาทั้งก้อนแล้วสรุปโจทย์ออกมาเป็นฟิลด์ที่มีโครงสร้าง
  db.recordScore(id, 3, JSON.stringify({ score: 3, pain_point: "คิวคนไข้ล้นจนตอบแชทไม่ทัน", persona_type: "unknown" }));
  await say(id, "ผมเปิดคลินิกครับ อยากให้ AI ช่วยงานหน้าร้าน");
  assert.ok(Number(db.getCustomer(id).known_context_at) > 0, "โจทย์ที่ scorer อ่านออกต้องถูกปักหมุดถาวร");

  for (const text of ["อยู่กรุงเทพครับ", "เรียนที่ไหนครับ", "จอดรถยังไงครับ", "มีที่นั่งไหมครับ"]) {
    await say(id, text);
  }
  assert.ok(
    !db.recentTurns(id, 2).some((turn) => String(turn.content).includes("เปิดคลินิก")),
    "บริบทเดิมต้องหลุดหน้าต่างไปแล้ว — เหลือหมุดถาวรเป็นหลักฐานชิ้นเดียว",
  );

  await say(id, "ราคาเท่าไหร่ครับ");
  const prompt = systemOf(hermesFetch.calls.at(-1));
  assert.match(prompt, /ตอบราคาที่อนุมัติแล้วอย่างมั่นใจ/u, "คนที่เล่าโจทย์ให้เราแล้วต้องได้ราคาทันที");
  assert.doesNotMatch(prompt, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u, "ห้ามคัดกรองคนที่เรารู้จักอยู่แล้ว");
  db.close();
});
