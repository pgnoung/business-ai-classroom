// F5/F6 (ตรวจย้อนหลัง ก.ย. 2026): ไฟล์/รูปในห้องที่ "ยังไม่เคยมีเรื่องเงิน" ห้ามปิด AI
//
// F5 ของจริง: ลีดสายคอนเทนต์บน Facebook ส่งวิดีโอ/ไฟล์งานระหว่างคุยกับลูกแพร ไฟล์ทุกไฟล์ปิดห้อง
// ถาวร + push ทีม โดยบอทไม่พูดอะไรเลย 5 ใน 8 ห้องไม่เคยมีคนตอบ คำถามที่ตามมาเงียบหาย
// (4 เคสที่ถูกคือลูกค้าจ่ายเงินแล้วส่งใบหัก ณ ที่จ่าย = ห้องมีเรื่องเงินอยู่แล้ว — ต้องเหมือนเดิม)
// F6 ของจริง: รูปที่ดาวน์โหลดไม่ทันหน้าต่างรอ (no_file) ปิด AI แม้ห้องไม่มีเรื่องเงิน และเส้นรูป
// ไม่มีข้อความตอบรับเลย ลูกค้าส่งเอกสารแล้วเจอความเงียบทุกครั้ง
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { FILE_ACK_TEMPLATE, IMAGE_ACK_TEMPLATE, paymentStartedFromRow } from "../src/pipeline.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function makeApp({ imageClassify = null, reply = "ได้เลยค่ะ ลูกแพรช่วยดูให้นะคะ", config = {} } = {}) {
  const db = memoryDb();
  const notices = [];
  const hermesFetch = hermesFetchStub(reply);
  const line = lineFetchStub();
  const app = createApp({
    db, logger: silent, config: testConfig(config),
    overrides: {
      notifier: { fireLater: (n) => notices.push(n) }, hermesFetch, lineFetch: line, sleep: async () => {},
      ...(imageClassify ? { imageClassify } : {}),
    },
  });
  return { app, db, notices, hermesFetch, line };
}
const fileEvent = (userId) => ({ type: "message", replyToken: "rt-file", source: { userId }, message: { type: "file", id: "f-1", fileName: "work.mp4" } });
const imageEvent = (userId, id = "img-1") => ({ type: "message", replyToken: "rt-img", source: { userId }, message: { type: "image", id } });
const sentTexts = (line) => line.sends.flatMap((s) => (s.body?.messages || []).map((m) => m.text || ""));

/* ------------------------------------ F5 ------------------------------------ */

test("F5: ห้องที่ยังไม่มีเรื่องเงิน ส่งไฟล์ = AI คุยต่อ + ตอบรับหนึ่งบรรทัด + ธงคิว ไม่ปลุกทีม", async (t) => {
  const { app, db, notices, hermesFetch, line } = makeApp();
  t.after(() => db.close());
  db.upsertCustomer("U-file-lead", {});
  const result = await app.pipeline.handleEvent(fileEvent("U-file-lead"));

  assert.equal(result.route, "file_review");
  assert.equal(result.sent, true, "ลูกค้าต้องได้ข้อความตอบรับ ไม่ใช่ความเงียบ");
  const row = db.getCustomer("U-file-lead");
  assert.equal(row.ai_enabled, 1, "ห้องที่ไม่มีเรื่องเงินห้ามปิด AI เพราะไฟล์");
  assert.equal(row.state, "NEEDS_HUMAN", "ธงคิวรอคนยังอยู่ให้ทีมเปิดดูไฟล์เมื่อสะดวก");
  assert.match(row.handoff_summary, /file_review/u);
  assert.equal(paymentStartedFromRow(row), false);
  assert.deepEqual(sentTexts(line), [FILE_ACK_TEMPLATE]);
  assert.equal(notices.filter((n) => n.reason === "file_review").length, 0, "ไม่มีเรื่องเงิน = ไม่ปลุกทีม");
  assert.equal(hermesFetch.calls.length, 0, "ห้ามส่งไฟล์เข้าโมเดล");
  assert.ok(db.listHandoffNotes("U-file-lead", 10).some((n) => n.author === "ai_auto" && /ไฟล์/u.test(n.text)));

  // คำถามที่ตามมาต้องได้คำตอบ (เดิมเงียบเพราะ AI ปิด)
  const follow = await app.pipeline.handleInboundText({ customerId: "U-file-lead", text: "คลิปนี้ตัดต่อแบบนี้โอเคไหมคะ", replyToken: "rt-2" });
  assert.equal(follow.sent, true);
  assert.equal(hermesFetch.calls.length, 1);
});

test("F5: ห้องที่มีเรื่องเงินแล้ว ส่งไฟล์ = พฤติกรรมเดิม (ปิด AI + ปลุกทีม + ไม่ตอบ)", async (t) => {
  const { app, db, notices, line } = makeApp();
  t.after(() => db.close());
  db.upsertCustomer("U-file-paid", {});
  db.markMoneySeen("U-file-paid");
  const result = await app.pipeline.handleEvent(fileEvent("U-file-paid"));
  assert.equal(result.suppressed, "file_review");
  const row = db.getCustomer("U-file-paid");
  assert.equal(row.ai_enabled, 0);
  assert.equal(row.ai_off_reason, "file_review");
  assert.equal(notices.filter((n) => n.reason === "file_review").length, 1);
  assert.equal(line.sends.length, 0, "ห้องเงินยังเงียบรอคนเหมือนเดิม");
});

// ของจริง: ลูกค้าที่จ่ายแล้วนอกสายตาระบบ (ไม่มีธงเงิน) ส่งใบหัก ณ ที่จ่าย/เลขบัญชีคืนเงิน ในห้องที่ทีมเคยคุย
test("F5: ห้องที่คนจริงเคยตอบแล้ว (ห้องของทีม) ส่งไฟล์ = พฤติกรรมเดิม แม้ไม่มีธงเงิน", async (t) => {
  const { app, db, notices, line } = makeApp();
  t.after(() => db.close());
  db.upsertCustomer("U-file-team", {});
  db.insertMessage({ customerId: "U-file-team", direction: "out", content: "ได้รับเรื่องแล้วค่ะ", operator: "chom" });
  const result = await app.pipeline.handleEvent(fileEvent("U-file-team"));
  assert.equal(result.suppressed, "file_review");
  assert.equal(db.getCustomer("U-file-team").ai_off_reason, "file_review");
  assert.equal(notices.filter((n) => n.reason === "file_review").length, 1, "ทีมต้องรู้ว่ามีเอกสารเข้ามา");
  assert.equal(line.sends.length, 0);
});

test("F5: ห้องที่คนปิด AI ไว้เอง ส่งไฟล์ = ไม่ตอบ ไม่แตะเหตุปิด", async (t) => {
  const { app, db, line } = makeApp();
  t.after(() => db.close());
  db.upsertCustomer("U-file-manual", {});
  db.setAiEnabled("U-file-manual", false, "manual");
  await app.pipeline.handleEvent(fileEvent("U-file-manual"));
  assert.equal(db.getCustomer("U-file-manual").ai_off_reason, "manual");
  assert.equal(line.sends.length, 0);
});

test("F5: คนเปิด AI คืนในห้องที่ปิดเพราะไฟล์ = ข้อความลูกค้าที่ค้างอยู่ได้คำตอบ", async (t) => {
  const { app, db, hermesFetch, line } = makeApp({ config: { CONSOLE_SESSION_SECRET: "test-console-secret-0123456789" } });
  db.createOperator({ username: "nok", passHash: hashPassword("operator-pass-123"), displayName: "พี่นก" });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const customerId = "U-file-reopen";
  db.upsertCustomer(customerId, {});
  db.markMoneySeen(customerId); // ห้องเงิน -> ไฟล์ปิด AI (เส้นเดิม)
  await app.pipeline.handleEvent(fileEvent(customerId));
  db.insertMessage({ customerId, direction: "in", content: "ส่งเอกสารให้แล้วนะคะ คลาสเริ่มกี่โมงคะ" });
  await app.pipeline.handleInboundText({ customerId, text: "ส่งเอกสารให้แล้วนะคะ คลาสเริ่มกี่โมงคะ", replyToken: "" });
  assert.equal(hermesFetch.calls.length, 0, "AI ปิดอยู่ ข้อความถูกกลืน");

  const post = (path, body, headers = {}) => httpRequest(app.server, {
    method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const auth = await post("/console/api/login", { username: "nok", password: "operator-pass-123" });
  const head = { cookie: (auth.headers["set-cookie"]?.[0] || "").split(";")[0], "x-csrf-token": auth.json.csrf };
  const on = await post(`/console/api/customers/${customerId}/ai`, { enabled: true }, head);
  assert.equal(on.status, 200);
  // >= 1: หลังตอบแล้ว scorer เรียกโมเดลต่ออีกหนึ่งครั้งแบบ fire-and-forget
  await waitFor(() => hermesFetch.calls.length >= 1, { timeout: 3000 });
  await waitFor(() => line.sends.length >= 1, { timeout: 3000 });
  assert.ok(db.listAudit().some((a) => a.action === "file_review_pending_reply" && a.target === customerId));
});

/* ------------------------------------ F6 ------------------------------------ */

const noFile = { kind: "unknown", reason: "ไม่มีไฟล์รูปให้จำแนกทัน", reasonCode: "no_file" };

test("F6: รูปดาวน์โหลดไม่ทัน (ลองซ้ำแล้ว) + ห้องไม่มีเรื่องเงิน = AI คุยต่อ + ตอบรับ + ยังปลุกคนตรวจ", async (t) => {
  let calls = 0;
  const { app, db, notices, line } = makeApp({ imageClassify: { enabled: true, classify: async () => { calls += 1; return noFile; } } });
  t.after(() => db.close());
  db.upsertCustomer("U-img-lead", {});
  const result = await app.pipeline.handleEvent(imageEvent("U-img-lead"));
  assert.equal(calls, 2, "no_file = ลองดาวน์โหลด/จำแนกซ้ำอีกหนึ่งครั้งก่อนตัดสิน");
  assert.equal(result.route, "media_review");
  const row = db.getCustomer("U-img-lead");
  assert.equal(row.ai_enabled, 1, "ห้องที่ไม่มีเรื่องเงินห้ามปิด AI เพราะรูปที่ยังไม่รู้ว่าอะไร");
  assert.equal(row.state, "NEEDS_HUMAN", "ยังต้องมีคนตรวจรูป");
  assert.equal(Number(row.money_seen_at || 0), 0);
  assert.deepEqual(sentTexts(line), [IMAGE_ACK_TEMPLATE]);
  assert.equal(notices.filter((n) => n.reason === "image_review").length, 1, "push ให้คนตรวจรูปยังอยู่");
});

test("F6: ลองซ้ำแล้วจำแนกได้ว่าไม่ใช่เรื่องเงิน = คุยต่อตามปกติ ไม่ปักธง", async (t) => {
  let calls = 0;
  const { app, db, hermesFetch } = makeApp({
    imageClassify: { enabled: true, classify: async () => { calls += 1; return calls === 1 ? noFile : { kind: "other", description: "ภาพโพสต์คลาส" }; } },
  });
  t.after(() => db.close());
  db.upsertCustomer("U-img-retry", {});
  const result = await app.pipeline.handleEvent(imageEvent("U-img-retry"));
  assert.equal(calls, 2);
  assert.notEqual(result.route, "media_review");
  assert.equal(hermesFetch.calls.length, 1, "ลูกแพรตอบรูปเองได้");
  assert.notEqual(db.getCustomer("U-img-retry").state, "NEEDS_HUMAN");
});

test("F6: ห้องที่มีเรื่องเงินแล้ว รูปที่ยังไม่รู้ว่าอะไร = เส้นเงินเดิม (ปิด AI เงียบรอคน)", async (t) => {
  const { app, db, line, notices } = makeApp({ imageClassify: { enabled: true, classify: async () => noFile } });
  t.after(() => db.close());
  db.upsertCustomer("U-img-money", {});
  db.markMoneySeen("U-img-money");
  await app.pipeline.handleEvent(imageEvent("U-img-money"));
  const row = db.getCustomer("U-img-money");
  assert.equal(row.ai_enabled, 0);
  assert.equal(row.ai_off_reason, "money_line");
  assert.equal(line.sends.length, 0);
  assert.equal(notices.filter((n) => n.reason === "image_review").length, 1);
});

test("F6: สวิตช์จำแนกรูปปิด + ห้องไม่มีเรื่องเงิน = AI คุยต่อ + ตอบรับ (เหตุ 1–5 ก.ย.)", async (t) => {
  const { app, db, line } = makeApp({ imageClassify: { enabled: false, classify: async () => ({ kind: "other" }) } });
  t.after(() => db.close());
  db.upsertCustomer("U-img-off", {});
  await app.pipeline.handleEvent(imageEvent("U-img-off"));
  assert.equal(db.getCustomer("U-img-off").ai_enabled, 1);
  assert.deepEqual(sentTexts(line), [IMAGE_ACK_TEMPLATE]);
});

test("F6: เห็นไบต์แล้วแต่จำแนกไม่ออก = ยังเป็นบริบทเงิน (ปิด AI เหมือนเดิม ไม่ส่งตอบรับ)", async (t) => {
  const { app, db, line } = makeApp({
    imageClassify: { enabled: true, classify: async () => ({ kind: "unknown", reason: "รูปใหญ่เกิน", reasonCode: "too_large" }) },
  });
  t.after(() => db.close());
  db.upsertCustomer("U-img-tried", {});
  await app.pipeline.handleEvent(imageEvent("U-img-tried"));
  const row = db.getCustomer("U-img-tried");
  assert.equal(row.ai_enabled, 0);
  assert.ok(Number(row.money_seen_at) > 0);
  assert.equal(line.sends.length, 0);
});
