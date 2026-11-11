// paymentStep.mjs — ขั้นชำระเงินที่ระบบประกอบเอง (audit ลูกแพร 18 ต.ค. 2026)
//
// ต้นเหตุ: ตั้งแต่เปิด SALES_DECISION_GUARD_ENABLED (27 ก.ย. 12:45) พรอมต์เครื่องเดิมได้ PRICE_BEFORE_BANK_RULE ต่อท้าย
// ทุกเทิร์น — กติกานั้นเรียกการ์ด "ขั้นตอนปิดการขาย" (ที่มีบล็อกบัญชี) ว่า "ขั้นตอนเก่า" และสั่ง "ห้ามส่งช่องทางชำระเงิน"
// ผลจริงในโปรดักชัน: บล็อกบัญชีจาก AI = 0 ครั้งหลัง 27 ก.ย. 10:16 (ก่อนหน้านั้นสัปดาห์ละ 1–5) และด่าน price_before_bank
// ไม่เคยตัดอะไรเลย เพราะโมเดลไม่ร่างบล็อกเอง
//
// ทางแก้ (พี่ง้วงสั่ง 28 ส.ค. / ยืนยัน 10 ต.ค.: รู้ประเภทเอกสารแล้วต้องส่งบัญชีทันที):
// ระบบประกอบ "สรุปคลาส รอบ ค่าเรียน + บล็อกชำระเงิน + ฟอร์มลงทะเบียน" เองในข้อความเดียว โมเดลไม่พิมพ์ตัวเลขหรือเลขบัญชี
//   · ค่าเรียน = ราคาที่ห้องนี้ได้จริง (ข้อความขาออกล่าสุดที่มีราคาที่ผูกกับคลาสนั้น) ไม่มีราคาในห้อง = ราคาฐานของคลาส
//     ที่อนุมัติไว้แถวเดียว — กำกวมเมื่อไหร่ ไม่ประกอบ ส่งให้คน
//   · เลขบัญชีและฟอร์มอ่านจากการ์ดที่เจ้าของดูแล (ห้าม hardcode เลขบัญชีจริงในโค้ด)
//   · ไม่ส่งซ้ำ (ดีลเริ่มจ่ายแล้ว/มีบล็อกบัญชีในห้องแล้ว = ไม่ประกอบ) · ไม่มีคำเร่งโอน · ภาษี/ผ่อน ไม่พูดเอง
// ไฟล์นี้เป็นตรรกะบริสุทธิ์ทั้งหมด (ไม่แตะ DB) — pipeline.mjs เป็นคนเก็บหมุดและส่ง

import { isDocumentNameQuestion } from "./safetyRouter.mjs";
import { thaiShortDate } from "./classRounds.mjs";
import {
  boundPriceRows, checkPriceBeforeBank, courseLabelName, coursesMentionedIn, customerCourseEvidence, paymentInstructionsIndex,
} from "./salesDecisionGuard.mjs";

// สวิตช์ในหน้าตั้งค่า (settings): "off" = ปิดตัวประกอบ กลับไปพฤติกรรมเดิม · ไม่มีแถว = เปิด
export const PAYMENT_STEP_SETTING = "payment_step_composer";
// หมุดต่อห้อง: ลูกค้าบอกประเภทเอกสารแล้ว แต่เทิร์นนั้นยังส่งข้อความชำระเงินไม่ได้ (ถามเรื่องอื่นพ่วง / ข้อมูลไม่ครบ)
export const PAYMENT_STEP_PIN_PREFIX = "payment_step_pin:";
export const PAYMENT_STEP_PIN_TTL_MS = 7 * 86_400_000;
export const PAYMENT_STEP_AUDIT = Object.freeze({ composed: "payment_step_composed", pending: "payment_step_pending", modelBlocked: "payment_model_draft_blocked" });
export const DOC_TYPE_QUESTION = "ต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?";
const HISTORY_SCAN = 24;

const space = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const userTurns = (history) => (Array.isArray(history) ? history : []).filter((turn) => turn?.role === "user").map((turn) => String(turn.content ?? turn.text ?? ""));
const botTurns = (history) => (Array.isArray(history) ? history : []).filter((turn) => turn?.role === "assistant").map((turn) => String(turn.content ?? turn.text ?? ""));

/** ก้อนข้อความล่าสุดของฝั่งร้าน (AI หรือทีม) ก่อนเทิร์นนี้ — "" = เทิร์นก่อนหน้าเป็นของลูกค้า */
export function lastBotBurst(history) {
  const turns = Array.isArray(history) ? history : [];
  const out = [];
  for (let i = turns.length - 1; i >= 0 && turns[i]?.role === "assistant"; i -= 1) out.unshift(String(turns[i]?.content ?? ""));
  return out.join("\n");
}

// ---- 1. การ์ดของเจ้าของ: บล็อกบัญชี + ฟอร์มลงทะเบียน ----
const BANK_LINE = /^\s*ธนาคาร\s*[:：]\s*\S/u;
const ACCOUNT_LINE = /^\s*เลขที่บัญชี\s*[:：]\s*(\d(?:[\s-]?\d){8,13})\s*$/u;
const ACCOUNT_NAME_LINE = /^\s*ชื่อบัญชี\s*[:：]\s*\S/u;
const FORM_HEADING = /ข้อมูลลงทะเบียน/u;
const FORM_FIELD = /^\s*-\s*[^:：\n]{2,60}[:：]\s*$/u;
const THANKS = /ขอบ(?:พระ)?คุณ/u;
const PAYMENT_IMAGE = /\[IMAGE:(payment[a-z0-9_-]*)\]/iu;
// บรรทัดคำสั่งถึงโมเดลในการ์ด ("ส่งตามรูปแบบนี้เป๊ะ ๆ ...:") ไม่ใช่ข้อความถึงลูกค้า
const INSTRUCTION_LINE = /[:：]\s*$|รูปแบบ|บล็อก|marker|\[IMAGE:|ตัวอักษร|บอลลูน/iu;

function nearestLineAbove(lines, index) {
  for (let i = index - 1; i >= 0 && i >= index - 3; i -= 1) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

function kitFrom(content) {
  const lines = String(content || "").split("\n");
  const bankAt = lines.findIndex((line, i) => BANK_LINE.test(line) && ACCOUNT_LINE.test(lines[i + 1] || "") && ACCOUNT_NAME_LINE.test(lines[i + 2] || ""));
  if (bankAt < 0) return null;
  const digits = ACCOUNT_LINE.exec(lines[bankAt + 1])[1].replace(/\D/gu, "");
  if (digits.length < 10 || digits.length > 12) return null;
  const above = nearestLineAbove(lines, bankAt);
  const intro = above && !INSTRUCTION_LINE.test(above) && /โอน|ชำระ/u.test(above) ? above : "สามารถโอนชำระได้ที่บัญชีนี้นะคะ";
  const bank = `${intro}\n\n${lines.slice(bankAt, bankAt + 3).map((line) => line.trim()).join("\n")}`;
  const headingAt = lines.findIndex((line, i) => i > bankAt && FORM_HEADING.test(line));
  if (headingAt < 0) return null;
  const endAt = lines.findIndex((line, i) => i > headingAt && THANKS.test(line));
  if (endAt < 0) return null;
  const fields = lines.slice(headingAt + 1, endAt).filter((line) => FORM_FIELD.test(line));
  if (fields.length < 3) return null;
  let startAt = headingAt;
  for (let i = headingAt - 1; i > bankAt + 2 && i >= headingAt - 3; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!INSTRUCTION_LINE.test(line)) startAt = i;
    break;
  }
  const form = lines.slice(startAt, endAt + 1).map((line) => line.trimEnd().replace(/^\s+(?=-)/u, "")).join("\n")
    .replace(/\n{3,}/gu, "\n\n").trim();
  const image = PAYMENT_IMAGE.exec(String(content || ""));
  return { bank, form, imageKey: image ? image[1].toLowerCase() : "" };
}

/** ชุดชำระเงินจากการ์ดที่อนุมัติ (การ์ดชื่อ "ปิดการขาย" ก่อน) — ไม่ครบ = null = ตัวประกอบไม่ทำงาน */
export function extractPaymentKit(entries = []) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry.content === "string");
  const closing = (entry) => (/ปิดการขาย/u.test(String(entry.title || "")) ? 0 : 1);
  const kits = [...list].sort((a, b) => closing(a) - closing(b))
    .map((entry) => ({ entry, kit: kitFrom(entry.content) })).filter((found) => found.kit);
  if (!kits.length) return null;
  // การ์ดสองใบที่บัญชีต่างกัน = ไม่รู้ว่าบัญชีไหนถูก ห้ามเดา (ให้คนแก้การ์ดก่อน)
  if (new Set(kits.map((found) => found.kit.bank)).size > 1) return null;
  return { ...kits[0].kit, source: String(kits[0].entry.title || "") };
}

// ---- 2. ลูกค้าตอบประเภทเอกสาร ----
// "เคยถามไปแล้ว" ใช้ตัวจับเดียวกับ safetyRouter + ถ้อยคำที่โมเดลใช้จริง ("ขอใช้ชื่อบุคคลหรือชื่อบริษัทดีคะ") + คำขอข้อมูลบริษัท
const EXTRA_DOC_ASK = /(?:ชื่อ|นาม)\s*บุคคล(?:ธรรมดา)?\s*หรือ\s*(?:ชื่อ|นาม)?\s*บริษัท|(?:ชื่อ|นาม)\s*บริษัท\s*หรือ\s*(?:ชื่อ|นาม)?\s*บุคคล|ชื่อนิติบุคคล/u;
// ต้องเป็น "คำถาม/คำขอ" ถึงลูกค้า — ประโยคบอกข้อมูล ("ออกใบเสร็จในนามบุคคลธรรมดาหรือบริษัทได้ค่ะ") ไม่นับ
const ASKING = /[?？]|(?<!ค่)คะ|ครับ|ไหม|มั้ย|หรือเปล่า|ไม่ทราบว่า|ต้องการ|สะดวก|รบกวน|ขอทราบ|แจ้ง(?:ลูกแพร)?(?:ได้)?เลย|ขอใช้/u;
// คำขอข้อมูลบริษัทเป็นรายการหลายบรรทัด ("รบกวนส่งข้อมูล…" แล้วตามด้วย "ชื่อนิติบุคคล") — ดูทั้งก้อน
const COMPANY_DETAILS_ASK = /(?:รบกวน|ขอ|ส่ง|แจ้ง)\S{0,6}ข้อมูล[\s\S]{0,120}ชื่อนิติบุคคล|ชื่อนิติบุคคล[\s\S]{0,160}(?:รบกวน|ส่ง(?:มา|ให้)|แจ้ง)/u;
export function botAskedDocType(history) {
  const burst = lastBotBurst(history);
  if (COMPANY_DETAILS_ASK.test(burst)) return true;
  return burst.split(/\n+/u).some((line) => (isDocumentNameQuestion(line) || EXTRA_DOC_ASK.test(line))
    && ASKING.test(line.replace(/ได้ค่ะ\s*\S{0,4}\s*$/u, "")));
}

// ยกเลิก = ล้างหมุด · ขอเวลา = เก็บหมุดไว้เฉย ๆ (ไม่ส่ง ไม่ปักธง) — ห้ามส่งบัญชีใส่คนที่เพิ่งบอกว่าขอคิดก่อน
const CANCEL = /ยกเลิก|ไม่สนใจ|เปลี่ยนใจ|ไม่เอา(?:แล้ว|ค่ะ|คะ|ครับ|คับ)?\s*$/u;
const DEFER = /ขอ(?:เวลา|คิด|พิจารณา|ลองดู|ดูก่อน|อนุมัติ|ปรึกษา)|คิดก่อน|พิจารณา|ตัดสินใจก่อน|ยังไม่(?:พร้อม|สะดวก|แน่ใจ|ตัดสินใจ|สมัคร|ลง|โอน)|ไว้ก่อน|ปรึกษา|อนุมัติ|รอ(?:ก่อน|ดูก่อน|ผู้|หัวหน้า|เจ้านาย|ที่บ้าน|แฟน|บริษัท|ฝ่าย|งบ)|(?:เดี๋ยว|เด๋ว|เด่ว)\S{0,14}(?:แจ้ง|บอก|ทัก|ติดต่อ)|ขอเป็น(?:เดือน|รอบ)|ไว้(?:ทัก|แจ้ง|ค่อย)|ทีหลัง|ค่อย(?:ตัดสินใจ|สมัคร|แจ้ง|โอน)/u;
// หมุดที่ค้างไว้ ส่งเมื่อลูกค้าบอกชัดว่าพร้อมเท่านั้น ("ขอบคุณค่ะ" / "ได้ค่ะ" เฉย ๆ ไม่นับ)
const READY = /โอน|สมัคร|ลงทะเบียน|บัญชี|ชำระ|จ่าย|พร้อม|จอง|ส่ง(?:มา|ให้)?(?:เลย|ได้เลย)|เอาเลย|ตกลง|ลุย|ยืนยัน/u;
// คำตอบประเภทเอกสาร "ล้วน ๆ" — ตัดคำตอบ คำลงท้าย คำรับ วันที่ และคำถามราคา/วิธีโอนที่ข้อความชุดนี้ตอบเองแล้ว เหลือเนื้อหาอื่น = ไม่ใช่ล้วน
// คำเติม — เรียงยาวก่อนสั้น ("ค่าเรียน" ต้องถูกตัดทั้งคำ ไม่ใช่เหลือ "เรียน" หลังตัด "ค่า")
const FILLER = /ลงทะเบียน|ธรรมดา|ค่าเรียน|ใบเสร็จ|ใบกำกับ\S*|ช่องทาง|เปลี่ยน|เอกสาร|วันที่|กี่บาท|ครับผม|ค่ะผม|ยืนยัน|เดี๋ยว|เท่าไหร่|เท่าไร|เลขที่|เด๋ว|เด่ว|ค่อย|เสาร์|บัญชี|ยังไง|สมัคร|พร้อม|ตกลง|ราคา|okay|ด้วย|แล้ว|โอเค|ชำระ|ค่ะ|คะ|ค่า|ครับ|คับ|ฮะ|จ้า|จ้ะ|นะ|เลย|ได้|เอา|เป็น|ก็|ขอ|ออก|ใน|นาม|ชื่อ|ภาษี|ok|ส่ง|มา|ให้|รอบ|วัน|ยอด|เลข|โอน|จ่าย|ไง|ไหม|มั้ย|[\d\s/.,!?？()\-–:]+|\p{Extended_Pictographic}|\uFE0F/giu;
const MONTH_TOKENS = /ม\.?ค\.?|ก\.?พ\.?|มี\.?ค\.?|เม\.?ย\.?|พ\.?ค\.?|มิ\.?ย\.?|ก\.?ค\.?|ส\.?ค\.?|ก\.?ย\.?|ต\.?ค\.?|พ\.?ย\.?|ธ\.?ค\.?|[ก-๙]+าคม|[ก-๙]+ายน|กุมภาพันธ์/gu;
export function isBareDocAnswer(units) {
  const rest = String((Array.isArray(units) ? units : [units]).join(" "))
    .replace(DOC_ANSWER_WORDS, " ").replace(NO_DOC_WORDS, " ").replace(MONTH_TOKENS, " ").replace(FILLER, " ");
  return [...rest.replace(/\s+/gu, "")].length <= 4;
}
const NO_DOC = /ไม่(?:ต้อง|เอา|ขอ)\s*(?:ออก)?\s*(?:เอกสาร|ใบเสร็จ|ใบกำกับ)/u;
const NO_DOC_WORDS = new RegExp(`${/ไม่(?:ต้อง|เอา|ขอ)\s*(?:ออก)?\s*(?:เอกสาร|ใบเสร็จ|ใบกำกับ\S*)/u.source}`, "gu");
const PERSON = /บุคคลธรรมดา|(?:ใน)?นาม\s*(?:บุคคล|ส่วนตัว|ตัวเอง)|ชื่อ\s*(?:บุคคล|ตัวเอง|ส่วนตัว)|^\s*(?:บุคคล|ส่วนตัว|ตัวเอง)\s*(?:ค่ะ|คะ|ครับ|คับ|ค่า|จ้า|จ้ะ|นะคะ|นะครับ)?\s*$/u;
const COMPANY = /บริษัท|นิติบุคคล|ห้างหุ้นส่วน|หจก|บจก|บมจ|(?:ใน)?นาม\s*(?:องค์กร|หน่วยงาน)/u;
export const DOC_TYPE_LABEL = Object.freeze({ person: "บุคคลธรรมดา", company: "บริษัท", none: "ไม่ต้องออกเอกสาร" });

/** "person" | "company" | "none" (ไม่ต้องออกเอกสาร) | null — สองแบบปนกัน/ไม่มีเลย/ขอยกเลิก = null (ไม่เดา) · อ่านทีละบรรทัด */
// ข้อความยาวที่เล่าเรื่องงาน ("โครงการส่วนบุคคล ใช้ทุนส่วนตัว…") ไม่ใช่คำตอบ — นับเฉพาะบรรทัดสั้น หรือก้อนที่เป็นข้อมูลบริษัท
const ANSWER_LINE_MAX = 60;
export function classifyDocTypeAnswer(text) {
  const all = String(text ?? "").split(/\n+/u).map(space).filter(Boolean);
  if (!all.length || all.some((line) => CANCEL.test(line))) return null;
  const details = all.some((line) => COMPANY_DETAILS.test(line));
  const lines = details ? all : all.filter((line) => [...line].length <= ANSWER_LINE_MAX);
  const found = new Set();
  for (const line of lines) {
    if (NO_DOC.test(line)) { found.add("none"); continue; }
    const person = PERSON.test(line);
    const company = COMPANY.test(line);
    if (person && company) return null;
    if (person) found.add("person");
    if (company) found.add("company");
  }
  return found.size === 1 ? [...found][0] : null;
}

// คำถามอื่นที่พ่วงมา = ต้องให้โมเดลตอบก่อน (ระบบส่งชุดชำระเงินในเทิร์นถัดไป) — คำถามราคา/วิธีโอน/เอกสาร ข้อความชุดนี้ตอบเองอยู่แล้ว
const QUESTION = /[?？]|ไหม|มั้ย|ม้าย|หรือเปล่า|รึเปล่า|หรือยัง|ยังไง|อย่างไร|อะไร|เมื่อไหร่|เมื่อไร|ที่ไหน|กี่(?!บาท)|ทำไม|ขอ(?:ดู|รายละเอียด|ข้อมูล|ทราบ|สอบถาม)|สอบถาม|รายละเอียด/u;
const ANSWERED_HERE = /ราคา|เท่า(?:ไหร่|ไร)|ค่าเรียน|กี่บาท|ยอด|เลข(?:ที่)?\s*บัญชี|ช่องทาง\S{0,4}(?:ชำระ|โอน|จ่าย)|โอน|จ่าย|ชำระ|ออกเอกสาร|ใบเสร็จ|ใบกำกับ|ในนาม|บุคคลธรรมดา|บริษัท|นิติบุคคล/u;
// พี่ง้วง: ภาษี/ผ่อน/บัตร พูดเมื่อลูกค้าถามเท่านั้น — ข้อความชุดนี้ไม่มีเรื่องพวกนี้ จึงต้องให้โมเดลตอบจากคลังก่อน
const ASKED_ONLY_TOPIC = /ภาษี|\bvat\b|ผ่อน|บัตร(?!คำ|ภาพ)|หัก\s*ณ|ค่าธรรมเนียม|ใบเสนอราคา|มัดจำ|คืนเงิน|เงินสด|หน้างาน/iu;
const DOC_ANSWER_WORDS = new RegExp(`${PERSON.source}|${COMPANY.source}`, "gu");
// ข้อมูลบริษัทที่ลูกค้าส่งมา ("เลขที่ผู้เสียภาษี 0105…") ไม่ใช่คำถามเรื่องภาษี
const COMPANY_DETAILS = /เลข(?:ที่)?\s*(?:ทะเบียน|ประจำตัวผู้เสียภาษี|ผู้เสียภาษี|ภาษี|นิติบุคคล)|สำนักงานใหญ่|สาขา(?:ที่|เลขที่)?\s*\d|(?<!\d)\d{13}(?!\d)|(?:บริษัท|บจก|บมจ)[^\n]{1,80}จำกัด/u;
export function hasOtherAsk(parts) {
  return (Array.isArray(parts) ? parts : [parts]).flatMap((part) => String(part ?? "").split(/\n+/u)).some((line) => {
    const value = space(line);
    if (!value || COMPANY_DETAILS.test(value)) return false;
    if (ASKED_ONLY_TOPIC.test(value)) return true;
    // ตัดคำตอบประเภทเอกสารออกก่อน ("บุคคลธรรมดา เรียนที่ไหนคะ" = ถามสถานที่ ไม่ใช่ถามเรื่องเอกสาร)
    const rest = space(value.replace(DOC_ANSWER_WORDS, " "));
    return QUESTION.test(rest) && !ANSWERED_HERE.test(rest);
  });
}

// ---- 3. ข้อเสนอของห้องนี้: คลาส · ค่าเรียน · รอบ ----
const THAI_DIGIT_WORDS = { สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9, สิบ: 10 };
const HEADCOUNT = /(?<![\d,.])(\d{1,3})\s*(?:ท่าน|คน|ที่นั่ง)|(สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ)\s*(?:ท่าน|คน|ที่นั่ง)/gu;
const ONLINE = /ออนไล|ออนลาย|online|vdo|on ?demand|ดูย้อนหลัง/iu;
// "ขายของออนไลน์ / ร้านออนไลน์" คือธุรกิจของลูกค้า ไม่ใช่คลาสออนไลน์ (นิยามเดียวกับ replyEngineV3/lanes.mjs)
const ONLINE_BUSINESS = /(?:ขาย(?:ของ|สินค้า)|ร้าน(?:ค้า)?|ธุรกิจ|การตลาด|ตลาด|หน้าร้าน)\s*(?:ออนไลน์?|ออนไล|ออนลาย|online)/giu;
const asksOnline = (text) => ONLINE.test(String(text || "").replace(ONLINE_BUSINESS, " "));
// ราคาในแชท: "12,900 บาท" · "15,900.-" · "12,900 บาท/ท่าน" (เลขที่ไม่มีหน่วยเงินไม่นับ)
const AMOUNT = /(?<![\d,])(\d{1,3}(?:,\d{3})+|\d{3,6})(?=\s*(?:บาท|\.-|-\s*\/|฿|\s*\/\s*ท่าน))/gu;
// แถวราคาที่มีเงื่อนไข (2 ท่าน / นักเรียนเก่า / ราคาปกติ ฯลฯ) ไม่ใช่ราคาฐานของคนเดียว
const QUALIFIED_LABEL = /ท่าน|นักเรียนเก่า|re-?learn|ส่วนลด|ปกติ|หลัง|bundle|ก่อนลด|โบนัส|มูลค่า/iu;

const amountsIn = (text) => [...String(text || "").matchAll(AMOUNT)].map((match) => Number(match[1].replace(/,/gu, ""))).filter(Number.isSafeInteger);
const fail = (reason) => ({ ok: false, reason });

export function headcountMentioned(texts) {
  let max = 0;
  for (const text of texts) {
    for (const match of String(text || "").matchAll(HEADCOUNT)) max = Math.max(max, match[1] ? Number(match[1]) : THAI_DIGIT_WORDS[match[2]] || 0);
  }
  return max;
}

// ราคามีเงื่อนไขที่ห้องได้ ต้องมีหลักฐานจากลูกค้าว่าเข้าเงื่อนไข (นักเรียนเก่า) — ราคากลุ่ม/ส่วนลดอื่น ให้คนตัดสิน
const OLD_STUDENT = /เคย(?:มา)?เรียน|เคยลง|นักเรียนเก่า|ศิษย์|re-?learn|เรียนซ้ำ/iu;
function qualifiedPriceAllowed(row, customerTexts) {
  const label = String(row?.label ?? row?.label_th ?? "");
  if (!QUALIFIED_LABEL.test(label)) return true;
  if (/นักเรียนเก่า|re-?learn/iu.test(label)) return customerTexts.some((text) => OLD_STUDENT.test(String(text || "")));
  return false;
}
function priceFor({ course, courses, history, approvedPrices, approved, customerTexts = [] }) {
  const rows = boundPriceRows(course, approvedPrices).filter((row) => approved.has(Number(row.amount)));
  if (!rows.length) return fail("no_price_row");
  const bound = new Set(rows.map((row) => Number(row.amount)));
  const rowOf = (amount) => rows.find((row) => Number(row.amount) === amount && !QUALIFIED_LABEL.test(String(row.label ?? row.label_th ?? "")))
    || rows.find((row) => Number(row.amount) === amount);
  const base = [...new Set(rows.filter((row) => !QUALIFIED_LABEL.test(String(row.label ?? row.label_th ?? ""))).map((row) => Number(row.amount)))];
  for (const turn of botTurns(history).reverse().slice(0, HISTORY_SCAN)) {
    const priced = [...new Set(amountsIn(turn))].filter((amount) => approved.has(amount));
    if (!priced.length) continue;
    // ข้อความราคาที่เอ่ยคลาสอื่นด้วย = หลักฐานกำกวม (เลขเดียวกันผูกได้หลายคลาส เช่น 12,900) — ให้คนตัดสิน
    if (coursesMentionedIn(turn, courses).some((other) => other !== course)) return fail("price_ambiguous");
    // ราคาล่าสุดที่ห้องได้ไม่ใช่ราคาของคลาสนี้ (เช่น คลาสออนไลน์ 4,900) — ห้ามย้อนไปหยิบราคาเก่ากว่า
    const found = priced.filter((amount) => bound.has(amount));
    if (!found.length) return fail("price_mismatch");
    const picked = found.length === 1 ? found : found.filter((amount) => base.includes(amount));
    if (picked.length !== 1) return fail("price_ambiguous");
    // ราคาเดียวที่ห้องได้เป็นแถวมีเงื่อนไข (เช่น 11,900 ของ 2 ท่าน) = ห้ามใช้กับคนเดียวโดยไม่มีหลักฐาน
    if (!base.includes(picked[0]) && !qualifiedPriceAllowed(rowOf(picked[0]), customerTexts)) return fail("price_qualified");
    return { ok: true, amount: picked[0], row: rowOf(picked[0]), source: "quoted" };
  }
  return base.length === 1 ? { ok: true, amount: base[0], row: rowOf(base[0]), source: "approved_base" } : fail("price_unknown");
}

function courseFor({ latestText, history, courses, roundCourse = null }) {
  const inbound = customerCourseEvidence(latestText, history, courses);
  if (inbound.length > 1) return fail("customer_course_ambiguous");
  // ลูกค้าเลือกวันของรอบสอนสดเองแล้ว = คลาสของรอบนั้น (ถามว่า "มีออนไลน์ไหม" ก่อนเลือกรอบสดไม่นับเป็นคลาสออนไลน์)
  if (roundCourse) return inbound.length && inbound[0] !== roundCourse ? fail("course_round_mismatch") : { ok: true, course: roundCourse };
  // คลาสออนไลน์ยังไม่อยู่ในรายการคลาสของนโยบายขาย — ลูกค้าพูดถึงออนไลน์ล่าสุด = ให้ทีมส่งเอง
  if ([latestText, ...userTurns(history).slice(-4)].some(asksOnline)) return fail("online_course");
  if (inbound.length === 1) return { ok: true, course: inbound[0] };
  // คลาสที่ร้านคุยด้วยล่าสุด ("คุณ… เหมาะกับคลาส AI Agent for Business" แล้ว "คลาสนี้ … 12,900.-")
  for (const turn of botTurns(history).reverse().slice(0, HISTORY_SCAN)) {
    const named = coursesMentionedIn(turn, courses);
    if (!named.length) continue;
    return named.length === 1 ? { ok: true, course: named[0] } : fail("course_ambiguous");
  }
  return fail("course_unresolved");
}

const MONTH_WORDS = [
  "มค|มกรา(?:คม)?|jan", "กพ|กุมภา(?:พันธ์)?|feb", "มีค|มีนา(?:คม)?|mar", "เมย|เมษา(?:ยน)?|apr", "พค|พฤษภา(?:คม)?|may", "มิย|มิถุนา(?:ยน)?|jun",
  "กค|กรกฎา(?:คม)?|jul", "สค|สิงหา(?:คม)?|aug", "กย|กันยา(?:ยน)?|sep", "ตค|ตุลา(?:คม)?|oct", "พย|พฤศจิกา(?:ยน)?|nov", "ธค|ธันวา(?:คม)?|dec",
];
const THAI_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const dateParts = (iso) => String(iso || "").split("-").map(Number);
export function mentionsRound(text, round) {
  const [, month, day] = dateParts(round?.date);
  if (!month || !day) return false;
  const value = String(text || "").normalize("NFC").replace(/\./gu, "").toLowerCase();
  return new RegExp(`(?<!\\d)0?${day}\\s*(?:${MONTH_WORDS[month - 1]})`, "u").test(value)
    || new RegExp(`(?<!\\d)0?${day}\\s*/\\s*0?${month}(?![\\d])`, "u").test(value);
}
const courseOwnsRound = (course, round) => {
  const names = [course?.name, ...(Array.isArray(course?.aliases) ? course.aliases : [])].map(space).map((name) => name.toLowerCase()).filter(Boolean);
  return [round?.product, round?.label].map((value) => space(value).toLowerCase()).some((value) => value && names.some((name) => value === name || value.endsWith(` ${name}`)));
};
const bookable = (round) => round?.fileStatus !== "full" && round?.fileStatus !== "closed" && round?.seatsLeft !== 0;
export function roundLabel(round) {
  const [year, month, day] = dateParts(round?.date);
  const weekday = THAI_WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  return `${weekday} ${thaiShortDate(round.date)}`;
}

// ไทม์ไลน์ใหม่ → เก่า (รวมข้อความเทิร์นนี้) พร้อมก้อนข้อความร้านที่อยู่ก่อนแต่ละข้อความลูกค้า
function timeline(history, latestText) {
  const turns = [...(Array.isArray(history) ? history : []), { role: "user", content: String(latestText || "") }];
  const out = [];
  for (let i = turns.length - 1; i >= 0 && out.length < HISTORY_SCAN; i -= 1) {
    const turn = turns[i];
    let before = "";
    if (turn?.role === "user") for (let j = i - 1; j >= 0 && turns[j]?.role === "assistant"; j -= 1) before = `${turns[j].content}\n${before}`;
    out.push({ role: turn?.role, content: String(turn?.content ?? ""), before });
  }
  return out;
}
// "12 ค่ะ" ตอบคำถาม "สนใจรอบ 12/9 หรือ 19/9 ดีคะ" = วันที่ไม่มีเดือน นับเฉพาะรอบที่ร้านเพิ่งเสนอในก้อนก่อนหน้า
const DAY_ONLY = /^\D{0,12}?(?<!\d)(\d{1,2})(?!\d)\D{0,12}$/u;
// ประโยคของร้านที่ "ถาม/เสนอ" รอบ ("สนใจรอบ 19 ก.ย. ไหมคะ?") ไม่ใช่การยืนยันรอบที่ลูกค้าเลือก
const OFFER_LINE = /[?？]|ไหม|มั้ย|ดีคะ|ดีครับ|หรือ/u;
// ร้าน "ยืนยัน" รอบที่ลูกค้าเลือก — ประโยคแนะนำ ("รอบใกล้สุดคือ 14 พ.ย.", "มีรอบ 21 พ.ย. ด้วยนะคะ") ไม่ใช่การเลือก
const CONFIRM_LINE = /รอบที่เลือก|เลือก(?:รอบ)?|รับทราบ|ยืนยัน|สำหรับ\s*\d+\s*ท่าน|ลงทะเบียน|สรุป(?:รายการ|รายละเอียด)?|^\s*(?:วันที่|รอบ)\s*[:：]/u;
function roundsSaidIn(entry, rounds) {
  if (entry.role === "assistant") {
    const stated = entry.content.split(/\n+/u).filter((line) => !OFFER_LINE.test(line) && CONFIRM_LINE.test(line)).join("\n");
    return rounds.filter((round) => mentionsRound(stated, round));
  }
  const dated = rounds.filter((round) => mentionsRound(entry.content, round));
  if (dated.length || entry.role !== "user") return dated;
  const day = DAY_ONLY.exec(space(entry.content));
  if (!day) return [];
  return rounds.filter((round) => mentionsRound(entry.before, round) && dateParts(round.date)[2] === Number(day[1]));
}
/** รอบที่ถูกเลือกล่าสุด: ลูกค้าพิมพ์วันเอง หรือร้านยืนยันรอบเดียว ("รอบที่เลือกคือ…") — ข้อความใหม่กว่าชนะ · ลูกค้าพิมพ์หลายวัน = ยังไม่เลือก */
function latestRoundChoice({ history, latestText, rounds, customerOnly = false }) {
  for (const entry of timeline(history, latestText)) {
    if (customerOnly && entry.role !== "user") continue;
    const hit = roundsSaidIn(entry, rounds);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1 && entry.role === "user") return null;
  }
  return null;
}

function roundFor({ course, rounds, latestText, history }) {
  const mine = (Array.isArray(rounds) ? rounds : []).filter((round) => courseOwnsRound(course, round));
  // คลาสที่ไม่มีรอบ (ไม่ใช่คลาสสด) ไม่ต้องมีบรรทัดรอบ
  if (!mine.length) return course?.type === "group_live" ? fail("no_open_round") : { ok: true, round: null, options: [] };
  // ลูกค้าเลือกเองชนะเสมอ · ร้านยืนยันคนละรอบหลังจากนั้น = ขัดกัน ให้คนตัดสิน · ไม่มีการเลือกของลูกค้า = ใช้รอบที่ร้านยืนยัน
  const customerChoice = latestRoundChoice({ history, latestText, rounds: mine, customerOnly: true });
  const latestChoice = latestRoundChoice({ history, latestText, rounds: mine });
  if (customerChoice && latestChoice && latestChoice !== customerChoice) return fail("round_conflict");
  const chosen = customerChoice || latestChoice;
  if (chosen) return bookable(chosen) ? { ok: true, round: chosen, options: [] } : fail("round_unavailable");
  const open = mine.filter(bookable);
  if (!open.length) return fail("no_open_round");
  return open.length === 1 ? { ok: true, round: open[0], options: [] } : { ok: true, round: null, options: open.slice(0, 3) };
}

/** ข้อเสนอที่ห้องนี้ได้จริง — ทุกตัวเลขมาจากตารางราคาที่อนุมัติ/ประวัติห้อง ไม่มีการคำนวณยอดรวม */
export function resolvePaymentOffer({ latestText = "", history = [], courses = [], approvedPrices = [], approvedAmounts = null, rounds = [] } = {}) {
  const approved = approvedAmounts instanceof Set ? approvedAmounts : new Set((approvedAmounts || []).map(Number));
  const customerSaid = [latestText, ...userTurns(history).slice(-8)];
  if (headcountMentioned(customerSaid) >= 2) return fail("multi_seat");
  if (customerSaid.some((text) => /ใบเสนอราคา/u.test(String(text || "")))) return fail("quotation_requested");
  const picked = latestRoundChoice({ history, latestText, rounds: Array.isArray(rounds) ? rounds : [], customerOnly: true });
  const roundCourse = picked ? (Array.isArray(courses) ? courses : []).find((candidate) => courseOwnsRound(candidate, picked)) || null : null;
  const course = courseFor({ latestText, history, courses, roundCourse });
  if (!course.ok) return course;
  const price = priceFor({ course: course.course, courses, history, approvedPrices, approved, customerTexts: customerSaid.concat(userTurns(history)) });
  if (!price.ok) return price;
  const round = roundFor({ course: course.course, rounds, latestText, history });
  if (!round.ok) return round;
  return { ok: true, course: course.course, displayName: courseLabelName(course.course, price.row), amount: price.amount,
    priceSource: price.source, round: round.round, roundOptions: round.options };
}

// ---- 4. ข้อความชุดเดียว ----
const COMPANY_DETAILS_REQUEST = "สำหรับออกเอกสารในนามบริษัท รบกวนส่งชื่อนิติบุคคล สำนักงานใหญ่หรือสาขาเลขที่ สถานที่ตั้ง เลขทะเบียนนิติบุคคล และชื่อ–เบอร์ผู้รับเอกสาร พร้อมที่อยู่จัดส่งด้วยนะคะ";
const baht = (amount) => Number(amount).toLocaleString("en-US");

/** bubbles ตามลำดับส่ง · imageAfter = รูปช่องทางชำระวางต่อจากบล็อกบัญชี · text = ทั้งชุดสำหรับด่านเงิน/ด่านคำ */
export function composePaymentMessage({ docType, offer, kit, companyDetailsGiven = false } = {}) {
  const company = docType === "company";
  const lead = company ? "ได้เลยค่ะ ออกเอกสารในนามบริษัทได้ค่ะ ลูกแพรสรุปรายละเอียดการสมัครให้นะคะ" : "ได้เลยค่ะ ลูกแพรสรุปรายละเอียดการสมัครให้นะคะ";
  const lines = [`คลาส : ${offer.displayName}`];
  if (offer.round) lines.push(`รอบ : ${roundLabel(offer.round)}`);
  else if (offer.roundOptions?.length) lines.push(`รอบ : เลือกได้ ${offer.roundOptions.map(roundLabel).join(" · ")} (แจ้งรอบที่สะดวกได้เลยค่ะ)`);
  lines.push(`ค่าเรียน : ${baht(offer.amount)} บาท/ท่าน`);
  if (docType !== "none") lines.push(`ออกเอกสารในนาม : ${DOC_TYPE_LABEL[docType] || DOC_TYPE_LABEL.person}`);
  const bubbles = [`${lead}\n\n${lines.join("\n")}`, kit.bank, kit.form];
  if (company && !companyDetailsGiven) bubbles.push(COMPANY_DETAILS_REQUEST);
  const marker = kit.imageKey ? `\n[IMAGE:${kit.imageKey}]` : "";
  return { bubbles, imageAfter: kit.imageKey ? 2 : undefined,
    text: [`${bubbles[0]}\n\n${bubbles[1]}${marker}`, ...bubbles.slice(2)].join("\n\n") };
}

// ---- 5. ตัดสินเทิร์น ----
/** ห้องนี้ได้ช่องทางชำระไปแล้วหรือยัง (ดีลเริ่มจ่าย หรือมีบล็อกบัญชีจากฝั่งร้านในประวัติ) */
// deal_status "awaiting_payment" อย่างเดียวไม่ใช่หลักฐาน — lifecycle ตั้งให้เองตอนลูกค้าเลือกรอบ (round_chosen) ทั้งที่ยังไม่มีใครส่งบัญชี
// หลักฐานจริง = ผู้เรียกส่ง evidence มา (audit ส่งบัญชี/ข้อความบัญชีทั้งห้อง จาก DB) · จ่ายแล้ว · มีเรื่องเงินเข้ามาแล้ว · บัญชีในประวัติ
const PAID_DEALS = new Set(["paid_confirmed", "prep_sent"]);
export function paymentAlreadyDelivered({ customer = null, history = [], evidence = false } = {}) {
  if (evidence) return true;
  if (PAID_DEALS.has(String(customer?.deal_status || "")) || Number(customer?.money_seen_at) > 0) return true;
  return botTurns(history).some((turn) => paymentInstructionsIndex(turn) >= 0);
}

export function readPin(raw, { now = Date.now(), sessionId = null } = {}) {
  try {
    const pin = JSON.parse(String(raw || "null"));
    if (!pin || !Object.hasOwn(DOC_TYPE_LABEL, pin.docType)) return null;
    if (!(now - Number(pin.at) < PAYMENT_STEP_PIN_TTL_MS)) return null;
    if (pin.sessionId && sessionId && pin.sessionId !== sessionId) return null;
    return pin;
  } catch {
    return null;
  }
}

/**
 * action:
 *  · "compose"   — ส่งข้อความชำระเงินที่ประกอบแล้ว (message)
 *  · "pin"       — ลูกค้าบอกประเภทเอกสารแล้ว แต่เทิร์นนี้ยังส่งไม่ได้ (reason) — เก็บหมุด ให้โมเดลตอบตามปกติ
 *                  manual = true เมื่อข้อมูลไม่พอ/กำกวม (ต้องให้คนส่งบัญชีเอง)
 *  · "clear"     — ลูกค้าขอยกเลิกระหว่างมีหมุด
 *  · "none"      — ไม่ใช่จังหวะนี้
 */
// ลูกค้าพูดถึงประเภทเอกสารเองชัด ๆ ("ขอเปลี่ยนเป็นนามบริษัท", "ออกใบเสร็จในนามบุคคลธรรมดานะคะ") = คำตอบใหม่ ชนะหมุดเดิม
const DOC_CONTEXT = /ในนาม|นาม(?:บริษัท|บุคคล)|ออกเอกสาร|ใบเสร็จ|ใบกำกับ|เป็นชื่อ|ชื่อ(?:บริษัท|บุคคล)|เปลี่ยนเป็น/u;
export function explicitDocStatement(units) {
  const lines = (Array.isArray(units) ? units : [units]).flatMap((unit) => String(unit ?? "").split(/\n+/u)).filter((line) => DOC_CONTEXT.test(line));
  return lines.length ? classifyDocTypeAnswer(lines.join("\n")) : null;
}

export function planPaymentStep({ text = "", parts = [], history = [], customer = null, pin = null, kit = null, delivered = false,
  courses = [], approvedPrices = [], approvedAmounts = null, rounds = [] } = {}) {
  if (!kit) return { action: "none", reason: "no_kit" };
  if (paymentAlreadyDelivered({ customer, history, evidence: delivered })) return { action: pin ? "clear" : "none", reason: "already_delivered" };
  const units = (Array.isArray(parts) && parts.length ? parts : [text]).map(String);
  const said = space(units.join(" "));
  const answered = (botAskedDocType(history) ? classifyDocTypeAnswer(units.join("\n")) : null) || explicitDocStatement(units);
  if (!answered && pin && units.some((unit) => CANCEL.test(space(unit)))) return { action: "clear", reason: "customer_cancelled" };
  const docType = answered || pin?.docType || null;
  if (!docType) return { action: "none", reason: "doc_type_unknown" };
  const wait = (reason, manual = false) => ({ action: "pin", docType, reason, manual });
  // ใบเสนอราคาเป็นงานของทีม (ออกเอกสารจริงก่อนโอน) — ระบบไม่ส่งบัญชีแซง
  if (/ใบเสนอราคา/u.test(said)) return wait("quotation_requested", true);
  if (DEFER.test(said)) return wait("customer_deferred");
  if (hasOtherAsk(units)) return wait("other_question");
  // ส่งทันทีเฉพาะคำตอบประเภทเอกสาร "ล้วน ๆ" (หรือข้อมูลบริษัท) · มีเนื้อหาอื่นพ่วง = ให้โมเดลคุยก่อน
  // ส่งจากหมุดเฉพาะเมื่อลูกค้าบอกชัดว่าพร้อม (โอน/สมัคร/ขอบัญชี/ได้เลย…) — "ขอบคุณค่ะ" เฉย ๆ ไม่นับ
  const ready = READY.test(said);
  if (answered && !ready && !isBareDocAnswer(units) && !units.some((unit) => COMPANY_DETAILS.test(unit))) return wait("extra_content");
  if (!answered && !ready) return wait("not_ready");
  const offer = resolvePaymentOffer({ latestText: units.join("\n"), history, courses, approvedPrices, approvedAmounts, rounds });
  if (!offer.ok) return wait(offer.reason, true);
  const companyDetailsGiven = [...units, ...userTurns(history).slice(-8)].some((value) => COMPANY_DETAILS.test(String(value || "")));
  const message = composePaymentMessage({ docType, offer, kit, companyDetailsGiven });
  // ตรวจตัวเองด้วยด่านเดียวกับทุกคำตอบ: ชื่อคลาส + ค่าเรียนที่ผูกกับคลาสนั้นต้องมาก่อนบล็อกชำระเงิน
  const self = checkPriceBeforeBank({ text: message.text, approvedAmounts, approvedPrices, courses, latestText: units.join("\n"), history });
  if (!self.ok || !self.bank) return wait(`self_check_${self.reason || "no_bank"}`, true);
  return { action: "compose", docType, offer, message, fromPin: !answered };
}

/** ร่างของโมเดลที่ยังพิมพ์ช่องทางชำระเอง: ตัดย่อหน้าที่มีบัญชี/ฟอร์มทิ้ง (เหลือคำตอบส่วนอื่น) */
// ตัดตั้งแต่ย่อหน้าแรกที่เป็นเรื่องช่องทางชำระจนจบ (บัญชี ฟอร์ม คำขอบคุณท้ายฟอร์มเดินมาเป็นชุดเดียวกันเสมอ)
export function stripPaymentInstructions(text) {
  const blocks = String(text || "").split(/\n{2,}/u);
  const first = blocks.findIndex((block) => paymentInstructionsIndex(block) >= 0
    || /^\s*(?:ธนาคาร|เลขที่บัญชี|ชื่อบัญชี)\s*[:：]/mu.test(block)
    || FORM_HEADING.test(block)
    || /(?:โอนชำระ|โอนเงิน)[^\n]{0,20}บัญชี|แจ้งโอนแล้ว/u.test(block));
  return (first < 0 ? blocks : blocks.slice(0, first)).join("\n\n").trim();
}

// ---- 5. ตอนลูกค้าแจ้งโอน/ส่งสลิป: ขอข้อมูลลงทะเบียนไปพร้อมกัน ถ้ายังไม่เคยกรอก (คำตอบ C4 ข้อ 12 ของพี่ง้วง, 20 ต.ค. 2026) ----
// "ถ้าลูกค้ายังไม่เคยกรอก ให้ข้อความของระบบขอข้อมูลลงทะเบียนไปด้วย ทีมจะได้ไม่ต้องตามทีหลัง"
// ฟอร์มมาจากการ์ดของเจ้าของ (ชุดเดียวกับที่ระบบส่งพร้อมบัญชี) — ไม่มีการ์ด/ตัวประกอบปิด = ข้อความเดิม ไม่มีฟอร์ม
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;
const PHONE = /(?<!\d)0\d(?:[\s-]?\d){7,8}(?!\d)/u;
const fieldLabels = (form) => String(form || "").split("\n").filter((line) => FORM_FIELD.test(line))
  .map((line) => line.replace(/^\s*-\s*/u, "").replace(/[*＊]?\s*[:：]\s*$/u, "").trim()).filter((label) => [...label].length >= 2);

/** ลูกค้าเคยส่งข้อมูลลงทะเบียนแล้วหรือยัง — ข้อความของลูกค้าที่มีอีเมลคู่กับเบอร์/หัวช่องฟอร์ม หรือมีหัวช่องฟอร์มตั้งแต่สองช่อง */
export function registrationFormFilled(history = [], kit = null) {
  const labels = fieldLabels(kit?.form);
  return userTurns(history).some((text) => {
    const labelHits = labels.filter((label) => text.includes(label)).length;
    if (labelHits >= 2) return true;
    return EMAIL.test(text) && (PHONE.test(text) || labelHits >= 1);
  });
}

/** ข้อความแจ้งโอน/สลิปของระบบ + ฟอร์มลงทะเบียน (เฉพาะห้องที่ยังไม่เคยกรอก) */
export function withRegistrationAsk(text, { kit = null, history = [] } = {}) {
  const form = String(kit?.form || "").trim();
  if (!form || registrationFormFilled(history, kit)) return text;
  return `${String(text || "").trim()}\n\n${form}`;
}
