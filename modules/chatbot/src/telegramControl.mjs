// telegramControl.mjs — ช่องสั่งงานลูกแพรทาง Telegram ของพี่ง้วง (2026-09-28)
//
// บอทใหม่เฉพาะงานนี้ (ห้ามใช้บอทแจ้งเตือน ops เดิมที่ผูก webhook อยู่ที่อื่น) — รับข้อความด้วย
// long polling (getUpdates) เพราะ chassis ไม่ต้องเปิดเส้นเข้าเพิ่ม · เริ่มเองเมื่อมีโทเคนใน DB
//
// ความปลอดภัย:
// - สั่งได้เฉพาะ Telegram user + private chat ที่จับคู่ด้วยรหัสจากคอนโซล (เจ้าของเท่านั้น)
//   คนอื่นทุกคน = ไม่ทำอะไร ไม่ตอบ (log แค่ว่ามีคนแปลกหน้า ไม่ log เนื้อความ/ไม่ log id)
// - offset บันทึก "ก่อน" ทำคำสั่ง = ทำอย่างมากครั้งเดียว (ดับกลางทางแล้วไม่ส่งซ้ำ) · update เก่ากว่า
//   offset ถูกทิ้ง · คำสั่งค้างเกิน 10 นาที (ระบบดับอยู่) ถูกข้ามพร้อมบอกเหตุ ไม่ส่งย้อนหลังเงียบ ๆ
// - ปุ่มเลือก/ยืนยันใช้ครั้งเดียวต่อ nonce · หมดอายุ 10 นาที
// - ภาษาพูดอิสระผ่าน mini AI ได้ แต่คำสั่งที่เปลี่ยนสถานะ (yolo/เปิด/ปิด AI) ต้องกดยืนยันการตีความก่อนเสมอ
// - "คุยกับลูกแพร" (28 ก.ย.): ข้อความที่ไม่ใช่คำสั่ง (mini AI ถอดไม่ได้) ไปที่สมองแชท (telegramOwnerChat.mjs)
//   แทน UNKNOWN_TEXT — สมองแชทสั่งระบบไม่ได้ · สวิตช์ owner_chat_mode ปิด = พฤติกรรมเดิมทุกอย่าง
// - บทเรียนรออนุมัติ (28 ก.ย. เย็น): สรุปทุกคืน 22:00 + คำสั่ง "บทเรียนรออนุมัติ" + ปุ่ม "L:…" (telegramLessonDigest.mjs)
//   ตัดสินผ่านทางเดียวกับคอนโซล · ตรวจสิทธิ์อนุมัติของบัญชีที่จับคู่ใหม่ทุกครั้งที่กด
import { isGenericProfile } from "./brand.mjs";
import { randomBytes } from "node:crypto";
import { createTelegramClient, maskBotToken, TELEGRAM_BOT_TOKEN_PATTERN } from "./telegramClient.mjs";
import { createTelegramStore } from "./telegramStore.mjs";
import { MINI_AI_SYSTEM, parseOwnerCommand, validateMiniAiCommand } from "./yoloCommands.mjs";
import { resolveCustomer, resolveLeadingName } from "./customerResolver.mjs";
import { describeRoomStatus } from "./yoloStatus.mjs";
import { setCustomerAiSwitch } from "./aiSwitch.mjs";
import { channelLabel, cleanInstruction } from "./yoloText.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import * as say from "./telegramReplies.mjs";
import { createTelegramChatBridge } from "./telegramOwnerChat.mjs";
import { createLessonDigest, LESSON_DIGEST_TICK_MS } from "./telegramLessonDigest.mjs";

const POLL_TIMEOUT_SEC = 25;
const IDLE_NO_TOKEN_MS = 15_000;
const PENDING_TTL_MS = 10 * 60_000;
const STALE_COMMAND_MS = 10 * 60_000;
const OK_STATUS_EVERY_MS = 60_000;
const QUIET_LOG_EVERY_MS = 60_000;
const MUTATIONS = new Set(["yolo", "ai_on", "ai_off"]);
const CONFIRM_WORDS = /^(?:ยืนยัน|ส่งเลย|ส่ง|ใช่|ตกลง|โอเค|ok|okay|yes)$/iu;
const CANCEL_WORDS = /^(?:ยกเลิก|ไม่ใช่|ไม่|cancel|no)$/iu;
// ระหว่างคุยกับลูกแพร "โอเค/ใช่/ส่ง" คือคำคุยธรรมดา — ถ้าข้อความล่าสุดของบอทเป็นคำตอบแชท (ใหม่กว่ารายการที่รอ)
// รับเฉพาะคำชัด ๆ นี้ (หรือกดปุ่ม) ไม่งั้น "โอเคค่ะ" ที่ตอบแชทจะไปกดยืนยันส่งข้อความหาลูกค้าแทน (code review 28 ก.ย.)
const EXPLICIT_CONFIRM = /^ยืนยัน$/u;
const EXPLICIT_CANCEL = /^ยกเลิก$/u;
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

function choiceNumber(text) {
  const value = String(text || "").trim();
  if (/^[1-9]$/u.test(value)) return Number(value);
  const thai = THAI_DIGITS.indexOf(value);
  return value.length === 1 && thai > 0 ? thai : null;
}

export function createTelegramControl({
  config, db, yolo, hermes = null, ownerChat = null, chatLessons = null, fetchImpl, logger = console, now = Date.now, sleep = null,
}) {
  const store = createTelegramStore({ db, now });
  const client = createTelegramClient({ getToken: () => store.token(), fetchImpl });
  // ลำดับเหตุการณ์ (ไม่ใช้เวลา — สองอย่างเกิดในมิลลิวินาทีเดียวกันได้): อะไรใหม่กว่ากันระหว่างรายการที่รอกับคำตอบแชท
  let sequence = 0;
  const nextSeq = () => { sequence += 1; return sequence; };
  const chat = createTelegramChatBridge({ ownerChat, lessons: chatLessons, client, now, logger, nextSeq });
  const lessonDigest = createLessonDigest({ config, db, client, owner: () => store.owner(), logger, now });
  let digestTimer = null;
  const helpFlags = () => ({ chat: chat.enabled(), lessons: lessonDigest.lessonsOn(), digest: lessonDigest.dailyOn() });
  let running = false;
  let stopController = null;
  let wakeUp = null;
  let lastOkWrite = 0;
  let lastQuietLog = 0;
  let pending = null;
  let deadToken = "";

  const quietLog = (message) => {
    if (now() - lastQuietLog < QUIET_LOG_EVERY_MS) return;
    lastQuietLog = now();
    logger.warn?.(message);
  };
  const actorOf = (owner) => `telegram:${owner?.pairedBy || "owner"}`;
  const reply = (chatId, text, keyboard = null) => client.sendMessage({ chatId, text, keyboard });
  const isOwner = (from, chat, owner) => Boolean(owner && chat?.type === "private" && !from?.is_bot
    && String(from?.id) === owner.userId && String(chat?.id) === owner.chatId);

  function remember(kind, chatId, data) {
    const nonce = randomBytes(6).toString("base64url");
    pending = { kind, chatId: String(chatId), nonce, seq: nextSeq(), expiresAt: now() + PENDING_TTL_MS, ...data };
    return nonce;
  }

  async function ask(chatId, kind, text, keyboardFor, data) {
    const nonce = remember(kind, chatId, data);
    const sent = await reply(chatId, text, keyboardFor(nonce));
    if (pending?.nonce === nonce && sent?.ok) pending.messageId = sent.result?.message_id ?? null;
  }

  async function miniAiParse(text) {
    if (typeof hermes?.scoreCustomer !== "function") return null;
    // ข้อความของพี่ง้วงเอง — ตัวตัดข้อความหลอกระบบไม่แตะ (รีวิวรอบ 4)
    const result = await hermes.scoreCustomer({ system: MINI_AI_SYSTEM, transcript: text, trustedTurns: true });
    if (result?.usage) {
      // kind "score" = โมเดลบทบาท scorer (llm_usage.kind เป็นชุดปิดตาม CHECK ของตาราง)
      try { db.addLlmUsage({ customerId: "", kind: "score", model: result.model || "", ...usageFields(result.usage) }); } catch { /* ห้ามล้ม */ }
    }
    if (!result || result.failed || typeof result.text !== "string") return null;
    const checked = validateMiniAiCommand(result.text, text);
    return checked.ok ? checked.command : null;
  }

  async function execute(chatId, owner, action, target, { confirmed = false } = {}) {
    if (action.action === "status") {
      const status = describeRoomStatus({ db, config, customerId: target.id, nowMs: now() });
      return reply(chatId, status ? say.statusText(status, config, now()) : say.notFoundText(target.label, "", [], now()));
    }
    if (action.action === "ai_on" || action.action === "ai_off") {
      const row = db.getCustomer(target.id);
      if (!row) return reply(chatId, say.notFoundText(target.label, "", [], now()));
      const enable = action.action === "ai_on";
      const summary = { id: row.line_user_id, name: row.known_name || row.display_name, channel: channelLabel(row.channel_id) };
      if ((Number(row.ai_enabled) === 1) === enable) return reply(chatId, say.aiSwitchedText(summary, enable, { unchanged: true }, config));
      setCustomerAiSwitch({ db, customerId: target.id, enabled: enable, operator: actorOf(owner), source: "telegram", nowMs: now() });
      return reply(chatId, say.aiSwitchedText(summary, enable, {}, config));
    }
    // ถามหน้าด่านก่อน (ไม่ร่าง ไม่เสียเงิน) — จะได้ไม่บอกว่า "กำลังร่าง" แล้วตามด้วย "ไม่ส่ง"
    const pre = yolo.preflight(target.id);
    if (!pre.refusal && !(pre.confirm.length && !confirmed)) {
      await reply(chatId, say.workingText({ name: target.label, channel: channelLabel(target.channelId) }));
    }
    const result = await yolo.run({
      customerId: target.id, instruction: action.instruction || "", actor: actorOf(owner), source: "telegram",
      alsoEnableAi: action.alsoEnableAi === true, confirm: confirmed,
    });
    if (result.status === "needs_confirmation") {
      return ask(chatId, "confirm", say.confirmText(result), (nonce) => say.confirmKeyboard(nonce), { action, target });
    }
    return reply(chatId, result.ok ? say.sentText(result, config) : say.refusedText(result, config));
  }

  // เลือกห้องได้แล้ว — คำสั่งจาก mini AI ที่เปลี่ยนสถานะต้องทวนความเข้าใจให้กดยืนยันก่อน
  async function proceed(chatId, owner, action, target) {
    if (action.viaModel && MUTATIONS.has(action.action)) {
      return ask(chatId, "interpret", say.interpretationText(action, target),
        (nonce) => say.confirmKeyboard(nonce, action.action === "yolo" ? "✅ ใช่ ส่งเลย" : "✅ ใช่"), { action, target });
    }
    return execute(chatId, owner, action, target);
  }

  async function handleCommand(chatId, owner, command) {
    if (command.action === "help") return reply(chatId, say.helpText(helpFlags()));
    if (!command.target) return reply(chatId, say.needNameText(command.action));
    const resolution = command.form === "leading"
      ? resolveLeadingName(db, { text: command.target, channel: command.channel })
      : resolveCustomer(db, { query: command.target, channel: command.channel });
    const action = {
      ...command,
      instruction: command.form === "leading" ? cleanInstruction(resolution.instruction || "", 500) : (command.instruction || ""),
    };
    if (resolution.status === "invalid") return reply(chatId, say.needNameText(command.action));
    if (resolution.status === "none") {
      return reply(chatId, say.notFoundText(resolution.query || command.target, command.channel, resolution.suggestions, now()));
    }
    // ส่งผิดคน = ความเสียหายที่แพงที่สุด:
    // - ชื่อตรงคนเดียวแต่มีชื่อคล้าย → yolo ต้องให้เลือกก่อน
    // - ไม่มีชื่อตรงเลย เดาจากชื่อบางส่วนได้คนเดียว → คำสั่งที่เปลี่ยนสถานะต้องกดเลือกก่อน (สถานะดูได้เลย)
    const similarForYolo = resolution.status === "unique" && resolution.hasSimilar && action.action === "yolo";
    const looseForMutation = resolution.status === "unique" && resolution.loose === true && MUTATIONS.has(action.action);
    if (resolution.status === "ambiguous" || similarForYolo || looseForMutation) {
      const matches = similarForYolo ? [resolution.matches[0], ...resolution.similar].slice(0, 5) : resolution.matches;
      const mode = resolution.split ? "split" : similarForYolo ? "similar" : looseForMutation ? "loose" : "many";
      return ask(chatId, "pick", say.pickText(resolution.query, matches, now(), { total: resolution.total || matches.length, mode }),
        (nonce) => say.pickKeyboard(nonce, matches.length), { action, matches });
    }
    return proceed(chatId, owner, action, resolution.matches[0]);
  }

  // คำตอบของ pending (เลข/ยืนยัน/ยกเลิก) — คืน true ถ้าจัดการแล้ว
  async function answerPending(chatId, owner, op) {
    const current = pending;
    if (!current || current.chatId !== String(chatId)) return false;
    if (current.expiresAt <= now()) {
      pending = null;
      await reply(chatId, say.EXPIRED_TEXT);
      return true;
    }
    if (current.kind === "lesson") return answerLesson(chatId, owner, current, op);
    const target = current.kind === "pick" ? current.matches[Number(op) - 1] : current.target;
    if (op !== "no" && current.kind === "pick" && !target) {
      // เลขเกินรายการ: บอกช่วงที่เลือกได้ (รายการยังอยู่) — เดิมเงียบไปเลย (code review 2026-09-28)
      await reply(chatId, say.pickRangeText(current.matches.length));
      return true;
    }
    if (op !== "no" && (!target || (current.kind !== "pick" && op !== "ok"))) return false;
    pending = null; // ใช้ครั้งเดียว — กดซ้ำ/ส่งซ้ำไม่มีผล
    if (current.messageId) client.clearKeyboard({ chatId, messageId: current.messageId }).catch(() => {});
    if (op === "no") {
      await reply(chatId, say.CANCELLED_TEXT);
      return true;
    }
    if (current.kind === "pick") {
      // ตัวเลือกจากขอบชื่อกำกวม (split) พกคำสั่งของตัวเอง — ใช้ของตัวที่ถูกเลือก
      const chosen = typeof target.instruction === "string"
        ? { ...current.action, instruction: cleanInstruction(target.instruction, 500) }
        : current.action;
      await proceed(chatId, owner, chosen, target);
    } else {
      await execute(chatId, owner, current.action, target, { confirmed: current.kind === "confirm" });
    }
    return true;
  }

  // บทเรียนจากแชท: กดยืนยัน = บันทึกผ่านด่านเดียวกับคอนโซล · ยกเลิก = ไม่มีอะไรถูกเขียน
  async function answerLesson(chatId, owner, current, op) {
    if (op !== "ok" && op !== "no") return false;
    pending = null;
    if (current.messageId) client.clearKeyboard({ chatId, messageId: current.messageId }).catch(() => {});
    await reply(chatId, op === "no" ? say.CANCELLED_TEXT : chat.saveLesson(current.lesson, owner));
    return true;
  }

  async function handleOwnerText(chatId, owner, text) {
    const number = choiceNumber(text);
    const chatOn = chat.enabled();
    // ข้อความล่าสุดของบอทเป็นคำตอบแชทที่ใหม่กว่ารายการที่รอ = พี่ง้วงกำลังตอบลูกแพร ไม่ใช่ตอบรายการนั้น
    const chatIsLatest = chatOn && chat.contextOpen() && chat.lastReplySeq() > Number(pending?.seq || 0);
    if (pending?.chatId === String(chatId)) {
      if (pending.kind === "pick" && number && !chatIsLatest) return answerPending(chatId, owner, String(number));
      if (pending.kind !== "pick" && (chatIsLatest ? EXPLICIT_CONFIRM : CONFIRM_WORDS).test(text)) return answerPending(chatId, owner, "ok");
      if ((chatIsLatest ? EXPLICIT_CANCEL : CANCEL_WORDS).test(text)) return answerPending(chatId, owner, "no");
    }
    // เลขเดี่ยว ๆ ระหว่างคุยกันอยู่ = ตอบคำถามของลูกแพร ("เอากี่แบบ" → "3") ไม่ใช่เลือกห้อง
    if (number && !(chatOn && chat.contextOpen())) return reply(chatId, say.NO_CHOICE_TEXT);
    // "บทเรียนรออนุมัติ" = รายการพร้อมปุ่ม (อ่านอย่างเดียวจนกว่าจะกดปุ่ม) — คำสั่งตายตัว ไม่ผ่าน mini AI/สมองแชท
    if (lessonDigest.isListCommand(text)) {
      pending = null;
      chat.closeContext();
      return lessonDigest.sendList(chatId, owner);
    }
    let command = parseOwnerCommand(text);
    if (command.action === "empty") return null;
    if (command.action === "unknown") {
      const stopTyping = chatOn ? chat.startTyping(chatId) : null;
      // วางแผนค้นข้อมูลไปพร้อมกับ mini AI (อ่านอย่างเดียว · ถ้าเป็นคำสั่งผลนี้ถูกทิ้ง)
      const lookup = chatOn && !number ? chat.prefetch({ text, owner }) : null;
      try {
        // ข้อความสั้นมาก/ยาวเกิน/ไม่มีตัวอักษร ไม่ต้องเสียค่าโมเดลถอดความ
        const worthParsing = !number && [...text].length >= 4 && [...text].length <= 400 && /\p{L}/u.test(text);
        command = worthParsing ? await miniAiParse(text) : null;
        // ถามเรื่องลูกค้าเป็นภาษาพูดที่ mini AI อ่านเป็น "สถานะ" = ลูกแพรตอบคำถามจริงพร้อมห้องนั้น (อ่านอย่างเดียว)
        const focus = chatOn && command?.action === "status" ? chat.focus(command) : null;
        if (!command || focus) return chatOn ? await chat.talk({ chatId, owner, text, pending, ask, focus, lookup }) : await reply(chatId, say.UNKNOWN_TEXT);
      } finally {
        stopTyping?.();
      }
    }
    pending = null; // คำสั่งใหม่ = ทิ้งรายการเลือกเก่า
    chat.closeContext(); // หลังคำสั่ง เลขเดี่ยว ๆ กลับไปหมายถึงการเลือกห้องตามเดิม
    return handleCommand(chatId, owner, command);
  }

  async function handleMessage(message) {
    if (typeof message?.text !== "string" || message.chat?.type !== "private" || message.from?.is_bot) return;
    const text = message.text.trim();
    const owner = store.owner();
    const start = /^\/start(?:@\w+)?\s+(\S+)$/iu.exec(text);
    if (start && store.pairing()) {
      const paired = store.consumePairing(start[1], { userId: message.from.id, chatId: message.chat.id });
      if (paired.ok) {
        try { db.addAudit({ operator: paired.pairedBy || "owner", action: "telegram_paired", detail: `user …${String(message.from.id).slice(-4)}` }); } catch { /* ห้ามล้ม */ }
        pending = null;
        return reply(message.chat.id, say.pairedText(helpFlags()));
      }
    }
    if (!isOwner(message.from, message.chat, owner)) return quietLog("telegramControl: ข้ามข้อความจากบัญชีที่ไม่ได้จับคู่");
    if (start) return reply(message.chat.id, say.helpText(helpFlags()));
    const sentAt = Number(message.date) * 1000;
    if (Number.isFinite(sentAt) && sentAt > 0 && now() - sentAt > STALE_COMMAND_MS) {
      return reply(message.chat.id, say.staleText(sentAt, now()));
    }
    store.patchStatus({ lastCommandAt: now() });
    return handleOwnerText(message.chat.id, owner, text);
  }

  async function handleCallback(query) {
    const owner = store.owner();
    const chat = query?.message?.chat;
    if (!isOwner(query?.from, chat, owner)) return quietLog("telegramControl: ข้ามปุ่มจากบัญชีที่ไม่ได้จับคู่");
    client.answerCallbackQuery({ id: query.id }).catch(() => {});
    const [prefix, nonce, op] = String(query.data || "").split(":");
    // ปุ่มสรุปบทเรียน (คนละคำนำหน้ากับรายการที่รอ "y:") — ผูกกับ id บทเรียน ไม่ใช่ pending ตัวเดียวของแชท
    if (prefix === "L") return lessonDigest.handleCallback({ chatId: chat.id, owner, data: query.data, message: query.message });
    if (prefix !== "y" || !pending || pending.nonce !== nonce) return reply(chat.id, say.EXPIRED_TEXT);
    return answerPending(chat.id, owner, op);
  }

  async function handleUpdate(update) {
    try {
      if (update?.callback_query) return await handleCallback(update.callback_query);
      if (update?.message) return await handleMessage(update.message);
    } catch (err) {
      logger.error?.(`telegramControl: ทำคำสั่งไม่สำเร็จ (${err?.name || "Error"})`);
      const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
      const owner = store.owner();
      if (owner && String(chatId) === owner.chatId) await reply(chatId, say.ERROR_TEXT).catch(() => {});
    }
    return null;
  }

  async function pollOnce({ timeoutSec = POLL_TIMEOUT_SEC } = {}) {
    const token = store.token();
    if (!token) return { ok: false, reason: "no_token" };
    if (token === deadToken) return { ok: false, reason: "token_rejected" };
    const offset = store.offset();
    const response = await client.getUpdates({ offset, timeoutSec, signal: stopController?.signal ?? null });
    // โทเคนถูกเปลี่ยน/ลบระหว่าง long poll: ผลนี้เป็นของบอทตัวเก่า — update id นับแยกต่อบอท
    // ถ้าเอามาเขียน offset จะทำให้ข้อความแรก ๆ ของบอทใหม่ถูกข้ามทิ้ง
    if (store.token() !== token) return { ok: false, reason: "token_changed" };
    if (!response.ok) {
      if (response.reason === "aborted") return response;
      if (response.errorCode === 401) deadToken = token; // ไม่ยิงซ้ำด้วยโทเคนที่ Telegram ปฏิเสธแล้ว
      store.patchStatus({ lastError: say.pollErrorText(response), lastErrorAt: now() });
      quietLog(`telegramControl: รับข้อความไม่สำเร็จ (${response.errorCode || response.reason})`);
      return response;
    }
    const updates = Array.isArray(response.result) ? response.result : [];
    let handled = 0;
    for (const update of updates) {
      if (store.token() !== token || !running && stopController?.signal?.aborted) break; // เปลี่ยนบอท/กำลังปิดระหว่างทำชุดนี้
      const id = Number(update?.update_id);
      if (!Number.isSafeInteger(id) || id < store.offset()) continue; // ของเก่า/เล่นซ้ำ
      store.setOffset(id + 1); // บันทึกก่อนทำ: ดับกลางทาง = ไม่ทำซ้ำ (ส่งถึงลูกค้าอย่างมากครั้งเดียว)
      await handleUpdate(update);
      handled += 1;
    }
    if (now() - lastOkWrite >= OK_STATUS_EVERY_MS || handled) {
      lastOkWrite = now();
      store.patchStatus({ lastOkAt: now(), lastError: "", lastErrorAt: 0 });
    }
    return { ok: true, handled };
  }

  // ตัด long poll ที่ค้างอยู่ (ของโทเคนเดิม) แล้วปลุกให้เริ่มรอบใหม่ทันที
  function restartPoll() {
    if (!running) return;
    stopController?.abort();
    stopController = new AbortController();
    wakeUp?.();
  }

  function pause(ms) {
    return new Promise((resolve) => {
      if (sleep) { sleep(ms).then(resolve, resolve); wakeUp = resolve; return; }
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      wakeUp = () => { clearTimeout(timer); resolve(); };
    });
  }

  async function loop() {
    let backoffMs = 0;
    while (running) {
      if (!store.token()) {
        await pause(IDLE_NO_TOKEN_MS);
        continue;
      }
      const startedAt = now();
      const result = await pollOnce().catch(() => ({ ok: false, reason: "error" }));
      if (!running) break;
      if (result.ok) {
        backoffMs = 0;
        // long poll ปกติค้างรอ ~25 วิ — ถ้ากลับมาเร็วผิดปกติแบบว่างเปล่า ห้ามวนยิงรัว ๆ
        if (!result.handled && now() - startedAt < 1_000) await pause(1_000);
        continue;
      }
      if (result.reason === "token_rejected") { await pause(IDLE_NO_TOKEN_MS * 4); continue; }
      if (result.reason === "token_changed" || result.reason === "aborted") continue; // เริ่มรอบใหม่ด้วยโทเคนปัจจุบัน
      backoffMs = result.errorCode === 429 && result.retryAfter
        ? result.retryAfter * 1000
        : Math.min(300_000, Math.max(5_000, backoffMs * 2));
      await pause(backoffMs);
    }
  }

  return {
    handleUpdate,
    pollOnce,
    start() {
      if (running) return false;
      // White-label: ช่องสั่งงานเจ้าของทาง Telegram/YOLO เป็นของธุรกิจคอร์สของพี่ง้วง — generic ไม่เปิดเลย
      if (isGenericProfile(config?.brand)) return false;
      running = true;
      stopController = new AbortController();
      loop().catch((err) => logger.error?.(`telegramControl: ตัวรับข้อความหยุด (${err?.name || "Error"})`));
      // สรุปบทเรียนรออนุมัติ 22:00 — ตรวจนาทีละครั้ง (จดวันที่ส่งใน settings: รีสตาร์ตไม่ส่งซ้ำ)
      digestTimer = setInterval(() => {
        lessonDigest.tick().catch((err) => logger.warn?.(`telegramControl: สรุปบทเรียนไม่สำเร็จ (${err?.name || "Error"})`));
      }, LESSON_DIGEST_TICK_MS);
      digestTimer.unref?.();
      return true;
    },
    stop() {
      running = false;
      stopController?.abort();
      wakeUp?.();
      if (digestTimer) clearInterval(digestTimer);
      digestTimer = null;
    },
    // เทสต์/ตัวตั้งเวลาเรียกตรง ๆ ได้ (start() ตั้งนาฬิกาเรียกทุกนาที)
    lessonDigestTick: () => lessonDigest.tick(),
    wake: () => wakeUp?.(),
    get running() { return running; },

    /* ---------------------- ใช้จากคอนโซล (consoleYoloApi.mjs) ---------------------- */
    view() {
      const owner = store.owner();
      const pairing = store.pairing();
      const status = store.status();
      const token = store.token();
      return {
        configured: Boolean(token),
        tokenHint: maskBotToken(token),
        botUsername: store.botName(),
        paired: owner ? { pairedBy: owner.pairedBy || "", pairedAt: Number(owner.pairedAt) || null, userHint: `…${String(owner.userId).slice(-4)}` } : null,
        pairing: pairing ? { expiresAt: Number(pairing.expiresAt) } : null,
        pairingLockedAt: Number(status.pairingLockedAt) || null,
        lastOkAt: Number(status.lastOkAt) || null,
        lastCommandAt: Number(status.lastCommandAt) || null,
        lastError: String(status.lastError || ""),
        lastErrorAt: Number(status.lastErrorAt) || null,
        running,
      };
    },
    // ตรวจกับ Telegram ก่อนเก็บ (getMe) — โทเคนผิดไม่ถูกบันทึกเลย
    async saveToken(token) {
      const value = String(token || "").trim();
      if (!TELEGRAM_BOT_TOKEN_PATTERN.test(value)) return { ok: false, status: 400, error: "รูปแบบโทเคนไม่ถูกต้อง — คัดลอกจาก @BotFather ทั้งบรรทัด (ตัวเลข:ตัวอักษร)" };
      const me = await client.getMe({ token: value });
      if (!me.ok) {
        return me.errorCode === 401 || me.errorCode === 404
          ? { ok: false, status: 400, error: "Telegram ไม่รับโทเคนนี้ — ตรวจว่าคัดลอกครบหรือสร้างบอทใหม่" }
          : { ok: false, status: 502, error: "ติดต่อ Telegram ไม่ได้ตอนตรวจโทเคน ลองใหม่อีกครั้งค่ะ" };
      }
      if (me.result?.is_bot !== true) return { ok: false, status: 400, error: "โทเคนนี้ไม่ใช่ของบอท" };
      store.saveToken(value, String(me.result?.username || ""));
      deadToken = "";
      pending = null;
      restartPoll();
      return { ok: true, botUsername: String(me.result?.username || "") };
    },
    clearToken() {
      store.clearAll();
      pending = null;
      restartPoll();
    },
    createPairing(createdBy) {
      if (!store.token()) return { ok: false, status: 409, error: "ตั้งโทเคนบอทก่อนแล้วค่อยสร้างรหัสจับคู่" };
      const { code, expiresAt } = store.createPairing(createdBy);
      const bot = store.botName();
      return { ok: true, code, expiresAt, botUsername: bot, deepLink: bot ? `https://t.me/${bot}?start=${code}` : "" };
    },
    unpair() {
      store.clearOwner();
      pending = null;
    },
  };
}
