// dbOwnerChat.mjs — ทางอ่าน/เขียนของ "คุยกับลูกแพร" ทาง Telegram (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//
// พี่ง้วงขอ: "ช่วยให้ลูกแพร telegram มีสมอง และสามารถคุยกับพี่ง้วง เป็นเหมือนลูกแพรจริงๆเลย"
// ไฟล์นี้มีสองส่วน (แยกจาก db.mjs ตามแบบแผน dbYolo.mjs — คุมขนาดไฟล์หลัก):
//   1) ความจำของแชทเจ้าของ (ตาราง owner_chat_turns — ใหม่ เติมอย่างเดียว)
//      เก็บเป็น "คู่" (พี่ง้วงพิมพ์ + ลูกแพรตอบ) ด้วย exchange_id เดียวกัน ลบก็ลบทั้งคู่ ประวัติจึงไม่เหลือ
//      คำตอบลอย ๆ ที่ไม่มีคำถาม · เก็บไม่เกิน 200 เทิร์นและ 30 วัน ตัดเองทั้งตอนเขียนและตอนอ่าน
//      (งาน retention รายวันอาจปิดอยู่ — ความจำนี้ต้องหมดอายุเองโดยไม่พึ่งใคร)
//   2) คิวรีอ่านอย่างเดียวของ "ข้อมูลสด" (ownerChatSnapshot.mjs): กิจกรรมวันนี้ · ลีดร้อน · สิ่งที่สั่งล่าสุด
//      ทุกตัวเลขเป็น SQL ตรง ๆ ตัด canary เสมอ — ลูกแพรพูดตัวเลขกับเจ้าของได้เฉพาะที่มาจากตรงนี้
//
// ตารางนี้ไม่มีคอลัมน์ customer_id/message_id โดยเจตนา (ไม่ใช่ข้อมูลรายลูกค้า) แต่ข้อความที่พี่ง้วงพิมพ์
// อาจมีชื่อลูกค้า — สิทธิ์ให้ลืมจึงกวาดเทิร์นที่เอ่ยชื่อเต็มของคนนั้นด้วย (forgetOwnerChatMentions)
import { randomUUID } from "node:crypto";
import { NON_HUMAN_NOTE_AUTHORS_SQL } from "./lineOaContext.mjs";
import { customerNameForms } from "./ownerChatText.mjs";

export const OWNER_CHAT_KEEP_TURNS = 200;
export const OWNER_CHAT_KEEP_DAYS = 30;
export const OWNER_CHAT_TURN_MAX_CHARS = 4000;
const OWNER_CHAT_READ_MAX = 40;
const DAY_MS = 86_400_000;
const escapeLike = (value) => String(value).replace(/[\\%_]/gu, (ch) => `\\${ch}`);
const clip = (value) => [...String(value ?? "")].slice(0, OWNER_CHAT_TURN_MAX_CHARS).join("");

// ห้องที่ย้ายมาจาก LINE OA เดิมแล้วถูกโยงกับห้องใหม่ = สำเนาของลูกค้าคนเดียวกัน (กติกาเดียวกับ dbAttention.mjs)
const NOT_LINKED_LEGACY_COPY = `NOT (
  EXISTS (SELECT 1 FROM customer_tags legacy_tag
          WHERE legacy_tag.customer_id = c.line_user_id AND legacy_tag.tag = 'ย้ายจาก LINE OA')
  AND EXISTS (SELECT 1 FROM customers linked_customer
              WHERE linked_customer.legacy_link = 'linked:' || c.line_user_id)
)`;
// ใครส่งข้อความขาออก — กติกาเดียวกับ kpi.senderOf (agent_mode ใหม่ · operator ของแถวเก่า)
const AI_OUT = "m.agent_mode = 'ai'";
const HUMAN_OUT = `(m.agent_mode LIKE 'operator%'
  OR (m.agent_mode IS NULL AND m.operator NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})))`;
// การกระทำที่ลูกแพรควรรู้ว่าเพิ่งเกิด: YOLO ทุกช่องทาง + ทุกอย่างที่สั่งผ่าน Telegram
const ACTION_WHERE = `(action IN ('yolo_sent', 'yolo_partial', 'yolo_refused')
  OR (operator LIKE 'telegram:%' AND action IN ('ai_toggle', 'lesson_saved', 'lesson_proposed')))`;

export function createOwnerChatDbMethods({ run, all, get, now }) {
  const cutoff = () => now() - OWNER_CHAT_KEEP_DAYS * DAY_MS;

  function pruneOwnerChatTurns() {
    let removed = run("DELETE FROM owner_chat_turns WHERE created_at < ?", cutoff()).changes;
    removed += run(
      `DELETE FROM owner_chat_turns WHERE rowid NOT IN (
         SELECT rowid FROM owner_chat_turns ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      OWNER_CHAT_KEEP_TURNS,
    ).changes;
    return removed;
  }

  return {
    pruneOwnerChatTurns,

    // หนึ่งคู่ = หนึ่ง exchange_id · เวลาเดียวกัน ลำดับตาม rowid (พิมพ์ก่อน ตอบทีหลัง)
    addOwnerChatExchange({ ownerRef, userText, assistantText }) {
      const ref = String(ownerRef || "");
      if (!ref) throw new Error("owner chat needs an owner reference");
      const exchange = randomUUID();
      const t = now();
      for (const [role, content] of [["user", userText], ["assistant", assistantText]]) {
        run(
          `INSERT INTO owner_chat_turns (id, exchange_id, owner_ref, role, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          randomUUID(), exchange, ref, role, clip(content), t,
        );
      }
      pruneOwnerChatTurns();
      return exchange;
    },

    // เทิร์นล่าสุดของเจ้าของคนนี้ เรียงเก่า -> ใหม่ (รูปเดียวกับ history ที่ส่งเข้าโมเดล)
    recentOwnerChatTurns(ownerRef, { limit = 20 } = {}) {
      const ref = String(ownerRef || "");
      if (!ref) return [];
      pruneOwnerChatTurns();
      const size = Math.min(OWNER_CHAT_READ_MAX, Math.max(1, Math.trunc(Number(limit)) || 20));
      return all(
        `SELECT role, content, created_at FROM owner_chat_turns
          WHERE owner_ref = ? AND created_at >= ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        ref, cutoff(), size,
      ).reverse().map((row) => ({ role: row.role, content: String(row.content || ""), createdAt: Number(row.created_at) || 0 }));
    },

    // สิทธิ์ให้ลืม (resetCustomer forget): คู่ข้อความที่เอ่ยชื่อของคนนั้นหายทั้งคู่ — ทุกรูปที่แชทนี้ใช้เรียก
    // (ชื่อเต็ม · ตัด "คุณ" · ชื่อต้น — พี่ง้วงพิมพ์แค่ "คุณสมชาย" บ่อยกว่าชื่อเต็ม: code review 28 ก.ย.)
    // รูปที่สั้นกว่า 3 ตัวไม่กวาด ("เอ" อยู่ใน "เอไอ") — ไม่กวาดดีกว่ากวาดผิดทั้งประวัติ
    forgetOwnerChatMentions(names = []) {
      let removed = 0;
      for (const name of customerNameForms(Array.isArray(names) ? names : [])) {
        removed += run(
          `DELETE FROM owner_chat_turns WHERE exchange_id IN (
             SELECT exchange_id FROM owner_chat_turns WHERE content LIKE ? ESCAPE '\\')`,
          `%${escapeLike(name)}%`,
        ).changes;
      }
      return removed;
    },

    /* ------------------------- ข้อมูลสด (อ่านอย่างเดียว) ------------------------- */

    // กิจกรรมตั้งแต่ต้นวัน (เวลาไทย) — นับเป็น "ห้อง" ไม่ใช่บอลลูน (คำตอบหนึ่งครั้งแตกหลายบอลลูนได้)
    ownerChatActivity(dayStartMs) {
      const since = Number(dayStartMs) || 0;
      const inbound = get(
        `SELECT COUNT(DISTINCT customer_id) AS rooms, COUNT(*) AS messages FROM messages
          WHERE direction = 'in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'`,
        since,
      ) || {};
      // ทักครั้งแรกในชีวิต = ไม่มีข้อความขาเข้าก่อนวันนี้เลย (ไม่ใช้ customers.created_at เพราะห้อง
      // ที่นำเข้าจาก LINE OA เดิมมีเวลาสร้างเป็นวันนำเข้า ไม่ใช่วันที่ลูกค้าทักจริง)
      const first = get(
        // "+customer_id" = ให้ตัววางแผนใช้ idx_messages_time (เฉพาะข้อความวันนี้) แทนการไล่ทั้งตาราง
        // ผ่าน idx_messages_customer เพื่อทำ DISTINCT (ตรวจด้วย EXPLAIN QUERY PLAN 28 ก.ย.)
        `SELECT COUNT(*) AS n FROM (SELECT DISTINCT +customer_id AS cid FROM messages
           WHERE direction = 'in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%') t
          WHERE NOT EXISTS (SELECT 1 FROM messages p
            WHERE p.customer_id = t.cid AND p.direction = 'in' AND p.created_at < ?)`,
        since, since,
      ) || {};
      const out = get(
        `SELECT
           COUNT(DISTINCT CASE WHEN ${AI_OUT} AND m.message_class = 'reactive' THEN m.customer_id END) AS ai_rooms,
           COUNT(DISTINCT CASE WHEN ${HUMAN_OUT} AND m.message_class = 'reactive' THEN m.customer_id END) AS human_rooms,
           COUNT(DISTINCT CASE WHEN ${AI_OUT} AND m.message_class = 'proactive' THEN m.customer_id END) AS proactive_rooms
         FROM messages m
         WHERE m.direction = 'out' AND m.created_at >= ? AND m.customer_id NOT LIKE 'canary:%'`,
        since,
      ) || {};
      const needs = get(
        "SELECT COUNT(*) AS n FROM customers WHERE state = 'NEEDS_HUMAN' AND line_user_id NOT LIKE 'canary:%'",
      ) || {};
      return {
        inboundRooms: Number(inbound.rooms) || 0,
        inboundMessages: Number(inbound.messages) || 0,
        firstTimeRooms: Number(first.n) || 0,
        aiRooms: Number(out.ai_rooms) || 0,
        humanRooms: Number(out.human_rooms) || 0,
        proactiveRooms: Number(out.proactive_rooms) || 0,
        needsHuman: Number(needs.n) || 0,
      };
    },

    // ลีดคะแนนสูงที่ยังคุยกันอยู่ (มีข้อความใน sinceMs) — ไม่เอาห้องที่เป็นลูกค้าแล้ว/ปิดดีลแล้ว/สำเนาห้องเก่า
    ownerChatHotLeads({ sinceMs = 0, minScore = 5, limit = 5 } = {}) {
      return all(
        `SELECT * FROM (
           SELECT c.line_user_id, c.display_name, c.known_name, c.channel_id, c.last_score, c.ai_enabled,
                  c.ai_off_reason, c.state, c.deal_status, c.money_seen_at,
                  (SELECT m.created_at FROM messages m WHERE m.customer_id = c.line_user_id
                    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_at,
                  (SELECT m.direction FROM messages m WHERE m.customer_id = c.line_user_id
                    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_dir,
                  (SELECT m.agent_mode FROM messages m WHERE m.customer_id = c.line_user_id
                    ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_agent_mode,
                  EXISTS (SELECT 1 FROM messages m WHERE m.customer_id = c.line_user_id
                    AND m.direction = 'out' AND ${HUMAN_OUT}) AS human_touched
           FROM customers c
           WHERE c.last_score >= ? AND c.line_user_id NOT LIKE 'canary:%'
             AND COALESCE(c.state, '') != 'RESOLVED'
             AND COALESCE(c.deal_status, '') NOT IN ('paid', 'won', 'paid_confirmed', 'prep_sent')
             AND NOT EXISTS (SELECT 1 FROM customer_tags st
                   WHERE st.customer_id = c.line_user_id AND lower(st.tag) IN ('customer', 'null'))
             AND ${NOT_LINKED_LEGACY_COPY}
         ) h
         WHERE h.last_at IS NOT NULL AND h.last_at >= ?
         ORDER BY h.last_score DESC, h.last_at DESC
         LIMIT ?`,
        Math.trunc(Number(minScore)) || 5, Number(sinceMs) || 0, Math.min(20, Math.max(1, Math.trunc(Number(limit)) || 5)),
      );
    },

    // สิ่งที่เพิ่งสั่ง (YOLO ทุกช่องทาง + Telegram) ใหม่สุดก่อน — รายละเอียดเป็นของที่ audit จดไว้แล้ว
    ownerChatRecentActions({ sinceMs = 0, limit = 5 } = {}) {
      return all(
        `SELECT operator, action, target, detail, created_at FROM admin_audit
          WHERE created_at >= ? AND ${ACTION_WHERE}
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        Number(sinceMs) || 0, Math.min(20, Math.max(1, Math.trunc(Number(limit)) || 5)),
      );
    },
  };
}
