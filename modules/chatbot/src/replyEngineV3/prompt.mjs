// prompt.mjs — ประกอบคำขอของเครื่องตอบ v3 (spec v3.1 §B3/§B4)
// บล็อก 1 (แคชได้ทั้งสองค่าย): ธรรมนูญ + truth-source policy — คงที่ทุกไบต์ ไม่มีข้อมูลธุรกิจที่เปลี่ยนได้
// บล็อก 2 (ต่อเทิร์น): ข้อเท็จจริง · context envelope · ความรู้ fallback · งาน · บทเรียนเจ้าของ · ตัวอย่างที่พี่ง้วงเลือก
// ประวัติใช้งบตัวอักษรรวม เก็บก้อนต้น+ท้ายเมื่อยาว และสงวนข้อตกลงที่แอดมินพิมพ์เอง
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { truncateCodePoints } from "../unicodeText.mjs";
import { thaiShortDate } from "../classRounds.mjs";
import { V3_OUTPUT_FORMAT } from "./promptTexts.mjs";
import { currentSoul, soulBlock } from "../soul/index.mjs";
import { CLASS_NAMES } from "./priceFacts.mjs";
import { STAGES } from "./stage.mjs";
import { EXEMPLARS } from "./exemplars.mjs";
import { hasAuthoritativeBusinessContext, normalizeContextEnvelope, renderBusinessSection, renderContextEnvelope } from "./contextEnvelope.mjs";
import { styleCardText } from "../replyStyle/styleCard.mjs";

// v3.3 (เคสจริง 5 ต.ค.): ไม่ปิดซ้ำข้อเสนอที่ลูกค้ายังไม่ตอบ · เงินตึง/เรียนไม่ไหว/คุ้มไหม = ตอบข้อกังวล ไม่ชวนดูรอบ
// · อีโมจิไม่ขึ้นต้นบอลลูน — บล็อกคงที่ (ธรรมนูญ/ข้อมูลคลาส) ไม่ได้แก้ แคชเดิมยังใช้ได้
// v3.4 (รีวิวเคสจริงทั้งวัน 5 ต.ค.): ลาแล้วไม่ตอบคำรับ · ปิดอย่างสุภาพกับคนที่ยังไม่ได้มาซื้อ · รู้ระดับแล้วไม่ส่งบันได · ตอบคำถามก่อน
// · ขอพื้นฐานก่อนราคาแบบเดียวกันทุกห้องพร้อมบอกว่าราคามาต่อ · หลังราคาไม่ถอยไปทำความรู้จัก · ถามวันที่ได้ข้อเท็จจริงของวันนั้น
// · พิมพ์แทรกระหว่างส่งไม่ทวนซ้ำ — บล็อกคงที่ไม่ได้แก้ แคชเดิมยังใช้ได้
// v3.5 (รีวิวเคสจริงทั้งวัน 5 ต.ค. รอบรีวิว): ถ้อยคำงานของเทิร์นเปลี่ยน — บ่นค่าเรียนไม่ไหว = ดูแลใจ (บอกทางมาเป็นคู่ได้) · ปฏิเสธข้อเสนอ = รับคำไม่เสนอต่อ
// · แม่ป่วย/ตกงาน/โดนตื๊อ/รอปรึกษา = ดูแลใจไม่ถาม · งงหลังราคา = อธิบายใหม่ · คำตอบ "ไม่มีรอบ" ไม่ขึ้นต้นด้วยคำตอบรับ · รอบเต็มบอกว่าเต็ม
// · ปิดห้องเงินตึงไม่พูดเรื่องรายได้ — บล็อกคงที่ (ธรรมนูญ/ข้อมูลคลาส) ไม่ได้แก้ แคชเดิมยังใช้ได้
// v3.6 (รีวิวเคสจริง 6–7 ต.ค. คำสั่งพี่ง้วง "ทำข้อ 1-4 ได้เลย"): ข้อความแรกขอรายละเอียด = ข้อมูลคลาสจริง 2–3 ประโยคก่อนบันได
// · หลังการ์ดราคาไม่ปิดด้วยคำถามคัดกรอง (รู้คลาส = เลือกรอบ · ยังไม่รู้ = สนใจคลาสไหน) · คลาสที่ลูกค้าบอกเองว่าอยากเรียนชนะระดับ
// · เลือกรอบแล้วถามค่าเรียน = รับรอบนั้นแล้วถามคัดกรองข้อเดียว — บล็อกคงที่ (ธรรมนูญ/ข้อมูลคลาส) ไม่ได้แก้ แคชเดิมยังใช้ได้
// · รอบรีวิว 8: คำบอกต้องเป็นคำกริยาของลูกค้าเอง (ลง/สมัคร/เรียน/เอา + ชื่อคลาส) · อยากเรียน Workflow ที่ระดับ ≤4 = การ์ดสองคลาส Business ก่อน
//   + หนึ่งประโยคว่าต่อยอดกัน — ถ้อยคำงานของเทิร์นเท่านั้น บล็อกคงที่ไม่ได้แก้
// v3.9 (พี่ง้วง 12 ต.ค. "human touch"): บล็อกคงที่เปลี่ยน — ธรรมนูญ/ข้อมูลคลาสบอกว่าข้อมูลหลักมีเสมอ (ไม่บอกลูกค้าว่ายืนยันไม่ได้)
// + จุดคุ้มค่า 7 ข้อ (ใบประกาศนียบัตร) ผูกกับค่าเรียน · ด่าน H11 (บอกว่าไม่มีข้อมูลทั้งที่มี) · ทักแรกที่ยังไม่รู้คลาสเห็นรอบที่เปิดของแต่ละคลาส
// · ตัวอย่างที่พี่ง้วงเลือกตัดประโยคยกสำเร็จรูป "ได้อีกเยอะ" และคำชวนดูหัวข้อตายตัว — แคชบล็อกแรกหมุนใหม่ทุกห้อง
export const V3_PROMPT_VERSION = "v3.9";
export const V3_HISTORY_TOTAL_CHARS = 14_000;
export const V3_HISTORY_ADMIN_RESERVE_CHARS = 3_000;
export const V3_HISTORY_MESSAGE_CHARS = 2_400;
export const V3_HISTORY_HARD_MESSAGE_LIMIT = 120;
// v3.8 ไม่มี business fact ใน stable block จึงไม่ผูก truth กับ anchor แบบเดิม
export const CLASS_ESSENTIALS_ANCHORS = Object.freeze([]);
const THAI_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

// 18 ต.ค. 2026 (ขั้นที่ 1 ของแผน soul): ธรรมนูญและข้อมูลธุรกิจมาจาก soul ของ instance (เส้น v3 / v3Business)
// รูปแบบคำตอบเป็นชั้นที่ล็อกในโค้ด เติมผ่านช่อง output-format · ไม่มี soul = ค่ากลางที่ไม่มีชื่อแบรนด์
export function constitutionFor(outputFormat = "plan_reply") {
  const format = outputFormat === "reply_only" ? V3_OUTPUT_FORMAT.reply_only : V3_OUTPUT_FORMAT.plan_reply;
  return soulBlock("v3", { slots: { "output-format": format } });
}

export function classEssentials() {
  return soulBlock("v3Business");
}

export function stableBlockText(outputFormat = "plan_reply") {
  return `${constitutionFor(outputFormat)}\n\n${classEssentials()}\n\n`;
}

// 5 พ.ย. 2026: สวิตช์ reply_style_card=on ต่อการ์ดสไตล์ท้ายบล็อกคงที่ (ยังอยู่ก่อนหมุดแคช) · ปิด = ข้อความเดิมทุกไบต์
function stableBlockFor(outputFormat, styleCard = false) {
  const stable = stableBlockText(outputFormat);
  return styleCard === true ? `${stable}${styleCardText()}\n\n` : stable;
}

// ซอร์สทุกไฟล์ของเครื่อง v3 (ถ้อยคำงาน ตัวปรับจังหวะ บันทึกซ่อม การ์ด ตัวตัดสินจังหวะ) — แก้อะไรก็ตาม hash เปลี่ยน
// (เดิมนับแค่ข้อความฟังก์ชัน moves/closing: แก้ตัวช่วยที่ฟังก์ชันพวกนั้นเรียก hash ไม่ขยับ = แช่แข็งไม่จริง)
function engineSources() {
  const dir = new URL("./", import.meta.url);
  try {
    return readdirSync(dir).filter((name) => /\.(?:mjs|json)$/u.test(name)).sort()
      .map((name) => [name, readFileSync(new URL(name, dir), "utf8")]);
  } catch {
    return [];
  }
}
const hashCache = new Map();

/** ลายนิ้วมือของพรอมต์ทั้งชุด (ธรรมนูญ ข้อมูลคลาส ถ้อยคำงานทุกจังหวะ ตัวอย่าง ซอร์สเครื่อง) — แช่แข็งก่อนวัดผล held-out */
// soul เปลี่ยนได้ระหว่างโปรเซส (เทสต์ติดตั้งใหม่ · ห้องในกลุ่มทดลองได้รุ่นทดลอง) — แคชแยกตาม soul ของงานที่กำลังทำ
export function promptHash(outputFormat = "plan_reply") {
  const cacheKey = `${outputFormat}:${currentSoul()?.sha256 || "chassis-default"}`;
  if (hashCache.has(cacheKey)) return hashCache.get(cacheKey);
  const stages = Object.entries(STAGES).map(([key, spec]) => [key, spec.thai, spec.band, String(spec.moves), String(spec.closing)]);
  const hash = createHash("sha256")
    .update(JSON.stringify([V3_PROMPT_VERSION, stableBlockText(outputFormat), stages, EXEMPLARS, engineSources()]))
    .digest("hex").slice(0, 16);
  hashCache.set(cacheKey, hash);
  return hash;
}

export function missingAnchors(entries = []) {
  const text = (Array.isArray(entries) ? entries : []).map((entry) => `${entry?.title || ""}\n${entry?.content || ""}`).join("\n");
  return CLASS_ESSENTIALS_ANCHORS.filter((anchor) => !text.includes(anchor));
}

function todayLine(todayIso) {
  const [year, month, day] = String(todayIso || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const weekday = THAI_WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const [d, mon, yyyy] = thaiShortDate(todayIso).split(" ");
  return `- วันนี้: วัน${weekday}ที่ ${d} ${mon} ${yyyy}`;
}

function nameLine(facts) {
  const address = facts.address || {};
  if (address.generic || !address.label) return "- ชื่อที่ใช้เรียก: ไม่มี — คุยต่อได้เลยโดยไม่เรียกชื่อ";
  if (!address.mayUseName) return "- ชื่อที่ใช้เรียก: เทิร์นนี้พักการเรียกชื่อ";
  if (facts.nameInLadder) return `- ชื่อที่ใช้เรียก: ${address.label} (ชื่อนี้อยู่ในช่อง {{บันได}} แล้ว ข้อความที่พิมพ์เองไม่ต้องเรียกชื่อซ้ำ)`;
  return `- ชื่อที่ใช้เรียก: ${address.label} (เรียกได้หนึ่งครั้งในจังหวะทักทายหรือชวนตัดสินใจ)`;
}

// รีวิวเคสจริงทั้งวัน 5 ต.ค.: ระดับที่บอกเป็นนัยไม่เคยถึงโมเดล (ตอบว่าใช้อยู่และสนใจ AI อีกตัวด้วย แล้วยังโดนถามว่าใช้ AI มาแค่ไหน)
function impliedLevelText(implied) {
  if (!implied) return "";
  // รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): สิ่งที่ลูกค้าบอกล่าสุดชนะ (บอกทีหลังว่าใช้ทุกวัน/สร้างเองแล้ว)
  if (implied.source === "opening_built" || implied.source === "said_built") return "เล่าแล้วว่าเคยสร้าง Custom AI หรือผู้ช่วย AI เองแล้ว";
  if (implied.source === "opening_used" || implied.source === "said_used") return "ตอบแล้วว่าใช้ AI อยู่แล้ว";
  return implied.level === 1 ? "ตอบแล้วว่ายังไม่เคยใช้ AI หรือเพิ่งเริ่ม" : `ระดับ ${implied.level} ตามที่เล่า`;
}

function toldLine(facts) {
  const parts = [];
  // รีวิวเคสจริงทั้งวัน 5 ต.ค.: ลูกค้าตอบใต้บันไดเป็นช่วง ("สองถึงสาม") = บอกเป็นช่วง ไม่ปัดเป็นข้อเดียว
  if (facts.routing?.levelRange) parts.push(`ระดับ ${facts.routing.levelRange.join("–")} ตามบันได`);
  else if (Number.isInteger(facts.routing?.level)) parts.push(`ระดับ ${facts.routing.level} ตามบันได`);
  else if (facts.impliedLevel) parts.push(impliedLevelText(facts.impliedLevel));
  // feedback ทีม 10 ต.ค.: "ยัง" ต่อคำถามโฆษณาเรื่อง AI Agent ไม่ได้บอกระดับการใช้ AI ทั่วไป
  else if (facts.agentOpening) parts.push(`ตอบคำถามในโฆษณาว่า "${truncateCodePoints(facts.text, 40)}" (ยังไม่ได้ใช้ AI Agent — ยังไม่รู้ว่าใช้ AI ทั่วไปอย่าง ChatGPT ระดับไหน)`);
  if (facts.tools?.length) parts.push(`ใช้ ${facts.tools.join(", ")}`);
  if (facts.goal?.evidence) parts.push(`เรื่องงาน/เป้าหมาย: "${truncateCodePoints(facts.goal.evidence, 120)}"`);
  if (facts.painPoint) parts.push(`ปัญหาที่เล่า: "${truncateCodePoints(facts.painPoint, 120)}"`);
  if (!parts.length) return "";
  // ตรวจคิว 13 ต.ค.: ลูกแพรบอกลูกค้าว่า "พื้นฐานระดับ 3 และใช้ ChatGPT อยู่แล้ว" ทั้งที่เขาไม่เคยบอก · "ยังค่ะ" ถูกสรุปเป็น "ระดับ 1 ที่ยังไม่เคยใช้ AI"
  // — ระดับที่ระบบอ่านมีไว้เลือกคลาส ไม่ใช่สิ่งที่จะพูดกับลูกค้า (เว้นแต่เขาเพิ่งตอบข้อบันไดในข้อความนี้)
  const levelNote = Number.isInteger(facts.answeredLevel) ? ""
    : " (ข้อมูลนี้ใช้เลือกคลาส — ไม่พูดเลขระดับ และไม่สรุปเครื่องมือหรือพื้นฐานที่เขาไม่ได้พูดเองให้ลูกค้าฟัง)";
  return `- สิ่งที่ลูกค้าเล่าแล้ว: ${parts.join(" · ")}${levelNote}`;
}

function sentLine(facts) {
  const parts = [];
  if (facts.ladderShown) parts.push("บันไดระดับ");
  if (facts.posterSent) parts.push("โปสเตอร์คลาส");
  if (facts.sentReviewCount) parts.push(`รีวิว ${facts.sentReviewCount} ลิงก์`);
  parts.push(facts.priceQuoted ? "แจ้งค่าเรียนแล้ว" : "ยังไม่เคยแจ้งค่าเรียน");
  parts.push(facts.roundsSent ? "ส่งรอบเรียนแล้ว" : "ยังไม่เคยส่งรอบเรียน");
  if (facts.prepSaid) parts.push("ชวนเตรียมงาน/Laptop มาใช้ใน Workshop แล้ว (ไม่ต้องพูดซ้ำ เว้นแต่ลูกค้าถามเอง)");
  return `- ส่งให้ลูกค้าแล้วในห้องนี้: ${parts.join(" · ")}`;
}

// รีวิวปรปักษ์ 10 ต.ค.: บรรทัดนี้เฉพาะจังหวะขาย — จังหวะดูแลใจ/ลังเล/ลา ไม่บอกโมเดลว่าก้าวถัดไปคือขั้นสมัคร
const PICKED_ROUND_STAGES = new Set(["LOGISTICS", "PRICE", "DEAL_PAIR", "DEAL_SINGLE", "BRIDGE", "SCREEN_PRICE", "DELIVER"]);
function pickedRoundLine(facts, decision) {
  if (!facts.pickedRound || !PICKED_ROUND_STAGES.has(decision?.stage) || (decision?.modifiers || []).includes("money_hardship")) return "";
  return `- รอบที่ลูกค้าเลือกไว้แล้ว: ${facts.pickedRound} (ไม่ต้องชวนเลือกรอบซ้ำ เว้นแต่ลูกค้าขอดูหรือเปลี่ยนรอบเอง)`;
}

function imageLine(facts, decision) {
  // พี่ง้วง 12 ต.ค.: รูปบรรยากาศที่ตัวตัดสินของเทิร์นเลือก (socialProof) แทนรูปที่เสนอแบบเดิม — หนึ่งรูปต่อเทิร์น
  const key = facts.socialProof?.image?.key || facts.imageOffer?.key;
  const ladderSlot = decision?.stage === "FIRST_CONTACT" || (decision?.stage === "SCREEN_PRICE" && decision?.ladder);
  if (!key || (ladderSlot && key === "ai-stage-ladder")) return "- รูปที่แนบได้เทิร์นนี้: ไม่มี";
  return `- รูปที่แนบได้เทิร์นนี้: [IMAGE:${key}]`;
}

// รีวิวเคสจริงทั้งวัน 5 ต.ค.: ลูกค้าถามวันที่ที่เป็นรอบของอีกคลาส แต่รอบที่โมเดลเห็นมีแค่สามรอบแรกของคลาสนี้ เลยตอบผิดว่าวันนั้นไม่มีรอบเลย
const DATE_STATUS_TEXT = Object.freeze({ open: () => "มีรอบของคลาสนี้", none: () => "ยังไม่มีรอบเรียน", full: () => "รอบของคลาสนี้วันนั้นเต็มแล้ว (ปิดรับสมัคร)",
  other_class: (rd) => `ไม่ใช่รอบของคลาสนี้ (เป็นรอบของ ${rd.otherClass})` });
function requestedDateLine(rd) {
  if (!rd?.status) return "";
  const near = rd.nearest?.length ? ` · รอบของคลาสนี้ที่ใกล้ที่สุด: ${rd.nearest.join(" · ")}` : "";
  return `- วันที่ลูกค้าถาม: ${rd.label} — ${(DATE_STATUS_TEXT[rd.status] || DATE_STATUS_TEXT.none)(rd)}${near}`;
}

// รีวิว 12 ต.ค.: ทักแรก "เรียนวันไหนคะ" (ยังไม่รู้คลาส) — งานของเทิร์นให้รอบจริงของสองคลาส แต่บล็อกนี้เคยบอก "ยังไม่มีรอบที่ประกาศ"
// และธรรมนูญให้ใช้วันจากบล็อกนี้ → โมเดลตอบว่าไม่มีรอบ (บอกว่าไม่มีข้อมูลทั้งที่มี) · ยังไม่รู้คลาส = แสดงรอบที่เปิดแยกตามคลาส
/** รอบที่เปิดแยกตามคลาส ตอนที่ระบบยังไม่ได้เลือกคลาส — [[key, labels]] (รู้คลาสแล้ว = []) */
export function openRoundsByClass(facts = {}) {
  if (facts.classKey || facts.roundLabels?.length) return [];
  const rounds = facts.openingRounds || {};
  return Object.keys(CLASS_NAMES).map((key) => [key, (Array.isArray(rounds[key]) ? rounds[key] : []).filter(Boolean)])
    .filter(([, labels]) => labels.length);
}

/** รอบที่ด่านหลังร่างนับว่า "ระบบมีข้อมูลรอบ" (H11/วันที่) — รอบของคลาสนี้ หรือรอบของทุกคลาสเมื่อยังไม่รู้คลาส */
export function heldRoundLabels(facts = {}) {
  if (facts.roundLabels?.length) return [...facts.roundLabels];
  return [...new Set(openRoundsByClass(facts).flatMap(([, labels]) => labels))];
}

function roundsLine(facts) {
  if (facts.roundLabels?.length) return `- รอบที่เปิด${facts.classKey ? "ของคลาสนี้" : ""}: ${facts.roundLabels.join(" · ")}`;
  const byClass = openRoundsByClass(facts);
  if (byClass.length) {
    return `- รอบที่เปิดแยกตามคลาส (ลูกค้ายังไม่ได้เลือกคลาส): ${byClass.map(([key, labels]) => `${CLASS_NAMES[key]} ${labels.join(" · ")}`).join(" / ")}`;
  }
  return "- รอบที่เปิด: ยังไม่มีรอบที่ประกาศ (ไม่ต้องบอกวัน)";
}

/** บล็อก "ข้อเท็จจริงของเทิร์นนี้" (§B4) — บรรทัดที่ไม่มีข้อมูลไม่แสดง ยกเว้นชื่อ รอบ และรูป */
export function renderTurnFacts(facts = {}, decision = null) {
  const quote = (items) => items.map((item) => `"${item}"`).join(" · ");
  const lines = [
    "## ข้อเท็จจริงของเทิร์นนี้ (ระบบตรวจแล้ว)",
    todayLine(facts.todayIso),
    nameLine(facts),
    toldLine(facts),
    Number.isInteger(facts.routing?.headcount) ? `- จำนวนผู้เรียน: ${facts.routing.headcount} ท่าน` : "",
    `- คลาสที่ระบบเลือก: ${facts.classLabel || "ยังไม่ระบุ — ใช้ข้อมูลล่าสุดของลูกค้าและไม่เดาคลาส"}`,
    roundsLine(facts),
    requestedDateLine(facts.requestedDate),
    pickedRoundLine(facts, decision),
    sentLine(facts),
    imageLine(facts, decision),
    facts.usedOpeners?.length ? `- คำเปิดที่ลูกแพรใช้ไปแล้วในห้องนี้ (เลือกคำเปิดอื่น): ${quote(facts.usedOpeners)}` : "",
    facts.adminLines?.length ? `- ทีมงานพิมพ์เองล่าสุด: ${quote(facts.adminLines)}` : "",
    facts.teamNotes?.length ? `- บันทึกจากทีมงาน: ${facts.teamNotes.join(" · ")}` : "",
    facts.hashtagNote ? `- ที่มาของลูกค้า (ทีมงานบันทึก ลูกค้าไม่ได้พูดเอง): ${facts.hashtagNote}` : "",
    facts.arrivalNote ? `- ${facts.arrivalNote}` : "",
    // รีวิวเคสจริงทั้งวัน 5 ต.ค.: ลูกค้าตอบหรืองงคำถามต้อนรับในโฆษณา แต่โมเดลของจังหวะทักแรก/ให้กำลังใจไม่เคยเห็นคำถามนั้น
    facts.adWelcomeQuestion && (facts.firstReply || facts.openingAnswer || facts.confusedOpening)
      ? `- คำถามต้อนรับในโฆษณาที่ลูกค้าเห็นก่อนทักมา: "${truncateCodePoints(facts.adWelcomeQuestion, 160)}"` : "",
    facts.tagRules ? `- ป้ายลูกค้าและกติกาสินค้า: ${facts.tagRules}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export function renderCards(cards = []) {
  if (!cards.length) return "";
  return `## ความรู้ที่เกี่ยวข้อง\n${cards.map((card) => `[${card.title}]\n${card.content}`).join("\n\n")}`;
}

export const ADMIN_PREFIX = "[แอดมินทีมงานพิมพ์เอง]";
const isAdmin = (content) => String(content).startsWith(ADMIN_PREFIX);

/**
 * หน้าต่างประวัติของ v3 ก่อนตัดความยาว — เลือกด้วยงบรวมและสงวนก้อนแอดมิน ไม่ตัดตามจำนวน 16 ก้อน
 * บอลลูนบอทติดกันรวมเป็นก้อนเดียวเฉพาะของ AI · ข้อความที่แอดมินพิมพ์เองเป็นก้อนของตัวเองเสมอ
 * (ธรรมนูญ: ข้อความที่ "ขึ้นต้น" ด้วยป้ายแอดมิน = คำของทีมงาน — รวมกันแล้วคำของ AI จะไปอยู่ใต้ป้าย)
 */
export function historyWindow(history = []) {
  const merged = [];
  for (const turn of Array.isArray(history) ? history : []) {
    const role = turn?.role === "assistant" ? "assistant" : "user";
    const content = String(turn?.content ?? "");
    const last = merged.at(-1);
    if (role === "assistant" && last?.role === "assistant" && !isAdmin(content) && !isAdmin(last.content)) {
      last.content = `${last.content}\n\n${content}`;
    } else merged.push({ role, content });
  }
  const capped = merged.map((turn, index) => ({ ...turn, content: capMessage(turn.content), index }));
  const keep = new Set();
  let used = 0;
  let adminUsed = 0;
  for (let i = capped.length - 1; i >= 0; i -= 1) {
    const turn = capped[i];
    if (!isAdmin(turn.content)) continue;
    const size = [...turn.content].length;
    if (adminUsed + size > V3_HISTORY_ADMIN_RESERVE_CHARS) continue;
    keep.add(i); adminUsed += size; used += size;
  }
  for (let i = capped.length - 1; i >= 0 && keep.size < V3_HISTORY_HARD_MESSAGE_LIMIT; i -= 1) {
    if (keep.has(i)) continue;
    const size = [...capped[i].content].length;
    if (used + size > V3_HISTORY_TOTAL_CHARS) continue;
    keep.add(i); used += size;
  }
  return capped.filter((_, index) => keep.has(index)).map(({ role, content }) => ({ role, content }));
}

// ก้อนยาวเก็บทั้งต้นและท้าย: ข้อตกลงมักอยู่ต้น ส่วนคำถาม/เงื่อนไขล่าสุดอยู่ท้าย
function capMessage(content) {
  const chars = [...content];
  if (chars.length <= V3_HISTORY_MESSAGE_CHARS) return content;
  const marker = "\n…\n";
  const markerSize = [...marker].length;
  if (isAdmin(content)) {
    const prefix = `${ADMIN_PREFIX} `;
    const body = [...String(content).slice(prefix.length)];
    const room = V3_HISTORY_MESSAGE_CHARS - [...prefix].length - markerSize;
    const first = Math.ceil(room / 2);
    return `${prefix}${body.slice(0, first).join("")}${marker}${body.slice(-Math.floor(room / 2)).join("")}`;
  }
  const room = V3_HISTORY_MESSAGE_CHARS - markerSize;
  return `${chars.slice(0, Math.ceil(room / 2)).join("")}${marker}${chars.slice(-Math.floor(room / 2)).join("")}`;
}

/** ประวัติที่ส่งให้โมเดล: งบรวม 14k code points · ก้อนละ ≤2.4k · เก็บข้อตกลงต้นก้อนและคำถามท้ายก้อน */
export function v3History(history = []) {
  return historyWindow(history);
}

// 7 พ.ย. 2026 (พี่ง้วง "แก้และเทสเลย"): ร่างแรกของ Sonnet/Haiku ที่เปิดการ์ดสไตล์ถูกส่งซ่อมเพราะ S3/S1 บ่อยที่สุด
// (บรรทัดสุดท้ายไม่ใช่คำถาม หรือห้อยประโยคลา "ถ้ามีคำถาม…") — ย้ำในบันทึกท้ายข้อความ ซึ่งเป็นจุดที่โมเดลอ่านล่าสุดก่อนเขียน
// เฉพาะตอนเปิดการ์ด และเฉพาะเทิร์นที่ต้องปิดด้วยคำถาม/ข้อเสนอ · ปิดการ์ด = บันทึกเดิมทุกไบต์
export const CLOSING_REMINDER = "บรรทัดสุดท้ายของข้อความต้องเป็นคำถามหรือข้อเสนอนั้นข้อเดียว ไม่มีประโยคใดต่อท้ายนอกจาก \"ลูกแพรส่งให้ค่ะ\" "
  + "และไม่ใช้ประโยคลาอย่าง \"ถ้ามีคำถาม…\" \"ไว้ค่อย…\" \"พร้อมเมื่อไหร่…\" \"ทักลูกแพรได้…\"";
const REMIND_POLICIES = new Set(["hot", "question"]);

export function recapLine(plan, outputFormat = "plan_reply", closingPolicy = "") {
  const [min, max] = plan.band;
  const format = outputFormat === "reply_only" ? "ส่งเฉพาะข้อความถึงลูกค้า" : "ตอบในรูปแบบ <plan>…</plan><reply>…</reply>";
  const reminder = REMIND_POLICIES.has(closingPolicy) ? ` · ${CLOSING_REMINDER}` : "";
  return `(บันทึกจากระบบถึงลูกแพร ลูกค้าไม่เห็นส่วนนี้: งานของเทิร์นนี้คือ "${plan.thai}" ยาวราว ${min}–${max} ตัวอักษร · ปิดท้าย: ${plan.closingShort}${reminder} · ${format})`;
}
const closingPolicyOf = (input = {}) => (input.styleCard === true ? String(input.closingPolicy || "") : "");

// ส่วนของบล็อกต่อเทิร์นที่เป็นคำสั่ง/ข้อมูล (ไม่รวมตัวอย่าง) — ลำดับเดียวกับที่โมเดลอ่าน
function normalizedEnvelope({ facts = {}, decision = null, contextEnvelope = null }) {
  return contextEnvelope?.businessStatus ? contextEnvelope : normalizeContextEnvelope(contextEnvelope, { facts, decision, userText: facts.text });
}

function turnSections({ facts = {}, decision = null, plan, cards = [], contextEnvelope = null, ownerLessonText = "", guardRepair = "" }, { omitBusiness = false } = {}) {
  const repairSection = guardRepair && !plan.text.includes(guardRepair) ? `## ข้อกำกับเพิ่มจากด่านตรวจ (ต้องทำตาม)\n${guardRepair}` : "";
  const normalized = normalizedEnvelope({ facts, decision, contextEnvelope });
  const fallbackCards = hasAuthoritativeBusinessContext(normalized) ? [] : cards;
  return [renderTurnFacts(facts, decision), renderContextEnvelope(normalized, { omitBusiness }), renderCards(fallbackCards), plan.text, repairSection, String(ownerLessonText || "").trim()];
}

/** ถ้อยคำทั้งหมดที่ระบบสั่งให้โมเดลพูด/อ่านในเทิร์นนี้ (ไม่รวมตัวอย่าง) — ตัวตรวจ "ลอกตัวอย่าง" ไม่นับส่วนที่ซ้ำกับตรงนี้ */
export function instructionText(input = {}) {
  const outputFormat = input.outputFormat || "plan_reply";
  return [stableBlockFor(outputFormat, input.styleCard), ...turnSections(input), recapLine(input.plan, outputFormat, closingPolicyOf(input))].filter(Boolean).join("\n\n");
}

/**
 * @param {{facts: object, decision?: object, plan: {thai: string, band: number[], closingShort: string, text: string},
 *   cards?: object[], contextEnvelope?: object, exemplars?: string, ownerLessonText?: string, history?: object[], userText?: string,
 *   guardRepair?: string, outputFormat?: string, styleCard?: boolean, businessCacheLayer?: boolean}} input
 */
export function buildV3Messages(input) {
  const { exemplars = "", history = [], userText = "", outputFormat = "plan_reply", plan } = input;
  // 7 พ.ย. 2026 (งานแคช): สวิตช์ reply_cache_layer=on ย้ายข้อมูลธุรกิจที่อนุมัติ (ราว 4,400 token มีไม่กี่แบบ) ขึ้นมาก่อนข้อเท็จจริงของเทิร์น
  // แล้วปักหมุดของตัวเอง ถ้อยคำไม่เปลี่ยน เปลี่ยนแค่ลำดับ · ปิด = พรอมต์เดิมทุกไบต์
  const business = input.businessCacheLayer === true ? renderBusinessSection(normalizedEnvelope(input)) : "";
  const turnBlock = [...turnSections(input, { omitBusiness: Boolean(business) }), exemplars].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: [
      { type: "text", text: stableBlockFor(outputFormat, input.styleCard), prompt_cache_breakpoint: { mode: "explicit" } },
      ...(business ? [{ type: "text", text: `${business}\n\n`, prompt_cache_breakpoint: { mode: "explicit" } }] : []),
      { type: "text", text: turnBlock },
    ] },
    ...v3History(history),
    { role: "user", content: `${String(userText)}\n\n${recapLine(plan, outputFormat, closingPolicyOf(input))}` },
  ];
}
