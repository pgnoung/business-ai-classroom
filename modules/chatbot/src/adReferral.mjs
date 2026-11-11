// adReferral.mjs — อ่าน "มาจากแอดไหน" ของ Messenger แล้วจดลง customer_ad_referrals (คำสั่งพี่ง้วง 6 ต.ค. 2026)
//
// ที่มา: แอดชุด "QUALIFIED MSG 6 OCT 2026" ทำมาเพื่อเลิกดึงคนหารายได้/เกษียณ/ตกงาน แต่ตัวกวาดห้องสีเหลือง
// (qualifySweep) บอกได้แค่ว่าห้องไหนไม่เข้าเกณฑ์ — ไม่รู้ว่าห้องนั้นมาจากแอดตัวไหน จึงตัดแอดที่ดึงคนผิดไม่ได้
//
// Meta ส่ง referral มาสามที่ (เอกสาร Messenger Platform webhook):
//   message.referral         — ข้อความแรกหลังคลิกแอด Click-to-Messenger (เธรดใหม่)
//   postback.referral        — ปุ่มเริ่มต้นของเธรดใหม่
//   messaging[].referral     — event "messaging_referrals": คนที่มีเธรดอยู่แล้วกดแอด/ลิงก์ m.me เข้ามาอีก
//   ⚠ เพจต้อง subscribe ฟิลด์ messaging_referrals ด้วย (นอกจาก messages) ไม่งั้น Meta ไม่ส่ง referral เลย
//
// กติกาของไฟล์นี้:
// - **ห้ามเปลี่ยนวิธีตอบ** — จดอย่างเดียว ไม่สร้างแถวลูกค้า ไม่แตะ ai_enabled ไม่ส่งอะไรเข้าไปป์ไลน์/พรอมต์
// - สวิตช์ ad_referral_capture: ไม่มีแถว/ค่าอื่น/อ่านพัง = off (ฟีเจอร์ใหม่ปิดไว้ก่อนตามกติกา chassis)
// - **ห้าม throw** — จดพังต้องไม่ทำให้ข้อความลูกค้าหายหรือ webhook ตอบ 500 (Meta จะส่งซ้ำทั้งก้อน)
// - เก็บเฉพาะที่มาของแอด + post_id + รูปแอด (photo_url หรือภาพปก video_url) ไว้โชว์แถบ "มาจากโฆษณา" ในหน้าแชท
//   (พี่ง้วง 6 ต.ค. ค่ำ) — รูปรับเฉพาะ https บนโดเมน CDN ของ Meta · ลิงก์หมดอายุได้ หน้าเว็บมีภาพสำรอง

import { activeBrand, isGenericProfile } from "./brand.mjs";
export const AD_REFERRAL_CAPTURE_KEY = "ad_referral_capture";
export const AD_REFERRAL_CAPTURE_MODES = Object.freeze(["off", "on"]);

const MAX_REF = 200;
const MAX_TITLE = 120;
const MAX_ENUM = 40;
// Meta: ad_id เป็นสตริงตัวเลข (เกิน 2^53 จึงต้องเป็นสตริงเท่านั้น — ตัวเลข JS เสียความแม่นยำ ไม่เดาค่า)
const AD_ID_PATTERN = /^\d{1,32}$/u;
// Meta: ref รับเฉพาะ "alphanumeric, -, _, =" — ตัวอื่นทิ้ง
const REF_DISALLOWED = /[^A-Za-z0-9_=-]/gu;
const ENUM_DISALLOWED = /[^A-Z_]/gu;
// post_id ของ ads_context_data = "<page id>_<post id>" (บางครั้งมาเลขเดียว)
const POST_ID_PATTERN = /^\d{1,32}(?:_\d{1,32})?$/u;
const MAX_PHOTO_URL = 2048;
// ไม่ใช้ CONTROL_CHARS (ธง g ทำให้ .test สลับผลตาม lastIndex) — ช่องว่างใน URL ก็ไม่รับ
const URL_UNSAFE = /[\u0000-\u0020\u007f-\u009f]/u;
// รูปแอดมาจาก CDN ของ Meta เท่านั้น — โดเมนอื่น = ไม่เก็บ (หน้าแชทจะไปดึงรูปจากที่อยู่นี้ในเบราว์เซอร์ทีมงาน)
const PHOTO_HOST_SUFFIXES = Object.freeze([".fbcdn.net", ".facebook.com", ".fbsbx.com", ".cdninstagram.com"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;

/** อ่านสวิตช์แบบปิดไว้ก่อนเสมอ (fail closed) */
export function adReferralCaptureMode(db) {
  // White-label: โปรไฟล์ generic ปิดฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วงเสมอ (ค่าใน DB ไม่มีผล)
  if (isGenericProfile(activeBrand())) return "off";
  try {
    const value = db?.getSetting?.(AD_REFERRAL_CAPTURE_KEY);
    return AD_REFERRAL_CAPTURE_MODES.includes(value) ? value : "off";
  } catch {
    return "off";
  }
}

const enumValue = (value) => String(value ?? "").toUpperCase().replace(ENUM_DISALLOWED, "").slice(0, MAX_ENUM);
const adIdValue = (value) => (typeof value === "string" && AD_ID_PATTERN.test(value) ? value : "");
const refValue = (value) => (typeof value === "string" ? value.replace(REF_DISALLOWED, "").slice(0, MAX_REF) : "");

const postIdValue = (value) => (typeof value === "string" && POST_ID_PATTERN.test(value) ? value : "");

/** รูปแอดที่ยอมให้คอนโซลโหลด: https บน CDN Meta เท่านั้น — ผิดเงื่อนไข = '' (adReferralView ตรวจซ้ำตอนอ่าน) */
export function photoUrlValue(value) {
  if (typeof value !== "string" || !value || value.length > MAX_PHOTO_URL || URL_UNSAFE.test(value)) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    const host = url.hostname.toLowerCase();
    return PHOTO_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ? url.href : "";
  } catch {
    return "";
  }
}

/** รูปแอด: photo_url ก่อน · ไม่มีแล้วค่อยใช้ภาพปกวิดีโอ (video_url ของ Meta คือที่อยู่ภาพปก) */
function adMedia(context) {
  const photo = photoUrlValue(context?.photo_url);
  if (photo) return { photoUrl: photo, mediaType: "photo" };
  const videoThumb = photoUrlValue(context?.video_url);
  return videoThumb ? { photoUrl: videoThumb, mediaType: "video" } : { photoUrl: "", mediaType: "" };
}

function titleValue(value) {
  if (typeof value !== "string") return "";
  const clean = value.replace(CONTROL_CHARS, " ").replace(/\s+/gu, " ").trim();
  return [...clean].slice(0, MAX_TITLE).join("");
}

function referralOf(event) {
  if (!event || typeof event !== "object") return null;
  if (event.message?.is_echo) return null; // echo = ข้อความของเพจเอง ไม่ใช่การเข้ามาจากแอด
  const candidates = [
    ["referral", event.referral],
    ["postback", event.postback?.referral],
    ["message", event.message?.referral],
  ];
  for (const [kind, value] of candidates) {
    if (value && typeof value === "object" && !Array.isArray(value)) return { kind, value };
  }
  return null;
}

/**
 * แปลง event ของ Messenger เป็นข้อมูลที่มาของแอด — ไม่มี referral หรือไม่มีอะไรบอกที่มาเลย = null
 * (referral สินค้าจาก Shops มีแค่ product.id ไม่มี source/ad_id/ref = ไม่ใช่เรื่องที่รายงานนี้นับ)
 */
export function extractAdReferral(event, { nowMs = Date.now() } = {}) {
  const found = referralOf(event);
  if (!found) return null;
  const { kind, value } = found;
  const source = enumValue(value.source);
  const adId = adIdValue(value.ad_id);
  const ref = refValue(value.ref);
  if (!source && !adId && !ref) return null;
  const ts = Number(event.timestamp);
  return {
    kind,
    source,
    type: enumValue(value.type),
    adId,
    ref,
    adTitle: titleValue(value.ads_context_data?.ad_title),
    postId: postIdValue(value.ads_context_data?.post_id),
    ...adMedia(value.ads_context_data),
    referralAt: Number.isFinite(ts) && ts > 0 ? Math.trunc(ts) : nowMs,
  };
}

/**
 * จดที่มาจากแอดของ event นี้ (ถ้ามี) — คืน { captured, reason } เสมอ ไม่ throw
 * firstContact = ยังไม่มีแถวลูกค้าของห้องนี้ตอนที่ event เข้ามา (ผู้เรียกอ่านก่อนสร้างแถว)
 */
export function captureAdReferral(db, {
  event, customerId, channelId = "facebook", firstContact = false, nowMs = Date.now(), logger = console,
} = {}) {
  try {
    if (adReferralCaptureMode(db) !== "on") return { captured: false, reason: "off" };
    const referral = extractAdReferral(event, { nowMs });
    if (!referral) return { captured: false, reason: "none" };
    const inserted = db.recordAdReferral({
      customerId, channelId, source: referral.source, type: referral.type, adId: referral.adId,
      ref: referral.ref, adTitle: referral.adTitle, eventKind: referral.kind,
      firstContact: Boolean(firstContact), referralAt: referral.referralAt,
      postId: referral.postId, photoUrl: referral.photoUrl, mediaType: referral.mediaType,
    });
    return inserted ? { captured: true, reason: "stored" } : { captured: false, reason: "duplicate" };
  } catch (err) {
    try {
      logger?.warn?.(`ad referral: จดที่มาจากแอดไม่สำเร็จ (${err?.message || err}) — ข้อความลูกค้าเดินต่อตามปกติ`);
    } catch { /* logger พังก็ห้ามลากเส้นรับข้อความล้ม */ }
    return { captured: false, reason: "error" };
  }
}
