// mode.mjs — สวิตช์ reply_engine (spec v3.1 §A1/A2)
// ไม่มีแถว / ค่าอื่นทุกค่า / อ่านพัง = legacy = เครื่องตอบเดิมทุกไบต์ · ค่าต้องเป็น "v3" ตรงตัวเท่านั้น
// ถอยกลับ = ตั้งกลับเป็น legacy ในคอนโซล มีผลข้อความถัดไป ไม่ต้อง deploy
import { activeBrand, isGenericProfile } from "../brand.mjs";
export const REPLY_ENGINE_KEY = "reply_engine";
export const REPLY_ENGINE_MODES = Object.freeze(["legacy", "v3"]);

// 7 พ.ย. 2026 (งานแคช): สวิตช์ reply_cache_layer — ไม่มีแถว = off = พรอมต์เดิมทุกไบต์
// on = ข้อมูลธุรกิจที่อนุมัติขึ้นมาอยู่บล็อกของตัวเองพร้อมหมุดแคช ถ้อยคำเท่าเดิม เปลี่ยนแค่ลำดับ
export const REPLY_CACHE_LAYER_KEY = "reply_cache_layer";
export const REPLY_CACHE_LAYER_MODES = Object.freeze(["on", "off"]);

export function replyCacheLayerMode(db) {
  try {
    return String(db?.getSetting?.(REPLY_CACHE_LAYER_KEY) ?? "").trim().toLowerCase() === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

export function replyEngineMode(db) {
  // White-label: โปรไฟล์ generic ปิดฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วงเสมอ (ค่าใน DB ไม่มีผล)
  if (isGenericProfile(activeBrand())) return "legacy";
  try {
    return db?.getSetting?.(REPLY_ENGINE_KEY) === "v3" ? "v3" : "legacy";
  } catch {
    return "legacy";
  }
}
