// lineUsageReport.mjs — ประกอบตัวเลข "LINE OA เดือนนี้" (28 ก.ย. 2026) · ฟังก์ชันบริสุทธิ์ ไม่แตะ DB/เครือข่าย
//
// คำถามพี่ง้วง: push ที่กินโควตามาจาก (1) ระบบส่งเข้าทีมงาน (2) บรอดแคสต์จาก LINE OA หรือ (3) ส่งหาลูกค้าจริง
// ที่มาของตัวเลขสามแหล่ง แต่ละแหล่งตอบได้คนละส่วน — ห้ามเอามาปนกันแบบเดา:
//   บัญชีของเรา (line_send_ledger)  = ระบบลูกแพรยิงเพื่ออะไร นับตั้งแต่วันเริ่มบันทึก (วันไทย)
//   สถิติ LINE (line_delivery_insights) = บรอดแคสต์/แชทจาก OA Manager + ยอด API รวม (วันญี่ปุ่น มาช้า ~1 วัน)
//   โควตา (quota/consumption)       = ยอดที่นับไปแล้วทั้งเดือน ณ ตอนนี้ (LINE บอกเองว่าเป็นค่าประมาณ)
// ส่วนที่ต่อกันไม่ได้แสดงเป็น "ยังแยกไม่ได้" พร้อมเหตุผล ไม่เกลี่ยให้ครบ
// ช่วงก่อนเริ่มบันทึก: แจ้งเตือนทีมนับจาก admin_audit (notify/digest จดจำนวน push ไว้ทุกครั้งอยู่แล้ว)
// ส่วน push อื่นของระบบรู้แค่ยอดรวมจากสถิติ LINE → "ระบบลูกแพร ก่อนเริ่มแยกประเภท"
// ราคา: ไม่มีราคาฝังในโค้ด — ประมาณเงินเฉพาะเมื่อเจ้าของกรอกแพ็กเกจเอง (บทเรียน: หน้า LINE ทางการแต่ละหน้าบอกไม่ตรงกัน)
import { bangkokDay } from "./lineSendLedger.mjs";
import { jstDateKey, jstDayStartMs } from "./lineInsight.mjs";

const DAY_MS = 86_400_000;
const BKK_OFFSET_MS = 7 * 3_600_000;
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const THAI_DAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
export const MONTHS_BACK = 11;

// กลุ่มตามคำถามของพี่ง้วง (ลำดับ = ลำดับที่โชว์)
export const SPLIT_PARTS = Object.freeze([
  { key: "team", label: "ส่งเข้าทีมงาน", hint: "แจ้งเตือนทีม + สรุปรายวันถึงเจ้าของ" },
  { key: "broadcast", label: "บรอดแคสต์", hint: "จาก LINE OA Manager + จากคอนโซลลูกแพร" },
  { key: "customers", label: "ส่งหาลูกค้า", hint: "ลูกแพรตอบแบบ push · ทักตาม · YOLO · ทีมตอบจากคอนโซล" },
  { key: "systemUnsplit", label: "ระบบลูกแพร ก่อนเริ่มแยกประเภท", hint: "push ของระบบก่อนวันเริ่มบันทึก (ไม่รวมแจ้งเตือนทีม)" },
  { key: "other", label: "อื่น ๆ ของระบบ", hint: "เช่น ข้อความตอบรับโหมดเทรน" },
  { key: "unknown", label: "ยังแยกไม่ได้", hint: "วันที่ LINE ยังไม่ส่งสถิติ หรือระบบอื่นที่ใช้ OA เดียวกัน" },
]);

export const PURPOSE_META = Object.freeze({
  team_alert: { group: "team", label: "แจ้งเตือนทีม (🔔 แจ้งจากระบบ Front Desk)" },
  owner_digest: { group: "team", label: "สรุปรายวันถึงเจ้าของ" },
  customer_reply: { group: "customers", label: "ลูกแพรตอบทันด้วย reply" },
  customer_reply_fallback: { group: "customers", label: "ลูกแพรตอบ แต่ต้องใช้ push" },
  followup: { group: "customers", label: "ทักตามอัตโนมัติ" },
  yolo: { group: "customers", label: "YOLO ที่พี่ง้วงสั่ง" },
  operator: { group: "customers", label: "ทีมตอบจากคอนโซล" },
  broadcast: { group: "broadcast", label: "บรอดแคสต์จากคอนโซลลูกแพร" },
  // 28 ก.ย. 2026: ข้อความตามขั้น (Step) ของคอนโซล — LINE จัด stepMessage ของ OA Manager ไว้กลุ่มเดียวกับบรอดแคสต์
  step_message: { group: "broadcast", label: "ข้อความตามขั้น (Step) จากคอนโซลลูกแพร" },
  // 11 ต.ค. 2026: ของที่ลูกค้าขอเองผ่านคีย์เวิร์ดแคมเปญ (#AIAGENT → การวางระบบ AI Agent ส่งรายคน)
  campaign_delivery: { group: "customers", label: "ส่งของที่ลูกค้าขอผ่านคีย์เวิร์ดแคมเปญ" },
  // 12 ต.ค. 2026 ค่ำ: คำลาหลังทีมกดยืนยันปิดห้องที่ AI เสนอ (ห้องตรวจของพี่ง้วง)
  owner_close: { group: "customers", label: "คำลาหลังทีมยืนยันปิดห้อง" },
  other: { group: "other", label: "อื่น ๆ (เช่น ตอบรับโหมดเทรน)" },
});
export const DETAIL_LABELS = Object.freeze({
  reply_rejected: "ตอบช้าจน reply token หมดอายุ",
  no_reply_token: "ตอบข้อความค้าง (ไม่มี reply token)",
  over_five: "คำตอบยาวเกิน 5 ก้อน",
});

// ช่องของ "Get number of message deliveries" · counts: true = นับโควตา · false = ไม่นับ · null = ไม่ทราบ
// ที่มาการนับ: developers.line.biz/en/docs/messaging-api/pricing/ + lineforbusiness.com/th/helpcenter/line-oa
// (ตรวจ 28 ก.ย. 2026: บรอดแคสต์/Step/Push/Multicast/Broadcast API นับ · แชท/ตอบกลับอัตโนมัติ/ทักทาย/Reply ไม่นับ)
export const INSIGHT_FIELDS = Object.freeze([
  { key: "broadcast", source: "oa", counts: true, label: "บรอดแคสต์ถึงเพื่อนทุกคน" },
  { key: "targeting", source: "oa", counts: true, label: "บรอดแคสต์แบบเลือกกลุ่ม" },
  { key: "stepMessage", source: "oa", counts: true, label: "ข้อความตามลำดับขั้น (Step)" },
  { key: "chat", source: "oa", counts: false, label: "แชทแอดมินใน OA Manager" },
  { key: "autoResponse", source: "oa", counts: false, label: "ตอบกลับอัตโนมัติ" },
  { key: "welcomeResponse", source: "oa", counts: false, label: "ข้อความทักทายเพื่อนใหม่" },
  { key: "apiPush", source: "api", counts: true, label: "push" },
  { key: "apiMulticast", source: "api", counts: true, label: "multicast" },
  { key: "apiBroadcast", source: "api", counts: true, label: "broadcast ผ่าน API" },
  { key: "apiNarrowcast", source: "api", counts: true, label: "narrowcast" },
  { key: "apiReply", source: "api", counts: false, label: "reply" },
]);
const FIELD_BY_KEY = new Map(INSIGHT_FIELDS.map((field) => [field.key, field]));
const sumFields = (counts, source, counted) => INSIGHT_FIELDS
  .filter((f) => f.source === source && f.counts === counted)
  .reduce((sum, f) => sum + (Number(counts?.[f.key]) || 0), 0);

/* --------------------------------- เดือน/วัน --------------------------------- */

export function bangkokMonthKey(ms) {
  return bangkokDay(ms).slice(0, 7);
}

/** ?month=YYYY-MM → เดือนนี้หรือย้อนได้ไม่เกิน MONTHS_BACK เดือน (ไม่ส่ง = เดือนนี้) */
export function resolveMonth(value, nowMs) {
  const current = bangkokMonthKey(nowMs);
  const key = value === undefined || value === null || value === "" ? current : String(value);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(key) || key > current) return { ok: false };
  const [cy, cm] = current.split("-").map(Number);
  const [y, m] = key.split("-").map(Number);
  if ((cy - y) * 12 + (cm - m) > MONTHS_BACK) return { ok: false };
  return { ok: true, key, current: key === current };
}

export function previousMonthKey(key) {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function monthWindow(key) {
  const [y, m] = key.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return {
    fromDay: `${key}-01`, toDay: `${key}-${String(days).padStart(2, "0")}`,
    fromDate: `${y}${mm}01`, toDate: `${y}${mm}${String(days).padStart(2, "0")}`,
    // เดือนของ LINE (โควตา/สถิติ) นับตามเวลาญี่ปุ่น — เริ่มก่อนเดือนไทย 2 ชม.
    lineStartMs: jstDayStartMs(`${y}${mm}01`),
    lineEndMs: jstDayStartMs(`${y}${mm}${String(days).padStart(2, "0")}`) + DAY_MS,
    days,
  };
}

/**
 * ช่วง "ก่อนเริ่มบันทึก" ของเดือน — ผู้เรียกใช้ดึงแถว audit ของแจ้งเตือนทีม · null = บัญชีครอบทั้งเดือนแล้ว
 * บัญชีว่างทั้งหมด (ยังไม่มีการส่งหลังขึ้นระบบนี้) = ทั้งช่วงยังเป็นก่อนเริ่มบันทึก
 */
export function preLedgerWindow({ monthKey, nowMs, ledgerStartMs }) {
  const win = monthWindow(monthKey);
  const end = Math.min(ledgerStartMs ?? Infinity, win.lineEndMs, nowMs);
  return end > win.lineStartMs ? { startMs: win.lineStartMs, endMs: end } : null;
}

export function thaiDayLabel(isoDay) {
  const [y, m, d] = String(isoDay).split("-").map(Number);
  return `${THAI_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${THAI_MONTHS[m - 1]}`;
}

export function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return `${THAI_MONTHS[m - 1]} ${y}`;
}

const isoOfDate = (date) => `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

/* ------------------------ แจ้งเตือนทีมก่อนเริ่มบันทึก (audit) ------------------------ */

const ALERT_SENT = /push แจ้งทีม (\d+)\/\d+ คน/u;
const DIGEST_BUBBLES = /bubbles=(\d+)/u;

/** นับ push ถึงทีมจากแถว audit (escalate_notify = คนที่ได้รับจริง · digest_sent = จำนวนบอลลูน ทีละ push) */
export function parseTeamPushAudit(rows = []) {
  const out = { alertEvents: 0, alertPushes: 0, digestSends: 0, digestPushes: 0, byLineDate: new Map() };
  for (const row of rows) {
    let pushes = 0;
    if (row.action === "escalate_notify") {
      pushes = Number(ALERT_SENT.exec(String(row.detail || ""))?.[1] || 0);
      out.alertEvents += 1;
      out.alertPushes += pushes;
    } else if (row.action === "digest_sent") {
      pushes = Number(DIGEST_BUBBLES.exec(String(row.detail || ""))?.[1] || 0);
      out.digestSends += 1;
      out.digestPushes += pushes;
    }
    if (pushes) {
      const date = jstDateKey(row.created_at);
      out.byLineDate.set(date, (out.byLineDate.get(date) || 0) + pushes);
    }
  }
  return out;
}

/* -------------------------------- ราคาแพ็กเกจ -------------------------------- */

export const LINE_PLAN_KEYS = Object.freeze({
  monthlyFeeThb: "line_plan_monthly_fee_thb",
  includedMessages: "line_plan_included_messages",
  extraPerMessageThb: "line_plan_extra_per_message_thb",
});
const PLAN_LIMITS = Object.freeze({
  monthlyFeeThb: { max: 1_000_000, integer: false, label: "ค่าแพ็กเกจต่อเดือน" },
  includedMessages: { max: 100_000_000, integer: true, label: "จำนวนข้อความที่รวมในแพ็กเกจ" },
  extraPerMessageThb: { max: 1_000, integer: false, label: "ราคาต่อข้อความส่วนเกิน" },
});

/** ตรวจค่าที่เจ้าของกรอก — ว่าง = ล้างค่านั้น · ตัวเลขติดลบ/เกินเพดาน/ไม่ใช่ตัวเลข = ปฏิเสธทั้งชุด */
export function parsePlanInput(body = {}) {
  const plan = {};
  for (const [field, limit] of Object.entries(PLAN_LIMITS)) {
    const raw = body?.[field];
    if (raw === undefined || raw === null || String(raw).trim() === "") { plan[field] = null; continue; }
    const text = String(raw).replaceAll(",", "").trim();
    const value = /^\d+(?:\.\d+)?$/u.test(text) ? Number(text) : NaN;
    if (!Number.isFinite(value) || value > limit.max || (limit.integer && !Number.isInteger(value))) {
      return { ok: false, error: `${limit.label}ต้องเป็นตัวเลขไม่ติดลบ${limit.integer ? " (จำนวนเต็ม)" : ""} และไม่เกิน ${limit.max.toLocaleString("en-US")}` };
    }
    plan[field] = value;
  }
  return { ok: true, plan };
}

export function readPlan(getSetting) {
  const plan = {};
  for (const [field, key] of Object.entries(LINE_PLAN_KEYS)) {
    let raw = null;
    try { raw = getSetting(key); } catch { raw = null; }
    const value = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    plan[field] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return { ...plan, configured: plan.monthlyFeeThb !== null && plan.includedMessages !== null };
}

// ค่าแพ็กเกจ + ส่วนเกิน × ราคา — ไม่รู้ราคาส่วนเกินแต่ใช้เกินแล้ว = null (ห้ามเดาเป็นศูนย์)
function costFor(plan, used) {
  if (!plan?.configured || !Number.isFinite(used)) return null;
  const extraMessages = Math.max(0, Math.round(used) - plan.includedMessages);
  const extraThb = plan.extraPerMessageThb === null ? (extraMessages > 0 ? null : 0) : extraMessages * plan.extraPerMessageThb;
  return { used: Math.round(used), extraMessages, extraThb, totalThb: extraThb === null ? null : plan.monthlyFeeThb + extraThb };
}

/* ---------------------------------- ตัวประกอบ ---------------------------------- */

function emptyPurpose(purpose) {
  const meta = PURPOSE_META[purpose] || PURPOSE_META.other;
  return { purpose, group: meta.group, label: meta.label, counted: 0, free: 0, sends: 0, requests: 0, messageObjects: 0, details: {} };
}

function summarizeLedger(rows, win, lastDay) {
  const byPurpose = new Map();
  const byDay = new Map();
  const batching = { requests: 0, sends: 0 };
  for (const row of rows) {
    if (row.day < win.fromDay || row.day > lastDay) continue;
    const purpose = PURPOSE_META[row.purpose] ? row.purpose : "other";
    const entry = byPurpose.get(purpose) || emptyPurpose(purpose);
    const counted = Number(row.counts_quota) === 1 ? Number(row.recipients) || 0 : 0;
    const free = Number(row.counts_quota) === 1 ? 0 : Number(row.recipients) || 0;
    entry.counted += counted;
    entry.free += free;
    entry.sends += Number(row.sends) || 0;
    entry.requests += Number(row.requests) || 0;
    entry.messageObjects += Number(row.message_objects) || 0;
    if (row.detail && counted) entry.details[row.detail] = (entry.details[row.detail] || 0) + counted;
    byPurpose.set(purpose, entry);
    // push ทีละบอลลูน: คำขอมากกว่าครั้งส่ง = รวมเป็นคำขอเดียวได้ (LINE นับต่อคำขอ ไม่ใช่ต่อบอลลูน)
    if (row.method === "push") {
      batching.requests += Number(row.requests) || 0;
      batching.sends += Number(row.sends) || 0;
    }
    const day = byDay.get(row.day) || { team: 0, customers: 0, customersFree: 0, broadcast: 0, other: 0 };
    const group = entry.group;
    if (group === "customers") { day.customers += counted; day.customersFree += free; } else day[group] += counted;
    byDay.set(row.day, day);
  }
  return { byPurpose, byDay, batching };
}

function summarizeInsights(rows, win, lastDate) {
  const byDate = new Map();
  for (const row of rows) {
    const date = String(row.date);
    if (date < win.fromDate || date > lastDate) continue;
    const entry = byDate.get(date) || { status: row.status, counts: {}, channels: 0, ready: 0 };
    entry.channels += 1;
    if (row.status === "ready") {
      entry.ready += 1;
      let counts = {};
      try { counts = JSON.parse(row.counts_json || "{}") || {}; } catch { counts = {}; }
      for (const [key, value] of Object.entries(counts)) {
        if (Number.isSafeInteger(value) && value >= 0) entry.counts[key] = (entry.counts[key] || 0) + value;
      }
    }
    // วันที่มีหลาย OA: ready ครบทุก OA ถึงนับว่าวันนั้นพร้อม
    entry.status = entry.ready === entry.channels ? "ready" : row.status === "ready" ? entry.status : row.status;
    byDate.set(date, entry);
  }
  return byDate;
}

/**
 * @param {object} input
 * @param {Array<{channelId:string,name?:string,quota:{type:string,value:number|null,totalUsage:number,at?:number,cachedAt?:number}|null}>} input.quotas
 */
export function buildLineUsageReport({
  nowMs, monthKey, ledgerRows = [], ledgerStartMs = null, insightRows = [], quotas = [],
  auditRows = [], plan = null, includeCost = false, quotaSource = "live",
  // false = มุมมองที่เติมแจ้งเตือนทีมย้อนหลังจาก audit ไม่ได้ (เลือก OA เดียวใน instance หลาย OA — audit ไม่ได้จดว่าออกทาง OA ไหน)
  auditBackfill = true,
}) {
  const win = monthWindow(monthKey);
  const current = monthKey === bangkokMonthKey(nowMs);
  const lastDay = current ? bangkokDay(nowMs) : win.toDay;
  // สถิติของ LINE มีถึงเมื่อวานเท่านั้น (ของวันนี้ยังนับไม่เสร็จ)
  const lastDate = current ? jstDateKey(nowMs - DAY_MS) : win.toDate;
  const ledger = summarizeLedger(ledgerRows, win, lastDay);
  const insight = summarizeInsights(insightRows, win, lastDate);
  const readyDates = [...insight.entries()].filter(([, e]) => e.status === "ready").map(([date]) => date).sort();
  // วันที่ควรมีสถิติแล้ว = ต้นเดือนถึงเมื่อวานของ LINE (วันที่ 1 ของเดือน LINE ยังไม่มีวันไหนพร้อม)
  const expectedDates = lastDate < win.fromDate ? 0 : Number((lastDate < win.toDate ? lastDate : win.toDate).slice(6, 8));

  // ---- บัญชีของเรา ----
  const purposes = Object.keys(PURPOSE_META).map((p) => ledger.byPurpose.get(p) || emptyPurpose(p));
  const groupCounted = (group) => purposes.filter((p) => p.group === group).reduce((s, p) => s + p.counted, 0);
  const preWindow = preLedgerWindow({ monthKey, nowMs, ledgerStartMs });
  const audit = preWindow ? parseTeamPushAudit(auditRows.filter((row) => row.created_at >= preWindow.startMs && row.created_at < preWindow.endMs)) : null;
  const teamPre = audit ? audit.alertPushes + audit.digestPushes : 0;

  // ---- สถิติ LINE ----
  const oaFields = {};
  let apiPushPreLedger = 0; // push/narrowcast/broadcast API ของวันก่อนเริ่มบันทึก (แยกประเภทไม่ได้)
  let apiMulticastPreLedger = 0; // multicast มีใช้แค่บรอดแคสต์ของคอนโซลเรา — นับเป็นบรอดแคสต์ได้ตรง ๆ
  let teamAlignedPreLedger = 0;
  for (const date of readyDates) {
    const counts = insight.get(date).counts;
    for (const [key, value] of Object.entries(counts)) oaFields[key] = (oaFields[key] || 0) + value;
    // วันของ LINE ที่จบก่อนเริ่มบันทึกทั้งวัน: ยอด API ทั้งวันเป็นของระบบเรา
    if (preWindow && jstDayStartMs(date) + DAY_MS <= preWindow.endMs) {
      const multicast = Number(counts.apiMulticast) || 0;
      apiMulticastPreLedger += multicast;
      apiPushPreLedger += sumFields(counts, "api", true) - multicast;
      teamAlignedPreLedger += audit?.byLineDate.get(date) || 0;
    }
  }
  const oaCounted = sumFields(oaFields, "oa", true);
  const apiCounted = sumFields(oaFields, "api", true);

  // ---- โควตา ----
  const usable = (quotas || []).filter((q) => q?.quota && Number.isFinite(Number(q.quota.totalUsage)));
  const used = current && usable.length ? usable.reduce((s, q) => s + Number(q.quota.totalUsage), 0) : null;
  const limited = usable.length && usable.every((q) => q.quota.type === "limited" && Number.isFinite(Number(q.quota.value)));
  const limit = current && limited ? usable.reduce((s, q) => s + Number(q.quota.value), 0) : null;
  const quotaAt = usable.map((q) => Number(q.quota.at ?? q.quota.cachedAt) || null).filter(Boolean);
  // เดือนที่ผ่านไปแล้ว: ยอดทางการ = ผลรวมสถิติ LINE ถ้ามีครบทุกวัน
  const officialPast = !current && readyDates.length === win.days ? oaCounted + apiCounted : null;
  const total = used ?? officialPast;

  // ---- โควตาไปไหน ----
  const values = {
    team: groupCounted("team") + teamPre,
    broadcast: oaCounted + groupCounted("broadcast") + apiMulticastPreLedger,
    customers: groupCounted("customers"),
    systemUnsplit: Math.max(0, apiPushPreLedger - teamAlignedPreLedger),
    other: groupCounted("other"),
  };
  const known = Object.values(values).reduce((s, v) => s + v, 0);
  const unknown = total === null ? null : Math.max(0, total - known);
  const overCount = total === null ? 0 : Math.max(0, known - total);
  // ไม่ได้เติมจาก audit = ยอดก่อนเริ่มบันทึกยังรวมแจ้งเตือนทีมอยู่ — คำอธิบายต้องบอกตามจริง
  const hintFor = (part) => (part.key === "systemUnsplit" && !auditBackfill ? "push ของระบบก่อนวันเริ่มบันทึก (รวมแจ้งเตือนทีม — มุมมองรายสาขาแยกย้อนหลังไม่ได้)" : part.hint);
  const parts = SPLIT_PARTS
    .map((part) => ({ ...part, hint: hintFor(part), value: part.key === "unknown" ? unknown : values[part.key] }))
    .filter((part) => part.value !== null && (part.value > 0 || ["team", "broadcast", "customers"].includes(part.key)));

  // ---- รายวัน (วันไทย) ----
  const ledgerStartDay = ledgerStartMs ? bangkokDay(ledgerStartMs) : null;
  const auditByBkkDay = new Map();
  for (const row of preWindow ? auditRows : []) {
    if (row.created_at < preWindow.startMs || row.created_at >= preWindow.endMs) continue;
    const single = parseTeamPushAudit([row]);
    const pushes = single.alertPushes + single.digestPushes;
    if (pushes) auditByBkkDay.set(bangkokDay(row.created_at), (auditByBkkDay.get(bangkokDay(row.created_at)) || 0) + pushes);
  }
  const days = [];
  for (let d = Number(lastDay.slice(8, 10)); d >= 1; d -= 1) {
    const day = `${monthKey}-${String(d).padStart(2, "0")}`;
    const tracked = ledgerStartDay !== null && day >= ledgerStartDay;
    const row = ledger.byDay.get(day) || { team: 0, customers: 0, customersFree: 0, broadcast: 0, other: 0 };
    const lineEntry = insight.get(day.replaceAll("-", ""));
    const lineReady = lineEntry?.status === "ready";
    days.push({
      day, label: thaiDayLabel(day), tracked,
      // วันแรกของบัญชีนับได้เฉพาะหลังเวลาเริ่ม (ช่องลูกค้า/บรอดแคสต์ของช่วงก่อนหน้านั้นในวันเดียวกันไม่มีที่มา) — บอกเวลาเริ่มกำกับแถว
      startsAt: preWindow && ledgerStartMs && day === ledgerStartDay ? ledgerStartMs : null,
      // ก่อนเริ่มบันทึก แจ้งเตือนทีมยังนับได้ครบจาก audit (วันที่ไม่มีแถว = ไม่มีการแจ้งเตือนจริง ๆ)
      team: row.team + (auditByBkkDay.get(day) || 0),
      customers: tracked ? row.customers : null,
      customersFree: tracked ? row.customersFree : null,
      broadcastSystem: tracked ? row.broadcast : null,
      other: tracked ? row.other : null,
      countedOurs: tracked ? row.team + row.customers + row.broadcast + row.other : null,
      lineStatus: lineEntry ? lineEntry.status : "none",
      lineOaCounted: lineReady ? sumFields(lineEntry.counts, "oa", true) : null,
      lineApiCounted: lineReady ? sumFields(lineEntry.counts, "api", true) : null,
      lineFree: lineReady ? sumFields(lineEntry.counts, "oa", false) + sumFields(lineEntry.counts, "api", false) : null,
    });
  }

  // ---- แจ้งเตือนทีมทั้งเดือน (คาดการณ์) ----
  const elapsedDays = current ? Math.max(1, (nowMs - win.lineStartMs) / DAY_MS) : win.days;
  const teamProjected = Math.round((values.team / elapsedDays) * win.days);
  const projectedUsed = total === null ? null : current ? Math.round((total / elapsedDays) * win.days) : total;

  let cost = null;
  if (includeCost) {
    const planInfo = plan || { configured: false };
    const now = costFor(planInfo, total);
    const projected = current ? costFor(planInfo, projectedUsed) : null;
    // ย้ายแจ้งเตือนทีมออกจาก LINE: ประหยัดเงินได้เฉพาะส่วนที่ทำให้เกินโควตาของแพ็กเกจ
    let teamSavingThb = null;
    if (planInfo.configured && planInfo.extraPerMessageThb !== null && projectedUsed !== null) {
      const over = Math.max(0, projectedUsed - planInfo.includedMessages);
      teamSavingThb = Math.min(teamProjected, over) * planInfo.extraPerMessageThb;
    }
    cost = {
      configured: planInfo.configured === true,
      plan: { monthlyFeeThb: planInfo.monthlyFeeThb ?? null, includedMessages: planInfo.includedMessages ?? null, extraPerMessageThb: planInfo.extraPerMessageThb ?? null },
      now, projected, teamSavingThb,
    };
  }

  // หมายเหตุมี key ให้หน้าจอเลือกซ่อนอันที่การ์ดบอกไว้แล้วในตำแหน่งอื่น (แชทเจ้าของใช้ครบทุกข้อ)
  const notes = [];
  const note = (key, text) => notes.push({ key, text });
  if (ledgerStartMs === null) note("ledger_empty", "ยังไม่มีการส่งที่ระบบบันทึกได้ในเดือนนี้ — ตัวเลขฝั่งระบบจะเริ่มขึ้นหลังข้อความแรก");
  else if (preWindow) {
    note("ledger_since", auditBackfill
      ? `บันทึกฝั่งระบบเริ่มนับตั้งแต่วันที่ ${thaiDayLabel(ledgerStartDay)} — ก่อนหน้านั้นแยกได้เฉพาะแจ้งเตือนทีม (จากบันทึกการแจ้งเตือน) ที่เหลือเป็นยอดรวมจากสถิติ LINE`
      : `บันทึกฝั่งระบบเริ่มนับตั้งแต่วันที่ ${thaiDayLabel(ledgerStartDay)} — ก่อนหน้านั้นเป็นยอดรวมจากสถิติ LINE (มุมมองรายสาขาแยกแจ้งเตือนทีมย้อนหลังไม่ได้)`);
  }
  if (readyDates.length < expectedDates) {
    note("line_stats_partial", readyDates.length
      ? `สถิติ LINE มีถึงวันที่ ${thaiDayLabel(isoOfDate(readyDates.at(-1)))} (${readyDates.length}/${expectedDates} วัน) — LINE ส่งสถิติช้าประมาณ 1 วัน`
      : "ยังไม่มีสถิติจาก LINE ของเดือนนี้ — ระบบดึงให้เองวันละครั้ง (ตัวเลขบรอดแคสต์จาก OA Manager จะขึ้นหลังจากนั้น)");
  }
  if (overCount > 0) note("over_count", `ตัวเลขที่ระบบนับได้มากกว่ายอดของ LINE ${overCount.toLocaleString("en-US")} ข้อความ — LINE ไม่นับข้อความถึงคนที่บล็อก OA และยอดโควตาของ LINE เป็นค่าประมาณ`);
  if (!current) note("past_month", "โควตาย้อนหลังดูได้ใน LINE OA Manager — หน้านี้ใช้ยอดรวมจากสถิติ LINE แทน");

  return {
    month: monthKey, monthLabel: monthLabel(monthKey), current, asOf: nowMs,
    quota: used === null ? null : {
      used, limit, left: limit === null ? null : Math.max(0, limit - used),
      ratio: limit ? Math.min(1, used / limit) : null,
      type: limited ? "limited" : "none", at: quotaAt.length ? Math.min(...quotaAt) : null, source: quotaSource,
      perChannel: usable.map((q) => ({ channelId: q.channelId, name: q.name || q.channelId, used: Number(q.quota.totalUsage), limit: q.quota.type === "limited" ? Number(q.quota.value) : null })),
    },
    split: { total, known, parts, overCount, teamProjected, projectedUsed },
    system: {
      startMs: ledgerStartMs, sinceDay: preWindow && ledgerStartMs ? ledgerStartDay : null,
      rows: purposes.map((p) => ({
        ...p, details: Object.entries(p.details).map(([key, value]) => ({ key, label: DETAIL_LABELS[key] || key, value })),
      })),
      countedTotal: purposes.reduce((s, p) => s + p.counted, 0),
      freeTotal: purposes.reduce((s, p) => s + p.free, 0),
      batching: ledger.batching.requests > ledger.batching.sends
        ? { requests: ledger.batching.requests, sends: ledger.batching.sends, saving: ledger.batching.requests - ledger.batching.sends } : null,
      preLedger: audit ? {
        alertEvents: audit.alertEvents, alertPushes: audit.alertPushes, digestPushes: audit.digestPushes,
        apiCounted: apiPushPreLedger + apiMulticastPreLedger, apiMulticast: apiMulticastPreLedger,
      } : null,
    },
    lineStats: {
      readyDays: readyDates.length, expectedDays: expectedDates,
      latestReady: readyDates.length ? isoOfDate(readyDates.at(-1)) : null,
      fields: INSIGHT_FIELDS.map((f) => ({ ...f, value: oaFields[f.key] || 0 })),
      extra: Object.entries(oaFields).filter(([key]) => !FIELD_BY_KEY.has(key)).map(([key, value]) => ({ key, value })),
      oaCounted, apiCounted,
      free: sumFields(oaFields, "oa", false) + sumFields(oaFields, "api", false),
    },
    days, cost, notes,
  };
}
