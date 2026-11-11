// identityLinkHints.mjs — เดาคู่ห้อง Facebook ↔ LINE จากจังหวะเวลา เมื่อลูกค้าแอดไลน์แล้วไม่ส่งรหัส (30 ก.ย. 2026)
//
// พี่ง้วง: "ถ้าลูกค้าไม่ทำอยู่ดี ... ทำระบบ check code เพื่อ match ในแชท facebook กับ LINE" → เสนอเทียบชื่อ →
// "ลูกค้าส่วนใหญ่ Facebook กับ LINE ชื่อไม่ตรงกันเลย LINE ใช้ชื่อเล่น เคสนี้น่าจะไม่ work"
// จึงใช้สิ่งที่ตรงกันแน่ ๆ แทนชื่อ = เวลา: ทีมส่งลิงก์เชิญให้ลูกค้า Facebook → ไม่นานมีคนใหม่แอดไลน์/ทักไลน์ครั้งแรกโดยไม่มีรหัส
//   · แจ้งทีมหนึ่งครั้งต่อห้อง LINE ใหม่ (รอ 3 นาทีก่อน เผื่อลูกค้ากำลังจะส่งรหัสตามมา) พร้อมรายชื่อห้อง Facebook ที่ลิงก์ยังไม่มีใครใช้
//     ใน 24 ชม. ก่อนหน้า + คลาส + ส่งไปกี่นาทีแล้ว → ทีมเปิดห้อง LINE กด "เชื่อมเป็นคนเดียวกัน" ในแผงช่องทางอื่น (รายการแนะนำขึ้นให้แล้ว)
//   · ไม่เชื่อมเองเด็ดขาด — เวลาใกล้กันไม่ใช่หลักฐาน (สองคนแอดไลน์ช่วงเดียวกันได้) คนต้องดูบริบทแล้วยืนยัน
//   · ไม่มีข้อความถึงลูกค้า · สวิตช์ identity_link_mode = off = ไม่แจ้ง · ห้องที่เชื่อมแล้ว/ห้อง Facebook ไม่เกี่ยว
// ตัวจับเวลาอยู่ในหน่วยความจำ (รีสตาร์ทระหว่างรอ = ข้ามรายนั้น) · กันแจ้งซ้ำด้วยแถว settings ต่อห้อง
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { identityLinkMode } from "./identityLinkCodes.mjs";
import { classLabel } from "./identityLinkClasses.mjs";
import { DAY_MS, nameOf, safe } from "./identityLinkShared.mjs";

export const IDENTITY_HINT_KEY_PREFIX = "identity_link_hint:";
export const IDENTITY_HINT_DELAY_MS = 3 * 60_000;
export const IDENTITY_HINT_WINDOW_MS = DAY_MS;
const MAX_LISTED = 3;

function agoText(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} นาทีก่อน`;
  const hours = Math.round(minutes / 60);
  return `${hours} ชม. ก่อน`;
}

/** ห้อง Facebook ที่ลิงก์เชิญยังไม่มีใครใช้ ในช่วง 24 ชม. ก่อนเวลา anchor (ห้องที่เชื่อม LINE อยู่แล้วไม่นับ) */
export function inviteCandidates(db, { anchorMs, nowMs = Date.now() } = {}) {
  const rows = safe(() => db.openIdentityInvites({ sinceMs: anchorMs - IDENTITY_HINT_WINDOW_MS, untilMs: anchorMs, nowMs }), []);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = String(row.customer_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const linkedLine = safe(() => db.listLinkedIdentities(id), [])
      .some((link) => link.customer_id !== id && link.channel_id !== FACEBOOK_CHANNEL_ID);
    if (linkedLine) continue;
    const customer = safe(() => db.getCustomer(id), null);
    out.push({ id, name: nameOf(customer) || "ลูกค้า Facebook", classType: row.class_type || "", sentAt: Number(row.created_at) || 0 });
  }
  return out;
}

export function hintText(candidates, { nowMs = Date.now() } = {}) {
  const listed = candidates.slice(0, MAX_LISTED).map((row) => {
    const cls = row.classType ? ` (${classLabel(row.classType)})` : "";
    return `คุณ${row.name}${cls} ส่งลิงก์ ${agoText(nowMs - row.sentAt)}`;
  });
  const more = candidates.length > MAX_LISTED ? ` และอีก ${candidates.length - MAX_LISTED} ห้อง` : "";
  return `เพิ่งแอดไลน์/ทักไลน์ครั้งแรกแต่ยังไม่ได้ส่งรหัสเชื่อมแชท — อาจเป็นลูกค้า Facebook ที่เราส่งลิงก์ไปแล้วยังไม่ได้ใช้: `
    + `${listed.join(" · ")}${more} — ถ้าใช่ เปิดห้อง LINE นี้แล้วกด "เชื่อมเป็นคนเดียวกัน" ในแผงช่องทางอื่นของลูกค้า`
    + ` (ระบบไม่เชื่อมเองจากเวลา ต้องให้คนดูก่อน)`;
}

export function createIdentityLinkHints({
  db, notifier = null, logger = console, now = Date.now, delayMs = IDENTITY_HINT_DELAY_MS,
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
} = {}) {
  function alreadyHinted(customerId) {
    return Boolean(safe(() => db.getSetting(IDENTITY_HINT_KEY_PREFIX + customerId), null));
  }

  function linkedAlready(customerId) {
    return safe(() => db.listLinkedIdentities(customerId), []).some((row) => row.customer_id !== customerId);
  }

  /** ตรวจจริง (หลังรอ) — คืนผลให้เทสต์/ร่องรอย */
  function check({ customerId, channelId, anchorMs }) {
    if (identityLinkMode(db) === "off") return { skipped: "mode_off" };
    if (alreadyHinted(customerId)) return { skipped: "already_hinted" };
    if (linkedAlready(customerId)) return { skipped: "linked" };
    const candidates = inviteCandidates(db, { anchorMs, nowMs: now() });
    if (!candidates.length) return { skipped: "no_open_invites" };
    safe(() => db.setSetting(IDENTITY_HINT_KEY_PREFIX + customerId, String(now())), null);
    const lineRow = safe(() => db.getCustomer(customerId), null);
    notifier?.fireLater?.({
      customerId, channelId, reason: "identity_link_candidate",
      customerName: nameOf(lineRow) || "ลูกค้า LINE ใหม่",
      reasonTextOverride: hintText(candidates, { nowMs: now() }),
      force: true,
    });
    safe(() => db.addAudit({
      operator: "system", action: "identity_link_hint", target: customerId,
      detail: `ห้อง LINE ใหม่ไม่มีรหัส · ลิงก์เชิญที่ยังไม่ใช้ ${candidates.length} ห้อง: ${candidates.slice(0, MAX_LISTED).map((row) => row.id).join(", ")}`,
    }), null);
    return { hinted: candidates.length };
  }

  /**
   * ห้อง LINE เพิ่งแอดเพื่อน (follow) หรือทักครั้งแรกโดยไม่มีรหัส → ตรวจหลังรอ delayMs (ลูกค้าอาจกำลังส่งรหัสตามมา)
   * @param {{customerId: string, channelId: string, at?: number, source?: "follow"|"first_message"}} event
   */
  function noteNewLineContact({ customerId, channelId, at = now(), source = "follow" } = {}) {
    const id = String(customerId || "");
    if (!id || String(channelId || "") === FACEBOOK_CHANNEL_ID || id.startsWith("canary:")) return false;
    if (identityLinkMode(db) === "off" || alreadyHinted(id)) return false;
    // ไม่มีลิงก์ค้างเลย = ไม่ต้องตั้งเวลา (กรณีส่วนใหญ่ของเพื่อนใหม่ทั่วไป)
    if (!safe(() => db.openIdentityInvites({ sinceMs: at - IDENTITY_HINT_WINDOW_MS, untilMs: at, nowMs: now(), limit: 1 }), []).length) return false;
    schedule(() => {
      try {
        check({ customerId: id, channelId, anchorMs: at });
      } catch (err) {
        logger.debug?.(`identityLinkHints: ตรวจคู่ห้องไม่สำเร็จ (${err?.message || err}) · ${source}`);
      }
    }, delayMs);
    return true;
  }

  return { noteNewLineContact, check };
}
