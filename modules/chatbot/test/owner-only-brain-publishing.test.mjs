// owner-only-brain-publishing — คำสั่งพี่ง้วง 2 ก.ย. 2026:
// "ชมพู่ทำงานประจำวันได้เหมือนเดิมทุกอย่าง แต่การ 'เผยแพร่' ของที่เปลี่ยนสมองลูกแพร
//  — ราคา โหมดสมอง/ข้อความเสริมต่อสาขา กติกาสินค้า ลิงก์คลาสฟรี คีย์เวิร์ด # และ
//  ตารางรอบเรียน — เป็นของพี่ง้วงคนเดียว"
//
// ทำไมต้องยิง HTTP จริงและมีครบสามบทบาท (เหตุผลเดียวกับ owner-only-money-and-webhooks):
//   1) ปุ่มที่หายไปจากหน้าเว็บไม่ใช่การป้องกัน — เปิด DevTools ยิง fetch เองได้
//   2) helpers.memoryDb() เลื่อนบัญชีแรกเป็น owner อัตโนมัติ เทสต์ที่ไม่เขียน role
//      จึงล็อกอินเป็นเจ้าของทั้งไฟล์และไม่เคยพิสูจน์เรื่องสิทธิ์เลย
//   3) admin โดนกันเท่ากับ staff โดยเจตนา: admin เป็นบทบาทที่แจกให้คนอื่นได้จาก
//      dropdown ในหน้าตั้งค่า ถ้ากันแค่ staff วันที่ชมพู่ถูกเลื่อนเป็น Admin
//      เธอจะกดเปลี่ยนราคาที่บอทพูดกับลูกค้าได้ทันที
//
// เส้นแบ่งที่ต้องไม่เพี้ยน: "ที่นั่ง" (จำนวนคนที่ลงทะเบียนแล้ว) ยังเป็นงานของทีม
// ชมพู่กรอกเองได้ตลอด — กันไปด้วยคือความล้มเหลวอีกแบบหนึ่ง
//
// Package K (2 ก.ย. 2026 คำสั่งเดียวกัน) เปลี่ยน "รูป" ของการปฏิเสธ ไม่ใช่ "ผล":
// คนที่ไม่มีสิทธิ์เผยแพร่ได้ 202 พร้อมคำขอในคิว แทน 403 เปล่า ๆ — แต่ข้อพิสูจน์ที่
// สำคัญที่สุดของไฟล์นี้ยังเหมือนเดิมทุกตัวอักษร: "ยิงแล้วของจริงต้องไม่ขยับ"
// ตัวคิวเองมีเทสต์ของมันที่ test/publish-approval-queue.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { readManualRounds, writeManualRounds } from "../src/classRounds.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";
import { FREECLASS_PATTERNS_KEY } from "../src/db.mjs";
import { brainModeKey } from "../src/knowledgePack.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const SECRET = "brain-publish-console-secret-0123456789";
const PASSWORD = "publish-gate-pass-1234";
const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";

// รอบเรียนต้อง "อยู่ในอนาคต" เสมอ (upcomingRounds ตัดรอบที่ผ่านไปแล้วทิ้ง) —
// ฝังวันที่ตายตัวไว้ = เทสต์จะเขียวจนถึงวันหนึ่งแล้วแดงเองโดยไม่มีใครแก้อะไร
function futureIso(daysAhead) {
  const at = new Date(Date.now() + daysAhead * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(at);
}
const ROUND_DATE = futureIso(30);
const NEW_ROUND_DATE = futureIso(45);

async function boot(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET });
  const db = memoryDb();
  // เขียน role ครบทุกบัญชีเสมอ — ห้ามพึ่ง default ของ helpers
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "hua", passHash: hashPassword(PASSWORD), displayName: "หัวหน้า", role: "admin" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.setApprovedPrice("คอร์สหลัก", 9900);
  writeManualRounds(db, [
    { date: ROUND_DATE, classKey: "basic", label: "Classroom AI Agent for Business", product: "", status: "open", capacity: 15 },
  ]);
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

function send(server, method, path, body, headers = {}) {
  return httpRequest(server, {
    method, path,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  });
}
const post = (server, path, body, headers) => send(server, "POST", path, body, headers);
// DELETE ของเส้นราคาไม่รับ body — ส่งไปด้วยจะโดนด่านตรวจ request ตีกลับ 400 ก่อนถึงด่านสิทธิ์
const del = (server, path, headers = {}) => httpRequest(server, { method: "DELETE", path, headers });
const get = (server, path, cookie) => httpRequest(server, { path, headers: { cookie } });

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, `ล็อกอิน ${username} ต้องผ่านก่อน ไม่งั้นเทสต์ที่เหลือไม่มีความหมาย — ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

// ข้อความปฏิเสธต้องเป็นตัวกลางตัวเดียวเสมอ — ห้ามบอกใบ้ว่าที่โดนกันคือของชิ้นไหน
// (ถ้าแต่ละเส้นตอบต่างกัน คนอ่านจะไล่ได้ว่าระบบมีของอะไรซ่อนอยู่บ้าง)
// Package K: ทางที่ถูกต้องของคนที่ไม่มีสิทธิ์เผยแพร่ = คำขอเข้าคิว (ไม่ใช่ของถูกเขียน)
function assertQueued(res, where) {
  assert.equal(res.status, 202, `${where} ต้องเข้าคิวรออนุมัติ — ได้ ${res.status} ${res.text}`);
  assert.equal(res.json?.queued, true, `${where} ต้องบอกว่า queued`);
  assert.ok(res.json?.requestId, `${where} ต้องคืน requestId`);
}

function assertCleanDenial(res, where) {
  assert.equal(res.status, 403, `${where} ต้องเป็น 403 — ได้ ${res.status} ${res.text}`);
  assert.equal(res.json?.error, DENY, `${where} ต้องใช้ข้อความปฏิเสธกลาง ๆ ตัวเดียวกัน`);
  for (const leak of ["ราคา", "สมอง", "กติกา", "รอบเรียน", "price", "brain", "rules", "CSRF"]) {
    assert.ok(!res.text.includes(leak), `${where} ข้อความปฏิเสธห้ามมีคำว่า "${leak}"`);
  }
  assert.ok(!/\d/u.test(res.json?.error ?? ""), `${where} ข้อความปฏิเสธห้ามมีตัวเลข`);
}

/* ------------------------------ ก. ตารางราคา ------------------------------ */

test("ราคา: เจ้าของเพิ่ม/แก้/ลบได้ทันที · admin กับ staff ได้แค่คำขอเข้าคิว ทั้งสามเส้น", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");
  const staff = await login(app.server, "chompoo");
  const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  for (const who of [admin, staff]) {
    const label = who === admin ? "admin" : "staff";
    assertQueued(await post(app.server, "/console/api/prices", { label: "ของแอบเพิ่ม", amount: 1 }, auth(who)), `${label} เพิ่มรายการ`);
    assertQueued(await post(app.server, "/console/api/prices/%E0%B8%84%E0%B8%AD%E0%B8%A3%E0%B9%8C%E0%B8%AA%E0%B8%AB%E0%B8%A5%E0%B8%B1%E0%B8%81", { amount: 1 }, auth(who)), `${label} แก้ยอด`);
    assertQueued(await del(app.server, "/console/api/prices/%E0%B8%84%E0%B8%AD%E0%B8%A3%E0%B9%8C%E0%B8%AA%E0%B8%AB%E0%B8%A5%E0%B8%B1%E0%B8%81", auth(who)), `${label} ลบรายการ`);
  }
  // เข้าคิวแล้วต้องไม่มีอะไรขยับจริง — คำขอที่เขียนของลงไปเลยคือช่องโหว่ที่มองไม่เห็น
  assert.equal(db.getApprovedPrice("ของแอบเพิ่ม"), null, "รายการที่คนไม่มีสิทธิ์ยิงมา ต้องไม่ถูกบันทึก");
  assert.equal(db.getApprovedPrice("คอร์สหลัก")?.amount, 9900, "ยอดเดิมต้องไม่ถูกแก้");

  assert.equal((await post(app.server, "/console/api/prices", { label: "คอร์สเสริม", amount: 1500 }, auth(owner))).status, 200);
  assert.equal((await post(app.server, "/console/api/prices/%E0%B8%84%E0%B8%AD%E0%B8%A3%E0%B9%8C%E0%B8%AA%E0%B8%AB%E0%B8%A5%E0%B8%B1%E0%B8%81", { amount: 8900 }, auth(owner))).status, 200);
  assert.equal((await del(app.server, "/console/api/prices/%E0%B8%84%E0%B8%AD%E0%B8%A3%E0%B9%8C%E0%B8%AA%E0%B8%AB%E0%B8%A5%E0%B8%B1%E0%B8%81", auth(owner))).status, 200);
  assert.equal(db.getApprovedPrice("คอร์สเสริม")?.amount, 1500, "เจ้าของต้องเพิ่มได้จริง");
  assert.equal(db.getApprovedPrice("คอร์สหลัก"), null, "เจ้าของต้องลบได้จริง");
});

/* --------------------------- ข. สมอง AI ต่อสาขา --------------------------- */

test("สมองต่อสาขา: เจ้าของสลับโหมด/ใส่ข้อความเสริมได้ทันที · admin กับ staff เข้าคิว", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");
  const staff = await login(app.server, "chompoo");
  const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  assertQueued(await post(app.server, "/console/api/settings/brain/default", { mode: "separate" }, auth(admin)), "admin สลับโหมดสมอง");
  assertQueued(await post(app.server, "/console/api/settings/brain/default", { addendum: "แอบเติม" }, auth(staff)), "staff ใส่ข้อความเสริม");
  assert.ok(!db.getSetting(brainModeKey("default")), "โหมดสมองต้องไม่ถูกเขียนจากคนที่ไม่มีสิทธิ์");

  assert.equal((await post(app.server, "/console/api/settings/brain/default", { mode: "separate" }, auth(owner))).status, 200);
  assert.equal(db.getSetting(brainModeKey("default")), "separate", "เจ้าของต้องสลับโหมดได้จริง");
});

/* ------------------ ค. กติกาสินค้า / คีย์เวิร์ด # / คลาสฟรี ------------------ */

test("กติกาที่ป้อนเข้าสมอง: เจ้าของบันทึกได้ทันที · admin กับ staff เข้าคิวทุกเส้น", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");
  const staff = await login(app.server, "chompoo");
  const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  const cases = [
    ["/console/api/settings/product-rules", { rules: "ห้ามขายซ้ำ" }],
    ["/console/api/settings/hashtag", { enabled: false }],
    ["/console/api/settings/freeclass", { patterns: ["pngoung.com/p/free"] }],
  ];
  for (const [path, body] of cases) {
    assertQueued(await post(app.server, path, body, auth(admin)), `admin POST ${path}`);
    assertQueued(await post(app.server, path, body, auth(staff)), `staff POST ${path}`);
  }
  assert.ok(!db.getSetting(PRODUCT_RULES_KEY), "กติกาสินค้าต้องไม่ถูกเขียนจากคนที่ไม่มีสิทธิ์");
  assert.ok(!db.getSetting(FREECLASS_PATTERNS_KEY), "ลิงก์คลาสฟรีต้องไม่ถูกเขียนจากคนที่ไม่มีสิทธิ์");

  for (const [path, body] of cases) {
    assert.equal((await post(app.server, path, body, auth(owner))).status, 200, `เจ้าของต้องยังบันทึก ${path} ได้`);
  }
  assert.equal(db.getSetting(PRODUCT_RULES_KEY), "ห้ามขายซ้ำ", "เจ้าของต้องบันทึกกติกาได้จริง");
});

/* ------------------------------ ง. รอบเรียน ------------------------------ */

test("รอบเรียน: สร้าง/ลบรอบเป็นของเจ้าของ แต่ 'จำนวนคนที่ลงทะเบียน' ยังเป็นงานของทีม", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");
  const staff = await login(app.server, "chompoo");
  const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

  const newRound = { date: NEW_ROUND_DATE, label: "รอบที่แอบเพิ่ม", capacity: 20 };
  assertQueued(await post(app.server, "/console/api/class-rounds/round", newRound, auth(admin)), "admin สร้างรอบ");
  assertQueued(await post(app.server, "/console/api/class-rounds/round", newRound, auth(staff)), "staff สร้างรอบ");
  assertQueued(await post(app.server, "/console/api/class-rounds/round-delete", { date: ROUND_DATE }, auth(admin)), "admin ลบรอบ");
  assertQueued(await post(app.server, "/console/api/class-rounds/round-delete", { date: ROUND_DATE }, auth(staff)), "staff ลบรอบ");
  const dates = readManualRounds(db).map((round) => round.date);
  assert.deepEqual(dates, [ROUND_DATE], "ตารางรอบต้องไม่ขยับเลยจากคนที่ไม่มีสิทธิ์");

  // เส้นที่ต้องเปิดไว้: ชมพู่คุยกับลูกค้าอยู่แล้วต้องกรอกเลขที่นั่งได้ทันที
  const seats = await post(app.server, "/console/api/class-rounds", { date: ROUND_DATE, enrolled: 7 }, auth(staff));
  assert.equal(seats.status, 200, `ที่นั่งเป็นงานประจำวันของทีม ต้องยังกรอกได้ — ได้ ${seats.status} ${seats.text}`);
  assert.equal(seats.json.rounds.find((r) => r.date === ROUND_DATE)?.seatsLeft, 8, "ตัวเลขที่ทีมกรอกต้องมีผลจริง");

  assert.equal((await post(app.server, "/console/api/class-rounds/round", newRound, auth(owner))).status, 200);
  assert.equal((await post(app.server, "/console/api/class-rounds/round-delete", { date: ROUND_DATE }, auth(owner))).status, 200);
  assert.deepEqual(readManualRounds(db).map((r) => r.date), [NEW_ROUND_DATE], "เจ้าของต้องสร้างและลบรอบได้จริง");
});

/* ------------------ จ. ไม่มี CSRF = ไม่ได้ทั้งของจริงและคิว ------------------ */

// Package C เคยยืนยันว่า "ไม่มีสิทธิ์ต้องได้ 403 เดียวกันแม้ไม่ส่ง CSRF" เพราะตอนนั้น
// staff ไม่มีทางผ่านด่านสิทธิ์เลย ข้อความ "CSRF ไม่ถูกต้อง" จึงเป็นคำใบ้ว่าหา token
// ได้แล้วจะผ่าน — Package K เปลี่ยนเรื่องนี้: staff ส่งคำขอได้จริง CSRF จึงกลายเป็น
// ด่านจริงที่ต้องตอบตามตรง สิ่งที่ยังต้องพิสูจน์เหมือนเดิมคือ "ไม่ผ่าน = ไม่มีอะไรเกิดขึ้น"
test("ไม่ส่ง CSRF: ทั้งของจริงและคิวต้องไม่ขยับสักอย่าง", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const only = { cookie: staff.cookie }; // จงใจไม่ส่ง x-csrf-token

  for (const [method, path, body] of [
    ["POST", "/console/api/prices", { label: "x", amount: 1 }],
    ["DELETE", "/console/api/prices/x", undefined],
    ["POST", "/console/api/settings/brain/default", { mode: "shared" }],
    ["POST", "/console/api/settings/product-rules", { rules: "x" }],
    ["POST", "/console/api/settings/hashtag", { enabled: true }],
    ["POST", "/console/api/settings/freeclass", { patterns: [] }],
    ["POST", "/console/api/class-rounds/round", { date: NEW_ROUND_DATE, label: "x" }],
    ["POST", "/console/api/class-rounds/round-delete", { date: ROUND_DATE }],
  ]) {
    const res = method === "DELETE" ? await del(app.server, path, only) : await post(app.server, path, body, only);
    assert.equal(res.status, 403, `${method} ${path} ไม่มี CSRF ต้องไม่ผ่าน — ได้ ${res.status} ${res.text}`);
  }
  assert.equal(db.countPendingPublishRequests(), 0, "คำขอที่ไม่ผ่าน CSRF ต้องไม่ถูกเก็บเข้าคิวสักใบ");
  assert.equal(db.getApprovedPrice("x"), null, "และของจริงต้องไม่ขยับ");
});

/* ---------------------- ฉ. อ่านได้เหมือนเดิมทุกบทบาท ---------------------- */

test("ทีมงานต้องยัง 'อ่าน' ของทั้งหมดได้ — กันเกินคือความล้มเหลวอีกแบบหนึ่ง", async (t) => {
  const { app } = await boot(t);
  const staff = await login(app.server, "chompoo");
  for (const path of [
    "/console/api/prices",
    "/console/api/settings/brain",
    "/console/api/settings/product-rules",
    "/console/api/settings/hashtag",
    "/console/api/settings/freeclass",
    "/console/api/class-rounds",
  ]) {
    const res = await get(app.server, path, staff.cookie);
    assert.equal(res.status, 200, `ชมพู่ต้องยังเปิดดู ${path} ได้ — ได้ ${res.status} ${res.text.slice(0, 120)}`);
  }
});

/* --------------------- ช. /console/api/me ต้องบอกความจริง --------------------- */

// หน้าเว็บตัดสินใจวาดปุ่มจากรายการนี้ — ถ้าประกาศไม่ตรงกับด่านจริง จะเกิดปุ่มที่
// กดแล้วเด้ง 403 (หรือแย่กว่า: ปุ่มที่หายไปทั้งที่กดได้) เหมือนเคสปี 2026-08-25
test("/console/api/me: เจ้าของได้สิทธิ์เผยแพร่ครบสามตัว · admin กับ staff ต้องไม่ได้เลย", async (t) => {
  const { app } = await boot(t);
  const publishCaps = ["prices.manage", "brain.publish", "rules.manage"];
  for (const [username, expected] of [["ngoung", true], ["hua", false], ["chompoo", false]]) {
    const session = await login(app.server, username);
    const me = await get(app.server, "/console/api/me", session.cookie);
    assert.equal(me.status, 200);
    for (const cap of publishCaps) {
      assert.equal(
        me.json.operator.capabilities.includes(cap), expected,
        `${username} ต้อง${expected ? "" : "ไม่"}มี ${cap} ใน /me (สิทธิ์ที่ประกาศต้องตรงกับด่านจริง)`,
      );
    }
  }
});
