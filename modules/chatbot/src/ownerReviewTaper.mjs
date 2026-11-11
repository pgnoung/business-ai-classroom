// ownerReviewTaper.mjs — ลดจำนวนห้องที่ต้องตรวจตามที่ลูกแพรเก่งขึ้น (คำสั่งพี่ง้วง 12 ต.ค. 2026: "สัปดาห์แรกตรวจทุกแชท
//                       ผ่าน 7 วันค่อยลดลงตามที่ลูกแพรเรียนรู้") — pure ทั้งไฟล์ (ไม่มีฐาน ไม่มีนาฬิกา ไม่มี I/O)
//
// ระดับ (level):
//   0 = ทุกห้องเข้าคิว (วันที่ 1–7 นับจาก owner_review_started_day เสมอ)
//   1 = ห้องน่าห่วง + สุ่ม 20% ของห้องที่เหลือ
//   2 = ห้องน่าห่วง + สุ่ม 10%
// ห้องน่าห่วง (flagged) = AI ให้คะแนน ≥ flagRisk หรือเจอรหัสร้ายแรง (ราคาผิด ข้อมูลผิด สัญญาเกินจริง ไม่ส่งต่อทีม)
// สุ่ม = hmac(dayKey, customerId) — ได้ผลเดิมทุกครั้ง (ทำซ้ำได้) และไม่ขึ้นกับคะแนนของ AI (ไม่ลำเอียง)
//   ระดับ 0 ก็สุ่มชุดเดียวกัน (20%) เพื่อวัดผล: ห้องที่ถูกสุ่มต้องตรวจทีละห้อง ไม่รวมใน "ดีที่เหลือทั้งหมด"
// เลื่อนระดับ: ทีละขั้น ไม่เกินหนึ่งขั้นต่อ 7 วัน เมื่อ 7 วันล่าสุด ตรงกับ AI ≥ 90% จากป้าย ≥ 150 ป้าย และพลาดในชุดสุ่ม ≤ 5%
// ลดระดับ: ทันที (กลับระดับ 0) เมื่อพลาดในชุดสุ่ม > 10% · เจ้าของปักระดับเองได้ (pin) ชนะทุกกติกา
// ป้ายจาก "ดีที่เหลือทั้งหมด" (bulk) ไม่นับในตัวเลขความแม่น — คนไม่ได้อ่านทีละห้อง จะทำให้ AI ดูเก่งเกินจริง
// นโยบายอยู่ใน setting owner_review_taper_policy (JSON) — อ่านพัง/ค่าแปลก = ค่าตั้งต้นทีละช่อง (ด้านปลอดภัย = ตรวจมากขึ้น)
import { createHmac } from "node:crypto";

export const OWNER_REVIEW_TAPER_POLICY_KEY = "owner_review_taper_policy";
export const OWNER_REVIEW_TAPER_STATE_KEY = "owner_review_taper_state";
export const OWNER_REVIEW_STARTED_DAY_KEY = "owner_review_started_day";
export const OWNER_REVIEW_LEVELS = Object.freeze([0, 1, 2]);
export const OWNER_REVIEW_LEVEL_LABELS = Object.freeze({
  0: "ตรวจทุกห้อง",
  1: "ห้องน่าห่วง + สุ่ม 20%",
  2: "ห้องน่าห่วง + สุ่ม 10%",
});
// รหัสร้ายแรง = น่าห่วงเสมอไม่ว่าคะแนนเท่าไร (ค่าตั้งต้น — นโยบายเปลี่ยนได้แต่ต้องเป็นรหัสในรายการปิด)
export const OWNER_REVIEW_HIGH_SEVERITY_CODES = Object.freeze(["wrong_price", "wrong_fact", "promise_risk", "missed_handoff"]);
// กุญแจของการสุ่ม — ค่าคงที่ในโค้ด (ต้องการแค่ "ทำซ้ำได้และไม่ขึ้นกับ AI" ไม่ได้ต้องการความลับ · ไม่มี env ใหม่)
const SAMPLE_KEY = "lukprae-owner-review-sample-v1";
const DAY_MS = 24 * 60 * 60_000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/u;

export const OWNER_REVIEW_TAPER_DEFAULTS = Object.freeze({
  flagRisk: 60,
  highSeverityCodes: OWNER_REVIEW_HIGH_SEVERITY_CODES,
  // สัดส่วนสุ่มต่อระดับ (ระดับ 0 สุ่มไว้วัดผลเท่านั้น — ทุกห้องเข้าคิวอยู่แล้ว)
  sampleRates: Object.freeze([0.2, 0.2, 0.1]),
  warmupDays: 7,
  promote: Object.freeze({ minAgreement: 0.9, minLabels: 150, maxMissRate: 0.05, minSampleLabels: 30, minDaysBetween: 7 }),
  demote: Object.freeze({ maxMissRate: 0.1, minSampleLabels: 10 }),
  pin: null,
});

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const numberIn = (value, min, max, fallback) => (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback);
const intIn = (value, min, max, fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);

/**
 * อ่านนโยบาย (pure) — raw = สตริง JSON จาก settings (หรือ object) · ทุกช่องตรวจแยก ผิดช่องไหนใช้ค่าตั้งต้นช่องนั้น
 * @param {unknown} raw
 * @param {{codes?: readonly string[]}} [options] codes = รายการรหัสปัญหาที่รู้จัก (กรอง highSeverityCodes)
 */
export function parseTaperPolicy(raw, { codes = null } = {}) {
  let input = raw;
  if (typeof raw === "string") {
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  }
  if (!isPlainObject(input)) input = {};
  const base = OWNER_REVIEW_TAPER_DEFAULTS;
  const known = Array.isArray(codes) ? new Set(codes) : null;
  const severe = Array.isArray(input.highSeverityCodes)
    ? [...new Set(input.highSeverityCodes.filter((code) => typeof code === "string" && (!known || known.has(code))))].slice(0, 20)
    : null;
  const rates = Array.isArray(input.sampleRates) && input.sampleRates.length === OWNER_REVIEW_LEVELS.length
    && input.sampleRates.every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1)
    ? input.sampleRates.slice() : base.sampleRates.slice();
  const promote = isPlainObject(input.promote) ? input.promote : {};
  const demote = isPlainObject(input.demote) ? input.demote : {};
  return {
    flagRisk: intIn(input.flagRisk, 1, 100, base.flagRisk),
    highSeverityCodes: severe && severe.length ? severe : base.highSeverityCodes.slice(),
    sampleRates: rates,
    warmupDays: intIn(input.warmupDays, 1, 60, base.warmupDays),
    promote: {
      minAgreement: numberIn(promote.minAgreement, 0.5, 1, base.promote.minAgreement),
      minLabels: intIn(promote.minLabels, 10, 5000, base.promote.minLabels),
      maxMissRate: numberIn(promote.maxMissRate, 0, 0.5, base.promote.maxMissRate),
      minSampleLabels: intIn(promote.minSampleLabels, 5, 5000, base.promote.minSampleLabels),
      minDaysBetween: intIn(promote.minDaysBetween, 1, 60, base.promote.minDaysBetween),
    },
    demote: {
      maxMissRate: numberIn(demote.maxMissRate, 0, 1, base.demote.maxMissRate),
      minSampleLabels: intIn(demote.minSampleLabels, 1, 5000, base.demote.minSampleLabels),
    },
    pin: input.pin === null || input.pin === undefined ? null : intIn(input.pin, 0, 2, null),
  };
}

/** สถานะระดับที่เก็บไว้ (pure) — {level, changedDay} · พัง = ระดับ 0 ยังไม่เคยเปลี่ยน */
export function parseTaperState(raw) {
  let input = raw;
  if (typeof raw === "string") {
    try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { input = {}; }
  }
  if (!isPlainObject(input)) input = {};
  return {
    level: intIn(input.level, 0, 2, 0),
    changedDay: typeof input.changedDay === "string" && DAY_KEY_RE.test(input.changedDay) ? input.changedDay : "",
  };
}

/** วันไทย YYYY-MM-DD ของเวลา ms (pure) */
export function bangkokDayKey(ms) {
  return new Date(Number(ms) + 7 * 60 * 60_000).toISOString().slice(0, 10);
}

/** จำนวนวันจาก fromDay ถึง toDay (YYYY-MM-DD) — ใช้ไม่ได้ = null */
export function dayDiff(fromDay, toDay) {
  if (!DAY_KEY_RE.test(String(fromDay)) || !DAY_KEY_RE.test(String(toDay))) return null;
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

/** วันที่ N (เริ่มที่ 1) นับจากวันเริ่มตรวจ — ยังไม่เริ่ม = 0 */
export function reviewDayNumber(startedDay, dayKey) {
  const diff = dayDiff(startedDay, dayKey);
  return diff === null || diff < 0 ? 0 : diff + 1;
}

/** dayKey ย้อนหลัง n วัน (pure) */
export function shiftDayKey(dayKey, days) {
  if (!DAY_KEY_RE.test(String(dayKey))) return "";
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + Number(days) * DAY_MS).toISOString().slice(0, 10);
}

/** ค่าสุ่มคงที่ 0 ≤ u < 1 ของห้องในวันนั้น (hmac-sha256 → 48 บิตแรก) */
export function sampleUnit(dayKey, customerId) {
  const digest = createHmac("sha256", SAMPLE_KEY).update(`${String(dayKey)}\u0000${String(customerId)}`).digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

/** ห้องนี้น่าห่วงไหม — ต้องเป็นผลอ่านของ AI ที่สำเร็จเท่านั้น */
export function isFlagged({ aiStatus, risk, issues = [] }, policy = OWNER_REVIEW_TAPER_DEFAULTS) {
  if (aiStatus !== "done") return false;
  if (Number.isFinite(Number(risk)) && risk !== null && Number(risk) >= policy.flagRisk) return true;
  const severe = new Set(policy.highSeverityCodes);
  return (Array.isArray(issues) ? issues : []).some((issue) => severe.has(issue?.code));
}

/**
 * ห้องนี้เข้าคิวไหม (pure) — {flagged, sampled, included: all|flagged|sample|none}
 * AI อ่านไม่สำเร็จ (failed/skipped) = เข้าคิวเสมอ ('all') เพราะไม่มีใครคัดกรองให้ · ระดับ 0 = 'all' ทุกห้อง
 */
export function includeDecision(item, level, dayKey, policy = OWNER_REVIEW_TAPER_DEFAULTS) {
  const flagged = isFlagged(item, policy);
  const rate = policy.sampleRates[intIn(level, 0, 2, 0)] ?? 0;
  const sampled = !flagged && item.aiStatus === "done" && sampleUnit(dayKey, item.customerId) < rate;
  if (level === 0 || item.aiStatus !== "done") return { flagged, sampled, included: "all" };
  if (flagged) return { flagged, sampled: false, included: "flagged" };
  return { flagged, sampled, included: sampled ? "sample" : "none" };
}

function issueKeyOf(issue) {
  return `${String(issue?.code || "")}@${String(issue?.messageId || "")}`;
}

/**
 * ตัวเลขความแม่นของ AI (pure) — rows = แถวที่มีป้าย (ownerReviewLabelledItems)
 *   labels     = ป้ายที่คนตรวจทีละห้อง (ไม่นับ bulk) ของห้องที่ AI อ่านสำเร็จ
 *   agreement  = (น่าห่วง∧ต้องปรับ + ไม่น่าห่วง∧ดีแล้ว) / labels
 *   missRate   = ต้องปรับ / ป้าย ในชุดสุ่ม (ห้องไม่น่าห่วงที่ถูกสุ่ม) — AI พลาดห้องที่ควรแก้กี่ %
 *   perCode    = {code: {agree, disagree}} จากการกดเห็นด้วย/ไม่เห็นด้วยกับปัญหาที่ AI ชี้
 */
export function taperMetrics(rows = []) {
  let labels = 0;
  let agree = 0;
  let sampleLabels = 0;
  let sampleMisses = 0;
  let flaggedLabels = 0;
  let flaggedNeedsFix = 0;
  const perCode = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || (row.label !== "good" && row.label !== "needs_fix")) continue;
    let issues = [];
    let verdicts = {};
    try { issues = JSON.parse(String(row.issues_json || "[]")); } catch { issues = []; }
    try { verdicts = JSON.parse(String(row.issue_verdicts_json || "{}")); } catch { verdicts = {}; }
    for (const issue of Array.isArray(issues) ? issues : []) {
      const verdict = isPlainObject(verdicts) ? verdicts[issueKeyOf(issue)] : undefined;
      if (verdict !== "agree" && verdict !== "disagree") continue;
      const code = String(issue?.code || "other");
      perCode[code] ??= { agree: 0, disagree: 0 };
      perCode[code][verdict] += 1;
    }
    if (row.ai_status !== "done" || row.label_via === "bulk") continue;
    const flagged = Number(row.flagged) === 1;
    const needsFix = row.label === "needs_fix";
    labels += 1;
    if (flagged === needsFix) agree += 1;
    if (flagged) {
      flaggedLabels += 1;
      if (needsFix) flaggedNeedsFix += 1;
    } else if (Number(row.sampled) === 1) {
      sampleLabels += 1;
      if (needsFix) sampleMisses += 1;
    }
  }
  const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);
  return {
    labels, agreement: ratio(agree, labels), sampleLabels, missRate: ratio(sampleMisses, sampleLabels),
    flaggedLabels, flaggedPrecision: ratio(flaggedNeedsFix, flaggedLabels), perCode,
  };
}

/**
 * ตัดสินระดับของวันนี้ (pure) — เรียกตอนปิดรอบ daily ก่อนจัดคิว (ลดระดับมีผลกับคิววันนี้ทันที)
 * @returns {{level: number, state: {level, changedDay}, reason: string, dayNumber: number}}
 *   reason: pinned | not_started | warmup | demoted | promoted | hold
 */
export function evaluateTaper({ policy = OWNER_REVIEW_TAPER_DEFAULTS, state = { level: 0, changedDay: "" }, metrics = taperMetrics([]),
  dayKey, startedDay = "" } = {}) {
  const dayNumber = reviewDayNumber(startedDay, dayKey);
  const current = { level: intIn(state?.level, 0, 2, 0), changedDay: String(state?.changedDay || "") };
  if (policy.pin !== null && policy.pin !== undefined) {
    return { level: policy.pin, state: current, reason: "pinned", dayNumber };
  }
  if (!dayNumber) return { level: 0, state: { level: 0, changedDay: current.changedDay }, reason: "not_started", dayNumber };
  if (dayNumber <= policy.warmupDays) {
    return { level: 0, state: { level: 0, changedDay: current.changedDay || startedDay }, reason: "warmup", dayNumber };
  }
  const missValid = metrics.sampleLabels >= policy.demote.minSampleLabels && metrics.missRate !== null;
  if (current.level > 0 && missValid && metrics.missRate > policy.demote.maxMissRate) {
    return { level: 0, state: { level: 0, changedDay: dayKey }, reason: "demoted", dayNumber };
  }
  const since = dayDiff(current.changedDay || startedDay, dayKey);
  const ready = current.level < 2
    && since !== null && since >= policy.promote.minDaysBetween
    && metrics.labels >= policy.promote.minLabels
    && metrics.agreement !== null && metrics.agreement >= policy.promote.minAgreement
    && metrics.sampleLabels >= policy.promote.minSampleLabels
    && metrics.missRate !== null && metrics.missRate <= policy.promote.maxMissRate;
  if (ready) return { level: current.level + 1, state: { level: current.level + 1, changedDay: dayKey }, reason: "promoted", dayNumber };
  return { level: current.level, state: current, reason: "hold", dayNumber };
}
