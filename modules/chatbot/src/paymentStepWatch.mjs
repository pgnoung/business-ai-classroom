// paymentStepWatch.mjs — ตัวเฝ้าขั้นชำระเงิน (audit ลูกแพร 18 ต.ค. 2026)
//
// เหตุจริง: บล็อกบัญชีจาก AI หายไปตั้งแต่ 27 ก.ย. นาน 3 สัปดาห์โดยไม่มีอะไรเตือน — มีคนรู้เพราะ audit ไล่นับเอง
// ตัวเฝ้านี้ดูผลลัพธ์ปลายทาง ไม่ดูว่าโค้ดเส้นไหนทำงาน: ย้อน 48 ชม. มีห้องที่ลูกค้าตอบประเภทเอกสารแล้ว
// แต่ระบบบันทึกว่าส่งบัญชี 0 ครั้ง และยังมีห้องที่ไม่มีใครส่งบัญชีให้เลย = แจ้งเจ้าของ (เว้น 48 ชม. ก่อนเตือนซ้ำ — เตือนทุกวันคือวิธีทำให้คนเลิกอ่าน)
// เกาะรอบ retention รายวัน (แบบ roundsWatch) ไม่สร้าง timer ใหม่ · ไม่ทักลูกค้า ไม่แตะสถานะห้อง

import { botAskedDocType, classifyDocTypeAnswer } from "./paymentStep.mjs";
import { paymentInstructionsIndex } from "./salesDecisionGuard.mjs";

export const PAYMENT_WATCH_KEY = "payment_step_watch_last_at";
export const PAYMENT_WATCH_WINDOW_MS = 48 * 3_600_000;
export const PAYMENT_WATCH_COOLDOWN_MS = 48 * 3_600_000;
const NAMES_SHOWN = 5;

/** คำตอบประเภทเอกสารของลูกค้า = ข้อความขาเข้าชุดแรกที่ตามหลังคำถามนั้นทันที */
export function answeredRoomFromThread({ ask, after = [] } = {}) {
  if (!botAskedDocType([{ role: "assistant", content: String(ask?.content || "") }])) return null;
  const reply = [];
  let index = 0;
  while (index < after.length && after[index].direction === "out") index += 1; // ก้อนเดียวกันของร้าน
  for (; index < after.length && after[index].direction === "in"; index += 1) reply.push(after[index]);
  if (!reply.length) return null;
  const docType = classifyDocTypeAnswer(reply.map((row) => String(row.content || "")).join("\n"));
  if (!docType) return null;
  const answeredAt = Number(reply.at(-1).created_at) || 0;
  const delivered = after.some((row) => row.direction === "out" && Number(row.created_at) >= answeredAt
    && paymentInstructionsIndex(String(row.content || "")) >= 0);
  return { customerId: String(ask.customer_id), name: String(ask.known_name || ask.display_name || "").trim(), docType, answeredAt, delivered };
}

/** ตัดสินล้วน: เตือนเมื่อมีห้องตอบแล้ว ≥ 1 และระบบส่งบัญชี 0 ครั้งในหน้าต่าง และพ้นช่วงพักเตือน */
export function decidePaymentStepAlert({ rooms = [], sends = 0, lastWarnAt = 0, now = Date.now() } = {}) {
  const answered = rooms.filter(Boolean);
  if (!answered.length) return { warn: false, reason: "no_answers" };
  if (sends > 0) return { warn: false, reason: "bank_sent_in_window", answered: answered.length, sends };
  if (now - (Number(lastWarnAt) || 0) < PAYMENT_WATCH_COOLDOWN_MS) return { warn: false, reason: "cooldown", answered: answered.length };
  const waiting = answered.filter((room) => !room.delivered);
  // ทีมส่งบัญชีให้ครบทุกห้องแล้ว = ลูกค้าไม่ได้ค้าง (ตัวประกอบอาจตั้งใจส่งให้คนทำ เช่น ใบเสนอราคา/หลายที่นั่ง) — ไม่เตือน
  if (!waiting.length) return { warn: false, reason: "all_rooms_served", answered: answered.length };
  const names = waiting.map((room) => room.name).filter(Boolean).slice(0, NAMES_SHOWN);
  const text = `ขั้นชำระเงินของลูกแพรอาจหยุดทำงาน — 48 ชม. ที่ผ่านมามีลูกค้าตอบเรื่องออกเอกสารแล้ว ${answered.length} ห้อง `
    + `แต่ระบบส่งช่องทางชำระ 0 ครั้ง (ยังไม่มีใครส่งบัญชีให้ ${waiting.length} ห้อง${names.length ? `: ${names.join(", ")}` : ""}) `
    + "รบกวนทีมส่งสรุปค่าเรียนและบัญชีให้ห้องที่ค้าง และให้คนดูแลระบบตรวจตัวประกอบข้อความชำระเงินค่ะ";
  return { warn: true, text, answered: answered.length, waiting: waiting.length };
}

export function checkPaymentStepAndWarn({ db, notifier = null, logger = console, now = Date.now, enabled = true } = {}) {
  // เฝ้าเฉพาะธุรกิจที่เปิดด่านเงิน (ลูกแพร) และไม่ได้ปิดตัวประกอบไว้ — ธุรกิจอื่นไม่มีขั้นนี้
  if (enabled !== true) return { skipped: "disabled" };
  if (typeof db?.listDocTypeAskCandidates !== "function") return { skipped: "no_db_support" };
  try { if (String(db.getSetting?.("payment_step_composer") || "").trim().toLowerCase() === "off") return { skipped: "composer_off" }; } catch { /* อ่านไม่ได้ = เฝ้าต่อ */ }
  const t = now();
  const since = t - PAYMENT_WATCH_WINDOW_MS;
  // คำถามอาจออกก่อนหน้าต่างหนึ่งวัน แต่ลูกค้ามาตอบในหน้าต่าง — นับที่เวลาคำตอบ
  const seen = new Set();
  const rooms = [];
  for (const ask of db.listDocTypeAskCandidates(since - 24 * 3_600_000)) {
    if (Number(ask.created_at) > t || seen.has(String(ask.customer_id))) continue; // นาฬิกาที่ฉีดเข้ามา (เทสต์/จำลอง) ห้ามเห็นอนาคต
    if (!botAskedDocType([{ role: "assistant", content: String(ask.content || "") }])) continue;
    const after = db.listMessagesAfter(ask.customer_id, ask.created_at, 40).filter((row) => Number(row.created_at) <= t);
    const room = answeredRoomFromThread({ ask, after });
    // ห้องที่ได้บัญชีไปก่อนแล้ว (เช่น ทีมถามชื่อออกใบเสร็จหลังลูกค้าโอน) ไม่ใช่ห้องค้าง
    if (room && !room.delivered && db.paymentDeliveredEvidence?.(room.customerId, t) === true) room.delivered = true;
    if (!room || room.answeredAt < since || seen.has(room.customerId)) continue;
    seen.add(room.customerId);
    rooms.push(room);
  }
  const sends = db.countBankSentSince(since, t);
  let lastWarnAt = 0;
  try { lastWarnAt = Number(db.getSetting(PAYMENT_WATCH_KEY)) || 0; } catch { lastWarnAt = 0; }
  const decision = decidePaymentStepAlert({ rooms, sends, lastWarnAt, now: t });
  if (!decision.warn) return { ok: true, warned: false, reason: decision.reason, answered: rooms.length, sends };
  logger.warn?.(`[paymentStepWatch] ${decision.text}`);
  try {
    db.setSetting(PAYMENT_WATCH_KEY, String(t));
    db.addAudit({ operator: "system", action: "payment_step_stalled", target: "ops:payment_step",
      detail: `answered=${decision.answered} waiting=${decision.waiting} sends=0 window=48h` });
  } catch (err) {
    logger.debug?.(`paymentStepWatch: บันทึกเวลาเตือนไม่สำเร็จ (${err?.message || err})`);
  }
  // force: cooldown ของตัวแจ้งเตือนผูกกับ "ลูกค้า" ส่วนงานนี้เป็นเรื่อง ops ที่เว้นช่วงเองอยู่แล้ว (แบบ roundsWatch)
  notifier?.fireLater?.({ customerId: "ops:payment_step", channelId: "default", reason: "payment_step_stalled",
    reasonTextOverride: decision.text, force: true });
  return { ok: true, warned: true, answered: decision.answered, waiting: decision.waiting, sends };
}
