// A paid draft and a provider send need different fences. A failed draft may
// retry slowly (three attempts per inbound/step); an uncertain send must never
// be replayed automatically. Persist BEFORE I/O so restart cannot reset either.
export const PROACTIVE_RETRY_MS = 15 * 60_000;
export const PROACTIVE_MAX_ATTEMPTS = 3;

export function createProactiveAttemptDbMethods({ run, get }) {
  return {
    getProactiveAttempt(customerId, lane = "staged", attemptKey = null) {
      return (attemptKey === null
        ? get("SELECT * FROM proactive_attempts WHERE customer_id=? AND lane=? ORDER BY updated_at DESC, rowid DESC LIMIT 1", String(customerId), String(lane))
        : get("SELECT * FROM proactive_attempts WHERE customer_id=? AND lane=? AND attempt_key=?", String(customerId), String(lane), String(attemptKey))) ?? null;
    },
    claimProactiveAttempt(customerId, lane, attemptKey, atMs) {
      const row = this.getProactiveAttempt(customerId, lane, attemptKey);
      const same = row?.attempt_key === String(attemptKey);
      if (same && ["sending", "settled"].includes(row.status)) return { ok: false, reason: "delivery_fenced" };
      if (same && row.attempts >= PROACTIVE_MAX_ATTEMPTS) return { ok: false, reason: "attempt_limit" };
      if (same && row.next_attempt_at > atMs) return { ok: false, reason: "attempt_backoff" };
      const attempts = same ? row.attempts + 1 : 1;
      run(`INSERT INTO proactive_attempts (customer_id, lane, attempt_key, attempts, next_attempt_at, status, updated_at)
        VALUES (?, ?, ?, ?, ?, 'drafting', ?)
        ON CONFLICT(customer_id, lane, attempt_key) DO UPDATE SET
          attempts=excluded.attempts, next_attempt_at=excluded.next_attempt_at, status=excluded.status, updated_at=excluded.updated_at`,
      String(customerId), String(lane), String(attemptKey), attempts, atMs + PROACTIVE_RETRY_MS * 2 ** (attempts - 1), atMs);
      return { ok: true, attempts };
    },
    fenceProactiveSend(customerId, lane, attemptKey, atMs) {
      const result = run(`UPDATE proactive_attempts SET status='sending', updated_at=?
        WHERE customer_id=? AND lane=? AND attempt_key=? AND status='drafting'`,
      atMs, String(customerId), String(lane), String(attemptKey));
      return Number(result.changes) === 1;
    },
    settleProactiveSend(customerId, lane, attemptKey, atMs) {
      run(`UPDATE proactive_attempts SET status='settled', updated_at=?
        WHERE customer_id=? AND lane=? AND attempt_key=? AND status='sending'`,
      atMs, String(customerId), String(lane), String(attemptKey));
    },
    // 2026-09-28 (ทักเบา ๆ หลังส่งบัญชี): "รอบนี้จบแล้วโดยไม่ส่ง" (ข้ามถาวร) — ปิดแถวเป็น settled
    // ห้ามแตะแถวที่กำลังส่งอยู่ (sending) เพราะแปลว่ามีคนข้ามเส้น provider ไปแล้ว; คืน true = ปิดสำเร็จ
    closeProactiveAttempt(customerId, lane, attemptKey, atMs) {
      const result = run(`INSERT INTO proactive_attempts (customer_id, lane, attempt_key, attempts, next_attempt_at, status, updated_at)
        VALUES (?, ?, ?, 0, ?, 'settled', ?)
        ON CONFLICT(customer_id, lane, attempt_key) DO UPDATE SET status='settled', updated_at=excluded.updated_at
        WHERE proactive_attempts.status = 'drafting'`,
      String(customerId), String(lane), String(attemptKey), atMs, atMs);
      return Number(result.changes) === 1;
    },
  };
}
