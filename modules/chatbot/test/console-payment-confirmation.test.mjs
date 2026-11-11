// A-18: a human-only payment confirmation reuses lifecycle state/event logs.
// It never sends LINE or creates a second payment ledger.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { dealProgress } from "../public/console/context.mjs";
import { hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);
const CONSOLE_SECRET = "test-console-secret-payment-confirmation";
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function post(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server, username) {
  const result = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(result.status, 200, result.text);
  return { cookie: result.headers["set-cookie"][0].split(";")[0], csrf: result.json.csrf };
}

async function start(t) {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: PASS_HASH, displayName: "Owner", role: "owner" });
  db.createOperator({ username: "admin", passHash: PASS_HASH, displayName: "Admin", role: "admin" });
  db.createOperator({ username: "staff", passHash: PASS_HASH, displayName: "Staff", role: "operator" });
  db.upsertCustomer("U-payment", { displayName: "Customer" });
  db.applyLifecycleTransition({ customerId: "U-payment", toStatus: "awaiting_payment", trigger: "bank_sent", actor: "system" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, CONSOLE_COOKIE_SECURE: "false" }), db,
    overrides: { lineFetch: lineFetchStub(), hermesFetch: hermesFetchStub("x"), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

test("dealProgress: 4-step display only advances from lifecycle/event evidence", () => {
  assert.equal(dealProgress({ lifecycle: { stage: "sales", dealStatus: "price_sent" } }).steps[0].active, true);
  assert.equal(dealProgress({ lifecycle: { stage: "sales", dealStatus: "awaiting_payment" } }).steps[1].active, true);
  assert.equal(dealProgress({ lifecycle: { stage: "sales", dealStatus: "awaiting_payment" }, customer: { handoff_summary: "[now] payment_review" } }).steps[2].active, true);
  const confirmed = dealProgress({
    lifecycle: { stage: "enrolled", dealStatus: "paid_confirmed" },
    lifecycleEvents: [{ trigger: "payment_confirmed", actor: "human" }],
  });
  assert.equal(confirmed.steps[3].done, true);
  assert.equal(confirmed.canConfirm, false);
});

test("payment confirmation: admin/owner only, CSRF + explicit confirm, idempotent audit, no LINE send", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "owner");
  const admin = await login(app.server, "admin");
  const staff = await login(app.server, "staff");
  const path = "/console/api/customers/U-payment/confirm-payment";

  const before = await httpRequest(app.server, {
    path: "/console/api/conversations/U-payment/messages", headers: { cookie: admin.cookie },
  });
  assert.equal(before.status, 200, before.text);
  assert.deepEqual(before.json.lifecycle, { stage: "sales", dealStatus: "awaiting_payment" });
  assert.ok(before.json.lifecycleEvents.some((event) => event.trigger === "bank_sent"));

  const noCsrf = await post(app.server, path, { confirm: true }, { cookie: admin.cookie });
  assert.equal(noCsrf.status, 403);
  // เจ้าของตัดสิน 2026-08-25: staff ยืนยันการชำระเงินได้ แต่ประตูของ "คนกด" ยังบังคับครบทุกบทบาท
  const staffNoCsrf = await post(app.server, path, { confirm: true }, { cookie: staff.cookie });
  assert.equal(staffNoCsrf.status, 403, "CSRF still enforced for staff");
  const staffNoConfirm = await post(app.server, path, {}, { cookie: staff.cookie, "x-csrf-token": staff.csrf });
  assert.equal(staffNoConfirm.status, 400, "explicit confirm still required for staff");
  assert.deepEqual(db.getLifecycle("U-payment"), { stage: "sales", dealStatus: "awaiting_payment" });
  const notExplicit = await post(app.server, path, {}, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(notExplicit.status, 400);
  assert.deepEqual(db.getLifecycle("U-payment"), { stage: "sales", dealStatus: "awaiting_payment" });

  const confirmed = await post(app.server, path, { confirm: true }, { cookie: admin.cookie, "x-csrf-token": admin.csrf });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.json.changed, true);
  assert.deepEqual(confirmed.json.lifecycle, { stage: "enrolled", dealStatus: "paid_confirmed" });
  assert.ok(Number(db.getCustomer("U-payment").money_seen_at) > 0, "financial document guard becomes durable after human confirmation");
  const humanEvents = db.listLifecycleEvents("U-payment").filter((event) => event.trigger === "payment_confirmed");
  assert.equal(humanEvents.length, 1);
  assert.equal(humanEvents[0].actor, "human");
  assert.equal(db.listAudit().filter((row) => row.action === "payment_confirmed").length, 1);
  assert.equal(db.messagesFor("U-payment").length, 0, "confirmation never sends a customer message");

  const repeat = await post(app.server, path, { confirm: true }, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(repeat.status, 200, repeat.text);
  assert.equal(repeat.json.changed, false);
  // staff ผ่านประตูสิทธิ์จริง (ไม่ใช่ 403) และยังคง idempotent ไม่สร้างเหตุการณ์ซ้ำ
  const staffRepeat = await post(app.server, path, { confirm: true }, { cookie: staff.cookie, "x-csrf-token": staff.csrf });
  assert.equal(staffRepeat.status, 200, staffRepeat.text);
  assert.equal(staffRepeat.json.changed, false);
  assert.equal(db.listLifecycleEvents("U-payment").filter((event) => event.trigger === "payment_confirmed").length, 1);
  assert.equal(db.listAudit().filter((row) => row.action === "payment_confirmed").length, 1);
});

test("payment confirmation: wrong lifecycle state is rejected without mutation", async (t) => {
  const { app, db } = await start(t);
  const admin = await login(app.server, "admin");
  db.applyLifecycleTransition({ customerId: "U-payment", toStatus: "paid_confirmed", trigger: "test_invalid", actor: "human" });
  const response = await post(app.server, "/console/api/customers/U-payment/confirm-payment", { confirm: true }, {
    cookie: admin.cookie, "x-csrf-token": admin.csrf,
  });
  assert.equal(response.status, 409, response.text);
  assert.equal(db.listAudit().filter((row) => row.action === "payment_confirmed").length, 0);
});

test("payment confirmation: concurrent Console requests create one event and one audit", async (t) => {
  const { app, db } = await start(t);
  const admin = await login(app.server, "admin");
  const request = () => post(app.server, "/console/api/customers/U-payment/confirm-payment", { confirm: true }, {
    cookie: admin.cookie, "x-csrf-token": admin.csrf,
  });
  const [first, second] = await Promise.all([request(), request()]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.deepEqual([first.json.changed, second.json.changed].sort(), [false, true]);
  assert.equal(db.listLifecycleEvents("U-payment").filter((event) => event.trigger === "payment_confirmed").length, 1);
  assert.equal(db.listAudit().filter((row) => row.action === "payment_confirmed").length, 1);
});
