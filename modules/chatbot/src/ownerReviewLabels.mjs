// ownerReviewLabels.mjs — ป้ายของคนในคิวตรวจแชทรายวัน + "ต้องปรับ" → บทเรียนของลูกแพร (ห้องตรวจ เฟส B · 12 ต.ค. 2026)
//
// พี่ง้วง: "พี่ง้วงกับชมพู่ยืนยันว่าแต่ละแชทตอบดีแล้ว หรือต้องปรับอะไร (เหมือนที่เราเคยเทส) แล้วลูกแพรเรียนจากตรงนี้"
//   · ดีแล้ว / ต้องปรับ = ป้ายต่อห้อง (compare-and-set ด้วย revision — สองเครื่องกดพร้อมกันได้ผลเดียว) · ย้อนได้ใน 10 วิ
//   · ต้องปรับ → แตะฟองที่ผิด → ชิปเหตุผล + "ควรตอบว่า…" → บทเรียนผ่านด่านเดียวกับแผง "ทำไมตอบแบบนี้" (ownerLessonStore)
//     เจ้าของสอน = ใช้ทันที (พฤติกรรมเดิมของบทเรียน — คำตอบบอกตรง ๆ) · ชมพู่สอน = รอพี่ง้วงอนุมัติ
//   · ดีที่เหลือทั้งหมด = ห้องที่ AI อ่านแล้ว ไม่น่าห่วง และไม่ได้ถูกสุ่มวัดผล (ป้าย bulk ไม่นับในตัวเลขความแม่นของ AI)
//   · เห็นด้วย/ไม่เห็นด้วยกับปัญหาที่ AI ชี้ = ตัวเลขความแม่นต่อรหัส
// ไฟล์นี้ไม่รู้จัก HTTP — คืน {status, body} ให้ consoleOwnerReviewDailyApi แปลงเป็นคำตอบ · audit ไม่มีเนื้อหาแชท
import { randomUUID } from "node:crypto";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { lessonSourceFields } from "./consoleLessonsApi.mjs";
import { BRAIN_MODE_SEPARATE, brainModeOf } from "./knowledgePack.mjs";
import { OWNER_LESSON_LIMITS, cleanLessonText, lessonTitle, ownerLessonsPaused } from "./ownerLessons.mjs";
import { createOwnerLessonWriter, lessonTeachingProblem } from "./ownerLessonStore.mjs";
import { OWNER_CLOSE_UNDO_MS } from "./ownerCloseService.mjs";
import { maskPersonalText } from "./qualifyPrompt.mjs";
import { OWNER_REVIEW_LABELS } from "./dbOwnerReviewItems.mjs";

export const OWNER_REVIEW_UNDO_MS = OWNER_CLOSE_UNDO_MS;
export const OWNER_REVIEW_BETTER_REPLY_MAX = 500;
// "ควรตอบว่า…" ต้องมีตัวอักษร/ตัวเลขอย่างน้อยเท่านี้ถึงเป็นบทเรียน (รีวิว 13 ต.ค.: "." หรือ "ok" เคยกลายเป็นบทเรียนที่ใช้ทันที
// และติดไปกับทุกเทิร์นของลูกแพร) — หน้าเว็บใช้เกณฑ์เดียวกันตอนเปิดปุ่มบันทึก (ส่งไปใน GET /daily)
export const OWNER_REVIEW_BETTER_REPLY_MIN = 6;
const MEANINGFUL_CHAR_RE = /[\p{L}\p{N}]/gu;

/**
 * ชิปเหตุผลของ "ต้องปรับ" (สัญญากับหน้าเว็บ — key ห้ามเปลี่ยน) · code = รหัสปัญหาที่ตรงกัน · teach = คำสอนที่ลูกแพรได้
 */
export const OWNER_REVIEW_FIX_CHIPS = Object.freeze([
  Object.freeze({ key: "curt", label: "ห้วนไป", code: "curt_or_robotic", teach: "ตอบให้อบอุ่นเป็นธรรมชาติแบบคนคุยแชท ไม่ห้วน ไม่แข็งเหมือนบอท" }),
  Object.freeze({ key: "missed_question", label: "ไม่ตอบคำถาม", code: "missed_question", teach: "ตอบคำถามที่ลูกค้าถามให้ตรงก่อน แล้วค่อยชวนคุยต่อ" }),
  Object.freeze({ key: "tell_price", label: "ควรบอกราคา", code: "ignored_request", teach: "ลูกค้าถามราคาตรง ๆ ให้ตอบราคาได้เลย พร้อมบอกว่าได้อะไรและคุ้มยังไง" }),
  Object.freeze({ key: "no_media", label: "ไม่ควรส่งรูป/รีวิว", code: "wrong_image_or_review", teach: "จังหวะนี้ไม่ต้องส่งรูปหรือรีวิว ตอบเป็นข้อความก่อน" }),
  Object.freeze({ key: "repeated", label: "ถามซ้ำ", code: "repeated_question", teach: "อย่าถามสิ่งที่ลูกค้าบอกไปแล้ว ใช้ข้อมูลที่ลูกค้าให้มาต่อได้เลย" }),
  Object.freeze({ key: "too_long", label: "ยาวไป", code: "over_long", teach: "ตอบให้สั้นกระชับแบบแชท อ่านจบในไม่กี่บรรทัด" }),
  Object.freeze({ key: "wrong_fact", label: "ข้อมูลผิด", code: "wrong_fact", teach: "ตอบให้ตรงกับข้อมูลที่อนุมัติไว้เท่านั้น ห้ามเดาตัวเลขหรือรายละเอียดเอง" }),
]);
const CHIP_BY_KEY = new Map(OWNER_REVIEW_FIX_CHIPS.map((chip) => [chip.key, chip]));
const CHIP_KEY_RE = /^[a-z_]{1,30}$/u;

// ข้อความตอบกลับของคอนโซล (ภาษาไทย) — code คือสัญญากับหน้าเว็บ ห้ามเปลี่ยนชื่อ
const MESSAGES = Object.freeze({
  not_found: "ไม่พบห้องนี้ในคิวตรวจ (อาจถูกลบตามสิทธิ์ให้ลืม)",
  bad_request: "คำขอไม่ถูกต้อง",
  not_ready: "คิวรอบนี้ยังเตรียมไม่เสร็จ — รอสักครู่นะคะ",
  not_queued: "ห้องนี้ไม่ได้อยู่ในคิวตรวจของรอบนี้",
  stale_revision: "มีคนตรวจห้องนี้ไปก่อนแล้ว — โหลดใหม่ก่อนนะคะ",
  not_undoable: "ย้อนได้เฉพาะป้ายที่ตัวเองเพิ่งกดเท่านั้น",
  undo_expired: "เลย 10 วินาทีแล้ว ย้อนไม่ได้ — กดป้ายใหม่ได้เลย",
  not_fixable: "แตะได้เฉพาะข้อความของลูกแพรในแชทวันนี้ของห้องนี้",
  fix_empty: "เลือกเหตุผล หรือพิมพ์ว่าควรตอบว่าอะไรก่อนนะคะ",
  fix_reply_short: "คำตอบที่ควรเป็นสั้นไปจนลูกแพรเรียนไม่ได้ — พิมพ์ให้ชัดอีกนิด หรือเลือกเหตุผลก่อนนะคะ",
  lesson_refused: "บันทึกบทเรียนไม่ได้",
  unknown_issue: "ไม่พบปัญหานี้ในผลตรวจของ AI",
  flagged_remaining: "ยังมีห้องน่าห่วงที่ยังไม่ได้ตรวจ — ตรวจห้องน่าห่วงให้ครบก่อนนะคะ",
  nothing_left: "ไม่มีห้องที่เหลือให้กดแล้ว",
  forbidden: "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้",
});

const refusal = (status, code, extra = {}) => ({ status, body: { ok: false, code, error: MESSAGES[code] || code, ...extra } });
const okResult = (body) => ({ status: 200, body: { ok: true, ...body } });

/** ตัวเลขรุ่นที่คอนโซลส่งมา — จำนวนเต็มไม่ติดลบ (ไม่ส่ง = คำขอไม่ถูกต้อง) */
export function parseRevision(value) {
  const number = typeof value === "number" ? value : (typeof value === "string" && /^\d{1,9}$/u.test(value) ? Number(value) : NaN);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function parseJsonList(text) {
  try {
    const parsed = JSON.parse(String(text || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const issueKeyOf = (issue) => `${String(issue?.code || "")}@${String(issue?.messageId || "")}`;

/**
 * "ควรตอบว่า…" ที่ใช้เป็นบทเรียนได้ (pure) — ผ่านด่านความยาวเดียวกับการสอนปกติ และมีตัวอักษร/ตัวเลข ≥ OWNER_REVIEW_BETTER_REPLY_MIN
 * @returns {string} ข้อความที่ล้างแล้ว · "" = ใช้ไม่ได้ (ว่าง จุด ok อีโมจิล้วน ฯลฯ)
 */
export function meaningfulBetterReply(value) {
  const reply = cleanLessonText(String(value ?? ""), OWNER_REVIEW_BETTER_REPLY_MAX).replace(/\s+/gu, " ").trim();
  if (!reply || lessonTeachingProblem(reply)) return "";
  return (reply.match(MEANINGFUL_CHAR_RE) || []).length >= OWNER_REVIEW_BETTER_REPLY_MIN ? reply : "";
}

/**
 * คำสอนจากชิป + "ควรตอบว่า…" (pure) — ยาวไม่เกินเพดานบทเรียน
 * @returns {{teaching: string, topic: string, labels: string[]}}
 */
export function composeFixLesson(chipKeys = [], betterReply = "") {
  const chips = chipKeys.map((key) => CHIP_BY_KEY.get(key)).filter(Boolean);
  const reply = cleanLessonText(betterReply, OWNER_REVIEW_BETTER_REPLY_MAX).replace(/\s+/gu, " ").trim();
  const parts = chips.map((chip) => chip.teach);
  if (reply) parts.push(`ในสถานการณ์แบบนี้ควรตอบประมาณว่า: ${reply}`);
  const teaching = cleanLessonText(parts.join(" · "), OWNER_LESSON_LIMITS.teaching);
  const labels = chips.map((chip) => chip.label);
  return { teaching, topic: cleanLessonText(labels.join(" · "), OWNER_LESSON_LIMITS.topic), labels };
}

export function createOwnerReviewLabelService({ db, config = {}, notifier = null, logger = console, now = Date.now } = {}) {
  const writer = createOwnerLessonWriter({ db, config, notifier, logger });
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  function audit(username, action, target, detail) {
    try {
      db.addAudit({ operator: String(username || "system:owner_review"), action, target: String(target || ""), detail: String(detail).slice(0, 300) });
    } catch (err) {
      logger.warn?.(`owner-review: บันทึก audit ไม่สำเร็จ (${err?.message || err})`);
    }
  }

  // ห้องในคิวที่ติดป้ายได้: รอบพร้อมแล้ว + ห้องอยู่ในคิว
  function labelable(item) {
    const batch = safe(() => db.ownerReviewBatch(item.batch_id), null);
    if (!batch || batch.kind !== "daily") return refusal(404, "not_found");
    if (batch.status !== "ready") return refusal(409, "not_ready");
    if (item.included === "none") return refusal(409, "not_queued");
    return null;
  }

  const namesOf = (customerId) => {
    const row = safe(() => db.getCustomer(customerId), null);
    return { row, names: [row?.display_name, row?.known_name] };
  };

  /** ดีแล้ว / ต้องปรับ (ไม่ผ่านฟอง) — note = โน้ตสั้นของคนตรวจ (ปิดชื่อ/เบอร์/อีเมลของห้องนั้นก่อนเก็บ) */
  function label({ item, label: value, revision, note = "", operator } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    const expected = parseRevision(revision);
    if (!username || expected === null) return refusal(400, "bad_request", { field: "revision" });
    if (!OWNER_REVIEW_LABELS.includes(value)) return refusal(400, "bad_request", { field: "label" });
    if (typeof note !== "string") return refusal(400, "bad_request", { field: "note" });
    const blocked = labelable(item);
    if (blocked) return blocked;
    const t = Number(now());
    const { names } = namesOf(item.customer_id);
    const updated = db.casOwnerReviewItemLabel(item.id, {
      expectedRevision: expected, label: value, note: maskPersonalText(note, names), via: "single", by: username, at: t,
    });
    if (!updated) return refusal(409, "stale_revision", { revision: Number(db.ownerReviewItem(item.id)?.revision) || 0 });
    audit(username, "owner_review_labelled", item.id, `${value} · via=single`);
    return okResult({ item: updated, undoUntil: t + OWNER_REVIEW_UNDO_MS });
  }

  /** ย้อนป้ายที่ตัวเองเพิ่งกด (10 วิ) — ป้ายจาก "ต้องปรับ" ถอนบทเรียนที่เพิ่งสร้างใหม่ในครั้งนั้นด้วย */
  function undo({ item, revision, operator } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    const expected = parseRevision(revision);
    if (!username || expected === null) return refusal(400, "bad_request", { field: "revision" });
    if (!item.label || item.label_via === "bulk" || String(item.labelled_by) !== username) return refusal(409, "not_undoable");
    const at = Number(item.labelled_at) || 0;
    if (Number(now()) - at > OWNER_REVIEW_UNDO_MS) return refusal(409, "undo_expired");
    const lessons = parseJsonList(item.lesson_ids_json);
    const withdraw = item.label_via === "fix"
      ? lessons.filter((entry) => entry?.created === true && Number(entry?.at) === at && String(entry?.by) === username)
      : [];
    const keep = lessons.filter((entry) => !withdraw.includes(entry));
    const updated = db.casOwnerReviewItemLabel(item.id, { expectedRevision: expected, label: null, lessonIds: keep });
    if (!updated) return refusal(409, "stale_revision", { revision: Number(db.ownerReviewItem(item.id)?.revision) || 0 });
    let withdrawn = 0;
    for (const entry of withdraw) {
      const lesson = safe(() => db.getOwnerLesson(String(entry.id)), null);
      if (!lesson || String(lesson.created_by) !== username) continue;
      if (safe(() => db.deleteOwnerLesson(lesson.id), false)) {
        withdrawn += 1;
        writer.audit(username, "lesson_withdrawn", lesson.id, lessonTitle(lesson));
      }
    }
    audit(username, "owner_review_label_undone", item.id, `withdrawn=${withdrawn}`);
    return okResult({ item: updated, lessonsWithdrawn: withdrawn });
  }

  // ฟองที่สอนได้ = ข้อความที่ลูกแพรเขียนเองในช่วงของห้องนี้ (ข้อความอัตโนมัติ/คำลาหลังปิด/ของทีมงาน สอนไม่ได้)
  function fixTarget(item, messageId) {
    if (typeof messageId !== "string" || !messageId || messageId.length > 200) return null;
    const row = safe(() => db.messageBrainContext(messageId), null);
    if (!row || String(row.customer_id) !== String(item.customer_id)) return null;
    if (String(row.direction) !== "out" || String(row.operator || "").trim()) return null;
    if (!safe(() => db.isLukpraeWrittenMessage(messageId), false)) return null;
    const at = Number(row.created_at) || 0;
    if (at <= Number(item.window_start_ms) || at > Number(item.window_end_ms)) return null;
    return row;
  }

  function lessonOutcome(saved, { teachOn, paused }) {
    if (!teachOn) {
      return { lesson: null, lessonStatus: "teach_off", appliesNow: false,
        message: "บันทึกว่าต้องปรับแล้ว — ระบบสอนลูกแพรปิดอยู่ ลูกแพรยังไม่ได้เรียนเรื่องนี้" };
    }
    const status = String(saved.lessonStatus || saved.lesson?.status || "");
    const appliesNow = status === "active" && !paused;
    let message = String(saved.message || "");
    if (status === "active" && paused) message += " · ตอนนี้พักการใช้บทเรียนอยู่ ลูกแพรจะเริ่มใช้เมื่อเปิดอีกครั้ง";
    if (status === "pending") message = `${message} — ลูกแพรจะใช้เมื่อพี่ง้วงอนุมัติ`;
    return {
      lesson: saved.lesson ? { id: String(saved.lesson.id), title: lessonTitle(saved.lesson), status: String(saved.lesson.status) } : null,
      lessonStatus: status, appliesNow, duplicate: saved.duplicate === true, message,
      ...(saved.injectionWarning ? { injectionWarning: true } : {}),
    };
  }

  /**
   * ต้องปรับ + สอนจากฟอง — {messageId, reasonChips[], betterReply} → บทเรียน + ป้าย needs_fix (via fix)
   * เจ้าของ (lessons.approve) = บทเรียนใช้ทันที · คนอื่น = รอเจ้าของอนุมัติ · ระบบสอนปิด (TEACH_ENABLED) = บันทึกป้ายอย่างเดียว
   */
  function fix({ item, messageId, reasonChips = [], betterReply = "", revision, operator } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    const expected = parseRevision(revision);
    if (!username || expected === null) return refusal(400, "bad_request", { field: "revision" });
    if (!Array.isArray(reasonChips) || reasonChips.length > OWNER_REVIEW_FIX_CHIPS.length
      || !reasonChips.every((key) => typeof key === "string" && CHIP_KEY_RE.test(key) && CHIP_BY_KEY.has(key))) {
      return refusal(400, "bad_request", { field: "reasonChips" });
    }
    if (typeof betterReply !== "string" || Array.from(betterReply).length > OWNER_REVIEW_BETTER_REPLY_MAX) {
      return refusal(400, "bad_request", { field: "betterReply" });
    }
    const chips = [...new Set(reasonChips)];
    // คำตอบที่สั้น/ว่างจนไม่ใช่คำสอน: มีชิป = ทิ้งคำตอบ ใช้ชิปอย่างเดียว · ไม่มีชิป = ไม่บันทึก (ของเจ้าของใช้ทันทีทุกเทิร์น)
    const reply = meaningfulBetterReply(betterReply);
    if (!chips.length && !reply) {
      return betterReply.trim()
        ? refusal(400, "fix_empty", { field: "betterReply", error: MESSAGES.fix_reply_short })
        : refusal(400, "fix_empty");
    }
    const blocked = labelable(item);
    if (blocked) return blocked;
    if (Number(item.revision) !== expected) return refusal(409, "stale_revision", { revision: Number(item.revision) || 0 });
    const target = fixTarget(item, messageId);
    if (!target) return refusal(400, "not_fixable");
    const { row: customer, names } = namesOf(item.customer_id);
    const composed = composeFixLesson(chips, reply);
    const teachOn = config.teachEnabled === true;
    const canApprove = hasOperatorCapability(operator, "lessons.approve");
    let saved = null;
    if (teachOn) {
      const channel = String(customer?.channel_id || item.channel_id || "default");
      saved = writer.save({
        teaching: composed.teaching, topic: composed.topic, username, canApprove,
        scope: safe(() => brainModeOf(db, channel), "") === BRAIN_MODE_SEPARATE ? channel : null,
        customerNames: names, sourceFields: () => lessonSourceFields(db, target, customer),
      });
      if (!saved.ok) return refusal(saved.httpStatus === 409 ? 409 : 400, "lesson_refused", { error: saved.error });
    }
    const t = Number(now());
    const lessons = parseJsonList(item.lesson_ids_json);
    const entry = saved?.lesson ? [{ id: String(saved.lesson.id), at: t, by: username, created: saved.duplicate !== true, messageId: String(target.id) }] : [];
    const note = [composed.labels.join(" · "), reply ? `ควรตอบว่า: ${reply}` : ""].filter(Boolean).join(" — ");
    const updated = db.casOwnerReviewItemLabel(item.id, {
      expectedRevision: expected, label: "needs_fix", note: maskPersonalText(note, names), via: "fix", by: username, at: t,
      lessonIds: [...lessons, ...entry],
    });
    if (!updated) {
      // ระหว่างทาง (ซิงโครนัสทั้งก้อน) ไม่ควรมีใครแทรก — ถ้าเกิดจริง ถอนบทเรียนที่เพิ่งสร้าง ไม่ให้มีบทเรียนที่ไม่มีป้ายรองรับ
      if (entry[0]?.created) safe(() => db.deleteOwnerLesson(entry[0].id), false);
      return refusal(409, "stale_revision", { revision: Number(db.ownerReviewItem(item.id)?.revision) || 0 });
    }
    audit(username, "owner_review_labelled", item.id, `needs_fix · via=fix · chips=${chips.join(",")}${reply || !betterReply.trim() ? "" : " · reply_dropped"}`);
    const paused = safe(() => ownerLessonsPaused(db), false);
    return okResult({
      item: updated, ...lessonOutcome(saved ?? {}, { teachOn, paused }), undoUntil: t + OWNER_REVIEW_UNDO_MS,
      ...(reply || !betterReply.trim() ? {} : { replyDropped: true }),
    });
  }

  /** เห็นด้วย/ไม่เห็นด้วยกับปัญหาที่ AI ชี้ (verdict null = ถอน) */
  function verdict({ item, issueKey, verdict: value, operator } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    if (!username || typeof issueKey !== "string" || issueKey.length > 200) return refusal(400, "bad_request", { field: "issueKey" });
    if (value !== null && value !== "agree" && value !== "disagree") return refusal(400, "bad_request", { field: "verdict" });
    const issues = parseJsonList(item.issues_json);
    if (!issues.some((issue) => issueKeyOf(issue) === issueKey)) return refusal(404, "unknown_issue");
    const updated = db.setOwnerReviewItemVerdict(item.id, issueKey, value);
    if (!updated) return refusal(404, "not_found");
    return okResult({ item: updated });
  }

  /**
   * ดีที่เหลือทั้งหมด — ต้องตรวจห้องน่าห่วงครบก่อน · ห้องที่ถูกสุ่มวัดผล / AI ชี้จุดไว้ ไม่รวม (ต้องดูทีละห้อง)
   * exceptId = การ์ดที่เปิดอยู่บนจอ (ไม่ติดป้ายห้องที่คนกำลังอ่าน)
   */
  function goodRest({ batch, operator, channels = null, exceptId = "" } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    if (!username) return refusal(400, "bad_request");
    if (exceptId !== "" && (typeof exceptId !== "string" || !/^[\w-]{1,80}$/u.test(exceptId))) return refusal(400, "bad_request", { field: "exceptId" });
    if (!batch || batch.kind !== "daily") return refusal(404, "not_found");
    if (batch.status !== "ready") return refusal(409, "not_ready");
    const counts = db.ownerReviewBatchItemCounts(batch.id, { channels });
    if (counts.flaggedRemaining > 0) return refusal(409, "flagged_remaining", { flaggedRemaining: counts.flaggedRemaining });
    if (!counts.bulkEligible) return refusal(409, "nothing_left");
    const t = Number(now());
    const bulkId = randomUUID();
    const labelled = db.bulkLabelOwnerReviewItems(batch.id, { channels, by: username, at: t, bulkId, exceptId });
    if (!labelled) return refusal(409, "nothing_left");
    audit(username, "owner_review_bulk_good", batch.id, `labelled=${labelled}`);
    return okResult({ labelled, bulkId, undoUntil: t + OWNER_REVIEW_UNDO_MS });
  }

  function undoGoodRest({ batch, bulkId, operator } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    if (!username || typeof bulkId !== "string" || !/^[\w-]{8,80}$/u.test(bulkId)) return refusal(400, "bad_request", { field: "bulkId" });
    if (!batch || batch.kind !== "daily") return refusal(404, "not_found");
    const at = db.ownerReviewBulkLabelledAt(batch.id, bulkId);
    if (!at) return refusal(409, "not_undoable");
    if (Number(now()) - at > OWNER_REVIEW_UNDO_MS) return refusal(409, "undo_expired");
    const reverted = db.undoBulkOwnerReviewItems(batch.id, { bulkId, by: username });
    if (!reverted) return refusal(409, "not_undoable");
    audit(username, "owner_review_bulk_undone", batch.id, `reverted=${reverted}`);
    return okResult({ reverted });
  }

  return { label, undo, fix, verdict, goodRest, undoGoodRest };
}
