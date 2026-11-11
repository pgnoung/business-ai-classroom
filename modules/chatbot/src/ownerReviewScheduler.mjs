// ownerReviewScheduler.mjs — รอบตรวจของพี่ง้วง 09:00 / 12:00 / 15:00 / 19:00 (คำสั่งพี่ง้วง 12 ต.ค. 2026 ค่ำ)
//
// พี่ง้วง: "ไม่มีอะไรปิดเองอีกแล้ว — AI ตรวจห้องที่มีข้อความใหม่ แล้วเสนอห้องที่ท่าทีไม่พาไปสู่การเรียน
//          พี่ง้วงหรือชมพู่กดยืนยันในคอนโซล · แจ้งเตือนถึงพี่ง้วงคนเดียว · ทำงานบน VPS (ปิด MacBook ได้)"
//
// ทุกอย่างอยู่ในโปรเซส chassis ตัวเดียวบน VPS (setInterval 60 วิ unref · ล็อกในโปรเซส · จองรอบในตาราง)
//   · จองรอบ = INSERT OR IGNORE บน owner_review_batches(kind, slot_ms) — รอบเดียวไม่ทำซ้ำ แม้รีสตาร์ตกลางรอบ
//   · รีสตาร์ต/deploy กลางรอบ = ทำต่อจาก cursor (ช่วงเวลาของรอบตายตัว ลำดับห้องจึงเหมือนเดิม)
//   · เครื่องล่มข้ามรอบ = ตามเก็บเฉพาะรอบล่าสุดที่เลยมาไม่เกิน 2 ชม. (รอบเก่ากว่านั้นรวมเข้ารอบถัดไปเอง — ช่วงต่อจากรอบก่อนหน้า)
//   · รอตัวกวาดคัดกรองรายชั่วโมงเดินจบก่อน (เวลาชนกันพอดีทุกรอบ · เกตเวย์ MAX_INFLIGHT=4 ใช้ร่วมกับคำตอบลูกค้า)
//   · ไม่เกิน 80 ห้องต่อรอบ · เรียก Luna ทีละห้อง · ปิดโปรเซส = หยุดระหว่างห้อง
// ห้องที่ดู: ลูกค้าพิมพ์ใหม่ในช่วงของรอบ · AI เปิด · ไม่เหลือง · closer.blockReason ว่าง · ไม่มีข้อเสนอค้าง · (อ่านท่าที) ไม่เคยถูกสั่งไม่ปิด
//   ดอกที่ 1 เจอคำ → closer.judge() (พรอมต์/เพดาน ฿100 ของการตีจบ) · ไม่มีดอกที่ 1 → Luna อ่านท่าที (ownerReviewPrompt · ฿40/วัน)
//   สวิตช์ owner_review_scan_scope: all (ค่าเริ่มต้นสัปดาห์แรก) | cue_only (เฉพาะห้องที่มีดอกที่ 1)
// สวิตช์ owner_review_mode: ไม่มีแถว = on (ปลุกมือถือเจ้าของเมื่อมีข้อเสนอใหม่) · shadow = สร้างข้อเสนอ ไม่ปลุก · off = ไม่ตรวจ
// งานดูแลทุกนาที (ทุกโหมด): ข้อเสนอรอเกิน 72 ชม./ห้องถูกกัน = หมดอายุ · ค้างยืนยันเกิน 5 นาที = กู้ · ลบแถวเก่า 180 วัน วันละครั้ง
// เฟส B (คิวตรวจแชทรายวัน 20:00 — ownerReviewDaily.mjs): นาทีที่ไม่มีงานของรอบ scan = เดินงานของรอบ daily ต่อ (ล็อกเดียวกัน ·
//   เรียก Luna ทีละห้องเหมือนกัน) · เพดานเงินรวม ฿80/วัน (owner_review ทั้ง scan + daily) โดย scan ใช้ได้ไม่เกินครึ่ง (฿40 เท่าเฟส A)
//   ที่เหลือกันไว้ให้คิว 20:00 เสมอ
// ไม่ log เนื้อหาแชท — log/สถิติเป็นตัวเลขรวม
import { createLock } from "./locks.mjs";
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import { bangkokHHMM, latestSlotMs, parseDigestTimes } from "./digest.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { loadModelPricing, pricingById, summarizeUsage } from "./modelPricing.mjs";
import { OFFTOPIC_MODEL } from "./hermesBridge.mjs";
import { OFFTOPIC_SCAN_CHARS, detectOfftopicCue } from "./offtopicCues.mjs";
import { OFFTOPIC_CONTEXT_TURNS, offtopicOwnerKept } from "./offtopicClose.mjs";
import { isNotQualifiedRow } from "./notQualified.mjs";
import { QUALIFY_LATEST_INBOUND_SQL, readQualifySweepModeStrict } from "./qualifySweepRules.mjs";
import { historyBeforeCurrentInbound } from "./conversationStyle.mjs";
import { presetButtonPhrases } from "./presetButtons.mjs";
import {
  OWNER_REVIEW_MAX_COMPLETION_TOKENS, OWNER_REVIEW_TRANSCRIPT_ROWS, ownerReviewScreenSystemPrompt,
  buildOwnerReviewScreenUser, ownerReviewReasonText, parseOwnerReviewScreen,
} from "./ownerReviewPrompt.mjs";
import { OWNER_REVIEW_DAILY_MAX_COMPLETION_TOKENS } from "./ownerReviewDailyPrompt.mjs";
import { createOwnerReviewDailyRunner } from "./ownerReviewDaily.mjs";
import { createTeamReplyReviewRunner } from "./teamReplyReview.mjs";

export const OWNER_REVIEW_MODE_KEY = "owner_review_mode";
export const OWNER_REVIEW_MODES = Object.freeze(["off", "shadow", "on"]);
export const OWNER_REVIEW_SCAN_SCOPE_KEY = "owner_review_scan_scope";
export const OWNER_REVIEW_SCAN_SCOPES = Object.freeze(["all", "cue_only"]);
// เวลารอบเป็นค่าคงที่ในโค้ด (ไม่มี env ใหม่ — กับดัก allowlist ของตัวปล่อย phase7)
export const OWNER_REVIEW_SCAN_TIMES = "09:00,12:00,15:00,19:00";
export const OWNER_REVIEW_USAGE_KIND = "owner_review";
// เพดานต่อวันของ owner_review ทั้งก้อน (รอบ scan + คิวตรวจแชท 20:00 — คำสั่ง 12 ต.ค.: "รวม ฿80/วัน")
export const OWNER_REVIEW_DAILY_THB_CAP = 80;
// รอบ scan ใช้ได้ไม่เกินสัดส่วนนี้ของเพดาน (฿40 เท่าเฟส A) — คิว 20:00 มาทีหลังในวันเดียวกัน ต้องเหลือเงินให้เสมอ
export const OWNER_REVIEW_SCAN_BUDGET_SHARE = 0.5;
export const OWNER_REVIEW_SCAN_ROOM_CAP = 80;
export const OWNER_REVIEW_CATCHUP_MS = 2 * 60 * 60_000;
// ยังไม่เคยมีรอบเลย = ย้อนดูข้อความลูกค้าไม่เกิน 24 ชม. (กันรอบแรกกวาดห้องทั้งประวัติ)
export const OWNER_REVIEW_FIRST_WINDOW_MS = 24 * 60 * 60_000;
// รอบที่ค้าง building นานเกินนี้ (เครื่องล่มข้ามวัน) = ปิดเป็น failed ไม่ทำต่อ (ข้อความเก่าเกินจะเสนอ)
export const OWNER_REVIEW_STALE_BATCH_MS = 12 * 60 * 60_000;
export const OWNER_REVIEW_TICK_MS = 60_000;
// หนึ่งนาทีที่ทำงาน (ถือล็อก) ไม่เกินเท่านี้ — ที่เหลือทำต่อในนาทีถัดไปจาก cursor
export const OWNER_REVIEW_RUN_MAX_MS = 8 * 60_000;
export const OWNER_REVIEW_JUDGE_TIMEOUT_MS = 20_000;
export const OWNER_CLOSE_EXPIRE_MS = 72 * 60 * 60_000;
export const OWNER_REVIEW_RETENTION_MS = 180 * 24 * 60 * 60_000;
export const OWNER_REVIEW_BREAKER_FAILURES = 3;
export const OWNER_REVIEW_BREAKER_BACKOFF_MS = 20 * 60_000;
// ตรวจข้อเสนอที่รออยู่ว่าห้องถูกกันหรือยัง ทุก 10 นาที (ไม่ใช่ทุกนาที — ด่านห้องอ่านหลายตาราง)
export const OWNER_REVIEW_BLOCK_CHECK_MS = 10 * 60_000;
const CANDIDATE_PAGE = 50;
const SCAN_MINUTES = parseDigestTimes(OWNER_REVIEW_SCAN_TIMES);
const SYSTEM_AUDIT_OPERATOR = "system:owner_review";

/** ไม่มีแถว/ว่าง/on = on · shadow · off/ค่าแปลก = off · อ่านพัง = null (ข้ามนาทีนี้) */
export function ownerReviewMode(db) {
  let value;
  try {
    value = String(db?.getSetting?.(OWNER_REVIEW_MODE_KEY) ?? "").trim().toLowerCase();
  } catch {
    return null;
  }
  if (value === "" || value === "on") return "on";
  return value === "shadow" ? "shadow" : "off";
}

/** ไม่มีแถว/ค่าแปลก = all (สัปดาห์แรก) · cue_only · อ่านพัง = cue_only (ด้านประหยัด) */
export function ownerReviewScanScope(db) {
  try {
    const value = String(db?.getSetting?.(OWNER_REVIEW_SCAN_SCOPE_KEY) ?? "").trim().toLowerCase();
    return value === "cue_only" ? "cue_only" : "all";
  } catch {
    return "cue_only";
  }
}

/** รอบตรวจล่าสุดที่ถึงเวลาแล้ว (≤ nowMs) — ก่อน 09:00 = รอบ 19:00 ของเมื่อวาน */
export function ownerReviewScanSlot(nowMs) {
  return latestSlotMs(Number(nowMs), SCAN_MINUTES);
}

/** รอบตรวจถัดไป (> nowMs) — แสดงในคอนโซล */
export function ownerReviewNextScanAt(nowMs) {
  const day = bangkokDayStartMs(Number(nowMs));
  for (const minutes of SCAN_MINUTES) {
    const at = day + minutes * 60_000;
    if (at > Number(nowMs)) return at;
  }
  return day + 24 * 60 * 60_000 + SCAN_MINUTES[0] * 60_000;
}

/**
 * รายการแจ้งเตือนของเจ้าของใน /push/pending — มีเฉพาะเมื่อรอบตรวจเพิ่งปลุก (เหตุการณ์ยังไม่หมดอายุ/ยังไม่เปิดดู)
 *   · owner_review_close = ยังมีข้อเสนอรอยืนยัน → "รอยืนยันปิด N ห้อง"
 *   · owner_review_daily = คิวตรวจแชทล่าสุดยังมีห้องที่ไม่มีป้าย → "คิวตรวจแชทวันนี้พร้อม N ห้อง (น่าห่วง M)"
 * นับจำนวนอย่างเดียว ไม่มีชื่อหรือข้อความลูกค้า
 */
export function ownerReviewPushItems({ db, operatorUsername, nowMs = Date.now() } = {}) {
  const items = [];
  try {
    const event = db.latestOwnerReviewPushEvent?.(operatorUsername, nowMs, "owner_review_close");
    const pending = event ? Number(db.ownerCloseCounts({}).pending?.total) || 0 : 0;
    if (event && pending) {
      items.push({
        id: `owner-review-close-${pending}-${Number(event.created_at) || 0}`,
        title: "รอพี่ง้วงยืนยันปิดห้อง",
        body: `รอยืนยันปิด ${pending} ห้อง — แตะเพื่อเปิดห้องตรวจ`,
        url: "/console/#/owner-review",
        tag: "lukprae-owner-review",
        createdAt: Number(event.created_at) || 0,
      });
    }
  } catch { /* รายการหนึ่งพังไม่ทำให้อีกรายการหาย */ }
  try {
    const event = db.latestOwnerReviewPushEvent?.(operatorUsername, nowMs, "owner_review_daily");
    const batch = event ? db.latestOwnerReviewBatch("daily") : null;
    const counts = batch?.status === "ready" ? db.ownerReviewBatchItemCounts(batch.id) : null;
    if (event && counts?.remaining > 0) {
      items.push({
        id: `owner-review-daily-${batch.id}-${Number(event.created_at) || 0}`,
        title: "ห้องตรวจของพี่ง้วง",
        body: `คิวตรวจแชทวันนี้พร้อม ${counts.included} ห้อง (น่าห่วง ${counts.flagged})`,
        url: "/console/#/owner-review/daily",
        tag: "lukprae-owner-review-daily",
        createdAt: Number(event.created_at) || 0,
      });
    }
  } catch { /* ไม่มีรายการ */ }
  return items;
}

const freshCounts = () => ({
  rooms: 0, evaluated: 0, cue: 0, judged: 0, screened: 0, proposed: 0, kept: 0, invalid: 0, failed: 0, overflow: 0, skipped: {},
});

function readCounts(batch) {
  try {
    const parsed = JSON.parse(String(batch?.counts_json || "{}"));
    const base = freshCounts();
    return parsed && typeof parsed === "object" ? { ...base, ...parsed, skipped: { ...(parsed.skipped || {}) } } : base;
  } catch {
    return freshCounts();
  }
}

export function createOwnerReviewScheduler({
  config = {}, db, closer, hermes, webPush = null, closeService = null, logger = console, now = Date.now,
  isDraining = () => false, sweepBusy = () => false, fx = null, modelPricing = null,
  intervalMs = OWNER_REVIEW_TICK_MS, dailyThbCap = OWNER_REVIEW_DAILY_THB_CAP, roomCap = OWNER_REVIEW_SCAN_ROOM_CAP,
} = {}) {
  const lock = createLock();
  let timer = null;
  let pricing = null;
  let usageBroken = false; // บันทึกต้นทุนไม่ได้ครั้งเดียว = หยุดอ่านท่าทีจนรีสตาร์ต (นับเงินไม่ได้ = ไม่จ่าย)
  let unmetered = { day: 0, count: 0 };
  const breaker = { consecutive: 0, until: 0, trips: 0 };
  let lastBlockCheckAt = 0;
  let lastPruneDay = 0;
  let lastRun = null;
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
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  /* ---------------------------------- เงิน (฿40/วัน) ---------------------------------- */

  const todayRows = (t) => db.llmUsageSummary(bangkokDayStartMs(t)).filter((row) => row.kind === OWNER_REVIEW_USAGE_KIND);
  const estimateRow = (tokensIn, tokensOut = OWNER_REVIEW_MAX_COMPLETION_TOKENS) => ({
    model: OFFTOPIC_MODEL, kind: OWNER_REVIEW_USAGE_KIND, tokens_in: tokensIn, tokens_out: tokensOut,
  });

  // kind = scan (เพดานครึ่งหนึ่ง) | daily (เพดานเต็ม) — ยอดที่ใช้แล้วเป็นก้อนเดียวกัน (llm_usage kind owner_review)
  function budgetCheck(t, tokensIn, kind = "scan") {
    if (usageBroken) return { ok: false, reason: "usage_unrecorded" };
    const daily = kind === "daily";
    const tokensOut = daily ? OWNER_REVIEW_DAILY_MAX_COMPLETION_TOKENS : OWNER_REVIEW_MAX_COMPLETION_TOKENS;
    const dayKey = bangkokDayStartMs(t);
    const pending = unmetered.day === dayKey ? unmetered.count : 0;
    const rows = [...todayRows(t), ...Array.from({ length: pending }, () => estimateRow(tokensIn, tokensOut)), estimateRow(tokensIn, tokensOut)];
    const projected = summarizeUsage(rows, pricingMap());
    if (projected.unknownTokens > 0) return { ok: false, reason: "pricing_unknown" };
    const cap = daily ? dailyThbCap : dailyThbCap * OWNER_REVIEW_SCAN_BUDGET_SHARE;
    if (projected.usd * thbPerUsd() > cap) return { ok: false, reason: "daily_cap" };
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
      db.addLlmUsage({ customerId, kind: OWNER_REVIEW_USAGE_KIND, model: result.model || OFFTOPIC_MODEL, ...usageFields(result.usage) });
      return true;
    } catch (err) {
      usageBroken = true;
      logger.error?.(`owner-review: บันทึกต้นทุนไม่สำเร็จ — หยุดอ่านท่าทีจนรีสตาร์ต (${err?.message || err})`);
      return false;
    }
  }

  /* ---------------------------------- ตัวตัดวงจร ---------------------------------- */

  const breakerOpen = (t) => breaker.until > Number(t);
  function noteModel(ok) {
    if (ok) {
      breaker.consecutive = 0;
      return;
    }
    breaker.consecutive += 1;
    if (breaker.consecutive < OWNER_REVIEW_BREAKER_FAILURES) return;
    breaker.consecutive = 0;
    breaker.until = now() + OWNER_REVIEW_BREAKER_BACKOFF_MS;
    breaker.trips += 1;
    logger.warn?.(`[owner-review] Luna ล้มติดกัน ${OWNER_REVIEW_BREAKER_FAILURES} ครั้ง — พักรอบตรวจ ${OWNER_REVIEW_BREAKER_BACKOFF_MS / 60_000} นาที (ทำต่อจากห้องเดิม)`);
  }

  /* ---------------------------------- อ่านห้อง ---------------------------------- */

  function transcriptRows(customerId) {
    const session = db.activeConversationSession?.(customerId) ?? null;
    const filter = session ? "session_id = ?" : "session_id IS NULL";
    const params = session ? [String(session.id)] : [];
    return raw().prepare(`SELECT id, direction, msg_type, content, operator, message_class, created_at
        FROM messages WHERE customer_id = ? AND ${filter} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(String(customerId), ...params, OWNER_REVIEW_TRANSCRIPT_ROWS).reverse();
  }

  // ข้อความลูกค้าในช่วงของรอบ (ใหม่สุดท้าย) — ดอกที่ 1 อ่านทั้งก้อน (ด่านผู้ซื้อข้ามข้อความกันได้) · บทสนทนาก่อนหน้าให้ Luna
  function roomContext(customerId, batch) {
    const inbound = db.ownerReviewWindowInbound(customerId, { windowStartMs: batch.window_start_ms, windowEndMs: batch.window_end_ms });
    const chars = Array.from(inbound.filter((row) => String(row.msg_type || "text") === "text")
      .map((row) => String(row.content ?? "").trim()).filter(Boolean).join("\n"));
    const newText = chars.slice(-OFFTOPIC_SCAN_CHARS).join("");
    const history = historyBeforeCurrentInbound(db.recentTurns(customerId, OFFTOPIC_CONTEXT_TURNS));
    return { newText, history };
  }

  /* ---------------------------------- ตรวจหนึ่งห้อง ---------------------------------- */

  const skip = (reason) => ({ outcome: "skipped", reason, called: false });

  function propose(customerId, row, batch, { source, category, cue = "", reason = "" }) {
    const latest = raw().prepare(QUALIFY_LATEST_INBOUND_SQL).get(String(customerId)) ?? null;
    if (!latest) return skip("no_inbound");
    const proposal = db.insertOwnerCloseProposal({
      customerId, channelId: row.channel_id || "default", batchId: batch.id, source, category, cue,
      aiReason: ownerReviewReasonText(reason, [row.display_name, row.known_name]), baselineInboundId: String(latest.id),
    });
    if (!proposal) return skip("open_proposal");
    safe(() => db.addAudit({ operator: SYSTEM_AUDIT_OPERATOR, action: "owner_close_proposed", target: customerId,
      detail: `proposal=${proposal.id} · ${source} · ${category}` }), null);
    return { outcome: "proposed", called: true, source };
  }

  async function judgeCue(customerId, row, batch, cue, ctx) {
    if (closer.recentlyKept?.(customerId, cue)) return skip("kept_recently");
    const verdict = await closer.judge({ customerId, category: cue, text: ctx.newText, history: ctx.history, timeoutMs: OWNER_REVIEW_JUDGE_TIMEOUT_MS });
    if (!verdict?.ok) {
      const outcome = String(verdict?.outcome || "failed");
      if (outcome.startsWith("capped") || outcome === "usage_unrecorded") return { outcome: "capped", reason: outcome, called: false };
      noteModel(outcome === "luna_invalid");
      return { outcome: outcome === "luna_invalid" ? "invalid" : "failed", called: true, source: "cue_luna" };
    }
    noteModel(true);
    if (!verdict.close) {
      closer.rememberKept?.(customerId, cue);
      return { outcome: "kept", called: true, source: "cue_luna" };
    }
    if (verdict.category !== cue) {
      const block = closer.blockReason(customerId, db.getCustomer(customerId), verdict.category, ctx.history);
      if (block) return { ...skip(block), called: true };
    }
    return propose(customerId, row, batch, { source: "cue_luna", category: verdict.category, cue, reason: verdict.reason });
  }

  async function screenRoom(customerId, row, batch, ctx, runCtx) {
    const t = now();
    const names = [row.display_name, row.known_name];
    const { user } = buildOwnerReviewScreenUser({
      rows: transcriptRows(customerId), nowMs: t, dayStartMs: bangkokDayStartMs(t), names,
      presetPhrases: runCtx.presetPhrases, channel: row.channel_id, hints: runCtx.hints,
    });
    const system = ownerReviewScreenSystemPrompt();
    const budget = budgetCheck(t, system.length + user.length);
    if (!budget.ok) return { outcome: "capped", reason: budget.reason, called: false };
    const call = typeof hermes?.ownerReviewCheck === "function" ? hermes.ownerReviewCheck : hermes?.offtopicCheck;
    if (typeof call !== "function") return skip("not_wired");
    let result = null;
    try {
      result = await call({ system, user, maxCompletionTokens: OWNER_REVIEW_MAX_COMPLETION_TOKENS,
        timeoutMs: OWNER_REVIEW_JUDGE_TIMEOUT_MS });
    } catch (err) {
      logger.warn?.(`owner-review: เรียก Luna ไม่สำเร็จ (${err?.name || "Error"})`);
      result = null;
    }
    if (!result || result.failed) {
      if (!result) noteUnmetered(now()); // 200 ที่ไม่มีเนื้อ = อาจถูกคิดเงินแล้ว
      noteModel(false);
      return { outcome: "failed", called: true, source: "luna_screen" };
    }
    if (!recordUsage(customerId, result)) return { outcome: "capped", reason: "usage_unrecorded", called: true };
    noteModel(true);
    const verdict = parseOwnerReviewScreen(result.text, names);
    if (!verdict) return { outcome: "invalid", called: true, source: "luna_screen" };
    if (!verdict.propose) return { outcome: "kept", called: true, source: "luna_screen" };
    const block = closer.blockReason(customerId, db.getCustomer(customerId), verdict.category, ctx.history);
    if (block) return { ...skip(block), called: true };
    return propose(customerId, row, batch, { source: "luna_screen", category: verdict.category, reason: verdict.reason });
  }

  async function evaluateRoom(customerId, batch, runCtx) {
    const row = db.getCustomer(customerId);
    if (!row) return skip("no_row");
    if (Number(row.ai_enabled) !== 1 || isNotQualifiedRow(row)) return skip("ai_off");
    if (db.openOwnerCloseProposalFor(customerId)) return skip("open_proposal");
    const ctx = roomContext(customerId, batch);
    const cue = detectOfftopicCue(ctx.newText);
    const block = closer.blockReason(customerId, row, cue, ctx.history);
    if (block) return skip(block);
    if (cue) return judgeCue(customerId, row, batch, cue, ctx);
    if (runCtx.scope !== "all") return skip("no_cue");
    // ห้องที่เจ้าของเคยสั่งไม่ปิด (หมวดใดก็ได้ใน 30 วัน) ไม่อ่านท่าทีซ้ำ — คำสั่งคนชนะคำเดาของ AI
    if (Object.keys(offtopicOwnerKept(db, customerId, now())).length) return skip("owner_kept");
    return screenRoom(customerId, row, batch, ctx, runCtx);
  }

  async function evaluateSafely(customerId, batch, runCtx) {
    try {
      return await evaluateRoom(customerId, batch, runCtx);
    } catch (err) {
      logger.error?.(`owner-review: ตรวจห้องไม่สำเร็จ (${err?.message || err})`);
      return { outcome: "error", called: false };
    }
  }

  function tally(counts, result) {
    counts.rooms += 1;
    if (result.called) counts.evaluated += 1;
    if (result.source === "cue_luna") counts.judged += 1;
    if (result.source === "luna_screen") counts.screened += 1;
    if (result.outcome === "proposed") counts.proposed += 1;
    else if (result.outcome === "kept") counts.kept += 1;
    else if (result.outcome === "invalid") counts.invalid += 1;
    else if (result.outcome === "failed" || result.outcome === "error") counts.failed += 1;
    else if (result.outcome === "skipped") counts.skipped[result.reason] = (counts.skipped[result.reason] || 0) + 1;
  }

  /* ---------------------------------- รอบ ---------------------------------- */

  async function notifyIfNeeded(batch, counts) {
    const added = safe(() => db.pendingOwnerCloseCountForBatch(batch.id), 0);
    counts.newPending = added;
    if (!added) return { push: "nothing_new" };
    const mode = ownerReviewMode(db);
    if (mode !== "on") return { push: `mode_${mode ?? "unknown"}` };
    // ตัวกวาดไม่ใช่ on = ยืนยันแล้วปิดห้องไม่ได้ — ไม่ปลุกเจ้าของให้มากดสิ่งที่ทำไม่ได้ (คอนโซลแสดงคำเตือนแทน)
    if (readQualifySweepModeStrict(db) !== "on") return { push: "sweep_not_on" };
    if (typeof webPush?.notifyOwner !== "function") return { push: "no_push" };
    try {
      const sent = await webPush.notifyOwner({ kind: "close" });
      return { push: sent?.skipped ? String(sent.skipped) : "sent", sent: Number(sent?.sent) || 0 };
    } catch (err) {
      logger.warn?.(`owner-review: ปลุกมือถือเจ้าของไม่สำเร็จ (${err?.message || err})`);
      return { push: "error" };
    }
  }

  async function finishBatch(batch, counts, stopped = "") {
    const pushed = await notifyIfNeeded(batch, counts);
    const t = now();
    const final = { ...counts, ...(stopped ? { stopped } : {}), push: pushed.push };
    db.updateOwnerReviewBatch(batch.id, {
      status: "ready", counts: final, readyAt: t, ...(pushed.push === "sent" ? { notifiedAt: t } : {}),
    });
    logger.log?.(`[owner-review] รอบ ${bangkokHHMM(batch.slot_ms)} เสร็จ — ห้องที่ดู ${final.rooms} · เรียก AI ${final.evaluated} · `
      + `เสนอใหม่ ${final.proposed}${stopped ? ` · หยุด: ${stopped}` : ""} · แจ้งเตือน: ${pushed.push}`);
    return { batchId: batch.id, status: "ready", counts: final };
  }

  async function runBatch(batch, startedAt) {
    const counts = readCounts(batch);
    let cursor = String(batch.cursor || "");
    const runCtx = {
      scope: ownerReviewScanScope(db),
      presetPhrases: safe(() => presetButtonPhrases({ db }), undefined),
      hints: safe(() => db.recentOwnerCloseRejections(5).map((row) => ({ category: row.category, note: row.owner_note })), []),
    };
    for (;;) {
      const page = db.ownerReviewScanCandidates({
        windowStartMs: batch.window_start_ms, windowEndMs: batch.window_end_ms, cursor, limit: CANDIDATE_PAGE,
      });
      if (!page.length) return finishBatch(batch, counts);
      for (const room of page) {
        // หยุดระหว่างห้อง = รอบยัง building · นาทีถัดไปทำต่อจาก cursor
        const pause = isDraining() ? "draining" : sweepBusy() ? "sweep_running" : breakerOpen(now()) ? "breaker"
          : now() - startedAt >= OWNER_REVIEW_RUN_MAX_MS ? "time" : ownerReviewMode(db) === "off" ? "switch_off" : "";
        if (pause) {
          db.updateOwnerReviewBatch(batch.id, { cursor, counts });
          return { batchId: batch.id, status: "building", paused: pause, counts };
        }
        const id = String(room.id);
        let result;
        if (counts.evaluated >= roomCap) {
          counts.overflow += 1;
          result = null;
        } else {
          result = await evaluateSafely(id, batch, runCtx);
          if (result.outcome === "capped") {
            db.updateOwnerReviewBatch(batch.id, { cursor, counts });
            logger.log?.(`[owner-review] หยุดรอบนี้ (${result.reason}) — เพดาน ฿${dailyThbCap * OWNER_REVIEW_SCAN_BUDGET_SHARE}/วัน (อ่านท่าที) / ฿100/วัน (ดอกที่ 2)`);
            return finishBatch(batch, counts, `budget:${result.reason}`);
          }
          tally(counts, result);
        }
        cursor = `${Number(room.last_in) || 0}:${id}`;
        db.updateOwnerReviewBatch(batch.id, { cursor, counts });
      }
    }
  }

  function claimDueBatch(t, mode) {
    const slot = ownerReviewScanSlot(t);
    if (slot == null) return { skipped: "no_slot" };
    if (db.ownerReviewBatchForSlot("scan", slot)) return { skipped: "not_due", slot };
    if (t - slot > OWNER_REVIEW_CATCHUP_MS) return { skipped: "too_late", slot };
    const previousEnd = db.previousOwnerReviewWindowEnd("scan", slot);
    const windowStartMs = Math.max(previousEnd, t - OWNER_REVIEW_FIRST_WINDOW_MS);
    const batch = db.claimOwnerReviewBatch({ kind: "scan", slotMs: slot, windowStartMs, windowEndMs: t, mode });
    if (!batch) return { skipped: "claimed_elsewhere", slot };
    logger.log?.(`[owner-review] เริ่มรอบ ${bangkokHHMM(slot)} (${mode}) — ข้อความลูกค้าตั้งแต่ ${bangkokHHMM(windowStartMs)}`);
    return { batch };
  }

  /* ---------------------------------- งานดูแล ---------------------------------- */

  function expireProposal(proposal, outcome) {
    if (typeof closeService?.expire === "function") return closeService.expire(proposal, outcome);
    return Boolean(db.casOwnerCloseProposal(proposal.id, {
      from: ["pending", "send_failed"], expectedRevision: Number(proposal.revision), patch: { status: "expired", outcome },
    }));
  }

  function maintain(t) {
    const out = { expired: 0, blocked: 0, recovered: 0 };
    try {
      for (const proposal of db.staleOwnerCloseProposals(t - OWNER_CLOSE_EXPIRE_MS)) {
        if (expireProposal(proposal, "timeout")) out.expired += 1;
      }
      if (t - lastBlockCheckAt >= OWNER_REVIEW_BLOCK_CHECK_MS) {
        lastBlockCheckAt = t;
        for (const proposal of db.pendingOwnerCloseProposals(100)) {
          const row = db.getCustomer(proposal.customer_id);
          const reason = !row || Number(row.ai_enabled) !== 1 || isNotQualifiedRow(row)
            ? "room_ai_off" : closer?.blockReason?.(proposal.customer_id, row, proposal.category) || "";
          if (reason && expireProposal(proposal, reason.startsWith("room_") ? reason : `blocked:${reason}`)) out.blocked += 1;
        }
      }
      if (typeof closeService?.recoverStuck === "function") out.recovered = closeService.recoverStuck(t);
      const day = bangkokDayStartMs(t);
      if (day !== lastPruneDay) {
        lastPruneDay = day;
        out.pruned = db.pruneOwnerReview(t - OWNER_REVIEW_RETENTION_MS);
      }
    } catch (err) {
      logger.warn?.(`owner-review: งานดูแลข้อเสนอไม่สำเร็จ (${err?.message || err})`);
    }
    return out;
  }

  // เฟส B: คิวตรวจแชทรายวัน 20:00 — ใช้เงิน/ตัวตัดวงจร/ทางสร้างข้อเสนอปิดชุดเดียวกับรอบ scan
  const daily = createOwnerReviewDailyRunner({
    db, hermes, closer, webPush, logger, now, isDraining, sweepBusy,
    budgetCheck, recordUsage, noteUnmetered, breakerOpen, noteModel, propose,
    modeOf: ownerReviewMode, scopeOf: ownerReviewScanScope, runMaxMs: OWNER_REVIEW_RUN_MAX_MS,
  });

  // 3 พ.ย. 2026: ตรวจคำตอบของทีม (เจ้าของเห็นคนเดียว) — เงิน/ตัวตัดวงจรก้อนเดียวกัน เดินเมื่อไม่มีงานของรอบ scan/daily
  const team = createTeamReplyReviewRunner({
    db, hermes, logger, now, budgetCheck, recordUsage, noteUnmetered, breakerOpen, noteModel,
  });

  async function runDue() {
    if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
    try {
      if (isDraining()) return { skipped: "draining" };
      if (!raw()) return { skipped: "not_wired" };
      const t = now();
      const maintenance = maintain(t);
      const mode = ownerReviewMode(db);
      if (mode === null) return { skipped: "db_error", maintenance };
      if (mode === "off") return { skipped: "switch_off", maintenance };
      if (typeof closer?.judge !== "function" || typeof closer?.blockReason !== "function") return { skipped: "not_wired", maintenance };
      if (breakerOpen(t)) return { skipped: "breaker_open", until: breaker.until, maintenance };
      if (sweepBusy()) return { skipped: "sweep_running", maintenance };
      breaker.consecutive = 0;
      let batch = db.buildingOwnerReviewBatches("scan")[0] ?? null;
      if (batch && t - Number(batch.created_at) > OWNER_REVIEW_STALE_BATCH_MS) {
        db.updateOwnerReviewBatch(batch.id, { status: "failed", counts: { ...readCounts(batch), stopped: "stale" }, readyAt: t });
        logger.warn?.(`[owner-review] รอบ ${bangkokHHMM(batch.slot_ms)} ค้างเกิน 12 ชม. — ปิดเป็น failed ไม่ทำต่อ`);
        batch = null;
      }
      if (!batch) {
        const claimed = claimDueBatch(t, mode);
        if (!claimed.batch) {
          // ไม่มีงานของรอบ scan = นาทีนี้ทำคิวตรวจแชทรายวันต่อ (ถ้ามี) — ไม่มีงานทั้งคู่ = คืนเหตุของรอบ scan เหมือนเดิม
          const dailyResult = await daily.runDue(t, mode);
          if (dailyResult.skipped) {
            // ห้องตรวจปิด (off) ออกไปก่อนถึงตรงนี้แล้ว — ตรวจคำตอบทีมไม่ปลุกใคร จึงเดินทั้งโหมด on และ shadow
            const teamResult = await team.runDue(t);
            if (teamResult.skipped) return { ...claimed, daily: dailyResult.skipped, team: teamResult.skipped, maintenance };
            lastRun = { at: t, kind: "team", status: teamResult.status };
            return { mode, maintenance, ...teamResult };
          }
          lastRun = { at: t, kind: "daily", status: dailyResult.status, ...(dailyResult.paused ? { paused: dailyResult.paused } : {}) };
          return { mode, maintenance, ...dailyResult };
        }
        batch = claimed.batch;
      }
      const result = await runBatch(batch, t);
      lastRun = { at: t, slot: batch.slot_ms, status: result.status, ...(result.paused ? { paused: result.paused } : {}) };
      return { mode, maintenance, ...result };
    } catch (err) {
      logger.error?.(`owner-review: รอบตรวจล้ม (${err?.message || err})`);
      return { skipped: "error" };
    } finally {
      lock.release();
    }
  }

  // ตัวเลขรวมสำหรับ /health และคอนโซล — ไม่มีรหัสห้อง ไม่มีเนื้อหา
  function stats() {
    const t = now();
    let thb = null;
    try {
      const spent = summarizeUsage(todayRows(t), pricingMap());
      thb = spent.unknownTokens > 0 ? null : Math.round(spent.usd * thbPerUsd() * 100) / 100;
    } catch { thb = null; }
    const latest = safe(() => db.latestOwnerReviewBatch("scan"), null);
    const counts = safe(() => db.ownerCloseCounts({}), null);
    return {
      mode: ownerReviewMode(db) ?? "unknown",
      scope: ownerReviewScanScope(db),
      inFlight: lock.held,
      usageBroken,
      breaker: { open: breakerOpen(t), until: breakerOpen(t) ? breaker.until : null, trips: breaker.trips },
      lastBatch: latest ? {
        slot: Number(latest.slot_ms), status: latest.status, readyAt: latest.ready_at == null ? null : Number(latest.ready_at),
        counts: readCounts(latest),
      } : null,
      lastRun,
      nextScanAt: ownerReviewNextScanAt(t),
      pending: Number(counts?.pending?.total) || 0,
      sendFailed: Number(counts?.send_failed?.total) || 0,
      today: { thb, capThb: dailyThbCap, scanCapThb: dailyThbCap * OWNER_REVIEW_SCAN_BUDGET_SHARE },
      daily: safe(() => daily.stats(), null),
    };
  }

  function start() {
    if (timer || !(intervalMs > 0)) return false;
    timer = setInterval(() => {
      runDue().catch((err) => logger.error?.(`owner-review: ${err?.message || err}`));
    }, intervalMs);
    timer.unref?.();
    logger.log?.(`[owner-review] เดินทุก ${intervalMs}ms (รอบ ${OWNER_REVIEW_SCAN_TIMES} เวลาไทย — สวิตช์ owner_review_mode เช็คสดทุกรอบ)`);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runDue, start, stop, stats, get running() { return timer !== null; } };
}
