// qualifyAnswerPending.mjs — หลังห้องสีเหลืองกลับเป็นสีเขียว (5 ต.ค. 2026)
//
// พี่ง้วง: "ถ้าเมื่อไหร่ sense ได้ว่าแชทนั้นมีศักยภาพขึ้นมา ให้กลับมาเปิดสีเขียวเหมือนเดิม"
// เปิดคืนแล้วข้อความล่าสุดของลูกค้ายังไม่มีใครตอบ = ส่งเข้าเส้นตอบปกติอีกครั้ง (answerPendingInbound เดิม)
// ผู้เรียก: ตัวกวาดคัดกรองเปิดเขียว · คนกดเปิด AI ทับห้องสีเหลืองในคอนโซล (aiSwitch — รีวิวปรปักษ์ 5 ต.ค. #21)
// ด่านเพิ่มเฉพาะเส้นนี้: ห้อง Facebook ต้องยังอยู่ในหน้าต่าง 24 ชม. (แบบเดียวกับ pauseHeld.scanPauseHeld)
//   นอกหน้าต่าง Meta ห้ามส่งข้อความทั่วไป — ห้องเปิดเขียวแล้วรอลูกค้าทักใหม่เอง ไม่ฝืนส่ง
//   อ่านหน้าต่างไม่ได้ = ไม่ส่ง (เงียบปลอดภัยกว่าส่งผิดกฎแพลตฟอร์ม)
// รีวิวปรปักษ์ 5 ต.ค. #9: answerPendingInbound ส่งข้อความล่าสุดข้อความเดียว — ข้อความที่ลูกค้าพิมพ์ระหว่างเหลือง
//   (มักเป็นเหตุที่ห้องเปิดเขียวเลย เช่น "บริษัทอยากส่งพนักงาน 5 คน") ส่งตามไปเป็น heldParts ให้โมเดลเห็นครบ
// รีวิวปรปักษ์รอบ 2 5 ต.ค.: คนกดเปิด AI ส่ง maxPendingAgeMs (24 ชม.) — ข้อความค้างเก่า/ตอบแล้ว ไม่ตอบย้อนหลัง (ดู pendingAgeBlock)
import { answerPendingInbound } from "./aiPausePolicy.mjs";
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { auditYellowHeldMerged, collectYellowHeldParts, yellowOffAtFor } from "./qualifyFastReclaim.mjs";

export const QUALIFY_PENDING_AUDIT_ACTION = "not_qualified_pending_reply";
export const QUALIFY_PENDING_AUDIT_DETAIL =
  "ตัวกวาดคัดกรองเปิด AI คืน — ส่งข้อความที่ค้างเข้าเส้นทางตอบอีกครั้ง (push เพราะ reply token หมดอายุ)";

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ข้อความล่าสุดของห้อง (ทุกทิศ ทุกชนิด) — เกณฑ์เดียวกับ latestRowOf ของตัวกวาด
const LATEST_ROW_SQL = `SELECT direction, created_at FROM messages WHERE customer_id = ?
  ORDER BY created_at DESC, rowid DESC LIMIT 1`;

/**
 * ด่านอายุข้อความค้าง (ใช้เมื่อผู้เรียกส่ง maxPendingAgeMs) — "" = ผ่าน
 * ข้อความล่าสุดของห้องต้องเป็นของลูกค้า และไม่เก่ากว่า maxPendingAgeMs · อ่านไม่ได้ = ไม่ส่ง (เงียบปลอดภัยกว่าตอบซ้ำ)
 */
function pendingAgeBlock(db, customerId, nowMs, maxPendingAgeMs, logger) {
  let latest = null;
  try {
    latest = db.raw.prepare(LATEST_ROW_SQL).get(String(customerId)) ?? null;
  } catch (err) {
    logger.warn?.(`qualify-answer-pending: อ่านข้อความล่าสุดไม่สำเร็จ (${err?.message || err}) — ไม่ส่งข้อความค้าง`);
    return "db_error";
  }
  if (!latest || latest.direction !== "in") return "already_answered";
  return nowMs - (Number(latest.created_at) || 0) > maxPendingAgeMs ? "stale_pending" : "";
}

/**
 * @param {{auditDetail?: string, via?: string, maxPendingAgeMs?: number}} options
 *   auditDetail = ถ้อยคำ audit ของผู้เรียก (คนกดเปิดใช้ถ้อยคำของคน)
 *   maxPendingAgeMs = ตอบเฉพาะเมื่อข้อความล่าสุดของห้องเป็นของลูกค้าและใหม่กว่านี้ (0 = ไม่จำกัด — ตัวกวาดคุมเวลาเอง)
 *     รีวิวปรปักษ์รอบ 2 5 ต.ค.: คนกดเปิด AI ทับห้องเหลืองเคยตอบข้อความ "ค่ะ" ที่ค้างมา 5 วัน และข้อความที่ทีมตอบไปแล้ว
 *     ทาง LINE OA Manager (ไม่มีแถวขาออกในระบบ) ลูกค้าจึงได้คำตอบซ้ำ — เก่าเกิน/ตอบแล้ว = ปล่อยให้คิวรอตอบ
 */
export function createQualifyAnswerPending({
  db, pipeline, notifier = null, logger = console, now = Date.now,
  auditDetail = QUALIFY_PENDING_AUDIT_DETAIL, via = "sweep", maxPendingAgeMs = 0,
} = {}) {
  return function answerPending({ customerId } = {}) {
    let customer = null;
    try {
      customer = db.getCustomer(customerId);
    } catch (err) {
      logger.warn?.(`qualify-answer-pending: อ่านลูกค้าไม่สำเร็จ (${err?.message || err})`);
      return { skipped: "db_error" };
    }
    if (!customer) return { skipped: "no_customer" };
    if (String(customer.channel_id || "") === FACEBOOK_CHANNEL_ID) {
      let open = false;
      try { open = db.withinFacebookWindow(String(customerId), now()) === true; } catch { open = false; }
      if (!open) return { skipped: "fb_window_closed" };
    }
    if (Number(maxPendingAgeMs) > 0) {
      const blocked = pendingAgeBlock(db, customerId, Number(now()) || Date.now(), Number(maxPendingAgeMs), logger);
      if (blocked) {
        logger.info?.(`qualify-answer-pending: ไม่ตอบข้อความค้าง (${blocked}) — ห้องขึ้นคิวรอตอบให้ทีม`);
        return { skipped: blocked };
      }
    }
    // offAt: คนกดเปิดไม่แตะสถานะ (offAt ของรอบเหลืองยังอยู่) · ตัวกวาดเปิดเขียวจดสถานะใหม่ที่ไม่มี offAt แล้ว
    // yellowOffAtFor จึงตกไปอ่าน audit ai_off_not_qualified ล่าสุดแทน (ขอบล่างอีกชั้นคือคำตอบล่าสุดของฝั่งเรา)
    // รอยต่อนี้มีเทสต์ของจริงทั้งเส้นที่ qualify-sweep-wiring (รีวิวปรปักษ์ 5 ต.ค. #9)
    const offAt = yellowOffAtFor(db, customerId);
    const withHeld = typeof pipeline?.handleInboundText === "function"
      ? {
        handleInboundText: (args = {}) => {
          // ข้อความที่ answerPendingInbound ส่งซ้ำ = ข้อความล่าสุด → ตัดออกจากชุดค้าง ไม่ให้โมเดลเห็นซ้ำ
          const heldParts = collectYellowHeldParts(db, customerId, { offAt, incoming: [args.text], logger });
          auditYellowHeldMerged(db, customerId, heldParts.length, via, logger);
          return pipeline.handleInboundText(heldParts.length ? { ...args, heldParts } : args);
        },
      }
      : pipeline; // ไม่มี pipeline = answerPendingInbound ปักธงให้คนตอบเอง (ห้ามเดาแทนคน)
    return answerPendingInbound({
      db, pipeline: withHeld, notifier, customerId, logger,
      auditAction: QUALIFY_PENDING_AUDIT_ACTION,
      auditDetail,
    });
  };
}
