// aiPause.mjs — สวิตช์หยุด AI "ทั้งระบบ" แบบยังรับข้อมูล (v1.4.47 — คำสั่งพี่ง้วง 2026-08-22)
//
// ใช้ตอน cutover เข้า LINE OA จริง: เปิด webhook รับทุกข้อความ ดึงชื่อ บันทึกประวัติ
// จับ facts/lifecycle ตามปกติ แต่ "ไม่ตอบใคร ไม่ทักใคร" จนกว่าพี่ง้วงสั่ง kick off
// (ปิดสวิตช์นี้ในคอนโซลปุ่มเดียว)
//
// สองชั้นเหมือน followup_enabled: ค่า runtime ใน DB (คอนโซล) ชนะ env AI_PAUSED
// ต่างกันที่ทิศ fail-safe: อ่าน DB ไม่ได้ -> ถือว่า "หยุด" (เงียบปลอดภัยกว่าพูดผิด)
import { createHash, timingSafeEqual } from "node:crypto";

export const AI_PAUSE_SETTING = "ai_paused";
// 2026-08-24 (พี่ง้วงเลือก "โหมดร่างอย่างเดียว" ระหว่าง cutover): paused อยู่ แต่ AI
// คิดและวางร่างไว้ใน Correction Loop ให้แอดมินกด "ใช้ร่างนี้" เอง — ไม่ส่งหาลูกค้าเด็ดขาด
// fail-safe คนละทิศกับ pause: อ่านค่าไม่ได้ = ถือว่า "ปิดโหมดร่าง" (ไม่คิด ไม่เสียเงิน)
export const AI_PAUSE_DRAFT_SETTING = "ai_paused_draft_mode";
const REACTIVE_CANARY_DOMAIN = "lukprae-ai-paused-reactive-canary-v1\0";
const SHA256_VALUE = /^sha256:[a-f0-9]{64}$/u;

function pauseState({ db, config } = {}) {
  try {
    const stored = db?.getSetting?.(AI_PAUSE_SETTING);
    if (stored === "1") return { paused: true, trusted: true };
    if (stored === "0") return { paused: false, trusted: true };
  } catch {
    return { paused: true, trusted: false };
  }
  return { paused: config?.aiPaused === true, trusted: true };
}

export function aiPausedDraftModeOn({ db, config } = {}) {
  try {
    const stored = db?.getSetting?.(AI_PAUSE_DRAFT_SETTING);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    return false;
  }
  return config?.aiPausedDraftMode === true;
}

export function reactiveCanarySha256(customerId) {
  return `sha256:${createHash("sha256").update(`${REACTIVE_CANARY_DOMAIN}${String(customerId ?? "")}`).digest("hex")}`;
}

export function validReactiveCanarySha256(value) {
  return SHA256_VALUE.test(String(value || ""));
}

export function aiPausedNow({ db, config } = {}) {
  return pauseState({ db, config }).paused;
}

// ช่วง cutover ยัง pause ทั้งระบบ แต่ยอมให้ทดสอบ reactive text ได้คนเดียวจาก hash ใน env
// เท่านั้น ไม่มีชื่อ/LINE id ใน config และไม่แตะเส้น proactive, follow-up หรือ audio fallback.
export function aiPausedForReactiveCustomer({ db, config, customerId } = {}) {
  const state = pauseState({ db, config });
  if (!state.paused) return false;
  if (!state.trusted || !customerId) return true;
  const configured = String(config?.aiPausedReactiveCanarySha256 || "");
  if (!validReactiveCanarySha256(configured)) return true;
  const expected = reactiveCanarySha256(customerId);
  return !timingSafeEqual(
    Buffer.from(configured.slice("sha256:".length), "hex"),
    Buffer.from(expected.slice("sha256:".length), "hex"),
  );
}
