// dbMetaCapi.mjs — ใบเสร็จการส่ง Purchase เข้า Meta Conversions API (metaCapi.mjs · พี่ง้วง 7 ต.ค. 2026)
// หนึ่งแถวต่อออเดอร์ต่อโหมด — จองแถวก่อนยิงเสมอ = ออเดอร์เดียวไม่ถูกส่งซ้ำ (กดชำระแล้ว/ยกเลิก/กดใหม่ก็ไม่ซ้ำ)
// เก็บแค่เลขออเดอร์ ยอด สถานะ และคำตอบย่อของ Meta — ไม่เก็บ PSID/ข้อความลูกค้า (customer_id อยู่ที่ orders อยู่แล้ว)
export const META_CAPI_SCHEMA = `
-- meta_capi_events — Purchase ที่ส่งเข้า Meta (src/metaCapi.mjs)
--   mode   = test (มี test_event_code ไม่นับจริง) | live
--   status = pending → sent | failed | skipped (ไม่มี PSID/ยอด/ชุดข้อมูล)
CREATE TABLE IF NOT EXISTS meta_capi_events (
  order_id     TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  event_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  value_thb    REAL,
  detail       TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (order_id, mode)
);
`;

/** ข้ามแบบถาวร (ไม่ลองใหม่) — ห้องไม่ใช่ Messenger / ไม่มียอด */
export const CAPI_FINAL_SKIPS = Object.freeze(["not_messenger", "no_total", "off"]);
/** ลองใหม่ได้กี่ครั้ง และห่างกันอย่างน้อยเท่าไร (Meta รับ event ย้อนหลังไม่เกิน 7 วัน) */
export const CAPI_MAX_ATTEMPTS = 5;
export const CAPI_RETRY_GAP_MS = 25 * 60_000;
const RETRYABLE_SQL = `(status = 'failed' OR (status = 'skipped' AND detail NOT IN (${CAPI_FINAL_SKIPS.map((v) => `'${v}'`).join(", ")})))`;

export function createMetaCapiDbMethods({ run, get, all, now }) {
  return {
    /**
     * จองสิทธิ์ส่ง — true เมื่อเป็นครั้งแรก หรือรอบก่อนพัง/ข้ามด้วยเหตุที่แก้ได้ (ยังไม่ครบโควตา + ห่างพอ)
     * ส่งสำเร็จแล้ว / กำลังส่ง / ข้ามถาวร = false เสมอ → ออเดอร์เดียวไม่ถูกนับซ้ำ (รีวิว 7 ต.ค.: ห้ามหายถาวรเพราะพังครั้งเดียว)
     */
    reserveCapiEvent({ orderId, mode, eventId, valueThb = null }) {
      const t = now();
      const inserted = run(
        `INSERT OR IGNORE INTO meta_capi_events (order_id, mode, event_id, status, value_thb, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        String(orderId), String(mode), String(eventId), valueThb == null ? null : Number(valueThb), t, t,
      ).changes === 1;
      if (inserted) return true;
      return run(
        `UPDATE meta_capi_events SET status = 'pending', attempts = attempts + 1, updated_at = ?
          WHERE order_id = ? AND mode = ? AND ${RETRYABLE_SQL} AND attempts < ? AND updated_at <= ?`,
        t, String(orderId), String(mode), CAPI_MAX_ATTEMPTS, t - CAPI_RETRY_GAP_MS,
      ).changes === 1;
    },

    /** ออเดอร์ Messenger ที่ชำระแล้วในช่วง sinceMs ที่ยังไม่ถูกส่งสำเร็จในโหมดนี้ (ตัวกวาดลองใหม่) */
    capiRetryCandidates({ mode, sinceMs, limit = 20 }) {
      const t = now();
      return all(
        `SELECT o.id, o.customer_id, o.total, o.status FROM orders o
          WHERE o.status IN ('paid', 'done') AND o.updated_at >= ? AND o.customer_id LIKE 'facebook:%'
            AND NOT EXISTS (SELECT 1 FROM meta_capi_events e WHERE e.order_id = o.id AND e.mode = ?
                              AND NOT (${RETRYABLE_SQL.replaceAll("status", "e.status").replaceAll("detail", "e.detail")}
                                       AND e.attempts < ? AND e.updated_at <= ?))
          ORDER BY o.updated_at DESC LIMIT ?`,
        Number(sinceMs) || 0, String(mode), CAPI_MAX_ATTEMPTS, t - CAPI_RETRY_GAP_MS, Math.max(1, Math.min(100, Number(limit) || 20)),
      );
    },

    finishCapiEvent({ orderId, mode, status, detail = "" }) {
      run(
        "UPDATE meta_capi_events SET status = ?, detail = ?, updated_at = ? WHERE order_id = ? AND mode = ?",
        String(status), String(detail).slice(0, 300), now(), String(orderId), String(mode),
      );
    },

    capiEventFor(orderId) {
      return all("SELECT * FROM meta_capi_events WHERE order_id = ? ORDER BY created_at DESC", String(orderId));
    },

    capiEventCounts(sinceMs = 0) {
      return all(
        "SELECT mode, status, COUNT(*) AS n FROM meta_capi_events WHERE created_at >= ? GROUP BY mode, status",
        Number(sinceMs) || 0,
      );
    },
  };
}
