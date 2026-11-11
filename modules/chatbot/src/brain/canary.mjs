// brain/canary.mjs — กติกาของ "รุ่นทดลอง": ใครอยู่ฝั่งไหน และอะไรที่ทดลองไม่ได้
//
// แยกออกจาก store/runtime เพราะทั้งสองไฟล์ต้องใช้ตัวเดียวกัน และเพราะกติกาสองข้อนี้
// คือหัวใจของความปลอดภัยฝั่ง canary ทั้งหมด ควรอ่านจบได้ในหน้าเดียว
import { createHash } from "node:crypto";

/**
 * ชนิดการ์ดที่ "ทดลองกับบางห้อง" ไม่ได้ (แบบแปลน §6 Step 5 · §7 "ชนิดที่ห้าม canary
 * บังคับในโค้ด") — เพราะมันเป็นค่าที่ต้องเป็นค่าเดียวต่อธุรกิจ ไม่ใช่ต่อห้อง:
 *   price / product / schedule = ตัวเลขและของที่ขาย — ลูกค้าสองคนได้คนละราคาคือเรื่องร้องเรียน
 *   banned_phrase             = ตัวกรอง ถ้าทดลองแปลว่าบางห้องไม่มีตัวกรอง
 *   policy ที่บังคับใช้จริง    = เส้นทาง/ช่อง/การส่ง (enforcement ≠ prompt_only)
 * ที่ทดลองได้คือของที่เป็น "คำพูด": fact, persona_section, template, channel_addendum,
 * media และ policy แบบ prompt_only
 */
export const CANARY_FORBIDDEN_KINDS = Object.freeze(["price", "product", "schedule", "banned_phrase"]);
export const CANARY_REFUSAL_CODE = "canary_not_supported_for_kind";

/** 0-99 จาก customer_id — เสถียรข้าม process ข้ามเครื่อง และไม่ขึ้นกับเวลา */
export function customerBucket(customerId) {
  return createHash("sha256").update(String(customerId ?? "")).digest().readUInt32BE(0) % 100;
}

/**
 * ห้องนี้อยู่ฝั่ง canary ไหม (บริสุทธิ์ ทดสอบแยกได้)
 *
 * ลำดับ: หมดอายุการทดลองแล้ว -> ไม่ · ระบุตัวผู้ทดสอบไว้ -> ตามรายชื่อล้วน ·
 * ระบุช่องทางไว้ -> ห้องนอกช่องทางไม่เข้าข่าย · ที่เหลือ -> ตามเปอร์เซ็นต์ของ hash
 */
export function inCanaryCohort(canary = {}, { customerId, channelId, atMs = null } = {}) {
  if (!canary || typeof canary !== "object") return false;
  const until = Number(canary.until);
  if (Number.isFinite(until) && until > 0 && atMs !== null && Number(atMs) >= until) return false;

  const testers = Array.isArray(canary.tester_ids) ? canary.tester_ids.map(String) : [];
  if (testers.includes(String(customerId))) return true;

  const channels = Array.isArray(canary.channels) ? canary.channels.map(String) : [];
  if (channels.length && !channels.includes(String(channelId || "default"))) return false;

  const percent = Number(canary.percent);
  if (!Number.isFinite(percent) || percent <= 0) return false;
  // 100 = ทุกห้อง · ค่าที่เกิน 100 ถือเป็น 100 (ไม่ใช่ "ไม่มีใคร" ซึ่งเป็นทิศที่โกหก)
  return customerBucket(customerId) < Math.min(100, percent);
}

function forbiddenKind(rev) {
  if (CANARY_FORBIDDEN_KINDS.includes(String(rev.kind))) return true;
  if (String(rev.kind) !== "policy") return false;
  try {
    const enforcement = JSON.parse(String(rev.body_json || "{}"))?.enforcement?.kind;
    return String(enforcement || "prompt_only") !== "prompt_only";
  } catch {
    return true; // อ่าน enforcement ไม่ออก = ถือว่าบังคับใช้จริง (fail-closed)
  }
}

/**
 * ชนิดที่ทดลองไม่ได้ ต่างกันระหว่างรุ่นที่จะตั้งเป็น canary กับรุ่น live หรือเปล่า
 *
 * เทียบด้วย (kind, key) -> body_sha256 ทั้งสองทาง: เพิ่ม / หาย / แก้ ถือเป็นความต่างหมด
 * @returns {{kind: string, key: string, change: "added"|"removed"|"changed"}[]}
 */
export function canaryKindConflicts(candidateRevs = [], liveRevs = []) {
  const index = (revs) => new Map(revs.filter(forbiddenKind).map((rev) => [`${rev.kind} ${rev.key}`, rev]));
  const candidate = index(candidateRevs);
  const live = index(liveRevs);
  const out = [];
  for (const [id, rev] of candidate) {
    const before = live.get(id);
    if (!before) out.push({ kind: rev.kind, key: rev.key, change: "added" });
    else if (before.body_sha256 !== rev.body_sha256) out.push({ kind: rev.kind, key: rev.key, change: "changed" });
  }
  for (const [id, rev] of live) {
    if (!candidate.has(id)) out.push({ kind: rev.kind, key: rev.key, change: "removed" });
  }
  return out.sort((a, b) => (`${a.kind} ${a.key}` < `${b.kind} ${b.key}` ? -1 : 1));
}

/** ข้อความไทยบรรทัดเดียวสำหรับปฏิเสธ — บอกชนิดและคีย์ ไม่บอกเนื้อ */
export function canaryRefusalMessage(conflicts) {
  const names = conflicts.slice(0, 5).map((item) => `${item.kind}:${item.key} (${item.change})`).join(", ");
  const more = conflicts.length > 5 ? ` และอีก ${conflicts.length - 5} รายการ` : "";
  return `brain: ${CANARY_REFUSAL_CODE} — รุ่นนี้เปลี่ยนของที่ทดลองกับบางห้องไม่ได้ (${names}${more})`
    + " · ราคา สินค้า รอบเรียน คำต้องห้าม และกติกาที่บังคับใช้จริง ต้องเป็นค่าเดียวต่อธุรกิจ"
    + " — เผยแพร่เป็น live ทั้งหมดหรือไม่เลย";
}
