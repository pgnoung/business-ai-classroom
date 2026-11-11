// dbYolo.mjs — คิวรีอ่านอย่างเดียวของ YOLO / คำสั่งเจ้าของทาง Telegram (2026-09-28)
//
// แยกไฟล์ตามแบบแผน dbProactiveAttempts.mjs (คุม db.mjs ไม่ให้โตเกิน) — ไม่มีตารางใหม่:
// การส่ง YOLO ใช้รั้ว proactive_attempts lane 'yolo' ตัวเดียวกับ follow-up ทุกเส้น
// เพดานความถี่จึงนับจากแถวรั้วนั้นตรง ๆ (ส่งจริง = sending/settled) ไม่ต้องมีบัญชีแยก

// ต้องตรงกับ LEGACY_SOURCE_TAG ใน legacyLink.mjs เป๊ะ (เทสต์ yolo-db ตรวจให้)
// ไม่ import ตรง ๆ เพราะ legacyLink.mjs import db.mjs อยู่แล้ว = วงจร import ตอนบูต
export const LEGACY_REFERENCE_TAG = "ย้ายจาก LINE OA";
export const YOLO_LANE = "yolo";

// ห้องที่ "สั่งงานได้": ห้องจริงที่ลูกค้าเคยทักเข้ามาอย่างน้อยหนึ่งครั้ง
// - ไม่เอา canary (ลูกค้าสังเคราะห์) และห้องอ้างอิงระบบเก่า (chat.line.biz คนละ namespace
//   กับ Messaging API — ส่งไปก็ไม่ถึงใคร เหตุผลเต็มอยู่หัวไฟล์ legacyLink.mjs)
// - ไม่เคยทักเข้ามา = ไม่ใช่บทสนทนา YOLO มีไว้ "คุยต่อ" ไม่ใช่เปิดบทสนทนาใหม่กับคนแปลกหน้า
const ROOM_WHERE = `c.line_user_id NOT LIKE 'canary:%'
  AND NOT EXISTS (SELECT 1 FROM customer_tags lt WHERE lt.customer_id = c.line_user_id AND lt.tag = ?)
  AND EXISTS (SELECT 1 FROM messages mi WHERE mi.customer_id = c.line_user_id AND mi.direction = 'in')`;

export function createYoloDbMethods({ all, get }) {
  return {
    // channel: "LINE" = ทุก OA ของ LINE, "FB" = Facebook, อื่น ๆ = ทุกช่อง
    // คืนเฉพาะคอลัมน์ที่ใช้เทียบชื่อ — รายละเอียดกิจกรรมดึงทีหลังเฉพาะห้องที่ชื่อเข้าเค้า
    listYoloRooms({ channel = "" } = {}) {
      const filter = channel === "FB" ? " AND c.channel_id = 'facebook'"
        : channel === "LINE" ? " AND c.channel_id <> 'facebook'" : "";
      return all(
        `SELECT c.line_user_id, c.display_name, c.known_name, c.channel_id, c.updated_at
           FROM customers c WHERE ${ROOM_WHERE}${filter}`,
        LEGACY_REFERENCE_TAG,
      );
    },

    isLegacyReferenceRoom(customerId) {
      return Boolean(get(
        "SELECT 1 AS hit FROM customer_tags WHERE customer_id = ? AND tag = ? LIMIT 1",
        String(customerId), LEGACY_REFERENCE_TAG,
      ));
    },

    // ข้อความล่าสุดของห้อง (ทุก session) — ใช้จัดอันดับ "ห้องที่เพิ่งคุย" และตัวอย่างในรายการเลือก
    yoloRoomActivity(customerId) {
      const id = String(customerId);
      const latest = get(
        `SELECT created_at, content, direction, msg_type FROM messages
          WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        id,
      );
      const inbound = get(
        "SELECT MAX(created_at) AS at FROM messages WHERE customer_id = ? AND direction = 'in'",
        id,
      );
      return {
        lastInboundAt: inbound?.at ?? null,
        lastMessageAt: latest?.created_at ?? null,
        lastMessage: latest ? String(latest.content || "") : "",
        lastDirection: latest?.direction || "",
        lastMsgType: latest?.msg_type || "",
      };
    },

    // N ข้อความล่าสุด เรียงเก่า -> ใหม่ (ทุก session — สถานะห้องต้องสะท้อนสิ่งที่ลูกค้าเห็นล่าสุด)
    recentRoomMessages(customerId, limit = 3) {
      return all(
        `SELECT direction, content, operator, msg_type, message_class, created_at FROM messages
          WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        String(customerId), Math.min(20, Math.max(1, Math.trunc(Number(limit)) || 3)),
      ).reverse();
    },

    // จำนวน YOLO ที่ "ข้ามเส้น provider แล้ว" (sending = กำลังส่ง/ผลกำกวม, settled = ส่งจบ)
    // ร่างที่ถูกปฏิเสธค้าง drafting และไม่นับ — พี่ง้วงแก้คำสั่งแล้วลองใหม่ได้ทันที
    countYoloSends({ customerId = null, sinceMs = 0 } = {}) {
      const row = customerId
        ? get(
          `SELECT COUNT(*) AS n FROM proactive_attempts
            WHERE lane = ? AND customer_id = ? AND status IN ('sending','settled') AND updated_at >= ?`,
          YOLO_LANE, String(customerId), Number(sinceMs) || 0,
        )
        : get(
          `SELECT COUNT(*) AS n FROM proactive_attempts
            WHERE lane = ? AND status IN ('sending','settled') AND updated_at >= ?`,
          YOLO_LANE, Number(sinceMs) || 0,
        );
      return Number(row?.n || 0);
    },

    // YOLO ครั้งล่าสุดของห้องที่ข้ามเส้น provider แล้วแต่รั้วยังค้าง sending = ระบบดับ/ล้มระหว่างส่ง
    // ไม่รู้ว่าถึงลูกค้าหรือยัง (code review 2026-09-28: เดิมแถวนี้หลุดจากช่วงกัน 10 นาทีแล้วสั่งซ้ำได้
    // เงียบ ๆ) — คืนเวลาของแถวนั้น ถ้าแถวล่าสุด (sending/settled) ยังเป็น sending · ส่งครั้งใหม่สำเร็จ
    // เมื่อไหร่แถว settled ใหม่จะมาแทนเป็น "ล่าสุด" เอง ไม่ต้องเขียนแก้แถวเก่า
    lastUnresolvedYoloSendAt({ customerId, sinceMs = 0 } = {}) {
      const row = get(
        `SELECT status, updated_at FROM proactive_attempts
          WHERE lane = ? AND customer_id = ? AND status IN ('sending','settled') AND updated_at >= ?
          ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
        YOLO_LANE, String(customerId), Number(sinceMs) || 0,
      );
      return row?.status === "sending" ? Number(row.updated_at) : null;
    },

    // จำนวนร่าง YOLO ทั้งหมด (ทุกสถานะ) — เพดานค่าโมเดลต่อวัน กันลูปสั่งซ้ำจากที่ใดก็ตาม
    countYoloDrafts({ sinceMs = 0 } = {}) {
      return Number(get(
        "SELECT COUNT(*) AS n FROM proactive_attempts WHERE lane = ? AND updated_at >= ?",
        YOLO_LANE, Number(sinceMs) || 0,
      )?.n || 0);
    },
  };
}
