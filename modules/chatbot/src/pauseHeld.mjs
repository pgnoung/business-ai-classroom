// pauseHeld.mjs — "ข้อความที่ลูกค้าพิมพ์ระหว่าง AI พัก (คนเพิ่งตอบ) แล้วยังไม่มีใครตอบ" (2026-09-28)
//
// นโยบายเจ้าของ 2 ก.ย. 2026: "ตอบจากคอนโซลหรือ Business Suite → AI พัก 15 นาทีแล้วกลับมา"
// แต่ข้อความที่ลูกค้าพิมพ์ระหว่างพักถูกกลืนเป็น silent_by_design|operator_active ตลอดไปถ้าคนไม่ตอบ
// (ก.ย.: FB 133 ช่วงพัก 17 ช่วงไม่มีใครตอบเลย + LINE 7 ช่วง) ตัวอ่านนี้คือนิยามเดียวของ "ชุดที่ค้าง"
// ที่สองเส้นใช้ร่วมกัน:
//   · ตัวกวาดเมื่อหมดเวลาพัก (pauseResume.mjs) — ลูกค้าไม่ได้พิมพ์ต่อ: AI ตอบชุดนี้หนึ่งครั้ง
//   · เทิร์นปกติถัดไป (pipeline.mjs handleInboundText) — ลูกค้าพิมพ์ต่อหลังหมดเวลาพัก: ชุดนี้ต้องอยู่ใน
//     เทิร์นเดียวกัน เพราะประวัติที่โมเดลเห็นตัดแถวลูกค้าท้ายห้องทิ้งทั้งหมด (historyBeforeCurrentInbound)
//     ของเดิมข้อความชุดนั้นจึงหายจากสายตาโมเดลเงียบ ๆ แม้ลูกค้าจะพิมพ์ต่อแล้วได้คำตอบ
//
// อ่านจากตาราง messages + customers.operator_active_until เท่านั้น — ตารางบัญชีเทิร์นขาเข้าเป็นบันทึก
// ไม่ใช่คิว (schema.mjs) ห้ามใช้เป็นตัวตัดสินว่าจะตอบอะไร
// "พัก" เท่านั้น ไม่ใช่ "ปิด": ข้อความที่เงียบเพราะ AI ปิดห้ามถูกตอบย้อนหลังเมื่อเปิดคืน (controlGate.mjs
// กติกาข้อ 3) — มีการสลับ AI หลังข้อความแรกที่ค้าง = แยกไม่ออกแล้วว่าข้อความไหนเงียบเพราะอะไร จึงไม่นับ
// สวิตช์: settings pause_resume_answer (ค่าเริ่มต้น = เปิด; "off" ปิดทั้งสองเส้นทันทีไม่ต้อง deploy;
// "facebook" = เฉพาะห้อง Facebook — คำตอบของคนใน Business Suite มาเป็น echo ระบบเห็นครบ แต่ห้อง LINE
// แอดมินอาจตอบต่อใน LINE OA Manager ซึ่งระบบมองไม่เห็น ข้อความที่ดูเหมือน "ค้าง" อาจมีคนตอบไปแล้ว)
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { LEGACY_AUTO_CUSTOMER_AUDIT } from "./legacyLink.mjs";

export const PAUSE_RESUME_SETTING = "pause_resume_answer";
export const PAUSE_RESUME_AUDIT_ACTION = "ai_pause_resume_answer";
// เฉพาะช่วงพักที่เพิ่งหมด — กันการย้อนไปตอบข้อความเก่าหลายวันตอน deploy ครั้งแรก
export const PAUSE_RESUME_LOOKBACK_MS = 2 * 3_600_000;
const HISTORY_ROWS = 40;
const MAX_PARTS = 10;
const OFF_VALUES = new Set(["off", "0", "false", "no"]);
// การกระทำที่เปลี่ยน ai_enabled ของห้อง (คนกดในคอนโซล/แดชบอร์ด + ระบบปลดเกตเอง)
const AI_SWITCH_ACTIONS = Object.freeze(["ai_toggle", "fb_legacy_gate_cleared", `${LEGACY_AUTO_CUSTOMER_AUDIT}_undo`]);

// "off" | "facebook" | "on" — อ่านไม่ได้ = ปิด (ทั้งสองเส้นทำให้ AI พูดเพิ่ม เงียบตามเดิมปลอดภัยกว่าพูดผิดจังหวะ)
export function pauseResumeMode(db) {
  try {
    const value = String(db.getSetting(PAUSE_RESUME_SETTING) ?? "").trim().toLowerCase();
    if (OFF_VALUES.has(value)) return "off";
    return value === FACEBOOK_CHANNEL_ID ? FACEBOOK_CHANNEL_ID : "on";
  } catch {
    return "off";
  }
}

export function pauseResumeEnabled(db) {
  return pauseResumeMode(db) !== "off";
}

const no = (reason) => ({ ok: false, reason });
// ตรงกับ recentTurns: operator ไม่ว่างและไม่ใช่ "system" = คนจริงพิมพ์ (คอนโซล / echo ของ Business Suite)
const humanOperator = (operator) => {
  const value = String(operator ?? "").trim();
  return Boolean(value) && value !== "system";
};

function aiSwitchedSince(db, customerId, sinceMs) {
  const marks = AI_SWITCH_ACTIONS.map(() => "?").join(",");
  return Boolean(db.raw.prepare(
    `SELECT 1 FROM admin_audit WHERE target = ? AND created_at >= ? AND action IN (${marks}) LIMIT 1`,
  ).get(customerId, sinceMs, ...AI_SWITCH_ACTIONS));
}

/**
 * อ่านชุดข้อความที่ค้างจากช่วงพักล่าสุดของห้อง
 * @param {object} db
 * @param {object|null} customer แถว customers
 * @param {{nowMs?: number, isMoneyRoom?: (customer: object) => boolean, isCampaignText?: (text: string) => boolean}} options
 * @returns {{ok: true, parts: string[], anchorId: string, sessionId: string, later: number} | {ok: false, reason: string}}
 *   parts = ข้อความ (text) ที่มาระหว่างพักหลังคนตอบ เรียงเก่า -> ใหม่ · later = แถวลูกค้าที่มาหลังหมดเวลาพัก
 */
export function scanPauseHeld(db, customer, { nowMs = Date.now(), isMoneyRoom = null, isCampaignText = () => false } = {}) {
  if (!customer) return no("no_customer");
  const until = Number(customer.operator_active_until) || 0;
  if (!until) return no("no_pause");
  if (until > nowMs) return no("still_paused");
  if (nowMs - until > PAUSE_RESUME_LOOKBACK_MS) return no("pause_too_old");
  if (customer.ai_enabled !== 1) return no("ai_off");
  if (customer.state === "NEEDS_HUMAN") return no("needs_human");
  if (customer.do_not_disturb === 1) return no("dnd");
  const mode = pauseResumeMode(db);
  if (mode === "off") return no("disabled");
  const facebookRoom = String(customer.channel_id || "") === FACEBOOK_CHANNEL_ID;
  if (mode === FACEBOOK_CHANNEL_ID && !facebookRoom) return no("channel_off");
  // ไม่รู้สถานะเงิน = ถือเป็นห้องเงิน (fail-closed แบบเดียวกับ paymentStartedFor)
  if (typeof isMoneyRoom !== "function" || isMoneyRoom(customer)) return no("money_line");
  const customerId = String(customer.line_user_id);
  if (facebookRoom && !db.withinFacebookWindow(customerId, nowMs)) {
    return no("fb_window_closed");
  }
  const sessionId = db.activeConversationSession(customerId)?.id;
  if (!sessionId) return no("no_session");
  const rows = db.raw.prepare(
    `SELECT id, direction, msg_type, content, operator, created_at FROM messages
      WHERE customer_id = ? AND session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(customerId, String(sessionId), HISTORY_ROWS);
  if (!rows.length || rows[0].direction !== "in") return no("answered");
  const trailing = [];
  let lastOutbound = null;
  for (const row of rows) {
    if (row.direction === "out") {
      lastOutbound = row;
      break;
    }
    trailing.unshift(row);
  }
  // ช่วงพักเริ่มจาก "คนตอบ" เสมอ — ข้อความล่าสุดของฝั่งเราต้องเป็นคน (พักจากเหตุอื่น เช่น
  // สงสัยตอบนอกระบบ ไม่มีแถวคนตอบให้เห็น = ไม่รู้ว่าคนคุยอะไรไป ห้ามเดา)
  if (!lastOutbound || !humanOperator(lastOutbound.operator)) return no("last_reply_not_human");
  const held = trailing.filter((row) => Number(row.created_at) <= until);
  if (!held.length) return no("nothing_held");
  if (aiSwitchedSince(db, customerId, Number(held[0].created_at) || 0)) return no("ai_switched");
  const parts = held
    .filter((row) => row.msg_type === "text")
    .map((row) => String(row.content ?? "").trim())
    .filter(Boolean);
  if (!parts.length) return no("no_text");
  if (parts.some((text) => isCampaignText(text))) return no("campaign_keyword");
  return {
    ok: true, parts: parts.slice(-MAX_PARTS), anchorId: String(held.at(-1).id), sessionId: String(sessionId),
    later: trailing.length - held.length,
  };
}

// ก้อนปัจจุบันที่มาถึงก่อนหมดเวลาพักแต่ถูกประมวลผลหลังหมด (debounce คร่อมเส้น) หรือก้อนที่ยกมา
// (carry ของตัวกวาด) อยู่ในทั้งสองชุด — ตัดหางชุดค้างที่ตรงกับหัวก้อนปัจจุบันออก ไม่ให้โมเดลเห็นซ้ำ
function withoutOverlap(held, incoming) {
  const head = incoming.map((text) => String(text ?? "").trim());
  for (let size = Math.min(held.length, head.length); size > 0; size -= 1) {
    const tail = held.slice(-size);
    if (tail.every((text, index) => text === head[index])) return held.slice(0, held.length - size);
  }
  return held;
}

/**
 * เทิร์นปกติถัดไปหลังหมดเวลาพัก: ข้อความค้างที่ต้องนำหน้าก้อนนี้ (ว่าง = เทิร์นเดิมทุกไบต์)
 * บันทึก audit เมื่อรวมจริง อ่านพังทุกกรณี = คืนค่าว่าง (ห้ามทำให้เส้นตอบปกติล้ม)
 */
export function heldPausePartsForTurn(db, { customerId, incoming = [], nowMs = Date.now(), isMoneyRoom, isCampaignText, logger = console } = {}) {
  try {
    const customer = db.getCustomer(customerId);
    if (!(Number(customer?.operator_active_until) > 0)) return [];
    const scan = scanPauseHeld(db, customer, { nowMs, isMoneyRoom, isCampaignText });
    if (!scan.ok) return [];
    const parts = withoutOverlap(scan.parts, Array.isArray(incoming) ? incoming : []);
    if (!parts.length) return [];
    db.addAudit({
      operator: "system", action: PAUSE_RESUME_AUDIT_ACTION, target: String(customerId),
      detail: `หมดเวลาพัก AI — ข้อความค้างระหว่างพัก ${parts.length} ข้อความ → รวมเข้าเทิร์นที่ลูกค้าพิมพ์ต่อ`,
    });
    return parts;
  } catch (err) {
    logger.warn?.(`pauseHeld: อ่านข้อความค้างระหว่างพักไม่สำเร็จ (${err?.message || err}) — ตอบเฉพาะก้อนนี้`);
    return [];
  }
}
