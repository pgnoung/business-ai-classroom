// telegramReplies.mjs — ข้อความที่ "ลูกแพร" ตอบพี่ง้วงทาง Telegram (2026-09-28)
//
// เสียง: ลูกแพรพูดเอง สุภาพ ลงท้ายค่ะ สั้น อ่านบนมือถือจบในจอเดียว
// ความเป็นส่วนตัว: Telegram ไม่ใช่ช่องทางเข้ารหัสปลายทาง — ชื่อลูกค้าปิดบางส่วนเสมอ ("คุณ ส***")
// ข้อความที่ส่งจริงแสดงเต็มตามที่พี่ง้วงขอ (ต้องรู้ว่าลูกค้าได้อะไรไป) · ข้อความธรรมดา ไม่มี markup
import { aiOffReasonText, formatBangkokTime, maskName, previewText } from "./yoloText.mjs";

const RULE = "────────";

export function customerTag(customer, keep = 1) {
  return `คุณ ${maskName(customer?.name || customer?.label || customer?.displayName || "", keep)} (${customer?.channel || "LINE"})`;
}

export function roomLink(config, customerId) {
  const base = String(config?.consolePublicBaseUrl || "").trim();
  return base && customerId ? `🔗 ${base}/#/c/${encodeURIComponent(String(customerId))}` : "";
}

const lines = (...parts) => parts.flat().filter((part) => part !== null && part !== undefined && part !== "").join("\n");

const COMMAND_LINES = [
  "⚡ yolo LINE คุณเอ ถามต่อเรื่องจำนวนพนักงาน",
  "   ให้ลูกแพรพิมพ์ต่อในห้องนั้นตอนนี้ 1 ครั้ง (ไม่ใส่เรื่องก็ได้ ลูกแพรอ่านบริบทเอง)",
  "   ต่อท้ายว่า \"แล้วคุยต่อ\" = เปิด AI ห้องนั้นต่อให้ด้วย",
  "🟢 เปิด AI LINE คุณเอ",
  "🔴 ปิด AI FB คุณบี",
  "🔎 สถานะ คุณเอ",
];

// chat = สวิตช์ "คุยกับลูกแพร" (owner_chat_mode) เปิดอยู่ไหม — ปิดอยู่ห้ามบอกว่าคุยได้ (28 ก.ย. 2026)
// lessons = จอสอนเปิด (มีบทเรียนให้อนุมัติ) · digest = ส่งสรุปบทเรียนทุกคืน 22:00 (lesson_digest_mode)
export function helpText({ chat = false, lessons = false, digest = false } = {}) {
  return lines(
    chat ? "ลูกแพรอยู่ตรงนี้ค่ะพี่ง้วง 😊 พิมพ์คุยกันได้ทุกเรื่องเลย — คลาส รอบเรียน ที่นั่ง ลูกค้า หรือให้ช่วยคิดแคปชั่นก็ได้ค่ะ" : "ลูกแพรพร้อมรับคำสั่งค่ะพี่ง้วง 😊",
    "",
    chat ? "ส่วนงานที่ต้องทำกับห้องลูกค้า ใช้คำสั่งนี้ค่ะ (ลูกแพรในแชทส่งหาลูกค้าเองไม่ได้):" : "",
    COMMAND_LINES,
    lessons ? "📚 บทเรียนรออนุมัติ" : "",
    lessons ? `   ดูบทเรียนที่ทีมสอนลูกแพรไว้ แล้วกดอนุมัติ/ไม่ใช้ในแชทนี้ได้เลย${digest ? " (ถ้ามีเรื่องรอ ลูกแพรส่งสรุปให้ทุกคืน 22:00)" : ""}` : "",
    "",
    "ชื่อซ้ำ/คล้ายกัน ลูกแพรจะให้เลือกเลขก่อนเสมอ · พิมพ์ภาษาปกติก็ได้ ลูกแพรจะทวนความเข้าใจให้กดยืนยันก่อนค่ะ",
    chat ? "สอนวิธีตอบลูกค้าได้ด้วย เช่น \"ต่อไปถ้าลูกค้าถามเรื่องที่จอดรถ ให้ตอบว่า…\" ลูกแพรจะให้กดยืนยันก่อนบันทึกเป็นบทเรียนค่ะ" : "",
  );
}

// ค่าตั้งต้นของสวิตช์คือเปิด (ไม่มีแถว = เปิด) — ข้อความช่วยเหลือมาตรฐานจึงบอกว่าคุยได้ + คำสั่งบทเรียนรออนุมัติ
export const HELP_TEXT = helpText({ chat: true, lessons: true, digest: true });

export const UNKNOWN_TEXT = lines(
  "ลูกแพรยังไม่เข้าใจคำสั่งนี้ค่ะ 🙏 ลองแบบนี้นะคะ",
  "yolo LINE คุณเอ ถามต่อเรื่องจำนวนพนักงาน",
  "หรือพิมพ์ \"ช่วยด้วย\" เพื่อดูคำสั่งทั้งหมดค่ะ",
);

export const CANCELLED_TEXT = "ยกเลิกแล้วค่ะ 👌";
export const EXPIRED_TEXT = "รายการนี้ทำไปแล้วหรือหมดอายุแล้วค่ะ (เกิน 10 นาที) ส่งคำสั่งใหม่ได้เลยนะคะ";
export const NO_CHOICE_TEXT = "ตอนนี้ไม่มีรายการให้เลือกค่ะ ส่งคำสั่งใหม่ได้เลยนะคะ";
export const ERROR_TEXT = "ขออภัยค่ะ ลูกแพรทำคำสั่งนี้ไม่สำเร็จ ลองใหม่อีกครั้งนะคะ";

export function pairedText(flags = {}) {
  return lines("✅ จับคู่สำเร็จแล้วค่ะพี่ง้วง ต่อจากนี้ลูกแพรรับคำสั่งจากบัญชีนี้บัญชีเดียวนะคะ", "", helpText(flags));
}

/* --------------------------- "คุยกับลูกแพร" · บทเรียน --------------------------- */

export function lessonOfferText(lesson) {
  return lines(
    "📝 บันทึกเป็นบทเรียนให้ลูกแพรไหมคะ",
    lesson?.topic ? `หัวข้อ: ${lesson.topic}` : "",
    `สอน: ${lesson?.teaching || ""}`,
    "บันทึกแล้วลูกแพรใช้กับลูกค้าทุกคนตั้งแต่ข้อความถัดไป (แก้/ปิดได้ที่เมนู \"บทเรียน\" ในคอนโซล)",
    "กดปุ่ม หรือพิมพ์ \"ยืนยัน\" ภายใน 10 นาทีค่ะ",
  );
}

export function lessonSavedText(result) {
  const pending = result?.lessonStatus === "pending";
  return lines(
    `${pending ? "📨" : "✅"} ${result?.message || ""}`,
    pending ? "บัญชีที่จับคู่ไว้ไม่มีสิทธิ์อนุมัติ — บทเรียนรอเจ้าของกดอนุมัติในเมนู \"บทเรียน\" ก่อนนะคะ" : "",
  );
}

export function lessonRefusedText(error) {
  return `📝 บทเรียนนี้ลูกแพรยังบันทึกให้ไม่ได้ค่ะ — ${error || "ลองพิมพ์ใหม่อีกครั้งนะคะ"}`;
}

export function staleText(atMs, nowMs) {
  return `⏱ คำสั่งนี้ส่งมาเมื่อ ${formatBangkokTime(atMs, nowMs)} ระหว่างที่ระบบยังไม่พร้อม ลูกแพรขอข้ามไว้ก่อนนะคะ ถ้ายังต้องการ ส่งใหม่ได้เลยค่ะ`;
}

export function needNameText(action) {
  const example = action === "status" ? "สถานะ คุณเอ" : action === "yolo" ? "yolo LINE คุณเอ ถามต่อเรื่องราคา" : `${action === "ai_on" ? "เปิด" : "ปิด"} AI LINE คุณเอ`;
  return `ขอชื่อลูกค้าด้วยนะคะ เช่น "${example}"`;
}

export function workingText(target) {
  return `⏳ รับทราบค่ะ ลูกแพรกำลังอ่านห้อง${customerTag(target)} แล้วร่างข้อความให้นะคะ`;
}

function aiStateLine(customer, aiChanged = false) {
  if (!customer) return "";
  if (customer.aiEnabled) {
    return `AI ห้องนี้: 🟢 เปิด${aiChanged ? " (เปิดตามคำสั่ง)" : ""} — ลูกค้าตอบมา ลูกแพรคุยต่อให้เองค่ะ`;
  }
  return `AI ห้องนี้: 🔴 ปิดอยู่ (${aiOffReasonText(customer.aiOffReason)}) — ลูกค้าตอบมา ลูกแพรจะยังไม่ตอบนะคะ`;
}

function warningLines(warnings = []) {
  return (Array.isArray(warnings) ? warnings : []).map((warning) => `⚠️ ${warning.text || warning.code}`);
}

const SEND_FAILURE_TEXT = Object.freeze({
  live_send_disabled: "ระบบยังไม่เปิดส่งจริงสำหรับช่องทางนี้",
  pilot_not_allowlisted: "ห้องนี้ยังไม่อยู่ในรายชื่อที่อนุญาตให้ส่ง (pilot)",
  no_access_token: "ช่องทางนี้ยังไม่มีโทเคน",
  internal_error: "ระบบขัดข้องระหว่างส่ง — ตรวจในห้องก่อนสั่งซ้ำนะคะ",
});

export function sentText(result, config) {
  const ladder = result.ladder;
  return lines(
    `ส่งให้${customerTag(result.customer)} แล้วค่ะพี่ง้วง 👇`,
    RULE,
    result.sentText || "",
    result.images?.length ? `🖼 รูป: ${result.images.join(", ")}` : "",
    RULE,
    result.status === "partial" ? `⚠️ ส่งได้บางส่วน (${result.delivered}/${result.expected}) — ตรวจในห้องก่อนสั่งซ้ำนะคะ` : "",
    aiStateLine(result.customer, result.aiChanged),
    // FU อัตโนมัติทำงานเฉพาะห้องที่ AI เปิด — ห้องที่ทีมดูแลไม่ต้องรายงานเรื่องบันได
    ladder && ladder.after > ladder.before && result.customer?.aiEnabled ? `FU อัตโนมัติเลื่อนไปขั้น ${ladder.after}/${ladder.ladderLength} แล้ว วันนี้ไม่ทักซ้ำค่ะ` : "",
    warningLines(result.warnings),
    roomLink(config, result.customer?.id),
  );
}

export function refusedText(result, config) {
  const detail = SEND_FAILURE_TEXT[result.detail] || (result.detail && /^\d+$/u.test(String(result.detail)) ? `ผู้ให้บริการตอบรหัส ${result.detail}` : "");
  return lines(
    `🚫 ยังไม่ได้ส่งถึง${result.customer ? customerTag(result.customer) : "ลูกค้า"}ค่ะ`,
    result.reasonText || result.reason || "",
    detail ? `(${detail})` : "",
    warningLines(result.warnings),
    roomLink(config, result.customer?.id),
  );
}

export function confirmText(result) {
  return lines(
    `⚠️ ขอยืนยันก่อนนะคะ — ${customerTag(result.customer)}`,
    (result.confirm || []).map((item) => `• ${item.text}`),
    warningLines(result.warnings),
    "กดปุ่ม หรือพิมพ์ \"ยืนยัน\" ภายใน 10 นาทีค่ะ",
  );
}

export function interpretationText(action, target) {
  const head = action.action === "yolo" ? "⚡ yolo" : action.action === "ai_on" ? "🟢 เปิด AI" : "🔴 ปิด AI";
  return lines(
    "ลูกแพรเข้าใจว่า 👇",
    `${head} → ${customerTag(target)}`,
    action.action === "yolo" ? `เรื่อง: ${action.instruction || "(ให้ลูกแพรอ่านบริบทแล้วเลือกเอง)"}` : "",
    action.action === "yolo" && action.alsoEnableAi ? "แล้วเปิด AI ห้องนี้ต่อด้วย" : "",
    "ถูกต้องไหมคะ",
  );
}

function choiceLine(room, index, nowMs) {
  const snippet = room.lastMessage ? ` · "${previewText(room.lastMessage, 40)}"` : "";
  // ตัวเลือกที่ขอบชื่อต่างกัน (split) พกคำสั่งของตัวเอง — โชว์ให้เห็นว่าเลือกแล้วลูกแพรจะทำเรื่องอะไร
  const topic = typeof room.instruction === "string" ? `\n   ↳ เรื่อง: ${previewText(room.instruction, 40) || "(ให้ลูกแพรเลือกเอง)"}` : "";
  return `${index + 1}) ${maskName(room.label, 3)} · ${room.channelId === "facebook" ? "FB" : "LINE"} · ${formatBangkokTime(room.lastMessageAt, nowMs)}${snippet}${topic}`;
}

const PICK_HEAD = Object.freeze({
  many: (query, total) => `เจอ ${total} ห้องที่ชื่อเข้ากับ "${query}" ค่ะ เลือกเลขได้เลย 👇`,
  similar: (query) => `มีชื่อคล้าย "${query}" มากกว่าหนึ่งห้องค่ะ ขอให้เลือกก่อนส่งนะคะ 👇`,
  loose: (query) => `ไม่มีห้องชื่อ "${query}" ตรงตัวค่ะ ห้องที่ใกล้ที่สุดคือห้องนี้ — ใช่ไหมคะ 👇`,
  split: (query) => `ชื่อ "${query}" อ่านได้มากกว่าหนึ่งแบบค่ะ เลือกห้องที่ตั้งใจก่อนนะคะ 👇`,
});

// mode: many = หลายห้องชื่อเข้า · similar = ชื่อตรงแต่มีชื่อคล้าย · loose = เดาจากชื่อบางส่วน · split = ขอบชื่อกำกวม
export function pickText(query, matches, nowMs, { total = matches.length, mode = "many" } = {}) {
  return lines(
    (PICK_HEAD[mode] || PICK_HEAD.many)(query, total),
    matches.map((room, index) => choiceLine(room, index, nowMs)),
    total > matches.length ? `(แสดง ${matches.length} ห้องที่คุยล่าสุด — พิมพ์ชื่อให้ยาวขึ้นเพื่อแคบลงได้ค่ะ)` : "",
    "พิมพ์เลข หรือกดปุ่ม ภายใน 10 นาทีค่ะ",
  );
}

export function pickRangeText(count) {
  return count > 1
    ? `เลือกเลข 1–${count} นะคะ (หรือพิมพ์ "ยกเลิก")`
    : "มีให้เลือกแค่เลข 1 ค่ะ (หรือพิมพ์ \"ยกเลิก\")";
}

export function notFoundText(query, channel, suggestions = [], nowMs = Date.now()) {
  return lines(
    `🔍 ไม่พบห้องชื่อ "${query}"${channel ? ` ใน ${channel}` : ""} ค่ะ`,
    suggestions.length ? "ชื่อใกล้เคียง:" : "",
    suggestions.map((room, index) => choiceLine(room, index, nowMs)),
    suggestions.length ? "ถ้าใช่ พิมพ์คำสั่งใหม่ด้วยชื่อนั้นได้เลยค่ะ" : "ลองพิมพ์ชื่อจริงหรือชื่อ LINE ของลูกค้าอีกครั้งนะคะ",
  );
}

export function aiSwitchedText(target, enabled, { unchanged = false } = {}, config = null) {
  const head = unchanged
    ? `ห้อง${customerTag(target)} AI ${enabled ? "เปิด" : "ปิด"}อยู่แล้วค่ะ`
    : enabled
      ? `🟢 เปิด AI ห้อง${customerTag(target)} แล้วค่ะ — ลูกค้าทักมา ลูกแพรตอบเองนะคะ`
      : `🔴 ปิด AI ห้อง${customerTag(target)} แล้วค่ะ — ห้องนี้ทีมดูแลเองนะคะ`;
  return lines(head, roomLink(config, target?.id));
}

export function statusText(status, config, nowMs = Date.now()) {
  const icon = { ลูกค้า: "👤", ลูกแพร: "🤖", ทีม: "🙋" };
  return lines(
    `🔎 ${customerTag(status)}`,
    `AI: ${status.aiEnabled ? "🟢" : "🔴"} ${status.aiText}`,
    status.operatorPausedUntil ? `⏸ ทีมคุยอยู่ (AI พักถึง ${formatBangkokTime(status.operatorPausedUntil, nowMs)})` : "",
    status.needsHuman ? "🚩 มีธงรอคนดูแลค้างอยู่" : "",
    status.doNotDisturb ? "🔕 ลูกค้าขอไม่ให้รบกวน (DND)" : "",
    `ลูกค้าพิมพ์ล่าสุด: ${formatBangkokTime(status.lastInboundAt, nowMs)} · ทีมตอบล่าสุด: ${status.lastHumanReplyAt ? formatBangkokTime(status.lastHumanReplyAt, nowMs) : "ยังไม่มี"}`,
    `FU อัตโนมัติ: ${status.followup}`,
    status.fbWindowClosesAt ? `หน้าต่าง 24 ชม. ของ Facebook ปิด: ${formatBangkokTime(status.fbWindowClosesAt, nowMs)}` : "",
    status.recent.length ? `${status.recent.length} ข้อความล่าสุด:` : "ยังไม่มีข้อความ",
    status.recent.map((row) => `${icon[row.who] || "•"} ${row.who}: ${row.text || "-"}`),
    roomLink(config, status.id),
  );
}

// สถานะตัวรับข้อความที่คอนโซลโชว์ (ไม่ใช่ข้อความถึงพี่ง้วงใน Telegram) — description ถูกล้างโทเคนมาแล้ว
export function pollErrorText(result) {
  if (result?.reason === "network") return `เชื่อมต่อ Telegram ไม่ได้ (${result.detail || "network"})`;
  if (result?.errorCode === 401) return "โทเคนใช้ไม่ได้แล้ว (401) — วางโทเคนใหม่ในคอนโซล";
  if (result?.errorCode === 409) return "มีตัวอื่นรับข้อความบอทนี้อยู่ (webhook/โปรแกรมอื่น) — ใช้บอทใหม่สำหรับลูกแพรเท่านั้น";
  if (result?.errorCode === 429) return "Telegram ให้รอสักครู่ (429)";
  return `Telegram ตอบ ${result?.errorCode || "?"}${result?.description ? ` ${result.description}` : ""}`;
}

// ปุ่มแนบท้าย — callback_data ≤ 64 ไบต์: "y:<nonce>:<op>"
export function pickKeyboard(nonce, count) {
  const numbers = Array.from({ length: count }, (_, index) => ({ text: String(index + 1), callback_data: `y:${nonce}:${index + 1}` }));
  return [numbers, [{ text: "ยกเลิก", callback_data: `y:${nonce}:no` }]];
}

export function confirmKeyboard(nonce, label = "✅ ยืนยันส่ง") {
  return [[{ text: label, callback_data: `y:${nonce}:ok` }], [{ text: "ยกเลิก", callback_data: `y:${nonce}:no` }]];
}
