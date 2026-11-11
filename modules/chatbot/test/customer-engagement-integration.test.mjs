import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { decidePriceDisclosure } from "../src/priceDisclosure.mjs";
import { customerCareMode } from "../src/customerCare.mjs";
import { scoringStatus } from "../public/console/context.mjs";
import { memoryDb, testConfig, hermesFetchStub, lineFetchStub, poisonGlobalFetch } from "./helpers.mjs";
poisonGlobalFetch();
const now = () => Date.parse("2026-09-13T01:00:00Z");
const silent = { log() {}, warn() {}, error() {}, debug() {} };

test("real scorer seam records source/time and cannot turn an ad button into Hot", async (t) => {
  const db = memoryDb({ now }); t.after(() => db.close());
  const model = hermesFetchStub(JSON.stringify({ score: 9, trend: "up", buying_signals: ["จอง"], persona_type: "sme_owner", pain_point: "เดาจากปุ่ม" }));
  const app = createApp({ config: testConfig(), db, logger: silent,
    overrides: { now, hermesFetch: model, lineFetch: lineFetchStub() } });
  db.upsertCustomer("U-engagement", {});
  for (let i = 0; i < 3; i++) db.insertMessage({ id: `tap-${i}`, customerId: "U-engagement", direction: "in", content: "จองคิวได้ไหม?" });
  await app.pipeline.scoreBurst("U-engagement");
  const row = db.latestScoreRow("U-engagement");
  const payload = JSON.parse(row.payload_json);
  assert.equal(row.score, 2);
  assert.equal(payload.score_assessment.status, "insufficient_evidence");
  assert.equal(payload.score_assessment.raw_score, 9);
  assert.equal(payload.pain_point, null);
  assert.equal(payload.persona_type, "unknown");
  assert.equal(payload.score_assessment.assessed_at, new Date(now()).toISOString());
  assert.equal(payload.score_assessment.source_message_ids.length, 3);
  assert.match(model.calls[0].body.messages.at(-1).content, /preset/);
  assert.equal(db.messagesFor("U-engagement").length, 3, "stored taps preserved");
});

test("scorer evidence view keeps text/media/actor/time without modifying recentTurns", (t) => {
  const db = memoryDb({ now }); t.after(() => db.close());
  db.upsertCustomer("U-evidence", {});
  db.insertMessage({ customerId: "U-evidence", direction: "in", msgType: "image", content: "private-image-placeholder" });
  db.insertMessage({ customerId: "U-evidence", direction: "out", operator: "admin", content: "บันทึกตัวอย่าง" });
  const oldView = db.recentTurns("U-evidence");
  const evidence = db.scoringEvidenceTurns("U-evidence");
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].msg_type, "image");
  assert.equal(evidence[1].operator, "admin");
  assert.equal(evidence[1].created_at, now());
  assert.deepEqual(db.recentTurns("U-evidence"), oldView);
});

test("no score from 0 through 10 may volunteer price on a button-only opening", () => {
  for (let score = 0; score <= 10; score++) for (const text of ["คุณให้บริการอะไรบ้าง", "ราคาเทอมละเท่าไหร่"]) {
    const d = decidePriceDisclosure({ score, text, history: [], customer: {}, presetButton: { fromPresetButton: true, buttonsOnlySoFar: true } });
    assert.equal(d.mode, "defer"); assert.equal(d.volunteerPrice, false); assert.equal(d.withPromo, false);
  }
});

test("fresh money request after actual screening still gets price even with low score", () => {
  const d = decidePriceDisclosure({ text: "ราคาเท่าไหร่คะ", score: 0, customer: { price_deferred_at: 100 } });
  assert.equal(d.mode, "quote"); assert.equal(d.volunteerPrice, true);
});

test("pause/thanks defeats stale Hot and old price debt, not a fresh money question", () => {
  for (const text of ["ขอบคุณค่ะ", "โอเคค่ะ ขอบคุณมากเลยค่ะ", "ขอคิดดูก่อนค่ะ", "ไม่สะดวกค่ะ", "วันนั้นไม่ว่างครับ"]) {
    const d = decidePriceDisclosure({ text, score: 10, customer: { price_deferred_at: 100 } });
    assert.equal(d.silent, true, text); assert.equal(d.withPromo, false);
  }
  const d = decidePriceDisclosure({ text: "ไม่สะดวกวันนั้นค่ะ ราคาเท่าไหร่คะ", score: 0 });
  assert.equal(d.mode, "quote"); assert.equal(d.withPromo, false); assert.equal(d.projectPricing, false);
  assert.equal(customerCareMode("ค่ะ"), null, "accepting an offer isn't closing");
  assert.equal(customerCareMode("ขอบคุณค่ะ ขอรายละเอียดต่อได้ไหมคะ"), null, "thanks plus a new request is not a closing");
  assert.equal(customerCareMode("ตัวอย่างลูกค้าบอกว่าไม่สะดวกค่ะ"), null);
});

test("console separates insufficient evidence and old interest from current readiness", () => {
  assert.equal(scoringStatus({ at: now(), payload: { score_assessment: { status: "insufficient_evidence" } } }, {}, now()).insufficient, true);
  assert.equal(scoringStatus({ at: now() - 73 * 3600000 }, {}, now()).stale, true);
  assert.equal(scoringStatus({ at: now() }, {}, now()).stale, false);
});
