// brain/sources.mjs — อ่าน "แหล่งความจริงที่ใช้อยู่วันนี้" แล้วแปลงเป็นการ์ด
//
// แยกจาก import.mjs เพื่อให้ไฟล์นั้นเหลือแต่ลำดับงาน (append -> version -> lint -> pointer)
// ทุกฟังก์ชันที่นี่บริสุทธิ์ต่อ db/ไฟล์: อ่านอย่างเดียว ไม่เขียนอะไรเลย
//
// สิ่งที่ **ไม่** นำเข้าและทำไม (แบบแปลน §11 P1): persona, brand pack, template,
// safety-rules, รูป — ยังเป็นไฟล์/โค้ดจนถึง P4 แล้วย้ายพร้อมปลด pin ใน release เดียว
// ที่นี่บันทึกได้แค่ sha ของไฟล์ที่ปักหมุดลง manifest เพื่อให้เวอร์ชันชี้ไฟล์ที่ถูกต้อง
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { FREECLASS_PATTERNS_KEY } from "../db.mjs";
import { PRODUCT_RULES_KEY } from "../tags.mjs";
import { readManualRounds, readRoundsFile } from "../classRounds.mjs";
import { normalizeHashtagBusinessKeywords } from "../pipeline.mjs";
import { bodySha256 } from "./store.mjs";
import { compareSqliteText } from "./text.mjs";
import { hasKnowledgeMetadata, knowledgeMetadataFromRow } from "./knowledgeMetadata.mjs";

export const HASHTAG_KEYWORDS_SETTING = "hashtag_business_keywords";
export const HASHTAG_SILENCE_SETTING = "hashtag_silence";

// สถานะรอบของโค้ดเดิม -> คำศัพท์ปิดของแบบแปลน (open/full/done/cancelled)
// เก็บค่าเดิมไว้ด้วยเสมอ (`status`) เพราะ projection ของ runtime ใช้ค่าเดิมทุกตัวอักษร
// almost_full ไม่มีในคำศัพท์ใหม่ แต่ยัง "รับสมัครอยู่" จึง map เป็น open
const STATUS_TO_DESIGN = Object.freeze({
  open: "open", almost_full: "open", full: "full", closed: "done",
});
export const ACCEPTING_ROUND_STATUSES = Object.freeze(["open", "almost_full"]);

/* ------------------------------ ความรู้ -> fact ------------------------------ */

// เก็บ created_at และ rowid ของแถวต้นทางไว้ใน body เพราะลำดับใน prompt คือข้อมูล:
// db.listActiveKnowledge เรียง `created_at ASC, rowid ASC` และตัวตัดเพดานทิ้ง "เก่าสุด"
// ก่อน ถ้าคอมไพเลอร์เรียงคนละแบบ ก้อนที่ถูกตัดจะเป็นคนละก้อน = คนละ prompt
function knowledgeCards(db) {
  const rows = db.raw
    .prepare("SELECT rowid AS source_rowid, * FROM knowledge_entries WHERE deleted_at IS NULL ORDER BY created_at ASC, rowid ASC")
    .all();
  return rows.map((row) => {
    const configuredKnowledge = hasKnowledgeMetadata(safeJsonValue(row.provenance_json, {}));
    const metadata = knowledgeMetadataFromRow(row);
    return {
    itemId: `fact:${row.id}`,
    kind: "fact",
    key: `fact:${row.id}`,
    // channel_id NULL = คลังกลาง (สาขาโหมด shared เห็น) / = id หนึ่ง ๆ = คลังของสาขานั้น
    // จงใจไม่ใช้ "*" ของแบบแปลน เพราะ "กลาง" ไม่ใช่ "ทุกสาขา": สาขาโหมด separate ไม่อ่านกลาง
    scope: { channel: row.channel_id === null ? "central" : [String(row.channel_id)] },
    // active = 0 ไม่ใช่ "ไม่มีการ์ด" แต่คือการ์ดที่ไม่ถูกฉีดเข้า prompt = inject 'never'
    // เมทาดาทาที่พังต้องไม่ตกกลับไป pin เพราะความรู้ที่ตั้งใจให้ค้นหาอาจหลุดเข้า prompt ทุกเทิร์น
    inject: knowledgeInject(row, { configuredKnowledge, metadata }),
    body: {
      kind: "fact",
      title: String(row.title ?? ""),
      content: String(row.content ?? ""),
      channel_id: row.channel_id === null ? null : String(row.channel_id),
      source_created_at: Number(row.created_at),
      source_rowid: Number(row.source_rowid),
      // คอลัมน์ที่ตัวฉาย projection ต้องคืนกลับให้ครบตอนกู้แถว — ถ้าการ์ดไม่พกไว้ แถวที่กู้มา
      // จะกลายเป็น source='brain_projection' version=1 ไม่มี provenance: ประวัติว่าใครสอน
      // ความรู้ใบนี้ (ข้อเสนอการเรียนรู้ใบไหน คนไหนอนุมัติ) หายไปเงียบ ๆ พร้อมกับสายซ้อนทับ
      // จงใจไม่พก updated_by/updated_at: สองตัวนั้นขยับทุกครั้งที่มีคนกดบันทึก การพกไว้
      // จะทำให้ "แก้โดยคนละคนแต่เนื้อเท่าเดิม" กลายเป็นการ์ดคนละใบ = รุ่นใหม่ที่ไม่มีอะไรเปลี่ยน
      source: String(row.source ?? "human_console"),
      provenance: safeJsonValue(row.provenance_json, {}),
      supersedes_id: row.supersedes_id === null || row.supersedes_id === undefined ? null : String(row.supersedes_id),
      superseded_by: row.superseded_by === null || row.superseded_by === undefined ? null : String(row.superseded_by),
      entry_version: Math.max(1, Number(row.version) || 1),
    },
    provenance: { source: `import:knowledge_entries:${row.id}`, source_version: Number(row.version ?? 1) },
    };
  });
}

function knowledgeInject(row, { configuredKnowledge, metadata }) {
  if (row.active !== 1) return "never";
  if (!configuredKnowledge) return "pin";
  return metadata?.mode === "pin" || metadata?.mode === "retrieve" ? metadata.mode : "never";
}

/* ------------------------------ ราคา -> price ------------------------------ */

// นำเข้าเท่าที่ตารางเดิมมีจริง: label + amount เท่านั้น
// ห้ามเติม quote_policy / headcount_multiplier_allowed ให้เอง — วันนี้ไม่มีใครเคยตัดสินใจ
// ค่าพวกนั้น การเดาแทนเจ้าของแล้วเก็บเป็น "ข้อมูลที่อนุมัติแล้ว" คือการปลอมหลักฐาน
// confidence = needs_owner_confirm บอกตรง ๆ ว่าช่องที่เหลือยังรอเจ้าของเติม
function priceCards(db) {
  return db.approvedPrices().map((row) => ({
    itemId: `price:${row.label}`,
    kind: "price",
    key: `price:${row.label}`,
    scope: { channel: "*" },
    confidence: "needs_owner_confirm",
    body: { label_th: String(row.label), amount: Number(row.amount), kind: "normal" },
    provenance: { source: `import:approved_prices:${row.label}` },
  }));
}

/* ---------------------------- รอบเรียน -> schedule ---------------------------- */

// ลำดับความสำคัญต้องตรงกับ upcomingRounds เป๊ะ: ที่กรอกเองจากคอนโซลชนะไฟล์เสมอ
// ถ้าไม่ mirror ตรงนี้ instance ที่ยังใช้ไฟล์อยู่จะได้สมองที่ไม่มีรอบเลย แล้ว parity
// จะฟ้องว่าต่างกันทุกคืนโดยที่ไม่มีใครทำอะไรผิด
export function readSourceRounds(db, { classRoundsFile = null, logger = console } = {}) {
  const manual = readManualRounds(db);
  if (manual.length) return { rounds: manual, origin: "class_rounds_manual" };
  const fromFile = classRoundsFile ? readRoundsFile(classRoundsFile, logger) : [];
  return { rounds: fromFile, origin: fromFile.length ? "class_rounds_file" : "none" };
}

function scheduleCards(db, { classRoundsFile, logger }) {
  const { rounds, origin } = readSourceRounds(db, { classRoundsFile, logger });
  const seen = new Map();
  for (const [sourceIndex, round] of rounds.entries()) {
    // ตัวระบุต้องรวมทุกฟิลด์ที่แยกรอบออกจากกันได้จริง — สองรอบวันเดียวกัน คลาสเดียวกัน
    // แต่คนละชื่อ คือคนละรอบ ถ้าใช้แค่ date+classKey ใบหลังจะกลายเป็น "การแก้ใบแรก"
    // แล้วประวัติจะโกหกว่าเจ้าของเปลี่ยนชื่อรอบ ทั้งที่ประกาศสองรอบ
    const label = String(round.label || "").trim();
    const itemId = `schedule:${round.date}:${round.classKey}:${label}`;
    if (seen.has(itemId)) {
      throw new Error(`brain: รอบเรียนซ้ำกันทุกฟิลด์ (${round.date} / ${round.classKey} / ${label}) — แก้ที่แหล่งก่อนนำเข้า`);
    }
    seen.set(itemId, {
      itemId, kind: "schedule", key: itemId,
      scope: { channel: "*", product: round.product ? [round.product] : "*" },
      body: {
        date: round.date,
        round_key: round.classKey,
        label_th: round.label,
        product_key: round.product,
        // ค่าเดิมของโค้ด (open/almost_full/full/closed หรืออะไรก็ตามที่อยู่ในไฟล์) —
        // projection ของ runtime ใช้ค่านี้ ห้ามแปลงก่อนเก็บ
        status: round.fileStatus,
        status_design: STATUS_TO_DESIGN[round.fileStatus] ?? "open",
        capacity: round.capacity,
        // ลำดับในแหล่ง คือข้อมูล: readManualRounds/readRoundsFile เรียงตามวันด้วย sort
        // ที่เสถียร รอบวันเดียวกันจึงคงลำดับที่เจ้าของพิมพ์ไว้ และ upcomingRounds ส่งต่อ
        // ลำดับนั้นเข้า seatRuleLines ตรง ๆ ถ้าคอมไพเลอร์เรียงใหม่ตามชื่อ บรรทัดที่นั่ง
        // ของสองรอบวันเดียวกันจะสลับที่ = คนละไบต์ ทั้งที่เนื้อหาเหมือนกันทุกอย่าง
        source_index: sourceIndex,
      },
      provenance: { source: `import:${origin}:${round.date}:${round.classKey}` },
    });
  }
  return [...seen.values()];
}

/* ------------------------------ สินค้า -> product ----------------------------- */

// วันนี้ "สินค้า" ไม่มีตารางของตัวเองใน DB: แคตตาล็อกจริงอยู่ใน sales-policy.json ซึ่งเป็น
// ไฟล์ (และไฟล์ยังเป็นไฟล์จนถึง P4) ที่เดียวใน DB ที่เขียนชื่อสินค้าไว้จริงคือรอบเรียน
// จึงสังเคราะห์การ์ดสินค้าจากชื่อสินค้าที่ปรากฏในรอบ — ไม่เดาอะไรเพิ่ม
function productCards(rounds) {
  const seen = new Map();
  for (const card of rounds) {
    const key = String(card.body.product_key || "").trim();
    if (!key || seen.has(key)) continue;
    seen.set(key, {
      itemId: `product:${key}`,
      kind: "product",
      key: `product:${key}`,
      scope: { channel: "*" },
      confidence: "needs_owner_confirm",
      body: {
        name_th: key, name_en: "", aliases: [], subject_key: "", tier: "",
        status: "selling", one_line_th: "", sellable: true,
      },
      provenance: { source: `import:${String(card.provenance.source).split(":")[1]}:product:${key}` },
    });
  }
  return [...seen.values()].sort((a, b) => compareSqliteText(a.key, b.key));
}

/* --------------------------- กติกา/เส้นทาง -> policy --------------------------- */

// หมายเหตุความเบี่ยงเบนจากแบบแปลน: §5 บอกว่า policy ในเฟส 1 เป็น `prompt_only` เท่านั้น
// แต่ลิงก์คลาสฟรีและคีย์เวิร์ด # เป็นกติกา "เส้นทาง" จริง ๆ (ติดป้าย / แทนข้อความลูกค้า)
// เฟส 1a จึงบันทึก enforcement ตามความจริงไว้ก่อน — ยังไม่มีโค้ดใดบังคับใช้จากการ์ด
// และ ref ทั้งสองจะเข้า registry ของโค้ด (lint L11) ตอน P4
function policyCards(db) {
  const cards = [];
  const productRules = db.getSetting(PRODUCT_RULES_KEY);
  if (typeof productRules === "string" && productRules !== "") {
    cards.push({
      itemId: "policy:product_rules", kind: "policy", key: "policy:product_rules",
      scope: { channel: "*" },
      body: {
        statement_th: productRules,
        enforcement: { kind: "prompt_only", ref: "tags.composeTagRules" },
        params: {}, precedence: 50,
      },
      provenance: { source: `import:settings:${PRODUCT_RULES_KEY}` },
    });
  }

  const freeclass = parseJsonSetting(db, FREECLASS_PATTERNS_KEY, []);
  if (Array.isArray(freeclass) && freeclass.length) {
    cards.push({
      itemId: "policy:freeclass_links", kind: "policy", key: "policy:freeclass_links",
      scope: { channel: "*" },
      body: {
        statement_th: "ลิงก์คลาสฟรีที่ทีมงานตั้งไว้ — ส่งลิงก์เหล่านี้แล้วติดป้ายลูกค้าอัตโนมัติ",
        enforcement: { kind: "route", ref: "db.autoTagFreeClass" },
        params: { patterns: freeclass.map((value) => (typeof value === "string" ? value : "")) },
        precedence: 50,
      },
      provenance: { source: `import:settings:${FREECLASS_PATTERNS_KEY}` },
    });
  }

  const rawKeywords = parseJsonSetting(db, HASHTAG_KEYWORDS_SETTING, null);
  const silence = db.getSetting(HASHTAG_SILENCE_SETTING);
  const keywords = rawKeywords === null ? null : normalizeHashtagBusinessKeywords(rawKeywords);
  if (keywords !== null || silence === "1" || silence === "0") {
    cards.push({
      itemId: "policy:hashtag", kind: "policy", key: "policy:hashtag",
      scope: { channel: "*" },
      body: {
        statement_th: "คีย์เวิร์ดกิจกรรม # / @ ที่ลูกแพรตอบเอง และสวิตช์เงียบสำหรับ # ที่ไม่อยู่ในรายการ",
        enforcement: { kind: "route", ref: "pipeline.resolveBusinessHashtag" },
        params: {
          business_keywords: keywords ?? {},
          keywords_configured: keywords !== null,
          silence: silence === "1" ? "1" : silence === "0" ? "0" : null,
        },
        precedence: 50,
      },
      provenance: { source: `import:settings:${HASHTAG_KEYWORDS_SETTING}` },
    });
  }
  return cards;
}

function safeJsonValue(text, fallback) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch { return fallback; }
}

function parseJsonSetting(db, key, fallback) {
  const raw = db.getSetting(key);
  if (raw === null || raw === undefined || raw === "") return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/* -------------------------- การ์ดทั้งหมด ณ ตอนนี้ -------------------------- */

/** การ์ดทั้งหมดของ "สถานะแหล่งเดิม ณ ตอนนี้" เรียงคงที่ (kind, key) */
export function collectCurrentSourceCards(db, { classRoundsFile = null, logger = console } = {}) {
  const schedules = scheduleCards(db, { classRoundsFile, logger });
  const cards = [
    ...productCards(schedules),
    ...knowledgeCards(db),
    ...priceCards(db),
    ...schedules,
    ...policyCards(db),
  ];
  return cards
    .map((card) => ({ ...card, bodySha256: bodySha256(card.body) }))
    .sort((a, b) => compareSqliteText(`${a.kind} ${a.key}`, `${b.kind} ${b.key}`));
}

/* ---------------------- ไฟล์ที่ปักหมุด + allowlist ของ L15 ---------------------- */

const EMAIL_TOKEN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const HANDLE_TOKEN = /@[A-Za-z0-9._-]{4,}/gu;
const PHONE_TOKEN = /\b0\d{8,9}\b/gu;

/** sha256 ของไฟล์ที่ปักหมุด — {ชื่อ: path} -> {ชื่อ: {path, sha256}} (ไฟล์หาย = sha null) */
export function pinFiles(files = {}) {
  const out = {};
  for (const [name, path] of Object.entries(files)) {
    if (!path) continue;
    let sha = null;
    try { sha = createHash("sha256").update(readFileSync(String(path))).digest("hex"); } catch { sha = null; }
    out[name] = { path: String(path), sha256: sha };
  }
  return out;
}

/**
 * รายชื่อ "ช่องทางติดต่อของร้านเราเอง" ที่ L15 ต้องไม่ฟ้อง
 *
 * เก็บจากสองที่เท่านั้น:
 *   (1) ไฟล์ persona — เป็นคำประกาศตัวตนของร้านที่เจ้าของเขียนเอง เบอร์/อีเมลในนั้น
 *       คือของร้านโดยนิยาม
 *   (2) config/brain-lint-allowlist.json ของ instance — ค่าที่เจ้าของยืนยันเองทีละตัว
 *
 * จงใจ **ไม่** กวาดจากไฟล์ที่ปักหมุดทุกไฟล์: brand pack มีเนื้อหาการ์ดความรู้ที่อาจอ้าง
 * ช่องทางติดต่อของคนอื่น (พาร์ตเนอร์ สถานที่จัดงาน ลูกค้าองค์กร) ถ้ากวาดหมด เบอร์ของ
 * บุคคลที่สามจะกลายเป็น "ของเรา" แล้ว L15 จะเงียบกับสิ่งที่มันถูกเขียนขึ้นมาเพื่อจับพอดี
 *
 * สกัดครั้งเดียวตอนนำเข้าแล้วเก็บลง manifest พร้อม "ที่มาต่อรายการ" — คอมไพเลอร์จึงยัง
 * บริสุทธิ์ต่อเวอร์ชัน ไม่ต้องแตะดิสก์ตอนบูต และคนตรวจย้อนได้ว่าค่าไหนมาจากไหน
 */
export const ALLOWLIST_PINNED_FILES = Object.freeze(["persona"]);

export function buildLintAllowlist({ pinnedFiles = {}, allowlistFile = null } = {}) {
  const bySource = new Map();
  const add = (value, source) => {
    const token = String(value || "").trim().toLowerCase();
    if (token && !bySource.has(token)) bySource.set(token, source);
  };

  for (const name of ALLOWLIST_PINNED_FILES) {
    const path = pinnedFiles?.[name]?.path;
    if (!path || !existsSync(path)) continue;
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    for (const re of [EMAIL_TOKEN, HANDLE_TOKEN, PHONE_TOKEN]) {
      for (const hit of text.match(re) ?? []) add(hit, `pinned:${name}`);
    }
  }
  if (allowlistFile && existsSync(allowlistFile)) {
    try {
      const parsed = JSON.parse(readFileSync(allowlistFile, "utf8"));
      for (const value of parsed?.contacts ?? []) {
        if (typeof value === "string") add(value, "config:brain-lint-allowlist");
      }
      // accountNumbers = ตัวเลขที่ธุรกิจเป็นเจ้าของเอง (เลขบัญชีร้าน / เลขผู้เสียภาษีของเรา)
      // ปฏิบัติเหมือน contacts ทุกประการ: เป็นของเรา L15 จึงต้องไม่ฟ้อง — แต่แยกช่องไว้
      // เพื่อให้คนกรอกเห็นชัดว่าช่องนี้ไม่ใช่ที่ใส่เลขบัญชีลูกค้า (ที่มาถูกบันทึกแยกด้วย)
      for (const value of parsed?.accountNumbers ?? []) {
        if (typeof value === "string") add(value, "config:brain-lint-allowlist:accountNumbers");
      }
    } catch { /* ไฟล์เสีย = ไม่มี allowlist เพิ่ม (ห้ามเดา) */ }
  }
  return [...bySource.entries()]
    .map(([value, source]) => ({ value, source }))
    .sort((a, b) => compareSqliteText(a.value, b.value));
}

/** ค่าเปล่า ๆ ของ allowlist (lint ต้องการแค่ค่า ส่วน "ที่มา" มีไว้ให้คนตรวจ) */
export function allowlistValues(entries = []) {
  return entries.map((entry) => (typeof entry === "string" ? entry : entry?.value)).filter(Boolean);
}
