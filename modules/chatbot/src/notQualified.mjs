// notQualified.mjs — ห้อง "AI off (not qualify)" สีเหลือง (คำสั่งพี่ง้วง 5 ต.ค. 2026)
//
// "ทุกชั่วโมง (เวลาทำการ) ให้มี AI อีกตัวคอยกวาดแชทของวันนั้น ว่าคนไหนไม่มีศักยภาพ หรือเป็นฟีลอยากสร้างรายได้
//  ไม่มีรายได้ ตกงาน หรือดูแล้วไม่เหมาะเป็นลูกค้าของพี่ง้วงจริง ๆ ให้ปิด AI mode ของแชทนั้นได้เลย เป็นไอคอนสีเหลือง
//  ... ถ้าเมื่อไหร่ sense ได้ว่าแชทนั้นมีศักยภาพขึ้นมา ให้กลับมาเปิดสีเขียวเหมือนเดิม
//  ระบบนี้ reverse ไปมาระหว่างการปิดจากสีเหลืองและไปสีเขียวเท่านั้น ไม่นับการปิดกรณีอื่น ๆ"
//
// ไฟล์นี้คือสัญญากลางที่ทุกส่วนใช้ร่วมกัน (ตัวกวาด ไปป์ไลน์ คอนโซล สวิตช์) — ห้าม import โมดูลอื่นของ chassis
// กฎความเป็นเจ้าของ: ตัวกวาดแตะได้เฉพาะห้องที่ ai_off_reason === NOT_QUALIFIED_REASON ที่ตัวเองเขียน
//   · เหตุนี้ต้องไม่อยู่ใน STICKY_AI_OFF_REASONS (aiPausePolicy.mjs) ไม่งั้น canAutoEnableAi จะกันการเปิดคืนของตัวเอง
//   · ห้ามเขียนผ่าน applyStickyAiOff (stickyOffPlanFor ตกเป็น money_line เมื่อไม่รู้จักเหตุ)
//   · ปิด/เปิดด้วย UPDATE แบบมีเงื่อนไข (compare-and-set) เท่านั้น — เส้นอื่นที่เขียนเหตุอื่นทับแล้ว = ไม่ใช่ของเราอีกต่อไป
//   · ไม่ใช่รหัสเส้นเงิน: ห้ามมีคำ payment/slip/installment/refund/image_review (isMoneyLineReason ใน pipeline.mjs)

import { activeBrand, isGenericProfile } from "./brand.mjs";
export const NOT_QUALIFIED_REASON = "not_qualified";
/** ค่า `by` ของ aiOffInfo สำหรับห้องสีเหลือง (คอนโซลใช้เป็นคลาส by-qualify) */
export const NOT_QUALIFIED_BY = "qualify";
export const NOT_QUALIFIED_LABEL = "AI off (not qualify)";
export const NOT_QUALIFIED_REASON_TEXT = "AI คัดกรองแล้วว่ายังไม่เข้าเกณฑ์ลูกค้า (ตัวกวาดรายชั่วโมงปิดเอง เปิดคืนเองเมื่อเห็นศักยภาพ)";

/** สวิตช์ในแผงตั้งค่า: ไม่มีแถว/ค่าอื่น/อ่านพัง = off */
export const QUALIFY_SWEEP_MODE_KEY = "qualify_sweep_mode";
export const QUALIFY_SWEEP_MODES = Object.freeze(["off", "shadow", "on"]);

// สถานะต่อห้องเก็บใน settings รูป `<ชื่อ>:<id>` เพื่อให้ PDPA reset (db.resetCustomer) ลบให้เองตามรูปแบบ
/** คำตัดสินล่าสุดของห้อง: JSON {verdict, confidence, category, reason, lastInboundId, at, offAt?, mode} */
export const qualifyStateKey = (customerId) => `qualify:${customerId}`;
/** คนกดเปิด AI ทับห้องสีเหลือง = ตัวกวาดห้ามปิดห้องนี้อีก (คนตัดสินแล้วชนะ AI) */
export const qualifyReleaseKey = (customerId) => `qualify_release:${customerId}`;
/** ห้องสีเหลืองที่มีข้อความใหม่ — ตัวกวาดตรวจซ้ำรอบนาทีถัดไป ไม่ต้องรอชั่วโมง */
export const qualifyRecheckKey = (customerId) => `qualify_recheck:${customerId}`;
/**
 * ตัวกวาดยืนยันแล้ว (มีหลักฐาน) ว่าข้อความลูกค้าถึงเวลานี้ยังไม่เข้าเกณฑ์: ค่า = created_at (ms) ของข้อความลูกค้าล่าสุดที่ยืนยัน
 * คิวรอตอบ/KPI ซ่อนห้องสีเหลืองเฉพาะเมื่อ hold ≥ เวลาข้อความลูกค้าล่าสุด — ห้องสีเหลืองที่ลูกค้าทักใหม่แล้วยังไม่ถูกยืนยัน
 * (ตรวจซ้ำล้ม/unclear/ชนเพดานงบ/สวิตช์ไม่ใช่ on) กลับมาโผล่ในคิวให้คนเห็นเสมอ (รีวิวปรปักษ์ 5 ต.ค.)
 */
export const qualifyHoldKey = (customerId) => `qualify_hold:${customerId}`;
/** คนกดเปิด AI ห้องนี้ล่าสุดเมื่อไหร่ (ทุกเหตุ ไม่ใช่แค่ห้องเหลือง) — ค่า = ms · ตัวกวาดไม่ปิดห้องที่คนเพิ่งคืนให้ AI */
export const qualifyHumanOnKey = (customerId) => `qualify_human_on:${customerId}`;
/** คนแตะห้องนี้ (ส่งข้อความ/เขียนโน้ต/กดเปิด AI) ภายในช่วงนี้ = ตัวกวาดไม่ปิดเป็นสีเหลือง */
export const QUALIFY_HUMAN_RECENT_MS = 7 * 24 * 3_600_000;

export const AUDIT_AI_OFF_NOT_QUALIFIED = "ai_off_not_qualified";
export const AUDIT_AI_ON_QUALIFIED = "ai_on_qualified";
export const QUALIFY_AUDIT_OPERATOR = "system:qualify";

/** ห้องนี้ AI ปิดเพราะตัวกวาดเองหรือไม่ (ทั้งสองคอลัมน์ต้องตรง) */
export function isNotQualifiedRow(row) {
  return Boolean(row) && Number(row.ai_enabled) === 0 && String(row.ai_off_reason ?? "").trim() === NOT_QUALIFIED_REASON;
}

/** อ่านสวิตช์แบบปิดไว้ก่อนเสมอ (fail closed) */
export function qualifySweepMode(db) {
  // White-label: โปรไฟล์ generic ปิดฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วงเสมอ (ค่าใน DB ไม่มีผล)
  if (isGenericProfile(activeBrand())) return "off";
  try {
    const value = db?.getSetting?.(QUALIFY_SWEEP_MODE_KEY);
    return QUALIFY_SWEEP_MODES.includes(value) ? value : "off";
  } catch {
    return "off";
  }
}

export function readJsonSetting(db, key) {
  try {
    const raw = db?.getSetting?.(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}
