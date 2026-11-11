// shipping.mjs — ข้อมูลจัดส่งบนออเดอร์ + ตัวตรวจความถูกต้องแบบไทย (v1.1 — พี่ง้วงสั่ง 2026-08-10)
//
// ปัญหาจริงที่มาของไฟล์นี้ (เคสลูกค้า A): ลูกค้าพิมพ์เบอร์ 9 หลัก / อีเมล gmail.con
// แล้วระบบสรุปผ่านเฉย ๆ — ต่อไปทุกจุดที่รับข้อมูลจัดส่งต้องผ่านตัวตรวจนี้:
// - scorer จับข้อมูลจัดส่งจากแชท -> เก็บบนออเดอร์ + ตีธง warning ให้แอดมินเห็น
// - แอดมิน key เอง/แก้ใน console -> เห็น warning สด ๆ ใต้ฟอร์ม
// - AI ฝั่งตอบลูกค้า มีกติกาใน prompt ให้ทวนเช็คก่อนสรุป (pipeline baseRules)
// ตัวตรวจ "เตือนอย่างเดียว" — ไม่บล็อกการบันทึก (ข้อมูลจริงบางเคสตั้งใจไม่ครบ
// เช่น รับหน้าร้าน) — คนเป็นผู้ตัดสินเสมอ

export const SHIPPING_FIELD_MAX = Object.freeze({ name: 100, phone: 30, address: 300, email: 100 });

// 77 จังหวัด — ใช้เช็คว่า "ที่อยู่มีจังหวัดจริงหรือเปล่า" (สะกดตรงเท่านั้น — สะกดผิดจะโดนเตือน)
export const THAI_PROVINCES = Object.freeze([
  "กรุงเทพมหานคร", "กรุงเทพฯ", "กรุงเทพ", "กระบี่", "กาญจนบุรี", "กาฬสินธุ์", "กำแพงเพชร",
  "ขอนแก่น", "จันทบุรี", "ฉะเชิงเทรา", "ชลบุรี", "ชัยนาท", "ชัยภูมิ", "ชุมพร", "เชียงราย",
  "เชียงใหม่", "ตรัง", "ตราด", "ตาก", "นครนายก", "นครปฐม", "นครพนม", "นครราชสีมา",
  "นครศรีธรรมราช", "นครสวรรค์", "นนทบุรี", "นราธิวาส", "น่าน", "บึงกาฬ", "บุรีรัมย์",
  "ปทุมธานี", "ประจวบคีรีขันธ์", "ปราจีนบุรี", "ปัตตานี", "พระนครศรีอยุธยา", "อยุธยา",
  "พะเยา", "พังงา", "พัทลุง", "พิจิตร", "พิษณุโลก", "เพชรบุรี", "เพชรบูรณ์", "แพร่",
  "ภูเก็ต", "มหาสารคาม", "มุกดาหาร", "แม่ฮ่องสอน", "ยโสธร", "ยะลา", "ร้อยเอ็ด", "ระนอง",
  "ระยอง", "ราชบุรี", "ลพบุรี", "ลำปาง", "ลำพูน", "เลย", "ศรีสะเกษ", "สกลนคร", "สงขลา",
  "สตูล", "สมุทรปราการ", "สมุทรสงคราม", "สมุทรสาคร", "สระแก้ว", "สระบุรี", "สิงห์บุรี",
  "สุโขทัย", "สุพรรณบุรี", "สุราษฎร์ธานี", "สุรินทร์", "หนองคาย", "หนองบัวลำภู",
  "อ่างทอง", "อำนาจเจริญ", "อุดรธานี", "อุตรดิตถ์", "อุทัยธานี", "อุบลราชธานี",
]);

// โดเมนอีเมลที่คนพิมพ์ผิดบ่อย -> คำที่น่าจะตั้งใจพิมพ์ (เคสจริง: gmail.con)
const EMAIL_TYPO_DOMAINS = Object.freeze({
  "gmail.con": "gmail.com", "gmail.co": "gmail.com", "gmial.com": "gmail.com",
  "gamil.com": "gmail.com", "gmall.com": "gmail.com",
  "hotmail.con": "hotmail.com", "hotmial.com": "hotmail.com",
  "yahoo.con": "yahoo.com", "outlook.con": "outlook.com",
});

const trim = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ค่าที่ลูกค้าพิมพ์เองก่อนแทรกลงข้อความเตือน (โน้ต/prompt เห็นต่อ) — ยุบ whitespace + จำกัดสั้น
const quoteSafe = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 60);

// รับก้อน shipping จากทุกทาง (scorer/console) -> ทรงมาตรฐาน หรือ null ถ้าว่างเปล่า
// ไม่ throw เด็ดขาด — ข้อมูลจัดส่งพังห้ามลากออเดอร์/แชทล้ม
export function normalizeShipping(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const shipping = {
    name: trim(raw.name, SHIPPING_FIELD_MAX.name),
    phone: trim(raw.phone, SHIPPING_FIELD_MAX.phone),
    address: trim(raw.address, SHIPPING_FIELD_MAX.address),
    email: trim(raw.email, SHIPPING_FIELD_MAX.email),
  };
  return shipping.name || shipping.phone || shipping.address || shipping.email ? shipping : null;
}

/* ------------------------------- ตัวตรวจรายช่อง ------------------------------ */

// เบอร์ไทย: มือถือ 10 หลักขึ้น 06/08/09, บ้าน/สำนักงาน 9 หลักขึ้น 02-07; รับ +66 ด้วย
export function checkThaiPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "").replace(/^66/, "0");
  if (!digits) return { ok: false, warning: null }; // ไม่มีเบอร์ = ช่องว่าง ไม่ใช่เบอร์ผิด
  if (/^0[689]\d{8}$/.test(digits)) return { ok: true, digits };
  if (/^0[2-7]\d{7}$/.test(digits)) return { ok: true, digits };
  // ขึ้นต้นแบบมือถือ (06/08/09) แต่ไม่ครบ 10 หลัก = เคสพิมพ์ตก/เกินที่เจอบ่อยสุด — บอกจำนวนหลักตรง ๆ
  const detail = /^0[689]/.test(digits) && digits.length !== 10
    ? `มี ${digits.length} หลัก (มือถือต้อง 10 หลัก)`
    : "รูปแบบไม่ตรงเบอร์ไทย (มือถือ 10 หลัก / เบอร์บ้าน 9 หลัก)";
  return { ok: false, digits, warning: `เบอร์โทร "${quoteSafe(phone)}" ${detail} — ทวนกับลูกค้าอีกครั้ง` };
}

// รหัสไปรษณีย์ไทย: 5 หลัก 10xxx-96xxx
export function checkThaiPostal(postal) {
  const digits = String(postal || "").replace(/\D/g, "");
  if (!digits) return { ok: false, warning: null };
  if (/^\d{5}$/.test(digits) && Number(digits.slice(0, 2)) >= 10 && Number(digits.slice(0, 2)) <= 96) {
    return { ok: true, digits };
  }
  return { ok: false, digits, warning: `รหัสไปรษณีย์ "${quoteSafe(postal)}" ไม่ใช่รหัสไทยที่ถูกต้อง (5 หลัก 10xxx-96xxx)` };
}

export function checkEmail(email) {
  const value = String(email || "").trim();
  if (!value) return { ok: false, warning: null };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    return { ok: false, warning: `อีเมล "${quoteSafe(value)}" รูปแบบไม่ถูกต้อง` };
  }
  const domain = value.split("@")[1].toLowerCase();
  const fixed = EMAIL_TYPO_DOMAINS[domain];
  if (fixed) {
    return { ok: false, warning: `อีเมลลงท้าย "${quoteSafe(domain)}" — น่าจะตั้งใจพิมพ์ "${fixed}" ทวนกับลูกค้าก่อน` };
  }
  return { ok: true };
}

/* --------------------------- warning รวมต่อออเดอร์ --------------------------- */

// คืน [] เมื่อไม่มีอะไรน่าห่วง — ช่องที่ "ว่าง" ไม่เตือน (คนตัดสินว่าต้องครบไหม)
// ยกเว้น: มีที่อยู่แต่หา จังหวัด/ปณ. ไม่เจอ = เตือน (ที่อยู่ส่งของจริงต้องมีสองอย่างนี้)
export function shippingWarnings(shipping) {
  const s = normalizeShipping(shipping);
  if (!s) return [];
  const warnings = [];
  const phone = checkThaiPhone(s.phone);
  if (phone.warning) warnings.push(phone.warning);
  const email = checkEmail(s.email);
  if (email.warning) warnings.push(email.warning);
  if (s.address) {
    const postal = checkThaiPostal((s.address.match(/\b(\d{5})\b/) || [])[1] || "");
    if (!postal.ok) {
      warnings.push(postal.warning || "ที่อยู่ยังไม่มีรหัสไปรษณีย์ 5 หลัก — ขอลูกค้าเพิ่ม");
    }
    if (!THAI_PROVINCES.some((p) => s.address.includes(p))) {
      warnings.push("ที่อยู่ยังไม่พบชื่อจังหวัด (หรือสะกดไม่ตรง) — ทวนกับลูกค้าอีกครั้ง");
    }
  }
  return warnings;
}

// ป้ายสรุปสั้น ๆ สำหรับโน้ต/CSV/webhook — บรรทัดเดียว อ่านรู้เรื่องใน Excel
export function shippingLabel(shipping) {
  const s = normalizeShipping(shipping);
  if (!s) return "";
  return [s.name, s.phone, s.address, s.email].filter(Boolean).join(" · ");
}

// parse จากคอลัมน์ shipping_json (DB) — พัง/ว่าง = null เงียบ ๆ
export function parseShippingJson(json) {
  if (!json) return null;
  try {
    return normalizeShipping(JSON.parse(json));
  } catch {
    return null;
  }
}
