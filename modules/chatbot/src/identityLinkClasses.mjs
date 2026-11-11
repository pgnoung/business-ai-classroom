// identityLinkClasses.mjs — คลาสที่ลูกค้าซื้อ + ข้อความถึงลูกค้าของการเชื่อม Facebook → LINE (ฟังก์ชันบริสุทธิ์)
//
// คำตอบพี่ง้วง 28 ก.ย. 2026 (~21:30) ต่อข้อความชุดแรก:
//   1) ข้อความเชิญ "vary ตามคลาสที่ลงไป" — ออนไลน์ = ลงทะเบียนเข้าเรียนที่ LINE · สอนสด = เอกสาร/เตรียมตัว/กลุ่ม support ทาง LINE
//   3) ลูกค้าที่ยังไม่ซื้อ "ให้อยู่ที่ facebook ก่อน" — ไม่มีข้อความเชิญแบบนั้นอีกแล้ว (ไม่มีทุกที่)
//   4) หลังเชื่อม "สวัสดีค่ะ คุณ xxxx แล้วส่งรายละเอียดตามสิ่งที่เค้าซื้อได้เลย" — ออนไลน์ = ข้อมูลลงทะเบียน · สอนสด = การเตรียมตัว
//   5) รหัสใช้ไม่ได้ "ไม่ต้องครับ" — ไม่ตอบลูกค้าเลย (ปักธงให้ทีมอย่างเดียว — identityLink.mjs)
// รายละเอียดของแต่ละคลาสเป็นข้อความตายตัวที่เจ้าของอนุมัติ แก้ได้ในคอนโซลโดยไม่ต้อง deploy (identityLink.mjs เก็บใน settings)
// ค่าเริ่มต้นร่างจากคลังความรู้ที่อนุมัติแล้วเท่านั้น (สมองรุ่นที่ใช้จริง + ความรู้ที่ทีมยืนยัน อ่านแบบอ่านอย่างเดียว 28 ก.ย.)
//   · ไม่มีราคา/โปร · ไม่แต่งขั้นตอนเอง — คลาสออนไลน์ใช้ข้อมูลลงทะเบียนจากคู่มือแชทของชมพู่ (30 ก.ย. พี่ง้วงให้ร่าง)
import { planCustomerAddress } from "./customerAddress.mjs";
import { normalizeLineBasicId } from "./identityLinkCodes.mjs";

// 30 ก.ย. 2026 (พี่ง้วง: "ออนไลน์ให้อิงตามคลาส ส่วนใหญ่เป็น AI 99% อาจมี fb หรือ LINE ด้วยนิดหน่อย"):
// เพิ่มคอร์สออนไลน์ Facebook Ads / LINE OA รุ่นเก่าไว้ท้ายรายการ (มีคนซื้อน้อย) — ข้อความเชิญ/ลงทะเบียนของแต่ละคลาสแยกกัน
export const IDENTITY_CLASS_TYPES = Object.freeze(["online", "live_business", "live_workflow", "live_private", "online_fb", "online_line"]);

// label = ชื่อที่ทีมเห็นในปุ่มเลือก/แจ้งเตือน · format = ข้อความเชิญชุดไหน · inviteName = ชื่อคลาสในข้อความถึงลูกค้า
export const IDENTITY_CLASSES = Object.freeze({
  online: Object.freeze({
    type: "online", format: "online", label: "AI Agent for Business Online", inviteName: "คลาส AI Agent for Business Online",
    hint: "คลาสออนไลน์ (VDO on demand) — การ์ดที่อนุมัติยังเรียกคอร์สนี้ว่า \"สร้างกองทัพ AI ด้วย Custom GPTs\"",
  }),
  live_business: Object.freeze({
    type: "live_business", format: "live", label: "Classroom AI Agent for Business", inviteName: "คลาส AI Agent for Business",
    hint: "คลาสสอนสด 1 วัน (พื้นฐาน)",
  }),
  live_workflow: Object.freeze({
    type: "live_workflow", format: "live", label: "Classroom AI Agent Workflow Automation", inviteName: "คลาส AI Agent Workflow Automation",
    hint: "คลาสสอนสด 1 วัน (ต่อยอด)",
  }),
  live_private: Object.freeze({
    type: "live_private", format: "live", label: "Private Class / In-house", inviteName: "Private Class / In-house",
    hint: "สอนสดส่วนตัว หรืออบรมทีมในองค์กร",
  }),
  online_fb: Object.freeze({
    type: "online_fb", format: "online", label: "Facebook Ads Online", inviteName: "คลาส Facebook Ads Online",
    hint: "คลาสออนไลน์ยิงแอด Facebook (คอร์สรุ่นเก่า มีคนซื้อไม่มาก)",
  }),
  online_line: Object.freeze({
    type: "online_line", format: "online", label: "LINE OA Online", inviteName: "คลาส LINE OA Online",
    hint: "คลาสออนไลน์ LINE OA (คอร์สรุ่นเก่า มีคนซื้อไม่มาก)",
  }),
});

export function normalizeClassType(value) {
  const text = String(value ?? "");
  return IDENTITY_CLASS_TYPES.includes(text) ? text : "";
}

export const classLabel = (type) => IDENTITY_CLASSES[type]?.label || "";

/* ------------------------------ อ่านคลาสจากหลักฐาน ------------------------------ */

// ชื่อสินค้าบนออเดอร์ / ป้าย "ซื้อแล้ว: …" / ป้าย "สนใจ: …" (ทั้งกรอบใหม่และป้ายข้อความอิสระรุ่นเก่า)
// หนึ่งข้อความ = คลาสเดียว เรียงความสำคัญ private > workflow > online > business
//   ("In-house training: AI Agent for Business" คืองาน in-house · "AI Agent for Business Online" คือออนไลน์
//    · "AI Agent Workflow Automation — หลังส่วนลดนักเรียนเก่า Online" คือคลาส Workflow ที่ลดให้นักเรียนออนไลน์เก่า)
// ไม่ใช่คลาส: consult/ที่ปรึกษา · บรรทัดส่วนลด/โบนัสบนออเดอร์ · ปฏิเสธ
// 30 ก.ย. 2026: คอร์สออนไลน์ LINE OA / Facebook Ads รุ่นเก่า = คลาสของมันเอง (online_line / online_fb) ไม่ใช่ออนไลน์ AI
const NEGATIVE = /(ยังไม่สนใจ|ไม่สนใจ|ไม่เรียน|ปฏิเสธ)/u;
const NOT_A_CLASS = /(consult|คอนซัล|ที่ปรึกษา|วิทยากร)|^\s*(ส่วนลด|มูลค่าโบนัส|โบนัส|bonus|discount)/iu;
// คลาส LINE OA / Facebook Ads ออนไลน์รุ่นเก่า — ไม่ใช่คลาสออนไลน์ AI (Facebook ก่อน: "ยิงแอด Facebook ผ่าน LINE" = คอร์สแอด)
const OLD_FB_COURSE = /(?<![a-z])(fb|facebook)(?![a-z])|ยิงแอด/iu;
const OLD_LINE_COURSE = /(?<![a-z])line(?![a-z])|(?<!ออน)ไลน์/iu;
const PRIVATE = /(private|ไพรเวท|in[\s_-]*house|อินเฮาส์|คลาสส่วนตัว|เรียนส่วนตัว|สอนส่วนตัว)/iu;
const ONLINE = /(online|ออนไลน์|custom\s*gpts?|กองทัพ|on\s*demand)/iu;
const WORKFLOW = /(workflow|automation|ai\s*advance|make\.com|(?<![a-z])make(?![a-z])|stage\s*6|(?<![a-z])m3(?![a-z0-9]))/iu;
const BUSINESS = /(ai\s*agent\s*(for|4)\s*business|ai\s*for\s*business|ai\s*basic|gen\s*ai\s*classroom|classroom\s*ai\s*agent|(?<![a-z])ai\s*agent(?![a-z]))/iu;

export function classTypeFromText(text) {
  const value = String(text ?? "").trim();
  if (!value || NEGATIVE.test(value) || NOT_A_CLASS.test(value)) return "";
  if (PRIVATE.test(value)) return "live_private";
  if (WORKFLOW.test(value)) return "live_workflow";
  if (ONLINE.test(value)) {
    if (OLD_FB_COURSE.test(value)) return "online_fb";
    if (OLD_LINE_COURSE.test(value)) return "online_line";
    return "online";
  }
  if (BUSINESS.test(value)) return "live_business";
  return "";
}

/* --------------------------------- ข้อความเชิญ --------------------------------- */

// ชื่อเรียกแบบสั้น (ชื่อต้นคำเดียว ไม่มีคำนำหน้า/นามสกุล) — ไม่รู้ชื่อ = "" (ตัด "คุณ{ชื่อ}" ทิ้งทั้งก้อน)
export function customerCallName({ knownName = "", displayName = "" } = {}) {
  const plan = planCustomerAddress({ knownName, displayName });
  return plan.generic ? "" : plan.label;
}

/**
 * ข้อความเชิญทาง Facebook (ลูกค้าที่ซื้อแล้วเท่านั้น) — คลาสไม่รู้จัก = "" (ไม่มีข้อความสำหรับคนที่ยังไม่ซื้อ)
 * 30 ก.ย. 2026 (พี่ง้วง: "ปรับคำพูดให้เหมาะกับการที่ให้ลูกค้าจะแอดไลน์เข้าไป"): บอกชื่อคลาสที่ซื้อ · ทำไมต้องไป LINE
 * 30 ก.ย. 2026 เช้า (พี่ง้วงทดลองจริงสองรอบ: ลิงก์ line.me จาก Messenger กดไม่ได้ + "ยาวไป คนไม่สังเกต ไม่ดู ... ส่งเป็น 2 บอลลูน"):
 *   บอลลูนแรกสั้น — วิธีหลักคือแอดไลน์ @ไอดี แล้วส่งรหัสที่เห็นอยู่ตรงนั้น (กดค้างคัดลอกทั้งข้อความไปวางใน LINE ก็ได้
 *   ระบบหารหัสเจอเองทุกตำแหน่ง) · บอลลูนที่สองเป็นลิงก์ล้วน (Messenger ขึ้นเป็นลิงก์ใหญ่กดง่าย) = ทางลัดเมื่อเปิดแอป LINE ได้
 *   ลิงก์ line.me ในเบราว์เซอร์ของ Messenger ค้างหน้า "Open LINE to continue" — จึงห้ามให้ลิงก์เป็นทางเดียว
 */
export function identityInviteText({ classType = "", code = "", basicId = "", knownName = "", displayName = "" } = {}) {
  const info = IDENTITY_CLASSES[normalizeClassType(classType)];
  if (!info) return "";
  const who = customerCallName({ knownName, displayName });
  const lineId = normalizeLineBasicId(basicId);
  const what = info.format === "online" ? "ขั้นตอนลงทะเบียนเข้าเรียน" : "รายละเอียดการเตรียมตัวก่อนเรียน";
  return [
    // ชื่อขึ้นต้นด้วยอังกฤษ (Private Class) ต้องเว้นวรรคจากคำไทยข้างหน้า
    `ขอบคุณที่ลงทะเบียน${/^[A-Za-z]/u.test(info.inviteName) ? " " : ""}${info.inviteName} กับพี่ง้วงนะคะ 🙏`,
    `${what}และกลุ่ม support อยู่ที่ LINE ค่ะ`,
    "",
    `👉 รบกวน${who ? `${who} ` : ""}แอดไลน์ ${lineId} แล้วส่งรหัสนี้มาในแชทนะคะ`,
    `รหัส: ${code}`,
    "",
    "หรือกดลิงก์ด้านล่าง ระบบใส่รหัสให้แล้ว กด \"ส่ง\" ได้เลยค่ะ",
  ].join("\n");
}

/** ข้อความที่ส่งจริงทาง Facebook: บอลลูนคำเชิญ (มีรหัส) + บอลลูนลิงก์ล้วน (Messenger ขึ้นเป็นลิงก์ใหญ่) */
export function identityInviteBubbles(text, url) {
  return [String(text || ""), String(url || "")].filter(Boolean);
}

/* ------------------------- ข้อความของคลาส (หลังเชื่อมใน LINE) ------------------------- */

// bubbleChars = แตกเองเมื่อบับเบิลเดียวยาวเกิน (อ่านบนมือถือสบาย) · lineChars = เพดานของ LINE ต่อข้อความ
// maxBubbles = reply หนึ่งครั้งส่งได้ 5 ข้อความ (ส่งฟรีด้วย reply token) · totalChars = กันวางเอกสารทั้งเล่ม
export const IDENTITY_TEMPLATE_LIMITS = Object.freeze({ maxBubbles: 5, bubbleChars: 2_000, lineChars: 5_000, totalChars: 6_000 });
const SEPARATOR = /^[ \t]*-{3,}[ \t]*$/mu;

function cleanTemplate(text) {
  return String(text ?? "")
    .replace(/\r\n?/gu, "\n")
    // ตัวควบคุมที่มองไม่เห็น (ยกเว้นขึ้นบรรทัด/แท็บ) — มาจากการคัดลอกวาง ไม่ใช่เนื้อความ
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b\u2028\u2029\ufeff]/gu, "")
    .split("\n").map((line) => line.replace(/[ \t]+$/u, "")).join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

// ก้อนที่ยาวเกิน = แตกตามย่อหน้า → ตามบรรทัด → ตัดตรง ๆ (ทางสุดท้าย)
function splitLong(part, max) {
  if (part.length <= max) return [part];
  const out = [];
  let current = "";
  const pushPiece = (piece, joiner) => {
    if (!current) { current = piece; return; }
    if (current.length + joiner.length + piece.length <= max) { current += joiner + piece; return; }
    out.push(current);
    current = piece;
  };
  for (const paragraph of part.split("\n\n")) {
    if (paragraph.length <= max) { pushPiece(paragraph, "\n\n"); continue; }
    for (const line of paragraph.split("\n")) {
      if (line.length <= max) { pushPiece(line, "\n"); continue; }
      for (let i = 0; i < line.length; i += max) pushPiece(line.slice(i, i + max), "");
    }
  }
  if (current) out.push(current);
  return out;
}

/** ข้อความของคลาส → บับเบิล (บรรทัดที่มีแค่ --- = บับเบิลใหม่) */
export function splitTemplateBubbles(text) {
  return cleanTemplate(text).split(SEPARATOR)
    .map((part) => part.trim()).filter(Boolean)
    .flatMap((part) => splitLong(part, IDENTITY_TEMPLATE_LIMITS.bubbleChars));
}

/** ตรวจก่อนบันทึก — ว่างได้ (= ยังไม่มีข้อความ ระบบบอกลูกค้าว่าทีมงานจะส่งให้ + ปักธงทีม) */
export function validateTemplateText(text) {
  const cleaned = cleanTemplate(text);
  if (cleaned.length > IDENTITY_TEMPLATE_LIMITS.totalChars) {
    return { ok: false, text: cleaned, bubbles: [], error: `ยาวเกิน ${IDENTITY_TEMPLATE_LIMITS.totalChars.toLocaleString("en-US")} ตัวอักษร — ตัดให้สั้นลงก่อนบันทึก` };
  }
  const bubbles = splitTemplateBubbles(cleaned);
  if (bubbles.length > IDENTITY_TEMPLATE_LIMITS.maxBubbles) {
    return { ok: false, text: cleaned, bubbles, error: `แตกได้ ${bubbles.length} ข้อความ — LINE ตอบกลับได้ครั้งละไม่เกิน 5 ข้อความ ลดเส้น --- หรือตัดให้สั้นลง` };
  }
  return { ok: true, text: cleaned, bubbles, error: "" };
}

// ข้อความตามคำสั่งพี่ง้วงเมื่อยังไม่มีรายละเอียดของคลาสนั้น (ทีมถูกปักธงให้ส่งเอง)
export function welcomeFallbackText(classType) {
  const info = IDENTITY_CLASSES[normalizeClassType(classType)];
  if (!info) return "ทีมงานจะส่งรายละเอียดให้ในแชทนี้นะคะ";
  return info.format === "online"
    ? "ทีมงานจะส่งขั้นตอนลงทะเบียนให้ในแชทนี้นะคะ"
    : "ทีมงานจะส่งรายละเอียดการเตรียมตัวก่อนเรียนให้ในแชทนี้นะคะ";
}

/**
 * ข้อความตอบกลับใน LINE หลังลูกค้าที่ซื้อแล้วเชื่อมแชท — คำทักทายรวมอยู่บับเบิลแรก (ไม่กินที่บับเบิลที่ห้า)
 * @returns {{bubbles: string[], usedTemplate: boolean}} usedTemplate=false = ส่งแค่คำทักทาย + บอกว่าทีมงานจะส่งให้
 */
export function identityWelcomeBubbles({ classType = "", template = "", knownName = "", displayName = "" } = {}) {
  const who = customerCallName({ knownName, displayName });
  const greeting = `สวัสดีค่ะ${who ? ` ${who}` : ""} 🙏`;
  const { maxBubbles, lineChars } = IDENTITY_TEMPLATE_LIMITS;
  let parts = splitTemplateBubbles(template);
  const usedTemplate = parts.length > 0;
  if (!usedTemplate) parts = [welcomeFallbackText(classType)];
  // ข้อความที่บันทึกไว้ก่อนมีเพดาน/ยาวเกิน: รวมส่วนเกินเข้าบับเบิลสุดท้าย แล้วตัดที่เพดานของ LINE
  if (parts.length > maxBubbles) parts = [...parts.slice(0, maxBubbles - 1), parts.slice(maxBubbles - 1).join("\n\n")];
  const bubbles = parts.map((part, index) => (index === 0 ? `${greeting}\n${part}` : part))
    .map((part) => (part.length > lineChars ? `${part.slice(0, lineChars - 1)}…` : part));
  return { bubbles, usedTemplate };
}

// ค่าเริ่มต้น (ร่างจากคลังที่อนุมัติ — รอพี่ง้วงอนุมัติถ้อยคำ แก้ได้ในหน้าตั้งค่า):
//   เวลา 10:00-17:00 · EZ Space ถ.เทพารักษ์ ใกล้ Mega Bangna · จอดฟรีทั้งวัน · BTS ศรีเทพา + Grab ~5 นาที · อาหารกลางวัน/เบรก
//   · การเตรียมตัวต่อคลาส (ความรู้ "การเตรียมตัวก่อนเรียน (ส่งหลังยืนยันการชำระเงิน)") · สไลด์ + คลาสออนไลน์ทบทวน + LINE Support 1 ปี
//   ตัดตัวเลขเงินของผู้ให้บริการภายนอกออกตามคำสั่ง "ไม่มีราคา" · ลิงก์สมัคร Make อยู่กับทีม (คลัง: "ถ้าลูกค้าขอ ให้ทีมส่ง")
const LIVE_LOGISTICS = [
  "📍 เรียนสด 1 วัน เวลา 10:00-17:00 น.",
  "สถาบันพี่ง้วงติดกระดุม อาคาร EZ Space ถ.เทพารักษ์ (ใกล้ Mega Bangna)",
  "🚗 มีที่จอดรถกว้างขวาง จอดฟรีทั้งวัน",
  "🚆 BTS ศรีเทพา แล้วต่อ Grab ประมาณ 5 นาที",
  "🍱 มีอาหารกลางวันและเบรกให้ ถ้ามีข้อจำกัดด้านอาหาร แจ้งทีมงานล่วงหน้าได้เลยนะคะ",
].join("\n");
const DEVICE = "คอมพิวเตอร์สำหรับทำ workshop (แนะนำ Mac M-chip ขึ้นไป หรือ Windows 11) และเมาส์ (ถ้ามี)";
const AFTER_CLASS = "หลังเรียนได้สไลด์ คลาสออนไลน์ไว้ทบทวน และกลุ่ม LINE Support 1 ปีค่ะ";

// คลาสออนไลน์ (30 ก.ย. 2026 พี่ง้วงให้ร่างเอง): ข้อเท็จจริงจากคู่มือแชทของชมพู่ (VDO on demand ผ่านแพลตฟอร์มของเรา ~6 ชม.
// · ข้อมูลที่ต้องขอตอนลงทะเบียน) + คำพี่ง้วง "ลงทะเบียนเข้าเรียนที่ LINE ... เข้ากลุ่ม support หลังเรียนทาง LINE"
// ไม่มีราคา · วิธีเข้าเรียนมากับอีเมลที่ทีมงานส่งหลังตรวจเงินเข้า · พี่ง้วงตอบ 3 ข้อแล้ว 30 ก.ย. แก้ต่อได้ในหน้าตั้งค่า
const ONLINE_REGISTER = [
  "📝 ลงทะเบียนเข้าเรียน",
  "รบกวนพิมพ์ข้อมูลตอบในแชทนี้ได้เลยนะคะ",
  "1) ชื่อ-นามสกุลผู้เรียน",
  "2) ชื่อเล่น",
  "3) E-mail ที่ใช้งานได้",
  "4) เบอร์โทร",
  "5) อยากได้อะไรจากคลาสนี้ (เล่าสั้น ๆ ก็ได้ค่ะ)",
  "",
  // 30 ก.ย. 2026 (พี่ง้วง): ทีมงานตรวจเงินเข้าก่อนเสมอ แล้วส่งอีเมลลงทะเบียนสำเร็จภายใน 2 ชม. — ช่วงดึกอาจช้า
  "ได้ข้อมูลครบแล้ว ทีมงานจะส่งอีเมลยืนยันการลงทะเบียนสำเร็จให้ภายใน 2 ชั่วโมงค่ะ (ถ้าเป็นช่วงดึกอาจช้ากว่านี้นิดหน่อยนะคะ)",
  "รบกวนเช็กกล่องอีเมล และโฟลเดอร์จดหมายขยะด้วยนะคะ",
].join("\n");
// กลุ่ม LINE Support มีจริงทุกคลาสออนไลน์ — แอดมินเป็นคนส่งลิงก์เข้ากลุ่ม (พี่ง้วง 30 ก.ย.)
const ONLINE_SUPPORT = "เรียนแล้วติดตรงไหน ถามในกลุ่ม LINE Support ได้เลย ทีมงานจะส่งลิงก์เข้ากลุ่มให้ในแชทนี้ค่ะ\nมีคำถามพิมพ์ไว้ในแชทนี้ได้เลยนะคะ 😊";
const onlineTemplate = ({ welcome, prepare }) => [welcome, "---", ONLINE_REGISTER, "---", "💻 สิ่งที่ควรเตรียม", ...prepare, "", ONLINE_SUPPORT].join("\n");

export const IDENTITY_TEMPLATE_DEFAULTS = Object.freeze({
  online: onlineTemplate({
    welcome: [
      "ยินดีต้อนรับเข้าคลาส AI Agent for Business Online (สร้างกองทัพ AI ของคุณเอง ด้วย Custom GPTs) ค่ะ 🎉",
      "เรียนผ่านวิดีโอ on demand บนแพลตฟอร์มของเรา ประมาณ 6 ชั่วโมง เรียนเวลาไหนก็ได้ตามสะดวกค่ะ",
    ].join("\n"),
    prepare: [
      "• คอมพิวเตอร์สำหรับเรียนและลงมือทำตาม",
      "• บัญชี ChatGPT แนะนำแบบ Plus ขึ้นไป",
      "(ถ้ายังไม่สะดวกสมัครรายเดือน ตรวจสิทธิ์ทดลองใช้ Plus ฟรี 1 เดือนได้ค่ะ ต้องผูกบัตร และแนะนำให้กดยกเลิก (Cancel Subscription) ทันทีหลังรับสิทธิ์ จะยังใช้ฟรีได้ครบ 30 วัน)",
    ],
  }),
  online_fb: onlineTemplate({
    welcome: "ยินดีต้อนรับเข้าคลาส Facebook Ads Online ค่ะ 🎉",
    prepare: [
      "• คอมพิวเตอร์สำหรับเรียนและลงมือทำตาม",
      "• เพจ Facebook ของร้าน และบัญชีโฆษณา (ถ้ามี) จะได้ลองทำไปพร้อมกันค่ะ",
    ],
  }),
  online_line: onlineTemplate({
    welcome: "ยินดีต้อนรับเข้าคลาส LINE OA Online ค่ะ 🎉",
    prepare: [
      "• คอมพิวเตอร์สำหรับเรียนและลงมือทำตาม",
      "• บัญชี LINE OA ของร้าน (ถ้ามี) จะได้ลองทำไปพร้อมกันค่ะ",
    ],
  }),
  live_business: [
    "รายละเอียดการเตรียมตัวก่อนเรียนคลาส AI Agent for Business ค่ะ",
    "",
    LIVE_LOGISTICS,
    "---",
    "💻 สิ่งที่ต้องเตรียม",
    `1) ${DEVICE}`,
    "2) บัญชี ChatGPT แนะนำแบบ Plus ขึ้นไป",
    "• ถ้ายังไม่สะดวกสมัครรายเดือน ตรวจสิทธิ์ทดลองใช้ Plus ฟรี 1 เดือนได้ค่ะ (เข้าสู่ระบบแล้วดูเมนูซ้ายล่าง หรือหน้า Account/Settings ถ้ามีสิทธิ์จะขึ้น Try Plus Free หรือ Claim free offer)",
    "• ต้องผูกบัตรเครดิต/เดบิต (1 บัตรรับสิทธิ์ได้ 1 ครั้ง) ครบ 1 เดือนระบบจะตัดเงินอัตโนมัติ แนะนำให้กดยกเลิก (Cancel Subscription) ทันทีหลังกดรับสิทธิ์ จะยังใช้ Plus ฟรีได้ครบ 30 วันค่ะ",
    "3) ติดตั้ง Codex desktop ลงบนเครื่อง (chatgpt.com/th-TH/codex) แล้วลงชื่อเข้าใช้ด้วยบัญชี ChatGPT",
    "",
    AFTER_CLASS,
    "มีคำถามพิมพ์ไว้ในแชทนี้ได้เลยนะคะ ทีมงานจะตอบให้ค่ะ",
  ].join("\n"),
  live_workflow: [
    "รายละเอียดการเตรียมตัวก่อนเรียนคลาส AI Agent Workflow Automation ค่ะ",
    "",
    LIVE_LOGISTICS,
    "---",
    "💻 สิ่งที่ต้องเตรียม",
    `1) ${DEVICE}`,
    "2) สมัครบัญชีสำหรับเชื่อมระบบ AI Automation",
    "• LINE Developer Console — ในคลาสทำระบบ Automation 2 ระบบ จึงต้องเชื่อม LINE OA 2 บัญชี (1 Provider / 2 LINE OA)",
    "• OpenAI Platform สำหรับใช้ API",
    "3) สมัครบัญชี Make — ใช้อีเมลที่ยังไม่เคยสมัคร Make มาก่อน สมัครผ่านลิงก์แนะนำของเราจะได้ใช้ฟรี 1 เดือนค่ะ",
    "4) ติดตั้ง Codex desktop (ถ้ามีอยู่แล้วใช้บัญชีเดิมได้)",
    "",
    "ลิงก์สมัคร Make และวิดีโอสอนสมัครบัญชีต่าง ๆ ขอจากทีมงานในแชทนี้ได้เลยนะคะ",
    AFTER_CLASS,
  ].join("\n"),
  live_private: [
    "รายละเอียดการเตรียมตัวสำหรับ Private Class / In-house ค่ะ",
    "",
    "ทีมผู้ดูแลจะยืนยันวันเรียน สถานที่ และหลักสูตรที่เลือกอีกครั้งในแชทนี้นะคะ",
    "",
    "💻 สิ่งที่ผู้เรียนทุกท่านต้องเตรียม",
    `• ${DEVICE}`,
    "• iPad หรือแท็บเล็ตอย่างเดียวไม่เหมาะกับ workshop เพราะต้องสลับหลายหน้าต่างและพิมพ์เยอะค่ะ",
    "• บัญชีและโปรแกรมที่ต้องสมัครล่วงหน้าขึ้นกับหลักสูตรที่เลือก ทีมงานจะส่งรายการให้ในแชทนี้ค่ะ",
  ].join("\n"),
});
