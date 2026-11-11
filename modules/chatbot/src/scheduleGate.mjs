// scheduleGate.mjs — Schedule Gate: เวลาทำการของบอท (runtime settings ใน DB, default ปิด)
//
// กติกา:
// - settings: schedule_enabled ("1"/"0"), schedule_active_hours ("HH:MM-HH:MM" เวลาไทย),
//   schedule_ack_template (ข้อความตอบรับนอกเวลา — ว่าง = ไม่ส่ง)
// - รองรับช่วงข้ามคืน เช่น 20:00-08:00 (start รวม, end ไม่รวม) — Asia/Bangkok ไม่มี DST
// - ลำดับความสำคัญใน pipeline: takeover (AI ปิด) > operator-pause > do_not_disturb/opt-out
//   > schedule gate > ตอบปกติ — gate นี้เช็คท้ายสุดก่อนตอบ
// - นอกเวลา: ข้อความลูกค้ายังถูก log ครบ, เส้นทาง escalate ฉุกเฉินยังยิง,
//   ack ส่งได้ครั้งเดียวต่อลูกค้าต่อช่วงปิดหนึ่งช่วง (กุญแจ = เวลาเริ่มช่วงปิด)
// - อ่าน settings พัง = ถือว่า gate ปิด (บอทตอบปกติ — ความปลอดภัยตัวอื่น fail-closed อยู่แล้ว)

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export const SCHEDULE_ENABLED_KEY = "schedule_enabled";
export const SCHEDULE_HOURS_KEY = "schedule_active_hours";
export const SCHEDULE_ACK_KEY = "schedule_ack_template";

// "HH:MM-HH:MM" -> { startMin, endMin } (นาทีของวันเวลาไทย) หรือ null ถ้ารูปแบบผิด
// start == end = ช่วงกำกวม (ทั้งวัน/ศูนย์นาที) — ถือว่า config ใช้ไม่ได้
export function parseActiveHours(raw) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(String(raw || "").trim());
  if (!m) return null;
  const startMin = Number(m[1]) * 60 + Number(m[2]);
  const endMin = Number(m[3]) * 60 + Number(m[4]);
  if (startMin === endMin) return null;
  return { startMin, endMin };
}

function bangkokMinuteOfDay(tsMs) {
  return Math.floor(((tsMs + BANGKOK_OFFSET_MS) % DAY_MS) / MIN_MS);
}

function bangkokDayStartMs(tsMs) {
  return Math.floor((tsMs + BANGKOK_OFFSET_MS) / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS;
}

// อยู่ในเวลาทำการไหม — start รวม, end ไม่รวม; startMin > endMin = ช่วงข้ามคืน
export function inActiveWindow(tsMs, window) {
  if (!window) return true;
  const m = bangkokMinuteOfDay(tsMs);
  if (window.startMin < window.endMin) return m >= window.startMin && m < window.endMin;
  return m >= window.startMin || m < window.endMin;
}

// จุดเริ่ม (epoch ms) ของช่วง "นอกเวลาทำการ" รอบปัจจุบัน — ใช้เป็นกุญแจ ack ต่อช่วง
// อยู่ในเวลาทำการ = null
export function offWindowStartMs(tsMs, window) {
  if (!window || inActiveWindow(tsMs, window)) return null;
  const dayStart = bangkokDayStartMs(tsMs);
  const m = bangkokMinuteOfDay(tsMs);
  const endMs = window.endMin * MIN_MS;
  if (window.startMin < window.endMin) {
    // ช่วงปิด = [end, start วันถัดไป) — ยังไม่ถึง start วันนี้ = ช่วงปิดเริ่มตั้งแต่ end เมื่อวาน
    return m < window.startMin ? dayStart - DAY_MS + endMs : dayStart + endMs;
  }
  return dayStart + endMs; // ข้ามคืน: ช่วงปิด = [end, start) ภายในวันเดียวกัน
}

// อ่านสถานะ gate จาก settings — คืนค่าพร้อมใช้สำหรับ pipeline และหน้า console
export function scheduleState({ db, now = Date.now } = {}) {
  let enabledRaw = null;
  let hoursRaw = "";
  let ackTemplate = "";
  try {
    enabledRaw = db.getSetting(SCHEDULE_ENABLED_KEY);
    hoursRaw = db.getSetting(SCHEDULE_HOURS_KEY) || "";
    ackTemplate = db.getSetting(SCHEDULE_ACK_KEY) || "";
  } catch {
    return { enabled: false, window: null, active: true, offPeriodStart: null, ackTemplate: "" };
  }
  const window = parseActiveHours(hoursRaw);
  // เปิดใช้จริงต้องมีทั้งสวิตช์ "1" และช่วงเวลาที่ parse ได้ — ไม่ครบ = gate ไม่ทำงาน
  if (enabledRaw !== "1" || !window) {
    return { enabled: false, window, active: true, offPeriodStart: null, ackTemplate };
  }
  const t = now();
  const active = inActiveWindow(t, window);
  return {
    enabled: true,
    window,
    active,
    offPeriodStart: active ? null : offWindowStartMs(t, window),
    ackTemplate,
  };
}
