// bangkokTime.mjs — ขอบเขตวัน/เดือนของธุรกิจตามเวลา Asia/Bangkok (UTC+7 ไม่มี DST)
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

export function bangkokDayStartMs(nowMs = Date.now()) {
  return Math.floor((nowMs + BANGKOK_OFFSET_MS) / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS;
}

export function bangkokMonthStartMs(nowMs = Date.now()) {
  const date = new Date(nowMs + BANGKOK_OFFSET_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - BANGKOK_OFFSET_MS;
}
