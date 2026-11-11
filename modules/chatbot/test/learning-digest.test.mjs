import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfig } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";
import {
  createLearningDigest, knowledgeDigest, learningDigestGlobalEnabled,
  learningRiskFlags, LEARNING_ENABLED_KEY, LEARNING_LAST_RUN_KEY,
} from "../src/learningDigest.mjs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const FIXED_NOW = Date.UTC(2026, 7, 24, 3, 0, 0);
const PREVIOUS_DAY = FIXED_NOW - 24 * 60 * 60_000;
const fixedDb = () => openDb({ file: ":memory:", now: () => FIXED_NOW });

function approvedCorrection(db, {
  customerId = "U-learning", humanFinal = "ลูกแพรแนะนำให้เริ่มจากโจทย์งานซ้ำหนึ่งเรื่องก่อนค่ะ",
} = {}) {
  db.upsertCustomer(customerId, { channelId: "default" });
  const id = db.addCorrection({
    customerId,
    aiDraft: "ร่างเดิม",
    humanFinal,
    reason: "operator corrected answer",
  });
  db.updateCorrection(id, { status: "approved", decidedBy: "owner" });
  db.raw.prepare("UPDATE corrections SET decided_at=?,created_at=? WHERE id=?")
    .run(PREVIOUS_DAY, PREVIOUS_DAY, id);
  return id;
}

function enabledLearning(db, overrides = {}) {
  const config = createConfig({
    LEARNING_DIGEST_ENABLED: "false",
    LEARNING_DIGEST_INTERVAL_MS: "0",
    ...overrides,
  });
  db.setSetting(LEARNING_ENABLED_KEY, "1");
  return createLearningDigest({ config, db, logger: silent, now: () => FIXED_NOW, intervalMs: 0 });
}

function messageOnPreviousDay(db, input) {
  const id = db.insertMessage(input);
  db.raw.prepare("UPDATE messages SET created_at=? WHERE id=?").run(PREVIOUS_DAY, id);
  return id;
}

test("learning config is default-off, capped, and risk scan is deterministic", () => {
  const config = createConfig({ LEARNING_DAILY_USD_CAP: "99" });
  const db = fixedDb();
  assert.equal(config.learningDigestEnabled, false);
  assert.equal(config.learningDailyUsdCap, 0.5);
  assert.equal(learningDigestGlobalEnabled({ db, config }), false);
  assert.deepEqual(learningRiskFlags("ข้อมูลทั่วไปสำหรับเริ่มใช้งาน"), []);
  assert.ok(learningRiskFlags("ราคา 12,900 บาท ผ่อน 10 เดือน").includes("money"));
  assert.ok(learningRiskFlags("ราคา 12,900 บาท ผ่อน 10 เดือน").includes("promotion_or_terms"));
  db.close();
});

test("learning health snapshot distinguishes global enablement, model mode, and interval arming", () => {
  const db = fixedDb();
  const disabled = createLearningDigest({
    config: createConfig({ LEARNING_DIGEST_ENABLED: "false", LEARNING_DIGEST_INTERVAL_MS: "0" }),
    db, logger: silent, intervalMs: 0,
  });
  assert.deepEqual(disabled.healthSnapshot(), {
    enabled: false,
    modelEnabled: false,
    configuredMode: "deterministic_fallback:model_disabled",
    mode: "deterministic_fallback:model_disabled",
    lastRunMode: null,
    lastRunStatus: null,
    armed: false,
    running: false,
    intervalMs: 0,
    lastRunAt: null,
  });

  const modelDisabled = createLearningDigest({
    config: createConfig({ LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "60000" }),
    db, logger: silent,
  });
  assert.equal(modelDisabled.healthSnapshot().enabled, true);
  assert.equal(modelDisabled.healthSnapshot().modelEnabled, false);
  assert.equal(modelDisabled.healthSnapshot().configuredMode, "deterministic_fallback:model_disabled");
  assert.equal(modelDisabled.healthSnapshot().mode, "deterministic_fallback:model_disabled");
  assert.equal(modelDisabled.healthSnapshot().armed, true);
  assert.equal(modelDisabled.healthSnapshot().running, false);

  const modelUnavailable = createLearningDigest({
    config: createConfig({ LEARNING_DIGEST_ENABLED: "true", LEARNING_MODEL_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "60000" }),
    db, logger: silent,
  });
  assert.equal(modelUnavailable.healthSnapshot().modelEnabled, true);
  assert.equal(modelUnavailable.healthSnapshot().mode, "deterministic_fallback:model_unavailable");

  const modelAssisted = createLearningDigest({
    config: createConfig({ LEARNING_DIGEST_ENABLED: "true", LEARNING_MODEL_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "60000" }),
    db, logger: silent, scorer: async () => ({ clusters: [] }),
  });
  assert.equal(modelAssisted.healthSnapshot().mode, "model_assisted");
  db.close();
});

test("learning health running follows start/stop lifecycle exactly", () => {
  const db = fixedDb();
  const learning = createLearningDigest({
    config: createConfig({ LEARNING_DIGEST_ENABLED: "false", LEARNING_DIGEST_INTERVAL_MS: "60000" }),
    db, logger: silent, bootDelayMs: 60000,
  });
  assert.equal(learning.healthSnapshot().running, false);
  assert.equal(learning.start(), true);
  assert.equal(learning.healthSnapshot().running, true);
  assert.equal(learning.start(), false, "start ซ้ำต้องไม่สร้าง timer ซ้อน");
  learning.stop();
  assert.equal(learning.healthSnapshot().running, false);
  db.close();
});

test("disabled digest creates no run, candidate, knowledge, LLM usage, or network work", async () => {
  const db = fixedDb();
  approvedCorrection(db);
  const learning = createLearningDigest({
    config: createConfig({ LEARNING_DIGEST_ENABLED: "false" }),
    db, logger: silent, now: () => FIXED_NOW, intervalMs: 0,
  });
  assert.deepEqual(await learning.runOnce(), { skipped: true, reason: "learning_disabled" });
  assert.equal(db.listLearningRuns().length, 0);
  assert.equal(db.listLearningCandidates({}).length, 0);
  assert.equal(db.listKnowledge().length, 0);
  assert.equal(db.llmUsageSummary(0).length, 0);
  db.close();
});

test("enabled digest proposes an approved correction but cannot write knowledge", async () => {
  const db = fixedDb();
  const correctionId = approvedCorrection(db);
  const learning = enabledLearning(db);
  const result = await learning.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.candidatesCreated, 1);
  assert.equal(db.listKnowledge().length, 0, "proposal generation must not mutate the brain");
  assert.equal(db.llmUsageSummary(0).length, 0, "deterministic stage must record no model call");
  const candidate = learning.snapshot().candidates[0];
  assert.equal(candidate.status, "proposed");
  assert.deepEqual(candidate.evidence, [{ type: "operator_override", id: correctionId, at: PREVIOUS_DAY }]);
  assert.deepEqual(candidate.riskFlags, []);
  assert.equal((await learning.runOnce()).candidatesCreated, 0, "cluster key makes reruns idempotent");
  db.close();
});

test("successful runOnce persists and surfaces the exact operational tick outcome", async () => {
  const db = fixedDb();
  approvedCorrection(db);
  const config = createConfig({
    LEARNING_DIGEST_ENABLED: "true",
    LEARNING_DIGEST_INTERVAL_MS: "60000",
    LEARNING_MODEL_ENABLED: "false",
  });
  const learning = createLearningDigest({
    config, db, logger: silent, now: () => FIXED_NOW,
    intervalMs: 60000, bootDelayMs: 60000,
  });
  assert.equal(learning.start(), true);
  assert.equal(learning.healthSnapshot().running, true);
  const result = await learning.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.run.status, "complete");
  assert.equal(result.run.mode, "deterministic_fallback:model_disabled");
  assert.equal(Number(db.getSetting(LEARNING_LAST_RUN_KEY)), FIXED_NOW);
  assert.equal(db.listLearningRuns(1)[0].id, result.run.id);
  assert.deepEqual(learning.healthSnapshot(), {
    enabled: true,
    modelEnabled: false,
    configuredMode: "deterministic_fallback:model_disabled",
    mode: "deterministic_fallback:model_disabled",
    lastRunMode: "deterministic_fallback:model_disabled",
    lastRunStatus: "complete",
    armed: true,
    running: true,
    intervalMs: 60000,
    lastRunAt: FIXED_NOW,
  });
  learning.stop();
  assert.equal(learning.healthSnapshot().running, false);
  db.close();
});

test("human approval is the only path that inserts learned knowledge with provenance", async () => {
  const db = fixedDb();
  approvedCorrection(db);
  const learning = enabledLearning(db);
  await learning.runOnce();
  const candidate = learning.snapshot().candidates[0];
  const result = learning.decideCandidate(candidate.id, { action: "approve", operator: "owner" });
  assert.equal(result.ok, true);
  assert.equal(result.entry.source, "learning_digest");
  assert.equal(result.entry.active, 1);
  assert.equal(JSON.parse(result.entry.provenance_json).candidateId, candidate.id);
  assert.equal(db.getLearningCandidate(candidate.id).status, "approved");
  assert.equal(db.listKnowledge().length, 1);
  db.close();
});

test("risk, stale digest, and human-authored conflict each block approval", async () => {
  // Risk block.
  const riskyDb = fixedDb();
  approvedCorrection(riskyDb, { humanFinal: "ราคาพิเศษ 12,900 บาท เหลือ 4 ที่นั่งค่ะ" });
  const risky = enabledLearning(riskyDb);
  await risky.runOnce();
  const riskyCandidate = risky.snapshot().candidates[0];
  assert.equal(risky.decideCandidate(riskyCandidate.id, { action: "approve", operator: "owner" }).code, "risk_blocked");
  assert.equal(riskyDb.listKnowledge().length, 0);
  riskyDb.close();

  // Stale digest block.
  const staleDb = fixedDb();
  approvedCorrection(staleDb);
  const stale = enabledLearning(staleDb);
  await stale.runOnce();
  const staleCandidate = stale.snapshot().candidates[0];
  staleDb.addKnowledge({ title: "คนเพิ่มภายหลัง", content: "ห้ามข้อเสนอเก่าข้ามการตรวจใหม่" });
  assert.equal(stale.decideCandidate(staleCandidate.id, { action: "approve", operator: "owner" }).code, "stale_knowledge");
  staleDb.close();

  // Human source always wins on a same-title conflict.
  const conflictDb = fixedDb();
  approvedCorrection(conflictDb);
  const human = conflictDb.addKnowledge({ title: "แนวทางเริ่มต้น", content: "ข้อมูลที่คนยืนยันไว้" });
  const conflict = enabledLearning(conflictDb);
  await conflict.runOnce();
  const conflictCandidate = conflict.snapshot().candidates[0];
  assert.equal(conflict.editCandidate(conflictCandidate.id, {
    title: human.title,
    content: "ข้อเสนอใหม่ที่ไม่ควรทับคน",
  }).ok, true);
  assert.equal(conflict.decideCandidate(conflictCandidate.id, { action: "approve", operator: "owner" }).code, "human_source_conflict");
  assert.equal(conflictDb.listKnowledge().length, 1);
  conflictDb.close();
});

test("weekly rollback deactivates only learned rows and preserves human knowledge", async () => {
  const db = fixedDb();
  const human = db.addKnowledge({ title: "ข้อมูลคน", content: "คงอยู่" });
  approvedCorrection(db);
  const learning = enabledLearning(db);
  await learning.runOnce();
  const candidate = learning.snapshot().candidates[0];
  const applied = learning.decideCandidate(candidate.id, { action: "approve", operator: "owner" });
  assert.equal(applied.ok, true);
  const rollback = learning.rollbackWeek({ operator: "owner" });
  assert.equal(rollback.deactivated, 1);
  assert.equal(db.getKnowledge(human.id).active, 1);
  assert.equal(db.getKnowledge(applied.entry.id).active, 0);
  db.close();
});

test("Stage A uses only prior-day production signals and excludes dashboard-key/training/canary provenance", async () => {
  const db = fixedDb();
  db.upsertCustomer("U-real", { channelId: "default" });
  db.upsertCustomer("U-training", { channelId: "training" });
  db.upsertCustomer("canary:learning", { channelId: "default" });
  messageOnPreviousDay(db, { customerId: "U-real", direction: "out", agentMode: "ai", content: "ขอตรวจสอบข้อมูลก่อนค่ะ" });
  messageOnPreviousDay(db, { customerId: "U-training", direction: "out", agentMode: "ai", content: "ข้อมูลยังไม่ยืนยันค่ะ" });
  messageOnPreviousDay(db, { customerId: "canary:learning", direction: "out", agentMode: "ai", content: "ข้อมูลยังไม่ยืนยันค่ะ" });

  const valid = approvedCorrection(db, { customerId: "U-real", humanFinal: "ให้เริ่มจากงานซ้ำหนึ่งขั้นตอนก่อนค่ะ" });
  const dashboardReason = approvedCorrection(db, { customerId: "U-real", humanFinal: "ข้อความจาก API ห้ามเรียน" });
  db.raw.prepare("UPDATE corrections SET reason='dashboard_key' WHERE id=?").run(dashboardReason);
  const dashboardAudit = approvedCorrection(db, { customerId: "U-real", humanFinal: "ข้อความจาก API เก่า ห้ามเรียน" });
  db.addAudit({ operator: "dashboard-key", action: "correction_add", target: "U-real", detail: `id=${dashboardAudit}` });
  const training = approvedCorrection(db, { customerId: "U-training", humanFinal: "คำตอบใน OA เทรนห้ามเรียน" });

  const config = createConfig({
    LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "0",
    TRAINING_COMMANDS_CHANNELS: "training",
  });
  const learning = createLearningDigest({ config, db, logger: silent, now: () => FIXED_NOW, intervalMs: 0 });
  const result = await learning.runOnce();
  assert.equal(result.ok, true);
  const candidates = learning.snapshot().candidates;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].evidence[0].id, valid);
  assert.notEqual(candidates[0].evidence[0].id, training);
  assert.match(result.run.detail, /dashboard_key_excluded=2/);
  assert.equal(result.run.signals_found, 2, "valid correction + hedge; excluded sources do not become signals");
  assert.equal(db.listKnowledge().length, 0, "Stage A may only propose");
  db.close();
});

test("optional Stage B is bounded, records learning usage, and still cannot auto-apply", async () => {
  const db = fixedDb();
  const correctionId = approvedCorrection(db);
  let calls = 0;
  const scorer = async ({ transcript, model, maxCompletionTokens }) => {
    calls += 1;
    assert.equal(model, "scorer-test");
    assert.equal(maxCompletionTokens, 1500);
    assert.doesNotMatch(transcript, /U-learning/u, "provider prompt uses de-identified refs");
    return {
      model,
      text: JSON.stringify({ clusters: [{
        kind: "correction_pattern",
        title: "แนวทางเริ่มจากงานซ้ำ",
        proposed_content: "แนะนำให้เริ่มจากงานซ้ำหนึ่งเรื่องก่อนค่ะ",
        evidence_refs: ["s1"],
      }] }),
      usage: { prompt_tokens: 120, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 20 } },
    };
  };
  const config = createConfig({
    LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "0",
    LEARNING_MODEL_ENABLED: "true", LEARNING_MODEL: "scorer-test",
    LEARNING_MAX_CLUSTERS: "99", LEARNING_MAX_TOKENS_OUT: "9999",
  });
  const learning = createLearningDigest({
    config, db, logger: silent, now: () => FIXED_NOW, intervalMs: 0, scorer,
    modelPricing: [{ id: "scorer-test", inUsdPerM: 1, outUsdPerM: 2, verified: true }],
  });
  const result = await learning.runOnce();
  assert.equal(calls, 1);
  assert.equal(config.learningMaxClusters, 10);
  assert.equal(config.learningMaxTokensOut, 1500);
  assert.equal(result.run.mode, "model_assisted");
  assert.equal(result.run.llm_calls, 1);
  assert.equal(result.run.tokens_in, 120);
  assert.equal(result.run.tokens_out, 80);
  assert.equal(result.candidatesCreated, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE kind='learning'").get().n, 1);
  assert.equal(db.listKnowledge().length, 0);
  assert.equal(learning.snapshot().candidates[0].evidence[0].id, correctionId);
  const rerun = await learning.runOnce();
  assert.equal(rerun.reason, "day_already_processed");
  assert.equal(calls, 1, "a completed model-assisted day must not spend again");
  db.close();
});

test("Stage B strips every risky signal before crossing the model boundary", async () => {
  const db = fixedDb();
  approvedCorrection(db, {
    customerId: "U-safe-learning",
    humanFinal: "คุณมินท์เริ่มจากงานซ้ำหนึ่งเรื่องก่อนค่ะ",
  });
  approvedCorrection(db, {
    customerId: "U-risky-learning",
    humanFinal: "โทร 0812345678 หรือส่งที่ private@example.com ราคา 12,900 บาทค่ะ",
  });
  let transcriptSeen = "";
  const config = createConfig({
    LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "0",
    LEARNING_MODEL_ENABLED: "true", LEARNING_MODEL: "scorer-test",
  });
  const learning = createLearningDigest({
    config, db, logger: silent, now: () => FIXED_NOW, intervalMs: 0,
    scorer: async ({ transcript, model }) => {
      transcriptSeen = transcript;
      return {
        model, text: JSON.stringify({ clusters: [] }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
    modelPricing: [{ id: "scorer-test", inUsdPerM: 1, outUsdPerM: 1, verified: true }],
  });
  const result = await learning.runOnce();
  assert.equal(result.run.llm_calls, 1);
  assert.match(transcriptSeen, /"type":"operator_override"/u);
  assert.match(transcriptSeen, /"length_band":"short"/u);
  assert.doesNotMatch(transcriptSeen, /"text":/u);
  assert.doesNotMatch(transcriptSeen, /คุณมินท์|งานซ้ำหนึ่งเรื่อง/u,
    "even text that does not match the risk classifier remains local");
  assert.doesNotMatch(transcriptSeen, /0812345678|private@example\.com|12,900/u);
  db.close();
});

test("Stage B makes no provider call when every signal is risk-filtered", async () => {
  const db = fixedDb();
  approvedCorrection(db, {
    humanFinal: "ติดต่อ private@example.com และชำระ 12,900 บาทค่ะ",
  });
  let calls = 0;
  const config = createConfig({
    LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "0",
    LEARNING_MODEL_ENABLED: "true", LEARNING_MODEL: "scorer-test",
  });
  const learning = createLearningDigest({
    config, db, logger: silent, now: () => FIXED_NOW, intervalMs: 0,
    scorer: async () => { calls += 1; return null; },
    modelPricing: [{ id: "scorer-test", inUsdPerM: 1, outUsdPerM: 1, verified: true }],
  });
  const result = await learning.runOnce();
  assert.equal(calls, 0);
  assert.equal(result.run.llm_calls, 0);
  assert.equal(result.run.mode, "deterministic_fallback:risk_filtered");
  assert.equal(learning.healthSnapshot().configuredMode, "model_assisted");
  assert.equal(learning.healthSnapshot().mode, "deterministic_fallback:risk_filtered");
  assert.equal(learning.healthSnapshot().lastRunMode, "deterministic_fallback:risk_filtered");
  assert.equal(learning.healthSnapshot().lastRunStatus, "complete");
  assert.equal(db.listAudit().some((row) => row.action === "learning_model_input_filtered"), true);
  db.close();
});

test("learning health reports the persisted model failure instead of configured capability", async () => {
  const db = fixedDb();
  approvedCorrection(db);
  const config = createConfig({
    LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "0",
    LEARNING_MODEL_ENABLED: "true", LEARNING_MODEL: "scorer-test",
  });
  const learning = createLearningDigest({
    config, db, logger: silent, now: () => FIXED_NOW, intervalMs: 0,
    scorer: async () => null,
    modelPricing: [{ id: "scorer-test", inUsdPerM: 1, outUsdPerM: 1, verified: true }],
  });
  const result = await learning.runOnce();
  assert.equal(result.run.mode, "deterministic_fallback:model_failed");
  assert.equal(learning.healthSnapshot().configuredMode, "model_assisted");
  assert.equal(learning.healthSnapshot().mode, "deterministic_fallback:model_failed");
  assert.equal(learning.healthSnapshot().lastRunMode, "deterministic_fallback:model_failed");
  assert.equal(learning.healthSnapshot().lastRunStatus, "complete");
  db.close();
});

test("model preflight stops before call when projected daily cost exceeds $0.50", async () => {
  const db = fixedDb();
  approvedCorrection(db);
  let calls = 0;
  const config = createConfig({
    LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "0",
    LEARNING_MODEL_ENABLED: "true", LEARNING_MODEL: "costly",
    LEARNING_DAILY_USD_CAP: "0.5",
  });
  const learning = createLearningDigest({
    config, db, logger: silent, now: () => FIXED_NOW, intervalMs: 0,
    scorer: async () => { calls += 1; return null; },
    modelPricing: [{ id: "costly", inUsdPerM: 1000, outUsdPerM: 1000, verified: true }],
  });
  const result = await learning.runOnce();
  assert.equal(calls, 0);
  assert.match(result.run.mode, /budget_stop_daily_cap/u);
  assert.equal(result.run.llm_calls, 0);
  assert.equal(db.listAudit().some((row) => row.action === "learning_budget_stop"), true);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE kind='learning'").get().n, 0);
  assert.equal(result.candidatesCreated, 1, "safe deterministic correction fallback remains available");
  db.close();
});

test("KPI receipt and probe export use de-identified ids and never log raw customer text", async () => {
  const db = fixedDb();
  db.upsertCustomer("U-private-probe", { channelId: "default" });
  const rawQuestion = "อยากเริ่มใช้ AI กับงานซ้ำ ต้องเริ่มอย่างไรคะ?";
  const rawMessageId = messageOnPreviousDay(db, {
    id: "raw-provider-message-123", customerId: "U-private-probe", direction: "in", content: rawQuestion,
  });
  messageOnPreviousDay(db, {
    customerId: "U-private-probe", direction: "out", agentMode: "ai", content: "ขอตรวจสอบข้อมูลก่อนค่ะ",
  });
  const note = db.addHandoffNote({ customerId: "U-private-probe", author: "ai_promise", text: "private note" });
  db.raw.prepare("UPDATE handoff_notes SET created_at=? WHERE id=?").run(PREVIOUS_DAY, note.id);
  db.addLlmUsage({ customerId: "U-private-probe", kind: "draft", model: "m", tokensIn: 100, tokensOut: 10, cachedIn: 40 });
  db.raw.prepare("UPDATE llm_usage SET created_at=?").run(PREVIOUS_DAY);

  const logs = [];
  const logger = { log(value) { logs.push(String(value)); }, warn(value) { logs.push(String(value)); }, error(value) { logs.push(String(value)); } };
  const config = createConfig({ LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "0" });
  const learning = createLearningDigest({ config, db, logger, now: () => FIXED_NOW, intervalMs: 0, modelPricing: [] });
  const result = await learning.runOnce();
  const exported = learning.exportProbeSet();
  assert.equal(result.run.hedge_rate, 1);
  assert.equal(result.run.promise_notes_per_100, 100);
  assert.equal(result.run.cache_hit_rate, 0.4);
  assert.equal(result.run.probe_count, 1);
  assert.equal(exported.probes.length, 1);
  assert.equal(exported.probes[0].question, rawQuestion);
  assert.equal(exported.probes[0].id.length, 64);
  const exportJson = JSON.stringify(exported);
  assert.doesNotMatch(exportJson, /U-private-probe|raw-provider-message-123/u);
  assert.doesNotMatch(JSON.stringify(db.listAudit()), new RegExp(rawQuestion, "u"));
  assert.doesNotMatch(logs.join("\n"), new RegExp(rawQuestion, "u"));
  assert.equal(rawMessageId, "raw-provider-message-123");
  db.close();
});

test("old llm_usage schema migrates additively and accepts learning usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-learning-migration-"));
  const file = join(dir, "old.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE llm_usage (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('draft','score','followup','staged_followup')),
      model TEXT NOT NULL DEFAULT '', tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0, cached_in INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    INSERT INTO llm_usage VALUES ('old','U1','draft','m',4,2,3,1);
    CREATE TABLE learning_runs (
      id TEXT PRIMARY KEY, day_key TEXT NOT NULL,
      signals_found INTEGER NOT NULL DEFAULT 0, clusters INTEGER NOT NULL DEFAULT 0,
      llm_calls INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0, usd REAL NOT NULL DEFAULT 0,
      candidates_created INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running', knowledge_digest TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, completed_at INTEGER
    );
  `);
  old.close();
  const db = openDb({ file });
  const previous = db.raw.prepare("SELECT * FROM llm_usage WHERE id='old'").get();
  assert.equal(previous.cached_in, 3);
  db.addLlmUsage({ customerId: "", kind: "learning", model: "none", tokensIn: 0, tokensOut: 0 });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE kind='learning'").get().n, 1);
  const learningColumns = new Set(db.raw.prepare("PRAGMA table_info(learning_runs)").all().map((row) => row.name));
  for (const column of [
    "mode", "hedge_rate", "promise_notes_per_100", "operator_override_per_100",
    "knowledge_chars", "cache_hit_rate", "probe_count",
  ]) assert.equal(learningColumns.has(column), true, `${column} must migrate additively`);
  db.close();
  openDb({ file }).close(); // The same additive migration must be idempotent.
  rmSync(dir, { recursive: true, force: true });
});

test("console learning route is owner-gated, CSRF-protected, and auditable", async (t) => {
  const db = fixedDb();
  db.createOperator({
    username: "owner", passHash: hashPassword("owner-pass-123"), displayName: "Owner", role: "owner",
  });
  db.createOperator({
    username: "admin", passHash: hashPassword("admin-pass-123"), displayName: "Admin", role: "admin",
  });
  db.createOperator({
    username: "operator", passHash: hashPassword("operator-pass-123"), displayName: "Operator", role: "operator",
  });
  approvedCorrection(db);
  const config = testConfig({
    CONSOLE_SESSION_SECRET: "learning-console-secret-123456",
    LEARNING_DIGEST_ENABLED: "false",
    LEARNING_DIGEST_INTERVAL_MS: "0",
    TRAINING_COMMANDS_CHANNELS: "training",
  });
  const learningDigest = createLearningDigest({ config, db, logger: silent, now: () => FIXED_NOW, intervalMs: 0 });
  const app = createApp({
    config,
    db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      learningDigest,
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "owner-pass-123" }),
  });
  const cookie = (login.headers["set-cookie"]?.[0] || "").split(";")[0];
  const headers = { cookie, "content-type": "application/json", "x-csrf-token": login.json.csrf };
  assert.equal((await httpRequest(app.server, { path: "/console/api/learning" })).status, 401);
  const probes = await httpRequest(app.server, { path: "/console/api/learning/probes", headers: { cookie } });
  assert.equal(probes.status, 200);
  assert.deepEqual(probes.json.probes, []);
  assert.equal((await httpRequest(app.server, {
    method: "POST", path: "/console/api/learning/toggle", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  })).status, 403);
  assert.equal((await httpRequest(app.server, {
    method: "POST", path: "/console/api/learning/toggle", headers,
    body: JSON.stringify({ enabled: true }),
  })).status, 200);
  const run = await httpRequest(app.server, {
    method: "POST", path: "/console/api/learning/run", headers, body: "{}",
  });
  assert.equal(run.status, 200);
  assert.equal(run.json.candidates.length, 1);
  const candidateId = run.json.candidates[0].id;
  for (const [username, password] of [["admin", "admin-pass-123"], ["operator", "operator-pass-123"]]) {
    const nonOwnerLogin = await httpRequest(app.server, {
      method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const nonOwnerCookie = (nonOwnerLogin.headers["set-cookie"]?.[0] || "").split(";")[0];
    const nonOwnerHeaders = {
      cookie: nonOwnerCookie,
      "content-type": "application/json",
      "x-csrf-token": nonOwnerLogin.json.csrf,
    };
    const auditCountBeforeDecision = db.listAudit().length;
    assert.equal((await httpRequest(app.server, {
      path: "/console/api/learning/probes", headers: { cookie: nonOwnerCookie },
    })).status, 403);
    const denied = await httpRequest(app.server, {
      method: "POST", path: `/console/api/learning/${candidateId}/decide`, headers: nonOwnerHeaders,
      body: JSON.stringify({ action: "approve" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(db.listLearningCandidates({}).find((candidate) => candidate.id === candidateId).status, "proposed");
    assert.equal(db.listKnowledge().length, 0);
    assert.equal(db.listAudit().length, auditCountBeforeDecision);
  }
  const decision = await httpRequest(app.server, {
    method: "POST", path: `/console/api/learning/${candidateId}/decide`, headers,
    body: JSON.stringify({ action: "approve" }),
  });
  assert.equal(decision.status, 200);
  assert.equal(db.listAudit().some((row) => row.action === "learning_approve"), true);
});
