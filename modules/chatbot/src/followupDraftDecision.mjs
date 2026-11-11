// A follow-up model has two valid outcomes: customer-facing copy or an explicit
// control decision to stay silent. Keep that decision out of customer channels.
export const FOLLOWUP_NO_SEND_PREFIX = "[[NO_SEND:";

export const FOLLOWUP_NO_SEND_REASONS = Object.freeze([
  "customer_pause",
  "conversation_resolved",
  "operator_takeover",
  "already_answered",
  "no_useful_followup",
  "internal_rationale",
]);

const REASON_SET = new Set(FOLLOWUP_NO_SEND_REASONS);
const SENTINEL = /^\[\[NO_SEND:([a-z_]+)\]\]$/u;
const INTERNAL_RATIONALE = [
  /^(?:ตอนนี้|จึง)?\s*(?:ควร|ควรจะ)(?:พัก|งด|หยุด)(?:การ)?(?:ทัก|ติดตาม|follow[ -]?up)/iu,
  /^(?:ตอนนี้|จึง)?\s*(?:ไม่ควร|ไม่ต้อง)(?:ส่ง(?:ข้อความ)?|ทัก|ติดตาม|follow[ -]?up)/iu,
  /^(?:งดส่ง|ข้ามการส่ง|ไม่ส่ง)(?:ข้อความ|การติดตาม|follow[ -]?up)/iu,
  /^(?:เหตุผล|decision|rationale)\s*:/iu,
  /(?:ลูกแพร|แอดมิน|ทีมงาน).{0,30}รับปาก.{0,20}(?:พัก|งด|หยุด)(?:การ)?(?:ทัก|ติดตาม)/iu,
  /^(?:should|do)\s+not\s+(?:send|follow[ -]?up)/iu,
  /^no[ -]?send\b/iu,
  // 2026-10-04 (Sonnet 5.5): เล่าการวิเคราะห์บทสนทนา/การทำตามกติกาออกมาก่อนตัวข้อความ — ทดสอบ 36 ร่าง หลุด 2
  // ("ลูกค้าบอกระดับ 4 … ข้อความนี้จึงชวนคุยต่อ … ได้เลยค่ะ ร่างข้อความนี้ค่ะ" · "ก่อนอื่นต้องดูว่าลูกค้าตอบอะไรมาบ้าง:")
  // จับแคบ ๆ: เปิดด้วยการเล่าถึงลูกค้าแบบบุคคลที่สาม · ป้ายตัวร่าง · อธิบายว่าข้อความทำตามกติกาอะไร
  /^(?:ก่อนอื่น(?:ต้อง)?(?:ดู|อ่าน)|ลูกค้า(?:บอก|ส่ง|ยังไม่|ตอบ|เล่า))/u,
  /(?:^|\n)\s*(?:ข้อความที่ร่าง|ร่างข้อความนี้|ข้อความที่จะส่ง)\s*(?:ค่ะ|ครับ)?\s*[:：]?\s*(?:\n|$)/u,
  /ข้อความนี้(?:จึง|จะ)(?:ชวน|ถาม|ทัก)|โดยไม่(?:ถามซ้ำ|พูดถึงราคา|ทวง)/u,
];

function inferInternalReason(text) {
  if (/(?:ขอพัก|อย่าเพิ่ง|ไม่ต้องทัก|ไม่ต้องติดตาม|พักการติดตาม|หยุดติดต่อ)/u.test(text)) {
    return "customer_pause";
  }
  if (/(?:แอดมิน|ทีมงาน|คนดูแล|operator)/iu.test(text)) return "operator_takeover";
  if (/(?:ตอบ(?:ไป)?แล้ว|เคยตอบ|ถามซ้ำ|answered)/iu.test(text)) return "already_answered";
  if (/(?:จบแล้ว|เรียบร้อยแล้ว|แก้ได้แล้ว|resolved)/iu.test(text)) return "conversation_resolved";
  return "internal_rationale";
}

export function parseFollowupDraftDecision(value) {
  const text = String(value ?? "").trim();
  const sentinel = text.match(SENTINEL);
  if (sentinel) {
    return { action: "skip", reason: REASON_SET.has(sentinel[1]) ? sentinel[1] : "internal_rationale" };
  }
  // A malformed or decorated control token is still control output. It must
  // never be treated as customer copy.
  if (/\[\[NO_SEND\b/iu.test(text)) return { action: "skip", reason: "internal_rationale" };
  if (INTERNAL_RATIONALE.some((pattern) => pattern.test(text))) {
    return { action: "skip", reason: inferInternalReason(text) };
  }
  return { action: "send", text };
}

export function followupDecisionInstructions() {
  return [
    "อ่านบทสนทนาจากเก่าไปใหม่ โดยสถานะล่าสุดที่เกิดจริงจากลูกค้า คำตอบ AI ที่ส่งแล้ว และข้อความล่าสุดที่แอดมินทีมงานพิมพ์เอง ชนะโน้ต/ผลวิเคราะห์เก่าเสมอ",
    "คำถามที่ลูกค้าตอบแล้ว หรือแอดมินสรุป/แก้ไขแล้ว ห้ามเปิดถามซ้ำ แม้โน้ตหรือผลวิเคราะห์เก่ายังขอให้ถามเรื่องนั้น",
    "ถ้าลูกค้าแสดงความรำคาญ ขอพัก/หยุดการติดตาม บทสนทนาจบแล้ว แอดมินรับช่วง หรือไม่มีข้อความที่มีประโยชน์ให้ส่ง: ห้ามอธิบายเหตุผลเป็นข้อความลูกค้า",
    "กรณีไม่ควรส่ง ให้ตอบเพียง token เดียวตามรูปแบบ [[NO_SEND:<reason>]] โดย reason ต้องเป็น customer_pause, conversation_resolved, operator_takeover, already_answered หรือ no_useful_followup",
  ].join("\n");
}
