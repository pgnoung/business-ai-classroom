import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { validateReplyDeliveryPolicy } from "../src/replyDeliveryPolicy.mjs";
import { humanQueueStatus, waitingForHumanSince } from "../public/console/inbox.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

test("old no-op candidates cannot bury a real correction behind a raw page limit", (t) => {
  const db = memoryDb(); t.after(() => db.close());
  const real = db.addCorrection({ customerId: "synthetic", aiDraft: "คำตอบเดิม", humanFinal: "คำตอบที่แก้จริง" });
  for (let i = 0; i < 205; i += 1) db.addCorrection({ customerId: "synthetic", aiDraft: "ข้อความเดิม [IMAGE:poster]", humanFinal: "ข้อความเดิม" });
  const page = db.listCorrectionWorkQueue(1);
  assert.deepEqual(page.corrections.map((row) => row.id), [real]);
  assert.equal(page.hiddenNoopCount, 205);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM corrections").get().n, 206, "read filter must retain history");
});

test("unresolved human promise stays actionable even after an AI reply", (t) => {
  const db = memoryDb(); t.after(() => db.close());
  db.upsertCustomer("synthetic-promise");
  db.insertMessage({ customerId: "synthetic-promise", direction: "in", content: "ขอติดต่อทีมค่ะ" });
  db.addHandoffNote({ customerId: "synthetic-promise", author: "ai_promise", text: "ทีมจะรับต่อ" });
  db.insertMessage({ customerId: "synthetic-promise", direction: "out", agentMode: "ai", operator: "system", content: "บันทึกไว้แล้วค่ะ" });
  const row = db.listConversations({ segment: "needs" }).find((item) => item.line_user_id === "synthetic-promise");
  assert.equal(row.has_unkept_promise, 1);
  assert.equal(humanQueueStatus(row, { inNeedsQueue: true }).key, "needs_followup");
  assert.ok(waitingForHumanSince(row) > 0);
});

test("system delivery adjustment is diagnostic, not a human training correction", async (t) => {
  const db = memoryDb();
  const app = createApp({ config: testConfig(), db, logger: silent, overrides: {
    hermesFetch: hermesFetchStub("ยินดีช่วยแนะนำคลาสให้เหมาะกับงานค่ะ อยากนำไปช่วยงานแบบไหนคะ"),
    lineFetch: lineFetchStub(), sleep: async () => {},
    replyDeliveryPolicy: validateReplyDeliveryPolicy({ enabled: true, maxQuestions: 0 }),
  } });
  t.after(() => { app.learning.stop(); app.server.close(); db.close(); });
  const result = await app.pipeline.handleInboundText({ customerId: "synthetic-style", text: "สนใจเรียนค่ะ", replyToken: "synthetic-reply" });
  assert.equal(result.sent, true);
  assert.equal(db.listCorrections("candidate").length, 0);
  const diagnostics = db.listAudit(100).filter((row) => row.action === "reply_delivery_adjusted");
  assert.equal(diagnostics.length, 1, "must exercise the delivery adjustment path");
  assert.match(diagnostics[0].detail, /trimmed_questions|style_violation_accepted/);
  assert.doesNotMatch(diagnostics[0].detail, /คลาส|สนใจ/);
});
