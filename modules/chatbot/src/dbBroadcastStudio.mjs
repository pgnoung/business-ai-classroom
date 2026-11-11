// dbBroadcastStudio.mjs — ที่เก็บของสตูดิโอบรอดแคสต์ (28 ก.ย. 2026) — แยกไฟล์คุม dbBroadcast.mjs
//
// ต่อยอดตาราง broadcasts เดิม ไม่ใช่ระบบคู่ขนาน: ทุกการส่งยังเป็นแถว broadcasts หนึ่งแถว + OA claim/lease +
// quarantine ชุดเดิม ตารางใหม่เก็บเฉพาะสิ่งที่ multicast เดิมไม่มี
//   broadcast_campaigns        = โหมดผู้รับ (ป้าย/เพื่อนทุกคน/กลุ่มเป้าหมาย LINE/ข้อมูลประชากร) + เลขคำขอ LINE + สถิติ
//   broadcast_links            = ลิงก์นับคลิกต่อแคมเปญ/ต่อขั้น — นับรวมเท่านั้น ไม่มี id ลูกค้าในตารางหรือใน URL
//   broadcast_schedule_targets = งานตั้งเวลาของโหมดฝั่ง LINE (ตัวตั้งเวลาเดิมรู้จักแค่ป้าย)
//   line_follow_state          = สถานะเพิ่มเพื่อน/บล็อกล่าสุดจาก webhook ที่ตรวจลายเซ็นแล้ว (ผูกลูกค้า → อยู่ใน PDPA reset)
// การส่งฝั่ง LINE (broadcast/narrowcast) ไม่มีรายชื่อผู้รับ — ด่านกันส่งซ้ำใช้ quarantine ชุดเดิมด้วย
// audience_fingerprint = "line:<broadcastId>" ซึ่งกันทุกการส่งของ OA นั้นจนผู้ดูแลตรวจผล (dbBroadcast.claimBroadcast)
import { createHash, randomUUID } from "node:crypto";
import { SPAM_EXISTS_SQL } from "./spamTag.mjs";

export const STUDIO_MODES = Object.freeze(["tags", "all", "audience", "demographic"]);
export const LINE_SIDE_MODES = Object.freeze(["all", "audience", "demographic"]);
const LINE_SIDE_PREFIX = "line:";

export const BROADCAST_STUDIO_SCHEMA = `
-- 28 ก.ย. 2026 สตูดิโอบรอดแคสต์: ข้อมูลเสริมต่อแคมเปญ (1:1 กับ broadcasts) — แถว broadcasts เก่าไม่มีแถวนี้ = โหมดป้าย
CREATE TABLE IF NOT EXISTS broadcast_campaigns (
  broadcast_id          TEXT PRIMARY KEY REFERENCES broadcasts(id) ON DELETE CASCADE,
  channel_id            TEXT NOT NULL DEFAULT 'default',
  mode                  TEXT NOT NULL CHECK (mode IN ('tags','all','audience','demographic')),
  target_json           TEXT NOT NULL DEFAULT '{}',
  estimate              INTEGER,
  estimate_kind         TEXT NOT NULL DEFAULT 'exact' CHECK (estimate_kind IN ('exact','line_estimate','line_decides')),
  notification_disabled INTEGER NOT NULL DEFAULT 0,
  aggregation_unit      TEXT NOT NULL DEFAULT '',
  schedule_id           TEXT,
  line_request_id       TEXT NOT NULL DEFAULT '',
  line_phase            TEXT NOT NULL DEFAULT '',
  line_success_count    INTEGER,
  line_failure_count    INTEGER,
  line_target_count     INTEGER,
  line_error            TEXT NOT NULL DEFAULT '',
  line_progress_at      INTEGER,
  insight_json          TEXT NOT NULL DEFAULT '',
  insight_at            INTEGER,
  ledger_adjusted       INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broadcast_campaigns_channel ON broadcast_campaigns(channel_id, created_at);

-- ลิงก์นับคลิก: /r/<token> → redirect ไปปลายทางที่คนเขียนไว้ (เก็บฝั่งเซิร์ฟเวอร์เท่านั้น ไม่ใช่ open redirect)
-- owner_kind = broadcast (owner_id = broadcasts.id) | step (owner_id = step_sequences.id, step_no = ขั้น)
CREATE TABLE IF NOT EXISTS broadcast_links (
  token          TEXT PRIMARY KEY,
  owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('broadcast','step')),
  owner_id       TEXT NOT NULL,
  step_no        INTEGER NOT NULL DEFAULT 0,
  link_no        INTEGER NOT NULL,
  url            TEXT NOT NULL,
  label          TEXT NOT NULL DEFAULT '',
  clicks         INTEGER NOT NULL DEFAULT 0,
  first_click_at INTEGER,
  last_click_at  INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broadcast_links_owner ON broadcast_links(owner_kind, owner_id, step_no, link_no);

-- งานตั้งเวลาที่สร้างจากสตูดิโอ — ตัวตั้งเวลา (broadcastSchedule.mjs) เห็นแถวนี้ = ให้สตูดิโอส่งแทน
-- (ป้าย → multicast พร้อมลิงก์นับคลิก/สถิติ LINE · เพื่อนทุกคน/กลุ่มเป้าหมาย/ข้อมูลประชากร → broadcast/narrowcast)
CREATE TABLE IF NOT EXISTS broadcast_schedule_targets (
  schedule_id           TEXT PRIMARY KEY REFERENCES broadcast_schedules(id) ON DELETE CASCADE,
  mode                  TEXT NOT NULL CHECK (mode IN ('tags','all','audience','demographic')),
  target_json           TEXT NOT NULL DEFAULT '{}',
  notification_disabled INTEGER NOT NULL DEFAULT 0,
  track_clicks          INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL
);

-- สถานะเพื่อนล่าสุดต่อห้อง (webhook follow/unfollow) — ใช้ตัดคนที่บล็อกจากบรอดแคสต์ + ทริกเกอร์ "เพิ่มเพื่อน"
CREATE TABLE IF NOT EXISTS line_follow_state (
  customer_id       TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL DEFAULT 'default',
  state             TEXT NOT NULL CHECK (state IN ('followed','unfollowed')),
  unblocked         INTEGER NOT NULL DEFAULT 0,
  changed_at        INTEGER NOT NULL,
  first_followed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_line_follow_state_changed ON line_follow_state(channel_id, state, changed_at);
`;

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function lineSideFingerprint(broadcastId) {
  return `${LINE_SIDE_PREFIX}${String(broadcastId || "")}`;
}

export function isLineSideFingerprint(value) {
  return String(value || "").startsWith(LINE_SIDE_PREFIX);
}

export function createBroadcastStudioDbMethods({ db, run, all, get, now }) {
  function inTransaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already closed */ }
      throw error;
    }
  }

  const liveClaim = (channel, broadcastId, owner, t) => get(
    `SELECT 1 AS ok FROM broadcast_channel_claims
     WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ? AND lease_expires_at > ?`,
    channel, broadcastId, owner, t,
  );

  return {
    /* ------------------------------- campaigns ------------------------------- */

    // ผูกแคมเปญเข้ากับแถว broadcasts ที่เพิ่ง claim (ก่อนเรียก LINE เสมอ) + ลิงก์นับคลิกทั้งหมดในธุรกรรมเดียว
    attachBroadcastCampaign({
      broadcastId, channelId = "default", mode = "tags", target = {}, estimate = null, estimateKind = "exact",
      notificationDisabled = false, aggregationUnit = "", scheduleId = null, links = [],
    } = {}) {
      const id = String(broadcastId || "");
      if (!id || !STUDIO_MODES.includes(mode)) throw new Error("broadcast campaign payload ไม่ถูกต้อง");
      const t = now();
      return inTransaction(() => {
        run(
          `INSERT INTO broadcast_campaigns
            (broadcast_id, channel_id, mode, target_json, estimate, estimate_kind, notification_disabled,
             aggregation_unit, schedule_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, String(channelId || "default"), mode, JSON.stringify(target ?? {}),
          Number.isSafeInteger(estimate) ? estimate : null, String(estimateKind || "exact"),
          notificationDisabled ? 1 : 0, String(aggregationUnit || ""), scheduleId ? String(scheduleId) : null, t, t,
        );
        this.insertTrackedLinks({ ownerKind: "broadcast", ownerId: id, links, at: t });
        return this.getBroadcastCampaign(id);
      });
    },

    insertTrackedLinks({ ownerKind, ownerId, stepNo = 0, links = [], at = now() } = {}) {
      const statement = db.prepare(
        `INSERT INTO broadcast_links (token, owner_kind, owner_id, step_no, link_no, url, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let inserted = 0;
      for (const [index, link] of (links || []).entries()) {
        statement.run(
          String(link.token), String(ownerKind), String(ownerId), Number(link.stepNo ?? stepNo) || 0,
          Number(link.linkNo ?? index), String(link.url), String(link.label || "").slice(0, 40), Number(at),
        );
        inserted += 1;
      }
      return inserted;
    },

    getBroadcastCampaign(broadcastId) {
      return get("SELECT * FROM broadcast_campaigns WHERE broadcast_id = ?", String(broadcastId || "")) ?? null;
    },

    // ประวัติ: แถวเก่าที่ไม่มีแคมเปญ = โหมดป้าย (LEFT JOIN) · คลิกรวมจากลิงก์ของแคมเปญนั้น
    listBroadcastCampaigns({ channel = null, limit = 30 } = {}) {
      const where = channel ? "WHERE b.channel_id = ?" : "";
      const params = channel ? [String(channel)] : [];
      return all(
        `SELECT b.rowid AS broadcast_no, b.*, c.mode, c.target_json, c.estimate, c.estimate_kind,
                c.notification_disabled, c.aggregation_unit, c.schedule_id, c.line_request_id, c.line_phase,
                c.line_success_count, c.line_failure_count, c.line_target_count, c.line_error,
                c.line_progress_at, c.insight_json, c.insight_at,
                (SELECT COALESCE(SUM(l.clicks), 0) FROM broadcast_links l
                  WHERE l.owner_kind = 'broadcast' AND l.owner_id = b.id) AS link_clicks,
                (SELECT COUNT(*) FROM broadcast_links l
                  WHERE l.owner_kind = 'broadcast' AND l.owner_id = b.id) AS link_count
         FROM broadcasts b LEFT JOIN broadcast_campaigns c ON c.broadcast_id = b.id
         ${where}
         ORDER BY b.created_at DESC LIMIT ?`,
        ...params, Math.min(100, Math.max(1, Number(limit) || 30)),
      );
    },

    getBroadcastCampaignRow(broadcastId) {
      return get(
        `SELECT b.rowid AS broadcast_no, b.*, c.mode, c.target_json, c.estimate, c.estimate_kind,
                c.notification_disabled, c.aggregation_unit, c.schedule_id, c.line_request_id, c.line_phase,
                c.line_success_count, c.line_failure_count, c.line_target_count, c.line_error,
                c.line_progress_at, c.insight_json, c.insight_at, c.ledger_adjusted
         FROM broadcasts b LEFT JOIN broadcast_campaigns c ON c.broadcast_id = b.id
         WHERE b.id = ?`,
        String(broadcastId || ""),
      ) ?? null;
    },

    updateCampaignProgress(broadcastId, {
      phase = null, successCount = null, failureCount = null, targetCount = null, error = null, at = now(),
    } = {}) {
      const id = String(broadcastId || "");
      const changed = run(
        `UPDATE broadcast_campaigns SET
           line_phase = COALESCE(?, line_phase),
           line_success_count = COALESCE(?, line_success_count),
           line_failure_count = COALESCE(?, line_failure_count),
           line_target_count = COALESCE(?, line_target_count),
           line_error = COALESCE(?, line_error),
           line_progress_at = ?, updated_at = ?
         WHERE broadcast_id = ?`,
        phase === null ? null : String(phase), Number.isSafeInteger(successCount) ? successCount : null,
        Number.isSafeInteger(failureCount) ? failureCount : null, Number.isSafeInteger(targetCount) ? targetCount : null,
        error === null ? null : String(error).slice(0, 300), Number(at), Number(at), id,
      ).changes === 1;
      // narrowcast จบแล้วรู้ยอดคนได้รับจริง — ตัวเลขนี้ให้ประวัติแสดง "ส่งแล้ว N คน" ตามความจริงจาก LINE
      if (changed && Number.isSafeInteger(successCount)) {
        run("UPDATE broadcasts SET sent_count = ?, updated_at = ? WHERE id = ?", successCount, Number(at), id);
      }
      return changed;
    },

    saveCampaignInsight(broadcastId, { insight = null, at = now() } = {}) {
      return run(
        "UPDATE broadcast_campaigns SET insight_json = ?, insight_at = ?, updated_at = ? WHERE broadcast_id = ?",
        insight ? JSON.stringify(insight) : "", Number(at), Number(at), String(broadcastId || ""),
      ).changes === 1;
    },

    // ปรับบัญชีการส่ง LINE ครั้งเดียวต่อแคมเปญ เมื่อ LINE บอกจำนวนผู้รับจริง (broadcast/narrowcast จดตอนส่งเป็น 0)
    markCampaignLedgerAdjusted(broadcastId) {
      return run(
        "UPDATE broadcast_campaigns SET ledger_adjusted = 1, updated_at = ? WHERE broadcast_id = ? AND ledger_adjusted = 0",
        now(), String(broadcastId || ""),
      ).changes === 1;
    },

    /* ------------------------------ tracked links ----------------------------- */

    trackedLinks(ownerKind, ownerId) {
      return all(
        `SELECT token, step_no, link_no, url, label, clicks, first_click_at, last_click_at
         FROM broadcast_links WHERE owner_kind = ? AND owner_id = ? ORDER BY step_no, link_no`,
        String(ownerKind), String(ownerId),
      );
    },

    getTrackedLink(token) {
      return get("SELECT * FROM broadcast_links WHERE token = ?", String(token || "")) ?? null;
    },

    recordLinkClick(token, { at = now() } = {}) {
      const t = Number(at);
      return run(
        `UPDATE broadcast_links SET clicks = clicks + 1,
           first_click_at = COALESCE(first_click_at, ?), last_click_at = ?
         WHERE token = ?`,
        t, t, String(token || ""),
      ).changes === 1;
    },

    /* --------------------------- LINE-side delivery --------------------------- */

    // ด่านก่อนข้ามเส้น provider: แถว quarantine ถูกเขียนก่อนเรียก LINE เสมอ
    // ถ้าคำตอบหาย/โปรเซสตาย แถวนี้ค้างอยู่และกันทุกการส่งของ OA จนคนตรวจ (ไม่มีการส่งซ้ำอัตโนมัติ)
    armLineSideGuard(channelId, broadcastId, ownerToken, { retryKey = "", estimate = 0 } = {}) {
      const channel = String(channelId || "default");
      const id = String(broadcastId || "");
      const owner = String(ownerToken || "");
      if (!id || !owner) throw new Error("line-side guard payload ไม่ถูกต้อง");
      const t = now();
      return inTransaction(() => {
        if (!liveClaim(channel, id, owner, t)) return null;
        const quarantineId = randomUUID();
        run(
          `INSERT INTO broadcast_delivery_quarantines
            (id, channel_id, audience_fingerprint, broadcast_id, batch_no, retry_key_hash,
             provider_status, failure_kind, attempted_count, created_at)
           VALUES (?, ?, ?, ?, 0, ?, 0, 'ambiguous', ?, ?)`,
          quarantineId, channel, lineSideFingerprint(id), id,
          createHash("sha256").update(String(retryKey || "")).digest("hex"),
          Number.isSafeInteger(estimate) && estimate > 0 ? estimate : 0, t,
        );
        return get("SELECT * FROM broadcast_delivery_quarantines WHERE id = ?", quarantineId) ?? null;
      });
    },

    // ผลที่รู้แน่ (LINE ตอบรับ หรือปฏิเสธชัด) — ปิดด่าน + ปิดงาน + ปล่อย claim ในธุรกรรมเดียว
    settleLineSideSend(channelId, broadcastId, ownerToken, {
      quarantineId = "", accepted = false, requestId = "", lastError = "",
    } = {}) {
      const channel = String(channelId || "default");
      const id = String(broadcastId || "");
      const owner = String(ownerToken || "");
      const t = now();
      return inTransaction(() => {
        if (!liveClaim(channel, id, owner, t)) throw new Error("line-side settle: claim ไม่พร้อม");
        const removed = run(
          `DELETE FROM broadcast_delivery_quarantines
           WHERE id = ? AND channel_id = ? AND broadcast_id = ? AND resolved_at IS NULL`,
          String(quarantineId || ""), channel, id,
        );
        if (removed.changes !== 1) throw new Error("line-side settle: guard ไม่พร้อม");
        const updated = run(
          `UPDATE broadcasts SET status = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND channel_id = ? AND status = 'sending'`,
          accepted ? "done" : "failed", String(lastError || "").slice(0, 300), t, id, channel,
        );
        if (updated.changes !== 1) throw new Error("line-side settle: terminal update ไม่สำเร็จ");
        run(
          `UPDATE broadcast_campaigns SET line_request_id = ?, line_phase = ?, line_error = ?, updated_at = ?
           WHERE broadcast_id = ?`,
          String(requestId || ""), accepted ? "accepted" : "rejected", accepted ? "" : String(lastError || "").slice(0, 300),
          t, id,
        );
        const released = run(
          "DELETE FROM broadcast_channel_claims WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ?",
          channel, id, owner,
        );
        if (released.changes !== 1) throw new Error("line-side settle: claim release ไม่สำเร็จ");
        return true;
      });
    },

    // ผลไม่ชัด (timeout/0/5xx): คงแถว quarantine ไว้ + ปิดงานเป็น failed + ปล่อย claim — ห้ามส่งซ้ำอัตโนมัติ
    quarantineLineSideSend(channelId, broadcastId, ownerToken, {
      quarantineId = "", providerStatus = 0, failureKind = "ambiguous", lastError = "",
    } = {}) {
      const channel = String(channelId || "default");
      const id = String(broadcastId || "");
      const owner = String(ownerToken || "");
      const kind = new Set(["status_0", "server_error", "exception", "ambiguous"]).has(failureKind) ? failureKind : "ambiguous";
      const t = now();
      return inTransaction(() => {
        if (!liveClaim(channel, id, owner, t)) return null;
        const guard = run(
          `UPDATE broadcast_delivery_quarantines SET provider_status = ?, failure_kind = ?
           WHERE id = ? AND channel_id = ? AND broadcast_id = ? AND resolved_at IS NULL`,
          Number(providerStatus) || 0, kind, String(quarantineId || ""), channel, id,
        );
        if (guard.changes !== 1) throw new Error("line-side quarantine: guard ไม่พร้อม");
        const updated = run(
          `UPDATE broadcasts SET status = 'failed', last_error = ?, updated_at = ?
           WHERE id = ? AND channel_id = ? AND status = 'sending'`,
          String(lastError || "").slice(0, 300), t, id, channel,
        );
        if (updated.changes !== 1) throw new Error("line-side quarantine: terminal update ไม่สำเร็จ");
        run(
          "UPDATE broadcast_campaigns SET line_phase = 'unknown', line_error = ?, updated_at = ? WHERE broadcast_id = ?",
          String(lastError || "").slice(0, 300), t, id,
        );
        const released = run(
          "DELETE FROM broadcast_channel_claims WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ?",
          channel, id, owner,
        );
        if (released.changes !== 1) throw new Error("line-side quarantine: claim release ไม่สำเร็จ");
        return get("SELECT * FROM broadcast_delivery_quarantines WHERE id = ?", String(quarantineId)) ?? null;
      });
    },

    // เจ้าของตรวจผลจากหลักฐานภายนอก (OA Manager/สถิติ LINE) — ไม่ส่งอะไร บันทึกคำตัดสินอย่างเดียว
    resolveLineSideQuarantine({ id = "", channelId = "", resolvedBy = "", resolution = "", reason = "" } = {}) {
      const quarantineId = String(id || "");
      const channel = String(channelId || "");
      const operator = String(resolvedBy || "").trim();
      const decision = String(resolution || "");
      const operatorReason = String(reason || "").trim();
      if (!quarantineId || !channel || !operator
          || !new Set(["confirmed_delivered", "confirmed_not_delivered"]).has(decision)
          || operatorReason.length < 5 || operatorReason.length > 300) {
        throw new Error("line-side quarantine resolution ต้องระบุผู้ตรวจ ผลยืนยัน และเหตุผล 5-300 ตัวอักษร");
      }
      const t = now();
      return inTransaction(() => {
        const row = get(
          "SELECT * FROM broadcast_delivery_quarantines WHERE id = ? AND channel_id = ?",
          quarantineId, channel,
        );
        if (!row || !isLineSideFingerprint(row.audience_fingerprint)) return { outcome: "missing", row: null };
        if (row.resolved_at !== null) return { outcome: "already_resolved", row };
        const activeClaim = get(
          `SELECT 1 AS ok FROM broadcast_channel_claims
           WHERE broadcast_id = ? AND channel_id = ? AND lease_expires_at > ?`,
          row.broadcast_id, channel, t,
        );
        if (activeClaim) return { outcome: "delivery_active", row };
        const delivered = decision === "confirmed_delivered";
        run(
          "UPDATE broadcasts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?",
          delivered ? "done" : "failed", `quarantine resolved: ${decision}`, t, row.broadcast_id,
        );
        run(
          "UPDATE broadcast_campaigns SET line_phase = ?, updated_at = ? WHERE broadcast_id = ?",
          delivered ? "confirmed_delivered" : "confirmed_not_delivered", t, row.broadcast_id,
        );
        const resolved = run(
          `UPDATE broadcast_delivery_quarantines SET resolved_at = ?, resolved_by = ?, resolution = ?
           WHERE id = ? AND channel_id = ? AND resolved_at IS NULL`,
          t, operator, decision, quarantineId, channel,
        );
        if (resolved.changes !== 1) throw new Error("line-side quarantine resolution race");
        const reasonHash = createHash("sha256").update(operatorReason).digest("hex").slice(0, 16);
        run(
          `INSERT INTO admin_audit (id, operator, action, target, detail, created_at)
           VALUES (?, ?, 'broadcast_delivery_quarantine_resolved', ?, ?, ?)`,
          randomUUID(), operator, channel,
          `quarantine=${quarantineId}; line_side=true; resolution=${decision}; reason_recorded=true; reason_sha256=${reasonHash}`.slice(0, 500),
          t,
        );
        return { outcome: "resolved", row: get("SELECT * FROM broadcast_delivery_quarantines WHERE id = ?", quarantineId) };
      });
    },

    /* ------------------------------- results ------------------------------- */

    // ผู้รับที่รู้ชื่อจริง (โหมดป้าย) ที่ทักกลับภายในหน้าต่าง — "ทักกลับ" ไม่ได้แปลว่าทักเพราะบรอดแคสต์
    campaignRecipientReplies(broadcastId, { fromMs, toMs } = {}) {
      return Number(get(
        `SELECT COUNT(DISTINCT r.line_user_id) AS n FROM broadcast_recipients r
         WHERE r.broadcast_id = ? AND r.status = 'sent' AND EXISTS (
           SELECT 1 FROM messages m WHERE m.customer_id = r.line_user_id AND m.direction = 'in'
             AND m.created_at > ? AND m.created_at <= ?)`,
        String(broadcastId || ""), Number(fromMs), Number(toMs),
      )?.n) || 0;
    },

    campaignRecipientOrders(broadcastId, { fromMs, toMs } = {}) {
      const row = get(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT o.customer_id) AS customers, COALESCE(SUM(o.total), 0) AS total
         FROM orders o
         WHERE o.status NOT IN ('draft','cancelled') AND o.created_at > ? AND o.created_at <= ?
           AND o.customer_id IN (SELECT line_user_id FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'sent')`,
        Number(fromMs), Number(toMs), String(broadcastId || ""),
      ) || {};
      return { orders: Number(row.n) || 0, customers: Number(row.customers) || 0, total: Number(row.total) || 0 };
    },

    // โหมด "เพื่อนทุกคน": ไม่มีรายชื่อผู้รับ แต่ทุกห้องที่ระบบรู้จัก (ไม่บล็อก/ไม่ใช่สแปม/มีอยู่ก่อนส่ง) ได้รับด้วย
    // ตัวเลขนี้จึงเป็น "ประมาณจากลูกค้าที่ระบบรู้จัก" — หน้าเว็บต้องบอกแบบนั้นเสมอ
    channelKnownReplies({ channelId, fromMs, toMs } = {}) {
      return Number(get(
        `SELECT COUNT(DISTINCT m.customer_id) AS n FROM messages m
         JOIN customers c ON c.line_user_id = m.customer_id
         WHERE c.channel_id = ? AND c.created_at <= ? AND m.direction = 'in'
           AND m.created_at > ? AND m.created_at <= ? AND c.line_user_id NOT LIKE 'canary:%'`,
        String(channelId || "default"), Number(fromMs), Number(fromMs), Number(toMs),
      )?.n) || 0;
    },

    // ส่งฝั่ง LINE (เพื่อนทุกคน/กลุ่มเป้าหมาย/ข้อมูลประชากร) LINE เป็นคนเลือกผู้รับ — ระบบตัดคนตามสถานะของเราไม่ได้
    // นับให้คนกดส่งเห็นก่อนยืนยันว่ามีกี่ห้องที่ "ปกติเราไม่ส่ง" แต่รอบนี้จะได้รับ (เฉพาะห้องที่ยังไม่บล็อก ไม่ใช่ประวัติ OA เดิม)
    lineSideUnprotectedCounts(channelId) {
      const row = get(
        `SELECT
           SUM(CASE WHEN c.do_not_disturb = 1 THEN 1 ELSE 0 END) AS dnd,
           SUM(CASE WHEN c.do_not_disturb = 0 AND c.marketing_consent < 0 THEN 1 ELSE 0 END) AS optout,
           SUM(CASE WHEN c.do_not_disturb = 0 AND c.marketing_consent >= 0 AND ${SPAM_EXISTS_SQL("c.line_user_id")} THEN 1 ELSE 0 END) AS spam
         FROM customers c
         WHERE c.channel_id = ? AND c.line_user_id NOT LIKE 'canary:%'
           AND NOT EXISTS (SELECT 1 FROM customer_tags lt WHERE lt.customer_id = c.line_user_id AND lt.tag = 'ย้ายจาก LINE OA')
           AND NOT EXISTS (SELECT 1 FROM line_follow_state fs WHERE fs.customer_id = c.line_user_id AND fs.state = 'unfollowed')`,
        String(channelId || "default"),
      ) || {};
      const dnd = Number(row.dnd) || 0;
      const optout = Number(row.optout) || 0;
      const spam = Number(row.spam) || 0;
      return { dnd, optout, spam, total: dnd + optout + spam };
    },

    channelKnownOrders({ channelId, fromMs, toMs } = {}) {
      const row = get(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT o.customer_id) AS customers, COALESCE(SUM(o.total), 0) AS total
         FROM orders o JOIN customers c ON c.line_user_id = o.customer_id
         WHERE c.channel_id = ? AND c.created_at <= ? AND o.status NOT IN ('draft','cancelled')
           AND o.created_at > ? AND o.created_at <= ?`,
        String(channelId || "default"), Number(fromMs), Number(fromMs), Number(toMs),
      ) || {};
      return { orders: Number(row.n) || 0, customers: Number(row.customers) || 0, total: Number(row.total) || 0 };
    },

    /* ---------------------------- schedule targets ---------------------------- */

    // งานตั้งเวลาของสตูดิโอ = แถว broadcast_schedules เดิม + แถวเป้าหมาย ในธุรกรรมเดียว (ครึ่งเดียว = ไม่มีงาน)
    createStudioSchedule({
      channelId = "default", messages = [], includeTags = [], excludeTags = [], scheduledAt = 0, previewCount = 0,
      audienceFingerprint = "", confirmationHash = "", confirmationExpiresAt = 0, createdBy = "",
      mode = "tags", target = {}, notificationDisabled = false, trackClicks = true,
    } = {}) {
      if (!STUDIO_MODES.includes(mode)) throw new Error("schedule target mode ไม่ถูกต้อง");
      const id = randomUUID();
      const t = now();
      try {
        inTransaction(() => {
          run(
            `INSERT INTO broadcast_schedules
              (id, channel_id, messages_json, include_tags_json, exclude_tags_json,
               scheduled_at, preview_count, audience_fingerprint, confirmation_hash,
               confirmation_expires_at, status, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
            id, String(channelId || "default"), JSON.stringify(messages ?? []),
            JSON.stringify(includeTags ?? []), JSON.stringify(excludeTags ?? []),
            Number(scheduledAt), Number(previewCount) || 0, String(audienceFingerprint),
            String(confirmationHash), Number(confirmationExpiresAt), String(createdBy), t, t,
          );
          run(
            `INSERT INTO broadcast_schedule_targets (schedule_id, mode, target_json, notification_disabled, track_clicks, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            id, mode, JSON.stringify(target ?? {}), notificationDisabled ? 1 : 0, trackClicks ? 1 : 0, t,
          );
        });
      } catch (error) {
        if (/broadcast_schedules\.confirmation_hash|idx_broadcast_schedules_confirmation_hash/u.test(String(error?.message || error))) {
          const replay = new Error("broadcast schedule confirmation ถูกใช้ไปแล้ว");
          replay.code = "BROADCAST_SCHEDULE_CONFIRMATION_REPLAY";
          throw replay;
        }
        throw error;
      }
      return this.getBroadcastSchedule(id);
    },

    broadcastScheduleTarget(scheduleId) {
      const row = get("SELECT * FROM broadcast_schedule_targets WHERE schedule_id = ?", String(scheduleId || ""));
      return row ? { ...row, target: parseJson(row.target_json, {}) } : null;
    },

    /* ------------------------------ follow state ------------------------------ */

    // webhook follow/unfollow ที่ตรวจลายเซ็นแล้ว — แถวล่าสุดต่อห้อง (ไม่เก็บประวัติรายครั้ง)
    recordLineFollow({ customerId, channelId = "default", followed = true, unblocked = false, at = now() } = {}) {
      const id = String(customerId || "");
      if (!id) return false;
      const t = Number(at);
      run(
        `INSERT INTO line_follow_state (customer_id, channel_id, state, unblocked, changed_at, first_followed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET
           state = excluded.state, unblocked = excluded.unblocked, changed_at = excluded.changed_at,
           first_followed_at = COALESCE(line_follow_state.first_followed_at, excluded.first_followed_at)`,
        id, String(channelId || "default"), followed ? "followed" : "unfollowed", unblocked ? 1 : 0, t,
        followed ? t : null,
      );
      return true;
    },

    lineFollowState(customerId) {
      return get("SELECT * FROM line_follow_state WHERE customer_id = ?", String(customerId || "")) ?? null;
    },

    deleteLineFollowState(customerId) {
      return run("DELETE FROM line_follow_state WHERE customer_id = ?", String(customerId || "")).changes;
    },
  };
}
