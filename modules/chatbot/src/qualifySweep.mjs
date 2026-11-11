// qualifySweep.mjs — ตัวกวาดคัดกรอง "ไม่เข้าเกณฑ์" รายชั่วโมง (คำสั่งพี่ง้วง 5 ต.ค. 2026)
//
// "ทุกชั่วโมง (เวลาทำการ) ให้มี AI อีกตัวคอยกวาดแชทของวันนั้น ว่าคนไหนไม่มีศักยภาพ ... ให้ปิด AI mode ของแชทนั้น
//  เป็นไอคอนสีเหลือง ... ถ้าเมื่อไหร่ sense ได้ว่าแชทนั้นมีศักยภาพขึ้นมา ให้กลับมาเปิดสีเขียวเหมือนเดิม
//  ระบบนี้ reverse ไปมาระหว่างการปิดจากสีเหลืองและไปสีเขียวเท่านั้น ไม่นับการปิดกรณีอื่น ๆ"
//
// กติกาเหล็กของไฟล์นี้ (สัญญากลางอยู่ที่ notQualified.mjs):
//   · แตะได้เฉพาะสองทาง: AI เปิด -> เหลือง (ai_off_reason = not_qualified) และ เหลืองของเราเอง -> เขียว
//     เขียนด้วย UPDATE แบบมีเงื่อนไข (compare-and-set) เท่านั้น — เส้นอื่นเขียนเหตุอื่นทับแล้ว = ไม่ใช่ของเราอีกต่อไป
//     ห้ามใช้ setAiEnabled (ไม่มีเงื่อนไข) และห้ามใช้ applyStickyAiOff (เหตุที่ไม่รู้จักตกเป็น money_line)
//   · โมเดลคิด "นอกคิว" ของห้อง แล้วค่อยเขียนใน pipeline.runExclusive (คิวเดียวกับเส้นตอบลูกค้า):
//     อ่านแถวใหม่ + ข้อความล่าสุดใหม่ ถ้าลูกค้าพิมพ์เพิ่ม/ด่านไม่ผ่านแล้ว = เลิก ไม่เขียน
//   · เรียกโมเดลทีละห้องเรียงกันเท่านั้น (เกตเวย์ MAX_INFLIGHT=4 ใช้ร่วมกับคำตอบลูกค้าจริง)
//   · จ่ายเฉพาะห้องที่มีข้อความลูกค้าใหม่นับจากคำตัดสินครั้งก่อน (lastInboundId) — ห้องเดิมไม่ตัดสินซ้ำทุกชั่วโมง
//   · เพดานเงิน ฿100/วัน และ 60 ห้องต่อรอบ · บันทึกต้นทุนไม่ได้ = หยุด (เพดานอ่านยอดจาก llm_usage)
//   · โหมด shadow = คำตัดสินของโมเดลไม่สลับห้องเด็ดขาด · ไม่มีแถวสวิตช์/อ่านพัง = off
//   · ไม่ส่งอะไรถึงลูกค้าเอง: เปิดเขียวแล้วถ้าข้อความล่าสุดยังไม่มีใครตอบ ส่งต่อให้ answerPending ที่ผู้เรียกฉีดมา
//     (Part D ผูกกับ aiPausePolicy.answerPendingInbound + ด่านหน้าต่าง 24 ชม. ของ Facebook)
//   · ไม่ log เนื้อหาแชท — log/stats เป็นตัวเลขรวมเท่านั้น
//
// รีวิวปรปักษ์ 5 ต.ค.: ด้านเปิดเขียวต้อง "ล้มแล้วเปิด" (fail open) — ด้านปิดยังขี้ระแวงเหมือนเดิม
//   · สวิตช์ไม่ใช่ on (off/shadow) = คืนห้องเหลืองทุกห้องเป็นเขียวทุกนาที (#3 #8 #16) — runbook/rollback เรียก
//     releaseAllNotQualified เองได้ก่อนสลับ release (#4) · คำตัดสินที่จดตอนไม่ใช่ on ไม่นับในโหมด on
//   · ตรวจเขียวแล้วโมเดลล้ม/ผลผิดรูป = ห้ามจด lastInboundId ลองใหม่ทุก 10 นาที ครบ 3 ครั้งต่อข้อความใหม่ = เปิดเขียว (#6)
//   · คิวรอตอบซ่อนห้องเหลืองเฉพาะเมื่อ qualify_hold ≥ เวลาข้อความลูกค้าล่าสุด: ต่อ hold เฉพาะตอนปิดเหลือง และตอนโมเดล
//     ยืนยันไม่เข้าเกณฑ์ด้วยหลักฐานจากข้อความใหม่ — ไม่ชัด/มั่นใจต่ำ/ชนเพดาน = ห้องขึ้นคิวรอตอบให้คนเห็น (#6 #10)
//   · ห้องใหม่ (ปิดเหลือง) ใช้งบได้ 70% ของเพดาน ที่เหลือกันไว้ตรวจเปิดเขียว (#10)
//   · โมเดลล้มติดกัน 3 ครั้งในรอบ = พักรอบชั่วโมงและตรวจซ้ำ 20 นาที · รอบชั่วโมงเดินไม่เกิน 10 นาที (#17)
//   · ตรวจซ้ำห้องเดียวกันได้คำตัดสินไม่ถี่กว่า 15 นาที (#18)
//   · ไม่ปิดเหลือง: ข้อความลูกค้าล่าสุดยังไม่มีใครตอบ (#11) · คนตอบ/เขียนโน้ต/กดเปิด AI ภายใน 7 วัน (#5)
//   · เปิดเขียวกันเฉพาะห้อง NEEDS_HUMAN — ห้องที่ทีมกดเสร็จสิ้นแล้วลูกค้าทักกลับมาเปิดได้ (#20)
// รีวิวปรปักษ์รอบ 2 5 ต.ค.:
//   · เปิดเขียวแล้วตอบข้อความค้างทุกชั่วโมง ยกเว้นข้อความเก่าเกิน 60 นาที (แทนกติกา 08:00–21:00 ที่ทำให้ผู้ซื้อกลางคืน
//     ไม่ได้คำตอบ) — ไม่ตอบ = จด answerSkipped + offAt ในสถานะเขียว ให้เทิร์นถัดไปรวมข้อความที่พิมพ์ระหว่างเหลือง
//   · อ่านสวิตช์พัง = ข้ามนาทีนั้นทั้งหมด (skipped: db_error) ไม่ใช่ถือเป็น off แล้วคืนห้องเหลืองทุกห้อง
//   · คืนห้องทั้งหมด (off/shadow/rollback) ใช้ด่านคน/เงินชุดเดียวกับเปิดเขียว
//   · /health เห็น usageBroken + blocked · capped นับห้องละครั้งต่อวัน · ตรวจซ้ำอ่านกุญแจต่อเป็นหน้า ๆ (ไม่ติดหัวแถว)
// รีวิวปรปักษ์รอบ 3 5 ต.ค.:
//   · บรอดแคสต์ของทีม (proactive) ไม่ใช่คนรับห้อง ทั้งด่านเปิดเขียว/คืนห้อง/ปิดเหลือง · ข้อความค้างตัดสินด้วยคำตอบ reactive
//   · สวิตช์เปลี่ยนกลางรอบ = หยุดรอบ/ตรวจซ้ำทันที และอ่านสวิตช์ซ้ำในคิวก่อนปิดเหลือง · /health มี inFlight ให้ runbook รอ
//   · ตรวจซ้ำ: ห้องที่ยังไม่เคยถูกตรวจซ้ำตั้งแต่เป็นเหลืองขึ้นก่อนห้องที่ตัดสินแล้ว (สถานะจด purpose green)
import { createLock } from "./locks.mjs";
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import { bangkokHHMM } from "./digest.mjs";
import { aiPausedNow } from "./aiPause.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { loadModelPricing, pricingById, summarizeUsage } from "./modelPricing.mjs";
import { presetButtonPhrases } from "./presetButtons.mjs";
import { QUALIFY_MODEL } from "./hermesBridge.mjs";
import { yellowOffAtFor } from "./qualifyFastReclaim.mjs";
import {
  AUDIT_AI_OFF_NOT_QUALIFIED, AUDIT_AI_ON_QUALIFIED, NOT_QUALIFIED_REASON, QUALIFY_AUDIT_OPERATOR,
  isNotQualifiedRow, qualifyHoldKey, qualifyHumanOnKey, qualifyRecheckKey, qualifyReleaseKey, qualifyStateKey,
  qualifySweepMode, readJsonSetting,
} from "./notQualified.mjs";
import {
  QUALIFY_CONTEXT_ROWS, QUALIFY_TODAY_MAX_ROWS, qualifySystemPrompt, buildQualifyTranscript, parseQualifyVerdict,
} from "./qualifyPrompt.mjs";
import {
  QUALIFY_CAS_OFF_SQL, QUALIFY_CAS_ON_SQL, QUALIFY_LATEST_INBOUND_SQL, QUALIFY_SWEEP_TIMES, answerSkippedExtra,
  evidenceNewerThan, greenBlockReason, humanSinceOffFor, lastHumanNoteAtFor, lastStaffReplyIgnoringAdGreetingAt, qualifyPendingIsStale,
  QUALIFY_RECHECK_PREFIX, qualifySlotState, qualifyWindowStartMs, readRecheckQueue,
  qualifyStateCountsFor, readQualifySweepModeStrict, releaseAllNotQualified, verdictAllowsGreen, verdictAllowsYellow,
  sweepYellowBlockReason, yellowBlockReason, qualifyAuditDetail,
} from "./qualifySweepRules.mjs";

// กติกา pure ทั้งหมดอยู่ใน qualifySweepRules.mjs — re-export ให้ผู้เรียกเดิม import จากไฟล์นี้ได้เหมือนเดิม
export {
  QUALIFY_CAS_OFF_SQL, QUALIFY_CAS_ON_SQL, QUALIFY_GREEN_MIN_CONFIDENCE, QUALIFY_HOT_SCORE, QUALIFY_PENDING_STALE_MS,
  QUALIFY_SWEEP_MAX_LATE_MS, QUALIFY_SWEEP_TIMES, QUALIFY_YELLOW_MIN_CONFIDENCE, answerSkippedExtra, greenBlockReason,
  inQualifySweepSlot, qualifyAuditDetail, qualifyPendingIsStale, qualifySlotMs, qualifySlotState, qualifyStateCountsFor,
  readQualifySweepModeStrict, releaseAllNotQualified, releaseKeepReason, verdictAllowsGreen, verdictAllowsYellow,
  yellowBlockReason,
} from "./qualifySweepRules.mjs";

export const QUALIFY_SWEEP_LAST_SLOT_KEY = "qualify_sweep_last_slot";
export const QUALIFY_SWEEP_TICK_MS = 60_000;
export const QUALIFY_DAILY_THB_CAP = 100;
export const QUALIFY_SLOT_ROOM_CAP = 60;
// ห้องเหลืองที่มีข้อความใหม่ (กุญแจ qualify_recheck จากไปป์ไลน์) ตรวจได้ทุกนาที ทุกชั่วโมง — แต่ไม่เกิน 5 ห้องต่อนาที
// และรอให้ลูกค้าเงียบ 90 วิก่อน (พิมพ์ต่อเนื่องหลายข้อความ = ตัดสินทีเดียวตอนจบ)
export const QUALIFY_RECHECK_PER_TICK = 5;
export const QUALIFY_RECHECK_QUIET_MS = 90_000;
export const QUALIFY_RECHECK_RETRY_MS = 10 * 60_000;
export const QUALIFY_MIN_TYPED_MESSAGES = 2;
export const QUALIFY_MAX_COMPLETION_TOKENS = 800;
// รีวิวปรปักษ์ 5 ต.ค. #10: ห้องใหม่ใช้งบได้ถึง 70% ของเพดาน (฿70 จาก ฿100) — 30% ที่เหลือกันไว้ให้ห้องเหลือง
// ที่ลูกค้าอาจกลายเป็นผู้ซื้อ (เดิมรอบชั่วโมงใช้งบหมดแล้วห้องเหลืองติดเหลืองถึงเที่ยงคืน)
export const QUALIFY_YELLOW_BUDGET_SHARE = 0.7;
// รีวิวปรปักษ์ 5 ต.ค. #6: ตรวจเขียวไม่ได้คำตัดสินครบ 3 ครั้งต่อข้อความใหม่ = เปิดเขียวไว้ก่อน
export const QUALIFY_GREEN_MAX_ATTEMPTS = 3;
// รีวิวปรปักษ์ 5 ต.ค. #17: เกตเวย์ล่ม = ยิงล้ม 60 ครั้งติดกันทุกชั่วโมงและถือช่องเกตเวย์ที่ใช้ร่วมกับคำตอบลูกค้า
export const QUALIFY_BREAKER_FAILURES = 3;
export const QUALIFY_BREAKER_BACKOFF_MS = 20 * 60_000;
export const QUALIFY_SLOT_MAX_MS = 10 * 60_000;
// รีวิวปรปักษ์ 5 ต.ค. #18: ห้องเหลืองที่พิมพ์ถี่ทั้งคืนเคยกินงบรายวันได้ทีละข้อความ
export const QUALIFY_RECHECK_MIN_INTERVAL_MS = 15 * 60_000;
const CANDIDATE_LIMIT = 500;
const RECHECK_PREFIX = QUALIFY_RECHECK_PREFIX;
const UNVERIFIABLE_VERDICT = Object.freeze({
  verdict: "unclear", confidence: 0, category: "insufficient", evidenceIds: Object.freeze([]),
  reason: "ตรวจซ้ำไม่ได้คำตัดสิน 3 ครั้ง — เปิดตอบไว้ก่อน",
});

/* ------------------------------- ตัวกวาด (factory) ------------------------------ */

export function createQualifySweep({
  config = {}, db, hermes, pipeline, burst = null, logger = console, now = Date.now, isDraining = () => false,
  answerPending = null, fx = null, modelPricing = null, intervalMs = QUALIFY_SWEEP_TICK_MS,
  dailyThbCap = QUALIFY_DAILY_THB_CAP, slotRoomCap = QUALIFY_SLOT_ROOM_CAP,
} = {}) {
  const lock = createLock();
  let timer = null;
  let pricing = null;
  let usageBroken = false; // เขียน llm_usage ไม่ได้ครั้งเดียว = หยุดเรียกโมเดลจนรีสตาร์ต (นับเงินไม่ได้ = ไม่จ่าย)
  // ทั้งหมดอยู่ในหน่วยความจำ — รีสตาร์ต = เริ่มนับใหม่ (ลองซ้ำได้มากขึ้นเล็กน้อย ยังติดเพดานเงิน)
  const retryAfter = new Map(); // customerId -> เวลาที่ลองตรวจเขียวได้อีก (หลังโมเดลล้ม/ผลผิดรูป)
  const greenFailures = new Map(); // #6: customerId -> { inboundId, count } ตรวจเขียวไม่ได้คำตัดสินกี่ครั้งต่อข้อความใหม่
  const lastRecheckAt = new Map(); // #18: customerId -> เวลาที่ตรวจเขียวได้คำตัดสินล่าสุด
  const breaker = { consecutive: 0, until: 0, trips: 0 }; // #17
  // รีวิวปรปักษ์รอบ 2 5 ต.ค.: capped นับ "ห้อง" ต่อวัน (เดิมนับทุกนาทีที่ห้องเดิมชนเพดาน — ห้องเดียวขึ้น 121)
  // capReason = เหตุที่หยุดเรียกโมเดลวันนี้แยกงาน ให้ /health บอกได้ว่าทำไมห้องเหลืองไม่ถูกตรวจ
  const freshDay = (key) => ({
    key, checked: 0, yellow: 0, green: 0, unclear: 0, cappedRooms: new Set(), unmetered: 0,
    capLogged: { yellow: false, green: false }, capReason: { yellow: "", green: "" },
  });
  let day = freshDay(0);

  const raw = () => db?.raw;
  const pricingMap = () => {
    pricing ??= pricingById(modelPricing ?? loadModelPricing(config.modelPricingFile, { logger }));
    return pricing;
  };
  const thbPerUsd = () => {
    try {
      const live = Number(fx?.current?.()?.thbPerUsd);
      if (live > 0) return live;
    } catch { /* fx พัง = ใช้ค่า config */ }
    return Number(config.thbPerUsd) > 0 ? Number(config.thbPerUsd) : 36;
  };
  const today = (t) => {
    const key = bangkokDayStartMs(t);
    if (day.key !== key) day = freshDay(key);
    return day;
  };

  /* ------------------------------ อ่านข้อมูลห้อง ------------------------------ */

  function latestInboundOf(customerId) {
    return raw().prepare(QUALIFY_LATEST_INBOUND_SQL).get(String(customerId)) ?? null;
  }

  function latestRowOf(customerId) {
    return raw().prepare(`SELECT direction, created_at FROM messages WHERE customer_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(String(customerId)) ?? null;
  }

  // คำตอบจริงล่าสุดของฝั่งเรา — ข้อความทวง/บรอดแคสต์ (proactive) ไม่นับว่าตอบ (กติกาเดียวกับคิวรอตอบ)
  function latestReplyAt(customerId) {
    return Number(raw().prepare(`SELECT created_at FROM messages WHERE customer_id = ? AND direction = 'out'
      AND COALESCE(message_class, 'reactive') != 'proactive' ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(String(customerId))?.created_at) || 0;
  }

  // บทสนทนาของ session ปัจจุบัน: ข้อความวันนี้ (สูงสุด 60 แถวล่าสุด) + บริบทก่อนวันนี้ 12 แถว เรียงเก่า -> ใหม่
  function transcriptRows(customerId, dayStartMs) {
    const session = db.activeConversationSession?.(customerId) ?? null;
    const filter = session ? "session_id = ?" : "session_id IS NULL";
    const params = session ? [String(session.id)] : [];
    const select = `SELECT id, direction, msg_type, content, operator, message_class, created_at
      FROM messages WHERE customer_id = ? AND ${filter}`;
    const todayRows = raw().prepare(`${select} AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(String(customerId), ...params, dayStartMs, QUALIFY_TODAY_MAX_ROWS);
    const before = raw().prepare(`${select} AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(String(customerId), ...params, dayStartMs, QUALIFY_CONTEXT_ROWS);
    return [...before.reverse(), ...todayRows.reverse()];
  }

  function silencedByTag(customerId) {
    try {
      return typeof db.isBotSilencedByTag === "function" ? Boolean(db.isBotSilencedByTag(customerId)) : true;
    } catch {
      return true;
    }
  }

  // หมุด "คนกดเปิด AI ห้องนี้" (Part D เขียนเป็น ms) — มีหมุดแต่อ่านไม่ออก = ถือว่าคนเพิ่งกด (ด้านปลอดภัย: ไม่ปิดเหลือง)
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

  function yellowFacts(customerId, nowMs) {
    const latestIn = latestInboundOf(customerId);
    return {
      nowMs,
      salesDecisionGuardEnabled: config.salesDecisionGuardEnabled === true,
      silenced: silencedByTag(customerId),
      released: Boolean(db.getSetting(qualifyReleaseKey(customerId))),
      // รีวิวปรปักษ์รอบ 3 5 ต.ค.: เดิมนับบรอดแคสต์ด้วย (กว้างไว้ = เหลืองน้อยลง) — บรอดแคสต์ทุกสัปดาห์ถึงทุกห้องที่ทักได้
      // ทำให้ตัวกวาดปิดเหลืองใครไม่ได้เลย 7 วัน ทั้งที่คนไม่ได้ตัดสินห้องนั้น · ตัดสินใจใช้ชุดเดียวกับด่านเปิดเขียว:
      // นับเฉพาะคำตอบ reactive ของทีม (ด้านปิดยังกันด้วยคะแนน/ข้อความค้าง/โน้ต/คนกดเปิด AI ครบเหมือนเดิม)
      humanOutboundAt: lastStaffReplyIgnoringAdGreetingAt(db, customerId),
      humanNoteAt: lastHumanNoteAtFor(db, customerId),
      humanOnAt: humanOnAt(customerId, nowMs),
      burstPending: Number(burst?.pendingSize?.(customerId)) || 0,
      unanswered: Boolean(latestIn) && latestReplyAt(customerId) < Number(latestIn.created_at),
    };
  }

  // ไม่รู้เวลาปิด (offAt 0) = คนเคยตอบเมื่อไหร่ก็ตามถือว่าคนรับห้องแล้ว (ด้านปลอดภัย) — ชุดเดียวกับการคืนห้องทั้งหมด
  function greenFacts(customerId, nowMs, offAt) {
    return {
      nowMs,
      silenced: silencedByTag(customerId),
      humanSinceOff: humanSinceOffFor(db, customerId, offAt),
      lastInboundAt: Number(latestInboundOf(customerId)?.created_at) || 0,
    };
  }

  /* ---------------------------------- เงิน ---------------------------------- */

  function todayQualifyRows(t) {
    return db.llmUsageSummary(bangkokDayStartMs(t)).filter((row) => row.kind === "qualify");
  }

  function estimateRow(tokensIn) {
    return { model: String(config.hermesQualifyModel || "").trim() || QUALIFY_MODEL, kind: "qualify", tokens_in: tokensIn, tokens_out: QUALIFY_MAX_COMPLETION_TOKENS };
  }

  // ยอดวันนี้ + ประมาณการของห้องถัดไป ต้องไม่เกินเพดานของงานนั้น · ราคาไม่รู้ = หยุด (ห้ามจ่ายโดยไม่รู้ราคา)
  // รีวิวปรปักษ์ 5 ต.ค. #10: ปิดเหลืองใช้ได้ 70% ของเพดาน · ตรวจเปิดเขียวใช้ได้เต็มเพดาน
  function budgetCheck(t, tokensInEstimate, purpose) {
    if (usageBroken) return { ok: false, reason: "usage_unrecorded" };
    const stats = today(t);
    const unmetered = Array.from({ length: stats.unmetered }, () => estimateRow(tokensInEstimate));
    const projected = summarizeUsage([...todayQualifyRows(t), ...unmetered, estimateRow(tokensInEstimate)], pricingMap());
    if (projected.unknownTokens > 0) return { ok: false, reason: "pricing_unknown" };
    const cap = purpose === "green" ? dailyThbCap : dailyThbCap * QUALIFY_YELLOW_BUDGET_SHARE;
    if (projected.usd * thbPerUsd() > cap) return { ok: false, reason: "daily_cap" };
    return { ok: true };
  }

  function recordUsage(customerId, result) {
    if (!result?.usage) {
      today(now()).unmetered += 1; // ไม่มีตัวเลขจาก provider — นับเป็นค่าประมาณต่อห้องในเพดานแทน
      return;
    }
    try {
      db.addLlmUsage({ customerId, kind: "qualify", model: result.model || String(config.hermesQualifyModel || "").trim() || QUALIFY_MODEL, ...usageFields(result.usage) });
    } catch (err) {
      usageBroken = true;
      logger.error?.(`qualify-sweep: บันทึกต้นทุนไม่สำเร็จ — หยุดเรียกโมเดลจนรีสตาร์ต (${err?.message || err})`);
    }
  }

  // ชนเพดาน/หยุดจ่าย: นับห้องละครั้งต่อวัน + จดเหตุล่าสุดของงานนั้น · log ครั้งเดียวต่อวันต่องาน
  function noteCapped(t, reason, purpose, customerIds) {
    const stats = today(t);
    for (const id of customerIds) stats.cappedRooms.add(String(id));
    stats.capReason[purpose === "green" ? "green" : "yellow"] = String(reason || "");
    logCapOnce(t, reason, purpose);
  }

  function logCapOnce(t, reason, purpose) {
    const stats = today(t);
    const kind = purpose === "green" ? "green" : "yellow";
    if (stats.capLogged[kind]) return;
    stats.capLogged[kind] = true;
    logger.log?.(kind === "green"
      ? `[qualify-sweep] หยุดเรียกโมเดลวันนี้สำหรับตรวจห้องเหลือง (${reason}) — เพดาน ฿${dailyThbCap}/วัน · ห้องเหลืองที่ลูกค้าทักใหม่ขึ้นคิวรอตอบให้คนดูแทน`
      : `[qualify-sweep] หยุดเรียกโมเดลวันนี้สำหรับห้องใหม่ (${reason}) — ห้องใหม่ใช้ได้ ${Math.round(QUALIFY_YELLOW_BUDGET_SHARE * 100)}% ของเพดาน ฿${dailyThbCap}/วัน ที่เหลือกันไว้ตรวจห้องเหลือง`);
  }

  /* -------------------------- ตัวตัดวงจรเมื่อโมเดลล้ม (#17) -------------------------- */

  const breakerOpen = (t) => breaker.until > Number(t);

  // ล้มติดกัน 3 ครั้งในรอบเดียว = พัก 20 นาที (ทั้งรอบชั่วโมงและตรวจซ้ำ) · ได้คำตอบ (แม้ผิดรูป) = provider ยังอยู่ นับใหม่
  function noteModelResult(ok) {
    if (ok) {
      breaker.consecutive = 0;
      return;
    }
    breaker.consecutive += 1;
    if (breaker.consecutive < QUALIFY_BREAKER_FAILURES) return;
    breaker.consecutive = 0;
    breaker.until = now() + QUALIFY_BREAKER_BACKOFF_MS;
    breaker.trips += 1;
    logger.warn?.(`[qualify-sweep] โมเดลล้มติดกัน ${QUALIFY_BREAKER_FAILURES} ครั้ง — พักรอบชั่วโมงและตรวจซ้ำ ${QUALIFY_BREAKER_BACKOFF_MS / 60_000} นาที`);
  }

  /* -------------------------------- สถานะต่อห้อง -------------------------------- */

  // purpose "green" = คำตัดสินจากการตรวจซ้ำห้องเหลือง (ใช้จัดลำดับกุญแจตรวจซ้ำ — ห้องที่ยังไม่เคยถูกตรวจซ้ำได้ก่อน)
  function writeState(customerId, verdict, { lastInboundId, at, mode, offAt = 0, invalid = false, extra = null, purpose = "" }) {
    const state = {
      verdict: verdict?.verdict ?? "unclear",
      confidence: Number.isFinite(verdict?.confidence) ? verdict.confidence : 0,
      category: verdict?.category ?? "insufficient",
      reason: verdict?.reason ?? "",
      evidenceIds: Array.isArray(verdict?.evidenceIds) ? [...verdict.evidenceIds] : [],
      lastInboundId: String(lastInboundId || ""),
      at,
      mode,
      ...(offAt ? { offAt } : {}),
      ...(invalid ? { invalid: true } : {}),
      ...(purpose === "green" ? { purpose } : {}),
      ...(extra || {}),
    };
    db.setSetting(qualifyStateKey(customerId), JSON.stringify(state));
    return state;
  }

  function clearRecheck(key, value) {
    raw().prepare("DELETE FROM settings WHERE key = ? AND value = ?").run(String(key), String(value));
  }

  // กุญแจตรวจซ้ำที่ไปป์ไลน์ปักไว้เป็นค่าใหม่สุดเสมอ — มีอยู่แล้วห้ามทับ (เส้นรอบชั่วโมงอาจไม่มีกุญแจ)
  function ensureRecheck(customerId, snapshot) {
    raw().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING")
      .run(qualifyRecheckKey(customerId), `${now()}:${snapshot.lastInboundId}`);
  }

  function forgetRoom(customerId) {
    retryAfter.delete(customerId);
    greenFailures.delete(customerId);
  }

  // audit เฉพาะตอนสถานะเปลี่ยนจริง (listAudit เห็นแค่ 500 แถวล่าสุดทั้งระบบ) · audit พังห้ามทำให้สถานะห้องหาย
  function auditSwitch(customerId, action, verdict, detail = null) {
    try {
      db.addAudit({ operator: QUALIFY_AUDIT_OPERATOR, action, target: customerId, detail: detail ?? qualifyAuditDetail(verdict) });
    } catch (err) {
      logger.warn?.(`qualify-sweep: บันทึก audit ไม่สำเร็จ (${err?.message || err})`);
    }
  }

  /* --------------------------------- สลับห้อง --------------------------------- */

  async function applyYellow(customerId, snapshot, verdict, mode) {
    if (typeof pipeline?.runExclusive !== "function") return { outcome: "no_queue" };
    return pipeline.runExclusive(customerId, async () => {
      // รีวิวปรปักษ์รอบ 3 5 ต.ค.: รอบชั่วโมงอ่านสวิตช์ครั้งเดียวตอนเริ่ม แล้วเดินได้ถึง 10 นาที — กดปิด/สลับ shadow หรือรัน
      // เครื่องมือ rollback ระหว่างรอบ ห้องที่เหลือยังถูกปิดเหลืองต่อ (และค้าง not_qualified ใน release เก่าตลอดไป)
      // อ่านสวิตช์สดอีกครั้งในคิวก่อน CAS · อ่านพัง (null) ก็ไม่ปิด
      if (readQualifySweepModeStrict(db) !== "on") return { outcome: "mode_changed" };
      const t = now();
      const latest = latestInboundOf(customerId);
      if (!latest || String(latest.id) !== snapshot.lastInboundId) return { outcome: "changed" };
      const block = sweepYellowBlockReason(db.getCustomer(customerId), yellowFacts(customerId, t));
      if (block) return { outcome: `blocked:${block}` };
      if (raw().prepare(QUALIFY_CAS_OFF_SQL).run(NOT_QUALIFIED_REASON, customerId).changes !== 1) return { outcome: "cas_lost" };
      auditSwitch(customerId, AUDIT_AI_OFF_NOT_QUALIFIED, verdict);
      writeState(customerId, verdict, { lastInboundId: snapshot.lastInboundId, at: t, mode, offAt: t });
      // รีวิวปรปักษ์ 5 ต.ค. #6: ยืนยันข้อความลูกค้าถึงตัวนี้แล้ว — คิวรอตอบซ่อนห้องจนกว่าลูกค้าจะทักใหม่
      db.setSetting(qualifyHoldKey(customerId), String(Number(latest.created_at) || t));
      return { outcome: "yellow" };
    });
  }

  // เปิดเขียวแล้วข้อความลูกค้าล่าสุดยังไม่มีใครตอบ — ใครตอบ: "now" = answerPending ทันที · อื่น ๆ = ไม่ตอบในรอบนี้
  // รีวิวปรปักษ์รอบ 2 5 ต.ค. (#10 regression): เดิมกันทุกห้องนอก 08:00–21:00 — ผู้ซื้อที่พิมพ์สี่ทุ่มแล้วผ่านตอนสี่ทุ่มห้านาที
  // ไม่ได้คำตอบเลย · ตอนนี้ข้อความใหม่ตอบทุกชั่วโมงเหมือนห้องเขียวปกติ ไม่ตอบเฉพาะข้อความเก่าเกิน 60 นาที (เพดานพ้น
  // ตอนเที่ยงคืนแล้วไปตอบข้อความบ่ายสอง) · burst = ลูกค้ากำลังพิมพ์ เส้นตอบปกติรับข้อความชุดนั้นเอง (ห้ามตอบซ้อน)
  // รีวิวปรปักษ์รอบ 3 5 ต.ค.: "ยังไม่มีใครตอบ" ตัดสินด้วยคำตอบ reactive (บรอดแคสต์/ทักตามไม่นับ) · มีแถว proactive ตามหลัง
  // = answerPending อ่านเทิร์นล่าสุดเป็นของเรา ตอบไม่ได้ → จด answerSkipped ให้เทิร์นถัดไปเห็นข้อความค้าง (ห้องขึ้นคิวรอตอบอยู่แล้ว)
  function pendingPlan(customerId, latest, t) {
    if (!(latestReplyAt(customerId) < Number(latest?.created_at))) return "";
    if (latestRowOf(customerId)?.direction !== "in") return "proactive_after";
    if ((Number(burst?.pendingSize?.(customerId)) || 0) > 0) return "burst";
    if (qualifyPendingIsStale(latest?.created_at, t)) return "stale";
    return typeof answerPending === "function" ? "now" : "not_wired";
  }

  async function applyGreen(customerId, snapshot, verdict, mode, { detail = null, extra = null } = {}) {
    if (typeof pipeline?.runExclusive !== "function") return { outcome: "no_queue" };
    const result = await pipeline.runExclusive(customerId, async () => {
      const t = now();
      const latest = latestInboundOf(customerId);
      if (!latest || String(latest.id) !== snapshot.lastInboundId) return { outcome: "changed" };
      const block = greenBlockReason(db.getCustomer(customerId), greenFacts(customerId, t, snapshot.offAt));
      if (block) return { outcome: `blocked:${block}` };
      const offAt = snapshot.offAt || yellowOffAtFor(db, customerId); // อ่านก่อนเขียนสถานะเขียวทับ offAt
      if (raw().prepare(QUALIFY_CAS_ON_SQL).run(customerId, NOT_QUALIFIED_REASON).changes !== 1) return { outcome: "cas_lost" };
      auditSwitch(customerId, AUDIT_AI_ON_QUALIFIED, verdict, detail);
      const plan = pendingPlan(customerId, latest, t);
      // ไม่ตอบข้อความค้างในรอบนี้ = จดธงให้เทิร์นถัดไปของลูกค้ารวมข้อความที่พิมพ์ระหว่างเหลือง (สัญญาอยู่ที่ answerSkippedExtra)
      const skipped = plan && plan !== "now" ? answerSkippedExtra(offAt) : null;
      writeState(customerId, verdict, { lastInboundId: snapshot.lastInboundId, at: t, mode, extra: { ...(extra || {}), ...(skipped || {}) } });
      raw().prepare("DELETE FROM settings WHERE key = ?").run(qualifyHoldKey(customerId));
      forgetRoom(customerId);
      return { outcome: "green", plan };
    });
    if (result?.outcome !== "green") return result;
    const { plan, ...green } = result;
    if (plan === "stale") return { ...green, answer: "stale" };
    if (plan !== "now") return green;
    // นอกคิวเสมอ: answerPending ส่งเข้าคิวเดียวกันต่อ — เรียกในคิวจะรอตัวเองจนค้าง
    try {
      await answerPending({ customerId });
    } catch (err) {
      logger.warn?.(`qualify-sweep: ตอบข้อความค้างหลังเปิดเขียวไม่สำเร็จ (${err?.message || err})`);
    }
    return green;
  }

  // ห้องยังเหลืองและโมเดลยืนยันด้วยข้อความใหม่ = ต่อ hold ถึงข้อความที่ตัดสิน (ข้อความใหม่กว่านี้ขึ้นคิวรอตอบเอง)
  async function refreshHold(customerId, snapshot) {
    if (typeof pipeline?.runExclusive !== "function") return { outcome: "no_queue" };
    return pipeline.runExclusive(customerId, async () => {
      const latest = latestInboundOf(customerId);
      if (!latest || String(latest.id) !== snapshot.lastInboundId) return { outcome: "changed" };
      if (!isNotQualifiedRow(db.getCustomer(customerId))) return { outcome: "not_yellow" };
      db.setSetting(qualifyHoldKey(customerId), String(snapshot.lastInboundAt));
      return { outcome: "held" };
    });
  }

  async function applySafely(work) {
    try {
      return await work();
    } catch (err) {
      logger.error?.(`qualify-sweep: สลับห้องไม่สำเร็จ (${err?.message || err})`);
      return { outcome: "apply_error" };
    }
  }

  /* ------------------------------- ตัดสินหนึ่งห้อง ------------------------------- */

  function preCheck(customerId, purpose, t, prior) {
    const row = db.getCustomer(customerId);
    const block = purpose === "yellow"
      ? sweepYellowBlockReason(row, yellowFacts(customerId, t))
      : greenBlockReason(row, greenFacts(customerId, t, prior?.offAt));
    return { row, block };
  }

  // ด่านก่อนเรียกโมเดลของการตรวจเขียว: พักหลังล้ม (#6) และไม่ถี่กว่า 15 นาที (#18) — เก็บกุญแจไว้ตรวจหลังพ้นช่วง
  function greenGate(customerId, t, snapshot) {
    if ((retryAfter.get(customerId) || 0) > t) return { outcome: "backoff", keepMarker: true };
    if (lastRecheckAt.has(customerId) && t - lastRecheckAt.get(customerId) < QUALIFY_RECHECK_MIN_INTERVAL_MS) {
      ensureRecheck(customerId, snapshot);
      return { outcome: "throttled", keepMarker: true };
    }
    return null;
  }

  // รีวิวปรปักษ์ 5 ต.ค. #6: ตรวจเขียวไม่ได้คำตัดสิน (โมเดลล้ม/ผลผิดรูป) ห้ามจด lastInboundId — เดิมจดแล้วรอบชั่วโมงตอบ
  // "unchanged" ผู้ซื้อเงียบจนกว่าจะพิมพ์ใหม่ · ลองใหม่ทุก 10 นาที ครบ 3 ครั้งต่อข้อความใหม่ = เปิดเขียวไว้ก่อน
  // (ด่านคน/เงิน/ป้ายของ greenBlockReason ยังกันอยู่ในคิว — ห้องที่คนรับไปแล้วไม่ถูกเปิดทับ)
  async function greenUnverified(base, customerId, snapshot, mode, kind) {
    const prev = greenFailures.get(customerId);
    const count = prev?.inboundId === snapshot.lastInboundId ? prev.count + 1 : 1;
    if (count < QUALIFY_GREEN_MAX_ATTEMPTS || mode !== "on") {
      greenFailures.set(customerId, { inboundId: snapshot.lastInboundId, count });
      retryAfter.set(customerId, now() + QUALIFY_RECHECK_RETRY_MS);
      ensureRecheck(customerId, snapshot);
      return { ...base, outcome: kind, called: true, keepMarker: true, attempts: count };
    }
    forgetRoom(customerId);
    const applied = await applySafely(() => applyGreen(customerId, snapshot, UNVERIFIABLE_VERDICT, mode, {
      detail: "release:green_unverifiable", extra: { release: "green_unverifiable" },
    }));
    if (applied.outcome === "green") today(now()).green += 1;
    return { ...base, outcome: applied.outcome === "green" ? "release:green_unverifiable" : applied.outcome, called: true, attempts: count };
  }

  async function decideYellow(base, customerId, snapshot, verdict, mode) {
    if (!verdictAllowsYellow(verdict)) return { ...base, outcome: `recorded:${verdict.verdict}`, called: true };
    if (mode !== "on") return { ...base, outcome: "shadow:yellow", called: true };
    const applied = await applySafely(() => applyYellow(customerId, snapshot, verdict, mode));
    if (applied.outcome === "yellow") today(now()).yellow += 1;
    return { ...base, outcome: applied.outcome, called: true };
  }

  async function decideGreen(base, customerId, snapshot, verdict, mode, rows) {
    if (verdictAllowsGreen(verdict)) {
      if (mode !== "on") return { ...base, outcome: "shadow:green", called: true };
      const applied = await applySafely(() => applyGreen(customerId, snapshot, verdict, mode));
      if (applied.outcome === "green") today(now()).green += 1;
      return { ...base, outcome: applied.outcome, called: true, ...(applied.answer ? { answer: applied.answer } : {}) };
    }
    // รีวิวปรปักษ์ 5 ต.ค. #6: ต่อ hold เฉพาะ not_qualified ≥ 0.8 ที่หลักฐานมีบรรทัดลูกค้าใหม่กว่าจุดยืนยันครั้งก่อน
    // unclear / potential มั่นใจต่ำ / ชี้แค่บรรทัดเก่า = คงเหลืองแต่ไม่ต่อ hold → ข้อความใหม่ขึ้นคิวรอตอบให้คนตัดสิน
    const holdAt = Number(db.getSetting(qualifyHoldKey(customerId))) || 0;
    if (mode === "on" && verdictAllowsYellow(verdict) && evidenceNewerThan(verdict, rows, Math.max(holdAt, snapshot.offAt))) {
      const held = await applySafely(() => refreshHold(customerId, snapshot));
      if (held.outcome === "held") return { ...base, outcome: "held", called: true };
    }
    return { ...base, outcome: `recorded:${verdict.verdict}`, called: true };
  }

  /**
   * @param {string} customerId
   * @param {"yellow"|"green"} purpose yellow = ห้อง AI เปิดที่อาจปิดเหลือง · green = ห้องเหลืองของเราที่อาจเปิดคืน
   * @returns {Promise<{customerId, purpose, outcome: string, called?: boolean, keepMarker?: boolean}>}
   *   keepMarker = เก็บกุญแจตรวจซ้ำไว้ (ยังไม่ได้คำตัดสินของข้อความนี้)
   */
  async function evaluateRoom(customerId, purpose, { mode, presetPhrases }) {
    const t = now();
    const base = { customerId, purpose };
    const prior = readJsonSetting(db, qualifyStateKey(customerId));
    const { row, block } = preCheck(customerId, purpose, t, prior);
    if (block) return { ...base, outcome: `skipped:${block}` };
    const latest = latestInboundOf(customerId);
    if (!latest) return { ...base, outcome: "skipped:no_inbound" };
    const lastInboundId = String(latest.id);
    if (prior?.lastInboundId === lastInboundId && qualifyStateCountsFor(prior, mode)) return { ...base, outcome: "unchanged" };
    const offAt = purpose === "green" ? Number(prior?.offAt) || 0 : 0;
    const snapshot = { lastInboundId, lastInboundAt: Number(latest.created_at) || 0, offAt };
    if (purpose === "green") {
      const gate = greenGate(customerId, t, snapshot);
      if (gate) return { ...base, ...gate };
    }
    // 8 พ.ย. 2026 รอบทุกชั่วโมง: ช่วง "ปัจจุบัน" ของบทสนทนา = ต้นวัน หรือย้อน 2 ชม. ถ้าเพิ่งพ้นเที่ยงคืน
    const dayStart = qualifyWindowStartMs(t, bangkokDayStartMs(t));
    const names = [row.display_name, row.known_name];
    const rows = transcriptRows(customerId, dayStart);
    const transcript = buildQualifyTranscript({
      rows, nowMs: t, dayStartMs: dayStart, names, presetPhrases, channel: row.channel_id, purpose, offAt,
    });
    if (purpose === "yellow" && transcript.typedCustomerCount < QUALIFY_MIN_TYPED_MESSAGES) {
      return { ...base, outcome: "skipped:too_few_messages" };
    }
    const system = qualifySystemPrompt();
    const budget = budgetCheck(t, system.length + transcript.user.length, purpose);
    if (!budget.ok) {
      // ชนเพดานตอนตรวจเขียว = คงเหลืองโดยไม่ต่อ hold (ขึ้นคิวให้คนเห็น) + เก็บกุญแจไว้ตรวจเมื่องบวันใหม่ว่าง
      if (purpose === "green") ensureRecheck(customerId, snapshot);
      return { ...base, outcome: "capped", reason: budget.reason, keepMarker: true };
    }

    let result = null;
    try {
      result = await hermes.qualifyCustomer({
        system, user: transcript.user, maxCompletionTokens: QUALIFY_MAX_COMPLETION_TOKENS,
      });
    } catch (err) {
      logger.warn?.(`qualify-sweep: เรียกโมเดลไม่สำเร็จ (${err?.name || "Error"})`);
      result = null;
    }
    if (!result || result.failed) {
      if (!result) today(now()).unmetered += 1; // ได้ 200 แต่ไม่มีเนื้อ = อาจถูกคิดเงินแล้ว นับเข้าเพดานไว้ก่อน
      noteModelResult(false);
      if (purpose === "green") return greenUnverified(base, customerId, snapshot, mode, "error");
      return { ...base, outcome: "error", called: true };
    }
    noteModelResult(true);
    recordUsage(customerId, result);
    const stats = today(now());
    stats.checked += 1;
    const verdict = parseQualifyVerdict(result.text, { customerRefs: transcript.customerRefs, names });
    const at = now();
    if (!verdict) {
      stats.unclear += 1;
      if (purpose === "green") return greenUnverified(base, customerId, snapshot, mode, "invalid");
      // ด้านปิดเหลือง: จดว่าตัดสินแล้ว (ไม่จ่ายซ้ำทุกชั่วโมงกับห้องเดิม — ห้องยังเขียว) ข้อความใหม่ตัดสินใหม่ได้
      writeState(customerId, null, { lastInboundId, at, mode, invalid: true });
      return { ...base, outcome: "invalid", called: true };
    }
    if (verdict.verdict === "unclear") stats.unclear += 1;
    writeState(customerId, verdict, { lastInboundId, at, mode, offAt, purpose });
    if (purpose === "yellow") return decideYellow(base, customerId, snapshot, verdict, mode);
    lastRecheckAt.set(customerId, at);
    forgetRoom(customerId);
    return decideGreen(base, customerId, snapshot, verdict, mode, rows);
  }

  // ห้องหนึ่งพัง (DB อ่านไม่ได้ ฯลฯ) ต้องไม่ลากทั้งรอบ — นับเป็น error ของห้องนั้นแล้วไปห้องถัดไป
  async function evaluateSafely(customerId, purpose, ctx) {
    try {
      return await evaluateRoom(customerId, purpose, ctx);
    } catch (err) {
      logger.error?.(`qualify-sweep: ตัดสินห้องไม่สำเร็จ (${err?.message || err})`);
      return { customerId, purpose, outcome: "error" };
    }
  }

  /* --------------------------------- สองเส้นงาน --------------------------------- */

  // กุญแจหนึ่งดอก: null = ข้ามโดยไม่เรียกโมเดล (ไม่เหลือง/ลูกค้ายังพิมพ์/รอลองใหม่) · อื่น ๆ = ผลของ evaluateRoom
  async function recheckMarker(marker, t, ctx) {
    const customerId = String(marker.key).slice(RECHECK_PREFIX.length);
    if (!isNotQualifiedRow(db.getCustomer(customerId))) {
      clearRecheck(marker.key, marker.value); // ห้องไม่เหลืองแล้ว (คนเปิด/เหตุอื่นทับ) — ไม่ใช่งานของเรา
      forgetRoom(customerId);
      return null;
    }
    const latest = latestInboundOf(customerId);
    if (latest && t - Number(latest.created_at) < QUALIFY_RECHECK_QUIET_MS) return null;
    if ((Number(burst?.pendingSize?.(customerId)) || 0) > 0) return null;
    if ((retryAfter.get(customerId) || 0) > t) return null;
    const result = await evaluateSafely(customerId, "green", ctx);
    if (result.outcome === "capped" || result.keepMarker) return result; // ยังไม่ได้คำตัดสิน — เก็บกุญแจไว้
    if (result.outcome === "error") {
      retryAfter.set(customerId, t + QUALIFY_RECHECK_RETRY_MS); // ห้องพังกลางทาง = เก็บกุญแจไว้ลองใหม่ ไม่ยิงถี่
      return result;
    }
    clearRecheck(marker.key, marker.value); // ลบเฉพาะค่าที่อ่านมา — ข้อความใหม่ระหว่างตรวจปักค่าใหม่ไว้แล้ว
    return result;
  }

  // รีวิวปรปักษ์รอบ 3 5 ต.ค.: สวิตช์เปลี่ยนระหว่างรอบ (กดปิด/shadow/rollback) = หยุดทันที · อ่านพัง (null) ก็หยุด
  const modeChanged = (ctx) => readQualifySweepModeStrict(db) !== ctx.mode;

  // ทุกนาที ทุกชั่วโมง: ห้องเหลืองที่ลูกค้าพิมพ์มาใหม่ (ไปป์ไลน์ปักกุญแจไว้) — ไม่ต้องรอรอบชั่วโมงถัดไป · เรียกไม่เกิน 5 ห้อง/นาที
  // คิวอ่านต่อเป็นหน้า ๆ (รอบ 2) และห้องที่ยังไม่เคยตรวจซ้ำตั้งแต่เป็นเหลืองขึ้นก่อน (รอบ 3) — readRecheckQueue
  async function runRechecks(t, ctx) {
    const results = [];
    let called = 0;
    for (const marker of readRecheckQueue(db, { recentlyChecked: (id) => lastRecheckAt.has(id) })) {
      if (called >= QUALIFY_RECHECK_PER_TICK || isDraining() || breakerOpen(now()) || modeChanged(ctx)) break;
      const result = await recheckMarker(marker, t, ctx);
      if (!result) continue;
      results.push(result);
      if (result.called) called += 1;
      if (result.outcome === "capped") {
        // เก็บกุญแจไว้ — พ้นเพดาน (วันใหม่) แล้วค่อยตรวจ · ห้องขึ้นคิวรอตอบเพราะไม่ต่อ hold
        noteCapped(t, result.reason, "green", [result.customerId]);
        break;
      }
    }
    for (const [id, at] of lastRecheckAt) if (t - at >= QUALIFY_RECHECK_MIN_INTERVAL_MS) lastRecheckAt.delete(id);
    for (const [id, until] of retryAfter) if (until <= t) retryAfter.delete(id);
    return results;
  }

  // รอบชั่วโมง: ทุกห้องที่ลูกค้าทักวันนี้ — ห้องเหลืองของเราที่มีข้อความใหม่ก่อน (อาจเป็นผู้ซื้อที่รอคำตอบ) แล้วห้อง AI เปิด
  async function runSlot(t, ctx) {
    const rooms = raw().prepare(`SELECT c.line_user_id AS id, c.ai_enabled, c.ai_off_reason, MAX(m.created_at) AS last_in
      FROM messages m JOIN customers c ON c.line_user_id = m.customer_id
      WHERE m.direction = 'in' AND m.created_at >= ? AND c.line_user_id NOT LIKE 'canary:%'
      GROUP BY c.line_user_id ORDER BY last_in DESC LIMIT ?`).all(qualifyWindowStartMs(t, bangkokDayStartMs(t)), CANDIDATE_LIMIT);
    const queue = [
      ...rooms.filter((room) => isNotQualifiedRow(room)).map((room) => [String(room.id), "green"]),
      ...rooms.filter((room) => Number(room.ai_enabled) === 1).map((room) => [String(room.id), "yellow"]),
    ];
    const results = [];
    const startedAt = now();
    let called = 0;
    let stopped = "";
    for (let index = 0; index < queue.length; index += 1) {
      if (isDraining()) break;
      const left = queue.length - index;
      // รีวิวปรปักษ์ 5 ต.ค. #17: โมเดลล้มติดกัน = หยุดรอบ · เดินเกิน 10 นาที = หยุด (ไม่ล้นรอบถัดไป ไม่ถือช่องเกตเวย์ทั้งชั่วโมง)
      if (breakerOpen(now())) stopped = "breaker";
      else if (modeChanged(ctx)) stopped = "mode_changed";
      else if (now() - startedAt >= QUALIFY_SLOT_MAX_MS) stopped = "time";
      else if (called >= slotRoomCap) stopped = "room_cap";
      if (stopped) {
        // สวิตช์เปลี่ยน ≠ ชนเพดาน — ไม่นับห้องที่เหลือเป็น capped (ห้องเหลืองถูกคืนในนาทีถัดไปอยู่แล้ว)
        if (stopped !== "mode_changed") for (const [id] of queue.slice(index)) today(t).cappedRooms.add(id);
        const why = stopped === "room_cap" ? `ครบ ${slotRoomCap} ห้องแล้ว`
          : stopped === "time" ? `เดินครบ ${QUALIFY_SLOT_MAX_MS / 60_000} นาทีแล้ว`
            : stopped === "mode_changed" ? "สวิตช์ qualify_sweep_mode เปลี่ยนระหว่างรอบ หยุดทันที" : "โมเดลล้มติดกัน พักก่อน";
        logger.log?.(`[qualify-sweep] รอบ ${bangkokHHMM(ctx.slot)} ${why} — เหลือ ${left} ห้องไปรอบหน้า`);
        break;
      }
      const [customerId, purpose] = queue[index];
      const result = await evaluateSafely(customerId, purpose, ctx);
      results.push(result);
      if (result.called) called += 1;
      if (result.outcome === "capped") {
        stopped = "budget";
        noteCapped(t, result.reason, purpose, queue.slice(index).map(([id]) => id));
        break;
      }
    }
    return { rooms: rooms.length, called, results, ...(stopped ? { stopped } : {}) };
  }

  async function runDue() {
    if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
    try {
      if (isDraining()) return { skipped: "draining" };
      // รีวิวปรปักษ์รอบ 2 5 ต.ค.: อ่านสวิตช์พัง (เช่น SQLITE_BUSY) ≠ off — ข้ามนาทีนี้ทั้งหมด ไม่คืนห้อง ไม่กวาด
      const mode = readQualifySweepModeStrict(db);
      if (mode === null) {
        logger.warn?.("[qualify-sweep] อ่านสวิตช์ qualify_sweep_mode ไม่ได้ — ข้ามนาทีนี้ (ไม่คืนห้องเหลือง ไม่กวาด)");
        return { skipped: "db_error" };
      }
      // รีวิวปรปักษ์ 5 ต.ค. #3 #8 #16: สวิตช์ไม่ใช่ on = ครึ่งที่เปิดเขียวหยุดทำงาน → คืนห้องเหลืองทั้งหมดทุกนาที
      // (กดปิดฉุกเฉินแล้วห้องที่ตัดสินผิดต้องกลับมาตอบ ไม่ใช่เงียบและหายจากคิวรอตอบ)
      const released = mode === "on" ? 0 : releaseAllNotQualified({ db, now, reason: `mode_${mode}`, logger });
      const extra = released > 0 ? { released } : {};
      if (mode === "off") return { skipped: "switch_off", ...extra };
      if (!raw() || typeof hermes?.qualifyCustomer !== "function") return { skipped: "not_wired", ...extra };
      if (aiPausedNow({ db, config })) return { skipped: "ai_paused", ...extra };
      const t = now();
      today(t);
      breaker.consecutive = 0; // นับล้มติดกัน "ในรอบนี้"
      if (breakerOpen(t)) return { mode, ...extra, skipped: "breaker_open", until: breaker.until };
      const ctx = { mode, presetPhrases: presetButtonPhrases({ db }), slot: null };
      const rechecks = await runRechecks(t, ctx);
      // พักระหว่างตรวจซ้ำ = ไม่จองรอบ (พ้นพักภายใน 30 นาทีแรกของรอบ ยังกวาดรอบนี้ได้)
      if (breakerOpen(now())) return { mode, ...extra, rechecks, slot: { skipped: "breaker_open" } };
      let lastSlot = 0;
      try {
        lastSlot = Number(db.getSetting(QUALIFY_SWEEP_LAST_SLOT_KEY)) || 0;
      } catch {
        return { mode, ...extra, rechecks, slot: { skipped: "db_error" } }; // อ่านรอบไม่ได้ — ไม่เสี่ยงกวาดซ้ำ
      }
      const slotState = qualifySlotState(t, lastSlot);
      if (!slotState.due) return { mode, ...extra, rechecks, slot: { skipped: "not_due", at: slotState.slot } };
      // จองรอบก่อนทำงาน (at-most-once): ล้มกลางทางแล้วลองใหม่ทุกนาที = จ่ายเงินซ้ำกับห้องเดิม
      db.setSetting(QUALIFY_SWEEP_LAST_SLOT_KEY, String(slotState.slot));
      if (slotState.late) {
        logger.log?.(`[qualify-sweep] ข้ามรอบ ${bangkokHHMM(slotState.slot)} — เลยเวลามา ${Math.round((t - slotState.slot) / 60_000)} นาที`);
        return { mode, ...extra, rechecks, slot: { skipped: "too_late", at: slotState.slot } };
      }
      const slot = await runSlot(t, { ...ctx, slot: slotState.slot });
      logger.log?.(`[qualify-sweep] รอบ ${bangkokHHMM(slotState.slot)} (${mode}) ห้องที่ทักวันนี้ ${slot.rooms} · ตัดสิน ${slot.called}`);
      return { mode, ...extra, rechecks, slot: { at: slotState.slot, ...slot } };
    } catch (err) {
      logger.error?.(`qualify-sweep: รอบกวาดล้ม (${err?.message || err})`);
      return { skipped: "error" };
    } finally {
      lock.release();
    }
  }

  // รีวิวปรปักษ์รอบ 2 5 ต.ค.: ทำไมห้องเหลืองไม่ถูกตรวจ — บันทึกต้นทุนไม่ได้ > ตัวตัดวงจร > เพดานของวันนี้ (ตรวจเขียวก่อน)
  function blockedReason(t, counters) {
    if (usageBroken) return "usage_unrecorded";
    if (breakerOpen(t)) return "breaker";
    if (counters.capReason.green) return `${counters.capReason.green}:green`;
    if (counters.capReason.yellow) return `${counters.capReason.yellow}:yellow`;
    return null;
  }

  // ตัวเลขรวมสำหรับ /health เท่านั้น — ไม่มีรหัสห้อง ไม่มีเนื้อหา · thb อ่านจาก llm_usage (รอดการรีสตาร์ต)
  // ตัวนับอื่นอยู่ในหน่วยความจำ เริ่มใหม่ทุกวัน (เวลาไทย) และทุกครั้งที่รีสตาร์ต · breaker = สถานะตัวตัดวงจร (#17)
  // usageBroken = บันทึกต้นทุนไม่ได้ หยุดเรียกโมเดลจนรีสตาร์ต · blocked = เหตุที่หยุดเรียกโมเดลตอนนี้ (null = ไม่ได้หยุด)
  function stats() {
    const t = now();
    const counters = today(t);
    let thb = null;
    try {
      const spent = summarizeUsage(todayQualifyRows(t), pricingMap());
      thb = spent.unknownTokens > 0 ? null : Math.round(spent.usd * thbPerUsd() * 100) / 100;
    } catch { thb = null; }
    let lastSlot = null;
    try { lastSlot = Number(db.getSetting(QUALIFY_SWEEP_LAST_SLOT_KEY)) || null; } catch { lastSlot = null; }
    const open = breakerOpen(t);
    return {
      mode: qualifySweepMode(db),
      lastSlot,
      // รีวิวปรปักษ์รอบ 3 5 ต.ค.: runbook ก่อน rollback รอจน false — true = รอบกวาด/ตรวจซ้ำกำลังเดินอยู่ในนาทีนี้
      inFlight: lock.held,
      usageBroken,
      blocked: blockedReason(t, counters),
      today: {
        checked: counters.checked, yellow: counters.yellow, green: counters.green,
        unclear: counters.unclear, capped: counters.cappedRooms.size, thb,
      },
      breaker: { open, until: open ? breaker.until : null, trips: breaker.trips },
    };
  }

  function start() {
    if (timer || !(intervalMs > 0)) return false;
    timer = setInterval(() => {
      runDue().catch((err) => logger.error?.(`qualify-sweep: ${err?.message || err}`));
    }, intervalMs);
    timer.unref?.();
    logger.log?.(`[qualify-sweep] เดินทุก ${intervalMs}ms (รอบ ${QUALIFY_SWEEP_TIMES} เวลาไทย — สวิตช์ qualify_sweep_mode เช็คสดทุกรอบ)`);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runDue, start, stop, stats, get running() { return timer !== null; } };
}
