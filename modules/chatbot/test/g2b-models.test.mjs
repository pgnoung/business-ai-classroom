// G2b (B8) — model picker + AI cost tracking + live FX
// สลับโมเดล runtime มีผลกับ body.model จริง, scorer แยกโมเดล, llm_usage ครบทุก kind,
// คณิตค่าใช้จ่ายเทียบไฟล์ราคา (รู้/ไม่รู้ราคา), แปลง THB, auth/CSRF, fxRate ครบ 4 เคส
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createFollowupEngine } from "../src/followupEngine.mjs";
import { createFxRate } from "../src/fxRate.mjs";
import { loadModelPricing, pricingById, usageCostUsd, summarizeUsage } from "../src/modelPricing.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen, sleep, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

/* ------------------------- pricing loader + cost math ----------------------- */

test("B8.1: โหลดไฟล์ราคาจริง — sol/terra/luna verified, รุ่นราคา null เลือกได้แต่ไม่มีราคา", () => {
  const entries = loadModelPricing(testConfig().modelPricingFile, { logger: silent });
  assert.equal(entries.length, 12); // +gpt-6.1-sol (30 ก.ย. 2026) · +claude-sonnet-5-5 (4 ต.ค. 2026) · +claude-opus-5-5 (1 พ.ย. 2026)
  const sol = entries.find((m) => m.id === "gpt-5.6-sol");
  assert.deepEqual(
    { inUsdPerM: sol.inUsdPerM, outUsdPerM: sol.outUsdPerM, cachedInUsdPerM: sol.cachedInUsdPerM, verified: sol.verified },
    // ราคาโปรโมชัน OpenAI ตรวจ 2026-08-31 (ของเดิม $5/$30 คือราคาลิสต์ที่เลิกใช้แล้ว)
    { inUsdPerM: 4, outUsdPerM: 20, cachedInUsdPerM: 0.4, verified: true }
  );
  // developers.openai.com/api/docs/models/gpt-6.1-sol ตรวจ 2026-09-30: $2 / $0.10 cached / $10
  const sol61 = entries.find((m) => m.id === "gpt-6.1-sol");
  assert.deepEqual(
    { inUsdPerM: sol61.inUsdPerM, outUsdPerM: sol61.outUsdPerM, cachedInUsdPerM: sol61.cachedInUsdPerM, verified: sol61.verified },
    { inUsdPerM: 2, outUsdPerM: 10, cachedInUsdPerM: 0.1, verified: true },
  );
  const luna = entries.find((m) => m.id === "gpt-5.6-luna");
  assert.equal(luna.inUsdPerM, 0.2);
  const nano = entries.find((m) => m.id === "gpt-5.4-nano");
  assert.equal(nano.inUsdPerM, null);
  assert.equal(nano.verified, false);
});

test("B8.1: loader tolerant — ไฟล์หาย/JSON พัง/ไม่ใช่ array = []", () => {
  assert.deepEqual(loadModelPricing("/tmp/no-such-pricing-file.json", { logger: silent }), []);
  const dir = mkdtempSync(join(tmpdir(), "pricing-"));
  try {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "ไม่ใช่ json {");
    assert.deepEqual(loadModelPricing(broken, { logger: silent }), []);
    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ models: [] }));
    assert.deepEqual(loadModelPricing(wrongShape, { logger: silent }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B8: usageCostUsd + summarizeUsage — รู้ราคาคิดเงิน / ไม่รู้ = null + นับ token แยก", () => {
  const pricing = pricingById(loadModelPricing(testConfig().modelPricingFile, { logger: silent }));
  // sol: 1M in + 1M out = 4 + 20 = 24 USD (ไม่มี cachedIn = คิดราคาเต็มเหมือนเดิม)
  assert.equal(usageCostUsd({ model: "gpt-5.6-sol", tokensIn: 1_000_000, tokensOut: 1_000_000 }, pricing), 24);
  assert.equal(usageCostUsd({ model: "gpt-5.4-nano", tokensIn: 100, tokensOut: 100 }, pricing), null);
  assert.equal(usageCostUsd({ model: "ไม่รู้จัก", tokensIn: 100, tokensOut: 100 }, pricing), null);

  const summary = summarizeUsage([
    { model: "gpt-5.6-sol", kind: "draft", tokens_in: 1_000_000, tokens_out: 0 }, // 4 USD
    { model: "gpt-5.6-luna", kind: "score", tokens_in: 0, tokens_out: 1_000_000 }, // 1.2 USD
    { model: "gpt-5.4-nano", kind: "draft", tokens_in: 400, tokens_out: 600 }, // ไม่รู้ราคา
  ], pricing);
  assert.equal(summary.usd, 5.2);
  assert.equal(summary.unknownTokens, 1000);
  assert.equal(summary.breakdown.length, 3);
  assert.equal(summary.breakdown.find((b) => b.model === "gpt-5.4-nano").usd, null);
});

/* ------------------------ B8.2: runtime model switching ---------------------- */

function makeApp({ configOverrides = {}, hermesFetch } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} },
    logger: silent,
  });
  return { app, db, config, hermesFetch: hermes, lineFetch: line };
}

test("B8.2: reply_model จาก DB settings ถูกส่งเป็น body.model จริง (อ่านสดทุก call)", async () => {
  const { app, db, hermesFetch, config } = makeApp();
  await app.pipeline.handleInboundText({ customerId: "U-m1", text: "สวัสดีค่ะ", replyToken: "" });
  assert.equal(hermesFetch.calls[0].body.model, config.hermesModel, "ยังไม่ตั้ง = ค่า default");

  db.setSetting("reply_model", "gpt-5.6-luna");
  await app.pipeline.handleInboundText({ customerId: "U-m1", text: "ถามต่อค่ะ", replyToken: "" });
  assert.equal(hermesFetch.calls.at(-1).body.model, "gpt-5.6-luna", "สลับได้โดยไม่ restart");
});

test("B8.2: scorer ใช้ scorer_model แยกจาก reply_model + บันทึก usage kind=score", async () => {
  const { app, db, hermesFetch } = makeApp();
  db.setSetting("reply_model", "gpt-5.6-sol");
  db.setSetting("scorer_model", "gpt-5.6-luna");
  db.upsertCustomer("U-m2", {});
  db.insertMessage({ customerId: "U-m2", direction: "in", content: "สนใจค่ะ" });

  await app.pipeline.scoreBurst("U-m2");
  assert.equal(hermesFetch.calls.at(-1).body.model, "gpt-5.6-luna", "scorer ต้องใช้คันโยกของตัวเอง");
  const rows = db.llmUsageForCustomer("U-m2");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "gpt-5.6-luna");
  const summary = db.llmUsageSummary(0);
  assert.equal(summary[0].kind, "score");
  // token จาก stub: prompt 805 / completion 72
  assert.equal(summary[0].tokens_in, 805);
  assert.equal(summary[0].tokens_out, 72);
});

test("B8.2: instance scorer default ใช้ HERMES_SCORER_MODEL โดยไม่เปลี่ยน reply model", async () => {
  const { app, db, hermesFetch, config } = makeApp({ configOverrides: { HERMES_SCORER_MODEL: "gpt-5.6-luna" } });
  db.upsertCustomer("U-default-scorer", {});
  db.insertMessage({ customerId: "U-default-scorer", direction: "in", content: "สนใจคลาส AI ค่ะ" });

  await app.pipeline.scoreBurst("U-default-scorer");

  assert.equal(config.hermesModel, "gpt-5.6-sol");
  assert.equal(config.hermesScorerModel, "gpt-5.6-luna");
  assert.equal(hermesFetch.calls.at(-1).body.model, "gpt-5.6-luna");
  db.close();
});

test("B8.2: closed model policy coerces stale DB overrides to Sol/Luna defaults", async () => {
  const config = testConfig({
    HERMES_MODEL: "gpt-5.6-sol",
    HERMES_SCORER_MODEL: "gpt-5.6-luna",
    HERMES_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.6-luna,gpt-5.6-terra",
    HERMES_REPLY_ALLOWED_MODELS: "gpt-5.6-sol",
    HERMES_SCORER_ALLOWED_MODELS: "gpt-5.6-luna",
  });
  const db = memoryDb();
  const fetchStub = hermesFetchStub();
  const bridge = createHermesBridge({
    config, fetchImpl: fetchStub, logger: silent,
    getReplyModel: () => db.getSetting("reply_model"),
    getScorerModel: () => db.getSetting("scorer_model"),
  });
  db.setSetting("reply_model", "gpt-5.6-terra");
  db.setSetting("scorer_model", "gpt-5.6-sol");

  await bridge.draftReply({ userText: "สวัสดีค่ะ" });
  await bridge.scoreCustomer({ transcript: "ลูกค้า: สนใจค่ะ" });

  assert.equal(fetchStub.calls[0].body.model, "gpt-5.6-sol");
  assert.equal(fetchStub.calls[1].body.model, "gpt-5.6-luna");
  db.close();
});

test("B8.2: Luna payload ใช้ไม่ได้ -> Terra high fallback หนึ่งครั้งและบันทึก score ครั้งเดียว", async () => {
  const calls = [];
  const validScore = JSON.stringify({
    score: 6,
    trend: "up",
    buying_signals: ["มีเป้าหมายชัด"],
    persona_read: { disc: "unknown", bank: "unknown", reason: "ข้อมูลยังไม่พอ" },
    next_move: "ถามเป้าหมายการนำ AI ไปใช้ต่อ",
    suggested_question: "อยากนำ AI ไปช่วยงานส่วนไหนก่อนคะ",
    known_name: null,
    context_summary: "กำลังสำรวจคลาส AI",
    tags: ["สนใจ AI"],
    out_of_band_reply: false,
    order: null,
  });
  const hermesFetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    const content = calls.length === 1 ? "not-json" : validScore;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model,
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100 + calls.length, completion_tokens: 10 + calls.length },
      }),
    };
  };
  const { app, db } = makeApp({
    configOverrides: {
      HERMES_SCORER_FALLBACK_MODEL: "gpt-5.6-terra",
      HERMES_SCORER_FALLBACK_REASONING_EFFORT: "high",
    },
    hermesFetch,
  });
  db.setSetting("scorer_model", "gpt-5.6-luna");
  db.upsertCustomer("U-score-fallback", {});
  db.insertMessage({ customerId: "U-score-fallback", direction: "in", content: "อยากเอา AI ไปช่วยลดงานซ้ำค่ะ" });

  const result = await app.pipeline.scoreBurst("U-score-fallback");

  assert.equal(result.score, 6);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.model, "gpt-5.6-luna");
  assert.equal(Object.hasOwn(calls[0].body, "reasoning_effort"), false, "Luna primary ต้องไม่ส่ง reasoning_effort");
  assert.equal(calls[1].body.model, "gpt-5.6-terra");
  assert.equal(calls[1].body.reasoning_effort, "high");
  assert.deepEqual(db.llmUsageForCustomer("U-score-fallback").map((row) => row.model), [
    "gpt-5.6-luna",
    "gpt-5.6-terra",
  ]);
  assert.equal(db.scoreHistory("U-score-fallback").length, 1, "fallback ห้ามสร้าง score ซ้ำ");
  assert.equal(JSON.parse(db.scoreHistory("U-score-fallback")[0].payload_json).scorer_fallback.reason, "invalid_primary_payload");
  db.close();
});

test("B8.2: definitive scorer 400/401/403 rejection must not invoke Terra fallback", async () => {
  for (const status of [400, 401, 403]) {
    const calls = [];
    const hermesFetch = async (_url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: false, status, json: async () => ({}) };
    };
    const { app, db } = makeApp({
      configOverrides: {
        HERMES_SCORER_MODEL: "gpt-5.6-luna",
        HERMES_SCORER_FALLBACK_MODEL: "gpt-5.6-terra",
        HERMES_SCORER_FALLBACK_REASONING_EFFORT: "high",
      },
      hermesFetch,
    });
    const customerId = `U-score-definitive-${status}`;
    db.upsertCustomer(customerId, {});
    db.insertMessage({ customerId, direction: "in", content: "สนใจคลาสค่ะ" });

    assert.equal(await app.pipeline.scoreBurst(customerId), null);
    assert.equal(calls.length, 1, `HTTP ${status} must stop before fallback`);
    assert.equal(db.scoreHistory(customerId).length, 0);
    db.close();
  }
});

test("B8.3: draft reply บันทึก usage kind=draft — Hermes ล่มไม่มี usage = ไม่มีแถว", async () => {
  const { app, db } = makeApp();
  await app.pipeline.handleInboundText({ customerId: "U-m3", text: "สวัสดีค่ะ", replyToken: "" });
  const rows = db.llmUsageForCustomer("U-m3");
  assert.equal(rows.length, 1);
  assert.equal(db.llmUsageSummary(0).find((r) => r.kind === "draft").tokens_in, 805);

  // Hermes ล่ม -> fallback template — ห้ามมีแถว usage เพิ่ม
  const broken = makeApp({ hermesFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  await broken.app.pipeline.handleInboundText({ customerId: "U-m4", text: "สวัสดีค่ะ", replyToken: "" });
  assert.equal(broken.db.llmUsageForCustomer("U-m4").length, 0);
  broken.db.close();
  db.close();
});

test("B8.3: follow-up draft บันทึก usage kind=followup + โน้ต handoff เข้า prompt", async () => {
  const NOON = Date.UTC(2026, 7, 7, 5, 0, 0); // 12:00 เวลาไทย — นอก quiet hours แน่นอน
  const config = testConfig({ FOLLOWUP_ENABLED: "true" }); // Final send gate now rechecks the global switch.
  // นาฬิกาเดียว: created_at ของนัดต้องมาจากเวลาเดียวกับที่ engine ใช้ตัดสินว่าถึงกำหนด
  const db = memoryDb({ now: () => NOON });
  const hermesFetch = hermesFetchStub("อ้างอิงเรื่องที่คุยค้างไว้ค่ะ สะดวกคุยต่อไหมคะ");
  const hermes = createHermesBridge({
    config, fetchImpl: hermesFetch, logger: silent,
    getReplyModel: () => db.getSetting("reply_model") || config.hermesModel,
  });
  const line = createLineClient({ config, fetchImpl: lineFetchStub(), sleep: async () => {}, logger: silent });
  const engine = createFollowupEngine({
    config, db, hermes, line,
    guard: createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [] }),
    humanizer: createHumanizer(),
    logger: silent, now: () => NOON,
  });

  db.setSetting("reply_model", "gpt-5.6-terra");
  db.upsertCustomer("U-fu-usage", {});
  db.setFollowupEnabled("U-fu-usage", true);
  db.addHandoffNote({ customerId: "U-fu-usage", author: "nok", text: "ลูกค้ารอเทียบรุ่น X5Pro" });
  const row = db.createFollowup({ customerId: "U-fu-usage", scheduledAt: NOON - 1000, createdBy: "nok" });

  const result = await engine.processFollowup(row);
  assert.equal(result.status, "sent");
  assert.equal(hermesFetch.calls[0].body.model, "gpt-5.6-terra", "follow-up ใช้ reply_model");
  assert.ok(promptText(hermesFetch.calls[0].body.messages[0].content).includes("ลูกค้ารอเทียบรุ่น X5Pro"), "B6: โน้ตเข้า prompt follow-up");
  const rows = db.llmUsageForCustomer("U-fu-usage");
  assert.equal(rows.length, 1);
  assert.equal(db.llmUsageSummary(0)[0].kind, "followup");
  db.close();
});

/* -------------------------- B8.4: console API + cost ------------------------ */

async function startConsole(t, { configOverrides = {} } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, ...configOverrides });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, config };
}

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server) {
  const res = await postJson(server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(res.status, 200);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

test("B8.4: GET /models คืนรายการ+ราคา / POST สลับ -> settings + audit / validation", async (t) => {
  const { app, db, config } = await startConsole(t, { configOverrides: { FX_LIVE: "false" } });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const list = await httpRequest(app.server, { path: "/console/api/models", headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal(list.json.models.length, 12);
  assert.equal(list.json.replyModel, config.hermesModel);
  assert.equal(list.json.scorerModel, config.hermesModel);
  assert.ok(Number(list.json.thbPerUsd) > 0);

  const flip = await postJson(app.server, "/console/api/models", { target: "reply", model: "gpt-5.6-luna" }, headers);
  assert.equal(flip.status, 200);
  assert.equal(flip.json.replyModel, "gpt-5.6-luna");
  assert.equal(db.getSetting("reply_model"), "gpt-5.6-luna");
  const audit = db.listAudit().find((a) => a.action === "model_change");
  assert.equal(audit.target, "reply_model");
  assert.ok(audit.detail.includes("gpt-5.6-luna"));

  const scorer = await postJson(app.server, "/console/api/models", { target: "scorer", model: "gpt-5.6-terra" }, headers);
  assert.equal(scorer.json.scorerModel, "gpt-5.6-terra");

  assert.equal((await postJson(app.server, "/console/api/models", { target: "reply", model: "gpt-999" }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/models", { target: "อื่น", model: "gpt-5.6-luna" }, headers)).status, 400);
});

test("B8.4: Training model policy hides and rejects models outside Sol/Luna/Terra", async (t) => {
  const { app, db } = await startConsole(t, { configOverrides: {
    FX_LIVE: "false",
    HERMES_MODEL: "gpt-5.6-sol",
    HERMES_SCORER_MODEL: "gpt-5.6-luna",
    HERMES_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.6-luna,gpt-5.6-terra",
    HERMES_REPLY_ALLOWED_MODELS: "gpt-5.6-sol",
    HERMES_SCORER_ALLOWED_MODELS: "gpt-5.6-luna",
  } });
  db.setSetting("reply_model", "gpt-5.4-nano");
  db.setSetting("scorer_model", "gpt-5.4-nano");
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const list = await httpRequest(app.server, { path: "/console/api/models", headers: { cookie } });
  assert.deepEqual(list.json.models.map((entry) => entry.id).sort(), ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(list.json.replyModels.map((entry) => entry.id), ["gpt-5.6-sol"]);
  assert.deepEqual(list.json.scorerModels.map((entry) => entry.id), ["gpt-5.6-luna"]);
  assert.equal(list.json.replyModel, "gpt-5.6-sol");
  assert.equal(list.json.scorerModel, "gpt-5.6-luna");
  assert.equal((await postJson(app.server, "/console/api/models", { target: "reply", model: "gpt-5.4-nano" }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/models", { target: "reply", model: "gpt-5.6-luna" }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/models", { target: "scorer", model: "gpt-5.6-sol" }, headers)).status, 400);
});

test("B8.4: overview คิดเงินถูกตามไฟล์ราคา + THB rate + โมเดลราคาไม่รู้ = token อย่างเดียว", async (t) => {
  const { app, db } = await startConsole(t, {
    configOverrides: { FX_LIVE: "false", THB_PER_USD: "40" },
  });
  db.upsertCustomer("U-cost", {});
  db.addLlmUsage({ customerId: "U-cost", kind: "draft", model: "gpt-5.6-sol", tokensIn: 1_000_000, tokensOut: 0 }); // 4 USD
  db.addLlmUsage({ customerId: "U-cost", kind: "score", model: "mystery-model", tokensIn: 400, tokensOut: 600 }); // ไม่รู้ราคา
  const { cookie } = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/overview", headers: { cookie } });
  assert.equal(res.status, 200);
  const cost = res.json.aiCost;
  assert.equal(cost.thbPerUsd, 40);
  assert.equal(cost.fxSource, "env");
  assert.equal(cost.today.usd, 4);
  assert.equal(cost.today.thb, 160, "THB = USD x rate");
  assert.equal(cost.today.unknownTokens, 1000);
  assert.equal(cost.month.usd, 4);
  const unknownRow = cost.month.breakdown.find((b) => b.model === "mystery-model");
  assert.equal(unknownRow.usd, null, "ไม่รู้ราคา = null ให้ UI โชว์ —");
  assert.equal(unknownRow.tokensIn + unknownRow.tokensOut, 1000);
});

test("B8.4c: messages endpoint แนบ aiCost สะสมรายลูกค้า (ไม่ปนลูกค้าอื่น)", async (t) => {
  const { app, db } = await startConsole(t, {
    configOverrides: { FX_LIVE: "false", THB_PER_USD: "40" },
  });
  db.upsertCustomer("U-cc", {});
  db.upsertCustomer("U-other", {});
  // (100000*4 + 10000*20)/1M = 0.6 USD -> 24 THB
  db.addLlmUsage({ customerId: "U-cc", kind: "draft", model: "gpt-5.6-sol", tokensIn: 100_000, tokensOut: 10_000 });
  db.addLlmUsage({ customerId: "U-other", kind: "draft", model: "gpt-5.6-sol", tokensIn: 1_000_000, tokensOut: 0 });
  const { cookie } = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/conversations/U-cc/messages", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.ok(Math.abs(res.json.aiCost.usd - 0.6) < 1e-9);
  assert.ok(Math.abs(res.json.aiCost.thb - 24) < 1e-9);
  assert.equal(res.json.aiCost.unknownTokens, 0);
});

/* --------------------------------- B8: fxRate ------------------------------- */

test("customer API preserves cached tokens and historical-model pricing outside the picker allowlist", async (t) => {
  const { app, db } = await startConsole(t, { configOverrides: {
    FX_LIVE: "false", THB_PER_USD: "36", HERMES_ALLOWED_MODELS: "gpt-5.6-sol",
  } });
  db.upsertCustomer("U-cache-regression", {});
  db.addLlmUsage({ customerId: "U-cache-regression", kind: "staged_followup", model: "gpt-5.6-sol",
    tokensIn: 100000, cachedIn: 90000, tokensOut: 1000 });
  db.addLlmUsage({ customerId: "U-cache-regression", kind: "score", model: "gpt-5.6-luna",
    tokensIn: 1000, cachedIn: 500, tokensOut: 100 });
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/conversations/U-cache-regression/messages", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.aiCost.unknownTokens, 0);
  assert.equal(res.json.aiCost.breakdown.find(row => row.model === "gpt-5.6-sol").cachedIn, 90000);
  assert.ok(Math.abs(res.json.aiCost.usd - (0.096 + 0.00023)) < 1e-10);
});

test("B8 fx: ดึงสด -> cache ใน settings -> current() ใช้ค่า live โดยไม่ยิงซ้ำ", async () => {
  const db = memoryDb();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.ok(String(url).includes("open.er-api.com"));
    return { ok: true, status: 200, json: async () => ({ rates: { THB: 35.5 } }) };
  };
  const fx = createFxRate({ config: testConfig({ THB_PER_USD: "40" }), db, fetchImpl, logger: silent });

  assert.equal(await fx.refresh(), 35.5);
  assert.equal(db.getSetting("fx_thb_per_usd"), "35.5");
  assert.ok(Number(db.getSetting("fx_fetched_at")) > 0);

  const cur = fx.current();
  assert.equal(cur.thbPerUsd, 35.5);
  assert.equal(cur.source, "live");
  assert.equal(calls, 1, "cache สดอยู่ ห้าม refetch");
  db.close();
});

test("B8 fx: cache แก่เกิน 12 ชม. -> ใช้ค่าเก่าตอบก่อน + refresh เบื้องหลัง", async () => {
  const NOW = 1_800_000_000_000;
  const db = memoryDb({ now: () => NOW });
  db.setSetting("fx_thb_per_usd", "30");
  db.setSetting("fx_fetched_at", String(NOW - 13 * 3_600_000));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ rates: { THB: 37 } }) };
  };
  const fx = createFxRate({ config: testConfig(), db, fetchImpl, logger: silent, now: () => NOW });

  const first = fx.current();
  assert.equal(first.thbPerUsd, 30, "รอบนี้ใช้ค่าที่มีไปก่อน (ห้าม block)");
  await sleep(10); // ให้ fire-and-forget refresh จบ
  assert.equal(calls, 1, "ต้อง trigger refresh หนึ่งครั้ง");
  assert.equal(db.getSetting("fx_thb_per_usd"), "37");
  assert.equal(fx.current().thbPerUsd, 37, "รอบถัดไปได้ค่าใหม่");
  db.close();
});

test("B8 fx: fetch พัง + ไม่มี cache -> fallback env THB_PER_USD เงียบ ๆ", async () => {
  const db = memoryDb();
  const fx = createFxRate({
    config: testConfig({ THB_PER_USD: "40" }), db,
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
    logger: silent,
  });
  const cur = fx.current();
  assert.equal(cur.thbPerUsd, 40);
  assert.equal(cur.source, "env");
  await sleep(10); // refresh ล้มเหลวต้องเงียบ ไม่มี unhandled rejection
  assert.equal(db.getSetting("fx_thb_per_usd"), null);
  db.close();
});

test("B8 fx: FX_LIVE=false = escape hatch — ใช้ env เท่านั้น ไม่ยิง network เลย", async () => {
  const db = memoryDb();
  db.setSetting("fx_thb_per_usd", "35"); // มี cache ก็ห้ามใช้
  let calls = 0;
  const fx = createFxRate({
    config: testConfig({ FX_LIVE: "false", THB_PER_USD: "38" }), db,
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ rates: { THB: 30 } }) }; },
    logger: silent,
  });
  const cur = fx.current();
  assert.equal(cur.thbPerUsd, 38);
  assert.equal(cur.source, "env");
  await sleep(5);
  assert.equal(calls, 0);
  db.close();
});

/* ---------------- v1.4.9: เส้นโมเดล follow-up + migration llm_usage ---------------- */

test("v1.4.9: GET/POST /models — เส้น followup ครบวงจร (override / ตามตัวหลัก / validation / provider)", async (t) => {
  const { app, db } = await startConsole(t, { configOverrides: { FX_LIVE: "false" } });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  // ยังไม่ตั้ง = ตามตัวหลัก (สะท้อนโมเดล reply ปัจจุบัน) + provider ออกให้ UI
  let list = await httpRequest(app.server, { path: "/console/api/models", headers: { cookie } });
  assert.equal(list.json.followupFollowsReply, true);
  assert.equal(list.json.followupModel, list.json.replyModel);
  assert.equal(list.json.followupModels.length, 12);
  assert.equal(list.json.followupModels[0].provider, "openai", "provider field = โครงรองรับ provider อื่นในอนาคต");

  const flip = await postJson(app.server, "/console/api/models", { target: "followup", model: "gpt-5.6-luna" }, headers);
  assert.equal(flip.status, 200);
  assert.equal(flip.json.followupModel, "gpt-5.6-luna");
  assert.equal(flip.json.followupFollowsReply, false);
  assert.equal(db.getSetting("followup_model"), "gpt-5.6-luna");
  const audit = db.listAudit().find((a) => a.action === "model_change" && a.target === "followup_model");
  assert.ok(audit.detail.includes("gpt-5.6-luna"));

  // เปลี่ยนตัวหลักภายหลัง — override ของ FU ต้องไม่ขยับ
  await postJson(app.server, "/console/api/models", { target: "reply", model: "gpt-5.6-terra" }, headers);
  list = await httpRequest(app.server, { path: "/console/api/models", headers: { cookie } });
  assert.equal(list.json.followupModel, "gpt-5.6-luna");

  // ล้าง override (model ว่าง) = กลับไปตามตัวหลัก ซึ่งตอนนี้คือ terra
  const clear = await postJson(app.server, "/console/api/models", { target: "followup", model: "" }, headers);
  assert.equal(clear.status, 200);
  assert.equal(clear.json.followupFollowsReply, true);
  assert.equal(clear.json.followupModel, "gpt-5.6-terra");

  // ค่ามั่ว = 400 และค่าว่างใช้ได้เฉพาะ followup เท่านั้น
  assert.equal((await postJson(app.server, "/console/api/models", { target: "followup", model: "gpt-999" }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/models", { target: "reply", model: "" }, headers)).status, 400);
});

test("v1.4.9: bridge role followup — override ใช้โมเดลตัวเอง / ไม่ตั้ง = ตามตัวหลักสด", async () => {
  const config = testConfig({});
  const db = memoryDb();
  const fetchStub = hermesFetchStub();
  const bridge = createHermesBridge({
    config, fetchImpl: fetchStub, logger: silent,
    getReplyModel: () => db.getSetting("reply_model") || config.hermesModel,
    getFollowupModel: () => db.getSetting("followup_model") || "",
  });
  db.setSetting("reply_model", "gpt-5.6-terra");

  await bridge.draftReply({ userText: "ตามงานค่ะ", role: "followup" });
  assert.equal(fetchStub.calls.at(-1).body.model, "gpt-5.6-terra", "ไม่มี override = ตามตัวหลัก ณ ตอน call");

  db.setSetting("followup_model", "gpt-5.6-luna");
  await bridge.draftReply({ userText: "ตามงานต่อค่ะ", role: "followup" });
  assert.equal(fetchStub.calls.at(-1).body.model, "gpt-5.6-luna", "มี override = โมเดลของ FU เอง");

  await bridge.draftReply({ userText: "ลูกค้าถามค่ะ" });
  assert.equal(fetchStub.calls.at(-1).body.model, "gpt-5.6-terra", "เส้นตอบลูกค้าห้ามโดน override ของ FU");
  db.close();
});

test("v1.4.9: migration llm_usage — DB เก่า (CHECK ไม่มี staged_followup) ถูก rebuild ข้อมูลเดิมครบ", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { openDb } = await import("../src/db.mjs");
  const dir = mkdtempSync(join(tmpdir(), "llm-usage-migrate-"));
  const file = join(dir, "old.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE llm_usage (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('draft','score','followup')),
      model TEXT NOT NULL DEFAULT '', tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO llm_usage VALUES ('old-1', 'U-a', 'draft', 'gpt-5.6-sol', 10, 5, 1000);
  `);
  legacy.close();

  const db = openDb({ file });
  const migrated = db.addLlmUsage({ customerId: "U-a", kind: "staged_followup", model: "gpt-5.6-luna", tokensIn: 3, tokensOut: 2 });
  assert.ok(migrated, "kind ใหม่ต้องเขียนได้หลัง rebuild");
  const rows = db.raw.prepare("SELECT id, kind FROM llm_usage ORDER BY created_at").all();
  assert.deepEqual(rows.map((r) => r.id).slice(0, 1), ["old-1"], "แถวเดิมต้องรอด migration");
  assert.equal(rows.length, 2);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("v1.4.9b: inherit เดินโซ่เดียวกับ bridge — followup allowlist จำกัดแล้วหน้าเว็บโชว์ตัวที่ยิงจริง", async (t) => {
  const { app } = await startConsole(t, { configOverrides: { FX_LIVE: "false", HERMES_FOLLOWUP_ALLOWED_MODELS: "gpt-5.6-luna" } });
  const { cookie } = await login(app.server);
  const list = await httpRequest(app.server, { path: "/console/api/models", headers: { cookie } });
  assert.equal(list.json.replyModel, "gpt-5.6-sol");
  // บั๊กจากรีวิว: เดิม inherit คืน replyModel ตรง ๆ (sol) ทั้งที่ bridge จะ substitute
  // เป็น luna เพราะ sol ไม่อยู่ใน followup allowlist — หน้าเว็บต้องโชว์ luna
  assert.equal(list.json.followupModel, "gpt-5.6-luna");
  assert.equal(list.json.followupInheritModel, "gpt-5.6-luna");
});

test("v1.4.9b: HERMES_FOLLOWUP_MODEL ตั้งไว้ — ล้าง override แล้วผลจริง+audit คือ env default ไม่ใช่คำว่าตามตัวหลัก", async (t) => {
  const { app, db } = await startConsole(t, { configOverrides: { FX_LIVE: "false", HERMES_FOLLOWUP_MODEL: "gpt-5.6-terra" } });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  await postJson(app.server, "/console/api/models", { target: "followup", model: "gpt-5.6-luna" }, headers);
  const clear = await postJson(app.server, "/console/api/models", { target: "followup", model: "" }, headers);
  assert.equal(clear.status, 200);
  assert.equal(clear.json.followupModel, "gpt-5.6-terra", "ล้างแล้วตกไป env default ไม่ใช่ reply model");
  assert.equal(clear.json.followupFollowsReply, false, "env ตั้งอยู่ = ไม่ใช่สถานะตามตัวหลัก");
  assert.equal(clear.json.followupOverrideActive, false);
  assert.equal(clear.json.followupInheritModel, "gpt-5.6-terra");
  const clearAudit = db.listAudit().find((a) => a.target === "followup_model" && a.detail.includes('-> "gpt-5.6-terra"'));
  assert.ok(clearAudit, "audit ต้องบันทึกสถานะจริง (env default) ไม่ใช่ข้อความ ตามตัวหลัก");
});
