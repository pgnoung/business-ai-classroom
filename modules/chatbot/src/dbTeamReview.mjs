// dbTeamReview.mjs — ตารางผลตรวจ "คำตอบของทีม" (teamReplyReview.mjs · คำสั่งพี่ง้วง 3 พ.ย. 2026)
//
// พี่ง้วง: ตรวจว่าชมพู่ (แอดมินคนจริง) ตอบแชทเป็นยังไง — "พี่ง้วงเห็นคนเดียว" · "ใช้ luna ดีกว่า"
// หนึ่งแถวต่อห้องต่อวัน (day_key เวลาไทย) · ไม่มีข้อความแชทในตารางนี้ มีแต่คะแนน/รหัสปัญหา/โน้ตที่ปิดชื่อแล้ว
import { NON_HUMAN_NOTE_AUTHORS_SQL } from "./lineOaContext.mjs";
import { HUMAN_TOUCH_SQL } from "./dbAttention.mjs";

export const TEAM_REVIEW_STATUSES = Object.freeze(["pending", "done", "failed", "skipped"]);

export const TEAM_REVIEW_SCHEMA = `
-- team_reply_reviews — Luna อ่านคำตอบของทีม (แอดมินคนจริง) วันละครั้งต่อห้อง · เจ้าของเห็นคนเดียว
--   operators = ชื่อผู้พิมพ์ฝั่งทีมในวันนั้น (คั่นด้วย , ) · human_messages = จำนวนข้อความของทีมในช่วง
--   status = pending | done | failed (Luna ล้ม/ตอบผิดรูป) | skipped (เงินหมด/ค้างนาน/ไม่มีข้อความทีม)
--   score = 1–5 (NULL = ยังไม่ได้อ่าน) · issues_json = [{code, messageId, note}] รหัสในรายการปิดเท่านั้น
CREATE TABLE IF NOT EXISTS team_reply_reviews (
  id              TEXT PRIMARY KEY,
  day_key         TEXT NOT NULL,
  customer_id     TEXT NOT NULL REFERENCES customers(line_user_id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL DEFAULT 'default',
  window_start_ms INTEGER NOT NULL,
  window_end_ms   INTEGER NOT NULL,
  operators       TEXT NOT NULL DEFAULT '',
  human_messages  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','skipped')),
  score           INTEGER CHECK (score IS NULL OR (score BETWEEN 1 AND 5)),
  summary         TEXT NOT NULL DEFAULT '',
  good            TEXT NOT NULL DEFAULT '',
  issues_json     TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (day_key, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_team_reply_reviews_status ON team_reply_reviews(status, created_at);
CREATE INDEX IF NOT EXISTS idx_team_reply_reviews_day ON team_reply_reviews(day_key);
`;

export function createTeamReviewDbMethods({ db, run, all, get, now, newId }) {
  let ready = false;
  const ensure = () => {
    if (ready) return;
    db.exec(TEAM_REVIEW_SCHEMA);
    ready = true;
  };

  return {
    // ห้องที่ทีมพิมพ์คุยกับลูกค้าในช่วง (คอนโซล / Business Suite / YOLO — นิยามเดียวกับไม้ต่อ)
    teamReviewCandidates({ fromMs, toMs, limit = 400 } = {}) {
      return all(
        `SELECT m.customer_id, COALESCE(c.channel_id, 'default') AS channel_id, COUNT(*) AS human_messages,
                group_concat(DISTINCT CASE WHEN m.operator NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL}) THEN m.operator END) AS operators
         FROM messages m JOIN customers c ON c.line_user_id = m.customer_id
         WHERE m.created_at > ? AND m.created_at <= ? AND ${HUMAN_TOUCH_SQL("m")}
           AND m.customer_id NOT LIKE 'canary:%'
         GROUP BY m.customer_id
         ORDER BY MAX(m.created_at) DESC
         LIMIT ?`,
        Number(fromMs), Number(toMs), Math.max(1, Math.trunc(Number(limit)) || 400),
      );
    },

    /** สร้างแถวของวันนั้น (ซ้ำ = ข้าม) — คืนจำนวนแถวใหม่ */
    addTeamReviewRows({ dayKey, windowStartMs, windowEndMs, rooms = [] }) {
      ensure();
      const t = now();
      let added = 0;
      for (const room of rooms) {
        const result = run(
          `INSERT OR IGNORE INTO team_reply_reviews
             (id, day_key, customer_id, channel_id, window_start_ms, window_end_ms, operators, human_messages, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId(), String(dayKey), String(room.customer_id), String(room.channel_id || "default"),
          Number(windowStartMs), Number(windowEndMs), String(room.operators || ""), Number(room.human_messages) || 0, t, t,
        );
        added += Number(result?.changes) || 0;
      }
      return added;
    },

    pendingTeamReviews({ limit = 10 } = {}) {
      ensure();
      return all(
        `SELECT * FROM team_reply_reviews WHERE status = 'pending' ORDER BY created_at, id LIMIT ?`,
        Math.max(1, Math.trunc(Number(limit)) || 10),
      );
    },

    /** แถวค้าง pending นานเกิน (เครื่องดับ/เงินหมดทั้งคืน) = skipped — ไม่วนอ่านของเก่าข้ามวัน */
    expireTeamReviews(beforeMs) {
      ensure();
      return Number(run(`UPDATE team_reply_reviews SET status = 'skipped', updated_at = ? WHERE status = 'pending' AND created_at < ?`,
        now(), Number(beforeMs))?.changes) || 0;
    },

    saveTeamReview(id, { status, score = null, summary = "", good = "", issues = [] }) {
      ensure();
      run(
        `UPDATE team_reply_reviews SET status = ?, score = ?, summary = ?, good = ?, issues_json = ?, updated_at = ? WHERE id = ?`,
        String(status), score == null ? null : Number(score), String(summary), String(good), JSON.stringify(issues || []), now(), String(id),
      );
    },

    // ข้อความของห้องสำหรับให้ Luna อ่าน — สิ้นสุดที่ปลายช่วง · เก่า → ใหม่
    teamReviewWindowRows(customerId, endMs, limit) {
      return all(
        `SELECT m.id, m.direction, m.msg_type, m.content, m.operator, m.message_class, m.created_at
         FROM messages m WHERE m.customer_id = ? AND m.created_at <= ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
        String(customerId), Number(endMs), Math.max(1, Math.trunc(Number(limit)) || 40),
      ).reverse();
    },

    listTeamReviews({ sinceDayKey = "" } = {}) {
      ensure();
      return all(
        `SELECT r.*, c.display_name, c.known_name FROM team_reply_reviews r
         LEFT JOIN customers c ON c.line_user_id = r.customer_id
         WHERE r.day_key >= ? ORDER BY r.day_key DESC, COALESCE(r.score, 9), r.updated_at DESC LIMIT 2000`,
        String(sinceDayKey),
      );
    },
  };
}
