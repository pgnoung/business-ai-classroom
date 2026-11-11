import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);
const silent = { log() {}, warn() {}, error() {} };

async function startConsole(t) {
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "test-console-secret-0123456789" }),
    db,
    overrides: { hermesFetch: hermesFetchStub("รับทราบค่ะ"), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

function partialPostJson(server, path, body, headers = {}) {
  const payload = JSON.stringify(body);
  const splitAt = Math.max(1, Math.floor(payload.length / 2));
  const address = server.address();
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const request = http.request({
    host: "127.0.0.1", port: address.port, method: "POST", path,
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json = null;
      try { json = JSON.parse(text); } catch { /* test response may not be JSON */ }
      resolveResponse({ status: res.statusCode, text, json });
    });
  });
  request.on("error", rejectResponse);
  const started = new Promise((resolve, reject) => request.write(payload.slice(0, splitAt), (error) => error ? reject(error) : resolve()));
  return { started, finish: () => { request.end(payload.slice(splitAt)); return response; } };
}

async function login(server) {
  const response = await postJson(server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(response.status, 200, response.text);
  return {
    cookie: response.headers["set-cookie"][0].split(";")[0],
    csrf: response.json.csrf,
  };
}

test("suppressed customer metadata is returned and manual follow-up is rejected until explicitly re-enabled", async (t) => {
  const { app, db } = await startConsole(t);
  const customerId = "U-suppressed-api";
  db.upsertCustomer(customerId, {});
  db.suppressFollowupsForCustomer(customerId, "customer_considering");
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const detail = await httpRequest(app.server, {
    path: `/console/api/conversations/${customerId}/messages`, headers: { cookie },
  });
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.customer.followup_suppression_reason, "customer_considering");
  assert.equal(detail.json.customer.followup_enabled, 0);
  const inbox = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  assert.equal(inbox.status, 200, inbox.text);
  const room = inbox.json.conversations.find(c => c.line_user_id === customerId);
  assert.equal(room.followup_suppression_reason, "customer_considering");
  assert.equal(room.followup_enabled, 0);
  assert.equal(room.staged_followup_preview, null);

  const blocked = await postJson(app.server, `/console/api/customers/${customerId}/followups`, {
    scheduledAt: Date.now() + 3_600_000,
  }, headers);
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /เปิด follow-up ก่อน/u);
  assert.equal(db.listFollowupsFor(customerId).length, 0);

  const enabled = await postJson(app.server, `/console/api/customers/${customerId}/followup`, { enabled: true }, headers);
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.json.customer.followup_suppression_reason, "");
  assert.equal(enabled.json.customer.followup_enabled, 1);

  const allowed = await postJson(app.server, `/console/api/customers/${customerId}/followups`, {
    scheduledAt: Date.now() + 3_600_000,
  }, headers);
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal(allowed.json.followup.status, "pending");
});

test("suppression that arrives while a manual follow-up request body is incomplete wins the final check", async (t) => {
  const { app, db } = await startConsole(t);
  const customerId = "U-suppression-race";
  db.upsertCustomer(customerId, {});
  const { cookie, csrf } = await login(app.server);
  const pending = partialPostJson(app.server, `/console/api/customers/${customerId}/followups`, {
    scheduledAt: Date.now() + 3_600_000,
  }, { cookie, "x-csrf-token": csrf });

  await pending.started;
  await new Promise((resolve) => setTimeout(resolve, 20));
  db.suppressFollowupsForCustomer(customerId, "customer_will_return");
  const response = await pending.finish();

  assert.equal(response.status, 409, response.text);
  assert.match(response.json.error, /เปิด follow-up ก่อน/u);
  assert.equal(db.listFollowupsFor(customerId).length, 0);
});
