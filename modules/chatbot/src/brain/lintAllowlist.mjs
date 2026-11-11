// brain/lintAllowlist.mjs — "ช่องทางติดต่อของร้านเราเอง" ที่ L15 ต้องไม่ฟ้อง
//
// เดิมรายการนี้ถูกแช่ไว้ใน manifest ตอนนำเข้า ซึ่งพังในเคสที่เกิดจริงแน่ ๆ: ความรู้ใบหนึ่ง
// มีเบอร์ร้านหรือ LINE id ของ OA ตัวเอง แล้ววันหนึ่งเบอร์เปลี่ยน/มี OA ตัวที่สอง คนแก้ใบนั้น
// จะโดน L15 บล็อกทุกครั้ง โดยไม่มีทางแก้เลยนอกจากลบเบอร์ร้านตัวเองออกจากความรู้
//
// ตอนนี้จึงประกอบสด ณ เวลาที่ด่านทำงาน จากสามที่:
//   1. ค่าที่แช่ไว้ตอนนำเข้า (persona + config/brain-lint-allowlist.json ของ instance)
//   2. settings key `brain_lint_allowlist` ที่เจ้าของเติมเองได้จากคอนโซล
// (รายชื่อ OA มาจาก env/ไฟล์ ไม่ใช่ตารางในฐาน จึงไม่มีที่สามให้กวาด — ค่าของ OA ที่ต้องยกเว้น
//  เจ้าของเติมผ่านข้อ 2 ได้ทีเดียวจบ และมีร่องรอยว่าใครเติมเมื่อไร)
import { allowlistValues } from "./sources.mjs";

export const BRAIN_LINT_ALLOWLIST_KEY = "brain_lint_allowlist";
export const BRAIN_LINT_ALLOWLIST_MAX = 50;

/** ค่าที่เจ้าของเติมเอง — array ของสตริง (เบอร์ / @handle / อีเมลของร้าน) */
export function readOwnerAllowlist(db) {
  let raw = null;
  try { raw = db.getSetting(BRAIN_LINT_ALLOWLIST_KEY); } catch { return []; }
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch { return []; }
}

export function writeOwnerAllowlist(db, values = []) {
  const cleaned = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    if (!text || text.length > 120) continue;
    if (!cleaned.includes(text)) cleaned.push(text);
  }
  if (cleaned.length > BRAIN_LINT_ALLOWLIST_MAX) {
    return { ok: false, error: `รายการช่องทางของร้านต้องไม่เกิน ${BRAIN_LINT_ALLOWLIST_MAX} รายการ` };
  }
  db.setSetting(BRAIN_LINT_ALLOWLIST_KEY, JSON.stringify(cleaned));
  return { ok: true, values: cleaned };
}

/** รายการรวมที่ด่านใช้จริง (ค่าเปล่า ๆ ตัวพิมพ์เล็ก — runBrainLints เทียบแบบ case-insensitive) */
export function liveLintAllowlist(db, pinned = []) {
  const seen = new Set();
  const out = [];
  for (const value of [...allowlistValues(pinned), ...readOwnerAllowlist(db)]) {
    const text = String(value || "").trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}
