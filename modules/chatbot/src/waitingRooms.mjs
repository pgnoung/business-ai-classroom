// waitingRooms.mjs — นิยาม "รอตอบ" ชุดเดียวของทั้งคอนโซล (28 ก.ย. 2026)
//
// พี่ง้วงเห็น "ลูกค้ารอคนตอบตอนนี้ 52 ห้อง · นานสุด 29 วัน" แล้วบอกว่าบางห้องจบไปแล้ว บางห้องเป็นกลุ่มที่
// ไม่อยากตอบแล้ว และขอให้ "tab รอตอบ กับหน้านี้เหมือนกัน จะได้คุยง่าย ๆ" — รายการบนหน้าภาพรวม ชิป
// "รอตอบ"/"ค้าง >24 ชม." ในหน้าแชท และ (ภายหลัง) สรุปทาง Telegram จึงต้องมาจากฟังก์ชันเดียวในไฟล์นี้
// ตัวเลขและลำดับจะได้ตรงกันทุกที่ ไม่ใช่สามที่นับสามแบบ
//
// รอตอบ = ครบทุกข้อ
//   1) ลูกค้าพิมพ์มาใน 30 วันล่าสุด และข้อความล่าสุดเกิน 3 นาทีแล้ว (ลูกแพรตอบในไม่กี่วินาที)
//   2) หลังข้อความนั้นยังไม่มีคำตอบแบบ reactive จากใครเลย (ข้อความทักตาม/บรอดแคสไม่นับว่าตอบ)
//   3) ไม่ใช่สแปม (ป้าย null) · ไม่ใช่สำเนาห้องระบบเก่าที่โยงแล้ว · ไม่ใช่ canary
//   4) ไม่ได้กด "✓ เสร็จสิ้น" หลังข้อความล่าสุดของลูกค้า (ทักกลับมาหลังปิดเคส = รอตอบอีกครั้ง)
//   5) ในข้อความที่ยังไม่มีคนตอบ มีอย่างน้อยหนึ่งข้อความที่ "มีเรื่อง" — สติกเกอร์ อีโมจิล้วน
//      (รวม LINE emoji อย่าง "(thumbs up)(hands together)") ขอบคุณ/โอเคสั้น ๆ แฮชแท็ก และปุ่มไลก์ของ
//      Messenger ไม่ใช่เรื่องที่ต้องตอบ
// ห้องที่ AI ปิดยังนับ (คนจริงติดค้างคำตอบอยู่) แต่ทุกห้องบอกว่า AI ปิดเพราะใคร (aiOffActor.mjs)
//   ยกเว้นห้องสีเหลือง "AI off (not qualify)" ที่ "เหลืองนิ่ง" (5 ต.ค. 2026 พี่ง้วง) — ตัวกวาดคัดกรองตั้งใจไม่ตามต่อ
//   จึงไม่ใช่งานค้างของทีม (ตัดที่ SQL ของ dbAttention.attentionWaitingCandidates · quietYellowSql)
//   รีวิวปรปักษ์ 5 ต.ค. #20: ตัดเฉพาะ state AI_ACTIVE + หมุด qualify_hold ≥ ข้อความลูกค้าล่าสุด — ห้องเหลืองที่รอคน
//   (NEEDS_HUMAN) ปิดเคสแล้วทักกลับ หรือมีข้อความใหม่ที่ตัวกวาดยังไม่ยืนยัน ยังขึ้นรอตอบตามปกติ
// เรียง: เรื่องเงิน > ร้อน > อุ่น > อื่น ๆ แล้วรอนานสุดก่อน · "รอ" นับจากข้อความล่าสุดของลูกค้า
import { customerCareMode } from "./customerCare.mjs";
import { isAckOnly } from "./scheduleCheck.mjs";
import { isNoiseInbound } from "./needsHumanSla.mjs";
import { FB_STICKER_CDN_PATH } from "./facebookWebhook.mjs";
import { RECENT_WINDOW_MS } from "./lineOaContext.mjs";
import { aiOffInfo, notQualifiedTeamBlocked } from "./aiOffActor.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const WAITING_WINDOW_MS = RECENT_WINDOW_MS;
// ลูกแพรตอบในไม่กี่วินาที — ข้อความที่เพิ่งเข้ามาไม่ถึง 3 นาทียังไม่ใช่ "ไม่มีใครตอบ"
export const WAITING_GRACE_MS = 3 * MIN;
// ชิป "ค้าง >24 ชม." — เกินวันแล้วยังไม่มีใครตอบ
export const WAITING_LONG_MS = DAY;
// คอนโซลส่ง Facebook แบบ messaging_type RESPONSE ได้ภายใน 24 ชม. หลังข้อความล่าสุดของลูกค้าเท่านั้น
// เกินนั้นต้องให้คนตอบใน Meta Business Suite (ได้ถึง 7 วัน) — ป้ายนี้บอกทีมก่อนกดส่งแล้วล้ม
export const FB_REPLY_WINDOW_MS = DAY;
export const ATTENTION_PREVIEW_CHARS = 40;

const NON_TEXT_PREVIEW = Object.freeze({
  image: "ส่งรูปภาพ", sticker: "ส่งสติกเกอร์", video: "ส่งวิดีโอ", audio: "ส่งข้อความเสียง",
  file: "ส่งไฟล์", location: "ส่งตำแหน่งที่ตั้ง",
});
const graphemes = typeof Intl?.Segmenter === "function"
  ? (text) => Array.from(new Intl.Segmenter("th", { granularity: "grapheme" }).segment(text), (part) => part.segment)
  : (text) => Array.from(text);

/** ข้อความสั้นหนึ่งบรรทัดของข้อความลูกค้า — ≤40 ตัวอักษรรวม … (นับตัวที่มองเห็น ไม่ตัดกลางสระ/วรรณยุกต์) */
export function attentionPreview(type, text, max = ATTENTION_PREVIEW_CHARS) {
  const kind = String(type || "text");
  if (kind !== "text" && NON_TEXT_PREVIEW[kind]) return NON_TEXT_PREVIEW[kind];
  const clean = String(text || "").replace(/^\[[^\]]{1,40}\]\s*/u, "").replace(/\s+/gu, " ").trim();
  if (!clean) return NON_TEXT_PREVIEW[kind] || "";
  const parts = graphemes(clean);
  return parts.length > max ? `${parts.slice(0, max - 1).join("")}…` : clean;
}

/** มูลค่าทางธุรกิจของห้อง: money > hot > warm > other */
export function attentionValue(row = {}) {
  if (Number(row.money_seen_at) > 0 || row.ai_off_reason === "bank_sent" || row.deal_status === "awaiting_payment") return "money";
  const score = Number(row.last_score);
  if (row.last_score != null && Number.isInteger(score) && score >= 8) return "hot";
  if (row.last_score != null && Number.isInteger(score) && score >= 5) return "warm";
  return "other";
}
const VALUE_RANK = Object.freeze({ money: 0, hot: 1, warm: 2, other: 3 });

// LINE ส่ง LINE emoji มาเป็นชื่ออังกฤษในวงเล็บ เช่น "(thumbs up)(hands together)" พร้อมตำแหน่งใน metadata
// ตัดตามตำแหน่งก่อน (แม่นที่สุด) แล้วค่อยตัดรูปชื่อในวงเล็บสำหรับข้อความเก่าที่ยังไม่ได้เก็บตำแหน่ง
// (ชื่อ emoji เป็นอังกฤษตัวเล็กล้วน — "(Stage 4)" หรือวงเล็บภาษาไทยไม่โดนตัด)
const LINE_EMOJI_NAME = /\((?:[a-z]+(?: [a-z]+){0,4})\)/gu;
export function stripLineEmoji(text, emojis = null) {
  const value = String(text ?? "");
  const ranges = (Array.isArray(emojis) ? emojis : [])
    .map((emoji) => [Number(emoji?.index), Number(emoji?.length)])
    .filter(([index, length]) => Number.isInteger(index) && Number.isInteger(length) && index >= 0 && length > 0 && index + length <= value.length)
    .sort((a, b) => a[0] - b[0]);
  let out = "";
  let cursor = 0;
  for (const [index, length] of ranges) {
    if (index < cursor) continue;
    out += value.slice(cursor, index);
    cursor = index + length;
  }
  out += value.slice(cursor);
  return out.replace(LINE_EMOJI_NAME, " ");
}

function isMessengerStickerUrl(url) {
  const raw = String(url || "");
  if (!raw) return false;
  try {
    return FB_STICKER_CDN_PATH.test(new URL(raw).pathname);
  } catch {
    return FB_STICKER_CDN_PATH.test(raw.split("?")[0]);
  }
}

// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): คำรับสุภาพที่ตัวจับเดิมไม่รู้จัก ("ครับผม" · "ยินดีค่ะ" · "สาธุ" · "เช่นกันค่ะ" · "ขอบคุณลูกแพรค่ะ")
// เคยค้างในรายการรอคนตอบ — เครื่องตอบ v3 เงียบได้เฉพาะคำที่ตัวนี้นับว่าไม่ต้องตอบ (ชุดเดียวกัน) · ทั้งข้อความต้องเป็นคำพวกนี้ล้วน
const POLITE_ACK = new RegExp(`^(?:(?:${[
  "ค่[ะา]+", "คะ", "คร[ัา]+บ(?:ผม)?", "คับ", "จ้[าะ]+", "ยินดี(?:ค่ะ|ครับ)?", "เช่นกัน", "สาธุ", "รับทราบ",
  "ขอบ(?:พระ)?คุณ(?:มาก)?", "นะ", "(?:น้อง|คุณ|พี่)?(?:ลูกแพร|แอดมิน)", "ทีมงาน",
].join("|")})\\s*)+$`, "u");
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิวสอง): ชื่อ/คำเรียกล้วน ๆ ("แอดมินคะ" · "ลูกแพรคะ" · "ทีมงานครับ") คือเรียกหาคน ไม่ใช่คำรับ
// — นับเป็นคำรับได้เฉพาะตอนมีคำขอบคุณ/รับทราบอยู่ด้วย ("ขอบคุณลูกแพรค่ะ") ไม่งั้นห้องต้องขึ้นในรายการรอคนตอบ
const ADDRESS_CALL = /ลูกแพร|แอดมิน|ทีมงาน/u;
const ACK_CONTENT = /ขอบ(?:พระ)?คุณ|ยินดี|เช่นกัน|สาธุ|รับทราบ/u;
const politeAck = (text) => POLITE_ACK.test(text) && (!ADDRESS_CALL.test(text) || ACK_CONTENT.test(text));

/**
 * ข้อความขาเข้าชิ้นนี้ "ไม่มีเรื่องให้ตอบ" ไหม — ใช้ตัวจับที่ระบบมีอยู่แล้วทั้งหมด (ไม่เขียน regex ภาษาไทยใหม่):
 * customerCare THANKS_ONLY · scheduleCheck.isAckOnly (รับทราบ + อีโมจิที่พบบ่อย) · needsHumanSla.isNoiseInbound
 * (สติกเกอร์/แฮชแท็ก/สัญลักษณ์ล้วน/คำรับสั้น) · รูปจาก CDN สติกเกอร์ของ Messenger (ปุ่มไลก์ก่อน 5 ก.ย.)
 * @param {{ type?: string, text?: string, emojis?: Array|null, url?: string|null }} message
 */
export function isAckOnlyInbound({ type = "text", text = "", emojis = null, url = "" } = {}) {
  const kind = String(type || "text");
  if (kind === "sticker") return true;
  if (kind === "image") return isMessengerStickerUrl(url);
  if (kind !== "text") return false; // ไฟล์ เสียง วิดีโอ ตำแหน่ง = มีของให้คนเปิดดู
  const raw = String(text ?? "").trim();
  if (raw.startsWith("#")) return true; // คีย์เวิร์ดกิจกรรม LINE OA ตอบเอง (กติกาเดียวกับ SQL)
  // ตัวเชื่อมอีโมจิ (ZWJ + variation selector) ไม่ใช่ตัวอักษร — หัวใจสีแดงหรืออีโมจิคนโค้งต้องเหลือแต่สัญลักษณ์
  const rest = stripLineEmoji(raw, emojis).replace(/[\u200d\ufe0e\ufe0f]/gu, "").trim();
  if (!rest) return true;
  // มีเครื่องหมายคำถาม = อาจเป็นคำถาม ("ok?") — ตัวจับของบันไดทวงตัดเครื่องหมายทิ้งก่อนเทียบ ที่นี่ต้องไม่ซ่อนคำถาม
  if (/[?\uff1f]/u.test(rest)) return false;
  return customerCareMode(rest) === "close" || isAckOnly(rest) || isNoiseInbound({ type: "text", text: rest })
    || politeAck(rest.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}]/gu, " ").trim());
}

/**
 * ห้องนี้ยังรอตอบจริงไหม (ข้อ 5 ของนิยาม) + ข้อความที่ควรโชว์เป็นตัวอย่าง
 * แถวไม่มี unanswered_json (ผู้เรียกเดิม) = เชื่อ SQL เหมือนพฤติกรรมเดิม
 * ข้อความที่ยังไม่มีคนตอบมีมากกว่าที่อ่านมา = ถือว่ามีเรื่อง (ไม่ซ่อนลูกค้าเพราะอ่านไม่ครบ)
 */
export function waitingSignal(row = {}) {
  const fallback = { type: row.last_in_type, text: row.last_in_text };
  if (row.unanswered_json == null) return { waiting: true, preview: fallback };
  let items = null;
  try {
    items = JSON.parse(String(row.unanswered_json));
  } catch {
    return { waiting: true, preview: fallback };
  }
  if (!Array.isArray(items) || !items.length) return { waiting: true, preview: fallback };
  const substantive = items.find((item) => !isAckOnlyInbound(item || {}));
  if (substantive) return { waiting: true, preview: { type: substantive.type, text: substantive.text } };
  const count = Number(row.unanswered_count) || items.length;
  return { waiting: count > items.length, preview: fallback };
}

function channelName(channelLabel, id) {
  const label = String(channelLabel(id) || id);
  if (label === "default") return "LINE";
  if (label === "facebook") return "Facebook";
  return label;
}

function roomBase(row, channelLabel, preview = { type: row.last_in_type, text: row.last_in_text }) {
  const id = String(row.line_user_id || "");
  const score = row.last_score == null ? null : Number(row.last_score);
  return {
    id,
    name: String(row.known_name || row.display_name || `ลูกค้า …${id.slice(-4)}`),
    pictureUrl: /^https:\/\//u.test(String(row.picture_url || "")) ? String(row.picture_url) : "",
    channelId: String(row.channel_id || "default"),
    // โหมด OA เดียวไม่มีชื่อสาขา (ได้ "default" กลับมา) — คนอ่านต้องเห็นชื่อช่องทาง ไม่ใช่รหัส
    channelName: channelName(channelLabel, String(row.channel_id || "default")),
    score: Number.isInteger(score) ? score : null,
    value: attentionValue(row),
    aiOn: Number(row.ai_enabled) === 1,
    owner: String(row.human_owner || ""),
    preview: attentionPreview(preview.type, preview.text),
  };
}
export { roomBase as attentionRoomBase };

/**
 * จัดอันดับห้องรอตอบจากผู้สมัคร (db.attentionWaitingCandidates) — บริสุทธิ์ ทดสอบได้โดยไม่ต้องมี DB
 * limit = จำนวนห้องที่ส่งรายละเอียดกลับ (ยอดรวม/ค้างเกินวัน/รอนานสุด นับจากทุกห้องเสมอ)
 * teamBlockedOf(row) = ห้องเหลืองที่มีแต่ทีมปลดได้ไหม (รีวิวปรปักษ์รอบ 3 5 ต.ค. — ผู้เรียกที่มี DB ส่ง notQualifiedTeamBlocked)
 */
export function summarizeWaiting(rows = [], { now = Date.now(), limit = 8, channelLabel = (id) => id, teamBlockedOf = () => false } = {}) {
  const ranked = rows
    .map((row) => ({ row, since: Number(row.last_in_at) || 0, signal: waitingSignal(row) }))
    .filter((item) => item.since > 0 && item.signal.waiting)
    .sort((a, b) => (VALUE_RANK[attentionValue(a.row)] - VALUE_RANK[attentionValue(b.row)]) || (a.since - b.since));
  const oldest = ranked.reduce((min, item) => Math.min(min, item.since), Number.POSITIVE_INFINITY);
  const cap = Number.isFinite(Number(limit)) ? Math.max(0, Math.trunc(Number(limit))) : ranked.length;
  return {
    total: ranked.length,
    over24: ranked.filter((item) => now - item.since >= WAITING_LONG_MS).length,
    oldestWaitMs: ranked.length ? Math.max(0, now - oldest) : 0,
    rooms: ranked.slice(0, cap).map(({ row, since, signal }) => {
      const waitMs = Math.max(0, now - since);
      return {
        ...roomBase(row, channelLabel, signal.preview),
        since,
        waitMs,
        over24: waitMs >= WAITING_LONG_MS,
        fbReplyClosed: String(row.channel_id || "") === "facebook" && waitMs >= FB_REPLY_WINDOW_MS,
        aiOff: aiOffInfo(row, { teamBlocked: teamBlockedOf(row) === true }),
        aiPaused: Number(row.ai_enabled) === 1 && Number(row.operator_active_until || 0) > now,
      };
    }),
  };
}

/** ห้องรอตอบทั้งหมด (เรียงแล้ว) — ตัวเดียวที่หน้าภาพรวม ชิปหน้าแชท และช่องทางอื่นต้องเรียก */
export function listWaitingRooms({ db, now = Date.now(), channel = null, channelLabel = (id) => id, limit = Number.POSITIVE_INFINITY } = {}) {
  const rows = db.attentionWaitingCandidates({
    channel, sinceMs: now - WAITING_WINDOW_MS, beforeMs: now - WAITING_GRACE_MS,
  });
  return summarizeWaiting(rows, { now, limit, channelLabel, teamBlockedOf: (row) => notQualifiedTeamBlocked(db, row) });
}

/** ห้องเดียว: รอตอบไหม (null = ไม่รอ) — หัวห้องแชทใช้บอกลำดับ/เวลารอด้วยนิยามเดียวกัน */
export function waitingRoomFor({ db, customerId, now = Date.now(), channelLabel = (id) => id } = {}) {
  if (!customerId) return null;
  const rows = db.attentionWaitingCandidates({
    customerId, sinceMs: now - WAITING_WINDOW_MS, beforeMs: now - WAITING_GRACE_MS, limit: 1,
  });
  return summarizeWaiting(rows, { now, limit: 1, channelLabel, teamBlockedOf: (row) => notQualifiedTeamBlocked(db, row) }).rooms[0] ?? null;
}
