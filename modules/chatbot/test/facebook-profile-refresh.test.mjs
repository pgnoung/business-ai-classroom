import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createOperatorApi } from "../src/operatorApi.mjs";
import { memoryDb, testConfig, poisonGlobalFetch, httpRequest, listen } from "./helpers.mjs";

poisonGlobalFetch();
const logger = { log() {}, warn() {}, error() {}, debug() {} };
const id = "facebook:123456";
const path = `/api/customers/${encodeURIComponent(id)}/refresh-profile`;

test("profile refresh: dashboard authentication, real registry mapping, no sends and no control changes", async (t) => {
  const db = memoryDb();
  const calls = [];
  db.upsertCustomer(id, { channelId: "facebook" });
  db.setAiEnabled(id, false, "manual");
  db.setNeedsHuman(id, "human_requested", "test handoff");
  db.setFollowupEnabled(id, false);
  db.setKnownName(id, "ชื่อที่ทีมตั้ง");
  const before = db.getCustomer(id);
  const app = createApp({
    config: testConfig({ FB_ENABLED: "true", FB_LIVE_SEND: "true", FB_PAGE_ACCESS_TOKEN: "test-page-token" }), db, logger,
    overrides: { lineFetch: async (url, options) => {
      calls.push({ url, method: options.method });
      assert.equal(new URL(url).pathname, "/v24.0/123456");
      assert.equal(new URL(url).searchParams.has("access_token"), false);
      assert.equal(options.headers.Authorization, "Bearer test-page-token");
      return { ok: true, json: async () => ({ first_name: "ชื่อทดสอบ", last_name: "นามสมมติ", profile_pic: "https://example.com/avatar.jpg" }) };
    } },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const post = (key) => httpRequest(app.server, { method: "POST", path, headers: key ? { "x-dashboard-key": key } : {} });
  assert.equal((await post()).status, 401);
  assert.equal((await post("wrong")).status, 401);
  assert.equal(calls.length, 0);
  const result = await post("test-dashboard-key");
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, updated: true });
  const after = db.getCustomer(id);
  assert.equal(after.display_name, "ชื่อทดสอบ นามสมมติ");
  assert.equal(after.picture_url, "https://example.com/avatar.jpg");
  for (const key of Object.keys(before).filter((k) => !["display_name", "picture_url", "updated_at"].includes(k))) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.deepEqual((await post("test-dashboard-key")).json, { ok: true, updated: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
});

function harness(getProfile) {
  const rows = new Map([[id, { channel_id: "facebook", display_name: "" }]]);
  const writes = [];
  const api = createOperatorApi({
    db: { getCustomer: (key) => rows.get(key), setProfile: (...args) => writes.push(args), addAudit: () => {} },
    lineRegistry: { channels: [{ id: "facebook", provider: "facebook" }], forChannel: () => ({ getProfile }) },
  });
  const run = async (customerId = id) => {
    let output;
    await api.handle({ method: "POST" }, {}, new URL(`http://localhost/api/customers/${encodeURIComponent(customerId)}/refresh-profile`), {
      json: (_res, status, body) => { output = { status, body }; },
    });
    return output;
  };
  return { rows, writes, run };
}

test("profile refresh: missing / non-Facebook customers never call provider", async () => {
  const h = harness(() => { assert.fail("unexpected provider call"); });
  assert.equal((await h.run("facebook:999")).status, 404);
  h.rows.set("U-line", { channel_id: "default" });
  assert.equal((await h.run("U-line")).status, 400);
});

test("profile refresh: denied Meta response leaves row untouched and can be retried", async () => {
  const h = harness(async () => null);
  assert.equal((await h.run()).status, 502);
  assert.equal((await h.run()).status, 502);
  assert.equal(h.writes.length, 0);
});

test("profile refresh: concurrent requests do not duplicate provider calls or resurrect forgotten customer", async () => {
  let release;
  const h = harness(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.run();
  assert.equal((await h.run()).status, 409);
  h.rows.delete(id);
  release({ displayName: "name" });
  assert.equal((await pending).status, 404);
  assert.equal(h.writes.length, 0);
});

test("profile refresh: operator profile edit while waiting is preserved", async () => {
  let release;
  const h = harness(() => new Promise((resolve) => { release = resolve; }));
  const pending = h.run();
  h.rows.set(id, { channel_id: "facebook", display_name: "saved meanwhile" });
  release({ displayName: "provider name" });
  assert.deepEqual((await pending).body, { ok: true, updated: false });
  assert.equal(h.writes.length, 0);
});
