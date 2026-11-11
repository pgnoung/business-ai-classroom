// retention.mjs — M4: งานลบข้อมูลเก่าตามกรอบ retention (รายวัน)
//
// แบบแผนเดียวกับ canary/followupEngine (SPEC ข้อ 5): setInterval + unref +
// synchronous lock (release ใน finally) — รอบก่อนยังไม่จบ = ข้ามรอบนี้
// RETENTION_ENABLED default true; ปิดแล้ว runOnce เป็น no-op (ไม่ลบอะไรเลย)
// กรอบอายุรายตารางมาจาก config.retentionDays (env override ได้) — ดู config.mjs
import { checkRoundsAndWarn } from "./roundsWatch.mjs";
import { checkPaymentStepAndWarn } from "./paymentStepWatch.mjs";
import { createLock } from "./locks.mjs";
import { flagStalledHotLeads } from "./hotLeadWatch.mjs";
import { purgeExpiredJevAuditManifests } from "./jevAuditRetention.mjs";

const DAY_MS = 86_400_000;
export const RETENTION_LAST_PRUNE_KEY = "retention_last_prune_at";

export function createRetention({ config, db, notifier = null, mediaDeletion = null, logger = console, now = Date.now, intervalMs = DAY_MS }) {
  const lock = createLock();
  let timer = null;

  function runOnce() {
    if (!lock.tryAcquire()) return { skipped: true, reason: "run_in_flight" };
    try {
      const t = now();
      let jevAudit = { scanned: 0, deleted: 0 };
      // Audit reports carry customer identifiers and retain their own fixed
      // 30-day policy. RETENTION_ENABLED controls chassis-table pruning, not
      // this independent final-artifact obligation.
      if (config.jevAuditDir) {
        try { jevAudit = purgeExpiredJevAuditManifests({ auditDir: config.jevAuditDir, now: t }); }
        catch (err) { logger.warn?.(`retention: Jev audit manifest retention deferred (${err?.message || err})`); }
      }
      if (config.retentionEnabled !== true) return { skipped: true, reason: "retention_disabled", jevAudit };
      const pruned = db.pruneRetention({ now: t, days: config.retentionDays || {} });
      let mediaDeletionResult = { attempted: 0, deleted: 0, missing: 0, failed: 0, pending: 0, skipped: true };
      if (typeof mediaDeletion === "function") {
        try {
          mediaDeletionResult = mediaDeletion() || mediaDeletionResult;
        } catch (err) {
          logger.warn?.(`retention: private media deletion deferred (${err?.message || err})`);
          mediaDeletionResult = { ...mediaDeletionResult, failed: 1, skipped: false };
        }
      }
      try {
        db.setSetting(RETENTION_LAST_PRUNE_KEY, String(t));
      } catch (err) {
        logger.debug?.(`retention: บันทึกเวลา prune ไม่สำเร็จ (${err?.message || err})`);
      }
      // สรุปหนึ่งบรรทัดต่อรอบ — ops เห็นได้จาก log ว่างานเดินจริงและลบไปเท่าไร
      logger.log?.(
        `[retention] pruned events_dedupe=${pruned.eventsDedupe} llm_usage=${pruned.llmUsage} ` +
        `score_history=${pruned.scoreHistory} admin_audit=${pruned.adminAudit} schedule_ack=${pruned.scheduleAck} ` +
        `opportunity_handoff=${pruned.opportunityHandoff} training_candidate=${pruned.trainingCandidate} ` +
        `attachments=${pruned.messageAttachments || 0} orphan_uploads=${pruned.orphanMessageAttachments || 0} ` +
        `media_delete_pending=${mediaDeletionResult.pending || 0} orphan_ad_referrals=${pruned.orphanAdReferrals || 0}`
        + ` jev_audit_deleted=${jevAudit.deleted || 0}`
      );
      // v1.3.4: เกาะรอบเดียวกับ retention — ตัวเฝ้าดีลร้อนค้างไม่ทักลูกค้า แค่ติดป้ายให้ทีมเห็น
      // ล้มเหลวห้ามกระทบ retention หรือแชทหลัก
      let hotLeads = { flagged: 0 };
      try {
        hotLeads = flagStalledHotLeads({ db, now, logger });
      } catch (err) {
        logger.debug?.(`retention: ตัวเฝ้าดีลร้อนค้างล้มเหลว (${err?.message || err})`);
      }
      // v1.4.32: ตารางรอบเรียนใกล้หมด = เสียโอกาสขายเงียบ ๆ — เกาะรอบเดียวกันเพื่อไม่สร้าง
      // timer ใหม่ และล้มเหลวห้ามกระทบ retention หรือแชทหลัก (เหมือนตัวเฝ้าดีลร้อนค้าง)
      let rounds = { skipped: "not_run" };
      try {
        rounds = checkRoundsAndWarn({ config, db, notifier, logger, now });
      } catch (err) {
        logger.debug?.(`retention: ตัวเฝ้าตารางรอบเรียนล้มเหลว (${err?.message || err})`);
      }
      // 18 ต.ค. 2026 (audit ลูกแพร): ห้องตอบเรื่องออกเอกสารแล้ว แต่ระบบส่งบัญชี 0 ครั้งใน 48 ชม. = แจ้งเจ้าของ
      // เกาะรอบเดียวกัน ล้มเหลวห้ามกระทบ retention หรือแชทหลัก (เหมือนตัวเฝ้าตารางรอบเรียน)
      let paymentStep = { skipped: "not_run" };
      try {
        paymentStep = checkPaymentStepAndWarn({ db, notifier, logger, now, enabled: config.salesDecisionGuardEnabled === true });
      } catch (err) {
        logger.debug?.(`retention: ตัวเฝ้าขั้นชำระเงินล้มเหลว (${err?.message || err})`);
      }
      return { ok: true, pruned, mediaDeletion: mediaDeletionResult, jevAudit, hotLeads, rounds, paymentStep, at: t };
    } finally {
      lock.release(); // ปล่อย lock เสมอ ไม่ว่าจะจบทางไหน
    }
  }

  // อ่านเวลา prune ล่าสุดจาก settings (คงอยู่ข้าม restart — process เดียวเป็นเจ้าของ DB)
  function lastPruneAt() {
    try {
      const n = Number(db.getSetting(RETENTION_LAST_PRUNE_KEY));
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  // เหตุจริง 2026-08-14: setInterval 24 ชม.โดยไม่มีรอบแรกตอนบูต + pilot ถูกรีสตาร์ท
  // ทุกครั้งที่ deploy = งานนี้ "ไม่เคยรันเลยสักครั้ง" ตั้งแต่มีฟีเจอร์ (พิสูจน์: ไม่มี
  // retention_last_prune_at ใน DB จริง) ทุกอย่างที่เกาะรอบนี้ (hotLeadWatch) จึงตายตามด้วย
  // ต้องรันรอบแรกไม่นานหลังบูต แล้วรอบถัดไปตามตาราง — ดีเลย์สั้น ๆ กันชนกับช่วงบูตหนัก
  const BOOT_DELAY_MS = 2 * 60 * 1000;

  function start() {
    if (timer || intervalMs <= 0) return false;
    const tick = () => {
      try {
        runOnce();
      } catch (err) {
        logger.error?.(`retention: ${err?.message || err}`);
      }
    };
    const boot = setTimeout(() => {
      // ข้ามรอบบูตถ้าเพิ่งรันไปไม่นาน (เช่น รีสตาร์ทถี่ ๆ ตอน deploy) — กันงานถี่เกินตาราง
      const last = lastPruneAt();
      if (last === null || Date.now() - last >= intervalMs) tick();
    }, BOOT_DELAY_MS);
    boot.unref?.();
    timer = setInterval(tick, intervalMs);
    timer.unref?.(); // ไม่ค้ำ process ตอน shutdown
    logger.log?.(`[retention] งานลบข้อมูลเก่าเดินทุก ${intervalMs}ms + รอบแรกใน ${BOOT_DELAY_MS}ms (enabled=${config.retentionEnabled === true})`);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    runOnce,
    start,
    stop,
    lastPruneAt,
    get busy() { return lock.held; },
    get running() { return timer !== null; },
  };
}
