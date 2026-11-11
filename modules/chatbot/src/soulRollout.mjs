// soulRollout.mjs — เปิดใช้ soul รุ่นทดลองทีละขั้น โดยไม่ต้อง deploy (ขั้นที่ 3 ของแผน soul, 20 ต.ค. 2026)
//
// release หนึ่งตัวมี soul สองรุ่น: รุ่นหลัก (SOUL_FILE ที่ใช้อยู่) + รุ่นทดลอง (SOUL_CANDIDATE_FILE)
// ห้องไหนได้รุ่นไหนตัดสินจากสวิตช์ในหน้าตั้งค่า (อ่านสดทุกเทิร์น · เจ้าของเท่านั้นที่กดได้):
//   soul_candidate_mode — off (ไม่มีแถว/ค่าขยะ/อ่านพัง: ทุกห้องรุ่นหลักเหมือนเดิมทุกไบต์)
//                       · canary (ห้องใหม่ที่เริ่มคุยหลังเวลาเปิด ได้รุ่นทดลองตามสัดส่วน · ห้องเดิมคงรุ่นหลัก ไม่เปลี่ยนน้ำเสียงกลางบทสนทนา)
//                       · all (ทุกห้อง + เส้นที่ไม่ผูกห้อง: owner chat · ห้องตรวจ · ตัวคัดกรอง · ตัวปิดนอกเรื่อง)
//   soul_candidate_since   — เวลาเริ่มกลุ่มทดลอง (ตั้งเองตอนกดเป็น canary · ไม่มี = ไม่มีห้องเข้ากลุ่ม)
//   soul_candidate_percent — สัดส่วนห้องใหม่ที่ได้รุ่นทดลอง (1–100 · ไม่มีแถว = 20)
// ห้องเดียวกันได้คำตอบเดิมทุกครั้ง (แบ่งด้วย hash ของรหัสห้อง ไม่สุ่มใหม่) · ถอยกลับ = กด off (มีผลเทิร์นถัดไป)
// ไฟล์นี้ไม่มีชื่อแบรนด์ — chassis กลางใช้ได้ทุกร้านที่มี soul สองรุ่น
import { createHash } from "node:crypto";

export const SOUL_CANDIDATE_MODE_KEY = "soul_candidate_mode";
export const SOUL_CANDIDATE_MODES = Object.freeze(["off", "canary", "all"]);
export const SOUL_CANDIDATE_SINCE_KEY = "soul_candidate_since";
export const SOUL_CANDIDATE_PERCENT_KEY = "soul_candidate_percent";
export const SOUL_CANDIDATE_DEFAULT_PERCENT = 20;

function setting(db, key) {
  try {
    return String(db?.getSetting?.(key) ?? "").trim();
  } catch {
    return "";
  }
}

export function soulCandidateMode(db) {
  const value = setting(db, SOUL_CANDIDATE_MODE_KEY).toLowerCase();
  return SOUL_CANDIDATE_MODES.includes(value) ? value : "off";
}

export function soulCandidatePercent(db) {
  const raw = setting(db, SOUL_CANDIDATE_PERCENT_KEY);
  const value = raw === "" ? SOUL_CANDIDATE_DEFAULT_PERCENT : Number(raw);
  if (!Number.isFinite(value)) return SOUL_CANDIDATE_DEFAULT_PERCENT;
  return Math.min(100, Math.max(1, Math.round(value)));
}

/** เวลาเริ่มกลุ่มทดลอง (ms) — ไม่มี/อ่านไม่ได้ = null = ไม่มีห้องใดเข้ากลุ่ม */
export function soulCandidateSince(db) {
  const parsed = Date.parse(setting(db, SOUL_CANDIDATE_SINCE_KEY));
  return Number.isFinite(parsed) ? parsed : null;
}

/** ช่อง 0–99 ของห้อง — คงที่ต่อรหัสห้อง */
export function canaryBucket(customerId) {
  const digest = createHash("sha256").update(`soul-canary:${String(customerId ?? "")}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/** ห้องนี้อยู่ในกลุ่มทดลองไหม (โหมด canary) — ห้องที่สร้างก่อนเวลาเปิด หรือไม่รู้เวลาสร้าง = ไม่อยู่ */
export function inCanary(db, customerId, { since = soulCandidateSince(db), percent = soulCandidatePercent(db) } = {}) {
  if (!customerId || since === null) return false;
  let createdAt = 0;
  try {
    createdAt = Number(db.getCustomer(customerId)?.created_at) || 0;
  } catch {
    return false;
  }
  if (!createdAt || createdAt < since) return false;
  return canaryBucket(customerId) < percent;
}

/** ตัวเลือกให้ soul/index.mjs — { customerId } ว่าง = เส้นที่ไม่ผูกห้อง (ได้รุ่นทดลองเฉพาะโหมด all) */
export function createSoulSelector({ db }) {
  return ({ customerId = "" } = {}) => {
    const mode = soulCandidateMode(db);
    if (mode === "all") return "candidate";
    if (mode === "canary" && customerId && inCanary(db, customerId)) return "candidate";
    return "primary";
  };
}

/** หลังกดสวิตช์: เข้าโหมด canary ใหม่ทุกครั้ง = เริ่มนับห้องใหม่จากตอนนี้ */
export function onSoulCandidateModeChange(db, before, after, nowMs = Date.now()) {
  if (after === "canary" && before !== "canary") db.setSetting(SOUL_CANDIDATE_SINCE_KEY, new Date(nowMs).toISOString());
}

/** สถานะสำหรับหน้า #/soul */
export function soulRolloutInfo(db) {
  const since = soulCandidateSince(db);
  return {
    mode: soulCandidateMode(db),
    percent: soulCandidatePercent(db),
    since: since === null ? "" : new Date(since).toISOString(),
  };
}
