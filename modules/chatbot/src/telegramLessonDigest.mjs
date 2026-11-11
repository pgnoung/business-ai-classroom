// telegramLessonDigest.mjs — บทเรียนรออนุมัติ ส่งให้พี่ง้วงกดอนุมัติใน Telegram ทุกคืน 22:00 (28 ก.ย. 2026)
//
// คำสั่งพี่ง้วง: "แอดมินหรือทีมสอน → เข้าไปรอใน 'รออนุมัติ' ที่เมนู บทเรียน พี่ง้วงต้องกดอนุมัติก่อน … = อันนี้
//  ให้พี่ง้วง สื่อสารผ่าน telegram ได้ไหม จะได้ง่าย · ทุกวัน ส่งมา ให้พี่ง้วง approve ส่งสัก 22:00 ก็ได้ครับ"
//
// - ทุกวัน 22:00–23:59 เวลาไทย (ตัวนับรอบนาทีละครั้งใน telegramControl — ไม่มี process ใหม่) ถ้ามีบทเรียนรออนุมัติ
//   และจับคู่ Telegram ไว้ = ส่งสรุปหนึ่งชุด (เก่าสุดก่อน สูงสุด 10 เรื่อง บอกว่าเหลืออีกกี่เรื่อง)
//   ไม่มีเรื่องรอ = ไม่ส่งอะไรวันนั้น · จดวันที่ส่ง/ตรวจแล้วใน settings "ก่อน" ส่ง = รีสตาร์ตแล้วไม่ส่งซ้ำ
//   ระบบดับตอน 22:00 = ส่งตอนกลับมาได้ถึง 23:59 เท่านั้น (ข้ามวันแล้วไม่ส่งย้อนหลัง)
//   สรุปยาวหลายข้อความแล้วส่งไม่ถึงกลางทาง = จดหน้าที่เหลือไว้ (outbox) แล้วส่งต่อจากหน้าที่ค้างใน 5 นาที
//   (ไม่ส่งหน้าแรกซ้ำ · ข้ามวันแล้วทิ้ง) — รีวิวโค้ด 28 ก.ย.: เดิมหน้าท้าย + ปุ่มอนุมัติทั้งหมดหายเงียบทั้งคืน
// - ปุ่มต่อเรื่อง ✅ อนุมัติ / 🗑 ไม่ใช้ + ✅ อนุมัติทั้งหมด (2 เรื่องขึ้นไป) — ตัดสินผ่านทางเดียวกับคอนโซล
//   (ownerLessonStore.decide: ต้องยัง pending · approveOwnerLesson / deleteOwnerLesson · audit lesson_approved /
//   lesson_declined ในนาม "telegram:<บัญชีคอนโซลที่จับคู่>") และตรวจสิทธิ์ lessons.approve ของบัญชีนั้นใหม่ทุกครั้งที่กด
// - ปุ่มพก "ลายนิ้วมือ" ของหัวข้อ+คำสอน: ถ้ามีคนแก้บทเรียนหลังส่งรายการ ปุ่มเก่าไม่อนุมัติฉบับที่พี่ง้วงยังไม่เห็น
// - คำสั่ง "บทเรียนรออนุมัติ" / "รออนุมัติ" = รายการเดียวกันได้ทุกเมื่อ
// - ความเป็นส่วนตัว: คำลูกค้า/คำตอบเดิมสั้น ๆ ชื่อปิด 3 ตัว ซ่อนเบอร์/อีเมล/ลิงก์/เลขยาว (กติกาเดียวกับแชทเจ้าของ)
// - สวิตช์ settings.lesson_digest_mode: ไม่มีแถว = เปิด · "off" = ไม่ส่งสรุปรายวัน · อ่านพัง = ปิด
//   (ปิดแค่ของที่ส่งเองตอน 22:00 — พิมพ์คำสั่งดูรายการยังได้)
import { activeBrand, isGenericProfile } from "./brand.mjs";
import { createHash, randomBytes } from "node:crypto";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { lessonTitle, oneLine } from "./ownerLessons.mjs";
import { createOwnerLessonWriter } from "./ownerLessonStore.mjs";
import { bangkokIsoDate, channelLabel, formatBangkokTime } from "./yoloText.mjs";
import { clampText, scrubCustomerText } from "./ownerChatText.mjs";

export const LESSON_DIGEST_MODE_KEY = "lesson_digest_mode";
export const LESSON_DIGEST_MODES = Object.freeze(["on", "off"]);
// เวลาส่งสรุปรายวัน (ชั่วโมงเวลาไทย) — ส่งได้ตั้งแต่ HH:00 จนถึง 23:59 ของวันนั้น
export const LESSON_DIGEST_HOUR_BKK = 22;
export const LESSON_DIGEST_DAY_KEY = "lesson_digest_day";
export const LESSON_DIGEST_MANIFEST_KEY = "lesson_digest_manifest";
export const LESSON_DIGEST_OUTBOX_KEY = "lesson_digest_outbox";
export const LESSON_DIGEST_MAX = 10;
export const LESSON_DIGEST_TICK_MS = 60_000;
const RETRY_AFTER_FAIL_MS = 5 * 60_000;
const PAGE_MAX = 3_500; // เพดาน Telegram 4,096 — เผื่ออีโมจิ/หัวท้าย
const CONTEXT_MAX = 90;
const BKK_OFFSET_MS = 7 * 3_600_000;
const APPROVE = "lessons.approve";
// "L:a:<id>:<fp>" / "L:d:<id>:<fp>" / "L:all:<token>" — ไม่เกิน 64 ไบต์ (เพดาน callback_data) · คนละคำนำหน้ากับ "y:"
const CALLBACK_ONE = /^L:(a|d):([A-Za-z0-9-]{1,40}):([A-Za-z0-9_-]{10})$/u;
const CALLBACK_ALL = /^L:all:([A-Za-z0-9_-]{8,16})$/u;
export const LESSON_LIST_COMMAND = /^(?:ขอ\s*)?(?:ดู\s*)?(?:มี\s*)?(?:บทเรียน\s*)?(?:ที่\s*)?รอ\s*(?:การ\s*)?อนุมัติ(?:\s*(?:หน่อย|บ้าง|ไหม|มั้ย|อะไร|ครับ|ค่ะ|คะ|นะ|จ้า))*\s*[?？]*$/u;

export const LESSON_NONE_TEXT = "ตอนนี้ไม่มีบทเรียนรออนุมัติค่ะ 🎉";
export const LESSON_TEACH_OFF_TEXT = "ตอนนี้ปิดการสอนลูกแพรอยู่ (จอสอนปิด) — อนุมัติบทเรียนจากตรงนี้ไม่ได้ค่ะ";
export const LESSON_STALE_ALL_TEXT = "ปุ่มนี้มาจากรายการเก่าแล้วค่ะ — พิมพ์ \"บทเรียนรออนุมัติ\" เพื่อดูรายการล่าสุดนะคะ";

/** ไม่มีแถว = เปิด · "off" = ปิด · อ่านพัง = ปิด (ไม่ส่งของที่ไม่แน่ใจ) */
export function lessonDigestMode(db) {
  // White-label: โปรไฟล์ generic ปิดฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วงเสมอ (ค่าใน DB ไม่มีผล)
  if (isGenericProfile(activeBrand())) return "off";
  try {
    return String(db?.getSetting?.(LESSON_DIGEST_MODE_KEY) ?? "").trim().toLowerCase() === "off" ? "off" : "on";
  } catch {
    return "off";
  }
}

/** ลายนิ้วมือของสิ่งที่พี่ง้วงเห็น (หัวข้อ + คำสอน + ขอบเขตช่องทาง) — แก้ทีหลัง = ปุ่มเก่าใช้ไม่ได้ */
export function lessonFingerprint(lesson) {
  return createHash("sha256")
    .update(`${lesson?.topic ?? ""}\n${lesson?.teaching ?? ""}\n${lesson?.channel_id ?? ""}`)
    .digest("base64url").slice(0, 10);
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

const lines = (...parts) => parts.flat().filter((part) => part !== null && part !== undefined && part !== "").join("\n");
const bangkokHour = (ms) => new Date(Number(ms) + BKK_OFFSET_MS).getUTCHours();
const oneData = (op, lesson) => `L:${op}:${lesson.id}:${lessonFingerprint(lesson)}`;
const fitsButton = (lesson) => /^[A-Za-z0-9-]{1,40}$/u.test(String(lesson?.id || ""));

export function createLessonDigest({ config = {}, db, client, owner: ownerOf = () => null, logger = console, now = Date.now }) {
  const writer = createOwnerLessonWriter({ db, config, logger });
  const teachOn = () => config.teachEnabled === true;
  const lessonsLink = () => (config.consolePublicBaseUrl ? `${config.consolePublicBaseUrl}/#/lessons` : "");
  let ticking = false;
  let retryAt = 0;

  // บัญชีคอนโซลที่ออกรหัสจับคู่ — ต้องยังอยู่ ไม่ถูกปิด และยังมีสิทธิ์อนุมัติ (ตรวจใหม่ทุกครั้ง)
  function approver(owner) {
    const username = String(owner?.pairedBy || "").trim();
    const operator = username ? safe(() => db.getOperator(username), null) : null;
    return operator && Number(operator.disabled || 0) !== 1 && hasOperatorCapability(operator, APPROVE) ? operator : null;
  }

  const needConsoleText = () => lines(
    "บัญชีคอนโซลที่จับคู่ Telegram ไว้ไม่มีสิทธิ์อนุมัติบทเรียนแล้วค่ะ — อนุมัติในคอนโซล เมนู \"บทเรียน\" นะคะ",
    lessonsLink() ? `👉 ${lessonsLink()}` : "",
  );

  function teacherName(username) {
    const operator = safe(() => db.getOperator(String(username || "")), null);
    return oneLine(operator?.display_name || username || "ทีมงาน", 40);
  }

  // หนึ่งเรื่อง: หัวข้อ · คำสอนเต็ม (สิ่งที่จะถูกอนุมัติ) · ใครสอน เมื่อไหร่ · บริบทสั้น ๆ ที่ปิดชื่อ/ซ่อนเบอร์แล้ว
  function lessonBlock(lesson, number, nowMs) {
    const customer = lesson.customer_id ? safe(() => db.getCustomer(lesson.customer_id), null) : null;
    const names = customer ? [customer.known_name, customer.display_name] : [];
    const label = customer ? String(customer.known_name || customer.display_name || "") : "";
    const context = (text) => clampText(scrubCustomerText(oneLine(text, 600), { names, label }), CONTEXT_MAX);
    return lines(
      `${number}) ${lessonTitle(lesson)}`,
      `สอน: "${oneLine(lesson.teaching, 700)}"`,
      `โดย ${teacherName(lesson.created_by)} · ${formatBangkokTime(lesson.created_at, nowMs)}`
        + (lesson.channel_id ? ` · ใช้เฉพาะ ${channelLabel(lesson.channel_id)}` : ""),
      lesson.customer_text ? `ลูกค้าพิมพ์: "${context(lesson.customer_text)}"` : "",
      lesson.ai_text ? `ลูกแพรตอบเดิม: "${context(lesson.ai_text)}"` : "",
    );
  }

  /** แบ่งเป็นข้อความละไม่เกิน PAGE_MAX · ปุ่มของแต่ละเรื่องอยู่ใต้ข้อความที่มีเรื่องนั้น · อนุมัติทั้งหมดอยู่ข้อความสุดท้าย */
  function composePages(rows, total, { nowMs, daily, token }) {
    const header = lines(
      daily ? `📚 สรุปบทเรียนรออนุมัติประจำวัน — ${total} เรื่อง` : `📚 บทเรียนรออนุมัติตอนนี้ ${total} เรื่อง`,
      total > rows.length
        ? `(แสดง ${rows.length} เรื่องที่รอนานที่สุดก่อน · เหลืออีก ${total - rows.length} เรื่อง — ตัดสินชุดนี้แล้วพิมพ์ "บทเรียนรออนุมัติ" เพื่อดูต่อ)`
        : "",
      "ทีมสอนลูกแพรไว้ รอพี่ง้วงตัดสินค่ะ: ✅ อนุมัติ = ลูกแพรใช้กับลูกค้าทุกคนตั้งแต่ข้อความถัดไป · 🗑 ไม่ใช้ = ลบคำขอนี้",
    );
    const footer = lines(
      "อยากแก้คำสอนก่อนอนุมัติ เปิดเมนู \"บทเรียน\" ในคอนโซลค่ะ",
      lessonsLink() ? `👉 ${lessonsLink()}` : "",
    );
    const pages = [];
    let current = { blocks: [], rows: [] };
    const pageText = (page, first, last) => [first ? header : "📚 บทเรียนรออนุมัติ (ต่อ)", ...page.blocks, ...(last ? [footer] : [])].join("\n\n");
    rows.forEach((lesson, index) => {
      const block = lessonBlock(lesson, index + 1, nowMs);
      const candidate = { blocks: [...current.blocks, block], rows: [...current.rows, { lesson, number: index + 1 }] };
      if (current.blocks.length && pageText(candidate, pages.length === 0, true).length > PAGE_MAX) {
        pages.push(current);
        current = { blocks: [block], rows: [{ lesson, number: index + 1 }] };
      } else {
        current = candidate;
      }
    });
    if (current.blocks.length) pages.push(current);
    return pages.map((page, index) => {
      const last = index === pages.length - 1;
      const keyboard = page.rows.filter(({ lesson }) => fitsButton(lesson)).map(({ lesson, number }) => [
        { text: `✅ อนุมัติ ${number}`, callback_data: oneData("a", lesson) },
        { text: `🗑 ไม่ใช้ ${number}`, callback_data: oneData("d", lesson) },
      ]);
      if (last && rows.length >= 2) keyboard.push([{ text: "✅ อนุมัติทั้งหมด", callback_data: `L:all:${token}` }]);
      return { text: pageText(page, index === 0, last), keyboard };
    });
  }

  function pendingNow() {
    const total = Number(db.countOwnerLessons({ viewer: null }).pending) || 0;
    return { total, rows: total ? db.pendingOwnerLessonsOldest(LESSON_DIGEST_MAX) : [] };
  }

  const readJson = (key) => safe(() => JSON.parse(String(db.getSetting(key) || "null")), null);
  const readManifest = () => readJson(LESSON_DIGEST_MANIFEST_KEY);

  // ส่งหน้าที่ยังไม่ส่งตามลำดับ หยุดที่หน้าแรกที่ส่งไม่ถึง — คืน outbox ที่ขยับ next แล้ว (ไม่แก้ของเดิม)
  async function deliver(chatId, outbox) {
    let next = outbox.next;
    const messageIds = [...outbox.messageIds];
    while (next < outbox.pages.length) {
      const page = outbox.pages[next];
      const result = await client.sendMessage({ chatId, text: page.text, keyboard: page.keyboard });
      if (!result?.ok) break;
      messageIds.push(result.result?.message_id ?? null);
      next += 1;
    }
    return { ...outbox, next, messageIds };
  }

  function saveManifest(outbox) {
    try {
      db.setSetting(LESSON_DIGEST_MANIFEST_KEY, JSON.stringify({
        token: outbox.token, at: now(), items: outbox.items, messageIds: outbox.messageIds.filter((id) => id != null),
      }));
    } catch (err) {
      logger.warn?.(`lessonDigest: จดรายการที่ส่งไม่สำเร็จ (${err?.message || err}) — ปุ่มอนุมัติทั้งหมดของชุดนี้จะใช้ไม่ได้`);
    }
  }

  const saveOutbox = (outbox) => safe(() => db.setSetting(LESSON_DIGEST_OUTBOX_KEY, outbox ? JSON.stringify(outbox) : ""), null);

  /**
   * ส่งรายการ (สรุปรายวัน หรือคำสั่ง "บทเรียนรออนุมัติ")
   * reason: send_failed = ไม่ถึงเลยสักหน้า · partial = ถึงบางหน้า (รายวัน: หน้าที่เหลือรอใน outbox)
   * @returns {Promise<{sent: number, total?: number, reason?: string}>}
   */
  async function sendList(chatId, owner, { daily = false, day = "" } = {}) {
    const say = (text) => (daily ? null : client.sendMessage({ chatId, text }));
    if (!teachOn()) { await say(LESSON_TEACH_OFF_TEXT); return { sent: 0, reason: "teach_off" }; }
    if (!approver(owner)) { await say(needConsoleText()); return { sent: 0, reason: "no_approver" }; }
    const { total, rows } = pendingNow();
    if (!rows.length) { await say(LESSON_NONE_TEXT); return { sent: 0, total, reason: "none" }; }
    const token = randomBytes(6).toString("base64url");
    const pages = composePages(rows, total, { nowMs: now(), daily, token });
    const outbox = await deliver(chatId, {
      day, chatId: String(chatId), token, next: 0, messageIds: [], pages,
      items: rows.map((lesson) => ({ id: String(lesson.id), fp: lessonFingerprint(lesson) })),
    });
    if (!outbox.next) return { sent: 0, total, reason: "send_failed" };
    saveManifest(outbox);
    if (outbox.next === pages.length) return { sent: outbox.next, total };
    logger.warn?.(`lessonDigest: ส่งได้ ${outbox.next}/${pages.length} ข้อความ${daily ? " — ส่งหน้าที่เหลือต่อใน 5 นาที" : ""}`);
    if (daily) saveOutbox(outbox);
    return { sent: outbox.next, total, reason: "partial" };
  }

  // สรุปของคืนนี้ที่ส่งค้างกลางทาง: ส่งต่อจากหน้าที่ค้าง (วันเดียวกันเท่านั้น — ข้ามวันแล้วทิ้ง ไม่ส่งย้อนหลัง)
  async function resume(outbox, day, nowMs) {
    if (outbox.day !== day) { saveOutbox(null); return null; }
    if (nowMs < retryAt) return { sent: 0, reason: "retry_wait" };
    const owner = ownerOf();
    if (!owner?.chatId || String(owner.chatId) !== outbox.chatId) { saveOutbox(null); return { sent: 0, reason: "not_paired" }; }
    const before = outbox.next;
    const updated = await deliver(owner.chatId, outbox);
    if (readManifest()?.token === updated.token) saveManifest(updated);
    if (updated.next < updated.pages.length) {
      saveOutbox(updated);
      retryAt = nowMs + RETRY_AFTER_FAIL_MS;
      return { sent: updated.next - before, reason: "partial" };
    }
    saveOutbox(null);
    return { sent: updated.next - before, reason: "resumed" };
  }

  /** ตัวนับรอบรายนาที: ส่งสรุปครั้งเดียวต่อวันในช่วง 22:00–23:59 เวลาไทย */
  async function tick() {
    if (ticking) return { sent: 0, reason: "busy" };
    ticking = true;
    try {
      const nowMs = now();
      if (lessonDigestMode(db) !== "on") return { sent: 0, reason: "off" };
      if (!teachOn()) return { sent: 0, reason: "teach_off" };
      if (bangkokHour(nowMs) < LESSON_DIGEST_HOUR_BKK) return { sent: 0, reason: "not_yet" };
      const day = bangkokIsoDate(nowMs);
      const outbox = readJson(LESSON_DIGEST_OUTBOX_KEY);
      if (outbox?.pages) {
        const resumed = await resume(outbox, day, nowMs);
        if (resumed) return resumed;
      }
      const done = safe(() => String(db.getSetting(LESSON_DIGEST_DAY_KEY) ?? ""), null);
      if (done === null) return { sent: 0, reason: "read_failed" };
      if (done === day) return { sent: 0, reason: "already" };
      if (nowMs < retryAt) return { sent: 0, reason: "retry_wait" };
      const owner = ownerOf();
      if (!owner?.chatId) return { sent: 0, reason: "not_paired" };
      if (!approver(owner)) return { sent: 0, reason: "no_approver" };
      // จดก่อนส่ง: ดับกลางทาง/รีสตาร์ต = ไม่ส่งซ้ำ (ไม่มีเรื่องรอก็จดว่าตรวจแล้ว — วันนั้นไม่ส่งอะไร)
      try { db.setSetting(LESSON_DIGEST_DAY_KEY, day); } catch { return { sent: 0, reason: "claim_failed" }; }
      let result;
      try {
        result = await sendList(owner.chatId, owner, { daily: true, day });
      } catch (err) {
        // อ่านคิวบทเรียนพัง (DB สะดุด) ก่อนส่งอะไรออกไป = ถือว่าส่งไม่ถึง ไม่เผาสิทธิ์ของคืนนี้ทิ้ง
        logger.warn?.(`lessonDigest: เตรียมสรุปบทเรียนไม่สำเร็จ (${err?.name || "Error"})`);
        result = { sent: 0, reason: "send_failed" };
      }
      if (result.reason === "send_failed") {
        // ส่งไม่ถึงเลยสักข้อความ = คืนสิทธิ์ให้รอบถัดไป (เว้น 5 นาที) ภายในคืนเดียวกัน
        safe(() => db.setSetting(LESSON_DIGEST_DAY_KEY, done), null);
        retryAt = nowMs + RETRY_AFTER_FAIL_MS;
        logger.warn?.("lessonDigest: ส่งสรุปบทเรียนไม่สำเร็จ — ลองใหม่ใน 5 นาที");
      } else if (result.reason === "partial") {
        retryAt = nowMs + RETRY_AFTER_FAIL_MS; // หน้าที่เหลืออยู่ใน outbox — ส่งต่อรอบถัดไป
      }
      return result;
    } finally {
      ticking = false;
    }
  }

  // ปุ่มใต้ข้อความที่ถูกกด: เหลือเฉพาะเรื่องที่ยังรอ (ฉบับเดิม) · ปุ่มอนุมัติทั้งหมดอยู่ต่อเมื่อชุดนั้นยังเหลือ ≥ 2 เรื่อง
  async function refreshKeyboard(chatId, message) {
    const rows = message?.reply_markup?.inline_keyboard;
    if (!message?.message_id || !Array.isArray(rows)) return;
    const manifest = readManifest();
    const keep = [];
    let allRow = null;
    for (const row of rows) {
      const buttons = (Array.isArray(row) ? row : []).filter((button) => typeof button?.callback_data === "string");
      const all = buttons.find((button) => CALLBACK_ALL.test(button.callback_data));
      if (all) {
        const token = CALLBACK_ALL.exec(all.callback_data)[1];
        if (manifest?.token === token && stillPending(manifest.items).length >= 2) allRow = [all];
        continue;
      }
      const match = CALLBACK_ONE.exec(buttons[0]?.callback_data || "");
      const lesson = match ? safe(() => db.getOwnerLesson(match[2]), null) : null;
      if (lesson?.status === "pending" && lessonFingerprint(lesson) === match[3]) keep.push(buttons);
    }
    if (allRow) keep.push(allRow);
    await client.setKeyboard({ chatId, messageId: message.message_id, keyboard: keep }).catch(() => null);
  }

  function stillPending(items = []) {
    return (Array.isArray(items) ? items : []).map((item) => ({ item, lesson: safe(() => db.getOwnerLesson(item.id), null) }))
      .filter(({ item, lesson }) => lesson?.status === "pending" && lessonFingerprint(lesson) === item.fp);
  }

  async function decideOne(chatId, operator, [, op, id, fp], message) {
    const lesson = safe(() => db.getOwnerLesson(id), null);
    let text;
    if (!lesson) text = "บทเรียนนี้ไม่อยู่ในคิวแล้วค่ะ (มีคนกดไม่ใช้หรือลบไปแล้ว) — ลูกแพรไม่ได้ทำอะไรเพิ่มนะคะ";
    else if (lesson.status !== "pending") {
      text = `บทเรียน "${lessonTitle(lesson)}" ถูกตัดสินไปแล้วค่ะ (ตอนนี้${lesson.status === "active" ? "ใช้อยู่" : "ปิดใช้อยู่"}) — ลูกแพรไม่ได้ทำอะไรเพิ่มนะคะ`;
    } else if (lessonFingerprint(lesson) !== fp) {
      text = `บทเรียน "${lessonTitle(lesson)}" ถูกแก้ไขหลังจากส่งรายการนี้ค่ะ — พิมพ์ "บทเรียนรออนุมัติ" เพื่อดูฉบับล่าสุดก่อนกดนะคะ`;
    } else {
      const username = String(operator.username);
      const result = writer.decide(lesson.id, op === "a" ? "approve" : "decline", { username, auditAs: `telegram:${username}` });
      text = !result.ok
        ? `บทเรียน "${lessonTitle(lesson)}" ถูกตัดสินไปแล้วค่ะ — ลูกแพรไม่ได้ทำอะไรเพิ่มนะคะ`
        : op === "a"
          ? `✅ อนุมัติ "${result.title}" แล้วค่ะ — ลูกแพรใช้ตั้งแต่ข้อความถัดไป`
          : `🗑 ไม่ใช้ "${result.title}" — ลบคำขอนี้แล้วค่ะ`;
    }
    await refreshKeyboard(chatId, message);
    return client.sendMessage({ chatId, text });
  }

  async function approveAll(chatId, operator, token, message) {
    const manifest = readManifest();
    if (!manifest || manifest.token !== token) {
      await refreshKeyboard(chatId, message);
      return client.sendMessage({ chatId, text: LESSON_STALE_ALL_TEXT });
    }
    const username = String(operator.username);
    const approvable = stillPending(manifest.items);
    let approved = 0;
    for (const { lesson } of approvable) {
      if (writer.decide(lesson.id, "approve", { username, auditAs: `telegram:${username}` }).ok) approved += 1;
    }
    const skipped = (Array.isArray(manifest.items) ? manifest.items.length : 0) - approved;
    const remaining = safe(() => pendingNow().total, 0);
    safe(() => db.setSetting(LESSON_DIGEST_MANIFEST_KEY, ""), null); // ชุดนี้จบแล้ว — กดซ้ำ = ปุ่มเก่า
    for (const messageId of Array.isArray(manifest.messageIds) ? manifest.messageIds : []) {
      await client.clearKeyboard({ chatId, messageId }).catch(() => null);
    }
    if (message?.message_id && !(manifest.messageIds || []).includes(message.message_id)) await refreshKeyboard(chatId, message);
    return client.sendMessage({
      chatId,
      text: lines(
        approved ? `✅ อนุมัติแล้ว ${approved} เรื่องค่ะ — ลูกแพรใช้ตั้งแต่ข้อความถัดไป` : "ไม่มีเรื่องไหนในชุดนี้ที่ยังรออนุมัติแล้วค่ะ",
        skipped > 0 ? `(ข้าม ${skipped} เรื่องที่ถูกตัดสิน ลบ หรือแก้ไขไปแล้ว)` : "",
        remaining ? `ยังมีบทเรียนรออนุมัติอีก ${remaining} เรื่อง — พิมพ์ "บทเรียนรออนุมัติ" เพื่อดูต่อ` : "",
      ),
    });
  }

  /** ปุ่ม "L:…" จากเจ้าของที่จับคู่แล้ว (ผู้เรียกกรอง isOwner มาแล้ว) */
  async function handleCallback({ chatId, owner, data, message }) {
    const value = String(data || "");
    if (!teachOn()) return client.sendMessage({ chatId, text: LESSON_TEACH_OFF_TEXT });
    const operator = approver(owner);
    if (!operator) return client.sendMessage({ chatId, text: needConsoleText() });
    const one = CALLBACK_ONE.exec(value);
    if (one) return decideOne(chatId, operator, one, message);
    const all = CALLBACK_ALL.exec(value);
    if (all) return approveAll(chatId, operator, all[1], message);
    return client.sendMessage({ chatId, text: "ปุ่มนี้ใช้ไม่ได้แล้วค่ะ — พิมพ์ \"บทเรียนรออนุมัติ\" เพื่อดูรายการล่าสุดนะคะ" });
  }

  return {
    tick,
    sendList,
    handleCallback,
    isListCommand: (text) => LESSON_LIST_COMMAND.test(String(text || "").trim()),
    lessonsOn: teachOn,
    dailyOn: () => teachOn() && lessonDigestMode(db) === "on",
  };
}
