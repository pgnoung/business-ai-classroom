// dbAdReferrals.mjs — ที่มาของห้องจากแอด Meta (คำสั่งพี่ง้วง 6 ต.ค. 2026: แอดชุด QUALIFIED MSG
// ต้องรู้ว่า "แอดตัวไหนพาคนแบบไหนมา" — คนหารายได้/ตกงาน หรือคนที่ไปถึงราคาและจ่ายจริง)
//
// เขียนจากขาเข้า Facebook เท่านั้น (adReferral.mjs) — อ่านจากรายงานในคอนโซล (consoleAdReferralsApi.mjs)
// ไม่มีใครอ่านตารางนี้ระหว่างตอบแชท: ไปป์ไลน์/พรอมต์ไม่รู้จักตารางนี้เลยโดยโครงสร้าง
//
// หนึ่งแถว = หนึ่งครั้งที่ Meta บอกว่าห้องนี้มาจากแอด/ลิงก์ (ห้องเดียวคลิกหลายแอดได้หลายแถว · เพดานต่อห้อง)
// event ซ้ำจาก Meta (retry) ชน UNIQUE แล้วถูกทิ้ง — แถวแรกชนะ
//
// PDPA: มีคอลัมน์ customer_id → test/pdpa-cascade.test.mjs ไล่เจอเอง และ resetCustomer ลบให้
// (รวมกรณีไม่มีแถวลูกค้า: เธรดเดิมกดแอดแต่ไม่เคยพิมพ์ — ทางหลักของแถวกำพร้าคือ retention 7 วัน)
// ไม่เก็บข้อความแชท ชื่อ หรือรูปของลูกค้า · ad_title คือหัวข้อแอดของเราเอง ไม่ใช่ข้อมูลคน
// 6 ต.ค. 2026 (ค่ำ, พี่ง้วง "ให้อยู่ในหน้าแชทเหมือน facebook"): เก็บ post_id + รูปแอด (photo_url หรือภาพปก
// video_url) ไว้โชว์แถบ "มาจากโฆษณา" ในหน้าแชท — เป็นรูปแอดของเราเอง ไม่ใช่รูปลูกค้า · ลิงก์ CDN ของ Meta
// หมดอายุได้ หน้าเว็บต้องมีภาพสำรองเสมอ · รายงานรายแอดไม่ใช้สองคอลัมน์นี้
import { SALES_DEAL_FLOW } from "./dbLifecycle.mjs";
import { SYSTEM_CUSTOMER_TAG_SQL } from "./legacyAutoTag.mjs";
import { createHash } from "node:crypto";

/** แถวกำพร้า (ไม่มีแถวลูกค้า) เก็บไว้รอข้อความแรกกี่วัน ก่อน retention กวาดทิ้ง */
export const AD_REFERRAL_ORPHAN_RETENTION_DAYS = 7;
/** เพดานแถวต่อห้อง — ลิงก์ m.me?ref=<อะไรก็ได้> ใครก็กดได้ ห้ามให้ห้องเดียวโตไม่จำกัด (แถวของห้องจริงไม่มีอายุ) */
export const AD_REFERRAL_MAX_PER_CUSTOMER = 20;
/** retention (dbExtra.pruneRetention) ใช้คิวรีนี้ — พารามิเตอร์เดียวคือ cutoff (ms) */
export const ORPHAN_AD_REFERRALS_DELETE_SQL = `DELETE FROM customer_ad_referrals
  WHERE created_at < ?
    AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.line_user_id = customer_ad_referrals.customer_id)`;

export const AD_REFERRAL_SCHEMA = `
-- customer_ad_referrals — ห้องนี้มาจากแอด/ลิงก์ไหน (Meta webhook referral · src/adReferral.mjs เป็นคนเขียน)
--   source      = ADS | SHORTLINK | ... ตามที่ Meta ส่ง (ตัวพิมพ์ใหญ่)
--   type        = OPEN_THREAD ฯลฯ
--   ad_id       = เลขแอดใน Ads Manager (ตัวเลขล้วน · ว่าง = ไม่ใช่แอด เช่นลิงก์ m.me)
--   ref         = ค่า ref ที่เราตั้งในแอด/ลิงก์ (ว่างได้)
--   event_kind  = message (ข้อความแรกหลังคลิกแอด) | postback (ปุ่มเริ่มต้น) | referral (เธรดเดิมกดแอด)
--   first_contact = 1 เมื่อยังไม่มีห้องนี้ในระบบตอนคลิก (เธรด Messenger ที่เก่ากว่าระบบนับเป็นห้องใหม่ด้วย)
--   referral_at = เวลาของ event ตามนาฬิกา Meta (ms) · created_at = เวลาที่ระบบรับ
--   post_id     = โพสต์ของแอด (<page>_<post>) · photo_url = รูปแอด/ภาพปกวิดีโอ (CDN Meta หมดอายุได้)
--   media_type  = photo | video | '' (ไว้ใส่ปุ่ม ▶ บนภาพปก)
CREATE TABLE IF NOT EXISTS customer_ad_referrals (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  channel_id    TEXT NOT NULL DEFAULT 'facebook',
  source        TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT '',
  ad_id         TEXT NOT NULL DEFAULT '',
  ref           TEXT NOT NULL DEFAULT '',
  ad_title      TEXT NOT NULL DEFAULT '',
  event_kind    TEXT NOT NULL DEFAULT '' CHECK (event_kind IN ('', 'message', 'postback', 'referral')),
  first_contact INTEGER NOT NULL DEFAULT 0,
  referral_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  post_id       TEXT NOT NULL DEFAULT '',
  photo_url     TEXT NOT NULL DEFAULT '',
  media_type    TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_ad_referrals_event
  ON customer_ad_referrals(customer_id, referral_at, source, ad_id, ref);
CREATE INDEX IF NOT EXISTS idx_customer_ad_referrals_time ON customer_ad_referrals(referral_at);
-- รีวิว 6 ต.ค. ค่ำ: หา "ลิงก์รูปล่าสุดของแอด" ต้องไม่สแกนทั้งตาราง (20k แถว/แอดค้าง 2,000 แถว = 4.5 วิบน event loop)
CREATE INDEX IF NOT EXISTS idx_customer_ad_referrals_ad ON customer_ad_referrals(ad_id, referral_at);
-- ad_thumbs — สำเนารูปแอด (src/adThumbs.mjs เป็นคนเขียน) ให้แถบในหน้าแชทมีรูปแม้ลิงก์ CDN ของ Meta หมดอายุ
--   หนึ่งแถวต่อแอด · รูปแอดของเพจเราเอง ไม่ผูกลูกค้า · content_type มาจากไบต์หัวไฟล์ (ไม่เชื่อ header)
CREATE TABLE IF NOT EXISTS ad_thumbs (
  ad_id        TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  byte_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  source_url   TEXT NOT NULL DEFAULT '',
  fetched_at   INTEGER NOT NULL
);
`;

/** DB เก่าที่สร้างตารางไปก่อน 6 ต.ค. ค่ำ — db.mjs เติมคอลัมน์ด้วย ensureColumn ตามรายการนี้ */
export const AD_REFERRAL_ADDED_COLUMNS = Object.freeze([
  ["post_id", "post_id TEXT NOT NULL DEFAULT ''"],
  ["photo_url", "photo_url TEXT NOT NULL DEFAULT ''"],
  ["media_type", "media_type TEXT NOT NULL DEFAULT ''"],
]);

// ขั้น lifecycle ที่ "ถึงราคาแล้ว" / "ถึงเลือกรอบแล้ว" = ทิศเดินหน้าของ SALES_DEAL_FLOW จากขั้นนั้น + ขั้นหลังจ่าย
// (derive จากลำดับจริง — เพิ่มขั้นใหม่ในอนาคตแล้วรายงานไม่เงียบผิด · เทสต์ ad-referral-report คุม)
const AFTER_PAYMENT = Object.freeze(["paid_confirmed", "prep_sent"]);
const stagesFrom = (status) => Object.freeze([...SALES_DEAL_FLOW.slice(SALES_DEAL_FLOW.indexOf(status)), ...AFTER_PAYMENT]);
export const AD_REFERRAL_PRICE_STAGES = stagesFrom("price_sent");
export const AD_REFERRAL_ROUND_STAGES = stagesFrom("awaiting_round_choice");
const sqlList = (values) => values.map((value) => `'${value}'`).join(", ");

// ห้องหนึ่งนับให้แอดตัวแรกในช่วง (touches.rn = 1) · ห้องผีที่ไม่มีแถวลูกค้า (กดแอดแต่ไม่เคยพิมพ์) ไม่นับ
// เพราะ retention กวาดทิ้งใน 7 วัน — นับไว้แล้วช่วงเดิมจะหดเอง เปอร์เซ็นต์เทียบข้ามวันไม่ได้
// ผลลัพธ์ทุกตัวต้องเกิด "หลังคลิก" — ลูกค้าเก่ากดแอดใหม่ ห้ามได้เครดิตจากของที่เกิดก่อน
const REPORT_SQL = `
WITH touches AS (
  SELECT r.customer_id, r.ad_id, r.source, r.ref, r.ad_title, r.referral_at,
         MAX(r.first_contact) OVER (PARTITION BY r.customer_id) AS first_contact,
         ROW_NUMBER() OVER (PARTITION BY r.customer_id ORDER BY r.referral_at, r.rowid) AS rn
    FROM customer_ad_referrals r
    JOIN customers c ON c.line_user_id = r.customer_id
   WHERE r.referral_at >= ? AND r.referral_at < ? AND r.customer_id NOT LIKE 'canary:%'
),
firsts AS (
  SELECT customer_id, ad_id, source, ref, ad_title, first_contact, referral_at,
         CASE WHEN ad_id <> '' THEN 'ad:' || ad_id ELSE 'ref:' || source || ':' || ref END AS group_key
    FROM touches WHERE rn = 1
),
-- ชื่อแอดจากคลิกล่าสุดของกลุ่ม (แก้ชื่อแอดกลางแคมเปญแล้วเห็นชื่อใหม่)
titled AS (
  SELECT f.*, FIRST_VALUE(ad_title) OVER (
           PARTITION BY group_key ORDER BY (ad_title <> '') DESC, referral_at DESC) AS latest_title
    FROM firsts f
),
-- เหลือง = audit ของตัวกวาด (ทางเดียวที่ห้องกลายเป็น not_qualified คือ qualifySweep ซึ่งจด audit ทุกครั้ง)
-- อ่านครั้งเดียวด้วยดัชนีเวลา (admin_audit ไม่มีดัชนี target — ห้าม EXISTS รายห้อง)
yellow AS (
  SELECT target AS customer_id, MAX(created_at) AS last_off_at
    FROM admin_audit
   WHERE created_at >= ? AND action = 'ai_off_not_qualified'
   GROUP BY target
),
rooms AS (
  SELECT t.*,
    CASE WHEN y.last_off_at >= t.referral_at THEN 1 ELSE 0 END AS nq,
    CASE WHEN y.last_off_at >= t.referral_at AND c.ai_enabled = 0 AND TRIM(c.ai_off_reason) = 'not_qualified'
         THEN 1 ELSE 0 END AS nq_now,
    CASE WHEN COALESCE(c.price_quoted_at, 0) >= t.referral_at
           OR EXISTS (SELECT 1 FROM lifecycle_events e WHERE e.customer_id = t.customer_id
                        AND e.created_at >= t.referral_at AND e.to_status IN (${sqlList(AD_REFERRAL_PRICE_STAGES)}))
         THEN 1 ELSE 0 END AS price,
    CASE WHEN EXISTS (SELECT 1 FROM lifecycle_events e WHERE e.customer_id = t.customer_id
                        AND e.created_at >= t.referral_at AND e.to_status IN (${sqlList(AD_REFERRAL_ROUND_STAGES)}))
         THEN 1 ELSE 0 END AS round,
    CASE WHEN EXISTS (SELECT 1 FROM lifecycle_events e WHERE e.customer_id = t.customer_id
                        AND e.created_at >= t.referral_at AND e.to_status = 'paid_confirmed')
           OR EXISTS (SELECT 1 FROM enrollments n WHERE n.customer_id = t.customer_id
                        AND n.created_at >= t.referral_at AND n.status IN ('enrolled', 'completed'))
           -- ออเดอร์ต้อง "สร้าง" หลังคลิก — updated_at ขยับตอนส่งของ/แก้ที่อยู่ของออเดอร์เก่าได้
           OR EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = t.customer_id
                        AND o.created_at >= t.referral_at AND o.status IN ('paid', 'shipped', 'done'))
           -- ป้าย customer ที่คนติด — ป้ายที่ระบบโยงชื่อลูกค้าเก่าติดเอง (legacyLink) ไม่ใช่การซื้อจากแอดนี้
           OR (EXISTS (SELECT 1 FROM customer_tags g WHERE g.customer_id = t.customer_id
                         AND g.created_at >= t.referral_at AND lower(g.tag) = 'customer')
               AND NOT ${SYSTEM_CUSTOMER_TAG_SQL("t.customer_id")})
         THEN 1 ELSE 0 END AS paid
    FROM titled t
    JOIN customers c ON c.line_user_id = t.customer_id
    LEFT JOIN yellow y ON y.customer_id = t.customer_id
)
SELECT group_key, MAX(ad_id) AS ad_id, MAX(source) AS source, MAX(ref) AS ref, MAX(latest_title) AS ad_title,
       COUNT(*) AS rooms_opened, SUM(first_contact) AS new_rooms,
       SUM(nq) AS not_qualified, SUM(nq_now) AS not_qualified_now,
       SUM(price) AS reached_price, SUM(round) AS reached_round,
       SUM(CASE WHEN price = 1 OR round = 1 THEN 1 ELSE 0 END) AS reached_price_or_round,
       SUM(paid) AS paid, MIN(referral_at) AS first_at, MAX(referral_at) AS last_at
  FROM rooms
 GROUP BY group_key
 ORDER BY rooms_opened DESC, group_key ASC`;

const METRICS = Object.freeze([
  ["roomsOpened", "rooms_opened"], ["newRooms", "new_rooms"], ["notQualified", "not_qualified"],
  ["notQualifiedNow", "not_qualified_now"], ["reachedPrice", "reached_price"], ["reachedRound", "reached_round"],
  ["reachedPriceOrRound", "reached_price_or_round"], ["paid", "paid"],
]);

// แถบ/ป้ายในคอนโซลนับเฉพาะ "แอดจริง" — ลิงก์ m.me?ref=<อะไรก็ได้> (SHORTLINK) ใครก็กดได้ ห้ามขึ้นป้าย AD
// และห้ามทับแอดจริงที่ลูกค้ากดมาก่อน (รีวิว 6 ต.ค. ค่ำ) · รายงานรายแอดยังนับลิงก์ตามเดิม
const IS_AD_ROW_SQL = "(ad_id <> '' OR source = 'ADS')";
const groupKeyOf = (row) => (row.ad_id ? `ad:${row.ad_id}` : `ref:${row.source}:${row.ref}`);
/** ห้องหนึ่งอ่านทีละห้อง/ทีละหน้ารายการ — หน้ารายการมีได้หลายร้อยห้อง ตัดเป็นก้อนให้พ้นเพดานพารามิเตอร์ SQLite */
const LIST_CHUNK = 400;
/** แถบในหน้าแชทโชว์แอดล่าสุดกี่ตัว (ห้องเดียวมีได้ถึง AD_REFERRAL_MAX_PER_CUSTOMER แถว) */
export const AD_REFERRAL_CARD_MAX_ADS = 5;

/**
 * รวมแถวของห้องเดียว (เรียงเก่า→ใหม่) เป็นรายการแอดใหม่สุดก่อน — คลิกแอดหนึ่งครั้ง Meta ส่งมา 2 event
 * (referral + message) จึงนับเป็นแอดเดียว · ชื่อ/โพสต์/รูปใช้ค่าล่าสุดที่ไม่ว่าง (แก้ชื่อแอดแล้วเห็นชื่อใหม่)
 */
function groupAdTouches(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = groupKeyOf(row);
    const at = Number(row.referral_at) || 0;
    const group = groups.get(key) || {
      key, adId: String(row.ad_id || ""), source: String(row.source || ""), ref: String(row.ref || ""),
      adTitle: "", postId: "", photoUrl: "", mediaType: "", firstAt: at, lastAt: at,
    };
    group.lastAt = Math.max(group.lastAt, at);
    group.firstAt = Math.min(group.firstAt, at);
    if (row.ad_title) group.adTitle = String(row.ad_title);
    if (row.post_id) group.postId = String(row.post_id);
    if (row.photo_url) {
      group.photoUrl = String(row.photo_url);
      group.mediaType = String(row.media_type || "");
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.lastAt - a.lastAt || a.key.localeCompare(b.key));
}

function reportRow(row) {
  const out = {
    key: String(row.group_key), adId: String(row.ad_id || ""), source: String(row.source || ""),
    ref: String(row.ref || ""), adTitle: String(row.ad_title || ""),
    firstAt: Number(row.first_at) || null, lastAt: Number(row.last_at) || null,
  };
  for (const [field, column] of METRICS) out[field] = Number(row[column]) || 0;
  return out;
}

export function createAdReferralDbMethods({ run, all, get, now, newId }) {
  return {
    /** เก็บหนึ่งครั้งที่ Meta บอกที่มา — คืน true เมื่อเป็นแถวใหม่ (event ซ้ำ/ห้องเต็มเพดาน = false) */
    recordAdReferral({
      customerId, channelId = "facebook", source = "", type = "", adId = "", ref = "", adTitle = "",
      eventKind = "", firstContact = false, referralAt, postId = "", photoUrl = "", mediaType = "",
    }) {
      const id = String(customerId || "");
      const at = Number(referralAt);
      if (!id) throw new Error("customer identity is required");
      if (!Number.isFinite(at) || at <= 0) throw new Error("referral time is required");
      const stored = Number(get("SELECT COUNT(*) AS n FROM customer_ad_referrals WHERE customer_id = ?", id)?.n) || 0;
      if (stored >= AD_REFERRAL_MAX_PER_CUSTOMER) return false;
      return run(
        `INSERT OR IGNORE INTO customer_ad_referrals
           (id, customer_id, channel_id, source, type, ad_id, ref, ad_title, event_kind, first_contact, referral_at, created_at,
            post_id, photo_url, media_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), id, String(channelId), String(source), String(type), String(adId), String(ref),
        String(adTitle), String(eventKind), firstContact ? 1 : 0, Math.trunc(at), now(),
        String(postId), String(photoUrl), photoUrl ? String(mediaType) : "",
      ).changes === 1;
    },

    /**
     * แถบ "มาจากโฆษณา" ในหน้าแชท — null = ห้องนี้ไม่ได้มาจากแอด/ลิงก์ (หรือยังไม่ได้เปิดเก็บตอนลูกค้ากด)
     * firstContact = ห้องเปิดครั้งแรกจากแอด (ลูกค้าใหม่) · false = คนที่มีเธรดอยู่แล้วกดแอดกลับมา
     */
    adReferralCardFor(customerId) {
      const rows = all(
        `SELECT ad_id, source, ref, ad_title, post_id, photo_url, media_type, first_contact, referral_at
           FROM customer_ad_referrals WHERE customer_id = ? AND ${IS_AD_ROW_SQL} ORDER BY referral_at, rowid`,
        String(customerId),
      );
      if (!rows.length) return null;
      const ads = groupAdTouches(rows);
      return {
        firstContact: rows.some((row) => Number(row.first_contact) === 1),
        firstAt: Number(rows[0].referral_at) || null,
        lastAt: ads[0].lastAt || null,
        adCount: ads.length,
        ads: ads.slice(0, AD_REFERRAL_CARD_MAX_ADS),
      };
    },

    /** ป้ายบนแถวรายการแชท — แผนที่ customerId → แอดล่าสุดของห้อง (คิวรีเดียวต่อก้อน ไม่อ่านรายห้อง) */
    latestAdReferralsFor(customerIds) {
      const ids = [...new Set((customerIds || []).map(String).filter(Boolean))];
      const byCustomer = new Map();
      for (let i = 0; i < ids.length; i += LIST_CHUNK) {
        const chunk = ids.slice(i, i + LIST_CHUNK);
        const rows = all(
          `SELECT customer_id, ad_id, source, ref, ad_title, referral_at FROM customer_ad_referrals
            WHERE customer_id IN (${chunk.map(() => "?").join(", ")}) AND ${IS_AD_ROW_SQL}
            ORDER BY customer_id, referral_at, rowid`,
          ...chunk,
        );
        const perCustomer = new Map();
        for (const row of rows) {
          const list = perCustomer.get(row.customer_id) || [];
          list.push(row);
          perCustomer.set(row.customer_id, list);
        }
        for (const [customerId, list] of perCustomer) {
          const [latest, ...rest] = groupAdTouches(list);
          byCustomer.set(customerId, {
            adId: latest.adId, source: latest.source, ref: latest.ref, adTitle: latest.adTitle,
            lastAt: latest.lastAt, adCount: rest.length + 1,
          });
        }
      }
      return byCustomer;
    },

    /** เก็บ/แทนที่สำเนารูปของแอด (adThumbs.mjs ตรวจชนิด/ขนาดมาแล้ว) */
    saveAdThumb({ adId, contentType, bytes, sourceUrl = "" }) {
      const id = String(adId || "");
      if (!/^\d{1,32}$/u.test(id)) throw new Error("ad id is invalid");
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      if (!data.length) throw new Error("thumbnail is empty");
      const sha256 = createHash("sha256").update(data).digest("hex");
      run(
        `INSERT INTO ad_thumbs (ad_id, content_type, bytes, byte_size, sha256, source_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ad_id) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes,
           byte_size = excluded.byte_size, sha256 = excluded.sha256, source_url = excluded.source_url,
           fetched_at = excluded.fetched_at`,
        id, String(contentType), data, data.length, sha256, String(sourceUrl).slice(0, 2048), now(),
      );
      return { adId: id, sha256, byteSize: data.length };
    },

    /** รูปของแอดสำหรับเส้นเสิร์ฟ — ไม่มี = null */
    adThumbFor(adId) {
      return get("SELECT ad_id, content_type, bytes, byte_size, sha256, fetched_at FROM ad_thumbs WHERE ad_id = ?", String(adId)) ?? null;
    },

    /** แผนที่ adId → { sha256, fetchedAt } ของแอดที่มีสำเนาแล้ว (ไม่ดึงไบต์รูป) */
    adThumbStamps(adIds) {
      const ids = [...new Set((adIds || []).map(String).filter((id) => /^\d{1,32}$/u.test(id)))];
      if (!ids.length) return new Map();
      const rows = all(
        `SELECT ad_id, sha256, fetched_at FROM ad_thumbs WHERE ad_id IN (${ids.map(() => "?").join(", ")})`, ...ids,
      );
      return new Map(rows.map((row) => [row.ad_id, { sha256: row.sha256, fetchedAt: Number(row.fetched_at) }]));
    },

    /**
     * แอดที่มีลิงก์รูปแต่ยังไม่มีสำเนา — แอดที่คลิกล่าสุดก่อน · ใช้ลิงก์ล่าสุดของแอดนั้น (ลิงก์เก่าหมดอายุก่อน)
     * exclude = แอดที่ตัวเก็บรูปพักไว้ (โหลดพัง) — ตัดใน SQL ไม่งั้นแอดพังเต็มหน้าต่าง แอดใหม่ไม่ได้คิว (รีวิว 6 ต.ค.)
     */
    adsMissingThumb(limit = 20, { exclude = [] } = {}) {
      const skip = [...new Set((exclude || []).map(String).filter((id) => /^\d{1,32}$/u.test(id)))].slice(0, 500);
      return all(
        `SELECT a.ad_id,
                (SELECT r2.photo_url FROM customer_ad_referrals r2
                  WHERE r2.ad_id = a.ad_id AND r2.photo_url <> ''
                  ORDER BY r2.referral_at DESC, r2.rowid DESC LIMIT 1) AS photo_url
           FROM (SELECT ad_id, MAX(referral_at) AS last_at FROM customer_ad_referrals
                  WHERE ad_id <> '' AND photo_url <> '' GROUP BY ad_id) a
          WHERE NOT EXISTS (SELECT 1 FROM ad_thumbs t WHERE t.ad_id = a.ad_id)
            ${skip.length ? `AND a.ad_id NOT IN (${skip.map(() => "?").join(", ")})` : ""}
          ORDER BY a.last_at DESC
          LIMIT ?`,
        ...skip, Math.max(1, Math.min(200, Number(limit) || 20)),
      );
    },

    /** บัญชีโฆษณาล่าสุดที่ส่งยอดค่าแอดเข้ามา (ads_spend) — ไว้ประกอบลิงก์ตัวจัดการโฆษณา · ไม่มี = '' */
    latestAdsAccountId() {
      const row = get("SELECT account_id FROM ads_spend WHERE account_id <> '' ORDER BY day DESC LIMIT 1");
      return String(row?.account_id || "");
    },

    listAdReferrals(customerId) {
      return all(
        "SELECT * FROM customer_ad_referrals WHERE customer_id = ? ORDER BY referral_at, rowid",
        String(customerId),
      );
    },

    /** สิทธิ์ให้ลืม/ล้างห้อง — เรียกจาก resetCustomer ทั้งกรณีมีและไม่มีแถวลูกค้า (อยู่ใน transaction ของมันแล้ว) */
    deleteAdReferralsForCustomer(customerId) {
      return run("DELETE FROM customer_ad_referrals WHERE customer_id = ?", String(customerId)).changes;
    },

    /**
     * รายงานรายแอดของห้องที่ "เปิดจากแอด" ในช่วง [sinceMs, untilMs) — อ่านอย่างเดียว
     * ห้องหนึ่งนับให้แอดตัวแรกในช่วงนั้นตัวเดียว · ผลลัพธ์ (เหลือง/ราคา/รอบ/จ่าย) นับเฉพาะที่เกิดหลังคลิก
     * ผู้เรียกต้องคุมความยาวช่วงเอง (เส้นคอนโซลจำกัด 92 วัน) — คิวรีรันบน event loop เดียวกับแชทลูกค้า
     */
    adReferralReport({ sinceMs, untilMs }) {
      const since = Number(sinceMs);
      const until = Number(untilMs);
      if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) {
        throw new Error("ad referral report range is invalid");
      }
      const rows = all(REPORT_SQL, since, until, since).map(reportRow);
      const totals = Object.fromEntries(METRICS.map(([field]) => [field, rows.reduce((sum, row) => sum + row[field], 0)]));
      const coverage = get(
        `SELECT COUNT(*) AS rooms,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM customer_ad_referrals r WHERE r.customer_id = c.line_user_id)
                         THEN 1 ELSE 0 END) AS with_referral
           FROM customers c
          WHERE c.channel_id = 'facebook' AND c.created_at >= ? AND c.created_at < ?
            AND c.line_user_id NOT LIKE 'canary:%'`,
        since, until,
      ) || {};
      // ศูนย์ = lifecycle_mode ปิดอยู่ช่วงนั้น → "ถึงขั้นเลือกรอบ" นับไม่ได้ (ราคายังนับจาก price_quoted_at)
      const lifecycle = get(
        "SELECT COUNT(*) AS n FROM lifecycle_events WHERE created_at >= ? AND created_at < ?", since, until,
      ) || {};
      const started = get("SELECT MIN(created_at) AS at FROM customer_ad_referrals") || {};
      return {
        rows,
        totals,
        coverage: {
          newFacebookRooms: Number(coverage.rooms) || 0,
          newFacebookRoomsFromReferral: Number(coverage.with_referral) || 0,
          lifecycleEvents: Number(lifecycle.n) || 0,
        },
        captureStartedAt: Number(started.at) || null,
      };
    },
  };
}
