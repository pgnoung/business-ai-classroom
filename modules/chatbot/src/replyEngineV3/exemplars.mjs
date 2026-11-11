// exemplars.mjs — เลือกตัวอย่างคำตอบที่พี่ง้วงเลือกเอง 2–3 ชิ้นต่อเทิร์น (spec v3.1 §D)
// โมเดลรุ่นใหม่ลอกความยาว/ทรงของตัวอย่าง จึงใช้เฉพาะคำตอบที่ชนะจริง (รอบ 3) และบอกให้เขียนใหม่ ไม่ลอกประโยค
// ไฟล์ exemplars.json สร้างด้วย tools/voice-v3-eval/build-exemplars.mjs เท่านั้น (ไม่มีข้อความลูกค้า ไม่มีเคส held-out)
import { readFileSync } from "node:fs";
import { openSlotsFor, STAGES } from "./stage.mjs";
import { slotTokens } from "./slots.mjs";

export const EXEMPLARS = Object.freeze(JSON.parse(readFileSync(new URL("./exemplars.json", import.meta.url), "utf8")).exemplars
  .map((item) => Object.freeze({ ...item })));
export const EXEMPLARS_MAX = 3;
export const EXEMPLARS_MAX_CHARS = 1800;
const NEIGHBOUR = Object.freeze({
  DISCOVERY: "REASSURE", REASSURE: "DISCOVERY", CONCEPT: "BRIDGE", BRIDGE: "CONCEPT", MISREAD: "DISCOVERY",
  PRICE: "DEAL_PAIR", DEAL_PAIR: "PRICE", DEAL_SINGLE: "PRICE", OBJECTION: "REASSURE", DELIVER: "BRIDGE",
});
const OBJECTION_NEIGHBOUR_ID = "E07";
const TWO_PRIMARIES = new Set(["DISCOVERY", "BRIDGE"]);
const HEADER = "## ตัวอย่างคำตอบที่พี่ง้วงเลือกเอง (ดูจังหวะ ความยาว และความอุ่น แล้วเขียนใหม่ให้ตรงกับลูกค้าคนนี้ ไม่ลอกประโยค)";
const ROUND_TOKENS = ["รอบ1", "รอบ2"];

/** FNV-1a 32 บิต — หมุนลำดับตัวอย่างที่คะแนนเท่ากันแบบคงที่ต่อห้อง/เทิร์น */
export function fnv1a(value = "") {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const modelChars = (text) => [...String(text).replace(/\{\{[^{}]+\}\}|\[IMAGE:[^\]]+\]/gu, "")].length;

/** ลักษณะเด่นของเทิร์นที่ใช้จับคู่ตัวอย่าง (+2) */
export function featureFor(stage, facts = {}) {
  const text = String(facts.text || "");
  if (stage === "DISCOVERY") {
    if (facts.focus?.kind === "ai_level" && /\d/u.test(String(facts.focus.answer || ""))) return "level_number";
    if ((facts.tools || []).length && (facts.tools || []).some((name) => text.toLowerCase().includes(name.toLowerCase().slice(0, 4)))) return "tool";
    if ([...text].length > 80) return "long_self_assessment";
    return "work";
  }
  if (stage === "REASSURE") return facts.focus?.kind === "custom_ai_experience" || /ไม่เคย(?:สร้าง|ใช้)/u.test(text) ? "never_built" : "used_not_pro";
  if (stage === "BRIDGE") {
    if (/จริงจัง|ลงมือ|หารายได้|สร้างรายได้|อาชีพเสริม/u.test(text)) return "income_commit";
    if (/ขาย|สินค้า|digital product|niche|tpt|etsy/iu.test(text)) return "seller_niche";
    return facts.goal?.kind === "content" ? "content_images" : "income_commit";
  }
  if (stage === "PRICE" || stage === "DEAL_SINGLE") return /โปรแกรม|ต้องซื้อ|เครื่องมือ|chatgpt/iu.test(text) ? "price_plus_tools" : "price";
  return "";
}

const featureMatches = (exemplar, feature) => Boolean(feature) && (exemplar.feature === feature
  || (feature === "tool" && String(exemplar.feature).startsWith("tool_")));

function bandMatches(exemplar, stage) {
  const band = STAGES[stage]?.band;
  if (!band) return false;
  const length = modelChars(exemplar.reply);
  return length >= band[0] && length <= band[1];
}

// ตัวอย่างที่มีช่องเติมซึ่งเทิร์นนี้ไม่ได้เปิด = สอนให้วางช่องผิด (ช่องที่ไม่เปิดถูกตัด = ด่านแข็ง H3) → ไม่ใช้
// เช่น E01 จบที่ {{บันได}} ใช้ได้เฉพาะทักแรก/ขอพื้นฐานที่มีบันได · E14 {{ราคา}} ไม่เป็นเพื่อนบ้านของดีลคู่
function renderable(exemplar, facts, open) {
  const tokens = slotTokens(exemplar.reply);
  if (tokens.some((name) => ROUND_TOKENS.includes(name)) && (facts.roundLabels?.length || 0) < 2) return false;
  return tokens.every((name) => ROUND_TOKENS.includes(name) || open.has(name));
}

function ranked(pool, stage, feature, seed) {
  const scored = pool.map((exemplar, index) => ({
    exemplar, index, score: (featureMatches(exemplar, feature) ? 2 : 0) + (bandMatches(exemplar, stage) ? 1 : 0),
  }));
  const groups = new Map();
  for (const item of scored) {
    if (!groups.has(item.score)) groups.set(item.score, []);
    groups.get(item.score).push(item);
  }
  const rotation = fnv1a(seed);
  return [...groups.keys()].sort((a, b) => b - a).flatMap((score) => {
    const group = groups.get(score);
    const shift = rotation % group.length;
    return [...group.slice(shift), ...group.slice(0, shift)].map((item) => item.exemplar);
  });
}

function admit(chosen, exemplar) {
  if (!exemplar || chosen.some((item) => item.exemplar.id === exemplar.id)) return false;
  if (exemplar.group && chosen.some((item) => item.exemplar.group === exemplar.group)) return false;
  return true;
}

/**
 * openSlots = ช่องเติมที่เปิดในเทิร์นนี้ (ไม่ส่ง = ช่องตามจังหวะ โดย ladder บอกว่าขอพื้นฐานมีบันไดไหม)
 * @returns {Array<{exemplar: object, stage: string}>} ≤3 ชิ้น รวม ≤1,800 ตัวอักษร
 */
export function pickExemplars({ stage, facts = {}, seed = "", excludeCaseIds = [], openSlots = null, ladder = false } = {}) {
  const excluded = new Set(excludeCaseIds);
  const open = new Set(Array.isArray(openSlots) ? openSlots : openSlotsFor({ stage, ladder }).open);
  const usable = EXEMPLARS.filter((item) => !excluded.has(item.caseId) && renderable(item, facts, open));
  const chosen = [];
  const primaries = ranked(usable.filter((item) => item.stages.includes(stage)), stage, featureFor(stage, facts), seed);
  for (const exemplar of primaries) {
    if (chosen.length >= (TWO_PRIMARIES.has(stage) ? 2 : 1)) break;
    if (admit(chosen, exemplar)) chosen.push({ exemplar, stage });
  }
  const neighbour = NEIGHBOUR[stage];
  if (neighbour) {
    const pool = stage === "OBJECTION" ? usable.filter((item) => item.id === OBJECTION_NEIGHBOUR_ID) : usable.filter((item) => item.stages.includes(neighbour));
    const next = ranked(pool, neighbour, featureFor(neighbour, facts), seed).find((item) => admit(chosen, item));
    if (next) chosen.push({ exemplar: next, stage: neighbour });
  }
  const out = [];
  let total = 0;
  for (const item of chosen.slice(0, EXEMPLARS_MAX)) {
    const length = [...item.exemplar.reply].length;
    if (out.length && total + length > EXEMPLARS_MAX_CHARS) continue;
    out.push(item);
    total += length;
  }
  return out;
}

/** {{รอบ1}}/{{รอบ2}} เติมด้วยรอบที่เปิดจริงของเทิร์นนี้ ส่วนช่องเติมอื่นคงเป็นตัวช่อง (สอนตำแหน่งวาง) */
export function exemplarReply(exemplar, facts = {}) {
  return String(exemplar.reply)
    .replace(/\{\{รอบ1\}\}/gu, facts.roundLabels?.[0] || "")
    .replace(/\{\{รอบ2\}\}/gu, facts.roundLabels?.[1] || "");
}

export function renderExemplars(picked = [], facts = {}) {
  if (!picked.length) return "";
  return [HEADER, ...picked.map(({ exemplar, stage }, i) =>
    `ตัวอย่างที่ ${i + 1} · ขั้น: ${STAGES[stage]?.thai || stage} · สถานการณ์: ${exemplar.context}\n${exemplarReply(exemplar, facts)}`)].join("\n\n");
}
