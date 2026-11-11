// aiOffActor.mjs — "AI ปิด" เพราะใคร: คนกดเอง หรือระบบตัดสินเอง (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//
// เดิมทุกห้องที่ AI ปิดขึ้นสีแดงคำว่า "AI ปิด" เหมือนกันหมด พี่ง้วงบอกว่า "ยังไม่รู้ว่าปิดโดย AI
// หรือปิดโดยแอดมิน หรือคนจริง ๆ" — ห้องที่คนตั้งใจปิด (รับช่วงคุยเอง/ลูกค้าเก่า/สแปม) กับห้องที่
// ระบบปิดเพราะสัญญาณเสี่ยง (เส้นเงิน ขอคุยกับคน ร้องเรียน) ต้องการการกระทำคนละแบบ:
//   โดยคน  (สีม่วง CI ลูกแพร) = มีคนตัดสินแล้ว ห้องนี้เป็นของทีม
//   โดยระบบ (สีแดง)          = ระบบหยุดเองเพราะเหตุนี้ ต้องมีคนเข้าไปดู
//   ไม่ทราบ (สีเทา)          = ห้องเก่าที่ปิดก่อนระบบเริ่มจดเหตุ (2 ก.ย. 2026) — ไม่เดาว่าใครปิด
//
// ตัดสินจากเหตุที่บันทึกไว้ใน customers.ai_off_reason ซึ่งทุกเส้นทางเขียนไว้แล้ว:
//   manual            = สวิตช์ในคอนโซล/Telegram/แดชบอร์ด (aiSwitch.mjs · MANUAL_AI_OFF_REASON)
//   customer_handover = คนติดป้าย customer (ยกเว้นป้ายที่ระบบติดเองจากชื่อซ้ำห้องลูกค้าเก่า — ดูด้านล่าง)
//   not_a_customer    = คนติดป้าย null (= สแปม)
// เหตุอื่นทั้งหมด (booking_handoff, bank_sent, money_line, human_requested, complaint, file_review …)
// มาจากไปป์ไลน์/เกตอัตโนมัติ = "โดยระบบ" · ข้อความอธิบายเหตุใช้ชุดเดียวกับ Telegram (yoloText.mjs)
//
// 5 ต.ค. 2026 (คำสั่งพี่ง้วง "เพิ่มเป็น icon สีเหลือง ประมาณว่า AI off (not qualify)"): ห้องที่ตัวกวาดรายชั่วโมง
// ปิดเพราะคัดกรองแล้วยังไม่เข้าเกณฑ์ลูกค้า (ai_off_reason = not_qualified) เป็นกลุ่มที่สี่ — สีเหลือง by "qualify"
// ไม่ใช่แดง เพราะไม่ใช่สัญญาณเสี่ยงที่ต้องมีคนรีบเข้าไปดู และไม่ใช่ม่วงเพราะคนไม่ได้ตัดสิน
// (ห้ามใส่ใน AI_OFF_BY_HUMAN_REASONS — ตัวกวาดเปิดคืนเองได้ ส่วนห้องที่คนปิดตัวกวาดห้ามแตะ)
import { aiOffReasonText } from "./yoloText.mjs";
import {
  NOT_QUALIFIED_BY, NOT_QUALIFIED_LABEL, NOT_QUALIFIED_REASON, NOT_QUALIFIED_REASON_TEXT,
  isNotQualifiedRow, qualifyStateKey, readJsonSetting,
} from "./notQualified.mjs";
import { releaseKeepReason } from "./qualifySweepRules.mjs";

export const AI_OFF_BY_HUMAN_REASONS = Object.freeze(["manual", "customer_handover", "not_a_customer"]);
const HUMAN = new Set(AI_OFF_BY_HUMAN_REASONS);

export const AI_OFF_LABEL = Object.freeze({
  human: "AI ปิด · โดยคน",
  system: "AI ปิด · โดยระบบ",
  unknown: "AI ปิด",
  [NOT_QUALIFIED_BY]: NOT_QUALIFIED_LABEL,
});

// เหตุที่ตัวกวาดเขียนไว้ในคำตัดสินล่าสุด (qualifyStateKey) ยาวไม่เกินที่ prompt สั่ง (120 ตัว) — ตัดซ้ำที่นี่
// เผื่อแถวเก่า/แถวพัง ไม่ให้ tooltip กับแถบคิวยาวล้นจอมือถือ
const QUALIFY_REASON_MAX = 120;

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ห้องเหลืองที่รอทีม (state เช่น NEEDS_HUMAN — ไฟล์/รูป/เสียงรอตรวจ) เคยขึ้นคำอธิบายกลาง
// "เปิดคืนเองเมื่อเห็นศักยภาพ" ในคิวรอตอบ ทั้งที่ตัวกวาดเปิดห้องสถานะนี้ไม่ได้ (greenBlockReason = state) — ทีมจึงอ่านว่า
// ปล่อยไว้ได้ ทั้งที่ห้องนี้รอคนอยู่ · ห้องสถานะนี้บอกตรง ๆ ว่ารอทีม (ข้อความซื้อของลูกค้ายังเปิด AI ได้ทันทีทางลัด)
export const NOT_QUALIFIED_WAITING_TEAM_TEXT =
  "ห้องสีเหลืองที่รอทีมดู — ตัวกวาดไม่เปิด AI คืนเองจนกว่าทีมจะตรวจ (ลูกค้าถามราคา/สมัคร AI ตอบได้ทันที)";
// สถานะที่ตัวกวาดยังเปิดเขียวเองได้ (ตรงกับ GREEN_STATES ของ qualifySweepRules) — ไม่มีค่า = แถวเก่า/ข้อมูลไม่ครบ ถือเป็นปกติ
const QUALIFY_SELF_REOPEN_STATES = new Set(["", "AI_ACTIVE", "RESOLVED"]);

function qualifyWaitsForTeam(row) {
  return !QUALIFY_SELF_REOPEN_STATES.has(String(row?.state ?? "").trim());
}

/**
 * ห้องเหลืองที่ "มีแต่ทีมปลดได้" ไหม (รีวิวปรปักษ์รอบ 3 5 ต.ค.) — เดิมดูแค่ state: ห้องที่ทีมตอบ/เขียนโน้ตหลังเป็นเหลือง
 * (human_since_off) มีคนถือห้อง (human_owner) หรือเริ่มขั้นจ่ายเงิน (money) ตัวกวาดไม่เปิดเขียวเองและการคืนห้องทั้งหมด
 * ก็คงไว้ — แต่คิวรอตอบ/หัวห้องยังบอกทีมว่า "ตัวกวาดเปิดคืนเอง" ทีมจึงปล่อยห้องที่ไม่มีอะไรเปิดให้อีกเลย
 * ใช้ด่านชุดเดียวกับการคืนห้องทั้งหมด (releaseKeepReason: needs_human/state/money/human_owner/human_since_off)
 * อ่านแถวเต็มจาก DB (แถวของคิวรอตอบไม่มีทุกคอลัมน์ที่ด่านเงินอ่าน) · อ่านพัง = ถือว่ารอทีม (ด้านปลอดภัย: ทีมเข้าไปดู)
 */
export function notQualifiedTeamBlocked(db, row) {
  if (!isNotQualifiedRow(row)) return false;
  try {
    const full = db?.getCustomer?.(String(row.line_user_id ?? "")) ?? row;
    return Boolean(releaseKeepReason(db, full));
  } catch {
    return true;
  }
}

function qualifyReasonText(verdictReason) {
  const text = String(verdictReason ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return NOT_QUALIFIED_REASON_TEXT;
  return text.length > QUALIFY_REASON_MAX ? `${text.slice(0, QUALIFY_REASON_MAX - 1)}…` : text;
}

// เหตุที่ตารางคำแปลของ Telegram (yoloText.mjs) ยังไม่มี — ไม่อยากให้แถวคิวขึ้นรหัสดิบภาษาอังกฤษ
// (ไม่แก้ yoloText.mjs เพราะเป็นไฟล์ของงาน Telegram ที่กำลังแก้อยู่คู่ขนาน · รหัสมาจาก aiPausePolicy/legacyLink/
// facebookWebhook/pipeline JEV)
const EXTRA_REASON_TEXT = Object.freeze({
  customer_asked_quiet: "ลูกค้าบอกว่าไม่ต้องตอบแล้ว",
  legacy_candidate: "รอยืนยันห้องระบบเก่า (นโยบายเดิม)",
  legacy_ambiguous: "ชื่อซ้ำหลายห้องระบบเก่า รอคนเทียบ",
  fb_gate_pending: "Facebook รอตรวจว่าเป็นลูกค้าเก่าไหม",
  jev_review_stop: "ผู้ตรวจแนะนำให้คนรับช่วง",
});

function reasonTextOf(reason) {
  const known = aiOffReasonText(reason);
  return known !== reason ? known : (EXTRA_REASON_TEXT[reason] || reason);
}

// ป้าย customer ที่ legacyLink.mjs ติดให้เองเมื่อชื่อตรงห้องลูกค้าเก่าที่ลงทะเบียนแล้ว — เหตุเป็น
// customer_handover เหมือนคนติด แต่คนตัดสินคือระบบ (แถวต้องมีคอลัมน์ ai_off_system_tag จาก SQL)
const SYSTEM_CUSTOMER_TAG_TEXT = "ชื่อตรงห้องลูกค้าเก่าที่ลงทะเบียนแล้ว ระบบติดป้าย customer ให้";

/**
 * เหตุของคำตัดสินที่ทำให้ห้องเป็นสีเหลือง ("" = ไม่ใช่ห้องเหลือง/ไม่มีเหตุ → คำอธิบายกลาง)
 * อ่านเฉพาะห้องเหลือง (ห้องอื่นไม่แตะ settings) · ใช้เฉพาะคำตัดสิน not_qualified — คำตัดสินภายหลัง
 * (เช่น unclear ตอนตรวจซ้ำ) ไม่ใช่เหตุที่ปิดห้อง · เหตุถูกทำความสะอาดแล้วที่ qualifyPrompt (ไม่มีชื่อ/คำพูดลูกค้า)
 */
export function notQualifiedReasonFor(db, row) {
  if (!isNotQualifiedRow(row)) return "";
  const state = readJsonSetting(db, qualifyStateKey(String(row.line_user_id ?? "")));
  return state?.verdict === "not_qualified" && typeof state.reason === "string" ? state.reason : "";
}

/**
 * ข้อมูล "AI ปิดเพราะใคร" ของห้อง — null เมื่อ AI เปิดอยู่
 * @param {{ ai_enabled?: number, ai_off_reason?: string, ai_off_system_tag?: number, state?: string }} row แถว customers
 *   (state ใช้กับห้องเหลืองเท่านั้น: สถานะที่ตัวกวาดเปิดเองไม่ได้ = ข้อความ "รอทีมดู")
 * @param {{ qualifyReason?: string, teamBlocked?: boolean }} [options] qualifyReason = เหตุจากคำตัดสินล่าสุดของตัวกวาด
 *   (ไม่ส่ง = คำอธิบายกลาง) · teamBlocked = ผล notQualifiedTeamBlocked (true = ข้อความ "รอทีมดู" แทนเหตุของตัวกวาด)
 * @returns {{ by: "human"|"system"|"unknown"|"qualify", reason: string, label: string, reasonText: string } | null}
 */
export function aiOffInfo(row = {}, options = {}) {
  if (!row || Number(row.ai_enabled) === 1) return null;
  // options อ่านแบบกันพัง — ผู้เรียกบางที่อาจส่ง null หรือใช้กับ .map() (อาร์กิวเมนต์ที่สองเป็นเลขลำดับ)
  const qualifyReason = typeof options?.qualifyReason === "string" ? options.qualifyReason : "";
  const teamBlocked = options?.teamBlocked === true;
  const reason = String(row.ai_off_reason ?? "").trim();
  if (!reason) {
    return {
      by: "unknown", reason: "", label: AI_OFF_LABEL.unknown,
      reasonText: "ไม่มีบันทึกว่าใครปิด (ห้องที่ปิดก่อนระบบเริ่มจดเหตุ 2 ก.ย. 2026)",
    };
  }
  if (reason === NOT_QUALIFIED_REASON) {
    const waitsForTeam = teamBlocked || qualifyWaitsForTeam(row);
    const reasonText = waitsForTeam ? NOT_QUALIFIED_WAITING_TEAM_TEXT : qualifyReasonText(qualifyReason);
    return { by: NOT_QUALIFIED_BY, reason, label: NOT_QUALIFIED_LABEL, reasonText };
  }
  if (reason === "customer_handover" && Number(row.ai_off_system_tag) === 1) {
    return { by: "system", reason, label: AI_OFF_LABEL.system, reasonText: SYSTEM_CUSTOMER_TAG_TEXT };
  }
  const by = HUMAN.has(reason) ? "human" : "system";
  return { by, reason, label: AI_OFF_LABEL[by], reasonText: reasonTextOf(reason) };
}
