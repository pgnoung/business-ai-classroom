// adWelcomeQuestion.mjs — "คำถามต้อนรับในโฆษณา Facebook" (audit ก.ย. 2026 §4.1, ตั้งค่าได้ในคอนโซล)
//
// โฆษณา Click-to-Messenger ถามลูกค้าก่อนเปิดแชท (เช่น "เคยสร้าง AI เป็นผู้ช่วยส่วนตัวมาก่อนมั้ยคะ?")
// แต่ข้อความนั้นไม่มากับ webhook — ลูกค้าจึงพิมพ์แค่ "ยังครับ" มาเป็นข้อความแรก แล้วลูกแพรไม่รู้ว่า
// เขาตอบอะไร ค่านี้ให้เจ้าของบอกระบบได้ว่าโฆษณาถามอะไร ระบบจะส่งให้โมเดลเป็น "บริบท" ของเทิร์น
// เปิดห้องที่เป็นคำตอบสั้นเท่านั้น ไม่เคยถูกเขียนเป็นข้อความในประวัติ (ลูกแพรไม่ได้พิมพ์มันในแชทนี้)
//
// เก็บใน settings แถวเดียว — ว่าง/ไม่มีแถว = ไม่รู้คำถาม (พฤติกรรมเริ่มต้น พรอมต์ไม่มีบรรทัดนี้)
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";

export const AD_WELCOME_QUESTION_KEY = "fb_ad_welcome_question";
export const AD_WELCOME_QUESTION_MAX = 400;

// ข้อความจากคอนโซลเข้าพรอมต์ได้บรรทัดเดียว: ตัดอักขระควบคุม ยุบช่องว่าง/บรรทัดใหม่ และคุมความยาว
// (บันไดตัวเลือกหลายบรรทัดในโฆษณาจะกลายเป็นบรรทัดเดียวที่ยังอ่านออก)
export function normalizeAdWelcomeQuestion(value) {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/"/gu, "”")
    .replace(/\s+/gu, " ")
    .trim();
  return [...clean].slice(0, AD_WELCOME_QUESTION_MAX).join("");
}

export function readAdWelcomeQuestion(db) {
  try {
    return normalizeAdWelcomeQuestion(db?.getSetting?.(AD_WELCOME_QUESTION_KEY) ?? "");
  } catch {
    return "";
  }
}

// ห้อง LINE ไม่ได้มาจากโฆษณา Facebook — ห้ามอ้างคำถามโฆษณากับห้องที่ไม่เคยเห็นมัน
export function adWelcomeQuestionFor({ db, customer } = {}) {
  if (String(customer?.channel_id || "") !== FACEBOOK_CHANNEL_ID) return "";
  return readAdWelcomeQuestion(db);
}
