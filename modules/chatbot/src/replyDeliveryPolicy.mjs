// replyDeliveryPolicy.mjs — instance-scoped output contract after humanizer.
//
// This module deliberately does not rewrite drafts.  A caller decides whether a
// violation becomes a human handoff, a correction candidate, or another safe
// action.  Keeping the policy pure lets a customer instance opt in without
// changing legacy instances such as Airdog.
import { existsSync, readFileSync } from "node:fs";

const POLICY_KEYS = new Set([
  "enabled",
  "maxImages",
  "maxQuestions",
  "maxTextBubbles",
  "requireExactlyOneFinalQuestionWhenImages",
  "terminalRoutes",
  "terminalIntents",
  "terminalReasons",
]);

const DEFAULT_ENABLED_POLICY = Object.freeze({
  enabled: true,
  maxImages: 2,
  maxQuestions: 1,
  maxTextBubbles: 3,
  requireExactlyOneFinalQuestionWhenImages: true,
  terminalRoutes: Object.freeze([]),
  terminalIntents: Object.freeze([]),
  terminalReasons: Object.freeze([]),
});

export const DISABLED_REPLY_DELIVERY_POLICY = Object.freeze({ enabled: false });

function asStringList(value, key) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Reply delivery policy ${key} must be an array of non-empty strings.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function asLimit(value, key, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new Error(`Reply delivery policy ${key} must be an integer from 0 to 20.`);
  }
  return value;
}

// Validate object data from a reviewed JSON file.  Unknown keys are errors so a
// typo never quietly weakens an instance's outbound contract.
export function validateReplyDeliveryPolicy(value) {
  if (value === undefined || value === null) return DISABLED_REPLY_DELIVERY_POLICY;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Reply delivery policy must be a JSON object.");
  }
  for (const key of Object.keys(value)) {
    if (!POLICY_KEYS.has(key)) throw new Error(`Reply delivery policy has unknown key: ${key}`);
  }
  if (value.enabled === undefined || typeof value.enabled !== "boolean") {
    throw new Error("Reply delivery policy enabled must be a boolean.");
  }
  if (!value.enabled) {
    // Disabled means disabled, not a partially active configuration whose
    // remaining fields may later be mistakenly consumed.
    if (Object.keys(value).length !== 1) {
      throw new Error("Disabled reply delivery policy must contain only enabled:false.");
    }
    return DISABLED_REPLY_DELIVERY_POLICY;
  }
  if (value.requireExactlyOneFinalQuestionWhenImages !== undefined &&
      typeof value.requireExactlyOneFinalQuestionWhenImages !== "boolean") {
    throw new Error("Reply delivery policy requireExactlyOneFinalQuestionWhenImages must be a boolean.");
  }
  return Object.freeze({
    enabled: true,
    maxImages: asLimit(value.maxImages, "maxImages", DEFAULT_ENABLED_POLICY.maxImages),
    maxQuestions: asLimit(value.maxQuestions, "maxQuestions", DEFAULT_ENABLED_POLICY.maxQuestions),
    maxTextBubbles: asLimit(value.maxTextBubbles, "maxTextBubbles", DEFAULT_ENABLED_POLICY.maxTextBubbles),
    requireExactlyOneFinalQuestionWhenImages:
      value.requireExactlyOneFinalQuestionWhenImages === undefined
        ? DEFAULT_ENABLED_POLICY.requireExactlyOneFinalQuestionWhenImages
        : value.requireExactlyOneFinalQuestionWhenImages,
    terminalRoutes: asStringList(value.terminalRoutes, "terminalRoutes"),
    terminalIntents: asStringList(value.terminalIntents, "terminalIntents"),
    terminalReasons: asStringList(value.terminalReasons, "terminalReasons"),
  });
}

export function loadReplyDeliveryPolicy(file) {
  if (!file) return DISABLED_REPLY_DELIVERY_POLICY;
  if (!existsSync(file)) throw new Error(`Reply delivery policy file does not exist: ${file}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Reply delivery policy file is invalid JSON: ${err?.message || err}`);
  }
  return validateReplyDeliveryPolicy(parsed);
}

// Thai LINE messages often omit '?' and commonly end with an emoji. Count
// question *clauses*, not every occurrence of words such as "อะไร": those words
// also appear in explanatory lists (for example a RICE prompt breakdown).
//
// Yes/no markers are intrinsically interrogative at a clause boundary, while
// broad question words need a polite question ending or explicit punctuation.
// Emoji are removed only when they behave like punctuation at a boundary.
const YES_NO_QUESTION = /(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง)(?:นะคะ|นะครับ|คะ|ครับ)?\s*[?？]?(?=\s*(?:$|[.!]|แล้ว|หรือ))/giu;
// v1.2.5: "นะคะ/นะครับ" เป็นคำลงท้ายบอกเล่าที่ทำให้ประโยคนุ่มลง ไม่ใช่คำถาม
// ("เดี๋ยวลูกแพรเช็คให้ว่าเหลือกี่ที่นั่งนะคะ" คือการรับปาก ไม่ได้ถามลูกค้า)
const QUESTION_WORD_CLAUSE = /(?:กี่(?:บาท|วัน|คน|ท่าน|เครื่อง|รุ่น)?|อะไร|ไหน|ใคร|ทำไม|ยังไง|อย่างไร|เมื่อไหร่|เท่าไหร่|เท่าไร)(?:[^\n.!?？]{0,24}?)(?<!นะ)(?:คะ|ครับ|[?？])(?=\s|$|[.!])/giu;
// เครื่องหมาย ? ใน URL (?ref= ?utm_source= ?v=) ไม่ใช่คำถาม — ต้องมาสก์ทิ้งก่อนนับเสมอ
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|co\.th|net|org|me|gle|app|io|ai)\/\S*/giu;
const BOUNDARY_EMOJI = /[\p{Extended_Pictographic}\uFE0F\u200D]+(?=\s|$|[.!?？])/gu;

// A LINE reaction-like suffix can be a multi-codepoint sequence: base emoji +
// skin tone, a ZWJ sequence, a keycap, or a tag flag.  `Extended_Pictographic`
// alone does not consume every trailing component (notably skin tones and
// keycap/tag code points), which used to make a perfectly normal final Thai
// question look non-terminal.
const TRAILING_EMOJI_SEQUENCE = /(?:(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]*\u{E007F})?)|(?:[0-9#*]\uFE0F?\u20E3))+\s*$/u;
const FINAL_YES_NO_QUESTION = /(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง)(?:นะคะ|นะครับ|คะ|ครับ)?\s*[?？]?\s*$/iu;
const FINAL_QUESTION_WORD_CLAUSE = /(?:กี่(?:บาท|วัน|คน|ท่าน|เครื่อง|รุ่น)?|อะไร|ไหน|ใคร|ทำไม|ยังไง|อย่างไร|เมื่อไหร่|เท่าไหร่|เท่าไร)(?:[^\n.!?？]{0,24}?)(?<!นะ)(?:คะ|ครับ|[?？])\s*$/iu;

function withoutTrailingEmoji(text) {
  let result = String(text || "").trimEnd();
  // A loop keeps the rule correct if two independently formed emoji sequences
  // are appended to a bubble (for example a hand + a keycap reaction).
  while (TRAILING_EMOJI_SEQUENCE.test(result)) {
    result = result.replace(TRAILING_EMOJI_SEQUENCE, "").trimEnd();
  }
  return result;
}

// v1.2.4 (เคสจริง 2026-08-13): กติกา "ถามได้ครั้งละหนึ่งคำถาม" หมายถึงจำนวน "คำถามที่
// ลูกค้าต้องตอบ" ไม่ใช่จำนวนแพตเทิร์นที่ regex เจอ. ของเดิมนับ
// "เคยใช้ AI ช่วยงานอะไรบ้างแล้วคะ เช่น เขียนงาน สรุปเอกสาร หรือสร้างภาพ?"
// เป็นสองคำถาม (คำว่า "อะไร...คะ" หนึ่ง + เครื่องหมาย "?" ท้ายประโยคเดียวกันอีกหนึ่ง)
// แล้วบล็อกคำตอบทั้งก้อนทิ้ง ทั้งที่ลูกค้าเห็นคำถามเดียว — จึงต้องนับทีละประโยค
function countQuestionPatterns(text) {
  let remainder = withoutTrailingEmoji(text).replace(BOUNDARY_EMOJI, "").replace(URL_PATTERN, " ");
  const yesNo = [...remainder.matchAll(YES_NO_QUESTION)];
  for (const match of yesNo) remainder = remainder.replace(match[0], "");
  const questionWords = [...remainder.matchAll(QUESTION_WORD_CLAUSE)];
  for (const match of questionWords) remainder = remainder.replace(match[0], "");
  return yesNo.length + questionWords.length + [...remainder.matchAll(/[?？]/gu)].length;
}

export function countQuestions(text) {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return Math.min(countQuestionPatterns(text), 1);
  return sentences.reduce((count, sentence) => count + Math.min(countQuestionPatterns(sentence), 1), 0);
}

export function bubbleHasQuestion(text) {
  return countQuestions(text) > 0;
}

// Image replies need a question as their *last clause*.  A question earlier in
// the final bubble is not an invitation for the customer to reply if ordinary
// delivery prose follows it.
export function bubbleEndsWithQuestion(text) {
  const terminalText = withoutTrailingEmoji(text);
  if (!countQuestions(terminalText)) return false;
  return /[?？]\s*$/u.test(terminalText) ||
    FINAL_YES_NO_QUESTION.test(terminalText) ||
    FINAL_QUESTION_WORD_CLAUSE.test(terminalText);
}

// v1.2.2 (เคสจริง 2026-08-12: ลูกค้าพิมพ์ "สนใจคับ ai" แล้วได้ template
// "ข้อมูลตรงนี้ยังยืนยันไม่ได้ค่ะ" กลับไป): คำถามเกินโควตาเป็นปัญหา "รูปแบบ" ไม่ใช่
// "เนื้อหาผิด" — การทิ้งคำตอบทั้งก้อนแล้วส่ง fallback ทำให้ลูกค้าเจอ dead end
// ทั้งที่ดราฟต์มีคำตอบที่ถูกต้องอยู่. ซ่อมด้วยการ "ตัดคำถามส่วนเกินทิ้ง" เท่านั้น
// (ลบอย่างเดียว ไม่เคยเติมข้อความใหม่) แล้วประเมินใหม่ก่อนถึงจะยอม fallback
export const REPAIRABLE_VIOLATIONS = Object.freeze([
  "max_questions_exceeded",
  "image_reply_requires_exactly_one_question",
]);

export function isRepairableDelivery(violations = []) {
  const list = Array.isArray(violations) ? violations : [];
  return list.length > 0 && list.every((item) => REPAIRABLE_VIOLATIONS.includes(item));
}

// v1.2.5 (ตรวจอิสระ 2026-08-13): กติกาการส่งทั้งชุดนี้เป็นเรื่อง "รูปแบบ" ไม่ใช่ความปลอดภัย
// — จำนวนคำถาม จำนวนบับเบิล และกติกาว่ารูปต้องมีคำถามปิดท้าย. การทิ้งคำตอบที่ถูกต้อง
// ทั้งก้อนเพราะเรื่องเหล่านี้ ทำให้ลูกค้าเจอทางตัน ซึ่งเสียหายกว่าการส่งข้อความที่
// รูปแบบไม่เป๊ะมาก (เคสจริง: ลูกค้าขอใบเสร็จแล้วได้ "ข้อมูลตรงนี้ยังยืนยันไม่ได้ค่ะ" + ไม่ได้รูป)
// ฟังก์ชันนี้จึงลดทอนด้วยการ "ลบอย่างเดียว" จนส่งได้ และไม่มีทางคืนค่าว่าง
export function degradeToDeliverable({ policy = DISABLED_REPLY_DELIVERY_POLICY, bubbles = [], images = [], route = "", intent = "", reason = "" } = {}) {
  const applied = [];
  let nextBubbles = Array.isArray(bubbles) ? [...bubbles] : [];
  let nextImages = Array.isArray(images) ? [...images] : [];
  const assess = () => assessReplyDelivery({ policy, bubbles: nextBubbles, images: nextImages, route, intent, reason });

  let result = assess();
  if (result.ok || result.disabled) return { bubbles: nextBubbles, images: nextImages, applied, ok: true };

  if (result.violations.includes("max_images_exceeded")) {
    nextImages = nextImages.slice(0, policy.maxImages);
    applied.push("trimmed_images");
    result = assess();
  }
  if (result.violations.includes("max_questions_exceeded")) {
    const repaired = repairExcessQuestions(nextBubbles, { maxQuestions: policy.maxQuestions });
    if (repaired?.length) {
      nextBubbles = repaired;
      applied.push("trimmed_questions");
      result = assess();
    }
  }
  if (result.violations.includes("max_text_bubbles_exceeded")) {
    const kept = nextBubbles.slice(0, policy.maxTextBubbles - 1);
    const tail = nextBubbles.slice(policy.maxTextBubbles - 1);
    const merge = (bubble) => (typeof bubble === "string" ? bubble : bubble.text);
    const last = tail[tail.length - 1];
    kept.push(typeof last === "object" && last !== null
      ? { ...last, text: tail.map(merge).join(" ") }
      : tail.map(merge).join(" "));
    nextBubbles = kept;
    applied.push("merged_bubbles");
    result = assess();
  }
  // กติกา "รูปต้องจบด้วยคำถามเดียว" มีไว้กันบทสนทนาตายหลังส่งรูป เป็นความชอบด้านสไตล์
  // ไม่ใช่ความปลอดภัย — ลูกค้าที่ขอใบเสร็จต้องได้ทั้งข้อความและรูป ไม่ใช่ถูกตัดอย่างใดอย่างหนึ่ง
  if (result.violations.some((item) => item.startsWith("image_reply_requires"))) {
    applied.push("waived_image_question_rule");
  }
  return { bubbles: nextBubbles, images: nextImages, applied, ok: result.ok, violations: result.violations };
}

// แตกประโยคไทยแบบเดียวกับที่แอดมินอ่าน: ขึ้นบรรทัดใหม่ หรือคำลงท้ายสุภาพ = จบประโยค
// ส่วนขยายที่ขึ้นต้นด้วย "เช่น/หรือ/และ..." เป็นหางของประโยคก่อนหน้า ไม่ใช่ประโยคใหม่
// (ต้องตรงกับกติกาเดียวกันใน humanizer ไม่งั้นตัวนับกับตัวแตกบับเบิลจะเห็นคนละความจริง)
const SENTENCE_CONTINUATION = /^(?:เช่น|อย่างเช่น|ตัวอย่างเช่น|เป็นต้น|หรือ|และ|แต่|เพราะ|โดย|ซึ่ง|ทั้งนี้)/u;

function splitSentences(text) {
  const parts = String(text || "")
    .split(/\n+/u)
    .flatMap((line) => line.split(/(?<=(?:ค่ะ|นะคะ|ค่า|คะ|ครับ|นะครับ|[?？!])[\s)]*)\s+/u))
    .map((part) => part.trim())
    .filter(Boolean);
  return mergeSentenceFragments(parts);
}

// วงเล็บที่ยังเปิดค้างอยู่ = ประโยคยังไม่จบ ห้ามตัด (ป้าย "(ข้อมูลตัวอย่าง...)" ต้องอยู่ครบ)
export function mergeSentenceFragments(parts = []) {
  const merged = [];
  let openParens = 0;
  for (const part of parts) {
    const continues = merged.length && (openParens > 0 || SENTENCE_CONTINUATION.test(part));
    if (continues) merged[merged.length - 1] += ` ${part}`;
    else merged.push(part);
    openParens += (part.match(/[(（]/gu) || []).length - (part.match(/[)）]/gu) || []).length;
    if (openParens < 0) openParens = 0;
  }
  return merged;
}

// เก็บคำถามไว้ตัวสุดท้ายตัวเดียว (คำถามนำที่พาบทสนทนาต่อ) แล้วตัดคำถามก่อนหน้าทิ้ง
// คืน null เมื่อซ่อมแล้วไม่เหลือข้อความ — ให้ caller ตัดสินใจ fallback ตามเดิม
export function repairExcessQuestions(bubbles = [], { maxQuestions = 1 } = {}) {
  const list = Array.isArray(bubbles) ? bubbles : [];
  const sentencesPerBubble = list.map((bubble) => splitSentences(bubbleText(bubble)));
  // v1.4.5 (เคสจริง 2026-08-15: บันไดคัดกรองถูก join(" ") จนบรรทัดว่างหายทั้งก้อน):
  // บอลลูนที่มีโครงจัดรูป (\n\n หรือบรรทัดรายการ) ห้ามผ่าประโยค — คำว่า "ยังไง"
  // ในตัวเลือกบันไดถูกนับเป็นคำถามจน repair วิ่ง แล้ว rebuild ทำลายฟอร์แมตทั้งข้อความ
  const formattedBubble = list.map((bubble) => {
    const text = bubbleText(bubble);
    return text.includes("\n\n") || text.split("\n").length > 2;
  });
  const questionKeys = [];
  const contentBearing = new Set();
  sentencesPerBubble.forEach((sentences, bubbleIndex) => {
    sentences.forEach((sentence, sentenceIndex) => {
      if (countQuestions(sentence) === 0) return;
      const key = `${bubbleIndex}:${sentenceIndex}`;
      questionKeys.push(key);
      if (formattedBubble[bubbleIndex]) {
        // คำถามในบอลลูน formatted คือส่วนหนึ่งของโครง (เช่น คำถามคัดกรองเหนือบันได)
        contentBearing.add(key);
        return;
      }
      // v1.2.5: ตัดคำถามออกแล้วยังเหลือเนื้อความ = ประโยคนี้มีคำตอบของลูกค้าอยู่ ห้ามลบ
      // (เคยลบทิ้งจนลูกค้าได้แต่คำถามลอย ๆ กลับไป โดยคำตอบหายหมด)
      const stripped = sentence
        .replace(URL_PATTERN, " ")
        .replace(YES_NO_QUESTION, " ")
        .replace(QUESTION_WORD_CLAUSE, " ")
        .replace(/[?？]/gu, " ")
        .replace(/(?:ค่ะ|คะ|ครับ|นะคะ|นะครับ)/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      if ([...stripped].length >= 12) contentBearing.add(key);
    });
  });
  if (questionKeys.length <= maxQuestions) return null;

  // ลบได้เฉพาะ "ประโยคคำถามล้วน" และลบตัวเก่าก่อนเสมอ (คำถามนำตัวท้ายคือตัวที่พาคุยต่อ)
  const removable = questionKeys.filter((key) => !contentBearing.has(key));
  const removeCount = Math.min(removable.length, questionKeys.length - maxQuestions);
  if (removeCount <= 0) return null;
  const drop = new Set(removable.slice(0, removeCount));

  const repaired = [];
  sentencesPerBubble.forEach((sentences, bubbleIndex) => {
    const kept = sentences.filter((_, sentenceIndex) => !drop.has(`${bubbleIndex}:${sentenceIndex}`));
    if (!kept.length) return;
    const source = list[bubbleIndex];
    // v1.4.5: บอลลูนที่ไม่โดนตัดประโยคใดเลย ต้องคงข้อความต้นฉบับทั้งก้อน —
    // เดิม rebuild ทุกบอลลูนด้วย join(" ") ทำให้บรรทัดว่าง/บรรทัดรายการหายเงียบ ๆ
    // แม้บอลลูนนั้นไม่เกี่ยวกับคำถามเกินเลย
    const text = kept.length === sentences.length
      ? bubbleText(source)
      : kept.join(" ").replace(/\s{2,}/gu, " ").trim();
    repaired.push(typeof source === "object" && source !== null ? { ...source, text } : text);
  });
  return repaired.length ? repaired : null;
}

function bubbleText(bubble) {
  return typeof bubble === "string" ? bubble : String(bubble?.text || "");
}

function terminalException(policy, { route = "", intent = "", reason = "" } = {}) {
  return policy.terminalRoutes.includes(String(route)) ||
    policy.terminalIntents.includes(String(intent)) ||
    policy.terminalReasons.includes(String(reason));
}

// Return every failed rule to make logging/correction review deterministic.
// `bubbles` accepts humanizer outputs ({ text, pauseSec }) or plain strings.
export function assessReplyDelivery({ policy = DISABLED_REPLY_DELIVERY_POLICY, bubbles = [], images = [], route = "", intent = "", reason = "" } = {}) {
  if (!policy?.enabled) return { ok: true, disabled: true, violations: [], terminalException: false };
  const textBubbles = Array.isArray(bubbles) ? bubbles.map(bubbleText).filter(Boolean) : [];
  const imageList = Array.isArray(images) ? images : [];
  const questionCount = textBubbles.reduce((count, text) => count + countQuestions(text), 0);
  const finalText = textBubbles.at(-1) || "";
  const isTerminal = terminalException(policy, { route, intent, reason });
  const violations = [];

  if (imageList.length > policy.maxImages) violations.push("max_images_exceeded");
  if (textBubbles.length > policy.maxTextBubbles) violations.push("max_text_bubbles_exceeded");
  if (questionCount > policy.maxQuestions) violations.push("max_questions_exceeded");
  if (imageList.length && policy.requireExactlyOneFinalQuestionWhenImages && !isTerminal) {
    if (questionCount !== 1) violations.push("image_reply_requires_exactly_one_question");
    if (!bubbleEndsWithQuestion(finalText)) violations.push("image_reply_requires_final_question");
  }
  return {
    ok: violations.length === 0,
    disabled: false,
    violations,
    terminalException: isTerminal,
    questionCount,
    textBubbleCount: textBubbles.length,
    imageCount: imageList.length,
  };
}
