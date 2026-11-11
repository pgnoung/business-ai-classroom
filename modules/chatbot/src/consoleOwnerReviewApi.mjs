// consoleOwnerReviewApi.mjs — ห้องตรวจของพี่ง้วง (#/owner-review) · เฟส A: ข้อเสนอปิดห้องรอยืนยัน (12 ต.ค. 2026 ค่ำ)
//
// เส้นทาง (ใต้ /console/api/owner-review/…) — สัญญากับหน้าเว็บอยู่ที่คำอธิบายแต่ละเส้นด้านล่าง
//   GET  summary                    ตัวเลขหัวหน้า + สถานะสวิตช์ + แท็บ (แท็บ daily = เฟส B ยังไม่เปิด)
//   GET  proposals?view=open|decided&limit&cursor   รายการ (รอยืนยันก่อน · keyset)
//   GET  proposals/:id              รายละเอียด + 8 ข้อความล่าสุดของห้อง (ปิดชื่อ/เบอร์/อีเมล · ชื่อลูกค้าแบบย่อเท่านั้น)
//   POST proposals/:id/decide       {action: confirm|silent|reject, reason?, seenMessageId, revision}
//   POST proposals/:id/undo         {revision} — ย้อน "ไม่ปิด" ภายใน 10 วิ (ยืนยันแล้วส่งคำลาไปแล้ว ย้อนไม่ได้)
//   POST proposals/:id/note         {reason, revision} — เหตุ "ไม่ปิด" จากชิปในแถบย้อน (คนที่กดเอง · ภายใน 10 นาที)
//   summary?peek=1 = การ์ดหน้าภาพรวมอ่านตัวเลขเฉย ๆ ไม่นับว่าเจ้าของ "เปิดห้องตรวจแล้ว" (ไม่ล้างแจ้งเตือนรอยืนยันปิด)
//   daily…                          เฟส B: คิวตรวจแชทรายวัน 20:00 — consoleOwnerReviewDailyApi.mjs (สัญญาอยู่หัวไฟล์นั้น)
// สิทธิ์: closes.confirm (owner · admin · staff — พี่ง้วงตัดสินว่าชมพู่ยืนยันได้) · staff เห็นเฉพาะห้องในสาขาที่ได้รับมอบ
// ไม่มีข้อความแชทดิบ/ชื่อเต็มลูกค้าในคำตอบ — ข้อความผ่าน maskPersonalText และตัดยาว · audit ไม่มีเนื้อหา
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { isNotQualifiedRow } from "./notQualified.mjs";
import { OFFTOPIC_CATEGORY_LABELS, offtopicCloseMode, offtopicFallbackText } from "./offtopicClose.mjs";
import { OWNER_CLOSE_UNDO_MS, publicProposal } from "./ownerCloseService.mjs";
import {
  OWNER_REVIEW_DAILY_THB_CAP, OWNER_REVIEW_SCAN_BUDGET_SHARE, OWNER_REVIEW_SCAN_ROOM_CAP, OWNER_REVIEW_SCAN_TIMES,
  ownerReviewMode, ownerReviewNextScanAt, ownerReviewScanScope,
} from "./ownerReviewScheduler.mjs";
import { maskPersonalText, qualifySpeakerOf } from "./qualifyPrompt.mjs";
import { QUALIFY_LATEST_INBOUND_SQL, readQualifySweepModeStrict } from "./qualifySweepRules.mjs";
import { createOwnerReviewDailyRoutes } from "./consoleOwnerReviewDailyApi.mjs";

const CAPABILITY = "closes.confirm";
const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
export const OWNER_REVIEW_DETAIL_MESSAGES = 8;
const MESSAGE_MAX_CHARS = 600;
const NONTEXT_LABEL = Object.freeze({
  image: "[ส่งรูป]", sticker: "[สติกเกอร์]", audio: "[ข้อความเสียง]", file: "[ไฟล์]", video: "[วิดีโอ]",
});
const SOURCE_LABELS = Object.freeze({ cue_luna: "เจอคำนอกเรื่อง + AI ยืนยัน", luna_screen: "AI อ่านท่าทีของห้อง" });
const STATUS_LABELS = Object.freeze({
  pending: "รอยืนยัน", confirming: "กำลังส่ง", confirmed: "ปิดแล้ว (ส่งคำลา)", closed_silent: "ปิดเงียบแล้ว",
  rejected: "ไม่ปิด", send_failed: "ส่งคำลาไม่สำเร็จ", expired: "หมดอายุ",
});
const graphemeSegmenter = new Intl.Segmenter("th", { granularity: "grapheme" });

/** ชื่อลูกค้าแบบย่อ (ตัวแรก•••ตัวท้าย) — คอนโซลจำห้องได้ แต่ไม่แสดงชื่อเต็ม */
export function maskDisplayName(name) {
  const parts = [...graphemeSegmenter.segment(String(name ?? "").replace(/\s+/gu, " ").trim())].map((part) => part.segment);
  if (!parts.length) return "ลูกค้า";
  if (parts.length <= 2) return `${parts[0]}•`;
  return `${parts[0]}•••${parts.at(-1)}`;
}

function activeChannelIds(channels) {
  const active = Array.isArray(channels) ? channels.filter((channel) => channel?.active !== false).map((channel) => String(channel.id)) : [];
  return active.length ? active : ["default"];
}

// null = ทุกสาขา (owner/admin หรือร้านที่มีสาขาเดียว) · staff = เฉพาะสาขาที่ได้รับมอบ
function allowedChannels({ db, username, operator, channels }) {
  const active = activeChannelIds(channels);
  if (active.length <= 1 || operator?.role === "owner" || operator?.role === "admin") return null;
  const mine = new Set(db.listOperatorChannels(username).map(String));
  // เจน 12 ต.ค. (เช็ก production): ยังไม่มีใครถูกมอบสาขาเลย (operator_channels ว่าง) และกล่องแชทก็ไม่แยกสาขา —
  // พี่ง้วงสั่งให้ชมพู่ยืนยันปิดได้ = staff ที่ไม่มีการมอบสาขาเห็นทุกสาขา · มีการมอบบางสาขาเมื่อไหร่ = เห็นเฉพาะที่มอบ
  if (mine.size === 0) return null;
  return active.filter((id) => mine.has(id));
}

/**
 * ใช้ห้องตรวจได้ไหม — ด่านเดียวกับทุกเส้นของ API (สิทธิ์ closes.confirm + มีสาขาที่เห็นอย่างน้อยหนึ่ง)
 * /me ใช้ตัวนี้เปิดเมนู: staff ที่ไม่ได้รับมอบสาขาไหนเลยต้องไม่เห็นเมนูที่กดแล้วได้ 403 (รีวิว 12 ต.ค. ค่ำ)
 * อ่านฐานไม่ได้ = ปิดเมนู (ไม่เดาว่าเห็น)
 */
export function ownerReviewAccess({ db, username, operator, channels = [] } = {}) {
  // ไม่มีบัญชีจริง (operator null) = ไม่ให้เข้า — staff ที่ไม่มีการมอบสาขาเห็นทุกสาขา ด่านนี้จึงต้องเช็กบัญชีเอง
  if (!operator || !hasOperatorCapability(operator, CAPABILITY)) return false;
  try {
    const scope = allowedChannels({ db, username, operator, channels });
    return !Array.isArray(scope) || scope.length > 0;
  } catch {
    return false;
  }
}

/** สาขาที่บัญชีนี้มองไม่เห็น (staff ที่ได้รับมอบไม่ครบ) — หน้าเว็บบอกตรง ๆ ว่ารายการไม่ครบ */
function channelScopeOf(scope, channels, channelLabel) {
  if (!Array.isArray(scope)) return { limited: false, hidden: [] };
  const visible = new Set(scope);
  const hidden = activeChannelIds(channels).filter((id) => !visible.has(id)).map((id) => channelLabel(id));
  return { limited: hidden.length > 0, hidden };
}

function messageText(row, names) {
  const type = String(row?.msg_type || "text");
  if (type !== "text") return NONTEXT_LABEL[type] || "[สื่ออื่น]";
  const chars = Array.from(maskPersonalText(String(row?.content ?? ""), names).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim());
  return chars.length > MESSAGE_MAX_CHARS ? `${chars.slice(0, MESSAGE_MAX_CHARS).join("")}…` : chars.join("") || "[ข้อความว่าง]";
}

// stats = ตัวเลขรวมของรอบตรวจ (ownerReviewScheduler.stats — server ส่งเป็นฟังก์ชันเพราะตัวตรวจสร้างทีหลังคอนโซล)
// config/notifier/logger = ของบทเรียน ("ต้องปรับ" ในคิวตรวจแชท → ownerLessonStore · แฟล็ก TEACH_ENABLED · ปลุกเจ้าของเมื่อทีมสอน)
export function createConsoleOwnerReviewRoutes({
  db, channels = [], closeService = null, stats = () => null, now = Date.now, channelLabel = (id) => String(id || "default"),
  config = {}, notifier = null, logger = console,
} = {}) {
  const dailyRoutes = createOwnerReviewDailyRoutes({ db, config, notifier, logger, now, channelLabel });
  function listItem(row) {
    const lastInboundAt = Number(row.last_inbound_at) || 0;
    return {
      ...publicProposal(row),
      categoryLabel: OFFTOPIC_CATEGORY_LABELS[row.category] || row.category,
      sourceLabel: SOURCE_LABELS[row.source] || row.source,
      statusLabel: STATUS_LABELS[row.status] || row.status,
      customer: {
        // เจน 12 ต.ค.: พี่ง้วง/ชมพู่ต้องจำห้องได้ (หน้าแชทของคอนโซลก็แสดงชื่อเต็มอยู่แล้ว) — ชื่อเต็มสำหรับหน้าจอ ชื่อปิดบางส่วนไว้ที่อื่น
        displayName: String(row.customer_known_name || row.customer_display_name || "").trim().slice(0, 80),
        displayNameMasked: maskDisplayName(row.customer_known_name || row.customer_display_name),
        channelLabel: channelLabel(row.channel_id),
        aiEnabled: Number(row.customer_ai_enabled) === 1,
      },
      lastInboundAt,
      newSinceProposal: lastInboundAt > (Number(row.created_at) || 0),
    };
  }

  function summary(scope) {
    const t = now();
    const counts = db.ownerCloseCounts({ channels: scope, sinceMs: bangkokDayStartMs(t) });
    const latest = db.latestOwnerReviewBatch("scan");
    let lastCounts = {};
    try { lastCounts = JSON.parse(String(latest?.counts_json || "{}")) || {}; } catch { lastCounts = {}; }
    let scan = null;
    try { scan = stats?.() ?? null; } catch { scan = null; }
    const pending = counts.pending.total + counts.confirming.total;
    let daily = null;
    try { daily = dailyRoutes.summary(scope); } catch { daily = null; }
    return {
      mode: ownerReviewMode(db) ?? "unknown",
      scope: ownerReviewScanScope(db),
      // ตัวกวาดไม่ใช่ on = กดยืนยันแล้วถูกปฏิเสธเสมอ (ห้องเหลืองถูกคืนทุกนาที) — หน้าเว็บต้องเตือนก่อนให้กด
      sweepOn: readQualifySweepModeStrict(db) === "on",
      offtopicMode: offtopicCloseMode(db),
      counts: {
        pending, sendFailed: counts.send_failed.total,
        today: {
          confirmed: counts.confirmed.since, closedSilent: counts.closed_silent.since,
          rejected: counts.rejected.since, expired: counts.expired.since,
        },
      },
      lastScan: latest ? {
        slotAt: Number(latest.slot_ms), status: latest.status, readyAt: latest.ready_at == null ? null : Number(latest.ready_at),
        rooms: Number(lastCounts.rooms) || 0, evaluated: Number(lastCounts.evaluated) || 0, proposed: Number(lastCounts.proposed) || 0,
      } : null,
      nextScanAt: ownerReviewNextScanAt(t),
      scanTimes: OWNER_REVIEW_SCAN_TIMES.split(","),
      roomCap: OWNER_REVIEW_SCAN_ROOM_CAP,
      // เพดานรวม ฿80/วัน (รอบ scan + คิวตรวจแชท) — รอบ scan ใช้ได้ไม่เกิน scanCapThb
      costToday: { thb: scan?.today?.thb ?? null, capThb: OWNER_REVIEW_DAILY_THB_CAP, scanCapThb: OWNER_REVIEW_DAILY_THB_CAP * OWNER_REVIEW_SCAN_BUDGET_SHARE },
      inFlight: scan?.inFlight === true,
      tabs: [
        { key: "close", label: "รอยืนยันปิด", count: pending + counts.send_failed.total, available: true },
        { key: "daily", label: "ตรวจแชทวันนี้", count: Number(daily?.progress?.remaining) || 0, available: Boolean(daily) },
      ],
      // เฟส B: คิวตรวจแชทรายวัน (รอบล่าสุดที่พร้อม · กำลังเตรียม · ค้างตรวจ 7 วัน · ระดับการตรวจ/วันที่ N/7/ความตรงกับ AI 7 วัน)
      daily,
      categories: OFFTOPIC_CATEGORY_LABELS,
      undoMs: OWNER_CLOSE_UNDO_MS,
      channelScope: channelScopeOf(scope, channels, channelLabel),
    };
  }

  // since = ข้อความลูกค้าที่หน้าเว็บเห็นครั้งก่อน (หลัง 409 ลูกค้าพิมพ์ใหม่ จุดอ้างอิงในฐานถูกเลื่อนไปข้อความล่าสุดแล้ว
  // — ไม่ส่ง since ข้อความที่ทำให้ 409 จะไม่ติดป้าย "ใหม่") · ต้องเป็นข้อความขาเข้าของห้องนี้ ไม่งั้นใช้จุดอ้างอิงเดิม
  function detail(row, { since = "" } = {}) {
    const customerId = String(row.customer_id);
    const room = db.getCustomer(customerId);
    const messages = db.raw.prepare(`SELECT id, direction, msg_type, content, operator, message_class, created_at
        FROM messages WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(customerId, OWNER_REVIEW_DETAIL_MESSAGES).reverse();
    const anchorOf = (messageId) => (messageId
      ? db.raw.prepare("SELECT id, created_at FROM messages WHERE id = ? AND customer_id = ? AND direction = 'in'").get(String(messageId), customerId)
      : null) ?? null;
    const sinceRow = String(since || "").length <= 300 ? anchorOf(since) : null;
    const reference = sinceRow ?? anchorOf(row.baseline_inbound_id);
    const baselineAt = Number(reference?.created_at) || 0;
    const latest = db.raw.prepare(QUALIFY_LATEST_INBOUND_SQL).get(customerId) ?? null;
    const facebook = String(room?.channel_id || row.channel_id || "") === FACEBOOK_CHANNEL_ID;
    let windowOpen = true;
    if (facebook) { try { windowOpen = db.withinFacebookWindow(customerId, now()) === true; } catch { windowOpen = false; } }
    const masks = [room?.display_name, room?.known_name];
    return {
      proposal: listItem({ ...row, last_inbound_at: latest?.created_at ?? 0 }),
      latestInboundId: String(latest?.id || ""),
      customerTypedSinceBaseline: Boolean(latest) && String(latest.id) !== String(sinceRow?.id || row.baseline_inbound_id || ""),
      messages: messages.map((message) => ({
        id: String(message.id),
        direction: message.direction === "in" ? "in" : "out",
        speaker: qualifySpeakerOf(message),
        msgType: String(message.msg_type || "text"),
        text: messageText(message, masks),
        at: Number(message.created_at) || 0,
        proactive: message.message_class === "proactive",
        afterBaseline: baselineAt > 0 && message.direction === "in" && Number(message.created_at) > baselineAt,
      })),
      room: {
        aiEnabled: Number(room?.ai_enabled) === 1,
        yellow: isNotQualifiedRow(room),
        channelId: String(room?.channel_id || row.channel_id || "default"),
        channelLabel: channelLabel(room?.channel_id || row.channel_id),
        facebook, fbWindowOpen: facebook ? windowOpen : null,
        // ยืนยันแล้วส่งคำลาได้ไหม (Facebook นอก 24 ชม. = ได้แค่ปิดเงียบ)
        canSendGoodbye: !facebook || windowOpen,
      },
      // ข้อความลาที่จะถูกส่งจริงเมื่อกดยืนยัน (ข้อความตายตัวตามหมวด — ไม่มีข้อมูลลูกค้า)
      goodbyeText: offtopicFallbackText(row.category),
      sweepOn: readQualifySweepModeStrict(db) === "on",
    };
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "owner-review") return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    if (!hasOperatorCapability(operator, CAPABILITY)) { json(res, 403, { ok: false, error: DENY }); return true; }
    const scope = allowedChannels({ db, username, operator, channels });
    if (Array.isArray(scope) && !scope.length) { json(res, 403, { ok: false, error: DENY }); return true; }

    if (req.method === "GET" && route.length === 2 && route[1] === "summary") {
      // เจ้าของเปิดห้องตรวจแล้ว = เห็นแล้ว — มือถือไม่ต้องเด้ง "รอยืนยันปิด" ซ้ำตอนลูกค้าคนอื่นทัก
      // ?peek=1 = การ์ดหน้าภาพรวม (poll ทุก 15 วิ) — ห้ามล้าง ไม่งั้นแจ้งเตือนที่เพิ่งยิงหายก่อนมือถือมาอ่าน
      const peek = url.searchParams.get("peek") === "1";
      if (operator?.role === "owner" && !peek) { try { db.clearOwnerReviewPushEvents?.(username); } catch { /* ไม่สำคัญพอจะทำให้หน้าเสีย */ } }
      json(res, 200, { ok: true, canConfirm: true, ...summary(scope) });
      return true;
    }

    if (req.method === "GET" && route.length === 2 && route[1] === "proposals") {
      const view = String(url.searchParams.get("view") || "open");
      if (!["open", "decided"].includes(view)) { json(res, 400, { ok: false, error: "view ไม่ถูกต้อง" }); return true; }
      const listed = db.listOwnerCloseProposals({
        view, channels: scope, cursor: String(url.searchParams.get("cursor") || ""),
        limit: Number(url.searchParams.get("limit")) || 30,
      });
      json(res, 200, { ok: true, view, rows: listed.rows.map(listItem), hasMore: listed.hasMore, nextCursor: listed.nextCursor });
      return true;
    }

    if (route[1] === "daily") {
      return dailyRoutes.handle(req, res, url, route, { json, readJson, username, operator, requireCsrf, scope });
    }

    if (route[1] !== "proposals" || route.length < 3 || route.length > 4) {
      json(res, 404, { ok: false, error: "ไม่พบ endpoint นี้" });
      return true;
    }
    let id = "";
    try { id = decodeURIComponent(route[2]); } catch { id = ""; }
    const row = /^[\w-]{1,80}$/u.test(id) ? db.ownerCloseProposalScoped(id, scope) : null;
    if (!row) { json(res, 404, { ok: false, code: "not_found", error: "ไม่พบข้อเสนอนี้" }); return true; }

    if (req.method === "GET" && route.length === 3) {
      json(res, 200, { ok: true, ...detail(row, { since: String(url.searchParams.get("since") || "") }) });
      return true;
    }
    if (req.method !== "POST" || route.length !== 4 || !["decide", "undo", "note"].includes(route[3])) {
      json(res, 404, { ok: false, error: "ไม่พบ endpoint นี้" });
      return true;
    }
    if (!requireCsrf()) { json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" }); return true; }
    if (!closeService) { json(res, 503, { ok: false, code: "unavailable", error: "ห้องตรวจยังไม่พร้อมบนเซิร์ฟเวอร์" }); return true; }
    const body = await readJson(req);
    const note = () => (typeof closeService.note === "function"
      ? closeService.note({ proposalId: id, operator: { username }, revision: body?.revision, reason: typeof body?.reason === "string" ? body.reason : "" })
      : { status: 404, body: { ok: false, error: "ไม่พบ endpoint นี้" } });
    const result = route[3] === "undo"
      ? closeService.undo({ proposalId: id, operator: { username }, revision: body?.revision })
      : route[3] === "note" ? note() : await closeService.decide({
        proposalId: id, action: String(body?.action || ""), operator: { username },
        seenMessageId: typeof body?.seenMessageId === "string" ? body.seenMessageId : "",
        revision: body?.revision, reason: typeof body?.reason === "string" ? body.reason : "",
      });
    const refreshed = db.ownerCloseProposalScoped(id, scope);
    const latestAt = Number(db.raw.prepare(QUALIFY_LATEST_INBOUND_SQL).get(String(row.customer_id))?.created_at) || 0;
    json(res, result.status, { ...result.body, ...(refreshed ? { proposal: listItem({ ...refreshed, last_inbound_at: latestAt }) } : {}) });
    return true;
  }
  return { handle };
}
