// brain/text.mjs — ตัวช่วยเล็ก ๆ ที่ทั้งสมองใช้ร่วมกัน: normalize ไทย, JSON ที่เสถียร, sha256
//
// ทำไม stableJson ต้องมี: checksum ของ bundle ต้องไม่ขึ้นกับ "ลำดับที่คีย์ถูกใส่ใน object"
// JSON.stringify ธรรมดาเรียงตามลำดับ insertion — คอมไพเลอร์ที่อ่านการ์ดมาคนละลำดับ
// จะได้ checksum คนละตัวทั้งที่เนื้อหาเหมือนกันเป๊ะ แล้ว "เวอร์ชันเดิม" จะดูเหมือนเปลี่ยน
import { createHash } from "node:crypto";

// สำเนาของ normalizeThai ใน safetyRouter.mjs:82 (ตัวนั้นยังไม่ถูก export)
// แบบแปลน P0b วางแผนย้ายไป thaiText.mjs แล้วให้ทุกเส้นเรียกตัวเดียว — เฟส 1a
// ห้ามแตะ safetyRouter (เส้นตอบลูกค้า) จึงคัดลอกมาพร้อมเทสต์ที่ผูกสองตัวไว้ด้วยกัน
// (test/brain-compile.test.mjs) ถ้าต้นฉบับเปลี่ยน เทสต์จะแดงก่อนที่ lint จะเพี้ยนเงียบ ๆ
export const ZERO_WIDTH_RE = /[\u200b-\u200f\u2060\ufeff\u00ad]/u;
export const SARA_AE_DOUBLE_RE = /\u0e40\u0e40/u;

export function normalizeThai(text) {
  return String(text || "")
    .normalize("NFC")
    .replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/gu, "")
    .replace(/\u0e40\u0e40/gu, "\u0e41");
}

// อักขระที่ normalizer จะตัดทิ้ง — L16 ใช้ตรวจว่ามีตัวไหนหลงอยู่ใน body การ์ดไหม
// (ถ้าปล่อยไว้: การ์ดผ่าน lint แต่ถูกตัดตอน runtime = คนละสตริงกับที่คนตรวจเห็น)
export function hasNormalizerCasualties(text) {
  const raw = String(text || "");
  return ZERO_WIDTH_RE.test(raw) || SARA_AE_DOUBLE_RE.test(raw) || raw.normalize("NFC") !== raw;
}

// JSON ที่เรียงคีย์ทุกชั้น — array คงลำดับเดิมเสมอ (ลำดับใน array คือข้อมูล ไม่ใช่ความบังเอิญ)
export function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

export function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function sha256Json(value) {
  return sha256(stableJson(value));
}

// เรียงแบบเดียวกับ SQLite `ORDER BY <text col>` (collation BINARY = เทียบไบต์ UTF-8)
// Array.prototype.sort เทียบ UTF-16 code unit ซึ่งต่างกันเมื่อมีอักขระนอก BMP
// ตารางราคาต้องเรียงเหมือน db.approvedPrices() ทุกแถว ไม่งั้น parity แตกแบบหายาก
export function compareSqliteText(a, b) {
  return Buffer.compare(Buffer.from(String(a), "utf8"), Buffer.from(String(b), "utf8"));
}
