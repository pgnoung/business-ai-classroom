// brain/parity.mjs — "สมองที่คอมไพล์แล้ว ตรงกับสิ่งที่ระบบใช้จริงอยู่ตอนนี้ไหม"
//
// นี่คือเหตุผลทั้งหมดของเฟส 1a: ก่อนจะให้ runtime อ่านสมอง (P2) ต้องพิสูจน์ก่อนว่า
// คอมไพเลอร์ประกอบของออกมาได้ตรงกับทางเดิม "ทุกไบต์" ติดต่อกันหลายคืน
//
// ตัวเทียบคือ **ฟังก์ชันเดิมของ runtime เอง** ไม่ใช่ตรรกะที่ลอกมาเขียนใหม่ —
// ถ้าเทียบกับสำเนา ความผิดที่เหมือนกันทั้งสองฝั่งจะไม่มีวันถูกจับได้
import { composeKnowledgeForChannel } from "../knowledgePack.mjs";
import { composeTagRules, PRODUCT_RULES_KEY } from "../tags.mjs";
import { seatRuleLines, upcomingRounds } from "../classRounds.mjs";
import { hashtagBusinessKeywords } from "../pipeline.mjs";
import { FREECLASS_PATTERNS_KEY } from "../db.mjs";
import { compileBrain, knowledgeBlockFor } from "./compile.mjs";
import { HASHTAG_SILENCE_SETTING } from "./sources.mjs";
import { sha256Json } from "./text.mjs";

// logger ที่กลืนคำเตือน: ตอนเทียบ parity เราเรียกตัวประกอบเดิมซ้ำอีกรอบ ไม่ควรทำให้
// log ของ production มีบรรทัด "ความรู้เกินเพดาน" ซ้ำสองเท่าจนคนอ่านสับสนว่าเกิดสองครั้ง
const QUIET = Object.freeze({ warn() {}, debug() {}, log() {}, error() {} });

/**
 * เทียบ bundle ของเวอร์ชัน live กับสิ่งที่เส้นเดิมประกอบจากตารางเดิม ณ ตอนนี้
 *
 * @returns {{ok: boolean, versionId: string|null, reason: string, mismatches: {part: string, expectedSha: string, actualSha: string}[]}}
 *   expected = ทางเดิม (แหล่งความจริงวันนี้) · actual = สิ่งที่สมองคอมไพล์ออกมา
 *   ไม่มีเวอร์ชัน = ok:true reason:"no_brain_version" (ยังไม่ได้นำเข้า ไม่ใช่ความผิดพลาด)
 */
export function brainParityReport(db, { todayIso = null, classRoundsFile = null, logger = QUIET } = {}) {
  let live = null;
  try {
    live = db.getBrainPointer?.("live") ?? null;
  } catch {
    return { ok: true, versionId: null, reason: "brain_tables_unavailable", mismatches: [] };
  }
  if (!live) {
    // มีเวอร์ชันอยู่แต่ไม่มีอันไหนเป็น live = สมองถูกปลดระวางไปแล้วโดยไม่มีตัวแทน
    // เงียบตรงนี้คือการรายงานว่า "ไม่มีอะไรผิด" ทั้งที่ pointer หายไปกลางทาง
    let versionCount = 0;
    try { versionCount = db.listBrainVersions?.(1)?.length ?? 0; } catch { versionCount = 0; }
    if (versionCount > 0) {
      return {
        ok: false, versionId: null, reason: "no_live_pointer",
        mismatches: [{ part: "pointer.live", expectedSha: "", actualSha: "" }],
      };
    }
    return { ok: true, versionId: null, reason: "no_brain_version", mismatches: [] };
  }

  let bundle;
  try {
    bundle = compileBrain(db, live.version_id, { todayIso, logger });
  } catch (err) {
    return {
      ok: false, versionId: live.version_id, reason: `compile_failed: ${err?.message || err}`,
      mismatches: [{ part: "compile", expectedSha: "", actualSha: "" }],
    };
  }

  const mismatches = compareBundleToLegacy(db, bundle, { todayIso, classRoundsFile, logger });
  return {
    ok: mismatches.length === 0,
    versionId: live.version_id,
    reason: mismatches.length === 0 ? "match" : "mismatch",
    mismatches,
  };
}

/**
 * เทียบ bundle ที่คอมไพล์แล้วกับ "สิ่งที่เส้นเดิมประกอบจากตารางเดิม ณ ตอนนี้" ทีละส่วน
 *
 * แยกออกมาจาก `brainParityReport` เพราะเฟส 1b มีผู้เรียกที่สอง: ตัวฉาย projection
 * ต้องพิสูจน์ตัวเองทันทีหลังเขียนตารางเดิม (ในธุรกรรมเดียวกัน) ว่าเขียนได้ตรงจริง
 * ไม่ใช่รอให้บรรทัด parity ตอนบูตรอบถัดไปมาบอกว่าเพี้ยนไปแล้วทั้งคืน
 *
 * @returns {{part: string, expectedSha: string, actualSha: string}[]} ว่าง = ตรงทุกส่วน
 */
export function compareBundleToLegacy(db, bundle, { todayIso = null, classRoundsFile = null, logger = QUIET } = {}) {
  const mismatches = [];
  const compare = (part, expected, actual) => {
    const expectedSha = sha256Json(expected);
    const actualSha = sha256Json(actual);
    if (expectedSha !== actualSha) mismatches.push({ part, expectedSha, actualSha });
  };

  // 1. บล็อกความรู้ — ทุกช่องทางที่มีการ์ดของตัวเอง บวก default
  for (const channelId of parityChannels(db, bundle)) {
    compare(
      `promptBlocks.knowledge:${channelId}`,
      composeKnowledgeForChannel({ db, channelId, logger }),
      knowledgeBlockFor(bundle, db, channelId),
    );
  }

  // 2. ตารางราคาที่ guard บริโภค
  compare("guardTables.approvedPrices", db.approvedPrices(), bundle.guardTables.approvedPrices);

  // 3. กติกาสินค้า — ทั้งสตริงดิบและบรรทัดที่ถูกฉีดเข้า prompt
  const productRules = db.getSetting(PRODUCT_RULES_KEY) || "";
  compare("rules.productRules", productRules, bundle.rules.productRules);
  compare("rules.productRulesLines", composeTagRules({ tags: [], productRules }), bundle.rules.productRulesLines);

  // 4. ที่นั่ง — เทียบเฉพาะเมื่อผู้เรียกบอก "วันนี้วันไหน" (projection ผูกกับเวลา)
  if (todayIso) {
    compare(
      "rules.seatRuleLines",
      seatRuleLines(upcomingRounds({ file: classRoundsFile, db, todayIso, logger })),
      bundle.rules.seatRuleLines,
    );
  }

  // 5. ลิงก์คลาสฟรี + คีย์เวิร์ด # (ชั้นที่มาจาก DB เท่านั้น — ค่า env ยังเป็น env ในเฟสนี้)
  compare("rules.freeclassPatterns", parseArraySetting(db, FREECLASS_PATTERNS_KEY), bundle.rules.freeclassPatterns);
  compare(
    "rules.hashtag.businessKeywords",
    hashtagBusinessKeywords({ db, config: { hashtagBusinessKeywords: {} } }),
    bundle.rules.hashtag.keywordsConfigured ? bundle.rules.hashtag.businessKeywords : {},
  );
  compare("rules.hashtag.silence", db.getSetting(HASHTAG_SILENCE_SETTING), bundle.rules.hashtag.silence);

  return mismatches;
}

/** บรรทัดเดียวสำหรับ log ตอนบูต — ห้ามมีเนื้อหาความรู้หรือข้อมูลลูกค้าใน log */
export function brainParityLogLine(report) {
  if (!report.versionId) {
    return report.reason === "no_live_pointer"
      ? "[chassis] brain parity: มีเวอร์ชันสมองอยู่แต่ไม่มีรุ่นไหนถูกตั้งเป็น live"
      : `[chassis] brain parity: ${report.reason} (ยังไม่มีเวอร์ชันสมอง)`;
  }
  const head = `[chassis] brain parity: ${report.ok ? "ตรง" : "ไม่ตรง"} version=${report.versionId}`;
  if (report.ok) return head;
  return `${head} ต่างที่: ${report.mismatches.map((m) => m.part).join(", ")}`;
}

function parityChannels(db, bundle) {
  const ids = new Set(["default", ...Object.keys(bundle.promptBlocks.knowledge.byChannel ?? {})]);
  try {
    for (const row of db.raw.prepare("SELECT DISTINCT channel_id FROM knowledge_entries WHERE channel_id IS NOT NULL").all()) {
      ids.add(String(row.channel_id));
    }
  } catch { /* ไม่มีตาราง = ไม่มีสาขาเพิ่ม */ }
  return [...ids].sort();
}

function parseArraySetting(db, key) {
  try {
    const parsed = JSON.parse(db.getSetting(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
