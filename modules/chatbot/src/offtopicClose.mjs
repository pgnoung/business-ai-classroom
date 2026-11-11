// offtopicClose.mjs — ตีจบแชทที่คุยไปเรื่อยนอกเรื่องการเรียน (คำสั่งพี่ง้วง 12 ต.ค. 2026 14:10)
//
// พี่ง้วง: "ถ้าลูกค้าคนไหน เริ่มคุยไปเรื่อย ใน topic ที่ไม่น่าจะเข้ามาสู่การเรียน หรือ เป็นลูกค้าเราได้ ให้คุณ ตีจบได้เลย
//          (เช่น ขอเงินหน่อย, ไม่มีตังค์เรียน, บวชอยู่, หาเงินกินข้าว, มาทำธุรกิจกับผมไหม, ไม่ได้ใช้ มีแต่ขาย ai ให้คน)"
//
// กุญแจสองดอก (เจนออกแบบ) — ดอกเดียวไม่ตีจบเด็ดขาด:
//   ดอกที่ 1 = ตัวจับคำไทยชุดตายตัว (offtopicCues.mjs) บนข้อความล่าสุดของลูกค้า (ทั้งก้อน burst) แยกหมวด: ask_money · no_budget_drift · monk ·
//              survival_income · business_pitch · ai_vendor · gambling · adult_harassment · off_topic_personal (ห้องสแปมที่ทีมติดป้าย
//              12 ต.ค.: พนัน · หยาบ/ลวนลามลูกแพร · หาคู่/ขอให้ปลุก/เงินก้อนโต) — ข้อความที่มีสัญญาณผู้ซื้อ (ถามราคา/ผ่อน/รอบ/สมัคร/ทีม/
//              ถามเรื่องเรียน/อยากเรียน/อยากให้ AI ช่วยงาน/เชิญบรรยาย) · เรื่องเงินที่จ่ายแล้ว · เรื่องที่ต้องดูแลใจ = ไม่มีดอกที่ 1
//   ดอกที่ 2 = Luna (gpt-5.6-luna ผ่าน hermes.offtopicCheck · เส้นตาย ~8 วิ) อ่าน 12 เทิร์นล่าสุด + หมวด ตอบ JSON {close, category, reason}
//              ล้ม/หมดเวลา/ผิดรูป/ไม่ใช่ true ตรงตัว = ไม่ตีจบ ตอบตามปกติ · ตอบ false = จำไว้ 7 วัน ห้องนั้น+หมวดนั้นไม่ถามซ้ำ
// ข้อความหลอกระบบ (รีวิวรอบ 7 — คำตัดสินของเจน): ไม่ใช่เหตุตีจบแล้ว ไม่มีหมวดของตัวเอง — hermesBridge ตัดโค้ดแบบแข็งออกจากทุกคำขอ
//   (promptInjection.mjs) แล้วลูกแพรตอบตามปกติ · ห้องสแปมจริงที่ส่งก้อนโค้ดถูกตีจบด้วยหมวดขาย AI ผ่าน Luna อยู่แล้ว
// ครบสองดอก = ไปป์ไลน์ให้เครื่อง v3 เขียนคำลาหนึ่งข้อความ (GOODBYE/offtopic_close · replyEngineV3/offtopicTurn.mjs)
//   ยกเว้นหมวดข้อความลาตายตัว (FIXED_CLOSE_CATEGORIES: adult_harassment) — ไม่ร่างด้วยโมเดล ไม่เสี่ยงคำหวาน
//   v3 ปิด/ล้ม/ถอยเครื่องเดิม/ร่างมีคำถาม ลิงก์ ราคา = ข้อความลาสั้นที่เขียนไว้ตามหมวด (offtopicFallbackText)
//   v3 ตัดสินว่าเป็นจังหวะดูแลใจ (care_moment) = ไม่ตีจบ (จังหวะดูแลใจชนะเสมอ)
// ส่งครบแล้วค่อยปิดห้องเป็นสีเหลือง "เหมือนตัวกวาดทุกอย่าง" (applyClose): CAS เดียวกัน · audit ai_off_not_qualified ·
//   สถานะ qualify:<id> (mode on + offAt + offtopic) · qualify_hold · + audit offtopic_close พร้อมหมวด
//   ทักตามไม่ถูกยกเลิก (เหมือนตัวกวาด): ai_enabled=0 หยุดผู้ส่งทุกตัวอยู่แล้ว — ห้องที่เปิดคืนได้ทักตามเดิม
//   → ทางลัดเปิดเขียว (qualifyFastReclaim — สัญญาณอ่อน "สนใจ/ถามคลาส" ของห้องที่ตีจบ รอตัวกวาดตรวจแทน) · ตัวกวาดตรวจซ้ำ ·
//     ทีมกดเปิด AI (qualify_release) ทำงานกับห้องนี้เหมือนห้องเหลืองทุกห้อง
//
// ไม่แตะเด็ดขาด: ห้องที่ AI ปิดแล้ว · คน/ทีมถือห้องหรือเพิ่งแตะใน 7 วัน · มีเงิน/เริ่มจ่าย · นักเรียนเก่า/ลูกค้าที่ลงทะเบียน (lifecycle/ป้าย)
//   · คะแนนร้อน · ห้องทดสอบ/ห้องทีม/ห้องเจ้าของ · เส้นด่วน/ร้องเรียน/สุขภาพจิต/เงิน (ไปป์ไลน์กันก่อนเรียก)
//   · ได้ราคาแล้วและลูกค้าต่อรอง (ผ่อน/ลด/แพง) แล้วบอกว่าไม่มีงบ = ข้อกังวลเรื่องราคา ให้เส้นปกติดูแลใจ
//     (กติกาพี่ง้วง 5 ต.ค.: ถามราคาตอนเงินตึงยังได้ราคาตามจริง — Luna ไม่ตีจบห้องที่ลูกค้าถามราคาเอง)
// สวิตช์ offtopic_close_mode (พี่ง้วง 12 ต.ค. ค่ำ: "ไม่มีอะไรปิดเองอีกแล้ว — AI เสนอ พี่ง้วง/ชมพู่กดยืนยัน"):
//   ไม่มีแถว/ว่าง/propose = propose — เทิร์นสด assess() คืน null ก่อนเรียก Luna (ลูกแพรตอบตามปกติ ไม่มีค่าใช้จ่ายเพิ่ม)
//     ห้องที่ควรตีจบถูกเสนอโดยรอบตรวจ 09/12/15/19 (ownerReviewScheduler.mjs → judge()) แล้วคนกดยืนยันในคอนโซล
//     (ownerCloseService.mjs → applyClose({ owner })) · on = ตีจบเองในเทิร์น (แบบเดิม — เก็บไว้ใช้ภายหลัง ต้องให้
//   qualify_sweep_mode เป็น on ด้วย เพราะ off/shadow ของตัวกวาดคืนห้องเหลืองทุกนาที) · shadow = เรียก Luna แล้วจดคำตัดสินใน
//   audit offtopic_shadow ไม่ตีจบจริง · ค่าอื่นทุกค่า/อ่านพัง = off (ปิดเมื่อไม่แน่ใจ) · คอนโซลสลับได้ที่ "สวิตช์พฤติกรรมลูกแพร"
// พี่ง้วงกด "ไม่ปิด" = offtopic_owner_kept:<id> (หมวดนั้น 30 วัน) — blockReason กันทั้งการเสนอและการตีจบเองในเทิร์น
// เงิน: llm_usage kind offtopic_check · เพดาน ฿100/วัน (แยกจากเพดานตัวกวาด) · ราคาไม่รู้/บันทึกต้นทุนไม่ได้/ชนเพดาน = ไม่ตีจบ
// ไม่ log เนื้อหาแชท — log/audit เป็นหมวดและเหตุสั้นเท่านั้น
// ห้าม import pipeline.mjs (ไปป์ไลน์รับตัวนี้ผ่าน createPipeline({ offtopicCloser }) จาก server.mjs)
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { loadModelPricing, pricingById, summarizeUsage } from "./modelPricing.mjs";
import { OFFTOPIC_MODEL } from "./hermesBridge.mjs";
import { CLAUDE_EXPORT_TESTERS_KEY, parseClaudeExportTesterIds } from "./claudeChatExport.mjs";
import { soulBlock } from "./soul/index.mjs";
import {
  FIXED_CLOSE_CATEGORIES, OFFTOPIC_CATEGORIES, OFFTOPIC_CUE_PATTERNS, OFFTOPIC_SCAN_CHARS as SCAN_CHARS, detectOfftopicCue,
} from "./offtopicCues.mjs";
import {
  AUDIT_AI_OFF_NOT_QUALIFIED, NOT_QUALIFIED_REASON, QUALIFY_AUDIT_OPERATOR,
  qualifyHoldKey, qualifyHumanOnKey, qualifyReleaseKey, qualifyStateKey,
} from "./notQualified.mjs";
import {
  QUALIFY_CAS_OFF_SQL, QUALIFY_LATEST_INBOUND_SQL, lastHumanNoteAtFor, lastStaffReplyAtFor, readQualifySweepModeStrict,
  yellowBlockReason,
} from "./qualifySweepRules.mjs";

export const OFFTOPIC_CLOSE_MODE_KEY = "offtopic_close_mode";
// ลำดับนี้คือการสลับในคอนโซล: ปิด → ทดลอง → เสนอให้คนยืนยัน → ตีจบเอง (ผ่านทดลองก่อนเสมอ แบบเดียวกับสวิตช์ตัวกวาด)
export const OFFTOPIC_CLOSE_MODES = Object.freeze(["off", "shadow", "propose", "on"]);
// พี่ง้วงกด "ไม่ปิด" ห้องที่ AI เสนอ = ห้องนั้น+หมวดนั้นไม่ถูกเสนอ/ตีจบซ้ำ 30 วัน (settings — PDPA กวาดตามรูปแบบ <ชื่อ>:<id>)
export const OFFTOPIC_OWNER_KEPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const offtopicOwnerKeptKey = (customerId) => `offtopic_owner_kept:${customerId}`;
export const OFFTOPIC_USAGE_KIND = "offtopic_check";
export const AUDIT_OFFTOPIC_CLOSE = "offtopic_close";
export const AUDIT_OFFTOPIC_SHADOW = "offtopic_shadow";
export const OFFTOPIC_DAILY_THB_CAP = 100;
export const OFFTOPIC_CONTEXT_TURNS = 12;
export const OFFTOPIC_TURN_CHARS = 300;
export const OFFTOPIC_MAX_COMPLETION_TOKENS = 600;
// Luna ตอบว่าไม่ตีจบ = ห้องนั้น+หมวดนั้นไม่ถามซ้ำ 7 วัน (คนขายบริการ AI/เจ้าของธุรกิจพูดคำเดิมซ้ำได้ทุกข้อความ —
// ถามซ้ำทุกข้อความ = จ่ายซ้ำ และเปิดโอกาสตีจบผิดคนเพิ่มขึ้นตามความยาวแชท)
export const OFFTOPIC_KEPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const offtopicKeptKey = (customerId) => `offtopic_kept:${customerId}`;
// ดอกที่ 1 (ตัวจับคำ + ด่านผู้ซื้อ) อยู่ที่ offtopicCues.mjs — ส่งออกซ้ำจากที่นี่ให้ผู้เรียกเดิมใช้ได้เหมือนเดิม
export {
  FIXED_CLOSE_CATEGORIES, OFFTOPIC_CATEGORIES, OFFTOPIC_CUE_PATTERNS, detectOfftopicCue,
} from "./offtopicCues.mjs";

/** ลูกค้าต่อรองราคาในบทสนทนาล่าสุด (ผ่อน/ลด/แพง/โปร) — pure */
export function customerNegotiated(history = []) {
  return (Array.isArray(history) ? history : []).slice(-OFFTOPIC_CONTEXT_TURNS)
    .some((turn) => turn?.role === "user" && OFFTOPIC_CUE_PATTERNS.NEGOTIATION_RE.test(String(turn.content ?? "").slice(0, SCAN_CHARS)));
}

/* ------------------------------------ สวิตช์ ------------------------------------ */

/**
 * ไม่มีแถว/ว่าง/propose = propose (คำสั่งพี่ง้วง 12 ต.ค. ค่ำ — ไม่มีอะไรปิดเอง) · on = ตีจบเองในเทิร์น ·
 * shadow = ทดลอง (ตัดสินแล้วจด ไม่ตีจบ) · ค่าอื่นทุกค่า ("off" "false" "0" พิมพ์ผิด) และอ่านพัง = off (ไม่ตีจบเมื่อไม่แน่ใจ)
 */
export function offtopicCloseMode(db) {
  try {
    const value = String(db?.getSetting?.(OFFTOPIC_CLOSE_MODE_KEY) ?? "").trim().toLowerCase();
    if (value === "" || value === "propose") return "propose";
    if (value === "on" || value === "shadow") return value;
    return "off";
  } catch {
    return "off";
  }
}

/** ตีจบเองในเทิร์นทำงานได้ไหมตอนนี้: ตัวกวาดต้อง on (ห้องเหลืองอยู่รอด) และสวิตช์ของตัวเองเป็น on */
export function offtopicCloseActive(db) {
  return offtopicCloseMode(db) === "on" && readQualifySweepModeStrict(db) === "on";
}

/**
 * ปิดเหลืองได้ไหม (applyClose): ตัวกวาดต้อง on เสมอ (off/shadow คืนห้องเหลืองทุกนาที — ลาแล้วห้องไม่ปิด)
 * ownerConfirmed = พี่ง้วง/ชมพู่กดยืนยันเอง (ownerCloseService) — ไม่พึ่งสวิตช์ตีจบเอง · ไม่ใช่คนยืนยัน = สวิตช์ต้องเป็น on
 */
export function offtopicCloseApplyAllowed(db, { ownerConfirmed = false } = {}) {
  if (readQualifySweepModeStrict(db) !== "on") return false;
  return ownerConfirmed === true || offtopicCloseMode(db) === "on";
}

/**
 * โหมดที่ใช้จริงของเทิร์นนี้: on (ตีจบได้) · shadow (เรียก Luna จดผล ไม่ตีจบ — ไม่ต้องพึ่งตัวกวาด) ·
 * propose (ไม่เรียก Luna ในเทิร์น — รอบตรวจของเจ้าของเป็นคนเสนอ) · off
 */
export function offtopicEffectiveMode(db) {
  const mode = offtopicCloseMode(db);
  if (mode === "shadow" || mode === "propose") return mode;
  return mode === "on" && readQualifySweepModeStrict(db) === "on" ? "on" : "off";
}

/* ----------------------------- พี่ง้วงกด "ไม่ปิด" ----------------------------- */

function readOwnerKeptRaw(db, customerId) {
  const raw = db.getSetting(offtopicOwnerKeptKey(customerId));
  if (raw == null || String(raw).trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** หมวดที่เจ้าของสั่งไม่ปิดของห้องนี้ (ยังไม่หมดอายุ 30 วัน) — {category: {at, by, proposalId}} · อ่านพัง = โยน (ผู้เรียกกันเอง) */
export function offtopicOwnerKept(db, customerId, nowMs = Date.now()) {
  return Object.fromEntries(Object.entries(readOwnerKeptRaw(db, customerId))
    .filter(([category, mark]) => OFFTOPIC_CATEGORIES.includes(category)
      && Number(mark?.at) > 0 && Number(nowMs) - Number(mark.at) < OFFTOPIC_OWNER_KEPT_TTL_MS));
}

/** จด "ไม่ปิด" ของเจ้าของ (ห้องนี้+หมวดนี้ 30 วัน) — ทับของเดิมของหมวดเดียวกัน */
export function rememberOfftopicOwnerKept(db, customerId, category, { by = "", proposalId = "", nowMs = Date.now() } = {}) {
  if (!OFFTOPIC_CATEGORIES.includes(category)) return false;
  const fresh = offtopicOwnerKept(db, customerId, nowMs);
  db.setSetting(offtopicOwnerKeptKey(customerId), JSON.stringify({
    ...fresh, [category]: { at: Number(nowMs), by: String(by).slice(0, 60), proposalId: String(proposalId).slice(0, 80) },
  }));
  return true;
}

/** ถอนคำสั่ง "ไม่ปิด" (กดย้อนภายใน 10 วิ) — ลบเฉพาะหมวดที่มาจาก proposal นี้ */
export function forgetOfftopicOwnerKept(db, customerId, category, { proposalId = "", nowMs = Date.now() } = {}) {
  const fresh = offtopicOwnerKept(db, customerId, nowMs);
  if (!fresh[category] || (proposalId && fresh[category].proposalId !== String(proposalId))) return false;
  const rest = Object.fromEntries(Object.entries(fresh).filter(([key]) => key !== category));
  if (Object.keys(rest).length) db.setSetting(offtopicOwnerKeptKey(customerId), JSON.stringify(rest));
  else db.raw?.prepare?.("DELETE FROM settings WHERE key = ?").run(offtopicOwnerKeptKey(customerId));
  return true;
}

/* ------------------------------ ดอกที่ 2: Luna ยืนยัน ------------------------------ */

export const OFFTOPIC_CATEGORY_LABELS = Object.freeze({
  ask_money: "ขอเงิน/ขอยืมเงินจากเรา/ขอบริจาค",
  no_budget_drift: "บอกว่าไม่มีเงินหรือไม่มีงบเรียน",
  monk: "บวชอยู่ (พระ/สามเณร)",
  survival_income: "หาเงินยังชีพ/ของานทำกับเรา",
  business_pitch: "ชวนเราทำธุรกิจ/ร่วมลงทุน หรือเสนอขายบริการให้เรา (ไม่ใช่การเล่าธุรกิจของตัวเอง)",
  ai_vendor: "ขายบัญชีหรือบริการ AI ให้คนอื่น และไม่ได้มาเพื่อเรียน (ไม่ใช่คนทำงานด้าน AI ที่อยากเรียนต่อยอด)",
  gambling: "ชวนเล่นพนัน/ขอสูตรหรือเลขเด็ด/ขอให้ AI ช่วยพนัน",
  adult_harassment: "คำหยาบเชิงเพศ หรือถามแฟน/อายุ/ขอช่องทางส่วนตัวของลูกแพรพร้อมคำจีบโดยไม่มีเรื่องเรียนหรือเรื่องงาน",
  off_topic_personal: "เรื่องส่วนตัวที่ไม่เกี่ยวกับการเรียน (หาคู่ ขอให้ปลุก/ร้องเพลงกล่อม เงินก้อนโตจากคนแปลกหน้า)",
});

// 18 ต.ค. 2026 (ขั้นที่ 1 ของแผน soul): บรรทัดตัวตน (บรรทัดแรกเดิม) มาจาก soul เส้น offtopic ตรงตัว
// ไม่มี soul = บรรทัดกลางที่ไม่มีชื่อแบรนด์ · กติกาด้านล่างคงเดิมทุกไบต์
const OFFTOPIC_RULES = [
  "คำสั่งเจ้าของ: ลูกค้าที่เริ่มคุยไปเรื่อยในเรื่องที่ไม่น่าจะพาไปสู่การเรียนหรือเป็นลูกค้าได้ ให้ลูกแพรตีจบอย่างสุภาพ เช่น ขอเงิน/ขอยืมเงิน · ไม่มีตังค์เรียน "
    + "(โดยไม่ได้ถามราคาหรือทางผ่อน) · บวชอยู่ · หาเงินกินข้าว/ของานทำ · ชวนเรามาทำธุรกิจ/ลงทุน/เสนอขายบริการให้เรา · ไม่ได้ใช้ AI เพราะขาย AI ให้คนอื่นอยู่แล้ว "
    + "· ชวนเล่นพนัน/ขอเลขเด็ด · พูดหยาบเชิงเพศหรือลวนลามลูกแพร · คุยเรื่องส่วนตัว (หาคู่ ขอให้ปลุก ร้องเพลงกล่อม เงินก้อนโตจากคนแปลกหน้า)",
  "งานของคุณ: ระบบเจอคำที่เข้าข่ายหมวดหนึ่งในข้อความล่าสุดของลูกค้า อ่านบทสนทนาทั้งหมดแล้วตัดสินว่าควรตีจบหรือไม่",
  "ตีจบผิดคนเดียว = เสียลูกค้าหลักหมื่น · ตอบ close=true เฉพาะเมื่อบทสนทนาชัดว่าไม่ได้มุ่งไปสู่การเรียน",
  "ตอบ close=false เสมอเมื่อมีข้อใดข้อหนึ่ง (ทุกหมวด):",
  "- เรื่องร้องเรียน ความปลอดภัย สุขภาพจิต เรื่องเดือดร้อน (ตกงาน ป่วย น้ำท่วม สูญเสีย) เรื่องด่วน หรือเงินที่จ่ายไปแล้ว (คืนเงิน สลิป)",
  "- เงินหรือข้อเสนอไหลมาทางเรา: บริษัทหรือที่บ้านจะออกค่าเรียนให้ เชิญพี่ง้วงไปบรรยาย/สอน สปอนเซอร์หรือจ้างงานพี่ง้วง",
  "- ลูกค้าจะพาทีม พนักงาน หรือองค์กรมาเรียน หรืออยากให้ไปอบรมที่บริษัท",
  "- คำที่ระบบเจอเป็นการเล่าเรื่องในอดีต เรื่องของคนอื่น หรือความหมายอื่น (เช่นขอเวลาสัก 10 นาที ขอยืมร่ม แว่น หรือไมค์ที่ห้องเรียน "
    + "ลูกขอค่าเทอม งบไม่มีจำกัด หรือคำที่ยกมาในโค้ด/เครื่องหมายคำพูด)",
  "- คุณไม่แน่ใจ",
  "ตอบ close=false เมื่อมีข้อใดข้อหนึ่ง (ทุกหมวดยกเว้น monk · gambling · คำหยาบเชิงเพศของ adult_harassment):",
  "- ลูกค้าถามราคา ค่าเรียน การผ่อน ส่วนลด รอบเรียน วันเรียน หรือวิธีสมัคร/จอง (ในบทสนทนานี้)",
  "- ลูกค้าเล่าเป้าหมายงานหรือธุรกิจที่อยากให้ AI ช่วย ซึ่งตรงกับคลาส",
  "- ลูกค้ากำลังเล่างานหรือธุรกิจของตัวเองเพื่อตอบคำถามของลูกแพร (ทำงานด้านไหน ทำธุรกิจอะไร) — การเล่าว่ารับทำเพจ ยิงแอด "
    + "ขายตรง เป็นตัวแทน รับทำแชทบอท หรือสอน AI ไม่ใช่การชวนเราทำธุรกิจ คนทำงานด้าน AI คือผู้ซื้อคลาส Agent",
  "- ลูกค้าบอกว่าอยากเรียนหรือสนใจคลาส พร้อมถามรายละเอียดหรือขั้นต่อไป",
  "- ลูกค้าบอกว่าจะเก็บเงิน รอเงินเดือน จะสมัครภายหลัง หรือถามหาทุน",
  "- ลูกค้าจะไปขอเงินจากที่บ้าน แฟน หรือบริษัทมาเรียน (เป็นผู้ซื้อ ไม่ใช่ขอเงินเรา)",
  "- หมวด no_budget_drift: ลูกแพรเพิ่งแจ้งราคา แล้วลูกค้าบอกว่างบไม่พอเป็นครั้งแรก (ข้อกังวลเรื่องราคา ให้ลูกแพรดูแลใจก่อน)",
  "กติกาหมวด monk (คำสั่งเจ้าของ \"บวชอยู่\" ตีจบได้เลย): ลูกค้าเป็นพระหรือสามเณรที่บวชอยู่ตอนนี้ = close=true แม้เคยถามราคา รอบ "
    + "หรือเล่าเป้าหมายมาก่อน · close=false เมื่อสึกแล้ว/เคยบวช/พูดถึงการบวชของคนอื่น/เป็นฆราวาสที่ทำงานกับวัด "
    + "หรือวัด/องค์กรจะส่งคนมาเรียนเป็นกลุ่มและออกค่าเรียนเอง · ลูกหรือหลานของลูกค้าเป็นพระ/เณร = ลูกค้าไม่ใช่พระ "
    + "· ขายพระเครื่องหรือสังฆภัณฑ์ หรือลูกค้าของร้านเป็นพระ = ลูกค้าไม่ใช่พระ close=false",
  "กติกาหมวด gambling: ลูกค้าชวนเล่นพนัน ขอสูตรหรือเลขเด็ด ขอให้ AI ช่วยพนัน หรือโฆษณาเว็บพนัน = close=true แม้เคยถามราคามาก่อน "
    + "· close=false เมื่อคำนั้นเป็นการเล่าธุรกิจหรืองานถูกกฎหมายของลูกค้า (แผงลอตเตอรี่ ทนาย ตำรวจ งานป้องกันเว็บพนัน) ที่อยากใช้ AI ช่วยงาน "
    + "หรือเล่าว่าเลิกเล่นแล้ว · ร้านเบอร์มงคลหรือป้ายทะเบียนเลขสวย บริษัททัวร์หรือโรงแรม พ่อแม่ที่ลูกติดพนัน หรือกฎกรองคอมเมนต์สแปม = close=false",
  "กติกาหมวด adult_harassment: คำหยาบเชิงเพศ หรือพูดเรื่องทางเพศกับลูกแพร = close=true เสมอ · ถามเรื่องป้องกัน ข่าว หรือ deepfake "
    + "(เช่นพ่อแม่ถามว่า AI ทำรูปโป๊ได้ไหมเพื่อกันลูก) ตำรวจหรือทนายที่ทำคดี หรือคำว่า sex ที่เป็นช่องข้อมูลในโค้ด/ชีท/ฟอร์ม = close=false "
    + "· ถามแฟน ถามอายุ หรือขอไลน์/เบอร์ส่วนตัวของลูกแพรพร้อมคำจีบ (น่ารัก คิดถึง อยากเป็นแฟน) = close=true เมื่อในบทสนทนานี้ลูกค้าไม่ได้ถามเรื่องคลาสจริง · ขอเบอร์/ไลน์เพื่อโทรถามรายละเอียด สมัคร "
    + "ส่งสลิป ติดต่อพี่ง้วงหรือทีมงาน หรือคุยเรื่องจ้างสอน/อบรม = close=false · ขอย้ายไปคุยทางไลน์หรือช่องทางที่สะดวกกว่า "
    + "(ไม่ค่อยเล่นเฟส สะดวกทางไลน์ อยากถามข้อมูลเพิ่ม) = close=false · ขอบคุณหรือชมแรง ๆ (เช่น \"ขอบคุณมาก รักนะครับ\") = close=false",
  "กติกาหมวด off_topic_personal: หาคู่หรือหาแฟน ขอให้ลูกแพรปลุกหรือร้องเพลงกล่อม เรื่องได้เงินก้อนโตจากคนแปลกหน้า = close=true เมื่อบทสนทนาไม่ได้มุ่งไปสู่การเรียน "
    + "· close=false เมื่อเป็นงานหรือคอนเทนต์ของลูกค้าที่อยากใช้ AI ช่วย (เช่นทำเพลงกล่อมเด็ก ทำแอปหาคู่)",
  "ตอบเป็น JSON บรรทัดเดียวเท่านั้น ไม่มีข้อความอื่น:",
  `{"close":true,"category":"${OFFTOPIC_CATEGORIES.join("|")}","reason":"<เหตุสั้นไม่เกิน 80 ตัวอักษร ไม่ยกคำพูดหรือชื่อลูกค้า>"}`,
];

/** system ของ Luna ที่ยืนยันการตีจบ (ส่วนคงที่ แคชได้) */
export function offtopicSystemPrompt() {
  return [soulBlock("offtopic"), ...OFFTOPIC_RULES].join("\n");
}

const clip = (value, max) => {
  const chars = [...String(value ?? "").replace(/\s+/gu, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

/** ข้อความ user ของ Luna: หมวด + 12 เทิร์นล่าสุด (เก่า → ใหม่ ตัดเทิร์นละ 300 ตัว) + ข้อความล่าสุด */
export function buildOfftopicCheckUser({ category = "", history = [], text = "" } = {}) {
  const turns = (Array.isArray(history) ? history : []).slice(-OFFTOPIC_CONTEXT_TURNS)
    .filter((turn) => turn && String(turn.content ?? "").trim())
    .map((turn) => `[${turn.role === "user" ? "ลูกค้า" : "ลูกแพร"}] ${clip(turn.content, OFFTOPIC_TURN_CHARS)}`);
  return [
    `หมวดที่ระบบเจอ: ${category} (${OFFTOPIC_CATEGORY_LABELS[category] || "-"})`,
    "บทสนทนาก่อนหน้า (เก่า → ใหม่):",
    turns.length ? turns.join("\n") : "(ยังไม่มี — นี่คือข้อความแรกของห้อง)",
    "ข้อความล่าสุดของลูกค้า:",
    clip(text, OFFTOPIC_TURN_CHARS * 2),
  ].join("\n");
}

// เหตุจากโมเดลเข้า audit เท่านั้น — ตัดคำในเครื่องหมายคำพูด (กันยกคำพูดลูกค้า) และขึ้นบรรทัด
function cleanReason(value) {
  return clip(String(value ?? "").replace(/["“”'‘’][^"“”'‘’\n]{0,200}["“”'‘’]/gu, "…"), 120);
}

/**
 * แปลงคำตอบของ Luna (pure) — null = ใช้ไม่ได้ (ไม่ตีจบ) · close ต้องเป็น boolean จริง ("true" สตริง = ผิดรูป)
 * @returns {null | {close: boolean, category: string, reason: string}} category "" = นอกรายการ (ผู้เรียกใช้หมวดของดอกที่ 1)
 */
export function parseOfftopicVerdict(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start || end - start > 2_000) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.close !== "boolean") return null;
  return {
    close: parsed.close,
    category: OFFTOPIC_CATEGORIES.includes(parsed.category) ? parsed.category : "",
    reason: cleanReason(parsed.reason),
  };
}

/* ------------------------------- ข้อความลาสำรอง ------------------------------- */

// ใช้เมื่อเครื่อง v3 ปิด/ล้ม/ร่างไม่ผ่าน — สั้น อบอุ่น คำลงท้ายผู้หญิง ไม่มีคำถาม ราคา ลิงก์ หรือชื่อคลาส
// พระ: ฆราวาสไม่อวยพรพระ — ใช้คำขอที่นอบน้อม · ขาย/ทำงานด้าน AI: เปิดประตูไว้ (คนทำงาน AI คือผู้ซื้อคลาส Agent ในวันหน้า)
const FALLBACK_TEXT = Object.freeze({
  ask_money: "ลูกแพรเข้าใจนะคะ แต่ต้องขออภัยจริง ๆ ค่ะ ลูกแพรช่วยเรื่องเงินหรือให้ยืมเงินไม่ได้ แชทนี้ลูกแพรดูแลเฉพาะเรื่องสอบถามคลาสเรียน AI ของพี่ง้วงค่ะ ขอเป็นกำลังใจให้ผ่านช่วงนี้ไปได้ด้วยดีนะคะ",
  no_budget_drift: "ลูกแพรเข้าใจค่ะ ตอนนี้ยังไม่สะดวกก็ไม่เป็นไรเลยนะคะ ไม่ต้องฝืนค่ะ วันไหนพร้อมและอยากรู้เรื่องคลาส AI ทักลูกแพรมาได้เสมอค่ะ ขอให้ทุกอย่างราบรื่นนะคะ",
  monk: "นมัสการค่ะ กราบขอบพระคุณที่เมตตาติดต่อมาค่ะ แชทนี้ลูกแพรดูแลเฉพาะเรื่องสอบถามคลาสเรียน AI ของพี่ง้วง ขอพระคุณเจ้าโปรดรักษาสุขภาพนะคะ กราบนมัสการค่ะ",
  survival_income: "ลูกแพรเข้าใจและเป็นกำลังใจให้นะคะ แต่ต้องขออภัยค่ะ ลูกแพรช่วยเรื่องหางานหรือหารายได้ไม่ได้ แชทนี้ลูกแพรดูแลเฉพาะเรื่องสอบถามคลาสเรียน AI ของพี่ง้วงค่ะ ขอให้เจอโอกาสดี ๆ เร็ว ๆ นะคะ",
  business_pitch: "ขอบคุณที่นึกถึงและติดต่อมานะคะ แต่เรื่องชวนทำธุรกิจหรือเสนอบริการ ลูกแพรรับไว้ทางแชทนี้ไม่ได้ค่ะ แชทนี้ลูกแพรดูแลเฉพาะเรื่องสอบถามคลาสเรียน AI ของพี่ง้วงค่ะ ขอให้งานราบรื่นนะคะ",
  ai_vendor: "ขอบคุณที่เล่าให้ฟังนะคะ แชทนี้ลูกแพรดูแลเรื่องสอบถามคลาสเรียน AI ของพี่ง้วงเป็นหลักค่ะ วันไหนอยากต่อยอดเรื่อง AI Agent ทักลูกแพรมาได้เสมอนะคะ ขอให้งานไปได้ดีค่ะ",
  gambling: "ขออภัยนะคะ เรื่องการพนันหรือเลขเด็ด ลูกแพรช่วยไม่ได้ค่ะ แชทนี้ลูกแพรดูแลเฉพาะเรื่องสอบถามคลาสเรียน AI ของพี่ง้วงค่ะ ขอให้เป็นวันที่ดีนะคะ",
  // สุภาพ ขีดเส้นชัด ไม่หวาน ไม่อีโมจิ ไม่อวยพรแบบสนิทสนม (ข้อความตายตัว — ไม่ให้โมเดลร่าง)
  adult_harassment: "ลูกแพรขอดูแลแชทนี้เฉพาะเรื่องสอบถามคลาสเรียน AI ของพี่ง้วงนะคะ เรื่องส่วนตัวหรือข้อความลักษณะนี้ ลูกแพรขอไม่คุยต่อค่ะ ขอบคุณที่เข้าใจค่ะ",
  // เรื่องส่วนตัว (หาคู่/ขอให้ปลุก/ร้องเพลงกล่อม): ปิดด้วยคำขอบคุณที่เป็นกลาง ไม่อวยพรแบบสนิทสนม
  off_topic_personal: "ขอบคุณที่ทักมานะคะ แต่เรื่องส่วนตัวแบบนี้ลูกแพรช่วยไม่ได้ค่ะ แชทนี้ลูกแพรดูแลเฉพาะเรื่องสอบถามคลาสเรียน AI ของพี่ง้วงค่ะ ขอบคุณที่เข้าใจนะคะ",
});
const FALLBACK_DEFAULT = "ขอบคุณที่ทักมานะคะ แชทนี้ลูกแพรดูแลเฉพาะเรื่องสอบถามคลาสเรียน AI ของพี่ง้วงค่ะ ขอให้เป็นวันที่ดีนะคะ";

/**
 * ข้อความลาสำรองตามหมวด — ข้อความแรกของห้องนำด้วย "สวัสดีค่ะ"
 * (ยกเว้นพระที่ขึ้นต้นด้วยนมัสการอยู่แล้ว และหมวดข้อความลาตายตัวที่ส่งเหมือนเดิมทุกครั้ง)
 */
export function offtopicFallbackText(category, { firstReply = false } = {}) {
  const text = FALLBACK_TEXT[category] || FALLBACK_DEFAULT;
  return firstReply && category !== "monk" && !FIXED_CLOSE_CATEGORIES.includes(category) ? `สวัสดีค่ะ ${text}` : text;
}

// คำลาที่ v3 เขียนต้องไม่มีอะไรขาย/ถามติดไป และยังบอกว่าลูกแพรดูแลเรื่องคลาส AI — ไม่ผ่าน = ใช้ข้อความสำรอง
// (ด่านหลังร่างของ v3 ตัดประโยคคำถามทิ้งได้ — เหลือแค่ "ขอบคุณค่ะ" สั้น ๆ = ไม่ใช่คำลาที่ครบ)
const CLOSE_TEXT_MIN = 40;
const CLOSE_TEXT_MAX = 400;
// รีวิวรอบ 4: รีวิว/รูปบรรยากาศ/ทดลองเรียน/ช่องเติม = ของขายที่หลุดมากับคำลา ("ลูกแพรฝากรีวิวไว้ให้ดูนะคะ" ทั้งที่ช่องรีวิวถูกตัดทิ้ง)
const CLOSE_FORBIDDEN_RE = /(?:[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|https?:|www\.|\[image|\{\{|ราคา|บาท|ผ่อน|ส่วนลด|โปรโมชั่น|โปรโมชัน|รอบเรียน|รอบหน้า|รอบที่เปิด|จองที่|เลข(?:ที่)?บัญชี|พร้อมเพย์|โอนเงิน|รีวิว|บรรยากาศ|ทดลองเรียน|\d{3})/iu;
const CLOSE_SCOPE_RE = /(?:คลาส|คอร์ส|เรียน|ai|เอไอ)/iu;
// พระ: ห้ามเรียก "คุณ" (ยกเว้นพระคุณเจ้า/ขอบพระคุณ) และห้ามอีโมจิ — แชทจริงเคยเรียกพระว่า "คุณ" ตามชื่อเฟซบุ๊ก
const MONK_CLOSE_BAD_RE = /(?:(?<!พระ)คุณ|\p{Extended_Pictographic})/u;
// พนัน/ลวนลาม/เรื่องส่วนตัว: ห้ามอีโมจิ คำหวาน หรือคำอวยพรเรื่องคู่/โชค (รีวิวรอบ 3: "ขอให้เจอคนที่ใช่นะคะ 💕" ถึงคนที่ขอให้สร้างครอบครัวด้วย)
const COOL_CLOSE_CATEGORIES = Object.freeze(["gambling", "adult_harassment", "off_topic_personal"]);
const WARM_CLOSE_BAD_RE = /(?:\p{Extended_Pictographic}|รัก(?!ษ)|คิดถึง|จุ๊บ|คนที่ใช่|เนื้อคู่|คู่ชีวิต|หัวใจ|ฝันดี|โชค)/u;

/** ร่างคำลาของ v3 ใช้ได้ไหม (pure) */
export function offtopicCloseTextOk(text, category = "") {
  const value = String(text ?? "").trim();
  const length = [...value].length;
  if (category === "monk" && MONK_CLOSE_BAD_RE.test(value)) return false;
  if (COOL_CLOSE_CATEGORIES.includes(category) && WARM_CLOSE_BAD_RE.test(value)) return false;
  return length >= CLOSE_TEXT_MIN && length <= CLOSE_TEXT_MAX && !CLOSE_FORBIDDEN_RE.test(value) && CLOSE_SCOPE_RE.test(value);
}

/** เหตุบนหัวห้องสีเหลือง (คอนโซลแสดงเหตุนี้ ≤120 ตัว) — ไม่มีคำพูดลูกค้า */
const STATE_REASON = Object.freeze({
  ask_money: "ลูกค้าขอเงินหรือขอยืมเงิน ไม่ใช่เรื่องการเรียน — ลูกแพรตีจบอย่างสุภาพแล้ว",
  no_budget_drift: "ลูกค้าบอกว่าไม่มีงบเรียนและไม่ได้ถามทางเลือก — ลูกแพรตีจบอย่างสุภาพแล้ว",
  monk: "ลูกค้าบวชอยู่ (พระ/สามเณร) — ลูกแพรตีจบอย่างให้เกียรติแล้ว",
  survival_income: "ลูกค้าหางานหรือหาเงินยังชีพ ไม่ใช่เรื่องการเรียน — ลูกแพรตีจบอย่างสุภาพแล้ว",
  business_pitch: "ลูกค้าชวนทำธุรกิจ/ลงทุน/เสนอขายบริการ — ลูกแพรตีจบอย่างสุภาพแล้ว",
  ai_vendor: "ลูกค้าขายบัญชีหรือบริการ AI เอง ไม่ได้มองหาคลาส — ลูกแพรตีจบอย่างสุภาพแล้ว",
  gambling: "ลูกค้าชวนเล่นพนันหรือขอเลขเด็ด ไม่ใช่เรื่องการเรียน — ลูกแพรตีจบอย่างสุภาพแล้ว",
  adult_harassment: "ลูกค้าพูดหยาบเชิงเพศหรือถามเรื่องส่วนตัวของลูกแพร — ลูกแพรขีดเส้นอย่างสุภาพและตีจบแล้ว",
  off_topic_personal: "ลูกค้าคุยเรื่องส่วนตัว (หาคู่/ขอให้ปลุก/เงินก้อนโต) ไม่ใช่เรื่องการเรียน — ลูกแพรตีจบอย่างสุภาพแล้ว",
});
// หมวดของตัวกวาด (qualifyPrompt) ที่ใกล้ที่สุด — รายงาน/สถิติที่อ่าน category เดิมยังจัดกลุ่มได้
const SWEEP_CATEGORY = Object.freeze({
  ask_money: "no_income", no_budget_drift: "no_income", survival_income: "income_seeker_no_budget",
  monk: "not_fit", business_pitch: "not_fit", ai_vendor: "not_fit",
  gambling: "not_fit", adult_harassment: "not_fit", off_topic_personal: "not_fit",
});
// คำตัดสินจากกุญแจสองดอก (ไม่ใช่คะแนนความมั่นใจของโมเดล) — ใช้แสดงผลเท่านั้น
const CLOSE_CONFIDENCE = 0.9;

/* ---------------------------------- ตัวตีจบ ---------------------------------- */

const TEST_ROOM_PREFIX = /^(?:canary|sandbox|training)[-:]/u;
// ข้อความลูกค้าที่คนตรวจเห็นตอนกดยืนยัน (applyClose owner.anchorSeen) — ต้องเป็นข้อความขาเข้าของห้องนี้เท่านั้น
const OWNER_SEEN_INBOUND_SQL = "SELECT id, created_at FROM messages WHERE id = ? AND customer_id = ? AND direction = 'in'";

export function createOfftopicCloser({
  config = {}, db, hermes, logger = console, now = Date.now, thbPerUsd = null, modelPricing = null,
  dailyThbCap = OFFTOPIC_DAILY_THB_CAP,
} = {}) {
  let pricing = null;
  let usageBroken = false; // บันทึกต้นทุนไม่ได้ครั้งเดียว = หยุดเรียกโมเดลจนรีสตาร์ต (นับเงินไม่ได้ = ไม่จ่าย)
  let unmetered = { day: 0, count: 0 }; // ได้ 200 แต่ไม่มีตัวเลข usage — นับเป็นค่าประมาณในเพดาน
  let capLoggedDay = 0;
  const raw = () => db?.raw;

  const pricingMap = () => {
    pricing ??= pricingById(modelPricing ?? loadModelPricing(config.modelPricingFile, { logger }));
    return pricing;
  };
  const fxRate = () => {
    try {
      const live = Number(typeof thbPerUsd === "function" ? thbPerUsd() : thbPerUsd);
      if (live > 0) return live;
    } catch { /* fx พัง = ใช้ค่า config */ }
    return Number(config.thbPerUsd) > 0 ? Number(config.thbPerUsd) : 36;
  };

  /* ----------------------------- ห้องที่ห้ามแตะ ----------------------------- */

  function testerIds() {
    try {
      return new Set(parseClaudeExportTesterIds(db.getSetting(CLAUDE_EXPORT_TESTERS_KEY)));
    } catch {
      return null; // อ่านรายชื่อห้องทดสอบไม่ได้ = ไม่รู้ว่าห้องนี้เป็นห้องทดสอบไหม → ไม่ตีจบ
    }
  }

  // หมุด "คนกดเปิด AI" (ms หรือ JSON {at}) — มีหมุดแต่อ่านไม่ออก = ถือว่าคนเพิ่งกด (ด้านปลอดภัย)
  function humanOnAt(customerId, nowMs) {
    const value = db.getSetting(qualifyHumanOnKey(customerId));
    if (value == null || String(value).trim() === "") return 0;
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 0) return direct;
    try {
      const at = Number(JSON.parse(value)?.at);
      if (Number.isFinite(at) && at > 0) return at;
    } catch { /* อ่านไม่ออก */ }
    return nowMs;
  }

  // 12 ต.ค. ค่ำ (session แคมเปญ #AIAGENT): ป้าย "ที่มา: …" ที่ทีมติด = ห้องที่ทีมพามาด้วยแคมเปญ/คลาส (เช่น IESA6 คุยแผน AI Agent ไม่ใช่คอร์ส)
  // ห้ามเสนอปิด/ตีจบเด็ดขาด · อ่านไม่ได้ = ถือว่ามีป้าย (ไม่ปิด)
  const CAMPAIGN_SOURCE_TAG_SQL = "SELECT 1 AS hit FROM customer_tags WHERE customer_id = ? AND tag LIKE 'ที่มา:%' LIMIT 1";
  function campaignSourceTagged(customerId) {
    try {
      const database = raw();
      return database ? Boolean(database.prepare(CAMPAIGN_SOURCE_TAG_SQL).get(String(customerId))) : true;
    } catch {
      return true;
    }
  }

  function silencedByTag(customerId) {
    try {
      return typeof db.isBotSilencedByTag === "function" ? Boolean(db.isBotSilencedByTag(customerId)) : true;
    } catch {
      return true;
    }
  }

  /**
   * เหตุที่ห้ามตีจบห้องนี้ ("" = ตีจบได้) — ด่านชุดเดียวกับการปิดเหลืองของตัวกวาด + ห้องทดสอบ/ทีม/เจ้าของ
   * history (ถ้ามี) = บทสนทนาของเทิร์นนี้: ได้ราคาแล้ว + ลูกค้าต่อรอง แล้วบอกว่าไม่มีงบ = ข้อกังวลเรื่องราคา (ไม่ตีจบ)
   */
  function blockReason(customerId, row, category = "", history = null) {
    const id = String(customerId ?? "");
    if (!id || TEST_ROOM_PREFIX.test(id)) return "test_room";
    const testers = testerIds();
    if (!testers || testers.has(id)) return "tester";
    const staff = [...(Array.isArray(config.escalateNotifyIds) ? config.escalateNotifyIds : []), config.digestLineUserId]
      .map((value) => String(value ?? "").trim()).filter(Boolean);
    if (staff.some((value) => value === id || id.endsWith(`:${value}`))) return "staff_room";
    const t = Number(now());
    // ข้อความล่าสุดคือข้อความที่เทิร์นนี้กำลังตอบ (ไม่ใช่ "ค้าง") · burst รวมมาแล้ว
    const block = yellowBlockReason(row, {
      nowMs: t,
      salesDecisionGuardEnabled: config.salesDecisionGuardEnabled === true,
      silenced: silencedByTag(id),
      released: Boolean(db.getSetting(qualifyReleaseKey(id))),
      humanOutboundAt: lastStaffReplyAtFor(db, id),
      humanNoteAt: lastHumanNoteAtFor(db, id),
      humanOnAt: humanOnAt(id, t),
      burstPending: 0,
      unanswered: false,
    });
    if (block) return block;
    if (campaignSourceTagged(id)) return "campaign_source";
    // พี่ง้วง/ชมพู่กด "ไม่ปิด" ห้องนี้+หมวดนี้ภายใน 30 วัน — ไม่เสนอซ้ำ และไม่ตีจบเองในเทิร์น (โหมด on)
    if (category && offtopicOwnerKept(db, id, t)[category]) return "owner_kept";
    if (category === "no_budget_drift" && Number(row?.price_quoted_at) > 0 && history && customerNegotiated(history)) {
      return "price_negotiating";
    }
    return "";
  }

  /* ------------------------- จำคำตัดสิน "ไม่ตีจบ" ของห้อง ------------------------- */

  function keptMarks(customerId) {
    try {
      const parsed = JSON.parse(db.getSetting(offtopicKeptKey(customerId)) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  // ห้องนี้+หมวดนี้ถูกตัดสินไปแล้วใน 7 วัน — on: เฉพาะคำตัดสิน "ไม่ตีจบ" · shadow: ทุกคำตัดสิน (คุมค่าใช้จ่ายช่วงทดลอง)
  function judgedRecently(customerId, category, mode, nowMs) {
    const mark = keptMarks(customerId)[category];
    const at = Number(mark?.at);
    if (!Number.isFinite(at) || at <= 0 || nowMs - at >= OFFTOPIC_KEPT_TTL_MS) return false;
    return mode === "shadow" || mark.verdict === "kept";
  }

  function rememberVerdict(customerId, category, verdict, nowMs) {
    try {
      const fresh = Object.fromEntries(Object.entries(keptMarks(customerId))
        .filter(([key, mark]) => OFFTOPIC_CATEGORIES.includes(key) && nowMs - Number(mark?.at) < OFFTOPIC_KEPT_TTL_MS));
      db.setSetting(offtopicKeptKey(customerId), JSON.stringify({ ...fresh, [category]: { verdict, at: nowMs } }));
    } catch (err) {
      logger.warn?.(`offtopic-close: จดคำตัดสินของห้องไม่สำเร็จ (${err?.message || err})`);
    }
  }

  /* ---------------------------------- เงิน ---------------------------------- */

  function todayRows(t) {
    return db.llmUsageSummary(bangkokDayStartMs(t)).filter((row) => row.kind === OFFTOPIC_USAGE_KIND);
  }
  const estimateRow = (tokensIn) => ({ model: OFFTOPIC_MODEL, kind: OFFTOPIC_USAGE_KIND, tokens_in: tokensIn, tokens_out: OFFTOPIC_MAX_COMPLETION_TOKENS });

  function budgetCheck(t, tokensIn) {
    if (usageBroken) return { ok: false, reason: "usage_unrecorded" };
    const dayKey = bangkokDayStartMs(t);
    const pending = unmetered.day === dayKey ? unmetered.count : 0;
    const rows = [...todayRows(t), ...Array.from({ length: pending }, () => estimateRow(tokensIn)), estimateRow(tokensIn)];
    const projected = summarizeUsage(rows, pricingMap());
    if (projected.unknownTokens > 0) return { ok: false, reason: "pricing_unknown" };
    if (projected.usd * fxRate() > dailyThbCap) return { ok: false, reason: "daily_cap" };
    return { ok: true };
  }

  function noteUnmetered(t) {
    const dayKey = bangkokDayStartMs(t);
    unmetered = unmetered.day === dayKey ? { day: dayKey, count: unmetered.count + 1 } : { day: dayKey, count: 1 };
  }

  function recordUsage(customerId, result) {
    if (!result?.usage) {
      noteUnmetered(now());
      return true;
    }
    try {
      db.addLlmUsage({ customerId, kind: OFFTOPIC_USAGE_KIND, model: result.model || OFFTOPIC_MODEL, ...usageFields(result.usage) });
      return true;
    } catch (err) {
      usageBroken = true;
      logger.error?.(`offtopic-close: บันทึกต้นทุนไม่สำเร็จ — หยุดตรวจจนรีสตาร์ต (${err?.message || err})`);
      return false;
    }
  }

  function logCapOnce(t, reason) {
    const dayKey = bangkokDayStartMs(t);
    if (capLoggedDay === dayKey) return;
    capLoggedDay = dayKey;
    logger.log?.(`[offtopic-close] หยุดตรวจวันนี้ (${reason}) — เพดาน ฿${dailyThbCap}/วัน · ห้องที่คุยนอกเรื่องได้คำตอบตามปกติ`);
  }

  /* ---------------------------------- ตรวจ ---------------------------------- */

  const decided = (customerId, cue, outcome) => logger.info?.(`offtopic_check ${JSON.stringify({ customerId, cue, outcome })}`);

  async function askLuna(id, cue, history, text, { timeoutMs = 0 } = {}) {
    const user = buildOfftopicCheckUser({ category: cue, history, text });
    const deadline = Number(timeoutMs) > 0 ? Number(timeoutMs) : Number(config.offtopicTimeoutMs);
    const t = Number(now());
    const system = offtopicSystemPrompt();
    const budget = budgetCheck(t, system.length + user.length);
    if (!budget.ok) {
      logCapOnce(t, budget.reason);
      return { outcome: `capped:${budget.reason}` };
    }
    let result = null;
    try {
      result = await hermes.offtopicCheck({ system, user, maxCompletionTokens: OFFTOPIC_MAX_COMPLETION_TOKENS,
        ...(deadline > 0 ? { timeoutMs: deadline } : {}) });
    } catch (err) {
      logger.warn?.(`offtopic-close: เรียก Luna ไม่สำเร็จ (${err?.name || "Error"})`);
      result = null;
    }
    if (!result || result.failed) {
      if (!result) noteUnmetered(now()); // 200 ที่ไม่มีเนื้อ = อาจถูกคิดเงินแล้ว
      return { outcome: "luna_failed" };
    }
    if (!recordUsage(id, result)) return { outcome: "usage_unrecorded" };
    const verdict = parseOfftopicVerdict(result.text);
    return verdict ? { verdict } : { outcome: "luna_invalid" };
  }

  function auditShadow(id, cue, verdict) {
    const detail = verdict.close ? `close:${verdict.category || cue}` : "kept";
    audit(AUDIT_OFFTOPIC_SHADOW, id, [detail, `cue:${cue}`, verdict.reason || ""].filter(Boolean).join(" · "));
  }

  /**
   * กุญแจสองดอก — null = ไม่ตีจบ (ตอบตามปกติ) · ไม่โยน error ใส่ไปป์ไลน์เด็ดขาด
   * @param {{customerId: string, text: string, history?: Array<{role: string, content: string}>}} input
   * @returns {Promise<null | {category: string, cue: string, reason: string, fixed?: boolean}>} fixed = ข้อความลาตายตัว ห้ามร่างด้วยโมเดล
   */
  async function assess({ customerId, text = "", history = [] } = {}) {
    try {
      if (typeof hermes?.offtopicCheck !== "function" || !raw()) return null;
      // ตัวจับคำ (pure) ก่อน — ข้อความส่วนใหญ่ไม่มีดอกที่ 1 จึงไม่ต้องอ่านสวิตช์จาก DB ทุกเทิร์น
      const cue = detectOfftopicCue(text);
      if (!cue) return null;
      const mode = offtopicEffectiveMode(db);
      if (mode === "off") return null;
      const id = String(customerId ?? "");
      // propose (ค่าเริ่มต้น): ไม่เรียก Luna ในเทิร์น ไม่ตีจบ — รอบตรวจ 09/12/15/19 เป็นคนเสนอให้พี่ง้วงยืนยัน
      if (mode === "propose") {
        decided(id, cue, "propose");
        return null;
      }
      const row = db.getCustomer(id);
      const block = blockReason(id, row, cue, history);
      if (block) {
        decided(id, cue, `skipped:${block}`);
        return null;
      }
      if (judgedRecently(id, cue, mode, Number(now()))) {
        decided(id, cue, "skipped:judged_recently");
        return null;
      }
      const asked = await askLuna(id, cue, history, text);
      if (!asked.verdict) {
        decided(id, cue, asked.outcome);
        return null;
      }
      const { verdict } = asked;
      if (mode === "shadow") {
        rememberVerdict(id, cue, verdict.close ? "shadow_close" : "kept", Number(now()));
        auditShadow(id, cue, verdict);
        decided(id, cue, `shadow:${verdict.close ? `close:${verdict.category || cue}` : "kept"}`);
        return null;
      }
      if (verdict.close !== true) {
        rememberVerdict(id, cue, "kept", Number(now()));
        decided(id, cue, "kept");
        return null;
      }
      // หมวดของ Luna อาจต่างจากดอกที่ 1 — ด่านเฉพาะหมวดต้องตรวจด้วยหมวดที่จะใช้ตีจบจริง (คำลา/สถานะ/ปิดเหลืองใช้หมวดเดียวกัน)
      // รีวิวรอบ 3: ดอกที่ 1 เจอคำลวนลาม (หมวดข้อความลาตายตัว) แล้ว Luna ตั้งชื่อเป็นหมวดอื่น = ยังใช้ข้อความลาตายตัวของลวนลาม
      // (คนที่พูดหยาบต้องไม่ได้คำลาที่โมเดลร่างและอวยพร)
      const category = FIXED_CLOSE_CATEGORIES.includes(cue) ? cue : (verdict.category || cue);
      if (category !== cue) {
        const categoryBlock = blockReason(id, db.getCustomer(id), category, history);
        if (categoryBlock) {
          decided(id, cue, `skipped:${categoryBlock}:${category}`);
          return null;
        }
      }
      decided(id, cue, `close:${category}`);
      return { category, cue, reason: verdict.reason, ...(FIXED_CLOSE_CATEGORIES.includes(category) ? { fixed: true } : {}) };
    } catch (err) {
      logger.warn?.(`offtopic-close: ตรวจไม่สำเร็จ (${err?.message || err}) — ตอบตามปกติ`);
      return null;
    }
  }

  /* --------------------- ดอกที่ 2 นอกเทิร์น (รอบตรวจของเจ้าของ) --------------------- */

  /**
   * Luna ยืนยันดอกที่ 1 แบบเดียวกับในเทิร์น (พรอมต์/เพดาน ฿100/วัน/llm_usage offtopic_check ชุดเดียวกัน) — ไม่ตีจบ ไม่จด audit
   * ผู้เรียก (ownerReviewScheduler) ตรวจ blockReason เอง และเป็นคนสร้างข้อเสนอให้คนยืนยัน · ไม่โยน error
   * @param {{customerId: string, category: string, text?: string, history?: Array<{role: string, content: string}>, timeoutMs?: number}} input
   * @returns {Promise<{ok: true, close: boolean, category: string, cue: string, reason: string, fixed?: boolean} | {ok: false, outcome: string}>}
   *   category = หมวดที่จะใช้ปิดจริง (หมวดข้อความลาตายตัวของดอกที่ 1 ชนะเสมอ) · outcome: capped:<เหตุ> | luna_failed | luna_invalid | usage_unrecorded | ...
   */
  async function judge({ customerId, category = "", text = "", history = [], timeoutMs = 0 } = {}) {
    try {
      if (typeof hermes?.offtopicCheck !== "function" || !raw()) return { ok: false, outcome: "not_wired" };
      const cue = OFFTOPIC_CATEGORIES.includes(category) ? category : "";
      if (!cue) return { ok: false, outcome: "no_category" };
      const id = String(customerId ?? "");
      const asked = await askLuna(id, cue, history, text, { timeoutMs });
      if (!asked.verdict) {
        decided(id, cue, `judge:${asked.outcome}`);
        return { ok: false, outcome: asked.outcome };
      }
      const { verdict } = asked;
      const resolved = FIXED_CLOSE_CATEGORIES.includes(cue) ? cue : (verdict.category || cue);
      decided(id, cue, `judge:${verdict.close ? `close:${resolved}` : "kept"}`);
      return {
        ok: true, close: verdict.close === true, category: resolved, cue, reason: verdict.reason,
        ...(FIXED_CLOSE_CATEGORIES.includes(resolved) ? { fixed: true } : {}),
      };
    } catch (err) {
      logger.warn?.(`offtopic-close: judge ไม่สำเร็จ (${err?.message || err})`);
      return { ok: false, outcome: "error" };
    }
  }

  /** ห้องนี้+หมวดนี้ Luna เพิ่งตัดสินว่า "ไม่ตีจบ" ใน 7 วัน (ไม่ต้องถามซ้ำทุกรอบตรวจ) */
  const recentlyKept = (customerId, category) => judgedRecently(String(customerId ?? ""), category, "on", Number(now()));
  /** จดคำตัดสิน "ไม่ตีจบ" ของ Luna (กุญแจ offtopic_kept ชุดเดียวกับในเทิร์น) */
  const rememberKept = (customerId, category) => {
    if (OFFTOPIC_CATEGORIES.includes(category)) rememberVerdict(String(customerId ?? ""), category, "kept", Number(now()));
  };

  /* -------------------------------- ปิดเหลือง -------------------------------- */

  function audit(action, customerId, detail) {
    try {
      db.addAudit({ operator: QUALIFY_AUDIT_OPERATOR, action, target: customerId, detail: String(detail).slice(0, 500) });
    } catch (err) {
      logger.warn?.(`offtopic-close: บันทึก audit ไม่สำเร็จ (${err?.message || err})`);
    }
  }

  /**
   * หลังคำลาถึงมือลูกค้าครบแล้ว — ปิดห้องเป็นสีเหลืองแบบเดียวกับตัวกวาด (ต้องเรียกในคิวของห้อง)
   * ด่านทั้งหมดถูกตรวจซ้ำ (คนอาจรับห้องระหว่างที่ลูกแพรกำลังพิมพ์) · ลูกค้าพิมพ์ข้อความใหม่หลังข้อความที่ตอบ = ไม่ปิด
   * ทักตามที่ค้างไม่ถูกยกเลิก (เหมือนตัวกวาด) — ai_enabled=0 ทำให้ผู้ส่งทุกตัวข้าม · ห้องที่เปิดคืนได้ทักตามเดิม
   * @returns {{outcome: string}}
   */
  function applyClose({ customerId, plan, inboundId = "", owner = null } = {}) {
    const id = String(customerId ?? "");
    const category = OFFTOPIC_CATEGORIES.includes(plan?.category) ? plan.category : "";
    // owner = {username, silent, anchorSeen} — คนกดยืนยันข้อเสนอในคอนโซล (ownerCloseService) · silent = ปิดเหลืองโดยไม่ส่งคำลา
    const ownerName = owner && typeof owner === "object" ? String(owner.username || "").slice(0, 60) : "";
    try {
      if (!category || !raw()) return { outcome: "no_plan" };
      if (!offtopicCloseApplyAllowed(db, { ownerConfirmed: Boolean(ownerName) })) return { outcome: "mode_off" };
      const latest = raw().prepare(QUALIFY_LATEST_INBOUND_SQL).get(id) ?? null;
      if (!latest) return { outcome: "changed" };
      // รีวิว 12 ต.ค. ค่ำ (p1-race): คำลาของเจ้าของถึงลูกค้าแล้ว แต่ลูกค้าพิมพ์แทรกระหว่างยิง push — เดิมคืน "changed"
      // = ลาแล้วห้องยังเขียว ลูกแพรตอบต่อท้ายคำลา และรอบตรวจเสนอห้องซ้ำได้ (คำลาสองครั้ง)
      // anchorSeen = ปิดเทียบข้อความที่คนตรวจเห็น (lastInboundId + hold = ข้อความนั้น) — ข้อความใหม่จึงถูกตัดสินตามปกติ:
      // เทิร์นที่รอคิวของห้องเจอห้องเหลือง → เปิดคืนเร็ว (สัญญาณซื้อ/ด่วน) หรือปักกุญแจให้ตัวกวาดตรวจภายในไม่กี่นาที
      let anchor = latest;
      if (inboundId && String(latest.id) !== String(inboundId)) {
        if (!ownerName || owner.anchorSeen !== true) return { outcome: "changed" };
        anchor = raw().prepare(OWNER_SEEN_INBOUND_SQL).get(String(inboundId), id) ?? null;
        if (!anchor) return { outcome: "changed" };
      }
      const block = blockReason(id, db.getCustomer(id), category);
      if (block) return { outcome: `blocked:${block}` };
      const t = Number(now());
      if (raw().prepare(QUALIFY_CAS_OFF_SQL).run(NOT_QUALIFIED_REASON, id).changes !== 1) return { outcome: "cas_lost" };
      const silent = Boolean(ownerName) && owner.silent === true;
      const reason = silent ? `${STATE_REASON[category].split(" — ")[0]} — ปิดเงียบตามที่ทีมยืนยัน (ไม่ส่งคำลา)` : STATE_REASON[category];
      audit(AUDIT_AI_OFF_NOT_QUALIFIED, id, `offtopic:${category} · ${reason}`);
      db.setSetting(qualifyStateKey(id), JSON.stringify({
        verdict: "not_qualified", confidence: CLOSE_CONFIDENCE, category: SWEEP_CATEGORY[category],
        reason, evidenceIds: [String(anchor.id)], lastInboundId: String(anchor.id),
        at: t, mode: "on", offAt: t, offtopic: category,
        ...(ownerName ? { confirmedBy: ownerName, ...(silent ? { silent: true } : {}) } : {}),
      }));
      // ข้อความที่ตอบไปแล้วถูกยืนยัน — คิวรอตอบซ่อนห้องจนกว่าลูกค้าจะทักใหม่ (กติกาเดียวกับตัวกวาด)
      db.setSetting(qualifyHoldKey(id), String(Number(anchor.created_at) || t));
      const newer = anchor !== latest;
      audit(AUDIT_OFFTOPIC_CLOSE, id, [category, plan.cue && plan.cue !== category ? `cue:${plan.cue}` : "",
        ownerName ? `owner:${ownerName}${silent ? " · silent" : ""}` : "", newer ? "newer_inbound" : "", plan.reason || ""]
        .filter(Boolean).join(" · "));
      logger.info?.(`offtopic_close ${JSON.stringify({ customerId: id, category })}`);
      return newer ? { outcome: "yellow", newerInbound: true } : { outcome: "yellow" };
    } catch (err) {
      logger.error?.(`offtopic-close: ปิดห้องไม่สำเร็จ (${err?.message || err})`);
      return { outcome: "error" };
    }
  }

  // cueOf = ตัวพักของการเปิดคืนเร็ว (ห้องที่ตีจบแล้ว) — ข้อความที่ยังมีคำนอกเรื่อง (ดอกที่ 1 ตัวเดียวกัน) พักไว้ให้ตัวกวาด
  return {
    assess, judge, applyClose, blockReason, recentlyKept, rememberKept,
    cueOf: detectOfftopicCue, fallbackText: offtopicFallbackText, textOk: offtopicCloseTextOk,
  };
}
