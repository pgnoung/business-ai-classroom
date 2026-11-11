// brain/redactStore.mjs — ทางเขียนของ PDPA บนตารางสมอง (ลบเนื้อการ์ด + ทะเบียนการลบ)
//
// แยกออกจาก brain/store.mjs เพื่อคุมขนาดไฟล์ (< 400 บรรทัดตามกติกาของโมดูลสมอง)
// ยังเป็น "ทางเขียนเดียว" เหมือนเดิม: เมธอดถูกผสมเข้า object เดียวกับ store ตอนประกอบ db
// จึงเรียก this.getBrainRev ได้ตามปกติ และ append-only ยังถูกกันด้วย trigger ใน schema.mjs
import { stableJson } from "./text.mjs";

/**
 * @param {{run: Function, all: Function, now: Function, atomically: Function}} deps
 */
export function createBrainRedactionMethods({ run, all, now, atomically }) {
  return {
    // PDPA: ลบ "เนื้อ" ของ revision แล้วบันทึกไว้ — sha ต้นฉบับคงเดิม tree จึงไม่ขยับ
    // สองคำสั่งต้องอยู่ในธุรกรรมเดียว: ถ้าแถวทะเบียนไม่เกิด เราจะมี tombstone ที่ไม่มี
    // ใครรู้ว่าลบเพราะอะไร ซึ่งพิสูจน์การปฏิบัติตาม PDPA ไม่ได้
    redactBrainRev(revId, { customerHash = null, reason = "", at = null } = {}) {
      return atomically(() => {
        const row = this.getBrainRev(revId);
        if (!row || row.redacted === 1) return false;
        const when = Number(at ?? now());
        run(
          "UPDATE brain_item_revs SET redacted = 1, body_json = ? WHERE rev_id = ?",
          stableJson({ tombstone: true, reason: String(reason || "") }), String(revId),
        );
        run(
          `INSERT INTO redactions (rev_id, customer_hash, reason, redacted_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(rev_id) DO UPDATE SET
             customer_hash = excluded.customer_hash,
             reason = excluded.reason,
             redacted_at = excluded.redacted_at`,
          String(revId), customerHash ? String(customerHash) : null, String(reason || ""), when,
        );
        return true;
      });
    },

    // ลบร่องรอย "ที่มา" หลังจาก redact เนื้อไปแล้ว (customer_hash ใน provenance)
    // trigger อนุญาตเฉพาะกรณี redacted = 1 -> 1 และเปลี่ยนได้แค่ provenance_json
    scrubBrainRevProvenance(revId, provenance = {}) {
      const row = this.getBrainRev(revId);
      if (!row || row.redacted !== 1) return false;
      return run(
        "UPDATE brain_item_revs SET provenance_json = ? WHERE rev_id = ?",
        stableJson(provenance ?? {}), String(revId),
      ).changes === 1;
    },

    // การ์ดที่ถูกลบเนื้อตามคำขอลูกค้า — กล่องตรวจต้องรู้ว่ารุ่นที่ใช้อยู่ยังอ้างใบไหนอยู่บ้าง
    // (แบบแปลน §6 Step 4 ข้อ 7: การ์ดที่ถูก redact บังคับให้ต้องออกรุ่นใหม่)
    // จงใจไม่ select customer_hash: กล่องตรวจต้องรู้ว่า "การ์ดใบไหนถูกลบ" ไม่ใช่ "ของใคร"
    listBrainRedactions(limit = 50) {
      return all(
        `SELECT r.rev_id, r.reason, r.redacted_at, v.item_id, v.kind, v.key
           FROM redactions AS r JOIN brain_item_revs AS v ON v.rev_id = r.rev_id
          ORDER BY r.redacted_at DESC LIMIT ?`,
        Math.min(200, Math.max(1, Number(limit) || 50)),
      );
    },
  };
}
