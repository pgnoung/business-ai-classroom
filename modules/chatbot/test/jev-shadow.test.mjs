import test from "node:test";
import assert from "node:assert/strict";
import { createJevShadow, parseJevAnswer, redactShadowTranscript, JEV_MODEL } from "../src/jevShadow.mjs";
import { shadowReport } from "../src/jevShadowReport.mjs";
import { createApp } from "../src/server.mjs";
import { memoryDb, poisonGlobalFetch, testConfig, hermesFetchStub, lineFetchStub } from "./helpers.mjs";
poisonGlobalFetch();
const ts = Date.parse("2026-09-21T12:00:00+07:00");
const silent = { warn() {}, error() {}, log() {}, debug() {} };
const answer = () => ({ model: JEV_MODEL, answers: {
  readiness: { type: "score", score: 4, confidence: 0.9, probabilities: { 0:0, 1:0, 2:0, 3:0, 4:1, 5:0 } },
  sufficient: { type: "noul", noul: 0.9 }, production_only: { type: "noul", noul: 0.1 }, budget_constraint: { type: "noul", noul: 0.2 },
}, usage: { input_tokens: 1000, output_tokens: 20 } });
function setup({ fetchImpl = async () => ({ ok: true, json: async () => answer() }), enabled = true, key = "fixture", limit = 250 } = {}) {
  const db = memoryDb({ now: () => ts });
  db.upsertCustomer("shadow-fixture", {});
  db.recordScore("shadow-fixture", 6, "{}");
  const sessionId = db.ensureActiveConversationSession("shadow-fixture").id;
  const input = { customer: db.getCustomer("shadow-fixture"), sessionId, scoreId: db.latestScoreRow("shadow-fixture").id,
    transcript: "[customer] อยากเรียน AI ช่วยงานค่ะ", assessment: { status: "assessed" }, primaryScore: 6, primaryModel: "luna-fixture" };
  const shadow = createJevShadow({ config: { jevShadowEnabled: enabled, typesafeApiKey: key, jevShadowDailyLimit: limit }, db, fetchImpl, now: () => ts, logger: silent });
  return { db, input, shadow };
}
test("shadow stores bounded results only, never changes canonical scores/customer", async () => {
  let body;
  const w = setup({ fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => answer() }; } });
  try {
    const before = JSON.stringify(w.db.getCustomer("shadow-fixture"));
    assert.equal((await w.shadow.observe(w.input)).status, "compared");
    assert.equal(JSON.stringify(w.db.getCustomer("shadow-fixture")), before);
    assert.equal(w.db.scoreHistory("shadow-fixture").length, 1);
    assert.equal(body.model, JEV_MODEL);
    assert.deepEqual(Object.keys(body.state), ["transcript"]);
    assert.doesNotMatch(JSON.stringify(body), /luna-fixture|primaryScore|shadow-fixture/);
    const row = w.db.raw.prepare("SELECT * FROM jev_shadow").get();
    assert.equal(JSON.parse(row.result_json).score, 8);
    assert.doesNotMatch(JSON.stringify(row), /อยากเรียน/);
  } finally { w.db.close(); }
});
test("off, missing key, insufficient evidence and oversized input never call provider", async () => {
  for (const mode of ["off", "key", "evidence", "large"]) {
    let calls = 0;
    const w = setup({ enabled: mode !== "off", key: mode === "key" ? "" : "fixture", fetchImpl: async () => { calls++; throw Error("must not call"); } });
    try {
      if (mode === "evidence") w.input.assessment.status = "insufficient_evidence";
      if (mode === "large") w.input.transcript = "ก".repeat(30000);
      assert.ok((await w.shadow.observe(w.input)).skipped);
      assert.equal(calls, 0);
    } finally { w.db.close(); }
  }
});
test("duplicate evidence and durable daily cap prevent repeat charges", async () => {
  const w = setup({ limit: 2 });
  try {
    await w.shadow.observe(w.input);
    assert.equal((await w.shadow.observe(w.input)).skipped, "duplicate");
    await w.shadow.observe({ ...w.input, transcript: "new evidence" });
    assert.equal((await w.shadow.observe({ ...w.input, transcript: "third evidence" })).skipped, "daily_cap");
    const restarted = createJevShadow({ config: { jevShadowEnabled: true, typesafeApiKey: "fixture", jevShadowDailyLimit: 2 }, db: w.db, now: () => ts });
    assert.equal((await restarted.observe({ ...w.input, transcript: "after restart" })).skipped, "daily_cap");
  } finally { w.db.close(); }
});
test("provider rejection, invalid output and missing usage never become confident free results", async () => {
  for (const kind of ["http", "invalid", "uncertain", "usage", "timeout", "model"]) {
    const w = setup({ fetchImpl: async () => {
      if (kind === "timeout") throw Error("fixture timeout with secret data that must not persist");
      const value = answer();
      if (kind === "invalid") value.answers.readiness.score = 500;
      if (kind === "uncertain") value.answers.readiness.confidence = 0.1;
      if (kind === "usage") delete value.usage;
      if (kind === "model") value.model = "unapproved-model";
      return { ok: kind !== "http", status: 429, json: async () => value };
    } });
    try {
      await w.shadow.observe(w.input);
      const row = w.db.raw.prepare("SELECT * FROM jev_shadow").get();
      assert.equal(row.status, { http: "http_429", invalid: "invalid_answer", uncertain: "uncertain", usage: "compared", timeout: "provider_error", model: "model_mismatch" }[kind]);
      if (["http", "usage", "timeout"].includes(kind)) assert.equal(row.input_tokens, null);
      assert.equal(w.db.getCustomer("shadow-fixture").last_score, 6);
      assert.doesNotMatch(JSON.stringify(row), /secret data/);
      if (kind === "model") assert.equal(shadowReport(w.db.raw, "2026-09-21").costComplete, false);
    } finally { w.db.close(); }
  }
});

test("concurrency ceiling prevents extra requests without serializing Luna", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const w = setup({ fetchImpl: async () => { await gate; return { ok: true, json: async () => answer() }; } });
  const first = w.shadow.observe(w.input);
  const second = w.shadow.observe({ ...w.input, transcript: "second" });
  assert.equal((await w.shadow.observe({ ...w.input, transcript: "third" })).skipped, "busy");
  release(); await Promise.all([first, second]);
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) AS n FROM jev_shadow").get().n, 2);
  w.db.close();
});
test("privacy filters known identity, contacts and links while preserving source labels", () => {
  const text = redactShadowTranscript("[preset; id=abc] Alice mail a@b.com https://example.test tel 0812345678", { known_name: "Alice" });
  assert.doesNotMatch(text, /Alice|abc|a@b.com|example.test|0812345678/);
  assert.match(text, /preset/);
});
test("reset in flight deletes observation and late completion cannot recreate it", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const w = setup({ fetchImpl: async () => { await gate; return { ok: true, json: async () => answer() }; } });
  const pending = w.shadow.observe(w.input);
  w.db.resetCustomer("shadow-fixture"); release(); await pending;
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) AS n FROM jev_shadow").get().n, 0);
  w.db.close();
});
test("report uses Bangkok day, uncertainty exclusion and explicitly unmeasured accuracy", async () => {
  const w = setup();
  try {
    await w.shadow.observe(w.input);
    const report = shadowReport(w.db.raw, "2026-09-21");
    assert.equal(report.attempted, 1); assert.equal(report.compared, 1);
    assert.equal(report.sameBand, 0); assert.equal(report.meanAbsoluteDelta, 2);
    assert.equal(report.estimatedKnownJevUsd, 0.000042);
    assert.match(report.accuracy, /unmeasured/);
    assert.doesNotMatch(JSON.stringify(report), /shadow-fixture|อยากเรียน/);
    assert.equal(shadowReport(w.db.raw, "2026-09-20").attempted, 0);
  } finally { w.db.close(); }
});
test("pipeline scorer persists Luna while JEV is still pending, and JEV cannot overwrite it", async () => {
  let resolveProvider, started = false;
  const gate = new Promise(r => { resolveProvider = r; });
  const db = memoryDb();
  const app = createApp({ config: testConfig({ JEV_SHADOW_ENABLED: "true", TYPESAFE_API_KEY: "fixture" }), db, logger: silent,
    overrides: { lineFetch: lineFetchStub(), hermesFetch: hermesFetchStub(JSON.stringify({ score: 6, trend: "flat" })),
      jevFetch: async () => { started = true; await gate; return { ok: true, json: async () => answer() }; } } });
  try {
    db.upsertCustomer("pipe-fixture", {});
    db.insertMessage({ customerId: "pipe-fixture", direction: "in", content: "อยากเรียน AI ช่วยงานบัญชีค่ะ" });
    await app.pipeline.scoreBurst("pipe-fixture");
    assert.equal(started, true); assert.equal(db.getCustomer("pipe-fixture").last_score, 6);
    assert.equal(db.raw.prepare("SELECT status FROM jev_shadow").get().status, "pending");
    resolveProvider();
    await new Promise(r => setImmediate(r));
    assert.equal(db.getCustomer("pipe-fixture").last_score, 6);
    assert.equal(db.raw.prepare("SELECT status FROM jev_shadow").get().status, "compared");
  } finally { resolveProvider(); await new Promise(r => setImmediate(r)); db.close(); }
});
