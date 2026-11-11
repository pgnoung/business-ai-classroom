// dbIdentityLinks.mjs — ตาราง + เมธอด DB ของ "ลูกค้าคนเดียวกันข้ามช่องทาง" (Facebook ↔ LINE, 28 ก.ย. 2026)
//
// ห้องแชทยังเป็นห้องใครห้องมันเหมือนเดิม (customer key ต่อช่องทาง — ดู channels.mjs) ตารางนี้แค่บอกว่า
// "ห้องไหนเป็นคนเดียวกัน": หนึ่งแถวต่อหนึ่งตัวตน ตัวตนที่ถือ person_id เดียวกันคือคนเดียวกัน
//   · หนึ่งคนมีได้ห้องเดียวต่อช่องทาง (unique person_id+channel_id) — Facebook สองบัญชีรวมเป็นคนเดียวไม่ได้
//   · linked_via = code (ลูกค้าส่งรหัสเอง) · team (ทีมเชื่อมมือ) · suggestion (ทีมกดยืนยันจากรายการแนะนำ)
//   · inherited_json = สิ่งที่การเชื่อม "คัดลอกเข้ามาในห้องนี้" (ป้าย/โน้ต/AI เงียบ) — ใช้ถอนคืนตอนยกเลิกการเชื่อม
//     { from, at, tags[], silenced, knownName, pins[], notes: [{ id, about }], followupDisabled }
//     notes[].about = ห้องที่โน้ตนั้นพูดถึง (ลืมห้องนั้นเมื่อไร โน้ตนี้ต้องหายตาม)
// รหัสเก็บเป็น HMAC เท่านั้น (identityLinkCodes.mjs) · ความพยายามส่งรหัสเก็บไว้คุมเพดาน ไม่เก็บตัวข้อความ
// class_type (28 ก.ย. ค่ำ, คำตอบพี่ง้วง) = คลาสที่ทีมเลือกตอนส่งลิงก์ — ฝั่ง LINE รู้ว่าต้องส่งรายละเอียดของคลาสไหน
//   (ฐานเดิมได้คอลัมน์จาก migrateIdentityLinkSchema ตอนเปิด DB · '' = รหัสรุ่นก่อนมีคลาส)
//
// PDPA (test/pdpa-cascade.test.mjs ไล่ตารางจาก schema เอง): ทั้งสามตารางมี customer_id — resetCustomer
// เรียก detachIdentityOnReset เสมอ ซึ่งลบแถวของคนนั้น ล้าง redeemed_by ที่ชี้มาหาเขาในรหัสของห้องอื่น
// และลบโน้ตสรุปที่คัดลอก "จากเขา" ไปไว้ในห้องอื่นของคนเดียวกัน (โน้ตนั้นเป็นเนื้อหาของห้องที่ถูกลืม)
import { maskLinkCodes } from "./identityLinkCodes.mjs";
import { PURCHASED_ORDER_STATUSES } from "./purchaseHistory.mjs";
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";

export const IDENTITY_LINK_SCHEMA = `
CREATE TABLE IF NOT EXISTS customer_identity_links (
  customer_id    TEXT PRIMARY KEY,
  person_id      TEXT NOT NULL,
  channel_id     TEXT NOT NULL,
  linked_via     TEXT NOT NULL CHECK (linked_via IN ('code','team','suggestion')),
  linked_by      TEXT NOT NULL DEFAULT '',
  inherited_json TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_links_person_channel
  ON customer_identity_links(person_id, channel_id);

CREATE TABLE IF NOT EXISTS identity_link_codes (
  code_hash   TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','revoked')),
  issued_via  TEXT NOT NULL CHECK (issued_via IN ('console','auto')),
  issued_by   TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  redeemed_by TEXT NOT NULL DEFAULT '',
  class_type  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_identity_link_codes_customer ON identity_link_codes(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_identity_link_codes_time ON identity_link_codes(created_at);
CREATE INDEX IF NOT EXISTS idx_identity_link_codes_redeemed ON identity_link_codes(redeemed_by);

CREATE TABLE IF NOT EXISTS identity_link_attempts (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_link_attempts_customer ON identity_link_attempts(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_identity_link_attempts_time ON identity_link_attempts(created_at);
`;

export const IDENTITY_LINK_VIAS = Object.freeze(["code", "team", "suggestion"]);
// ผลที่ "ไม่ใช่ความผิดของผู้ส่ง" ไม่นับเข้าเพดาน (เชื่อมสำเร็จ/ส่งซ้ำของตัวเอง)
export const IDENTITY_LINK_OK_OUTCOMES = Object.freeze(["linked", "already_linked"]);
// ไม่ได้ตรวจรหัสจริง (ระบบพักตรวจ/ไม่มีกุญแจ) = ไม่ใช่การเดา — ไม่นับเข้าเพดานไหนเลย
export const IDENTITY_LINK_UNCHECKED_OUTCOMES = Object.freeze(["busy", "unavailable"]);
// ห้องที่ถูกพักแล้วยังยิงต่อ: นับในห้องตัวเอง (พักต่อไป) แต่ไม่นับเข้าเพดานทั้งระบบ — ห้องเดียวลากทุกห้องให้ "busy" ไม่ได้
export const IDENTITY_LINK_THROTTLED_OUTCOMES = Object.freeze(["rate_limited"]);
// สิ่งที่การสืบทอดเขียนไว้ในแถวของห้องปลายทาง (ชุดเดียวกับที่ undoInheritance ถอน)
export const INHERITED_FROM_KEYS = Object.freeze(["from", "at", "tags", "silenced", "knownName", "pins", "classType"]);
const ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_REFERENCE_TAG = "ย้ายจาก LINE OA";

/** คอลัมน์ที่เพิ่มหลังตารางเกิดแล้ว (CREATE TABLE IF NOT EXISTS ไม่เติมให้) — เรียกจาก openDb ทุกบูต */
export function migrateIdentityLinkSchema(db) {
  const cols = db.prepare("PRAGMA table_info(identity_link_codes)").all();
  if (!cols.some((col) => col.name === "class_type")) {
    db.exec("ALTER TABLE identity_link_codes ADD COLUMN class_type TEXT NOT NULL DEFAULT ''");
  }
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text || "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function createIdentityLinkDbMethods({ db, run, all, get, now, newId }) {
  const linkRow = (customerId) => get("SELECT * FROM customer_identity_links WHERE customer_id = ?", String(customerId)) ?? null;
  const personRows = (personId) => all(
    `SELECT l.customer_id, l.person_id, l.channel_id, l.linked_via, l.linked_by, l.inherited_json, l.created_at,
            c.display_name, c.known_name, c.picture_url, c.ai_enabled, c.ai_off_reason, c.state
       FROM customer_identity_links l LEFT JOIN customers c ON c.line_user_id = l.customer_id
      WHERE l.person_id = ? ORDER BY l.created_at, l.rowid`,
    String(personId),
  );

  return {
    /** ห่อชุดคำสั่งให้เป็นก้อนเดียว — ข้างในห้ามเปิด transaction ซ้อน */
    runIdentityLinkTransaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* ปิดไปแล้ว */ }
        throw error;
      }
    },

    getIdentityLinkRow(customerId) {
      return linkRow(customerId);
    },

    identityPersonOf(customerId) {
      return linkRow(customerId)?.person_id ?? null;
    },

    /** ทุกตัวตนของคนเดียวกัน (รวมตัวเอง) — ห้องที่ยังไม่เชื่อมกับใคร = [] */
    listLinkedIdentities(customerId) {
      const personId = linkRow(customerId)?.person_id;
      return personId ? personRows(personId) : [];
    },

    /**
     * ผูกสองห้องเป็นคนเดียวกัน (ต้องเรียกใน runIdentityLinkTransaction)
     * allowMerge = รวมสองคนที่ต่างก็มีห้องเชื่อมอยู่แล้วได้ (ทีมทำเท่านั้น — รหัสของลูกค้าห้ามรวมคนสองคน)
     * @returns {{state: string, personId?: string, added?: string[]}}
     */
    linkIdentityRowsInTx({ aId, bId, via, by = "", allowMerge = false }) {
      const a = String(aId || "");
      const b = String(bId || "");
      if (!IDENTITY_LINK_VIAS.includes(via)) throw new Error("identity link via ไม่ถูกต้อง");
      if (!a || !b || a === b) return { state: "same" };
      const ca = get("SELECT line_user_id, channel_id FROM customers WHERE line_user_id = ?", a);
      const cb = get("SELECT line_user_id, channel_id FROM customers WHERE line_user_id = ?", b);
      if (!ca || !cb) return { state: "missing" };
      if (a.startsWith("canary:") || b.startsWith("canary:")) return { state: "missing" };
      const chA = String(ca.channel_id || "default");
      const chB = String(cb.channel_id || "default");
      if (chA === chB) return { state: "same_channel" };
      const la = linkRow(a);
      const lb = linkRow(b);
      if (la && lb && la.person_id === lb.person_id) return { state: "already", personId: la.person_id };
      const t = now();
      const insert = (id, personId, channelId) => run(
        `INSERT INTO customer_identity_links (customer_id, person_id, channel_id, linked_via, linked_by, inherited_json, created_at)
         VALUES (?, ?, ?, ?, ?, '{}', ?)`,
        id, personId, channelId, via, String(by).slice(0, 80), t,
      );
      const channelsOf = (personId) => new Set(all("SELECT channel_id FROM customer_identity_links WHERE person_id = ?", personId).map((row) => row.channel_id));
      if (la && lb) {
        if (!allowMerge) return { state: "conflict", reason: "both_linked" };
        const keep = channelsOf(la.person_id);
        const moving = all("SELECT customer_id, channel_id FROM customer_identity_links WHERE person_id = ?", lb.person_id);
        if (moving.some((row) => keep.has(row.channel_id))) return { state: "conflict", reason: "channel_taken" };
        run("UPDATE customer_identity_links SET person_id = ? WHERE person_id = ?", la.person_id, lb.person_id);
        return { state: "linked", personId: la.person_id, added: moving.map((row) => row.customer_id) };
      }
      if (la || lb) {
        const existing = la || lb;
        const joiningId = la ? b : a;
        const joiningChannel = la ? chB : chA;
        if (channelsOf(existing.person_id).has(joiningChannel)) return { state: "conflict", reason: "channel_taken" };
        insert(joiningId, existing.person_id, joiningChannel);
        return { state: "linked", personId: existing.person_id, added: [joiningId] };
      }
      const personId = newId();
      insert(a, personId, chA);
      insert(b, personId, chB);
      return { state: "linked", personId, added: [a, b] };
    },

    /** เอาห้องนี้ออกจากคน (ต้องเรียกใน transaction) — เหลือห้องเดียว = ไม่ใช่การเชื่อมแล้ว ลบทิ้งด้วย */
    unlinkIdentityRowInTx(customerId) {
      const row = linkRow(customerId);
      if (!row) return { state: "not_linked" };
      run("DELETE FROM customer_identity_links WHERE customer_id = ?", String(customerId));
      let remaining = personRows(row.person_id);
      if (remaining.length === 1) {
        run("DELETE FROM customer_identity_links WHERE customer_id = ?", remaining[0].customer_id);
        remaining = [{ ...remaining[0], dissolved: true }];
      }
      return { state: "unlinked", personId: row.person_id, removed: row, remaining };
    },

    setIdentityInherited(customerId, value = {}) {
      run("UPDATE customer_identity_links SET inherited_json = ? WHERE customer_id = ?",
        JSON.stringify(value && typeof value === "object" ? value : {}), String(customerId));
    },

    identityInherited(customerId) {
      return parseJson(linkRow(customerId)?.inherited_json);
    },

    /* ------------------------------- รหัสเชื่อมแชท ------------------------------- */

    /** ออกรหัสใหม่ให้ห้องนี้ — รหัสเก่าที่ยังไม่ถูกใช้ถูกยกเลิกในก้อนเดียวกัน (ลิงก์ล่าสุดเท่านั้นที่ใช้ได้) */
    insertIdentityLinkCode({ customerId, codeHash, via, by = "", expiresAt, classType = "" }) {
      if (!codeHash || !["console", "auto"].includes(via)) throw new Error("identity link code ไม่ถูกต้อง");
      const t = now();
      return this.runIdentityLinkTransaction(() => {
        run(
          `UPDATE identity_link_codes SET status = 'revoked', closed_at = ?
            WHERE customer_id = ? AND status = 'active'`,
          t, String(customerId),
        );
        run(
          `INSERT INTO identity_link_codes (code_hash, customer_id, status, issued_via, issued_by, created_at, expires_at, class_type)
           VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
          String(codeHash), String(customerId), via, String(by).slice(0, 80), t, Number(expiresAt), String(classType || "").slice(0, 40),
        );
        return { createdAt: t, expiresAt: Number(expiresAt) };
      });
    },

    revokeIdentityLinkCode(codeHash) {
      return run(
        "UPDATE identity_link_codes SET status = 'revoked', closed_at = ? WHERE code_hash = ? AND status = 'active'",
        now(), String(codeHash),
      ).changes === 1;
    },

    revokeIdentityLinkCodesFor(customerId) {
      return run(
        "UPDATE identity_link_codes SET status = 'revoked', closed_at = ? WHERE customer_id = ? AND status = 'active'",
        now(), String(customerId),
      ).changes;
    },

    findIdentityLinkCode(codeHash) {
      return get("SELECT * FROM identity_link_codes WHERE code_hash = ?", String(codeHash)) ?? null;
    },

    /** ใช้รหัสหนึ่งครั้ง (ต้องเรียกใน transaction) — true เฉพาะคนแรกที่ใช้ทันก่อนหมดอายุ */
    consumeIdentityLinkCodeInTx({ codeHash, redeemedBy }) {
      const t = now();
      return run(
        `UPDATE identity_link_codes SET status = 'consumed', closed_at = ?, redeemed_by = ?
          WHERE code_hash = ? AND status = 'active' AND expires_at > ?`,
        t, String(redeemedBy), String(codeHash), t,
      ).changes === 1;
    },

    latestIdentityLinkCode(customerId) {
      return get(
        `SELECT code_hash, status, issued_via, issued_by, created_at, expires_at, closed_at, class_type
           FROM identity_link_codes WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        String(customerId),
      ) ?? null;
    },

    countIdentityLinkCodes({ customerId = null, sinceMs = 0, via = null, excludeStatus = null } = {}) {
      const where = ["created_at >= ?"];
      const params = [Number(sinceMs) || 0];
      if (customerId !== null) { where.push("customer_id = ?"); params.push(String(customerId)); }
      if (via) { where.push("issued_via = ?"); params.push(String(via)); }
      if (excludeStatus) { where.push("status != ?"); params.push(String(excludeStatus)); }
      return Number(get(`SELECT COUNT(*) AS n FROM identity_link_codes WHERE ${where.join(" AND ")}`, ...params)?.n || 0);
    },

    /** ปิดรหัสในข้อความขาเข้าที่บันทึกไปแล้ว (webhook บันทึกก่อนรู้ว่าเป็นรหัส) — คืน true เมื่อแก้จริง */
    maskIdentityLinkCodesInMessage(messageId) {
      const row = get("SELECT content FROM messages WHERE id = ?", String(messageId));
      if (!row) return false;
      const masked = maskLinkCodes(row.content);
      if (masked === row.content) return false;
      run("UPDATE messages SET content = ? WHERE id = ?", masked, String(messageId));
      return true;
    },

    /* ------------------------ ความพยายามส่งรหัส (คุมเพดาน) ------------------------ */

    recordIdentityLinkAttempt({ customerId, outcome }) {
      const t = now();
      run("DELETE FROM identity_link_attempts WHERE created_at < ?", t - ATTEMPT_RETENTION_MS);
      run("INSERT INTO identity_link_attempts (id, customer_id, outcome, created_at) VALUES (?, ?, ?, ?)",
        newId(), String(customerId), String(outcome).slice(0, 40), t);
    },

    /**
     * รหัสที่เดาผิด (นับทีละรหัส) — customerId = null คือทั้งระบบ
     * ห้องเดียว: นับครั้งที่ถูกพักด้วย (ยิงต่อ = พักต่อ) · ทั้งระบบ: นับเฉพาะรหัสที่ตรวจจริง
     */
    countIdentityLinkFailures({ customerId = null, sinceMs = 0 } = {}) {
      const skip = [
        ...IDENTITY_LINK_OK_OUTCOMES, ...IDENTITY_LINK_UNCHECKED_OUTCOMES,
        ...(customerId === null ? IDENTITY_LINK_THROTTLED_OUTCOMES : []),
      ];
      const params = [Number(sinceMs) || 0, ...skip];
      let sql = `SELECT COUNT(*) AS n FROM identity_link_attempts WHERE created_at >= ? AND outcome NOT IN (${skip.map(() => "?").join(",")})`;
      if (customerId !== null) { sql += " AND customer_id = ?"; params.push(String(customerId)); }
      return Number(get(sql, ...params)?.n || 0);
    },

    /* ----------------------------- ข้อมูลช่วยแนะนำ ----------------------------- */

    /** เบอร์/อีเมลดิบของห้องนี้ (facts ที่ระบบ/ทีมบันทึก + ที่อยู่จัดส่งบนออเดอร์) — ผู้เรียกปรับรูปเอง */
    identityContactValues(customerId) {
      const facts = all(
        `SELECT fact_key, value FROM customer_facts
          WHERE customer_id = ? AND fact_key IN ('contact_phone','contact_email')`,
        String(customerId),
      );
      const orders = all(
        "SELECT shipping_json FROM orders WHERE customer_id = ? AND shipping_json <> '' ORDER BY created_at DESC LIMIT 20",
        String(customerId),
      );
      return { facts, orders };
    },

    /** ทุกเบอร์/อีเมลในระบบ (มีเพดาน) — ใช้หาห้องอื่นที่ข้อมูลติดต่อตรงกันเป๊ะ */
    allIdentityContactValues({ limit = 20_000 } = {}) {
      const cap = Math.max(1, Math.min(50_000, Number(limit) || 20_000));
      return {
        facts: all(
          `SELECT customer_id, fact_key, value FROM customer_facts
            WHERE fact_key IN ('contact_phone','contact_email') AND customer_id NOT LIKE 'canary:%' LIMIT ?`,
          cap,
        ),
        orders: all(
          `SELECT customer_id, shipping_json FROM orders
            WHERE shipping_json <> '' AND customer_id NOT LIKE 'canary:%' ORDER BY created_at DESC LIMIT ?`,
          cap,
        ),
      };
    },

    /** ห้องที่ยังเคลื่อนไหวอยู่ (ไม่รวมห้องอ้างอิงระบบเก่า/canary) — สำหรับเทียบชื่อแบบคำใบ้ */
    /**
     * 30 ก.ย. 2026 (พี่ง้วง: ลูกค้าแอดไลน์แล้วไม่ส่งรหัส · ชื่อ FB กับ LINE ไม่ตรงกัน "LINE ใช้ชื่อเล่น"): จับคู่ด้วยจังหวะเวลาแทน
     * ลิงก์เชิญที่ยังไม่มีใครใช้ (active = ไม่ถูกแทน ไม่หมดอายุ) ที่ส่งในช่วงเวลา — ห้อง Facebook ที่รอลูกค้าไปแอดไลน์
     */
    openIdentityInvites({ sinceMs = 0, untilMs = Number.MAX_SAFE_INTEGER, nowMs = Date.now(), limit = 20 } = {}) {
      return all(
        `SELECT customer_id, class_type, created_at FROM identity_link_codes
          WHERE status = 'active' AND created_at >= ? AND created_at <= ? AND expires_at > ?
          ORDER BY created_at DESC LIMIT ?`,
        Number(sinceMs) || 0, Number(untilMs), Number(nowMs) || 0, Math.max(1, Math.min(50, Number(limit) || 20)),
      );
    },

    /** ห้อง LINE ที่เพิ่งเริ่มคุยหรือเพิ่งแอดเพื่อนในช่วงเวลา (ห้อง Facebook/canary/ห้องประวัติ LINE OA เดิมไม่นับ) */
    newLineRoomsBetween({ sinceMs = 0, untilMs = Number.MAX_SAFE_INTEGER, limit = 20 } = {}) {
      return all(
        `SELECT c.line_user_id, c.display_name, c.known_name, c.channel_id,
                MAX(c.created_at, COALESCE(f.changed_at, 0)) AS seen_at
           FROM customers c LEFT JOIN line_follow_state f ON f.customer_id = c.line_user_id AND f.state = 'followed'
          WHERE c.channel_id != ? AND c.line_user_id NOT LIKE 'canary:%'
            AND (c.created_at BETWEEN ? AND ? OR f.changed_at BETWEEN ? AND ?)
            AND NOT EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id = c.line_user_id AND t.tag = ?)
          ORDER BY seen_at DESC LIMIT ?`,
        FACEBOOK_CHANNEL_ID, Number(sinceMs) || 0, Number(untilMs), Number(sinceMs) || 0, Number(untilMs),
        LEGACY_REFERENCE_TAG, Math.max(1, Math.min(50, Number(limit) || 20)),
      );
    },

    /** เวลาที่ห้อง LINE นี้เริ่มคุย/แอดเพื่อนครั้งล่าสุด (ไว้เทียบกับเวลาส่งลิงก์เชิญ) — ไม่รู้ = 0 */
    lineRoomSeenAt(customerId) {
      const row = get(
        `SELECT c.created_at, (SELECT f.changed_at FROM line_follow_state f WHERE f.customer_id = c.line_user_id AND f.state = 'followed') AS followed_at
           FROM customers c WHERE c.line_user_id = ?`,
        String(customerId),
      );
      return Math.max(Number(row?.created_at) || 0, Number(row?.followed_at) || 0);
    },

    listIdentityCandidateRooms({ sinceMs = 0, limit = 4_000 } = {}) {
      return all(
        `SELECT c.line_user_id, c.display_name, c.known_name, c.channel_id, c.updated_at,
                (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id) AS last_message_at
           FROM customers c
          WHERE c.updated_at >= ? AND c.line_user_id NOT LIKE 'canary:%'
            AND NOT EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id = c.line_user_id AND t.tag = ?)
          ORDER BY c.updated_at DESC LIMIT ?`,
        Number(sinceMs) || 0, LEGACY_REFERENCE_TAG, Math.max(1, Math.min(10_000, Number(limit) || 4_000)),
      );
    },

    /** ชื่อสินค้าบนออเดอร์ที่ "ซื้อจริง" (สถานะชุดเดียวกับ RFM) — หลักฐานว่าซื้อคลาสไหน (identityLinkClasses.classTypeFromText) */
    identityPurchasedItemNames(customerId) {
      const marks = PURCHASED_ORDER_STATUSES.map(() => "?").join(",");
      const names = [];
      for (const row of all(`SELECT items_json FROM orders WHERE customer_id = ? AND status IN (${marks}) ORDER BY created_at DESC LIMIT 20`,
        String(customerId), ...PURCHASED_ORDER_STATUSES)) {
        let items = [];
        try { items = JSON.parse(row.items_json || "[]") || []; } catch { items = []; }
        for (const item of Array.isArray(items) ? items : []) {
          const name = String(item?.name || "").trim();
          if (name) names.push(name.slice(0, 120));
        }
      }
      return names;
    },

    /** ออเดอร์ที่จ่ายแล้วของห้องนี้ (สัญญาณ "ซื้อแล้ว" ประกอบกับป้าย customer) */
    identityPaidOrderCount(customerId) {
      return Number(get(
        "SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status IN ('paid','shipped','done')",
        String(customerId),
      )?.n || 0);
    },

    /* ------------------------------- PDPA / reset ------------------------------- */

    /**
     * เรียกจาก resetCustomer (อยู่ใน transaction ของมันแล้ว — ห้ามเปิดซ้อน)
     * ลบทุกแถวของคนนี้ + ตัวชี้ที่ห้องอื่นเก็บไว้ + โน้ตสรุปที่คัดลอกจากห้องนี้ไปไว้ห้องอื่น
     */
    detachIdentityOnReset(customerId) {
      const id = String(customerId);
      run("DELETE FROM identity_link_attempts WHERE customer_id = ?", id);
      run("DELETE FROM identity_link_codes WHERE customer_id = ?", id);
      run("UPDATE identity_link_codes SET redeemed_by = '' WHERE redeemed_by = ?", id);
      const row = linkRow(id);
      if (!row) return { detached: false };
      const others = all(
        "SELECT customer_id, inherited_json FROM customer_identity_links WHERE person_id = ? AND customer_id <> ?",
        row.person_id, id,
      );
      for (const other of others) {
        const inherited = parseJson(other.inherited_json);
        const notes = Array.isArray(inherited.notes) ? inherited.notes : [];
        const aboutMe = notes.filter((note) => note?.about === id);
        for (const note of aboutMe) {
          run("DELETE FROM handoff_notes WHERE id = ? AND customer_id = ?", String(note.id || ""), other.customer_id);
        }
        if (!aboutMe.length && inherited.from !== id) continue;
        const next = { ...inherited, notes: notes.filter((note) => note?.about !== id) };
        // คนที่มี 3 ห้องขึ้นไป แถวของห้องที่เหลือไม่ถูกลบ — ร่องรอยสิ่งที่คัดลอกจากห้องที่ถูกลืม (เช่นชื่อ) ต้องไม่ค้าง
        if (inherited.from === id) for (const key of INHERITED_FROM_KEYS) delete next[key];
        run("UPDATE customer_identity_links SET inherited_json = ? WHERE customer_id = ?", JSON.stringify(next), other.customer_id);
      }
      run("DELETE FROM customer_identity_links WHERE customer_id = ?", id);
      if (others.length === 1) run("DELETE FROM customer_identity_links WHERE customer_id = ?", others[0].customer_id);
      return { detached: true, others: others.length };
    },
  };
}
