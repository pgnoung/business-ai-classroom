// v1.2.3 — จังหวะการขายอ่านจากสัญญาณซื้อสด ไม่รอ scorer
// เคสอ้างอิงคือบทสนทนาจริงของลูกแพร 2026-08-12 ที่ลูกค้าถามราคา โปรโมชั่น วันเรียน
// ครบทุกอย่างแล้ว แต่บอทยังอยู่โหมดสำรวจจนลูกค้าพิมพ์ว่า "ไม่ขายเหรอ" แล้วเลิกคุย
import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVERY_QUESTION_BUDGET,
  buildSalesMotionRules,
  countAssistantQuestions,
  detectBuyingSignals,
  hasAskedEarlyBird,
  hasRecentFatigue,
  resolveSalesStage,
} from "../src/salesMotion.mjs";

const LOST_LEAD_HISTORY = [
  { role: "user", content: "สนใจคับ ai" },
  { role: "assistant", content: "ยินดีค่ะ ตอนนี้ใช้ AI ตัวไหนอยู่บ้างคะ?" },
  { role: "user", content: "excel ครับ" },
  { role: "assistant", content: "ในไฟล์มีคอลัมน์อะไรบ้างคะ?" },
  { role: "user", content: "ราคาแพงไหม คลาสนี้" },
  { role: "assistant", content: "15,900 บาทค่ะ อยากให้สรุปภาพระบบให้ดูไหมคะ?" },
  { role: "user", content: "15900 เรียนกี่วันครับ" },
];

test("ลูกค้าที่ถามราคา วันเรียน และโปรโมชั่นแล้ว ต้องอยู่ขั้นเสนอขาย แม้คะแนนยังเป็น 0", () => {
  const resolved = resolveSalesStage({ text: "มีโปรไหม", history: LOST_LEAD_HISTORY, leadScore: 0 });
  assert.equal(resolved.stage, "offer");
  assert.ok(resolved.signals.includes("price"));
  assert.ok(resolved.signals.includes("schedule"));
  assert.ok(resolved.signals.includes("promotion"));
});

test("คะแนนของ scorer ดันขึ้นได้อย่างเดียว ห้ามดึงกลับลงเป็นโหมดสำรวจ", () => {
  assert.equal(resolveSalesStage({ text: "สวัสดีครับ", history: [], leadScore: 9 }).stage, "offer");
  assert.equal(resolveSalesStage({ text: "สวัสดีครับ", history: [], leadScore: 6 }).stage, "value");
  // คะแนนตกเพราะลูกค้าหงุดหงิด ไม่ได้แปลว่าเจตนาซื้อหายไป
  assert.equal(resolveSalesStage({ text: "อยากสมัครครับ", history: [], leadScore: 0 }).stage, "offer");
});

test("คำพูดเรื่องราคาของธุรกิจลูกค้าเองไม่นับเป็นสัญญาณซื้อ", () => {
  const signals = detectBuyingSignals({ text: "เอกสาร ทำใบเสนอราคา ครับ" });
  assert.equal(signals.keys.includes("price"), false);
});

test("สัญญาณรำคาญต้องจำข้ามเทิร์น ไม่ใช่ลืมทันทีในเทิร์นถัดไป", () => {
  const history = [
    { role: "user", content: "ถามเยอะจัง" },
    { role: "assistant", content: "ขอโทษค่ะ" },
    { role: "user", content: "คลาสคนเรียนเยอะมั้ย" },
    { role: "assistant", content: "กลุ่มเล็กค่ะ" },
  ];
  assert.equal(hasRecentFatigue({ text: "มีรายละเอียดมั้ย", history }), true);
  assert.equal(hasRecentFatigue({ text: "มีรายละเอียดมั้ย", history: [], turns: 4 }), false);
  assert.equal(hasRecentFatigue({ text: "ไม่ขายเหรอ ถามเยอะไป" }), true);
});

test("ถามครบงบแล้วต้องห้ามถามเก็บข้อมูลอีก", () => {
  // v1.3.1: งบขยายเป็น 5 ตามคำถามคัดกรองของคู่มือ — ต่อประวัติให้ถึงงบก่อนทดสอบ
  const spentBudget = [...LOST_LEAD_HISTORY,
    { role: "assistant", content: "ทีมมีกี่ท่านคะ?" },
    { role: "user", content: "3 ท่านค่ะ" },
    { role: "assistant", content: "อยากเรียนไปทำเองหรืออยากทำระบบจากโจทย์จริงคะ?" },
  ];
  assert.ok(countAssistantQuestions(spentBudget) >= DISCOVERY_QUESTION_BUDGET);
  const rules = buildSalesMotionRules({ text: "มีโปรไหม", history: spentBudget, leadScore: 0 }).join("\n");
  assert.match(rules, /ห้ามถามเพื่อเก็บข้อมูลอีก/u);
  assert.match(rules, /ห้ามวนกลับไปสำรวจโจทย์อีก/u);
});

test("ลูกค้าถามโปรเอง = ตอบตรง ห้ามย้อนถามว่าทราบโปรฯ หรือยัง", () => {
  // v1.3.4: การย้อนถาม "ทราบโปรฯ แล้วหรือยัง" ใส่คนที่เพิ่งถามว่า "มีโปรไหม" คือการหลบ
  const rules = buildSalesMotionRules({
    text: "มีโปรไหม", history: LOST_LEAD_HISTORY, leadScore: 0, addressLabel: "คุณสมศักดิ์",
  }).join("\n");
  assert.match(rules, /early bird/u, "ต้องมีคำแนะนำเรื่องโปรฯ ให้โมเดลตอบได้");
  assert.doesNotMatch(rules, /จังหวะนี้เหมาะที่จะถาม/u, "ห้ามย้อนถามคนที่ถามมาก่อน");
});

// ลูกค้าที่ร้อนแล้วแต่ยังไม่เคยเอ่ยเรื่องราคา/โปร/รอบ/สมัครเลย
const HOT_BUT_SILENT_HISTORY = [
  { role: "user", content: "สนใจคับ ai" },
  { role: "assistant", content: "ยินดีค่ะ ตอนนี้ใช้ AI ตัวไหนอยู่บ้างคะ?" },
  { role: "user", content: "ใช้ ChatGPT ตอบลูกค้าอยู่ครับ" },
  { role: "assistant", content: "เข้าใจเลยค่ะ คลาส AI Agent for Business ตรงกับงานนี้ค่ะ" },
];

test("2026-09-13: ลูกค้าร้อนแล้วแต่ยังไม่ถาม ห้ามชวนโปรฯ จากคะแนนล้วน", () => {
  const rules = buildSalesMotionRules({
    text: "ครับ", history: HOT_BUT_SILENT_HISTORY, leadScore: 9, addressLabel: "คุณสมศักดิ์",
  }).join("\n");
  assert.doesNotMatch(rules, /ไม่ทราบว่าคุณสมศักดิ์ทราบโปรโมชั่น/u);
  // v1.2.5: label ผ่านตัวกรองคำนำหน้ามาแล้ว ห้ามเติม "คุณ" ซ้ำ
  const honorific = buildSalesMotionRules({
    text: "ครับ", history: HOT_BUT_SILENT_HISTORY, leadScore: 9, addressLabel: "พี่เบียร์",
  }).join("\n");
  assert.doesNotMatch(honorific, /ไม่ทราบว่าพี่เบียร์ทราบโปรโมชั่น/u);
  assert.doesNotMatch(honorific, /คุณพี่เบียร์/u);

  const asked = [...HOT_BUT_SILENT_HISTORY, { role: "assistant", content: "ทราบโปรโมชั่น early bird แล้วหรือยังคะ?" }];
  assert.equal(hasAskedEarlyBird(asked), true);
  assert.doesNotMatch(buildSalesMotionRules({ text: "ครับ", history: asked, leadScore: 9 }).join("\n"), /จังหวะนี้เหมาะที่จะถาม/u);
});

test("ข้อความเปิดที่มีแค่คำว่า 'สนใจ' กับ 'สอนอะไร' ต้องไม่ปลดล็อกโปรโมชั่น", () => {
  // เคสจริง 2026-08-13: ยิงโปรฯ ที่เทิร์นที่ 4 แล้วลูกค้าตอบ "ยังครับ ยังไม่รู้เลยพี่ง้วง สอนอะไร"
  // สองคำนี้คือ "นิยามของขั้นสำรวจ" ไม่ใช่สัญญาณซื้อ
  const opener = buildSalesMotionRules({
    text: "สนใจ ai ครับ พี่ง้วง สอนอะไรมั่ง", history: [], leadScore: null, addressLabel: "คุณลูกค้า",
  }).join("\n");
  assert.doesNotMatch(opener, /early bird/iu);
  assert.match(opener, /ขั้นของการขายตอนนี้: discovery/u, "ข้อความเปิดต้องยังอยู่ขั้นสำรวจ");

  // และคะแนนเย็นต้องไม่ถูกดันขึ้นด้วยคำอ่อนสองคำ
  const stage = resolveSalesStage({ text: "สนใจ ai ครับ พี่ง้วง สอนอะไรมั่ง", history: [], leadScore: null });
  assert.equal(stage.stage, "discovery");
  assert.equal(stage.signalWeight, 2, "ยังเห็นสัญญาณอ่อนสองตัว แต่ต้องไม่พอให้ข้ามขั้น");
});

test("ลูกค้าที่บ่นว่าถามเยอะ ต้องไม่โดนยิงคำถาม early bird ซ้ำเข้าไปอีก", () => {
  const annoyed = [...LOST_LEAD_HISTORY, { role: "user", content: "ไม่ขายเหรอ ถามเยอะไป" }];
  const rules = buildSalesMotionRules({ text: "ไม่เรียนละ", history: annoyed }).join("\n");
  assert.match(rules, /ห้ามถามเพื่อเก็บข้อมูลอีก/u);
  assert.doesNotMatch(rules, /จังหวะนี้เหมาะที่จะถาม/u);
});

test("บทสนทนาที่ยังไม่มีสัญญาณซื้อ ยังอยู่ขั้นทำความรู้จัก", () => {
  const rules = buildSalesMotionRules({ text: "สวัสดีครับ", history: [] }).join("\n");
  assert.match(rules, /ตอบเฉพาะเรื่องที่ลูกค้าถาม/u);
  assert.doesNotMatch(rules, /early bird/u);
});

// ---- v1.3: แผนผังเลือกคลาสจากคู่มือของชมพู่ (แอดมินคนจริง) 2026-08-13 ----
import { buildClassRoutingRules, detectAiLevel, detectHeadcount, detectRoundInterest, recommendProduct } from "../src/salesMotion.mjs";
// 15 Sep: menu answers require the pending question.
const aiQuestion = { history: [{ role: "assistant", content: "เคยใช้ AI มาประมาณระดับไหนแล้วคะ?" }] };

test("v1.3: อ่านระดับการใช้ AI ได้ทั้งจากตัวเลขและจากพฤติกรรมที่ลูกค้าเล่า", () => {
  assert.equal(detectAiLevel("3", aiQuestion), 3);
  assert.equal(detectAiLevel("ระดับ 5 ค่ะ"), 5);
  assert.equal(detectAiLevel("ข้อ 2 ครับ", aiQuestion), 2);
  assert.equal(detectAiLevel("ยังไม่เคยใช้เลยครับ", aiQuestion), 1);
  assert.equal(detectAiLevel("เคยลองเล่นถามข้อมูลบ้าง"), 2);
  assert.equal(detectAiLevel("ใช้สรุปข้อมูลกับเขียนอีเมลทุกวัน"), 3);
  assert.equal(detectAiLevel("เคยสร้าง Custom GPT แล้วครับ"), 5);
  assert.equal(detectAiLevel("เคยใช้ Make.com เชื่อมระบบแล้ว"), 5);
  assert.equal(detectAiLevel("สนใจคลาสครับ"), null, "ข้อความที่ไม่บอกระดับต้องไม่เดา");
});

test("15 Sep: ระดับ 5 เป็นข้อมูลพื้นฐาน ไม่ใช่คำตัดสินคลาส", () => {
  assert.equal(recommendProduct({ level: 5 }), "workflow_automation_or_higher");
  assert.equal(recommendProduct({ level: 4 }), "ai_agent_for_business");
  assert.equal(recommendProduct({ level: 1 }), "ai_agent_for_business");
  const rules = buildClassRoutingRules({ text: "เคยสร้าง Custom GPT แล้วครับ" }).join("\n");
  assert.match(rules, /ยังไม่ทราบเป้าหมายงาน/u);
  assert.doesNotMatch(rules, /ห้ามเสนอคลาสพื้นฐาน/u);
  assert.match(rules, /อย่าสรุปว่า Stage นี้ต้องเรียนคลาสใด/u);
});

test("v1.3: จำนวนผู้เรียนเปลี่ยนรูปแบบคลาสตามแผนผัง", () => {
  assert.equal(detectHeadcount("อยากพาทีม 12 คนมาเรียนครับ"), 12);
  assert.equal(recommendProduct({ level: 2, headcount: 12 }), "in_house_training");
  assert.equal(recommendProduct({ level: 2, headcount: 6 }), "private_or_in_house");
  assert.equal(recommendProduct({ level: 2, headcount: 2 }), "ai_agent_for_business");
  // จำนวนคนมาก่อนระดับเสมอ — ทีม 12 คนไม่ควรถูกเสนอคลาสรวมแม้พื้นฐานจะต่ำ
  const rules = buildClassRoutingRules({ text: "อยากให้ทีม 12 คนใช้ AI ช่วยทำรายงาน ยังไม่เคยใช้ AI เลย" }).join("\n");
  assert.match(rules, /In-house Training คุ้มค่าที่สุด/u);
});

test("v1.3: อ่านระดับจากประวัติได้ ไม่ใช่แค่ข้อความล่าสุด", () => {
  const history = [
    { role: "user", content: "ระดับ 5 ครับ" },
    { role: "assistant", content: "รับทราบค่ะ" },
  ];
  const rules = buildClassRoutingRules({ text: "แล้วราคาเท่าไหร่", history }).join("\n");
  assert.match(rules, /ระดับการใช้ AI = 5/u);
});

// ---- v1.3.1: ผลตรวจอิสระ 2026-08-13 เทียบกับต้นฉบับคู่มือ ----

test("v1.3.1: ประโยคปฏิเสธห้ามถูกอ่านว่าทำเป็นแล้ว", () => {
  // คู่มือ ตาราง 2.2: "ใช้ช่วยงานจริง แต่ยังไม่เคยสร้าง Custom AI" -> AI Agent for Business
  assert.equal(detectAiLevel("ใช้ช่วยงานจริง แต่ยังไม่เคยสร้าง Custom AI"), null);
  assert.equal(detectAiLevel("ยังไม่เคยสร้าง Custom GPT เลยค่ะ"), null);
  assert.equal(detectAiLevel("ไม่เคยใช้ Make.com ครับ"), null);
  // คู่มือ กฎ 4 ข้อ ข้อ 2: อยากเรียน Automation ไม่ได้แปลว่าพร้อม
  assert.equal(detectAiLevel("อยากเรียน automation ครับ"), null);
  assert.equal(detectAiLevel("สนใจ workflow automation ครับ"), null);
  // ของจริงที่ทำได้แล้ว ยังต้องอ่านออก
  assert.equal(detectAiLevel("เคยสร้าง Custom GPT แล้วครับ"), 5);
  assert.equal(detectAiLevel("ใช้ Make.com เชื่อมระบบแล้วครับ"), 5);
});

test("v1.3.1: ข้อความที่บังเอิญมีเลข 1-5 ต้องไม่กลายเป็นระดับ", () => {
  assert.equal(detectAiLevel("สนใจรอบวันที่ 15 ค่ะ"), null);
  assert.equal(detectAiLevel("สะดวกวันที่ 22 ค่ะ"), null);
  assert.equal(detectAiLevel("ทีมมี 4 คนค่ะ"), null, "จำนวนคนไม่ใช่ระดับ");
  // รูปแบบที่เป็นระดับจริงยังต้องอ่านออก
  assert.equal(detectAiLevel("3", aiQuestion), 3);
  assert.equal(detectAiLevel("ระดับ 4 เลยค่ะ"), 4);
});

test("v1.3.1: อ่านถ้อยคำตัวเลือกทั้ง 5 ระดับที่บอทส่งไปให้ลูกค้าเลือก", () => {
  assert.equal(detectAiLevel("ยังไม่เคยใช้งาน แต่สนใจและอยากเริ่มต้นเรียนรู้"), 1);
  assert.equal(detectAiLevel("เคยทดลองใช้บ้าง เช่น ถามข้อมูล แปลภาษา หรือค้นหาไอเดีย"), 2);
  assert.equal(detectAiLevel("เริ่มนำมาใช้ช่วยงานจริง เช่น สรุปข้อมูล เขียนอีเมล"), 3);
  assert.equal(detectAiLevel("ใช้งานเป็นประจำ และอยากเรียนรู้เทคนิคที่สูงขึ้น"), 4);
});

test("v1.3.1: ระดับที่ลูกค้าตอบครั้งแรกห้ามถูกเขียนทับด้วยเลขในเทิร์นหลัง", () => {
  const history = [
    { role: "user", content: "ยังไม่เคยใช้งานเลยค่ะ อยากเริ่มต้นเรียนรู้" },
    { role: "assistant", content: "รับทราบค่ะ" },
  ];
  const rules = buildClassRoutingRules({ text: "สนใจรอบวันที่ 15 ค่ะ", history }).join("\n");
  assert.match(rules, /ระดับการใช้ AI = 1/u);
  assert.match(rules, /AI Agent for Business/u);
  assert.doesNotMatch(rules, /ห้ามเสนอคลาสพื้นฐาน/u);
});

test("v1.3.1: งบคำถามต้องพอสำหรับคำถามคัดกรอง 5 ข้อของคู่มือ", () => {
  assert.ok(DISCOVERY_QUESTION_BUDGET >= 5, "คู่มือมีคำถามคัดกรอง 5 ข้อ");
});

/* ---- v1.3.4: ช่องโหว่ที่ตัวตรวจปรปักษ์จับได้หลังทำประตูโปรฯ เข้มขึ้น ---- */

test("เกราะกันถามวนต้องทำงานแม้ยังอยู่ขั้น discovery", () => {
  // regression จริง: เดิมกฎงบคำถามผูกกับ stage !== "discovery" พอประตูโปรฯ เข้มขึ้น
  // stage ค้าง discovery นานขึ้น เกราะที่เกิดจากเคสจริง "ลูกค้าเลิกคุยเพราะถูกถามวน" จึงตายเงียบ
  const history = [
    { role: "user", content: "สนใจครับ" },
    { role: "assistant", content: "ใช้ AI อะไรอยู่คะ?" },
    { role: "user", content: "chatgpt" },
    { role: "assistant", content: "งานไหนเสียเวลาสุดคะ?" },
    { role: "user", content: "ตอบแชท" },
    { role: "assistant", content: "ทีมกี่คนคะ?" },
    { role: "user", content: "2 คน" },
    { role: "assistant", content: "งบประมาณเท่าไหร่คะ?" },
    { role: "user", content: "ไม่แน่ใจ" },
    { role: "assistant", content: "สะดวกวันไหนคะ?" },
  ];
  const rules = buildSalesMotionRules({ text: "ขอรายละเอียดหน่อยครับ", history, leadScore: 2 }).join("\n");
  assert.equal(resolveSalesStage({ text: "ขอรายละเอียดหน่อยครับ", history, leadScore: 2 }).stage, "discovery");
  assert.match(rules, /ห้ามถามเพื่อเก็บข้อมูลอีก/u, "ถามครบงบแล้วต้องหยุดถาม ไม่ว่าจะอยู่ขั้นไหน");
});

test("ลูกค้าที่บอกว่าถูกถามเยอะแล้วถามราคาเอง ต้องได้คำตอบ ไม่ใช่ถูกเมิน", () => {
  const history = [{ role: "user", content: "ไม่ต้องถามแล้ว" }];
  const rules = buildSalesMotionRules({ text: "ราคาเท่าไหร่ครับ", history, leadScore: 3 }).join("\n");
  assert.match(rules, /ตอบตรง/u, "คนที่หงุดหงิดแล้วถามราคาคือคนที่อยากได้คำตอบที่สุด");
});

test("สำนวนต่อรองราคาและถามเวลาหมดโปรฯ ต้องนับเป็นสัญญาณซื้อ", () => {
  // ตรวจปรปักษ์พบว่า 33 จาก 37 สำนวนไทยจริงเงียบสนิท กลุ่มที่เจ็บสุดคือคนกำลังจะซื้อ
  // 2026-09-04: สัญญาณยังต้องถูกจับเหมือนเดิมทุกสำนวน — สิ่งที่เปลี่ยนคือ "คำตอบที่สั่งไป"
  // แยกตามจังหวะราคา (คนที่เรารู้จักบ้างแล้วได้ตัวเลข คนแปลกหน้าล้วนได้การรับรู้ + คัดกรองหนึ่งข้อ)
  // 2026-09-04 รอบสอง: "เรารู้จักเขาแล้ว" ไม่อ่านจาก "ผมเปิดคลินิกครับ" อีกแล้ว —
  // regex ชุดนั้นจับ "อยากใช้ AI / ปัญหาคือ" ซึ่งเป็นประโยคเปิดของลีดทุกคน จึงถูกลบทั้งชุด
  // สัญญาณที่ใช้แทนคือผลของ scorer ซึ่งมีโครงสร้างและอ่านบทสนทนาทั้งก้อน
  const KNOWN = [{ role: "user", content: "ผมเปิดคลินิกครับ" }, { role: "assistant", content: "ยินดีค่ะ" }];
  const SCORED = { painPoint: "คิวคนไข้ล้นจนตอบแชทไม่ทัน", personaType: "unknown" };
  for (const text of ["ลดได้ไหมครับ", "แพงจังครับ", "เกินงบไปนิดนึงครับ", "ที่อื่นถูกกว่านี้ครับ"]) {
    const rules = buildSalesMotionRules({ text, history: KNOWN, leadScore: 4, scoreSignals: SCORED }).join("\n");
    assert.match(rules, /ตอบตรง ๆ ด้วยข้อมูลที่อนุมัติแล้ว/u, `"${text}" ต้องได้คำตอบเรื่องราคา/โปรฯ`);
  }
  // สำนวนที่ไม่ใช่คำถามเรื่องเงิน (หมดเขต/ที่นั่ง/ขั้นตอน) ต้องถูกจับเป็นสัญญาณซื้อเหมือนเดิม
  // และต้องได้คำตอบครบ — สิ่งเดียวที่รอจังหวะคือตัวเลข
  for (const text of ["หมดเขตเมื่อไหร่ครับ", "ยังพอมีที่ไหมครับ", "ต้องทำยังไงต่อครับ"]) {
    const rules = buildSalesMotionRules({ text, history: KNOWN, leadScore: 4, scoreSignals: SCORED }).join("\n");
    assert.match(rules, /ห้ามย้อนถามว่าทราบโปรฯ แล้วหรือยัง/u, `"${text}" ต้องได้คำตอบ ไม่ใช่ถูกย้อนถาม`);
    assert.match(rules, /ด้วยข้อมูลที่อนุมัติแล้ว/u);
  }
});

test("2026-09-04: สำนวนเดียวกันจากคนแปลกหน้าล้วน ๆ ต้องไม่ถูกเมิน แต่ยังไม่ใส่ตัวเลข", () => {
  // จุดที่พังของเดิม: บรรทัดนี้ถูก push ทีหลัง warmth จึงเป็นคำสั่งสุดท้ายที่โมเดลอ่าน
  // พรอมต์เดียวกันจึงมีทั้ง "ห้ามใส่ตัวเลขราคา" และ "ตอบตรง ๆ รวมโปรฯ early bird"
  for (const text of ["ลดได้ไหมครับ", "แพงจังครับ", "เกินงบไปนิดนึงครับ"]) {
    const rules = buildSalesMotionRules({ text, history: [], leadScore: 4 }).join("\n");
    assert.match(rules, /รับรู้คำถามเขาก่อน/u, `"${text}" ต้องถูกรับรู้ ห้ามทำเป็นไม่ได้ยิน`);
    assert.match(rules, /ยังไม่ต้องใส่ตัวเลขราคา ส่วนลด หรือโปรโมชั่นในเทิร์นนี้/u);
    assert.doesNotMatch(rules, /early bird/iu);
  }
  for (const text of ["หมดเขตเมื่อไหร่ครับ", "ยังพอมีที่ไหมครับ", "ต้องทำยังไงต่อครับ"]) {
    const rules = buildSalesMotionRules({ text, history: [], leadScore: 4 }).join("\n");
    assert.match(rules, /ตอบให้ครบด้วยข้อมูลที่อนุมัติแล้ว/u, `"${text}" ไม่ใช่คำถามเรื่องเงิน ต้องได้คำตอบครบ`);
    assert.match(rules, /ยังไม่ถึงจังหวะราคา/u);
  }
});

test("อ่านระดับจาก keycap emoji ที่ลูกค้าตอบกลับจากเมนูได้", () => {
  // คำถามคัดกรองส่งบันไดเป็น 1️⃣-5️⃣ ลูกค้าจึงมักกดตอบด้วย keycap เดียวกัน
  // ซึ่งเป็นลำดับ 3 code point ไม่ใช่ตัวเลขธรรมดา
  assert.equal(detectAiLevel("2️⃣", aiQuestion), 2);
  assert.equal(detectAiLevel("3️⃣ ครับ", aiQuestion), 3);
  assert.equal(detectAiLevel("5️⃣", aiQuestion), 5);
  // ของเดิมต้องยังอ่านได้เหมือนเดิม และเลขที่ไม่ใช่ระดับต้องยังอ่านไม่ออก
  assert.equal(detectAiLevel("ระดับ 4 ครับ"), 4);
  assert.equal(detectAiLevel("สนใจรอบวันที่ 15 ค่ะ"), null);
});

/* ---- 2026-09-04: คำตอบบันไดระดับ 1 ที่ลูกค้าจริงพิมพ์ (เคสจริงสองห้องบนโปรดักชัน) ---- */
//
// ถ้อยคำตัวเลือกระดับ 1 ที่เราส่งไปคือประโยคเต็ม ("ยังไม่เคยใช้งาน แต่สนใจ...") แต่คนไทย
// ตอบกลับด้วยคำปฏิเสธคำเดียวที่ไม่มีคำว่า "ใช้" อยู่เลย — ห้อง A ตอบ "ยังไม่เคยครับ"
// ห้อง B ตอบ "ไม่เคยครับ" ทั้งสองห้องถูกอ่านเป็น null แล้วโดนขอคัดกรองซ้ำ ทั้งที่เพิ่ง
// ตอบคำถามของเราไปหมาด ๆ (คำตอบทั้งสองมาก่อน deploy จึงยังไม่มีหมุด known_context_at
// ให้พึ่ง — ช่องโหว่ที่แก้รอบนี้คือตัวอ่าน ไม่ใช่หมุด)
test("คำตอบบันไดระดับ 1 แบบที่ลูกค้าพิมพ์จริง ต้องอ่านออกทุกสำนวน", () => {
  const answers = [
    "ไม่เคย", "ยังไม่เคย", "ไม่เคยเลย", "ยังไม่เคยเลย", "ยังเลย",
    "ยังครับ", "ยังค่ะ", "ไม่เคยใช้", "ยังไม่ได้ใช้", "ยังไม่ได้ลอง", "ยังไม่เริ่ม",
    // ทุกตัวข้างบนบวกคำลงท้ายสุภาพ ซึ่งเป็นรูปที่มาจริงในแชท
    "ไม่เคยครับ", "ยังไม่เคยครับ", "ไม่เคยเลยค่ะ", "ยังไม่เคยเลยครับ", "ยังเลยครับ",
    "ไม่เคยใช้ครับ", "ยังไม่ได้ใช้ค่ะ", "ยังไม่ได้ลองครับ", "ยังไม่เริ่มเลยค่ะ", "ไม่เคยคะ",
    // ตอบบันไดแล้วต่อประโยคในข้อความเดียว = ยังเป็นคำตอบบันได (ข้อความเปิดห้องของห้อง B)
    "ยังครับ แต่สนใจ", "ไม่เคยค่ะ แต่อยากเริ่ม", "ยังไม่เคยครับ พอดีเพิ่งรู้จัก",
    "ไม่เคยครับ.", "ยังเลยค่ะ!",
  ];
  for (const text of answers) {
    assert.equal(detectAiLevel(text, aiQuestion), 1, `"${text}" คือการตอบบันไดว่ายังไม่เคยใช้ AI`);
  }
});

test("คำว่า 'ยัง' ที่ไม่ใช่คำตอบบันได ต้องไม่ถูกอ่านเป็นระดับ", () => {
  const notAnswers = [
    // "ยังไม่" + คำอื่น = สถานะเรื่องอื่นของลูกค้า ไม่ใช่ระดับการใช้ AI
    "ยังไม่ตัดสินใจครับ", "ยังไม่สะดวกค่ะ", "ยังไม่ว่างครับ", "ยังไม่ได้โอนครับ",
    "ยังไม่แน่ใจว่าจะคุ้มไหมคะ", "ยังไม่ได้คุยกับหัวหน้าครับ",
    // "ยัง" เป็นพยางค์หน้าของคำอื่น — ด่านนี้พังง่ายที่สุดถ้าไม่บังคับให้จบอนุประโยค
    "ยังไงครับ", "ยังงี้ใช่ไหมคะ", "ยังอยากรู้รายละเอียดเพิ่มครับ", "ยังพอมีที่ไหมครับ",
    // มีของต่อท้ายในอนุประโยคเดียวกัน = ไม่ใช่คำตอบสั้น ๆ ของบันได (ของเดิมอ่านเป็น null
    // ผ่านตัวปฏิเสธหน้าคำสัญญาณระดับ 5 — พฤติกรรมนั้นต้องไม่เปลี่ยน)
    "ไม่เคยใช้ Make.com ครับ", "ยังไม่เคยสร้าง Custom GPT เลยค่ะ",
    "ใช้ช่วยงานจริง แต่ยังไม่เคยสร้าง Custom AI",
  ];
  for (const text of notAnswers) {
    assert.equal(detectAiLevel(text), null, `"${text}" ไม่ใช่การตอบบันไดระดับ AI`);
  }
});

/* ---- v1.3.4: ลูกค้าเอ่ยวันที่ = กำลังเลือกรอบเรียน ---- */

test("เอ่ยวันที่ในบริบทรอบเรียน = สัญญาณซื้อแรงเท่ากับบอกว่าจะสมัคร", () => {
  // "สนใจรอบวันที่ 15 ค่ะ" เคยถูกอ่านผิดเป็นระดับ AI 5 พอกันบั๊กนั้นแล้วก็กลายเป็น
  // ข้อความที่ระบบมองไม่เห็นอะไรเลย ทั้งที่ลูกค้าเลือกวันแล้ว
  for (const [text, expected] of [
    ["สนใจรอบวันที่ 15 ค่ะ", { day: 15, month: null }],
    ["เอารอบ 22 ครับ", { day: 22, month: null }],
    ["สนใจ 22 ส.ค. ครับ", { day: 22, month: 8 }],
    ["รอบ 15 สิงหา ค่ะ", { day: 15, month: 8 }],
    ["เสาร์ที่ 29 ครับ", { day: 29, month: null }],
  ]) {
    assert.deepEqual(detectRoundInterest(text), expected, `ต้องอ่านวันที่จาก: ${text}`);
  }
  assert.equal(resolveSalesStage({ text: "สนใจรอบวันที่ 15 ค่ะ", history: [], leadScore: null }).stage, "offer");
});

test("เลขที่ไม่ใช่วันเรียนต้องไม่ถูกอ่านเป็นการเลือกรอบ", () => {
  for (const text of [
    "ระดับ 5 ครับ", "มา 2 ท่านครับ", "เรียน 10:00-17:00 น.",
    "ราคา 12,900 บาท", "เรียนกี่ชั่วโมงครับ", "ผ่อน 10 เดือน",
  ]) {
    assert.equal(detectRoundInterest(text), null, `ต้องไม่อ่านเป็นวันเรียน: ${text}`);
  }
});

test("เลือกรอบแล้วต้องได้กฎที่สั่งเทียบกับรอบที่ประกาศจริง ห้ามยืนยันวันที่ไม่มี", () => {
  const rules = buildSalesMotionRules({ text: "สนใจรอบวันที่ 15 ค่ะ", history: [], leadScore: 5 }).join("\n");
  assert.match(rules, /กำลังเลือกรอบเรียน/u);
  assert.match(rules, /ห้ามยืนยันวันที่ที่ไม่ได้ประกาศ/u);
});

test("v1.3.5: วันที่ในบริบทยกเลิก/การเงิน/เอกสาร/วันเกิด ต้องไม่ใช่การเลือกรอบ", () => {
  // ตรวจปรปักษ์: "ยกเลิกรอบวันที่ 15" เคยกลายเป็นสัญญาณซื้อแรงสุด แล้วบอทชวนจองใส่คนที่กำลังยกเลิก
  for (const text of [
    "ยกเลิกรอบวันที่ 15 ครับ", "ขอเลื่อนไปรอบวันที่ 22", "ผ่อนถึงวันที่ 15",
    "โอนไปแล้ววันที่ 13", "ใบกำกับลงวันที่ 22", "วันเกิดผมวันที่ 15",
  ]) {
    assert.equal(detectRoundInterest(text), null, `ต้องไม่อ่านเป็นการเลือกรอบ: ${text}`);
  }
});

test("v1.3.5: เลือกรอบแล้ว คำแนะนำ Private/In-house จากจำนวนคนต้องหลบ แต่ข้อมูลคัดกรองต้องอยู่", () => {
  const history = [{ role: "user", content: "มา 6 คนครับ" }];
  const rules = buildClassRoutingRules({ text: "สนใจรอบวันที่ 22 ค่ะ", history }).join("\n");
  assert.match(rules, /จำนวนผู้เรียน = 6 ท่าน/u, "ข้อมูลคัดกรองต้องยังเข้า prompt");
  assert.doesNotMatch(rules, /อย่าฝืนขายคลาสรวม/u, "กฎขัดกันสองทางต้องไม่เกิด");
  assert.match(rules, /เดินหน้าจองรอบที่เลือกให้จบ/u);
});
