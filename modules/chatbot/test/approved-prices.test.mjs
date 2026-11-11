// M5: จัดการตารางราคา approved_prices จาก console — CRUD + auth/CSRF + audit
// และ price guard ต้องเห็นการเปลี่ยนแปลงทันทีโดยไม่ต้อง restart (อ่านตารางสดทุก check)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.setApprovedPrice("คอร์สหลัก", 2500);
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db };
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

test("M5 auth: ไม่มี session = 401, ไม่มี CSRF = 403 (add/edit/delete) — ตารางไม่ถูกแตะ", async (t) => {
  const { app, db } = await startConsole(t);
  assert.equal((await httpRequest(app.server, { path: "/console/api/prices" })).status, 401);
  assert.equal((await postJson(app.server, "/console/api/prices", { label: "x", amount: 1 })).status, 401);

  const { cookie } = await login(app.server);
  assert.equal((await postJson(app.server, "/console/api/prices", { label: "x", amount: 990 }, { cookie })).status, 403);
  assert.equal((await postJson(app.server, "/console/api/prices/%E0%B8%84%E0%B8%AD%E0%B8%A3%E0%B9%8C%E0%B8%AA%E0%B8%AB%E0%B8%A5%E0%B8%B1%E0%B8%81", { amount: 990 }, { cookie })).status, 403);
  assert.equal((await httpRequest(app.server, {
    method: "DELETE", path: "/console/api/prices/x", headers: { cookie },
  })).status, 403);
  // node:sqlite คืนแถวแบบ null-prototype — เทียบเป็น JSON แทน deepEqual กับ object literal
  assert.equal(JSON.stringify(db.approvedPrices()), JSON.stringify([{ label: "คอร์สหลัก", amount: 2500 }]), "ตารางห้ามขยับ");
});

test("M5 CRUD: list/add/edit/delete + audit ครบ + validation", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  // list
  const list = await httpRequest(app.server, { path: "/console/api/prices", headers: { cookie } });
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.prices, [{ label: "คอร์สหลัก", amount: 2500 }]);

  // add
  const add = await postJson(app.server, "/console/api/prices", { label: "โปรลด", amount: 1990 }, headers);
  assert.equal(add.status, 200);
  assert.ok(add.json.prices.some((p) => p.label === "โปรลด" && p.amount === 1990));
  const auditAdd = db.listAudit().find((a) => a.action === "price_add");
  assert.equal(auditAdd.operator, "nok");
  assert.equal(auditAdd.target, "โปรลด");
  assert.equal(auditAdd.detail, "1990");

  // add ซ้ำ label เดิม -> 409
  assert.equal((await postJson(app.server, "/console/api/prices", { label: "โปรลด", amount: 2090 }, headers)).status, 409);

  // edit amount
  const edit = await postJson(app.server, `/console/api/prices/${encodeURIComponent("โปรลด")}`, { amount: 2090 }, headers);
  assert.equal(edit.status, 200);
  assert.equal(db.getApprovedPrice("โปรลด").amount, 2090);
  const auditEdit = db.listAudit().find((a) => a.action === "price_edit");
  assert.equal(auditEdit.detail, "1990 -> 2090");

  // delete
  const del = await httpRequest(app.server, {
    method: "DELETE", path: `/console/api/prices/${encodeURIComponent("โปรลด")}`,
    headers: { cookie, "x-csrf-token": csrf },
  });
  assert.equal(del.status, 200);
  assert.equal(db.getApprovedPrice("โปรลด"), null);
  const auditDel = db.listAudit().find((a) => a.action === "price_delete");
  assert.equal(auditDel.target, "โปรลด");
  assert.equal(auditDel.detail, "2090");

  // validation: label ว่าง/ยาวเกิน, amount ไม่ใช่เลขบวก, edit/delete ของที่ไม่มี
  assert.equal((await postJson(app.server, "/console/api/prices", { label: "", amount: 100 }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/prices", { label: "x".repeat(101), amount: 100 }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/prices", { label: "ดี", amount: 0 }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/prices", { label: "ดี", amount: "abc" }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/prices/ghost", { amount: 100 }, headers)).status, 404);
  assert.equal((await httpRequest(app.server, {
    method: "DELETE", path: "/console/api/prices/ghost", headers: { cookie, "x-csrf-token": csrf },
  })).status, 404);
});

test("M5: guard เห็นราคาที่เพิ่ม/ลบทันที — ไม่ต้อง restart (second-writer SQLite เกษียณ)", async (t) => {
  const { app } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  // ก่อนเพิ่ม: 4,990 ไม่อยู่ในตาราง -> block
  assert.equal(app.guard.checkOutbound("ราคา 4,990 บาทค่ะ").ok, false, "ก่อนเพิ่มต้อง block");

  // เพิ่มผ่าน console API -> guard (process เดียวกัน อ่านตารางสด) ต้องปล่อยทันที
  await postJson(app.server, "/console/api/prices", { label: "X3 Pro", amount: 4990 }, headers);
  assert.equal(app.guard.checkOutbound("ราคา 4,990 บาทค่ะ").ok, true, "เพิ่มแล้วต้องผ่านทันที");

  // แก้ยอด -> เลขเดิม block, เลขใหม่ผ่าน
  await postJson(app.server, `/console/api/prices/${encodeURIComponent("X3 Pro")}`, { amount: 5990 }, headers);
  assert.equal(app.guard.checkOutbound("ราคา 4,990 บาทค่ะ").ok, false, "ยอดเก่าหลังแก้ต้อง block");
  assert.equal(app.guard.checkOutbound("ราคา 5,990 บาทค่ะ").ok, true);

  // ลบ -> กลับไป block
  await httpRequest(app.server, {
    method: "DELETE", path: `/console/api/prices/${encodeURIComponent("X3 Pro")}`,
    headers: { cookie, "x-csrf-token": csrf },
  });
  assert.equal(app.guard.checkOutbound("ราคา 5,990 บาทค่ะ").ok, false, "ลบแล้วต้อง block ทันที");
});
