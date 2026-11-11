// dbLearning.mjs — persistence boundary for daily-learning proposals.
// The scheduler may create only proposed candidates. A knowledge row can be
// written only by applyLearningCandidate(), which is called from an authenticated
// human decision route and commits the candidate + knowledge change atomically.
import { randomUUID } from "node:crypto";
import { KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_TITLE_MAX } from "./dbExtra.mjs";

const clampLimit = (value, fallback = 100) => Math.min(500, Math.max(1, Math.trunc(Number(value)) || fallback));

function ensureColumn(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function createLearningDbMethods({ db, run, all, get, now }) {
  // Keep the learning migration owned by this persistence boundary. This runs
  // after the base schema and is additive/idempotent for an already-live DB.
  ensureColumn(db, "learning_runs", "mode", "mode TEXT NOT NULL DEFAULT 'deterministic_fallback'");
  ensureColumn(db, "learning_runs", "hedge_rate", "hedge_rate REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "learning_runs", "promise_notes_per_100", "promise_notes_per_100 REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "learning_runs", "operator_override_per_100", "operator_override_per_100 REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "learning_runs", "knowledge_chars", "knowledge_chars INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "learning_runs", "cache_hit_rate", "cache_hit_rate REAL NOT NULL DEFAULT 0");
  ensureColumn(db, "learning_runs", "probe_count", "probe_count INTEGER NOT NULL DEFAULT 0");

  return {
    learningStageAData({ startMs = 0, endMs = now(), excludedChannelIds = [] } = {}) {
      const excluded = [...new Set((Array.isArray(excludedChannelIds) ? excludedChannelIds : [])
        .map(String).filter(Boolean))];
      const channelSql = excluded.length ? ` AND customer.channel_id NOT IN (${excluded.map(() => "?").join(",")})` : "";
      const params = [Math.max(0, Number(startMs) || 0), Math.max(0, Number(endMs) || 0), ...excluded];
      const messages = all(
        `SELECT message.id,message.customer_id,message.direction,message.content,
                message.agent_mode,message.created_at,customer.channel_id
           FROM messages message
           JOIN customers customer ON customer.line_user_id=message.customer_id
          WHERE message.created_at>=? AND message.created_at<?
            AND message.msg_type='text' AND TRIM(message.content)!=''
            AND message.customer_id NOT LIKE 'canary:%'${channelSql}
          ORDER BY message.created_at,message.rowid`,
        ...params,
      );
      const corrections = all(
        `SELECT correction.id,correction.customer_id,correction.human_final,
                correction.reason,correction.inbound_message_id,
                COALESCE(correction.decided_at,correction.created_at) AS decided_at,
                customer.channel_id
           FROM corrections correction
           JOIN customers customer ON customer.line_user_id=correction.customer_id
          WHERE correction.status='approved' AND TRIM(correction.human_final)!=''
            AND COALESCE(correction.decided_at,correction.created_at)>=?
            AND COALESCE(correction.decided_at,correction.created_at)<?
            AND correction.customer_id NOT LIKE 'canary:%'
            AND correction.reason!='dashboard_key'
            AND NOT EXISTS (
              SELECT 1 FROM admin_audit audit
               WHERE audit.operator='dashboard-key' AND audit.action='correction_add'
                 AND audit.detail='id=' || correction.id
            )${channelSql}
          ORDER BY COALESCE(correction.decided_at,correction.created_at),correction.rowid`,
        ...params,
      );
      const promiseNotes = all(
        `SELECT note.id,note.customer_id,note.created_at,customer.channel_id
           FROM handoff_notes note
           JOIN customers customer ON customer.line_user_id=note.customer_id
          WHERE note.author='ai_promise' AND note.created_at>=? AND note.created_at<?
            AND note.customer_id NOT LIKE 'canary:%'${channelSql}
          ORDER BY note.created_at,note.rowid`,
        ...params,
      );
      const scoreRows = all(
        `SELECT score.id,score.customer_id,score.score,score.created_at,customer.channel_id
           FROM score_history score
           JOIN customers customer ON customer.line_user_id=score.customer_id
          WHERE score.created_at>=? AND score.created_at<?
            AND score.customer_id NOT LIKE 'canary:%'${channelSql}
          ORDER BY score.customer_id,score.created_at,score.rowid`,
        ...params,
      );
      const excludedDashboardKey = Number(get(
        `SELECT COUNT(*) AS n
           FROM corrections correction
          WHERE correction.status='approved'
            AND COALESCE(correction.decided_at,correction.created_at)>=?
            AND COALESCE(correction.decided_at,correction.created_at)<?
            AND (correction.reason='dashboard_key' OR EXISTS (
              SELECT 1 FROM admin_audit audit
               WHERE audit.operator='dashboard-key' AND audit.action='correction_add'
                 AND audit.detail='id=' || correction.id
            ))`,
        Math.max(0, Number(startMs) || 0), Math.max(0, Number(endMs) || 0),
      )?.n || 0);
      return { messages, corrections, promiseNotes, scoreRows, excludedDashboardKey };
    },

    learningKnowledgeStats() {
      return get(
        `SELECT COALESCE(SUM(LENGTH(title)+LENGTH(content)),0) AS knowledge_chars
           FROM knowledge_entries WHERE active=1 AND deleted_at IS NULL`,
      ) || { knowledge_chars: 0 };
    },

    learningUsageStats({ startMs = 0, endMs = now() } = {}) {
      return get(
        `SELECT COALESCE(SUM(tokens_in),0) AS tokens_in,
                COALESCE(SUM(cached_in),0) AS cached_in
           FROM llm_usage WHERE created_at>=? AND created_at<?`,
        Math.max(0, Number(startMs) || 0), Math.max(0, Number(endMs) || 0),
      ) || { tokens_in: 0, cached_in: 0 };
    },

    listApprovedCorrectionsForLearning({ sinceMs = 0, limit = 200 } = {}) {
      return all(
        `SELECT c.id, c.ai_draft, c.human_final, c.reason,
                COALESCE(c.decided_at, c.created_at) AS decided_at,
                customer.channel_id
         FROM corrections c
         LEFT JOIN customers customer ON customer.line_user_id = c.customer_id
         WHERE c.status = 'approved'
           AND TRIM(c.human_final) != ''
           AND COALESCE(c.decided_at, c.created_at) >= ?
           AND NOT EXISTS (
             SELECT 1 FROM learning_candidates candidate
             WHERE candidate.cluster_key = 'correction:' || c.id
           )
         ORDER BY COALESCE(c.decided_at, c.created_at) ASC, c.rowid ASC
         LIMIT ?`,
        Math.max(0, Number(sinceMs) || 0), clampLimit(limit, 200),
      );
    },

    knowledgeRowsForDigest() {
      return all(
        `SELECT id,title,content,channel_id,source,version,updated_at,provenance_json
         FROM knowledge_entries
         WHERE active = 1 AND deleted_at IS NULL
         ORDER BY COALESCE(channel_id,''), created_at, rowid`,
      );
    },

    findActiveKnowledgeMatches({ title, content, channelId = null } = {}) {
      const scope = channelId == null ? "channel_id IS NULL" : "channel_id = ?";
      const params = channelId == null ? [] : [String(channelId)];
      return all(
        `SELECT * FROM knowledge_entries
         WHERE active = 1 AND deleted_at IS NULL AND ${scope}
           AND (title = ? OR content = ?)
         ORDER BY updated_at DESC, rowid DESC`,
        ...params, String(title), String(content),
      );
    },

    createLearningRun({ dayKey, knowledgeDigest = "", mode = "deterministic_fallback" } = {}) {
      const id = randomUUID();
      run(
        `INSERT INTO learning_runs
          (id,day_key,status,knowledge_digest,mode,created_at)
         VALUES (?,?,'running',?,?,?)`,
        id, String(dayKey), String(knowledgeDigest), String(mode), now(),
      );
      return this.getLearningRun(id);
    },

    finishLearningRun(id, {
      status = "complete", signalsFound = 0, clusters = 0,
      llmCalls = 0, tokensIn = 0, tokensOut = 0, usd = 0,
      candidatesCreated = 0, detail = "", mode = "deterministic_fallback",
      hedgeRate = 0, promiseNotesPer100 = 0, operatorOverridePer100 = 0,
      knowledgeChars = 0, cacheHitRate = 0, probeCount = 0,
    } = {}) {
      const allowed = new Set(["complete", "skipped_no_activity", "failed"]);
      if (!allowed.has(status)) throw new Error("invalid learning run status");
      run(
        `UPDATE learning_runs SET status=?, signals_found=?, clusters=?, llm_calls=?,
           tokens_in=?, tokens_out=?, usd=?, candidates_created=?, detail=?,mode=?,
           hedge_rate=?,promise_notes_per_100=?,operator_override_per_100=?,
           knowledge_chars=?,cache_hit_rate=?,probe_count=?,completed_at=?
         WHERE id=? AND status='running'`,
        status, Math.max(0, Number(signalsFound) || 0), Math.max(0, Number(clusters) || 0),
        Math.max(0, Number(llmCalls) || 0), Math.max(0, Number(tokensIn) || 0),
        Math.max(0, Number(tokensOut) || 0), Math.max(0, Number(usd) || 0),
        Math.max(0, Number(candidatesCreated) || 0), String(detail).slice(0, 500), String(mode).slice(0, 80),
        Math.max(0, Number(hedgeRate) || 0), Math.max(0, Number(promiseNotesPer100) || 0),
        Math.max(0, Number(operatorOverridePer100) || 0), Math.max(0, Number(knowledgeChars) || 0),
        Math.max(0, Number(cacheHitRate) || 0), Math.max(0, Number(probeCount) || 0),
        now(), String(id),
      );
      return this.getLearningRun(id);
    },

    getLearningRun(id) {
      return get("SELECT * FROM learning_runs WHERE id=?", String(id)) ?? null;
    },

    getCompletedLearningRunForDay(dayKey, mode = "") {
      return get(
        `SELECT * FROM learning_runs
          WHERE day_key=? AND status='complete'
            AND (mode=? OR (?='model_assisted' AND llm_calls>0))
          ORDER BY completed_at DESC,rowid DESC LIMIT 1`,
        String(dayKey), String(mode), String(mode),
      ) ?? null;
    },

    listLearningRuns(limit = 30) {
      return all(
        "SELECT * FROM learning_runs ORDER BY created_at DESC, rowid DESC LIMIT ?",
        clampLimit(limit, 30),
      );
    },

    createLearningCandidate({
      runId, dayKey, clusterKey, channelId = null, kind = "correction",
      title = "", proposedContent = "", evidence = [], conflicts = [],
      riskFlags = [], knowledgeDigest = "",
    } = {}) {
      const id = randomUUID();
      const t = now();
      const result = run(
        `INSERT OR IGNORE INTO learning_candidates
          (id,run_id,day_key,kind,cluster_key,channel_id,title,proposed_content,
           evidence_json,conflict_json,risk_flags_json,knowledge_digest,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, String(runId), String(dayKey), kind === "cluster" ? "cluster" : "correction",
        String(clusterKey), channelId == null ? null : String(channelId),
        String(title).slice(0, KNOWLEDGE_TITLE_MAX), String(proposedContent).slice(0, KNOWLEDGE_CONTENT_MAX),
        JSON.stringify(Array.isArray(evidence) ? evidence : []),
        JSON.stringify(Array.isArray(conflicts) ? conflicts : []),
        JSON.stringify(Array.isArray(riskFlags) ? riskFlags : []),
        String(knowledgeDigest), t, t,
      );
      if (result.changes !== 1) return null;
      return this.getLearningCandidate(id);
    },

    getLearningCandidate(id) {
      return get("SELECT * FROM learning_candidates WHERE id=?", String(id)) ?? null;
    },

    // Training intake has no client-controlled batch id.  Its dedupe key is a
    // server-computed content hash, so a reordered re-import resolves to the
    // same proposal instead of making a second unpublished candidate.
    getLearningCandidateByCluster(clusterKey) {
      return get("SELECT * FROM learning_candidates WHERE cluster_key=?", String(clusterKey)) ?? null;
    },

    listLearningCandidates({ status = null, limit = 100 } = {}) {
      return status
        ? all(
            "SELECT * FROM learning_candidates WHERE status=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
            String(status), clampLimit(limit),
          )
        : all(
            "SELECT * FROM learning_candidates ORDER BY created_at DESC, rowid DESC LIMIT ?",
            clampLimit(limit),
          );
    },

    updateLearningCandidateProposal(id, {
      title, proposedContent, riskFlags = [], conflicts = [], knowledgeDigest = "",
    } = {}) {
      const row = this.getLearningCandidate(id);
      if (!row || row.status !== "proposed") return null;
      run(
        `UPDATE learning_candidates SET title=?, proposed_content=?, risk_flags_json=?,
           conflict_json=?, knowledge_digest=?, updated_at=?
         WHERE id=? AND status='proposed'`,
        String(title ?? row.title).slice(0, KNOWLEDGE_TITLE_MAX),
        String(proposedContent ?? row.proposed_content).slice(0, KNOWLEDGE_CONTENT_MAX),
        JSON.stringify(Array.isArray(riskFlags) ? riskFlags : []),
        JSON.stringify(Array.isArray(conflicts) ? conflicts : []),
        String(knowledgeDigest), now(), String(id),
      );
      return this.getLearningCandidate(id);
    },

    rejectLearningCandidate(id, { decidedBy = "" } = {}) {
      const t = now();
      const result = run(
        `UPDATE learning_candidates SET status='rejected',decided_by=?,decided_at=?,updated_at=?
         WHERE id=? AND status='proposed'`,
        String(decidedBy), t, t, String(id),
      );
      return result.changes === 1 ? this.getLearningCandidate(id) : null;
    },

    applyLearningCandidate(id, {
      decidedBy = "", provenance = {}, existingEntryId = "", supersedesId = "",
    } = {}) {
      const candidate = this.getLearningCandidate(id);
      if (!candidate || candidate.status !== "proposed") return null;
      const t = now();
      // เรียกเดี่ยว ๆ ต้องได้ BEGIN IMMEDIATE เหมือนเดิมทุกตัวอักษร (จับ write lock ตั้งแต่
      // บรรทัดแรก แล้วรอด้วย busy_timeout) — SAVEPOINT เปิดธุรกรรมแบบ deferred ซึ่งย้าย
      // จุดที่ชนกันไปกลางทาง แล้วสาขา supersede จะได้ SQLITE_BUSY_SNAPSHOT แทนที่จะรอ
      // เรียกจากใน write hook ของสมอง (ธุรกรรมเปิดอยู่แล้ว) ต้องเป็น SAVEPOINT เพราะ
      // BEGIN ซ้อนจะ throw แล้วลาก rollback ทั้งก้อน — จึงเลือกตามสถานะจริง ไม่เดา
      const nested = db.isTransaction === true;
      db.exec(nested ? "SAVEPOINT learning_apply" : "BEGIN IMMEDIATE");
      try {
        let entryId = String(existingEntryId || "");
        if (!entryId) {
          entryId = randomUUID();
          let version = 1;
          if (supersedesId) {
            const previous = get(
              `SELECT * FROM knowledge_entries
               WHERE id=? AND active=1 AND deleted_at IS NULL AND source='learning_digest'`,
              String(supersedesId),
            );
            if (!previous) throw new Error("learning supersede target is not active learned knowledge");
            version = Math.max(1, Number(previous.version) || 1) + 1;
            run(
              "UPDATE knowledge_entries SET active=0,superseded_by=?,updated_by=?,updated_at=? WHERE id=?",
              entryId, String(decidedBy), t, previous.id,
            );
          }
          run(
            `INSERT INTO knowledge_entries
              (id,title,content,active,updated_by,channel_id,source,provenance_json,
               supersedes_id,version,created_at,updated_at)
             VALUES (?,?,?,1,?,?,'learning_digest',?,?,?,?,?)`,
            entryId, candidate.title, candidate.proposed_content, String(decidedBy),
            candidate.channel_id, JSON.stringify(provenance || {}),
            supersedesId ? String(supersedesId) : null, version, t, t,
          );
        }
        const updated = run(
          `UPDATE learning_candidates SET status='approved',decided_by=?,decided_at=?,
             applied_entry_id=?,updated_at=?
           WHERE id=? AND status='proposed'`,
          String(decidedBy), t, entryId, t, String(id),
        );
        if (updated.changes !== 1) throw new Error("learning candidate changed during approval");
        db.exec(nested ? "RELEASE learning_apply" : "COMMIT");
        return { candidate: this.getLearningCandidate(id), entry: this.getKnowledge(entryId) };
      } catch (error) {
        try {
          db.exec(nested ? "ROLLBACK TO learning_apply; RELEASE learning_apply;" : "ROLLBACK");
        } catch { /* ถูกปิดไปแล้ว */ }
        throw error;
      }
    },

    rollbackLearnedKnowledgeSince(sinceMs, { updatedBy = "" } = {}) {
      const t = now();
      return run(
        `UPDATE knowledge_entries SET active=0,updated_by=?,updated_at=?
         WHERE source='learning_digest' AND active=1 AND deleted_at IS NULL AND created_at>=?`,
        String(updatedBy), t, Math.max(0, Number(sinceMs) || 0),
      ).changes;
    },
  };
}
