// Read-only, all-session history search.  This intentionally does not reuse
// the inbox query: inbox is an active-work queue, whereas this surface is an
// audit/search view over durable chassis message rows.
import { hasOperatorCapability } from "./operatorRoles.mjs";

const CAPABILITY = "operations.use";
const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
const ACTORS = new Set(["all", "customer", "ai", "human", "system"]);
const DIRECTIONS = new Set(["all", "in", "out"]);

function activeChannelIds(channels) {
  const ids = Array.isArray(channels) ? channels.filter((row) => row?.active !== false).map((row) => String(row.id)) : [];
  return ids.length ? ids : ["default"];
}

function allowedChannels({ db, username, operator, channels }) {
  const active = activeChannelIds(channels);
  // Owners/admins are responsible for this whole instance. Do not silently
  // hide imported or retired OA history merely because its channel is inactive.
  if (operator?.role === "owner" || operator?.role === "admin") return null;
  if (active.length <= 1) return active;
  const granted = new Set(db.listOperatorChannels(username));
  return active.filter((id) => granted.has(id));
}

function bangkokStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day) - 7 * 3_600_000;
  const check = new Date(utc + 7 * 3_600_000);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day ? utc : null;
}

function escapeLike(value) { return String(value).replace(/[\\%_]/g, (part) => `\\${part}`); }
function safeText(value, limit = 120) { return String(value || "").trim().slice(0, limit); }
function cursor(value) {
  const [at, rid] = String(value || "").split(".", 2);
  return /^\d{1,16}$/u.test(at || "") && /^\d{1,16}$/u.test(rid || "") ? { at: Number(at), rid: Number(rid) } : null;
}

function actorClause(actor) {
  if (actor === "customer") return "m.direction = 'in'";
  if (actor === "human") return "m.direction = 'out' AND m.operator <> '' AND m.operator <> 'system'";
  if (actor === "system") return "m.direction = 'out' AND m.operator = 'system'";
  if (actor === "ai") return "m.direction = 'out' AND (m.operator = '' OR m.operator IS NULL)";
  return "";
}

function publicRow(row) {
  return {
    id: row.id, rid: Number(row.rid), customerId: row.customer_id, channelId: row.channel_id || "default",
    direction: row.direction, msgType: row.msg_type, content: row.content || "", messageClass: row.message_class || "",
    operator: row.operator || "", agentMode: row.agent_mode || "", createdAt: Number(row.created_at) || 0,
    customerName: row.known_name || row.display_name || "",
  };
}

export function createConsoleHistoryRoutes({ config, db, channels = [] }) {
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "history") return false;
    const { json, username, operator } = ctx;
    if (config.chatHistoryEnabled !== true) { json(res, 404, { ok: false, error: "ประวัติแชทยังไม่เปิด" }); return true; }
    if (!hasOperatorCapability(operator, CAPABILITY)) { json(res, 403, { ok: false, error: DENY }); return true; }
    if (req.method !== "GET") { json(res, 405, { ok: false, error: "อ่านประวัติได้อย่างเดียว" }); return true; }
    const allowed = allowedChannels({ db, username, operator, channels });
    if (allowed && !allowed.length) { json(res, 403, { ok: false, error: DENY }); return true; }
    const requestedChannel = safeText(url.searchParams.get("channel"), 100);
    if (requestedChannel && allowed && !allowed.includes(requestedChannel)) { json(res, 403, { ok: false, error: DENY }); return true; }
    const scope = requestedChannel ? [requestedChannel] : allowed;
    const isTranscript = route.length === 2 && route[1] === "transcript";
    const isThreads = route.length === 2 && route[1] === "threads";

    const direction = safeText(url.searchParams.get("direction"), 10) || "all";
    const actor = safeText(url.searchParams.get("actor"), 10) || "all";
    if (!isTranscript && (!DIRECTIONS.has(direction) || !ACTORS.has(actor))) { json(res, 400, { ok: false, error: "ตัวกรองทิศทางหรือผู้ส่งไม่ถูกต้อง" }); return true; }
    const fromRaw = safeText(url.searchParams.get("from"), 10);
    const toRaw = safeText(url.searchParams.get("to"), 10);
    const from = fromRaw ? bangkokStart(fromRaw) : null;
    const toStart = toRaw ? bangkokStart(toRaw) : null;
    if (!isTranscript && ((fromRaw && from == null) || (toRaw && toStart == null) || (from != null && toStart != null && from > toStart))) {
      json(res, 400, { ok: false, error: "วันที่ต้องเป็น YYYY-MM-DD และช่วงวันต้องถูกต้อง" }); return true;
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw == null ? (isThreads ? 30 : 50) : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > (isThreads ? 30 : 100)) { json(res, 400, { ok: false, error: isThreads ? "limit ต้องอยู่ระหว่าง 1 ถึง 30" : "limit ต้องอยู่ระหว่าง 1 ถึง 100" }); return true; }

    const where = ["m.customer_id NOT LIKE 'canary:%'"];
    const params = [];
    if (scope) { where.unshift(`(${scope.map(() => "c.channel_id = ?").join(" OR ")})`); params.push(...scope); }
    if (direction !== "all") { where.push("m.direction = ?"); params.push(direction); }
    const actorSql = actorClause(actor); if (actorSql) where.push(actorSql);
    if (from != null) { where.push("m.created_at >= ?"); params.push(from); }
    if (toStart != null) { where.push("m.created_at < ?"); params.push(toStart + 86_400_000); }
    const q = safeText(url.searchParams.get("q"), 160);
    const customerQ = safeText(url.searchParams.get("customer"), 160);
    if (q) { const like = `%${escapeLike(q)}%`; where.push("(m.content LIKE ? ESCAPE '\\' OR c.display_name LIKE ? ESCAPE '\\' OR c.known_name LIKE ? ESCAPE '\\' OR m.customer_id LIKE ? ESCAPE '\\')"); params.push(like, like, like, like); }
    if (customerQ) { const like = `%${escapeLike(customerQ)}%`; where.push("(c.display_name LIKE ? ESCAPE '\\' OR c.known_name LIKE ? ESCAPE '\\' OR m.customer_id LIKE ? ESCAPE '\\')"); params.push(like, like, like); }
    const after = cursor(url.searchParams.get("cursor"));
    if (url.searchParams.has("cursor") && !after) { json(res, 400, { ok: false, error: "cursor ไม่ถูกต้อง" }); return true; }
    if (after && !isThreads) { where.push("(m.created_at < ? OR (m.created_at = ? AND m.rowid < ?))"); params.push(after.at, after.at, after.rid); }

    if (isThreads) {
      // Rank after applying every search/date/actor predicate.  A room whose
      // newest overall message does not match a historical search must remain
      // discoverable through its newest matching message.
      const outerCursor = after ? " AND (created_at < ? OR (created_at = ? AND rid < ?))" : "";
      const threadParams = after ? [...params, after.at, after.at, after.rid, limit + 1] : [...params, limit + 1];
      const rows = db.raw.prepare(`SELECT * FROM (
        SELECT m.rowid AS rid,m.id,m.customer_id,m.channel_id,m.content,m.created_at,c.display_name,c.known_name,
          ROW_NUMBER() OVER (PARTITION BY m.customer_id ORDER BY m.created_at DESC,m.rowid DESC) AS thread_rank
        FROM messages m JOIN customers c ON c.line_user_id=m.customer_id
        WHERE ${where.join(" AND ")}
      ) WHERE thread_rank=1${outerCursor} ORDER BY created_at DESC,rid DESC LIMIT ?`).all(...threadParams);
      const listed = rows.slice(0, limit); const tail = listed.at(-1);
      json(res, 200, { ok: true, threads: listed.map(row => ({ customerId: row.customer_id, customerName: row.known_name || row.display_name || "", channelId: row.channel_id || "default", latestAt: Number(row.created_at) || 0, preview: safeText(row.content, 160) })), hasMore: rows.length > limit, nextCursor: rows.length > limit && tail ? `${tail.created_at}.${tail.rid}` : null });
      return true;
    }

    if (route.length === 1) {
      const rows = db.raw.prepare(`SELECT m.rowid AS rid,m.id,m.customer_id,m.channel_id,m.direction,m.msg_type,m.content,m.message_class,m.operator,m.agent_mode,m.created_at,c.display_name,c.known_name
        FROM messages m JOIN customers c ON c.line_user_id=m.customer_id
        WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC,m.rowid DESC LIMIT ?`).all(...params, limit + 1);
      const listed = rows.slice(0, limit); const tail = listed.at(-1);
      json(res, 200, { ok: true, rows: listed.map(publicRow), hasMore: rows.length > limit,
        nextCursor: rows.length > limit && tail ? `${tail.created_at}.${tail.rid}` : null,
        coverage: "แสดงทุกช่วงการสนทนาที่ระบบยังเก็บไว้ ประวัติใน LINE OA โดยตรงหรือรายการที่ถูกลบอาจไม่มี" });
      return true;
    }
    if (route.length === 2 && route[1] === "transcript") {
      const customerId = safeText(url.searchParams.get("customerId"), 300);
      if (!customerId) { json(res, 400, { ok: false, error: "ต้องระบุ customerId" }); return true; }
      // Transcript deliberately ignores the list's text/date/actor filters.
      // Selecting a search hit must open every durable session for that room.
      const transcriptWhere = ["m.customer_id NOT LIKE 'canary:%'", "m.customer_id = ?"];
      const transcriptParams = [customerId];
      if (scope) { transcriptWhere.unshift(`(${scope.map(() => "c.channel_id = ?").join(" OR ")})`); transcriptParams.unshift(...scope); }
      const atMsRaw = url.searchParams.get("atMs"); const atMs = atMsRaw == null ? null : Number(atMsRaw);
      if (atMsRaw != null && (!Number.isSafeInteger(atMs) || atMs < 0)) { json(res, 400, { ok: false, error: "atMs ไม่ถูกต้อง" }); return true; }
      if (atMs != null) { transcriptWhere.push("m.created_at <= ?"); transcriptParams.push(atMs); }
      const pageDirection = safeText(url.searchParams.get("direction"), 10) || "older";
      if (!new Set(["older", "newer"]).has(pageDirection)) { json(res, 400, { ok: false, error: "direction ไม่ถูกต้อง" }); return true; }
      if (after) {
        transcriptWhere.push(pageDirection === "newer" ? "(m.created_at > ? OR (m.created_at = ? AND m.rowid > ?))" : "(m.created_at < ? OR (m.created_at = ? AND m.rowid < ?))");
        transcriptParams.push(after.at, after.at, after.rid);
      }
      const rows = db.raw.prepare(`SELECT m.rowid AS rid,m.id,m.customer_id,m.channel_id,m.direction,m.msg_type,m.content,m.message_class,m.operator,m.agent_mode,m.created_at,c.display_name,c.known_name
        FROM messages m JOIN customers c ON c.line_user_id=m.customer_id
        WHERE ${transcriptWhere.join(" AND ")} ORDER BY m.created_at ${pageDirection === "newer" ? "ASC" : "DESC"},m.rowid ${pageDirection === "newer" ? "ASC" : "DESC"} LIMIT ?`).all(...transcriptParams, limit + 1);
      const listed = rows.slice(0, limit); const oldest = listed.at(pageDirection === "newer" ? 0 : -1); const newest = listed.at(pageDirection === "newer" ? -1 : 0);
      const newerWhere = ["m.customer_id NOT LIKE 'canary:%'", "m.customer_id = ?"];
      const newerParams = [customerId];
      if (scope) { newerWhere.unshift(`(${scope.map(() => "c.channel_id = ?").join(" OR ")})`); newerParams.unshift(...scope); }
      const newerExists = newest ? Boolean(db.raw.prepare(`SELECT 1 FROM messages m JOIN customers c ON c.line_user_id=m.customer_id WHERE ${newerWhere.join(" AND ")} AND (m.created_at > ? OR (m.created_at = ? AND m.rowid > ?)) LIMIT 1`).get(...newerParams, newest.created_at, newest.created_at, newest.rid)) : false;
      json(res, 200, { ok: true, customerId, rows: [...listed].sort((a,b) => a.created_at-b.created_at || a.rid-b.rid).map(publicRow), hasMore: rows.length > limit,
        hasOlder: pageDirection === "older" ? rows.length > limit : Boolean(oldest), olderCursor: oldest ? `${oldest.created_at}.${oldest.rid}` : null, hasNewer: newerExists, newerCursor: newerExists && newest ? `${newest.created_at}.${newest.rid}` : null,
        nextCursor: rows.length > limit ? `${(pageDirection === "newer" ? newest : oldest).created_at}.${(pageDirection === "newer" ? newest : oldest).rid}` : null,
        coverage: "บทสนทนานี้รวมทุกช่วงที่ระบบยังเก็บไว้" });
      return true;
    }
    json(res, 404, { ok: false, error: "ไม่พบเส้นทางประวัติ" }); return true;
  }
  return { handle };
}
