// identityLinkTemplates.mjs — ข้อความของคลาสที่ลูกค้าได้ใน LINE หลังเชื่อมแชทจาก Facebook (เก็บใน settings)
// แยกจาก identityLink.mjs (28 ก.ย. ค่ำ) — เจ้าของแก้ในหน้าตั้งค่า ไม่ต้อง deploy · คอนโซล: consoleIdentityLinkApi.mjs
import { IDENTITY_TEMPLATE_DEFAULTS, normalizeClassType, validateTemplateText } from "./identityLinkClasses.mjs";

/* ------------------- ข้อความของคลาส (เจ้าของแก้ในหน้าตั้งค่า ไม่ต้อง deploy) ------------------- */

// settings: identity_link_template:<คลาส> = {"text": "...", "by": "...", "at": ms}
//   ไม่มีแถว / text = null = ใช้ค่าเริ่มต้นจากคลัง (identityLinkClasses.mjs) · text = "" = เจ้าของตั้งใจเว้นว่าง
export const IDENTITY_TEMPLATE_KEY_PREFIX = "identity_link_template:";

/** ข้อความของคลาสที่ใช้จริงตอนนี้ — อ่านไม่ได้ = ว่าง (ไม่ส่งค่าเริ่มต้นแทนข้อความที่เจ้าของอาจแก้ไว้แล้ว) */
export function readIdentityTemplate(db, classType) {
  const type = normalizeClassType(classType);
  const empty = { classType: type, text: "", isDefault: false, updatedBy: "", updatedAt: 0, readError: false };
  if (!type) return empty;
  let raw;
  try {
    raw = db.getSetting(IDENTITY_TEMPLATE_KEY_PREFIX + type);
  } catch {
    return { ...empty, readError: true };
  }
  let saved = null;
  try { saved = raw == null || raw === "" ? null : JSON.parse(String(raw)); } catch { return { ...empty, readError: true }; }
  const meta = saved && typeof saved === "object" ? { updatedBy: String(saved.by || ""), updatedAt: Number(saved.at) || 0 } : {};
  if (saved && typeof saved === "object" && typeof saved.text === "string") {
    return { ...empty, ...meta, text: saved.text };
  }
  return { ...empty, ...meta, text: IDENTITY_TEMPLATE_DEFAULTS[type] || "", isDefault: true };
}

/** บันทึก (text = สตริง) หรือกลับไปใช้ค่าเริ่มต้น (text = null) — ผ่านเพดานของ LINE ก่อนเสมอ */
export function saveIdentityTemplate(db, classType, { text = null, by = "", at = Date.now() } = {}) {
  const type = normalizeClassType(classType);
  if (!type) return { ok: false, error: "ไม่รู้จักคลาสนี้" };
  if (text === null) {
    db.setSetting(IDENTITY_TEMPLATE_KEY_PREFIX + type, JSON.stringify({ text: null, by: String(by).slice(0, 80), at }));
    return { ok: true, template: readIdentityTemplate(db, type) };
  }
  const checked = validateTemplateText(text);
  if (!checked.ok) return { ok: false, error: checked.error };
  db.setSetting(IDENTITY_TEMPLATE_KEY_PREFIX + type, JSON.stringify({ text: checked.text, by: String(by).slice(0, 80), at }));
  return { ok: true, template: readIdentityTemplate(db, type) };
}
