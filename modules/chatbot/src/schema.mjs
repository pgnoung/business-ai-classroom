// schema.mjs — DDL ทั้งหมดของ chassis (แยกจาก db.mjs เพื่อคุมขนาดไฟล์ <800 บรรทัด)
// ทุกตาราง CREATE TABLE IF NOT EXISTS — คอลัมน์ใหม่บนตารางเดิมเติมผ่าน ensureColumn ใน db.mjs

// Multi-OA (W3): line_user_id เป็น "customer key" — channel default = raw LINE user id
// (แถวเก่าถูกต้องทันที ไม่ต้อง migrate), channel อื่น = "<channelId>:<lineUserId>"
// ลูกค้าคนเดียวทัก 2 OA = 2 แถว; เหตุผลของ scheme นี้อยู่หัวไฟล์ src/channels.mjs
// channel_id บน customers/messages เติมให้ DB เก่าผ่าน ensureColumn ใน db.mjs
import { BRAIN_SCHEMA } from "./brain/schema.mjs";
// 28 ก.ย. 2026: บัญชีการยิง LINE + สถิติทางการของ LINE (การ์ด "LINE OA เดือนนี้") — DDL อยู่กับตัวเก็บของมันเอง
import { LINE_USAGE_SCHEMA } from "./dbLineUsage.mjs";
// 28 ก.ย. 2026: ลูกค้าคนเดียวกันข้ามช่องทาง (Facebook ↔ LINE) + รหัสเชื่อมแชท — DDL อยู่กับตัวเก็บของมันเอง
import { IDENTITY_LINK_SCHEMA } from "./dbIdentityLinks.mjs";
// 28 ก.ย. 2026: สตูดิโอบรอดแคสต์ (แคมเปญ/ลิงก์นับคลิก/สถานะเพื่อน) — DDL อยู่กับตัวเก็บของมันเอง
import { BROADCAST_STUDIO_SCHEMA } from "./dbBroadcastStudio.mjs";
// 28 ก.ย. 2026: ข้อความตามขั้น (Step messages) — ลำดับ/คนในลำดับ/การส่งแต่ละขั้น
import { STEP_MESSAGES_SCHEMA } from "./dbStepMessages.mjs";
// 6 ต.ค. 2026: ที่มาของห้องจากแอด Meta (referral ของ Messenger) — DDL อยู่กับตัวเก็บของมันเอง
import { AD_REFERRAL_SCHEMA } from "./dbAdReferrals.mjs";
import { META_CAPI_SCHEMA } from "./dbMetaCapi.mjs";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  line_user_id      TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL DEFAULT '',
  ai_enabled        INTEGER NOT NULL DEFAULT 1,
  state             TEXT NOT NULL DEFAULT 'AI_ACTIVE',
  human_owner       TEXT NOT NULL DEFAULT '',
  handoff_summary   TEXT NOT NULL DEFAULT '',
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  do_not_disturb    INTEGER NOT NULL DEFAULT 0,
  followup_suppression_reason TEXT NOT NULL DEFAULT ''
                           CHECK (followup_suppression_reason IN ('','customer_will_return','customer_considering','colleague_will_contact','accounting_documents')),
  channel_id        TEXT NOT NULL DEFAULT 'default',
  legacy_last_activity_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  channel       TEXT NOT NULL DEFAULT 'line',
  msg_type      TEXT NOT NULL DEFAULT 'text',
  content       TEXT NOT NULL DEFAULT '',
  message_class TEXT NOT NULL DEFAULT 'reactive'
                CHECK (message_class IN ('reactive','proactive')),
  operator      TEXT NOT NULL DEFAULT '',
  channel_id    TEXT NOT NULL DEFAULT 'default',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer_id, created_at);

-- Private customer/operator media. Never reuse media_assets: that table/store is
-- deliberately public marketing media. Bytes are addressed only by an opaque id.
CREATE TABLE IF NOT EXISTS message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  customer_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  source TEXT NOT NULL DEFAULT 'line',
  kind TEXT NOT NULL CHECK(kind IN ('image','file','sticker','audio','video','unknown')),
  status TEXT NOT NULL DEFAULT 'unavailable' CHECK(status IN ('queued','ready','unavailable','failed')),
  original_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  byte_size INTEGER,
  sha256 TEXT NOT NULL DEFAULT '',
  storage_key TEXT NOT NULL DEFAULT '',
  provider_message_id TEXT NOT NULL DEFAULT '',
  provider_meta_json TEXT NOT NULL DEFAULT '{}',
  unavailable_reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  send_claim_id TEXT NOT NULL DEFAULT '',
  send_claim_expires_at INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_customer ON message_attachments(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_attachments_due ON message_attachments(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS attachment_download_tokens (
  token_hash TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachment_download_expiry ON attachment_download_tokens(expires_at);
CREATE TABLE IF NOT EXISTS message_media_upload_reservations (
  id TEXT PRIMARY KEY,
  operator TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_media_upload_reservations_expiry ON message_media_upload_reservations(expires_at);
CREATE INDEX IF NOT EXISTS idx_message_media_upload_reservations_operator ON message_media_upload_reservations(operator, created_at);
CREATE TABLE IF NOT EXISTS message_media_deletion_queue (
  storage_key TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_media_deletion_queue_created ON message_media_deletion_queue(created_at);
CREATE TABLE IF NOT EXISTS operator_outbound_attempts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK(status IN ('sending','accepted_pending','partial_pending','accepted','partial','rejected','ambiguous')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  claim_id TEXT NOT NULL DEFAULT '',
  provider_status INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_outbound_attempts_status ON operator_outbound_attempts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_operator_outbound_attempts_customer ON operator_outbound_attempts(customer_id, created_at);

-- Training reset: a customer may have many immutable conversation sessions.
-- Only the active session is prompt-visible; older sessions may become an
-- owner-reviewed training candidate but are never injected automatically.
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  channel_id  TEXT NOT NULL DEFAULT 'default',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated')),
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_one_active
  ON conversation_sessions(customer_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_customer
  ON conversation_sessions(customer_id, created_at);

CREATE TABLE IF NOT EXISTS training_candidates (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  reset_event_id TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'pending_owner_confirmation'
                 CHECK (status IN ('pending_owner_confirmation','approved','rejected')),
  transcript_json TEXT NOT NULL DEFAULT '[]',
  message_count  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  ack_status     TEXT NOT NULL DEFAULT 'pending'
                 CHECK (ack_status IN ('pending','sent','failed','ambiguous')),
  ack_detail     TEXT NOT NULL DEFAULT '',
  ack_resolved_at INTEGER,
  ack_resolved_by TEXT NOT NULL DEFAULT '',
  ack_resolution  TEXT NOT NULL DEFAULT '',
  decided_at     INTEGER,
  decided_by     TEXT NOT NULL DEFAULT ''
);
-- v1.2.6 (คำสั่งพี่ง้วง 2026-08-13): ผู้ทดสอบพิมพ์ feedback ต่อท้าย /reset หรือส่ง /fb
-- ระหว่างรอบได้ — เก็บผูกกับ session เพื่ออ่านคู่กับบทสนทนาจริงตอนรีวิว
CREATE TABLE IF NOT EXISTS training_feedback (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  reviewer    TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_training_feedback_session
  ON training_feedback(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_training_candidates_review
  ON training_candidates(status, created_at);
CREATE INDEX IF NOT EXISTS idx_training_candidates_customer
  ON training_candidates(customer_id, created_at);

-- dedupe ด้วย LINE message.id — INSERT ครั้งที่สองไม่เข้า = redelivery
CREATE TABLE IF NOT EXISTS events_dedupe (
  message_id TEXT PRIMARY KEY,
  seen_at    INTEGER NOT NULL
);

-- Correction Loop v1: เก็บ candidate จากคำแก้ของคน (อนุมัติเข้า Brain Pack ภายหลัง)
CREATE TABLE IF NOT EXISTS corrections (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL,
  ai_draft           TEXT NOT NULL DEFAULT '',
  human_final        TEXT NOT NULL DEFAULT '',
  reason             TEXT NOT NULL DEFAULT '',
  source_reason      TEXT NOT NULL DEFAULT '',
  inbound_message_id TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'candidate'
                     CHECK (status IN ('candidate','approved','rejected')),
  decided_at         INTEGER,
  decided_by         TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL
);

-- Observational result only. This deliberately contains no image bytes, paths,
-- provider payload, model text, or free-form diagnostic.  One canonical inbound
-- message can have one latest result; retries replace that result idempotently.
CREATE TABLE IF NOT EXISTS inbound_image_classifications (
  message_id           TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  customer_id          TEXT NOT NULL,
  provider_message_id  TEXT NOT NULL,
  classification_state TEXT NOT NULL CHECK(classification_state IN ('classified','download_unavailable','classifier_error','classifier_disabled')),
  classified_kind      TEXT NOT NULL CHECK(classified_kind IN ('slip','document','other','unknown')),
  diagnostic_code      TEXT NOT NULL CHECK(diagnostic_code IN ('valid','disabled','no_file','read_error','no_bytes','too_large','bad_mime','no_model','model_error','unparsable','invalid_response','unavailable')),
  action               TEXT NOT NULL CHECK(action IN ('text_pipeline','human_review')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_image_classifications_customer
  ON inbound_image_classifications(customer_id, updated_at);

-- ตารางราคาที่อนุมัติแล้ว — price guard เทียบกับตารางนี้เท่านั้น (SPEC ข้อ 6)
CREATE TABLE IF NOT EXISTS approved_prices (
  label  TEXT PRIMARY KEY,
  amount REAL NOT NULL
);

-- โครงรอ follow-up engine (G1b+) — G1a สร้างตารางไว้เฉย ๆ
CREATE TABLE IF NOT EXISTS followup_state (
  customer_id  TEXT PRIMARY KEY,
  ladder_stage INTEGER NOT NULL DEFAULT 0,
  last_nudge_at INTEGER,
  nudge_count  INTEGER NOT NULL DEFAULT 0
);

-- synthetic canary (G1b: ยิงจริงเป็นรอบ ๆ + บันทึก round-trip)
CREATE TABLE IF NOT EXISTS proactive_attempts (
  customer_id TEXT NOT NULL REFERENCES customers(line_user_id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('drafting','sending','settled')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(customer_id, lane, attempt_key)
);

CREATE TABLE IF NOT EXISTS canary_state (
  id            TEXT PRIMARY KEY,
  last_probe_at INTEGER,
  last_ok_at    INTEGER,
  status        TEXT NOT NULL DEFAULT 'idle',
  detail        TEXT NOT NULL DEFAULT '',
  round_trip_ms INTEGER
);

-- G1b: บัญชี operator รายคน — เก็บเฉพาะ scrypt hash ห้ามมี plaintext เด็ดขาด
CREATE TABLE IF NOT EXISTS operators (
  username     TEXT PRIMARY KEY,
  pass_hash    TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT 'operator',
  disabled     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- v1.3: operator ปกติเห็น/ส่ง Broadcast ได้เฉพาะ OA ที่ได้รับมอบหมาย
-- role owner/admin เข้าถึงทุก OA; instance channel เดียวยังคง backward-compatible
CREATE TABLE IF NOT EXISTS operator_channels (
  username    TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (username, channel_id),
  FOREIGN KEY (username) REFERENCES operators(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_operator_channels_channel ON operator_channels(channel_id, username);

-- Owner browser push endpoints. endpoint is a provider bearer capability and
-- is never returned through console APIs or audit text. Session binding makes
-- logout/expiry/password rotation revoke delivery without a second sender.
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id                 TEXT PRIMARY KEY,
  operator_username  TEXT NOT NULL,
  endpoint           TEXT NOT NULL,
  endpoint_hash      TEXT NOT NULL UNIQUE,
  session_id_hash    TEXT NOT NULL,
  session_expires_at INTEGER NOT NULL,
  token_version      INTEGER NOT NULL DEFAULT 1,
  user_agent         TEXT NOT NULL DEFAULT '',
  enabled            INTEGER NOT NULL DEFAULT 1,
  last_success_at    INTEGER,
  last_failure_at    INTEGER,
  last_status        INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (operator_username) REFERENCES operators(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_web_push_active
  ON web_push_subscriptions(enabled,session_expires_at,operator_username);

-- Short-lived same-origin notification lookup. Customer text is never stored;
-- customer_id exists only to create the exact authenticated console deep link.
CREATE TABLE IF NOT EXISTS web_push_events (
  id                TEXT PRIMARY KEY,
  operator_username TEXT NOT NULL,
  customer_id       TEXT NOT NULL,
  channel_id        TEXT NOT NULL DEFAULT 'default',
  reason            TEXT NOT NULL DEFAULT 'inbound',
  dedupe_key        TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  FOREIGN KEY (operator_username) REFERENCES operators(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_web_push_events_operator
  ON web_push_events(operator_username,created_at);

-- G1b: audit log การกระทำใน console — ใครล็อกอิน ใครสลับ AI ใครตอบ เมื่อไร
CREATE TABLE IF NOT EXISTS admin_audit (
  id         TEXT PRIMARY KEY,
  operator   TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON admin_audit(created_at);

-- G2a (F3): interest score 0-10 ต่อลูกค้า — payload_json = JSON เต็มจาก scorer
CREATE TABLE IF NOT EXISTS score_history (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  score        INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_score_customer ON score_history(customer_id, created_at);

-- Read-only decision experiment. Never consumed by customer-facing policy.
CREATE TABLE IF NOT EXISTS jev_shadow (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, score_id TEXT NOT NULL,
  session_id TEXT NOT NULL, evidence_hash TEXT NOT NULL, policy TEXT NOT NULL,
  primary_model TEXT NOT NULL, primary_score INTEGER NOT NULL,
  model TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}',
  input_tokens INTEGER, output_tokens INTEGER, elapsed_ms INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(customer_id, session_id, evidence_hash, policy, model),
  FOREIGN KEY(score_id) REFERENCES score_history(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jev_shadow_time ON jev_shadow(created_at);

-- JEV decision review is a receipt stream. It deliberately stores only a
-- whitelisted verdict, never the customer text submitted to the provider.
CREATE TABLE IF NOT EXISTS jev_decision_reviews (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  stage TEXT NOT NULL, policy TEXT NOT NULL, model TEXT NOT NULL,
  brain_version_id TEXT NOT NULL DEFAULT '', proposed_action TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'off', action TEXT NOT NULL, status TEXT NOT NULL, confidence_10 REAL,
  result_json TEXT NOT NULL DEFAULT '{}', evidence_hash TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  elapsed_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  reviewer TEXT NOT NULL DEFAULT '', review_status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at INTEGER, review_note TEXT NOT NULL DEFAULT '',
  UNIQUE(customer_id, session_id, turn_id, stage, evidence_hash, policy, model),
  FOREIGN KEY(customer_id) REFERENCES customers(line_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jev_decision_reviews_time ON jev_decision_reviews(created_at);

-- Owner labels on retrospective manifests.  They are inert human feedback:
-- no pipeline, knowledge, or customer-facing path reads this table.
CREATE TABLE IF NOT EXISTS jev_audit_feedback (
  batch_id TEXT NOT NULL, case_id TEXT NOT NULL, evidence_hash TEXT NOT NULL,
  customer_id TEXT NOT NULL, stop_label TEXT, notify_label TEXT,
  note TEXT NOT NULL DEFAULT '', reviewer TEXT NOT NULL, reviewed_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  event_at INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT 'default', anchor_message_id TEXT NOT NULL DEFAULT '',
  stop_choice TEXT NOT NULL DEFAULT '', notify_choice TEXT NOT NULL DEFAULT '',
  original_stop TEXT NOT NULL DEFAULT 'unknown', original_notify TEXT NOT NULL DEFAULT 'unknown',
  stop_confidence_10 REAL, notify_confidence_10 REAL, complaint_choice TEXT NOT NULL DEFAULT '', complaint_confidence_10 REAL,
  reason_choice TEXT NOT NULL DEFAULT '',
  comparison_json TEXT NOT NULL DEFAULT '{}', event_kinds_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (batch_id, case_id, evidence_hash),
  FOREIGN KEY(customer_id) REFERENCES customers(line_user_id) ON DELETE CASCADE,
  CHECK(stop_label IS NULL OR stop_label IN ('correct','incorrect')),
  CHECK(notify_label IS NULL OR notify_label IN ('correct','incorrect'))
);
CREATE INDEX IF NOT EXISTS idx_jev_audit_feedback_customer ON jev_audit_feedback(customer_id);
CREATE INDEX IF NOT EXISTS idx_jev_audit_feedback_batch ON jev_audit_feedback(batch_id,case_id);

-- G2a (F5): follow-up engine v1 — นัดทักลูกค้าที่แอดมินตั้งจาก console
CREATE TABLE IF NOT EXISTS followups (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','sent','cancelled','skipped')),
  created_by   TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  detail       TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_followups_customer ON followups(customer_id, created_at);

-- G2a: runtime settings (เช่นสวิตช์ follow-up global) + ตัวนับ metric (key ขึ้นต้น metric:)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Durable erasure ledger for restore. It deliberately stores only a
-- domain-separated hash, never a raw LINE/provider identity.
CREATE TABLE IF NOT EXISTS customer_tombstones (
  line_user_id_hash TEXT PRIMARY KEY,
  forgotten_at      INTEGER NOT NULL,
  reason            TEXT NOT NULL DEFAULT 'pdpa_request'
);
CREATE INDEX IF NOT EXISTS idx_customer_tombstones_time
  ON customer_tombstones(forgotten_at);

-- G2b (B6): บันทึกส่งต่อหลายแถวต่อลูกค้า — โน้ตคนเขียน + โน้ต ai_auto จาก scorer
CREATE TABLE IF NOT EXISTS handoff_notes (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  author      TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoff_notes_customer ON handoff_notes(customer_id, created_at);

-- G2b (B8): บันทึก token usage ทุก call ที่ Hermes ตอบ usage มา (คิดค่าใช้จ่าย AI)
-- v1.4.9: เพิ่ม 'staged_followup' — CHECK เดิมปัดแถวของ FU ตามสเตจตกแบบเงียบตั้งแต่
-- v1.4.6 (catch กลืน error) ทำให้ต้นทุน follow-up ไม่เคยถูกบันทึก
-- 5 ต.ค. 2026: เพิ่ม 'qualify' (ตัวกวาดคัดกรองลูกค้ารายชั่วโมง) — DB เดิม rebuild ที่ migrateLlmUsageQualifyKind ใน db.mjs
-- 12 ต.ค. 2026: เพิ่ม 'offtopic_check' (Luna ยืนยันก่อนตีจบแชทนอกเรื่อง) — rebuild ด้วยฟังก์ชันเดียวกัน
-- 12 ต.ค. 2026 ค่ำ: เพิ่ม 'owner_review' (Luna อ่านท่าทีห้องให้รอบตรวจของเจ้าของ — เพดานของตัวเอง ฿40/วัน)
CREATE TABLE IF NOT EXISTS llm_usage (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL CHECK (kind IN ('draft','score','followup','staged_followup','learning','qualify','offtopic_check','owner_review')),
  model       TEXT NOT NULL DEFAULT '',
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cached_in   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_time ON llm_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_customer ON llm_usage(customer_id, created_at);

-- G3: คลังความรู้ที่ทีมงานเพิ่มเองจาก console — ฉีดเข้า prompt ก่อนตอบ (เฉพาะ active)
-- ราคายังคุมด้วย approved_prices + compliance guard เสมอ (ความรู้ข้าม guard ไม่ได้)
-- G6 (P1): channel_id NULL = สมองกลาง (ทุกสาขาโหมด shared เห็น) /
-- = channel id หนึ่ง ๆ = ความรู้เฉพาะสาขาที่เปิดโหมด "สมองแยก" (ดู knowledgePack.mjs)
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  active          INTEGER NOT NULL DEFAULT 1,
  updated_by      TEXT NOT NULL DEFAULT '',
  channel_id      TEXT,
  source          TEXT NOT NULL DEFAULT 'human_console',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  supersedes_id   TEXT,
  superseded_by   TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  deleted_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Daily learning is deliberately a proposal queue. The digest can create only
-- proposed rows; a human console decision is the sole path into knowledge_entries.
CREATE TABLE IF NOT EXISTS learning_candidates (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  day_key         TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'correction'
                  CHECK (kind IN ('correction','cluster')),
  cluster_key     TEXT NOT NULL UNIQUE,
  channel_id      TEXT,
  title           TEXT NOT NULL DEFAULT '',
  proposed_content TEXT NOT NULL DEFAULT '',
  evidence_json   TEXT NOT NULL DEFAULT '[]',
  conflict_json   TEXT NOT NULL DEFAULT '[]',
  risk_flags_json TEXT NOT NULL DEFAULT '[]',
  knowledge_digest TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','approved','rejected','sent_to_lab')),
  decided_by      TEXT NOT NULL DEFAULT '',
  decided_at      INTEGER,
  applied_entry_id TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learning_candidates_status
  ON learning_candidates(status, created_at);
CREATE INDEX IF NOT EXISTS idx_learning_candidates_day
  ON learning_candidates(day_key, created_at);

CREATE TABLE IF NOT EXISTS learning_runs (
  id                 TEXT PRIMARY KEY,
  day_key            TEXT NOT NULL,
  signals_found      INTEGER NOT NULL DEFAULT 0,
  clusters           INTEGER NOT NULL DEFAULT 0,
  llm_calls          INTEGER NOT NULL DEFAULT 0,
  tokens_in          INTEGER NOT NULL DEFAULT 0,
  tokens_out         INTEGER NOT NULL DEFAULT 0,
  usd                REAL NOT NULL DEFAULT 0,
  candidates_created INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','complete','skipped_no_activity','failed')),
  knowledge_digest   TEXT NOT NULL DEFAULT '',
  detail             TEXT NOT NULL DEFAULT '',
  mode               TEXT NOT NULL DEFAULT 'deterministic_fallback',
  hedge_rate         REAL NOT NULL DEFAULT 0,
  promise_notes_per_100 REAL NOT NULL DEFAULT 0,
  operator_override_per_100 REAL NOT NULL DEFAULT 0,
  knowledge_chars    INTEGER NOT NULL DEFAULT 0,
  cache_hit_rate     REAL NOT NULL DEFAULT 0,
  probe_count        INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  completed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_learning_runs_time ON learning_runs(created_at);

-- G3: ผลตรวจสลิปอัตโนมัติ (pre-check ให้แอดมินเท่านั้น — บอทไม่เคยยืนยันยอดกับลูกค้า)
CREATE TABLE IF NOT EXISTS slip_checks (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  message_id   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','valid','suspect','error')),
  amount       REAL,
  trans_ref    TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slip_checks_customer ON slip_checks(customer_id, created_at);

-- G6 (P2): ออเดอร์ v1 — AI สร้างได้เฉพาะ "ร่าง" (draft) ให้แอดมินดู ห้ามคุยเงินกับลูกค้าเอง
-- items_json = [{name, qty, price|null}] (price null = ยังไม่ตรงตาราง approved_prices)
-- total NULL = ยังไม่ระบุยอด; slip_check_id = ผลตรวจสลิปที่ระบบจับคู่ให้ (best effort)
-- เลขออเดอร์ที่คนอ่าน (#N) = rowid — ทุก SELECT ฝั่ง db ดึง rowid AS order_no
CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  channel_id    TEXT NOT NULL DEFAULT 'default',
  items_json    TEXT NOT NULL DEFAULT '[]',
  total         REAL,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','confirmed','paid','shipped','done','cancelled')),
  note          TEXT NOT NULL DEFAULT '',
  shipping_json TEXT NOT NULL DEFAULT '',
  shipping_source TEXT NOT NULL DEFAULT '',
  slip_check_id TEXT,
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, updated_at);

-- v1.1 (item 7): chat tag ต่อลูกค้า — source: 'rfm' (ระบบคำนวณจากออเดอร์จริง ลบ/สร้างใหม่ได้),
-- 'ai' (scorer อ่าน intent จากบทสนทนา), 'human' (แอดมินติดเอง — ระบบห้ามลบ)
-- ใช้ต่อยอด broadcast segment + กติกาสินค้าใน prompt (ดู tags.mjs)
CREATE TABLE IF NOT EXISTS customer_tags (
  customer_id TEXT NOT NULL,
  tag         TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('rfm','ai','human')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (customer_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags(tag);

-- v1.4.9c (พี่ง้วงอนุมัติ 2026-08-17): ทะเบียน tag มาตรฐาน + sync เว็บ->LINE OA
-- canonical_key = ชื่อ tag ใน chassis (bare = green-label ตรงกับ LINE / มี prefix "group/" =
-- chassis-only). sync_to_line=1 + line_tag_id != null = "managed namespace" ที่ push ขึ้น LINE
CREATE TABLE IF NOT EXISTS tag_registry (
  canonical_key  TEXT PRIMARY KEY,
  display_name   TEXT NOT NULL DEFAULT '',
  tag_group      TEXT NOT NULL DEFAULT '',
  source_default TEXT NOT NULL DEFAULT 'human',
  sync_to_line   INTEGER NOT NULL DEFAULT 0,
  line_tag_id    TEXT,
  line_bot_id    TEXT NOT NULL DEFAULT '',
  color          TEXT NOT NULL DEFAULT '',
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tag_registry_sync ON tag_registry(sync_to_line, line_bot_id);

-- สถานะ sync ต่อลูกค้า — idempotency ด้วย last_pushed_hash (ไม่ push ซ้ำถ้าไม่เปลี่ยน)
CREATE TABLE IF NOT EXISTS tag_sync_state (
  customer_id      TEXT NOT NULL,
  line_bot_id      TEXT NOT NULL DEFAULT '',
  last_pushed_hash TEXT NOT NULL DEFAULT '',
  -- JSON array ของ managed tagId ที่ chassis เคย push ให้ห้องนี้ — ใช้ตัดสินว่า tag ไหน
  -- "chassis เป็นเจ้าของ" (ลบได้) vs "ทีมติดเองใน LINE" (สงวน). กัน tag ทีมหายยกแถว
  last_pushed_ids  TEXT NOT NULL DEFAULT '[]',
  last_synced_at   INTEGER,
  last_error       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (customer_id, line_bot_id)
);

-- v1.2 (พี่ง้วงสั่ง 2026-08-10): บรอดแคสตาม segment (include/exclude tag) ต่อสาขา
-- audience คำนวณสดตอนกด (ตัด do_not_disturb/canary เสมอ); ส่งผ่าน LINE multicast
-- ทุกการส่งเป็นการกดของคนใน console + confirm (ไม่มีเส้นทางอัตโนมัติ)
CREATE TABLE IF NOT EXISTS broadcasts (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL DEFAULT 'default',
  messages_json     TEXT NOT NULL DEFAULT '[]',
  include_tags_json TEXT NOT NULL DEFAULT '[]',
  exclude_tags_json TEXT NOT NULL DEFAULT '[]',
  audience_count    INTEGER NOT NULL DEFAULT 0,
  sent_count        INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  last_sent_index   INTEGER NOT NULL DEFAULT -1,
  status            TEXT NOT NULL DEFAULT 'sending'
                    CHECK (status IN ('sending','partial','done','failed')),
  last_error        TEXT NOT NULL DEFAULT '',
  cancel_requested_at INTEGER,
  cancel_requested_by TEXT NOT NULL DEFAULT '',
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broadcasts_time ON broadcasts(created_at);

-- Immutable recipient ledger. The queue row and every recipient are committed
-- together before any provider call, then updated only at batch boundaries.
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  line_user_id TEXT NOT NULL,
  batch_no INTEGER NOT NULL DEFAULT -1,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','failed','skipped','cancelled')),
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (broadcast_id, line_user_id)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_status
  ON broadcast_recipients(broadcast_id, status);

-- Provider 0/5xx/network exceptions are not proof of rejection: LINE may have
-- accepted the multicast before the response was lost. Preserve that ambiguity
-- durably and block the exact OA+audience from another send until an operator
-- records an explicit reconciliation outcome. No legacy row is rewritten.
CREATE TABLE IF NOT EXISTS broadcast_delivery_quarantines (
  id                   TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL,
  audience_fingerprint TEXT NOT NULL,
  broadcast_id         TEXT NOT NULL UNIQUE REFERENCES broadcasts(id) ON DELETE RESTRICT,
  batch_no             INTEGER NOT NULL,
  retry_key_hash       TEXT NOT NULL,
  provider_status      INTEGER NOT NULL DEFAULT 0,
  failure_kind         TEXT NOT NULL CHECK (failure_kind IN ('status_0','server_error','exception','ambiguous')),
  attempted_count      INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  resolved_at          INTEGER,
  resolved_by          TEXT NOT NULL DEFAULT '',
  resolution           TEXT NOT NULL DEFAULT ''
                     CHECK (resolution IN ('','confirmed_delivered','confirmed_not_delivered'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_delivery_quarantine_open
  ON broadcast_delivery_quarantines(channel_id, audience_fingerprint)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_broadcast_delivery_quarantine_broadcast
  ON broadcast_delivery_quarantines(broadcast_id);

-- Exact attempted recipients remain separate from the ordinary recipient
-- status CHECK, so an additive migration can express "unknown" honestly.
CREATE TABLE IF NOT EXISTS broadcast_delivery_unknown_recipients (
  quarantine_id TEXT NOT NULL REFERENCES broadcast_delivery_quarantines(id) ON DELETE RESTRICT,
  broadcast_id  TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE RESTRICT,
  line_user_id  TEXT NOT NULL,
  batch_no      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (quarantine_id, line_user_id)
);
CREATE INDEX IF NOT EXISTS idx_broadcast_delivery_unknown_broadcast
  ON broadcast_delivery_unknown_recipients(broadcast_id);

-- มีได้เพียงงานส่งเดียวต่อ OA ในเวลาเดียวกัน. แถวนี้เป็น DB-level claim
-- ไม่ใช่ lock ใน memory จึงกัน POST พร้อมกันข้าม process ได้ด้วย.
CREATE TABLE IF NOT EXISTS broadcast_channel_claims (
  channel_id   TEXT PRIMARY KEY,
  broadcast_id TEXT NOT NULL UNIQUE REFERENCES broadcasts(id) ON DELETE CASCADE,
  owner_token  TEXT NOT NULL,
  claimed_at   INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL
);

-- B-13: durable intent to broadcast later. This is deliberately separate from
-- broadcasts: a broadcasts row means a concrete send attempt whose recipient
-- ledger and channel lease have already been committed. Scheduling never writes
-- that table and therefore cannot accidentally look like a provider attempt.
CREATE TABLE IF NOT EXISTS broadcast_schedules (
  id                         TEXT PRIMARY KEY,
  channel_id                 TEXT NOT NULL DEFAULT 'default',
  messages_json              TEXT NOT NULL DEFAULT '[]',
  include_tags_json          TEXT NOT NULL DEFAULT '[]',
  exclude_tags_json          TEXT NOT NULL DEFAULT '[]',
  scheduled_at               INTEGER NOT NULL,
  preview_count              INTEGER NOT NULL DEFAULT 0,
  audience_fingerprint       TEXT NOT NULL,
  confirmation_hash          TEXT NOT NULL,
  confirmation_expires_at    INTEGER NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'scheduled'
                             CHECK (status IN ('scheduled','preparing','dispatched','cancelled','failed')),
  broadcast_id               TEXT UNIQUE REFERENCES broadcasts(id) ON DELETE SET NULL,
  preparing_owner_token      TEXT NOT NULL DEFAULT '',
  preparing_lease_expires_at INTEGER NOT NULL DEFAULT 0,
  preparing_at               INTEGER,
  dispatched_at              INTEGER,
  cancelled_at               INTEGER,
  failed_at                  INTEGER,
  cancel_requested_at        INTEGER,
  cancel_requested_by        TEXT NOT NULL DEFAULT '',
  quiet_deferred_count       INTEGER NOT NULL DEFAULT 0,
  last_quiet_deferred_at     INTEGER,
  last_failure_phase         TEXT NOT NULL DEFAULT '',
  last_error                 TEXT NOT NULL DEFAULT '',
  created_by                 TEXT NOT NULL DEFAULT '',
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broadcast_schedules_due
  ON broadcast_schedules(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_schedules_channel
  ON broadcast_schedules(channel_id, status, scheduled_at);
-- A preview confirmation is a single-use human approval envelope. This UNIQUE
-- index is the atomic consume boundary across concurrent chassis processes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_schedules_confirmation_hash
  ON broadcast_schedules(confirmation_hash);

-- B-12: ปลายทาง "ส่งทดสอบให้ตัวเอง" แยกจากรายชื่อลูกค้า/segment โดยเด็ดขาด.
-- LINE user id อยู่เฉพาะตาราง private นี้ และไม่มี endpoint ใดคืนค่านี้กลับ browser/audit.
-- challenge เก็บ hash เท่านั้น: ผู้ใช้ต้องส่งข้อความ challenge ตรงตัวเข้ามาจาก OA เดียวกัน
-- ภายใน 5 นาที จึง bind ปลายทางต่อ operator + OA ได้หนึ่งครั้ง.
CREATE TABLE IF NOT EXISTS broadcast_self_test_challenges (
  id                TEXT PRIMARY KEY,
  operator_username TEXT NOT NULL,
  session_hash      TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  challenge_hash    TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  consumed_at       INTEGER,
  consumed_by       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_broadcast_self_test_challenge_match
  ON broadcast_self_test_challenges(channel_id, challenge_hash, expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS broadcast_self_test_destinations (
  operator_username TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  session_hash      TEXT NOT NULL,
  line_user_id      TEXT NOT NULL,
  verified_at       INTEGER NOT NULL,
  PRIMARY KEY (operator_username, channel_id)
);

-- v1.3: รูปที่ operator อัปโหลดเพื่อใช้ในบรอดแคส
-- ไฟล์จริงอยู่นอก DB ใน MEDIA_DIR; ตารางนี้เป็น allowlist เดียวของ public /media/*
CREATE TABLE IF NOT EXISTS media_assets (
  id          TEXT PRIMARY KEY,
  asset_key   TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png')),
  byte_size   INTEGER NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  sha256      TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_media_assets_status ON media_assets(status, created_at);

-- v1.4 Lifecycle (แผน ARCHITECTURE_LIFECYCLE_PROFILES.md เฟส 1 — additive ทั้งหมด):
-- ความจำแบบมีโครงสร้างที่รอด /reset — วันนี้ความเข้าใจลูกค้าคำนวณสดจาก regex
-- บนประวัติทุกเทิร์นแล้วตายพร้อม /reset
-- ข้อเท็จจริงต่อลูกค้า มีที่มาเสมอ: precedence human > deterministic > scorer
CREATE TABLE IF NOT EXISTS customer_facts (
  customer_id TEXT NOT NULL,
  fact_key    TEXT NOT NULL,
  value       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL CHECK (source IN ('human','deterministic','scorer')),
  evidence    TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (customer_id, fact_key)
);

-- append-only: ทุกการเลื่อนสถานะทั้งสองแกน ใคร/อะไรเป็นคนเลื่อน พร้อมหลักฐาน
CREATE TABLE IF NOT EXISTS lifecycle_events (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  from_stage  TEXT NOT NULL,
  to_stage    TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  trigger     TEXT NOT NULL DEFAULT '',
  actor       TEXT NOT NULL DEFAULT 'system',
  evidence    TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_customer ON lifecycle_events(customer_id, created_at);

-- ประวัติเรียนที่ "คนยืนยัน" เท่านั้น — สิ่งเดียวที่มีสิทธิ์บอกว่าลูกค้าเก่า
-- (ป้อน hook verifiedLearningFor ที่เปิดรอไว้ใน pipeline โดยไม่แก้ salesPolicy)
CREATE TABLE IF NOT EXISTS enrollments (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  course_id    TEXT NOT NULL,
  round_date   TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','completed','cancelled')),
  confirmed_by TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrollments_customer ON enrollments(customer_id, created_at);

-- แยกจาก followups เด็ดขาด: engine ส่งจริงอ่านเฉพาะ followups status='pending'
-- จึง "ไม่มีเส้นทางที่เครื่องส่ง suggestion ได้เลยโดยโครงสร้าง" — คนอนุมัติค่อยย้ายข้าม
CREATE TABLE IF NOT EXISTS followup_suggestions (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  deal_status  TEXT NOT NULL DEFAULT '',
  step         INTEGER NOT NULL DEFAULT 1,
  template_key TEXT NOT NULL DEFAULT '',
  draft_text   TEXT NOT NULL DEFAULT '',
  suggested_at INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'suggested'
               CHECK (status IN ('suggested','approved','dismissed','expired')),
  resolved_by  TEXT NOT NULL DEFAULT '',
  resolved_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followup_suggestions_status ON followup_suggestions(status, suggested_at);

-- ค่าแอด Meta รายวัน (Make ยิงเข้ามาทุกเช้า 05:00 ด้วยยอดของ "เมื่อวาน")
-- เก็บรายวันไม่ใช่ก้อนเดียว เพราะหน้า ROAS เลือกช่วงได้ทั้งรายวัน 7 วัน และ 30 วัน
-- day = วันที่แบบเวลาไทย (YYYY-MM-DD) เป็น primary key -> ยิงซ้ำวันเดิมคือทับ ไม่ใช่บวกเพิ่ม
CREATE TABLE IF NOT EXISTS ads_spend (
  day        TEXT PRIMARY KEY,
  spend_thb  REAL NOT NULL DEFAULT 0,
  account_id TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT 'make',
  raw_json   TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- publish_requests — คิว "ขออนุมัติเผยแพร่" (Package K, คำสั่งพี่ง้วง 2 ก.ย. 2026)
--
-- ที่มา: Package C ทำให้ราคา/สมอง/กติกา/รอบเรียน/คลังความรู้ เป็นสิทธิ์เจ้าของคนเดียว
-- ผลข้างเคียงคือทีมงานเจอ 403 แล้วต้องไปตามพี่ง้วงเอง ตารางนี้เก็บ "คำขอ" ไว้แทน
-- แล้วให้เจ้าของกดอนุมัติ = ระบบเล่นคำขอนั้นซ้ำด้วยตัวตนของเจ้าของ
--
-- กติกาเหล็ก: ห้ามมีคอลัมน์ customer_id หรือ line_user_id ในตารางนี้เด็ดขาด
--   คำขอเป็นเรื่องของ "ของที่เข้าไปในสมองบอท" ไม่ใช่ข้อมูลลูกค้า
--   (test/pdpa-cascade.test.mjs ไล่ตารางจาก schema เอง — ใส่คอลัมน์นั้นเมื่อไร
--    ตารางนี้จะถูกลากเข้าเส้นทางลบข้อมูลลูกค้าทันทีโดยไม่มีใครตั้งใจ)
--
-- claimed_at = ธงกันอนุมัติซ้ำ ตั้งด้วย UPDATE เงื่อนไขเดียวที่เป็น atomic ของ SQLite
--   (status ยังเป็น pending ระหว่าง replay — ถ้าโปรเซสตายกลางคัน แถวจะค้าง pending
--    ที่กดอนุมัติไม่ได้อีก = fail-closed ไม่มีการเผยแพร่ครึ่ง ๆ กลาง ๆ ให้ต้องเดา)
CREATE TABLE IF NOT EXISTS publish_requests (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  method        TEXT NOT NULL,
  route_json    TEXT NOT NULL DEFAULT '[]',
  body_json     TEXT NOT NULL DEFAULT '{}',
  summary       TEXT NOT NULL DEFAULT '',
  proposed_by   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','failed')),
  claimed_at    INTEGER NOT NULL DEFAULT 0,
  decided_by    TEXT NOT NULL DEFAULT '',
  decided_at    INTEGER,
  decision_note TEXT NOT NULL DEFAULT '',
  result_json   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_requests_status
  ON publish_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_publish_requests_proposer
  ON publish_requests(proposed_by, created_at);

-- inbound_turn_outcomes — "บันทึกผลลัพธ์ของเทิร์นขาเข้า" ไม่ใช่คิวงาน
--
-- กติกาเหล็กของตารางนี้ (ห้ามละเมิดโดยเด็ดขาด):
--   ห้ามมีโค้ดบรรทัดใดอ่านตารางนี้แล้วเรียก pipeline.handleEvent หรือ sendBubbles
--   ผู้อ่านที่อนุญาต: คอนโซล, digest, รายงาน, retention เท่านั้น
--   นี่คือสิ่งเดียวที่ทำให้ "ห้ามส่งซ้ำ" เป็นคุณสมบัติเชิงโครงสร้าง ไม่ใช่กติกาที่ต้องระวัง
--   บังคับใช้ด้วย test/inbound-turn-outcomes.test.mjs (T-07) — ห้ามลบเทสต์นั้น
--
-- ชื่อสถานะจงใจไม่ใช้ pending/queued/retry เพื่อไม่ให้ใครในอนาคตเข้าใจผิดว่าเป็นคิว
CREATE TABLE IF NOT EXISTS inbound_turn_outcomes (
  message_id   TEXT PRIMARY KEY,          -- = messages.id คือ 'in:<dedupeKey>'
  customer_id  TEXT NOT NULL,
  channel_id   TEXT NOT NULL DEFAULT 'default',
  channel_kind TEXT NOT NULL DEFAULT 'line',   -- 'line' | 'facebook'
  status       TEXT NOT NULL DEFAULT 'owed'
    CHECK (status IN ('owed','sending','answered','silent_by_design',
                      'stranded_shutdown','stranded_ambiguous',
                      'stranded_crash','stranded_error')),
  reason       TEXT NOT NULL DEFAULT '',
  process_id   TEXT NOT NULL DEFAULT '',   -- boot id ของโปรเซสที่รับเทิร์นนี้ไว้
  created_at   INTEGER NOT NULL,           -- เวลาข้อความลูกค้า
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_turn_outcomes_open
  ON inbound_turn_outcomes(status, created_at);
CREATE INDEX IF NOT EXISTS idx_inbound_turn_outcomes_customer
  ON inbound_turn_outcomes(customer_id, created_at);

-- owner_lessons — "สอนลูกแพรจากแผง 'ทำไมตอบแบบนี้'" (คำสั่งพี่ง้วง 2026-09-28)
-- บทเรียน = คำลูกค้าที่นำไปสู่คำตอบ + คำตอบเดิมของลูกแพร + สิ่งที่คนสอน
-- ตอนร่างคำตอบ บทเรียนที่ใกล้เรื่องที่สุดถูกแนบท้ายพรอมต์ (src/ownerLessons.mjs)
--   channel_id NULL        = ใช้ทุกช่องทาง
--   status                 = active (ลูกแพรใช้) | pending (รอเจ้าของอนุมัติ) | disabled (ปิดไว้)
--   teaching_key           = คำสอนที่ปรับรูปแล้ว ใช้กันบันทึกซ้ำ (unique ต่อช่องทาง)
--   customer_id / source_message_id = ตัวชี้ห้องต้นเรื่อง มีไว้ให้ "สิทธิ์ให้ลืม" หาเจอ
--     resetCustomer ล้าง customer_text/ai_text/ตัวชี้ทิ้ง แต่คำสอนอยู่ต่อ (เป็นของธุรกิจ)
CREATE TABLE IF NOT EXISTS owner_lessons (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT,
  customer_text     TEXT NOT NULL DEFAULT '',
  ai_text           TEXT NOT NULL DEFAULT '',
  teaching          TEXT NOT NULL,
  teaching_key      TEXT NOT NULL DEFAULT '',
  topic             TEXT NOT NULL DEFAULT '',
  source_message_id TEXT NOT NULL DEFAULT '',
  customer_id       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('active','pending','disabled')),
  created_by        TEXT NOT NULL DEFAULT '',
  decided_by        TEXT NOT NULL DEFAULT '',
  decided_at        INTEGER,
  use_count         INTEGER NOT NULL DEFAULT 0,
  last_used_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_lessons_status ON owner_lessons(status, decided_at);
CREATE INDEX IF NOT EXISTS idx_owner_lessons_customer ON owner_lessons(customer_id);
CREATE INDEX IF NOT EXISTS idx_owner_lessons_source ON owner_lessons(source_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_lessons_teaching
  ON owner_lessons(teaching_key, IFNULL(channel_id, ''));

-- owner_chat_turns — "คุยกับลูกแพร" ทาง Telegram ของพี่ง้วง (คำสั่งพี่ง้วง 28 ก.ย. 2026)
-- ความจำสั้นของแชทเจ้าของ↔ลูกแพร (ไม่ใช่ข้อมูลรายลูกค้า — ไม่มี customer_id โดยเจตนา)
--   exchange_id = คู่ "พี่ง้วงพิมพ์ + ลูกแพรตอบ" ลบก็ลบทั้งคู่
--   owner_ref   = hash ของบัญชี Telegram ที่จับคู่ (จับคู่คนใหม่ = ไม่เห็นความจำของคนเก่า)
-- เก็บไม่เกิน 200 เทิร์น/30 วัน ตัดเองทุกครั้งที่เขียนและอ่าน (src/dbOwnerChat.mjs)
CREATE TABLE IF NOT EXISTS owner_chat_turns (
  id          TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL,
  owner_ref   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_chat_turns_owner ON owner_chat_turns(owner_ref, created_at);
CREATE INDEX IF NOT EXISTS idx_owner_chat_turns_exchange ON owner_chat_turns(exchange_id);
`
// DDL ของสมอง (เฟส 1a) แยกไฟล์ไว้เพื่อคุมขนาดไฟล์นี้ < 800 บรรทัด — ต่อเป็นสตริงเดียว
// แล้ว exec ครั้งเดียวตอนเปิดฐาน (ไม่ใช่ migration แยกเส้น)
  + BRAIN_SCHEMA
  + LINE_USAGE_SCHEMA
  + IDENTITY_LINK_SCHEMA
  + BROADCAST_STUDIO_SCHEMA
  + STEP_MESSAGES_SCHEMA
  + AD_REFERRAL_SCHEMA
  + META_CAPI_SCHEMA;
// 12 ต.ค. 2026 ค่ำ: ตารางห้องตรวจของพี่ง้วง (owner_review_batches / owner_close_proposals) ไม่อยู่ในชุดนี้โดยเจตนา —
// dbOwnerReview.mjs สร้างตอนเขียนครั้งแรก (แบบ trial_invites) ฐานที่ยังไม่เคยตรวจจึงมีโครงตารางเท่าเดิมทุกตาราง
