// hotLeadWatch.mjs — v1.3.4: ลูกค้าที่ร้อนแล้วเงียบหายต้องมีคนเห็น
//
// เหตุจริง 2026-08-13: ลูกค้าคะแนน 10/10 ให้ชื่อบริษัท เลขผู้เสียภาษี ที่อยู่ครบ
// ถามวิธีโอนเงิน แล้วเงียบไป ระบบไม่ได้ทำอะไรต่อเลย —
//   followups = 0 แถวทั้งฐานข้อมูล, human_owner ว่าง, last_seen_by_operator_at = 0
//   (ไม่เคยมีใครเปิดห้องแชทนี้)
// ภาคติดตามลูกค้าทั้งภาคของคู่มือไม่มีโค้ดรองรับ createFollowup ถูกเรียกจากปุ่มในคอนโซลเท่านั้น
//
// ตัวเฝ้านี้ "ไม่ส่งข้อความหาลูกค้า" เด็ดขาด — การทักลูกค้าต้องมีคนอนุมัติเสมอ
// หน้าที่มันคือติดป้ายและเขียนโน้ตให้ทีมงานเห็นบนคอนโซลว่ามีดีลร้อนค้างอยู่

export const HOT_LEAD_MIN_SCORE = 8;
export const HOT_LEAD_SILENT_MS = 6 * 60 * 60 * 1000; // เงียบเกิน 6 ชั่วโมง = ควรมีคนตาม
export const HOT_LEAD_TAG = "ดีลร้อนค้าง";

/**
 * หาลูกค้าที่ "ร้อนแล้วเงียบ" — บริสุทธิ์ ไม่มีผลข้างเคียง เพื่อให้ทดสอบได้ตรง ๆ
 * @param {Array} customers แถวจากตาราง customers
 * @param {{ now:number, minScore?:number, silentMs?:number }} options
 */
export function findStalledHotLeads(customers, { now, minScore = HOT_LEAD_MIN_SCORE, silentMs = HOT_LEAD_SILENT_MS } = {}) {
  if (!Array.isArray(customers)) return [];
  return customers.filter((row) => {
    if (!row || !row.line_user_id) return false;
    if (!Number.isInteger(row.last_score) || row.last_score < minScore) return false;
    // มีคนรับช่วงแล้ว = ไม่ต้องเตือนซ้ำ (ทีมงานเห็นแล้ว)
    if (String(row.human_owner || "").trim()) return false;
    // เคยมีคนเปิดห้องหลังข้อความล่าสุด = เห็นแล้วเช่นกัน
    const lastSeen = Number(row.last_seen_by_operator_at) || 0;
    const updatedAt = Number(row.updated_at) || 0;
    if (lastSeen >= updatedAt) return false;
    return now - updatedAt >= silentMs;
  });
}

// ข้อความโน้ตต้องบอก "ทำไมถึงต้องรีบ" ไม่ใช่แค่บอกว่ามีเรื่อง
function noteFor(row, now) {
  const hours = Math.floor((now - (Number(row.updated_at) || now)) / (60 * 60 * 1000));
  return `ดีลร้อนค้าง: คะแนนความสนใจ ${row.last_score}/10 และเงียบมา ${hours} ชั่วโมงแล้ว `
    + "โดยยังไม่มีใครรับช่วง — ตรวจประวัติแล้วตัดสินใจว่าจะติดตามอย่างไร "
    + "(ระบบไม่ได้ทักลูกค้าเอง การทักต้องให้คนอนุมัติเสมอ)";
}

/**
 * ติดป้าย + เขียนโน้ตให้ทีมงานเห็น — idempotent ต่อรอบ (ป้ายซ้ำไม่เพิ่มโน้ตซ้ำ)
 * ทุกการเขียนอยู่ใน try/catch เพราะงานเฝ้าห้ามทำให้แชทหลักล้ม
 */
export function flagStalledHotLeads({ db, now = Date.now(), logger = console, minScore, silentMs } = {}) {
  let customers = [];
  try {
    customers = db.listStalledHotLeadCandidates?.() ?? [];
  } catch (err) {
    logger.debug?.(`hotLeadWatch: อ่านรายชื่อลูกค้าไม่สำเร็จ (${err?.message || err})`);
    return { flagged: 0, skipped: true };
  }
  const stamp = typeof now === "function" ? now() : Number(now);
  const stalled = findStalledHotLeads(customers, { now: stamp, minScore, silentMs });
  let flagged = 0;
  for (const row of stalled) {
    try {
      const existing = db.listTags?.(row.line_user_id) ?? [];
      const already = existing.some((tag) => String(tag?.tag ?? tag) === HOT_LEAD_TAG);
      if (already) continue;
      db.addTag?.(row.line_user_id, HOT_LEAD_TAG, "ai");
      db.addHandoffNote?.({
        customerId: row.line_user_id,
        author: "ai_auto",
        text: noteFor(row, stamp),
      });
      flagged += 1;
    } catch (err) {
      logger.debug?.(`hotLeadWatch: ติดป้ายลูกค้า ${row.line_user_id} ไม่สำเร็จ (${err?.message || err})`);
    }
  }
  if (flagged) logger.log?.(`[hotLeadWatch] ติดป้ายดีลร้อนค้าง ${flagged} ราย (ไม่ได้ทักลูกค้า)`);
  return { flagged, scanned: customers.length };
}
