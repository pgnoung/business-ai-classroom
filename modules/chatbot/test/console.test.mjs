// Operator Console (G1b) — login/lockout/expiry, CSRF, auth deny, reply, toggle,
// correction capture, static allowlist, fail-closed 503, XSS-inert DOM helper
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createConfig } from "../src/config.mjs";
import { clientIp } from "../src/consoleApi.mjs";
import { hashPassword, createSessions, SESSION_COOKIE } from "../src/auth.mjs";
import { el } from "../public/console/dom.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  signLine, httpRequest, listen, waitFor, sleep, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const LINE_SECRET = "test-line-secret";
const PASSWORD = "operator-pass-123";
// scrypt ช้าโดยตั้งใจ — hash ครั้งเดียวใช้ทุกเทสต์
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t, { configOverrides = {}, seedOperator = true, imageCatalog } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, ...configOverrides });
  const db = memoryDb();
  db.setApprovedPrice("price-2500", 2500);
  if (seedOperator) {
    db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  }
  const hermesFetch = hermesFetchStub("ขอบคุณที่ทักมานะคะ เดี๋ยวดูแลให้เลยค่ะ");
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch, lineFetch, sleep: async () => {},
      ...(imageCatalog ? { imageCatalog } : {}),
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, config, hermesFetch, lineFetch };
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
  const setCookie = res.headers["set-cookie"]?.[0] || "";
  return { cookie: setCookie.split(";")[0], csrf: res.json.csrf, raw: setCookie, operator: res.json.operator };
}

/* ------------------------------- fail-closed ------------------------------- */

test("console: ไม่มี CONSOLE_SESSION_SECRET -> 503 ทั้งหน้าเว็บและ api", async (t) => {
  const { app } = await startConsole(t, { configOverrides: { CONSOLE_SESSION_SECRET: "" } });
  const page = await httpRequest(app.server, { path: "/console" });
  assert.equal(page.status, 503);
  const api = await httpRequest(app.server, { path: "/console/api/inbox" });
  assert.equal(api.status, 503);
  // login ก็ห้ามทำงาน — ไม่มี secret = เซ็น session ไม่ได้
  const loginRes = await postJson(app.server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(loginRes.status, 503);
});

test("console: ไม่มีบัญชี operator เลย -> 503 (ต้อง seed ก่อน)", async (t) => {
  const { app } = await startConsole(t, { seedOperator: false });
  const page = await httpRequest(app.server, { path: "/console" });
  assert.equal(page.status, 503);
  const api = await httpRequest(app.server, { path: "/console/api/inbox" });
  assert.equal(api.status, 503);
  assert.ok(api.json.error.includes("OPERATOR_SEED"));
});

/* ----------------------------------- login --------------------------------- */

test("login: ถูกต้อง -> 200 + HttpOnly cookie + csrf + audit", async (t) => {
  const { app, db } = await startConsole(t);
  const { raw, csrf, operator } = await login(app.server);
  assert.ok(raw.includes("HttpOnly"));
  assert.ok(raw.includes("SameSite=Lax"));
  assert.ok(raw.includes("Path=/console"));
  assert.ok(csrf.length > 10);
  assert.equal(operator.username, "nok");
  assert.equal(operator.displayName, "พี่นก");
  const audit = db.listAudit();
  assert.equal(audit[0].action, "login");
  assert.equal(audit[0].operator, "nok");
});

test("login: รหัสผิด/user ไม่มีจริง -> 401 ข้อความกลาง ๆ + audit login_failed", async (t) => {
  const { app, db } = await startConsole(t);
  const bad = await postJson(app.server, "/console/api/login", { username: "nok", password: "wrong-pass" });
  assert.equal(bad.status, 401);
  const ghost = await postJson(app.server, "/console/api/login", { username: "ghost", password: "whatever-123" });
  assert.equal(ghost.status, 401);
  // ข้อความต้องไม่บอกใบ้ว่า username มีจริงไหม
  assert.equal(bad.json.error, ghost.json.error);
  assert.equal(db.listAudit().filter((a) => a.action === "login_failed").length, 2);
});

test("login: ผิดครบ 5 ครั้ง -> 429 ล็อกชั่วคราว แม้รหัสถูกก็ไม่ผ่าน", async (t) => {
  const { app } = await startConsole(t);
  for (let i = 0; i < 5; i += 1) {
    const res = await postJson(app.server, "/console/api/login", { username: "nok", password: `wrong-${i}` });
    assert.equal(res.status, 401);
  }
  const locked = await postJson(app.server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(locked.status, 429);
  assert.ok(locked.json.retryAfterMs > 0);
});

/* --------------------------- H4: cookie Secure ----------------------------- */

test("H4 config: consoleCookieSecure default true; CONSOLE_COOKIE_SECURE=false ปิดได้", () => {
  assert.equal(createConfig({}).consoleCookieSecure, true, "default ต้องเป็น Secure");
  assert.equal(createConfig({ CONSOLE_COOKIE_SECURE: "false" }).consoleCookieSecure, false);
  assert.equal(createConfig({ CONSOLE_COOKIE_SECURE: "true" }).consoleCookieSecure, true);
});

test("H4: login ตั้ง Set-Cookie พร้อม Secure โดย default + ถอด Secure ได้ผ่าน env", async (t) => {
  const secure = await startConsole(t);
  assert.ok((await login(secure.app.server)).raw.includes("Secure"), "default cookie ต้องมี Secure");

  const insecure = await startConsole(t, { configOverrides: { CONSOLE_COOKIE_SECURE: "false" } });
  assert.ok(!(await login(insecure.app.server)).raw.includes("Secure"), "escape hatch: http localhost ไม่มี Secure");
});

/* ------------------- H5: proxy-aware client IP + limiter -------------------- */

test("H5 clientIp: loopback อ่าน header จริง, non-loopback เชื่อ socket (กันปลอม header)", () => {
  // loopback socket -> cf-connecting-ip ชนะ
  assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "cf-connecting-ip": "203.0.113.7" } }), "203.0.113.7");
  // loopback ipv6 + ไม่มี cf -> x-forwarded-for ตัวแรก
  assert.equal(clientIp({ socket: { remoteAddress: "::1" }, headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } }), "203.0.113.9");
  // cf-connecting-ip ชนะ x-forwarded-for
  assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" } }), "1.2.3.4");
  // non-loopback socket -> เชื่อ socket ไม่สน header ที่ client ยัดมา
  assert.equal(clientIp({ socket: { remoteAddress: "198.51.100.4" }, headers: { "cf-connecting-ip": "203.0.113.7" } }), "198.51.100.4");
  // loopback แต่ไม่มี header proxy -> คืน loopback ตามเดิม
  assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), "127.0.0.1");
});

test("H5 limiter+audit: bucket ตาม cf-connecting-ip ไม่ใช่ socket loopback (กัน DoS ล็อกรวม)", async (t) => {
  const { app, db } = await startConsole(t);
  // ยิงผิด 5 ครั้งจาก IP จริง A + username คนละตัวทุกครั้ง (ถัง u: ไม่ล็อก, ถัง ip:A สะสมครบ 5)
  for (let i = 0; i < 5; i += 1) {
    const res = await postJson(app.server, "/console/api/login",
      { username: `ghost-${i}`, password: `wrong-${i}` }, { "cf-connecting-ip": "203.0.113.10" });
    assert.equal(res.status, 401);
  }
  // audit ต้องบันทึก IP จริงจาก header (ไม่ใช่ 127.0.0.1 ของ tunnel)
  const failed = db.listAudit().filter((a) => a.action === "login_failed");
  assert.equal(failed.length, 5);
  assert.ok(failed.every((a) => a.detail === "ip=203.0.113.10"), "audit ต้องเป็น IP จริง");
  // จาก IP A -> ล็อก 429 แม้รหัสถูก
  const lockedA = await postJson(app.server, "/console/api/login",
    { username: "nok", password: PASSWORD }, { "cf-connecting-ip": "203.0.113.10" });
  assert.equal(lockedA.status, 429, "IP A ยิงผิด 5 ครั้งต้องโดนล็อก");
  // จาก IP B (header ต่าง, socket เดียวกัน 127.0.0.1) -> คนละถัง ไม่โดนล็อกร่วม
  const okB = await postJson(app.server, "/console/api/login",
    { username: "nok", password: PASSWORD }, { "cf-connecting-ip": "203.0.113.99" });
  assert.equal(okB.status, 200, "IP B header ต่างกัน = คนละถัง ไม่ถูก DoS ล็อกรวม");
});

test("login: field ว่าง -> 400", async (t) => {
  const { app } = await startConsole(t);
  assert.equal((await postJson(app.server, "/console/api/login", { username: "nok" })).status, 400);
  assert.equal((await postJson(app.server, "/console/api/login", {})).status, 400);
});

/* ------------------------------ session / auth ----------------------------- */

test("console api: ไม่มี session -> 401 ทุก endpoint (deny by default)", async (t) => {
  const { app } = await startConsole(t);
  for (const path of ["/console/api/me", "/console/api/inbox", "/console/api/conversations/U1/messages", "/console/api/audit"]) {
    const res = await httpRequest(app.server, { path });
    assert.equal(res.status, 401, path);
  }
  for (const path of ["/console/api/conversations/U1/reply", "/console/api/customers/U1/ai", "/console/api/logout"]) {
    const res = await postJson(app.server, path, {});
    assert.equal(res.status, 401, path);
  }
});

test("session: cookie หมดอายุ -> 401 (expiry บังคับจริง)", async (t) => {
  const { app } = await startConsole(t);
  // เซ็นด้วย secret จริงแต่ให้ออกในอดีต — ลายเซ็นถูกทุกอย่าง ยกเว้นหมดอายุแล้ว
  let clock = Date.now() - 10 * 24 * 3600_000;
  const past = createSessions({ secret: CONSOLE_SECRET, ttlMs: 7 * 24 * 3600_000, now: () => clock });
  const expired = past.issue("nok");
  const res = await httpRequest(app.server, {
    path: "/console/api/me",
    headers: { cookie: `${SESSION_COOKIE}=${expired.token}` },
  });
  assert.equal(res.status, 401);
});

test("session: token ปลอม/เซ็นด้วย secret อื่น -> 401", async (t) => {
  const { app } = await startConsole(t);
  const other = createSessions({ secret: "some-other-secret" });
  const forged = other.issue("nok");
  const res = await httpRequest(app.server, {
    path: "/console/api/me",
    headers: { cookie: `${SESSION_COOKIE}=${forged.token}` },
  });
  assert.equal(res.status, 401);
});

test("หน้า /console: ไม่มี session -> 302 ไป login, มี session -> 200 html", async (t) => {
  const { app } = await startConsole(t);
  const anon = await httpRequest(app.server, { path: "/console" });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.location, "/console/login");

  const { cookie } = await login(app.server);
  const authed = await httpRequest(app.server, { path: "/console", headers: { cookie } });
  assert.equal(authed.status, 200);
  assert.ok(authed.text.includes("Front Desk Console"));
  assert.ok(authed.headers["content-security-policy"].includes("default-src 'self'"));
  // มี session แล้วเข้าหน้า login -> เด้งกลับ console
  const loginPage = await httpRequest(app.server, { path: "/console/login", headers: { cookie } });
  assert.equal(loginPage.status, 302);
});

test("logout: ล้าง cookie + audit", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie } = await login(app.server);
  const res = await postJson(app.server, "/console/api/logout", {}, { cookie });
  assert.equal(res.status, 200);
  assert.ok(res.headers["set-cookie"][0].includes("Max-Age=0"));
  assert.ok(db.listAudit().some((a) => a.action === "logout"));
});

/* ------------------------------------ CSRF --------------------------------- */

test("CSRF: mutating POST ไม่มี/ผิด token -> 403 ไม่แตะข้อมูล", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U1", {});
  const { cookie } = await login(app.server);

  const noToken = await postJson(app.server, "/console/api/customers/U1/ai", { enabled: false }, { cookie });
  assert.equal(noToken.status, 403);
  const badToken = await postJson(app.server, "/console/api/customers/U1/ai", { enabled: false },
    { cookie, "x-csrf-token": "forged-token" });
  assert.equal(badToken.status, 403);
  assert.equal(db.getCustomer("U1").ai_enabled, 1, "toggle ห้ามเกิดขึ้น");

  const reply = await postJson(app.server, "/console/api/conversations/U1/reply", { text: "hi" }, { cookie });
  assert.equal(reply.status, 403);
  assert.equal(db.messagesFor("U1").length, 0);
});

test("CSRF: token ของ session อื่นใช้ไม่ได้", async (t) => {
  const { app, db } = await startConsole(t);
  db.createOperator({ username: "fon", passHash: PASS_HASH, displayName: "ฝน" });
  db.upsertCustomer("U1", {});
  const a = await login(app.server);
  const b = await login(app.server, { username: "fon" });
  const res = await postJson(app.server, "/console/api/customers/U1/ai", { enabled: false },
    { cookie: a.cookie, "x-csrf-token": b.csrf });
  assert.equal(res.status, 403);
});

/* ----------------------------------- Origin -------------------------------- */

test("Origin: คำขอเปลี่ยนข้อมูลจากเว็บอื่น -> 403 แม้ session + CSRF ถูกต้อง", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U1", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const foreign = await postJson(app.server, "/console/api/customers/U1/ai", { enabled: false },
    { ...headers, origin: "https://evil.example" });
  assert.equal(foreign.status, 403, "Origin ต่างเว็บต้องถูกตัดทิ้ง");
  assert.equal(db.getCustomer("U1").ai_enabled, 1, "toggle ห้ามเกิดขึ้น");

  // ไม่มีหัว Origin = ผ่าน (client เก่า/เครื่องมือที่ไม่ใช่เบราว์เซอร์ ไม่ส่งหัวนี้)
  const noOrigin = await postJson(app.server, "/console/api/customers/U1/ai", { enabled: false }, headers);
  assert.equal(noOrigin.status, 200);
  assert.equal(db.getCustomer("U1").ai_enabled, 0);

  // Origin ตรงกับ host ของคำขอเอง = ผ่าน (dev/เทสต์ที่ไม่ได้ตั้ง CONSOLE_PUBLIC_BASE_URL)
  const host = `127.0.0.1:${app.server.address().port}`;
  const sameOrigin = await postJson(app.server, "/console/api/customers/U1/ai", { enabled: true },
    { ...headers, origin: `http://${host}` });
  assert.equal(sameOrigin.status, 200);
  assert.equal(db.getCustomer("U1").ai_enabled, 1);

  // login ก็อยู่หลังด่านนี้ — ฟอร์มล็อกอินจากเว็บอื่นยิงเข้ามาไม่ได้
  const foreignLogin = await postJson(app.server, "/console/api/login",
    { username: "nok", password: PASSWORD }, { origin: "https://evil.example" });
  assert.equal(foreignLogin.status, 403);
});

test("Origin: ฐาน URL ที่ตั้งไว้ผ่านได้ ส่วนโดเมนที่แค่ขึ้นต้นเหมือนกันไม่ผ่าน", async (t) => {
  const { app, db } = await startConsole(t, {
    configOverrides: { CONSOLE_PUBLIC_BASE_URL: "https://console.example/" },
  });
  db.upsertCustomer("U1", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const configured = await postJson(app.server, "/console/api/customers/U1/ai", { enabled: false },
    { ...headers, origin: "https://console.example" });
  assert.equal(configured.status, 200);
  assert.equal(db.getCustomer("U1").ai_enabled, 0);

  for (const origin of ["https://console.example.evil.test", "http://console.example", "null"]) {
    const res = await postJson(app.server, "/console/api/customers/U1/ai", { enabled: true },
      { ...headers, origin });
    assert.equal(res.status, 403, `origin ${origin} ต้องไม่ผ่าน`);
  }
  assert.equal(db.getCustomer("U1").ai_enabled, 0, "ไม่มีคำขอไหนแก้ค่าได้");

  // GET ไม่ถูกด่านนี้แตะ — คนกดลิงก์ห้องแชทจาก LINE ยังเปิดคอนโซลได้
  const read = await httpRequest(app.server, {
    path: "/console/api/inbox", headers: { cookie, origin: "https://evil.example" },
  });
  assert.equal(read.status, 200);
});

/* ------------------------------ operator reply ----------------------------- */

test("reply: operator ตอบ -> ผ่าน LINE mock + log messages (operator-attributed) + audit", async (t) => {
  const { app, db, lineFetch } = await startConsole(t);
  db.upsertCustomer("U1", { displayName: "คุณลูกค้า" });
  const { cookie, csrf } = await login(app.server);

  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: "เดี๋ยวพี่นกดูแลต่อเองนะคะ" }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(res.json.sent, true);

  // ต้องยิงเข้า LINE mock (push — operator ไม่มี reply token)
  assert.equal(lineFetch.calls.length, 1);
  assert.ok(lineFetch.calls[0].url.endsWith("/v2/bot/message/push"));
  assert.equal(lineFetch.calls[0].body.to, "U1");
  assert.equal(lineFetch.calls[0].body.messages[0].text, "เดี๋ยวพี่นกดูแลต่อเองนะคะ");

  // log เข้า messages: direction=out, class=reactive, operator=nok
  const out = db.messagesFor("U1").filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0].message_class, "reactive");
  assert.equal(out[0].operator, "nok");

  const audit = db.listAudit().find((a) => a.action === "reply");
  assert.equal(audit.operator, "nok");
  assert.equal(audit.target, "U1");
});

/* ตรวจปรปักษ์ 2026-09-04 (รอบที่หก): ข้อความของ operator ต้องปักหมุด price_quoted_at ด้วย
 *
 * เดิมมีแต่เส้น AI ที่ปักหมุด ส่วนข้อความ operator อาศัย priceAlreadyStated ซึ่งอ่านจาก
 * "ตัวหนังสือในหน้าต่างประวัติ 12 แถว" อย่างเดียว — พอมันเลื่อนหลุด ระบบเห็นห้องที่
 * "ยังไม่เคยแจ้งราคาและยังไม่เคยคัดกรอง" แล้วยิงคำถามคัดกรองใส่คนที่เพิ่งได้ราคาจากคนจริง
 * เหตุผลเต็ม (รวมข้อแลกเปลี่ยนที่ยอมรับแล้ว) อยู่ในคอมเมนต์ที่จุดปักใน consoleApi.mjs
 */
test("reply: ราคาคลาสที่ operator พิมพ์เอง ต้องปักหมุด price_quoted_at (หมุดอยู่รอดข้ามหน้าต่างประวัติ)", async (t) => {
  const { app, db } = await startConsole(t);
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.upsertCustomer("U1", { displayName: "คุณลูกค้า" });
  db.markPriceDeferred("U1");
  assert.equal(Number(db.getCustomer("U1").price_quoted_at), 0);
  const { cookie, csrf } = await login(app.server);

  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: "คลาสนี้ ปกติ 19,900 บาท/ท่านค่ะ" }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.ok(
    Number(db.getCustomer("U1").price_quoted_at) > 0,
    "ราคาถึงมือลูกค้าจากคนจริงก็คือถึงมือลูกค้า — หมุดต้องบันทึกไว้ ไม่ใช่ฝากไว้กับหน้าต่างประวัติ",
  );
});

test("reply: ตัวเลขที่ไม่ใช่ราคาคลาสที่อนุมัติ ห้ามปักหมุดว่าแจ้งราคาแล้ว", async (t) => {
  const { app, db } = await startConsole(t);
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.upsertCustomer("U1", { displayName: "คุณลูกค้า" });
  const { cookie, csrf } = await login(app.server);

  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: "พี่ง้วงสอนมาแล้วกว่า 5,000 คน รอบนี้เหลือ 20 ที่นั่งค่ะ" }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(
    Number(db.getCustomer("U1").price_quoted_at), 0,
    "จำนวนคน/ที่นั่ง ไม่ใช่ราคา — ตัวจับต้องเทียบกับตารางราคาต่อหัวที่อนุมัติเท่านั้น",
  );
});

test("reply: ช่องส่ง LINE ไม่พร้อม (ไม่มี mock + live off) -> 502 ไม่ log message", async (t) => {
  const { app, db } = await startConsole(t, { configOverrides: { LINE_MOCK_URL: "" } });
  db.upsertCustomer("U1", {});
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: "ทดสอบ" }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 502);
  assert.equal(db.messagesFor("U1").length, 0, "ส่งไม่ออก = ห้ามหลอก log ว่าส่งแล้ว");
});

test("reply: ลูกค้าไม่มีจริง -> 404, ข้อความว่าง/ยาวเกิน -> 400", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U1", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  assert.equal((await postJson(app.server, "/console/api/conversations/U-none/reply", { text: "x" }, headers)).status, 404);
  assert.equal((await postJson(app.server, "/console/api/conversations/U1/reply", { text: "  " }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/conversations/U1/reply", { text: "ก".repeat(2001) }, headers)).status, 400);
});

/* Public broadcast uploads are global assets without customer ownership. They
   must never be accepted as a one-to-one chat upload after private media ships. */
test("reply: marker จาก public broadcast upload ถูกทิ้งในแชท 1:1", async (t) => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const mediaDir = mkdtempSync(join(tmpdir(), "chat-attach-"));
  const { app, db, lineFetch } = await startConsole(t, {
    configOverrides: {
      MEDIA_UPLOAD_ENABLED: "true", MEDIA_DIR: mediaDir,
      MEDIA_PUBLIC_BASE_URL: "https://media.test",
    },
  });
  db.upsertCustomer("U1", { displayName: "คุณลูกค้า" });
  const { cookie, csrf } = await login(app.server);

  // รูป PNG 1x1 จริง (fixture เดียวกับ broadcast-media.test.mjs)
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const saved = app.broadcastMedia.save({
    buffer: png, contentType: "image/png", label: "สลิปตัวอย่าง.png", createdBy: "nok",
  });
  assert.match(saved.media.key, /^upload_/u, "key รูปอัปโหลดต้องขึ้นต้น upload_");

  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: `ส่งรูปให้นะคะ\n[IMAGE:${saved.media.key}]` }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(res.json.imagesSent, 0);
  assert.deepEqual(res.json.droppedImageKeys, [saved.media.key]);

  const pushed = lineFetch.calls.flatMap((c) => c.body.messages || []);
  assert.equal(pushed.some((message) => message.type === "image"), false);

  const out = db.messagesFor("U1").filter((m) => m.direction === "out");
  assert.equal(out.some((m) => m.msg_type === "image"), false);
  assert.equal(out.some((m) => m.content.includes(saved.media.key)), false);
});

// v1.4.13 (audit จับ): push ส่งทีละบอลลูน — ล้มกลางลูปแล้วลูกค้าเห็นบางส่วนไปแล้ว
// ต้องบันทึกลง DB เหมือน AI path ไม่งั้นประวัติขาด + operator กดส่งซ้ำ = ลูกค้าได้สองชุด
test("reply: LINE ล้มกลางลูป -> บันทึกเฉพาะที่ส่งถึงลูกค้าจริง + บอกว่าส่งได้บางส่วน", async (t) => {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  db.upsertCustomer("U1", { displayName: "คุณลูกค้า" });
  let pushes = 0;
  const lineFetch = async (url, opts = {}) => {
    if (!String(url).includes("/v2/bot/message/push")) return { ok: true, status: 200, json: async () => ({}) };
    pushes += 1;
    // บอลลูนแรกถึงลูกค้า บอลลูนที่สองโดนโควตาหมด (เคสจริง 2026-08-15)
    return pushes === 1
      ? { ok: true, status: 200, json: async () => ({}) }
      : { ok: false, status: 429, json: async () => ({ message: "quota" }) };
  };
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub("x"), lineFetch, sleep: async () => {}, imageCatalog: [
      { key: "class-1", url: "https://img.test/a.jpg", previewUrl: "https://img.test/a.jpg" },
    ] },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: "ส่งรูปให้นะคะ\n[IMAGE:class-1]" }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 502);
  assert.equal(res.json.partiallyDelivered, 1);
  assert.match(res.json.error, /ส่งได้บางส่วน/u, "ต้องเตือน operator ว่าอย่ากดส่งซ้ำมั่ว");

  const out = db.messagesFor("U1").filter((m) => m.direction === "out");
  assert.equal(out.length, 1, "ต้องบันทึกเฉพาะบอลลูนที่ถึงลูกค้าจริง (ห้ามบันทึกรูปที่ไม่ได้ส่ง)");
  assert.equal(out[0].msg_type, "text");
  assert.equal(out[0].operator, "nok");
});

test("reply: รูปเกินเพดาน 6 ต่อครั้ง -> คืน overflowImageKeys ไม่ทิ้งเงียบ", async (t) => {
  const catalog = Array.from({ length: 8 }, (_, i) => ({
    key: `c${i}`, url: `https://img.test/${i}.jpg`, previewUrl: `https://img.test/${i}.jpg`,
  }));
  const { app, db } = await startConsole(t, { imageCatalog: catalog });
  db.upsertCustomer("U1", {});
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: `ดูรูปนะคะ ${catalog.map((c) => `[IMAGE:${c.key}]`).join(" ")}` }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(res.json.imagesSent, 6);
  assert.deepEqual(res.json.overflowImageKeys, ["c6", "c7"], "รูปที่เกินต้องถูกรายงาน ไม่หายเงียบ");
});

/* ---------------------------- correction capture --------------------------- */

test("correction: reply พร้อม aiDraft ที่ต่างจากข้อความจริง -> เก็บ candidate", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U1", {});
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: "ราคาขอเช็คกับทีมก่อนนะคะ", aiDraft: "คอร์สนี้ 999 บาทค่ะ" },
    { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.ok(res.json.correctionId);
  const rows = db.listCorrections("candidate");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ai_draft, "คอร์สนี้ 999 บาทค่ะ");
  assert.equal(rows[0].human_final, "ราคาขอเช็คกับทีมก่อนนะคะ");
});

test("correction: reply ด้วย draftId (ร่างที่ถูกบล็อก) -> เติม human_final แถวเดิม", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U1", {});
  const draftId = db.addCorrection({ customerId: "U1", aiDraft: "ร่างที่โดนบล็อก", humanFinal: "" });
  const { cookie, csrf } = await login(app.server);

  // ร่างค้างต้องโผล่ใน GET messages ให้ operator เห็น
  const view = await httpRequest(app.server, { path: "/console/api/conversations/U1/messages", headers: { cookie } });
  assert.equal(view.json.pendingDraft.id, draftId);

  const res = await postJson(app.server, "/console/api/conversations/U1/reply",
    { text: "ฉบับที่คนแก้แล้ว", draftId, aiDraft: "ร่างที่โดนบล็อก" },
    { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(res.json.correctionId, draftId);
  const row = db.getCorrection(draftId);
  assert.equal(row.human_final, "ฉบับที่คนแก้แล้ว");
  assert.equal(db.listCorrections("candidate").length, 1, "ต้องไม่สร้างแถวซ้ำ");
});

/* ------------------------------ AI toggle + gate ---------------------------- */

test("toggle: ปิด AI จาก console แล้ว control gate หยุดตอบทันที", async (t) => {
  const { app, db, lineFetch } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);

  // ข้อความแรก: AI ตอบตามปกติ
  const body1 = JSON.stringify({
    events: [{
      type: "message", webhookEventId: "w-t1", replyToken: "rt-t1",
      source: { type: "user", userId: "U5" }, message: { id: "m-t1", type: "text", text: "สวัสดีค่ะ" },
    }],
  });
  await httpRequest(app.server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(body1, LINE_SECRET) },
    body: body1,
  });
  await waitFor(() => lineFetch.calls.length >= 1);

  // operator ปิด AI ผ่าน console
  const toggled = await postJson(app.server, "/console/api/customers/U5/ai", { enabled: false },
    { cookie, "x-csrf-token": csrf });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.json.customer.ai_enabled, 0);
  assert.equal(db.listAudit()[0].action, "ai_toggle");
  assert.equal(db.listAudit()[0].detail, "off");

  // ข้อความถัดไปต้องเงียบ (gate อ่านค่าใหม่ทันที) — inbound ยังถูก log ตามเดิม
  const before = lineFetch.calls.length;
  const body2 = JSON.stringify({
    events: [{
      type: "message", webhookEventId: "w-t2", replyToken: "rt-t2",
      source: { type: "user", userId: "U5" }, message: { id: "m-t2", type: "text", text: "ยังอยู่ไหมคะ" },
    }],
  });
  await httpRequest(app.server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(body2, LINE_SECRET) },
    body: body2,
  });
  await sleep(80);
  assert.equal(lineFetch.calls.length, before, "AI ปิดแล้วห้ามตอบ");
  assert.equal(db.messagesFor("U5").filter((m) => m.direction === "in").length, 2);
});

test("toggle: เปิด AI กลับ -> เคลียร์ธง NEEDS_HUMAN (ปิดเคส takeover)", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U6", {});
  db.setNeedsHuman("U6", "complaint", "ลูกค้าไม่พอใจ");
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/customers/U6/ai", { enabled: true },
    { cookie, "x-csrf-token": csrf });
  assert.equal(res.json.customer.state, "AI_ACTIVE");
  assert.ok(res.json.customer.handoff_summary.includes("complaint"), "summary เก็บไว้เป็นประวัติ");
});

/* ------------------------------ inbox / static ----------------------------- */

test("inbox: คืนรายการพร้อมธง needs-human + ai_enabled", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U7", { displayName: "คุณเจ็ด" });
  db.insertMessage({ customerId: "U7", direction: "in", content: "สอบถามค่ะ" });
  db.setNeedsHuman("U7", "urgent", "");
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  const convo = res.json.conversations.find((c) => c.line_user_id === "U7");
  assert.equal(convo.state, "NEEDS_HUMAN");
  assert.equal(convo.ai_enabled, 1);
  assert.equal(convo.last_message, "สอบถามค่ะ");
});

test("static: allowlist เท่านั้น — traversal/ไฟล์แปลก -> 404", async (t) => {
  const { app } = await startConsole(t);
  const js = await httpRequest(app.server, { path: "/console/static/console.js" });
  assert.equal(js.status, 200);
  assert.equal(js.headers["x-content-type-options"], "nosniff");
  assert.ok(js.headers["content-type"].startsWith("text/javascript"));
  assert.match(js.headers["cache-control"], /must-revalidate/);
  assert.ok(js.headers.etag);
  const cached = await httpRequest(app.server, {
    path: "/console/static/console.js", headers: { "if-none-match": js.headers.etag },
  });
  assert.equal(cached.status, 304, "asset เดิมต้อง revalidate โดยไม่ส่ง body ซ้ำ");
  for (const path of [
    "/console/static/../../src/config.mjs",
    "/console/static/..%2F..%2Fsrc%2Fconfig.mjs",
    "/console/static/nope.js",
  ]) {
    const res = await httpRequest(app.server, { path });
    assert.notEqual(res.status, 200, path);
  }
});

/* ------------------------------- XSS-inert DOM ----------------------------- */

// DOM stub เล็ก ๆ ให้ el() วิ่งใน Node ได้ — จับพฤติกรรม: ทุกข้อความต้องเป็น text node
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

test("XSS: ข้อความแชทที่มี HTML/script กลายเป็น text node เสมอ — ไม่มีทาง parse", (t) => {
  globalThis.document = fakeDocument();
  t.after(() => { delete globalThis.document; });

  const payload = `<img src=x onerror=alert(1)><script>steal()</script>"><svg/onload=hack()>`;
  const node = el("p", {}, payload);
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].nodeType, 3, "ต้องเป็น text node ไม่ใช่ element");
  assert.equal(node.children[0].nodeValue, payload, "server ส่ง raw text — client เก็บเป็น text ตรง ๆ");
  assert.equal(node.attrs.innerHTML, undefined);
});

test("XSS: on* แบบสตริงถูกทิ้ง / javascript: URL ถูกทิ้ง / ค่าปกติผ่าน", (t) => {
  globalThis.document = fakeDocument();
  t.after(() => { delete globalThis.document; });

  const evil = el("a", { href: "javascript:alert(1)", onclick: "steal()" }, "กดฉัน");
  assert.equal(evil.attrs.href, undefined, "javascript: URL ต้องหาย");
  assert.equal(evil.attrs.onclick, undefined, "inline handler สตริงต้องหาย");
  assert.deepEqual(evil.listeners, {});

  const dataText = el("a", { href: "data:text/html,<script>x</script>" });
  assert.equal(dataText.attrs.href, undefined);

  let clicked = false;
  const good = el("button", { class: "btn", href: "https://example.com", onclick: () => { clicked = true; } }, "ตกลง");
  assert.equal(good.className, "btn");
  assert.equal(good.attrs.href, "https://example.com");
  good.listeners.click();
  assert.equal(clicked, true);
});

test("XSS: server คืน raw text ตรง ๆ ใน JSON (ไม่ escape ฝั่ง server)", async (t) => {
  const { app, db } = await startConsole(t);
  const payload = `<script>document.cookie</script>`;
  db.upsertCustomer("U8", {});
  db.insertMessage({ customerId: "U8", direction: "in", content: payload });
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/conversations/U8/messages", headers: { cookie } });
  assert.equal(promptText(res.json.messages[0].content), payload, "ต้อง raw เป๊ะ — การกัน XSS อยู่ที่ DOM helper ฝั่ง client");
});

/* ---------------------------------- audit ---------------------------------- */

test("audit: GET /console/api/audit คืนรายการล่าสุดก่อน", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U9", {});
  const { cookie, csrf } = await login(app.server);
  await postJson(app.server, "/console/api/customers/U9/ai", { enabled: false }, { cookie, "x-csrf-token": csrf });
  const res = await httpRequest(app.server, { path: "/console/api/audit", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.audit[0].action, "ai_toggle");
  assert.ok(res.json.audit.some((a) => a.action === "login"));
});

/* ------------------------ operator reply + [IMAGE:key] ---------------------- */
// BUG 4 (Airdog trial): operator ตอบพร้อม [IMAGE:x3pro_sku_1] แล้ว marker ดิบหลุดถึงลูกค้า
// — เส้นทาง console ต้องผ่าน extractImageMarkers + แคตตาล็อกเดียวกับ AI path

const IMG_CATALOG = [
  { key: "x3pro_sku_a", url: "https://img.test/x3pro-a.jpg", previewUrl: "https://img.test/x3pro-a-s.jpg" },
  { key: "x3pro_sku_b", url: "https://img.test/x3pro-b.jpg", previewUrl: "https://img.test/x3pro-b.jpg" },
];

test("reply: marker 2 จริง + 1 แปลกหน้า -> text สะอาด + 2 รูปผ่าน LINE mock + DB + รายงาน dropped", async (t) => {
  const { app, db, lineFetch } = await startConsole(t, { imageCatalog: IMG_CATALOG });
  db.upsertCustomer("U-op-img", {});
  const { cookie, csrf } = await login(app.server);

  const res = await postJson(app.server, "/console/api/conversations/U-op-img/reply",
    { text: "รุ่นนี้ตามรูปเลยนะคะ [IMAGE:x3pro_sku_a] [image:x3pro_sku_b] [IMAGE:ghost_sku]" },
    { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(res.json.sent, true);
  assert.equal(res.json.imagesSent, 2, "response ต้องบอกจำนวนรูปที่ส่งจริง");
  assert.deepEqual(res.json.droppedImageKeys, ["ghost_sku"], "key แปลกหน้าต้องถูกรายงานให้ UI toast");

  // ขาออก LINE: text ไร้ marker + image message โครงถูกต้อง (push โหมดเดียวกับ operator เดิม)
  assert.equal(lineFetch.sends.length, 3, "text 1 + image 2 = push 3 ครั้ง");
  assert.ok(lineFetch.sends.every((c) => c.url.endsWith("/v2/bot/message/push")));
  const messages = lineFetch.sends.map((c) => c.body.messages[0]);
  assert.deepEqual(messages.map((m) => m.type), ["text", "image", "image"]);
  assert.ok(!/\[image:/iu.test(messages[0].text), `marker ดิบห้ามหลุดถึงลูกค้า: ${messages[0].text}`);
  assert.equal(messages[0].text, "รุ่นนี้ตามรูปเลยนะคะ", "ข้อความ operator ส่งตามที่พิมพ์ ไม่ผ่าน humanizer");
  assert.equal(messages[1].originalContentUrl, "https://img.test/x3pro-a.jpg");
  assert.equal(messages[1].previewImageUrl, "https://img.test/x3pro-a-s.jpg");
  assert.equal(messages[2].originalContentUrl, "https://img.test/x3pro-b.jpg");
  assert.ok(!JSON.stringify(lineFetch.calls).includes("ghost_sku"), "key แปลกหน้าห้ามหลุดทุกช่องทาง");
  assert.equal(lineFetch.loadingCalls().length, 0, "เส้นทาง operator ไม่ต้องมี loading animation");

  // DB: แถว text + แถวรูป operator-attributed ครบ
  const out = db.messagesFor("U-op-img").filter((m) => m.direction === "out");
  assert.equal(out.length, 3);
  assert.equal(out[0].msg_type, "text");
  assert.equal(out[0].content, "รุ่นนี้ตามรูปเลยนะคะ");
  const imageRows = out.filter((m) => m.msg_type === "image");
  assert.equal(imageRows.length, 2);
  assert.equal(imageRows[0].content, "[image:x3pro_sku_a] https://img.test/x3pro-a.jpg");
  assert.equal(imageRows[1].content, "[image:x3pro_sku_b] https://img.test/x3pro-b.jpg");
  assert.ok(out.every((m) => m.operator === "nok" && m.message_class === "reactive"));
});

test("reply: ไม่มี marker -> พฤติกรรมเดิมทุกอย่าง + response รายงานศูนย์", async (t) => {
  const { app, db, lineFetch } = await startConsole(t, { imageCatalog: IMG_CATALOG });
  db.upsertCustomer("U-op-plain", {});
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/conversations/U-op-plain/reply",
    { text: "เดี๋ยวพี่นกเช็คให้นะคะ" }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(res.json.imagesSent, 0);
  assert.deepEqual(res.json.droppedImageKeys, []);
  assert.equal(lineFetch.sends.length, 1);
  assert.equal(lineFetch.sends[0].body.messages[0].text, "เดี๋ยวพี่นกเช็คให้นะคะ");
  const out = db.messagesFor("U-op-plain").filter((m) => m.direction === "out");
  assert.equal(out.length, 1);
  assert.equal(out[0].content, "เดี๋ยวพี่นกเช็คให้นะคะ");
});

test("reply: marker แปลกหน้าล้วน (ไม่เหลือ text/รูป) -> 400 ไม่ส่ง ไม่ log", async (t) => {
  const { app, db, lineFetch } = await startConsole(t, { imageCatalog: IMG_CATALOG });
  db.upsertCustomer("U-op-ghost", {});
  const { cookie, csrf } = await login(app.server);
  const res = await postJson(app.server, "/console/api/conversations/U-op-ghost/reply",
    { text: "[IMAGE:ghost_sku]" }, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 400);
  assert.deepEqual(res.json.droppedImageKeys, ["ghost_sku"]);
  assert.equal(lineFetch.calls.length, 0, "ไม่มีอะไรเหลือให้ส่ง = ห้ามยิง LINE");
  assert.equal(db.messagesFor("U-op-ghost").length, 0);
});
