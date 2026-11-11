// yoloText.mjs — ตัวช่วยข้อความภาษาไทยที่ YOLO / คำสั่งเจ้าของ / Telegram ใช้ร่วมกัน
//
// ทำไมแยกไฟล์ (2026-09-28, งาน YOLO ตามคำสั่งพี่ง้วง): ตัวแยกคำสั่ง ตัวหาลูกค้า และข้อความ
// ตอบกลับทาง Telegram ต้อง "มองชื่อลูกค้าแบบเดียวกัน" — ถ้าแต่ละที่ normalize เอง ชื่อที่ตัวแยก
// คำสั่งตัดออกมาจะหาไม่เจอในตัวหาลูกค้า แล้วพี่ง้วงเจอ "ไม่พบลูกค้า" ทั้งที่พิมพ์ชื่อถูก
//
// ทุกฟังก์ชันในไฟล์นี้บริสุทธิ์ (ไม่แตะ DB/เครือข่าย) เทสต์ไล่ได้ครบทุกกรณีภาษาไทยแปลก ๆ

const ZERO_WIDTH = /[​-‍⁠﻿]/gu;
// สระ/วรรณยุกต์ที่ขึ้นต้นคำไม่ได้ — ใช้กัน "คุณากร" ถูกตัดเป็น "ากร" ตอนลอกคำว่าคุณ
const THAI_NON_INITIAL = "ะ-ฺๅ็-๎";
const HONORIFIC_PREFIX = new RegExp(`^(?:(?:คุณ|คุน)(?![${THAI_NON_INITIAL}])|khun\\s+|k\\s+)\\s*`, "u");
const SEGMENTER = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter("th", { granularity: "grapheme" }) : null;

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const THAI_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

// normalize สำหรับ "เทียบชื่อ" เท่านั้น (ไม่ใช่ข้อความที่จะแสดง):
// - NFC + ตัดตัวอักษรล่องหนที่ติดมากับการ copy จาก LINE
// - แก้นิสัยพิมพ์ไทยที่พบบ่อย: เ+เ → แ, ํ+า → ำ (หน้าตาเหมือนกันแต่คนละรหัส)
// - ตัวพิมพ์เล็ก + ทิ้ง emoji/เครื่องหมาย (ชื่อโปรไฟล์ LINE ชอบมี 🌸 หรือจุด)
// - ยุบช่องว่าง — แต่ "ไม่ลบ" ช่องว่าง เพราะตัวแยกคำสั่งต้องใช้ขอบคำ
export function normalizeForMatch(value) {
  return String(value ?? "")
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(/เเ/gu, "แ")
    .replace(/ํา/gu, "ำ")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

// ลอกคำนำหน้า "คุณ/คุน/khun/k." ออก (ครั้งเดียว) — พี่ง้วงพิมพ์ "คุณเอ" แต่ชื่อในระบบคือ "เอ"
// หรือกลับกัน ชื่อโปรไฟล์ตั้งว่า "คุณเอ" แต่พิมพ์ "เอ" ต้องเจอทั้งสองทาง
export function stripHonorific(normalized) {
  const value = String(normalized ?? "");
  const stripped = value.replace(HONORIFIC_PREFIX, "").trim();
  return stripped || value;
}

export function nameKey(value) {
  return stripHonorific(normalizeForMatch(value));
}

export function graphemes(value) {
  const text = String(value ?? "");
  if (!SEGMENTER) return [...text];
  return [...SEGMENTER.segment(text)].map((part) => part.segment);
}

// ชื่อลูกค้าที่ออกนอกคอนโซล (Telegram) ต้องปิดบางส่วนเสมอ — เหมือนตัวอย่างของพี่ง้วง "คุณ ส***"
// keep = จำนวนตัวอักษร (grapheme) ที่เปิดให้เห็น — รายการให้เลือกใช้ 3 เพื่อให้แยกคนออก
export function maskName(value, keep = 1) {
  const base = stripHonorific(String(value ?? "").normalize("NFC").replace(ZERO_WIDTH, "").replace(/\s+/gu, " ").trim());
  const parts = graphemes(base).filter((part) => part.trim());
  if (!parts.length) return "ลูกค้า";
  const shown = parts.slice(0, Math.max(1, Math.min(keep, parts.length - 1 || 1))).join("");
  return `${shown}***`;
}

// ตัวอย่างข้อความสั้น ๆ (ตัดตาม grapheme ไม่ตัดกลางสระ) — ใช้ทั้งรายการเลือกลูกค้าและสถานะ
export function previewText(value, max = 40) {
  const flat = String(value ?? "").normalize("NFC").replace(ZERO_WIDTH, "").replace(/\s+/gu, " ").trim();
  const parts = graphemes(flat);
  if (parts.length <= max) return flat;
  return `${parts.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

// ตัดคำสั่งของเจ้าของให้อยู่ในเพดาน — ตัดตาม grapheme และทิ้งอักขระควบคุม (กันแทรกบรรทัดปลอม)
export function cleanInstruction(value, max = 500) {
  const flat = String(value ?? "").normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const parts = graphemes(flat);
  return parts.length <= max ? flat : parts.slice(0, max).join("").trim();
}

function bangkokParts(ms) {
  const date = new Date(Number(ms) + BANGKOK_OFFSET_MS);
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth(),
    hh: String(date.getUTCHours()).padStart(2, "0"),
    mm: String(date.getUTCMinutes()).padStart(2, "0"),
    dayIndex: Math.floor((Number(ms) + BANGKOK_OFFSET_MS) / DAY_MS),
  };
}

// เวลาแบบคนอ่าน (เวลาไทยเสมอ ไม่ขึ้นกับเครื่องเซิร์ฟเวอร์): "12 นาทีก่อน" · "วันนี้ 14:05" ·
// "เมื่อวาน 20:11" · "27 ก.ย. 09:10" — อนาคต (นัด FU) ใช้รูปวัน/เวลาอย่างเดียว
export function formatBangkokTime(ms, nowMs = Date.now()) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return "-";
  const diff = Number(nowMs) - at;
  if (diff >= 0 && diff < 60_000) return "เมื่อสักครู่";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} นาทีก่อน`;
  const target = bangkokParts(at);
  const today = bangkokParts(nowMs);
  const clock = `${target.hh}:${target.mm}`;
  if (target.dayIndex === today.dayIndex) return `วันนี้ ${clock}`;
  if (target.dayIndex === today.dayIndex - 1) return `เมื่อวาน ${clock}`;
  if (target.dayIndex === today.dayIndex + 1) return `พรุ่งนี้ ${clock}`;
  return `${target.day} ${THAI_MONTHS[target.month]} ${clock}`;
}

// วันที่ปฏิทินไทย (Asia/Bangkok, ไม่มี DST) แบบ ISO — ใช้ตัดรอบเรียนที่ผ่านไปแล้ว
// รูปเดียวกับ todayInBangkok ของ pipeline ("en-CA" = YYYY-MM-DD)
export function bangkokIsoDate(ms = Date.now()) {
  return new Date(Number(ms) + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

// "จันทร์ 28 ก.ย. 2026 เวลา 12:00 น." — ปี ค.ศ. + ชื่อเดือนย่อ รูปเดียวกับตารางรอบในคลังความรู้
// ("เสาร์ 10 ต.ค. 2026") โมเดลจึงเทียบได้ตรง ๆ ว่ารอบไหนผ่านไปแล้ว
export function bangkokNowLabel(ms = Date.now()) {
  const date = new Date(Number(ms) + BANGKOK_OFFSET_MS);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${THAI_WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${THAI_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} เวลา ${hh}:${mm} น.`;
}

// เหตุที่ AI ของห้องปิด — แปลรหัสเป็นคำที่พี่ง้วงอ่านแล้วเข้าใจทันที
// (รหัสมาจาก aiPausePolicy/pipeline/facebookWebhook — ไม่รู้จัก = โชว์รหัสดิบ ดีกว่าเดาความหมาย)
const AI_OFF_REASON_TEXT = Object.freeze({
  manual: "ทีมกดปิดเอง",
  handoff_private_inhouse: "ส่งต่องาน In-house/Private ให้ทีมแล้ว",
  booking_handoff: "ลูกค้าขอจอง/สมัคร ส่งต่อชมพู่แล้ว",
  bank_sent: "ส่งเลขบัญชีแล้ว รอทีมดูแลเรื่องเงิน",
  money_line: "เส้นเงิน รอคนตรวจยอด",
  payment_review: "รอคนตรวจยอด/สลิป",
  human_requested: "ลูกค้าขอคุยกับคน",
  complaint: "ลูกค้าไม่พอใจ รอคนดูแล",
  optout: "ลูกค้าขอให้หยุดทัก",
  identity_question: "ลูกค้าถามว่าเป็นบอทไหม ส่งต่อคนแล้ว",
  urgent_mental: "พบสัญญาณวิกฤต ต้องมีคนดูแล",
  customer_handover: "ลูกค้าเก่า ทีมดูแลเอง",
  not_a_customer: "ไม่ใช่ลูกค้า",
  file_review: "ลูกค้าส่งไฟล์ รอทีมเปิดดู",
  fb_legacy_customer: "ลูกค้าเก่าฝั่ง Facebook ทีมดูแลเอง",
  fb_name_unverified: "Facebook ยังยืนยันชื่อไม่ได้",
  fb_human_replying: "ทีมตอบใน Business Suite อยู่",
  jev_followup_stop: "ผู้ตรวจแนะนำให้คนรับช่วง",
  // 5 ต.ค. 2026 (คำสั่งพี่ง้วง): ตัวกวาดรายชั่วโมงปิดเอง = ป้ายเหลือง "AI off (not qualify)" — ข้อความเดียวกับ
  // NOT_QUALIFIED_REASON_TEXT (notQualified.mjs · เทสต์คุมว่าตรงกัน) ให้ Telegram กับคอนโซลพูดเหมือนกัน
  not_qualified: "AI คัดกรองแล้วว่ายังไม่เข้าเกณฑ์ลูกค้า (ตัวกวาดรายชั่วโมงปิดเอง เปิดคืนเองเมื่อเห็นศักยภาพ)",
});

export function aiOffReasonText(reason) {
  const code = String(reason ?? "").trim();
  if (!code) return "ปิดอยู่";
  return AI_OFF_REASON_TEXT[code] || code;
}

// ชื่อช่องทางแบบที่พี่ง้วงเรียก — Facebook = "FB", ที่เหลือทั้งหมดคือ LINE OA
export function channelLabel(channelId) {
  return String(channelId || "") === "facebook" ? "FB" : "LINE";
}
