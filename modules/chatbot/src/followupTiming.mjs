// followupTiming.mjs — นาฬิกาเวลาไทย · ช่องเวลากลางวัน · วันที่ที่ลูกค้าเอ่ย (28 ก.ย. 2026)
//
// ใช้ร่วมกันสองงานที่พี่ง้วงสั่งเช้า 28 ก.ย.:
//   1. ทักเบา ๆ หนึ่งครั้งหลังส่งเลขบัญชี ("ขอแบบละมุนที่สุดครับ")          → paymentGentleNudge.mjs
//   2. ลูกค้า "ขอเช็คคิวก่อน" = ทักหนึ่งครั้งแทนบันไดปกติ (LINE/FB ต่างกัน) → scheduleCheck*.mjs
//
// ทุกฟังก์ชันเป็น pure: รับเวลาเข้ามา ไม่อ่านนาฬิกาเอง — badge บนคอนโซลกับเวลาที่ยิงจริงต้องตรงกัน
// และเทสต์ต้องคุมผลได้ (หลักเดียวกับ stepJitterMs ใน stagedFollowups.mjs)
import { createHash } from "node:crypto";
import { bangkokDayStartMs } from "./bangkokTime.mjs";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
const BANGKOK_OFFSET_MS = 7 * HOUR_MS;

// ช่องที่ "วางแผน" ให้ทักได้: 09:00–20:30 — ช่วงเงียบจริงเริ่ม 21:00 (followupEngine.inQuietHours)
// เว้นไว้ 30 นาทีให้รอบ tick/การส่งจบก่อนเข้าช่วงเงียบเสมอ
export const PLAN_DAY_START_MIN = 9 * 60;
export const PLAN_DAY_END_MIN = 20 * 60 + 30;
// "สาย ๆ" ของ LINE: 10:00–11:30 — พ้นช่วงเช้าที่คนกำลังเริ่มงาน และยังไม่ใช่เวลาพักเที่ยง
export const LATE_MORNING_START_MIN = 10 * 60;
export const LATE_MORNING_END_MIN = 11 * 60 + 30;

export const bangkokDayStart = (tsMs) => bangkokDayStartMs(Number(tsMs));
export const bangkokIsoDate = (tsMs) => new Date(Number(tsMs) + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
export function isoDayStart(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return Date.UTC(year, month - 1, day) - BANGKOK_OFFSET_MS;
}
const atMinute = (dayStartMs, minuteOfDay) => dayStartMs + minuteOfDay * MINUTE_MS;

// ค่าเดิมทุกครั้งสำหรับอินพุตเดิม (แทน Math.random) — ใช้กระจายเวลาไม่ให้ทุกห้องตรงกันเป๊ะ
export function hashUnit(...parts) {
  return createHash("sha256").update(parts.map(String).join("|")).digest().readUInt32BE(0) / 2 ** 32;
}

/** ช่วงกลางวัน (09:00–20:30 เวลาไทย) ที่ตัดกับ [fromMs, toMs) — คืนรายการ [เริ่ม, จบ] */
export function daytimeIntervals(fromMs, toMs, { startMin = PLAN_DAY_START_MIN, endMin = PLAN_DAY_END_MIN } = {}) {
  const out = [];
  if (!(Number(toMs) > Number(fromMs))) return out;
  for (let day = bangkokDayStart(fromMs); day < toMs; day += DAY_MS) {
    const start = Math.max(fromMs, atMinute(day, startMin));
    const end = Math.min(toMs, atMinute(day, endMin));
    if (end > start) out.push([start, end]);
  }
  return out;
}

/** จุดเดียวในชุดช่วงเวลา กระจายตามความยาว (unit ∈ [0,1)) ปัดลงเป็นนาทีเต็ม — ไม่มีช่วง = null */
export function pickInIntervals(intervals, unit) {
  const spans = (Array.isArray(intervals) ? intervals : []).filter(([a, b]) => b > a);
  const total = spans.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (!(total > 0)) return null;
  let offset = Math.min(total - 1, Math.max(0, Math.floor(Number(unit) * total)));
  for (const [a, b] of spans) {
    if (offset < b - a) return Math.max(a, a + Math.floor(offset / MINUTE_MS) * MINUTE_MS);
    offset -= b - a;
  }
  return spans.at(-1)[0];
}

/**
 * ช่องสาย ๆ (10:00–11:30) วันแรกที่ยังทันหลัง earliestMs — notBeforeMs = เริ่มหาจากวันนั้น
 * (เช่น "วันถัดจากวันที่ลูกค้าบอกว่าจะโอน") หาไม่เจอในสามวัน = null
 */
export function lateMorningDue({ earliestMs, notBeforeMs = null, unit = 0 }) {
  const from = Math.max(Number(earliestMs), Number(notBeforeMs ?? earliestMs));
  let day = bangkokDayStart(from);
  for (let i = 0; i < 3; i += 1, day += DAY_MS) {
    const start = Math.max(Number(earliestMs), atMinute(day, LATE_MORNING_START_MIN));
    const end = atMinute(day, LATE_MORNING_END_MIN);
    if (end > start) return pickInIntervals([[start, end]], unit);
  }
  return null;
}

/* ------------------------ วันที่ที่ลูกค้าเอ่ยในแชท ------------------------ */
// รับเฉพาะรูปที่เจอบ่อยและตีความได้ทางเดียว — รูปกำกวม (เช่น 5/10) ไม่ถูกแปลเลย
// ผลผิดทางที่ยอมรับได้คือ "ไม่รู้วัน" (ใช้เวลาตั้งต้น) ไม่ใช่ "เดาวันผิดแล้วทักผิดจังหวะ"

const WEEKDAYS = [
  [/(?:จันทร์|monday)/iu, 1], [/(?:อังคาร|tuesday)/iu, 2], [/(?:พุธ|wednesday)/iu, 3],
  [/(?:พฤหัส(?:บดี)?|thursday)/iu, 4], [/(?:ศุกร์|friday)/iu, 5], [/(?:เสาร์|saturday)/iu, 6],
  [/(?:อาทิตย์|sunday)/iu, 0],
];
const MONTHS = [
  "ม\\.?\\s?ค\\.?|มกรา(?:คม)?|jan(?:uary)?", "ก\\.?\\s?พ\\.?|กุมภา(?:พันธ์)?|feb(?:ruary)?",
  "มี\\.?\\s?ค\\.?|มีนา(?:คม)?|mar(?:ch)?", "เม\\.?\\s?ย\\.?|เมษา(?:ยน)?|apr(?:il)?",
  "พ\\.?\\s?ค\\.?|พฤษภา(?:คม)?|may", "มิ\\.?\\s?ย\\.?|มิถุนา(?:ยน)?|jun(?:e)?",
  "ก\\.?\\s?ค\\.?|กรก[ฎฏ]า(?:คม)?|jul(?:y)?", "ส\\.?\\s?ค\\.?|สิงหา(?:คม)?|aug(?:ust)?",
  "ก\\.?\\s?ย\\.?|กันยา(?:ยน)?|sep(?:t(?:ember)?)?", "ต\\.?\\s?ค\\.?|ตุลา(?:คม)?|oct(?:ober)?",
  "พ\\.?\\s?ย\\.?|พฤศจิกา(?:ยน)?|nov(?:ember)?", "ธ\\.?\\s?ค\\.?|ธันวา(?:คม)?|dec(?:ember)?",
];
const DAY_MONTH = new RegExp(`(?<![\\d.])([0-3]?\\d)\\s*(${MONTHS.map((m) => `(?:${m})`).join("|")})(?![a-z])`, "giu");

function ctxOf(refMs) {
  const date = new Date(Number(refMs) + BANGKOK_OFFSET_MS);
  return {
    dayStart: bangkokDayStart(refMs),
    weekday: date.getUTCDay(),
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    dom: date.getUTCDate(),
  };
}
const plusDays = (ctx, days) => bangkokIsoDate(ctx.dayStart + days * DAY_MS + HOUR_MS);
const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const isoOf = (year, month, day) => new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);

function weekdayIso(ctx, target, { next = false, thisOne = false } = {}) {
  if (next) {
    // "วันจันทร์หน้า" = วันนั้นของสัปดาห์หน้า (สัปดาห์เริ่มวันจันทร์)
    const mondayIndex = (ctx.weekday + 6) % 7;
    return plusDays(ctx, 7 - mondayIndex + ((target + 6) % 7));
  }
  const delta = (target - ctx.weekday + 7) % 7;
  return plusDays(ctx, delta === 0 && !thisOne ? 7 : delta);
}

function monthMatchIndex(token) {
  const value = String(token || "").toLowerCase();
  return MONTHS.findIndex((pattern) => new RegExp(`^(?:${pattern})$`, "iu").test(value));
}

/**
 * ข้อความนี้เอ่ยถึงวันที่ ISO นี้ไหม ("10 ต.ค." / "10 ตุลาคม" / "10 oct") — ใช้หาว่า
 * "รอบที่ลูกแพรเพิ่งส่งให้ดู" คือรอบไหน โดยไม่ต้องเดาจากคำว่า "วันที่ 10" เปล่า ๆ
 */
export function mentionsCalendarDate(text, iso) {
  const [, month, day] = String(iso || "").split("-").map(Number);
  if (!(month >= 1 && month <= 12 && day >= 1)) return false;
  const pattern = new RegExp(`(?<![\\d.])0?${day}\\s*(?:${MONTHS[month - 1]})(?![a-z])`, "iu");
  return pattern.test(String(text ?? ""));
}

/** วันที่แบบ "วัน + เดือน" ที่เขียนชัด ("10 ต.ค.") เท่านั้น — ใช้อ่านรอบเรียนจากบล็อกสรุปของลูกแพร */
export function explicitCalendarDates(text, refMs) {
  const value = String(text ?? "");
  if (!value.trim() || !Number.isFinite(Number(refMs))) return [];
  const ctx = ctxOf(refMs);
  const out = new Set();
  for (const match of value.matchAll(DAY_MONTH)) {
    const day = Number(match[1]);
    const month = monthMatchIndex(match[2]);
    if (month < 0 || !(day >= 1 && day <= lastDayOfMonth(ctx.year, month))) continue;
    const thisYear = isoOf(ctx.year, month, day);
    // บล็อกสรุปพูดถึงรอบในอนาคตเสมอ — วันที่เลยมาแล้วเกินสองเดือนคือรอบปีหน้า
    out.add(thisYear >= plusDays(ctx, -60) ? thisYear : isoOf(ctx.year + 1, month, day));
  }
  return [...out].sort();
}

/** ทุกนิพจน์วันที่ในข้อความ — [{ iso, index, length }] เรียงตามตำแหน่ง */
export function resolveDateExpressions(text, refMs) {
  const value = String(text ?? "").replace(/\s*ๆ/gu, "");
  if (!value.trim() || !Number.isFinite(Number(refMs))) return [];
  const ctx = ctxOf(refMs);
  const hits = [];
  const add = (match, iso) => { if (iso) hits.push({ iso, index: match.index, length: match[0].length }); };
  const scan = (pattern, fn) => { for (const match of value.matchAll(pattern)) add(match, fn(match)); };

  scan(/มะรืน(?:นี้)?|day after tomorrow/giu, () => plusDays(ctx, 2));
  scan(/พรุ่ง(?:นี้|นี่)|พรุ้งนี้|tomorrow/giu, (m) => (/day after tomorrow/iu.test(value.slice(Math.max(0, m.index - 10), m.index + 8)) ? null : plusDays(ctx, 1)));
  scan(/วันนี้|(?:เย็น|บ่าย|ค่ำ|คืน|เช้า)นี้|ตอน(?:เย็น|บ่าย|ค่ำ)|(?<![ก-๙])(?:บ่าย|เย็น|ค่ำ)(?![ก-๙])|today|tonight/giu, () => plusDays(ctx, 0));
  scan(/อีก\s*(\d{1,2})\s*วัน|in\s+(\d{1,2})\s+days/giu, (m) => plusDays(ctx, Number(m[1] ?? m[2])));
  scan(/(?:สิ้น|ปลาย)เดือน|end of (?:the )?month/giu, () => isoOf(ctx.year, ctx.month, lastDayOfMonth(ctx.year, ctx.month)));
  scan(/เงินเดือน(?:ออก|เข้า)|pay\s?day|salary/giu, () => isoOf(ctx.year, ctx.month, lastDayOfMonth(ctx.year, ctx.month)));
  scan(/ต้นเดือน(?:หน้า)?/gu, (m) => (/หน้า$/u.test(m[0]) || ctx.dom > 3
    ? isoOf(ctx.year, ctx.month + 1, 5) : isoOf(ctx.year, ctx.month, 5)));
  scan(/เดือนหน้า|next month/giu, (m) => (/ต้น$/u.test(value.slice(Math.max(0, m.index - 3), m.index)) ? null
    : isoOf(ctx.year, ctx.month + 1, 1)));
  scan(/(?<!วัน)(?:สัปดาห์|อาทิตย์|วีค)หน้า|next week/giu, () => plusDays(ctx, 7 - ((ctx.weekday + 6) % 7)));
  scan(/สุดสัปดาห์|เสาร์อาทิตย์|weekend/giu, () => weekdayIso(ctx, 6, { thisOne: true }));
  scan(/วัน\s?(จันทร์|อังคาร|พุธ|พฤหัส(?:บดี)?|ศุกร์|เสาร์|อาทิตย์)\s?(นี้|หน้า)?|(?:(this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/giu, (m) => {
    const name = m[1] ?? m[4];
    const target = WEEKDAYS.find(([pattern]) => pattern.test(name))?.[1];
    if (target === undefined) return null;
    const modifier = String(m[2] ?? m[3] ?? "").toLowerCase();
    return weekdayIso(ctx, target, { next: modifier === "หน้า" || modifier === "next", thisOne: modifier === "นี้" || modifier === "this" });
  });
  scan(/วันที่\s?([0-3]?\d)(?!\s*(?:\/|-|\.|ม\.|ก\.|มี|เม|พ\.|มิ|ส\.|ต\.|ธ\.|[ก-ฮ]\.?\s?[ก-ฮ]\.))/gu, (m) => {
    const day = Number(m[1]);
    if (!(day >= 1 && day <= 31)) return null;
    const month = day >= ctx.dom ? ctx.month : ctx.month + 1;
    const year = ctx.year + Math.floor(month / 12);
    const normalized = month % 12;
    return day <= lastDayOfMonth(year, normalized) ? isoOf(year, normalized, day) : null;
  });
  for (const match of value.matchAll(DAY_MONTH)) {
    const day = Number(match[1]);
    const month = monthMatchIndex(match[2]);
    if (month < 0 || !(day >= 1 && day <= lastDayOfMonth(ctx.year, month))) continue;
    const thisYear = isoOf(ctx.year, month, day);
    add(match, thisYear >= plusDays(ctx, 0) ? thisYear : isoOf(ctx.year + 1, month, day));
  }
  return hits.sort((a, b) => a.index - b.index);
}

const PAY_VERB = /โอน|จ่าย|ชำระ|เคลียร์(?:ยอด|เงิน)|pay(?!\s?day)|transfer|เงินเดือน(?:ออก|เข้า)|pay\s?day|salary/giu;
const REPLY_VERB = /แจ้ง|บอก|ตอบ|ทัก|ยืนยัน|คอนเฟิร์ม|confirm|ติดต่อ|กลับมา|get back|let you know|reply/giu;
// "พรุ่งนี้ไม่ได้" / "ไม่สะดวกพรุ่งนี้" = วันนั้นถูกปฏิเสธ ไม่ใช่วันนัด
const NEGATED_AFTER = /^\s{0,2}(?:ยัง)?ไม่(?:ได้|สะดวก|ทัน|ว่าง)/u;
const NEGATED_BEFORE = /ไม่(?:ได้|สะดวก|ทัน|ว่าง)?\s{0,2}$/u;
const NEAR_CHARS = 24;

function contextualDate(text, refMs, verbPattern) {
  const value = String(text ?? "").replace(/\s*ๆ/gu, "");
  const verbs = [...value.matchAll(verbPattern)].map((m) => [m.index, m.index + m[0].length]);
  if (!verbs.length) return null;
  const dates = resolveDateExpressions(value, refMs).filter((hit) => {
    const end = hit.index + hit.length;
    if (NEGATED_AFTER.test(value.slice(end, end + 12)) || NEGATED_BEFORE.test(value.slice(Math.max(0, hit.index - 10), hit.index))) return false;
    return verbs.some(([a, b]) => (a >= end && a - end <= NEAR_CHARS) || (b <= hit.index && hit.index - b <= NEAR_CHARS)
      || (a <= hit.index && b >= end));
  });
  if (!dates.length) return null;
  // หลายวัน = เอาวันหลังสุด: ทักทีหลังนุ่มกว่าทักก่อนวันที่ลูกค้าให้ไว้
  return dates.map((hit) => hit.iso).sort().at(-1);
}

/** วันที่ลูกค้าบอกว่าจะโอน/จ่าย ("พรุ่งนี้โอน", "สิ้นเดือน", "หลังเงินเดือนออก") — ไม่มี = null */
export function paymentDateHint(text, refMs) {
  return contextualDate(text, refMs, PAY_VERB);
}

/** วันที่ลูกค้าบอกว่าจะแจ้งกลับ ("พรุ่งนี้แจ้ง", "วันศุกร์ตอบได้") — วันเรียนที่เอ่ยถึงไม่นับ */
export function replyDateHint(text, refMs) {
  return contextualDate(text, refMs, REPLY_VERB);
}
