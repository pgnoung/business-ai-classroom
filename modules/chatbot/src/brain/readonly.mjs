// brain/readonly.mjs — เปิดฐานแบบ "อ่านอย่างเดียวจริง ๆ" สำหรับรายงานและการซ้อม
//
// openDb() ของ chassis ไม่ใช่ทางอ่าน: มันรัน SCHEMA, ensureColumn (ALTER TABLE), migration
// และตั้ง PRAGMA — เรียกครั้งเดียวก็เปลี่ยนไฟล์แล้ว การให้เครื่องมือ "รายงาน" กับ
// "ซ้อมโดยไม่เขียน" ใช้ทางนั้น แปลว่าคำสัญญา "ไม่เขียนอะไร" เป็นเท็จตั้งแต่บรรทัดแรก
// และบนฐาน production มันคือการแก้สคีมาโดยไม่ได้ตั้งใจจากคำสั่งที่คนคิดว่าปลอดภัย
//
// ที่นี่จึงเปิดด้วย readOnly: true แล้วประกอบเฉพาะเมธอด "อ่าน" ที่ตัวเทียบ parity และ
// ตัวอ่านแหล่งต้องใช้ ตารางที่ยังไม่มี (ฐานเก่าที่ยังไม่เคยมีสมอง) คืนค่าว่างแทนที่จะระเบิด
import { DatabaseSync } from "node:sqlite";

export function openBrainReadOnly(file) {
  const db = new DatabaseSync(String(file), { readOnly: true });
  const cache = new Map();
  const prep = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) { stmt = db.prepare(sql); cache.set(sql, stmt); }
    return stmt;
  };
  const get = (sql, ...params) => { try { return prep(sql).get(...params) ?? null; } catch { return null; } };
  const all = (sql, ...params) => { try { return prep(sql).all(...params); } catch { return []; } };

  return {
    raw: db,
    readOnly: true,

    getSetting(key) {
      return get("SELECT value FROM settings WHERE key = ?", String(key))?.value ?? null;
    },

    // เรียงเหมือน db.listActiveKnowledge ทุกตัวอักษร (created_at ASC, rowid ASC)
    listActiveKnowledge(channelId = null) {
      return channelId
        ? all(
            "SELECT * FROM knowledge_entries WHERE active = 1 AND deleted_at IS NULL AND channel_id = ? ORDER BY created_at ASC, rowid ASC",
            String(channelId),
          )
        : all("SELECT * FROM knowledge_entries WHERE active = 1 AND deleted_at IS NULL AND channel_id IS NULL ORDER BY created_at ASC, rowid ASC");
    },

    listKnowledge() {
      return all("SELECT * FROM knowledge_entries WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC");
    },

    approvedPrices() {
      return all("SELECT label, amount FROM approved_prices ORDER BY label");
    },

    /* ------------------------------ ฝั่งสมอง ------------------------------ */

    getBrainRev(revId) {
      return get("SELECT * FROM brain_item_revs WHERE rev_id = ?", String(revId));
    },

    listBrainRevs(revIds = []) {
      const out = [];
      for (const id of revIds) {
        const row = this.getBrainRev(id);
        if (row) out.push(row);
      }
      return out;
    },

    currentBrainRev(itemId) {
      return get(
        "SELECT * FROM brain_item_revs WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        String(itemId),
      );
    },

    getBrainVersion(versionId) {
      return get("SELECT * FROM brain_versions WHERE version_id = ?", String(versionId));
    },

    listBrainVersions(limit = 50) {
      return all("SELECT * FROM brain_versions ORDER BY seq DESC LIMIT ?", Math.min(500, Math.max(1, Number(limit) || 50)));
    },

    getBrainPointer(role = "live") {
      return get("SELECT * FROM brain_versions WHERE pointer = ?", String(role));
    },

    close() {
      try { db.close(); } catch { /* ปิดซ้ำ — ข้าม */ }
    },
  };
}
