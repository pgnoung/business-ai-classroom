// blueprintStore.mjs — คำขอแบบวางระบบ AI Agent รายคน เก็บในตาราง settings (ไม่สร้าง/ไม่แก้ตาราง)
//
// คีย์: blueprint_req:<campaignId>:<customerId> → JSON หนึ่งก้อนต่อคนต่อแคมเปญ (ส่งซ้ำ = ก้อนเดิม ล่าสุดชนะ)
// PDPA: resetCustomer กวาดคีย์ settings ที่มี id เป็น segment ท้าย (`%:<id>`) อยู่แล้ว — ลืมลูกค้า = ก้อนนี้หายด้วย
//       (customerId ของสาขาอื่นมี ":" ในตัว เช่น "branch:U…" ก็ยังเป็น segment ท้ายเหมือนเดิม)
//
// ทุกการเขียนเป็น compare-and-swap บนค่าเดิมทั้งก้อน: อ่าน → แก้ (ฟังก์ชันบริสุทธิ์) → เขียนเฉพาะเมื่อค่าในฐานยังเป็นค่าที่อ่าน
// ในโปรเซสเดียว read-modify-write ไม่มี await คั่นจึงไม่ชนกันเอง ส่วนสองโปรเซส (ช่วงสลับ release) CAS กันการเขียนทับ
export const REQUEST_KEY_PREFIX = "blueprint_req:";
export const STATE_KEY_PREFIX = "blueprint_state:";
export const SPEND_KEY_PREFIX = "blueprint_spend:";

export const ENTRY_STATUSES = Object.freeze([
  "pending", // รอสร้างแบบวางระบบ
  "ready", // สร้างแล้ว รอเวลาส่ง
  "sending", // จองส่งแล้ว (มี retryKey) — ค้าง = ส่งซ้ำด้วย key เดิมได้อย่างปลอดภัย
  "sent",
  "undeliverable", // ส่งไม่ถึง (บล็อก/ไม่ใช่เพื่อน/LINE ปฏิเสธถาวร) — ไม่ลองซ้ำ
  "failed", // สร้างไม่ผ่านครบจำนวนครั้ง หรือส่งล้มเกินจำนวนครั้ง — ทีมดูต่อ
  "skipped", // ไม่ส่งตามกติกา (ขอไม่รับข้อความ/สแปม/ห้องเงียบ)
  "expired", // พ้นช่วงแคมเปญแล้วยังไม่ได้ส่ง
]);

export function requestKey(campaignId, customerId) {
  return `${REQUEST_KEY_PREFIX}${campaignId}:${customerId}`;
}

function parseEntry(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function readEntry(db, campaignId, customerId) {
  const raw = db.getSetting(requestKey(campaignId, customerId));
  return raw == null ? null : parseEntry(raw);
}

/** ทุกคำขอของแคมเปญ (หรือทุกแคมเปญเมื่อไม่ระบุ) — แถวพังข้าม */
export function listEntries(db, campaignId = "") {
  const prefix = campaignId ? `${REQUEST_KEY_PREFIX}${campaignId}:` : REQUEST_KEY_PREFIX;
  const rows = db.raw.prepare("SELECT key, value FROM settings WHERE key >= ? AND key < ? ORDER BY key")
    .all(prefix, `${prefix}￿`);
  const out = [];
  for (const row of rows) {
    const entry = parseEntry(row.value);
    if (entry && entry.campaignId && entry.customerId && row.key === requestKey(entry.campaignId, entry.customerId)) out.push(entry);
  }
  return out;
}

/**
 * อ่าน-แก้-เขียนแบบ CAS — mutate(entry|null) คืนก้อนใหม่ (object ใหม่) หรือ null = ไม่เปลี่ยน
 * @returns {{ ok: boolean, entry: object|null, changed: boolean, conflict?: boolean }}
 */
export function updateEntry(db, campaignId, customerId, mutate, { attempts = 3 } = {}) {
  const key = requestKey(campaignId, customerId);
  for (let i = 0; i < attempts; i += 1) {
    const raw = db.getSetting(key);
    const current = raw == null ? null : parseEntry(raw);
    const next = mutate(current);
    if (!next) return { ok: true, entry: current, changed: false };
    const value = JSON.stringify(next);
    const result = raw == null
      ? db.raw.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value)
      : db.raw.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?").run(value, key, raw);
    if (Number(result?.changes) === 1) return { ok: true, entry: next, changed: true };
  }
  return { ok: false, entry: null, changed: false, conflict: true };
}

export function countByStatus(entries) {
  const counts = Object.fromEntries(ENTRY_STATUSES.map((status) => [status, 0]));
  for (const entry of entries) {
    if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
  }
  counts.total = entries.length;
  return counts;
}

/* ------------------------- สถานะระดับแคมเปญ (ไม่ผูกลูกค้า) ------------------------- */

export function readCampaignState(db, campaignId) {
  return parseEntry(db.getSetting(`${STATE_KEY_PREFIX}${campaignId}`) ?? "") ?? {};
}

export function writeCampaignState(db, campaignId, state) {
  db.setSetting(`${STATE_KEY_PREFIX}${campaignId}`, JSON.stringify(state));
}

/* ------------------------- ยอดค่าโมเดลต่อวัน (บาท, วันตามเวลาไทย) ------------------------- */

export function readSpendThb(db, day) {
  const value = Number(db.getSetting(`${SPEND_KEY_PREFIX}${day}`));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function addSpendThb(db, day, thb) {
  const add = Number(thb);
  if (!Number.isFinite(add) || add <= 0) return readSpendThb(db, day);
  const next = Math.round((readSpendThb(db, day) + add) * 10_000) / 10_000;
  db.setSetting(`${SPEND_KEY_PREFIX}${day}`, String(next));
  return next;
}
