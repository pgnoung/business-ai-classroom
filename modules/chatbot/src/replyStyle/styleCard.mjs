// styleCard.mjs — การ์ดสไตล์การเขียนของลูกแพร (ถอดจากคำตอบ Opus 5.5 ที่ทีมเลือกในเทสปิดตารอบ 6–8)
// พี่ง้วง 5 พ.ย. 2026: "ฝากสอน sonnet ด้วย opus สไตล์ก่อน" — ให้รุ่นที่ถูกกว่าเขียนน้ำเสียงเดียวกับ Opus
//
// สวิตช์ reply_style_card (ไม่ต้อง deploy):
//   off (ไม่มีแถว = ค่าเริ่มต้น) — พรอมต์ทุกไบต์เหมือนเดิม แคชเดิมของ Opus ไม่ขยับ
//   on — ต่อการ์ดท้ายบล็อกคงที่ (ก้อนที่แคชได้) จึงจ่ายเต็มราคาแค่ตอนเขียนแคช แล้วอ่านถูกทุกเทิร์น
// การ์ดเป็นเรื่องน้ำเสียงและโครงข้อความเท่านั้น: ไม่มีราคา รอบเรียน วันที่ ขนาดกลุ่ม หรือข้อเท็จจริงธุรกิจอื่น
// ข้อมูลจริงมาจากบล็อกต่อเทิร์นเสมอ (เทสต์ล็อกไว้ว่าการ์ดไม่มีตัวเลขราคา/วันที่)
// แก้ถ้อยคำที่ styleCard.json แล้วขึ้น version ใหม่ — แหล่งที่มาและเหตุผลอยู่ใน skills/lukprae-opus-style/
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const REPLY_STYLE_CARD_KEY = "reply_style_card";
export const REPLY_STYLE_CARD_MODES = Object.freeze(["on", "off"]);

const CARD = Object.freeze(JSON.parse(readFileSync(new URL("./styleCard.json", import.meta.url), "utf8")));
export const STYLE_CARD_VERSION = String(CARD.version || "");

export function replyStyleCardMode(db) {
  try {
    return String(db?.getSetting?.(REPLY_STYLE_CARD_KEY) ?? "").trim().toLowerCase() === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

/** ข้อความการ์ดที่ต่อท้ายบล็อกคงที่ — ลำดับ: หัว · กติกาใช้การ์ด · หลักการเขียน · ตัวอย่างน้ำเสียงต่อจังหวะ */
export function styleCardText(card = CARD) {
  // ขีดนำ ไม่ใช่เลขลำดับ — การ์ดต้องไม่มีตัวเลขเลย (เทสต์กันราคา/วันที่หลุดเข้ามาด้วยกติกาเดียวกัน)
  const rules = (card.rules || []).map((rule) => `- ${rule}`).join("\n");
  const examples = (card.examples || []).map((example) =>
    `[${example.stage}] ลูกค้า: ${example.customer}\nลูกแพร: ${example.reply}`).join("\n\n");
  return [
    "## สไตล์การเขียนของลูกแพร",
    card.preface,
    `### หลักการเขียน\n${rules}`,
    examples ? `### ตัวอย่างน้ำเสียง\n${card.examplesNote}\n\n${examples}` : "",
  ].filter(Boolean).join("\n\n");
}

export const STYLE_CARD_SHA = createHash("sha256").update(styleCardText()).digest("hex").slice(0, 12);
