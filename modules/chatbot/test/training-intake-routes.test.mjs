// HTTP boundary for curated training intake.  All state stays in the in-memory DB.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { knowledgeMetadataFromRow } from "../src/brain/knowledgeMetadata.mjs";
import { memoryDb, testConfig, hermesFetchStub, httpRequest, lineFetchStub, listen, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

const SECRET = "training-intake-routes-secret-0123456789";
const PASSWORDS = { owner: "owner-training-pass-123", admin: "admin-training-pass-123", operator: "operator-training-pass-123" };
const QUIET = { log() {}, warn() {}, error() {}, debug() {} };
const metadata = { mode: "retrieve", domain: "LINE", offering: "LINE Basic", keywords: ["แท็ก LINE"] };
const body = (extra = {}) => ({
  origin: "team_notes", channelId: null, knowledgeMetadata: metadata,
  entries: [{ title: "แท็ก LINE", question: "แท็กคืออะไร", answer: "ใช้จัดกลุ่มบทสนทนา" }],
  ...extra,
});

async function boot(t, { enabled = true, retrievalReady = true } = {}) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SECRET,
    KNOWLEDGE_VERSIONED: "true",
    BRAIN_READ: "versioned",
    TRAINING_INTAKE_ENABLED: enabled ? "true" : "false",
    TEACH_ENABLED: "true",
  });
  config.brainRetrievalEnabled = retrievalReady;
  if (!retrievalReady) {
    config.knowledgeVersioned = false;
    config.brainRead = "legacy";
  }
  const db = memoryDb();
  for (const [role, password] of Object.entries(PASSWORDS)) {
    db.createOperator({ username: role, passHash: hashPassword(password), role });
  }
  importCurrentSourcesAsVersion1(db, { createdBy: "owner", logger: QUIET, todayIso: todayInBangkok(Date.now()) });
  const app = createApp({ config, db, logger: QUIET, overrides: {
    channels: [{ id: "branch-a", name: "สาขา A", active: true, channelSecret: "test", channelAccessToken: "test" }],
    hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
  } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const result = await request(server, "POST", "/console/api/login", { username, password: PASSWORDS[username] });
  assert.equal(result.status, 200);
  return { cookie: (result.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: result.json.csrf };
}

function headers(session, { csrf = true } = {}) {
  return { cookie: session.cookie, ...(csrf ? { "x-csrf-token": session.csrf } : {}) };
}

function request(server, method, path, json, extraHeaders = {}) {
  return httpRequest(server, { method, path, headers: { "content-type": "application/json", ...extraHeaders }, body: json === undefined ? null : JSON.stringify(json) });
}

test("training intake routes are absent by default and advertised only when enabled", async (t) => {
  const { app } = await boot(t, { enabled: false });
  const owner = await login(app.server, "owner");
  assert.equal((await request(app.server, "GET", "/console/api/teach/intake", undefined, headers(owner))).status, 404);
  const me = await request(app.server, "GET", "/console/api/me", undefined, headers(owner));
  assert.equal(me.status, 200);
  assert.equal(me.json.features.trainingIntake, false);
});


test("Brain-off intake remains proposal-only while learning status exposes separate publication readiness", async (t) => {
  const { app, db } = await boot(t, { retrievalReady: false });
  const owner = await login(app.server, "owner");
  const staff = await login(app.server, "operator");
  const intake = await request(app.server, "GET", "/console/api/teach/intake", undefined, headers(staff));
  assert.equal(intake.status, 200);
  assert.equal(intake.json.ready, true);
  assert.equal(intake.json.publicationReady, false);
  assert.equal(intake.json.knowledgeMetadata.ready, false);
  const preview = await request(app.server, "POST", "/console/api/teach/intake/preview", body(), headers(staff));
  const commit = await request(app.server, "POST", "/console/api/teach/intake/commit", { ...body(), previewHash: preview.json.previewHash, confirm: true }, headers(staff));
  assert.equal(commit.status, 202);
  assert.equal(db.listLearningCandidates({ limit: 100 }).length, 1);
  assert.equal(db.listKnowledge().length, 0);
  for (const session of [owner, staff]) {
    const learning = await request(app.server, "GET", "/console/api/learning", undefined, headers(session));
    assert.equal(learning.status, 200);
    if (session === staff) assert.equal(Object.hasOwn(learning.json, "budgetUsd"), false);
    assert.deepEqual(learning.json.trainingIntake, { canPropose: true, canPublish: false, message: "รับข้อเสนอเพื่อรอรีวิวได้ แต่รอสมองพร้อมก่อนจึงจะเผยแพร่ได้" });
  }
});

test("intake HTTP route gates auth, CSRF, input shape and server-side scope", async (t) => {
  const { app, db } = await boot(t);
  assert.equal((await request(app.server, "GET", "/console/api/teach/intake")).status, 401);
  const staff = await login(app.server, "operator");
  const status = await request(app.server, "GET", "/console/api/teach/intake", undefined, headers(staff));
  assert.equal(status.status, 200);
  assert.equal(status.json.ready, true);
  assert.deepEqual(status.json.origins, ["team_notes", "line_oa_curated"]);
  assert.deepEqual(status.json.channels, [{ id: null, label: "สมองกลาง" }], "shared channels must not become an intake scope");
  assert.equal((await request(app.server, "POST", "/console/api/teach/intake/preview", body(), headers(staff, { csrf: false }))).status, 403);
  assert.equal((await request(app.server, "POST", "/console/api/teach/intake/preview", { ...body(), unexpected: true }, headers(staff))).status, 400);
  assert.equal((await request(app.server, "POST", "/console/api/teach/intake/preview", body({ channelId: "branch-a" }), headers(staff))).status, 400);
  assert.equal(db.listLearningCandidates({ limit: 100 }).length, 0, "invalid preview must never write");
});

test("staff and admin can propose only; owner approval publishes one versioned retrieval fact", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "owner");
  const staff = await login(app.server, "operator");
  const admin = await login(app.server, "admin");
  for (const session of [staff, admin]) {
    const preview = await request(app.server, "POST", "/console/api/teach/intake/preview", body(), headers(session));
    assert.equal(preview.status, 200);
    assert.equal(preview.json.canCommit, true);
    const committed = await request(app.server, "POST", "/console/api/teach/intake/commit", { ...body(), previewHash: preview.json.previewHash, confirm: true }, headers(session));
    assert.equal(committed.status, 202);
    assert.equal(committed.json.published, false);
  }
  const candidates = db.listLearningCandidates({ limit: 100 });
  assert.equal(candidates.length, 1, "same curated fact is deduped across operators");
  const candidate = candidates[0];
  for (const session of [staff, admin]) {
    const denied = await request(app.server, "POST", `/console/api/learning/${encodeURIComponent(candidate.id)}/decide`, { action: "approve" }, headers(session));
    assert.equal(denied.status, 403);
  }
  assert.equal(db.getLearningCandidate(candidate.id).status, "proposed");
  assert.equal(db.listKnowledge().length, 0);
  const applied = await request(app.server, "POST", `/console/api/learning/${encodeURIComponent(candidate.id)}/decide`, { action: "approve" }, headers(owner));
  assert.equal(applied.status, 200, JSON.stringify(applied.json));
  assert.equal(db.getLearningCandidate(candidate.id).status, "approved");
  assert.deepEqual(knowledgeMetadataFromRow(db.listKnowledge()[0]), metadata);
});

test("commit requires the server preview receipt and leaves proposals unpublished", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "operator");
  assert.equal((await request(app.server, "POST", "/console/api/teach/intake/commit", { ...body(), confirm: true, previewHash: "x" }, headers(staff))).status, 409);
  const preview = await request(app.server, "POST", "/console/api/teach/intake/preview", body(), headers(staff));
  assert.equal(preview.status, 200);
  const commit = await request(app.server, "POST", "/console/api/teach/intake/commit", { ...body(), confirm: true, previewHash: preview.json.previewHash }, headers(staff));
  assert.equal(commit.status, 202);
  assert.equal(commit.json.published, false);
  assert.equal(db.listKnowledge().length, 0, "commit creates a proposal, never an active knowledge row");
  assert.equal(db.listLearningCandidates({ limit: 100 }).length, 1);
});

test("intake browser assets and its synthetic CSV are reachable with the expected MIME types", async (t) => {
  const { app } = await boot(t, { enabled: false });
  for (const [asset, mime] of [["trainingIntake.mjs", "text/javascript"], ["intakeCsv.mjs", "text/javascript"], ["trainingIntake.css", "text/css"], ["training-intake-sample.csv", "text/csv"]]) {
    const res = await request(app.server, "GET", `/console/static/${asset}`);
    assert.equal(res.status, 200, asset);
    assert.ok(res.headers["content-type"].startsWith(mime), asset);
  }
});
