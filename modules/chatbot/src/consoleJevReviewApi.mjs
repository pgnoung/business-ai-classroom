// Human review of Jev decision receipts. This route only records an operator's
// assessment; it has no path to corrections, knowledge, brain, or pipeline state.
import { hasOperatorCapability } from "./operatorRoles.mjs";

const CAPABILITY = "corrections.review";
const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
const DECISIONS = new Set(["confirmed_correct", "confirmed_wrong", "needs_context", "dismissed"]);

function safeResult(text) {
  try {
    const value = JSON.parse(String(text || "{}"));
    const checks = {};
    for (const key of ["complaint", "human_need", "answer_quality", "stop", "notify"]) {
      const check = value?.checks?.[key];
      if (!check || typeof check !== "object") continue;
      const confidence = check.confidence;
      const confidence10 = check.confidence10;
      const probabilities = check.probabilities && typeof check.probabilities === "object" && !Array.isArray(check.probabilities)
        ? Object.fromEntries(Object.entries(check.probabilities).filter(([, n]) => typeof n === "number" && Number.isFinite(n)).map(([name, n]) => [String(name).slice(0, 80), n]))
        : {};
      if (typeof check.choice === "string" && typeof confidence === "number" && Number.isFinite(confidence) && typeof confidence10 === "number" && Number.isFinite(confidence10)) {
        checks[key] = { choice: check.choice.slice(0, 80), confidence, confidence10, probabilities };
      }
    }
    return {
      action: typeof value?.action === "string" ? value.action.slice(0, 80) : "",
      reason: typeof value?.reason === "string" ? value.reason.slice(0, 160) : "",
      confidence10: typeof value?.confidence10 === "number" && Number.isFinite(value.confidence10) ? value.confidence10 : null,
      checks,
    };
  } catch {
    return { action: "", reason: "", confidence10: null, checks: {} };
  }
}

function activeChannelIds(channels) {
  const active = Array.isArray(channels) ? channels.filter((channel) => channel?.active !== false).map((channel) => String(channel.id)) : [];
  return active.length ? active : ["default"];
}

function allowedChannels({ db, username, operator, channels }) {
  const active = activeChannelIds(channels);
  if (active.length <= 1 || operator?.role === "owner" || operator?.role === "admin") return active;
  return active.filter((id) => db.listOperatorChannels(username).includes(id));
}

function scopeClause(channels) {
  return { sql: channels.map(() => "c.channel_id = ?").join(" OR "), values: channels };
}

function publicRow(row) {
  const result = safeResult(row.result_json);
  return {
    id: row.id,
    customerId: row.customer_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    stage: row.stage,
    policy: row.policy,
    model: row.model,
    mode: row.mode || "off",
    proposedAction: row.proposed_action,
    action: row.action,
    status: row.status,
    confidence10: row.confidence_10 == null ? result.confidence10 : Number(row.confidence_10),
    result,
    applied: Number(row.applied) === 1,
    createdAt: Number(row.created_at) || 0,
    elapsedMs: row.elapsed_ms == null ? null : Number(row.elapsed_ms),
    reviewer: row.reviewer || "",
    reviewStatus: row.review_status || "pending",
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    reviewNote: row.review_note || "",
  };
}

export function createConsoleJevReviewRoutes({ db, channels = [], now = Date.now }) {
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "jev-reviews") return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    if (!hasOperatorCapability(operator, CAPABILITY)) { json(res, 403, { ok: false, error: DENY }); return true; }
    const allowed = allowedChannels({ db, username, operator, channels });
    if (!allowed.length) { json(res, 403, { ok: false, error: DENY }); return true; }
    const scope = scopeClause(allowed);

    if (req.method === "GET" && route.length === 1) {
      const reviewStatus = String(url.searchParams.get("reviewStatus") || "all");
      if (reviewStatus !== "all" && !["pending", ...DECISIONS].includes(reviewStatus)) {
        json(res, 400, { ok: false, error: "reviewStatus ไม่ถูกต้อง" }); return true;
      }
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit")) || 30)));
      const cursor = String(url.searchParams.get("cursor") || "");
      const [cursorAt, cursorId] = cursor.split(".", 2);
      const hasCursor = /^\d{1,16}$/.test(cursorAt || "") && /^[\w-]{1,80}$/u.test(cursorId || "");
      const where = [`(${scope.sql})`];
      const params = [...scope.values];
      if (reviewStatus !== "all") { where.push("j.review_status = ?"); params.push(reviewStatus); }
      if (hasCursor) { where.push("(j.created_at < ? OR (j.created_at = ? AND j.id < ?))"); params.push(Number(cursorAt), Number(cursorAt), cursorId); }
      const rows = db.raw.prepare(`SELECT j.* FROM jev_decision_reviews j
        JOIN customers c ON c.line_user_id = j.customer_id
        WHERE ${where.join(" AND ")} ORDER BY j.created_at DESC, j.id DESC LIMIT ?`).all(...params, limit + 1);
      const hasMore = rows.length > limit;
      const listed = rows.slice(0, limit);
      const tail = listed.at(-1);
      json(res, 200, { ok: true, rows: listed.map(publicRow), hasMore,
        nextCursor: hasMore && tail ? `${tail.created_at}.${tail.id}` : null,
        notice: "ความมั่นใจเป็นระดับความแน่ใจของคำตอบ ไม่ใช่ความถูกต้อง และการตัดสินนี้ไม่เพิ่มความรู้โดยอัตโนมัติ" });
      return true;
    }

    if (req.method === "POST" && route.length === 3 && route[2] === "decide") {
      if (!requireCsrf()) { json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" }); return true; }
      const id = decodeURIComponent(route[1]);
      const body = await readJson(req);
      const reviewStatus = String(body?.action || "");
      const note = typeof body?.note === "string" ? body.note.trim() : "";
      if (!DECISIONS.has(reviewStatus) || note.length > 1000) {
        json(res, 400, { ok: false, error: "ผลตัดสินหรือบันทึกไม่ถูกต้อง" }); return true;
      }
      const current = db.raw.prepare(`SELECT j.* FROM jev_decision_reviews j JOIN customers c ON c.line_user_id = j.customer_id
        WHERE j.id = ? AND (${scope.sql})`).get(id, ...scope.values);
      if (!current) { json(res, 404, { ok: false, error: "ไม่พบรายการตรวจ" }); return true; }
      const changed = db.raw.prepare(`UPDATE jev_decision_reviews SET reviewer = ?, review_status = ?, reviewed_at = ?, review_note = ?
        WHERE id = ? AND review_status = 'pending'`).run(username, reviewStatus, now(), note, id).changes;
      if (changed !== 1) { json(res, 409, { ok: false, error: "รายการนี้ถูกตัดสินแล้ว กรุณาโหลดใหม่" }); return true; }
      const row = db.raw.prepare("SELECT * FROM jev_decision_reviews WHERE id = ?").get(id);
      db.addAudit({ operator: username, action: "jev_decision_review", target: id, detail: `status=${reviewStatus}; customer=${current.customer_id}; no_auto_promotion=true` });
      json(res, 200, { ok: true, row: publicRow(row), notice: "บันทึกคำตัดสินแล้ว ยังไม่มีการเพิ่ม knowledge, correction หรือเปลี่ยนการตอบลูกค้า" });
      return true;
    }
    return false;
  }
  return { handle };
}
