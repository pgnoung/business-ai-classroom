// inboundOutcome.mjs — แปลงค่า return ของ pipeline.handleEvent เป็นสถานะในบัญชีเทิร์น
//
// ก่อนหน้านี้ค่านี้ถูกทิ้งที่ server.mjs และ facebookWebhook.mjs (fire-and-forget)
// เหตุผลความเงียบ 26 แบบจึงไม่เหลือร่องรอยเลย ทำให้แยก "ตั้งใจเงียบ" ออกจาก
// "ตายกลางทาง" ไม่ได้ โมดูลนี้ทำให้คำตัดสินของ pipeline กลายเป็นข้อเท็จจริงถาวร
// โดยไม่ต้องไปแก้จุดตัดสินใจสักจุดเดียว
//
// ห้ามมีบรรทัดใดในไฟล์นี้ส่งข้อความ — หน้าที่เดียวคือ "จด"

// ถ้อยคำของธงต้องตรงกับความจริงเป๊ะ ๆ เพราะแอดมินตัดสินใจ "พิมพ์ต่อดีไหม" จากบรรทัดนี้
// stranded_ambiguous = เริ่มส่งไปแล้ว ลูกค้าอาจได้บางส่วน -> ต้องอ่านห้องก่อนพิมพ์
// stranded_crash / stranded_shutdown = ยังไม่ได้เริ่มส่ง -> พิมพ์ตอบได้เลย
export function strandedHandoffMessage(status) {
  return status === "stranded_ambiguous"
    ? "ระบบดับกลางการส่ง — ลูกค้าอาจได้ข้อความบางส่วนแล้ว ต้องมีคนดูก่อนพิมพ์ต่อ"
    : "ระบบดับก่อนบอทได้ตอบ — ข้อความนี้ยังไม่มีใครตอบ";
}

// ปักธง "ต้องมีคนรับต่อ" ให้ห้องหนึ่ง โดยมีกติกาเดียวกันทุกจุดที่เรียก
//
// สองด่านนี้ไม่ใช่ของประดับ:
//   1) ห้องที่ปิด AI อยู่แล้ว (money_line/bank_sent/ป้ายลูกค้า/fb legacy) เป็นของคนจริง
//      อยู่แล้ว บอทไม่มีทางตอบตั้งแต่ต้น ปักธงไปก็เป็นเสียงรบกวนที่ทำให้คนเลิกสนใจธง
//   2) ห้องที่ถูกปักธงไว้แล้ว ห้ามปักซ้ำรัว ๆ — setNeedsHuman ต่อท้าย handoff_summary
//      ทุกครั้งแล้วตัดเหลือ 2000 ตัวท้าย บริบท handoff ของจริง (เคสเงิน/ลูกค้าโกรธ)
//      จะถูกดันหลุดหัวสตริงไปทีละบรรทัดทุกครั้งที่ deploy
export function flagNeedsHumanForTurn(db, customerId, { reason, message, skipIfFlagged = false, logger = console } = {}) {
  try {
    const customer = db.getCustomer(customerId);
    if (customer?.ai_enabled !== 1) return false;
    if (skipIfFlagged && customer?.state === "NEEDS_HUMAN") return false;
    db.setNeedsHuman(customerId, reason, message);
    return true;
  } catch (err) {
    logger.warn?.(`inboundOutcome: ปักธงให้คนรับต่อไม่สำเร็จ (${err?.message || err})`);
    return false;
  }
}

// เทิร์นที่ "เดี๋ยวมีเทิร์นอื่นตอบให้" — ห้าม settle ต้องปล่อยค้าง owed ไว้
// ถ้าเทิร์นนั้นตอบสำเร็จ hook ใน insertMessage จะ range-settle ปิดให้เอง
// ถ้าโปรเซสตายก่อน หนี้ยังค้างให้ boot sweep เห็น = ถูกต้องทั้งสองทาง
const CARRIED = new Set(["merged_forward", "safety_preempted"]);

export function stampInboundOutcome(db, messageId, verdict, logger = console) {
  if (!messageId) return;
  // ปิดเทิร์นนี้ "พร้อมพี่น้องที่รอเทิร์นนี้ตอบให้" เสมอ (ข้อความที่ถูก burst ดูดเข้าไป)
  // ถ้าปิดเฉพาะตัวเอง แถวพี่น้องจะค้าง owed ตลอดไปเมื่อเทิร์นนี้ "ตั้งใจเงียบ"
  // แล้วบูตครั้งหน้าจะปลุกแอดมินด้วยข้อความเท็จว่า "ระบบดับก่อนบอทได้ตอบ"
  const close = (status, reason = "") => db.closeInboundTurnWithEarlier(messageId, { status, reason });
  try {
    if (!verdict || verdict.error) {
      close("stranded_error", String(verdict?.error?.message || "").slice(0, 120));
      return;
    }
    if (verdict.absorbed) return;                       // leader จะปิดให้ (ผ่าน range-settle)
    if (verdict.suppressed && CARRIED.has(verdict.suppressed)) return;
    if (verdict.suppressed === "drain_aborted_before_send") {
      close("stranded_shutdown", "draft_aborted");
      return;
    }
    if (verdict.suppressed) {
      close("silent_by_design", verdict.suppressed);
      return;
    }
    if (verdict.skipped) {
      close("silent_by_design", `skipped:${verdict.skipped}`);
      return;
    }
    if (verdict.blocked) {
      close("silent_by_design", `blocked:${verdict.reason || "unknown"}`);
      return;
    }
    // ---- เส้นที่ "พยายามส่งแล้ว" (verdict มี field sent เสมอ) ----
    // sent === false แปลว่ายิงถึง LINE ไม่สำเร็จ หรือถูกปิดกั้นก่อนถึง provider
    // เดิมเส้นนี้ตกลงมาถึงบรรทัดสุดท้ายแล้วถูกจดว่า 'answered' ทั้งที่ลูกค้าไม่ได้อะไรเลย
    // = ลบสัญญาณ "ลูกค้าไม่ได้รับอะไร" ทิ้ง ซึ่งเป็นเหตุผลเดียวที่ตารางนี้มีอยู่
    if (verdict.sent === false) {
      const send = verdict.sendResult || {};
      if (send.blocked) {
        // ถูกปิดกั้นโดยกติกาของเราเอง (pilot allowlist / live send ปิด / ไม่มี token)
        // = ตั้งใจไม่ส่ง ไม่ใช่ความล้มเหลว แต่ต้องเห็นเหตุผลจริง ห้ามกลืนเป็น answered
        close("silent_by_design", `send_blocked:${send.reason || "unknown"}`);
        return;
      }
      // ส่งไม่สำเร็จจริง (โควตา push หมด 429 / เครือข่ายล่ม / provider ปฏิเสธ)
      // pipeline ปักธง send_failed ให้แล้ว ตรงนี้แค่ทำให้บัญชีตรงกับความจริง
      close("stranded_error", `send_failed:${send.status ?? send.reason ?? "unknown"}`);
      return;
    }
    // ส่งสำเร็จ = hook ใน insertMessage ปิดไปแล้ว UPDATE นี้จึงไม่โดนอะไร
    // (ทุก UPDATE มี AND status IN ('owed','sending'))
    close("answered", "");
  } catch (err) {
    logger.warn?.(`inboundOutcome: จดผลลัพธ์ไม่สำเร็จ (${err?.message || err})`);
  }
}
