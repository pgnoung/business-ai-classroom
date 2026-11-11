// ownerChatSnapshot.mjs — "ข้อมูลสด" ที่ลูกแพรเห็นทุกครั้งที่พี่ง้วงทักมาทาง Telegram (28 ก.ย. 2026)
//
// หลักคิด: ลูกแพรในแชทนี้พูดตัวเลขกับเจ้าของได้เฉพาะที่อยู่ในก้อนนี้ (+ ความรู้/ตารางราคาที่อนุมัติ)
// ทุกตัวเลขอ่านสดจาก DB ตอนพี่ง้วงพิมพ์ ไม่มีแคช ไม่มีตัวเลขจากโมเดล
//   รอบ/ที่นั่ง  — currentUpcomingRounds ตัวเดียวกับเส้นตอบลูกค้า = หน้า "ที่นั่ง" (คำสั่งพี่ง้วง 28 ก.ย.:
//                 "ใส่ตรงที่นั่งเมนูอย่างเดียว และลูกแพรเอาตรงนั้นไปใช้") + จำนวนคนลงจริงต่อรอบสำหรับเจ้าของ
//   วันนี้       — นับเป็นห้อง (ไม่ใช่บอลลูน) ตัดต้นวันเวลาไทย ไม่นับ canary (dbOwnerChat.mjs)
//   รอคำตอบ     — ผู้สมัครชุดเดียวกับการ์ด "เงินรั่ว" หน้าภาพรวม (dbAttention + summarizeWaiting) + เหตุ
//   ลีดร้อน      — คะแนนสูงสุดที่ยังคุยใน 7 วัน · การกระทำล่าสุด = audit ของ YOLO/Telegram ใน 24 ชม.
// ชื่อลูกค้าปิดบางส่วนเสมอ (Telegram ไม่ใช่ช่องเข้ารหัส — กติกาเดียวกับ telegramReplies.mjs)
// งบ: ก้อนนี้อยู่ส่วนที่เปลี่ยนทุกข้อความของพรอมต์ (ไม่ถูกแคช) จึงคุมไม่เกิน OWNER_SNAPSHOT_MAX_CHARS
// อ่านส่วนไหนพัง = ส่วนนั้นบอกว่าอ่านไม่ได้ ส่วนอื่นไปต่อ (แชทกับเจ้าของห้ามล้มเพราะคิวรีเดียว)
import { thaiShortDate } from "./classRounds.mjs";
import { currentUpcomingRounds } from "./roundsSource.mjs";
import { aiPausedNow } from "./aiPause.mjs";
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import { ATTENTION_GRACE_MS, attentionPreview, attentionValue, summarizeWaiting } from "./consoleAttentionApi.mjs";
import { RECENT_WINDOW_MS } from "./lineOaContext.mjs";
import { BACKLOG_MAX_AGE_MS } from "./kpi.mjs";
import { needsPersonReason, personReasonLabel } from "./needsPersonReason.mjs";
import { yoloReasonText } from "./yoloPolicy.mjs";
import { aiOffReasonText, bangkokIsoDate, bangkokNowLabel, channelLabel, formatBangkokTime, maskName } from "./yoloText.mjs";
import { clampText, durationText, scrubCustomerText, thaiNumber, truncateAtGrapheme } from "./ownerChatText.mjs";
import { lessonDigestMode } from "./telegramLessonDigest.mjs";

export const OWNER_SNAPSHOT_MAX_CHARS = 4500;
const DAY_MS = 86_400_000;
const HOT_LEAD_WINDOW_MS = 7 * DAY_MS;
const ACTION_WINDOW_MS = DAY_MS;
const THAI_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
// จำนวนรายการต่อหัวข้อ — ถ้ารวมแล้วยาวเกินงบ ถอยลงทีละขั้น (ขั้นสุดท้ายยังมีทุกหัวข้อ)
const LIST_SIZES = [
  { rounds: 10, waiting: 5, hot: 5, actions: 5 },
  { rounds: 8, waiting: 3, hot: 3, actions: 3 },
  { rounds: 6, waiting: 2, hot: 2, actions: 2 },
];
const VALUE_TEXT = Object.freeze({ money: "มีเรื่องเงิน (ส่งบัญชี/รอโอน)", hot: "ลูกค้าสนใจสูง", warm: "ลูกค้ากำลังพิจารณา" });

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

const roomLabel = (row) => String(row?.known_name || row?.display_name || "").trim() || "ลูกค้า";
const roomTag = (row) => `${maskName(roomLabel(row), 3)} (${channelLabel(row?.channel_id)})`;

function weekdayOf(isoDate) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  return THAI_WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/* ------------------------------------ รอบเรียน ------------------------------------ */

function roundStatus(round) {
  if (round.today) return "เรียนวันนี้ (ปิดรับสมัครแล้ว)";
  const status = String(round.fileStatus ?? "open");
  if (status === "closed") return "ปิดรับสมัครแล้ว";
  if (status === "full" || round.seatsLeft === 0) return "เต็มแล้ว";
  if (status === "almost_full") return "ใกล้เต็ม";
  return "เปิดรับสมัคร";
}

function roundSeats(round) {
  const taken = round.enrolled;
  if (round.unlimited) return `ออนไลน์ ไม่จำกัดที่นั่ง ${taken === null ? "(ยังไม่กรอกจำนวนคนลง)" : `ลงทะเบียน ${thaiNumber(taken)} คน`}`;
  if (taken === null) return `ความจุ ${thaiNumber(round.capacity)} ที่ (ยังไม่กรอกจำนวนคนลง)`;
  const base = `ลงทะเบียน ${thaiNumber(taken)}/${thaiNumber(round.capacity)} คน`;
  if (round.overbooked > 0) return `${base} (เกินความจุ ${thaiNumber(round.overbooked)})`;
  return round.today || round.seatsLeft === 0 ? base : `${base} เหลือ ${thaiNumber(round.seatsLeft)} ที่`;
}

function readRounds({ db, config, nowMs, logger, bundle }) {
  if (!config?.classRoundsFile) return null; // ธุรกิจที่ไม่มีรอบเรียน = ไม่มีหัวข้อนี้เลย
  const todayIso = bangkokIsoDate(nowMs);
  // ส่ง "เมื่อวาน" เข้าไปเพื่อให้ได้รอบของวันนี้ด้วย (ลูกค้าสมัครไม่ทันแล้ว แต่เจ้าของต้องรู้ว่าวันนี้มีคลาส)
  // bundle = สมองรุ่นที่ลูกค้าได้อยู่ตอนนี้ (ตัวเดียวกับ pipeline.currentRoundsRules) · ไม่มี = หน้าที่นั่งตรง ๆ
  const rounds = currentUpcomingRounds({ db, config, bundle, todayIso: bangkokIsoDate(nowMs - DAY_MS), logger });
  return rounds.map((round) => ({ ...round, today: round.date === todayIso }));
}

function roundsSection(rounds, max) {
  if (!rounds) return [];
  if (!rounds.length) return ["รอบเรียน: ยังไม่มีรอบเรียนที่ประกาศในหน้า \"ที่นั่ง\" (กับลูกค้า ลูกแพรไม่เดาวันเรียนเอง)"];
  const shown = rounds.slice(0, max);
  const lines = ["รอบเรียน (หน้า \"ที่นั่ง\" ของทีม — ชุดเดียวกับที่ลูกแพรใช้ตอบลูกค้า):"];
  for (const round of shown) {
    lines.push(`· ${weekdayOf(round.date)} ${thaiShortDate(round.date)} — ${round.label} — ${roundStatus(round)} — ${roundSeats(round)}`);
  }
  if (rounds.length > shown.length) lines.push(`· (ยังมีรอบถัดไปอีก ${rounds.length - shown.length} รอบในหน้าที่นั่ง)`);
  const notes = [];
  if (shown.some((round) => !round.today && (round.seatsLeft === 0 || ["full", "closed"].includes(round.fileStatus)))) {
    notes.push("รอบเต็ม/ปิด ลูกแพรเสนอรอบถัดไปแทน");
  }
  if (shown.some((round) => round.unlimited)) notes.push("รอบออนไลน์ไม่บอกจำนวนที่นั่ง ใช้คำว่า \"ราคาพิเศษมีจำนวนจำกัด\"");
  if (notes.length) lines.push(`(กับลูกค้า: ${notes.join(" · ")})`);
  return lines;
}

/* ------------------------------------ วันนี้ ------------------------------------ */

function bangkokClock(ms) {
  const date = new Date(Number(ms) + 7 * 3_600_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function todaySection(today, nowMs) {
  if (!today) return ["วันนี้: อ่านตัวเลขกิจกรรมไม่สำเร็จ"];
  const until = bangkokClock(nowMs);
  return [
    `วันนี้ (00:00–${until} น.): ลูกค้าทักเข้ามา ${thaiNumber(today.inboundRooms)} ห้อง (${thaiNumber(today.inboundMessages)} ข้อความ)`
      + ` · ทักครั้งแรก ${thaiNumber(today.firstTimeRooms)} ห้อง · ลูกแพรตอบ ${thaiNumber(today.aiRooms)} ห้อง`
      + ` · ทีมตอบเอง ${thaiNumber(today.humanRooms)} ห้อง · ลูกแพรทักตาม/YOLO ${thaiNumber(today.proactiveRooms)} ห้อง`,
  ];
}

/* ---------------------------------- รอคำตอบ ---------------------------------- */

function waitingReason(row, nowMs) {
  if (!row) return "";
  const person = needsPersonReason(row);
  if (person) return personReasonLabel(person);
  if (row.state === "NEEDS_HUMAN") return "ติดธงรอคนดูแล";
  if (Number(row.ai_enabled) !== 1) return `AI ปิด — ${aiOffReasonText(row.ai_off_reason)}`;
  if (Number(row.operator_active_until || 0) > nowMs) return "ทีมกำลังคุยอยู่ (AI พัก)";
  return "AI เปิดอยู่แต่ยังไม่มีคำตอบ";
}

// ห้องที่เพิ่งรอ (≤ 48 ชม. — เกณฑ์เดียวกับ backlog ของ KPI) ขึ้นก่อน: ของจริงมีห้องที่ค้างธงมาเป็นเดือน
// (ตรวจสำเนา 28 ก.ย.: 53 ห้องใน 30 วัน ห้าอันดับแรกของการ์ดหน้าภาพรวมรอ 24–28 วันทั้งหมด) ถ้าเรียงแบบ
// การ์ดอย่างเดียว คำถาม "วันนี้เป็นไงบ้าง" จะได้แต่เรื่องเก่า — ห้องค้างนานยังนับในยอดรวมและเติมท้ายรายการ
// ใช้ร่วมกับคิวรี "waiting" ของแชทเจ้าของ (ownerChatLookups.mjs) — allReasons = นับเหตุของทุกห้องที่รอ
export function readWaitingRooms(db, nowMs, { limit = LIST_SIZES[0].waiting, freshMs = BACKLOG_MAX_AGE_MS, allReasons = false } = {}) {
  const rows = db.attentionWaitingCandidates({ sinceMs: nowMs - RECENT_WINDOW_MS, beforeMs: nowMs - ATTENTION_GRACE_MS });
  const all = summarizeWaiting(rows, { now: nowMs, limit, channelLabel });
  const fresh = summarizeWaiting(rows.filter((row) => Number(row.last_in_at) >= nowMs - freshMs), { now: nowMs, limit, channelLabel });
  const freshIds = new Set(fresh.rooms.map((room) => room.id));
  const ranked = [...fresh.rooms, ...all.rooms.filter((room) => !freshIds.has(room.id))].slice(0, limit);
  const byId = new Map(rows.map((row) => [String(row.line_user_id), row]));
  const reasonOf = (id) => waitingReason(safe(() => db.getCustomer(id), null) || byId.get(id) || null, nowMs);
  const reasons = new Map();
  if (allReasons) {
    for (const row of rows) {
      const reason = reasonOf(String(row.line_user_id)) || "ไม่ทราบเหตุ";
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
  }
  return {
    total: all.total,
    fresh: fresh.total,
    reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]),
    rooms: ranked.map((room) => {
      const row = safe(() => db.getCustomer(room.id), null) || byId.get(room.id) || {};
      const source = byId.get(room.id) || {};
      const preview = attentionPreview(source.last_in_type, source.last_in_text);
      return {
        id: room.id, name: maskName(roomLabel(row), 3), channel: channelLabel(row.channel_id), waitMs: room.waitMs,
        value: attentionValue(row), reason: waitingReason(row, nowMs),
        preview: scrubCustomerText(preview, { names: [row.known_name, row.display_name], label: roomLabel(row) }),
      };
    }),
  };
}

function waitingSection(waiting, max) {
  if (!waiting) return ["ลูกค้ารอคำตอบ: อ่านไม่สำเร็จ"];
  if (!waiting.total) return ["ลูกค้ารอคำตอบ: ไม่มีห้องที่ลูกค้าพิมพ์คนสุดท้ายแล้วยังไม่มีใครตอบ (30 วันล่าสุด)"];
  const lines = [`ลูกค้ารอคำตอบ (ลูกค้าพิมพ์คนสุดท้าย ยังไม่มีใครตอบ · 30 วันล่าสุด): ${thaiNumber(waiting.total)} ห้อง`
    + ` · ในนี้เพิ่งรอไม่เกิน 48 ชม. ${thaiNumber(waiting.fresh)} ห้อง — รายการ: ห้องที่เพิ่งรอขึ้นก่อน (เรื่องเงิน/ร้อนก่อน) แล้วตามด้วยห้องค้างนาน`];
  for (const room of waiting.rooms.slice(0, max)) {
    lines.push(`· ${room.name} (${room.channel}) — รอ ${durationText(room.waitMs)} — ${room.reason}`
      + `${room.preview ? ` — ล่าสุด: "${room.preview}"` : ""}${VALUE_TEXT[room.value] ? ` — [${VALUE_TEXT[room.value]}]` : ""}`);
  }
  if (waiting.total > Math.min(max, waiting.rooms.length)) lines.push(`· …และอีก ${thaiNumber(waiting.total - Math.min(max, waiting.rooms.length))} ห้อง (ดูในคอนโซลหน้าภาพรวม)`);
  return lines;
}

/* ---------------------------------- ลีดร้อน ---------------------------------- */

function readHotLeads(db, nowMs) {
  return db.ownerChatHotLeads({ sinceMs: nowMs - HOT_LEAD_WINDOW_MS, limit: LIST_SIZES[0].hot }).map((row) => ({
    id: String(row.line_user_id), name: maskName(roomLabel(row), 3), channel: channelLabel(row.channel_id), score: Number(row.last_score),
    money: attentionValue(row) === "money", aiOn: Number(row.ai_enabled) === 1, aiOffReason: String(row.ai_off_reason || ""),
    lastAt: Number(row.last_at) || 0, lastDir: String(row.last_dir || ""),
    lastBy: row.last_agent_mode === "ai" ? "ลูกแพร" : String(row.last_agent_mode || "").startsWith("operator") ? "ทีม" : "ฝั่งเรา",
    humanTouched: Number(row.human_touched) === 1,
  }));
}

function hotSection(leads, max, nowMs) {
  if (!leads) return ["ลีดคะแนนสูง: อ่านไม่สำเร็จ"];
  if (!leads.length) return ["ลีดคะแนนสูง (คุยใน 7 วัน): ยังไม่มีห้องที่คะแนนความสนใจ 5 ขึ้นไป"];
  const lines = ["ลีดคะแนนสูงที่คุยใน 7 วัน (คะแนนความสนใจ 0–10 จากตัวอ่านแชท · 8+ ร้อน · 5–7 อุ่น):"];
  for (const lead of leads.slice(0, max)) {
    const when = formatBangkokTime(lead.lastAt, nowMs);
    const last = lead.lastDir === "in" ? `ลูกค้าพิมพ์ ${when} (รอฝั่งเราตอบ)` : `${lead.lastBy}ตอบ ${when} (ลูกค้ายังไม่ตอบกลับ)`;
    lines.push(`· ${lead.name} (${lead.channel}) — ${lead.score}/10 ${lead.score >= 8 ? "สนใจสูง" : "กำลังพิจารณา"}`
      + `${lead.money ? " · มีเรื่องเงิน (ส่งบัญชี/รอโอน)" : ""} — AI ${lead.aiOn ? "เปิด" : `ปิด (${aiOffReasonText(lead.aiOffReason)})`}`
      + ` — ล่าสุด: ${last}${lead.humanTouched ? "" : " — ทีมยังไม่เคยทัก"}`);
  }
  return lines;
}

/* ------------------------------- การกระทำล่าสุด ------------------------------- */

function actionText(row, customer) {
  const tag = customer ? roomTag(customer) : "ห้องที่ถูกลบไปแล้ว";
  const detail = String(row.detail || "");
  const via = String(row.operator || "").startsWith("telegram:") || detail.startsWith("telegram") ? "สั่งทาง Telegram" : "สั่งจากคอนโซล";
  const topic = /"([^"]{1,80})"/u.exec(detail)?.[1];
  const about = topic ? ` · เรื่อง "${scrubCustomerText(topic, { names: [customer?.known_name, customer?.display_name], label: roomLabel(customer) })}"` : "";
  if (row.action === "yolo_sent") return `YOLO ส่งแล้ว → ${tag}${about} · ${via}`;
  if (row.action === "yolo_partial") return `YOLO ส่งได้บางส่วน → ${tag}${about} · ${via}`;
  if (row.action === "yolo_refused") {
    const code = detail.split(" · ")[1] || "";
    return `YOLO ไม่ได้ส่ง → ${tag} (${clampText(yoloReasonText(code) || code, 60)}) · ${via}`;
  }
  if (row.action === "ai_toggle") return `${detail.startsWith("on") ? "เปิด" : "ปิด"} AI → ${tag} · ${via}`;
  return `บันทึกบทเรียน "${clampText(detail, 60)}" · ${via}`;
}

function readActions(db, nowMs) {
  return db.ownerChatRecentActions({ sinceMs: nowMs - ACTION_WINDOW_MS, limit: LIST_SIZES[0].actions }).map((row) => {
    const customer = row.action.startsWith("lesson_") ? null : safe(() => db.getCustomer(row.target), null);
    return { at: Number(row.created_at) || 0, text: actionText(row, customer),
      ...(customer ? { room: { id: String(customer.line_user_id), mask: maskName(roomLabel(customer), 3), channel: channelLabel(customer.channel_id) } } : {}) };
  });
}

function actionsSection(actions, max, nowMs) {
  if (!actions?.length) return [];
  return ["สิ่งที่สั่งผ่าน Telegram/YOLO ใน 24 ชม. (ใหม่สุดก่อน):",
    ...actions.slice(0, max).map((action) => `· ${formatBangkokTime(action.at, nowMs)} — ${action.text}`)];
}

function lessonsLine(pending, db) {
  if (pending == null) return "";
  if (!pending) return "บทเรียนที่ทีมสอนรอพี่ง้วงอนุมัติ: ไม่มี";
  return `บทเรียนที่ทีมสอนรอพี่ง้วงอนุมัติ: ${thaiNumber(pending)} เรื่อง — พี่ง้วงพิมพ์ "บทเรียนรออนุมัติ" ในแชทนี้เพื่อดูและกดอนุมัติ/ไม่ใช้ได้`
    + (lessonDigestMode(db) === "on" ? " (ลูกแพรส่งสรุปให้ทุกคืน 22:00 ด้วย)" : "");
}

/* ------------------------------------ รวม ------------------------------------ */

/**
 * @returns {{facts: object, text: string}} facts = ตัวเลขดิบ (เทสต์เทียบกับ DB) · text = ก้อนที่ส่งเข้าโมเดล
 */
export function buildOwnerSnapshot({ db, config = {}, nowMs = Date.now(), logger = console, bundle = null } = {}) {
  // ส่วนไหนอ่านพัง = ส่วนนั้นบอกว่าอ่านไม่ได้ แต่ต้องมีร่องรอยใน log (ข้อมูลสดที่เงียบหายคือข้อมูลที่โกหก)
  const read = (label, fn, fallback) => {
    try { return fn(); } catch (err) {
      logger.warn?.(`ownerChatSnapshot: อ่าน${label}ไม่สำเร็จ (${err?.message || err}) — ส่วนนี้ขึ้นว่าอ่านไม่ได้`);
      return fallback;
    }
  };
  const today = read("กิจกรรมวันนี้", () => db.ownerChatActivity(bangkokDayStartMs(nowMs)), null);
  const facts = {
    nowLabel: bangkokNowLabel(nowMs),
    paused: safe(() => aiPausedNow({ db, config }), true),
    rounds: read("รอบเรียน", () => readRounds({ db, config, nowMs, logger, bundle }), []),
    today: today && {
      inboundRooms: today.inboundRooms, inboundMessages: today.inboundMessages, firstTimeRooms: today.firstTimeRooms,
      aiRooms: today.aiRooms, humanRooms: today.humanRooms, proactiveRooms: today.proactiveRooms,
    },
    needsHuman: today ? today.needsHuman : null,
    waiting: read("ห้องรอคำตอบ", () => readWaitingRooms(db, nowMs), null),
    hotLeads: read("ลีดคะแนนสูง", () => readHotLeads(db, nowMs), null),
    actions: read("การกระทำล่าสุด", () => readActions(db, nowMs), []),
    // บทเรียนที่ทีมสอนรอพี่ง้วงอนุมัติ (28 ก.ย. เย็น) — จอสอนปิด = ไม่มีเรื่องนี้ในระบบ
    lessonsPending: config.teachEnabled === true ? read("บทเรียนรออนุมัติ", () => Number(db.countOwnerLessons({ viewer: null }).pending) || 0, null) : null,
  };
  const head = [
    `ข้อมูลสดจากระบบ (อ่านตอน ${facts.nowLabel} เวลาไทย) — ตัวเลขในแชทนี้ต้องมาจากตรงนี้ ความรู้ที่อนุมัติ หรือตารางราคาเท่านั้น:`,
    facts.paused
      ? "สถานะ: ⚠️ ลูกแพรถูกหยุดตอบลูกค้าทั้งระบบอยู่ (สวิตช์หยุด AI ในคอนโซล) — ลูกค้าทักมาจะยังไม่มีคำตอบจาก AI"
      : "สถานะ: ลูกแพรตอบลูกค้าตามปกติ (ไม่ได้ถูกหยุดทั้งระบบ)",
  ];
  let text = "";
  for (const size of LIST_SIZES) {
    text = [
      ...head,
      ...roundsSection(facts.rounds, size.rounds),
      ...todaySection(facts.today, nowMs),
      facts.needsHuman == null ? "" : `ห้องที่ติดธงรอคนดูแลตอนนี้: ${thaiNumber(facts.needsHuman)} ห้อง`,
      lessonsLine(facts.lessonsPending, db),
      ...waitingSection(facts.waiting, size.waiting),
      ...hotSection(facts.hotLeads, size.hot, nowMs),
      ...actionsSection(facts.actions, size.actions, nowMs),
    ].filter(Boolean).join("\n");
    if (text.length <= OWNER_SNAPSHOT_MAX_CHARS) break;
  }
  if (text.length > OWNER_SNAPSHOT_MAX_CHARS) text = truncateAtGrapheme(text, OWNER_SNAPSHOT_MAX_CHARS);
  return { facts, text };
}
