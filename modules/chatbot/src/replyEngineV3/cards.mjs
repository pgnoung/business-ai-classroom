// cards.mjs — ความรู้ที่เกี่ยวข้องต่อเทิร์น ≤2 ใบ ใบละ ≤1,200 ตัวอักษร (spec v3.1 §E)
// การ์ดราคา/ส่วนลด/รีวิว/รอบเรียน/เงิน/เอกสาร/CRM ไม่เข้าพรอมต์ v3 เลย (โค้ดเติมช่องเอง หรือเป็นเลนเครื่องเดิม)
// ตัวกรองตัดทั้งข้อ (บรรทัด + บรรทัดย่อหน้าต่อท้าย) ที่เป็นคำสั่ง/ประวัติการแก้/ตัวเลขเงิน/วันที่/ส่งต่อทีม — โมเดลรุ่นใหม่ทำตามตัวอักษร
import { truncateCodePoints } from "../unicodeText.mjs";
import { ASKS_RE } from "./stage.mjs";

export const CARD_MAX_CHARS = 1200;
export const MAX_CARDS = 2;
export const BUSINESS_CONTEXT_MAX_CHARS = 7200;
const SANITIZE_LINE = /ห้าม|ล็อก|จอง(?:สิทธิ์|ที่นั่ง|ไว้|รอบ)|สำรอง(?:ที่|สิทธิ์)|ผ่อน|บัตรเครดิต|0%|ใบเสนอราคา|มัดจำ|ติดต่อกลับ|ยืนยันกลับ|แจ้งกลับ|ส่งเรื่องให้ทีม|เดี๋ยว(?:ลูกแพร|แพร|ทีม)|ดีที่สุด|อันดับ|การันตี|เคยเสียเงิน|ข้อมูลเดิม|ความผิดพลาด|แก้แล้ว|ส่งต่อทีม|ให้ทีมงาน|ทีม(?:งาน)?จะ|ฟอร์ม|พี่ง้วง(?:เคาะ|ยืนยัน|กำหนด|แก้)|คู่มือชมพู่|\d{4}-\d{2}-\d{2}|[\d,]{4,}\s*บาท|\d{1,2}\s*(?:ส\.ค\.|สิงหาคม|ก\.ย\.|กันยายน|ต\.ค\.|ตุลาคม|พ\.ย\.|พฤศจิกายน|ธ\.ค\.|ธันวาคม)/u;
// ตรวจความเร็ว (รีวิวเคสจริงทั้งวัน 5 ต.ค.): เริ่มจับได้เฉพาะต้นช่วงช่องว่าง (ผลเหมือนเดิม — ช่วงช่องว่างทั้งช่วงถูกตัดไปพร้อมวงเล็บ)
const TITLE_DATE_PAREN = /(?<!\s)\s*[(（][^()（）]*\d{4}-\d{2}-\d{2}[^()（）]*[)）]/gu;
const TOOL_WORD = /chat\s*-?gpt|gemini|claude|copilot|notebooklm|codex|make\.?com|n8n|เครื่องมือ|โปรแกรม|ai ?ตัวไหน|ใช้ ?ai ?อะไร|แอปอะไร/iu;
const CANVA_ASK = /canva|capcut|ออกแบบ|แอป/iu;
const LOCATION_ASK = /ที่ไหน|สถานที่|เดินทาง|bts|รถไฟฟ้า|จอดรถ|ไปยังไง/iu;
const COMPANION_ASK = /ผู้ติดตาม|มาด้วยได้ไหม|พา.{0,10}มา/u;
const TRUST_ASK = /พี่ง้วงเป็นใคร|ใครสอน|ผู้สอน|วิทยากร|ประวัติ|ผลงาน|เชื่อถือ|สอนมากี่ปี/u;
const TRIAL_ASK = /ทดลอง|ลองเรียน|ลองก่อน|ดูก่อน|คลิปการสอน/u;
const OUTLINE_ASK = /สอนอะไร|เรียนอะไร|หัวข้อ|เนื้อหา|หลักสูตร|outline/iu;
const FIT_OR_BENEFIT_ASK = /เรียน(?:แล้ว|ไป).{0,30}(?:ช่วย|ได้อะไร)|ช่วย(?:ทำ)?งาน(?:ส่วนไหน|ด้านไหน|อะไร)|(?:งาน|ส่วนงาน)(?:ไหน|อะไร).{0,20}ช่วย|ตามทัน|ไม่เก่ง(?:เทค|ไอที|ai)|ไม่มีพื้นฐาน|มือใหม่|เริ่มจากพื้นฐาน/iu;
const ANAPHORIC_FOLLOWUP = /ถ้ามี|ถ้าอย่างนั้น|ที่(?:แจ้ง|บอก|พูด)ไว้|อันนั้น|แบบนั้น|เรื่องนั้น|ต้องเริ่ม(?:จาก)?ตรงไหน|เริ่ม(?:จาก)?ยังไง|ทำยังไง/iu;
// "เคยใช้ ChatGPT บ้างค่ะ" = เล่า ไม่ใช่ถาม — การ์ดเครื่องมือ (Codex เป็นเครื่องมือหลัก) ให้เฉพาะคนที่ถามจริง
// อะไร/ไหน กลางประโยคยังเป็นคำถาม ("ใช้ AI ตัวไหนสอน") · บ้าง นับเฉพาะท้ายคำถาม ("ใช้ ChatGPT บ้างคะ")
const WH_WORD = /อะไร|ไหน/u;
const BANG_QUESTION = /บ้าง\s*(?:คะ|ครับ|คับ|[?？])\s*$/u;
// ข้อกังวล: v3 ไม่มีช่องราคาและไม่มีข้อมูลคลาสออนไลน์ — ข้อที่สั่งให้บอกตัวเลือกถูกกว่าพร้อมราคา หรือแนะนำออนไลน์ ต้องไม่เข้าพรอมต์
// (กติกาพี่ง้วง: คลาสออนไลน์เสนอได้เมื่อลูกค้าถามเองเท่านั้น — ลูกค้าที่ถามเองไปเลนเครื่องเดิมแล้ว)
const OBJECTION_STRIP = /ตัวเลือกที่ถูกกว่า|ราคาถูกกว่า|พร้อมราคา|ทางเลือกที่เหมาะกว่า|เสนอ(?:ได้)?.{0,12}คลาสออนไลน์|คลาสออนไลน์\s*[—–-]|แนะนำคลาสออนไลน์|มีคลาสออนไลน์แบบ|ขอเรียนออนไลน์/u;
// ข้อมูลธุรกิจใน envelope เป็น source data ไม่ใช่สคริปต์สนทนา แต่ตัวเลขเงิน/วันเรียน/ขั้นชำระยังต้องมาจาก deterministic slots และเลนเดิม
const DETERMINISTIC_SOURCE_LINE = /เลขบัญชี|คิวอาร์|\bqr\b|โอน(?:เงิน)?|ชำระ(?:เงิน)?|มัดจำ|บัตรเครดิต|ใบเสนอราคา|ยืนยันยอด|ตรวจยอด|[\d,]{4,}\s*บาท|ราคา\s*\d|(?:รอบ|เรียน)\s*(?:วัน)?ที่?\s*\d{1,2}\s*(?:ส\.|สิงหาคม|ก\.|กันยายน|ต\.|ตุลาคม|พ\.|พฤศจิกายน|ธ\.|ธันวาคม)/iu;
const SCOPE_ASK = /ทำได้(?:ไหม|มั้ย)|สอน.{0,20}(?:ไหม|มั้ย)|ครอบคลุม|ขอบเขต|เชื่อม|อัตโนมัติ|automation/iu;
const OBJECTION_SECTIONS = Object.freeze({
  budget: ["[ราคาและความคุ้มค่า]", "[ลูกค้าบอกว่าเกินงบ", "[จังหวะลูกค้าบ่นแพง"],
  undecided: ["[ยังไม่พร้อมตัดสินใจ]"],
  confidence: ["[พื้นฐานและความมั่นใจ]"],
  time: ["[เวลา สถานที่ เครื่องมือ]"],
  distance: ["[เวลา สถานที่ เครื่องมือ]"],
  value: ["[ผลลัพธ์และขอบเขต]"],
});

export function cleanCardTitle(title = "") {
  return String(title).replace(TITLE_DATE_PAREN, "").trim();
}

// ข้อหนึ่งข้อ = บรรทัดที่ไม่ย่อหน้า + บรรทัดย่อหน้าที่ต่อท้าย (ข้อความยาวที่ตัดบรรทัดในการ์ดยังเป็นข้อเดียวกัน)
function itemsOf(text) {
  const items = [];
  for (const line of String(text).split("\n")) {
    const continues = /^[ \t]+\S/u.test(line) && items.length && items.at(-1).at(-1).trim();
    if (continues) items.at(-1).push(line); else items.push([line]);
  }
  return items;
}

/** ตัดทั้งข้อเมื่อบรรทัดใดบรรทัดหนึ่งในข้อนั้นเข้าตัวกรอง (extra = ตัวกรองเพิ่มของการ์ดนั้น) */
export function sanitizeCardText(text = "", extra = null) {
  const drop = (line) => SANITIZE_LINE.test(line) || Boolean(extra?.test(line));
  return itemsOf(text).filter((item) => !item.some(drop)).map((item) => item.join("\n")).join("\n")
    .replace(/\n{3,}/gu, "\n\n").trim();
}

/** เก็บนโยบายสิทธิ์/availability ตามเจ้าของ แต่กัน money/date/payment facts ที่มี deterministic source ของตัวเอง */
export function sanitizeBusinessKnowledge(text = "") {
  return itemsOf(text).filter((item) => !item.some((line) => DETERMINISTIC_SOURCE_LINE.test(line)))
    .map((item) => item.join("\n")).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

const findEntry = (entries, test) => entries.find((entry) => test.test(String(entry?.title || "")));
function comparableRevision(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}
const findCurrentEntry = (entries, test) => entries.filter((entry) => test.test(String(entry?.title || ""))).sort((a, b) =>
  comparableRevision(a?.source_created_at ?? a?.provenance?.source_created_at) - comparableRevision(b?.source_created_at ?? b?.provenance?.source_created_at)
  || comparableRevision(a?.source_rowid ?? a?.provenance?.source_rowid) - comparableRevision(b?.source_rowid ?? b?.provenance?.source_rowid)
  || comparableRevision(a?.entry_version ?? a?.provenance?.entry_version) - comparableRevision(b?.entry_version ?? b?.provenance?.entry_version)).at(-1);

// ส่วนในวงเล็บเหลี่ยมหัวบรรทัด เช่น "[ราคาและความคุ้มค่า]" จนถึงหัวข้อถัดไป
function bracketSection(content, prefix) {
  const lines = String(content).split("\n");
  const start = lines.findIndex((line) => line.startsWith(prefix));
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && /^\[/u.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function between(content, { from = null, fromHeading = null, until = null } = {}) {
  let value = String(content);
  if (from || fromHeading) {
    const lines = value.split("\n");
    const at = lines.findIndex((line) => (fromHeading ? line.trim().startsWith(fromHeading) : line.includes(from)));
    value = at < 0 ? "" : lines.slice(at).join("\n");
  }
  if (until) {
    // ตัดที่ "หัวข้อ" (บรรทัดที่ขึ้นต้นด้วยคำนั้น) ไม่ใช่คำที่บังเอิญอยู่กลางบรรทัดชื่อการ์ด
    const lines = value.split("\n");
    const at = lines.findIndex((line) => line.trim().startsWith(until));
    if (at >= 0) value = lines.slice(0, at).join("\n");
  }
  return value;
}

function card(entry, body, prefix = "", extra = null) {
  if (!entry) return null;
  const content = sanitizeCardText(body, extra);
  if (!content) return null;
  return { title: cleanCardTitle(entry.title), content: truncateCodePoints(`${prefix}${content}`, CARD_MAX_CHARS) };
}

function objectionCard(entries, decision) {
  const entry = findEntry(entries, /คลังตอบข้อโต้แย้ง/u);
  const prefixes = OBJECTION_SECTIONS[decision.reason] || OBJECTION_SECTIONS.undecided;
  return card(entry, prefixes.map((prefix) => bracketSection(entry?.content, prefix)).filter(Boolean).join("\n\n"), "", OBJECTION_STRIP);
}

// ลำดับความสำคัญตามตาราง §E — ใบแรกจากจังหวะ แล้วตามด้วยใบตามเจตนาที่ตรง
function candidates(entries, facts, decision) {
  const text = String(facts.text || "");
  // "ต้องใช้โปรแกรมอะไรบ้างคะ" ก็คือคำถาม (ASKS_RE ของจังหวะไม่มี อะไร/ไหน/บ้าง) · "เคยใช้ ChatGPT บ้างค่ะ" ไม่ใช่
  const asks = ASKS_RE.test(text) || WH_WORD.test(text) || BANG_QUESTION.test(text.trim());
  const scope = () => card(findEntry(entries, /ขอบเขตของแต่ละคลาส/u), between(findEntry(entries, /ขอบเขตของแต่ละคลาส/u)?.content, { until: "[อธิบาย Workshop" }));
  return [
    () => (decision.stage === "OBJECTION" ? objectionCard(entries, decision) : null),
    () => (decision.stage === "CONCEPT" || SCOPE_ASK.test(text) ? scope() : null),
    () => (TOOL_WORD.test(text) && asks ? card(findEntry(entries, /เครื่องมือ AI ที่ใช้สอน/u), findEntry(entries, /เครื่องมือ AI ที่ใช้สอน/u)?.content) : null),
    () => (CANVA_ASK.test(text) && asks ? card(findEntry(entries, /Canva/u), findEntry(entries, /Canva/u)?.content) : null),
    () => (LOCATION_ASK.test(text) ? card(findEntry(entries, /การเดินทาง/u), between(findEntry(entries, /การเดินทาง/u)?.content, { until: "ที่นั่งคงเหลือ" })) : null),
    () => (COMPANION_ASK.test(text) ? card(findEntry(entries, /เลื่อนวันเรียน/u), between(findEntry(entries, /เลื่อนวันเรียน/u)?.content, { fromHeading: "ผู้ติดตาม" })) : null),
    () => (TRUST_ASK.test(text) ? card(findEntry(entries, /ประวัติและความน่าเชื่อถือ/u), findEntry(entries, /ประวัติและความน่าเชื่อถือ/u)?.content) : null),
    () => (TRIAL_ASK.test(text) ? card(findEntry(entries, /ขอบเขตของแต่ละคลาส/u), between(findEntry(entries, /ขอบเขตของแต่ละคลาส/u)?.content, { from: "ลองก่อนตัดสินใจ" })) : null),
    () => (OUTLINE_ASK.test(text) && decision.stage !== "DELIVER"
      ? card(findEntry(entries, /Outline ทางการ/u), findEntry(entries, /Outline ทางการ/u)?.content, "(หยิบ 1–2 หัวข้อมาเล่า ไม่ต้องยกทั้งรายการ)\n") : null),
  ];
}

/** @returns {Array<{title: string, content: string}>} ≤2 ใบ ไม่ซ้ำชื่อ */
export function selectCards(entries = [], facts = {}, decision = {}) {
  // ปิดอย่างสุภาพ = ไม่มีข้อมูลคลาสให้หยิบมาขาย (รีวิวเคสจริงทั้งวัน 5 ต.ค.)
  if (decision.stage === "EXIT") return [];
  const list = Array.isArray(entries) ? entries : [];
  const picked = [];
  for (const make of candidates(list, facts, decision)) {
    if (picked.length >= MAX_CARDS) break;
    let next = null;
    try { next = make(); } catch { next = null; }
    if (next && !picked.some((item) => item.title === next.title && item.content === next.content)) picked.push(next);
  }
  return picked;
}

function sourceSlice(entry, body, reason) {
  if (!entry) return null;
  const content = sanitizeBusinessKnowledge(body);
  if (!content) return null;
  return { title: cleanCardTitle(entry.title), content, reason,
    id: entry.id || "", revId: entry.revId || entry.rev_id || "",
    source_created_at: entry.source_created_at ?? entry?.provenance?.source_created_at ?? null,
    source_rowid: entry.source_rowid ?? entry?.provenance?.source_rowid ?? null,
    entry_version: entry.entry_version ?? entry?.provenance?.entry_version ?? null,
    provenance: entry.provenance && typeof entry.provenance === "object" ? entry.provenance : {} };
}

function pendingCourseArtifact(content, courseKey, kind) {
  const value = String(content || "");
  if (!["business", "workflow"].includes(courseKey)) return "";
  const lines = value.split("\n");
  if (kind === "outline") {
    const business = "======== คลาสที่ 1";
    const workflow = "======== คลาสที่ 2";
    const start = lines.findIndex((line) => line.trim().startsWith(courseKey === "business" ? business : workflow));
    if (start < 0) return "";
    const end = lines.findIndex((line, index) => index > start && (courseKey === "business"
      ? line.trim().startsWith(workflow)
      : /^(?:หมายเหตุ|ห้าม(?:พูด|แก้)|วิธีส่ง)/u.test(line.trim())));
    return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
  }
  const business = "สำหรับ AI Agent for Business:";
  const workflow = "สำหรับ AI Agent Workflow Automation:";
  const start = lines.findIndex((line) => line.trim().startsWith(courseKey === "business" ? business : workflow));
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && (courseKey === "business"
    ? line.trim().startsWith(workflow)
    : /^(?:หมายเหตุ|ห้าม(?:พูด|แก้)|วิธีส่ง)/u.test(line.trim())));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
}

function businessSlices(entries, facts, decision) {
  const text = String(facts?.text || "");
  // ข้อความก่อนหน้าใช้บอกหัวข้อค้นคืนเท่านั้น ข้อเท็จจริงที่ส่งยังมาจาก approved entry ด้านล่างเสมอ
  const retrievalText = ANAPHORIC_FOLLOWUP.test(text) && facts?.lastBotText
    ? `${text}\n${String(facts.lastBotText)}` : text;
  const asks = ASKS_RE.test(text) || WH_WORD.test(text) || BANG_QUESTION.test(text.trim());
  const asksTrial = TRIAL_ASK.test(retrievalText);
  const asksFitOrBenefit = FIT_OR_BENEFIT_ASK.test(retrievalText);
  const pendingContentKey = decision.stage === "DELIVER" && decision.reason === "accepted_offer"
    && facts?.pendingOffer?.type === "content" ? facts.pendingOffer.courseKey || "" : null;
  const scopeEntry = findCurrentEntry(entries, /ขอบเขตของแต่ละคลาส/u);
  const benefitEntry = findCurrentEntry(entries, /สิ่งที่จะได้รับ/u);
  const slices = [];
  const add = (entry, body, reason) => {
    const slice = sourceSlice(entry, body, reason);
    if (slice && !slices.some((item) => item.title === slice.title && item.content === slice.content)) slices.push(slice);
  };
  if (decision.stage === "EXIT") return slices;
  if (decision.stage === "OBJECTION") {
    const entry = findCurrentEntry(entries, /คลังตอบข้อโต้แย้ง/u);
    const prefixes = OBJECTION_SECTIONS[decision.reason] || OBJECTION_SECTIONS.undecided;
    add(entry, prefixes.map((prefix) => bracketSection(entry?.content, prefix)).filter(Boolean).join("\n\n"), `objection:${decision.reason || "undecided"}`);
  }
  if (pendingContentKey !== null) {
    const outlineEntry = findCurrentEntry(entries, /Outline ทางการ/u);
    add(outlineEntry, pendingCourseArtifact(outlineEntry?.content, pendingContentKey, "outline"), `pending_content:${pendingContentKey || "unbound"}`);
    add(benefitEntry, pendingCourseArtifact(benefitEntry?.content, pendingContentKey, "benefits"), `pending_benefits:${pendingContentKey || "unbound"}`);
  }
  if (asksTrial) add(scopeEntry, between(scopeEntry?.content, { from: "ลองก่อนตัดสินใจ" }), "trial");
  if (asksFitOrBenefit) {
    add(scopeEntry, between(scopeEntry?.content, { until: "[อธิบาย Workshop" }), "fit_scope");
    add(benefitEntry, benefitEntry?.content, "benefits");
  }
  if (decision.stage === "CONCEPT" || SCOPE_ASK.test(text)) add(scopeEntry, between(scopeEntry?.content, { until: "[อธิบาย Workshop" }), "scope");
  if (TOOL_WORD.test(text) && asks) {
    const entry = findCurrentEntry(entries, /เครื่องมือ AI ที่ใช้สอน/u); add(entry, entry?.content, "tools");
  }
  if (CANVA_ASK.test(text) && asks) {
    const entry = findCurrentEntry(entries, /Canva/u); add(entry, entry?.content, "canva");
  }
  if (LOCATION_ASK.test(text)) {
    const entry = findCurrentEntry(entries, /การเดินทาง/u); add(entry, between(entry?.content, { until: "ที่นั่งคงเหลือ" }), "logistics");
  }
  if (COMPANION_ASK.test(text)) {
    const entry = findCurrentEntry(entries, /เลื่อนวันเรียน/u); add(entry, between(entry?.content, { fromHeading: "ผู้ติดตาม" }), "companion");
  }
  if (TRUST_ASK.test(text)) {
    const entry = findCurrentEntry(entries, /ประวัติและความน่าเชื่อถือ/u); add(entry, entry?.content, "trust");
  }
  if (OUTLINE_ASK.test(text) && decision.stage !== "DELIVER") {
    const entry = findCurrentEntry(entries, /Outline ทางการ/u); add(entry, entry?.content, "outline");
  }
  // คำถามที่ต้องอธิบายคลาสได้ core facts + สิทธิ์ครบเป็นส่วน ไม่ใช่ prefix 1,200 ตัวอักษร
  if (["CONCEPT", "BRIDGE", "DISCOVERY"].includes(decision.stage) || OUTLINE_ASK.test(text) || asksTrial || asksFitOrBenefit) {
    add(scopeEntry, between(scopeEntry?.content, { until: "[อธิบาย Workshop" }), "core_scope");
    add(benefitEntry, benefitEntry?.content, "benefits");
  }
  return slices;
}

function fitWholeSlices(slices, budget) {
  const selected = [];
  let used = 0;
  let truncated = false;
  for (const slice of slices) {
    const block = `[${slice.title}]\n${slice.content}`;
    const size = [...block].length + (selected.length ? 2 : 0);
    if (used + size > budget) { truncated = true; continue; }
    selected.push({ ...slice, block });
    used += size;
  }
  return { selected, truncated };
}

/**
 * เลือก source section ครบตาม intent ภายใต้งบรวมเดียว พร้อม trace; ไม่ตัด prefix กลาง section และไม่เลือกซ้ำใน pipeline
 * @returns {{text:string, trace:Array<object>, truncated:boolean}}
 */
export function selectBusinessContext(entries = [], facts = {}, decision = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const { selected, truncated } = fitWholeSlices(businessSlices(list, facts, decision), BUSINESS_CONTEXT_MAX_CHARS);
  return {
    text: selected.map((item) => item.block).join("\n\n"),
    trace: selected.map(({ title, reason, id, revId, source_created_at, source_rowid, entry_version, provenance }) =>
      ({ title, reason, id, revId, source_created_at, source_rowid, entry_version, provenance })),
    truncated,
  };
}
