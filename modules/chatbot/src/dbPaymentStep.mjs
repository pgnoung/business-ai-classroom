// dbPaymentStep.mjs — คิวรีอ่านอย่างเดียวของตัวเฝ้าขั้นชำระเงิน (paymentStepWatch.mjs · 18 ต.ค. 2026)
// รันวันละครั้งบนรอบ retention: สแกนข้อความขาออกช่วงสั้น ๆ ด้วย LIKE (ไม่มี index เวลา แต่เป็นงานรายวัน)

import { paymentInstructionsIndex } from "./salesDecisionGuard.mjs";

export const BANK_SENT_ACTIONS = Object.freeze(["bank_sent_info_continues", "ai_off_bank_sent"]);
const DELIVERED_ACTIONS = Object.freeze([...BANK_SENT_ACTIONS, "payment_step_composed"]);

export function createPaymentStepDbMethods({ all, get }) {
  return {
    /**
     * ห้องนี้เคยได้ช่องทางชำระแล้วหรือยัง — ดูทั้งห้อง ไม่ใช่แค่หน้าต่างประวัติของเทิร์น (ผลตรวจโค้ด 18 ต.ค.)
     * audit ส่งบัญชี/ตัวประกอบส่ง หรือข้อความขาออกที่มีบล็อกบัญชีจริง (AI หรือทีม) หรือรูปช่องทางชำระ
     */
    paymentDeliveredEvidence(customerId, untilMs = Number.MAX_SAFE_INTEGER) {
      const marks = DELIVERED_ACTIONS.map(() => "?").join(", ");
      if (get(`SELECT 1 AS hit FROM admin_audit WHERE target = ? AND created_at <= ? AND action IN (${marks}) LIMIT 1`,
        String(customerId), Number(untilMs) || Number.MAX_SAFE_INTEGER, ...DELIVERED_ACTIONS)) return true;
      const rows = all(
        `SELECT content FROM messages WHERE customer_id = ? AND direction = 'out' AND created_at <= ?
            AND (content LIKE '%บัญชี%' OR content LIKE '%พร้อมเพย์%' OR content LIKE '%payment-%')
          ORDER BY created_at DESC LIMIT 200`,
        String(customerId), Number(untilMs) || Number.MAX_SAFE_INTEGER,
      );
      return rows.some((row) => paymentInstructionsIndex(String(row.content || "")) >= 0 || /\[image:payment[a-z0-9_-]*\]/iu.test(String(row.content || "")));
    },

    /** ข้อความขาออก (AI/ทีม) ที่อาจเป็นคำถามประเภทเอกสาร — ตัวจับละเอียดอยู่ใน paymentStep.botAskedDocType */
    listDocTypeAskCandidates(sinceMs) {
      return all(
        `SELECT m.id, m.customer_id, m.content, m.created_at, c.display_name, c.known_name
           FROM messages m LEFT JOIN customers c ON c.line_user_id = m.customer_id
          WHERE m.direction = 'out' AND m.created_at >= ?
            AND (m.content LIKE '%บุคคล%' OR m.content LIKE '%บริษัท%')
          ORDER BY m.created_at`,
        Number(sinceMs) || 0,
      );
    },

    /** ข้อความของห้องหลังเวลาหนึ่ง (ทั้งสองทิศ เรียงตามเวลา) */
    listMessagesAfter(customerId, afterMs, limit = 40) {
      return all(
        `SELECT direction, content, created_at FROM messages
          WHERE customer_id = ? AND created_at > ? ORDER BY created_at LIMIT ?`,
        String(customerId), Number(afterMs) || 0, Math.max(1, Math.min(200, Number(limit) || 40)),
      );
    },

    /** จำนวนครั้งที่ระบบบันทึกว่าบล็อกบัญชีถึงมือลูกค้า (ทั้งเส้นด่านเงินเปิด/ปิด) ในช่วง [sinceMs, untilMs] */
    countBankSentSince(sinceMs, untilMs = Number.MAX_SAFE_INTEGER) {
      const marks = BANK_SENT_ACTIONS.map(() => "?").join(", ");
      const row = get(`SELECT COUNT(*) AS n FROM admin_audit WHERE created_at >= ? AND created_at <= ? AND action IN (${marks})`,
        Number(sinceMs) || 0, Number(untilMs) || Number.MAX_SAFE_INTEGER, ...BANK_SENT_ACTIONS);
      return Number(row?.n) || 0;
    },
  };
}
