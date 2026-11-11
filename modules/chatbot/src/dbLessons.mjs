// dbLessons.mjs — ทางอ่าน/เขียนเดียวของตาราง owner_lessons (แยกไฟล์คุมขนาด db.mjs)
//
// "สอนลูกแพรจากแผง 'ทำไมตอบแบบนี้'" (คำสั่งพี่ง้วง 2026-09-28): บทเรียนหนึ่งเรื่อง =
// คำลูกค้าที่นำไปสู่คำตอบ + คำตอบเดิมของลูกแพร + สิ่งที่คนสอน ตรรกะเลือก/ประกอบพรอมต์อยู่ที่
// src/ownerLessons.mjs · ด่านสิทธิ์/ความเป็นส่วนตัวอยู่ที่ src/consoleLessonsApi.mjs
// ไฟล์นี้ทำแค่ SQL — ไม่ตัดสินว่าใครทำอะไรได้ และไม่แตะข้อความให้สวยขึ้น
import { randomUUID } from "node:crypto";

export const LESSON_STATUSES = Object.freeze(["active", "pending", "disabled"]);
const STATUS_SET = new Set(LESSON_STATUSES);
// metadata ของข้อความเป็น JSON ที่เขียนโดยเรา แต่ยังอ่านแบบกันพัง: id ต้องหน้าตาเป็น id
const LESSON_ID = /^[A-Za-z0-9-]{1,80}$/u;
const escapeLike = (value) => String(value).replace(/[\\%_]/gu, (ch) => `\\${ch}`);

export function createLessonDbMethods({ run, all, get, now }) {
  return {
    addOwnerLesson({
      channelId = null, customerText = "", aiText = "", teaching, teachingKey, topic = "",
      sourceMessageId = "", customerId = "", status = "pending", createdBy = "",
    } = {}) {
      if (!STATUS_SET.has(status) || status === "disabled") throw new Error("invalid lesson status");
      const id = randomUUID();
      const t = now();
      const active = status === "active";
      run(
        `INSERT INTO owner_lessons
          (id, channel_id, customer_text, ai_text, teaching, teaching_key, topic, source_message_id,
           customer_id, status, created_by, decided_by, decided_at, use_count, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        id, channelId == null ? null : String(channelId), String(customerText), String(aiText),
        String(teaching), String(teachingKey), String(topic), String(sourceMessageId), String(customerId),
        status, String(createdBy), active ? String(createdBy) : "", active ? t : null, t, t,
      );
      return this.getOwnerLesson(id);
    },

    getOwnerLesson(id) {
      return get("SELECT * FROM owner_lessons WHERE id = ?", String(id)) ?? null;
    },

    // กันบันทึกซ้ำ: คำสอนเดียวกัน (หลังปรับรูป) ในช่องทางเดียวกัน = เรื่องเดียวกัน
    findOwnerLessonByKey(teachingKey, channelId = null) {
      return get(
        "SELECT * FROM owner_lessons WHERE teaching_key = ? AND IFNULL(channel_id, '') = ?",
        String(teachingKey), channelId == null ? "" : String(channelId),
      ) ?? null;
    },

    countOwnerLessonsTotal() {
      return Number(get("SELECT COUNT(*) AS n FROM owner_lessons")?.n || 0);
    },

    // viewer = null → เห็นทุกแถว (ผู้อนุมัติ) · viewer = username → เห็นที่ใช้อยู่ + ของตัวเอง
    // (เหตุผลเดียวกับคิวขออนุมัติ Package K: ทีมงานต้องรู้ว่าของที่ส่งค้างอยู่ไหม ไม่ใช่เห็นของทั้งร้าน)
    // เรียง "รออนุมัติ" ขึ้นก่อนเสมอ — เป็นของที่ต้องมีคนตัดสิน ที่เหลือใหม่สุดก่อน
    listOwnerLessons({ status = "", q = "", viewer = null, limit = 50, offset = 0 } = {}) {
      const wanted = STATUS_SET.has(status) ? status : "";
      const needle = String(q || "").trim().toLowerCase().slice(0, 80);
      const like = `%${escapeLike(needle)}%`;
      const size = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 50));
      const from = Math.max(0, Math.trunc(Number(offset)) || 0);
      const rows = all(
        `SELECT * FROM owner_lessons
          WHERE (? = '' OR status = ?)
            AND (? = 1 OR status = 'active' OR created_by = ?)
            AND (? = '' OR lower(teaching) LIKE ? ESCAPE '\\' OR lower(topic) LIKE ? ESCAPE '\\'
                 OR lower(customer_text) LIKE ? ESCAPE '\\')
          ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
        wanted, wanted, viewer == null ? 1 : 0, String(viewer ?? ""),
        needle, like, like, like, size + 1, from,
      );
      return { rows: rows.slice(0, size), hasMore: rows.length > size, offset: from };
    },

    countOwnerLessons({ viewer = null } = {}) {
      const counts = { all: 0, active: 0, pending: 0, disabled: 0 };
      for (const row of all(
        `SELECT status, COUNT(*) AS n FROM owner_lessons
          WHERE (? = 1 OR status = 'active' OR created_by = ?) GROUP BY status`,
        viewer == null ? 1 : 0, String(viewer ?? ""),
      )) {
        counts[row.status] = Number(row.n) || 0;
        counts.all += Number(row.n) || 0;
      }
      return counts;
    },

    updateOwnerLesson(id, { teaching, teachingKey, topic, channelId }) {
      return run(
        `UPDATE owner_lessons SET teaching = ?, teaching_key = ?, topic = ?, channel_id = ?, updated_at = ?
          WHERE id = ?`,
        String(teaching), String(teachingKey), String(topic),
        channelId == null ? null : String(channelId), now(), String(id),
      ).changes === 1;
    },

    // อนุมัติ = เริ่มนับเป็น "เรื่องล่าสุด" ตั้งแต่วินาทีนี้ (เหมือนน้องเก้า — ของที่เพิ่งผ่านต้องเห็นผลก่อน)
    approveOwnerLesson(id, by) {
      const t = now();
      return run(
        `UPDATE owner_lessons SET status = 'active', decided_by = ?, decided_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
        String(by), t, t, String(id),
      ).changes === 1;
    },

    // เปิด/ปิดใช้ ไม่ใช่การอนุมัติ — แถวที่ยังรออนุมัติต้องผ่าน approveOwnerLesson เท่านั้น
    setOwnerLessonEnabled(id, enabled, by) {
      const t = now();
      return enabled
        ? run(
          `UPDATE owner_lessons SET status = 'active', decided_by = CASE WHEN decided_at IS NULL THEN ? ELSE decided_by END,
              decided_at = COALESCE(decided_at, ?), updated_at = ?
            WHERE id = ? AND status = 'disabled'`,
          String(by), t, t, String(id),
        ).changes === 1
        : run(
          "UPDATE owner_lessons SET status = 'disabled', updated_at = ? WHERE id = ? AND status = 'active'",
          t, String(id),
        ).changes === 1;
    },

    // คำสอนซ้ำของทีมงานกับเรื่องที่เจ้าของปิดไว้ = ส่งกลับเข้าคิวให้เจ้าของตัดสินใหม่
    // คำขอรอบใหม่เป็นของคนที่ส่งล่าสุด — ไม่งั้นเขามองไม่เห็นและถอนคำขอของตัวเองไม่ได้ (รีวิว 2026-09-28)
    requeueOwnerLesson(id, by) {
      return run(
        `UPDATE owner_lessons SET status = 'pending', created_by = ?, decided_by = '', decided_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'disabled'`,
        String(by), now(), String(id),
      ).changes === 1;
    },

    // คิวรออนุมัติ เก่าสุดก่อน — สรุปบทเรียนรายวันทาง Telegram (เรื่องที่รอนานสุดต้องได้ตัดสินก่อน)
    pendingOwnerLessonsOldest(limit = 10) {
      return all(
        "SELECT * FROM owner_lessons WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT ?",
        Math.min(50, Math.max(1, Math.trunc(Number(limit)) || 10)),
      );
    },

    deleteOwnerLesson(id) {
      return run("DELETE FROM owner_lessons WHERE id = ?", String(id)).changes === 1;
    },

    // ชุดที่ตัวเลือกบทเรียนตอนร่างใช้ — ใหม่สุดก่อน (อนุมัติล่าสุด) เพดานกันห้องที่สอนไว้เยอะมาก
    activeOwnerLessons(channelId = "default", limit = 300) {
      return all(
        `SELECT * FROM owner_lessons
          WHERE status = 'active' AND (channel_id IS NULL OR channel_id = ?)
          ORDER BY decided_at DESC, created_at DESC, rowid DESC LIMIT ?`,
        String(channelId || "default"), Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || 300)),
      );
    },

    ownerLessonsByIds(ids = []) {
      const out = [];
      for (const id of [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 20)) {
        const row = LESSON_ID.test(id) ? this.getOwnerLesson(id) : null;
        out.push(row ?? { id, missing: true });
      }
      return out;
    },

    // นับเฉพาะเทิร์นที่ส่งถึงลูกค้าจริง (ผู้เรียกอยู่หลัง sendResult.ok) — ไม่ใช่ทุกครั้งที่ร่าง
    bumpOwnerLessonUse(ids = []) {
      const t = now();
      let bumped = 0;
      for (const id of [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 20)) {
        bumped += run(
          "UPDATE owner_lessons SET use_count = use_count + 1, last_used_at = ? WHERE id = ?", t, id,
        ).changes;
      }
      return bumped;
    },

    // ข้อความลูกค้าที่ "นำไปสู่" คำตอบนี้ = ข้อความขาเข้าหลังคำตอบรอบก่อน จนถึงคำตอบนี้
    // คำตอบหนึ่งรอบมักมีหลายฟอง จึงหาขอบจาก "ขาออกที่เก่ากว่าข้อความลูกค้าล่าสุด" ไม่ใช่ฟองก่อนหน้า
    // (สอนจากฟองที่สองของคำตอบเดียวกัน ต้องได้คำถามเดียวกับฟองแรก)
    lessonSourceTurns(message, limit = 3) {
      const customerId = String(message?.customer_id || "");
      const at = Number(message?.created_at) || 0;
      if (!customerId || !at) return [];
      const lastIn = get(
        `SELECT created_at FROM messages WHERE customer_id = ? AND direction = 'in' AND created_at <= ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        customerId, at,
      );
      if (!lastIn) return [];
      const prevOut = Number(get(
        "SELECT MAX(created_at) AS at FROM messages WHERE customer_id = ? AND direction = 'out' AND created_at < ?",
        customerId, Number(lastIn.created_at),
      )?.at || 0);
      return all(
        `SELECT msg_type, content FROM messages
          WHERE customer_id = ? AND direction = 'in' AND created_at > ? AND created_at <= ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        customerId, prevOut, at, Math.min(5, Math.max(1, Number(limit) || 3)),
      ).reverse();
    },

    // บทเรียนที่เทิร์นนี้ใช้ (pipeline จดไว้ใน metadata ตอนส่งสำเร็จ) — ใช้วาดแผง "ทำไมตอบแบบนี้"
    messageOwnerLessonIds(messageId) {
      const row = get("SELECT metadata_json FROM messages WHERE id = ?", String(messageId));
      let metadata = null;
      try { metadata = JSON.parse(String(row?.metadata_json || "{}")); } catch { metadata = null; }
      const ids = Array.isArray(metadata?.ownerLessons) ? metadata.ownerLessons : [];
      return [...new Set(ids.map(String).filter((id) => LESSON_ID.test(id)))].slice(0, 10);
    },

    ownerLessonsTaughtFrom(messageId) {
      if (!String(messageId || "")) return [];
      return all(
        "SELECT * FROM owner_lessons WHERE source_message_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5",
        String(messageId),
      );
    },

    // สิทธิ์ให้ลืม/ล้างประวัติ (resetCustomer เรียกก่อนลบ messages): คำสอนเป็นของธุรกิจ อยู่ต่อ
    // แต่คำพูดลูกค้า คำตอบเดิม และตัวชี้ห้องต้องหาย — เหมือน scrubTeachIdentity ของการ์ดความรู้
    // จับทั้งคอลัมน์ customer_id และตัวชี้ข้อความ เผื่อแถวที่ customer_id ถูกถอดไปก่อนแล้ว
    scrubOwnerLessonsForCustomer(customerId) {
      const id = String(customerId || "");
      if (!id) return 0;
      return run(
        `UPDATE owner_lessons SET customer_text = '', ai_text = '', customer_id = '', source_message_id = '',
            updated_at = ?
          WHERE customer_id = ?
             OR (source_message_id != '' AND source_message_id IN (SELECT id FROM messages WHERE customer_id = ?))`,
        now(), id, id,
      ).changes;
    },
  };
}
