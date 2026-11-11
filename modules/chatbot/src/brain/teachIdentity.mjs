// brain/teachIdentity.mjs — ตัวตนของลูกค้าใน teach_json: ทำ hash และลบทิ้ง
//
// เป็นไฟล์ใบไม้โดยเจตนา (import แค่ node:crypto) เพราะ src/db.mjs ต้องเรียกมันตอนลบลูกค้า
// ตามคำขอ — ถ้าอยู่ใน brain/teach.mjs ซึ่ง import learningDigest.mjs -> dbExtra.mjs
// จะเกิดวงกลมของ import กับ db.mjs เอง
import { createHash, createHmac } from "node:crypto";

const CUSTOMER_HASH_DOMAIN = "lukprae-teach-customer-v1\0";

/**
 * id ของลูกค้าไม่เคยลงไปใน teach_json — ลง hash เท่านั้น (แบบแปลน §5 PDPA ข้อ 2)
 *
 * มีกุญแจ (secret ของ instance) = ย้อนกลับด้วย dictionary ของ LINE id ที่รู้อยู่แล้วไม่ได้
 * ไม่มีกุญแจ = ตกกลับเป็น sha256 + domain แบบเดียวกับ tombstone (เครื่องที่ยังไม่ตั้ง secret
 * ต้องทำงานได้ ไม่ใช่ล้มตอนบูต) — สองโหมดให้คนละค่าโดยเจตนา ห้ามสลับกันกลางคัน
 *
 * @param {string} customerId
 * @param {string} [secret] กุญแจของ instance (config.consoleSessionSecret)
 */
export function teachCustomerHash(customerId, secret = "") {
  const id = String(customerId || "").trim();
  if (!id) return "";
  const key = String(secret || "");
  const digest = key
    ? createHmac("sha256", key).update(CUSTOMER_HASH_DOMAIN).update(id).digest("hex")
    : createHash("sha256").update(CUSTOMER_HASH_DOMAIN).update(id).digest("hex");
  return digest.slice(0, 32);
}

// ฟิลด์ที่ผูกกับ "คนคนหนึ่ง" — ต้องหายไปทั้งชุดเมื่อเจ้าของข้อมูลขอให้ลืม
// (card_ref ไม่อยู่ในรายการ: การ์ดความรู้เป็นของธุรกิจ ไม่ได้ถูกลบไปกับลูกค้า)
export const TEACH_IDENTITY_FIELDS = Object.freeze([
  "correct_text", "customer_hash", "correction_ref", "message_ref",
]);

/**
 * ลบร่องรอยของลูกค้าออกจาก teach_json — คืน object ใหม่เสมอ
 * ใช้ทั้งตอน "รุ่นจบชีวิต" และตอนใช้สิทธิ์ให้ลืม
 */
export function stripTeachIdentity(teach = {}) {
  const source = teach && typeof teach === "object" ? teach : {};
  const next = { ...source };
  let changed = false;
  for (const field of TEACH_IDENTITY_FIELDS) {
    if (field in next) { delete next[field]; changed = true; }
  }
  if (changed) next.correct_text_cleared = true;
  return { teach: next, changed };
}
