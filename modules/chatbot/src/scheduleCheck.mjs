// scheduleCheck.mjs — ลูกค้า "ขอเช็คคิวก่อน / ขอเช็ควันก่อน" (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//
// "ควรทำยังไงดี ให้ลูกค้าไม่รู้สึกรำคาญ และเหมือนเราจี้ไปตลอด เพราะถ้าเป็นปกติ FU message จะทำงานอยู่ดี"
//
// ของจริง ก.ย. (อ่านอย่างเดียว): ลูกค้าที่บอกว่าขอไปเช็คคิว/ตารางก่อน โดนบันไดปกติทักภายใน 1–15 ชม.
// ในเกือบทุกห้อง (hot ของ FB ทักใน ~1 ชม.; cold ของ FB ที่เงียบตอน 21:00 โดนสามไม้ติดในเช้าเดียว)
// ไฟล์นี้ถือสามอย่าง: ตัวจับเจตนา · หมุดของห้อง (followup_state.defer_json) · บรรทัดสั่งงานเทิร์นตอบ
// ส่วนเวลาทักหนึ่งครั้ง/ข้อความทักอยู่ที่ scheduleCheckIn.mjs · สวิตช์ settings.schedule_check_followup
//
// เจตนาที่ "ไม่ใช่" เรื่องนี้: "ขอคิดก่อน" ทั่วไป = หยุดติดตามเต็มรูปแบบ (followupSuppression.mjs) ไม่ใช่ทักหนึ่งครั้ง
// ข้อความที่มีทั้งสองอย่าง ("ขอเช็คตารางกับปรึกษาแฟนก่อน") → หยุดติดตามชนะ เพราะห้องถูกคัดออกจาก candidate
import { activeBrand, isGenericProfile } from "./brand.mjs";
import { replyDateHint } from "./followupTiming.mjs";
import { openRounds, roundWeekdayThai } from "./openRounds.mjs";

export const SCHEDULE_CHECK_FOLLOWUP_KEY = "schedule_check_followup";
export const SCHEDULE_CHECK_KIND = "schedule_check";
// ลูกค้ามักพิมพ์ต่อเป็นก้อน ("ขอเช็คคิวก่อน" + "มีรอบไหนบ้าง") — ข้อความในไม่กี่นาทีถัดมาเป็นก้อนเดียวกัน
const SAME_BURST_MS = 3 * 60_000;

/** ไม่มีแถว = on (คำสั่งเจ้าของ) · off = พฤติกรรมเดิมทุกอย่าง · อ่านพัง = off */
export function scheduleCheckFollowupMode(db) {
  // White-label: โปรไฟล์ generic ปิดฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วงเสมอ (ค่าใน DB ไม่มีผล)
  if (isGenericProfile(activeBrand())) return "off";
  try {
    const raw = String(db?.getSetting?.(SCHEDULE_CHECK_FOLLOWUP_KEY) ?? "").trim().toLowerCase();
    return raw === "off" ? "off" : "on";
  } catch {
    return "off";
  }
}

export function scheduleCheckFollowupEnabled(db) {
  return scheduleCheckFollowupMode(db) === "on";
}

/* ------------------------------ ตัวจับเจตนา ------------------------------ */

const compactOf = (text) => String(text ?? "").toLowerCase()
  .replace(/[​-‍﻿]/gu, "").replace(/[\s\p{P}^]+/gu, "");

// คำกริยา "ตรวจตาราง" — ดู แยกไว้ต่างหากเพราะ "ขอดูตาราง" เฉย ๆ คือขอให้เราส่งตาราง ไม่ใช่ขอไปดูเอง
const CHECK_VERB = "(?:เช็?[คก]|เชค|วาง|เคลียร์|จัด)";
const LOOK_VERB = "ดู";
// ของที่เป็น "ตารางของลูกค้าเอง" + ต้องตามด้วยคำปิดท้าย/คำต่อที่เป็นเรื่องเวลา (กัน "เช็ควันหมดอายุ")
const OWN_SCHEDULE = "(?:คิว(?:งาน|ว่าง|ตัวเอง)?|ตาราง(?:งาน|เวลา|ตัวเอง|เรียน|ชีวิต)?|วัน(?:ว่าง|เวลา)?|เวลา(?:ว่าง)?|ปฏิทิน|calendar|schedule)"
  + "(?=ว่าง|เวลา|ก่อน|นิด|แป|แล้ว|อีก|ช่วง|กับ|ว่า|ที่สะดวก|ไหน|ครับ|คับ|ค่ะ|คะ|ค่า|นะ|จ้า|ด้วย|$)";
const DEFER_TAIL = "(?:ก่อน|อีกที|อีกครั้ง|แป[๊ป]?[บป]|นิดนึง|สักครู่|สักพัก|แล้ว(?:จะ)?(?:มา)?(?:แจ้ง|บอก|ตอบ|ทัก|ติดต่อ|คอนเฟิร์ม|ยืนยัน))";
const LOOK_TAIL = "(?:ก่อน|แป[๊ป]?[บป]|นิดนึง|สักครู่|แล้ว(?:จะ)?(?:มา)?(?:แจ้ง|บอก|ตอบ|ทัก|ติดต่อ|คอนเฟิร์ม|ยืนยัน))";
const PARTY = "(?:ทีม|ที่ออฟฟิศ|ออฟฟิศ|ที่ทำงาน|บริษัท|หัวหน้า|เจ้านาย|แฟน|ครอบครัว|ที่บ้าน|ผู้เข้าอบรม|ลูกทีม|น้องๆ?|เลขา|hr|หุ้นส่วน|พาร์ทเนอร์)";
const FUTURE_LEAD = "(?:เดี๋ยว|เด๋ว|เด่ว|เดียว|เดะ|ต้อง|ไว้)";
const PRONOUN = "(?:ผม|ดิฉัน|ฉัน|หนู|พี่|เรา|น้อง)";

const CHECK_THEN_DEFER = new RegExp(`${CHECK_VERB}(?:ให้)?(?:กับ.{1,15}?)?${OWN_SCHEDULE}.{0,30}?${DEFER_TAIL}`, "u");
const LOOK_THEN_DEFER = new RegExp(`${LOOK_VERB}(?:ให้)?${OWN_SCHEDULE}.{0,30}?${LOOK_TAIL}`, "u");
const CHECK_WITH_PARTY = new RegExp(`${CHECK_VERB}กับ${PARTY}.{0,12}?(?:ก่อน|อีกที).{0,24}?(?:ว่าง|สะดวก|วัน|คิว|ตาราง|เวลา)`, "u");
const LEAD_START = new RegExp(`^${FUTURE_LEAD}${PRONOUN}?(?:ขอ)?(?:ลอง)?(?:${CHECK_VERB}|${LOOK_VERB})(?:ให้)?(?:กับ.{1,15}?)?${OWN_SCHEDULE}`, "u");
const LEADING_FILLER = new RegExp(`^(?:ครับ|คับ|ค่ะ|คะ|ค่า|โอเค|ok|ได้(?:ครับ|คับ|ค่ะ|คะ)?|ถ้างั้น|งั้น|อ่อ|อ๋อ|อ้อ|เออ|ขอบคุณ(?:ครับ|ค่ะ|คะ)?|${PRONOUN})+`, "u");
const ENGLISH = /\b(?:let me|i(?:'ll| will| need to| have to| must| gotta)?|need to|have to|gotta)\s+(?:double[- ]?)?check\s+(?:with\s+)?(?:(?:my|our|the)\s+)?(?:team'?s?\s+|office'?s?\s+|boss'?s?\s+)?(?:schedule|calendar|availability|diary)/iu;

// ขอให้ "เรา" เป็นคนเช็ค/ส่งตาราง = คำขอ ไม่ใช่การขอเวลาไปเช็คเอง
const REQUEST_TO_US = /(?:ช่วย|รบกวน|ขอให้|อยากให้|ฝาก)[^\n]{0,8}(?:เช็?[คก]|เชค|ดู|หา|ส่ง|จัด)|(?:เช็?[คก]|เชค|ดู)[^\n]{0,20}ให้(?:หน่อย|ด้วย|ที)|ของ(?:พี่ง้วง|ทาง|คุณ|แอดมิน|ลูกแพร)/u;
const NEGATED = /ไม่ต้อง(?:[^\n]{0,4})(?:เช็?[คก]|เชค|ดู)|ไม่(?:ได้)?(?:เช็?[คก]|เชค)/u;
const QUOTED_OR_EXAMPLE = /["“”‘’]|ตัวอย่าง|เช่น|ลูกค้าพูดว่า|ลูกค้าบอกว่า|เขาบอกว่า|เขียนข้อความ/u;

/** ลูกค้าขอไปเช็คคิว/วัน/ตารางของตัวเองก่อนไหม — { kind } หรือ null (ไม่แน่ใจ = null) */
export function classifyScheduleCheck(text) {
  const raw = String(text ?? "").trim();
  if (!raw || QUOTED_OR_EXAMPLE.test(raw)) return null;
  const compact = compactOf(raw);
  if (!compact || REQUEST_TO_US.test(compact) || NEGATED.test(compact)) return null;
  const lead = compact.replace(LEADING_FILLER, "");
  const hit = CHECK_THEN_DEFER.test(compact) || LOOK_THEN_DEFER.test(compact)
    || CHECK_WITH_PARTY.test(compact) || LEAD_START.test(lead) || ENGLISH.test(raw);
  return hit ? { kind: SCHEDULE_CHECK_KIND } : null;
}

// ตอบรับสั้น ๆ ที่ไม่มีเรื่องใหม่ — หลังขอเช็คคิวแล้วพิมพ์ "ขอบคุณค่ะ" ต้องไม่ทำให้บันไดปกติกลับมาทัก
const ACK = /^(?:ค่ะ|ค่า|คะ|ครับ|คับ|ครัช|จ้า|จ้ะ|จ่ะ|นะ|น้า|โอเค|โอเช|ok(?:ay)?|ได้(?:เลย)?|รับทราบ|เข้าใจแล้ว|ขอบคุณ(?:มาก)?|ขอบใจ|thank(?:s|you)?|thx|ty|you|👍|🙏|😊|🙂|😄|😁|❤️|❤|♥️|💕|✨|🥰|😍|🤍|💯|🙇‍♀️|🙇|55+|ๆ|\u{fe0f})+$/u;

export function isAckOnly(text) {
  const raw = String(text ?? "").trim();
  if (!raw || /[?？]/u.test(raw) || [...raw].length > 40) return false;
  const compact = compactOf(raw);
  return Boolean(compact) && ACK.test(compact);
}

/* ---------------------- หมุดของห้อง (followup_state.defer_json) ---------------------- */

/** หมุดที่อ่านได้ หรือ null — { kind, at, hint (YYYY-MM-DD|null), sentAt? } */
export function parseScheduleMarker(json) {
  if (!json) return null;
  try {
    const value = typeof json === "string" ? JSON.parse(json) : json;
    if (value?.kind !== SCHEDULE_CHECK_KIND || !Number.isFinite(Number(value.at))) return null;
    const hint = /^\d{4}-\d{2}-\d{2}$/u.test(String(value.hint ?? "")) ? value.hint : null;
    const sentAt = Number.isFinite(Number(value.sentAt)) && Number(value.sentAt) > 0 ? Number(value.sentAt) : null;
    return { kind: SCHEDULE_CHECK_KIND, at: Number(value.at), hint, ...(sentAt ? { sentAt } : {}) };
  } catch {
    return null;
  }
}

/**
 * หมุดถัดไปเมื่อลูกค้าพิมพ์ข้อความนี้ — object = ตั้งใหม่ · null = ล้าง · undefined = ไม่แตะ
 *   ขอเช็คคิว → ตั้ง (พร้อมวันที่ลูกค้าบอกว่าจะแจ้งกลับ ถ้ามี)
 *   ทักไปแล้วหนึ่งครั้ง แล้วลูกค้าพิมพ์อะไรก็ตาม → ล้าง (กลับสู่การคุยปกติ)
 *   ตอบรับสั้น ๆ / พิมพ์ต่อในก้อนเดียวกัน → คงไว้ · เรื่องใหม่ → ล้าง
 */
export function nextScheduleCheckMarker({ markerJson = "", text = "", atMs }) {
  if (classifyScheduleCheck(text)) {
    return { kind: SCHEDULE_CHECK_KIND, at: Number(atMs), hint: replyDateHint(text, atMs) };
  }
  const marker = parseScheduleMarker(markerJson);
  if (!marker) return undefined;
  if (marker.sentAt) return null;
  if (isAckOnly(text) || Number(atMs) - marker.at <= SAME_BURST_MS) return undefined;
  return null;
}

/* ---------------------------- บรรทัดสั่งงานเทิร์นตอบ ---------------------------- */

function roundLines(rounds) {
  const open = openRounds(rounds);
  if (!open.length) {
    return ["  · ตอนนี้ระบบไม่มีรายการรอบล่าสุด — ห้ามเดาวันที่เอง ให้ชวนพิมพ์วันที่สะดวกมาในแชทได้เลย"];
  }
  return [
    "  รอบที่เปิดรับตอนนี้ (ตัดรอบที่ผ่านไปแล้ว เต็มแล้ว และปิดรับออกแล้ว — ใช้รายการนี้เท่านั้น):",
    ...open.map((round) => `  · ${roundWeekdayThai(round)} ${round.thai || round.date} — ${round.label || round.product || "คลาส"}`),
  ];
}

/**
 * บรรทัดสั่งงานของเทิร์นที่ลูกค้าขอเช็คคิวก่อน — "" = พรอมต์เดิมทุกไบต์ (สวิตช์ปิด/ไม่ใช่เทิร์นนี้)
 * คำถามปิดท้ายถูกปิดอีกชั้นที่ replyClosingQuestion.customerIsClosing (ตัวจับเดียวกัน)
 */
export function scheduleCheckReplyDirective({ enabled = false, text = "", rounds = [] } = {}) {
  if (enabled !== true || !classifyScheduleCheck(text)) return "";
  // rounds รับเป็นฟังก์ชันได้ — ไปป์ไลน์อ่านรอบ (ไฟล์/settings) เฉพาะเทิร์นที่จับได้จริง ไม่ใช่ทุกข้อความ
  const list = typeof rounds === "function" ? rounds() : rounds;
  return [
    "- เทิร์นนี้ลูกค้าบอกว่าขอเช็คคิว/วัน/ตารางของตัวเองก่อน (คำสั่งพี่ง้วง: ต้องไม่รู้สึกว่าถูกจี้) — กติกาเทิร์นนี้ชนะกติกาชวนปิดการขายด้านบน:",
    "  · ถ้าลูกค้าถามอะไรมาในข้อความนี้ ให้ตอบให้ครบก่อน",
    "  · แล้วตอบรับสั้น ๆ อย่างอบอุ่น และให้สิ่งที่เขาต้องใช้เช็คคิว: รอบที่เปิดรับ 2-3 รอบที่ใกล้ที่สุดของคลาสที่คุยกันอยู่ "
      + "(วัน วันที่ และชื่อคลาส) — ห้ามใช้วันที่จากคลังความรู้หรือจากประวัติแชท",
    "  · บอกว่า \"ไม่ต้องรีบนะคะ\" และสะดวกวันไหนพิมพ์วันที่มาในแชทนี้ได้เลย",
    // ไม่มีคำเรื่องเงินในบรรทัดนี้โดยเจตนา — จังหวะราคาเป็นของ priceDisclosure.mjs ที่เดียว (ลูกค้าถามราคา = ตอบตามแม่แบบเดิม)
    "  · จบด้วยประโยคบอกเล่า ห้ามปิดท้ายด้วยคำถาม ห้ามชวนจอง ยืนยัน หรือโอน และห้ามเร่งให้ตัดสินใจ",
    "  · ห้ามพูดว่าที่นั่งใกล้เต็ม เหลือน้อย หรือต้องรีบ ห้ามบอกจำนวนที่นั่งเหลือเว้นแต่ลูกค้าถาม "
      + "และห้ามบอกหรือบอกเป็นนัยว่าจองหรือกันที่นั่งไว้ให้",
    ...roundLines(list),
  ].join("\n");
}
