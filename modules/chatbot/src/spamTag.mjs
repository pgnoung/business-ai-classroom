// spamTag.mjs — "สแปม" = ห้องที่ติดป้าย null (คำสั่งพี่ง้วง 28 ก.ย. 2026: "spam = null chat tag")
//
// ทำไมไม่สร้างสถานะใหม่: ป้าย null มีความหมายว่า "ไม่ใช่แชทจริง" อยู่แล้ว (คำสั่งเจ้าของ 28 ส.ค. —
// บัญชีมาตามเอกสาร เจ้าของบริษัทที่ส่งทีมมาเรียน) และกลไกเงียบของบอทผูกกับป้ายนี้ครบทุกเส้นแล้ว
// (ปิด AI เหตุ not_a_customer · follow-up ข้าม tag_silenced · ไปป์ไลน์ปิดซ้ำทุกเทิร์น)
// สแปมจึงเป็นแค่ "ชื่อเรียกบนหน้าจอ" ของป้ายเดิม + กติกาว่าห้องแบบนี้ต้องหายจากทุกคิวงานของทีม
// ผลข้างเคียงที่ตั้งใจ: ห้องที่เคยติด null ไว้ก่อนวันนี้ถือเป็นสแปมด้วยทันที
//
// ไฟล์นี้ไม่ import อะไรเลย — ให้ไฟล์ SQL ทุกไฟล์ (db.mjs, dbAttention, dbExtra, dbWebPush) ใช้ได้
// โดยไม่เกิดวง import · เทียบแบบไม่สนตัวพิมพ์ เพราะตาราง customer_tags ไม่มี COLLATE NOCASE
// ("null"/"Null"/"NULL" เป็นคนละแถวกันได้ — ต้องนับเป็นสแปมทุกแบบ และตอนคืนต้องถอดทุกแบบ)

export const SPAM_TAG = "null";

export function isSpamTag(tag) {
  return String(tag ?? "").trim().toLowerCase() === SPAM_TAG;
}

// ประกอบ SQL จากชื่อคอลัมน์ที่เป็นค่าคงที่ของโค้ดเท่านั้น (ไม่มี input จากผู้ใช้)
export const SPAM_EXISTS_SQL = (customerCol) => `EXISTS (
  SELECT 1 FROM customer_tags spam_tag
  WHERE spam_tag.customer_id = ${customerCol} AND lower(trim(spam_tag.tag)) = '${SPAM_TAG}')`;

export const NOT_SPAM_SQL = (customerCol) => `NOT ${SPAM_EXISTS_SQL(customerCol)}`;
