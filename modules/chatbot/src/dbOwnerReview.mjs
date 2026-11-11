// dbOwnerReview.mjs — ห้องตรวจของพี่ง้วง (คำสั่งพี่ง้วง 12 ต.ค. 2026 ค่ำ: "ไม่มีอะไรปิดเองอีกแล้ว")
//
// เฟส A (ข้อเสนอปิดห้อง): รอบตรวจ 09:00/12:00/15:00/19:00 (ownerReviewScheduler.mjs) เสนอห้องที่ท่าทีไม่พาไปสู่การเรียน
//   → พี่ง้วง/ชมพู่กดยืนยันในคอนโซล (ownerCloseService.mjs) → ลูกแพรลาสุภาพ + ห้องเป็นสีเหลือง not_qualified
// เฟส B (คิวตรวจแชทรายวัน 20:00) ใช้ owner_review_batches ชุดเดียวกัน (kind 'daily') + owner_review_items (dbOwnerReviewItems.mjs
//   ประกอบเข้ามาที่นี่ — db.mjs ไม่ต้องรู้จักไฟล์นั้น)
//
// เก็บเฉพาะตัวชี้ + หมวด + เหตุสั้นที่ปิดข้อมูลส่วนตัวแล้ว — ข้อความแชทอยู่ในตาราง messages ที่เดิม ไม่คัดลอกมา
// PDPA: owner_close_proposals มี customer_id (FK ON DELETE CASCADE) → resetCustomer ลบให้ (deleteOwnerReviewForCustomer)
//   test/pdpa-cascade.test.mjs เรียก ensureOwnerReviewTables ก่อนไล่ตาราง · owner_review_batches ไม่ผูกลูกค้า (นับรวมเท่านั้น)
// ตารางสร้างตอนเขียนครั้งแรก (จองรอบ/สร้างข้อเสนอ — แบบ trial_invites) ไม่ใช่ตอนเปิดฐาน: ฐานที่ยังไม่เคยตรวจมีโครงตารางเท่าเดิม
//   — เทสต์ "เหมือนคอมมิต production ทุกไบต์" (blueprint-zero-impact) เทียบทุกตารางในฐาน · อ่านตอนยังไม่มีตาราง = ว่าง
// ไม่มี import จาก db.mjs (กันวงกลม) — db.mjs กระจายเมธอดผ่าน createOwnerReviewDbMethods
import { createOwnerReviewItemDbMethods } from "./dbOwnerReviewItems.mjs";

export const OWNER_REVIEW_BATCH_KINDS = Object.freeze(["scan", "daily"]);
export const OWNER_REVIEW_BATCH_STATUSES = Object.freeze(["building", "ready", "failed"]);
export const OWNER_CLOSE_SOURCES = Object.freeze(["cue_luna", "luna_screen"]);
export const OWNER_CLOSE_STATUSES = Object.freeze([
  "pending", "confirming", "confirmed", "rejected", "closed_silent", "send_failed", "expired",
]);
// ห้องหนึ่งมีข้อเสนอที่ "ยังเปิดอยู่" ได้ทีละอันเท่านั้น (ดัชนี UNIQUE แบบมีเงื่อนไขชุดเดียวกัน)
export const OWNER_CLOSE_OPEN_STATUSES = Object.freeze(["pending", "confirming", "send_failed"]);
export const OWNER_CLOSE_DECIDED_STATUSES = Object.freeze(["confirmed", "rejected", "closed_silent", "expired"]);
export const OWNER_CLOSE_REASON_MAX = 200;
export const OWNER_CLOSE_NOTE_MAX = 300;

const sqlList = (values) => values.map((value) => `'${value}'`).join(",");
const OPEN_SQL = sqlList(OWNER_CLOSE_OPEN_STATUSES);
const DECIDED_SQL = sqlList(OWNER_CLOSE_DECIDED_STATUSES);

export const OWNER_REVIEW_SCHEMA = `
-- owner_review_batches — รอบตรวจของเจ้าของ (ownerReviewScheduler.mjs) · UNIQUE(kind, slot_ms) = จองรอบแบบถาวร (ครั้งเดียวต่อรอบ)
--   kind        = scan (เสนอปิดห้อง 09/12/15/19) | daily (คิวตรวจแชท 20:00 — เฟส B)
--   window_*    = ช่วงข้อความลูกค้าที่รอบนี้ดู (ต่อจากรอบก่อนหน้าพอดี ไม่ซ้อน ไม่ขาด)
--   mode        = shadow (สร้างข้อเสนอ ไม่ปลุกมือถือ) | on
--   status      = building (กำลังทำ — รีสตาร์ตแล้วทำต่อจาก cursor) | ready | failed
--   cursor      = ห้องล่าสุดที่ทำแล้ว "<last_in>:<customer_id>" (keyset) · counts_json = ตัวเลขรวม ไม่มีรหัสห้อง
CREATE TABLE IF NOT EXISTS owner_review_batches (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('scan','daily')),
  slot_ms         INTEGER NOT NULL,
  window_start_ms INTEGER NOT NULL DEFAULT 0,
  window_end_ms   INTEGER NOT NULL DEFAULT 0,
  mode            TEXT NOT NULL DEFAULT 'on' CHECK (mode IN ('shadow','on')),
  status          TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','failed')),
  cursor          TEXT NOT NULL DEFAULT '',
  counts_json     TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  ready_at        INTEGER,
  notified_at     INTEGER,
  UNIQUE (kind, slot_ms)
);
CREATE INDEX IF NOT EXISTS idx_owner_review_batches_status ON owner_review_batches(kind, status, slot_ms);
-- owner_close_proposals — ห้องที่ AI เสนอให้ปิด รอคนยืนยัน (ไม่มีข้อความแชทในตารางนี้)
--   source       = cue_luna (ดอกที่ 1 เจอคำ + Luna ยืนยัน) | luna_screen (Luna อ่านท่าทีห้องที่ไม่มีดอกที่ 1)
--   category     = หมวดของ offtopicCues (OFFTOPIC_CATEGORIES) · cue = หมวดของดอกที่ 1 ('' = ไม่มี)
--   ai_reason    = เหตุสั้นของ Luna (≤200 · ตัดคำพูดในเครื่องหมายคำพูด + ปิดชื่อ/เบอร์/อีเมลแล้ว)
--   baseline_inbound_id = ข้อความลูกค้าล่าสุดที่ข้อเสนอนี้เห็น — ยืนยันได้เมื่อยังไม่มีข้อความใหม่หลังจากนี้
--   status       = pending → confirming → confirmed | closed_silent | send_failed · pending → rejected | expired
--   revision     = กันกดซ้ำสองเครื่อง (ทุกการเปลี่ยนสถานะ +1 · คอนโซลส่งค่าที่เห็นกลับมา)
CREATE TABLE IF NOT EXISTS owner_close_proposals (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers(line_user_id) ON DELETE CASCADE,
  channel_id          TEXT NOT NULL DEFAULT 'default',
  batch_id            TEXT NOT NULL DEFAULT '',
  source              TEXT NOT NULL DEFAULT 'luna_screen' CHECK (source IN ('cue_luna','luna_screen')),
  category            TEXT NOT NULL DEFAULT '',
  cue                 TEXT NOT NULL DEFAULT '',
  ai_reason           TEXT NOT NULL DEFAULT '',
  baseline_inbound_id TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirming','confirmed','rejected','closed_silent','send_failed','expired')),
  outcome             TEXT NOT NULL DEFAULT '',
  owner_note          TEXT NOT NULL DEFAULT '',
  decided_by          TEXT NOT NULL DEFAULT '',
  decided_at          INTEGER,
  revision            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_close_one_open
  ON owner_close_proposals(customer_id) WHERE status IN (${OPEN_SQL});
CREATE INDEX IF NOT EXISTS idx_owner_close_status ON owner_close_proposals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_owner_close_customer ON owner_close_proposals(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_owner_close_batch ON owner_close_proposals(batch_id);
`;

// คอลัมน์ที่ CAS เขียนได้ (allowlist — ชื่อคอลัมน์ไม่เคยมาจากผู้ใช้)
const PATCHABLE = Object.freeze({
  status: "status", outcome: "outcome", ownerNote: "owner_note", decidedBy: "decided_by",
  decidedAt: "decided_at", baselineInboundId: "baseline_inbound_id",
});

const clipText = (value, max) => {
  const chars = Array.from(String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim());
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
};

function parseCursor(cursor) {
  const text = String(cursor || "");
  const cut = text.indexOf(".");
  if (cut <= 0) return null;
  const at = text.slice(0, cut);
  const id = text.slice(cut + 1);
  return /^\d{1,16}$/u.test(at) && /^[\w:-]{1,120}$/u.test(id) ? { at: Number(at), id } : null;
}

function scopeSql(channels) {
  if (!Array.isArray(channels)) return { sql: "1 = 1", values: [] };
  if (!channels.length) return { sql: "1 = 0", values: [] };
  return { sql: `(${channels.map(() => "COALESCE(c.channel_id, 'default') = ?").join(" OR ")})`, values: channels.map(String) };
}

export function createOwnerReviewDbMethods({ db, run, all, get, now, newId }) {
  let ready = false;
  const exists = () => ready || (ready = Boolean(get(`SELECT COUNT(*) = 2 AS ok FROM sqlite_master
    WHERE type = 'table' AND name IN ('owner_review_batches', 'owner_close_proposals')`)?.ok));
  const ensure = () => {
    if (exists()) return;
    db.exec(OWNER_REVIEW_SCHEMA);
    ready = true;
  };
  const proposalById = (id) => (exists() ? get("SELECT * FROM owner_close_proposals WHERE id = ?", String(id)) ?? null : null);
  // เฟส B: คิวตรวจแชทรายวัน (owner_review_items) — ตารางแยก สร้างตอนเขียนครั้งแรกของตัวเอง (ฐานที่มีเฟส A แล้วก็สร้างเพิ่มได้)
  const items = createOwnerReviewItemDbMethods({ db, run, all, get, now, newId });

  return {
    ...items,

    /** สร้างตารางห้องตรวจ (ปกติสร้างเองตอนเขียนครั้งแรก — เทสต์ PDPA เรียกก่อนไล่ตาราง) */
    ensureOwnerReviewTables() {
      ensure();
      items.ensureOwnerReviewItemsTable();
      return true;
    },

    /* ---------------------------------- รอบตรวจ ---------------------------------- */

    /** จองรอบ (INSERT OR IGNORE บน UNIQUE(kind, slot_ms)) — คืนแถวที่จองได้ หรือ null = มีคนจองรอบนี้แล้ว */
    claimOwnerReviewBatch({ kind, slotMs, windowStartMs = 0, windowEndMs = 0, mode = "on" } = {}) {
      if (!OWNER_REVIEW_BATCH_KINDS.includes(kind)) throw new Error("owner review batch kind is invalid");
      ensure();
      const t = now();
      const id = newId();
      const result = run(`INSERT OR IGNORE INTO owner_review_batches
          (id, kind, slot_ms, window_start_ms, window_end_ms, mode, status, cursor, counts_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'building', '', '{}', ?, ?)`,
      id, kind, Number(slotMs), Number(windowStartMs) || 0, Number(windowEndMs) || 0, mode === "shadow" ? "shadow" : "on", t, t);
      return Number(result.changes) === 1 ? get("SELECT * FROM owner_review_batches WHERE id = ?", id) : null;
    },

    ownerReviewBatch(id) {
      if (!exists()) return null;
      return get("SELECT * FROM owner_review_batches WHERE id = ?", String(id)) ?? null;
    },

    ownerReviewBatchForSlot(kind, slotMs) {
      if (!exists()) return null;
      return get("SELECT * FROM owner_review_batches WHERE kind = ? AND slot_ms = ?", String(kind), Number(slotMs)) ?? null;
    },

    /** รอบที่ยังทำไม่เสร็จ (รีสตาร์ต/deploy กลางรอบ) — เก่าก่อน */
    buildingOwnerReviewBatches(kind) {
      if (!exists()) return [];
      return all(`SELECT * FROM owner_review_batches WHERE kind = ? AND status = 'building'
        ORDER BY slot_ms ASC LIMIT 5`, String(kind));
    },

    latestOwnerReviewBatch(kind) {
      if (!exists()) return null;
      return get("SELECT * FROM owner_review_batches WHERE kind = ? ORDER BY slot_ms DESC LIMIT 1", String(kind)) ?? null;
    },

    /** ปลายช่วงของรอบก่อนหน้า (รอบถัดไปดูต่อจากตรงนี้) — 0 = ยังไม่เคยมีรอบ */
    previousOwnerReviewWindowEnd(kind, beforeSlotMs) {
      if (!exists()) return 0;
      return Number(get(`SELECT MAX(window_end_ms) AS at FROM owner_review_batches
        WHERE kind = ? AND slot_ms < ?`, String(kind), Number(beforeSlotMs))?.at) || 0;
    },

    updateOwnerReviewBatch(id, { status, cursor, counts, readyAt, notifiedAt } = {}) {
      if (!exists()) return 0;
      const sets = ["updated_at = ?"];
      const values = [now()];
      if (status !== undefined) {
        if (!OWNER_REVIEW_BATCH_STATUSES.includes(status)) throw new Error("owner review batch status is invalid");
        sets.push("status = ?");
        values.push(status);
      }
      // รอบจบ (ready/failed) = ไม่ต้องทำต่อแล้ว — ล้าง cursor เสมอ (cursor มีรหัสห้อง ห้ามค้างในแถวที่เก็บ 180 วัน · PDPA)
      const finished = status !== undefined && status !== "building";
      if (finished) sets.push("cursor = ''");
      else if (cursor !== undefined) { sets.push("cursor = ?"); values.push(String(cursor).slice(0, 200)); }
      if (counts !== undefined) { sets.push("counts_json = ?"); values.push(JSON.stringify(counts ?? {}).slice(0, 4000)); }
      if (readyAt !== undefined) { sets.push("ready_at = ?"); values.push(readyAt == null ? null : Number(readyAt)); }
      if (notifiedAt !== undefined) { sets.push("notified_at = ?"); values.push(notifiedAt == null ? null : Number(notifiedAt)); }
      return Number(run(`UPDATE owner_review_batches SET ${sets.join(", ")} WHERE id = ?`, ...values, String(id)).changes);
    },

    /**
     * ห้องที่ลูกค้าพิมพ์ใหม่ในช่วงของรอบ (window_start, window_end] และ AI ยังเปิด — เรียงข้อความล่าสุดก่อน (keyset ต่อจาก cursor)
     * cursor = "<last_in>:<customer_id>" ของห้องล่าสุดที่ทำแล้ว · ช่วงเวลาตายตัวต่อรอบ จึงทำต่อหลังรีสตาร์ตได้ลำดับเดิม
     */
    ownerReviewScanCandidates({ windowStartMs, windowEndMs, cursor = "", limit = 100 } = {}) {
      const cut = String(cursor || "").indexOf(":");
      const at = cut > 0 ? Number(String(cursor).slice(0, cut)) : NaN;
      const after = cut > 0 ? String(cursor).slice(cut + 1) : "";
      // "<last_in>:" (รหัสห้องถูกล้างตามสิทธิ์ให้ลืม) = ทำต่อจากเวลานั้น รวมห้องที่เวลาเท่ากัน (customer_id > '' จริงเสมอ)
      const hasCursor = Number.isFinite(at);
      return all(`SELECT m.customer_id AS id, MAX(m.created_at) AS last_in, COUNT(*) AS inbound
          FROM messages m JOIN customers c ON c.line_user_id = m.customer_id
         WHERE m.direction = 'in' AND m.created_at > ? AND m.created_at <= ?
           AND c.ai_enabled = 1 AND c.line_user_id NOT LIKE 'canary:%'
         GROUP BY m.customer_id
        ${hasCursor ? "HAVING (last_in < ? OR (last_in = ? AND m.customer_id > ?))" : ""}
         ORDER BY last_in DESC, m.customer_id ASC
         LIMIT ?`,
      Number(windowStartMs) || 0, Number(windowEndMs) || 0, ...(hasCursor ? [at, at, after] : []),
      Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100)));
    },

    /** ข้อความที่ลูกค้าพิมพ์เองในช่วงของรอบ (เก่า → ใหม่) — ใช้หาดอกที่ 1 */
    ownerReviewWindowInbound(customerId, { windowStartMs, windowEndMs, limit = 12 } = {}) {
      return all(`SELECT id, msg_type, content, created_at FROM messages
         WHERE customer_id = ? AND direction = 'in' AND created_at > ? AND created_at <= ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      String(customerId), Number(windowStartMs) || 0, Number(windowEndMs) || 0, Math.max(1, Number(limit) || 12)).reverse();
    },

    /* ---------------------------------- ข้อเสนอ ---------------------------------- */

    /** สร้างข้อเสนอ — ห้องมีข้อเสนอที่ยังเปิดอยู่แล้ว (UNIQUE) = null ไม่ซ้ำ */
    insertOwnerCloseProposal({ customerId, channelId = "default", batchId = "", source, category, cue = "", aiReason = "", baselineInboundId = "" } = {}) {
      if (!OWNER_CLOSE_SOURCES.includes(source)) throw new Error("owner close source is invalid");
      ensure();
      const id = newId();
      const t = now();
      try {
        run(`INSERT INTO owner_close_proposals
            (id, customer_id, channel_id, batch_id, source, category, cue, ai_reason, baseline_inbound_id,
             status, outcome, owner_note, decided_by, decided_at, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', NULL, 0, ?, ?)`,
        id, String(customerId), String(channelId || "default"), String(batchId || ""), source, String(category || ""),
        String(cue || ""), clipText(aiReason, OWNER_CLOSE_REASON_MAX), String(baselineInboundId || ""), t, t);
      } catch (err) {
        if (/UNIQUE/u.test(String(err?.message || ""))) return null;
        throw err;
      }
      return proposalById(id);
    },

    ownerCloseProposal(id) {
      return proposalById(id);
    },

    /** ข้อเสนอที่ยังเปิดอยู่ของห้องนี้ (pending/confirming/send_failed) — null = ไม่มี */
    openOwnerCloseProposalFor(customerId) {
      if (!exists()) return null;
      return get(`SELECT * FROM owner_close_proposals WHERE customer_id = ? AND status IN (${OPEN_SQL})
        ORDER BY created_at DESC LIMIT 1`, String(customerId)) ?? null;
    },

    /**
     * รายการในคอนโซล — view open (รอยืนยันก่อน · ใหม่ก่อน) | decided (ตัดสินแล้ว · ล่าสุดก่อน)
     * channels = สาขาที่ผู้ดูเห็นได้ (null = ทุกสาขา) · cursor = "<เวลา>.<id>" ของแถวสุดท้ายหน้าก่อน
     */
    listOwnerCloseProposals({ view = "open", channels = null, cursor = "", limit = 30 } = {}) {
      if (!exists()) return { rows: [], hasMore: false, nextCursor: null };
      const decided = view === "decided";
      const scope = scopeSql(channels);
      const orderCol = decided ? "p.updated_at" : "p.created_at";
      const keyset = parseCursor(cursor);
      const where = [`p.status IN (${decided ? DECIDED_SQL : OPEN_SQL})`, scope.sql];
      const params = [...scope.values];
      if (keyset) {
        where.push(`(${orderCol} < ? OR (${orderCol} = ? AND p.id < ?))`);
        params.push(keyset.at, keyset.at, keyset.id);
      }
      const size = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 30));
      const rows = all(`SELECT p.*, c.display_name AS customer_display_name, c.known_name AS customer_known_name,
            c.ai_enabled AS customer_ai_enabled, c.ai_off_reason AS customer_ai_off_reason,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = p.customer_id AND m.direction = 'in') AS last_inbound_at
          FROM owner_close_proposals p JOIN customers c ON c.line_user_id = p.customer_id
         WHERE ${where.join(" AND ")}
         ORDER BY ${orderCol} DESC, p.id DESC LIMIT ?`, ...params, size + 1);
      const hasMore = rows.length > size;
      const page = rows.slice(0, size);
      const tail = page.at(-1);
      return {
        rows: page, hasMore,
        nextCursor: hasMore && tail ? `${decided ? tail.updated_at : tail.created_at}.${tail.id}` : null,
      };
    },

    /** แถวเดียวพร้อมข้อมูลห้อง — คืน null เมื่อห้องอยู่นอกสาขาที่ผู้ดูเห็นได้ */
    ownerCloseProposalScoped(id, channels = null) {
      if (!exists()) return null;
      const scope = scopeSql(channels);
      return get(`SELECT p.*, c.display_name AS customer_display_name, c.known_name AS customer_known_name,
            c.ai_enabled AS customer_ai_enabled, c.ai_off_reason AS customer_ai_off_reason
          FROM owner_close_proposals p JOIN customers c ON c.line_user_id = p.customer_id
         WHERE p.id = ? AND ${scope.sql}`, String(id), ...scope.values) ?? null;
    },

    /**
     * เปลี่ยนสถานะแบบ compare-and-set — ต้องอยู่ในสถานะ from และ revision ตรง (ไม่ส่ง expectedRevision = ไม่เช็ค)
     * ทุกครั้งที่สำเร็จ revision +1 · คืนแถวใหม่ หรือ null = มีคนเปลี่ยนไปก่อนแล้ว
     */
    casOwnerCloseProposal(id, { from = [], expectedRevision = null, patch = {} } = {}) {
      const statuses = (Array.isArray(from) ? from : [from]).filter((value) => OWNER_CLOSE_STATUSES.includes(value));
      if (!statuses.length) throw new Error("owner close CAS needs a from status");
      if (patch.status !== undefined && !OWNER_CLOSE_STATUSES.includes(patch.status)) throw new Error("owner close status is invalid");
      if (!exists()) return null;
      const sets = ["revision = revision + 1", "updated_at = ?"];
      const values = [now()];
      for (const [key, column] of Object.entries(PATCHABLE)) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        if (key === "decidedAt") values.push(patch[key] == null ? null : Number(patch[key]));
        else if (key === "ownerNote") values.push(clipText(patch[key], OWNER_CLOSE_NOTE_MAX));
        else values.push(String(patch[key] ?? "").slice(0, 200));
      }
      const where = [`id = ?`, `status IN (${statuses.map(() => "?").join(",")})`];
      const params = [String(id), ...statuses];
      if (expectedRevision !== null && expectedRevision !== undefined) {
        where.push("revision = ?");
        params.push(Math.trunc(Number(expectedRevision)));
      }
      const changed = Number(run(`UPDATE owner_close_proposals SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`,
        ...values, ...params).changes);
      return changed === 1 ? proposalById(id) : null;
    },

    /** ข้อเสนอที่รอนานเกิน (pending/send_failed สร้างก่อน cutoff) — ให้ผู้เรียกเปลี่ยนเป็น expired ทีละแถว */
    staleOwnerCloseProposals(cutoffMs, limit = 100) {
      if (!exists()) return [];
      return all(`SELECT * FROM owner_close_proposals WHERE status IN ('pending','send_failed') AND created_at < ?
        ORDER BY created_at ASC LIMIT ?`, Number(cutoffMs), Math.max(1, Number(limit) || 100));
    },

    /** ข้อเสนอที่ยังรออยู่ (pending) — ตรวจว่าห้องถูกกัน (คนรับ/จ่ายเงิน/เหลืองแล้ว) หรือยัง */
    pendingOwnerCloseProposals(limit = 100) {
      if (!exists()) return [];
      return all(`SELECT * FROM owner_close_proposals WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
        Math.max(1, Number(limit) || 100));
    },

    /** ค้างสถานะ confirming นานเกิน (โปรเซสตายกลางการยืนยัน) */
    stuckConfirmingOwnerCloseProposals(cutoffMs, limit = 20) {
      if (!exists()) return [];
      return all(`SELECT * FROM owner_close_proposals WHERE status = 'confirming' AND updated_at < ?
        ORDER BY updated_at ASC LIMIT ?`, Number(cutoffMs), Math.max(1, Number(limit) || 20));
    },

    /** ตัวเลขของการ์ด/หัวหน้า — นับตามสถานะ (เฉพาะสาขาที่ผู้ดูเห็นได้) + ที่ตัดสินแล้วตั้งแต่ sinceMs */
    ownerCloseCounts({ channels = null, sinceMs = 0 } = {}) {
      const scope = scopeSql(channels);
      const rows = !exists() ? [] : all(`SELECT p.status AS status, COUNT(*) AS n,
            SUM(CASE WHEN p.decided_at >= ? THEN 1 ELSE 0 END) AS since
          FROM owner_close_proposals p JOIN customers c ON c.line_user_id = p.customer_id
         WHERE ${scope.sql} GROUP BY p.status`, Number(sinceMs) || 0, ...scope.values);
      const by = Object.fromEntries(OWNER_CLOSE_STATUSES.map((status) => [status, { total: 0, since: 0 }]));
      for (const row of rows) {
        if (by[row.status]) by[row.status] = { total: Number(row.n) || 0, since: Number(row.since) || 0 };
      }
      return by;
    },

    /** เวลาสร้างของข้อเสนอที่รอยืนยันล่าสุด (ใช้ทำ id/tag การแจ้งเตือนของเจ้าของ) — 0 = ไม่มี */
    latestPendingOwnerCloseAt() {
      if (!exists()) return 0;
      return Number(get("SELECT MAX(created_at) AS at FROM owner_close_proposals WHERE status = 'pending'")?.at) || 0;
    },

    /** ข้อเสนอของรอบนี้ที่ยังรออยู่ (นับว่ารอบนี้เพิ่มงานให้เจ้าของกี่ห้อง) */
    pendingOwnerCloseCountForBatch(batchId) {
      if (!exists()) return 0;
      return Number(get(`SELECT COUNT(*) AS n FROM owner_close_proposals WHERE batch_id = ? AND status = 'pending'`,
        String(batchId))?.n) || 0;
    },

    /** ข้อเสนอที่เจ้าของกด "ไม่ปิด" ล่าสุดพร้อมเหตุ (ตัวอย่างห้ามปิดให้ Luna — หมวด + เหตุสั้นของเจ้าของเท่านั้น) */
    recentOwnerCloseRejections(limit = 5) {
      if (!exists()) return [];
      return all(`SELECT category, owner_note, decided_at FROM owner_close_proposals
        WHERE status = 'rejected' AND owner_note <> '' ORDER BY decided_at DESC LIMIT ?`, Math.max(1, Number(limit) || 5));
    },

    /** ลบแถวเก่า (ตัดสินแล้วเกิน cutoff) — รอบตรวจเรียกวันละครั้ง · เฟส B: คิวตรวจแชทรายวันเกิน cutoff ด้วย */
    pruneOwnerReview(cutoffMs) {
      const cutoff = Number(cutoffMs) || 0;
      const reviewItems = items.pruneOwnerReviewItems(cutoff);
      if (!exists()) return { proposals: 0, batches: 0, items: reviewItems };
      const proposals = Number(run(`DELETE FROM owner_close_proposals WHERE status IN (${DECIDED_SQL}) AND updated_at < ?`, cutoff).changes);
      const batches = Number(run("DELETE FROM owner_review_batches WHERE status <> 'building' AND slot_ms < ?", cutoff).changes);
      return { proposals, batches, items: reviewItems };
    },

    /**
     * PDPA reset/ลืม — ข้อเสนอ + แถวคิวตรวจแชทรายวันทุกแถวของห้องนี้ (FK cascade ครอบกรณีลบแถวลูกค้า ตรงนี้ครอบ reset ที่ไม่ลบแถว)
     * คืนจำนวนแถวที่ลบรวม
     */
    deleteOwnerReviewForCustomer(customerId) {
      const reviewItems = items.deleteOwnerReviewItemsForCustomer(customerId);
      if (!exists()) return reviewItems;
      const id = String(customerId);
      // cursor ของรอบที่ยังทำอยู่ชี้ห้องนี้ = เก็บแค่เวลา ("<last_in>:") ทำต่อได้ตำแหน่งเดิมโดยไม่มีรหัสห้อง
      // รอบที่จบแล้วไม่ควรมี cursor (updateOwnerReviewBatch ล้างให้) — ล้างซ้ำกันแถวเก่าก่อนแก้
      run(`UPDATE owner_review_batches SET cursor = substr(cursor, 1, instr(cursor, ':'))
        WHERE status = 'building' AND instr(cursor, ':') > 0 AND substr(cursor, instr(cursor, ':') + 1) = ?`, id);
      run("UPDATE owner_review_batches SET cursor = '' WHERE status <> 'building' AND cursor <> ''");
      return reviewItems + Number(run("DELETE FROM owner_close_proposals WHERE customer_id = ?", id).changes);
    },
  };
}
