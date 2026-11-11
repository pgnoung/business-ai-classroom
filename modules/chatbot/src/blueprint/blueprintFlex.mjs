// blueprintFlex.mjs — การ์ดเลื่อน LINE "การวางระบบ AI Agent" + ใบรับ + คำสั่งตั้งต้น (11 ต.ค. 2026)
//
// buildBlueprintFlex(blueprint, { campaign, displayName }) → LINE flex message (carousel 7 ใบ)
//   1 ปก: หัวเรื่อง + ผู้ช่วยตัวแรก + เป้าหมาย + "หน้าตางานที่คุณจะได้" (sampleOutput ทำเป็นแจ้งเตือนบนมือถือ)
//   2 ที่คุณบอก + ทำไมเริ่มงานนี้ + ข้อมูล + เครื่องมือ · 3 ขั้นตอน → ผลงาน · 4 ขอบเขตอำนาจ (โซนเจ้าของตัดสินสีทอง)
//   5 ทดลอง 7 วัน · 6 วัดผล + ข้อควรระวัง
//   7 ก้าวถัดไปเมื่อทดลองผ่าน + ก้าวแรกพรุ่งนี้ + ชี้ไปที่คำสั่งตั้งต้น + ปิดจากทีมพี่ง้วง
//     (ปุ่มคุยต่อ = ข้อความธรรมดา ไม่ใช่คีย์เวิร์ดรับคำขอ)
// buildAgentBriefText(blueprint, { campaign }) → "คำสั่งตั้งต้น" ≤ 2,500 ตัวอักษร ที่ลูกค้ากดค้างคัดลอกไปวางในแชท AI ได้ทันที
//   ประกอบจากช่องของแผนตรง ๆ (ไม่เรียกโมเดล) · ผู้ส่งแนบเป็นข้อความถัดจากการ์ดในคำขอเดียวกัน
// buildAckMessages({ campaign, business, now }) → [text, flex ใบรับ] ตอบทันทีเมื่อได้ #AIAGENT
// blueprintToText(blueprint, { campaign }) → ข้อความสำรอง ≤ 2,000 ตัวอักษร (ใช้เมื่อส่ง Flex ไม่ได้ + ประวัติแชทของลูกแพร)
//
// โทน: เขียวหัวเป็ดเข้ม #123F3D · ทองหม่น #C1A05F · งาช้าง — ไม่มีรูปภายนอก ไม่มีตัวอักษร xxs
// อ่านง่ายสำหรับเจ้าของวัย 45+: เนื้อหาทุกช่องอย่างน้อย sm (xs เหลือแค่ป้ายตัวหนา เลขหน้า ชื่อผู้ส่งในแจ้งเตือน และบรรทัดลงชื่อ)
// ตัวอักษรเล็กบนพื้นเขียวกลาง (#1A524D) ใช้ทองอ่อน #D8BD85 (4.9:1) ไม่ใช่ทองหม่น (3.6:1 ไม่ผ่าน 4.5:1)
// v2: ปกเลิกสารบัญ (การ์ดเลื่อนดูเองได้ และต้องคืนที่ให้กล่องหน้าตางาน) · แผนรุ่นแรกที่ไม่มีช่องใหม่ยังเรนเดอร์ครบ (ข้ามกล่องที่ไม่มีข้อมูล)
// ไล่สีปก/ใบปิดจากบนลงล่าง (180deg) ให้ขอบล่างเป็นสีเดียวกับ footer พอดี ไม่เห็นรอยต่อ
// ขนาด: ใช้ span รวมหลายบรรทัดในข้อความเดียว และไม่ใส่ค่าที่เป็นค่าเริ่มต้นของ LINE (flex 1 ในแนวนอน,
//       สีตัวอักษรเนื้อหาใช้สีเริ่มต้นของ LINE ซึ่งเกือบดำ ฯลฯ)
//       เคสยาวสุดทุกช่อง < 30 KB (มีเทสต์คุม)
// pure: ไม่มี I/O · ไม่แก้ object ที่ส่งเข้ามา · ข้อความว่างถูกข้าม (LINE ไม่รับ text ว่าง)
import { addressableCustomerName } from "../customerName.mjs";
import { cleanIntakeField } from "./blueprintPrompt.mjs";
import { priceSafeNumbers, toThaiNumerals } from "./blueprintSchema.mjs";

export const BLUEPRINT_ALT_TEXT_MAX = 300;
export const BLUEPRINT_TEXT_MAX = 2000;
export const AGENT_BRIEF_MAX = 2500;
export const AGENT_BRIEF_HEADER = "คำสั่งตั้งต้น · กดค้างเพื่อคัดลอก แล้ววางในแชท AI ที่คุณใช้อยู่";
export const SAMPLE_PANEL_LABEL = "หน้าตางานที่คุณจะได้";
export const NEXT_LEVEL_LABEL = "ก้าวถัดไปเมื่อทดลองผ่าน";
export const FLEX_CONTENTS_MAX_BYTES = 30_000;
export const DEFAULT_OA_ID = "@pngoung";
export const DEFAULT_CTA_TEXT = "อยากคุยเรื่อง AI Agent ต่อ";
export const CTA_TEXT_MAX = 40;
export const FALLBACK_HEADLINE = "การวางระบบ AI Agent ตัวแรกของคุณ";
export const FALLBACK_AGENT_NAME = "ผู้ช่วย AI ตัวแรก";

export const PALETTE = Object.freeze({
  teal: "#123F3D",
  tealDeep: "#0B2C2A",
  tealMid: "#1A524D",
  tealTint: "#E6EFEB",
  gold: "#C1A05F",
  goldLight: "#D8BD85",
  goldDeep: "#86662A",
  goldTint: "#F6EDDA",
  ivory: "#FBF7EF",
  ivoryCard: "#F3EDE1",
  hair: "#E2D8C6",
  ink: "#1E2A29",
  muted: "#5B6765",
  rust: "#9A4634",
  rustTint: "#F7E9E3",
  ivory90: "#FBF7EFE6",
  ivory70: "#FBF7EFB3",
  glass: "#FFFFFF14",
  goldLine: "#C1A05F8C",
});
const C = PALETTE;

const TOTAL_BUBBLES = 7;
const TH_DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const MASK_TOKEN_RE = /\[(?:เบอร์|อีเมล|ลิงก์|ตัวเลข)\]/u;

const BRAND = "ทีมพี่ง้วง";
// บรรทัดท้ายของหน้าตางานที่ขึ้นต้นแบบนี้ = เรื่องที่รอเจ้าของตัดสิน (พรอมต์สั่งไว้) → ทำเป็นป้ายทองบนการ์ด
const DECISION_LINE_RE = /^รอคุณตัดสิน\s*[:：]?\s*/u;
// ชื่อธุรกิจกลาง ๆ (ผู้เรียนไม่ได้บอก) ไม่ขึ้นบนปก — ปกไม่ควรเขียนว่า "ธุรกิจ" เฉย ๆ
const GENERIC_BUSINESS_RE = /^(?:ธุรกิจ|ธุรกิจของคุณ|SME|ทั่วไป)$/iu;

/* ------------------------------ small helpers ------------------------------ */

const s = (value) => (typeof value === "string" ? value.trim() : "");
const arr = (value) => (Array.isArray(value) ? value : []);
const nonEmpty = (value) => s(value).length > 0;
const cpLength = (value) => [...String(value)].length;
const cpSlice = (value, max) => {
  const chars = [...String(value)];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…` : String(value);
};

/** ข้อความบรรทัดเดียวสั้น ๆ (ป้าย/ตัวเลข) */
function text(value, props = {}) {
  return { type: "text", text: value, ...props };
}

/** ข้อความเนื้อหาที่ตัดบรรทัดได้ */
function para(value, props = {}) {
  return { type: "text", text: value, wrap: true, ...props };
}

/** ข้อความหลายช่วงในก้อนเดียว (ประหยัดขนาด) — span ว่างถูกข้าม */
function spans(parts, props = {}) {
  const contents = parts.filter((part) => part && part.text);
  // มี contents แล้ว LINE ไม่อ่าน text (ไม่ใส่ซ้ำ ประหยัดขนาดครึ่งหนึ่ง)
  return { type: "text", wrap: true, contents: contents.map((part) => ({ type: "span", ...part })), ...props };
}

function box(layout, contents, props = {}) {
  return { type: "box", layout, contents: contents.filter(Boolean), ...props };
}

const rule = (color, margin) => ({ type: "separator", color, margin });

/** เวลาส่งในเขตกรุงเทพ: { short: "วันจันทร์ 10:00", long: "วันจันทร์ที่ 12 ต.ค. เวลา 10:00 น.", date } หรือ null */
export function bangkokSendLabel(sendAt) {
  const ms = Date.parse(String(sendAt || ""));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + BANGKOK_OFFSET_MS);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const day = TH_DAYS[d.getUTCDay()];
  const date = `${d.getUTCDate()} ${TH_MONTHS[d.getUTCMonth()]}`;
  return { short: `วัน${day} ${hhmm}`, long: `วัน${day}ที่ ${date} เวลา ${hhmm} น.`, date };
}

function oaIdOf(campaign) {
  const id = s(campaign?.oaId);
  return /^@[A-Za-z0-9._-]{2,40}$/u.test(id) ? id : DEFAULT_OA_ID;
}

/** ข้อความของปุ่มคุยต่อ — ต้องพาไปคุยปกติ ห้ามเป็นคีย์เวิร์ดรับคำขอ (#...) ไม่อย่างนั้นกดแล้ววนกลับเข้าแคมเปญ */
export function ctaTextOf(campaign) {
  const custom = s(campaign?.ctaText);
  const keyword = s(campaign?.keyword).toLowerCase();
  if (!custom || custom.startsWith("#") || (keyword && custom.toLowerCase().startsWith(keyword)) || [...custom].length > CTA_TEXT_MAX) {
    return DEFAULT_CTA_TEXT;
  }
  return custom;
}

/* ------------------------------ bubble parts ------------------------------- */

const pageMark = (index) => text(`${index}/${TOTAL_BUBBLES}`, { size: "xs", color: C.ivory70, align: "end", flex: 0 });

function sectionHeader(index, kicker, title) {
  return box("vertical", [
    box("horizontal", [text(kicker, { size: "xs", color: C.gold, weight: "bold" }), pageMark(index)]),
    para(title, { size: "lg", color: C.ivory, weight: "bold", margin: "sm" }),
  ], { backgroundColor: C.teal, paddingAll: "20px" });
}

const label = (value, color = C.goldDeep, props = {}) => text(value, { size: "xs", color, weight: "bold", ...props });

function contentBubble(index, kicker, title, bodyContents) {
  return {
    type: "bubble",
    size: "mega",
    header: sectionHeader(index, kicker, title),
    body: box("vertical", bodyContents, { backgroundColor: C.ivory, paddingAll: "20px" }),
  };
}

/** แถวรายการ: เลขทองชิดซ้าย + เนื้อหา (หัวตัวหนา + บรรทัดรองสีจาง ขนาดเท่ากัน — muted บนงาช้าง 5.5:1) */
function numberedRow(no, title, note, { margin = "md", noColor = C.goldDeep, bold = true } = {}) {
  return box("horizontal", [
    text(no, { size: "sm", color: noColor, weight: "bold", flex: 0 }),
    nonEmpty(note) ? spans([
      { text: s(title), ...(bold ? { weight: "bold" } : {}) },
      { text: `\n${s(note)}`, color: C.muted },
    ], { size: "sm", margin: "md" }) : para(s(title), { size: "sm", margin: "md", ...(bold ? { weight: "bold" } : {}) }),
  ], margin === "none" ? {} : { margin });
}

const two = (index) => String(index + 1).padStart(2, "0");
// "คุณสมชาย" ติดกันแบบไทย · ชื่ออักษรละติน "คุณ Nok" เว้นวรรค
const honorific = (name) => (/^[A-Za-z]/u.test(name) ? `คุณ ${name}` : `คุณ${name}`);

/* --------------------------------- bubbles --------------------------------- */

/** ชื่อธุรกิจสั้น ๆ ที่ใช้ขึ้นการ์ดได้ ("" = ไม่มีหรือกลางเกินไป) */
function businessLabelOf(bp) {
  const value = s(bp.businessLabel);
  return value && !GENERIC_BUSINESS_RE.test(value) ? value : "";
}

/** บรรทัดของหน้าตางาน: [{ text, decision }] — decision = บรรทัด "รอคุณตัดสิน: ..." (ตัดคำนำออก ป้ายทองแทน) */
function sampleLines(bp) {
  return arr(bp.sampleOutput?.lines).map(s).filter(Boolean).map((line) => {
    const decision = DECISION_LINE_RE.test(line);
    return { text: decision ? line.replace(DECISION_LINE_RE, "") || line : line, decision };
  });
}

/**
 * "หน้าตางานที่คุณจะได้" — แจ้งเตือนบนมือถือจากผู้ช่วย: ป้าย AI + ชื่อผู้ช่วย + หัวงาน แล้วตามด้วยบรรทัดงานจริง
 * พื้นงาช้างบนปกเขียวเข้ม = ชิ้นที่ตาไปหยุดก่อน (ของที่เจ้าของจะได้จริง) · บรรทัดรอตัดสินเป็นป้ายทอง ตรงกับหลัก "คุณเป็นคนตัดสิน"
 */
function samplePanel(bp) {
  const lines = sampleLines(bp);
  if (!lines.length) return null;
  const title = s(bp.sampleOutput?.title);
  const agent = s(bp.agentName) || FALLBACK_AGENT_NAME;
  return box("vertical", [
    label(SAMPLE_PANEL_LABEL, C.goldLight),
    box("vertical", [
      box("horizontal", [
        box("vertical", [text("AI", { size: "xs", color: C.goldLight, weight: "bold", align: "center" })], {
          width: "28px", height: "28px", cornerRadius: "14px", backgroundColor: C.teal, justifyContent: "center", flex: 0,
        }),
        box("vertical", [
          text(agent, { size: "xs", color: C.muted, weight: "bold" }),
          title ? para(title, { size: "sm", color: C.teal, weight: "bold" }) : null,
        ], { margin: "md" }),
      ], { alignItems: "center" }),
      rule(C.hair, "md"),
      spans(lines.flatMap((line, index) => {
        const lead = index ? "\n" : "";
        return line.decision
          ? [{ text: `${lead}★ รอคุณตัดสิน  `, color: C.goldDeep, weight: "bold" }, { text: line.text, weight: "bold" }]
          : [{ text: `${lead}•  `, color: C.goldDeep, weight: "bold" }, { text: line.text }];
      }), { size: "sm", color: C.ink, margin: "md", lineSpacing: "6px" }),
    ], { margin: "sm", paddingAll: "14px", cornerRadius: "16px", backgroundColor: C.ivory }),
  ], { margin: "xl" });
}

function coverBubble(bp, { campaign, name }) {
  const prepared = name ? `เตรียมให้${honorific(name)}` : "เตรียมให้คุณโดยเฉพาะ";
  const title = s(campaign?.title);
  const business = businessLabelOf(bp);
  // ปกคือใบที่ถูกส่งต่อเข้ากลุ่ม LINE — ต้องเห็นว่ามาจากทีมพี่ง้วง และทำให้ธุรกิจไหน
  const from = title ? `${title} · ${BRAND}` : BRAND;
  return {
    type: "bubble",
    size: "mega",
    body: box("vertical", [
      box("horizontal", [text("การวางระบบ AI Agent", { size: "xs", color: C.gold, weight: "bold" }), pageMark(1)]),
      box("vertical", [], { width: "36px", height: "2px", backgroundColor: C.gold, margin: "md" }),
      para(s(bp.headline) || FALLBACK_HEADLINE, { size: "xl", color: C.ivory, weight: "bold", margin: "lg" }),
      box("vertical", [
        label("ผู้ช่วยตัวแรกของคุณ", C.goldLight),
        para(s(bp.agentName) || FALLBACK_AGENT_NAME, { size: "lg", color: C.ivory, weight: "bold", margin: "xs" }),
        nonEmpty(bp.mission) ? para(s(bp.mission), { size: "sm", color: C.ivory90, margin: "sm" }) : null,
      ], { margin: "xl", paddingAll: "16px", cornerRadius: "14px", backgroundColor: C.glass, borderColor: C.goldLine, borderWidth: "1px" }),
      samplePanel(bp),
    ], { paddingAll: "20px", background: { type: "linearGradient", angle: "180deg", startColor: C.tealDeep, endColor: C.tealMid } }),
    footer: box("horizontal", [
      para(`${prepared}${business ? ` · ${business}` : ""}\n${from}`, { size: "xs", color: C.ivory70 }),
      text("เลื่อนดู →", { size: "xs", color: C.goldLight, weight: "bold", flex: 0, gravity: "bottom" }),
    ], { backgroundColor: C.tealMid, paddingTop: "6px", paddingBottom: "18px", paddingStart: "20px", paddingEnd: "20px" }),
  };
}

function dataBubble(bp) {
  const inputs = arr(bp.inputs).filter((item) => nonEmpty(item?.source));
  return contentBubble(2, "ข้อมูล · เครื่องมือ", "เริ่มจากงานนี้ เพราะอะไร", [
    // ทวนสิ่งที่ผู้เรียนบอก (ฟังแล้วจริง) ก่อนเหตุผลที่เลือกงานนี้
    nonEmpty(bp.businessRestated) ? para(s(bp.businessRestated), { size: "sm", color: C.muted }) : null,
    nonEmpty(bp.whyThisFirst) ? box("horizontal", [
      box("vertical", [], { width: "3px", backgroundColor: C.gold, flex: 0 }),
      para(s(bp.whyThisFirst), { size: "sm", margin: "md" }),
    ], { margin: nonEmpty(bp.businessRestated) ? "lg" : "none" }) : null,
    label("ข้อมูลที่ Agent อ่าน", C.goldDeep, { margin: "xl" }),
    ...inputs.map((item, index) => numberedRow(two(index), item.source, item.note, { margin: index ? "md" : "sm" })),
    nonEmpty(bp.toolsHint) ? box("vertical", [
      label("เครื่องมือ", C.teal),
      para(s(bp.toolsHint), { size: "sm", margin: "xs" }),
    ], { margin: "xl", paddingAll: "12px", cornerRadius: "10px", backgroundColor: C.tealTint }) : null,
  ]);
}

function workBubble(bp) {
  const steps = arr(bp.steps).filter((item) => nonEmpty(item?.what));
  const outputs = arr(bp.outputs).map((item) => s(item?.deliverable)).filter(Boolean);
  return contentBubble(3, "ขั้นตอน · ตรวจผล", "Agent ทำงานอย่างไร", [
    ...steps.map((item, index) => numberedRow(two(index), item.what, "", { margin: index ? "md" : "none", noColor: C.teal, bold: false })),
    outputs.length ? box("vertical", [
      label("ผลงานที่คุณเปิดตรวจได้", C.goldDeep),
      spans(outputs.flatMap((item, index) => [
        { text: `${index ? "\n" : ""}✓  `, color: C.goldDeep, weight: "bold" },
        { text: item },
      ]), { size: "sm", margin: "sm", lineSpacing: "6px" }),
    ], { margin: "xl", paddingAll: "14px", cornerRadius: "12px", backgroundColor: C.ivoryCard, borderColor: C.hair, borderWidth: "1px" }) : null,
  ]);
}

// รายการ "ห้ามทำ" อยู่ใต้หัว ห้ามทำ/ห้าม อยู่แล้ว — โมเดลเผลอขึ้นต้นด้วย "ห้าม" ซ้ำ ตัดออกตอนแสดง (ข้อความเดิมไม่หาย)
const withoutLeadingBan = (item) => s(item).replace(/^ห้าม\s*/u, "") || s(item);

function rung({ title, items, bg, accent, border = null, icon }) {
  const list = arr(items).map(s).filter(Boolean);
  if (!list.length) return null;
  return box("vertical", [
    label(`${icon}  ${title}`, accent, { size: "sm" }),
    para(list.map((item) => `• ${item}`).join("\n"), { size: "sm", margin: "xs" }),
  ], {
    margin: "md", paddingAll: "12px", cornerRadius: "10px", backgroundColor: bg,
    ...(border ? { borderColor: border, borderWidth: "2px" } : {}),
  });
}

function authorityBubble(bp) {
  const a = bp.authority || {};
  return contentBubble(4, "ขอบเขตอำนาจ", "AI ช่วยเตรียม คุณเป็นคนตัดสิน", [
    para("ตกลงกันก่อนเริ่มว่า Agent ทำเองได้แค่ไหน", { size: "sm", color: C.muted }),
    rung({ title: "ทำได้เลย", items: a.canDo, bg: C.tealTint, accent: C.teal, icon: "●" }),
    rung({ title: "ร่างไว้ รอคนตรวจ", items: a.draftsForReview, bg: C.ivoryCard, accent: C.teal, icon: "○" }),
    rung({ title: "คุณตัดสิน", items: a.ownerDecides, bg: C.goldTint, accent: C.goldDeep, border: C.gold, icon: "★" }),
    rung({ title: "ห้ามทำ", items: arr(a.never).map(withoutLeadingBan), bg: C.rustTint, accent: C.rust, icon: "✕" }),
  ]);
}

function pilotBubble(bp) {
  const days = arr(bp.pilot7days).filter((item) => nonEmpty(item?.action));
  return contentBubble(5, "ทดลอง 7 วัน", "เริ่มเล็ก ตัดสินจากหลักฐาน", [
    ...days.map((item, index) => {
      const last = index === days.length - 1;
      return box("horizontal", [
        box("vertical", [
          text(s(item.day) || `ช่วง ${index + 1}`, { size: "xs", color: last ? C.tealDeep : C.ivory, weight: "bold", align: "center" }),
        ], { width: "62px", flex: 0, paddingAll: "3px", cornerRadius: "6px", backgroundColor: last ? C.gold : C.teal }),
        para(s(item.action), { size: "sm", margin: "md" }),
      ], { ...(index ? { margin: "md" } : {}), alignItems: "flex-start" });
    }),
    box("vertical", [
      spans([
        { text: "ไปต่อเมื่อ  ", weight: "bold", color: C.teal },
        { text: "ผ่านตรวจโดยแก้นิดเดียว · ใช้เวลารวมน้อยลง · มีคนรับงานต่อชัด\n" },
        { text: "หยุดหรือปรับ  ", weight: "bold", color: C.rust },
        { text: "ข้อมูลขาดจนต้องเดา · ต้องแก้เกือบทุกชิ้น · ทำเกินขอบเขตที่ตกลง" },
      ], { size: "sm", lineSpacing: "6px" }),
    ], { margin: "xl", paddingAll: "12px", cornerRadius: "10px", backgroundColor: C.ivoryCard }),
  ]);
}

// ไม่มีบรรทัดตายตัวเรื่อง "ยอดขายดูตามรอบธุรกิจ": งานที่ไม่เกี่ยวกับยอดขาย (ตอบสเปก เอกสาร) อ่านแล้วเหมือนแม่แบบหลงมา
// และเมื่อมีตัววัดผลทางธุรกิจ โมเดลเขียนเงื่อนไขนั้นไว้ใน how ของตัวที่ 3 อยู่แล้ว (พรอมต์ข้อ metrics)
function measureBubble(bp) {
  const metrics = arr(bp.metrics).filter((item) => nonEmpty(item?.name));
  const watchOuts = arr(bp.watchOuts).map(s).filter(Boolean);
  return contentBubble(6, "วัดผล · ข้อควรระวัง", "วัดอะไร และระวังอะไร", [
    ...metrics.map((item, index) => numberedRow(two(index), item.name, item.how, { margin: index ? "md" : "none" })),
    watchOuts.length ? box("vertical", [
      label("ข้อควรระวัง", C.rust),
      para(watchOuts.map((item) => `• ${item}`).join("\n"), { size: "sm", margin: "xs" }),
    ], { margin: "xl", paddingAll: "12px", cornerRadius: "10px", backgroundColor: C.rustTint }) : null,
  ]);
}

/**
 * ใบปิด: ภาพก้าวถัดไป → ก้าวแรกพรุ่งนี้ (สิ่งที่ลงมือได้) → ชี้ไปที่คำสั่งตั้งต้นในข้อความถัดไป → คำขอบคุณ
 * กล่องก้าวถัดไปเป็นพื้นโปร่งไม่มีขอบ (ภาพข้างหน้า) ส่วนก้าวแรกมีขอบทอง (สิ่งที่ต้องทำจริง) — ตาไปจบที่ก้าวแรก
 */
function closingBubble(bp, { campaign, name }) {
  const title = s(campaign?.title);
  const thanks = title ? `ขอบคุณที่ร่วมคลาส ${title} นะคะ` : "ขอบคุณที่ร่วมคลาสกับโค้ชง้วงนะคะ";
  const greeting = name ? `${honorific(name)} ` : "";
  const cta = ctaTextOf(campaign);
  return {
    type: "bubble",
    size: "mega",
    body: box("vertical", [
      box("horizontal", [text("จากทีมพี่ง้วง", { size: "xs", color: C.gold, weight: "bold" }), pageMark(TOTAL_BUBBLES)]),
      box("vertical", [], { width: "36px", height: "2px", backgroundColor: C.gold, margin: "md" }),
      para("AI ช่วยเตรียม", { size: "xl", color: C.ivory, weight: "bold", margin: "lg" }),
      para("คุณเป็นคนตัดสิน", { size: "xl", color: C.gold, weight: "bold" }),
      nonEmpty(bp.nextLevel) ? box("vertical", [
        label(NEXT_LEVEL_LABEL, C.goldLight),
        para(s(bp.nextLevel), { size: "sm", color: C.ivory90, margin: "sm" }),
      ], { margin: "xl", paddingAll: "14px", cornerRadius: "14px", backgroundColor: C.glass }) : null,
      nonEmpty(bp.firstStepTomorrow) ? box("vertical", [
        label("ก้าวแรก พรุ่งนี้ · 30 นาที", C.goldLight),
        para(s(bp.firstStepTomorrow), { size: "md", color: C.ivory, weight: "bold", margin: "sm" }),
      ], { margin: nonEmpty(bp.nextLevel) ? "md" : "xl", paddingAll: "16px", cornerRadius: "14px", backgroundColor: C.glass, borderColor: C.goldLine, borderWidth: "1px" }) : null,
      spans([
        { text: "คำสั่งตั้งต้น", weight: "bold", color: C.goldLight },
        { text: "ของผู้ช่วยตัวนี้อยู่ในข้อความถัดไป กดค้างเพื่อคัดลอกไปลองในแชท AI ได้ทันที" },
      ], { size: "sm", color: C.ivory90, margin: "lg" }),
      para(`${greeting}${thanks} ติดตรงไหนหรืออยากให้ช่วยดูต่อ ทักลูกแพรในแชทนี้ได้เลยค่ะ`, { size: "sm", color: C.ivory90, margin: "md" }),
    ], { paddingAll: "22px", background: { type: "linearGradient", angle: "180deg", startColor: C.tealDeep, endColor: C.tealMid } }),
    footer: box("vertical", [
      box("vertical", [para(cta, { size: "sm", color: C.tealDeep, weight: "bold", align: "center" })], {
        backgroundColor: C.gold, cornerRadius: "10px", paddingAll: "12px",
        action: { type: "message", label: "คุยต่อกับทีม", text: cta },
      }),
      text(`ลูกแพร · ${BRAND}`, { size: "xs", color: C.ivory70, align: "center", margin: "md" }),
    ], { backgroundColor: C.tealMid, paddingTop: "4px", paddingBottom: "18px", paddingStart: "22px", paddingEnd: "22px" }),
  };
}

/* ---------------------------------- public --------------------------------- */

/** altText ≤ 300 — สิ่งที่ขึ้นในแจ้งเตือนและรายการแชท */
export function blueprintAltText(blueprint) {
  const parts = ["การวางระบบ AI Agent ของคุณมาแล้วค่ะ", s(blueprint?.headline), s(blueprint?.agentName)].filter(Boolean);
  return cpSlice(parts.join(" · "), BLUEPRINT_ALT_TEXT_MAX);
}

/**
 * การ์ดเลื่อน 7 ใบจาก blueprint ที่ผ่าน validateBlueprint แล้ว (เรนเดอร์แบบกันพัง: ช่องว่างถูกข้าม)
 * @param {object} blueprint
 * @param {{ campaign?: object, displayName?: string }} options displayName = ชื่อโปรไฟล์ LINE (ใช้เมื่อดูเหมือนชื่อคนเท่านั้น)
 */
export function buildBlueprintFlex(blueprint, { campaign = {}, displayName = "" } = {}) {
  const bp = blueprint && typeof blueprint === "object" ? blueprint : {};
  const name = cpSlice(addressableCustomerName({ displayName }), 20);
  return {
    type: "flex",
    altText: blueprintAltText(bp),
    contents: {
      type: "carousel",
      contents: [
        coverBubble(bp, { campaign, name }),
        dataBubble(bp),
        workBubble(bp),
        authorityBubble(bp),
        pilotBubble(bp),
        measureBubble(bp),
        closingBubble(bp, { campaign, name }),
      ],
    },
  };
}

/**
 * ข้อความตอบรับทันทีหลังได้ #AIAGENT: [ข้อความของลูกแพร, ใบรับ Flex]
 * now = เวลาปัจจุบัน (ms) — คำขอที่เข้ามาหลังเวลาส่งรอบนี้แล้วจะได้ "ภายใน 24 ชั่วโมง" แทนวันเวลาที่ผ่านไปแล้ว
 */
export function buildAckMessages({ campaign = {}, business = "", now = Date.now() } = {}) {
  const sendLabel = bangkokSendLabel(campaign?.sendAt);
  const when = sendLabel && Date.parse(campaign.sendAt) > Number(now) ? sendLabel : null;
  const oaId = oaIdOf(campaign);
  // มีข้อมูลติดต่อปนมา (ถูกปิดเป็น [เบอร์] ฯลฯ) = ไม่ทวนชื่อธุรกิจเลย ดีกว่าโชว์ป้ายแปลก ๆ หรือสะท้อนข้อมูลส่วนตัว
  const cleanedBusiness = cleanIntakeField(business, 60);
  const businessText = MASK_TOKEN_RE.test(cleanedBusiness) ? "" : cleanedBusiness;
  const forWhom = businessText ? `สำหรับ${businessText}` : "สำหรับธุรกิจของคุณ";
  const whenLong = when ? when.long : "ภายใน 24 ชั่วโมง";
  const title = s(campaign?.title);
  const ackText = [
    `ได้รับแล้วค่ะ ขอบคุณที่ร่วมคลาส${title ? ` ${title}` : "กับโค้ชง้วง"} นะคะ`,
    `ทีมพี่ง้วงจะส่งแผนการวางระบบ AI Agent ${forWhom} ให้ในแชทนี้ ${whenLong} ค่ะ`,
    `รบกวนเป็นเพื่อนกับ ${oaId} ไว้นะคะ ข้อความจะได้ส่งถึงคุณค่ะ`,
  ].join("\n");

  const row = (key, value) => box("horizontal", [
    text(key, { size: "xs", color: C.muted, flex: 2 }),
    para(value, { size: "sm", color: C.ink, weight: "bold", flex: 5 }),
  ], { margin: "md" });

  const receipt = {
    type: "bubble",
    size: "kilo",
    header: box("vertical", [
      para(title || "การวางระบบ AI Agent", { size: "xs", color: C.gold, weight: "bold" }),
      text("ได้รับแล้ว ✓", { size: "xl", color: C.ivory, weight: "bold", margin: "sm" }),
    ], { backgroundColor: C.teal, paddingAll: "18px" }),
    body: box("vertical", [
      label("การวางระบบ AI Agent ของคุณ"),
      row("ธุรกิจ", businessText || "ธุรกิจของคุณ"),
      row("ส่งให้", when ? `${when.short} (${when.date})` : "ภายใน 24 ชั่วโมง"),
      row("ช่องทาง", `แชทนี้ (${oaId})`),
      rule(C.hair, "lg"),
      para(`เป็นเพื่อนกับ ${oaId} ไว้ ข้อความจึงส่งถึงคุณได้`, { size: "xs", color: C.muted, margin: "md" }),
    ], { backgroundColor: C.ivory, paddingAll: "18px" }),
  };

  return [
    { type: "text", text: ackText },
    {
      type: "flex",
      altText: cpSlice(`ได้รับแล้ว ✓ · ส่งการวางระบบ AI Agent ให้${when ? when.short : "ภายใน 24 ชั่วโมง"}`, BLUEPRINT_ALT_TEXT_MAX),
      contents: receipt,
    },
  ];
}

// ลำดับขั้นใช้เลขไทย (๑. ๒.) — ด่านราคานับเฉพาะเลขอารบิก "1. ตีราคาทอง" ถูกตีเป็นราคา แต่ "๑. ตีราคาทอง" ไม่ใช่
const stepNo = (index) => `${toThaiNumerals(index + 1)}.`;

/** ข้อความล้วนสำรอง (≤ 2,000 ตัวอักษร) — ยาวเกินจะตัดหมวดรองทิ้งทั้งหมวด ไม่ตัดกลางประโยค */
export function blueprintToText(blueprint, { campaign = {} } = {}) {
  const bp = blueprint && typeof blueprint === "object" ? blueprint : {};
  const bullets = (items) => items.map(s).filter(Boolean).map((item) => `• ${item}`).join("\n");
  const a = bp.authority || {};
  const group = (name, items) => (arr(items).some(nonEmpty) ? `${name}\n${bullets(arr(items))}` : "");
  const head = [
    "การวางระบบ AI Agent ของคุณ",
    s(bp.headline),
    "",
    nonEmpty(bp.agentName) ? `ผู้ช่วยตัวแรก: ${s(bp.agentName)}` : "",
    nonEmpty(bp.mission) ? `เป้าหมาย: ${s(bp.mission)}` : "",
    s(bp.businessRestated),
  ].filter((line, index) => index === 2 || line).join("\n");
  const sample = sampleLines(bp);
  const sampleTitle = s(bp.sampleOutput?.title);
  const sections = [
    [SAMPLE_PANEL_LABEL, sample.length ? [
      sampleTitle, ...sample.map((line) => (line.decision ? `★ รอคุณตัดสิน: ${line.text}` : `• ${line.text}`)),
    ].filter(Boolean).join("\n") : ""],
    ["ทำไมเริ่มที่งานนี้", s(bp.whyThisFirst)],
    ["ข้อมูลที่ Agent อ่าน", bullets(arr(bp.inputs).map((item) => [s(item?.source), s(item?.note)].filter(Boolean).join(": ")))],
    ["ขั้นตอน", arr(bp.steps).map((item) => s(item?.what)).filter(Boolean).map((what, index) => `${stepNo(index)} ${what}`).join("\n")],
    ["ผลงานที่คุณเปิดตรวจได้", bullets(arr(bp.outputs).map((item) => item?.deliverable))],
    ["ขอบเขตอำนาจ (AI ช่วยเตรียม คุณเป็นคนตัดสิน)", [
      group("ทำได้เลย", a.canDo), group("ร่างไว้ รอคนตรวจ", a.draftsForReview),
      group("คุณตัดสิน", a.ownerDecides), group("ห้ามทำ", arr(a.never).map(withoutLeadingBan)),
    ].filter(Boolean).join("\n")],
    ["ทดลอง 7 วัน", arr(bp.pilot7days).filter((item) => nonEmpty(item?.action)).map((item) => `${s(item.day)}: ${s(item.action)}`).join("\n")],
    ["วัดผล", bullets(arr(bp.metrics).map((item) => [s(item?.name), s(item?.how)].filter(Boolean).join(": ")))],
    ["ข้อควรระวัง", bullets(arr(bp.watchOuts))],
    ["เครื่องมือ", s(bp.toolsHint)],
    [NEXT_LEVEL_LABEL, s(bp.nextLevel)],
    ["ก้าวแรก พรุ่งนี้ (30 นาที)", s(bp.firstStepTomorrow)], // จบที่สิ่งที่ลงมือได้ เหมือนการ์ด
  ].filter(([, body]) => body);
  const title = s(campaign?.title);
  const closing = `ขอบคุณที่ร่วมคลาส${title ? ` ${title} นะคะ` : "กับโค้ชง้วงนะคะ"} อยากคุยต่อ ทักลูกแพรในแชทนี้ได้เลยค่ะ\nลูกแพร · ทีมพี่ง้วง`;
  // ยาวเกิน: เก็บหัว + หน้าตางาน + ขั้นตอน + ขอบเขตอำนาจ + ก้าวแรกไว้ ตัดหมวดรองตามลำดับนี้
  const dropOrder = ["เครื่องมือ", "ข้อควรระวัง", "ข้อมูลที่ Agent อ่าน", "วัดผล", NEXT_LEVEL_LABEL, "ผลงานที่คุณเปิดตรวจได้",
    "ทำไมเริ่มที่งานนี้", "ทดลอง 7 วัน", SAMPLE_PANEL_LABEL];
  const render = (list) => priceSafeNumbers([head, ...list.map(([name, body]) => `\n${name}\n${body}`), `\n${closing}`].join("\n"));
  let kept = sections;
  let out = render(kept);
  for (const name of dropOrder) {
    if ([...out].length <= BLUEPRINT_TEXT_MAX) break;
    kept = kept.filter(([section]) => section !== name);
    out = render(kept);
  }
  return cpSlice(out, BLUEPRINT_TEXT_MAX);
}

// ชื่อธุรกิจที่เป็นกิจกรรม ("ผลิตและจำหน่ายเครื่องดื่ม") ต่อท้าย "ผู้ช่วยของ..." ไม่ได้ → เติม "ธุรกิจ" ให้เป็นชื่อกิจการ
const ENTITY_LABEL_RE = /^(?:ร้าน|บริษัท|โรงงาน|โรงแรม|โรงเรียน|โรงพยาบาล|คลินิก|ธุรกิจ|กิจการ|เอเจนซี|เอเจนซี่|รีสอร์ท|ที่|ศูนย์|สถาบัน|สำนักงาน|ห้าง|อู่|ฟาร์ม|แบรนด์|โฮสเทล|คาเฟ่|สตูดิโอ|ออฟฟิศ|สปา|ตลาด|โครงการ)/u;
const entityLabel = (label) => (ENTITY_LABEL_RE.test(label) ? label : `ธุรกิจ${/^[A-Za-z0-9]/u.test(label) ? " " : ""}${label}`);

// "คุณ" ในช่องของแผนหมายถึงเจ้าของ แต่ในคำสั่งตั้งต้น "คุณ" คือผู้ช่วย AI และเจ้าของพูดเป็น "ฉัน"
// เปลี่ยนเฉพาะคำว่า คุณ ที่ยืนเดี่ยว (ตัดคำด้วย Intl.Segmenter) — คุณภาพ คุณค่า คุณสมบัติ ไม่โดน
const BRIEF_WORD_SEGMENTER = typeof Intl === "object" && typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter("th", { granularity: "word" }) : null;
function ownerVoice(value) {
  const text = s(value);
  if (!text.includes("คุณ") || !BRIEF_WORD_SEGMENTER) return text;
  return [...BRIEF_WORD_SEGMENTER.segment(text)].map((part) => (part.segment === "คุณ" ? "ฉัน" : part.segment)).join("");
}

/** ส่วนต่าง ๆ ของคำสั่งตั้งต้น — level = ระดับการย่อเมื่อยาวเกิน (0 = เต็ม) */
function briefSections(bp, level) {
  const agent = s(bp.agentName) || FALLBACK_AGENT_NAME;
  const business = businessLabelOf(bp) ? entityLabel(businessLabelOf(bp)) : "";
  // "ผู้ช่วยตีราคาทอง ผู้ช่วยของร้านทอง" ซ้ำคำ → ชื่อที่มีคำว่าผู้ช่วยอยู่แล้วใช้ "ประจำ" · ไม่รู้ธุรกิจ = "ในธุรกิจของฉัน"
  const role = agent.includes("ผู้ช่วย") ? "" : "ผู้ช่วย";
  const whose = business ? (role ? `ผู้ช่วยของ${business}ของฉัน` : `ประจำ${business}ของฉัน`) : `${role}ในธุรกิจของฉัน`;
  const a = bp.authority || {};
  const take = (items, max) => arr(items).map(ownerVoice).filter(Boolean).slice(0, max);
  const itemsMax = level >= 2 ? 2 : 3;
  const bulletLines = (items) => items.map((item) => `• ${item}`);
  const inputs = arr(bp.inputs).filter((item) => nonEmpty(item?.source)).map((item) => (
    level >= 1 || !nonEmpty(item.note) ? ownerVoice(item.source) : `${ownerVoice(item.source)}: ${ownerVoice(item.note)}`
  ));
  const steps = arr(bp.steps).map((item) => ownerVoice(item?.what)).filter(Boolean);
  const outputs = arr(bp.outputs).map((item) => ownerVoice(item?.deliverable)).filter(Boolean);
  const sample = sampleLines(bp).slice(0, level >= 3 ? 2 : 4);
  const sampleTitle = s(bp.sampleOutput?.title);
  const rules = [
    ["ทำได้เลย:", take(a.canDo, itemsMax)],
    ["ร่างให้ฉันตรวจก่อนใช้:", take(a.draftsForReview, itemsMax)],
    ["ถามฉันก่อนเสมอ:", take(a.ownerDecides, itemsMax)],
    ["ห้าม:", take(arr(a.never).map(withoutLeadingBan), itemsMax)],
  ].filter(([, items]) => items.length);
  return [
    [AGENT_BRIEF_HEADER, "ช่วงแรกลองกับข้อมูลที่ไม่มีข้อมูลส่วนตัวลูกค้าก่อน (ตัดชื่อ เบอร์โทร และเลขบัญชีออก)"],
    [`คุณคือ ${agent} ${whose}`, nonEmpty(bp.mission) ? `เป้าหมาย: ${ownerVoice(bp.mission)}` : ""],
    inputs.length ? ["ข้อมูลที่ฉันจะส่งให้", ...bulletLines(inputs)] : [],
    steps.length ? ["ทำตามลำดับ", ...steps.map((step, index) => `${stepNo(index)} ${step}`)] : [],
    outputs.length ? ["ส่งผลงานกลับเป็น", ...bulletLines(outputs)] : [],
    sample.length ? [
      "หน้าตาที่ฉันอยากได้ เช่น", sampleTitle,
      ...bulletLines(sample.map((line) => (line.decision ? `รอคุณตัดสิน: ${line.text}` : line.text))),
    ] : [],
    [
      "กติกา",
      ...rules.flatMap(([name, items]) => [name, ...bulletLines(items)]),
      "ถ้าข้อมูลไม่พอ บอกว่าขาดอะไร อย่าเดา",
    ],
    ["เริ่มจากถามฉันว่าวันนี้มีข้อมูลอะไรให้ดู"],
  ].map((lines) => lines.filter(Boolean)).filter((lines) => lines.length);
}

/**
 * "คำสั่งตั้งต้น" ข้อความเดียวที่ลูกค้ากดค้างคัดลอกไปวางในแชท AI ที่ใช้อยู่ได้ทันที (≤ 2,500 ตัวอักษร ไม่มี markdown ไม่มีลิงก์)
 * ประกอบจากช่องของแผนตรง ๆ ไม่เรียกโมเดล — ช่องผ่านด่านความซื่อตรงมาแล้ว ส่วนที่เติมที่นี่เป็นข้อความคงที่
 * เลขใกล้คำเรื่องเงินในข้อความรวมถูกเขียนเป็นคำไทย/เลขไทย (priceSafeNumbers) ให้ผ่านด่านราคาเหมือนการ์ด
 * ยาวเกิน = ย่อเป็นขั้น: ตัดคำอธิบายข้อมูล → กติกาเหลือกลุ่มละสองข้อ → หน้าตางานเหลือสองบรรทัด → ตัดท้ายที่ขอบบรรทัด
 */
export function buildAgentBriefText(blueprint, { campaign = {} } = {}) {
  void campaign; // สงวนไว้: ข้อความเดียวกันทุกแคมเปญ (ไม่อ้างชื่อคลาสในคำสั่งที่ลูกค้าเอาไปใช้ต่อ)
  const bp = blueprint && typeof blueprint === "object" ? blueprint : {};
  let out = "";
  for (let level = 0; level <= 3; level += 1) {
    out = priceSafeNumbers(briefSections(bp, level).map((lines) => lines.join("\n")).join("\n\n"));
    if (cpLength(out) <= AGENT_BRIEF_MAX) return out;
  }
  // ยังยาวเกิน (ข้อมูลผิดรูปผิดขนาด): ตัดที่ขอบบรรทัด แล้วปิดด้วยบรรทัดเริ่มงานเสมอ
  const ending = "เริ่มจากถามฉันว่าวันนี้มีข้อมูลอะไรให้ดู";
  const lines = out.split("\n");
  const kept = [];
  for (const line of lines) {
    if (cpLength([...kept, line, "", ending].join("\n")) > AGENT_BRIEF_MAX) break;
    kept.push(line);
  }
  return [...kept, "", ending].join("\n");
}

/** ขนาด JSON ของ contents (ไบต์ UTF-8) — ผู้ส่งใช้ตัดสินว่าจะส่ง Flex หรือ blueprintToText แทน */
export function flexContentsBytes(message) {
  return new TextEncoder().encode(JSON.stringify(message?.contents ?? null)).length;
}
