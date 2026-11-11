// brain/schema.mjs — DDL ของสมองที่มีเวอร์ชัน (เฟส 1a)
//
// แยกไฟล์จาก src/schema.mjs เพื่อคุมขนาดไฟล์ < 800 บรรทัด — ตัวสตริงถูกต่อเข้ากับ SCHEMA
// แล้ว exec ครั้งเดียวตอนเปิดฐาน (ดู src/schema.mjs) ไม่ใช่ migration แยกเส้น
//
// เฟส 1a สร้างตารางไว้ "ข้าง ๆ" ทางเดิมเท่านั้น: ยังไม่มีโค้ดเส้นตอบลูกค้าอ่านตารางพวกนี้
// เลยแม้แต่ไบต์เดียว (ทางอ่านจริงเปิดใน P2 ด้วยแฟล็ก BRAIN_READ ตามแผนย้าย §11)
//
// ตารางการ์ด (brain_item_revs / brain_versions / redactions) ไม่มีคอลัมน์ customer_id /
// message_id / line_user_id โดยเจตนา — การ์ดคือ "ความรู้ของธุรกิจ" ไม่ใช่ข้อมูลลูกค้า
// การ์ดที่เกิดจากคำแก้ของลูกค้ารายหนึ่งเก็บได้เฉพาะ provenance.customer_hash แล้วลบด้วย
// redactions — ไม่มีวันเก็บ id ดิบ
//
// เฟส 3 เพิ่มสามตาราง (golden_turns / eval_baselines / gate_runs) และ **หนึ่งในนั้นผูกกับ
// ข้อความลูกค้าจริง**: golden_turns.message_ref ชี้ messages.id ตรง ๆ (แบบแปลน §5) จึงเข้า
// resetCustomer(forget) ใน commit เดียวกับที่สร้างตาราง และ test/pdpa-cascade.test.mjs
// ถูกขยายให้ไล่คอลัมน์ message_ref/message_id จาก PRAGMA เอง ไม่ใช่จากลิสต์ที่คนเขียนค้างไว้

// คอลัมน์ทุกตัวที่ "ห้ามขยับ" ตอน redact — ใช้ซ้ำในสอง WHEN เพื่อไม่ให้ลืมตัวใดตัวหนึ่ง
// (เขียนเป็นสตริงเดียวแล้ว interpolate: SQLite ไม่มีตัวแปรใน trigger ให้ใช้)
const IMMUTABLE_EXCEPT_BODY_AND_REDACTED = `
     NEW.rev_id = OLD.rev_id AND NEW.item_id = OLD.item_id AND NEW.kind = OLD.kind
     AND NEW.key = OLD.key AND NEW.body_sha256 = OLD.body_sha256
     AND NEW.scope_json = OLD.scope_json
     AND NEW.inject = OLD.inject AND NEW.priority = OLD.priority AND NEW.locked = OLD.locked
     AND NEW.confidence = OLD.confidence
     AND NEW.valid_from IS OLD.valid_from AND NEW.valid_until IS OLD.valid_until
     AND NEW.supersedes_rev IS OLD.supersedes_rev
     AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at`;

// DDL ของตาราง revision — เป็นฟังก์ชันเพราะการอัปเกรดสคีมาต้องสร้างตารางชื่อชั่วคราว
// ด้วยนิยามเดียวกันเป๊ะ แล้วคัดลอกข้อมูลข้าม (SQLite แก้ NOT NULL/CHECK ตรง ๆ ไม่ได้)
export function brainItemRevsDdl(tableName) {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
  rev_id          TEXT NOT NULL PRIMARY KEY,
  item_id         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('product','fact','price','schedule','policy',
                                                'persona_section','template','channel_addendum','media','banned_phrase')),
  key             TEXT NOT NULL,             -- คีย์คงที่ของการ์ด เช่น price:ai-agent-business:normal
  scope_json      TEXT NOT NULL DEFAULT '{}',-- {product,subject,channel} — ดู src/brain/import.mjs
  body_json       TEXT NOT NULL,             -- เก็บหลัง normalizeThai แล้ว; ถูกแทนด้วย tombstone เมื่อ redact
  body_sha256     TEXT NOT NULL,             -- sha ของ body ต้นฉบับ (คงไว้แม้ redact เพื่อให้ tree_sha256 ไม่เปลี่ยน)
  redacted        INTEGER NOT NULL DEFAULT 0,
  inject          TEXT NOT NULL DEFAULT 'pin' CHECK (inject IN ('pin','retrieve','never')),
  priority        INTEGER NOT NULL DEFAULT 50,
  locked          INTEGER NOT NULL DEFAULT 0,
  confidence      TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (confidence IN ('confirmed','seen_once','needs_owner_confirm')),
  valid_from      INTEGER,
  valid_until     INTEGER,
  supersedes_rev  TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);`;
}

// รุ่นของสคีมาสมอง — ขยับเมื่อ trigger/ดัชนี/นิยามตารางเปลี่ยน
// 1 = ชุดแรก (a024b2d9): rev_id ยอมรับ NULL, ไม่มี trigger กัน INSERT OR REPLACE,
//     ไม่มี unique index บน seq
// 2 = trigger append-only ครบ + unique index
// 3 = เฟส 3: golden_turns / eval_baselines / gate_runs (ชุดปัจจุบัน)
export const BRAIN_SCHEMA_VERSION = 3;
export const BRAIN_SCHEMA_SETTING = "brain_schema_version";

export const BRAIN_SCHEMA = `
/* ============================ Brain (Phase 1a) ============================= */

-- brain_item_revs — revision ของการ์ด (append-only)
--
-- "การ์ด" ไม่มีตารางของตัวเอง: card = ทุกแถวที่ item_id เดียวกัน แถวใหม่สุดคือค่าปัจจุบัน
-- (แบบแปลน §5 ตัดตาราง cards/pointer ทิ้งโดยเจตนา — ตารางน้อย = cascade น้อย = พังยาก)
--
-- rev_id เป็น TEXT NOT NULL ด้วย ไม่ใช่แค่ PRIMARY KEY: ใน rowid table ของ SQLite
-- คอลัมน์ PRIMARY KEY ที่เป็น TEXT ยอมรับ NULL ได้ ถ้าปล่อยไว้ เงื่อนไข NEW.rev_id =
-- OLD.rev_id ใน trigger จะกลายเป็น NULL แล้ว NOT(NULL) = NULL = trigger ไม่ยิง
--
-- CHECK ของ kind ใส่ครบทั้ง 10 ชนิดตามแบบแปลนตั้งแต่วันแรก เพราะ SQLite แก้ CHECK
-- ตรง ๆ ไม่ได้ (ต้อง rebuild ตาราง) — เฟส 1a ใช้จริงแค่ 5 ชนิดแรก และตัวช่วยเขียน
-- ใน src/brain/store.mjs ปฏิเสธชนิดที่เหลือ จนกว่า P4 จะเปิด
${brainItemRevsDdl("brain_item_revs")}
CREATE INDEX IF NOT EXISTS idx_brain_item_revs_item ON brain_item_revs(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_brain_item_revs_kind ON brain_item_revs(kind, key);

-- INSERT OR REPLACE / REPLACE INTO คือช่องโหว่จริงของ append-only: SQLite แก้ conflict
-- ด้วยการ "ลบแถวเดิมแล้วแทรกใหม่" ซึ่งเลี่ยง BEFORE DELETE trigger ได้เมื่อ
-- recursive_triggers ปิดอยู่ (ค่าเริ่มต้นของ SQLite) ปิดทางด้วยสองชั้น:
--   ชั้นนี้ = ปฏิเสธการแทรกทับ rev_id ที่มีอยู่แล้วตั้งแต่ BEFORE INSERT (ยิงเสมอ)
--   อีกชั้น = PRAGMA recursive_triggers = ON ใน openDb ให้ BEFORE DELETE ยิงด้วย
CREATE TRIGGER IF NOT EXISTS brain_item_revs_no_replace
BEFORE INSERT ON brain_item_revs
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM brain_item_revs WHERE rev_id = NEW.rev_id)
BEGIN SELECT RAISE(ABORT, 'brain_item_revs append-only: แทรกทับ revision เดิมไม่ได้'); END;

-- append-only เชิงโครงสร้าง: UPDATE ผ่านได้สองทางเท่านั้น ทั้งคู่เป็นเรื่อง PDPA
--   (ก) redact: redacted 0 -> 1 เปลี่ยนได้เฉพาะ body_json (ทุกคอลัมน์อื่นถูกตรึง)
--   (ข) ลบร่องรอยที่มา: redacted 1 -> 1 เปลี่ยนได้เฉพาะ provenance_json
--       (customer_hash ใน provenance เป็นข้อมูลที่ต้องลบได้หลังจาก redact เนื้อไปแล้ว)
CREATE TRIGGER IF NOT EXISTS brain_item_revs_append_only
BEFORE UPDATE ON brain_item_revs
FOR EACH ROW WHEN NOT (
  (OLD.redacted = 0 AND NEW.redacted = 1
   AND NEW.provenance_json = OLD.provenance_json
   AND ${IMMUTABLE_EXCEPT_BODY_AND_REDACTED})
  OR
  (OLD.redacted = 1 AND NEW.redacted = 1
   AND NEW.body_json = OLD.body_json
   AND ${IMMUTABLE_EXCEPT_BODY_AND_REDACTED})
)
BEGIN SELECT RAISE(ABORT, 'brain_item_revs append-only: แก้ revision ไม่ได้ (redaction เท่านั้น)'); END;

CREATE TRIGGER IF NOT EXISTS brain_item_revs_no_delete
BEFORE DELETE ON brain_item_revs
BEGIN SELECT RAISE(ABORT, 'brain_item_revs append-only: ลบ revision ไม่ได้'); END;

-- ทะเบียนการลบเนื้อหาตามคำขอ (PDPA) — sha ต้นฉบับยังอยู่บน rev เพื่อไม่ให้ tree เปลี่ยน
CREATE TABLE IF NOT EXISTS redactions (
  rev_id        TEXT PRIMARY KEY,
  customer_hash TEXT,
  reason        TEXT,
  redacted_at   INTEGER
);

-- brain_versions — ชุด revision ที่ถูกแช่แข็งไว้หนึ่งชุด + ผลด่าน + pointer
-- pointer อยู่เป็นคอลัมน์ (แบบแปลนตัดตาราง brain_pointers/brain_pointer_history ทิ้ง
-- แล้วใช้ admin_audit เดิมเป็นทะเบียน "ใครสลับเมื่อไร") — ดู setBrainPointer()
CREATE TABLE IF NOT EXISTS brain_versions (
  version_id       TEXT NOT NULL PRIMARY KEY,
  parent_id        TEXT,
  seq              INTEGER NOT NULL,
  label            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL CHECK (status IN ('draft','checking','proposed','rejected','validated',
                                                   'canary','live','retired','rolled_back','failed')),
  pointer          TEXT CHECK (pointer IN ('live','canary')),
  canary_json      TEXT NOT NULL DEFAULT '{}',
  manifest_json    TEXT NOT NULL,             -- {revIds:[...], pinnedFiles:{...}, lintAllowlist:[...], counts:{...}}
  tree_sha256      TEXT NOT NULL,             -- sha ของ item_id:body_sha256 ที่เรียงแล้ว (redact ไม่ทำให้เปลี่ยน)
  compiled_sha256  TEXT,
  code_contract    TEXT NOT NULL,
  gate_report_json TEXT,
  gate_acks_json   TEXT NOT NULL DEFAULT '[]',
  teach_json       TEXT NOT NULL DEFAULT '{}',
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  validated_at     INTEGER,
  published_at     INTEGER,
  retired_at       INTEGER
);
-- partial unique: live มีได้แถวเดียว และ canary มีได้แถวเดียว
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_versions_pointer
  ON brain_versions(pointer) WHERE pointer IS NOT NULL;
-- seq คือ "รุ่นที่เท่าไร" ที่คนอ้างถึง — ซ้ำเมื่อไรประวัติก็อ่านไม่ออก
CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_versions_seq ON brain_versions(seq);

/* ============================== เฟส 3: ด่านหนัก ============================== */

-- golden_turns — คลังเดียวของ "เทิร์นที่เราตรวจซ้ำได้" (แบบแปลน §5)
--
-- ทำไมต้องเป็นตาราง ไม่ใช่ไฟล์ต่อไป: eval/scenarios/*.json เป็นคลังของเครื่องมือทดสอบ
-- ส่วนป้ายเส้นทางที่ ledger/staff/owner ติดเป็นคลังของ runtime — สองคลังที่ "ควรจะ" ตรงกัน
-- คือรากของด่านที่โกหก (เหตุการณ์ C8) ไฟล์ JSON จึงกลายเป็น seed ที่นำเข้าตารางนี้ครั้งเดียว
--
-- PDPA: message_ref ชี้ messages.id ของจริง แถวนี้จึงถูกลบใน resetCustomer(forget)
-- (ดู src/db.mjs) และ text_hmac เป็น HMAC ที่มีกุญแจของ instance ไม่ใช่ sha เปล่า —
-- sha เปล่าของข้อความสั้น ๆ ย้อนกลับได้ด้วย dictionary ภายในไม่กี่วินาที
CREATE TABLE IF NOT EXISTS golden_turns (
  turn_id               TEXT NOT NULL PRIMARY KEY,
  case_id               TEXT NOT NULL,            -- เคสหนึ่งเคส = หลายเทิร์นเรียงกัน
  title                 TEXT NOT NULL DEFAULT '',  -- ชื่อที่คนอ่านออก ("ถามราคาก่อนรู้จักคลาส")
  turn_no               INTEGER NOT NULL DEFAULT 1,
  message_ref           TEXT,                     -- messages.id (ลบตาม cascade); NULL = สังเคราะห์
  synthetic_text        TEXT,                     -- เฉพาะเคสสังเคราะห์ (เคส eval + adversarial)
  text_hmac             TEXT NOT NULL,            -- HMAC-SHA256(กุญแจ instance, normalizeThai(text))
  route_inputs_json     TEXT NOT NULL DEFAULT '{}',
  expected_json         TEXT NOT NULL,            -- ศัพท์เดียวกับ eval/assertions.mjs
  recorded_model_output TEXT,                     -- คำตอบที่โมเดลเคยให้ (เล่นซ้ำ guard/delivery ฟรี)
  severity              TEXT NOT NULL DEFAULT 'style'
                        CHECK (severity IN ('irreversible','lead','style')),
  origin                TEXT NOT NULL,            -- ledger_payment | correction | eval_case | ...
  scope_json            TEXT NOT NULL DEFAULT '{}',-- {product:[..]|"*", channel:[..]|"*"}
  -- เจ้าของปิดเคสที่ล้าสมัยได้ (แบบแปลน §6 Step 4) — เก็บว่าใครและเพราะอะไร
  -- เคส irreversible ยังบล็อกต่อไปแม้ถูกปิด: ปุ่มนี้ปิด "เกณฑ์ที่ล้าสมัย" ไม่ใช่ "ด่านที่ไม่สะดวก"
  retired_by            TEXT,
  retired_reason        TEXT,
  retired_at            INTEGER,
  labelled_by           TEXT,
  labelled_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_golden_turns_case ON golden_turns(case_id, turn_no);
CREATE INDEX IF NOT EXISTS idx_golden_turns_message ON golden_turns(message_ref);

-- eval_baselines — ผลทุกรอบที่รัน ต่อ (เคส, รุ่น) + คะแนนความไม่นิ่ง (แบบแปลน §5/§7 G8)
--
-- retired_by/retired_reason ที่นี่เป็น "ใบเสร็จของรอบที่เจ้าของตัดสินใจ" ไม่ใช่แหล่งความจริง
-- ของการปิดเคส (ความจริงอยู่ที่ golden_turns.retired_at ซึ่งเป็นระดับเคส ไม่ใช่ระดับรุ่น)
CREATE TABLE IF NOT EXISTS eval_baselines (
  case_id        TEXT NOT NULL,
  version_id     TEXT NOT NULL,
  results_json   TEXT NOT NULL,                   -- [{at, verdict, fails:[...]}] ทุกรอบ
  flake_score    REAL NOT NULL DEFAULT 0,
  retired_by     TEXT,
  retired_reason TEXT,
  recorded_at    INTEGER,
  PRIMARY KEY (case_id, version_id)
);

-- gate_runs — ใบเสร็จของด่านที่ "มีต้นทุน" (เวลา/เงิน) แบบแปลน §5
CREATE TABLE IF NOT EXISTS gate_runs (
  run_id          TEXT NOT NULL PRIMARY KEY,
  version_id      TEXT,
  release_id      TEXT,
  kind            TEXT NOT NULL,                  -- G5 | G8 | G5b
  snapshot_sha256 TEXT,
  started_at      INTEGER,
  finished_at     INTEGER,
  verdict         TEXT CHECK (verdict IN ('pass','block','needs_ack','error','not_applicable')),
  report_json     TEXT NOT NULL DEFAULT '{}',
  cost_thb        REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gate_runs_version ON gate_runs(version_id, kind);
`;


/**
 * อัปเกรดสคีมาสมองให้ตรงรุ่นปัจจุบัน
 *
 * ทำไมต้องมี: `CREATE TABLE IF NOT EXISTS` และ `CREATE TRIGGER IF NOT EXISTS` เงียบสนิท
 * เมื่อของเดิมมีอยู่แล้ว ฐานที่เคยรัน DDL ชุดแรกจึงยังถือ trigger รุ่นเก่าที่มีช่องโหว่
 * (rev_id ยอมรับ NULL, ไม่มีตัวกัน INSERT OR REPLACE, seq ซ้ำได้) แล้ว "ผ่านเทสต์บน
 * เครื่องใหม่ แต่ไม่ปลอดภัยบนเครื่องที่เคยรันของเก่า" ซึ่งเป็นความต่างที่มองไม่เห็นเลย
 *
 * production ไม่เคยมีตารางสมอง — ที่ต้องกู้คือ worktree ของนักพัฒนาเท่านั้น
 */
export function migrateBrainSchema(db) {
  const stored = readSchemaVersion(db);
  if (stored === BRAIN_SCHEMA_VERSION) return { migrated: false, from: stored };

  // ทิ้ง trigger/ดัชนีของรุ่นเก่าก่อน แล้วให้ BRAIN_SCHEMA สร้างใหม่ทั้งชุด
  for (const name of ["brain_item_revs_append_only", "brain_item_revs_no_replace", "brain_item_revs_no_delete"]) {
    db.exec(`DROP TRIGGER IF EXISTS ${name};`);
  }
  for (const name of ["idx_brain_versions_pointer", "idx_brain_versions_seq",
    "idx_golden_turns_case", "idx_golden_turns_message", "idx_gate_runs_version"]) {
    db.exec(`DROP INDEX IF EXISTS ${name};`);
  }
  if (revIdIsNullable(db)) rebuildItemRevs(db);
  db.exec(BRAIN_SCHEMA);
  ensureGoldenColumns(db);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(BRAIN_SCHEMA_SETTING, String(BRAIN_SCHEMA_VERSION));
  return { migrated: true, from: stored };
}

// คอลัมน์ที่เพิ่มหลังตารางเฟส 3 เกิดแล้ว — `CREATE TABLE IF NOT EXISTS` ไม่เพิ่มคอลัมน์ให้
// ฐานที่มีตารางอยู่แล้ว worktree ของนักพัฒนาที่รัน commit ระหว่างทางจึงต้องซ่อมตัวเองได้
// (production ไม่เคยมีตารางชุดนี้ — ตารางจะถูกสร้างครบตั้งแต่ครั้งแรกที่อัปเดต)
function ensureGoldenColumns(db) {
  try {
    const columns = db.prepare("PRAGMA table_info(golden_turns)").all();
    if (!columns.length) return;
    const add = (name, ddl) => {
      if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE golden_turns ADD COLUMN ${ddl}`);
    };
    add("title", "title TEXT NOT NULL DEFAULT ''");
    add("recorded_at", "recorded_at INTEGER");
    add("recorded_from", "recorded_from TEXT");
  } catch { /* ตารางยังไม่เกิด = DDL ข้างบนจะสร้างให้เองพร้อมคอลัมน์ครบ */ }
}

function readSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(BRAIN_SCHEMA_SETTING);
    return row?.value ? Number(row.value) : 0;
  } catch {
    return 0;
  }
}

function revIdIsNullable(db) {
  try {
    return db.prepare("PRAGMA table_info(brain_item_revs)").all()
      .some((column) => column.name === "rev_id" && column.notnull === 0);
  } catch {
    return false;
  }
}

// รูปแบบคัดลอกตารางมาตรฐานของ SQLite — trigger ถูกทิ้งไปก่อนหน้านี้แล้ว DROP จึงผ่าน
// (แถวที่ rev_id เป็น NULL ไม่มีทางอ้างถึงได้อยู่แล้ว จึงตกไประหว่างคัดลอก)
function rebuildItemRevs(db) {
  const columns = "rev_id, item_id, kind, key, scope_json, body_json, body_sha256, redacted, inject,"
    + " priority, locked, confidence, valid_from, valid_until, supersedes_rev,"
    + " provenance_json, created_by, created_at";
  db.exec(`
    ${brainItemRevsDdl("brain_item_revs_migrated")}
    INSERT INTO brain_item_revs_migrated (${columns})
      SELECT ${columns} FROM brain_item_revs WHERE rev_id IS NOT NULL;
    DROP TABLE brain_item_revs;
    ALTER TABLE brain_item_revs_migrated RENAME TO brain_item_revs;
  `);
}
