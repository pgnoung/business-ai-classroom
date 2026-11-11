// blueprintIntakeParse.mjs — แยก "ธุรกิจ" กับ "งานที่อยากให้ผู้ช่วย AI ทำก่อน" จากข้อความ #AIAGENT (11 ต.ค. 2026)
//
// หน้าเว็บของคลาสเติมข้อความให้ในช่องแชท LINE แบบนี้ แล้วผู้เรียนกดส่งเอง:
//   #AIAGENT IESA6
//   ธุรกิจ: <business>
//   อยากให้ผู้ช่วย AI ทำก่อน: <answer>
//   (ขอรับไอเดียการวางระบบ AI Agent ภายใน 24 ชม.)
// แต่คนแก้ข้อความก่อนกดส่งได้เสมอ — ตัวแยกต้องทน: ลบบรรทัด/สลับลำดับ/ไม่มีป้าย/พิมพ์ยาวมาก/อีโมจิ/ตัวควบคุม
// ไม่มีป้ายเลย = เก็บข้อความที่เหลือทั้งหมดเป็นคำตอบ (รับสิ่งที่เขาส่งมา ไม่เดาแทน)
// pure ล้วน ไม่มี I/O — เทสต์ทุกกรณีขอบได้
import { keywordRegex } from "./blueprintCampaignConfig.mjs";

export const BUSINESS_MAX = 120;
export const ANSWER_MAX = 400;
export const RAW_MAX = 2000;

// ตัวควบคุม (ยกเว้นขึ้นบรรทัด) zero-width และ bidi override — ไม่ควรเก็บ/ส่งต่อให้โมเดล
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;

const BUSINESS_LABEL = /^(?:ประเภท\s*ธุรกิจ|ธุรกิจ(?:\s*ของ(?:ฉัน|ผม|เรา|หนู))?|กิจการ|business)\s*[:：=\-–—]?\s*/iu;
const ANSWER_LABEL = /^(?:อยากให้\s*ผู้ช่วย(?:\s*AI)?\s*ทำ(?:\s*ก่อน)?|อยาก\s*มอบหมาย(?:\s*ให้\s*เขา)?(?:\s*ทำ)?(?:\s*ก่อน)?|งาน(?:ที่อยากให้\s*AI\s*ทำ|แรก)|คำตอบ|answer)\s*[:：=\-–—]?\s*/iu;
// บรรทัดท้ายที่หน้าเว็บเติมให้ — ไม่ใช่เนื้อหาของผู้เรียน
const FOOTER = /^\(?\s*ขอรับ\s*ไอเดีย.*$/u;

/** ตัดตาม code point (ไม่หั่นอีโมจิ/สระไทยกลางตัว) แล้วตัดช่องว่างท้าย */
export function capCodePoints(text, max) {
  const chars = [...String(text ?? "")];
  return chars.length <= max ? String(text ?? "") : chars.slice(0, max).join("").trimEnd();
}

function cleanBlock(lines) {
  return lines.map((line) => line.replace(/[ \t]+/gu, " ").trim()).filter(Boolean).join("\n").trim();
}

/**
 * @returns {{ business: string, answer: string, rawText: string, labelled: boolean }}
 *   rawText = ข้อความทั้งก้อนที่ล้างตัวควบคุมแล้ว (เพดาน RAW_MAX) · business/answer ถูกตัดเพดานแล้ว
 */
export function parseBlueprintSubmission(text, { keyword = "#AIAGENT", campaignId = "" } = {}) {
  const raw = String(text ?? "").normalize("NFC").replace(/\r\n?/gu, "\n").replace(CONTROL, "");
  const rawText = capCodePoints(raw.trim(), RAW_MAX);
  // ตัดคีย์เวิร์ด (และรหัสแคมเปญที่ตามมาทันที เช่น "IESA6") ออกจากต้นข้อความ
  let body = rawText.replace(keywordRegex(keyword), "");
  if (campaignId) {
    const code = new RegExp(`^[ \\t]*${campaignId.replace(/[-]/gu, "\\-")}(?![\\p{L}\\p{N}_])[ \\t]*[:：\\-]?`, "iu");
    body = body.replace(code, "");
  }
  const lines = body.split("\n");
  const blocks = { business: [], answer: [], loose: [] };
  let current = "loose";
  for (const original of lines) {
    const line = original.trim();
    if (!line) continue;
    if (FOOTER.test(line)) continue;
    if (BUSINESS_LABEL.test(line)) {
      current = "business";
      blocks.business.push(line.replace(BUSINESS_LABEL, ""));
      continue;
    }
    if (ANSWER_LABEL.test(line)) {
      current = "answer";
      blocks.answer.push(line.replace(ANSWER_LABEL, ""));
      continue;
    }
    blocks[current].push(line);
  }
  const labelled = blocks.business.length > 0 || blocks.answer.length > 0;
  let business = cleanBlock(blocks.business);
  let answer = cleanBlock(blocks.answer);
  const loose = cleanBlock(blocks.loose);
  // ไม่มีป้าย = ทั้งก้อนคือคำตอบ · มีแต่ป้ายธุรกิจ = ข้อความลอยคือคำตอบ · มีแต่ป้ายคำตอบ = ข้อความลอยคือธุรกิจ
  if (loose) {
    if (!answer) answer = loose;
    else if (!business) business = loose;
    else answer = `${answer}\n${loose}`;
  }
  return {
    business: capCodePoints(business.replace(/\n+/gu, " "), BUSINESS_MAX),
    answer: capCodePoints(answer, ANSWER_MAX),
    rawText,
    labelled,
  };
}
