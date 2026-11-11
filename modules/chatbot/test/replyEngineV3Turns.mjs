// replyEngineV3Turns.mjs — 25 เทิร์นสังเคราะห์ที่ล็อก "สวิตช์ปิด = คำขอถึงสมองเดิมทุกไบต์"
// ครอบทุกจังหวะที่เครื่องตอบ v3 แตะ (ทักครั้งแรก ราคา ส่วนลด ข้อกังวล ลา ส่งต่อทีม เงิน ออนไลน์ หลายข้อความ ฯลฯ)
// และเส้น redraft (คำแบน) — ห้ามแก้ข้อความในไฟล์นี้หลังบันทึก hash แล้ว (ต้องบันทึกใหม่จาก commit ก่อนแก้โค้ด)
const user = (content) => ({ role: "user", content });
const bot = (content) => ({ role: "assistant", content });
const admin = (content) => ({ role: "assistant", content, operator: "chompoo" });

const LADDER_ASK = "สวัสดีค่ะ ลูกแพรเป็นผู้ช่วยของพี่ง้วงค่ะ\n\nไม่ทราบว่าเคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ?\n\n1️⃣ ยังไม่เคยใช้เลย\n\n2️⃣ เคยลองเล่นนิดหน่อย\n\n3️⃣ ใช้ช่วยงานจริงบ้างแล้ว\n\n4️⃣ ใช้ประจำ\n\n5️⃣ สร้าง AI ขององค์กรเอง";
const AFTER_LEVEL = [bot(LADDER_ASK), user("3 ค่ะ"), bot("ดีเลยค่ะ ใช้กับงานจริงมาแล้ว ปกติทำงานหรือธุรกิจด้านไหนอยู่คะ?")];
const QUOTED = [...AFTER_LEVEL, user("ทำร้านกาแฟค่ะ ราคาเท่าไหร่คะ"),
  bot("ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n\n📌 AI Agent for Business\nราคาปกติ 19,900 บาท\nโปรโมชั่น Early Bird 12,900 บาท/ท่าน")];
const ON = { natural_voice_mode: "on" };

export const LEGACY_IDENTITY_TURNS = Object.freeze([
  { id: "t01-first-price", text: "ราคาเทอมละเท่าไหร่คะ", settings: ON },
  { id: "t02-first-interest", text: "สนใจคลาส AI ค่ะ", settings: ON },
  { id: "t03-ladder-answer", history: [bot(LADDER_ASK)], text: "3", settings: ON },
  { id: "t04-tool-answer", history: AFTER_LEVEL, text: "ใช้ ChatGPT ค่ะ", settings: ON },
  { id: "t05-low-confidence", history: AFTER_LEVEL, text: "ยังไม่เก่งเลยค่ะ มือใหม่มาก กลัวตามไม่ทัน", settings: ON },
  { id: "t06-concept", history: AFTER_LEVEL, text: "AI Agent คืออะไรคะ", settings: ON },
  { id: "t07-goal", history: AFTER_LEVEL, text: "ขายของออนไลน์ค่ะ อยากให้ AI ช่วยทำโพสต์กับรูปสินค้า", settings: ON },
  { id: "t08-price-after-level", history: AFTER_LEVEL, text: "ราคาเท่าไหร่คะ", settings: ON },
  { id: "t09-pair-discount", history: QUOTED, text: "มา 2 คนลดได้ไหมคะ", settings: ON },
  { id: "t10-single-discount", history: QUOTED, text: "ลดได้อีกไหมคะ", settings: ON },
  { id: "t11-objection", history: QUOTED, text: "แพงไปนิดค่ะ เกินงบ", settings: ON },
  { id: "t12-location", history: AFTER_LEVEL, text: "เรียนที่ไหนคะ จอดรถได้ไหม", settings: ON },
  { id: "t13-rounds", history: QUOTED, text: "มีรอบไหนบ้างคะ", settings: ON },
  { id: "t14-goodbye", history: QUOTED, text: "ขอบคุณค่ะ ไว้โอกาสหน้านะคะ", settings: ON },
  { id: "t15-misread", history: [...AFTER_LEVEL, user("หาข้อมูลค่ะ"), bot("แบบนี้ต่อยอดไปทำ Workflow เชื่อมระบบได้ค่ะ")], text: "ไม่ใช่ค่ะ หมายถึงอยากใช้ AI ตัวอื่นให้เก่งขึ้น", settings: ON },
  { id: "t16-checklist", history: AFTER_LEVEL, text: "ขอเช็คลิสต์สิ่งที่ต้องเตรียมหน่อยค่ะ", settings: ON },
  { id: "t17-booking", history: QUOTED, text: "ขอจองรอบหน้าเลยค่ะ", settings: ON },
  { id: "t18-contact-team", history: QUOTED, text: "ขอเบอร์ทีมงานหน่อยค่ะ", settings: ON },
  { id: "t19-in-house", history: AFTER_LEVEL, text: "อยากให้ไปสอนที่บริษัท ทีม 20 คนค่ะ", settings: ON },
  { id: "t20-payment", history: QUOTED, text: "โอนเงินยังไงคะ ขอเลขบัญชีหน่อย", settings: ON },
  { id: "t21-online", history: AFTER_LEVEL, text: "มีคลาสออนไลน์แบบดูย้อนหลังไหมคะ", settings: ON },
  { id: "t22-burst", history: AFTER_LEVEL, parts: ["ทำบัญชีค่ะ", "อยากให้ช่วยสรุปเอกสาร", "จริงจังค่ะ"], settings: ON },
  { id: "t23-named-classic", customer: { knownName: "มินตรา" }, history: [bot(LADDER_ASK), user("4 ค่ะ")], text: "ใช้ Gemini ทุกวันค่ะ", settings: {} },
  { id: "t24-banned-word-redraft", history: AFTER_LEVEL, text: "ทำร้านดอกไม้ค่ะ", settings: ON,
    replies: ["คลาสนี้ดีที่สุดสำหรับร้านดอกไม้เลยค่ะ อยากให้ AI ช่วยงานไหนก่อนคะ?", "คลาสนี้เหมาะกับร้านดอกไม้มากค่ะ อยากให้ AI ช่วยงานไหนก่อนคะ?"] },
  { id: "t25-admin-promise", history: [...QUOTED, admin("ทีมงานให้ราคา Early Bird ไว้จนถึงสิ้นเดือนนะคะ")], text: "ยังได้ราคานั้นอยู่ไหมคะ", settings: ON },
]);
