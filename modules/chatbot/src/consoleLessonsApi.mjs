// consoleLessonsApi.mjs — เส้นทาง /console/api/lessons/* (สอนลูกแพรจากแผง "ทำไมตอบแบบนี้")
//
// คำสั่งพี่ง้วง 2026-09-28: "พิมพ์สอนในแผงนั้นได้เลย กดบันทึกแล้วลูกแพรเก็บเข้าบทเรียน
// และนำมาปรับใช้ในเรื่องนั้น ๆ ได้เลย" — เส้นนี้จึงเป็นทางลัดที่ไม่ผ่านบันไดเผยแพร่ของการ์ด
// ความรู้ (บทเรียนคือวิธีตอบ ไม่ใช่ข้อเท็จจริง — ข้อเท็จจริงยังต้องไปจอสอนแบบละเอียด)
//
// ด่านของเส้นนี้ (ทั้งหมดอยู่ที่นี่ ไม่ใช่ที่หน้าเว็บ):
//   · แฟล็กจอสอนปิด = เส้นนี้ไม่มีอยู่จริง (404) เหมือน /teach/*
//   · lessons.teach  = สอนได้ (เจ้าของ/แอดมิน/ทีมงาน) · lessons.approve = เจ้าของเท่านั้น
//   · เจ้าของสอน = ใช้ทันที · คนอื่นสอน = รอเจ้าของอนุมัติ (ของที่เปลี่ยนวิธีพูดของลูกแพร
//     เป็นของพี่ง้วงคนเดียว — กติกาเดียวกับคลังความรู้ Package K 2 ก.ย. 2026)
//   · คำสอน/หัวข้อห้ามมีชื่อลูกค้าห้องนั้น เบอร์ อีเมล เลขยาว — บทเรียนใช้กับลูกค้าทุกคน
//   · คำลูกค้า/คำตอบเดิมเก็บแบบลบข้อมูลระบุตัวแล้ว และผูกห้องไว้ให้สิทธิ์ให้ลืมตามล้างได้
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { redactDecisionText } from "./jevDecisionReview.mjs";
import { brainModeOf, BRAIN_MODE_SEPARATE } from "./knowledgePack.mjs";
import {
  OWNER_LESSON_LIMITS as LIMITS, OWNER_LESSONS_PAUSED_KEY, cleanLessonText, lessonPrivacyRefusal,
  lessonTeachingKey, lessonTitle, oneLine, ownerLessonsPaused, suggestLessonTopic,
} from "./ownerLessons.mjs";
// ด่านบันทึก (ความยาว/ความเป็นส่วนตัว/กันซ้ำ/เพดาน/audit/ปลุกเจ้าของ) ย้ายไปไฟล์กลาง 28 ก.ย. 2026
// เพื่อให้การสอนผ่าน Telegram ("คุยกับลูกแพร") ใช้ด่านชุดเดียวกันทุกข้อ
import {
  LESSON_INJECTION_WARNING, LESSON_SAVED_ACTIVE, LESSON_SAVED_PENDING, createOwnerLessonWriter, lessonTeachingProblem,
} from "./ownerLessonStore.mjs";
import { alteredInSystemBlock } from "./promptInjection.mjs";

export { LESSON_SAVED_ACTIVE, LESSON_SAVED_PENDING };
export const LESSON_TEACH_CAPABILITY = "lessons.teach";
export const LESSON_APPROVE_CAPABILITY = "lessons.approve";
const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";

// ข้อความที่ไม่ใช่ตัวหนังสือ แทนด้วยชนิดของมัน — ห้ามเดาเนื้อรูป/เสียงแทนลูกค้า
const NON_TEXT_LABEL = { image: "(ลูกค้าส่งรูป)", sticker: "(ลูกค้าส่งสติกเกอร์)", audio: "(ลูกค้าส่งเสียง)", video: "(ลูกค้าส่งวิดีโอ)", file: "(ลูกค้าส่งไฟล์)" };

function sourceTurnTexts(db, row, customer) {
  const turns = safe(() => db.lessonSourceTurns(row), []);
  return turns.map((turn) => (String(turn.msg_type || "text") === "text"
    ? redactDecisionText(turn.content, customer ?? {}, LIMITS.customer)
    : NON_TEXT_LABEL[turn.msg_type] || "(ลูกค้าส่งไฟล์แนบ)")).filter((text) => String(text).trim());
}

/**
 * คำลูกค้า/คำตอบเดิม/ตัวชี้ห้องของบทเรียนที่สอนจากฟองของลูกแพร (ลบข้อมูลระบุตัวแล้ว) — ใช้ร่วมกับคิวตรวจแชทรายวัน
 * (consoleOwnerReviewDailyApi "ต้องปรับ" → บทเรียน) ให้สองทางเข้าเก็บบริบทแบบเดียวกันทุกไบต์
 */
export function lessonSourceFields(db, row, customer) {
  return {
    customerText: cleanLessonText(sourceTurnTexts(db, row, customer).join("\n"), LIMITS.customer),
    aiText: redactDecisionText(row.content, customer ?? {}, LIMITS.ai),
    sourceMessageId: String(row.id), customerId: String(row.customer_id || ""),
  };
}

export function publicLesson(row, names = new Map()) {
  return {
    id: String(row.id), title: lessonTitle(row), topic: String(row.topic || ""), teaching: String(row.teaching || ""),
    customerText: String(row.customer_text || ""), aiText: String(row.ai_text || ""), status: String(row.status),
    channelId: row.channel_id ?? null, createdBy: String(row.created_by || ""),
    createdByName: names.get(String(row.created_by || "")) || String(row.created_by || ""),
    decidedBy: String(row.decided_by || ""), createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0, decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    useCount: Number(row.use_count) || 0, lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    sourceMessageId: String(row.source_message_id || ""), customerId: String(row.customer_id || ""),
  };
}

/**
 * ข้อมูลส่วน "บทเรียน" ของแผงทำไมตอบแบบนี้ — /teach/why แนบให้ (consoleTeachApi.mjs)
 * `used` อ่านจาก metadata ที่ pipeline จดตอนส่งจริงเท่านั้น ห้ามเดาจากบทเรียนที่มีตอนนี้
 */
export function lessonsForWhyPanel(db, row, { operator = null } = {}) {
  const canTeach = hasOperatorCapability(operator, LESSON_TEACH_CAPABILITY);
  const used = safe(() => db.ownerLessonsByIds(db.messageOwnerLessonIds(row.id)), []).map((lesson) => (lesson.missing
    ? { id: lesson.id, title: "", status: "deleted", missing: true }
    : { id: String(lesson.id), title: lessonTitle(lesson), status: String(lesson.status), missing: false }));
  const teachable = String(row?.direction) === "out" && !String(row?.operator || "").trim();
  if (!canTeach) return { canTeach: false, canApprove: false, used, teachable, taughtHere: [], suggestedTopic: "" };
  const customer = safe(() => db.getCustomer(row.customer_id), null);
  return {
    canTeach, teachable, used,
    canApprove: hasOperatorCapability(operator, LESSON_APPROVE_CAPABILITY),
    paused: ownerLessonsPaused(db),
    taughtHere: safe(() => db.ownerLessonsTaughtFrom(row.id), []).map((lesson) => ({
      id: String(lesson.id), title: lessonTitle(lesson), teaching: String(lesson.teaching || ""), status: String(lesson.status),
    })),
    suggestedTopic: teachable ? suggestLessonTopic(sourceTurnTexts(db, row, customer)) : "",
    limits: { teaching: LIMITS.teaching, topic: LIMITS.topic },
  };
}

export function createLessonRoutes({ db, config = {}, channels = [], notifier = null, logger = console }) {
  const channelIds = new Set((Array.isArray(channels) ? channels : []).map((channel) => String(channel.id)));
  const writer = createOwnerLessonWriter({ db, config, notifier, logger });
  const audit = writer.audit;

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "lessons") return false;
    const { json, operator, username, requireCsrf } = ctx;
    const reply = (status, payload) => {
      json(res, status, payload);
      return true;
    };
    // จอสอนปิด = แผงทำไมตอบแบบนี้ไม่มี จึงไม่มีทางสอน — เส้นนี้ต้องเหมือนไม่มีอยู่จริง (404 ไม่ใช่ 403)
    if (config.teachEnabled !== true) return reply(404, { ok: false, error: "ไม่พบเส้นทางนี้" });
    if (!hasOperatorCapability(operator, LESSON_TEACH_CAPABILITY)) return reply(403, { ok: false, error: DENY });
    const canApprove = hasOperatorCapability(operator, LESSON_APPROVE_CAPABILITY);
    if (req.method !== "GET" && !requireCsrf()) return reply(403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
    const body = req.method === "POST" ? await ctx.readJson(req).catch(() => ({})) : {};

    if (req.method === "GET" && route.length === 1) {
      const viewer = canApprove ? null : username;
      const page = db.listOwnerLessons({
        status: String(url.searchParams.get("status") || ""), q: String(url.searchParams.get("q") || ""),
        viewer, offset: url.searchParams.get("offset"),
      });
      const names = new Map(safe(() => db.listOperators(), []).map((op) => [String(op.username), String(op.display_name || op.username)]));
      return reply(200, {
        ok: true, lessons: page.rows.map((row) => publicLesson(row, names)), hasMore: page.hasMore, offset: page.offset,
        counts: db.countOwnerLessons({ viewer }), paused: ownerLessonsPaused(db), canApprove, username,
        channels: (Array.isArray(channels) ? channels : []).map((channel) => ({ id: String(channel.id), name: String(channel.name || channel.id) })),
        limits: { teaching: LIMITS.teaching, topic: LIMITS.topic },
      });
    }
    if (req.method === "POST" && route.length === 1) return createFromMessage(body, { reply, username, canApprove });
    if (req.method === "POST" && route[1] === "pause" && route.length === 2) {
      if (!canApprove) return reply(403, { ok: false, error: DENY });
      const paused = body?.paused === true;
      db.setSetting(OWNER_LESSONS_PAUSED_KEY, paused ? "1" : "0");
      audit(username, paused ? "lessons_paused" : "lessons_resumed", "owner_lessons", "");
      return reply(200, { ok: true, paused });
    }

    const lesson = route[1] ? safe(() => db.getOwnerLesson(decodeURIComponent(route[1])), null) : null;
    if (!lesson) return reply(404, { ok: false, error: "ไม่พบบทเรียนนี้ (อาจถูกลบไปแล้ว)" });
    const ownPending = lesson.created_by === username && lesson.status === "pending";

    if (req.method === "DELETE" && route.length === 2) {
      if (!canApprove && !ownPending) return reply(403, { ok: false, error: DENY });
      db.deleteOwnerLesson(lesson.id);
      audit(username, ownPending && !canApprove ? "lesson_withdrawn" : "lesson_deleted", lesson.id, lessonTitle(lesson));
      return reply(200, { ok: true, deleted: true });
    }
    if (req.method === "POST" && route.length === 2) return editLesson(lesson, body, { reply, username, canApprove, ownPending });
    if (req.method === "POST" && route.length === 3) {
      if (!canApprove) return reply(403, { ok: false, error: DENY });
      if (route[2] === "approve" || route[2] === "decline") {
        // ทางเดียวกับปุ่มในสรุปบทเรียนทาง Telegram (ownerLessonStore.decide — 28 ก.ย. 2026)
        const decided = writer.decide(lesson.id, route[2], { username });
        if (!decided.ok) return reply(decided.httpStatus, { ok: false, error: decided.error });
        return reply(200, { ok: true, lesson: decided.lesson ? publicLesson(decided.lesson) : null });
      }
      if (route[2] === "enable") {
        if (lesson.status === "pending") return reply(409, { ok: false, error: "บทเรียนนี้ยังรออนุมัติ — กดอนุมัติแทนนะคะ" });
        const enabled = body?.enabled === true;
        db.setOwnerLessonEnabled(lesson.id, enabled, username);
        audit(username, enabled ? "lesson_enabled" : "lesson_disabled", lesson.id, lessonTitle(lesson));
        return reply(200, { ok: true, lesson: publicLesson(db.getOwnerLesson(lesson.id)) });
      }
    }
    return reply(404, { ok: false, error: "ไม่พบเส้นทางนี้" });
  }

  function createFromMessage(body, { reply, username, canApprove }) {
    if (!textFields(body, ["messageId", "teaching"], ["topic"])) return reply(400, { ok: false, error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" });
    const teaching = cleanLessonText(body?.teaching, LIMITS.teaching + 1);
    const topic = oneLine(body?.topic, LIMITS.topic);
    const invalid = lessonTeachingProblem(teaching);
    if (invalid) return reply(400, { ok: false, error: invalid });
    const row = safe(() => db.messageBrainContext(String(body?.messageId || "").slice(0, 200)), null);
    if (!row) return reply(404, { ok: false, error: "ไม่พบข้อความนี้" });
    // สอนได้จาก "คำตอบของลูกแพร" เท่านั้น — ข้อความลูกค้าหรือที่คนตอบเองไม่ใช่สิ่งที่ลูกแพรพูด
    if (String(row.direction) !== "out" || String(row.operator || "").trim()) {
      return reply(400, { ok: false, error: "สอนได้จากคำตอบของลูกแพรเท่านั้นค่ะ" });
    }
    const customer = safe(() => db.getCustomer(row.customer_id), null);
    // โหมดสมองแยกของสาขา = บทเรียนผูกสาขานั้น (ธุรกิจคนละแบบ) · โหมดกลาง = ใช้ทุกช่องทาง
    const channel = String(customer?.channel_id || "default");
    const result = writer.save({
      teaching, topic, username, canApprove,
      scope: brainModeOf(db, channel) === BRAIN_MODE_SEPARATE ? channel : null,
      customerNames: [customer?.known_name, customer?.display_name],
      sourceFields: () => lessonSourceFields(db, row, customer),
    });
    if (!result.ok) return reply(result.httpStatus, { ok: false, error: result.error });
    const warning = result.injectionWarning ? { injectionWarning: true } : {};
    if (result.duplicate) {
      return reply(200, { ok: true, duplicate: true, lesson: publicLesson(result.lesson), status: result.lessonStatus, message: result.message, ...warning });
    }
    return reply(200, { ok: true, lesson: publicLesson(result.lesson), status: result.lessonStatus, message: result.message, ...warning });
  }

  function editLesson(lesson, body, { reply, username, canApprove, ownPending }) {
    if (!canApprove && !ownPending) return reply(403, { ok: false, error: DENY });
    if (!textFields(body, [], ["teaching", "topic"])) return reply(400, { ok: false, error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" });
    const teaching = body?.teaching === undefined ? lesson.teaching : cleanLessonText(body.teaching, LIMITS.teaching + 1);
    const topic = body?.topic === undefined ? lesson.topic : oneLine(body.topic, LIMITS.topic);
    const invalid = lessonTeachingProblem(teaching);
    if (invalid) return reply(400, { ok: false, error: invalid });
    let scope = lesson.channel_id ?? null;
    if (body?.channelId !== undefined && canApprove) {
      scope = body.channelId === null || body.channelId === "" ? null : String(body.channelId);
      if (scope !== null && !channelIds.has(scope)) return reply(400, { ok: false, error: "ไม่รู้จักช่องทางนี้" });
    }
    const customer = lesson.customer_id ? safe(() => db.getCustomer(lesson.customer_id), null) : null;
    const refusal = lessonPrivacyRefusal(`${topic}\n${teaching}`, [customer?.known_name, customer?.display_name]);
    if (refusal) return reply(400, { ok: false, error: refusal });
    const key = lessonTeachingKey(teaching);
    const clash = safe(() => db.findOwnerLessonByKey(key, scope), null);
    if (clash && clash.id !== lesson.id) return reply(409, { ok: false, error: "มีบทเรียนที่สอนแบบเดียวกันอยู่แล้ว" });
    db.updateOwnerLesson(lesson.id, { teaching, teachingKey: key, topic, channelId: scope });
    audit(username, "lesson_edited", lesson.id, lessonTitle({ topic, teaching }));
    const warning = alteredInSystemBlock(teaching) ? { injectionWarning: true, message: LESSON_INJECTION_WARNING } : {};
    return reply(200, { ok: true, lesson: publicLesson(db.getOwnerLesson(lesson.id)), ...warning });
  }

  return { handle };
}

// ช่องข้อความต้องเป็นสตริงจริง — {} ที่ยิง API ตรง ๆ ไม่ควรกลายเป็นบทเรียน "[object Object]"
function textFields(body, required, optional) {
  if (!body || typeof body !== "object") return false;
  return required.every((key) => typeof body[key] === "string")
    && optional.every((key) => body[key] === undefined || typeof body[key] === "string");
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
