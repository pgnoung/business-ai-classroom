// legacyAutoTag.mjs — หลักฐานว่า "ระบบ" เป็นคนติดป้าย customer ให้ห้องลูกค้า (ไม่ใช่คนติด)
//
// ย้ายค่าคงที่ออกมาจาก legacyLink.mjs เมื่อ 28 ก.ย. 2026 เพราะคอนโซลต้องใช้กติกาเดียวกันใน SQL ของ
// รายการแชท (db.mjs/dbAttention.mjs) เพื่อบอกว่า "AI ปิด · โดยระบบ" — แต่ legacyLink.mjs import db.mjs
// อยู่แล้ว ถ้า db.mjs import กลับจะเกิดวง import ที่ BOT_SILENCED_TAGS ยังไม่พร้อมตอนโหลด
// ไฟล์นี้จึงไม่ import อะไรเลย และ legacyLink.mjs ใช้ค่าชุดนี้ชุดเดียวกัน (กติกาไม่มีทางแยกกันเดิน)

export const LEGACY_AUTO_CUSTOMER_NOTE =
  "ชื่อตรงห้องระบบเก่าที่ลงทะเบียนแล้ว — ติดป้าย customer ให้แล้ว บอทเงียบ รอทีมงานตอบเอง";
export const SYSTEM_LINK_AUTHOR = "ระบบ (โยงระบบเก่าด้วยชื่อ)";
// ป้ายระบบถูกติดคู่กับโน้ตในจังหวะเดียวกัน — คนถอนแล้วติดเองใหม่ทีหลัง แถวป้ายจะใหม่กว่าโน้ตมาก = ป้ายของคน
export const AUTO_TAG_NOTE_WINDOW_MS = 60_000;

const sqlText = (value) => `'${String(value).replace(/'/gu, "''")}'`;

// SQL คู่กับ systemOwnsCustomerTag ใน legacyLink.mjs (กติกาเดียวกันทุกข้อ) — 1 = ป้าย customer แถวนี้ระบบติดเอง
export const SYSTEM_CUSTOMER_TAG_SQL = (customerCol) => `EXISTS (
  SELECT 1 FROM customer_tags auto_tag
  JOIN handoff_notes auto_note ON auto_note.customer_id = auto_tag.customer_id
  WHERE auto_tag.customer_id = ${customerCol} AND auto_tag.tag = 'customer'
    AND auto_note.author = ${sqlText(SYSTEM_LINK_AUTHOR)}
    AND auto_note.text = ${sqlText(LEGACY_AUTO_CUSTOMER_NOTE)}
    AND ABS(auto_note.created_at - auto_tag.created_at) <= ${AUTO_TAG_NOTE_WINDOW_MS})`;
