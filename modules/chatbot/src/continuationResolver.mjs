// continuationResolver.mjs — LuKprae training F2 (handoff 2026-08-12):
// คำรับสั้น ("ครับ", "โอเค", "ได้ค่ะ") ต้องถูกอ่าน "เทียบกับข้อเสนอที่ค้างอยู่"
// ของเทิร์นผู้ช่วยก่อนหน้า — ไม่ใช่ query ว่างเปล่าที่ทำให้ retrieval ไม่ได้การ์ดอะไรเลย
// แล้ว Sol ตกไปตอบ "ต้องให้ทีมยืนยัน" ทั้งที่ข้อมูลอนุมัติมีอยู่ (บั๊กจริง 2026-08-12)
//
// กติกาเหล็กจาก handoff:
// - pure function, bounded input/output — ห้าม derive ราคา/ตารางเวลา/ที่นั่ง/สิทธิ์การค้า
// - ห้าม copy ข้อความประวัติตามอำเภอใจเข้า system instruction: offerText มาจาก
//   "ประโยคข้อเสนอของผู้ช่วยเอง" เท่านั้น + ยุบ whitespace + จำกัด 140 ตัวอักษร
// - ความมั่นใจไม่พอ (ไม่มีข้อเสนอค้าง) = acknowledge_only — ห้ามเดา topic ใหม่
// - retrievalText ใช้ "เลือกการ์ดความรู้ที่อนุมัติแล้ว" เท่านั้น (brainPackSelector
//   fallbackQuery) — ไม่ถูกฉีดเป็นข้อเท็จจริงใน prompt
import { isShortAcknowledgement } from "./conversationStyle.mjs";
import { bubbleHasQuestion } from "./scoring.mjs";
import { PRICE_MENTION } from "./priceDirectives.mjs";
import { resolveReplyFocus } from "./conversationFocus.mjs";

const OFFER_TEXT_MAX = 140;
const RETRIEVAL_ASSISTANT_MAX = 300;
const RETRIEVAL_TOPIC_MAX = 200;
const SUBSTANTIVE_MIN_CHARS = 6;

// ข้อเสนอแบบบอกเล่า (ไม่มีเครื่องหมายคำถาม) เช่น "แพรเสนอว่าจะสรุปให้ค่ะ",
// "เดี๋ยวส่งรายละเอียดให้นะคะ" — ลูกค้าตอบ "ครับ" ก็คือรับข้อเสนอเหมือนกัน
const OFFER_STATEMENT = /(?:เสนอว่า|เดี๋ยว[^\s]{0,12}ให้|จะ(?:สรุป|ส่ง|จัด|ทำ|เล่า|แนะนำ)[^\s]{0,12}ให้)/u;

function hasPendingOffer(text) {
  return bubbleHasQuestion(text) || OFFER_STATEMENT.test(String(text || ""));
}

const clean = (value) => String(value || "").replace(/["\n\r]+/gu, " ").replace(/\s+/gu, " ").trim();

// ประโยคข้อเสนอ = ประโยคเชิงถาม/ชวนล่าสุดในเทิร์นผู้ช่วย (แบ่งตามคำลงท้ายไทย)
function lastOfferSentence(text) {
  const sentences = String(text || "")
    .split(/(?<=(?:ค่ะ|นะคะ|ค่า|คะ|ครับ)[\s!?)]*)\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    if (hasPendingOffer(sentences[i])) return clean(sentences[i]);
  }
  return clean(sentences.at(-1) || "");
}

// คืน continuation hint หรือ null (= ไม่ใช่คำรับสั้น เส้นทางปกติทำงานเหมือนเดิมเป๊ะ)
// history = เทิร์นก่อนข้อความปัจจุบัน (historyBeforeCurrentInbound) เก่า -> ใหม่
export function resolveContinuation({ latestText = "", history = [] } = {}) {
  const focus = resolveReplyFocus({ text: latestText, history });
  if (focus) return { isShortAck: false, action: "answer_previous_question", retrievalText: focus.question, offerText: "", focus };
  if (!isShortAcknowledgement(latestText)) return null;
  const turns = Array.isArray(history) ? history : [];
  if (turns.at(-1)?.role === "user") return { isShortAck: true, action: "acknowledge_only", retrievalText: "", offerText: "" };

  // เทิร์นผู้ช่วยล่าสุด = ที่มาของ "ข้อเสนอที่ค้างอยู่"
  let assistantIndex = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === "assistant" && String(turns[i]?.content || "").trim()) {
      assistantIndex = i;
      break;
    }
  }
  if (assistantIndex < 0) {
    return { isShortAck: true, action: "acknowledge_only", retrievalText: "", offerText: "" };
  }
  const assistantText = String(turns[assistantIndex].content || "");

  // ผู้ช่วยไม่ได้เสนอ/ถามอะไรค้างไว้ = ลูกค้าแค่รับทราบ — จบอย่างอบอุ่น ห้ามเปิดเรื่องใหม่
  if (!hasPendingOffer(assistantText)) {
    return { isShortAck: true, action: "acknowledge_only", retrievalText: "", offerText: "" };
  }

  // หัวข้อจริงล่าสุดของลูกค้า (ก่อนเทิร์นผู้ช่วยนั้น) — ข้ามคำรับสั้น ๆ ของลูกค้าเอง
  let topicText = "";
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role !== "user") continue;
    const content = String(turn.content || "").trim();
    if ([...content].length >= SUBSTANTIVE_MIN_CHARS && !isShortAcknowledgement(content)) {
      topicText = content;
      break;
    }
  }

  const offer = lastOfferSentence(assistantText);
  return {
    isShortAck: true,
    action: "continue_previous_offer",
    retrievalText: [
      clean(assistantText).slice(0, RETRIEVAL_ASSISTANT_MAX),
      clean(topicText).slice(0, RETRIEVAL_TOPIC_MAX),
    ].filter(Boolean).join(" "),
    offerText: offer.slice(0, OFFER_TEXT_MAX),
    offerHasMoney: PRICE_MENTION.test(offer),
  };
}
