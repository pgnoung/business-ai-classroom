// lineOaContext.mjs — ป้าย "สรุปจาก LINE OA" บนห้องที่คนดูแลเอง
// (คำสั่งพี่ง้วง 2026-08-26)
//
// ปัญหาที่ป้ายนี้แก้
// ห้องที่ติดป้าย "customer" หรือปิด AI = ทีมงานตอบเอง และทีมงาน "ยังตอบในแอป
// LINE OA อยู่จริง" (ยืนยัน 2026-08-26: DB มี outbound แค่ห้องเดียวใน 6 ชม. ขณะที่
// แอป LINE OA มีอีกหลายห้อง) — Messaging API ไม่ส่ง webhook ของข้อความที่แอดมิน
// พิมพ์ในแอปนั้นกลับมา และไม่มี endpoint ให้อ่านย้อนหลัง (ข้อจำกัดของ LINE ไม่ใช่บั๊ก
// ของเรา) คอนโซลจึงมองไม่เห็นบทสนทนาฝั่งนั้นเลย ทั้งประวัติแชทและ context ที่ลูกแพรใช้
//
// สิ่งที่ป้ายนี้ "ไม่" อ้าง
// ไม่ได้อ้างว่าตรวจเจอข้อความใน LINE OA — ตรวจไม่ได้จริง ไม่มีทางรู้เลยว่ามีหรือไม่มี
// ป้ายบอกเฉพาะสิ่งที่ตรวจได้ 100% จากข้อมูลของเราเอง: "เรื่องราวถูกพากลับเข้าคอนโซล
// แล้วหรือยัง" ซึ่งเป็นคำถามที่ต้องตอบอยู่ดีไม่ว่าจะมีอะไรเกิดข้างนอกหรือไม่
//
// ทางที่ context กลับเข้าระบบมีสองทาง — ทั้งคู่นับเป็น "สรุปแล้ว"
//   1) โน้ตส่งต่อที่คนเขียน — pipeline.mjs ป้อน listHandoffNotes เข้า prompt ทุกครั้ง
//      ที่ลูกแพรตอบ จึงเป็นช่องทางตรงที่สุดในการเล่าเรื่องจาก LINE OA ให้ AI ฟัง
//   2) ตอบในคอนโซลเอง — ข้อความอยู่ในตาราง messages แล้ว = อยู่ใน history ของ AI แล้ว
//      (ถ้าไม่นับข้อนี้ ป้ายจะขึ้นส้มทุกครั้งที่ชมพู่ตอบตามปกติ ซึ่งกวนจนเลิกอ่าน)
//
// จุดยึดเวลา: ใช้ "ลูกค้าทักล่าสุดเมื่อไร" ไม่ใช่ "ป้าย customer ติดเมื่อไร"
//
// เคยใช้เวลาติดป้ายเป็นจุดยึด แล้ววัดกับข้อมูลจริง 2026-08-26 พบว่าใช้ไม่ได้:
// ป้าย 800 ใบถูกติดรวดเดียวตอนย้ายระบบ (23 ส.ค.) และอีก 9 ใบติดวันนี้ "หลัง" คุยจบ
// เวลาติดป้ายจึงใหม่กว่าข้อความล่าสุดเกือบทุกห้อง = ซ่อนไป 584 ห้อง เหลือติดป้ายแค่ 7
// พูดง่าย ๆ คือฟีเจอร์ดับสนิทโดยไม่มีใครรู้
//
// จุดยึดที่ใช้จริงคือหน้าต่างเวลา: ห้องที่ลูกค้าทักภายใน RECENT_WINDOW_DAYS เท่านั้น
// เหตุผล — ห้องที่เงียบมาสองเดือนไม่มีใครต้องรีบสรุปอะไร ส่วนห้องที่เพิ่งคุยกันคือห้อง
// ที่บทสนทนาอาจกำลังเกิดในแอป LINE OA อยู่ตอนนี้ (วัดแล้ว: ส้ม 6 · เขียว 43 · ซ่อน 542)
import { isNotQualifiedRow } from "./notQualified.mjs";

export const RECENT_WINDOW_DAYS = 30;
export const RECENT_WINDOW_MS = RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// ผู้เขียนโน้ตที่ "ไม่ใช่คน" — ต้องไม่ทำให้ป้ายเขียวเอง
//   ai_auto / system            = สรุปจากสิ่งที่ระบบเห็นอยู่แล้ว ไม่ใช่ context ใหม่
//   LINE OA (ย้ายข้อมูล)         = tools/line-migration-import.mjs เขียนรวดเดียว 6,412 ใบ
//   ระบบ (โยงระบบเก่าด้วยชื่อ)    = src/legacyLink.mjs เขียนเองตอนโยงห้องเก่า
// สองตัวหลังเป็นโค้ดเขียน ไม่ใช่คนเล่าเรื่อง ถ้านับเป็นคนแล้ววันหนึ่งรันย้ายข้อมูลซ้ำ
// ทุกห้องจะเขียวพร้อมกันทั้งที่ไม่มีใครสรุปอะไรเลย — เขียวหลอกอันตรายกว่าส้มเกิน
//
// หมายเหตุ: "ข้อความ" ขาออกที่ย้ายมาจาก LINE OA ยังนับปกติ เพราะเป็นบทสนทนาจริงที่
// อยู่ในคอนโซลให้อ่านได้แล้ว ต่างจากโน้ตซึ่งเป็นสรุปที่เครื่องปั๊มขึ้นมาตอน import
export const NON_HUMAN_NOTE_AUTHORS = [
  "ai_auto",
  "system",
  "",
  "LINE OA (ย้ายข้อมูล)",
  "ระบบ (โยงระบบเก่าด้วยชื่อ)",
  // ai_promise = ใบสั่งงานที่บอทเขียนถึงทีมงานเองตอนรับปากลูกค้า (pipeline.mjs)
  // ยังไม่มีในฐานข้อมูลตอนนี้เพราะลูกแพรถูกหยุดอยู่ แต่จะเกิดทันทีที่ปลดสวิตช์
  // ถ้าไม่กรองไว้ก่อน ห้องจะเขียวเพราะคำพูดของบอทเอง ไม่ใช่เพราะคนสรุปอะไรกลับมา
  "ai_promise",
  // 28 ก.ย. 2026: โน้ตที่ระบบเขียนตอนเชื่อมห้อง Facebook ↔ LINE (identityLink.mjs IDENTITY_NOTE_AUTHOR)
  "ระบบ (เชื่อมช่องทาง)",
];

// ใช้ประกอบ SQL ใน db.mjs — ค่าคงที่ล้วน ไม่มี input จากผู้ใช้ แต่ escape ' ไว้กันพลาด
export const NON_HUMAN_NOTE_AUTHORS_SQL = NON_HUMAN_NOTE_AUTHORS
  .map((author) => `'${author.replace(/'/g, "''")}'`)
  .join(", ");

export function isHumanNoteAuthor(author) {
  return !NON_HUMAN_NOTE_AUTHORS.includes(String(author ?? "").trim());
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * คืนสถานะป้ายของหนึ่งห้อง หรือ null ถ้าห้องนี้ไม่ต้องติดป้าย
 * รับแถวจาก listConversations (หรือ getCustomer ที่เติมฟิลด์เดียวกันมาแล้ว)
 *
 * @returns {{synced: boolean, reason: "note"|"console_reply"|"pending",
 *            lastInboundAt: number, contextAt: number|null}|null}
 */
export function lineOaContextState(row, nowMs = Date.now()) {
  if (!row) return null;

  const customerTagAt = num(row.customer_tag_at);
  // 5 ต.ค. 2026 (พี่ง้วง): ห้องสีเหลืองที่ตัวกวาดคัดกรองปิด = ไม่มีทีมรับช่วงคุยใน LINE OA — ไม่ต้องรอสรุป
  const aiOff = Number(row.ai_enabled) !== 1 && !isNotQualifiedRow(row);
  // ห้องที่ AI ยังทำงาน = ลูกแพรตอบในคอนโซล บทสนทนาครบอยู่แล้วโดยธรรมชาติ
  if (!customerTagAt && !aiOff) return null;

  const lastInboundAt = num(row.last_inbound_at);
  if (!lastInboundAt) return null;
  // ห้องที่เงียบเกินหน้าต่างเวลา = ไม่มีอะไรเร่งด่วนให้สรุป ไม่ต้องรกตา
  if (lastInboundAt < Number(nowMs) - RECENT_WINDOW_MS) return null;

  const noteAt = num(row.last_human_note_at);
  const replyAt = num(row.last_operator_outbound_at);
  const contextAt = Math.max(noteAt, replyAt);
  const synced = contextAt >= lastInboundAt;

  return {
    synced,
    // โน้ตชนะเสมอเมื่อทั้งคู่ผ่านเกณฑ์ — เป็นหลักฐานที่ตั้งใจเล่าเรื่อง ไม่ใช่ผลพลอยได้
    reason: !synced ? "pending" : (noteAt >= lastInboundAt ? "note" : "console_reply"),
    lastInboundAt,
    contextAt: contextAt || null,
  };
}
