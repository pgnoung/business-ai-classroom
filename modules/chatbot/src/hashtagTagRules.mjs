// hashtagTagRules.mjs — คีย์เวิร์ด # → ป้ายของทีม ที่เจ้าของติ๊กเองทีละคำ (ข้อ 8 ของพี่ง้วง 28 ก.ย. 2026)
//
// พี่ง้วง: "บางครั้ง ผมให้พิมพ์ ลงคลาส ด้วย # เช่น #make … มี option ให้เลือก ผมมาติ๊กเองว่า อันนี้ นับเป็นของแจกหรือไม่"
// → ระบบไม่เดาเองว่า # ไหนคือของแจก · ค่าเริ่มต้นทุกคำ = ไม่ติดป้าย · เจ้าของเลือกต่อคำ:
//   ไม่ติด / ของแจก: <ชื่อ> / กิจกรรม: <ชื่อ>  (สองมิติของทีมในกรอบป้ายชุดเดียว)
// ลูกค้าพิมพ์คำนั้นเมื่อไหร่ ติดป้ายให้ทันที (ทั้งคำที่ลูกแพรตอบเอง และคำที่ปล่อยให้ auto-response ของ LINE OA ตอบ)
// เขียนเป็นป้าย source human = กติกาที่ทีมตั้งเอง ระบบไม่ลบ/ไม่เขียนทับภายหลัง · กรอบปิด = ไม่ติดอะไร
import { checkHumanTag, formatFrameworkTag } from "./tagFramework.mjs";

export const HASHTAG_TAG_RULES_KEY = "hashtag_tag_rules";
export const HASHTAG_TAG_DIMENSIONS = Object.freeze(["ของแจก", "กิจกรรม"]);
const KEYWORD = /^[#@][^\s#@]{1,40}$/u;
const MAX_RULES = 200;
const MAX_VALUE = 36;

/** คีย์เวิร์ดตัวแรกของข้อความ ("#Make สนใจค่ะ" → "#make") หรือ "" */
export function hashtagKeywordOf(text) {
  const match = /^\s*([#@][^\s#@]{1,40})/u.exec(String(text || ""));
  return match ? match[1].toLowerCase() : "";
}

function cleanValue(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * ตรวจกติกาหนึ่งข้อก่อนบันทึก — dimension "" = ไม่ติดป้าย (ลบกติกา)
 * @returns {{ ok: true, keyword: string, rule: { dimension: string, value: string } | null } | { ok: false, reason: string }}
 */
export function validateHashtagTagRule({ keyword, dimension, value }, framework) {
  const key = String(keyword || "").trim().toLowerCase();
  if (!KEYWORD.test(key)) return { ok: false, reason: "คีย์เวิร์ดต้องขึ้นต้นด้วย # หรือ @ และไม่มีช่องว่าง (ไม่เกิน 40 ตัวอักษร)" };
  const dim = String(dimension || "");
  if (!dim) return { ok: true, keyword: key, rule: null };
  if (!HASHTAG_TAG_DIMENSIONS.includes(dim)) return { ok: false, reason: "เลือกได้เฉพาะ ไม่ติดป้าย / ของแจก / กิจกรรม" };
  const clean = cleanValue(value);
  if (!clean) return { ok: false, reason: `ใส่ชื่อ${dim}ด้วย เช่น ${dim === "ของแจก" ? "Make Cheat Sheet" : "MOS2026"}` };
  if (clean.length > MAX_VALUE || /[:：]/u.test(clean)) return { ok: false, reason: `ชื่อต้องไม่เกิน ${MAX_VALUE} ตัวอักษรและไม่มีเครื่องหมาย :` };
  if (framework) {
    const check = checkHumanTag(formatFrameworkTag(dim, clean), framework);
    if (!check.ok) return { ok: false, reason: check.reason };
  }
  return { ok: true, keyword: key, rule: { dimension: dim, value: clean } };
}

/** กติกาที่บันทึกไว้ (แถวพัง/ค่าผิดรูป = ข้าม ไม่เดา) */
export function readHashtagTagRules(db) {
  let parsed = {};
  try {
    const raw = db?.getSetting?.(HASHTAG_TAG_RULES_KEY);
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
  const out = {};
  for (const [keyword, rule] of Object.entries(parsed && typeof parsed === "object" ? parsed : {}).slice(0, MAX_RULES)) {
    const checked = validateHashtagTagRule({ keyword, dimension: rule?.dimension, value: rule?.value }, null);
    if (checked.ok && checked.rule) out[checked.keyword] = checked.rule;
  }
  return out;
}

/** บันทึก/ลบกติกาหนึ่งคำ (ผ่าน validateHashtagTagRule มาแล้ว) — คืนกติกาชุดใหม่ */
export function saveHashtagTagRule(db, keyword, rule) {
  const rules = readHashtagTagRules(db);
  if (rule) rules[keyword] = rule;
  else delete rules[keyword];
  db.setSetting(HASHTAG_TAG_RULES_KEY, JSON.stringify(rules));
  return rules;
}

/**
 * ลูกค้าพิมพ์คีย์เวิร์ดที่เจ้าของตั้งกติกาไว้ = ติดป้ายของทีมให้ (ครั้งเดียว ซ้ำ = ไม่ทำอะไร)
 * framework = กรอบที่เปิดอยู่ (activeTagFramework) — null = ไม่ติดอะไร · ทุกความล้มเหลว = เงียบ
 * @returns {string | null} ป้ายที่ติดใหม่
 */
export function applyHashtagTagRule({ db, customerId, text, framework, logger = console }) {
  try {
    if (!framework || String(customerId).startsWith("canary:")) return null;
    const keyword = hashtagKeywordOf(text);
    if (!keyword) return null;
    const rule = readHashtagTagRules(db)[keyword];
    if (!rule) return null;
    const check = checkHumanTag(formatFrameworkTag(rule.dimension, rule.value), framework);
    if (!check.ok) return null;
    // ไม่สร้างแถวลูกค้าเอง (webhook บันทึกข้อความขาเข้าก่อนถึงจุดนี้แล้ว — สร้างเองเสี่ยงได้ช่องทางผิด)
    if (!db.addTag(customerId, check.tag, "human")) return null;
    db.addAudit({ operator: "system", action: "hashtag_tag_auto", target: customerId, detail: `${keyword} → ${check.tag}`.slice(0, 200) });
    return check.tag;
  } catch (err) {
    logger.debug?.(`hashtag tag: ติดป้ายไม่สำเร็จ (${err?.message || err})`);
    return null;
  }
}

/**
 * คีย์เวิร์ดที่ลูกค้าพิมพ์จริงในช่วงหลัง (ข้อความขึ้นต้นด้วย #/@) — ให้เจ้าของเห็นคำที่ใช้อยู่จริง
 * คืนเฉพาะคำ + จำนวนห้อง + ครั้งล่าสุด (ไม่มีรหัส/ข้อความลูกค้า) · คำที่เจอแค่ห้องเดียวไม่คืน
 * (อาจเป็นสิ่งที่ลูกค้าคนเดียวพิมพ์เอง ไม่ใช่คีย์เวิร์ดกิจกรรม)
 */
export function listHashtagKeywordsSeen(db, { now = Date.now(), days = 180, limit = 80, minRooms = 2 } = {}) {
  const since = now - days * 86_400_000;
  const rows = db.raw.prepare(
    `SELECT customer_id, content, created_at FROM messages
     WHERE direction = 'in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'
       AND (content LIKE '#%' OR content LIKE '@%' OR content LIKE ' #%')`,
  ).all(since);
  const seen = new Map();
  for (const row of rows) {
    const keyword = hashtagKeywordOf(row.content);
    if (!keyword) continue;
    const entry = seen.get(keyword) || { keyword, rooms: new Set(), lastAt: 0 };
    entry.rooms.add(row.customer_id);
    entry.lastAt = Math.max(entry.lastAt, Number(row.created_at) || 0);
    seen.set(keyword, entry);
  }
  return [...seen.values()]
    .filter((entry) => entry.rooms.size >= minRooms)
    .map((entry) => ({ keyword: entry.keyword, rooms: entry.rooms.size, lastAt: entry.lastAt }))
    .sort((a, b) => b.rooms - a.rooms || b.lastAt - a.lastAt)
    .slice(0, limit);
}
