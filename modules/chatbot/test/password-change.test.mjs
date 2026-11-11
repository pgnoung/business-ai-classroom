// M1: เปลี่ยนรหัสผ่าน + session revocation ผ่าน token_version
// - เปลี่ยนสำเร็จ = cookie ใหม่ใช้ต่อได้ / token เก่าทุกใบ (เวอร์ชันเดิม) หลุดทันที
// - รหัสปัจจุบันผิด = 403 / รหัสใหม่สั้นเกิน = 400 / ไม่มี CSRF = 403
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
const NEW_PASSWORD = "new-secret-pass-456";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.setApprovedPrice("price-2500", 2500);
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

async function login(server, { username = "nok", password = PASSWORD } = {}) {
  const res = await postJson(server, "/console/api/login", { username, password });
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

test("M1: เปลี่ยนรหัสสำเร็จ -> cookie ใหม่ใช้ได้ + token เก่าหลุด + รหัสใหม่ล็อกอินได้ + audit", async (t) => {
  const { app, db } = await startConsole(t);
  // สองเครื่อง (สอง session) ล็อกอินพร้อมกัน — เครื่อง B ต้องหลุดหลังเครื่อง A เปลี่ยนรหัส
  const a = await login(app.server);
  const b = await login(app.server);

  const res = await postJson(app.server, "/console/api/password",
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    { cookie: a.cookie, "x-csrf-token": a.csrf });
  assert.equal(res.status, 200, res.text);
  assert.ok(res.json.csrf.length > 10, "ต้องคืน csrf ของ session ใหม่");
  const raw = res.headers["set-cookie"]?.[0] || "";
  assert.ok(raw.includes("HttpOnly"), "ต้องออก cookie ใหม่ให้เครื่องนี้");
  const freshCookie = raw.split(";")[0];

  // cookie ใหม่ (เวอร์ชันใหม่) ใช้ต่อได้ทันที
  const meFresh = await httpRequest(app.server, { path: "/console/api/me", headers: { cookie: freshCookie } });
  assert.equal(meFresh.status, 200, "session ใหม่ของเครื่องที่เปลี่ยนรหัสต้องใช้ได้");

  // token เก่าทุกใบ (ทั้งของเครื่อง A เดิมและเครื่อง B) ต้องหลุด — session revocation จริง
  for (const old of [a.cookie, b.cookie]) {
    const me = await httpRequest(app.server, { path: "/console/api/me", headers: { cookie: old } });
    assert.equal(me.status, 401, "token เวอร์ชันเดิมต้องถูกปฏิเสธ");
  }

  // csrf ใหม่ใช้ mutation ต่อได้ (ผูก sid ใหม่)
  db.upsertCustomer("U-pw", {});
  const toggle = await postJson(app.server, "/console/api/customers/U-pw/ai", { enabled: false },
    { cookie: freshCookie, "x-csrf-token": res.json.csrf });
  assert.equal(toggle.status, 200, "csrf ของ session ใหม่ต้องใช้งานได้");

  // รหัสเดิมล็อกอินไม่ได้แล้ว / รหัสใหม่ล็อกอินได้
  assert.equal((await postJson(app.server, "/console/api/login", { username: "nok", password: PASSWORD })).status, 401);
  await login(app.server, { password: NEW_PASSWORD });

  // audit password_change — ไม่มีรหัสผ่าน (แม้บางส่วน) หลุดเข้า audit
  const audit = db.listAudit().find((row) => row.action === "password_change");
  assert.equal(audit.operator, "nok");
  assert.equal(audit.detail, "");
  assert.ok(!JSON.stringify(db.listAudit()).includes(NEW_PASSWORD));
  assert.equal(db.getOperator("nok").token_version, 2, "token_version ต้องถูก bump");
});

test("M1: รหัสปัจจุบันผิด -> 403 ไม่แตะรหัส/เวอร์ชัน, session เดิมยังใช้ได้", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/password",
    { currentPassword: "wrong-current-pass", newPassword: NEW_PASSWORD },
    { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 403);
  assert.equal(db.getOperator("nok").token_version, 1, "เวอร์ชันห้ามขยับ");
  assert.equal((await httpRequest(app.server, { path: "/console/api/me", headers: { cookie } })).status, 200);
  assert.ok(!db.listAudit().some((row) => row.action === "password_change"));
  // รหัสเดิมยังล็อกอินได้ตามปกติ
  await login(app.server);
});

test("M1: รหัสใหม่สั้นกว่า 10 ตัวอักษร -> 400 ไม่แตะอะไร", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/password",
    { currentPassword: PASSWORD, newPassword: "short-123" },
    { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 400);
  assert.equal(db.getOperator("nok").token_version, 1);
  await login(app.server); // รหัสเดิมยังใช้ได้
});

test("M1: auth ครบชั้น — ไม่มี session = 401, ไม่มี/ผิด CSRF = 403", async (t) => {
  const { app, db } = await startConsole(t);
  assert.equal((await postJson(app.server, "/console/api/password",
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status, 401);
  const { cookie } = await login(app.server);
  assert.equal((await postJson(app.server, "/console/api/password",
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, { cookie })).status, 403);
  assert.equal((await postJson(app.server, "/console/api/password",
    { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    { cookie, "x-csrf-token": "forged" })).status, 403);
  assert.equal(db.getOperator("nok").token_version, 1);
});
