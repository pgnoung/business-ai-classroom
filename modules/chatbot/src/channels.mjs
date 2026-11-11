// channels.mjs — Multi-OA / multi-branch (หลายสาขาของ "ธุรกิจเดียวกัน" ใช้ instance เดียว)
//
// กติกาสถาปัตยกรรม (HANDOFF §10):
// - สาขาของธุรกิจเดียวกัน = หลาย channel ใน instance + console เดียว (ไฟล์นี้)
// - "คนละลูกค้า/คนละธุรกิจ" ยังต้องแยก instance เสมอ — isolation ข้ามธุรกิจได้ฟรี
//   จากสถาปัตยกรรม 1 ลูกค้า = 1 chassis + 1 DB ห้ามเอา channels มายุบรวม
//
// การตั้งค่า: env CHANNELS_FILE ชี้ไฟล์ JSON (chmod 600 นอก git) รูปแบบ:
//   [{ "id": "ratchada", "name": "สาขารัชดา", "channelSecret": "...",
//      "channelAccessToken": "...", "active": true, "basicId": "@abc1234" }, ...]
//   basicId (ไม่บังคับ, 28 ก.ย. 2026) = LINE ID ของ OA สำหรับลิงก์เชิญจาก Facebook (identityLink.mjs)
//   โหมด legacy อ่านจาก env LINE_BASIC_ID · ผิดรูป = ไม่มี (ห้ามเดา) — ไม่ใช่ความลับ แต่ต้องมาจากการตั้งค่าเสมอ
// - ไม่มีไฟล์/ไฟล์พัง = โหมด legacy: channel เดียว id "default" จาก env
//   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN (backward compatible 100%)
// - loader tolerant: entry ที่ผิดรูปถูกข้ามพร้อม warn — ห้าม log ค่า secret เด็ดขาด
//
// Customer key (การตัดสินใจที่จงใจ — อ่านก่อนแก้):
// ลูกค้า LINE คนเดียวที่ทักเข้า 2 OA ต้องเป็น "คนละแถว" ใน customers
// ทางเลือกที่ invasive น้อยที่สุดและถูกต้อง: เข้ารหัส channel ลง key เดิม
//   - channel "default"  -> key = <lineUserId>  (แถวเก่าทุกแถวถูกต้องทันที ไม่ต้อง migrate)
//   - channel อื่น       -> key = "<channelId>:<lineUserId>"
// เหตุผลที่ไม่ rebuild PK เป็น (line_user_id, channel_id): SQLite เปลี่ยน PK ต้อง
// สร้างตารางใหม่ + ตารางลูกทุกตัว (messages/followups/score/slip/notes/corrections/
// llm_usage) อ้าง customer_id เป็นคอลัมน์เดียว — scoped key ทำให้ตารางลูกแยกต่อ
// channel ได้ฟรีโดยไม่แตะ query ใด ๆ; LINE user id (U + hex 32 ตัว) ไม่มี ":" อยู่แล้ว
// ข้อแลกเปลี่ยน: ก่อนยิง LINE API ต้องถอด raw user id ด้วย rawUserId() เสมอ
// - channel id ห้ามมี ":" และห้ามใช้คำสงวน "canary" (ตัวกรอง 'canary:%' ใน db.mjs)
import { readFileSync } from "node:fs";
import { normalizeLineBasicId } from "./identityLinkCodes.mjs";

export const DEFAULT_CHANNEL_ID = "default";
const CHANNEL_ID_RE = /^[a-zA-Z0-9_-]{1,50}$/;
const RESERVED_IDS = new Set(["canary"]); // 'canary:%' = ลูกค้าสังเคราะห์ใน db.mjs

// channel legacy จาก env — ใช้เมื่อไม่มี CHANNELS_FILE (พฤติกรรมเดิมทุกประการ)
function legacyChannel(config) {
  return {
    id: DEFAULT_CHANNEL_ID,
    name: config.lineChannelName || "",
    channelSecret: config.lineChannelSecret || "",
    channelAccessToken: config.lineChannelAccessToken || "",
    active: true,
    basicId: normalizeLineBasicId(config.lineBasicId),
  };
}

// โหลดรายการ channel — คืน array เสมอ (อย่างน้อย legacy channel เดียว)
export function loadChannels(config, { logger = console } = {}) {
  if (!config.channelsFile) return [legacyChannel(config)];

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(config.channelsFile, "utf8"));
  } catch (err) {
    logger.warn?.(`channels: อ่าน CHANNELS_FILE ไม่ได้ (${err?.message || err}) — ใช้โหมด legacy channel เดียว`);
    return [legacyChannel(config)];
  }
  if (!Array.isArray(parsed)) {
    logger.warn?.("channels: CHANNELS_FILE ต้องเป็น JSON array — ใช้โหมด legacy channel เดียว");
    return [legacyChannel(config)];
  }

  const channels = [];
  const seen = new Set();
  for (const entry of parsed) {
    const id = String(entry?.id ?? "");
    if (!CHANNEL_ID_RE.test(id) || RESERVED_IDS.has(id.toLowerCase())) {
      logger.warn?.(`channels: ข้าม channel id ไม่ถูกต้อง "${id}" (a-z0-9_- ยาว 1-50, ห้าม "canary")`);
      continue;
    }
    if (seen.has(id)) {
      logger.warn?.(`channels: ข้าม channel id ซ้ำ "${id}"`);
      continue;
    }
    seen.add(id);
    channels.push({
      id,
      name: typeof entry.name === "string" ? entry.name.trim().slice(0, 100) : "",
      channelSecret: typeof entry.channelSecret === "string" ? entry.channelSecret : "",
      channelAccessToken: typeof entry.channelAccessToken === "string" ? entry.channelAccessToken : "",
      active: entry.active !== false,
      basicId: normalizeLineBasicId(entry.basicId),
    });
  }
  if (!channels.length) {
    logger.warn?.("channels: CHANNELS_FILE ไม่มี channel ที่ใช้ได้ — ใช้โหมด legacy channel เดียว");
    return [legacyChannel(config)];
  }
  logger.log?.(`[channels] โหลด ${channels.length} channel จาก CHANNELS_FILE (active ${channels.filter((c) => c.active).length})`);
  return channels;
}

/* ----------------------- v1.5: Facebook Messenger channel ---------------------- */
// channel ที่สองของธุรกิจเดียวกัน — เข้า registry/console ร่วมกับ LINE channels
// แต่ "ไม่มี channelSecret ของ LINE" โดยตั้งใจ: จะไม่ติด activeChannels ของ LINE webhook
// (verify ไล่ลอง secret จึงไม่แตะ และ lineWebhookDegraded ยังสะท้อนสถานะ LINE ล้วน)
//
// โทเคน/secret เป็น getter สด: ทางหลักคือกรอกจากคอนโซล (DB settings) — เปลี่ยนได้
// โดยไม่ restart; env เป็น bootstrap/override ตอนกู้ระบบหรือเทสต์
export const FACEBOOK_CHANNEL_ID = "facebook";
// ชื่อแถวใน DB settings (ไม่ใช่ค่า credential) — ตัวสแกนของ release builder จับ
// "ชื่อฝั่งซ้ายที่ลงท้าย token/secret ตามด้วย literal" จึงตั้งชื่อ constant เป็นกลาง
export const FB_KEY_PAGE_ACCESS = "fb_page_access_token";
export const FB_KEY_APP = "fb_app_secret";
export const FB_KEY_VERIFY = "fb_verify_token";

export function facebookChannel(config, db) {
  const setting = (key, fallback) => {
    try { return String(db.getSetting(key) || "") || String(fallback || ""); } catch { return String(fallback || ""); }
  };
  return {
    id: FACEBOOK_CHANNEL_ID,
    name: "Facebook",
    provider: "facebook",
    channelSecret: "",
    channelAccessToken: "",
    active: true,
    credentials: () => ({
      pageAccessToken: setting(FB_KEY_PAGE_ACCESS, config.fbPageAccessToken),
      appSecret: setting(FB_KEY_APP, config.fbAppSecret),
      verifyToken: setting(FB_KEY_VERIFY, config.fbVerifyToken),
    }),
  };
}

// customer key ต่อ (channel, LINE user) — ดูเหตุผลของ scheme ที่คอมเมนต์หัวไฟล์
export function customerKey(channelId, userId) {
  const id = String(channelId || DEFAULT_CHANNEL_ID);
  return id === DEFAULT_CHANNEL_ID ? String(userId) : `${id}:${userId}`;
}

// ถอด raw LINE user id จาก customer key — strip เฉพาะ prefix ที่เป็น channel จริง
// ("canary:synthetic" ไม่ใช่ channel -> คืนทั้ง key ตามเดิม เหมือนพฤติกรรมก่อนหน้า)
export function splitCustomerKey(key, knownChannelIds) {
  const s = String(key ?? "");
  const at = s.indexOf(":");
  if (at > 0) {
    const prefix = s.slice(0, at);
    if (knownChannelIds?.has?.(prefix)) return { channelId: prefix, userId: s.slice(at + 1) };
  }
  return { channelId: DEFAULT_CHANNEL_ID, userId: s };
}

export function channelIdOfCustomer(row) {
  return row?.channel_id || DEFAULT_CHANNEL_ID;
}
