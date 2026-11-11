// dbStepMessages.mjs — ที่เก็บของ "ข้อความตามขั้น" (Step messages) (28 ก.ย. 2026)
//
// พี่ง้วงขอ (28 ก.ย. 2026): "ให้สร้างระบบ STEP MESSAGE เหมือน LINE OA เลย โดยตอนนี้ step message สามารถทำได้ ใน LINE OA เท่านั้น"
//   step_sequences   = ลำดับขั้นหนึ่งชุด: ทริกเกอร์ + ขั้น (หน่วงเวลา · ข้อความสำเร็จรูป · เงื่อนไขป้าย) + สถานะ
//   step_enrollments = ลูกค้าหนึ่งคนในลำดับหนึ่งชุด (ครั้งเดียวต่อชุด) — ขั้นถัดไป เวลาถึงกำหนด เหตุที่หยุด
//                      status baseline = คนที่มีป้าย/ออเดอร์อยู่ก่อนเปิดใช้ (ไม่ส่ง แค่กันไม่ให้ถูกนับเป็นคนใหม่)
//   step_deliveries  = การส่งแต่ละขั้นต่อคน (PRIMARY KEY กันส่งซ้ำ: แถวถูกเขียนก่อนเรียก LINE เสมอ)
// ตารางที่มี customer_id ทั้งสองถูกลบใน resetCustomer (PDPA) — ไม่มี id ลูกค้าในสถิติที่ส่งออกหน้าจอ
import { randomUUID } from "node:crypto";

export const STEP_TRIGGERS = Object.freeze(["follow", "keyword", "tag", "order_paid"]);
export const STEP_SEQUENCE_STATUSES = Object.freeze(["draft", "active", "paused", "archived"]);

export const STEP_MESSAGES_SCHEMA = `
-- 28 ก.ย. 2026 ข้อความตามขั้น (Step messages) — ดู src/stepMessages.mjs
CREATE TABLE IF NOT EXISTS step_sequences (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL DEFAULT 'default',
  name              TEXT NOT NULL DEFAULT '',
  trigger_type      TEXT NOT NULL CHECK (trigger_type IN ('follow','keyword','tag','order_paid')),
  trigger_value     TEXT NOT NULL DEFAULT '',
  stop_on_reply     INTEGER NOT NULL DEFAULT 0,
  steps_json        TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  version           INTEGER NOT NULL DEFAULT 1,
  trigger_since     INTEGER,
  activated_at      INTEGER,
  activated_by      TEXT NOT NULL DEFAULT '',
  activated_version INTEGER,
  paused_at         INTEGER,
  paused_by         TEXT NOT NULL DEFAULT '',
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_step_sequences_channel ON step_sequences(channel_id, status);

CREATE TABLE IF NOT EXISTS step_enrollments (
  id             TEXT PRIMARY KEY,
  sequence_id    TEXT NOT NULL REFERENCES step_sequences(id) ON DELETE CASCADE,
  customer_id    TEXT NOT NULL,
  channel_id     TEXT NOT NULL DEFAULT 'default',
  status         TEXT NOT NULL CHECK (status IN ('baseline','active','completed','stopped')),
  next_step      INTEGER NOT NULL DEFAULT 0,
  next_due_at    INTEGER,
  anchor_at      INTEGER NOT NULL,
  enrolled_at    INTEGER NOT NULL,
  trigger_detail TEXT NOT NULL DEFAULT '',
  defer_reason   TEXT NOT NULL DEFAULT '',
  stop_reason    TEXT NOT NULL DEFAULT '',
  stopped_at     INTEGER,
  last_sent_at   INTEGER,
  lease_owner    TEXT NOT NULL DEFAULT '',
  lease_until    INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  UNIQUE (sequence_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_step_enrollments_due ON step_enrollments(status, next_due_at);
CREATE INDEX IF NOT EXISTS idx_step_enrollments_customer ON step_enrollments(customer_id, status);

CREATE TABLE IF NOT EXISTS step_deliveries (
  enrollment_id TEXT NOT NULL REFERENCES step_enrollments(id) ON DELETE CASCADE,
  sequence_id   TEXT NOT NULL,
  step_no       INTEGER NOT NULL,
  customer_id   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('sending','sent','failed','unknown','skipped')),
  reason        TEXT NOT NULL DEFAULT '',
  request_id    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (enrollment_id, step_no)
);
CREATE INDEX IF NOT EXISTS idx_step_deliveries_sequence ON step_deliveries(sequence_id, step_no, status);
CREATE INDEX IF NOT EXISTS idx_step_deliveries_customer ON step_deliveries(customer_id);
`;

function parseSteps(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function hydrateSequence(row) {
  return row ? { ...row, steps: parseSteps(row.steps_json), stop_on_reply: Number(row.stop_on_reply) === 1 } : null;
}

export function createStepMessageDbMethods({ db, run, all, get, now }) {
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

  return {
    /* ------------------------------- sequences ------------------------------- */

    createStepSequence({ channelId = "default", name = "", triggerType, triggerValue = "", stopOnReply = false, steps = [], createdBy = "" } = {}) {
      const id = randomUUID();
      const t = now();
      run(
        `INSERT INTO step_sequences (id, channel_id, name, trigger_type, trigger_value, stop_on_reply, steps_json,
           status, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
        id, String(channelId || "default"), String(name), String(triggerType), String(triggerValue),
        stopOnReply ? 1 : 0, JSON.stringify(steps), String(createdBy), t, t,
      );
      return this.getStepSequence(id);
    },

    getStepSequence(id) {
      return hydrateSequence(get("SELECT * FROM step_sequences WHERE id = ?", String(id || "")));
    },

    listStepSequences({ channel = null, includeArchived = false } = {}) {
      const where = [];
      const params = [];
      if (channel) { where.push("channel_id = ?"); params.push(String(channel)); }
      if (!includeArchived) where.push("status != 'archived'");
      return all(
        `SELECT * FROM step_sequences ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END, updated_at DESC`,
        ...params,
      ).map(hydrateSequence);
    },

    activeStepSequences({ channel = null, triggerType = null } = {}) {
      const where = ["status = 'active'"];
      const params = [];
      if (channel) { where.push("channel_id = ?"); params.push(String(channel)); }
      if (triggerType) { where.push("trigger_type = ?"); params.push(String(triggerType)); }
      return all(`SELECT * FROM step_sequences WHERE ${where.join(" AND ")} ORDER BY created_at`, ...params).map(hydrateSequence);
    },

    countActiveStepSequences(channelId) {
      return Number(get("SELECT COUNT(*) AS n FROM step_sequences WHERE channel_id = ? AND status = 'active'", String(channelId))?.n) || 0;
    },

    // แก้ได้เฉพาะร่าง/พักอยู่ — version +1 ทุกครั้ง (ใบยืนยันเปิดใช้ผูกกับ version)
    updateStepSequence(id, { name, triggerType, triggerValue, stopOnReply, steps } = {}) {
      const t = now();
      const changed = run(
        `UPDATE step_sequences SET name = ?, trigger_type = ?, trigger_value = ?, stop_on_reply = ?, steps_json = ?,
           version = version + 1, updated_at = ?
         WHERE id = ? AND status IN ('draft','paused')`,
        String(name), String(triggerType), String(triggerValue), stopOnReply ? 1 : 0, JSON.stringify(steps), t, String(id),
      ).changes === 1;
      return changed ? this.getStepSequence(id) : null;
    },

    // เปิดใช้: เวลาเริ่มนับทริกเกอร์ = ตอนนี้ + คนที่มีป้าย/ออเดอร์อยู่แล้ว = baseline (ไม่ได้รับ) ในธุรกรรมเดียว
    activateStepSequence(id, { version, activatedBy = "", baselineCustomerIds = [], links = [] } = {}) {
      const t = now();
      return inTransaction(() => {
        const changed = run(
          `UPDATE step_sequences SET status = 'active', trigger_since = ?, activated_at = COALESCE(activated_at, ?),
             activated_by = ?, activated_version = version, paused_at = NULL, paused_by = '', updated_at = ?
           WHERE id = ? AND version = ? AND status IN ('draft','paused')`,
          t, t, String(activatedBy), t, String(id), Number(version),
        ).changes === 1;
        if (!changed) return null;
        const sequence = this.getStepSequence(id);
        const insertBaseline = db.prepare(
          `INSERT OR IGNORE INTO step_enrollments
             (id, sequence_id, customer_id, channel_id, status, next_step, next_due_at, anchor_at, enrolled_at, trigger_detail, updated_at)
           VALUES (?, ?, ?, ?, 'baseline', 0, NULL, ?, ?, 'existing_before_activation', ?)`,
        );
        let baseline = 0;
        for (const customerId of baselineCustomerIds) {
          baseline += insertBaseline.run(randomUUID(), sequence.id, String(customerId), sequence.channel_id, t, t, t).changes;
        }
        const ownerId = `${sequence.id}:v${sequence.version}`;
        const existing = new Set(all("SELECT token FROM broadcast_links WHERE owner_kind = 'step' AND owner_id = ?", ownerId).map((r) => r.token));
        if (!existing.size && links.length) {
          const statement = db.prepare(
            `INSERT INTO broadcast_links (token, owner_kind, owner_id, step_no, link_no, url, label, created_at)
             VALUES (?, 'step', ?, ?, ?, ?, ?, ?)`,
          );
          for (const link of links) {
            statement.run(String(link.token), ownerId, Number(link.stepNo) || 0, Number(link.linkNo) || 0,
              String(link.url), String(link.label || "").slice(0, 40), t);
          }
        }
        return { sequence: this.getStepSequence(id), baseline };
      });
    },

    pauseStepSequence(id, { pausedBy = "" } = {}) {
      const t = now();
      const changed = run(
        "UPDATE step_sequences SET status = 'paused', paused_at = ?, paused_by = ?, updated_at = ? WHERE id = ? AND status = 'active'",
        t, String(pausedBy), t, String(id),
      ).changes === 1;
      return changed ? this.getStepSequence(id) : null;
    },

    // ปิดถาวร: ลำดับนี้ไม่รับคนเพิ่ม และทุกคนที่ยังอยู่ในลำดับหยุดทันที (ไม่มีการส่งค้าง)
    archiveStepSequence(id) {
      const t = now();
      return inTransaction(() => {
        const changed = run(
          "UPDATE step_sequences SET status = 'archived', updated_at = ? WHERE id = ? AND status != 'archived'",
          t, String(id),
        ).changes === 1;
        if (!changed) return null;
        run(
          `UPDATE step_enrollments SET status = 'stopped', stop_reason = 'sequence_archived', stopped_at = ?, updated_at = ?
           WHERE sequence_id = ? AND status = 'active'`,
          t, t, String(id),
        );
        return this.getStepSequence(id);
      });
    },

    stepSequenceLinks(sequence) {
      return all(
        `SELECT token, step_no, link_no, url, label, clicks FROM broadcast_links
         WHERE owner_kind = 'step' AND owner_id = ? ORDER BY step_no, link_no`,
        `${sequence.id}:v${sequence.version}`,
      );
    },

    /* ------------------------------- enrollments ------------------------------- */

    // ครั้งเดียวต่อคนต่อชุด (UNIQUE) — เข้าซ้ำ/เคยเป็น baseline = ไม่เข้าใหม่
    enrollStepCustomer({ sequenceId, customerId, channelId = "default", at = now(), dueAt, detail = "" } = {}) {
      const t = Number(at);
      const inserted = run(
        `INSERT OR IGNORE INTO step_enrollments
           (id, sequence_id, customer_id, channel_id, status, next_step, next_due_at, anchor_at, enrolled_at, trigger_detail, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)`,
        randomUUID(), String(sequenceId), String(customerId), String(channelId || "default"),
        Number(dueAt), t, t, String(detail).slice(0, 80), now(),
      ).changes === 1;
      return inserted;
    },

    getStepEnrollment(id) {
      return get("SELECT * FROM step_enrollments WHERE id = ?", String(id || "")) ?? null;
    },

    // ถึงกำหนด + ลำดับยัง active — จับจองด้วย lease (หลายโปรเซสไม่หยิบคนเดียวกัน)
    claimDueStepEnrollments({ at = now(), limit = 20, owner = "", leaseMs = 120_000 } = {}) {
      const t = Number(at);
      return inTransaction(() => {
        const rows = all(
          `SELECT e.* FROM step_enrollments e JOIN step_sequences s ON s.id = e.sequence_id
           WHERE e.status = 'active' AND e.next_due_at IS NOT NULL AND e.next_due_at <= ? AND e.lease_until <= ?
             AND s.status = 'active'
           ORDER BY e.next_due_at, e.enrolled_at LIMIT ?`,
          t, t, Math.min(200, Math.max(1, Number(limit) || 20)),
        );
        const statement = db.prepare(
          "UPDATE step_enrollments SET lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND lease_until <= ?",
        );
        return rows.filter((row) => statement.run(String(owner), t + Number(leaseMs), t, row.id, t).changes === 1);
      });
    },

    releaseStepEnrollment(id, owner) {
      run("UPDATE step_enrollments SET lease_owner = '', lease_until = 0 WHERE id = ? AND lease_owner = ?", String(id), String(owner));
    },

    deferStepEnrollment(id, { until, reason = "" } = {}) {
      return run(
        `UPDATE step_enrollments SET next_due_at = ?, defer_reason = ?, lease_owner = '', lease_until = 0, updated_at = ?
         WHERE id = ? AND status = 'active'`,
        Number(until), String(reason).slice(0, 40), now(), String(id),
      ).changes === 1;
    },

    stopStepEnrollment(id, reason) {
      const t = now();
      return run(
        `UPDATE step_enrollments SET status = 'stopped', stop_reason = ?, stopped_at = ?, lease_owner = '', lease_until = 0, updated_at = ?
         WHERE id = ? AND status = 'active'`,
        String(reason).slice(0, 40), t, t, String(id),
      ).changes === 1;
    },

    // หยุดทุกลำดับที่ลูกค้าคนนี้ยังอยู่ (บล็อก/ขอหยุด ฯลฯ) — sequenceFilter ใช้กับ "ลูกค้าตอบ" ที่เลือกได้ต่อชุด
    stopStepEnrollmentsForCustomer(customerId, reason, { onlyStopOnReply = false, enrolledBefore = null } = {}) {
      const t = now();
      const where = ["customer_id = ?", "status = 'active'"];
      const params = [String(customerId)];
      if (onlyStopOnReply) where.push("sequence_id IN (SELECT id FROM step_sequences WHERE stop_on_reply = 1)");
      if (enrolledBefore !== null) { where.push("enrolled_at < ?"); params.push(Number(enrolledBefore)); }
      return run(
        `UPDATE step_enrollments SET status = 'stopped', stop_reason = ?, stopped_at = ?, lease_owner = '', lease_until = 0, updated_at = ?
         WHERE ${where.join(" AND ")}`,
        String(reason).slice(0, 40), t, t, ...params,
      ).changes;
    },

    // เดินไปขั้นถัดไป (หรือจบ) หลังส่ง/ข้ามขั้น — anchor = เวลาที่เริ่มนับหน่วงของขั้นถัดไป
    advanceStepEnrollment(id, { nextStep, dueAt = null, anchorAt, sentAt = null, completed = false } = {}) {
      const t = now();
      return run(
        `UPDATE step_enrollments SET next_step = ?, next_due_at = ?, anchor_at = ?, last_sent_at = COALESCE(?, last_sent_at),
           status = ?, defer_reason = '', lease_owner = '', lease_until = 0, updated_at = ?
         WHERE id = ? AND status = 'active'`,
        Number(nextStep), completed ? null : Number(dueAt), Number(anchorAt), sentAt === null ? null : Number(sentAt),
        completed ? "completed" : "active", t, String(id),
      ).changes === 1;
    },

    // ด่านกันส่งซ้ำ: แถวนี้ต้องเกิดก่อนเรียก LINE — มีอยู่แล้ว = เคยพยายามส่งขั้นนี้ไปแล้ว (ห้ามส่งซ้ำ)
    beginStepDelivery({ enrollmentId, sequenceId, stepNo, customerId, status = "sending", reason = "" } = {}) {
      const t = now();
      return run(
        `INSERT OR IGNORE INTO step_deliveries (enrollment_id, sequence_id, step_no, customer_id, status, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        String(enrollmentId), String(sequenceId), Number(stepNo), String(customerId), String(status), String(reason).slice(0, 60), t, t,
      ).changes === 1;
    },

    settleStepDelivery({ enrollmentId, stepNo, status, reason = "", requestId = "" } = {}) {
      return run(
        `UPDATE step_deliveries SET status = ?, reason = ?, request_id = ?, updated_at = ?
         WHERE enrollment_id = ? AND step_no = ? AND status = 'sending'`,
        String(status), String(reason).slice(0, 60), String(requestId || ""), now(), String(enrollmentId), Number(stepNo),
      ).changes === 1;
    },

    // LINE ปฏิเสธชัด ๆ ว่ายังไม่รับ (429/ช่องส่งปิด) = ไม่มีการส่งเกิดขึ้น → ถอดด่านเพื่อให้ลองใหม่ภายหลังได้
    clearStepDelivery({ enrollmentId, stepNo } = {}) {
      return run(
        "DELETE FROM step_deliveries WHERE enrollment_id = ? AND step_no = ? AND status = 'sending'",
        String(enrollmentId), Number(stepNo),
      ).changes === 1;
    },

    // เลย์ลีสหมดอายุค้าง (โปรเซสตายกลางทาง) — แถว sending ที่ค้าง = ผลไม่ชัด ห้ามส่งซ้ำ → หยุดคนนั้น
    recoverStaleStepDeliveries({ at = now(), olderThanMs = 10 * 60_000 } = {}) {
      const t = Number(at);
      return inTransaction(() => {
        const stale = all(
          "SELECT enrollment_id, step_no FROM step_deliveries WHERE status = 'sending' AND updated_at < ?",
          t - Number(olderThanMs),
        );
        for (const row of stale) {
          run(
            "UPDATE step_deliveries SET status = 'unknown', reason = 'process_interrupted', updated_at = ? WHERE enrollment_id = ? AND step_no = ?",
            t, row.enrollment_id, row.step_no,
          );
          run(
            `UPDATE step_enrollments SET status = 'stopped', stop_reason = 'delivery_unknown', stopped_at = ?, updated_at = ?
             WHERE id = ? AND status = 'active'`,
            t, t, row.enrollment_id,
          );
        }
        return stale.length;
      });
    },

    /* ------------------------------- triggers ------------------------------- */

    // ป้ายทริกเกอร์ (ตรงตัว หรือทั้งมิติ "มิติ:") ที่ติดหลังเวลาเริ่มนับ และยังไม่มีแถวในลำดับนี้
    stepTagTriggerCandidates({ sequenceId, channelId, tag, prefix = "", since, limit = 200 } = {}) {
      const match = prefix ? "substr(t.tag, 1, length(?)) = ?" : "t.tag = ?";
      const params = prefix ? [prefix, prefix] : [String(tag)];
      return all(
        `SELECT t.customer_id, MIN(t.created_at) AS at FROM customer_tags t
         JOIN customers c ON c.line_user_id = t.customer_id
         WHERE ${match} AND t.created_at >= ? AND c.channel_id = ? AND c.line_user_id NOT LIKE 'canary:%'
           AND NOT EXISTS (SELECT 1 FROM customer_tags lt WHERE lt.customer_id = t.customer_id AND lt.tag = 'ย้ายจาก LINE OA')
           AND NOT EXISTS (SELECT 1 FROM step_enrollments e WHERE e.sequence_id = ? AND e.customer_id = t.customer_id)
         GROUP BY t.customer_id ORDER BY at LIMIT ?`,
        ...params, Number(since), String(channelId), String(sequenceId), Math.min(500, Math.max(1, Number(limit) || 200)),
      );
    },

    stepTagHolders({ channelId, tag, prefix = "" } = {}) {
      const match = prefix ? "substr(t.tag, 1, length(?)) = ?" : "t.tag = ?";
      const params = prefix ? [prefix, prefix] : [String(tag)];
      return all(
        `SELECT DISTINCT t.customer_id FROM customer_tags t JOIN customers c ON c.line_user_id = t.customer_id
         WHERE ${match} AND c.channel_id = ?`,
        ...params, String(channelId),
      ).map((row) => row.customer_id);
    },

    stepPaidOrderCandidates({ sequenceId, channelId, since, limit = 200 } = {}) {
      return all(
        `SELECT o.customer_id, MIN(o.updated_at) AS at FROM orders o
         JOIN customers c ON c.line_user_id = o.customer_id
         WHERE o.status IN ('paid','shipped','done') AND o.updated_at >= ? AND c.channel_id = ?
           AND c.line_user_id NOT LIKE 'canary:%'
           AND NOT EXISTS (SELECT 1 FROM step_enrollments e WHERE e.sequence_id = ? AND e.customer_id = o.customer_id)
         GROUP BY o.customer_id ORDER BY at LIMIT ?`,
        Number(since), String(channelId), String(sequenceId), Math.min(500, Math.max(1, Number(limit) || 200)),
      );
    },

    stepPaidOrderHolders({ channelId } = {}) {
      return all(
        `SELECT DISTINCT o.customer_id FROM orders o JOIN customers c ON c.line_user_id = o.customer_id
         WHERE o.status IN ('paid','shipped','done') AND c.channel_id = ? AND c.line_user_id NOT LIKE 'canary:%'`,
        String(channelId),
      ).map((row) => row.customer_id);
    },

    customerHasPaidOrder(customerId) {
      return Boolean(get(
        "SELECT 1 AS ok FROM orders WHERE customer_id = ? AND status IN ('paid','shipped','done') LIMIT 1",
        String(customerId),
      ));
    },

    customerSlipSince(customerId, since) {
      return Boolean(get(
        "SELECT 1 AS ok FROM slip_checks WHERE customer_id = ? AND created_at >= ? LIMIT 1",
        String(customerId), Number(since),
      ));
    },

    inboundSince(customerId, since) {
      return Boolean(get(
        "SELECT 1 AS ok FROM messages WHERE customer_id = ? AND direction = 'in' AND created_at > ? LIMIT 1",
        String(customerId), Number(since),
      ));
    },

    // ข้อความสนทนาล่าสุด (ไม่นับข้อความเชิงรุก) ทั้งสองทิศ — ใช้กันการแทรกกลางบทสนทนาสด
    lastConversationAt(customerId) {
      return Number(get(
        "SELECT MAX(created_at) AS t FROM messages WHERE customer_id = ? AND message_class = 'reactive'",
        String(customerId),
      )?.t) || 0;
    },

    proactiveSentSince(customerId, since) {
      return Boolean(get(
        "SELECT 1 AS ok FROM messages WHERE customer_id = ? AND direction = 'out' AND message_class = 'proactive' AND created_at >= ? LIMIT 1",
        String(customerId), Number(since),
      ));
    },

    // ข้อความตามขั้นใช้ "ทักอัตโนมัติวันละครั้ง" ก้อนเดียวกับทักตาม (followup_state.sent_today) —
    // ส่งขั้นแล้ว = วันนี้ทักตามไม่ออกอีก (daily_cap) และกลับกัน
    markProactiveUsedToday(customerId, todayKey) {
      run(
        `INSERT INTO followup_state (customer_id, sent_today, today_key, episodes_today) VALUES (?, 1, ?, 0)
         ON CONFLICT(customer_id) DO UPDATE SET
           sent_today = CASE WHEN followup_state.today_key = excluded.today_key THEN followup_state.sent_today + 1 ELSE 1 END,
           episodes_today = CASE WHEN followup_state.today_key = excluded.today_key THEN followup_state.episodes_today ELSE 0 END,
           today_key = excluded.today_key`,
        String(customerId), String(todayKey),
      );
    },

    /* ------------------------------- stats ------------------------------- */

    stepSequenceStats(sequence) {
      const id = String(sequence.id);
      const deliveries = all(
        "SELECT step_no, status, COUNT(*) AS n FROM step_deliveries WHERE sequence_id = ? GROUP BY step_no, status",
        id,
      );
      const waiting = all(
        "SELECT next_step, COUNT(*) AS n FROM step_enrollments WHERE sequence_id = ? AND status = 'active' GROUP BY next_step",
        id,
      );
      // คนที่หยุดหลังมีแถวส่งของขั้นนั้นแล้ว (ผลส่งไม่ชัด/LINE ปฏิเสธ) ถูกนับใน deliveries อยู่แล้ว — ห้ามนับ "เข้าขั้น" ซ้ำ
      const stopped = all(
        `SELECT e.next_step, e.stop_reason, COUNT(*) AS n,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM step_deliveries d WHERE d.enrollment_id = e.id AND d.step_no = e.next_step)
                    THEN 1 ELSE 0 END) AS with_delivery
         FROM step_enrollments e WHERE e.sequence_id = ? AND e.status = 'stopped' GROUP BY e.next_step, e.stop_reason`,
        id,
      );
      const replied = all(
        `SELECT d.step_no, COUNT(DISTINCT d.customer_id) AS n FROM step_deliveries d
         WHERE d.sequence_id = ? AND d.status = 'sent' AND EXISTS (
           SELECT 1 FROM messages m WHERE m.customer_id = d.customer_id AND m.direction = 'in'
             AND m.created_at > d.updated_at AND m.created_at <= d.updated_at + 259200000)
         GROUP BY d.step_no`,
        id,
      );
      const clicks = all(
        `SELECT step_no, COALESCE(SUM(clicks), 0) AS n FROM broadcast_links
         WHERE owner_kind = 'step' AND substr(owner_id, 1, length(?)) = ? GROUP BY step_no`,
        `${id}:`, `${id}:`,
      );
      const totals = get(
        `SELECT
           SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped,
           SUM(CASE WHEN status = 'baseline' THEN 1 ELSE 0 END) AS baseline
         FROM step_enrollments WHERE sequence_id = ?`,
        id,
      ) || {};
      const steps = sequence.steps.map((_, index) => {
        const byStatus = Object.fromEntries(deliveries.filter((r) => r.step_no === index).map((r) => [r.status, Number(r.n)]));
        const waitingHere = Number(waiting.find((r) => r.next_step === index)?.n) || 0;
        const stoppedHere = stopped.filter((r) => r.next_step === index);
        const stoppedTotal = stoppedHere.reduce((s, r) => s + Number(r.n), 0);
        const stoppedAfterAttempt = stoppedHere.reduce((s, r) => s + (Number(r.with_delivery) || 0), 0);
        const attempted = Object.values(byStatus).reduce((s, n) => s + n, 0);
        return {
          step: index + 1,
          entered: attempted + waitingHere + stoppedTotal - stoppedAfterAttempt,
          waiting: waitingHere,
          sent: byStatus.sent || 0,
          skipped: byStatus.skipped || 0,
          failed: (byStatus.failed || 0) + (byStatus.unknown || 0),
          stopped: stoppedTotal,
          stoppedBy: Object.fromEntries(stoppedHere.map((r) => [r.stop_reason || "unknown", Number(r.n)])),
          replied: Number(replied.find((r) => r.step_no === index)?.n) || 0,
          clicked: Number(clicks.find((r) => r.step_no === index)?.n) || 0,
        };
      });
      return {
        active: Number(totals.active) || 0, completed: Number(totals.completed) || 0,
        stopped: Number(totals.stopped) || 0, baseline: Number(totals.baseline) || 0,
        steps,
      };
    },

    // ประมาณคนเข้าลำดับต่อเดือน (ใช้ประมาณโควตาในหน้ายืนยันเปิดใช้) — ข้อมูล 30 วันล่าสุดเท่านั้น
    stepMonthlyEnrollmentEstimate({ triggerType, triggerValue = "", prefix = "", channelId, since } = {}) {
      if (triggerType === "follow") {
        return Number(get(
          "SELECT COUNT(*) AS n FROM line_follow_state WHERE channel_id = ? AND first_followed_at >= ?",
          String(channelId), Number(since),
        )?.n) || 0;
      }
      if (triggerType === "tag") {
        const match = prefix ? "substr(t.tag, 1, length(?)) = ?" : "t.tag = ?";
        const params = prefix ? [prefix, prefix] : [String(triggerValue)];
        return Number(get(
          `SELECT COUNT(DISTINCT t.customer_id) AS n FROM customer_tags t JOIN customers c ON c.line_user_id = t.customer_id
           WHERE ${match} AND c.channel_id = ? AND t.created_at >= ?`,
          ...params, String(channelId), Number(since),
        )?.n) || 0;
      }
      if (triggerType === "order_paid") {
        return Number(get(
          `SELECT COUNT(DISTINCT o.customer_id) AS n FROM orders o JOIN customers c ON c.line_user_id = o.customer_id
           WHERE c.channel_id = ? AND o.status IN ('paid','shipped','done') AND o.updated_at >= ?`,
          String(channelId), Number(since),
        )?.n) || 0;
      }
      // keyword: นับคนที่พิมพ์ #คำนั้นใน 30 วัน (สแกนครั้งเดียวตอนดูหน้ายืนยัน)
      return Number(get(
        `SELECT COUNT(DISTINCT m.customer_id) AS n FROM messages m
         WHERE m.channel_id = ? AND m.direction = 'in' AND m.created_at >= ? AND instr(lower(m.content), lower(?)) > 0`,
        String(channelId), Number(since), `#${triggerValue}`,
      )?.n) || 0;
    },

    deleteStepDataForCustomer(customerId) {
      const id = String(customerId || "");
      run("DELETE FROM step_deliveries WHERE customer_id = ?", id);
      run("DELETE FROM step_enrollments WHERE customer_id = ?", id);
    },
  };
}
