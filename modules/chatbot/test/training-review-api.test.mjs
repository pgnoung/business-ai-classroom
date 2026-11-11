// Owner-only review queue for `/reset` training snapshots.  Approval is a
// workflow decision only; the runtime must not mutate the AI brain.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { memoryDb, testConfig, hermesFetchStub, lineFetchStub, httpRequest, listen } from "./helpers.mjs";

const silent = { log() {}, warn() {}, error() {} };
const SECRET = "training-review-console-secret";
const PASSWORD = "owner-review-pass-123";

function post(server, path, body, headers = {}) {
  return httpRequest(server, { method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function boot(t) {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), displayName: "Owner", role: "owner" });
  db.createOperator({ username: "operator", passHash: hashPassword(PASSWORD), displayName: "Operator", role: "operator" });
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SECRET }), db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch, sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, lineFetch };
}

async function login(server, username) {
  const result = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(result.status, 200, result.text);
  return { cookie: result.headers["set-cookie"][0].split(";")[0], csrf: result.json.csrf };
}

function candidate(db) {
  db.upsertCustomer("training-user", { channelId: "default" });
  db.insertMessage({ customerId: "training-user", direction: "in", content: "ข้อความส่วนตัว" });
  return db.rotateTrainingSession({ customerId: "training-user", channelId: "default", resetEventId: `reset-${Date.now()}-${Math.random()}` }).candidate;
}

test("training candidates: operator ถูกปิดทั้ง list/detail/decide", async (t) => {
  const { app, db } = await boot(t);
  const row = candidate(db);
  const operator = await login(app.server, "operator");
  for (const path of ["/console/api/training-candidates", `/console/api/training-candidates/${row.id}`]) {
    const res = await httpRequest(app.server, { path, headers: { cookie: operator.cookie } });
    assert.equal(res.status, 403, path);
    assert.equal(res.json?.error, "สำหรับเจ้าของระบบเท่านั้น");
  }
  const decide = await post(app.server, `/console/api/training-candidates/${row.id}/decide`, { action: "approve" }, { cookie: operator.cookie, "x-csrf-token": operator.csrf });
  assert.equal(decide.status, 403);
  assert.equal(db.getTrainingCandidate(row.id).status, "pending_owner_confirmation");
  const resolve = await post(app.server, `/console/api/training-candidates/${row.id}/ack/resolve`, { action: "resolve_without_send" }, { cookie: operator.cookie, "x-csrf-token": operator.csrf });
  assert.equal(resolve.status, 403);
});

test("training ACK: owner+CSRF can resolve pending/failed/ambiguous without provider send or list PII", async (t) => {
  const { app, db, lineFetch } = await boot(t);
  const owner = await login(app.server, "owner");
  const headers = { cookie: owner.cookie, "x-csrf-token": owner.csrf };
  for (const status of ["pending", "failed", "ambiguous"]) {
    const row = candidate(db);
    if (status !== "pending") db.setTrainingCandidateAck(row.id, { status, detail: `${status}_fixture` });
    const response = await post(app.server, `/console/api/training-candidates/${row.id}/ack/resolve`, { action: "resolve_without_send" }, headers);
    assert.equal(response.status, 200, `${status}: ${response.text}`);
    assert.equal(response.json.sent, false);
    assert.equal(response.json.candidate.ack_resolved, true);
    assert.equal(response.json.candidate.ack_resolution, "owner_no_send");
    assert.equal("ack_resolved_by" in response.json.candidate, false, "operator identity stays in audit, not candidate payload");
    const stored = db.getTrainingCandidate(row.id);
    assert.equal(stored.ack_resolved_by, "owner");
    assert.equal(stored.ack_resolution, "owner_no_send");
    assert.equal(db.listAudit().some((entry) => entry.action === "training_ack_resolve_without_send" && entry.target === row.id), true);
  }
  assert.equal(lineFetch.sends.length, 0, "resolution must never call LINE");
  const listed = await httpRequest(app.server, { path: "/console/api/training-candidates", headers: { cookie: owner.cookie } });
  assert.equal(listed.status, 200);
  for (const item of listed.json.candidates) {
    assert.equal("customer_id" in item, false);
    assert.equal("transcript_json" in item, false);
    assert.equal("ack_resolved_by" in item, false);
  }
  const all = await httpRequest(app.server, { path: "/console/api/training-candidates?status=all", headers: { cookie: owner.cookie } });
  assert.equal(all.status, 200);
  assert.equal(all.json.candidates.length, 3, "ACK recovery stays discoverable across candidate review states");
});

test("training ACK: resolution validates CSRF/action and refuses sent, duplicate, or active provider attempt", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "owner");
  const pathFor = (id) => `/console/api/training-candidates/${id}/ack/resolve`;
  const row = candidate(db);
  assert.equal((await post(app.server, pathFor(row.id), { action: "resolve_without_send" }, { cookie: owner.cookie })).status, 403);
  assert.equal((await post(app.server, pathFor(row.id), { action: "retry" }, { cookie: owner.cookie, "x-csrf-token": owner.csrf })).status, 400);

  db.setTrainingCandidateAck(row.id, { status: "sent", detail: "line_acknowledged" });
  assert.equal((await post(app.server, pathFor(row.id), { action: "resolve_without_send" }, { cookie: owner.cookie, "x-csrf-token": owner.csrf })).status, 409);

  const resolved = candidate(db);
  const headers = { cookie: owner.cookie, "x-csrf-token": owner.csrf };
  assert.equal((await post(app.server, pathFor(resolved.id), { action: "resolve_without_send" }, headers)).status, 200);
  assert.equal((await post(app.server, pathFor(resolved.id), { action: "resolve_without_send" }, headers)).status, 409);

  const inFlight = candidate(db);
  db.setTrainingCandidateAck(inFlight.id, { status: "ambiguous", detail: `attempt_started:${Date.now()}` });
  const blocked = await post(app.server, pathFor(inFlight.id), { action: "resolve_without_send" }, headers);
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /กำลังส่ง ACK/u);
});

test("training candidates: owner sees redacted list, transcript only on detail, then confirms without brain mutation", async (t) => {
  const { app, db } = await boot(t);
  const row = candidate(db);
  const owner = await login(app.server, "owner");
  const headers = { cookie: owner.cookie, "x-csrf-token": owner.csrf };

  const listed = await httpRequest(app.server, { path: "/console/api/training-candidates", headers: { cookie: owner.cookie } });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.candidates.length, 1);
  assert.equal(listed.json.candidates[0].id, row.id);
  assert.equal(listed.json.candidates[0].ack_status, "pending");
  assert.equal(listed.json.candidates[0].expires_at, listed.json.candidates[0].created_at + 90 * 86_400_000);
  assert.equal("customer_id" in listed.json.candidates[0], false);
  assert.equal("transcript_json" in listed.json.candidates[0], false);

  const detail = await httpRequest(app.server, { path: `/console/api/training-candidates/${row.id}`, headers: { cookie: owner.cookie } });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.candidate.id, row.id);
  assert.deepEqual(detail.json.candidate.transcript.map((turn) => turn.content), ["ข้อความส่วนตัว"]);
  assert.equal(detail.json.candidate.transcript[0].message_class, "reactive");

  const beforePersona = db.getSetting("training:persona:applied") || "";
  const approved = await post(app.server, `/console/api/training-candidates/${row.id}/decide`, { action: "approve" }, headers);
  assert.equal(approved.status, 200);
  assert.equal(approved.json.candidate.status, "approved");
  assert.equal(approved.json.candidate.applied_to_brain, false);
  assert.equal(db.getSetting("training:persona:applied") || "", beforePersona);
  assert.equal(db.listAudit().some((entry) => entry.action === "training_candidate_approve" && entry.target === row.id), true);
});

test("training candidates: owner decision requires CSRF, validates action, and cannot be changed twice", async (t) => {
  const { app, db } = await boot(t);
  const row = candidate(db);
  const owner = await login(app.server, "owner");
  const base = { cookie: owner.cookie };
  assert.equal((await post(app.server, `/console/api/training-candidates/${row.id}/decide`, { action: "approve" }, base)).status, 403);
  assert.equal((await post(app.server, `/console/api/training-candidates/${row.id}/decide`, { action: "delete" }, { ...base, "x-csrf-token": owner.csrf })).status, 400);
  assert.equal((await post(app.server, "/console/api/training-candidates/missing/decide", { action: "approve" }, { ...base, "x-csrf-token": owner.csrf })).status, 404);
  assert.equal((await post(app.server, `/console/api/training-candidates/${row.id}/decide`, { action: "reject" }, { ...base, "x-csrf-token": owner.csrf })).status, 200);
  assert.equal((await post(app.server, `/console/api/training-candidates/${row.id}/decide`, { action: "approve" }, { ...base, "x-csrf-token": owner.csrf })).status, 409);
});
