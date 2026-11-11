// postCheck.mjs — ตรวจร่างของ v3 แบบไม่เรียกโมเดล แล้วสรุปเป็นบันทึกแก้หนึ่งรอบ (spec v3.1 §F)
// ลำดับ: แกะ <reply> → แก้อัตโนมัติ → ตรวจก่อนเติมช่อง (เงิน/ช่อง/วันที่) → เติมช่อง → ตรวจหลังเติม (H1–H9 แข็ง, S1–S8 อ่อน)
// ด่านทุกด่านของไปป์ไลน์ยังทำงานตามเดิมหลังจากนี้ — ไฟล์นี้กันแค่สิ่งที่ v3 ต้องไม่ส่งออกไปตั้งแต่ต้น
import { isClosingQuestion } from "../handoffClosing.mjs";
import { announcesCorrection } from "../priceConsistency.mjs";
import { dropGenericAddress } from "../customerAddress.mjs";
import { CLASS_NAMES } from "./priceFacts.mjs";
import { HELP_CHOOSE_RE } from "./afterPrice.mjs";
import { DETAILS_ASK_RE } from "./stage.mjs";
import { closingOf, offerTypes, PREP_ASK_RE, WORKSHOP_PREP_RE } from "./closings.mjs";
import { askLike, avoidTypesOf, CARE_LINE, closingSimilarity, closingTypes, hardshipSalesOffer, isOfferForm, normalizeClosing, repeatsClosing,
  sentencesOf as offerSentencesOf } from "./closings.mjs";
import { expandSlots, insertSlot, slotTokens } from "./slots.mjs";
import { stripFakeScarcity } from "./socialProof.mjs";

const MONTHS = [["มกราคม", "ม.ค."], ["กุมภาพันธ์", "ก.พ."], ["มีนาคม", "มี.ค."], ["เมษายน", "เม.ย."], ["พฤษภาคม", "พ.ค."], ["มิถุนายน", "มิ.ย."],
  ["กรกฎาคม", "ก.ค."], ["สิงหาคม", "ส.ค."], ["กันยายน", "ก.ย."], ["ตุลาคม", "ต.ค."], ["พฤศจิกายน", "พ.ย."], ["ธันวาคม", "ธ.ค."]];
const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const MONTH_ALT = MONTHS.flatMap(([full, short]) => [esc(full), `${esc(short.slice(0, -1))}\\.?`]).join("|");
// ตรวจความเร็ว (รีวิวเคสจริงทั้งวัน 5 ต.ค.): รายการวันที่ยาวเกินแปดวันในประโยคเดียวไม่มีจริง — จำกัดไว้ ตัวจับไม่ย้อนรอยกับเลขยาว ๆ
const THAI_DATE = new RegExp(`((?:\\d{1,2}\\s*(?:,|และ|หรือ|กับ|[-–])\\s*){0,8}\\d{1,2})\\s*(${MONTH_ALT})`, "gu");
const MONEY_WORD = /บาท|฿|ราคา|ค่า|ยอด|ชำระ|จ่าย|ส่วนลด/u;
const META_LEAK = /บันทึกจากระบบ|งานของเทิร์นนี้|ข้อเท็จจริงของเทิร์นนี้|ช่องเติม|\{\{|ระบบบอก|ตามกติกา/u;
export const EXIT_PHRASE = /ทักลูกแพร(?:มา)?ได้|พร้อมเมื่อไหร่|ไว้ค่อย|ถ้ามีคำถาม/u;
const HARD_CLOSE = /สมัครเลยไหม|เริ่มขั้นตอนสมัคร|จองเลยไหม|โอนได้เลย/u;
const STOCK_PHRASE = "ต่อยอดให้ AI ช่วยงานได้เป็นระบบขึ้น";
// คำนามธรรมที่พี่ง้วงเลือกทิ้ง (dev 4 ต.ค. 6.1 ยังเลี่ยงมาเป็น "ช่วยงานเป็นระบบขึ้น")
const STOCK_ABSTRACT = /(?:ช่วยงาน|ทำงาน)(?:ได้)?เป็นระบบ(?:มาก)?ขึ้น/u;
// ยกคำพิมพ์ของลูกค้ามาครอบเครื่องหมายคำพูด (dev 4 ต.ค. sep-007 \u201cได้คระย\u201d)
const QUOTED_SPAN = /[\u201c"]([^\u201d"\n]{1,40})[\u201d"]/gu;
const LOGIC_OPENER = /^(?:เพื่อแนะนำ|ถ้า|สำหรับ|จากที่)/u;
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (ตรวจความเร็ว): \s* ติดกันรอบท่อนที่ไม่บังคับลองแบ่งช่องว่างทุกแบบ — ช่องว่างแต่ละช่วงต้องตามด้วยคำ (ผลเหมือนเดิม)
const TERM_CORRECTION = /(?:ไม่ได้|ไม่ใช่|ไม่)(?:\s*(?:แบ่ง|คิด|เป็น))?(?:\s*เป็น)?\s*(?:ราย)?เทอม/u;
const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu;
const SMILE = "\u{1F60A}";
const IMAGE_MARKER = /\[image:([^\]\s]+)\]/giu;
const URL = /https?:\/\/\S+|www\.\S+/giu;
const TRIAL_LINK_PROMISE = /เริ่ม(?:เรียน)?จาก\s*ลิงก์นี้|นี่(?:คือ|เป็น)\s*ลิงก์|(?:เปิด|เข้าเรียน(?:ได้)?)\s*(?:ที่|จาก)\s*ลิงก์|ส่ง.{0,20}ลิงก์.{0,20}(?:ให้|ได้เลย)|ลิงก์(?:ทดลองเรียน|คลาสทดลอง)?(?:นี้|ด้านล่าง|คือ)/iu;
const TRIAL_LINK_DENIAL = /(?:ยัง)?ไม่(?:ส่ง|ให้|แจก)|อย่า(?:เพิ่ง)?ส่ง|ห้ามส่ง|งดส่ง|ยกเลิก(?:การ)?ส่ง|เปลี่ยนใจไม่(?:ส่ง|เอา)|ไม่สามารถ(?:ส่ง|ให้)|(?:ส่ง|ให้).{0,12}ไม่ได้|ขอไม่(?:ให้)?ส่ง/u;
const TRIAL_LINK_CARRIED_DENIAL = /(?:ยัง)?ไม่(?:ส่ง|ให้)(?:แล้ว|ก่อน|ตอนนี้)?|อย่า(?:เพิ่ง)?ส่ง|ห้ามส่ง|งดส่ง|ยกเลิก(?:การส่ง)?|เปลี่ยนใจ.{0,12}ไม่(?:เอา|รับ|ส่ง)|ไม่(?:เอา|รับ)แล้ว/u;
const TRIAL_LINK_OTHER_TARGET = /(?:คลาส|คอร์ส)(?:เสียเงิน|สอนสด|หลัก)|ค่า(?:ใช้จ่าย|เรียน)|ราคา|สมัคร|ลงทะเบียน|เงิน|รายละเอียด|หัวข้อ|รีวิว/u;
const TOKEN_OR_IMAGE = /\{\{[^{}]+\}\}|\[IMAGE:[^\]]+\]/giu;
const QUESTION_STAGES = new Set(["DISCOVERY", "REASSURE", "CONCEPT", "MISREAD", "OBJECTION"]);
const MIRROR_STAGES = new Set(["DISCOVERY", "REASSURE", "BRIDGE", "MISREAD"]);
const CLASS_STAGES = new Set(["BRIDGE", "MISREAD", "DEAL_PAIR", "DEAL_SINGLE"]);
const PRICE_STAGES = new Set(["PRICE", "DEAL_PAIR", "DEAL_SINGLE"]);
const PARTICLE_SPAN = /^(?:ค่ะ|คะ|ครับ|นะ|จ้า|ค่า|ไหม|มั้ย|ด้วย|ได้|เลย|แล้ว|ที่|และ|หรือ)+$/u;

const chars = (text) => [...String(text)];
export const modelLength = (text) => chars(String(text).replace(TOKEN_OR_IMAGE, "").replace(/\s+/gu, " ").trim()).length;
const paragraphsOf = (text) => String(text).split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
export const sentencesOf = (line) => String(line).split(/(?<=(?:ค่ะ|คะ|ครับ|[?？!]))[ \t]+/u).map((part) => part.trim()).filter(Boolean);
const tidy = (text) => String(text).replace(/[ \t]{2,}/gu, " ").replace(/(?<![ \t])[ \t]+$/gmu, "").replace(/\n{3,}/gu, "\n\n").trim();

/** <plan>…</plan><reply>…</reply> แบบผ่อนปรน — ไม่มี <reply> = ตัด <plan> ทิ้งแล้วใช้ที่เหลือ */
export function parseReply(raw = "") {
  const value = String(raw ?? "");
  const plan = /<plan>([\s\S]*?)(?:<\/plan>|$)/iu.exec(value)?.[1]?.trim() || "";
  const tagged = /<reply>([\s\S]*?)(?:<\/reply>|$)/iu.exec(value);
  const reply = tagged ? tagged[1] : value.replace(/<plan>[\s\S]*?(?:<\/plan>|$)/giu, "");
  return { plan, reply: reply.replace(/<\/?(?:plan|reply)>/giu, "").trim(), tagged: Boolean(tagged) };
}

// ช่องเติม/รูปทั้งบรรทัด — ห้ามเอาอีโมจิไปต่อท้าย (เคสจริง 5 ต.ค.: บล็อกราคาต้องสะอาด)
const SLOT_LINE = /^\s*(?:\{\{[^{}]+\}\}|\[IMAGE:[^\]]+\])\s*$/iu;
const EMOJI_RUN = "(?:\\p{Extended_Pictographic}(?:\uFE0F|\u200D\\p{Extended_Pictographic}|\\p{Emoji_Modifier})*)";
const LEADING_EMOJI = new RegExp(`^\\s*((?:${EMOJI_RUN}\\s*)+)`, "u");
// อีโมจิขึ้นต้นประโยคกลางบรรทัด ("…นะคะ 😊 เมื่อสะดวก…") — ตัวแบ่งบอลลูนตัดหลังคำลงท้าย บอลลูนถัดไปจึงขึ้นต้นด้วยอีโมจิ
const MIDLINE_EMOJI = new RegExp(`((?:ค่ะ|คะ|ค่า|ครับ|นะ|จ้า|[?？!]))[ \\t]*((?:${EMOJI_RUN})+)[ \\t]+(?=\\S)`, "gu");
// "{{ราคา}} 😊" — ช่องถูกยกออกเป็นย่อหน้าของตัวเองตอนเติม อีโมจิที่ติดท้ายจะเหลือเป็นบอลลูนเดี่ยว → ทิ้ง
const EMOJI_AFTER_SLOT = new RegExp(`(\\{\\{[^{}\\n]+\\}\\})[ \\t]*(?:${EMOJI_RUN}[ \\t]*)+`, "gu");

/**
 * บอลลูนต้องไม่ขึ้นต้นด้วยอีโมจิ (เคสจริง 5 ต.ค.: บอลลูนที่สองของข้อความราคาขึ้นต้นด้วย 😊)
 * ขึ้นต้นบรรทัด = ย้ายไปท้ายบรรทัดข้อความก่อนหน้า (ข้ามไม่ได้ถ้าก่อนหน้าเป็นช่องเติม/รูป → ไปท้ายบรรทัดตัวเอง)
 * ขึ้นต้นประโยคกลางบรรทัด = ติดท้ายประโยคก่อนหน้า แล้วขึ้นบรรทัดใหม่ให้ประโยคถัดไป
 */
function relocateEmoji(lines, stage, fixes) {
  const out = lines.map((line) => line.replace(EMOJI_AFTER_SLOT, (whole, token) => { fixes.push("emoji_after_slot"); return token; }));
  for (let i = 0; i < out.length; i += 1) {
    if (stage === "DELIVER" || out[i] === null || SLOT_LINE.test(out[i])) continue;
    const lead = LEADING_EMOJI.exec(out[i]);
    if (!lead) continue;
    const emoji = lead[1].replace(/\s+/gu, "");
    const rest = out[i].slice(lead[0].length).trim();
    let j = i - 1;
    while (j >= 0 && (out[j] === null || !out[j].trim())) j -= 1;
    if (j >= 0 && !SLOT_LINE.test(out[j])) {
      out[j] = `${out[j].trimEnd()} ${emoji}`;
      out[i] = rest || null;
    } else out[i] = rest ? `${rest} ${emoji}` : null;
    fixes.push("emoji_moved");
  }
  return out.filter((line) => line !== null).map((line) => line.replace(MIDLINE_EMOJI, (whole, end, emoji) => {
    fixes.push("emoji_moved");
    return `${end} ${emoji}\n`;
  }));
}

function fixEmoji(text, stage, fixes) {
  let smileKept = false;
  let headers = 0;
  const out = String(text).split("\n").map((line) => {
    const leading = stage === "DELIVER" && headers < 3 ? /^\s*(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/u.exec(line) : null;
    if (leading) headers += 1;
    const head = leading ? leading[0] : "";
    const rest = line.slice(head.length).replace(EMOJI, (emoji) => {
      if (emoji === SMILE && !smileKept) { smileKept = true; return emoji; }
      fixes.push("emoji");
      return "";
    });
    return `${head}${rest}`;
  });
  // 😊 ขึ้นต้นย่อหน้า (dev 4 ต.ค. "😊 ทั้ง SEL…") — ย้ายไปท้ายบรรทัดก่อนหน้าที่มีข้อความ
  return relocateEmoji(out, stage, fixes).join("\n");
}

// เคสจริง 5 ต.ค.: ลูกแพรปิดทุกเทิร์นด้วย "อยากให้ลูกแพรส่งรอบเรียนที่เปิดอยู่ให้ดูไหมคะ?" ทั้งที่ลูกค้าไม่ตอบ
// และชวนดูรอบหลังลูกค้าบอกว่าต้องยืมเงินมาเรียน — โมเดลยังทำอีก = ตัดประโยคนั้นทิ้ง แล้วปิดด้วยประโยคที่ไม่ถามแทน
export const REPEAT_REPLACEMENT = "ถ้าอยากรู้เพิ่มเติม บอกลูกแพรได้เลยค่ะ";
export const HARDSHIP_REPLACEMENT = "ไม่ต้องรีบตัดสินใจนะคะ ค่อย ๆ ดูให้พร้อมก่อน ถ้าอยากคุยเพิ่มเติม บอกลูกแพรได้เลยค่ะ";
// ตรวจซ้ำเคสจริง 5 ต.ค. ผ่านไปป์ไลน์จริง: สองเทิร์นติดกันที่ตัดข้อเสนอซ้ำ จบด้วยประโยคแทนที่ประโยคเดียวกันทั้งสองเทิร์น
// (ปัญหาเดิมในรูปใหม่) — ประโยคแทนที่อยู่ในข้อความล่าสุดของลูกแพรแล้ว = ใช้ประโยคสำรอง · ไม่มีเหลือ = ไม่ต่อ
// รีวิวเคสจริง 5 ต.ค.: ประโยคสำรองเดิม "ถ้ามีข้อสงสัยเพิ่ม ทักลูกแพรมาได้เสมอนะคะ" เป็นคำลา — ติด S3 (เสียยกซ่อมเพื่อตัดประโยคที่ระบบ
// เติมเอง) และลูกค้าตอบ "ครับ" แล้วห้องถูกปิดเป็น GOODBYE — ประโยคแทนที่ทุกประโยคต้องไม่ใช่คำลาและไม่ติด EXIT_PHRASE (มีเทสต์ล็อก)
export const REPLACEMENTS = Object.freeze({
  repeat: Object.freeze([REPEAT_REPLACEMENT, "ส่วนไหนยังไม่ชัด บอกลูกแพรได้เลยค่ะ"]),
  hardship: Object.freeze([HARDSHIP_REPLACEMENT, "ค่อย ๆ ดูให้พร้อมก่อนนะคะ ลูกแพรยินดีคุยต่อเมื่อสะดวกเสมอค่ะ"]),
});
// จังหวะร้อน (BRIDGE/ราคา/ดีลคู่/ถามรอบ) ที่ตัดตัวปิดซ้ำแล้ว = ปิดด้วยก้าวถัดไปที่ยังไม่ถูกห้ามแทนประโยคไม่ถาม
// (รีวิวเคสจริง 5 ต.ค.: ประโยคไม่ถามในจังหวะร้อนติด S3 ทุกครั้ง = เรียกโมเดลรอบสอง และลูกค้าที่พร้อมซื้อไม่ได้ก้าวต่อไป)
// พี่ง้วง 12 ต.ค. (human touch): ประโยคชวนดูหัวข้อแบบตายตัว "อยากดูหัวข้อที่สอนในคลาสนี้แบบเต็ม ๆ ไหมคะ?" ถูกลอกซ้ำทั้งวัน (ราว 45 ครั้งใน 27 ห้อง)
// → ผูกกับคลาสที่คุยอยู่ (outlineStepLine) และไม่เติมเลยเมื่อข้อความล่าสุดของลูกแพรเพิ่งชวนดูหัวข้อไปแล้ว · NEXT_STEP_LINES.outline คือรูปที่ยังไม่รู้คลาส
// soul v1.1 C6 (20 ต.ค. 2026): รูปถ่อมตัวของ soul ตรงตัว "ไม่ทราบว่าคุณ(ชื่อ) สนใจให้ลูกแพรส่ง…ไหมคะ ลูกแพรส่งให้ค่ะ"
// (เดิม "อยากให้ลูกแพรส่ง…ไหมคะ?" แล้วรอตัวแปลงถ่อมตัวทำให้ — ได้รูปครึ่งทาง ไม่มีชื่อและท่อนท้าย)
export function outlineStepLine(ctx = {}) {
  const name = String(ctx.className || "").trim();
  return `ไม่ทราบว่า${politeNameOf(ctx)}สนใจให้ลูกแพรส่งหัวข้อที่จะได้ลงมือทำในคลาส${name ? ` ${name} ` : ""}ให้ดูก่อนไหมคะ ลูกแพรส่งให้ค่ะ`;
}
const outlineOfferedRecently = (ctx = {}) => offerTypes(closingOf(ctx.recentBotText || "")).includes("outline");
export const NEXT_STEP_LINES = Object.freeze({
  booking: "ไม่ทราบว่าสนใจให้ลูกแพรส่งรายละเอียดการสมัครไหมคะ ลูกแพรส่งให้ค่ะ",
  outline: outlineStepLine(),
  open: "ตอนนี้อยากเริ่มใช้ AI กับงานไหนก่อนคะ?",
  // รีวิวเคสจริงทั้งวัน 5 ต.ค.: หลังแจ้งราคาแล้วประโยคสำรองสุดท้ายเคยเป็นคำถามเรื่องงาน (ถอยกลับไปทำความรู้จัก)
  // พี่ง้วง 13 ต.ค.: เดิม "ตอนนี้ยังติดเรื่องวันเรียน ค่าเรียน หรือ…" = ลูกค้ารู้สึกว่าถูกถามว่าไม่สะดวกค่าเรียน — พาไปข้างหน้าแทน
  afterPrice: "ไม่ทราบว่ามีส่วนไหนที่อยากให้ลูกแพรเล่าเพิ่มไหมคะ?",
});
// เทิร์นนี้แจ้งราคาอยู่ หรือแจ้งไปแล้วในห้องนี้
const pricedTurn = (ctx = {}) => Boolean(ctx.priceQuoted) || PRICE_STAGES.has(ctx.stage);
// พี่ง้วง 13 ต.ค.: "ไม่ทราบว่าคุณ… สะดวก… ดีนะคะ?"
export const chooseRoundLine = (labels = [], address = null) =>
  `ไม่ทราบว่า${address && !address.generic && address.label ? `${address.label} ` : ""}สะดวกรอบ ${labels[0]} หรือ ${labels[1]} ดีนะคะ?`;
const usedRecently = (line, ctx = {}) => {
  const recent = normalizeClosing(ctx.recentBotText || "");
  return Boolean(recent) && recent.includes(normalizeClosing(line));
};
function replacementFor(kind, ctx = {}) {
  return REPLACEMENTS[kind].find((line) => !usedRecently(line, ctx)) || "";
}
// ลำดับ: ก้าวสมัคร (เลือกรอบแล้ว) หรือชวนเลือกรอบ → ดูหัวข้อ → คำถามเปิดเรื่องงาน · ข้ามชนิดที่ห้ามและประโยคที่เพิ่งใช้
// ถามราคา/ส่วนลด = สนใจแต่ยังไม่ได้บอกว่าจะสมัคร — ก้าวถัดไปเดิม (ชวนเลือกรอบ/ดูหัวข้อ) ไม่ข้ามไปขอส่งรายละเอียดการสมัคร
const PRICE_ASK_REASONS = new Set(["money_ask", "price_owed", "discount_ask", "group_price_ask"]);
function nextStepFor(ctx = {}) {
  const decision = ctx.decision || {};
  const banned = avoidTypesOf(decision);
  const labels = ctx.roundLabels || [];
  const options = [];
  if (decision.logistics === "booking" || decision.roundPick) options.push(NEXT_STEP_LINES.booking);
  // ยังไม่รู้คลาส (รอบที่ด่านเห็นคือรอบของทุกคลาสรวมกัน) = ไม่ชวนเลือกสองรอบแรกแบบเดาคลาส
  else if (!banned.has("rounds") && labels.length >= 2 && ctx.classKnown !== false) options.push(chooseRoundLine(labels, ctx.address));
  // รีวิวเคสจริงทั้งวัน 5 ต.ค. (ตรวจสดรอบสุดท้าย): คนพร้อมซื้อที่ประโยคชวนเลือกรอบเดิมเพิ่งถามไป = ก้าวสมัคร ไม่ตกไปดูหัวข้อหรือคำถามเปิด
  if (decision.buying && !PRICE_ASK_REASONS.has(decision.reason)) options.push(NEXT_STEP_LINES.booking);
  if (!banned.has("outline") && !ctx.outlineSent && !outlineOfferedRecently(ctx)) options.push(outlineStepLine(ctx));
  options.push(pricedTurn(ctx) ? NEXT_STEP_LINES.afterPrice : NEXT_STEP_LINES.open);
  return options.find((line) => !repeatsClosing(line, decision.avoid || []) && !usedRecently(line, ctx)) || "";
}
const hasLetters = (sentence) => /\p{L}/u.test(sentence);
const isSlotParagraph = (paragraph) => paragraph.split("\n").every((line) => SLOT_LINE.test(line) || !line.trim());
const endsWithQuestion = (text) => isClosingQuestion(sentencesOf(paragraphsOf(text).at(-1)?.split("\n").at(-1) || "").at(-1) || "");

// เงินตึงแต่ลูกค้าบอกเองว่าจะสมัคร/ถามรอบ ("ยืมเงินแม่มาแล้ว สมัครรอบ 24 ยังไง") = ข้อเสนอรอบ/จองเรื่องที่เขาถามไม่ถูกตัด
function hardshipAllowed(decision, ctx) {
  const allowed = new Set(closingTypes(ctx.userText || "").filter((type) => type === "rounds" || type === "booking"));
  if (decision.enroll) { allowed.add("rounds"); allowed.add("booking"); }
  return allowed;
}

/**
 * เงินตึง: ตัดคำชวนซื้อเฉพาะท้ายบรรทัด (เดินจากท้ายบรรทัดย้อนขึ้นมา หยุดที่ประโยคแรกที่ไม่ใช่คำชวนซื้อ)
 * รีวิวเคสจริง 5 ต.ค.: ประโยคกลางบรรทัดห้ามตัด (ตัด "ค่าเรียนผ่อนได้นะคะ" แล้วเหลือเศษ "สูงสุด 10 เดือน…") · คำเร่งที่เป็นประโยคบอกเล่า
 * ("โปรโมชั่นเหลือถึงสิ้นเดือน" / "ที่นั่งใกล้เต็ม") ต้องโดนตัดด้วย · ประโยคข้อเสนอ (ชวนเลือกรอบ/จอง) ตัดเฉพาะย่อหน้าปิดท้าย
 */
function markHardshipTail(sentences, why, sales, closingParagraph) {
  for (let si = sentences.length - 1; si >= 0; si -= 1) {
    const sentence = sentences[si];
    if (!hasLetters(sentence)) continue;
    if (hardshipSalesOffer(sentence, sales) && (closingParagraph || !isOfferForm(sentence))) { why[si] = "drop_sales_offer"; continue; }
    if (!why[si]) return;
  }
}

function dropRepeatedClosings(text, ctx, fixes) {
  const decision = ctx.decision || {};
  const avoid = decision.avoid || [];
  const hardship = (decision.modifiers || []).includes("money_hardship");
  if (!avoid.length && !hardship) return text;
  const sales = { allowed: hardshipAllowed(decision, ctx), paymentAsk: decision.paymentAsk === true };
  const paragraphs = paragraphsOf(text);
  const closingIndex = paragraphs.findLastIndex((paragraph) => !isSlotParagraph(paragraph));
  let droppedLast = false;
  let droppedAny = false;
  const out = paragraphs.map((paragraph, pi) => {
    // งานส่งของ (ร่าง/สรุปที่ลูกค้าขอ) = ตรวจเฉพาะย่อหน้าปิดท้ายของลูกแพร ไม่แตะเนื้องานของลูกค้า
    if (ctx.stage === "DELIVER" && pi < paragraphs.length - 1) return paragraph;
    const lines = paragraph.split("\n");
    return lines.map((line, li) => {
      if (SLOT_LINE.test(line)) return line;
      const sentences = offerSentencesOf(line);
      const lastLettered = sentences.findLastIndex(hasLetters);
      // ตัวปิดซ้ำ = ประโยคถาม/ข้อเสนอที่ซ้ำตัวปิดที่ลูกค้ายังไม่ตอบ (ตำแหน่งไหนก็ได้)
      const why = sentences.map((sentence) => (askLike(sentence) && repeatsClosing(sentence, avoid) ? "drop_repeat_closing" : ""));
      if (hardship) markHardshipTail(sentences, why, sales, pi === closingIndex);
      if (!why.some(Boolean)) return line;
      const kept = sentences.filter((sentence, si) => {
        if (!why[si]) return true;
        fixes.push(why[si]);
        droppedAny = true;
        if (pi === paragraphs.length - 1 && li === lines.length - 1 && si === lastLettered) droppedLast = true;
        return false;
      });
      // เศษที่เหลือแต่อีโมจิหลังตัดประโยค = ทิ้ง (ห้ามเหลือบอลลูนที่มีแต่อีโมจิ)
      return kept.some(hasLetters) ? kept.join(" ") : "";
    }).filter((line) => line.trim()).join("\n");
  }).filter(Boolean);
  if (!droppedAny) return text;
  const kept = out.join("\n\n");
  // ยังจบด้วยคำถามอยู่แล้ว = ไม่ต่อ
  if (!droppedLast || endsWithQuestion(kept)) return kept;
  // จังหวะร้อน (รวมเงินตึงที่ลูกค้าบอกเองว่าจะสมัคร) = ต้องมีก้าวถัดไป · ไม่ร้อนและมีประโยคใส่ใจอยู่แล้ว = ไม่ต่อประโยคใส่ใจซ้ำ
  const hot = ctx.policy === "hot";
  if (!hot && hardship && CARE_LINE.test(kept)) return kept;
  const replacement = (hot && nextStepFor(ctx)) || replacementFor(hardship ? "hardship" : "repeat", ctx);
  if (!replacement) return kept;
  const lastKept = out.length === paragraphs.length && out.length ? out.at(-1) : "";
  // คำถามปิดท้ายต้องเป็นคำถามเดียวของย่อหน้าสุดท้าย (S1 นับเครื่องหมายคำถามในย่อหน้าสุดท้าย)
  const ownParagraph = /[?？]/u.test(replacement) && /[?？]/u.test(lastKept);
  if (lastKept && !ownParagraph && !SLOT_LINE.test(lastKept.split("\n").at(-1))) out[out.length - 1] = `${lastKept} ${replacement}`;
  else out.push(replacement);
  return out.join("\n\n");
}

// รีวิวเคสจริงทั้งวัน 5 ต.ค. (ห้อง LINE ช่วงค่ำ): เทิร์นที่ลูกค้าพิมพ์แทรกระหว่างส่ง ย่อหน้าแรกทวนบับเบิลที่เขาเพิ่งเห็นเกือบทั้งประโยค
// — ใช้เฉพาะเทิร์นซ้อน (คู่ปกติที่ทวนสูงคือการ์ดราคา/สรุปที่ตั้งใจ) · ย่อหน้าช่องเติมไม่แตะ
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): เดิมตัดทั้งย่อหน้าเมื่อบับเบิลเดิมอยู่ในย่อหน้านั้น แม้ย่อหน้ามีคำตอบใหม่ต่อท้าย
// ("…รวม Workshop แล้วค่ะ แต่ไม่รวมค่าอาหารกลางวันนะคะ" หายทั้งก้อน) — ตัดเฉพาะประโยคที่ทวนบับเบิลเดิม (คล้าย ≥0.8 หรือเป็นท่อนหนึ่งของบับเบิลเดิม)
// ประโยคใหม่เก็บไว้ · เหลือแต่คำรับสั้น ๆ ("เข้าใจแล้วค่ะ") = ตัดด้วย (คือการรับรู้เรื่องเดิมซ้ำ) · ตัดแล้วไม่เหลืออะไร = ไม่แตะ
const OVERLAP_ECHO = 0.8;
const ECHO_CONTAINED_MIN = 12;
const SHORT_ACK_CHARS = 14;
function echoesBubble(sentence, bubbles) {
  const mine = normalizeClosing(sentence);
  if (!mine) return false;
  return bubbles.some((bubble) => {
    const seen = normalizeClosing(bubble);
    if ([...mine].length >= ECHO_CONTAINED_MIN && seen.includes(mine)) return true;
    return [bubble, ...sentencesOf(bubble)].some((part) => closingSimilarity(sentence, part, { containment: false }) >= OVERLAP_ECHO);
  });
}
// feedback ทีม 10 ต.ค.: ห้องเดียวได้ประโยคชวนเตรียม Laptop/งานมาใช้ใน Workshop ซ้ำ 4–5 ครั้ง — ห้องที่บอกไปแล้ว ตัดประโยคแบบนี้ทิ้ง
// (ตัดแล้วไม่เหลืออะไร = คงไว้ ให้ด่านอื่นตัดสิน) · ช่องเติมไม่แตะ
// รีวิวปรปักษ์ 10 ต.ค.: ลูกค้าถามเองว่าต้องเตรียม/เอาอะไรมา = คำตอบ ไม่ใช่คำซ้ำ · ประโยคที่มีเวลา/วันที่/สถานที่ปนอยู่ไม่ตัด
const PREP_KEEP_RE = /\d|EZ\s?Space|เทพารักษ์|บางนา|ที่จอด|chat\s*-?gpt|plus|แยกจาก|ค่าเรียน|ค่าใช้จ่าย|ไม่มี|ยืม/iu;
function dropRepeatedPrep(text, ctx, fixes) {
  if (!ctx.prepSaid || !WORKSHOP_PREP_RE.test(text) || PREP_ASK_RE.test(String(ctx.userText || ""))) return text;
  let dropped = false;
  const paragraphs = paragraphsOf(text).map((paragraph) => {
    if (isSlotParagraph(paragraph)) return paragraph;
    return paragraph.split("\n").map((line) => {
      if (SLOT_LINE.test(line)) return line;
      const sentences = sentencesOf(line);
      const kept = sentences.filter((sentence) => !(hasLetters(sentence) && WORKSHOP_PREP_RE.test(sentence) && !askLike(sentence)
        && !PREP_KEEP_RE.test(sentence)));
      if (kept.length !== sentences.length) dropped = true;
      return kept.join(" ");
    }).filter((line) => line.trim()).join("\n");
  }).filter((paragraph) => paragraph.trim());
  if (!dropped || !paragraphs.some((paragraph) => hasLetters(paragraph.replace(TOKEN_OR_IMAGE, " ")))) return text;
  fixes.push("repeat_prep");
  return paragraphs.join("\n\n");
}
function dropOverlapEcho(text, ctx, fixes) {
  const seen = ctx.overlapDelivered || [];
  if (!seen.length) return text;
  const paragraphs = paragraphsOf(text);
  if (!paragraphs.length || isSlotParagraph(paragraphs[0])) return text;
  let dropped = false;
  const lines = paragraphs[0].split("\n").map((line) => {
    if (SLOT_LINE.test(line)) return line;
    const sentences = sentencesOf(line);
    const kept = sentences.filter((sentence) => !(hasLetters(sentence) && echoesBubble(sentence, seen)));
    if (kept.length !== sentences.length) dropped = true;
    return kept.join(" ");
  }).filter((line) => line.trim());
  if (!dropped) return text;
  const leftover = lines.flatMap((line) => sentencesOf(line)).filter(hasLetters);
  const onlyAck = leftover.every((sentence) => modelLength(sentence) <= SHORT_ACK_CHARS);
  const rest = onlyAck ? paragraphs.slice(1) : [lines.join("\n"), ...paragraphs.slice(1)];
  if (!rest.some((paragraph) => hasLetters(paragraph.replace(TOKEN_OR_IMAGE, " ")))) return text;
  fixes.push("overlap_echo");
  return rest.join("\n\n");
}

// "…ไหนก่อนคะ เช่น A หรือ Bคะ?" → "…ไหนก่อนคะ เช่น A หรือ B?" (dev 4 ต.ค.: 6.1 เติม คะ ซ้ำท้ายตัวเลือก)
function fixOptionsParticle(text, fixes) {
  const lines = String(text).split("\n");
  const i = lines.findLastIndex((line) => line.trim());
  if (i < 0) return text;
  const fixed = lines[i].replace(/((?:คะ|ค่ะ)\s+เช่น\s[^?？]*?\S)(?:คะ|ค่ะ)\s*([?？])\s*$/u, "$1$2");
  if (fixed === lines[i]) return text;
  lines[i] = fixed;
  fixes.push("options_particle");
  return lines.join("\n");
}

// 7 พ.ย. 2026 (พี่ง้วง "แก้และเทสเลย"): จังหวะร้อนที่ร่างห้อยประโยคลาไว้ท้ายข้อความ ("ถ้ามีคำถามเพิ่มเติม ทักลูกแพรได้เลยนะคะ")
// เคยติด S3 แล้วเรียกโมเดลรอบสองทุกครั้ง (ต้นเหตุหลักที่ Sonnet ซ่อมบ่อย) — ตัดหางนั้นด้วยโค้ดแทน
// · ตัดเฉพาะประโยคลาที่อยู่ท้ายสุด (รวมอีโมจิที่ห้อยตาม) ไล่ขึ้นทีละประโยค/บรรทัด/ย่อหน้า จนเจอประโยคที่ไม่ใช่คำลา
// · ตัดแล้วไม่ได้จบด้วยคำถาม = ต่อก้าวถัดไปแบบเดียวกับตัวปิดซ้ำ · ไม่มีก้าวถัดไปให้ใช้ หรือเหลือแต่เศษ = คงร่างเดิม (S3 ส่งซ่อมตามเดิม)
// · ประโยคลากลางข้อความไม่แตะ — ยังติด S3 และซ่อมด้วยโมเดลเหมือนเดิม
function dropExitTail(text, ctx, fixes) {
  if (ctx.policy !== "hot") return text;
  const paragraphs = paragraphsOf(text);
  let dropped = false;
  while (paragraphs.length) {
    const lines = paragraphs.at(-1).split("\n");
    if (SLOT_LINE.test(lines.at(-1))) break;
    const sentences = sentencesOf(lines.at(-1));
    let cut = sentences.length;
    while (cut > 0 && (!hasLetters(sentences[cut - 1]) || EXIT_PHRASE.test(sentences[cut - 1]))) cut -= 1;
    if (!sentences.slice(cut).some((sentence) => EXIT_PHRASE.test(sentence))) break;
    dropped = true;
    if (cut > 0) {
      lines[lines.length - 1] = sentences.slice(0, cut).join(" ");
      paragraphs[paragraphs.length - 1] = lines.join("\n");
      break;
    }
    lines.pop();
    if (lines.some((line) => line.trim())) paragraphs[paragraphs.length - 1] = lines.join("\n");
    else paragraphs.pop();
  }
  if (!dropped || !paragraphs.some(hasLetters)) return text;
  // ตัวเดียวกับด่าน S3 ("…ไหมคะ ลูกแพรส่งให้ค่ะ" นับว่าจบด้วยคำถาม)
  if (!isClosingQuestion(finalQuestionLine(paragraphs.join("\n\n")).sentence)) {
    const step = nextStepFor(ctx);
    if (!step) return text;
    const last = paragraphs.at(-1);
    const ownParagraph = /[?？]/u.test(step) && /[?？]/u.test(last);
    if (!ownParagraph && !SLOT_LINE.test(last.split("\n").at(-1))) paragraphs[paragraphs.length - 1] = `${last} ${step}`;
    else paragraphs.push(step);
    fixes.push("exit_tail_next_step");
  }
  fixes.push("drop_exit_tail");
  return paragraphs.join("\n\n");
}

function dropTrailingQuestions(text, fixes) {
  const paragraphs = paragraphsOf(text);
  while (paragraphs.length) {
    const sentences = sentencesOf(paragraphs.at(-1).split("\n").at(-1));
    if (!sentences.length || !isClosingQuestion(sentences.at(-1))) break;
    const lines = paragraphs.at(-1).split("\n");
    const kept = sentences.slice(0, -1).join(" ");
    lines[lines.length - 1] = kept;
    const next = lines.filter((line) => line.trim()).join("\n");
    fixes.push("drop_question");
    if (next) { paragraphs[paragraphs.length - 1] = next; } else paragraphs.pop();
  }
  return paragraphs.join("\n\n");
}

// ---- ปิดอย่างสุภาพ (รีวิวเคสจริงทั้งวัน 5 ต.ค.): ไม่มีประโยคขาย (ข้อเสนอ/ชื่อคลาส/Workshop/ราคา/รอบ) เหลือแต่คำรับ + ประตูเปิด ----
const EXIT_SALES = new RegExp(`${Object.values(CLASS_NAMES).join("|")}|Workshop|ทีม TA|LINE Support|โปรโมชั่น|โปรโมชัน|early ?bird|ราคา|ค่าเรียน|ผ่อน|รีวิว|หัวข้อ|รอบเรียน|สมัคร|จอง`, "iu");
const EXIT_MIN_CHARS = 12;
// ร่างที่เหลือไม่ถึงหนึ่งประโยคหลังตัดคำขาย = ใช้ประโยคสำรองตามเหตุ (ไม่มีคำถาม ไม่มีชื่อคลาส ผ่านด่านคำแบน — มีเทสต์ล็อก)
export const EXIT_FALLBACK = Object.freeze({
  wrong_click: "ไม่เป็นไรเลยค่ะ วันไหนอยากรู้เรื่องคลาส AI ทักลูกแพรมาได้เลยนะคะ 😊",
  not_for_class: "ไม่เป็นไรเลยค่ะ วันไหนอยากรู้เรื่องคลาส AI ทักลูกแพรมาได้เลยนะคะ 😊",
  not_interested: "ขอบคุณที่บอกลูกแพรตรง ๆ นะคะ วันไหนอยากรู้เรื่องคลาส AI ทักมาได้เลยค่ะ 😊",
  price_decline: "เข้าใจเลยค่ะ ขอบคุณที่บอกลูกแพรตรง ๆ นะคะ วันไหนพร้อม ทักมาได้เลยค่ะ 😊",
  hardship_decline: "เข้าใจเลยค่ะ ไม่ต้องฝืนเรื่องงบนะคะ วันไหนพร้อม ทักลูกแพรมาได้เลยค่ะ 😊",
  who_are_you: "ลูกแพรเป็นผู้ช่วย AI ของพี่ง้วง ดูแลตอบแชทเรื่องคลาสเรียน AI ของเพจนี้ค่ะ ถ้าไม่ได้ตั้งใจทักมาก็ไม่เป็นไรเลยนะคะ",
});
const exitFallback = (ctx) => EXIT_FALLBACK[ctx.decision?.exit] || EXIT_FALLBACK.not_interested;
function dropExitSales(text, fixes) {
  return paragraphsOf(text).map((paragraph) => paragraph.split("\n").map((line) => {
    if (SLOT_LINE.test(line)) { fixes.push("exit_slot"); return ""; }
    const kept = offerSentencesOf(line).filter((sentence) => {
      const sales = isOfferForm(sentence) || EXIT_SALES.test(sentence);
      if (sales) fixes.push("exit_sales");
      return !sales;
    });
    return kept.some(hasLetters) ? kept.join(" ") : "";
  }).filter((line) => line.trim()).join("\n")).filter(Boolean).join("\n\n");
}

// ---- ประโยคกั้นราคา (พี่ง้วง 13 ต.ค. ทาง A) ----
// v3.5 (6 ต.ค.) ให้ระบบเติม "ขอถามสั้น ๆ ข้อเดียวนะคะ ตอบแล้วลูกแพรแจ้งค่าเรียนให้ทันทีเลยค่ะ" ทุกครั้งที่ขอพื้นฐานก่อนราคา — ลูกค้าอ่านเป็นการตั้งเงื่อนไข
// (13 ต.ค. ห้องที่พิมพ์ "ราคา" คำเดียวได้ประโยคนี้เป็นบับเบิลเดี่ยว) · ตอนนี้กลับด้าน: ร่างที่ยังไม่มีราคา ถ้ามีประโยคแบบนี้ (โมเดลเลียนจากประวัติแชท) = ตัดออก
// ข้อความที่มีช่องราคา/ดีลแล้วไม่แตะ ("ลูกแพรแจ้งค่าเรียนให้เลยนะคะ" ตามด้วยตัวเลขจริงไม่ใช่การกั้น)
export const PRICE_GATE = new RegExp([
  "ขอ(?:ถาม|ทราบ)\\S{0,12}?(?:\\s?ๆ\\s?)?(?:ข้อ|คำถาม)?เดียว",
  "ตอบ(?:ข้อนี้|คำถามนี้)?\\s?(?:แล้ว|เสร็จ)\\s?(?:ลูกแพร)?\\s?(?:จะ)?\\s?(?:แจ้ง|บอก|ส่ง)\\s?(?:ค่าเรียน|ราคา)",
  "(?:แจ้ง|บอก|ส่ง)\\s?(?:ค่าเรียน|ราคา)\\S{0,16}?ให้\\s?(?:ทันที|เลย)",
].join("|"), "u");
// ส่วนนำของคำถาม ("ขอถามสั้น ๆ ข้อเดียวว่า…?") — ตัดแค่ส่วนนำ เก็บคำถามไว้
const PRICE_GATE_LEAD = /^ขอ(?:ถาม|ทราบ)[^?？]*?(?:ข้อ|คำถาม)?เดียว(?:ก่อน)?(?:นะ)?(?:คะ|ค่ะ)?\s?(?:ว่า)?\s?/u;
const PRICED_SLOT = /\{\{(?:ราคา|ดีล)\}\}/u;
// ประโยคที่เล่าคุณค่าแล้วต่อท้ายด้วยคำกั้นในประโยคเดียวกัน ("…พี่ง้วงดูแลเอง ตอบแล้วลูกแพรแจ้งค่าเรียนให้ทันทีเลยค่ะ") = เก็บส่วนหน้าไว้
const GATE_JOINER_TAIL = /(?:แล้ว|จึง|เลย|และ|ซึ่ง)$/u;
function withoutGate(sentence) {
  if (/[?？]\s*$/u.test(sentence)) {
    const question = sentence.replace(PRICE_GATE_LEAD, "").trim();
    return question && !PRICE_GATE.test(question) && hasLetters(question) ? question : "";
  }
  const at = sentence.search(PRICE_GATE);
  const head = at > 0 && /\s/u.test(sentence[at - 1]) ? sentence.slice(0, at).trimEnd().replace(GATE_JOINER_TAIL, "").trimEnd() : "";
  if (!head || !hasLetters(head)) return "";
  return /(?:ค่ะ|คะ|[!.])$/u.test(head) ? head : `${head}ค่ะ`;
}
function dropPriceGate(text, fixes) {
  if (PRICED_SLOT.test(text) || !PRICE_GATE.test(text)) return text;
  const out = paragraphsOf(text).map((paragraph) => paragraph.split("\n").map((line) => sentencesOf(line)
    .map((sentence) => (PRICE_GATE.test(sentence) ? withoutGate(sentence) : sentence)).filter(Boolean).join(" "))
    .filter((line) => line.trim()).join("\n")).filter((paragraph) => paragraph.trim()).join("\n\n");
  if (!hasLetters(out.replace(TOKEN_OR_IMAGE, " "))) return text;
  fixes.push("price_gate");
  return out;
}

// ---- พี่ง้วง 13 ต.ค. (แชทจริง 21:18): ถามชวนหาข้อติดใจที่มีค่าเรียนเป็นตัวเลือก ----
// "มีเรื่องไหนอยากให้อธิบายเพิ่มก่อนตัดสินใจคะ / ระหว่างวันเรียน ค่าเรียน หรือเนื้อหาในคลาส?" · "ยังติดเรื่องค่าเรียนไหมคะ?"
// = ลูกค้ารู้สึกว่าถูกถามว่าไม่สะดวกค่าเรียน — ตัดคำถามนั้น (ลูกค้าพูดเรื่องเงินเองในข้อความนี้ = ไม่แตะ)
const PROBE_MONEY_WORD = /ค่าเรียน|ค่าคอร์ส|ราคา|งบ|ค่าใช้จ่าย/u;
const DOUBT_PROBE = /ติด(?:เรื่อง|ตรง|ใจ)|ลังเล|กังวล|ไม่สะดวก|ระหว่าง|หรือ|ก่อนตัดสินใจ|ส่วนไหน|เรื่องไหน/u;
function dropPriceDoubtProbe(text, ctx = {}, fixes = []) {
  if (PROBE_MONEY_WORD.test(String(ctx.userText || "")) || !PROBE_MONEY_WORD.test(text)) return text;
  let dropped = false;
  const out = paragraphsOf(text).map((paragraph) => paragraph.split("\n").map((line) => sentencesOf(line).filter((sentence) => {
    const probe = /[?？]\s*$|คะ\s*$/u.test(sentence) && PROBE_MONEY_WORD.test(sentence) && DOUBT_PROBE.test(sentence) && !/\{\{/u.test(sentence);
    if (probe) dropped = true;
    return !probe;
  }).join(" ")).filter((line) => line.trim()).join("\n")).filter((paragraph) => paragraph.trim()).join("\n\n");
  if (!dropped || !hasLetters(out.replace(TOKEN_OR_IMAGE, " "))) return text;
  fixes.push("price_doubt_probe");
  return out;
}

// ---- พี่ง้วง 13 ต.ค.: คำถามชวน/ข้อเสนอต้องถ่อมตัว ไม่ห้วน ----
// "อยากให้ลูกแพรส่ง…ไหมคะ?" → "ไม่ทราบว่าคุณ… สนใจให้ลูกแพรส่ง…ไหมคะ?" · "อยากดู…ไหมคะ?" → "ไม่ทราบว่าคุณ… สนใจดู…ไหมคะ?"
// · "สะดวกรอบ … ดีคะ?" → "ไม่ทราบว่าคุณ… สะดวกรอบ … ดีนะคะ?" · "ไม่ทราบว่า…" ที่ยังไม่มีชื่อ = เติมชื่อที่ใช้เรียก
// ทำก่อนขยายช่องเติม (บันได/ราคา/รีวิวเป็นข้อความที่ตรวจแล้ว ไม่แตะ)
const POLITE_LEAD = /^(?:แล้ว|ตอนนี้|ถ้างั้น|งั้น|ถ้าอย่างนั้น)\s*/u;
const ASK_TAIL = /(?:คะ[?？]?|[?？])$/u;
const POLITE_MAX = 240;
function politeNameOf(ctx = {}) {
  const address = ctx.address;
  return address && !address.generic && address.label ? `${address.label} ` : "";
}
// "แบบเต็ม ๆ" + "ไหมคะ" ต้องเว้นวรรคหลังไม้ยมก · คำอื่นติดกันตามเดิม
const joinAsk = (body) => { const b = String(body).replace(/\s+$/u, ""); return /ๆ$/u.test(b) ? `${b} ` : b; };
// พี่ง้วง 29 ต.ค. (ห้องคุณบอย): แปลงเฉพาะคำถามจริง — "สะดวกเมื่อไหร่ค่อยเข้าไปดูได้เลยนะคะ" / "อยากให้ลองดูนะคะ" เป็นคำบอกเล่า
const QUESTION_WORD = /ไหน|อะไร|ไหม|มั้ย|เท่าไ(?:ห)?ร่|กี่|ยังไง|อย่างไร|เมื่อไ(?:ห)?ร่|หรือ/u;
const isQuestion = (s) => /[?？]$/u.test(s)
  || /(?:ไหม|มั้ย|ดี|ไหน|อะไร|เท่าไ(?:ห)?ร่|หรือเปล่า|รึเปล่า|หรือยัง|ยังไง|อย่างไร)(?:นะ)?คะ$/u.test(s)
  || (/(?<!นะ)คะ$/u.test(s) && QUESTION_WORD.test(s));
function politeAsk(sentence, name, opts = {}) {
  const s = sentence.trim();
  if ([...s].length > POLITE_MAX || !ASK_TAIL.test(s) || !isQuestion(s) || /\{\{|\[IMAGE:/u.test(s)) return sentence;
  const core = s.replace(POLITE_LEAD, "");
  let m = /^อยากให้ลูกแพร(.+?)(?:เลย)?(?:ไหม|มั้ย)/u.exec(core);
  if (m && ASK_TAIL.test(core)) return `ไม่ทราบว่า${name}สนใจให้ลูกแพร${joinAsk(m[1])}ไหมคะ?`;
  m = /^อยาก(ดู|เห็น|ได้)(.+?)(?:ไหม|มั้ย)/u.exec(core);
  if (m && ASK_TAIL.test(core)) return `ไม่ทราบว่า${name}สนใจ${m[1]}${joinAsk(m[2])}ไหมคะ?`;
  m = /^สะดวก(.+?)(ไหม|มั้ย|ดี)?(?:นะ)?คะ[?？]?$/u.exec(core);
  if (m) {
    const what = m[1].trim();
    // "ดีนะคะ" เฉพาะคำถามให้เลือก ("รอบไหน" / "… หรือ …") — "สะดวกรอบไหนมากที่สุดคะ?" "สะดวกเรียนช่วงเดือนไหนเป็นพิเศษคะ?" คงหางเดิม
    const choice = m[2] === "ดี" || /ไหน$|หรือ/u.test(what);
    const tail = m[2] === "ไหม" || m[2] === "มั้ย" ? "ไหมคะ?" : choice ? "ดีนะคะ?" : "คะ?";
    return `ไม่ทราบว่า${name}สะดวก${what}${tail === "ดีนะคะ?" && !/ไหน$/u.test(what) ? " " : ""}${tail}`;
  }
  // 29 ต.ค.: "ไม่ทราบว่าคุณอยากให้ลูกแพร…ไหมคะ?" ถ่อมตัวครึ่งเดียว = แปลงท่อนหลังแบบเดียวกับคำชวนห้วน
  m = /^ไม่ทราบว่า\s?คุณ\s?(อยาก(?:ให้ลูกแพร|ดู|เห็น|ได้).*)$/u.exec(core);
  if (m) {
    const inner = politeAsk(m[1], name, opts);
    if (inner !== m[1]) return inner;
  }
  // 29 ต.ค.: คำถามคุยเรื่องงาน/คลาสที่ขึ้นต้นด้วย "อยาก…" / "สนใจ…" (18 ห้องหลัง soul v1.1) = ขึ้นต้นถ่อมตัว
  if (!opts.deliver && /^(?:อยาก|สนใจ)/u.test(core)) return `ไม่ทราบว่า${name}${core}`;
  if (name && /^ไม่ทราบว่า(?!\s*คุณ)/u.test(core)) return core.replace(/^ไม่ทราบว่า\s*/u, `ไม่ทราบว่า${name}`);
  // "ไม่ทราบว่าคุณสนใจ…" ที่รู้ชื่ออยู่แล้ว = เติมชื่อ — เว้นข้อความที่เรียกชื่อไปแล้ว (ไม่เรียกซ้ำในข้อความเดียว)
  if (name && !opts.mentioned && /^ไม่ทราบว่า\s?คุณ(?=\s?(?:สนใจ|สะดวก|อยาก))/u.test(core)) {
    return core.replace(/^ไม่ทราบว่า\s?คุณ\s?/u, `ไม่ทราบว่า${name}`);
  }
  return sentence;
}
// พี่ง้วง 29 ต.ค. (ห้องคุณบอย): "รอบที่เปิดมี เสาร์ 14 พ.ย. · … 19 ธ.ค. สะดวกรอบไหนคะ?" — รายการกับคำถามติดเป็นประโยคเดียว
// ด่านเดิมดูแค่ต้นประโยคจึงไม่เห็น = แยกท่อนคำถามท้ายประโยคออกมาแปลง แล้วปิดท่อนหน้าด้วย "ค่ะ"
const TAIL_ASK_AT = /\s(?=สะดวก|อยาก|สนใจ)/gu;
// ท่อนหน้าจบด้วยคำเชื่อม/คำยกตัวอย่าง ("…ช่วยต่อคะ เช่น อยากนำ AI…") = ท่อนหลังเป็นส่วนของคำถามเดิม ไม่แยก
const TAIL_HEAD_BLOCK = /(?:ถ้า|หาก|เมื่อ|ว่า|ที่|จะ|ไม่|ก็|และ|หรือ|แต่|เพราะ|เช่น|คือ|ได้แก่|อาทิ|อย่าง)$/u;
const TAIL_LEAD_IN = /^(?:สำหรับ|ถ้า|หาก|หลัง|ก่อน|เมื่อ|พอ|ระหว่าง|ส่วน|ในส่วน|เรื่อง|ตอนนี้|นอกจาก|จาก|ตาม|เพื่อ|แต่ละ|กรณี)/u;
function politeTail(sentence, name, opts = {}) {
  if (opts.deliver || /ไม่ทราบว่า/u.test(sentence)) return sentence;
  for (const at of sentence.matchAll(TAIL_ASK_AT)) {
    const head = sentence.slice(0, at.index).trimEnd();
    const tail = sentence.slice(at.index + 1);
    if (!head || TAIL_HEAD_BLOCK.test(head)) continue;
    // ท่อนหน้าเป็นแค่คำเรียก ("คุณSita สะดวกเรียน…ไหมคะ?") = ใช้คำเรียกนั้นเป็นชื่อ ไม่เรียกซ้ำสองครั้ง
    if (/^คุณ\S{1,30}$/u.test(head)) {
      const named = politeAsk(tail, `${head} `, opts);
      if (named !== tail) return named;
      continue;
    }
    const next = politeAsk(tail, name, opts);
    if (next === tail) continue;
    // ท่อนหน้าเป็นวลีนำ ("สำหรับธุรกิจ… / ถ้านำไปใช้… / หลังกลับถึงไทยวันที่ 30") = ต่อคำถามเลย ไม่ปิดด้วยค่ะ
    const close = TAIL_LEAD_IN.test(head) || /(?:ค่ะ|คะ|ครับ|นะ)$/u.test(head) || !/[\p{Script=Thai}0-9.)]$/u.test(head) ? "" : " ค่ะ";
    return `${head}${close} ${next}`;
  }
  return sentence;
}
function nameMentioned(text, address) {
  if (!address || address.generic || !address.mention) return false;
  return new RegExp(address.mention.source, "u").test(String(text));
}
export function politeAsks(text, ctx = {}, fixes = []) {
  const name = politeNameOf(ctx);
  // งานส่งของ: ย่อหน้าท้ายอาจเป็นเนื้องาน (แคปชัน) เมื่อประโยคปิดท้ายถูกตัด — ใช้แค่กติกา 13 ต.ค. ที่ดูต้นประโยค
  const opts = { mentioned: nameMentioned(text, ctx.address), deliver: ctx.stage === "DELIVER" };
  let changed = false;
  const politeLine = (line) => sentencesOf(line).map((sentence) => {
    const whole = politeAsk(sentence, name, opts);
    const next = whole !== sentence ? whole : politeTail(sentence, name, opts);
    if (next !== sentence) changed = true;
    return next;
  }).join(" ");
  // งานส่งของ (แคปชัน/ข้อความที่ลูกค้าขอให้ร่าง) = เนื้องานของลูกค้า แปลงเฉพาะย่อหน้าปิดท้ายของลูกแพร
  const paragraphs = String(text).split("\n\n");
  const out = paragraphs.map((paragraph, pi) => (ctx.stage === "DELIVER" && pi < paragraphs.length - 1
    ? paragraph : paragraph.split("\n").map(politeLine).join("\n"))).join("\n\n");
  if (!changed) return text;
  fixes.push("polite_ask");
  return out;
}

const KHUN_LUKPRAE_MIX = /ไม่ทราบว่า\s?คุณ((?:(?!สนใจ|ให้)\S){0,30})\s+ลูกแพร(?:ขออนุญาต|ขอ)?\s?/gu;
// "…ไหมคะ ลูกแพรส่งให้ค่ะ?" — หางคำเสนอไม่ใช่คำถาม (เครื่องหมาย ? ทำให้ถูกแยกเป็นบับเบิลคำถามเดี่ยว)
const SEND_TAIL_QMARK = /ลูกแพรส่งให้ค่ะ\s*[?？]+/gu;
// ---- พี่ง้วง 14 ต.ค.: บับเบิลแรกของการแบ่งรับราคา = "ได้เลยค่ะ ลูกแพรขออนุญาตส่งข้อมูลสักครู่นะคะ" ----
// แชทจริง: "ได้เลยค่ะ เรื่องค่าเรียนลูกแพรดูแลให้ค่ะ" — ประโยครับเรื่องค่าเรียนแบบนี้ (และ "ยินดีที่สนใจนะคะ" ลอย ๆ) ถูกแทนด้วยประโยคเปิดตรงตัว
// วางเป็นย่อหน้าของตัวเอง (= บับเบิลแรก) · ข้อความแรกของห้องที่ทักทายก่อน = วางต่อจากย่อหน้าทักทาย
const SCREEN_OPENER = "ได้เลยค่ะ ลูกแพรขออนุญาตส่งข้อมูลสักครู่นะคะ";
const ODD_PRICE_ACK = /^(?:ได้เลยค่ะ|ได้ค่ะ|ยินดี(?:ที่สนใจ)?(?:นะ)?ค่ะ|ยินดีที่สนใจนะคะ)?\s*(?:เรื่อง)?(?:ค่าเรียน|ราคา)\S{0,12}(?:ลูกแพร)?\s?(?:ดูแล|จัดการ|ช่วยดู|แจ้ง)ให้(?:นะ)?ค่ะ$|^(?:ได้เลยค่ะ|ได้ค่ะ|ยินดีที่สนใจนะคะ|ยินดีค่ะ)$/u;
const GREETING_PARAGRAPH = /^สวัสดี/u;
// ประโยคทักทาย/แนะนำตัวของข้อความแรก — ประโยคเปิดต้องตามหลังประโยคพวกนี้เสมอ (แชทจริง 14 ต.ค.: ทักทายกับเนื้อหาอยู่ย่อหน้าเดียวกัน
// ประโยคเปิดเลยไปอยู่หน้า "สวัสดีค่ะ")
const INTRO_SENTENCE = /^สวัสดี|ลูกแพรเป็นผู้ช่วย|ดูแลให้คำปรึกษา/u;
function splitGreeting(paragraphs) {
  if (!paragraphs.length || !GREETING_PARAGRAPH.test(paragraphs[0])) return paragraphs;
  const [line, ...lines] = paragraphs[0].split("\n");
  const sentences = sentencesOf(line);
  let n = 0;
  while (n < sentences.length && INTRO_SENTENCE.test(sentences[n])) n += 1;
  const rest = [sentences.slice(n).join(" "), ...lines].filter((part) => part.trim()).join("\n");
  return [sentences.slice(0, n).join(" ") || paragraphs[0], ...(n && rest ? [rest] : []), ...paragraphs.slice(1)];
}
function ensureScreenOpener(text, ctx = {}, fixes = []) {
  if (String(text).includes(SCREEN_OPENER)) {
    // มีประโยคเปิดแล้วแต่อยู่หน้าคำทักทาย = ย้ายไปหลังคำทักทาย
    const without = String(text).replace(SCREEN_OPENER, "").replace(/^[ \t]+/u, "").trim();
    if (!GREETING_PARAGRAPH.test(without) || String(text).indexOf(SCREEN_OPENER) > String(text).indexOf("สวัสดี")) return text;
    text = without;
  }
  const paragraphs = splitGreeting(paragraphsOf(text));
  if (!paragraphs.length) return text;
  const at = GREETING_PARAGRAPH.test(paragraphs[0]) && paragraphs.length > 1 ? 1 : 0;
  // ตัดประโยครับเรื่องค่าเรียนที่ขึ้นต้นย่อหน้านั้น (ประโยคเปิดแทนให้)
  const lead = sentencesOf(paragraphs[at].split("\n")[0]);
  while (lead.length && ODD_PRICE_ACK.test(lead[0].trim())) lead.shift();
  const rest = [lead.join(" "), ...paragraphs[at].split("\n").slice(1)].filter((line) => line.trim()).join("\n");
  const next = [...paragraphs.slice(0, at), SCREEN_OPENER, ...(rest ? [rest] : []), ...paragraphs.slice(at + 1)];
  fixes.push("screen_opener");
  return next.join("\n\n");
}

/** แก้ได้เองโดยไม่ต้องเรียกโมเดล (§F ข้อ 2) */
export function autoFix(text, ctx = {}, fixes = []) {
  let value = String(text)
    .replace(/นะครับ/gu, "นะคะ").replace(/ครับ\s*\?/gu, "คะ?").replace(/ครับ/gu, "ค่ะ")
    .replace(/(?<!ลูก)แพร(?=\s|ค่ะ|คะ|นะ)/gu, "ลูกแพร")
    .replace(/\*\*/gu, "").replace(/^#{1,6}[ \t]*/gmu, "")
    .replace(/คะ[ \t]+\?/gu, "คะ?");
  if (ctx.address) value = dropGenericAddress(value, ctx.address);
  value = value.replace(URL, () => { fixes.push("url"); return ""; });
  let imageKept = false;
  value = value.replace(IMAGE_MARKER, (marker, key) => {
    if (!imageKept && ctx.imageKey && key.toLowerCase() === String(ctx.imageKey).toLowerCase()) { imageKept = true; return `[IMAGE:${ctx.imageKey}]`; }
    fixes.push("image");
    return "";
  });
  // พี่ง้วง 12 ต.ค.: เทิร์นชวนทดลองเรียนฟรี — "จำกัดสิทธิ์ต่อวัน" พูดได้เพราะเพดานจริง แต่ตัวเลขสิทธิ์/ที่นั่งใกล้เต็มไม่ได้มาจากตัวนับ = ตัดประโยคนั้น
  if (ctx.trialInvite) {
    const honest = stripFakeScarcity(value);
    if (honest !== value.trim()) { fixes.push("scarcity"); value = honest; }
  }
  value = fixEmoji(value, ctx.stage, fixes);
  value = fixOptionsParticle(value, fixes);
  value = dropRepeatedClosings(value, ctx, fixes);
  value = dropExitTail(value, ctx, fixes);
  value = dropOverlapEcho(value, ctx, fixes);
  value = dropRepeatedPrep(value, ctx, fixes);
  if (ctx.stage === "EXIT") value = dropExitSales(value, fixes);
  if (ctx.policy === "none") value = dropTrailingQuestions(value, fixes);
  if (ctx.stage === "EXIT" && modelLength(value) < EXIT_MIN_CHARS) { fixes.push("exit_fallback"); value = exitFallback(ctx); }
  value = dropPriceGate(value, fixes);
  if (ctx.stage === "SCREEN_PRICE") value = ensureScreenOpener(value, ctx, fixes);
  value = dropPriceDoubtProbe(value, ctx, fixes);
  // แม่แบบ "ไม่ทราบว่าคุณ(ชื่อ) …" — โมเดลพิมพ์ตามตัว = ใส่ชื่อที่ใช้เรียก (ไม่มีชื่อ = ตัดออก)
  if (/คุณ\s?\(ชื่อ(?:ที่ใช้เรียก)?\)/u.test(value)) {
    fixes.push("name_placeholder");
    const label = ctx.address && !ctx.address.generic && ctx.address.label ? `${ctx.address.label} ` : "";
    value = value.replace(/คุณ\s?\(ชื่อ(?:ที่ใช้เรียก)?\)\s?/gu, label);
  }
  // ตรวจคิว 13 ต.ค.: ลูกแพรเรียกลูกค้าที่เป็นพระว่า "อาตมา" ("งานวิจัยของอาตมา") — คำนี้พระใช้เรียกตัวเอง ลูกแพรไม่มีทางพูดถึงตัวเองด้วยคำนี้
  if (/อาตมา(?!ภาพ)/u.test(value)) { fixes.push("monk_pronoun"); value = value.replace(/อาตมา(?!ภาพ)/gu, "พระคุณเจ้า"); }
  return tidy(value);
}

function stripUnopenedSlots(text, open) {
  const allowed = new Set(open);
  let onlyContent = false;
  const removed = [];
  const paragraphs = paragraphsOf(text).map((paragraph) => {
    const next = paragraph.replace(/\{\{([^{}\n]{1,16})\}\}/gu, (whole, name) => {
      if (allowed.has(name.trim())) return whole;
      removed.push(name.trim());
      return "";
    });
    if (!next.trim() && paragraph.trim()) onlyContent = true;
    return next.trim();
  });
  return { text: paragraphs.filter(Boolean).join("\n\n"), removed, onlyContent };
}

const YEAR_CONTEXT = new RegExp(`(?:${MONTH_ALT}|ปี|พ\\.ศ\\.|ค\\.ศ\\.)\\s*$`, "u");
export function typedMoney(text = "") {
  const value = String(text).replace(TOKEN_OR_IMAGE, " ");
  const comma = /\d{1,3}(?:,\d{3})+/u.exec(value);
  if (comma) return comma[0];
  for (const match of value.matchAll(/(?<![\d.:,])\d{3,}(?![\d.:,])/gu)) {
    const n = Number(match[0]);
    const before = value.slice(Math.max(0, match.index - 20), match.index);
    const after = value.slice(match.index + match[0].length, match.index + match[0].length + 20);
    const year = match[0].length === 4 && ((n >= 2000 && n <= 2099) || (n >= 2500 && n <= 2599)) && YEAR_CONTEXT.test(value.slice(Math.max(0, match.index - 12), match.index));
    if (year) continue;
    if (match[0].length >= 4 || MONEY_WORD.test(before) || MONEY_WORD.test(after)) return match[0];
  }
  return "";
}

const monthIndexOf = (token) => MONTHS.findIndex(([full, short]) => token === full || token.replace(/\.?$/u, ".") === short);

/** วันที่ไทยที่ไม่อยู่ในรอบที่เปิดและไม่ใช่วันนี้ */
export function foreignDates(text = "", allowedDates = new Set()) {
  const bad = [];
  for (const match of String(text).matchAll(THAI_DATE)) {
    const month = monthIndexOf(match[2]);
    for (const day of match[1].match(/\d{1,2}/gu) || []) {
      if (!allowedDates.has(`${Number(day)}-${month + 1}`)) bad.push(`${day} ${match[2]}`);
    }
  }
  return bad;
}

// ---- วันที่ลูกค้าถามที่ไม่มีรอบของคลาสนี้ (รีวิวเคสจริงทั้งวัน 5 ต.ค.) ----
// เทิร์นนั้นพูดถึงวันที่ได้ (ด่านวันที่เปิดให้) แต่ประโยคที่เอ่ยวันนั้นต้องบอกว่าไม่มี/ไม่ใช่ หรือบอกว่าเป็นรอบของอีกคลาส — อ้างว่ามีรอบ = ผิดด่านแข็ง
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "ยังไม่เต็มค่ะ สมัครได้เลย" / "ไม่ได้เต็มนะคะ" (อ้างว่ามีที่) เคยผ่านเพราะคำว่า ยังไม่/ไม่ได้ เฉย ๆ นับเป็นคำปฏิเสธ
// · รอบเต็มบอกว่า "เต็มแล้ว" ได้ · "เป็นรอบของคลาสต่อยอด" = บอกว่าเป็นของอีกคลาส · ประโยคที่พาไปรอบใกล้สุดไม่ใช่การอ้างวันนั้น
const DATE_DENIAL = /ไม่มี(?:รอบ)?|ยังไม่(?:มี|เปิด)|ไม่ใช่|ไม่เปิด|ไม่ตรง|(?<!ไม่(?:ได้)?\s?)เต็ม|ปิดรับ/u;
const OTHER_CLASS_WORD = Object.freeze({ "AI Agent Workflow Automation": /workflow|ต่อยอด/iu, "AI Agent for Business": /business|พื้นฐาน/iu });
const compactDate = (text) => String(text).replace(/\s+/gu, "");
// ประโยคที่เอ่ยรอบใกล้สุดที่ระบบเสนอด้วย ("สำหรับเสาร์ 24 ขอแนะนำรอบใกล้สุดคือเสาร์ 17") = พาไปรอบอื่น ไม่ใช่อ้างว่าวันนั้นมีรอบ
const namesNearest = (sentence, labels = []) => labels.some((label) => compactDate(sentence).includes(compactDate(String(label).replace(/^\S+\s+/u, ""))));
function requestedDateRe(iso) {
  const [, month, day] = String(iso || "").split("-").map(Number);
  if (!month || !day) return null;
  const [full, short] = MONTHS[month - 1];
  return new RegExp(`(?<!\\d)${day}\\s*(?:${esc(full)}|${esc(short.slice(0, -1))}\\.?)|(?:เสาร์|อาทิตย์|วันที่)\\s*(?:ที่\\s*)?${day}(?!\\d)`, "u");
}
function claimsRequestedDate(final, ctx) {
  const rd = ctx.requestedDate;
  if (!rd?.status || rd.status === "open") return "";
  const re = requestedDateRe(rd.iso);
  if (!re) return "";
  const otherWord = OTHER_CLASS_WORD[rd.otherClass];
  for (const line of String(final).split("\n")) {
    for (const sentence of sentencesOf(line)) {
      if (!re.test(sentence) || DATE_DENIAL.test(sentence) || namesNearest(sentence, ctx.roundLabels)) continue;
      if (rd.status === "other_class" && otherWord?.test(sentence)) continue;
      return rd.label;
    }
  }
  return "";
}
// ไม่มีระบบรายชื่อรอหรือแจ้งเตือนรอบใหม่ — "ถ้ามีรอบใหม่จะแจ้งให้ทราบ / จดชื่อไว้" คือคำสัญญาที่ไม่มีใครทำตาม
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): หลุด "จะแจ้งรอบใหม่ให้ทราบ" · "พอมีรอบใหม่ ลูกแพรทักไปบอก" · "ถ้ามีคลาสรอบใหม่…" · "ลูกแพรเก็บชื่อไว้ให้"
// · "ติดต่อกลับไป" — และเคยจับเนื้อหาคลาส ("ฝึกทำ waiting list อัตโนมัติ" · "ให้ AI จดชื่อลูกค้าลงชีต") กับ "ไม่ต้องลงชื่อรอ" · "ลงชื่อรอบ…" (สมัครรอบ)
// — คำว่าจดชื่อ/รายชื่อรอ/waiting list นับเฉพาะตอนลูกแพรเป็นคนทำและไม่ได้ปฏิเสธ
const NOTIFY_VERB = "(?:จะ|เดี๋ยว)\\s?(?:รีบ)?(?:แจ้ง|บอก|ทัก|ส่งข่าว|อัปเดต|อัพเดต|ติดต่อ(?:กลับ)?)";
const NOTIFY_PLAIN = "ทักไป(?:บอก|แจ้ง)|ติดต่อกลับ|แจ้งให้ทราบ|บอกให้ทราบ";
const ROUND_CONDITION = "(?:เมื่อ|ทันทีที่|ถ้า|หาก|พอ)\\s?(?:มี|เปิด)\\s?(?:คลาส|คอร์ส)?\\s?รอบ";
const NOT_ME = "(?<!ไม่(?:ต้อง)?\\s?)";
// รีวิวเคสจริง 6–7 ต.ค.: "แจ้งรอบถัดไปให้ทราบได้เมื่อมีข้อมูล" หลุด (ไม่มี จะ/เดี๋ยว นำหน้า และเงื่อนไขเป็น "เมื่อมีข้อมูล" ไม่ใช่ "เมื่อมีรอบ")
// — ลูกแพรเป็นคนแจ้ง (ไม่ใช่ชวนลูกค้าบอกลูกแพร/ทีม) + เรื่องรอบ + เงื่อนไขว่ามีข้อมูล/ข่าว/อัปเดตเมื่อไหร่ · "แจ้งค่าเรียนให้ทันที" ไม่ใช่เรื่องรอบ
const NOTIFY_ANY = "(?:แจ้ง|บอก|ทัก|อัปเดต|อัพเดต|ส่งข่าว)(?!\\s?(?:ลูกแพร|ทีม|แอดมิน|มา|เข้ามา|ได้เลย|ค่าเรียน|ราคา))";
const INFO_CONDITION = "(?:เมื่อ|ทันทีที่|ถ้า|หาก|พอ)\\s?(?:มี|ได้)\\s?(?:ข้อมูล|ข่าว|อัปเดต|อัพเดต)";
const NEXT_ROUND = "รอบ\\s?(?:ใหม่|ถัดไป|ต่อไป|หน้า)";
export const WAITLIST_PROMISE = new RegExp([`${NOTIFY_VERB}[^\\n]{0,24}?${ROUND_CONDITION}`,
  `${ROUND_CONDITION}[^\\n]{0,30}?(?:${NOTIFY_VERB}|${NOTIFY_PLAIN})`, `${NOTIFY_VERB}\\S{0,6}?รอบ(?:ใหม่|ถัดไป|หน้า)`,
  `${NOT_ME}(?:แจ้ง|บอก|อัปเดต|อัพเดต|ส่งข่าว)\\s?(?:เรื่อง)?\\s?${NEXT_ROUND}[^\\n]{0,20}?(?:ให้(?:ทราบ|รู้)|${INFO_CONDITION})`,
  `${NOTIFY_ANY}\\S{0,4}?(?:เรื่อง)?\\s?รอบ[^\\n]{0,30}?${INFO_CONDITION}`, `${INFO_CONDITION}\\s?(?:เรื่อง|ของ)?\\s?รอบ[^\\n]{0,30}?${NOTIFY_ANY}`,
  `${NEXT_ROUND}[^\\n]{0,30}?${INFO_CONDITION}[^\\n]{0,20}?${NOTIFY_ANY}`,
  `${NOT_ME}(?:ลูกแพร|เดี๋ยว|จะ)\\S{0,8}?(?:จด|เก็บ|บันทึก|ลง)(?:ชื่อ|รายชื่อ|เบอร์|วันที่)(?!ลูกค้า)\\S{0,6}?(?:ไว้|รอ|ให้)`,
  `${NOT_ME}(?:ลง|ใส่)ชื่อ(?:รอ|ไว้)(?!บ)`, `${NOT_ME}รายชื่อรอ(?!บ)`, `${NOT_ME}คิวรอ(?!บ)`,
  "(?:ลูกแพร|เดี๋ยว|จะ)\\S{0,12}?(?:ใส่|ลง|เพิ่ม)\\S{0,6}?wait(?:ing)?\\s?list"].join("|"), "iu");

// ---- H11 บอกลูกค้าว่า "ยังยืนยันไม่ได้ / ไม่มีข้อมูล" ทั้งที่ระบบมีข้อมูลนั้น (พี่ง้วง 12 ต.ค. "แก้เลย ทุกอย่างคือ human touch") ----
// เคสจริง 11 ต.ค.: "เรียนเท่าไหนครับ" → "ตอนนี้ลูกแพรยังยืนยันค่าเรียนไม่ได้ค่ะ" · "มีแบบไหน" → "ยังไม่มีข้อมูลยืนยันว่ามีคลาสแบบไหนบ้าง"
// · "ยังไม่มีข้อมูลหัวข้อเรียนที่ยืนยันได้ครบ จึงยังสรุปรายละเอียดให้ไม่ได้" · "ใบรับรองหรือประกาศนียบัตร … ยังไม่มีข้อมูลยืนยันส่วนนี้"
// นับเฉพาะประโยคที่มีทั้ง (ก) คำปฏิเสธว่าไม่มีข้อมูล/ยืนยันไม่ได้ และ (ข) เรื่องที่ระบบถือข้อมูลไว้เสมอ: ค่าเรียน ชื่อ/ประเภทคลาส
// หัวข้อที่สอน รูปแบบเรียนสด สถานที่ สิ่งที่รวม ใบประกาศนียบัตร และวันเรียน (เฉพาะเทิร์นที่มีรอบเปิด)
// เรื่องที่ไม่มีในข้อมูลจริง (ตัวต่อตัว/ปักตะกร้า TikTok/ตารางรายชั่วโมง) หรือเป็นงานทีม (ที่นั่ง จอง สมัคร ยอดโอน) หรือการรับประกันผล ไม่นับ
// ทุกตัวจับเป็นคำตายตัว + ช่วงสั้นที่มีขอบเขต (ห้ามช่องว่างและห้ามคำว่า ได้ ในช่วงกลาง — "ยืนยันได้เลยว่าไม่ได้มีค่าใช้จ่ายเพิ่ม" ไม่นับ)
// รีวิว 12 ต.ค. (ประโยคบอกเล่าที่มั่นใจถูกนับผิด): "ไม่ได้" ที่แปลว่า "ทำไม่ได้" จบวลีตรงนั้น (ค่ะ/นะ/ว่า/ช่องว่าง/ท้ายประโยค)
// ส่วน "ไม่ได้" ที่ตามด้วยคำกริยา ("ยืนยันว่าไม่ได้มีค่าใช้จ่ายเพิ่ม" · "ยืนยันว่าค่าเรียนไม่ได้รวมค่าเดินทาง") คือการปฏิเสธเนื้อความ ไม่ใช่บอกว่าไม่มีข้อมูล
// "ไม่มีรายละเอียด" นับเฉพาะตอนจบวลีหรือตามด้วยคำบอกว่าข้อมูลขาด ("คลาสนี้ไม่มีรายละเอียดซับซ้อน" ไม่นับ)
const CANNOT_END = "(?=ค่ะ|คะ|นะ|ครับ|คับ|จ้า|จ้ะ|ใน(?:ตอนนี้|ขณะนี้)|ตอนนี้|ขณะนี้|ว่า|เลย|จริง|แน่|ทั้งหมด|แล้ว|เพราะ|จึง|เนื่องจาก|จนกว่า|[\\s.,!?？…)\"”]|$)";
const NO_DETAIL_END = "(?=(?:ที่)?(?:ยืนยัน|แน่ชัด|ชัดเจน|ครบ)|ส่วน|เรื่อง|ตรงนี้|ตรงนั้น|เกี่ยวกับ|ว่า|ให้|หัวข้อ|รอบ|วัน|"
  + "ของ(?!คุณ|ลูกค้า|ร้าน|บริษัท)|ค่ะ|คะ|นะ|ครับ|คับ|จ้า|เลย|ใน(?:ตอนนี้|ขณะนี้)|ตอนนี้|[\\s.,!?？…)]|$)";
const NO_INFO_CLAIM = new RegExp([
  `ยืนยัน(?:(?!ได้)[^\\s?？!]){0,24}?ไม่ได้${CANNOT_END}`,
  "ไม่สามารถ(?:ยืนยัน|ระบุ|แจ้ง|บอก|สรุป|ให้ข้อมูล)",
  "ไม่มีข้อมูล(?!ลับ|ส่วนตัว|ส่วนบุคคล|ลูกค้า|สำคัญ|ของ(?:คุณ|ลูกค้า|ร้าน|บริษัท))",
  `ไม่มีรายละเอียด${NO_DETAIL_END}`,
  `(?:สรุป|แจ้ง|ให้ข้อมูล)(?:(?!ได้)[^\\s?？!]){0,20}?ให้ไม่ได้${CANNOT_END}`,
].join("|"), "u");
const HELD_TOPICS = Object.freeze([
  // ราคาเครื่องมือภายนอก (ChatGPT Plus / แพ็กเกจ Make) ไม่ใช่ค่าเรียนของเรา
  { re: /ค่าเรียน|ราคา|ค่าใช้จ่าย|ค่าคอร์ส|ค่าคลาส|ค่าอบรม|โปรโมชั่น|โปรโมชัน|early\s?bird/iu,
    unless: /ChatGPT|GPT|Plus|Make\.com|Canva|Gemini|Claude|แพ็กเกจ|แพคเกจ|API|โปรแกรม|แอป/iu },
  { re: /คลาส(?:แบบ|อะไร|ไหนบ้าง|อื่น)|มี(?:กี่)?คลาส|คอร์ส(?:แบบ|อะไร|ไหนบ้าง|อื่น)|รายชื่อ(?:คลาส|คอร์ส)|AI Agent for Business|Workflow Automation/iu },
  { re: /หัวข้อ|เนื้อหา|หลักสูตร|ที่สอน|สอนอะไร|outline/iu },
  { re: /เรียนสด|รูปแบบ(?:การ)?เรียน|สถานที่|เรียนที่ไหน|รวมอะไร|สิ่งที่(?:ได้|รวม)|ทีม\s?TA|กลุ่ม\s?LINE|LINE\s?Support/iu },
  { re: /ใบประกาศ|ประกาศนียบัตร|ใบรับรอง|certificate|เซอร์ติ/iu },
]);
const HELD_ROUND_TOPIC = /วันเรียน|รอบ(?:เรียน|ที่เปิด|ถัดไป|หน้า|ใหม่|ไหน)|มีรอบ/u;
const NOT_HELD_TOPIC = /การันตี|รับประกัน|ทุกคน|ผลลัพธ์|รายได้|ยอดขาย|ได้แน่|เห็นผล|ตัวต่อตัว|private|in-?house|อินเฮาส์|นอกสถานที่|ใบเสนอราคา|ใบกำกับ|ภาษี|ผ่อน|บัตรเครดิต|ที่นั่ง|จอง|สำรอง|สมัคร|ลงทะเบียน|ยอดโอน|สลิป|ล็อก/iu;

// ---- H11 (รอบ 2 · พี่ง้วง 12 ต.ค. ข้อ 3): "ยังไม่มีรอบที่ประกาศ · รอบเรียนยังไม่ประกาศ · ตอนนี้ยังไม่มีรอบเรียน" ทั้งที่เทิร์นนี้มีรอบเปิด ----
// ประโยคแบบนี้ไม่มีคำว่า "ยืนยันไม่ได้/ไม่มีข้อมูล" จึงหลุดตัวจับข้างบน — นับเฉพาะเทิร์นที่มีรอบเปิด (ctx.roundLabels)
// และลูกค้าไม่ได้ถามวันที่ที่ไม่มีรอบ (วันนั้นปฏิเสธได้ตรง ๆ — ด่าน H4 ดูแล)
// นับเฉพาะคำกล่าวรวม ๆ ว่าไม่มีรอบ: ประโยคที่เจาะจงชุดย่อย (วัน/เดือน/ช่วงเวลา/ตัวเลข/รอบใหม่-ถัดไป-อื่น-เพิ่ม/อีกคลาส/ออนไลน์-ส่วนตัว)
// หรือเป็นเงื่อนไข/คำถาม อาจจริงได้ จึงไม่นับ (เคสจริง 11 ต.ค.: "รอบวันอาทิตย์ยังไม่ได้ประกาศ" ตอนที่เปิดแต่วันเสาร์ = จริง)
// "กรอบ/ครอบ" ไม่ใช่รอบ · ทุกช่วงมีขอบเขต (ช่องว่างไม่เกินหนึ่งตัวต่อจุด) — ไม่ย้อนรอยกับข้อความยาว
const ROUND_NOUN = "(?:(?<![กค])รอบ(?:เรียน|สอนสด|คลาส)?|วันเรียน|ตารางเรียน)";
const ROUND_NOW = "(?:\\s?(?:ใน)?(?:ตอนนี้|ขณะนี้))?";
const ROUND_TAIL = "(?:\\s?(?:ที่|ซึ่ง)?\\s?(?:เปิด(?:รับ(?:สมัคร)?)?(?:อยู่|ไว้)?|ประกาศ(?:ไว้|แล้ว)?|กำหนด(?:ไว้)?))?";
const ROUND_END = "(?=ค่ะ|คะ|นะ|ครับ|คับ|จ้า|จ้ะ|ใน(?:ตอนนี้|ขณะนี้)|ตอนนี้|ขณะนี้|เลย|[\\s.,!?？…)\"”]|$)";
// "รอบเรียนยังไม่ประกาศ/เปิด(รับสมัคร)/ออก(มา)" ต้องจบที่คำกริยานั้น — "ยังไม่ออกใบประกาศนียบัตร / ยังไม่ออกบิล" เป็นเรื่องอื่น ไม่ใช่รอบ
const ROUND_VERB_TAIL = "(?:รับ(?:สมัคร)?|ออกมา|มา|ไว้)?";
// "ไม่ต้องรอประกาศรอบเรียน สมัครรอบที่เปิดอยู่ได้เลย" = บอกให้ไม่ต้องรอ ไม่ใช่บอกว่ายังไม่มีรอบ
const NOT_NEEDED_WAIT = "(?<!ไม่(?:จำเป็น)?ต้อง\\s?)";
const NO_ROUND_CLAIM = new RegExp([
  `ไม่มี(?:การ)?(?:ประกาศ|กำหนด(?:การ)?)?\\s?${ROUND_NOUN}${ROUND_TAIL}${ROUND_END}`,
  `${ROUND_NOUN}${ROUND_NOW}\\s?ยังไม่(?:ได้)?(?:(?:ประกาศ|เปิด|กำหนด|ออก)${ROUND_VERB_TAIL}|มี)${ROUND_END}`,
  `ยังไม่(?:ได้)?(?:ประกาศ|เปิด|กำหนด|ออก)(?:รับสมัคร)?\\s?${ROUND_NOUN}${ROUND_TAIL}${ROUND_END}`,
  `${ROUND_NOUN}${ROUND_NOW}\\s?(?:ยัง)?(?:ต้อง)?${NOT_NEEDED_WAIT}รอ(?:การ|ทีม(?:งาน)?)?ประกาศ`,
  `${NOT_NEEDED_WAIT}รอ(?:ทีม(?:งาน)?)?ประกาศ\\s?${ROUND_NOUN}`,
].join("|"), "u");
// ชุดย่อยที่อาจไม่มีรอบจริง + เงื่อนไข/คำถาม + งานทีม (ที่นั่ง/โอน)
const ROUND_SUBSET = new RegExp([
  "\\d", MONTH_ALT, "จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|สัปดาห์|เดือน|ปีหน้า|ปีใหม่|ไตรมาส|ช่วง|เช้า|บ่าย|เย็น|ค่ำ|กลางคืน|วันธรรมดา|วันหยุด|weekend|weekday",
  "ใหม่|ถัด|ต่อไป|หน้า|เพิ่ม|อื่น|อีก|หลังจาก|เต็ม",
  "ออนไลน์|online|zoom|ซูม|VDO|วิดีโอ|ส่วนตัว|ตัวต่อตัว|private|in-?house|อินเฮาส์|องค์กร|บริษัท|จังหวัด|สาขา|Custom\\s?GPT|ปรึกษา|consult",
  "ถ้า|หาก|กรณี|เผื่อ|หรือเปล่า|ไหม|มั้ย|[?？]|ที่สะดวก|ที่ว่าง|ของคุณ|ลูกค้า|ที่เลือก|ที่นั่ง|จอง|สำรอง|ยอดโอน|สลิป|ชำระ|การันตี|รับประกัน",
].join("|"), "iu");
const CLASS_MENTION = Object.freeze({ business: /for\s?Business|คลาสพื้นฐาน|คลาสเริ่มต้น/iu, workflow: /Workflow|คลาสต่อยอด/iu });

/** ประโยคเดียว: บอกว่า "ยังไม่มีรอบ/รอบยังไม่ประกาศ" แบบรวม ๆ ทั้งที่เทิร์นนี้มีรอบเปิด (ประโยคที่เจาะจงชุดย่อยไม่นับ) */
export function claimsNoOpenRound(sentence = "", ctx = {}) {
  const value = String(sentence || "");
  if (!(ctx.roundLabels || []).length) return false;
  if (ctx.requestedDate?.status && ctx.requestedDate.status !== "open") return false;
  if (!NO_ROUND_CLAIM.test(value) || ROUND_SUBSET.test(value)) return false;
  // อีกคลาสอาจยังไม่มีรอบจริง — รอบที่ด่านเห็นคือรอบของคลาสที่คุยอยู่ (ยังไม่รู้คลาส = ทุกคลาสรวมกัน จึงไม่นับประโยคที่เอ่ยชื่อคลาส)
  return !Object.keys(CLASS_MENTION).some((key) => CLASS_MENTION[key].test(value) && CLASS_NAMES[key] !== ctx.className);
}

/** ประโยคเดียว: อ้างว่าไม่มีข้อมูล/ยืนยันไม่ได้ ในเรื่องที่ระบบมีข้อมูล */
export function claimsNoHeldInfo(sentence = "", ctx = {}) {
  const value = String(sentence || "");
  if (claimsNoOpenRound(value, ctx)) return true;
  if (!NO_INFO_CLAIM.test(value) || NOT_HELD_TOPIC.test(value)) return false;
  if (HELD_TOPICS.some(({ re, unless }) => re.test(value) && !unless?.test(value))) return true;
  return (ctx.roundLabels || []).length > 0 && HELD_ROUND_TOPIC.test(value);
}

function offending(text, test) {
  for (const line of String(text).split("\n")) {
    for (const sentence of sentencesOf(line)) if (test(sentence)) return sentence;
  }
  return "";
}

function hardChecks(final, modelText, ctx) {
  const hard = [];
  const p = ctx.predicates || {};
  const money = typedMoney(modelText);
  if (money) hard.push({ id: "H2", sample: money });
  const dates = foreignDates(modelText, ctx.allowedDates);
  if (dates.length) hard.push({ id: "H4", dates });
  const claimed = claimsRequestedDate(final, ctx);
  if (claimed) hard.push({ id: "H4", dates: [claimed], claim: true });
  if (META_LEAK.test(final)) hard.push({ id: "H5" });
  const promise = (s) => Boolean(p.looksLikeTeamPromise?.(s) || p.looksLikeSelfPromise?.(s));
  if (promise(final)) hard.push({ id: "H6", sentence: offending(final, promise) || final.slice(0, 80) });
  if (p.looksLikeHandoverReply?.([final])) hard.push({ id: "H7", sentence: offending(final, (s) => p.looksLikeHandoverReply([s])) || final.slice(0, 80) });
  if (WAITLIST_PROMISE.test(final)) hard.push({ id: "H10", sentence: offending(final, (s) => WAITLIST_PROMISE.test(s)) || final.slice(0, 80) });
  // งานส่งของ (ร่างงานของลูกค้า) ไม่ตรวจ — เนื้องานเป็นของลูกค้า
  const noInfo = ctx.stage === "DELIVER" ? "" : offending(final, (s) => claimsNoHeldInfo(s, ctx));
  if (noInfo) hard.push({ id: "H11", sentence: noInfo, ...(claimsNoOpenRound(noInfo, ctx) ? { rounds: true } : {}) });
  if (PRICE_STAGES.has(ctx.stage) && (announcesCorrection(final) || /ขอโทษ|ขออภัย/u.test(final))) hard.push({ id: "H8" });
  const outbound = p.checkOutbound ? p.checkOutbound(final, ctx.guardTurn) : { ok: true };
  if (outbound?.ok === false) {
    hard.push({ id: "H9", detail: (outbound.violations || []).map((v) => `${v.type}:${v.detail ?? ""}`).join(", ") });
  }
  return hard;
}

// soul v1.1 C6 (20 ต.ค. 2026): คำชวนถ่อมตัว "…ไหมคะ ลูกแพรส่งให้ค่ะ" — ท่อนท้ายเป็นคำบอกเล่าที่ห่อคำถามไว้
// ตัวตรวจต้องมองคำถามก่อนท่อนนั้น ไม่งั้นจังหวะร้อนที่ปิดด้วยคำชวนแบบที่พี่ง้วงเลือก ติด S3 แล้วยิงซ่อมทุกครั้ง
const HUMBLE_TAIL = /^(?:เลือกแล้ว)?ลูกแพรส่ง\S{0,24}ให้(?:นะ)?ค่ะ$/u;
// 7 พ.ย. 2026 (เทสร่างแรก Sonnet + การ์ด v3 ขั้นพาเข้าคลาส 13 เคส): ร่างที่ยังติด S3 ทั้งหมดคือคำชวนที่มีเหตุผลสั้น ๆ
// คั่นก่อนท่อนถ่อมตัว ("…ไหมคะ จะได้เห็นว่าหัวข้อไหนตรงกับงานของคุณ… ลูกแพรส่งให้ค่ะ") — ยังปิดด้วยข้อเสนอเหมือนเดิม
// (การ์ดสไตล์ที่ถอดจากคำตอบ Opus ที่ทีมเลือกก็ใช้รูปนี้) แต่ตัวแบ่งประโยคตัดได้ก้อนเดียว ตัวตรวจจึงไม่เห็นคำถาม
// ยอมรับเฉพาะเหตุผลที่ขึ้นด้วย "จะได้" ยาวไม่เกินหนึ่งประโยคสั้น และต้องปิดด้วยท่อนถ่อมตัวตรงตัว · ประโยคลา/คำบอกเล่าอื่นยังติดเหมือนเดิม
const REASONED_HUMBLE_TAIL = /^(?:ลูกแพร)?จะได้[^?？\n]{1,160}?\s(?:เลือกแล้ว)?ลูกแพรส่ง\S{0,24}ให้(?:นะ)?ค่ะ$/u;
function finalQuestionLine(final) {
  const last = paragraphsOf(final).at(-1) || "";
  const line = last.split("\n").at(-1) || "";
  const sentences = sentencesOf(line);
  const tail = sentences.at(-1) || "";
  const humble = sentences.length > 1 && (HUMBLE_TAIL.test(tail) || (REASONED_HUMBLE_TAIL.test(tail) && !EXIT_PHRASE.test(tail)));
  const sentence = humble ? sentences.at(-2) : tail;
  return { paragraph: last, line, sentence };
}

function mirrored(reply, ctx) {
  const squash = (value) => chars(String(value).replace(/\s+/gu, ""));
  const target = squash(reply).join("");
  if (Number.isInteger(ctx.level) && new RegExp(`(?:ข้อ|ระดับ)\\s*${ctx.level}(?!\\d)`, "u").test(reply)) return true;
  for (const source of [ctx.userText, ctx.prevUserText]) {
    const list = squash(source);
    for (let i = 0; i + 4 <= list.length; i += 1) {
      const span = list.slice(i, i + 4).join("");
      if (!PARTICLE_SPAN.test(span) && target.includes(span)) return true;
    }
  }
  return false;
}

const COPY_SPAN = 40;
const TOLD_MIN = 12;
const BLOCKED = "\u0000";
const squashCopy = (text) => String(text).replace(TOKEN_OR_IMAGE, "").replace(/["“”‘’]/gu, "").replace(/\s+/gu, " ");
// คำปิดมาตรฐานที่ stage ใช้ได้หลายเคสไม่ใช่หลักฐานว่าลอก exemplar แม้ v3.8 เอาตัวอย่างประโยคออกจากธรรมนูญ
const STANDARD_OFFER_COPY = /อยากให้ลูกแพรส่งรอบเรียนที่เปิดอยู่ให้ดูไหมคะ[?？]?|สนใจดูรอบเรียนที่เปิดอยู่ไหมคะ\s?ลูกแพรส่งให้ค่ะ/gu;

/**
 * ตัวอย่างที่เหลือเฉพาะถ้อยคำของตัวอย่างเอง: ช่วงที่ยาว ≥12 ตัวอักษรซึ่งระบบสั่งให้พูดอยู่แล้ว
 * (ประโยคแนะนำตัว เหตุผลขอพื้นฐาน ข้อเสนอส่งรอบ ชื่อคลาส รอบเรียน …) ถูกแทนด้วยตัวกั้น
 * — ลูกแพรพูดตามงานของเทิร์นครบ ๆ ต้องไม่โดนนับว่า "ลอกตัวอย่าง" (S7)
 */
export function exemplarOwnText(source, instruction = "") {
  // ช่องเติม/รูปในตัวอย่าง = ตัวกั้น (ช่วงที่ลอกต้องไม่ข้ามช่อง)
  const list = chars(squashCopy(String(source).replace(TOKEN_OR_IMAGE, BLOCKED).replace(STANDARD_OFFER_COPY, BLOCKED)));
  const told = squashCopy(instruction);
  if (!told.trim()) return list.join("");
  const out = [];
  let i = 0;
  while (i < list.length) {
    let size = 0;
    if (i + TOLD_MIN <= list.length && told.includes(list.slice(i, i + TOLD_MIN).join(""))) {
      size = TOLD_MIN;
      while (i + size < list.length && told.includes(list.slice(i, i + size + 1).join(""))) size += 1;
    }
    out.push(size ? BLOCKED : list[i]);
    i += size || 1;
  }
  return out.join("");
}

// ctx.exemplarTexts ผ่าน exemplarOwnText มาแล้ว (engine ทำครั้งเดียวต่อเทิร์น)
// 7 พ.ย. 2026: คำตอบจริงของครูจากคลัง (reply_style_bank) ยอมให้ใช้วลีของครูได้ ลอกเกินหนึ่งประโยค (80 ตัวอักษร) ถึงนับว่าลอก
const BANK_COPY_SPAN = 80;
function copiedFromExemplar(modelText, exemplars = [], spanLength = COPY_SPAN) {
  const value = chars(squashCopy(modelText));
  for (let i = 0; i + spanLength <= value.length; i += 1) {
    const span = value.slice(i, i + spanLength).join("");
    if (exemplars.some((source) => String(source).includes(span))) return span;
  }
  return "";
}

function stockPhrase(final, modelText, ctx) {
  if (final.includes(STOCK_PHRASE)) return STOCK_PHRASE;
  const abstract = STOCK_ABSTRACT.exec(modelText);
  if (abstract) return abstract[0];
  const opener = LOGIC_OPENER.exec(modelText.trim());
  if (opener) return opener[0];
  if (/เทอม/u.test(ctx.userText || "") && TERM_CORRECTION.test(final)) return TERM_CORRECTION.exec(final)[0];
  if (ctx.stage === "DISCOVERY" && /ตรวจก่อนใช้/u.test(final) && !/ตรวจ/u.test(ctx.userText || "")) return "ตรวจก่อนใช้";
  return copiedFromExemplar(modelText, ctx.exemplarTexts) || copiedFromExemplar(modelText, ctx.bankTexts, BANK_COPY_SPAN);
}

// ---- ตอบคำถามก่อน (รีวิวเคสจริงทั้งวัน 5 ต.ค.: ขอข้อมูลคลาส / ถามว่าต้องมีบริษัทเองไหม ได้แค่ทักทาย + เหตุผล + บันได) ----
// ประโยคที่ทักแรก/ขอพื้นฐานพูดทุกห้อง (ทักทาย แนะนำตัว เหตุผลขอพื้นฐาน ประโยคราคามาต่อ) ไม่นับเป็นคำตอบ
const STOCK_FIRST_LINES = [
  /^สวัสดี(?:ค่ะ|คะ)?/u, /ลูกแพรเป็นผู้ช่วย/u, /ดูแลให้คำปรึกษาข้อมูลคลาสเรียน/u, /ยินดีที่(?:สนใจ|ทัก)/u,
  /เพื่อให้เลือกคลาสที่เหมาะสม/u, /มี(?:คลาส(?:\s*AI)?)?หลายคลาส/u, /ขอ(?:ทราบ|เช็ก|เช็ค|ถาม)(?:พื้นฐาน|สั้น)/u,
  /^ไม่เป็นไร(?:เลย)?(?:ค่ะ|คะ)/u, /^ขอโทษที่/u, /^ขออภัย/u, /ลูกแพรแจ้งค่าเรียนให้/u,
];
const ANSWER_CHECK_STAGES = new Set(["FIRST_CONTACT", "SCREEN_PRICE"]);
// รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 U7): ข้อความแรกที่ขอรายละเอียด — ประโยคข้อมูลคลาส (1 วัน · Workshop · TA · EZ Space · ทบทวนออนไลน์)
// ทำให้ด่าน "ตอบก่อน" ผ่านเสมอ ร่างที่ให้ข้อมูลคลาส + บันได แต่ไม่ตอบ "ใช้ Mac ได้ไหม" จึงหลุด — ประโยคข้อมูลคลาสนับเป็นคำตอบ
// เฉพาะตอนพูดถึงเรื่องที่ลูกค้าถาม (คำละตินเดียวกัน เช่น Mac/iPad หรือคำหัวข้อ เช่น วัน/เวลา/ออนไลน์/อายุ)
// (สร้างตอนใช้ครั้งแรก: stage.mjs กับไฟล์นี้อยู่ในวง import เดียวกันผ่านไปป์ไลน์ — ค่าคงที่ของ stage.mjs ยังไม่พร้อมตอนโหลดไฟล์นี้)
let detailsAskAll = null;
const detailsAskPattern = () => (detailsAskAll ??= new RegExp(DETAILS_ASK_RE.source, "giu"));
const QUESTION_TOPIC_WORDS = /วัน|เวลา|กี่โมง|ที่ไหน|สถานที่|ออนไลน์|ออนไซต์|อายุ|พื้นฐาน|โน้ตบุ๊ก|โน๊ตบุ๊ก|คอม|ไอแพด|มือถือ|ภาษา|เดินทาง|จอดรถ|กี่คน|ย้อนหลัง|ทบทวน|ใบประกาศ/gu;
const COMMON_LATIN = new Set(["ai", "agent", "for", "business", "workflow", "automation", "class"]);
function questionTopics(userText = "") {
  const asked = String(userText || "").replace(detailsAskPattern(), " ");
  const latin = (asked.match(/[A-Za-z]{2,}/gu) || []).map((word) => word.toLowerCase()).filter((word) => !COMMON_LATIN.has(word));
  return [...new Set([...latin, ...(asked.match(QUESTION_TOPIC_WORDS) || [])])];
}
function answersQuestion(modelText, { details = false, userText = "" } = {}) {
  const lines = String(modelText).replace(TOKEN_OR_IMAGE, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const topics = details ? questionTopics(userText) : [];
  const answers = (sentence) => !details || !DETAILS_FACT_WORDS.some((re) => re.test(sentence))
    || topics.some((topic) => sentence.toLowerCase().includes(topic));
  return lines.flatMap((line) => sentencesOf(line)).some((sentence) => hasLetters(sentence) && !STOCK_FIRST_LINES.some((re) => re.test(sentence)) && answers(sentence));
}

// ---- หลังแจ้งราคาแล้วถามเรื่องงาน/ระดับซ้ำ (รีวิวเคสจริงทั้งวัน 5 ต.ค.: การ์ดราคาแล้วปิดด้วย "อยากเริ่มฝึกกับงานไหนก่อน") ----
// คำถามก้าวถัดไป (รอบ/สมัคร/ยังติดเรื่องไหน/สนใจคลาสไหน) ไม่นับ
// รีวิวเคสจริง 6–7 ต.ค.: นับทุกห้องที่เห็นราคาแล้ว (เดิมเฉพาะตอนรู้คลาส — ยังไม่รู้คลาสได้ "เคยสร้าง Custom AI หรือ Workflow มาแล้วหรือยัง" หลังการ์ด
// สองคลาส และ "เคยใช้ AI ไหม") · "ขายสินค้าประเภทไหน" ก็เป็นคำถามทำความรู้จัก · ลูกค้าขอให้ช่วยเลือกคลาสเอง = คำถามเลือกคลาสใช้ได้
const AFTER_PRICE_DISCOVERY = /(?:งาน|ด้าน|ส่วน|เรื่อง)ไหน|อยากให้ AI ช่วย|ทำงานด้าน|ธุรกิจ(?:อะไร|ด้านไหน)|เคย(?:ลอง)?(?:ใช้|สร้าง) ?(?:AI|Custom|ChatGPT)|ระดับ(?:ไหน|ที่เท่าไหร่)|ประเภท(?:ไหน|อะไร)|(?:สินค้า|บริการ)(?:อะไร|แบบไหน)|ขาย(?:อะไร|ของอะไร)/iu;
const NEXT_STEP_WORDS = /รอบ|สมัคร|วันเรียน|ค่าเรียน|ติดเรื่อง|ลังเล|คลาสไหน/u;
// ---- ข้อความแรกที่ขอรายละเอียด (รีวิวเคสจริง 6–7 ต.ค.): ต้องมีข้อมูลคลาสจริงอย่างน้อยสองเรื่องก่อนบันได ----
const DETAILS_FACT_WORDS = [/1\s?วัน|เต็มวัน|10:00/u, /workshop|ลงมือทำ/iu, /\bTA\b/u, /ออนไลน์|ทบทวน/u, /EZ Space|บางนา|Mega Bangna/iu, /กลุ่มเล็ก|15 ท่าน/u, /LINE Support|กลุ่ม LINE/iu];
const detailFacts = (text) => DETAILS_FACT_WORDS.filter((re) => re.test(String(text).replace(TOKEN_OR_IMAGE, " "))).length;
// จำนวนคำถามในข้อความ — ตัวเลือกต่อท้าย ("…ไหนคะ เช่น … หรือ …?") คือคำถามเดียวกับประโยคก่อนหน้า (ตัวแบ่งประโยคตัดหลัง คะ)
const OPTIONS_TAIL = /^(?:เช่น|ทั้ง|หรือ)/u;
function questionUnits(text) {
  const units = [];
  for (const sentence of String(text).replace(TOKEN_OR_IMAGE, " ").split("\n").flatMap((line) => sentencesOf(line)).filter(hasLetters)) {
    if (units.length && OPTIONS_TAIL.test(sentence)) units[units.length - 1] += ` ${sentence}`;
    else units.push(sentence);
  }
  return units.filter((unit) => isClosingQuestion(unit)).length;
}

function softChecks(final, modelText, ctx, inline, draftLength = modelLength(modelText)) {
  const soft = inline.map((slot) => ({ id: "SLOT_INLINE", slot }));
  const { paragraph, line, sentence } = finalQuestionLine(final);
  const hasQuestion = isClosingQuestion(sentence);
  const marks = (paragraph.match(/[?？]/gu) || []).length;
  if (ctx.policy === "question" && !hasQuestion) soft.push({ id: "S1" });
  else if (["question", "hot"].includes(ctx.policy) && marks > 1) soft.push({ id: "S1" });
  else if (ctx.policy === "slot" && sentencesOf(modelText.replace(TOKEN_OR_IMAGE, "")).some((s) => isClosingQuestion(s))) soft.push({ id: "S1", slot: true });
  // คำถามไม่บังคับ (free: เงินตึง/ข้อกังวลหลังลูกค้าเมินข้อเสนอเดิม — เคสจริง 5 ต.ค.) = งานสั่งคำถามเปิดเบา ๆ เอง
  // ไม่ยิงซ่อมเพื่อเติมตัวเลือก (เดิม "ตอนนี้อะไรจะช่วยได้มากที่สุดคะ?" ติด S2 แล้วเสียหนึ่งยกซ่อม)
  // วัดความยาวโดยไม่นับหัวถ่อมตัว "ไม่ทราบว่าคุณ…" ที่ด่าน polite_ask เติมให้ (29 ต.ค.) — คำถามกว้างยังต้องได้ตัวเลือก
  if (QUESTION_STAGES.has(ctx.stage) && ctx.policy !== "free" && hasQuestion
    && chars(line.replace(/^ไม่ทราบว่า(?:คุณ\S{0,30}\s)?/u, "")).length < 45
    && /อะไร|ไหน|อย่างแรก/u.test(line) && !/เช่น|หรือ|ทั้ง|,/u.test(line)) soft.push({ id: "S2" });
  const exit = EXIT_PHRASE.exec(final);
  if (ctx.policy === "hot" && (!hasQuestion || exit)) soft.push({ id: "S3", phrase: exit?.[0] || "" });
  const names = [ctx.className, ...Object.values(CLASS_NAMES)].filter(Boolean);
  if (CLASS_STAGES.has(ctx.stage) && !names.some((name) => final.includes(name))) soft.push({ id: "S4" });
  const close = HARD_CLOSE.exec(final);
  if (close) soft.push({ id: "S5", phrase: close[0] });
  const length = draftLength;
  const [min, max] = ctx.band || [0, Infinity];
  if (length > 1.6 * max || (!["GOODBYE", "EXIT"].includes(ctx.stage) && length < 0.6 * min)) soft.push({ id: "S6", n: length });
  const turnMods = ctx.decision?.modifiers || [];
  if (ANSWER_CHECK_STAGES.has(ctx.stage) && turnMods.includes("answer_first")
    && !answersQuestion(modelText, { details: turnMods.includes("details"), userText: ctx.userText })) {
    soft.push({ id: "S10" });
  }
  // ทั้งบรรทัดคำถามปิดท้าย ("…งานไหนก่อนคะ เช่น …?" ตัวแบ่งประโยคตัดหลัง คะ)
  if (pricedTurn(ctx) && ctx.policy === "hot" && hasQuestion && !HELP_CHOOSE_RE.test(String(ctx.userText || ""))
    && AFTER_PRICE_DISCOVERY.test(line) && !NEXT_STEP_WORDS.test(line)) soft.push({ id: "S11" });
  // รีวิวเคสจริง 6–7 ต.ค.: ขอรายละเอียดแล้วได้ข้อมูลบรรทัดเดียวก่อนบันได
  if ((ctx.decision?.modifiers || []).includes("details") && detailFacts(modelText) < 2) soft.push({ id: "S12" });
  // รีวิวเคสจริง 6–7 ต.ค.: คำถามคัดกรองก่อนราคาตามด้วยประโยคชวนตอบอีกข้อ (คนละย่อหน้า S1 ไม่เห็น) = ลูกค้าเห็นสองคำถาม
  if (ctx.stage === "SCREEN_PRICE" && ctx.policy === "question" && questionUnits(modelText) > 1) soft.push({ id: "S13" });
  const stock = stockPhrase(final, modelText, ctx);
  if (stock) soft.push({ id: "S7", phrase: stock });
  const quoted = [...modelText.matchAll(QUOTED_SPAN)].map((m) => m[1].trim()).find((span) => span && String(ctx.userText || "").includes(span));
  if (quoted) soft.push({ id: "S9", span: quoted });
  if (MIRROR_STAGES.has(ctx.stage) && chars(String(ctx.userText || "").replace(/\s+/gu, "")).length >= 12 && !mirrored(modelText, ctx)) {
    soft.push({ id: "S8", span: chars(String(ctx.userText || "").replace(/\s+/gu, " ").trim()).slice(0, 12).join("") });
  }
  return soft;
}

/**
 * @returns {{text: string, modelText: string, plan: string, hard: object[], soft: object[], fixes: string[], slotsUsed: string[]}}
 */
export function finalizeDraft(raw, ctx = {}) {
  const parsed = parseReply(raw);
  const fixes = [];
  const hard = [];
  // ร่างจริงต้องสัญญาว่าจะให้ลิงก์ก่อน จึงซ่อม URL ที่ autoFix ลบออก; ข้อความปฏิเสธ/เลื่อนส่งไม่ถูกยกระดับเป็นการอนุญาต
  let trialLinkDirection = null;
  if (ctx.trialLinkRequested && ctx.approvedTrialUrl) {
    for (const clause of parsed.reply.split(/(?:แต่(?:ว่า|ก็)?|อย่างไรก็ตาม|ทว่า)|[\n.!?。！？]+|(?:ค่ะ|ครับ|คะ|ค่า)\s+/u)
      .map((item) => item.trim()).filter(Boolean)) {
      if (/ลิงก์/u.test(clause)) {
        if (TRIAL_LINK_DENIAL.test(clause)) trialLinkDirection = false;
        else if (TRIAL_LINK_PROMISE.test(clause)) trialLinkDirection = true;
      } else if (trialLinkDirection !== null && !TRIAL_LINK_OTHER_TARGET.test(clause) && TRIAL_LINK_CARRIED_DENIAL.test(clause)) {
        // “นี่คือลิงก์... แต่เปลี่ยนใจ ไม่ส่งแล้ว” — clause หลังละ target ได้และต้องชนะคำสัญญาเก่า
        trialLinkDirection = false;
      }
    }
  }
  const addApprovedTrialLink = trialLinkDirection === true;
  let text = autoFix(parsed.reply, ctx, fixes);
  const stripped = stripUnopenedSlots(text, ctx.openSlots || []);
  text = stripped.text;
  if (stripped.removed.length) fixes.push(...stripped.removed.map((name) => `strip_slot:${name}`));
  if (stripped.onlyContent) hard.push({ id: "H3", slot: stripped.removed[0] });
  const emptyModel = modelLength(text) === 0;
  for (const [name, where] of ctx.required || []) {
    if (!slotTokens(text).includes(name) && ctx.slotValues?.[name]) { text = insertSlot(text, name, where); fixes.push(`insert:${name}`); }
  }
  // พี่ง้วง 12 ต.ค.: รูปบรรยากาศคลาสจริงที่ตัวตัดสินเลือก = ระบบแนบให้เองถ้าโมเดลลืม (ไว้ก่อนย่อหน้าสุดท้าย — คำถามปิดท้ายยังอยู่ท้ายสุด)
  if (ctx.imageRequired && ctx.imageKey && !emptyModel && !text.toLowerCase().includes(`[image:${String(ctx.imageKey).toLowerCase()}]`)) {
    const paragraphs = text.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
    text = [...paragraphs.slice(0, -1), `[IMAGE:${ctx.imageKey}]`, ...paragraphs.slice(-1)].join("\n\n");
    fixes.push("insert:image");
  }
  const slotValues = { ...(ctx.slotValues || {}) };
  if (addApprovedTrialLink) {
    slotValues.ทดลองเรียน = ctx.approvedTrialUrl;
    if (!slotTokens(text).includes("ทดลองเรียน")) {
      text = insertSlot(text, "ทดลองเรียน", "beforeLast");
      fixes.push("insert:ทดลองเรียน");
    }
  }
  // แชทจริง 14 ต.ค.: "ไม่ทราบว่าคุณ ลูกแพรขออนุญาตส่ง…" (สองแม่แบบปนกัน) → "ไม่ทราบว่าคุณ… สนใจให้ลูกแพรส่ง…" ก่อนต่อช่องว่าง (ไม่งั้นได้ "คุณลูกแพร")
  // S6 วัดความยาวที่โมเดลเขียนเอง — หัวถ่อมตัวที่ด่าน polite_ask เติมให้ไม่นับ (29 ต.ค.)
  const draftLength = modelLength(text);
  text = politeAsks(text, ctx, fixes).replace(KHUN_LUKPRAE_MIX, (_, name) => `ไม่ทราบว่าคุณ${name ? `${name} ` : ""}สนใจให้ลูกแพร`)
    .replace(/ไม่ทราบว่า\s?คุณ[ \t]+(?=[\u0E00-\u0E7F])/gu, "ไม่ทราบว่าคุณ").replace(SEND_TAIL_QMARK, "ลูกแพรส่งให้ค่ะ");
  // ชมพู่ 7 พ.ย. 2026 (เทสปิดตารอบ 12): "ไม่ทราบว่าคุณอนุญาตให้ลูกแพรส่ง…" อ่านแข็ง ใช้ "สนใจให้ลูกแพรส่ง…" แทน
  // (5.6 Sol ลอกคำ "ข้อเสนอแบบขออนุญาต" จากคำสั่งงานเดิม) · "ลูกแพรขออนุญาตส่งข้อมูล…" ของทีมไม่แตะ
  if (/(?<!ขอ)อนุญาตให้ลูกแพร/u.test(text)) { text = text.replace(/(?<!ขอ)อนุญาตให้ลูกแพร/gu, "สนใจให้ลูกแพร"); fixes.push("permission_to_interest"); }
  const expanded = expandSlots(text, slotValues);
  const final = tidy(expanded.text);
  if (emptyModel || !final) hard.unshift({ id: "H1" });
  hard.push(...hardChecks(final, text, ctx));
  const soft = softChecks(final, text, ctx, expanded.inline, draftLength);
  return { text: final, modelText: text, plan: parsed.plan, hard, soft, fixes, slotsUsed: expanded.used };
}

// ช่องเติมกลางประโยคไม่นับเป็นการเผยระบบ (ระบบเติมเองหลังจากนี้)
const sentenceFails = (sentence, ctx) => hardChecks(sentence, sentence, ctx)
  .some((item) => item.id !== "H5" || META_LEAK.test(sentence.replace(/\{\{[^{}]+\}\}/gu, "")));

/** ตัดประโยคที่ผิดด่านแข็งทิ้ง (ช่องเติมคงไว้) แล้วตรวจใหม่ — ใช้ตอนไม่มีเวลา/ไม่มีโอกาสซ่อมแล้ว */
export function stripHard(result, ctx = {}) {
  const paragraphs = paragraphsOf(result.modelText).map((paragraph) => paragraph.split("\n").map((line) => {
    if (/^\{\{[^{}]+\}\}$/u.test(line.trim())) return line;
    return sentencesOf(line).filter((sentence) => !sentenceFails(sentence, ctx)).join(" ");
  }).filter((line) => line.trim()).join("\n"));
  return finalizeDraft(paragraphs.filter(Boolean).join("\n\n"), ctx);
}

// ลูกค้าได้ราคาไปแล้วแต่เทิร์นนี้ไม่มีช่องราคา (เช่น บ่นแพง) = ห้ามบอกว่า "ยังไม่บอกตัวเลข" (ไม่จริง)
function moneyRepair(ctx) {
  if ((ctx.openSlots || []).some((name) => ["ราคา", "ดีล"].includes(name))) return "ใช้ช่องเติม {{ราคา}} หรือ {{ดีล}} แทน";
  if (ctx.priceQuoted) return "ตัดตัวเลขออก เทิร์นนี้ไม่พิมพ์ตัวเลขเงิน ถ้าต้องอ้างถึงราคา พูดว่า ราคาที่ลูกแพรแจ้งไว้ แทน";
  return "เทิร์นนี้ยังไม่บอกตัวเลขค่าเรียน ตัดตัวเลขออก";
}

const REPAIR_LINES = Object.freeze({
  H1: () => "ส่งคำตอบในรูปแบบ <plan>…</plan><reply>…</reply>",
  H2: (v, ctx) => `มีตัวเลขเงินที่พิมพ์เอง ("${v.sample}") ${moneyRepair(ctx)}`,
  H3: (v) => `ช่อง {{${v.slot}}} ไม่ได้เปิดในเทิร์นนี้ เอาออก`,
  H4: (v, ctx) => (v.claim
    ? `${v.dates.join(", ")} ${ctx.requestedDate?.status === "full" ? "รอบของคลาสนี้เต็มแล้ว บอกตรง ๆ ว่าเต็มแล้ว" : "ไม่มีรอบของคลาสนี้ บอกตรง ๆ ว่าไม่มี (หรือบอกว่าเป็นรอบของอีกคลาส)"} แล้วเสนอรอบที่ใกล้ที่สุด ${(ctx.roundLabels || []).join(", ")}`
    : `วันที่ ${v.dates.join(", ")} ไม่อยู่ในรอบที่เปิด ใช้ได้เฉพาะ ${(ctx.roundLabels || []).join(", ") || "วันที่ในข้อเท็จจริงของเทิร์นนี้"}`),
  H5: () => "ตัดส่วนที่พูดถึงระบบหรือบันทึกภายในออก คุยกับลูกค้าตรง ๆ",
  H6: (v) => `ประโยค "${v.sentence}" รับปากแทนทีมงานหรือรับปากว่าจะจอง/ล็อกให้ เปลี่ยนเป็นให้ข้อมูลและชวนตัดสินใจ`,
  H7: (v) => `ประโยค "${v.sentence}" รับปากแทนทีมงานหรือรับปากว่าจะจอง/ล็อกให้ เปลี่ยนเป็นให้ข้อมูลและชวนตัดสินใจ`,
  H8: () => "ข้อความที่มีราคาต้องมั่นใจ ตัดคำขอโทษหรือคำว่าขอแก้ไขออก",
  H9: (v) => `มีคำหรือตัวเลขที่ด่านตรวจไม่ผ่าน (${v.detail}) เปลี่ยนเป็นคำที่จริงและวัดได้`,
  H10: (v) => `ประโยค "${v.sentence}" รับปากว่าจะแจ้งกลับหรือจดชื่อไว้ แต่ไม่มีระบบแจ้งเตือนรอบใหม่ ตัดออก แล้วชวนบอกช่วงวันที่สะดวกแทน`,
  H11: (v, ctx) => `ประโยค "${v.sentence}" บอกลูกค้าว่ายืนยันไม่ได้หรือไม่มีข้อมูล แต่ลูกแพรมีข้อมูลเรื่องนี้อยู่แล้ว `
    + "(ชื่อคลาสทั้งสอง รูปแบบเรียนสด สถานที่ สิ่งที่รวมในค่าเรียน หัวข้อที่สอน ใบประกาศนียบัตรเมื่อเรียนจบ และรอบที่เปิด) "
    + "เขียนประโยคนั้นใหม่ให้ตอบจากข้อมูลธุรกิจที่อนุมัติในเทิร์นนี้อย่างอบอุ่นและมั่นใจ ถ้ารายละเอียดบางส่วนไม่อยู่ในข้อมูล เล่าส่วนที่มีแล้วชวนคุยต่อ "
    + "โดยไม่ใช้คำว่ายืนยันไม่ได้หรือไม่มีข้อมูล และไม่เติมรายละเอียดที่ข้อมูลไม่ได้บอก"
    // รอบ 2: บอกว่ายังไม่มีรอบ/รอบยังไม่ประกาศ ทั้งที่มีรอบเปิด = บอกรอบจริงแทน (ยังไม่รู้คลาส = รอบแยกตามคลาสในข้อเท็จจริง ไม่รวมเป็นชุดเดียว)
    + (v.rounds ? (ctx.classKnown === false
      ? " รอบที่เปิดแยกตามคลาสอยู่ในข้อเท็จจริงของเทิร์นนี้ บอกรอบจริงจากตรงนั้นแทนการบอกว่ายังไม่มีรอบ"
      : ` รอบที่เปิดตอนนี้คือ ${(ctx.roundLabels || []).join(" · ")} บอกรอบเหล่านี้แทนการบอกว่ายังไม่มีรอบ`) : "")
    // จังหวะขอพื้นฐานก่อนราคา: ราคาไม่ได้หาย แค่มาต่อหลังลูกค้าตอบ — บอกแบบนั้นแทนคำว่ายืนยันไม่ได้
    + (ctx.stage === "SCREEN_PRICE" ? " เทิร์นนี้ยังไม่บอกตัวเลขค่าเรียน ให้เล่าว่าคลาสนี้ได้อะไรและคุ้มยังไงแทน โดยไม่ตั้งเงื่อนไขว่าต้องตอบก่อนถึงจะได้รู้ราคา" : ""),
  // จังหวะจบที่ {{บันได}}: คำถามระดับอยู่ในช่องแล้ว — ถามเองเพิ่ม = ลูกค้าได้สองคำถาม
  S1: (v, ctx) => (v.slot ? "ไม่ต้องถามคำถามเอง ช่อง {{บันได}} มีคำถามระดับครบแล้ว ตัดคำถามที่พิมพ์เองออก แล้วจบที่ {{บันได}}"
    : `ปิดท้ายด้วยคำถามเดียวที่ตอบง่าย มีตัวเลือก 2–4 อย่างจากเรื่องของลูกค้า${avoidSuffix(ctx)}`),
  S2: () => "คำถามปิดท้ายยังกว้างไป เติมตัวเลือก 2–4 อย่างจากงานของลูกค้า",
  // ลูกค้ายังไม่ตอบข้อเสนอรอบ (เคสจริง 5 ต.ค.) = ห้ามแนะนำให้ชวนดูรอบซ้ำในบันทึกซ่อม
  // รีวิวเคสจริง 5 ต.ค.: ลูกค้าเลือกรอบแล้ว = บันทึกซ่อมชวนก้าวสมัคร ไม่ใช่ชวนเลือกรอบอีก
  S3: (v, ctx) => (pickedRound(ctx) ? `ลูกค้าเลือกรอบแล้ว ปิดด้วยก้าวสมัครหนึ่งข้อ เช่น ${NEXT_STEP_LINES.booking}${v.phrase ? ` และตัดประโยค "${v.phrase}"` : ""}`
    : avoidsRounds(ctx)
    ? `ปิดด้วยคำถามเปิดหนึ่งข้อที่พาไปต่อ${avoidSuffix(ctx)}${v.phrase ? ` และตัดประโยค "${v.phrase}"` : ""}`
    : `ลูกค้ากำลังสนใจจริง ปิดด้วยก้าวถัดไปที่ชัด เช่น ${(ctx.roundLabels || []).length >= 2 && ctx.classKnown !== false
      ? `ชวนเลือกรอบ ${ctx.roundLabels[0]} หรือ ${ctx.roundLabels[1]} หรือ` : ""}ชวนแบบถ่อมตัวว่า "ไม่ทราบว่า${politeNameOf(ctx) || "คุณ(ชื่อ) "}สนใจให้ลูกแพรส่งรอบเรียนที่เปิดอยู่ให้ดูไหมคะ ลูกแพรส่งให้ค่ะ"${v.phrase ? ` และตัดประโยค "${v.phrase}"` : ""}`),
  S4: (v, ctx) => `เอ่ยชื่อคลาส ${ctx.className || CLASS_NAMES.business} พร้อมเหตุผลที่ผูกกับงานของลูกค้า`,
  S5: (v, ctx) => (pickedRound(ctx) ? `เปลี่ยน "${v.phrase}" เป็นข้อเสนอแบบถามความสนใจ เช่น ${NEXT_STEP_LINES.booking}`
    : avoidsRounds(ctx) ? `ตัด "${v.phrase}" แล้วปิดด้วยประโยคที่ไม่เร่งตัดสินใจ`
    : `เปลี่ยน "${v.phrase}" เป็นข้อเสนอแบบถามความสนใจ เช่น "ไม่ทราบว่าคุณ(ชื่อ) สนใจดูรอบเรียนที่เปิดอยู่ไหมคะ ลูกแพรส่งให้ค่ะ"`),
  S6: (v, ctx) => `ยาว/สั้นไป (${v.n} ตัวอักษร) ปรับให้อยู่ราว ${ctx.band?.[0]}–${ctx.band?.[1]} ตัวอักษร คงปฏิกิริยา คำของลูกค้า ผลลัพธ์ และคำถามปิดท้าย`,
  S7: (v) => `เลี่ยงประโยค "${v.phrase}" ใช้ผลลัพธ์ที่จับต้องได้จากงานของลูกค้าแทน`,
  // ไม่ยกตัวอย่างคำของลูกค้าในข้อความสั่งแก้ — เคยทำให้โมเดลยกคำพิมพ์ผิดของลูกค้ามาครอบเครื่องหมายคำพูด
  S8: () => "พูดถึงเรื่องที่ลูกค้าเล่าต่ออีกนิด เช่น ระดับ เครื่องมือ หรืองานของเขา ด้วยภาษาของลูกแพร ไม่ยกคำพิมพ์ของเขามาทั้งคำ",
  S9: () => "เล่าถึงสิ่งที่ลูกค้าพูดด้วยภาษาของลูกแพร ไม่ยกคำพิมพ์ของเขามาใส่เครื่องหมายคำพูด",
  S10: () => "ลูกค้าถามมาในข้อความนี้ ตอบคำถามนั้นให้ตรงหนึ่งถึงสองประโยคจากข้อมูลที่มี ก่อนขอทราบพื้นฐาน",
  S11: (v, ctx) => (!ctx.classKnown || ctx.bothClassCards
    ? "หลังแจ้งราคาแล้ว ไม่ถามเรื่องงาน ระดับ หรือเคยสร้าง AI เองหรือยัง ปิดด้วยคำถามเดียวว่าสนใจคลาสไหน เช่น \"สนใจคลาสไหนคะ หรืออยากให้ลูกแพรช่วยเลือกให้เหมาะกับงานคะ?\""
    : `หลังแจ้งราคาแล้ว ไม่ถามเรื่องงานหรือระดับซ้ำ ปิดด้วยก้าวถัดไปหนึ่งข้อ เช่น ${(ctx.roundLabels || []).length >= 2 && !avoidsRounds(ctx)
      ? `ชวนเลือกรอบ ${ctx.roundLabels[0]} หรือ ${ctx.roundLabels[1]} หรือ` : ""}เสนอส่งรีวิวจากผู้เรียนที่ทำงานคล้ายกันแบบถ่อมตัว ("ไม่ทราบว่า${politeNameOf(ctx) || "คุณ(ชื่อ) "}สนใจให้ลูกแพรส่งรีวิวจากผู้เรียนที่ทำงานคล้ายกันไหมคะ ลูกแพรส่งให้ค่ะ") · ไม่ถามว่าติดเรื่องไหน ลังเลอะไร หรือติดเรื่องค่าเรียน`),
  S12: () => "ลูกค้าขอรายละเอียดคลาส ต่อจากคำทักทายให้ข้อมูลจริง 2–3 ประโยคก่อนช่อง {{บันได}}: เรียนสด 1 วัน 10:00–17:00 น. ได้ลงมือทำ Workshop กับงานจริงของตัวเอง มีทีม TA ช่วย และทบทวนผ่านคลาสออนไลน์ได้ (ไม่บอกตัวเลขค่าเรียน)",
  S13: () => "ถามคำถามคัดกรองข้อเดียวพอ ตัดคำถามหรือประโยคชวนให้ตอบที่เกินมาออก",
  SLOT_INLINE: (v) => `วางช่องเติม {{${v.slot}}} ไว้บรรทัดของมันเอง`,
});

// ข้อเสนอรอบใช้ไม่ได้เทิร์นนี้: ลูกค้ายังไม่ตอบข้อเสนอรอบ หรือเพิ่งเล่าว่าเงินตึง/ต้องยืมเงิน (ยกเว้นเขาบอกเองว่าจะสมัคร)
function avoidsRounds(ctx = {}) {
  const decision = ctx.decision || {};
  return avoidTypesOf(decision).has("rounds") || ((decision.modifiers || []).includes("money_hardship") && !decision.enroll);
}
const pickedRound = (ctx = {}) => ctx.decision?.logistics === "booking" || ctx.decision?.roundPick === true;
const avoidSuffix = (ctx = {}) => ((ctx.decision?.avoid || []).length ? " ที่ไม่ซ้ำกับที่ลูกแพรถามหรือเสนอไปแล้ว" : "");

export function repairNote(result, ctx = {}) {
  const seen = new Set();
  const lines = [];
  for (const item of [...(result.hard || []), ...(result.soft || [])]) {
    const line = REPAIR_LINES[item.id]?.(item, ctx);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(`- ${line}`);
  }
  const format = ctx.outputFormat === "reply_only" ? "ส่งเฉพาะข้อความถึงลูกค้า" : "ในรูปแบบ <plan>…</plan><reply>…</reply>";
  return ["[ตรวจคุณภาพจากระบบ — ไม่ใช่ข้อความลูกค้า]",
    `ร่างก่อนหน้ายังไม่ผ่านข้อต่อไปนี้ แก้เฉพาะจุดเหล่านี้ ส่วนที่ดีอยู่แล้วให้คงไว้ แล้วส่งคำตอบใหม่ทั้งข้อความ${format}`,
    ...lines].join("\n");
}
