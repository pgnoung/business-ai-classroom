// identityLinkShared.mjs — ของกลางของการเชื่อมลูกค้าข้าม Facebook ↔ LINE (แยกจาก identityLink.mjs 28 ก.ย. ค่ำ)
// ไม่มีสถานะ ไม่ import โมดูลเชื่อมช่องทางตัวอื่น (กันวงจร import) — identityLink/identityLinkConsole ใช้ร่วมกัน
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { FB_LEGACY_TAG } from "./facebookWebhook.mjs";

export const IDENTITY_LINK_CAPABILITY = "identity.link";
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const PAID_DEAL_STATUSES = new Set(["paid_confirmed", "prep_sent"]);
export const VIA_TEXT = Object.freeze({ code: "ลูกค้าส่งรหัสยืนยันเอง", team: "ทีมงานเชื่อมเอง", suggestion: "ทีมงานยืนยันจากรายการแนะนำ" });

export const isFacebookRoom = (row) => String(row?.channel_id || "") === FACEBOOK_CHANNEL_ID;
export const nameOf = (row) => String(row?.known_name || row?.display_name || "").trim();

export function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** ห้องนี้ "ซื้อ/ลงทะเบียนแล้ว" ไหม — ป้าย customer (หรือป้ายลูกค้าเก่าของเกต Facebook) · ทีมยืนยันยอด · ออเดอร์จ่ายแล้ว */
export function identityIsBuyer(db, customerId, tags = null) {
  const list = Array.isArray(tags) ? tags : safe(() => db.listTags(customerId), []);
  if (list.some((row) => String(row.tag).trim().toLowerCase() === "customer" || String(row.tag).trim() === FB_LEGACY_TAG)) return true;
  const customer = safe(() => db.getCustomer(customerId), null);
  if (PAID_DEAL_STATUSES.has(String(customer?.deal_status || ""))) return true;
  return safe(() => db.identityPaidOrderCount(customerId), 0) > 0;
}
