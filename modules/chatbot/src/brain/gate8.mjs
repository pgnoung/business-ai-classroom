// brain/gate8.mjs — เคสที่เถียงกับตัวเอง ห้ามมีสิทธิ์บล็อกการเผยแพร่
//
// ปัญหาที่ด่านนี้แก้ (04 §5 + แบบแปลน §7 G8): จาก 28 เคสตกที่ไล่ดูจริง เป็นบั๊ก 8 เกณฑ์ผิด
// 13 เคสเขียนผิด 7 — **71% ไม่ใช่บั๊ก** และผลของโมเดลไม่นิ่งเท่ากันทุกรอบ (concurrency > 4
// ทำให้โมเดลค้างแล้วส่ง template กลับมาเป็นผล "ตก" ปลอม 5/108) ถ้าเคสแบบนั้นบล็อกได้
// ทุกครั้งที่มันสะบัด คนจะเรียนรู้ที่จะกดข้ามด่าน แล้วด่านก็หมดความหมายทั้งชุด
//
// ═══ ทำไม "รัน G5 ซ้ำ k รอบ" ถึงถูกถอนออก (2026-09-03) ═══
//
// G5 เป็น deterministic ล้วน: อินพุตเดียวกันให้ผลเดียวกันเสมอโดยโครงสร้าง การรันซ้ำ 3 รอบ
// จึงเป็นงาน 3 เท่าเพื่อผลิตเลข 0 ที่รู้คำตอบอยู่แล้ว — และ "อัตราผลบวกปลอม = 0" ที่ได้มา
// แบบนั้นก็เป็นตัวเลขที่ไม่ได้วัดอะไรเลย (จริงโดยนิยาม ไม่ใช่จริงเพราะวัด) ซึ่งเป็นความไม่ซื่อสัตย์
// ชนิดเดียวกับที่โครงการนี้พยายามกำจัด
//
// สิ่งที่เข้ามาแทน:
//   - "อินพุตเดิมต้องให้ผลเดิม" ย้ายไปเป็น invariant ของ G0 (เครื่องมือตรวจพิสูจน์ตัวเอง)
//     ถ้าวันไหนมันไม่จริง ด่านทั้งบันไดจะปฏิเสธทำงาน ไม่ใช่รายงานเป็นสถิติ
//   - k-of-n และ flake_score สงวนไว้ให้ผลที่ **มาจากโมเดล** เท่านั้น (G5b / ชุดเต็มรายสัปดาห์)
//     ซึ่งเข้าบัญชีเดียวกันผ่าน `recordEvalResult` — บัญชีเดียว ไม่ใช่สอง
//   - G8 ยังกักตัวเคสที่ประวัติ **ของรุ่นนี้** บอกว่าเถียงกันเอง ก่อนให้มันบล็อกใคร
import { runGate5 } from "./gate5.mjs";
import { BLOCK } from "./lint.mjs";

export const GATE8_ID = "G8";
export const FLAKE_QUARANTINE = 0.3;

/**
 * @param {object} input
 * @param {number} [input.runs] จำนวนรอบ (k) — ต่ำกว่า 2 คือไม่มีอะไรให้เทียบ
 * @returns {{id, verdict, blocking, needsAck, quarantined, falsePositiveRate, summary, runs}}
 */
export function runGate8({
  turns = [], cards = [], bundle = null, previousBundle = null, touched = [],
  db = null, extraRules = [], bannedPhrases = [], versionId = "candidate",
  record = true, previousCards = [],
} = {}) {
  // รอบเดียว — G5 เป็น deterministic การรันซ้ำไม่ให้ข้อมูลใหม่
  const report = runGate5({ turns, cards, bundle, previousBundle, touched, db, extraRules, bannedPhrases, previousCards });
  if (!report.applicable) {
    return {
      id: GATE8_ID, verdict: "not_applicable", blocking: [], needsAck: [], quarantined: [],
      falsePositiveRate: null, runs: 1, summary: { ...report.summary, disagreedCases: 0 },
    };
  }

  const quarantined = [];
  const stable = new Set();
  for (const row of report.cases) {
    const failed = row.newFails.length > 0 || row.oldFails.length > 0;
    // บันทึกผลรอบนี้เข้าบัญชี **ของรุ่นนี้** (คีย์ (case, version)) — ประวัติของรุ่นอื่น
    // ต้องไม่ไหลข้ามมาถอนการบล็อกที่ถูกต้องของรุ่นนี้ หลังคนย้อนกลับแล้วลองใหม่หนึ่งครั้ง
    let flake = 0;
    if (db?.recordEvalResult && record) {
      flake = db.recordEvalResult({
        caseId: row.caseId, versionId, verdict: failed ? "fail" : "pass",
        fails: [...row.newFails, ...row.oldFails],
      })?.flakeScore ?? 0;
    } else if (db?.getEvalBaseline) {
      flake = db.getEvalBaseline(row.caseId, versionId)?.flakeScore ?? 0;
    }
    if (flake >= FLAKE_QUARANTINE) quarantined.push({ caseId: row.caseId, flakeScore: flake });
    else stable.add(row.caseId);
  }

  const keep = (finding) => stable.has(String(finding.cardId));
  const blocking = report.blocking.filter(keep);
  const needsAck = report.needsAck.filter(keep);
  return {
    id: GATE8_ID,
    verdict: blocking.length ? "block" : needsAck.length || quarantined.length ? "needs_ack" : "pass",
    blocking,
    // เคสที่กักตัวไม่ได้หายไปเฉย ๆ — มันกลายเป็นข้อที่ต้องรับทราบว่า "ด่านตอบแทนไม่ได้"
    needsAck: [...needsAck, ...quarantined.map(quarantineFinding)],
    quarantined,
    // null = ยังไม่มีผลจากโมเดลในบัญชีให้คำนวณ — ห้ามรายงาน 0 ซึ่งอ่านว่า "วัดแล้วไม่มีปัญหา"
    falsePositiveRate: quarantined.length ? Number((quarantined.length / report.cases.length).toFixed(4)) : null,
    runs: 1,
    summary: {
      ...report.summary,
      stableCases: stable.size,
      disagreedCases: quarantined.length,
    },
  };
}

function quarantineFinding(row) {
  return {
    code: GATE8_ID,
    severity: BLOCK,
    cardId: row.caseId,
    detail: "flake",
    message: `บทสนทนา ${row.caseId} เคยให้ผลไม่ตรงกันเองบนรุ่นนี้ (คะแนนความไม่นิ่ง ${row.flakeScore})`
      + " — ด่านจึงไม่ให้มันบล็อกการเผยแพร่ แต่เคสนี้ต้องซ่อมก่อนจะเชื่อผลของมันได้อีก",
  };
}

