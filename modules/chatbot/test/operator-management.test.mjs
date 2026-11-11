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
const OWNER_PASSWORD = "owner-console-pass-123";
const TEAM_PASSWORD = "team-console-pass-123";
const NEW_TEAM_PASSWORD = "team-console-pass-456";
const OWNER_HASH = hashPassword(OWNER_PASSWORD);

async function startConsole(t) {
  const db = memoryDb();
  db.createOperator({
    username: "owner",
    passHash: OWNER_HASH,
    displayName: "พี่ง้วง",
    role: "owner",
  });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "operator-admin-test-secret-0123456789" }),
    db,
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
    method: "POST",
    path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server, username, password) {
  const res = await postJson(server, "/console/api/login", { username, password });
  assert.equal(res.status, 200, res.text);
  return {
    cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0],
    csrf: res.json.csrf,
    operator: res.json.operator,
  };
}

test("super admin สร้าง admin/staff ได้ และรายการไม่เปิดเผย credential", async (t) => {
  const { app, db } = await startConsole(t);
  const owner = await login(app.server, "owner", OWNER_PASSWORD);
  assert.equal(owner.operator.role, "owner");
  assert.equal(owner.operator.roleKey, "super_admin");
  assert.ok(owner.operator.capabilities.includes("users.manage"));

  for (const account of [
    { username: "team.admin", displayName: "หัวหน้าทีม", role: "admin" },
    { username: "team.staff", displayName: "ทีมแชท", role: "staff" },
  ]) {
    const res = await postJson(app.server, "/console/api/operators",
      { ...account, password: TEAM_PASSWORD },
      { cookie: owner.cookie, "x-csrf-token": owner.csrf });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.operator.roleKey, account.role);
  }

  const listed = await httpRequest(app.server, {
    path: "/console/api/operators",
    headers: { cookie: owner.cookie },
  });
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.json.operators.map((row) => row.username), ["owner", "team.admin", "team.staff"]);
  assert.equal(listed.json.operators[0].roleKey, "super_admin");
  assert.ok(!listed.text.includes("pass_hash"));
  assert.ok(!listed.text.includes("token_version"));
  assert.ok(!listed.text.includes(TEAM_PASSWORD));

  const admin = await login(app.server, "team.admin", TEAM_PASSWORD);
  assert.equal(admin.operator.roleKey, "admin");
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/operators", headers: { cookie: admin.cookie },
  })).status, 403, "Admin ห้ามจัดการบัญชีผู้ใช้");
  assert.equal((await login(app.server, "team.staff", TEAM_PASSWORD)).operator.roleKey, "staff");
  assert.ok(!JSON.stringify(db.listAudit()).includes(TEAM_PASSWORD));
});

test("เฉพาะ super admin จัดการผู้ใช้ และห้ามสร้าง/แก้บัญชี super admin", async (t) => {
  const { app } = await startConsole(t);
  const owner = await login(app.server, "owner", OWNER_PASSWORD);
  const created = await postJson(app.server, "/console/api/operators",
    { username: "staff.one", displayName: "Staff One", role: "staff", password: TEAM_PASSWORD },
    { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(created.status, 201, created.text);
  const staff = await login(app.server, "staff.one", TEAM_PASSWORD);

  assert.equal((await httpRequest(app.server, {
    path: "/console/api/operators", headers: { cookie: staff.cookie },
  })).status, 403);
  assert.equal((await postJson(app.server, "/console/api/operators",
    { username: "rogue", displayName: "Rogue", role: "admin", password: TEAM_PASSWORD },
    { cookie: staff.cookie, "x-csrf-token": staff.csrf })).status, 403);

  assert.equal((await postJson(app.server, "/console/api/operators",
    { username: "other.owner", displayName: "Owner 2", role: "super_admin", password: TEAM_PASSWORD },
    { cookie: owner.cookie, "x-csrf-token": owner.csrf })).status, 400);
  assert.equal((await postJson(app.server, "/console/api/operators/owner",
    { displayName: "Changed", role: "staff", disabled: true },
    { cookie: owner.cookie, "x-csrf-token": owner.csrf })).status, 403);
  assert.equal((await postJson(app.server, "/console/api/operators",
    { username: "x", displayName: "X", role: "staff", password: "short" },
    { cookie: owner.cookie, "x-csrf-token": owner.csrf })).status, 400);
});

test("เปลี่ยน role/ปิดบัญชี/รีเซ็ตรหัสตัด session เดิม และ staff ถูกกันจาก config", async (t) => {
  const { app, db } = await startConsole(t);
  const owner = await login(app.server, "owner", OWNER_PASSWORD);
  const create = await postJson(app.server, "/console/api/operators",
    { username: "team.user", displayName: "ทีมงาน", role: "staff", password: TEAM_PASSWORD },
    { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(create.status, 201, create.text);
  const first = await login(app.server, "team.user", TEAM_PASSWORD);

  assert.equal((await httpRequest(app.server, {
    path: "/console/api/inbox", headers: { cookie: first.cookie },
  })).status, 200, "staff ต้องทำงานแชทประจำวันได้");
  // เจ้าของตัดสิน 2026-08-25: staff ทำงานได้ทุกอย่าง ยกเว้น "ตั้งค่าเกี่ยวกับคน"
  // (1 ก.ย. 2026 เดิมข้อนี้ยิง /console/api/models แต่เส้นนั้นกลายเป็นของเจ้าของคนเดียว
  //  ตามคำสั่งเรื่อง webhook/ค่าใช้จ่าย จึงเปลี่ยนมาใช้เส้นตั้งค่างานที่ยังเป็นของทีม
  //  เจตนาเดิมของข้อนี้ไม่เปลี่ยน: staff ต้องเข้าหน้าตั้งค่างานประจำวันได้)
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/settings/schedule", headers: { cookie: first.cookie },
  })).status, 200, "staff เข้าหน้าตั้งค่างานได้ตามคำสั่งเจ้าของ");
  // คำสั่งพี่ง้วง 1 ก.ย. 2026: การตั้งค่าเชื่อมต่อ/โมเดล (มีราคาต่อ 1M token) เป็นของเจ้าของคนเดียว
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/models", headers: { cookie: first.cookie },
  })).status, 403, "staff ต้องไม่เห็นการตั้งค่าโมเดล/ราคาโมเดล");
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/operators", headers: { cookie: first.cookie },
  })).status, 403, "ข้อยกเว้นเดียวคือการตั้งค่าเรื่องคน — staff ต้องถูกกันเสมอ");
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/audit", headers: { cookie: first.cookie },
  })).status, 403, "audit คือประวัติการกระทำของคน — staff ต้องถูกกันเสมอ");

  const promote = await postJson(app.server, "/console/api/operators/team.user",
    { displayName: "หัวหน้าทีม", role: "admin", disabled: false },
    { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(promote.status, 200, promote.text);
  assert.equal(promote.json.operator.roleKey, "admin");
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/me", headers: { cookie: first.cookie },
  })).status, 401, "เปลี่ยน role ต้องตัด session เก่า");

  const admin = await login(app.server, "team.user", TEAM_PASSWORD);
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/settings/schedule", headers: { cookie: admin.cookie },
  })).status, 200, "admin จัดการ config งานประจำได้");
  // admin ถูกกันเท่ากับ staff ในเรื่องเงินและการเชื่อมต่อ — admin คือบทบาทที่แจกให้คนอื่นได้
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/models", headers: { cookie: admin.cookie },
  })).status, 403, "เลื่อนเป็น Admin แล้วก็ยังต้องไม่เห็นการตั้งค่าโมเดล");

  const reset = await postJson(app.server, "/console/api/operators/team.user/password",
    { newPassword: NEW_TEAM_PASSWORD },
    { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(reset.status, 200, reset.text);
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/me", headers: { cookie: admin.cookie },
  })).status, 401, "รีเซ็ตรหัสต้องตัด session เก่า");
  assert.equal((await postJson(app.server, "/console/api/login",
    { username: "team.user", password: TEAM_PASSWORD })).status, 401);
  await login(app.server, "team.user", NEW_TEAM_PASSWORD);

  const disable = await postJson(app.server, "/console/api/operators/team.user",
    { displayName: "หัวหน้าทีม", role: "admin", disabled: true },
    { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(disable.status, 200, disable.text);
  assert.equal((await postJson(app.server, "/console/api/login",
    { username: "team.user", password: NEW_TEAM_PASSWORD })).status, 401);
  assert.ok(!JSON.stringify(db.listAudit()).includes(NEW_TEAM_PASSWORD));
});
