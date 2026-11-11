// ownerChatLookupCatalog.mjs — รายการคิวรีที่ลูกแพร "ขอค้น" ได้ในแชทเจ้าของ + ตัวตรวจแผนจากโมเดล (28 ก.ย. 2026)
//
// พี่ง้วงขอ "ลิ้งค์ไวๆ กับสมองลูกแพร เพื่อดูข้อมูล พี่ง้วงสอบถาม วิเคราะห์" — เกตเวย์ไม่รับ tool calling
// (sanitizeChatRequest รับแค่ system/user/assistant) จึงทำสองจังหวะในตัวระบบเอง:
//   1) วางแผน: โมเดลตัวให้คะแนน (luna) เห็นข้อความ + แชทล่าสุด + รายการนี้ แล้วตอบ JSON {"queries":[…]}
//   2) ระบบตรวจแผนแบบไม่เชื่ออะไรเลย (ไฟล์นี้) แล้วรันคิวรีที่อยู่ในรายการเท่านั้น (ownerChatLookups.mjs)
// โมเดลไม่มีทางส่ง SQL/คำสั่งใด ๆ — เลือกได้แค่ "ชื่อคิวรี + ค่าที่ตรวจชนิดและขอบเขตแล้ว" และทุกคิวรีอ่านอย่างเดียว
//
// กติกาตัวตรวจ (ทิ้งทีละชิ้น ไม่ทิ้งทั้งแผน):
//   ชื่อคิวรีไม่รู้จัก = ทิ้งคิวรีนั้น · ชื่ออาร์กิวเมนต์ไม่รู้จัก = ทิ้งอาร์กิวเมนต์นั้น (ใช้ค่าตั้งต้น)
//   ค่าผิดชนิด = ใช้ค่าตั้งต้น · ค่าเกินขอบเขต = ตัดเข้าขอบ (จดไว้ให้ลูกแพรบอกพี่ง้วงว่าใช้ช่วงไหนจริง)
//   อาร์กิวเมนต์บังคับหาย/ใช้ไม่ได้ = ทิ้งคิวรีนั้น · ชื่อลูกค้า (room) ต้องอยู่ในข้อความของพี่ง้วงจริง
//   ไม่เกิน 3 คิวรี · ซ้ำกัน = นับครั้งเดียว · วันที่อยู่ในช่วง 90 วันล่าสุดถึงวันนี้เท่านั้น
import { DEAL_STATUSES } from "./dbLifecycle.mjs";
import { bangkokIsoDate, nameKey } from "./yoloText.mjs";

export const LOOKUP_MAX_QUERIES = 3;
export const LOOKUP_MAX_DAYS = 90;
const DAY_MS = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/u;
const THAI_WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const int = (min, max, fallback) => ({ type: "int", min, max, default: fallback });
const bool = (fallback) => ({ type: "bool", default: fallback });
const oneOf = (values, fallback) => ({ type: "enum", values, default: fallback });
const CHANNEL = oneOf(["all", "LINE", "FB"], "all");

export const LOOKUP_CATALOG = Object.freeze({
  activity: {
    args: { from: { type: "date", required: true }, to: { type: "date", default: "today" }, channel: CHANNEL, byDay: bool(true) },
    doc: "chat totals and per-day counts: customer rooms/messages, first-time customers, rooms answered by AI vs team, AI follow-ups, handoffs by reason. Compare two periods with two activity queries.",
  },
  topics: {
    args: { days: int(1, LOOKUP_MAX_DAYS, 7), channel: CHANNEL },
    doc: "what customers asked about, counted by topic (price, rounds/dates, online, location/parking, class content, booking/payment, in-house, receipts/tax, beginner fit, free class) with a few short samples",
  },
  search: {
    args: { keyword: { type: "text", min: 2, max: 40, required: true }, days: int(1, LOOKUP_MAX_DAYS, 30), channel: CHANNEL },
    doc: "count customer messages containing a keyword (Thai or English, short) plus up to 5 short snippets",
  },
  leads: {
    args: {
      minScore: int(0, 10, 8), maxScore: int(0, 10, 10), activeDays: int(1, LOOKUP_MAX_DAYS, 7), channel: CHANNEL,
      dealStatus: oneOf(["any", ...DEAL_STATUSES], "any"), waitingReply: bool(false), noTeamContact: bool(false),
      aiState: oneOf(["any", "on", "off"], "any"), sort: oneOf(["score", "recent", "waiting"], "score"), limit: int(1, 10, 10),
    },
    doc: "list leads by interest score 0-10 (8+ hot, 5-7 warm); waitingReply = customer spoke last and nobody replied; noTeamContact = no human from the team has messaged them",
  },
  room: {
    args: { name: { type: "text", min: 2, max: 60, required: true, fromOwnerText: true } },
    doc: "one customer's room by the name the boss typed: status, score, summary, last messages",
  },
  funnel: {
    args: { days: int(1, LOOKUP_MAX_DAYS, 30), channel: CHANNEL },
    doc: "sales/payment funnel of rooms active in the window: price sent, payment channel sent, AI off waiting for a money check, customer tags, deal statuses, orders",
  },
  followups: {
    args: { days: int(1, LOOKUP_MAX_DAYS, 14), channel: CHANNEL, replyHours: int(1, 72, 24) },
    doc: "AI follow-ups (automatic + YOLO) sent and how many rooms replied within replyHours, by channel and score band",
  },
  waiting: {
    args: { freshHours: int(1, 168, 48), limit: int(1, 10, 8) },
    doc: "rooms where the customer spoke last and nobody replied (30 days), grouped by reason and age",
  },
  aiCost: {
    args: { from: { type: "date", default: "monthStart" }, to: { type: "date", default: "today" }, byDay: bool(false) },
    doc: "AI spend in Thai baht by job (customer replies, owner chat, scorer, follow-ups) and by model",
  },
  // 28 ก.ย. 2026: "เดือนนี้ LINE ใช้ไปเท่าไหร่ แยกตามอะไร" — อ่านบัญชีการส่ง + สถิติ LINE + ภาพโควตาที่เก็บไว้ (lineUsage.mjs)
  lineUsage: {
    args: { month: oneOf(["this", "last"], "this"), byDay: bool(false) },
    doc: "LINE OA message quota for a month: used/limit and where the counted messages went — team alerts + owner digest pushed by our system, broadcasts from LINE OA Manager (LINE's official stats), messages to customers (AI replies free vs pushed, follow-ups, YOLO, team console sends), free messages, and a baht estimate only if the boss saved his LINE plan price",
  },
});

// ข้อความที่ต้องใช้ข้อมูลถึงจะเรียกตัววางแผน (คุยเล่น/ขอบคุณ/ร่างแคปชั่นไม่ต้องเสียค่าโมเดลและเวลา)
const DATA_CUE = /วันนี้|เมื่อวาน|สัปดาห์|อาทิตย์นี้|อาทิตย์ที่แล้ว|อาทิตย์ก่อน|เดือน|ปีนี้|ช่วงนี้|ย้อนหลัง|ล่าสุด|กี่|เท่าไหร่|เท่าไร|ยอด|สถิติ|ตัวเลข|จำนวน|ค่า\s*ai|ค่าใช้จ่าย|ต้นทุน|ลีด|ลูกค้า|ห้อง|ถาม|ตอบกลับ|ทักตาม|follow|fu\b|จ่าย|โอน|สลิป|ปิดการขาย|ปิดได้|ดีล|ออเดอร์|รายได้|วิเคราะห์|เทียบ|ต่างกัน|เพิ่มขึ้น|ลดลง|แนวโน้ม|trend|ค้น|มีใคร|ใครบ้าง|คนไหน|รอ|ค้าง|ส่งต่อ|คะแนน|ร้อน|อุ่น|เย็น|line|fb|facebook|เฟส|ไลน์|แชท|สรุป|รายงาน|report|ภาพรวม|เคส|โควต|push|พุช|บรอดแคส|broadcast|แพ็กเกจ|package/iu;

// รูปคำสั่งที่เปลี่ยนสถานะ (yolo / เปิด-ปิด AI / สถานะ) — ไม่วางแผนค้นล่วงหน้าคู่กับ mini AI (รีวิวโค้ด 28 ก.ย.:
// ไม่งั้นคำสั่ง "ปิด AI ห้องคุณเอ" เสียค่าโมเดล + โควตาต่อวันให้แผนที่ถูกทิ้งแทบทุกครั้ง) · ถ้า mini AI บอกว่าไม่ใช่คำสั่ง
// ข้อความนั้นยังได้วางแผนค้นตามปกติ (ช้ากว่าเดิม ~2 วิ) — ไม่มีคำถามไหนเสียโอกาสค้น
const COMMAND_SHAPE = /\byolo\b|(?:เปิด|ปิด)\s*(?:ai|เอไอ|บอท)|^\s*(?:สถานะ|status)(?:\s|$)/iu;

export function looksLikeCommand(text) {
  return COMMAND_SHAPE.test(String(text ?? ""));
}

export function needsLookup(text) {
  const value = String(text ?? "").trim();
  return [...value].length >= 4 && /\p{L}/u.test(value) && DATA_CUE.test(value);
}

function argDoc(spec) {
  if (spec.type === "date") return "YYYY-MM-DD";
  if (spec.type === "int") return `${spec.min}-${spec.max}`;
  if (spec.type === "enum") return spec.values.length > 6 ? `one of the deal statuses (${spec.values.slice(0, 4).join("|")}|…)` : spec.values.join("|");
  if (spec.type === "bool") return "true|false";
  return `text ${spec.min}-${spec.max} chars`;
}

/** system ของตัววางแผน — ภาษาอังกฤษเพื่อให้ JSON นิ่ง (แบบเดียวกับ MINI_AI_SYSTEM) · วันที่เวลาไทยเสมอ */
export function lookupPlannerSystem({ nowMs = Date.now() } = {}) {
  const today = bangkokIsoDate(nowMs);
  const oldest = bangkokIsoDate(nowMs - (LOOKUP_MAX_DAYS - 1) * DAY_MS);
  const clock = new Date(nowMs + 7 * 3_600_000);
  const hhmm = `${String(clock.getUTCHours()).padStart(2, "0")}:${String(clock.getUTCMinutes()).padStart(2, "0")}`;
  return [
    "You pick read-only database lookups so ลูกแพร (the AI assistant of a Thai live-AI-class business) can answer her boss พี่ง้วง with real numbers.",
    `Today in Bangkok: ${THAI_WEEKDAYS_EN[clock.getUTCDay()]} ${today}, time ${hhmm}. Allowed dates: ${oldest} to ${today}.`,
    "Reply with ONE JSON object and nothing else: {\"queries\":[{\"name\":\"...\",\"args\":{...}}]}",
    "Rules:",
    `- 0 to ${LOOKUP_MAX_QUERIES} queries. Return {"queries":[]} for small talk, feelings, writing help (captions, scripts), teaching rules, or anything answered by the always-attached live summary: today's totals so far, upcoming rounds and seats, approved prices, top 5 hot leads, top 5 rooms waiting now, last 24h YOLO/Telegram actions.`,
    "- Use only the queries and argument names below; omit an argument to use its default. Dates are YYYY-MM-DD in Bangkok time. \"this week\" = the last 7 days including today unless days are named; \"this month\" = from the 1st of this month.",
    "- Set an optional argument only when the boss's words ask for it (a period, a channel, a score, a reply window); otherwise omit it — never invent a filter or window he did not mention.",
    "- room.name must be copied exactly from the boss's message; never invent or complete a customer name.",
    "Queries (name {args}: purpose):",
    ...Object.entries(LOOKUP_CATALOG).map(([name, entry]) => `${name} {${Object.entries(entry.args)
      .map(([arg, spec]) => `${arg}: ${argDoc(spec)}${spec.required ? " (required)" : ""}`).join(", ")}}: ${entry.doc}`),
  ].join("\n");
}

/** ข้อความที่ตัววางแผนเห็น: แชทล่าสุดย่อ ๆ + ข้อความใหม่ (ไม่มีข้อมูลลูกค้าจาก DB เลย) */
export function lookupPlannerTranscript({ text = "", history = [] } = {}) {
  const recent = (Array.isArray(history) ? history : []).slice(-4)
    .map((turn) => `${turn.role === "user" ? "พี่ง้วง" : "ลูกแพร"}: ${[...String(turn.content || "").replace(/\s+/gu, " ")].slice(0, 300).join("")}`);
  return [
    ...(recent.length ? ["แชทล่าสุด (เก่า→ใหม่):", ...recent, "---"] : []),
    `ข้อความใหม่ของพี่ง้วง: ${[...String(text || "")].slice(0, 1_000).join("")}`,
  ].join("\n");
}

function firstJsonObject(raw) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function realIso(value) {
  if (!ISO.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}

const compact = (value) => nameKey(value).replace(/ /gu, "");

// ค่าหนึ่งช่อง → { ok, value, note } · ok:false = ใช้ไม่ได้ (ผู้เรียกใช้ค่าตั้งต้น/ทิ้งคิวรีถ้าบังคับ)
function checkArg(spec, raw, { today, oldest, monthStart, ownerText }) {
  const fallback = spec.default === "today" ? today : spec.default === "monthStart" ? monthStart : spec.default;
  if (raw === undefined || raw === null || raw === "") return { ok: spec.default !== undefined, value: fallback, missing: true };
  if (spec.type === "date") {
    const value = String(raw).trim();
    if (!realIso(value)) return { ok: false };
    if (value > today) return { ok: true, value: today, note: `ขอวันที่ ${value} (อนาคต) — ใช้วันนี้แทน` };
    if (value < oldest) return { ok: true, value: oldest, note: `ขอย้อนถึง ${value} — ค้นได้ไม่เกิน ${LOOKUP_MAX_DAYS} วัน จึงเริ่มที่ ${oldest}` };
    return { ok: true, value };
  }
  if (spec.type === "int") {
    const number = typeof raw === "number" ? raw : /^\s*-?\d+\s*$/u.test(String(raw)) ? Number(raw) : NaN;
    if (!Number.isFinite(number)) return { ok: false };
    const value = Math.min(spec.max, Math.max(spec.min, Math.trunc(number)));
    return { ok: true, value, ...(value !== Math.trunc(number) ? { note: `ขอ ${Math.trunc(number)} — ใช้ ${value} (ขอบเขต ${spec.min}–${spec.max})` } : {}) };
  }
  if (spec.type === "bool") {
    if (raw === true || raw === "true") return { ok: true, value: true };
    if (raw === false || raw === "false") return { ok: true, value: false };
    return { ok: false };
  }
  if (spec.type === "enum") {
    const value = spec.values.find((option) => option.toLowerCase() === String(raw).trim().toLowerCase());
    return value ? { ok: true, value } : { ok: false };
  }
  const value = String(raw).replace(/\s+/gu, " ").trim();
  const length = [...value].length;
  if (typeof raw !== "string" || length < spec.min || length > spec.max) return { ok: false };
  // ชื่อลูกค้าที่โมเดลคืนมาต้องอยู่ในข้อความของพี่ง้วงจริง — ไม่งั้นแปลว่าโมเดลแต่งชื่อขึ้นเอง
  if (spec.fromOwnerText && (compact(value).length < 2 || !compact(ownerText).includes(compact(value)))) return { ok: false, fatal: "name_not_in_text" };
  return { ok: true, value };
}

/**
 * ตรวจแผนจากตัววางแผน — ไม่เชื่ออะไรเลย
 * @returns {{queries: Array<{name: string, args: object, notes: string[]}>, dropped: Array<{name: string, reason: string}>}}
 */
export function validateLookupPlan(rawText, { ownerText = "", nowMs = Date.now() } = {}) {
  const parsed = firstJsonObject(rawText);
  const items = Array.isArray(parsed?.queries) ? parsed.queries : [];
  const today = bangkokIsoDate(nowMs);
  const context = {
    today, ownerText,
    oldest: bangkokIsoDate(nowMs - (LOOKUP_MAX_DAYS - 1) * DAY_MS),
    monthStart: `${today.slice(0, 8)}01`,
  };
  const queries = [];
  const dropped = [];
  const seen = new Set();
  for (const item of items.slice(0, 10)) {
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    const entry = Object.hasOwn(LOOKUP_CATALOG, name) ? LOOKUP_CATALOG[name] : null;
    if (!entry) { dropped.push({ name: name.slice(0, 40) || "?", reason: "unknown_query" }); continue; }
    const rawArgs = item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args : {};
    const args = {};
    const notes = [];
    let fatal = "";
    for (const [key, spec] of Object.entries(entry.args)) {
      const checked = checkArg(spec, rawArgs[key], context);
      if (checked.fatal) { fatal = checked.fatal; break; }
      if (!checked.ok) {
        if (spec.required) { fatal = `bad_${key}`; break; }
        args[key] = spec.default === "today" ? today : spec.default === "monthStart" ? context.monthStart : spec.default;
        continue;
      }
      args[key] = checked.value;
      if (checked.note) notes.push(checked.note);
    }
    if (fatal) { dropped.push({ name, reason: fatal }); continue; }
    // ช่วงวันที่กลับหัว = สลับให้ · ช่วงคะแนนกลับหัว = สลับให้
    if (args.from && args.to && args.from > args.to) [args.from, args.to] = [args.to, args.from];
    if (Number.isInteger(args.minScore) && Number.isInteger(args.maxScore) && args.minScore > args.maxScore) {
      [args.minScore, args.maxScore] = [args.maxScore, args.minScore];
    }
    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (queries.length >= LOOKUP_MAX_QUERIES) { dropped.push({ name, reason: "over_limit" }); continue; }
    queries.push({ name, args, notes });
  }
  return { queries, dropped };
}
