// console-intro-media — เมนู Intro จักรวาลลูกแพร (ปิดเป็นค่าเริ่มต้น เจ้าของเปิดเอง)
// + การเสิร์ฟวิดีโออินโทรแบบ HTTP Range (Safari เล่น <video> ไม่ได้เลยถ้าไม่มี 206) — 28 ก.ย. 2026
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { CONSOLE_INTRO_SETTING, consoleIntroMedia } from "../src/consoleIntroApi.mjs";
import { CONSOLE_MEDIA_FILE_NAMES, CONSOLE_STATIC_FILE_NAMES, parseByteRange, serveConsoleStatic, serveRangeFile } from "../src/consoleStatic.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const SECRET = "console-intro-test-secret";
const PASSWORD = "intro-pass-123456";
const silent = { log() {}, warn() {}, error() {} };

async function start(t, { theme = "lukprae", dataDir = null } = {}) {
  const db = memoryDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "owner", passHash, displayName: "เจ้าของ", role: "owner" });
  db.createOperator({ username: "admin", passHash, displayName: "แอดมิน", role: "admin" });
  db.createOperator({ username: "staff", passHash, displayName: "ทีมงาน", role: "operator" });
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, CONSOLE_BRAND_THEME: theme, ...(dataDir ? { DATA_DIR: dataDir } : {}) });
  const app = createApp({ config, db, overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

const me = (server, session) => httpRequest(server, { path: "/console/api/me", headers: { cookie: session.cookie } });
const toggle = (server, session, body, { csrf = session.csrf } = {}) => httpRequest(server, {
  method: "POST", path: "/console/api/intro",
  headers: { cookie: session.cookie, "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
  body: JSON.stringify(body),
});

test("intro: ปิดเป็นค่าเริ่มต้น และไม่มีวิดีโอก็ไม่หลอกว่ามี", async (t) => {
  const { app } = await start(t);
  const owner = await login(app.server, "owner");
  const res = await me(app.server, owner);
  assert.equal(res.json.features.intro, false);
  assert.deepEqual(res.json.introMedia, { video: false, poster: false });
  const state = await httpRequest(app.server, { path: "/console/api/intro", headers: { cookie: owner.cookie } });
  assert.equal(state.status, 200);
  assert.equal(state.json.enabled, false);
  assert.equal(state.json.available, true);
  assert.equal(state.json.canManage, true);
});

test("intro: เจ้าของเปิดแล้วทุกบทบาทเห็นเมนู ปิดแล้วหายทั้งหมด และมีบันทึก audit", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "owner");
  const staff = await login(app.server, "staff");
  const on = await toggle(app.server, owner, { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.enabled, true);
  assert.equal(db.getSetting(CONSOLE_INTRO_SETTING), "1");
  assert.equal((await me(app.server, owner)).json.features.intro, true);
  assert.equal((await me(app.server, staff)).json.features.intro, true, "ทีมงานต้องเห็นเมนูเมื่อเจ้าของเปิด");
  assert.ok(db.listAudit(20).some((row) => row.action === "console_intro_toggle" && row.detail === "on"));
  const off = await toggle(app.server, owner, { enabled: false });
  assert.equal(off.json.enabled, false);
  assert.equal((await me(app.server, staff)).json.features.intro, false);
});

test("intro: เปิดได้เฉพาะเจ้าของ — admin/staff/ไม่มี CSRF/ค่าผิดรูป ถูกปฏิเสธทั้งหมด", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "owner");
  const admin = await login(app.server, "admin");
  const staff = await login(app.server, "staff");
  assert.equal((await toggle(app.server, admin, { enabled: true })).status, 403);
  assert.equal((await toggle(app.server, staff, { enabled: true })).status, 403, "staff ถูกกันตั้งแต่ด่าน route");
  assert.equal((await httpRequest(app.server, { path: "/console/api/intro", headers: { cookie: staff.cookie } })).status, 403);
  assert.equal((await toggle(app.server, owner, { enabled: true }, { csrf: "" })).status, 403);
  assert.equal((await toggle(app.server, owner, { enabled: "yes" })).status, 400);
  assert.equal(db.getSetting(CONSOLE_INTRO_SETTING), null, "ไม่มีคำขอไหนเปลี่ยนค่าได้");
  const anonymous = await httpRequest(app.server, { method: "POST", path: "/console/api/intro", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(anonymous.status, 401);
});

test("intro: instance อื่นเปิดไม่ได้เลย แม้มีค่าค้างใน DB", async (t) => {
  const { app, db } = await start(t, { theme: "airdog" });
  db.setSetting(CONSOLE_INTRO_SETTING, "1");
  const owner = await login(app.server, "owner");
  assert.equal((await me(app.server, owner)).json.features.intro, false);
  assert.equal((await toggle(app.server, owner, { enabled: true })).status, 404);
  const state = await httpRequest(app.server, { path: "/console/api/intro", headers: { cookie: owner.cookie } });
  assert.equal(state.json.available, false);
});

test("intro media: รู้ว่ามีไฟล์วิดีโอ/ภาพปกจริงไหมจากดิสก์ ไม่ต้องให้เบราว์เซอร์ยิงเดา", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-intro-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(consoleIntroMedia({ dir }), { video: false, poster: false });
  writeFileSync(join(dir, "lukprae-universe-intro.mp4"), Buffer.alloc(16));
  assert.deepEqual(consoleIntroMedia({ dir }), { video: true, poster: false });
  writeFileSync(join(dir, "lukprae-universe-intro-poster.webp"), Buffer.alloc(16));
  assert.deepEqual(consoleIntroMedia({ dir }), { video: true, poster: true });
});

/* -------------------------- วิดีโอ: HTTP Range -------------------------- */

test("byte range: รูปแบบที่ Safari/Chrome ใช้จริง + ขอบผิดรูป", () => {
  assert.deepEqual(parseByteRange("bytes=0-1", 100), { start: 0, end: 1 });
  assert.deepEqual(parseByteRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange("bytes=-5", 100), { start: 95, end: 99 });
  assert.deepEqual(parseByteRange("bytes=0-999", 100), { start: 0, end: 99 }, "ปลายเกินไฟล์ = ตัดที่ท้ายไฟล์");
  assert.equal(parseByteRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseByteRange("bytes=5-2", 100), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseByteRange("bytes=0-1,5-6", 100), null, "หลายช่วง = ไม่สนใจแล้วส่งทั้งไฟล์");
  assert.equal(parseByteRange("", 100), null);
  assert.equal(parseByteRange("items=0-1", 100), null);
});

async function rangeServer(t, path) {
  const server = createServer((req, res) => serveRangeFile(req, res, { path, type: "video/mp4" }, (r, status, body) => {
    r.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    r.end(JSON.stringify(body));
  }));
  await listen(server);
  t.after(() => server.close());
  return server;
}

test("video: 200 ทั้งไฟล์ / 206 ทีละช่วง / 416 / 304 / If-Range / HEAD — ครบตามที่ <video> ต้องใช้", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-range-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "intro.mp4");
  const bytes = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  writeFileSync(file, bytes);
  const server = await rangeServer(t, file);

  const full = await httpRequest(server, { path: "/v" });
  assert.equal(full.status, 200);
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.headers["content-type"], "video/mp4");
  assert.equal(Number(full.headers["content-length"]), 100);
  assert.deepEqual([...full.buffer], [...bytes]);
  assert.match(full.headers.etag, /^W\/"/u);

  const probe = await httpRequest(server, { path: "/v", headers: { range: "bytes=0-1" } });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers["content-range"], "bytes 0-1/100");
  assert.deepEqual([...probe.buffer], [0, 1]);

  const tail = await httpRequest(server, { path: "/v", headers: { range: "bytes=-5" } });
  assert.equal(tail.status, 206);
  assert.deepEqual([...tail.buffer], [95, 96, 97, 98, 99]);

  const bad = await httpRequest(server, { path: "/v", headers: { range: "bytes=100-" } });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers["content-range"], "bytes */100");

  const cached = await httpRequest(server, { path: "/v", headers: { "if-none-match": full.headers.etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.buffer.length, 0);

  const stale = await httpRequest(server, { path: "/v", headers: { range: "bytes=0-1", "if-range": 'W/"old"' } });
  assert.equal(stale.status, 200, "ไฟล์เปลี่ยนระหว่างดู = ส่งไฟล์ใหม่ทั้งไฟล์ ห้ามต่อชิ้นผิดไฟล์");
  assert.equal(stale.buffer.length, 100);

  const head = await httpRequest(server, { method: "HEAD", path: "/v", headers: { range: "bytes=10-19" } });
  assert.equal(head.status, 206);
  assert.equal(Number(head.headers["content-length"]), 10);
  assert.equal(head.buffer.length, 0);
});

test("video: ไฟล์อินโทรยังไม่มี = 404 เงียบ ๆ (หน้า Intro แสดงกรอบรอ) และอยู่ใน allowlist แยกจากไฟล์ static", () => {
  const name = "brand/lukprae/intro/lukprae-universe-intro.mp4";
  assert.ok(CONSOLE_MEDIA_FILE_NAMES.includes(name));
  assert.ok(!CONSOLE_STATIC_FILE_NAMES.includes(name), "วิดีโอห้ามเข้าเส้นอ่านทั้งไฟล์เข้าหน่วยความจำ");
  const response = {};
  serveConsoleStatic({ headers: {}, method: "GET" }, {}, name, (_res, status, body) => Object.assign(response, { status, body }));
  assert.equal(response.status, 404);
  assert.equal(response.body.ok, false);
});

test("video: วิดีโอ Intro ต้องล็อกอินก่อน — ไฟล์ static อื่นยังเปิดให้หน้า login ใช้ได้ (28 ก.ย. 2026)", async (t) => {
  const { app } = await start(t);
  const path = "/console/static/brand/lukprae/intro/lukprae-universe-intro.mp4";
  const anonymous = await httpRequest(app.server, { path, headers: { range: "bytes=0-1" } });
  assert.equal(anonymous.status, 401, "รู้ URL อย่างเดียวห้ามดูวิดีโอที่เจ้าของยังไม่อนุมัติเผยแพร่");
  const css = await httpRequest(app.server, { path: "/console/static/console.css" });
  assert.equal(css.status, 200, "หน้า login ยังต้องโหลด css ได้โดยไม่ล็อกอิน");
  const owner = await login(app.server, "owner");
  const signedIn = await httpRequest(app.server, { path, headers: { cookie: owner.cookie, range: "bytes=0-1" } });
  assert.notEqual(signedIn.status, 401, "ล็อกอินแล้วผ่านด่าน (ไม่มีไฟล์ในเทสต์ = 404 ตามปกติ)");
});

test("video: วิดีโอจริงอยู่ที่ DATA_DIR/console-media (นอก git/release) — ล็อกอินแล้วได้ 206 เป็นชิ้น", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "intro-data-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mediaDir = join(dataDir, "console-media");
  mkdirSync(mediaDir, { recursive: true });
  writeFileSync(join(mediaDir, "lukprae-universe-intro.mp4"), Buffer.alloc(64, 7));
  const { app, db } = await start(t, { dataDir });
  const path = "/console/static/brand/lukprae/intro/lukprae-universe-intro.mp4";
  assert.equal((await httpRequest(app.server, { path, headers: { range: "bytes=0-9" } })).status, 401);
  const owner = await login(app.server, "owner");
  const part = await httpRequest(app.server, { path, headers: { cookie: owner.cookie, range: "bytes=0-9" } });
  assert.equal(part.status, 206);
  assert.equal(part.buffer.length, 10);
  assert.equal(part.headers["content-type"], "video/mp4");
  db.setSetting(CONSOLE_INTRO_SETTING, "1");
  const info = await me(app.server, owner);
  assert.equal(info.json.introMedia.video, true, "หน้า Intro รู้ว่ามีวิดีโอจากโฟลเดอร์ข้อมูล");
});
