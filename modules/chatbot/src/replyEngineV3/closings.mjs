// closings.mjs — ข้อเสนอ/คำถามปิดท้ายที่ลูกแพรใช้ไปแล้ว + ตัวแบ่งประโยคที่ทนอีโมจิ (โมดูลปลายทาง ไม่ import ไฟล์อื่นของ v3)
// เคสจริง 5 ต.ค. (ห้อง Facebook): หลังแจ้งราคา ลูกค้าถามเรื่องรายได้ กังวลเนื้อหาเยอะ และบอกว่าต้องยืมเงินมาเรียน
// แต่ลูกแพรปิดทุกข้อความด้วย "อยากให้ลูกแพรส่งรอบเรียนที่เปิดอยู่ให้ดูไหมคะ?" ซ้ำสี่ครั้ง ทั้งที่ลูกค้าไม่เคยตอบรับเลย
// ไฟล์นี้จำว่าสองเทิร์นล่าสุดลูกแพรปิดด้วยอะไร (turnFacts) ให้ตัวเลือกปิดท้าย (stageTasks) และด่านหลังร่าง (postCheck) ใช้ชุดเดียวกัน
import { isClosingQuestion } from "../handoffClosing.mjs";

export const ADMIN_PREFIX = "[แอดมินทีมงานพิมพ์เอง]";
export const EMOJI_CHARS = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu;
// ตัดประโยคหลังคำลงท้าย แม้มีอีโมจิติด ("…ได้นะคะ😊 ส่วนในคลาส…")
const SENTENCE_SPLIT = /(?<=(?:ค่ะ|คะ|ครับ|นะ|[?？!])[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]*)\s+/u;
export const OFFER_ASK_RE = /ให้ไหม|ไหมคะ|มั้ยคะ|ไหมครับ/u;
// ประโยคข้อเสนอของลูกแพรเอง ("อยากให้ลูกแพรสรุป…ให้ดูไหมคะ?" / "ลูกแพรช่วยร่าง…ได้นะคะ") — held-out 5 ต.ค.:
// ลูกค้าตอบรับข้อเสนอที่อยู่กลางก้อน หรือข้อเสนอที่ไม่มีเครื่องหมายคำถาม แล้วโดนถามซ้ำว่าอยากให้ช่วยอะไร (sep-005, sep-029)
// แชทจริง 13 ต.ค.: "ขออนุญาตส่งหัวข้อที่สอนในคลาสให้ดู…ไหมคะ?" (ไม่มีคำว่าลูกแพร) ไม่ถูกนับเป็นข้อเสนอ → "ครับ" ได้คำปลอบใจแทนหัวข้อ
export const OFFER_ACTOR = /ให้ลูกแพร|ลูกแพร(?:ขอ|สามารถ)?(?:ช่วย)?(?:ส่ง|สรุป|ร่าง|ทำ|ยกตัวอย่าง|ออกแบบ|แนะนำ|เตรียม)|ลูกแพรช่วย|ขออนุญาต(?:ส่ง|สรุป|แนะนำ)|(?:อยาก|ต้องการ)(?:ดู(?!แล)|ได้)|สนใจ(?:ดู|รับ|ให้ลูกแพร)/u;
// แชทจริง 13 ต.ค.: "ลูกแพรขอส่งหัวข้อ…ได้บ้างนะคะ?" — ข้อเสนอที่ปิดด้วย "นะคะ?" นับเป็นคำปิดข้อเสนอ
export const OFFER_CLOSE = /(?:ไหม|มั้ย)(?:คะ|ครับ)?\s*[?？]?|ได้(?:เลย)?นะ(?:คะ)?|ให้(?:ได้|ดู)(?:เลย)?(?:นะ)?(?:คะ|ค่ะ)|นะ(?:คะ|ครับ)\s*[?？]/u;
const URLISH = /https?:\/\/\S+|www\.\S+/giu;

export const sentencesOf = (text) => String(text).split("\n")
  .flatMap((line) => line.trim().split(SENTENCE_SPLIT)).map((part) => part.trim()).filter(Boolean);
export const askLike = (sentence) => /[?？]/u.test(sentence) || OFFER_CLOSE.test(sentence) || OFFER_ASK_RE.test(sentence) || isClosingQuestion(sentence);

// ชนิดของข้อเสนอ — "ซ้ำ" = ชนิดเดียวกัน แม้ถ้อยคำต่างกัน ("อยากให้ส่งรอบเรียนไว้ดูไหม" กับ "สะดวกรอบไหนดีคะ" คือเรื่องรอบทั้งคู่)
export const CLOSING_TYPES = Object.freeze([
  ["rounds", /รอบ(?!คอบ)|ตารางเรียน|วันเรียน|วันไหน|เปิดเรียน/u],
  ["booking", /จอง|สมัคร|ลงทะเบียน|ที่นั่ง|ล็อก/u],
  ["price", /ราคา|ค่าเรียน|โปรโมชั่น|ส่วนลด|early ?bird/iu],
  ["outline", /หัวข้อ|เนื้อหา|outline|รายละเอียด(?:ของ)?คลาส|สอนอะไร/iu],
  // 8 พ.ย. 2026: ข้อเสนอส่งหัวข้อที่เอ่ยงานของลูกค้า ("…ตรงกับขั้นตอนทำคลิป ไม่ทราบว่าสนใจให้ลูกแพรส่งไปให้ไหมคะ") เคยนับเป็นข้อเสนอรีวิว
  // แล้วลูกค้าตอบรับได้คำปลอบใจแทนหัวข้อ — "คลิป" นับเฉพาะคลิปของคลาส/ผู้เรียน หรือคำว่าส่ง/ดูคลิป
  ["review", /รีวิว|ตัวอย่างงาน|คลิป(?:รีวิว|บรรยากาศ|ตัวอย่าง|ผู้เรียน|จากคลาส|ในคลาส)|(?:ส่ง|ดู)คลิป/u],
]);
// ข้อเสนอขายที่ห้ามใช้ในเทิร์นที่ลูกค้าเล่าว่าเงินตึง/ต้องยืมเงิน (เคสจริง 5 ต.ค.: "ไม่อยากให้ฝืนงบ" แล้วยังชวนดูรอบ)
export const SALES_TYPES = Object.freeze(new Set(["rounds", "booking", "price"]));
export const TYPE_LABEL = Object.freeze({
  rounds: "ส่งรอบเรียน/ชวนเลือกรอบ", booking: "ชวนจองหรือสมัคร", price: "เรื่องราคาหรือโปรโมชั่น",
  outline: "ส่งหัวข้อที่สอน", review: "ส่งรีวิวหรือตัวอย่างงาน",
});

export function closingTypes(sentence = "") {
  const text = String(sentence).replace(URLISH, " ");
  return CLOSING_TYPES.filter(([, test]) => test.test(text)).map(([type]) => type);
}

// ประโยค "ข้อเสนอ/ชวน" ของลูกแพรจริง ๆ (ส่ง…ให้ดู · ชวนเลือกรอบ · ชวนจอง) — ตรวจซ้ำเคสจริง 5 ต.ค. ผ่านไปป์ไลน์จริง:
// คำถามสำรวจที่บังเอิญมีคำว่า คลิป/ราคา/เนื้อหา ("…ทำภาพ หรือทำคลิปคะ?") ถูกนับเป็นข้อเสนอรีวิว และประโยคบอกเล่าที่ลงท้าย
// "ได้เลยนะคะ" ("วันเรียนจริงจะได้ลงมือทำทีละขั้นกับทีม TA ได้เลยนะคะ") ถูกตัดทิ้งเพราะมีคำว่า วันเรียน — ชนิดข้อเสนอนับเฉพาะประโยคแบบนี้
const OFFER_FORM = new RegExp([
  OFFER_ACTOR.source, "สะดวก(?:มา)?(?:เรียน)?(?:รอบ|วัน)", "เลือกรอบ", "รอบไหน",
  "(?:จอง|สมัคร|ลงทะเบียน)(?:ที่นั่ง|เรียน|รอบ|ไว้|เลย|ก่อน|ได้|ไหม|มั้ย)", "ส่ง\\S{0,30}?ให้", "ให้ดู",
].join("|"), "u");
export const isOfferForm = (sentence = "") => OFFER_FORM.test(String(sentence).replace(URLISH, " "));
/** ชนิดข้อเสนอของประโยค — ประโยคที่ไม่ใช่รูปข้อเสนอ = [] (คำถามสำรวจ/ประโยคบอกเล่าไม่ทำให้ห้ามเสนอเรื่องนั้น) */
export const offerTypes = (sentence = "") => (isOfferForm(sentence) ? closingTypes(sentence) : []);

// เงินตึง: ข้อเสนอขาย = รูปข้อเสนอ หรือคำเร่งซื้อ (ผ่อน/แบ่งจ่าย/โปรโมชั่น/ส่วนลด) · ประโยคใส่ใจ ("ไม่ต้องรีบตัดสินใจเรื่องค่าเรียน…") ไม่นับ
const SALES_PUSH = /ผ่อน|แบ่งจ่าย|โปรโมชั่น|โปรโมชัน|ส่วนลด|early ?bird|ราคาพิเศษ|ที่นั่งใกล้เต็ม|ที่นั่งเหลือ|รีบ(?:จอง|สมัคร)/iu;
// feedback ทีม 10 ต.ค.: ประโยคชวนเตรียมงาน/Laptop มาใช้ใน Workshop ถูกพูดซ้ำทุกเทิร์นในห้องเดียว (สูงสุด 5 ครั้ง) — บอกครั้งเดียวพอ
// (คำปฏิเสธ "ไม่ต้องเตรียม…" และทีมงานนำตัวอย่างมาให้ดู ไม่นับ — ต้องเป็นลูกค้าเตรียม/นำของมาใช้หรือฝึกเอง)
const NOT_NEEDED = "(?<!ไม่(?:ต้อง|จำเป็น(?:ต้อง)?)\\s?)";
export const WORKSHOP_PREP_RE = new RegExp(`${NOT_NEEDED}(?:เตรียม|นำ|เอา|พก)[^\\n]{0,80}?มา(?:ใช้|ฝึก|ทำ|ลอง)[^\\n]{0,60}?(?:workshop|เวิร์ก?ช็อป|ในคลาส)`
  + `|${NOT_NEEDED}(?:เตรียม|นำ|เอา|พก)\\s?(?:laptop|แล็ปท็อป|โน้ตบุ๊ก|คอมพิวเตอร์)`, "iu");
// ลูกค้าถามเองว่าต้องเตรียม/เอาอะไรมา = ตอบได้ตามปกติ (ด่านตัดประโยคซ้ำไม่แตะ)
export const PREP_ASK_RE = /เตรียม|ต้อง(?:เอา|นำ|มี|ใช้|ซื้อ)|เอา\S{0,12}มา|อุปกรณ์|laptop|แล็ปท็อป|โน้ตบุ๊ก|คอม|ยืม|ไอแพด|ipad|แท็บเล็ต|tablet|โปรแกรม|chat\s*-?gpt|plus|ค่าใช้จ่าย/iu;
export const CARE_LINE = /ไม่ต้องรีบ|ไม่(?:อยากให้)?ฝืน|ไม่เร่ง|ค่อย ?ๆ/u;
/**
 * ประโยคนี้เป็นการชวนซื้อในเทิร์นเงินตึงไหม
 * allowed = ชนิดที่ลูกค้าขอเองเทิร์นนี้ (บอกจะสมัคร/ถามรอบ) → ไม่ตัด
 * paymentAsk = ลูกค้าถามวิธีจ่ายเอง → คำตอบเรื่องผ่อน/บัตร/ค่าเรียนไม่ใช่การเร่งขาย ตัดได้เฉพาะคำชวนเลือกรอบ/จอง
 * (รีวิวเคสจริง 5 ต.ค.: "ถ้าต้องยืมเงินมาเรียน ขอผ่อนได้ไหม" ถูกตัดคำตอบเรื่องผ่อนทิ้ง เหลือเศษ "สูงสุด 10 เดือน…")
 */
export function hardshipSalesOffer(sentence = "", { allowed = new Set(), paymentAsk = false } = {}) {
  if (CARE_LINE.test(sentence)) return false;
  const types = closingTypes(sentence).filter((type) => SALES_TYPES.has(type) && !allowed.has(type));
  if (!types.length) return false;
  if (paymentAsk) return isOfferForm(sentence) && types.some((type) => type !== "price");
  return isOfferForm(sentence) || SALES_PUSH.test(sentence);
}

// เทียบแบบไม่สนคำลงท้าย อีโมจิ เครื่องหมาย และช่องว่าง ("…ไหมคะ?" = "…มั้ยคะ 😊")
const PARTICLES = /นะคะ|นะครับ|ค่ะ|คะ|ครับ|คับ|จ้า|จ้ะ|ค่า|ไหม|มั้ย|มั๊ย|นะ/gu;
// พี่ง้วง 13 ต.ค.: รูปถ่อมตัว "ไม่ทราบว่าคุณ… สนใจให้ลูกแพรส่ง…ไหมคะ ลูกแพรส่งให้ค่ะ" = คำถามเดียวกับ "อยากให้ลูกแพรส่ง…ไหมคะ?"
// ตัดหัว/หางสุภาพก่อนเทียบ ไม่งั้นตัวกันถามซ้ำมองไม่เห็นว่าเป็นคำถามเดิม
const POLITE_HEAD = /ไม่ทราบว่า\s*(?:คุณ\s?(?:\(ชื่อ(?:ที่ใช้เรียก)?\)|[^\s]{1,30}?)\s+)?/gu;
const POLITE_TAIL = /(?:เลือกแล้ว)?ลูกแพรส่ง(?:รายละเอียดการสมัคร)?ให้ค่ะ$/u;
const canonicalAsk = (text) => String(text).trimEnd().replace(POLITE_TAIL, "").replace(POLITE_HEAD, "")
  .replace(/สนใจ(?=ให้ลูกแพร|ดู|เห็น|ได้)/gu, "อยาก").replace(/ดีนะคะ/gu, "ดีคะ");
export function normalizeClosing(text = "") {
  return canonicalAsk(text).replace(URLISH, "").replace(EMOJI_CHARS, "").replace(/[\p{P}\p{S}\s]/gu, "")
    .replace(PARTICLES, "").toLowerCase();
}

function bigrams(chars) {
  const out = new Map();
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const key = `${chars[i]}${chars[i + 1]}`;
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

export const SIMILAR_CLOSING = 0.8;
const CONTAINED_MIN = 12;

/** ความเหมือนของประโยคปิดท้ายสองประโยค (0–1): Dice ของคู่ตัวอักษร · ประโยคหนึ่งอยู่ในอีกประโยคทั้งก้อน = 1 */
// containment = false: ไม่นับว่าเหมือนเพราะประโยคสั้นอยู่ในประโยคยาว (ตัวตัดบับเบิลทวนซ้ำใช้ — ย่อหน้าที่มีบับเบิลเดิม + คำตอบใหม่ต้องไม่ถูกนับว่าซ้ำ)
export function closingSimilarity(a = "", b = "", { containment = true } = {}) {
  const x = [...normalizeClosing(a)];
  const y = [...normalizeClosing(b)];
  if (!x.length || !y.length) return 0;
  const [short, long] = x.length <= y.length ? [x.join(""), y.join("")] : [y.join(""), x.join("")];
  if (short === long || (containment && [...short].length >= CONTAINED_MIN && long.includes(short))) return 1;
  const left = bigrams(x);
  const right = bigrams(y);
  let shared = 0;
  for (const [key, count] of left) shared += Math.min(count, right.get(key) || 0);
  const total = Math.max(1, x.length - 1) + Math.max(1, y.length - 1);
  return (2 * shared) / total;
}

// ประโยคปิดท้ายของก้อน: ประโยคถาม/ข้อเสนอสุดท้ายในสามประโยคท้าย (ข้ามลิงก์และเศษที่ไม่มีตัวอักษร)
// ("อยากให้ส่งรอบไหมคะ? ไม่ต้องรีบนะคะ" ยังนับข้อเสนอรอบเป็นตัวปิด)
const CLOSING_LOOKBACK = 3;
export function closingOf(burst = "") {
  const sentences = sentencesOf(String(burst).replace(URLISH, " ").replace(/\[IMAGE:[^\]]+\]/giu, " "))
    .filter((sentence) => /\p{L}/u.test(sentence));
  for (const sentence of sentences.slice(-CLOSING_LOOKBACK).reverse()) {
    if (askLike(sentence)) return sentence.replace(EMOJI_CHARS, "").replace(/\s+/gu, " ").trim();
  }
  return "";
}

const isAdmin = (turn) => String(turn?.content || "").startsWith(ADMIN_PREFIX) || Boolean(turn?.operator);
export const RECENT_CLOSING_TURNS = 2;

/**
 * ตัวปิดของสองเทิร์นล่าสุดที่ลูกแพรพิมพ์ (ใหม่สุดก่อน) พร้อมข้อความลูกค้าที่ตอบเทิร์นนั้น
 * reply ของเทิร์นล่าสุด = "" (ข้อความลูกค้าเทิร์นนี้ ตัวตัดสินจังหวะดูเอง) · ข้อความแอดมินคั่นเทิร์นแต่ไม่นับเป็นของลูกแพร
 * latest = มาจากก้อนล่าสุดของลูกแพร (ก้อนล่าสุดไม่มีตัวปิด = ตัวปิดที่เหลือมาจากก้อนก่อนหน้า ซึ่งลูกค้าตอบไปแล้วใน reply)
 * @returns {Array<{text: string, types: string[], reply: string, latest: boolean}>}
 */
export function recentClosings(history = []) {
  const turns = Array.isArray(history) ? history : [];
  const bursts = [];
  let reply = [];
  let i = turns.length - 1;
  while (i >= 0 && bursts.length < RECENT_CLOSING_TURNS) {
    const turn = turns[i];
    if (turn?.role !== "assistant" || isAdmin(turn)) {
      // ทีมงานพิมพ์คั่น = ลูกค้าตอบทีมงาน ไม่ใช่ตอบข้อเสนอของลูกแพร
      if (turn?.role === "assistant") reply = [];
      else reply.unshift(String(turn?.content || ""));
      i -= 1;
      continue;
    }
    const parts = [];
    while (i >= 0 && turns[i]?.role === "assistant" && !isAdmin(turns[i])) { parts.unshift(String(turns[i].content || "")); i -= 1; }
    bursts.push({ burst: parts.join("\n"), reply: reply.join("\n") });
    reply = [];
  }
  return bursts.map(({ burst, reply: answer }, index) => {
    const text = closingOf(burst);
    return text ? { text, types: offerTypes(text), reply: answer, latest: index === 0 } : null;
  }).filter(Boolean);
}

/** ประโยคนี้ซ้ำตัวปิดที่ต้องเลี่ยงไหม: ข้อเสนอชนิดเดียวกัน หรือถ้อยคำเหมือน ≥0.8 */
// ตรวจคิว 13 ต.ค.: "ตอนนี้ทำงานหรือธุรกิจด้านไหนอยู่คะ เช่น เจ้าของธุรกิจ…" กับ "…อยู่คะ เช่น งานขาย…" = คำถามเดิม (ตัวเลือกต่างกันทำให้ความเหมือนต่ำกว่าเกณฑ์)
// เทียบท่อนคำถามก่อน "เช่น" ด้วย เมื่อท่อนนั้นยาวพอจะเป็นคำถามจริง
const questionStem = (text = "") => String(text).split(/\s*(?:เช่น|ตัวอย่างเช่น)/u)[0];
const STEM_MIN = 12;
const sameStem = (a, b) => {
  const [x, y] = [questionStem(a), questionStem(b)];
  return x !== String(a) && y !== String(b) && [...normalizeClosing(x)].length >= STEM_MIN && [...normalizeClosing(y)].length >= STEM_MIN
    && closingSimilarity(x, y, { containment: false }) >= SIMILAR_CLOSING;
};
export function repeatsClosing(sentence = "", avoid = []) {
  if (!avoid.length) return false;
  const types = new Set(offerTypes(sentence));
  return avoid.some((item) => (item.types || []).some((type) => types.has(type))
    || closingSimilarity(sentence, item.text) >= SIMILAR_CLOSING || sameStem(sentence, item.text));
}

export const avoidTypesOf = (decision = {}) => new Set((decision.avoid || []).flatMap((item) => item.types || []));
/** ลูกค้าเมินข้อเสนอ (รอบ/จอง/ราคา/หัวข้อ/รีวิว) ในสองเทิร์นล่าสุด — คำถามที่ลูกค้าตอบแล้วไม่นับ */
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): ลูกค้าตอบข้อเสนอด้วยคำปฏิเสธล้วน ("ไม่ต้องการค่ะ") = ปฏิเสธข้อเสนอแน่นอน (ตัวตัดสินจังหวะติดป้าย offerDeclined)
export const declinedOffer = (decision = {}) => Boolean(decision.offerDeclined) || avoidTypesOf(decision).size > 0;
