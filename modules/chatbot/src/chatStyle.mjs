// chatStyle.mjs — สไตล์การพิมพ์ของลูกค้า นับจากข้อความที่เขาพิมพ์เองจริง (ไม่ใช้โมเดล ไม่มีค่าใช้จ่าย)
//
// มาแทน DISC (พี่ง้วงสั่ง 4 ต.ค. 2026 หลังตรวจข้อมูล ก.ย.: ตัวให้คะแนนอ่าน DISC ไม่ออก 81%
// ที่อ่านออกเป็น C 86% เพราะลูกค้าแชทถามราคา/รอบเรียนเหมือนกันหมด = อ่านสถานการณ์ ไม่ใช่คน)
// สิ่งที่นับได้แน่นอนจากตัวอักษร: พิมพ์สั้นหรือยาว · ใช้อีโมจิไหม · ถามหลายข้อไหม
// ใช้ปรับความยาว/น้ำเสียงของคำตอบเท่านั้น ไม่ตัดสินความพร้อมซื้อหรือตัวตนลูกค้า

import { isPresetButtonTap } from "./presetButtons.mjs";

const EMOJI = /\p{Extended_Pictographic}/u;
const QUESTION = /(?:[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|ยังไง|อย่างไร|เท่าไหร่|เท่าไร|กี่|ที่ไหน|เมื่อไหร่|ไหนบ้าง|อะไรบ้าง)/u;
// ข้อความที่ระบบสร้างแทนสื่อ (รูป สติกเกอร์ ไฟล์) ไม่ใช่สิ่งที่ลูกค้าพิมพ์
const PLACEHOLDER = /^\s*[([]/u;
export const CHAT_STYLE_MIN_MESSAGES = 2;
export const SHORT_MEDIAN_CHARS = 20;
export const LONG_MEDIAN_CHARS = 90;

// ปุ่มเมนูสำเร็จรูป (เช่น "คิดค่าบริการเท่าไหร่") ไม่ใช่สิ่งที่ลูกค้าพิมพ์ — นับแล้วจะได้ "พิมพ์สั้น/ถามหลายเรื่อง" ของเมนู ไม่ใช่ของคน
const typedByCustomer = (history = [], presetPhrases = null) => (Array.isArray(history) ? history : [])
  .filter((turn) => turn?.role === "user" && !turn.fromPresetButton)
  .map((turn) => String(turn.content ?? "").trim())
  .filter((text) => text && !PLACEHOLDER.test(text) && !(presetPhrases && isPresetButtonTap(text, presetPhrases)));

export function readChatStyle(history = [], currentText = "", { presetPhrases = null } = {}) {
  const texts = [...typedByCustomer(history, presetPhrases), ...typedByCustomer([{ role: "user", content: currentText }], presetPhrases)].slice(-8);
  if (texts.length < CHAT_STYLE_MIN_MESSAGES) return null;
  const lengths = texts.map((t) => [...t].length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  const share = (pattern) => texts.filter((t) => pattern.test(t)).length / texts.length;
  return {
    messages: texts.length,
    medianChars: median,
    length: median <= SHORT_MEDIAN_CHARS ? "short" : median >= LONG_MEDIAN_CHARS ? "long" : "medium",
    emoji: share(EMOJI) >= 0.3,
    asksALot: share(QUESTION) >= 0.6 && texts.length >= 3,
  };
}

// บรรทัดเดียวสำหรับกติกาของเทิร์น — คืน "" เมื่อยังไม่มีสัญญาณพอ (พรอมต์ไม่เปลี่ยน)
export function chatStyleRule(style) {
  if (!style) return "";
  const parts = [];
  // ไม่สั่ง "ตอบสั้น" เฉย ๆ — รอบทดสอบ 1 คำตอบที่สั้นจนไม่มีประโยคให้คุณค่าแพ้ 5.6 (พี่ง้วงเลือกเอง)
  if (style.length === "short") parts.push("ลูกค้าพิมพ์สั้น → เลี่ยงรายการยาวหรือหลายย่อหน้า แต่ยังมีคุณค่าหนึ่งประโยคกับก้าวถัดไปตามปกติ");
  if (style.length === "long") parts.push("ลูกค้าพิมพ์ยาวเล่าละเอียด → ตอบรับเรื่องที่เขาเล่าให้ครบก่อน แล้วค่อยพาไปต่อ");
  if (style.emoji) parts.push("ลูกค้าใช้อีโมจิ → ใส่อีโมจิอุ่น ๆ ได้");
  if (style.asksALot) parts.push("ลูกค้าถามหลายเรื่อง → ตอบให้ครบทุกคำถามก่อนถามกลับ");
  if (!parts.length) return "";
  return `- สไตล์แชทของลูกค้า (นับจากที่เขาพิมพ์เอง ใช้ปรับความยาวและน้ำเสียงเท่านั้น): ${parts.join(" · ")}`;
}
