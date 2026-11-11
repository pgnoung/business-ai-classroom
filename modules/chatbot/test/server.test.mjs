// server — webhook HMAC/dedupe/500, health, operator API auth (fail-closed)
// หมายเหตุ: ค่าที่วิ่งบนสาย HTTP (header/path) ต้องเป็น ASCII — ภาษาไทยใช้ใน body เท่านั้น
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createApp } from "../src/server.mjs";
import { createCanary } from "../src/canary.mjs";
import { createLearningDigest } from "../src/learningDigest.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  signLine, httpRequest, listen, waitFor, sleep,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const SECRET = "test-line-secret";
const KEY_HEADER = { "x-dashboard-key": "test-dashboard-key" };
const LEARNING_NOW = Date.UTC(2026, 7, 24, 3, 0, 0);

function seedApprovedLearningCorrection(db) {
  db.upsertCustomer("U-learning-health", { channelId: "default" });
  const id = db.addCorrection({
    customerId: "U-learning-health",
    aiDraft: "ร่างทดสอบ",
    humanFinal: "แนะนำให้เริ่มจากงานซ้ำหนึ่งเรื่องก่อนค่ะ",
    reason: "operator corrected answer",
  });
  db.updateCorrection(id, { status: "approved", decidedBy: "owner" });
  const previousDay = LEARNING_NOW - 24 * 60 * 60_000;
  db.raw.prepare("UPDATE corrections SET decided_at=?,created_at=? WHERE id=?").run(previousDay, previousDay, id);
  return id;
}

// สร้าง + listen + ลงทะเบียนปิดให้อัตโนมัติแม้เทสต์ fail (กัน server ค้างทั้ง run)
async function startServer(t, {
  configOverrides = {}, approved = [2500], hermesHealthFetch = null, learningFactory = null,
} = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  for (const amount of approved) db.setApprovedPrice(`price-${amount}`, amount);
  const hermesFetch = hermesFetchStub("ขอบคุณที่ทักมานะคะ เดี๋ยวดูแลให้เลยค่ะ");
  const lineFetch = lineFetchStub();
  const learningDigest = typeof learningFactory === "function" ? learningFactory({ config, db }) : null;
  const app = createApp({
    config,
    db,
    overrides: {
      hermesFetch,
      ...(hermesHealthFetch ? { hermesHealthFetch } : {}),
      ...(learningDigest ? { learningDigest } : {}),
      lineFetch,
      sleep: async () => {},
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.learning.stop();
    app.server.close();
    db.close();
  });
  return { app, db, config, hermesFetch, lineFetch };
}

function webhookBody(messageId, { text = "สวัสดีค่ะ", userId = "Uwebhook", type = "text" } = {}) {
  return JSON.stringify({
    events: [
      {
        type: "message",
        webhookEventId: `w-${messageId}`,
        replyToken: `rt-${messageId}`,
        source: { type: "user", userId },
        message: { id: messageId, type, text },
      },
    ],
  });
}

function postWebhook(server, raw, signature) {
  return httpRequest(server, {
    method: "POST",
    path: "/webhooks/line",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "x-line-signature": signature } : {}),
    },
    body: raw,
  });
}

test("webhook: HMAC ผิด -> 403 ไม่ประมวลผลอะไร", async (t) => {
  const { app, lineFetch } = await startServer(t);
  const raw = webhookBody("m-bad");
  const res = await postWebhook(app.server, raw, "Zm9yZ2VkLXNpZ25hdHVyZQ==");
  assert.equal(res.status, 403);
  await sleep(30);
  assert.equal(lineFetch.calls.length, 0);
});

test("webhook: ไม่มี signature header -> 403", async (t) => {
  const { app } = await startServer(t);
  const res = await postWebhook(app.server, webhookBody("m-nosig"), null);
  assert.equal(res.status, 403);
});

test("webhook: HMAC ถูก -> 200 และ pipeline ตอบกลับผ่าน mock LINE", async (t) => {
  const { app, db, lineFetch } = await startServer(t);
  const raw = webhookBody("m-ok");
  const res = await postWebhook(app.server, raw, signLine(raw, SECRET));
  assert.equal(res.status, 200);
  assert.equal(res.json.accepted, 1);
  await waitFor(() => lineFetch.sends.length >= 1);
  assert.ok(lineFetch.sends[0].url.endsWith("/v2/bot/message/reply"));
  // inbound ต้องถูก log ก่อน AI gate เสมอ (บทเรียน Fern)
  const inbound = db.messagesFor("Uwebhook").filter((m) => m.direction === "in");
  assert.equal(inbound.length, 1);
});

test("webhook: dedupe — ส่งซ้ำ message.id เดิม = 200 แต่ไม่ประมวลผลซ้ำ", async (t) => {
  const { app, lineFetch } = await startServer(t);
  const raw = webhookBody("m-dup");
  const sig = signLine(raw, SECRET);
  const first = await postWebhook(app.server, raw, sig);
  assert.equal(first.json.accepted, 1);
  await waitFor(() => lineFetch.sends.length >= 1);
  const second = await postWebhook(app.server, raw, sig); // LINE redelivery
  assert.equal(second.status, 200);
  // idempotent ack: ข้อความซ้ำ = งานถูกจดไปแล้วรอบก่อน จึงนับว่า "รับแล้ว" เหมือนกัน
  // (ถ้านับเป็น 0 destination mapping จะไม่ถูกเขียนเมื่อโปรเซสตายหลัง COMMIT ก่อนตอบ 200)
  assert.equal(second.json.accepted, 1);
  await sleep(50);
  assert.equal(lineFetch.sends.length, 1, "redelivery ห้ามตอบซ้ำ");
});

test("webhook: ไม่มี LINE_CHANNEL_SECRET -> 503 (fail-closed degraded)", async (t) => {
  const { app } = await startServer(t, { configOverrides: { LINE_CHANNEL_SECRET: "" } });
  const raw = webhookBody("m-degraded");
  const res = await postWebhook(app.server, raw, "YW55dGhpbmc=");
  assert.equal(res.status, 503);
});

test("webhook: body ไม่ใช่ JSON (ลายเซ็นถูก) -> 400", async (t) => {
  const { app } = await startServer(t);
  const raw = "not-json-at-all";
  const res = await postWebhook(app.server, raw, signLine(raw, SECRET));
  assert.equal(res.status, 400);
});

test("webhook: slow/incomplete unauthenticated body is cut off by the endpoint timeout", async (t) => {
  const { app } = await startServer(t, {
    configOverrides: { LINE_WEBHOOK_BODY_TIMEOUT_MS: "1000", HTTP_REQUEST_TIMEOUT_MS: "2000" },
  });
  const { port } = app.server.address();
  const startedAt = Date.now();
  const outcome = await new Promise((resolve, reject) => {
    const failTimer = setTimeout(() => reject(new Error("slow body was not cut off")), 1_600);
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/webhooks/line",
      headers: { "content-type": "application/json", "content-length": "10" },
      agent: false,
    }, (res) => {
      res.resume();
      res.on("end", () => {
        clearTimeout(failTimer);
        resolve({ status: res.statusCode });
      });
    });
    req.on("error", (error) => {
      clearTimeout(failTimer);
      resolve({ error }); // destroy-on-timeout normally reaches this branch
    });
    req.write("{"); // intentionally never end the declared 10-byte body
  });
  assert.ok(outcome.error || outcome.status === 408);
  assert.ok(Date.now() - startedAt < 1_600);
});

test("webhook: DB เขียนไม่ได้ -> 500 ให้ LINE redeliver", async (t) => {
  const { app, db } = await startServer(t);
  db.close(); // จำลอง DB พัง
  const raw = webhookBody("m-dbfail");
  const res = await postWebhook(app.server, raw, signLine(raw, SECRET));
  assert.equal(res.status, 500);
});

test("health: ok + schemaVersion + components ครบ โดยไม่ต้อง auth", async (t) => {
  const { app } = await startServer(t);
  const res = await httpRequest(app.server, { path: "/health" });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.schemaVersion, 1);
  assert.equal(res.json.components.db, "ok");
  assert.equal(res.json.components.liveSend, "off"); // fail-closed default
});

test("health: learning reports the true enablement, mode, model switch, and scheduler interval", async (t) => {
  const off = await startServer(t, {
    configOverrides: { LEARNING_DIGEST_ENABLED: "false", LEARNING_DIGEST_INTERVAL_MS: "0", LEARNING_MODEL_ENABLED: "false" },
  });
  const offHealth = await httpRequest(off.app.server, { path: "/health" });
  assert.equal(offHealth.json.components.learning, "off");
  assert.deepEqual(offHealth.json.learning, {
    enabled: false,
    modelEnabled: false,
    configuredMode: "deterministic_fallback:model_disabled",
    mode: "deterministic_fallback:model_disabled",
    lastRunMode: null,
    lastRunStatus: null,
    armed: false,
    running: false,
    intervalMs: 0,
    lastRunAt: null,
  });

  const deterministic = await startServer(t, {
    configOverrides: { LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "60000", LEARNING_MODEL_ENABLED: "false" },
  });
  const deterministicHealth = await httpRequest(deterministic.app.server, { path: "/health" });
  assert.equal(deterministicHealth.json.components.learning, "armed");
  assert.equal(deterministicHealth.json.learning.enabled, true);
  assert.equal(deterministicHealth.json.learning.modelEnabled, false);
  assert.equal(deterministicHealth.json.learning.mode, "deterministic_fallback:model_disabled");
  assert.equal(deterministicHealth.json.learning.armed, true);
  assert.equal(deterministicHealth.json.learning.intervalMs, 60000);

  const modelAssisted = await startServer(t, {
    configOverrides: { LEARNING_DIGEST_ENABLED: "true", LEARNING_DIGEST_INTERVAL_MS: "60000", LEARNING_MODEL_ENABLED: "true" },
  });
  const modelHealth = await httpRequest(modelAssisted.app.server, { path: "/health" });
  assert.equal(modelHealth.json.learning.enabled, true);
  assert.equal(modelHealth.json.learning.modelEnabled, true);
  assert.equal(modelHealth.json.learning.mode, "model_assisted");
  assert.equal(modelHealth.json.learning.armed, true);
});

test("health: an actual scorer-fallback tick exposes its persisted outcome, not model success", async (t) => {
  const { app, db } = await startServer(t, {
    configOverrides: {
      LEARNING_DIGEST_ENABLED: "true",
      LEARNING_DIGEST_INTERVAL_MS: "60000",
      LEARNING_MODEL_ENABLED: "true",
      LEARNING_MODEL: "scorer-test",
      TRAINING_COMMANDS_CHANNELS: "training",
    },
    learningFactory: ({ config, db: learningDb }) => createLearningDigest({
      config,
      db: learningDb,
      logger: silent,
      now: () => LEARNING_NOW,
      intervalMs: 60000,
      bootDelayMs: 60000,
      scorer: async () => { throw new Error("injected scorer failure"); },
      modelPricing: [{ id: "scorer-test", inUsdPerM: 1, outUsdPerM: 1, verified: true }],
    }),
  });
  seedApprovedLearningCorrection(db);
  assert.equal(app.learning.start(), true);
  const outcome = await app.learning.runOnce();
  assert.equal(outcome.run.status, "complete");
  assert.equal(outcome.run.mode, "deterministic_fallback:model_failed");
  const health = await httpRequest(app.server, { path: "/health" });
  assert.equal(health.status, 200);
  assert.equal(health.json.components.learning, "armed");
  assert.equal(health.json.learning.configuredMode, "model_assisted");
  assert.equal(health.json.learning.mode, "deterministic_fallback:model_failed");
  assert.equal(health.json.learning.lastRunMode, "deterministic_fallback:model_failed");
  assert.equal(health.json.learning.lastRunStatus, "complete");
  assert.equal(health.json.learning.lastRunAt, LEARNING_NOW);
  assert.equal(health.json.learning.armed, true);
  assert.equal(health.json.learning.running, true);
  assert.equal(health.json.learning.intervalMs, 60000);
});

test("health: a hard learning tick failure remains available and reports the persisted failed run", async (t) => {
  const { app, db } = await startServer(t, {
    configOverrides: {
      LEARNING_DIGEST_ENABLED: "true",
      LEARNING_DIGEST_INTERVAL_MS: "60000",
      LEARNING_MODEL_ENABLED: "true",
      LEARNING_MODEL: "scorer-test",
      TRAINING_COMMANDS_CHANNELS: "training",
    },
    learningFactory: ({ config, db: learningDb }) => createLearningDigest({
      config,
      db: learningDb,
      logger: silent,
      now: () => LEARNING_NOW,
      intervalMs: 60000,
      scorer: async () => ({ clusters: [] }),
      modelPricing: [{ id: "scorer-test", inUsdPerM: 1, outUsdPerM: 1, verified: true }],
    }),
  });
  seedApprovedLearningCorrection(db);
  const originalStageAData = db.learningStageAData;
  db.learningStageAData = () => { throw new Error("injected learning tick failure"); };
  await assert.rejects(app.learning.runOnce(), /injected learning tick failure/u);
  db.learningStageAData = originalStageAData;
  const persisted = db.listLearningRuns(1)[0];
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.mode, "model_assisted");
  const health = await httpRequest(app.server, { path: "/health" });
  assert.equal(health.status, 200, "learning failure must not take the health endpoint down");
  assert.equal(health.json.learning.lastRunStatus, "failed");
  assert.equal(health.json.learning.lastRunMode, "model_assisted");
  assert.equal(health.json.learning.mode, "model_assisted");
  assert.equal(health.json.learning.lastRunAt, null, "failed tick must not claim successful completion time");
});

test("health: db พัง -> ok:false + 503", async (t) => {
  const { app, db } = await startServer(t);
  db.close();
  const res = await httpRequest(app.server, { path: "/health" });
  assert.equal(res.status, 503);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.components.db, "down");
  assert.ok(res.json.learning, "learning snapshot remains available while DB failure is reported separately");
  assert.equal(typeof res.json.learning.armed, "boolean");
  assert.equal(typeof res.json.learning.running, "boolean");
});

test("health: configured stateless gateway must keep all three route models inference-ready", async (t) => {
  let lunaReady = true;
  const { app } = await startServer(t, {
    configOverrides: {
      HERMES_BASE: "http://127.0.0.1:8650/v1",
      HERMES_API_KEY: "local-fixture",
      HERMES_HEALTH_PATH: "/models/health",
    },
    hermesHealthFetch: async () => new Response(JSON.stringify({
      ok: lunaReady,
      providerModelsVerified: true,
      providerInferenceReady: lunaReady,
      modelReadiness: { "gpt-5.6-sol": true, "gpt-5.6-luna": lunaReady, "gpt-5.6-terra": true },
    }), { status: 200 }),
  });
  assert.equal((await httpRequest(app.server, { path: "/health" })).status, 200);
  lunaReady = false;
  const degraded = await httpRequest(app.server, { path: "/health" });
  assert.equal(degraded.status, 503);
  assert.equal(degraded.json.ok, false);
  assert.equal(degraded.json.components.hermes, "degraded");
});

// เหตุ 27 ก.ย. 2026: เครดิต OpenAI หมด 40 นาที แต่ /health บอกแค่ hermes degraded
// ตัวเฝ้าจึงแจ้งได้แค่ "บริการล่ม HTTP 503" — ต้องบอกเหตุที่แน่ใจได้ให้คนแก้ถูกจุดทันที
const GATEWAY_HEALTH_CONFIG = {
  HERMES_BASE: "http://127.0.0.1:8650/v1",
  HERMES_API_KEY: "local-fixture",
  HERMES_HEALTH_PATH: "/models/health",
};
const CREDIT_FAILURE = {
  model: "gpt-5.6-sol", kind: "upstream_status", status: 429,
  type: "insufficient_quota", code: "credit_balance_exhausted", at: "2026-09-27T08:34:00.000Z",
};
const failureOf = (model, fields = {}) => ({ ...CREDIT_FAILURE, model, ...fields });
const RATE_LIMITED = { type: "requests", code: "rate_limit_exceeded" };
const UNREACHABLE = { kind: "upstream_unreachable", status: null, type: null, code: null };

// รูปเดียวกับ /v1/models/health ของ gateway: modelFailures มีเฉพาะโมเดลที่ยังค้าง
function gatewayHealthStub({ failures = {}, notReady = Object.keys(failures), lastUpstreamError = null } = {}) {
  return async () => {
    const modelReadiness = Object.fromEntries(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]
      .map((model) => [model, !notReady.includes(model)]));
    const ready = notReady.length === 0;
    return new Response(JSON.stringify({
      ok: ready, providerModelsVerified: true, providerInferenceReady: ready, modelReadiness,
      lastUpstreamError, modelFailures: failures,
    }), { status: 200 });
  };
}

async function healthWith(t, stubOptions) {
  const { app } = await startServer(t, {
    configOverrides: GATEWAY_HEALTH_CONFIG,
    hermesHealthFetch: typeof stubOptions === "function" ? stubOptions : gatewayHealthStub(stubOptions),
  });
  return httpRequest(app.server, { path: "/health" });
}

test("health: เครดิต OpenAI หมด -> components.hermesReason = provider_credit_exhausted", async (t) => {
  const cases = [
    { why: "โค้ดใหม่ credit_balance_exhausted", failures: { "gpt-5.6-sol": CREDIT_FAILURE } },
    { why: "โค้ดคลาสสิก insufficient_quota", failures: { "gpt-5.6-sol": failureOf("gpt-5.6-sol", { code: "insufficient_quota" }) } },
    // รีวิว 27 ก.ย.: luna ค้างเพราะเครดิต แล้ว sol ล้มเรื่องอื่นตามมาทับประวัติล่าสุด — ต้องยังบอกเหตุเครดิตได้
    { why: "เรื่องอื่นของโมเดลอื่นทับประวัติล่าสุด", failures: {
      "gpt-5.6-luna": failureOf("gpt-5.6-luna"),
      "gpt-5.6-sol": failureOf("gpt-5.6-sol", UNREACHABLE),
    }, lastUpstreamError: failureOf("gpt-5.6-sol", UNREACHABLE) },
  ];
  for (const item of cases) {
    const res = await healthWith(t, item);
    assert.equal(res.status, 503, `${item.why}: สัญญา health เดิม hermes ไม่พร้อม = 503`);
    assert.equal(res.json.ok, false, item.why);
    assert.equal(res.json.components.hermes, "degraded", item.why);
    assert.equal(res.json.components.hermesReason, "provider_credit_exhausted", item.why);
    // /health เปิดสาธารณะ: ออกได้แค่ enum ของเรา ห้ามสะท้อนค่าจาก gateway ตรง ๆ
    assert.doesNotMatch(res.text, /credit_balance_exhausted|insufficient_quota|2026-09-27T08:34|upstream_unreachable/u, item.why);
  }
});

test("health: hermesReason โผล่เฉพาะเมื่อแน่ใจว่าเครดิตหมดจริง — เหตุอื่นคงรูปเดิมทุกอย่าง", async (t) => {
  const cases = [
    { why: "rate limit ไม่ใช่เครดิตหมด", failures: { "gpt-5.6-sol": failureOf("gpt-5.6-sol", RATE_LIMITED) }, status: 503 },
    { why: "degraded แต่ไม่มีรายการค้าง", notReady: ["gpt-5.6-luna"], status: 503 },
    { why: "ประวัติเครดิตเก่าของ sol ที่ฟื้นแล้ว ตัวที่ค้างล้มด้วยเหตุอื่น",
      failures: { "gpt-5.6-terra": failureOf("gpt-5.6-terra", { status: 400, type: "invalid_request_error", code: "unsupported_parameter" }) },
      lastUpstreamError: CREDIT_FAILURE, status: 503 },
    { why: "พร้อมครบแล้ว เหลือแค่ประวัติเก่า", failures: {}, lastUpstreamError: CREDIT_FAILURE, status: 200 },
    { why: "gateway บอกว่าพร้อมแต่ยังมีรายการเครดิตค้าง (ขัดกันเอง)", failures: { "gpt-5.6-sol": CREDIT_FAILURE },
      notReady: ["gpt-5.6-luna"], status: 503 },
    { why: "modelFailures ผิดรูปเป็นสตริง", failures: "insufficient_quota", notReady: ["gpt-5.6-sol"], status: 503 },
    { why: "modelFailures ผิดรูปเป็นอาร์เรย์", failures: [CREDIT_FAILURE], notReady: ["gpt-5.6-sol"], status: 503 },
    { why: "gateway รุ่นเก่า (มีแค่ lastUpstreamError)", failures: undefined, notReady: ["gpt-5.6-sol"],
      lastUpstreamError: CREDIT_FAILURE, status: 503 },
  ];
  for (const item of cases) {
    const res = await healthWith(t, item);
    assert.equal(res.status, item.status, item.why);
    assert.equal(res.json.components.hermes, item.status === 200 ? "ok" : "degraded", item.why);
    assert.equal(Object.hasOwn(res.json.components, "hermesReason"), false, item.why);
  }
  const unreachable = await healthWith(t, async () => { throw new Error("gateway down"); });
  assert.equal(unreachable.json.components.hermes, "degraded");
  assert.equal(Object.hasOwn(unreachable.json.components, "hermesReason"), false, "ต่อ gateway ไม่ได้ = ไม่รู้เหตุ");
});

test("route ที่ไม่มีจริง -> 404", async (t) => {
  const { app } = await startServer(t);
  const res = await httpRequest(app.server, { path: "/no-such-route" });
  assert.equal(res.status, 404);
});

/* ------------------------------ operator API ------------------------------ */

test("api: ไม่ได้ตั้ง DASHBOARD_API_KEY -> 503 ทุก endpoint (fail-closed)", async (t) => {
  const { app } = await startServer(t, { configOverrides: { DASHBOARD_API_KEY: "" } });
  const res = await httpRequest(app.server, { path: "/api/conversations", headers: KEY_HEADER });
  assert.equal(res.status, 503);
});

test("api: key ผิด -> 401 (timing-safe compare)", async (t) => {
  const { app } = await startServer(t);
  const res = await httpRequest(app.server, {
    path: "/api/conversations",
    headers: { "x-dashboard-key": "wrong-key" },
  });
  assert.equal(res.status, 401);
});

test("api: ไม่ส่ง key -> 401", async (t) => {
  const { app } = await startServer(t);
  const res = await httpRequest(app.server, { path: "/api/conversations" });
  assert.equal(res.status, 401);
});

test("api: conversations คืนรายการพร้อม ai_enabled + handoff summary", async (t) => {
  const { app, db } = await startServer(t);
  db.upsertCustomer("U1", { displayName: "คุณหนึ่ง" });
  db.insertMessage({ customerId: "U1", direction: "in", content: "สวัสดี" });
  db.setNeedsHuman("U1", "complaint", "โกรธมาก");
  const res = await httpRequest(app.server, { path: "/api/conversations", headers: KEY_HEADER });
  assert.equal(res.status, 200);
  const convo = res.json.conversations.find((c) => c.line_user_id === "U1");
  assert.equal(convo.ai_enabled, 1);
  assert.ok(convo.handoff_summary.includes("complaint"));
  assert.equal(convo.last_message, "สวัสดี");
});

test("api: messages ของลูกค้ารายคน", async (t) => {
  const { app, db } = await startServer(t);
  db.upsertCustomer("U2", {});
  db.insertMessage({ customerId: "U2", direction: "in", content: "ถาม" });
  db.insertMessage({ customerId: "U2", direction: "out", content: "ตอบ" });
  const res = await httpRequest(app.server, { path: "/api/conversations/U2/messages", headers: KEY_HEADER });
  assert.equal(res.status, 200);
  assert.equal(res.json.messages.length, 2);
});

test("api: toggle ai_enabled — mutation เดียวที่อนุญาตใน G1a", async (t) => {
  const { app, db } = await startServer(t);
  db.upsertCustomer("U3", {});
  const res = await httpRequest(app.server, {
    method: "POST",
    path: "/api/customers/U3/ai",
    headers: { ...KEY_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.customer.ai_enabled, 0);
  assert.equal(db.getCustomer("U3").ai_enabled, 0);
  // enabled ไม่ใช่ boolean -> 400
  const bad = await httpRequest(app.server, {
    method: "POST",
    path: "/api/customers/U3/ai",
    headers: { ...KEY_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(bad.status, 400);
});

test("api: ลูกค้าไม่มีจริง -> 404", async (t) => {
  const { app } = await startServer(t);
  const res = await httpRequest(app.server, { path: "/api/customers/U-none", headers: KEY_HEADER });
  assert.equal(res.status, 404);
});

test("api: บันทึก correction candidate + อ่านกลับ", async (t) => {
  const { app } = await startServer(t);
  const post = await httpRequest(app.server, {
    method: "POST",
    path: "/api/corrections",
    headers: { ...KEY_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ customerId: "U4", aiDraft: "ร่างเดิม", humanFinal: "คำแก้ของคน" }),
  });
  assert.equal(post.status, 200);
  const list = await httpRequest(app.server, { path: "/api/corrections?status=candidate", headers: KEY_HEADER });
  assert.equal(list.json.corrections.length, 1);
  assert.equal(list.json.corrections[0].human_final, "คำแก้ของคน");
});

test("api: ไม่สร้าง candidate เมื่อข้อความที่ลูกค้าเห็นเหมือนเดิม แต่เก็บร่างว่างไว้ให้ทีมแก้ได้", async (t) => {
  const { app, db } = await startServer(t);
  const ignored = await httpRequest(app.server, {
    method: "POST", path: "/api/corrections", headers: { ...KEY_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ customerId: "U-noop", aiDraft: "รายละเอียดค่ะ [IMAGE:card]", humanFinal: "รายละเอียดค่ะ" }),
  });
  assert.equal(ignored.status, 200);
  assert.equal(ignored.json.ignored, "no_material_edit");
  assert.equal(db.listCorrections("candidate").length, 0);

  const draft = await httpRequest(app.server, {
    method: "POST", path: "/api/corrections", headers: { ...KEY_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ customerId: "U-draft", aiDraft: "ร่างที่ต้องให้คนแก้", humanFinal: "" }),
  });
  assert.equal(draft.status, 200);
  assert.ok(draft.json.id, "ร่างว่างต้องเก็บไว้เป็นงานที่คนแก้ต่อได้");
});

/* --------------------- M6: /api mutations เขียน audit --------------------- */

test("M6 api: toggle ai ผ่าน dashboard key -> audit ai_toggle operator=dashboard-key", async (t) => {
  const { app, db } = await startServer(t);
  db.upsertCustomer("U-audit", {});
  const res = await httpRequest(app.server, {
    method: "POST",
    path: "/api/customers/U-audit/ai",
    headers: { ...KEY_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(res.status, 200);
  const audit = db.listAudit().find((a) => a.action === "ai_toggle");
  assert.equal(audit.operator, "dashboard-key");
  assert.equal(audit.target, "U-audit");
  assert.equal(audit.detail, "off");
  // 400 (enabled ไม่ใช่ boolean) ห้ามเขียน audit เพิ่ม
  await httpRequest(app.server, {
    method: "POST",
    path: "/api/customers/U-audit/ai",
    headers: { ...KEY_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ enabled: "yes" }),
  });
  assert.equal(db.listAudit().filter((a) => a.action === "ai_toggle").length, 1);
});

test("M6 api: เพิ่ม correction ผ่าน dashboard key -> audit correction_add (ไม่มีเนื้อหา draft)", async (t) => {
  const { app, db } = await startServer(t);
  const post = await httpRequest(app.server, {
    method: "POST",
    path: "/api/corrections",
    headers: { ...KEY_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ customerId: "U-audit2", aiDraft: "ร่างลับ", humanFinal: "คำแก้" }),
  });
  assert.equal(post.status, 200);
  const audit = db.listAudit().find((a) => a.action === "correction_add");
  assert.equal(audit.operator, "dashboard-key");
  assert.equal(audit.target, "U-audit2");
  assert.equal(audit.detail, `id=${post.json.id}`);
  assert.ok(!audit.detail.includes("ร่างลับ"), "audit ห้ามมีเนื้อหา draft");
});

/* --------------------------------- canary --------------------------------- */

test("canary: โครง probe บันทึกสถานะ not_armed + lock กันวิ่งซ้อน", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const canary = createCanary({ db, logger: silent });
  const result = await canary.runProbe();
  assert.equal(result.armed, false);
  assert.equal(canary.status().status, "not_armed");

  // probe ช้า: รอบสองต้องโดน lock ข้าม ไม่วิ่งซ้อน (release ใน finally)
  let resolveProbe;
  const slow = createCanary({
    db,
    probeFn: () => new Promise((resolve) => (resolveProbe = resolve)),
    logger: silent,
  });
  const running = slow.runProbe();
  const skipped = await slow.runProbe();
  assert.equal(skipped.skipped, true);
  resolveProbe(true);
  const done = await running;
  assert.equal(done.ok, true);
  assert.equal(slow.busy, false, "lock ต้องถูกปล่อยใน finally");
  assert.equal(canary.status().status, "ok");
});
