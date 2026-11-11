// openRounds.mjs — "รอบที่เปิดรับตอนนี้" ชุดเดียวกับที่เส้นตอบลูกค้าใช้ (28 ก.ย. 2026)
//
// คลังความรู้ (sync จาก class-rounds.json) โชว์รอบที่ผ่านไปแล้วว่า "เปิดรับสมัคร" ได้ถ้ายังไม่มีคน sync ซ้ำ
// (เจอจริงคืน 28 ก.ย.) — ข้อความทักตามและบรรทัดสั่งงานเทิร์น "ขอเช็คคิวก่อน" จึงต้องอ่านรอบจาก
// ตัวทับเดียวกับ pipeline.currentRoundsRules / yolo.currentSeatRules เท่านั้น (ตัดด้วยวันนี้เวลาไทย)
// ไฟล์นี้ pure (ไม่แตะ DB/สมอง) — ตัวอ่านรอบจากแหล่งจริงอยู่ที่ roundsSource.mjs
import { thaiShortDate } from "./classRounds.mjs";
import { mentionsCalendarDate } from "./followupTiming.mjs";

const CLOSED_STATUSES = new Set(["full", "closed"]);
const THAI_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

/** ยังรับสมัครจริงไหม: สถานะไม่ใช่เต็ม/ปิด และที่นั่งเหลือไม่เป็นศูนย์ (ไม่รู้จำนวน = ยังเปิด) */
export function isOpenRound(round) {
  const status = String(round?.fileStatus ?? round?.status ?? "open");
  return Boolean(round?.date) && !CLOSED_STATUSES.has(status) && round?.seatsLeft !== 0;
}

/** รอบที่เปิดรับ เรียงตามวัน — จำกัดต่อคลาสและรวม (บรรทัดสั่งงานสั้น ไม่ยัดตารางทั้งปี) */
export function openRounds(rounds, { perClass = 3, total = 6 } = {}) {
  const perKey = new Map();
  const out = [];
  for (const round of (Array.isArray(rounds) ? rounds : []).filter(isOpenRound)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const key = String(round.classKey || round.label || "");
    const count = perKey.get(key) ?? 0;
    if (count >= perClass) continue;
    perKey.set(key, count + 1);
    out.push(round);
    if (out.length >= total) break;
  }
  return out;
}

/** "10 ต.ค." — รูปสั้นที่ใช้ในข้อความถึงลูกค้า */
export function roundShortThai(round) {
  return thaiShortDate(round.date).replace(/\s\d{4}$/u, "");
}

export function roundWeekdayThai(round) {
  const [year, month, day] = String(round.date).split("-").map(Number);
  return THAI_WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/** รอบที่ถูกเอ่ยวันที่ไว้ในข้อความชุดนี้ (เช่นข้อความที่ลูกแพรเพิ่งส่งรอบให้ดู) */
export function roundsMentionedIn(texts, rounds) {
  const joined = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text ?? "")).join("\n");
  if (!joined.trim()) return [];
  return (Array.isArray(rounds) ? rounds : []).filter((round) => mentionsCalendarDate(joined, round.date));
}

/**
 * รอบของ "คลาสที่คุยกันอยู่" — ชื่อผลิตภัณฑ์เต็มโผล่ในบทสนทนาและชี้ได้คลาสเดียว
 * (ชื่อชนกันสองคลาส = ไม่เดา คืน [])
 */
export function roundsOfDiscussedClass(texts, rounds) {
  const joined = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text ?? "")).join("\n").toLowerCase();
  const byClass = new Map();
  for (const round of Array.isArray(rounds) ? rounds : []) {
    const key = String(round.classKey || round.label || "");
    if (!byClass.has(key)) byClass.set(key, { names: new Set(), rounds: [] });
    const entry = byClass.get(key);
    for (const name of [round.product, round.label]) if (String(name || "").trim()) entry.names.add(String(name).toLowerCase());
    entry.rounds.push(round);
  }
  const hits = [...byClass.values()].filter((entry) => [...entry.names].some((name) => joined.includes(name)));
  return hits.length === 1 ? hits[0].rounds : [];
}
