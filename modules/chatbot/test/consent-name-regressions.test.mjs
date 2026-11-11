import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { OPTOUT_TEMPLATE } from "../src/safetyRouter.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const WORKFLOW = "ตั้งใจส่งเสริมการตลาดออนไลน์ เดิมให้เซลส์ทำ newsletter ส่ง แต่ไม่รู้ว่าส่งจริงไหม ผลตอบรับเป็นอย่างไร convert เป็นยอดขายเท่าไร ลูกค้าจะคลิกให้เป็นอีเมลสแปมไหม จะ unsubscribe ไหม";

function fixture(t, reply = "เริ่มจากดูผลตอบรับของอีเมลได้ค่ะ") {
  const db = memoryDb();
  const lineFetch = lineFetchStub();
  const hermesFetch = hermesFetchStub(reply);
  const app = createApp({ config: testConfig(), db,
    overrides: { lineFetch, hermesFetch, sleep: async () => {} }, logger: silent });
  t.after(() => db.close());
  return { db, app, lineFetch, hermesFetch };
}

test("newsletter use case reaches drafting without changing consent or cancelling followups", async (t) => {
  const { db, app, lineFetch, hermesFetch } = fixture(t);
  const customerId = "U-newsletter-synthetic";
  db.upsertCustomer(customerId, {});
  const followup = db.createFollowup({ customerId, scheduledAt: Date.now() + 3600000 });
  const turnId = db.insertMessage({ customerId, direction: "in", content: WORKFLOW });
  const result = await app.pipeline.handleInboundText({ customerId, text: WORKFLOW, turnId, replyToken: "test-token" });
  assert.equal(result.sent, true);
  assert.notEqual(result.route, "optout");
  assert.equal(hermesFetch.calls.length, 1, "business question must reach the normal drafting boundary");
  assert.equal(db.getCustomer(customerId).do_not_disturb, 0);
  assert.equal(db.getFollowup(followup.id).status, "pending");
  assert.equal(db.listAudit().some(row => row.action === "followup_optout"), false);
  assert.equal(lineFetch.sends.some(call => JSON.stringify(call.body).includes(OPTOUT_TEMPLATE)), false);
});

test("a separate direct opt-out after a business question still persists consent and cancels followups", async (t) => {
  const { db, app, hermesFetch } = fixture(t);
  const customerId = "U-direct-consent-synthetic";
  db.upsertCustomer(customerId, {});
  const followup = db.createFollowup({ customerId, scheduledAt: Date.now() + 3600000 });
  const text = `${WORKFLOW}\nแต่สำหรับผม ไม่ต้องส่งข้อความมาอีกนะครับ`;
  const result = await app.pipeline.handleInboundText({ customerId, text, replyToken: "test-token" });
  assert.equal(result.route, "optout");
  assert.equal(result.sent, true);
  assert.equal(hermesFetch.calls.length, 0);
  assert.equal(db.getCustomer(customerId).do_not_disturb, 1);
  assert.equal(db.getFollowup(followup.id).status, "cancelled");
  assert.equal(db.listAudit().filter(row => row.action === "followup_optout").length, 1);
});

test("a name beginning with อา is supplied to the reactive model with คุณ and survives delivery", async (t) => {
  const { db, app, lineFetch, hermesFetch } = fixture(t, "คุณอาร์ตเริ่มจากงานที่ทำซ้ำได้ค่ะ");
  const customerId = "U-address-synthetic";
  db.upsertCustomer(customerId, { displayName: "อาร์ต" });
  const result = await app.pipeline.handleInboundText({ customerId, text: "อยากเริ่มใช้เครื่องมือช่วยงานครับ", replyToken: "test-token" });
  assert.equal(result.sent, true);
  const systemText = hermesFetch.calls[0].body.messages.filter(message => message.role === "system")
    .flatMap(message => Array.isArray(message.content) ? message.content.map(part => part.text || "") : [message.content])
    .join("\n");
  assert.match(systemText, /ชื่อที่ใช้เรียกลูกค้าคนนี้คือ "คุณอาร์ต"/u);
  assert.doesNotMatch(systemText, /ชื่อที่ใช้เรียกลูกค้าคนนี้คือ "อาร์ต"/u);
  const sent = lineFetch.sends.flatMap(call => call.body.messages || []).map(message => message.text || "").join("\n");
  assert.match(sent, /คุณอาร์ต/u);
  assert.doesNotMatch(sent, /คุณคุณ/u);
});
