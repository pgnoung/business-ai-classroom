// brain-schema-migration.test.mjs — ฐานที่เคยรัน DDL สมองชุดแรกต้องถูกอัปเกรดตอนเปิด
//
// ทำไมต้องมีไฟล์นี้: `CREATE TABLE IF NOT EXISTS` และ `CREATE TRIGGER IF NOT EXISTS`
// เงียบสนิทเมื่อของเดิมมีอยู่แล้ว ฐานที่เคยรันชุดแรกจึงยังถือ trigger รุ่นที่มีช่องโหว่
// (rev_id ยอมรับ NULL, ไม่มีตัวกัน INSERT OR REPLACE, seq ซ้ำได้) แล้วโค้ดใหม่จะ
// "ผ่านเทสต์บนเครื่องใหม่ แต่ไม่ปลอดภัยบนเครื่องที่เคยรันของเก่า" — ความต่างที่มองไม่เห็น
//
// production ไม่เคยมีตารางสมอง ที่ต้องกู้คือ worktree ของนักพัฒนา แต่กติกาเดียวกันนี้
// จะคุ้มครองการเปลี่ยนสคีมาครั้งต่อ ๆ ไปที่ production มีข้อมูลอยู่จริง
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.mjs";
import { BRAIN_SCHEMA_VERSION, BRAIN_SCHEMA_SETTING } from "../src/brain/schema.mjs";

// สำเนา DDL สมองชุดแรกตามที่ commit a024b2d9 ส่งออกไปจริง (คัดลอกมาเป็น fixture
// โดยเจตนา — ถ้าอ้างไฟล์ปัจจุบัน เทสต์จะทดสอบตัวเองแล้วผ่านตลอดกาล)
const LEGACY_BRAIN_DDL = `CREATE TABLE IF NOT EXISTS brain_item_revs (
  rev_id          TEXT PRIMARY KEY,
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
);
CREATE INDEX IF NOT EXISTS idx_brain_item_revs_item ON brain_item_revs(item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_brain_item_revs_kind ON brain_item_revs(kind, key);

-- append-only เชิงโครงสร้าง: UPDATE ผ่านได้ทางเดียวคือ "redaction ตาม PDPA"
-- (redacted 0 -> 1 โดย sha ต้นฉบับและตัวระบุการ์ดต้องไม่ขยับ) นอกนั้น ABORT ทันที
CREATE TRIGGER IF NOT EXISTS brain_item_revs_append_only
BEFORE UPDATE ON brain_item_revs
FOR EACH ROW WHEN NOT (
  OLD.redacted = 0 AND NEW.redacted = 1
  AND NEW.rev_id = OLD.rev_id AND NEW.item_id = OLD.item_id AND NEW.kind = OLD.kind
  AND NEW.key = OLD.key AND NEW.body_sha256 = OLD.body_sha256 AND NEW.created_at = OLD.created_at
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
  version_id       TEXT PRIMARY KEY,
  parent_id        TEXT,
  seq              INTEGER NOT NULL,
  label            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL CHECK (status IN ('draft','checking','proposed','rejected','validated',
                                                   'canary','live','retired','rolled_back','failed')),
  pointer          TEXT CHECK (pointer IN ('live','canary')),
  canary_json      TEXT NOT NULL DEFAULT '{}',
  manifest_json    TEXT NOT NULL,             -- {revIds:[...], pinnedFiles:{...}, counts:{...}}
  tree_sha256      TEXT NOT NULL,             -- sha ของรายการ body_sha256 (redact ไม่ทำให้เปลี่ยน)
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
CREATE INDEX IF NOT EXISTS idx_brain_versions_seq ON brain_versions(seq);`;

function legacyDbFile() {
  const file = join(mkdtempSync(join(tmpdir(), "brain-legacy-")), "chassis.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');");
  db.exec(LEGACY_BRAIN_DDL);
  db.close();
  return file;
}

test("ฐานเก่ายังมีช่องโหว่จริงก่อนอัปเกรด — ไม่งั้นเทสต์นี้ไม่ได้พิสูจน์อะไร", () => {
  const file = legacyDbFile();
  const db = new DatabaseSync(file);
  const columns = db.prepare("PRAGMA table_info(brain_item_revs)").all();
  assert.equal(columns.find((c) => c.name === "rev_id").notnull, 0, "ของเก่า rev_id ยอมรับ NULL");
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name);
  assert.equal(triggers.includes("brain_item_revs_no_replace"), false, "ของเก่าไม่มีตัวกัน INSERT OR REPLACE");
  db.close();
});

test("เปิดฐานเก่าด้วย openDb แล้วช่องโหว่ทั้งสามถูกปิด", () => {
  const file = legacyDbFile();
  const db = openDb({ file });

  assert.equal(Number(db.getSetting(BRAIN_SCHEMA_SETTING)), BRAIN_SCHEMA_VERSION);

  const rev = db.appendBrainRev({
    itemId: "fact:1", kind: "fact", key: "fact:1", scope: { channel: "central" },
    body: { title: "ก" }, createdBy: "owner", createdAt: 1,
  });

  // (1) แทรกทับ rev_id เดิมไม่ได้อีกแล้ว
  assert.throws(
    () => db.raw.exec(`INSERT OR REPLACE INTO brain_item_revs
      (rev_id,item_id,kind,key,body_json,body_sha256,created_by,created_at)
      VALUES ('${rev.rev_id}','fact:1','fact','fact:1','{}','x','attacker',2)`),
    /append-only/u,
  );

  // (2) แอบเปลี่ยนคอลัมน์อื่นพร้อม redact ไม่ได้ (trigger รุ่นเก่าตรึงไม่ครบ)
  assert.throws(
    () => db.raw.exec(`UPDATE brain_item_revs SET redacted = 1, body_json = '{}', inject = 'never'
                        WHERE rev_id = '${rev.rev_id}'`),
    /append-only/u,
  );

  // (3) seq ซ้ำไม่ได้
  db.raw.exec(`INSERT INTO brain_versions (version_id,seq,status,manifest_json,tree_sha256,code_contract,created_by,created_at)
               VALUES ('v1', 1, 'draft', '{}', 't', 'c', 'owner', 1)`);
  assert.throws(
    () => db.raw.exec(`INSERT INTO brain_versions (version_id,seq,status,manifest_json,tree_sha256,code_contract,created_by,created_at)
                       VALUES ('v2', 1, 'draft', '{}', 't', 'c', 'owner', 1)`),
    /UNIQUE/u,
  );

  assert.equal(db.raw.prepare("PRAGMA table_info(brain_item_revs)").all()
    .find((c) => c.name === "rev_id").notnull, 1);
  db.close();
});

test("อัปเกรดแล้วข้อมูลเดิมไม่หาย และเปิดซ้ำไม่อัปเกรดวนอีก", () => {
  const file = legacyDbFile();
  const seed = new DatabaseSync(file);
  seed.exec(`INSERT INTO brain_item_revs
    (rev_id,item_id,kind,key,scope_json,body_json,body_sha256,redacted,inject,priority,locked,
     confidence,provenance_json,created_by,created_at)
    VALUES ('เก่า-1','fact:1','fact','fact:1','{}','{"title":"ของเดิม"}','sha-เดิม',0,'pin',50,0,
            'confirmed','{"source":"import:x"}','owner',1)`);
  seed.close();

  const db = openDb({ file });
  const kept = db.getBrainRev("เก่า-1");
  assert.equal(kept.body_json, '{"title":"ของเดิม"}', "แถวเดิมต้องถูกคัดลอกข้ามมาครบ");
  assert.equal(kept.body_sha256, "sha-เดิม");
  db.close();

  const again = openDb({ file });
  assert.equal(again.getBrainRev("เก่า-1").body_json, '{"title":"ของเดิม"}');
  assert.equal(Number(again.getSetting(BRAIN_SCHEMA_SETTING)), BRAIN_SCHEMA_VERSION);
  assert.equal(again.countBrainRevs(), 1);
  again.close();
});
