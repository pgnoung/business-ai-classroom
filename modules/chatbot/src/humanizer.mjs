// humanizer.mjs — ทำให้ draft ของ AI อ่านเหมือนแอดมินไทยตัวจริง
// (พอร์ตจาก LuKprae humanizer ปรับเป้า bubble ~117 ตัวอักษรตาม SPEC G1a)
//
// ชั้น draft ตัดสินว่า "พูดอะไร" — โมดูลนี้แก้ "อ่านแล้วรู้สึกยังไง":
// ตัด markdown/bullet/เลขข้อ/ภาษาราชการ, แตก 1-4 bubble, opener ไม่ซ้ำ reply ก่อนหน้า
// ต่อ customer, และคำนวณ send-delay ระหว่าง bubble
import { createHash } from "node:crypto";
import { enforceFemaleParticles } from "./personaParticles.mjs";

// v1.4.1 (feedback พี่ง้วง 2026-08-14): เพดานขยับเป็น 4 สำหรับข้อความที่มีลิงก์ —
// ลิงก์รีวิวต้องได้บอลลูนของตัวเอง และคำถามปิดท้ายอีกบอลลูน ไม่งั้นทุกอย่างถูกอัด
// รวมกันเป็นพืดเดียว (เพดานนี้ห้ามเกิน maxTextBubbles ของ reply-delivery-policy
// ไม่งั้นชั้น delivery จะจับยุบรวมกลับด้วยช่องว่างซึ่งแย่กว่าเดิม)
const MAX_BUBBLES = 4;
const SIMPLE_MAX_BUBBLES = 2; // F3 (handoff 2026-08-12): ค่าปกติ 1-2 บับเบิล
const COMPLEX_BASE_BUBBLES = 3; // เรื่องซับซ้อน 3 — +1 ได้เมื่อมีลิงก์ที่ต้องแยกก้อน
// v1.4.9 (เคสลูกค้า A 2026-08-17 "outline ยาวเป็นพรืด"): outline ทางการมีหลาย section
// (📑หัวข้อ → 🎯เป้าหมาย → 🎯สิ่งที่จะได้รับ) knowledge สั่งให้แยกเป็นชุดบอลลูน แต่
// เพดาน 4 บีบให้ยุบเป็นก้อนเดียว 22 บรรทัด — outline ต้องแยกตามหัวข้อ
// v1.4.9b (รีวิว 2026-08-17): เพดาน 4 ไม่ใช่ 5 — เทิร์นแนะนำคลาสแนบโปสเตอร์ (mustAttach)
// ด้วย ถ้า outline 5 บอลลูน + รูป = 6 objects จะเกิน MAX_BUBBLES_PER_REPLY(5) หลุดไป
// push loop ช้า/เปลือง quota. 4 บอลลูน + โปสเตอร์ = 5 = atomic reply พอดี (section splitter
// รวม intro เข้ากับหัวข้อแรก ได้ [intro+📑หัวข้อ] → [🎯เป้าหมาย] → [🎯สิ่งที่จะได้รับ] → คำถาม)
const OUTLINE_MAX_BUBBLES = 4;

// หัวข้อ section ของ outline — emoji ชุดนี้ใช้เป็น "หัวข้อ" ในเอกสารทางการจริง
// (📑 หัวข้อที่สอน / 🎯 เป้าหมาย / 🎯 สิ่งที่จะได้รับ) ต้องแยกให้ขาดจาก bullet
// รายการ (🔴🟠🟡🟢✅🤖📊) ที่เป็น "ข้อในลิสต์" ไม่ใช่หัวข้อ
const SECTION_HEADER_LINE = /^\s*(?:📑|🎯|📝|📋|📌|🗂️?|🔖|📁|📂)\s+\S/u;

// แชทจริง 14 ต.ค.: "ไม่ทราบว่าคุณ ลูกแพรขออนุญาตส่ง…" ห้ามกลายเป็น "คุณลูกแพร"
const KHUN_LUKPRAE_MIX = /ไม่ทราบว่า\s?คุณ((?:(?!สนใจ|ให้)\S){0,30})\s+ลูกแพร(?:ขออนุญาต|ขอ)?\s?/gu;
const BARE_KHUN_GAP = /ไม่ทราบว่า\s?คุณ[ \t]+(?=[\u0E00-\u0E7F])/gu;
const NAME_PLACEHOLDER = /(?:คุณ\s?)?\(ชื่อ(?:ที่ใช้เรียก)?\)\s?/gu;

export function countSectionHeaders(text) {
  return String(text || "").split("\n").filter((line) => SECTION_HEADER_LINE.test(line)).length;
}

// แตกข้อความยาวตาม "หัวข้อ section": บรรทัดก่อนหัวข้อแรก = บอลลูน intro, แต่ละหัวข้อ
// เริ่มบอลลูนใหม่ที่ดูดเนื้อจนถึงหัวข้อถัดไป — ส่วนเกินเพดานยุบด้วย \n\n (ไม่ใช่ช่องว่าง)
function splitBySections(value, maxBubbles) {
  const groups = [];
  let current = [];
  for (const line of String(value).split("\n")) {
    if (SECTION_HEADER_LINE.test(line) && current.some((item) => item.trim())) {
      groups.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.some((item) => item.trim())) groups.push(current.join("\n").trim());
  const clean = groups.filter(Boolean);
  if (clean.length <= 1) return clean;
  if (clean.length <= maxBubbles) return clean;
  const kept = clean.slice(0, Math.max(1, maxBubbles - 1));
  kept.push(clean.slice(Math.max(1, maxBubbles - 1)).join("\n\n"));
  return kept;
}

// URL ในแชท: อักขระ URL คือทุกอย่างที่ไม่ใช่ช่องว่างและไม่ใช่อักษรไทย — สำคัญมาก
// เพราะอักษรไทยไม่ใช่ whitespace ถ้าปล่อยให้ "ค่ะ" ติดท้ายลิงก์ LINE จะนับเป็นส่วน
// ของ URL แล้วลิงก์ตาย (เคสจริง 2026-08-14: ".../1TstVf06Ff/ค่ะ" เปิดไม่ได้)
const URL_SOURCE = "https?:\\/\\/[^\\s\\u0E00-\\u0E7F]+";
const URL_ONLY = new RegExp(`${URL_SOURCE}`, "u");
const URL_AT_END = new RegExp(`${URL_SOURCE}[\\s.!]*$`, "u");
const TARGET_BUBBLE_LENGTH = 117; // SPEC G1a: เป้า ~117 chars/bubble (median แอดมินจริง)
// v1.4.4: ก้อนที่เป็น "บล็อกจัดรูปแบบ" (เว้นบรรทัด/หลายบรรทัด เช่น บล็อกราคาของชมพู่
// ~250 ตัวอักษร) ใช้เพดานใหญ่กว่า prose — บล็อกพวกนี้ถูกออกแบบมาให้อยู่บอลลูนเดียว
const BLOCK_BUBBLE_LENGTH = 450;
const MIN_SPLIT_LENGTH = 130; // สั้นกว่านี้อยู่ bubble เดียวตามธรรมชาติ

// F3: กติกา deterministic ว่าข้อความ "ซับซ้อนจริง" พอจะใช้ 3 บับเบิล —
// ยาวมาก (>420 ตัวอักษร) หรือโมเดลจัดโครงเป็น 3 ย่อหน้าขึ้นไปเอง
// (คำตอบข้อมูลปกติ ~250-350 ตัวอักษรเคยถูกซอยเป็น 3 บับเบิลพร้อมกันวินาทีเดียว
//  = อ่านเหมือนบอทยิงประกาศ ไม่ใช่แอดมินพิมพ์)
const COMPLEX_MIN_CHARS = 420;
const COMPLEX_MIN_PARAGRAPHS = 3;
export function isComplexMaterial(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if ([...value].length > COMPLEX_MIN_CHARS) return true;
  return value.split(/\n{2,}/u).filter((part) => part.trim()).length >= COMPLEX_MIN_PARAGRAPHS;
}

// opener ที่แอดมินจริงใช้สลับกัน — กัน pattern หุ่นยนต์ที่เปิดประโยคซ้ำทุก reply
const OPENING_SWAPS = {
  "ได้เลยค่ะ": ["ได้ค่ะ", "จัดให้เลยค่ะ", "โอเคเลยค่ะ"],
  "ได้ค่ะ": ["ได้เลยค่ะ", "โอเคค่ะ"],
  "รับทราบค่ะ": ["โอเคค่ะ", "ได้ค่ะ", "รับเรื่องไว้แล้วนะคะ"],
  "สวัสดีค่ะ": ["สวัสดีค่า", "ยินดีต้อนรับค่ะ"],
  "ขอบคุณค่ะ": ["ขอบคุณมากเลยค่ะ", "ขอบพระคุณค่ะ"],
  "ขอบพระคุณมากค่ะ": ["ขอบคุณมากเลยนะคะ", "ขอบคุณค่ะ"],
};

// รูปแบบที่อ่านแล้วรู้ทันทีว่าเครื่องเขียนในแชท LINE ไทย
const AI_TELL_PATTERNS = [
  { pattern: /^#{1,6}\s+/gmu, replacement: "" }, // markdown heading
  { pattern: /\*\*([^*]+)\*\*/gu, replacement: "$1" }, // bold
  { pattern: /__([^_]+)__/gu, replacement: "$1" },
  { pattern: /`([^`]+)`/gu, replacement: "$1" }, // inline code
  { pattern: /^\s*(?:[-*•]|\d+[.)])\s+/gmu, replacement: "" }, // bullet / เลขข้อ
  { pattern: /\s+—\s+|—/gu, replacement: " " }, // em dash
  { pattern: /!{2,}/gu, replacement: "!" },
  { pattern: /\?{2,}/gu, replacement: "?" },
];

// รีวิวปรปักษ์รอบ 3 5 ต.ค.: ทำไมกฎลบคำเปิดแบบผู้ช่วย AI ต้องมีแบบ "ยืนเป็นประโยคเอง"
// ด่านคำลงท้ายผู้หญิง (สวิตช์ PERSONA_PARTICLES) ทำงานก่อน stripAiTells — "แน่นอนครับ" จึงมาถึงกฎข้างล่างเป็น
// "แน่นอนค่ะ" แล้วกฎเดิม (จับกลางคำ + กินวรรคถัดไป) ทำให้คำตอบทั้งก้อนว่าง ("แน่นอนครับ" → ไม่ได้ส่งอะไรเลย),
// ขาดกลางคำ ("ลูกแพรยินดีให้บริการครับ" → "ลูกแพร") หรือคำแก้หาย ("ไม่ได้ครับ เอ้ย แน่นอนค่ะ" → "ไม่ได้ค่ะ เอ้ยค่ะ")
// แบบใหม่ตัดเฉพาะเมื่อขึ้นต้นบรรทัด/หลังวรรค และตามด้วยวรรค/จบบรรทัด และไม่ใช่ฝั่งใดฝั่งหนึ่งของคู่แก้คำผิด
// ใช้เฉพาะตอนเปิดสวิตช์ — ปิดสวิตช์ยังเป็นกฎเดิมทุกตัวอักษร (เท่า a5005211 ทุกร้านที่ไม่ได้เปิด)
const TELL_CORRECTION_WORD = "(?:เอ้ย|เอ๊ย|อุ๊ย|อุ้ย|เอ่อ|ขอโทษ|พิมพ์ผิด|ขอแก้เป็น)";
const TELL_CORRECTION_GAP = String.raw`[\s.…,!~]*`;
function standaloneTellPhrase(phrase) {
  const guarded = String.raw`(?<!${TELL_CORRECTION_WORD}(?:ค่ะ|คะ|นะคะ)?${TELL_CORRECTION_GAP})${phrase}!?(?!${TELL_CORRECTION_GAP}${TELL_CORRECTION_WORD})`;
  // ทางแรก: ทั้งบรรทัดมีแค่คำนี้ = ลบทั้งบรรทัดรวมขึ้นบรรทัดใหม่ (ไม่สร้างย่อหน้าว่างที่ทำให้แตกบอลลูนเพิ่ม)
  // ทางสอง: ยืนเป็นประโยค = ลบคำ + วรรคท้าย แต่เก็บวรรคหน้าไว้คั่นประโยคที่เหลือ
  return new RegExp(String.raw`^${guarded}[ \t]*(?:\n|$)|(?<=^|\s)${guarded}(?=\s|$)[ \t]*`, "gmu");
}

// ภาษาราชการ/ภาษาผู้ช่วย AI -> ภาษาแอดมินแชท
// ช่องที่สาม (มีเฉพาะกฎลบคำเปิด) = แบบยืนเป็นประโยคเอง ใช้เมื่อ stripAiTells({ tellPhrases: "standalone" })
const PHRASE_SOFTENERS = [
  [/หากมีข้อสงสัยเพิ่มเติม(?:ประการใด)?/gu, "ถ้าติดตรงไหน"],
  [/ไม่ต้องลังเลที่จะ(?:สอบถาม|ติดต่อ)/gu, "ทักมาได้เลย"],
  [/อย่างไรก็ตาม/gu, "แต่"],
  [/แน่นอนค่ะ!?\s*/gu, "", standaloneTellPhrase("แน่นอนค่ะ")],
  [/ยินดีให้บริการค่ะ!?\s*/gu, "", standaloneTellPhrase("ยินดีให้บริการค่ะ")],
  [/ดังต่อไปนี้\s*[:：]?/gu, "ตามนี้เลยค่ะ"],
  [/ดังนี้\s*[:：]/gu, "ตามนี้ค่ะ"],
  [/กรุณา/gu, "รบกวน"],
  [/ท่านสามารถ/gu, "สามารถ"],
  // 2026-10-03 (รีวิวรอบ 3): เดิมแทนเป็น "ของคุณลูกค้า" — humanizer ทำงานหลังด่านตัด "คุณลูกค้า"
  // จึงใส่คำที่เพิ่งถูกตัดกลับเข้าไปในห้องที่ไม่มีชื่อ และฟังเป็นภาษาระบบในทุกห้อง
  [/ของท่าน/gu, "ของคุณ"],
];

const POLITE_ENDING = /[ค่ะคะค่าครับ]\s*$/u;
const THAI_SCRIPT = /\p{Script=Thai}/u;
// ต้องจับเป็น "ลำดับ emoji" ไม่ใช่ทีละ code point — ไม่งั้น 🙏🏻 (emoji + สีผิว)
// ถูกนับเป็น 2 ตัวและถูกตัดเหลือ 🏻 ลอย ๆ ส่งถึงลูกค้า ส่วน 👩‍💻 (ZWJ) กินโควตา 2 ตัว
// ในตัวเดียวและถูกตัดกลางลำดับจนเหลือ ZWJ ค้าง — ใช้รูปแบบเดียวกับ replyDeliveryPolicy
const EMOJI_SEQUENCE_SOURCE = "(?:(?:\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?\\p{Emoji_Modifier}?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E)?\\p{Emoji_Modifier}?)*(?:[\\u{E0020}-\\u{E007E}]*\\u{E007F})?)|(?:[0-9#*]\\uFE0F?\\u20E3))";
const EMOJI_PATTERN = /(?:(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]*\u{E007F})?)|(?:[0-9#*]\uFE0F?\u20E3))/gu;
// v1.3.4: วัดจากคู่มือของแอดมินคนจริง (ชมพู่) — บรรทัดที่มี emoji ทั้ง 60 บรรทัด
// มี emoji "หนึ่งตัวพอดี" ทุกบรรทัด ไม่มีบรรทัดไหนใช้สองตัวเลย และ style profile
// ที่สกัดจากแชทจริงก็ระบุ emojiMaximum = 1 ตรงกัน
//
// จึงเปลี่ยนหน่วยจาก "ต่อคำตอบ" เป็น "ต่อบรรทัด" ซึ่งเป็นหน่วยที่วัดมาจริง:
// แต่ละบรรทัดมีตัวเน้นได้หนึ่งตัว เข้มขึ้นในย่อหน้ายาว ๆ (เดิมยัดได้ 2 ตัวติดกัน)
// แต่ผ่อนขึ้นตอนตอบเป็นลิสต์หลายบรรทัด ซึ่งตรงกับที่แอดมินคนจริงพิมพ์
const MAX_EMOJI_PER_LINE = 1;

// tellPhrases: "anywhere" = กฎเดิม (ค่าเริ่มต้น ห้ามเปลี่ยน) · "standalone" = ตัดเฉพาะที่ยืนเป็นประโยคเอง
// · "keep" = ไม่ตัดคำเปิดเลย (ทางถอยเมื่อตัดแล้วไม่เหลือภาษาไทย) — กฎ softener ตัวอื่นทำงานเหมือนเดิมทุกแบบ
export function stripAiTells(text, { tellPhrases = "anywhere" } = {}) {
  let value = String(text || "");
  for (const { pattern, replacement } of AI_TELL_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  for (const [pattern, replacement, standalone] of PHRASE_SOFTENERS) {
    if (standalone && tellPhrases !== "anywhere") {
      if (tellPhrases === "standalone") value = value.replace(standalone, replacement);
      continue;
    }
    value = value.replace(pattern, replacement);
  }
  // อักษรไทยติด URL = ลิงก์ตายใน LINE (เคสจริง ".../ค่ะ") — คั่นด้วยวรรคเสมอ
  // ไม่ว่าจะมาจากโมเดลหรือขั้นตอนไหน ลิงก์ต้องจบที่ whitespace เท่านั้น
  value = value.replace(new RegExp(`(${URL_SOURCE})(?=[\\u0E00-\\u0E7F])`, "gu"), "$1 ");
  value = limitEmoji(value, MAX_EMOJI_PER_LINE);
  return value
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();
}

// v1.2.1 (feedback พี่ง้วง): emoji "นำหน้าบรรทัด" คือ bullet นำสายตาสำหรับหัวข้อ/ลิสต์
// — อนุญาตโดยไม่นับโควตา ส่วน emoji แทรกกลางประโยคยังจำกัดเท่าเดิมกันลายเซ็นบอท
function limitEmoji(text, max) {
  return text
    .split("\n")
    .map((line) => {
      // โควตารีเซ็ตทุกบรรทัด — หน่วยที่วัดมาจากคู่มือคือ "ต่อบรรทัด" ไม่ใช่ต่อคำตอบ
      let count = 0;
      const leadLength = (line.match(/^\s*/u) || [""])[0].length;
      return line.replace(EMOJI_PATTERN, (match, offset) => {
        if (offset === leadLength) return match; // bullet นำบรรทัด
        count += 1;
        return count <= max ? match : "";
      });
    })
    .join("\n");
}

// ห้ามเปิดประโยคซ้ำกับ reply ก่อนหน้า (เทียบ opener ล่าสุดของ customer นั้น)
export function varyOpening(text, previousBotText = "") {
  const value = String(text || "");
  const previous = String(previousBotText || "");
  if (!value || !previous) return value;
  for (const [opening, swaps] of Object.entries(OPENING_SWAPS)) {
    if (value.startsWith(opening) && previous.startsWith(opening)) {
      const swap = swaps[stableIndex(value, swaps.length)];
      return swap + value.slice(opening.length);
    }
  }
  return value;
}

// แตก draft ยาวเป็น 1-4 bubble แบบ "ย่อหน้าเป็นหน่วย" (v1.4.4 — ฉบับตัดคำยั่งยืน):
// แอดมินคนจริง (ชมพู่) จัดข้อความเป็นบล็อกเว้นบรรทัด — บล็อกราคา/สิ่งที่จะได้รับ/บัญชี
// ต้องเดินทางทั้งก้อน ห้ามซอยเป็นประโยคแล้วต่อกลับด้วยช่องว่างเป็นพืดเด็ดขาด
// - บล็อกที่มีหลายบรรทัดหรือมีบรรทัดรายการ = อะตอม (ห้ามแตะข้างใน)
// - บล็อก prose บรรทัดเดียวที่ยาวมากเท่านั้นถึงซอยเป็นประโยคได้
// - บล็อกที่อยู่บอลลูนเดียวกันต่อกันด้วยบรรทัดว่าง (คงหน้าตาที่โมเดล/ชมพู่จัดมา)
export function splitIntoBubbles(text, { maxBubbles = MAX_BUBBLES, targetLength = TARGET_BUBBLE_LENGTH } = {}) {
  const value = String(text || "").trim();
  if (!value) return [];
  if ([...value].length <= MIN_SPLIT_LENGTH && !value.includes("\n\n")) return [value];

  // v1.4.9: outline หลาย section (>=2 หัวข้อ) แตกตามหัวข้อ ไม่ใช่ตามความยาว
  // (บล็อกราคา/ลงทะเบียนมีหัวข้อ emoji <2 จึงไม่เข้าเส้นนี้ — คงเป็นก้อนเดียว)
  if (countSectionHeaders(value) >= 2) {
    const sectioned = splitBySections(value, maxBubbles);
    if (sectioned.length > 1) return sectioned;
  }

  // หน่วย = ย่อหน้า (para) — สองชนิด: "จัดรูปแบบ" (หลายบรรทัด/บรรทัดรายการ เช่น
  // บล็อกราคา) กับ prose ธรรมดา; prose บรรทัดเดียวยาวมากซอยเป็นประโยคได้
  // บล็อกรายการที่เว้นบรรทัดต่อกัน (บันได 1️⃣-5️⃣ ฉบับพี่ง้วงเว้นบรรทัดทุกข้อ)
  // ต้องเชื่อมเป็นหน่วยเดียวก่อน — ห้ามให้ตัวตัดผ่ากลางบันไดเด็ดขาด
  const rawBlocks = value.split(/\n{2,}/u).map((block) => block.trim()).filter(Boolean);
  const blocks = [];
  for (const block of rawBlocks) {
    const startsList = LIST_ITEM_LINE.test(block.split("\n")[0] + " ");
    const previous = blocks.at(-1);
    if (startsList && previous && LIST_ITEM_LINE.test(previous.split("\n").at(-1) + " ")) {
      blocks[blocks.length - 1] = `${previous}\n\n${block}`;
    } else {
      blocks.push(block);
    }
  }
  const units = blocks
    .flatMap((block) => {
      const formatted = block.includes("\n") || hasListLines(block);
      if (formatted || [...block].length <= targetLength * 2) {
        return [{ text: block, formatted, para: true }];
      }
      return splitThaiSentences(block).map((sentence) => ({ text: sentence.trim(), formatted: false, para: false }));
    })
    .filter((unit) => unit.text);
  if (units.length <= 1) return [value];

  const bubbles = [];
  let current = "";
  let currentFormatted = false;
  for (const unit of units) {
    // ย่อหน้าต่อย่อหน้าคั่นด้วยบรรทัดว่าง / ประโยคย่อยในย่อหน้าเดียวกันต่อด้วยช่องว่าง
    const separator = current ? (unit.para ? "\n\n" : " ") : "";
    const merged = current ? `${current}${separator}${unit.text}` : unit.text;
    // ก้อนที่มีบล็อกจัดรูปแบบร่วมอยู่ (เช่น เกริ่น + บล็อกราคา + วิธีชำระ) ใช้เพดานใหญ่
    // เพราะถูกออกแบบมาเป็นชุดเดียว — prose ล้วนใช้เพดานปกติ (คนละหัวข้อ = คนละก้อน)
    const limit = unit.formatted || currentFormatted ? BLOCK_BUBBLE_LENGTH : targetLength;
    if (current && [...merged].length > limit && bubbles.length < maxBubbles - 1) {
      bubbles.push(current);
      current = unit.text;
      currentFormatted = unit.formatted;
    } else {
      current = merged;
      currentFormatted = currentFormatted || unit.formatted;
    }
  }
  if (current) bubbles.push(current);
  return mergeOverflow(bubbles, maxBubbles);
}

function hasListLines(paragraph) {
  return String(paragraph || "").split("\n").some((line) => LIST_ITEM_LINE.test(line));
}

// v1.2.4: คำที่ขึ้นต้นส่วนขยาย ("เช่น ...") ไม่ใช่ประโยคใหม่ — แยกออกมาแล้วกลายเป็น
// บับเบิลลอย ๆ ที่อ่านไม่รู้เรื่อง และถูกนับเป็นคำถามเพิ่มอีกหนึ่งข้อ
const CONTINUATION_START = /^(?:เช่น|อย่างเช่น|ตัวอย่างเช่น|เป็นต้น|หรือ|และ|แต่|เพราะ|โดย|ซึ่ง|ทั้งนี้)/u;

function splitThaiSentences(paragraph) {
  // ภาษาไทยในแชทไม่มี full stop — คำลงท้ายสุภาพคือจุดจบประโยค
  // ช่องว่างก่อน ?/! เป็นรูปแบบที่โมเดลส่งมาได้ แต่ห้ามนับเครื่องหมายเป็นประโยคใหม่
  const parts = String(paragraph || "")
    .replace(/[ \t]+([!?？])/gu, "$1")
    .split(/(?<=(?:ค่ะ|นะคะ|ค่า|คะ|ครับ)[\s!?)]*)\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged = [];
  let openParens = 0;
  for (const part of parts) {
    // วงเล็บเปิดค้าง = ประโยคยังไม่จบ (ป้าย "(ข้อมูลตัวอย่างระหว่างเทรน...)" ห้ามขาดครึ่ง)
    const continues = merged.length && (openParens > 0 || CONTINUATION_START.test(part));
    if (continues) merged[merged.length - 1] += ` ${part}`;
    else merged.push(part);
    openParens += (part.match(/[(（]/gu) || []).length - (part.match(/[)）]/gu) || []).length;
    if (openParens < 0) openParens = 0;
  }
  return merged;
}

function mergeOverflow(bubbles, maxBubbles) {
  const natural = [...bubbles];
  // A short acknowledgement is natural as part of the answer, but robotic as
  // its own LINE bubble (for example: "ได้ค่ะ" then the useful sentence).
  if (natural.length > 1 && [...natural[0]].length <= 16) {
    natural.splice(0, 2, `${natural[0]} ${natural[1]}`);
  }
  if (natural.length <= maxBubbles) return natural;
  const kept = natural.slice(0, maxBubbles - 1);
  // ยุบส่วนเกินด้วยการขึ้นบรรทัดใหม่ ไม่ใช่ช่องว่าง — ก้อนที่ถูกบังคับรวม
  // ยังอ่านเป็นย่อหน้าได้ ไม่กลายเป็นประโยคพืดเดียว (feedback พี่ง้วง 2026-08-14)
  kept.push(natural.slice(maxBubbles - 1).join("\n"));
  return kept;
}

// โมเดลเวลาพิมพ์: คนอ่านข้อความก่อนหน้าแล้วพิมพ์ ~4-6 ตัวอักษรไทย/วินาที
// jitter แบบ deterministic (hash ข้อความ) ให้เทสต์นิ่งแต่ pause ไม่ซ้ำเป๊ะทุกครั้ง
// v1.2.1 (feedback สดพี่ง้วง): บอลลูนแรกของบอทออกแล้ว บอลลูนถัดไปต้องตามไว (~5 วิ)
// — ช่องว่างนานเกินทำให้ข้อความบอทไปแทรกหลังคำถามใหม่ของลูกค้า อ่านแล้วเหมือนตอบผิดเรื่อง
export function pauseSecondsForBubble(text, index = 0) {
  const length = [...String(text || "")].length;
  const base = index === 0 ? 0 : 2;
  const typing = Math.ceil(length / 45);
  const jitter = stableIndex(text, 2); // 0-1s
  return Math.max(2, Math.min(5, base + typing + jitter));
}

function stableIndex(text, modulo) {
  if (!modulo) return 0;
  const digest = createHash("sha256").update(String(text || "")).digest();
  return digest[0] % modulo;
}

// บรรทัดรายการ (bullet / เลขข้อ / keycap นำหน้า) เป็น "โครงสร้าง" ไม่ใช่ประโยค
// เติมคำลงท้ายเข้าไปจะได้ "5️⃣ เคยสร้าง Custom AI, Workflow หรือ Automation แล้วค่ะ"
// ซึ่งเป็นข้อความที่ไม่มีแอดมินคนไหนพิมพ์ — เจอจริงตอนเทสต์บันได 5 ระดับ
const LIST_ITEM_LINE = new RegExp(`^\\s*(?:${EMOJI_SEQUENCE_SOURCE}|[-*•]|\\d+[.)])\\s`, "u");

export function ensurePoliteEnding(text) {
  // v1.4.4: ก้อนที่มีบรรทัดว่างข้างใน = บล็อกจัดรูปแบบ (ราคา/บัญชี/สิ่งที่จะได้รับ)
  // ถูกออกแบบท้ายก้อนมาแล้ว — เติม ค่ะ เข้าไปได้ "2.5%)ค่ะ" ซึ่งไม่มีแอดมินคนไหนพิมพ์
  if (String(text || "").includes("\n\n")) return String(text || "").trim();
  const lastLine = String(text || "").split("\n").at(-1) ?? "";
  if (LIST_ITEM_LINE.test(lastLine)) return String(text || "").trim();
  // จบด้วยลิงก์ = ห้ามเติมคำลงท้ายทุกกรณี — ตัวเช็ควรรคเดิมรู้จักแค่ [A-Za-z0-9]
  // ลิงก์ที่จบด้วย "/" เลยโดนต่อ "ค่ะ" ชิดติดจนลิงก์ตาย (เคสจริง 2026-08-14)
  if (URL_AT_END.test(String(text || "").trim())) return String(text || "").trim();
  const value = String(text || "")
    .trim()
    .replace(/(คะ|ค่ะ|ครับ)\s*\?+\s*(?:ค่ะ|คะ|ครับ)\s*$/u, "$1?")
    // เดิม whitelist ไว้ 7 ตัว ทำให้ emoji อื่น (🔥 💰 ⏰ ✅) กลายเป็น "...บาทค่ะ 🔥ค่ะ"
    // ซึ่งคือ emoji ชุดที่เจ้าของอยากใช้เน้นราคาพอดี — ใช้คลาส emoji ทั่วไปแทน
    .replace(new RegExp(`(คะ|ค่ะ|ครับ)\\s*(${EMOJI_SEQUENCE_SOURCE})\\s*(?:ค่ะ|คะ|ครับ)\\s*$`, "u"), "$1 $2");
  if (!value) return value;
  const stripped = value.replace(new RegExp(`(?:${EMOJI_SEQUENCE_SOURCE}|[\\s.!?])+$`, "gu"), "");
  if (POLITE_ENDING.test(stripped)) return value;
  // v1.2.4 (เคสจริง 2026-08-13): ประโยคที่จบด้วย "?" อยู่แล้ว ห้ามต่อคำลงท้ายท้ายเครื่องหมาย
  // ("...สร้างภาพ?ค่ะ" คือข้อความพังที่เกือบหลุดถึงลูกค้า) — ต้องแทรกคำลงท้ายไว้ก่อน "?"
  // emoji ท้ายข้อความต้องถูกยกออกก่อน แล้วเอากลับไปต่อท้ายสุด ไม่งั้นคำลงท้ายจะไปอยู่
  // หลัง emoji ("...บาท 🔥ค่ะ") ซึ่งไม่มีแอดมินคนไหนพิมพ์แบบนั้น
  const tailEmoji = value.match(new RegExp(`(?:\\s*(?:${EMOJI_SEQUENCE_SOURCE}))+\\s*$`, "u"))?.[0] ?? "";
  const core = tailEmoji ? value.slice(0, value.length - tailEmoji.length) : value;
  if (tailEmoji) {
    const politeCore = ensurePoliteEnding(core);
    return `${politeCore}${tailEmoji.replace(/\s+$/u, "").replace(/^\s*/u, " ")}`;
  }
  const trailing = value.match(/[\s.!?]+$/u)?.[0] ?? "";
  const body = trailing ? value.slice(0, value.length - trailing.length) : value;
  const question = /[?？]/u.test(trailing);
  // คำลงท้ายไทยหลังตัวอักษรละติน/ตัวเลขต้องมีวรรค ("Organization ค่ะ")
  const separator = /[A-Za-z0-9]$/.test(body) ? " " : "";
  if (question) return `${body}${separator}คะ?`;
  return `${value}${/[A-Za-z0-9]$/.test(value) ? " " : ""}ค่ะ`;
}

// v1.2.1 (feedback พี่ง้วง): คำถามนำท้ายข้อความต้อง "เคาะบรรทัดใหม่ + มี ?"
// — ลูกค้าสแกนบนมือถือแล้วเห็นทันทีว่าเราถามอะไร ไม่จมอยู่ท้ายพารากราฟ
// v1.2.5: ต้องเป็นคำถาม "ที่ท้ายประโยค" เท่านั้น — ของเดิมจับคำถามที่ตำแหน่งไหนก็ได้
// ทำให้ประโยคบอกเล่า "ไม่มีค่าใช้จ่ายอะไรเพิ่มค่ะ" ถูกเติม "?" กลายเป็นคำถาม และลิงก์
// ที่มี query string ("...register?ref=line ค่ะ") ก็ถูกตัดสินว่าเป็นคำถามด้วย
// "นะคะ/นะครับ" เป็นคำลงท้ายบอกเล่า จึงไม่นับ ("เดี๋ยวเช็คให้ว่าเหลือกี่ที่นั่งนะคะ")
const QUESTION_HINT = new RegExp(
  "(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง)(?:นะคะ|นะครับ|คะ|ครับ)?\\s*[?？]?$"
  + "|(?:อะไร|ไหน|ใคร|ทำไม|ยังไง|อย่างไร|เมื่อไหร่|เท่าไหร่|เท่าไร|กี่)[^\\n]{0,20}?(?<!นะ)(?:คะ|ครับ)\\s*[?？]?$"
  // คำถามตัวเลือก "จะมาเรียนเองหรือพาทีมมาด้วยคะ" — ไม่มีคำแสดงคำถามและโมเดลมักลืมใส่ ?
  // อาศัยธรรมเนียมไทย: คำถามลงท้าย "คะ" ส่วนประโยคบอกเล่าลงท้าย "ค่ะ" (คนละคำ)
  + "|หรือ[^\\n]{0,48}?(?<!นะ)(?:คะ|ครับ)\\s*[?？]?$"
  + "|[?？]\\s*$",
  "u",
);
const TRAILING_EMOJI = /(\s*\p{Extended_Pictographic}+\s*)$/u;

function ensureQuestionMark(sentence) {
  const value = sentence.replace(/\s+$/u, "");
  if (/\?\s*$/u.test(value.replace(TRAILING_EMOJI, ""))) return value;
  if (TRAILING_EMOJI.test(value)) return value.replace(TRAILING_EMOJI, "?$1");
  return `${value}?`;
}

// v1.3.3 (feedback พี่ง้วง): คำถามปิดท้ายต้องเป็น "บอลลูนของตัวเอง" ไม่ใช่แค่ขึ้นบรรทัด
// ใหม่ในก้อนเดิม — บนมือถือ ก้อนยาว ๆ ที่มีคำถามซ่อนอยู่บรรทัดสุดท้ายอ่านแล้วติดเป็นพรืด
// ลูกค้าไม่เห็นว่าถูกถามอะไร
//
// จงใจ "จองโควตา" ให้คำถามตั้งแต่ต้น แทนที่จะเพิ่มบอลลูนตอนท้าย เพราะ
// replyDeliveryPolicy จะรวมบอลลูนส่วนเกินกลับเข้าด้วยกันด้วยช่องว่าง ซึ่งจะได้ผลแย่กว่าเดิม
export function hasTrailingLeadQuestion(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  const lastSentence = splitThaiSentences(value.split("\n").at(-1)).at(-1) || "";
  return QUESTION_HINT.test(lastSentence);
}

// แยกบรรทัดคำถามท้ายบอลลูนสุดท้ายออกมาเป็นบอลลูนใหม่ ถ้ายังมีโควตาเหลือ
// ตรวจซ้ำด้วย QUESTION_HINT เพื่อไม่ให้ไปตัดบรรทัดสุดท้ายของรายการหัวข้อ (emoji bullet)
export function detachLeadQuestion(bubbles, maxBubbles) {
  if (!Array.isArray(bubbles) || bubbles.length === 0 || bubbles.length >= maxBubbles) return bubbles;
  const last = String(bubbles.at(-1) ?? "");
  const cut = last.lastIndexOf("\n");
  if (cut < 0) return bubbles;
  const body = last.slice(0, cut).trim();
  const question = last.slice(cut + 1).trim();
  if (!body || !question || !QUESTION_HINT.test(question)) return bubbles;
  return [...bubbles.slice(0, -1), body, question];
}

// v1.4.4 (คำสั่งพี่ง้วง 2026-08-15): รีวิว = บอลลูนเดียว — เกริ่น + ชื่อ-ตำแหน่ง + ลิงก์
// อยู่ก้อนเดียวกัน โดย "ลิงก์ต้องเป็นบรรทัดสุดท้ายของก้อน" (ห้ามมีอะไรตามหลังลิงก์
// ในบรรทัด/ก้อนเดียวกัน — ลิงก์เสียคือบาปหนักสุด) ข้อความที่ตามหลังลิงก์ (เช่น
// คำถามชวนคุยต่อ) แยกออกเป็นบอลลูนถัดไป
export function detachStandaloneLink(bubbles, maxBubbles) {
  if (!Array.isArray(bubbles) || bubbles.length === 0) return bubbles;
  const out = [];
  let budget = maxBubbles - bubbles.length;
  for (const bubble of bubbles) {
    const text = String(bubble);
    const match = URL_ONLY.exec(text);
    if (!match) {
      out.push(text);
      continue;
    }
    const before = text.slice(0, match.index).replace(/[ \t]+$/u, "").replace(/\n+$/u, "\n").trimEnd();
    let after = text.slice(match.index + match[0].length).replace(/^[\s.!]+/u, "").trim();
    // คำลงท้ายลอย ๆ หลังลิงก์ ("ค่ะ") ไม่มีเนื้อหา — ทิ้งไป ห้ามต่อกลับเข้าลิงก์ทุกกรณี
    if (/^(?:ค่ะ|คะ|ค่า|ครับ|นะคะ|นะครับ)$/u.test(after)) after = "";
    // v1.4.11 (เคสจริงลูกค้า A 2026-08-18: โมเดลอัดคำแนะนำคลาส+รีวิว+ลิงก์รวมก้อนเดียว
    // 400 ตัวอักษร): ถ้าก้อนก่อนลิงก์มีประโยคเกริ่นรีวิวอยู่กลางก้อน แยกเนื้อหาหน้ารีวิว
    // ออกเป็นบอลลูนของตัวเอง — รีวิวต้องได้ก้อนสะอาดตามสัญญา 3 บอลลูนของชมพู่
    let linkBubble;
    const reviewIntroIndex = before.search(/ขออนุญาตส่งรีวิว/u);
    // v1.4.11b (audit จับ): ข้อความหลังลิงก์ (คำถามชวนคุย) ต้องได้ก้อนแยกก่อนเสมอ —
    // ถ้าโควตาเหลือใบเดียวและมี after ให้ยกโควตาให้ after ไม่ใช่การแยกก้อนเกริ่น
    if (reviewIntroIndex > 40 && budget > (after ? 1 : 0)) {
      out.push(before.slice(0, reviewIntroIndex).trimEnd());
      budget -= 1;
      linkBubble = `${before.slice(reviewIntroIndex).trimEnd()}\n${match[0]}`;
    } else {
      // เกริ่น + ลิงก์เป็นบรรทัดสุดท้าย = ก้อนรีวิวมาตรฐาน
      linkBubble = before ? `${before}\n${match[0]}` : match[0];
    }
    if (!after) {
      out.push(linkBubble);
      continue;
    }
    if (budget > 0) {
      out.push(linkBubble, after);
      budget -= 1;
    } else {
      // โควตาหมด: ท้ายต้องขึ้นบรรทัดใหม่หลังลิงก์เสมอ (LINE ตัดลิงก์ที่ whitespace)
      out.push(`${linkBubble}\n${after}`);
    }
  }
  return out;
}

// v1.4.1: คืนบรรทัดให้ keycap ที่ถูกต่อกลับด้วยช่องว่าง (ตัวแบ่งประโยคกิน \n หลัง
// "คะ?" ได้ หรือโมเดลพิมพ์ "? 1️⃣" เอง) — ทำเฉพาะบอลลูนที่มีบรรทัด keycap อยู่แล้ว
// เพื่อไม่ไปยุ่งกับ keycap กลางประโยคปกติ ("กด 1️⃣ เพื่อยืนยัน")
const KEYCAP_SOURCE = "[0-9#*]\\uFE0F?\\u20E3";
const HAS_KEYCAP_LINE = new RegExp(`\\n\\s*${KEYCAP_SOURCE}`, "u");
export function restoreKeycapLineBreaks(bubble) {
  const value = String(bubble || "");
  if (HAS_KEYCAP_LINE.test(value)) {
    return value.replace(new RegExp(`([^\\n])[ \\t]+(?=${KEYCAP_SOURCE})`, "gu"), "$1\n");
  }
  // v1.4.5 (เคสจริง 2026-08-15: บันไดคัดกรองทั้งก้อนถูกพ่นเป็นบรรทัดเดียว):
  // เงื่อนไขเดิมต้องมี keycap หลัง \n อยู่ก่อนถึงจะซ่อม — ก้อนที่ inline ล้วน
  // จึงหลุดทั้งก้อน; รายการจริง (≥3 keycap) ให้คืนบรรทัดว่างตามฟอร์แมตบันได
  // ของพี่ง้วง ส่วน prose ที่เอ่ยถึง keycap แค่ 1-2 ตัวไม่โดนแตะ
  if ((value.match(new RegExp(KEYCAP_SOURCE, "gu")) || []).length >= 3) {
    return value.replace(new RegExp(`([^\\n])[ \\t]+(?=${KEYCAP_SOURCE})`, "gu"), "$1\n\n");
  }
  return value;
}

export function formatLeadQuestion(text) {
  const value = String(text || "").trim();
  if (!value) return value;
  const lines = value.split("\n");
  const lastLine = lines.at(-1);
  const sentences = splitThaiSentences(lastLine);
  const lastSentence = sentences.at(-1) || "";
  if (!QUESTION_HINT.test(lastSentence)) return value;
  const question = ensureQuestionMark(lastSentence);
  if (sentences.length === 1) {
    return [...lines.slice(0, -1), question].join("\n");
  }
  const body = sentences.slice(0, -1).join(" ");
  return [...lines.slice(0, -1), body, question].join("\n");
}

// instance เก็บ opener ล่าสุดต่อ customer (in-memory — รีสตาร์ทแล้วเริ่มใหม่ได้ ไม่ใช่ state ธุรกิจ)
//
// femaleParticles (คำสั่งพี่ง้วง 5 ต.ค. 2026 "เพิ่มด่านกันคำว่าครับให้หน่อย"): ลูกแพรเป็นผู้หญิง แต่ production
// ส่ง "ยินดีครับ... เอ่อ ยินดีค่ะ" ถึงลูกค้า — humanize คือทางเดียวที่ข้อความที่ AI เขียนทุกเส้นต้องผ่าน
// (ตอบปกติ ผู้ตรวจเขียนใหม่ ติดตาม staged YOLO ทวงโอน) ส่วนข้อความที่แอดมินพิมพ์ไม่เคยผ่านที่นี่ จึงไม่โดนแก้
// ค่าเริ่มต้นปิด: chassis ใช้หลายร้าน ร้านที่ผู้ช่วยเป็นผู้ชาย/ไม่ระบุเพศต้องไม่โดนเปลี่ยนเสียง
// onParticleFix(customerId, fixes, residual) — ให้ชั้นนอกเขียน audit; พังก็ห้ามทำให้ข้อความไม่ถูกส่ง
export function createHumanizer({ femaleParticles = false, onParticleFix = null, logger = console } = {}) {
  const lastOpenerByCustomer = new Map();

  function reportParticles(customerId, fixes, residual) {
    if (typeof onParticleFix !== "function") return;
    const warn = (error) => logger?.warn?.(`[humanizer] onParticleFix failed: ${error?.message || error}`);
    try {
      const pending = onParticleFix(customerId, fixes, residual);
      if (pending && typeof pending.then === "function") pending.then(null, warn);
    } catch (error) {
      warn(error);
    }
  }

  // ขั้น 0: ต้องมาก่อน stripAiTells/varyOpening — OPENING_SWAPS และ PHRASE_SOFTENERS จับคำที่ลงท้าย ค่ะ
  // ด่านพังเอง = ส่งข้อความเดิมพร้อมแจ้ง (ลูกค้าเจอความเงียบแย่กว่าคำลงท้ายผิด)
  function applyFemaleParticles(customerId, text, protect) {
    let result;
    try {
      result = enforceFemaleParticles(text, { protect });
    } catch (error) {
      logger?.warn?.(`[humanizer] female particle guard failed: ${error?.message || error}`);
      reportParticles(customerId, [], [{ kind: "guard_error", sample: "" }]);
      return text;
    }
    if (result.changed || result.residual.length) reportParticles(customerId, result.fixes, result.residual);
    return result.text;
  }

  // รีวิวปรปักษ์รอบ 3 5 ต.ค.: เปิดสวิตช์ = ตัดคำเปิดแบบ AI เฉพาะที่ยืนเป็นประโยคเอง และถ้าตัดแล้วไม่เหลือภาษาไทยเลย
  // ("แน่นอนครับ" → "แน่นอนค่ะ" → ว่าง) ให้เก็บคำไว้ — ข้อความว่างคือ empty_after_humanize ลูกค้าไม่ได้คำตอบ
  function stripAiTellsKeepingThai(source) {
    const cleaned = stripAiTells(source, { tellPhrases: "standalone" });
    if (THAI_SCRIPT.test(cleaned) || !THAI_SCRIPT.test(String(source || ""))) return cleaned;
    return stripAiTells(source, { tellPhrases: "keep" });
  }

  // คืน [{ text, pauseSec }] พร้อมส่ง — ว่าง = ไม่มีอะไรควรส่ง
  // protect = ข้อความที่ห้ามแก้คำลงท้าย (ชื่อลูกค้า ป้ายรีวิว) ใช้เฉพาะตอนเปิด femaleParticles
  function humanize({ customerId = "default", text = "", protect = [] }) {
    // พี่ง้วง 13 ต.ค.: แม่แบบคำถามถ่อมตัว "ไม่ทราบว่าคุณ(ชื่อ) …" — ถ้าโมเดลพิมพ์ "(ชื่อ)" ตามตัวมาถึงด่านส่ง ตัดทิ้ง (ทุกเส้นทาง: v3/เครื่องเดิม/ทักตาม)
    // แชทจริง 13 ต.ค.: "ไม่ทราบว่าคุณ ทำธุรกิจ…" (ไม่มีชื่อ เหลือช่องว่างเหมือนชื่อหาย) = ติดกันเป็น "ไม่ทราบว่าคุณทำธุรกิจ…"
    text = String(text ?? "").replace(NAME_PLACEHOLDER, "")
      .replace(KHUN_LUKPRAE_MIX, (_, name) => `ไม่ทราบว่าคุณ${name ? `${name} ` : ""}สนใจให้ลูกแพร`)
      .replace(BARE_KHUN_GAP, "ไม่ทราบว่าคุณ").replace(/ลูกแพรส่งให้ค่ะ\s*[?？]+/gu, "ลูกแพรส่งให้ค่ะ");
    const source = femaleParticles ? applyFemaleParticles(customerId, text, protect) : text;
    const cleaned = femaleParticles ? stripAiTellsKeepingThai(source) : stripAiTells(source);
    const varied = varyOpening(cleaned, lastOpenerByCustomer.get(customerId) || "");
    // F3: ปกติ 1-2 บับเบิล — 3 เฉพาะเรื่องซับซ้อนจริง และ +1 เมื่อมีลิงก์
    // (ลิงก์ต้องได้บอลลูนของตัวเอง — feedback พี่ง้วง 2026-08-14)
    const hasLink = URL_ONLY.test(varied);
    // v1.4.9: outline (>=2 หัวข้อ section) ได้เพดานพิเศษ 5 เพื่อแยกแต่ละหัวข้อเป็นบอลลูน
    const isOutline = countSectionHeaders(varied) >= 2;
    const base = isOutline ? OUTLINE_MAX_BUBBLES : isComplexMaterial(varied) ? COMPLEX_BASE_BUBBLES : SIMPLE_MAX_BUBBLES;
    const ceiling = Math.min(isOutline ? OUTLINE_MAX_BUBBLES : MAX_BUBBLES, base + (hasLink ? 1 : 0));
    // จองโควตาบอลลูนสุดท้ายไว้ให้คำถามปิดท้าย เนื้อหาจึงตัดในโควตาที่เหลือ
    const reserveQuestion = ceiling > 1 && hasTrailingLeadQuestion(varied);
    const bodyBudget = reserveQuestion ? ceiling - 1 : ceiling;
    // มีลิงก์ = กันโควตาไว้หนึ่งช่องให้ detachStandaloneLink แยกลิงก์ออกทีหลัง
    // ไม่งั้นตัวแตกประโยคใช้โควตาเต็มแล้วลิงก์ไม่มีที่ให้แยก
    let bubbles = splitIntoBubbles(varied, { maxBubbles: Math.max(1, bodyBudget - (hasLink ? 1 : 0)) });
    if (!bubbles.length) return [];
    if (hasLink) bubbles = detachStandaloneLink(bubbles, bodyBudget);

    const withEnding = bubbles.map((bubble, index) =>
      index === bubbles.length - 1 ? formatLeadQuestion(ensurePoliteEnding(bubble)) : bubble
    );
    const detached = detachLeadQuestion(withEnding, ceiling).map(restoreKeycapLineBreaks);
    lastOpenerByCustomer.set(customerId, detached[0]);
    return detached.map((bubbleText, index) => ({
      text: bubbleText,
      pauseSec: pauseSecondsForBubble(bubbleText, index),
    }));
  }

  return { humanize };
}
