// dbGentleFollowups.mjs — ที่เก็บของ "ทักเบา ๆ" สองแบบ (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//   · หมุด "ขอเช็คคิวก่อน" ของห้อง = followup_state.defer_json (ตัวเดินอยู่ที่ scheduleCheck.mjs)
//   · ทักเบา ๆ หลังส่งเลขบัญชี = อ่านแถว audit bank_sent_info_continues (ไม่ต้องเขียนอะไรเพิ่มในเส้นตอบ)
// ความ "ครั้งเดียวต่อรอบ" ของการทักหลังส่งบัญชีใช้ proactive_attempts (lane payment_nudge) ตัวเดิม

// เส้นส่งเลขบัญชีที่ AI ยังเปิดอยู่ (SALES_DECISION_GUARD_ENABLED) เขียนแถวนี้ทุกครั้งที่บล็อกบัญชีถึงมือลูกค้า
export const BANK_SENT_AUDIT_ACTION = "bank_sent_info_continues";

export function createGentleFollowupDbMethods({ run, get, all }) {
  return {
    /** ตั้ง/ล้างหมุดของห้อง ("" = ไม่มี) — สร้างแถว followup_state ให้ถ้ายังไม่มี ไม่แตะคอลัมน์บันได */
    setFollowupDefer(customerId, value) {
      run(
        `INSERT INTO followup_state (customer_id, defer_json) VALUES (?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET defer_json = excluded.defer_json`,
        String(customerId), String(value ?? ""),
      );
    },

    /** เวลาที่บล็อกบัญชีถึงมือลูกค้าครั้งล่าสุด (ไม่เก่ากว่า sinceMs) — ไม่มี = null (ใช้ index เวลา) */
    latestBankSentAt(customerId, sinceMs = 0) {
      const row = get(
        `SELECT MAX(created_at) AS at FROM admin_audit
          WHERE created_at >= ? AND target = ? AND action = ?`,
        Number(sinceMs) || 0, String(customerId), BANK_SENT_AUDIT_ACTION,
      );
      return Number(row?.at) > 0 ? Number(row.at) : null;
    },

    /**
     * ห้องที่อาจต้องได้ข้อความทักเบา ๆ หลังส่งบัญชี: AI ยังเปิด · รอชำระ · ไม่ห้ามรบกวน · ยังคุยกันในช่วงนี้
     * (ด่านละเอียดทั้งหมดอยู่ที่ paymentGentleNudge.mjs — SQL คัดแค่คร่าว ๆ ให้เหลือไม่กี่ห้อง)
     */
    listPaymentNudgeCandidates({ nowMs, activeWithinMs }) {
      return all(
        `SELECT c.*,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id AND m.direction = 'in') AS last_inbound_at
         FROM customers c
         WHERE c.ai_enabled = 1 AND c.deal_status = 'awaiting_payment'
           AND c.do_not_disturb = 0 AND COALESCE(c.marketing_consent, 0) >= 0
           AND (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id) >= ?`,
        Number(nowMs) - Number(activeWithinMs),
      );
    },
  };
}
