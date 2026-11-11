// consoleTeamReviewApi.mjs — GET /console/api/team-review (คำสั่งพี่ง้วง 3 พ.ย. 2026: "พี่ง้วงเห็นคนเดียว")
//
// ผลตรวจคำตอบของทีมโดย Luna (teamReplyReview.mjs) — สิทธิ์ team_review.view มีเฉพาะ owner
// อ่านอย่างเดียว · ไม่มีข้อความแชท มีแต่คะแนน รหัสปัญหา และโน้ตที่ปิดชื่อแล้ว
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { TEAM_REVIEW_ISSUE_CODES } from "./teamReplyReview.mjs";
import { bangkokDayKey } from "./ownerReviewTaper.mjs";

const DAY = 86_400_000;
export const TEAM_REVIEW_DAYS_DEFAULT = 7;
export const TEAM_REVIEW_DAYS_MAX = 60;
export const TEAM_REVIEW_ROOMS_MAX = 200;

function parseIssues(raw) {
  try {
    const list = JSON.parse(String(raw || "[]"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const avg = (values) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);

/** สรุปแถว team_reply_reviews (pure) — รวมทั้งทีม · แยกตามคนพิมพ์ · รหัสปัญหาที่เจอบ่อย · รายห้อง (คะแนนต่ำก่อน) */
export function summarizeTeamReviews(rows = [], { channelLabel = (id) => id, roomsMax = TEAM_REVIEW_ROOMS_MAX } = {}) {
  const done = rows.filter((row) => row.status === "done" && Number.isInteger(Number(row.score)));
  const byOperator = new Map();
  const codeCounts = {};
  for (const row of done) {
    const issues = parseIssues(row.issues_json);
    for (const issue of issues) codeCounts[issue.code] = (codeCounts[issue.code] || 0) + 1;
    for (const name of String(row.operators || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const entry = byOperator.get(name) ?? { operator: name, scores: [], issues: 0 };
      entry.scores.push(Number(row.score));
      entry.issues += issues.length;
      byOperator.set(name, entry);
    }
  }
  const scoreBuckets = [5, 4, 3, 2, 1].map((score) => ({ score, rooms: done.filter((row) => Number(row.score) === score).length }));
  return {
    total: rows.length,
    reviewed: done.length,
    notReviewed: rows.length - done.length,
    avgScore: avg(done.map((row) => Number(row.score))),
    scoreBuckets,
    operators: [...byOperator.values()]
      .map(({ operator, scores, issues }) => ({ operator, rooms: scores.length, avgScore: avg(scores), issues }))
      .sort((a, b) => b.rooms - a.rooms),
    topIssues: Object.entries(codeCounts)
      .map(([code, count]) => ({ code, label: TEAM_REVIEW_ISSUE_CODES[code]?.label || code, count }))
      .sort((a, b) => b.count - a.count),
    rooms: [...done]
      .sort((a, b) => Number(a.score) - Number(b.score) || String(b.day_key).localeCompare(String(a.day_key)))
      .slice(0, roomsMax)
      .map((row) => ({
        id: row.customer_id,
        name: String(row.known_name || row.display_name || "").trim() || `ลูกค้า …${String(row.customer_id).slice(-4)}`,
        channelName: channelLabel(row.channel_id),
        dayKey: row.day_key,
        operators: row.operators,
        score: Number(row.score),
        summary: row.summary,
        good: row.good,
        issues: parseIssues(row.issues_json).map((issue) => ({
          code: issue.code, label: TEAM_REVIEW_ISSUE_CODES[issue.code]?.label || issue.code, note: issue.note || "", messageId: issue.messageId || "",
        })),
      })),
  };
}

export function createConsoleTeamReviewRoutes({ db, now = Date.now, channelLabel = (id) => id }) {
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "team-review" || route.length !== 1) return false;
    const { json, operator } = ctx;
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!hasOperatorCapability(operator, "team_review.view")) {
      json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้" });
      return true;
    }
    const days = Math.min(TEAM_REVIEW_DAYS_MAX, Math.max(1, Math.trunc(Number(url.searchParams.get("days"))) || TEAM_REVIEW_DAYS_DEFAULT));
    try {
      const sinceDayKey = bangkokDayKey(now() - (days - 1) * DAY);
      const rows = db.listTeamReviews({ sinceDayKey });
      json(res, 200, { ok: true, days, sinceDayKey, ...summarizeTeamReviews(rows, { channelLabel }) });
    } catch {
      json(res, 500, { ok: false, error: "อ่านผลตรวจคำตอบทีมไม่สำเร็จ" });
    }
    return true;
  }
  return { handle };
}
