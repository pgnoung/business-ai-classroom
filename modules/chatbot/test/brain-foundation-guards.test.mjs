import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";
import { createBrainWriteHook } from "../src/brain/writeHook.mjs";
import { assertBrainReadConfig, createBrainRuntime } from "../src/brain/runtime.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";

poisonGlobalFetch();
const silent = { log() {}, debug() {}, info() {}, warn() {}, error() {} };

test("retrieval is off by default and cannot run against legacy or unversioned writes", () => {
  assert.equal(testConfig().brainRetrievalEnabled, false);
  const enabled = testConfig({ BRAIN_RETRIEVAL_ENABLED: "true" });
  assert.equal(enabled.brainRetrievalEnabled, true);
  assert.throws(() => assertBrainReadConfig({ config: enabled }), /BRAIN_READ=versioned/u);
  assert.throws(() => assertBrainReadConfig({ config: {
    ...enabled, brainRead: "versioned", knowledgeVersioned: false,
  } }), /KNOWLEDGE_VERSIONED/u);
  assert.deepEqual(assertBrainReadConfig({ config: {
    ...enabled, brainRead: "versioned", knowledgeVersioned: true,
  } }), { ok: true, reason: "versioned" });
});

test("retrieval holds an unsupported current contract rather than selecting a retired brain", () => {
  const db = memoryDb();
  try {
    db.addKnowledge({ title: "ข้อมูลเดิม", content: "ข้อมูลที่เคยอนุมัติ" });
    importCurrentSourcesAsVersion1(db, { logger: silent });
    const realPointer = db.getBrainPointer.bind(db);
    const old = realPointer("live");
    const unsupported = { ...old, version_id: "future-version", code_contract: "future-contract" };
    db.getBrainPointer = (role) => role === "live" ? unsupported : realPointer(role);
    let fallbackReads = 0;
    db.listBrainVersions = () => { fallbackReads += 1; return [{ ...old, status: "retired" }]; };
    const alerts = [];
    const runtime = createBrainRuntime({
      db, config: { brainRead: "versioned", knowledgeVersioned: true, brainRetrievalEnabled: true, brainFallbackAlertStreak: 1 },
      notifier: { fireLater: (value) => alerts.push(value) }, logger: silent,
    });
    assert.equal(runtime.resolve("synthetic", "default"), null);
    assert.equal(fallbackReads, 0, "do not search withdrawn versions for a replacement");
    assert.equal(runtime.snapshot().contractFallbacks, 0);
    assert.ok(alerts.some((value) => /พักการร่าง/u.test(value.reasonTextOverride)));
    assert.equal(alerts.some((value) => /ยังได้รับคำตอบตามปกติ/u.test(value.reasonTextOverride)), false);
  } finally { db.close(); }
});

test("legacy console write rolls back its knowledge when the audit write fails", () => {
  const db = memoryDb();
  try {
    const hook = createBrainWriteHook({ db, config: {}, logger: silent });
    db.addAudit = () => { throw new Error("synthetic audit failure"); };
    assert.throws(() => hook.apply({
      kind: "knowledge_add", username: "test-owner",
      audit: { action: "knowledge_add", target: "synthetic" },
      apply: () => db.addKnowledge({ title: "ที่จอดรถ", content: "ใช้ประตูด้านข้าง" }),
    }), /synthetic audit failure/u);
    assert.equal(db.listKnowledge().length, 0, "a failed request must not leave unaudited knowledge active");
  } finally { db.close(); }
});

test("legacy command failure rolls back all prior mutations in that command", () => {
  const db = memoryDb();
  try {
    const hook = createBrainWriteHook({ db, config: {}, logger: silent });
    assert.throws(() => hook.apply({
      kind: "knowledge_add", username: "test-owner",
      audit: { action: "knowledge_add" },
      apply: () => {
        db.addKnowledge({ title: "จุดต้อนรับ", content: "ติดต่อชั้นล่าง" });
        throw new Error("synthetic command failure");
      },
    }), /synthetic command failure/u);
    assert.equal(db.listKnowledge().length, 0);
    assert.equal(db.listAudit().length, 0);
  } finally { db.close(); }
});

test("successful legacy console writes preserve their result and original audit shape", () => {
  const db = memoryDb();
  try {
    const hook = createBrainWriteHook({ db, config: {}, logger: silent });
    const audit = { action: "knowledge_add", target: "", detail: "ข้อมูลตัวอย่าง" };
    const result = hook.apply({
      kind: "knowledge_add", username: "test-owner", audit,
      apply: () => {
        const row = db.addKnowledge({ title: "ที่จอดรถ", content: "ใช้ประตูด้านข้าง" });
        audit.target = row.id;
        return row;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "off");
    assert.equal(Object.hasOwn(result, "versionId"), false);
    assert.equal(db.listKnowledge().length, 1);
    const rows = db.listAudit();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, result.applied.id);
    assert.equal(rows[0].detail, audit.detail);
    assert.equal(rows[0].operator, "test-owner");
  } finally { db.close(); }
});
