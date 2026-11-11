// workClock.mjs — นาฬิกาเวลาทำการของทีม สำหรับ "ไม้ต่อจากลูกแพร" (relayBaton.mjs · คำสั่งพี่ง้วง 3 พ.ย. 2026)
//
// พี่ง้วง: "จันทร์-เสาร์ (ยกเว้นวันหยุดนักขัตฤกษ์ ตาม calendar) หรือ ถ้าวันไหน ชมพู่ไม่มา หรือไม่นับ ผมจะบอกในแชทเอง"
// - วันทำงาน = จันทร์–เสาร์ 09:00–18:00 เวลาไทย · อาทิตย์ไม่นับ
// - วันที่ไม่นับ (นักขัตฤกษ์ + วันที่ชมพู่ไม่มา) อยู่รายการเดียวกับวันหยุดของหน้าผลงาน (settings.kpi_holidays)
//   ตัวเลขผลงานกับนาฬิกาไม้ต่อจึงตัดวันเดียวกันเสมอ ไม่มีสองรายการให้ลืมอัปเดตอีกที่
// ฟังก์ชันบริสุทธิ์ทั้งหมด (ยกเว้น readOffDays ที่อ่าน DB) — เทสต์คุมนิยามได้ตรง ๆ

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BANGKOK_OFFSET_MS = 7 * HOUR;
export const WORK_DAY_START_HOUR = 9;
export const WORK_DAY_END_HOUR = 18;
export const OFF_DAYS_KEY = "kpi_holidays";
// กันวนไม่จบเมื่อช่วงเวลายาวผิดปกติ — ไม้ต่อดูย้อนหลังไม่กี่สัปดาห์ เกินนี้ถือว่าครบไปนานแล้ว
const MAX_DAYS_SCAN = 400;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;

export function parseOffDays(raw) {
  return new Set(String(raw ?? "").split(/[\s,]+/u).map((s) => s.trim()).filter((s) => DATE_KEY.test(s)));
}

/** อ่านรายการวันที่ไม่นับจาก settings — อ่านพัง = ไม่มีวันหยุดเพิ่ม (นับเข้มกว่า ดีกว่าซ่อนห้องค้าง) */
export function readOffDays(db) {
  try {
    return parseOffDays(db.getSetting(OFF_DAYS_KEY));
  } catch {
    return new Set();
  }
}

// เที่ยงคืนเวลาไทยของวันที่ t อยู่ (เป็นเวลา UTC ms)
function bangkokMidnight(t) {
  return Math.floor((Number(t) + BANGKOK_OFFSET_MS) / DAY) * DAY - BANGKOK_OFFSET_MS;
}

function dayKeyOf(midnight) {
  return new Date(midnight + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

export function isWorkDay(midnight, offDays = new Set()) {
  if (new Date(midnight + BANGKOK_OFFSET_MS).getUTCDay() === 0) return false; // อาทิตย์
  return !offDays.has(dayKeyOf(midnight));
}

function workWindow(midnight) {
  return [midnight + WORK_DAY_START_HOUR * HOUR, midnight + WORK_DAY_END_HOUR * HOUR];
}

/** เวลาทำการที่ผ่านไประหว่าง fromMs → toMs (ms) */
export function workMsBetween(fromMs, toMs, { offDays = new Set() } = {}) {
  const from = Number(fromMs);
  const to = Number(toMs);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  let total = 0;
  let midnight = bangkokMidnight(from);
  for (let i = 0; i < MAX_DAYS_SCAN && midnight < to; i += 1, midnight += DAY) {
    if (!isWorkDay(midnight, offDays)) continue;
    const [start, end] = workWindow(midnight);
    total += Math.max(0, Math.min(end, to) - Math.max(start, from));
  }
  return total;
}

/** เวลาจริงที่ "เวลาทำการ" สะสมครบ workMs นับจาก startMs — เช่น ลูกแพรจบ 22:00 + 2 ชม. = 11:00 วันทำงานถัดไป */
export function addWorkMs(startMs, workMs, { offDays = new Set() } = {}) {
  let left = Math.max(0, Number(workMs) || 0);
  let cursor = Number(startMs);
  let midnight = bangkokMidnight(cursor);
  for (let i = 0; i < MAX_DAYS_SCAN; i += 1, midnight += DAY) {
    if (!isWorkDay(midnight, offDays)) continue;
    const [start, end] = workWindow(midnight);
    const from = Math.max(start, cursor);
    if (from >= end) continue;
    if (from + left <= end) return from + left;
    left -= end - from;
    cursor = end;
  }
  return Number.POSITIVE_INFINITY;
}

/** วันที่ t อยู่เป็นวันทำงานไหม (จ.–ส. และไม่อยู่ในรายการ) — รอบแจ้งเตือน 18:10 อยู่นอกเวลาทำการแต่ยังเป็นวันทำงาน */
export function isWorkDayAt(tsMs, { offDays = new Set() } = {}) {
  return isWorkDay(bangkokMidnight(tsMs), offDays);
}

/** ตอนนี้อยู่ในเวลาทำการไหม */
export function isWorkTime(tsMs, { offDays = new Set() } = {}) {
  const midnight = bangkokMidnight(tsMs);
  if (!isWorkDay(midnight, offDays)) return false;
  const [start, end] = workWindow(midnight);
  return tsMs >= start && tsMs < end;
}
