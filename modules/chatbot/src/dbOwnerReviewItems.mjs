// dbOwnerReviewItems.mjs — คิวตรวจแชทรายวัน 20:00 ของพี่ง้วง (ห้องตรวจ เฟส B · คำสั่งพี่ง้วง 12 ต.ค. 2026)
//
// พี่ง้วง: "ทุกวัน 20:00 ส่งประวัติแชทของลูกค้าทุกเคสของวันนั้นมาให้พี่ง้วงกับชมพู่ยืนยันว่าตอบดีไหม หรือต้องปรับอะไร
//          (เหมือนที่เราเคยเทส) แล้วลูกแพรเรียนจากตรงนี้ · สัปดาห์แรกตรวจทุกแชท ผ่าน 7 วันค่อยลดลงตามที่ลูกแพรเก่งขึ้น"
//
// หนึ่งแถว = หนึ่งห้องที่ลูกแพร (ข้อความขาออกที่ไม่มีชื่อคนส่ง) คุยด้วยในช่วงของรอบ daily (owner_review_batches kind 'daily')
//   · เก็บเฉพาะตัวชี้ (ห้อง/ข้อความสุดท้ายที่เห็น) + ผลตรวจของ AI (คะแนน รหัสปัญหา โน้ตสั้นที่ปิดข้อมูลส่วนตัวแล้ว) + ป้ายของคน
//   · ข้อความแชทอยู่ในตาราง messages ที่เดิม ไม่คัดลอกมา — หน้าเว็บอ่านสดจาก messages ตอนเปิดการ์ด
// PDPA: customer_id REFERENCES customers ON DELETE CASCADE + deleteOwnerReviewItemsForCustomer (resetCustomer ไม่ลบแถวลูกค้า)
// เก็บ 180 วัน (pruneOwnerReviewItems — รอบตรวจเรียกวันละครั้งผ่าน pruneOwnerReview)
// ตารางสร้างตอนเขียนครั้งแรก (แบบ dbOwnerReview.mjs) — ฐานที่ยังไม่เคยมีรอบ daily มีโครงตารางเท่าเดิมทุกไบต์
// ไม่มี import จาก db.mjs (กันวงกลม) — dbOwnerReview.mjs ประกอบเมธอดชุดนี้เข้า createOwnerReviewDbMethods

export const OWNER_REVIEW_AI_STATUSES = Object.freeze(["pending", "done", "failed", "skipped"]);
export const OWNER_REVIEW_INCLUDED = Object.freeze(["all", "flagged", "sample", "none"]);
export const OWNER_REVIEW_LABELS = Object.freeze(["good", "needs_fix"]);
// single = กดทีละห้อง · fix = กด "ต้องปรับ" แล้วสอนจากฟอง · bulk = "ดีที่เหลือทั้งหมด" (ไม่นับในตัวเลขความแม่นของ AI)
export const OWNER_REVIEW_LABEL_VIA = Object.freeze(["single", "fix", "bulk"]);
export const OWNER_REVIEW_LABEL_NOTE_MAX = 500;
export const OWNER_REVIEW_SUMMARY_MAX = 120;
export const OWNER_REVIEW_ISSUES_MAX = 8;
export const OWNER_REVIEW_DAILY_ROOM_HARD_CAP = 400;

export const OWNER_REVIEW_ITEMS_SCHEMA = `
-- owner_review_items — คิวตรวจแชทรายวัน (ownerReviewDaily.mjs) · หนึ่งห้องต่อรอบ daily · ไม่มีข้อความแชทในตารางนี้
--   last_message_id = ข้อความล่าสุดของห้องในช่วงของรอบ (ตัวที่ผู้ตรวจเห็นเป็นตัวสุดท้าย)
--   ai_status   = pending (รอ AI อ่าน) | done | failed (Luna ล้ม/ตอบผิดรูป) | skipped (เงินหมด/รอบค้างนาน/ห้องหาย)
--   risk        = 0–100 จาก AI (NULL = AI ไม่ได้อ่าน) · issues_json = [{code, messageId, note}] รหัสในรายการปิดเท่านั้น
--   flagged/sampled/included = ผลของ ownerReviewTaper (ห้องน่าห่วง / สุ่มตรวจ / เข้าคิวหรือไม่)
--   label       = good | needs_fix | NULL (ยังไม่ตรวจ) · label_via = single | fix | bulk · revision กันกดซ้ำสองเครื่อง
--   issue_verdicts_json = {"<code>@<messageId>": "agree"|"disagree"} — คนเห็นด้วยกับปัญหาที่ AI ชี้ไหม (วัดความแม่นต่อรหัส)
--   lesson_ids_json = [{id, at, by, created}] บทเรียนที่สร้างจากการกด "ต้องปรับ" ของห้องนี้
CREATE TABLE IF NOT EXISTS owner_review_items (
  id                  TEXT PRIMARY KEY,
  batch_id            TEXT NOT NULL DEFAULT '',
  customer_id         TEXT NOT NULL REFERENCES customers(line_user_id) ON DELETE CASCADE,
  channel_id          TEXT NOT NULL DEFAULT 'default',
  day_key             TEXT NOT NULL DEFAULT '',
  window_start_ms     INTEGER NOT NULL DEFAULT 0,
  window_end_ms       INTEGER NOT NULL DEFAULT 0,
  last_message_id     TEXT NOT NULL DEFAULT '',
  ai_messages         INTEGER NOT NULL DEFAULT 0,
  ai_status           TEXT NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending','done','failed','skipped')),
  ai_summary          TEXT NOT NULL DEFAULT '',
  risk                INTEGER CHECK (risk IS NULL OR (risk BETWEEN 0 AND 100)),
  issues_json         TEXT NOT NULL DEFAULT '[]',
  offtopic_hint       TEXT NOT NULL DEFAULT '',
  flagged             INTEGER NOT NULL DEFAULT 0,
  sampled             INTEGER NOT NULL DEFAULT 0,
  included            TEXT NOT NULL DEFAULT 'all' CHECK (included IN ('all','flagged','sample','none')),
  label               TEXT CHECK (label IS NULL OR label IN ('good','needs_fix')),
  label_note          TEXT NOT NULL DEFAULT '',
  label_via           TEXT NOT NULL DEFAULT '' CHECK (label_via IN ('','single','fix','bulk')),
  label_bulk_id       TEXT NOT NULL DEFAULT '',
  issue_verdicts_json TEXT NOT NULL DEFAULT '{}',
  lesson_ids_json     TEXT NOT NULL DEFAULT '[]',
  labelled_by         TEXT NOT NULL DEFAULT '',
  labelled_at         INTEGER,
  revision            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (batch_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_owner_review_items_day ON owner_review_items(day_key, included, label);
CREATE INDEX IF NOT EXISTS idx_owner_review_items_batch ON owner_review_items(batch_id, ai_status);
CREATE INDEX IF NOT EXISTS idx_owner_review_items_customer ON owner_review_items(customer_id);
`;

// อยู่ในคิว = ไม่ใช่ none · รายการเดียวกันทุกคิวรี (หน้าเว็บ/ตัวเลข/แจ้งเตือน)
const QUEUED = "i.included <> 'none'";
// ยังต้องคนตรวจทีละห้อง (ห้ามรวมใน "ดีที่เหลือทั้งหมด"): AI ชี้ว่าน่าห่วง หรือถูกสุ่มมาวัดความแม่นของ AI
// หรือ AI ยังไม่ได้อ่าน (failed/skipped — ไม่มีใครคัดกรองให้ "ดีที่เหลือ" = ป้ายดีแล้วโดยไม่มีใครอ่านเลย)
// หรือ AI ชี้จุดไว้แม้แค่จุดเล็ก (รีวิว 13 ต.ค.: "ดีที่เหลือ" เคยติดป้ายดีให้ห้องที่ AI ว่าห้วน/ถามซ้ำโดยไม่มีใครเปิดดู)
const BULK_ELIGIBLE = "i.label IS NULL AND i.flagged = 0 AND i.sampled = 0 AND i.ai_status = 'done' AND i.issues_json = '[]'";

/**
 * ข้อความที่ลูกแพรเขียนเอง (ตรวจ/สอนได้) — ตัวเดียวกันทั้งตอนเลือกห้องเข้าคิว ตอนบอกหน้าเว็บว่าฟองไหนแตะแก้ได้ และด่านของ "ต้องปรับ"
 *   ขาออก · ไม่มีชื่อคนส่ง · agent_mode = ai (แถวเก่าก่อนติดป้าย = null) · ไม่ใช่ข้อความสำเร็จรูปของระบบ:
 *   step_message / blueprint (agent_mode อื่น) · คำลาหลังยืนยันปิด (metadata.ownerClose) · ข้อความเชื่อมบัญชี (metadata.identityLink)
 * (รีวิว 13 ต.ค.: ห้องที่มีแค่ข้อความอัตโนมัติเคยเข้าคิว กินเงิน Luna และสอนให้ลูกแพรเลิกพูดข้อความที่เจ้าของเขียนไว้เองได้)
 */
export const lukpraeWrittenSql = (alias) => `(${alias}.direction = 'out' AND ${alias}.operator = '' AND COALESCE(${alias}.agent_mode, 'ai') = 'ai'
  AND (CASE WHEN json_valid(${alias}.metadata_json)
    THEN json_type(${alias}.metadata_json, '$.ownerClose') IS NULL AND json_type(${alias}.metadata_json, '$.identityLink') IS NULL
    ELSE 1 END))`;
// ห้องที่เข้าคิว = ลูกแพรตอบลูกค้าจริง (reactive) อย่างน้อยหนึ่งครั้งในช่วง — ข้อความทักตาม/บรอดแคสต์อย่างเดียวไม่ใช่ "เคสของวันนี้"
const LUKPRAE_REPLY = `(${lukpraeWrittenSql("m")} AND m.message_class = 'reactive')`;

function scopeSql(channels) {
  if (!Array.isArray(channels)) return { sql: "1 = 1", values: [] };
  if (!channels.length) return { sql: "1 = 0", values: [] };
  return { sql: `(${channels.map(() => "COALESCE(c.channel_id, 'default') = ?").join(" OR ")})`, values: channels.map(String) };
}

const clipText = (value, max) => {
  const chars = Array.from(String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim());
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
};

function parseJson(text, fallback) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function createOwnerReviewItemDbMethods({ db, run, all, get, now, newId }) {
  let ready = false;
  const exists = () => ready || (ready = Boolean(get(`SELECT COUNT(*) = 1 AS ok FROM sqlite_master
    WHERE type = 'table' AND name = 'owner_review_items'`)?.ok));
  const ensure = () => {
    if (exists()) return;
    db.exec(OWNER_REVIEW_ITEMS_SCHEMA);
    ready = true;
  };
  const byId = (id) => (exists() ? get("SELECT * FROM owner_review_items WHERE id = ?", String(id)) ?? null : null);
  const withCustomer = `i.*, c.display_name AS customer_display_name, c.known_name AS customer_known_name,
    c.ai_enabled AS customer_ai_enabled, c.ai_off_reason AS customer_ai_off_reason, COALESCE(c.channel_id, i.channel_id) AS room_channel_id`;

  return {
    ensureOwnerReviewItemsTable() {
      ensure();
      return true;
    },

    /**
     * สร้างแถวของรอบ daily จากห้องที่ลูกแพรตอบในช่วง (window_start, window_end] — INSERT OR IGNORE (ทำซ้ำได้หลังรีสตาร์ต)
     * ห้องที่ลูกแพรตอบ = มีคำตอบ reactive ที่ลูกแพรเขียนเอง (lukpraeWrittenSql) อย่างน้อยหนึ่งครั้ง · ไม่นับห้อง canary
     *   ห้องที่มีแค่ข้อความอัตโนมัติ (step/blueprint/ทักตาม/คำลาหลังปิด) ไม่เข้าคิว
     * ai_messages = ข้อความที่ลูกแพรเขียนเองในช่วง (รวมทักตามที่เขียนเอง) · เรียงห้องที่ลูกแพรตอบล่าสุดก่อน · เกิน cap = ไม่เข้าคิว (นับ overflow)
     */
    insertOwnerReviewItemsForBatch(batch, { dayKey, cap = 300 } = {}) {
      ensure();
      const limit = Math.max(1, Math.min(OWNER_REVIEW_DAILY_ROOM_HARD_CAP, Math.trunc(Number(cap)) || 300));
      const start = Number(batch.window_start_ms) || 0;
      const end = Number(batch.window_end_ms) || 0;
      const rooms = all(`SELECT m.customer_id AS id, COALESCE(c.channel_id, 'default') AS channel_id,
            SUM(CASE WHEN ${lukpraeWrittenSql("m")} THEN 1 ELSE 0 END) AS ai_messages,
            MAX(CASE WHEN ${LUKPRAE_REPLY} THEN m.created_at END) AS last_out
          FROM messages m JOIN customers c ON c.line_user_id = m.customer_id
         WHERE m.direction = 'out' AND m.operator = '' AND m.created_at > ? AND m.created_at <= ?
           AND c.line_user_id NOT LIKE 'canary:%'
         GROUP BY m.customer_id
        HAVING SUM(CASE WHEN ${LUKPRAE_REPLY} THEN 1 ELSE 0 END) > 0
         ORDER BY last_out DESC, m.customer_id ASC`, start, end);
      let inserted = 0;
      const t = now();
      for (const room of rooms.slice(0, limit)) {
        const last = get(`SELECT id FROM messages WHERE customer_id = ? AND created_at > ? AND created_at <= ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`, String(room.id), start, end);
        inserted += Number(run(`INSERT OR IGNORE INTO owner_review_items
            (id, batch_id, customer_id, channel_id, day_key, window_start_ms, window_end_ms, last_message_id, ai_messages,
             ai_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        newId(), String(batch.id), String(room.id), String(room.channel_id || "default"), String(dayKey || ""), start, end,
        String(last?.id || ""), Number(room.ai_messages) || 0, t, t).changes);
      }
      return { rooms: Math.min(rooms.length, limit), inserted, overflow: Math.max(0, rooms.length - limit) };
    },

    ownerReviewItem(id) {
      return byId(id);
    },

    /** ข้อความนี้ลูกแพรเขียนเองไหม (lukpraeWrittenSql — ด่านเดียวกับตอนเลือกห้อง) — ด่านของ "ต้องปรับ" */
    isLukpraeWrittenMessage(messageId) {
      return Boolean(get(`SELECT 1 AS ok FROM messages m WHERE m.id = ? AND ${lukpraeWrittenSql("m")}`, String(messageId))?.ok);
    },

    /** แถวเดียวพร้อมชื่อห้อง — null เมื่อห้องอยู่นอกสาขาที่ผู้ดูเห็นได้ */
    ownerReviewItemScoped(id, channels = null) {
      if (!exists()) return null;
      const scope = scopeSql(channels);
      return get(`SELECT ${withCustomer} FROM owner_review_items i JOIN customers c ON c.line_user_id = i.customer_id
        WHERE i.id = ? AND ${scope.sql}`, String(id), ...scope.values) ?? null;
    },

    /** ห้องที่ยังรอ AI อ่าน (ลำดับเดิมทุกครั้ง — ทำต่อหลังรีสตาร์ตได้) */
    pendingOwnerReviewItems(batchId, limit = 20) {
      if (!exists()) return [];
      return all(`SELECT * FROM owner_review_items WHERE batch_id = ? AND ai_status = 'pending'
        ORDER BY created_at ASC, rowid ASC LIMIT ?`, String(batchId), Math.max(1, Math.min(200, Number(limit) || 20)));
    },

    /** เก็บผลอ่านของ AI — เขียนได้ครั้งเดียว (ต้องยัง pending) · คืนจำนวนแถวที่เปลี่ยน */
    saveOwnerReviewItemReview(id, { aiStatus, risk = null, summary = "", issues = [], offtopicHint = "" } = {}) {
      if (!OWNER_REVIEW_AI_STATUSES.includes(aiStatus) || aiStatus === "pending") throw new Error("owner review ai status is invalid");
      if (!exists()) return 0;
      const score = risk == null ? null : Math.max(0, Math.min(100, Math.round(Number(risk))));
      const list = (Array.isArray(issues) ? issues : []).slice(0, OWNER_REVIEW_ISSUES_MAX).map((issue) => ({
        code: String(issue?.code || "").slice(0, 40), messageId: String(issue?.messageId || "").slice(0, 120),
        note: clipText(issue?.note, 120),
      }));
      return Number(run(`UPDATE owner_review_items SET ai_status = ?, risk = ?, ai_summary = ?, issues_json = ?, offtopic_hint = ?,
          updated_at = ? WHERE id = ? AND ai_status = 'pending'`,
      aiStatus, Number.isFinite(score) ? score : null, clipText(summary, OWNER_REVIEW_SUMMARY_MAX), JSON.stringify(list),
      String(offtopicHint || "").slice(0, 40), now(), String(id)).changes);
    },

    /** ห้องที่ยังไม่ได้อ่านทั้งหมดของรอบ → skipped (เงินหมด/รอบค้างนาน) */
    skipPendingOwnerReviewItems(batchId) {
      if (!exists()) return 0;
      return Number(run(`UPDATE owner_review_items SET ai_status = 'skipped', updated_at = ?
        WHERE batch_id = ? AND ai_status = 'pending'`, now(), String(batchId)).changes);
    },

    ownerReviewItemsForBatch(batchId) {
      if (!exists()) return [];
      return all("SELECT * FROM owner_review_items WHERE batch_id = ? ORDER BY created_at ASC, rowid ASC", String(batchId));
    },

    /** ผลของ ownerReviewTaper ต่อห้อง (ตอนปิดรอบ) */
    setOwnerReviewItemInclusion(id, { flagged, sampled, included }) {
      if (!OWNER_REVIEW_INCLUDED.includes(included)) throw new Error("owner review inclusion is invalid");
      if (!exists()) return 0;
      return Number(run(`UPDATE owner_review_items SET flagged = ?, sampled = ?, included = ?, updated_at = ? WHERE id = ?`,
        flagged ? 1 : 0, sampled ? 1 : 0, included, now(), String(id)).changes);
    },

    /** ตัวเลขของรอบ (เฉพาะสาขาที่ผู้ดูเห็นได้) — ไม่มีรหัสห้อง */
    ownerReviewBatchItemCounts(batchId, { channels = null } = {}) {
      const zero = {
        rooms: 0, pending: 0, done: 0, failed: 0, skipped: 0, included: 0, flagged: 0, sampled: 0,
        labelled: 0, good: 0, needsFix: 0, remaining: 0, flaggedRemaining: 0, bulkEligible: 0,
      };
      if (!exists()) return zero;
      const scope = scopeSql(channels);
      const row = get(`SELECT COUNT(*) AS rooms,
            SUM(i.ai_status = 'pending') AS pending, SUM(i.ai_status = 'done') AS done,
            SUM(i.ai_status = 'failed') AS failed, SUM(i.ai_status = 'skipped') AS skipped,
            SUM(${QUEUED}) AS included, SUM(${QUEUED} AND i.flagged = 1) AS flagged, SUM(${QUEUED} AND i.sampled = 1) AS sampled,
            SUM(${QUEUED} AND i.label IS NOT NULL) AS labelled, SUM(${QUEUED} AND i.label = 'good') AS good,
            SUM(${QUEUED} AND i.label = 'needs_fix') AS needs_fix, SUM(${QUEUED} AND i.label IS NULL) AS remaining,
            SUM(${QUEUED} AND i.label IS NULL AND i.flagged = 1) AS flagged_remaining,
            SUM(${QUEUED} AND ${BULK_ELIGIBLE}) AS bulk_eligible
          FROM owner_review_items i JOIN customers c ON c.line_user_id = i.customer_id
         WHERE i.batch_id = ? AND ${scope.sql}`, String(batchId), ...scope.values) ?? {};
      return {
        rooms: Number(row.rooms) || 0, pending: Number(row.pending) || 0, done: Number(row.done) || 0,
        failed: Number(row.failed) || 0, skipped: Number(row.skipped) || 0, included: Number(row.included) || 0,
        flagged: Number(row.flagged) || 0, sampled: Number(row.sampled) || 0, labelled: Number(row.labelled) || 0,
        good: Number(row.good) || 0, needsFix: Number(row.needs_fix) || 0, remaining: Number(row.remaining) || 0,
        flaggedRemaining: Number(row.flagged_remaining) || 0, bulkEligible: Number(row.bulk_eligible) || 0,
      };
    },

    /**
     * คิวของรอบ (เฉพาะห้องที่เข้าคิว) — น่าห่วงก่อน · AI ยังไม่ได้อ่าน (ไม่รู้ความเสี่ยง) ถัดมา · ที่เหลือคะแนนสูงก่อน
     * ไม่มีข้อความแชท — การ์ดดึงรายละเอียดทีละห้อง
     */
    listOwnerReviewQueue(batchId, { channels = null, limit = OWNER_REVIEW_DAILY_ROOM_HARD_CAP } = {}) {
      if (!exists()) return [];
      const scope = scopeSql(channels);
      return all(`SELECT ${withCustomer} FROM owner_review_items i JOIN customers c ON c.line_user_id = i.customer_id
         WHERE i.batch_id = ? AND ${QUEUED} AND ${scope.sql}
         ORDER BY i.flagged DESC, (i.ai_status = 'done') ASC, COALESCE(i.risk, 0) DESC, i.created_at ASC, i.id ASC
         LIMIT ?`, String(batchId), ...scope.values, Math.max(1, Math.min(OWNER_REVIEW_DAILY_ROOM_HARD_CAP, Number(limit) || 1)));
    },

    /**
     * เขียนป้ายแบบ compare-and-set (revision ต้องตรง) — คืนแถวใหม่ หรือ null = มีคนเปลี่ยนไปก่อนแล้ว
     * label null = ล้างป้าย (ย้อน) · lessonIds = รายการบทเรียนทั้งก้อน (ผู้เรียกต่อท้ายเอง)
     */
    casOwnerReviewItemLabel(id, { expectedRevision, label, note = "", via = "", by = "", at = null, bulkId = "", lessonIds } = {}) {
      if (label !== null && !OWNER_REVIEW_LABELS.includes(label)) throw new Error("owner review label is invalid");
      if (via !== "" && !OWNER_REVIEW_LABEL_VIA.includes(via)) throw new Error("owner review label source is invalid");
      if (!exists()) return null;
      const sets = ["label = ?", "label_note = ?", "label_via = ?", "label_bulk_id = ?", "labelled_by = ?", "labelled_at = ?",
        "revision = revision + 1", "updated_at = ?"];
      const values = [label, label === null ? "" : clipText(note, OWNER_REVIEW_LABEL_NOTE_MAX), label === null ? "" : via,
        label === null ? "" : String(bulkId || "").slice(0, 80), label === null ? "" : String(by || "").slice(0, 60),
        label === null || at == null ? null : Number(at), now()];
      if (lessonIds !== undefined) {
        sets.push("lesson_ids_json = ?");
        values.push(JSON.stringify(Array.isArray(lessonIds) ? lessonIds.slice(-20) : []));
      }
      const changed = Number(run(`UPDATE owner_review_items SET ${sets.join(", ")} WHERE id = ? AND revision = ?`,
        ...values, String(id), Math.trunc(Number(expectedRevision))).changes);
      return changed === 1 ? byId(id) : null;
    },

    /** คนกดเห็นด้วย/ไม่เห็นด้วยกับปัญหาที่ AI ชี้ (verdict null = ถอน) — ไม่แตะ revision ของป้าย */
    setOwnerReviewItemVerdict(id, key, verdict) {
      if (!exists()) return null;
      const row = byId(id);
      if (!row) return null;
      const current = parseJson(row.issue_verdicts_json, {});
      const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
      if (verdict === null) delete next[key];
      else next[key] = verdict === "agree" ? "agree" : "disagree";
      run("UPDATE owner_review_items SET issue_verdicts_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(next), now(), String(id));
      return byId(id);
    },

    /**
     * "ดีที่เหลือทั้งหมด" — ห้องในคิวที่ยังไม่มีป้าย ไม่น่าห่วง ไม่ได้ถูกสุ่มวัดผล และ AI ไม่ได้ชี้จุดใด (ต้องดูทีละห้องเสมอ)
     * ภายในสาขาที่เห็นได้ · exceptId = การ์ดที่เปิดอยู่บนจอ (ไม่ติดป้ายห้องที่หายไปจากใต้นิ้ว) · คืนจำนวนแถวที่ติดป้าย (bulkId ใช้ย้อน)
     */
    bulkLabelOwnerReviewItems(batchId, { channels = null, by, at, bulkId, exceptId = "" } = {}) {
      if (!exists()) return 0;
      const scope = scopeSql(channels);
      return Number(run(`UPDATE owner_review_items SET label = 'good', label_note = '', label_via = 'bulk', label_bulk_id = ?,
            labelled_by = ?, labelled_at = ?, revision = revision + 1, updated_at = ?
          WHERE id IN (SELECT i.id FROM owner_review_items i JOIN customers c ON c.line_user_id = i.customer_id
                        WHERE i.batch_id = ? AND i.id <> ? AND ${QUEUED} AND ${BULK_ELIGIBLE} AND ${scope.sql})`,
      String(bulkId), String(by || "").slice(0, 60), Number(at), now(), String(batchId), String(exceptId || ""), ...scope.values).changes);
    },

    /** ย้อน "ดีที่เหลือทั้งหมด" — เฉพาะแถวของ bulkId นี้ที่คนเดิมกดและยังไม่ถูกเปลี่ยน */
    undoBulkOwnerReviewItems(batchId, { bulkId, by } = {}) {
      if (!exists() || !String(bulkId || "")) return 0;
      return Number(run(`UPDATE owner_review_items SET label = NULL, label_note = '', label_via = '', label_bulk_id = '',
            labelled_by = '', labelled_at = NULL, revision = revision + 1, updated_at = ?
          WHERE batch_id = ? AND label_via = 'bulk' AND label_bulk_id = ? AND labelled_by = ?`,
      now(), String(batchId), String(bulkId), String(by || "")).changes);
    },

    /** เวลาติดป้ายของ bulkId (ตรวจหน้าต่างย้อน 10 วิ) — 0 = ไม่มี */
    ownerReviewBulkLabelledAt(batchId, bulkId) {
      if (!exists()) return 0;
      return Number(get(`SELECT MAX(labelled_at) AS at FROM owner_review_items
        WHERE batch_id = ? AND label_bulk_id = ? AND label_via = 'bulk'`, String(batchId), String(bulkId))?.at) || 0;
    },

    /** แถวที่มีป้ายในช่วงวัน [fromDayKey, toDayKey) — วัดความแม่นของ AI ย้อนหลัง 7 วัน (ownerReviewTaper.metrics) */
    ownerReviewLabelledItems(fromDayKey, toDayKey) {
      if (!exists()) return [];
      return all(`SELECT day_key, ai_status, flagged, sampled, included, label, label_via, issues_json, issue_verdicts_json
          FROM owner_review_items WHERE day_key >= ? AND day_key < ? AND label IS NOT NULL
          ORDER BY day_key ASC LIMIT 5000`, String(fromDayKey), String(toDayKey));
    },

    /** รอบ daily ที่พร้อมแล้วตั้งแต่ sinceSlotMs พร้อมจำนวนที่ยังไม่ตรวจ (ชิป "ค้างตรวจ") — ใหม่ก่อน */
    ownerReviewDailyBacklog(sinceSlotMs, { channels = null } = {}) {
      if (!exists()) return [];
      const scope = scopeSql(channels);
      return all(`SELECT b.id AS batch_id, b.slot_ms, b.status,
            (SELECT COUNT(*) FROM owner_review_items i JOIN customers c ON c.line_user_id = i.customer_id
              WHERE i.batch_id = b.id AND ${QUEUED} AND i.label IS NULL AND ${scope.sql}) AS remaining,
            (SELECT COUNT(*) FROM owner_review_items i JOIN customers c ON c.line_user_id = i.customer_id
              WHERE i.batch_id = b.id AND ${QUEUED} AND ${scope.sql}) AS included
          FROM owner_review_batches b
         WHERE b.kind = 'daily' AND b.status = 'ready' AND b.slot_ms >= ?
         ORDER BY b.slot_ms DESC LIMIT 14`, ...scope.values, ...scope.values, Number(sinceSlotMs) || 0);
    },

    deleteOwnerReviewItemsForCustomer(customerId) {
      if (!exists()) return 0;
      return Number(run("DELETE FROM owner_review_items WHERE customer_id = ?", String(customerId)).changes);
    },

    pruneOwnerReviewItems(cutoffMs) {
      if (!exists()) return 0;
      return Number(run("DELETE FROM owner_review_items WHERE created_at < ?", Number(cutoffMs) || 0).changes);
    },
  };
}
