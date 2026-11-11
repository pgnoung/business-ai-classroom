// consoleOwnerReviewDailyApi.mjs — แท็บ "ตรวจแชทวันนี้" ของห้องตรวจ (#/owner-review/daily · เฟส B · 12 ต.ค. 2026)
//
// เส้นทาง (ใต้ /console/api/owner-review/daily…) — consoleOwnerReviewApi ตรวจสิทธิ์ closes.confirm + สาขาก่อนส่งมาที่นี่
//   GET  daily?batch=<id>                    คิวของรอบ (ไม่ส่ง = รอบล่าสุดที่พร้อม) + ความคืบหน้า + ค้างตรวจ + ระดับการตรวจ
//   GET  daily/items/:id                      ห้องเดียว: แชทของช่วงนั้นเป็นฟอง [mN] + ปัญหาที่ AI ชี้ผูกกับฟอง
//   POST daily/items/:id/label               {label: good|needs_fix, revision, note?}
//   POST daily/items/:id/undo                {revision} — ย้อนป้ายที่ตัวเองกดภายใน 10 วิ (ถอนบทเรียนที่เพิ่งสร้างด้วย)
//   POST daily/items/:id/fix                 {messageId, reasonChips[], betterReply, revision} → บทเรียน + ป้าย needs_fix
//   POST daily/items/:id/verdict             {issueKey, verdict: agree|disagree|null}
//   POST daily/items/:id/claim               {} — "กำลังดูห้องนี้" (3 นาที · ในหน่วยความจำ) ให้พี่ง้วงกับชมพู่ไม่เปิดห้องเดียวกันพร้อมกัน
//   POST daily/batches/:id/good-rest         {exceptId?} — ดีที่เหลือทั้งหมด (ห้องไม่น่าห่วง ไม่ถูกสุ่ม AI ไม่ชี้จุด · ไม่รวมการ์ดบนจอ)
//   POST daily/batches/:id/good-rest/undo    {bulkId}
//   POST daily/taper                         {pin: null|0|1|2} — เจ้าของปักระดับการตรวจ (owner เท่านั้น)
// สิทธิ์: ดู/ติดป้าย = corrections.review · ต้องปรับ+สอน = lessons.teach (owner ใช้ทันที · staff รออนุมัติ)
// ข้อความแชทผ่าน maskPersonalText (ชื่อ/เบอร์/อีเมล) และตัดยาว · audit ไม่มีเนื้อหา · ไม่มีข้อมูลลูกค้าใน log
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { OFFTOPIC_CATEGORY_LABELS } from "./offtopicClose.mjs";
import { isNotQualifiedRow } from "./notQualified.mjs";
import { maskPersonalText, qualifySpeakerOf } from "./qualifyPrompt.mjs";
import { ownerLessonsPaused, lessonTitle } from "./ownerLessons.mjs";
import { OWNER_REVIEW_CODES, OWNER_REVIEW_ISSUE_CODES } from "./ownerReviewDailyPrompt.mjs";
import { OWNER_REVIEW_DAILY_TIME, ownerReviewNextDailyAt } from "./ownerReviewDaily.mjs";
import {
  OWNER_REVIEW_FIX_CHIPS, OWNER_REVIEW_BETTER_REPLY_MAX, OWNER_REVIEW_BETTER_REPLY_MIN, OWNER_REVIEW_UNDO_MS, createOwnerReviewLabelService,
  issueKeyOf, parseJsonList,
} from "./ownerReviewLabels.mjs";
import { lukpraeWrittenSql } from "./dbOwnerReviewItems.mjs";
import {
  OWNER_REVIEW_LEVEL_LABELS, OWNER_REVIEW_STARTED_DAY_KEY, OWNER_REVIEW_TAPER_POLICY_KEY, OWNER_REVIEW_TAPER_STATE_KEY,
  bangkokDayKey, parseTaperPolicy, parseTaperState, reviewDayNumber, shiftDayKey, taperMetrics,
} from "./ownerReviewTaper.mjs";

const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
const DAY_MS = 24 * 60 * 60_000;
export const OWNER_REVIEW_BACKLOG_DAYS = 7;
export const OWNER_REVIEW_DETAIL_ROWS = 200;
export const OWNER_REVIEW_DETAIL_CONTEXT_ROWS = 3;
// "กำลังดูห้องนี้" อยู่ได้นานเท่านี้ (หน้าเว็บต่ออายุทุก 30 วิ ขณะการ์ดยังเปิด) — ปิดแอปแล้วห้องคืนคิวเองหลังหมดเวลา
export const OWNER_REVIEW_CLAIM_MS = 3 * 60_000;
const BUBBLE_MAX_CHARS = 1_200;
const ID_RE = /^[\w-]{1,80}$/u;
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const NONTEXT_LABEL = Object.freeze({
  image: "[ส่งรูป]", sticker: "[สติกเกอร์]", audio: "[ข้อความเสียง]", file: "[ไฟล์]", video: "[วิดีโอ]",
});
const SPEAKER = Object.freeze({ "ลูกค้า": "customer", "ลูกแพร": "ai", "แอดมิน": "team" });
// รูปที่ลูกแพรส่ง = รูปจากคลังที่อนุมัติแล้ว ("[image:key] https://…" — ของบริษัท ไม่ใช่ของลูกค้า) · รูปที่อัปโหลดเอง (upload_) ไม่โชว์
const OUT_IMAGE_RE = /^\[image:([^\]\n]{1,80})\]\s{1,4}(https:\/\/\S{1,1000})$/u;
const graphemeSegmenter = new Intl.Segmenter("th", { granularity: "grapheme" });

/** "12 ต.ค." จาก YYYY-MM-DD */
export function thaiDayLabel(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(dayKey || ""));
  return match ? `${Number(match[3])} ${TH_MONTHS[Number(match[2]) - 1] || ""}`.trim() : "";
}

function maskName(name) {
  const parts = [...graphemeSegmenter.segment(String(name ?? "").replace(/\s+/gu, " ").trim())].map((part) => part.segment);
  if (!parts.length) return "ลูกค้า";
  return parts.length <= 2 ? `${parts[0]}•` : `${parts[0]}•••${parts.at(-1)}`;
}

/** รูปจากคลังที่ลูกแพรส่ง → {key, url} · อย่างอื่น (รูปลูกค้า/รูปที่ทีมอัปโหลด) = null */
export function catalogImageOf(row, lukpraeWritten) {
  if (!lukpraeWritten || String(row?.msg_type) !== "image" || String(row?.direction) !== "out") return null;
  const match = OUT_IMAGE_RE.exec(String(row?.content ?? "").trim());
  if (!match || /^upload_/u.test(match[1])) return null;
  return { key: match[1].trim(), url: match[2] };
}

function bubbleText(row, names, image = null) {
  const type = String(row?.msg_type || "text");
  if (image) return `[ส่งรูป: ${image.key}]`;
  if (type !== "text") return NONTEXT_LABEL[type] || "[สื่ออื่น]";
  const chars = Array.from(maskPersonalText(String(row?.content ?? ""), names).replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === "\n" ? "\n" : " "))
    .replace(/[^\S\n]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim());
  return chars.length > BUBBLE_MAX_CHARS ? `${chars.slice(0, BUBBLE_MAX_CHARS).join("")}…` : chars.join("") || "[ข้อความว่าง]";
}

function parseObject(text) {
  try {
    const parsed = JSON.parse(String(text || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function createOwnerReviewDailyRoutes({
  db, config = {}, notifier = null, logger = console, now = Date.now, channelLabel = (id) => String(id || "default"),
} = {}) {
  const service = createOwnerReviewLabelService({ db, config, notifier, logger, now });
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const setting = (key) => safe(() => String(db.getSetting(key) ?? ""), "");

  /* ------------------------- กำลังดูห้องนี้ (ในหน่วยความจำ · หนึ่งห้องต่อคน) ------------------------- */

  // itemId → {username, until} · ขนาดไม่เกินจำนวนบัญชีคอนโซล (ทุกคนถือได้ทีละห้อง) · ไม่มีข้อมูลลูกค้า
  const presence = new Map();
  function liveClaim(id, t = Number(now())) {
    const entry = presence.get(id);
    if (!entry) return null;
    if (entry.until > t) return entry;
    presence.delete(id);
    return null;
  }
  function claim(id, username) {
    const t = Number(now());
    const held = liveClaim(id, t);
    if (held && held.username !== username) return held;
    for (const [key, entry] of presence) if (entry.username === username || entry.until <= t) presence.delete(key);
    presence.set(id, { username, until: t + OWNER_REVIEW_CLAIM_MS });
    return null;
  }
  function release(id, username) {
    if (presence.get(id)?.username === username) presence.delete(id);
  }
  /** ชื่อคนอื่นที่กำลังดูห้องนี้ (ไม่ใช่ตัวเอง) — null = ไม่มี */
  function viewingBy(id, username, names) {
    const held = liveClaim(id);
    return held && held.username !== username ? names.get(held.username) || held.username : null;
  }

  function operatorNames() {
    return new Map(safe(() => db.listOperators(), []).map((op) => [String(op.username), String(op.display_name || op.username)]));
  }

  /* ---------------------------------- รูปข้อมูลสาธารณะ ---------------------------------- */

  /** ห้องหนึ่งในคิว — ไม่มีข้อความแชท (สรุป/โน้ตของ AI ปิดข้อมูลส่วนตัวตั้งแต่ตอนเก็บ) */
  function publicItem(row, names = new Map()) {
    const verdicts = parseObject(row.issue_verdicts_json);
    const done = row.ai_status === "done";
    const flagged = Number(row.flagged) === 1;
    const sampled = Number(row.sampled) === 1;
    const issues = parseJsonList(row.issues_json).map((issue) => {
      const key = issueKeyOf(issue);
      const meta = OWNER_REVIEW_ISSUE_CODES[issue?.code] || OWNER_REVIEW_ISSUE_CODES.other;
      return {
        key, code: String(issue?.code || "other"), label: meta.label, severity: meta.severity,
        messageId: String(issue?.messageId || ""), note: String(issue?.note || ""),
        verdict: verdicts[key] === "agree" || verdicts[key] === "disagree" ? verdicts[key] : null,
      };
    });
    const name = String(row.customer_known_name || row.customer_display_name || "").trim();
    return {
      id: String(row.id), batchId: String(row.batch_id), dayKey: String(row.day_key), customerId: String(row.customer_id),
      customer: {
        displayName: name.slice(0, 80), displayNameMasked: maskName(name),
        channelLabel: channelLabel(row.room_channel_id || row.channel_id), aiEnabled: Number(row.customer_ai_enabled) === 1,
      },
      aiStatus: String(row.ai_status), aiMessages: Number(row.ai_messages) || 0,
      risk: row.risk == null ? null : Number(row.risk),
      riskLevel: flagged ? "high" : done ? "normal" : "unknown",
      riskLabel: flagged ? "น่าห่วง" : done ? "ปกติ" : "AI ยังไม่ได้อ่าน",
      flagged, sampled, included: String(row.included),
      summary: String(row.ai_summary || ""), issues, issueCount: issues.length,
      offtopicHint: row.offtopic_hint ? { category: String(row.offtopic_hint), label: OFFTOPIC_CATEGORY_LABELS[row.offtopic_hint] || String(row.offtopic_hint) } : null,
      label: row.label ?? null, labelVia: String(row.label_via || ""), labelNote: String(row.label_note || ""),
      labelledBy: String(row.labelled_by || ""), labelledByName: names.get(String(row.labelled_by || "")) || String(row.labelled_by || ""),
      labelledAt: row.labelled_at == null ? null : Number(row.labelled_at), revision: Number(row.revision) || 0,
      mustReview: flagged || sampled,
      bulkEligible: !row.label && !flagged && !sampled && done && row.included !== "none" && issues.length === 0,
      lessons: parseJsonList(row.lesson_ids_json).map((entry) => ({
        id: String(entry?.id || ""), created: entry?.created === true, messageId: String(entry?.messageId || ""),
      })),
      lastMessageId: String(row.last_message_id || ""),
    };
  }

  function publicBatch(batch) {
    if (!batch) return null;
    const dayKey = bangkokDayKey(batch.slot_ms);
    let counts = {};
    try { counts = JSON.parse(String(batch.counts_json || "{}")) || {}; } catch { counts = {}; }
    return {
      id: String(batch.id), dayKey, dayLabel: thaiDayLabel(dayKey), status: String(batch.status),
      cutoffAt: Number(batch.slot_ms), windowStartAt: Number(batch.window_start_ms), windowEndAt: Number(batch.window_end_ms),
      readyAt: batch.ready_at == null ? null : Number(batch.ready_at),
      level: Number.isInteger(counts.taper?.level) ? counts.taper.level : null,
      levelLabel: Number.isInteger(counts.taper?.level) ? OWNER_REVIEW_LEVEL_LABELS[counts.taper.level] : "",
      overflow: Number(counts.overflow) || 0,
    };
  }

  /* ---------------------------------- ระดับการตรวจ ---------------------------------- */

  function taperSummary() {
    const todayKey = bangkokDayKey(now());
    const policy = parseTaperPolicy(setting(OWNER_REVIEW_TAPER_POLICY_KEY), { codes: OWNER_REVIEW_CODES });
    const state = parseTaperState(setting(OWNER_REVIEW_TAPER_STATE_KEY));
    const startedDay = setting(OWNER_REVIEW_STARTED_DAY_KEY);
    const metrics = taperMetrics(safe(() => db.ownerReviewLabelledItems(shiftDayKey(todayKey, -6), shiftDayKey(todayKey, 1)), []));
    const dayNumber = reviewDayNumber(startedDay, todayKey);
    const inWarmup = dayNumber > 0 && dayNumber <= policy.warmupDays;
    const level = policy.pin ?? (dayNumber === 0 || inWarmup ? 0 : state.level);
    return {
      level, levelLabel: OWNER_REVIEW_LEVEL_LABELS[level], pinned: policy.pin !== null, pin: policy.pin,
      dayNumber, warmupDays: policy.warmupDays, inWarmup, startedDay, flagRisk: policy.flagRisk,
      agreement7d: metrics.agreement, missRate7d: metrics.missRate, labels7d: metrics.labels, sampleLabels7d: metrics.sampleLabels,
      perCode7d: metrics.perCode,
      promoteNeeds: {
        minAgreement: policy.promote.minAgreement, minLabels: policy.promote.minLabels,
        maxMissRate: policy.promote.maxMissRate, minSampleLabels: policy.promote.minSampleLabels,
      },
    };
  }

  /* ---------------------------------- คิว ---------------------------------- */

  function readyBatches(scope) {
    return safe(() => db.ownerReviewDailyBacklog(now() - (OWNER_REVIEW_BACKLOG_DAYS + 1) * DAY_MS, { channels: scope }), []);
  }

  function selectBatch(scope, requested = "") {
    if (requested) {
      const batch = ID_RE.test(requested) ? safe(() => db.ownerReviewBatch(requested), null) : null;
      return batch?.kind === "daily" && batch.status === "ready" ? batch : undefined;
    }
    const first = readyBatches(scope)[0];
    if (first) return safe(() => db.ownerReviewBatch(first.batch_id), null);
    const latest = safe(() => db.latestOwnerReviewBatch("daily"), null);
    return latest?.status === "ready" ? latest : null;
  }

  function backlogOf(scope, exceptId = "") {
    const since = now() - OWNER_REVIEW_BACKLOG_DAYS * DAY_MS;
    return readyBatches(scope)
      .filter((row) => Number(row.slot_ms) >= since && Number(row.remaining) > 0 && String(row.batch_id) !== String(exceptId))
      .map((row) => {
        const dayKey = bangkokDayKey(row.slot_ms);
        return { batchId: String(row.batch_id), dayKey, dayLabel: thaiDayLabel(dayKey), remaining: Number(row.remaining) || 0, included: Number(row.included) || 0 };
      });
  }

  function buildingOf() {
    const latest = safe(() => db.latestOwnerReviewBatch("daily"), null);
    if (latest?.status !== "building") return null;
    const counts = db.ownerReviewBatchItemCounts(latest.id);
    const dayKey = bangkokDayKey(latest.slot_ms);
    return { batchId: String(latest.id), dayKey, dayLabel: thaiDayLabel(dayKey), done: counts.rooms - counts.pending, total: counts.rooms };
  }

  const progressOf = (counts) => ({
    total: counts.included, labelled: counts.labelled, remaining: counts.remaining, flagged: counts.flagged,
    flaggedRemaining: counts.flaggedRemaining, good: counts.good, needsFix: counts.needsFix, rooms: counts.rooms,
  });

  /** บล็อก daily ของ GET /owner-review/summary — ตัวเลขอย่างเดียว */
  function summary(scope) {
    const batch = selectBatch(scope) || null;
    const counts = batch ? db.ownerReviewBatchItemCounts(batch.id, { channels: scope }) : null;
    return {
      available: true,
      dailyTime: OWNER_REVIEW_DAILY_TIME,
      nextDailyAt: ownerReviewNextDailyAt(now()),
      batch: publicBatch(batch),
      progress: counts ? progressOf(counts) : null,
      building: buildingOf(),
      backlog: backlogOf(scope, batch?.id),
      taper: taperSummary(),
    };
  }

  function queue(scope, requested, username = "") {
    const batch = selectBatch(scope, requested);
    if (batch === undefined) return null;
    const counts = batch ? db.ownerReviewBatchItemCounts(batch.id, { channels: scope }) : null;
    const names = operatorNames();
    return {
      batch: publicBatch(batch),
      progress: counts ? progressOf(counts) : null,
      bulkGood: counts ? {
        eligible: counts.bulkEligible, allowed: counts.flaggedRemaining === 0 && counts.bulkEligible > 0,
        flaggedRemaining: counts.flaggedRemaining,
      } : { eligible: 0, allowed: false, flaggedRemaining: 0 },
      items: batch ? db.listOwnerReviewQueue(batch.id, { channels: scope })
        .map((row) => ({ ...publicItem(row, names), viewingBy: row.label ? null : viewingBy(String(row.id), username, names) })) : [],
      backlog: backlogOf(scope, batch?.id),
      building: buildingOf(),
      taper: taperSummary(),
      nextDailyAt: ownerReviewNextDailyAt(now()),
    };
  }

  /* ---------------------------------- รายละเอียดห้อง ---------------------------------- */

  function detail(row, operator) {
    const customerId = String(row.customer_id);
    const room = safe(() => db.getCustomer(customerId), null);
    const names = [room?.display_name, room?.known_name];
    const start = Number(row.window_start_ms) || 0;
    const end = Number(row.window_end_ms) || 0;
    // lukprae = ลูกแพรเขียนเอง (ด่านเดียวกับตอนเลือกห้อง/ตอนสอน) — ข้อความอัตโนมัติแตะแก้ไม่ได้และติดป้าย "อัตโนมัติ"
    const select = `SELECT m.id, m.direction, m.msg_type, m.content, m.operator, m.message_class, m.created_at,
        ${lukpraeWrittenSql("m")} AS lukprae FROM messages m`;
    const windowRows = db.raw.prepare(`${select} WHERE m.customer_id = ? AND m.created_at > ? AND m.created_at <= ?
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`).all(customerId, start, end, OWNER_REVIEW_DETAIL_ROWS).reverse();
    const truncated = windowRows.length >= OWNER_REVIEW_DETAIL_ROWS;
    const contextRows = truncated ? [] : db.raw.prepare(`${select} WHERE m.customer_id = ? AND m.created_at <= ?
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`).all(customerId, start, OWNER_REVIEW_DETAIL_CONTEXT_ROWS).reverse();
    const item = publicItem(row, operatorNames());
    const byMessage = new Map();
    for (const issue of item.issues) {
      if (!issue.messageId) continue;
      byMessage.set(issue.messageId, [...(byMessage.get(issue.messageId) || []), issue.key]);
    }
    const bubbles = [...contextRows.map((message) => [message, false]), ...windowRows.map((message) => [message, true])]
      .map(([message, inWindow], index) => {
        const speaker = SPEAKER[qualifySpeakerOf(message)] || "ai";
        const written = Number(message.lukprae) === 1;
        const image = catalogImageOf(message, written);
        const out = message.direction === "out";
        return {
          id: String(message.id), ref: `m${index + 1}`, speaker, direction: out ? "out" : "in",
          msgType: String(message.msg_type || "text"), text: bubbleText(message, names, image), at: Number(message.created_at) || 0,
          proactive: message.message_class === "proactive", inWindow,
          automated: out && speaker === "ai" && !written,
          fixable: inWindow && speaker === "ai" && written,
          ...(image ? { image } : {}),
          issueKeys: byMessage.get(String(message.id)) || [],
        };
      });
    const shown = new Set(bubbles.map((bubble) => bubble.id));
    const after = Number(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ? AND created_at > ?").get(customerId, end)?.n) || 0;
    const lessonRows = safe(() => db.ownerLessonsByIds(item.lessons.map((entry) => entry.id)), []);
    return {
      item: {
        ...item,
        lessons: item.lessons.map((entry) => {
          const lesson = lessonRows.find((candidate) => String(candidate.id) === entry.id);
          return { ...entry, title: lesson && !lesson.missing ? lessonTitle(lesson) : "", status: lesson?.missing ? "deleted" : String(lesson?.status || "") };
        }),
      },
      bubbles,
      truncated,
      unanchoredIssueKeys: item.issues.filter((issue) => !issue.messageId || !shown.has(issue.messageId)).map((issue) => issue.key),
      continuedAfterCutoff: after > 0,
      room: {
        aiEnabled: Number(room?.ai_enabled) === 1, yellow: isNotQualifiedRow(room),
        channelLabel: channelLabel(room?.channel_id || row.channel_id), conversationHash: `#/c/${encodeURIComponent(customerId)}`,
      },
      canTeach: config.teachEnabled === true && hasOperatorCapability(operator, "lessons.teach"),
      teachEnabled: config.teachEnabled === true,
      lessonsApplyNow: hasOperatorCapability(operator, "lessons.approve"),
      lessonsPaused: safe(() => ownerLessonsPaused(db), false),
    };
  }

  /* ---------------------------------- ตัวรับคำขอ ---------------------------------- */

  function scopedItem(id, scope) {
    return ID_RE.test(id) ? safe(() => db.ownerReviewItemScoped(id, scope), null) : null;
  }

  function respond(json, res, result, scope, itemId = "") {
    const body = { ...result.body };
    if (body.item) delete body.item;
    const refreshed = itemId ? scopedItem(itemId, scope) : null;
    json(res, result.status, { ...body, ...(refreshed ? { item: publicItem(refreshed, operatorNames()) } : {}) });
    return true;
  }

  function setPin(body, username) {
    const pin = body?.pin;
    if (!(pin === null || (Number.isInteger(pin) && pin >= 0 && pin <= 2))) return { status: 400, body: { ok: false, code: "bad_request", error: "ระดับไม่ถูกต้อง" } };
    const current = parseObject(setting(OWNER_REVIEW_TAPER_POLICY_KEY));
    db.setSetting(OWNER_REVIEW_TAPER_POLICY_KEY, JSON.stringify({ ...current, pin }));
    safe(() => db.addAudit({ operator: username, action: "owner_review_taper_pinned", target: "owner_review", detail: `pin=${pin === null ? "auto" : pin}` }), null);
    return { status: 200, body: { ok: true, taper: taperSummary() } };
  }

  /**
   * route[0] = owner-review, route[1] = daily · ctx.scope = สาขาที่ผู้ดูเห็นได้ (null = ทุกสาขา)
   * คืน true เสมอ (เส้นใต้ daily เป็นของไฟล์นี้ทั้งหมด)
   */
  async function handle(req, res, url, route, ctx) {
    const { json, readJson, username, operator, requireCsrf, scope } = ctx;
    const deny = () => json(res, 403, { ok: false, code: "forbidden", error: DENY });
    if (!hasOperatorCapability(operator, "corrections.review")) { deny(); return true; }
    const notFound = () => { json(res, 404, { ok: false, code: "not_found", error: "ไม่พบ endpoint นี้" }); return true; };

    if (req.method === "GET" && route.length === 2) {
      const requested = String(url.searchParams.get("batch") || "");
      const result = queue(scope, requested, username);
      if (!result) { json(res, 404, { ok: false, code: "not_found", error: "ไม่พบคิวของวันนั้น (อาจเลย 180 วันแล้ว)" }); return true; }
      json(res, 200, {
        ok: true, ...result,
        // teach = สิ่งที่ลูกแพรจะจำเมื่อเลือกชิปนี้ (แผ่นต้องปรับโชว์ก่อนกดบันทึก)
        chips: OWNER_REVIEW_FIX_CHIPS.map((chip) => ({ key: chip.key, label: chip.label, teach: chip.teach })),
        codes: Object.fromEntries(OWNER_REVIEW_CODES.map((code) => [code, { label: OWNER_REVIEW_ISSUE_CODES[code].label, severity: OWNER_REVIEW_ISSUE_CODES[code].severity }])),
        undoMs: OWNER_REVIEW_UNDO_MS, betterReplyMax: OWNER_REVIEW_BETTER_REPLY_MAX, betterReplyMin: OWNER_REVIEW_BETTER_REPLY_MIN,
        canPin: operator?.role === "owner",
      });
      return true;
    }

    if (route[2] === "items" && route.length >= 4 && route.length <= 5) {
      let id = "";
      try { id = decodeURIComponent(route[3]); } catch { id = ""; }
      const row = scopedItem(id, scope);
      if (!row) { json(res, 404, { ok: false, code: "not_found", error: "ไม่พบห้องนี้ในคิวตรวจ" }); return true; }
      if (req.method === "GET" && route.length === 4) {
        json(res, 200, { ok: true, ...detail(row, operator) });
        return true;
      }
      const action = route[4];
      if (req.method !== "POST" || !["label", "undo", "fix", "verdict", "claim"].includes(action)) return notFound();
      if (!requireCsrf()) { json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" }); return true; }
      if (action === "claim") {
        await readJson(req).catch(() => null); // ไม่มีอะไรให้อ่าน — กินเนื้อคำขอให้หมดเหมือนเส้นอื่น
        const held = row.label ? null : claim(String(row.id), String(username || ""));
        json(res, 200, { ok: true, claimed: !held && !row.label, viewingBy: held ? operatorNames().get(held.username) || held.username : null });
        return true;
      }
      if (action === "fix" && !hasOperatorCapability(operator, "lessons.teach")) { deny(); return true; }
      const body = await readJson(req).catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { ok: false, code: "bad_request", error: "คำขอไม่ถูกต้อง" }); return true; }
      const who = { username, role: operator?.role };
      const result = action === "label" ? service.label({ item: row, label: body.label, revision: body.revision, note: body.note ?? "", operator: who })
        : action === "undo" ? service.undo({ item: row, revision: body.revision, operator: who })
          : action === "fix" ? service.fix({
            item: row, messageId: body.messageId, reasonChips: body.reasonChips ?? [], betterReply: body.betterReply ?? "", revision: body.revision, operator: who,
          })
            : service.verdict({ item: row, issueKey: body.issueKey, verdict: body.verdict ?? null, operator: who });
      if (result.status === 200 && action !== "verdict") release(String(row.id), String(username || ""));
      return respond(json, res, result, scope, id);
    }

    if (route[2] === "batches" && (route.length === 5 || route.length === 6) && route[4] === "good-rest") {
      if (req.method !== "POST" || (route.length === 6 && route[5] !== "undo")) return notFound();
      if (!requireCsrf()) { json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" }); return true; }
      let id = "";
      try { id = decodeURIComponent(route[3]); } catch { id = ""; }
      const batch = ID_RE.test(id) ? safe(() => db.ownerReviewBatch(id), null) : null;
      const body = await readJson(req).catch(() => ({})) ?? {};
      const who = { username, role: operator?.role };
      const result = route.length === 6
        ? service.undoGoodRest({ batch, bulkId: body?.bulkId, operator: who })
        : service.goodRest({ batch, operator: who, channels: scope, exceptId: body?.exceptId ?? "" });
      const progress = batch?.kind === "daily" ? progressOf(db.ownerReviewBatchItemCounts(batch.id, { channels: scope })) : null;
      json(res, result.status, { ...result.body, ...(progress ? { progress } : {}) });
      return true;
    }

    if (route[2] === "taper" && route.length === 3 && req.method === "POST") {
      if (operator?.role !== "owner") { deny(); return true; }
      if (!requireCsrf()) { json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" }); return true; }
      const body = await readJson(req).catch(() => null);
      const result = setPin(body, username);
      json(res, result.status, result.body);
      return true;
    }
    return notFound();
  }

  return { handle, summary, publicItem };
}
