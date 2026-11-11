// fbAdGreeting.mjs — แยก "ข้อความทักของแอด" ออกจาก "แอดมินพิมพ์เอง" (พี่ง้วงสั่งแก้ 8 พ.ย. 2026)
//
// แอด Click-to-Messenger ทักลูกค้าในนามเพจ ("สวัสดีค่ะ คุณ{ชื่อ}! ... ไม่ทราบว่า ...") จึงกลับมาเป็น echo
// หน้าตาเหมือนแอดมินพิมพ์จาก Business Suite ทุกอย่าง ของเดิมพักบอท 15 นาที ห้องจากแอดเลยรอคำตอบแรก ~16 นาทีทุกห้อง
//
// พลาดด้านนี้ = บอทพูดแทรกคนจริง จึงต้องผ่านครบทุกข้อ ไม่ผ่านหรืออ่านไม่ได้ = ถือเป็นคนพิมพ์ พักตามเดิม (fail closed):
//   1. รูปข้อความ: สวัสดี + คุณ + ชื่อ + "!" ที่ Meta เติมให้ แล้วเข้าคำถาม "ไม่ทราบว่า" ของแอด
//   2. ลูกค้าไม่ได้รอคำตอบอยู่ — แอดมินเพิ่งมาตอบห้องที่ค้าง ก็ขึ้นต้นด้วยคำทักแบบนี้ได้
//   3. ห้องเงียบมาแล้วอย่างน้อย 1 ชม. — แอดเปิดบทสนทนา แอดมินที่กำลังคุยอยู่ไม่เข้าข้อนี้
// ทาบกับ echo จริง 90 วัน (4,891 ข้อความ): ผ่าน 83 ทุกข้อความมีลูกค้าตอบภายใน 5 วินาที ไม่มีข้อความของคนจริงติดมา
export const FB_AD_GREETING_IDLE_MS = 60 * 60_000;

const AD_GREETING_SHAPE = /^สวัสดี(?:ค่ะ|ครับ)?\s*คุณ\s*[^\n!]{1,40}!\s*(?:ลูกแพร\s*นะคะ\s*)?ไม่ทราบว่า/u;
const LAST_MESSAGE_SQL = "SELECT direction, created_at FROM messages WHERE customer_id = ? AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1";

export function looksLikeAdGreeting(text) {
  return typeof text === "string" && AD_GREETING_SHAPE.test(text);
}

/** ตอนรับ echo: เรียกก่อนบันทึกแถวนี้ · อ่านย้อนหลัง: ส่ง nowMs = เวลาของแถวนั้น ลบ 1 ms เพื่อดูเฉพาะแถวก่อนหน้า */
export function isAdGreetingEcho(db, customerId, text, nowMs = Date.now()) {
  if (!looksLikeAdGreeting(text)) return false;
  try {
    const last = db.raw.prepare(LAST_MESSAGE_SQL).get(String(customerId), nowMs);
    if (!last) return true;
    if (last.direction === "in") return false;
    return nowMs - Number(last.created_at) >= FB_AD_GREETING_IDLE_MS;
  } catch {
    return false;
  }
}
