// kpi.mjs — วัดผลการตอบแชท คน vs ลูกแพร (คำสั่งพี่ง้วง 1 ก.ย. 2026)
//
// ทุกฟังก์ชันที่นี่บริสุทธิ์ (รับแถว คืนตัวเลข) เพื่อให้เทสต์คุมนิยามได้ครบ —
// KPI ที่นิยามเพี้ยนอันตรายกว่าไม่มี KPI เพราะคนจะตัดสินใจจากมัน
//
// สามเรื่องที่ตั้งใจออกแบบให้ไม่หลอกตา:
// 1. ใช้ "ค่ากลาง" ไม่ใช่ค่าเฉลี่ย — เคสตอบข้ามคืนไม่กี่เคสลากค่าเฉลี่ยจนไร้ความหมาย
// 2. แยกตัวเลข "เฉพาะเวลาทำการ" ให้ด้วย — AI ตอบตีสองได้ คนไม่ได้ เทียบรวมคือไม่แฟร์
// 3. % ปิดการขายโชว์เฉพาะ Hybrid กับ AI ล้วน (พี่ง้วงเคาะ) — ห้องที่คนดูแลล้วนคือเคส
//    ที่ถูกคัดมาแล้วว่ายาก (จังหวะเงิน/ข้อร้องเรียน/งาน in-house) เอา % ไปเทียบกันตรง ๆ
//    จะอ่านออกมาว่า "AI ปิดเก่งกว่าคน" ซึ่งไม่จริงและไม่แฟร์กับทีม

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 21;

// จังหวะที่ถือว่า "ปิดการขายแล้ว" — ตามที่พี่ง้วงกำหนด: ไปถึงจุดส่งเลขบัญชี
// หรือส่งรายละเอียด private/in-house ครบ (ไม่ใช่ "เก็บเงินได้" — บอทไม่ยืนยันยอดโดยตั้งใจ)
export const CLOSED_OFF_REASONS = Object.freeze(["bank_sent", "handoff_private_inhouse"]);
export const CLOSED_DEAL_STATUSES = Object.freeze(["awaiting_payment", "paid", "won"]);
// 5 ต.ค. 2026 (พี่ง้วง): ห้องสีเหลือง "AI off (not qualify)" = ตั้งใจไม่ตามต่อ — ไม่ใช่งานค้างของทีม
// นับแยกไว้ใน excluded ให้เห็นว่าตัดออกกี่ห้อง (ไม่ซ่อน) — ใช้รหัสตรงกับ notQualified.mjs
// รีวิวปรปักษ์ 5 ต.ค. #20: ตัดเฉพาะ "เหลืองนิ่งที่ตัวกวาดยืนยันแล้ว" (กติกาเดียวกับคิวรอตอบ dbAttention.quietYellowSql):
//   state = AI_ACTIVE และหมุด qualify_hold ≥ เวลาข้อความลูกค้าล่าสุด — ห้องเหลืองที่รอคน (NEEDS_HUMAN/RESOLVED แล้วทักกลับ)
//   หรือมีข้อความใหม่ที่ตัวกวาดยังไม่ยืนยัน ยังนับเป็นงานค้างของทีมตามปกติ
// หมุดมาจาก customer.qualify_hold_at (คอลัมน์ที่ผู้อ่าน DB เติมให้) หรือ qualifyHoldOf(customerId) ที่ผู้เรียกส่งมา
//   ไม่มีทั้งสองทาง = ไม่ตัด (fail open: เห็นเกินดีกว่าซ่อนลีดที่รอคำตอบ)
const NOT_QUALIFIED_OFF_REASON = "not_qualified";
function isQuietNotQualified(customer, lastInAt, qualifyHoldOf) {
  if (!(Number(customer?.ai_enabled) === 0 && String(customer?.ai_off_reason ?? "").trim() === NOT_QUALIFIED_OFF_REASON)) return false;
  if (String(customer?.state ?? "") !== "AI_ACTIVE") return false;
  let hold = Number(customer?.qualify_hold_at) || 0;
  if (!hold && typeof qualifyHoldOf === "function") {
    try { hold = Number(qualifyHoldOf(String(customer?.line_user_id ?? ""))) || 0; } catch { hold = 0; }
  }
  return hold > 0 && hold >= (Number(lastInAt) || 0);
}

export function bangkokHour(tsMs) {
  return Math.floor(((tsMs + BANGKOK_OFFSET_MS) % DAY_MS) / 3_600_000);
}

export function inWorkingHours(tsMs) {
  const hour = bangkokHour(tsMs);
  return hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

/** ข้อความขาออกนี้ใครส่ง — "ai" | "human" | null (ของเก่าก่อนติดป้าย) */
export function senderOf(message) {
  const mode = String(message?.agent_mode || "");
  if (mode === "ai") return "ai";
  if (mode.startsWith("operator")) return "human";
  // ของเก่าไม่มี agent_mode: ใช้ operator เป็นตัวตัดสิน (บอทเก็บ operator เป็นค่าว่าง)
  if (message?.agent_mode == null && String(message?.operator || "").trim()) return "human";
  return null;
}

// ตรวจกับของจริง 1 ก.ย. 2026: "ข้อความสุดท้ายเป็นของลูกค้า" ไม่เท่ากับ "ยังรอคำตอบ"
// ได้ 58 ห้องแต่ 37 ห้องเงียบมาเกิน 7 วัน (บทสนทนาจบไปแล้ว) และหลายห้องคือข้อความ
// แฮชแท็กที่ระบบ "ตั้งใจ" ไม่ตอบ (ปล่อยให้ LINE OA จัดการ) — ถ้านับรวม หน้านี้จะกลายเป็น
// ตัวเลขที่ทีมเลิกสนใจภายในสัปดาห์เดียว จึงนับเฉพาะที่ยังลงมือทันและควรลงมือจริง
export const BACKLOG_MAX_AGE_MS = 48 * 3_600_000;

/** ข้อความนี้เป็นแฮชแท็กที่ระบบตั้งใจเงียบไหม (บอทไม่ตอบโดยออกแบบ) */
export function isSilentByDesign(message) {
  return message?.is_hashtag === 1 || message?.is_hashtag === true;
}

/* ---- วันที่ไม่ควรเอามาวัดผลทีมงาน (คำสั่งพี่ง้วง 1 ก.ย. 2026) ----
 * ตัดวันอาทิตย์ วันหยุดนักขัตฤกษ์ และ "วันที่ทีมหยุด" ซึ่งดูจากกฎที่พี่ง้วงให้:
 * เช้า 09:00-11:00 ไม่มีใครในทีมตอบเลย = วันนั้นชมพู่หยุด
 *
 * กฎนี้ดีกว่ารายชื่อวันหยุดตายตัว เพราะจับวันหยุดนักขัตฤกษ์ วันลา และวันหยุดชดเชย
 * ได้เองโดยไม่ต้องมีใครมาอัปเดตรายชื่อทุกปี
 *
 * แต่มีการ์ดหนึ่งข้อ: ถ้าเช้าวันนั้น "ไม่มีลูกค้าทักเข้ามาเลย" การที่ทีมไม่ได้ตอบ
 * ไม่ใช่หลักฐานว่าหยุด — แปลว่าไม่มีใครถาม ถ้าตัดทิ้งจะเสียข้อมูลวันทำงานจริงไปฟรี ๆ
 */
export const TEAM_MORNING_START_HOUR = 9;
export const TEAM_MORNING_END_HOUR = 11;

export function dayKeyBangkok(tsMs) {
  return new Date(Number(tsMs) + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

export function isSunday(tsMs) {
  return new Date(Number(tsMs) + BANGKOK_OFFSET_MS).getUTCDay() === 0;
}

/** สรุปว่าแต่ละวันเป็นวันทำงานของทีมไหม — คืน Map<YYYY-MM-DD, {off, reason}> */
export function classifyDays(rooms = [], { holidays = new Set() } = {}) {
  const days = new Map();
  const touch = (tsMs) => {
    const key = dayKeyBangkok(tsMs);
    let day = days.get(key);
    if (!day) {
      day = { key, sunday: isSunday(tsMs), holiday: holidays.has(key), morningHumanReplies: 0, morningInbound: 0 };
      days.set(key, day);
    }
    return day;
  };
  for (const room of rooms) {
    for (const message of room.messages || []) {
      const day = touch(message.created_at);
      const hour = bangkokHour(message.created_at);
      if (hour < TEAM_MORNING_START_HOUR || hour >= TEAM_MORNING_END_HOUR) continue;
      if (message.direction === "in") { if (!isSilentByDesign(message)) day.morningInbound += 1; continue; }
      if (String(message.message_class || "") === "proactive") continue;
      if (senderOf(message) === "human") day.morningHumanReplies += 1;
    }
  }
  for (const day of days.values()) {
    // ทีมหยุก: มีลูกค้าทักเข้ามาตอนเช้าจริง แต่ไม่มีใครในทีมตอบเลยสักคน
    day.teamOff = day.morningInbound > 0 && day.morningHumanReplies === 0;
    day.off = day.sunday || day.holiday || day.teamOff;
    day.reason = day.sunday ? "วันอาทิตย์" : day.holiday ? "วันหยุดนักขัตฤกษ์" : day.teamOff ? "ทีมหยุด (เช้าไม่มีใครตอบ)" : "";
  }
  return days;
}

export function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1));
  return sortedValues[index];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: percentile(sorted, 50), p90Ms: percentile(sorted, 90) };
}

/**
 * จับคู่ "ลูกค้าพูดหนึ่งตา -> ใครตอบ และช้าเท่าไร"
 * - ลูกค้าพิมพ์ติดกันหลายข้อความ = หนึ่งตา (นับจากข้อความแรกของตานั้น ซึ่งคือเวลาที่เขาเริ่มรอ)
 * - ข้อความ proactive (follow-up) ไม่ใช่การตอบ — ข้ามไป ไม่ปิดตาที่ค้างอยู่
 * messages ต้องเรียงตามเวลาแล้ว และเป็นของลูกค้าคนเดียว
 */
export function responsePairs(messages = []) {
  const pairs = [];
  let waitingSince = null;
  for (const message of messages) {
    if (message.direction === "in") {
      // แฮชแท็กไม่ได้รอคำตอบจากเรา — ถ้านับ จะได้ "เวลารอ" ที่ไม่มีใครตั้งใจจะตอบตั้งแต่แรก
      if (isSilentByDesign(message)) continue;
      if (waitingSince == null) waitingSince = Number(message.created_at);
      continue;
    }
    if (String(message.message_class || "") === "proactive") continue;
    if (waitingSince == null) continue;
    const by = senderOf(message);
    if (by) pairs.push({ by, waitedMs: Number(message.created_at) - waitingSince, askedAt: waitingSince });
    waitingSince = null;
  }
  return pairs;
}

/** ห้องนี้ใครดูแล — "ai" ล้วน / "human" ล้วน / "hybrid" / "none" (ยังไม่มีใครตอบ) */
export function classifyRoom(messages = []) {
  let ai = 0;
  let human = 0;
  for (const message of messages) {
    if (message.direction !== "out") continue;
    const by = senderOf(message);
    if (by === "ai") ai += 1;
    else if (by === "human") human += 1;
  }
  if (ai && human) return "hybrid";
  if (ai) return "ai";
  if (human) return "human";
  return "none";
}

export function roomIsClosed(customer = {}) {
  return CLOSED_OFF_REASONS.includes(String(customer.ai_off_reason || ""))
    || CLOSED_DEAL_STATUSES.includes(String(customer.deal_status || ""));
}

/**
 * รวมทุกอย่างเป็นก้อนเดียวให้หน้าคอนโซล
 * rooms = [{ customer, messages }] โดย messages เรียงเวลาแล้วและอยู่ในช่วงที่วัด
 * qualifyHoldOf(customerId) = ค่า qualify_hold:<id> (ms) ของห้องเหลือง — ไม่ส่ง = ห้องเหลืองนับเป็น backlog ปกติ
 */
export function summarizeKpi({ rooms = [], nowMs = Date.now(), holidays = new Set(), qualifyHoldOf = null } = {}) {
  const days = classifyDays(rooms, { holidays });
  const speedAll = { ai: [], human: [] };
  const speedWork = { ai: [], human: [] };
  const speedWorkDays = { ai: [], human: [] };
  const backlog = [];
  const skipped = { hashtag: 0, stale: 0, notQualified: 0 };
  const byClass = {
    hybrid: { rooms: 0, closed: 0 },
    ai: { rooms: 0, closed: 0 },
    human: { rooms: 0, closed: 0 },
    none: { rooms: 0, closed: 0 },
  };
  let inboundTurns = 0;

  for (const room of rooms) {
    const messages = room.messages || [];
    const customer = room.customer || {};
    for (const pair of responsePairs(messages)) {
      inboundTurns += 1;
      speedAll[pair.by].push(pair.waitedMs);
      const onWorkingDay = !days.get(dayKeyBangkok(pair.askedAt))?.off;
      if (inWorkingHours(pair.askedAt)) {
        speedWork[pair.by].push(pair.waitedMs);
        // ตัวเลขที่ใช้ตัดสินผลงานทีมจริง ๆ คือชุดนี้: เวลาทำการ ในวันที่ทีมทำงาน
        if (onWorkingDay) speedWorkDays[pair.by].push(pair.waitedMs);
      }
    }
    const kind = classifyRoom(messages);
    byClass[kind].rooms += 1;
    if (roomIsClosed(customer)) byClass[kind].closed += 1;

    const last = messages[messages.length - 1];
    if (last && last.direction === "in") {
      const waitedMs = nowMs - Number(last.created_at);
      if (isSilentByDesign(last)) { skipped.hashtag += 1; continue; }
      if (waitedMs > BACKLOG_MAX_AGE_MS) { skipped.stale += 1; continue; }
      if (isQuietNotQualified(customer, last.created_at, qualifyHoldOf)) { skipped.notQualified += 1; continue; }
      backlog.push({
        customerId: customer.line_user_id ?? room.customerId ?? "",
        channelId: customer.channel_id || "default",
        aiEnabled: customer.ai_enabled === 1,
        offReason: customer.ai_off_reason || "",
        waitedMs,
      });
    }
  }

  backlog.sort((a, b) => b.waitedMs - a.waitedMs);
  const buckets = [
    { key: "under30m", label: "ไม่เกิน 30 นาที", maxMs: 30 * 60_000, rooms: 0 },
    { key: "under2h", label: "30 นาที – 2 ชม.", maxMs: 2 * 3_600_000, rooms: 0 },
    { key: "under8h", label: "2 – 8 ชม.", maxMs: 8 * 3_600_000, rooms: 0 },
    { key: "over8h", label: "เกิน 8 ชม.", maxMs: Infinity, rooms: 0 },
  ];
  for (const item of backlog) {
    (buckets.find((bucket) => item.waitedMs <= bucket.maxMs) ?? buckets[buckets.length - 1]).rooms += 1;
  }

  const rate = (entry) => (entry.rooms ? Math.round((entry.closed / entry.rooms) * 1000) / 10 : null);
  return {
    speed: {
      all: { ai: stats(speedAll.ai), human: stats(speedAll.human) },
      workingHours: { ai: stats(speedWork.ai), human: stats(speedWork.human) },
      workingDays: { ai: stats(speedWorkDays.ai), human: stats(speedWorkDays.human) },
    },
    days: {
      counted: [...days.values()].filter((day) => !day.off).length,
      excluded: [...days.values()].filter((day) => day.off)
        .map(({ key, reason }) => ({ key, reason })).sort((a, b) => b.key.localeCompare(a.key)),
    },
    backlog: {
      total: backlog.length,
      // โชว์สิ่งที่ตัดออกเสมอ ไม่ซ่อน — ตัวเลขที่อธิบายที่มาไม่ได้คือตัวเลขที่ไม่มีใครเชื่อ
      excluded: {
        hashtagRooms: skipped.hashtag, endedRooms: skipped.stale, notQualifiedRooms: skipped.notQualified,
        maxAgeHours: BACKLOG_MAX_AGE_MS / 3_600_000,
      },
      buckets: buckets.map(({ key, label, rooms }) => ({ key, label, rooms })),
      waitingForHuman: backlog.filter((item) => !item.aiEnabled).length,
      top: backlog.slice(0, 10),
    },
    closing: {
      // พี่ง้วงเคาะ: โชว์ % เฉพาะสองกลุ่มนี้ ห้ามเอาห้องคนล้วนมาเทียบ %
      hybrid: { ...byClass.hybrid, ratePct: rate(byClass.hybrid) },
      fullyAi: { ...byClass.ai, ratePct: rate(byClass.ai) },
      humanOnlyRooms: byClass.human.rooms,
      humanOnlyClosed: byClass.human.closed,
      noReplyRooms: byClass.none.rooms,
    },
    totals: { rooms: rooms.length, inboundTurns },
  };
}
