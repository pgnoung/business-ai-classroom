// Current-turn care intent, never a score-derived guess about readiness.
// Controls tone only; never changes AI ownership or follow-up consent.
import { classifyFollowupSuppression } from "./followupSuppression.mjs";
const THANKS_ONLY = /^(?:(?:โอเค|ok|ได้)(?:ครับ|ค่ะ|คะ)?[\s,]*)?(?:ขอบคุณ(?:มาก)?(?:เลย)?(?:นะ)?(?:ครับ|ค่ะ|คะ|ค่า)?|thank\s*you|thanks)[\s.!…🙏😊✨]*$/iu;
const UNAVAILABLE = /^(?:(?:ผม|ดิฉัน|ฉัน)?\s*|(?:วันนั้น|รอบนี้|รอบนั้น)\s*)?(?:ยัง)?(?:ไม่สะดวก|ไม่ว่าง|ติดงาน)(?:ครับ|ค่ะ|คะ|นะ|วัน|รอบ|ช่วง|เลย|จริง|\s|$)/u;
export function customerCareMode(text) {
  const value = String(text ?? "").trim();
  if (THANKS_ONLY.test(value)) return "close";
  if (classifyFollowupSuppression(value)) return "pause";
  if (!/[“”"‘’]|ตัวอย่าง|เขาบอก|ลูกค้าบอก/u.test(value) && UNAVAILABLE.test(value)) return "pause";
  return null;
}
