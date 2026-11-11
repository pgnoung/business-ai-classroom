// blueprintSchema.mjs — รูปทรง "การวางระบบ AI Agent" ที่ผู้เรียนแต่ละคนได้รับทาง LINE (11 ต.ค. 2026)
//
// ที่มา: คลาส IESA S-Curve MBA รุ่น 6 (11 ต.ค. 2026) — ฉาก "ถ้ามีผู้ช่วยเพิ่มหนึ่งคน ฉันอยากมอบหมายให้เขา ____ ก่อน"
// ผู้เรียนส่ง #AIAGENT เข้ามา แล้ววันจันทร์ 10:00 ได้การ์ดเลื่อน (blueprintFlex.mjs) ที่สร้างจากรูปทรงนี้
//
// ไฟล์นี้ pure ล้วน (ไม่มี I/O ไม่มี import) — ใช้ได้ทั้งตอนเรียกโมเดล (strict JSON schema) และตอนตรวจผล
//   BLUEPRINT_JSON_SCHEMA         schema แบบ strict (ทุก property required, additionalProperties:false)
//   blueprintResponsesFormat()    ก้อน text.format สำหรับ POST /v1/responses
//   blueprintChatResponseFormat() ก้อน response_format สำหรับ /chat/completions (ถ้าปลายทางรองรับ)
//   parseBlueprintText(text)      ข้อความจากโมเดล → { ok, value, errors } (เกตเวย์ที่ไม่มี response_format ใช้ตัวนี้)
//   normalizeBlueprint(raw)       คืน "สำเนาใหม่" ที่ล้างข้อความ + ซ่อมเรื่องรูปแบบที่ซ่อมได้เอง (ดูด้านล่าง) ไม่แก้ของเดิม
//   validateBlueprint(value)      ตรวจทุกช่อง: ชนิด จำนวน ความยาว + ด่านความซื่อตรง (ชื่อค่ายโมเดล คำรับประกัน เงิน ลิงก์
//                                 อักษรจีน คำที่ด่าน compliance บล็อก)
//   textProblems(text)            ด่านความซื่อตรงชุดเดียวกันสำหรับข้อความใด ๆ (ใช้ตรวจคำสั่งตั้งต้นที่ประกอบจากแผน)
//
// v2 (2026-10-11.2) — หลังรอบจริงคืน 11 ต.ค.:
//   - ยาวเกินเพดานเคยทำให้ต้องเรียกโมเดลใหม่ทั้งก้อน ("inputs[2].note: ยาว 75 เกิน 72") — ตอนนี้ normalize ตัดที่ขอบคำไทย
//     (Intl.Segmenter) ให้เอง เลือกจุดเว้นวรรค (จบวลี) ก่อน ไม่ตัดกลางคำ ไม่เติม "…" · รายการเกินจำนวนสูงสุดตัดส่วนเกินทิ้ง
//     (ขั้นตอน/แผน 7 วันเก็บข้อสุดท้ายไว้ เพราะเป็นการส่งงาน/การตัดสินใจวัน 7) · เลข 1-2 หลักในช่องที่มีคำเรื่องเงิน
//     (ใบเสนอราคา ยอด จ่าย ฯลฯ) เขียนเป็นคำไทย เพราะด่านราคาของลูกแพรถือว่าเลขใกล้คำพวกนี้คือราคา
//     สิ่งที่ยังตีกลับให้เรียกใหม่: เนื้อหาผิดกติกา (คำแบน ชื่อค่าย เงิน ลิงก์ อักษรจีน) รูปทรงผิด และรายการน้อยกว่าขั้นต่ำ
//   - ช่องใหม่: businessLabel (ชื่อธุรกิจสั้น ๆ) · sampleOutput (หน้าตางานที่ Agent ส่งให้เจ้าของจริง) · nextLevel (โตไปเป็นอะไร)
//   - แผนรุ่นแรก (ไม่มีสามช่องใหม่เลย) ยังผ่านได้ — ร่างที่สร้างไว้ก่อน deploy ยังเรนเดอร์และส่งได้
//     มีบางช่องแต่ไม่ครบ = รูปทรงผิด ตีกลับ
//
// ความยาวนับเป็น code point (ตัวสระ/วรรณยุกต์ไทยนับแยก) — เพดานตั้งให้การ์ดบนมือถือไม่ล้น และ Flex ทั้งชุด < 30 KB
// schema ที่ส่งให้โมเดลไม่มี maxLength (ดูหมายเหตุที่ str()) — เพดานคุมด้วย normalize (ตัด) + validate (ตรวจ)

export const BLUEPRINT_SCHEMA_NAME = "ai_agent_blueprint";
export const BLUEPRINT_SCHEMA_VERSION = "2026-10-11.2";

// เพดานความยาว (code point) และจำนวนรายการ — ค่าเดียวกันใช้ทั้งใน schema, พรอมต์, normalize และตัวตรวจ
// v2: เพดานความยาวขึ้น 10-20% เท่าที่งบ Flex ให้ (เป้าที่บอกโมเดลแทบเท่าเดิม และเกินเพดานก็ตัดที่ขอบคำแทนการเรียกใหม่)
// จำนวนสูงสุด: inputs 3 (เดิม 5) steps 4 (เดิม 5) outputs 3 (เดิม 4) authority กลุ่มละ 2 (เดิม 3) เพื่อคืนที่ให้กล่อง "หน้าตางานที่คุณจะได้" บนปก
// งบขนาด: โครง Flex (กล่อง/สี/ระยะ) ราว 16 KB คงที่ เนื้อหาเต็มเพดานทุกช่องต้องอยู่ใต้ 13 KB → เคสยาวสุดต่ำกว่า 30 KB (มีเทสต์คุม)
export const BLUEPRINT_LIMITS = Object.freeze({
  businessLabel: 40,
  businessRestated: 100,
  whyThisFirst: 160,
  mission: 125,
  agentName: 36,
  sampleOutput: { title: 36, min: 3, max: 4, line: 70 },
  headline: 70,
  inputs: { min: 2, max: 3, source: 40, note: 80 },
  steps: { min: 3, max: 4, what: 86 },
  outputs: { min: 2, max: 3, deliverable: 88 },
  authority: { min: 1, max: 2, item: 68 },
  pilot7days: { min: 4, max: 5, day: 12, action: 82 },
  metrics: { min: 2, max: 3, name: 48, how: 86 },
  firstStepTomorrow: 135,
  nextLevel: 110,
  watchOuts: { min: 1, max: 2, item: 106 },
  toolsHint: 112,
});

// ความยาว "เป้า" ที่บอกโมเดล (สั้นกว่าเพดานเพื่อเผื่อ) — การ์ดอ่านสบายบนจอ 360 px
export const BLUEPRINT_TARGETS = Object.freeze({
  businessLabel: 24,
  businessRestated: 70,
  whyThisFirst: 130,
  mission: 95,
  agentName: 22,
  sampleOutput: { title: 28, line: 58 },
  headline: 42,
  inputs: { source: 30, note: 62 },
  steps: { what: 70 },
  outputs: { deliverable: 70 },
  authority: { item: 52 },
  pilot7days: { day: 9, action: 68 },
  metrics: { name: 38, how: 70 },
  firstStepTomorrow: 105,
  nextLevel: 90,
  watchOuts: { item: 85 },
  toolsHint: 92,
});

// ลำดับช่อง = ลำดับที่โมเดลเขียน: เลือกงานก่อน (why → mission) แล้วค่อยตั้งชื่อ วาดผลงาน และเขียนหัวเรื่องจากภาพนั้น
export const BLUEPRINT_KEYS = Object.freeze([
  "businessLabel", "businessRestated", "whyThisFirst", "mission", "agentName", "sampleOutput", "headline",
  "inputs", "steps", "outputs", "authority", "pilot7days", "metrics",
  "firstStepTomorrow", "nextLevel", "watchOuts", "toolsHint",
]);
// ช่องที่เพิ่มใน v2 — แผนที่ไม่มีครบทั้งสามช่อง = แผนรุ่นแรก (ยอมรับ) · มีบางช่อง = รูปทรงผิด
export const BLUEPRINT_V2_KEYS = Object.freeze(["businessLabel", "sampleOutput", "nextLevel"]);
export const AUTHORITY_KEYS = Object.freeze(["canDo", "draftsForReview", "ownerDecides", "never"]);
export const SAMPLE_OUTPUT_KEYS = Object.freeze(["title", "lines"]);

const L = BLUEPRINT_LIMITS;
const T = BLUEPRINT_TARGETS;

// ไม่ใส่ maxLength ใน schema ที่ส่งให้โมเดล: ทดสอบจริง 11 ต.ค. 2026 โมเดลถูกบังคับตัดกลางคำ ("ที่ไม่ปก")
// ความยาวจึงบอกเป็นเป้าในคำอธิบาย แล้วให้ normalizeBlueprint ตัดที่ขอบคำเมื่อเกินเพดาน
function str(target, description) {
  return { type: "string", description: `${description} (ยาวไม่เกินราว ${target} ตัวอักษร)` };
}

function list(items, min, max, description) {
  return { type: "array", minItems: min, maxItems: max, description, items };
}

function obj(properties, description) {
  return { type: "object", description, additionalProperties: false, required: Object.keys(properties), properties };
}

const authorityList = (description) => list(str(T.authority.item, "วลีสั้น เริ่มด้วยคำกริยา"), L.authority.min, L.authority.max, description);

/** strict JSON schema — ทุกระดับ required ครบ additionalProperties:false (ใช้ได้กับ structured output แบบ strict) */
export const BLUEPRINT_JSON_SCHEMA = Object.freeze(obj({
  businessLabel: str(T.businessLabel, "ชื่อประเภทธุรกิจสั้น ๆ ตามคำของผู้เรียน เช่น ร้านซักผ้าหยอดเหรียญ (ไม่บอก = ธุรกิจ)"),
  businessRestated: str(T.businessRestated, "ทวนธุรกิจและสิ่งที่ผู้เรียนอยากมอบหมาย เป็นประโยคสุภาพ ไม่เติมข้อเท็จจริงที่เขาไม่ได้บอก"),
  whyThisFirst: str(T.whyThisFirst, "ทำไมงานนี้ควรเริ่มก่อน: กินเวลาจริง ซ้ำทุกวัน มีข้อมูลอยู่แล้ว ตรวจผลได้"),
  mission: str(T.mission, "เป้าหมาย 1 ประโยค: ทำอะไรให้ใคร จังหวะไหน ได้ผลอะไรที่ตรวจได้"),
  agentName: str(T.agentName, "ชื่อบทบาทภาษาไทยที่จำง่าย เหมือนตำแหน่งของคนในทีม"),
  sampleOutput: obj({
    title: str(T.sampleOutput.title, "หัวของงานชิ้นที่ส่งให้เจ้าของ พร้อมจังหวะหรือเวลา เช่น สรุปเช้านี้ 08:30"),
    lines: list(str(T.sampleOutput.line, "หนึ่งบรรทัดของงานจริง ใช้ตัวแทนอย่าง ลูกค้ารายที่ 1 ไม่ใส่ชื่อจริงหรือจำนวนเงิน"),
      L.sampleOutput.min, L.sampleOutput.max, "บรรทัดในงานชิ้นนั้น บรรทัดท้ายคือเรื่องที่รอเจ้าของตัดสิน"),
  }, "ตัวอย่างหน้าตางานที่ Agent ส่งให้เจ้าของจริงในธุรกิจนี้"),
  headline: str(T.headline, "หัวเรื่องหน้าปก: ผลที่เจ้าของรู้สึกได้ ด้วยคำของธุรกิจนั้น ไม่ใช่ชื่อเทคโนโลยี"),
  inputs: list(obj({
    source: str(T.inputs.source, "แหล่งข้อมูลที่ธุรกิจแบบนี้มีอยู่แล้ว"),
    note: str(T.inputs.note, "ใช้ข้อมูลนี้ทำอะไร หรือต้องเตรียมอย่างไร"),
  }, "ข้อมูลเข้า 1 แหล่ง"), L.inputs.min, L.inputs.max, "ข้อมูลที่ Agent อ่าน (อ่านเฉพาะที่อนุญาต)"),
  steps: list(obj({
    what: str(T.steps.what, "ขั้นตอน 1 ขั้น เริ่มด้วยคำกริยา"),
  }, "ขั้นตอน"), L.steps.min, L.steps.max, "ลำดับงานที่ Agent ทำ"),
  outputs: list(obj({
    deliverable: str(T.outputs.deliverable, "ผลงานที่เจ้าของเปิดดูและตรวจได้จริง"),
  }, "ผลงาน"), L.outputs.min, L.outputs.max, "ผลงานที่ส่งให้เจ้าของ/ทีม"),
  authority: obj({
    canDo: authorityList("ทำได้เลย หรือทำแล้วรายงาน (งานภายใน ไม่กระทบลูกค้า/เงิน)"),
    draftsForReview: authorityList("ร่างไว้ให้คนตรวจก่อนใช้"),
    ownerDecides: authorityList("เรื่องที่เจ้าของต้องตัดสินเอง"),
    never: authorityList("ห้ามทำ"),
  }, "ขอบเขตอำนาจ: AI ช่วยเตรียม คนเป็นคนตัดสิน"),
  pilot7days: list(obj({
    day: str(T.pilot7days.day, "เช่น วัน 1 หรือ วัน 2-3"),
    action: str(T.pilot7days.action, "สิ่งที่ทำในช่วงนั้น"),
  }, "ช่วงของการทดลอง"), L.pilot7days.min, L.pilot7days.max, "แผนทดลอง 7 วัน ครบวัน 1 ถึงวัน 7"),
  metrics: list(obj({
    name: str(T.metrics.name, "ชื่อตัววัด"),
    how: str(T.metrics.how, "วัดอย่างไร จากข้อมูลอะไร"),
  }, "ตัววัด"), L.metrics.min, L.metrics.max, "วัดกระบวนการก่อน ยอดขายวัดตามรอบธุรกิจจริง"),
  firstStepTomorrow: str(T.firstStepTomorrow, "สิ่งเดียวที่ทำได้พรุ่งนี้ ใช้เวลาไม่เกิน 30 นาที"),
  nextLevel: str(T.nextLevel, "ถ้าทดลอง 7 วันผ่าน ผู้ช่วยตัวนี้โตไปทำอะไรได้อีก (ภาพข้างหน้า ไม่สัญญาผล)"),
  watchOuts: list(str(T.watchOuts.item, "ข้อควรระวังที่เฉพาะกับงานนี้"), L.watchOuts.min, L.watchOuts.max, "ข้อควรระวัง"),
  toolsHint: str(T.toolsHint, "ประเภทเครื่องมือแบบกลาง ๆ ไม่ระบุยี่ห้อ"),
}, "การวางระบบ AI Agent ตัวแรกของธุรกิจหนึ่งราย"));

/** text.format สำหรับ OpenAI Responses API */
export function blueprintResponsesFormat() {
  return { type: "json_schema", name: BLUEPRINT_SCHEMA_NAME, strict: true, schema: BLUEPRINT_JSON_SCHEMA };
}

/** response_format สำหรับ /chat/completions ที่รองรับ json_schema */
export function blueprintChatResponseFormat() {
  return { type: "json_schema", json_schema: { name: BLUEPRINT_SCHEMA_NAME, strict: true, schema: BLUEPRINT_JSON_SCHEMA } };
}

/* ------------------------------ normalize ------------------------------ */

// ตัวควบคุม/zero-width/bidi override — ไม่ควรถึงมือลูกค้าเลย
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/gu;

/** ล้างสตริงหนึ่งช่องสำหรับการ์ด LINE: markdown ออก, em/en dash เป็นขีดธรรมดา, ยุบช่องว่างเป็นบรรทัดเดียว */
export function cleanCardText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(CONTROL_RE, "")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/__(.+?)__/gu, "$1")
    .replace(/`+/gu, "")
    .replace(/^\s*#{1,6}\s+/u, "")
    .replace(/(?<=\d)\s*[–—―]\s*(?=\d)/gu, "-")
    .replace(/\s*[–—―]\s*/gu, " - ")
    .replace(/^\s*[-•·*]\s+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeValue(value) {
  if (typeof value === "string") return cleanCardText(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalizeValue(inner)]));
  }
  return value;
}

export const cpLength = (text) => [...String(text)].length;

const WORD_SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("th", { granularity: "word" }) : null;
const GRAPHEME_SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("th", { granularity: "grapheme" }) : null;
// คำเชื่อม/บุพบทที่จบวลีไม่ได้ — ตัดแล้วเหลือคำพวกนี้ท้ายประโยค = ตัดทิ้งอีกคำ ("ส่งให้คนตรวจและ" → "ส่งให้คนตรวจ")
const DANGLING_WORDS = new Set([
  "และ", "หรือ", "แล้ว", "เพื่อ", "โดย", "ที่", "ซึ่ง", "ของ", "กับ", "จาก", "ใน", "ว่า", "เช่น", "ถ้า", "หาก", "แต่",
  "จึง", "เมื่อ", "ตาม", "พร้อม", "รวมถึง", "ทั้ง", "คือ", "ให้", "แก่", "การ", "ความ", "เพราะ", "ส่วน",
]);
const TRAILING_JUNK_RE = /[\s,;:(\-–·/+&]+$/u;
// จุดเว้นวรรคที่อยู่ไกลกว่านี้ (สัดส่วนของเพดาน) ถือเป็นจุดจบวลีที่ดี — ใกล้กว่านี้ใช้ขอบคำแทน เพื่อไม่ทิ้งเนื้อหาเกินจำเป็น
const CLAUSE_CUT_MIN_RATIO = 0.6;

function wordSegments(text) {
  if (WORD_SEGMENTER) return [...WORD_SEGMENTER.segment(text)].map((part) => ({ text: part.segment, word: part.isWordLike }));
  return text.split(/(\s+)/u).filter(Boolean).map((part) => ({ text: part, word: !/^\s+$/u.test(part) }));
}

function graphemeCut(text, max) {
  const parts = GRAPHEME_SEGMENTER ? [...GRAPHEME_SEGMENTER.segment(text)].map((part) => part.segment) : [...text];
  let out = "";
  for (const part of parts) {
    if (cpLength(out + part) > max) break;
    out += part;
  }
  return out;
}

function tidyCut(text) {
  let out = text.replace(TRAILING_JUNK_RE, "");
  const open = (out.match(/\(/gu) || []).length;
  const close = (out.match(/\)/gu) || []).length;
  if (open > close) out = out.slice(0, out.lastIndexOf("(")).replace(TRAILING_JUNK_RE, "");
  return out;
}

/**
 * ย่อข้อความไทยให้ไม่เกิน max code point โดยตัดที่ขอบคำเท่านั้น (Intl.Segmenter ภาษาไทย)
 * เลือกจุดเว้นวรรคท้ายสุดก่อน (คือจบวลีในภาษาไทย) ถ้าอยู่ลึกพอ · ไม่อย่างนั้นใช้ขอบคำท้ายสุด
 * แล้วตัดคำเชื่อมที่ค้างท้ายและเครื่องหมายค้าง · ไม่เติม "…" · ไม่เกินอยู่แล้ว = คืนค่าเดิม
 */
export function shortenThai(value, max) {
  if (typeof value !== "string" || cpLength(value) <= max) return value;
  const segments = wordSegments(value);
  let position = 0;
  let lastSpace = -1;
  let lastWord = -1;
  for (const segment of segments) {
    if (position > max) break;
    const length = cpLength(segment.text);
    if (/^\s+$/u.test(segment.text)) lastSpace = position; // ตัดหน้าช่องว่าง = จบวลี
    else if (position + length <= max) lastWord = position + length;
    position += length;
  }
  const chars = [...value];
  const cutAt = lastSpace >= Math.ceil(max * CLAUSE_CUT_MIN_RATIO) ? lastSpace : Math.max(lastWord, lastSpace);
  if (cutAt <= 0) return tidyCut(graphemeCut(value, max).trim());
  let out = tidyCut(chars.slice(0, cutAt).join("").trim());
  const minKeep = Math.ceil(max * 0.5);
  for (let round = 0; round < 2; round += 1) {
    const words = wordSegments(out);
    const last = words[words.length - 1];
    if (!last || !DANGLING_WORDS.has(last.text)) break;
    const shorter = tidyCut(out.slice(0, out.length - last.text.length).trim());
    if (cpLength(shorter) < minKeep) break;
    out = shorter;
  }
  return out || tidyCut(graphemeCut(value, max).trim());
}

// คำที่ด่านราคาของลูกแพรใช้ตัดสินว่าเลขอยู่ "ในบริบทราคา" (complianceGuard.mjs PRICE_CONTEXT) — เลข 1-2 หลักใกล้คำพวกนี้
// ถูกบล็อกถ้าไม่ตรงตารางราคา ("ใบเสนอราคา 5 ใบ" โดน · "ใบเสนอราคาห้าใบ" ผ่าน) ที่นี่ใช้ทั้งช่องเป็นหน้าต่าง (กว้างกว่าด่านจริง)
const PRICE_WORD_RE = /(?:ราคา|บาท|฿|ค่า(?:บริการ|คอร์ส|รักษา|ใช้จ่าย|มัดจำ)|คอร์สละ|ครั้งละ|ต่อครั้ง|เริ่มต้น|โปรโมชั่น|โปรโมชัน|ส่วนลด|ลดเหลือ|เหลือเพียง|ลดพิเศษ|ชำระ|จ่าย|มัดจำ|ยอด|เฉลี่ย|สุทธิ|net)/iu;
// เลข 1-2 หลัก (หรือช่วง 3-4) ที่ไม่ใช่เวลา (08:30) ทศนิยม ร้อยละ เศษส่วน หรือรหัสติดอักษรละติน (A4) — "ลูกค้ารายที่ 1: ..." แปลงได้
const SMALL_NUMBER_RE = /( ?)(?<![\dA-Za-z,:/.])(\d{1,2})(?: ?(?:-|ถึง) ?(\d{1,2}))?(?![\dA-Za-z,/%]|[.:]\d)( ?)/gu;
const THAI_DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const isThaiChar = (char) => /[฀-๿]/u.test(char || "");

/** 0-99 เป็นคำไทย: 3 → สาม · 11 → สิบเอ็ด · 21 → ยี่สิบเอ็ด */
export function thaiNumberWord(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(value);
  if (n < 10) return THAI_DIGITS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  const head = tens === 1 ? "สิบ" : tens === 2 ? "ยี่สิบ" : `${THAI_DIGITS[tens]}สิบ`;
  return ones === 0 ? head : `${head}${ones === 1 ? "เอ็ด" : THAI_DIGITS[ones]}`;
}

/**
 * ช่องที่มีคำเรื่องเงิน: เลข 1-2 หลักเป็นคำไทย ("ใบเสนอราคา 5 ใบ" → "ใบเสนอราคาห้าใบ") · ช่องอื่นคืนค่าเดิม
 * force = แปลงแม้ช่องนี้ไม่มีคำเรื่องเงิน (บรรทัดของหน้าตางานแปลงทั้งชุด ให้ "ลูกค้ารายที่หนึ่ง" ไม่ปนกับ "ลูกค้ารายที่ 2")
 */
export function thaiQuantities(value, { force = false } = {}) {
  if (typeof value !== "string" || (!force && !PRICE_WORD_RE.test(value))) return value;
  return value.replace(SMALL_NUMBER_RE, (match, lead, from, to, trail, offset, whole) => {
    const before = whole[offset - 1];
    const after = whole[offset + match.length];
    const words = to ? `${thaiNumberWord(from)}ถึง${thaiNumberWord(to)}` : thaiNumberWord(from);
    return `${lead && !isThaiChar(before) ? lead : ""}${words}${trail && !isThaiChar(after) ? trail : ""}`;
  });
}

const fitText = (value, max) => shortenThai(thaiQuantities(value), max);

const PRICE_WORD_GLOBAL_RE = new RegExp(PRICE_WORD_RE.source, "giu");
// ตัวเลขทุกรูป (รวม 12,900 และ 1.5) พร้อมช่องว่างรอบตัว — รูปเดียวกับ NUMBER_PATTERN ของด่านราคา
const NUMBER_TOKEN_RE = /( ?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)( ?)/gu;
const THAI_NUMERALS = "๐๑๒๓๔๕๖๗๘๙";
// หน้าต่างรอบเลขที่ด่านราคาดู (±20 ก่อน / +12 หลัง) บวกเผื่อ — ข้อความหลายบรรทัด เลข 3 หลักขึ้นไปด่านไม่ตัดที่ขอบย่อหน้า
const PRICE_WINDOW_BEFORE = 24;
const PRICE_WINDOW_AFTER = 16;

/** เลขไทย ๐-๙ แทนเลขอารบิก — ด่านราคานับเฉพาะเลขอารบิก จึงไม่ถือว่าเป็นราคา */
export const toThaiNumerals = (value) => String(value).replace(/\d/gu, (digit) => THAI_NUMERALS[Number(digit)]);

/**
 * ข้อความหลายบรรทัดที่ประกอบจากหลายช่อง (คำสั่งตั้งต้น ข้อความสำรอง): เลขที่อยู่ใกล้คำเรื่องเงินในข้อความรวม
 * (ข้ามบรรทัดได้) → เลข 1-2 หลักเป็นคำไทย เลขอื่นเป็นเลขไทย · เวลา (08:30) และรหัสติดอักษรละติน (A4) คงเดิม
 * แต่ละช่องผ่านด่านมาแล้ว แต่พอนำมาวางต่อกัน คำเรื่องเงินของบรรทัดหนึ่งอาจอยู่ในหน้าต่างของเลขอีกบรรทัด
 */
export function priceSafeNumbers(text) {
  const value = String(text ?? "");
  const words = [...value.matchAll(PRICE_WORD_GLOBAL_RE)].map((match) => [match.index, match.index + match[0].length]);
  if (!words.length) return value;
  return value.replace(NUMBER_TOKEN_RE, (match, lead, number, trail, offset, whole) => {
    const start = offset + lead.length;
    const end = start + number.length;
    const before = whole[start - 1] || "";
    const after = whole[end] || "";
    if (before === ":" || after === ":" || /[A-Za-z]/u.test(before) || /[A-Za-z]/u.test(after)) return match;
    const near = words.some(([from, to]) => to > start - PRICE_WINDOW_BEFORE && from < end + PRICE_WINDOW_AFTER);
    if (!near) return match;
    if (/^\d{1,2}$/u.test(number)) {
      const outer = whole[offset - 1];
      const next = whole[offset + match.length];
      return `${lead && !isThaiChar(outer) ? lead : ""}${thaiNumberWord(number)}${trail && !isThaiChar(next) ? trail : ""}`;
    }
    return `${lead}${toThaiNumerals(number)}${trail}`;
  });
}

/** รายการยาวเกินจำนวนสูงสุด = ตัดส่วนเกิน · keepLast = เก็บข้อสุดท้าย (ส่งงาน/ตัดสินวัน 7) แทนข้อก่อนหน้า */
function capList(items, max, keepLast = false) {
  if (!Array.isArray(items) || items.length <= max) return items;
  return keepLast ? [...items.slice(0, max - 1), items[items.length - 1]] : items.slice(0, max);
}

function fitObjectList(items, spec, fields, keepLast) {
  const capped = capList(items, spec.max, keepLast);
  if (!Array.isArray(capped)) return capped;
  return capped.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const out = { ...item };
    for (const field of fields) if (typeof out[field] === "string") out[field] = fitText(out[field], spec[field]);
    return out;
  });
}

function fitStringList(items, max, itemMax) {
  const capped = capList(items, max);
  return Array.isArray(capped) ? capped.map((item) => fitText(item, itemMax)) : capped;
}

const STRING_KEYS = ["businessLabel", "businessRestated", "whyThisFirst", "mission", "agentName", "headline", "firstStepTomorrow", "nextLevel", "toolsHint"];
const OBJECT_LISTS = Object.freeze({
  inputs: { fields: ["source", "note"] },
  steps: { fields: ["what"], keepLast: true },
  outputs: { fields: ["deliverable"] },
  pilot7days: { fields: ["day", "action"], keepLast: true },
  metrics: { fields: ["name", "how"] },
});

/** ซ่อมเรื่องรูปแบบที่ซ่อมได้เอง (ยาวเกิน · รายการเกิน · เลขใกล้คำเรื่องเงิน) — ช่องที่ชนิดผิดปล่อยไว้ให้ validate ตีกลับ */
function fitBlueprint(value) {
  const out = { ...value };
  for (const key of STRING_KEYS) if (typeof out[key] === "string") out[key] = fitText(out[key], L[key]);
  for (const [key, { fields, keepLast = false }] of Object.entries(OBJECT_LISTS)) {
    if (Object.hasOwn(out, key)) out[key] = fitObjectList(out[key], L[key], fields, keepLast);
  }
  if (Object.hasOwn(out, "watchOuts")) out.watchOuts = fitStringList(out.watchOuts, L.watchOuts.max, L.watchOuts.item);
  if (out.authority && typeof out.authority === "object" && !Array.isArray(out.authority)) {
    out.authority = { ...out.authority };
    for (const key of AUTHORITY_KEYS) {
      if (Object.hasOwn(out.authority, key)) out.authority[key] = fitStringList(out.authority[key], L.authority.max, L.authority.item);
    }
  }
  if (out.sampleOutput && typeof out.sampleOutput === "object" && !Array.isArray(out.sampleOutput)) {
    const sample = { ...out.sampleOutput };
    if (typeof sample.title === "string") sample.title = fitText(sample.title, L.sampleOutput.title);
    if (Object.hasOwn(sample, "lines")) {
      const lines = capList(sample.lines, L.sampleOutput.max);
      // บรรทัดไหนมีคำเรื่องเงิน = แปลงเลขทุกบรรทัด (ตัวแทนอย่าง "ลูกค้ารายที่ 1" ต้องเขียนแบบเดียวกันทั้งกล่อง)
      const force = Array.isArray(lines) && lines.some((line) => typeof line === "string" && PRICE_WORD_RE.test(line));
      sample.lines = Array.isArray(lines)
        ? lines.map((line) => shortenThai(thaiQuantities(line, { force }), L.sampleOutput.line))
        : lines;
    }
    out.sampleOutput = sample;
  }
  return out;
}

/**
 * สำเนาใหม่ที่ล้างทุกสตริง + ซ่อมความยาว/จำนวนเกิน/เลขใกล้คำเรื่องเงิน — ไม่แก้ object ที่ส่งเข้ามา
 * ไม่เติมช่องที่หาย และไม่ลบช่องแปลก (ให้ validateBlueprint ตัดสินรูปทรง)
 */
export function normalizeBlueprint(raw) {
  const cleaned = normalizeValue(raw);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) ? fitBlueprint(cleaned) : cleaned;
}

/* ------------------------------ validate ------------------------------- */

// ชื่อค่าย/รุ่นโมเดล/แพลตฟอร์มออโตเมชัน — ข้อความถึงลูกค้าต้องเป็นกลาง ("AI Agent" เท่านั้น)
const VENDOR_RE = /(?:chat\s*gpt|\bgpt[-\s]?\d|\bopenai\b|\bclaude\b|\banthropic\b|\bgemini\b|\bcopilot\b|\bllama\b|\bdeepseek\b|\bgrok\b|\bmistral\b|\bmake\.com\b|\bzapier\b|\bn8n\b|\bnotebooklm\b|\bperplexity\b|\bqwen\b)/iu;
// P-112: ไม่มีโน้ต "สร้างด้วย AI / สมมติ / สาธิต" ในงานที่ส่งลูกค้า
const DISCLAIMER_RE = /(?:สร้างด้วย\s*AI|สร้างโดย\s*AI|ข้อมูลสมมติ|ตัวอย่างสมมติ|สมมติ|สาธิต|disclaimer)/iu;
// ห้ามสัญญาผล/รับประกัน
const GUARANTEE_RE = /(?:แน่นอน\s*100|100\s*%|ไม่มีพลาด|ได้ผลแน่|ยอดขายเพิ่มขึ้น\s*\d|เพิ่มยอดขาย\s*\d)/iu;
// คำว่า รับประกัน/การันตี ผ่านได้เฉพาะในวลีห้าม (วลีเดียวกัน = ไม่มีช่องว่างคั่น): "ไม่ร่างคำแนะนำรักษาหรือคำรับประกัน" "ห้ามให้คำการันตี"
// เจอจริง 11 ต.ค. (รอบพิสูจน์ v2): ข้อควรระวังของคลินิกที่บอกว่า "ไม่ร่าง...คำรับประกัน" ถูกตีกลับทั้งที่เป็นข้อห้ามที่ถูกต้อง
// ด่าน compliance จริงไม่บล็อกคำนี้ (บล็อก การันตีผล/รับรองผล ซึ่ง GUARD_WORD_RE ตรวจแยกอยู่แล้ว)
const GUARANTEE_WORD_RE = /รับประกัน|การันตี|guarantee/giu;
// คำปฏิเสธ + กริยาของการให้คำมั่น ("ไม่ร่าง..." "ห้ามให้...") หรือคำปฏิเสธชิดคำนั้นเลย ("ไม่รับประกัน" "ห้ามให้คำการันตี")
// "ไม่ต้องห่วงรับประกันผล" ไม่ผ่าน (ไม่ต้อง ไม่ใช่การห้ามให้คำมั่น)
const NEGATED_PHRASE_RE = /(?:ไม่|ห้าม|อย่า|งด|เลี่ยง)(?:ให้|ร่าง|เขียน|ใช้|ใส่|พูด|สัญญา|ตอบ|รับปาก|เสนอ|อ้าง|ออก)|(?:ไม่|ห้าม|อย่า|งด|เลี่ยง)(?:ให้)?(?:คำ)?$|\b(?:never|not|no|avoid)\b/iu;
function hasPromiseWord(text) {
  for (const match of text.matchAll(GUARANTEE_WORD_RE)) {
    const phraseStart = text.slice(0, match.index).search(/\S*$/u);
    if (!NEGATED_PHRASE_RE.test(text.slice(phraseStart, match.index))) return true;
  }
  return false;
}
// ห้ามพูดถึงเงิน/ราคา/ค่าใช้จ่ายเป็นตัวเลข
const MONEY_RE = /(?:฿|\d[\d,.]*\s*(?:บาท|baht|thb|usd|\$)|\$\s*\d)/iu;
// เลขรูปทรงจำนวนเงิน (มี comma ทศนิยม หรือ 3 หลักขึ้นไป) ในช่องที่มีคำเรื่องเงิน = ด่านราคาบล็อกแน่ (ไม่ใช่เวลา 08:30)
const MONEY_SHAPED_NUMBER_RE = /(?<![\d:])(?:\d{1,3}(?:,\d{3})+|\d+\.\d+|\d{3,})(?![\d:])/u;
// ห้ามลิงก์/อีเมล/เบอร์โทรในเนื้อหา
const CONTACT_RE = /(?:https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.]+|(?:\+?66|0)\d{1,2}[-\s]?\d{3}[-\s]?\d{3,4})/iu;
// คำที่ด่าน compliance ของลูกแพรบล็อกทั้งข้อความ (config/clinic-banned.json + DIAGNOSIS_PATTERNS ใน complianceGuard.mjs)
// ตรวจซ้ำที่นี่ให้รายงานตั้งแต่ตอน parse ว่าต้องเรียกใหม่เพราะอะไร — ด่านจริงยังตัดสินทั้งตอนสร้างและตอนส่ง
// ("ดีที่สุด" ในงานทั่วไปอย่าง "เลือกงานที่ดีที่สุด" ก็โดน · "อันดับ 1" ตรงตัวอักษรรวม "อันดับ 10" เหมือนด่านจริง)
const GUARD_WORD_RE = /(?:ดีที่สุด|อันดับ 1|การันตีผล|เห็นผล 100%|หายขาด|ปลอดภัย 100%|ไม่มีผลข้างเคียง|เห็นผลทันที|ผลลัพธ์ถาวร|รับรองผล|วินิจฉัย|(?:น่าจะ|อาจจะ|คงจะ|คง|คุณ|ลูกค้า)\s*เป็นโรค|อาการ(?:แบบ)?นี้\s*(?:คือ|เป็น)โรค|ยืนยันว่า(?:คุณ)?เป็น|ฟันธงว่าเป็น)/u;
// อักษรจีน/ญี่ปุ่น/เกาหลีหลุดเข้ามาในภาษาไทย (เจอจริงในเดโม 11 ต.ค. "ขอ确认คิว") → ให้เจนใหม่ ไม่ตัดทิ้ง
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/u;

/** ปัญหาความซื่อตรงของข้อความหนึ่งก้อน → รายการคำอธิบาย (ว่าง = ผ่าน) — ใช้ได้กับข้อความใดก็ได้ */
export function textProblems(text) {
  const value = String(text ?? "");
  const problems = [];
  if (VENDOR_RE.test(value)) problems.push("มีชื่อค่ายหรือรุ่นโมเดล (ต้องเป็นกลาง)");
  if (DISCLAIMER_RE.test(value)) problems.push("มีคำอย่าง สมมติ/สาธิต/สร้างด้วย AI (P-112)");
  if (GUARANTEE_RE.test(value) || hasPromiseWord(value)) problems.push("มีคำรับประกันหรือสัญญาผล");
  if (MONEY_RE.test(value)) problems.push("มีจำนวนเงินหรือราคา");
  if (PRICE_WORD_RE.test(value) && MONEY_SHAPED_NUMBER_RE.test(value)) problems.push("มีตัวเลขแบบจำนวนเงินในข้อความเรื่องเงิน");
  if (CONTACT_RE.test(value)) problems.push("มีลิงก์ อีเมล หรือเบอร์โทร");
  if (GUARD_WORD_RE.test(value)) problems.push("มีคำที่ด่านตรวจข้อความบล็อก (โฆษณาเกินจริงหรือวินิจฉัย)");
  const foreign = value.match(CJK_RE);
  if (foreign) problems.push(`มีอักษรต่างภาษา "${foreign[0]}" ปนในภาษาไทย`);
  return problems;
}

function checkString(errors, path, value, max) {
  if (typeof value !== "string") {
    errors.push(`${path}: ต้องเป็นข้อความ`);
    return;
  }
  if (!value.trim()) {
    errors.push(`${path}: ว่าง`);
    return;
  }
  if (cpLength(value) > max) errors.push(`${path}: ยาว ${cpLength(value)} เกิน ${max}`);
  errors.push(...textProblems(value).map((problem) => `${path}: ${problem}`));
}

function checkExactKeys(errors, path, value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path || "(root)"}: ต้องเป็น object`);
    return false;
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) errors.push(`${path}${path ? "." : ""}${key}: ขาด`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(`${path}${path ? "." : ""}${key}: ไม่อยู่ใน schema`);
  return true;
}

function checkArray(errors, path, value, min, max) {
  if (!Array.isArray(value)) {
    errors.push(`${path}: ต้องเป็นรายการ`);
    return false;
  }
  if (value.length < min || value.length > max) errors.push(`${path}: มี ${value.length} รายการ (ต้อง ${min}-${max})`);
  return true;
}

function checkObjectList(errors, path, value, spec, fields) {
  if (!checkArray(errors, path, value, spec.min, spec.max)) return;
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!checkExactKeys(errors, itemPath, item, fields)) return;
    for (const field of fields) checkString(errors, `${itemPath}.${field}`, item[field], spec[field]);
  });
}

function checkStringList(errors, path, value, min, max, itemMax) {
  if (!checkArray(errors, path, value, min, max)) return;
  value.forEach((item, index) => checkString(errors, `${path}[${index}]`, item, itemMax));
}

/** แผนรุ่นแรก (ก่อน v2) = ไม่มีช่องใหม่เลยสักช่อง — ยังรับไว้ให้ร่างที่สร้างก่อน deploy เรนเดอร์และส่งได้ */
export function isLegacyBlueprint(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && BLUEPRINT_V2_KEYS.every((key) => !Object.hasOwn(value, key));
}

/** ตรวจครบทุกช่องตาม schema + เพดานความยาว + ด่านเนื้อหา → { ok, errors } (ไม่แก้ค่า) */
export function validateBlueprint(value) {
  const errors = [];
  const keys = isLegacyBlueprint(value) ? BLUEPRINT_KEYS.filter((key) => !BLUEPRINT_V2_KEYS.includes(key)) : BLUEPRINT_KEYS;
  if (!checkExactKeys(errors, "", value, keys)) return { ok: false, errors };
  for (const key of STRING_KEYS) {
    if (Object.hasOwn(value, key)) checkString(errors, key, value[key], L[key]);
  }
  for (const [key, { fields }] of Object.entries(OBJECT_LISTS)) {
    if (Object.hasOwn(value, key)) checkObjectList(errors, key, value[key], L[key], fields);
  }
  if (Object.hasOwn(value, "watchOuts")) checkStringList(errors, "watchOuts", value.watchOuts, L.watchOuts.min, L.watchOuts.max, L.watchOuts.item);
  if (Object.hasOwn(value, "authority") && checkExactKeys(errors, "authority", value.authority, AUTHORITY_KEYS)) {
    for (const key of AUTHORITY_KEYS) {
      if (Object.hasOwn(value.authority, key)) {
        checkStringList(errors, `authority.${key}`, value.authority[key], L.authority.min, L.authority.max, L.authority.item);
      }
    }
  }
  if (Object.hasOwn(value, "sampleOutput") && checkExactKeys(errors, "sampleOutput", value.sampleOutput, SAMPLE_OUTPUT_KEYS)) {
    const sample = value.sampleOutput;
    if (Object.hasOwn(sample, "title")) checkString(errors, "sampleOutput.title", sample.title, L.sampleOutput.title);
    if (Object.hasOwn(sample, "lines")) {
      checkStringList(errors, "sampleOutput.lines", sample.lines, L.sampleOutput.min, L.sampleOutput.max, L.sampleOutput.line);
    }
  }
  // อักษรต่างภาษาในช่องที่ไม่ใช่สตริงตามรูปทรง (เช่นค่าแปลกในช่องเกิน) ก็ยังต้องเห็น — ตรวจทั้งก้อนอีกชั้น
  const foreign = JSON.stringify(value).match(CJK_RE);
  if (foreign && !errors.some((error) => error.includes(foreign[0]))) errors.push(`มีอักษรต่างภาษา "${foreign[0]}" ปนในภาษาไทย`);
  return { ok: errors.length === 0, errors };
}

/* -------------------------------- parse -------------------------------- */

/** ดึง JSON ก้อนแรกจากข้อความโมเดล (รองรับ ```json fences และคำนำหน้า) — คืน object หรือ null */
export function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** ข้อความจากโมเดล → { ok, value, errors } — value ผ่าน normalize แล้ว (ใช้เรนเดอร์ได้ทันทีเมื่อ ok) */
export function parseBlueprintText(text) {
  const parsed = extractJsonObject(text);
  if (!parsed) return { ok: false, value: null, errors: ["ไม่พบ JSON ที่อ่านได้ในคำตอบของโมเดล"] };
  const value = normalizeBlueprint(parsed);
  const { ok, errors } = validateBlueprint(value);
  return { ok, value: ok ? value : null, errors };
}
