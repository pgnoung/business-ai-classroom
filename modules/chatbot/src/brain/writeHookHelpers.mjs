// brain/writeHookHelpers.mjs — ตัวช่วยของ writeHook (แยกออกมาเพื่อคุมขนาดไฟล์ < 400 บรรทัด)
//
// ที่นี่ไม่มีการตัดสินใจเชิงนโยบายเลยแม้แต่ข้อเดียว: ทุกฟังก์ชันเป็น "วิธีเขียน audit /
// วิธีตั้งชื่อรุ่น / วิธีเทียบว่าการ์ดใบไหนถูกแตะ" ซึ่ง writeHook เรียกใช้ ตัวตัดสินว่าจะ
// เผยแพร่หรือไม่ ยังอยู่ที่เดียวใน writeHook.mjs เหมือนเดิม


// ทางเดิมล้วน: เขียนตารางเดิม + แถว audit เดิม ไม่มีคำต่อท้าย ไม่มีเวอร์ชัน
// (แฟล็กปิด หรือยังไม่เคยนำเข้าสมอง — คอนโซลต้องทำงานเหมือนก่อนมีเฟส 1b ทุกตัวอักษร)
export function legacyOnly(db, username, applyLegacy, audit, outcome) {
  // The legacy path still owns live knowledge while versioned reads are off.
  // A failed command/audit must roll back together, just like the versioned path.
  // Successful response and audit payloads remain unchanged.
  return db.brainTransaction(() => {
    const applied = applyLegacy();
    if (audit?.action) {
      db.addAudit({ operator: username, action: audit.action, target: audit.target ?? "", detail: audit.detail ?? "" });
    }
    return { ok: true, outcome, applied };
  });
}

// ห้ามกลืน error ของ addAudit: ที่นี่ยังอยู่ในธุรกรรมของ hook การโยนจึงหมายถึง "ทั้งการเขียน
// และแถว audit หายไปด้วยกัน" ซึ่งถูกต้องกว่า "ของเปลี่ยนแล้วแต่ไม่มีหลักฐานว่าใครเปลี่ยน"
// (เป็นความล้มเหลวรูปเดียวกับที่แก้ให้ทางแฟล็กปิดไปแล้ว — ทางแฟล็กเปิดก็ต้องไม่ต่างกัน)
export function writeAudit(db, username, audit, note, { kind = "", outcome = "" } = {}) {
  {
    if (audit?.action) {
      db.addAudit({
        operator: username, action: audit.action, target: audit.target ?? "",
        detail: [audit.detail, note].filter(Boolean).join(" · "),
      });
      return;
    }
    // เส้นที่เขียน audit เองข้างใน apply (audit: null — เพราะมันเขียนสองแถวขึ้นไป) จะไม่เหลือ
    // แถวไหนเลยเมื่อผลไม่ใช่ live: audit ของมันถูกยกเลิกไปพร้อมกับการเขียนตารางเดิม
    // "ทีมงานกดแล้วไม่มีร่องรอยว่าเคยกด" คือรูปแบบความล้มเหลวที่เฟสนี้ตั้งใจกำจัด
    if (SILENT_OUTCOMES.includes(outcome)) return;
    db.addAudit({
      operator: username, action: "brain_write_outcome", target: String(kind),
      detail: [outcome, note].filter(Boolean).join(" · "),
    });
  }
}

// ผลที่ "ไม่ต้องมีแถวสรุปเพิ่ม": live กับ unchanged มีแถวของ handler เองอยู่แล้ว ส่วน off /
// no_brain_version คือทางเดิมล้วน ต้องเหมือนก่อนมีเฟสนี้ทุกตัวอักษร
const SILENT_OUTCOMES = Object.freeze(["live", "unchanged", "off", "no_brain_version"]);

// ผลที่แปลว่า "ทางเดิมล้วน" — response ต้องไม่มีคี่ย์ `brain` ติดไปด้วยเลย
export const BRAIN_SILENT_OUTCOMES = Object.freeze(["off", "no_brain_version"]);

// ป้ายของรุ่นคือสิ่งเดียวที่คนอ่านในประวัติ — ต้องบอกทั้ง "ของชิ้นไหน" และ "เปลี่ยนเป็นอะไร"
// (audit.target = ชื่อรายการ · audit.detail = ค่าที่เปลี่ยน) ไม่ใช่แค่ค่าลอย ๆ ที่เดาไม่ออก
export function auditLabel(audit, spec) {
  const parts = [audit?.target, audit?.detail].map((part) => String(part || "").trim()).filter(Boolean);
  return (parts.join(" ") || spec.label).slice(0, 120);
}

// item_id ที่ "เพิ่ม / หายไป / เนื้อหรือขอบเขตหรือโหมดฉีดเปลี่ยน"
export function diffTouched(before, after) {
  const key = (card) => `${card.bodySha256}|${card.inject ?? "pin"}|${JSON.stringify(card.scope ?? {})}`;
  const beforeMap = new Map(before.map((card) => [card.itemId, key(card)]));
  const afterMap = new Map(after.map((card) => [card.itemId, key(card)]));
  const touched = new Set();
  for (const [id, sig] of afterMap) if (beforeMap.get(id) !== sig) touched.add(id);
  for (const id of beforeMap.keys()) if (!afterMap.has(id)) touched.add(id);
  return [...touched].sort();
}

export function refusalMessage(report) {
  if (report.verdict === "error") return report.error || "ด่านตรวจของสมองใช้งานไม่ได้ — หยุดการเผยแพร่";
  const first = report.blocking[0];
  const more = report.blocking.length > 1 ? ` (และอีก ${report.blocking.length - 1} ข้อ)` : "";
  return `ยังบันทึกไม่ได้ — ${first?.message || "ด่านตรวจของสมองไม่ผ่าน"}${more}`;
}

export function needsAckMessage(report, seq) {
  const first = report.needsAck[0];
  const more = report.needsAck.length > 1 ? ` และอีก ${report.needsAck.length - 1} ข้อ` : "";
  return `บันทึกเป็นรุ่นสมอง ${seq} แล้ว แต่ยังไม่ได้ใช้งาน เพราะสมองยังมีข้อค้างที่ต้องรับทราบก่อน:`
    + ` ${first?.message || "มีข้อค้าง"}${more}`;
}

// รุ่นที่ "ค้าง" อยู่บนสายของ live ปัจจุบัน — รุ่นทดลอง หรือรุ่นที่รอรับทราบ
export function pendingChildOf(db, liveVersionId) {
  for (const row of db.listBrainVersions(50)) {
    if (row.parent_id !== liveVersionId) continue;
    if (row.pointer === "canary" || row.status === "proposed") return row;
  }
  return null;
}

export function safeJson(text) {
  try { return JSON.parse(String(text || "{}")); } catch { return {}; }
}

export function safeArray(text) {
  try {
    const parsed = JSON.parse(String(text || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
