// ownerReviewDaily.mjs — คิวตรวจแชทรายวัน 20:00 ของพี่ง้วง (ห้องตรวจ เฟส B · คำสั่งพี่ง้วง 12 ต.ค. 2026)
//
// พี่ง้วง: "ทุกวัน 20:00 ส่งประวัติแชทของลูกค้าทุกเคสของวันนั้นมาให้พี่ง้วงกับชมพู่ยืนยันว่าตอบดีไหม หรือต้องปรับอะไร
//          แล้วลูกแพรเรียนจากตรงนี้ · สัปดาห์แรกตรวจทุกแชท · ปิด MacBook ได้ · แจ้งเตือนถึงพี่ง้วงคนเดียว · ข้อมูลอยู่บน VPS"
//
// เดินในโปรเซส chassis ตัวเดียวกับรอบเสนอปิด (ownerReviewScheduler เรียก runDue เมื่อไม่มีงานของรอบ scan) — ล็อก/เพดานเงิน/
// ตัวตัดวงจรชุดเดียวกัน · Luna ทีละห้อง · หยุดระหว่างห้องได้ (ปิดโปรเซส/ตัวกวาดคัดกรองเดิน/ตัวตัดวงจร/ครบเวลาต่อนาที/ปิดสวิตช์)
//   1. จองรอบ 20:00 (owner_review_batches kind 'daily' · INSERT OR IGNORE) — เลยมาไม่เกิน 3 ชม. ยังตามเก็บ · เกินนั้นรวมเข้าวันถัดไป
//      ช่วงของรอบ = ปลายรอบ daily ก่อนหน้า → 20:00 (รอบแรก = 24 ชม. ก่อนหน้า · ช่วงยาวสุด 72 ชม.)
//   2. สร้างแถว owner_review_items หนึ่งแถวต่อห้องที่ลูกแพรตอบในช่วงนั้น (counts.populated กันสร้างซ้ำหลังรีสตาร์ต)
//   3. Luna อ่านทีละห้อง (ownerReviewDailyPrompt) → คะแนน/ปัญหา/สรุป · หมวดนอกเรื่องที่ชัด → ข้อเสนอปิดผ่านทางเดิมของเฟส A
//   4. ห้องหมด → ownerReviewTaper ตัดสินระดับของวันนี้ แล้วจัดห้องเข้าคิว → ปลุกมือถือเจ้าของ (นับจำนวนอย่างเดียว)
// เงินหมด = ห้องที่เหลือ skipped แต่ยังเข้าคิวให้คนดู (ไม่มี AI คัดกรอง = ต้องดูเอง) · รอบค้าง building เกิน 12 ชม. = ปิดแบบเดียวกัน
// คิวต้องถึงมือคนตรงเวลา (รีวิว 13 ต.ค.: Luna ล่มเคยดึงคิว 20:00 กับแจ้งเตือนไปถึงเช้า) — ตัวตัดวงจรพักได้ครั้งเดียวต่อรอบ
//   ตัดวงจรครั้งที่สอง หรือเลย 90 นาทีหลังเริ่มรอบ = ห้องที่เหลือ skipped แล้วปิดรอบ + ปลุกเจ้าของทันที
// ไม่ log เนื้อหาแชท/รหัสห้อง — log และ counts_json เป็นตัวเลขรวม
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import { bangkokHHMM, latestSlotMs, parseDigestTimes } from "./digest.mjs";
import { OFFTOPIC_CONTEXT_TURNS, offtopicOwnerKept } from "./offtopicClose.mjs";
import { isNotQualifiedRow } from "./notQualified.mjs";
import { historyBeforeCurrentInbound } from "./conversationStyle.mjs";
import { presetButtonPhrases } from "./presetButtons.mjs";
import { ownerLessonsPaused } from "./ownerLessons.mjs";
import { lukpraeWrittenSql } from "./dbOwnerReviewItems.mjs";
import {
  OWNER_REVIEW_CODES, OWNER_REVIEW_DAILY_CONTEXT_ROWS, OWNER_REVIEW_DAILY_MAX_COMPLETION_TOKENS, OWNER_REVIEW_DAILY_TIMEOUT_MS,
  OWNER_REVIEW_DAILY_WINDOW_ROWS, buildOwnerReviewDailyUser, ownerLessonRubric, ownerReviewDailySystem, parseOwnerReviewDaily,
} from "./ownerReviewDailyPrompt.mjs";
import {
  OWNER_REVIEW_STARTED_DAY_KEY, OWNER_REVIEW_TAPER_POLICY_KEY, OWNER_REVIEW_TAPER_STATE_KEY, bangkokDayKey, evaluateTaper,
  includeDecision, parseTaperPolicy, parseTaperState, shiftDayKey, taperMetrics,
} from "./ownerReviewTaper.mjs";

// เวลาคิวเป็นค่าคงที่ในโค้ด (ไม่มี env ใหม่ — กับดัก allowlist ของตัวปล่อย phase7)
export const OWNER_REVIEW_DAILY_TIME = "20:00";
export const OWNER_REVIEW_DAILY_CATCHUP_MS = 3 * 60 * 60_000;
export const OWNER_REVIEW_DAILY_FIRST_WINDOW_MS = 24 * 60 * 60_000;
export const OWNER_REVIEW_DAILY_MAX_WINDOW_MS = 72 * 60 * 60_000;
export const OWNER_REVIEW_DAILY_ROOM_CAP = 300;
export const OWNER_REVIEW_DAILY_STALE_MS = 12 * 60 * 60_000;
// คิวพร้อมไม่เกินเท่านี้หลังจองรอบ (ห้องที่ AI ยังไม่ได้อ่าน = เข้าคิวให้คนดูเอง) — กันรอบลากข้ามเที่ยงคืนไปกินงบของวันถัดไปด้วย
export const OWNER_REVIEW_DAILY_DEADLINE_MS = 90 * 60_000;
// ตัวตัดวงจรเปิดระหว่างรอบได้กี่ครั้งก่อนปิดรอบ (ครั้งแรกพัก 20 นาทีแล้วลองต่อ — Luna สะดุดชั่วคราวไม่ทำให้ทั้งคืนไม่มี AI คัดกรอง)
export const OWNER_REVIEW_DAILY_BREAKER_PAUSES = 1;
const DAILY_MINUTES = parseDigestTimes(OWNER_REVIEW_DAILY_TIME);
// ข้อความอัตโนมัติ (step/blueprint/คำลาหลังปิด/เชื่อมบัญชี) = ข้อความที่ทีมตั้งไว้เอง — ส่งให้ Luna เห็นเป็น "แอดมิน"
// (พรอมต์บอกว่าข้อความของแอดมินไม่ต้องตรวจ) · ชื่อนี้ไม่ออกไปกับบทสนทนา ใช้แค่ตัดสินผู้พูด
const AUTOMATED_SPEAKER = "ข้อความตั้งไว้";
const PAGE = 20;

/** รอบ 20:00 ล่าสุดที่ถึงเวลาแล้ว (≤ nowMs) */
export function ownerReviewDailySlot(nowMs) {
  return latestSlotMs(Number(nowMs), DAILY_MINUTES);
}

/** รอบ 20:00 ถัดไป (> nowMs) */
export function ownerReviewNextDailyAt(nowMs) {
  const at = bangkokDayStartMs(Number(nowMs)) + DAILY_MINUTES[0] * 60_000;
  return at > Number(nowMs) ? at : at + 24 * 60 * 60_000;
}

const freshCounts = () => ({
  populated: false, rooms: 0, overflow: 0, reviewed: 0, failed: 0, invalid: 0, skipped: {}, dropped: 0,
  hints: 0, proposed: 0, hintSkipped: {}, breakerPauses: 0,
});

export function readDailyCounts(batch) {
  try {
    const parsed = JSON.parse(String(batch?.counts_json || "{}"));
    const base = freshCounts();
    return parsed && typeof parsed === "object"
      ? { ...base, ...parsed, skipped: { ...(parsed.skipped || {}) }, hintSkipped: { ...(parsed.hintSkipped || {}) } }
      : base;
  } catch {
    return freshCounts();
  }
}

/**
 * @param {object} deps
 * @param {(t: number, tokensIn: number, kind: "daily") => {ok: boolean, reason?: string}} deps.budgetCheck
 * @param {(customerId: string, result: object) => boolean} deps.recordUsage
 * @param {(t: number) => void} deps.noteUnmetered
 * @param {(t: number) => boolean} deps.breakerOpen
 * @param {(ok: boolean) => void} deps.noteModel
 * @param {(customerId, row, batch, opts) => object} deps.propose ทางสร้างข้อเสนอปิดของเฟส A (audit + จุดอ้างอิง + กันซ้ำ)
 * @param {(db) => string|null} deps.modeOf สวิตช์ owner_review_mode (อ่านสดทุกห้อง)
 * @param {(db) => string} deps.scopeOf สวิตช์ owner_review_scan_scope (cue_only = ไม่เสนอปิดจากการอ่านท่าที)
 */
export function createOwnerReviewDailyRunner({
  db, hermes, closer, webPush = null, logger = console, now = Date.now, isDraining = () => false, sweepBusy = () => false,
  budgetCheck, recordUsage, noteUnmetered, breakerOpen, noteModel, propose, modeOf, scopeOf,
  roomCap = OWNER_REVIEW_DAILY_ROOM_CAP, runMaxMs = 8 * 60_000,
} = {}) {
  const raw = () => db?.raw;
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const setting = (key) => safe(() => String(db.getSetting(key) ?? ""), "");

  /* ---------------------------------- จองรอบ ---------------------------------- */

  function claim(t, mode) {
    const slot = ownerReviewDailySlot(t);
    if (slot == null) return { skipped: "daily_no_slot" };
    if (db.ownerReviewBatchForSlot("daily", slot)) return { skipped: "daily_not_due", slot };
    if (t - slot > OWNER_REVIEW_DAILY_CATCHUP_MS) return { skipped: "daily_too_late", slot };
    const previousEnd = db.previousOwnerReviewWindowEnd("daily", slot);
    const windowStartMs = previousEnd > 0
      ? Math.max(previousEnd, slot - OWNER_REVIEW_DAILY_MAX_WINDOW_MS)
      : slot - OWNER_REVIEW_DAILY_FIRST_WINDOW_MS;
    const batch = db.claimOwnerReviewBatch({ kind: "daily", slotMs: slot, windowStartMs, windowEndMs: slot, mode });
    if (!batch) return { skipped: "daily_claimed_elsewhere", slot };
    // วันที่ 1 ของการตรวจ = รอบ daily แรกที่ปลุกเจ้าของจริง (โหมด on) — โหมด shadow ไม่เริ่มนับสัปดาห์แรก
    if (mode === "on" && !setting(OWNER_REVIEW_STARTED_DAY_KEY)) {
      safe(() => db.setSetting(OWNER_REVIEW_STARTED_DAY_KEY, bangkokDayKey(slot)), null);
    }
    logger.log?.(`[owner-review] เริ่มคิวตรวจแชท ${bangkokDayKey(slot)} (${mode}) — แชทตั้งแต่ ${bangkokHHMM(windowStartMs)}`);
    return { batch };
  }

  /* ---------------------------------- อ่านห้อง ---------------------------------- */

  function windowRows(customerId, batch) {
    return raw().prepare(`SELECT m.id, m.direction, m.msg_type, m.content, m.operator, m.message_class, m.created_at,
          ${lukpraeWrittenSql("m")} AS lukprae
        FROM messages m WHERE m.customer_id = ? AND m.created_at <= ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`)
      .all(String(customerId), Number(batch.window_end_ms), OWNER_REVIEW_DAILY_WINDOW_ROWS + OWNER_REVIEW_DAILY_CONTEXT_ROWS)
      .reverse()
      .map((row) => (row.direction === "out" && !String(row.operator || "").trim() && Number(row.lukprae) !== 1
        ? { ...row, operator: AUTOMATED_SPEAKER } : row));
  }

  // บทเรียนของเจ้าของ (ใช้อยู่ · ไม่ได้กดพัก) เป็นเกณฑ์เพิ่ม — คำนวณครั้งเดียวต่อสาขาต่อการเดิน
  function systemFor(runCtx, channelId) {
    const key = String(channelId || "default");
    if (!runCtx.systems.has(key)) {
      const lessons = runCtx.lessonsPaused ? [] : safe(() => db.activeOwnerLessons(key, 300), []);
      runCtx.systems.set(key, ownerReviewDailySystem(ownerLessonRubric(lessons)));
    }
    return runCtx.systems.get(key);
  }

  const save = (item, aiStatus, fields = {}) => db.saveOwnerReviewItemReview(item.id, { aiStatus, ...fields });

  function proposeFromHint(item, batch, verdict, runCtx) {
    const category = verdict.offtopic?.category;
    if (!category) return "";
    if (runCtx.scope !== "all") return "scope_cue_only";
    const id = String(item.customer_id);
    const row = db.getCustomer(id);
    if (!row || Number(row.ai_enabled) !== 1 || isNotQualifiedRow(row)) return "ai_off";
    if (db.openOwnerCloseProposalFor(id)) return "open_proposal";
    // คำสั่ง "ไม่ปิด" ของคน (หมวดใดก็ได้ใน 30 วัน) ชนะคำเดาของ AI — แบบเดียวกับการอ่านท่าทีของรอบ scan
    if (Object.keys(offtopicOwnerKept(db, id, now())).length) return "owner_kept";
    if (closer?.recentlyKept?.(id, category)) return "kept_recently";
    const history = historyBeforeCurrentInbound(db.recentTurns(id, OFFTOPIC_CONTEXT_TURNS));
    const block = closer?.blockReason?.(id, row, category, history) ?? "not_wired";
    if (block) return block;
    const result = propose(id, row, batch, { source: "luna_screen", category, reason: verdict.offtopic.reason || verdict.summary });
    return result?.outcome === "proposed" ? "proposed" : String(result?.reason || "not_proposed");
  }

  async function reviewItem(item, batch, runCtx) {
    const id = String(item.customer_id);
    const row = db.getCustomer(id);
    if (!row) {
      save(item, "skipped");
      return { outcome: "skipped", reason: "no_row" };
    }
    const names = [row.display_name, row.known_name];
    const channel = String(row.channel_id || item.channel_id || "default");
    const t = now();
    const built = buildOwnerReviewDailyUser({
      rows: windowRows(id, batch), windowStartMs: batch.window_start_ms, nowMs: t, names, presetPhrases: runCtx.presetPhrases, channel,
    });
    if (!built.reviewIds.size) {
      save(item, "skipped");
      return { outcome: "skipped", reason: "no_messages" };
    }
    const system = systemFor(runCtx, channel);
    const budget = budgetCheck(t, system.length + built.user.length, "daily");
    if (!budget.ok) return { outcome: "capped", reason: budget.reason };
    if (typeof hermes?.ownerReviewCheck !== "function") {
      save(item, "skipped");
      return { outcome: "skipped", reason: "not_wired" };
    }
    let result = null;
    try {
      result = await hermes.ownerReviewCheck({
        system, user: built.user, maxCompletionTokens: OWNER_REVIEW_DAILY_MAX_COMPLETION_TOKENS, timeoutMs: OWNER_REVIEW_DAILY_TIMEOUT_MS,
        purpose: "daily",
      });
    } catch (err) {
      logger.warn?.(`owner-review: คิวตรวจแชท — เรียก Luna ไม่สำเร็จ (${err?.name || "Error"})`);
      result = null;
    }
    if (!result || result.failed) {
      if (!result) noteUnmetered(now()); // 200 ที่ไม่มีเนื้อ = อาจถูกคิดเงินแล้ว
      noteModel(false);
      save(item, "failed");
      return { outcome: "failed" };
    }
    const recorded = recordUsage(id, result);
    noteModel(true);
    const verdict = parseOwnerReviewDaily(result.text, { refs: built.refs, reviewIds: built.reviewIds, names });
    if (!verdict) {
      save(item, "failed");
      return recorded ? { outcome: "invalid" } : { outcome: "capped", reason: "usage_unrecorded" };
    }
    save(item, "done", {
      risk: verdict.risk, summary: verdict.summary, issues: verdict.issues, offtopicHint: verdict.offtopic?.category || "",
    });
    const hint = verdict.offtopic ? safe(() => proposeFromHint(item, batch, verdict, runCtx), "error") : "";
    if (!recorded) return { outcome: "capped", reason: "usage_unrecorded", reviewed: true, hint, dropped: verdict.dropped };
    return { outcome: "done", hint, dropped: verdict.dropped };
  }

  async function reviewSafely(item, batch, runCtx) {
    try {
      return await reviewItem(item, batch, runCtx);
    } catch (err) {
      logger.error?.(`owner-review: คิวตรวจแชท — อ่านห้องไม่สำเร็จ (${err?.message || err})`);
      safe(() => save(item, "failed"), 0); // ห้องที่พังต้องไม่ค้าง pending (ไม่งั้นวนห้องเดิมทุกนาที)
      return { outcome: "failed" };
    }
  }

  function tally(counts, result) {
    if (result.outcome === "done" || result.reviewed) counts.reviewed += 1;
    else if (result.outcome === "invalid") counts.invalid += 1;
    else if (result.outcome === "failed") counts.failed += 1;
    else if (result.outcome === "skipped") counts.skipped[result.reason] = (counts.skipped[result.reason] || 0) + 1;
    counts.dropped += Number(result.dropped) || 0;
    if (result.hint) {
      counts.hints += 1;
      if (result.hint === "proposed") counts.proposed += 1;
      else counts.hintSkipped[result.hint] = (counts.hintSkipped[result.hint] || 0) + 1;
    }
  }

  /* ---------------------------------- ปิดรอบ ---------------------------------- */

  // ระดับของวันนี้ (ลดระดับมีผลกับคิววันนี้ทันที) แล้วจัดห้องเข้าคิว — ทำซ้ำได้ผลเดิม (สุ่มด้วย hmac · ระดับจดวันเปลี่ยนไว้)
  function applyTaper(batch) {
    const dayKey = bangkokDayKey(batch.slot_ms);
    const policy = parseTaperPolicy(setting(OWNER_REVIEW_TAPER_POLICY_KEY), { codes: OWNER_REVIEW_CODES });
    const state = parseTaperState(setting(OWNER_REVIEW_TAPER_STATE_KEY));
    const metrics = taperMetrics(safe(() => db.ownerReviewLabelledItems(shiftDayKey(dayKey, -7), dayKey), []));
    const decision = evaluateTaper({ policy, state, metrics, dayKey, startedDay: setting(OWNER_REVIEW_STARTED_DAY_KEY) });
    if (decision.state.level !== state.level || decision.state.changedDay !== state.changedDay) {
      safe(() => db.setSetting(OWNER_REVIEW_TAPER_STATE_KEY, JSON.stringify(decision.state)), null);
    }
    for (const item of db.ownerReviewItemsForBatch(batch.id)) {
      let issues = [];
      try { issues = JSON.parse(String(item.issues_json || "[]")); } catch { issues = []; }
      db.setOwnerReviewItemInclusion(item.id, includeDecision({
        aiStatus: item.ai_status, risk: item.risk, issues, customerId: item.customer_id,
      }, decision.level, dayKey, policy));
    }
    return {
      level: decision.level, reason: decision.reason, dayNumber: decision.dayNumber,
      policy: { flagRisk: policy.flagRisk, sampleRate: policy.sampleRates[decision.level], pinned: policy.pin !== null },
      metrics: { labels: metrics.labels, agreement: metrics.agreement, missRate: metrics.missRate, sampleLabels: metrics.sampleLabels },
    };
  }

  async function notify(itemCounts) {
    if (!itemCounts.included) return { push: "empty" };
    const mode = modeOf(db);
    if (mode !== "on") return { push: `mode_${mode ?? "unknown"}` };
    if (typeof webPush?.notifyOwner !== "function") return { push: "no_push" };
    try {
      const sent = await webPush.notifyOwner({ kind: "daily" });
      return { push: sent?.skipped ? String(sent.skipped) : "sent" };
    } catch (err) {
      logger.warn?.(`owner-review: ปลุกมือถือเจ้าของ (คิวตรวจแชท) ไม่สำเร็จ (${err?.message || err})`);
      return { push: "error" };
    }
  }

  async function finish(batch, counts, stopped = "") {
    const taper = applyTaper(batch);
    const itemCounts = db.ownerReviewBatchItemCounts(batch.id);
    const pushed = await notify(itemCounts);
    const t = now();
    const final = {
      ...counts, ...(stopped ? { stopped } : {}), push: pushed.push, taper,
      included: itemCounts.included, flagged: itemCounts.flagged, sampled: itemCounts.sampled,
    };
    db.updateOwnerReviewBatch(batch.id, { status: "ready", counts: final, readyAt: t, ...(pushed.push === "sent" ? { notifiedAt: t } : {}) });
    logger.log?.(`[owner-review] คิวตรวจแชท ${bangkokDayKey(batch.slot_ms)} พร้อม — ห้อง ${counts.rooms} · AI อ่าน ${counts.reviewed} · `
      + `เข้าคิว ${itemCounts.included} (น่าห่วง ${itemCounts.flagged}) · ระดับ ${taper.level} (${taper.reason})`
      + `${stopped ? ` · หยุด: ${stopped}` : ""} · แจ้งเตือน: ${pushed.push}`);
    return { kind: "daily", batchId: batch.id, status: "ready", counts: final };
  }

  /** ปิดรอบก่อน AI อ่านครบ — ห้องที่เหลือเข้าคิวแบบไม่มี AI คัดกรอง (reason = budget:* | breaker | deadline | stale) */
  function closeEarly(batch, counts, reason, logLine) {
    const key = reason.startsWith("budget:") ? "budget" : reason;
    counts.skipped[key] = (counts.skipped[key] || 0) + db.skipPendingOwnerReviewItems(batch.id);
    logger.log?.(`[owner-review] คิวตรวจแชท ${bangkokDayKey(batch.slot_ms)} — ${logLine} ห้องที่เหลือ ${counts.skipped[key]} ห้องเข้าคิวให้คนดูเอง`);
    return finish(batch, counts, reason);
  }

  const pastDeadline = (batch, t) => t - Number(batch.created_at || batch.slot_ms) >= OWNER_REVIEW_DAILY_DEADLINE_MS;

  /* ---------------------------------- เดินรอบ ---------------------------------- */

  async function runBatch(batch, startedAt) {
    const counts = readDailyCounts(batch);
    if (!counts.populated) {
      const made = db.insertOwnerReviewItemsForBatch(batch, { dayKey: bangkokDayKey(batch.slot_ms), cap: roomCap });
      counts.populated = true;
      counts.rooms = made.rooms;
      counts.overflow = made.overflow;
      db.updateOwnerReviewBatch(batch.id, { counts });
    }
    const runCtx = {
      scope: safe(() => scopeOf(db), "cue_only"),
      presetPhrases: safe(() => presetButtonPhrases({ db }), undefined),
      lessonsPaused: safe(() => ownerLessonsPaused(db), true),
      systems: new Map(),
    };
    for (;;) {
      const page = db.pendingOwnerReviewItems(batch.id, PAGE);
      if (!page.length) return finish(batch, counts);
      for (const item of page) {
        const t = now();
        if (breakerOpen(t)) {
          // ตัวตัดวงจรเพิ่งเปิดในการเดินนี้ (ผู้เรียกไม่เรียกตอนเปิดอยู่) — ครั้งแรกพักแล้วลองต่อ ครั้งที่สอง/เลยเวลา = ปิดรอบ
          counts.breakerPauses = (Number(counts.breakerPauses) || 0) + 1;
          if (counts.breakerPauses > OWNER_REVIEW_DAILY_BREAKER_PAUSES || pastDeadline(batch, t)) {
            return closeEarly(batch, counts, "breaker", "Luna ล้มซ้ำ หยุดเรียก AI");
          }
        } else if (pastDeadline(batch, t)) {
          return closeEarly(batch, counts, "deadline", `ครบ ${OWNER_REVIEW_DAILY_DEADLINE_MS / 60_000} นาที หยุดเรียก AI`);
        }
        const pause = isDraining() ? "draining" : sweepBusy() ? "sweep_running" : breakerOpen(t) ? "breaker"
          : t - startedAt >= runMaxMs ? "time" : modeOf(db) === "off" ? "switch_off" : "";
        if (pause) {
          db.updateOwnerReviewBatch(batch.id, { counts });
          return { kind: "daily", batchId: batch.id, status: "building", paused: pause, counts };
        }
        const result = await reviewSafely(item, batch, runCtx);
        if (result.outcome === "capped") {
          tally(counts, result);
          return closeEarly(batch, counts, `budget:${result.reason}`, `หยุดเรียก AI (${result.reason})`);
        }
        tally(counts, result);
        db.updateOwnerReviewBatch(batch.id, { counts });
      }
    }
  }

  /**
   * งานของรอบ daily ในนาทีนี้ — ผู้เรียกถือล็อก + ตรวจสวิตช์/ตัวตัดวงจร/ตัวกวาดแล้ว
   * @returns {Promise<object>} {skipped} = ไม่มีงาน · {kind:'daily', status, ...}
   */
  async function runDue(t, mode) {
    let batch = db.buildingOwnerReviewBatches("daily")[0] ?? null;
    if (batch && t - Number(batch.created_at) > OWNER_REVIEW_DAILY_STALE_MS) {
      // เครื่องล่มข้ามคืน — ห้องที่เหลือเข้าคิวแบบไม่มี AI คัดกรอง (ดีกว่าทิ้งทั้งวัน)
      return closeEarly(batch, readDailyCounts(batch), "stale", "ค้างเกิน 12 ชม. ปิดรอบ");
    }
    if (!batch) {
      const claimed = claim(t, mode);
      if (!claimed.batch) return claimed;
      batch = claimed.batch;
    }
    return runBatch(batch, t);
  }

  function stats() {
    const latest = safe(() => db.latestOwnerReviewBatch("daily"), null);
    const counts = latest ? readDailyCounts(latest) : null;
    return {
      nextDailyAt: ownerReviewNextDailyAt(now()),
      lastBatch: latest ? {
        slot: Number(latest.slot_ms), dayKey: bangkokDayKey(latest.slot_ms), status: latest.status,
        readyAt: latest.ready_at == null ? null : Number(latest.ready_at),
        counts: {
          rooms: counts.rooms, reviewed: counts.reviewed, failed: counts.failed + counts.invalid, overflow: counts.overflow,
          included: Number(counts.included) || 0, flagged: Number(counts.flagged) || 0, proposed: counts.proposed,
          level: counts.taper?.level ?? null, push: counts.push ?? null, stopped: counts.stopped ?? null,
        },
      } : null,
    };
  }

  return { runDue, stats };
}
