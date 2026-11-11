// needsPersonReason.mjs — "ห้องนี้ต้องใช้คนจริงไหม และเพราะอะไร"
//
// คำสั่งเจ้าของ 2026-09-02 (หลังเปิดใช้ SLA วันแรก): push แจ้งทีมเสียเงินจริงต่อข้อความ
// จึงต้องแยกให้ขาดระหว่าง "ห้องที่อยู่ในคิวรอคน" (เห็นบนคอนโซล ไม่เสียเงิน) กับ
// "ห้องที่ต้องใช้คนจริง ๆ" (ยอมจ่ายค่า push) — ไฟล์นี้คือคำตอบข้อหลังที่เดียว
//
// อยู่แยกเป็นโมดูลใบเพราะมีสองฝั่งต้องใช้ค่าเดียวกัน: ตัวกรองใน SQL (dbExtra.mjs)
// และตรรกะตัดสินตอนเลือกห้องจะทวง (needsHumanSla.mjs) — คนละสำเนากันเมื่อไหร่
// คือวันที่ระบบอ่านห้องมาแล้วทิ้งทั้งหมด หรือ push ห้องที่เจ้าของสั่งว่าไม่ต้อง push
// เหตุที่ "ต้องใช้คน" จริง ๆ = เหตุเดียวที่ยอมจ่ายค่า push (คำสั่งเจ้าของ 2026-09-02)
export const NEEDS_HUMAN_SLA_PERSON_REASONS = Object.freeze([
  "complaint",
  "optout",
  "human_requested",
  // คำสั่งพี่ง้วง 2026-09-05: ห้องที่ลูกค้าจอง/สมัครแล้ว = ยอมจ่ายค่า push เสมอ
  // (คนรอที่นั่งอยู่ ยิ่งช้ายิ่งเสียดีลจริง ไม่ใช่แค่เสียความรู้สึก)
  "booking_handoff",
  "handoff_private_inhouse",
  "opportunity_handoff",
  "urgent_mental",
  // 2026-10-15 (พี่ง้วง): เจ้าของ/แอดมินกด "ส่งต่อแอดมิน" จากปุ่ม YOLO = คนตัดสินแล้วว่าห้องนี้ต้องใช้คน
  "owner_handoff",
]);
const PERSON = new Set(NEEDS_HUMAN_SLA_PERSON_REASONS);

const PERSON_REASON_TEXT = Object.freeze({
  complaint: "ลูกค้าร้องเรียน/ไม่พอใจ",
  optout: "ลูกค้าขอให้หยุดทัก",
  human_requested: "ลูกค้าขอคุยกับคนจริง",
  booking_handoff: "ลูกค้าขอจอง/สมัคร — รอทีมงานยืนยันที่นั่ง",
  handoff_private_inhouse: "งาน private class / in-house ที่ทีมรับช่วงเอง",
  opportunity_handoff: "ข้อมูลงานครบตาม policy แล้ว รอทีมรับช่วง",
  urgent_mental: "พบสัญญาณวิกฤตสุขภาพจิต — ต้องมีคนดูแลทันที",
  owner_handoff: "ถูกส่งต่อให้แอดมินจากปุ่ม YOLO",
});

// setNeedsHuman ต่อท้าย handoff_summary เป็นบรรทัด "[ISO] <reason>: <สรุป>" (db.mjs:472)
// จึงอ่านเหตุจาก token หัวบรรทัด ไม่ใช่สตริงย่อย กันคำในสรุปของคนทำให้เข้าใจผิด
const HANDOFF_REASON_LINE = /\[[^\]]{0,40}\]\s*([a-z][a-z0-9_]*)/giu;

export function handoffPersonReason(summary) {
  const text = String(summary ?? "");
  if (!text) return null;
  let matched = null;
  for (const m of text.matchAll(HANDOFF_REASON_LINE)) {
    if (PERSON.has(m[1])) matched = m[1]; // เอาเหตุล่าสุดที่ต้องใช้คนเป็นคำตอบ
  }
  if (matched) return matched;
  // สรุปรูปแบบเก่า/ที่ถูกตัดหัวทิ้ง — ถอยไปเทียบแบบเดียวกับ escalate() ใน pipeline.mjs
  return NEEDS_HUMAN_SLA_PERSON_REASONS.find((reason) => text.includes(reason)) ?? null;
}

/**
 * ห้องนี้ "ต้องใช้คน" ด้วยเหตุอะไร — คืน token ของเหตุ หรือ null ถ้าไม่เข้าข่าย push
 * AI ปิดถาวร: อ่านจาก ai_off_reason · NEEDS_HUMAN: อ่านจาก handoff_summary
 */
export function needsPersonReason(row) {
  if (!row) return null;
  const offReason = String(row.ai_off_reason ?? "").trim();
  if (Number(row.ai_enabled) !== 1 && PERSON.has(offReason)) return offReason;
  if (String(row.state ?? "") === "NEEDS_HUMAN") return handoffPersonReason(row.handoff_summary);
  return null;
}


// F9 (ตรวจย้อนหลัง ก.ย. 2026): เหตุ "ต้องใช้คน" ถูกยกขึ้นเมื่อไร — เวลาของบรรทัดล่าสุดใน handoff_summary
// ที่เป็นเหตุนั้น (ms) หรือ 0 ถ้าหาไม่เจอ (เช่น optout ที่ปิด AI โดยไม่มีบรรทัดส่งต่อ) — 0 = ใช้กติกาเดิม
const HANDOFF_REASON_LINE_AT = /\[([^\]]{10,40})\]\s*([a-z][a-z0-9_]*)/giu;
export function personReasonRaisedAt(row, reason) {
  const wanted = String(reason ?? "");
  if (!wanted) return 0;
  let latest = 0;
  for (const m of String(row?.handoff_summary ?? "").matchAll(HANDOFF_REASON_LINE_AT)) {
    if (m[2] !== wanted) continue;
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}

// F11 (ตรวจย้อนหลัง ก.ย. 2026): เหตุทุกบรรทัดที่ถูกยกตั้งแต่ sinceMs (รวม) — ใช้ตัดสินว่าธงรอคนตอนนี้
// เป็นของเหตุเดียวล้วน ๆ ไหม (เช่น สมองล่ม) ก่อนปลดอัตโนมัติ · บรรทัดที่อ่านเวลาไม่ออกไม่นับ
export function handoffReasonsSince(summary, sinceMs) {
  const since = Number(sinceMs) || 0;
  const reasons = [];
  for (const m of String(summary ?? "").matchAll(HANDOFF_REASON_LINE_AT)) {
    const at = Date.parse(m[1]);
    if (Number.isFinite(at) && at >= since) reasons.push(m[2]);
  }
  return reasons;
}

export function personReasonLabel(reason) {
  return PERSON_REASON_TEXT[String(reason ?? "")] || "ต้องมีคนเข้าไปดูแล";
}
