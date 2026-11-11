// ownerLessons.mjs — "สอนลูกแพรจากแผง 'ทำไมตอบแบบนี้'" (คำสั่งพี่ง้วง 2026-09-28)
//
// คำขอเจ้าของ: สอนได้ตรงใต้ฟองของลูกแพรเลย กดบันทึกแล้วลูกแพรเอาไปใช้กับเรื่องคล้ายกัน
// ตั้งแต่ข้อความถัดไป ไม่ต้องเดินไปหน้าตั้งค่า — แบบเดียวกับ "สอนน้องเก้า"
// (work/nongkao/cloud/lib/lessons.mjs) ที่พี่ง้วงใช้แล้วชอบ
//
// บทเรียน ≠ การ์ดความรู้: การ์ดคือ "ข้อเท็จจริง" ที่ผ่านบันไดเผยแพร่/รุ่นสมอง (teach.mjs)
// บทเรียนคือ "วิธีตอบ" — น้ำเสียง ลำดับการพูด สิ่งที่ถามกลับ สิ่งที่ไม่ควรพูด ไฟล์นี้จึงไม่แตะ
// ตัวคอมไพล์สมองเลย (parity ของสมองเงาต้องตรงเหมือนเดิม) บทเรียนเดินทางเป็นหัวข้อต่อท้าย
// กติกาของเทิร์นนั้น ๆ เท่านั้น
//
// สัญญาที่ห้ามพัง:
//   1. ไม่มีบทเรียนที่ใช้อยู่ (หรือกดหยุดไว้) = พรอมต์เหมือนเดิมทุกไบต์ — applyOwnerLessons ไม่แตะอะไรเลย
//   2. บทเรียนอยู่ "ใต้" กติกาเรื่องราคา/เงิน/การชำระเงิน/การส่งต่อคน/ความปลอดภัย และข้อมูลที่อนุมัติ
//      แต่อยู่ "เหนือ" กติกาการเขียนทั่วไป — หัวข้อพูดลำดับนี้ออกมาตรง ๆ ทุกครั้ง
//   3. บรรทัดที่โค้ดเขียนเองและเอ่ยถึงเงิน ประกาศข้างผ่าน priceRule("neutral") ทุกบรรทัด
//      ส่วนบรรทัดที่เป็นคำของคน (คำสอน/คำลูกค้า/คำตอบเดิม) คืนออกไปเป็น dataLines ให้ด่าน
//      กันคำสั่งสวนกันยกเว้นแบบเจาะจงบรรทัด เหมือนโน้ตทีมงาน (test/price-directive-contradiction)
//   4. อะไรพังในไฟล์นี้ = ตอบต่อโดยไม่มีบทเรียน ห้ามลากเส้นตอบลูกค้าล้ม
//
// ขอบเขตที่ต้องรู้ (รีวิว 2026-09-28): "ตัวเลข" ที่บทเรียนพูดยังโดนด่านราคาหลังโมเดล (complianceGuard)
// เหมือนทุกคำตอบ แต่ "จังหวะ" (เช่นบทเรียนที่สอนให้ข้ามคำถามคัดกรอง) กันได้ด้วยลำดับชั้นในพรอมต์เท่านั้น
// — เหมือนกติกาจังหวะราคาเดิมทั้งชุด จึงจงใจไม่ตัดบทเรียนเรื่องราคาทิ้ง (บทเรียนเรื่องวิธีคุยเรื่องราคา
// คือของที่เจ้าของอยากสอนที่สุด) ถ้าจะยืนยันกับโมเดลจริง ให้ทำ eval เทิร์นคัดกรองที่มีบทเรียนสวนทาง
import { PRICE_MENTION, priceRule } from "./priceDirectives.mjs";
import { truncateCodePoints } from "./unicodeText.mjs";
import { normalizeThai } from "./brain/text.mjs";

// ปุ่ม "หยุดใช้บทเรียนชั่วคราว" ของเจ้าของ (หน้า #/lessons) — ทางถอยที่ไม่ต้องลบอะไร
export const OWNER_LESSONS_PAUSED_KEY = "owner_lessons_paused";

export const OWNER_LESSON_LIMITS = Object.freeze({
  // เก็บ: คำสอนยาวได้เท่าที่ส่งเข้าพรอมต์จริง — เก็บยาวกว่าที่ใช้ = ท่อนท้ายหายเงียบ ๆ
  teaching: 600, topic: 60, minTeaching: 3, customer: 600, ai: 1000,
  // เข้าพรอมต์: บริบทสั้นพอให้รู้ว่า "สถานการณ์แบบไหน" ไม่ใช่ทั้งแชทของคนอื่น
  promptCustomer: 160, promptAi: 200, fallbackTitle: 40,
  // ต่อเทิร์น: เรื่องที่ใกล้ที่สุด 3 + เรื่องล่าสุดอีก 1 (ถ้ายังไม่ถูกเลือก) ภายใต้งบตัวอักษรเดียว
  relevant: 3, newest: 1, budget: 1800,
  // เพดานกันห้องที่สอนไว้เยอะมาก — ตัวเลือกดูแค่บทเรียนที่ใช้อยู่ล่าสุดเท่านี้ต่อเทิร์น
  consider: 300, maxRows: 1000,
});

/* -------------------------------- ข้อความ -------------------------------- */

// ยุบทุก whitespace เป็นช่องเดียว = หนึ่งช่องข้อมูลกลายเป็นหนึ่งบรรทัดในพรอมต์เสมอ
// (ด่านกันคำสั่งสวนกันยกเว้นแบบรายบรรทัด — คำสอนที่แอบขึ้นบรรทัดใหม่จะหลุดการยกเว้น)
export function oneLine(value, max) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  const chars = [...text];
  return chars.length <= max ? text : `${truncateCodePoints(text, Math.max(1, max - 1))}…`;
}

// คงการขึ้นบรรทัดที่คนสอนตั้งใจไว้ (หน้าเว็บแสดงตามนั้น) แต่ตัดช่องว่างเกิน/ตัวอักษรเกินเพดาน
export function cleanLessonText(value, max) {
  const text = String(value ?? "").replace(/\r\n?/gu, "\n").replace(/[^\S\n]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n").trim();
  return truncateCodePoints(text, max).trim();
}

// กุญแจกันบันทึกซ้ำ: สอนประโยคเดียวกันสองรอบ (ต่างแค่ช่องว่าง/จุดท้าย) = เรื่องเดียวกัน
export function lessonTeachingKey(teaching) {
  return normalizeThai(String(teaching ?? "")).toLowerCase().replace(/\s+/gu, " ")
    .replace(/[\s.!?…,。~]+$/u, "").trim();
}

export function lessonTitle(row) {
  return oneLine(row?.topic, OWNER_LESSON_LIMITS.topic)
    || oneLine(row?.teaching, OWNER_LESSON_LIMITS.fallbackTitle);
}

// หัวข้อที่เดาให้จากคำถามล่าสุดของลูกค้า (ผ่านการลบข้อมูลระบุตัวมาแล้วจากผู้เรียก)
// คนไทยเว้นวรรคระหว่างวลี จึงหยิบ "วลีแรกที่เป็นคำถาม" ก่อน — ข้อความลูกค้ามักมีคำถามปนคำเล่า
// ("มีที่จอดรถไหมคะ มากันสามคน") หัวข้อควรเป็นคำถาม ไม่ใช่ทั้งประโยค
const TRAILING_PARTICLES = /(?:\s*(?:นะคะ|นะครับ|ครับผม|ครับ|ค่ะ|คะ|คับ|ค่า|จ้า|จ้ะ|นะ)|[\s?!.~…]+)+$/u;
const QUESTION_PHRASE = /(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า|เท่าไหร่|เท่าไร|ยังไง|อย่างไร|ที่ไหน|เมื่อไหร่|เมื่อไร|อะไร|กี่|\?)/u;
export function suggestLessonTopic(customerTurns = []) {
  for (const turn of [...customerTurns].reverse()) {
    const phrases = oneLine(turn, 400).replace(/\[[^\]]*\]/gu, " ").split(/\s+/u).filter(Boolean);
    const picked = phrases.find((phrase) => QUESTION_PHRASE.test(phrase)) ?? phrases.join(" ");
    const text = picked.replace(TRAILING_PARTICLES, "").trim();
    if (text) return shortTopic(text, 40);
  }
  return "";
}

function shortTopic(text, max) {
  if ([...text].length <= max) return text;
  let out = "";
  for (const part of SEGMENTER.segment(text)) {
    if ([...out].length + [...part.segment].length > max) break;
    out += part.segment;
  }
  return out.trim() || truncateCodePoints(text, max);
}

/* ------------------------------ ความเป็นส่วนตัว ------------------------------ */

// คำสอนถูกส่งเข้าพรอมต์ของลูกค้าทุกคน — ข้อมูลที่ระบุตัวคนต้องไม่เข้ามาตั้งแต่ตอนบันทึก
// ตรวจ "ค่า" ไม่ใช่ "คำ": สอนว่า "ถ้าลูกค้าขอเบอร์ ให้บอกว่าคุยในแชทนี้ได้เลย" ต้องผ่าน
// (ตัวตรวจของการ์ดความรู้กันคำว่า "เบอร์/ที่อยู่" ทั้งคำ ซึ่งแรงเกินไปสำหรับบทเรียนเรื่องวิธีตอบ)
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;
const PHONE = /(?<!\d)(?:\+?66[\s-]?|0)(?:\d[\s-]?){7,8}\d(?!\d)/u;
const LONG_DIGITS = /(?<!\d)\d(?:[\s-]?\d){9,}(?!\d)/u;
const LINE_USER_ID = /\bU[0-9a-f]{32}\b/u;
const CUSTOMER_NAME_MIN = 3;

export function lessonPrivacyRefusal(text, customerNames = []) {
  const value = normalizeThai(String(text ?? ""));
  if (EMAIL.test(value) || PHONE.test(value) || LONG_DIGITS.test(value) || LINE_USER_ID.test(value)) {
    return "บทเรียนมีเบอร์ อีเมล หรือเลขยาว ๆ (เช่นเลขบัญชี) — บทเรียนใช้กับลูกค้าทุกคน จึงเก็บข้อมูลแบบนี้ไม่ได้"
      + " ถ้าเป็นข้อมูลติดต่อหรือการชำระเงินของร้าน ให้แก้ที่คลังความรู้แทนนะคะ";
  }
  const lower = value.toLowerCase();
  const hit = customerNames
    .map((name) => normalizeThai(String(name || "")).trim())
    .filter((name) => [...name].length >= CUSTOMER_NAME_MIN)
    .find((name) => lower.includes(name.toLowerCase()));
  if (hit) {
    return `บทเรียนมีชื่อลูกค้าห้องนี้ ("${hit}") — บทเรียนใช้กับลูกค้าทุกคน ลบชื่อออกแล้วเขียนเป็นวิธีตอบกลาง ๆ ก่อนนะคะ`;
  }
  return "";
}

/* ------------------------------- เลือกบทเรียน ------------------------------- */

// จับคำภาษาไทยแบบน้องเก้า: ตัดคำด้วย Intl.Segmenter แล้วทิ้งคำเล็ก/คำลงท้ายที่ไม่บอกเรื่อง
const SEGMENTER = new Intl.Segmenter("th", { granularity: "word" });
const IGNORED = new Set([
  "ครับ", "ค่ะ", "คะ", "คับ", "ค่า", "จ้า", "จ้ะ", "นะ", "แล้ว", "การ", "ความ", "ของ", "ที่", "ได้", "เป็น",
  "มี", "และ", "ให้", "ใน", "ไป", "มา", "กับ", "จะ", "ว่า", "ไหม", "มั้ย", "หน่อย", "เลย", "ด้วย", "หรือ",
  "อยู่", "ไม่", "ก็", "นี้", "นั้น", "แบบ", "คือ", "บ้าง", "อะไร", "ยังไง", "อย่างไร", "เรา", "คุณ",
  "ผม", "ฉัน", "ดิฉัน", "หนู", "พี่", "น้อง", "ลูกค้า", "ตอบ", "ถาม", "บอก",
]);

export function lessonTerms(text) {
  const out = new Set();
  for (const part of SEGMENTER.segment(normalizeThai(String(text ?? "")).toLowerCase())) {
    if (part.isWordLike && [...part.segment].length > 1 && !IGNORED.has(part.segment)) out.add(part.segment);
  }
  return out;
}

// คำของบทเรียนหนึ่งเรื่องคำนวณครั้งเดียวต่อรุ่นของแถว ไม่ใช่ทุกเทิร์น — กุญแจคือ id (ไม่ใช่ id+เวลา)
// แถวที่ถูกแก้หรือถูกล้างคำลูกค้าตามสิทธิ์ให้ลืม (updated_at เปลี่ยน) จึงถูก "แทนที่" ทันทีที่ใช้ครั้งถัดไป
// ไม่ใช่ค้างคำชุดเก่าไว้ในหน่วยความจำคู่กับชุดใหม่
const TERMS_CACHE = new Map();
function termsOf(lesson) {
  const stamp = String(lesson.updated_at ?? "");
  const cached = TERMS_CACHE.get(lesson.id);
  if (cached?.stamp === stamp) return cached.terms;
  if (!cached && TERMS_CACHE.size >= 2000) TERMS_CACHE.clear();
  const terms = lessonTerms(`${lesson.topic || ""}\n${lesson.customer_text || ""}\n${lesson.teaching || ""}`);
  TERMS_CACHE.set(lesson.id, { stamp, terms });
  return terms;
}

const activatedAt = (lesson) => Number(lesson?.decided_at ?? lesson?.created_at) || 0;

/**
 * เลือกบทเรียนของเทิร์นนี้ (ฟังก์ชันบริสุทธิ์ — ไม่แตะฐานข้อมูล)
 *
 * สูตรน้องเก้า: คะแนน = จำนวนคำที่ตรงกับสิ่งที่ลูกค้าเพิ่งพูด (สามข้อความล่าสุด) หารรากของขนาด
 * บทเรียน (บทเรียนยาวไม่ได้เปรียบเพราะมีคำเยอะ) เอา 3 เรื่องที่ใกล้ที่สุด แล้วเติมเรื่องล่าสุด
 * อีก 1 ถ้ายังไม่ถูกเลือก (สิ่งที่สอนล่าสุดคือวิธีที่ร้านอยากให้พูดวันนี้ ไม่ว่าเรื่องอะไร)
 * ทั้งหมดต้องอยู่ในงบตัวอักษรเดียว — เรื่องที่ใหญ่เกินงบถูกข้าม ไม่ใช่ตัดครึ่ง
 *
 * @returns {Array<object>} แถวบทเรียนตามลำดับที่จะวางในพรอมต์
 */
export function pickOwnerLessons(lessons = [], { text = "", history = [], limits = OWNER_LESSON_LIMITS } = {}) {
  const usable = (Array.isArray(lessons) ? lessons : [])
    .filter((lesson) => lesson?.status === "active" && String(lesson.teaching || "").trim());
  if (!usable.length) return [];
  const saidText = [
    ...(Array.isArray(history) ? history : []).filter((turn) => turn?.role === "user").slice(-2)
      .map((turn) => String(turn.content ?? turn.text ?? "")),
    String(text ?? ""),
  ].join("\n");
  const said = lessonTerms(saidText);
  const relevant = said.size
    ? usable.map((lesson) => {
      const words = termsOf(lesson);
      let hits = 0;
      for (const word of said) if (words.has(word)) hits += 1;
      return { lesson, score: hits / Math.sqrt(Math.max(4, words.size)) };
    }).filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || activatedAt(b.lesson) - activatedAt(a.lesson))
      .slice(0, limits.relevant).map((item) => item.lesson)
    : [];
  const newest = [...usable].sort((a, b) => activatedAt(b) - activatedAt(a))
    .filter((lesson) => !relevant.some((picked) => picked.id === lesson.id))
    .slice(0, limits.newest);
  const chosen = [];
  let used = 0;
  for (const lesson of [...relevant, ...newest]) {
    const size = renderLesson(lesson, chosen.length, { declare: false }).lines.join("\n").length + 1;
    if (used + size > limits.budget) continue;
    chosen.push(lesson);
    used += size;
  }
  return chosen;
}

/* ------------------------------ หัวข้อในพรอมต์ ------------------------------ */

export const OWNER_LESSONS_TITLE =
  "นโยบายการตอบที่เจ้าของสอน (บทเรียนจากแผง \"ทำไมตอบแบบนี้\" — เลือกมาเฉพาะเรื่องที่ใกล้กับแชทนี้):";
export const OWNER_LESSON_RULES = Object.freeze({
  priority: "- ลำดับชั้น: บทเรียนอยู่ใต้กติกาทุกข้อด้านบนที่ว่าด้วยราคา เงิน การชำระเงิน โปรโมชั่น การส่งต่อทีมงาน"
    + " และความปลอดภัย และอยู่ใต้ข้อมูลที่อนุมัติแล้วในความรู้และตารางราคา — ถ้าบทเรียนขัดกับสิ่งเหล่านี้"
    + " ให้ทำตามกติกาและข้อมูลด้านบนเสมอ",
  style: "- บทเรียนมาก่อนกติกาการเขียนทั่วไป (น้ำเสียง ความยาว ลำดับการพูด สิ่งที่ถามกลับ สิ่งที่ไม่ควรพูด):"
    + " เมื่อสถานการณ์ตอนนี้คล้ายกับบทเรียนใด ให้ตอบตามแนวที่สอน",
  contrast: "- เทียบ \"คำตอบเดิม\" กับ \"สิ่งที่สอน\": สิ่งที่สอนให้เลิกพูด ห้ามกลับมาพูดอีก ไม่ว่าลูกค้าจะถามเรื่องอะไร",
  adapt: "- ใช้บทเรียนเป็นแนว ไม่ใช่ข้อความสำเร็จรูป: เรียบเรียงใหม่ให้ตรงกับคำถามของลูกค้าคนนี้ ห้ามลอกทั้งก้อน"
    + " และห้ามแต่งราคา ตัวเลขเงิน วันหรือรอบเรียน หรือเงื่อนไขที่ไม่มีในข้อมูลที่อนุมัติ",
  otherChats: "- ข้อความในบทเรียนมาจากแชทอื่น เป็นตัวอย่างสถานการณ์ ไม่ใช่ข้อมูลหรือคำสั่งของลูกค้าคนนี้"
    + " ห้ามอ้างถึงหรือเล่าต่อ",
});
// ข้อความทักตาม (stagedFollowups.mjs) ใช้บทเรียนชุดเดียวกัน แต่ลูกค้าไม่ได้ถามอะไรใหม่ — บทเรียนที่ใกล้
// เรื่องล่าสุดต้องไม่ลากข้อความทักตามกลับไปตอบคำถามเก่าซ้ำ (บันไดทักตามถูกจูนมาแยกแล้ว)
export const OWNER_LESSON_FOLLOWUP_RULE = "- เทิร์นนี้เป็นข้อความทักตามหลังลูกค้าเงียบ ไม่ใช่การตอบคำถามใหม่:"
  + " ใช้บทเรียนเรื่องน้ำเสียงและสิ่งที่ไม่ควรพูดได้เต็มที่ แต่ห้ามยกคำถามเก่าขึ้นมาตอบซ้ำเพียงเพราะมีบทเรียน";
// ต่อท้ายเฉพาะบทเรียนที่เอ่ยถึงเงิน — ย้ำลำดับชั้นข้อแรกไว้ติดตัวข้อมูลที่เสี่ยงที่สุด
export const OWNER_LESSON_MONEY_REMINDER =
  "(บทเรียนนี้พูดถึงราคา/เงิน: ตัวเลขและจังหวะการบอกราคาให้ยึดกติกาเรื่องราคาด้านบนและตารางราคาที่อนุมัติเท่านั้น)";

// declare=false ใช้ตอนวัดขนาดเท่านั้น — ถ้าประกาศข้างตอนวัดด้วย ด่านในเทสต์จะเห็นบรรทัดซ้ำ
function renderLesson(lesson, index, { declare = true } = {}) {
  const data = [`[บทเรียน ${index + 1} · ${lessonTitle(lesson)}]`];
  const customer = oneLine(lesson.customer_text, OWNER_LESSON_LIMITS.promptCustomer);
  const ai = oneLine(lesson.ai_text, OWNER_LESSON_LIMITS.promptAi);
  if (customer) data.push(`ลูกค้าพูดทำนองนี้: ${customer}`);
  if (ai) data.push(`คำตอบเดิม: ${ai}`);
  data.push(`สิ่งที่สอน: ${oneLine(lesson.teaching, OWNER_LESSON_LIMITS.teaching)}`);
  const lines = [...data];
  if (PRICE_MENTION.test(data.join("\n"))) {
    lines.push(declare ? priceRule("neutral", OWNER_LESSON_MONEY_REMINDER) : OWNER_LESSON_MONEY_REMINDER);
  }
  return { lines, dataLines: data };
}

/**
 * ประกอบหัวข้อบทเรียนหนึ่งก้อน — ไม่มีบทเรียน = สตริงว่าง (ผู้เรียกต้องไม่ต่ออะไรเลย)
 * @returns {{text: string, ids: string[], dataLines: string[]}}
 */
export function buildOwnerLessonsSection(lessons = [], { followup = false } = {}) {
  if (!Array.isArray(lessons) || !lessons.length) return { text: "", ids: [], dataLines: [] };
  const lines = [
    OWNER_LESSONS_TITLE,
    priceRule("neutral", OWNER_LESSON_RULES.priority),
    OWNER_LESSON_RULES.style,
    OWNER_LESSON_RULES.contrast,
    priceRule("neutral", OWNER_LESSON_RULES.adapt),
    OWNER_LESSON_RULES.otherChats,
    ...(followup ? [OWNER_LESSON_FOLLOWUP_RULE] : []),
  ];
  const dataLines = [];
  lessons.forEach((lesson, index) => {
    const rendered = renderLesson(lesson, index);
    lines.push(...rendered.lines);
    dataLines.push(...rendered.dataLines);
  });
  return { text: lines.join("\n"), ids: lessons.map((lesson) => String(lesson.id)), dataLines };
}

/* --------------------------------- runtime --------------------------------- */

export function ownerLessonsPaused(db) {
  try { return db?.getSetting?.(OWNER_LESSONS_PAUSED_KEY) === "1"; } catch { return false; }
}

/**
 * จุดเกาะเดียวใน pipeline: ต่อหัวข้อบทเรียนท้าย draftArgs.rules แล้วคืน id ที่ใช้
 * (วางหลังกติกาทุกข้อ เพราะหัวข้อพูดถึง "กติกาด้านบน" — และอยู่ในส่วนที่เปลี่ยนทุกเทิร์นของ
 * พรอมต์อยู่แล้ว จึงไม่ทำให้ cache ของส่วนคงที่ (ความรู้ + persona) แตก)
 *
 * @returns {string[]} id ของบทเรียนที่ใส่ในพรอมต์ ([] = ไม่ได้แตะ draftArgs เลย)
 */
export function applyOwnerLessons({ db, draftArgs, channelId = "default", text = "", history = [], followup = false, logger = console } = {}) {
  try {
    if (!draftArgs || typeof db?.activeOwnerLessons !== "function" || ownerLessonsPaused(db)) return [];
    const active = db.activeOwnerLessons(channelId || "default", OWNER_LESSON_LIMITS.consider);
    if (!active.length) return [];
    const section = buildOwnerLessonsSection(pickOwnerLessons(active, { text, history }), { followup });
    if (!section.text) return [];
    draftArgs.rules = draftArgs.rules ? `${draftArgs.rules}\n${section.text}` : section.text;
    return section.ids;
  } catch (err) {
    logger?.debug?.(`ownerLessons: เลือกบทเรียนไม่สำเร็จ (${err?.message || err}) — ตอบต่อโดยไม่มีบทเรียน`);
    return [];
  }
}

// ทางเกาะของข้อความทักตาม: ห่อสตริงกติกาเดิม (เส้นนั้นส่ง rules เป็นช่องเดียวใน object literal)
// แล้วฝาก id ที่ใช้ไว้ใน sink ให้ผู้เรียกจดลง metadata ตอนส่งสำเร็จ — ไม่มีบทเรียน = คืนสตริงเดิมตัวเดิม
export function withOwnerLessonRules(db, rules, { channelId = "default", history = [], sink = null, logger = console } = {}) {
  const draftArgs = { rules };
  const ids = applyOwnerLessons({ db, draftArgs, channelId, text: "", history, followup: true, logger });
  if (sink && typeof sink === "object") sink.ids = ids;
  return draftArgs.rules;
}

// metadata ของข้อความขาออก: รวมกับ brainRetrieval เดิม (ถ้ามี) เพราะ spread ทีหลังทับทั้งก้อน
// เทิร์นที่ข้อความสุดท้ายไม่ได้มาจากโมเดล (template/fallback) = ไม่จดว่าใช้บทเรียน
export function ownerLessonMetadata(ids, { deterministic = false, brainRetrieval = null } = {}) {
  if (deterministic || !Array.isArray(ids) || !ids.length) return {};
  return { metadata: { ...(brainRetrieval ? { brainRetrieval } : {}), ownerLessons: ids.map(String) } };
}

export function recordOwnerLessonUse(db, ids, { deterministic = false, logger = console } = {}) {
  if (deterministic || !Array.isArray(ids) || !ids.length) return 0;
  try {
    return db.bumpOwnerLessonUse(ids);
  } catch (err) {
    logger?.debug?.(`ownerLessons: นับการใช้บทเรียนไม่สำเร็จ (${err?.message || err})`);
    return 0;
  }
}
