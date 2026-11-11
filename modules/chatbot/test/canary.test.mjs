// canary (G1b) — ยิงข้อความสังเคราะห์ผ่าน pipeline จริง, round-trip, alert hook,
// lock กันซ้อน, interval start/stop, /health โชว์ผลล่าสุด
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createCanary } from "../src/canary.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen, sleep, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };

async function startArmed(t, { configOverrides = {} } = {}) {
  const config = testConfig({ CANARY_INTERVAL_MS: "60000", ...configOverrides });
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("ระบบยังตอบปกติดีค่ะ");
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.canary.stop();
    app.server.close();
    db.close();
  });
  return { app, db, config, hermesFetch, lineFetch };
}

test("canary: ยิงผ่าน pipeline เต็มเส้นถึง LINE mock + บันทึก round-trip", async (t) => {
  const { app, db, lineFetch, config } = await startArmed(t);
  const result = await app.canary.runProbe();
  assert.equal(result.armed, true);
  assert.equal(result.ok, true);
  assert.ok(result.roundTripMs >= 0);

  // reply ของ canary ต้องออกทาง LINE mock จริง (push — ไม่มี reply token)
  assert.ok(lineFetch.sends.length >= 1);
  assert.equal(lineFetch.sends[0].body.to, config.canaryUserId);

  const state = db.getCanary("line-webhook");
  assert.equal(state.status, "ok");
  assert.ok(state.last_ok_at > 0);
  assert.ok(state.round_trip_ms >= 0);
});

test("canary: /health โชว์ผลล่าสุด + components.canary=armed", async (t) => {
  const { app } = await startArmed(t);
  await app.canary.runProbe();
  const res = await httpRequest(app.server, { path: "/health" });
  assert.equal(res.status, 200);
  assert.equal(res.json.components.canary, "armed");
  assert.equal(res.json.canary.status, "ok");
  assert.ok(res.json.canary.roundTripMs >= 0);
  assert.ok(res.json.canary.lastOkAt > 0);
});

test("canary: ไม่เปิด CANARY_INTERVAL_MS = not armed + /health บอก off", async (t) => {
  const config = testConfig();
  const db = memoryDb();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const result = await app.canary.runProbe();
  assert.equal(result.armed, false);
  assert.equal(app.canary.start(), false, "ไม่ armed ห้ามตั้ง interval");
  const res = await httpRequest(app.server, { path: "/health" });
  assert.equal(res.json.components.canary, "off");
});

test("canary: ลูกค้าสังเคราะห์ต้องไม่โผล่ใน inbox ของคนจริง", async (t) => {
  const { app, db } = await startArmed(t);
  db.upsertCustomer("Ureal", { displayName: "ลูกค้าจริง" });
  await app.canary.runProbe();
  const ids = db.listConversations().map((c) => c.line_user_id);
  assert.ok(ids.includes("Ureal"));
  assert.ok(!ids.some((id) => id.startsWith("canary:")), "canary:* ห้ามปน inbox");
});

test("canary: probe fail -> alert = log + webhook (ถ้าตั้ง URL)", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const alertCalls = [];
  const alertFetch = async (url, opts) => {
    alertCalls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
  const logged = [];
  const canary = createCanary({
    db,
    probeFn: async () => false,
    alertWebhookUrl: "http://alert.mock/hook",
    fetchImpl: alertFetch,
    logger: { ...silent, error: (m) => logged.push(m) },
  });
  const result = await canary.runProbe();
  assert.equal(result.ok, false);
  assert.equal(db.getCanary("line-webhook").status, "failed");
  assert.ok(logged.some((m) => String(m).includes("ALERT")), "ต้องมี log line เสมอ");
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].url, "http://alert.mock/hook");
  assert.equal(alertCalls[0].body.status, "failed");
  assert.equal(alertCalls[0].body.canary, "line-webhook");
});

test("canary: alert webhook พังเอง -> canary ไม่พังตาม", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const canary = createCanary({
    db,
    probeFn: async () => false,
    alertWebhookUrl: "http://alert.mock/hook",
    fetchImpl: async () => { throw new Error("webhook down"); },
    logger: silent,
  });
  const result = await canary.runProbe();
  assert.equal(result.ok, false);
  assert.equal(db.getCanary("line-webhook").status, "failed");
  assert.equal(canary.busy, false);
});

test("canary: probe ค้างเกิน timeout -> error + lock ถูกปล่อย", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const canary = createCanary({
    db,
    probeFn: () => new Promise(() => {}), // ค้างตลอดกาล
    timeoutMs: 40,
    logger: silent,
  });
  const result = await canary.runProbe();
  assert.equal(result.ok, false);
  assert.equal(result.error, true);
  const state = db.getCanary("line-webhook");
  assert.equal(state.status, "error");
  assert.ok(state.detail.includes("40ms"));
  assert.equal(canary.busy, false, "lock ต้องถูกปล่อยใน finally แม้ timeout");
});

test("canary: lock กันยิงซ้อน — probe ช้าอยู่ = รอบใหม่โดนข้าม", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  let resolveProbe;
  const canary = createCanary({
    db,
    probeFn: () => new Promise((resolve) => (resolveProbe = resolve)),
    logger: silent,
  });
  const running = canary.runProbe();
  const skipped = await canary.runProbe();
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "probe_in_flight");
  resolveProbe(true);
  const done = await running;
  assert.equal(done.ok, true);
  assert.equal(canary.busy, false);
});

test("canary: start/stop ยิงตาม interval จริง", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  let probes = 0;
  const canary = createCanary({
    db,
    probeFn: async () => { probes += 1; return true; },
    intervalMs: 20,
    logger: silent,
  });
  t.after(() => canary.stop());
  assert.equal(canary.start(), true);
  assert.equal(canary.running, true);
  assert.equal(canary.start(), false, "start ซ้ำห้ามตั้ง timer ซ้อน");
  await waitFor(() => probes >= 2, { timeout: 2000 });
  canary.stop();
  assert.equal(canary.running, false);
  const after = probes;
  await sleep(60);
  assert.equal(probes, after, "stop แล้วห้ามยิงต่อ");
});
