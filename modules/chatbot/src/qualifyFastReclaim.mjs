// qualifyFastReclaim.mjs — ห้องสีเหลืองที่ลูกค้าพิมพ์มาใหม่ (คำสั่งพี่ง้วง 5 ต.ค. 2026)
//
// พี่ง้วง: "ถ้าเมื่อไหร่ sense ได้ว่าแชทนั้น ๆ มีศักยภาพขึ้นมา (มีแนวโน้มน่าจะซื้อคอร์สได้) ให้กลับมาเปิดสีเขียวเหมือนเดิม"
// ตัวกวาดรายชั่วโมงตัดสินด้วยโมเดล — แต่บางข้อความรอชั่วโมงไม่ได้ จึงเปิดเขียวทันทีในเทิร์นเดียวกัน (ไม่เรียกโมเดล):
//   · ความปลอดภัย/ต้องการคน: เส้น priority safety · route.escalate · ขอหยุดทัก (opt-out) · ขอให้เงียบ (quiet_stop)
//     ห้องเหลืองเงียบสนิท = ร้องเรียน/ขอคุยกับคน/เรื่องด่วนถูกกลืน ไม่มีธง ไม่มี push — ต้องเดินเส้นปกติให้ครบ
//     (เส้นปกติจะปิด AI ต่อด้วยเหตุที่คนต้องดูแลเอง เช่น complaint/human_requested — ห้องไม่กลับไปเป็นเหลือง)
//   · สัญญาณซื้อ: ใบ้จอง/ขอติดต่อทีม (เทิร์นนี้) · แจ้งโอน · ถามเรื่องเงิน · เลือกรอบ/จะสมัคร/ถามตารางเรียน
//     + (รีวิวปรปักษ์ 5 ต.ค. #3/#7) ราคา/โปร/สนใจ/สถานที่ของ salesMotion · งานทีม/in-house · ขอเลขบัญชี/QR/บัตร/จะโอน
//     · ถามรอบ/รายละเอียดคลาส · ทวงคำตอบ/กล่าวหาว่าโกง — เดิมใช้แค่ตัวจับเดิมห้าตัว แล้วข้อความอย่าง "ขอเลขบัญชีค่ะ"
//     "บริษัทจะส่งพนักงาน 5 คนมาเรียน" "ทำไมไม่ตอบ" ตกไปรอโมเดล (ซึ่งล้ม/ตอบ unclear/สวิตช์ไม่ใช่ on ได้) ห้องจึงเงียบใส่
//     คนที่พร้อมจ่ายหรือกำลังโกรธ · ตัวจับเดิมใช้ก่อนเสมอ ชุดคำใหม่มีเฉพาะสิ่งที่ตัวจับเดิมไม่รู้จัก (ชุดเล็ก มีเทสต์ทุกวลี)
// ไม่เข้าข่าย = ห้องยังเหลือง แล้วปักกุญแจ qualify_recheck ให้ตัวกวาดตรวจซ้ำภายในไม่กี่นาที (ไม่ต้องรอชั่วโมง)
//
// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ด่าน "ห้ามเปิดทับห้อง NEEDS_HUMAN" ของรอบแรก (#1/#19) ถอดออกแล้ว — มันทำให้ห้องเหลืองเข้มกว่า
// ห้องเขียว: ลีดที่ส่งไฟล์/รูปที่โหลดไม่ได้/เสียงที่ถอดไม่ออกแล้วถามราคา ห้องเขียวตอบ (AI ยังเปิดใน NEEDS_HUMAN) แต่ห้องเหลือง
// เงียบ และตัวกวาดก็เปิดให้ไม่ได้ (greenBlockReason = state) จนกว่าคนจะมาแตะ · ต้นเหตุจริงของ #2 (ไฟล์ในห้องที่ทีมคุยอยู่)
// ปิดที่ไปป์ไลน์แล้ว: ห้องนั้นเปลี่ยนเหตุเป็น file_review (รูปเงิน/แจ้งโอน = money_line) — CAS ด้านล่างแพ้ที่ "เหตุ" เอง
// ทุกเส้นที่ห้องเหลืองยังค้าง not_qualified + NEEDS_HUMAN จึงเป็นเส้นที่ห้องเขียวเปิด AI ไว้ตามปกติ
// ระวังสัญญาณหลอก (รีวิวปรปักษ์รอบ 2): ปฏิเสธ ("ไม่สนใจ") · ขอของฟรี · หางาน/สมัครเป็นพนักงาน · "หาเงินด่วน" ต้องยังเหลือง
//
// ไฟล์นี้ห้าม import qualifySweep.mjs หรือ pipeline.mjs (ตัวกวาด/ไปป์ไลน์ import ไฟล์นี้อยู่แล้ว — กันวงกลม)
import { isPaymentActionText } from "./safetyRouter.mjs";
import { asksAboutMoney } from "./priceDisclosure.mjs";
import { detectBuyingSignals, detectHeadcount, recommendProduct } from "./salesMotion.mjs";
import {
  AUDIT_AI_OFF_NOT_QUALIFIED, AUDIT_AI_ON_QUALIFIED, NOT_QUALIFIED_REASON, QUALIFY_AUDIT_OPERATOR, isNotQualifiedRow,
  qualifyHoldKey, qualifyRecheckKey, qualifyStateKey, readJsonSetting,
} from "./notQualified.mjs";

// สัญญาณที่เป็น "ต้องให้คน/เส้นปลอดภัยเดิน" ไม่ใช่การซื้อ — สถานะที่จดไว้จึงไม่ใช่คำตัดสิน potential
// (เส้นปกติปิดห้องต่อด้วยเหตุของคนทันที เช่น complaint/human_requested/optout)
const SAFETY_SIGNALS = new Set(["safety", "escalate", "optout", "quiet_stop"]);
// ลูกค้าทวงคำตอบ/กล่าวหา — ต้องมีคนหรือ AI ตอบ แต่ไม่ใช่หลักฐานว่าจะซื้อ (จดเป็น unclear ไม่ใช่ potential)
const ATTENTION_SIGNALS = new Set(["frustration"]);
// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ทางลัดเคยจดทุกสัญญาณเป็น potential/buying_intent มั่นใจ 1.0 — "สนใจค่ะ" คำเดียวถูกบันทึกว่า
// เป็นผู้ซื้อแน่นอนเท่ากับคนขอเลขบัญชี · ทางลัดไม่ได้ถามโมเดล จึงจดความมั่นใจแบบพอประมาณตามน้ำหนักของสัญญาณ
// (ตัวกวาดอ่านแค่ mode/lastInboundId ของสถานะนี้ — ตัวเลขนี้มีไว้ให้คนอ่าน/สถิติ ไม่ได้เปลี่ยนการตัดสิน)
const STRONG_BUYING_SIGNALS = new Set(["handoff", "payment_action", "money_ask", "payment_intent", "enroll", "team"]);
const SOFT_BUYING_SIGNALS = new Set(["interest", "location"]);
// ห้องที่ปิดเหลืองด้วยการตีจบแชทนอกเรื่อง (offtopicClose.mjs — สถานะ qualify:<id> มีช่อง offtopic): สัญญาณสองตัวนี้ไม่เปิดเขียวทันที
// (เฉพาะหมวดใน OFFTOPIC_HOLD_CATEGORIES — ข้อความที่ยังมีคำนอกเรื่องพักทุกหมวด)
const OFFTOPIC_SOFT_SIGNALS = new Set(["interest", "class_ask"]);
// รีวิว 12 ต.ค. (รอบ 2): พักเปิดเขียวเฉพาะหมวดที่ "สนใจไหม/พร้อมลงทุน" เป็นคำของผู้เสนอขายเอง หรือเป็นห้องที่ไม่มีวันเป็นผู้ซื้อ
// (ชวนธุรกิจ · ขาย AI · พนัน · ลวนลาม · เรื่องส่วนตัว) — ห้องไม่มีงบ/พระ/หางาน/ขอเงินที่กลับมาบอกว่า
// "ตอนนี้มีงบแล้ว สนใจคลาส" = ผู้ซื้อที่กลับมา เปิดเขียวทันทีตามทางลัดเดิม (ไฟล์นี้ import offtopicClose.mjs ไม่ได้ — วน import)
// (รีวิวรอบ 7: ไม่มีการตีจบเพราะข้อความหลอกระบบแล้ว — ทุกห้องที่ตีจบผ่าน Luna ยืนยัน)
export const OFFTOPIC_HOLD_CATEGORIES = Object.freeze(["business_pitch", "ai_vendor", "gambling", "adult_harassment", "off_topic_personal"]);
// หมวดตีจบของห้องนี้ ("" = ไม่ได้ปิดเหลืองด้วยการตีจบ) — ทุกหมวด (รวมไม่มีงบ/พระ/หางาน/ขอเงิน)
function offtopicClosedCategory(db, customerId) {
  const state = readJsonSetting(db, qualifyStateKey(customerId));
  const category = typeof state?.offtopic === "string" ? state.offtopic : "";
  return state?.verdict === "not_qualified" ? category : "";
}
// ไปป์ไลน์ส่งตัวจับคำนอกเรื่อง (ดอกที่ 1 ของ offtopicClose) มาเป็นฟังก์ชัน — เรียกเฉพาะห้องที่ตีจบแล้ว (ไฟล์นี้ import ตัวนั้นตรง ๆ ไม่ได้: วน import)
function offtopicCueIn(signalInput, logger) {
  try {
    return typeof signalInput?.offtopicCueOf === "function" && Boolean(signalInput.offtopicCueOf());
  } catch (err) {
    logger?.warn?.(`qualify-fast: ตรวจคำนอกเรื่องไม่สำเร็จ (${err?.message || err})`);
    return false;
  }
}
export const FAST_VERDICT_CONFIDENCE = Object.freeze({ strong: 0.75, medium: 0.7, soft: 0.6, attention: 0.5 });

/** คำตัดสินที่ทางลัดจดของสัญญาณนี้ — pure (export ไว้ให้เทสต์ล็อกว่าไม่มีสัญญาณไหนจด 1.0) */
export function fastVerdictFor(signal) {
  const key = String(signal || "");
  if (SAFETY_SIGNALS.has(key) || ATTENTION_SIGNALS.has(key)) {
    return { verdict: "unclear", category: "insufficient", confidence: FAST_VERDICT_CONFIDENCE.attention, strength: SAFETY_SIGNALS.has(key) ? "safety" : "attention" };
  }
  const strength = STRONG_BUYING_SIGNALS.has(key) ? "strong" : SOFT_BUYING_SIGNALS.has(key) ? "soft" : "medium";
  return { verdict: "potential", category: "buying_intent", confidence: FAST_VERDICT_CONFIDENCE[strength], strength };
}
const SIGNAL_REASON = Object.freeze({
  safety: "ข้อความเรื่องด่วน/ร้องเรียน/ขอคุยกับคน — เปิด AI ให้เส้นปลอดภัยทำงาน",
  escalate: "ข้อความที่ต้องส่งต่อให้คน — เปิด AI ให้เส้นส่งต่อทำงาน",
  optout: "ลูกค้าขอหยุดการทัก — เปิด AI เพื่อตอบรับและหยุดตามขั้นตอน",
  quiet_stop: "ลูกค้าขอให้หยุดตอบ — เปิด AI เพื่อปิดเงียบตามขั้นตอน",
  handoff: "ลูกค้าขอจองหรือขอติดต่อทีม",
  payment_action: "ลูกค้าแจ้งการชำระเงิน",
  money_ask: "ลูกค้าถามเรื่องราคาหรือการชำระ",
  payment_intent: "ลูกค้าขอช่องทางชำระหรือบอกว่าจะโอน",
  frustration: "ลูกค้าทวงคำตอบหรือไม่พอใจ — เปิด AI ให้มีคนตอบ",
  enroll: "ลูกค้าแสดงเจตนาสมัครหรือเลือกรอบ",
  schedule: "ลูกค้าถามตารางหรือรอบเรียน",
  price: "ลูกค้าถามราคา",
  promotion: "ลูกค้าถามโปรโมชั่นหรือการผ่อน",
  team: "ลูกค้าจะพาทีมหรือพนักงานมาเรียน",
  class_ask: "ลูกค้าถามรอบหรือรายละเอียดคลาส",
  interest: "ลูกค้าบอกว่าสนใจเรียน",
  location: "ลูกค้าถามสถานที่หรือรูปแบบการเรียน",
});

// ---- ชุดคำเล็ก ๆ ที่ตัวจับเดิมไม่รู้จัก (รีวิวปรปักษ์ 5 ต.ค. #3/#7 — ทุกวลีในรีวิวมีเทสต์) ----
// ขอช่องทางชำระ/บอกว่าจะโอน — isPaymentActionText จับเฉพาะ "โอนแล้ว" ส่วน asksAboutMoney จับเฉพาะคำถามราคา
// รีวิวรอบ 6 (ตีจบนอกเรื่อง): "เดี๋ยวผมโอนให้ทีเดียวเลย" "ผมโอนให้ทีเดียวเต็มจำนวน" ในห้องที่ตีจบแล้ว = ผู้ซื้อที่จะจ่าย (เดิมเงียบ)
const PAYMENT_INTENT = /(?:เลข(?:ที่)?บัญชี|ขอบัญชี|บัญชี(?:ไหน|อะไร)|เข้าบัญชี|พร้อมเพย์|คิวอาร์|(?<![a-z])qr(?![a-z])|พร้อม(?:โอน|ชำระ|จ่าย)|จะ(?:โอน|ชำระ)|(?:เดี๋ยว|เด๋ว)\s*(?:(?:ผม|หนู|ฉัน|เรา|ดิฉัน)\s*)?(?:โอน|ชำระ|จ่าย)|(?:โอน|จ่าย)(?:ให้)?\s*(?:ทีเดียว|เต็มจำนวน)|โอน(?:เลย|ได้เลย|พรุ่งนี้|วันนี้|ทาง|ยังไง|ที่ไหน|ไปที่)|(?:จ่าย|ชำระ)(?:ผ่าน|ด้วย)?(?:บัตร|เครดิต)|รูดบัตร|ตัดบัตร|บัตรเครดิต|ผ่อน)/iu;
// ทวงคำตอบ/กล่าวหา — ห้องเหลืองเงียบใส่ "ทำไมไม่ตอบ"/"โกงหรือเปล่า" = ชื่อเสียงเสีย (ตัวกวาดไม่มีกฎร้องเรียน)
const FRUSTRATION = /(?:ทำไม(?:ยัง)?ไม่(?:ตอบ|อ่าน)|(?:จะ|ไม่)ตอบ(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|เลย)|ตอบช้า|อยู่(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า)|โกง|ต้มตุ๋น|มิจฉาชีพ)/u;
// รีวิวปรปักษ์รอบ 2 5 ต.ค.: "ด่วน" ลอย ๆ เคยจับ "หาเงินด่วน" "มีงานด่วนไหม" ของคนหางาน (กลุ่มที่ตัวกวาดตั้งใจพัก) จนห้องเปิดเขียว
// นับเฉพาะการขอให้รีบตอบ: ขึ้นต้นด้วยด่วน · เรื่องด่วน · ตอบด่วน · ขอด่วน · ลงท้ายด้วย "ด่วนมาก/ด่วนที่สุด"
// และไม่นับเมื่อมีคำว่าเงิน/งานอยู่ไม่เกิน 4 ตัวก่อนหน้า ("ขอเงินด่วน" "ทำงานด่วน" = หาเงิน ไม่ใช่ทวงคำตอบ)
const URGENT_ASK = /(?:^\s*ด่วน|เรื่องด่วน|ตอบด่วน|ขอด่วน|ด่วน(?:มาก|ที่สุด)(?:ค่ะ|คะ|ครับ)?\s*[!?.]*\s*$)/u;
const MONEY_OR_JOB_URGENT = /(?:เงิน|งาน)[^\n]{0,4}ด่วน/u;
// "ไม่ได้หลอกนะคะ" = ลูกค้าบอกว่าตัวเองไม่ได้หลอก ไม่ใช่กล่าวหาเรา — ตัดทิ้งก่อนหา "หลอก"
// แต่ "ไม่ได้หลอกใช่ไหมคะ" คือถามด้วยความระแวง ยังนับ (มีคำถามต่อท้ายไม่เกิน 12 ตัว)
const NOT_SCAMMING = /ไม่ได้\s*หลอก(?!\S{0,12}(?:ใช่ไหม|ใช่มั้ย|ใช่ป่ะ|ใช่ปะ|ไหม|มั้ย|หรือเปล่า|รึเปล่า|\?))/gu;
const SCAM_WORD = /หลอก/u;

function isFrustration(value) {
  if (FRUSTRATION.test(value)) return true;
  if (URGENT_ASK.test(value) && !MONEY_OR_JOB_URGENT.test(value)) return true;
  return SCAM_WORD.test(value.replace(NOT_SCAMMING, " "));
}
// งานทีม/in-house — ตัวจับจริงของระบบ (detectDirectOpportunityType) ต้องมีนโยบายขาย ไปป์ไลน์ส่งผลมาเป็น projectOpportunity
// ชุดนี้คือตัวสำรองเมื่อไม่มีนโยบาย: คำ in-house ตรง ๆ · พนักงาน/ทีม/ลูกน้อง/องค์กร คู่กับการเรียน (ไม่ใช่แค่ "เคยทำงานบริษัท")
// พี่ง้วง 13 ต.ค.: on-site/ออนไซต์ เปล่า ๆ = คลาสสอนสดที่ห้องเรียน (Classroom) ไม่ใช่งานทีม — นับเฉพาะคู่กับทีม/บริษัท
const TEAM_LEARNING = /(?:in[-\s]?house|อินเฮาส์|(?:on[-\s]?site|ออนไซต์|ออนไซท์)[^\n]{0,20}?(?:ให้|ที่|ใน)\s*(?:ทีม|พนักงาน|บริษัท|องค์กร|ออฟฟิศ)|(?:พนักงาน|ทีม|ลูกน้อง|องค์กร)[^\n]{0,24}?(?:เรียน|อบรม|เทรน|ใช้\s*AI)|(?:เรียน|อบรม|สอน|เทรน)[^\n]{0,24}?(?:พนักงาน|ทีม|ลูกน้อง|องค์กร))/iu;
const LEARNING_WORD = /(?:เรียน|อบรม|คลาส|คอร์ส|สมัคร)/u;
// รีวิวรอบ 6: ขอ/จองที่นั่งเป็นจำนวน ("ขอสัก 10 ที่ครับ" "จอง 3 ที่") = สมัคร (เดิมห้องที่ตีจบแล้วเงียบ)
const SEAT_ASK = /(?:ขอ|จอง|เอา)\s?(?:สัก\s?)?\d{1,3}\s?(?:ที่นั่ง|ที่|ท่าน)/u;
// ถามรอบ/รายละเอียดคลาสทรงที่ schedule ของ salesMotion ไม่รู้จัก ("คลาสหน้าเมื่อไหร่" "เรียนกี่โมง" "เอาคอร์สนี้")
const CLASS_ASK = /(?:(?:คลาส|คอร์ส|รอบ(?:เรียน)?)[^\n]{0,12}?(?:เมื่อไ(?:หร่|ร)|วันไหน|กี่โมง|ไหนบ้าง|ออนไลน์|เดือนหน้า|ครั้งหน้า|ถัดไป|เปิดอีก)|เรียน(?:กี่โมง|วันไหน|ตอนไหน|ช่วงไหน)|รายละเอียด(?:คลาส|คอร์ส|การเรียน)|(?:เอา|ลง|ซื้อ)(?:คอร์ส|คลาส)|ลงเรียน|พร้อม(?:ลงทุน|จ่าย|เรียน))/u;
// ห้องเหลืองคือคนที่ "หางาน/หารายได้" — "อยากได้งานทำ" "สนใจหารายได้" "สมัครงาน" ไม่ใช่สัญญาณซื้อ
// (interest ของ salesMotion มีคำว่า "อยากได้" และ enroll มีคำว่า "สมัคร" — ตัดคำเหล่านี้ทิ้งก่อนอ่านสัญญาณ)
// รีวิวปรปักษ์รอบ 2 5 ต.ค.: เดิมตัดแค่ "สมัครงาน" — "อยากสมัครเป็นพนักงานค่ะ" "รับพนักงานไหมคะ" "อยากเป็นทีมงานของพี่ง้วง"
// "สนใจทำงานออนไลน์" เปิดเขียวเป็น enroll/team/interest แล้วจดว่าเป็นผู้ซื้อ
const JOB_APPLICATION = /(?:(?:รับ)?สมัคร(?:เป็น)?(?:งาน|พนักงาน|ทีมงาน|แอดมิน|ตัวแทน)|รับ(?:พนักงาน|สมัคร))/gu;
// คำหางานชัด ๆ (ใช้กัน team/class_ask/interest) — "งานพิเศษ" ไม่อยู่ชุดนี้: ตัวจับ project ของระบบใช้คำนี้กับงานวิทยากรได้
// คำกำกวมต้องมีบริบทการ "ของาน": "รับพนักงานไหม" (ถามหางาน) ≠ "ร้านรับพนักงานใหม่ 5 คน" (เจ้าของร้าน) ·
// "สนใจทำงานออนไลน์" ≠ "ทำงานออนไลน์อยู่แล้ว" · "อยากเป็นทีมงานของพี่ง้วง" ≠ "ผมเป็นทีมงานฝ่ายการตลาด" ·
// "ทำงานกับพี่ง้วง/ทางเพจ" ≠ "ทำงานกับทีม 10 คน" — ผู้ซื้อจริงต้องไม่ถูกกันเพราะเล่าเรื่องงานของตัวเอง
// รีวิวปรปักษ์รอบ 3 5 ต.ค.: "สนใจงานค่ะ" เคยเปิดเขียวเป็น interest — นับเฉพาะ "สนใจ(ทำ)งาน" ที่จบประโยค ("สนใจงานสัมมนา" ไม่นับ)
const JOB_SEEKING = /(?:หางาน|งานทำ|สมัครงาน|อยากได้งาน|สนใจ(?:ทำ)?งาน(?=(?:ค่ะ|คะ|ครับ|คับ|จ้า|จ้ะ|นะ(?:คะ|ครับ)?)?(?:\s|[!?.]|$))|สมัคร(?:เป็น)?(?:พนักงาน|ทีมงาน|แอดมิน|ตัวแทน)|รับ(?:พนักงาน|คน|ทีมงาน)(?:เพิ่ม)?(?:ไหม|มั้ย|อยู่ไหม|หรือเปล่า|รึเปล่า|ป่ะ)|รับสมัครงาน|อยาก(?:ทำงาน)?เป็นทีมงาน|เป็นทีมงาน(?:ของ|กับ|ให้)|ร่วมงานกับ|(?:สนใจ|อยาก|หา|ขอ|รับ|มี)(?:ทำ)?งาน(?:ออนไลน์|ที่บ้าน|อยู่บ้าน)|ทำงานกับ(?:พี่|ทาง|ที่นี่|คุณ|เพจ|ร้าน|บริษัท(?:นี้|คุณ))|(?:เงิน|งาน)ด่วน)/u;
// กว้างกว่า (ชุดเดิมของ interest): หารายได้/หาเงิน/ทำงานกับ — กันเฉพาะ interest ("สนใจหารายได้") ไม่กันทีม/รอบ/สมัคร/ราคา
const INCOME_SEEKING = /(?:หารายได้|รายได้เสริม|หาเงิน|ได้เงิน|งานพิเศษ|ทำงานกับ)/u;
// รีวิวปรปักษ์รอบ 2 5 ต.ค.: interest ไม่ดูคำปฏิเสธ — "ไม่สนใจค่ะ" "ยังไม่สนใจค่ะ" "ไม่อยากเรียนแล้วค่ะ" เคยเปิดเขียวเป็นผู้ซื้อ
// ตัดวลีปฏิเสธทั้งคำ (ถึงช่องว่างหรือ "แต่" ถัดไป) ก่อนอ่าน enroll/team/class_ask/interest — "ไม่เอาออนไลน์ อยากเรียนที่ห้อง"
// ยังเห็นท่อนหลังที่เป็นสัญญาณจริง
// รีวิวปรปักษ์รอบ 3 5 ต.ค.: เดิมรู้จักแค่ สนใจ/อยาก(เรียน|สมัคร|ได้)/เอา — "ไม่สมัครค่ะ" "ยังไม่จองนะคะ" "คงไม่ได้สมัครค่ะ"
// "ไม่ต้องจองให้นะคะ" "ไม่ลงเรียนค่ะ" "ไม่ซื้อคอร์สค่ะ" "เลิกสนใจแล้ว" เปิดเขียวและถูกจดเป็นผู้ซื้อ (enroll มั่นใจ 0.75)
// เพิ่มคำปฏิเสธ คงไม่ได้/ไม่ต้อง/เลิก และกริยา จอง/สมัคร/ลงเรียน/ลงทะเบียน/ซื้อ (ยังหยุดที่ "แต่" เหมือนเดิม)
const NEGATED_WANT = /(?:คงไม่ได้|ไม่ได้|ไม่ต้อง|ไม่ค่อย|ยังไม่|ไม่|เลิก)\s*(?:(?:น่า)?สนใจ|อยาก(?:เรียน|สมัคร|ได้|จอง)|เอา|สมัคร|จอง|ลง(?:เรียน|ทะเบียน)|ซื้อ)(?:(?!แต่)\S)*/gu;
// ขอของฟรี = ยังเหลืองสำหรับ interest/team/class_ask ("อยากเรียนฟรี" ไม่ใช่หลักฐานว่าจะจ่าย) · ฟรีแลนซ์ = อาชีพ ไม่ใช่ของฟรี
// รีวิวปรปักษ์รอบ 3 5 ต.ค.: "อยากได้ของแจกค่ะ" เคยเปิดเขียวเป็น interest — แจก = ของฟรี ("แจกแจงรายละเอียด" = อธิบาย ไม่นับ)
const FREE_ASK = /(?:ฟรี(?!แลน)|(?<![a-z])free(?![a-z])|แจก(?!แจง))/iu;
// รีวิวปรปักษ์รอบ 3 5 ต.ค.: คนหารายได้ถามค่าตอบแทนของตัวเอง ("เงินเดือนเท่าไหร่คะ" "ได้เงินวันละเท่าไหร่คะ" "ค่าจ้างเท่าไหร่คะ"
// "รับเงินผ่านบัญชีไหนคะ") เคยเปิดเขียวเป็น money_ask/payment_intent มั่นใจ 0.75 — คำเงินฝั่ง "ได้รับ" โดยไม่มีคำคอร์ส/ราคา
// ข้ามตัวจับเงินทั้งสามชุด (money_ask · payment_intent · price/promotion) ให้โมเดลตรวจซ้ำตัดสินแทน (~2 นาที)
// "คอร์สราคาเท่าไหร่คะ" "ขอเลขบัญชีค่ะ จะโอนค่าเรียน" ยังเปิดทันที · ได้เงินคืน (คืนเงิน) และรับเงินสด (จ่ายสด) เป็นคำถามผู้ซื้อ
// รอบ 3 ตรวจซ้ำ: "เพิ่มรายได้ร้าน" / "รับเงินผ่านบัตร" คือภาษาของเจ้าของธุรกิจที่จะซื้อ ไม่ใช่คนหางาน
const EARNING = /(?:เงินเดือน|ค่าจ้าง|ค่าแรง|(?<!เพิ่ม|สร้าง|ยอด)รายได้(?!ร้าน|ของร้าน|ธุรกิจ|ของธุรกิจ|บริษัท|กิจการ|ตก|ลด)|ได้เงิน(?!คืน)|รับเงิน(?!สด|(?:ผ่าน|ทาง|ด้วย|เป็น)?\s?(?:บัตร|พร้อมเพย์|qr|QR|คิวอาร์|เงินสด))|เงินเข้า|ค่าคอม)/u;
const COURSE = /(?:คอร์ส|คลาส|เรียน|ค่าเรียน|ราคา|สมัคร|อบรม)/u;
const asksAboutEarning = (value) => EARNING.test(value) && !COURSE.test(value);

function buyingKeySignal(value, earning = false) {
  const keys = detectBuyingSignals({ text: value.replace(JOB_APPLICATION, " ") }).keys;
  for (const key of earning ? ["enroll", "schedule"] : ["enroll", "schedule", "price", "promotion"]) if (keys.includes(key)) return key;
  return "";
}

/** ทีม/พนักงานมาเรียน: ผลจากตัวจับงาน project ของไปป์ไลน์ หรือคำ in-house/ทีม+เรียน หรือจำนวนคนที่ควรเป็นคลาสทีม */
function teamSignal(value, projectOpportunity) {
  if (projectOpportunity) return true;
  if (TEAM_LEARNING.test(value)) return true;
  return Boolean(recommendProduct({ headcount: detectHeadcount(value) })) && LEARNING_WORD.test(value);
}

/**
 * สัญญาณซื้อที่ต้องกันคำปฏิเสธ/ของฟรี/หางานก่อน (รีวิวปรปักษ์รอบ 2 5 ต.ค.)
 * value = ข้อความเต็ม · wanted = ข้อความที่ตัดวลีปฏิเสธออกแล้ว — ผลตัวจับ project ของไปป์ไลน์อ่านจากข้อความเต็ม
 * จึงใช้ได้เฉพาะเมื่อไม่มีวลีปฏิเสธ ("ไม่สนใจ inhouse ค่ะ" ต้องไม่เป็น team)
 */
function guardedBuyingSignal(value, projectOpportunity, earning = false) {
  const wanted = value.replace(NEGATED_WANT, " ");
  const key = buyingKeySignal(wanted, earning);
  if (key) return key;
  if (SEAT_ASK.test(wanted)) return "enroll";
  // รอบ 3 ตรวจซ้ำ: ดูคำหางานจากข้อความที่ตัดคำปฏิเสธแล้ว — "ไม่ได้สนใจงานค่ะ สนใจคอร์ส" ต้องได้ AI คืน
  const freeOrJob = FREE_ASK.test(value) || JOB_SEEKING.test(wanted);
  if (!freeOrJob && teamSignal(wanted, wanted === value ? projectOpportunity : null)) return "team";
  if (!freeOrJob && CLASS_ASK.test(wanted)) return "class_ask";
  const soft = detectBuyingSignals({ text: wanted }).keys;
  if (soft.includes("interest") && !freeOrJob && !INCOME_SEEKING.test(value)) return "interest";
  if (soft.includes("location")) return "location";
  return "";
}

/**
 * สัญญาณเปิดเขียวทันทีของเทิร์นนี้ ("" = ไม่มี) — pure
 * @param {{route?: object, prioritySafetyRoute?: boolean, handoffHint?: object|null, text?: string, projectOpportunity?: string|null}} input
 *   projectOpportunity = ผล detectDirectOpportunityType ของข้อความนี้ (ไปป์ไลน์ส่งมาเมื่อมีนโยบายขาย)
 */
export function fastReclaimSignal({ route = null, prioritySafetyRoute = false, handoffHint = null, text = "", projectOpportunity = null } = {}) {
  if (prioritySafetyRoute) return "safety";
  if (route?.escalate) return "escalate";
  if (route?.optOut) return "optout";
  if (route?.route === "quiet_stop") return "quiet_stop";
  // ใบ้จาก "ข้อความก่อนหน้า" ตัวกวาดเห็นไปแล้วตอนตัดสินเหลือง — นับเฉพาะใบ้ของเทิร์นนี้
  if (handoffHint && handoffHint.from === "current") return "handoff";
  const value = String(text ?? "");
  if (!value.trim()) return "";
  if (isPaymentActionText(value)) return "payment_action";
  const earning = asksAboutEarning(value); // รอบ 3: ถามค่าตอบแทนของตัวเอง ไม่ใช่ถามราคาคอร์ส
  if (!earning && asksAboutMoney(value)) return "money_ask";
  if (!earning && PAYMENT_INTENT.test(value)) return "payment_intent";
  if (isFrustration(value)) return "frustration";
  return guardedBuyingSignal(value, projectOpportunity, earning);
}

/** สัญญาณกลุ่มความปลอดภัย/ต้องให้คน (เส้นปกติปิดห้องต่อด้วยเหตุของคนเอง) — จดสถานะเป็น unclear ไม่ใช่ผู้ซื้อ */
export function isSafetyReclaimSignal(signal) {
  return SAFETY_SIGNALS.has(String(signal || ""));
}

/**
 * เปิดห้องสีเหลืองกลับเป็นเขียวแบบ compare-and-set (เฉพาะห้องที่ยังเป็นของตัวกวาดจริง: ai_enabled=0 + เหตุ not_qualified)
 * ต้องเรียกในคิวของห้อง และ "ก่อน" controlGate.open — ประตูอ่าน ai_enabled ครั้งเดียวต่อเทิร์น
 * รีวิวปรปักษ์รอบ 2 5 ต.ค.: ไม่มีเงื่อนไข state อีกแล้ว (ดูหัวไฟล์) — ห้อง NEEDS_HUMAN ที่ยัง not_qualified ได้คำตอบเหมือนห้องเขียว
 * ห้องที่ทีมต้องดูจริง (ไฟล์ในห้องที่ทีมคุยอยู่ · รูปเงิน · แจ้งโอน) เปลี่ยนเหตุไปแล้ว CAS นี้จึงแพ้ที่ ai_off_reason
 * @returns {boolean} true = เปิดสำเร็จ (เทิร์นนี้เดินเส้นปกติต่อได้)
 */
export function reclaimNotQualified({ db, customerId, signal, lastInboundId = "", nowMs = Date.now(), logger = console }) {
  if (!signal) return false;
  const changed = db.raw.prepare(
    `UPDATE customers SET ai_enabled = 1, ai_off_reason = ''
      WHERE line_user_id = ? AND ai_enabled = 0 AND ai_off_reason = ?`,
  ).run(String(customerId), NOT_QUALIFIED_REASON).changes === 1;
  if (!changed) return false;
  // รีวิวปรปักษ์ 5 ต.ค. #20 (รวมงาน): หมุด qualify_hold มีความหมายเฉพาะตอนห้องเหลือง — ตัวกวาดลบทุกครั้งที่เปิดเขียว
  // ทางลัดนี้ลบเหมือนกัน ให้ "มีหมุด = ห้องเหลืองที่ตัวกวาดยืนยันแล้ว" จริงทุกเส้น (คิวรอตอบ/KPI อ่านกติกานี้)
  try {
    db.raw.prepare("DELETE FROM settings WHERE key = ?").run(qualifyHoldKey(customerId));
  } catch (err) {
    logger?.warn?.(`qualify-fast: ลบหมุด hold ไม่สำเร็จ (${err?.message || err})`);
  }
  const judged = fastVerdictFor(signal);
  try {
    db.addAudit({
      operator: QUALIFY_AUDIT_OPERATOR, action: AUDIT_AI_ON_QUALIFIED, target: String(customerId),
      detail: `fast:${signal}`,
    });
  } catch (err) {
    logger?.warn?.(`qualify-fast: audit ไม่สำเร็จ (${err?.message || err})`);
  }
  try {
    // lastInboundId = ข้อความนี้ → ตัวกวาดไม่ตัดสินห้องนี้ซ้ำจนกว่าลูกค้าจะพิมพ์ใหม่ (ไม่จ่ายซ้ำกับหลักฐานเดิม)
    db.setSetting(qualifyStateKey(customerId), JSON.stringify({
      verdict: judged.verdict,
      confidence: judged.confidence,
      category: judged.category,
      strength: judged.strength,
      reason: SIGNAL_REASON[signal] || "",
      evidenceIds: [],
      lastInboundId: String(lastInboundId || ""),
      at: Number(nowMs) || Date.now(),
      mode: "fast",
      fast: signal,
    }));
  } catch (err) {
    logger?.warn?.(`qualify-fast: จดสถานะไม่สำเร็จ (${err?.message || err})`);
  }
  return true;
}

/** ห้องเหลืองมีข้อความใหม่แต่ไม่เข้าข่ายเปิดทันที — ค่าใหม่ทุกข้อความ (ตัวกวาดลบเฉพาะค่าที่ตัวเองอ่าน) */
export function markQualifyRecheck({ db, customerId, messageId = "", nowMs = Date.now(), logger = console }) {
  try {
    db.setSetting(qualifyRecheckKey(customerId), `${Number(nowMs) || Date.now()}:${String(messageId || "")}`);
    return true;
  } catch (err) {
    logger?.warn?.(`qualify-fast: ปักกุญแจตรวจซ้ำไม่สำเร็จ (${err?.message || err})`);
    return false;
  }
}

/* ---------- ข้อความที่ลูกค้าพิมพ์ระหว่างห้องเหลือง (รีวิวปรปักษ์ 5 ต.ค. #9) ----------
 * ประวัติที่โมเดลเห็นตัดแถวลูกค้าท้ายห้องทิ้งหมด (historyBeforeCurrentInbound) — ห้องเหลืองที่เปิดเขียว
 * (ทางลัดในไปป์ไลน์ · ตัวกวาด · คนกดเปิด) เคยตอบข้อความล่าสุดข้อความเดียว ทั้งที่ลูกค้าเพิ่งบอก
 * "ได้งานใหม่แล้ว บริษัทอยากส่งพนักงาน 5 คน" ระหว่างเหลือง — โมเดลจึงตอบราคาคนเดียวให้คนที่มันยังคิดว่าตกงาน
 * ชุดนี้ = ข้อความ (text) ของลูกค้าหลังคำตอบล่าสุดของฝั่งเรา · ตั้งแต่เวลาที่ปิดเหลือง · ไม่เกิน 10 · ห้องสนทนาปัจจุบัน
 * (แบบเดียวกับ pauseHeld.scanPauseHeld) แล้วตัดข้อความของเทิร์นปัจจุบันออกจากท้าย ไม่ให้โมเดลเห็นซ้ำ
 */
export const YELLOW_HELD_MAX_PARTS = 10;
export const YELLOW_HELD_AUDIT_ACTION = "not_qualified_held_merged";
const YELLOW_HELD_SCAN_ROWS = 40;

/** เวลาที่ห้องถูกปิดเหลือง (ms): จากคำตัดสินล่าสุด หรือ audit ปิดเหลืองล่าสุด · ไม่รู้ = 0 (ไม่จำกัดขอบล่าง) */
export function yellowOffAtFor(db, customerId) {
  const fromState = Number(readJsonSetting(db, qualifyStateKey(customerId))?.offAt) || 0;
  if (fromState > 0) return fromState;
  try {
    const row = db.raw.prepare(
      "SELECT MAX(created_at) AS at FROM admin_audit WHERE target = ? AND action = ?",
    ).get(String(customerId), AUDIT_AI_OFF_NOT_QUALIFIED);
    return Number(row?.at) || 0;
  } catch {
    return 0;
  }
}

// ข้อความใน DB อาจมีป้ายนำหน้า เช่น "[เสียงถอดความ] ..." ที่ก้อนของเทิร์นไม่มี — เทียบแบบไม่นับป้ายและช่องว่าง
const normalizePart = (value) => String(value ?? "").replace(/^\[[^\]]{1,40}\]\s*/u, "").replace(/\s+/gu, " ").trim();

function dropCurrentTurn(rows, incoming, currentId) {
  const head = (Array.isArray(incoming) ? incoming : []).map(normalizePart).filter(Boolean);
  for (let size = Math.min(rows.length, head.length); size > 0; size -= 1) {
    const tail = rows.slice(-size).map((row) => normalizePart(row.content));
    if (tail.every((text, index) => text === head[head.length - size + index])) return rows.slice(0, rows.length - size);
  }
  // เทียบไม่ติด (ข้อความถูกแทนด้วยประโยค seed ฯลฯ) = ตัดแถวของเทิร์นนี้ด้วยรหัส
  return currentId ? rows.filter((row) => String(row.id) !== String(currentId)) : rows;
}

/**
 * ข้อความค้างระหว่างเหลือง เรียงเก่า → ใหม่ (ว่าง = ไม่มี) · อ่านพังทุกกรณี = ว่าง (ห้ามทำให้เส้นตอบล้ม)
 * @param {{offAt?: number, incoming?: string[], currentId?: string, logger?: object}} options
 *   incoming = ข้อความของเทิร์นปัจจุบัน (ตัดออกจากท้าย) · currentId = รหัสแถวขาเข้าของเทิร์นนี้ (สำรองเมื่อเทียบข้อความไม่ติด)
 */
export function collectYellowHeldParts(db, customerId, { offAt = 0, incoming = [], currentId = "", logger = console } = {}) {
  try {
    const id = String(customerId);
    const session = db.activeConversationSession?.(id)?.id;
    const scope = session ? "session_id = ?" : "session_id IS NULL";
    const rows = db.raw.prepare(
      `SELECT id, direction, msg_type, content, created_at FROM messages
        WHERE customer_id = ? AND ${scope} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(id, ...(session ? [String(session)] : []), YELLOW_HELD_SCAN_ROWS);
    const since = Number(offAt) || 0;
    const trailing = [];
    for (const row of rows) {
      if (row.direction === "out") break; // คำตอบล่าสุดของฝั่งเรา (AI หรือคน) = ข้อความก่อนหน้านั้นได้คำตอบแล้ว
      if (Number(row.created_at) < since) break; // ก่อนปิดเหลือง = ไม่ใช่ข้อความที่ถูกกลืนเพราะเหลือง
      trailing.unshift(row);
    }
    const textRows = trailing.filter((row) => row.msg_type === "text" && normalizePart(row.content));
    return dropCurrentTurn(textRows, incoming, currentId)
      .map((row) => String(row.content ?? "").trim())
      .slice(-YELLOW_HELD_MAX_PARTS);
  } catch (err) {
    logger?.warn?.(`qualify-fast: อ่านข้อความค้างระหว่างเหลืองไม่สำเร็จ (${err?.message || err}) — ตอบข้อความล่าสุดอย่างเดียว`);
    return [];
  }
}

/** audit การรวมข้อความค้าง (นับอย่างเดียว ไม่มีเนื้อความ) — พังห้ามหยุดการตอบลูกค้า */
export function auditYellowHeldMerged(db, customerId, count, via, logger = console) {
  if (!(count > 0)) return;
  try {
    db.addAudit({
      operator: "system", action: YELLOW_HELD_AUDIT_ACTION, target: String(customerId),
      detail: `ห้องเหลืองเปิดเขียว (${via}) — ข้อความที่ลูกค้าพิมพ์ระหว่างเหลือง ${count} ข้อความ → รวมเข้าเทิร์นตอบ`,
    });
  } catch (err) {
    logger?.warn?.(`qualify-fast: audit ข้อความค้างไม่สำเร็จ (${err?.message || err})`);
  }
}

/* ---------- ตัวกวาดเปิดเขียวแต่ไม่ได้ตอบข้อความค้าง (รีวิวปรปักษ์รอบ 2 5 ต.ค. — รอยต่อกับ qualifySweep.applyGreen) ----------
 * ตัวกวาดเปิดเขียวแล้วข้าม answerPending (เช่นข้อความค้างเก่าเกินไป) จะจด `answerSkipped: true` (+ offAt ของรอบเหลือง)
 * ในสถานะ qualify:<id> · เดิมเทิร์นถัดไปของลูกค้าเห็นห้องเป็นเขียวแล้ว จึงไม่รวมข้อความที่พิมพ์ระหว่างเหลือง
 * (historyBeforeCurrentInbound ตัดแถวลูกค้าท้ายห้องทิ้ง) — เหตุที่ห้องเปิดเขียว ("มีร้านกาแฟสองสาขา") ไม่มีใครตอบเลย
 * เทิร์นแรกของห้องเขียวที่มีธงนี้ = รวมข้อความค้างแบบเดียวกับทางลัด แล้วลบธง (ครั้งเดียว ไม่สแกนทุกเทิร์นตลอดไป)
 */
export const QUALIFY_ANSWER_SKIPPED_FIELD = "answerSkipped";

function clearAnswerSkipped(db, customerId, state, logger) {
  try {
    const { [QUALIFY_ANSWER_SKIPPED_FIELD]: _skipped, ...rest } = state;
    db.setSetting(qualifyStateKey(customerId), JSON.stringify(rest));
  } catch (err) {
    logger?.warn?.(`qualify-fast: ลบธงข้อความค้างหลังเปิดเขียวไม่สำเร็จ (${err?.message || err})`);
  }
}

function heldAfterSkippedGreen({ db, customerId, customer, messageId, incoming, logger }) {
  // เฉพาะห้องที่ AI เปิดอยู่จริง — ห้องที่ปิดด้วยเหตุอื่นภายหลังไม่ได้ตอบเทิร์นนี้ ธงต้องรอเทิร์นที่ตอบจริง
  if (Number(customer?.ai_enabled) !== 1) return { yellow: false };
  const state = readJsonSetting(db, qualifyStateKey(customerId));
  if (!state?.[QUALIFY_ANSWER_SKIPPED_FIELD]) return { yellow: false };
  const offAt = yellowOffAtFor(db, customerId);
  const heldParts = collectYellowHeldParts(db, customerId, { offAt, incoming, currentId: messageId, logger });
  clearAnswerSkipped(db, customerId, state, logger);
  auditYellowHeldMerged(db, customerId, heldParts.length, "sweep:answer_skipped", logger);
  // reclaimed = "เทิร์นนี้คือเทิร์นแรกที่ได้ตอบหลังห้องออกจากเหลือง" (ไปป์ไลน์ใช้ช่องนี้ตัดสินว่าจะรวม heldParts)
  return heldParts.length
    ? { yellow: false, reclaimed: true, signal: "answer_skipped", heldParts }
    : { yellow: false };
}

/**
 * ทั้งหมดของจุดเดียวในไปป์ไลน์ (ก่อนประตู AI) — ห้องไม่เหลือง = อ่านแค่สถานะ qualify:<id> ของห้องที่ AI เปิด
 * (ธง answerSkipped ด้านบน) ห้อง AI ปิดด้วยเหตุอื่นไม่อ่านอะไรเพิ่ม
 * @param {{incoming?: string[]}} args incoming = ข้อความของเทิร์นนี้ (ใช้ตัดออกจากชุดค้าง)
 * @returns {{yellow: false, reclaimed?: boolean, signal?: string, heldParts?: string[]} | {yellow: true, reclaimed: boolean, signal: string, heldParts: string[]}}
 *   heldParts = ข้อความค้างระหว่างเหลืองที่ต้องนำหน้าเทิร์นนี้ (เมื่อเปิดเขียวสำเร็จ หรือเทิร์นแรกหลังตัวกวาดข้ามการตอบ)
 */
export function handleNotQualifiedTurn({ db, customerId, customer = null, signalInput = {}, messageId = "", incoming = [], nowMs = Date.now(), logger = console }) {
  if (!isNotQualifiedRow(customer)) return heldAfterSkippedGreen({ db, customerId, customer, messageId, incoming, logger });
  const signal = fastReclaimSignal(signalInput);
  // รีวิว 12 ต.ค. (ตีจบแชทนอกเรื่อง): ห้องที่ลูกแพรเพิ่งตีจบ — ไม่เปิดเขียวทันที ให้ตัวกวาดอ่านทั้งห้องตัดสินแทนภายในไม่กี่นาที เมื่อ
  //   · ข้อความยังมีคำนอกเรื่องอยู่ในตัว (ผ่านด่านผู้ซื้อแล้ว = ไม่ใช่คำถามราคาถึงเรา) — ทุกหมวด: "สนใจแต่ไม่มีเงินค่ะ" หลังตีจบเพราะไม่มีงบ
  //     เคยเปิดเขียวแล้วได้คำลาซ้ำอีกรอบ (รีวิวรอบ 3)
  //   · สัญญาณอ่อน (สนใจ/ถามคลาส) ของหมวดที่ "สนใจไหม/พร้อมลงทุน" เป็นคำเสนอขายของเขาเอง หรือเป็นห้องที่ไม่มีวันเป็นผู้ซื้อ
  //     (OFFTOPIC_HOLD_CATEGORIES) — ห้องไม่มีงบ/พระ/หางาน/ขอเงินที่กลับมาว่า "ตอนนี้มีงบแล้ว สนใจคลาส" (ไม่มีคำนอกเรื่อง) เปิดทันที
  // ความปลอดภัย/ทวงคำตอบ/สัญญาณแรงล้วน ๆ เปิดทันทีตามเดิม
  const offtopicClosed = signal && !SAFETY_SIGNALS.has(signal) && !ATTENTION_SIGNALS.has(signal) ? offtopicClosedCategory(db, customerId) : "";
  if (offtopicClosed && (offtopicCueIn(signalInput, logger)
    || (OFFTOPIC_SOFT_SIGNALS.has(signal) && OFFTOPIC_HOLD_CATEGORIES.includes(offtopicClosed)))) {
    markQualifyRecheck({ db, customerId, messageId, nowMs, logger });
    return { yellow: true, reclaimed: false, signal, heldParts: [], offtopicHeld: true };
  }
  // อ่าน "ก่อน" เปิดเขียว: reclaimNotQualified เขียนสถานะใหม่ทับคำตัดสินที่มี offAt
  const offAt = signal ? yellowOffAtFor(db, customerId) : 0;
  if (signal && reclaimNotQualified({ db, customerId, signal, lastInboundId: messageId, nowMs, logger })) {
    const heldParts = collectYellowHeldParts(db, customerId, { offAt, incoming, currentId: messageId, logger });
    auditYellowHeldMerged(db, customerId, heldParts.length, `fast:${signal}`, logger);
    return { yellow: true, reclaimed: true, signal, heldParts };
  }
  markQualifyRecheck({ db, customerId, messageId, nowMs, logger });
  return { yellow: true, reclaimed: false, signal, heldParts: [] };
}
