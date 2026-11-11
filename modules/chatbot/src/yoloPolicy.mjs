// yoloPolicy.mjs — กติกาของ YOLO แบบบริสุทธิ์ (ไม่แตะ DB/เครือข่าย) ให้เทสต์ไล่ครบทุกช่อง
//
// YOLO (คำสั่งพี่ง้วง 2026-09-28): "ให้ลูกแพรพิมพ์ต่อในห้องนี้ตอนนี้ 1 ครั้ง" — ทำงานได้แม้ AI
// ของห้องปิดอยู่/รอคน/ทีมเพิ่งตอบ และ "ไม่แตะสวิตช์ AI" เว้นแต่สั่งเปิดด้วย
//
// ผลตัดสินมีสามชั้น:
//   refusal = ไม่ส่งเด็ดขาด (บอกเหตุผล) — สิทธิ์ของลูกค้า/กติกา Meta/ความปลอดภัย/เพดาน
//   confirm = ต้องกดยืนยันก่อน (เส้นเงิน = งานของคน ตามกติกาเหล็กข้อ 4; ลูกค้าไม่พอใจ;
//             ลูกค้าบอกว่าขอคิดก่อน; YOLO ครั้งก่อนค้างผลกำกวม) — ยังไม่ร่าง ยังไม่เสียค่าโมเดล จนกว่าจะยืนยัน
//   warning = ส่งได้ แต่รายงานให้พี่ง้วงรู้ (ทีมเพิ่งตอบ, ช่วงดึก ฯลฯ)
import { paymentStartedFromRow } from "./pipeline.mjs";
import { paymentHoldActive, ladderFor } from "./stagedFollowups.mjs";
import { warmthBand } from "./conversationStyle.mjs";
import { inQuietHours } from "./followupEngine.mjs";
import { serviceFollowupPaused } from "./serviceBoundary.mjs";
import { FB_MESSAGING_WINDOW_MS } from "./db.mjs";
import { formatBangkokTime } from "./yoloText.mjs";

export const YOLO_ROOM_COOLDOWN_MS = 10 * 60_000;
export const YOLO_DAILY_SEND_CAP = 30;
// เพดานร่างต่อวัน (รวมร่างที่ถูกปฏิเสธ) — กันค่าโมเดลบานจากการสั่งซ้ำรัว ๆ ไม่ว่าจากช่องไหน
export const YOLO_DAILY_DRAFT_CAP = 60;
// Facebook: ต้องเหลือหน้าต่างอย่างน้อย 10 นาทีตอน "เริ่มร่าง" (ร่างกินเวลาได้เป็นนาที)
// ต่อจาก margin 5 นาทีที่ withinFacebookWindow กันไว้อยู่แล้ว — เช็คซ้ำด้วยเวลาจริงก่อนยิงอีกชั้น
export const YOLO_FB_DRAFT_MARGIN_MS = 10 * 60_000;
export const HUMAN_RECENT_MS = 30 * 60_000;
// ส่งค้างผลกำกวมเก่ากว่านี้ไม่ต้องถาม — ข้อความใหม่พ้นวันไปแล้วไม่ใช่ "ส่งซ้ำ" ในสายตาลูกค้า
export const YOLO_UNRESOLVED_LOOKBACK_MS = 24 * 3_600_000;
const FB_WINDOW_SHORT_MS = 2 * 3_600_000;

const TEXT = Object.freeze({
  unknown_customer: "ไม่พบห้องลูกค้านี้ในระบบ (อาจถูกลบข้อมูลตามคำขอแล้ว)",
  legacy_room: "ห้องนี้เป็นประวัติจาก LINE OA เดิม ส่งข้อความไม่ถึงลูกค้าค่ะ",
  do_not_disturb: "ลูกค้าขอไม่ให้รบกวน (DND) — ลูกแพรไม่ทักห้องนี้ค่ะ",
  opted_out: "ลูกค้าขอให้หยุดทักแล้ว — ลูกแพรไม่ส่งข้อความเชิงรุกค่ะ",
  urgent_mental: "ห้องนี้มีสัญญาณวิกฤตสุขภาพจิต ต้องให้คนดูแลเองเท่านั้นค่ะ",
  no_conversation: "ลูกค้ายังไม่เคยทักเข้ามา — YOLO ใช้คุยต่อในห้องที่เคยคุยกันเท่านั้นค่ะ",
  ai_paused: "ตอนนี้ลูกแพรถูกหยุดทั้งระบบอยู่ — เปิดระบบก่อนแล้วค่อยสั่งใหม่นะคะ",
  fb_window_closed: "ห้อง Facebook นี้ลูกค้าเงียบเกิน 24 ชม.แล้ว (กติกา Meta) — ส่งไม่ได้จนกว่าลูกค้าจะทักมาใหม่ค่ะ",
  in_flight: "กำลังส่ง YOLO ห้องนี้อยู่ รอสักครู่นะคะ",
  rate_limited_room: "ห้องนี้เพิ่งได้ YOLO ไปเมื่อไม่ถึง 10 นาที — เว้นจังหวะให้ลูกค้าก่อนนะคะ",
  rate_limited_daily: `วันนี้ใช้ YOLO ครบ ${YOLO_DAILY_SEND_CAP} ครั้งแล้ว — พรุ่งนี้สั่งใหม่ได้ค่ะ`,
  draft_budget: "วันนี้ร่าง YOLO ครบเพดานค่าโมเดลแล้ว — พรุ่งนี้สั่งใหม่ได้ค่ะ",
  brain_not_ready: "สมองของลูกแพรยังไม่พร้อมสำหรับห้องนี้ — ยังไม่ได้ส่งอะไรค่ะ",
  hermes_down: "สมองของลูกแพรไม่ตอบตอนร่าง — ยังไม่ได้ส่งอะไรถึงลูกค้า ลองสั่งใหม่ได้เลยค่ะ",
  guard_blocked: "ร่างไม่ผ่านด่านความปลอดภัย — ไม่ได้ส่งค่ะ ลองปรับคำสั่งแล้วสั่งใหม่ได้",
  payment_instructions: "ร่างมีเลขบัญชี/ช่องทางชำระเงิน — เรื่องเงินให้ทีมส่งเองนะคะ ไม่ได้ส่งค่ะ",
  instruction_leak: "ร่างหลุดพูดถึงคำสั่งภายใน — ไม่ได้ส่งค่ะ ลองสั่งใหม่อีกครั้งได้",
  price_revision_upward: "ร่างแจ้งราคาสูงกว่าที่เคยบอกลูกค้า — ต้องให้คนยืนยันเอง ไม่ได้ส่งค่ะ",
  empty_draft: "ร่างออกมาว่าง — ไม่ได้ส่งค่ะ",
  superseded: "มีข้อความใหม่ในห้องระหว่างที่ลูกแพรร่าง (ลูกค้าพิมพ์มา หรือมีคนตอบไปแล้ว) — ยกเลิกข้อความนี้ไว้ก่อน สั่งใหม่ได้เลยค่ะ",
  changed_before_send: "สถานะห้องเปลี่ยนระหว่างร่าง — ไม่ได้ส่งค่ะ",
  delivery_fenced: "รายการนี้ถูกล็อกการส่งไว้แล้ว — ไม่ส่งซ้ำค่ะ",
  send_failed: "ช่องทางไม่รับข้อความ — ยังไม่ถึงลูกค้าค่ะ",
  invalid_instruction: "คำสั่งยาวเกินไป — ขอไม่เกิน 500 ตัวอักษรนะคะ",
  // ต้องยืนยันก่อน
  unresolved_send: "YOLO ครั้งก่อนของห้องนี้ระบบขัดข้องระหว่างกำลังส่ง ไม่แน่ใจว่าถึงลูกค้าหรือยัง — เปิดดูแชทก่อน ถ้ายังไม่ถึงค่อยยืนยันส่งนะคะ",
  money_line:"ห้องนี้อยู่ในเส้นเงิน (ส่งเลขบัญชี/รอตรวจยอด/เคยชำระแล้ว) — เรื่องเงินเป็นงานของคน ยืนยันไหมคะว่าให้ลูกแพรทักตอนนี้",
  complaint: "ลูกค้าห้องนี้เคยไม่พอใจ/ร้องเรียน — ยืนยันไหมคะว่าให้ลูกแพรทักเอง",
  followup_suppressed: "ลูกค้าบอกไว้ว่าขอคิดก่อน/จะกลับมาเอง ระบบจึงหยุดติดตาม — ยืนยันไหมคะว่าให้ทักตอนนี้",
  // แจ้งเตือน (ส่งได้)
  human_recent: "ทีมเพิ่งตอบห้องนี้",
  operator_active: "ทีมกำลังคุยห้องนี้อยู่",
  needs_human: "ห้องนี้มีธงรอคนดูแลค้างอยู่",
  tag_silenced: "ห้องนี้ติดป้ายให้บอทเงียบ (ลูกค้าซื้อแล้ว/ไม่ใช่ลูกค้า)",
  quiet_hours: "ตอนนี้ช่วงดึก (21:00–09:00) ลูกค้าอาจยังไม่สะดวกอ่าน",
  fb_window_short: "หน้าต่าง 24 ชม. ของ Facebook ใกล้ปิด",
  service_boundary: "ห้องนี้ถูกพักการติดตามเพราะคุยนอกขอบเขตบริการ",
  appointment_soon: "มีนัด follow-up ที่ทีมตั้งไว้ (ยังไม่ถูกยกเลิก — ยกเลิกได้ในแผงข้อมูลลูกค้า)",
});

export function yoloReasonText(code) {
  const key = String(code || "");
  return TEXT[key] || TEXT[key.split(":")[0]] || key;
}

// ใช้ทั้งหน้าด่าน (ที่นี่) และด่านสดก่อนยิง (yoloDelivery.mjs) — ที่เดียว กันสองชั้นเล่าคนละกติกา
export function urgentMental(customer) {
  if (customer?.ai_off_reason === "urgent_mental") return true;
  return /(?:^|\n)\[[^\]]+\]\s*urgent_mental(?::|$)/u.test(String(customer?.handoff_summary || ""));
}

// เส้นเงิน = เคยแตะเงินจริง (ธงถาวร/สถานะดีล/เหตุปิด AI/บรรทัด handoff) หรือจังหวะเงินที่ยังรอคนตรวจ
// ใช้ตัวตัดสินชุดเดียวกับ pipeline (paymentStartedFromRow) — ห้องที่ระบบถือว่าเป็นเรื่องเงิน
// ต้องเป็นเรื่องเงินใน YOLO ด้วย ไม่งั้นสองเส้นจะเล่าคนละเรื่อง
export function moneyLineRoom(customer, { nowMs, lastInboundAt = null } = {}) {
  if (!customer) return false;
  if (paymentStartedFromRow(customer)) return true;
  return paymentHoldActive({ handoffSummary: customer.handoff_summary, nowMs, lastInboundAt });
}

// facts มาจาก yolo.mjs (อ่านสด ๆ ต่อคำขอ) — ฟังก์ชันนี้ตัดสินอย่างเดียว
export function evaluateYoloPreflight(facts = {}) {
  const { customer = null, nowMs = 0 } = facts;
  const warnings = [];
  const out = (refusal) => ({ refusal, confirm: [], warnings });
  if (!customer || facts.isCanary) return out("unknown_customer");
  if (facts.isLegacy) return out("legacy_room");
  if (Number(customer.do_not_disturb) === 1) return out("do_not_disturb");
  if (Number(customer.marketing_consent ?? 0) < 0 || customer.ai_off_reason === "optout") return out("opted_out");
  if (urgentMental(customer)) return out("urgent_mental");
  if (!facts.lastInboundAt) return out("no_conversation");
  if (facts.aiPaused) return out("ai_paused");
  const isFacebook = String(customer.channel_id || "") === "facebook";
  if (isFacebook && !facts.fbWindowOpenForDraft) return out("fb_window_closed");
  if (facts.inFlight) return out("in_flight");
  if (Number(facts.roomSends || 0) >= 1) return out("rate_limited_room");
  if (Number(facts.daySends || 0) >= YOLO_DAILY_SEND_CAP) return out("rate_limited_daily");
  if (Number(facts.dayDrafts || 0) >= YOLO_DAILY_DRAFT_CAP) return out("draft_budget");

  const confirm = [];
  // ส่งครั้งก่อนค้างผลกำกวม: อาจถึงลูกค้าแล้ว — คนต้องดูแชทแล้วยืนยันเอง (ขึ้นก่อนเหตุอื่น = เรื่องหลักที่ต้องเช็ก)
  if (Number(facts.unresolvedSendAt) > 0) confirm.push("unresolved_send");
  if (moneyLineRoom(customer, { nowMs, lastInboundAt: facts.lastInboundAt })) confirm.push("money_line");
  if (customer.ai_off_reason === "complaint") confirm.push("complaint");
  if (String(customer.followup_suppression_reason || "")) confirm.push("followup_suppressed");

  const humanAt = Number(facts.lastOperatorOutboundAt || 0);
  if (humanAt && nowMs - humanAt < HUMAN_RECENT_MS) {
    warnings.push({ code: "human_recent", text: `${TEXT.human_recent} (${formatBangkokTime(humanAt, nowMs)})` });
  }
  const operatorUntil = Number(customer.operator_active_until || 0);
  if (operatorUntil > nowMs) {
    warnings.push({ code: "operator_active", text: `${TEXT.operator_active} (AI พักถึง ${formatBangkokTime(operatorUntil, nowMs)})` });
  }
  if (customer.state === "NEEDS_HUMAN") warnings.push({ code: "needs_human", text: TEXT.needs_human });
  if (facts.silencedTag) warnings.push({ code: "tag_silenced", text: TEXT.tag_silenced });
  if (serviceFollowupPaused(customer)) warnings.push({ code: "service_boundary", text: TEXT.service_boundary });
  if (inQuietHours(nowMs)) warnings.push({ code: "quiet_hours", text: TEXT.quiet_hours });
  if (Number(facts.nextAppointmentAt) > 0) {
    warnings.push({ code: "appointment_soon", text: `${TEXT.appointment_soon} ${formatBangkokTime(facts.nextAppointmentAt, nowMs)}` });
  }
  if (isFacebook) {
    const closesAt = Number(facts.lastInboundAt) + FB_MESSAGING_WINDOW_MS;
    if (closesAt - nowMs < FB_WINDOW_SHORT_MS) {
      warnings.push({ code: "fb_window_short", text: `${TEXT.fb_window_short} (${formatBangkokTime(closesAt, nowMs)})` });
    }
  }
  return { refusal: null, confirm, warnings };
}

// คำที่แปลว่า "คำสั่งภายในหลุดถึงลูกค้า" — ลูกค้าต้องไม่รู้ว่าข้อความนี้มาจากการสั่ง
const LEAK_PATTERNS = [
  /\byolo\b/iu,
  /\(ระบบ\)/u,
  /ได้รับคำสั่ง/u,
  /คำสั่ง(?:จาก|ของ)?\s*(?:พี่ง้วง|ทีม(?:งาน)?|แอดมิน|ระบบ|ภายใน)/u,
  /พี่ง้วง\s*(?:สั่ง|ให้ลูกแพร|บอกให้|ขอให้|ฝากให้)/u,
  /(?:ถูก|โดน)\s*สั่งให้/u,
];

export function findInstructionLeak(text) {
  const value = String(text || "");
  return LEAK_PATTERNS.find((pattern) => pattern.test(value)) ? "instruction_leak" : null;
}

function bangkokDayKey(tsMs) {
  return new Date(Number(tsMs) + 7 * 3_600_000).toISOString().slice(0, 10);
}

// เลื่อนบันได follow-up หลัง YOLO ส่งสำเร็จ — YOLO "ใช้" ขั้นที่กำลังจะถึงไปแล้ว:
//   ladder_stage +1 · sent_today +1 (LINE ทักอัตโนมัติได้วันละรอบ → วันนี้ไม่มี FU ซ้อน)
//   · บันทึกข้อความลง history ให้ร่าง FU รอบหน้าไม่ถามซ้ำ
// กติกา episode/stage เหมือน processCustomer ใน stagedFollowups.mjs ทุกข้อ (ลูกค้าตอบหลัง
// anchor เดิม = episode ใหม่ · สเตจเปลี่ยน = เริ่มบันไดใหม่) ไม่งั้นรอบถัดไปจะรีเซ็ตทับการเลื่อนนี้
export function shiftLadderAfterYolo({ stateRow = null, customer, lastInboundAt, nowMs, sentText = "" }) {
  const state = {
    ladder_stage: Number(stateRow?.ladder_stage ?? 0),
    last_nudge_at: stateRow?.last_nudge_at ?? null,
    nudge_count: Number(stateRow?.nudge_count ?? 0),
    stage_key: String(stateRow?.stage_key ?? ""),
    episode_anchor: stateRow?.episode_anchor ?? null,
    episodes_today: Number(stateRow?.episodes_today ?? 0),
    sent_today: Number(stateRow?.sent_today ?? 0),
    today_key: String(stateRow?.today_key ?? ""),
    cold_sent_total: Number(stateRow?.cold_sent_total ?? 0),
    history: [],
  };
  try {
    const parsed = JSON.parse(String(stateRow?.history_json ?? "[]"));
    if (Array.isArray(parsed)) state.history = parsed;
  } catch { /* ประวัติพัง = เริ่มใหม่ เหมือน loadState ของ stagedFollowups */ }
  const today = bangkokDayKey(nowMs);
  if (state.today_key !== today) {
    state.today_key = today;
    state.sent_today = 0;
    state.episodes_today = 0;
  }
  if (lastInboundAt && (!state.episode_anchor || lastInboundAt > state.episode_anchor)) {
    state.episode_anchor = lastInboundAt;
    state.ladder_stage = 0;
  }
  const stage = warmthBand(Number.isInteger(customer?.last_score) ? customer.last_score : null);
  if (state.stage_key && state.stage_key !== stage) state.ladder_stage = 0;
  const ladderLength = ladderFor(stage, customer?.channel_id || "").length;
  const before = state.ladder_stage;
  if (state.ladder_stage === 0) state.episodes_today += 1;
  state.ladder_stage = Math.min(ladderLength, state.ladder_stage + 1);
  state.stage_key = stage;
  state.last_nudge_at = nowMs;
  state.nudge_count += 1;
  state.sent_today += 1;
  if (stage === "cold") state.cold_sent_total += 1;
  state.history.push({ kind: "yolo", question: [...String(sentText || "")].slice(0, 300).join(""), at: nowMs, stage });
  return {
    state: { ...state, history_json: JSON.stringify(state.history.slice(-20)) },
    summary: { stage, before, after: state.ladder_stage, ladderLength },
  };
}
