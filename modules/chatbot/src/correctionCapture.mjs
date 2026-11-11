// correctionCapture.mjs — ตัดสินว่า "คนแก้ร่างของบอทจริงไหม" ก่อนบันทึกเข้ากล่องตรวจ
//
// เหตุจริง 2026-09-03: กล่องตรวจมีของค้าง 170 ใบ เจ้าของเปิดดูแล้วถามว่าระบบมั่วหรือเปล่า
// เพราะคำตอบของลูกแพรกับของทีมดูเหมือนกันเป๊ะ วัดแล้ว 149 ใบต่างกันแค่ marker
// [IMAGE:ai-stage-ladder] ใบเดียว เหลือคำแก้จริง 3 ใบ
//
// ที่มา: chassis ถอด marker ออกไปทำเป็นรูปจริงก่อนส่งเสมอ ข้อความที่ operator กดส่งจึงไม่มี
// marker ติดไปด้วย — เป็นพฤติกรรมที่ถูกต้อง แต่จุดบันทึกเทียบสตริงดิบ ๆ ทีละไบต์ มันจึงอ่านว่า
// "คนแก้" ทุกครั้งที่คนกดส่งร่างเดิมทั้งดุ้น ซึ่งความจริงคือ "คนเห็นด้วยกับบอท" — อ่านกลับข้าง
//
// กล่องตรวจที่เต็มไปด้วยของปลอมแย่กว่ากล่องว่าง เพราะคนเลิกอ่านมันทั้งกล่อง
import { IMAGE_MARKER_PATTERN } from "./imageCatalog.mjs";

// Provenance is deliberately a small, closed vocabulary.  `reason` remains
// the operator-facing decision explanation; this field says why the system
// captured a draft without copying the rejected text or amounts into metadata.
export const SYSTEM_CORRECTION_SOURCE_PREFIXES = Object.freeze([
  "system:compliance_block",
  "system:followup_compliance_block",
  "system:staged_followup_compliance_block",
]);
export const SYSTEM_CORRECTION_VIOLATION_TYPES = Object.freeze([
  "price", "price_binding", "banned_word", "diagnosis",
]);

/**
 * Return a safe closed code for a system-captured correction.
 *
 * `violations` may be guard rows or string types.  Unknown types are omitted
 * rather than becoming a new unreviewed metadata channel.
 */
export function formatSystemCorrectionSource(reason, violations = []) {
  const base = String(reason || "").trim();
  if (base === "system:price_revision_upward" || base === "system:ai_paused_draft") return base;
  if (!SYSTEM_CORRECTION_SOURCE_PREFIXES.includes(base)) return "";
  const allowed = new Set(SYSTEM_CORRECTION_VIOLATION_TYPES);
  const types = [...new Set((Array.isArray(violations) ? violations : [])
    .map((violation) => typeof violation === "string" ? violation : violation?.type)
    .map((type) => String(type || "").trim().toLowerCase())
    .filter((type) => allowed.has(type)))].sort();
  return types.length ? `${base}:${types.join(",")}` : base;
}

// Consumers that only display provenance need a boolean, never a parser that
// might accidentally surface an unregistered value.  Recompose the value to
// ensure its suffix is sorted, deduplicated, and from the same closed list.
export function isRecognizedSystemCorrectionSource(value = "") {
  const text = String(value || "").trim();
  if (text === "system:price_revision_upward" || text === "system:ai_paused_draft") return true;
  const match = /^(system:(?:compliance_block|followup_compliance_block|staged_followup_compliance_block))(?::([a-z_,]+))?$/u.exec(text);
  if (!match) return false;
  const parts = match[2] ? match[2].split(",") : [];
  return formatSystemCorrectionSource(match[1], parts) === text;
}

// เทียบกันที่ "เนื้อความที่ลูกค้าได้อ่านจริง": ถอด marker ที่ chassis กินไปแล้ว และยุบช่องว่าง
// (ขึ้นบรรทัดใหม่เกินมาหนึ่งตัวไม่ใช่บทเรียนที่ต้องสอนบอท)
export function normalizeOutboundText(text) {
  // IMAGE_MARKER_PATTERN มี flag g — ใช้กับ replace ได้ปลอดภัย (lastIndex ถูกรีเซ็ตให้เอง)
  // แต่ห้ามเอาไปใช้กับ .test() เพราะอันนั้นค้าง state ข้ามการเรียก
  return String(text || "").replace(IMAGE_MARKER_PATTERN, " ").replace(/\s+/gu, " ").trim();
}

/**
 * คนแก้เนื้อความจริงหรือไม่ — ใช้ตัดสินว่าจะเก็บเข้ากล่องตรวจไหม
 *
 * ไม่มีร่าง = ไม่มีอะไรให้เทียบ · คนไม่ได้พิมพ์ข้อความ (ส่งแต่รูป/สติกเกอร์) = ไม่ใช่คำแก้ข้อความ
 */
export function isHumanEdit(aiDraft, humanFinal) {
  const draft = normalizeOutboundText(aiDraft);
  const final = normalizeOutboundText(humanFinal);
  if (!draft || !final) return false;
  return draft !== final;
}

// คิวคำแก้เก่าอาจถูกสร้างจากเส้นทางที่ยังไม่ได้เรียก isHumanEdit มาก่อน
// จึงต้องมีด่านอ่าน/เขียนร่วมกันด้วย: เก็บหลักฐานเดิมไว้ตามเดิม แต่ห้ามเอา
// ข้อความที่ลูกค้าเห็นเหมือนกันไปเสนอเป็นบทเรียน หรือผูกเข้ารุ่นสมองภายหลัง
export function isTeachableCorrection(aiDraft, humanFinal) {
  return isHumanEdit(aiDraft, humanFinal);
}
