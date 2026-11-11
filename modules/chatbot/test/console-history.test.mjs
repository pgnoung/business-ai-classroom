import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { memoryDb, poisonGlobalFetch, testConfig, hermesFetchStub, httpRequest, lineFetchStub, listen } from "./helpers.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";

poisonGlobalFetch();
const PASSWORD = "history-password-123";
const PASS_HASH = hashPassword(PASSWORD);
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function insert(db, { id, customerId, channelId = "default", content, at, direction = "in", operator = "" }) {
  db.upsertCustomer(customerId, { channelId, displayName: customerId });
  db.insertMessage({ id, customerId, channelId, content, direction, operator, createdAt: at });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, id);
}
function post(server, path, body, headers = {}) { return httpRequest(server, { method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); }
async function login(server, username = "owner") {
  const response = await post(server, "/console/api/login", { username, password: PASSWORD });
  return response.headers["set-cookie"][0].split(";")[0];
}
async function start(t, overrides = {}, channels = undefined) {
  const db = memoryDb(); db.createOperator({ username: "owner", passHash: PASS_HASH, role: "owner" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "history-secret", CHAT_HISTORY_ENABLED: "true", ...overrides }), db, logger: silent,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {}, ...(channels ? { channels } : {}) } });
  await listen(app.server); t.after(() => { app.server.close(); db.close(); }); return { app, db };
}

test("history is disabled by default and feature is explicitly advertised only when enabled", async (t) => {
  const { app } = await start(t, { CHAT_HISTORY_ENABLED: "false" }); const cookie = await login(app.server);
  assert.equal((await httpRequest(app.server, { path: "/console/api/history", headers: { cookie } })).status, 404);
  assert.equal((await httpRequest(app.server, { path: "/console/api/me", headers: { cookie } })).json.features.chatHistory, false);
});

test("history search is all-session, escaped, stable at timestamp ties and read-only", async (t) => {
  const { app, db } = await start(t); const t0 = Date.UTC(2026, 8, 1, 4, 30); // 11:30 Bangkok
  insert(db, { id: "m1", customerId: "U-history", content: "ถามราคา 100%_จริง", at: t0 });
  insert(db, { id: "m2", customerId: "U-history", content: "แอดมินตอบ", at: t0, direction: "out", operator: "staff" });
  insert(db, { id: "m3", customerId: "U-other", content: "ถามราคา 100x_จริง", at: t0 - 1 });
  const cookie = await login(app.server);
  const first = await httpRequest(app.server, { path: "/console/api/history?q=100%25_&from=2026-09-01&to=2026-09-01&limit=1", headers: { cookie } });
  assert.equal(first.status, 200); assert.equal(first.json.rows.length, 1); assert.equal(first.json.rows[0].content, "ถามราคา 100%_จริง"); assert.equal(first.json.hasMore, false, "literal LIKE search does not match wildcard-shaped near text");
  const all = await httpRequest(app.server, { path: "/console/api/history?customer=U-history&limit=1", headers: { cookie } });
  assert.equal(all.json.hasMore, true); assert.equal(all.json.rows[0].id, "m2");
  const second = await httpRequest(app.server, { path: `/console/api/history?customer=U-history&limit=1&cursor=${all.json.nextCursor}`, headers: { cookie } });
  assert.equal(second.json.rows[0].id, "m1", "rowid disambiguates identical created_at values");
  const transcript = await httpRequest(app.server, { path: "/console/api/history/transcript?customerId=U-history&q=does-not-match&from=not-a-date&actor=not-an-actor&limit=10", headers: { cookie } });
  assert.deepEqual(transcript.json.rows.map((row) => row.id), ["m1", "m2"], "transcript is chronological for chat bubbles");
  assert.equal(db.listAudit().filter((row) => row.action.includes("history")).length, 0, "opening history has no stateful audit side effect");
});

test("history scopes operators to their granted channel while owner sees inactive imported channel", async (t) => {
  const { app, db } = await start(t, {}, [{ id: "a", active: true }, { id: "retired", active: false }]); db.createOperator({ username: "staff", passHash: PASS_HASH, role: "operator" }); db.grantOperatorChannel("staff", "a");
  insert(db, { id: "a", customerId: "U-a", channelId: "a", content: "visible", at: 10 });
  insert(db, { id: "retired", customerId: "U-retired", channelId: "retired", content: "imported", at: 11 });
  const owner = await login(app.server); const staff = await login(app.server, "staff");
  const ownerRows = await httpRequest(app.server, { path: "/console/api/history?limit=10", headers: { cookie: owner } });
  assert.deepEqual(ownerRows.json.rows.map((row) => row.id), ["retired", "a"]);
  const staffRows = await httpRequest(app.server, { path: "/console/api/history?limit=10", headers: { cookie: staff } });
  assert.deepEqual(staffRows.json.rows.map((row) => row.id), ["a"]);
});

test("history opens bounded decision context and ignores a stale room response", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/history" });
  const { createHistoryPage } = await import("../public/console/history.mjs");
  const pending = new Map();
  const api = (path) => {
    if (path === "/console/api/jev-audits") return Promise.resolve({ batches: [{ batchId: "batch" }] });
    if (path.startsWith("/console/api/jev-audits/batch/threads?")) return Promise.resolve({ threads: [
      { firstCaseId: "a", customerId: "A", customerName: "A", atMs: 10, channelId: "default" },
      { firstCaseId: "b", customerId: "B", customerName: "B", atMs: 20, channelId: "default" },
    ], hasMore: false });
    if (path.startsWith("/console/api/jev-audits/batch/cases?")) {
      const customerId = new URL(`http://test${path}`).searchParams.get("customerId");
      return Promise.resolve({ rows: [{ id: customerId.toLowerCase(), customerId, atMs: customerId === "A" ? 10 : 20 }] });
    }
    if (path.startsWith("/console/api/history/transcript?")) {
      const customerId = new URL(`http://test${path}`).searchParams.get("customerId");
      return new Promise((resolve) => pending.set(customerId, { path, resolve }));
    }
    throw new Error(`unexpected ${path}`);
  };
  const state = { routeGen: 1, channels: [], ui: {} };
  const render = createHistoryPage({ api, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)), pageHeader: (title) => doc.createTextNode(title), tabBar: () => doc.createElement("nav"), stopPolling() {}, state, setView() {}, channelName: () => "LINE" });
  await render();
  const buttons = doc.body.querySelectorAll("button").filter((node) => String(node.className).includes("history-thread"));
  buttons[0].dispatch("click"); buttons[1].dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(pending.get("B").path, /customerId=B/u);
  assert.match(pending.get("B").path, /atMs=20/u, "audit room starts at the selected decision point");
  pending.get("B").resolve({ customerId: "B", rows: [{ id: "B-only", customerId: "B", content: "FRESH_B", direction: "in", msgType: "text", createdAt: 2 }], hasOlder: false, hasNewer: false });
  await new Promise((resolve) => setImmediate(resolve));
  const view = JSON.stringify(doc.body, (key, value) => key === "parent" ? undefined : value);
  assert.match(view, /FRESH_B/u); assert.doesNotMatch(view, /STALE_A/u);
});
