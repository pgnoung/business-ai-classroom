// brain/project.mjs — เขียน "ตารางเดิม" ให้เท่ากับเวอร์ชันสมองใบหนึ่ง (แบบแปลน §5 Projection)
//
// ใช้เมื่อ pointer live ย้ายโดยที่ตารางเดิมยังไม่ตาม: เลื่อนขั้น canary -> live และย้อนกลับ
// ไปรุ่นก่อน จนกว่าจะถึง P2 runtime ยังอ่านตารางเดิมอยู่ ดังนั้น "ย้อนกลับ" ที่ไม่เขียน
// ตารางเดิมด้วย = ปุ่มที่ขยับแค่ตัวเลขบนหน้าจอ ลูกค้ายังได้ยินของเดิมทุกคำ
//
// กติกาสองข้อ:
//   1. UPSERT ตามคีย์คงที่ + soft-delete แถวที่หายไป — id เดิมต้องอยู่ ไม่งั้น audit,
//      learning_candidates.supersedes และ sha ต่อรายการของ knowledge-artifact พังหมด
//   2. เขียนเสร็จต้อง "พิสูจน์ตัวเอง" ด้วยตัวเทียบ parity ตัวเดียวกับที่ใช้ตอนบูต ในธุรกรรม
//      เดียวกัน — ไม่ตรงเมื่อไรคือโยน ธุรกรรมถูกยกเลิก ตารางเดิมกลับไปเหมือนเดิมทั้งหมด
//      (ตัวฉายที่เขียนผิดแล้วเงียบ คือสิ่งเดียวที่อันตรายกว่าการไม่มีตัวฉายเลย)
import { compileBrain } from "./compile.mjs";
import { compareBundleToLegacy } from "./parity.mjs";
import { writeManualRounds } from "../classRounds.mjs";
import { PRODUCT_RULES_KEY } from "../tags.mjs";
import { FREECLASS_PATTERNS_KEY } from "../db.mjs";
import { HASHTAG_KEYWORDS_SETTING, HASHTAG_SILENCE_SETTING } from "./sources.mjs";

const QUIET = Object.freeze({ warn() {}, debug() {}, log() {}, error() {} });

export class BrainProjectionFailed extends Error {
  constructor(message, mismatches = []) {
    super(message);
    this.name = "BrainProjectionFailed";
    this.mismatches = mismatches;
  }
}

/**
 * เขียนตารางเดิมให้เท่ากับเวอร์ชันที่ระบุ แล้วพิสูจน์ว่าตรงจริง
 *
 * ต้องถูกเรียกอยู่ในธุรกรรม (ผู้เรียกใช้ db.brainTransaction) — ที่นี่ไม่เปิดธุรกรรมเอง
 * เพราะการย้าย pointer กับการเขียนตารางเดิมต้องเป็นก้อนเดียวกันเสมอ
 *
 * @returns {{cards: number, knowledgeUpserted: number, knowledgeRetired: number, prices: number}}
 */
export function projectVersionToLegacy(db, versionId, { todayIso = null, classRoundsFile = null, updatedBy = "brain" } = {}) {
  const bundle = compileBrain(db, versionId, { todayIso, logger: QUIET });
  const byKind = (kind) => bundle.cards.filter((card) => card.kind === kind);

  const knowledge = projectKnowledge(db, byKind("fact"), updatedBy);
  const prices = projectPrices(db, byKind("price"));
  projectPolicies(db, byKind("policy"));
  projectRounds(db, byKind("schedule"));

  const mismatches = compareBundleToLegacy(db, bundle, { todayIso, classRoundsFile, logger: QUIET });
  if (mismatches.length) {
    throw new BrainProjectionFailed(
      `เขียนตารางเดิมจากรุ่นสมองนี้แล้วยังไม่ตรงกัน (${mismatches.map((m) => m.part).join(", ")})`
      + " — ยกเลิกทั้งหมดแล้ว ของเดิมไม่ถูกแตะ",
      mismatches,
    );
  }
  return { cards: bundle.cards.length, ...knowledge, prices };
}

/* ------------------------------- คลังความรู้ ------------------------------- */

// id ของแถวเดิมต้องอยู่ที่เดิม: การ์ด fact ถูกตั้งชื่อ item_id = `fact:<knowledge id>`
function projectKnowledge(db, cards, updatedBy) {
  const wanted = new Map(cards.map((card) => [String(card.itemId).slice("fact:".length), card]));
  const existing = db.raw.prepare("SELECT id, deleted_at FROM knowledge_entries").all();
  const known = new Set(existing.map((row) => String(row.id)));
  let upserted = 0;
  let retired = 0;

  for (const [id, card] of wanted) {
    const active = card.inject === "never" ? 0 : 1;
    const channelId = card.body.channel_id === null ? null : String(card.body.channel_id);
    if (known.has(id)) {
      // เขียนเฉพาะเมื่อของจริงต่างกัน: updated_at/updated_by เป็นข้อมูลของ "การกระทำ"
      // ไม่ใช่เนื้อหา การขยับมันทุกแถวทุกครั้งที่ฉาย ทำให้ประวัติว่าใครแก้อะไรเมื่อไรพัง
      // และ dedupe ของข้อเสนอการเรียนรู้ (ที่ดูจากคลัง ณ เวลาหนึ่ง) เห็นคลังเปลี่ยนทั้งก้อน
      const current = db.raw.prepare(
        `SELECT title, content, active, channel_id, created_at, deleted_at,
                source, provenance_json, supersedes_id, superseded_by, version
           FROM knowledge_entries WHERE id = ?`,
      ).get(id);
      // สายเลือดของแถว (มาจากข้อเสนอการเรียนรู้ใบไหน แทนที่ใบไหน รุ่นที่เท่าไร) เป็นส่วนหนึ่ง
      // ของ "รุ่นนี้หน้าตาแบบไหน" เท่ากับเนื้อ — ถ้าคืนแค่เนื้อ การย้อนรุ่นจะย้อนได้ครึ่งเดียว
      // แล้ว dedupe ของ learning digest กับ supersede chain จะชี้ไปคนละทางกับที่ประวัติบอก
      const lineage = {
        source: String(card.body.source ?? "human_console"),
        provenance: JSON.stringify(card.body.provenance ?? {}),
        supersedesId: card.body.supersedes_id ?? null,
        supersededBy: card.body.superseded_by ?? null,
        version: Math.max(1, Number(card.body.entry_version) || 1),
      };
      const same = current
        && current.title === String(card.body.title ?? "")
        && current.content === String(card.body.content ?? "")
        && Number(current.active) === active
        && (current.channel_id ?? null) === channelId
        && Number(current.created_at) === Number(card.body.source_created_at)
        && current.deleted_at === null
        && String(current.source ?? "") === lineage.source
        && String(current.provenance_json ?? "{}") === lineage.provenance
        && (current.supersedes_id ?? null) === lineage.supersedesId
        && (current.superseded_by ?? null) === lineage.supersededBy
        && Number(current.version ?? 1) === lineage.version;
      if (!same) {
        db.raw.prepare(
          `UPDATE knowledge_entries
              SET title = ?, content = ?, active = ?, channel_id = ?, created_at = ?,
                  source = ?, provenance_json = ?, supersedes_id = ?, superseded_by = ?, version = ?,
                  updated_by = ?, updated_at = ?, deleted_at = NULL
            WHERE id = ?`,
        ).run(
          String(card.body.title ?? ""), String(card.body.content ?? ""), active,
          channelId, Number(card.body.source_created_at),
          lineage.source, lineage.provenance, lineage.supersedesId, lineage.supersededBy, lineage.version,
          String(updatedBy), Date.now(), id,
        );
        upserted += 1;
      }
      continue;
    }
    {
      // แถวที่ถูกลบถาวรไปแล้ว (ไม่ควรเกิด — การลบของคอนโซลเป็น soft delete) เกิดใหม่ด้วย id เดิม
      //
      // rowid ต้องเป็นตัวเดิมด้วย ไม่ใช่แค่ id: ลำดับความรู้ใน prompt คือ
      // `ORDER BY created_at ASC, rowid ASC` — สองรายการที่ created_at เท่ากัน (เพิ่มใน
      // มิลลิวินาทีเดียวกัน หรือถูกตั้ง created_at เท่ากันจากการฉายครั้งก่อน) จะสลับที่กัน
      // ถ้าใบหนึ่งได้ rowid ใหม่ที่ท้ายตาราง = คนละ prompt ทั้งที่เนื้อหาชุดเดียวกัน
      // ตัวเทียบ parity จะจับได้ แต่จับตอนที่ธุรกรรมเขียนไปครึ่งทางแล้ว จึงกันตั้งแต่ตรงนี้
      const frozen = Number(card.body.source_rowid);
      const taken = Number.isInteger(frozen) && frozen > 0
        ? db.raw.prepare("SELECT 1 AS hit FROM knowledge_entries WHERE rowid = ?").get(frozen)
        : { hit: 1 };
      if (taken) {
        throw new BrainProjectionFailed(
          `กู้ความรู้ ${id} กลับมาไม่ได้: ที่นั่งเดิมในตาราง (rowid ${frozen}) ถูกแถวอื่นใช้ไปแล้ว`
          + " — คืนค่าจากไฟล์สำรองแทน ไม่งั้นลำดับความรู้ใน prompt จะเปลี่ยนเงียบ ๆ",
        );
      }
      // คืนคอลัมน์ที่การ์ดพกมาให้ครบ ไม่ใช่ตั้งเป็นค่าของ "แถวที่ระบบสร้างเอง" —
      // ความรู้ที่มาจากข้อเสนอการเรียนรู้ต้องกลับมาเป็น learning_digest พร้อม provenance เดิม
      db.raw.prepare(
        `INSERT INTO knowledge_entries
           (rowid, id, title, content, active, updated_by, channel_id, source, provenance_json,
            supersedes_id, superseded_by, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        frozen, id, String(card.body.title ?? ""), String(card.body.content ?? ""), active,
        String(updatedBy), channelId,
        String(card.body.source ?? "human_console"),
        JSON.stringify(card.body.provenance ?? {}),
        card.body.supersedes_id ?? null, card.body.superseded_by ?? null,
        Math.max(1, Number(card.body.entry_version) || 1),
        Number(card.body.source_created_at), Date.now(),
      );
      upserted += 1;
    }
  }

  for (const row of existing) {
    if (wanted.has(String(row.id)) || row.deleted_at !== null) continue;
    db.raw.prepare("UPDATE knowledge_entries SET active = 0, deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(Date.now(), Date.now(), String(row.id));
    retired += 1;
  }
  return { knowledgeUpserted: upserted, knowledgeRetired: retired };
}

/* ---------------------------------- ราคา ---------------------------------- */

function projectPrices(db, cards) {
  const wanted = new Map(cards.map((card) => [String(card.body.label_th), Number(card.body.amount)]));
  for (const row of db.approvedPrices()) {
    if (!wanted.has(String(row.label))) db.deleteApprovedPrice(String(row.label));
  }
  for (const [label, amount] of wanted) db.setApprovedPrice(label, amount);
  return wanted.size;
}

/* ------------------------------- กติกา/เส้นทาง ------------------------------- */

function projectPolicies(db, cards) {
  const byKey = new Map(cards.map((card) => [card.key, card]));

  // การ์ดหายไป = ค่าว่าง ไม่ใช่ "คงของเดิมไว้" — ไม่งั้นการย้อนกลับจะย้อนได้ครึ่งเดียว
  db.setSetting(PRODUCT_RULES_KEY, String(byKey.get("policy:product_rules")?.body?.statement_th ?? ""));

  const patterns = byKey.get("policy:freeclass_links")?.body?.params?.patterns;
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(Array.isArray(patterns) ? patterns : []));

  const hashtag = byKey.get("policy:hashtag")?.body?.params ?? null;
  // keywords_configured = false แปลว่า "ยังไม่เคยตั้งค่า" ซึ่งต่างจาก "ตั้งเป็นรายการว่าง"
  // (ตัวแรกให้ค่า default ของ env ทำงาน ตัวหลังปิดคีย์เวิร์ดทั้งหมด) — ต้องแยกให้ออก
  if (hashtag?.keywords_configured === true) {
    db.setSetting(HASHTAG_KEYWORDS_SETTING, JSON.stringify(hashtag.business_keywords ?? {}));
  } else {
    dropSetting(db, HASHTAG_KEYWORDS_SETTING);
  }
  // "ยังไม่เคยตั้ง" ต้องเป็นแถวที่ไม่มีอยู่จริง ไม่ใช่แถวค่าว่าง: getSetting คืน null กับ ""
  // คนละค่า และตัวเทียบ parity เทียบด้วย sha ของค่า — เขียน "" ลงไปคือทำให้ตัวเองไม่ตรง
  if (hashtag?.silence === "1" || hashtag?.silence === "0") db.setSetting(HASHTAG_SILENCE_SETTING, hashtag.silence);
  else dropSetting(db, HASHTAG_SILENCE_SETTING);
}

// settings ไม่มี delete ใน db.mjs (ตั้งใจ — ของส่วนใหญ่ "ค่าว่าง" กับ "ไม่มีแถว" เท่ากัน)
// แต่สองคีย์ของ # แยกสองสถานะนี้จริง ตัวฉายจึงต้องลบแถวได้
function dropSetting(db, key) {
  db.raw.prepare("DELETE FROM settings WHERE key = ?").run(String(key));
}

/* --------------------------------- รอบเรียน --------------------------------- */

function projectRounds(db, cards) {
  const rounds = [...cards]
    .sort((a, b) => (a.body.date < b.body.date ? -1 : a.body.date > b.body.date ? 1 : 0)
      || (Number(a.body.source_index ?? 0) - Number(b.body.source_index ?? 0)))
    .map((card) => ({
      date: String(card.body.date),
      classKey: String(card.body.round_key ?? "custom"),
      label: String(card.body.label_th ?? ""),
      product: String(card.body.product_key ?? ""),
      status: String(card.body.status ?? "open"),
      capacity: card.body.capacity === null || card.body.capacity === undefined ? null : Number(card.body.capacity),
    }));
  writeManualRounds(db, rounds);
}
