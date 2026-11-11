// dbLineUsage.mjs — ที่เก็บของการ์ด "LINE OA เดือนนี้" (28 ก.ย. 2026)
//
// สองตาราง ไม่มี id ลูกค้า/ผู้รับเลยทั้งคู่ (นับอย่างเดียว) จึงอยู่นอกเส้น PDPA cascade โดยเจตนา:
//   line_send_ledger        = ระบบของเรายิง LINE ไปกี่คำขอ ด้วยวิธีไหน เพื่ออะไร (รวมรายวันเวลาไทย)
//   line_delivery_insights  = สถิติทางการจาก LINE รายวัน (วันตามเวลาญี่ปุ่น UTC+9 ตามที่ LINE ใช้)
// ตารางแรกโตวันละไม่กี่แถว (วัน × OA × วิธี × เหตุผล) ตารางหลังวันละแถวต่อ OA — ไม่ต้องมีงานลบ
// DDL ต่อท้าย SCHEMA ใน schema.mjs (CREATE ... IF NOT EXISTS = เพิ่มอย่างเดียว ไม่แตะตารางเดิม)

export const LINE_USAGE_SCHEMA = `
-- line_send_ledger — บัญชีการยิง LINE ของระบบ รวมรายวัน (src/lineSendLedger.mjs เป็นคนเขียน)
--   day             = YYYY-MM-DD เวลาไทย
--   method          = reply | push | multicast | narrowcast | broadcast (reply อย่างเดียวที่ LINE ไม่นับโควตา)
--   purpose         = เหตุผลการส่ง (team_alert, customer_reply, customer_reply_fallback, followup, ...)
--   detail          = เหตุที่คำตอบลูกค้าต้องใช้ push (reply_rejected | no_reply_token | over_five) หรือว่าง
--   sends           = ครั้งที่ระบบสั่งส่ง (ส่งหนึ่งครั้งแตกเป็นหลายคำขอได้ เมื่อยิงทีละบอลลูน)
--   requests        = คำขอที่ LINE ตอบรับ
--   recipients      = ผู้รับรวมทุกคำขอ = จำนวนที่ LINE นับโควตาเมื่อ counts_quota = 1
--   message_objects = บอลลูน/รูป/สติกเกอร์ในคำขอเหล่านั้น (ไม่คูณผู้รับ)
CREATE TABLE IF NOT EXISTS line_send_ledger (
  day             TEXT NOT NULL,
  channel_id      TEXT NOT NULL DEFAULT 'default',
  method          TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '',
  counts_quota    INTEGER NOT NULL DEFAULT 0,
  sends           INTEGER NOT NULL DEFAULT 0,
  requests        INTEGER NOT NULL DEFAULT 0,
  recipients      INTEGER NOT NULL DEFAULT 0,
  message_objects INTEGER NOT NULL DEFAULT 0,
  first_at        INTEGER NOT NULL,
  last_at         INTEGER NOT NULL,
  PRIMARY KEY (day, channel_id, method, purpose, detail)
);

-- line_delivery_insights — "Get number of message deliveries" ของ LINE ต่อ OA ต่อวัน (src/lineInsight.mjs)
--   date        = YYYYMMDD ตามเวลาญี่ปุ่น (UTC+9) — คนละขอบวันกับ line_send_ledger (ต่างกัน 2 ชม.)
--   status      = ready | unready | out_of_service | error (error = ยิงไม่สำเร็จ รอบหน้าลองใหม่)
--   counts_json = ตัวเลขทุกช่องที่ LINE ส่งมา (เฉพาะตัวเลข — ไม่มีข้อมูลคน)
CREATE TABLE IF NOT EXISTS line_delivery_insights (
  channel_id      TEXT NOT NULL,
  date            TEXT NOT NULL,
  status          TEXT NOT NULL,
  counts_json     TEXT NOT NULL DEFAULT '{}',
  error           TEXT NOT NULL DEFAULT '',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL,
  ready_at        INTEGER,
  PRIMARY KEY (channel_id, date)
);
`;

const LEDGER_COLUMNS = `day, channel_id, method, purpose, detail, counts_quota, sends, requests, recipients,
  message_objects, first_at, last_at`;

// ช่อง channel ที่ผู้เรียกกรองมา — ว่าง = ทุก OA ของ LINE
function channelFilter(column, channelIds) {
  const ids = Array.isArray(channelIds) ? channelIds.map(String).filter(Boolean) : [];
  if (!ids.length) return { sql: "", params: [] };
  return { sql: ` AND ${column} IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

export function createLineUsageDbMethods({ run, all, get }) {
  return {
    /** บวกหนึ่งเหตุการณ์ส่งเข้ากล่องรายวัน (UPSERT — แถวเดียวต่อ วัน × OA × วิธี × เหตุผล × เหตุ) */
    addLineSend({ day, channelId, method, purpose, detail = "", countsQuota, sends = 0, requests = 1, recipients = 1, messageObjects = 0, at }) {
      run(
        `INSERT INTO line_send_ledger (${LEDGER_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, channel_id, method, purpose, detail) DO UPDATE SET
           sends = sends + excluded.sends,
           requests = requests + excluded.requests,
           recipients = recipients + excluded.recipients,
           message_objects = message_objects + excluded.message_objects,
           last_at = MAX(last_at, excluded.last_at)`,
        String(day), String(channelId), String(method), String(purpose), String(detail || ""),
        countsQuota ? 1 : 0, Number(sends) || 0, Number(requests) || 0, Number(recipients) || 0,
        Number(messageObjects) || 0, Number(at), Number(at),
      );
    },

    /** แถวบัญชีในช่วงวัน (YYYY-MM-DD รวมหัวท้าย) */
    lineSendRows({ fromDay, toDay, channelIds = [] } = {}) {
      const filter = channelFilter("channel_id", channelIds);
      return all(
        `SELECT ${LEDGER_COLUMNS} FROM line_send_ledger
          WHERE day >= ? AND day <= ?${filter.sql}
          ORDER BY day, channel_id, method, purpose, detail`,
        String(fromDay), String(toDay), ...filter.params,
      );
    },

    /** บัญชีเริ่มนับเมื่อไร (เวลาจริงของคำขอแรกที่บันทึกได้) — null = ยังไม่เคยบันทึกเลย */
    lineSendLedgerStart({ channelIds = [] } = {}) {
      const filter = channelFilter("channel_id", channelIds);
      const row = get(`SELECT MIN(first_at) AS at FROM line_send_ledger WHERE 1 = 1${filter.sql}`, ...filter.params);
      return Number(row?.at) > 0 ? Number(row.at) : null;
    },

    /** เก็บผลดึงสถิติหนึ่งวัน — นับครั้งที่ลอง และจำเวลาที่ได้ ready ครั้งแรก */
    saveLineInsight({ channelId, date, status, counts = {}, error = "", at }) {
      run(
        `INSERT INTO line_delivery_insights (channel_id, date, status, counts_json, error, attempts, last_attempt_at, ready_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(channel_id, date) DO UPDATE SET
           status = excluded.status,
           counts_json = CASE WHEN excluded.status = 'ready' THEN excluded.counts_json ELSE line_delivery_insights.counts_json END,
           error = excluded.error,
           attempts = line_delivery_insights.attempts + 1,
           last_attempt_at = excluded.last_attempt_at,
           ready_at = COALESCE(line_delivery_insights.ready_at, excluded.ready_at)`,
        String(channelId), String(date), String(status), JSON.stringify(counts || {}), String(error || "").slice(0, 120),
        Number(at), status === "ready" ? Number(at) : null,
      );
    },

    /** สถิติ LINE ในช่วงวันที่ (YYYYMMDD รวมหัวท้าย) */
    lineInsightRows({ fromDate, toDate, channelIds = [] } = {}) {
      const filter = channelFilter("channel_id", channelIds);
      return all(
        `SELECT channel_id, date, status, counts_json, error, attempts, last_attempt_at, ready_at
           FROM line_delivery_insights
          WHERE date >= ? AND date <= ?${filter.sql}
          ORDER BY date, channel_id`,
        String(fromDate), String(toDate), ...filter.params,
      );
    },

    /** ภาพโควตาล่าสุดทุก OA ที่ตัวดึงสถิติเก็บไว้ (settings line_quota_snapshot:<channel>) */
    lineQuotaSnapshots() {
      return all("SELECT key, value FROM settings WHERE key LIKE 'line_quota_snapshot:%' ORDER BY key");
    },

    /**
     * push แจ้งทีม/สรุปถึงเจ้าของ ที่เกิดก่อนมีบัญชี — อ่านจาก admin_audit ที่ notify.mjs/digest.mjs เขียนอยู่แล้ว
     * ("push แจ้งทีม 2/2 คน" · "bubbles=5") ใช้เติมช่วงต้นเดือนก่อนวันเริ่มบันทึกเท่านั้น ห้ามนับซ้ำช่วงที่บัญชีมีแล้ว
     */
    teamPushAuditRows({ sinceMs, untilMs }) {
      return all(
        `SELECT action, detail, created_at FROM admin_audit
          WHERE created_at >= ? AND created_at < ? AND action IN ('escalate_notify', 'digest_sent')`,
        Number(sinceMs), Number(untilMs),
      );
    },
  };
}
