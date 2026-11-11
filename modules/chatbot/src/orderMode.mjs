// orderMode.mjs — โหมดออเดอร์ของร้าน: "shipping" (ส่งของ — ค่าเริ่มต้นของ chassis) หรือ "class" (ขายคลาสเรียน)
// (พี่ง้วง 7 ต.ค. 2026: "อยากปรับให้ออเดอร์เป็นระบบของคลาสพี่ง้วง ไม่ได้มีส่งของ ... แค่ยืนยันออเดอร์ก็พอ"
//  + "ถ้าเป็นใบกำกับภาษี ใบเสนอราคา อาจจะยังมีที่อยู่")
//
// โหมดคลาส:
// - ขั้นสถานะ: ร่าง → ยืนยันออเดอร์ (รอชำระ) → ชำระแล้ว → ลงทะเบียนเรียนแล้ว · ข้ามขั้น "จัดส่ง"
//   ค่าสถานะในฐานข้อมูลคงเดิม (draft/confirmed/paid/done) — รายงานยอดขาย/ROAS/รายแอดนับเหมือนเดิมทุกตัว
// - ข้อมูลจัดส่ง → ข้อมูลผู้เรียน (ชื่อ เบอร์ อีเมล) · ที่อยู่เป็นช่องไม่บังคับ (ใบกำกับภาษี/ใบเสนอราคา) ไม่เตือนรหัสไปรษณีย์/จังหวัด
// - เลือกรอบเรียนในออเดอร์ได้ — กด "ชำระแล้ว" แล้วลงชื่อผู้เรียนเข้ารอบนั้นในตาราง enrollments
// สวิตช์ order_mode: ไม่มีแถว/ค่าแปลก/อ่านพัง = shipping (ร้านเดิมทุกร้านทำงานเหมือนเดิม)
import { checkEmail, checkThaiPhone, normalizeShipping, shippingWarnings } from "./shipping.mjs";

export const ORDER_MODE_KEY = "order_mode";
export const ORDER_MODES = Object.freeze(["shipping", "class"]);

export function orderMode(db) {
  try {
    const value = db?.getSetting?.(ORDER_MODE_KEY);
    return ORDER_MODES.includes(value) ? value : "shipping";
  } catch {
    return "shipping";
  }
}

export const isClassMode = (db) => orderMode(db) === "class";

// โหมดคลาส: ชำระแล้ว → ลงทะเบียนเรียนแล้ว (done) ตรง ๆ · ยกเลิกได้ทุกขั้นที่ยังไม่จบเหมือนเดิม
const CLASS_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["confirmed", "cancelled"]),
  confirmed: Object.freeze(["paid", "cancelled"]),
  paid: Object.freeze(["done", "cancelled"]),
  // ออเดอร์เก่าที่ค้าง "จัดส่งแล้ว" ก่อนเปลี่ยนโหมด ยังปิดได้
  shipped: Object.freeze(["done", "cancelled"]),
  done: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export function classModeCanTransition(from, to) {
  return (CLASS_TRANSITIONS[from] || []).includes(to);
}

/** คำเตือนข้อมูลผู้เรียนของโหมดคลาส — ตรวจเบอร์/อีเมล ไม่ตรวจที่อยู่ (ไม่บังคับ ไว้ทำใบกำกับ/ใบเสนอราคา) */
export function studentWarnings(info) {
  const s = normalizeShipping(info);
  if (!s) return [];
  const warnings = [];
  const phone = checkThaiPhone(s.phone);
  if (phone.warning) warnings.push(phone.warning);
  const email = checkEmail(s.email);
  if (email.warning) warnings.push(email.warning);
  return warnings;
}

/** คำเตือนตามโหมด — จุดเดียวที่ API/AI ใช้ */
export const orderInfoWarnings = (info, mode) => (mode === "class" ? studentWarnings(info) : shippingWarnings(info));

const ROUND_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ROUND_KEY = /^[A-Za-z0-9_-]{1,40}$/u;

/** รอบเรียนที่ผูกกับออเดอร์ { date, classKey, label } — ทรงผิด = null */
export function normalizeClassRound(raw) {
  if (!raw || typeof raw !== "object") return null;
  const date = String(raw.date || "");
  const classKey = String(raw.classKey || "");
  if (!ROUND_DATE.test(date) || !ROUND_KEY.test(classKey)) return null;
  const label = String(raw.label || "").replace(/[\u0000-\u001f]/gu, " ").trim().slice(0, 80);
  return { date, classKey, label };
}

export function parseClassRound(json) {
  try { return normalizeClassRound(JSON.parse(String(json || ""))); } catch { return null; }
}
