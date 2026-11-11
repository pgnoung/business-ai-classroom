// telegramClient.mjs — Telegram Bot API ขั้นต่ำสำหรับ "ลูกแพรรับคำสั่งพี่ง้วง" (2026-09-28)
//
// กติกาความลับ (ห้ามพลาด): โทเคนบอทอยู่ใน path ของ URL (…/bot<token>/method) ตามสเปก Telegram
// จึง "ห้าม log URL / ห้ามคืนข้อความ error ดิบ" เด็ดขาด — ทุกผลที่ออกจากไฟล์นี้ผ่าน redact แล้ว
// และ error เครือข่ายคืนแค่ชื่อชนิด (TypeError/TimeoutError) ไม่ใช่ message ที่อาจพก URL มาด้วย
//
// ทุกคำขอมี AbortSignal.timeout (SPEC ข้อ 5) · getUpdates ต่อ signal ของผู้เรียกเพื่อหยุดตอนปิดระบบ
const API_BASE = "https://api.telegram.org";
// รูปโทเคนจาก @BotFather: <bot id ตัวเลข>:<ความลับ 35 ตัว> — เผื่อความยาวไว้กว้าง ๆ แต่ปิดอักขระแปลก
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{5,15}:[A-Za-z0-9_-]{30,80}$/u;
const MAX_TEXT = 3900; // เพดานจริงของ Telegram 4096 — เผื่ออีโมจิ/อักขระคู่

// โชว์บนคอนโซลแบบปิดบัง: เลข bot id (สาธารณะอยู่แล้ว) + จุด ๆ — ไม่มีส่วนลับแม้แต่ตัวเดียว
export function maskBotToken(token) {
  const value = String(token || "");
  const id = /^(\d{5,15}):/u.exec(value)?.[1];
  return id ? `${id}:••••••••` : "";
}

export function redactBotSecrets(text, token = "") {
  let value = String(text ?? "");
  if (token) value = value.split(String(token)).join("[token]");
  // กันพลาดชั้นสอง: รูป bot<id>:<secret> ใด ๆ ที่หลุดมาในข้อความ
  return value.replace(/\d{5,15}:[A-Za-z0-9_-]{30,80}/gu, "[token]");
}

function clip(text) {
  const chars = [...String(text ?? "")];
  return chars.length <= MAX_TEXT ? chars.join("") : `${chars.slice(0, MAX_TEXT - 1).join("")}…`;
}

// "คุยกับลูกแพร" (28 ก.ย. 2026): คำตอบแบบแชท (สคริปต์/แคปชั่นหลายแบบ) ยาวเกินข้อความเดียวได้ —
// แบ่งเป็นหลายข้อความที่รอยต่อย่อหน้า > บรรทัด > ช่องว่าง (ไม่ตัดกลางคำ/กลางสระ) แทนการตัดท้ายทิ้งด้วย clip
// นับเป็นหน่วย UTF-16 (String.length) ซึ่งไม่น้อยกว่าที่ Telegram นับ จึงไม่มีทางเกินเพดานจริง
export const TELEGRAM_CHUNK_MAX = 3800;
export const TELEGRAM_MAX_CHUNKS = 5;
const CHUNK_OVERFLOW_NOTE = "\n\n(ยาวเกินกว่าจะส่งครบในแชท ลูกแพรตัดท้ายไว้ตรงนี้ค่ะ)";
const GRAPHEMES = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter("th", { granularity: "grapheme" }) : null;

function hardCut(text, max) {
  if (!GRAPHEMES) return Math.max(1, max);
  let used = 0;
  for (const part of GRAPHEMES.segment(text)) {
    if (used + part.segment.length > max) break;
    used += part.segment.length;
  }
  return Math.max(1, used);
}

function cutPoint(text, max) {
  const window = text.slice(0, max + 1);
  for (const mark of ["\n\n", "\n", " "]) {
    const at = window.lastIndexOf(mark, max);
    if (at >= max * 0.5) return at;
  }
  return hardCut(text, max);
}

export function splitTelegramText(text, { max = TELEGRAM_CHUNK_MAX, maxChunks = TELEGRAM_MAX_CHUNKS } = {}) {
  let rest = String(text ?? "").replace(/\r\n?/gu, "\n").trim();
  const chunks = [];
  while (rest && chunks.length < maxChunks) {
    if (rest.length <= max) { chunks.push(rest); rest = ""; break; }
    const at = cutPoint(rest, max);
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest && chunks.length) {
    const last = chunks.pop();
    const room = max - CHUNK_OVERFLOW_NOTE.length;
    chunks.push(`${last.length > room ? last.slice(0, hardCut(last, room)).trimEnd() : last}${CHUNK_OVERFLOW_NOTE}`);
  }
  return chunks.filter(Boolean);
}

export function createTelegramClient({ getToken, fetchImpl = (...args) => globalThis.fetch(...args), baseUrl = API_BASE } = {}) {
  const readToken = () => {
    try { return String(getToken?.() || ""); } catch { return ""; }
  };

  async function call(method, params = {}, { timeoutMs = 15_000, signal = null, token: tokenOverride = "" } = {}) {
    const token = String(tokenOverride || readToken());
    if (!token) return { ok: false, errorCode: 0, reason: "no_token" };
    let res;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      res = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: signal && typeof signal.addEventListener === "function" ? AbortSignal.any([timeout, signal]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) return { ok: false, errorCode: 0, reason: "aborted" };
      // ชื่อชนิดเท่านั้น — message ของ fetch บางตัวแนบ URL (ซึ่งมีโทเคน) มาด้วย
      return { ok: false, errorCode: 0, reason: "network", detail: String(err?.name || "Error") };
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res?.ok || data?.ok !== true) {
      return {
        ok: false,
        errorCode: Number(data?.error_code || res?.status || 0),
        reason: "api",
        description: redactBotSecrets(String(data?.description || ""), token).slice(0, 200),
        retryAfter: Math.max(0, Number(data?.parameters?.retry_after || 0)),
      };
    }
    return { ok: true, result: data.result };
  }

  return {
    call,
    getMe: ({ token = "" } = {}) => call("getMe", {}, { timeoutMs: 10_000, token }),
    getUpdates: ({ offset = 0, timeoutSec = 25, signal = null } = {}) => call("getUpdates", {
      offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"],
    }, { timeoutMs: (timeoutSec + 15) * 1000, signal }),
    // ข้อความธรรมดาเสมอ (ไม่มี parse_mode) — ข้อความลูกค้าที่มีเครื่องหมายแปลก ๆ จะไม่ทำให้ส่งพัง
    sendMessage: ({ chatId, text, keyboard = null }) => call("sendMessage", {
      chat_id: chatId, text: clip(text), link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }),
    // "กำลังพิมพ์…" อยู่ได้ ~5 วิ ต่อครั้ง — ผู้เรียกยิงซ้ำระหว่างรอโมเดล (telegramOwnerChat.mjs)
    sendChatAction: ({ chatId, action = "typing" }) => call("sendChatAction", { chat_id: chatId, action }, { timeoutMs: 5_000 }),
    answerCallbackQuery: ({ id, text = "" }) => call("answerCallbackQuery", {
      callback_query_id: id, ...(text ? { text: clip(text).slice(0, 190) } : {}),
    }),
    clearKeyboard: ({ chatId, messageId }) => call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
    }),
    // เปลี่ยนชุดปุ่มใต้ข้อความเดิม (สรุปบทเรียน: ตัดสินเรื่องไหนแล้ว ปุ่มเรื่องนั้นหาย)
    setKeyboard: ({ chatId, messageId, keyboard = [] }) => call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: Array.isArray(keyboard) ? keyboard : [] },
    }),
  };
}
