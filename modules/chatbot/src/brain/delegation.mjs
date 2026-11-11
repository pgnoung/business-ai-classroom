// brain/delegation.mjs — "สิทธิ์สีเขียว" ที่เจ้าของมอบให้ทีมงานได้ชั่วคราว (แบบแปลน §6, §13 ข้อ 2)
//
// แบบแปลนตัดตาราง `approval_policy` ทิ้งโดยเจตนา เหลือเป็น settings key เดียว:
//   brain_delegation = { roles: [...], kinds: [...], expires_at, set_by, set_at }
//
// สามข้อที่โค้ดบังคับ ไม่ใช่ UI:
//   1. ชนิดสีแดง (ราคา/รอบ/สินค้า/policy ที่บังคับใช้จริง) มอบสิทธิ์ไม่ได้เด็ดขาด
//      — "ราคาสองค่าพร้อมกันคือความเสียหายทางธุรกิจที่ auto-halt มองไม่เห็น" (§6 Step 5)
//   2. ของที่มอบสิทธิ์แล้ว เผยแพร่ได้แค่ถึง canary เสมอ ไม่มีทางถึง live
//   3. หมดอายุได้ไม่เกิน 90 วัน และหมดแล้วต้องกลับไปเป็นคิวขออนุมัติเอง (fail-closed)
export const BRAIN_DELEGATION_KEY = "brain_delegation";
export const DELEGATION_MAX_DAYS = 90;
export const DELEGATION_DEFAULT_DAYS = 90;

// ชนิดที่ "เขียว" พอจะมอบสิทธิ์ได้ในเฟสนี้ — fact อย่างเดียว
// (media ของแบบแปลนยังไม่มีในเฟส 1b เพราะการ์ดชนิดนั้นเปิดที่ P4)
export const DELEGATABLE_KINDS = Object.freeze(["fact"]);
export const DELEGATABLE_ROLES = Object.freeze(["admin", "operator"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function safeJson(text) {
  try { return JSON.parse(String(text || "")); } catch { return null; }
}

/** อ่านค่าที่บันทึกไว้ดิบ ๆ — คืน null เมื่อยังไม่เคยตั้งหรืออ่านไม่ออก */
export function readBrainDelegation(db) {
  let raw = null;
  try { raw = db.getSetting(BRAIN_DELEGATION_KEY); } catch { return null; }
  const parsed = safeJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  return {
    roles: (Array.isArray(parsed.roles) ? parsed.roles : []).filter((r) => DELEGATABLE_ROLES.includes(r)),
    // กรองอีกชั้นตอนอ่านด้วย: แถว settings ที่ถูกแก้ตรงในฐานข้อมูลต้องไม่ปลดชนิดสีแดงให้
    kinds: (Array.isArray(parsed.kinds) ? parsed.kinds : []).filter((k) => DELEGATABLE_KINDS.includes(k)),
    expiresAt: Number(parsed.expires_at ?? parsed.expiresAt ?? 0) || 0,
    setBy: String(parsed.set_by ?? parsed.setBy ?? ""),
    setAt: Number(parsed.set_at ?? parsed.setAt ?? 0) || 0,
  };
}

/** สถานะที่หน้าคอนโซลแสดง — active / expired / ยังไม่เคยมอบ */
export function brainDelegationState(db, now = Date.now()) {
  const row = readBrainDelegation(db);
  if (!row || !row.roles.length || !row.kinds.length || !row.expiresAt) {
    return { configured: false, active: false, expired: false, roles: [], kinds: [], expiresAt: 0, setBy: "", setAt: 0 };
  }
  const expired = Number(now) >= row.expiresAt;
  return { configured: true, active: !expired, expired, ...row };
}

/**
 * ทีมงานคนนี้เผยแพร่ของชุดนี้ขึ้น canary ได้เองไหม
 *
 * @param {object} input
 * @param {string} input.role  บทบาทของคนกด
 * @param {string[]} input.cardKinds ชนิดการ์ดที่การแก้ครั้งนี้แตะ (จากทะเบียนของ writeHook)
 */
export function delegationAllows(db, { role, cardKinds = [], now = Date.now() } = {}) {
  const state = brainDelegationState(db, now);
  if (!state.active) return false;
  if (!state.roles.includes(String(role))) return false;
  if (!cardKinds.length) return false;
  // ทุกชนิดที่แตะต้องอยู่ในทั้งรายการที่มอบ และรายการที่โค้ดยอมให้มอบได้
  return cardKinds.every((kind) => state.kinds.includes(kind) && DELEGATABLE_KINDS.includes(kind));
}

/**
 * ตั้ง/ยกเลิกสิทธิ์สีเขียว — คืน {ok, error, state}
 * days = 0 หรือ roles/kinds ว่าง = ยกเลิก (กลับไปเป็นคิวขออนุมัติเหมือนเดิม)
 */
export function writeBrainDelegation(db, { roles = [], kinds = [], days = DELEGATION_DEFAULT_DAYS, by = "", now = Date.now() } = {}) {
  const cleanRoles = [...new Set((Array.isArray(roles) ? roles : []).map(String))].sort();
  const cleanKinds = [...new Set((Array.isArray(kinds) ? kinds : []).map(String))].sort();
  const span = Number(days);
  if (cleanRoles.some((role) => !DELEGATABLE_ROLES.includes(role))) {
    return { ok: false, error: `บทบาทที่มอบสิทธิ์ได้มีแค่ ${DELEGATABLE_ROLES.join(" / ")}` };
  }
  const red = cleanKinds.filter((kind) => !DELEGATABLE_KINDS.includes(kind));
  if (red.length) {
    return {
      ok: false,
      error: `ชนิด "${red.join(", ")}" มอบสิทธิ์ไม่ได้ — ราคา รอบเรียน สินค้า และกติกาที่บังคับใช้จริง`
        + " ต้องให้พี่ง้วงกดเองเสมอ (ลูกค้าเทียบสกรีนช็อตกันได้)",
    };
  }
  if (!Number.isFinite(span) || span < 0 || span > DELEGATION_MAX_DAYS) {
    return { ok: false, error: `อายุสิทธิ์ต้องเป็น 0-${DELEGATION_MAX_DAYS} วัน` };
  }
  if (!cleanRoles.length || !cleanKinds.length || span === 0) {
    db.setSetting(BRAIN_DELEGATION_KEY, "");
    return { ok: true, state: brainDelegationState(db, now), revoked: true };
  }
  db.setSetting(BRAIN_DELEGATION_KEY, JSON.stringify({
    roles: cleanRoles, kinds: cleanKinds,
    expires_at: Number(now) + span * DAY_MS,
    set_by: String(by), set_at: Number(now),
  }));
  return { ok: true, state: brainDelegationState(db, now), revoked: false };
}
