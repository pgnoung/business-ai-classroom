// ชุดข้อมูลสังเคราะห์ของเทสต์ขั้นชำระเงิน (paymentStep) — รูปแบบการ์ด/ราคา/รอบตามของจริง เลขบัญชีปลอม
export const CLOSING_CARD = {
  title: "ขั้นตอนปิดการขาย: บัญชี + ฟอร์มลงทะเบียน + AI ปิดจังหวะเงิน (พี่ง้วงแก้ 2026-08-16)",
  content: `กติกาสูงสุดของขั้นตอนนี้: คำถามเดียวที่อนุญาตให้ถามก่อนแจ้งเลขบัญชี คือ "ออกเอกสารในนามบุคคลธรรมดาหรือบริษัท"

ขั้นที่ 2 — ทันทีที่รู้คำตอบขั้นที่ 1: ข้อความถัดไปต้องมีบล็อกบัญชีเสมอ

บล็อกแจ้งบัญชี ส่งตามรูปแบบนี้เป๊ะ ๆ พร้อมแนบ marker [IMAGE:payment-kbank]:

สามารถโอนชำระได้ที่บัญชีนี้นะคะ

ธนาคาร : กสิกรไทย
เลขที่บัญชี : 000-0-00000-0
ชื่อบัญชี : บจก. ตัวอย่าง

จากนั้น "บอลลูนถัดไปทันที" (ไม่ต้องรอลูกค้าแจ้งโอน)
ส่งฟอร์มนี้ตามตัวอักษรทั้งก้อน:

แจ้งโอนแล้ว ลูกแพรขออนุญาตรบกวน ขอข้อมูลเพิ่มเติมนะคะ

🖋️ ข้อมูลลงทะเบียน

- ชื่อ-นามสกุล* :
- ชื่อเล่น :
- E-mail* :
- เบอร์โทร* :
- สิ่งที่คาดหวังในการเรียน* :

ขอบพระคุณมากค่ะ 🙏🏻😊

ขั้นที่ 3 — เมื่อลูกค้าแจ้งโอนหรือส่งสลิป ระบบจะปิด AI`,
};
export const COURSES = [
  { id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic", "AI for Business"] },
  { id: "ai-workflow-automation", type: "group_live", name: "AI Workflow Automation", aliases: ["AI Advance", "AI Agent Workflow Automation"] },
];
export const PRICES = [
  { label: "AI Agent for Business — Early Bird", amount: 12900 },
  { label: "AI Agent for Business — Early Bird เมื่อมา 2 ท่านขึ้นไป (ลด 1,000)", amount: 11900 },
  { label: "AI Agent Workflow Automation — Early Bird", amount: 15900 },
  { label: "AI Agent Workflow Automation — หลังส่วนลดนักเรียนเก่า Online", amount: 12900 },
  { label: "Classroom (ทั้ง 2 คลาส) — ราคาปกติ", amount: 19900 },
];
export const AMOUNTS = new Set(PRICES.map((row) => row.amount));
const round = (date, product, extra = {}) => ({ date, product, label: `Classroom ${product}`, fileStatus: "open", seatsLeft: 9, ...extra });
export const ROUNDS = [
  round("2026-11-14", "AI Agent for Business"), round("2026-11-21", "AI Agent for Business"),
  round("2026-12-19", "AI Agent for Business"), round("2026-11-28", "AI Agent Workflow Automation"),
];
