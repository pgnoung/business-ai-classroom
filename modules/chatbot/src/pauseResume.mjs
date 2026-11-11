// pauseResume.mjs — ตัวกวาดเมื่อหมดเวลาพัก AI (2026-09-28)
//
// ลูกค้าพิมพ์ระหว่าง AI พัก 15 นาที (คนเพิ่งตอบ) แล้วไม่มีใครตอบต่อ และไม่ได้พิมพ์อะไรเพิ่มหลังหมดเวลาพัก
// = AI ตอบชุดนั้นหนึ่งครั้งผ่านไปป์ไลน์ปกติ (บริบทเต็ม รวมคำตอบของคน) — นิยาม "ชุดที่ค้าง" และเหตุผล
// อยู่ที่ pauseHeld.mjs (ถ้าลูกค้าพิมพ์ต่อหลังหมดเวลาพัก เทิร์นปกติรวมชุดนี้เข้าไปเอง ไม่ใช่งานของไฟล์นี้)
//
// กติกาเหล็กที่ไฟล์นี้ต้องรักษา:
//   · ตอบครั้งเดียวต่อชุดข้อความ: จองสิทธิ์ใน proactive_attempts (lane pause_resume, key = ข้อความล่าสุด)
//     แล้วปักรั้ว 'sending' ก่อนเรียกไปป์ไลน์ — รอบถัดไปหรือการรีสตาร์ตเรียกซ้ำไม่ได้ แม้ผลจะเป็นถูกกัน/ล้ม
//   · กันตอบซ้อนกับข้อความใหม่: ตรวจซ้ำในคิวต่อลูกค้าเดียวกับเส้นตอบปกติ (runExclusive) และถ้าลูกค้า
//     พิมพ์เข้ามาระหว่างคิด respondToBurst รวมข้อความไปข้างหน้าเอง (merged_forward) = คำตอบเดียว
//   · ไม่ส่งเอง ไม่แต่งคำตอบเอง: ทุกด่านของเส้นตอบปกติ (guard/ราคา/เวลาทำการ/เส้นเงิน) ยังตัดสินเหมือนเดิม
import { aiPausedNow } from "./aiPause.mjs";
import { createLock } from "./locks.mjs";
import {
  PAUSE_RESUME_AUDIT_ACTION, PAUSE_RESUME_LOOKBACK_MS, pauseResumeEnabled, scanPauseHeld,
} from "./pauseHeld.mjs";
import { CAMPAIGN_KEYWORD, paymentStartedFromRow } from "./pipeline.mjs";

export {
  PAUSE_RESUME_AUDIT_ACTION, PAUSE_RESUME_LOOKBACK_MS, PAUSE_RESUME_SETTING, pauseResumeEnabled, pauseResumeMode,
} from "./pauseHeld.mjs";
export const PAUSE_RESUME_LANE = "pause_resume";
export const PAUSE_RESUME_TICK_MS = 60_000;
// ห้องที่ตรวจต่อรอบ (ส่วนใหญ่จบที่ "ตอบแล้ว" ด้วยการอ่านแถวเดียว) กับห้องที่เรียกโมเดลจริงต่อรอบ
// แยกกันเพื่อไม่ให้ห้องใหม่อดคิวเพราะห้องเก่าที่ตอบไปแล้วกินที่ LIMIT
const CANDIDATES_PER_TICK = 200;
const DISPATCHES_PER_TICK = 5;

const isCampaignText = (text) => CAMPAIGN_KEYWORD.test(text);

/**
 * ห้องนี้ถึงเวลาที่ตัวกวาดต้องตอบชุดที่ค้างหรือยัง
 * @returns {{ok: true, anchorId: string, parts: string[], sessionId: string} | {ok: false, reason: string}}
 */
export function findPauseResume(db, customer, nowMs = Date.now()) {
  const scan = scanPauseHeld(db, customer, { nowMs, isMoneyRoom: paymentStartedFromRow, isCampaignText });
  if (!scan.ok) return scan;
  // ลูกค้าพิมพ์ต่อหลังหมดเวลาพักแล้ว — เส้นตอบปกติเป็นเจ้าของ (และรวมชุดที่ค้างเข้าไปเอง)
  if (scan.later > 0) return { ok: false, reason: "after_pause" };
  return { ok: true, anchorId: scan.anchorId, parts: scan.parts, sessionId: scan.sessionId };
}

function outcomeOf(verdict) {
  if (!verdict) return "unknown";
  if (verdict.error) return "error";
  if (verdict.sent === true) return "sent";
  if (verdict.sent === false) return "send_failed";
  if (verdict.suppressed) return `suppressed:${verdict.suppressed}`;
  if (verdict.blocked) return `blocked:${verdict.reason || "guard"}`;
  return String(verdict.skipped || "unknown");
}

export function createPauseResumeSweep({
  db, config = {}, pipeline, logger = console, now = Date.now, isDraining = () => false, tickMs = PAUSE_RESUME_TICK_MS,
} = {}) {
  const lock = createLock();
  let timer = null;

  async function resumeRoom(customerId, nowMs) {
    const pending = findPauseResume(db, db.getCustomer(customerId), nowMs);
    if (!pending.ok) return { customerId, skipped: pending.reason };
    const claim = db.claimProactiveAttempt(customerId, PAUSE_RESUME_LANE, pending.anchorId, nowMs);
    if (!claim.ok) return { customerId, skipped: claim.reason };
    // ปักรั้วก่อนเรียกโมเดล: ผลออกมาแบบไหนก็ตาม (ส่ง/ถูกกัน/ล้ม) ชุดข้อความนี้จะไม่ถูกลองซ้ำอีก
    db.fenceProactiveSend(customerId, PAUSE_RESUME_LANE, pending.anchorId, nowMs);
    let verdict;
    try {
      verdict = await pipeline.runExclusive(customerId, async () => {
        // ตรวจซ้ำในคิวต่อลูกค้า: คนตอบเข้ามา / ข้อความใหม่ / ห้องถูกปิดระหว่างรอคิว = ไม่ตอบ
        const fresh = findPauseResume(db, db.getCustomer(customerId), now());
        if (!fresh.ok || fresh.anchorId !== pending.anchorId) return { skipped: `recheck:${fresh.reason || "changed"}` };
        return pipeline.respondToBurst({
          customerId, text: fresh.parts.join("\n"), parts: fresh.parts, replyToken: "", expectedSessionId: fresh.sessionId,
        });
      });
    } catch (err) {
      verdict = { error: err };
      logger.error?.(`pauseResume: ตอบข้อความค้างไม่สำเร็จ (${err?.message || err}) customer=${customerId}`);
    } finally {
      db.settleProactiveSend(customerId, PAUSE_RESUME_LANE, pending.anchorId, now());
    }
    const outcome = outcomeOf(verdict);
    try {
      db.addAudit({
        operator: "system", action: PAUSE_RESUME_AUDIT_ACTION, target: customerId,
        detail: `หมดเวลาพัก AI — ข้อความค้างระหว่างพัก ${pending.parts.length} ข้อความ → ${outcome}`,
      });
    } catch { /* audit พังห้ามทำให้รอบกวาดล้ม */ }
    return { customerId, outcome };
  }

  async function runOnce() {
    if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
    try {
      if (isDraining()) return { skipped: "draining" };
      if (!pauseResumeEnabled(db)) return { skipped: "disabled" };
      if (aiPausedNow({ db, config })) return { skipped: "ai_paused" };
      const nowMs = now();
      const rooms = db.raw.prepare(
        `SELECT line_user_id AS id FROM customers
          WHERE ai_enabled = 1 AND do_not_disturb = 0 AND COALESCE(state, '') <> 'NEEDS_HUMAN'
            AND operator_active_until > ? AND operator_active_until <= ?
            AND line_user_id NOT LIKE 'canary:%'
          ORDER BY operator_active_until ASC LIMIT ?`,
      ).all(nowMs - PAUSE_RESUME_LOOKBACK_MS, nowMs, CANDIDATES_PER_TICK);
      const results = [];
      let dispatched = 0;
      for (const room of rooms) {
        if (dispatched >= DISPATCHES_PER_TICK || isDraining()) break;
        try {
          const result = await resumeRoom(String(room.id), nowMs);
          if (result.outcome) dispatched += 1;
          results.push(result);
        } catch (err) {
          logger.error?.(`pauseResume: ${err?.message || err}`);
          results.push({ customerId: String(room.id), skipped: "error" });
        }
      }
      return { checked: rooms.length, dispatched, results };
    } catch (err) {
      logger.error?.(`pauseResume: รอบกวาดล้ม (${err?.message || err})`);
      return { skipped: "error" };
    } finally {
      lock.release();
    }
  }

  return {
    runOnce,
    start() {
      if (timer || !(tickMs > 0)) return false;
      timer = setInterval(() => { runOnce().catch(() => {}); }, tickMs);
      timer.unref?.(); // ไม่ค้ำ process ตอน shutdown
      return true;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get running() { return timer !== null; },
  };
}
