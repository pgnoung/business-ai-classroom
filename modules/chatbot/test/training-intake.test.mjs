import test from "node:test";
import assert from "node:assert/strict";
import { createTrainingIntakeService } from "../src/trainingIntake.mjs";
import { createLearningDigest } from "../src/learningDigest.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { memoryDb, testConfig } from "./helpers.mjs";

const QUIET = { warn() {}, debug() {}, log() {}, error() {} };
const metadata = { mode: "retrieve", domain: "LINE", offering: "LINE Basic", keywords: ["แท็ก LINE"] };
const input = (entries = [{ title: "แท็ก LINE", question: "แท็กคืออะไร", answer: "ใช้จัดกลุ่มบทสนทนา" }]) => ({
  origin: "team_notes", channelId: null, knowledgeMetadata: metadata, entries,
});

function readyDb() {
  const db = memoryDb();
  importCurrentSourcesAsVersion1(db, { createdBy: "test", logger: QUIET, todayIso: todayInBangkok(Date.now()) });
  const config = testConfig({ KNOWLEDGE_VERSIONED: "true", BRAIN_READ: "versioned" });
  config.brainRetrievalEnabled = true;
  config.teachEnabled = true;
  config.trainingIntakeEnabled = true;
  return { db, config };
}

test("training intake preview is deterministic and never writes", () => {
  const { db, config } = readyDb();
  const service = createTrainingIntakeService({ db, config });
  const before = db.listLearningCandidates({ limit: 100 }).length;
  const preview = service.preview(input());
  assert.equal(preview.ok, true);
  assert.equal(preview.canCommit, true);
  assert.equal(db.listLearningCandidates({ limit: 100 }).length, before);
  db.close();
});

test("commit binds the exact preview, dedupes an independently reordered batch, and remains unpublished", () => {
  const { db, config } = readyDb();
  const service = createTrainingIntakeService({ db, config });
  const rows = [
    { title: "แท็ก LINE", question: "แท็กคืออะไร", answer: "ใช้จัดกลุ่มบทสนทนา" },
    { title: "ตอบแชท", question: "ตอบอย่างไร", answer: "อ่านคำถามก่อนตอบ" },
  ];
  const firstInput = input(rows);
  const preview = service.preview(firstInput);
  const first = service.commit({ body: firstInput, previewHash: preview.previewHash, submittedBy: "staff" });
  assert.equal(first.created, 2);
  assert.equal(first.published, false);
  const reordered = input([...rows].reverse());
  const secondPreview = service.preview(reordered);
  const second = service.commit({ body: reordered, previewHash: secondPreview.previewHash, submittedBy: "staff" });
  assert.equal(second.created, 0);
  assert.equal(second.duplicates, 2);
  assert.throws(() => service.commit({ body: firstInput, previewHash: "old", submittedBy: "staff" }), { code: "stale_preview" });
  db.close();
});

test("risky text is not reflected from preview and audit failure rolls candidate writes back", () => {
  const { db, config } = readyDb();
  const service = createTrainingIntakeService({ db, config });
  const risky = service.preview(input([{ title: "ติดต่อ", question: "โทร 0812345678", answer: "ข้อมูลทีม" }]));
  assert.equal(risky.rows[0].index, 0);
  assert.ok(risky.rows[0].issueCodes.includes("personal_or_financial_data"));
  assert.ok(risky.rows[0].issueCodes.includes("privacy_refusal"));
  assert.equal(Object.hasOwn(risky.rows[0], "content"), false);
  assert.equal(risky.canCommit, false);
  const safe = input();
  const preview = service.preview(safe);
  const originalAudit = db.addAudit;
  db.addAudit = () => { throw new Error("audit unavailable"); };
  assert.throws(() => service.commit({ body: safe, previewHash: preview.previewHash, submittedBy: "staff" }));
  db.addAudit = originalAudit;
  assert.equal(db.listLearningCandidates({ limit: 100 }).length, 0);
  db.close();
});

test("metadata clears the same risk and privacy boundary before any row is previewed", () => {
  const { db, config } = readyDb();
  const service = createTrainingIntakeService({ db, config });
  assert.throws(() => service.preview({
    ...input(),
    knowledgeMetadata: { ...metadata, keywords: ["โทร 0812345678"] },
  }), { code: "risk_rejected" });
  db.close();
});

test("dedupe ignores title but keeps metadata and scope as knowledge identity", () => {
  const { db, config } = readyDb();
  const service = createTrainingIntakeService({ db, config });
  const firstBody = input([{ title: "ชื่อแรก", question: "ถาม", answer: "ตอบ" }]);
  const firstPreview = service.preview(firstBody);
  const first = service.commit({ body: firstBody, previewHash: firstPreview.previewHash, submittedBy: "staff" });
  assert.equal(first.created, 1);
  const renamed = input([{ title: "ชื่อใหม่", question: "ถาม", answer: "ตอบ" }]);
  const renamedPreview = service.preview(renamed);
  assert.equal(renamedPreview.rows[0].duplicate, true);
  const renamedCommit = service.commit({ body: renamed, previewHash: renamedPreview.previewHash, submittedBy: "staff" });
  assert.equal(renamedCommit.duplicates, 1);
  const otherMetadata = {
    ...renamed,
    knowledgeMetadata: { ...metadata, offering: "LINE Advanced", keywords: ["แท็กขั้นสูง"] },
  };
  const otherPreview = service.preview(otherMetadata);
  assert.equal(otherPreview.rows[0].duplicate, false);
  db.close();
});

test("multiline CSV fields normalize CRLF and the service refuses direct use while disabled", () => {
  const { db, config } = readyDb();
  const service = createTrainingIntakeService({ db, config });
  const windows = input([{ title: "หลายบรรทัด", question: "บรรทัดหนึ่ง\r\nบรรทัดสอง\t", answer: "คำตอบ\r\nต่อเนื่อง" }]);
  const unix = input([{ title: "หลายบรรทัด", question: "บรรทัดหนึ่ง\nบรรทัดสอง\t", answer: "คำตอบ\nต่อเนื่อง" }]);
  assert.equal(service.preview(windows).previewHash, service.preview(unix).previewHash);
  assert.throws(() => service.preview(input([{ title: "หัวข้อ\nใหม่", question: "ถาม", answer: "ตอบ" }])), { code: "invalid_input" });
  config.trainingIntakeEnabled = false;
  assert.throws(() => service.preview(input()), { code: "intake_disabled" });
  db.close();
});


test("legacy Brain-off intake creates only a candidate and needs re-review after readiness", () => {
  const db = memoryDb();
  const config = testConfig({ TRAINING_INTAKE_ENABLED: "true", TEACH_ENABLED: "true" });
  Object.assign(config, { trainingIntakeEnabled: true, teachEnabled: true, brainRetrievalEnabled: false, knowledgeVersioned: false, brainRead: "legacy" });
  const service = createTrainingIntakeService({ db, config });
  const original = input([{ title: "แท็ก LINE", question: "แท็กคืออะไร", answer: "ใช้จัดกลุ่มบทสนทนา" }]);
  const preview = service.preview(original);
  const committed = service.commit({ body: original, previewHash: preview.previewHash, submittedBy: "staff" });
  const first = db.getLearningCandidate(committed.candidateIds[0]);
  assert.equal(db.listKnowledge().length, 0);
  assert.equal(db.getBrainPointer("live")?.version_id, undefined);
  assert.equal(db.listAudit().filter((row) => row.action === "training_intake_commit").length, 1);

  const learning = createLearningDigest({ db, config, logger: QUIET });
  assert.equal(learning.decideCandidate(first.id, { action: "approve", operator: "owner" }).code, "intake_not_ready");
  assert.equal(learning.decideCandidate(first.id, { action: "supersede", operator: "owner" }).code, "intake_not_ready");
  assert.equal(learning.decideCandidate(first.id, { action: "edit", title: first.title, content: first.proposed_content }).code, "intake_not_ready");
  assert.equal(learning.decideCandidate(first.id, { action: "reject", operator: "owner" }).ok, true);

  const revised = input([{ title: "แท็ก LINE เพิ่ม", question: "แท็กต่างจากกลุ่มอย่างไร", answer: "ใช้จัดกลุ่มบทสนทนา" }]);
  const revisedPreview = service.preview(revised);
  const revisedCommit = service.commit({ body: revised, previewHash: revisedPreview.previewHash, submittedBy: "staff" });
  const pending = db.getLearningCandidate(revisedCommit.candidateIds[0]);
  const evidenceBefore = JSON.parse(pending.evidence_json);
  Object.assign(config, { brainRetrievalEnabled: true, knowledgeVersioned: true, brainRead: "versioned" });
  importCurrentSourcesAsVersion1(db, { createdBy: "owner", logger: QUIET, todayIso: todayInBangkok(Date.now()) });
  db.addKnowledge({ title: "เปลี่ยนคลังหลังตรวจ", content: "ข้อมูลทั่วไปที่ไม่ซ้ำข้อเสนอ", updatedBy: "owner" });
  assert.equal(learning.decideCandidate(pending.id, { action: "approve", operator: "owner" }).code, "stale_knowledge");
  assert.equal(learning.decideCandidate(pending.id, { action: "edit", title: pending.title, content: pending.proposed_content }).ok, true);
  assert.equal(learning.decideCandidate(pending.id, { action: "approve", operator: "owner" }).ok, true);
  assert.deepEqual(JSON.parse(db.getLearningCandidate(pending.id).evidence_json), evidenceBefore);
  db.close();
});

test("a separate-channel scope flip is rejected before an old preview can commit", () => {
  const { db, config } = readyDb();
  const channels = [{ id: "branch-a", active: true }];
  db.setSetting("brain_mode:branch-a", "separate");
  const service = createTrainingIntakeService({ db, config, channels });
  const branchBody = { ...input(), channelId: "branch-a" };
  const preview = service.preview(branchBody);
  db.setSetting("brain_mode:branch-a", "shared");
  assert.throws(() => service.commit({ body: branchBody, previewHash: preview.previewHash, submittedBy: "staff" }), { code: "invalid_scope" });
  db.close();
});

test("commit revalidates knowledge inside the candidate transaction", () => {
  const { db, config } = readyDb();
  const service = createTrainingIntakeService({ db, config });
  const body = input();
  const preview = service.preview(body);
  const transact = db.brainTransaction.bind(db);
  db.brainTransaction = (write) => transact(() => {
    db.addKnowledge({ title: "เปลี่ยนระหว่างรอ", content: "ข้อมูลทั่วไปชุดใหม่", updatedBy: "owner" });
    return write();
  });
  assert.throws(() => service.commit({ body, previewHash: preview.previewHash, submittedBy: "staff" }), { code: "stale_preview" });
  assert.equal(db.listLearningCandidates({ limit: 100 }).length, 0);
  db.close();
});
