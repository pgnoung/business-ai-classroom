// yoloStatus.mjs — "สถานะ <ชื่อ>" สำหรับพี่ง้วงทาง Telegram (2026-09-28)
//
// อ่านอย่างเดียวล้วน: สวิตช์ AI + เหตุ, 3 ข้อความล่าสุด (ย่อ), ทีมตอบล่าสุดเมื่อไร, บันได FU
// ตัวบอกบันได FU ใช้ previewStagedFollowup ตัวเดียวกับ badge ⏱ บนคอนโซล — สองจอต้องเล่าเรื่องเดียวกัน
import { followupThreadEnabled, followupThreadPickFor, previewStagedFollowup, ladderFor } from "./stagedFollowups.mjs";
import { scheduleCheckFollowupEnabled } from "./scheduleCheck.mjs";
import { PAYMENT_NUDGE_SKIP_TEXT, paymentNudgePreview } from "./paymentGentleNudge.mjs";
import { isBankInfoConversation } from "./salesDecisionGuard.mjs";
import { aiPausedNow } from "./aiPause.mjs";
import { FB_MESSAGING_WINDOW_MS } from "./db.mjs";
import { aiOffReasonText, channelLabel, formatBangkokTime, previewText } from "./yoloText.mjs";

const FU_BLOCKED_TEXT = Object.freeze({
  urgent_mental: "หยุด (สัญญาณวิกฤต ต้องมีคนดูแล)",
  service_boundary: "หยุด (คุยนอกขอบเขตบริการ)",
  payment_hold: "หยุด (รอคนตรวจยอด)",
  cold_cap: "หยุด (ทักครบเพดานของลูกค้าเย็นแล้ว)",
  ladder_done: "บันไดรอบนี้ครบแล้ว รอลูกค้าตอบ",
  // รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8): ห้อง v3 ไม่ทักเมื่อไม่มีเรื่องค้าง/ลูกค้าปิดเอง — ต่างจาก "ทักครบแล้ว"
  no_thread: "ไม่ทัก (ไม่มีเรื่องที่ค้างให้ทักต่อ) รอลูกค้าตอบ",
  followup_stop: "ไม่ทัก (ลูกค้าปิดเอง/ปฏิเสธ/ขอพัก/ดูแลใจ)",
  daily_cap: "วันนี้ทักครบแล้ว",
  dormant: "หยุด (ลูกค้าเงียบเกิน 10 วัน)",
  // 2026-09-28: Facebook เว้นระยะไม้หลังถูกเลื่อนพ้นคืน — ไม้ที่ไม่ทันประตู 24 ชม. ถูกข้าม บันไดจบเร็วขึ้น
  fb_window_ends: "บันไดรอบนี้จบแล้ว — ไม้ถัดไปไม่ทันหน้าต่าง 24 ชม. ของ Facebook รอลูกค้าทักมาใหม่",
});

function stagedSwitchOn(db, config) {
  try {
    const stored = db.getSetting("staged_followup_enabled");
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch { return false; }
  return config.stagedFollowupEnabled === true;
}

function followupLine({ db, config, customer, nowMs }) {
  if (!(config.stagedFollowupTickMs > 0) || !stagedSwitchOn(db, config)) return "ระบบ FU อัตโนมัติปิดอยู่ทั้งระบบ";
  if (Number(customer.ai_enabled) !== 1) return "ไม่มี (AI ห้องนี้ปิด — FU อัตโนมัติไม่ทักห้องที่ทีมดูแล)";
  // 2026-09-28: ห้องหลังส่งบัญชีปิดบันไดปกติไว้ แต่อาจมีข้อความทักเบา ๆ ครั้งเดียว — เล่าเรื่องเดียวกับ badge คอนโซล
  if (isBankInfoConversation(customer)) {
    const payment = paymentNudgePreview({ db, config, customer, nowMs });
    if (payment?.dueAt) return `ทักเบา ๆ หลังส่งบัญชีครั้งเดียว — ${formatBangkokTime(payment.dueAt, nowMs)}`;
    if (payment?.blocked === "payment_nudge_done") return "ทักเบา ๆ หลังส่งบัญชีไปแล้ว (ไม่ทักเรื่องโอนอีก)";
    if (payment?.blocked) return `ไม่ทักหลังส่งบัญชี (${PAYMENT_NUDGE_SKIP_TEXT[payment.reason] || payment.reason})`;
  }
  if (Number(customer.followup_enabled) !== 1) return "ไม่มี (ห้องนี้ปิดการติดตาม)";
  let preview = null;
  try {
    preview = previewStagedFollowup({
      customer,
      state: db.getFollowupState(customer.line_user_id),
      lastInboundAt: db.lastInboundAt(customer.line_user_id),
      lastOutboundAt: db.lastOutboundAt(customer.line_user_id),
      nowMs,
      delays: {
        cold: config.stagedColdDelayMs ?? 3_600_000,
        warm: config.stagedWarmDelayMs ?? 1_800_000,
        hot: config.stagedHotDelayMs ?? 1_800_000,
      },
      // 2026-09-28: ห้องที่ลูกค้าขอเช็คคิวก่อน — บอกเวลาทักครั้งเดียวให้ตรงกับเส้นยิงจริง
      scheduleCheck: scheduleCheckFollowupEnabled(db),
      // รอบรีวิว 8: ห้อง v3 ใช้แผนเรื่องค้างตัวเดียวกับเส้นยิงจริงและ badge คอนโซล
      threadPick: followupThreadEnabled(db)
        ? ({ history }) => followupThreadPickFor({ db, config, customer, history, nowMs })
        : null,
    });
  } catch { return "อ่านไม่ได้"; }
  if (!preview) return "ไม่มีคิว";
  if (preview.blocked) return FU_BLOCKED_TEXT[preview.blocked] || preview.blocked;
  if (preview.stage === "schedule_check") return `ลูกค้าขอเช็คคิวก่อน — ทักถามครั้งเดียว ${formatBangkokTime(preview.dueAt, nowMs)}`;
  const total = ladderFor(preview.stage, customer.channel_id || "").length;
  return `${preview.stage} ขั้น ${preview.step}/${total} — ถัดไป ${formatBangkokTime(preview.dueAt, nowMs)}`;
}

function speaker(row) {
  if (row.direction === "in") return "ลูกค้า";
  const operator = String(row.operator || "").trim();
  if (operator && operator !== "system") return "ทีม";
  return "ลูกแพร";
}

function messagePreview(row) {
  if (row.msg_type && row.msg_type !== "text") {
    return row.msg_type === "image" ? "[รูป]" : row.msg_type === "sticker" ? "[สติกเกอร์]" : `[${row.msg_type}]`;
  }
  return previewText(row.content, 60);
}

export function describeRoomStatus({ db, config, customerId, nowMs = Date.now() }) {
  const customer = db.getCustomer(customerId);
  if (!customer) return null;
  const lastInboundAt = db.lastInboundAt(customerId);
  const recent = db.recentRoomMessages(customerId, 3).map((row) => ({
    who: speaker(row), text: messagePreview(row), at: row.created_at,
  }));
  const isFacebook = String(customer.channel_id || "") === "facebook";
  return {
    id: customer.line_user_id,
    name: String(customer.known_name || customer.display_name || "").trim(),
    channel: channelLabel(customer.channel_id),
    aiEnabled: Number(customer.ai_enabled) === 1,
    aiText: Number(customer.ai_enabled) === 1
      ? (aiPausedNow({ db, config }) ? "เปิด (แต่ลูกแพรถูกหยุดทั้งระบบอยู่)" : "เปิด — ลูกแพรตอบเอง")
      : `ปิด — ${aiOffReasonText(customer.ai_off_reason)}`,
    operatorPausedUntil: Number(customer.operator_active_until || 0) > nowMs ? Number(customer.operator_active_until) : null,
    needsHuman: customer.state === "NEEDS_HUMAN",
    doNotDisturb: Number(customer.do_not_disturb) === 1,
    lastInboundAt,
    lastHumanReplyAt: db.lastOperatorOutboundAt(customerId),
    followup: followupLine({ db, config, customer, nowMs }),
    fbWindowClosesAt: isFacebook && lastInboundAt ? Number(lastInboundAt) + FB_MESSAGING_WINDOW_MS : null,
    recent,
  };
}
