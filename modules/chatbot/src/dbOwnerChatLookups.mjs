// dbOwnerChatLookups.mjs — คิวรีอ่านอย่างเดียวของ "ถามอะไรก็ค้นให้" ในแชทเจ้าของ (28 ก.ย. 2026 บ่าย)
//
// พี่ง้วง: "สามารถลิ้งค์ไวๆ กับ สมองลูกแพร เพื่อดูข้อมูล พี่ง้วง สอบถาม วิเคราะห์ ได้ไหม"
// ลูกแพรเลือกคิวรีจากรายการปิด (ownerChatLookupCatalog.mjs) แล้วระบบรันที่นี่ — ไม่มี SQL จากโมเดลเลย
// ทุกคิวรี: SELECT ล้วน · ตัด canary · มีเพดานช่วงเวลา (ผู้เรียกตัดไม่เกิน 90 วัน) และเพดานแถว (LIMIT)
// ใช้ idx_messages_time (created_at) เป็นทางเข้าหลัก — ช่วงเวลามาก่อน ลูกค้าทีหลัง (ตรวจด้วย EXPLAIN)
// ตัวเลขทุกตัวที่ลูกแพรพูดในผลค้นมาจากตรงนี้ · การปิดชื่อ/ซ่อนเบอร์ทำที่ตัวจัดรูป (ownerChatLookups.mjs)
import { NON_HUMAN_NOTE_AUTHORS_SQL } from "./lineOaContext.mjs";

const DAY_MS = 86_400_000;
const BKK_OFFSET_MS = 7 * 3_600_000;
// วันเวลาไทยเป็นเลขวัน (epoch day) — จัดกลุ่มรายวันใน SQL โดยไม่พึ่ง timezone ของเครื่อง
const BKK_DAY = (column) => `CAST((${column} + ${BKK_OFFSET_MS}) / ${DAY_MS} AS INTEGER)`;
const HUMAN_OUT = `(m.agent_mode LIKE 'operator%'
  OR (m.agent_mode IS NULL AND m.operator NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})))`;
const escapeLike = (value) => String(value).replace(/[\\%_]/gu, (ch) => `\\${ch}`);
const clampLimit = (value, max, fallback) => Math.min(max, Math.max(1, Math.trunc(Number(value)) || fallback));

// ช่องทาง: "LINE" = ทุก OA ของ LINE · "FB" = Facebook · อื่น ๆ = ทุกช่อง (รูปเดียวกับ listYoloRooms)
function channelSql(column, channel) {
  if (channel === "FB") return ` AND ${column} = 'facebook'`;
  if (channel === "LINE") return ` AND ${column} <> 'facebook'`;
  return "";
}

// 28 ก.ย. 2026: ห้อง Facebook + LINE ที่เชื่อมเป็นคนเดียวกัน (dbIdentityLinks.mjs) — ตัวนับ "คน" ใช้ person_id
// แทน id ห้อง (ห้องที่ยังไม่เชื่อมกับใคร = คนหนึ่งคนตามเดิม) · ตัวนับ "ห้อง" ทุกตัวยังเป็นรายห้องเหมือนเดิม
const PERSON_KEY = (column) => `COALESCE((SELECT il.person_id FROM customer_identity_links il WHERE il.customer_id = ${column}), ${column})`;
// ลูกค้าคนนี้เคยทักทางช่องทางอื่นของคนเดียวกันก่อนเวลานี้ไหม (ทักห้อง LINE ครั้งแรก ≠ ลูกค้าใหม่ถ้าเคยคุย Facebook มาก่อน)
const EARLIER_ON_LINKED = (column, atColumn) => `EXISTS (
  SELECT 1 FROM customer_identity_links me
    JOIN customer_identity_links other ON other.person_id = me.person_id AND other.customer_id <> me.customer_id
    JOIN messages pm ON pm.customer_id = other.customer_id AND pm.direction = 'in' AND pm.created_at < ${atColumn}
   WHERE me.customer_id = ${column})`;

// ห้องที่ย้ายมาจาก LINE OA เดิมแล้วถูกโยงกับห้องใหม่ = สำเนาของลูกค้าคนเดียวกัน (กติกาเดียวกับ dbAttention.mjs)
const NOT_LINKED_LEGACY_COPY = `NOT (
  EXISTS (SELECT 1 FROM customer_tags legacy_tag
          WHERE legacy_tag.customer_id = c.line_user_id AND legacy_tag.tag = 'ย้ายจาก LINE OA')
  AND EXISTS (SELECT 1 FROM customers linked_customer
              WHERE linked_customer.legacy_link = 'linked:' || c.line_user_id)
)`;

export function createOwnerLookupDbMethods({ all, get }) {
  return {
    // กิจกรรมรายวัน (ห้อง ไม่ใช่บอลลูน) — day = epoch day เวลาไทย
    lookupActivityByDay({ startMs, endMs, channel = "" }) {
      return all(
        `SELECT ${BKK_DAY("m.created_at")} AS day,
                COUNT(DISTINCT CASE WHEN m.direction = 'in' THEN m.customer_id END) AS in_rooms,
                SUM(CASE WHEN m.direction = 'in' THEN 1 ELSE 0 END) AS in_messages,
                COUNT(DISTINCT CASE WHEN m.direction = 'out' AND m.agent_mode = 'ai' AND m.message_class = 'reactive' THEN m.customer_id END) AS ai_rooms,
                COUNT(DISTINCT CASE WHEN m.direction = 'out' AND m.message_class = 'reactive' AND ${HUMAN_OUT} THEN m.customer_id END) AS human_rooms,
                COUNT(DISTINCT CASE WHEN m.direction = 'out' AND m.agent_mode = 'ai' AND m.message_class = 'proactive' THEN m.customer_id END) AS followup_rooms
           FROM messages m
          WHERE m.created_at >= ? AND m.created_at < ? AND m.customer_id NOT LIKE 'canary:%'${channelSql("m.channel_id", channel)}
          GROUP BY day ORDER BY day`,
        Number(startMs), Number(endMs),
      );
    },

    // ยอดรวมทั้งช่วง (ห้องที่ทักหลายวันนับครั้งเดียว) + แยก LINE/FB
    lookupActivityTotals({ startMs, endMs, channel = "" }) {
      return get(
        `SELECT COUNT(DISTINCT CASE WHEN m.direction = 'in' THEN m.customer_id END) AS in_rooms,
                SUM(CASE WHEN m.direction = 'in' THEN 1 ELSE 0 END) AS in_messages,
                COUNT(DISTINCT CASE WHEN m.direction = 'in' AND m.channel_id = 'facebook' THEN m.customer_id END) AS in_rooms_fb,
                COUNT(DISTINCT CASE WHEN m.direction = 'in' AND m.channel_id <> 'facebook' THEN m.customer_id END) AS in_rooms_line,
                COUNT(DISTINCT CASE WHEN m.direction = 'out' AND m.agent_mode = 'ai' AND m.message_class = 'reactive' THEN m.customer_id END) AS ai_rooms,
                COUNT(DISTINCT CASE WHEN m.direction = 'out' AND m.message_class = 'reactive' AND ${HUMAN_OUT} THEN m.customer_id END) AS human_rooms,
                COUNT(DISTINCT CASE WHEN m.direction = 'out' AND m.agent_mode = 'ai' AND m.message_class = 'proactive' THEN m.customer_id END) AS followup_rooms
           FROM messages m
          WHERE m.created_at >= ? AND m.created_at < ? AND m.customer_id NOT LIKE 'canary:%'${channelSql("m.channel_id", channel)}`,
        Number(startMs), Number(endMs),
      ) || {};
    },

    // ลูกค้าที่ทักครั้งแรกในชีวิตภายในช่วง (รายวัน) — ไม่มีข้อความขาเข้าก่อนหน้านั้นเลย
    lookupFirstTimeByDay({ startMs, endMs, channel = "" }) {
      return all(
        `SELECT ${BKK_DAY("f.first_in")} AS day, COUNT(*) AS n,
                SUM(CASE WHEN f.channel_id = 'facebook' THEN 1 ELSE 0 END) AS fb
           FROM (SELECT t.cid, t.channel_id,
                        (SELECT p.created_at FROM messages p WHERE p.customer_id = t.cid AND p.direction = 'in'
                          ORDER BY p.created_at ASC LIMIT 1) AS first_in
                   FROM (SELECT DISTINCT +m.customer_id AS cid, m.channel_id AS channel_id FROM messages m
                          WHERE m.direction = 'in' AND m.created_at >= ? AND m.created_at < ?
                            AND m.customer_id NOT LIKE 'canary:%'${channelSql("m.channel_id", channel)}) t) f
          WHERE f.first_in >= ? AND f.first_in < ?
            AND NOT ${EARLIER_ON_LINKED("f.cid", "f.first_in")}
          GROUP BY day ORDER BY day`,
        Number(startMs), Number(endMs), Number(startMs), Number(endMs),
      );
    },

    // บันทึกส่งต่อทีม — ตัวอ่านเวลาต่อบรรทัดอยู่ฝั่ง JS (handoff_summary เก็บ 2,000 ตัวท้ายเท่านั้น)
    // กรองหยาบด้วย updated_at ก่อน: บรรทัดส่งต่อที่เขียนเวลา T ทำให้ updated_at ≥ T เสมอ (setNeedsHuman)
    // ห้องที่ไม่ขยับเลยตั้งแต่ต้นช่วง จึงไม่มีบรรทัดในช่วงแน่นอน (รีวิวโค้ด 28 ก.ย.: ไม่ต้องอ่านทุกห้อง)
    lookupHandoffSummaries({ channel = "", sinceMs = 0 } = {}) {
      return all(
        `SELECT line_user_id, channel_id, handoff_summary FROM customers
          WHERE handoff_summary <> '' AND updated_at >= ? AND line_user_id NOT LIKE 'canary:%'${channelSql("channel_id", channel)}`,
        Number(sinceMs) || 0,
      );
    },

    // ข้อความลูกค้า (ตัวอักษรล้วน) ในช่วง — ใหม่สุดก่อน · เนื้อความตัด 300 ตัว · เพดานแถว
    lookupCustomerTexts({ sinceMs, channel = "", limit = 20_000 }) {
      return all(
        `SELECT m.customer_id, m.channel_id, substr(m.content, 1, 300) AS content, m.created_at
           FROM messages m
          WHERE m.direction = 'in' AND m.msg_type = 'text' AND m.created_at >= ?
            AND m.customer_id NOT LIKE 'canary:%'${channelSql("m.channel_id", channel)}
          ORDER BY m.created_at DESC LIMIT ?`,
        Number(sinceMs), clampLimit(limit, 20_000, 20_000),
      );
    },

    // ค้นคำในข้อความลูกค้า: จำนวน + ห้อง + ตัวอย่างล่าสุด (คำค้นผ่าน LIKE แบบ escape แล้ว)
    lookupMessageSearch({ keyword, sinceMs, channel = "", samples = 5 }) {
      const like = `%${escapeLike(keyword)}%`;
      const where = `m.direction = 'in' AND m.msg_type = 'text' AND m.created_at >= ? AND m.content LIKE ? ESCAPE '\\'
        AND m.customer_id NOT LIKE 'canary:%'${channelSql("m.channel_id", channel)}`;
      const counts = get(`SELECT COUNT(*) AS n, COUNT(DISTINCT m.customer_id) AS rooms FROM messages m WHERE ${where}`, Number(sinceMs), like) || {};
      const rows = all(
        `SELECT m.customer_id, m.channel_id, substr(m.content, 1, 400) AS content, m.created_at
           FROM messages m WHERE ${where} ORDER BY m.created_at DESC LIMIT ?`,
        Number(sinceMs), like, clampLimit(samples, 10, 5),
      );
      return { messages: Number(counts.n) || 0, rooms: Number(counts.rooms) || 0, rows };
    },

    // ลีดตามเงื่อนไข — ห้องที่ยังคุยอยู่ในช่วง · ไม่เอาห้องที่เป็นลูกค้าแล้ว/สำเนาห้องเก่า
    lookupLeads({
      minScore = 8, maxScore = 10, sinceMs = 0, channel = "", dealStatus = "", waitingReply = false,
      noTeamContact = false, aiState = "any", sort = "score", limit = 10,
    } = {}) {
      const filters = [
        "h.last_at IS NOT NULL AND h.last_at >= ?",
        ...(waitingReply ? ["h.last_dir = 'in'"] : []),
        ...(noTeamContact ? ["h.human_touched = 0"] : []),
      ];
      const order = sort === "recent" ? "h.last_at DESC"
        : sort === "waiting" ? "CASE WHEN h.last_dir = 'in' THEN 0 ELSE 1 END, h.last_at ASC"
          : "h.last_score DESC, h.last_at DESC";
      const inner = `SELECT c.line_user_id, c.display_name, c.known_name, c.channel_id, c.last_score, c.ai_enabled,
                c.ai_off_reason, c.state, c.deal_status, c.money_seen_at, c.handoff_summary,
                (SELECT m.created_at FROM messages m WHERE m.customer_id = c.line_user_id
                  ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_at,
                (SELECT m.direction FROM messages m WHERE m.customer_id = c.line_user_id
                  ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_dir,
                (SELECT m.agent_mode FROM messages m WHERE m.customer_id = c.line_user_id
                  ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_agent_mode,
                EXISTS (SELECT 1 FROM messages m WHERE m.customer_id = c.line_user_id
                  AND m.direction = 'out' AND ${HUMAN_OUT}) AS human_touched
           FROM customers c
          WHERE c.last_score >= ? AND c.last_score <= ? AND c.line_user_id NOT LIKE 'canary:%'
            -- เฉพาะห้องที่มีข้อความในช่วง (ทางเข้า idx_messages_time) — ไม่ไล่คิวรีย่อยกับทุกห้องในฐาน
            AND c.line_user_id IN (SELECT DISTINCT +mm.customer_id FROM messages mm WHERE mm.created_at >= ?)
            AND COALESCE(c.state, '') <> 'RESOLVED'
            AND NOT EXISTS (SELECT 1 FROM customer_tags st
                  WHERE st.customer_id = c.line_user_id AND lower(st.tag) IN ('customer', 'null'))
            AND ${NOT_LINKED_LEGACY_COPY}${channelSql("c.channel_id", channel)}
            ${dealStatus ? "AND c.deal_status = ?" : ""}
            ${aiState === "on" ? "AND c.ai_enabled = 1" : aiState === "off" ? "AND c.ai_enabled <> 1" : ""}`;
      const params = [Math.trunc(minScore), Math.trunc(maxScore), Number(sinceMs), ...(dealStatus ? [String(dealStatus)] : [])];
      const total = get(`SELECT COUNT(*) AS n FROM (${inner}) h WHERE ${filters.join(" AND ")}`, ...params, Number(sinceMs)) || {};
      const rows = all(
        `SELECT * FROM (${inner}) h WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ?`,
        ...params, Number(sinceMs), clampLimit(limit, 10, 10),
      );
      return { total: Number(total.n) || 0, rows };
    },

    // ภาพรวมการขาย/การชำระ ของห้องที่ลูกค้าทักในช่วง (ไม่มีเลขบัญชี ไม่มียอดโอนรายคน)
    lookupFunnel({ sinceMs, channel = "" }) {
      const active = `SELECT DISTINCT +m.customer_id AS cid FROM messages m
          WHERE m.direction = 'in' AND m.created_at >= ? AND m.customer_id NOT LIKE 'canary:%'${channelSql("m.channel_id", channel)}`;
      const since = Number(sinceMs);
      const counts = get(
        `SELECT COUNT(*) AS active,
                SUM(CASE WHEN c.price_quoted_at >= ? THEN 1 ELSE 0 END) AS price_quoted,
                SUM(CASE WHEN c.money_seen_at >= ? THEN 1 ELSE 0 END) AS money_seen,
                SUM(CASE WHEN c.ai_enabled <> 1 AND c.ai_off_reason = 'bank_sent' THEN 1 ELSE 0 END) AS bank_sent_ai_off,
                SUM(CASE WHEN c.state = 'NEEDS_HUMAN' THEN 1 ELSE 0 END) AS needs_human,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id = c.line_user_id AND lower(t.tag) = 'customer') THEN 1 ELSE 0 END) AS customer_tagged,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id = c.line_user_id AND lower(t.tag) = 'customer' AND t.created_at >= ?) THEN 1 ELSE 0 END) AS customer_tagged_new,
                COUNT(DISTINCT ${PERSON_KEY("c.line_user_id")}) AS active_people,
                COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id = c.line_user_id AND lower(t.tag) = 'customer')
                  THEN ${PERSON_KEY("c.line_user_id")} END) AS customer_tagged_people
           FROM (${active}) a JOIN customers c ON c.line_user_id = a.cid`,
        since, since, since, since,
      ) || {};
      const deals = all(
        `SELECT c.deal_status AS status, COUNT(*) AS n FROM (${active}) a JOIN customers c ON c.line_user_id = a.cid
          GROUP BY c.deal_status ORDER BY n DESC`,
        since,
      );
      const orders = get(
        `SELECT SUM(CASE WHEN o.created_at >= ? THEN 1 ELSE 0 END) AS created,
                SUM(CASE WHEN o.status = 'confirmed' AND o.updated_at >= ? THEN 1 ELSE 0 END) AS confirmed,
                SUM(CASE WHEN o.status IN ('paid', 'shipped', 'done') AND o.updated_at >= ? THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN o.status IN ('paid', 'shipped', 'done') AND o.updated_at >= ? THEN COALESCE(o.total, 0) ELSE 0 END) AS revenue
           FROM orders o WHERE o.customer_id NOT LIKE 'canary:%'${channelSql("o.channel_id", channel)}`,
        since, since, since, since,
      ) || {};
      return { counts, deals, orders };
    },

    // ผลของการทักตาม: ข้อความเชิงรุกของลูกแพร (ทักตามอัตโนมัติ + YOLO) ในช่วง แล้วลูกค้าตอบภายใน replyMs ไหม
    // นับเป็น "ห้อง" (หนึ่งครั้งที่ทักแตกได้หลายบอลลูน) · YOLO แยกด้วย metadata.yolo
    lookupFollowups({ sinceMs, channel = "", replyMs = DAY_MS }) {
      return get(
        `WITH fu AS (
           SELECT m.customer_id, m.created_at, m.channel_id,
                  COALESCE(json_extract(m.metadata_json, '$.yolo'), 0) AS yolo,
                  EXISTS (SELECT 1 FROM messages r WHERE r.customer_id = m.customer_id AND r.direction = 'in'
                    AND r.created_at > m.created_at AND r.created_at <= m.created_at + ?) AS replied
             FROM messages m
            WHERE m.direction = 'out' AND m.agent_mode = 'ai' AND m.message_class = 'proactive'
              AND m.created_at >= ? AND m.customer_id NOT LIKE 'canary:%'${channelSql("m.channel_id", channel)}
         )
         SELECT COUNT(*) AS bubbles,
                COUNT(DISTINCT fu.customer_id) AS rooms,
                COUNT(DISTINCT CASE WHEN fu.replied THEN fu.customer_id END) AS replied_rooms,
                COUNT(DISTINCT CASE WHEN fu.yolo THEN fu.customer_id END) AS yolo_rooms,
                COUNT(DISTINCT CASE WHEN fu.yolo AND fu.replied THEN fu.customer_id END) AS yolo_replied_rooms,
                COUNT(DISTINCT CASE WHEN fu.channel_id = 'facebook' THEN fu.customer_id END) AS fb_rooms,
                COUNT(DISTINCT CASE WHEN fu.channel_id = 'facebook' AND fu.replied THEN fu.customer_id END) AS fb_replied_rooms,
                COUNT(DISTINCT CASE WHEN fu.channel_id <> 'facebook' THEN fu.customer_id END) AS line_rooms,
                COUNT(DISTINCT CASE WHEN fu.channel_id <> 'facebook' AND fu.replied THEN fu.customer_id END) AS line_replied_rooms,
                COUNT(DISTINCT CASE WHEN c.last_score >= 8 THEN fu.customer_id END) AS hot_rooms,
                COUNT(DISTINCT CASE WHEN c.last_score >= 8 AND fu.replied THEN fu.customer_id END) AS hot_replied_rooms,
                COUNT(DISTINCT CASE WHEN c.last_score BETWEEN 5 AND 7 THEN fu.customer_id END) AS warm_rooms,
                COUNT(DISTINCT CASE WHEN c.last_score BETWEEN 5 AND 7 AND fu.replied THEN fu.customer_id END) AS warm_replied_rooms,
                COUNT(DISTINCT CASE WHEN c.last_score IS NULL OR c.last_score <= 4 THEN fu.customer_id END) AS cold_rooms,
                COUNT(DISTINCT CASE WHEN (c.last_score IS NULL OR c.last_score <= 4) AND fu.replied THEN fu.customer_id END) AS cold_replied_rooms
           FROM fu LEFT JOIN customers c ON c.line_user_id = fu.customer_id`,
        Number(replyMs), Number(sinceMs),
      ) || {};
    },

    // ค่า AI จัดกลุ่มตามวัน/โมเดล/ชนิด + แยกแชทเจ้าของ (customer_id ว่าง ชนิด draft) ออกจากงานตอบลูกค้า
    // รูปแถวเดียวกับ llmUsageSummary จึงคิดเงินด้วย summarizeUsage ตัวเดียวกับคอนโซลได้ตรง ๆ
    // แยกกลุ่ม "ครั้งที่มีการเขียนแคช" ออกด้วย (ตรวจสำเนา 28 ก.ย.): summarizeUsage ถือว่าทั้งกลุ่มไม่ทราบราคา
    // เมื่อกลุ่มมีการเขียนแคชของโมเดลที่ยังไม่มีราคาเขียนแคช — ถ้ารวมกลุ่มใหญ่ ค่าเรียกปกติที่รู้ราคาหายไปทั้งก้อน
    lookupUsageRows({ sinceMs, untilMs }) {
      return all(
        `SELECT ${BKK_DAY("created_at")} AS day, model, kind, (customer_id = '') AS unattributed,
                SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
                SUM(COALESCE(cached_in, 0)) AS cached_in, SUM(cache_write_in) AS cache_write_in,
                (tokens_in > 272000) AS long_context,
                SUM(CASE WHEN cache_write_known = 0 AND tokens_in > 0 THEN 1 ELSE 0 END) AS missing_cache_write_calls
           FROM llm_usage WHERE created_at >= ? AND created_at < ?
          GROUP BY day, model, kind, unattributed, (tokens_in > 272000), (COALESCE(cache_write_in, 0) > 0)
          ORDER BY day`,
        Number(sinceMs), Number(untilMs),
      );
    },
  };
}
