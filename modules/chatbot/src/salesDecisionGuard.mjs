// Deterministic payment safety. This binds a visible course offer to its own
// explicitly labelled approved price row; semantic quality remains Jev's job.
export const PRICE_BEFORE_BANK_RULE = "กติกาปัจจุบันมีลำดับสูงกว่าขั้นตอนปิดการขายเก่า: ก่อนส่งเลขบัญชี พร้อมเพย์ QR หรือรูป payment-kbank ต้องแจ้งชื่อคอร์ส/รอบและค่าเรียนที่อนุมัติในคำตอบชุดเดียวกันก่อนบล็อกชำระเงินเสมอ หากยังยืนยันราคาไม่ได้ ห้ามส่งช่องทางชำระเงิน ให้ตอบคำถามล่าสุดหรือถามข้อมูลที่จำเป็นก่อน ห้ามเร่งโอน และเมื่อส่งบัญชีแล้วให้ตอบข้อมูลจากคลังต่อได้ แต่ห้ามยืนยันการชำระเงินหรือที่นั่งแทนคน";
export const BANK_INFO_RULE = "ห้องนี้ได้รับช่องทางชำระเงินแล้ว: ตอบคำถามรายละเอียดจากความรู้ที่อนุมัติได้ต่อ ห้ามเร่งหรือทวงโอน ห้ามส่งเลขบัญชีซ้ำเอง ห้ามยืนยันยอดโอน สลิป คืนเงิน หรือที่นั่งแทนทีมงาน";
// 18 ต.ค. 2026 (audit ลูกแพร): PRICE_BEFORE_BANK_RULE ข้างบนเรียกการ์ด "ขั้นตอนปิดการขาย" ว่า "ขั้นตอนเก่า" และสั่ง
// "ห้ามส่งช่องทางชำระเงิน" — ตั้งแต่เปิดสวิตช์ 27 ก.ย. 12:45 โมเดลไม่ร่างบล็อกบัญชีอีกเลย (ส่ง 0 ครั้ง ด่านไม่เคยต้องตัด)
// เมื่อการ์ดมีบล็อกบัญชี + ฟอร์มครบ ระบบเป็นคนประกอบข้อความชำระเงินเอง (paymentStep.mjs) และกติกานี้แทนที่ตัวบน
export const SYSTEM_PAYMENT_RULE = "ขั้นชำระเงิน (กติกาปัจจุบัน แทนวิธีส่งบล็อกบัญชีในรายการ \"ขั้นตอนปิดการขาย\"): ระบบเป็นผู้ส่งสรุปคลาส รอบ ค่าเรียน ช่องทางชำระเงิน และฟอร์มลงทะเบียนให้ลูกค้าเองทันทีที่ลูกค้าแจ้งว่าจะออกเอกสารในนามบุคคลธรรมดาหรือบริษัท — ห้ามพิมพ์เลขบัญชี ชื่อบัญชี พร้อมเพย์ QR marker รูป payment หรือฟอร์มลงทะเบียนเองเด็ดขาด · ถ้าลูกค้าพร้อมสมัคร/ขอช่องทางชำระ และยังไม่เคยบอกประเภทเอกสาร ให้ถามคำถามเดียว \"ต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?\" · ถ้าลูกค้าบอกประเภทเอกสารแล้วแต่ยังถามเรื่องอื่น ให้ตอบเรื่องนั้นให้ครบ ห้ามถามประเภทเอกสารซ้ำ · ห้ามเร่งโอน ห้ามยืนยันยอดโอน สลิป หรือที่นั่งแทนทีมงาน · ภาษี หัก ณ ที่จ่าย ผ่อนชำระ บัตรเครดิต พูดเมื่อลูกค้าถามเท่านั้น";

export function paymentInstructionsIndex(text) {
  const value = String(text || "");
  const matches = [/(?:เลข(?:ที่)?บัญชี|พร้อมเพย์|เลข\s*บัญชี)\s*[:：]?\s*\d/u, /\[IMAGE:(?:payment|bank|promptpay|qr)[a-z0-9_-]*\]/iu, /(?:สแกน|scan).{0,25}(?:QR|คิวอาร์).{0,25}(?:จ่าย|ชำระ|โอน)/iu]
    .map(pattern => value.search(pattern)).filter(index => index >= 0);
  for (const number of value.matchAll(/(?<!\d)\d(?:[\s-]?\d){7,14}(?!\d)/gu)) {
    const start = Math.max(0, number.index - 70); const label = /บัญชี|พร้อมเพย์|โอน(?:เข้า|มา|ไป|ที่)|ชำระ(?:ที่|ผ่าน)/u.exec(value.slice(start, number.index));
    if (label) matches.push(start + label.index);
  }
  return matches.length ? Math.min(...matches) : -1;
}

const normalized = value => String(value || "").toLocaleLowerCase("th-TH").replace(/[–—]/gu, "-").replace(/\s+/gu, " ").trim();
const courseNames = course => [course?.name, ...(Array.isArray(course?.aliases) ? course.aliases : [])].map(normalized).filter(Boolean);
const mentionedCourses = (text, courses) => (Array.isArray(courses) ? courses : []).filter(course => courseNames(course).some(name => normalized(text).includes(name)));
const amountsIn = text => [...String(text || "").matchAll(/(?<!\d)(\d{1,3}(?:,\d{3})+|\d+)(?:\s*)บาท/gu)].map(match => Number(match[1].replace(/,/gu, ""))).filter(Number.isSafeInteger);
function exactLabelPrefix(label, courseName) { const source = normalized(label); const course = normalized(courseName); const next = source.startsWith(course) ? source.slice(course.length, course.length + 1) : "x"; return (!next || /[\s\-(:]/u.test(next)); }
function courseEvidence(latestText, history, courses) {
  // The newest explicit customer selection supersedes an older course mention.
  // A single current turn that names multiple courses remains ambiguous.
  const evidence = [latestText, ...(Array.isArray(history) ? history.filter(turn => turn?.role === "user").reverse().map(turn => turn.content ?? turn.text) : [])];
  for (const text of evidence) {
    const matches = mentionedCourses(text, courses);
    if (matches.length) return matches;
  }
  return [];
}

// ตัวช่วยชุดเดียวกับด่านข้างล่าง — ตัวประกอบข้อความชำระเงิน (paymentStep.mjs) ต้องผูกคลาสกับราคาด้วยนิยามเดียวกันเป๊ะ
export const coursesMentionedIn = mentionedCourses;
export const customerCourseEvidence = courseEvidence;
/** แถวราคาที่ป้ายขึ้นต้นด้วยชื่อ/ชื่อเรียกของคลาสนี้ (ไม่เดาจับคู่แบบหลวม) */
export function boundPriceRows(course, approvedPrices) {
  return (Array.isArray(approvedPrices) ? approvedPrices : []).filter(row => courseNames(course).some(name => exactLabelPrefix(row?.label ?? row?.label_th, name))
    && Number.isSafeInteger(Number(row?.amount)));
}
/** ชื่อคลาสตามที่ป้ายราคาที่อนุมัติเขียนไว้ (ตัวพิมพ์เดิม) — ใช้แสดงกับลูกค้าแทนชื่อภายใน */
export function courseLabelName(course, row) {
  const names = [course?.name, ...(Array.isArray(course?.aliases) ? course.aliases : [])].filter(Boolean).map(String);
  return names.filter(name => exactLabelPrefix(row?.label ?? row?.label_th, name)).sort((a, b) => b.length - a.length)[0] || String(course?.name || "");
}

/** Generic labels, discounts, and rounds are deliberately not inferred or joined. */
export function checkPriceBeforeBank({ text, approvedAmounts, approvedPrices, courses, latestText = "", history = [] } = {}) {
  const index = paymentInstructionsIndex(text);
  if (index < 0) return { ok: true, bank: false };
  const prefix = String(text || "").slice(0, index); const allCourses = Array.isArray(courses) ? courses : [];
  const offered = mentionedCourses(prefix, allCourses);
  if (offered.length !== 1) return { ok: false, bank: true, reason: "course_missing_or_ambiguous" };
  const selected = offered[0]; const inbound = courseEvidence(latestText, history, allCourses);
  if (inbound.length > 1) return { ok: false, bank: true, reason: "customer_course_ambiguous" };
  if (inbound.length === 1 && inbound[0] !== selected) return { ok: false, bank: true, reason: "customer_course_mismatch" };
  const rows = Array.isArray(approvedPrices) ? approvedPrices : [];
  // The canonical display name can differ from a price-table label. Only a
  // declared alias is an allowed exact alternative; never fuzzy-join labels.
  const boundRows = rows.filter(row => courseNames(selected).some(name => exactLabelPrefix(row?.label ?? row?.label_th, name)) && Number.isSafeInteger(Number(row?.amount)));
  const approved = approvedAmounts instanceof Set ? approvedAmounts : new Set((approvedAmounts || []).map(Number));
  const matching = amountsIn(prefix).some(amount => approved.has(amount) && boundRows.some(row => Number(row.amount) === amount));
  return matching ? { ok: true, bank: true, course: selected.name } : { ok: false, bank: true, reason: "price_not_bound_to_course" };
}

export function isBankInfoConversation(customer) { return customer?.ai_enabled === 1 && customer?.deal_status === "awaiting_payment"; }
