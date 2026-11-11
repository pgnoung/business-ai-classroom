// stepMessages.mjs — "ข้อความตามขั้น" (Step messages) ของคอนโซลลูกแพร (28 ก.ย. 2026)
//
// พี่ง้วงขอ (28 ก.ย. 2026): "ให้สร้างระบบ STEP MESSAGE เหมือน LINE OA เลย โดยตอนนี้ step message สามารถทำได้ ใน LINE OA เท่านั้น"
// ลำดับหนึ่งชุด = ทริกเกอร์ + ขั้น (สูงสุด 10) · ข้อความทุกขั้นเป็นข้อความสำเร็จรูปที่คนเขียนและอนุมัติ (ไม่มี AI เขียนสดในรุ่นแรก)
//
// ทริกเกอร์ (นับเฉพาะเหตุการณ์หลังเวลาเปิดใช้ trigger_since):
//   follow     — เพิ่มเพื่อนใหม่ (webhook follow ที่ไม่ใช่การเลิกบล็อก)
//   keyword    — ลูกค้าพิมพ์ #คำ (เช่น #ของแจก) — ตัวรับข้อความเรียก onInboundMessage
//   tag        — ติดป้าย (ตรงตัว หรือทั้งมิติ "ของแจก:*") — สแกนทุกรอบ · คนที่มีป้ายอยู่ก่อนเปิดใช้ = baseline ไม่ได้รับ
//   order_paid — ออเดอร์ชำระแล้ว (ข้อความเตรียมเรียน/เอกสารเท่านั้น — ลูกค้าที่ซื้อแล้วทีมดูแล 100%)
//
// หยุดทันที (ตรวจใหม่ทุกครั้งก่อนส่ง): ซื้อแล้ว/ป้าย customer/ซื้อครั้งที่ · สแปม (null) · ขอหยุดทัก/ปฏิเสธการตลาด ·
//   บล็อก OA · ทีมรับห้องต่อหรือ AI ปิด · เรื่องเงิน (รอชำระ/ส่งสลิป/ใบเสนอราคา) · โหมดบริการ · ลูกค้าตอบ (ถ้าเลือกไว้) ·
//   ไม่มีป้ายเงื่อนไขแล้ว (ทริกเกอร์ป้าย) · ออเดอร์ถูกยกเลิก (ทริกเกอร์ออเดอร์) · ปิดลำดับ
//
// ลำดับความสำคัญกับ "ทักตาม" (stagedFollowups) — ลูกค้าไม่มีวันได้ข้อความตามขั้นกับทักตามในวันเดียวกัน:
//   1. ทักอัตโนมัติ LINE วันละครั้งก้อนเดียวกัน: ส่งขั้นแล้วบวก followup_state.sent_today (ทักตามเห็น daily_cap)
//      และขั้นจะเลื่อนไปพรุ่งนี้ถ้าวันนี้มีข้อความเชิงรุกใด ๆ ออกไปแล้ว (ทักตาม/YOLO/ทักหลังส่งบัญชี/บรอดแคสต์)
//   2. ทักตามมาก่อน: ถ้าบันไดทักตามของลูกค้าจะถึงกำหนดภายในวันนี้ ขั้นเลื่อนไปพรุ่งนี้ (คุยจริงสำคัญกว่าข้อความชุด)
//   3. ไม่แทรกบทสนทนาสด: มีข้อความคุยกัน (ทิศใดก็ได้) ใน 2 ชม. ล่าสุด หรือทีมกำลังคุมห้อง = เลื่อน
//   4. ไม่ส่งช่วง 21:00–09:00 (เวลาไทย) — เลื่อนไป 09:00 + สุ่มไม่เกิน 40 นาที
// สวิตช์รวม settings.step_messages_mode: ไม่มีแถว = on (ทำงานเฉพาะลำดับที่ถูกเปิดใช้โดยคน) · off = หยุดรับคนและหยุดส่งทุกชุด
import { createHash, randomUUID } from "node:crypto";
import { buildBroadcastMessages, storedMessageLogRow } from "./broadcastMessages.mjs";
import { aggregationUnitFor, createLinkCollector, trackingBaseUrl } from "./broadcastStudio.mjs";
import { bangkokDay, SEND_PURPOSE } from "./lineSendLedger.mjs";
import { inQuietHours, nextQuietEnd } from "./followupEngine.mjs";
import { aiPausedNow } from "./aiPause.mjs";
import { serviceFollowupPaused } from "./serviceBoundary.mjs";
import { followupThreadEnabled, followupThreadPickFor, paymentHoldActive, previewStagedFollowup } from "./stagedFollowups.mjs";
import { CUSTOMER_HANDOVER_REASON } from "./pipeline.mjs";
import { scheduleCheckFollowupEnabled } from "./scheduleCheck.mjs";
import { STEP_TRIGGERS } from "./dbStepMessages.mjs";
import { isSpamTag } from "./spamTag.mjs";
import { createLock } from "./locks.mjs";

export const STEP_MESSAGES_MODE_KEY = "step_messages_mode";
const LEGACY_IMPORT_TAG = "ย้ายจาก LINE OA";
export const STEP_LIMITS = Object.freeze({
  maxSteps: 10, maxActivePerChannel: 20, maxDelayDays: 30, maxDelayHours: 72, minDelayHours: 1,
  nameMax: 60, keywordMax: 40, conditionTagsMax: 5,
});
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BKK_OFFSET_MS = 7 * HOUR_MS;
export const LIVE_CONVERSATION_QUIET_MS = 2 * HOUR_MS;
const OPERATOR_GRACE_MS = 30 * MINUTE_MS;
const MORNING_JITTER_MS = 40 * MINUTE_MS;
const SENDS_PER_TICK = 20;
const QUOTA_RESERVE_MIN = 200;
const QUOTA_RESERVE_RATIO = 0.03;
// เรื่องเงินอยู่ที่ทีม: รอเลือกรอบ/ใบเสนอราคา/รอชำระ = หยุด (ข้อความชุดห้ามแทรกจังหวะปิดการขาย)
const MONEY_LINE_DEALS = new Set(["quote_sent", "awaiting_payment"]);
const PURCHASED_DEALS = new Set(["paid_confirmed", "prep_sent"]);
const KEYWORD_RE = /^[\p{L}\p{N}_-]{1,40}$/u;
const TIME_RE = /^(\d{2}):(\d{2})$/u;

export const STOP_REASON_LABELS = Object.freeze({
  purchased: "ซื้อแล้ว", spam: "สแปม (null)", dnd: "ขอหยุดการทัก", marketing_optout: "ปฏิเสธการตลาด",
  unfollowed: "บล็อก OA", human_takeover: "ทีมรับห้องต่อ/AI ปิด", money_line: "เรื่องเงินอยู่กับทีม",
  customer_replied: "ลูกค้าตอบกลับ", left_segment: "ไม่มีป้ายเงื่อนไขแล้ว", order_cancelled: "ออเดอร์ถูกยกเลิก",
  service_boundary: "โหมดบริการ", urgent_care: "ส่งต่อคนดูแลด่วน", sequence_archived: "ปิดลำดับนี้",
  delivery_unknown: "ผลส่งไม่ชัด (ไม่ส่งซ้ำ)", send_rejected: "LINE ปฏิเสธ", guard_blocked: "ข้อความไม่ผ่านตัวกันราคา",
  customer_missing: "ไม่พบห้องแชท", delivery_fenced: "ขั้นนี้เคยพยายามส่งแล้ว", legacy_import: "ห้องประวัติจาก OA เดิม (ส่งไม่ถึง)",
});
export const DEFER_REASON_LABELS = Object.freeze({
  quiet_hours: "ช่วงเงียบ 21:00–09:00", live_conversation: "กำลังคุยกันอยู่", operator_active: "ทีมกำลังคุมห้อง",
  daily_cap: "วันนี้ทักไปแล้ว", followup_first: "ทักตามมาก่อนวันนี้", quota_reserve: "เก็บโควตาไว้ตอบลูกค้า",
  quota_unknown: "อ่านโควตาไม่ได้", rate_limited: "LINE ให้รอ", send_unavailable: "ช่องส่งยังไม่พร้อม",
});

export function stepMessagesMode(db) {
  try {
    const stored = db.getSetting(STEP_MESSAGES_MODE_KEY);
    return stored === "off" ? "off" : "on";
  } catch {
    return "off"; // อ่านไม่ได้ = ปิดไว้ก่อน
  }
}

function hashUnit(...parts) {
  return createHash("sha256").update(parts.map(String).join("|")).digest().readUInt32BE(0) / 2 ** 32;
}

function bangkokDayStart(ms) {
  return Math.floor((Number(ms) + BKK_OFFSET_MS) / DAY_MS) * DAY_MS - BKK_OFFSET_MS;
}

function nextMorning(ms, seed) {
  return nextQuietEnd(ms) + Math.round(hashUnit(seed, ms) * MORNING_JITTER_MS);
}

/** เวลาถึงกำหนดของขั้น — นับจาก anchor (เข้าลำดับ/ขั้นก่อนหน้า) แล้วเลี่ยงช่วงเงียบ */
export function stepDueAt(step, anchorMs, seed = "") {
  const anchor = Number(anchorMs);
  let due;
  if (step?.delay?.kind === "days") {
    const match = TIME_RE.exec(String(step.delay.at || "10:00"));
    const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : 600;
    due = bangkokDayStart(anchor) + Number(step.delay.days) * DAY_MS + minutes * MINUTE_MS;
  } else {
    due = anchor + Number(step?.delay?.hours || 1) * HOUR_MS;
  }
  return inQuietHours(due) ? nextMorning(due, seed) : due;
}

export function keywordMatches(text, keyword) {
  const needle = `#${String(keyword || "").normalize("NFC").toLocaleLowerCase("th-TH")}`;
  const haystack = String(text || "").normalize("NFC").toLocaleLowerCase("th-TH");
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? " " : haystack[index - 1];
    const rest = haystack.slice(index + needle.length);
    const boundaryBefore = /[\s(（「"'“]/u.test(before);
    const boundaryAfter = !rest || /^[\s.,!?…:;)）」"'”]/u.test(rest) || /^(?:ค่ะ|คะ|ครับ|นะ|จ้า|จ้ะ|ค่า)/u.test(rest);
    if (boundaryBefore && boundaryAfter) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function tagPrefixOf(value) {
  const match = /^(.+?)\s*:\s*\*$/u.exec(String(value || "").trim());
  return match ? `${match[1].trim()}:` : "";
}

function hasTagMatching(tags, wanted) {
  const prefix = tagPrefixOf(wanted);
  return tags.some((tag) => (prefix ? tag.startsWith(prefix) : tag === wanted));
}

/* ------------------------------- validation ------------------------------- */

function normalizeCondition(raw) {
  const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map((t) => String(t || "").trim()).filter(Boolean))];
  const hasTags = clean(raw?.hasTags);
  const hasNotTags = clean(raw?.hasNotTags);
  if (hasTags.length > STEP_LIMITS.conditionTagsMax || hasNotTags.length > STEP_LIMITS.conditionTagsMax) {
    return { error: `เงื่อนไขป้ายได้ไม่เกิน ${STEP_LIMITS.conditionTagsMax} ป้ายต่อฝั่ง` };
  }
  return { condition: hasTags.length || hasNotTags.length ? { hasTags, hasNotTags } : null };
}

function normalizeDelay(raw, index) {
  if (raw?.kind === "days") {
    const days = Number(raw.days);
    const at = String(raw.at || "10:00");
    const match = TIME_RE.exec(at);
    if (!Number.isInteger(days) || days < 1 || days > STEP_LIMITS.maxDelayDays) return { error: `ขั้นที่ ${index + 1}: จำนวนวันต้อง 1–${STEP_LIMITS.maxDelayDays}` };
    const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : -1;
    if (!match || Number(match[2]) > 59 || minutes < 9 * 60 || minutes > 20 * 60 + 30) {
      return { error: `ขั้นที่ ${index + 1}: เวลาส่งต้องอยู่ช่วง 09:00–20:30` };
    }
    return { delay: { kind: "days", days, at } };
  }
  const hours = Number(raw?.hours);
  if (!Number.isInteger(hours) || hours < STEP_LIMITS.minDelayHours || hours > STEP_LIMITS.maxDelayHours) {
    return { error: `ขั้นที่ ${index + 1}: หน่วงเป็นชั่วโมงได้ ${STEP_LIMITS.minDelayHours}–${STEP_LIMITS.maxDelayHours} ชม.` };
  }
  return { delay: { kind: "hours", hours } };
}

/**
 * ตรวจลำดับขั้นจากคอนโซล → { sequence } หรือ { error }
 * ข้อความทุกขั้นประกอบจริง + ผ่านตัวกันราคาตั้งแต่ตอนบันทึก (ตรวจซ้ำตอนเปิดใช้และตอนส่ง)
 */
export function validateStepSequenceInput(body, { imageCatalogByKey = new Map(), guardCheck = () => ({ ok: true }) } = {}) {
  const name = String(body?.name || "").trim();
  if (!name || name.length > STEP_LIMITS.nameMax) return { error: `ตั้งชื่อลำดับ 1–${STEP_LIMITS.nameMax} ตัวอักษร` };
  const triggerType = String(body?.triggerType || "");
  if (!STEP_TRIGGERS.includes(triggerType)) return { error: "เลือกทริกเกอร์ของลำดับ" };
  let triggerValue = String(body?.triggerValue || "").trim();
  if (triggerType === "keyword") {
    triggerValue = triggerValue.replace(/^#/u, "").normalize("NFC");
    if (!KEYWORD_RE.test(triggerValue)) return { error: "คีย์เวิร์ดต้องเป็นคำเดียว (ตัวอักษร/ตัวเลข ไม่เกิน 40 ตัว) เช่น ของแจก" };
  } else if (triggerType === "tag") {
    if (!triggerValue || triggerValue.length > 60 || isSpamTag(triggerValue)) return { error: "เลือกป้ายที่เป็นทริกเกอร์" };
  } else {
    triggerValue = "";
  }
  const rawSteps = Array.isArray(body?.steps) ? body.steps : [];
  if (!rawSteps.length) return { error: "ต้องมีอย่างน้อย 1 ขั้น" };
  if (rawSteps.length > STEP_LIMITS.maxSteps) return { error: `มีได้ไม่เกิน ${STEP_LIMITS.maxSteps} ขั้นต่อลำดับ` };
  const steps = [];
  for (const [index, raw] of rawSteps.entries()) {
    const delay = normalizeDelay(raw?.delay, index);
    if (delay.error) return delay;
    const condition = normalizeCondition(raw?.condition);
    if (condition.error) return { error: `ขั้นที่ ${index + 1}: ${condition.error}` };
    const built = buildBroadcastMessages(raw?.messages, { imageCatalogByKey });
    if (built.error) return { error: `ขั้นที่ ${index + 1}: ${built.error}` };
    const guarded = guardCheck(built.messages);
    if (!guarded.ok) return { error: `ขั้นที่ ${index + 1}: ${guarded.error}` };
    steps.push({ delay: delay.delay, condition: condition.condition, messages: built.stored });
  }
  return {
    sequence: {
      name, triggerType, triggerValue, stopOnReply: body?.stopOnReply === true, steps,
      channelId: String(body?.channelId || "default"),
    },
  };
}

/* --------------------------------- engine --------------------------------- */

export function createStepMessages({
  db, config = {}, engine = null, lineRegistry = null, getImageCatalogByKey = () => new Map(),
  logger = console, now = Date.now,
} = {}) {
  const lock = createLock();
  const owner = randomUUID();
  let timer = null;
  let lastRun = null;
  const guardCheck = (messages) => (engine?.guardCheck ? engine.guardCheck(messages) : { ok: true });

  function audit(action, target, detail) {
    try { db.addAudit({ operator: "system", action, target, detail: String(detail || "").slice(0, 200) }); }
    catch (error) { logger.warn?.(`stepMessages: audit ไม่สำเร็จ (${error?.message || error})`); }
  }

  const enabled = () => stepMessagesMode(db) === "on";

  function stagedFollowupsOn() {
    if (!(Number(config.stagedFollowupTickMs) > 0)) return false;
    try {
      const stored = db.getSetting("staged_followup_enabled");
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch { return true; } // อ่านไม่ได้ = ถือว่าทักตามอาจเกิด → ข้อความตามขั้นถอยให้ (ทางปลอดภัย)
    return config.stagedFollowupEnabled === true;
  }

  function enroll(sequence, customerId, at, detail) {
    const first = sequence.steps[0];
    if (!first) return false;
    const inserted = db.enrollStepCustomer({
      sequenceId: sequence.id, customerId, channelId: sequence.channel_id, at,
      dueAt: stepDueAt(first, at, `${sequence.id}|${customerId}|0`), detail,
    });
    if (inserted) audit("step_enrolled", sequence.channel_id, `sequence=${sequence.id}; trigger=${sequence.trigger_type}`);
    return inserted;
  }

  // webhook follow/unfollow (หลังบันทึกสถานะเพื่อนแล้ว) — บล็อก = หยุดทุกลำดับของคนนั้น
  function onFollowEvent({ channelId, customerId, followed, unblocked = false, at = now() } = {}) {
    if (!followed) {
      const stopped = db.stopStepEnrollmentsForCustomer(customerId, "unfollowed");
      if (stopped) audit("step_stopped", channelId, `reason=unfollowed; count=${stopped}`);
      return { stopped };
    }
    if (unblocked || !enabled()) return { enrolled: 0 };
    const sequences = db.activeStepSequences({ channel: channelId, triggerType: "follow" })
      .filter((sequence) => Number(sequence.trigger_since) <= Number(at));
    if (!sequences.length) return { enrolled: 0 };
    ensureCustomerRow(channelId, customerId);
    let enrolled = 0;
    for (const sequence of sequences) {
      if (enroll(sequence, customerId, Number(at), "follow")) enrolled += 1;
    }
    return { enrolled };
  }

  // เพื่อนใหม่ที่ยังไม่เคยพิมพ์ = ยังไม่มีแถวลูกค้า (แถวเกิดตอนข้อความแรก) — สร้างให้เฉพาะคนที่เข้าลำดับ
  // เพื่อให้ด่านหยุด (DND/ทีมรับห้อง/ป้าย) ทำงาน และห้องแชทเห็นข้อความต้อนรับที่ส่งไป
  // ทักตามอัตโนมัติไม่แตะคนกลุ่มนี้ (ต้องมีข้อความขาเข้าก่อน) · ชื่อ LINE ดึงแบบไม่รอ พังได้ไม่เป็นไร
  function ensureCustomerRow(channelId, customerId) {
    if (db.getCustomer(customerId)) return;
    db.upsertCustomer(customerId, { channelId });
    try {
      const client = lineRegistry?.forChannel?.(channelId);
      const userId = lineRegistry?.rawUserId ? lineRegistry.rawUserId(customerId) : customerId;
      if (client?.getProfile) {
        Promise.resolve(client.getProfile({ userId }))
          .then((profile) => { if (profile) db.setProfile(customerId, profile); })
          .catch(() => {});
      }
    } catch { /* ชื่อเป็นของแถม */ }
  }

  // ข้อความลูกค้า (หลังบันทึกลงฐาน) — หยุดลำดับที่เลือก "หยุดเมื่อลูกค้าตอบ" แล้วค่อยรับคนเข้าลำดับคีย์เวิร์ด
  function onInboundMessage({ channelId, customerId, text = "", at = now() } = {}) {
    const stopped = db.stopStepEnrollmentsForCustomer(customerId, "customer_replied", { onlyStopOnReply: true, enrolledBefore: at });
    if (!enabled() || !String(text || "").includes("#")) return { stopped, enrolled: 0 };
    let enrolled = 0;
    for (const sequence of db.activeStepSequences({ channel: channelId, triggerType: "keyword" })) {
      if (Number(sequence.trigger_since) > Number(at)) continue;
      if (keywordMatches(text, sequence.trigger_value) && enroll(sequence, customerId, Number(at), `keyword:${sequence.trigger_value}`)) enrolled += 1;
    }
    return { stopped, enrolled };
  }

  // ป้าย/ออเดอร์ = สแกนทุกรอบ (ไม่ผูก hook กับทุกจุดที่ติดป้าย — ป้ายเกิดได้จากหลายทาง)
  function scanTriggers(at) {
    let enrolled = 0;
    for (const sequence of db.activeStepSequences()) {
      if (sequence.trigger_type === "tag") {
        const prefix = tagPrefixOf(sequence.trigger_value);
        for (const row of db.stepTagTriggerCandidates({
          sequenceId: sequence.id, channelId: sequence.channel_id, tag: sequence.trigger_value, prefix,
          since: sequence.trigger_since,
        })) {
          if (enroll(sequence, row.customer_id, at, `tag:${sequence.trigger_value}`)) enrolled += 1;
        }
      } else if (sequence.trigger_type === "order_paid") {
        for (const row of db.stepPaidOrderCandidates({ sequenceId: sequence.id, channelId: sequence.channel_id, since: sequence.trigger_since })) {
          if (enroll(sequence, row.customer_id, at, "order_paid")) enrolled += 1;
        }
      }
    }
    return enrolled;
  }

  // ตรวจ "หยุดถาวร" สดทุกครั้งก่อนส่ง — คืนเหตุผล หรือ "" ถ้ายังส่งต่อได้
  function stopReason(sequence, enrollment, customer, tags) {
    if (!customer) return "customer_missing";
    const lowered = tags.map((tag) => tag.toLowerCase());
    if (lowered.some(isSpamTag)) return "spam";
    // ห้องประวัติที่ย้ายมาจาก LINE OA เดิม = userId คนละชุดกับ Messaging API ส่งไปก็ไม่ถึง (กติกาเดียวกับบรอดแคสต์)
    if (tags.includes(LEGACY_IMPORT_TAG)) return "legacy_import";
    if (Number(customer.do_not_disturb) === 1) return "dnd";
    if (Number(customer.marketing_consent ?? 0) < 0) return "marketing_optout";
    if (db.lineFollowState(customer.line_user_id)?.state === "unfollowed") return "unfollowed";
    if (customer.ai_off_reason === "urgent_mental") return "urgent_care";
    const paidTrigger = sequence.trigger_type === "order_paid";
    // ลำดับ "ออเดอร์ชำระแล้ว" ส่งถึงคนที่ซื้อแล้วเท่านั้น ซึ่งถูกปิด AI ด้วยป้าย customer เสมอ (ทีมดูแล 100%)
    // — ยกเว้นเฉพาะเหตุนั้นเหตุเดียว · ปิด AI ด้วยเหตุอื่น (ทีมรับห้อง/ดูแลใจ/ไม่ใช่ลูกค้า) = หยุดเหมือนเดิม
    const purchaseHandover = paidTrigger && customer.ai_off_reason === CUSTOMER_HANDOVER_REASON;
    if (Number(customer.ai_enabled) !== 1 && !purchaseHandover) return "human_takeover";
    if (serviceFollowupPaused(customer)) return "service_boundary";
    if (!paidTrigger) {
      if (lowered.includes("customer") || tags.some((tag) => /^ซื้อครั้งที่\s*:/u.test(tag))
          || PURCHASED_DEALS.has(String(customer.deal_status)) || db.customerHasPaidOrder(customer.line_user_id)) {
        return "purchased";
      }
    } else if (!db.customerHasPaidOrder(customer.line_user_id)) {
      return "order_cancelled";
    }
    if (MONEY_LINE_DEALS.has(String(customer.deal_status))
        || paymentHoldActive({ handoffSummary: customer.handoff_summary, nowMs: now(), lastInboundAt: db.lastInboundAt(customer.line_user_id) })
        || db.customerSlipSince(customer.line_user_id, enrollment.enrolled_at)) {
      return "money_line";
    }
    if (sequence.stop_on_reply && db.inboundSince(customer.line_user_id, enrollment.enrolled_at)) return "customer_replied";
    if (sequence.trigger_type === "tag" && !hasTagMatching(tags, sequence.trigger_value)) return "left_segment";
    return "";
  }

  // ตรวจ "ยังไม่ใช่ตอนนี้" — คืน { until, reason } หรือ null
  function deferral(enrollment, customer, at) {
    const seed = enrollment.id;
    if (inQuietHours(at)) return { until: nextMorning(at, seed), reason: "quiet_hours" };
    const operatorUntil = Number(customer.operator_active_until) || 0;
    if (operatorUntil > at) return { until: operatorUntil + OPERATOR_GRACE_MS, reason: "operator_active" };
    const lastTalk = db.lastConversationAt(customer.line_user_id);
    if (lastTalk && at - lastTalk < LIVE_CONVERSATION_QUIET_MS) {
      const until = lastTalk + LIVE_CONVERSATION_QUIET_MS;
      return { until: inQuietHours(until) ? nextMorning(until, seed) : until, reason: "live_conversation" };
    }
    const todayStart = bangkokDayStart(at);
    const tomorrow = nextMorning(todayStart + DAY_MS - HOUR_MS, seed); // 09:00 พรุ่งนี้ + สุ่ม
    const state = db.getFollowupState(customer.line_user_id);
    if ((state?.today_key === bangkokDay(at) && Number(state.sent_today) >= 1) || db.proactiveSentSince(customer.line_user_id, todayStart)) {
      return { until: tomorrow, reason: "daily_cap" };
    }
    if (stagedFollowupsOn()) {
      try {
        const preview = previewStagedFollowup({
          customer, state, lastInboundAt: db.lastInboundAt(customer.line_user_id),
          lastOutboundAt: db.lastOutboundAt(customer.line_user_id), nowMs: at,
          scheduleCheck: scheduleCheckFollowupEnabled(db),
          // รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 C3): ห้อง v3 ที่ทักตามจะไม่ยิง (ไม่มีเรื่องค้าง/ลูกค้าปิดเอง) ไม่ต้องเลื่อนข้อความตามขั้นไปพรุ่งนี้
          threadPick: followupThreadEnabled(db)
            ? ({ history }) => followupThreadPickFor({ db, config, customer, history, nowMs: at, logger })
            : null,
        });
        if (preview?.dueAt && preview.dueAt < todayStart + DAY_MS) return { until: tomorrow, reason: "followup_first" };
      } catch (error) {
        logger.debug?.(`stepMessages: อ่านบันไดทักตามไม่สำเร็จ (${error?.message || error})`);
      }
    }
    return null;
  }

  function trackerFor(sequence, stepNo) {
    const base = trackingBaseUrl(config);
    const links = base ? db.stepSequenceLinks(sequence).filter((link) => Number(link.step_no) === stepNo) : [];
    if (!links.length) return null;
    let index = 0;
    return ({ url }) => {
      const link = links[index++];
      return link && link.url === url ? `${base}/r/${link.token}` : url;
    };
  }

  // ลิงก์นับคลิกของทุกขั้น สร้างครั้งเดียวตอนเปิดใช้ (ผูกกับ version) — ทุกคนที่ได้ขั้นเดียวกันใช้ลิงก์ชุดเดียว = นับรวมต่อขั้น
  function activationLinks(sequence) {
    const base = trackingBaseUrl(config);
    if (!base) return [];
    const links = [];
    for (const [stepNo, step] of sequence.steps.entries()) {
      const collector = createLinkCollector(base);
      buildBroadcastMessages(step.messages, { imageCatalogByKey: getImageCatalogByKey(), linkTracker: collector.tracker });
      for (const link of collector.links) links.push({ ...link, stepNo });
    }
    return links;
  }

  function logDelivery(customerId, channelId, stored, sequence, stepNo) {
    for (const message of stored) {
      const row = storedMessageLogRow(message, "(step)");
      try {
        db.insertMessage({
          customerId, direction: "out", msgType: row.msgType, content: row.content, channelId,
          metadata: { ...row.metadata, stepMessage: { sequenceId: sequence.id, step: stepNo + 1 } },
          messageClass: "proactive", operator: "", agentMode: "step_message",
        });
      } catch (error) {
        logger.debug?.(`stepMessages: บันทึกประวัติแชทไม่สำเร็จ (${error?.message || error})`);
      }
    }
  }

  async function sendStep({ sequence, enrollment, customer, stepNo, step, quotaState }) {
    const client = lineRegistry?.forChannel?.(sequence.channel_id);
    if (!client?.sendAllowed?.()) return { outcome: "defer", until: now() + HOUR_MS, reason: "send_unavailable" };
    const built = buildBroadcastMessages(step.messages, { imageCatalogByKey: getImageCatalogByKey(), linkTracker: trackerFor(sequence, stepNo) });
    if (built.error) return { outcome: "stop", reason: "send_rejected", detail: built.error, pause: true };
    const guarded = guardCheck(built.messages);
    if (!guarded.ok) return { outcome: "stop", reason: "guard_blocked", detail: guarded.error, pause: true };
    if (quotaState.remaining !== null && quotaState.remaining - 1 < quotaState.reserve) {
      return { outcome: "defer", until: nextMorning(now() + 12 * HOUR_MS, enrollment.id), reason: "quota_reserve" };
    }
    if (!db.beginStepDelivery({ enrollmentId: enrollment.id, sequenceId: sequence.id, stepNo, customerId: customer.line_user_id })) {
      return { outcome: "stop", reason: "delivery_fenced" };
    }
    const to = lineRegistry.rawUserId ? lineRegistry.rawUserId(customer.line_user_id) : customer.line_user_id;
    let result;
    try {
      result = await client.pushMessages({
        to, messages: built.messages, retryKey: randomUUID(),
        aggregationUnit: aggregationUnitFor("step", sequence.id, stepNo + 1), purpose: SEND_PURPOSE.stepMessage,
      });
    } catch (error) {
      result = { ok: false, ambiguous: true, status: 0, error: String(error?.message || error) };
    }
    const status = Number(result?.status) || 0;
    if (result?.ok) {
      db.settleStepDelivery({ enrollmentId: enrollment.id, stepNo, status: "sent", requestId: result.requestId || "" });
      if (quotaState.remaining !== null) quotaState.remaining -= 1;
      return { outcome: "sent", built };
    }
    if (result?.ambiguous || (!result?.blocked && (status === 0 || status >= 500))) {
      db.settleStepDelivery({ enrollmentId: enrollment.id, stepNo, status: "unknown", reason: `ambiguous_${status}` });
      return { outcome: "stop", reason: "delivery_unknown" };
    }
    if (result?.blocked || status === 429) {
      // ยังไม่ข้ามเส้น provider (ช่องปิด) หรือ LINE ปฏิเสธชัดว่ายังไม่รับ — ถอดด่านแล้วลองใหม่ภายหลัง
      db.clearStepDelivery({ enrollmentId: enrollment.id, stepNo });
      return { outcome: "defer", until: now() + HOUR_MS, reason: status === 429 ? "rate_limited" : "send_unavailable", haltChannel: true };
    }
    db.settleStepDelivery({ enrollmentId: enrollment.id, stepNo, status: "failed", reason: `http_${status}` });
    return { outcome: "stop", reason: "send_rejected" };
  }

  async function processEnrollment(enrollment, at, quotaFor) {
    const sequence = db.getStepSequence(enrollment.sequence_id);
    if (!sequence || sequence.status !== "active") {
      db.releaseStepEnrollment(enrollment.id, owner);
      return { skipped: "sequence_inactive" };
    }
    const customer = db.getCustomer(enrollment.customer_id);
    const tags = customer ? db.listTags(customer.line_user_id).map((row) => row.tag) : [];
    const reason = stopReason(sequence, enrollment, customer, tags);
    if (reason) {
      db.stopStepEnrollment(enrollment.id, reason);
      return { stopped: reason };
    }
    const stepNo = Number(enrollment.next_step);
    const step = sequence.steps[stepNo];
    if (!step) {
      db.advanceStepEnrollment(enrollment.id, { nextStep: stepNo, anchorAt: at, completed: true });
      return { completed: true };
    }
    const hold = deferral(enrollment, customer, at);
    if (hold) {
      db.deferStepEnrollment(enrollment.id, hold);
      return { deferred: hold.reason };
    }
    const nextOf = (anchorAt) => {
      const nextStep = stepNo + 1;
      const next = sequence.steps[nextStep];
      return next
        ? { nextStep, anchorAt, dueAt: stepDueAt(next, anchorAt, `${sequence.id}|${enrollment.customer_id}|${nextStep}`) }
        : { nextStep, anchorAt, completed: true };
    };
    const condition = step.condition;
    if (condition && (condition.hasTags.some((tag) => !hasTagMatching(tags, tag)) || condition.hasNotTags.some((tag) => hasTagMatching(tags, tag)))) {
      db.beginStepDelivery({ enrollmentId: enrollment.id, sequenceId: sequence.id, stepNo, customerId: customer.line_user_id, status: "skipped", reason: "condition" });
      db.advanceStepEnrollment(enrollment.id, nextOf(at));
      return { skippedStep: stepNo + 1 };
    }
    const quotaState = await quotaFor(sequence.channel_id);
    if (!quotaState.known) {
      db.deferStepEnrollment(enrollment.id, { until: at + HOUR_MS, reason: "quota_unknown" });
      return { deferred: "quota_unknown" };
    }
    const sent = await sendStep({ sequence, enrollment, customer, stepNo, step, quotaState });
    if (sent.outcome === "sent") {
      const sentAt = now();
      logDelivery(customer.line_user_id, sequence.channel_id, sent.built.stored, sequence, stepNo);
      try { db.markProactiveUsedToday(customer.line_user_id, bangkokDay(sentAt)); } catch { /* ด่านกันซ้อนในวันเดียวยังมี proactiveSentSince */ }
      db.advanceStepEnrollment(enrollment.id, { ...nextOf(sentAt), sentAt });
      audit("step_sent", sequence.channel_id, `sequence=${sequence.id}; step=${stepNo + 1}`);
      return { sent: stepNo + 1 };
    }
    if (sent.outcome === "defer") {
      db.deferStepEnrollment(enrollment.id, { until: sent.until, reason: sent.reason });
      return { deferred: sent.reason, haltChannel: sent.haltChannel === true };
    }
    db.stopStepEnrollment(enrollment.id, sent.reason);
    if (sent.pause) {
      db.pauseStepSequence(sequence.id, { pausedBy: "system:guard" });
      audit("step_sequence_paused", sequence.channel_id, `sequence=${sequence.id}; reason=${sent.reason}; ${sent.detail || ""}`);
    }
    return { stopped: sent.reason };
  }

  async function runTick() {
    const at = now();
    if (!enabled()) return { skipped: "mode_off" };
    if (aiPausedNow({ db, config })) return { skipped: "ai_paused" };
    try { db.recoverStaleStepDeliveries({ at }); } catch (error) { logger.warn?.(`stepMessages: กู้สถานะค้างไม่สำเร็จ (${error?.message || error})`); }
    let enrolled = 0;
    try { enrolled = scanTriggers(at); } catch (error) { logger.warn?.(`stepMessages: สแกนทริกเกอร์ไม่สำเร็จ (${error?.message || error})`); }
    const due = db.claimDueStepEnrollments({ at, limit: SENDS_PER_TICK, owner });
    const quotas = new Map();
    const halted = new Set();
    const quotaFor = async (channelId) => {
      if (quotas.has(channelId)) return quotas.get(channelId);
      let state = { known: false, remaining: null, reserve: 0 };
      try {
        const quota = await engine?.quotaFor?.(channelId, { fresh: true });
        if (quota?.type === "none" && Number.isSafeInteger(quota.totalUsage)) state = { known: true, remaining: null, reserve: 0 };
        else if (quota?.type === "limited" && Number.isSafeInteger(quota.value) && Number.isSafeInteger(quota.totalUsage)) {
          state = {
            known: true, remaining: quota.value - quota.totalUsage,
            reserve: Math.max(QUOTA_RESERVE_MIN, Math.ceil(quota.value * QUOTA_RESERVE_RATIO)),
          };
        }
      } catch { /* ไม่รู้โควตา = ไม่ส่ง */ }
      quotas.set(channelId, state);
      return state;
    };
    const results = [];
    for (const enrollment of due) {
      if (halted.has(enrollment.channel_id) || !enabled()) {
        db.releaseStepEnrollment(enrollment.id, owner);
        continue;
      }
      try {
        const result = await processEnrollment(enrollment, now(), quotaFor);
        if (result.haltChannel) halted.add(enrollment.channel_id);
        results.push(result);
      } catch (error) {
        logger.error?.(`stepMessages: ${enrollment.id} ล้มเหลว (${error?.message || error})`);
        db.releaseStepEnrollment(enrollment.id, owner);
        results.push({ error: true });
      }
    }
    lastRun = { at, enrolled, processed: results.length };
    return { enrolled, results };
  }

  async function runOnce() {
    if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
    try { return await runTick(); } finally { lock.release(); }
  }

  function tickMs() {
    const value = Number(config.stepMessagesTickMs ?? 60_000);
    return value > 0 ? Math.min(5 * MINUTE_MS, Math.max(15_000, value)) : 0;
  }

  function start() {
    if (timer || !tickMs() || !engine) return false;
    timer = setInterval(() => {
      runOnce().catch((error) => logger.error?.(`stepMessages: รอบล้มเหลว (${error?.message || error})`));
    }, tickMs());
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    onFollowEvent, onInboundMessage, runOnce, start, stop, activationLinks, guardCheck,
    armed: () => Boolean(timer), lastRun: () => lastRun, owner,
  };
}
