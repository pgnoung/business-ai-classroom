// yoloCommands.mjs — แปลงข้อความคำสั่งของพี่ง้วง (Telegram) เป็นการกระทำที่ตรวจได้
//
// สองชั้นตามที่ออกแบบ (2026-09-28):
//   1) ตัวแยกแบบกำหนดตายตัว สำหรับรูปแบบมาตรฐาน — ไม่มีโมเดล ไม่มีค่าใช้จ่าย ผลเดิมทุกครั้ง
//        yolo <LINE|FB> <ชื่อ> <สิ่งที่ให้ทำ> [แล้วคุยต่อ]
//        เปิด AI <LINE|FB> <ชื่อ> · ปิด AI <LINE|FB> <ชื่อ> · สถานะ <ชื่อ> · ช่วยด้วย/help
//   2) ภาษาพูดอิสระ → "mini AI" (โมเดลเล็กทางเดียวกับ scorer) ตอบ JSON ตายตัว แล้วตรวจเข้มที่นี่
//      โมเดลมีสิทธิ์แค่ "ถอดความ" — ชื่อลูกค้าต้องมีอยู่จริงในข้อความของพี่ง้วง (กันโมเดลเดาชื่อ)
//      และตัวที่เลือกห้องคือ customerResolver เสมอ ไม่ใช่โมเดล
import { cleanInstruction, nameKey } from "./yoloText.mjs";

export const OWNER_ACTIONS = Object.freeze(["yolo", "ai_on", "ai_off", "status", "help"]);
export const MAX_INSTRUCTION_CHARS = 500;
const MAX_TARGET_CHARS = 60;

const HELP = /^\/?(?:help|start|ช่วยด้วย|ช่วย|วิธีใช้|คำสั่ง|เมนู|\?)(?:@\w+)?$/iu;
const YOLO = /^\/?(?:yolo|โยโล่?)(?:@\w+)?(?:\s+|$)(.*)$/iu;
const AI_ON = /^\/?(?:ai\s*on|เปิด\s*(?:ai|เอไอ|บอท|ลูกแพร))(?:@\w+)?(?:\s+|$)(.*)$/iu;
const AI_OFF = /^\/?(?:ai\s*off|ปิด\s*(?:ai|เอไอ|บอท|ลูกแพร))(?:@\w+)?(?:\s+|$)(.*)$/iu;
const STATUS = /^\/?(?:status|สถานะ|เช็[คก]สถานะ|ดูสถานะ)(?:@\w+)?(?:\s+|$)(.*)$/iu;

const LINE_WORDS = "line|ไลน์|ไลน";
const FB_WORDS = "fb|facebook|messenger|เฟส(?:บุ๊?ค|บุ๊?ก)?|เฟซ(?:บุ๊?ค|บุ๊?ก)?|เพจ";
const CHANNEL_PREFIX = new RegExp(
  `^(?:\\(\\s*(${LINE_WORDS}|${FB_WORDS})\\s*\\)|(${LINE_WORDS}|${FB_WORDS})\\s*[:：]|(${LINE_WORDS}|${FB_WORDS})(?=\\s|$))\\s*`,
  "iu",
);
const LEADING_FILLER = /^(?:ห้อง(?:ของ)?|ของ|ให้|สำหรับ)\s+/u;
// คำลงท้ายที่ตัดได้ "เฉพาะเมื่อเว้นวรรคก่อน" — ชื่ออย่าง "มานะ" ต้องไม่ถูกตัดเป็น "มา"
const TRAILING_PARTICLES = /(?:\s+(?:ด้วย|หน่อย|นะ|ค่ะ|คะ|ครับ|จ้า|จ้ะ|เลย))+\s*$/u;
// "แล้วคุยต่อ" / "เปิด AI ด้วย" ท้ายคำสั่ง yolo = เปิด AI ห้องนั้นหลังส่งสำเร็จ
// "ชวนคุยต่อ" (ไม่มี "แล้ว" นำ) เป็นเนื้อคำสั่ง ไม่ใช่สวิตช์ — จึงบังคับให้มีคำเชื่อมหรือช่องว่าง
const ENABLE_AI_SUFFIX = new RegExp(
  "(?:แล้ว\\s*(?:ให้\\s*)?(?:ลูกแพร\\s*)?คุยต่อ"
  + "|(?:แล้ว|และ)\\s*เปิด\\s*(?:ai|เอไอ|บอท|ลูกแพร)"
  + "|(?:^|\\s)เปิด\\s*(?:ai|เอไอ|บอท|ลูกแพร)"
  + "|(?:^|\\s)\\+\\s*ai)"
  + "(?:\\s*(?:ด้วย|ต่อ|เลย|นะ|ไป|ไว้|ห้องนี้|ค่ะ|คะ|ครับ))*\\s*[.!]*$",
  "iu",
);
// ใช้ตรวจว่าโมเดลอ้าง alsoEnableAi ลอย ๆ หรือพี่ง้วงพูดถึงการเปิด AI จริง
const MENTIONS_ENABLE_AI = /เปิด\s*(?:ai|เอไอ|บอท|ลูกแพร)|คุยต่อ|\+\s*ai/iu;

function channelOf(word) {
  const value = String(word || "").toLowerCase();
  if (!value) return "";
  return new RegExp(`^(?:${LINE_WORDS})$`, "iu").test(value) ? "LINE" : "FB";
}

export function takeChannel(text) {
  const value = String(text || "").trim();
  const matched = CHANNEL_PREFIX.exec(value);
  if (!matched) return { channel: "", rest: value };
  return { channel: channelOf(matched[1] || matched[2] || matched[3]), rest: value.slice(matched[0].length).trim() };
}

export function takeEnableAiSuffix(text) {
  const value = String(text || "").trim();
  const matched = ENABLE_AI_SUFFIX.exec(value);
  if (!matched) return { text: value, alsoEnableAi: false };
  return { text: value.slice(0, matched.index).trim(), alsoEnableAi: true };
}

function nameOnly(text) {
  return String(text || "").replace(LEADING_FILLER, "").replace(TRAILING_PARTICLES, "").trim();
}

// ผล: { action, channel, target, form, alsoEnableAi? }
//   form "leading" = target คือ "ชื่อ + สิ่งที่ให้ทำ" ติดกัน → ให้ resolveLeadingName แยก
//   form "name"    = target คือชื่อล้วน → resolveCustomer
// action "unknown" = ไม่ใช่รูปแบบมาตรฐาน (ผู้เรียกค่อยส่งต่อให้ mini AI)
export function parseOwnerCommand(input) {
  const text = cleanInstruction(input, 800).replace(/\s+/gu, " ").trim();
  if (!text) return { action: "empty" };
  if (HELP.test(text)) return { action: "help" };
  let matched = YOLO.exec(text);
  if (matched) {
    const { channel, rest } = takeChannel(matched[1]);
    const { text: target, alsoEnableAi } = takeEnableAiSuffix(rest);
    return { action: "yolo", channel, target, form: "leading", alsoEnableAi };
  }
  for (const [pattern, action] of [[AI_ON, "ai_on"], [AI_OFF, "ai_off"], [STATUS, "status"]]) {
    matched = pattern.exec(text);
    if (!matched) continue;
    const { channel, rest } = takeChannel(matched[1]);
    return { action, channel, target: nameOnly(rest), form: "name" };
  }
  return { action: "unknown" };
}

/* ------------------------------- mini AI ------------------------------- */

// งานของโมเดลเล็ก: ถอดความเท่านั้น ห้ามเติมชื่อ ห้ามเดา — ตอบ JSON บรรทัดเดียว
export const MINI_AI_SYSTEM = [
  "You convert ONE chat command from a Thai business owner into strict JSON for an assistant named ลูกแพร.",
  "Reply with exactly one JSON object and nothing else:",
  '{"action":"yolo|ai_on|ai_off|status|help|unknown","channel":"LINE|FB|null","customerQuery":"","instruction":"","alsoEnableAi":false}',
  "- yolo = the owner wants ลูกแพร to send ONE message to a customer's chat right now (instruction = what to say or ask, in Thai; may be empty).",
  "- ai_on / ai_off = switch the AI on or off for one customer's chat. status = the owner asks how a customer's chat is going. help = asks how to use.",
  "- customerQuery = the customer name copied EXACTLY as the owner wrote it (keep Thai spelling; do not complete, translate or guess). Empty if no name.",
  "- channel = LINE or FB only if the owner said so, otherwise null.",
  "- alsoEnableAi = true only when the owner also asks to turn the AI on / let ลูกแพร continue the chat afterwards.",
  "- If the request is anything else or unclear, use action unknown. Never invent a customer.",
].join("\n");

function firstJsonObject(raw) {
  const text = String(raw || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const compactKey = (value) => nameKey(value).replace(/ /gu, "");

// ตรวจผลของโมเดลแบบไม่เชื่ออะไรเลย — คืน { ok, command } หรือ { ok:false, reason }
export function validateMiniAiCommand(rawText, ownerText) {
  const parsed = firstJsonObject(rawText);
  if (!parsed) return { ok: false, reason: "not_json" };
  const action = String(parsed.action || "").trim();
  if (action === "unknown") return { ok: false, reason: "model_unknown" };
  if (!OWNER_ACTIONS.includes(action)) return { ok: false, reason: "bad_action" };
  if (action === "help") return { ok: true, command: { action: "help" } };
  const rawChannel = String(parsed.channel ?? "").trim().toUpperCase();
  if (rawChannel && rawChannel !== "NULL" && rawChannel !== "LINE" && rawChannel !== "FB") return { ok: false, reason: "bad_channel" };
  const channel = rawChannel === "LINE" || rawChannel === "FB" ? rawChannel : "";
  const target = String(parsed.customerQuery ?? "").replace(/\s+/gu, " ").trim();
  if (!target || [...target].length > MAX_TARGET_CHARS) return { ok: false, reason: "bad_target" };
  const targetKey = compactKey(target);
  // ชื่อที่โมเดลคืนมาต้องอยู่ในข้อความของพี่ง้วงจริง — ไม่งั้นแปลว่าโมเดลแต่งชื่อขึ้นเอง
  if (targetKey.length < 2 || !compactKey(ownerText).includes(targetKey)) return { ok: false, reason: "target_not_in_text" };
  if (parsed.instruction != null && typeof parsed.instruction !== "string") return { ok: false, reason: "bad_instruction" };
  if (parsed.alsoEnableAi != null && typeof parsed.alsoEnableAi !== "boolean") return { ok: false, reason: "bad_flag" };
  const command = { action, channel, target, form: "name", viaModel: true };
  if (action === "yolo") {
    command.instruction = cleanInstruction(parsed.instruction || "", MAX_INSTRUCTION_CHARS);
    command.alsoEnableAi = parsed.alsoEnableAi === true && MENTIONS_ENABLE_AI.test(String(ownerText || ""));
  }
  return { ok: true, command };
}
