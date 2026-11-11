// ownerChatLookups.mjs — รันคิวรีที่ผ่านตัวตรวจแล้ว + จัดรูปผลเป็นข้อความสั้นให้ลูกแพรตอบพี่ง้วง (28 ก.ย. 2026)
//
// ทุกฟังก์ชันอ่านอย่างเดียว (คิวรีอยู่ใน dbOwnerChatLookups.mjs) · ตัวเลขทุกตัวในผลมาจาก DB ตรง ๆ
// กติกาความเป็นส่วนตัวเดียวกับข้อมูลสด (Telegram ไม่ใช่ช่องเข้ารหัส): ชื่อปิดเหลือ 3 ตัวอักษร · ไม่มี id
// ในข้อความ (ลิงก์ห้องระบบแนบเองหลังคำตอบ — ownerChatLinks.mjs) · ข้อความลูกค้าตัดสั้นและซ่อนเบอร์/อีเมล/ลิงก์/เลขยาว
// ทุกผลขึ้นหัวด้วย "ช่วงเวลา/ตัวกรองที่ใช้จริง" (รวมที่ตัวตรวจตัดขอบ) ให้ลูกแพรบอกพี่ง้วงได้ตรง
// ผลแต่ละก้อนมีเพดานตัวอักษร รวมทุกก้อนไม่เกิน LOOKUP_RESULTS_MAX_CHARS — อยู่ส่วนที่ไม่ถูกแคชของพรอมต์
import { resolveCustomer } from "./customerResolver.mjs";
import { aiOffReasonText, bangkokIsoDate, channelLabel, formatBangkokTime, maskName } from "./yoloText.mjs";
import { needsPersonReason, personReasonLabel } from "./needsPersonReason.mjs";
import { attentionValue } from "./consoleAttentionApi.mjs";
import { summarizeUsage } from "./modelPricing.mjs";
import { mentionContextLines } from "./ownerChatMentions.mjs";
import { readWaitingRooms } from "./ownerChatSnapshot.mjs";
import { clampText, durationText, scrubCustomerText, thaiNumber, truncateAtGrapheme } from "./ownerChatText.mjs";
import { runLineUsageLookup } from "./lineUsage.mjs";
import { samePersonResolution } from "./identityLink.mjs";
import { bangkokMonthKey, previousMonthKey } from "./lineUsageReport.mjs";

export const LOOKUP_RESULT_MAX_CHARS = 1_800;
export const LOOKUP_RESULTS_MAX_CHARS = 5_000;
const DAY_MS = 86_400_000;
const BKK_OFFSET_MS = 7 * 3_600_000;
const DAY_LINES_MAX = 31;
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const THAI_DAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const CHANNEL_TEXT = { all: "ทุกช่องทาง", LINE: "LINE", FB: "Facebook" };
const channelArg = (value) => (value === "LINE" || value === "FB" ? value : "");
const HANDOFF_LINE = /\[([^\]]{10,40})\]\s*([a-z][a-z0-9_]*)/giu;

export const DEAL_STATUS_THAI = Object.freeze({
  new: "เพิ่งเริ่มคุย", collecting_info: "กำลังเก็บข้อมูล", class_recommended: "แนะนำคลาสแล้ว",
  details_sent: "ส่งรายละเอียดแล้ว", price_sent: "แจ้งราคาแล้ว", awaiting_round_choice: "รอเลือกรอบ",
  awaiting_team_decision: "รอทีมตัดสินใจ", quote_sent: "ส่งใบเสนอราคาแล้ว", awaiting_payment: "รอชำระเงิน",
  not_ready: "ยังไม่พร้อม", waiting_next_round: "รอรอบถัดไป", paid_confirmed: "ชำระแล้ว (ยืนยัน)",
  prep_sent: "ส่งข้อมูลเตรียมเรียนแล้ว",
});
const REASON_EXTRA = Object.freeze({ brain_knowledge_unavailable: "ความรู้ที่อนุมัติยังใช้ตอบไม่ได้" });
const reasonText = (code) => REASON_EXTRA[code] || (personReasonLabel(code) !== personReasonLabel("") ? personReasonLabel(code) : aiOffReasonText(code));

// หัวข้อที่ลูกค้าถาม (นับด้วยคำชัด ๆ — ข้อความหนึ่งเข้าได้หลายหัวข้อ)
const TOPICS = [
  ["ราคา/ค่าเรียน/โปร", /ราคา|เท่าไหร่|เท่าไร|ค่าเรียน|ค่าคอร์ส|กี่บาท|ส่วนลด|โปรโมชั่น|early ?bird|ผ่อน/iu],
  ["รอบเรียน/วันเวลา", /รอบ|วันไหน|วันที่|เปิดสอน|เปิดรับ|เสาร์|อาทิตย์|ตารางเรียน|กี่โมง|เวลาเรียน|เรียนวัน/iu],
  ["เรียนออนไลน์/ดูย้อนหลัง", /ออนไลน์|online|zoom|ซูม|ย้อนหลัง/iu],
  ["สถานที่/การเดินทาง/ที่จอดรถ", /ที่ไหน|สถานที่|จอดรถ|ที่จอด|เดินทาง|แผนที่|bts|mrt/iu],
  ["เนื้อหาคลาส/เหมาะกับใคร", /สอนอะไร|เนื้อหา|หลักสูตร|เรียนอะไร|ได้อะไร|workflow|agent|พื้นฐาน|มือใหม่|ไม่เคยใช้|เหมาะ/iu],
  ["สมัคร/จอง/ชำระเงิน", /สมัคร|จอง|ชำระ|โอน|สลิป|บัญชี|พร้อมเพย์/iu],
  ["อบรมองค์กร/in-house", /in-?house|อินเฮาส์|องค์กร|พนักงาน|จัดอบรม/iu],
  ["ใบเสร็จ/ใบกำกับภาษี", /ใบเสร็จ|ใบกำกับ|ภาษี|หัก ?ณ ?ที่จ่าย|invoice/iu],
  ["คลาสฟรี", /คลาสฟรี|ฟรี|free/iu],
];

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function isoStartMs(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return Date.UTC(y, m - 1, d) - BKK_OFFSET_MS;
}

function dayIso(dayIndex) {
  return new Date(Number(dayIndex) * DAY_MS).toISOString().slice(0, 10);
}

function thaiDay(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return `${THAI_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${THAI_MONTHS[m - 1]}`;
}

function clock(ms) {
  const date = new Date(Number(ms) + BKK_OFFSET_MS);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function rangeText(from, to, nowMs) {
  const today = bangkokIsoDate(nowMs);
  const label = from === to ? thaiDay(from) : `${thaiDay(from)} – ${thaiDay(to)}`;
  return `${label} ${to.slice(0, 4)}${to === today ? ` (วันนี้นับถึง ${clock(nowMs)} น.)` : ""}`;
}

// "N วันล่าสุด" = วันนี้กับ N-1 วันก่อนหน้าแบบเต็มวันตามเวลาไทย — ช่วงที่ค้นจริงตรงกับที่เขียนบอกในผลทุกตัวอักษร
// (เดิมนับย้อน N×24 ชม. จากตอนนี้ ข้อความครึ่งวันแรกของวันก่อนช่วงที่ป้ายบอกหลุดเข้ามาด้วย)
const windowStartMs = (days, nowMs) => isoStartMs(bangkokIsoDate(nowMs - (days - 1) * DAY_MS));
const windowText = (days, nowMs) => `${days} วันล่าสุด (${thaiDay(bangkokIsoDate(nowMs - (days - 1) * DAY_MS))} – ${thaiDay(bangkokIsoDate(nowMs))})`;
const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "-");
const label = (row) => String(row?.known_name || row?.display_name || "").trim() || "ลูกค้า";
const roomRef = (row) => ({ id: String(row.line_user_id), mask: maskName(label(row), 3), channel: channelLabel(row.channel_id) });

/* --------------------------------- activity --------------------------------- */

function countHandoffs(rows, startMs, endMs) {
  const counts = new Map();
  for (const row of rows) {
    for (const match of String(row.handoff_summary || "").matchAll(HANDOFF_LINE)) {
      const at = Date.parse(match[1]);
      if (!Number.isFinite(at) || at < startMs || at >= endMs) continue;
      counts.set(match[2], (counts.get(match[2]) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function activity(db, { from, to, channel, byDay }, nowMs) {
  const ch = channelArg(channel);
  const startMs = isoStartMs(from);
  const endMs = Math.min(isoStartMs(to) + DAY_MS, nowMs + 1);
  const totals = db.lookupActivityTotals({ startMs, endMs, channel: ch });
  const firsts = db.lookupFirstTimeByDay({ startMs, endMs, channel: ch });
  const firstTotal = firsts.reduce((sum, row) => sum + Number(row.n || 0), 0);
  const firstFb = firsts.reduce((sum, row) => sum + Number(row.fb || 0), 0);
  const handoffs = countHandoffs(db.lookupHandoffSummaries({ channel: ch, sinceMs: startMs }), startMs, endMs);
  const lines = [
    `【สถิติแชท】${rangeText(from, to, nowMs)} · ${CHANNEL_TEXT[channel] || CHANNEL_TEXT.all}`,
    `รวมทั้งช่วง: ลูกค้าทัก ${thaiNumber(totals.in_rooms)} ห้อง (${thaiNumber(totals.in_messages)} ข้อความ${ch ? "" : ` · LINE ${thaiNumber(totals.in_rooms_line)} / FB ${thaiNumber(totals.in_rooms_fb)} ห้อง`})`
      + ` · ลูกค้าใหม่ (ทักครั้งแรก) ${thaiNumber(firstTotal)} คน${ch ? "" : ` (LINE ${thaiNumber(firstTotal - firstFb)} / FB ${thaiNumber(firstFb)})`}`
      + ` · ลูกแพรตอบ ${thaiNumber(totals.ai_rooms)} ห้อง · ทีมตอบเอง ${thaiNumber(totals.human_rooms)} ห้อง · ลูกแพรทักตาม/YOLO ${thaiNumber(totals.followup_rooms)} ห้อง`,
    handoffs.length
      ? `ส่งต่อทีม (นับจากบันทึกส่งต่อที่ยังเก็บอยู่): ${handoffs.slice(0, 8).map(([code, n]) => `${reasonText(code)} ${thaiNumber(n)}`).join(" · ")}`
      : "ส่งต่อทีม: ไม่มีบันทึกส่งต่อในช่วงนี้",
  ];
  if (byDay) {
    const byDayRows = new Map(db.lookupActivityByDay({ startMs, endMs, channel: ch }).map((row) => [dayIso(row.day), row]));
    const firstByDay = new Map(firsts.map((row) => [dayIso(row.day), Number(row.n || 0)]));
    const days = [];
    for (let at = isoStartMs(from); at < endMs; at += DAY_MS) days.push(bangkokIsoDate(at));
    const shown = days.slice(-DAY_LINES_MAX);
    lines.push(`รายวัน${shown.length < days.length ? ` (${DAY_LINES_MAX} วันล่าสุดของช่วง)` : ""}:`);
    for (const iso of shown) {
      const row = byDayRows.get(iso) || {};
      lines.push(`· ${thaiDay(iso)}: ทัก ${thaiNumber(row.in_rooms)} ห้อง/${thaiNumber(row.in_messages)} ข้อความ · ใหม่ ${thaiNumber(firstByDay.get(iso))}`
        + ` · ลูกแพรตอบ ${thaiNumber(row.ai_rooms)} · ทีม ${thaiNumber(row.human_rooms)} · ทักตาม ${thaiNumber(row.followup_rooms)}`);
    }
  }
  return { lines, rooms: [] };
}

/* ------------------------------ topics / search ------------------------------ */

function snippetAround(content, keyword, width = 36) {
  const text = String(content || "").replace(/\s+/gu, " ").trim();
  const at = keyword ? text.toLowerCase().indexOf(String(keyword).toLowerCase()) : -1;
  if (at < 0) return clampText(text, width * 2);
  const start = Math.max(0, at - width);
  const part = text.slice(start, at + keyword.length + width);
  return `${start > 0 ? "…" : ""}${part}${at + keyword.length + width < text.length ? "…" : ""}`;
}

function customerSnippet(db, row, keyword, nowMs) {
  const customer = safe(() => db.getCustomer(row.customer_id), null) || {};
  const text = scrubCustomerText(snippetAround(row.content, keyword), { names: [customer.known_name, customer.display_name], label: label(customer) });
  return `${maskName(label(customer), 3)} (${channelLabel(row.channel_id)}, ${formatBangkokTime(row.created_at, nowMs)}): "${text}"`;
}

function topics(db, { days, channel }, nowMs) {
  const rows = db.lookupCustomerTexts({ sinceMs: windowStartMs(days, nowMs), channel: channelArg(channel) });
  const rooms = new Set(rows.map((row) => row.customer_id));
  const counted = TOPICS.map(([name, pattern]) => {
    const hits = rows.filter((row) => pattern.test(String(row.content || "")));
    return { name, messages: hits.length, rooms: new Set(hits.map((row) => row.customer_id)).size, sample: hits[0] || null };
  }).filter((topic) => topic.messages > 0).sort((a, b) => b.rooms - a.rooms || b.messages - a.messages);
  const unmatched = rows.filter((row) => !TOPICS.some(([, pattern]) => pattern.test(String(row.content || "")))).length;
  const lines = [
    `【ลูกค้าถามเรื่องอะไร】${windowText(days, nowMs)} · ${CHANNEL_TEXT[channel] || CHANNEL_TEXT.all}`,
    `ข้อความตัวอักษรจากลูกค้า ${thaiNumber(rows.length)} ข้อความ จาก ${thaiNumber(rooms.size)} ห้อง${rows.length >= 20_000 ? " (นับถึงเพดาน 20,000 ข้อความล่าสุด)" : ""} · ข้อความหนึ่งเข้าได้หลายหัวข้อ`,
    ...counted.map((topic, index) => `· ${topic.name}: ${thaiNumber(topic.rooms)} ห้อง (${thaiNumber(topic.messages)} ข้อความ)`
      + (index < 4 && topic.sample ? ` — ตัวอย่าง ${customerSnippet(db, topic.sample, "", nowMs)}` : "")),
    `· ไม่เข้าหัวข้อไหน (ทักทาย/ตอบสั้น/เรื่องอื่น): ${thaiNumber(unmatched)} ข้อความ`,
  ];
  return { lines, rooms: [] };
}

function search(db, { keyword, days, channel }, nowMs) {
  const found = db.lookupMessageSearch({ keyword, sinceMs: windowStartMs(days, nowMs), channel: channelArg(channel), samples: 5 });
  const lines = [
    `【ค้นคำ "${keyword}" ในข้อความลูกค้า】${windowText(days, nowMs)} · ${CHANNEL_TEXT[channel] || CHANNEL_TEXT.all}`,
    `พบ ${thaiNumber(found.messages)} ข้อความ จาก ${thaiNumber(found.rooms)} ห้อง${found.rows.length ? " — ล่าสุด:" : ""}`,
    ...found.rows.map((row) => `· ${customerSnippet(db, row, keyword, nowMs)}`),
  ];
  const rooms = found.rows.map((row) => safe(() => db.getCustomer(row.customer_id), null)).filter(Boolean).map(roomRef);
  return { lines, rooms };
}

/* ---------------------------------- leads ---------------------------------- */

function leadLine(row, nowMs) {
  const score = Number(row.last_score);
  const when = formatBangkokTime(row.last_at, nowMs);
  const by = row.last_agent_mode === "ai" ? "ลูกแพร" : String(row.last_agent_mode || "").startsWith("operator") ? "ทีม" : "ฝั่งเรา";
  const last = row.last_dir === "in" ? `ลูกค้าพิมพ์ ${when} (ยังไม่มีใครตอบ)` : `${by}ตอบ ${when} (ลูกค้ายังไม่ตอบกลับ)`;
  const deal = row.deal_status && row.deal_status !== "new" ? ` · ${DEAL_STATUS_THAI[row.deal_status] || row.deal_status}` : "";
  return `· ${maskName(label(row), 3)} (${channelLabel(row.channel_id)}) — ${score}/10 ${score >= 8 ? "สนใจสูง" : score >= 5 ? "กำลังพิจารณา" : "เพิ่งเริ่มคุย"}${deal}`
    + `${attentionValue(row) === "money" ? " · มีเรื่องเงิน" : ""} — AI ${Number(row.ai_enabled) === 1 ? "เปิด" : `ปิด (${aiOffReasonText(row.ai_off_reason)})`}`
    + ` — ล่าสุด: ${last}${Number(row.human_touched) === 1 ? "" : " — ทีมยังไม่เคยทัก"}`;
}

function leads(db, args, nowMs) {
  const found = db.lookupLeads({
    minScore: args.minScore, maxScore: args.maxScore, sinceMs: windowStartMs(args.activeDays, nowMs), channel: channelArg(args.channel),
    dealStatus: args.dealStatus === "any" ? "" : args.dealStatus, waitingReply: args.waitingReply, noTeamContact: args.noTeamContact,
    aiState: args.aiState, sort: args.sort, limit: args.limit,
  });
  const filters = [
    `คะแนน ${args.minScore}–${args.maxScore}`, `คุยใน ${args.activeDays} วัน`, CHANNEL_TEXT[args.channel] || CHANNEL_TEXT.all,
    ...(args.dealStatus !== "any" ? [`สถานะดีล ${DEAL_STATUS_THAI[args.dealStatus] || args.dealStatus}`] : []),
    ...(args.waitingReply ? ["ลูกค้าพิมพ์ล่าสุดและยังไม่มีใครตอบ"] : []),
    ...(args.noTeamContact ? ["ทีมยังไม่เคยทัก"] : []),
    ...(args.aiState !== "any" ? [`AI ${args.aiState === "on" ? "เปิด" : "ปิด"}`] : []),
  ];
  const lines = [
    `【รายชื่อลีด】${filters.join(" · ")} · เรียงตาม${args.sort === "recent" ? "ความใหม่" : args.sort === "waiting" ? "รอนานสุด" : "คะแนน"}`,
    `เข้าเงื่อนไข ${thaiNumber(found.total)} ห้อง${found.total > found.rows.length ? ` (แสดง ${found.rows.length})` : ""}`,
    ...found.rows.map((row) => leadLine(row, nowMs)),
  ];
  return { lines, rooms: found.rows.map(roomRef) };
}

/* ----------------------------------- room ----------------------------------- */

function room(db, config, { name }, nowMs) {
  // 28 ก.ย. 2026: ชื่อตรงหลายห้องแต่เป็นคนเดียวกันที่เชื่อม Facebook ↔ LINE แล้ว = ห้องเดียว (ห้องที่คุยล่าสุด
  // + บรรทัด "ช่องทางอื่นของลูกค้าคนเดียวกัน") และแนบลิงก์ทุกห้องของคนนั้น
  const resolution = samePersonResolution(db, resolveCustomer(db, { query: name }));
  if (resolution.status === "unique") {
    const mention = { status: "unique", query: resolution.query, room: resolution.matches[0], loose: resolution.loose === true };
    const lines = mentionContextLines({ db, config, mentions: [mention], nowMs }).slice(1);
    const ids = resolution.samePerson ? [mention.room.id, ...resolution.linkedIds.filter((id) => id !== mention.room.id)] : [mention.room.id];
    const rows = ids.map((id) => safe(() => db.getCustomer(id), null)).filter(Boolean);
    return { lines: [`【ห้องลูกค้า "${name}"】`, ...lines], rooms: rows.map(roomRef) };
  }
  if (resolution.status === "ambiguous") {
    const rows = resolution.matches.map((match) => safe(() => db.getCustomer(match.id), null)).filter(Boolean);
    return {
      lines: [`【ห้องลูกค้า "${name}"】ชื่อนี้ตรงกับ ${resolution.total || rows.length} ห้อง — ให้ถามพี่ง้วงก่อนว่าหมายถึงห้องไหน:`,
        ...resolution.matches.map((match, index) => `  ${index + 1}) ${maskName(match.label, 3)} · ${channelLabel(match.channelId)} · คุยล่าสุด ${formatBangkokTime(match.lastMessageAt, nowMs)}`)],
      rooms: rows.map(roomRef),
    };
  }
  const near = (resolution.suggestions || []).map((match) => `${maskName(match.label, 3)} (${channelLabel(match.channelId)})`);
  return { lines: [`【ห้องลูกค้า "${name}"】ไม่พบห้องชื่อนี้${near.length ? ` — ชื่อใกล้เคียง: ${near.join(", ")}` : ""}`], rooms: [] };
}

/* ------------------------------ funnel / followups ------------------------------ */

function funnel(db, { days, channel }, nowMs) {
  const { counts, deals, orders } = db.lookupFunnel({ sinceMs: windowStartMs(days, nowMs), channel: channelArg(channel) });
  const active = Number(counts.active) || 0;
  // 28 ก.ย. 2026: ห้อง Facebook + LINE ที่เชื่อมเป็นคนเดียวกัน = 1 คน 2 ห้อง — บอกจำนวนคนเมื่อไม่เท่าจำนวนห้อง
  const people = (rooms, persons) => (Number(persons) > 0 && Number(persons) < Number(rooms)
    ? ` (${thaiNumber(persons)} คน — บางคนมีทั้งห้อง Facebook และ LINE)` : "");
  const dealLine = deals.filter((row) => row.status && row.status !== "new").slice(0, 8)
    .map((row) => `${DEAL_STATUS_THAI[row.status] || row.status} ${thaiNumber(row.n)}`);
  return {
    lines: [
      `【ภาพรวมการขาย】ห้องที่ลูกค้าทักใน ${windowText(days, nowMs)} · ${CHANNEL_TEXT[channel] || CHANNEL_TEXT.all}`,
      `ห้องที่คุย ${thaiNumber(active)}${people(active, counts.active_people)} · ได้รับราคาครั้งแรกในช่วงนี้ ${thaiNumber(counts.price_quoted)} · แตะเรื่องเงิน/ส่งช่องทางชำระในช่วงนี้ ${thaiNumber(counts.money_seen)}`
        + ` · ตอนนี้ปิด AI เพราะส่งเลขบัญชีแล้ว (รอทีมดูแลเงิน) ${thaiNumber(counts.bank_sent_ai_off)} · ติดธงรอคน ${thaiNumber(counts.needs_human)}`,
      `ติดป้าย "ลูกค้า" (ชำระ/ลงเรียนแล้ว): ${thaiNumber(counts.customer_tagged)} ห้อง${people(counts.customer_tagged, counts.customer_tagged_people)} (ติดป้ายในช่วงนี้ ${thaiNumber(counts.customer_tagged_new)})`,
      dealLine.length ? `สถานะดีล (เฉพาะที่ไม่ใช่ "เพิ่งเริ่มคุย"): ${dealLine.join(" · ")}` : "สถานะดีล: ทุกห้องยังเป็น \"เพิ่งเริ่มคุย\" (ระบบเลื่อนสถานะดีลอาจยังไม่เปิด)",
      `ออเดอร์ในช่วงนี้: สร้าง ${thaiNumber(orders.created)} · ยืนยัน ${thaiNumber(orders.confirmed)} · จ่ายแล้ว ${thaiNumber(orders.paid)} (฿${thaiNumber(Math.round(Number(orders.revenue) || 0))})`,
      "(ไม่มีเลขบัญชีหรือยอดโอนรายคนในผลนี้โดยเจตนา)",
    ],
    rooms: [],
  };
}

function followups(db, { days, channel, replyHours }, nowMs) {
  const r = db.lookupFollowups({ sinceMs: windowStartMs(days, nowMs), channel: channelArg(channel), replyMs: replyHours * 3_600_000 });
  const band = (name, total, replied) => `${name} ${thaiNumber(replied)}/${thaiNumber(total)} (${pct(replied, total)})`;
  return {
    lines: [
      `【ผลการทักตาม】${windowText(days, nowMs)} · ${CHANNEL_TEXT[channel] || CHANNEL_TEXT.all} · นับว่า "ตอบกลับ" เมื่อลูกค้าพิมพ์มาภายใน ${replyHours} ชม. หลังข้อความทักตาม`,
      `ลูกแพรทักตาม ${thaiNumber(r.rooms)} ห้อง (${thaiNumber(r.bubbles)} ข้อความ) · ลูกค้าตอบกลับ ${thaiNumber(r.replied_rooms)} ห้อง (${pct(Number(r.replied_rooms) || 0, Number(r.rooms) || 0)})`,
      `แยกช่องทาง (ตอบกลับ/ทักตาม): ${band("LINE", r.line_rooms, r.line_replied_rooms)} · ${band("FB", r.fb_rooms, r.fb_replied_rooms)}`,
      `แยกตามคะแนนปัจจุบันของห้อง: ${band("สนใจสูง", r.hot_rooms, r.hot_replied_rooms)} · ${band("กำลังพิจารณา", r.warm_rooms, r.warm_replied_rooms)} · ${band("เพิ่งเริ่มคุย", r.cold_rooms, r.cold_replied_rooms)}`,
      `ในนี้เป็น YOLO ที่พี่ง้วงสั่ง ${thaiNumber(r.yolo_rooms)} ห้อง (ตอบกลับ ${thaiNumber(r.yolo_replied_rooms)})`,
    ],
    rooms: [],
  };
}

/* ---------------------------------- waiting ---------------------------------- */

function waiting(db, { freshHours, limit }, nowMs) {
  const result = readWaitingRooms(db, nowMs, { limit, freshMs: freshHours * 3_600_000, allReasons: true });
  const lines = [
    `【ห้องรอคำตอบ】ลูกค้าพิมพ์คนสุดท้ายแล้วยังไม่มีใครตอบ (30 วันล่าสุด): ${thaiNumber(result.total)} ห้อง`
      + ` · รอไม่เกิน ${freshHours} ชม. ${thaiNumber(result.fresh)} · ค้างนานกว่านั้น ${thaiNumber(result.total - result.fresh)}`,
    result.reasons.length ? `แยกตามเหตุ: ${result.reasons.map(([reason, n]) => `${reason} ${thaiNumber(n)}`).join(" · ")}` : "",
    ...result.rooms.map((room) => `· ${room.name} (${room.channel}) — รอ ${durationText(room.waitMs)} — ${room.reason}${room.preview ? ` — ล่าสุด: "${room.preview}"` : ""}`),
  ].filter(Boolean);
  return { lines, rooms: result.rooms.map((room) => ({ id: room.id, mask: room.name, channel: room.channel })) };
}

/* ---------------------------------- aiCost ---------------------------------- */

function usageJob(row) {
  const kind = String(row.kind || "");
  const mine = Number(row.unattributed) === 1;
  if (kind === "draft") return mine ? "แชทเจ้าของ (Telegram)" : "ตอบลูกค้า";
  if (kind === "score") return mine ? "แชทเจ้าของ: อ่านคำสั่ง/วางแผนค้น" : "ให้คะแนนลูกค้า";
  if (kind === "followup") return "ทักตาม/YOLO";
  if (kind === "staged_followup") return "ทักตามตามสเตจ";
  if (kind === "learning") return "สรุปเรียนรู้รายวัน";
  if (kind === "qualify") return "คัดกรองลูกค้า"; // ตัวกวาดรายชั่วโมง (5 ต.ค. 2026)
  return kind || "อื่น ๆ";
}

function aiCost(db, { from, to, byDay }, nowMs, { pricing, thbPerUsd }) {
  const sinceMs = isoStartMs(from);
  const untilMs = Math.min(isoStartMs(to) + DAY_MS, nowMs + 1);
  const rows = db.lookupUsageRows({ sinceMs, untilMs });
  const cost = (subset) => summarizeUsage(subset, pricing);
  const total = cost(rows);
  const groupBy = (keyOf) => {
    const groups = new Map();
    for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) || []), row]);
    return [...groups.entries()].map(([key, subset]) => [key, cost(subset).usd]).sort((a, b) => b[1] - a[1]);
  };
  const baht = (usd) => `฿${(usd * thbPerUsd).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const lines = [
    `【ค่า AI】${rangeText(from, to, nowMs)} · อัตรา ${thbPerUsd} บาท/ดอลลาร์ (อัตราเดียวกับคอนโซล)`,
    `รวม ${baht(total.usd)} (≈ $${total.usd.toFixed(2)})`,
    `แยกตามงาน: ${groupBy(usageJob).map(([job, usd]) => `${job} ${baht(usd)}`).join(" · ") || "-"}`,
    `แยกตามโมเดล: ${groupBy((row) => row.model || "?").map(([model, usd]) => `${model} ${baht(usd)}`).join(" · ") || "-"}`,
  ];
  if (byDay) {
    const days = groupBy((row) => dayIso(row.day)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-DAY_LINES_MAX);
    lines.push("รายวัน:", ...days.map(([iso, usd]) => `· ${thaiDay(iso)}: ${baht(usd)}`));
  }
  if (total.unknownTokens > 0) {
    lines.push(`(ยังไม่รวม ${thaiNumber(total.unknownTokens)} โทเคนที่ราคายังไม่ยืนยัน — โมเดลที่ไม่มีในไฟล์ราคา หรือครั้งที่เขียนแคชกับโมเดลที่ยังไม่มีราคาเขียนแคช · ยอดจริงสูงกว่านี้)`);
  }
  if (total.unknownCacheWriteCalls > 0) lines.push(`(${thaiNumber(total.unknownCacheWriteCalls)} ครั้งไม่มีข้อมูลการเขียนแคช — ต้นทุนส่วนนั้นอาจสูงกว่าที่คิดไว้)`);
  // ตัวเลขหน้าคอนโซล (รวมทั้งช่วงเป็นก้อนเดียว) — ถ้าไม่ตรงกันบอกไว้ พี่ง้วงจะได้ไม่งงว่าทำไมสองที่ไม่เท่ากัน
  const consoleUsd = safe(() => summarizeUsage(db.llmUsageSummary(sinceMs, null, untilMs), pricing).usd, null);
  if (consoleUsd != null && Math.abs(consoleUsd - total.usd) > Math.max(0.01, total.usd * 0.01)) {
    lines.push(`(หน้าภาพรวมในคอนโซลคิดรวมทั้งช่วงเป็นก้อนเดียวจึงแสดง ${baht(consoleUsd)} — ยอดข้างบนคิดแยกทีละวัน/งาน `
      + "ก้อนที่ปนการเขียนแคชที่ยังไม่มีราคาจึงไม่ลากค่าเรียกปกติทั้งก้อนหายไปด้วย)");
  }
  return { lines, rooms: [] };
}

/* ----------------------------------- run ----------------------------------- */

const RUNNERS = {
  activity: (ctx, args) => activity(ctx.db, args, ctx.nowMs),
  topics: (ctx, args) => topics(ctx.db, args, ctx.nowMs),
  search: (ctx, args) => search(ctx.db, args, ctx.nowMs),
  leads: (ctx, args) => leads(ctx.db, args, ctx.nowMs),
  room: (ctx, args) => room(ctx.db, ctx.config, args, ctx.nowMs),
  funnel: (ctx, args) => funnel(ctx.db, args, ctx.nowMs),
  followups: (ctx, args) => followups(ctx.db, args, ctx.nowMs),
  waiting: (ctx, args) => waiting(ctx.db, args, ctx.nowMs),
  aiCost: (ctx, args) => aiCost(ctx.db, args, ctx.nowMs, ctx),
  // 28 ก.ย. 2026: โควตา LINE เดือนนี้/เดือนก่อน แยกที่มา (ไม่มีชื่อลูกค้าในผลเลย · ราคาเฉพาะที่เจ้าของกรอกเอง)
  lineUsage: (ctx, args) => {
    const thisMonth = bangkokMonthKey(ctx.nowMs);
    const monthKey = args.month === "last" ? previousMonthKey(thisMonth) : thisMonth;
    return { lines: runLineUsageLookup({ db: ctx.db, nowMs: ctx.nowMs, monthKey, byDay: args.byDay === true }), rooms: [] };
  },
};

/**
 * รันคิวรีที่ผ่านตัวตรวจแล้ว — คิวรีไหนพังขึ้นว่า "ค้นไม่สำเร็จ" ก้อนอื่นไปต่อ (มี log)
 * @returns {{text: string, rooms: Array<{id: string, mask: string, channel: string}>, ran: string[]}}
 */
export function runOwnerLookups({ db, config = {}, queries = [], nowMs = Date.now(), pricing = new Map(), thbPerUsd = 36, logger = console } = {}) {
  const blocks = [];
  const rooms = [];
  const ran = [];
  let used = 0;
  for (const query of queries) {
    const runner = RUNNERS[query.name];
    if (!runner) continue;
    let result;
    try {
      result = runner({ db, config, nowMs, pricing, thbPerUsd }, query.args);
    } catch (err) {
      logger.warn?.(`ownerChatLookups: ค้น ${query.name} ไม่สำเร็จ (${err?.message || err})`);
      result = { lines: [`【${query.name}】ค้นไม่สำเร็จรอบนี้ (ระบบขัดข้อง) — บอกพี่ง้วงตรง ๆ ว่ายังค้นเรื่องนี้ไม่ได้`], rooms: [] };
    }
    const notes = query.notes?.length ? [`(ตัวกรองที่ใช้จริง: ${query.notes.join(" · ")})`] : [];
    const block = truncateAtGrapheme([...result.lines, ...notes].join("\n"), LOOKUP_RESULT_MAX_CHARS);
    if (used + block.length > LOOKUP_RESULTS_MAX_CHARS) break;
    used += block.length + 2;
    blocks.push(block);
    rooms.push(...result.rooms);
    ran.push(query.name);
  }
  return { text: blocks.join("\n\n"), rooms, ran };
}
