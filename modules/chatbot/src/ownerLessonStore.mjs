// ownerLessonStore.mjs — ทางบันทึกบทเรียนเส้นเดียว ใช้ร่วมกันระหว่างคอนโซลกับ Telegram (28 ก.ย. 2026)
//
// เดิมทั้งหมดนี้อยู่ใน consoleLessonsApi.mjs (สอนจากแผง "ทำไมตอบแบบนี้" ใต้ฟองของลูกแพร)
// พี่ง้วงขอให้สอนลูกแพรผ่านแชท Telegram ได้ด้วย ("ต่อไปถ้าลูกค้าถามเรื่อง… ให้ตอบ…") — ย้ายด่านมาไว้ที่นี่
// ให้สองทางเข้าใช้ด่านชุดเดียวกันทุกข้อ ไม่มีสำเนาที่สองให้เพี้ยน:
//   · ความยาว (lessonTeachingProblem) · ความเป็นส่วนตัว (lessonPrivacyRefusal — เบอร์/อีเมล/เลขยาว/ชื่อลูกค้า)
//   · กันซ้ำด้วย teaching_key (สอนเรื่องเดิม = แถวเดียว ผลขึ้นกับว่าใครสอนซ้ำ) · เพดาน 1,000 เรื่อง
//   · เจ้าของ (lessons.approve) = ใช้ทันที · คนอื่น = รอเจ้าของอนุมัติ + ปลุกเจ้าของ · audit ทุกครั้ง
// ไฟล์นี้ไม่รู้จัก HTTP — คืนผลเป็น object ให้ผู้เรียกแปลงเป็นคำตอบของตัวเอง (JSON หรือข้อความ Telegram)
import {
  OWNER_LESSON_LIMITS as LIMITS, lessonPrivacyRefusal, lessonTeachingKey, lessonTitle, oneLine,
} from "./ownerLessons.mjs";
import { alteredInSystemBlock } from "./promptInjection.mjs";

export const LESSON_SAVED_ACTIVE = "บันทึกแล้ว — ลูกแพรจะใช้กับเรื่องคล้ายกันตั้งแต่ข้อความถัดไป";
export const LESSON_SAVED_PENDING = "ส่งให้พี่ง้วงอนุมัติแล้ว";
// รีวิวรอบ 4: บทเรียนที่มีโทเคนพิเศษ/คำ handshake (เช่นยกตัวอย่าง <|im_start|>) ถูกตัวตัดข้อความหลอกระบบตัดก่อนถึงโมเดล — เตือนตอนบันทึก
export const LESSON_INJECTION_WARNING = "หมายเหตุ: บทเรียนนี้มีโค้ดสั่งโมเดล (เช่น <|im_start|> หรือ [INST]) ส่วนนั้นจะถูกตัดออกก่อนถึงลูกแพร "
  + "— ถ้าอยากสอนเรื่องนี้ ให้เขียนเป็นคำอธิบายธรรมดาแทนนะคะ";

/** ผลบันทึก + คำเตือนเมื่อบางส่วนของคำสอนจะถูกตัดก่อนถึงโมเดล (บทเรียนอยู่ในบล็อก system ต่อเทิร์น) */
export function withInjectionWarning(result, teaching) {
  if (!result?.ok || !alteredInSystemBlock(teaching)) return result;
  return { ...result, injectionWarning: true, message: `${result.message} · ${LESSON_INJECTION_WARNING}` };
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

/** ข้อความผิดของคำสอน (สั้น/ว่าง/ยาวเกิน) — "" = ผ่าน */
export function lessonTeachingProblem(teaching) {
  const length = [...String(teaching || "")].length;
  // จุด/เครื่องหมายล้วน ๆ ไม่ใช่คำสอน และจะชนกุญแจกันซ้ำว่าง ๆ ของคนอื่น
  if (length < LIMITS.minTeaching || !lessonTeachingKey(teaching)) return "พิมพ์สิ่งที่อยากสอนลูกแพรก่อนนะคะ";
  if (length > LIMITS.teaching) return `บทเรียนยาวได้ไม่เกิน ${LIMITS.teaching} ตัวอักษร — แบ่งเป็นหลายเรื่องได้นะคะ`;
  return "";
}

export function createOwnerLessonWriter({ db, config = {}, notifier = null, logger = console }) {
  // audit ไม่เก็บคำลูกค้า/คำตอบเดิม — เก็บแค่หัวข้อที่คนของเราพิมพ์ (ผ่านด่านความเป็นส่วนตัวแล้ว)
  function audit(operatorName, action, target, detail) {
    try { db.addAudit({ operator: operatorName, action, target, detail: oneLine(detail, 80) }); }
    catch (err) { logger.debug?.(`lessons: เขียน audit ไม่สำเร็จ (${err?.message || err})`); }
  }

  // ปลุกเจ้าของเหมือนคิวขออนุมัติ — ไม่ force: สอนรัว ๆ สิบเรื่องได้แจ้งเตือนเดียวต่อ 10 นาที
  function notifyOwner(by, lesson) {
    try {
      const pending = db.countOwnerLessons({ viewer: null }).pending;
      const link = config.consolePublicBaseUrl ? `\n👉 ${config.consolePublicBaseUrl}/#/lessons` : "";
      notifier?.fireLater?.({
        customerId: "ops:lessons", channelId: "default", reason: "lesson_pending",
        reasonTextOverride: `${oneLine(by, 40)} สอนลูกแพรเรื่อง "${lessonTitle(lesson)}" รอพี่ง้วงอนุมัติ`
          + `\nรออนุมัติทั้งหมด ${pending} เรื่อง — เปิดเมนู "บทเรียน" เพื่ออนุมัติหรือไม่อนุมัติ${link}`,
      });
    } catch (err) {
      logger.debug?.(`lessons: แจ้งเจ้าของไม่สำเร็จ (${err?.message || err})`);
    }
  }

  // สอนเรื่องเดิมซ้ำ = เก็บแถวเดียว (unique index กันไว้อีกชั้น) — ผลลัพธ์ขึ้นกับว่าใครสอนซ้ำ
  function settleDuplicate(existing, { username, auditAs, canApprove }) {
    let message = "";
    if (existing.status === "active") message = "มีบทเรียนนี้อยู่แล้ว — ลูกแพรใช้อยู่แล้วค่ะ";
    else if (canApprove) {
      if (existing.status === "pending") db.approveOwnerLesson(existing.id, username);
      else db.setOwnerLessonEnabled(existing.id, true, username);
      audit(auditAs, existing.status === "pending" ? "lesson_approved" : "lesson_enabled", existing.id, lessonTitle(existing));
      message = LESSON_SAVED_ACTIVE;
    } else if (existing.status === "pending") message = "บทเรียนนี้รอพี่ง้วงอนุมัติอยู่แล้วค่ะ";
    else {
      db.requeueOwnerLesson(existing.id, username);
      audit(auditAs, "lesson_proposed", existing.id, lessonTitle(existing));
      notifyOwner(username, existing);
      message = LESSON_SAVED_PENDING;
    }
    const lesson = db.getOwnerLesson(existing.id);
    return { ok: true, httpStatus: 200, duplicate: true, lesson, lessonStatus: lesson.status, message };
  }

  /**
   * ตรวจโดยไม่เขียนอะไร — Telegram ใช้ก่อนโชว์ปุ่มยืนยัน (ไม่ถามให้กดสิ่งที่จะถูกปฏิเสธอยู่ดี)
   * @returns {{ok: boolean, error?: string, duplicateOf?: object|null}}
   */
  function check({ teaching, topic = "", scope = null, customerNames = [] }) {
    const invalid = lessonTeachingProblem(teaching);
    if (invalid) return { ok: false, error: invalid };
    const refusal = lessonPrivacyRefusal(`${topic}\n${teaching}`, customerNames);
    if (refusal) return { ok: false, error: refusal };
    return { ok: true, duplicateOf: safe(() => db.findOwnerLessonByKey(lessonTeachingKey(teaching), scope), null) };
  }

  /**
   * บันทึกบทเรียนหนึ่งเรื่อง (ด่านเดียวกันทุกทางเข้า)
   * - username = บัญชีคอนโซลที่เป็นเจ้าของคำสอน (created_by — หน้า "บทเรียน" โชว์ชื่อคนนี้)
   * - auditAs  = ชื่อที่จดใน audit (Telegram ใช้ "telegram:<username>" ให้เห็นที่มา)
   * - sourceFields() = คำลูกค้า/คำตอบเดิม/ตัวชี้ห้อง — เรียกเฉพาะตอนเขียนแถวใหม่จริง
   */
  function save({
    teaching, topic = "", scope = null, username, auditAs = username, canApprove = false,
    customerNames = [], sourceFields = () => ({}),
  }) {
    const checked = check({ teaching, topic, scope, customerNames });
    if (!checked.ok) return { ok: false, httpStatus: 400, error: checked.error };
    const key = lessonTeachingKey(teaching);
    if (checked.duplicateOf) return withInjectionWarning(settleDuplicate(checked.duplicateOf, { username, auditAs, canApprove }), teaching);
    if (db.countOwnerLessonsTotal() >= LIMITS.maxRows) {
      return { ok: false, httpStatus: 409, error: `บทเรียนเต็ม ${LIMITS.maxRows.toLocaleString("th-TH")} เรื่องแล้ว — ลบเรื่องที่ไม่ใช้แล้วก่อนนะคะ` };
    }
    const status = canApprove ? "active" : "pending";
    const source = sourceFields() || {};
    const lesson = db.addOwnerLesson({
      channelId: scope, teaching, teachingKey: key, topic, status, createdBy: username,
      customerText: String(source.customerText || ""), aiText: String(source.aiText || ""),
      sourceMessageId: String(source.sourceMessageId || ""), customerId: String(source.customerId || ""),
    });
    audit(auditAs, status === "active" ? "lesson_saved" : "lesson_proposed", lesson.id, lessonTitle(lesson));
    if (status === "pending") notifyOwner(username, lesson);
    return withInjectionWarning({
      ok: true, httpStatus: 200, duplicate: false, lesson, lessonStatus: status,
      message: status === "active" ? LESSON_SAVED_ACTIVE : LESSON_SAVED_PENDING,
    }, teaching);
  }

  /**
   * ตัดสินบทเรียนที่รออนุมัติ — ทางเดียวของคอนโซล (POST /lessons/:id/approve|decline) และ Telegram
   * (ปุ่มในสรุปบทเรียนรายวัน) · ผู้เรียกตรวจสิทธิ์ lessons.approve เองก่อนเรียก
   * - ต้องยังเป็น pending · อนุมัติ = approveOwnerLesson · ไม่ใช้ = deleteOwnerLesson
   * - audit lesson_approved / lesson_declined ในนาม auditAs (Telegram = "telegram:<username>")
   * @returns {{ok: true, httpStatus: 200, lesson: object|null, title: string}|{ok: false, httpStatus: number, reason: string, error: string}}
   */
  function decide(id, decision, { username, auditAs = username }) {
    const lesson = safe(() => db.getOwnerLesson(id), null);
    if (!lesson) return { ok: false, httpStatus: 404, reason: "missing", error: "ไม่พบบทเรียนนี้ (อาจถูกลบไปแล้ว)" };
    if (lesson.status !== "pending") return { ok: false, httpStatus: 409, reason: "decided", error: "บทเรียนนี้ถูกตัดสินไปแล้ว" };
    const approve = decision === "approve";
    const changed = approve ? db.approveOwnerLesson(lesson.id, username) : db.deleteOwnerLesson(lesson.id);
    if (!changed) return { ok: false, httpStatus: 409, reason: "decided", error: "บทเรียนนี้ถูกตัดสินไปแล้ว" };
    audit(auditAs, approve ? "lesson_approved" : "lesson_declined", lesson.id, lessonTitle(lesson));
    return { ok: true, httpStatus: 200, lesson: approve ? db.getOwnerLesson(lesson.id) : null, title: lessonTitle(lesson) };
  }

  return { save, check, audit, notifyOwner, decide };
}
