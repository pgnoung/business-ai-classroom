import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { memoryDb, testConfig, hermesFetchStub, lineFetchStub, poisonGlobalFetch, promptText } from "./helpers.mjs";
poisonGlobalFetch();
const silent = { log() {}, warn() {}, debug() {}, error() {} };
const outline = "Outline AI Agent for Business นะคะ\n📑 หัวข้อที่สอน\n🔴 Prompting framework\n🟠 Prompting flow\n🎯 Workshop ประยุกต์กับงาน";
const approved = `[Outline ทางการทั้งสองคลาส]\n======== คลาสที่ 1 ========\n${outline}`;

for (const versioned of [false, true]) test(`warm outline goes into the actual ${versioned ? "versioned" : "legacy"} prompt and can finish without a question`, async t => {
  const db = memoryDb();
  db.addKnowledge({ title: "Outline ทางการทั้งสองคลาส", content: approved, updatedBy: "owner" });
  if (versioned) importCurrentSourcesAsVersion1(db, { logger: silent });
  const hermes = hermesFetchStub(outline);
  const line = lineFetchStub();
  const app = createApp({ db, config: testConfig(versioned ? { BRAIN_READ: "versioned", KNOWLEDGE_VERSIONED: "true" } : {}), logger: silent,
    overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} } });
  t.after(() => { app.server.close(); db.close(); });
  const id = "canary:outline-warm";
  db.upsertCustomer(id, {}); db.recordScore(id, 7);
  const text = "สนใจ AI Agent for Business อยากเรียนไปช่วยงานค่ะ";
  db.insertMessage({ customerId: id, direction: "in", content: text });
  await app.pipeline.handleInboundText({ customerId: id, text, replyToken: "synthetic" });
  assert.equal(hermes.calls.length, 1);
  const system = promptText(hermes.calls[0].body.messages.find(m => m.role === "system").content);
  assert.match(system, /ส่ง Outline ที่อนุมัติของ AI Agent for Business/);
  assert.match(system, /7\/10 \(warm\)/);
  assert.match(system, /ห้ามบังคับให้มีคำถามปิดท้าย/);
  const sent = db.messagesFor(id).filter(row => row.direction === "out");
  assert.ok(sent.some(row => row.content.includes("Prompting framework")));
  assert.equal(sent.some(row => /[?？]|อยากดู.*ไหม/u.test(row.content)), false);
});

test("failed asset delivery cannot create a delivered-outline dedupe marker", async t => {
  const db = memoryDb();
  db.addKnowledge({ title: "Outline ทางการทั้งสองคลาส", content: approved, updatedBy: "owner" });
  const hermes = hermesFetchStub(outline);
  const app = createApp({ db, config: testConfig(), logger: silent, overrides: { hermesFetch: hermes,
    lineFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), sleep: async () => {} } });
  t.after(() => { app.server.close(); db.close(); });
  const id = "canary:outline-failed"; db.upsertCustomer(id, {});
  const text = "ขอ Outline AI Agent for Business ค่ะ";
  await app.pipeline.handleInboundText({ customerId: id, text, replyToken: "synthetic" });
  assert.equal(hermes.calls.length, 1);
  assert.equal(db.messagesFor(id).filter(row => row.direction === "out").length, 0);
  assert.deepEqual([...db.sentCourseOutlines(id)], []);
});

for (const invented of [false, true]) test(`outline final URL gate ${invented ? "blocks an invented link" : "accepts approved selected evidence"}`, async t => {
  const db = memoryDb();
  const review = "https://www.facebook.com/reel/123456";
  db.addKnowledge({ title: "Outline ทางการทั้งสองคลาส", content: approved, updatedBy: "owner" });
  db.addKnowledge({ title: "รีวิว", content: `[Classroom - AI Agent for Business]\n- ผู้เรียนตัวอย่าง | รีวิว: ${review}`, updatedBy: "owner" });
  const hermes = hermesFetchStub(`${outline}\n\n${invented ? "https://unapproved.invalid/outline" : review}`);
  const line = lineFetchStub();
  const app = createApp({ db, config: testConfig(), logger: silent,
    overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} } });
  t.after(() => { app.server.close(); db.close(); });
  const id = `canary:outline-url-${invented}`; db.upsertCustomer(id, {});
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "ขอ Outline AI Agent for Business ค่ะ", replyToken: "synthetic" });
  if (invented) {
    assert.equal(result.suppressed, "outline_url_unapproved");
    assert.equal(line.sends.length, 0);
    assert.deepEqual([...db.sentCourseOutlines(id)], []);
  } else {
    assert.ok(line.sends.length > 0);
    assert.ok(db.sentCourseOutlines(id).has("agent_business"));
  }
});
