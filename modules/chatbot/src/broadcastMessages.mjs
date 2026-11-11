// broadcastMessages.mjs — ประกอบ "บับเบิล" ของบรอดแคสต์/ข้อความตามขั้นให้เป็น LINE message objects (28 ก.ย. 2026)
//
// พี่ง้วงขอ (28 ก.ย. 2026): "สำหรับ บรอดแคส ให้ทำ ระบบที่สร้างได้เหมือน LINE OA MANAGER เลย"
// ชนิดที่รองรับ (สูงสุด 5 บับเบิลต่อครั้ง = เพดานของ LINE ต่อคำขอ):
//   text    — ข้อความ ≤ 1,000 ตัวอักษร (ลิงก์ในข้อความถูกแปลงเป็นลิงก์นับคลิกได้ ถ้าเปิดไว้)
//   image   — รูปจากคลังที่ระบบรู้จักเท่านั้น (แคตตาล็อก/รูปที่อัปโหลด) ห้ามรับ URL อิสระจากฟอร์ม
//   sticker — เฉพาะชุดที่คัดไว้ใน BASIC_STICKERS (ชุดเดียวกับห้องแชท — ดูภาพจริงแล้วทุกตัว)
//   card    — การ์ด/การ์ดเลื่อน (Flex) รูป + หัวข้อ + ข้อความ + ปุ่ม (ลิงก์ https หรือให้ลูกค้าพิมพ์ข้อความตอบ)
// ทรงที่เก็บลงฐาน (stored) เป็น "สิ่งที่คนเขียน" (คีย์รูป ลิงก์เดิม) — ประกอบใหม่ได้เสมอตอนส่งจริง/ใช้เป็นแม่แบบ
// ยังไม่ทำ (เฟส 2): rich message/imagemap, วิดีโอ, คูปอง, A/B test
import { validBasicSticker } from "./messageMedia.mjs";

export const BROADCAST_MAX_BUBBLES = 5;
export const BROADCAST_TEXT_MAX = 1000;
export const LINE_TEXT_MAX = 5000;
export const CARD_MAX = 10; // LINE รับ carousel ได้ 12 ใบ — เผื่อขนาด 50 KB ของ Flex
export const CARD_TITLE_MAX = 40;
export const CARD_TEXT_MAX = 160;
export const CARD_BUTTON_MAX = 3;
export const CARD_LABEL_MAX = 20; // ปุ่มของ LINE ตัดข้อความยาว — 20 อ่านครบบนมือถือทุกรุ่น
export const CARD_MESSAGE_TEXT_MAX = 300;
export const ALT_TEXT_MAX = 400;
export const URL_MAX = 1000;

const BRAND_ROSE = "#D13868";
const INK = "#43333C";
const INK_2 = "#6A5461";

// ASCII เท่านั้น — ข้อความไทยที่ติดท้ายลิงก์โดยไม่เว้นวรรคต้องไม่ถูกกลืนเป็นส่วนหนึ่งของ URL
const URL_IN_TEXT_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gu;
const TRAILING_PUNCT_RE = /[)\]}>.,;:!?'"]+$/u;

/** URL ที่ปลอดภัยพอจะส่งให้ลูกค้าและเป็นปลายทาง redirect — คืน href ที่ normalize แล้ว หรือ "" */
export function safeLinkUrl(value, { httpsOnly = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > URL_MAX) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && (httpsOnly || parsed.protocol !== "http:")) return "";
  if (parsed.username || parsed.password || !parsed.hostname) return "";
  return parsed.href.length > URL_MAX ? "" : parsed.href;
}

/** ลิงก์ http(s) ในข้อความ — ตัดวรรคตอนท้ายออก (ลิงก์ที่จบด้วยจุดของประโยค) */
export function findUrls(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(URL_IN_TEXT_RE)) {
    const url = match[0].replace(TRAILING_PUNCT_RE, "");
    if (url.length > "https://".length) out.push({ url, index: match.index });
  }
  return out;
}

function cleanText(value, max) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? null : text;
}

function catalogImage(imageCatalogByKey, key, { forCard = false } = {}) {
  const entry = imageCatalogByKey.get(String(key || ""));
  if (!entry) return { error: `รูป "${key}" ไม่อยู่ในแคตตาล็อก` };
  if (entry.needsVerification === true) return { error: `รูป "${key}" ยังรอตรวจสอบ — ห้ามใช้ในบรอดแคสต์` };
  if (forCard && !/^https:\/\//u.test(String(entry.url || ""))) return { error: `รูป "${key}" ใช้ในการ์ดไม่ได้ (LINE ต้องการลิงก์ https)` };
  return { entry };
}

// ลิงก์ในข้อความ → ลิงก์นับคลิก (ถ้ามีตัวแปลง) · ตัวแปลงคืน URL ใหม่หรือ URL เดิม
function trackTextLinks(text, linkTracker, where) {
  if (typeof linkTracker !== "function") return text;
  let out = "";
  let cursor = 0;
  let order = 0;
  for (const { url, index } of findUrls(text)) {
    const target = safeLinkUrl(url);
    out += text.slice(cursor, index);
    out += target ? linkTracker({ url: target, label: "", ...where, link: order++ }) : url;
    cursor = index + url.length;
  }
  return out + text.slice(cursor);
}

function buildCardButton(raw, where, linkTracker) {
  const label = cleanText(raw?.label, CARD_LABEL_MAX);
  if (!label) return { error: `ปุ่มต้องมีชื่อ 1-${CARD_LABEL_MAX} ตัวอักษร` };
  if (raw?.kind === "message") {
    const text = cleanText(raw?.text, CARD_MESSAGE_TEXT_MAX);
    if (!text) return { error: `ปุ่มแบบ "ให้ลูกค้าพิมพ์ตอบ" ต้องมีข้อความ 1-${CARD_MESSAGE_TEXT_MAX} ตัวอักษร` };
    return {
      stored: { label, kind: "message", text },
      action: { type: "message", label, text },
    };
  }
  const uri = safeLinkUrl(raw?.uri, { httpsOnly: true });
  if (!uri) return { error: `ปุ่ม "${label}" ต้องมีลิงก์ https ที่ถูกต้อง` };
  const target = typeof linkTracker === "function" ? linkTracker({ url: uri, label, ...where }) : uri;
  return {
    stored: { label, kind: "uri", uri },
    action: { type: "uri", label, uri: target },
  };
}

function buildCard(raw, cardIndex, bubbleIndex, { imageCatalogByKey, linkTracker }) {
  const title = cleanText(raw?.title, CARD_TITLE_MAX);
  if (title === null) return { error: `หัวข้อการ์ดยาวเกิน ${CARD_TITLE_MAX} ตัวอักษร` };
  const text = cleanText(raw?.text, CARD_TEXT_MAX);
  if (text === null) return { error: `ข้อความในการ์ดยาวเกิน ${CARD_TEXT_MAX} ตัวอักษร` };
  const imageKey = String(raw?.imageKey || "").trim();
  let hero = null;
  if (imageKey) {
    const image = catalogImage(imageCatalogByKey, imageKey, { forCard: true });
    if (image.error) return image;
    hero = {
      type: "image", url: image.entry.url, size: "full", aspectRatio: "20:13", aspectMode: "cover",
    };
  }
  if (!title && !text && !hero) return { error: "การ์ดต้องมีรูป หัวข้อ หรือข้อความอย่างน้อยหนึ่งอย่าง" };
  const rawButtons = Array.isArray(raw?.buttons) ? raw.buttons : [];
  if (rawButtons.length > CARD_BUTTON_MAX) return { error: `การ์ดมีปุ่มได้ไม่เกิน ${CARD_BUTTON_MAX} ปุ่ม` };
  const buttons = [];
  const storedButtons = [];
  for (let i = 0; i < rawButtons.length; i += 1) {
    const built = buildCardButton(rawButtons[i], { bubble: bubbleIndex, card: cardIndex, button: i }, linkTracker);
    if (built.error) return built;
    storedButtons.push(built.stored);
    buttons.push({
      type: "button", height: "sm",
      style: i === 0 ? "primary" : "secondary",
      ...(i === 0 ? { color: BRAND_ROSE } : {}),
      action: built.action,
    });
  }
  const bodyContents = [];
  if (title) bodyContents.push({ type: "text", text: title, weight: "bold", size: "lg", wrap: true, color: INK });
  if (text) bodyContents.push({ type: "text", text, size: "sm", wrap: true, color: INK_2 });
  const bubble = { type: "bubble", size: "kilo" };
  if (hero) bubble.hero = hero;
  if (bodyContents.length) bubble.body = { type: "box", layout: "vertical", spacing: "sm", contents: bodyContents };
  if (buttons.length) bubble.footer = { type: "box", layout: "vertical", spacing: "sm", contents: buttons };
  return {
    bubble,
    stored: { imageKey: imageKey || "", title, text, buttons: storedButtons },
  };
}

function buildCardMessage(raw, bubbleIndex, options) {
  const cards = Array.isArray(raw?.cards) ? raw.cards : [];
  if (!cards.length) return { error: "บับเบิลการ์ดต้องมีอย่างน้อย 1 ใบ" };
  if (cards.length > CARD_MAX) return { error: `การ์ดเลื่อนมีได้ไม่เกิน ${CARD_MAX} ใบ` };
  const bubbles = [];
  const stored = [];
  for (let i = 0; i < cards.length; i += 1) {
    const built = buildCard(cards[i], i, bubbleIndex, options);
    if (built.error) return { error: cards.length > 1 ? `การ์ดใบที่ ${i + 1}: ${built.error}` : built.error };
    bubbles.push(built.bubble);
    stored.push(built.stored);
  }
  const typedAlt = cleanText(raw?.altText, ALT_TEXT_MAX);
  if (typedAlt === null) return { error: `ข้อความแจ้งเตือนของการ์ดยาวเกิน ${ALT_TEXT_MAX} ตัวอักษร` };
  const firstTitle = stored.find((card) => card.title)?.title || stored.find((card) => card.text)?.text || "ข้อความใหม่";
  const altText = typedAlt || `[การ์ด] ${firstTitle}`.slice(0, ALT_TEXT_MAX);
  return {
    message: {
      type: "flex", altText,
      contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles },
    },
    stored: { type: "card", altText: typedAlt, cards: stored },
  };
}

/**
 * validate ก้อนข้อความจาก console → { messages, stored } หรือ { error }
 * @param {Array} rawMessages ทรง stored (ดูหัวไฟล์)
 * @param {{ imageCatalogByKey?: Map, linkTracker?: Function|null }} options
 *   linkTracker({ url, label, bubble, card?, button?, link? }) → URL ที่จะใส่ในข้อความจริง
 */
export function buildBroadcastMessages(rawMessages, { imageCatalogByKey = new Map(), linkTracker = null } = {}) {
  if (!Array.isArray(rawMessages) || !rawMessages.length) {
    return { error: "ต้องมีข้อความอย่างน้อย 1 บับเบิล" };
  }
  if (rawMessages.length > BROADCAST_MAX_BUBBLES) {
    return { error: `ส่งได้สูงสุด ${BROADCAST_MAX_BUBBLES} บับเบิลต่อครั้ง (กติกา LINE)` };
  }
  const messages = [];
  const stored = []; // ทรงที่เก็บลง DB/ประวัติ (ไม่มี URL ยาว ๆ ซ้ำซ้อน)
  for (let index = 0; index < rawMessages.length; index += 1) {
    const raw = rawMessages[index];
    if (raw?.type === "text") {
      const text = typeof raw.text === "string" ? raw.text.trim() : "";
      if (!text) return { error: "บับเบิลข้อความห้ามว่าง" };
      if (text.length > BROADCAST_TEXT_MAX) {
        return { error: `ข้อความยาวเกิน ${BROADCAST_TEXT_MAX} ตัวอักษร` };
      }
      const sent = trackTextLinks(text, linkTracker, { bubble: index });
      if (sent.length > LINE_TEXT_MAX) return { error: "ข้อความหลังแปลงลิงก์ยาวเกินที่ LINE รับ" };
      messages.push({ type: "text", text: sent });
      stored.push({ type: "text", text });
    } else if (raw?.type === "image") {
      const image = catalogImage(imageCatalogByKey, raw.key);
      if (image.error) return image;
      messages.push({
        type: "image",
        originalContentUrl: image.entry.url,
        previewImageUrl: image.entry.previewUrl || image.entry.url,
      });
      stored.push({ type: "image", key: image.entry.key });
    } else if (raw?.type === "sticker") {
      const sticker = validBasicSticker(raw);
      if (!sticker) return { error: "สติกเกอร์นี้ไม่อยู่ในชุดที่ระบบอนุมัติ" };
      messages.push({ type: "sticker", packageId: sticker.packageId, stickerId: sticker.stickerId });
      stored.push({ type: "sticker", packageId: sticker.packageId, stickerId: sticker.stickerId });
    } else if (raw?.type === "card") {
      const built = buildCardMessage(raw, index, { imageCatalogByKey, linkTracker });
      if (built.error) return built;
      messages.push(built.message);
      stored.push(built.stored);
    } else {
      return { error: "ชนิดบับเบิลไม่รองรับ (ข้อความ/รูป/สติกเกอร์/การ์ดเท่านั้น)" };
    }
  }
  return { messages, stored };
}

/** ข้อความที่ลูกค้า "อ่านได้" ต่อหนึ่ง message object — ใช้ส่งเข้าตัวกันราคา/คำต้องห้ามทีละก้อน */
export function guardTextOf(message) {
  if (message?.type === "text") return String(message.text || "");
  if (message?.type !== "flex") return "";
  const texts = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === "text" || key === "label" || key === "altText") && typeof value === "string") texts.push(value);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(message);
  // การ์ดหนึ่งก้อนลูกค้าอ่านรวดเดียว — ตรวจรวมกัน ("ราคาพิเศษ" ในหัวข้อ + ตัวเลขในข้อความ = บริบทราคา)
  return texts.join("\n");
}

/**
 * แถวที่บันทึกลงประวัติแชทรายคน (ข้อความเชิงรุก) ต่อหนึ่งบับเบิลที่เก็บไว้ — ห้องแชทเห็นว่าส่งอะไรไปเมื่อไร
 * สติกเกอร์ใช้ทรงเดียวกับที่ห้องแชทเก็บเอง (msgType sticker + metadata) หน้าแชทจึงวาดเป็นสติกเกอร์ได้เลย
 */
export function storedMessageLogRow(message, suffix = "(broadcast)") {
  if (message?.type === "text") return { msgType: "text", content: String(message.text || ""), metadata: {} };
  if (message?.type === "image") return { msgType: "image", content: `[image:${message.key}] ${suffix}`, metadata: {} };
  if (message?.type === "sticker") {
    return {
      msgType: "sticker", content: "[sticker]",
      metadata: { packageId: String(message.packageId || ""), stickerId: String(message.stickerId || "") },
    };
  }
  if (message?.type === "card") {
    const cards = Array.isArray(message.cards) ? message.cards : [];
    const head = cards[0]?.title || cards[0]?.text || "";
    return { msgType: "text", content: `[การ์ด ${cards.length} ใบ] ${head} ${suffix}`.replace(/\s+/gu, " ").trim(), metadata: {} };
  }
  return { msgType: "text", content: `[${String(message?.type || "unknown")}] ${suffix}`, metadata: {} };
}
