import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();

const SECRET = "line-oa-status-console-secret-0123456789";
const PASSWORD = "line-oa-status-pass-1234";
const QUIET = { warn() {}, debug() {}, log() {}, error() {} };

async function boot(t) {
  // Keep the versioned Brain path off: status is operational readiness, not a
  // hidden activation dependency. All credentials here are synthetic.
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SECRET,
    KNOWLEDGE_VERSIONED: "false",
    BRAIN_READ: "legacy",
    TEACH_ENABLED: "true",
    TRAINING_INTAKE_ENABLED: "true",
    LINE_CHANNEL_NAME: "OA ทดสอบ",
    LINE_CHANNEL_SECRET: "line-oa-status-synthetic-secret",
  });
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), role: "owner" });
  db.createOperator({ username: "staff", passHash: hashPassword(PASSWORD), role: "operator" });
  const app = createApp({
    config, db, logger: QUIET,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const result = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(result.status, 200, result.text);
  return { cookie: (result.headers["set-cookie"]?.[0] || "").split(";")[0] };
}

const get = (server, path, session = null) => httpRequest(server, {
  path,
  headers: session ? { cookie: session.cookie } : {},
});

test("owner status is reachable with Brain off; staff and anonymous sessions cannot read it; GET leaves DB unchanged", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "owner");
  const staff = await login(app.server, "staff");
  const before = { audit: db.listAudit(), settings: db.listSettings?.() || [] };

  const result = await get(app.server, "/console/api/line-oa/status", owner);
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.scope, "one_business_per_instance");
  assert.equal(result.json.channels.length, 1);
  const channel = result.json.channels[0];
  assert.equal(channel.id, "default");
  assert.equal(channel.label, "OA ทดสอบ");
  assert.equal(channel.active, true);
  // The promise this endpoint makes is operational, not editorial: a local
  // secret permits signed inbound verification but never proves LINE points
  // to the instance.  Keep UI copy free to improve without weakening it.
  assert.deepEqual(
    { configured: channel.webhook.configured, provenConnected: channel.webhook.provenConnected, status: channel.webhook.status },
    { configured: true, provenConnected: false, status: "configured_unverified" },
  );
  assert.match(channel.webhook.message, /ยังไม่ได้ตรวจยืนยัน|ยังไม่มีหลักฐานยืนยัน/u);
  assert.deepEqual(
    { observed: channel.managerDirect.observed, status: channel.managerDirect.status },
    { observed: false, status: "unobserved" },
  );
  assert.deepEqual(
    { enabled: channel.curatedQa.enabled, status: channel.curatedQa.status, href: channel.curatedQa.href },
    { enabled: true, status: "queue_available", href: "#/teach-intake" },
  );
  assert.equal(channel.nativeBackup.status, "schema_unverified");
  assert.equal(channel.nativePerChatTags.status, "not_available");
  assert.equal(result.text.includes("line-oa-status-synthetic-secret"), false, "secret must not be returned");

  assert.equal((await get(app.server, "/console/api/line-oa/status", staff)).status, 403);
  assert.equal((await get(app.server, "/console/api/line-oa/status")).status, 401);
  assert.deepEqual({ audit: db.listAudit(), settings: db.listSettings?.() || [] }, before, "GET must not write audit/settings");
});

test("readiness assets are served from the real console static allowlist", async (t) => {
  const { app } = await boot(t);
  for (const [path, type] of [
    ["/console/static/readiness.mjs", "text/javascript"],
    ["/console/static/readiness.css", "text/css"],
  ]) {
    const result = await get(app.server, path);
    assert.equal(result.status, 200, `${path}: ${result.text}`);
    assert.match(String(result.headers["content-type"] || ""), new RegExp(`^${type}`));
  }
});
