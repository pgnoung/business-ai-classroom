// qualifySweepRules.mjs — กติกาแบบ pure ของตัวกวาดคัดกรอง "ไม่เข้าเกณฑ์" (คำสั่งพี่ง้วง 5 ต.ค. 2026)
//
// แยกจาก qualifySweep.mjs ให้ไฟล์ไม่เกิน 800 บรรทัด (รีวิวปรปักษ์ 5 ต.ค. เพิ่มด่านหลายข้อ) — qualifySweep.mjs re-export ทุกตัว
// ผู้เรียกภายนอก import จาก qualifySweep.mjs ได้เหมือนเดิม · ไฟล์นี้ห้าม import qualifySweep.mjs (กันวงกลม)
//   · เวลารอบทุกต้นชั่วโมง 00:00–23:00 (เวลาไทยบนเครื่อง UTC) · ข้อความค้างเก่าเกิน 60 นาทีไม่ตอบย้อนหลัง
//   · ด่านปิดเหลือง/เปิดเขียว + เกณฑ์คำตัดสิน + SQL compare-and-set ชุดเดียวที่ทุกเส้นใช้
//   · releaseAllNotQualified: คืนห้องเหลืองทั้งหมด (สวิตช์ไม่ใช่ on / runbook / rollback)
//   · readQualifySweepModeStrict: อ่านสวิตช์แยก "ไม่มีแถว/ค่าแปลก" (= off) ออกจาก "อ่านพัง" (= ข้ามนาทีนี้)
import { activeBrand, isGenericProfile } from "./brand.mjs";
import { latestSlotMs, parseDigestTimes } from "./digest.mjs";
import { canAutoEnableAi, legacyIdentityPending } from "./aiPausePolicy.mjs";
import { isAdGreetingEcho } from "./fbAdGreeting.mjs";
import { NON_HUMAN_NOTE_AUTHORS_SQL } from "./lineOaContext.mjs";
import { paymentStartedFromRow } from "./pipeline.mjs";
import { QUALIFY_ANSWER_SKIPPED_FIELD, yellowOffAtFor } from "./qualifyFastReclaim.mjs";
import { isBankInfoConversation } from "./salesDecisionGuard.mjs";
import {
  AUDIT_AI_ON_QUALIFIED, NOT_QUALIFIED_REASON, QUALIFY_AUDIT_OPERATOR, QUALIFY_HUMAN_RECENT_MS,
  QUALIFY_SWEEP_MODES, QUALIFY_SWEEP_MODE_KEY,
  isNotQualifiedRow, qualifyHoldKey, qualifyRecheckKey, qualifyStateKey, readJsonSetting,
} from "./notQualified.mjs";

// เวลารอบของตัวกวาด: ทุกต้นชั่วโมงตลอด 24 ชม. เวลาไทย (พี่ง้วง 8 พ.ย. 2026 "การคัดกรองแชท ให้ทำทุก 1 ชั่วโมง เลยครับ")
// เดิม 09:00…20:00 (12 รอบ) — ห้องที่ทักกลางคืนรอถึงเก้าโมง · จ่ายเฉพาะห้องที่มีข้อความลูกค้าใหม่ รอบเพิ่มจึงไม่จ่ายห้องเดิมซ้ำ
export const QUALIFY_SWEEP_TIMES = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`).join(",");
// ห้องที่ทักหลังรอบสุดท้ายของเมื่อวาน (เช่น 23:40) ต้องยังอยู่ในรอบ 00:00 — มองย้อนอย่างน้อย 2 ชม. ข้ามเที่ยงคืนได้
export const QUALIFY_LOOKBACK_MS = 2 * 3_600_000;
// เครื่องล่ม/deploy ข้ามรอบไปเกิน 30 นาที = ข้ามรอบนั้น (แบบ hotFollowupPush) — รอบถัดไปเก็บห้องเดิมได้อยู่แล้ว
export const QUALIFY_SWEEP_MAX_LATE_MS = 30 * 60_000;
export const QUALIFY_YELLOW_MIN_CONFIDENCE = 0.8;
export const QUALIFY_GREEN_MIN_CONFIDENCE = 0.6;
// last_score ตั้งแต่ 7 = ห้องที่ผู้ให้คะแนนเห็นความสนใจแล้ว ไม่ปิดเหลืองเด็ดขาด (ด่านกลาง ใช้ร่วมกับตัวตีจบนอกเรื่อง)
export const QUALIFY_HOT_SCORE = 7;
// พี่ง้วง 8 พ.ย. 2026: ตัวกวาดคัดกรองปิดเหลืองเฉพาะห้องที่ "scoring ต่ำ" = 0–5 (เริ่มที่ 0–4 ตามแถบ score-low ของคอนโซล
// แล้วพี่ง้วงสั่ง "นับ 5 ด้วยครับ" วันเดียวกัน — replay พบห้องว่างงาน/ไม่มีงบคะแนน 5 สี่ห้องที่ 0–4 ไม่ปิด)
// ยังไม่เคยให้คะแนน (null) = ไม่รู้ว่าต่ำ = ไม่ปิด · ใช้กับตัวกวาดคัดกรองเท่านั้น (sweepYellowBlockReason)
// ตัวตีจบนอกเรื่อง/ห้องตรวจของเจ้าของใช้ yellowBlockReason ตัวกลางเหมือนเดิม (ลวนลาม/สแปมไม่ต้องรอคะแนนต่ำ)
export const QUALIFY_LOW_SCORE_MAX = 5;

/** ต้นช่วงที่ตัวกวาดมองห้อง: ต้นวันเวลาไทย หรือย้อน 2 ชม. ถ้าเพิ่งพ้นเที่ยงคืน (pure) */
export function qualifyWindowStartMs(nowMs, dayStartMs) {
  return Math.min(Number(dayStartMs), Number(nowMs) - QUALIFY_LOOKBACK_MS);
}
// รีวิวปรปักษ์รอบ 2 5 ต.ค. (#10 regression): เดิมกันตอบข้อความค้างนอก 08:00–21:00 ทุกกรณี — ผู้ซื้อที่พิมพ์ตอนสี่ทุ่ม
// แล้วตรวจเขียวผ่านตอนสี่ทุ่มห้านาทีไม่ได้คำตอบเลย และเทิร์นถัดไปตอนเช้าโมเดลไม่เห็นข้อความที่พิมพ์ระหว่างเหลือง
// ตอนนี้ตัดสินจาก "อายุ" ของข้อความค้างแทนเวลานาฬิกา: ใหม่ = ตอบทันทีทุกชั่วโมงเหมือนห้องเขียวปกติ
// เก่าเกิน 60 นาที (เช่น 14:20 ชนเพดานแล้วพ้นเพดานตอนเที่ยงคืน) = ไม่ตอบย้อนหลัง ห้องขึ้นคิวรอตอบ + จด answerSkipped
export const QUALIFY_PENDING_STALE_MS = 60 * 60_000;
// เปิดเขียวได้เฉพาะสองสถานะนี้ (สถานะมีแค่ AI_ACTIVE / NEEDS_HUMAN / RESOLVED) — ไม่รู้จัก = กันไว้
const GREEN_STATES = new Set(["AI_ACTIVE", "RESOLVED"]);

const SLOT_MINUTES = parseDigestTimes(QUALIFY_SWEEP_TIMES);

/* ------------------------------- เวลารอบ (pure) ------------------------------- */

/** epoch ms ของรอบล่าสุดที่ถึงเวลาแล้ว (<= nowMs) — ต้นชั่วโมงปัจจุบันเวลาไทย */
export function qualifySlotMs(nowMs) {
  return latestSlotMs(Number(nowMs), SLOT_MINUTES);
}

/**
 * รอบนี้ต้องทำไหม: due = ยังไม่เคยจองรอบนี้ · late = เลยเวลามาเกิน 30 นาที (จองแล้วข้าม)
 * @returns {{slot: number|null, due: boolean, late: boolean}}
 */
export function qualifySlotState(nowMs, lastSlotMs = 0) {
  const slot = qualifySlotMs(nowMs);
  if (slot == null) return { slot: null, due: false, late: false };
  const due = slot > (Number(lastSlotMs) || 0);
  return { slot, due, late: due && Number(nowMs) - slot > QUALIFY_SWEEP_MAX_LATE_MS };
}

/** ด่านปิดเหลืองของตัวกวาดคัดกรอง = ด่านกลาง + คะแนนต้องต่ำ (0–5) (pure) */
export function sweepYellowBlockReason(row, facts = {}) {
  const block = yellowBlockReason(row, facts);
  if (block) return block;
  return row?.last_score != null && Number(row.last_score) <= QUALIFY_LOW_SCORE_MAX ? "" : "score_not_low";
}

/** ตอนนี้อยู่ในหน้าต่างของรอบกวาดไหม (ต้นชั่วโมงใดก็ได้เวลาไทย ถึง +30 นาที) — ให้ integrator เทสต์การผูกได้ */
export function inQualifySweepSlot(nowMs) {
  const slot = qualifySlotMs(nowMs);
  return slot != null && Number(nowMs) - slot >= 0 && Number(nowMs) - slot <= QUALIFY_SWEEP_MAX_LATE_MS;
}

/** ข้อความลูกค้าที่ค้างอยู่เก่าเกินกว่าจะตอบย้อนหลังไหม (เวลาไม่รู้ = เก่า — ไม่ส่งข้อความโดยไม่รู้บริบท) */
export function qualifyPendingIsStale(lastInboundAt, nowMs) {
  const at = Number(lastInboundAt) || 0;
  return !(at > 0) || (Number(nowMs) || 0) - at > QUALIFY_PENDING_STALE_MS;
}

/* ------------------------------- สวิตช์ (อ่านแบบเข้ม) ------------------------------- */

/**
 * อ่าน qualify_sweep_mode แบบแยกเหตุ (รีวิวปรปักษ์รอบ 2 5 ต.ค.): qualifySweepMode() เดิมแปลงทุกความผิดพลาดเป็น off
 * แล้วตัวกวาดคืนห้องเหลืองทุกห้องในนาทีนั้น — SQLITE_BUSY ครั้งเดียวกลายเป็นการสลับสถานะยกห้องที่ไม่มีคนสั่ง
 * @returns {"off"|"shadow"|"on"|null} null = อ่านพัง (ผู้เรียกต้องข้ามนาทีนี้ทั้งหมด) · ไม่มีแถว/ค่าแปลก = "off" (คืนห้องถูกต้อง)
 */
export function readQualifySweepModeStrict(db) {
  // White-label: โปรไฟล์ generic ไม่มีตัวกวาดคัดกรอง (พรอมต์เฉพาะคอร์ส) — "off" = คืนห้องเหลืองตามปกติ
  if (isGenericProfile(activeBrand())) return "off";
  if (typeof db?.getSetting !== "function") return "off";
  let value;
  try {
    value = db.getSetting(QUALIFY_SWEEP_MODE_KEY);
  } catch {
    return null;
  }
  return QUALIFY_SWEEP_MODES.includes(value) ? value : "off";
}

/* ------------------------------ ข้อเท็จจริงของห้อง (DB) ------------------------------ */

/** โน้ตส่งต่อล่าสุดที่คนเขียนเอง (ไม่นับโน้ตของระบบ) — 0 = ไม่มี */
export function lastHumanNoteAtFor(db, customerId) {
  return Number(db.raw.prepare(`SELECT MAX(created_at) AS at FROM handoff_notes
    WHERE customer_id = ? AND author NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})`).get(String(customerId))?.at) || 0;
}

// รีวิวปรปักษ์รอบ 3 5 ต.ค.: เดิมใช้ db.lastOperatorOutboundAt ซึ่งนับแถวบรอดแคสต์ด้วย — broadcast.mjs/broadcastSchedule/
// broadcastStudio เขียนแถว out ต่อผู้รับหนึ่งแถว (operator = ชื่อทีมที่กดส่ง · message_class 'proactive') ผลคือบรอดแคสต์
// ครั้งเดียวทำให้ห้องเหลืองทุกห้องที่ได้รับ "ถูกคนรับไปแล้ว": โมเดลเปิดเขียวไม่ได้ สวิตช์ off/shadow และ rollback ก็คืนไม่ได้
// และห้องเขียวที่ได้รับปิดเหลืองไม่ได้ 7 วัน · บรอดแคสต์ไม่ใช่การตัดสินห้องนี้ของคน จึงนับเฉพาะคำตอบ reactive ของทีม
// (คำตอบจากคอนโซล consoleApi และจาก Business Suite เป็น reactive — คนรับห้องจริงยังกันเหมือนเดิม)
const STAFF_REPLY_FILTER = `customer_id = ? AND direction = 'out' AND operator <> '' AND operator <> 'system'
    AND COALESCE(message_class, 'reactive') != 'proactive'`;
const LAST_STAFF_REPLY_SQL = `SELECT MAX(created_at) AS at FROM messages WHERE ${STAFF_REPLY_FILTER}`;
const STAFF_REPLIES_NEWEST_FIRST_SQL = `SELECT created_at, content FROM messages WHERE ${STAFF_REPLY_FILTER}
  ORDER BY created_at DESC, rowid DESC`;

/** คำตอบ reactive ล่าสุดที่ทีมพิมพ์เอง (ไม่นับลูกแพร/ระบบ/บรอดแคสต์/ข้อความทักตาม) — 0 = ไม่มี */
export function lastStaffReplyAtFor(db, customerId) {
  return Number(db.raw.prepare(LAST_STAFF_REPLY_SQL).get(String(customerId))?.at) || 0;
}

/**
 * 8 พ.ย. 2026 (พี่ง้วง "ให้ตรวจด้วย"): เฉพาะตัวคัดกรอง — ข้อความทักของแอด Facebook ถูกเก็บเป็นแถวของทีม แต่ไม่ใช่คนรับห้อง
 * ใช้กฎชุดเดียวกับตอนรับ echo โดยดูเฉพาะแถวก่อนหน้า (ลบ 1 ms ไม่ให้เจอตัวเอง) · ตัวปิดแชทนอกเรื่องยังใช้ lastStaffReplyAtFor
 */
export function lastStaffReplyIgnoringAdGreetingAt(db, customerId) {
  const id = String(customerId);
  for (const row of db.raw.prepare(STAFF_REPLIES_NEWEST_FIRST_SQL).iterate(id)) {
    const at = Number(row.created_at) || 0;
    if (!isAdGreetingEcho(db, id, row.content, at - 1)) return at;
  }
  return 0;
}

/**
 * คนตอบ/เขียนโน้ตหลังห้องเป็นเหลืองไหม = คนรับห้องไปแล้ว · ไม่รู้เวลาปิด (0) = คนเคยตอบเมื่อไหร่ก็ถือว่ารับแล้ว (ด้านปลอดภัย)
 * ใช้ทั้งด่านเปิดเขียว (greenFacts) และการคืนห้องทั้งหมด — ชุดเดียวกัน (รีวิวปรปักษ์รอบ 2 5 ต.ค.) · บรอดแคสต์ไม่นับ (รอบ 3)
 */
export function humanSinceOffFor(db, customerId, offAt) {
  const since = Number(offAt) || 0;
  return lastStaffReplyIgnoringAdGreetingAt(db, customerId) > since || lastHumanNoteAtFor(db, customerId) > since;
}

// ข้อความลูกค้าล่าสุดยังไม่มีคำตอบ reactive (บรอดแคสต์/ข้อความทักตามที่ตามหลังมาไม่นับว่าตอบ — กติกาเดียวกับคิวรอตอบ)
// รีวิวปรปักษ์รอบ 3 5 ต.ค.: เดิมดู direction ของแถวล่าสุด — บรอดแคสต์หลังคำถามของผู้ซื้อทำให้ข้อความค้างดูเหมือนตอบแล้ว
const UNANSWERED_SQL = `SELECT
    (SELECT MAX(created_at) FROM messages WHERE customer_id = ? AND direction = 'in') AS last_in,
    (SELECT MAX(created_at) FROM messages WHERE customer_id = ? AND direction = 'out'
       AND COALESCE(message_class, 'reactive') != 'proactive') AS last_reply`;

/** ข้อความลูกค้าล่าสุดของห้องนี้ยังไม่มีใครตอบไหม (ไม่มีข้อความลูกค้า = ไม่ค้าง) */
export function inboundUnansweredFor(db, customerId) {
  const id = String(customerId);
  const at = db.raw.prepare(UNANSWERED_SQL).get(id, id);
  const lastIn = Number(at?.last_in) || 0;
  return lastIn > 0 && lastIn > (Number(at?.last_reply) || 0);
}

/* -------------------------------- ด่าน (pure) -------------------------------- */

// คนแตะห้องภายใน 7 วัน (เวลาในอนาคต = นาฬิกาเพี้ยน ถือว่าเพิ่งแตะ — ด้านปลอดภัย)
function humanRecent(at, nowMs) {
  const value = Number(at) || 0;
  return value > 0 && (Number(nowMs) || 0) - value < QUALIFY_HUMAN_RECENT_MS;
}

/**
 * เหตุที่ห้ามปิดเหลือง ("" = ผ่าน) — ต้องผ่านทุกข้อ ทั้งก่อนเรียกโมเดลและตอนเขียนในคิว
 * facts: { nowMs, salesDecisionGuardEnabled, silenced, released, humanOutboundAt, humanNoteAt, humanOnAt, burstPending, unanswered }
 */
export function yellowBlockReason(row, facts = {}) {
  if (!row) return "no_row";
  if (String(row.line_user_id ?? "").startsWith("canary:")) return "canary";
  if (Number(row.ai_enabled) !== 1) return "ai_off";
  if (String(row.state ?? "") !== "AI_ACTIVE") return "state";
  if (String(row.human_owner ?? "").trim()) return "human_owner";
  if ((Number(row.operator_active_until) || 0) > (Number(facts.nowMs) || 0)) return "operator_active";
  if (Number(row.do_not_disturb) === 1) return "do_not_disturb";
  if (String(row.lifecycle_stage ?? "sales") !== "sales") return "lifecycle";
  if (paymentStartedFromRow(row)) return "money";
  if (facts.salesDecisionGuardEnabled && isBankInfoConversation(row)) return "bank_info";
  if (row.last_score != null && Number(row.last_score) >= QUALIFY_HOT_SCORE) return "score";
  // ห้องที่ชื่อตรงลูกค้าระบบเก่าแต่ยังไม่ยืนยัน = อาจเป็นลูกค้าที่เคยซื้อแล้ว ห้ามเหลือง (เพิ่มจากแบบแปลน — ด้านปลอดภัย)
  if (legacyIdentityPending(row)) return "legacy_pending";
  if (facts.silenced !== false) return "silenced_tag"; // อ่านป้ายไม่ได้ = ถือว่าเงียบ (fail closed)
  if (facts.released) return "released";
  // รีวิวปรปักษ์ 5 ต.ค. #5: เดิมนับแค่คนตอบ "วันนี้" — คนคุยใน LINE OA app/โทรแล้วเขียนโน้ต หรือกดเปิด AI คืน (เหตุอื่น
  // ที่ไม่ใช่เหลือง) ไม่ทิ้งหมุดไว้ ตัวกวาดเลยปิดห้องที่คนเพิ่งส่งคืนให้ AI · คนแตะห้องภายใน 7 วัน = คนตัดสินแล้ว
  if (humanRecent(facts.humanOutboundAt, facts.nowMs)) return "human_outbound";
  if (humanRecent(facts.humanNoteAt, facts.nowMs)) return "human_note";
  if (humanRecent(facts.humanOnAt, facts.nowMs)) return "human_on";
  if ((Number(facts.burstPending) || 0) > 0) return "burst_pending";
  // รีวิวปรปักษ์ 5 ต.ค. #11: ข้อความลูกค้าล่าสุดยังไม่มีใครตอบ (อายุเท่าไหร่ก็ตาม — คำตอบที่ระบบติดค้างเอง เช่น AI พัก
  // ทั้งระบบ) = ห้ามปิดทับ ไม่งั้นห้องหลุดจากคิวรอตอบที่เป็นตาข่ายรองรับคำตอบที่ล้ม
  if (facts.unanswered) return "unanswered";
  return "";
}

/**
 * เหตุที่ห้ามเปิดเขียว ("" = ผ่าน) — เปิดได้เฉพาะห้องเหลืองของเราเอง และยังไม่มีเงิน/คน/ป้ายเข้ามาเกี่ยว
 * facts: { nowMs, silenced, humanSinceOff, lastInboundAt }
 */
export function greenBlockReason(row, facts = {}) {
  if (!isNotQualifiedRow(row)) return "not_yellow";
  if (!canAutoEnableAi(row, { expectReason: NOT_QUALIFIED_REASON })) return "not_ours";
  if (String(row.line_user_id ?? "").startsWith("canary:")) return "canary";
  // สลิป/ไฟล์ในห้องเหลืองตั้ง NEEDS_HUMAN โดยไม่เปลี่ยนเหตุ — ห้ามเปิด AI ทับห้องที่รอคนตรวจ
  // รีวิวปรปักษ์ 5 ต.ค. #20: เดิมกันทุกสถานะที่ไม่ใช่ AI_ACTIVE — ห้องที่ทีมกดเสร็จสิ้นแล้วลูกค้าทักกลับมาติดเหลืองตลอดไป
  // ตอนนี้ RESOLVED เปิดได้เมื่อมีข้อความลูกค้าหลังกดเสร็จสิ้น (resolved_at = 0 คือห้องเก่าที่หาเวลาปิดไม่เจอ = ยังปิดอยู่)
  const state = String(row.state ?? "");
  if (!GREEN_STATES.has(state)) return "state";
  if (state === "RESOLVED") {
    const resolvedAt = Number(row.resolved_at) || 0;
    if (!(resolvedAt > 0 && (Number(facts.lastInboundAt) || 0) > resolvedAt)) return "resolved";
  }
  if (String(row.human_owner ?? "").trim()) return "human_owner";
  if ((Number(row.operator_active_until) || 0) > (Number(facts.nowMs) || 0)) return "operator_active";
  if (Number(row.do_not_disturb) === 1) return "do_not_disturb";
  if (paymentStartedFromRow(row)) return "money";
  if (facts.silenced !== false) return "silenced_tag";
  // คนตอบ/เขียนโน้ตหลังห้องเป็นเหลือง = คนรับห้องไปแล้ว (คอนโซลหรือ Business Suite) — คนกดเปิดเองได้ ระบบไม่เปิดทับ
  if (facts.humanSinceOff) return "human_since_off";
  return "";
}

/** ผลที่พอจะปิดเหลือง: not_qualified · มั่นใจ ≥ 0.8 · มีหลักฐานและทุกรหัสเป็นข้อความที่ลูกค้าห้องนี้พิมพ์เอง */
export function verdictAllowsYellow(verdict) {
  return Boolean(verdict) && verdict.verdict === "not_qualified"
    && verdict.confidence >= QUALIFY_YELLOW_MIN_CONFIDENCE && verdict.evidenceValid === true;
}

/** ผลที่พอจะเปิดเขียว: potential · มั่นใจ ≥ 0.6 */
export function verdictAllowsGreen(verdict) {
  return Boolean(verdict) && verdict.verdict === "potential" && verdict.confidence >= QUALIFY_GREEN_MIN_CONFIDENCE;
}

/** รายละเอียด audit: หมวด + ความมั่นใจ + เหตุสั้น (ไม่มีคำพูดลูกค้า — parser ล้างแล้ว) */
export function qualifyAuditDetail(verdict) {
  const confidence = Number(verdict?.confidence);
  return [String(verdict?.category || "-"), Number.isFinite(confidence) ? confidence.toFixed(2) : "-", String(verdict?.reason || "")]
    .filter(Boolean).join(" · ").slice(0, 500);
}

/**
 * คำตัดสินของห้องนี้ยังใช้ได้ในโหมดนี้ไหม (pure) — ใช้ได้ = ข้อความเดิมไม่ต้องตัดสินซ้ำ
 * รีวิวปรปักษ์ 5 ต.ค. #3 #8 #16: คำตัดสินตอน shadow / ตอนคืนห้อง (release) ไม่นับในโหมด on — เดิมสลับ shadow → on
 * แล้วห้องเดิมไม่ถูกตัดสินจนกว่าลูกค้าจะพิมพ์ใหม่ · สถานะ fast ยังนับ: ไปป์ไลน์เพิ่งเห็นสัญญาณซื้อ/ความปลอดภัยของข้อความนี้เอง
 * ตัดสินข้อความเดียวกันซ้ำเพื่อปิดเหลืองขัดกับสัญญาณนั้น
 */
export function qualifyStateCountsFor(prior, mode) {
  if (mode !== "on") return true;
  return prior?.mode === "on" || prior?.mode === "fast";
}

export const QUALIFY_CAS_OFF_SQL = `UPDATE customers SET ai_enabled = 0, ai_off_reason = ?
  WHERE line_user_id = ? AND ai_enabled = 1 AND state = 'AI_ACTIVE' AND money_seen_at = 0`;
// รีวิวปรปักษ์ 5 ต.ค. #20: เปิดเขียวได้ทั้ง AI_ACTIVE และ RESOLVED — NEEDS_HUMAN (รอคนตรวจ) ห้ามเปิดทับ
export const QUALIFY_CAS_ON_SQL = `UPDATE customers SET ai_enabled = 1, ai_off_reason = ''
  WHERE line_user_id = ? AND ai_enabled = 0 AND ai_off_reason = ? AND state IN ('AI_ACTIVE', 'RESOLVED') AND money_seen_at = 0`;
export const QUALIFY_LATEST_INBOUND_SQL = `SELECT id, created_at FROM messages WHERE customer_id = ? AND direction = 'in'
  ORDER BY created_at DESC, rowid DESC LIMIT 1`;

/**
 * สถานะเขียวที่ "ยังไม่ได้ตอบข้อความค้าง" (รีวิวปรปักษ์รอบ 2 5 ต.ค. — สัญญากับไปป์ไลน์ qualifyFastReclaim.heldAfterSkippedGreen):
 *   answerSkipped: true · offAt: เวลาที่ห้องถูกปิดเหลือง (ms — ไม่รู้ = ไม่ใส่ yellowOffAtFor ตกไปอ่าน audit เอง)
 * เทิร์นตอบแรกของห้องที่ไม่เหลืองแล้วรวมข้อความที่ลูกค้าพิมพ์ระหว่างเหลือง (collectYellowHeldParts ตั้งแต่ offAt) แล้วลบธง
 * — ไม่งั้นโมเดลเห็นแค่ข้อความล่าสุด (ปัญหาเดียวกับ #9) · ห้องกลับเป็นเหลืองใหม่ = สถานะถูกเขียนทับ ธงหายเอง
 */
export function answerSkippedExtra(offAt) {
  const at = Number(offAt) || 0;
  return { [QUALIFY_ANSWER_SKIPPED_FIELD]: true, ...(at > 0 ? { offAt: at } : {}) };
}

/**
 * เหตุที่ห้องเหลืองห้องนี้คืนเป็นเขียวเองไม่ได้ตอนคืนทั้งหมด ("" = คืนได้)
 * รีวิวปรปักษ์รอบ 2 5 ต.ค.: เดิมเช็คแค่ CAS (สถานะ + money_seen_at) — ห้องที่ทีมตอบ/เขียนโน้ตหลังเหลือง ตั้ง human_owner
 * หรือเริ่มขั้นจ่ายเงิน (deal_status/handoff) ถูกเปิด AI ทับทันทีที่สลับ off/shadow ทั้งที่โหมด on กันไว้
 * ด่านคน/เงินชุดเดียวกับ greenBlockReason (ด่านชั่วคราวอย่าง operator_active ไม่นับ: ห้องคืนได้เมื่อพ้นช่วงอยู่แล้ว)
 * @returns {""|"needs_human"|"state"|"money"|"human_owner"|"human_since_off"}
 */
export function releaseKeepReason(db, row, offAt = yellowOffAtFor(db, row?.line_user_id)) {
  const state = String(row?.state ?? "");
  if (state === "NEEDS_HUMAN") return "needs_human";
  if (!GREEN_STATES.has(state)) return "state";
  if (paymentStartedFromRow(row)) return "money"; // รวม money_seen_at > 0 ที่ CAS กันอยู่แล้ว
  if (String(row.human_owner ?? "").trim()) return "human_owner";
  if (humanSinceOffFor(db, String(row.line_user_id ?? ""), offAt)) return "human_since_off";
  return "";
}

function releaseOneRoom({ db, raw, row, t, tag, logger }) {
  const customerId = String(row.line_user_id);
  raw.prepare("DELETE FROM settings WHERE key = ?").run(qualifyHoldKey(customerId)); // คืนได้หรือไม่ได้ ต้องขึ้นคิวให้คนเห็น
  const offAt = yellowOffAtFor(db, customerId);
  if (releaseKeepReason(db, row, offAt)) return "kept"; // คงเหลืองให้คนดูแล — hold ลบแล้ว ห้องอยู่ในคิวรอตอบ
  if (raw.prepare(QUALIFY_CAS_ON_SQL).run(customerId, NOT_QUALIFIED_REASON).changes !== 1) return "cas_lost";
  raw.prepare("DELETE FROM settings WHERE key = ?").run(qualifyRecheckKey(customerId));
  const latest = raw.prepare(QUALIFY_LATEST_INBOUND_SQL).get(customerId);
  // รีวิวปรปักษ์รอบ 3 5 ต.ค.: บรอดแคสต์ที่ตามหลังข้อความลูกค้าไม่ใช่คำตอบ — ยังจด answerSkipped ให้เทิร์นถัดไปเห็นข้อความค้าง
  const pending = inboundUnansweredFor(db, customerId);
  db.setSetting(qualifyStateKey(customerId), JSON.stringify({
    verdict: "unclear", confidence: 0, category: "insufficient", reason: "", evidenceIds: [],
    lastInboundId: String(latest?.id || ""), at: t, mode: "release", release: tag,
    ...(pending ? answerSkippedExtra(offAt) : {}),
  }));
  try {
    db.addAudit({ operator: QUALIFY_AUDIT_OPERATOR, action: AUDIT_AI_ON_QUALIFIED, target: customerId, detail: `release:${tag}` });
  } catch (err) {
    logger.warn?.(`qualify-sweep: บันทึก audit ไม่สำเร็จ (${err?.message || err})`);
  }
  return pending ? "released_pending" : "released";
}

/**
 * คืนห้องเหลืองทุกห้องเป็นเขียวทันที ไม่เรียกโมเดล (รีวิวปรปักษ์ 5 ต.ค. #4 #8 #16)
 * ตัวกวาดเรียกทุกนาทีเมื่อสวิตช์ไม่ใช่ on · runbook/rollback เรียกเองก่อนสลับกลับ release ที่ไม่รู้จัก not_qualified
 * (release เก่าไม่มีทางเปิดห้องเหลืองคืนเอง — ห้องจะเงียบตลอดไป)
 *   · ด่านคน/เงิน (releaseKeepReason) + CAS เดียวกับเปิดเขียว: ห้องที่ไม่ผ่านคงเหลืองไว้ให้คน แต่ลบ qualify_hold
 *     ทุกห้องให้ขึ้นคิวรอตอบ (รีวิวปรปักษ์รอบ 2 5 ต.ค.)
 *   · audit ทีละห้อง (ai_on_qualified · release:<reason>) + จดสถานะ mode "release" (โหมด on ตัดสินห้องนี้ใหม่ได้)
 *   · ไม่ตอบข้อความค้างเอง: ส่งรัวทีละหลายสิบห้องตอนสลับสวิตช์อันตรายกว่า — ห้องที่ยังไม่มีใครตอบขึ้นคิวรอตอบ
 *     และจด answerSkipped ให้เทิร์นถัดไปของลูกค้าเห็นข้อความที่พิมพ์ระหว่างเหลืองครบ
 * @param {{db: object, now?: (() => number)|number, reason?: string, logger?: object}} input
 * @returns {number} จำนวนห้องที่เปิดคืน
 */
export function releaseAllNotQualified({ db, now = Date.now, reason = "manual", logger = console } = {}) {
  const raw = db?.raw;
  if (!raw) return 0;
  const t = typeof now === "function" ? Number(now()) : Number(now) || Date.now();
  const tag = String(reason || "manual").replace(/[^\w:-]/gu, "_").slice(0, 60) || "manual";
  let rows = [];
  try {
    rows = raw.prepare("SELECT * FROM customers WHERE ai_enabled = 0 AND ai_off_reason = ?").all(NOT_QUALIFIED_REASON);
  } catch (err) {
    logger.error?.(`qualify-sweep: อ่านห้องเหลืองไม่สำเร็จ (${err?.message || err})`);
    return 0;
  }
  let released = 0;
  let pending = 0;
  for (const row of rows) {
    try {
      const outcome = releaseOneRoom({ db, raw, row, t, tag, logger });
      if (outcome.startsWith("released")) released += 1;
      if (outcome === "released_pending") pending += 1;
    } catch (err) {
      logger.error?.(`qualify-sweep: คืนห้องเหลืองไม่สำเร็จ (${err?.message || err})`);
    }
  }
  if (released > 0) {
    logger.log?.(`[qualify-sweep] คืนห้องเหลือง ${released} ห้องเป็นเขียว (release:${tag})`
      + (pending > 0 ? ` · ${pending} ห้องมีข้อความค้างที่ AI ไม่ตอบย้อนหลัง — ขึ้นคิวรอตอบให้ทีม` : ""));
  }
  return released;
}

// หลักฐานของคำตัดสินมีบรรทัดลูกค้าที่ใหม่กว่าจุดยืนยันครั้งก่อนไหม — ไม่รู้จุด (0) = ไม่นับ (ห้องขึ้นคิวให้คนดูไว้ก่อน)
export function evidenceNewerThan(verdict, rows, threshold) {
  if (!(threshold > 0)) return false;
  const createdAt = new Map(rows.map((row) => [String(row.id), Number(row.created_at) || 0]));
  return (verdict?.evidenceIds || []).some((id) => (createdAt.get(String(id)) || 0) > threshold);
}

/* ------------------------- คิวกุญแจตรวจซ้ำ (อ่านอย่างเดียว) ------------------------- */

const RECHECK_SCAN_LIMIT = 50; // ต่อหน้า
// รีวิวปรปักษ์รอบ 2 5 ต.ค. (#18 residual): กุญแจที่ถูกพัก (ถี่เกิน/รอลองใหม่/ลูกค้ายังพิมพ์) ค้างค่าเดิมอยู่หัวแถว —
// เดิมอ่านแค่ 50 แถวแรก 50 ห้องที่ถูกพักบังผู้ซื้อที่อยู่แถวที่ 51 ได้ถึง 15 นาที · อ่านต่อเป็นหน้า ๆ ถึง ~500 แถว
const RECHECK_SCAN_MAX_ROWS = 500;
export const QUALIFY_RECHECK_PREFIX = qualifyRecheckKey("");
// ช่วงคีย์ของ prefix บนดัชนี PK ของ settings (';' คือตัวถัดจาก ':') — ไม่ต้องใช้ LIKE ที่ '_' เป็น wildcard
const RECHECK_PREFIX_END = `${QUALIFY_RECHECK_PREFIX.slice(0, -1)};`;
const RECHECK_HEAD_SQL = "SELECT key, value FROM settings WHERE key >= ? AND key < ?";

// กุญแจตรวจซ้ำทีละหน้า เรียงเก่า → ใหม่ (keyset บน value, key — แถวที่ถูกลบ/ปักใหม่ระหว่างอ่านไม่ทำให้ข้ามหรือวน)
function recheckPage(raw, after) {
  const tail = "ORDER BY value, key LIMIT ?";
  if (!after) return raw.prepare(`${RECHECK_HEAD_SQL} ${tail}`).all(QUALIFY_RECHECK_PREFIX, RECHECK_PREFIX_END, RECHECK_SCAN_LIMIT);
  return raw.prepare(`${RECHECK_HEAD_SQL} AND (value > ? OR (value = ? AND key > ?)) ${tail}`)
    .all(QUALIFY_RECHECK_PREFIX, RECHECK_PREFIX_END, after.value, after.value, after.key, RECHECK_SCAN_LIMIT);
}

/**
 * จัดลำดับกุญแจตรวจซ้ำ (pure — รีวิวปรปักษ์รอบ 3 5 ต.ค.): ห้องที่ยังไม่เคยถูกตรวจซ้ำตั้งแต่เป็นเหลืองขึ้นก่อน แล้วค่อยห้องที่
 * ตัดสินไปแล้ว · เดิมเรียงเก่า → ใหม่ล้วน ห้องที่ได้คำตัดสินแล้วพิมพ์ "ขอบคุณค่ะ" ซ้ำพ้นช่วงพัก 15 นาทีพร้อมกันหลายสิบห้อง
 * กินโควตา 5 ห้อง/นาทีก่อนผู้ซื้อใหม่ที่ไม่ใช้คำหลัก (60 ห้อง = ผู้ซื้อเงียบ 14 นาที) · ในแต่ละกลุ่มยังเรียงเก่า → ใหม่
 */
export function recheckFreshFirst(markers, isFresh) {
  const fresh = [];
  const judged = [];
  for (const marker of markers) (isFresh(marker) ? fresh : judged).push(marker);
  return [...fresh, ...judged];
}

/**
 * กุญแจตรวจซ้ำที่ต้องดูในนาทีนี้ (สูงสุด ~500 ดอก) เรียงห้องใหม่ก่อน — ห้องที่ "ตัดสินแล้ว" = สถานะล่าสุดมาจากการตรวจซ้ำ
 * (purpose green ที่ตัวกวาดจด) หรือเพิ่งได้คำตัดสินในหน่วยความจำ (recentlyChecked) · ห้องที่เพิ่งเป็นเหลืองยังไม่มี purpose
 */
export function readRecheckQueue(db, { recentlyChecked = () => false } = {}) {
  const markers = [];
  let after = null;
  while (markers.length < RECHECK_SCAN_MAX_ROWS) {
    const page = recheckPage(db.raw, after);
    markers.push(...page);
    if (page.length < RECHECK_SCAN_LIMIT) break;
    after = page.at(-1);
  }
  const isFresh = (marker) => {
    const customerId = String(marker.key).slice(QUALIFY_RECHECK_PREFIX.length);
    return !recentlyChecked(customerId) && readJsonSetting(db, qualifyStateKey(customerId))?.purpose !== "green";
  };
  return recheckFreshFirst(markers.slice(0, RECHECK_SCAN_MAX_ROWS), isFresh);
}
