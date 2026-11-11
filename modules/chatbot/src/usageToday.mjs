// usageToday.mjs — ตัวเลขรวมของหน้า "Usage วันนี้" (8 พ.ย. 2026 พี่ง้วง "ทำ dashboard ใน lukprae console ก็ได้ครับ
// พี่ง้วงเห็นคนเดียว ... ไม่กระทบกับ performance ของ ระบบตอบแชทนะครับ")
//
// สัญญาของไฟล์นี้:
//   · อ่านอย่างเดียว (SELECT ล้วน) ผ่าน db.raw — ไม่เขียน settings/audit/ข้อความ ไม่เรียกโมเดล
//   · ผลมีแต่จำนวนนับ เงิน ชื่อรุ่น และรหัสกติกา — ไม่มีชื่อ ข้อความ หรือรหัสลูกค้า
//   · ทุกคิวรีเป็นช่วงเวลาวันนี้/เมื่อวานบน index เวลา (idx_messages_time, idx_llm_usage_time, idx_audit_time)
//     customers นับด้วยคิวรีเดียวต่อช่วง (ตารางราวหมื่นแถว) — ทั้งก้อนใช้เวลาระดับมิลลิวินาที ผู้เรียกแคชซ้ำอีกชั้น
//   · เงินคิดด้วย costReport ตัวเดียวกับการ์ดค่า AI หน้าภาพรวม ตัวเลขสองหน้าจึงตรงกัน
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import {
  AUDIT_AI_OFF_NOT_QUALIFIED, AUDIT_AI_ON_QUALIFIED, NOT_QUALIFIED_REASON, QUALIFY_AUDIT_OPERATOR, qualifySweepMode,
} from "./notQualified.mjs";

export const USAGE_JOB_LABELS = Object.freeze({
  draft: "ตอบแชท", staged_followup: "ทักตาม", followup: "ทักตาม", score: "ให้คะแนนความสนใจ",
  owner_review: "อ่านท่าทีห้อง", qualify: "คัดกรองเข้าเกณฑ์", offtopic_check: "ตรวจแชทนอกเรื่อง",
});
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const BKK_OFFSET_MS = 7 * HOUR_MS;
const NOT_CANARY = "customer_id NOT LIKE 'canary:%'";
const USAGE_COLUMNS = `model, kind, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
  SUM(COALESCE(cached_in, 0)) AS cached_in, SUM(cache_write_in) AS cache_write_in, (tokens_in > 272000) AS long_context,
  SUM(CASE WHEN cache_write_known = 0 AND tokens_in > 0 THEN 1 ELSE 0 END) AS missing_cache_write_calls`;
const TOP_RULES = 5;

const hourOf = (ms) => Math.floor(((Number(ms) + BKK_OFFSET_MS) % DAY_MS) / HOUR_MS);
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const parseMeta = (text) => {
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

function messageCounts(raw, from, to) {
  const inbound = raw.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT customer_id) AS c FROM messages
    WHERE direction = 'in' AND created_at >= ? AND created_at < ? AND ${NOT_CANARY}`).get(from, to);
  const out = raw.prepare(`SELECT agent_mode AS mode, message_class AS cls, COUNT(*) AS n FROM messages
    WHERE direction = 'out' AND msg_type = 'text' AND created_at >= ? AND created_at < ? AND ${NOT_CANARY}
    GROUP BY 1, 2`).all(from, to);
  const sum = (match) => out.filter(match).reduce((total, row) => total + Number(row.n), 0);
  const fresh = raw.prepare(`SELECT COUNT(*) AS n FROM customers
    WHERE created_at >= ? AND created_at < ? AND line_user_id NOT LIKE 'canary:%'`).get(from, to);
  return {
    customers: Number(inbound?.c) || 0,
    inbound: Number(inbound?.n) || 0,
    newCustomers: Number(fresh?.n) || 0,
    aiReplies: sum((row) => row.mode === "ai" && row.cls === "reactive"),
    followups: sum((row) => row.mode === "ai" && row.cls === "proactive"),
    teamMessages: sum((row) => String(row.mode || "").startsWith("operator")),
  };
}

function hourlyUsageRows(raw, from, to) {
  return raw.prepare(`SELECT CAST(((created_at + ${BKK_OFFSET_MS}) % ${DAY_MS}) / ${HOUR_MS} AS INTEGER) AS hour, ${USAGE_COLUMNS}
    FROM llm_usage WHERE created_at >= ? AND created_at < ? GROUP BY 1, model, kind, (tokens_in > 272000)`).all(from, to);
}

function hourly(raw, { todayStart, nowMs, yesterdayStart }, costThb) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour, inbound: 0, aiReplies: 0, followups: 0, costThb: 0, yesterdayInbound: 0, yesterdayCostThb: 0,
    future: hour > hourOf(nowMs),
  }));
  const rows = raw.prepare(`SELECT direction, agent_mode AS mode, message_class AS cls, msg_type AS type, created_at
    FROM messages WHERE created_at >= ? AND created_at < ? AND ${NOT_CANARY}`).all(yesterdayStart, nowMs + 1);
  for (const row of rows) {
    const slot = hours[hourOf(row.created_at)];
    const isToday = Number(row.created_at) >= todayStart;
    if (row.direction === "in") {
      if (isToday) slot.inbound += 1;
      else slot.yesterdayInbound += 1;
    } else if (isToday && row.type === "text" && row.mode === "ai") {
      if (row.cls === "reactive") slot.aiReplies += 1;
      else if (row.cls === "proactive") slot.followups += 1;
    }
  }
  for (const [from, to, field] of [[todayStart, nowMs + 1, "costThb"], [yesterdayStart, todayStart, "yesterdayCostThb"]]) {
    const byHour = new Map();
    for (const row of hourlyUsageRows(raw, from, to)) {
      if (!byHour.has(row.hour)) byHour.set(row.hour, []);
      byHour.get(row.hour).push(row);
    }
    for (const [hour, group] of byHour) if (hours[hour]) hours[hour][field] = round2(costThb(group));
  }
  return hours;
}

function costByJob(raw, report, thbPerUsd, from, to) {
  const calls = new Map(raw.prepare(`SELECT kind, model, COUNT(*) AS n FROM llm_usage
    WHERE created_at >= ? AND created_at < ? GROUP BY 1, 2`).all(from, to).map((row) => [`${row.kind}|${row.model}`, Number(row.n)]));
  const merged = new Map();
  for (const item of report.breakdown || []) {
    const key = `${item.kind}|${item.model}`;
    const prior = merged.get(key) ?? { kind: item.kind, job: USAGE_JOB_LABELS[item.kind] || item.kind, model: item.model,
      calls: calls.get(key) || 0, costThb: 0, priced: true };
    if (item.usd === null) prior.priced = false;
    else prior.costThb += Number(item.usd) * thbPerUsd;
    merged.set(key, prior);
  }
  return [...merged.values()].map((row) => ({ ...row, costThb: round2(row.costThb) })).sort((a, b) => b.costThb - a.costThb);
}

/** คุณภาพคำตอบวันนี้ จาก metadata ของคำตอบ AI แต่ละข้อความ (replyEngine: calls fallback styleBank styleCard firstDraft) */
export function replyQuality(rows = []) {
  let replies = 0; let rewritten = 0; let fallback = 0; let bankUsed = 0;
  const cards = new Map(); const rules = new Map();
  // บับเบิลของคำตอบเดียวมี replyEngine ชุดเดียวกัน — นับครั้งเดียวต่อ "ข้อความลูกค้าล่าสุดที่คำตอบนี้ตอบ"
  const seen = new Set();
  for (const row of rows) {
    const engine = parseMeta(row.metadata_json).replyEngine || {};
    if (!engine.engine) continue;
    const turn = `${row.customer_id}|${row.answered_at}`;
    if (seen.has(turn)) continue;
    seen.add(turn);
    replies += 1;
    if ((Number(engine.calls) || 1) > 1) rewritten += 1;
    if (engine.fallback) fallback += 1;
    if (Array.isArray(engine.styleBank) && engine.styleBank.length) bankUsed += 1;
    if (engine.styleCard) {
      const card = String(engine.styleCard).split(":")[0];
      cards.set(card, (cards.get(card) || 0) + 1);
    }
    for (const id of [...(engine.firstDraft?.hard || []), ...(engine.firstDraft?.soft || [])]) rules.set(String(id), (rules.get(String(id)) || 0) + 1);
  }
  const card = [...cards.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  return {
    replies, rewritten, firstTry: replies - rewritten, rewriteRate: replies ? rewritten / replies : 0, fallback, bankUsed, card,
    topRules: [...rules.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_RULES).map(([id, n]) => ({ id, n })),
  };
}

function qualifyToday(raw, db, { todayStart, nowMs, report, thbPerUsd, model, dailyCapThb }) {
  const audit = (action) => Number(raw.prepare(`SELECT COUNT(*) AS n FROM admin_audit
    WHERE created_at >= ? AND operator = ? AND action = ?`).get(todayStart, QUALIFY_AUDIT_OPERATOR, action)?.n) || 0;
  const yellowNow = Number(raw.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ai_enabled = 0 AND ai_off_reason = ?`)
    .get(NOT_QUALIFIED_REASON)?.n) || 0;
  const checked = Number(raw.prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE created_at >= ? AND kind = 'qualify'`)
    .get(todayStart)?.n) || 0;
  const costThb = (report.breakdown || []).filter((row) => row.kind === "qualify" && row.usd !== null)
    .reduce((total, row) => total + Number(row.usd) * thbPerUsd, 0);
  return {
    mode: qualifySweepMode(db), model, checked, closedToday: audit(AUDIT_AI_OFF_NOT_QUALIFIED),
    reopenedToday: audit(AUDIT_AI_ON_QUALIFIED), yellowNow, costThb: round2(costThb), dailyCapThb,
    nextRoundAt: (Math.floor(nowMs / HOUR_MS) + 1) * HOUR_MS,
  };
}

function lastModelOf(raw, kind) {
  return String(raw.prepare("SELECT model FROM llm_usage WHERE kind = ? ORDER BY created_at DESC LIMIT 1").get(kind)?.model || "");
}

function roles(raw, models, jobs, qualifyModel) {
  const of = (kinds) => jobs.filter((row) => kinds.includes(row.kind))
    .reduce((acc, row) => ({ calls: acc.calls + row.calls, costThb: round2(acc.costThb + row.costThb) }), { calls: 0, costThb: 0 });
  return [
    { id: "reply", job: "ตอบแชท", model: models.replyModel || lastModelOf(raw, "draft"), how: "ตั้งในระบบ", ...of(["draft"]) },
    { id: "followup", job: "ทักตาม", model: models.followupModel || lastModelOf(raw, "staged_followup"), how: "ตั้งในระบบ",
      ...of(["staged_followup", "followup"]) },
    { id: "score", job: "ให้คะแนนความสนใจ", model: models.scorerModel || lastModelOf(raw, "score"), how: "ตั้งในระบบ", ...of(["score"]) },
    { id: "owner_review", job: "อ่านท่าทีห้อง", model: lastModelOf(raw, "owner_review"), how: "ตายตัวในโค้ด", ...of(["owner_review"]) },
    { id: "qualify", job: "คัดกรองเข้าเกณฑ์", model: qualifyModel, how: "ตายตัวในโค้ด · ทุกชั่วโมง", ...of(["qualify"]) },
    { id: "check", job: "ตรวจคำตอบก่อนส่ง", model: "กติกาในโค้ด", how: "ผิดกติกา = เขียนใหม่ 1 ครั้ง", calls: 0, costThb: 0 },
  ];
}

/**
 * ก้อนข้อมูลทั้งหน้า (ไม่รวมสถานะกุญแจ ซึ่งผู้เรียกอ่านจากเกตเวย์เอง)
 * @param {{db: any, nowMs: number, costReport: Function, thbPerUsd: number, models?: object, qualifyModel?: string, qualifyDailyCapThb?: number}} input
 */
export function buildUsageToday({ db, nowMs, costReport, thbPerUsd, models = {}, qualifyModel = "", qualifyDailyCapThb = 0 }) {
  const raw = db.raw;
  const todayStart = bangkokDayStartMs(nowMs);
  const yesterdayStart = bangkokDayStartMs(todayStart - 1);
  const sameTimeYesterday = yesterdayStart + (nowMs - todayStart);
  const thb = (rows) => Number(costReport(rows, thbPerUsd)?.thb) || 0;
  const todayReport = costReport(db.llmUsageSummary(todayStart, null, nowMs + 1), thbPerUsd);
  const day = (from, to, costThb) => ({ ...messageCounts(raw, from, to), costThb: round2(costThb) });
  const jobs = costByJob(raw, todayReport, thbPerUsd, todayStart, nowMs + 1);
  const qualityRows = raw.prepare(`SELECT customer_id, metadata_json,
      (SELECT MAX(i.created_at) FROM messages i WHERE i.customer_id = m.customer_id AND i.direction = 'in' AND i.created_at <= m.created_at) AS answered_at
    FROM messages m WHERE direction = 'out' AND agent_mode = 'ai'
    AND message_class = 'reactive' AND msg_type = 'text' AND created_at >= ? AND ${NOT_CANARY}`).all(todayStart);
  return {
    asOf: nowMs, dayStart: todayStart, thbPerUsd,
    today: day(todayStart, nowMs + 1, todayReport.thb),
    yesterdaySameTime: day(yesterdayStart, sameTimeYesterday, thb(db.llmUsageSummary(yesterdayStart, null, sameTimeYesterday))),
    yesterday: day(yesterdayStart, todayStart, thb(db.llmUsageSummary(yesterdayStart, null, todayStart))),
    unpricedTokens: Number(todayReport.unknownTokens) || 0,
    hourly: hourly(raw, { todayStart, nowMs, yesterdayStart }, thb),
    costByJob: jobs,
    roles: roles(raw, models, jobs, qualifyModel),
    quality: replyQuality(qualityRows),
    qualify: qualifyToday(raw, db, { todayStart, nowMs, report: todayReport, thbPerUsd, model: qualifyModel, dailyCapThb: qualifyDailyCapThb }),
  };
}
