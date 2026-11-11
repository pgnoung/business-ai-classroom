// Console หน้าใหม่ (ภาพรวม + คิวรีวิวคำแก้) — overview stats จาก SQL (ขอบเขตวันไทย),
// corrections list/decide (CSRF, audit, invalid action), canary OFF/enabled, XSS-inert render
// บทเรียน: ห้าม hardcode วันที่ — fixture ทุกแถวผูกกับ "ตอนนี้" ผ่าน bangkokDayStartMs(Date.now())
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { bangkokDayStartMs } from "../src/db.mjs";
import { el } from "../public/console/dom.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t, { configOverrides = {} } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, ...configOverrides });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
    },
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
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

// ย้อน created_at ของแถวที่ seed ไว้ให้เป็น "เมื่อวาน" — ผูกกับ now เสมอ ไม่ hardcode วันที่
function rewind(db, table, keyCol, key, ts) {
  db.raw.prepare(`UPDATE ${table} SET created_at = ? WHERE ${keyCol} = ?`).run(ts, key);
}

/* ------------------------------- auth (deny) ------------------------------- */

test("overview/corrections: ไม่มี session -> 401 (deny by default)", async (t) => {
  const { app } = await startConsole(t);
  for (const path of ["/console/api/overview", "/console/api/corrections"]) {
    const res = await httpRequest(app.server, { path });
    assert.equal(res.status, 401, path);
  }
  const decide = await postJson(app.server, "/console/api/corrections/x/decide", { action: "approve" });
  assert.equal(decide.status, 401);
});

/* --------------------------------- overview -------------------------------- */

test("overview: ตัวเลขถูกต้องจาก fixture + ขอบเขตวันไทย + ไม่นับ canary", async (t) => {
  const { app, db } = await startConsole(t);
  const dayStart = bangkokDayStartMs(Date.now());

  // วันนี้: ลูกค้าใหม่ 2 คน, inbound 2, image out 1, text out 1 (ต้องไม่ปนเป็นรูป)
  db.upsertCustomer("U-today", { displayName: "คุณวันนี้" });
  db.upsertCustomer("U-aioff", {});
  db.setAiEnabled("U-aioff", false);
  db.insertMessage({ customerId: "U-today", direction: "in", content: "สวัสดีค่ะ" });
  db.insertMessage({ customerId: "U-today", direction: "in", content: "ถามราคาค่ะ" });
  db.insertMessage({ customerId: "U-today", direction: "out", msgType: "image", content: "[image:a] url" });
  db.insertMessage({ customerId: "U-today", direction: "out", content: "ตอบแล้วค่ะ" });

  // เมื่อวาน (ผูกกับ now): ลูกค้าเก่า + inbound เก่า + image เก่า — ห้ามนับเป็น "วันนี้"
  db.upsertCustomer("U-old", {});
  db.setNeedsHuman("U-old", "complaint");
  db.insertMessage({ id: "m-old-in", customerId: "U-old", direction: "in", content: "เมื่อวาน" });
  db.insertMessage({ id: "m-old-img", customerId: "U-old", direction: "out", msgType: "image", content: "รูปเก่า" });
  rewind(db, "messages", "id", "m-old-in", dayStart - 1);
  rewind(db, "messages", "id", "m-old-img", dayStart - 1);
  rewind(db, "customers", "line_user_id", "U-old", dayStart - 1);

  // ขอบพอดีเที่ยงคืนไทย: created_at == dayStart ต้องนับเป็นวันนี้
  db.insertMessage({ id: "m-edge", customerId: "U-today", direction: "in", content: "เที่ยงคืนเป๊ะ" });
  rewind(db, "messages", "id", "m-edge", dayStart);

  // canary สังเคราะห์ต้องไม่ปนทุกตัวเลข
  db.upsertCustomer("canary:synthetic", {});
  db.insertMessage({ customerId: "canary:synthetic", direction: "in", content: "[canary] ping" });
  db.insertMessage({ customerId: "canary:synthetic", direction: "out", msgType: "image", content: "x" });

  // corrections: candidate วันนี้ 1 + candidate เมื่อวาน 1 + approved วันนี้ 1 (ไม่นับ)
  const cOld = db.addCorrection({ customerId: "U-old", aiDraft: "ร่างเก่า" });
  rewind(db, "corrections", "id", cOld, dayStart - 1);
  db.addCorrection({ customerId: "U-today", aiDraft: "ร่างวันนี้" });
  const cApproved = db.addCorrection({ customerId: "U-today", aiDraft: "อนุมัติแล้ว" });
  db.updateCorrection(cApproved, { status: "approved" });

  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/overview", headers: { cookie } });
  assert.equal(res.status, 200);
  const s = res.json.stats;
  assert.equal(s.inboundToday, 3, "inbound วันนี้ = 2 + ขอบเที่ยงคืน 1 (ไม่นับของเก่า/canary)");
  assert.equal(s.newCustomersToday, 2, "U-today + U-aioff (ไม่นับ U-old/canary)");
  assert.equal(s.needsHuman, 1);
  assert.equal(s.guardBlockedToday, 1, "candidate วันนี้เท่านั้น — approved ไม่นับ");
  assert.equal(s.guardBlockedTotal, 2, "candidate ทั้งหมด (วันนี้ + เก่า)");
  assert.equal(s.imagesSentToday, 1, "เฉพาะ msg_type=image ขาออกวันนี้ (text/ของเก่า/canary ไม่นับ)");
  assert.equal(s.aiOffCustomers, 1);
  assert.equal(s.totalCustomers, 3, "canary ไม่นับเป็นลูกค้า");
  assert.equal(s.dayStartMs, dayStart);
});

test("overview: canary ปิด (interval=0) -> OFF, เปิด -> status + round_trip_ms จาก canary_state", async (t) => {
  // ค่า default ของ testConfig ไม่ตั้ง CANARY_INTERVAL_MS = ปิด
  const off = await startConsole(t);
  const offLogin = await login(off.app.server);
  const offRes = await httpRequest(off.app.server, { path: "/console/api/overview", headers: { cookie: offLogin.cookie } });
  assert.deepEqual(offRes.json.canary, { enabled: false, status: "off" });

  const on = await startConsole(t, { configOverrides: { CANARY_INTERVAL_MS: "60000" } });
  on.db.setCanary("line-webhook", { status: "ok", detail: "reply ครบ", lastProbeAt: Date.now(), lastOkAt: Date.now(), roundTripMs: 123 });
  const onLogin = await login(on.app.server);
  const onRes = await httpRequest(on.app.server, { path: "/console/api/overview", headers: { cookie: onLogin.cookie } });
  assert.equal(onRes.json.canary.enabled, true);
  assert.equal(onRes.json.canary.status, "ok");
  assert.equal(onRes.json.canary.roundTripMs, 123);
});

/* ----------------------------- corrections list ---------------------------- */

test("corrections: list default=candidate, กรองตาม status ได้, status มั่ว -> 400", async (t) => {
  const { app, db } = await startConsole(t);
  db.addCorrection({ customerId: "U1", aiDraft: "ร่าง 1" });
  db.addCorrection({ customerId: "U2", aiDraft: "ร่าง 2", humanFinal: "คนแก้แล้ว" });
  const noop = db.addCorrection({ customerId: "U-noop", aiDraft: "ร่างเดิม [IMAGE:card]", humanFinal: "ร่างเดิม" });
  const approved = db.addCorrection({ customerId: "U3", aiDraft: "ร่าง 3" });
  db.updateCorrection(approved, { status: "approved" });

  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/corrections", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.corrections.length, 2, "default = candidate เท่านั้น");
  assert.ok(res.json.corrections.every((c) => c.status === "candidate"));
  assert.equal(res.json.hiddenNoopCount, 1, "คิวทำงานไม่นับแถวที่ไม่ใช่คำแก้จริง");
  assert.equal(res.json.corrections.some((row) => row.id === noop), false);

  const history = await httpRequest(app.server,
    { path: "/console/api/corrections?status=candidate&includeNoopHistory=true", headers: { cookie } });
  assert.equal(history.json.corrections.some((row) => row.id === noop), true,
    "หลักฐานเดิมต้องเรียกอ่านกลับได้โดยไม่ต้องย้ายหรือลบ DB");

  const ap = await httpRequest(app.server, { path: "/console/api/corrections?status=approved", headers: { cookie } });
  assert.equal(ap.json.corrections.length, 1);
  assert.equal(ap.json.corrections[0].id, approved);

  const bad = await httpRequest(app.server, { path: "/console/api/corrections?status=hacked", headers: { cookie } });
  assert.equal(bad.status, 400);
});

/* ---------------------------- corrections decide ---------------------------- */

test("decide: อนุมัติพร้อม 'คำตอบที่ควรเป็น' -> human_final ถูกบันทึกก่อน approve + audit", async (t) => {
  const { app, db } = await startConsole(t);
  const id = db.addCorrection({ customerId: "U1", aiDraft: "คอร์สนี้ 999 บาทค่ะ" });
  const { cookie, csrf } = await login(app.server);

  const res = await postJson(app.server, `/console/api/corrections/${id}/decide`,
    { action: "approve", humanFinal: "ราคาขอเช็คกับทีมก่อนนะคะ" },
    { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(res.json.correction.status, "approved");
  assert.equal(res.json.correction.human_final, "ราคาขอเช็คกับทีมก่อนนะคะ");

  const row = db.getCorrection(id);
  assert.equal(row.status, "approved");
  assert.equal(row.human_final, "ราคาขอเช็คกับทีมก่อนนะคะ");
  assert.equal(db.listCorrections("candidate").length, 0);

  const audit = db.listAudit().find((a) => a.action === "correction_approve");
  assert.equal(audit.operator, "nok");
  assert.equal(audit.target, id);
  assert.ok(audit.detail.includes("U1"));
});

test("decide: ปัดตก -> status=rejected, human_final เดิมไม่ถูกแตะ + audit", async (t) => {
  const { app, db } = await startConsole(t);
  const id = db.addCorrection({ customerId: "U2", aiDraft: "ร่าง", humanFinal: "คำแก้เดิม" });
  const { cookie, csrf } = await login(app.server);

  const res = await postJson(app.server, `/console/api/corrections/${id}/decide`,
    { action: "reject" }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  const row = db.getCorrection(id);
  assert.equal(row.status, "rejected");
  assert.equal(row.human_final, "คำแก้เดิม");
  const audit = db.listAudit().find((a) => a.action === "correction_reject");
  assert.equal(audit.target, id);
});

test("decide: ไม่มี/ผิด CSRF -> 403 แถวไม่ถูกแตะ", async (t) => {
  const { app, db } = await startConsole(t);
  const id = db.addCorrection({ customerId: "U3", aiDraft: "ร่าง" });
  const { cookie } = await login(app.server);

  const noToken = await postJson(app.server, `/console/api/corrections/${id}/decide`,
    { action: "approve" }, { cookie });
  assert.equal(noToken.status, 403);
  const badToken = await postJson(app.server, `/console/api/corrections/${id}/decide`,
    { action: "approve" }, { cookie, "x-csrf-token": "forged" });
  assert.equal(badToken.status, 403);
  assert.equal(db.getCorrection(id).status, "candidate", "decide ห้ามเกิดขึ้น");
});

test("decide: action มั่ว -> 400, id ไม่มีจริง -> 404, ตัดสินซ้ำ -> 409", async (t) => {
  const { app, db } = await startConsole(t);
  const id = db.addCorrection({ customerId: "U4", aiDraft: "ร่าง" });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const bad = await postJson(app.server, `/console/api/corrections/${id}/decide`, { action: "delete" }, headers);
  assert.equal(bad.status, 400);
  assert.equal(db.getCorrection(id).status, "candidate");

  const ghost = await postJson(app.server, "/console/api/corrections/no-such-id/decide", { action: "approve" }, headers);
  assert.equal(ghost.status, 404);

  const first = await postJson(app.server, `/console/api/corrections/${id}/decide`,
    { action: "approve", humanFinal: "คำตอบที่ทีมแก้แล้ว" }, headers);
  assert.equal(first.status, 200);
  const again = await postJson(app.server, `/console/api/corrections/${id}/decide`, { action: "reject" }, headers);
  assert.equal(again.status, 409);
  assert.equal(db.getCorrection(id).status, "approved", "ตัดสินแล้วห้ามพลิกผ่าน API นี้");
});

test("decide: humanFinal ยาวเกิน 2000 -> 400", async (t) => {
  const { app, db } = await startConsole(t);
  const id = db.addCorrection({ customerId: "U5", aiDraft: "ร่าง" });
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, `/console/api/corrections/${id}/decide`,
    { action: "approve", humanFinal: "ก".repeat(2001) }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 400);
  assert.equal(db.getCorrection(id).status, "candidate");
});

/* ------------------------------- XSS-inert UI ------------------------------ */

// DOM stub แบบเดียวกับ console.test.mjs — จับพฤติกรรม: ทุกค่า dynamic ต้องเป็น text node
function fakeDocument() {
  const createTextNode = (s) => ({ nodeType: 3, nodeValue: s, textContent: s });
  const createElement = (tag) => ({
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: "",
    attrs: {},
    listeners: {},
    children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    append(...nodes) { this.children.push(...nodes); },
    get textContent() { return this.children.map((c) => c.textContent ?? "").join(""); },
  });
  return { createElement, createTextNode };
}

test("XSS: ai_draft ที่มี <script> ผ่าน API แบบ raw แล้วเรนเดอร์ด้วย el() เป็น text node เสมอ", async (t) => {
  const { app, db } = await startConsole(t);
  const payload = `<script>steal()</script><img src=x onerror=alert(1)>`;
  db.addCorrection({ customerId: "U-xss", aiDraft: payload, humanFinal: `"><svg/onload=hack()>` });
  const { cookie } = await login(app.server);

  // server ส่ง raw ตรง ๆ — การกัน XSS อยู่ที่ DOM helper ฝั่ง client
  const res = await httpRequest(app.server, { path: "/console/api/corrections", headers: { cookie } });
  const row = res.json.corrections[0];
  assert.equal(row.ai_draft, payload);

  globalThis.document = fakeDocument();
  t.after(() => { delete globalThis.document; });
  const node = el("p", { class: "correction-draft" }, row.ai_draft);
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].nodeType, 3, "ต้องเป็น text node — parse เป็น element ไม่ได้");
  assert.equal(node.children[0].nodeValue, payload);
  const finalNode = el("p", {}, row.human_final);
  assert.equal(finalNode.children[0].nodeType, 3);
});
