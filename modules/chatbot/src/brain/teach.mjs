// brain/teach.mjs — ตรรกะ deterministic ของวงจรสอน (แบบแปลน §6 Step 1–2)
//
// ไฟล์นี้ไม่เรียกโมเดลและไม่เขียนอะไรเลย มันตอบสามคำถามให้จอสอน:
//   1. "เรื่องที่กำลังสอนเป็นการ์ดชนิดไหน และสีอะไร" (ชิปก่อน แล้ว RISK_RULES ทีหลัง)
//   2. "การ์ดใบไหนที่น่าจะเกี่ยว" — จับคำ ไม่ใช่หลักฐานว่าโมเดลใช้ใบไหน (พูดตรง ๆ บนจอ)
//   3. "อะไรที่เก็บลง teach_json ได้บ้าง" — ทุกอย่างที่ไม่อยู่ในทะเบียนนี้ถูกทิ้ง
//
// PDPA (แบบแปลน §5 ข้อ 3 และ §12): teach_json เก็บได้แค่ "ตัวชี้" (id ของคำแก้/ข้อความ/
// การ์ด + hash ของลูกค้า) กับข้อความที่ "คนของเราพิมพ์เอง" (correct_text) ซึ่งถูกล้างตอน
// เผยแพร่ ข้อความของลูกค้าห้ามคัดลอกลงมาแม้แต่ประโยคเดียว — ไม่มีช่องให้มันในทะเบียนนี้
import { learningRiskFlags } from "../learningDigest.mjs";
import { teachCustomerHash } from "./teachIdentity.mjs";
import { normalizeThai } from "./text.mjs";

export const TEACH_CORRECT_TEXT_MAX = 2000;
const REF_MAX = 80;
const REF_SAFE = /^[A-Za-z0-9_:.@+-]{1,80}$/u;
const CHIP_MAX = 4;

/**
 * ชิปเหตุผลของ Step 1 (แบบแปลน §6) — `kind` คือชนิดการ์ดที่ชิปนั้นแปลว่าอะไร
 * `writable: false` = เฟสนี้ยังเขียนชนิดนี้จากจอสอนไม่ได้ (ยังเป็นไฟล์/โค้ด หรือรอ P4)
 * จอต้องบอกเหตุผลตรง ๆ ไม่ใช่ซ่อนปุ่มเฉย ๆ แล้วให้คนเดาว่าทำไมสอนไม่ได้
 */
export const TEACH_REASON_CHIPS = Object.freeze([
  { id: "wrong_fact", label: "ข้อมูลผิด", kind: "fact", writable: true },
  { id: "incomplete", label: "ตอบไม่ครบ", kind: "fact", writable: true },
  { id: "wrong_price", label: "ราคาผิด", kind: "price", writable: true },
  {
    id: "should_not_say", label: "ไม่ควรพูดเรื่องนี้", kind: "policy", writable: false,
    why: "กติกาของธุรกิจยังอยู่ในหน้าตั้งค่า (กติกาสินค้า) — แก้ที่นั่นแล้วมันจะเป็นรุ่นสมองเอง",
  },
  {
    id: "wrong_tone", label: "น้ำเสียงไม่ใช่", kind: "persona_section", writable: false,
    why: "น้ำเสียงยังอยู่ในไฟล์ persona ของระบบ ไม่ใช่การ์ดในเฟสนี้",
  },
  {
    id: "should_handoff", label: "ควรส่งต่อคน", kind: "route_label", writable: false,
    why: "การติดป้ายเส้นทางเป็นงานของคลังตัวอย่าง (golden turns) ซึ่งยังไม่เปิดในเฟสนี้",
  },
  {
    id: "should_not_handoff", label: "ไม่ควรส่งต่อคน", kind: "route_label", writable: false,
    why: "การติดป้ายเส้นทางเป็นงานของคลังตัวอย่าง (golden turns) ซึ่งยังไม่เปิดในเฟสนี้",
  },
  {
    id: "should_send_image", label: "ควรส่งรูป", kind: "media", writable: false,
    why: "คลังรูปยังเป็นไฟล์ image-catalog.json ไม่ใช่การ์ดในเฟสนี้",
  },
]);

const CHIP_BY_ID = new Map(TEACH_REASON_CHIPS.map((chip) => [chip.id, chip]));

// ชนิดที่จอสอนเขียนได้จริงในเฟสนี้ = ชนิดที่มีทางเขียนของคอนโซลรองรับอยู่แล้ว
export const TEACH_WRITABLE_KINDS = Object.freeze(["fact", "price"]);

// สีความเสี่ยงต่อชนิด (แบบแปลน §5 ตารางชนิดการ์ด)
const KIND_RISK = Object.freeze({
  fact: "green", price: "red", schedule: "red", product: "red",
  policy: "yellow", persona_section: "yellow", media: "green", route_label: "yellow",
});

const RISK_ORDER = Object.freeze(["green", "yellow", "red"]);
const RISK_LABEL = Object.freeze({ green: "เขียว", yellow: "เหลือง", red: "แดง" });

// คำที่ทำให้เรื่องถูกยกระดับ — โชว์บนจอว่า "คำว่า X ทำให้เรื่องนี้ต้องให้พี่ง้วงอนุมัติ"
const ESCALATION_WORDS = Object.freeze({
  money: /(?:฿|บาท|ราคา|ยอด|มัดจำ|ชำระ|โอน)/giu,
  promotion_or_terms: /(?:%|เปอร์เซ็นต์|ส่วนลด|โปรโมชั่น|ผ่อน|ดอกเบี้ย|ค่าธรรมเนียม)/giu,
  policy_or_promise: /(?:นโยบาย|คืนเงิน|เลื่อนคลาส|ยกเลิก|รับประกัน|การันตี|สัญญา|ตลอดชีพ)/giu,
  schedule_or_capacity: /(?:ที่นั่ง|รอบเรียน|วันเรียน|กำหนด|deadline)/giu,
});

const RISK_TO_KIND = Object.freeze({
  money: "price", promotion_or_terms: "price",
  schedule_or_capacity: "schedule", policy_or_promise: "policy",
});

/**
 * Step 2: จัดชนิดตามชิปก่อน regex ทีหลัง (แบบแปลน §6)
 *
 * @param {{chips?: string[], correctText?: string, title?: string}} input
 * @returns {{kind: string, risk: string, riskLabel: string, blocked: boolean, blockReason: string,
 *            writable: boolean, notWritableWhy: string, flags: string[], escalatedBy: {flag: string, word: string}[],
 *            chipKind: string|null, splitHint: string}}
 */
export function classifyTeachProposal({ chips = [], correctText = "", title = "" } = {}) {
  const picked = validChips(chips);
  const chipKind = picked.map((id) => CHIP_BY_ID.get(id)?.kind).find(Boolean) ?? null;
  const text = normalizeThai(`${title}\n${correctText}`);
  const flags = learningRiskFlags(text);

  // ข้อมูลส่วนบุคคลของลูกค้าห้ามกลายเป็นความรู้ของธุรกิจไม่ว่าชิปจะบอกว่าอะไร (L15 กันซ้ำอีกชั้น)
  if (flags.includes("personal_or_financial_data")) {
    return {
      kind: chipKind ?? "fact", risk: "red", riskLabel: RISK_LABEL.red,
      blocked: true,
      blockReason: "ข้อความนี้มีข้อมูลที่อาจระบุตัวบุคคล (เบอร์ อีเมล เลขบัญชี ที่อยู่) —"
        + " ความรู้ของธุรกิจเก็บข้อมูลส่วนตัวของลูกค้าไม่ได้ ลบส่วนนั้นออกก่อนค่ะ",
      writable: false, notWritableWhy: "", flags, escalatedBy: [], chipKind, splitHint: "",
    };
  }

  // regex ยกระดับได้ แต่ลดระดับไม่ได้: ชิป "ราคาผิด" ที่ข้อความไม่มีตัวเลข ยังเป็นราคาอยู่ดี
  const regexKind = flags.map((flag) => RISK_TO_KIND[flag]).find(Boolean) ?? null;
  const kind = higherRiskKind(chipKind ?? regexKind ?? "fact", regexKind ?? "fact");
  const chip = CHIP_BY_ID.get(picked[0] ?? "") ?? null;
  const writable = TEACH_WRITABLE_KINDS.includes(kind) && (chip ? chip.writable !== false : true);
  return {
    kind,
    risk: KIND_RISK[kind] ?? "yellow",
    riskLabel: RISK_LABEL[KIND_RISK[kind] ?? "yellow"],
    blocked: false,
    blockReason: "",
    writable,
    notWritableWhy: writable ? "" : (chip?.why || notWritableWhy(kind)),
    flags,
    escalatedBy: escalationWords(text, flags),
    chipKind,
    // ชิปกับ regex ไม่ตรงกัน = ของสองชิ้นปนกันอยู่ในข้อความเดียว ต้องบอกให้แยก ไม่ใช่เดาให้
    splitHint: chipKind && regexKind && chipKind !== regexKind
      ? `ชิปที่เลือกบอกว่าเป็น "${kindLabel(chipKind)}" แต่ข้อความมีเนื้อของ "${kindLabel(regexKind)}" ด้วย`
        + " — แยกเป็นสองใบจะปลอดภัยกว่า"
      : "",
  };
}

export function kindLabel(kind) {
  return {
    fact: "ข้อเท็จจริง", price: "ราคา", schedule: "รอบเรียน", product: "สินค้า",
    policy: "กติกา", persona_section: "น้ำเสียง", media: "รูป", route_label: "ป้ายเส้นทาง",
  }[kind] ?? kind;
}

function notWritableWhy(kind) {
  return `เฟสนี้ยังสอนการ์ดชนิด "${kindLabel(kind)}" จากจอนี้ไม่ได้ — แก้ที่หน้าตั้งค่าของเรื่องนั้นแทน`;
}

function higherRiskKind(a, b) {
  const rank = (kind) => RISK_ORDER.indexOf(KIND_RISK[kind] ?? "yellow");
  return rank(b) > rank(a) ? b : a;
}

function escalationWords(text, flags) {
  const out = [];
  for (const flag of flags) {
    const pattern = ESCALATION_WORDS[flag];
    if (!pattern) continue;
    const hit = String(text).match(pattern)?.[0];
    if (hit) out.push({ flag, word: hit });
  }
  return out;
}

export function validChips(chips = []) {
  const seen = new Set();
  for (const raw of Array.isArray(chips) ? chips : []) {
    const id = String(raw || "");
    if (CHIP_BY_ID.has(id)) seen.add(id);
    if (seen.size >= CHIP_MAX) break;
  }
  return [...seen];
}

/* ----------------------------- ด่านความเป็นส่วนตัว ----------------------------- */

// ชื่อที่สั้นเกินไปจับแล้วฟ้องมั่ว ("เอ" อยู่ในคำไทยเกือบทุกคำ) — ต่ำกว่านี้ไม่ตรวจ
const CUSTOMER_NAME_MIN = 3;

/**
 * ด่านฝั่งเซิร์ฟเวอร์ของจอสอน — คืนข้อความปฏิเสธเป็นภาษาไทย หรือ "" เมื่อผ่าน
 *
 * ทำไมต้องอยู่ฝั่งนี้: ตัวจัดชนิดที่ /teach/plan เป็น **คำแนะนำบนหน้าจอ** ไม่ใช่ด่าน
 * คนกดที่พิมพ์เสร็จแล้วกดส่งทันที (หรือใครก็ตามที่ยิง API ตรง ๆ) ข้ามมันได้ทั้งหมด
 * ด่านจริงต้องอยู่ตรงที่ของกำลังจะถูกเขียน ไม่ใช่ตรงที่หน้าจอกำลังคิด
 *
 * @param {{correctText?: string, cardText?: string, customerNames?: string[]}} input
 */
export function teachPrivacyRefusal({ correctText = "", cardText = "", customerNames = [] } = {}) {
  const text = normalizeThai(`${cardText}\n${correctText}`);
  if (learningRiskFlags(text).includes("personal_or_financial_data")) {
    return "ข้อความนี้มีข้อมูลที่อาจระบุตัวบุคคล (เบอร์ อีเมล เลขบัญชี ที่อยู่) —"
      + " ความรู้ของธุรกิจเก็บข้อมูลส่วนตัวของลูกค้าไม่ได้ ลบส่วนนั้นออกก่อนค่ะ";
  }
  // ชื่อของ "ลูกค้าห้องนี้" ไม่ใช่กฎของร้าน: คำตอบที่เขียนถึงคนคนเดียวถูกเติมมาให้ในจอสอน
  // ถ้าไม่ตรวจ ชื่อเขาจะกลายเป็นความรู้ถาวรที่ลูกค้าคนอื่นได้ยินด้วย
  const hit = customerNames
    .map((name) => normalizeThai(String(name || "")).trim())
    .filter((name) => name.length >= CUSTOMER_NAME_MIN)
    .find((name) => text.toLowerCase().includes(name.toLowerCase()));
  if (hit) {
    return `ข้อความนี้มีชื่อของลูกค้าในห้องนี้ ("${hit}") — ความรู้ของธุรกิจใช้กับลูกค้าทุกคน`
      + " ลบชื่อออกแล้วเขียนเป็นกติกากลางก่อนนะคะ";
  }
  return "";
}

/* ------------------------------- การ์ดที่น่าจะเกี่ยว ------------------------------- */

// n-gram ระดับตัวอักษร: ภาษาไทยไม่มีช่องว่างระหว่างคำ ตัวตัดคำที่เดาผิดจะสร้างรายการ
// ที่ไม่เกี่ยวเลย แล้วคนจะเลิกอ่านรายการนี้ทั้งรายการ — 4 ตัวอักษรจับ "ที่จอดรถ" ได้โดยไม่ต้องตัดคำ
const GRAM_SIZE = 4;
const RELATED_MAX = 5;
// ต่ำกว่านี้ = "ระบบหาไม่เจอ" ไม่ใช่ "ไม่มี" — ยังแสดงให้ดู แต่ต้องติดป้ายว่าอ่อน
export const RELATED_WEAK_SCORE = 0.08;

function gramsOf(text) {
  const value = normalizeThai(String(text || "")).toLowerCase().replace(/\s+/gu, " ").trim();
  const out = new Set();
  for (let i = 0; i + GRAM_SIZE <= value.length; i += 1) out.add(value.slice(i, i + GRAM_SIZE));
  return out;
}

// containment ไม่ใช่ Jaccard: การ์ดยาว ๆ กับประโยคสั้น ๆ ที่พูดเรื่องเดียวกัน ต้องได้คะแนนสูง
// (Jaccard จะลงโทษความยาวที่ต่างกันมาก ซึ่งเป็นรูปปกติของ "ประโยคหนึ่งเทียบกับการ์ดทั้งใบ")
function containment(a, b) {
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  if (!small.size) return 0;
  let hits = 0;
  for (const gram of small) if (large.has(gram)) hits += 1;
  return hits / small.size;
}

/**
 * การ์ดที่ "น่าจะเกี่ยว" — **ไม่ใช่หลักฐาน** ว่าโมเดลใช้ใบไหน
 * (แบบแปลน §6 Step 0: โหมดปักหมุดทั้งหมด ระบบไม่รู้ว่าโมเดล "ใช้" การ์ดไหน)
 *
 * คืนสามใบบนสุดเสมอแม้คะแนนต่ำ พร้อมธง `weak` — จอต้องพูดว่า "ระบบหาไม่เจอ"
 * ไม่ใช่ "ไม่มีการ์ดที่พูดเรื่องเดียวกัน" ซึ่งเป็นคำยืนยันที่ตัวจับคำพิสูจน์ไม่ได้
 *
 * @param {{title: string, content: string, id: string}[]} entries
 * @param {string} text
 */
export function relatedKnowledge(entries = [], text = "") {
  const needle = gramsOf(text);
  if (!needle.size) return [];
  const scored = [];
  for (const entry of entries) {
    const title = String(entry?.title || "");
    const content = String(entry?.content || "");
    const score = Math.max(
      containment(needle, gramsOf(`${title} ${content}`)),
      // ชื่อการ์ดอย่างเดียวได้น้ำหนักของตัวเอง: ชื่อสั้นและตรงประเด็นกว่าเนื้อทั้งใบเสมอ
      containment(needle, gramsOf(title)),
    );
    if (score <= 0) continue;
    scored.push({
      id: String(entry.id), title, score: Number(score.toFixed(4)),
      weak: score < RELATED_WEAK_SCORE,
      // เนื้อเดิมต้องมากับผลลัพธ์ ไม่งั้นจอสอนจะให้คนกด "แก้ใบนี้" โดยไม่เห็นว่าจะทับอะไร
      content, chars: content.length,
      excerpt: excerptAround(content, ""),
    });
  }
  return scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, RELATED_MAX);
}

const EXCERPT_RADIUS = 60;

export function excerptAround(content, needle) {
  const text = String(content || "").replace(/\s+/gu, " ").trim();
  if (!needle) return text.slice(0, EXCERPT_RADIUS * 2);
  const at = text.toLowerCase().indexOf(String(needle).toLowerCase());
  if (at < 0) return text.slice(0, EXCERPT_RADIUS * 2);
  const start = Math.max(0, at - EXCERPT_RADIUS);
  return `${start > 0 ? "…" : ""}${text.slice(start, at + EXCERPT_RADIUS)}${text.length > at + EXCERPT_RADIUS ? "…" : ""}`;
}

// ชื่อรายการราคาที่ "ต่างกันแค่รูป" คือชื่อเดียวกัน — ตารางราคาต้องไม่มีสองแถวที่ตัวกรอง
// มองว่าเป็นคนละราคาแต่คนอ่านว่าเป็นอันเดียวกัน
export function normalizedPriceLabel(label) {
  return normalizeThai(String(label || "")).toLowerCase().replace(/\s+/gu, " ").trim();
}

/* --------------------------------- teach_json --------------------------------- */

export const TEACH_SOURCES = Object.freeze([
  "correction", "guard_block", "learning", "redaction", "lint", "chat", "console",
]);

/**
 * ทะเบียนฟิลด์ของ teach_json — อะไรที่ไม่อยู่ในนี้ ถูกทิ้งทั้งหมด
 *
 * `customerHash` ถูกคำนวณฝั่งเซิร์ฟเวอร์เท่านั้น (`teachCustomerHash`) — ห้ามรับจากหน้าเว็บ
 * เพราะค่าที่รับมาไม่มีทางพิสูจน์ว่าเป็น hash จริงหรือ id ดิบที่ถูกส่งมาตรง ๆ
 */
export function sanitizeTeachContext(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const source = TEACH_SOURCES.includes(String(raw.source)) ? String(raw.source) : "console";
  const out = { source };
  // รับได้ทั้งชื่อจากหน้าเว็บ (camelCase) และชื่อที่เก็บจริง (snake_case) — ตัวเดียวกันต้อง
  // ผ่านทะเบียนนี้ได้สองรอบโดยไม่หายไป (ตัว hook กรองซ้ำอีกครั้งก่อนเขียนลงรุ่นเสมอ)
  for (const [key, field] of [["correctionRef", "correction_ref"], ["messageRef", "message_ref"],
    ["learningRef", "learning_ref"], ["cardRef", "card_ref"]]) {
    const value = String(raw[key] ?? raw[field] ?? "").slice(0, REF_MAX);
    if (value && REF_SAFE.test(value)) out[field] = value;
  }
  // customer_hash ผ่านได้เฉพาะรูปที่ teachCustomerHash ผลิต (32 ตัวอักษร hex ตัวเล็ก) —
  // id ดิบของ LINE ขึ้นต้นด้วย U ตัวใหญ่และยาว 33 ตัว จึงไม่มีวันผ่านด่านรูปแบบนี้
  if (/^[0-9a-f]{32}$/u.test(String(raw.customer_hash ?? ""))) out.customer_hash = String(raw.customer_hash);
  const chips = validChips(raw.reasonChips ?? raw.reason_chips);
  if (chips.length) out.reason_chips = chips;
  const correctText = String(raw.correctText ?? raw.correct_text ?? "").slice(0, TEACH_CORRECT_TEXT_MAX);
  if (correctText.trim()) out.correct_text = correctText;
  if (typeof raw.risk === "string" && RISK_ORDER.includes(raw.risk)) out.risk = raw.risk;
  return out;
}

export { teachCustomerHash, stripTeachIdentity } from "./teachIdentity.mjs";

/**
 * ล้างข้อความที่คนพิมพ์ออกจาก teach_json ตอนเผยแพร่ เหลือแค่ตัวชี้การ์ด
 * (แบบแปลน §5 PDPA ข้อ 3) — คืน object ใหม่เสมอ ไม่แก้ของเดิม
 */
export function teachJsonAfterPublish(teach = {}, { cardRefs = [] } = {}) {
  const source = teach && typeof teach === "object" ? teach : {};
  const next = { ...source };
  delete next.correct_text;
  const refs = [...(Array.isArray(cardRefs) ? cardRefs : [])]
    .map((ref) => String(ref).slice(0, REF_MAX))
    .filter((ref) => REF_SAFE.test(ref));
  if (refs.length) next.card_ref = refs.length === 1 ? refs[0] : refs;
  else if (Array.isArray(source.touched) && source.touched.length) next.card_ref = source.touched[0];
  next.correct_text_cleared = true;
  return next;
}
