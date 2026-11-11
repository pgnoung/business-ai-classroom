// dbAttention.mjs — "ห้องที่เงินกำลังรั่ว" สำหรับหน้าภาพรวมของเจ้าของ (28 ก.ย. 2026)
//
// ผลตรวจข้อมูลจริงเดือนกันยายน (รายงานจากผู้ประสานงาน): เงินรั่วสองทางใหญ่ที่สุดคือ
//   1) ลูกค้าพูดคนสุดท้ายแล้วไม่มีใครตอบเลย — 35 ห้อง, 24 ห้องรอเกิน 7 วัน
//      (มีงาน in-house 12 คน และ "สนใจคอนซัล" ที่ค้างไว้ 11 วัน)
//   2) ลูกค้าร้อน (คะแนน 8+) ที่เงียบไปโดยยังไม่เคยมีคนจริงทักเลย — ทุกยอดขายที่บันทึกไว้
//      ปิดโดยคนทั้งหมด ห้องร้อนที่ไม่มีคนแตะจึงคือยอดขายที่หลุดมือ
// ไฟล์นี้แค่ "คัดผู้สมัคร" ด้วย SQL แบบมีเพดาน (LIMIT) — การเรียง/นับ/ตัดข้อความอยู่ใน
// consoleAttentionApi.mjs ซึ่งเป็นฟังก์ชันบริสุทธิ์ทดสอบได้โดยไม่ต้องมี DB
//
// ห้ามคืนเนื้อความยาว: ดึงข้อความล่าสุดของลูกค้าแค่ 80 ตัวอักษร (API ตัดเหลือ ≤40 อีกชั้น)
// ข้อความที่ยังไม่มีคนตอบ (unanswered_json ≤8 ข้อความ × 160 ตัวอักษร) ใช้ตัดสินในหน่วยความจำเท่านั้น
// — summarizeWaiting ส่งออกแค่ตัวอย่าง ≤40 ตัวอักษร ไม่มีเส้นไหนส่งแถวดิบออก API
//
// 28 ก.ย. 2026 (พี่ง้วงเห็นคิว "รอคนตอบ 52 ห้อง นานสุด 29 วัน" แล้วบอกว่าบางห้องจบไปแล้ว):
// ผู้สมัครชุดนี้คือนิยาม "รอตอบ" ชุดเดียวของทั้งคอนโซล (หน้าภาพรวม + ชิปหน้าแชท + ภายหลัง Telegram)
// ตัดเพิ่ม: ห้องสแปม (ป้าย null) และห้องที่กดเสร็จสิ้น "หลัง" ข้อความล่าสุดของลูกค้า (ทักกลับมาหลัง
// ปิดเคส = รอตอบอีกครั้ง) · แนบข้อความขาเข้าที่ยังไม่มีใครตอบไว้ให้ waitingRooms.mjs ตัดห้องที่ลูกค้า
// ส่งแค่สติกเกอร์/อีโมจิ/ขอบคุณ ทิ้ง (ตัวจับอยู่ฝั่ง JS ใช้ตัวเดียวกับบันไดทวงของทีม ไม่เขียน regex ใหม่)
import { NON_HUMAN_NOTE_AUTHORS_SQL } from "./lineOaContext.mjs";
import { NOT_SPAM_SQL, SPAM_EXISTS_SQL } from "./spamTag.mjs";
import { SYSTEM_CUSTOMER_TAG_SQL } from "./legacyAutoTag.mjs";
import { NOT_QUALIFIED_REASON, qualifyHoldKey } from "./notQualified.mjs";

// เพดานผู้สมัครต่อคิวรี — ของจริงมีห้องที่ทักใน 30 วันไม่กี่ร้อยห้อง เพดานนี้กันกรณีผิดปกติ
export const ATTENTION_SCAN_LIMIT = 1500;
// ตัวชี้วัดไม้ต่อดูทุกห้องที่ลูกค้าทัก (ไม่กรองคะแนน) — ของจริง 3 พ.ย. 2026: 30 วัน = 1,500 ห้องชนเพดานเดิมพอดี
// ห้องที่ถูกตัดทิ้งเงียบ ๆ ทำให้ % เพี้ยน จึงใช้เพดานแยก (อ่านอย่างเดียว ~0.4 วิที่ 1,500 ห้อง)
export const RELAY_KPI_SCAN_LIMIT = 6000;

// ห้องที่ย้ายมาจาก LINE OA เดิมแล้วถูกโยงกับห้องใหม่ = สำเนาของลูกค้าคนเดียวกัน (กติกาเดียวกับ inbox)
const NOT_LINKED_LEGACY_COPY = `NOT (
  EXISTS (SELECT 1 FROM customer_tags legacy_tag
          WHERE legacy_tag.customer_id = c.line_user_id AND legacy_tag.tag = 'ย้ายจาก LINE OA')
  AND EXISTS (SELECT 1 FROM customers linked_customer
              WHERE linked_customer.legacy_link = 'linked:' || c.line_user_id)
)`;

// ห้องประวัติที่ย้ายมาจาก LINE OA เดิม — userId คนละชุดกับ Messaging API ส่งอะไรไปก็ไม่ถึง (กติกาเดียวกับบรอดแคสต์)
const LEGACY_IMPORT_TAG = "ย้ายจาก LINE OA";
const DAY_MS = 86_400_000;

// 29 ก.ย. 2026: "คนจริงทักแล้ว" = ข้อความคุยรายคนที่คนพิมพ์ (คอนโซล / Business Suite) หรือ YOLO ที่คนสั่ง
// — ลูกแพร/ระบบ/ตัวนำเข้า และข้อความ proactive ทุกแบบ (บรอดแคสต์/ข้อความตามขั้น/ลิงก์เชิญ LINE) ไม่นับ
export const HUMAN_TOUCH_SQL = (alias) => `(${alias}.direction = 'out' AND (
  (${alias}.message_class = 'reactive' AND ${alias}.operator NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL}))
  OR (json_valid(${alias}.metadata_json) AND json_extract(${alias}.metadata_json, '$.yolo') = 1)))`;

const CUSTOMER_COLS = `c.line_user_id, c.display_name, c.known_name, c.picture_url, c.channel_id,
  c.last_score, c.ai_enabled, c.state, c.money_seen_at, c.deal_status, c.ai_off_reason, c.human_owner,
  c.resolved_at, c.operator_active_until`;

// จำนวนข้อความขาเข้าที่ยังไม่มีใครตอบซึ่งอ่านมาตัดสินว่า "รับทราบล้วน" — เกินนี้ถือว่ามีเรื่องให้ตอบแน่
// (ลูกค้าส่งมา 9 ข้อความติดโดยไม่มีคำตอบ ไม่ใช่คนที่แค่ส่งสติกเกอร์ขอบคุณ)
export const WAITING_UNANSWERED_SCAN = 8;

// ข้อความขาเข้าหลังคำตอบล่าสุด (ใหม่สุดก่อน): ชนิด · 160 ตัวแรก · ตำแหน่ง LINE emoji · URL ไฟล์แนบ
// (URL ใช้จับ "ปุ่มไลก์" ของ Messenger ที่ก่อน 5 ก.ย. ถูกเก็บเป็นรูป — ไฟล์มาจาก CDN สติกเกอร์)
const unansweredJson = (a) => `(SELECT json_group_array(json_object(
      'at', r.created_at, 'type', r.msg_type, 'text', substr(r.content, 1, 160),
      'emojis', CASE WHEN json_valid(r.metadata_json) THEN json(json_extract(r.metadata_json, '$.emojis')) END,
      'url', (SELECT json_extract(ma.provider_meta_json, '$.url') FROM message_attachments ma
              WHERE ma.message_id = r.id AND json_valid(ma.provider_meta_json) LIMIT 1)))
    FROM (SELECT mu.id, mu.created_at, mu.msg_type, mu.content, mu.metadata_json FROM messages mu
          WHERE mu.customer_id = ${a}.line_user_id AND mu.direction = 'in'
            AND mu.created_at > COALESCE(${a}.last_reply_at, 0)
          ORDER BY mu.created_at DESC, mu.rowid DESC LIMIT ${WAITING_UNANSWERED_SCAN}) r)`;
const unansweredCount = (a) => `(SELECT COUNT(*) FROM messages mc
    WHERE mc.customer_id = ${a}.line_user_id AND mc.direction = 'in'
      AND mc.created_at > COALESCE(${a}.last_reply_at, 0))`;
const UNANSWERED_JSON = unansweredJson("w");
const UNANSWERED_COUNT = unansweredCount("w");

// ข้อความขาเข้าล่าสุด (เวลา/ชนิด/80 ตัวแรก) — ORDER BY + LIMIT 1 ใช้ idx_messages_customer หยุดที่แถวแรก
const LAST_IN = (col) => `(SELECT ${col} FROM messages mi
  WHERE mi.customer_id = c.line_user_id AND mi.direction = 'in'
  ORDER BY mi.created_at DESC, mi.rowid DESC LIMIT 1)`;

// 5 ต.ค. 2026 (พี่ง้วง): ห้องสีเหลืองที่ตัวกวาดคัดกรองปิด = ตั้งใจไม่ตามต่อ ไม่ใช่คนรอคำตอบ — แต่ซ่อนได้ "เฉพาะเหลืองนิ่ง"
// รีวิวปรปักษ์ 5 ต.ค. #20: เดิมซ่อนทุกห้องเหลืองไม่ว่าสถานะอะไร ห้องที่รอทีมตรวจไฟล์ (NEEDS_HUMAN) ห้องที่ปิดเคสแล้วลูกค้า
//   ทักกลับมา และห้องที่ลูกค้าเพิ่งส่งสัญญาณซื้อแต่ตัวกวาดยังตรวจซ้ำไม่ได้ (ล้ม/unclear/ชนเพดานงบ/สวิตช์ไม่ใช่ on)
//   จึงหายจากคิวรอตอบ ลีดร้อน และ KPI — ไม่มีทั้ง AI และคนเห็น
// ซ่อนเมื่อครบทุกข้อ: AI ปิดด้วยเหตุ not_qualified · state = AI_ACTIVE · ตัวกวาดยืนยันแล้ว (qualify_hold:<id> ≥ เวลา
//   ข้อความลูกค้าล่าสุด) — ไม่มีหมุด/หมุดเก่ากว่าข้อความ/ค่าเพี้ยน = ห้องเหลืองขึ้นคิวเหมือนห้อง AI ปิดทั่วไป (fail open)
const QUALIFY_HOLD_PREFIX = qualifyHoldKey("");
const quietYellowSql = (alias, lastInAt) => `(${alias}.ai_enabled != 1
  AND TRIM(${alias}.ai_off_reason) = '${NOT_QUALIFIED_REASON}'
  AND COALESCE(${alias}.state, '') = 'AI_ACTIVE'
  AND EXISTS (SELECT 1 FROM settings qh
              WHERE qh.key = '${QUALIFY_HOLD_PREFIX}' || ${alias}.line_user_id
                AND CAST(qh.value AS INTEGER) > 0
                AND CAST(qh.value AS INTEGER) >= COALESCE(${lastInAt}, 0)))`;

export function createAttentionDbMethods({ all, get }) {
  const bound = (value) => Math.max(1, Math.min(ATTENTION_SCAN_LIMIT, Math.trunc(Number(value)) || ATTENTION_SCAN_LIMIT));
  return {
    // ผู้สมัคร "ลูกค้ารอคนตอบ": ทักมาในหน้าต่างเวลา และหลังข้อความล่าสุดของลูกค้ายังไม่มีคำตอบเลย
    // "คำตอบ" = ข้อความขาออกแบบ reactive ของใครก็ได้ (ลูกแพรหรือคน) — follow-up/บรอดแคส
    // เป็น proactive ไม่นับว่าตอบ (การทวงไม่ใช่การตอบ — กติกาเดียวกับ KPI)
    attentionWaitingCandidates({ channel = null, sinceMs = 0, beforeMs = Number.MAX_SAFE_INTEGER, limit = ATTENTION_SCAN_LIMIT, customerId = null } = {}) {
      const ch = channel ? String(channel) : null;
      const one = customerId ? String(customerId) : null;
      // ห้องเดียว (หัวห้องแชท) ไม่ต้องสแกนทั้งหน้าต่าง 30 วัน — เงื่อนไขที่เหลือเหมือนกันทุกบรรทัด
      const scope = one
        ? "c.line_user_id = ?"
        : `c.line_user_id IN (
                   SELECT DISTINCT m.customer_id FROM messages m
                   WHERE m.direction = 'in' AND m.created_at >= ?)`;
      return all(
        `SELECT w.*,
                ${UNANSWERED_JSON} AS unanswered_json,
                ${UNANSWERED_COUNT} AS unanswered_count,
                CASE WHEN w.ai_enabled != 1 AND w.ai_off_reason = 'customer_handover'
                     THEN ${SYSTEM_CUSTOMER_TAG_SQL("w.line_user_id")} ELSE 0 END AS ai_off_system_tag
         FROM (
           SELECT ${CUSTOMER_COLS},
                  ${LAST_IN("mi.created_at")} AS last_in_at,
                  ${LAST_IN("mi.msg_type")} AS last_in_type,
                  ${LAST_IN("substr(mi.content, 1, 80)")} AS last_in_text,
                  (SELECT mo.created_at FROM messages mo
                    WHERE mo.customer_id = c.line_user_id AND mo.direction = 'out'
                      AND COALESCE(mo.message_class, 'reactive') != 'proactive'
                    ORDER BY mo.created_at DESC, mo.rowid DESC LIMIT 1) AS last_reply_at
           FROM customers c
           WHERE ${scope}
             AND c.line_user_id NOT LIKE 'canary:%'
             AND ${NOT_SPAM_SQL("c.line_user_id")}
             AND ${NOT_LINKED_LEGACY_COPY}${ch ? " AND c.channel_id = ?" : ""}
         ) w
         WHERE w.last_in_at IS NOT NULL AND w.last_in_at >= ? AND w.last_in_at <= ?
           AND (w.last_reply_at IS NULL OR w.last_reply_at < w.last_in_at)
           -- 5 ต.ค. 2026: ห้องสีเหลือง "เหลืองนิ่งที่ตัวกวาดยืนยันแล้ว" เท่านั้นที่ไม่ใช่คนรอคำตอบ (quietYellowSql — รีวิวปรปักษ์ #20)
           AND NOT ${quietYellowSql("w", "w.last_in_at")}
           -- ปิดเคสหลังข้อความล่าสุดของลูกค้า = จบแล้ว · ลูกค้าทักกลับมาหลังปิด = รอตอบอีกครั้ง
           -- (resolved_at = 0 คือห้องเก่าที่หาเวลาปิดไม่เจอ ถือว่ายังปิดอยู่เหมือนพฤติกรรมเดิม)
           AND NOT (COALESCE(w.state, '') = 'RESOLVED'
                    AND (COALESCE(w.resolved_at, 0) = 0 OR w.resolved_at >= w.last_in_at))
           -- แฮชแท็กคือข้อความที่ระบบตั้งใจไม่ตอบ (ปล่อยให้ LINE OA จัดการ) — ไม่ใช่คนรอ
           AND COALESCE(w.last_in_text, '') NOT LIKE '#%'
         ORDER BY w.last_in_at ASC
         LIMIT ?`,
        one ?? (Number(sinceMs) || 0), ...(ch ? [ch] : []), Number(sinceMs) || 0, Number(beforeMs), bound(limit),
      );
    },

    // ป้ายสถานะของห้องเดียวสำหรับหัวห้องแชท: สแปมไหม · ป้าย customer ระบบติดเองไหม · ลูกค้าทักล่าสุดเมื่อไร
    triageFlags(customerId) {
      return get(
        `SELECT ${SPAM_EXISTS_SQL("c.line_user_id")} AS is_spam,
                ${SYSTEM_CUSTOMER_TAG_SQL("c.line_user_id")} AS ai_off_system_tag,
                ${LAST_IN("mi.created_at")} AS last_in_at
         FROM customers c WHERE c.line_user_id = ?`,
        String(customerId),
      ) || null;
    },

    // ผู้สมัคร "ลูกค้าร้อนรอทีมทักต่อ" (29 ก.ย. 2026 พี่ง้วง: "จบที่ ai แล้วค้างแบบนี้ แต่ยังไม่มีคนไปตอบต่อ
    // แม้ลูกค้าไม่ได้ทักอะไรมาต่อ ก็ต้องให้คนไปตอบ ห้องนั้นถึงจะหายไปจาก list"):
    //   คะแนนล่าสุด 8+ · คำตอบจริงล่าสุดของฝั่งเรา (reactive) ตอบข้อความลูกค้าก่อนหน้า และคำตอบแรกต่อข้อความนั้น
    //   เป็นของลูกแพร ตั้งแต่ aiReplyBeforeMs ขึ้นไป · หลังข้อความนั้นยังไม่มีคนจริงทักเลย — ไม่มีเพดานวัน ค้างจนกว่าคนจะทัก
    //   ข้อความทวง/บรอดแคสต์/ข้อความตามขั้น (proactive) ไม่นับว่า "ลูกแพรตอบ" (กติกาเดียวกับคิวรอตอบ ไม่ซ้อนกันสองรายการ)
    //   ลูกค้าส่งแค่ ขอบคุณ/สติกเกอร์/แฮชแท็ก หลังคำตอบ = ยังค้าง · มีคำถามใหม่ที่ยังไม่มีใครตอบ = คิวรอตอบ
    //   (ตัดสินด้วย unanswered_json ใน consoleAttentionApi ตัวจับเดียวกับคิวรอตอบ)
    //   Facebook ที่ลูกค้าเงียบเกิน 7 วันส่งไม่ได้แล้ว — summarizeHotQuiet ตัดออกเอง
    // ห้องที่จ่ายแล้ว/ปิดดีลแล้ว ห้องติดป้ายเงียบ (ลูกค้าเก่า/null) และห้องประวัติจาก LINE OA เดิม ไม่ใช่ลีดที่ต้องไล่
    // กดเสร็จสิ้นไม่ทำให้หาย — ทางเดียวที่ห้องจะออกคือคนพิมพ์คุยกับลูกค้าจริง (พี่ง้วง 30 ก.ย.)
    attentionHotQuietCandidates({ channel = null, minScore = 8, aiReplyBeforeMs = Number.MAX_SAFE_INTEGER, limit = ATTENTION_SCAN_LIMIT } = {}) {
      const ch = channel ? String(channel) : null;
      const lastReply = `(SELECT mr.created_at FROM messages mr WHERE mr.customer_id = c.line_user_id AND mr.direction = 'out'
          AND mr.message_class = 'reactive' ORDER BY mr.created_at DESC, mr.rowid DESC LIMIT 1)`;
      const answeredIn = (col) => `(SELECT ${col} FROM messages mq WHERE mq.customer_id = c.line_user_id AND mq.direction = 'in'
          AND mq.created_at < COALESCE(${lastReply}, 0) ORDER BY mq.created_at DESC, mq.rowid DESC LIMIT 1)`;
      const answeredAt = answeredIn("mq.created_at");
      return all(
        `SELECT h.*, ${unansweredJson("h")} AS unanswered_json, ${unansweredCount("h")} AS unanswered_count FROM (
           SELECT ${CUSTOMER_COLS},
                  (SELECT ma.created_at FROM messages ma WHERE ma.customer_id = c.line_user_id
                    ORDER BY ma.created_at DESC, ma.rowid DESC LIMIT 1) AS last_at,
                  ${LAST_IN("mi.created_at")} AS last_in_at,
                  ${lastReply} AS last_reply_at,
                  -- ข้อความลูกค้าที่ลูกแพรตอบ (ตัวอย่างบนแถว = คำถามนี้ ไม่ใช่ "ขอบคุณ" ที่ส่งตามมา)
                  ${answeredAt} AS answered_in_at,
                  ${answeredIn("mq.msg_type")} AS last_in_type,
                  ${answeredIn("substr(mq.content, 1, 80)")} AS last_in_text,
                  -- ลูกแพรตอบข้อความนั้นเมื่อไร + ฝั่งเราส่งไปทั้งหมดกี่ข้อความหลังจากนั้น (รวมข้อความทวง)
                  (SELECT MIN(mo.created_at) FROM messages mo WHERE mo.customer_id = c.line_user_id AND mo.direction = 'out'
                     AND mo.message_class = 'reactive' AND mo.created_at > COALESCE(${answeredAt}, 0)) AS ai_reply_at,
                  (SELECT COUNT(*) FROM messages mo WHERE mo.customer_id = c.line_user_id AND mo.direction = 'out'
                     AND mo.created_at > COALESCE(${answeredAt}, 0)) AS outs_after_in,
                  EXISTS (SELECT 1 FROM messages mh WHERE mh.customer_id = c.line_user_id
                            AND mh.created_at > COALESCE(${answeredAt}, 0) AND ${HUMAN_TOUCH_SQL("mh")}) AS human_after_in,
                  EXISTS (SELECT 1 FROM messages me WHERE me.customer_id = c.line_user_id
                            AND ${HUMAN_TOUCH_SQL("me")}) AS team_talked_before
           FROM customers c
           WHERE c.last_score >= ? AND c.line_user_id NOT LIKE 'canary:%'
             AND COALESCE(c.deal_status, '') NOT IN ('paid', 'won')
             -- 5 ต.ค. 2026: ห้องสีเหลืองนิ่ง (คะแนนค้างจากก่อนปิด) ไม่ใช่ลีดร้อนที่ต้อง push ให้ทีมไล่ — ห้องเหลืองที่รอคน
             -- หรือมีข้อความใหม่ที่ตัวกวาดยังไม่ยืนยัน ยังขึ้นตามปกติ (quietYellowSql — รีวิวปรปักษ์ 5 ต.ค. #20)
             AND NOT ${quietYellowSql("c", LAST_IN("mi.created_at"))}
             AND NOT EXISTS (
                   SELECT 1 FROM customer_tags st
                   WHERE st.customer_id = c.line_user_id
                     AND (lower(st.tag) IN ('customer', 'null') OR st.tag = '${LEGACY_IMPORT_TAG}'))${ch ? " AND c.channel_id = ?" : ""}
           ORDER BY c.last_score DESC, c.updated_at DESC
           LIMIT ?
         ) h
         -- 30 ก.ย. 2026 (พี่ง้วง: "อยากให้หายได้ทางเดียวคือต้องพิมพ์คุยจริง ๆ"): กดเสร็จสิ้นไม่ทำให้หาย
         WHERE h.answered_in_at IS NOT NULL AND h.human_after_in = 0
           AND h.ai_reply_at IS NOT NULL AND h.ai_reply_at <= ?
         ORDER BY h.last_score DESC, h.last_in_at DESC`,
        Math.trunc(Number(minScore)) || 8, ...(ch ? [ch] : []), bound(limit), Number(aiReplyBeforeMs),
      );
    },

    // ผู้สมัคร "ไม้ต่อจากลูกแพร" (relayBaton.mjs · พี่ง้วง 3 พ.ย. 2026: ทุกห้อง) — โครงเดียวกับ attentionHotQuietCandidates
    // แต่ไม่กรองคะแนน และไม่ตัดห้องลูกค้าเก่า/ปิดดีลแล้ว (ลูกแพรคุยกับใคร ชมพู่ต้องต่อกับคนนั้น)
    //   last_reply_at = ข้อความสุดท้ายของลูกแพรในรอบ (aiEnd) — human_after_in = 0 จึงไม่มีคนแทรกหลังข้อความลูกค้า
    //   เวลาทำการ 2 ชม. ตัดสินใน JS (workClock) — SQL ตัดแบบหยาบด้วยนาฬิกาจริง (เวลาทำการ ≤ เวลาจริงเสมอ)
    //   ห้องที่ลูกแพรจบก่อน minAiEndMs หลุดรายการ ยกเว้นคะแนน keepScore+ (ค้างจนกว่าคนจะทัก — พี่ง้วง 29 ก.ย.)
    relayCandidates({ channel = null, aiEndBeforeMs = Number.MAX_SAFE_INTEGER, minAiEndMs = 0, keepScore = 8, limit = ATTENTION_SCAN_LIMIT } = {}) {
      const ch = channel ? String(channel) : null;
      const lastReply = `(SELECT mr.created_at FROM messages mr WHERE mr.customer_id = c.line_user_id AND mr.direction = 'out'
          AND mr.message_class = 'reactive' ORDER BY mr.created_at DESC, mr.rowid DESC LIMIT 1)`;
      const answeredIn = (col) => `(SELECT ${col} FROM messages mq WHERE mq.customer_id = c.line_user_id AND mq.direction = 'in'
          AND mq.created_at < COALESCE(${lastReply}, 0) ORDER BY mq.created_at DESC, mq.rowid DESC LIMIT 1)`;
      const answeredAt = answeredIn("mq.created_at");
      const minAiEnd = Number(minAiEndMs) || 0;
      const keep = Math.trunc(Number(keepScore)) || 8;
      return all(
        `SELECT h.*, ${unansweredJson("h")} AS unanswered_json, ${unansweredCount("h")} AS unanswered_count FROM (
           SELECT ${CUSTOMER_COLS},
                  (SELECT ma.created_at FROM messages ma WHERE ma.customer_id = c.line_user_id
                    ORDER BY ma.created_at DESC, ma.rowid DESC LIMIT 1) AS last_at,
                  ${LAST_IN("mi.created_at")} AS last_in_at,
                  ${lastReply} AS last_reply_at,
                  ${answeredAt} AS answered_in_at,
                  ${answeredIn("mq.msg_type")} AS last_in_type,
                  ${answeredIn("substr(mq.content, 1, 80)")} AS last_in_text,
                  (SELECT MIN(mo.created_at) FROM messages mo WHERE mo.customer_id = c.line_user_id AND mo.direction = 'out'
                     AND mo.message_class = 'reactive' AND mo.created_at > COALESCE(${answeredAt}, 0)) AS ai_reply_at,
                  (SELECT COUNT(*) FROM messages mo WHERE mo.customer_id = c.line_user_id AND mo.direction = 'out'
                     AND mo.created_at > COALESCE(${answeredAt}, 0)) AS outs_after_in,
                  EXISTS (SELECT 1 FROM messages mh WHERE mh.customer_id = c.line_user_id
                            AND mh.created_at > COALESCE(${answeredAt}, 0) AND ${HUMAN_TOUCH_SQL("mh")}) AS human_after_in,
                  EXISTS (SELECT 1 FROM messages me WHERE me.customer_id = c.line_user_id
                            AND ${HUMAN_TOUCH_SQL("me")}) AS team_talked_before
           FROM customers c
           WHERE c.line_user_id NOT LIKE 'canary:%'
             AND (COALESCE(c.last_score, 0) >= ? OR EXISTS (SELECT 1 FROM messages mx
                    WHERE mx.customer_id = c.line_user_id AND mx.created_at >= ?))
             AND NOT ${quietYellowSql("c", LAST_IN("mi.created_at"))}
             AND NOT EXISTS (
                   SELECT 1 FROM customer_tags st
                   WHERE st.customer_id = c.line_user_id
                     AND (lower(st.tag) = 'null' OR st.tag = '${LEGACY_IMPORT_TAG}'))${ch ? " AND c.channel_id = ?" : ""}
           ORDER BY c.updated_at DESC
           LIMIT ?
         ) h
         WHERE h.answered_in_at IS NOT NULL AND h.human_after_in = 0
           AND h.last_reply_at IS NOT NULL AND h.last_reply_at <= ?
           AND (h.last_reply_at >= ? OR COALESCE(h.last_score, 0) >= ?)
         ORDER BY h.last_reply_at`,
        keep, minAiEnd, ...(ch ? [ch] : []), bound(limit), Number(aiEndBeforeMs), minAiEnd, keep,
      );
    },

    // ข้อมูลดิบของตัวชี้วัดไม้ต่อ + อัตราตอบ (relayBaton.summarizeRelay) — ทุกห้องที่ลูกค้าทักตั้งแต่ sinceMs
    // ever_human = ห้องนี้เคยมีคนจริงพิมพ์ไหม (นับ "ลูกแพรคุยคนเดียวมาตลอด") · quiet_yellow = ห้องเหลืองนิ่ง (ไม่นับ)
    relayKpiRows({ sinceMs, channel = null } = {}) {
      const since = Number(sinceMs) || 0;
      const ch = channel ? String(channel) : null;
      const rooms = all(
        `SELECT c.line_user_id AS id, c.channel_id,
                EXISTS (SELECT 1 FROM messages me WHERE me.customer_id = c.line_user_id AND ${HUMAN_TOUCH_SQL("me")}) AS ever_human,
                ${quietYellowSql("c", LAST_IN("mi.created_at"))} AS quiet_yellow
         FROM customers c
         WHERE c.line_user_id NOT LIKE 'canary:%'
           AND NOT EXISTS (SELECT 1 FROM customer_tags st WHERE st.customer_id = c.line_user_id
                             AND (lower(st.tag) = 'null' OR st.tag = '${LEGACY_IMPORT_TAG}'))
           AND EXISTS (SELECT 1 FROM messages mi WHERE mi.customer_id = c.line_user_id AND mi.direction = 'in' AND mi.created_at >= ?)${ch ? " AND c.channel_id = ?" : ""}
         LIMIT ?`,
        since, ...(ch ? [ch] : []), RELAY_KPI_SCAN_LIMIT,
      );
      if (!rooms.length) return { rooms: [], messages: [] };
      const ids = rooms.map((room) => room.id);
      const marks = ids.map(() => "?").join(", ");
      const messages = all(
        `SELECT m.customer_id, m.direction, m.created_at, ${HUMAN_TOUCH_SQL("m")} AS human,
                (m.message_class = 'reactive') AS reactive,
                CASE WHEN m.direction = 'in' THEN m.msg_type END AS type,
                CASE WHEN m.direction = 'in' THEN substr(m.content, 1, 160) END AS text,
                CASE WHEN m.direction = 'in' AND json_valid(m.metadata_json) THEN json_extract(m.metadata_json, '$.emojis') END AS emojis_json
         FROM messages m WHERE m.customer_id IN (${marks}) AND m.created_at >= ?
         ORDER BY m.customer_id, m.created_at, m.rowid`,
        ...ids, since,
      );
      return { rooms, messages };
    },

    // ข้อมูลดิบของตัวชี้วัด "ทีมทักต่อลูกค้าร้อนกี่ %" (hotFollowupRate.mjs คิดต่อเป็นฟังก์ชันบริสุทธิ์)
    // ห้องที่ลูกค้าทักตั้งแต่ sinceMs และเคยมีคะแนน 8+ · เวลา/ทิศทาง/คนหรือไม่/ตอบจริงไหม + ข้อความขาเข้า 160 ตัวแรก
    // (ใช้ตัดสิน "แค่ขอบคุณ/สติกเกอร์" ในหน่วยความจำเท่านั้น — ตัวชี้วัดที่ส่งออกมีแต่ตัวเลข)
    hotFollowupKpiRows({ sinceMs, minScore = 8, channel = null } = {}) {
      const since = Number(sinceMs) || 0;
      const ch = channel ? String(channel) : null;
      const min = Math.trunc(Number(minScore)) || 8;
      const rooms = all(
        `SELECT c.line_user_id AS id, c.channel_id, c.last_score, c.deal_status,
                (SELECT MIN(t.created_at) FROM customer_tags t
                  WHERE t.customer_id = c.line_user_id AND lower(t.tag) = 'customer') AS customer_tag_at
         FROM customers c
         WHERE c.line_user_id NOT LIKE 'canary:%'
           AND NOT EXISTS (SELECT 1 FROM customer_tags st WHERE st.customer_id = c.line_user_id
                             AND (lower(st.tag) = 'null' OR st.tag = '${LEGACY_IMPORT_TAG}'))
           AND EXISTS (SELECT 1 FROM messages mi WHERE mi.customer_id = c.line_user_id AND mi.direction = 'in' AND mi.created_at >= ?)
           AND (c.last_score >= ? OR EXISTS (SELECT 1 FROM score_history sh
                  WHERE sh.customer_id = c.line_user_id AND sh.score >= ? AND sh.created_at >= ?))${ch ? " AND c.channel_id = ?" : ""}
         LIMIT ?`,
        since, min, min, since - 30 * DAY_MS, ...(ch ? [ch] : []), ATTENTION_SCAN_LIMIT,
      );
      if (!rooms.length) return { rooms: [], messages: [], scores: [] };
      const ids = rooms.map((room) => room.id);
      const marks = ids.map(() => "?").join(", ");
      const messages = all(
        `SELECT m.customer_id, m.direction, m.created_at, ${HUMAN_TOUCH_SQL("m")} AS human,
                (m.message_class = 'reactive') AS reactive,
                -- ขาเข้าเท่านั้น: ใช้ตัดสิน "แค่ขอบคุณ/สติกเกอร์" ในหน่วยความจำ ไม่ส่งออก API
                CASE WHEN m.direction = 'in' THEN m.msg_type END AS type,
                CASE WHEN m.direction = 'in' THEN substr(m.content, 1, 160) END AS text,
                CASE WHEN m.direction = 'in' AND json_valid(m.metadata_json) THEN json_extract(m.metadata_json, '$.emojis') END AS emojis_json
         FROM messages m WHERE m.customer_id IN (${marks}) AND m.created_at >= ?
         ORDER BY m.customer_id, m.created_at, m.rowid`,
        ...ids, since,
      );
      const scores = all(
        `SELECT customer_id, score, created_at FROM score_history
         WHERE customer_id IN (${marks}) AND created_at >= ? ORDER BY customer_id, created_at`,
        ...ids, since - 30 * DAY_MS,
      );
      return { rooms, messages, scores };
    },
  };
}
