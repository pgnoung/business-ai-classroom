// F11 (ตรวจย้อนหลัง ก.ย. 2026 — D884, D886, D981): สมองล่มแล้วบอทรับปากคนที่ไม่ได้มา
//
// ของจริง: ครั้งที่สองที่สมองไม่ตอบ ลูกค้าได้ "ทีมงานกำลังเข้ามาดูแลแชทนี้ต่อให้เร็วที่สุดค่ะ" ทั้งที่ระบบปลุกแค่
// ops:hermes (เหตุระดับระบบ ไม่มีใครถูกส่งเข้าห้องนี้) · ธง NEEDS_HUMAN จากสมองล่มยังค้างเป็นวันหลังสมองกลับมา
// กติกาใหม่:
//   1) ครั้งที่สองบอกความจริงว่าตอบช้า + ให้ทางลัดหาคนที่ใช้ได้จริงโดยไม่ต้องใช้สมอง ("ขอคุยกับทีมงาน")
//   2) สมองกลับมาตอบได้ = ปลดธงรอคนที่สมองล่มตั้งเอง · ห้องที่มีเหตุอื่นก่อน/ระหว่างนั้น = ไม่แตะ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { HERMES_DOWN_TEMPLATE, HERMES_DOWN_RETRY_TEMPLATE } from "../src/pipeline.mjs";
import { routeMessage } from "../src/safetyRouter.mjs";
import { stripAiTells, ensurePoliteEnding } from "../src/humanizer.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function makeFlakyApp() {
  const db = memoryDb();
  const state = { down: true };
  const healthy = hermesFetchStub("คลาสถัดไปเปิดรับสมัครอยู่ค่ะ สนใจรอบไหนดีคะ");
  const hermesFetch = async (url, opts) => (state.down
    ? { ok: false, status: 503, json: async () => ({}) }
    : healthy(url, opts));
  const app = createApp({
    db, logger: silent, config: testConfig(),
    overrides: { hermesFetch, lineFetch: lineFetchStub(), notifier: { fireLater() {} }, sleep: async () => {} },
  });
  return { app, db, state };
}

const outbound = (db, id) => db.messagesFor(id).filter((m) => m.direction === "out").map((m) => m.content);

test("F11: สมองล่มครั้งที่สอง = บอกความจริงว่าตอบช้า ไม่รับปากว่าทีมงานกำลังเข้ามา", async (t) => {
  const { app, db } = makeFlakyApp();
  t.after(() => db.close());
  await app.pipeline.handleInboundText({ customerId: "U-stall-truth", text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  await app.pipeline.handleInboundText({ customerId: "U-stall-truth", text: "ยังอยู่ไหมครับ", replyToken: "" });
  const sent = outbound(db, "U-stall-truth");
  assert.deepEqual(sent, [HERMES_DOWN_TEMPLATE, HERMES_DOWN_RETRY_TEMPLATE]);
  for (const text of sent) {
    assert.doesNotMatch(text, /ทีมงาน(?:กำลัง|จะ)\s*(?:เข้ามา|ติดต่อ|ดูแล)|มีคน(?:กำลัง)?เข้ามา/u, `ห้ามรับปากคนที่ไม่ได้มา: ${text}`);
  }
  assert.match(HERMES_DOWN_RETRY_TEMPLATE, /ขอคุยกับทีมงาน/u);
});

test("F11: ทางลัดที่ข้อความแนะนำต้องพาไปหาคนได้จริงโดยไม่ต้องใช้สมอง", () => {
  const phrase = HERMES_DOWN_RETRY_TEMPLATE.match(/"([^"]+)"/u)?.[1];
  assert.equal(phrase, "ขอคุยกับทีมงาน");
  const route = routeMessage({ text: phrase });
  assert.equal(route.route, "human_handoff", "ต้องเป็นเส้น deterministic ที่ปลุกทีมจริง ไม่ใช่เส้นที่ต้องรอสมอง");
  assert.equal(route.escalate?.reason, "human_requested");
});

test("F11: ข้อความสมองล่มผ่านสัญญาของ humanizer (ไม่มีอะไรถูกตัด/เติม)", () => {
  for (const text of [HERMES_DOWN_TEMPLATE, HERMES_DOWN_RETRY_TEMPLATE]) {
    assert.equal(stripAiTells(text), text);
    assert.equal(ensurePoliteEnding(text), text);
  }
});

test("F11: ถ้อยคำครั้งสองรุ่นก่อนยังนับเป็นการขอเวลา — ครั้งถัดไปเงียบ ไม่ขอเวลาซ้ำ", async (t) => {
  const { app, db } = makeFlakyApp();
  t.after(() => db.close());
  const id = "U-stall-legacy";
  db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "in", content: "ราคาเท่าไหร่ครับ" });
  db.insertMessage({ customerId: id, direction: "out", content: HERMES_DOWN_TEMPLATE, agentMode: "ai" });
  db.insertMessage({ customerId: id, direction: "in", content: "ยังอยู่ไหมครับ" });
  db.insertMessage({ customerId: id, direction: "out", content: "ขออภัยที่ให้รอนะคะ 🙏 ทีมงานกำลังเข้ามาดูแลแชทนี้ต่อให้เร็วที่สุดค่ะ", agentMode: "ai" });
  const third = await app.pipeline.handleInboundText({ customerId: id, text: "ว่าไงครับ", replyToken: "" });
  assert.equal(third.suppressed, "hermes_down_repeated");
});

test("F11: สมองกลับมาตอบได้ = ปลดธงรอคนที่สมองล่มตั้งเอง + audit", async (t) => {
  const { app, db, state } = makeFlakyApp();
  t.after(() => db.close());
  const id = "U-outage-recovered";
  await app.pipeline.handleInboundText({ customerId: id, text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  assert.equal(db.getCustomer(id).state, "NEEDS_HUMAN", "ระหว่างสมองล่มต้องติดธงรอคน");
  state.down = false;
  const back = await app.pipeline.handleInboundText({ customerId: id, text: "ยังอยู่ไหมครับ", replyToken: "" });
  assert.equal(back.sent, true);
  assert.equal(db.getCustomer(id).state, "AI_ACTIVE", "บอทตอบได้แล้ว ห้องต้องไม่ค้างในคิวรอคน");
  assert.ok(db.listAudit().some((a) => a.action === "hermes_down_recovered" && a.target === id));
});

test("F11: ห้องที่รอคนด้วยเหตุอื่นอยู่ก่อนสมองล่ม = สมองกลับมาแล้วธงยังอยู่", async (t) => {
  const { app, db, state } = makeFlakyApp();
  t.after(() => db.close());
  const id = "U-outage-preexisting";
  db.upsertCustomer(id, {});
  db.setNeedsHuman(id, "jev_review_notify", "ทีมควรติดตามห้องนี้");
  await app.pipeline.handleInboundText({ customerId: id, text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  state.down = false;
  await app.pipeline.handleInboundText({ customerId: id, text: "ยังอยู่ไหมครับ", replyToken: "" });
  assert.equal(db.getCustomer(id).state, "NEEDS_HUMAN", "ธงที่ไม่ได้เกิดจากสมองล่มห้ามถูกปลดอัตโนมัติ");
  assert.ok(!db.listAudit().some((a) => a.action === "hermes_down_recovered" && a.target === id));
});

test("F11: มีเหตุอื่นเกิดระหว่างสมองล่ม = สมองกลับมาแล้วธงยังอยู่", async (t) => {
  const { app, db, state } = makeFlakyApp();
  t.after(() => db.close());
  const id = "U-outage-new-reason";
  await app.pipeline.handleInboundText({ customerId: id, text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  db.setNeedsHuman(id, "jev_review_notify", "ทีมควรติดตามห้องนี้");
  state.down = false;
  await app.pipeline.handleInboundText({ customerId: id, text: "ยังอยู่ไหมครับ", replyToken: "" });
  assert.equal(db.getCustomer(id).state, "NEEDS_HUMAN");
});
