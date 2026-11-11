// brain/compile.mjs — คอมไพเลอร์ deterministic: เวอร์ชันของสมอง -> BrainBundle
//
// โหมดเดียวที่มีในเฟส 1a คือ `compat`: ผลลัพธ์ต้อง **ตรงทุกตัวอักษร** กับสิ่งที่เส้นเดิม
// ประกอบจากตารางเดิม (พิสูจน์ใน test/brain-parity.test.mjs โดยเรียกฟังก์ชันเดิมจริง ๆ
// เป็นตัวเทียบ ไม่ใช่ลอกตรรกะมาเขียนใหม่แล้วเทียบกับตัวเอง)
//
// บริสุทธิ์ต่อ "revision ในเวอร์ชัน + sha ไฟล์ที่ปักหมุด" — ยกเว้นจุดเดียวที่ประกาศไว้ชัด:
// จำนวนคนที่ลงทะเบียนแล้ว (settings.class_enrolled) ยังไม่ใช่การ์ด (แบบแปลนจงใจตัด
// ตาราง seat_counters ทิ้ง) จึงอ่านสดจาก db เฉพาะตอนขอ projection ที่ผูกกับวันที่
import {
  brainModeOf, buildKnowledgeSection, catalogOutOfPrompt, knowledgeUsage,
  BRAIN_MODE_SEPARATE, KNOWLEDGE_HEADER, KNOWLEDGE_MAX_CHARS,
} from "../knowledgePack.mjs";
import { composeTagRules } from "../tags.mjs";
import { seatRuleLines, readEnrolled, thaiShortDate, UNLIMITED_SEATS } from "../classRounds.mjs";
import { runBrainLints } from "./lint.mjs";
import { treeSha256 } from "./store.mjs";
import { allowlistValues } from "./sources.mjs";
import { compareSqliteText, sha256, sha256Json, stableJson } from "./text.mjs";

export const COMPILER_VERSION = "brain-compiler-1a.2";

/**
 * @param {object} db
 * @param {string} versionId
 * @param {{todayIso?: string|null, maxChars?: number, logger?: object, activeAt?: number|null}} [options]
 *   todayIso = null (ค่าเริ่มต้น) -> ไม่ผลิต projection ที่ผูกกับวันที่ (seatRuleLines = [])
 *   นี่คือโหมดที่ใช้คำนวณ compiled_sha256 ของเวอร์ชัน: ต้องไม่ขึ้นกับ "วันนี้วันไหน"
 *   ไม่งั้นเวอร์ชันเดิมจะได้ checksum ใหม่ทุกเที่ยงคืนแล้วดูเหมือนสมองเปลี่ยนเอง
 *   activeAt = เวลา (ms) ที่ใช้ตัดสิน valid_from/valid_until ของการ์ด — แบบแปลน §5
 *   "Validity ที่ runtime": โปรที่หมดอายุต้องหลุดออกจากทั้ง prompt และชุดตัวเลขของ guard
 *   ในฟังก์ชันเดียว ไม่ใช่ตรวจตอน publish อย่างเดียว · null = ไม่กรอง (เหมือนเดิมทุกไบต์)
 * @returns {object} BrainBundle
 */
export function compileBrain(db, versionId, { todayIso = null, maxChars = KNOWLEDGE_MAX_CHARS, logger = console, activeAt = null } = {}) {
  const version = db.getBrainVersion(versionId);
  if (!version) throw new Error(`brain: ไม่พบเวอร์ชัน ${versionId}`);
  const manifest = safeJson(version.manifest_json);
  const revs = db.listBrainRevs(manifest.revIds ?? []);
  assertVersionIntegrity(version, manifest, revs);

  // การ์ดที่หมดอายุ/ยังไม่ถึงวันเริ่ม ถูกตัดออก **ก่อน** ส่งเข้าคอมไพเลอร์ — ทั้ง prompt,
  // ตารางราคาของ guard และมุมมองคอนโซล จึงเห็นชุดเดียวกันเสมอ (ไม่มีทางที่ prompt พูดราคา
  // ที่ guard ตัดทิ้ง หรือ guard ยอมรับราคาที่ prompt ไม่มีอยู่แล้ว)
  const expiredRevIds = expiredRevIdsAt(revs, activeAt);
  const usable = expiredRevIds.length ? revs.filter((rev) => revValidAt(rev, activeAt)) : revs;

  return compileCards({
    cards: usable.map(toCard),
    expiredRevIds,
    versionId: version.version_id,
    treeSha256: version.tree_sha256,
    codeContract: version.code_contract,
    pinnedFiles: manifest.pinnedFiles ?? {},
    lintAllowlist: manifest.lintAllowlist ?? [],
    db, todayIso, maxChars, logger,
  });
}

/**
 * คอมไพล์จาก "รายการการ์ด" ตรง ๆ โดยไม่ต้องมีแถวเวอร์ชันในฐานข้อมูล
 *
 * ทำไมต้องมี (เฟส 1b): ด่านตรวจต้องรู้ผลก่อนตัดสินใจว่าจะบันทึกเวอร์ชันหรือไม่ ถ้าบังคับ
 * ให้เขียนเวอร์ชันก่อนคอมไพล์ ทุกครั้งที่ด่านตอบว่า "บล็อก" เราจะเหลือแถวเวอร์ชันขยะไว้
 * ในประวัติ แล้วหน้าประวัติจะเต็มไปด้วยรุ่นที่ไม่เคยมีใครตั้งใจสร้าง
 *
 * ตัว `compileBrain` ข้างบนเป็นเพียงตัวห่อที่โหลดการ์ดจากฐาน + ตรวจความครบถ้วน + กรองการ์ด
 * ที่หมดอายุตาม `activeAt` ก่อนเรียกตัวนี้ จึงมีเครื่องคอมไพล์เครื่องเดียวเสมอ
 * (สองเครื่องที่ "ควรจะ" ตรงกันคือรากของ parity ที่โกหก)
 *
 * `expiredRevIds` = รายชื่อ revision ที่ตัวห่อกรองทิ้งไปแล้ว ส่งมาเพื่อบันทึกลง checksum
 * เท่านั้น เส้นด่านตรวจ (ไม่มีแถวเวอร์ชัน ไม่มี activeAt) ปล่อยว่างไว้ตามเดิม
 */
export function compileCards({
  cards: input = [], versionId = null, treeSha256: tree = "", codeContract = "",
  pinnedFiles = {}, lintAllowlist = [], expiredRevIds = [], db = null,
  todayIso = null, maxChars = KNOWLEDGE_MAX_CHARS, logger = console,
} = {}) {
  const cards = [...input].sort((a, b) => compareSqliteText(`${a.kind} ${a.key}`, `${b.kind} ${b.key}`));
  const byKind = (kind) => cards.filter((card) => card.kind === kind);

  // 19 ต.ค. 2026: คลังรีวิวมีงบแยก (สวิตช์ review_catalog_in_prompt ≠ on) — ตัวประกอบ/ตัวนับเดียวกับ runtime
  // ผลต่างจากเดิมเฉพาะเมื่อรวมเกินเพดาน (ไม่ตัดการ์ดเก่าเพราะคลังรีวิว) และ usage ที่ L07/ด่านงบใช้
  const separateCatalog = catalogOutOfPrompt(db);
  const knowledge = compileKnowledgeBlocks(byKind("fact"), { maxChars, logger, separateCatalog });
  const approvedPrices = compileApprovedPrices(byKind("price"));
  const rounds = compileRounds(byKind("schedule"));
  const policies = Object.fromEntries(byKind("policy").map((card) => [card.key, card]));
  const productRules = String(policies["policy:product_rules"]?.body?.statement_th ?? "");

  const core = {
    versionId,
    treeSha256: tree,
    compilerVersion: COMPILER_VERSION,
    codeContract,
    pinnedFiles: pinnedFiles ?? {},
    todayIso: todayIso ?? null,
    // ใส่ลง core เฉพาะเมื่อ "ตัดของออกจริง" — checksum ของสมองที่ไม่มีการ์ดหมดอายุ
    // จึงเท่าเดิมทุกตัวอักษร ไม่ว่าจะส่ง activeAt มาหรือไม่ (ไม่ใช่ sha ใหม่ทุกเทิร์น)
    ...(expiredRevIds.length ? { expiredRevIds } : {}),
    promptBlocks: {
      // บล็อกความรู้ = stable text ตัวแรกที่ hermesBridge ส่ง
      // เก็บตาม "ขอบเขตของการ์ด" ไม่ใช่ตามสาขา เพราะสาขาไหนอ่านก้อนไหนขึ้นกับ
      // settings brain_mode:<channel> ซึ่งเป็นสวิตช์ runtime ไม่ใช่เนื้อหาของเวอร์ชัน
      // ใช้ knowledgeBlockFor(bundle, db, channelId) เพื่อได้ก้อนของสาขาหนึ่ง ๆ
      knowledge: { central: knowledge.central, byChannel: knowledge.byChannel },
      knowledgeHeader: KNOWLEDGE_HEADER,
    },
    guardTables: {
      // รูปที่ price guard บริโภควันนี้เป๊ะ ๆ: [{label, amount}] เรียงตาม label (BINARY)
      approvedPrices,
      // ยอดที่ยอมรับได้ = สิ่งที่ complianceGuard สร้างจากตารางข้างบน (Set ของ amount)
      approvedAmounts: [...new Set(approvedPrices.map((row) => Number(row.amount)))],
    },
    rules: {
      productRules,
      productRulesLines: composeTagRules({ tags: [], productRules }),
      seatRuleLines: todayIso ? seatRuleLines(projectRounds(db, rounds, todayIso)) : [],
      freeclassPatterns: freeclassPatternsOf(policies["policy:freeclass_links"]),
      hashtag: hashtagOf(policies["policy:hashtag"]),
    },
    consoleViews: {
      catalog: byKind("product").map((card) => ({ key: card.key, name_th: card.body.name_th, status: card.body.status })),
      priceTable: approvedPrices,
      scheduleTable: rounds,
    },
    budget: {
      // pinnedChars = หลังตัดแล้ว (ของจริงที่ส่ง) · usage = ก่อนตัด (ของจริงที่คนเขียนไว้)
      // L07 ต้องดูตัวหลัง ไม่งั้นมันวัดผลของการตัดแล้วบอกว่า "พอดีเป๊ะ" ทุกครั้ง
      pinnedChars: knowledge.pinnedChars,
      usage: knowledge.usage,
      knowledgeMaxChars: maxChars,
      cardCount: cards.length,
    },
  };

  return {
    ...core,
    // `cards` อยู่นอก core โดยเจตนา: checksum ต้องไม่ขยับเพราะเราเผยรายการการ์ดให้ผู้เรียก
    // (ตัวฉาย projection และด่านตรวจต้องการการ์ด ไม่ใช่แค่ผลลัพธ์ที่ประกอบแล้ว)
    cards,
    lints: runBrainLints({ cards, bundle: core, allowlist: allowlistValues(lintAllowlist ?? []) }),
    checksum: sha256Json(core),
  };
}

/**
 * การ์ดใบนี้ยัง "ใช้ได้" ณ เวลานี้ไหม — valid_from/valid_until เป็นขอบเขตปิดหัว เปิดท้าย
 * (ถึงเวลาเริ่มแล้วนับว่าใช้ได้ · ถึงเวลาหมดพอดีนับว่าหมดแล้ว)
 */
export function revValidAt(rev, atMs) {
  if (atMs === null || atMs === undefined || !Number.isFinite(Number(atMs))) return true;
  const at = Number(atMs);
  const from = rev?.valid_from == null ? null : Number(rev.valid_from);
  const until = rev?.valid_until == null ? null : Number(rev.valid_until);
  if (from !== null && Number.isFinite(from) && at < from) return false;
  if (until !== null && Number.isFinite(until) && at >= until) return false;
  return true;
}

/** rev_id ที่ถูกตัดออกเพราะเวลา — เรียงแล้วเพื่อให้เป็นลายเซ็นที่เสถียร */
export function expiredRevIdsAt(revs = [], atMs = null) {
  if (atMs === null || atMs === undefined) return [];
  return revs.filter((rev) => !revValidAt(rev, atMs)).map((rev) => String(rev.rev_id)).sort();
}

/**
 * บรรทัดที่นั่งของ "วันนี้" จาก bundle ที่คอมไพล์ไว้แล้ว
 *
 * แยกออกจาก compileBrain เพราะจำนวนคนที่ลงทะเบียน (settings.class_enrolled) เป็นค่าที่
 * ทีมงานแก้ระหว่างวัน ถ้าอบมันเข้า bundle ที่ถูก cache ตาม tree_sha256 การกรอกที่นั่งจะ
 * ไม่มีผลจนกว่าจะออกเวอร์ชันใหม่ — ทางเดิม (currentSeatRules) อ่านสดทุกเทิร์น
 */
export function seatRuleLinesFor(db, bundle, todayIso) {
  if (!todayIso) return [];
  return seatRuleLines(projectRounds(db, bundle.consoleViews.scheduleTable, todayIso));
}

/** รอบในอนาคตตัวเดียวกับ seatRuleLinesFor แต่เป็นรายการ (openRounds.mjs · 28 ก.ย. 2026) */
export function upcomingRoundsFor(db, bundle, todayIso) {
  if (!todayIso) return [];
  return projectRounds(db, bundle.consoleViews.scheduleTable, todayIso);
}

/**
 * การ์ดจาก `collectCurrentSourceCards` (ยังไม่เคยเป็น revision) -> รูปเดียวกับที่คอมไพเลอร์
 * ได้จาก `toCard(rev)` — เติมค่าตั้งต้นของคอลัมน์ที่ยังไม่มีแถวจริง ไม่เดาค่าอื่นเพิ่ม
 */
export function sourceCardToCard(card) {
  return {
    revId: null,
    itemId: card.itemId,
    kind: card.kind,
    key: card.key,
    scope: card.scope ?? {},
    body: card.body ?? {},
    inject: card.inject ?? "pin",
    priority: Number.isInteger(card.priority) ? card.priority : 50,
    locked: card.locked === true,
    confidence: card.confidence ?? "confirmed",
    validFrom: card.validFrom ?? null,
    validUntil: card.validUntil ?? null,
    provenance: card.provenance ?? {},
    bodySha256: card.bodySha256 ?? null,
    createdAt: card.createdAt ?? null,
  };
}

// เวอร์ชันคือ "หลักฐาน" ว่าสมองหน้าตาแบบไหนถูกเผยแพร่ ถ้า manifest กับแถวจริงเดินคนละทาง
// แล้วเรายังคอมไพล์ต่อ ผลลัพธ์จะเป็นสมองที่ไม่มีใครเคยอนุมัติ — ต้องดังทันที ไม่ใช่เงียบ
function assertVersionIntegrity(version, manifest, revs) {
  const wanted = manifest.revIds ?? [];
  if (revs.length !== wanted.length) {
    throw new Error(`brain: เวอร์ชัน ${version.version_id} อ้าง revision ${wanted.length} ใบ แต่หาเจอ ${revs.length} ใบ`);
  }
  const redacted = revs.filter((rev) => rev.redacted === 1);
  if (redacted.length) {
    // PDPA: การ์ดที่ถูกลบเนื้อตามคำขอลูกค้า คอมไพล์ต่อไม่ได้ — ต้องออกรุ่นใหม่ที่ไม่มีการ์ดนั้น
    throw new Error("brain: เวอร์ชันนี้มีการ์ดที่ถูกลบตามคำขอลูกค้า ต้องเผยแพร่รุ่นใหม่ที่ไม่มีการ์ดนั้น");
  }
  const tree = treeSha256(revs);
  if (tree !== version.tree_sha256) {
    throw new Error(`brain: tree ของเวอร์ชัน ${version.version_id} ไม่ตรงกับ revision ที่อ้างถึง (แก้ฐานข้อมูลตรง ๆ?)`);
  }
  for (const rev of revs) {
    if (sha256(rev.body_json) !== rev.body_sha256) {
      throw new Error(`brain: เนื้อของ revision ${rev.rev_id} ไม่ตรงกับ sha ที่บันทึกไว้ (แก้ฐานข้อมูลตรง ๆ?)`);
    }
  }
}

/* ------------------------------ บล็อกความรู้ ------------------------------ */

// ทำซ้ำ composeKnowledgeForChannel: เลือก scope ตาม brain_mode ของสาขา แล้วเรียงแบบ
// listActiveKnowledge (created_at ASC, rowid ASC) ก่อนส่งเข้า buildKnowledgeSection ตัวจริง
function compileKnowledgeBlocks(factCards, { maxChars, logger, separateCatalog = false }) {
  const central = factCards.filter((card) => card.body.channel_id === null);
  const perChannel = new Map();
  for (const card of factCards) {
    const id = card.body.channel_id;
    if (id === null) continue;
    if (!perChannel.has(id)) perChannel.set(id, []);
    perChannel.get(id).push(card);
  }
  const byChannel = {};
  const usage = { central: usageOf(central, maxChars, separateCatalog) };
  for (const [channelId, rows] of [...perChannel.entries()].sort((a, b) => compareSqliteText(a[0], b[0]))) {
    // สาขาที่มีคลังของตัวเอง = โหมด separate เท่านั้นที่อ่านคลังนี้ (ดู knowledgePack.brainModeOf)
    byChannel[channelId] = sectionOf(rows, { maxChars, logger, separateCatalog });
    usage[channelId] = usageOf(rows, maxChars, separateCatalog);
  }
  const centralBlock = sectionOf(central, { maxChars, logger, separateCatalog });
  const pinnedChars = { central: [...centralBlock].length };
  for (const [id, text] of Object.entries(byChannel)) pinnedChars[id] = [...text].length;
  return { central: centralBlock, byChannel, pinnedChars, usage };
}

function entriesOf(cards) {
  return [...cards]
    .filter((card) => card.inject !== "never")
    .sort((a, b) => (a.body.source_created_at - b.body.source_created_at) || (a.body.source_rowid - b.body.source_rowid))
    .map((card) => ({ title: card.body.title, content: card.body.content }));
}

function sectionOf(cards, { maxChars, logger, separateCatalog = false }) {
  // ใช้ตัวประกอบตัวเดียวกับ runtime — ห้ามเขียนตัวประกอบที่สองแล้วหวังว่าจะตรงกัน
  return buildKnowledgeSection(entriesOf(cards), { maxChars, logger, separateCatalog });
}

// ตัวนับตัวเดียวกับที่คอนโซลใช้ปฏิเสธการเพิ่มตอนล้น — บอก "ก่อนตัด" ว่าใหญ่แค่ไหน
// และมีกี่รายการที่ตกขอบ (droppedCount) ซึ่งคือสิ่งที่ L07 ต้องเห็น
function usageOf(cards, maxChars, separateCatalog = false) {
  // usage ไม่เพิ่มฟิลด์ใหม่ (checksum ของ bundle) — แบบใหม่แค่ไม่นับการ์ดคลังรีวิวใน totalChars/droppedCount
  const { totalChars, entryCount, droppedCount } = knowledgeUsage(entriesOf(cards), { maxChars, separateCatalog });
  return { totalChars, entryCount, droppedCount };
}

/* --------------------------------- ราคา --------------------------------- */

function compileApprovedPrices(priceCards) {
  return priceCards
    .map((card) => ({ label: String(card.body.label_th), amount: Number(card.body.amount) }))
    .sort((a, b) => compareSqliteText(a.label, b.label));
}

/* -------------------------------- รอบเรียน -------------------------------- */

function compileRounds(scheduleCards) {
  return scheduleCards
    .map((card) => ({
      date: card.body.date,
      classKey: card.body.round_key,
      label: card.body.label_th,
      product: card.body.product_key,
      // ค่าเดิมของโค้ด ไม่ใช่ค่าที่ map เป็นคำศัพท์ใหม่ — projection ต้องตรงไบต์
      fileStatus: card.body.status,
      capacity: card.body.capacity === null ? UNLIMITED_SEATS : Number(card.body.capacity),
      sourceIndex: Number(card.body.source_index ?? 0),
    }))
    // เรียงเหมือน readManualRounds/readRoundsFile เป๊ะ: ตามวัน แล้วตามลำดับในแหล่ง
    // (การ์ดเข้ามาเรียงตามคีย์ ซึ่งมีชื่อรอบอยู่ด้วย รอบวันเดียวกันจึงสลับที่ถ้าไม่แก้ตรงนี้)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.sourceIndex - b.sourceIndex))
    .map(({ sourceIndex, ...round }) => round);
}

// ทำซ้ำ upcomingRounds ของ classRounds.mjs — จุดเดียวที่อ่านนอกเวอร์ชันคือจำนวนที่ลงทะเบียน
// (settings.class_enrolled ยังไม่ใช่การ์ดตามแบบแปลน) และ "วันนี้" ที่ผู้เรียกส่งเข้ามา
function projectRounds(db, rounds, todayIso) {
  const enrolled = readEnrolled(db);
  return rounds
    .filter((round) => round.date > todayIso)
    .map((round) => {
      const taken = Object.hasOwn(enrolled, round.date) ? enrolled[round.date] : null;
      return {
        ...round,
        thai: thaiShortDate(round.date),
        enrolled: taken,
        unlimited: round.capacity === UNLIMITED_SEATS,
        seatsLeft: (round.capacity === UNLIMITED_SEATS || taken === null) ? null : Math.max(0, round.capacity - taken),
        overbooked: (round.capacity === UNLIMITED_SEATS || taken === null) ? 0 : Math.max(0, taken - round.capacity),
      };
    });
}

/* ------------------------------ กติกาเส้นทาง ------------------------------ */

function freeclassPatternsOf(card) {
  const patterns = card?.body?.params?.patterns;
  return Array.isArray(patterns) ? [...patterns] : [];
}

function hashtagOf(card) {
  const params = card?.body?.params ?? {};
  return {
    businessKeywords: params.business_keywords ?? {},
    keywordsConfigured: params.keywords_configured === true,
    silence: params.silence ?? null,
  };
}

/* --------------------------------- ตัวช่วย --------------------------------- */

function toCard(rev) {
  return {
    revId: rev.rev_id,
    itemId: rev.item_id,
    kind: rev.kind,
    key: rev.key,
    scope: safeJson(rev.scope_json),
    body: safeJson(rev.body_json),
    inject: rev.inject,
    priority: rev.priority,
    locked: rev.locked === 1,
    confidence: rev.confidence,
    validFrom: rev.valid_from,
    validUntil: rev.valid_until,
    provenance: safeJson(rev.provenance_json),
    bodySha256: rev.body_sha256,
    createdAt: rev.created_at,
  };
}

function safeJson(text) {
  try { return JSON.parse(String(text ?? "{}")); } catch { return {}; }
}

/**
 * ก้อนความรู้ที่สาขาหนึ่ง ๆ จะได้รับ — ทำซ้ำ composeKnowledgeForChannel ทุกเงื่อนไข
 * (โหมด shared = คลังกลาง / separate = คลังของสาขานั้นเท่านั้น ไม่อ่านกลาง)
 * brain_mode เป็นสวิตช์ runtime จึงอ่านจาก db ไม่ใช่จาก bundle
 */
export function knowledgeBlockFor(bundle, db, channelId = "default") {
  const id = String(channelId || "default");
  const separate = brainModeOf(db, id) === BRAIN_MODE_SEPARATE;
  if (!separate) return bundle.promptBlocks.knowledge.central;
  return bundle.promptBlocks.knowledge.byChannel[id] ?? "";
}

export { stableJson };
