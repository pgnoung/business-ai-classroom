// G3 ตรวจสลิปอัตโนมัติ (pre-check ให้แอดมิน) — fail-closed (ไม่มี URL = ปิดสนิท ไม่มี call),
// valid/suspect/error ครบ, เส้นทางตอบลูกค้าเดิมไม่เปลี่ยนทุกกรณี (บอทไม่ยืนยันยอดเสมอ),
// bearer token, overview/inbox/conversation โชว์ผล, XSS-inert render
// (ทุกอย่าง mock — ห้ามแตะ network จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { summarizeSlipResult } from "../src/slipCheck.mjs";
import { hashPassword } from "../src/auth.mjs";
import { el } from "../public/console/dom.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen, sleep, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const SLIP_URL = "http://slip.check/hook";

// stub fetch ของ slip checker: ขา download รูป (LINE mock) + ขา POST ตัวตรวจ
function slipFetchStub({ image = Buffer.from("fake-image-bytes"), result = { valid: true }, resultStatus = 200, resultRaw = null, downloadStatus = 200 } = {}) {
  const downloads = [];
  const checks = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/v2/bot/message/")) {
      downloads.push({ url: u, opts });
      if (downloadStatus !== 200) return { ok: false, status: downloadStatus, headers: { get: () => null } };
      return {
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "image/jpeg" : null) },
        arrayBuffer: async () => image,
      };
    }
    checks.push({ url: u, opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (resultStatus !== 200) return { ok: false, status: resultStatus, json: async () => ({}) };
    if (resultRaw === "not-json") return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } };
    return { ok: true, status: 200, json: async () => result };
  };
  fn.downloads = downloads;
  fn.checks = checks;
  return fn;
}

function makeApp({ configOverrides = {}, slipFetch } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch, slipFetch, sleep: async () => {} },
    logger: silent,
  });
  return { app, db, lineFetch };
}

function imageEvent(userId, messageId) {
  return { type: "message", replyToken: "rt", source: { userId }, message: { type: "image", id: messageId } };
}

// ชั้น webhook จริง upsert ลูกค้า + log inbound ก่อนเรียก pipeline.handleEvent เสมอ
// — เทสต์เรียก handleEvent ตรง ๆ จึงต้อง seed แบบเดียวกัน (ดู server.mjs)
// F6 (ตรวจย้อนหลัง ก.ย. 2026): สลิปมาหลังลูกค้าได้ช่องทางชำระเงินแล้ว = ห้องมีเรื่องเงิน
// (ห้องที่ยังไม่มีเรื่องเงินได้ข้อความตอบรับรูปแทนความเงียบ — ดู test/media-no-money-room.test.mjs)
function seedInboundImage(db, userId, messageId) {
  db.upsertCustomer(userId, {});
  db.setDealStatus(userId, "awaiting_payment");
  db.insertMessage({
    id: `in:${messageId}`, customerId: userId, direction: "in",
    msgType: "image", content: `[image] id=${messageId}`,
  });
}

/* --------------------------------- summaries --------------------------------- */

test("summarizeSlipResult: ✅ พร้อมยอด / ✅ ไม่มียอด / ⚠️ พร้อมเหตุผล (fallback) / error", () => {
  assert.equal(summarizeSlipResult("valid", { amount: 38500 }), "สลิปตรวจแล้ว: ✅ ยอด 38,500 ตรง");
  assert.equal(summarizeSlipResult("valid", {}), "สลิปตรวจแล้ว: ✅ ผ่านการตรวจอัตโนมัติ");
  assert.equal(summarizeSlipResult("suspect", { reason: "ยอดไม่ตรงกับบัญชี" }), "⚠️ สลิปน่าสงสัย: ยอดไม่ตรงกับบัญชี");
  assert.equal(summarizeSlipResult("suspect", {}), "⚠️ สลิปน่าสงสัย: ไม่ผ่านการตรวจอัตโนมัติ");
  assert.equal(summarizeSlipResult("error", {}), "สลิปตรวจอัตโนมัติไม่ได้ — ให้คนตรวจ");
});

/* --------------------------------- fail-closed -------------------------------- */

test("ไม่มี SLIP_CHECK_URL = ปิดสนิท: ไม่มี call ใด ๆ, เส้นทางลูกค้าเดิมเป๊ะ (escalate เท่านั้น)", async () => {
  const slipFetch = slipFetchStub();
  const { app, db, lineFetch } = makeApp({ slipFetch });
  assert.equal(app.slipCheck.enabled, false);

  seedInboundImage(db, "U-noslip", "mid-1");
  const result = await app.pipeline.handleEvent(imageEvent("U-noslip", "mid-1"));
  assert.equal(result.route, "media_review");
  await sleep(30); // เผื่อ fire-and-forget (ต้องไม่มี)
  assert.equal(slipFetch.downloads.length + slipFetch.checks.length, 0, "ห้ามมี network call");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM slip_checks").get().n, 0);
  assert.equal(db.getCustomer("U-noslip").state, "NEEDS_HUMAN", "escalate image_review เดิมยังทำงาน");
  assert.equal(lineFetch.sends.length, 0, "บอทห้ามตอบอะไรเรื่องรูป/สลิปถึงลูกค้า");
  db.close();
});

/* ---------------------------------- happy paths ---------------------------------- */

test("สลิปผ่าน (valid): บันทึกแถว + ยอด/ref + summary ✅ + bearer token — ลูกค้าไม่ได้รับอะไรเพิ่ม", async () => {
  const slipFetch = slipFetchStub({
    result: { valid: true, amount: 38500, sender: "สมชาย", receiver: "ร้านแอร์ด็อก", transRef: "TXN-778", timestamp: "2026-08-10 09:15" },
  });
  const { app, db, lineFetch } = makeApp({
    configOverrides: { SLIP_CHECK_URL: SLIP_URL, SLIP_CHECK_TOKEN: "slip-secret-token" },
    slipFetch,
  });
  assert.equal(app.slipCheck.enabled, true);

  seedInboundImage(db, "U-valid", "mid-ok");
  await app.pipeline.handleEvent(imageEvent("U-valid", "mid-ok"));
  const row = await waitFor(() => {
    const r = db.listSlipChecksFor("U-valid", 5)[0];
    return r && r.status !== "pending" ? r : null;
  });
  assert.equal(row.status, "valid");
  assert.equal(row.amount, 38500);
  assert.equal(row.trans_ref, "TXN-778");
  assert.equal(row.message_id, "mid-ok");
  assert.equal(JSON.parse(row.payload_json).sender, "สมชาย");

  // POST ไปตัวตรวจ: มี base64 + bearer + ids ครบ
  assert.equal(slipFetch.checks.length, 1);
  const call = slipFetch.checks[0];
  assert.equal(call.url, SLIP_URL);
  assert.equal(call.opts.headers.authorization, "Bearer slip-secret-token");
  assert.equal(call.body.imageBase64, Buffer.from("fake-image-bytes").toString("base64"));
  assert.deepEqual({ customerId: call.body.customerId, messageId: call.body.messageId }, { customerId: "U-valid", messageId: "mid-ok" });

  // summary เข้าธง NEEDS_HUMAN ให้แอดมินเห็น — แต่ห้ามส่งอะไรถึงลูกค้า
  const customer = db.getCustomer("U-valid");
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.ok(customer.handoff_summary.includes("✅ ยอด 38,500 ตรง"));
  assert.equal(lineFetch.sends.length, 0, "บอทไม่เคยยืนยันยอดกับลูกค้า");
  db.close();
});

test("สลิปน่าสงสัย (suspect): summary ⚠️ + เหตุผล + โผล่ overview/inbox — ลูกค้าไม่ได้รับอะไร", async () => {
  const slipFetch = slipFetchStub({ result: { valid: false, reason: "ยอดไม่ตรงกับบัญชี" } });
  const { app, db, lineFetch } = makeApp({ configOverrides: { SLIP_CHECK_URL: SLIP_URL }, slipFetch });

  seedInboundImage(db, "U-sus", "mid-sus");
  await app.pipeline.handleEvent(imageEvent("U-sus", "mid-sus"));
  const row = await waitFor(() => {
    const r = db.listSlipChecksFor("U-sus", 5)[0];
    return r && r.status !== "pending" ? r : null;
  });
  assert.equal(row.status, "suspect");
  assert.ok(db.getCustomer("U-sus").handoff_summary.includes("⚠️ สลิปน่าสงสัย: ยอดไม่ตรงกับบัญชี"));
  assert.equal(db.overviewStats().suspectSlipsToday, 1, "การ์ด overview ต้องนับได้");
  const convo = db.listConversations().find((c) => c.line_user_id === "U-sus");
  assert.equal(convo.last_slip_status, "suspect", "inbox row ต้องรู้สถานะสลิปล่าสุด");
  assert.equal(lineFetch.sends.length, 0);
  db.close();
});

test("ตัวตรวจพัง (HTTP 500 / payload ไม่มี valid / download พัง) = status error + summary ให้คนตรวจ", async () => {
  for (const [name, stubOpts] of [
    ["http_500", { resultStatus: 500 }],
    ["bad_payload", { result: { ok: true } }],
    ["download_404", { downloadStatus: 404 }],
  ]) {
    const slipFetch = slipFetchStub(stubOpts);
    const { app, db, lineFetch } = makeApp({ configOverrides: { SLIP_CHECK_URL: SLIP_URL }, slipFetch });
    seedInboundImage(db, "U-err", `mid-${name}`);
    await app.pipeline.handleEvent(imageEvent("U-err", `mid-${name}`));
    const row = await waitFor(() => {
      const r = db.listSlipChecksFor("U-err", 5)[0];
      return r && r.status !== "pending" ? r : null;
    });
    assert.equal(row.status, "error", name);
    assert.ok(db.getCustomer("U-err").handoff_summary.includes("สลิปตรวจอัตโนมัติไม่ได้"), name);
    assert.equal(lineFetch.sends.length, 0, `${name}: ลูกค้าต้องไม่ได้รับอะไร`);
    db.close();
  }
});

/* ------------------------------ console integration ------------------------------ */

const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

test("conversation API คืน slipChecks ให้หน้าแชทวาดการ์ดใต้รูป (id แถวรูป = in:<message id>)", async (t) => {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, SLIP_CHECK_URL: SLIP_URL });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const slipFetch = slipFetchStub({ result: { valid: true, amount: 1200 } });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), slipFetch, sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });

  // จำลอง webhook layer: log รูปขาเข้าด้วย id แบบเดียวกับ server (in:<message id>)
  db.upsertCustomer("U-conv", {});
  db.insertMessage({ id: "in:mid-77", customerId: "U-conv", direction: "in", msgType: "image", content: "[image] id=mid-77" });
  await app.pipeline.handleEvent(imageEvent("U-conv", "mid-77"));
  await waitFor(() => {
    const r = db.listSlipChecksFor("U-conv", 5)[0];
    return r && r.status !== "pending" ? r : null;
  });

  const loginRes = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: PASSWORD }),
  });
  const cookie = (loginRes.headers["set-cookie"]?.[0] || "").split(";")[0];
  const convo = await httpRequest(app.server, {
    path: "/console/api/conversations/U-conv/messages", headers: { cookie },
  });
  assert.equal(convo.status, 200);
  assert.equal(convo.json.slipChecks.length, 1);
  assert.equal(convo.json.slipChecks[0].status, "valid");
  assert.equal(convo.json.slipChecks[0].message_id, "mid-77");
  const imageRow = convo.json.messages.find((m) => m.msg_type === "image");
  assert.equal(imageRow.id, `in:${convo.json.slipChecks[0].message_id}`, "หน้าแชทจับคู่การ์ดกับฟองรูปด้วย id นี้");
});

/* ------------------------------- XSS-inert UI ------------------------------- */

function fakeDocument() {
  const createTextNode = (s) => ({ nodeType: 3, nodeValue: s, textContent: s });
  const createElement = (tag) => ({
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: "",
    attrs: {},
    children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    append(...nodes) { this.children.push(...nodes); },
    get textContent() { return this.children.map((c) => c.textContent ?? "").join(""); },
  });
  return { createElement, createTextNode };
}

test("XSS: reason จากตัวตรวจภายนอกเรนเดอร์ผ่าน el() เป็น text node เสมอ", (t) => {
  globalThis.document = fakeDocument();
  t.after(() => { delete globalThis.document; });
  const payload = `<img src=x onerror=alert(1)> "><svg/onload=hack()>`;
  const node = el("span", { class: "slip-meta" }, payload);
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].nodeType, 3);
  assert.equal(node.children[0].nodeValue, payload);
});
