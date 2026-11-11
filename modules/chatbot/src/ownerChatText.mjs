// ownerChatText.mjs — ตัวช่วยข้อความของ "คุยกับลูกแพร" ทาง Telegram (28 ก.ย. 2026) ฟังก์ชันบริสุทธิ์ล้วน
//
// Telegram ไม่ใช่ช่องทางเข้ารหัสปลายทาง (กติกาเดียวกับ telegramReplies.mjs): อะไรที่ส่งเข้าโมเดลของแชทนี้
// มีสิทธิ์ถูกพิมพ์ออกไปใน Telegram — จึงกรองตั้งแต่ขาเข้า (ชื่อเต็มลูกค้า เบอร์ อีเมล ลิงก์ เลขยาว)
// และกรองซ้ำที่ขาออก (เลขบัญชี โทเคน คีย์ markdown) ไม่พึ่งให้โมเดลจำกติกาอย่างเดียว
import { redactBotSecrets } from "./telegramClient.mjs";
import { maskName } from "./yoloText.mjs";

const URL = /https?:\/\/\S+/giu;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
// 9 หลักขึ้นไป (คั่นด้วยขีด/ช่องว่าง/จุด/วงเล็บได้ เช่น "(081) 234-5678") = เบอร์โทร เลขบัญชี เลขบัตร
// ราคา (9,900 — มีจุลภาค) วันที่ (2026-10-10 — 8 หลัก) เวลา (10:00) ไม่เข้าข่าย
const LONG_DIGITS = /(?<!\d)\+?\(?\d(?:[\s().-]{0,2}\d){8,}(?!\d)/gu;
// รูปกุญแจ/โทเคนที่พบบ่อย — ห้ามออกไปทาง Telegram ไม่ว่าโมเดลจะได้มาจากไหน
const KEY_LIKE = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*|\b[A-Fa-f0-9]{40,}\b/gu;

export const REDACTED_NUMBER = "[เลขยาวถูกซ่อน]";
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// รูปชื่อที่ต้องปิด: ชื่อเต็ม + คำแรก (คนเรียกกันด้วยชื่อต้น "คุณสมชาย") + ชื่อที่ตัด "คุณ" นำหน้าออก
// ทุกรูปต้องยาว 3 ตัวขึ้นไป (เกณฑ์เดียวกับด่านชื่อลูกค้าของบทเรียน) — ชื่อสั้นอย่าง "เอ" ไปโดนคำทั่วไป
// ("เอไอ") จนข้อความอ่านไม่รู้เรื่อง และชื่อสองตัวอักษรเองก็ระบุตัวคนแทบไม่ได้
export function customerNameForms(names) {
  const out = new Set();
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw || "").normalize("NFC").replace(/\s+/gu, " ").trim();
    const bare = name.replace(/^คุณ\s*/u, "");
    for (const form of [name, bare, bare.split(" ")[0]]) if ([...form].length >= 3) out.add(form);
  }
  return [...out].sort((a, b) => b.length - a.length); // ยาวก่อน — "สมชาย ใจดี" ต้องไม่เหลือ " ใจดี" ค้าง
}

/** ข้อความลูกค้า/สรุปห้องก่อนเข้าบริบท: ชื่อของห้องนั้นกลายเป็นชื่อปิดบัง + ซ่อนเบอร์/อีเมล/ลิงก์ */
export function scrubCustomerText(text, { names = [], label = "" } = {}) {
  let value = String(text ?? "").normalize("NFC");
  const mask = label ? maskName(label, 3) : "[ชื่อลูกค้า]";
  const forms = customerNameForms(names);
  // แทนทีเดียวทุกรูป — แทนทีละรูปจะไปโดนชื่อปิดบังที่เพิ่งใส่ ("มานี***" มีคำว่า "มานี" อยู่ข้างใน)
  if (forms.length) value = value.replace(new RegExp(forms.map(escapeRegExp).join("|"), "gu"), mask);
  return value.replace(URL, "[ลิงก์]").replace(EMAIL, "[อีเมล]").replace(LONG_DIGITS, REDACTED_NUMBER);
}

// โมเดลเล็ก (luna effort ต่ำ) บางครั้งหลุดคำจากอักษรอื่นท้ายบรรทัด — เจอจริงในรอบทดสอบ 28 ก.ย.:
// "…ส่งข้อความตามร่างนี้ ━ ашкол" · ตัดเฉพาะก้อนท้ายบรรทัดที่เป็นอักษรนอกไทย/ละติน (ไม่แตะกลางประโยค)
const FOREIGN_SCRIPT = "\\p{Script=Cyrillic}\\p{Script=Greek}\\p{Script=Arabic}\\p{Script=Hebrew}\\p{Script=Armenian}\\p{Script=Georgian}"
  + "\\p{Script=Devanagari}\\p{Script=Bengali}\\p{Script=Tamil}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
const TRAILING_FOREIGN = new RegExp(`[ \\t━─—–]*(?:[${FOREIGN_SCRIPT}][\\p{L}\\p{M}]*[ \\t.,!?━─—–]*)+$`, "gmu");

/** กรองคำตอบของลูกแพรก่อนส่ง Telegram: เลขยาว/โทเคน/กุญแจ + markdown ที่ Telegram ไม่แปล (ข้อความธรรมดา) */
export function cleanOwnerReply(text) {
  return redactBotSecrets(String(text ?? ""))
    .replace(KEY_LIKE, "[ซ่อนไว้]")
    .replace(LONG_DIGITS, REDACTED_NUMBER)
    // ตัวหนา **…** เท่านั้น — ชื่อปิดบัง "สมช***" มีดาวสามดวงติดกัน ห้ามโดนจับคู่ข้ามชื่อ (เจอจริงในรอบทดสอบ
    // กับโมเดลจริง 28 ก.ย.: "พิมพ์*** … Sar***" กลายเป็น "พิมพ์* … Sar*")
    .replace(/(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)/gsu, "$1")
    .replace(/__(.+?)__/gsu, "$1")
    .replace(/`{1,3}/gu, "")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(TRAILING_FOREIGN, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

// "รอ 2 ชม." — ระยะเวลาแบบคนอ่าน (นาที/ชม./วัน) ปัดลง ไม่มีทศนิยม
export function durationText(ms) {
  const value = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(value / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} นาที`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ชม.`;
  return `${Math.floor(hours / 24)} วัน`;
}

/** ตัดตามตัวอักษรที่มองเห็น (ไม่ตัดกลางสระ) พร้อม … — ใช้กับทุกช่องที่มาจากคน/โมเดล */
export function clampText(text, max) {
  const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
  const parts = typeof Intl?.Segmenter === "function"
    ? [...new Intl.Segmenter("th", { granularity: "grapheme" }).segment(flat)].map((part) => part.segment)
    : [...flat];
  return parts.length <= max ? flat : `${parts.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

/** ตัดความยาว (หน่วย UTF-16) ที่ขอบตัวอักษร ไม่ตัดกลางสระ/วรรณยุกต์ — คงบรรทัดใหม่ไว้ (ต่างจาก clampText) */
export function truncateAtGrapheme(text, maxUnits) {
  const value = String(text ?? "");
  if (value.length <= maxUnits) return value;
  let used = 0;
  const parts = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter("th", { granularity: "grapheme" }).segment(value) : [...value].map((segment) => ({ segment }));
  for (const part of parts) {
    if (used + part.segment.length > maxUnits - 1) break;
    used += part.segment.length;
  }
  return `${value.slice(0, used)}…`;
}

export function thaiNumber(value) {
  return Number(value || 0).toLocaleString("th-TH");
}
