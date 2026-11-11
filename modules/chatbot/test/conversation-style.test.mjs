import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationStyleRules,
  historyBeforeCurrentInbound,
} from "../src/conversationStyle.mjs";

test("prompt history excludes the contiguous inbound block already supplied as userText", () => {
  const history = [
    { role: "user", content: "อยากเรียน AI ค่ะ" },
    { role: "assistant", content: "แพรช่วยแนะนำได้ค่ะ" },
    { role: "user", content: "ขอ outline ก่อน" },
    { role: "user", content: "เรียนทั้งวันไหม" },
  ];
  assert.deepEqual(historyBeforeCurrentInbound(history), history.slice(0, 2));
  assert.deepEqual(historyBeforeCurrentInbound(history.slice(0, 2)), history.slice(0, 2));
});

test("question-fatigue instruction requires a direct answer and no question", () => {
  const rules = buildConversationStyleRules({ text: "ถามเยอะจัง ขอข้อมูลตรง ๆ เลยครับ" });
  assert.match(rules, /ห้ามถามกลับในเทิร์นนี้/u);
  assert.match(rules, /ตอบตรง/u);
});

test("short acknowledgement continues the prior action without restarting the script", () => {
  const rules = buildConversationStyleRules({ text: "ครับ" });
  assert.match(rules, /ตอบรับสั้น/u);
  assert.match(rules, /ห้ามอธิบายเรื่องเดิมซ้ำ/u);
});

// v1.2.1 (สเปคเปลี่ยนตามคำสั่งพี่ง้วง — หลัก high-ticket): เทิร์นปกติปิดท้ายด้วย
// "คำถามนำนุ่มนวลหนึ่งข้อ" เพื่อชวนคุยต่อ — แต่ต้องไม่ใช่ชุดคำถาม/แบบฟอร์มคัดกรอง
test("2026-09-13: ordinary turns ask one soft question only if necessary, never a questionnaire", () => {
  const rules = buildConversationStyleRules({ text: "อยากทราบรายละเอียดคลาสค่ะ" });
  assert.match(rules, /ถ้าขาดข้อมูลที่จำเป็นจริง ๆ/u);
  assert.match(rules, /ห้ามยิงคำถามชุด/u);
  assert.match(rules, /ไม่ใช่แบบฟอร์มคัดกรอง/u);
});

// ---- v1.2.1 (เคสจริง: บอทวนถาม "งานไหนเสียเวลาสุด" ทั้งที่ลูกค้าตอบแล้ว) ----
import { recentAskedQuestions } from "../src/conversationStyle.mjs";

test("v1.2.1: สกัดคำถามที่ผู้ช่วยถามไปแล้วจาก history เพื่อสั่งห้ามถามซ้ำ", () => {
  const turns = [
    { role: "assistant", content: "ยินดีค่ะ ตอนนี้ทีมงานติดขั้นตอนไหนมากที่สุดคะ" },
    { role: "user", content: "ทำบิลกับเช็คสต็อกครับ" },
    { role: "assistant", content: "เข้าใจเลยค่ะ งานเอกสารพวกนี้กินเวลาจริง ๆ ค่ะ ปกติใช้ AI ตัวไหนอยู่บ้างคะ?" },
  ];
  const asked = recentAskedQuestions(turns);
  assert.ok(asked.some((q) => q.includes("ขั้นตอนไหนมากที่สุด")));
  assert.ok(asked.some((q) => q.includes("ใช้ AI ตัวไหนอยู่")));
});

test("v1.2.1: กติกา asked-questions ปรากฏใน rules พร้อมคำสั่งห้ามถามซ้ำ", () => {
  const rules = buildConversationStyleRules({
    text: "excel ครับ",
    askedQuestions: ["ตอนนี้ทีมงานติดขั้นตอนไหนมากที่สุดคะ"],
  });
  assert.match(rules, /คำถามที่เราถามลูกค้าไปแล้ว/u);
  assert.match(rules, /ขั้นตอนไหนมากที่สุด/u);
  assert.match(rules, /ห้ามถามคำถามพวกนี้ซ้ำ/u);
});

// ---- v1.2.2 (คำสั่งพี่ง้วง 2026-08-12): ราคาเปิดตามความอุ่น ไม่ใช่ตามคำถามแรก ----
import { asksAboutPrice, buildWarmthRules, customerHesitates, warmthBand } from "../src/conversationStyle.mjs";

test("v1.2.2: 'ทำใบเสนอราคา' คืองานของลูกค้า ไม่ใช่การถามค่าเรียน", () => {
  assert.equal(asksAboutPrice("เอกสาร ทำใบเสนอราคา ครับ"), false);
  assert.equal(asksAboutPrice("ตั้งราคาสินค้ายังไงดี"), false);
  assert.equal(asksAboutPrice("คลาสนี้ราคาเท่าไหร่คะ"), true);
  assert.equal(asksAboutPrice("ค่าเรียนกี่บาทครับ"), true);
});

test("v1.2.2: เกณฑ์ความอุ่นตรงกับตัวกรองใน console (hot>=8, warm 5-7)", () => {
  assert.equal(warmthBand(null), "cold");
  assert.equal(warmthBand(4), "cold");
  assert.equal(warmthBand(5), "warm");
  assert.equal(warmthBand(7), "warm");
  assert.equal(warmthBand(8), "hot");
});

test("v1.2.2: ลูกค้าเย็น ถาม 'มีคลาสอะไรบ้าง' ต้องห้ามยิงราคา", () => {
  const rules = buildWarmthRules({ score: null, text: "มีคลาสอะไรบ้าง" }).join("\n");
  assert.match(rules, /ห้ามใส่ตัวเลขราคา/u);
});

// 2026-09-04 (นโยบายจังหวะราคาฉบับเคาะ): เจตนาของเทสต์ตัวนี้คือ "ห้ามโยนให้ทีมงาน"
// ซึ่งยังจริงทุกกรณี — สิ่งที่เปลี่ยนคือคนแปลกหน้าที่เรายังไม่รู้จักเลย ได้คำถามคัดกรอง
// หนึ่งข้อก่อนหนึ่งรอบ (ครั้งเดียว) ส่วนคนที่เรารู้จักบ้างแล้วยังได้ราคาทันทีเหมือนเดิม
//
// 2026-09-04 รอบสอง: "เรารู้จักเขาแล้ว" ไม่อ่านจากประโยคเล่าเรื่องตัวเองอีกแล้ว
// ("ผมเปิดคลินิกครับ" เคยเป็นสัญญาณ แต่ regex ชุดนั้นจับ "อยากใช้ AI / ปัญหาคือ" ด้วย
//  ซึ่งเป็นประโยคเปิดของลีดทุกคน) — ใช้สัญญาณมีโครงสร้างแทน: pain_point จาก scorer
test("v1.2.2: ลูกค้าถามราคาตรง ๆ ต้องไม่ถูกโยนให้ทีมงาน — คนที่เรารู้จักบ้างแล้วได้ราคาทันที", () => {
  const rules = buildWarmthRules({
    score: 2, text: "คลาสนี้ราคาเท่าไหร่คะ",
    history: [{ role: "user", content: "ผมเปิดคลินิกครับ" }, { role: "assistant", content: "ยินดีค่ะ" }],
    scoreSignals: { painPoint: "คิวคนไข้ล้นจนตอบแชทไม่ทัน", personaType: "unknown" },
  }).join("\n");
  assert.match(rules, /ตอบราคาที่อนุมัติแล้ว/u);
  assert.match(rules, /ห้ามหลบ ห้ามบอกให้รอทีมงาน/u);
  assert.doesNotMatch(rules, /ห้ามใส่ตัวเลขราคา/u);
});

test("v1.2.2 + นโยบาย 2026-09-04: คนแปลกหน้าล้วน ๆ ได้คำถามคัดกรองหนึ่งข้อ ไม่ใช่การโยนให้ทีมงาน", () => {
  const rules = buildWarmthRules({ score: 2, text: "คลาสนี้ราคาเท่าไหร่คะ" }).join("\n");
  assert.match(rules, /ห้ามใส่ตัวเลขราคาในคำตอบนี้/u);
  assert.match(rules, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "กรอบเหตุผลต้องเป็นประโยชน์ของผู้เรียน");
  assert.match(rules, /ห้ามถามมากกว่าหนึ่งข้อเด็ดขาด/u);
  // เจตนาเดิมของ v1.2.2 ยังอยู่ครบ: ห้ามผลักไปให้ทีมงาน ห้ามบอกว่าบอกไม่ได้
  assert.ok(rules.includes("รอทีมงาน"), "ต้องระบุว่าห้ามใช้ถ้อยคำ 'รอทีมงาน'");
  assert.ok(rules.includes("ยังบอกไม่ได้"));
  assert.match(rules, /การคัดกรองครั้งเดียวและครั้งสุดท้าย/u);
});

test("2026-09-13: ลูกค้า hot ไม่ได้เปิดราคาเพียงเพราะคะแนนสูง", () => {
  // เดิม warmth กับ salesMotion ปล่อยสคริปต์ early bird ประโยคเดียวกันซ้ำสองบรรทัด
  // และฝั่ง warmth ไม่มี hasAskedEarlyBird guard = หลังถามแล้วยังสั่งถามซ้ำทุกเทิร์น hot
  const rules = buildWarmthRules({ score: 9, text: "สนใจสมัครครับ", knownName: "สมศักดิ์" }).join("\n");
  assert.match(rules, /ยังไม่ถึงจังหวะราคา/u);
  assert.doesNotMatch(rules, /ลูกค้าพร้อมตัดสินใจแล้ว/u);
  assert.doesNotMatch(rules, /early bird/iu, "สคริปต์โปรฯ ต้องมาจาก salesMotion ที่มี guard เท่านั้น");
});

test("v1.3.5: จังหวะ warm เสนอรีวิวนักเรียนจริงที่ตรงธุรกิจลูกค้าได้ (logic ชมพู่)", () => {
  // 2026-09-13: คะแนนล้วนไม่พอ; เคสนี้เรายังติดค้างข้อเสนอที่ลูกค้าเคยถาม
  const warm = buildWarmthRules({ score: 6, text: "อยากให้ AI ช่วยงานบัญชีครับ", customer: { price_deferred_at: 1 } }).join("\n");
  assert.match(warm, /รีวิวนักเรียนจริง/u);
  assert.match(warm, /ห้ามแต่งรีวิวหรือแก้ลิงก์/u);
  // คำสั่งพี่ง้วง 2026-08-14: ใกล้เคียงพอ = ควรส่ง — ข้อยกเว้นเดียวคือส่งซ้ำ
  assert.match(warm, /ไม่ต้องตรงเป๊ะ/u, "ห้ามใช้ 'ไม่ตรงบริบท' เป็นเหตุให้เงียบ");
  assert.match(warm, /หากไม่มีรายการที่เกี่ยวข้อง หรือส่งไปแล้ว/u, "15 Sep: ไม่ฝืนรีวิวที่ไม่ช่วยตอบโจทย์");
  // เทิร์นเปิด (cold) ต้องยังไม่ยัดรีวิว — ชมพู่ระบุจังหวะ warm ชัดเจน
  const cold = buildWarmthRules({ score: 2, text: "สวัสดีครับ" }).join("\n");
  assert.doesNotMatch(cold, /รีวิวนักเรียนจริง/u);
});

test("v1.3.5: ลูกค้าลังเล = สูตรรับรู้ก่อนแล้วแนบรีวิวเป็นหลักฐาน (ยกเว้นช่วง cold)", () => {
  for (const text of ["ยังลังเลอยู่ครับ", "ช่วยได้จริงเหรอ", "คุ้มไหมครับ", "กลัวตามไม่ทัน"]) {
    assert.equal(customerHesitates(text), true, `ต้องจับความลังเล: ${text}`);
    const rules = buildWarmthRules({ score: 6, text }).join("\n");
    assert.match(rules, /ลูกค้ากำลังลังเล/u);
    assert.match(rules, /รับรู้ความกังวลก่อนหนึ่งประโยค/u);
    assert.match(rules, /ไม่ต้องตรงเป๊ะ/u, "ใกล้เคียงพอก็ส่งได้ ตามคำสั่งพี่ง้วง 2026-08-14");
  }
  // เทิร์น cold ที่ลูกค้ายังไม่รู้จักเรา รีวิวคือการยัดเยียด — ห้ามยิง
  const cold = buildWarmthRules({ score: 2, text: "ยังลังเลอยู่ครับ" }).join("\n");
  assert.doesNotMatch(cold, /ลูกค้ากำลังลังเล/u);
  // ข้อความปกติต้องไม่ถูกอ่านเป็นความลังเล
  assert.equal(customerHesitates("ราคาเท่าไหร่ครับ"), false);
  assert.equal(customerHesitates("สนใจรอบวันที่ 22 ค่ะ"), false);
  const pause = buildWarmthRules({ score: 9, text: "ขอคิดดูก่อน" }).join("\n");
  assert.match(pause, /ลูกค้าขอพักหรือยังไม่พร้อม/u);
  assert.doesNotMatch(pause, /รับรู้ความกังวลก่อนหนึ่งประโยค/u);
});

// ---- v1.4.6 (คำสั่งพี่ง้วง 2026-08-16): ข้อมูลคลาสก่อน → ราคา → คำถาม ----

test("v1.4.6: ถามราคาโดยยังไม่เคยเห็นข้อมูลคลาส = ต้องมีกฎแนะนำคลาสก่อนราคา", () => {
  // 2026-09-04: เทิร์นที่ "ถึงจังหวะราคาแล้ว" คือเทิร์นที่กฎนี้ทำงาน — คนแปลกหน้าล้วน ๆ
  // ที่ถามเป็นข้อความแรกจะได้เทิร์นคัดกรองก่อนหนึ่งรอบ (มีเทสต์ของตัวเองด้านบน)
  const rules = buildWarmthRules({ score: 5, text: "ราคาเท่าไหร่ครับ", customer: { known_context_at: 1 }, history: [] }).join("\n");
  assert.match(rules, /ยังไม่เคยเห็นข้อมูลคลาสในบทสนทนานี้/u);
  assert.match(rules, /ห้ามเปิดคำตอบด้วยตัวเลข/u);
  assert.match(rules, /ราคาต้องอยู่ในคำตอบนี้เสมอ/u, "ห้ามตีความเป็นการหลบราคา");

  // แค่บอทเคย 'เอ่ยชื่อคลาส' ยังไม่พอ — ต้องเคยเล่ารายละเอียดจริง (เคสจริง 2026-08-15 23:36)
  const nameOnly = buildWarmthRules({
    score: 5, text: "ค่าใช้จ่ายเท่าไหร่ครับ", customer: { known_context_at: 1 },
    history: [{ role: "assistant", content: "แนะนำคลาส AI Agent for Business ค่ะ สนใจไหมคะ" }],
  }).join("\n");
  assert.match(nameOnly, /ยังไม่เคยเห็นข้อมูลคลาสในบทสนทนานี้/u, "เอ่ยชื่ออย่างเดียว = ยังต้องเล่าข้อมูลก่อนราคา");
});

test("v1.4.6: เคยเล่ารายละเอียดคลาสแล้ว หรือลูกค้าเอ่ยชื่อคลาสเอง = กฎเดิมไม่เปลี่ยน", () => {
  const detailed = buildWarmthRules({
    score: 5, text: "ราคาเท่าไหร่คะ",
    history: [{ role: "assistant", content: "🎯 สิ่งที่จะได้รับ\n\n✅ ใช้ AI ได้อย่างถูกวิธี" }],
  }).join("\n");
  assert.doesNotMatch(detailed, /ยังไม่เคยเห็นข้อมูลคลาสในบทสนทนานี้/u);

  const customerNames = buildWarmthRules({
    score: null, text: "คลาส AI Agent for Business ราคาเท่าไหร่ครับ", history: [],
  }).join("\n");
  assert.doesNotMatch(customerNames, /ยังไม่เคยเห็นข้อมูลคลาสในบทสนทนานี้/u, "ลูกค้าเอ่ยชื่อเอง = มีบริบทแล้ว");
});

/* -------- v1.4.9 (2026-08-17): live -> online pivot ไม่ downgrade (เคสลูกค้า A) -------- */
import { pivotsToOnlineAfterLiveInterest } from "../src/conversationStyle.mjs";

const LIVE_HISTORY = [
  { role: "assistant", content: "เรียนสดแบบ Workshop กลุ่มเล็กไม่เกิน 15 ท่าน ได้สิทธิ์ทบทวนผ่านคลาสออนไลน์ไม่จำกัดเวลา" },
  { role: "assistant", content: "โปรโมชั่น Early Bird 12,900 บาท/ท่าน" },
  { role: "user", content: "มีส่วนลดไหม" },
];

test("v1.4.9: pivotsToOnlineAfterLiveInterest จับเฉพาะ 'ถาม online หลังคุยเส้นสอนสด'", () => {
  assert.equal(pivotsToOnlineAfterLiveInterest({ text: "คลาสออนไลน์ ราคา", history: LIVE_HISTORY }), true);
  // online-first แท้ (ไม่มี live marker) = ไม่ใช่ pivot
  assert.equal(pivotsToOnlineAfterLiveInterest({ text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history: [] }), false);
  assert.equal(pivotsToOnlineAfterLiveInterest({
    text: "คลาสออนไลน์ ราคา",
    history: [{ role: "assistant", content: "คลาสออนไลน์เป็น VDO on demand 9,900 ค่ะ" }],
  }), false);
  // ถามราคาสอนสด (ไม่ใช่ online) = ไม่เข้า
  assert.equal(pivotsToOnlineAfterLiveInterest({ text: "คลาสสอนสดราคาเท่าไหร่", history: LIVE_HISTORY }), false);
});

test("v1.4.9: buildWarmthRules ตอน pivot = ให้เลือกเส้น + บิ๊ว superset ห้ามเทราคา online เดี่ยว", () => {
  const rules = buildWarmthRules({ score: 6, text: "คลาสออนไลน์ ราคา", history: LIVE_HISTORY }).join("\n");
  assert.match(rules, /สอนสด\s*หรือ/u, "ต้องมีคำถามให้เลือกสอนสด/ออนไลน์");
  assert.match(rules, /(ทบทวน|ครอบคลุม|เรียนสด)/u, "ต้องบิ๊วว่าสอนสดครอบคลุมกว่า");
  assert.ok(!rules.includes("PROMOTION Early Bird"), "ห้ามมีแม่แบบเทราคาในเทิร์น pivot");
});

test("v1.4.9: online-first แท้ ยังได้แม่แบบราคาปกติ (non-regression)", () => {
  const rules = buildWarmthRules({ score: 6, text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", customer: { known_context_at: 1 }, history: [{ role: "assistant", content: "คลาสออนไลน์เป็น VDO on demand ค่ะ" }] }).join("\n");
  assert.ok(rules.includes("PROMOTION Early Bird"), "online-first ต้องได้แม่แบบราคา");
  assert.ok(!/สอนสด\s*หรือ/u.test(rules), "ไม่ควรมีกฎ pivot");
});

test("v1.4.9b: pivot ไม่ trigger จากคำการตลาดของบอทเอง (กลุ่มเล็ก/atmosphere FU)", () => {
  // เคสรีวิว: บอทส่ง staged atmosphere FU "พี่ง้วงสอนกลุ่มเล็ก" แล้วลูกค้า online-first ถามราคา
  const botAtmosphere = [{ role: "assistant", content: "ส่งบรรยากาศคลาสจริง พี่ง้วงสอนกลุ่มเล็ก ดูแลใกล้ชิดทุกท่านเลยนะคะ" }];
  assert.equal(pivotsToOnlineAfterLiveInterest({ text: "คลาสออนไลน์ ราคาเท่าไหร่คะ", history: botAtmosphere }), false);
  // เส้นสอนสดจริง (มีราคา 12,900) ยัง trigger
  assert.equal(pivotsToOnlineAfterLiveInterest({ text: "คลาสออนไลน์ ราคา", history: [{ role: "assistant", content: "Early Bird 12,900 บาท/ท่าน" }] }), true);
});

/* ---- v1.4.10: feedback ทีมงาน (คุณ Kunjinda) 2026-08-17 ---- */

test("v1.4.10: กฎ bullet + intent เครื่องมือ + สิทธิ์นักเรียนเก่า อยู่ในชุดกฎเสมอ", async () => {
  const { buildConversationStyleRules } = await import("../src/conversationStyle.mjs");
  const rules = buildConversationStyleRules({ text: "สอนแค่ ChatGPT หรอคะ" });
  assert.match(rules, /ต้องจัดเป็นหัวข้อสั้น \+ bullet/u, "กฎ bullet กันก้อนข้อความยาว (ปัญหาซ้ำซาก)");
  assert.match(rules, /ห้ามเขียนเป็นย่อหน้าร้อยยาวติดกันเกิน 3 บรรทัด/u);
  assert.match(rules, /รายการเครื่องมือที่ใช้ในคลาส/u, "กฎ intent สอนแค่ X = ถามเครื่องมือ");
  assert.match(rules, /สิทธิ์นักเรียนเก่า/u);
  assert.match(rules, /EDDU/u, "ช่องทางอื่นต้องให้ทีมตรวจ ห้ามยืนยันเอง");
  assert.match(rules, /ห้ามลูกแพรตีความเทียบชื่อคลาสหรือยืนยันส่วนลดเอง/u);
});

/* ---- v1.4.14: feedback ทีมงาน (คุณ Kunjinda) 2026-08-18 ---- */

test("v1.4.14: แจ้งขอบเขตต้องเดิน 4 จังหวะ + ห้ามถ้อยคำแข็งที่ตัดความหวัง", async () => {
  const { buildConversationStyleRules } = await import("../src/conversationStyle.mjs");
  const rules = buildConversationStyleRules({ text: "อยากได้ระบบกระจายโพสต์หลายแพลตฟอร์มค่ะ" });
  // โครง 4 จังหวะ: รับรู้ -> สิ่งที่ช่วยได้ -> ขอบเขตเชิงต่อยอด -> ทางไปต่อ
  assert.match(rules, /4 จังหวะ/u, "ต้องมีโครงแจ้งขอบเขต");
  assert.match(rules, /สิ่งที่คลาสช่วยได้จริง/u, "ต้องพูดสิ่งที่ช่วยได้ก่อนข้อจำกัด");
  assert.match(rules, /ห้ามจบคำตอบไว้ที่ข้อจำกัด/u);
  // ถ้อยคำแข็งที่ทีมงานยกมาจากแชทจริง ต้องถูกห้ามชัด ๆ
  assert.match(rules, /ไม่ได้รับประกันว่า/u, "ต้องห้ามรูปประโยค 'ไม่ได้รับประกันว่า'");
  assert.match(rules, /ไม่ควรคาดหวังว่า/u);
  assert.match(rules, /ยังไม่ตรงกับขอบเขตคลาส/u);
  assert.match(rules, /ห้ามเปิดหัวคำตอบ\/เปิดบอลลูนด้วยการปฏิเสธ/u);
  assert.match(rules, /นำไปต่อยอดเรื่องนี้ได้/u, "ต้องมีตัวอย่างถ้อยคำที่ควรใช้แทน");
});

test("v1.4.14: ไม่มีข้อมูลในคลัง = ห้ามปฏิเสธเด็ดขาดว่าไม่ได้สอน", async () => {
  const { buildConversationStyleRules } = await import("../src/conversationStyle.mjs");
  const rules = buildConversationStyleRules({ text: "คลาสนี้สอน NotebookLM กับทำ Dashboard ไหมคะ" });
  assert.match(rules, /ไม่มีข้อมูลในคลังความรู้/u);
  assert.match(rules, /ห้ามตอบปฏิเสธเด็ดขาด/u, "การปฏิเสธจากความไม่รู้ = ปิดประตูการขายด้วยข้อมูลที่ไม่มี");
  assert.match(rules, /ขอให้ทีมงานยืนยันรายละเอียด/u, "ทางออกที่ปลอดภัย = ให้ทีมยืนยัน");
  assert.match(rules, /Private Class\/In-house/u, "ถ้าลูกค้าเน้นเรื่องนั้น ต้องมีทางไปต่อ");
});

/* ---- v1.4.15: คำสั่งพี่ง้วง 2026-08-18 — high-end ห้ามตอบแข็ง/ปฏิเสธ/สร้างกำแพง ---- */

test("v1.4.15: หลักการน้ำเสียง high-end อยู่ในชุดกฎทุกคำตอบ (ไม่ใช่เฉพาะเรื่องขอบเขต)", async () => {
  const { buildConversationStyleRules } = await import("../src/conversationStyle.mjs");
  // ยิงด้วยข้อความทั่วไปที่ไม่เกี่ยวขอบเขตเลย — กฎต้องยังอยู่
  const rules = buildConversationStyleRules({ text: "สวัสดีค่ะ" });
  assert.match(rules, /หลักการสูงสุดของน้ำเสียง/u);
  assert.match(rules, /ห้ามตอบแข็ง ห้วน หรือขึ้นต้นด้วยการปฏิเสธ/u);
  assert.match(rules, /เปลี่ยนเป็นการเสนอ/u, "เนื้อความเชิงลบต้องแปลงเป็นสิ่งที่ทำได้");
  assert.match(rules, /กำแพงปิดการขาย/u);
});

test("v1.4.15: ห้ามเสริมเองว่าไม่มีเครื่องรูดบัตรหน้างาน (เคสจริงพี่ง้วงชี้)", async () => {
  const { buildConversationStyleRules } = await import("../src/conversationStyle.mjs");
  const rules = buildConversationStyleRules({ text: "รับบัตรเครดิตมั้ยคะ รับบัตรอะไรบ้างคะ" });
  assert.match(rules, /ไม่มีเครื่องรูดบัตรหน้างาน/u, "ต้องระบุประโยคต้องห้ามให้ชัด");
  assert.match(rules, /ห้ามเสริมข้อจำกัดที่ลูกค้าไม่ได้ถาม/u);
});

/* ---- v1.4.24: journey จับบอทคำนวณราคางาน project เอง (2026-08-19) ---- */

test("v1.4.24: งาน Private/In-house ห้ามคำนวณยอดรวมตามจำนวนท่านเอง", async () => {
  const { buildConversationStyleRules } = await import("../src/conversationStyle.mjs");
  const rules = buildConversationStyleRules({ text: "ทีมผมมี 6 คน อยากได้แบบส่วนตัวมากกว่าครับ" });
  assert.match(rules, /Private Class \/ In-house \/ วิทยากร/u);
  assert.match(rules, /ห้ามคำนวณยอดรวมตามจำนวนท่านเอง/u);
  assert.match(rules, /ห้ามบวกค่าบริการท่านที่เกินเอง/u);
  assert.match(rules, /ทีมผู้ดูแลเป็นผู้ออกใบเสนอราคา/u);
});

/* ===== v1.4.39: การต่อรองส่วนลด = การถามราคา (probe-objection-09) ===== */
//
// เดิม "ขอส่วนลดเพิ่ม" / "ลดได้อีกมั้ย" ไม่มีคำว่าราคาหรือเท่าไหร่ จึงไม่ถูกนับเป็น
// การถามราคา -> กติกา "ถามซ้ำครั้งที่สองต้องให้ราคาไปเลย" ไม่เคยทำงานกับการต่อรอง
// ผลจริง: ลูกค้าขอส่วนลดสองรอบติด จนจบเคสยังไม่เคยเห็นตัวเลขสักตัว

for (const line of [
  "ขอส่วนลดเพิ่มได้ไหม",
  "ลดได้อีกหน่อยมั้ยคะ 10000 พอดีมั้ย",
  "พามาด้วยกัน 3 คน ลดได้อีกมั้ยคะ",
  "มา 3 คนมีส่วนลดไหม",
  "ถ้า 2 คนลดมั้ยคะ",
  "ลดมั้ยคะ ขอราคาน่ารักๆ",
]) {
  test(`price: การต่อรองนับเป็นการถามราคา — "${line.slice(0, 30)}…"`, () => {
    assert.equal(asksAboutPrice(line), true);
  });
}

// คำว่า "ลด" ในบริบทโจทย์ธุรกิจ ห้ามนับเป็นการถามราคา ไม่งั้นบอทจะเทราคาใส่ลูกค้า
// ตอนที่เขากำลังเล่าปัญหางานอยู่ ซึ่งเป็นจังหวะที่ผิดที่สุด
for (const line of [
  "อยากเอา ai มาช่วยลดงานเอกสารครับ",
  "ช่วยลดขั้นตอนการทำงานได้ไหมครับ",
  "AI ช่วยลดต้นทุนได้เยอะเลยใช่ไหม",
  "อยากลดเวลาทำรายงานครับ",
]) {
  test(`price: "ลด" เรื่องงาน ไม่ใช่การถามราคา — "${line.slice(0, 30)}…"`, () => {
    assert.equal(asksAboutPrice(line), false);
  });
}

/* ===== v1.4.40: คลาสทดลองเรียนฟรี = ของสำหรับลูกค้าที่อุ่นแล้วเท่านั้น ===== */
//
// คำสั่งพี่ง้วง 2026-08-21: hot เท่านั้นถึงจะเล่าเต็มที่ได้ · cold/warm ให้แบ่งรับแบ่งสู้
// แล้วถามต่อ เหตุผล: ถ้าแจกตั้งแต่ยังไม่รู้จักกัน มันจะกลายเป็นทางออกให้ลูกค้าเลี่ยง
// การตัดสินใจแล้วหายไป (ทรงเดียวกับบั๊ก downgrade ไปออนไลน์ ซึ่งเคยเสียเงินจริง)

test("trial: ลูกค้า hot -> เล่าเรื่องคลาสทดลองได้เต็มที่", () => {
  const rules = [buildWarmthRules({ score: 9, text: "มีทดลองเรียนมั้ยครับ" })].flat().join("\n");
  assert.match(rules, /คลาสทดลองเรียน: ลูกค้ารายนี้อุ่นพอแล้ว/u);
});

for (const [label, score] of [["warm", 6], ["cold", 2], ["ยังไม่มีคะแนน", null]]) {
  test(`trial: ลูกค้า ${label} -> ห้ามเสนอเอง ให้แบ่งรับแบ่งสู้แล้วถามต่อ`, () => {
    const rules = [buildWarmthRules({ score, text: "มีทดลองเรียนมั้ยครับ" })].flat().join("\n");
    assert.match(rules, /ยังไม่อุ่นพอ ห้ามเสนอคลาสทดลองเรียนเอง/u);
    assert.match(rules, /มีคลาสทดลอง/u, "ต้องตอบความจริงว่ามีคลาสทดลอง ไม่แต่งว่ากำลังจัดทำ");
    assert.doesNotMatch(rules, /กำลังจัดทำ|ยังไม่มีรายละเอียด/u);
    // ต้องไม่กลายเป็นการปิดประตู — พี่ง้วงย้ำหลายรอบว่าห้ามตอบแข็งกับลูกค้า high-end
    assert.match(rules, /ห้ามปิดประตู/u);
  });
}

/* ===== v1.4.43: ขอยกเลิก/เลื่อนการมาเรียน — เห็นใจก่อน เลื่อนได้ ไม่ขาย ===== */
//
// เคสจริงในคลังแชท: "ขอยกเลิกไปเรียนค่ะ พอดีลูกชายไม่สบาย" — เดิมไม่มีกติกาอะไรจับ
// พี่ง้วงเคาะนโยบาย 2026-08-22: empathy ตามสไตล์เรา + เลื่อนคลาสได้ เมื่อพร้อมแจ้งล่วงหน้า
//
// วัดกับคลังจริง 10,530 ข้อความไม่ซ้ำ: จับ 14 ข้อความ เป็นการขอเลื่อน/ยกเลิกจริงทั้งหมด
// (ตอนแรกจับ 18 — มี 4 ข้อความ "ไม่สะดวกเรียนสด" ซึ่งคือการคุยเรื่องรูปแบบคลาส
//  = จังหวะขายเสนอทางเลือก ไม่ใช่การยกเลิกที่นั่ง จึงกันออกด้วย lookahead)
import { asksToRescheduleAttendance } from "../src/conversationStyle.mjs";

for (const line of [
  "สวัสดีค่ะ ขอโทษด้วยนะคะ ขอยกเลิกไปเรียนค่ะ พอดีลูกชายไม่สบาย",
  "งั้นขออนุญาต ยกเลิก 17 สค ก่อนนะคะ",
  "ขอเลื่อนรอบได้ไหมคะ ติดธุระด่วน",
  "แต่พอดีตอนนี้ติดโควิดถ้าจะขอเลื่อนคอร์สแรกไปเป็นวันเสาร์หน้าจะได้ไหมคะ",
  "ไม่สะดวกไปเรียนแล้วค่ะ ขอโทษด้วยนะคะ",
  "พอดีติดงาน ไปเรียนวันเสาร์ไม่ได้ครับ",
]) {
  test(`reschedule: คำขอเลื่อน/ยกเลิกการมาเรียน ต้องจับ — "${line.slice(0, 36)}…"`, () => {
    assert.equal(asksToRescheduleAttendance(line), true);
    assert.match(buildConversationStyleRules({ text: line }), /เห็นใจจริงใจ/u);
  });
}

for (const line of [
  // รูปแบบคลาส = จังหวะขาย ไม่ใช่การยกเลิก (เคสจริง 4 ข้อความในคลัง)
  "ไม่สะดวกเรียนสดค่ะเพราะอยู่ต่างจังหวัด",
  "พี่ไม่สะดวกไปเรียนสอนสดจริงๆ ค่ะ",
  // เลิกติดตาม/บริการเจ้าอื่น/เรื่องเล่าธุรกิจ — คนละเรื่องกับการเลื่อนเรียน
  "ยกเลิกการติดตามค่ะ",
  "น้อง admin คะ Gemini ที่ 1 ปี ฟรี หลังจากนั้นยกเลิกได้ไหมคะ",
  "ทางศูนย์บัตรแจ้งว่า ทางร้านยกเลิกออเดอร์ค่ะ",
  // "เลื่อน" ที่แปลว่าเลื่อนหน้าจอ
  "เลื่อนดูรายละเอียดคลาสแล้วค่ะ น่าสนใจมาก",
]) {
  test(`reschedule: ต้องไม่จับ — "${line.slice(0, 36)}…"`, () => {
    assert.equal(asksToRescheduleAttendance(line), false);
  });
}

test("reschedule: กติกาบอกครบ เห็นใจก่อน+เลื่อนได้+ห้ามขาย+เงินคืนส่งต่อทีม", () => {
  const rules = buildConversationStyleRules({ text: "ขอยกเลิกไปเรียนค่ะ พอดีลูกชายไม่สบาย" });
  assert.match(rules, /เลื่อนไปรอบที่สะดวกได้/u);
  assert.match(rules, /แจ้งเข้ามาล่วงหน้า/u);
  assert.match(rules, /ห้ามขาย/u);
  assert.match(rules, /ห้ามแจ้งเงื่อนไขเงินคืนเอง/u);
});

/* ===== v1.4.45: หลายบอลลูนติดกัน ต้องตอบให้ครบทุกบอลลูน ===== */
//
// เคสจริงพี่ง้วงเทสเอง 2026-08-22 22:03: 4 บอลลูน "ผมทำสำนักงานบัญชี / ช่วย แก้งาน /
// ออเดอร์ ลูกหนี้ / ทั่วไปครับ" บอทตอบเฉพาะสองบอลลูนแรก จนดูเหมือนอ่านได้แค่ 2-3 บอลลูน
// ความจริง burst รวมครบ แต่โมเดลไม่มีสัญญาณว่าเป็นคนละข้อความและไม่มีกติกาให้ตอบครบ
test("burst: หลายบอลลูน -> มีกติกาตอบให้ครบทุกข้อความ + ห้ามถามซ้ำสิ่งที่ตอบไว้ท้าย ๆ", () => {
  const rules = buildConversationStyleRules({ text: "ผมทำสำนักงานบัญชี\nช่วย แก้งาน\nออเดอร์ ลูกหนี้\nทั่วไปครับ", burstCount: 4 });
  assert.match(rules, /4 ข้อความติดกัน/u);
  assert.match(rules, /ตอบให้ครอบทุกข้อความ/u);
  assert.match(rules, /ห้ามถามซ้ำสิ่งที่ลูกค้าเพิ่งตอบ/u);
});

test("burst: บอลลูนเดียว -> ไม่มีกติกานี้ (ไม่รก prompt)", () => {
  const rules = buildConversationStyleRules({ text: "สนใจคลาส AI ค่ะ", burstCount: 1 });
  assert.doesNotMatch(rules, /ข้อความติดกัน/u);
});
