// exportCsv.mjs — Export ประวัติแชทเป็น CSV (Excel-friendly สำหรับแอดมินไทย)
//
// กติกา:
// - BOM (UTF-8) นำหน้าเสมอ — Excel ภาษาไทยอ่านออกทันที ไม่ต้อง import wizard
// - escape ตามมาตรฐาน CSV: มี " , \n \r = ครอบด้วย quote และ double quote ข้างใน
// - บรรทัดจบด้วย \r\n (Excel ทุกแพลตฟอร์มอ่านตรง)
// - เวลาเป็น Asia/Bangkok (UTC+7 คงที่ ไม่มี DST) รูปแบบ YYYY-MM-DD HH:MM
// - stream ทีละ batch ลง response — ห้ามต่อ string ก้อนยักษ์ (ชุดใหญ่กิน RAM)

import { activeBrand, brandSlug, isGenericProfile } from "./brand.mjs";

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const EXPORT_BATCH_SIZE = 500;

// W3: คอลัมน์ "สาขา" ต่อท้าย (ต่อท้ายเพื่อไม่ขยับตำแหน่งคอลัมน์เดิมของคนที่ import ประจำ)
export const EXPORT_HEADER = [
  "วันที่เวลา", "ลูกค้า", "user_id", "ทิศทาง", "ผู้ตอบ", "โหมด", "ประเภท", "ข้อความ", "สาขา",
];

const pad = (n) => String(n).padStart(2, "0");

// escape หนึ่ง field ตาม RFC 4180 — ค่าปกติผ่านตรง ๆ ไม่ครอบ quote ให้ไฟล์อ่านง่าย
// กัน CSV formula injection: เซลล์ที่ขึ้นต้นด้วย = + - @ (หรือ tab/CR) ถูก Excel/Sheets
// ตีความเป็นสูตร (เช่น =HYPERLINK(...)) — นำหน้าด้วย ' ให้กลายเป็นข้อความล้วน แล้วค่อย quote ตามปกติ
export function csvField(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// epoch ms -> "YYYY-MM-DD HH:MM" เวลาไทย
export function fmtBangkok(ms) {
  const d = new Date(Number(ms) + BANGKOK_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// "YYYY-MM" -> { sinceMs, untilMs } ขอบเขตเดือนตามเที่ยงคืนกรุงเทพ / null = รูปแบบผิด
export function bangkokMonthRangeMs(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) return null;
  return {
    sinceMs: Date.UTC(year, mon - 1, 1) - BANGKOK_OFFSET_MS,
    untilMs: Date.UTC(year, mon, 1) - BANGKOK_OFFSET_MS,
  };
}

// airdog-chat-<scope>[-<channel>]-<month|all>-<yyyymmdd>.csv (วันที่วันนี้ตามเวลาไทย)
// W3: มี channel filter ค่อยแทรกชื่อสาขา — ไม่มี = ชื่อไฟล์เดิมทุกตัวอักษร
export function exportFilename(scope, month, nowMs = Date.now(), channel = null) {
  const d = new Date(Number(nowMs) + BANGKOK_OFFSET_MS);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const channelPart = channel ? `-${String(channel).replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
  // White-label: โปรไฟล์ generic ใช้ slug ของร้าน (BUSINESS_ID) แทน "airdog" — course = ชื่อเดิมทุกตัวอักษร
  const prefix = isGenericProfile(activeBrand()) ? brandSlug(activeBrand(), "shop") : "airdog";
  return `${prefix}-chat-${scope}${channelPart}-${month || "all"}-${stamp}.csv`;
}

// ชื่อลูกค้าที่คนอ่านรู้เรื่อง: ชื่อจริงที่แอดมินบันทึก > ชื่อโปรไฟล์ LINE > ท้าย id
function customerLabel(row) {
  return row.known_name || row.display_name || `ลูกค้า ${String(row.customer_id).slice(-6)}`;
}

// โหมดผู้ส่งขาออก — แถวเก่า (agent_mode = null) เดาจากคอลัมน์ operator
// heuristic เดียวกับ bubbleModeClass ใน console.js (B7d)
function modeLabel(row) {
  if (row.direction !== "out") return "";
  const mode = row.agent_mode || (row.operator ? "operator_ai_on" : "ai");
  if (mode === "operator_ai_off") return "แอดมิน-AIปิด";
  if (mode === "operator_ai_on") return "แอดมิน-AIเปิด";
  return "AI";
}

// หนึ่งแถว message -> หนึ่งบรรทัด CSV (ยังไม่รวม \r\n ท้ายบรรทัด)
// W3: channelLabel(channel_id) -> ชื่อสาขาที่คนอ่านรู้เรื่อง (ไม่ส่ง = id ตรง ๆ)
export function exportRowToCsv(row, channelLabel = null) {
  return [
    fmtBangkok(row.created_at),
    customerLabel(row),
    row.customer_id,
    row.direction === "in" ? "ลูกค้า" : "ร้าน",
    row.direction === "out" ? (row.operator || "AI") : "",
    modeLabel(row),
    row.msg_type,
    row.content,
    channelLabel ? channelLabel(row.channel_id ?? "default") : (row.channel_id ?? "default"),
  ].map(csvField).join(",");
}

// เขียน CSV ทั้งชุดลง res เป็น chunk ๆ (BOM + header ก่อน แล้ววน batch จนหมด)
// คืนจำนวนแถวข้อมูลที่เขียน — caller ใช้ลง audit
export function streamCsvExport(res, { db, customerId = null, channel = null, sinceMs = 0, untilMs = null, batchSize = EXPORT_BATCH_SIZE, channelLabel = null }) {
  res.write("\uFEFF" + EXPORT_HEADER.map(csvField).join(",") + "\r\n");
  let rows = 0;
  let afterCreatedAt = -1;
  let afterRowid = -1;
  for (;;) {
    const batch = db.exportMessagesBatch({
      customerId, channel, sinceMs, untilMs, afterCreatedAt, afterRowid, limit: batchSize,
    });
    if (batch.length === 0) break;
    res.write(batch.map((row) => `${exportRowToCsv(row, channelLabel)}\r\n`).join(""));
    rows += batch.length;
    const last = batch[batch.length - 1];
    afterCreatedAt = last.created_at;
    afterRowid = last.rid;
    if (batch.length < batchSize) break;
  }
  return rows;
}
