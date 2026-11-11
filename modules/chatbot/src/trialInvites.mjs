// trialInvites.mjs — ด่านเดียวของ "คำชวนทดลองเรียนฟรี (จำกัดสิทธิ์ต่อวัน)" ทั้งเส้นตอบแชท (v3) และเส้นทักตาม
// พี่ง้วง 12 ต.ค. 2026: ลูกค้าจาง ๆ → ชวนลองคลาสทดลองเรียนฟรี + กิมมิก "จำกัดสิทธิ์ต่อวัน" ให้รีบสนใจ
// เจนเคาะ (ห้ามต่อรอง): คำว่าจำกัดต้องจริง — เพดาน settings.trial_invite_daily_cap (ค่าเริ่มต้น 20 · แก้ได้ภายหลัง) นับต่อวันเวลาไทยทุกห้องรวมกัน
//   · ยังไม่ครบ = ชวนได้และบอกได้ว่าสิทธิ์ที่ลูกแพรเปิดได้แต่ละวันมีจำนวนจำกัด (ไม่มีตัวเลข/ไม่มี "เหลือ X ที่")
//   · ครบแล้ว = วันนั้นไม่ชวนเลย · ห้องที่ได้คำชวนไปแล้ว = ไม่ชวนซ้ำ · ไม่มีลิงก์ทดลองเรียนที่อนุมัติ = ไม่ชวน (ไม่สัญญาสิ่งที่ส่งไม่ได้)
//   · ห้องที่เคยได้ลิงก์ทดลองเรียนนี้แล้วทางอื่น (ลูกค้าขอเอง/ทีมงานพิมพ์/เครื่องเดิม) = ไม่ชวนซ้ำ (ผู้ตรวจ 12 ต.ค.)
// ลิงก์มาจากบล็อก "คลาสทดลองเรียน (เรียนฟรี)" ในการ์ดความรู้ที่อนุมัติและเปิดใช้อยู่เท่านั้น (ตัวอ่านเดียวกับเส้นส่งลิงก์ทดลองเรียนของ v3)
import { randomUUID } from "node:crypto";
import { approvedTrialLink } from "./replyEngineV3/contextEnvelope.mjs";
import { bangkokIsoDate } from "./followupTiming.mjs";

export const TRIAL_INVITE_CAP_KEY = "trial_invite_daily_cap";
export const TRIAL_INVITE_CAP_DEFAULT = 20;
export const TRIAL_INVITE_CAP_MAX = 500;

/** เพดานคำชวนต่อวัน — ไม่มีแถว/อ่านพัง/ค่าแปลก = 20 · 0 = ปิดคำชวนทั้งหมด */
export function trialInviteDailyCap(db) {
  let raw = null;
  try { raw = db?.getSetting?.(TRIAL_INVITE_CAP_KEY); } catch { raw = null; }
  if (raw === null || raw === undefined || String(raw).trim() === "") return TRIAL_INVITE_CAP_DEFAULT;
  const text = String(raw).trim();
  if (!/^\d{1,4}$/u.test(text)) return TRIAL_INVITE_CAP_DEFAULT;
  return Math.min(TRIAL_INVITE_CAP_MAX, Number(text));
}

/**
 * ลิงก์ทดลองเรียนที่อนุมัติจากการ์ดความรู้ทั้งชุด — อ่านทีละการ์ด · ลิงก์ไม่ตรงกัน/ไม่มี = "" (fail closed)
 * การ์ดที่ปิดใช้ (active = 0) ไม่นับ — เจ้าของปิดการ์ดเพราะคลาสทดลองจบแล้ว = ห้ามชวนด้วยลิงก์เก่า
 */
export function approvedTrialLinkFromEntries(entries = []) {
  const links = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.active === 0 || entry?.active === false) continue;
    const text = String(entry?.content || "");
    if (!text.includes("ทดลองเรียน")) continue;
    const url = approvedTrialLink({ businessStatus: "approved", businessKnowledgeText: text });
    if (url) links.add(url);
  }
  return links.size === 1 ? [...links][0] : "";
}

/**
 * ข้อความที่อาจถึงมือลูกค้าแล้วหลังสั่งส่ง — ใช้ตัดสินว่าคำชวนถูกส่งหรือไม่
 * ส่งสำเร็จ/ล้มชัดเจน = ข้อความที่ provider รับจริง (delivered) · ผลกำกวม (reply/push ได้ 0 หรือ 5xx: LINE อาจรับไปแล้ว)
 * = ทั้งชุดที่ตั้งใจส่ง — นับเกิน (ชวนน้อยลง) ดีกว่าคืนสิทธิ์แล้วชวนห้องเดิมซ้ำ
 */
export function trialDeliveredText({ sendResult = {}, delivered = [], intended = [] } = {}) {
  const status = Number(sendResult?.status) || 0;
  const ambiguous = sendResult?.ok !== true && sendResult?.blocked !== true
    && (sendResult?.ambiguous === true || (sendResult?.status !== undefined && (status === 0 || status >= 500)));
  return (ambiguous ? intended : delivered).map((text) => String(text ?? "")).join("\n");
}

/**
 * ด่านคำชวนของห้องนี้ ณ ตอนนี้ (อ่านอย่างเดียวจนกว่าจะเรียก reserve) — หนึ่งด่าน = ผู้ถือการจองหนึ่งราย (holder)
 * @returns {{available: boolean, reason: string, url: string, day: string, cap: number,
 *   reserve: () => {ok: boolean, reason: string}, settle: (deliveredText: string) => string, release: () => void, reserved: () => boolean}}
 */
export function trialInviteGate({ db, customerId, nowMs = Date.now(), entries = [], logger = null } = {}) {
  const day = bangkokIsoDate(nowMs);
  const cap = trialInviteDailyCap(db);
  const url = approvedTrialLinkFromEntries(entries);
  const holder = randomUUID();
  let held = false;
  let reason = "";
  try {
    const row = db?.trialInviteRow?.(customerId) ?? null;
    if (!url) reason = "no_approved_link";
    else if (cap <= 0) reason = "cap_zero";
    else if (row?.status === "sent") reason = "already_invited";
    else if (db?.roomReceivedText?.(customerId, url)) reason = "already_has_link";
    else if (!(row?.status === "reserved" && row.day === day) && Number(db?.trialInvitesCounted?.(day, nowMs) ?? cap) >= cap) reason = "cap_reached";
  } catch (err) {
    reason = "ledger_unavailable";
    logger?.debug?.(`trialInvites: อ่านบัญชีคำชวนไม่ได้ (${err?.message || err}) — ไม่ชวน`);
  }
  const gate = {
    available: !reason, reason: reason || "available", url, day, cap,
    reserve() {
      if (!gate.available) return { ok: false, reason: gate.reason };
      try {
        const out = db.reserveTrialInvite({ customerId, day, cap, atMs: nowMs, holder });
        held = out.ok === true;
        return out;
      } catch (err) {
        logger?.warn?.(`trialInvites: จองสิทธิ์ไม่สำเร็จ (${err?.message || err}) — ไม่ชวน`);
        return { ok: false, reason: "ledger_unavailable" };
      }
    },
    reserved: () => held,
    /** คืนสิทธิ์ที่ด่านนี้ถือ — ถ้าการจองถูกเทิร์นอื่นรับไปถือแล้ว ไม่มีอะไรถูกลบ */
    release() {
      if (!held) return;
      held = false;
      try { db.releaseTrialInvite({ customerId, holder }); } catch { /* การจองที่ค้างหมดอายุเองตาม TTL */ }
    },
    /**
     * หลังส่งจริง: มีลิงก์ทดลองเรียนในข้อความที่ (อาจ) ถึงมือลูกค้า = จดว่าส่งแล้ว (เสมอ แม้การจองหาย) · ไม่มี = คืนสิทธิ์
     * คืน "sent" เฉพาะเมื่อจดลงบัญชีได้จริง · "unrecorded" = ส่งแล้วแต่จดไม่ได้ · "released" · "" = ด่านนี้ไม่ได้จอง
     */
    settle(deliveredText = "") {
      if (!held) return "";
      if (url && String(deliveredText || "").includes(url)) {
        held = false;
        try {
          if (db.markTrialInviteSent({ customerId, day, atMs: Math.max(Number(nowMs) || 0, Date.now()) })) return "sent";
        } catch (err) {
          logger?.warn?.(`trialInvites: จดคำชวนที่ส่งแล้วไม่สำเร็จ (${err?.message || err})`);
        }
        return "unrecorded";
      }
      gate.release();
      return "released";
    },
  };
  return gate;
}
