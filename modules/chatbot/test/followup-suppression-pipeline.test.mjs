import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {} };
function fixture(t, enabled = true) {
  const db = memoryDb();
  const line = lineFetchStub();
  const hermes = hermesFetchStub("รับทราบค่ะ สะดวกเมื่อไรแจ้งได้เลยค่ะ");
  const app = createApp({ config: testConfig({ CUSTOMER_FOLLOWUP_SUPPRESSION_ENABLED: String(enabled) }), db,
    overrides: { lineFetch: line, hermesFetch: hermes, sleep: async () => {} }, logger: silent });
  t.after(() => db.close());
  db.upsertCustomer("synthetic", {});
  db.recordScore("synthetic", 8, "{}");
  return { app, db, line, hermes };
}

test("direct inbound suppresses immediately even with reactive AI off, cancels jobs, and records a closed reason", async (t) => {
  const { app, db, line, hermes } = fixture(t);
  db.setAiEnabled("synthetic", false, "human_requested");
  const job = db.createFollowup({ customerId: "synthetic", scheduledAt: Date.now() + 60000, createdBy: "owner" });
  const running = app.pipeline.handleInboundText({ customerId: "synthetic", text: "เดี๋ยวติดต่อกลับไปครับ" });
  assert.equal(db.getCustomer("synthetic").followup_enabled, 0);
  assert.equal(db.getFollowup(job.id).status, "cancelled");
  await running;
  assert.equal(db.getCustomer("synthetic").ai_enabled, 0);
  assert.equal(db.getCustomer("synthetic").do_not_disturb, 0);
  assert.equal(line.sends.length, 0);
  assert.equal(hermes.calls.length, 0);
  assert.equal(db.listAudit().find(a => a.action === "followup_suppressed").detail, "customer_will_return");
});

test("deferral leaves reactive replies available, and ordinary inbound or scoring cannot resume followup", async (t) => {
  const { app, db, line } = fixture(t);
  await app.pipeline.handleInboundText({ customerId: "synthetic", text: "ขอคิดดูก่อนครับ", replyToken: "test-one" });
  assert.equal(db.getCustomer("synthetic").followup_suppression_reason, "customer_considering");
  assert.equal(db.getCustomer("synthetic").ai_enabled, 1);
  await app.pipeline.handleInboundText({ customerId: "synthetic", text: "เรียนออนไลน์ได้ไหมครับ", replyToken: "test-two" });
  db.recordScore("synthetic", 10, "{}");
  assert.equal(db.getCustomer("synthetic").followup_enabled, 0);
  assert.ok(line.sends.length > 0);
  assert.doesNotMatch(JSON.stringify(line.sends), /ไม่ทักไปรบกวน|unsubscribe/iu);
});

test("disabled instance flag preserves existing behavior", async (t) => {
  const { app, db } = fixture(t, false);
  db.setAiEnabled("synthetic", false);
  await app.pipeline.handleInboundText({ customerId: "synthetic", text: "คิดดูก่อนครับ" });
  assert.equal(db.getCustomer("synthetic").followup_enabled, 1);
  assert.equal(db.getCustomer("synthetic").followup_suppression_reason, "");
});

test("stale session and campaign seed cannot suppress the current customer's followup", async (t) => {
  const { app, db } = fixture(t);
  const old = db.activeConversationSession("synthetic").id;
  db.resetCustomer("synthetic");
  db.setAiEnabled("synthetic", false);
  const before = db.getCustomer("synthetic");
  await app.pipeline.handleInboundText({ customerId: "synthetic", text: "คิดดูก่อนครับ", expectedSessionId: old });
  assert.deepEqual(db.getCustomer("synthetic"), before);
  assert.equal(db.getCustomer("synthetic").followup_suppression_reason, "");
  db.setSetting("hashtag_business_keywords", JSON.stringify({ "#test": "ขอคิดดูก่อนครับ" }));
  const campaign = await app.pipeline.handleInboundText({ customerId: "synthetic", text: "#test" });
  assert.notEqual(campaign.suppressed, "hashtag_auto_response");
  assert.equal(db.getCustomer("synthetic").followup_suppression_reason, "");
});

test("colleague and explicitly identified accounting contact suppress even in a separate unpaid room", async (t) => {
  const { app, db } = fixture(t);
  for (const [customerId, text, reason] of [
    ["synthetic-ceo", "ผมเป็น CEO เดี๋ยวให้ทีมงานทักมา", "colleague_will_contact"],
    ["synthetic-accountant", "ผมอยู่ฝ่ายบัญชี มาตามใบเสร็จที่ค้าง", "accounting_documents"],
  ]) {
    db.upsertCustomer(customerId, {});
    db.setAiEnabled(customerId, false);
    await app.pipeline.handleInboundText({ customerId, text });
    assert.equal(db.getCustomer(customerId).followup_suppression_reason, reason);
    assert.equal(db.getCustomer(customerId).do_not_disturb, 0);
    assert.equal(db.getCustomer(customerId).money_seen_at, 0);
  }
});

test("document presales and newsletter use cases remain eligible for sales followup", async (t) => {
  const { app, db } = fixture(t);
  db.setAiEnabled("synthetic", false);
  for (const text of ["ขอใบเสนอราคาก่อนตัดสินใจได้ไหม", "อยากใช้ AI ตามเอกสาร", "ลูกค้าจะ unsubscribe newsletter ไหม", "ช่วยติดต่อกลับหาผมหน่อย"]) {
    await app.pipeline.handleInboundText({ customerId: "synthetic", text });
    assert.equal(db.getCustomer("synthetic").followup_enabled, 1, text);
    assert.equal(db.getCustomer("synthetic").do_not_disturb, 0, text);
  }
});

test("unavailable customers stay paused after acknowledgements and emoji, until an admin resumes", async (t) => {
  const { app, db } = fixture(t);
  for (const [index, text] of [
    "ตอนนี้ยังไม่พร้อมค่ะ",
    "ไม่สะดวกค่ะ ขอบคุณค่ะ",
    "ตอนนี้ทำงาน ไม่มีเวลาเลยค่ะ",
    "ยังไม่สนใจครับ ขอบคุณครับ",
    "ช่วงนี้ขอพักการคุยก่อนค่ะ",
    "ไม่ว่างครับผม",
    "ยัง ๆ ค่ะพี่ตอนนี้ยังไม่พร้อมค่ะ",
    "ตอนนี่ทำงานครับไม่มีเวลาเลยครับ",
    "ยังไม่สนใจครับ ขอพักเรื่องนี้ก่อน",
  ].entries()) {
    const customerId = `synthetic-pause-${index}`;
    db.upsertCustomer(customerId, {});
    db.setAiEnabled(customerId, false);
    const job = db.createFollowup({ customerId, scheduledAt: Date.now() + 60000, createdBy: "owner" });
    await app.pipeline.handleInboundText({ customerId, text });
    assert.equal(db.getCustomer(customerId).followup_enabled, 0, text);
    assert.equal(db.getFollowup(job.id).status, "cancelled", text);
    for (const acknowledgement of ["ขอบคุณค่ะ", "🙏"]) {
      await app.pipeline.handleInboundText({ customerId, text: acknowledgement });
      db.recordScore(customerId, 9, "{}");
      assert.equal(db.getCustomer(customerId).followup_enabled, 0, acknowledgement);
    }
    db.setFollowupEnabled(customerId, true);
    assert.equal(db.getCustomer(customerId).followup_enabled, 1);
    assert.equal(db.getCustomer(customerId).followup_suppression_reason, "");
  }
});
