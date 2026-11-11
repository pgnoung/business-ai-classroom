// price-directive-contradiction.test.mjs — ด่านหลักของงานนี้
//
// เหตุผลที่ต้องมีด่านนี้ (สรุปจากการรีวิวปรปักษ์สี่รอบที่ตกทั้งสี่รอบ):
// พรอมต์หนึ่งก้อนเคยมีคำสั่งเรื่องจังหวะราคาราว 15 บรรทัด ออกมาจากตัวประกอบ 5 ตัวใน 3 โมดูล
// แล้วสวนกันเอง แต่ละบรรทัดถูกเพิ่มจากเคสจริงที่มีวันที่กำกับ ไม่มีบรรทัดไหนผิดในตัวเอง —
// สิ่งที่ไม่เคยมีคือใครสักคนตรวจว่ามันพูดตรงกัน การไล่แก้ทีละบรรทัดจึงไม่เคยได้ผล
//
// รุ่นก่อนหน้าของด่านนี้เทียบด้วย "รายการวลี marker ที่เขียนมือไว้" ซึ่งปิดได้แค่ถ้อยคำที่มี
// คนเคยเห็น — รอบล่าสุดจึงยังมีสองบรรทัดหลุดผ่านไปได้ทั้งที่ด่านเขียว:
//   · เทิร์น quote_deferral_owed แบกทั้ง "ห้ามยื่นตัวเลขราคาให้เองโดยไม่ถูกถาม" และ
//     "คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ" พร้อมกัน
//   · pipeline สั่ง "ถ้าไม่มีข้อมูลให้บอกว่าขอเช็คกับทีมก่อน" ทุกเทิร์น ใต้หัวข้อ "ห้ามละเมิด
//     เด็ดขาด" ขณะที่เทิร์นคัดกรองแบนวลีนั้นด้วยชื่อ
//
// ด่านรุ่นนี้จึงกลับด้าน: คำสั่งเรื่องราคา **ต้องประกาศข้างของตัวเองตอนถูกเขียน** แล้วด่าน
// ตรวจสามอย่างต่อฉาก — (1) แต่ละแกนพูดข้างเดียว (2) พรอมต์ตรงกับคำตัดสิน
// (3) ไม่มีบรรทัดไหนพูดเรื่องเงินโดยไม่มีข้าง ข้อ (3) คือข้อที่ปิด "คลาส" ของบั๊กนี้จริง ๆ
// เพราะคำสั่งใหม่ที่ลืมประกาศข้างจะแดงทันที ไม่ใช่ล่องหนจนกว่าจะมีคนเขียน marker ให้
import test from "node:test";
import assert from "node:assert/strict";
import { baseRules, isClosingHandoffTurn, resolveProjectOpportunity } from "../src/pipeline.mjs";
import { approvedClassAmounts, decidePriceDisclosure } from "../src/priceDisclosure.mjs";
import {
  classifyPriceDirectives, ordersBannedPhrases, priceRule, SCREENING_BAN_DECLARATION,
  withPriceDirectiveCapture,
} from "../src/priceDirectives.mjs";
import { detectAiLevel, resolveClassRouting } from "../src/salesMotion.mjs";
import { validateSalesPolicy } from "../src/salesPolicy.mjs";
import { collapseInboundBurst, collapsePresetBurst, presetButtonFact } from "../src/presetButtons.mjs";
import { detectHandoffHint } from "../src/handoffIntent.mjs";
import { resolveContinuation } from "../src/continuationResolver.mjs";
import { buildOwnerLessonsSection, OWNER_LESSON_MONEY_REMINDER, OWNER_LESSON_RULES } from "../src/ownerLessons.mjs";
import { poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

// ฉากปุ่มสำเร็จรูปต้องประกอบผ่านตัวยุบของจริง (presetButtons.mjs) ไม่ใช่เขียน fact มือ —
// ไม่งั้นด่านจะเขียวกับข้อเท็จจริงที่ไปป์ไลน์ไม่มีวันผลิต
function buttonTurn(parts, history = []) {
  const view = collapseInboundBurst({ parts });
  const collapsedHistory = collapsePresetBurst(history);
  return {
    currentText: view.text,
    history: collapsedHistory,
    presetButton: presetButtonFact(view.view, collapsedHistory),
  };
}

const SALES_POLICY = validateSalesPolicy({
  schemaVersion: 1,
  businessId: "pngoung-tidkradum",
  customerJourneys: ["new_lead"],
  decisionRoles: ["owner"],
  routingPrior: { dominantInterest: "ai", share: 0.99, publicClaimAuthorized: false },
  courses: [{ id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic"] }],
  opportunities: [
    { type: "private_class", requiredSlots: ["organization_context", "audience_size"], optionalSlots: [], upsize: true, handoffOnComplete: true },
    { type: "in_house_training", requiredSlots: ["organization_context", "audience_size"], optionalSlots: [], upsize: true, handoffOnComplete: true },
  ],
});

const user = (content) => ({ role: "user", content });
const bot = (content) => ({ role: "assistant", content });
const stranger = (extra = {}) => ({
  line_user_id: "U-x", known_name: "", last_score: null,
  price_deferred_at: 0, price_quoted_at: 0, known_context_at: 0, price_pivot_deferred_at: 0, ...extra,
});
// ตารางราคาจริงของคลาสรวม — ฉากที่ต้องรู้ว่า "เคยแจ้งราคาไปแล้วหรือยัง" ต้องส่งชุดนี้เข้าไป
const AMOUNTS = approvedClassAmounts([
  { label: "AI Agent for Business", amount: 19900 },
  { label: "Early Bird", amount: 12900 },
]);
// สัญญาณมีโครงสร้างจาก scorer = "เรารู้จักโจทย์ของคนนี้แล้ว" (มาแทน regex ชุดเดิม)
const SCORED = { painPoint: "งานเอกสารกินเวลาทีมบัญชีทั้งวัน", personaType: "unknown" };
// คำถามคัดกรองบันไดระดับ AI ที่บอทเป็นคนส่งไปเอง — ฉากเคสจริงสองห้องข้างล่างต้องมีมันอยู่
// ในประวัติ ไม่งั้น "คำตอบบันได" จะลอยอยู่โดยไม่มีคำถามที่มันตอบ
const AI_LEVEL_LADDER = "ขออนุญาตถามสั้น ๆ หนึ่งข้อนะคะ ตอนนี้ใช้ AI ในงานระดับไหนคะ "
  + "1️⃣ ยังไม่เคยใช้งาน 2️⃣ เคยทดลองใช้บ้าง 3️⃣ ใช้ช่วยงานจริง 4️⃣ ใช้งานเป็นประจำ 5️⃣ เคยสร้าง Custom GPT";

// ฉากทั้งหมดคือเคสที่เคยพัง หรือเคยถูกยกมาในรีวิวปรปักษ์ว่าเป็นจุดที่คำสั่งสวนกัน
export const SCENARIOS = [
  {
    name: "คนแปลกหน้าถามราคาเป็นข้อความแรก",
    intent: "pricing",
    args: { customer: stranger(), currentText: "ราคาเท่าไหร่คะ", history: [] },
    expect: "defer",
  },
  {
    name: "คนแปลกหน้าถามราคาครั้งแรก แต่บอกเองว่าถูกถามมากไป",
    intent: "pricing",
    args: { customer: stranger(), currentText: "ไม่ต้องถามแล้ว ราคาเท่าไหร่", history: [] },
    expect: "quote",
  },
  {
    name: "ถามราคาซ้ำครั้งที่สอง (เคยขอถามคัดกรองไปแล้ว)",
    intent: "pricing",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: "ราคาเท่าไหร่คะ",
      history: [user("ราคาเท่าไหร่คะ"), bot("เรื่องราคาบอกได้เลยค่ะ เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นสั้น ๆ หนึ่งข้อนะคะ")],
    },
    expect: "quote",
  },
  {
    // ตรวจปรปักษ์ 2026-09-04: ฉากนี้เคยเขียว ทั้งที่พรอมต์แบก "ห้ามยื่นตัวเลขราคาให้เอง
    // โดยไม่ถูกถาม" (สาขา cold) และ "คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ" (บล็อกติดค้างราคา)
    // พร้อมกัน — ถ้อยคำของสาขา cold ไม่มีอยู่ในรายการ marker ชุดเดิมเลย
    name: "หลังคัดกรอง ลูกค้าตอบคำถามกลับมา (เทิร์นนี้ไม่มีคำเรื่องเงินเลย)",
    intent: "general",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: "ทำสำนักงานบัญชีครับ",
      history: [user("ราคาเท่าไหร่ครับ"), bot("เรื่องราคาบอกได้เลยค่ะ เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นสั้น ๆ หนึ่งข้อนะคะ")],
    },
    expect: "quote",
  },
  {
    name: "ขอส่วนลดมาเป็นข้อความแรก",
    intent: "pricing",
    flags: ["asks_discount"],
    args: { customer: stranger(), currentText: "ลดหน่อยได้ไหมคะ", history: [], hasApprovedFacts: true },
    expect: "defer",
  },
  {
    // ตรวจปรปักษ์ 2026-09-04 (Mandate 2): "เอ่ยชื่อคลาสของเรา" ถูกลบออกจากสัญญาณรู้จัก
    // — มันบอกแค่ว่าเขามาพร้อมบริบท ไม่ได้บอกอะไรเกี่ยวกับตัวเขา คนนี้จึงยังเป็นคนแปลกหน้า
    name: "เอ่ยชื่อคลาสของเราก่อน แล้วค่อยถามราคา (ยังไม่ใช่การรู้จักเขา)",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "ราคาเท่าไหร่คะ",
      history: [user("สนใจคลาส AI Agent for Business ค่ะ"), bot("ยินดีค่ะ")],
    },
    expect: "defer",
  },
  {
    // scorer อ่านโจทย์ของเขาออกแล้ว = สัญญาณมีโครงสร้างที่มาแทน regex ทั้งชุด
    name: "scorer อ่านโจทย์ของลูกค้าออกแล้ว แล้วเขาถามราคา",
    intent: "pricing",
    args: { customer: stranger(), currentText: "ราคาเท่าไหร่ครับ", history: [], scoreSignals: SCORED },
    expect: "quote",
  },
  {
    name: "ลูกค้า warm ถามราคา",
    intent: "pricing",
    args: { customer: stranger({ last_score: 6, known_context_at: 1_700_000_000_000 }), currentText: "ราคาเท่าไหร่คะ", history: [] },
    expect: "quote",
  },
  {
    name: "ลูกค้า hot ถามราคา",
    intent: "pricing",
    args: { customer: stranger({ last_score: 9, known_context_at: 1_700_000_000_000 }), currentText: "ราคาเท่าไหร่คะ", history: [] },
    expect: "quote",
  },
  {
    name: "pivot สอนสด -> ถามราคาออนไลน์ (เคสลูกค้า A)",
    intent: "pricing",
    args: {
      customer: stranger({ last_score: 6 }),
      currentText: "คลาสออนไลน์ ราคาเท่าไหร่คะ",
      history: [bot("โปรโมชั่น Early Bird 12,900 บาท/ท่าน"), user("จองที่นั่งยังไงคะ")],
    },
    expect: "defer",
  },
  {
    name: "ลูกค้าเล่าโจทย์ธุรกิจตัวเองที่มีคำว่าราคา (ไม่ได้ถามค่าเรียน)",
    intent: "general",
    args: { customer: stranger(), currentText: "ผมทำธุรกิจ อยากให้ AI ช่วยคิดราคาให้ลูกค้าครับ", history: [] },
    expect: "defer",
  },
  // ตัวอ่านเดิม (asksAboutPrice) ไม่ครอบคำพวกนี้เลย — คนกลุ่มนี้จึงเคยตกไปสาขา cold
  // แล้วโดนสั่งห้ามใส่ราคา พร้อม ๆ กับที่ salesMotion สั่งให้ตอบตรงด้วยโปรฯ
  ...["ค่าใช้จ่ายประมาณไหนคะ", "ผ่อนได้ไหมคะ", "มัดจำเท่าไรคะ", "ชำระยังไงคะ", "ขอใบเสนอราคาหน่อยค่ะ ราคาเท่าไหร่"].map((text) => ({
    name: `คำเรื่องเงินที่ตัวอ่านเดิมมองไม่เห็น หลังคัดกรองไปแล้ว — "${text}"`,
    intent: "pricing",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: text,
      history: [user("ราคาเท่าไหร่ครับ"), bot("เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ")],
    },
    expect: "quote",
  })),
  ...["ค่าใช้จ่ายประมาณไหนคะ", "ผ่อนได้ไหมคะ", "มัดจำเท่าไรคะ", "ชำระยังไงคะ"].map((text) => ({
    name: `คำเรื่องเงินที่ตัวอ่านเดิมมองไม่เห็น จากคนแปลกหน้า — "${text}"`,
    intent: "pricing",
    args: { customer: stranger(), currentText: text, history: [] },
    expect: "defer",
  })),
  {
    name: "คนแปลกหน้าถามรอบเรียน (สัญญาณซื้อ schedule แต่ไม่ใช่เรื่องเงิน)",
    intent: "general",
    args: { customer: stranger(), currentText: "เรียนวันไหนบ้างคะ", history: [] },
    expect: "defer",
  },
  {
    name: "คนแปลกหน้าถามวิธีสมัคร (สัญญาณซื้อ enroll แต่ไม่ใช่เรื่องเงิน)",
    intent: "general",
    args: { customer: stranger(), currentText: "สมัครยังไงคะ", history: [] },
    expect: "defer",
  },
  {
    // Mandate 2: "เอ่ยงาน in-house" ไม่ใช่การรู้จักเขา — และโหมดคัดกรองก่อนเสนอของ pipeline
    // ก็ต้องพูดฝั่งเดียวกับคำตัดสิน (ฉบับ defer) ไม่ใช่ประกาศชนะแล้วสั่งสวน
    name: "งาน in-house ถามราคาตรง ๆ (โหมดคัดกรองก่อนเสนอต้องพูดฝั่ง defer)",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "อยากให้ไปสอน in-house ที่บริษัท ราคาเท่าไหร่ครับ",
      history: [],
      salesPolicy: SALES_POLICY,
    },
    expect: "defer",
  },
  {
    name: "งาน in-house ค้างอยู่ แต่เทิร์นนี้ลูกค้าเล่าบริบทเฉย ๆ",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "ทีมงานอยู่กรุงเทพครับ",
      history: [user("อยากจัดอบรมพนักงานครับ"), bot("ยินดีค่ะ")],
      salesPolicy: SALES_POLICY,
      salesState: { opportunity: { type: "in_house_training", slots: {}, handoffReady: false } },
    },
    expect: "defer",
  },
  {
    // ตรวจปรปักษ์ 2026-09-04 (Mandate 3): แกนโปรฯ เคยมีตัวจับงาน project สองตัวที่ไม่ตรงกัน
    // ฉากนี้คือช่องว่างระหว่างสองตัวนั้นเป๊ะ ๆ — งาน in-house ค้างอยู่ใน sales state
    // (pipeline ประกาศโหมดคัดกรองก่อนเสนอ = ห้ามยกโปรฯ) แต่เทิร์นนี้ไม่มีคำว่า in-house
    // และไม่มีจำนวนคน ตัวจับเดิมของ priceDisclosure จึงตอบว่า "ยกโปรฯ ได้" แล้วยัดแม่แบบ
    // "PROMOTION Early Bird 📌" ลงไปในพรอมต์ก้อนเดียวกัน
    name: "งาน in-house ค้างใน sales state แล้วลูกค้า hot ถามราคา (แกนโปรฯ ต้องพูดข้างเดียว)",
    intent: "pricing",
    args: {
      customer: stranger({ last_score: 9, known_context_at: 1_700_000_000_000 }),
      currentText: "ราคาเท่าไหร่ครับ",
      history: [user("ทีมงานอยู่กรุงเทพครับ"), bot("ยินดีค่ะ")],
      salesPolicy: SALES_POLICY,
      salesState: { opportunity: { type: "in_house_training", slots: {}, handoffReady: false } },
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
    expectPromo: false,
  },
  {
    name: "โน้ตทีมงาน + กติกาสินค้า (ช่องข้อความอิสระที่ถูก push ท้ายสุด)",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "ราคาเท่าไหร่คะ",
      history: [],
      handoffNotes: [{ author: "chomphu", text: "ลูกค้ารายนี้เคยคุยทางโทรศัพท์แล้ว" }],
      productRules: "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ",
      customerTags: ["ลูกค้าใหม่"],
    },
    expect: "defer",
  },
  {
    // ขอบเขตที่ประกาศไว้ตรง ๆ: ข้อความอิสระที่ "คนเป็นคนเขียน" จัดข้างให้ไม่ได้ — โน้ต
    // ทีมงานที่เอ่ยตัวเลขเงินจึงต้องถูกยกเว้นอย่างชัดเจน ไม่ใช่ผ่านด่านไปเพราะบังเอิญ
    name: "โน้ตทีมงานที่เอ่ยตัวเลขเงิน (ข้อมูลของคน ไม่ใช่คำสั่งที่โค้ดปล่อย)",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "ราคาเท่าไหร่คะ",
      history: [],
      handoffNotes: [{ author: "chomphu", text: "ลูกค้าตกลงราคา 12,900 บาททางโทรศัพท์แล้ว" }],
    },
    expect: "defer",
    ignoreLines: ["- [chomphu] ลูกค้าตกลงราคา 12,900 บาททางโทรศัพท์แล้ว"],
  },
  {
    // ที่นั่งคงเหลือของรอบออนไลน์เอ่ยคำว่า "ราคาพิเศษมีจำนวนจำกัด" — เป็นบรรทัดที่โค้ดปล่อย
    // จึงต้องมีข้าง ฉากนี้มีไว้ให้ด่านความครบถ้วนได้เห็นมันจริง ๆ (สคีนาริโออื่นไม่ส่ง seatRules)
    name: "เทิร์นคัดกรองที่มีบรรทัดที่นั่งคงเหลือของรอบออนไลน์",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "ราคาเท่าไหร่คะ",
      history: [],
      seatRules: [
        "- ที่นั่งคงเหลือล่าสุดจากทีมงาน (ข้อมูลนี้ใหม่กว่าคลังความรู้เสมอ ให้ยึดอันนี้):",
        "  · 10 ม.ค. (รอบสอนสด) เหลือ 4 ที่นั่ง — บอกตัวเลขนี้ได้ แล้วชวนยืนยันสิทธิ์แบบไม่กดดัน",
        "- รอบที่รับได้ไม่จำกัดจำนวน (คลาสออนไลน์) — ห้ามพูดคำว่า “ไม่จำกัด” หรือบอกตัวเลขที่นั่งเด็ดขาด:",
        "  · 5 มี.ค. (รอบออนไลน์) — ให้บอกว่า “ราคาพิเศษมีจำนวนจำกัด” แล้วชวนยืนยันสิทธิ์แบบไม่กดดัน ห้ามบอกว่ามีที่นั่งเหลือเท่าไร",
      ],
    },
    expect: "defer",
  },
  {
    name: "โหมดเทรนภายใน — คนแปลกหน้าถามราคา",
    intent: "pricing",
    args: { customer: stranger(), currentText: "ราคาเท่าไหร่คะ", history: [], trainingMockMode: true },
    expect: "defer",
  },
  {
    // ข้อ 5: คำบอก "รูปแบบการเรียน" ไม่ใช่ชื่อคลาส — คนนี้คือคนแปลกหน้าล้วน ๆ
    name: "คนแปลกหน้าถาม 'คลาสออนไลน์ราคาเท่าไหร่' เป็นข้อความแรก",
    intent: "pricing",
    args: { customer: stranger(), currentText: "คลาสออนไลน์ราคาเท่าไหร่คะ", history: [], approvedAmounts: AMOUNTS },
    expect: "defer",
  },
  {
    // ข้อ 13: social proof ไม่ใช่การแจ้งราคา — การคัดกรองต้องไม่ถูกลัดวงจร
    name: "คนแปลกหน้าถามราคาหลังได้ยิน social proof ที่มีเลขหลักพัน",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "ราคาเท่าไหร่คะ",
      history: [user("สนใจครับ"), bot("พี่ง้วงสอนมาแล้วกว่า 5,000 คน รอบนี้รับ 20 ที่นั่งค่ะ")],
      approvedAmounts: AMOUNTS,
    },
    expect: "defer",
  },
  {
    // ข้อ 6: pivot ที่เกิดหลังคัดกรองแต่ยังไม่เคยให้ตัวเลข = ห้ามเลี่ยงรอบสอง
    name: "pivot สอนสด -> ออนไลน์ หลังคัดกรองไปแล้วโดยยังไม่เคยให้ตัวเลข",
    intent: "pricing",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000, last_score: 6 }),
      currentText: "คลาสออนไลน์ ราคาเท่าไหร่คะ",
      history: [bot("จองที่นั่งได้เลยค่ะ"), user("ขอถามก่อนครับ")],
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
  },
  {
    // Mandate 3: การเลี่ยงด้วย pivot ต้องมีจุดจบ — เคยเลี่ยงไปแล้วหนึ่งครั้ง = รอบนี้ต้องแจ้งราคา
    name: "pivot รอบสอง หลังเคยเลี่ยงด้วยคำถามสอนสด/ออนไลน์ไปแล้ว",
    intent: "pricing",
    args: {
      customer: stranger({ price_pivot_deferred_at: 1_700_000_000_000, price_quoted_at: 1_700_000_100_000, last_score: 6 }),
      currentText: "คลาสออนไลน์ ราคาเท่าไหร่คะ",
      history: [bot("โปรโมชั่น Early Bird 12,900 บาท/ท่าน"), user("จองที่นั่งยังไงคะ")],
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
  },
  {
    // Mandate 3: นโยบายข้อ 4 ชนะจังหวะ pivot — คนที่บอกว่าถูกถามมากไปต้องได้ตัวเลข
    name: "ถูกถามมากไป + ขอราคาคลาสออนไลน์ (ความหงุดหงิดต้องชนะ pivot)",
    intent: "pricing",
    args: {
      customer: stranger({ last_score: 6 }),
      currentText: "ไม่ต้องถามแล้ว ขอราคาคลาสออนไลน์เลยค่ะ",
      history: [bot("โปรโมชั่น Early Bird 12,900 บาท/ท่าน"), user("จองที่นั่งยังไงคะ")],
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
  },
  {
    // ข้อ 11: กติกา v1.2.2 ที่หายไป — ลูกค้าเย็น จังหวะราคาเปิดแล้ว แต่เทิร์นนี้ไม่ได้ถามเรื่องเงิน
    // mode ของคำตัดสิน = "ประตูราคาเปิดแล้วไหม" ส่วนข้างของพรอมต์ = "คำตอบนี้ต้องมีตัวเลขไหม"
    // เทิร์นนี้ประตูเปิด (เคยได้ราคาไปแล้ว) แต่เขาไม่ได้ถามเรื่องเงิน กติกา v1.2.2 จึงสั่ง
    // "ห้ามยื่นตัวเลขราคาให้เองโดยไม่ถูกถาม" — เป็นคนละคำถาม ไม่ใช่พรอมต์สวนกับคำตัดสิน
    name: "ลูกค้าเย็นที่ได้ราคาไปแล้ว ถามเรื่องอื่นที่ไม่ใช่เงิน",
    promptSide: "defer",
    intent: "general",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000, price_quoted_at: 1_700_000_100_000, last_score: 2 }),
      currentText: "เรียนที่ไหนคะ",
      history: [],
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
  },
  {
    // ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า, ข้อ 1): ฉากเดียวกับข้างบน แต่เปลี่ยนคำถามจาก
    // "เรียนที่ไหน" (สัญญาณ location — salesMotion ไม่สนใจ) เป็น "สมัครยังไง" (สัญญาณ enroll
    // ซึ่งอยู่ใน COMMERCIAL_SIGNALS) — ช่องว่างระหว่างตัวอ่านสองตัวอยู่ตรงนี้พอดี:
    // warmth ถามด้วย asksAboutMoney (เท็จ) แล้วสั่ง "ห้ามยื่นตัวเลขราคาให้เอง"
    // salesMotion ถามด้วย COMMERCIAL_SIGNALS (จริง) แล้วสั่ง "ตอบตรง ๆ รวมโปรฯ early bird"
    // ในพรอมต์ก้อนเดียวกัน และมันถูก push ทีหลัง = ชนะทุกครั้ง (นำด้วยส่วนลด ผิดนโยบายข้อ 3)
    name: "ลูกค้าเย็นที่ได้ราคาไปแล้ว ถามวิธีสมัคร (สัญญาณ enroll ไม่ใช่คำถามเรื่องเงิน)",
    promptSide: "defer",
    intent: "general",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000, price_quoted_at: 1_700_000_100_000, last_score: 2 }),
      currentText: "สมัครยังไงคะ",
      history: [],
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
    expectPromo: false,
  },
  {
    // ฝาแฝดของฉากข้างบนบนสัญญาณ schedule — "รอบหน้า" ไม่ใช่คำเรื่องเงินเลยสักตัว
    name: "ลูกค้าเย็นที่ได้ราคาไปแล้ว ถามรอบเรียนถัดไป (สัญญาณ schedule)",
    promptSide: "defer",
    intent: "general",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000, price_quoted_at: 1_700_000_100_000, last_score: 2 }),
      currentText: "รอบหน้าเรียนวันไหนคะ",
      history: [],
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
    expectPromo: false,
  },
  {
    // ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า, ข้อ 3): สาขา warm ของ warmth ไม่เคยมีฉากไหนเดินเข้า
    // เลยสักฉาก ด่านความครบถ้วนจึงไม่เคยเห็นสองบรรทัด "รีวิวนักเรียนจริง" ที่พูดว่า
    // "ธุรกิจ/บทบาทใกล้เคียงลูกค้า" — คำว่า "บทบาท" มีคำว่า "บาท" อยู่ข้างใน (ไทยไม่มีช่องว่าง)
    // ทั้งสองบรรทัดจึงถูกอ่านว่า "พูดเรื่องเงินแต่ไม่ประกาศข้าง" ทั้งที่ไม่ได้พูดเรื่องเงินเลย
    name: "ลูกค้า warm เล่าโจทย์ตัวเอง (สาขา warm ปล่อยกติการีวิวที่มีคำว่า 'บทบาท')",
    intent: "general",
    args: {
      customer: stranger({ last_score: 6 }),
      currentText: "งานเอกสารกินเวลาทั้งวันเลยค่ะ",
      history: [],
      approvedAmounts: AMOUNTS,
    },
    expect: "defer",
  },
  {
    name: "ลูกค้า warm ลังเล (สาขาความลังเลปล่อยกติการีวิวอีกบรรทัด)",
    intent: "general",
    args: {
      customer: stranger({ last_score: 6 }),
      currentText: "ยังไม่แน่ใจว่าจะคุ้มไหมคะ",
      history: [],
      approvedAmounts: AMOUNTS,
    },
    expect: "defer",
  },
  {
    // ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า, ข้อ 2): กติกาส่วนลดฉบับ "มีตารางราคาแล้ว" ของ
    // pipeline ไม่เคยมีฉากไหนเดินเข้าเลย ทั้งที่ท่อนท้ายของมันคือวลีเดียวกับความล้มเหลว
    // v1.4.39 ("ขอเช็คกับทีมงาน") และมันยิงในเทิร์นที่ลูกค้าต่อรองราคา = ฉากของเคสจริงเป๊ะ ๆ
    name: "ขอส่วนลดหลังคัดกรองไปแล้ว (กติกาส่วนลดฉบับมีตาราง ห้ามสั่งให้ไปเช็คกับทีม)",
    intent: "pricing",
    flags: ["asks_discount"],
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: "ลดหน่อยได้ไหมคะ",
      history: [user("ราคาเท่าไหร่คะ"), bot("เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ")],
      approvedAmounts: AMOUNTS,
      hasApprovedFacts: true,
    },
    expect: "quote",
  },
  {
    // ข้อ 2: งาน project แจ้งราคาได้ แต่ห้ามยกตารางโปรฯ — แกน promo ต้องพูดข้างเดียวเช่นกัน
    name: "ทีม 6 คนถามราคา หลัง scorer อ่านโจทย์ออกแล้ว (แจ้งราคาได้ แต่ห้ามยกโปรฯ)",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "ราคาเท่าไหร่ครับ",
      history: [user("ทีมมี 6 คนครับ"), bot("รับทราบค่ะ")],
      approvedAmounts: AMOUNTS,
      scoreSignals: SCORED,
    },
    expect: "quote",
    expectPromo: false,
  },
  {
    // ตรวจปรปักษ์ 2026-09-04 (Mandate 3): กติกา asks_discount ใน pipeline เคยดูแค่ mode
    // จึงสั่ง "ไล่ตารางส่วนลด/โปรโมชั่นที่อนุมัติ" ในเทิร์นงาน project ที่กติกาอื่นในพรอมต์
    // ก้อนเดียวกันสั่ง "ห้ามยกตารางโปรโมชั่นทั้งชุด" — แกนโปรฯ เป็นแกนของตัวเอง
    name: "ทีม 6 คนขอส่วนลด (แจ้งราคาได้ แต่กติกาส่วนลดต้องไม่ยกตารางโปรฯ)",
    intent: "pricing",
    flags: ["asks_discount"],
    args: {
      customer: stranger(),
      currentText: "ลดหน่อยได้ไหมครับ",
      history: [user("ทีมมี 6 คนครับ"), bot("รับทราบค่ะ")],
      approvedAmounts: AMOUNTS,
      scoreSignals: SCORED,
      hasApprovedFacts: true,
    },
    expect: "quote",
    expectPromo: false,
  },
  {
    name: "งาน in-house ถามราคาโดยไม่มี sales policy (เส้นกติกาสินค้าอย่างเดียว)",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "อยากจัดอบรมพนักงานที่บริษัท ราคาเท่าไหร่ครับ",
      history: [],
      approvedAmounts: AMOUNTS,
    },
    expect: "defer",
  },
  {
    // ข้อ 1: ตัวประกอบตัวที่ห้าเคยยิงคำสั่งเรื่องราคาใส่ทุกพรอมต์รวมถึงเทิร์นต่อรอง
    name: "คนแปลกหน้าต่อรองราคาเป็นข้อความแรก",
    intent: "pricing",
    args: { customer: stranger(), currentText: "แพงจังเลยครับ ลดได้อีกไหม", history: [], hasApprovedFacts: true },
    expect: "defer",
  },
  {
    name: "ลูกค้าถามสิทธิ์นักเรียนเก่าตั้งแต่ยังไม่รู้จักกัน",
    intent: "pricing",
    args: { customer: stranger(), currentText: "เคยเรียนกับพี่ง้วงแล้ว มีส่วนลดนักเรียนเก่าไหมคะ", history: [] },
    expect: "defer",
  },
  {
    // ตรวจปรปักษ์ 2026-09-04: ลูกค้า hot ที่ขอเลื่อนคลาส — conversationStyle สั่ง
    // "ห้ามรั้งด้วยโปรโมชั่น" ขณะที่ salesMotion เห็นสัญญาณ schedule ("รอบหน้า") แล้วสั่ง
    // "ตอบตรง ๆ รวมโปรโมชั่น early bird" ในพรอมต์ก้อนเดียวกัน — รายการ marker เดิมมองไม่เห็น
    // เพราะฝั่ง "ห้ามรั้งด้วยโปรฯ" ไม่เคยมีใครใส่ marker ให้
    name: "ลูกค้า hot ขอเลื่อนคลาส (ห้ามรั้งด้วยโปรฯ ต้องไม่ชนกับคำสั่งยกโปรฯ)",
    intent: "general",
    args: {
      customer: stranger({ last_score: 9 }),
      currentText: "ขอเลื่อนไปเรียนรอบหน้าค่ะ พอดีลูกไม่สบาย",
      history: [],
      approvedAmounts: AMOUNTS,
    },
    expect: "defer",
    expectPromo: false,
    expectSilentPrice: true,
  },
  /* ---- ตรวจปรปักษ์ 2026-09-04 (รอบที่หก): จุดบอดของเมทริกซ์เอง ----
   *
   * V8 coverage บนฉาก 46 ฉากเดิมชี้ว่าตัวปล่อยคำสั่งเรื่องราคาสามตัวมี execution count = 0
   * แปลว่าคำกล่าวอ้างเรื่อง "ความครบถ้วน" มีผลเฉพาะกิ่งที่เมทริกซ์บังเอิญเดินผ่าน — ซึ่งเป็น
   * เงื่อนไขเดียวกับที่ซ่อนคำสั่งสวนกันสองบรรทัดไว้เมื่อสองรอบก่อน */
  {
    // ตัวปล่อยที่ coverage = 0 ตัวที่ 1: บล็อก continuation ของตัวประกอบตัวที่ห้า
    // มันยัด "ประโยคข้อเสนอของผู้ช่วยเอง" เข้าพรอมต์คำต่อคำ แล้วสั่ง "ทำสิ่งนั้นต่อทันที"
    // แบบไม่มีเงื่อนไข — ถ้าประโยคนั้นคือการรับปากจะส่งราคา บรรทัดนี้ก็เป็นคำสั่งฝั่ง quote
    // และของเดิมเป็น rules.push() เปล่า ๆ จึงไม่เคยอ่านคำตัดสินและไม่เคยมีข้าง
    name: "continuation ที่ค้างเรื่องราคาไว้ ในเทิร์นที่ยังไม่ถึงจังหวะราคา",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "ครับ",
      history: [user("สนใจครับ"), bot("เดี๋ยวลูกแพรส่งรายละเอียดและราคาคลาสให้นะคะ")],
      continuation: { action: "continue_previous_offer", offerText: "เดี๋ยวลูกแพรส่งรายละเอียดและราคาคลาสให้นะคะ" },
      approvedAmounts: AMOUNTS,
    },
    expect: "defer",
    expectPromo: false,
  },
  {
    // ฝาแฝดฝั่ง quote: ห้องเดียวกันหลังคัดกรองไปแล้วโดยยังไม่เคยให้ตัวเลข (ติดค้างราคา)
    // บรรทัด continuation ต้องอยู่ฝั่งเดียวกับบล็อกติดค้างราคา ไม่ใช่ลอยไม่มีข้าง
    name: "continuation ที่ค้างเรื่องราคาไว้ ในเทิร์นที่ติดค้างราคาอยู่",
    intent: "general",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: "ครับ",
      history: [user("ราคาเท่าไหร่ครับ"), bot("เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ")],
      continuation: { action: "continue_previous_offer", offerText: "เดี๋ยวลูกแพรสรุปราคาคลาสที่เหมาะกับพี่ให้นะคะ" },
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
  },
  {
    // ข้อเสนอที่ไม่เกี่ยวกับเงินต้องไม่ถูกลากเข้าแกนราคา — ไม่งั้นทุกเทิร์นที่มี continuation
    // จะกลายเป็นคำสั่งเรื่องราคาโดยไม่จำเป็น แล้วไปชนกับฝั่งที่ถูกต้องของเทิร์นนั้น
    name: "continuation ที่ไม่เกี่ยวกับเงิน (ส่งโปสเตอร์) ในเทิร์นคัดกรอง",
    intent: "pricing",
    args: {
      customer: stranger(),
      currentText: "ราคาเท่าไหร่คะ",
      history: [user("สนใจค่ะ"), bot("เดี๋ยวลูกแพรส่งโปสเตอร์คลาสให้ดูนะคะ")],
      continuation: { action: "continue_previous_offer", offerText: "เดี๋ยวลูกแพรส่งโปสเตอร์คลาสให้ดูนะคะ" },
    },
    expect: "defer",
  },
  {
    // ตัวปล่อยที่ coverage = 0 ตัวที่ 2: กฎ scarcity early bird ของ salesMotion —
    // priceRule("promo") ตัวเดียวในระบบที่ยิงตอนลูกค้า "ไม่ได้ถาม" จึงเป็นบรรทัดที่เสี่ยง
    // ผิดนโยบายข้อ 3 (ห้ามนำด้วยส่วนลด) มากที่สุด แต่ไม่เคยมีฉากไหนเดินเข้าเลยสักฉาก
    name: "ลูกค้า hot เล่าโจทย์เฉย ๆ ไม่ได้ถามอะไรเลย (คะแนนล้วนห้าม scarcity early bird)",
    intent: "general",
    args: {
      customer: stranger({ last_score: 9 }),
      currentText: "อยากให้ทีมทำงานเอกสารเร็วขึ้นค่ะ",
      history: [],
      approvedAmounts: AMOUNTS,
    },
    expect: "defer",
  },
  {
    // ตัวปล่อยที่ coverage = 0 ตัวที่ 3: สาขา "ลูกค้าขอเทียบทุกคลาสเอง" ซึ่งแทนบล็อก
    // ขอบเขตราคาทั้งบล็อก (รวมแม่แบบแจ้งราคาและแม่แบบโปรฯ) — ถ้อยคำของมันไม่มีคำเรื่องเงิน
    // สักตัว ด่านความครบถ้วนจึงมองไม่เห็น และไม่มีฉากไหนเคยเดินเข้ามาก่อน
    name: "ขอเทียบราคาทุกคลาสหลังคัดกรองไปแล้ว (สาขาไล่ราคาหลายคลาส)",
    intent: "pricing",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: "ราคาแต่ละคลาสเท่าไหร่คะ",
      history: [user("ราคาเท่าไหร่คะ"), bot("เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ")],
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
  },
  {
    // ตัวปล่อยที่ coverage = 0 ตัวที่ 4: กติกาส่วนลดฉบับ "ยังไม่มีตารางราคาอนุมัติ"
    // (ธุรกิจติดตั้งใหม่ / คลังยังว่าง) — ท่อนของมันไล่ชื่อวลีต้องห้ามทั้งสามวลี
    // จึงเป็นบรรทัดที่เสี่ยงติดด่านถ้อยคำต้องห้ามที่สุดในไฟล์ แต่ไม่เคยถูกเดินผ่านเลย
    name: "ขอส่วนลดหลังคัดกรอง โดยยังไม่มีตารางราคาอนุมัติ",
    intent: "pricing",
    flags: ["asks_discount"],
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: "ลดหน่อยได้ไหมคะ",
      history: [user("ราคาเท่าไหร่คะ"), bot("เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ")],
    },
    expect: "quote",
  },
  {
    // ฝาแฝดในโหมดเทรนภายใน — ท่อนนี้สั่ง "ห้ามบอกให้รอทีมงานยืนยัน" ซึ่งมีวลีต้องห้าม
    // อยู่ในประโยคเดียวกับคำปฏิเสธพอดี ระยะห่างของ "ห้าม" กับวลีจึงต้องมีฉากยืนยันจริง
    name: "ขอส่วนลดในโหมดเทรนภายใน โดยยังไม่มีตารางราคาอนุมัติ",
    intent: "pricing",
    flags: ["asks_discount"],
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: "ลดหน่อยได้ไหมคะ",
      history: [user("ราคาเท่าไหร่คะ"), bot("เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ")],
      trainingMockMode: true,
    },
    expect: "quote",
  },
  /* ---------------- ปุ่มคำถามสำเร็จรูป (เคสจริง Facebook 2026-09-04 12:14 UTC) ---------------- */
  // โมเดลเห็น "คิดค่าบริการเท่าไหร่" สามบรรทัดจากการกดปุ่มสามครั้ง อ่านเป็นการทวง แล้วเขียน
  // "ขออภัยที่ยังไม่ได้ตอบราคาให้ตรง ๆ นะคะ" พร้อมเทราคาเต็ม ทั้งที่คำตัดสินเป็น defer —
  // บรรทัดเรื่องปุ่ม (conversationStyle) ต้องอยู่ข้างเดียวกับคำตัดสินในทุกฉากที่ปุ่มโผล่ได้
  {
    name: "ปุ่มราคาเดิมกดสามครั้งติด จากคนแปลกหน้า (เคสจริง 2026-09-04)",
    intent: "pricing",
    args: { customer: stranger(), ...buttonTurn(["คิดค่าบริการเท่าไหร่", "คิดค่าบริการเท่าไหร่", "คิดค่าบริการเท่าไหร่"]) },
    expect: "defer",
  },
  {
    name: "กดสี่ปุ่มต่างกันในก้อนเดียว จากคนแปลกหน้า (เคสจริง 2026-09-03)",
    intent: "pricing",
    args: {
      customer: stranger(),
      ...buttonTurn(["จองคิวได้ไหม", "คุณให้บริการอะไรบ้าง", "คิดค่าบริการเท่าไหร่", "คุณให้บริการอะไรบ้าง"]),
    },
    expect: "defer",
  },
  {
    name: "ปุ่มราคาหลังเคยคัดกรองไปแล้วหนึ่งครั้ง (นโยบายข้อ 2 ยังชนะ)",
    intent: "pricing",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      ...buttonTurn(["คิดค่าบริการเท่าไหร่"], [
        user("คิดค่าบริการเท่าไหร่"),
        bot("เรื่องราคาบอกได้เลยค่ะ เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นสั้น ๆ หนึ่งข้อนะคะ"),
      ]),
    },
    expect: "quote",
  },
  {
    // คำลงท้าย = มีคนพิมพ์ — ต้องไม่ถูกอ่านเป็นปุ่ม และยังเป็นการถามราคาครั้งแรกตามปกติ
    name: "พิมพ์เอง \"คิดค่าบริการเท่าไหร่ครับ\" (ไม่ใช่ปุ่ม)",
    intent: "pricing",
    args: { customer: stranger(), ...buttonTurn(["คิดค่าบริการเท่าไหร่ครับ"]) },
    expect: "defer",
  },
  {
    name: "ลูกค้า warm กดปุ่มราคา",
    intent: "pricing",
    args: { customer: stranger({ last_score: 6 }), ...buttonTurn(["คิดค่าบริการเท่าไหร่"]) },
    expect: "defer",
  },
  {
    name: "คนแปลกหน้ากดปุ่มที่ไม่ใช่เรื่องเงิน (\"คุณให้บริการอะไรบ้าง\")",
    intent: "general",
    args: { customer: stranger(), ...buttonTurn(["คุณให้บริการอะไรบ้าง"]) },
    expect: "defer",
  },
  /* ---- เคสจริงบนโปรดักชัน 2026-09-04: สองห้องที่ถูกเลื่อนราคาผิดด้วยเหตุเดียวกัน ----
   *
   * ทั้งสองห้องตอบบันไดระดับ AI ที่ "เราถามเอง" ไปแล้ว แต่ตอบด้วยคำปฏิเสธสั้น ๆ ที่
   * detectAiLevel อ่านไม่ออก (ยืนยันในเครื่อง: "ยังไม่เคยครับ" และ "ไม่เคยครับ" คืน null
   * ทั้งคู่) คำตัดสินจึงเป็น cold -> defer ทั้งที่เรารู้จักเขาแล้ว และโมเดลก็แจ้งราคาสวน
   * คำตัดสินทั้งสองห้อง — พรอมต์สั่งอย่าง โมเดลทำอีกอย่าง คือรูปเดียวกับบั๊กที่ไฟล์นี้กัน
   * (คำตอบบันไดของทั้งสองห้องเกิดก่อน deploy จึงยังไม่มีหมุด known_context_at ให้พึ่ง
   *  ส่วนนั้นเป็นไปตามที่ออกแบบ — ที่ต้องแก้คือตัวอ่าน) */
  {
    name: "ห้อง A: ตอบบันไดว่า 'ยังไม่เคยครับ' แล้วกดปุ่มราคาสามครั้ง (เคสจริง 2026-09-04)",
    intent: "pricing",
    args: {
      customer: stranger({ last_score: 3 }),
      ...buttonTurn(["คิดค่าบริการเท่าไหร่", "คิดค่าบริการเท่าไหร่", "คิดค่าบริการเท่าไหร่"], [
        bot(AI_LEVEL_LADDER), user("ยังไม่เคยครับ"), bot("รับทราบค่ะ"), user("งานประจำ"), bot("รับทราบค่ะ"),
      ]),
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
  },
  {
    name: "ห้อง B: เปิดห้อง 'ยังครับ แต่สนใจ' ตอบบันได 'ไม่เคยครับ' แล้วถามวันเรียนกับราคา (เคสจริง 2026-09-04)",
    intent: "pricing",
    args: {
      customer: stranger({ last_score: 3 }),
      currentText: "คอร์สที่เปิดสอนมีวันไหน และราคาเท่าไหร่ของแต่ละคอร์ส",
      history: [user("ยังครับ แต่สนใจ"), bot(AI_LEVEL_LADDER), user("ไม่เคยครับ"), bot("รับทราบค่ะ")],
      approvedAmounts: AMOUNTS,
    },
    expect: "quote",
  },
  /* ---- คำสั่งพี่ง้วง 2026-09-05 (รอบสาม): เทิร์นที่ "มีใบ้ส่งไม้ต่อ" ต้องเป็นกลาง ----
   *
   * รอบสองแก้คำสั่งสวนกันด้วยการใส่คำสั่งสวนทางกลับไป ("ห้ามปิดท้ายด้วยคำถามใด ๆ",
   * "ห้ามสำรวจโจทย์เพิ่ม", "ห้ามเสนอเส้นทาง/ขั้นถัดไป") ซึ่งแก้อาการแต่สร้างโรคที่ร้ายกว่า:
   * ใบ้ระดับ "สนใจสมัครค่ะ" ก็บังคับให้ลูกแพรเขียนประโยคส่งไม้ต่อได้ แล้วกุญแจดอกที่ 2
   * (ซึ่งควรเป็นคำตัดสินอิสระ) ก็เหลือแค่ตรายางของดอกที่ 1
   *
   * ฉากชุดนี้จึงตรวจ "ความเป็นกลาง" สามข้อพร้อมกัน (ดูแกนข้างล่าง):
   *   1. ไม่มีบรรทัดไหนสั่งให้ถามคำถาม (ระงับเท่านั้น ห้ามสั่งสวนทาง)
   *   2. แกนราคาพูดข้างเดียว และเทิร์นที่ลูกค้าไม่ได้ถามเรื่องเงิน ต้องไม่มีคำสั่งราคาเลย
   *   3. กติกาใบ้ที่เหลืออยู่ต้องเป็น "เงื่อนไข" ไม่ใช่คำสั่งปิดหัวข้อ */
  {
    // ข้อความแรกของห้องคือการจอง — เขาไม่ได้ถามเรื่องเงิน จึงต้องเงียบเรื่องราคาทั้งเทิร์น
    name: "cold ข้อความแรกคือการจอง (เทิร์นส่งไม้ต่อ ไม่ถามราคา)",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "ขอจองไว้ก่อนค่ะ",
      history: [],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("ขอจองไว้ก่อนค่ะ"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // ข้อ 17 ของรอบสอง: ข้อความแรกของห้อง + รูปบันไดถูกอนุมัติ = พรอมต์เคยสั่ง
    // "แนบคำถามคัดกรองระดับการใช้ AI เสมอ" ในก้อนเดียวกับกติกาส่งไม้ต่อ
    name: "ข้อความแรกของห้องคือการจอง + รูปบันไดถูกอนุมัติ (ข้อ 17)",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "ขอจองไว้ก่อนค่ะ",
      history: [],
      approvedAmounts: AMOUNTS,
      approvedImageKeys: ["ai-stage-ladder"],
      handoffIntent: detectHandoffHint("ขอจองไว้ก่อนค่ะ"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // R1: ใบ้ที่ "อ่อนที่สุด" ในระบบ — คนที่พิมพ์แค่ว่าสนใจ ต้องได้พรอมต์ที่เป็นกลาง
    // ไม่มีคำสั่งไหนบังคับให้ลูกแพรจบบทสนทนา (นี่คือฉากที่ทำให้กุญแจสองดอกเป็นดอกเดียว)
    name: "cold \"สนใจสมัครค่ะ\" (ใบ้อ่อน — พรอมต์ต้องเป็นกลาง)",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "สนใจสมัครค่ะ",
      history: [],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("สนใจสมัครค่ะ"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    name: "warm ขอสมัคร (เทิร์นส่งไม้ต่อ ไม่ถามราคา)",
    intent: "general",
    args: {
      customer: stranger({ last_score: 6 }),
      currentText: "ขอสมัครค่ะ",
      history: [user("สนใจคลาสค่ะ"), bot("ยินดีค่ะ")],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("ขอสมัครค่ะ"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // ตัดสินใจแล้ว + ถามราคาในข้อความเดียว = ต้องได้ตัวเลขในข้อความนี้ (อาจเป็นข้อความสุดท้าย)
    // และห้ามมีคำสั่งคัดกรองปนอยู่ ทั้งที่ห้องนี้เคยถูกเลี่ยงราคามาแล้วหนึ่งครั้ง
    name: "เคยเลี่ยงราคาแล้ว แล้วลูกค้าจองพร้อมถามราคา (เทิร์นส่งไม้ต่อ)",
    intent: "pricing",
    args: {
      customer: stranger({ price_deferred_at: 1_700_000_000_000 }),
      currentText: "ขอจองค่ะ ราคาเท่าไหร่คะ",
      history: [user("ราคาเท่าไหร่คะ"), bot("ขออนุญาตถามสั้น ๆ หนึ่งข้อนะคะ")],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("ขอจองค่ะ ราคาเท่าไหร่คะ"),
    },
    expect: "quote",
  },
  {
    // แจ้งราคาไปแล้วในห้องนี้ แล้วลูกค้าตัดสินใจ — เขาไม่ได้ถามราคาซ้ำ จึงไม่ต้องพูดเรื่องเงินอีก
    name: "แจ้งราคาไปแล้ว แล้วลูกค้า warm ตัดสินใจจองรอบ (เทิร์นส่งไม้ต่อ)",
    intent: "general",
    args: {
      customer: stranger({ last_score: 7, price_quoted_at: 1_700_000_000_000 }),
      currentText: "โอเคค่ะ ขอจองรอบ 26 เลยค่ะ",
      history: [user("ราคาเท่าไหร่คะ"), bot("คลาสนี้ ปกติ 19,900 บาท/ท่าน ค่ะ")],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("โอเคค่ะ ขอจองรอบ 26 เลยค่ะ"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // ลูกค้า hot ขอเบอร์ทีมงาน — ฉากเดียวในไฟล์ที่คำถามชวนคุย early bird ยิงได้จริง
    name: "hot ขอเบอร์ทีมงาน (คำถามชวนคุย early bird ต้องเงียบ)",
    intent: "general",
    args: {
      customer: stranger({ last_score: 9 }),
      currentText: "ขอเบอร์ทีมงานค่ะ",
      history: [user("สนใจคลาสค่ะ"), bot("ยินดีค่ะ")],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("ขอเบอร์ทีมงานค่ะ"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // คนแปลกหน้าเย็น ๆ ขอเบอร์ทีมงาน — ฉากที่บรรทัดขั้น discovery ("ทำความเข้าใจโจทย์
    // ของลูกค้าก่อน") ยิงจริง ต้องถูกระงับ ไม่ใช่ถูกสั่งสวนทาง
    name: "cold ขอเบอร์ทีมงาน (บรรทัดขั้น discovery ต้องเงียบ)",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "ขอเบอร์ทีมงานหน่อยค่ะ",
      history: [user("สวัสดีค่ะ"), bot("สวัสดีค่ะ ยินดีที่ได้คุยกันนะคะ")],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("ขอเบอร์ทีมงานหน่อยค่ะ"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // ระดับ 5: คำแนะนำคลาสของ buildClassRoutingRules สั่ง "ถามก่อนว่าโจทย์ต้องเชื่อมหลายระบบ"
    // ซึ่งเป็นคำสั่งให้ถามคำถาม — ต้องถูกระงับในเทิร์นที่มีใบ้
    name: "ระดับ 5 แล้วขอสมัครเลย (คำแนะนำคลาสที่สั่งให้ถามต้องเงียบ)",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "เคยสร้าง Custom GPT แล้วค่ะ ขอสมัครเลยค่ะ",
      history: [],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("เคยสร้าง Custom GPT แล้วค่ะ ขอสมัครเลยค่ะ"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // ลูกค้าบอกเองว่าถูกถามมากไปแล้วสั่งจอง — นโยบายข้อ 4 (ความหงุดหงิดชนะ) เคยดันให้
    // เป็น quote ทั้งที่เขาไม่ได้ถามเรื่องเงินเลยสักคำ
    name: "ถูกถามมากไปแล้วสั่งจองเลย (เทิร์นส่งไม้ต่อ ไม่ถามราคา)",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "ไม่ต้องถามแล้วค่ะ ขอจองเลย",
      history: [],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("ไม่ต้องถามแล้วค่ะ ขอจองเลย"),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // R3(c): ถอนคำพูดในเทิร์นนี้ = ใบ้ย้อนหลังหมดฤทธิ์ พรอมต์ต้องกลับเป็นเทิร์นปกติทุกไบต์
    name: "ลังเลหลังเคยพูดเรื่องจอง (ถอนคำพูดล้างใบ้ย้อนหลัง)",
    promptSide: "defer",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "ขอคิดดูก่อนนะคะ",
      history: [user("ขอจองค่ะ"), bot("ได้เลยค่ะ สนใจรอบไหนดีคะ")],
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("ขอคิดดูก่อนนะคะ", { previousTexts: ["ขอจองค่ะ"] }),
    },
    expect: "defer",
    expectSilentPrice: true,
  },
  {
    // ข้อ 18: งาน project มี flow ส่งต่อของตัวเอง — ใบ้ต้องถูกปิดทั้งใบในเทิร์นแบบนี้
    // ไม่งั้นพรอมต์จะสั่งทั้ง "เก็บข้อมูลทีละหนึ่งคำถามต่อเทิร์น" และ "ห้ามถามคัดกรองเพิ่ม"
    // แล้วห้องจะถูกปิดกลางคันโดยที่ทีมไม่ได้ slot อะไรเลย
    name: "งาน in-house ค้างอยู่ แล้วลูกค้าขอใบเสนอราคา (ข้อ 18: flow project เป็นเจ้าของ)",
    promptSide: "defer",
    intent: "general",
    args: {
      customer: stranger(),
      currentText: "ขอใบเสนอราคาค่ะ",
      history: [user("อยากจัดอบรมพนักงานครับ"), bot("ยินดีค่ะ")],
      salesPolicy: SALES_POLICY,
      salesState: { opportunity: { type: "in_house_training", slots: {}, handoffReady: false } },
      approvedAmounts: AMOUNTS,
      handoffIntent: detectHandoffHint("ขอใบเสนอราคาค่ะ"),
    },
    expect: "defer",
  },
];

// Owner-authorized 2026-09-13: exercise the actual composed prompt, not just
// isolated builders. A stale Hot score or old price debt cannot override care.
for (const currentText of ["ขอบคุณค่ะ", "ขอคิดดูก่อนค่ะ", "วันนั้นไม่สะดวกค่ะ"]) {
  SCENARIOS.push({ name: `ดูแลแทนเร่งขาย: ${currentText}`, intent: "general", expect: "defer", expectSilentPrice: true, expectPromo: false,
    args: { customer: { ...stranger(), last_score: 10, price_deferred_at: 1 }, currentText, history: [], approvedAmounts: AMOUNTS } });
}
SCENARIOS.push({ name: "ขอพักแต่ถามราคา ต้องตอบราคาโดยไม่กลายเป็นงาน project", intent: "general", expect: "quote", expectPromo: false,
  args: { customer: { ...stranger(), last_score: 10 }, currentText: "วันนั้นไม่สะดวกค่ะ ราคาเท่าไหร่คะ", history: [], approvedAmounts: AMOUNTS } });
for (const currentText of ["คุณให้บริการอะไรบ้าง", "ราคาเทอมละเท่าไหร่"]) {
  SCENARIOS.push({ name: `คะแนน 10 จากปุ่มล้วนไม่เปิดขาย: ${currentText}`, intent: "general", expect: "defer", expectPromo: false,
    args: { customer: { ...stranger(), last_score: 10 }, ...buttonTurn([currentText]), approvedAmounts: AMOUNTS } });
}
const longOfferHistory = [bot(`ลูกแพรจะสรุป${"รายละเอียดของคลาสและการเรียนรู้ ".repeat(7)}พร้อมราคาคลาสให้ สนใจไหมคะ`)];
SCENARIOS.push({ name: "รับข้อเสนอราคาที่อยู่หลังอักษร 140 ต้องได้รับราคา", intent: "general", expect: "quote",
  args: { customer: stranger(), currentText: "ค่ะ", history: longOfferHistory, approvedAmounts: AMOUNTS,
    continuation: resolveContinuation({ latestText: "ค่ะ", history: longOfferHistory }) } });

function decisionOf(scenario) {
  const {
    customer, currentText = "", history = [], approvedAmounts = null,
    scoreSignals = null, salesPolicy = null, salesState = null, presetButton = null,
    handoffIntent = null,
  } = scenario.args;
  return decidePriceDisclosure({
    text: currentText,
    history,
    score: Number.isInteger(customer?.last_score) ? customer.last_score : null,
    knownName: customer?.known_name || "",
    customer,
    inboundFlags: scenario.flags || [],
    approvedAmounts,
    scoreSignals,
    // ต้องใช้ตัวจับงาน project ตัวเดียวกับที่ baseRules ใช้ ไม่งั้นด่านจะเทียบกับคำตัดสินคนละก้อน
    projectOpportunity: resolveProjectOpportunity({ currentText, salesPolicy, salesState }),
    // ข้อเท็จจริงเรื่องปุ่มสำเร็จรูป — ก้อนเดียวกับที่ baseRules ได้รับ
    presetButton,
    // คำสั่งพี่ง้วง 2026-09-05: เทิร์นส่งไม้ต่อ = ประตูราคาต้องเปิด (เหตุผลเต็มอยู่ใน
    // decidePriceDisclosure) — ต้องคำนวณด้วยสูตรเดียวกับ baseRules เป๊ะ ๆ ไม่งั้นด่านนี้
    // จะเทียบพรอมต์กับคำตัดสินคนละก้อน แล้วแดงในฉากที่ไม่มีอะไรผิดจริง
    closingTurn: isClosingHandoffTurn(handoffIntent, resolveProjectOpportunity({ currentText, salesPolicy, salesState })),
  });
}

// ---- แกนที่สาม (คำสั่งพี่ง้วง 2026-09-05 รอบสาม): "เทิร์นที่มีใบ้ต้องไม่สั่งให้ถาม" ----
//
// รอบสองตรวจแกนนี้ด้วยรายการ "คำสั่งที่ห้ามมี" ซึ่งรวมทั้งคำสั่งที่ให้ถาม และคำสั่งที่ให้
// ขายต่อ — แล้วโค้ดก็ไปทำให้มันเขียวด้วยการใส่คำสั่งสวนทาง ("ห้ามปิดท้ายด้วยคำถามใด ๆ")
// ซึ่งคือสิ่งที่ทำให้กุญแจสองดอกไม่เป็นอิสระต่อกัน
//
// รอบนี้แกนนี้ตรวจ **คุณสมบัติ** ไม่ใช่รายการอาการ:
//   · พรอมต์ที่มีใบ้ ต้องไม่มีบรรทัดไหน "สั่งให้ถามคำถาม" เลย (ระงับ ไม่ใช่สั่งสวนทาง)
//   · พรอมต์ที่มีใบ้ ต้องไม่มีคำสั่งสวนทางเรื่องการปิดท้าย/การขาย (ห้ามมีคำว่า "ห้ามปิดท้าย
//     ด้วยคำถามใด ๆ" หรือ "ห้ามสำรวจโจทย์เพิ่ม") — ลูกแพรต้องเลือกเอง
//   · กติกาใบ้ที่เหลืออยู่ต้องเป็นเงื่อนไข ("ถ้าเขายืนยันชัด… · ถ้ายังเป็นคำถาม…")
//
// รายการนี้เป็นถ้อยคำจริงของตัวประกอบแต่ละตัว — เทสต์คู่แฝดข้างล่างพิสูจน์ว่ามันยังมีอยู่
// จริงในเทิร์นปกติ ถ้าวันหนึ่งถ้อยคำถูกแก้ ด่านนี้จะไม่กลายเป็นด่านที่เขียวเพราะไม่มีอะไรให้เจอ
const QUESTION_ORDERS = Object.freeze([
  "ถามท้ายข้อความเพียงข้อเดียวว่าอยากนำ AI ไปช่วยงานอะไร",
  "แนบรูปบันได 7 Stage",                        // pipeline: บันไดคัดกรองข้อความแรก
  "เก็บข้อมูลทีละหนึ่งคำถามต่อเทิร์น",              // pipeline: เก็บ slot งาน project
  "ขอถามคัดกรองหนึ่งข้อก่อน",                    // pipeline: สาขาขอส่วนลดฉบับ defer
  "ปิดด้วยคำถามคัดกรองข้อเดียว",                  // warmth: สาขาคัดกรองครั้งเดียว
  "โดยถามก่อนว่าโจทย์ต้องเชื่อมหลายระบบ",           // salesMotion: คำแนะนำคลาสระดับ 5
  "ต้องขอข้อมูลบริษัท จำนวนผู้เรียน สถานที่ และผู้ติดต่อ", // salesMotion: คำแนะนำคลาสทีมใหญ่
]);

// คำสั่งสวนทางที่รอบสองใส่ไว้ — ห้ามกลับมาอีก ไม่ว่าจะด้วยถ้อยคำไหน
const COUNTER_ORDERS = Object.freeze([
  "ห้ามปิดท้ายด้วยคำถามใด ๆ",
  "ห้ามสำรวจโจทย์เพิ่ม",
  "ห้ามเสนอเส้นทาง/ขั้นถัดไป",
  "ไม่ต้องสำรวจโจทย์เพิ่ม",
  "ไม่ต้องเสนอเส้นทาง",
]);

function render(lines) {
  return lines.map((line) => `    · ${line.trim().slice(0, 170)}`).join("\n") || "    (ไม่มี)";
}

for (const scenario of SCENARIOS) {
  test(`จังหวะราคา: พรอมต์ต้องพูดข้างเดียว — ${scenario.name}`, () => {
    const captured = withPriceDirectiveCapture(() => baseRules(scenario.intent, scenario.flags || [], scenario.args));
    const { bySide, unclassified } = classifyPriceDirectives(captured, { ignore: scenario.ignoreLines || [] });

    // ---- แกนที่หนึ่ง: ใส่ตัวเลขราคาในเทิร์นนี้ได้หรือยัง ----
    assert.ok(
      !(bySide.defer.length && bySide.quote.length),
      "พรอมต์ก้อนเดียวมีคำสั่งเรื่องราคาทั้งสองข้างพร้อมกัน — โมเดลจะเลือกข้างเอง (ซึ่งคือบั๊กที่ระบบนี้ถูกสร้างมาเพื่อกัน)\n"
      + `  ฉาก: ${scenario.name}\n`
      + `  ข้อความลูกค้า: ${scenario.args.currentText}\n`
      + "  ฝั่งห้ามใส่ราคา:\n" + render(bySide.defer) + "\n"
      + "  ฝั่งให้แจ้งราคา:\n" + render(bySide.quote),
    );
    if (scenario.expectSilentPrice) {
      // R1: เทิร์นที่มีใบ้ส่งไม้ต่อและลูกค้าไม่ได้ถามเรื่องเงิน = ห้ามมีคำสั่งฝั่งไหนเลย
      // (ไม่ใช่แค่ "ไม่ขัดกัน" — คนที่เพิ่งบอกว่าจะจอง ไม่ควรถูกถามคัดกรองและไม่ควรถูกยัดตัวเลข)
      assert.deepEqual(bySide.defer, [], `ฉากเงียบเรื่องราคา ห้ามมีคำสั่งฝั่งห้ามใส่ราคา\n${render(bySide.defer)}`);
      assert.deepEqual(bySide.quote, [], `ฉากเงียบเรื่องราคา ห้ามมีคำสั่งฝั่งให้แจ้งราคา\n${render(bySide.quote)}`);
    } else {
      // ฉากทุกฉากต้องมีคำสั่งเรื่องราคาอย่างน้อยหนึ่งข้าง ไม่งั้น "ผ่าน" เพราะพรอมต์เงียบสนิท
      // ซึ่งจะทำให้ด่านนี้กลายเป็นด่านที่วัดอะไรไม่ได้เลยโดยไม่มีใครรู้
      const promptSide = scenario.promptSide || scenario.expect;
      const side = promptSide === "defer" ? bySide.defer : bySide.quote;
      assert.ok(side.length > 0, `ฉากนี้ควรมีคำสั่งฝั่ง ${promptSide} อย่างน้อยหนึ่งบรรทัด แต่ไม่พบเลย\n${captured.text}`);
    }

    // พรอมต์ต้องตรงกับคำตัดสิน ไม่ใช่แค่ตรงกับตัวเอง
    const decision = decisionOf(scenario);
    assert.equal(decision.mode, scenario.expect, `ฉากนี้ควรตัดสินเป็น ${scenario.expect} แต่ได้ ${decision.mode} (${decision.reason})`);

    // ---- แกนที่สอง: โปรโมชั่น ----
    assert.ok(
      !(bySide.promo.length && bySide.no_promo.length),
      "พรอมต์ก้อนเดียวมีทั้ง 'ยกโปรโมชั่นได้' และ 'ยังไม่ยกโปรโมชั่น' พร้อมกัน\n"
      + `  ฉาก: ${scenario.name}\n`
      + "  ฝั่งยกโปรฯ:\n" + render(bySide.promo) + "\n"
      + "  ฝั่งยังไม่ยกโปรฯ:\n" + render(bySide.no_promo),
    );
    if (scenario.expectPromo === false) {
      assert.equal(bySide.promo.length, 0, `ฉากนี้ห้ามมีคำสั่งยกโปรฯ เลย แต่พบ:\n${render(bySide.promo)}`);
    }

    // ---- ด่านความครบถ้วน: ไม่มีบรรทัดไหนพูดเรื่องเงินโดยไม่ประกาศข้าง ----
    // นี่คือข้อที่ปิด "คลาส" ของบั๊ก ไม่ใช่แค่ตัวอย่างที่เจอรอบนี้
    assert.deepEqual(
      unclassified, [],
      "มีบรรทัดที่พูดถึงราคา/บาท/โปรฯ/ส่วนลด แต่ไม่ได้ประกาศข้างผ่าน priceRule() — "
      + "ด่านกันคำสั่งสวนกันมองไม่เห็นบรรทัดพวกนี้เลย ซึ่งคือวิธีที่คำสั่งสวนกันหลุดออกไปทุกรอบ\n"
      + `  ฉาก: ${scenario.name}\n` + render(unclassified),
    );

    // ---- แกนความเป็นกลาง: เทิร์นที่มีใบ้ต้องไม่สั่งให้ถาม และต้องไม่สั่งสวนทาง ----
    if (scenario.args.handoffIntent) {
      const closing = isClosingHandoffTurn(
        scenario.args.handoffIntent,
        resolveProjectOpportunity({
          currentText: scenario.args.currentText || "",
          salesPolicy: scenario.args.salesPolicy || null,
          salesState: scenario.args.salesState || null,
        }),
      );
      const ordersQuestion = QUESTION_ORDERS.filter((phrase) => captured.text.includes(phrase));
      const countersOrder = COUNTER_ORDERS.filter((phrase) => captured.text.includes(phrase));
      if (closing) {
        assert.deepEqual(
          ordersQuestion, [],
          "เทิร์นที่มีใบ้ส่งไม้ต่อยังมีบรรทัดที่สั่งให้ถามคำถาม — พรอมต์ก้อนเดียวกันมีกติกาใบ้ที่บอกว่า "
          + "ถ้าเขายืนยันแล้วห้ามถามคัดกรองเพิ่ม สองอย่างนี้อยู่ด้วยกันไม่ได้\n"
          + `  ฉาก: ${scenario.name}\n` + render(ordersQuestion),
        );
        assert.deepEqual(
          countersOrder, [],
          "เทิร์นที่มีใบ้มีคำสั่งสวนทางแบบไม่มีเงื่อนไข — นี่คือสิ่งที่ทำให้กุญแจดอกที่ 2 กลายเป็น "
          + "ตรายางของดอกที่ 1 (ลูกแพรถูกบังคับให้เขียนประโยคส่งไม้ต่อ) ต้องระงับเท่านั้น ห้ามสั่งสวน\n"
          + `  ฉาก: ${scenario.name}\n` + render(countersOrder),
        );
        // กติกาใบ้ที่เหลืออยู่ต้องมีจริง และต้องเป็นเงื่อนไขสองทาง (ยืนยันแล้ว / ยังไม่ยืนยัน)
        assert.match(
          captured.text, /ไม่ถามคำถามคัดกรองเพิ่ม|ไม่ชวนคุยขายต่อ/u,
          `ฉากที่มีใบ้ต้องมีกติกาใบ้อยู่จริง ไม่งั้นแกนนี้เขียวเพราะไม่มีอะไรให้ตรวจ\n${scenario.name}`,
        );
        assert.match(
          captured.text, /ถ้ายังเป็นคำถาม แค่สนใจ หรือยังลังเล|ถ้าเขาแค่เล่าว่าทีมงานเคยติดต่อไปแล้ว/u,
          `กติกาใบ้ต้องมีทางออกสำหรับคนที่ยังไม่ได้ยืนยัน ไม่งั้นมันคือคำสั่งปิดหัวข้อ\n${scenario.name}`,
        );
      } else {
        // งาน project: ใบ้ต้องถูกปิดทั้งใบ กติกาส่งไม้ต่อจึงต้องไม่โผล่มาแข่งกับ flow เดิม
        assert.doesNotMatch(
          captured.text, /ไม่ถามคำถามคัดกรองเพิ่ม/u,
          `ฉากงาน project ต้องไม่มีกติกาส่งไม้ต่อปน (flow เก็บ slot เป็นเจ้าของเทิร์นนี้)\n${scenario.name}`,
        );
      }
    }

    // ---- แกนถ้อยคำต้องห้าม: ทุกเทิร์น ไม่ใช่เฉพาะเทิร์นคัดกรอง ----
    //
    // ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า): ด่านนี้เคยรันเฉพาะฉากที่คำตัดสินเป็น DEFER_SCREENING
    // ซึ่งพลาดเคสจริงที่บันทึกไว้ทั้งเคส — v1.4.39 ("ขอลูกแพรเช็คตัวเลขกับทีมงานอีกครั้งนะคะ")
    // เกิดกับลูกค้าที่ *ต่อรองราคาต่ำกว่าตาราง* คือเทิร์นแจ้งราคา ไม่ใช่เทิร์นคัดกรอง
    // และเทิร์นแจ้งราคาก็แบกกฎ "ห้ามหลบ ห้ามบอกให้รอทีมงาน" อยู่ด้วย = สวนกับตัวเองเหมือนกัน
    // ตารางราคาที่อนุมัติคือคำตอบสุดท้ายทุกเทิร์น จึงไม่มีเทิร์นไหนที่วลีพวกนี้ถูกต้อง
    const offenders = captured.directives
      .map((item) => item.text)
      .filter((value) => !value.includes(SCREENING_BAN_DECLARATION) && ordersBannedPhrases(value).length);
    assert.deepEqual(
      offenders, [],
      "พรอมต์สั่งให้พูดถ้อยคำที่ระบบแบนด้วยชื่อ (ขอเช็กก่อน / ขอเช็คกับทีม / รอทีมงาน / "
      + "ยังบอกไม่ได้ / แจ้งราคาไม่ได้) — ความล้มเหลว v1.4.39 ที่บันทึกไว้เป็นผลผลิตของบรรทัดแบบนี้ตรง ๆ\n"
      + `  ฉาก: ${scenario.name}\n${render(offenders)}`,
    );
  });
}

/* ------- เคสจริงสองห้อง: เหตุผลของคำตัดสินต้องชี้ไปที่ "เขาตอบบันไดของเราแล้ว" ------- */
//
// ด่านข้างบนตรวจแค่ `mode` ซึ่งเขียวได้ด้วยเหตุผลอื่น (อุ่นพอ / เคยคัดกรองไปแล้ว / เคยได้
// ราคาไปแล้ว) — ห้องจริงทั้งสองห้องคะแนนยังเย็นและไม่มีหมุดอะไรเลยสักตัว ประตูราคาจึงต้อง
// เปิดด้วยสัญญาณเดียวเท่านั้นคือ "เขาตอบบันไดระดับ AI ที่เราถามเองไปแล้ว" ถ้าวันไหนเหตุผล
// เปลี่ยนไปเป็นอย่างอื่น แปลว่าฉากนี้เขียวด้วยเส้นทางอื่น ไม่ใช่ด้วยการซ่อมตัวอ่าน
test("จังหวะราคา: เคสจริงสองห้อง เปิดประตูราคาด้วย 'เขาตอบบันไดระดับ AI แล้ว' เท่านั้น", () => {
  for (const prefix of ["ห้อง A:", "ห้อง B:"]) {
    const scenario = SCENARIOS.find((item) => item.name.startsWith(prefix));
    assert.ok(scenario, `ไม่พบฉากเคสจริง "${prefix}"`);
    const { currentText = "", history = [] } = scenario.args;
    assert.equal(
      resolveClassRouting({ text: currentText, history }).level, 1,
      `${prefix} ผลคัดกรองต้องอ่านออกเป็นระดับ 1 ไม่งั้นพรอมต์จะประกาศ "ยังไม่ทราบระดับ"`,
    );
    const decision = decisionOf(scenario);
    assert.equal(decision.mode, "quote", `${prefix} ต้องได้ราคา ไม่ใช่ถูกคัดกรองซ้ำ`);
    assert.equal(
      decision.reason, "quote_answered_ai_level",
      `${prefix} เหตุผลต้องเป็น "เขาตอบบันไดระดับ AI แล้ว" แต่ได้ ${decision.reason}`,
    );
  }
  // ต้นเหตุตรง ๆ ของทั้งสองห้อง: ตัวอ่านเคยคืน null ให้คำตอบที่ลูกค้าพิมพ์จริงทั้งคู่
  const context = { history: [{ role: "assistant", content: "เคยใช้ AI มาบ้างไหมคะ?" }] };
  assert.equal(detectAiLevel("ยังไม่เคยครับ", context), 1, "คำตอบของห้อง A");
  assert.equal(detectAiLevel("ไม่เคยครับ", context), 1, "คำตอบของห้อง B");
  assert.equal(detectAiLevel("ยังครับ แต่สนใจ"), null, "ข้อความเปิดห้องไม่มีคำถามอ้างอิง");
});

/* ------------------------- ด่านนี้จับได้จริงหรือเปล่า ------------------------- */

test("จังหวะราคา: ด่านแกนราคาจับได้จริง — ยัดคำสั่งสวนทางเข้าไปแล้วต้องแดง", () => {
  const clean = withPriceDirectiveCapture(() => baseRules("pricing", [], { customer: stranger(), currentText: "ราคาเท่าไหร่คะ", history: [] }));
  const before = classifyPriceDirectives(clean);
  assert.ok(before.bySide.defer.length > 0 && before.bySide.quote.length === 0, "ฉากตั้งต้นต้องเป็นฝั่ง defer ล้วน");

  const poisoned = withPriceDirectiveCapture(() => {
    const rules = baseRules("pricing", [], { customer: stranger(), currentText: "ราคาเท่าไหร่คะ", history: [] });
    return `${rules}\n${priceRule("quote", "- ลูกค้าถามเรื่องราคาตรง ๆ: ตอบราคาที่อนุมัติแล้วอย่างมั่นใจ")}`;
  });
  const after = classifyPriceDirectives(poisoned);
  assert.ok(after.bySide.defer.length > 0 && after.bySide.quote.length > 0, "ด่านต้องมองเห็นคำสั่งฝั่งตรงข้ามที่ถูกเติมเข้ามา");
});

test("จังหวะราคา: ด่านแกนโปรฯ จับได้จริง — ยัดแม่แบบโปรฯ เข้าเทิร์นงาน project แล้วต้องแดง", () => {
  const args = {
    customer: stranger(),
    currentText: "ราคาเท่าไหร่ครับ",
    history: [user("ทีมมี 6 คนครับ"), bot("รับทราบค่ะ")],
    approvedAmounts: AMOUNTS,
    scoreSignals: SCORED,
  };
  const clean = classifyPriceDirectives(withPriceDirectiveCapture(() => baseRules("pricing", [], args)));
  assert.equal(clean.bySide.promo.length, 0, "ฉากตั้งต้นต้องไม่มีคำสั่งยกโปรฯ เลย");
  assert.ok(clean.bySide.no_promo.length > 0, "ฉากตั้งต้นต้องมีคำสั่งฝั่ง 'ยังไม่ยกโปรฯ'");

  const after = classifyPriceDirectives(withPriceDirectiveCapture(() => {
    const rules = baseRules("pricing", [], args);
    return `${rules}\n${priceRule("promo", "PROMOTION Early Bird 📌")}`;
  }));
  assert.ok(after.bySide.promo.length > 0 && after.bySide.no_promo.length > 0, "ด่านต้องมองเห็นแม่แบบโปรฯ ที่ถูกเติมเข้ามา");
});

// ด่านที่สำคัญที่สุดของงานรอบนี้: คำสั่งใหม่ที่ "ลืมประกาศข้าง" ต้องแดง ไม่ใช่ล่องหน
// (รายการ marker ชุดเดิมล่องหนโดยสมบูรณ์ ซึ่งคือสาเหตุที่บั๊กคลาสนี้กลับมาได้ทุกรอบ)
test("จังหวะราคา: คำสั่งเรื่องเงินที่ไม่ประกาศข้าง ต้องถูกจับได้ว่ายังไม่มีข้าง", () => {
  const captured = withPriceDirectiveCapture(() => {
    const rules = baseRules("pricing", [], { customer: stranger(), currentText: "ราคาเท่าไหร่คะ", history: [] });
    // เขียนแบบที่คนเพิ่มกติกาใหม่เขียนกันจริง ๆ — push สตริงลงไปตรง ๆ ไม่ผ่าน priceRule
    return `${rules}\n- ถ้าลูกค้าถามราคา ให้บอกว่าขอเช็คกับทีมก่อนนะคะ`;
  });
  const { unclassified } = classifyPriceDirectives(captured);
  assert.deepEqual(unclassified, ["- ถ้าลูกค้าถามราคา ให้บอกว่าขอเช็คกับทีมก่อนนะคะ"]);
});

test("จังหวะราคา: priceRule ปฏิเสธข้างที่ไม่มีอยู่จริง (กันสะกดผิดแล้วเงียบ)", () => {
  assert.throws(() => priceRule("quotes", "- อะไรสักอย่าง"), /ไม่มีอยู่จริง/u);
});

test("จังหวะราคา: นอก capture ต้องไม่เก็บสถานะอะไรเลย (โปรดักชันต้นทุนศูนย์)", () => {
  const value = priceRule("quote", "- บรรทัดนี้เกิดนอก capture");
  assert.equal(value, "- บรรทัดนี้เกิดนอก capture");
  const captured = withPriceDirectiveCapture(() => priceRule("defer", "- บรรทัดในนี้"));
  assert.equal(captured.directives.length, 1, "capture ต้องเห็นเฉพาะบรรทัดที่เกิดข้างในตัวเอง");
});

/* ---- แกนถาม-ห้ามถาม ต้องจับได้จริง: รายการต้องห้ามยัง "มีอยู่จริง" ในเทิร์นปกติ ---- */
//
// ด่านที่ตรวจว่า "ไม่มีถ้อยคำ X ในพรอมต์" มีจุดจบแบบเดียวเสมอ: วันหนึ่งมีคนแก้ถ้อยคำ
// ในตัวประกอบ แล้วด่านก็เขียวตลอดกาลเพราะไม่มีอะไรให้เจออีกแล้ว — เทสต์นี้คือด้านตรงข้าม
// ของแกนนั้น: ฉากเดียวกันเป๊ะ ๆ แต่ถอดใบ้ออก ต้องเห็นคำสั่งพวกนั้นกลับมาครบทุกบรรทัด
test("จังหวะราคา: แกนความเป็นกลางจับได้จริง — ถอดใบ้ส่งไม้ต่อออกแล้วคำสั่งเดิมต้องกลับมา", () => {
  const cases = [
    { phrase: "แนบรูปบันได 7 Stage", scenarioName: "ข้อความแรกของห้องคือการจอง + รูปบันไดถูกอนุมัติ (ข้อ 17)" },
    { phrase: "ถามท้ายข้อความเพียงข้อเดียวว่าอยากนำ AI ไปช่วยงานอะไร", scenarioName: "ระดับ 5 แล้วขอสมัครเลย (คำแนะนำคลาสที่สั่งให้ถามต้องเงียบ)" },
  ];
  for (const { phrase, scenarioName } of cases) {
    const scenario = SCENARIOS.find((item) => item.name === scenarioName);
    assert.ok(scenario, `ไม่พบฉาก "${scenarioName}"`);
    const withHint = baseRules(scenario.intent, scenario.flags || [], scenario.args);
    const withoutHint = baseRules(scenario.intent, scenario.flags || [], { ...scenario.args, handoffIntent: null });
    assert.ok(
      withoutHint.includes(phrase),
      `ถ้อยคำ "${phrase}" หายไปจากตัวประกอบแล้ว — รายการ QUESTION_ORDERS ต้องตามไปแก้ `
      + "ไม่งั้นแกนความเป็นกลางจะเขียวเพราะไม่มีอะไรให้เจอ",
    );
    assert.ok(!withHint.includes(phrase), `ใบ้ส่งไม้ต่อต้องปิดคำสั่ง "${phrase}" ในฉาก ${scenarioName}`);
  }
  // และงาน project ต้องได้บรรทัดเก็บ slot กลับมาเสมอ (ใบ้ถูกปิดทั้งใบ ไม่ใช่ถูกกรองบางบรรทัด)
  const project = SCENARIOS.find((item) => item.name.startsWith("งาน in-house ค้างอยู่ แล้วลูกค้าขอใบเสนอราคา"));
  assert.ok(baseRules(project.intent, [], project.args).includes("เก็บข้อมูลทีละหนึ่งคำถามต่อเทิร์น"));
});

/* ======== 2026-09-28: บทเรียนที่เจ้าของสอนจากแผง "ทำไมตอบแบบนี้" (src/ownerLessons.mjs) ======== */
//
// บทเรียนคือคำของคน (เหมือนโน้ตทีมงาน) ที่ต่อท้ายกติกาทุกเทิร์น และพูดเรื่องราคาได้ทุกทาง —
// "บอกราคาเลย ไม่ต้องถามคัดกรอง" ก็สอนได้ ถ้าปล่อยให้บรรทัดแบบนี้นับเป็นคำสั่งฝั่ง quote
// ทุกฉาก defer จะแดงทันที ถ้าปล่อยให้ล่องหน ด่านนี้ก็ตาบอด จึงออกแบบให้ชัดสามชั้น:
//   1. บรรทัดที่โค้ดเขียนในหัวข้อบทเรียน (ลำดับชั้น/ห้ามแต่งราคา/บรรทัดย้ำเรื่องเงิน) ประกาศ neutral
//   2. บรรทัดคำของคนคืนออกมาเป็น dataLines — ยกเว้นเจาะจงรายบรรทัดแบบเดียวกับ ignoreLines
//   3. หัวข้อพูดลำดับชั้นเป็นกติกาข้อแรก: กติกาเรื่องราคา/เงิน/การส่งต่อด้านบนชนะเสมอ
// เทสต์ข้างล่างต่อหัวข้อบทเรียนที่ "สั่งเรื่องราคาสวนทาง" เข้าไปทุกฉาก แล้วยืนยันว่าข้างของพรอมต์
// ไม่ขยับเลยแม้แต่บรรทัดเดียว และไม่มีบรรทัดเงินที่ไม่มีข้างหลุดออกมา
const PRICE_TEACHING_LESSONS = Object.freeze([
  {
    id: "lesson-quote", status: "active", topic: "ถามราคา", decided_at: 2,
    customer_text: "ราคาเท่าไหร่คะ", ai_text: "ขออนุญาตถามเบื้องต้นหนึ่งข้อก่อนนะคะ",
    teaching: "ถ้าลูกค้าถามราคา บอกราคา 19,900 บาทเลย ไม่ต้องถามคัดกรอง และบอกโปรโมชั่น Early Bird ด้วย",
  },
  {
    id: "lesson-discount", status: "active", topic: "ขอส่วนลด", decided_at: 1,
    customer_text: "ลดได้อีกไหม", ai_text: "ลดให้เพิ่มอีก 10% ค่ะ",
    teaching: "ห้ามให้ส่วนลดเพิ่มเอง บอกว่าราคาโปรเป็นราคาที่ดีที่สุดแล้ว",
  },
]);

for (const scenario of SCENARIOS) {
  test(`บทเรียนที่เจ้าของสอน: ต่อท้ายแล้วข้างของราคาต้องไม่ขยับ — ${scenario.name}`, () => {
    const ignore = scenario.ignoreLines || [];
    const base = classifyPriceDirectives(
      withPriceDirectiveCapture(() => baseRules(scenario.intent, scenario.flags || [], scenario.args)), { ignore });
    let section = null;
    const captured = withPriceDirectiveCapture(() => {
      const rules = baseRules(scenario.intent, scenario.flags || [], scenario.args);
      section = buildOwnerLessonsSection(PRICE_TEACHING_LESSONS);
      return `${rules}\n${section.text}`;
    });
    const withLessons = classifyPriceDirectives(captured, { ignore: [...ignore, ...section.dataLines] });
    assert.deepEqual(withLessons.unclassified, [],
      `หัวข้อบทเรียนมีบรรทัดเรื่องเงินที่ไม่มีข้าง\n  ฉาก: ${scenario.name}\n${render(withLessons.unclassified)}`);
    for (const side of ["quote", "defer", "promo", "no_promo"]) {
      assert.deepEqual(withLessons.bySide[side], base.bySide[side],
        `บทเรียนทำให้ข้าง ${side} ขยับ — หัวข้อบทเรียนต้องเป็น neutral ล้วน\n  ฉาก: ${scenario.name}`);
    }
    assert.ok(withLessons.bySide.neutral.includes(OWNER_LESSON_RULES.priority),
      "กติกาลำดับชั้น (ราคา/เงิน/การส่งต่อด้านบนชนะ) ต้องอยู่ในพรอมต์ทุกฉากที่มีบทเรียน");
    assert.equal(withLessons.bySide.neutral.filter((line) => line === OWNER_LESSON_MONEY_REMINDER).length, 2,
      "บทเรียนที่พูดเรื่องเงินทั้งสองเรื่องต้องมีบรรทัดย้ำลำดับชั้นติดตัว");
  });
}

test("บทเรียนที่เจ้าของสอน: การยกเว้นเจาะจงเฉพาะคำของคน — ไม่มีบรรทัดที่โค้ดเขียนหลบอยู่ใน dataLines", () => {
  const section = buildOwnerLessonsSection(PRICE_TEACHING_LESSONS);
  const coded = [...Object.values(OWNER_LESSON_RULES), OWNER_LESSON_MONEY_REMINDER];
  for (const line of coded) assert.ok(!section.dataLines.includes(line), `บรรทัดของโค้ดห้ามอยู่ในรายการยกเว้น: ${line}`);
  // ไม่ยกเว้น = คำสอนเรื่องราคาต้องถูกจับว่าไม่มีข้าง (พิสูจน์ว่าการยกเว้นมีผลจริง ไม่ใช่เขียวเพราะบังเอิญ)
  const bare = classifyPriceDirectives(withPriceDirectiveCapture(() => buildOwnerLessonsSection(PRICE_TEACHING_LESSONS).text));
  assert.ok(bare.unclassified.some((line) => line.includes("บอกราคา 19,900 บาทเลย")));
  assert.ok(bare.unclassified.every((line) => section.dataLines.includes(line)),
    "สิ่งที่ไม่มีข้างต้องเป็นคำของคนเท่านั้น");
  // ลำดับชั้นต้องมาก่อนตัวบทเรียนเสมอ — ข้อความที่อ่านทีหลังห้ามดูเหมือนมีน้ำหนักกว่า
  const lines = section.text.split("\n");
  assert.ok(lines.indexOf(OWNER_LESSON_RULES.priority) < lines.findIndex((line) => line.startsWith("[บทเรียน 1")));
});
