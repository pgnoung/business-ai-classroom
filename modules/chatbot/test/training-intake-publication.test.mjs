import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLearningDigest, knowledgeDigest } from "../src/learningDigest.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { memoryDb, testConfig } from "./helpers.mjs";

const QUIET = { warn() {}, debug() {}, log() {}, error() {} };
const metadata = { mode: "retrieve", domain: "LINE", offering: "LINE Basic", keywords: ["แท็ก LINE"] };
const batchHash = "a".repeat(64);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function boot({ channels = [] } = {}) {
  const db = memoryDb();
  importCurrentSourcesAsVersion1(db, { createdBy: "test", logger: QUIET, todayIso: todayInBangkok(Date.now()) });
  const config = testConfig({ KNOWLEDGE_VERSIONED: "true", BRAIN_READ: "versioned" });
  Object.assign(config, { trainingIntakeEnabled: true, teachEnabled: true, brainRetrievalEnabled: true });
  return { db, config, learning: createLearningDigest({ db, config, logger: QUIET, channels }) };
}

function evidenceFor({ title, content, channelId = null, batch = batchHash, knowledgeMetadata = metadata, ...rest } = {}) {
  const entryHash = digest({ content, origin: "team_notes", scope: channelId, knowledgeMetadata });
  return { type: "training_intake", schema: "training-intake-v1", origin: "team_notes", batchHash: batch, entryHash, submittedBy: "staff", knowledgeMetadata, ...rest };
}

function candidate(db, { id = `candidate-${Math.random()}`, channelId = null, evidence = null, title = "แท็ก LINE", content = "คำถาม: แท็กคืออะไร\nคำตอบ: ใช้จัดกลุ่มบทสนทนา" } = {}) {
  const item = evidence ?? evidenceFor({ title, content, channelId });
  return db.createLearningCandidate({
    runId: `training-intake:${item.batchHash}`, dayKey: "2026-09-06", clusterKey: `training-intake:${item.entryHash}`,
    channelId, kind: "cluster", title, proposedContent: content, evidence: [item], conflicts: [], riskFlags: [], knowledgeDigest: knowledgeDigest(db),
  });
}

test("approved training intake preserves retrieval provenance", () => {
  const { db, learning } = boot();
  const row = candidate(db);
  const result = learning.decideCandidate(row.id, { action: "approve", operator: "owner" });
  assert.equal(result.ok, true);
  const provenance = JSON.parse(result.entry.provenance_json);
  assert.deepEqual(provenance.knowledge, metadata);
  assert.equal(provenance.type, "training_intake");
  assert.equal(provenance.candidateId, row.id);
  db.close();
});

test("malformed or missing intake evidence fails closed before approval", () => {
  const { db, learning } = boot();
  const malformed = candidate(db, { evidence: { type: "training_intake", schema: "training-intake-v1" } });
  assert.equal(learning.decideCandidate(malformed.id, { action: "approve", operator: "owner" }).code, "intake_evidence_invalid");
  assert.equal(db.getLearningCandidate(malformed.id).status, "proposed");
  const missing = db.createLearningCandidate({
    runId: "training-intake:missing", dayKey: "2026-09-06", clusterKey: "training-intake:missing", kind: "cluster",
    title: "ไม่มีหลักฐาน", proposedContent: "คำถาม: ตัวอย่าง\nคำตอบ: ตัวอย่าง", evidence: [], riskFlags: [], knowledgeDigest: knowledgeDigest(db),
  });
  assert.equal(learning.decideCandidate(missing.id, { action: "approve", operator: "owner" }).code, "intake_evidence_invalid");
  db.close();
});

test("scope, flags, and exact-content collisions cannot silently publish intake knowledge", () => {
  const { db, config, learning } = boot({ channels: [{ id: "line-team", active: true }] });
  db.setSetting("brain_mode:line-team", "separate");
  const scoped = candidate(db, { channelId: "line-team" });
  db.setSetting("brain_mode:line-team", "shared");
  assert.equal(learning.decideCandidate(scoped.id, { action: "approve", operator: "owner" }).code, "intake_scope_stale");

  const riskyEvidence = evidenceFor({ title: "ปลอดภัย", content: "คำถาม: ถาม\nคำตอบ: ทั่วไป", batch: "c".repeat(64), knowledgeMetadata: { ...metadata, keywords: ["ราคา"] } });
  const risky = db.createLearningCandidate({ runId: `training-intake:${riskyEvidence.batchHash}`, dayKey: "2026-09-06", clusterKey: `training-intake:${riskyEvidence.entryHash}`, kind: "cluster", title: "ปลอดภัย", proposedContent: "คำถาม: ถาม\nคำตอบ: ทั่วไป", evidence: [riskyEvidence], riskFlags: [], knowledgeDigest: knowledgeDigest(db) });
  assert.equal(learning.decideCandidate(risky.id, { action: "approve", operator: "owner" }).code, "intake_risk_blocked");

  config.trainingIntakeEnabled = false;
  const disabled = candidate(db, { id: "disabled", evidence: evidenceFor({ title: "แท็ก LINE", content: "คำถาม: แท็กคืออะไร\nคำตอบ: ใช้จัดกลุ่มบทสนทนา", batch: "e".repeat(64) }) });
  assert.equal(learning.decideCandidate(disabled.id, { action: "approve", operator: "owner" }).code, "intake_not_ready");
  db.close();
});

test("same content with different retrieval metadata requires explicit owner reconciliation", () => {
  const { db, learning } = boot();
  const content = "คำถาม: แท็กคืออะไร\nคำตอบ: ใช้จัดกลุ่มบทสนทนา";
  db.addKnowledge({ title: "ความรู้เดิม", content, updatedBy: "owner", provenance: { knowledge: { ...metadata, offering: "คอร์สเก่า" } } });
  const evidence = evidenceFor({ title: "แท็กใหม่", content, batch: "c".repeat(64) });
  const row = candidate(db, { evidence, title: "แท็กใหม่", content });
  assert.equal(learning.decideCandidate(row.id, { action: "approve", operator: "owner" }).code, "existing_knowledge_conflict");
  assert.equal(db.getLearningCandidate(row.id).status, "proposed");
  db.close();
});

test("an intake proposal stays stale after any knowledge change", () => {
  const { db, learning } = boot();
  const row = candidate(db);
  db.addKnowledge({ title: "ภายหลัง", content: "ความรู้ใหม่", updatedBy: "owner" });
  assert.equal(learning.decideCandidate(row.id, { action: "approve", operator: "owner" }).code, "stale_knowledge");
  assert.equal(db.getLearningCandidate(row.id).status, "proposed");
  db.close();
});

test("curated intake content is immutable while an unchanged re-review refreshes its digest", () => {
  const { db, learning } = boot();
  const row = candidate(db);
  assert.equal(learning.decideCandidate(row.id, { action: "edit", title: "แก้หัวข้อ", content: row.proposed_content }).code, "intake_recreate_required");
  assert.equal(learning.decideCandidate(row.id, { action: "edit", title: row.title.replace("LINE", "ＬＩＮＥ"), content: row.proposed_content }).code, "intake_recreate_required");
  assert.equal(db.getLearningCandidate(row.id).title, row.title, "normalization-equivalent edits must not change the hash-bound submitted bytes");
  db.addKnowledge({ title: "ภายนอก", content: "เปลี่ยนคลัง", updatedBy: "owner" });
  const refreshed = learning.decideCandidate(row.id, { action: "edit", title: row.title, content: row.proposed_content });
  assert.equal(refreshed.ok, true);
  assert.equal(learning.decideCandidate(row.id, { action: "approve", operator: "owner" }).ok, true);
  db.close();
});

test("entry hash binds the persisted content and cannot be forged", () => {
  const { db, learning } = boot();
  const row = candidate(db, { evidence: { ...evidenceFor({ title: "แท็ก LINE", content: "คำถาม: แท็กคืออะไร\nคำตอบ: ใช้จัดกลุ่มบทสนทนา" }), entryHash: "0".repeat(64) } });
  assert.equal(learning.decideCandidate(row.id, { action: "approve", operator: "owner" }).code, "intake_entry_hash_mismatch");
  db.close();
});

test("knowledge digest binds metadata even when a writer preserves the row timestamp", () => {
  const row = { id: "fact", title: "หัวข้อ", content: "คำตอบทั่วไป", channel_id: null, source: "human_console", version: 1, updated_at: 1, provenance_json: JSON.stringify({ knowledge: metadata }) };
  const db = { knowledgeRowsForDigest: () => [row] };
  const before = knowledgeDigest(db);
  row.provenance_json = JSON.stringify({ knowledge: { ...metadata, offering: "อีกคลาส" } });
  assert.notEqual(knowledgeDigest(db), before);
});
