// db.mjs — SQLite ชั้นเดียว, single process เป็นเจ้าของไฟล์ DB (SPEC ข้อ 2)
// node:sqlite (Node 22.5+) + WAL + busy_timeout แบบเดียวกับ Team Pulse ที่รอด production
import { activeBrand, escapeRegExp, isGenericProfile } from "./brand.mjs";
import { DatabaseSync } from "node:sqlite";
import { serviceBoundaryState } from "./serviceBoundary.mjs";
import { reviewUrlKey } from "./reviewSelection.mjs";
import { arrivalUrlsIn } from "./showcaseCases.mjs";
import { detectDeliveredCourseOutlines } from "./courseOutlinePlan.mjs";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA } from "./schema.mjs";
import { createExtraDbMethods } from "./dbExtra.mjs";
import { createAttentionDbMethods } from "./dbAttention.mjs";
import { createBrainDbMethods } from "./brain/store.mjs";
import { createGoldenDbMethods } from "./brain/goldenStore.mjs";
import { migrateBrainSchema } from "./brain/schema.mjs";
import { createOrderDbMethods } from "./dbOrders.mjs";
import { createTagDbMethods } from "./dbTags.mjs";
import { createPublishRequestDbMethods } from "./dbPublishRequests.mjs";
import { createBroadcastDbMethods, ensureBroadcastPermissionOwner } from "./dbBroadcast.mjs";
import { createTrainingDbMethods } from "./dbTraining.mjs";
import { createLifecycleDbMethods } from "./dbLifecycle.mjs";
import { createLearningDbMethods } from "./dbLearning.mjs";
import { createLessonDbMethods } from "./dbLessons.mjs";
import { createWebPushDbMethods } from "./dbWebPush.mjs";
import { createProactiveAttemptDbMethods } from "./dbProactiveAttempts.mjs";
import { createTrialInviteDbMethods } from "./dbTrialInvites.mjs";
import { createYoloDbMethods } from "./dbYolo.mjs";
import { createGentleFollowupDbMethods } from "./dbGentleFollowups.mjs";
import { createPaymentStepDbMethods } from "./dbPaymentStep.mjs";
import { createOwnerChatDbMethods } from "./dbOwnerChat.mjs";
import { createOwnerLookupDbMethods } from "./dbOwnerChatLookups.mjs";
import { createLineUsageDbMethods } from "./dbLineUsage.mjs";
import { createIdentityLinkDbMethods, migrateIdentityLinkSchema } from "./dbIdentityLinks.mjs";
import { createBroadcastStudioDbMethods } from "./dbBroadcastStudio.mjs";
import { createStepMessageDbMethods } from "./dbStepMessages.mjs";
// 6 ต.ค. 2026: ที่มาของห้องจากแอด Meta (referral) — รายงาน "แอดตัวไหนพาคนแบบไหนมา" (dbAdReferrals.mjs)
import { AD_REFERRAL_ADDED_COLUMNS, createAdReferralDbMethods } from "./dbAdReferrals.mjs";
import { createMetaCapiDbMethods } from "./dbMetaCapi.mjs";
import { createOwnerReviewDbMethods } from "./dbOwnerReview.mjs";
import { createTeamReviewDbMethods } from "./dbTeamReview.mjs";
import { bangkokDayStartMs, bangkokMonthStartMs } from "./bangkokTime.mjs";
import { hashCustomerIdentity, normalizeTombstoneReason } from "./customerTombstones.mjs";
import { teachCustomerHash, stripTeachIdentity } from "./brain/teachIdentity.mjs";
import { NON_HUMAN_NOTE_AUTHORS_SQL } from "./lineOaContext.mjs";
import { NOT_SPAM_SQL, SPAM_EXISTS_SQL } from "./spamTag.mjs";
import { SYSTEM_CUSTOMER_TAG_SQL } from "./legacyAutoTag.mjs";
import { applyStablePersonaRead } from "./personaRead.mjs";
import { isTeachableCorrection, formatSystemCorrectionSource } from "./correctionCapture.mjs";
import { soulMeta } from "./soul/index.mjs";

// 18 ต.ค. 2026 (ขั้นที่ 1 ของแผน soul): ข้อความขาออกที่ AI เขียน (agent_mode = ai) จดรุ่นตัวตนไว้ใน meta
// เหมือน brain_version_id — ถอยรุ่น soul แล้วยังรู้ว่าข้อความไหนเขียนด้วยรุ่นไหน · ไม่มี soul = meta เดิมทุกไบต์
function withSoulStamp(metadata, { direction, agentMode }) {
  if (direction !== "out" || agentMode !== "ai") return metadata;
  const stamp = soulMeta();
  return stamp ? { ...metadata, ...stamp } : metadata;
}

// ขอบบนของช่วงเวลา — null/undefined/"" = ไม่มีขอบ
// ระวัง Number(null) === 0 ซึ่งเป็นตัวเลข finite: ถ้าเช็คด้วย Number.isFinite เฉย ๆ
// "ไม่มีขอบบน" จะกลายเป็น "created_at < 0" แล้วคิวรีคืนศูนย์แถวเงียบ ๆ
function upperBound(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Provenance is machine-readable and deliberately does not reuse `reason`,
// which remains editable human explanation. Empty preserves all legacy callers.
export function normalizeCorrectionSourceReason(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const finalColon = text.lastIndexOf(":");
  const base = finalColon > "system:".length ? text.slice(0, finalColon) : text;
  const types = finalColon > "system:".length ? text.slice(finalColon + 1).split(",") : [];
  const canonical = formatSystemCorrectionSource(base, types);
  if (!canonical || canonical !== text) throw new Error("invalid correction source reason");
  return canonical;
}

const FOLLOWUP_SUPPRESSION_REASONS = new Set([
  "customer_will_return",
  "customer_considering",
  "colleague_will_contact",
  "accounting_documents",
]);


// รวมผลอ่านลักษณะลูกค้ารอบนี้เข้ากับรอบก่อน ให้ค่านิ่งก่อนบันทึก
// ถ้าอ่านหรือแปลง JSON ไม่ได้ ให้ใช้ของรอบนี้ตามเดิม — ผลอ่านเป็นของเสริม
// ห้ามทำให้การบันทึกคะแนนล้มทั้งก้อนเพราะ payload เพี้ยน
function stabilizedScorePayload(get, customerId, payloadJson) {
  const text = String(payloadJson ?? "");
  if (!text.trim()) return text;
  try {
    const incoming = JSON.parse(text);
    const prevRow = get(
      "SELECT payload_json FROM score_history WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      String(customerId),
    );
    let previous = null;
    if (prevRow?.payload_json) { try { previous = JSON.parse(prevRow.payload_json); } catch { previous = null; } }
    return JSON.stringify(applyStablePersonaRead(incoming, previous));
  } catch {
    return text;
  }
}

// ห้องที่ลูกแพรรับปากลูกค้าว่า "ทีมงานจะติดต่อกลับ" แล้วยังไม่มีคนทำตาม
//
// 2026-08-28: ห้องพวกนี้ยังเป็น AI_ACTIVE จึงไม่เคยโผล่ในตัวกรอง "รอคน" ที่ทีมงานใช้
// วันที่เจอ มีสองห้องค้างอยู่ 15 และ 19 ชม. โดยไม่มีใครเห็น — เป็นคำสัญญาที่ระบบให้
// ลูกค้าไว้เองแล้วผิดคำพูด ซึ่งเสียหายกว่าห้องที่ไม่มีใครสัญญาอะไรไว้
//
// "ยังไม่มีคนทำตาม" = โน้ต ai_promise ใหม่กว่าทั้งโน้ตของคนล่าสุด และข้อความที่คนส่งออก
// ล่าสุด (ใช้รายชื่อ "ไม่ใช่คน" ชุดเดียวกับป้าย LINE OA — บอทตอบเองไม่นับว่าทีมงานทำตาม)
// ป้ายที่แปลว่า "บอทต้องเงียบถาวร ทีมงานดูแลเอง" — รวมไว้ที่เดียว ไม่แยกกลไกตามป้าย
// เพราะกติกา customer วันนี้กระจายอยู่ 8 จุดโดยไม่มีตัวกลาง ถ้าก็อปไปทำ null อีกชุด
// จะกลายเป็น 16 จุด และจะรั่วซ้ำรอยเดิมทุกข้อ
//
//   customer = ซื้อแล้ว ทีมงานคุยเอง (คำสั่งเจ้าของ v1.4.33)
//   null     = ไม่ได้มาคุย เช่นบัญชีมาตามเอกสาร หรือเจ้าของบริษัทที่ส่งทีมมาเรียน
//              (คำสั่งเจ้าของ 2026-08-28)
//
// เทียบแบบไม่สนตัวพิมพ์ เพราะตาราง customer_tags ไม่มี COLLATE NOCASE
// "null"/"Null"/"NULL" จึงเป็นคนละแถวกันได้
export const BOT_SILENCED_TAGS = Object.freeze(["customer", "null"]);
const SILENCED_TAG_LIST_SQL = BOT_SILENCED_TAGS.map((tag) => `'${tag}'`).join(", ");
// v1.4.49 (คำสั่งเจ้าของ 2026-08-29): ลูกค้าที่เพิ่งได้ "คลาสฟรี" — หยุดทักตาม 7 วัน
// นับจากวันติดป้าย แล้วค่อยกลับเข้าจังหวะปกติเอง (การทวงถามทันทีหลังให้ของขวัญ
// ทั้งน่ารำคาญและทำลายน้ำใจของของขวัญ) จับจากป้ายที่มีคำว่า "คลาสฟรี" —
// ของจริงทีมใช้ "รับคลาสฟรีจากlive" อยู่แล้ว ส่วนป้ายแจกของเก่า ("รับ GEN AI ฟรี")
// ไม่มีคำนี้จึงไม่โดน และป้ายที่ติดมานานเกิน 7 วันพ้นหน้าต่างโดยนิยาม
export const FREE_CLASS_QUIET_MS = 7 * 24 * 60 * 60 * 1000;
export const FREE_CLASS_TAG = "คลาสฟรี";
// v1.5: หน้าต่างส่งข้อความของ Facebook — ข้อความเชิงรุก (FU) ออกได้เฉพาะภายใน 24 ชม.
// หลังข้อความล่าสุดของลูกค้า เกินแล้ว Meta ถือเป็นการละเมิด = เสี่ยงแบนทั้งเพจ
// margin 5 นาที: งานที่ถูกหยิบตอนชั่วโมงที่ 23:56 ต้องไม่ไปถึง provider ตอน 24:01
export const FB_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
// ลิงก์ไหนคือ "คลาสฟรี" ตั้งจากหน้า Settings — ค่าว่าง = ระบบเฉย (เดาลิงก์ผิด
// เท่ากับกด FU เงียบใส่ลีดที่ไม่เกี่ยว จึงให้เจ้าของเป็นคนวางลิงก์เองเสมอ)
export const FREECLASS_PATTERNS_KEY = "freeclass_link_patterns";
// v1.4.50: เจ้าของก๊อปลิงก์จากแถบที่อยู่ (มักไม่มี www.) แต่ข้อความจริงเขียนได้หลายรูป —
// http/https, มี/ไม่มี www., ตัวพิมพ์ใหญ่ปนของโดเมน เทียบสตริงดิบจึงพลาดแบบเงียบ ๆ
// ตัดโปรโตคอลกับ www. ทิ้งทั้งสองฝั่งก่อนเทียบ (ไม่แตะ path — คนละคอร์สต้องไม่ชนกัน)
const canonicalLink = (s) => String(s || "").toLowerCase().replace(/https?:\/\//gu, "").replace(/www\./gu, "").trim();
const LEGACY_IMPORT_OPERATOR = "LINE OA (ย้ายข้อมูล)";
const FREE_CLASS_TAG_LIKE = "'%คลาสฟรี%'";
const FREE_CLASS_QUIET_SQL = (customerCol, nowExpr) => `NOT EXISTS (
            SELECT 1 FROM customer_tags gift_tag
            WHERE gift_tag.customer_id = ${customerCol}
              AND lower(gift_tag.tag) LIKE ${FREE_CLASS_TAG_LIKE}
              AND gift_tag.created_at > ${nowExpr} - 604800000)`;

const BOUGHT_TAG_EXCLUDE_SQL = (customerCol) => `NOT EXISTS (
            SELECT 1 FROM customer_tags silenced_tag
            WHERE silenced_tag.customer_id = ${customerCol}
              AND lower(silenced_tag.tag) IN (${SILENCED_TAG_LIST_SQL}))`;

const unkeptPromiseSql = (customerCol) => `EXISTS (
          SELECT 1 FROM handoff_notes promise
          WHERE promise.customer_id = ${customerCol} AND promise.author = 'ai_promise'
            AND promise.created_at > COALESCE((
                  SELECT MAX(human_note.created_at) FROM handoff_notes human_note
                  WHERE human_note.customer_id = ${customerCol}
                    AND human_note.author NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})), 0)
            AND promise.created_at > COALESCE((
                  SELECT MAX(human_out.created_at) FROM messages human_out
                  WHERE human_out.customer_id = ${customerCol} AND human_out.direction = 'out'
                    AND human_out.operator NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})), 0)
        )`;
export { bangkokDayStartMs, bangkokMonthStartMs } from "./bangkokTime.mjs";
// migration เบา ๆ สำหรับ DB ที่สร้างตั้งแต่ G1a (CREATE TABLE IF NOT EXISTS ไม่เติมคอลัมน์ใหม่)
function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

// 5 ต.ค. 2026 (ตัวกวาดคัดกรองลูกค้ารายชั่วโมง — คำสั่งพี่ง้วง): llm_usage.kind ต้องรับ 'qualify'
// ไม่งั้น insert ล้มแล้ว catch ของผู้เรียกกลืนเงียบ ต้นทุนหายจากรายงาน (ซ้ำรอยเหตุ staged_followup v1.4.9)
// และเพดานเงินรายวันของตัวกวาดซึ่งอ่านยอดจากตารางนี้จะเห็นศูนย์ตลอด
// SQLite แก้ CHECK ตรง ๆ ไม่ได้ จึง rebuild เมื่อ DDL ที่เก็บไว้ยังไม่มี 'qualify'
// ต่างจาก migration ชุด 'learning' ด้านล่าง: ชุดนั้นลอกแค่ 8 คอลัมน์แรก ถ้าลอกตามแบบนั้นตรงนี้
// cache_write_in / cache_write_known / brain_version_id ของทุกแถวในอดีตจะหายหมด — ชุดนี้ลอก "ทุกคอลัมน์ที่มีจริง"
// (อ่านจาก PRAGMA) และต้องถูกเรียกหลัง ensureColumn ของ llm_usage ครบแล้ว
// 12 ต.ค. 2026 (ตีจบแชทนอกเรื่อง — offtopicClose.mjs): เพิ่ม 'offtopic_check' (ต้นทุน Luna ยืนยันก่อนตีจบ) — rebuild แบบเดียวกัน
// เมื่อ DDL ยังไม่มีคำนี้ (DB ที่มี 'qualify' แล้วก็ rebuild อีกครั้งเดียว) · เพดานเงินของตัวตีจบอ่านยอดจากตารางนี้
// 12 ต.ค. 2026 ค่ำ: เพิ่ม 'owner_review' (รอบตรวจของเจ้าของ — ownerReviewScheduler.mjs) ต่อท้ายชุดเดิม — DB ที่มี 'offtopic_check'
// แล้ว rebuild อีกครั้งเดียว (ไม่มีคำนี้ = ต้นทุนหาย + เพดาน ฿40 เห็นศูนย์ตลอด → ตัวตรวจหยุดเองที่ usage_unrecorded)
const LLM_USAGE_LATEST_KIND = "'owner_review'";
const LLM_USAGE_REBUILD_COLUMNS = Object.freeze([
  ["id", "id TEXT PRIMARY KEY"],
  ["customer_id", "customer_id TEXT NOT NULL DEFAULT ''"],
  ["kind", "kind TEXT NOT NULL CHECK (kind IN ('draft','score','followup','staged_followup','learning','qualify','offtopic_check','owner_review'))"],
  ["model", "model TEXT NOT NULL DEFAULT ''"],
  ["tokens_in", "tokens_in INTEGER NOT NULL DEFAULT 0"],
  ["tokens_out", "tokens_out INTEGER NOT NULL DEFAULT 0"],
  ["cached_in", "cached_in INTEGER NOT NULL DEFAULT 0"],
  ["created_at", "created_at INTEGER NOT NULL"],
  ["cache_write_in", "cache_write_in INTEGER NOT NULL DEFAULT 0"],
  ["cache_write_known", "cache_write_known INTEGER NOT NULL DEFAULT 0"],
  ["brain_version_id", "brain_version_id TEXT"],
]);
const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
function migrateLlmUsageQualifyKind(db) {
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage'").get();
  if (!ddl || String(ddl.sql || "").includes(LLM_USAGE_LATEST_KIND)) return;
  const live = db.prepare("PRAGMA table_info(llm_usage)").all();
  const known = new Set(LLM_USAGE_REBUILD_COLUMNS.map(([name]) => name));
  // คอลัมน์ที่มีคนเติมทีหลังแต่ไม่อยู่ในรายการ: ลอกชนิด/NOT NULL/DEFAULT ตาม PRAGMA ไปด้วย ห้ามทิ้งข้อมูล
  const extra = live.filter((column) => !known.has(column.name)).map((column) => [column.name,
    `${quoteIdent(column.name)} ${column.type || ""}${column.notnull ? " NOT NULL" : ""}${column.dflt_value != null ? ` DEFAULT ${column.dflt_value}` : ""}`]);
  const definitions = [...LLM_USAGE_REBUILD_COLUMNS, ...extra];
  const liveNames = new Set(live.map((column) => column.name));
  const copied = definitions.filter(([name]) => liveNames.has(name)).map(([name]) => quoteIdent(name)).join(", ");
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE llm_usage_qualify_rebuild (${definitions.map(([, definition]) => definition).join(", ")})`);
    db.exec(`INSERT INTO llm_usage_qualify_rebuild (${copied}) SELECT ${copied} FROM llm_usage`);
    db.exec("DROP TABLE llm_usage");
    db.exec("ALTER TABLE llm_usage_qualify_rebuild RENAME TO llm_usage");
    db.exec("CREATE INDEX IF NOT EXISTS idx_llm_usage_time ON llm_usage(created_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_llm_usage_customer ON llm_usage(customer_id, created_at)");
    db.exec("COMMIT");
  } catch (error) {
    // ล้มกลางทาง = ถอยทั้งก้อน ตารางเดิมพร้อมข้อมูลครบอยู่ที่เดิม (บูตล้มดีกว่าบูตด้วยตารางครึ่ง ๆ)
    try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
    throw error;
  }
}

// ห้องที่ปิดเคสไว้ก่อนมีคอลัมน์ resolved_at (28 ก.ย. 2026): ใช้เวลากด "✓ เสร็จสิ้น" ครั้งล่าสุดจาก audit
// (ปุ่มเป็นเส้นเดียวที่ตั้ง RESOLVED และจด conversation_resolved ทุกครั้ง · audit เก็บ 365 วัน)
// ไม่มีร่องรอยเลย = ใช้ updated_at ซึ่งไม่เก่ากว่าเวลาปิดจริง (เอนไปทาง "ยังปิดอยู่" เหมือนพฤติกรรมเดิม)
// รันทุกบูตได้: หลังรอบแรกไม่มีแถว RESOLVED ที่ resolved_at = 0 เหลือให้แตะ (สแกน audit รอบเดียว ไม่ใช่ต่อแถว)
function backfillResolvedAt(db) {
  const pending = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE state = 'RESOLVED' AND resolved_at = 0").get();
  if (!Number(pending?.n)) return;
  db.exec(`UPDATE customers SET resolved_at = resolved.at
    FROM (SELECT target, MAX(created_at) AS at FROM admin_audit
          WHERE action = 'conversation_resolved' GROUP BY target) AS resolved
    WHERE resolved.target = customers.line_user_id AND customers.state = 'RESOLVED' AND customers.resolved_at = 0`);
  db.exec("UPDATE customers SET resolved_at = updated_at WHERE state = 'RESOLVED' AND resolved_at = 0");
}

// teachHashSecret = กุญแจของ instance สำหรับ hash ลูกค้าใน teach_json (config.consoleSessionSecret)
// ต้องอยู่ใน db เพราะ resetCustomer ต้องหา teach_json ที่ผูกกับคนคนนั้นให้เจอตอนใช้สิทธิ์ให้ลืม
export function openDb({ file = ":memory:", now = Date.now, teachHashSecret = "" } = {}) {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // ถ้ามี writer อื่น (เช่น สั่ง script มือขณะ webhook เขียน) รอ 5 วิ แทนล้มทันที
  db.exec("PRAGMA busy_timeout = 5000;");
  // perf 2026-08-24: WAL + synchronous default (FULL) = fsync ทุก commit บน event loop เดียว
  // NORMAL คือคู่ที่เอกสาร SQLite แนะนำสำหรับ WAL — เสียความทนได้เฉพาะไฟดับ ไม่ใช่แอปพัง
  db.exec("PRAGMA synchronous = NORMAL;");
  // append-only ของตารางสมองพึ่ง BEFORE DELETE trigger ด้วย และ SQLite ปิด recursive
  // triggers เป็นค่าเริ่มต้น: INSERT OR REPLACE จึงลบแถวเดิมได้เงียบ ๆ โดย trigger ไม่ยิง
  // ตั้งต่อ connection เหมือน foreign_keys (PRAGMA นี้ไม่ persist ในไฟล์)
  db.exec("PRAGMA recursive_triggers = ON;");
  db.exec(SCHEMA);
  // CREATE ... IF NOT EXISTS เงียบเมื่อของเดิมมีอยู่แล้ว ฐานที่เคยรัน DDL สมองรุ่นแรก
  // จึงยังถือ trigger รุ่นที่มีช่องโหว่อยู่ — ตัวนี้ไล่อัปเกรดให้ตรงรุ่นเสมอ
  migrateBrainSchema(db);

  function serializeOutboundPayload(payload) {
    const payloadJson = JSON.stringify(payload && typeof payload === "object" ? payload : {});
    if (/\/(?:download|line-media)[#/][A-Za-z0-9_-]{20,}/u.test(payloadJson)) {
      throw new Error("outbound attempt must not persist bearer grants");
    }
    return payloadJson;
  }

  function normalizeOutboundAttachmentIds(attachmentIds = []) {
    const ids = [...new Set((Array.isArray(attachmentIds) ? attachmentIds : []).map(String).filter(Boolean))];
    if (ids.length > 6) throw new Error("too many outbound attachments");
    return ids;
  }
  // SQLite แก้ CHECK ตรง ๆ ไม่ได้ จึง rebuild เมื่อ kind ใหม่ยังไม่อยู่ใน schema.
  // Preserve cached_in when upgrading a recent DB and synthesize zero for an
  // older DB. The migration is additive and keeps every existing usage row.
  const llmUsageDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage'").get();
  if (llmUsageDdl && !String(llmUsageDdl.sql || "").includes("'learning'")) {
    const hasCachedIn = db.prepare("PRAGMA table_info(llm_usage)").all().some((column) => column.name === "cached_in");
    db.exec(`
      BEGIN;
      CREATE TABLE llm_usage_migrated (
        id          TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL DEFAULT '',
        kind        TEXT NOT NULL CHECK (kind IN ('draft','score','followup','staged_followup','learning')),
        model       TEXT NOT NULL DEFAULT '',
        tokens_in   INTEGER NOT NULL DEFAULT 0,
        tokens_out  INTEGER NOT NULL DEFAULT 0,
        cached_in   INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );
      INSERT INTO llm_usage_migrated (id, customer_id, kind, model, tokens_in, tokens_out, cached_in, created_at)
      SELECT id, customer_id, kind, model, tokens_in, tokens_out, ${hasCachedIn ? "cached_in" : "0"}, created_at
      FROM llm_usage;
      DROP TABLE llm_usage;
      ALTER TABLE llm_usage_migrated RENAME TO llm_usage;
      CREATE INDEX IF NOT EXISTS idx_llm_usage_time ON llm_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_customer ON llm_usage(customer_id, created_at);
      COMMIT;
    `);
  }
  ensureColumn(db, "messages", "operator", "operator TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "canary_state", "round_trip_ms", "round_trip_ms INTEGER");
  // G2a: คอลัมน์ใหม่บนตารางเดิม — idempotent สำหรับ DB dev ที่มีอยู่แล้ว
  ensureColumn(db, "customers", "picture_url", "picture_url TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "customers", "known_name", "known_name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "customers", "last_score", "last_score INTEGER");
  ensureColumn(db, "customers", "last_score_at", "last_score_at INTEGER");
  ensureColumn(db, "customers", "followup_enabled", "followup_enabled INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "customers", "service_boundary_json", "service_boundary_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(
    db,
    "customers",
    "followup_suppression_reason",
    "followup_suppression_reason TEXT NOT NULL DEFAULT '' CHECK (followup_suppression_reason IN ('','customer_will_return','customer_considering','colleague_will_contact','accounting_documents'))",
  );
  // followup_enabled = 0 มีสองความหมายที่ต่างกันคนละเรื่อง และเดิมแยกไม่ออก:
  //   (ก) "ยังไม่มีใครตัดสินใจ" — ค่าตั้งต้นของห้องที่ยังไม่เคยคุยกันจริง
  //   (ข) "คนสั่งปิด" — ชมพู่กดปิด FU ให้ห้องนี้โดยเจตนา
  // ตัวเปิดอัตโนมัติตอนได้ score ต้องแตะเฉพาะ (ก) เท่านั้น ห้ามลบล้างการตัดสินใจของคน
  // ตรวจแล้วบน production 2026-08-26: admin_audit ไม่มี followup_toggle เลยสักครั้ง
  // แปลว่าเลข 0 ทั้ง 5,537 แถวคือ (ก) ล้วน การเติมคอลัมน์นี้ด้วย DEFAULT 0 จึงถูกต้อง
  // v1.4.52: โน้ตของกิจกรรมที่ลูกค้าทักมาด้วย #hashtag — ลูกค้ากลุ่มนี้มักทักคำเดียว
  // เป็นข้อความแรกสุด ระบบยังไม่รู้อะไรเลย โน้ตนี้คือสิ่งเดียวที่บอกว่าเขามาจากงานไหน
  ensureColumn(db, "customers", "hashtag_note", "hashtag_note TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "customers", "followup_choice_by_human", "followup_choice_by_human INTEGER NOT NULL DEFAULT 0");
  // G2b: B2 หน้าต่าง operator-active + B7d โหมดผู้ส่งขาออก — idempotent สำหรับ DB live เดิม
  ensureColumn(db, "customers", "operator_active_until", "operator_active_until INTEGER NOT NULL DEFAULT 0");
  // v1.4.9c: tag เปลี่ยนเมื่อไหร่ — รอบ sync tag เว็บ->LINE กลางคืนแตะเฉพาะห้องที่ dirty
  ensureColumn(db, "customers", "tags_dirty_at", "tags_dirty_at INTEGER");
  ensureColumn(db, "tag_sync_state", "last_pushed_ids", "last_pushed_ids TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "messages", "agent_mode", "agent_mode TEXT");
  // Additive structured source metadata (e.g. LINE emoji positions). Keep the
  // human-readable content column unchanged for prompt/history compatibility.
  ensureColumn(db, "messages", "metadata_json", "metadata_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "message_attachments", "source", "source TEXT NOT NULL DEFAULT 'line'");
  ensureColumn(db, "message_attachments", "attempts", "attempts INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "message_attachments", "next_attempt_at", "next_attempt_at INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "message_attachments", "send_claim_id", "send_claim_id TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "message_attachments", "send_claim_expires_at", "send_claim_expires_at INTEGER NOT NULL DEFAULT 0");
  // G4 (console v2): unread indicator — เวลาเปิดห้องล่าสุดโดย operator (0 = ยังไม่เคยเปิด)
  ensureColumn(db, "customers", "last_seen_by_operator_at", "last_seen_by_operator_at INTEGER NOT NULL DEFAULT 0");
  // W3 (multi-OA): scope ต่อสาขา — DB เก่า backfill เป็น 'default' อัตโนมัติผ่าน DEFAULT
  // (index สร้างตรงนี้ ไม่ใช่ใน SCHEMA — DB เก่ายังไม่มีคอลัมน์ตอน exec SCHEMA)
  ensureColumn(db, "customers", "channel_id", "channel_id TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(db, "messages", "channel_id", "channel_id TEXT NOT NULL DEFAULT 'default'");
  ensureColumn(db, "messages", "session_id", "session_id TEXT");
  ensureColumn(db, "training_candidates", "ack_status", "ack_status TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, "training_candidates", "ack_detail", "ack_detail TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "training_candidates", "ack_resolved_at", "ack_resolved_at INTEGER");
  ensureColumn(db, "training_candidates", "ack_resolved_by", "ack_resolved_by TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "training_candidates", "ack_resolution", "ack_resolution TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "handoff_notes", "pinned", "pinned INTEGER NOT NULL DEFAULT 0");
  // M1: token_version ต่อ operator — เปลี่ยนรหัสผ่าน = bump แล้ว session เก่าทุกใบหลุดทันที
  ensureColumn(db, "operators", "token_version", "token_version INTEGER NOT NULL DEFAULT 1");
  // G6 (P1): ความรู้ต่อสาขา — NULL = สมองกลาง (แถวเดิมทุกแถวเป็นกลางอัตโนมัติ)
  ensureColumn(db, "knowledge_entries", "channel_id", "channel_id TEXT");
  // Learning provenance is append-only metadata around the existing knowledge
  // rows. Old console-authored entries are explicitly classified as human.
  ensureColumn(db, "knowledge_entries", "source", "source TEXT NOT NULL DEFAULT 'human_console'");
  ensureColumn(db, "knowledge_entries", "provenance_json", "provenance_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "knowledge_entries", "supersedes_id", "supersedes_id TEXT");
  ensureColumn(db, "knowledge_entries", "superseded_by", "superseded_by TEXT");
  ensureColumn(db, "knowledge_entries", "version", "version INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "knowledge_entries", "deleted_at", "deleted_at INTEGER");
  // เฟส 1b: คำขอที่เล่นซ้ำแล้วจบด้วย "รอเจ้าของรับทราบรุ่นสมอง N" ไม่ใช่คำขอที่ล้มเหลว
  // เก็บเลขรุ่นที่รออยู่ไว้กับแถว แล้วปล่อยให้ status ยังเป็น pending (claimed_at ถูกคืนเป็น 0)
  // จงใจไม่แก้ CHECK ของ status: การ rebuild ตารางคิวบนฐานจริงมีความเสี่ยงมากกว่าค่าที่ได้
  ensureColumn(db, "publish_requests", "awaiting_version_id", "awaiting_version_id TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "corrections", "reason", "reason TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "corrections", "source_reason", "source_reason TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "corrections", "inbound_message_id", "inbound_message_id TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "corrections", "decided_at", "decided_at INTEGER");
  ensureColumn(db, "corrections", "decided_by", "decided_by TEXT NOT NULL DEFAULT ''");
  // เฟส 3: "สอนไปแล้วด้วยรุ่นสมองใบไหน" — บันทึกไว้บนแถว ไม่ใช่อนุมานจากรุ่นล่าสุด N ใบ
  // (อนุมานจากรุ่นล่าสุดแปลว่าพอมีรุ่นครบ N ใบ ของที่สอนไปแล้วจะโผล่กลับมาทั้งหมด)
  ensureColumn(db, "corrections", "taught_version_id", "taught_version_id TEXT NOT NULL DEFAULT ''");
  // v1.1: ข้อมูลจัดส่งบนออเดอร์ (JSON {name,phone,address,email}) — DB เดิม backfill ว่าง
  ensureColumn(db, "orders", "shipping_json", "shipping_json TEXT NOT NULL DEFAULT ''");
  // REVIEW FIX v1.1: ใครเขียน shipping ล่าสุด ('ai'/'human') — คนแก้แล้ว scorer ห้ามทับ
  ensureColumn(db, "orders", "shipping_source", "shipping_source TEXT NOT NULL DEFAULT ''");
  // v1.2 REVIEW FIX: เหตุผลความล้มเหลวล่าสุดของบรอดแคส (โชว์ใน history — ห้ามล้มเงียบ)
  ensureColumn(db, "broadcasts", "last_error", "last_error TEXT NOT NULL DEFAULT ''");
  // Broadcast safety v1: preserve the exact queue progress so a restart/incident
  // can be investigated without pretending that a partially accepted broadcast
  // was complete. SQLite cannot alter a CHECK constraint, so rebuild only old
  // tables that do not accept the explicit `partial` state.
  ensureColumn(db, "broadcasts", "last_sent_index", "last_sent_index INTEGER NOT NULL DEFAULT -1");
  ensureColumn(db, "broadcasts", "cancel_requested_at", "cancel_requested_at INTEGER");
  ensureColumn(db, "broadcasts", "cancel_requested_by", "cancel_requested_by TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "broadcast_channel_claims", "owner_token", "owner_token TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "broadcast_channel_claims", "lease_expires_at", "lease_expires_at INTEGER NOT NULL DEFAULT 0");
  // B-12: a self-test destination is valid only for the Console session that
  // issued the inbound challenge. Existing rows fail closed after migration.
  ensureColumn(db, "broadcast_self_test_destinations", "session_hash", "session_hash TEXT NOT NULL DEFAULT ''");
  const broadcastsDdl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'broadcasts'").get();
  if (broadcastsDdl && !String(broadcastsDdl.sql || "").includes("'partial'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE broadcasts_migrated (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL DEFAULT 'default',
        messages_json TEXT NOT NULL DEFAULT '[]',
        include_tags_json TEXT NOT NULL DEFAULT '[]',
        exclude_tags_json TEXT NOT NULL DEFAULT '[]',
        audience_count INTEGER NOT NULL DEFAULT 0,
        sent_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        last_sent_index INTEGER NOT NULL DEFAULT -1,
        status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending','partial','done','failed')),
        last_error TEXT NOT NULL DEFAULT '',
        cancel_requested_at INTEGER,
        cancel_requested_by TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO broadcasts_migrated (
        rowid, id, channel_id, messages_json, include_tags_json, exclude_tags_json,
        audience_count, sent_count, failed_count, last_sent_index, status, last_error,
        cancel_requested_at, cancel_requested_by,
        created_by, created_at, updated_at
      ) SELECT
        rowid, id, channel_id, messages_json, include_tags_json, exclude_tags_json,
        audience_count, sent_count, failed_count, last_sent_index, status, last_error,
        cancel_requested_at, cancel_requested_by,
        created_by, created_at, updated_at
      FROM broadcasts;
      DROP TABLE broadcasts;
      ALTER TABLE broadcasts_migrated RENAME TO broadcasts;
      CREATE INDEX IF NOT EXISTS idx_broadcasts_time ON broadcasts(created_at);
      COMMIT;
    `);
  }
  // v1.4 Lifecycle เฟส 1: สถานะสองแกน — DB เดิม backfill เป็น sales/new ผ่าน DEFAULT
  // (ไม่เดา state จากประวัติ — ทีมตั้งลูกค้าจริงจากคอนโซลเอง ตามแผนที่อนุมัติ)
  ensureColumn(db, "customers", "lifecycle_stage", "lifecycle_stage TEXT NOT NULL DEFAULT 'sales'");
  ensureColumn(db, "customers", "deal_status", "deal_status TEXT NOT NULL DEFAULT 'new'");
  // v1.4.11 (คำสั่งพี่ง้วง 2026-08-18): เหตุผลที่ AI ถูกปิด — ใช้แยกว่า follow-up agent
  // ยังทำงานต่อได้ไหม (bank_sent = ได้) และคอนโซลอ่านเหตุได้; ค่าว่าง = ปิดมือ/ไม่ทราบ
  ensureColumn(db, "customers", "ai_off_reason", "ai_off_reason TEXT NOT NULL DEFAULT ''");
  // v1.4.48: ผลการโยงกับห้องระบบเก่าด้วยชื่อ ('' = ยังไม่เคยตัดสิน / linked:<id> / ambiguous:<n> / none)
  ensureColumn(db, "customers", "legacy_link", "legacy_link TEXT NOT NULL DEFAULT ''");
  // เวลาจากสำมะโน LINE เดิมใช้เฉพาะห้องที่ไม่มี messages; แยกจาก updated_at เพื่อให้
  // การแก้ชื่อ/ป้ายไม่ดันห้องเก่าขึ้นบน inbox
  ensureColumn(db, "customers", "legacy_last_activity_at", "legacy_last_activity_at INTEGER");
  ensureColumn(db, "llm_usage", "cached_in", "cached_in INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "llm_usage", "cache_write_in", "cache_write_in INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "llm_usage", "cache_write_known", "cache_write_known INTEGER NOT NULL DEFAULT 0");
  // Brain เฟส 2: เทิร์นนี้อ่านสมองรุ่นไหน (NULL = อ่านตารางเดิม — ทุกแถวก่อน BRAIN_READ=versioned)
  // แบบแปลน §5 ตัดตาราง release_watch ทิ้งแล้วให้ "ผล 24 ชม. ของรุ่น N" เป็น query บนสอง
  // ตารางนี้แทน · เป็นรหัสเวอร์ชันของธุรกิจ ไม่ใช่ข้อมูลลูกค้า จึงไม่เข้าเงื่อนไข PDPA cascade
  // (คอลัมน์ที่ cascade ไล่หาคือ customer_id / line_user_id ซึ่งสองตารางนี้มีอยู่แล้ว)
  ensureColumn(db, "messages", "brain_version_id", "brain_version_id TEXT");
  ensureColumn(db, "llm_usage", "brain_version_id", "brain_version_id TEXT");
  // ต้องอยู่หลัง ensureColumn ของ llm_usage ทุกตัว (ตารางใหม่จึงมีครบทุกคอลัมน์เสมอ) — เหตุผลอยู่ที่ตัวฟังก์ชัน
  migrateLlmUsageQualifyKind(db);
  // ข้อความขาออกจดว่าโปรไฟล์ไหนตอบ (ai คือ Prae-Sales วันนี้ — เฟส 2 ค่อยมีค่าอื่น)
  ensureColumn(db, "messages", "agent_profile", "agent_profile TEXT");
  // v1.4.6 Staged follow-up (คำสั่งพี่ง้วง 2026-08-16 — sub-agent ตามสเตจแบบ Klangtech):
  // ต่อคอลัมน์จากโครง followup_state เดิม (G1a สร้างตารางรอไว้) — ladder_stage เดิมใช้เป็น
  // "ขั้นที่ส่งไปแล้วใน episode ปัจจุบัน", คอลัมน์ใหม่เก็บ episode/โควตากันรำคาญ/ประวัติกันซ้ำ
  // audit 2026-08-24: "ลูกค้ารายนี้เคยมีเรื่องเงินกับเราหรือยัง" ต้องเป็นธงถาวร —
  // handoff_summary เป็น buffer 2000 ตัวอักษรที่ถูกตัดทิ้งได้ และ ai_off_reason ถูกทับได้
  // ใช้ตัดสินว่า "ใบกำกับ/ใบเสร็จ" คือคำถามก่อนซื้อ (AI ตอบได้) หรือเอกสารจริง (คนออกเท่านั้น)
  ensureColumn(db, "customers", "money_seen_at", "money_seen_at INTEGER NOT NULL DEFAULT 0");
  // 2026-09-04 (จังหวะราคา): "เราเคยขอถามคัดกรองก่อนแจ้งราคาไปแล้วในห้องนี้หรือยัง"
  // ต้องเป็นธงถาวร ไม่ใช่การอ่านย้อนหลังจากตัวหนังสือ — history ที่เข้าพรอมต์คือ 12 แถว
  // ล่าสุด (HISTORY_TURNS) และหนึ่งรอบสนทนากินได้ ~5 แถว สัญญาณที่อยู่ในข้อความอย่างเดียว
  // จึงเลื่อนหลุดหน้าต่างแล้วติดอาวุธการคัดกรองใหม่ให้ลูกค้าคนเดิม (= ถูกถามซ้ำรอบสอง
  // ซึ่งเป็นความล้มเหลวที่พี่ง้วงชี้ชื่อไว้ตรง ๆ) · เขียนครั้งแรกชนะ ล้างได้เฉพาะ reset/PDPA
  ensureColumn(db, "customers", "price_deferred_at", "price_deferred_at INTEGER NOT NULL DEFAULT 0");
  // คู่ตรงข้ามของหมุดด้านบน: "ราคาคลาสถึงมือเขาไปแล้วจริง ๆ หรือยัง"
  // ต้องมีคู่กันเสมอ ไม่งั้น "ยังติดค้างราคาเขาอยู่" จะไม่มีทางคำนวณจากสถานะถาวรได้ แล้วโค้ด
  // จะตกไปอ่านสำนวนที่โมเดลเขียนเอง (ซึ่งผ่าน humanizer แล้ว = หายได้ทุกเมื่อ)
  // เขียนหลัง provider ยืนยันว่าส่งสำเร็จเท่านั้น และเฉพาะเมื่อข้อความมีราคาที่อนุมัติจริง
  ensureColumn(db, "customers", "price_quoted_at", "price_quoted_at INTEGER NOT NULL DEFAULT 0");
  // "ลูกค้าเคยเล่าอะไรเกี่ยวกับตัวเองให้เราแล้ว" — สัญญาณพวกนี้อ่านจาก history ซึ่งเป็น
  // หน้าต่างเลื่อน (ตั้งต้น 12 แถว) ห้องที่คุยยาวจึงเคย "กลายเป็นคนแปลกหน้าอีกครั้ง"
  // แล้วโดนคัดกรองใหม่ · หมุดนี้ดันไปทาง quote ทางเดียว จึงปลอดภัยที่จะเขียนทันทีที่อ่านออก
  ensureColumn(db, "customers", "known_context_at", "known_context_at INTEGER NOT NULL DEFAULT 0");
  // 2026-09-04 (ตรวจปรปักษ์): การเลี่ยงราคาด้วยคำถาม "สนใจดูเป็นคลาสสอนสดหรือคลาสออนไลน์ดีคะ"
  // (กัน downgrade เคสลูกค้า A 2026-08-17) ไม่เคยถูกบันทึกไว้เลย ห้องเดียวกันจึงถูกเลี่ยง
  // ด้วยคำถามเดิมได้ไม่จำกัดจำนวนครั้ง แม้ลูกค้าจะตอบคำถามนั้นไปแล้วก็ตาม — โควตาต้องมี
  // ครั้งเดียวเหมือนการคัดกรอง · เขียนครั้งแรกชนะ ล้างได้เฉพาะ reset/PDPA
  ensureColumn(db, "customers", "price_pivot_deferred_at", "price_pivot_deferred_at INTEGER NOT NULL DEFAULT 0");
  // 28 ก.ย. 2026 (พี่ง้วง: "✓ เสร็จสิ้น" เป็นปุ่มเคลียร์คิวรอตอบ): "ปิดเคสเมื่อไร" ต้องมีเวลาของตัวเอง —
  // สถานะ RESOLVED ค้างอยู่จนมีคนกดเปิดเคส ข้อความใหม่ของลูกค้าไม่ได้เปิดคืน ถ้าคิวรอตอบดูแค่สถานะ
  // ลูกค้าที่ปิดเคสไปเมื่อวานแล้ววันนี้ทักกลับมาจะหายจากทุกคิวโดยไม่มีใครรู้ (รอตอบ = ทักหลังเวลาปิดเคส)
  ensureColumn(db, "customers", "resolved_at", "resolved_at INTEGER NOT NULL DEFAULT 0");
  backfillResolvedAt(db);
  ensureColumn(db, "followup_state", "stage_key", "stage_key TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "followup_state", "episode_anchor", "episode_anchor INTEGER");
  ensureColumn(db, "followup_state", "episodes_today", "episodes_today INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "followup_state", "sent_today", "sent_today INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "followup_state", "today_key", "today_key TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "followup_state", "cold_sent_total", "cold_sent_total INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "followup_state", "history_json", "history_json TEXT NOT NULL DEFAULT '[]'");
  // 2026-09-28 (คำสั่งพี่ง้วง "ขอเช็คคิวก่อน"): หมุดของห้อง — ลูกค้าขอไปเช็คคิว/วันก่อน = ทักหนึ่งครั้งแทนบันได
  // เขียนโดยเส้นรับข้อความ อ่านโดย stagedFollowups/คอนโซล · saveFollowupState ไม่แตะคอลัมน์นี้ (ไม่ทับกัน)
  ensureColumn(db, "followup_state", "defer_json", "defer_json TEXT NOT NULL DEFAULT ''");
  // 28 ก.ย. 2026 (ค่ำ): คลาสที่ทีมเลือกตอนส่งลิงก์ต่อแชท LINE — identity_link_codes.class_type
  migrateIdentityLinkSchema(db);
  // 6 ต.ค. 2026 (ค่ำ): แถบ "มาจากโฆษณา" ในหน้าแชท — โพสต์ + รูปแอดของห้องจากแอด (dbAdReferrals.mjs)
  for (const [column, ddl] of AD_REFERRAL_ADDED_COLUMNS) ensureColumn(db, "customer_ad_referrals", column, ddl);
  // 7 ต.ค. 2026: โหมดคลาส — รอบเรียนที่ผูกกับออเดอร์ { date, classKey, label } (orderMode.mjs)
  ensureColumn(db, "orders", "class_round_json", "class_round_json TEXT NOT NULL DEFAULT ''");
  // เปิด DB จาก process ที่สองระหว่าง deploy ต้องไม่ปิดงานของ process แรกที่ lease
  // ยังสดอยู่. ปิดเฉพาะงานที่ไม่มี lease สดจริง และลบเฉพาะ claim หมดอายุ/จบแล้ว.
  const broadcastLeaseNow = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE broadcasts SET status = 'failed',
        last_error = 'lease งานส่งหมดอายุหรือไม่มีเจ้าของ — ยอดที่ส่งแล้วดู sent_count (ไม่ส่งซ้ำอัตโนมัติ กันข้อความเบิ้ล)'
      WHERE status = 'sending' AND NOT EXISTS (
        SELECT 1 FROM broadcast_channel_claims claim
        WHERE claim.broadcast_id = broadcasts.id AND claim.lease_expires_at > ?
      )`).run(broadcastLeaseNow);
    db.prepare(`DELETE FROM broadcast_channel_claims
      WHERE lease_expires_at <= ? OR broadcast_id IN (SELECT id FROM broadcasts WHERE status != 'sending')`).run(broadcastLeaseNow);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
    throw error;
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_customers_channel ON customers(channel_id, updated_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);");
  // perf 2026-08-24 (วินิจฉัย console ช้า): สาม index ที่ขาดแล้วทำให้ inbox/room poll สแกนทั้งตาราง
  // - legacy_link: EXISTS ใน listConversations/inboxCounts เคย correlate-สแกน customers ทั้งตารางต่อแถว (O(N^2))
  // - corrections: latestPendingDraft สแกนทั้งตารางทุก 7 วิ ที่เปิดห้องอยู่
  // - messages(created_at): overview นับรายวันเคยสแกนทั้งตาราง
  db.exec("CREATE INDEX IF NOT EXISTS idx_customers_legacy_link ON customers(legacy_link);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_corrections_customer ON corrections(customer_id, created_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);");

  // perf 2026-08-24: memoize prepared statements — เดิม prepare ใหม่ทุก call (~100+ ครั้ง/รอบ poll)
  // จ่ายค่า parse SQL ซ้ำบน event loop เดียวกับ webhook; Map ต่อ connection ปลอดภัยเพราะ
  // process เดียวเป็นเจ้าของ DB (ดู header ไฟล์นี้) และ SQL ทุกตัวเป็น string literal คงที่
  const stmtCache = new Map();
  const prep = (sql) => {
    let stmt = stmtCache.get(sql);
    if (!stmt) { stmt = db.prepare(sql); stmtCache.set(sql, stmt); }
    return stmt;
  };
  const run = (sql, ...params) => prep(sql).run(...params);
  const all = (sql, ...params) => prep(sql).all(...params);
  const get = (sql, ...params) => prep(sql).get(...params);

  ensureBroadcastPermissionOwner({ get, run, now });

  return {
    raw: db,
    ...createProactiveAttemptDbMethods({ run, get }),
    // 12 ต.ค. 2026: สิทธิ์ชวนทดลองเรียนฟรีต่อวัน (trialInvites.mjs) — นับจริง หยุดจริงเมื่อครบเพดาน
    ...createTrialInviteDbMethods({ db, run, get }),
    // 2026-09-28: YOLO/คำสั่งเจ้าของทาง Telegram — คิวรีอ่านอย่างเดียว (รั้วส่งใช้ proactive_attempts เดิม)
    ...createYoloDbMethods({ all, get }),
    // 2026-09-28: ทักเบา ๆ หลังส่งบัญชี + หมุด "ขอเช็คคิวก่อน" (paymentGentleNudge.mjs / scheduleCheck*.mjs)
    ...createGentleFollowupDbMethods({ run, get, all }),
    // 18 ต.ค. 2026: ตัวเฝ้าขั้นชำระเงิน — ห้องตอบเรื่องเอกสารแล้วแต่ระบบส่งบัญชี 0 ครั้ง (paymentStepWatch.mjs)
    ...createPaymentStepDbMethods({ all, get }),
    // 2026-09-28: "คุยกับลูกแพร" ทาง Telegram — ความจำแชทเจ้าของ + คิวรีข้อมูลสด (dbOwnerChat.mjs)
    ...createOwnerChatDbMethods({ run, all, get, now }),
    // บ่าย 28 ก.ย.: "ถามอะไรก็ค้นให้" — คิวรีอ่านอย่างเดียวที่ลูกแพรเลือกจากรายการปิด (dbOwnerChatLookups.mjs)
    ...createOwnerLookupDbMethods({ all, get }),
    // 28 ก.ย. 2026: บัญชีการยิง LINE ของระบบ + สถิติทางการของ LINE (การ์ด "LINE OA เดือนนี้" · dbLineUsage.mjs)
    ...createLineUsageDbMethods({ run, all, get }),
    // 28 ก.ย. 2026: ลูกค้าคนเดียวกันข้ามช่องทาง Facebook ↔ LINE + รหัสเชื่อมแชท (dbIdentityLinks.mjs)
    ...createIdentityLinkDbMethods({ db, run, all, get, now, newId: randomUUID }),
    // 6 ต.ค. 2026: ที่มาของห้องจากแอด Meta — เขียนจากขาเข้า Facebook, อ่านจากรายงานในคอนโซลเท่านั้น
    ...createAdReferralDbMethods({ run, all, get, now, newId: randomUUID }),
    ...createMetaCapiDbMethods({ run, all, get, now }),
    // 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง — รอบตรวจ + ข้อเสนอปิดห้องรอคนยืนยัน (dbOwnerReview.mjs)
    ...createOwnerReviewDbMethods({ db, run, all, get, now, newId: randomUUID }),
    // 3 พ.ย. 2026: ผลตรวจคำตอบของทีม (Luna · เจ้าของเห็นคนเดียว — dbTeamReview.mjs)
    ...createTeamReviewDbMethods({ db, run, all, get, now, newId: randomUUID }),

    // G3: คลังความรู้ + ผลตรวจสลิป (แยกไฟล์ dbExtra.mjs — คุมขนาดไฟล์นี้ <800 บรรทัด)
    ...createExtraDbMethods({ db, run, all, get, now, dayStartMs: bangkokDayStartMs }),
    // 28 ก.ย. 2026: ผู้สมัคร "ลูกค้ารอคนตอบ" + "ลูกค้าร้อนเงียบไป รอทีมทักต่อ" ของหน้าภาพรวม (อ่านอย่างเดียว)
    ...createAttentionDbMethods({ all, get }),
    // G6 (P2): ระบบออเดอร์ (แยกไฟล์ dbOrders.mjs)
    ...createOrderDbMethods({ run, all, get, now, dayStartMs: bangkokDayStartMs, monthStartMs: bangkokMonthStartMs }),
    ...createTagDbMethods({ run, all, get, now }), // v1.1: chat tags (RFM/ai/human) + v1.4.9c registry/sync
    // Package K: คิว "ขออนุมัติเผยแพร่" — ทีมงานเสนอ เจ้าของกดอนุมัติ (แยกไฟล์ dbPublishRequests.mjs)
    ...createPublishRequestDbMethods({ run, all, get, now }),
    ...createBroadcastDbMethods({ db, run, all, get, now }), // v1.2: บรอดแคสตาม segment
    // 28 ก.ย. 2026: สตูดิโอบรอดแคสต์ — โหมดผู้รับฝั่ง LINE + ลิงก์นับคลิก + สถานะเพื่อน (dbBroadcastStudio.mjs)
    ...createBroadcastStudioDbMethods({ db, run, all, get, now }),
    // 28 ก.ย. 2026: ข้อความตามขั้น (Step messages) — ลำดับ/คนในลำดับ/การส่งแต่ละขั้น (dbStepMessages.mjs)
    ...createStepMessageDbMethods({ db, run, all, get, now }),
    ...createTrainingDbMethods({ db, run, all, get, now }),
    ...createLearningDbMethods({ db, run, all, get, now }),
    // 2026-09-28: บทเรียนที่เจ้าของสอนจากแผง "ทำไมตอบแบบนี้" (แยกไฟล์ dbLessons.mjs)
    ...createLessonDbMethods({ run, all, get, now }),
    ...createWebPushDbMethods({ run, all, get, now }),
    // Brain เฟส 1a: ตารางสมองที่มีเวอร์ชัน — ยังไม่มีเส้นตอบลูกค้าอ่าน (src/brain/store.mjs)
    ...createBrainDbMethods({ db, run, all, get, now }),
    // เฟส 3: คลังเทิร์นตรวจซ้ำ + baseline + ใบเสร็จด่าน — กุญแจ HMAC ตัวเดียวกับ teach_json
    ...createGoldenDbMethods({ run, all, get, now, hmacSecret: teachHashSecret }),
    // v1.4: facts/สถานะสองแกน/enrollments (แยกไฟล์ dbLifecycle.mjs)
    ...createLifecycleDbMethods({ db, run, all, get, now }),

    ping() {
      return get("SELECT 1 AS ok")?.ok === 1;
    },

    /* ------------------------------ customers ------------------------------ */

    // Fern lesson: ลูกค้าใหม่ default TRUE / AI_ACTIVE — สร้างเฉพาะตอนยังไม่มีแถว
    // W3: lineUserId คือ "customer key" (channel default = raw id / อื่น = "<ch>:<id>")
    // channelId ตั้งเฉพาะตอน INSERT แถวใหม่ — แถวเดิมไม่ย้ายสาขาเอง
    upsertCustomer(lineUserId, { displayName = "", channelId = "default" } = {}) {
      const t = now();
      run(
        // followup_enabled ของ "ลูกค้าที่เพิ่งทักเข้ามาครั้งแรก"
        //
        // 2026-08-21 ตั้งเป็น 0 ตอนรีลีสนำร่อง 5 คน เพื่อกันไม่ให้ FU ยิงใครโดยไม่ตั้งใจ
        // 2026-08-26 (คำสั่งพี่ง้วง ก่อนเปิดใช้จริง): เปลี่ยนเป็น 1 — ให้ห้องที่ "เกิดใหม่
        // ตั้งแต่วันเปิดใช้" ได้ FU cold/warm/hot ตามปกติ ส่วนฐานเดิม 5,537 ห้องยังเงียบอยู่
        //
        // ที่ปลอดภัยเพราะ ON CONFLICT ด้านล่างแตะแค่ display_name/updated_at — แถวที่มีอยู่
        // แล้วจึงคง followup_enabled เดิม (0) ไว้ทุกแถว ไม่มีทางถูกเปิดย้อนหลังจากบรรทัดนี้
        // และห้องที่ติดป้าย customer ถูกคัดออกอยู่แล้วที่ listStagedFollowupCandidates
        // ซึ่งบังคับ ai_enabled = 1 (ป้าย customer = บอทเงียบถาวร)
        `INSERT INTO customers (line_user_id, display_name, channel_id, followup_enabled, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(line_user_id) DO UPDATE SET
           display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE customers.display_name END,
           updated_at = excluded.updated_at`,
        String(lineUserId), String(displayName), String(channelId || "default"), t, t
      );
      return this.getCustomer(lineUserId);
    },

    getCustomer(lineUserId) {
      return get("SELECT * FROM customers WHERE line_user_id = ?", String(lineUserId)) ?? null;
    },

    // ชื่อ LINE เป็นข้อมูลที่ผู้ใช้แก้เองได้ จึงใช้เพียงสร้าง candidate ให้พนักงาน
    // ยืนยัน ไม่ใช่ identity proof. คืนทุกแถวอ้างอิงแล้วให้ legacyLink normalize/filter
    // จุดเดียว เพื่อไม่พลาดชื่อที่ต่างกันเฉพาะ internal whitespace/Unicode.
    // หมายเหตุ perf 2026-08-24: ตัวกรองชื่อจริงอยู่ฝั่ง JS (normalizeDisplayName ทำ NFC +
    // ยุบช่องว่าง ซึ่ง SQL ทำไม่ได้) — SQL จึงคืนทุกแถว legacy แต่เอาเฉพาะ 2 คอลัมน์ที่ใช้
    // (เดิม SELECT c.* ลาก handoff_summary/รูป ฯลฯ ของ 799 แถวมาทุกข้อความขาเข้าที่ยังไม่โยง)
    findLegacyByDisplayName(displayName) {
      if (!String(displayName || "").trim()) return [];
      return all(
        `SELECT c.line_user_id, c.display_name FROM customers c
           JOIN customer_tags t ON t.customer_id = c.line_user_id AND t.tag = ?
          ORDER BY c.updated_at DESC`,
        "ย้ายจาก LINE OA",
      );
    },

    // 2026-08-24 (โยงมือ): ห้องเก่าห้องหนึ่งต้องถูกโยงได้โดยลูกค้าจริงคนเดียวเท่านั้น
    customerLinkedToLegacy(legacyId) {
      return get("SELECT line_user_id FROM customers WHERE legacy_link = ?", `linked:${String(legacyId)}`) ?? null;
    },
    setLegacyLink(lineUserId, value) {
      run("UPDATE customers SET legacy_link = ?, updated_at = ? WHERE line_user_id = ?", String(value || ""), now(), String(lineUserId));
    },

    // v1.4.11: reason บันทึกเฉพาะตอนปิด (bank_sent/human_requested/money_line/
    // handoff_private_inhouse/manual) — เปิดคืนเมื่อไหร่ล้างทิ้งเสมอ
    setAiEnabled(lineUserId, enabled, reason = "") {
      run(
        "UPDATE customers SET ai_enabled = ?, ai_off_reason = ?, updated_at = ? WHERE line_user_id = ?",
        enabled ? 1 : 0, enabled ? "" : String(reason || ""), now(), String(lineUserId)
      );
      return this.getCustomer(lineUserId);
    },

    // audit 2026-08-24: ปักธงถาวรว่าลูกค้ารายนี้แตะเรื่องเงินกับเราแล้ว (เขียนครั้งแรกชนะ
    // เพื่อให้ค่าเป็น "ครั้งแรกที่เห็นเงิน" จริง ๆ) — ล้างได้เฉพาะ PDPA reset เท่านั้น
    markMoneySeen(lineUserId) {
      run(
        "UPDATE customers SET money_seen_at = ?, updated_at = ? WHERE line_user_id = ? AND money_seen_at = 0",
        now(), now(), String(lineUserId)
      );
    },

    // จังหวะราคา: ปักหมุดว่าเราขอถามคัดกรองก่อนแจ้งราคาไปแล้วหนึ่งครั้งในห้องนี้
    // (เขียนครั้งแรกชนะ เหมือน money_seen_at — ค่าที่ได้คือ "ครั้งแรกที่เราขอถาม" จริง ๆ)
    // `AND price_deferred_at = 0` ทำให้เรียกซ้ำกี่ครั้งก็ได้ผลเดียวกัน (เช่น ตอน redraft
    // ของข้อความลูกค้าก้อนเดิม) — จึงเรียกจากจุดหลังส่งสำเร็จได้โดยไม่ต้องกลัวเขียนทับ
    markPriceDeferred(lineUserId) {
      run(
        "UPDATE customers SET price_deferred_at = ?, updated_at = ? WHERE line_user_id = ? AND price_deferred_at = 0",
        now(), now(), String(lineUserId)
      );
    },

    // จังหวะราคา: ปักหมุดว่าราคาคลาสที่อนุมัติถึงมือลูกค้าไปแล้วจริง (เขียนครั้งแรกชนะ)
    markPriceQuoted(lineUserId) {
      run(
        "UPDATE customers SET price_quoted_at = ?, updated_at = ? WHERE line_user_id = ? AND price_quoted_at = 0",
        now(), now(), String(lineUserId)
      );
    },

    // จังหวะราคา: ปักหมุดว่าเราเลี่ยงด้วยคำถาม "สอนสดหรือออนไลน์" ไปแล้วหนึ่งครั้งในห้องนี้
    // (เขียนครั้งแรกชนะ เรียกหลังส่งสำเร็จเท่านั้น ด้วยเหตุผลเดียวกับ markPriceDeferred)
    markOnlinePivotDeferred(lineUserId) {
      run(
        "UPDATE customers SET price_pivot_deferred_at = ?, updated_at = ? WHERE line_user_id = ? AND price_pivot_deferred_at = 0",
        now(), now(), String(lineUserId)
      );
    },

    // จังหวะราคา: ปักหมุดว่าลูกค้าเล่าบริบทของตัวเองให้เราแล้ว (เขียนครั้งแรกชนะ)
    markCustomerContextKnown(lineUserId) {
      run(
        "UPDATE customers SET known_context_at = ?, updated_at = ? WHERE line_user_id = ? AND known_context_at = 0",
        now(), now(), String(lineUserId)
      );
    },

    // v1.4.11: เดินดีลแบบ deterministic (จุดส่งเลขบัญชี -> awaiting_payment)
    setDealStatus(lineUserId, dealStatus) {
      run(
        "UPDATE customers SET deal_status = ?, updated_at = ? WHERE line_user_id = ?",
        String(dealStatus || "new"), now(), String(lineUserId)
      );
    },

    // escalate: ตั้ง state + ต่อท้าย handoff summary ให้คนจริงเห็นบริบท
    setNeedsHuman(lineUserId, reason, summary = "") {
      const existing = this.getCustomer(lineUserId);
      const prev = existing?.handoff_summary || "";
      const note = `[${new Date(now()).toISOString()}] ${reason}${summary ? `: ${summary}` : ""}`;
      const merged = prev ? `${prev}\n${note}` : note;
      run(
        "UPDATE customers SET state = 'NEEDS_HUMAN', handoff_summary = ?, updated_at = ? WHERE line_user_id = ?",
        merged.slice(-2000), now(), String(lineUserId)
      );
      return this.getCustomer(lineUserId);
    },

    // F1: อัปเดตโปรไฟล์จาก LINE (display name + รูป) — ค่าว่างไม่ทับของเดิม
    setProfile(lineUserId, { displayName = "", pictureUrl = "" } = {}) {
      this.upsertCustomer(lineUserId, {});
      run(
        `UPDATE customers SET
           display_name = CASE WHEN ? != '' THEN ? ELSE display_name END,
           picture_url  = CASE WHEN ? != '' THEN ? ELSE picture_url END,
           updated_at = ?
         WHERE line_user_id = ?`,
        String(displayName), String(displayName),
        String(pictureUrl), String(pictureUrl),
        now(), String(lineUserId)
      );
      return this.getCustomer(lineUserId);
    },

    // F2: ชื่อจริงที่ลูกค้าแจ้งในแชท (auto-extract หรือแอดมินแก้จาก console)
    setKnownName(lineUserId, name) {
      run(
        "UPDATE customers SET known_name = ?, updated_at = ? WHERE line_user_id = ?",
        String(name ?? "").trim().slice(0, 60), now(), String(lineUserId)
      );
      return this.getCustomer(lineUserId);
    },

    // สวิตช์ที่ "คน" กดในคอนโซล — ปักธงไว้ด้วยว่าห้องนี้มีคนตัดสินใจแล้ว
    // ตัวเปิดอัตโนมัติตอนได้ score จะไม่แตะห้องที่ปักธงนี้อีกเลย
    setFollowupEnabled(lineUserId, enabled) {
      run(
        `UPDATE customers SET
           followup_enabled = ?,
           followup_suppression_reason = CASE WHEN ? THEN '' ELSE followup_suppression_reason END,
           followup_choice_by_human = 1,
           updated_at = ?
         WHERE line_user_id = ?`,
        enabled ? 1 : 0, enabled ? 1 : 0, now(), String(lineUserId)
      );
      if (enabled) this.setServiceBoundaryState(lineUserId, { ...serviceBoundaryState(this.getCustomer(lineUserId)), paused: false });
      return this.getCustomer(lineUserId);
    },

    setServiceBoundaryState(lineUserId, state) {
      const value = serviceBoundaryState({ service_boundary_json: JSON.stringify(state) });
      run("UPDATE customers SET service_boundary_json = ?, updated_at = ? WHERE line_user_id = ?",
        JSON.stringify(value), now(), String(lineUserId));
      return this.getCustomer(lineUserId);
    },

    suppressFollowupsForCustomer(lineUserId, reason) {
      const customerId = String(lineUserId ?? "");
      const closedReason = String(reason ?? "");
      if (!FOLLOWUP_SUPPRESSION_REASONS.has(closedReason)) {
        throw new Error("invalid followup suppression reason");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getCustomer(customerId);
        if (!existing) {
          db.exec("COMMIT");
          return null;
        }
        if (Number(existing.followup_enabled) !== 0 || existing.followup_suppression_reason !== closedReason) {
          run(
            `UPDATE customers SET followup_enabled = 0, followup_suppression_reason = ?, updated_at = ?
             WHERE line_user_id = ?`,
            closedReason, now(), customerId,
          );
        }
        run(
          `UPDATE followups SET status = 'cancelled', detail = ?, updated_at = ?
           WHERE customer_id = ? AND status = 'pending'`,
          `customer requested no follow-up: ${closedReason}`, now(), customerId,
        );
        db.exec("COMMIT");
        return this.getCustomer(customerId);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw error;
      }
    },

    // B2: แอดมินตอบเองจาก console -> AI พักถึงเวลานี้ (0 = ไม่พัก) — ต่ออายุทุกครั้งที่ตอบ
    setOperatorActiveUntil(lineUserId, untilMs) {
      run(
        "UPDATE customers SET operator_active_until = ?, updated_at = ? WHERE line_user_id = ?",
        Math.max(0, Number(untilMs) || 0), now(), String(lineUserId)
      );
      return this.getCustomer(lineUserId);
    },

    setDoNotDisturb(lineUserId, on) {
      run(
        "UPDATE customers SET do_not_disturb = ?, updated_at = ? WHERE line_user_id = ?",
        on ? 1 : 0, now(), String(lineUserId)
      );
      return this.getCustomer(lineUserId);
    },

    // operator ปิดเคส/เปิด AI กลับ — เคลียร์ธง NEEDS_HUMAN (เก็บ handoff summary ไว้เป็นประวัติ)
    clearNeedsHuman(lineUserId) {
      run(
        "UPDATE customers SET state = 'AI_ACTIVE', updated_at = ? WHERE line_user_id = ? AND state = 'NEEDS_HUMAN'",
        now(), String(lineUserId)
      );
      return this.getCustomer(lineUserId);
    },

    /* ------------------------------- messages ------------------------------ */

    // agentMode (B7d): 'ai' | 'operator_ai_on' | 'operator_ai_off' — แถวเก่าเป็น null
    // (ฝั่ง UI ตีความ null: มี operator = operator_ai_on, ไม่มี = ai)
    // W3: channelId ไม่ส่งมา = อ่านจากแถวลูกค้า (caller เดิมทุกจุดถูกต้องอัตโนมัติ)
    // settleTurnsUpTo = "คำตอบก้อนนี้ครอบข้อความลูกค้าถึงเวลาไหน" (ms)
    // ไม่ส่งมา = ครอบถึงตอนนี้ ซึ่งถูกต้องสำหรับคำตอบที่แอดมินคนจริงพิมพ์ (คนเห็นทั้งห้อง
    // ก่อนกดส่ง) แต่ผิดสำหรับ AI: ระหว่าง AI ทยอยส่งบอลลูน (เว้นจังหวะพิมพ์รวม ~12 วิ)
    // ลูกค้าพิมพ์แทรกเข้ามาได้ ข้อความแทรกนั้นยังไม่มีใครตอบ ห้ามถูกปิดเป็น 'answered'
    // เส้น AI จึงต้องส่ง inboundBasisAt (เวลาข้อความล่าสุด ณ ตอนเริ่มคิด) มาเสมอ
    insertMessage({ id = randomUUID(), customerId, direction, channel = "line", msgType = "text", content = "", messageClass = "reactive", operator = "", agentMode = null, channelId = null, sessionId = null, metadata = {}, settleTurnsUpTo = null, brainVersionId = null, freeclassPatterns = null }) {
      const ch = channelId
        ?? get("SELECT channel_id FROM customers WHERE line_user_id = ?", String(customerId))?.channel_id
        ?? "default";
      const session = sessionId == null
        ? this.ensureActiveConversationSession(customerId, ch)
        : { id: String(sessionId) };
      run(
        `INSERT INTO messages (id, customer_id, direction, channel, msg_type, content, message_class, operator, agent_mode, channel_id, session_id, metadata_json, brain_version_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(id), String(customerId), direction, channel, msgType, String(content), messageClass, String(operator),
        agentMode == null ? null : String(agentMode), String(ch), session?.id ?? null,
        JSON.stringify(withSoulStamp(metadata && typeof metadata === "object" ? metadata : {}, { direction, agentMode })),
        brainVersionId ? String(brainVersionId) : null, now()
      );
      // v1.4.49 (คำสั่งเจ้าของ 2026-08-29): ส่งลิงก์คลาสฟรี (บอทหรือแอดมิน) = ติดป้าย
      // "คลาสฟรี" อัตโนมัติ -> FU เว้น 7 วันโดยกติกา FREE_CLASS_QUIET_SQL ทันที
      // เฉพาะข้อความคุยจริงรายคน (reactive ขาออก) — ประวัติย้ายระบบและข้อความเชิงรุก
      // (FU/บรอดแคส) ไม่นับ เพราะไม่ใช่การยื่นของขวัญให้คนตรงหน้า
      try {
        if (direction === "out" && messageClass === "reactive" && String(operator) !== LEGACY_IMPORT_OPERATOR
            && !String(customerId).startsWith("canary:")) {
          this.autoTagFreeClass(customerId, String(content), { byHuman: Boolean(String(operator).trim()), patterns: freeclassPatterns });
          // ข้อความตอบจริงหนึ่งครั้ง = ปิดทุกเทิร์นที่ค้างอยู่ "ก่อนขอบเขตที่คำตอบนี้ครอบ"
          // ครอบทั้งคำตอบของ AI และของแอดมินคนจริง ในกติกาเดียว
          // follow-up/broadcast เป็น proactive จึงไม่นับว่าตอบ (ถูกต้อง — การทวงไม่ใช่การตอบ)
          // เทียบแบบ === 0 เท่านั้น (ห้ามใช้ Number() ครอบ — Number(null) ก็เป็น 0
          // ค่าเริ่มต้นจะกลายเป็น "ห้ามปิดหนี้" ทั้งระบบโดยไม่มีใครรู้)
          //   0    = ข้อความออกไปจริงแต่ยังไม่ถือว่าตอบครบ (ส่งไม่ครบ/ล้มกลางคัน หรือไม่มี
          //          ข้อความลูกค้าเป็นฐานเทียบเลยอย่างเส้น canary) -> ผู้เรียกจดสถานะเอง
          //   null = ไม่ระบุขอบเขต -> ครอบถึงตอนนี้ (คำตอบที่แอดมินคนจริงพิมพ์)
          //   > 0  = ครอบถึงเวลานั้น (เส้น AI ส่ง inboundBasisAt มา)
          if (settleTurnsUpTo !== 0) {
            const bound = Number(settleTurnsUpTo);
            const settleUpTo = Number.isFinite(bound) && bound > 0 ? bound : now();
            this.closeOwedTurnsUpTo(customerId, settleUpTo, { status: "answered", reason: "" });
          }
        }
      } catch { /* ป้าย/บัญชีผลลัพธ์เป็นของแถม — ห้ามทำการบันทึกข้อความล้ม */ }
      return id;
    },

    // N turns ล่าสุด (in=user, out=assistant) เรียงเก่า -> ใหม่ สำหรับ inject เข้า Hermes
    //
    // v1.5.1 (probe-memory-05/06 ตกจริง 2026-08-30): ข้อความที่แอดมินคนจริงพิมพ์
    // เคยกลายเป็น role assistant เฉย ๆ — โมเดลแยกไม่ออกว่าประโยคไหนเป็นคำรับปาก
    // ของทีมงาน (ข้อผูกพัน) ประโยคไหนเป็นคำพูดตัวเอง จึงกล้าปฏิเสธสิ่งที่แอดมิน
    // เพิ่งรับปากลูกค้าไป ("จัดที่นั่งหน้าจอให้" -> บอทตอบ "ไม่ได้ค่ะ")
    // ติดป้ายให้เห็นชัด — กติกาคู่กันอยู่ใน pipeline baseRules
    recentTurns(customerId, turns = 6) {
      const session = this.activeConversationSession(customerId);
      const HUMAN_PREFIX = "[แอดมินทีมงานพิมพ์เอง] ";
      const shape = (r) => ({
        role: r.direction === "in" ? "user" : "assistant",
        content: r.direction === "out" && String(r.operator || "").trim() && r.operator !== "system"
          ? HUMAN_PREFIX + r.content
          : r.content,
      });
      // Compatibility for read-only legacy/import fixtures that contain
      // messages without a customer row. Real webhook rows always have an
      // active session; once one exists, never fall back across sessions.
      if (!session) {
        const legacy = all(
          `SELECT direction, content, operator FROM messages
           WHERE customer_id = ? AND session_id IS NULL AND msg_type = 'text'
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          String(customerId), Math.max(0, turns) * 2
        );
        return legacy.reverse().map(shape);
      }
      const rows = all(
        `SELECT direction, content, operator FROM messages
         WHERE customer_id = ? AND session_id = ? AND msg_type = 'text'
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        String(customerId), session.id, Math.max(0, turns) * 2
      );
      return rows.reverse().map(shape);
    },

    // Separate scorer view: keep actor, source id, media kind and time without
    // changing the frozen reply-history contract. Media is evidence of contact,
    // not text that the scorer can pretend to have read.
    scoringEvidenceTurns(customerId, turns = 16) {
      const session = this.activeConversationSession(customerId);
      const params = [String(customerId)];
      const filter = session ? "session_id = ?" : "session_id IS NULL";
      if (session) params.push(session.id);
      params.push(Math.min(200, Math.max(0, Math.trunc(Number(turns) || 16))) * 2);
      return all(`SELECT id, direction, content, operator, msg_type, created_at
        FROM messages WHERE customer_id = ? AND ${filter}
        ORDER BY created_at DESC, rowid DESC LIMIT ?`, ...params).reverse().map((r) => ({
          ...r, role: r.direction === "in" ? "user" : "assistant",
        }));
    },

    // G4: keyset pagination ย้อนอดีต — beforeAt/beforeRid = cursor ของข้อความเก่าสุดที่โหลดแล้ว
    // (ไม่ใช้ OFFSET: แชทยาวหมื่นแถวต้องไม่ช้าลงตามความลึก) — คืนเรียงเก่า -> ใหม่เหมือนเดิม
    messagesFor(customerId, limit = 50, { beforeAt = null, beforeRid = null, includeArchived = false } = {}) {
      const params = [String(customerId)];
      const active = includeArchived ? null : this.activeConversationSession(customerId);
      const sessionFilter = active ? "AND session_id = ?" : (includeArchived ? "" : "AND session_id IS NULL");
      if (active) params.push(active.id);
      let cursor = "";
      if (beforeAt != null) {
        cursor = "AND (created_at < ? OR (created_at = ? AND rowid < ?))";
        params.push(Number(beforeAt), Number(beforeAt), Number(beforeRid) || 0);
      }
      return all(
        `SELECT rowid AS rid, id, direction, channel, msg_type, content, message_class, operator, agent_mode, metadata_json, created_at
         FROM messages WHERE customer_id = ? ${sessionFilter} ${cursor}
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        ...params, limit
      ).reverse();
    },

    // R3 (คำสั่งพี่ง้วง 2026-09-05 รอบสาม): ข้อความ "ขาเข้าที่เป็นข้อความจริง" ล่าสุด
    // สำหรับใบ้ย้อนหลังของการส่งไม้ต่อ
    //
    // รอบสองยืม messagesFor(12) มาใช้แล้วกรองในหน่วยความจำ ซึ่งพังสองทาง: (1) ถ้าสิบสอง
    // แถวหลังสุดเป็นรูป/สติกเกอร์/ข้อความขาออกล้วน ข้อความขาเข้าจริงหลุดหน้าต่างไปเงียบ ๆ
    // (2) มันมองไม่เห็นว่า "แอดมินคนจริงเข้ามาตอบไปแล้ว" ซึ่งคือจุดเริ่มของบทสนทนาช่วงใหม่
    // — หลังคนตอบ ใบ้เก่าของบอทไม่ควรมีน้ำหนักอีกต่อไป
    //
    // ผูกกับ session ที่ใช้งานอยู่เหมือน messagesFor เสมอ (/reset จึงล้างใบ้ให้เองอัตโนมัติ)
    recentInboundTextsForHandoff(customerId, { limit = 2, sinceMs = 0 } = {}) {
      const id = String(customerId);
      const active = this.activeConversationSession(id);
      const sessionFilter = active ? "AND session_id = ?" : "AND session_id IS NULL";
      const scope = active ? [id, active.id] : [id];
      const humanReply = get(
        `SELECT MAX(created_at) AS at FROM messages
          WHERE customer_id = ? ${sessionFilter} AND direction = 'out' AND operator <> ''`,
        ...scope,
      );
      const floor = Math.max(Number(sinceMs) || 0, Number(humanReply?.at) || 0);
      return all(
        `SELECT content FROM messages
          WHERE customer_id = ? ${sessionFilter}
            AND direction = 'in' AND msg_type = 'text' AND created_at > ?
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        ...scope, floor, Math.max(1, Number(limit) || 1),
      ).map((row) => String(row.content || ""));
    },

    // A later inbound message is useful evidence of customer interaction, but
    // LINE does not expose which earlier bubble was read. Resolve this against
    // the complete customer timeline (not only the current Console page), and
    // mark only the final outbound row immediately before an inbound run.
    customerReplyInteractionsForMessages(customerId, messageIds = []) {
      const ids = [...new Set(messageIds.map(String).filter(Boolean))].slice(0, 200);
      if (!ids.length) return [];
      const requestedRows = ids.map(() => "(?)").join(",");
      return all(
        `WITH requested(id) AS (VALUES ${requestedRows}),
         candidates AS (
           SELECT message.rowid AS rid,message.id,message.customer_id,message.created_at
             FROM requested
             CROSS JOIN messages AS message
            WHERE message.id = requested.id
              AND message.customer_id = ? AND message.direction='out'
         ), next_rows AS (
           SELECT candidate.id,
                  COALESCE(
                    (SELECT same_time.rowid
                       FROM messages AS same_time
                      WHERE same_time.customer_id = candidate.customer_id
                        AND same_time.created_at = candidate.created_at
                        AND same_time.rowid > candidate.rid
                      ORDER BY same_time.rowid ASC
                      LIMIT 1),
                    (SELECT later.rowid
                       FROM messages AS later
                      WHERE later.customer_id = candidate.customer_id
                        AND later.created_at > candidate.created_at
                      ORDER BY later.created_at ASC,later.rowid ASC
                      LIMIT 1)
                  ) AS next_rid
             FROM candidates AS candidate
         )
         SELECT next_rows.id,later.created_at AS replied_at
           FROM next_rows
           JOIN messages AS later ON later.rowid = next_rows.next_rid
          WHERE later.direction='in'`,
        ...ids, String(customerId),
      );
    },

    addMessageAttachment({ id = randomUUID(), messageId = null, customerId, direction, source = "line", kind, status = "unavailable", originalName = "", mime = "", byteSize = null, sha256 = "", storageKey = "", providerMessageId = "", providerMeta = {}, unavailableReason = "", createdBy = "" }) {
      const t = now();
      run(`INSERT INTO message_attachments (id,message_id,customer_id,direction,source,kind,status,original_name,mime,byte_size,sha256,storage_key,provider_message_id,provider_meta_json,unavailable_reason,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, String(id), messageId == null ? null : String(messageId), String(customerId), String(direction), String(source), String(kind), String(status), String(originalName).slice(0, 255), String(mime).slice(0, 120), byteSize == null ? null : Number(byteSize), String(sha256), String(storageKey), String(providerMessageId), JSON.stringify(providerMeta && typeof providerMeta === "object" ? providerMeta : {}), String(unavailableReason).slice(0, 240), String(createdBy), t, t);
      return id;
    },

    // Store fixed operational evidence after a classifier attempt. The lookup
    // binds the canonical persisted message and attachment together, so a raw
    // provider id from another customer/channel cannot create a record.
    recordInboundImageClassification({ customerId, messageId, providerMessageId, classificationState, classifiedKind, diagnosticCode, action } = {}) {
      const customer = String(customerId || "");
      const message = String(messageId || "");
      const provider = String(providerMessageId || "");
      const states = new Set(["classified", "download_unavailable", "classifier_error", "classifier_disabled"]);
      const kinds = new Set(["slip", "document", "other", "unknown"]);
      const diagnostics = new Set(["valid", "disabled", "no_file", "read_error", "no_bytes", "too_large", "bad_mime", "no_model", "model_error", "unparsable", "invalid_response", "unavailable"]);
      const actions = new Set(["text_pipeline", "human_review"]);
      if (!customer || !message || !states.has(String(classificationState)) || !kinds.has(String(classifiedKind)) || !diagnostics.has(String(diagnosticCode)) || !actions.has(String(action))) return null;
      const canonical = get(
        "SELECT id FROM messages WHERE id=? AND customer_id=? AND direction='in' AND msg_type='image'",
        message, customer,
      );
      if (!canonical) return null;
      const attachment = get(
        `SELECT provider_message_id,status,unavailable_reason FROM message_attachments
          WHERE message_id=? AND customer_id=? AND direction='in' AND kind='image'
          ORDER BY created_at DESC LIMIT 1`,
        message, customer,
      );
      // An attachment supplies the authoritative provider mapping. If the
      // media row was not persisted (cap/failure), retain the diagnostic
      // anchored to the canonical message but do not copy caller input.
      const attachmentProvider = String(attachment?.provider_message_id || "");
      // A classifier can finish after LINE's unsend handler erased the prior
      // observation. That source has been withdrawn, so never recreate its
      // derived evidence. Other unavailable download states remain observable.
      if (attachment?.status === "unavailable" && attachment?.unavailable_reason === "ผู้ส่งถอนข้อความจาก LINE แล้ว") return null;
      if (attachmentProvider && attachmentProvider !== provider) return null;
      const persistedProvider = attachmentProvider ? provider : "";
      const t = now();
      run(
        `INSERT INTO inbound_image_classifications
          (message_id,customer_id,provider_message_id,classification_state,classified_kind,diagnostic_code,action,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(message_id) DO UPDATE SET
           customer_id=excluded.customer_id,provider_message_id=excluded.provider_message_id,
           classification_state=excluded.classification_state,classified_kind=excluded.classified_kind,
           diagnostic_code=excluded.diagnostic_code,action=excluded.action,updated_at=excluded.updated_at`,
        message, customer, persistedProvider, String(classificationState), String(classifiedKind), String(diagnosticCode), String(action), t, t,
      );
      return this.getInboundImageClassification({ customerId: customer, messageId: message });
    },

    getInboundImageClassification({ customerId, messageId } = {}) {
      return get(
        `SELECT message_id,classification_state,classified_kind,diagnostic_code,action,updated_at
           FROM inbound_image_classifications WHERE customer_id=? AND message_id=?`,
        String(customerId || ""), String(messageId || ""),
      ) ?? null;
    },

    // Signed inbound LINE persistence is one durability boundary. Dedupe must
    // roll back if message or attachment persistence fails, otherwise LINE
    // redelivery would be skipped and the media could never be recovered.
    // audit 2026-08-25: แถว attachment กับ audit เคยเป็นสอง autocommit ใน try เดียว —
    // audit ล้ม -> catch ลบไฟล์ทิ้ง แต่แถว attachment ยัง commit ค้าง ชี้ไปยังไฟล์ที่ไม่มีแล้ว
    // มัดเป็นหน่วยเดียวแบบเดียวกับ persistLineInbound
    addOperatorAttachmentWithAudit({ attachment = {}, audit = {} } = {}) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const id = this.addMessageAttachment(attachment);
        this.addAudit(audit);
        db.exec("COMMIT");
        return id;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },

    // owesReply = "เทิร์นนี้จะเดินต่อเข้า pipeline จริง" -> จดหนี้คำตอบไว้ในธุรกรรมเดียวกัน
    // (คำสั่งเทรน /reset, /fb, non-message event ตอบ ack เอง จึงไม่จดหนี้)
    persistLineInbound({ dedupeKey, customerId, channelId = "default", msgType = "unknown", content = "", metadata = {}, attachment = null, mediaMaxCount = 10_000, mediaMaxBytes = 4 * 1024 * 1024 * 1024, owesReply = false, channelKind = "line", processId = "" } = {}) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const fresh = run(
          "INSERT OR IGNORE INTO events_dedupe (message_id, seen_at) VALUES (?, ?)",
          String(dedupeKey), now(),
        ).changes === 1;
        if (!fresh) {
          db.exec("COMMIT");
          return { stored: false, reason: "duplicate", attachmentStored: false };
        }
        this.upsertCustomer(customerId, { channelId });
        const messageId = `in:${dedupeKey}`;
        let attachmentId = null;
        let attachmentSkipped = false;
        let resolvedMetadata = metadata && typeof metadata === "object" ? { ...metadata } : {};
        if (attachment) {
          const inventory = get(`SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(byte_size,0)),0) AS bytes FROM message_attachments`) || { count: 0, bytes: 0 };
          const estimatedBytes = Math.max(0, Number(attachment.byteSize) || 0);
          if (inventory.count >= Number(mediaMaxCount) || inventory.bytes + estimatedBytes > Number(mediaMaxBytes)) {
            attachmentSkipped = true;
            resolvedMetadata = { ...resolvedMetadata, mediaAttachmentSkipped: true, mediaUnavailableReason: "คลังสื่อถึงเพดาน" };
          }
        }
        // จับเวลา "ก่อน" เขียนแถวข้อความเสมอ — แถวหนี้ต้องไม่ใหม่กว่าข้อความของตัวเอง
        // ไม่งั้นด่านปิดหนี้ที่เทียบ created_at <= เวลาข้อความล่าสุด จะพลาดหนี้ก้อนของตัวเอง
        // ไปหนึ่งมิลลิวินาที แล้วเทิร์นที่ตอบไปแล้วจะค้างเป็น 'owed' ข้ามคืน
        const stampedAt = now();
        this.insertMessage({ id: messageId, customerId, direction: "in", msgType, channelId, content, metadata: resolvedMetadata });
        if (attachment && !attachmentSkipped) {
          attachmentId = this.addMessageAttachment({ ...attachment, messageId, customerId, direction: "in" });
        }
        // หนี้คำตอบต้อง commit พร้อมข้อความเสมอ — แยกกันเมื่อไหร่ ช่องที่ทำให้ห้องเงียบถาวร
        // กลับมาทันที เป็น INSERT เพิ่มในธุรกรรมที่มีอยู่แล้ว ไม่เพิ่มธุรกรรม ไม่เพิ่ม fsync
        if (owesReply) {
          run(
            `INSERT OR IGNORE INTO inbound_turn_outcomes
              (message_id, customer_id, channel_id, channel_kind, status, process_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'owed', ?, ?, ?)`,
            messageId, String(customerId), String(channelId), String(channelKind),
            String(processId), stampedAt, stampedAt,
          );
        }
        db.exec("COMMIT");
        return { stored: true, reason: "new", messageId, attachmentId, attachmentStored: Boolean(attachmentId), attachmentSkipped };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },

    /* --------------------- บัญชีผลลัพธ์เทิร์นขาเข้า (ไม่ใช่คิวงาน) -------------------- */
    //
    // ทุกเมธอดในบล็อกนี้เป็น UPDATE/SELECT ธรรมดา ห้ามเปิดธุรกรรมของตัวเองเด็ดขาด
    // เพราะบางตัวถูกเรียกจากใน insertMessage ซึ่งอาจอยู่ใน BEGIN IMMEDIATE ค้างอยู่แล้ว
    // (persistLineInbound / insertMessageWithAttachments) — เปิดซ้อนจะพังทั้งธุรกรรม

    closeInboundTurn(messageId, { status, reason = "" } = {}) {
      return run(
        `UPDATE inbound_turn_outcomes SET status = ?, reason = ?, updated_at = ?
         WHERE message_id = ? AND status IN ('owed','sending')`,
        String(status), String(reason).slice(0, 120), now(), String(messageId),
      ).changes || 0;
    },

    // ปิดเทิร์นทุกก้อนของลูกค้าคนนี้ที่เกิดก่อนเวลา atMs
    // ครอบ burst absorbed + merged_forward + safety_preempted + เทิร์นเก่าที่คำตอบนี้ครอบไปแล้ว
    closeOwedTurnsUpTo(customerId, atMs, { status, reason = "" } = {}) {
      return run(
        `UPDATE inbound_turn_outcomes SET status = ?, reason = ?, updated_at = ?
         WHERE customer_id = ? AND status IN ('owed','sending') AND created_at <= ?`,
        String(status), String(reason).slice(0, 120), now(),
        String(customerId), Number(atMs),
      ).changes || 0;
    },

    // ปิดเทิร์นนี้ พร้อมเทิร์นพี่น้องที่ "รอเทิร์นนี้ตอบให้" ในห้องเดียวกัน
    //
    // burst รวมหลายข้อความเป็นเทิร์นเดียว ข้อความที่ถูกดูดเข้าไป (absorbed) ถูกปล่อยค้าง
    // เป็น 'owed' โดยเจตนา เพราะปกติจะถูกปิดตอนคำตอบถูกบันทึกขาออก แต่ถ้าเทิร์นผู้นำ
    // "ตั้งใจเงียบ" (นอกเวลาทำการ / AI ปิด / แอดมินรับช่วง) จะไม่มีขาออกมาปิดให้เลย
    // แถวพี่น้องจึงค้าง owed ข้ามคืน แล้วบูตครั้งหน้าปลุกคนด้วยข้อความเท็จว่า
    // "ระบบดับก่อนบอทได้ตอบ" ทั้งที่ระบบทำถูกทุกอย่าง — ปิดพร้อมกันที่นี่จบเรื่อง
    closeInboundTurnWithEarlier(messageId, { status, reason = "" } = {}) {
      const row = get(
        "SELECT customer_id, created_at FROM inbound_turn_outcomes WHERE message_id = ?",
        String(messageId),
      );
      if (!row) return 0;
      return this.closeOwedTurnsUpTo(row.customer_id, row.created_at, { status, reason });
    },

    markInboundTurnSending(messageId, processId = "") {
      return run(
        `UPDATE inbound_turn_outcomes SET status = 'sending', process_id = ?, updated_at = ?
         WHERE message_id = ? AND status = 'owed'`,
        String(processId), now(), String(messageId),
      ).changes === 1;
    },

    // synchronous — ใช้ตอน hard exit เท่านั้น (node:sqlite DatabaseSync)
    //
    // คืน "แถวที่ได้รับผลกระทบ" ออกไปด้วย เพราะแถวพวกนี้ถูกปิดเป็นสถานะสุดท้ายทันที
    // ตัวกวาดตอนบูตรอบหน้าซึ่งมองเฉพาะ owed/sending จึงมองไม่เห็นมันอีกเลย
    // ผู้เรียกต้องปักธงให้คนรับต่อ "ตรงนี้" ไม่งั้นเทิร์นหายเงียบ = บั๊กเดิมทุกประการ
    strandOpenTurnsForProcess(processId) {
      const rows = all(
        `SELECT * FROM inbound_turn_outcomes
         WHERE process_id = ? AND status IN ('owed','sending')
         ORDER BY created_at ASC`,
        String(processId),
      );
      const owed = run(
        `UPDATE inbound_turn_outcomes SET status = 'stranded_shutdown', reason = 'hard_exit', updated_at = ?
         WHERE process_id = ? AND status = 'owed'`,
        now(), String(processId),
      ).changes || 0;
      const sending = run(
        `UPDATE inbound_turn_outcomes SET status = 'stranded_ambiguous', reason = 'hard_exit_during_send', updated_at = ?
         WHERE process_id = ? AND status = 'sending'`,
        now(), String(processId),
      ).changes || 0;
      return { owed, sending, rows };
    },

    listPreviousProcessOpenTurns(processId, limit = 200) {
      return all(
        `SELECT * FROM inbound_turn_outcomes
         WHERE status IN ('owed','sending') AND process_id <> ?
         ORDER BY created_at ASC LIMIT ?`,
        String(processId), Math.min(1000, Math.max(1, Number(limit) || 200)),
      );
    },

    // มีคำตอบ (AI หรือคนจริง) ตามหลังเทิร์นนี้ไหม — ใช้กันเตือนผิดตอน boot
    hasReactiveOutboundSince(customerId, sinceMs) {
      return Boolean(get(
        `SELECT 1 AS yes FROM messages
         WHERE customer_id = ? AND direction = 'out' AND message_class = 'reactive'
           AND created_at >= ? LIMIT 1`,
        String(customerId), Number(sinceMs),
      ));
    },

    strandedTurns({ sinceMs = 0, limit = 100 } = {}) {
      return all(
        `SELECT * FROM inbound_turn_outcomes
         WHERE status LIKE 'stranded_%' AND created_at >= ?
         ORDER BY created_at DESC LIMIT ?`,
        Number(sinceMs), Math.min(500, Math.max(1, Number(limit) || 100)),
      );
    },

    attachmentsForMessages(messageIds = []) {
      const ids = [...new Set(messageIds.map(String).filter(Boolean))];
      if (!ids.length) return [];
      return all(`SELECT id,message_id,customer_id,direction,kind,status,original_name,mime,byte_size,provider_meta_json,unavailable_reason,created_at FROM message_attachments WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at ASC`, ...ids);
    },

    getMessageAttachment(id) { return get("SELECT * FROM message_attachments WHERE id = ?", String(id)); },
    listMessageAttachmentsForCustomer(customerId) {
      return all("SELECT * FROM message_attachments WHERE customer_id = ? ORDER BY created_at ASC", String(customerId));
    },
    countLegacyPublicChatMedia(customerId) {
      return Number(get(
        `SELECT COUNT(*) AS n FROM messages
          WHERE customer_id=? AND direction='out' AND msg_type='image'
            AND content LIKE '[image:upload\\_%' ESCAPE '\\'`,
        String(customerId),
      )?.n) || 0;
    },
    listMessageAttachmentsByProviderMessageId(providerMessageId) {
      return all("SELECT * FROM message_attachments WHERE provider_message_id = ?", String(providerMessageId));
    },
    claimDueMessageAttachments({ limit = 2, nowAt = now(), maxAttempts = 6, leaseMs = 60_000 } = {}) {
      // Crash after the final lease must not leave an invisible queued row
      // forever. It becomes an explicit operator-visible terminal failure.
      run("UPDATE message_attachments SET status='failed', unavailable_reason='ดาวน์โหลดเกินจำนวนครั้งที่อนุญาต', updated_at=? WHERE status='queued' AND attempts >= ? AND next_attempt_at <= ?", Number(nowAt), Number(maxAttempts), Number(nowAt));
      const rows = all("SELECT id FROM message_attachments WHERE status = 'queued' AND next_attempt_at <= ? AND attempts < ? ORDER BY created_at ASC LIMIT ?", Number(nowAt), Number(maxAttempts), Math.max(1, Math.min(10, Number(limit) || 2)));
      const out = [];
      for (const row of rows) {
        const changed = run("UPDATE message_attachments SET attempts=attempts+1, next_attempt_at=? , updated_at=? WHERE id=? AND status='queued' AND next_attempt_at <= ?", Number(nowAt) + Number(leaseMs), Number(nowAt), row.id, Number(nowAt));
        if (changed?.changes) out.push(get("SELECT * FROM message_attachments WHERE id=?", row.id));
      }
      return out;
    },
    rescheduleMessageAttachment(id, { nextAttemptAt, reason = "" }) {
      run("UPDATE message_attachments SET status='queued', next_attempt_at=?, unavailable_reason=?, updated_at=? WHERE id=?", Number(nextAttemptAt), String(reason).slice(0, 240), now(), String(id));
      return this.getMessageAttachment(id);
    },

    updateMessageAttachment(id, { status, mime = "", byteSize = null, sha256 = "", storageKey = "", clearStorageKey = false, unavailableReason = "" } = {}) {
      run(`UPDATE message_attachments SET status=?, mime=CASE WHEN ? != '' THEN ? ELSE mime END, byte_size=COALESCE(?,byte_size), sha256=CASE WHEN ? != '' THEN ? ELSE sha256 END, storage_key=CASE WHEN ? THEN '' WHEN ? != '' THEN ? ELSE storage_key END, unavailable_reason=?, updated_at=? WHERE id=?`, String(status), String(mime), String(mime), byteSize == null ? null : Number(byteSize), String(sha256), String(sha256), clearStorageKey ? 1 : 0, String(storageKey), String(storageKey), String(unavailableReason).slice(0, 240), now(), String(id));
      return this.getMessageAttachment(id);
    },
    createAttachmentDownloadToken({ tokenHash, attachmentId, expiresAt }) {
      run("INSERT INTO attachment_download_tokens (token_hash,attachment_id,expires_at,created_at) VALUES (?,?,?,?)", String(tokenHash), String(attachmentId), Number(expiresAt), now());
    },
    createAttachmentDownloadTokens(items = []) {
      const rows = Array.isArray(items) ? items : [];
      if (!rows.length) return 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const item of rows) {
          run("INSERT INTO attachment_download_tokens (token_hash,attachment_id,expires_at,created_at) VALUES (?,?,?,?)", String(item.tokenHash), String(item.attachmentId), Number(item.expiresAt), now());
        }
        db.exec("COMMIT");
        return rows.length;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    },
// audit 2026-08-25: schema มี consumed_at และ query กรอง consumed_at IS NULL อยู่แล้ว
    // แต่ไม่มีโค้ดไหนเขียนค่านั้นเลย = grant ไฟล์ใช้ซ้ำได้ตลอด TTL
    // (เส้น /line-media ของรูปจงใจใช้ซ้ำได้ เพราะ LINE ดึงรูปซ้ำเป็นปกติ)
    consumeAttachmentDownloadToken(tokenHash) {
      return run(
        "UPDATE attachment_download_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL",
        now(), String(tokenHash)
      ).changes === 1;
    },

    activeAttachmentDownloadToken(tokenHash, at = now()) {
      return get("SELECT * FROM attachment_download_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at >= ?", String(tokenHash), Number(at));
    },
    revokeAttachmentDownloadTokens(tokenHashes = []) {
      const hashes = [...new Set(tokenHashes.map(String).filter(Boolean))];
      if (!hashes.length) return 0;
      return run(`DELETE FROM attachment_download_tokens WHERE token_hash IN (${hashes.map(() => "?").join(",")})`, ...hashes).changes || 0;
    },
    revokeAttachmentDownloadTokensForAttachment(attachmentId) {
      return run("DELETE FROM attachment_download_tokens WHERE attachment_id = ?", String(attachmentId)).changes || 0;
    },
    attachmentUploadUsage(operator, sinceAt) {
      return get(
        `SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes
           FROM message_attachments
          WHERE source='operator_upload' AND created_by=? AND created_at >= ?`,
        String(operator), Number(sinceAt),
      ) || { count: 0, bytes: 0 };
    },
    attachmentUploadTotalUsage(operator) {
      return get(
        `SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes
           FROM message_attachments
          WHERE source='operator_upload' AND created_by=?`,
        String(operator),
      ) || { count: 0, bytes: 0 };
    },
    messageMediaUsage() {
      return get(
        `SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes
           FROM message_attachments
          WHERE status='ready' AND storage_key != ''`,
      ) || { count: 0, bytes: 0 };
    },
    messageMediaInventory() {
      return get(
        `SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(byte_size,0)),0) AS bytes
           FROM message_attachments`,
      ) || { count: 0, bytes: 0 };
    },
    reserveMessageMediaUpload({ operator, byteSize, sinceAt, expiresAt, hourlyCountLimit, hourlyBytesLimit, totalCountLimit, totalBytesLimit, maxConcurrent, maxConcurrentPerOperator }) {
      const reservationId = randomUUID();
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        run("DELETE FROM message_media_upload_reservations WHERE expires_at <= ?", t);
        const active = get("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes FROM message_media_upload_reservations") || { count: 0, bytes: 0 };
        const activeOperator = get("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes FROM message_media_upload_reservations WHERE operator = ?", String(operator)) || { count: 0, bytes: 0 };
        const hourlyStored = this.attachmentUploadUsage(operator, sinceAt);
        const hourlyReserved = get("SELECT COUNT(*) AS count, COALESCE(SUM(byte_size),0) AS bytes FROM message_media_upload_reservations WHERE operator = ? AND created_at >= ?", String(operator), Number(sinceAt)) || { count: 0, bytes: 0 };
        const stored = this.messageMediaUsage();
        let reason = "";
        if (active.count >= Number(maxConcurrent) || activeOperator.count >= Number(maxConcurrentPerOperator)) reason = "concurrent";
        else if (hourlyStored.count + hourlyReserved.count >= Number(hourlyCountLimit) || hourlyStored.bytes + hourlyReserved.bytes + Number(byteSize) > Number(hourlyBytesLimit)) reason = "operator_quota";
        else if (stored.count + active.count >= Number(totalCountLimit) || stored.bytes + active.bytes + Number(byteSize) > Number(totalBytesLimit)) reason = "global_quota";
        if (reason) {
          db.exec("COMMIT");
          return { ok: false, reason };
        }
        run("INSERT INTO message_media_upload_reservations (id,operator,byte_size,expires_at,created_at) VALUES (?,?,?,?,?)", reservationId, String(operator), Number(byteSize), Number(expiresAt), t);
        db.exec("COMMIT");
        return { ok: true, id: reservationId };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },
    releaseMessageMediaUploadReservation(id) {
      return run("DELETE FROM message_media_upload_reservations WHERE id = ?", String(id)).changes === 1;
    },

    claimMessageAttachmentsForSend({ attachmentIds = [], customerId, claimId = randomUUID(), expiresAt }) {
      const ids = [...new Set(attachmentIds.map(String).filter(Boolean))];
      if (!ids.length) return { ok: true, claimId: "" };
      db.exec("BEGIN IMMEDIATE");
      try {
        const t = now();
        for (const attachmentId of ids) {
          const changed = run(
            `UPDATE message_attachments
                SET send_claim_id=?, send_claim_expires_at=?, updated_at=?
              WHERE id=? AND customer_id=? AND direction='out' AND source='operator_upload'
                AND status='ready' AND (message_id IS NULL OR message_id='')
                AND (send_claim_id='' OR send_claim_expires_at<=?)`,
            String(claimId), Number(expiresAt), t, attachmentId, String(customerId), t,
          ).changes;
          if (changed !== 1) throw new Error("attachment already claimed");
        }
        db.exec("COMMIT");
        return { ok: true, claimId: String(claimId) };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        return { ok: false, reason: "attachment_claim_failed" };
      }
    },
    releaseMessageAttachmentsSendClaim(claimId) {
      if (!claimId) return 0;
      return run(
        "UPDATE message_attachments SET send_claim_id='',send_claim_expires_at=0,updated_at=? WHERE send_claim_id=? AND (message_id IS NULL OR message_id='')",
        now(), String(claimId),
      ).changes || 0;
    },

    createOperatorOutboundAttempt({ id = randomUUID(), customerId, operator = "", payload = {}, attachmentIds = [], claimId = "" }) {
      const payloadJson = serializeOutboundPayload(payload);
      const ids = normalizeOutboundAttachmentIds(attachmentIds);
      const t = now();
      run(
        `INSERT INTO operator_outbound_attempts
          (id,customer_id,operator,status,payload_json,attachment_ids_json,claim_id,provider_status,created_at,updated_at)
         VALUES (?,?,?,'sending',?,?,?,0,?,?)`,
        String(id), String(customerId), String(operator), payloadJson, JSON.stringify(ids), String(claimId), t, t,
      );
      return this.getOperatorOutboundAttempt(id);
    },
    prepareOperatorOutboundAttempt({
      id = randomUUID(), customerId, operator = "", payload = {}, attachmentIds = [],
      claimId = randomUUID(), claimExpiresAt, downloadTokens = [],
    }) {
      const payloadJson = serializeOutboundPayload(payload);
      const ids = normalizeOutboundAttachmentIds(attachmentIds);
      const grants = Array.isArray(downloadTokens) ? downloadTokens : [];
      if (grants.length !== ids.length) throw new Error("outbound grants do not match attachments");
      const grantAttachmentIds = [...new Set(grants.map((item) => String(item?.attachmentId || "")).filter(Boolean))];
      if (grantAttachmentIds.length !== ids.length || ids.some((attachmentId) => !grantAttachmentIds.includes(attachmentId))) {
        throw new Error("outbound grants do not cover attachments");
      }
      const t = now();
      const durableClaimId = ids.length ? String(claimId) : "";
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const attachmentId of ids) {
          const changed = run(
            `UPDATE message_attachments
                SET send_claim_id=?, send_claim_expires_at=?, updated_at=?
              WHERE id=? AND customer_id=? AND direction='out' AND source='operator_upload'
                AND status='ready' AND (message_id IS NULL OR message_id='')
                AND (send_claim_id='' OR send_claim_expires_at<=?)`,
            durableClaimId, Number(claimExpiresAt), t, attachmentId, String(customerId), t,
          ).changes;
          if (changed !== 1) throw new Error("attachment already claimed");
        }
        for (const item of grants) {
          run(
            "INSERT INTO attachment_download_tokens (token_hash,attachment_id,expires_at,created_at) VALUES (?,?,?,?)",
            String(item.tokenHash), String(item.attachmentId), Number(item.expiresAt), t,
          );
        }
        run(
          `INSERT INTO operator_outbound_attempts
            (id,customer_id,operator,status,payload_json,attachment_ids_json,claim_id,provider_status,created_at,updated_at)
           VALUES (?,?,?,'sending',?,?,?,0,?,?)`,
          String(id), String(customerId), String(operator), payloadJson, JSON.stringify(ids), durableClaimId, t, t,
        );
        db.exec("COMMIT");
        return this.getOperatorOutboundAttempt(id);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
        throw error;
      }
    },
    getOperatorOutboundAttempt(id) {
      return get("SELECT * FROM operator_outbound_attempts WHERE id = ?", String(id)) ?? null;
    },
    listOperatorOutboundAttempts(status = null, limit = 100) {
      const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
      return status
        ? all("SELECT * FROM operator_outbound_attempts WHERE status=? ORDER BY created_at ASC LIMIT ?", String(status), bounded)
        : all("SELECT * FROM operator_outbound_attempts ORDER BY created_at ASC LIMIT ?", bounded);
    },
    setOperatorOutboundAttemptStatus(id, status, providerStatus = 0) {
      if (!["sending", "accepted_pending", "partial_pending", "accepted", "partial", "rejected", "ambiguous"].includes(status)) return false;
      return run(
        "UPDATE operator_outbound_attempts SET status=?,provider_status=?,updated_at=? WHERE id=? AND status!='accepted'",
        String(status), Math.max(0, Number(providerStatus) || 0), now(), String(id),
      ).changes === 1;
    },
    setPartialOperatorOutboundAttemptProjection(id, { payload = {}, attachmentIds = [], providerStatus = 0 } = {}) {
      const payloadJson = serializeOutboundPayload(payload);
      const ids = normalizeOutboundAttachmentIds(attachmentIds);
      return run(
        `UPDATE operator_outbound_attempts
            SET status='partial_pending',payload_json=?,attachment_ids_json=?,provider_status=?,updated_at=?
          WHERE id=? AND status='sending'`,
        payloadJson, JSON.stringify(ids), Math.max(0, Number(providerStatus) || 0), now(), String(id),
      ).changes === 1;
    },
    setAcceptedOperatorOutboundAttemptProjection(id, { payload = {}, attachmentIds = [], providerStatus = 0 } = {}) {
      const payloadJson = serializeOutboundPayload(payload);
      const ids = normalizeOutboundAttachmentIds(attachmentIds);
      return run(
        `UPDATE operator_outbound_attempts
            SET status='accepted_pending',payload_json=?,attachment_ids_json=?,provider_status=?,updated_at=?
          WHERE id=? AND status='sending'`,
        payloadJson, JSON.stringify(ids), Math.max(0, Number(providerStatus) || 0), now(), String(id),
      ).changes === 1;
    },
    finalizeAcceptedOperatorOutboundAttempt(id) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const attempt = get("SELECT * FROM operator_outbound_attempts WHERE id = ?", String(id));
        if (!attempt) throw new Error("outbound attempt missing");
        if (attempt.status === "accepted" || attempt.status === "partial") {
          db.exec("COMMIT");
          return { ok: true, alreadyFinalized: true };
        }
        if (attempt.status !== "accepted_pending" && attempt.status !== "partial_pending") throw new Error("outbound attempt is not provider-accepted");
        const terminalStatus = attempt.status === "partial_pending" ? "partial" : "accepted";
        let payload;
        let attachmentIds;
        try {
          payload = JSON.parse(attempt.payload_json || "{}");
          attachmentIds = JSON.parse(attempt.attachment_ids_json || "[]");
        } catch { throw new Error("outbound attempt payload malformed"); }
        const rows = Array.isArray(payload?.historyRows) ? payload.historyRows : [];
        if (!rows.length || rows.length > 8 || !Array.isArray(attachmentIds) || attachmentIds.length > 6) throw new Error("outbound attempt payload invalid");
        const attachmentMessageId = String(payload.attachmentMessageId || "");
        const attachmentMessageIds = payload?.attachmentMessageIds && typeof payload.attachmentMessageIds === "object" && !Array.isArray(payload.attachmentMessageIds)
          ? payload.attachmentMessageIds
          : {};
        for (const [index, row] of rows.entries()) {
          if (!row?.id || row.customerId !== attempt.customer_id || row.direction !== "out") throw new Error("outbound history row invalid");
          // Persist the exact provider proof with the history row. LINE does
          // not expose a customer-read receipt, so this metadata must never be
          // promoted beyond provider request acceptance. batchTail keeps the
          // Console status to one chip per operator send instead of repeating
          // it under every text/image/sticker bubble in the same request.
          this.insertMessage({
            ...row,
            metadata: {
              ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
              operatorDelivery: {
                attemptId: attempt.id,
                state: terminalStatus,
                providerStatus: Math.max(0, Number(attempt.provider_status) || 0),
                batchTail: index === rows.length - 1,
              },
            },
          });
        }
        if (attachmentIds.length) {
          for (const attachmentId of [...new Set(attachmentIds.map(String).filter(Boolean))]) {
            const messageId = String(attachmentMessageIds[attachmentId] || attachmentMessageId || "");
            if (!messageId || !rows.some((row) => row.id === messageId)) throw new Error("outbound attachment message missing");
            const changed = run(
              `UPDATE message_attachments SET message_id=?,send_claim_id='',send_claim_expires_at=0,updated_at=?
               WHERE id=? AND customer_id=? AND direction='out' AND source='operator_upload'
                 AND status='ready' AND (message_id IS NULL OR message_id='') AND send_claim_id=?`,
              messageId, now(), attachmentId, attempt.customer_id, attempt.claim_id,
            ).changes;
            if (changed !== 1) throw new Error("outbound attachment recovery link failed");
          }
        }
        this.setOperatorActiveUntil(attempt.customer_id, Number(payload.operatorActiveUntil) || now());
        run("UPDATE operator_outbound_attempts SET status=?,updated_at=? WHERE id=?", terminalStatus, now(), attempt.id);
        db.exec("COMMIT");
        return { ok: true, alreadyFinalized: false, status: terminalStatus };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },
    recoverAcceptedOperatorOutboundAttempts(limit = 100) {
      const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
      const attempts = all(
        "SELECT * FROM operator_outbound_attempts WHERE status IN ('accepted_pending','partial_pending') ORDER BY created_at ASC LIMIT ?",
        bounded,
      );
      let recovered = 0;
      let failed = 0;
      for (const attempt of attempts) {
        try { this.finalizeAcceptedOperatorOutboundAttempt(attempt.id); recovered += 1; }
        catch { failed += 1; }
      }
      return { attempted: attempts.length, recovered, failed };
    },
    quarantineInterruptedOperatorOutboundAttempts() {
      return run(
        "UPDATE operator_outbound_attempts SET status='ambiguous',updated_at=? WHERE status='sending'",
        now(),
      ).changes || 0;
    },

    insertMessageWithAttachments(message, attachmentIds = [], claimId = "") {
      const ids = [...new Set(attachmentIds.map(String).filter(Boolean))];
      db.exec("BEGIN IMMEDIATE");
      try {
        const messageId = this.insertMessage(message);
        for (const attachmentId of ids) {
          const sql = claimId
            ? `UPDATE message_attachments SET message_id=?,send_claim_id='',send_claim_expires_at=0,updated_at=?
               WHERE id=? AND customer_id=? AND direction='out' AND source='operator_upload'
                 AND status='ready' AND (message_id IS NULL OR message_id='') AND send_claim_id=?`
            : `UPDATE message_attachments SET message_id=?,send_claim_id='',send_claim_expires_at=0,updated_at=?
               WHERE id=? AND customer_id=? AND direction='out' AND source='operator_upload'
                 AND status='ready' AND (message_id IS NULL OR message_id='') AND send_claim_id=''`;
          const params = [String(messageId), now(), attachmentId, String(message.customerId)];
          if (claimId) params.push(String(claimId));
          const changed = run(sql, ...params).changes;
          if (changed !== 1) throw new Error("attachment link failed");
        }
        db.exec("COMMIT");
        return messageId;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },

    queueCustomerMediaDeletion(customerId, reason = "customer_reset") {
      const id = String(customerId);
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = all("SELECT id,storage_key FROM message_attachments WHERE customer_id = ?", id);
        for (const row of rows) {
          if (row.storage_key) run(
            `INSERT OR IGNORE INTO message_media_deletion_queue (storage_key,customer_id,reason,created_at,updated_at)
             VALUES (?,?,?,?,?)`,
            row.storage_key, id, String(reason).slice(0, 120), now(), now(),
          );
          run("DELETE FROM attachment_download_tokens WHERE attachment_id = ?", row.id);
        }
        run("UPDATE message_attachments SET status='unavailable',storage_key='',send_claim_id='',send_claim_expires_at=0,unavailable_reason=?,updated_at=? WHERE customer_id=?", "รอลบไฟล์ส่วนตัว", now(), id);
        db.exec("COMMIT");
        return rows.filter((row) => row.storage_key).map((row) => row.storage_key);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },
    queueUnreferencedMessageMediaDeletions(storageKeys = [], reason = "orphan_reconcile") {
      const keys = [...new Set(storageKeys.map(String).filter(Boolean))];
      if (!keys.length) return 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        let queued = 0;
        for (const storageKey of keys) {
          const referenced = get("SELECT 1 AS yes FROM message_attachments WHERE storage_key = ? LIMIT 1", storageKey);
          if (referenced) continue;
          queued += run(
            `INSERT OR IGNORE INTO message_media_deletion_queue (storage_key,customer_id,reason,created_at,updated_at)
             VALUES (?,'',?,?,?)`,
            storageKey, String(reason).slice(0, 120), now(), now(),
          ).changes || 0;
        }
        db.exec("COMMIT");
        return queued;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },
    queueProviderMessageMediaDeletion(providerMessageId, reason = "line_unsend") {
      const providerId = String(providerMessageId);
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = all("SELECT id,customer_id,storage_key FROM message_attachments WHERE provider_message_id = ?", providerId);
        // Withdrawal removes derived classification evidence too. Keeping a
        // diagnosis after the source image was withdrawn would defeat erasure.
        run("DELETE FROM inbound_image_classifications WHERE message_id IN (SELECT message_id FROM message_attachments WHERE provider_message_id = ?)", providerId);
        for (const row of rows) {
          if (row.storage_key) run(
            `INSERT OR IGNORE INTO message_media_deletion_queue (storage_key,customer_id,reason,created_at,updated_at)
             VALUES (?,?,?,?,?)`,
            row.storage_key, row.customer_id, String(reason).slice(0, 120), now(), now(),
          );
          run("DELETE FROM attachment_download_tokens WHERE attachment_id = ?", row.id);
          run("UPDATE message_attachments SET status='unavailable', storage_key='', unavailable_reason=?, updated_at=? WHERE id=?", "ผู้ส่งถอนข้อความจาก LINE แล้ว", now(), row.id);
        }
        db.exec("COMMIT");
        return rows.filter((row) => row.storage_key).map((row) => row.storage_key);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },
    listMessageMediaDeletionQueue(limit = 100, customerId = null) {
      const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
      return customerId == null
        ? all("SELECT * FROM message_media_deletion_queue ORDER BY created_at ASC LIMIT ?", bounded)
        : all("SELECT * FROM message_media_deletion_queue WHERE customer_id=? ORDER BY created_at ASC LIMIT ?", String(customerId), bounded);
    },
    completeMessageMediaDeletion(storageKey) {
      return run("DELETE FROM message_media_deletion_queue WHERE storage_key = ?", String(storageKey)).changes === 1;
    },
    failMessageMediaDeletion(storageKey, error = "") {
      run("UPDATE message_media_deletion_queue SET attempts=attempts+1,last_error=?,updated_at=? WHERE storage_key=?", String(error).slice(0, 160), now(), String(storageKey));
    },

    // G4: operator เปิดห้องนี้แล้ว — จุด unread ดับ (ห้ามแตะ updated_at เดี๋ยว inbox สลับลำดับ)
    // audit 2026-08-26: ตัวจับคู่ชื่อจากระบบเก่าปิด AI ให้ห้องเองโดยอัตโนมัติ
    // (legacy_candidate = เจอห้องเก่าชื่อตรงกันหนึ่งห้อง, legacy_ambiguous = ตรงหลายห้อง)
    // การเปิด AI กลับมาทั้งระบบ "ไม่" ล้างธงรายห้องพวกนี้ ห้องเหล่านั้นจึงเงียบต่อไป
    // โดยไม่มี error และไม่มีใครรู้ว่ามีกี่ห้อง — ต้องนับให้เห็นก่อนวันเปิดลูกแพร
    // audit 2026-08-26 (วิกฤต): ไม่มีอะไรบนเครื่องนี้รู้ได้เลยว่าข้อความลูกค้าหยุดเข้ามา
    // canary ถูกตรึงปิด, digest ปิด, web push ปิด และตอน AI หยุด ตัวแจ้งเตือนก็ไม่ทำงาน
    // ถ้า webhook ตายตอนตีสองวันเสาร์ กว่าจะรู้คือวันจันทร์ และ LINE ไม่ส่งซ้ำให้
    // ข้อความช่วงนั้นไม่เคยเข้าฐานข้อมูลเลย — หายถาวรโดยไม่มีร่องรอย
    // ตัวเลขนี้ทำให้ "เงียบผิดปกติ" ต่างจาก "วันนี้ลูกค้าน้อย" ได้
    lastInboundAtAny() {
      return Number(get("SELECT MAX(created_at) AS t FROM messages WHERE direction='in'")?.t || 0);
    },

    countRoomsAwaitingLegacyConfirm() {
      return Number(get(
        "SELECT count(*) AS n FROM customers WHERE ai_enabled=0 AND ai_off_reason IN ('legacy_candidate','legacy_ambiguous')",
      )?.n || 0);
    },

    // v1.4.49 (คำสั่งเจ้าของ 2026-08-29): แบนเนอร์ต้องกดเข้าห้องได้ ไม่ใช่โชว์ตัวเลขเฉย ๆ
    listRoomsAwaitingLegacyConfirm(limit = 20) {
      return all(
        `SELECT line_user_id AS id, COALESCE(NULLIF(known_name,''), NULLIF(display_name,''), line_user_id) AS name
           FROM customers WHERE ai_enabled=0 AND ai_off_reason IN ('legacy_candidate','legacy_ambiguous')
           ORDER BY updated_at DESC LIMIT ?`,
        Math.max(1, Math.min(50, Number(limit) || 20)),
      );
    },

    markConversationSeen(customerId) {
      run(
        "UPDATE customers SET last_seen_by_operator_at = ? WHERE line_user_id = ?",
        now(), String(customerId)
      );
    },

    markConversationUnread(customerId) {
      return run(
        "UPDATE customers SET last_seen_by_operator_at = 0 WHERE line_user_id = ?",
        String(customerId),
      ).changes === 1;
    },

    setHumanOwner(customerId, owner = "") {
      return run(
        "UPDATE customers SET human_owner = ?, updated_at = ? WHERE line_user_id = ?",
        String(owner).slice(0, 80), now(), String(customerId),
      ).changes === 1 ? this.getCustomer(customerId) : null;
    },

    // resolved_at = เวลากดปิดเคสล่าสุด (กดซ้ำในห้องที่ลูกค้าทักกลับมา = ปิดรอบใหม่) · เปิดเคส = ล้างเป็น 0
    setConversationResolved(customerId, resolved = true) {
      const t = now();
      return run(
        "UPDATE customers SET state = ?, resolved_at = ?, updated_at = ? WHERE line_user_id = ?",
        resolved ? "RESOLVED" : "AI_ACTIVE", resolved ? t : 0, t, String(customerId),
      ).changes === 1 ? this.getCustomer(customerId) : null;
    },

    countMessagesFor(customerId) {
      return Number(get("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ?", String(customerId))?.n || 0);
    },

    // B1: key รูปที่ "ส่งออกแล้ว" ให้ลูกค้าคนนี้ตั้งแต่ sinceMs — ใช้กันส่งรูปซ้ำ
    // v1.4.1: จำกัดใน session ได้ — รูปที่ส่งใน session เทรนเก่า (/reset ไปแล้ว)
    // เคยบล็อกรูปของ session ใหม่ทั้ง 7 วัน จนบทสนทนาใหม่ไม่มีรูปเลย
    recentImageKeys(customerId, sinceMs, sessionId = null) {
      const rows = sessionId
        ? all(
          `SELECT content FROM messages
           WHERE customer_id = ? AND direction = 'out' AND msg_type = 'image'
             AND created_at >= ? AND session_id = ? AND content LIKE '[image:%'`,
          String(customerId), Number(sinceMs) || 0, String(sessionId)
        )
        : all(
          `SELECT content FROM messages
           WHERE customer_id = ? AND direction = 'out' AND msg_type = 'image'
             AND created_at >= ? AND content LIKE '[image:%'`,
          String(customerId), Number(sinceMs) || 0
        );
      const keys = new Set();
      for (const row of rows) {
        const match = /^\[image:([^\]]+)\]/.exec(row.content);
        if (match) keys.add(match[1]);
      }
      return [...keys];
    },

    // เวลาที่ลูกค้าทักเข้ามาล่าสุด — ใช้เช็ค "ลูกค้าตอบแล้วหลังตั้งนัด follow-up"
    lastInboundAt(customerId) {
      return get(
        `SELECT created_at FROM messages
         WHERE customer_id = ? AND direction = 'in'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        String(customerId)
      )?.created_at ?? null;
    },

    // v1.5: Facebook ส่งข้อความเชิงรุกได้เฉพาะภายในหน้าต่าง 24 ชม.
    // ไม่มี inbound เลย = ปิดเสมอ (ห้ามทักคนที่ไม่เคยคุยกับเรา)
    withinFacebookWindow(customerId, nowMs = Date.now()) {
      const last = this.lastInboundAt(customerId);
      return Boolean(last) && nowMs >= last && nowMs - last < FB_MESSAGING_WINDOW_MS;
    },

    // v1.4.6: เวลาข้อความขาออกล่าสุด — staged follow-up ใช้วัด "ความเงียบตั้งแต่การ
    // แลกเปลี่ยนล่าสุด" (นับทั้งสองทิศ ข้อความ push ของเราเองก็รีเซ็ตตัวจับเวลาขั้นถัดไป)
    // audit 2026-08-24: ใช้รู้ว่า "บอทเพิ่งถามอะไรไป" เพื่อแยกคำตอบของลูกค้าออกจากคำขอ
    // อ่านแถวเดียวผ่าน idx_messages_customer — ถูกกว่าโหลด history ทั้งชุด
    lastOutboundText(customerId) {
      return get(
        `SELECT content FROM messages
         WHERE customer_id = ? AND direction = 'out'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        String(customerId)
      )?.content ?? "";
    },

    // The document-answer exemption must inspect the latest outbound row and
    // prove it came from AI. Filtering to AI rows in SQL would skip a newer
    // human reply and incorrectly reuse an older AI question.
    lastOutboundMessage(customerId) {
      return get(
        `SELECT content, operator, agent_mode
         FROM messages
         WHERE customer_id = ? AND direction = 'out'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        String(customerId)
      ) ?? null;
    },

    lastOutboundAt(customerId) {
      return get(
        `SELECT created_at FROM messages
         WHERE customer_id = ? AND direction = 'out'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        String(customerId)
      )?.created_at ?? null;
    },

    // เฉพาะข้อความที่ "คน" กดส่งจากคอนโซล — ไม่นับของลูกแพร/ระบบ (operator ว่างหรือ
    // 'system') ใช้กับป้าย "สรุปจาก LINE OA" เป็นหลักฐานว่าคนมาจัดการในคอนโซลจริง
    // เกณฑ์เดียวกับที่ dbWebPush ใช้ตัดสินว่า "มีคนตอบแล้วหรือยัง"
    lastOperatorOutboundAt(customerId) {
      return get(
        `SELECT created_at FROM messages
         WHERE customer_id = ? AND direction = 'out'
           AND operator <> '' AND operator <> 'system'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        String(customerId)
      )?.created_at ?? null;
    },

    // v1.4.6: URL รีวิว (facebook share) ที่เคยส่งให้ลูกค้าคนนี้แล้ว — ตลอดชีพ ไม่จำกัด
    // session เพราะรีวิวซ้ำคือความรำคาญข้ามบทสนทนา (ต่างจากรูปที่ dedupe ต่อ session)
    // 24 ก.ย. 2026: รวมหน้ารีวิวบน pngoungacademy.com — reviewUrlKey ผูกกับรีลเดิมให้เอง
    // 19 ต.ค. 2026: รวมหน้าตัวอย่างระบบ /showcase/apps/<id> (ส่งครั้งเดียวตลอดชีพ + นับเพดานแนบเองต่อห้อง)
    sentReviewUrls(customerId) {
      // White-label: โดเมนหน้ารีวิวมาจาก BRAND_REVIEW_DOMAINS (ค่าเริ่มต้น = SQL/regex เดิมทุกตัวอักษร)
      const domains = activeBrand().reviewDomains || [];
      const likeSite = domains.map(() => " OR content LIKE ? OR content LIKE ?").join("");
      const rows = all(
        `SELECT direction, content FROM messages
         WHERE customer_id = ? AND ((direction = 'out'
           AND (content LIKE '%facebook.com/%' ${likeSite}))
           OR (direction = 'in' AND (content LIKE '%WF%' OR content LIKE '%RV%')))`,
        String(customerId),
        ...domains.flatMap((domain) => [`%${domain}/reviews/%`, `%${domain}/showcase/%`])
      );
      const siteAlt = domains.map((domain) => `|(?:www\\.)?${escapeRegExp(domain)}`).join("");
      const urlRe = new RegExp(`https:\\/\\/(?:(?:www\\.|web\\.)?facebook\\.com${siteAlt})\\/[^\\s฀-๿]+`, "gu");
      const urls = new Set();
      for (const row of rows) {
        // ข้อความที่ปุ่มทักไลน์บนหน้าเว็บพิมพ์ไว้ (เคส WF-… / รหัส RV-…) = ลูกค้าดูหน้านั้นมาแล้ว — ลิงก์ที่ลูกค้าพิมพ์เองไม่นับ
        if (row.direction === "in") {
          if (isGenericProfile(activeBrand())) continue;
          for (const url of arrivalUrlsIn([row.content])) { const key = reviewUrlKey(url); if (key) urls.add(key); }
          continue;
        }
        for (const match of String(row.content || "").matchAll(urlRe)) {
          const key = reviewUrlKey(match[0]);
          if (key) urls.add(key);
        }
      }
      return urls;
    },

    // Outline is likewise a lifetime asset: only inspect plausible outbound
    // candidates, then apply the shared strict detector. A row exists only
    // after the delivery path has accepted it, so failed drafts cannot mark it.
    sentCourseOutlines(customerId) {
      const rows = all(
        `SELECT content, metadata_json FROM messages
         WHERE customer_id = ? AND direction = 'out' AND msg_type = 'text'
           AND (content LIKE '%Outline%' OR content LIKE '%หัวข้อที่สอน%'
             OR metadata_json LIKE '%"courseOutlines"%')`,
        String(customerId),
      );
      const delivered = new Set();
      for (const row of rows) {
        // Legacy rows can only prove an outline inside one actual outbound row.
        // Never concatenate older bubbles/turns here: that would fabricate a delivery.
        for (const course of detectDeliveredCourseOutlines([{ role: "assistant", content: row.content }])) delivered.add(course);
        try {
          const receipt = JSON.parse(String(row.metadata_json || "{}"))?.courseOutlines;
          if (Array.isArray(receipt)) for (const course of receipt) {
            if (course === "agent_business" || course === "agent_workflow_automation") delivered.add(course);
          }
        } catch { /* malformed metadata is not delivery proof */ }
      }
      return delivered;
    },

    // v1.4.6: สถานะบันได follow-up ต่อลูกค้า (แถวไม่มี = ยังไม่เคยมี episode)
    getFollowupState(customerId) {
      return get("SELECT * FROM followup_state WHERE customer_id = ?", String(customerId)) ?? null;
    },

    saveFollowupState(customerId, state = {}) {
      run(
        `INSERT INTO followup_state (customer_id, ladder_stage, last_nudge_at, nudge_count,
           stage_key, episode_anchor, episodes_today, sent_today, today_key, cold_sent_total, history_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET
           ladder_stage = excluded.ladder_stage,
           last_nudge_at = excluded.last_nudge_at,
           nudge_count = excluded.nudge_count,
           stage_key = excluded.stage_key,
           episode_anchor = excluded.episode_anchor,
           episodes_today = excluded.episodes_today,
           sent_today = excluded.sent_today,
           today_key = excluded.today_key,
           cold_sent_total = excluded.cold_sent_total,
           history_json = excluded.history_json`,
        String(customerId),
        Number(state.ladder_stage ?? 0),
        state.last_nudge_at == null ? null : Number(state.last_nudge_at),
        Number(state.nudge_count ?? 0),
        String(state.stage_key ?? ""),
        state.episode_anchor == null ? null : Number(state.episode_anchor),
        Number(state.episodes_today ?? 0),
        Number(state.sent_today ?? 0),
        String(state.today_key ?? ""),
        Number(state.cold_sent_total ?? 0),
        String(state.history_json ?? "[]")
      );
    },

    // v1.4.6: ลูกค้าที่ staged follow-up ควรพิจารณา — AI ยังเป็นเจ้าของแชท (ai_enabled)
    // และมีการคุยจริงในช่วง activeWithinMs (บทสนทนาเก่าเกินไม่ปลุก)
    // จงใจไม่กรอง state='NEEDS_HUMAN': ธงนี้ติดค้างได้นาน (escalation ping ทุกชนิดตั้งมัน)
    // ขณะที่เส้น reactive ยังตอบต่อปกติ — ถ้ากรอง ระบบ follow-up จะตายทั้งระบบ
    // (เคสจริง 2026-08-16: warm 31 นาทีไม่ถูก nudge เพราะธงค้างจากเคสรีวิวเมื่อวาน)
    // จังหวะเงินที่ยังรอคนตรวจ กรองที่ชั้น engine แทน (paymentHoldActive)
    // คำสั่งพี่ง้วง 2026-09-05 (กลับข้อยกเว้น v1.4.11): เดิมห้อง bank_sent ถูกคัดมาด้วย
    // เพื่อให้ follow-up ทวงโอนต่อได้ — ตอนนี้ "ส่งให้ชมพู่ handle ต่อเอง ไม่ต้อง follow up"
    // AI ปิด = ห้องของคนจริง ไม่มีข้อความอัตโนมัติใดตามไปอีก ไม่ว่าเหตุปิดจะเป็นอะไร
    // ห้องนี้ติดป้ายที่สั่งให้บอทเงียบหรือยัง — ใช้เป็นด่านสุดท้ายก่อนยิงข้อความ
    // ตอนที่ SQL คัดห้องไปแล้วแต่ทีมงานเพิ่งมาติดป้ายระหว่างที่บอทกำลังร่างอยู่
    // สแปม = ป้าย null ทุกตัวพิมพ์ (spamTag.mjs) — ใช้กันการแจ้งเตือนทีมก่อนปลุกเครื่อง
    isSpamCustomer(customerId) {
      if (!customerId) return false;
      return Boolean(get(`SELECT 1 AS hit WHERE ${SPAM_EXISTS_SQL("?")}`, String(customerId)));
    },

    isBotSilencedByTag(customerId) {
      if (!customerId) return false;
      return Boolean(get(
        `SELECT 1 AS hit FROM customer_tags WHERE customer_id = ?
           AND lower(tag) IN (${SILENCED_TAG_LIST_SQL}) LIMIT 1`,
        String(customerId),
      ));
    },

    listStagedFollowupCandidates({ nowMs, activeWithinMs }) {
      return all(
        `SELECT c.*,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id) AS last_message_at,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id AND m.direction = 'in') AS last_inbound_at
         FROM customers c
         WHERE c.ai_enabled = 1
           AND c.do_not_disturb = 0 AND c.followup_enabled = 1
           AND ${BOUGHT_TAG_EXCLUDE_SQL("c.line_user_id")}
           AND ${FREE_CLASS_QUIET_SQL("c.line_user_id", String(Number(nowMs)))}
           AND (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id AND m.direction = 'in') IS NOT NULL
           AND (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id) >= ?`,
        Number(nowMs) - Number(activeWithinMs)
      );
    },

    // ไม่โชว์ลูกค้าสังเคราะห์ของ canary (id ขึ้นต้น 'canary:') ใน inbox ของคนจริง
    // G4 (volume-ready): segment HOT/WARM/COLD/needs/aioff + ค้นหา q + limit/offset
    // - รับเลขเดี่ยว (ของเดิม) = limit อย่างเดียว — caller เก่าไม่ต้องแก้
    // - hot/warm เรียง score มาก -> น้อย ก่อน recency (คนใกล้ปิดการขายอยู่บนสุด)
    // 28 ก.ย. 2026: segment "spam" = ห้องติดป้าย null (spamTag.mjs) — ทุก segment อื่นตัดห้องสแปมทิ้ง
    // ids = ดึงเฉพาะห้องที่ระบุ (คิว "รอตอบ" เรียงลำดับเองใน waitingRooms.mjs แล้วค่อยมาดึงแถวเต็ม)
    listConversations(opts = {}) {
      const { limit = 100, offset = 0, q = "", segment = null, channel = null, owner = "", deep = false, ids = null } =
        typeof opts === "number" ? { limit: opts } : (opts || {});
      const SEGMENT_WHERE = {
        hot: "c.last_score >= 8",
        warm: "c.last_score BETWEEN 5 AND 7",
        cold: "(c.last_score IS NULL OR c.last_score <= 4)",
        needs: `(c.state = 'NEEDS_HUMAN' OR ${unkeptPromiseSql("c.line_user_id")})`,
        aioff: "c.ai_enabled != 1",
        // 5 ต.ค. 2026 (พี่ง้วง): ชิป "ไม่เข้าเกณฑ์" = ห้องสีเหลืองที่ตัวกวาดคัดกรองปิดเอง (notQualified.mjs) — ยังนับรวมใน aioff ด้วย
        notqualify: "c.ai_enabled != 1 AND TRIM(c.ai_off_reason) = 'not_qualified'",
        resolved: "c.state = 'RESOLVED'",
        // v1.4.33: ผูกกับป้ายจริงในตาราง ไม่ใช่สถานะที่เดาเอา — ป้ายคือสิ่งที่ทีมงานกดเอง
        customer: "EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id = c.line_user_id AND ct.tag = 'customer')",
        spam: SPAM_EXISTS_SQL("c.line_user_id"),
      };
      const where = [
        "c.line_user_id NOT LIKE 'canary:%'",
        // Once a real Messaging API room is explicitly linked, keep the legacy
        // reference out of the default inbox to avoid two apparent copies of
        // one customer. It remains reachable from the history strip.
        `NOT (
          EXISTS (SELECT 1 FROM customer_tags legacy_tag
                  WHERE legacy_tag.customer_id = c.line_user_id AND legacy_tag.tag = 'ย้ายจาก LINE OA')
          AND EXISTS (SELECT 1 FROM customers linked_customer
                      WHERE linked_customer.legacy_link = 'linked:' || c.line_user_id)
        )`,
      ];
      const baseParams = [];
      if (segment && SEGMENT_WHERE[segment]) where.push(SEGMENT_WHERE[segment]);
      // สแปม = คัดออกจากทุกคิวงานของทีม (ทั้งหมด/HOT/WARM/COLD/รอคน/AI ปิด/...) เหลือที่เดียวคือชิป "สแปม"
      if (segment !== "spam") where.push(NOT_SPAM_SQL("c.line_user_id"));
      if (Array.isArray(ids)) {
        const list = ids.map(String).filter(Boolean);
        if (!list.length) return [];
        where.push(`c.line_user_id IN (${list.map(() => "?").join(", ")})`);
        baseParams.push(...list);
      }
      if (segment === "mine") {
        where.push("c.human_owner = ?");
        baseParams.push(String(owner || ""));
      }
      // W3: กรองต่อสาขา — null = ทุกสาขา (พฤติกรรมเดิม)
      if (channel) {
        where.push("c.channel_id = ?");
        baseParams.push(String(channel));
      }
      // v1.4.12d: แถว followup_enabled..deal_status ต้องอยู่ครบ — previewStagedFollowup ใช้เป็น
      // เงื่อนไข gate ของ badge ⏱ FU; ขาดตัวใดตัวหนึ่ง = preview คืน null เงียบ ๆ ทั้ง inbox
      const projected = `
        SELECT c.rowid AS crid, c.line_user_id, c.display_name, c.known_name, c.picture_url,
               c.last_score, c.ai_enabled, c.state, c.human_owner, c.operator_active_until,
               c.handoff_summary, c.channel_id, c.updated_at,
               c.legacy_last_activity_at,
               c.followup_enabled, c.followup_suppression_reason, c.service_boundary_json, c.do_not_disturb, c.marketing_consent,
               c.ai_off_reason, c.deal_status, c.money_seen_at, c.resolved_at,
               -- "AI ปิด · โดยระบบ" ของป้าย customer ที่ระบบติดเองจากชื่อซ้ำ (aiOffActor.mjs) — คิดเฉพาะห้องที่เข้าข่าย
               CASE WHEN c.ai_enabled != 1 AND c.ai_off_reason = 'customer_handover'
                    THEN ${SYSTEM_CUSTOMER_TAG_SQL("c.line_user_id")} ELSE 0 END AS ai_off_system_tag,
               ${unkeptPromiseSql("c.line_user_id")} AS has_unkept_promise,
               EXISTS(SELECT 1 FROM customer_tags legacy_tag
                      WHERE legacy_tag.customer_id = c.line_user_id AND legacy_tag.tag = 'ย้ายจาก LINE OA') AS is_legacy,
               (SELECT content FROM messages m WHERE m.customer_id = c.line_user_id
                ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message,
               (SELECT created_at FROM messages m WHERE m.customer_id = c.line_user_id
                ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_message_at,
               (SELECT status FROM slip_checks sc WHERE sc.customer_id = c.line_user_id
                ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT 1) AS last_slip_status,
               EXISTS(SELECT 1 FROM messages m WHERE m.customer_id = c.line_user_id
                      AND m.direction = 'in' AND m.created_at > c.last_seen_by_operator_at) AS unread,
               (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id
                AND m.direction = 'in') AS last_inbound_at,
               (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id
                AND m.direction = 'out') AS last_outbound_at,
               -- ป้าย "สรุปจาก LINE OA" (src/lineOaContext.mjs) — สามคอลัมน์นี้ตอบว่า
               -- ห้องนี้เป็นงานของคนตั้งแต่เมื่อไร และเรื่องถูกพากลับเข้าคอนโซลครั้งล่าสุดเมื่อไร
               -- customer_tag_at ทำหน้าที่แทน EXISTS ด้วย: ไม่ null = ติดป้ายแล้ว
               (SELECT ct.created_at FROM customer_tags ct
                WHERE ct.customer_id = c.line_user_id AND ct.tag = 'customer') AS customer_tag_at,
               -- ติดป้ายที่สั่งให้บอทเงียบเมื่อไร (customer หรือ null) — หน้าเว็บใช้ตัวนี้
               -- ตัดสินว่าจะโชว์ 🚫 แทนไอคอน cold/warm/hot
               (SELECT MIN(st.created_at) FROM customer_tags st
                WHERE st.customer_id = c.line_user_id
                  AND lower(st.tag) IN (${SILENCED_TAG_LIST_SQL})) AS silenced_tag_at,
               (SELECT MAX(n.created_at) FROM handoff_notes n
                WHERE n.customer_id = c.line_user_id
                AND n.author NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})) AS last_human_note_at,
               (SELECT MAX(m.created_at) FROM messages m WHERE m.customer_id = c.line_user_id
                AND m.direction = 'out' AND m.operator <> '' AND m.operator <> 'system')
                AS last_operator_outbound_at,
               fs.customer_id AS fs_customer_id, fs.ladder_stage AS fs_ladder_stage,
               fs.stage_key AS fs_stage_key, fs.episode_anchor AS fs_episode_anchor,
               fs.episodes_today AS fs_episodes_today, fs.sent_today AS fs_sent_today,
               fs.today_key AS fs_today_key, fs.cold_sent_total AS fs_cold_sent_total,
               fs.defer_json AS fs_defer_json,
               -- 2026-09-28: Facebook เว้นระยะไม้ถัดไปนับจากไม้ก่อนที่ส่งจริง — badge ต้องได้ค่าเดียวกับเส้นยิงจริง
               fs.last_nudge_at AS fs_last_nudge_at,
               -- ชนิดของไม้ล่าสุด (YOLO = นับระยะจากข้อความนั้นเสมอ) — ดึงแค่ตัวเดียว ไม่ลากประวัติทั้งก้อนมาทุกแถว
               CASE WHEN json_valid(fs.history_json) THEN json_extract(fs.history_json, '$[#-1].kind') END AS fs_last_send_kind
        FROM customers c
        LEFT JOIN followup_state fs ON fs.customer_id = c.line_user_id
        WHERE ${where.join(" AND ")}`;
      // สำมะโน lastTalkedAt อาจใหม่กว่าชุด messages ที่ดึงมา (เช่น pagination จบก่อน)
      // จึงใช้เวลาที่ใหม่ที่สุดจากหลักฐานทั้งสอง; updated_at เป็น fallback เฉพาะห้องที่ไม่มีทั้งคู่
      const base = `SELECT projected.*,
        COALESCE(
          MAX(projected.last_message_at, projected.legacy_last_activity_at),
          projected.last_message_at,
          projected.legacy_last_activity_at,
          projected.updated_at
        ) AS activity_at
        FROM (${projected}) projected`;
      // "ยังไม่ได้ตอบ" = ลูกค้าเคยทัก และข้อความขาออกล่าสุดเก่ากว่าขาเข้าล่าสุด (หรือไม่เคยมีเลย)
      const UNANSWERED_SQL = "last_inbound_at IS NOT NULL AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at)";
      // crid = tiebreaker กันแถวที่ updated_at ชนกัน (insert รัว ๆ ใน ms เดียว) สลับลำดับมั่ว
      // 2026-08-28: คิว "รอคน" เคยเรียงเอาห้องที่ขยับล่าสุดขึ้นบน ห้องที่ลูกค้าทักทิ้งไว้
      // แล้วไม่มีใครตอบจึงจมลงล่างสุดของคิวที่ควรเห็นมันก่อนใคร — วันที่เจอ มีห้องรออยู่
      // 81, 58 และ 31 ชม. โดยไม่มีใครเห็น ทั้งที่ข้อมูลอยู่บนจอมาตลอด
      // คิวที่รอคนต้องเป็น "ใครรอนานสุดขึ้นก่อน" ไม่ใช่ "ใครเพิ่งขยับขึ้นก่อน"
      const orderBy = segment === "hot" || segment === "warm"
        ? "ORDER BY last_score DESC, activity_at DESC, crid DESC"
        : segment === "needs"
          // ห้องที่ "ลูกค้าทักแล้วยังไม่มีใครตอบ" ต้องมาก่อนห้องที่ตอบไปแล้วแต่ยังไม่ปิดเคส
          // เสมอ ต่อให้ห้องหลังจะเงียบมานานกว่า — คนที่ยังรอคำตอบอยู่คือคนที่เสียหายจริง
          ? `ORDER BY (CASE WHEN ${UNANSWERED_SQL} THEN 0 ELSE 1 END) ASC,
                      (CASE WHEN ${UNANSWERED_SQL} THEN last_inbound_at ELSE activity_at END) ASC,
                      crid ASC`
          : "ORDER BY activity_at DESC, crid DESC";
      const term = String(q || "").trim();
      // ลำดับ params: ของ base (channel) มาก่อนเสมอ — placeholder อยู่ใน subquery
      const params = [...baseParams];
      let sql = base;
      if (term) {
        // escape wildcard ของ LIKE — คำค้นของ operator ต้องเป็น literal เสมอ
        const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        // Keep the full-history scan message-first. A correlated EXISTS would
        // repeat a customer-index lookup for every visible conversation on each
        // search pause; this form scans messages once and materializes matching
        // customer keys before applying channel/segment guards from `base`.
        const deepClause = deep
          ? ` OR searched.line_user_id IN (
                SELECT search_message.customer_id FROM messages search_message
                WHERE search_message.content LIKE ? ESCAPE '\\'
              )`
          : "";
        sql = `SELECT * FROM (${base}) searched
               WHERE (display_name LIKE ? ESCAPE '\\' OR known_name LIKE ? ESCAPE '\\'
                      OR IFNULL(last_message, '') LIKE ? ESCAPE '\\'${deepClause})`;
        params.push(like, like, like);
        if (deep) params.push(like);
      }
      return all(
        `${sql} ${orderBy} LIMIT ? OFFSET ?`,
        ...params, Math.min(200, Math.max(1, Number(limit) || 100)), Math.max(0, Number(offset) || 0)
      );
    },

    // G4: ตัวเลขบน chip กรอง inbox — นับจาก SQL ทั้งตาราง (list เป็นแค่หน้าเดียว นับจากมันไม่ได้)
    // W3: channel = null นับทุกสาขา (เดิม) / ระบุ = นับเฉพาะสาขานั้น
    // 28 ก.ย. 2026: ห้องสแปม (ป้าย null) ไม่นับในตัวเลขไหนเลย มีตัวเลขของตัวเองที่ spam
    inboxCounts(channel = null, owner = "") {
      const params = [String(owner || "")];
      let channelWhere = "";
      if (channel) {
        channelWhere = " AND channel_id = ?";
        params.push(String(channel));
      }
      const spamRow = get(
        `SELECT COUNT(*) AS spam_n FROM customers
         WHERE line_user_id NOT LIKE 'canary:%' AND ${SPAM_EXISTS_SQL("customers.line_user_id")}
           AND NOT (
             EXISTS (SELECT 1 FROM customer_tags legacy_tag
                     WHERE legacy_tag.customer_id = customers.line_user_id AND legacy_tag.tag = 'ย้ายจาก LINE OA')
             AND EXISTS (SELECT 1 FROM customers linked_customer
                         WHERE linked_customer.legacy_link = 'linked:' || customers.line_user_id)
           )${channelWhere}`,
        ...params.slice(1),
      ) || {};
      const row = get(
        `SELECT COUNT(*) AS all_n,
                SUM(CASE WHEN last_score >= 8 THEN 1 ELSE 0 END) AS hot_n,
                SUM(CASE WHEN last_score BETWEEN 5 AND 7 THEN 1 ELSE 0 END) AS warm_n,
                SUM(CASE WHEN last_score IS NULL OR last_score <= 4 THEN 1 ELSE 0 END) AS cold_n,
                SUM(CASE WHEN state = 'NEEDS_HUMAN' OR ${unkeptPromiseSql("customers.line_user_id")} THEN 1 ELSE 0 END) AS needs_n,
                SUM(CASE WHEN ai_enabled != 1 THEN 1 ELSE 0 END) AS aioff_n,
                SUM(CASE WHEN ai_enabled != 1 AND TRIM(ai_off_reason) = 'not_qualified' THEN 1 ELSE 0 END) AS notqualify_n,
                SUM(CASE WHEN state = 'RESOLVED' THEN 1 ELSE 0 END) AS resolved_n,
                SUM(CASE WHEN human_owner = ? THEN 1 ELSE 0 END) AS mine_n,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id = customers.line_user_id AND ct.tag = 'customer') THEN 1 ELSE 0 END) AS customer_n
         FROM customers WHERE line_user_id NOT LIKE 'canary:%'
           AND ${NOT_SPAM_SQL("customers.line_user_id")}
           AND NOT (
             EXISTS (SELECT 1 FROM customer_tags legacy_tag
                     WHERE legacy_tag.customer_id = customers.line_user_id AND legacy_tag.tag = 'ย้ายจาก LINE OA')
             AND EXISTS (SELECT 1 FROM customers linked_customer
                         WHERE linked_customer.legacy_link = 'linked:' || customers.line_user_id)
           )${channelWhere}`,
        ...params
      ) || {};
      const n = (v) => Number(v) || 0;
      return {
        all: n(row.all_n), hot: n(row.hot_n), warm: n(row.warm_n),
        cold: n(row.cold_n), needs: n(row.needs_n), aioff: n(row.aioff_n), notqualify: n(row.notqualify_n),
        resolved: n(row.resolved_n), mine: n(row.mine_n),
        customer: n(row.customer_n), spam: n(spamRow.spam_n),
      };
    },

    // Export CSV: อ่านทีละ batch ด้วย keyset pagination (created_at, rowid) —
    // ไม่ใช้ OFFSET (ชุดใหญ่ช้า) และไม่ดึงทั้งตารางมาต่อ string ก้อนเดียว
    // join customers เพื่อได้ชื่อที่คนอ่านรู้เรื่อง — ลูกค้า canary ไม่ปนใน export
    // W3: channel = null คือทุกสาขา / ระบุ = เฉพาะสาขานั้น — แถวมี channel_id ให้คอลัมน์ "สาขา"
    exportMessagesBatch({ customerId = null, channel = null, sinceMs = 0, untilMs = null, afterCreatedAt = -1, afterRowid = -1, limit = 500 } = {}) {
      const where = ["m.customer_id NOT LIKE 'canary:%'"];
      const params = [];
      if (customerId) {
        where.push("m.customer_id = ?");
        params.push(String(customerId));
      }
      if (channel) {
        where.push("m.channel_id = ?");
        params.push(String(channel));
      }
      if (Number(sinceMs) > 0) {
        where.push("m.created_at >= ?");
        params.push(Number(sinceMs));
      }
      if (untilMs != null) {
        where.push("m.created_at < ?");
        params.push(Number(untilMs));
      }
      where.push("(m.created_at > ? OR (m.created_at = ? AND m.rowid > ?))");
      params.push(Number(afterCreatedAt), Number(afterCreatedAt), Number(afterRowid));
      return all(
        `SELECT m.rowid AS rid, m.customer_id, m.direction, m.msg_type, m.content,
                m.operator, m.agent_mode, m.channel_id, m.created_at,
                c.display_name, c.known_name
         FROM messages m
         LEFT JOIN customers c ON c.line_user_id = m.customer_id
         WHERE ${where.join(" AND ")}
         ORDER BY m.created_at ASC, m.rowid ASC
         LIMIT ?`,
        ...params, Math.min(2000, Math.max(1, Number(limit) || 500))
      );
    },

    /* -------------------------------- dedupe ------------------------------- */

    // true = ข้อความใหม่ / false = เคยเห็นแล้ว (LINE redelivery)
    markDedupe(messageId) {
      const result = run(
        "INSERT OR IGNORE INTO events_dedupe (message_id, seen_at) VALUES (?, ?)",
        String(messageId), now()
      );
      return result.changes === 1;
    },

    // Queue-race fallback for a training control that becomes paused after
    // admission. Dedupe and inbound persistence are one durability boundary:
    // if any later write fails, LINE redelivery must still be able to retry.
    persistPausedInbound({ dedupeKey, customerId, channelId = "default", msgType = "text", content = "" }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const fresh = run(
          "INSERT OR IGNORE INTO events_dedupe (message_id, seen_at) VALUES (?, ?)",
          String(dedupeKey), now(),
        ).changes === 1;
        if (!fresh) {
          db.exec("COMMIT");
          return { stored: false, reason: "duplicate" };
        }
        this.upsertCustomer(customerId, { channelId });
        this.insertMessage({
          id: `in:${dedupeKey}`,
          customerId,
          direction: "in",
          msgType,
          channelId,
          content,
        });
        db.exec("COMMIT");
        return { stored: true, reason: "new" };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },

    /* ----------------------------- corrections ----------------------------- */

    addCorrection({
      customerId, aiDraft = "", humanFinal = "", reason = "", sourceReason = "", inboundMessageId = "",
    }) {
      const customer = String(customerId);
      const source = normalizeCorrectionSourceReason(sourceReason);
      const inboundId = String(inboundMessageId || "");
      if (inboundId) {
        const inbound = get("SELECT 1 AS yes FROM messages WHERE id=? AND customer_id=? AND direction='in'", inboundId, customer);
        if (!inbound) throw new Error("correction inbound message must be an inbound message for this customer");
      }
      const id = randomUUID();
      run(
        `INSERT INTO corrections
          (id,customer_id,ai_draft,human_final,reason,source_reason,inbound_message_id,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        id, customer, String(aiDraft), String(humanFinal),
        String(reason).slice(0, 500), source, inboundId, now()
      );
      return id;
    },

    latestInboundMessageId(customerId) {
      const active = this.activeConversationSession(customerId);
      const row = active
        ? get("SELECT id FROM messages WHERE customer_id=? AND direction='in' AND session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", String(customerId), active.id)
        : get("SELECT id FROM messages WHERE customer_id=? AND direction='in' AND session_id IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1", String(customerId));
      return row?.id ?? null;
    },

    // Teaching UI must never use this to follow an arbitrary message id.
    // Historical session evidence remains readable after a reset by design.
    getCorrectionInboundMessage({ customerId, correctionId } = {}) {
      return get(
        `SELECT m.id,m.customer_id,m.direction,m.msg_type,m.content,m.created_at
           FROM corrections c JOIN messages m ON m.id=c.inbound_message_id
          WHERE c.id=? AND c.customer_id=? AND m.customer_id=? AND m.direction='in'`,
        String(correctionId || ''), String(customerId || ''), String(customerId || ''),
      ) ?? null;
    },

    listCorrections(status = "candidate", limit = 100) {
      return all(
        "SELECT * FROM corrections WHERE status = ? ORDER BY created_at DESC LIMIT ?",
        status, limit
      );
    },

    // Apply the working-queue filter before the display limit. Old no-op rows
    // must not permanently hide a real correction behind the first raw page.
    listCorrectionWorkQueue(limit = 100) {
      const size = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 100)));
      const corrections = [];
      let hiddenNoopCount = 0;
      for (let offset = 0; corrections.length < size; offset += 200) {
        const page = all("SELECT * FROM corrections WHERE status='candidate' ORDER BY created_at DESC, rowid DESC LIMIT 200 OFFSET ?", offset);
        for (const row of page) {
          if (String(row.human_final || "").trim() && !isTeachableCorrection(row.ai_draft, row.human_final)) hiddenNoopCount += 1;
          else corrections.push(row);
        }
        if (page.length < 200) break;
      }
      return { corrections: corrections.slice(0, size), hiddenNoopCount };
    },

    getCorrection(id) {
      return get("SELECT * FROM corrections WHERE id = ?", String(id)) ?? null;
    },

    // operator แก้ร่าง AI ที่ถูกบล็อกแล้วส่งเอง -> เติมคำแก้เข้าแถว candidate เดิม
    setCorrectionFinal(id, humanFinal) {
      const result = run(
        "UPDATE corrections SET human_final = ? WHERE id = ? AND status = 'candidate' AND taught_version_id = ''",
        String(humanFinal), String(id)
      );
      return result.changes === 1;
    },

    // ร่าง AI ล่าสุดที่ถูกบล็อก (ยังไม่มีคำแก้ของคน) — โชว์ให้ operator แก้แล้วส่ง
    latestPendingDraft(customerId) {
      return get(
        `SELECT id, ai_draft, created_at FROM corrections
         WHERE customer_id = ? AND status = 'candidate' AND human_final = '' AND ai_draft != ''
         ORDER BY created_at DESC LIMIT 1`,
        String(customerId)
      ) ?? null;
    },

    // เฟส 3: ผูก/ปลด "คำแก้ใบนี้ถูกสอนด้วยรุ่นไหน"
    // ปลด (versionId = "") ต้องมี เพราะรุ่นที่ถูกปัดตกแปลว่ายังไม่มีใครสอนของชิ้นนี้จริง
    // และแถวต้องกลับมาในกล่องตรวจเอง โดยไม่มีใครต้องไปแก้สถานะคืนด้วยมือ
    setCorrectionTaughtVersion(id, versionId = "") {
      return run(
        "UPDATE corrections SET taught_version_id = ? WHERE id = ?",
        String(versionId || ""), String(id),
      ).changes === 1;
    },

    // คำแก้ทุกใบที่ผูกกับรุ่นนี้ (ใช้ตอนรุ่นถูกปัดตก/หมดอายุ)
    correctionsTaughtByVersion(versionId) {
      return all("SELECT id FROM corrections WHERE taught_version_id = ?", String(versionId));
    },

    // ตัดสิน correction (Correction Queue): approve/reject ได้เฉพาะแถว candidate
    // humanFinal (ถ้าส่งมา) ถูกบันทึกก่อนเปลี่ยนสถานะ — คืนแถวล่าสุด หรือ null ถ้าไม่เข้าเงื่อนไข
    // reason (ถ้าส่งมา) = เหตุผลที่ปัดตก ("ไม่ต้องสอน เพราะ...") เขียนลงคอลัมน์ reason ที่มีอยู่แล้ว
    // ไม่ส่งมา = ไม่แตะคอลัมน์นั้นเลย เส้นตัดสินเดิมจึงเหมือนเดิมทุกไบต์
    updateCorrection(id, { status, humanFinal, reason, decidedBy = "" } = {}) {
      if (status !== "approved" && status !== "rejected") return null;
      if (typeof humanFinal === "string") {
        run(
          "UPDATE corrections SET human_final = ? WHERE id = ? AND status = 'candidate'",
          humanFinal, String(id)
        );
      }
      if (typeof reason === "string" && reason.trim()) {
        run(
          "UPDATE corrections SET reason = ? WHERE id = ? AND status = 'candidate'",
          reason.trim().slice(0, 500), String(id)
        );
      }
      const result = run(
        `UPDATE corrections SET status = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'candidate'`,
        status, now(), String(decidedBy), String(id)
      );
      return result.changes === 1 ? this.getCorrection(id) : null;
    },

    /* ---------------------------- score history (F3) ------------------------ */

    // บันทึกผล scorer หนึ่งรอบ + อัปเดต last_score/last_score_at บนแถวลูกค้า
    // บันทึกโน้ตกิจกรรมจาก hashtag — เขียนครั้งแรกครั้งเดียว ไม่ทับของเดิม
    // (ลูกค้าอาจพิมพ์ # ซ้ำ หรือทักจากหลายงาน งานแรกที่พาเขามาคือบริบทที่ตรงที่สุด)
    // v1.4.49: ตรวจว่าข้อความมีลิงก์คลาสฟรีที่เจ้าของตั้งไว้ไหม แล้วติดป้าย
    // ส่งซ้ำ = รีเซ็ตเวลา (ให้ของขวัญรอบใหม่ หน้าต่าง 7 วันนับใหม่ตามเจตนา)
    // patterns (P2): ลิงก์ของ "สมองรุ่นที่เทิร์นนี้ใช้" — ส่งมา = ไม่อ่าน settings เลย
    // ไม่ส่ง = อ่าน settings เหมือนเดิมทุกไบต์ (ทางเดิมและทางแอดมินคนจริงยังใช้ตัวนี้)
    autoTagFreeClass(customerId, text, { byHuman = false, patterns: fromBrain = null } = {}) {
      let patterns = [];
      if (Array.isArray(fromBrain)) patterns = fromBrain;
      else try { patterns = JSON.parse(this.getSetting(FREECLASS_PATTERNS_KEY) || "[]"); } catch { return false; }
      if (!Array.isArray(patterns) || !patterns.length) return false;
      const value = canonicalLink(text);
      if (!value) return false;
      const hit = patterns.some((p) => {
        if (typeof p !== "string" || !p.trim()) return false;
        const needle = canonicalLink(p);
        return Boolean(needle) && value.includes(needle);
      });
      if (!hit) return false;
      // v1.4.50: ป้ายที่แอดมินติดเองมาก่อน ห้ามถูกลดชั้นเป็นของ AI — ป้ายของคนเป็นของคนเสมอ
      // (ถ้าปล่อยให้ทับ ป้ายนั้นจะกลายเป็น source=ai แล้วโดนรอบรีเฟรช intent ล้างทิ้งได้)
      run(
        `INSERT INTO customer_tags (customer_id, tag, source, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(customer_id, tag) DO UPDATE SET
             created_at = excluded.created_at,
             source = CASE WHEN customer_tags.source = 'human' THEN 'human' ELSE excluded.source END`,
        String(customerId), FREE_CLASS_TAG, byHuman ? "human" : "ai", now(),
      );
      this.addAudit({
        operator: "system", action: "freeclass_tag_auto", target: String(customerId),
        detail: `ส่งลิงก์คลาสฟรี (${byHuman ? "แอดมิน" : activeBrand().agentName}) — FU เว้น 7 วันนับจากนี้`,
      });
      return true;
    },

    setHashtagNote(customerId, note) {
      const text = String(note ?? "").trim().slice(0, 600);
      if (!customerId || !text) return false;
      const changed = run(
        "UPDATE customers SET hashtag_note = ?, updated_at = ? WHERE line_user_id = ? AND hashtag_note = ''",
        text, now(), String(customerId),
      );
      return Boolean(changed?.changes);
    },

    recordScore(customerId, score, payloadJson = "") {
      const id = randomUUID();
      const t = now();
      // ผลอ่านลักษณะลูกค้าต้องนิ่ง — รวมกับรอบก่อนก่อนบันทึก ไม่ใช่เขียนทับด้วยผลดิบ
      // (จุดเดียวที่ทำ ผู้ใช้ปลายทางทุกตัวจึงได้ค่าที่นิ่งโดยไม่ต้องแก้อะไร)
      const storedPayload = stabilizedScorePayload(get, customerId, payloadJson);
      run(
        "INSERT INTO score_history (id, customer_id, score, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
        id, String(customerId), Number(score), storedPayload, t
      );
      run(
        "UPDATE customers SET last_score = ?, last_score_at = ?, updated_at = ? WHERE line_user_id = ?",
        Number(score), t, t, String(customerId)
      );
      // ได้ score = คุยกันจริงแล้ว → เปิด FU cold/warm/hot ให้ห้องนี้
      // (คำสั่งพี่ง้วง 2026-08-26: "ถ้าคุยไปแล้ว มี score cold warm hot, FU ต้องทำงานปกติ")
      //
      // ทำไมผูกกับ score ไม่ใช่ "ลูกค้าทักมา": ลูกค้าเก่าทักคำเดียวแล้วเงียบไม่ควรถูกทวง
      // แต่ห้องที่คุยกันจนระบบให้คะแนนได้ คือห้องที่มีบทสนทนาจริงและ FU มีประโยชน์
      // ผลข้างเคียงที่ตั้งใจ: ฐานเดิม 5,537 ห้องจะทยอยเข้า FU ทีละห้องตามที่คุยกันจริง
      // ไม่ใช่เปิดพรวดพร้อมกันทั้งฐาน — ซึ่งเป็นสิ่งที่กลัวกันตั้งแต่แรก
      //
      // ห้ามลบล้างการตัดสินใจของคน: ห้องที่ชมพู่กดปิดเองมี followup_choice_by_human = 1
      // และจะไม่ถูกแตะที่นี่ตลอดไป
      run(
        `UPDATE customers SET followup_enabled = 1, updated_at = ?
          WHERE line_user_id = ? AND followup_enabled = 0 AND followup_choice_by_human = 0
            AND followup_suppression_reason = ''`,
        t, String(customerId)
      );
      return id;
    },

    scoreHistory(customerId, limit = 20) {
      return all(
        `SELECT id, score, payload_json, created_at FROM score_history
         WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        String(customerId), Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 20))
      );
    },

    latestScoreRow(customerId) {
      return get(
        `SELECT id, score, payload_json, created_at FROM score_history
         WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        String(customerId)
      ) ?? null;
    },

    /* ------------------------------ followups (F5) --------------------------- */

    createFollowup({ customerId, scheduledAt, createdBy = "", note = "" }) {
      const id = randomUUID();
      const t = now();
      run(
        `INSERT INTO followups (id, customer_id, scheduled_at, status, created_by, note, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
        id, String(customerId), Number(scheduledAt), String(createdBy), String(note).slice(0, 300), t, t
      );
      return this.getFollowup(id);
    },

    getFollowup(id) {
      return get("SELECT * FROM followups WHERE id = ?", String(id)) ?? null;
    },

    listFollowupsFor(customerId, limit = 20) {
      return all(
        `SELECT * FROM followups WHERE customer_id = ?
         ORDER BY (status = 'pending') DESC, scheduled_at ASC, created_at DESC LIMIT ?`,
        String(customerId), Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 20))
      );
    },

    // นัดที่ถึงเวลาแล้ว (pending + scheduled_at <= now) — scheduler หยิบเป็นชุดเล็ก ๆ
    dueFollowups(nowMs = now(), limit = 10) {
      return all(
        `SELECT * FROM followups WHERE status = 'pending' AND scheduled_at <= ?
         ORDER BY scheduled_at ASC LIMIT ?`,
        Number(nowMs), Math.min(50, Math.max(1, Number(limit) || 10))
      );
    },

    // เปลี่ยนสถานะได้เฉพาะจาก pending (sent/cancelled/skipped เป็นสถานะปลายทาง)
    setFollowupStatus(id, status, { detail = "" } = {}) {
      if (!["sent", "cancelled", "skipped"].includes(status)) return false;
      const result = run(
        "UPDATE followups SET status = ?, detail = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        status, String(detail).slice(0, 300), now(), String(id)
      );
      return result.changes === 1;
    },

    // quiet hours: เลื่อนนัดไปเวลาใหม่ (ยังเป็น pending — ไม่ยกเลิก)
    rescheduleFollowup(id, scheduledAt, detail = "") {
      const result = run(
        "UPDATE followups SET scheduled_at = ?, detail = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        Number(scheduledAt), String(detail).slice(0, 300), now(), String(id)
      );
      return result.changes === 1;
    },

    // ลูกค้าขอหยุด (do_not_disturb) หรือ reset -> ยกเลิกนัดค้างทั้งหมดของลูกค้าคนนั้น
    cancelPendingFollowups(customerId, detail = "cancelled") {
      const result = run(
        "UPDATE followups SET status = 'cancelled', detail = ?, updated_at = ? WHERE customer_id = ? AND status = 'pending'",
        String(detail).slice(0, 300), now(), String(customerId)
      );
      return result.changes;
    },

    /* --------------------------- handoff notes (B6) -------------------------- */

    addHandoffNote({ customerId, author = "", text = "" }) {
      const id = randomUUID();
      run(
        "INSERT INTO handoff_notes (id, customer_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)",
        id, String(customerId), String(author), String(text).slice(0, 500), now()
      );
      return this.getHandoffNote(id);
    },

    getHandoffNote(id) {
      return get("SELECT * FROM handoff_notes WHERE id = ?", String(id)) ?? null;
    },

    // โน้ตล่าสุดที่ "คน" เขียน — ป้าย "สรุปจาก LINE OA" ในหัวห้องต้องใช้ค่านี้ ไม่ใช่
    // ค่าที่ถอดจาก listHandoffNotes เพราะ list นั้นเรียงปักหมุดก่อนแล้วตัดที่ LIMIT
    // ห้องที่ปักหมุดไว้เยอะพอจะดันโน้ตใหม่หลุดออกไป = ป้ายค้างส้มทั้งที่สรุปแล้ว
    // SQL ตรงนี้ต้องตรงกับคอลัมน์ last_human_note_at ใน listConversations เสมอ
    lastHumanHandoffNoteAt(customerId) {
      return get(
        `SELECT MAX(created_at) AS at FROM handoff_notes
         WHERE customer_id = ? AND author NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})`,
        String(customerId)
      )?.at ?? null;
    },

    // ปักหมุดมาก่อน แล้วเลือก N รายการ; ภายในแต่ละกลุ่มเรียงเก่า -> ใหม่
    // อย่าง deterministic แม้หลายแถวถูกเขียนใน millisecond เดียวกัน
    listHandoffNotes(customerId, limit = 20) {
      return all(
        `SELECT id,customer_id,author,text,created_at,pinned
           FROM (
             SELECT rowid AS insertion_order,id,customer_id,author,text,created_at,pinned
               FROM handoff_notes
              WHERE customer_id = ?
              ORDER BY pinned DESC,created_at DESC,rowid DESC
              LIMIT ?
           )
          ORDER BY pinned DESC,created_at ASC,insertion_order ASC`,
        String(customerId), Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 20))
      );
    },

    setHandoffNotePinned(id, pinned = true) {
      return run("UPDATE handoff_notes SET pinned = ? WHERE id = ?", pinned ? 1 : 0, String(id)).changes === 1
        ? this.getHandoffNote(id)
        : null;
    },

    deleteHandoffNote(id) {
      return run("DELETE FROM handoff_notes WHERE id = ?", String(id)).changes === 1;
    },

    // โน้ตสรุปสถานะจาก scorer — คงไว้แถวเดียวต่อลูกค้า (แทนของเก่า โน้ตคนไม่แตะ)
    upsertAiAutoNote(customerId, text) {
      run("DELETE FROM handoff_notes WHERE customer_id = ? AND author = 'ai_auto'", String(customerId));
      const id = randomUUID();
      run(
        "INSERT INTO handoff_notes (id, customer_id, author, text, created_at) VALUES (?, ?, 'ai_auto', ?, ?)",
        // v1.5.1: 500 -> 800 รับสรุปแบบ "ข้อตกลงสะสม + สถานะ" (scorer cap 700 + กันชน)
        id, String(customerId), String(text).slice(0, 800), now()
      );
      return id;
    },

    // P2: รุ่นสมองที่ "คำตอบล่าสุดของห้องนี้" ถูกผลิตขึ้นมา (null = ยังไม่เคยอ่านสมอง)
    // ใช้ตรวจว่ารุ่นเปลี่ยนใต้เท้าห้องที่กำลังคุยเรื่องเงินอยู่หรือเปล่า
    lastBrainVersionFor(customerId) {
      return get(
        `SELECT brain_version_id FROM messages
          WHERE customer_id = ? AND direction = 'out' AND brain_version_id IS NOT NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        String(customerId),
      )?.brain_version_id ?? null;
    },

    /* ----------------------------- llm usage (B8) ---------------------------- */

    // ไม่มี usage จาก Hermes = caller ไม่เรียกเมธอดนี้ (ข้ามเงียบ ๆ ตาม SPEC B8)
    // v1.4.25: เก็บ cached_tokens ด้วย — ต้องวัดได้ว่า prompt caching ทำงานจริงไหม
    // (ก่อนหน้านี้มองไม่เห็นเลย จึงไม่รู้ว่าจ่ายเต็มราคาทุก call มาตลอด)
    addLlmUsage({ customerId = "", kind, model = "", tokensIn = 0, tokensOut = 0, cachedIn = 0, cacheWriteIn = null, brainVersionId = null }) {
      const id = randomUUID();
      run(
        `INSERT INTO llm_usage (id, customer_id, kind, model, tokens_in, tokens_out, cached_in, cache_write_in, cache_write_known, brain_version_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, String(customerId), String(kind), String(model),
        Math.max(0, Math.round(Number(tokensIn) || 0)), Math.max(0, Math.round(Number(tokensOut) || 0)),
        Math.max(0, Math.round(Number(cachedIn) || 0)),
        Math.max(0, Math.round(Number(cacheWriteIn) || 0)),
        cacheWriteIn == null ? 0 : 1,
        brainVersionId ? String(brainVersionId) : null, now()
      );
      return id;
    },

    // รวม token ตาม model+kind ตั้งแต่ sinceMs (0 = ทั้งหมด) — คิดเงินฝั่ง caller ตาม pricing
    // v1.2: channel = scope ต่อสาขา (join customers — แถวที่หา channel ไม่ได้จะไม่นับใน scope)
    // untilMs = ขอบบน (ไม่รวม) สำหรับดูย้อนหลังทีละวัน — ไม่ส่ง = ถึงปัจจุบันเหมือนเดิม
    llmUsageSummary(sinceMs = 0, channel = null, untilMs = null) {
      const until = upperBound(untilMs);
      const capped = until !== null;
      if (channel) {
        return all(
          `SELECT u.model, u.kind, SUM(u.tokens_in) AS tokens_in, SUM(u.tokens_out) AS tokens_out,
                  SUM(COALESCE(u.cached_in, 0)) AS cached_in,
                  SUM(u.cache_write_in) AS cache_write_in, (u.tokens_in > 272000) AS long_context,
                  SUM(CASE WHEN u.cache_write_known=0 AND u.tokens_in>0 THEN 1 ELSE 0 END) AS missing_cache_write_calls
           FROM llm_usage u JOIN customers c ON c.line_user_id = u.customer_id
           WHERE u.created_at >= ?${capped ? " AND u.created_at < ?" : ""} AND c.channel_id = ?
           GROUP BY u.model, u.kind, (u.tokens_in > 272000) ORDER BY u.model, u.kind`,
          Number(sinceMs) || 0, ...(capped ? [until] : []), String(channel)
        );
      }
      return all(
        `SELECT model, kind, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
                SUM(COALESCE(cached_in, 0)) AS cached_in,
                SUM(cache_write_in) AS cache_write_in, (tokens_in > 272000) AS long_context,
                SUM(CASE WHEN cache_write_known=0 AND tokens_in>0 THEN 1 ELSE 0 END) AS missing_cache_write_calls
         FROM llm_usage WHERE created_at >= ?${capped ? " AND created_at < ?" : ""}
         GROUP BY model, kind, (tokens_in > 272000) ORDER BY model, kind`,
        Number(sinceMs) || 0, ...(capped ? [until] : [])
      );
    },

    // รวม token ของลูกค้าคนเดียว (all-time) ตาม model — โชว์ค่าใช้จ่ายรายลูกค้า
    llmUsageForCustomer(customerId) {
      return all(
        `SELECT model, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
                SUM(COALESCE(cached_in, 0)) AS cached_in,
                SUM(cache_write_in) AS cache_write_in, (tokens_in > 272000) AS long_context,
                SUM(CASE WHEN cache_write_known=0 AND tokens_in>0 THEN 1 ELSE 0 END) AS missing_cache_write_calls
         FROM llm_usage WHERE customer_id = ? GROUP BY model, (tokens_in > 272000) ORDER BY model`,
        String(customerId)
      );
    },

    /* ---------------------------- settings / metrics ------------------------- */

    setSetting(key, value) {
      run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(key), String(value)
      );
    },

    getSetting(key) {
      return get("SELECT value FROM settings WHERE key = ?", String(key))?.value ?? null;
    },

    // ตัวนับ metric แบบสะสม (F4: reply ไม่จบด้วยคำถามทั้งที่ score ต่ำ)
    bumpMetric(name) {
      run(
        `INSERT INTO settings (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
        `metric:${name}`
      );
    },

    getMetric(name) {
      const raw = this.getSetting(`metric:${name}`);
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    },

    /* ------------------------------- reset (F6) ------------------------------ */

    // hash ของลูกค้าที่ใช้ใน teach_json — ที่เดียวที่รู้กุญแจของ instance นี้
    teachCustomerHash(lineUserId) {
      return teachCustomerHash(lineUserId, teachHashSecret);
    },

    /**
     * ลบร่องรอยของลูกค้าคนหนึ่งออกจาก teach_json ของทุกรุ่นสมอง
     *
     * ทำไมต้องมีแยก: teach_json เป็นคอลัมน์ JSON บน brain_versions ซึ่งไม่มีคอลัมน์ผูกลูกค้า
     * test/pdpa-cascade.test.mjs จึงมองไม่เห็นโดยโครงสร้าง — ถ้าไม่เรียกตัวนี้ใน resetCustomer
     * "สิทธิ์ให้ลืม" จะทิ้ง hash + ตัวชี้คำแก้ + ข้อความที่คนพิมพ์ไว้ค้างตลอดกาล
     * การ์ดความรู้ที่เกิดจากการสอนยังอยู่ (เป็นของธุรกิจ) — ที่หายคือ "ใครเป็นต้นเรื่อง"
     */
    scrubTeachIdentity({ customerHash = "", refIds = [] } = {}) {
      const wanted = new Set([...refIds].map(String).filter(Boolean));
      const hash = String(customerHash || "");
      let scrubbed = 0;
      for (const row of all("SELECT version_id, teach_json FROM brain_versions")) {
        let teach = null;
        try { teach = JSON.parse(String(row.teach_json || "{}")); } catch { teach = null; }
        if (!teach || typeof teach !== "object") continue;
        const mine = (hash && teach.customer_hash === hash)
          || wanted.has(String(teach.correction_ref || ""))
          || wanted.has(String(teach.message_ref || ""));
        if (!mine) continue;
        const { teach: next, changed } = stripTeachIdentity(teach);
        if (!changed) continue;
        run("UPDATE brain_versions SET teach_json = ? WHERE version_id = ?",
          JSON.stringify(next), String(row.version_id));
        scrubbed += 1;
      }
      return scrubbed;
    },

    // ล้างประวัติลูกค้าหนึ่งคนสำหรับ test phase / PDPA erasure
    // - ค่าเดิมคง display_name/picture_url ไว้ เพื่อไม่เปลี่ยน UX ของปุ่ม reset
    // - forget=true ใช้เฉพาะเส้นทาง retention/สิทธิ์ให้ลืม: ล้าง identity/linkage ด้วย
    //   และทำให้ usage ไม่ระบุตัวบุคคลก่อนลบ เพื่อคงสถิติ model cost แบบ aggregate
    resetCustomer(lineUserId, { forget = false, forgetReason = "pdpa_request" } = {}) {
      const id = String(lineUserId ?? "");
      if (!id) throw new Error("customer identity is required");
      db.exec("BEGIN IMMEDIATE");
      try {
        const writeTombstone = () => run(
          `INSERT INTO customer_tombstones (line_user_id_hash,forgotten_at,reason)
           VALUES (?,?,?)
           ON CONFLICT(line_user_id_hash) DO UPDATE SET
             forgotten_at=MAX(customer_tombstones.forgotten_at,excluded.forgotten_at),
             reason=excluded.reason`,
          hashCustomerIdentity(id), now(), normalizeTombstoneReason(forgetReason),
        );
        const existing = this.getCustomer(id);
        // 6 ต.ค. 2026: เธรดเดิมกดแอดแล้วไม่เคยพิมพ์ = มีแถว referral แต่ไม่มีแถวลูกค้า — ลบก่อนจบเร็ว
        // (ห้องที่มีแถวลูกค้าถูกลบด้วยบรรทัดเดียวกันนี้เช่นกัน ไม่ต้องลบซ้ำข้างล่าง)
        this.deleteAdReferralsForCustomer(id);
        if (!existing) {
          if (forget) writeTombstone();
          db.exec("COMMIT");
          return null;
        }
      // Physical bytes are deleted through the durable queue before this
      // database erasure. Refuse every direct/reset caller while a byte pointer
      // or queued deletion remains, so a crash cannot orphan customer media.
      const mediaGuard = get(
        `SELECT
           (SELECT COUNT(*) FROM message_attachments WHERE customer_id=? AND storage_key!='') AS stored,
           (SELECT COUNT(*) FROM message_media_deletion_queue WHERE customer_id=?) AS queued`,
        id, id,
      ) || { stored: 0, queued: 0 };
      if (Number(mediaGuard.stored) > 0 || Number(mediaGuard.queued) > 0) {
        throw new Error("customer media deletion is incomplete");
      }
      if (forget) {
        const messageCounts = get(
          `SELECT
             SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) AS inbound,
             SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) AS outbound
           FROM messages WHERE customer_id=?`,
          id,
        ) || { inbound: 0, outbound: 0 };
        const tagCount = Number(get("SELECT COUNT(*) AS n FROM customer_tags WHERE customer_id=?", id)?.n || 0);
        const addMetric = (key, amount) => {
          const n = Math.max(0, Math.trunc(Number(amount) || 0));
          if (!n) return;
          run(
            `INSERT INTO settings (key,value) VALUES (?,?)
             ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(settings.value AS INTEGER)+? AS TEXT)`,
            key, String(n), n,
          );
        };
        addMetric("metric:retention_messages_in", messageCounts.inbound);
        addMetric("metric:retention_messages_out", messageCounts.outbound);
        addMetric("metric:retention_tag_assignments", tagCount);
        addMetric("metric:retention_customers_forgotten", 1);
        // Global model/kind/token summaries remain exact, but the usage row can
        // no longer be joined back to a customer or channel after erasure.
        run("UPDATE llm_usage SET customer_id='' WHERE customer_id=?", id);
        // 28 ก.ย. 2026: แชทพี่ง้วง↔ลูกแพรทาง Telegram ไม่ผูก id ลูกค้า แต่พี่ง้วงอาจพิมพ์ชื่อเต็มไว้
        // ลืม = คู่ข้อความที่เอ่ยชื่อเต็มของคนนี้หายด้วย (reset ธรรมดาไม่แตะ — ไม่ใช่คำขอลืม)
        this.forgetOwnerChatMentions([existing.known_name, existing.display_name]);
        writeTombstone();
      }
      // teach_json อ้าง id ของคำแก้/ข้อความที่กำลังจะถูกลบ — ต้องเก็บ id ไว้ก่อนลบ
      // ไม่งั้นหลังลบเสร็จจะไม่มีทางรู้อีกเลยว่ารุ่นไหนผูกกับคนคนนี้
      const teachRefIds = [
        ...all("SELECT id FROM corrections WHERE customer_id = ?", id).map((row) => row.id),
        ...all("SELECT id FROM messages WHERE customer_id = ?", id).map((row) => row.id),
      ];
      this.scrubTeachIdentity({ customerHash: this.teachCustomerHash(id), refIds: teachRefIds });
      // บทเรียนที่สอนจากห้องนี้: คำสอนอยู่ต่อ (ของธุรกิจ) แต่คำลูกค้า/คำตอบเดิม/ตัวชี้ห้องต้องหาย
      // — ต้องอยู่ก่อนลบ messages เพราะตามหาแถวจากตัวชี้ข้อความด้วย (dbLessons.mjs)
      this.scrubOwnerLessonsForCustomer(id);
      // 28 ก.ย. 2026: การเชื่อมข้ามช่องทาง — แถวของคนนี้ + ตัวชี้ในรหัสของห้องอื่น + โน้ตสรุปที่คัดลอกจากห้องนี้
      // ไปไว้ในห้องอื่นของคนเดียวกัน (ต้องอยู่ก่อนลบ handoff_notes/messages — อ่านแถวเชื่อมของเขาอยู่)
      this.detachIdentityOnReset(id);
      // เฟส 3 (PDPA): golden_turns.message_ref ชี้ messages.id ตรง ๆ — ต้องลบ **ก่อน**
      // แถว messages หายไป ไม่งั้น subquery หาไม่เจอแล้วตัวชี้ค้างอยู่ตลอดกาล
      // (แถวสังเคราะห์ไม่มี message_ref จึงไม่ถูกแตะ — เป็นของเราไม่ใช่ของลูกค้า)
      this.deleteGoldenTurnsForCustomer(id);
      run("DELETE FROM message_media_deletion_queue WHERE customer_id = ?", id);
      // Capability rows have no customer_id of their own, so delete them while
      // the attachment relationship is still present. Otherwise a PDPA reset
      // would leave durable download capabilities behind.
      run(
        `DELETE FROM attachment_download_tokens
          WHERE attachment_id IN (SELECT id FROM message_attachments WHERE customer_id = ?)`,
        id,
      );
      run("DELETE FROM message_attachments WHERE customer_id = ?", id);
      run("DELETE FROM operator_outbound_attempts WHERE customer_id = ?", id);
      run("DELETE FROM messages WHERE customer_id = ?", id);
      run("DELETE FROM score_history WHERE customer_id = ?", id);
      run("DELETE FROM jev_decision_reviews WHERE customer_id = ?", id);
      run("DELETE FROM jev_audit_feedback WHERE customer_id = ?", id);
      // 12 ต.ค. 2026 ค่ำ: ข้อเสนอปิดห้องที่รอ/เคยรอพี่ง้วงยืนยัน (dbOwnerReview.mjs) — reset ไม่ลบแถวลูกค้า จึงลบเองตรงนี้
      this.deleteOwnerReviewForCustomer(id);
      run("DELETE FROM followups WHERE customer_id = ?", id);
      run("DELETE FROM corrections WHERE customer_id = ?", id);
      run("DELETE FROM followup_state WHERE customer_id = ?", id);
      run("DELETE FROM proactive_attempts WHERE customer_id = ?", id);
      // 12 ต.ค. 2026: คำชวนทดลองเรียนฟรีของห้องนี้ — ไม่เหลือ id แต่คงยอดของวันนั้น (ลบแล้วยอดลด = ชวนเกินเพดานได้)
      this.anonymizeTrialInvite(id, randomUUID());
      run("DELETE FROM handoff_notes WHERE customer_id = ?", id);
      if (!forget) {
        run("DELETE FROM llm_usage WHERE customer_id = ?", id);
      }
      run("DELETE FROM slip_checks WHERE customer_id = ?", id);
      run("DELETE FROM orders WHERE customer_id = ?", id); // G6: ออเดอร์ผูกลูกค้า — PDPA ลบด้วย
      run("DELETE FROM customer_tags WHERE customer_id = ?", id); // v1.1: tag ผูกลูกค้า — PDPA ลบด้วย
      run("DELETE FROM tag_sync_state WHERE customer_id = ?", id); // v1.4.9c: สถานะ sync tag ผูกลูกค้า — PDPA ลบด้วย
      run("DELETE FROM broadcast_recipients WHERE line_user_id = ?", id);
      // 2026-09-02 (PDPA): บัญชี "ไม่รู้ว่าถึงหรือไม่" ของบรอดแคสต์เก็บ LINE id ดิบ
      // ลบเฉพาะแถวลูก แถวกักกัน (แม่) คงไว้เพราะเป็นหลักฐานว่ารอบนั้นผลไม่แน่ชัด
      // — ON DELETE RESTRICT กันไม่ให้ลบแม่อยู่แล้ว และคนที่ถูกลืมไม่มีทางอยู่ใน
      // audience รอบใหม่ ด่านกันส่งซ้ำจึงไม่เสียความหมาย
      run("DELETE FROM broadcast_delivery_unknown_recipients WHERE line_user_id = ?", id);
      // ปลายทางทดสอบส่งเองของผู้ดูแล — ปกติเป็น LINE id ของคนในทีม ไม่ใช่ลูกค้า
      // แต่ "ลืม" แปลว่าต้องไม่เหลือ id นั้นที่ไหนเลย ผู้ดูแลยืนยันปลายทางใหม่ได้เสมอ
      run("DELETE FROM broadcast_self_test_destinations WHERE line_user_id = ?", id);
      // 28 ก.ย. 2026: สถานะเพิ่มเพื่อน/บล็อกจาก webhook (ใช้ตัดคนบล็อกจากบรอดแคสต์) ผูกลูกค้า — PDPA ลบด้วย
      run("DELETE FROM line_follow_state WHERE customer_id = ?", id);
      // 28 ก.ย. 2026: ข้อความตามขั้น — คนในลำดับ + ประวัติการส่งต่อขั้น ผูกลูกค้า (สถิติรวมของลำดับลดตาม)
      this.deleteStepDataForCustomer(id);
      run("DELETE FROM training_candidates WHERE customer_id = ?", id);
      run("DELETE FROM training_feedback WHERE customer_id = ?", id); // v1.2.6: feedback ผูกลูกค้า — PDPA ลบด้วย
      run("DELETE FROM conversation_sessions WHERE customer_id = ?", id);
      // v1.4 (PDPA): facts มีข้อมูลภาษี/เบอร์/บริษัท — ลืมไม่ได้; event log ก็อ้างลูกค้าตรง ๆ
      run("DELETE FROM customer_facts WHERE customer_id = ?", id);
      run("DELETE FROM lifecycle_events WHERE customer_id = ?", id);
      run("DELETE FROM enrollments WHERE customer_id = ?", id);
      run("DELETE FROM followup_suggestions WHERE customer_id = ?", id);
      run("DELETE FROM web_push_events WHERE customer_id = ?", id);
      // บัญชีผลลัพธ์เทิร์นขาเข้าอ้างถึงลูกค้าตรง ๆ — PDPA/reset ต้องลบด้วย
      run("DELETE FROM inbound_turn_outcomes WHERE customer_id = ?", id);
      // M3 (PDPA): audit ที่อ้างถึงลูกค้าคนนี้ (target/detail) + สถานะ ack เวลาทำการ ต้องหายด้วย
      // (caller ฝั่ง console เพิ่มแถว audit "reset_customer" หลังลบ — เหลือหลักฐานการลบแถวเดียว)
      const like = `%${id.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      run("DELETE FROM admin_audit WHERE target = ? OR detail LIKE ? ESCAPE '\\'", id, like);
      // 2026-09-02 (PDPA): สถานะรายลูกค้าที่ฝากไว้ใน settings เคยลบทีละคีย์ที่รู้จัก
      // (schedule_ack:, oob_last:, opportunity_handoff:) คีย์ใหม่ที่ใครเพิ่มทีหลัง
      // จึงค้างอยู่เงียบ ๆ ทุกครั้ง — กวาดตามรูปแบบแทน: id ต้องเป็น segment เต็ม
      // ที่คั่นด้วย ":" เสมอ (`<ชื่อ>:<id>` หรือ `<ชื่อ>:<id>:<อะไรต่อ>`)
      // จับ segment เต็มไม่ใช่สตริงย่อย เพื่อไม่ให้คีย์ของ U10 หายตอนลบ U1
      // escape metacharacter ของ LIKE ก่อนเสมอ
      const escapedId = id.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      run(
        `DELETE FROM settings
          WHERE key = ?
             OR key LIKE ? ESCAPE '\\'
             OR key LIKE ? ESCAPE '\\'
             OR key LIKE ? ESCAPE '\\'`,
        id, `${escapedId}:%`, `%:${escapedId}`, `%:${escapedId}:%`,
      );
      if (forget) {
        // A retention forget is an erasure, not a console-history reset. The
        // primary row is itself a raw LINE identity, so it must disappear only
        // after every dependent row above and aggregate metric capture finish.
        run("DELETE FROM customers WHERE line_user_id = ?", id);
      } else {
        run(
          `UPDATE customers SET
             ai_enabled = 1, ai_off_reason = '', state = 'AI_ACTIVE', human_owner = '', handoff_summary = '',
           money_seen_at = 0, price_deferred_at = 0, price_quoted_at = 0, known_context_at = 0,
             price_pivot_deferred_at = 0, service_boundary_json = '{}',
             known_name = '', last_score = NULL, last_score_at = NULL,
             do_not_disturb = 0, followup_enabled = 1, followup_suppression_reason = '', operator_active_until = 0,
             last_seen_by_operator_at = 0, lifecycle_stage = 'sales', deal_status = 'new',
             updated_at = ?
           WHERE line_user_id = ?`,
          now(), id
        );
      }
      db.exec("COMMIT");
      return forget ? { forgotten: true } : this.getCustomer(id);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
        throw error;
      }
    },

    listCustomerTombstones() {
      return all(
        `SELECT line_user_id_hash,forgotten_at,reason
           FROM customer_tombstones
          ORDER BY forgotten_at ASC,line_user_id_hash ASC`,
      );
    },

    /* -------- overview: overviewStats(channel) ย้ายไป dbExtra.mjs (คุมไฟล์ <800) -------- */

    /* ------------------------------- operators ------------------------------ */

    createOperator({ username, passHash, displayName = "", role = "operator" }) {
      const t = now();
      run(
        `INSERT INTO operators (username, pass_hash, display_name, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        String(username), String(passHash), String(displayName), String(role), t, t
      );
      return this.getOperator(username);
    },

    getOperator(username) {
      return get("SELECT * FROM operators WHERE username = ?", String(username)) ?? null;
    },

    listOperators() {
      return all(
        `SELECT username, display_name, role, disabled, created_at, updated_at
         FROM operators ORDER BY created_at, username`
      );
    },

    countOperators() {
      return get("SELECT COUNT(*) AS n FROM operators WHERE disabled = 0")?.n ?? 0;
    },

    // M1: เปลี่ยนรหัสผ่าน + bump token_version — session อื่นทุกใบของบัญชีนี้ถูกตัดทันที
    changeOperatorPassword(username, passHash) {
      return run(
        "UPDATE operators SET pass_hash = ?, token_version = token_version + 1, updated_at = ? WHERE username = ?",
        String(passHash), now(), String(username)
      ).changes === 1;
    },

    // เปลี่ยน role/สถานะต้อง bump token_version เสมอ เพื่อให้สิทธิ์ของ session เก่า
    // ใช้ต่อไม่ได้แม้ผู้ใช้ยังเปิดหน้า console ค้างอยู่
    updateOperatorAccount(username, { displayName, role, disabled }) {
      return run(
        `UPDATE operators SET display_name = ?, role = ?, disabled = ?,
           token_version = token_version + 1, updated_at = ?
         WHERE username = ? AND role != 'owner'`,
        String(displayName), String(role), disabled ? 1 : 0, now(), String(username)
      ).changes === 1;
    },

    /* --------------------------------- audit -------------------------------- */

    addAudit({ operator, action, target = "", detail = "" }) {
      const id = randomUUID();
      run(
        "INSERT INTO admin_audit (id, operator, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id, String(operator), String(action), String(target), String(detail).slice(0, 500), now()
      );
      return id;
    },

    listAudit(limit = 100) {
      return all(
        "SELECT * FROM admin_audit ORDER BY created_at DESC, rowid DESC LIMIT ?",
        Math.min(500, Math.max(1, Number(limit) || 100))
      );
    },

    /* ---------------------------- approved prices --------------------------- */

    setApprovedPrice(label, amount) {
      run(
        `INSERT INTO approved_prices (label, amount) VALUES (?, ?)
         ON CONFLICT(label) DO UPDATE SET amount = excluded.amount`,
        String(label), Number(amount)
      );
    },

    approvedPrices() {
      return all("SELECT label, amount FROM approved_prices ORDER BY label");
    },

    getApprovedPrice(label) {
      return get("SELECT label, amount FROM approved_prices WHERE label = ?", String(label)) ?? null;
    },

    deleteApprovedPrice(label) {
      return run("DELETE FROM approved_prices WHERE label = ?", String(label)).changes === 1;
    },

    /* -------------------------------- canary -------------------------------- */

    setCanary(id, { status = "idle", detail = "", lastProbeAt = null, lastOkAt = null, roundTripMs = null } = {}) {
      run(
        `INSERT INTO canary_state (id, status, detail, last_probe_at, last_ok_at, round_trip_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           detail = excluded.detail,
           last_probe_at = COALESCE(excluded.last_probe_at, canary_state.last_probe_at),
           last_ok_at = COALESCE(excluded.last_ok_at, canary_state.last_ok_at),
           round_trip_ms = COALESCE(excluded.round_trip_ms, canary_state.round_trip_ms)`,
        String(id), status, detail, lastProbeAt, lastOkAt, roundTripMs
      );
    },

    getCanary(id) {
      return get("SELECT * FROM canary_state WHERE id = ?", String(id)) ?? null;
    },

    close() {
      try {
        db.close();
      } catch {
        // ปิดซ้ำ — ข้าม
      }
    },
  };
}
