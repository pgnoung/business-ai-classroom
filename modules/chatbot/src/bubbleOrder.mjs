// bubbleOrder.mjs — ลำดับข้อความ/รูป/สติกเกอร์ของหนึ่งการส่ง ใช้ร่วมกันระหว่าง LINE (lineClient) และ Facebook (facebookClient)
//
// FEEDBACK 2026-08-10: ถ้าบอลลูนสุดท้ายเป็นคำถามชวนคุยต่อ ให้ส่งรูปให้จบก่อน แล้วปิดท้ายด้วยคำถามเสมอ — จบด้วยรูปแล้วลูกค้ามักเงียบ
// 12 ต.ค. 2026: imageAfter = จำนวนบอลลูนข้อความก่อนรูป (ทักตามที่แนบรูปบรรยากาศ: คำนำ → รูป → คำชวน → คำถาม)
// รีวิวรอบ 4 (12 ต.ค.): Facebook เคยส่ง [ข้อความทั้งหมด, รูป] เสมอ — รูปบรรยากาศหลุดไปอยู่หลังคำถามปิดท้าย ห่างจากคำนำของมัน
// (ห้องในตัวอย่าง 11 ต.ค. เป็น Facebook 83 จาก 101 ห้อง) — กติกาเดียวกันทั้งสองช่องทางจึงอยู่ที่ไฟล์นี้ที่เดียว

export const ENDS_WITH_QUESTION_RE =
  /(?:[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง|กี่(?:บาท|วัน|เครื่อง|รุ่น)?|อะไร|ยังไง|อย่างไร|เท่าไหร่|เท่าไร)\s*(?:คะ|ครับ|ค่ะ|นะคะ|นะครับ)?\s*$/u;

/**
 * เรียงรายการส่ง (pure) — แต่ละรายการรูป {message, pauseSec} ตามที่ client สร้าง
 * imageAfter ถูกต้อง (1 ≤ n < จำนวนข้อความ และมีรูป) = รูปต่อจากข้อความที่ n · ไม่งั้นข้อความสุดท้ายเป็นคำถาม = รูปก่อนคำถาม ·
 * นอกนั้น = ข้อความ แล้วรูป แล้วสติกเกอร์ (กติกาเดิมทุกไบต์)
 */
export function orderOutbound({ textMsgs = [], imageMsgs = [], stickerMsgs = [], imageAfter = undefined } = {}) {
  const placed = Number.isInteger(imageAfter) && imageAfter > 0 && imageAfter < textMsgs.length && imageMsgs.length > 0;
  if (placed) return [...textMsgs.slice(0, imageAfter), ...imageMsgs, ...stickerMsgs, ...textMsgs.slice(imageAfter)];
  const lastText = textMsgs.at(-1)?.message?.text || "";
  if (imageMsgs.length && textMsgs.length && ENDS_WITH_QUESTION_RE.test(lastText)) {
    return [...textMsgs.slice(0, -1), ...imageMsgs, ...stickerMsgs, textMsgs.at(-1)];
  }
  return [...textMsgs, ...imageMsgs, ...stickerMsgs];
}
