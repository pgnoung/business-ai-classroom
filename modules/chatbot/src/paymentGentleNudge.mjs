// paymentGentleNudge.mjs — ทักเบา ๆ หนึ่งครั้งหลังส่งเลขบัญชี (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//
// พี่ง้วงถูกถาม "จะให้มีข้อความทวงโอนหลังส่งเลขบัญชีกลับมาไหม" → "ขอแบบละมุนที่สุดครับ"
//
// ก่อนหน้านี้ (ตั้งแต่ 5 ก.ย.): ส่งบล็อกบัญชีแล้ว = ไม่มีข้อความอัตโนมัติตามเลย — เส้น AI ปิด (เดิม) ปิดห้องทั้งห้อง
// ส่วนเส้น SALES_DECISION_GUARD (ขึ้นจริง 28 ก.ย.) เปิด AI ไว้ตอบคำถาม แต่ปิด followup_enabled ของห้อง
// ของจริง ก.ย.: 12 ห้องได้บล็อกบัญชี — 2 ห้องเงียบหายไปโดยไม่มีใครทักอีกเลย (ห้องหนึ่งบอกว่า "พรุ่งนี้โอน")
//
// ไฟล์นี้ = ข้อความเดียวต่อหนึ่งรอบส่งบัญชี แล้วจบ (ส่งแล้วหรือข้ามแล้ว ไม่มีข้อความเรื่องเงินตามอีก
// และบันไดปกติยังหยุดเหมือนเดิม) — เงื่อนไขครบทุกข้อ:
//   บล็อกบัญชีถึงมือแล้ว (audit bank_sent_info_continues) · ยังรอชำระ · ไม่มีหลักฐานโอน (รูป/ไฟล์/บอกว่าโอนแล้ว)
//   · ลูกค้าไม่ได้พิมพ์เรื่องใหม่หลังบล็อก (ตอบรับสั้น ๆ / บอกวันโอน ได้) · ไม่มีคนในทีมตอบหลังบล็อก
//   · ไม่มีโน้ตส่งต่อของคนหลังบล็อก · ไม่ห้ามรบกวน/ไม่ถอนความยินยอม/ไม่ขอพัก · AI เปิด · ไม่มีป้ายเงียบ
//   · ไม่มีคนกำลังตรวจยอด
// เวลา: LINE วันถัดไปช่วงสาย ๆ (≥ 18 ชม. หลังบล็อก · บอกวันโอน = วันถัดจากวันนั้น · เกิน 7 วัน = ไม่ทัก)
//       FB 5–8 ชม. หลังข้อความล่าสุดของลูกค้า ภายใน 09:00–20:30 (หน้าต่าง Meta 24 ชม.) — ไม่มีช่อง = ไม่ทัก
// เนื้อหา: ข้อความคงที่ (ไม่ให้โมเดลร่าง) — เหตุผล: เรื่องเงินคือที่ที่โมเดลเสี่ยงที่สุด ห้องนี้เคยเห็นราคาที่อนุมัติ
// แล้ว ด่านราคาจึง "ยอม" ให้ทวนยอดได้ ขณะที่กติกาคือห้ามยอด/เลขบัญชี/เส้นตาย/คำเร่ง/อ้างว่ากันที่นั่ง
// ข้อความคงที่ตรวจด้วยเทสต์ได้ทุกตัวอักษร และยังผ่าน guard + humanizer + JEV + ด่านสดก่อนส่งเหมือน follow-up อื่น
import { brandText } from "./brand.mjs";
import { aiPausedNow } from "./aiPause.mjs";
import { enforceCustomerAddressAll, planCustomerAddress } from "./customerAddress.mjs";
import { inQuietHours } from "./followupEngine.mjs";
import {
  DAY_MS, HOUR_MS, MINUTE_MS, bangkokIsoDate, daytimeIntervals, explicitCalendarDates, hashUnit, isoDayStart,
  lateMorningDue, paymentDateHint, pickInIntervals,
} from "./followupTiming.mjs";
import { reviewFollowup } from "./jevFollowupReview.mjs";
import { composeKnowledgeForChannel } from "./knowledgePack.mjs";
import { knowledgeForDraftReview } from "./reviewCatalogPrompt.mjs";
import { senderOf } from "./kpi.mjs";
import { isHumanNoteAuthor } from "./lineOaContext.mjs";
import { isOpenRound, roundShortThai } from "./openRounds.mjs";
import { currentUpcomingRounds } from "./roundsSource.mjs";
import { isBankInfoConversation } from "./salesDecisionGuard.mjs";
import { isAckOnly } from "./scheduleCheck.mjs";
import { serviceFollowupPaused } from "./serviceBoundary.mjs";
import { paymentHoldActive } from "./stagedFollowups.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";

export const PAYMENT_GENTLE_NUDGE_KEY = "payment_gentle_nudge";
export const PAYMENT_NUDGE_LANE = "payment_nudge";
const LOOKBACK_MS = 8 * DAY_MS;
const HINT_LOOKBACK_MS = 48 * HOUR_MS;
const LINE_MIN_AFTER_BANK_MS = 18 * HOUR_MS;
const MIN_QUIET_AFTER_ACTIVITY_MS = 45 * MINUTE_MS;
const MAX_AHEAD_MS = 7 * DAY_MS;
const FB_FROM_MS = 5 * HOUR_MS;
const FB_TO_MS = 8 * HOUR_MS;
// ต้องตรงกับ FB_MESSAGING_WINDOW_MS ใน db.mjs (เทสต์ยืนยัน) · เผื่อ 30 นาทีก่อนประตูปิด
const FB_WINDOW_MS = 24 * HOUR_MS - 5 * MINUTE_MS;
const FB_MARGIN_MS = 30 * MINUTE_MS;
const MAX_PER_TICK = 5;
// ผู้ตรวจโค้ด 28 ก.ย.: เวลาทักคำนวณจากเวลาส่งบัญชี จึงอาจอยู่ในอดีตแล้ว (ห้องค้างก่อนเปิดฟีเจอร์ / เปิดสวิตช์กลับหลังปิด
// หลายวัน / เซิร์ฟเวอร์ดับนาน) ถ้ายิงทุกห้องที่ "ถึงเวลาแล้ว" ทันที ลูกค้าจะได้ข้อความรวดเดียวตอนบ่าย/ค่ำ ไม่ใช่ช่วงที่วางไว้
// ช้ากว่าที่วางไว้ไม่เกิน 2 ชม. ยังส่ง (restart สั้น ๆ) · เกินนั้น = ข้ามรอบนี้ถาวร (บันทึก slot_missed)
const SEND_GRACE_MS = 2 * HOUR_MS;

/** เหตุที่ไม่ทักหลังส่งบัญชี — ภาษาคนสำหรับหน้าสถานะ (Telegram/คอนโซล) */
export const PAYMENT_NUDGE_SKIP_TEXT = Object.freeze({
  human_replied: "ทีมตอบแล้ว", human_note: "ทีมจดโน้ตว่าดูแลอยู่", customer_replied: "ลูกค้าคุยต่อเอง",
  payment_evidence: "ลูกค้าส่งสลิป/แจ้งโอนแล้ว", deal_moved: "ดีลเปลี่ยนสถานะแล้ว", ai_off: "AI ห้องนี้ปิด",
  opted_out: "ลูกค้าไม่รับข้อความ", customer_deferred: "ลูกค้าขอพัก/ขอคิดก่อน", regular_followup_on: "ทีมเปิดการติดตามปกติเอง",
  tag_silenced: "ติดป้ายเงียบ", urgent_mental: "ส่งต่อคนดูแล", service_boundary: "คุยนอกขอบเขตบริการ",
  payment_in_human_review: "ทีมกำลังตรวจยอด", fb_no_daytime_slot: "ไม่มีเวลากลางวันในหน้าต่าง Facebook",
  customer_named_later_date: "ลูกค้าบอกวันโอนที่ไกลกว่าหน้าต่าง Facebook", pay_date_beyond_7_days: "วันโอนที่ลูกค้าบอกเกิน 7 วัน",
  beyond_7_days: "เกิน 7 วัน", round_passed: "รอบเรียนถึงแล้ว", round_full: "รอบนั้นเต็มแล้ว", slot_missed: "เลยเวลาที่วางไว้",
  already_followed: "มีข้อความทักไปแล้ว", fb_window_closed: "หน้าต่าง Facebook ปิดแล้ว",
});

/** ไม่มีแถว = on (คำสั่งเจ้าของ) · off = ไม่ทักเลย (พฤติกรรมก่อน 28 ก.ย.) · อ่านพัง = off */
export function paymentGentleNudgeMode(db) {
  try {
    const raw = String(db?.getSetting?.(PAYMENT_GENTLE_NUDGE_KEY) ?? "").trim().toLowerCase();
    return raw === "off" ? "off" : "on";
  } catch {
    return "off";
  }
}

export function paymentGentleNudgeEnabled(db) {
  return paymentGentleNudgeMode(db) === "on";
}

/* ------------------------------ อ่านห้องหลังส่งบัญชี ------------------------------ */

// ลูกค้าบอกว่าโอน/ส่งสลิปแล้ว = คนต้องตรวจยอด ไม่ใช่จังหวะทัก
const PAYMENT_CLAIM = /(?:โอน|ชำระ|จ่าย)(?:เงิน)?(?:ให้)?(?:ไป)?(?:แล้ว|เรียบร้อย)|สลิป|slip|transferred|(?:already|have)\s+paid/iu;
const ASKS = /[?？]|ไหม|มั้ย|มั๊ย|หรือเปล่า|รึเปล่า|หรือยัง|ยังไง|อย่างไร|เท่าไ(?:หร่|ร)|อะไร|ไหน|เมื่อไ(?:หร่|ร)|ทำไม|กี่/u;

/** แถวข้อความหลังบล็อกบัญชีหนึ่งแถว → ack | pay_timing | payment_evidence | other | ai | human | proactive */
export function classifyAfterBank(message) {
  if (message?.direction === "out") {
    if (senderOf(message) === "human" && String(message.operator || "") !== "system") return "human";
    return message.message_class === "proactive" ? "proactive" : "ai";
  }
  const type = String(message?.msg_type || "text");
  if (type === "sticker") return "ack";
  if (type === "image" || type === "file") return "payment_evidence";
  if (type !== "text") return "other";
  const text = String(message?.content || "");
  if (PAYMENT_CLAIM.test(text)) return "payment_evidence";
  if (ASKS.test(text)) return "other";
  if (paymentDateHint(text, message?.created_at)) return "pay_timing";
  return isAckOnly(text) ? "ack" : "other";
}

const SKIP_BY_CLASS = Object.freeze({
  human: "human_replied", payment_evidence: "payment_evidence", other: "customer_replied", proactive: "already_followed",
});

/* ---------------------------------- เวลา ---------------------------------- */

/** เวลาทัก — { dueAt } หรือ { skip } · pure (badge บนคอนโซลกับเวลายิงจริงต้องตรงกัน) */
export function planPaymentNudge({ channelId = "", customerId = "", bankAt, lastInboundAt, lastActivityAt, payHintIso = null }) {
  const bank = Number(bankAt);
  const lastIn = Math.max(Number(lastInboundAt) || 0, 0);
  const activity = Math.max(Number(lastActivityAt) || 0, bank);
  const unit = hashUnit(customerId, bank, "payment_nudge");
  if (String(channelId) === "facebook") {
    const anchor = lastIn || bank;
    const spans = daytimeIntervals(Math.max(anchor + FB_FROM_MS, activity + MIN_QUIET_AFTER_ACTIVITY_MS),
      Math.min(anchor + FB_TO_MS, anchor + FB_WINDOW_MS - FB_MARGIN_MS));
    const dueAt = pickInIntervals(spans, unit);
    if (dueAt === null) return { skip: "fb_no_daytime_slot" };
    if (payHintIso && payHintIso > bangkokIsoDate(dueAt)) return { skip: "customer_named_later_date" };
    return { dueAt };
  }
  const dueAt = lateMorningDue({
    earliestMs: Math.max(bank + LINE_MIN_AFTER_BANK_MS, activity + MIN_QUIET_AFTER_ACTIVITY_MS),
    notBeforeMs: payHintIso ? isoDayStart(payHintIso) + DAY_MS : null,
    unit,
  });
  if (dueAt === null || dueAt - bank > MAX_AHEAD_MS) return { skip: payHintIso ? "pay_date_beyond_7_days" : "beyond_7_days" };
  return { dueAt };
}

// รอบที่บล็อกสรุปของลูกแพรพูดถึง (วันที่เขียนชัดวันเดียว) — หลายวัน = ไม่เดา
function bankBlockRoundIso(messages, bankAt) {
  const text = messages
    .filter((m) => m.direction === "out" && m.created_at <= bankAt + 1_000 && m.created_at >= bankAt - 10 * MINUTE_MS)
    .map((m) => String(m.content || "")).join("\n");
  const dates = explicitCalendarDates(text, bankAt);
  return dates.length === 1 ? dates[0] : null;
}

/**
 * ประเมินห้องหนึ่งห้อง (pure) — { status: done|skip|wait|due, reason?, dueAt?, roundShort? }
 * skip = จบถาวรสำหรับรอบส่งบัญชีนี้ (ผู้เรียกปิดแถว + จด audit ครั้งเดียว) · wait = ยังไม่ถึงเวลา
 */
export function evaluatePaymentNudge({ customer, bankAt, messages = [], nowMs, attempt = null, tagSilenced = false, holdActive = false, rounds = [], notes = [] }) {
  if (attempt && ["sending", "settled"].includes(attempt.status)) return { status: "done" };
  const skip = (reason) => ({ status: "skip", reason });
  if (!customer) return skip("customer_gone");
  if (String(customer.deal_status) !== "awaiting_payment") return skip("deal_moved");
  if (customer.ai_enabled !== 1) return skip("ai_off");
  if (customer.do_not_disturb === 1 || Number(customer.marketing_consent ?? 0) < 0) return skip("opted_out");
  if (String(customer.followup_suppression_reason || "")) return skip("customer_deferred");
  // เส้นส่งบัญชีปิดการทักตามปกติของห้องไว้แล้ว — ถ้าทีมกดเปิดกลับเอง บันไดปกติเป็นเจ้าของห้อง ห้ามทักซ้อนสองทาง
  if (customer.followup_enabled === 1) return skip("regular_followup_on");
  if (tagSilenced) return skip("tag_silenced");
  if (customer.ai_off_reason === "urgent_mental" || /(?:^|\n)\[[^\]]+\]\s*urgent_mental(?::|$)/u.test(String(customer.handoff_summary || ""))) {
    return skip("urgent_mental");
  }
  if (serviceFollowupPaused(customer)) return skip("service_boundary");
  if (holdActive) return skip("payment_in_human_review");
  // ทีมตอบลูกค้าใน LINE OA Manager ระบบมองไม่เห็น — ทีมจดโน้ตส่งต่อแทน (ป้าย "🟠 รอสรุป") โน้ตของคนหลังบล็อก = คนดูแลอยู่
  if ((Array.isArray(notes) ? notes : []).some((note) => isHumanNoteAuthor(note?.author) && Number(note?.created_at) > bankAt)) {
    return skip("human_note");
  }

  const rows = [...messages].sort((a, b) => a.created_at - b.created_at);
  const after = rows.filter((m) => m.created_at > bankAt);
  let payHintIso = null;
  for (const message of after) {
    const kind = classifyAfterBank(message);
    if (SKIP_BY_CLASS[kind]) return skip(SKIP_BY_CLASS[kind]);
  }
  // วันที่ลูกค้าบอกว่าจะโอน — ทั้งก่อนบล็อก ("พรุ่งนี้โอนให้นะคะ ขอเลขบัญชี") และหลังบล็อก ("ได้ค่ะ พรุ่งนี้โอน")
  for (const message of rows.filter((m) => m.direction === "in" && m.created_at >= bankAt - HINT_LOOKBACK_MS)) {
    if (String(message.msg_type || "text") !== "text" || ASKS.test(String(message.content || ""))) continue;
    const hint = paymentDateHint(message.content, message.created_at);
    if (hint && (!payHintIso || hint > payHintIso)) payHintIso = hint;
  }
  const inbound = rows.filter((m) => m.direction === "in");
  const plan = planPaymentNudge({
    channelId: customer.channel_id, customerId: customer.line_user_id, bankAt,
    lastInboundAt: inbound.at(-1)?.created_at ?? bankAt, lastActivityAt: rows.at(-1)?.created_at ?? bankAt, payHintIso,
  });
  if (plan.skip) return skip(plan.skip);

  const roundIso = bankBlockRoundIso(rows, bankAt);
  if (roundIso && roundIso <= bangkokIsoDate(plan.dueAt)) return skip("round_passed");
  const round = roundIso ? (Array.isArray(rounds) ? rounds : []).find((r) => r.date === roundIso) : null;
  if (round && !isOpenRound(round)) return skip("round_full");
  if (Number(nowMs) > plan.dueAt + SEND_GRACE_MS) return skip("slot_missed");
  const verdict = { dueAt: plan.dueAt, roundShort: round ? roundShortThai(round) : "" };
  return Number(nowMs) >= plan.dueAt ? { status: "due", ...verdict } : { status: "wait", ...verdict };
}

/* --------------------------------- ข้อความ --------------------------------- */

/** ข้อความเดียว คำถามนุ่มข้อเดียว — name = คำเรียกที่ผ่าน planCustomerAddress แล้ว ("คุณเอ") หรือ "" */
export function paymentNudgeText({ customerId = "", bankAt = 0, name = "", roundShort = "" } = {}) {
  // "รอบ 10 ต.ค. ไหมคะ" ต้องมีช่องว่างหลังตัวย่อ (ติดกันอ่านเป็น "ต.ค.ไหมคะ")
  const what = roundShort ? `การสมัครรอบ ${roundShort} ` : "การสมัครเรียน";
  return brandText(hashUnit(customerId, bankAt, "payment_nudge_text") < 0.5
    ? `สวัสดีค่ะ${name} 😊 มีอะไรให้ลูกแพรช่วยเพิ่มเติมเรื่อง${what}ไหมคะ ถ้าสะดวกเมื่อไหร่ ส่งสลิปการโอนไว้ในแชทนี้ได้เลยนะคะ ทีมงานจะยืนยันที่นั่งให้ค่ะ`
    : `${name ? `${name}คะ` : "สวัสดีค่ะ"} มีตรงไหนที่อยากให้ลูกแพรช่วยเพิ่มเติมเรื่อง${what}ไหมคะ 😊 สะดวกเมื่อไหร่ ส่งสลิปไว้ในแชทนี้ได้เลยนะคะ เดี๋ยวทีมงานยืนยันที่นั่งให้ค่ะ`);
}

/* ------------------------------ ประกอบข้อเท็จจริงจาก DB ------------------------------ */

function gatherFacts({ db, config, customer, nowMs, logger }) {
  const customerId = customer.line_user_id;
  const bankAt = db.latestBankSentAt(customerId, nowMs - LOOKBACK_MS);
  if (!bankAt) return null;
  const key = `bank:${bankAt}`;
  const attempt = db.getProactiveAttempt(customerId, PAYMENT_NUDGE_LANE, key);
  // รอบนี้จบแล้ว (ส่ง/ข้ามไปแล้ว) = ไม่ต้องอ่านอะไรเพิ่ม — ห้องค้างอยู่ในรายชื่อได้หลายวัน รอบละนาที
  if (attempt && ["sending", "settled"].includes(attempt.status)) return { key, bankAt, attempt };
  return {
    key, bankAt, attempt,
    messages: db.messagesFor(customerId, 80),
    tagSilenced: db.isBotSilencedByTag(customerId),
    notes: db.listHandoffNotes?.(customerId, 20) ?? [],
    holdActive: paymentHoldActive({ handoffSummary: customer.handoff_summary, nowMs, lastInboundAt: db.lastInboundAt(customerId) }),
    rounds: currentUpcomingRounds({ db, config, todayIso: bangkokIsoDate(nowMs), logger }),
  };
}

/** badge บนคอนโซล (ห้องรอชำระที่ AI เปิด) — ตรรกะเดียวกับเส้นยิงจริง ไม่เขียนอะไรเลย */
export function paymentNudgePreview({ db, config, customer, nowMs, logger = null }) {
  try {
    if (!customer || !isBankInfoConversation(customer) || !paymentGentleNudgeEnabled(db)) return null;
    const facts = gatherFacts({ db, config, customer, nowMs, logger });
    if (!facts) return null;
    const verdict = evaluatePaymentNudge({ customer, nowMs, ...facts });
    if (verdict.status === "done") return { blocked: "payment_nudge_done" };
    if (verdict.status === "skip") return { blocked: "payment_nudge_skipped", reason: verdict.reason };
    return { stage: "payment_nudge", step: 1, kind: "payment_gentle_nudge", dueAt: verdict.dueAt };
  } catch {
    return null;
  }
}

/* ---------------------------------- ตัวส่ง ---------------------------------- */

export function createPaymentGentleNudge({ config, db, lineRegistry, guard, humanizer, decisionReview = null, notifier = null, logger = console, now = Date.now }) {
  function closeEpisode(customerId, key, reason, tsMs) {
    if (!db.closeProactiveAttempt(customerId, PAYMENT_NUDGE_LANE, key, tsMs)) return;
    try {
      db.addAudit({ operator: "system", action: "payment_gentle_nudge_skipped", target: customerId, detail: reason });
    } catch { /* audit พังห้ามล้มรอบ */ }
  }

  async function processRoom(customer, tsMs) {
    const customerId = customer.line_user_id;
    const facts = gatherFacts({ db, config, customer, nowMs: tsMs, logger });
    if (!facts) return { customerId, skipped: "no_bank_block" };
    const verdict = evaluatePaymentNudge({ customer, nowMs: tsMs, ...facts });
    if (verdict.status === "done") return { customerId, skipped: "done" };
    if (verdict.status === "skip") {
      closeEpisode(customerId, facts.key, verdict.reason, tsMs);
      return { customerId, skipped: verdict.reason };
    }
    if (verdict.status !== "due") return { customerId, skipped: "not_due" };
    // ด่านชั่วคราว (รอบถัดไปลองใหม่ได้) — ช่วงเงียบ / คนกำลังคุย / AI หยุดทั้งระบบ
    if (inQuietHours(tsMs)) return { customerId, skipped: "quiet_hours" };
    if ((Number(customer.operator_active_until) || 0) > tsMs) return { customerId, skipped: "operator_active" };
    if (aiPausedNow({ db, config })) return { customerId, skipped: "ai_paused" };
    const facebook = String(customer.channel_id || "") === "facebook";
    if (facebook && !db.withinFacebookWindow(customerId, tsMs)) {
      closeEpisode(customerId, facts.key, "fb_window_closed", tsMs);
      return { customerId, skipped: "fb_window_closed" };
    }

    const history = db.recentTurns(customerId, 12);
    const address = planCustomerAddress({ knownName: customer.known_name || "", displayName: customer.display_name || "", history });
    const name = !address.generic && address.mayUseName ? `${address.pronoun}${address.name}` : "";
    const texts = enforceCustomerAddressAll([paymentNudgeText({ customerId, bankAt: facts.bankAt, name, roundShort: verdict.roundShort })], address);
    const check = guard.checkOutbound(texts.join("\n"), { customerId, channelId: customer.channel_id || "" });
    if (!check.ok) {
      closeEpisode(customerId, facts.key, "guard_blocked", tsMs);
      return { customerId, skipped: "guard_blocked" };
    }
    const bubbles = texts.flatMap((text) => humanizer.humanize({ customerId, text }));
    if (!bubbles.length) return { customerId, skipped: "empty_after_humanize" };

    const lastIn = db.lastInboundAt(customerId);
    const stillRelevant = () => {
      const current = db.getCustomer(customerId);
      return Boolean(current && isBankInfoConversation(current)
        && current.do_not_disturb !== 1 && Number(current.marketing_consent ?? 0) >= 0
        && !String(current.followup_suppression_reason || "") && !serviceFollowupPaused(current)
        && (Number(current.operator_active_until) || 0) <= now()
        && !db.isBotSilencedByTag(customerId) && db.lastInboundAt(customerId) === lastIn
        && (!facebook || db.withinFacebookWindow(customerId, now()))
        && paymentGentleNudgeEnabled(db) && !aiPausedNow({ db, config }));
    };
    if (!stillRelevant()) return { customerId, skipped: "superseded_before_send" };
    const correctionInboundMessageId = String(db.latestInboundMessageId?.(customerId) || "");
    if (!await reviewFollowup({ reviewer: decisionReview, db, customerId, turnId: correctionInboundMessageId, notifier,
      threshold10: config.jevReviewThreshold, blockPaymentInstructions: config.salesDecisionGuardEnabled === true,
      draftText: bubbles.map((bubble) => bubble.text).join("\n"),
      // 19 ต.ค. 2026: ด่านตรวจเห็นเฉพาะรายการคลังรีวิวที่อยู่ในร่างนี้จริง (ปกติไม่มี)
      knowledge: knowledgeForDraftReview({ db, draftText: bubbles.map((b) => b.text).join("\n"),
        knowledge: composeKnowledgeForChannel({ db, channelId: customer.channel_id || "default", logger }) }), isCurrent: stillRelevant })) {
      closeEpisode(customerId, facts.key, "jev_review_required", tsMs);
      return { customerId, skipped: "jev_review_required" };
    }
    if (!stillRelevant()) return { customerId, skipped: "superseded_after_jev" };
    const claim = db.claimProactiveAttempt(customerId, PAYMENT_NUDGE_LANE, facts.key, tsMs);
    if (!claim.ok || !db.fenceProactiveSend(customerId, PAYMENT_NUDGE_LANE, facts.key, now())) {
      return { customerId, skipped: claim.ok ? "delivery_fenced" : claim.reason };
    }
    const sendResult = await lineRegistry.forChannel(customer.channel_id || "default").sendBubbles({
      batch: true, to: lineRegistry.rawUserId(customerId), replyToken: "", bubbles, images: [], stillRelevant,
      purpose: SEND_PURPOSE.followup,
    });
    // ข้ามเส้น provider แล้ว = รอบนี้จบเสมอ (ส่งไม่ชัวร์ห้ามส่งซ้ำอัตโนมัติ — แบบแผนเดียวกับ staged)
    db.settleProactiveSend(customerId, PAYMENT_NUDGE_LANE, facts.key, now());
    const delivered = Array.isArray(sendResult?.delivered) ? sendResult.delivered
      : sendResult?.ok ? bubbles.map((bubble) => ({ type: "text", text: bubble.text })) : [];
    const deliveredTexts = delivered.filter((m) => typeof m?.text === "string").map((m) => m.text);
    for (const text of deliveredTexts) {
      db.insertMessage({ customerId, direction: "out", msgType: "text", content: text, messageClass: "proactive", agentMode: "ai" });
    }
    try {
      db.addAudit({
        operator: "system", action: deliveredTexts.length ? "payment_gentle_nudge_sent" : "payment_gentle_nudge_skipped", target: customerId,
        detail: deliveredTexts.length
          ? `${facebook ? "facebook" : "line"} · หลังส่งบัญชี ${((tsMs - facts.bankAt) / HOUR_MS).toFixed(1)} ชม.${verdict.roundShort ? ` · รอบ ${verdict.roundShort}` : ""}`
          : `send_failed:${sendResult?.status ?? sendResult?.reason ?? "?"}`,
      });
    } catch { /* audit พังห้ามล้มรอบ */ }
    return deliveredTexts.length ? { customerId, sent: "payment_gentle_nudge" } : { customerId, skipped: "send_failed" };
  }

  /** หนึ่งรอบ — ผู้เรียก (stagedFollowups.runTick) เช็คสวิตช์รวม/สถานะหยุด AI มาแล้ว */
  async function runTick(tsMs = now()) {
    if (!paymentGentleNudgeEnabled(db)) return { skipped: "disabled" };
    let rooms;
    try {
      rooms = db.listPaymentNudgeCandidates({ nowMs: tsMs, activeWithinMs: LOOKBACK_MS });
    } catch (err) {
      logger.error?.(`paymentGentleNudge: อ่านรายชื่อห้องไม่ได้ (${err?.message || err})`);
      return { skipped: "candidates_error" };
    }
    const results = [];
    // ห้องรอชำระที่ AI เปิดมีไม่กี่ห้อง และการประเมินไม่เรียกโมเดล — ดูทุกห้อง แต่ส่งได้ไม่เกินรอบละ 5 ห้อง
    for (const customer of rooms) {
      if (results.filter((r) => r.sent).length >= MAX_PER_TICK) break;
      try {
        results.push(await processRoom(customer, tsMs));
      } catch (err) {
        logger.error?.(`paymentGentleNudge: ${customer.line_user_id} ล้มเหลว (${err?.message || err})`);
        results.push({ customerId: customer.line_user_id, skipped: "error" });
      }
    }
    return { results };
  }

  return { runTick, processRoom };
}
