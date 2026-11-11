// socialProof.mjs — รูปและรีวิวคนจริงที่ลูกแพรแนบเอง ทั้งตอนคุยปกติ (v3) และตอนทักตาม (พี่ง้วง 12 ต.ค. 2026)
//
// วัดจริง 10–12 ต.ค.: รูปในคำตอบ ~44–50 รูป/วัน แต่ ~85% คือรูปบันได · โปสเตอร์คลาส 7 · รูปบรรยากาศ 2 ในสองวัน
// · ลิงก์รีวิวผู้เรียน 0–1/วันในคำตอบ และ 0 ในการทักตาม (ก่อนเครื่อง v3 ราว 18 ลิงก์/วัน) — v3 แนบรีวิวเฉพาะจังหวะให้กำลังใจ/ข้อกังวล
// และทักตามแทบไม่แนบอะไรเลย (โมเดลเลือกแนบเองได้ = ส่วนใหญ่ไม่แนบ)
//
// พี่ง้วง: "รูปส่งได้มากกว่า 1 ครั้ง ... ไม่ว่าจะ follow หรือคุยปกติ" · "ส่งรูปบ่อยหน่อย จะได้ดู humanize" · "รีวิวคนจริงก่อนบรรยากาศในคลาส"
//   ทักตาม: หลังรูปบันไดตามปกติ → (1) ทักครั้งแรก = รีวิวคนจริงที่ตรงกับลูกค้า → (2) ครั้งถัดไป = รูปบรรยากาศคลาสจริง
//   → (3) คุยต่อ = รีวิวที่ตรงกับเขาเพิ่มได้ → (4) ลูกค้าจาง ๆ = ชวนลองคลาสทดลองเรียนฟรี (จำกัดสิทธิ์ต่อวัน — เพดานจริง: trialInvites.mjs)
//   "1–5 ทำได้ไม่ต้องรอ follow up ถ้าบทสนทนาพาไป": รู้โจทย์แล้ว/หลังราคา/ข้อกังวล = รีวิว · กังวลว่าเรียนไหว/ถามบรรยากาศ = รูปห้องเรียน
//   · ยังไม่พร้อม/ขอคิดดูก่อน (ที่ v3 เป็นเจ้าของถ้อยคำ) = ชวนทดลองเรียนฟรี
// ผู้ตรวจ 12 ต.ค. (เส้นจริงของห้องที่เงียบ): ทักตามมีเพดานไม้ต่อช่วงเงียบ (ปกติ 2 · ได้ราคาแล้ว/พิมพ์ข้อความเดียว = 1 — นโยบายรอบ 1)
//   ลูกค้าที่เงียบตลอดจึงไม่เคยถึงขั้น (4) — ไม้สุดท้ายของช่วงเงียบ (ห้องที่คุยกันแล้ว) จึงพ่วงคำชวนไปกับของชิ้นหลักของไม้นั้น
//   โดยไม่เพิ่มจำนวนไม้ · ลูกค้าตอบกลับแล้วเงียบ = รีวิวเพิ่มก่อน แล้วไม้สุดท้ายค่อยชวน
// กติกา: ของชิ้นเดียวกัน (คีย์รูป/ลิงก์รีวิว/ลิงก์ทดลองเรียน) ไม่ส่งซ้ำในห้องเดิม · ต่อเทิร์นไม่เกินหนึ่งรูปและหนึ่งรีวิว
//   · ไม่แนบในจังหวะดูแลใจ เงินตึง เรื่องเงิน/ชำระ/สลิป ห้องที่คนดูแลอยู่ ห้องรอยืนยันตัวตนกับระบบเก่า ขั้นสมัคร/ชำระ ทางปิดห้อง/ลา
//   และข้อความแรก (นอกจากบันไดเดิม) · รีวิวต้องเป็นของจริงในคลังที่อนุมัติ เลือกด้วยตัวจับคู่เดิม (reviewSelection.selectReview)
//   · คำนำสั้นหนึ่งประโยค คำลงท้ายผู้หญิง และไม่ซ้ำคำนำเดิมของห้อง
// ไฟล์นี้เป็นตัวตัดสินล้วน (ไม่อ่าน DB ไม่ import pipeline/stage) — ผู้เรียกส่งบัญชีของที่ส่งแล้ว/ด่านคำชวนเข้ามา
// regex ทุกตัวในไฟล์นี้ใช้ตัวนับมีเพดาน (ไม่มี + / * ซ้อนกัน) — ปลอด ReDoS
import { parseCatalogText, reviewFitOf, reviewUrlKey, selectReview } from "../reviewSelection.mjs";
import { ATMOSPHERE_IMAGES, explicitPosterNegated } from "../imageSuggestion.mjs";
import { truncateCodePoints } from "../unicodeText.mjs";
import { sentencesOf } from "./closings.mjs";
import { SYSTEM_SHOWCASE_LABEL, arrivalUrlsIn, capabilityAsk, isShowcaseUrlKey, isSystemShowcase, showcaseWordingRule } from "../showcaseCases.mjs";

const HOUR_MS = 3_600_000;
/** รีวิวที่ลูกแพรแนบเองได้ต่อห้อง (ลูกค้าขอดูเองไม่นับเพดาน แต่ยังไม่ส่งซ้ำ) */
export const ROOM_REVIEW_CAP = 4;
/** ทักตาม: ลูกค้าเงียบมาอย่างน้อยเท่านี้ หรือเงียบผ่านการทักครั้งก่อนไปแล้ว = "จาง ๆ" */
export const FADING_SILENCE_MS = 20 * HOUR_MS;
const REVIEW_CATALOG_TITLE = "รีวิวนักเรียนจริง";
const ADMIN_PREFIX = "[แอดมินทีมงานพิมพ์เอง]";
const REVIEW_LEAD_STAGES = new Set(["REASSURE", "OBJECTION"]);
// การ์ดราคา/ส่วนลดคนเดียว = ฝากรีวิวคนจริงต่อท้ายการ์ด (แบบเดียวกับทักตามที่แจ้งราคาที่ค้าง 12 ต.ค.) · ดีลคู่ยาวอยู่แล้ว (ราคาปกติ + ราคาคู่) ไม่เพิ่ม
const PRICE_STAGES = new Set(["PRICE", "DEAL_SINGLE"]);
const GOAL_STAGES = new Set(["BRIDGE", "DISCOVERY", "CONCEPT"]);
const CLASS_NAMES = Object.freeze({ business: "AI Agent for Business", workflow: "AI Agent Workflow Automation" });

// ลูกค้าขอดูรีวิว/ตัวอย่างงานเอง (ขอ/อยากดู/มี … รีวิว · ส่ง … รีวิว … หน่อย/ให้ดู · รีวิว … ไหม/หน่อย/บ้าง)
// ผู้ตรวจ 12 ต.ค.: "ขอบคุณสำหรับรีวิว" (ขอ…รีวิว) และ "ส่งรีวิวให้ทีมแล้ว" เคยนับเป็นการขอ → ข้ามระยะห่าง/เพดานแล้วได้รีวิวใบที่สองทันที
export const EVIDENCE_ASK_RE = /(?:ขอ(?!บคุณ)|อยาก|มี)[^\n]{0,10}?(?:รีวิว|ตัวอย่างงาน|ผลงาน(?:ของ)?ผู้เรียน)|ส่ง[^\n]{0,8}?(?:รีวิว|ตัวอย่างงาน)[^\n]{0,10}?(?:ให้ดู|หน่อย|ได้ไหม|ได้มั้ย|ไหม|มั้ย|ด้วย(?:นะ|ค่ะ|คะ|ครับ|$))|(?:รีวิว|ผลงานผู้เรียน)[^\n]{0,10}?(?:ไหม|มั้ย|มั๊ย|หน่อย|บ้าง)/u;
// ลูกค้าพูดถึงรีวิวของตัวเอง/ขอบคุณที่ได้รีวิว (ศิษย์เก่าอยากเขียนรีวิว · ส่งรีวิวให้แล้ว) — ไม่ใช่การขอดู
export const OWN_REVIEW_RE = /เขียนรีวิว|รีวิวให้(?:แล้ว|พี่|ลูกแพร|ทีม|แอด)|(?:ส่ง|ทำ|ให้|ลง)รีวิว[^\n]{0,12}?แล้ว|ขอบคุณ(?:มาก)?(?:นะ)?(?:ค่ะ|คะ|ครับ)?\s?(?:สำหรับ|ที่(?:ส่ง|แนบ|แชร์|ให้))[^\n]{0,8}?รีวิว/u;
const NO_EVIDENCE_RE = /(?:ไม่ต้อง|ไม่เอา|อย่า|งด|ไม่อยาก)[^\n]{0,8}?(?:ส่ง|ดู)?[^\n]{0,4}?(?:รีวิว|คลิป|ตัวอย่าง)/u;
/** ลูกค้าขอดูรีวิว/ผลงานเองจริง ๆ (ไม่ใช่ขอบคุณ ไม่ใช่รีวิวของตัวเอง ไม่ใช่บอกว่าไม่ต้องส่ง) */
export const asksForEvidence = (text = "") => EVIDENCE_ASK_RE.test(String(text)) && !NO_EVIDENCE_RE.test(String(text)) && !OWN_REVIEW_RE.test(String(text));
// ถามบรรยากาศ/รูปแบบการสอน/ขนาดห้อง ("สอนยังไง" · "ห้องหนึ่งกี่คน" · "กลุ่มเล็กไหม")
// — "สมัครเรียนยังไง" (ขั้นสมัคร) · "ค่าเรียนยังไง"/"ราคาเรียนยังไง" (ราคา) · "โอนเงินเรียนยังไง" (ชำระ) ไม่นับ
export const ATMOSPHERE_ASK_RE = /บรรยากาศ|ห้องเรียน|กลุ่มเล็ก|ใกล้ชิด|ดูแลทั่วถึง|(?:คลาส|ห้อง|รุ่น)[^\n]{0,8}?กี่คน|กี่คน(?:ต่อ)?(?:รุ่น|คลาส|ห้อง)|สอน(?:ยังไง|แบบไหน|อย่างไร)|(?<!สมัคร|ค่า|ราคา|โอน|โอนเงิน|จ่าย|จ่ายเงิน|ชำระ|ชำระเงิน)เรียน(?:ยังไง|แบบไหน|อย่างไร)|รูปแบบ(?:การ)?(?:สอน|เรียน)/u;
// กังวลว่าตัวเองเรียนไหว/ตามทัน (มือใหม่ · ไม่มีพื้นฐาน · ยากไหม · อายุเยอะ) = รูปห้องเรียนจริง — "คุ้มไหม" (เรื่องคุณค่า) ไม่นับ
// · "ทดลองใช้แล้วแต่ยังไม่เก่ง" คือบอกระดับ ไม่ใช่ความกังวล (รอบ 2 ของ reviewJourney) — "ไม่เก่ง" เดี่ยว ๆ ไม่นับ
// ผู้ตรวจ 12 ต.ค.: "AI จะทำได้ไหม ตอบแชทลูกค้าแทน" (ถามความสามารถของ AI) และ "อยากเรียนให้ตามทันเทรนด์" (เป้าหมาย) ไม่ใช่ความกังวล
//   → "จะทำได้ไหม" ต้องมีตัวผู้พูด · "ทัน" ต้องเป็นปฏิเสธหรือคำถาม
export const ABILITY_DOUBT_RE = /มือใหม่|ไม่มีพื้นฐาน|ตามไม่ทัน|(?:เรียน|ตาม)(?:จะ)?ทัน(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า)|ยาก(?:ไหม|มั้ย|ไป)|เรียน(?:ได้|ไหว)(?:ไหม|มั้ย)|(?:เรา|ผม|ฉัน|หนู|ดิฉัน|ตัวเอง)[^\n]{0,8}?จะ(?:ทำ|เรียน)(?:ได้|ไหว)(?:ไหม|มั้ย)|อายุเยอะ|ไม่ใช่สาย(?:ไอที|เทค|IT)|กลัว[^\n]{0,12}?(?:ไม่ทัน|ไม่ได้|ไม่ไหว|ไม่เป็น)|ไม่(?:ค่อย)?มั่นใจว่า[^\n]{0,12}?(?:เรียน|ทำ)/iu;
// เรื่องเงิน/ชำระ/สลิปในข้อความนี้ = ไม่แนบอะไร (เลน v3 ส่งเรื่องพวกนี้ให้เครื่องเดิมอยู่แล้ว — ชั้นนี้กันซ้ำ) · "ค่าใช้จ่าย"/"แจกจ่าย" ไม่นับ
const PAYMENT_TALK_RE = /โอน|เลขบัญชี|พร้อมเพย์|สลิป|ชำระ|(?<!ใช้|แจก)จ่าย|ผ่อน|มัดจำ|ใบเสร็จ|ใบกำกับ|คืนเงิน|เงินคืน/u;
// คำชวนทดลองเรียน: ห้ามตัวเลขสิทธิ์/ที่นั่งที่ไม่ได้มาจากตัวนับ และห้ามอ้างว่าสิทธิ์/ที่นั่งใกล้เต็มหรือใกล้หมด — ประโยคแบบนี้ถูกตัดทิ้งก่อนส่ง
// ผู้ตรวจ 12 ต.ค.: เดิมหลุด "เหลือสิทธิ์ 3 ที่" · "เหลือสิทธิ์ทดลองเรียนแค่ 2 ที่" · "จำกัดวันละ 10 สิทธิ์" · "เหลือไม่กี่สิทธิ์" · "สิทธิ์ใกล้หมด"
export const FAKE_SCARCITY_RE = new RegExp([
  "เหลือ[^\\n]{0,24}?\\d{1,4}\\s?(?:สิทธิ์|สิทธิ|ที่นั่ง|ที่|ท่าน|คน)",
  "(?:อีก|แค่|เพียง)\\s?\\d{1,4}\\s?(?:สิทธิ์|สิทธิ|ที่นั่ง|ท่าน)",
  "\\d{1,4}\\s?(?:สิทธิ์|สิทธิ|ที่นั่ง|ท่าน|ที่)\\s?(?:สุดท้าย|เท่านั้น)",
  "(?:วันละ|ต่อวัน)\\s?(?:แค่|เพียง|ไม่เกิน)?\\s?\\d{1,4}\\s?(?:สิทธิ์|สิทธิ|ที่นั่ง|ท่าน|คน|ที่)",
  "\\d{1,4}\\s?(?:สิทธิ์|สิทธิ|ท่าน|ที่)\\s?(?:ต่อ|/)\\s?วัน",
  "เหลือ(?:อยู่)?(?:แค่|เพียง)?(?:ไม่กี่|น้อย)",
  "(?:สิทธิ์|สิทธิ|ที่นั่ง|คลาส|รอบ)[^\\n]{0,12}?(?:ใกล้|จะ|กำลังจะ)\\s?(?:เต็ม|หมด)",
  "ที่นั่ง[^\\n]{0,8}?(?:จำกัด|เหลือน้อย|มีไม่มาก|ใกล้หมด)",
  "(?:หมดเขต|ปิดรับ)\\s?(?:วันนี้|คืนนี้|พรุ่งนี้)",
].join("|"), "u");
export const SOCIAL_PROOF_PATTERNS = Object.freeze({ EVIDENCE_ASK_RE, OWN_REVIEW_RE, NO_EVIDENCE_RE, ATMOSPHERE_ASK_RE, ABILITY_DOUBT_RE,
  PAYMENT_TALK_RE, FAKE_SCARCITY_RE });

// ข้อเท็จจริงของรูปบรรยากาศ (คำอธิบายในแคตตาล็อกรูปที่อนุมัติ image-catalog.json) — ใช้เป็นคำนำของรูปเท่านั้น ไม่เติมเกินนี้
export const ATMOSPHERE_FACTS = Object.freeze({
  "classroom-atmosphere-1": "พี่ง้วงสอนกลุ่มเล็กดูแลใกล้ชิด",
  "classroom-atmosphere-2": "สอนสดถาม-ตอบใกล้ชิด",
});
const clip = (text, n) => truncateCodePoints(String(text || ""), n);

/** คลังรีวิวจากการ์ด "รีวิวนักเรียนจริง" (สมองรุ่นที่ใช้อยู่/คลังเดิม) — ไม่มีการ์ด = อ่านจากก้อนความรู้ของเทิร์น */
export function reviewCatalogOf({ entries = [], knowledgeText = "" } = {}) {
  const card = (Array.isArray(entries) ? entries : [])
    .find((entry) => String(entry?.title || "").includes(REVIEW_CATALOG_TITLE) && entry?.active !== 0);
  const rows = card ? parseCatalogText(card.content) : [];
  return rows.length ? rows : parseCatalogText(String(knowledgeText || ""));
}

/** ลิงก์รีวิวที่ห้องนี้ได้ไปแล้วทั้งหมด (ตัวนับของ DB + ลิงก์ในคำตอบของลูกแพรในประวัติ) — คีย์ตัวเดียวกับตัวกันซ้ำ */
export function sentReviewKeys(sentUrls = null, history = []) {
  const keys = new Set();
  for (const url of sentUrls || []) { const key = reviewUrlKey(url); if (key) keys.add(key); }
  for (const turn of Array.isArray(history) ? history : []) {
    // 19 ต.ค. 2026: รหัสหน้าเว็บที่ลูกค้ากดมา (เคส WF-… / รหัส RV-…) = ของชิ้นนั้นเขาดูแล้ว
    if (turn?.role === "user") { for (const url of arrivalUrlsIn([String(turn.content || "")])) { const key = reviewUrlKey(url); if (key) keys.add(key); } continue; }
    if (turn?.role !== "assistant") continue;
    for (const url of String(turn.content || "").match(/https:\/\/[^\s<>]+/gu) || []) { const key = reviewUrlKey(url); if (key) keys.add(key); }
  }
  return keys;
}

const asSet = (value) => (value instanceof Set ? value : new Set(Array.isArray(value) ? value : []));
/** รูปบรรยากาศใบถัดไปที่ห้องนี้ยังไม่เคยได้ (และอนุมัติในแคตตาล็อก) — "" = ส่งครบแล้ว/ไม่มีรูป */
export function nextAtmosphereKey(allowedImages, sentImageKeys) {
  const allowed = asSet(allowedImages);
  const sent = asSet(sentImageKeys);
  return ATMOSPHERE_IMAGES.find((key) => allowed.has(key) && !sent.has(key)) || "";
}
export const atmosphereSent = (sentImageKeys) => ATMOSPHERE_IMAGES.some((key) => asSet(sentImageKeys).has(key));

/**
 * คีย์รูปในก้อนข้อความล่าสุดของลูกแพร (ก่อนข้อความลูกค้าเทิร์นนี้) จากแถว messagesFor (ใหม่ → เก่า)
 * ใช้เว้นจังหวะรูปบรรยากาศ: ก้อนก่อนเพิ่งมีรูปบรรยากาศ = เทิร์นนี้ไม่ส่งใบที่สองติดกัน
 */
export function lastBurstImageKeys(rowsNewestFirst = []) {
  const rows = Array.isArray(rowsNewestFirst) ? rowsNewestFirst : [];
  let i = 0;
  while (i < rows.length && rows[i]?.direction === "in") i += 1;
  const keys = [];
  for (; i < rows.length && rows[i]?.direction === "out"; i += 1) {
    const key = /^\[image:([a-z0-9-]{1,80})\]/iu.exec(String(rows[i]?.content || ""))?.[1];
    if (key) keys.push(key.toLowerCase());
  }
  return keys;
}

/** รีวิวคนจริงที่ตรงกับลูกค้าที่สุดที่ยังไม่เคยส่ง (ตัวจับคู่เดิม: ธุรกิจ/กลุ่มลูกค้า/คลาส/รูปแบบ) + เหตุที่ตรง */
export function pickSocialReview(catalog = [], { sentKeys = new Set(), history = [], text = "", personaType = "", classKey = null } = {}) {
  const course = CLASS_NAMES[classKey] ? classKey : null;
  const review = selectReview(catalog, { sentUrls: sentKeys, history, text, personaType, kind: "testimonial", course });
  if (!review) return null;
  return { review, fit: reviewFitOf(review, { history, text, personaType, course }) };
}

function lastBotBurst(history = []) {
  const turns = Array.isArray(history) ? history : [];
  const out = [];
  for (let i = turns.length - 1; i >= 0 && turns[i]?.role === "assistant"; i -= 1) out.unshift(String(turns[i]?.content ?? ""));
  return out;
}

// เทิร์นที่ไม่แนบของใด ๆ เลย (คำตอบยังเป็นของ v3 ตามปกติ)
function chatExclusion(d, f) {
  const mods = d.modifiers || [];
  if (["EXIT", "SILENT", "FIRST_CONTACT"].includes(d.stage)) return d.stage.toLowerCase();
  if (d.stage === "SCREEN_PRICE" && d.ladder) return "ladder";
  if (f.firstReply) return "first_contact";
  if (mods.includes("money_hardship")) return "money_hardship";
  if (d.reason === "care_moment" || d.care || f.disclosure?.careMode) return "care";
  if (PAYMENT_TALK_RE.test(String(f.text || ""))) return "payment";
  if (d.enroll || d.enrollOpening || d.roundPick || d.logistics === "booking" || d.paymentAsk) return "registration";
  if (f.trialLinkRequested) return "trial_link";
  if (lastBotBurst(f.history).some((text) => text.startsWith(ADMIN_PREFIX))) return "human_owned";
  return "";
}
const quietTurn = (d) => Boolean(d.softDecline || d.offerDeclined || d.notReady || d.classDeclined || d.reason === "confused_after_price");
/** ห้องนี้เคยได้รีวิวผู้เรียน (ไม่นับตัวอย่างระบบที่ทำด้วย AI Agent — ตัวอย่างไม่ใช่รีวิว แต่ยังนับเพดาน/กันส่งซ้ำ) */
const hasTestimonialKey = (keys) => [...keys].some((key) => !isShowcaseUrlKey(key));

function chatReviewTrigger(d, f) {
  const text = String(f.text || "");
  // ลา/ปิดบทสนทนา และ "ไม่ต้องส่งรีวิว" มาก่อนเสมอ — แม้ประโยคจะมีคำว่ารีวิว
  if (d.stage === "GOODBYE" || NO_EVIDENCE_RE.test(text)) return "";
  if (asksForEvidence(text)) return "asked";
  if (REVIEW_LEAD_STAGES.has(d.stage) && !quietTurn(d)) return "objection";
  if (PRICE_STAGES.has(d.stage)) return "price";
  // รู้โจทย์ "ในข้อความนี้" (ลูกค้าเพิ่งเล่าเอง) — โจทย์จากผลอ่านของ scorer ติดอยู่ทุกเทิร์น ไม่ใช่จังหวะใหม่
  const evidence = String(f.goal?.evidence || "").slice(0, 40);
  if (evidence && text.includes(evidence) && GOAL_STAGES.has(d.stage)) return "goal";
  return "";
}

/**
 * แผนของเทิร์นคุยปกติ (v3) — { review, reviewTrigger, reviewFit, image, imageTrigger, trial, trialTrigger, skipped }
 * review = แถวในคลัง (ช่อง {{รีวิว}}) · image = { key } (ระบบแนบให้ถ้าโมเดลลืม) · trial = { url } (ช่อง {{ทดลองเรียน}} · ผู้เรียกจองสิทธิ์ก่อนใช้)
 * input: facts/decision ของเทิร์น · catalog · sentUrls (ลิงก์รีวิวที่ห้องได้แล้ว) · imageKeys (รูปที่ห้องได้แล้ว) · allowedImages
 *   · lastBurstImages = คีย์รูปในก้อนล่าสุดของลูกแพร · trialInvite = { available, url } จากด่านคำชวน · deferSaid = ลูกค้าขอเวลาคิด
 */
export function planChatSocialProof({ facts: f = {}, decision: d = {}, catalog = [], sentUrls = null, imageKeys = [], allowedImages = [],
  personaType = "", trialInvite = null, deferSaid = false, lastBurstImages = [] } = {}) {
  const plan = { review: null, reviewTrigger: "", reviewFit: "", image: null, imageTrigger: "", trial: null, trialTrigger: "", skipped: "" };
  const excluded = chatExclusion(d, f);
  if (excluded) return { ...plan, skipped: excluded };
  const history = Array.isArray(f.longHistory) && f.longHistory.length ? f.longHistory : (f.history || []);
  const sentKeys = sentReviewKeys(sentUrls, [...history, { role: "user", content: String(f.text || "") }]);
  const matchText = [f.text, f.goal?.evidence, f.painPoint].filter(Boolean).join("\n");

  const reviewTrigger = chatReviewTrigger(d, f);
  const spaced = !lastBotBurst(f.history).some((text) => (text.match(/https:\/\/[^\s<>]+/gu) || []).some((url) => reviewUrlKey(url)));
  const roomRoom = sentKeys.size < ROOM_REVIEW_CAP;
  // 19 ต.ค. 2026: "เรียนแล้วทำอะไรได้บ้าง / ใช้ได้จริงไหม / เอาไปใช้กับธุรกิจได้ไหม" = ตัวอย่างระบบที่ทำด้วย AI Agent หนึ่งชิ้นที่ตรงกับธุรกิจเขา
  // ก่อนรีวิวของจังหวะ "เพิ่งเล่าโจทย์" (คำถามนี้ถามว่าเอาไปทำอะไรได้ ไม่ใช่ขอดูคนจริง) — ขอดูเอง/ข้อกังวล/หลังราคา ยังเป็นรีวิวตามเดิม
  // เว้นจังหวะ + เพดานห้องเดียวกับรีวิว · ไม่มีตัวอย่างระบบในคลัง/ส่งครบแล้ว = ทางเดิมทุกอย่าง
  const capability = (!reviewTrigger || reviewTrigger === "goal") && d.stage !== "GOODBYE" && !quietTurn(d)
    && !NO_EVIDENCE_RE.test(String(f.text || "")) && capabilityAsk(String(f.text || ""));
  const showcase = capability && spaced && roomRoom
    ? selectReview(catalog, { sentUrls: sentKeys, history, text: matchText, personaType, kind: "showcase", scope: "system" }) : null;
  if (showcase) Object.assign(plan, { review: showcase, reviewTrigger: "capability", reviewFit: "" });
  else if (reviewTrigger) {
    if (reviewTrigger === "asked" || (spaced && roomRoom)) {
      // จังหวะให้กำลังใจ/ข้อกังวล/ขอดูเอง: ตัวเลือกหลักฐานเดิม (journey) ก่อน — ไม่มีค่อยใช้รีวิวคนจริงที่ตรงกับเขา
      const journey = (reviewTrigger === "asked" || reviewTrigger === "objection") && f.review && !sentKeys.has(reviewUrlKey(f.review.url)) ? f.review : null;
      const picked = journey ? { review: journey, fit: reviewFitOf(journey, { history, text: matchText, personaType }) }
        : pickSocialReview(catalog, { sentKeys, history, text: matchText, personaType, classKey: f.classKey });
      if (picked) Object.assign(plan, { review: picked.review, reviewTrigger, reviewFit: picked.fit });
      else plan.skipped = "review_exhausted";
    } else plan.skipped = spaced ? "review_room_cap" : "review_spacing";
  } else if (capability && !(spaced && roomRoom)) plan.skipped = spaced ? "review_room_cap" : "review_spacing";

  const text = String(f.text || "");
  const doubt = ABILITY_DOUBT_RE.test(text) ? "doubt" : ATMOSPHERE_ASK_RE.test(text) ? "atmosphere_ask" : "";
  if (doubt && d.stage !== "GOODBYE" && !quietTurn(d) && !explicitPosterNegated(text)) {
    const poster = f.imageOffer;
    const posterWins = poster?.key && !ATMOSPHERE_IMAGES.includes(poster.key) && (poster.mustAttach || poster.explicitAsk || poster.servicePoster);
    // ก้อนก่อนเพิ่งมีรูปบรรยากาศ = ไม่ส่งใบที่สองติดกัน (ผู้ตรวจ 12 ต.ค.: กังวลสองเทิร์นติด = ได้รูปทั้งสองใบติดกัน)
    const spacedPhoto = ![...asSet(lastBurstImages)].some((key) => ATMOSPHERE_IMAGES.includes(key));
    const key = posterWins || !spacedPhoto ? "" : nextAtmosphereKey(allowedImages, imageKeys);
    if (key) Object.assign(plan, { image: { key }, imageTrigger: doubt });
    else if (!spacedPhoto && !plan.skipped) plan.skipped = "photo_spacing";
  }

  const trialTrigger = d.stage === "OBJECTION" && d.notReady && !d.softDecline && !d.offerDeclined && !d.classDeclined ? "not_ready"
    : d.stage === "GOODBYE" && deferSaid ? "defer" : "";
  const engaged = Boolean(f.priceQuoted || f.classKey || f.goal || f.roundsSent);
  if (trialTrigger && engaged && trialInvite?.available && trialInvite.url) {
    Object.assign(plan, { trial: { url: trialInvite.url }, trialTrigger });
  }
  return plan;
}

/**
 * แผนของการทักตามหนึ่งไม้ (ห้อง v3 ที่มีเรื่องค้าง)
 * — { kind: "review" | "atmosphere" | "trial", review?, fit?, imageKey?, url?, trial?: { url }, step } | null
 * ของชิ้นหลัก: ยังไม่เคยได้รีวิว = รีวิว → ยังไม่เคยได้รูปบรรยากาศ = รูป → คุยต่อหลังของชิ้นล่าสุด = รีวิวเพิ่ม
 * คำชวนทดลองเรียนฟรี (ห้องที่คุยกันแล้ว · ยังมีสิทธิ์ของวันนี้ · ด่านคำชวนเปิด):
 *   · ไม้สุดท้ายของช่วงเงียบ (finalTouch) = พ่วงไปกับของชิ้นหลักของไม้นั้น — ไม่เพิ่มจำนวนไม้ (นโยบายรอบ 1)
 *   · ไม่มีของชิ้นหลักแล้ว และลูกค้าจาง ๆ หรือเป็นไม้สุดท้าย = คำชวนอย่างเดียว
 * การทักที่ส่งของค้าง (ราคา/รายละเอียด) แนบได้แค่รีวิว · ทักครั้งเดียว/ขั้นสมัคร/ทีมงานถามค้าง/แจ้งราคาที่ค้าง = ไม่แนบ (นโยบายรอบ 1)
 */
export function planFollowupSocialProof({ thread = null, plan = null, delivery = false, catalog = [], sentUrls = null, imageKeys = [], allowedImages = [],
  history = [], text = "", personaType = "", classKey = null, fading = false, continued = false, finalTouch = false, engaged = true,
  trialInvite = null, excluded = "" } = {}) {
  if (!thread || excluded || plan?.questionOnly || plan?.withReview || thread.askedBy === "team") return null;
  const sentKeys = sentReviewKeys(sentUrls, history);
  const review = () => pickSocialReview(catalog, { sentKeys, history, text, personaType, classKey });
  const trialUrl = engaged && !delivery && trialInvite?.available && trialInvite.url ? trialInvite.url : "";
  const withTrial = (out) => (trialUrl && finalTouch ? { ...out, trial: { url: trialUrl } } : out);
  if (!hasTestimonialKey(sentKeys)) {
    const first = review();
    if (first) return delivery ? { kind: "review", ...first, step: "first_review" } : withTrial({ kind: "review", ...first, step: "first_review" });
  }
  if (delivery) return null;
  if (!atmosphereSent(imageKeys)) {
    const key = nextAtmosphereKey(allowedImages, imageKeys);
    if (key) return withTrial({ kind: "atmosphere", imageKey: key, step: "first_photo" });
  }
  if (continued && sentKeys.size < ROOM_REVIEW_CAP) {
    const more = review();
    if (more) return withTrial({ kind: "review", ...more, step: "more_review" });
  }
  if (trialUrl && (fading || finalTouch)) return { kind: "trial", url: trialUrl, step: "fading_trial" };
  return null;
}

/** ลูกค้าจาง ๆ ในช่วงเงียบนี้: เงียบผ่านการทักครั้งก่อนไปแล้ว หรือเงียบนานเกิน 20 ชม. */
export function followupFading({ typedAt = 0, nowMs = 0, priorTouchAts = [] } = {}) {
  const typed = Number(typedAt) || 0;
  if (!typed) return false;
  if ((Array.isArray(priorTouchAts) ? priorTouchAts : []).some((at) => Number(at) > typed)) return true;
  return Number(nowMs) - typed >= FADING_SILENCE_MS;
}

// ---- ถ้อยคำ ----
// "sector" = ธุรกิจที่ลูกค้าเล่าตรงกับป้ายรีวิว · "role" = ตรงด้วยตำแหน่ง/สายงานหรือกลุ่มลูกค้าที่ระบบอ่าน (ไม่ใช่ธุรกิจเดียวกัน)
const FIT_TEXT = Object.freeze({ sector: "ธุรกิจใกล้เคียงกับเขา", role: "สายงานใกล้เคียงกับเขา", course: "เรียนคลาสเดียวกับที่เขาสนใจ" });
// คำชวนพร้อมลิงก์และประโยค "จำกัดสิทธิ์ต่อวัน" อยู่ในช่อง {{ทดลองเรียน}} (โค้ดเขียน — จริงตามเพดาน) · ข้อความที่โมเดลพิมพ์เองแค่รับคำอย่างใส่ใจ
export const TRIAL_TASK_LINE = "- เขายังไม่พร้อมตัดสินใจตอนนี้: รับคำเขาอย่างใส่ใจและไม่เร่งหนึ่งถึงสองประโยค แล้ววาง {{ทดลองเรียน}} ไว้บรรทัดของมันเอง "
  + "(ในช่องมีคำชวนลองคลาสทดลองเรียนฟรีพร้อมลิงก์ และเรื่องสิทธิ์ที่ลูกแพรเปิดได้จำกัดต่อวันแล้ว ไม่ต้องชวนซ้ำหรือพิมพ์ลิงก์เอง) "
  + "— ห้ามใส่ตัวเลขจำนวนสิทธิ์ ห้ามบอกว่าที่นั่งของคลาสใกล้เต็มหรือเหลือน้อย";

/** บรรทัดงานของเทิร์นคุยปกติ (ส่วนต่อเทิร์น — บล็อกคงที่ไม่เปลี่ยน แคชเดิมใช้ได้) · จังหวะให้กำลังใจ/ข้อกังวลมีบรรทัดรีวิวในขั้นของมันเองแล้ว */
export function socialProofTaskLines(f = {}, d = {}) {
  const sp = f.socialProof;
  if (!sp) return [];
  const lines = [];
  if (sp.review && !REVIEW_LEAD_STAGES.has(d.stage) && isSystemShowcase(sp.review)) {
    lines.push(`- แนบ${SYSTEM_SHOWCASE_LABEL}ที่ระบบเลือกให้ตรงกับเรื่องที่เขาถามแล้ว (${clip(sp.review.who, 90)}): `
      + `เขียนนำสั้น ๆ หนึ่งประโยคเป็นธรรมชาติว่าระบบนี้ช่วยงานแบบไหน แล้ววาง {{รีวิว}} ไว้บรรทัดของมันเอง — ${showcaseWordingRule()}`);
  } else if (sp.review && !REVIEW_LEAD_STAGES.has(d.stage)) {
    lines.push(`- แนบรีวิวผู้เรียนจริงที่ระบบเลือกให้ตรงกับเขาแล้ว (${clip(sp.review.who, 90)}${FIT_TEXT[sp.reviewFit] ? ` · ${FIT_TEXT[sp.reviewFit]}` : ""}): `
      + "เขียนนำสั้น ๆ หนึ่งประโยคเป็นธรรมชาติว่าทำไมรีวิวนี้ตรงกับเขา แล้ววาง {{รีวิว}} ไว้บรรทัดของมันเอง — ไม่แต่งคำพูด ยอดขาย หรือผลลัพธ์ของคนในรีวิว");
  }
  if (sp.image) {
    lines.push(`- เทิร์นนี้แนบ [IMAGE:${sp.image.key}] (รูปบรรยากาศคลาสจริง: ${ATMOSPHERE_FACTS[sp.image.key] || "บรรยากาศการสอนสด"}) `
      + "พร้อมประโยคสั้น ๆ หนึ่งประโยคว่ารูปนี้ช่วยให้เขาเห็นภาพเรื่องที่ถามหรือกังวลยังไง วางไว้ก่อนย่อหน้าสุดท้าย");
  }
  if (sp.trial) lines.push(TRIAL_TASK_LINE);
  return lines;
}

/** ตัดประโยคที่อ้างจำนวนสิทธิ์/ที่นั่งที่ไม่ได้มาจากตัวนับ (เฉพาะข้อความชวนทดลองเรียน) — บรรทัดช่องเติม/รูปคงไว้ */
export function stripFakeScarcity(text = "") {
  return String(text).split("\n").map((line) => {
    if (!FAKE_SCARCITY_RE.test(line)) return line;
    return sentencesOf(line).filter((sentence) => !FAKE_SCARCITY_RE.test(sentence)).join(" ");
  }).join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

// ---- ถ้อยคำของการทักตาม (โค้ดเขียนเองทั้งหมด — จริงตามข้อมูลที่อนุมัติ ไม่ให้โมเดลแต่งเรื่องผู้รีวิว) ----
export const FOLLOWUP_SOCIAL_RULES = Object.freeze({
  review: "- ไม้นี้ระบบแนบรีวิวจากผู้เรียนจริงที่ตรงกับลูกค้าไปกับข้อความนี้ให้แล้ว (ไม่ต้องใส่ลิงก์หรือชื่อผู้รีวิวเอง ไม่แต่งคำพูดหรือผลลัพธ์ของผู้รีวิว)",
  atmosphere: "- ไม้นี้ระบบแนบรูปบรรยากาศคลาสจริงพร้อมคำนำไปกับข้อความนี้ให้แล้ว (ไม่ต้องพูดถึงรูปเอง)",
  trial: "- ไม้นี้ระบบแนบคำชวนลองคลาสทดลองเรียนฟรีพร้อมลิงก์ไปกับข้อความนี้ให้แล้ว (ไม่ต้องพูดถึงคลาสทดลองหรือใส่ลิงก์เอง ห้ามใส่ตัวเลขจำนวนสิทธิ์หรือบอกว่าที่นั่งใกล้เต็ม)",
});
/** บรรทัดกติกาของของที่แนบไม้นี้ (ของชิ้นหลัก + คำชวนที่พ่วงมา) — ไม่มีของแนบ = [] (พรอมต์เดิมทุกไบต์) */
export function followupSocialRuleLines(thread = null) {
  const lines = [];
  if (FOLLOWUP_SOCIAL_RULES[thread?.socialAttach]) lines.push(FOLLOWUP_SOCIAL_RULES[thread.socialAttach]);
  if (thread?.socialTrial && thread.socialAttach !== "trial") lines.push(FOLLOWUP_SOCIAL_RULES.trial);
  return lines;
}

// คำนำหลายแบบต่อชนิด — ห้องเดิมไม่ได้คำนำเดิมซ้ำ (ผู้ตรวจ 12 ต.ค.: สองไม้ในห้องเดียวกันขึ้นต้นเหมือนกันทุกคำ อ่านแล้วเป็นบอท)
const REVIEW_INTROS = Object.freeze({
  sector: ["ฝากรีวิวของผู้เรียนจริงที่ทำธุรกิจใกล้เคียงกันไว้ให้ดูนะคะ", "มีรีวิวจากผู้เรียนจริงที่ทำธุรกิจคล้าย ๆ กันมาฝากค่ะ",
    "ลูกแพรเลือกรีวิวของผู้เรียนที่ทำธุรกิจใกล้เคียงกันมาให้ดูประกอบนะคะ"],
  role: ["ฝากรีวิวของผู้เรียนจริงที่ทำงานสายใกล้เคียงกันไว้ให้ดูนะคะ", "มีรีวิวจากผู้เรียนจริงที่ทำงานคล้าย ๆ กันมาฝากค่ะ",
    "ลูกแพรเลือกรีวิวของผู้เรียนที่ทำงานสายใกล้เคียงกันมาให้ดูประกอบนะคะ"],
  general: ["ฝากรีวิวจากผู้เรียนจริงไว้ให้ดูประกอบนะคะ", "มีรีวิวจากผู้เรียนจริงมาฝากให้ดูค่ะ", "ลูกแพรฝากรีวิวของผู้เรียนจริงไว้ให้ดูเพิ่มนะคะ"],
});
const courseIntros = (name) => [`ฝากรีวิวของผู้เรียนจริงจากคลาส ${name} ไว้ให้ดูนะคะ`, `มีรีวิวจากผู้เรียนคลาส ${name} มาฝากค่ะ`,
  `ลูกแพรเลือกรีวิวของผู้เรียนคลาส ${name} มาให้ดูประกอบนะคะ`];
const ATMOSPHERE_LEADS = Object.freeze(["ส่งรูปบรรยากาศคลาสจริงให้ดูนะคะ", "อีกมุมของคลาสจริงค่ะ", "ฝากรูปจากคลาสจริงไว้ให้เห็นภาพนะคะ"]);

/** แบบที่ห้องนี้ยังไม่เคยได้ · ใช้ครบแล้ว = แบบที่ใช้ครั้งล่าสุดนานที่สุด (usedTexts เรียงใหม่ → เก่า) */
export function pickUnusedVariant(variants = [], usedTexts = []) {
  const used = (Array.isArray(usedTexts) ? usedTexts : []).map((text) => String(text || ""));
  let best = variants[0] || "";
  let bestAge = -1;
  for (const variant of variants) {
    const age = used.findIndex((text) => text.includes(variant));
    if (age < 0) return variant;
    if (age > bestAge) { best = variant; bestAge = age; }
  }
  return best;
}
export function followupReviewIntro(fit = "", classKey = null, usedTexts = []) {
  if (fit === "sector" || fit === "role") return pickUnusedVariant(REVIEW_INTROS[fit], usedTexts);
  if (fit === "course" && CLASS_NAMES[classKey]) return pickUnusedVariant(courseIntros(CLASS_NAMES[classKey]), usedTexts);
  return pickUnusedVariant(REVIEW_INTROS.general, usedTexts);
}
export function atmosphereCaption(key = "", usedTexts = []) {
  return `${pickUnusedVariant(ATMOSPHERE_LEADS, usedTexts)} ${ATMOSPHERE_FACTS[key] || "สอนสดกลุ่มเล็ก"}เลยค่ะ`;
}
/** คำชวนทดลองเรียนฟรี (ทั้งช่อง {{ทดลองเรียน}} ของเทิร์นคุยปกติและไม้ทักตาม) — "จำกัดต่อวัน" จริงเพราะเพดาน · ไม่มีตัวเลข/ที่นั่ง */
export function trialInviteBubble(url = "") {
  return "ถ้าอยากลองดูแนวการสอนก่อนตัดสินใจ ลูกแพรขอชวนลองคลาสทดลองเรียนฟรีนะคะ สิทธิ์ชวนทดลองเรียนฟรีที่ลูกแพรเปิดได้ในแต่ละวันมีจำนวนจำกัด "
    + `วันนี้ลูกแพรเลยขอฝากไว้ให้ก่อนค่ะ\n${url}`;
}
const TRIAL_INVITE_MARK = /ขอชวนลองคลาสทดลองเรียนฟรี|สิทธิ์ชวนทดลองเรียนฟรี/u;
/**
 * เอาคำชวนทดลองเรียน (ประโยคที่โค้ดเขียน + ลิงก์) ออกจากข้อความ — ร่างที่เก็บให้แอดมินตอน AI พัก (ร่างนั้นไม่ผ่านบัญชีคำชวน)
 * บรรทัดอื่นคงเดิม
 */
export function stripTrialInvite(text = "", url = "") {
  const link = String(url || "");
  return String(text).split("\n")
    .filter((line) => !(link && line.includes(link)) && !TRIAL_INVITE_MARK.test(line))
    .join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}
