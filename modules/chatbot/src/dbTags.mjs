// dbTags.mjs — เมธอด DB ของระบบ chat tag (v1.1 item 7) — แยกไฟล์คุม db.mjs <800 บรรทัด
// ตาราง customer_tags อยู่ใน schema.mjs; ตัวคำนวณ RFM + กติกา prompt อยู่ tags.mjs
//
// source มี 3 ชั้น — กติกาการเขียนทับต่างกัน:
// - 'rfm'   : ระบบคำนวณจากออเดอร์จริง — recompute = ลบชุดเก่าทั้ง source แล้วเขียนใหม่
// - 'ai'    : scorer อ่าน intent จากบทสนทนา — refresh แบบเดียวกับ rfm (อ่านสด ไม่สะสมขยะ)
// - 'human' : แอดมินติดเอง — ระบบห้ามลบ/ห้ามทับเด็ดขาด ลบได้จากมือคนใน console เท่านั้น

export const TAG_MAX_LENGTH = 60;
export const TAG_SOURCES = Object.freeze(["rfm", "ai", "human"]);

// v1.4.50 (บั๊กจริง 2026-08-30): ป้ายบางใบเป็น "บันทึกเหตุการณ์ที่เกิดขึ้นแล้ว" ไม่ใช่ความเห็นสด
// ของ scorer — รีเฟรชป้าย intent จึงห้ามล้างทิ้ง ต่อให้ source เป็น 'ai' เหมือนกัน
// เคสที่พัง: บอทส่งลิงก์คลาสฟรี -> ติดป้าย (source=ai) -> scorer ยิงต่อในเทิร์นเดียวกัน
// (pipeline.mjs:2119 -> 1131) -> ป้ายหายเกลี้ยง -> FU ไม่เคยเงียบจริงในเส้นทางบอท
// ซึ่งเป็นเส้นทางหลักที่เจ้าของสั่งไว้ ผลคือตาม FU ทับของขวัญที่เพิ่งให้ไปเมื่อกี้
export const STICKY_AUTO_TAGS = Object.freeze(["คลาสฟรี"]);

export const normalizeTag = (tag) => String(tag || "").trim().replace(/\s+/g, " ").slice(0, TAG_MAX_LENGTH);

export function createTagDbMethods({ run, all, get, now }) {
  // v1.4.9c: mark ว่า tag ของลูกค้าคนนี้เปลี่ยน — รอบ sync กลางคืนแตะเฉพาะห้องที่ dirty
  const markTagsDirty = (customerId) => {
    run("UPDATE customers SET tags_dirty_at = ? WHERE line_user_id = ?", now(), String(customerId));
  };
  return {
    listTags(customerId) {
      return all(
        `SELECT tag, source, created_at FROM customer_tags WHERE customer_id = ?
         ORDER BY CASE source WHEN 'human' THEN 0 WHEN 'rfm' THEN 1 ELSE 2 END, created_at ASC`,
        String(customerId)
      );
    },

    addTag(customerId, tag, source = "human") {
      const clean = normalizeTag(tag);
      if (!clean || !TAG_SOURCES.includes(source)) return false;
      // ป้ายซ้ำ = อัปเดต source ไม่ได้ (ป้ายคนติดไว้ห้ามโดนระบบ downgrade) — IGNORE พอ
      const changed = run(
        "INSERT OR IGNORE INTO customer_tags (customer_id, tag, source, created_at) VALUES (?, ?, ?, ?)",
        String(customerId), clean, source, now()
      ).changes === 1;
      if (changed) markTagsDirty(customerId);
      return changed;
    },

    removeTag(customerId, tag) {
      const changed = run(
        "DELETE FROM customer_tags WHERE customer_id = ? AND tag = ?",
        String(customerId), normalizeTag(tag)
      ).changes === 1;
      if (changed) markTagsDirty(customerId);
      return changed;
    },

    // เขียนทับป้ายทั้งชุดของ source ระบบ ('rfm'/'ai') — ห้ามใช้กับ 'human' เด็ดขาด
    replaceSourceTags(customerId, source, tags = []) {
      if (source !== "rfm" && source !== "ai") return false;
      // v1.4.9c (แก้ dirty churn ตามรีวิว 2026-08-17): scorer/RFM เรียกทุกเทิร์น — mark dirty
      // เฉพาะเมื่อ "ชุด tag เปลี่ยนจริง" ไม่งั้น sync กลางคืนจะปั่นทุกคนทุกวันโดยไม่มีอะไรเปลี่ยน
      // ป้ายบันทึกเหตุการณ์ (STICKY_AUTO_TAGS) อยู่นอกชุดที่ scorer/RFM เป็นเจ้าของ
      // จึงต้องหลุดทั้งจากการนับ before/after และจากคำสั่งลบ ไม่งั้นทั้งหายและทั้งนับ dirty ผิด
      const keepOut = STICKY_AUTO_TAGS.length
        ? ` AND tag NOT IN (${STICKY_AUTO_TAGS.map(() => "?").join(", ")})`
        : "";
      const before = all(
        `SELECT tag FROM customer_tags WHERE customer_id = ? AND source = ?${keepOut} ORDER BY tag`,
        String(customerId), source, ...STICKY_AUTO_TAGS
      ).map((r) => r.tag);
      run(
        `DELETE FROM customer_tags WHERE customer_id = ? AND source = ?${keepOut}`,
        String(customerId), source, ...STICKY_AUTO_TAGS
      );
      const t = now();
      const inserted = [];
      // ป้ายที่คน/ระบบอื่นติดไว้แล้วชื่อชนกัน = IGNORE (unique ต่อ customer+tag)
      for (const tag of tags) {
        const clean = normalizeTag(tag);
        if (!clean) continue;
        const res = run(
          "INSERT OR IGNORE INTO customer_tags (customer_id, tag, source, created_at) VALUES (?, ?, ?, ?)",
          String(customerId), clean, source, t
        );
        if (res.changes === 1) inserted.push(clean);
      }
      const after = inserted.sort();
      const changed = before.length !== after.length || before.some((tag, i) => tag !== after[i]);
      if (changed) markTagsDirty(customerId);
      return true;
    },

    /* ---------- v1.4.9c: ทะเบียน tag มาตรฐาน + สถานะ sync (พี่ง้วงอนุมัติ 2026-08-17) ---------- */

    upsertTagRegistry({ canonicalKey, displayName = "", tagGroup = "", sourceDefault = "human", syncToLine = false, lineTagId = null, lineBotId = "", color = "", active = true }) {
      const key = normalizeTag(canonicalKey);
      if (!key) return false;
      run(
        `INSERT INTO tag_registry (canonical_key, display_name, tag_group, source_default, sync_to_line, line_tag_id, line_bot_id, color, active, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(canonical_key) DO UPDATE SET
           display_name = excluded.display_name, tag_group = excluded.tag_group,
           source_default = excluded.source_default, sync_to_line = excluded.sync_to_line,
           line_tag_id = excluded.line_tag_id, line_bot_id = excluded.line_bot_id,
           color = excluded.color, active = excluded.active, updated_at = excluded.updated_at`,
        key, String(displayName), String(tagGroup), String(sourceDefault),
        syncToLine ? 1 : 0, lineTagId == null ? null : String(lineTagId),
        String(lineBotId), String(color), active ? 1 : 0, now()
      );
      return true;
    },

    listTagRegistry({ lineBotId = null, syncableOnly = false } = {}) {
      const where = [];
      const params = [];
      if (lineBotId != null) { where.push("(line_bot_id = ? OR line_bot_id = '')"); params.push(String(lineBotId)); }
      if (syncableOnly) where.push("sync_to_line = 1 AND line_tag_id IS NOT NULL AND active = 1");
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return all(`SELECT * FROM tag_registry ${clause} ORDER BY tag_group, canonical_key`, ...params);
    },

    getTagSyncState(customerId, lineBotId = "") {
      return get(
        "SELECT * FROM tag_sync_state WHERE customer_id = ? AND line_bot_id = ?",
        String(customerId), String(lineBotId)
      ) || null;
    },

    saveTagSyncState({ customerId, lineBotId = "", lastPushedHash = "", lastPushedIds = null, lastError = "" }) {
      // ถ้าไม่ส่ง lastPushedIds มา = คงของเดิม (กรณี error ที่ไม่ได้ push จริง)
      const prev = lastPushedIds == null
        ? (this.getTagSyncState(customerId, lineBotId)?.last_pushed_ids || "[]")
        : JSON.stringify([...new Set((lastPushedIds || []).map(String))].sort());
      run(
        `INSERT INTO tag_sync_state (customer_id, line_bot_id, last_pushed_hash, last_pushed_ids, last_synced_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(customer_id, line_bot_id) DO UPDATE SET
           last_pushed_hash = excluded.last_pushed_hash, last_pushed_ids = excluded.last_pushed_ids,
           last_synced_at = excluded.last_synced_at, last_error = excluded.last_error`,
        String(customerId), String(lineBotId), String(lastPushedHash), prev, now(), String(lastError)
      );
      return true;
    },

    // ลูกค้าที่ tag เปลี่ยนตั้งแต่รอบ sync ก่อน (dirty) — รอบกลางคืนดึงเฉพาะกลุ่มนี้
    listTagDirtyCustomers({ channel = null, limit = 2000 } = {}) {
      const params = [];
      let chWhere = "";
      if (channel) { chWhere = " AND channel_id = ?"; params.push(String(channel)); }
      return all(
        `SELECT line_user_id, channel_id, tags_dirty_at FROM customers
         WHERE tags_dirty_at IS NOT NULL AND tags_dirty_at > 0
           AND line_user_id NOT LIKE 'canary:%'${chWhere}
         ORDER BY tags_dirty_at ASC LIMIT ?`,
        ...params, Math.min(5000, Math.max(1, Number(limit) || 2000))
      );
    },

    // compare-and-clear (แก้ lost-update ตามรีวิว 2026-08-17): ล้าง dirty เฉพาะเมื่อค่า
    // ยังเป็นค่าเดียวกับตอน sync อ่าน snapshot — ถ้ามีการเปลี่ยน tag ใหม่ระหว่าง sync
    // (RFM/scorer/แอดมิน) ค่าจะต่าง แล้ว dirty จะไม่ถูกล้าง (รอบหน้า sync ต่อ)
    clearTagsDirty(customerId, expectedDirtyAt = null) {
      if (expectedDirtyAt == null) {
        run("UPDATE customers SET tags_dirty_at = NULL WHERE line_user_id = ?", String(customerId));
      } else {
        run("UPDATE customers SET tags_dirty_at = NULL WHERE line_user_id = ? AND tags_dirty_at = ?",
          String(customerId), Number(expectedDirtyAt));
      }
      return true;
    },

    // สำหรับต่อยอด broadcast: ลูกค้าทุกคนที่มีป้ายนี้ (กรองสาขาได้)
    listCustomersByTag(tag, { channel = null, limit = 500 } = {}) {
      const params = [normalizeTag(tag)];
      let chWhere = "";
      if (channel) {
        chWhere = " AND c.channel_id = ?";
        params.push(String(channel));
      }
      return all(
        `SELECT c.line_user_id, c.display_name, c.known_name, c.channel_id, t.source
         FROM customer_tags t JOIN customers c ON c.line_user_id = t.customer_id
         WHERE t.tag = ? AND c.line_user_id NOT LIKE 'canary:%'${chWhere}
         ORDER BY c.updated_at DESC LIMIT ?`,
        ...params, Math.min(2000, Math.max(1, Number(limit) || 500))
      );
    },

    // ป้ายทั้งหมดพร้อมจำนวนลูกค้า — หน้า broadcast/ภาพรวมใช้เลือก segment
    // REVIEW FIX v1.2: GROUP BY tag อย่างเดียว (ป้ายชื่อเดียวกันคนละ source = ชิปเดียว
    // ตัวเลขไม่เบิ้ล) — source ที่โชว์เลือกตัวลำดับสูงสุด human > rfm > ai
    tagSummary({ channel = null, limit = 100 } = {}) {
      const params = [];
      let chWhere = "";
      if (channel) {
        chWhere = " AND c.channel_id = ?";
        params.push(String(channel));
      }
      return all(
        `SELECT t.tag,
                CASE MIN(CASE t.source WHEN 'human' THEN 0 WHEN 'rfm' THEN 1 ELSE 2 END)
                  WHEN 0 THEN 'human' WHEN 1 THEN 'rfm' ELSE 'ai' END AS source,
                COUNT(DISTINCT t.customer_id) AS customer_count
         FROM customer_tags t JOIN customers c ON c.line_user_id = t.customer_id
         WHERE c.line_user_id NOT LIKE 'canary:%'
           AND c.do_not_disturb = 0
           AND c.marketing_consent >= 0${chWhere}
         GROUP BY t.tag ORDER BY customer_count DESC, t.tag ASC LIMIT ?`,
        ...params, Math.min(500, Math.max(1, Number(limit) || 100))
      );
    },
  };
}
