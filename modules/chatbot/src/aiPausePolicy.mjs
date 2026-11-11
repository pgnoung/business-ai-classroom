// aiPausePolicy.mjs — นโยบายเดียวของ "AI พักเมื่อไหร่ / เงียบถาวรเมื่อไหร่"
// (คำสั่งเจ้าของ 2026-09-02 — รวมกติกาที่เคยกระจายอยู่ 5 ไฟล์มาไว้ที่เดียว)
//
// แยกให้ขาดสองคำที่เคยปนกันจนพัง:
//   พัก (pause)  = operator_active_until — มีวันหมดอายุ AI กลับมาเอง ห้ามแตะ ai_enabled
//   ปิด (sticky) = ai_enabled = 0 + เหตุผล — ไม่มีเส้นทางอัตโนมัติใดเปิดคืนได้ คนต้องกดเอง
//
// ที่ผ่านมาสองคำนี้ถูกใช้สลับกัน: ร้องเรียนถูก "พัก 60 นาที" แล้วบอทโผล่กลับมาขายต่อ
// ส่วนแอดมินตอบใน Business Suite กลับกลายเป็น "ปิดถาวร" จนห้องตายไปเลย
export const OPERATOR_PAUSE_MS = 15 * 60_000;

// เหตุที่คอนโซล/แดชบอร์ดบันทึกเมื่อ "คน" กดสวิตช์ปิดเอง — เดิมเขียนค่าว่างไว้
// ทำให้แยกไม่ออกจากห้องที่ไม่เคยมีใครตัดสินใจ และเส้นทางอัตโนมัติเปิดคืนทับได้
export const MANUAL_AI_OFF_REASON = "manual";

// เหตุที่แปลว่า "ห้องนี้เป็นของคนจริงแล้ว" — ทุกเส้นทางอัตโนมัติต้องเดินผ่าน
// canAutoEnableAi() ก่อนเปิด AI คืน ไม่มีข้อยกเว้น
export const STICKY_AI_OFF_REASONS = Object.freeze([
  MANUAL_AI_OFF_REASON,
  "money_line",              // เส้นเงิน (ห้ามแตะตรรกะ — อยู่ในลิสต์เพื่อกันการเปิดคืนอัตโนมัติ)
  "bank_sent",
  "human_requested",
  "file_review",             // Attached files need a human; no automatic reopening.
  // คำสั่งพี่ง้วง 2026-09-05: ลูกค้าจอง/สมัครแล้ว = ห้องของชมพู่เต็มตัว
  // ลูกแพรตอบรับหนึ่งข้อความแล้วเงียบถาวร ไม่ตามต่อ ไม่ follow up
  "booking_handoff",
  "urgent_mental",
  "customer_handover",
  "not_a_customer",
  "handoff_private_inhouse", // in-house / private class / งานบรรยาย — ทีมรับช่วงเต็มตัว
  "complaint",               // ร้องเรียน (2026-09-02: เดิมพัก 60 นาที)
  "optout",                  // ขอให้หยุดทัก/รำคาญ
  // F4b (ตรวจย้อนหลัง ก.ย. 2026): "ไม่ต้องตอบกลับแล้วครับ" — หยุดเงียบ ไม่ส่งแม่แบบใด ๆ
  // ห้องของคนจริงตัดสินต่อ (ทักเองหรือปล่อยไว้) ระบบห้ามเปิดคืนเอง
  "customer_asked_quiet",
  "identity_question",       // ห้องเก่าก่อน 28 ก.ย. ที่ปิดเพราะถามว่าเป็นบอท — ตั้งแต่ 28 ก.ย. ไม่ปิดแล้ว (templateStickyAiOffReason)
  // เกต Facebook ที่เอกสารเดิมกำกับว่า "ปลดด้วยมือคนเท่านั้น"
  "fb_legacy_customer",
  "fb_name_unverified",
  "fb_human_replying",       // ห้องเก่าก่อน 2026-09-02 — ปลดด้วย tools/reopen-fb-human-replying.mjs
]);

const STICKY = new Set(STICKY_AI_OFF_REASONS);

export function isStickyAiOffReason(reason) {
  return STICKY.has(String(reason ?? "").trim());
}

// ด่านเดียวที่เส้นทางอัตโนมัติ (เกต Facebook, การโยงระบบเก่า, ฯลฯ) ต้องผ่านก่อนเปิด AI คืน
// expectReason = เหตุชั่วคราวที่ "ของตัวเอง" เท่านั้นที่มีสิทธิ์ปลด (fail-closed)
export function canAutoEnableAi(customer, { expectReason = "" } = {}) {
  if (!customer) return false;
  if (customer.ai_enabled === 1) return true;
  const reason = String(customer.ai_off_reason ?? "").trim();
  if (isStickyAiOffReason(reason)) return false;
  return expectReason ? reason === String(expectReason) : true;
}

// ตั้งหน้าต่างพักหลังคนตอบเอง (คอนโซล หรือ echo ของแอดมินฝั่ง Facebook)
// จงใจไม่แตะ ai_enabled: ห้องที่คนกดปิดไว้ต้องปิดต่อ ห้องที่เปิดอยู่ต้องกลับมาเองเมื่อครบเวลา
export function pauseAiForHumanReply(db, customerId, { nowMs = Date.now(), logger = console } = {}) {
  try {
    db.setOperatorActiveUntil(customerId, nowMs + OPERATOR_PAUSE_MS);
    return { paused: true, until: nowMs + OPERATOR_PAUSE_MS };
  } catch (err) {
    logger.error?.(`aiPausePolicy: ตั้งหน้าต่างพัก AI ไม่สำเร็จ (${err?.message || err})`);
    return { paused: false };
  }
}

// ---- แผนการ "ปิดถาวร" ต่อเหตุ: เหตุที่เขียนลง ai_off_reason + ชื่อ audit ----
// เหตุที่ไม่อยู่ในตารางนี้ = เส้นเงิน (พฤติกรรมเดิมเป๊ะ: money_line/ai_off_money_line)
const STICKY_OFF_PLAN = Object.freeze({
  human_requested: { offReason: "human_requested", auditAction: "ai_off_human_requested" },
  // คำสั่งพี่ง้วง 2026-09-05 — ความหมายเดียวกับ human_requested ทุกประการ
  // ต่างกันแค่ "ใครเป็นคนเอ่ยก่อน": อันนี้ลูกค้าเป็นฝ่ายตัดสินใจซื้อ ไม่ได้ขอคน
  booking_handoff: { offReason: "booking_handoff", auditAction: "ai_off_booking_handoff" },
  urgent_mental: { offReason: "urgent_mental", auditAction: "ai_off_urgent_mental" },
  complaint: { offReason: "complaint", auditAction: "ai_off_complaint" },
  optout: { offReason: "optout", auditAction: "ai_off_optout" },
  customer_asked_quiet: { offReason: "customer_asked_quiet", auditAction: "ai_off_customer_asked_quiet" },
  identity_question: { offReason: "identity_question", auditAction: "ai_off_identity_question" },
});

export function stickyOffPlanFor(reason) {
  return STICKY_OFF_PLAN[String(reason ?? "")] ?? { offReason: "money_line", auditAction: "ai_off_money_line" };
}

// เส้นทาง deterministic ที่ "ตอบ template ความจริงไปแล้ว จากนั้นต้องเงียบรอคน"
// — ไม่มี escalate ของตัวเอง จึงต้องแยกออกมาจาก persistRouteEscalation
// (ร้องเรียนมี escalate อยู่แล้ว จึงไม่ต้องอยู่ที่นี่)
export function templateStickyAiOffReason(route) {
  if (!route || route.escalate) return "";
  // คำสั่งพี่ง้วง 2026-09-28 (ตัดสินข้อ F10 ของผลตรวจ ก.ย.): ถามว่าเป็นบอทไหม = ตอบความจริงแล้ว "คุยต่อได้"
  // ปิดเฉพาะเมื่อลูกค้าขอคนจริง (เส้น human_handoff) — เดิมปิดถาวรทันทีทั้งที่แม่แบบชวนให้บอกลูกแพร
  // แล้วลูกแพรไม่ได้ยินอีก (เคสจริง: ลูกค้าพิมพ์ "ทำไมไม่ตอบแล้ว" 5 ข้อความ) · เหตุ identity_question
  // ยังอยู่ใน STICKY_AI_OFF_REASONS ให้ห้องเก่าที่ปิดไว้แล้วคงปิดจนคนเปิดคืน
  if (route.intent === "followup_optout") return "optout";
  return "";
}

/* ---------------- ลูกค้าเก่าที่ยังไม่ยืนยันตัวตน (legacy candidate) ---------------- */

// กติกาเดียวที่แทรกเพิ่มเข้า prompt และแทรกเฉพาะห้องที่ยังรอยืนยันเท่านั้น
// เหตุผล: ชื่อ LINE ตรงกันไม่ใช่หลักฐานยืนยันตัวบุคคล ถ้าปล่อยให้อ้างประวัติของอีกคน
// = เอาข้อมูลลูกค้าคนหนึ่งไปเล่าให้อีกคนฟัง ซึ่งแย่กว่าการเงียบเสียอีก
export const LEGACY_PENDING_RULE =
  "- ลูกค้ารายนี้อาจเป็นลูกค้าเก่าที่ยังไม่ยืนยันตัวตน ห้ามอ้างประวัติ ชื่อ หรือข้อมูลจากระบบเก่า ให้คุยเหมือนลูกค้าใหม่";

export function legacyIdentityPending(customer) {
  const link = String(customer?.legacy_link ?? "");
  return link.startsWith("candidate:") || link.startsWith("ambiguous:");
}

// โน้ตที่ทีมงานอ่านแล้วรู้ว่าต้องทำอะไรต่อ เมื่อระบบตอบข้อความค้างให้เองไม่ได้
export const PENDING_INBOUND_NOTE = "มีข้อความค้างระหว่างรอยืนยันตัวตน";

// ---- ข้อความค้าง: ลูกค้าพิมพ์มาแล้วไม่มีใครตอบเลย ----
//
// ใช้ตอนคนกดยืนยัน/ปฏิเสธ/โยงมือ สำหรับห้องที่ค้างมาตั้งแต่ก่อน deploy นี้
// (AI ถูกปิดไว้ ข้อความจึงถูกกลืนเป็น silent_by_design/ai_disabled)
//
// ตั้งใจ "ไม่" แตะบัญชีเทิร์น (inbound_turns): แถวนั้นถูกปิดไปแล้วอย่างซื่อสัตย์ว่า
// เงียบเพราะ AI ปิด การย้อนไปเขียนทับจะทำให้บัญชีเล่าเรื่องที่ไม่เคยเกิด — คำตอบรอบนี้
// ถูกบันทึกเป็นข้อความขาออกใหม่ + audit แทน
// auditAction/auditDetail: เส้นอื่นที่ "คนเปิด AI คืน" ใช้ตัวนี้ได้ด้วย (F5 ก.ย. 2026: ห้องที่ปิดเพราะไฟล์แนบ)
// ค่าเริ่มต้นคือถ้อยคำเดิมของเส้นยืนยันตัวตนทุกตัวอักษร
export function answerPendingInbound({
  db, pipeline = null, notifier = null, customerId, logger = console,
  auditAction = "legacy_pending_reply",
  auditDetail = "ยืนยันตัวตนแล้ว — ส่งข้อความที่ค้างเข้าเส้นทางตอบอีกครั้ง (push เพราะ reply token หมดอายุ)",
} = {}) {
  let customer = null;
  try {
    customer = db.getCustomer(customerId);
  } catch (err) {
    logger.warn?.(`aiPausePolicy: อ่านลูกค้าไม่สำเร็จ (${err?.message || err})`);
    return { skipped: "db_error" };
  }
  if (!customer) return { skipped: "no_customer" };
  if (customer.ai_enabled !== 1) return { skipped: "ai_off" };
  if ((Number(customer.operator_active_until) || 0) > Date.now()) return { skipped: "operator_active" };

  let pending = "";
  try {
    const last = db.recentTurns(customerId, 2).at(-1);
    if (last?.role === "user") pending = String(last.content || "").trim();
  } catch (err) {
    logger.warn?.(`aiPausePolicy: อ่านประวัติไม่สำเร็จ (${err?.message || err})`);
    return { skipped: "history_unreadable" };
  }
  if (!pending) return { skipped: "no_pending" };

  // ไม่มี pipeline (เช่นถูกเรียกจาก script) = ห้ามเดาแทนคน: ปักธงให้คนเข้ามาตอบเอง
  if (typeof pipeline?.handleInboundText !== "function") {
    let flagged = false;
    try {
      if (customer.state !== "NEEDS_HUMAN") {
        db.setNeedsHuman(customerId, "legacy_pending_reply", PENDING_INBOUND_NOTE);
        flagged = true;
      }
    } catch (err) {
      logger.warn?.(`aiPausePolicy: ปักธงข้อความค้างไม่สำเร็จ (${err?.message || err})`);
    }
    notifier?.fireLater?.({
      customerId,
      channelId: customer.channel_id || "default",
      reason: "legacy_pending_reply",
      customerName: customer.known_name || customer.display_name || "",
      force: true,
    });
    return { flagged, skipped: flagged ? undefined : "already_flagged" };
  }

  try {
    db.addAudit({
      operator: "system", action: auditAction, target: customerId,
      detail: auditDetail,
    });
  } catch { /* audit พังห้ามหยุดการตอบลูกค้า */ }

  // fire-and-forget: คอนโซลต้องได้คำตอบทันที ห้ามค้างรอ Hermes ทั้งรอบ
  // replyToken ว่าง = เส้นทางส่งเลือก push ให้เอง (token ของเดิมหมดอายุไปนานแล้ว)
  setTimeout(() => {
    Promise.resolve(pipeline.handleInboundText({ customerId, text: pending, replyToken: "" }))
      .catch((err) => logger.error?.(`aiPausePolicy: ตอบข้อความค้างไม่สำเร็จ (${err?.message || err})`));
  }, 0);
  return { redispatched: true, text: pending };
}
