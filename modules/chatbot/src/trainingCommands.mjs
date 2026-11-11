// trainingCommands.mjs — narrow, local-only controls for the Training OA.
// Commands are deliberately exact: ordinary customer words must never trigger
// a destructive-looking session rotation.
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
export const TRAINING_RESET_ACK = "บันทึกบทสนทนาสำหรับเทรนแล้ว เริ่มคุยใหม่ได้เลยค่ะ";

const OUTER_IGNORABLE = /^[\s\u200B\u200C\u200D\uFEFF]+|[\s\u200B\u200C\u200D\uFEFF]+$/gu;

export function normalizeTrainingCommand(value) {
  return String(value ?? "").replace(OUTER_IGNORABLE, "");
}

// v1.2.6: ผู้ทดสอบพิมพ์ความเห็นต่อท้ายได้เลย ("/reset ตอบช้าไป ไม่เรียกชื่อ")
// ยังคงกติกาเดิมว่าต้องขึ้นต้นด้วยเครื่องหมาย / เท่านั้น คำพูดปกติของลูกค้าจึงไม่มีทางยิงโดน
const RESET_COMMAND = /^\/reset(?:\s+([\s\S]*))?$/iu;
const FEEDBACK_COMMAND = /^\/(?:fb|feedback)(?:\s+([\s\S]*))?$/iu;
export const MAX_FEEDBACK_CHARS = 2000;
export const TRAINING_FEEDBACK_ACK = "บันทึก feedback ไว้ให้แล้วค่ะ คุยต่อได้เลย";
export const TRAINING_FEEDBACK_EMPTY_ACK = "พิมพ์ feedback ต่อท้ายได้เลยค่ะ เช่น /fb ตอบช้าไป";
// ต่างจากข้อความข้างบนโดยตั้งใจ — ผู้ทดสอบต้องรู้ว่าความเห็นหาย ไม่ใช่คิดว่าตัวเองพิมพ์ไม่ครบ
export const TRAINING_FEEDBACK_FAILED_ACK = "ระบบบันทึก feedback ไม่สำเร็จค่ะ รบกวนส่งใหม่อีกครั้งนะคะ";
export const TRAINING_RESET_ACK_WITH_FEEDBACK = "บันทึกบทสนทนาและ feedback สำหรับเทรนแล้ว เริ่มคุยใหม่ได้เลยค่ะ";

function boundedFeedback(raw) {
  return normalizeTrainingCommand(raw || "").slice(0, MAX_FEEDBACK_CHARS);
}

export function parseTrainingResetCommand(value) {
  const match = RESET_COMMAND.exec(normalizeTrainingCommand(value));
  if (!match) return { isReset: false, feedback: "" };
  return { isReset: true, feedback: boundedFeedback(match[1]) };
}

export function parseTrainingFeedbackCommand(value) {
  const match = FEEDBACK_COMMAND.exec(normalizeTrainingCommand(value));
  if (!match) return { isFeedback: false, feedback: "" };
  return { isFeedback: true, feedback: boundedFeedback(match[1]) };
}

export function isTrainingResetCommand(value) {
  return parseTrainingResetCommand(value).isReset;
}

export function isTrainingFeedbackCommand(value) {
  return parseTrainingFeedbackCommand(value).isFeedback;
}

// The server calls this only from the same per-customer critical section that
// owns ordinary drafts through LINE delivery. The DB method atomically commits
// event dedupe + candidate snapshot + session rotation.
export function prepareTrainingResetCommand({ db, channelId, customerId, dedupeKey, feedback = "" }) {
  const result = db.rotateTrainingSession({ customerId, channelId, resetEventId: dedupeKey, feedback });
  // R3(d) (คำสั่งพี่ง้วง 2026-09-05): /reset = เริ่มบทสนทนาใหม่ ใบ้ส่งไม้ต่อของรอบก่อน
  // ต้องมองไม่เห็น การหมุน session ทำงานนี้ให้อยู่แล้ว (ตัวอ่านใบ้ผูกกับ session ที่ใช้งานอยู่)
  // แต่ปักหมุดเวลาไว้ด้วยเพื่อให้ข้อกำหนดนี้เป็นจริงโดยไม่ต้องพึ่งรายละเอียดของอีกโมดูล
  try {
    db.setSetting(`handoff_hint_reset:${customerId}`, String(Date.now()));
  } catch { /* หมุดเป็นของแถม — ห้ามทำให้ /reset ล้ม */ }
  return result;
}

function acknowledgementDetail(result) {
  if (result?.ok) return "line_acknowledged";
  if (!result?.blocked && (result?.ambiguous || result?.status === 0 || Number(result?.status) >= 500)) {
    return `ambiguous_status_${Number(result?.status) || 0}`;
  }
  return `failed_status_${Number(result?.status) || 0}`;
}

// An acknowledgement is never retried automatically.  Mark it ambiguous before
// making the provider call so a crash/timeout cannot become an unsafe duplicate.
export async function deliverTrainingResetAcknowledgement({ db, lineRegistry, channelId, customerId, event, rotation }) {
  if (rotation?.idempotent) return { ...rotation, sent: false, reason: "already_rotated" };
  const ackText = rotation?.feedbackSaved ? TRAINING_RESET_ACK_WITH_FEEDBACK : TRAINING_RESET_ACK;
  const candidateId = rotation?.candidate?.id;
  if (!candidateId) throw new Error("training reset rotation has no candidate");
  const claimed = db.setTrainingCandidateAck(candidateId, {
    status: "ambiguous", detail: `attempt_started:${Date.now()}`,
  });
  // Owner resolution is a no-send terminal decision. If it won the race before
  // this queued delivery claimed the row, never cross the provider boundary.
  if (claimed?.ack_resolved_at) {
    return { ...rotation, sent: false, reason: "owner_resolved_without_send" };
  }
  let sent;
  try {
    const line = lineRegistry.forChannel(channelId);
    sent = await line.sendBubbles({
      to: event?.source?.userId || "",
      replyToken: event?.replyToken || "",
      bubbles: [{ text: ackText }],
      images: [],
      purpose: SEND_PURPOSE.other, // ตอบรับโหมดเทรน (ผู้ทดสอบ ไม่ใช่ลูกค้า)
    });
  } catch (error) {
    db.setTrainingCandidateAck(candidateId, { status: "ambiguous", detail: "transport_exception" });
    db.addAudit({ operator: "system", action: "training_reset_ack", target: String(candidateId), detail: "ambiguous transport_exception" });
    return { ...rotation, sent: false, send: { ok: false, ambiguous: true, status: 0 } };
  }
  const status = sent?.ok ? "sent" : (!sent?.blocked && (sent?.ambiguous || sent?.status === 0 || Number(sent?.status) >= 500) ? "ambiguous" : "failed");
  const detail = acknowledgementDetail(sent);
  db.setTrainingCandidateAck(candidateId, { status, detail });
  db.addAudit({ operator: "system", action: "training_reset_ack", target: String(candidateId), detail: `${status} ${detail}` });
  if (sent?.ok) {
    db.insertMessage({
      id: `control:training-reset:${String(rotation.candidate.reset_event_id)}`,
      customerId,
      direction: "out",
      msgType: "system",
      content: ackText,
      messageClass: "reactive",
      operator: "system",
      channelId,
      sessionId: rotation.session?.id,
    });
  }
  return { ...rotation, sent: sent?.ok === true, send: sent };
}
