// brain/import.mjs — ยกแหล่งความจริงที่ใช้อยู่วันนี้เข้าสมองเป็นเวอร์ชันหนึ่งใบ
//
// เฟส 1a เป็น shadow store ล้วน: ตารางเดิมยังเป็นแหล่งความจริงของ runtime ทุกไบต์
// ตัวนำเข้าแค่ "ถ่ายสำเนา" มาเก็บในรูปการ์ดที่มีเวอร์ชัน เพื่อให้คอมไพเลอร์พิสูจน์ได้ว่า
// ประกอบกลับออกมาได้ตรงกับของเดิมทุกตัวอักษร (test/brain-parity.test.mjs)
//
// ตัวนำเข้า **ไม่บล็อกและไม่แก้เนื้อหา** ไม่ว่า lint จะฟ้องอะไร: การกรอง PII หรือตัด
// อักขระตอนนำเข้า = สมองจะได้คนละไบต์กับ prompt วันนี้ทันที ซึ่งทำลายเหตุผลทั้งหมด
// ของเฟสนี้ ผล lint ถูกเก็บลง gate_report_json ให้คนอ่าน แล้วไปแก้ที่ "แหล่ง" แทน
//
// idempotent: รันซ้ำแล้วแหล่งไม่เปลี่ยน = ไม่เกิดการ์ดใหม่และไม่เกิดเวอร์ชันใหม่
import { collectCurrentSourceCards, buildLintAllowlist, pinFiles, readSourceRounds } from "./sources.mjs";
import { compileBrain } from "./compile.mjs";
import { stableJson } from "./text.mjs";

export const BRAIN_CODE_CONTRACT = "brain-compat-1";
export { HASHTAG_KEYWORDS_SETTING, HASHTAG_SILENCE_SETTING } from "./sources.mjs";
export { collectCurrentSourceCards } from "./sources.mjs";

/**
 * นำเข้าแหล่งเดิมทั้งหมดเป็นเวอร์ชันใหม่ แล้วชี้ pointer `live` มาที่เวอร์ชันนั้น
 *
 * @param {object} db
 * @param {object} [options]
 * @param {Function|number} [options.now]
 * @param {string} [options.createdBy]
 * @param {string} [options.label]
 * @param {Record<string,string>} [options.pinnedFiles] {ชื่อ: path} ของไฟล์ที่ยังเป็นไฟล์
 *   (persona / brand pack / sales policy / class rounds) — เก็บ sha ลง manifest
 * @param {string|null} [options.classRoundsFile] ไฟล์รอบเรียน (ค่าเดียวกับ CLASS_ROUNDS_FILE)
 * @param {string|null} [options.allowlistFile] config/brain-lint-allowlist.json ของ instance
 * @returns {{created: boolean, reason: string, versionId: string, appended: number, cards: number,
 *            counts?: object, lints?: object[]}}
 */
export function importCurrentSourcesAsVersion1(db, {
  now = Date.now, createdBy = "import", label = "นำเข้าจากตารางเดิม",
  pinnedFiles = {}, classRoundsFile = null, allowlistFile = null, todayIso = null, logger = console,
} = {}) {
  const at = typeof now === "function" ? Number(now()) : Number(now);
  // ต้องเป็น "วันนี้" ตัวเดียวกับที่ตอนบูตใช้ ไม่งั้นรายงานตอนนำเข้ากับบรรทัด parity
  // ตอนบูตจะพูดคนละเรื่องเรื่องรอบเรียนที่เพิ่งผ่านไป แล้วไม่มีใครรู้ว่าอันไหนถูก
  const today = todayIso ?? todayInBangkok(at);
  // ปักหมุดไฟล์รอบเรียนเฉพาะเมื่อ "ใช้ไฟล์จริง ๆ" — ถ้าเจ้าของกรอกรอบในคอนโซลแล้ว
  // ไฟล์นั้นไม่มีผลต่อสมองเลย การเก็บ sha ของมันไว้จะทำให้เวอร์ชันเปลี่ยนทุกครั้งที่มี
  // คนไปแก้ไฟล์ที่ระบบไม่ได้อ่าน = เวอร์ชันใหม่ที่ไม่มีอะไรเปลี่ยนจริง
  const { origin } = readSourceRounds(db, { classRoundsFile, logger });
  const usesRoundsFile = origin === "class_rounds_file";
  const pinned = pinFiles({ ...pinnedFiles, ...(usesRoundsFile ? { classRounds: classRoundsFile } : {}) });
  const lintAllowlist = buildLintAllowlist({ pinnedFiles: pinned, allowlistFile });
  const cards = collectCurrentSourceCards(db, { classRoundsFile, logger });

  return db.brainTransaction(() => {
    const { revIds, appended } = appendCardRevisions(db, cards, { createdBy, createdAt: at });

    const live = db.getBrainPointer("live");
    const manifest = safeJson(live?.manifest_json);
    // "ไม่เปลี่ยน" ต้องเทียบชุด revision ที่อ้างถึงจริง ไม่ใช่แค่ tree ของเนื้อหา:
    // หลัง redact เนื้อการ์ดหนึ่งใบ เนื้อชุดใหม่ยัง sha เท่าเดิม (tree ไม่ขยับตามเจตนา)
    // แต่ manifest เดิมยังชี้ rev ที่ถูกลบเนื้อไปแล้ว ซึ่งคอมไพล์ไม่ได้ตลอดกาล
    const sameManifest = live
      && stableJson([...(manifest.revIds ?? [])].sort()) === stableJson([...revIds].sort())
      && stableJson(manifest.pinnedFiles ?? {}) === stableJson(pinned)
      && stableJson([...(manifest.lintAllowlist ?? [])].sort()) === stableJson([...lintAllowlist].sort());
    if (sameManifest) {
      return { created: false, reason: "unchanged", versionId: live.version_id, appended, cards: cards.length, roundsOrigin: origin };
    }

    const counts = cards.reduce((acc, card) => ({ ...acc, [card.kind]: (acc[card.kind] ?? 0) + 1 }), {});
    const version = db.createBrainVersion({
      parentId: live?.version_id ?? null,
      label, status: "draft", revIds, pinnedFiles: pinned, lintAllowlist, counts,
      codeContract: BRAIN_CODE_CONTRACT, createdBy, createdAt: at,
    });

    // คอมไพล์สองรอบโดยเจตนา (ทั้งคู่ทำงานบนการ์ดที่อยู่ในหน่วยความจำแล้ว):
    //   ไม่ใส่วันที่ -> compiled_sha256 ที่ไม่ขยับตามเวลา (เวอร์ชันเดิมต้องได้ sha เดิม)
    //   ใส่วันที่    -> ผล lint ที่ตรงกับสิ่งที่บรรทัด parity ตอนบูตจะเห็น
    const timeless = compileBrain(db, version.version_id, { logger });
    const bundle = compileBrain(db, version.version_id, { todayIso: today, logger });
    db.setBrainVersionCompiledSha(version.version_id, timeless.checksum);

    // ผลด่านต้องมาจากสิ่งที่ตรวจเจอจริง ไม่ใช่คำว่า "pass" ที่เขียนตายตัวไว้
    // (ข้อที่ไม่ได้รับการยกเว้น เช่น L01 คีย์ซ้ำ หรือ L12 คำว่า undefined ที่หลุดมากับ
    //  ข้อมูล เป็น block จริง ๆ — เฟส 1a ยังต้องชี้ live เพื่อให้เทียบเงาได้ จึงบันทึก
    //  การรับทราบไว้ตรง ๆ ว่ารับทราบเพราะอะไร แทนที่จะแกล้งบอกว่าไม่มีอะไรผิด)
    const blocking = bundle.lints.filter((finding) => finding.severity === "block");
    const verdict = blocking.length ? "needs_ack" : "pass";
    db.setBrainVersionGateReport(version.version_id, {
      verdict, kind: "import", compilerVersion: bundle.compilerVersion,
      todayIso: today, findings: bundle.lints,
    });
    if (blocking.length) {
      db.setBrainVersionGateAcks(version.version_id, [{
        by: createdBy, reason: "compat-shadow", at,
        codes: [...new Set(blocking.map((finding) => finding.code))].sort(),
      }]);
    }
    db.setBrainVersionStatus(version.version_id, "validated", { at });
    db.setBrainPointer("live", version.version_id, { changedBy: createdBy, at });
    return {
      created: true, reason: live ? "changed" : "first", versionId: version.version_id,
      appended, cards: cards.length, counts, lints: bundle.lints, verdict, roundsOrigin: origin,
    };
  });
}

/**
 * เขียน revision ให้การ์ดชุดหนึ่ง แล้วคืนรายชื่อ rev ที่ manifest จะอ้างถึง
 *
 * การ์ดที่ "เนื้อ + ขอบเขต + โหมดฉีด" เดิมมีอยู่แล้ว ใช้ rev เดิมต่อ
 * (การเทียบด้วย body_sha256 อย่างเดียวไม่พอ: ปิดสวิตช์ความรู้เปลี่ยนแค่ inject
 *  ซึ่งเปลี่ยน prompt จริง แต่ body เท่าเดิม — เคยทำให้ re-import ตอบ "ไม่เปลี่ยน")
 *
 * ใช้ร่วมกันสองทาง: ตัวนำเข้า (เฟส 1a) และ write hook ของคอนโซล (เฟส 1b) — ทางเขียน
 * revision ต้องมีทางเดียว ไม่งั้น "การ์ดใบเดิม" ของสองทางจะไม่ใช่ใบเดียวกัน
 */
export function appendCardRevisions(db, cards, { createdBy = "system", createdAt = Date.now() } = {}) {
  const revIds = [];
  let appended = 0;
  for (const card of cards) {
    const reusable = db.reusableBrainRev({
      itemId: card.itemId, bodySha256: card.bodySha256,
      inject: card.inject ?? "pin", scope: card.scope,
    });
    if (reusable) { revIds.push(reusable.rev_id); continue; }
    const previous = db.currentBrainRev(card.itemId);
    const rev = db.appendBrainRev({
      itemId: card.itemId, kind: card.kind, key: card.key, body: card.body,
      scope: card.scope, inject: card.inject ?? "pin",
      confidence: card.confidence ?? "confirmed",
      provenance: card.provenance, supersedesRev: previous?.rev_id ?? null,
      createdBy, createdAt,
    });
    revIds.push(rev.rev_id);
    appended += 1;
  }
  return { revIds, appended };
}

function safeJson(text) {
  try { return JSON.parse(String(text || "{}")); } catch { return {}; }
}

/** "วันนี้" ตามเวลาไทย — ตัวเดียวกับที่ pipeline และบรรทัด parity ตอนบูตใช้ */
export function todayInBangkok(atMs = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(atMs));
}
