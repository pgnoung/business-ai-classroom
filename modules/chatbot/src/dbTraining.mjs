// dbTraining.mjs — session rotation + owner-reviewed training candidates.
// Snapshots are local-only and remain inert until an owner explicitly reviews
// them. This module never feeds a candidate to persona, knowledge, or prompts.
import { randomUUID } from "node:crypto";

export const TRAINING_SNAPSHOT_MAX_MESSAGES = 500;
export const TRAINING_SNAPSHOT_MAX_CHARS = 200_000;

function textSnapshot(rows) {
  let used = 0;
  return rows.map((row) => ({
    direction: row.direction,
    content: String(row.content || "").slice(0, Math.max(0, TRAINING_SNAPSHOT_MAX_CHARS - used)),
    created_at: row.created_at,
    agent_mode: row.agent_mode || null,
    operator: row.operator || "",
    message_class: row.message_class || "reactive",
  })).filter((row) => {
    if (!row.content || used >= TRAINING_SNAPSHOT_MAX_CHARS) return false;
    used += row.content.length;
    return true;
  });
}

export function createTrainingDbMethods({ db, run, all, get, now }) {
  function customer(customerId) {
    return get("SELECT * FROM customers WHERE line_user_id = ?", String(customerId)) ?? null;
  }

  function ensureCustomer(customerId, channelId) {
    const existing = customer(customerId);
    if (existing) return existing;
    const t = now();
    run(
      `INSERT INTO customers (line_user_id, channel_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      String(customerId), String(channelId || "default"), t, t,
    );
    return customer(customerId);
  }

  function activeSession(customerId, channelId = "default") {
    const id = String(customerId);
    const existing = get(
      "SELECT * FROM conversation_sessions WHERE customer_id = ? AND status = 'active' LIMIT 1",
      id,
    );
    if (existing) return existing;
    const current = customer(id);
    if (!current) return null;
    const session = {
      id: randomUUID(), customer_id: id,
      channel_id: String(current.channel_id || channelId || "default"), created_at: now(),
    };
    run(
      `INSERT INTO conversation_sessions (id, customer_id, channel_id, status, created_at)
       VALUES (?, ?, ?, 'active', ?)`,
      session.id, session.customer_id, session.channel_id, session.created_at,
    );
    // Legacy rows predate session ownership. Put them in the one initial
    // session exactly once so a later reset can isolate the new conversation.
    run("UPDATE messages SET session_id = ? WHERE customer_id = ? AND session_id IS NULL", session.id, id);
    return get("SELECT * FROM conversation_sessions WHERE id = ?", session.id);
  }

  return {
    ensureActiveConversationSession(customerId, channelId = "default") {
      return activeSession(customerId, channelId);
    },

    activeConversationSession(customerId) {
      return activeSession(customerId);
    },

    rotateTrainingSession({ customerId, channelId = "default", resetEventId, feedback = "" }) {
      const id = String(customerId);
      const eventId = String(resetEventId || "");
      if (!eventId) throw new Error("training reset requires a dedupe event id");

      db.exec("BEGIN IMMEDIATE");
      try {
        // The event marker and the prompt boundary are one transaction.  A
        // previous pre-transaction marker may exist from an interrupted older
        // build; without a candidate it is an orphan, not proof of completion.
        const prior = get("SELECT * FROM training_candidates WHERE reset_event_id = ?", eventId);
        if (prior) {
          db.exec("COMMIT");
          return { candidate: prior, idempotent: true, session: activeSession(id, channelId) };
        }
        run(
          "INSERT OR IGNORE INTO events_dedupe (message_id, seen_at) VALUES (?, ?)",
          eventId, now(),
        );
        ensureCustomer(id, channelId);
        const current = activeSession(id, channelId);
        const rows = all(
          `SELECT direction, content, created_at, agent_mode, operator, message_class FROM messages
           WHERE customer_id = ? AND session_id = ? AND msg_type = 'text'
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          id, current.id, TRAINING_SNAPSHOT_MAX_MESSAGES,
        );
        const transcript = textSnapshot(rows.reverse());
        const t = now();
        // v1.2.6: ความเห็นที่ผู้ทดสอบพิมพ์ต่อท้าย /reset ผูกกับ session ที่กำลังปิด
        // ไม่ใช่ session ใหม่ — ไม่งั้นอ่านคู่กับบทสนทนาที่ให้ความเห็นนั้นไม่ได้
        const trimmedFeedback = String(feedback || "").trim();
        if (trimmedFeedback) {
          run(
            `INSERT INTO training_feedback (id, customer_id, session_id, reviewer, content, created_at)
             VALUES (?, ?, ?, 'tester', ?, ?)`,
            randomUUID(), id, current.id, trimmedFeedback, t,
          );
        }
        const candidateId = randomUUID();
        run(
          `INSERT INTO training_candidates
             (id, customer_id, session_id, reset_event_id, status, transcript_json, message_count, created_at)
           VALUES (?, ?, ?, ?, 'pending_owner_confirmation', ?, ?, ?)`,
          candidateId, id, current.id, eventId, JSON.stringify(transcript), transcript.length, t,
        );
        run("UPDATE conversation_sessions SET status = 'rotated', closed_at = ? WHERE id = ?", t, current.id);
        const nextSessionId = randomUUID();
        run(
          `INSERT INTO conversation_sessions (id, customer_id, channel_id, status, created_at)
           VALUES (?, ?, ?, 'active', ?)`,
          nextSessionId, id, String(channelId || current.channel_id || "default"), t,
        );

        // A training reset is a prompt boundary, not an operational takeover.
        // Preserve AI/human ownership, handoff, follow-ups, consent, orders and
        // every business control exactly as they were.
        run("DELETE FROM score_history WHERE customer_id = ?", id);
        // 2026-09-04 (ตรวจปรปักษ์): /reset หมุน session ให้เป็นบทสนทนาใหม่ แต่หมุดจังหวะราคา
        // ทั้งชุดยังค้างอยู่ — ห้องที่ "เพิ่งเริ่มใหม่" จึงถูกอ่านว่าเคยคัดกรอง/เคยได้ราคา/
        // เรารู้จักเขาแล้ว แล้วเทราคาใส่ข้อความแรกของรอบเทรนทุกครั้ง ทีมงานที่ใช้ /reset
        // เพื่อทดสอบเส้นทางคนแปลกหน้าจึงไม่มีทางเห็นเทิร์นคัดกรองเลยสักครั้ง
        // ล้างชุดเดียวกับที่ resetCustomer ล้าง (ยกเว้น known_name ซึ่งเป็นของลูกค้าคนเดิม
        // — /reset คือขอบเขตของพรอมต์ ไม่ใช่การลืมตัวตนลูกค้า)
        run(
          `UPDATE customers SET last_score = NULL, last_score_at = NULL,
             price_deferred_at = 0, price_quoted_at = 0, known_context_at = 0,
             price_pivot_deferred_at = 0, money_seen_at = 0, service_boundary_json = '{}',
             last_seen_by_operator_at = 0, updated_at = ? WHERE line_user_id = ?`,
          t, id,
        );
        db.exec("COMMIT");
        return {
          feedbackSaved: Boolean(trimmedFeedback),
          idempotent: false,
          candidate: get("SELECT * FROM training_candidates WHERE id = ?", candidateId),
          session: get("SELECT * FROM conversation_sessions WHERE id = ?", nextSessionId),
        };
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw err;
      }
    },

    // v1.2.6 (คำสั่งพี่ง้วง 2026-08-13): ผู้ทดสอบส่ง /fb ระหว่างรอบได้ — ความเห็นผูกกับ
    // session ที่กำลังคุยอยู่ เพื่ออ่านคู่กับบทสนทนาจริงตอนรีวิว
    addTrainingFeedback({ customerId, content, reviewer = "tester", channelId = "default" }) {
      const id = String(customerId);
      const text = String(content || "").trim();
      if (!text) return null;
      ensureCustomer(id, channelId);
      const session = activeSession(id, channelId);
      if (!session) return null;
      const row = {
        id: randomUUID(), customer_id: id, session_id: session.id,
        reviewer: String(reviewer || "tester"), content: text, created_at: now(),
      };
      run(
        `INSERT INTO training_feedback (id, customer_id, session_id, reviewer, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        row.id, row.customer_id, row.session_id, row.reviewer, row.content, row.created_at,
      );
      return row;
    },

    trainingFeedbackForSession(sessionId) {
      return all(
        "SELECT * FROM training_feedback WHERE session_id = ? ORDER BY created_at ASC",
        String(sessionId),
      );
    },

    listTrainingCandidates({ status = null, limit = 100 } = {}) {
      const capped = Math.min(200, Math.max(1, Number(limit) || 100));
      if (status == null) return all("SELECT * FROM training_candidates ORDER BY created_at DESC LIMIT ?", capped);
      return all("SELECT * FROM training_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?", String(status), capped);
    },

    getTrainingCandidate(candidateId) {
      return get("SELECT * FROM training_candidates WHERE id = ?", String(candidateId)) ?? null;
    },

    decideTrainingCandidate(candidateId, { approved, decidedBy = "" } = {}) {
      const status = approved === true ? "approved" : "rejected";
      const result = run(
        `UPDATE training_candidates SET status = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending_owner_confirmation'`,
        status, now(), String(decidedBy).slice(0, 120), String(candidateId),
      );
      return result.changes === 1 ? this.getTrainingCandidate(candidateId) : null;
    },

    setTrainingCandidateAck(candidateId, { status, detail = "" } = {}) {
      if (!new Set(["pending", "sent", "failed", "ambiguous"]).has(status)) throw new Error("invalid training ack status");
      run(
        `UPDATE training_candidates SET ack_status = ?, ack_detail = ?
         WHERE id = ? AND ack_resolved_at IS NULL`,
        status, String(detail).slice(0, 120), String(candidateId),
      );
      return this.getTrainingCandidate(candidateId);
    },

    resolveTrainingCandidateAck(candidateId, { resolvedBy = "" } = {}) {
      const result = run(
        `UPDATE training_candidates
         SET ack_resolved_at = ?, ack_resolved_by = ?, ack_resolution = 'owner_no_send'
         WHERE id = ? AND ack_resolved_at IS NULL
           AND ack_status IN ('pending','failed','ambiguous')`,
        now(), String(resolvedBy).slice(0, 120), String(candidateId),
      );
      return result.changes === 1 ? this.getTrainingCandidate(candidateId) : null;
    },

    pruneTrainingCandidates({ before }) {
      const rows = all("SELECT id, session_id FROM training_candidates WHERE created_at < ?", Number(before));
      if (!rows.length) return 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          run("DELETE FROM training_feedback WHERE session_id = ?", row.session_id);
          run("DELETE FROM training_candidates WHERE id = ?", row.id);
        }
        db.exec("COMMIT");
        return rows.length;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },
  };
}
