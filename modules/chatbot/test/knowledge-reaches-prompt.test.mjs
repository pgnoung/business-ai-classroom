// เทสต์ชุดนี้เกิดจากเหตุจริง 2026-08-13: ลูกแพรตอบเลขบัญชีเป็น [เลขบัญชี] และกลับคำ
// เรื่องส่วนลด 2 ท่านภายใน 44 วินาที ทั้งที่ข้อมูลทั้งสองอย่างอยู่ในคลังความรู้ครบ
//
// สาเหตุ: ความรู้ถูกต่อท้าย brand pack แล้วเดินทางผ่าน selectRelevantBrandPack ซึ่งจบด้วย
// .slice(0, 4000) พฤติกรรมจึงแยกเป็นสองขั้วชัดเจน
//   - เทิร์นที่การ์ดแมตช์   -> ตัดเหลือ 4,000 ตัวอักษร = ความรู้หายเกือบหมด
//   - เทิร์นที่การ์ดไม่แมตช์ -> คืนทั้งก้อน = ความรู้ครบ
// บทสนทนาเดียวจึงถือข้อเท็จจริงคนละชุดข้ามเทิร์น และโมเดลขัดแย้งกับตัวเองอย่างมั่นใจ
//
// เทสต์นี้ต้องแดงกับดีไซน์เดิม (พิสูจน์แล้ว: ขาดข้อมูล 6 จาก 8 คำถาม) และเขียวกับดีไซน์ใหม่
import test from "node:test";
import assert from "node:assert/strict";

import { buildKnowledgeSection } from "../src/knowledgePack.mjs";
import { selectRelevantBrandPack } from "../src/brainPackSelector.mjs";
import { createApp } from "../src/server.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// จำลองคลังความรู้จริงของลูกแพร: 11 รายการ ~20,000 ตัวอักษร โดยข้อเท็จจริงที่ใช้ปิดการขาย
// อยู่ใน "รายการเก่าสุด" ซึ่งเป็นตำแหน่งที่เสียเปรียบที่สุดของตัวตัดทั้งสองตัว
const FILLER = "ก".repeat(1800);
const ENTRIES = [
  { title: "คลาสและบริการทั้งหมด + ราคา", content: `AI Agent for Business ราคาปกติ 19,900 บาท Early Bird 12,900 บาท\nมา 2 ท่านขึ้นไปลดเพิ่มท่านละ 1,000 เหลือท่านละ 11,900 บาท\n${FILLER}` },
  { title: "ขั้นตอนปิดการขาย", content: `ต้องถามก่อนเสมอว่าออกใบกำกับภาษีในนามบุคคลธรรมดาหรือบริษัท\nธนาคารกสิกรไทย เลขที่บัญชี 1793924778\n${FILLER}` },
  { title: "การชำระเงิน ภาษี และเอกสาร", content: `นิติบุคคลหักภาษี ณ ที่จ่าย 3% จากยอดก่อน VAT\n${FILLER}` },
  { title: "รอบเรียนสอนสดที่เปิดรับ", content: `เสาร์ 22 ส.ค. 2026 เวลา 10:00-17:00 น. Classroom Basic\n${FILLER}` },
  ...Array.from({ length: 7 }, (_, i) => ({ title: `หัวข้ออื่น ${i}`, content: "ข".repeat(1900) })),
];

// ข้อเท็จจริงที่ถ้าหายแล้วเสียเงินจริงหรือเสียความเชื่อถือจริง
const MUST_REACH_MODEL = [
  ["เลขบัญชีรับเงิน", "1793924778"],
  ["ราคาส่วนลด 2 ท่าน", "11,900"],
  ["รอบเรียนที่ประกาศแล้ว", "22 ส.ค. 2026"],
  ["เงื่อนไขใบกำกับภาษี", "ใบกำกับภาษี"],
  ["อัตราหัก ณ ที่จ่าย", "3%"],
];

// คำถามจริงจากบทสนทนา 2026-08-13 — ครอบทั้งเส้นที่การ์ดแมตช์และไม่แมตช์
const REAL_QUESTIONS = [
  "ต้องโอนไปที่ไหนครับ",
  "เรียน 2 คนมีส่วนลดอะไรไหม",
  "รอบเรียนวันไหนบ้าง",
  "ออกใบกำกับได้ไหม",
  "หัก ณ ที่จ่ายไหม",
  "ราคาเท่าไหร่",
  "สอนอะไรบ้าง",
  "คับ",
];

// รูปแบบ pack จริงของลูกแพร (marker + JSON) — ใช้ของจริงเพื่อให้ตัวเลือกการ์ดทำงานเหมือนโปรดักชัน
const PACK_ENTRIES = [
  { id: "c-pay", titleTh: "การชำระเงิน โอนเงิน ใบกำกับภาษี", answerTh: "ค".repeat(700),
    tags: ["โอนเงิน", "โอน", "บัญชี", "ใบกำกับภาษี", "ใบกำกับ", "หัก ณ ที่จ่าย"] },
  { id: "c-class", titleTh: "รอบเรียน ส่วนลด ราคา และเนื้อหาที่สอน", answerTh: "ค".repeat(700),
    tags: ["รอบเรียน", "ส่วนลด", "ราคา", "สอนอะไร", "เรียน"] },
];
const BRAND_PACK = [
  "LUKPRAE_BRAIN_PACK_JSON_V1",
  JSON.stringify({ packId: "test-pack", entries: PACK_ENTRIES }),
  "END_LUKPRAE_BRAIN_PACK_JSON_V1",
  "",
  "กติกาความปลอดภัย: ราคาทุกตัวต้องมาจากรายการที่อนุมัติแล้วเท่านั้น",
].join("\n");

const knowledge = buildKnowledgeSection(ENTRIES, { logger: silent });

function missingFacts(systemPrompt) {
  return MUST_REACH_MODEL.filter(([, needle]) => !systemPrompt.includes(needle)).map(([label]) => label);
}

test("ดีไซน์เดิมทำข้อเท็จจริงหายจริง — ตรึงไว้เป็นหลักฐานว่าบั๊กมีอยู่", () => {
  // ความรู้ต่อท้าย brand pack แล้วผ่านตัวเลือกการ์ด = เส้นทางเดิมก่อน v1.3.4
  const damaged = REAL_QUESTIONS.filter((question) =>
    missingFacts(selectRelevantBrandPack(`${BRAND_PACK}\n\n${knowledge}`, question, {})).length > 0);
  assert.ok(
    damaged.length > 0,
    "ถ้าเทสต์นี้เขียว แปลว่าเส้นทางเดิมไม่ทำข้อมูลหายแล้ว — ให้ลบเทสต์นี้ทิ้ง อย่าแก้ให้ผ่าน",
  );
});

test("ดีไซน์ใหม่: ข้อเท็จจริงที่ใช้ปิดการขายต้องถึงโมเดลครบทุกคำถาม", () => {
  const failures = [];
  for (const question of REAL_QUESTIONS) {
    // เส้นทางจริงหลัง v1.3.4: การ์ดผ่านตัวเลือก ส่วนความรู้เป็นพารามิเตอร์แยก
    const cards = selectRelevantBrandPack(BRAND_PACK, question, {});
    const systemPrompt = [cards, knowledge].filter(Boolean).join("\n\n");
    const missing = missingFacts(systemPrompt);
    if (missing.length) failures.push(`"${question}" ขาด: ${missing.join(", ")}`);
  }
  assert.deepEqual(failures, [], `ข้อเท็จจริงหายจาก prompt:\n${failures.join("\n")}`);
});

test("ความรู้ต้องไม่ถูกตัดกลางตัวอักษร — ทุกบล็อกต้องเป็นก้อนเต็ม", () => {
  // เหตุจริง: prompt ที่ส่งออกไปลงท้ายด้วย "...เหลือ 25,900 บาท/ท" (ตัดกลางคำ)
  // ตัวเลขที่ถูกตัดครึ่งอันตรายกว่าตัวเลขที่หายไป เพราะมันยังดูเหมือนตัวเลขที่ใช้ได้
  for (const entry of ENTRIES) {
    const block = `[${entry.title}]\n${entry.content}`;
    assert.ok(knowledge.includes(block), `รายการ "${entry.title}" ต้องอยู่ครบทั้งก้อน ไม่ใช่ถูกตัดครึ่ง`);
  }
});

test("เงื่อนไขต้องเดินทางมาพร้อมข้อเท็จจริงเสมอ", () => {
  // เลขบัญชีที่มาโดยไม่มีเงื่อนไข "ถามใบกำกับภาษีก่อน" อันตรายกว่าไม่มีเลขบัญชีเลย
  for (const question of REAL_QUESTIONS) {
    const systemPrompt = [selectRelevantBrandPack(BRAND_PACK, question, {}), knowledge].join("\n\n");
    if (!systemPrompt.includes("1793924778")) continue;
    assert.match(systemPrompt, /บุคคลธรรมดาหรือบริษัท/u,
      `prompt ของ "${question}" มีเลขบัญชีแต่ไม่มีเงื่อนไขที่ต้องถามก่อน`);
  }
});

test("ขนาด prompt ที่ได้ต้องยังอยู่ในเพดานของเกตเวย์อย่างมีที่เหลือ", () => {
  const worst = Math.max(...REAL_QUESTIONS.map((question) =>
    [selectRelevantBrandPack(BRAND_PACK, question, {}), knowledge].join("\n\n").length));
  // เพดานข้อความเดี่ยวของเกตเวย์คือ 200,000 ตัวอักษร (openai-stateless-gateway.mjs)
  // ยังไม่รวม persona + rules จึงเผื่อไว้ครึ่งหนึ่ง
  assert.ok(worst < 100_000, `prompt ใหญ่เกินคาด ${worst.toLocaleString()} ตัวอักษร`);
});

/* ---- ผูกกับสายไฟจริง: เทสต์ข้างบนยังเขียวแม้ย้อน pipeline.mjs กลับดีไซน์เดิม ---- */

test("สายไฟจริง: ความรู้ต้องถึง system prompt ที่ยิงออกไปจริง แม้การ์ดจะแมตช์", async () => {
  // ตรวจปรปักษ์ชี้ว่าเทสต์ทองคำข้างบนเรียก selectRelevantBrandPack ตรง ๆ จึงไม่คุมว่า
  // pipeline ต่อสายอย่างไร — ย้อน pipeline.mjs กลับดีไซน์เดิมแล้วเทสต์ยังเขียวครบ
  // เทสต์นี้ดัก body ที่ส่งเข้า Hermes จริง จึงแดงทันทีถ้าใครถอดสายความรู้ออก
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });

  db.addKnowledge({ title: "ขั้นตอนปิดการขาย", content: `ธนาคารกสิกรไทย เลขที่บัญชี 1793924778\n${"ก".repeat(2500)}` });
  db.addKnowledge({ title: "ส่วนลดทั้งหมด", content: `มา 2 ท่านลดเพิ่มท่านละ 1,000 เหลือ 11,900 บาท\n${"ข".repeat(2500)}` });
  for (let i = 0; i < 5; i++) db.addKnowledge({ title: `หัวข้ออื่น ${i}`, content: "ค".repeat(2000) });

  // ถามเรื่องโอนเงิน = คำถามที่การ์ดในแพ็กจริงมักแมตช์ ซึ่งเป็นเส้นที่เคยตัดความรู้ทิ้ง
  await app.pipeline.handleInboundText({ customerId: "U-wire", text: "ต้องโอนไปที่ไหนครับ", replyToken: "rt" });

  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(system.includes("1793924778"), "เลขบัญชีต้องอยู่ใน system prompt ที่ยิงออกไปจริง");
  assert.ok(system.includes("11,900"), "ราคาส่วนลดต้องอยู่ใน system prompt ที่ยิงออกไปจริง");
  db.close();
});
