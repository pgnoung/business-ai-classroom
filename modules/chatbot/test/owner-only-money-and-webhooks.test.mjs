// owner-only-money-and-webhooks — คำสั่งพี่ง้วง 1 ก.ย. 2026:
// "ถ้าเป็นชมพู่ หรือพนักงาน ไม่ต้องเห็นค่าแอด ROAS ให้เห็นเฉพาะพี่ง้วงคนเดียว
//  และพวกการตั้ง webhook ใดๆ ชมพู่ พนักงานไม่ควรเห็น"
//
// ทำไมต้องยิงผ่าน HTTP จริงและต้องมีครบ "สามบทบาท":
//   1) การซ่อนปุ่มบนหน้าเว็บไม่ใช่การป้องกัน — พนักงานเปิด DevTools ยิง fetch เองได้
//      เทสต์ชุดนี้จึงจำลอง "พนักงานยิงตรงเข้า API" ไม่ผ่านหน้าเว็บเลย
//   2) helpers.memoryDb() เลื่อนบัญชีแรกเป็น owner ให้อัตโนมัติ เทสต์เดิมที่ดูเหมือน
//      คุมเส้น /roas อยู่ (kpi-roas-route) จึงล็อกอินเป็น owner ทั้งไฟล์และไม่เคยพิสูจน์
//      เรื่องสิทธิ์เลย — ที่นี่จึงเขียน role ให้ครบทุกบัญชีเสมอ
//   3) admin ถูกกันเท่ากับ staff โดยเจตนา: owner มีบัญชีเดียว ส่วน admin เป็นบทบาทที่
//      แจกให้คนอื่นได้จาก dropdown ในหน้าตั้งค่า วันที่ชมพู่ถูกเลื่อนเป็น Admin
//      ถ้ากันแค่ staff เธอจะเห็นกำไรและกดดูกุญแจ ingest ได้ทันที
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";
import { REVIEW_ENTRY_TITLE_MATCH } from "../src/reviewCatalogDoc.mjs";
import { FB_KEY_VERIFY } from "../src/channels.mjs";
import { ADS_KEY_SETTING } from "../src/adsIngest.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const SECRET = "owner-only-console-secret-0123456789";
const PASSWORD = "role-gate-pass-1234";
const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";

async function boot(t, { configOverrides = {} } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, FX_LIVE: "false", THB_PER_USD: "40", ...configOverrides });
  const db = memoryDb();
  // เขียน role ครบทุกบัญชีเสมอ — ห้ามพึ่ง default ของ helpers
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "hua", passHash: hashPassword(PASSWORD), displayName: "หัวหน้า", role: "admin" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

function post(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function put(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "PUT", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, `ล็อกอิน ${username} ต้องผ่านก่อน ไม่งั้นเทสต์ที่เหลือไม่มีความหมาย — ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

const get = (server, path, cookie) => httpRequest(server, { path, headers: { cookie } });

// ข้อความปฏิเสธห้ามบอกใบ้ของที่กันไว้ — ห้ามมีตัวเลข ห้ามมีชื่อฟีเจอร์/ชื่อความลับ
function assertCleanDenial(res, where) {
  assert.equal(res.status, 403, `${where} ต้องเป็น 403 — ได้ ${res.status} ${res.text}`);
  assert.equal(res.json?.error, DENY, `${where} ต้องใช้ข้อความปฏิเสธกลาง ๆ ตัวเดียวกัน`);
  const body = res.text.toLowerCase();
  for (const leak of ["roas", "spend", "profit", "key", "token", "secret", "กำไร", "ค่าแอด"]) {
    assert.ok(!body.includes(leak), `${where} ข้อความปฏิเสธห้ามมีคำว่า "${leak}"`);
  }
  assert.ok(!/\d/u.test(res.json?.error ?? ""), `${where} ข้อความปฏิเสธห้ามมีตัวเลข`);
}

/* ---------------------------- ก. เงิน (owner เท่านั้น) --------------------------- */

test("เงิน: owner ใช้ได้ / admin กับ staff โดน 403 ทุกเส้น", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");
  const staff = await login(app.server, "chompoo");

  for (const path of ["/console/api/roas?days=30", "/console/api/roas/ingest-key?reveal=1", "/console/api/audit?limit=10"]) {
    assert.equal((await get(app.server, path, owner.cookie)).status, 200, `owner ต้องยังใช้ ${path} ได้ปกติ`);
    assertCleanDenial(await get(app.server, path, admin.cookie), `admin GET ${path}`);
    assertCleanDenial(await get(app.server, path, staff.cookie), `staff GET ${path}`);
  }

  const costs = { adsThb: "1000" };
  assert.equal((await put(app.server, "/console/api/roas", costs, { cookie: owner.cookie, "x-csrf-token": owner.csrf })).status, 200);
  assertCleanDenial(await put(app.server, "/console/api/roas", costs, { cookie: admin.cookie, "x-csrf-token": admin.csrf }), "admin PUT /roas");
  assertCleanDenial(await put(app.server, "/console/api/roas", costs, { cookie: staff.cookie, "x-csrf-token": staff.csrf }), "staff PUT /roas");
});

test("เงิน: คนไม่มีสิทธิ์ต้องได้ 403 เดียวกันแม้ CSRF ผิด — ห้ามบอกใบ้ว่าแก้ CSRF แล้วจะผ่าน", async (t) => {
  const { app } = await boot(t);
  const staff = await login(app.server, "chompoo");
  // ไม่ส่ง x-csrf-token เลย: ถ้าด่านสิทธิ์อยู่หลัง CSRF จะได้ "CSRF token ไม่ถูกต้อง" ซึ่งคือคำใบ้
  assertCleanDenial(await put(app.server, "/console/api/roas", { adsThb: "1" }, { cookie: staff.cookie }), "staff PUT /roas ไม่มี CSRF");
  assertCleanDenial(await post(app.server, "/console/api/roas/ingest-key", {}, { cookie: staff.cookie }), "staff POST ingest-key ไม่มี CSRF");
});

test("กุญแจ ingest: admin กดหมุนไม่ได้จริง — กุญแจไม่เปลี่ยน และไม่มีแถว audit เพิ่ม", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");
  const staff = await login(app.server, "chompoo");

  assert.equal((await post(app.server, "/console/api/roas/ingest-key", {}, { cookie: owner.cookie, "x-csrf-token": owner.csrf })).status, 200);
  const before = db.getSetting(ADS_KEY_SETTING);
  assert.ok(before, "owner ต้องหมุนกุญแจได้ตามเดิม");
  const auditBefore = db.listAudit(500).filter((a) => String(a.action).startsWith("ads_ingest_key_")).length;

  for (const who of [admin, staff]) {
    assertCleanDenial(await post(app.server, "/console/api/roas/ingest-key", {}, { cookie: who.cookie, "x-csrf-token": who.csrf }), "POST ingest-key");
    assertCleanDenial(await get(app.server, "/console/api/roas/ingest-key?reveal=1", who.cookie), "GET ingest-key reveal");
  }
  assert.equal(db.getSetting(ADS_KEY_SETTING), before, "กุญแจต้องไม่ถูกหมุนโดยคนที่ไม่มีสิทธิ์");
  const auditAfter = db.listAudit(500).filter((a) => String(a.action).startsWith("ads_ingest_key_")).length;
  assert.equal(auditAfter, auditBefore, "คนไม่มีสิทธิ์ต้องไม่ทิ้งแถว audit ของกุญแจไว้เลย");
});

/* ------------------------ ข. การเชื่อมต่อ/webhook (owner) ------------------------ */

test("webhook/การเชื่อมต่อ: owner ใช้ได้ / admin กับ staff โดน 403 ทั้ง GET และ POST", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");
  const staff = await login(app.server, "chompoo");

  const paths = [
    "/console/api/models",
    "/console/api/settings/digest",
  ];
  for (const path of paths) {
    assert.equal((await get(app.server, path, owner.cookie)).status, 200, `owner ต้องยังเปิด ${path} ได้`);
    assertCleanDenial(await get(app.server, path, admin.cookie), `admin GET ${path}`);
    assertCleanDenial(await get(app.server, path, staff.cookie), `staff GET ${path}`);
    for (const who of [admin, staff]) {
      const res = await post(app.server, path, {}, { cookie: who.cookie, "x-csrf-token": who.csrf });
      assertCleanDenial(res, `POST ${path}`);
    }
  }

  // /settings/facebook ถือของสองเจ้าของในเส้นเดียว จึงกันเป็นฟิลด์ (ดูเทสต์ถัดไป)
  // ตรงนี้พิสูจน์เฉพาะส่วนที่เป็นการต่อสาย: ยิงฟิลด์โทเคนมาต้องโดนปฏิเสธทั้งคำขอ
  for (const who of [admin, staff]) {
    assertCleanDenial(
      await post(app.server, "/console/api/settings/facebook", { verifyToken: "x" }, { cookie: who.cookie, "x-csrf-token": who.csrf }),
      "POST /settings/facebook (ฟิลด์โทเคน)",
    );
  }
});

test("Facebook: พนักงานเติมรายชื่อลูกค้าเก่า Lead Center ได้ แต่ไม่เห็นสถานะการต่อสาย", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const ownerRes = await get(app.server, "/console/api/settings/facebook", owner.cookie);
  assert.equal(ownerRes.status, 200);
  assert.ok("hasVerifyToken" in ownerRes.json, "เจ้าของต้องยังเห็นว่าต่อสายครบหรือยัง");

  const staffRes = await get(app.server, "/console/api/settings/facebook", staff.cookie);
  assert.equal(staffRes.status, 200,
    "ลูกค้าเก่าจาก Lead Center ทักเข้าเพจแล้วบอทต้องเงียบ — ชมพู่ต้องเติมชื่อเองได้ทุกวัน");
  for (const field of ["hasPageAccessToken", "hasAppSecret", "hasVerifyToken"]) {
    assert.ok(!(field in staffRes.json), `${field} คือสถานะการต่อ webhook — ห้ามหลุดถึงพนักงาน`);
  }
  assert.deepEqual(staffRes.json.knownCustomers, [], "รายชื่อลูกค้าเก่าต้องอยู่กับทีม");

  const write = await post(app.server, "/console/api/settings/facebook",
    { knownCustomers: ["คุณเอ ร้านกาแฟ"] }, { cookie: staff.cookie, "x-csrf-token": staff.csrf });
  assert.equal(write.status, 200, `ชมพู่ต้องบันทึกรายชื่อได้จริง — ${write.text}`);
  assert.deepEqual(JSON.parse(db.getSetting("fb_known_customers")), ["คุณเอ ร้านกาแฟ"],
    "ต้องเขียนลงฐานข้อมูลจริง ไม่ใช่แค่ตอบ 200");

  // ส่งมาปนกัน = ปฏิเสธทั้งคำขอ ห้ามบันทึกครึ่ง ๆ กลาง ๆ
  const mixed = await post(app.server, "/console/api/settings/facebook",
    { knownCustomers: ["คุณบี"], verifyToken: "hijack" }, { cookie: staff.cookie, "x-csrf-token": staff.csrf });
  assertCleanDenial(mixed, "staff POST /settings/facebook (ปนฟิลด์โทเคน)");
  assert.deepEqual(JSON.parse(db.getSetting("fb_known_customers")), ["คุณเอ ร้านกาแฟ"],
    "คำขอที่ถูกปฏิเสธต้องไม่เขียนอะไรเลยแม้แต่ส่วนที่ทำได้");
  assert.equal(db.getSetting(FB_KEY_VERIFY), null, "verify token ต้องไม่ถูกแตะเลย");
});

test("ผู้รับแจ้งเตือน 'ลูกค้าขอคุยกับคน': ทีมยังจัดการเองได้ตามสิทธิ์ที่ /me ประกาศไว้", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");

  const me = await get(app.server, "/console/api/me", staff.cookie);
  assert.ok(me.json.operator.capabilities.includes("notifications.manage"),
    "ถ้าสิทธิ์ที่โฆษณากับสิทธิ์จริงไม่ตรงกัน จะกลายเป็นบั๊กเงียบแบบเดียวกับ 2026-08-25");

  const read = await get(app.server, "/console/api/settings/notify", staff.cookie);
  assert.equal(read.status, 200,
    `มีน้องใหม่เข้าทีม/มีคนลาออก ชมพู่ต้องเพิ่ม-ถอดผู้รับแจ้งเตือนได้เอง — ${read.text}`);

  const id = `U${"a".repeat(32)}`;
  const write = await post(app.server, "/console/api/settings/notify",
    { channelId: "default", ids: [id] }, { cookie: staff.cookie, "x-csrf-token": staff.csrf });
  assert.equal(write.status, 200, `ชมพู่ต้องบันทึกผู้รับแจ้งเตือนได้จริง — ${write.text}`);
  assert.deepEqual(write.json.ids, [id]);
  assert.ok(db.listAudit(50).some((row) => row.action === "escalate_notify_set"),
    "ต้องมีร่องรอยว่าใครแก้รายชื่อผู้รับแจ้งเตือน");
});

test("Facebook: admin ยิง POST แล้ว verify token ในฐานข้อมูลต้องไม่เปลี่ยนแม้แต่ตัวเดียว", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");

  const okWrite = await post(app.server, "/console/api/settings/facebook",
    { verifyToken: "owner-set-value" }, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(okWrite.status, 200, `owner ต้องยังตั้งค่าเพจได้ — ${okWrite.text}`);
  const before = db.getSetting(FB_KEY_VERIFY);

  const hijack = await post(app.server, "/console/api/settings/facebook",
    { verifyToken: "staff-hijack-value" }, { cookie: admin.cookie, "x-csrf-token": admin.csrf });
  assertCleanDenial(hijack, "admin POST /settings/facebook");
  assert.equal(db.getSetting(FB_KEY_VERIFY), before,
    "ถ้าค่านี้เปลี่ยนได้ = พนักงานคนเดียวตัดการเชื่อมต่อเพจ หรือชี้เพจไปเซิร์ฟเวอร์อื่นได้");
});

/* --------------------- ค. ตัดเฉพาะฟิลด์ ไม่ปิดทั้งเส้น (200 เสมอ) -------------------- */

test("ภาพรวม: staff ได้ 200 · aiCost เป็น null · แต่ยอดขาย/โควตา/สถิติต้องอยู่ครบ", async (t) => {
  const { app, db } = await boot(t);
  db.upsertCustomer("U-cost", {});
  db.addLlmUsage({ customerId: "U-cost", kind: "draft", model: "gpt-5.6-sol", tokensIn: 1_000_000, tokensOut: 0 });
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const ownerRes = await get(app.server, "/console/api/overview", owner.cookie);
  assert.equal(ownerRes.status, 200);
  assert.ok(ownerRes.json.aiCost, "เจ้าของต้องยังเห็นค่า AI");
  assert.ok(ownerRes.json.aiCost.today.usd > 0, "ตัวเลขของเจ้าของต้องเป็นของจริง ไม่ใช่ศูนย์");

  for (const who of [
    { name: "staff", session: staff },
    { name: "admin", session: await login(app.server, "hua") },
  ]) {
    const res = await get(app.server, "/console/api/overview", who.session.cookie);
    assert.equal(res.status, 200, `${who.name}: หน้าแรกหลังล็อกอินห้าม 403 เด็ดขาด`);
    assert.equal(res.json.aiCost, null, `${who.name}: ห้ามเห็นค่า AI`);
    assert.ok(res.json.stats, `${who.name}: สถิติงานประจำวันต้องอยู่`);
    assert.ok(res.json.orders, `${who.name}: ออเดอร์วันนี้/ยอดขายเดือนนี้ ตั้งใจไม่กัน`);
    assert.ok("quota" in res.json, `${who.name}: โควตา LINE ตั้งใจไม่กัน`);
    assert.ok("series" in res.json, `${who.name}: กราฟยอดขาย 14 วัน ตั้งใจไม่กัน`);
  }
});

test("ห้องแชท: staff ได้ 200 · ข้อความครบ · แต่ aiCost รายลูกค้าเป็น null", async (t) => {
  const { app, db } = await boot(t);
  db.upsertCustomer("U-cc", {});
  db.insertMessage({ customerId: "U-cc", direction: "in", msgType: "text", content: "สนใจคลาสค่ะ" });
  db.addLlmUsage({ customerId: "U-cc", kind: "draft", model: "gpt-5.6-sol", tokensIn: 100_000, tokensOut: 10_000 });
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const ownerRes = await get(app.server, "/console/api/conversations/U-cc/messages", owner.cookie);
  assert.equal(ownerRes.status, 200);
  assert.ok(ownerRes.json.aiCost?.usd > 0, "เจ้าของต้องยังเห็นค่า AI รายลูกค้า");

  const res = await get(app.server, "/console/api/conversations/U-cc/messages", staff.cookie);
  assert.equal(res.status, 200, "ชมพู่ต้องเปิดห้องแชทได้ตามปกติ");
  assert.equal(res.json.aiCost, null, "ชมพู่ห้ามเห็นต้นทุน AI ของห้องนี้");
  assert.equal(res.json.messages.length, 1, "ข้อความในห้องต้องครบเหมือนเดิม");
});

test("รายการสาขา: staff ได้ 200 พร้อม id/ชื่อ/สถานะ แต่ไม่มีฟิลด์การต่อสาย", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const ownerRes = await get(app.server, "/console/api/channels", owner.cookie);
  assert.equal(ownerRes.status, 200);
  assert.ok("hasSecret" in ownerRes.json.channels[0], "เจ้าของต้องยังเห็นสถานะการต่อ webhook");

  for (const who of [staff, await login(app.server, "hua")]) {
    const res = await get(app.server, "/console/api/channels", who.cookie);
    assert.equal(res.status, 200, "chip เลือกสาขาใช้เส้นนี้ทั้งคอนโซล — ปิดทั้งเส้นไม่ได้");
    const ch = res.json.channels[0];
    assert.ok(ch.id, "ต้องยังมี id ไว้กรอง chip");
    assert.ok("name" in ch && "active" in ch, "ต้องยังมีชื่อและสถานะเปิด/ปิด");
    for (const field of ["hasSecret", "hasToken", "destination"]) {
      assert.ok(!(field in ch), `ฟิลด์ ${field} คือสถานะการต่อ webhook — ห้ามหลุดถึงพนักงาน`);
    }
  }
});

test("หน้าเรียนรู้: staff ได้ 200 แต่ไม่มีเพดานงบ และไม่มีต้นทุนจริงของแต่ละรอบ", async (t) => {
  const { app, db } = await boot(t);
  // รอบที่ "ใช้เงินไปแล้วจริง" — ถ้าไม่ยัดตัวเลขเข้าไป เทสต์จะผ่านเพราะค่า default เป็น 0
  // ซึ่งพิสูจน์อะไรไม่ได้เลย (บนเครื่องจริงที่เปิด learningModelEnabled ตัวเลขนี้ไม่ใช่ 0)
  const run = db.createLearningRun({ dayKey: "2026-09-01", mode: "model_assisted" });
  db.finishLearningRun(run.id, {
    status: "complete", usd: 12.3456, llmCalls: 9, tokensIn: 900_000, tokensOut: 40_000,
    candidatesCreated: 3, hedgeRate: 0.12, probeCount: 5,
  });
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const ownerRes = await get(app.server, "/console/api/learning", owner.cookie);
  assert.equal(ownerRes.status, 200);
  assert.ok(typeof ownerRes.json.budgetUsd === "number", "เจ้าของต้องยังเห็นเพดานงบ");
  assert.equal(ownerRes.json.runs[0].usd, 12.3456, "เจ้าของต้องยังเห็นต้นทุนจริงของรอบล่าสุด");

  for (const who of [
    { name: "staff", session: staff },
    { name: "admin", session: await login(app.server, "hua") },
  ]) {
    const res = await get(app.server, "/console/api/learning", who.session.cookie);
    assert.equal(res.status, 200, `${who.name}: ใช้หน้านี้รีวิวคำแก้ทุกวัน — ปิดทั้งเส้นไม่ได้`);
    assert.ok(!("budgetUsd" in res.json), `${who.name}: เพดานงบเป็นตัวเลขต้นทุน ห้ามติดมาด้วย`);
    assert.ok("candidates" in res.json, `${who.name}: ของที่ต้องใช้รีวิวต้องอยู่ครบ`);
    const row = res.json.runs[0];
    assert.ok(row, `${who.name}: รอบล่าสุดต้องยังอยู่ (หน้าเว็บพิมพ์ KPI คุณภาพจากแถวนี้)`);
    for (const field of ["usd", "llm_calls", "tokens_in", "tokens_out"]) {
      assert.ok(!(field in row), `${who.name}: ${field} คือต้นทุนโมเดล — ห้ามหลุดทาง runs[]`);
    }
    // กันเกินก็คือความล้มเหลวอีกแบบ: ตัวเลขคุณภาพที่หน้าเว็บพิมพ์ต้องยังอยู่ครบ
    for (const field of ["mode", "status", "hedge_rate", "promise_notes_per_100", "probe_count"]) {
      assert.ok(field in row, `${who.name}: ${field} ไม่ใช่ตัวเลขเงิน ต้องยังอยู่`);
    }
    assert.ok(!JSON.stringify(res.json).includes("12.3456"),
      `${who.name}: ตัวเลขต้นทุนห้ามโผล่ที่ไหนใน response เลย`);
  }
});

test("วันหยุดที่ใช้ตัดวันออกจาก KPI: อ่านได้ทุกคน แต่คนถูกวัดแก้เกณฑ์ตัวเองไม่ได้", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const admin = await login(app.server, "hua");
  const staff = await login(app.server, "chompoo");

  assert.equal((await get(app.server, "/console/api/kpi/holidays", staff.cookie)).status, 200,
    "ดูว่าวันไหนถูกตัดออกแล้วบ้าง = อ่านผลงานตัวเอง ต้องเปิดให้ทีม");

  const okWrite = await put(app.server, "/console/api/kpi/holidays",
    { holidays: ["2026-12-05"] }, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(okWrite.status, 200, `เจ้าของต้องยังกรอกวันหยุดได้ — ${okWrite.text}`);

  for (const who of [{ name: "admin", s: admin }, { name: "staff", s: staff }]) {
    // ไม่ส่ง CSRF ด้วยหนึ่งครั้ง: ด่านสิทธิ์ต้องมาก่อน ไม่งั้นจะได้คำใบ้ว่าแก้ CSRF แล้วผ่าน
    assertCleanDenial(await put(app.server, "/console/api/kpi/holidays",
      { holidays: ["2026-12-25"] }, { cookie: who.s.cookie }), `${who.name} PUT holidays ไม่มี CSRF`);
    assertCleanDenial(await put(app.server, "/console/api/kpi/holidays",
      { holidays: ["2026-12-25"] }, { cookie: who.s.cookie, "x-csrf-token": who.s.csrf }), `${who.name} PUT holidays`);
  }
  assert.equal(db.getSetting("kpi_holidays"), "2026-12-05",
    "ถ้าค่านี้เปลี่ยนได้ = ใส่วันที่ตอบช้าเป็นวันหยุด แล้วค่ามัธยฐานเวลาตอบดีขึ้นเอง");
  assert.equal(db.listAudit(200).filter((row) => row.action === "kpi_holidays_edit").length, 1,
    "คนไม่มีสิทธิ์ต้องไม่ทิ้งแถว audit ไว้เลย");
});

/* ------------------------- ง. ของที่กันเกิน — ต้องเปิดคืน ------------------------- */

test("ผลงานการตอบแชท: staff ต้องเปิดได้ (เดิม 403 ทั้งที่เมนูโชว์ให้)", async (t) => {
  const { app, db } = await boot(t);
  db.upsertCustomer("U-1", {});
  db.insertMessage({ customerId: "U-1", direction: "in", msgType: "text", content: "สนใจค่ะ" });
  db.insertMessage({ customerId: "U-1", direction: "out", msgType: "text", content: "ยินดีค่ะ", agentMode: "ai" });
  const staff = await login(app.server, "chompoo");

  const res = await get(app.server, "/console/api/kpi?days=7", staff.cookie);
  assert.equal(res.status, 200, `พี่ง้วงระบุเองว่าพนักงานดูผลงานการตอบแชทได้ — ${res.text}`);
  assert.ok(res.json.speed && res.json.backlog && res.json.closing, "รูปข้อมูลต้องครบตามที่หน้าผลงานใช้");
});

test("คลังรีวิว: staff อ่านและบันทึกได้จริง (ฟอร์มนี้ทำมาให้ชมพู่กรอก)", async (t) => {
  const { app, db } = await boot(t);
  db.addKnowledge({
    title: `${REVIEW_ENTRY_TITLE_MATCH} แยกตามคลาส`,
    content: "วิธีใช้: หยิบรีวิวให้ตรงคลาส\n\n[Classroom : AI Agent For Business]\n- คุณเอ เจ้าของร้าน | รีวิว: https://www.facebook.com/reel/100000000000757\n",
    updatedBy: "ngoung",
  });
  const staff = await login(app.server, "chompoo");

  const read = await get(app.server, "/console/api/reviews", staff.cookie);
  assert.equal(read.status, 200, `คลังรีวิวไม่มีตัวเลขเงินสักฟิลด์ — ${read.text}`);
  assert.equal(read.json.total, 1);

  const sections = [{
    name: "Classroom : AI Agent For Business",
    items: [
      { who: "คุณเอ เจ้าของร้าน", url: "https://www.facebook.com/reel/100000000000757" },
      { who: "คุณบี คลินิกความงาม", url: "https://www.facebook.com/share/v/1TstVb02Bb/" },
    ],
  }];
  const write = await put(app.server, "/console/api/reviews", { sections }, { cookie: staff.cookie, "x-csrf-token": staff.csrf });
  assert.equal(write.status, 200, `ชมพู่ต้องบันทึกรีวิวได้จริง — ${write.text}`);
  assert.equal(write.json.total, 2);
  const saved = db.listKnowledge().find((row) => String(row.title).includes(REVIEW_ENTRY_TITLE_MATCH));
  assert.ok(saved.content.includes("คุณบี คลินิกความงาม"), "ต้องเขียนลงคลังความรู้จริง ไม่ใช่แค่ตอบ 200");
});

/* ------------------------- จ. งานประจำวันห้ามโดนลูกหลง ------------------------- */

test("งานประจำวันของชมพู่: ทุกเส้นต้องยัง 200", async (t) => {
  const { app, db } = await boot(t);
  db.upsertCustomer("U-day", { displayName: "ลูกค้า" });
  db.insertMessage({ customerId: "U-day", direction: "in", msgType: "text", content: "สวัสดีค่ะ" });
  const staff = await login(app.server, "chompoo");

  const paths = [
    "/console/api/me",
    "/console/api/inbox",
    "/console/api/conversations/U-day/messages",
    "/console/api/orders",
    "/console/api/orders/export",
    "/console/api/prices",
    "/console/api/knowledge",
    "/console/api/corrections",
    "/console/api/class-rounds",
    "/console/api/export",
    "/console/api/brain",
    "/console/api/settings/schedule",
    "/console/api/settings/followup",
    "/console/api/settings/product-rules",
    "/console/api/settings/hashtag",
    "/console/api/settings/freeclass",
    "/console/api/settings/brain",
  ];
  for (const path of paths) {
    const res = await get(app.server, path, staff.cookie);
    assert.equal(res.status, 200, `กันเกิน: ${path} ต้องยังใช้ได้ — ได้ ${res.status} ${res.text.slice(0, 120)}`);
  }
});

/* ------------------------- ฉ. ของที่กันถูกอยู่แล้ว ห้ามหลุด ------------------------- */

test("เส้นที่เป็นของเจ้าของอยู่แล้ว: admin ยังต้องเข้าไม่ได้เหมือนเดิม", async (t) => {
  const { app } = await boot(t);
  const admin = await login(app.server, "hua");
  for (const path of [
    "/console/api/backup-status",
    "/console/api/operators",
    "/console/api/settings/claude-export-testers",
    "/console/api/training-candidates",
  ]) {
    const res = await get(app.server, path, admin.cookie);
    assert.equal(res.status, 403, `${path} ต้องยังเป็นของเจ้าของเท่านั้น — ได้ ${res.status}`);
  }
});
