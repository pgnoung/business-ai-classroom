import test from "node:test";
import assert from "node:assert/strict";
import { brainReadiness, previewGates } from "../src/brain/readiness.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { BRAIN_PARITY_STREAK_KEY } from "../src/brain/parityWatch.mjs";
import { memoryDb, testConfig } from "./helpers.mjs";

const QUIET = { warn() {}, debug() {}, log() {}, error() {} };
const TODAY = todayInBangkok(Date.now());
const CODES = new Set(["G0", "G1", "G2", "G3", "G4", "G5", "G8", "L01", "L02", "L02b", "L03", "L05", "L07", "L11", "L12", "L15", "L16"]);

function expectedCounts(findings) {
  const counts = {};
  for (const finding of findings) {
    if (CODES.has(finding.code)) counts[finding.code] = (counts[finding.code] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

test("readiness reuses the gate preview but returns only fixed, safe summary fields", () => {
  const db = memoryDb();
  const config = testConfig({ KNOWLEDGE_VERSIONED: "false", BRAIN_READ: "legacy" });
  db.addKnowledge({ title: "หนี้เก่า", content: "ลดเหลือ 9,500 บาท", updatedBy: "owner" });
  importCurrentSourcesAsVersion1(db, { createdBy: "owner", logger: QUIET, todayIso: TODAY });
  db.setSetting(BRAIN_PARITY_STREAK_KEY, JSON.stringify({ days: 4, lastDay: TODAY }));
  const before = {
    pointer: db.getBrainPointer("live")?.version_id,
    knowledge: db.listKnowledge().map((row) => `${row.id}:${row.content}`),
    audit: db.listAudit(),
    streak: db.getSetting(BRAIN_PARITY_STREAK_KEY),
  };

  const preview = previewGates(db, { todayIso: TODAY });
  const readiness = brainReadiness({ db, config, todayIso: TODAY });
  assert.equal(readiness.live.exists, true);
  assert.equal(readiness.live.seq, preview.seq);
  assert.equal(preview.cards, preview.cardsById.size, "CLI preview retains its card count");
  assert.ok(preview.cardsById instanceof Map, "CLI preview retains card labels for --verbose");
  assert.deepEqual(readiness.debt.countsByCode, expectedCounts(preview.debt.needsAck));
  assert.equal(readiness.selfEdit.blockingCount, preview.worst.blocking.length);
  assert.equal(readiness.publication.ownerReviewRequired, true);
  assert.equal(readiness.publication.inheritedAckRequired, readiness.debt.pending);
  assert.equal(readiness.activation.status, "not_evaluated");
  assert.equal(readiness.flags.knowledgeVersioned, false);
  assert.equal(readiness.parity.streakDays, 4);
  assert.equal(JSON.stringify(readiness).includes("9,500"), false);
  assert.equal(JSON.stringify(readiness).includes("หนี้เก่า"), false);
  assert.deepEqual({
    pointer: db.getBrainPointer("live")?.version_id,
    knowledge: db.listKnowledge().map((row) => `${row.id}:${row.content}`),
    audit: db.listAudit(),
    streak: db.getSetting(BRAIN_PARITY_STREAK_KEY),
  }, before);
  db.close();
});

test("no live pointer remains an unevaluated read-only status", () => {
  const db = memoryDb();
  const readiness = brainReadiness({ db, config: testConfig({ KNOWLEDGE_VERSIONED: "false" }), todayIso: TODAY });
  assert.deepEqual(readiness.live, { exists: false, seq: null });
  assert.equal(readiness.parity.reason, "no_brain_version");
  assert.deepEqual(readiness.debt.countsByCode, {});
  assert.equal(readiness.publication.ownerReviewRequired, true);
  assert.equal(readiness.publication.inheritedAckRequired, false);
  db.close();
});
