// brain-retrieval-pipeline.test.mjs — retrieval ต้องเป็นทางเลือกของรุ่นสมอง
// ไม่ใช่ทางลัดที่ทำให้ legacy หรือห้องที่คนรับช่วง เปลี่ยนพฤติกรรม
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, promptText, testConfig,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { brainParityReport } from "../src/brain/parity.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const PIN = "กติกาหลักที่ต้องมีทุกเทิร์น";
const LINE_FACT = "ข้อมูลเฉพาะ LINE OA";
const AI_FACT = "ข้อมูลเฉพาะคอร์ส AI";
const FB_FACT = "ข้อมูลเฉพาะ Facebook Ads";
const CONSOLE_LINE_FACT = "ข้อมูล LINE OA ที่เจ้าของอนุมัติจากคอนโซล";
const PASSWORD = "retrieval-owner-pass-012345";
const SECRET = "retrieval-console-session-secret-0123456789";

function retrieval(domain, offering, keywords) {
  return { knowledge: { mode: "retrieve", domain, offering, keywords } };
}

async function boot(t, {
  versioned = true, retrievalEnabled = true, importBrain = true, lineFetch = lineFetchStub(), hermesText = "รับทราบค่ะ",
} = {}) {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), displayName: "เจ้าของ", role: "owner" });
  db.addKnowledge({ title: "กติกา", content: PIN, updatedBy: "owner" });
  db.addKnowledge({
    title: "LINE", content: LINE_FACT, updatedBy: "owner",
    provenance: retrieval("line", "line-basic", ["LINE", "ไลน์"]),
  });
  db.addKnowledge({
    title: "AI", content: AI_FACT, updatedBy: "owner",
    provenance: retrieval("ai", "ai-basic", ["AI Agent"]),
  });
  db.addKnowledge({
    title: "FB", content: FB_FACT, updatedBy: "owner",
    provenance: retrieval("facebook", "fb-ads", ["Facebook Ads"]),
  });
  const imported = importBrain ? importCurrentSourcesAsVersion1(db, { createdBy: "owner", logger: silent }) : null;
  const hermesFetch = hermesFetchStub(hermesText);
  const app = createApp({
    config: testConfig({
      CONSOLE_SESSION_SECRET: SECRET,
      KNOWLEDGE_VERSIONED: versioned ? "true" : "false",
      BRAIN_READ: versioned ? "versioned" : "legacy",
      BRAIN_RETRIEVAL_ENABLED: retrievalEnabled ? "true" : "false",
    }),
    db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, hermesFetch, lineFetch, imported };
}

async function ownerSession(server) {
  const login = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  assert.equal(login.status, 200, login.text);
  return { cookie: (login.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: login.json.csrf };
}

async function ask(db, app, customerId, text, replyToken = `rt-${customerId}`) {
  db.upsertCustomer(customerId, {});
  return app.pipeline.handleInboundText({ customerId, text, replyToken });
}

function systemPrompt(hermesFetch) {
  return promptText(hermesFetch.calls.at(-1).body.messages[0].content);
}

function outboundMetadata(db, customerId) {
  const row = db.messagesFor(customerId).filter((message) => message.direction === "out").at(-1);
  return row ? JSON.parse(row.metadata_json) : null;
}

test("retrieval flag off preserves the versioned prompt exactly and writes no retrieval trace", async (t) => {
  const legacy = await boot(t, { versioned: false, retrievalEnabled: false });
  const off = await boot(t, { versioned: true, retrievalEnabled: false });

  await ask(legacy.db, legacy.app, "U-retrieval-legacy", "ขอข้อมูล LINE OA");
  await ask(off.db, off.app, "U-retrieval-off", "ขอข้อมูล LINE OA");

  assert.equal(systemPrompt(off.hermesFetch), systemPrompt(legacy.hermesFetch), "flag off must retain the established prompt bytes");
  assert.equal(outboundMetadata(off.db, "U-retrieval-off")?.brainRetrieval, undefined);
});

test("owner HTTP authoring creates a new brain version whose next prompt selects LINE only", async (t) => {
  const { app, db, hermesFetch } = await boot(t);
  const owner = await ownerSession(app.server);
  const write = await httpRequest(app.server, {
    method: "POST", path: "/console/api/knowledge",
    headers: { "content-type": "application/json", cookie: owner.cookie, "x-csrf-token": owner.csrf },
    body: JSON.stringify({
      title: "Console LINE", content: CONSOLE_LINE_FACT,
      knowledgeMetadata: { mode: "retrieve", domain: "line", offering: "line-basic", keywords: ["LINE", "ไลน์"] },
    }),
  });
  assert.equal(write.status, 200, write.text);
  assert.ok(write.json.brain?.versionId, "owner authoring must publish an immutable next brain version");
  await ask(db, app, "U-retrieval-line", "ขอรายละเอียด LINE OA ค่ะ");

  const prompt = systemPrompt(hermesFetch);
  assert.match(prompt, new RegExp(PIN, "u"));
  assert.match(prompt, new RegExp(LINE_FACT, "u"));
  assert.match(prompt, new RegExp(CONSOLE_LINE_FACT, "u"));
  assert.doesNotMatch(prompt, new RegExp(`${AI_FACT}|${FB_FACT}`, "u"));
  const trace = outboundMetadata(db, "U-retrieval-line")?.brainRetrieval;
  assert.ok(trace, "accepted outbound only must retain a selection receipt");
  assert.equal(JSON.stringify(trace).includes("ขอรายละเอียด"), false, "never store raw customer query in trace");
  assert.equal(JSON.stringify(trace).includes(LINE_FACT), false, "never store card content in trace");
});

test("current keyword wins over prior-user context; context is fallback only when current query has no match", async (t) => {
  const { app, db, hermesFetch } = await boot(t);
  db.upsertCustomer("U-retrieval-context", {});
  db.insertMessage({ customerId: "U-retrieval-context", direction: "in", content: "สนใจ AI Agent ค่ะ" });
  await ask(db, app, "U-retrieval-context", "ขอรายละเอียด LINE");

  const prompt = systemPrompt(hermesFetch);
  assert.match(prompt, new RegExp(LINE_FACT, "u"));
  assert.doesNotMatch(prompt, new RegExp(AI_FACT, "u"));
});

test("a human-owned room still stops before Hermes despite retrieval being enabled", async (t) => {
  const { app, db, hermesFetch } = await boot(t);
  db.upsertCustomer("U-retrieval-human", {});
  db.setAiEnabled("U-retrieval-human", false, "manual");

  const result = await ask(db, app, "U-retrieval-human", "ขอรายละเอียด LINE OA");
  assert.equal(result.suppressed, "ai_disabled");
  assert.equal(hermesFetch.calls.length, 0, "retrieval must not reopen a room owned by a human");
  assert.equal(outboundMetadata(db, "U-retrieval-human"), null);
});

test("failed provider send writes no retrieval trace", async (t) => {
  const failedLine = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const { app, db, hermesFetch } = await boot(t, { lineFetch: failedLine });
  await ask(db, app, "U-retrieval-failed-send", "ขอ LINE OA");

  assert.equal(hermesFetch.calls.length, 1, "draft may occur before the provider outcome is known");
  assert.equal(outboundMetadata(db, "U-retrieval-failed-send"), null, "no accepted outbound means no retrieval receipt");
});

test("retrieval flag with no ready brain view holds the turn and never falls through to legacy-all-knowledge", async (t) => {
  const { app, db, hermesFetch } = await boot(t, { importBrain: false });
  const result = await ask(db, app, "U-retrieval-missing-view", "ขอ LINE OA");

  assert.equal(hermesFetch.calls.length, 0, "missing immutable view must fail closed before model call");
  assert.equal(result.suppressed, "brain_knowledge_unavailable");
  assert.equal(outboundMetadata(db, "U-retrieval-missing-view"), null);
});

test("retrieval never permits a model-proposed unapproved price to reach the customer", async (t) => {
  const { app, db, hermesFetch } = await boot(t, { hermesText: "ราคาแพ็กเกจ LINE OA 7,777 บาทค่ะ" });
  await ask(db, app, "U-retrieval-price", "ขอรายละเอียด LINE OA");

  assert.ok(hermesFetch.calls.length > 0, "exercise the actual draft and outbound guard path");
  const delivered = db.messagesFor("U-retrieval-price").filter((row) => row.direction === "out");
  assert.equal(delivered.some((row) => /7[,.]?777/u.test(row.content)), false);
  assert.match(systemPrompt(hermesFetch), new RegExp(LINE_FACT, "u"));
});

test("detected source drift after import holds retrieval before model and send", async (t) => {
  const { app, db, hermesFetch, lineFetch } = await boot(t);
  db.addKnowledge({ title: "Unimported", content: "ข้อมูลที่ยังไม่อยู่ในรุ่นอนุมัติ", updatedBy: "test" });
  const parity = brainParityReport(db, { logger: silent });
  assert.equal(parity.reason, "mismatch");
  app.brainRuntime.noteParity(parity);
  const result = await ask(db, app, "U-retrieval-drift", "ขอ LINE OA");

  assert.equal(result.suppressed, "brain_knowledge_unavailable");
  assert.equal(hermesFetch.calls.length, 0);
  assert.equal(lineFetch.sends.filter((call) => call.body?.to === "U-retrieval-drift" || call.body?.replyToken === "rt-U-retrieval-drift").length, 0);
  assert.equal(outboundMetadata(db, "U-retrieval-drift"), null);
});
