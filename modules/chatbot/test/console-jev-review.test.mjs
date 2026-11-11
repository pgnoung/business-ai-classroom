import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createConsoleJevReviewRoutes } from "../src/consoleJevReviewApi.mjs";
import { hashPassword } from "../src/auth.mjs";
import { memoryDb, poisonGlobalFetch, testConfig, hermesFetchStub, httpRequest, lineFetchStub, listen } from "./helpers.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";

poisonGlobalFetch();
const PASSWORD = "reviewer-password-123";
const PASS_HASH = hashPassword(PASSWORD);
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function insertReview(db, { id = "jev-1", customerId = "U-jev", channelId = "default" } = {}) {
  db.upsertCustomer(customerId, { channelId });
  db.raw.prepare(`INSERT INTO jev_decision_reviews
    (id,customer_id,session_id,turn_id,stage,policy,model,brain_version_id,proposed_action,mode,action,status,confidence_10,result_json,evidence_hash,applied,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, customerId, "session", "turn", "draft", "fixture", "jev-1.13.0", "", "draft_reply", "shadow", "rewrite", "reviewed", 7.5,
    JSON.stringify({ action: "rewrite", confidence10: 7.5, checks: { complaint: { choice: "none", confidence: 0.75, confidence10: 7.5, probabilities: { none: 1 } } } }),
    `hash-${id}`, 0, Date.now(),
  );
  return id;
}

function post(server, path, body, headers = {}) {
  return httpRequest(server, { method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function start(t, configOverrides = {}) {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: PASS_HASH, role: "owner" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "jev-review-test-secret", ...configOverrides }), db, logger: silent,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server) {
  const response = await post(server, "/console/api/login", { username: "owner", password: PASSWORD });
  assert.equal(response.status, 200);
  return { cookie: response.headers["set-cookie"][0].split(";")[0], csrf: response.json.csrf };
}

test("JEV console API requires a session and exposes only bounded receipt fields", async (t) => {
  const { app, db } = await start(t);
  insertReview(db);
  assert.equal((await httpRequest(app.server, { path: "/console/api/jev-reviews" })).status, 401);
  const auth = await login(app.server);
  const listed = await httpRequest(app.server, { path: "/console/api/jev-reviews", headers: { cookie: auth.cookie } });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.rows.length, 1);
  assert.deepEqual(Object.keys(listed.json.rows[0].result.checks), ["complaint"]);
  assert.doesNotMatch(JSON.stringify(listed.json), /transcript|display_name/u);
  insertReview(db, { id: "jev-unavailable", customerId: "U-unavailable" });
  db.raw.prepare("UPDATE jev_decision_reviews SET confidence_10 = NULL, result_json = ? WHERE id = ?").run(JSON.stringify({ action: "unavailable", confidence10: null, checks: { complaint: { choice: "unclear", confidence: null, confidence10: null, probabilities: { unclear: null } } } }), "jev-unavailable");
  const unavailable = await httpRequest(app.server, { path: "/console/api/jev-reviews", headers: { cookie: auth.cookie } });
  const row = unavailable.json.rows.find((entry) => entry.id === "jev-unavailable");
  assert.equal(row.confidence10, null);
  assert.equal(row.result.confidence10, null);
  assert.deepEqual(row.result.checks, {});
});

test("JEV console feature flag follows the current server mode", async (t) => {
  const off = await start(t);
  const offAuth = await login(off.app.server);
  assert.equal((await httpRequest(off.app.server, { path: "/console/api/me", headers: { cookie: offAuth.cookie } })).json.features.jevReview, false);
  const shadow = await start(t, { JEV_REVIEW_MODE: "shadow" });
  const shadowAuth = await login(shadow.app.server);
  assert.equal((await httpRequest(shadow.app.server, { path: "/console/api/me", headers: { cookie: shadowAuth.cookie } })).json.features.jevReview, true);
});

test("JEV decision validates CSRF and is an audit-only write", async (t) => {
  const { app, db } = await start(t);
  const id = insertReview(db);
  const auth = await login(app.server);
  const beforeCorrections = db.listCorrections("candidate").length;
  const missing = await post(app.server, "/console/api/jev-reviews/missing/decide", { action: "dismissed" }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(missing.status, 404);
  const bad = await post(app.server, `/console/api/jev-reviews/${id}/decide`, { action: "confirmed_wrong" }, { cookie: auth.cookie });
  assert.equal(bad.status, 403);
  assert.equal(db.raw.prepare("SELECT review_status FROM jev_decision_reviews WHERE id=?").get(id).review_status, "pending");
  const done = await post(app.server, `/console/api/jev-reviews/${id}/decide`, { action: "confirmed_wrong", note: "ตรวจโดยคน" }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(done.status, 200);
  const row = db.raw.prepare("SELECT * FROM jev_decision_reviews WHERE id=?").get(id);
  assert.equal(row.review_status, "confirmed_wrong");
  assert.equal(row.applied, 0);
  assert.equal(db.listCorrections("candidate").length, beforeCorrections);
  assert.equal(db.listKnowledge().length, 0);
  assert.ok(db.listAudit().some((item) => item.action === "jev_decision_review"));
  const again = await post(app.server, `/console/api/jev-reviews/${id}/decide`, { action: "dismissed" }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(again.status, 409);
});

test("JEV route hides records outside an operator's granted channel", async () => {
  const db = memoryDb();
  db.createOperator({ username: "staff", passHash: PASS_HASH, role: "operator" });
  db.grantOperatorChannel("staff", "a");
  insertReview(db, { id: "jev-a", customerId: "a:customer", channelId: "a" });
  insertReview(db, { id: "jev-b", customerId: "b:customer", channelId: "b" });
  const routes = createConsoleJevReviewRoutes({ db, channels: [{ id: "a", active: true }, { id: "b", active: true }] });
  let payload;
  const handled = await routes.handle({ method: "GET" }, {}, new URL("http://test/console/api/jev-reviews"), ["jev-reviews"], {
    username: "staff", operator: db.getOperator("staff"), readJson: async () => ({}), requireCsrf: () => true,
    json: (_res, status, body) => { payload = { status, body }; },
  });
  try {
    assert.equal(handled, true); assert.equal(payload.status, 200);
    assert.deepEqual(payload.body.rows.map((row) => row.id), ["jev-a"]);
  } finally { db.close(); }
});

test("review page renders a Jev receipt as an advisory human-review card", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const api = async (path) => {
    if (path.startsWith("/console/api/teach/review")) return { rows: [], total: 0, counts: {}, hasMore: false, cursor: 0 };
    if (path.startsWith("/console/api/jev-reviews")) return { rows: [{
      id: "jev-ui", customerId: "U-ui", stage: "draft", mode: "shadow", proposedAction: "draft_reply", action: "rewrite",
      confidence10: 7.5, applied: false, createdAt: Date.now(), reviewStatus: "pending",
      result: { checks: { complaint: { choice: "none", confidence10: 7.5, probabilities: { none: 1 } } } },
    }] };
    throw new Error(`unexpected ${path}`);
  };
  await createReviewPage({ api, toast() {}, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)), pageHeader: (title) => doc.createTextNode(title), tabBar: () => doc.createElement("nav"), stopPolling() {}, setView() {}, state: { features: { jevReview: true } } })();
  const text = JSON.stringify(doc.body, (key, value) => key === "parent" ? undefined : value);
  assert.match(text, /JEV double-check/u);
  assert.match(text, /7\.5\/10/u);
  assert.match(text, /ไม่สร้าง knowledge หรือสอนลูกแพรอัตโนมัติ/u);
});

test("review page reads the JEV flag at render time after console boot updates state", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const state = { features: { jevReview: false } };
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith("/console/api/teach/review")) return { rows: [], total: 0, counts: {}, hasMore: false, cursor: 0 };
    if (path.startsWith("/console/api/jev-reviews")) return {
      rows: [{ id: "jev-after-boot", customerId: "U-after-boot", action: "allow", mode: "shadow", reviewStatus: "pending", result: { checks: {} } }],
      hasMore: true,
      nextCursor: "cursor-2",
    };
    throw new Error(`unexpected ${path}`);
  };
  const render = createReviewPage({ api, toast() {}, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)), pageHeader: (title) => doc.createTextNode(title), tabBar: () => doc.createElement("nav"), stopPolling() {}, setView() {}, state });

  await render();
  assert.equal(calls.some((path) => path.startsWith("/console/api/jev-reviews")), false);
  state.features.jevReview = true;
  await render();

  const text = JSON.stringify(doc.body, (key, value) => key === "parent" ? undefined : value);
  assert.match(text, /JEV double-check/u);
  assert.match(text, /ดู JEV เพิ่ม/u);
  assert.doesNotMatch(text, /ไม่มีอะไรรอตัดสินค่ะ/u);
  assert.equal(calls.filter((path) => path.startsWith("/console/api/jev-reviews")).length, 1);
});
