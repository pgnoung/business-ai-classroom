// blueprintCampaignConfig.mjs — ค่าตั้งของแคมเปญ "#AIAGENT → แบบวางระบบ AI Agent ส่งทาง LINE" (11 ต.ค. 2026)
//
// พี่ง้วง (คลาส IESA S-Curve MBA รุ่น 6, 11 ต.ค. 2026): ผู้เรียนสแกน QR กรอกธุรกิจ + งานที่อยากให้ผู้ช่วย AI ทำก่อน
// หน้าเว็บเปิด LINE ให้ข้อความขึ้นต้นด้วย #AIAGENT แล้วผู้เรียนกดส่งเอง → ลูกแพรรับ ตอบรับครั้งเดียว และ
// วันจันทร์ 10:00 ส่ง "การวางระบบ AI Agent" เฉพาะคนนั้น — คำสั่ง 04:15 "เอาให้ไม่กระทบระบบเดิม"
//
// ค่าตั้งเป็น "ข้อมูล" ในตาราง settings (ไม่ใช่ค่าคงที่ในโค้ด) — คลาสหน้าใช้ซ้ำได้ด้วยการเพิ่มแถว:
//   blueprint_campaign:<campaignId>  JSON ของแคมเปญหนึ่งตัว (ดู validateCampaignConfig)
//   blueprint_send_mode              off (ไม่มีแถว = off) | pregenerate | on
//   blueprint_daily_cap_thb          เพดานค่าโมเดลต่อวัน (บาท) ค่าเริ่มต้น 150
// ทุกฟังก์ชันอ่านพัง = "ไม่มีแคมเปญ/ปิด" (ทางที่พิสูจน์แล้วว่าไม่กระทบระบบเดิม)
// campaignId ห้ามมี ":" — คีย์รายคน blueprint_req:<campaignId>:<customerId> ต้องให้ PDPA กวาดตาม segment ได้
export const CAMPAIGN_KEY_PREFIX = "blueprint_campaign:";
export const SEND_MODE_KEY = "blueprint_send_mode";
export const DAILY_CAP_KEY = "blueprint_daily_cap_thb";
export const BLUEPRINT_MODES = Object.freeze(["off", "pregenerate", "on"]);
export const DEFAULT_DAILY_CAP_THB = 150;
export const MAX_DAILY_CAP_THB = 2000;
const MAX_CAMPAIGNS = 20;
const HASHTAG_TAG_RULES_KEY = "hashtag_tag_rules"; // = hashtagTagRules.mjs (อ่านดิบ ไม่ import เพื่อไม่ผูกกรอบป้าย)

const CAMPAIGN_ID = /^[A-Za-z0-9_-]{1,24}$/u;
const KEYWORD = /^#[^\s#@:：]{2,30}$/u;
const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const DAY_MS = 86_400_000;
const BANGKOK_OFFSET_MS = 7 * 3_600_000;

// แคมเปญแรก (คลาสวันอาทิตย์ 11 ต.ค. 2026) — ลงฐานตอนบูตครั้งแรกเฉพาะเครื่องของลูกแพร (businessId)
// ถ้ามีแถวอยู่แล้วไม่เขียนทับ (ค่าที่แก้จากคอนโซลชนะเสมอ) · พ้นช่วงแคมเปญแล้วไม่ลงฐานอีก
export const SEED_BUSINESS_ID = "pngoung-tidkradum";
export const SEED_CAMPAIGNS = Object.freeze([
  Object.freeze({
    campaignId: "IESA6",
    keyword: "#AIAGENT",
    title: "IESA S-Curve MBA รุ่น 6",
    sendAt: "2026-10-12T10:00:00+07:00",
    followupOffDays: 7,
    enabled: true,
  }),
]);

const THAI_DAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

/** "จันทร์ 12 ต.ค. 10:00 น." ตามเวลา Asia/Bangkok */
export function thaiShortDateTime(ms) {
  const d = new Date(Number(ms) + BANGKOK_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${THAI_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${THAI_MONTHS[d.getUTCMonth()]} ${hh}:${mm} น.`;
}

const cleanLine = (value) => String(value ?? "").normalize("NFC").replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/gu, " ").replace(/\s+/gu, " ").trim();

export function defaultTagFor(campaignId) {
  return `ที่มา: ${campaignId} · AI Agent`;
}

export function defaultNoteFor({ title, keyword, sendAtMs }) {
  return `มาจากคลาส ${title} · ส่งโจทย์ "อยากให้ผู้ช่วย AI ทำอะไรก่อน" ผ่าน ${keyword} แล้ว`
    + ` · ทีมพี่ง้วงจะส่งไอเดียการวางระบบ AI Agent ให้ทาง LINE ${thaiShortDateTime(sendAtMs)}`
    + " (ถ้าลูกค้าถามเรื่องนี้ ตอบตามนี้ได้ ห้ามสัญญาเพิ่ม)";
}

/**
 * ตรวจค่าตั้งหนึ่งแคมเปญ → { ok, value } หรือ { ok:false, errors }
 * value = รูปมาตรฐานที่เก็บลงฐาน (ช่องที่ไม่ส่งมาได้ค่าเริ่มต้น) · ไม่แก้ object ที่ส่งเข้ามา
 */
export function validateCampaignConfig(input) {
  const errors = [];
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const campaignId = String(src.campaignId ?? "").trim();
  if (!CAMPAIGN_ID.test(campaignId)) errors.push("campaignId ต้องเป็น A-Z a-z 0-9 _ - ยาว 1-24 ตัว (ห้ามมี :)");
  const keyword = String(src.keyword ?? "").trim();
  if (!KEYWORD.test(keyword)) errors.push("keyword ต้องขึ้นต้นด้วย # ตามด้วย 2-30 ตัวอักษร ไม่มีช่องว่าง");
  const title = cleanLine(src.title);
  if (!title || [...title].length > 80) errors.push("title ต้องมี 1-80 ตัวอักษร");
  const sendAt = String(src.sendAt ?? "").trim();
  const sendAtMs = /(?:Z|[+-]\d{2}:\d{2})$/u.test(sendAt) ? Date.parse(sendAt) : Number.NaN;
  if (!Number.isFinite(sendAtMs)) errors.push("sendAt ต้องเป็นเวลา ISO ที่มีโซนเวลา เช่น 2026-10-12T10:00:00+07:00");
  const followupOffDays = Number(src.followupOffDays ?? 7);
  if (!Number.isInteger(followupOffDays) || followupOffDays < 0 || followupOffDays > 30) errors.push("followupOffDays ต้องเป็นจำนวนเต็ม 0-30");
  if (src.enabled !== undefined && typeof src.enabled !== "boolean") errors.push("enabled ต้องเป็น true/false");
  const maxSendsPerPerson = Number(src.maxSendsPerPerson ?? 2);
  if (!Number.isInteger(maxSendsPerPerson) || maxSendsPerPerson < 1 || maxSendsPerPerson > 3) errors.push("maxSendsPerPerson ต้องเป็น 1-3");
  const model = String(src.model ?? "").trim();
  if (model && !MODEL.test(model)) errors.push("model ต้องเป็นชื่อโมเดลตัวพิมพ์เล็ก (หรือเว้นว่าง = ตามโมเดลตอบแชท)");
  const tag = src.tag === undefined ? defaultTagFor(campaignId) : cleanLine(src.tag);
  if ([...tag].length > 60) errors.push("tag ต้องไม่เกิน 60 ตัวอักษร (ว่าง = ไม่ติดป้าย)");
  const note = src.note === undefined
    ? (Number.isFinite(sendAtMs) && title ? defaultNoteFor({ title, keyword, sendAtMs }) : "")
    : cleanLine(src.note);
  if ([...note].length > 300) errors.push("note ต้องไม่เกิน 300 ตัวอักษร (ว่าง = ไม่เขียนโน้ตที่มา)");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      campaignId, keyword, title, sendAt, followupOffDays,
      enabled: src.enabled !== false, maxSendsPerPerson, model, tag, note,
    },
  };
}

/** แคมเปญที่ใช้งานได้ (แถวพัง = ข้าม) พร้อมเวลาที่คำนวณแล้ว */
function withTimes(value) {
  const sendAtMs = Date.parse(value.sendAt);
  return { ...value, sendAtMs, holdDays: value.followupOffDays, expiresAtMs: sendAtMs + Math.max(1, value.followupOffDays) * DAY_MS };
}

function rangeRows(db, prefix) {
  // ช่วง [prefix, prefix + U+FFFF) — แบบเดียวกับ qualifySweepRules (ไม่ใช้ LIKE เพราะ _ เป็นอักขระพิเศษ)
  return db.raw.prepare("SELECT key, value FROM settings WHERE key >= ? AND key < ? ORDER BY key").all(prefix, `${prefix}￿`);
}

export function readCampaigns(db, { logger = null } = {}) {
  let rows = [];
  try {
    rows = rangeRows(db, CAMPAIGN_KEY_PREFIX).slice(0, MAX_CAMPAIGNS);
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows) {
    try {
      const checked = validateCampaignConfig(JSON.parse(row.value));
      if (checked.ok && `${CAMPAIGN_KEY_PREFIX}${checked.value.campaignId}` === row.key) out.push(withTimes(checked.value));
      else logger?.warn?.(`blueprint: ค่าตั้งแคมเปญ ${row.key} ไม่ถูกต้อง — ข้าม`);
    } catch {
      logger?.warn?.(`blueprint: ค่าตั้งแคมเปญ ${row.key} อ่านไม่ได้ — ข้าม`);
    }
  }
  return out;
}

export function readCampaign(db, campaignId) {
  return readCampaigns(db).find((c) => c.campaignId === campaignId) ?? null;
}

/**
 * คีย์เวิร์ดนี้ชนกับ # ที่ระบบเดิมใช้อยู่ไหม (รายการ # ของธุรกิจ / กติกา # → ป้าย / แคมเปญอื่น)
 * ชน = แคมเปญจะแย่งข้อความของเส้นเดิมไป (เช่นคำที่ auto-response ของ OA ตอบอยู่) → ห้ามบันทึก
 * @returns {string} เหตุผลภาษาไทย หรือ "" ถ้าไม่ชน
 */
export function keywordCollision(db, keyword, { campaignId = "" } = {}) {
  const key = String(keyword || "").trim().toLowerCase();
  const bare = key.replace(/^#/u, "");
  try {
    const stored = JSON.parse(db.getSetting("hashtag_business_keywords") || "{}");
    const keys = Object.keys(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}).map((k) => String(k).trim().toLowerCase());
    if (keys.includes(key) || keys.includes(bare)) return `คีย์เวิร์ด ${keyword} อยู่ในรายการ # ของธุรกิจแล้ว — ใช้คำอื่น`;
  } catch { /* อ่านไม่ได้ = ไม่มีรายการให้ชน */ }
  try {
    const rules = JSON.parse(db.getSetting(HASHTAG_TAG_RULES_KEY) || "{}");
    if (rules && typeof rules === "object" && Object.hasOwn(rules, key)) return `คีย์เวิร์ด ${keyword} มีกติกา # → ป้ายของทีมอยู่แล้ว — ใช้คำอื่น`;
  } catch { /* อ่านไม่ได้ = ไม่มีกติกาให้ชน */ }
  const other = readCampaigns(db).find((c) => c.campaignId !== campaignId && c.keyword.toLowerCase() === key);
  if (other) return `คีย์เวิร์ด ${keyword} เป็นของแคมเปญ ${other.campaignId} อยู่แล้ว`;
  return "";
}

export function saveCampaign(db, value) {
  const checked = validateCampaignConfig(value);
  if (!checked.ok) return checked;
  // ตรวจชนเฉพาะตอน "ตั้งคีย์เวิร์ดใหม่/เปลี่ยนคีย์เวิร์ด" — เปิด/ปิด/เปลี่ยนโมเดลของแคมเปญเดิมไม่ถูกขวาง
  const stored = readCampaign(db, checked.value.campaignId);
  if (!stored || stored.keyword.toLowerCase() !== checked.value.keyword.toLowerCase()) {
    const collision = keywordCollision(db, checked.value.keyword, { campaignId: checked.value.campaignId });
    if (collision) return { ok: false, errors: [collision] };
  }
  db.setSetting(`${CAMPAIGN_KEY_PREFIX}${checked.value.campaignId}`, JSON.stringify(checked.value));
  return { ok: true, value: withTimes(checked.value) };
}

/** ลงแคมเปญตั้งต้นครั้งเดียว — เฉพาะธุรกิจของลูกแพร · มีแถวแล้วไม่แตะ · พ้นช่วงแคมเปญแล้วไม่ลง */
export function seedCampaigns(db, { businessId = "", nowMs = Date.now(), seeds = SEED_CAMPAIGNS } = {}) {
  if (businessId !== SEED_BUSINESS_ID) return [];
  const seeded = [];
  for (const seed of seeds) {
    const checked = validateCampaignConfig(seed);
    if (!checked.ok) continue;
    const key = `${CAMPAIGN_KEY_PREFIX}${checked.value.campaignId}`;
    if (db.getSetting(key) != null) continue;
    if (withTimes(checked.value).expiresAtMs <= nowMs) continue;
    db.setSetting(key, JSON.stringify(checked.value));
    seeded.push(checked.value.campaignId);
  }
  return seeded;
}

/** โหมดส่ง — ไม่มีแถว/ค่าแปลก/อ่านพัง = off */
export function readSendMode(db) {
  try {
    const raw = String(db?.getSetting?.(SEND_MODE_KEY) ?? "").trim().toLowerCase();
    return BLUEPRINT_MODES.includes(raw) ? raw : "off";
  } catch {
    return "off";
  }
}

export function readDailyCapThb(db) {
  try {
    const raw = db?.getSetting?.(DAILY_CAP_KEY);
    if (raw == null || raw === "") return DEFAULT_DAILY_CAP_THB;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.min(MAX_DAILY_CAP_THB, value) : DEFAULT_DAILY_CAP_THB;
  } catch {
    return 0;
  }
}

// คีย์เวิร์ดต้องอยู่ "ต้นข้อความ" เท่านั้น · ไม่สนตัวพิมพ์ · # ต้องติดตัวอักษรตัวแรก (ด่าน CAMPAIGN_KEYWORD ของ pipeline)
// เว้นวรรคแทรกได้ "ไม่เกินหนึ่งช่อง" ("#AI AGENT") — "#A I A G E N T" / "#AI  AGENT" ไม่ใช่คำนี้ (ไม่กว้างจนกินคำอื่น)
// ตัวถัดจากคีย์เวิร์ดต้องไม่ใช่ตัวอักษร/ตัวเลข — "#AIAGENTX" และ "#AIAGENT2" ไม่ใช่คำนี้
const escapeChar = (ch) => ch.replace(/[\\^$.*+?()[\]{}|/-]/gu, "\\$&");
const keywordRegexCache = new Map();
export function keywordRegex(keyword) {
  const key = String(keyword);
  if (!keywordRegexCache.has(key)) {
    const chars = [...key.slice(1)].map(escapeChar);
    const variants = [chars.join("")];
    for (let i = 1; i < chars.length; i += 1) variants.push(`${chars.slice(0, i).join("")}[ \\t]${chars.slice(i).join("")}`);
    keywordRegexCache.set(key, new RegExp(`^\\s*#(?:${variants.join("|")})(?![\\p{L}\\p{M}\\p{N}_])`, "iu"));
  }
  return keywordRegexCache.get(key);
}

/** ข้อความนี้ขึ้นต้นด้วยคีย์เวิร์ดของแคมเปญไหน (เฉพาะที่เปิดอยู่) — ไม่มี = null */
export function campaignForText(text, campaigns) {
  const value = String(text ?? "").normalize("NFC");
  for (const campaign of campaigns) {
    if (campaign.enabled && keywordRegex(campaign.keyword).test(value)) return campaign;
  }
  return null;
}
