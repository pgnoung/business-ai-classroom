// styleBank.mjs — คลังคำตอบจริงของครู (Opus) ที่ทีมชอบ หยิบที่คล้ายสถานการณ์ของเทิร์นนี้มาให้รุ่นที่ถูกกว่าดูก่อนตอบ
// พี่ง้วง 7 พ.ย. 2026: "อยากให้ 6.1 Sol ใกล้ Opus ถึง 9–9.5" · 6.1 Sol fine-tune ไม่ได้ (OpenAI ไม่รองรับ) จึงสอนด้วยตัวอย่างจริงทุกเทิร์นแทน
//
// สวิตช์ reply_style_bank (ไม่ต้อง deploy): ไม่มีแถว/ค่าอื่น = off = พรอมต์เดิมทุกไบต์
// คลังเป็นไฟล์ JSON ใน instance (REPLY_STYLE_BANK_FILE) ไม่อยู่ใน git เพราะมีข้อความลูกค้า (ปิดชื่อ เบอร์ อีเมลแล้ว)
//   { "version": "...", "items": [{ "id", "stage", "user", "prev", "reply" }] }
// เลือกด้วยโค้ด ไม่เรียกโมเดล: ขั้นเดียวกันก่อน แล้วความคล้ายของข้อความลูกค้า (ตัวอักษรสามตัวติดกัน) · อ่านไฟล์พัง = ไม่มีตัวอย่าง
import { readFileSync, statSync } from "node:fs";

export const REPLY_STYLE_BANK_KEY = "reply_style_bank";
export const REPLY_STYLE_BANK_MODES = Object.freeze(["on", "off"]);
export const STYLE_BANK_K = 6;
// เทิร์นเดียวกับที่ครูเคยตอบ: ขั้นเดียวกัน + คำถามก่อนหน้าของลูกแพรคล้าย + คำตอบลูกค้าคล้าย → ใช้คำตอบครูเป็นแบบได้ (ไม่ถือว่าลอก)
const STRONG_PREV = 0.6;
const STRONG_USER = 0.5;
const MAX_REPLY_CHARS = 700;
const STAGE_GROUP = Object.freeze({
  DISCOVERY: "explore", CONCEPT: "explore", REASSURE: "explore", MISREAD: "explore",
  BRIDGE: "pitch", OBJECTION: "pitch",
  PRICE: "deal", SCREEN_PRICE: "deal", DEAL_PAIR: "deal", DEAL_SINGLE: "deal", LOGISTICS: "deal", DELIVER: "deal",
  FIRST_CONTACT: "open", GOODBYE: "close", EXIT: "close",
  // คลังทักตาม: ใช้ชนิดเรื่องที่ค้าง (thread.kind) แทนขั้น
  work: "fu_explore", level: "fu_explore", goal: "fu_explore", question: "fu_explore", none: "fu_explore",
  round_choice: "fu_deal", price_owed: "fu_deal", rounds_offer: "fu_deal", after_price: "fu_deal", booking: "fu_deal", class_choice: "fu_deal",
});

// สวิตช์แยกของข้อความทักตาม (followup_style_bank) — เปิดแชทหลักกับทักตามแยกกันได้ · ไม่มีแถว = off
export const FOLLOWUP_STYLE_BANK_KEY = "followup_style_bank";
export const FOLLOWUP_STYLE_BANK_K = 4;
export function followupStyleBankMode(db) {
  try {
    return String(db?.getSetting?.(FOLLOWUP_STYLE_BANK_KEY) ?? "").trim().toLowerCase() === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

export function replyStyleBankMode(db) {
  try {
    return String(db?.getSetting?.(REPLY_STYLE_BANK_KEY) ?? "").trim().toLowerCase() === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

let cache = { file: "", mtimeMs: -1, items: [] };
/** คลังจากไฟล์ (จำไว้จนกว่าไฟล์จะเปลี่ยน) · ไม่มีไฟล์/อ่านพัง = [] */
export function loadStyleBank(file, logger = null) {
  if (!file) return [];
  try {
    const { mtimeMs } = statSync(file);
    if (cache.file === file && cache.mtimeMs === mtimeMs) return cache.items;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const items = (Array.isArray(parsed?.items) ? parsed.items : [])
      .filter((item) => item && typeof item.reply === "string" && item.reply.trim() && typeof item.user === "string")
      .map((item) => Object.freeze({ id: String(item.id || ""), stage: String(item.stage || ""), user: item.user, prev: String(item.prev || ""),
        reply: item.reply, grams: grams(`${item.user} ${String(item.prev || "").slice(-200)}`),
        userGrams: grams(item.user), prevGrams: grams(String(item.prev || "").slice(-200)) }));
    cache = { file, mtimeMs, items };
    return items;
  } catch (error) {
    logger?.warn?.(`style bank: อ่านคลังไม่ได้ (${error?.message || error}) — ตอบโดยไม่มีตัวอย่างของครู`);
    return [];
  }
}

const norm = (text) => String(text || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
function grams(text) {
  const chars = [...norm(text)];
  const out = new Map();
  for (let i = 0; i + 3 <= chars.length; i += 1) {
    const g = chars.slice(i, i + 3).join("");
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}
function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0;
  for (const [g, n] of a) dot += n * (b.get(g) || 0);
  const len = (m) => Math.sqrt([...m.values()].reduce((s, n) => s + n * n, 0));
  return dot / (len(a) * len(b));
}

/** หยิบคำตอบของครูที่คล้ายเทิร์นนี้ที่สุด k อัน (ขั้นเดียวกันก่อน แล้วกลุ่มขั้นเดียวกัน) */
export function selectStyleExamples(bank = [], { stage = "", userText = "", prevBot = "", k = STYLE_BANK_K } = {}) {
  if (!Array.isArray(bank) || !bank.length || k <= 0) return [];
  const target = grams(`${userText} ${String(prevBot || "").slice(-200)}`);
  const group = STAGE_GROUP[stage] || "";
  const scored = bank.map((item) => {
    const stageScore = item.stage === stage ? 1 : group && STAGE_GROUP[item.stage] === group ? 0.5 : 0;
    return { item, score: stageScore + cosine(target, item.grams) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const out = [];
  const seen = new Set();
  const userG = grams(userText);
  const prevG = grams(String(prevBot || "").slice(-200));
  for (const { item } of scored) {
    const key = norm(item.reply).slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const strong = !out.length && item.stage === stage && prevG.size > 0
      && cosine(prevG, item.prevGrams || new Map()) >= STRONG_PREV && cosine(userG, item.userGrams || new Map()) >= STRONG_USER;
    out.push(strong ? Object.freeze({ ...item, strong: true }) : item);
    if (out.length >= k) break;
  }
  return out;
}

const clip = (text, n) => { const c = [...String(text || "")]; return c.length <= n ? c.join("") : `${c.slice(0, n).join("")}…`; };
export const STYLE_BANK_HEADER = "## คำตอบจริงของครูในสถานการณ์คล้ายกัน\n"
  + "ครูคือแอดมินที่ทีมชอบสไตล์ที่สุด อ่านเพื่อดูวิธีรับเรื่อง การหยิบคำของลูกค้ามาให้ความหมาย ความอบอุ่น การเรียงข้อความ และวิธีปิดท้าย แล้วเขียนคำตอบของเทิร์นนี้ด้วยน้ำเสียงเดียวกัน · "
  + "ข้อเท็จจริงทุกอย่าง (คลาส ราคา รอบ วันที่ รีวิว ลิงก์ ชื่อลูกค้า) ใช้จากข้อมูลและงานของเทิร์นนี้เท่านั้น · \"คุณ(ชื่อ)\" ในตัวอย่างคือชื่อลูกค้าคนนั้น · ห้ามลอกประโยคของครูทั้งประโยค";
export const STYLE_BANK_STRONG_NOTE = "ตัวอย่างของครู 1 คือสถานการณ์เดียวกับเทิร์นนี้ (ลูกแพรถามเรื่องเดียวกันและลูกค้าตอบคล้ายกัน) "
  + "ใช้คำตอบนั้นเป็นแบบได้ทั้งประโยคแรก จังหวะ และคำถามปิด แล้วปรับให้เข้ากับคำของลูกค้าคนนี้และงานของเทิร์นนี้ · ข้อเท็จจริงยังใช้จากข้อมูลของเทิร์นนี้เท่านั้น";
export function renderStyleExamples(items = []) {
  if (!items.length) return "";
  const header = items[0]?.strong ? `${STYLE_BANK_HEADER}\n${STYLE_BANK_STRONG_NOTE}` : STYLE_BANK_HEADER;
  return [header, ...items.map((item, i) => [
    `ตัวอย่างของครู ${i + 1}`,
    item.prev ? `ลูกแพรพูดก่อนหน้า: ${clip(item.prev, 240)}` : "",
    `ลูกค้า: ${clip(item.user, 240)}`,
    `ครูตอบ: ${clip(item.reply, MAX_REPLY_CHARS)}`,
  ].filter(Boolean).join("\n"))].join("\n\n");
}

// ---- ทักตาม: ตัวอย่างข้อความทักตามจริงของครู (ไฟล์ FOLLOWUP_STYLE_BANK_FILE)
// ในคลังทักตาม ชื่อลูกค้าถูกตัดออก และรอบ/ค่าเรียน/ลิงก์ถูกแทนด้วยป้าย [..ตามข้อมูลจริง] — ร่างที่ยังมีป้ายนี้ = ไม่ส่ง
export const FOLLOWUP_BANK_PLACEHOLDER = /\[(?:รอบ|ค่าเรียน|ลิงก์)ตามข้อมูลจริง\]|\(ชื่อ\)/u;
export const FOLLOWUP_BANK_HEADER = "## ข้อความทักตามจริงของครูในสถานการณ์คล้ายกัน\n"
  + "ครูคือแอดมินที่ทีมชอบสไตล์ที่สุด ดูวิธีทักกลับหลังลูกค้าเงียบ: หยิบเรื่องที่คุยค้างไว้มาต่อ ให้คุณค่าหรือภาพงานจริงหนึ่งเรื่อง แล้วปิดด้วยคำถามหรือข้อเสนอเดียว "
  + "แล้วเขียนข้อความทักตามของห้องนี้ด้วยน้ำเสียงเดียวกัน · ข้อเท็จจริงทุกอย่าง (คลาส ราคา รอบ วันที่ รีวิว ลิงก์ ชื่อลูกค้า) ใช้จากข้อมูลของห้องนี้เท่านั้น · "
  + "ป้าย [รอบตามข้อมูลจริง] [ค่าเรียนตามข้อมูลจริง] ในตัวอย่างคือข้อมูลของห้องนั้น ห้ามพิมพ์ป้ายนี้ · ห้ามลอกประโยคของครูทั้งประโยค";
export function renderFollowupExamples(items = []) {
  if (!items.length) return "";
  return [FOLLOWUP_BANK_HEADER, ...items.map((item, i) => [
    `ตัวอย่างของครู ${i + 1}`,
    item.prev ? `ลูกแพรพูดล่าสุด: ${clip(item.prev, 240)}` : "",
    item.user ? `ลูกค้าพูดล่าสุด: ${clip(item.user, 200)}` : "",
    `ครูทักตาม: ${clip(item.reply, MAX_REPLY_CHARS)}`,
  ].filter(Boolean).join("\n"))].join("\n\n");
}
/** กติกาทักตาม + ตัวอย่างของครูที่คล้ายห้องนี้ · ไม่มีคลัง = กติกาเดิมทุกไบต์ */
export function withFollowupExamples(rules, bank, { threadKind = "", userText = "", prevBot = "", k = FOLLOWUP_STYLE_BANK_K } = {}) {
  const block = renderFollowupExamples(selectStyleExamples(bank, { stage: threadKind || "none", userText, prevBot, k }));
  return block ? `${rules}\n\n${block}` : rules;
}
