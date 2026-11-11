// brain-gate8.test.mjs — G8: เคสที่เถียงกับตัวเองห้ามบล็อกการเผยแพร่
//
// สิ่งที่เทสต์นี้ต้องกันไว้ให้ได้:
//   - ไม่มีการเรียกโมเดล (fetch วางยาไว้) — G8 เป็น "บัญชี" บนผลของ G5 ไม่ใช่ด่านใหม่ที่ยิงโมเดล
//   - ผลทุกรอบถูกบันทึก ไม่ใช่รอบสุดท้าย (ไม่งั้นคะแนนความไม่นิ่งคิดไม่ได้)
//   - เคสที่ผลไม่ตรงกันเองถูกกักตัว: ไม่บล็อก แต่ไม่เงียบ
//   - อัตราผลบวกปลอมถูกรายงานเป็นตัวเลข ไม่ใช่ความรู้สึก
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";
import { collectCurrentSourceCards } from "../src/brain/sources.mjs";
import { compileCards, sourceCardToCard } from "../src/brain/compile.mjs";
import { BRAIN_CODE_CONTRACT } from "../src/brain/import.mjs";
import { runGate8, FLAKE_QUARANTINE } from "../src/brain/gate8.mjs";
import { brainGateSelfTest } from "../src/brain/gate.mjs";
import { flakeScore } from "../src/brain/goldenStore.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

poisonGlobalFetch();

// คลังเทิร์นตรวจซ้ำปฏิเสธการเขียนเมื่อไม่มีกุญแจของ instance (sha เปล่าย้อนกลับได้)
const GOLDEN_DB = { teachHashSecret: "test-instance-secret" };

const QUIET = { warn() {}, debug() {}, log() {} };
const TODAY = "2026-09-03";

function seed(db) {
  db.addKnowledge({ title: "แคตตาล็อกคลาส", content: "คลาส AI Agent for Business", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 11900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
}

function bundleOf(db) {
  const cards = collectCurrentSourceCards(db, { logger: QUIET }).map(sourceCardToCard);
  return {
    cards,
    bundle: compileCards({
      cards, versionId: "candidate", treeSha256: "t", codeContract: BRAIN_CODE_CONTRACT,
      db, todayIso: TODAY, logger: QUIET,
    }),
  };
}

function seedCase(db, { caseId, output, severity = "lead" }) {
  db.upsertGoldenTurn({
    caseId, title: caseId, syntheticText: "ราคาเท่าไหร่คะ",
    recordedModelOutput: JSON.stringify([output]),
    expected: [], severity, origin: "eval_case", scope: { product: "*" },
  });
}

test("G5 รันรอบเดียว และ invariant 'อินพุตเดิม -> ผลเดิม' ย้ายไปอยู่ที่ G0", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  seedCase(db, { caseId: "probe-a", output: "ราคา 11,900 บาทค่ะ" });
  seedCase(db, { caseId: "probe-b", output: "ราคา 7,777 บาทค่ะ", severity: "irreversible" });
  const before = bundleOf(db);
  db.setApprovedPrice("AI Agent for Business", 12900);
  const after = bundleOf(db);
  const report = runGate8({
    turns: db.listGoldenTurns(), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched: ["price:AI Agent for Business"], db,
    versionId: "v-candidate",
  });
  assert.equal(report.runs, 1, "รันซ้ำ 3 รอบกับชั้น deterministic คืองาน 3 เท่าเพื่อเลขที่รู้คำตอบอยู่แล้ว");
  assert.equal(report.falsePositiveRate, null,
    "ยังไม่มีผลจากโมเดลในบัญชี = ต้องเป็น null ห้ามเป็น 0 ซึ่งอ่านว่า 'วัดแล้วไม่มีปัญหา'");
  assert.equal(db.getEvalBaseline("probe-a", "v-candidate").results.length, 1);
  // invariant ที่เคยเป็นงานของ k-loop ตอนนี้เป็นเงื่อนไขของ G0 — ผิดเมื่อไรบันไดหยุดทั้งชุด
  assert.equal(brainGateSelfTest().ok, true);
  db.close();
});

test("บัญชีความไม่นิ่งเก็บทุกรอบและถึงเกณฑ์กักตัวเมื่อเถียงกันจริง", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  // ผลของด่านที่ใช้โมเดล (G5b / ชุดเต็มรายสัปดาห์) เข้าบัญชีเดียวกันนี้ — คะแนนความไม่นิ่ง
  // ของเคสหนึ่งจึงคิดจากผลจริงทุกรอบไม่ว่ามันมาจากด่านไหน ไม่ใช่บัญชีที่สอง
  db.recordEvalResult({ caseId: "probe-flaky", versionId: "v2", verdict: "pass" });
  db.recordEvalResult({ caseId: "probe-flaky", versionId: "v2", verdict: "fail" });
  db.recordEvalResult({ caseId: "probe-flaky", versionId: "v2", verdict: "pass" });
  const baseline = db.getEvalBaseline("probe-flaky", "v2");
  assert.equal(baseline.results.length, 3);
  assert.ok(baseline.flakeScore >= FLAKE_QUARANTINE,
    `คะแนนความไม่นิ่ง ${baseline.flakeScore} ต้องถึงเกณฑ์กักตัว ${FLAKE_QUARANTINE}`);
  db.close();
});

test("ประวัติของรุ่นอื่นต้องไม่ถอนการบล็อกที่ถูกต้องของรุ่นนี้", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  seedCase(db, { caseId: "probe-a", output: "ราคา 11,900 บาทค่ะ", severity: "irreversible" });
  // รุ่นเก่าเคยสะบัด (เช่นผลจากโมเดลในชุดเต็ม) — ต้องไม่ไหลข้ามมาที่รุ่นใหม่
  db.recordEvalResult({ caseId: "probe-a", versionId: "v-old", verdict: "pass" });
  db.recordEvalResult({ caseId: "probe-a", versionId: "v-old", verdict: "fail" });
  const before = bundleOf(db);
  db.setApprovedPrice("AI Agent for Business", 12900);
  const after = bundleOf(db);
  const report = runGate8({
    turns: db.listGoldenTurns(), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched: ["price:AI Agent for Business"], db, versionId: "v-new",
  });
  assert.equal(report.quarantined.length, 0, "ประวัติของรุ่นอื่นห้ามกักตัวเคสของรุ่นนี้");
  assert.ok(report.blocking.length > 0, "การบล็อกที่ถูกต้องต้องยังอยู่");
  db.close();
});

test("ผลที่สะบัดข้ามรอบในรอบเดียวกัน -> กักตัว + ขึ้นเป็นข้อที่ต้องรับทราบ", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  // เคส floor ถูกเลือกเสมอ ไม่ว่าจะแก้อะไร จึงใช้ทดสอบการกักตัวได้โดยไม่ต้องแก้อะไรเลย
  seedCase(db, { caseId: "probe-a", output: "ราคา 7,777 บาทค่ะ", severity: "irreversible" });
  const { cards, bundle } = bundleOf(db);
  const turns = db.listGoldenTurns();

  // db ปลอมที่ทำให้ recordEvalResult คืนคะแนนความไม่นิ่งสูง = ชั้นล่างเถียงกับตัวเอง
  const shaky = {
    // จำลองบัญชีที่บอกว่าเคสนี้เคยสะบัด (ของจริงมาจากผลของ G5b / ชุดเต็ม)
    recordEvalResult: () => ({ flakeScore: 0.5 }),
    messageBrainContext: () => null,
  };
  const report = runGate8({
    turns, cards, bundle, previousBundle: bundle, touched: [], db: shaky, versionId: "v1",
  });
  assert.equal(report.quarantined.length, 1);
  assert.equal(report.blocking.length, 0, "เคสที่กักตัวห้ามบล็อก");
  assert.ok(report.needsAck.some((f) => f.code === "G8"), "แต่ต้องขึ้นเป็นข้อที่ต้องรับทราบ ไม่ใช่หายไป");
  assert.equal(report.falsePositiveRate, 1);
  db.close();
});

test("ไม่มีอะไรให้เล่นซ้ำ = not_applicable ไม่ใช่ผ่าน", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  const { cards, bundle } = bundleOf(db);
  const report = runGate8({ turns: [], cards, bundle, previousBundle: bundle, touched: [], db });
  assert.equal(report.verdict, "not_applicable");
  db.close();
});

test("คะแนนความไม่นิ่งเป็นสัดส่วนเสียงข้างน้อย", () => {
  assert.equal(flakeScore(["pass", "pass", "fail"]), Number((1 / 3).toFixed(4)));
  assert.equal(flakeScore(["fail", "fail", "fail"]), 0);
});
