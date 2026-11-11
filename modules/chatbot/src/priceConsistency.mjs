// priceConsistency.mjs — v1.3.4: กัน "กลับคำเรื่องราคาให้แพงขึ้น" ภายในบทสนทนาเดียว
//
// เหตุจริง 2026-08-13: ลูกแพรบอก "ยังไม่มีส่วนลดคู่ รวม 25,800 บาท" แล้ว 44 วินาทีต่อมา
// บอกว่า "ขอแก้ไขข้อมูลส่วนลดเมื่อสักครู่นะคะ ... รวม 23,800 บาท" — ครั้งนั้นแก้ให้ถูกลง
// ซึ่งเป็นการแก้ที่ถูกต้อง แต่กลไกเดียวกันจะปล่อยทิศทางตรงข้ามผ่านด้วย
//
// ตรวจแล้วพบว่า compliance guard ไม่มีความจำระดับเซสชันเลย และกฎ "ราคาที่อนุมัติ × จำนวนคน"
// ปล่อยผ่านทั้ง 25,800 / 23,800 / 39,800 ทั้งที่ไม่มีเลขไหนอยู่ในตารางโดยตรง แปลว่า
// "เคยบอกถูก แล้วมาบอกแพงขึ้น" ซึ่งร้ายแรงที่สุดทั้งทางความน่าเชื่อถือและทางกฎหมาย
// ไม่มีอะไรกันเลยแม้แต่ชั้นเดียว
//
// ขอบเขตที่จงใจให้แคบ: ดักเฉพาะ "ข้อความที่ประกาศว่ากำลังแก้ไขข้อมูลเดิม แล้วเสนอราคาสูงขึ้น"
// เพราะการเอ่ยราคาปกติคู่กับราคาโปรเป็นเรื่องปกติของการขาย ถ้าดักกว้างเกินจะบล็อกงานที่ถูกต้อง

// สำนวนที่ลูกแพรใช้เวลาแก้ข้อมูลที่เคยบอกไป — มาจากดราฟต์จริงและคู่มือของแอดมินคนจริง
const CORRECTION_MARKER = /(?:ขอแก้ไข|ขออภัย.{0,20}(?:แจ้ง|ข้อมูล)|ขอปรับ(?:ข้อมูล|ราคา)|แก้ไขข้อมูล|ขอทบทวน(?:ข้อมูล|ราคา)|ที่แจ้งไปก่อนหน้า|เมื่อสักครู่)/u;

// เลขที่อยู่ในบริบทราคาเท่านั้น (มี comma หรือมีคำว่าบาทตามหลัง) — เลขอื่นไม่ใช่ราคา
const PRICE_NUMBER = /(\d{1,3}(?:,\d{3})+|\d{4,7})(?=\s*(?:บาท|฿))/gu;

export function extractQuotedPrices(text) {
  const found = new Set();
  for (const match of String(text || "").matchAll(PRICE_NUMBER)) {
    const amount = Number(match[1].replace(/,/gu, ""));
    if (Number.isFinite(amount) && amount >= 100) found.add(amount);
  }
  return [...found];
}

export function announcesCorrection(text) {
  return CORRECTION_MARKER.test(String(text || ""));
}

/**
 * ตัดสินว่าข้อความขาออกนี้ "กลับคำให้แพงขึ้น" หรือไม่
 * @param {string} outboundText ข้อความที่กำลังจะส่ง
 * @param {string[]} priorOutbound ข้อความที่เคยส่งให้ลูกค้าคนนี้ในเซสชันเดียวกัน (ใหม่ -> เก่า)
 * @returns {{ raised: boolean, previous?: number, next?: number }}
 */
export function detectUpwardPriceRevision(outboundText, priorOutbound = []) {
  if (!announcesCorrection(outboundText)) return { raised: false };
  const next = extractQuotedPrices(outboundText);
  if (!next.length) return { raised: false };

  const previous = [];
  for (const message of Array.isArray(priorOutbound) ? priorOutbound : []) {
    previous.push(...extractQuotedPrices(message));
  }
  if (!previous.length) return { raised: false };

  // เทียบ "ยอดสูงสุดที่เคยแจ้ง" กับ "ยอดสูงสุดที่กำลังจะแจ้ง" — การแก้ที่ทำให้ยอดสูงขึ้น
  // คือสิ่งที่ต้องให้คนจริงตัดสิน ส่วนการแก้ให้ถูกลงปล่อยผ่านได้ (เป็นการแก้ที่ควรทำ)
  const highestBefore = Math.max(...previous);
  const highestNow = Math.max(...next);
  if (highestNow > highestBefore) return { raised: true, previous: highestBefore, next: highestNow };
  return { raised: false };
}
