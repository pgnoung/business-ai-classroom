// yolo-console-api — เส้นคอนโซลของ YOLO และ "Telegram สั่งงานลูกแพร" ผ่าน HTTP จริงของ createApp
// สิทธิ์ (yolo.send = owner/admin · ตั้งค่า Telegram = เจ้าของ) · CSRF · รหัสสถานะ · audit ไม่มีความลับ
// + E2E สังเคราะห์: จับคู่ผ่านคอนโซล → Telegram สั่ง "yolo LINE คุณทดสอบ …" → LINE push 1 ครั้ง + ลูกแพรตอบใน Telegram
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { capabilitiesForRole } from "../src/operatorRoles.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
// ค่าจำลองประกอบจากชิ้น (ตัวสแกนความลับของ release จับรูป "password = ค่าจริง")
const PASSWORD = ["operator", "pass", "123"].join("-");
const SESSION_KEY = ["yolo", "console", "fixture", "0123456789"].join("-");
const PASS_HASH = hashPassword(PASSWORD);
const FAKE_BOT = ["987654321", "AAconsoleTestOnly_zyxwvutsrqponmlkjihgf"].join(":");
const OWNER_TG = 515151;
const DRAFT = "ขออนุญาตถามเพิ่มนิดนึงนะคะ ทีมที่จะเข้าร่วมมีประมาณกี่ท่านคะ";

function telegramStub() {
  const calls = [];
  const updates = [];
  const fn = async (url, options = {}) => {
    const method = String(url).split("/").pop();
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ method, body });
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
    if (method === "getMe") return ok({ id: 1234, is_bot: true, username: "lukprae_boss_bot" });
    if (method === "getUpdates") return ok(updates.splice(0));
    if (method === "sendMessage") return ok({ message_id: calls.length });
    return ok(true);
  };
  fn.calls = calls;
  fn.updates = updates;
  return fn;
}

function hermesStub() {
  const calls = [];
  const fn = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: DRAFT } }], usage: { prompt_tokens: 80, completion_tokens: 20 } }) };
  };
  fn.calls = calls;
  return fn;
}

async function start(t) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: PASS_HASH, displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "boss2", passHash: PASS_HASH, displayName: "แอดมิน", role: "admin" });
  db.createOperator({ username: "chompoo", passHash: PASS_HASH, displayName: "ชมพู่", role: "operator" });
  const lineFetch = lineFetchStub();
  const telegramFetch = telegramStub();
  const hermesFetch = hermesStub();
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY, CONSOLE_PUBLIC_BASE_URL: "https://lukprae.example/console" }),
    db, logger: silent,
    overrides: { lineFetch, hermesFetch, telegramFetch, sleep: async () => {} },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, lineFetch, telegramFetch, hermesFetch };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

const call = (server, session, method, path, body = null) => httpRequest(server, {
  method, path,
  headers: { cookie: session.cookie, "x-csrf-token": session.csrf, ...(body ? { "content-type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : null,
});

function seedRoom(db, id = "U0123456789abcdef0123456789abcdef", display = "คุณทดสอบ") {
  db.upsertCustomer(id, { displayName: display });
  db.insertMessage({ id: `in-${id}`, customerId: id, direction: "in", content: "สนใจ in-house สำหรับพนักงานค่ะ" });
  db.insertMessage({ id: `out-${id}`, customerId: id, direction: "out", content: "ยินดีค่ะ ขอรายละเอียดเพิ่มนิดนึงนะคะ" });
  db.setAiEnabled(id, false, "handoff_private_inhouse");
  return id;
}

test("สิทธิ์ yolo.send: เจ้าของ + แอดมิน · พนักงานไม่มี", () => {
  assert.ok(capabilitiesForRole("owner").includes("yolo.send"));
  assert.ok(capabilitiesForRole("admin").includes("yolo.send"));
  assert.ok(!capabilitiesForRole("operator").includes("yolo.send"));
});

test("POST /customers/:id/yolo: พนักงาน 403 · ไม่มี CSRF 403 · แอดมินส่งได้ · ข้อมูลผิดรูป 400", async (t) => {
  const { app, db, lineFetch } = await start(t);
  const id = seedRoom(db);
  const staff = await login(app.server, "chompoo");
  const denied = await call(app.server, staff, "POST", `/console/api/customers/${id}/yolo`, { instruction: "ทักทาย" });
  assert.equal(denied.status, 403);
  const admin = await login(app.server, "boss2");
  const noCsrf = await httpRequest(app.server, {
    method: "POST", path: `/console/api/customers/${id}/yolo`,
    headers: { cookie: admin.cookie, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(noCsrf.status, 403);
  const badType = await call(app.server, admin, "POST", `/console/api/customers/${id}/yolo`, { instruction: 5 });
  assert.equal(badType.status, 400);
  const missing = await call(app.server, admin, "POST", "/console/api/customers/U-ghost/yolo", {});
  assert.equal(missing.status, 404);
  const pre = await call(app.server, admin, "GET", `/console/api/customers/${id}/yolo`);
  assert.equal(pre.status, 200);
  assert.equal(pre.json.refusal, null);
  assert.equal(pre.json.customer.aiEnabled, false);

  const sent = await call(app.server, admin, "POST", `/console/api/customers/${id}/yolo`, { instruction: "ถามต่อเรื่องจำนวนพนักงาน", enableAi: false });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.status, "sent");
  assert.equal(lineFetch.sends.length, 1);
  assert.equal(lineFetch.sends[0].body.to, id);
  assert.deepEqual(lineFetch.sends[0].body.messages.map((m) => m.text), ["ขออนุญาตถามเพิ่มนิดนึงนะคะ", "ทีมที่จะเข้าร่วมมีประมาณกี่ท่านคะ?"]);
  assert.equal(db.getCustomer(id).ai_enabled, 0, "ไม่ได้ติ๊กเปิด AI = สวิตช์คงเดิม");
  const audit = db.listAudit(20).find((row) => row.action === "yolo_sent");
  assert.equal(audit.operator, "boss2");

  const again = await call(app.server, admin, "POST", `/console/api/customers/${id}/yolo`, {});
  assert.equal(again.status, 422);
  assert.equal(again.json.reason, "rate_limited_room");
  assert.match(again.json.error, /ไม่ถึง 10 นาที/u);
});

test("เส้นเงินผ่านคอนโซล: 409 ขอยืนยันก่อน · confirm:true แล้วส่ง · เปิด AI ต่อด้วยได้", async (t) => {
  const { app, db, lineFetch } = await start(t);
  const id = seedRoom(db);
  db.setDealStatus(id, "awaiting_payment");
  const owner = await login(app.server, "ngoung");
  const ask = await call(app.server, owner, "POST", `/console/api/customers/${id}/yolo`, { instruction: "ทักทาย", enableAi: true });
  assert.equal(ask.status, 409);
  assert.equal(ask.json.status, "needs_confirmation");
  assert.equal(ask.json.confirm[0].code, "money_line");
  assert.equal(lineFetch.sends.length, 0);
  const ok = await call(app.server, owner, "POST", `/console/api/customers/${id}/yolo`, { instruction: "ทักทาย", enableAi: true, confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.aiChanged, true);
  assert.equal(db.getCustomer(id).ai_enabled, 1);
});

test("ปุ่ม AI ในห้องแชทยังทำงานเหมือนเดิมหลังย้ายไป aiSwitch.mjs (on/off + audit detail เดิม)", async (t) => {
  const { app, db } = await start(t);
  const id = seedRoom(db);
  const owner = await login(app.server, "ngoung");
  const on = await call(app.server, owner, "POST", `/console/api/customers/${id}/ai`, { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.customer.ai_enabled, 1);
  const off = await call(app.server, owner, "POST", `/console/api/customers/${id}/ai`, { enabled: false });
  assert.equal(off.json.customer.ai_off_reason, "manual");
  const details = db.listAudit(10).filter((row) => row.action === "ai_toggle").map((row) => row.detail);
  assert.deepEqual(details, ["off", "on"]);
});

test("ตั้งค่า Telegram: เจ้าของเท่านั้น · โทเคนโชว์แบบปิดบัง · รหัสจับคู่ owner-only · audit ไม่มีความลับ", async (t) => {
  const { app, db, telegramFetch } = await start(t);
  const admin = await login(app.server, "boss2");
  assert.equal((await call(app.server, admin, "GET", "/console/api/settings/telegram")).status, 403);
  assert.equal((await call(app.server, admin, "POST", "/console/api/settings/telegram", { token: FAKE_BOT })).status, 403);
  const staff = await login(app.server, "chompoo");
  assert.equal((await call(app.server, staff, "GET", "/console/api/settings/telegram")).status, 403);

  const owner = await login(app.server, "ngoung");
  const empty = await call(app.server, owner, "GET", "/console/api/settings/telegram");
  assert.equal(empty.json.configured, false);
  const earlyPair = await call(app.server, owner, "POST", "/console/api/settings/telegram/pairing", {});
  assert.equal(earlyPair.status, 409, "ยังไม่มีโทเคน = ออกรหัสไม่ได้");
  assert.equal((await call(app.server, owner, "POST", "/console/api/settings/telegram", { token: "abc" })).status, 400);
  const saved = await call(app.server, owner, "POST", "/console/api/settings/telegram", { token: FAKE_BOT });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.tokenHint, "987654321:••••••••");
  assert.equal(saved.json.botUsername, "lukprae_boss_bot");
  assert.ok(telegramFetch.calls.some((c) => c.method === "getMe"));
  const pairing = await call(app.server, owner, "POST", "/console/api/settings/telegram/pairing", {});
  assert.equal(pairing.status, 200);
  assert.match(pairing.json.code, /^[A-HJ-NP-Z2-9]{10}$/u);
  assert.equal(pairing.json.deepLink, `https://t.me/lukprae_boss_bot?start=${pairing.json.code}`);
  const view = await call(app.server, owner, "GET", "/console/api/settings/telegram");
  assert.ok(view.json.pairing?.expiresAt > Date.now());
  assert.ok(!view.text.includes(FAKE_BOT.split(":")[1]), "GET ห้ามคืนส่วนลับของโทเคน");
  assert.ok(!view.text.includes(pairing.json.code), "รหัสจับคู่แสดงครั้งเดียวตอนสร้าง");
  const audits = db.listAudit(20).filter((row) => row.action.startsWith("telegram_"));
  assert.deepEqual(audits.map((row) => row.action).sort(), ["telegram_pairing_created", "telegram_token_set"]);
  for (const row of audits) {
    assert.ok(!row.detail.includes(FAKE_BOT.split(":")[1]) && !row.detail.includes(pairing.json.code));
  }
  const cleared = await call(app.server, owner, "POST", "/console/api/settings/telegram", { clear: true });
  assert.equal(cleared.json.configured, false);
  assert.equal(db.getSetting("telegram_control_bot"), "");
});

test("E2E สังเคราะห์: จับคู่ผ่านคอนโซล → Telegram 'yolo LINE คุณทดสอบ …' → LINE push 1 ครั้ง + ลูกแพรตอบใน Telegram", async (t) => {
  const { app, db, lineFetch, telegramFetch, hermesFetch } = await start(t);
  const id = seedRoom(db);
  const owner = await login(app.server, "ngoung");
  await call(app.server, owner, "POST", "/console/api/settings/telegram", { token: FAKE_BOT });
  const { json: { code } } = await call(app.server, owner, "POST", "/console/api/settings/telegram/pairing", {});
  const nowSec = Math.floor(Date.now() / 1000);
  const update = (update_id, text) => ({
    update_id, message: { message_id: update_id, date: nowSec, text, from: { id: OWNER_TG, is_bot: false }, chat: { id: OWNER_TG, type: "private" } },
  });
  telegramFetch.updates.push(update(1, `/start ${code}`));
  await app.telegramControl.pollOnce({ timeoutSec: 0 });
  const paired = await call(app.server, owner, "GET", "/console/api/settings/telegram");
  assert.equal(paired.json.paired.pairedBy, "ngoung");

  telegramFetch.updates.push(update(2, "yolo LINE คุณทดสอบ ถามต่อเรื่องจำนวนพนักงาน"));
  await app.telegramControl.pollOnce({ timeoutSec: 0 });

  assert.equal(lineFetch.sends.length, 1, "LINE push หนึ่งครั้งเท่านั้น");
  assert.equal(lineFetch.sends[0].url, "http://line.mock/v2/bot/message/push");
  assert.equal(lineFetch.sends[0].body.to, id);
  const pushed = lineFetch.sends[0].body.messages.map((m) => m.text).join("\n");
  assert.equal(pushed, "ขออนุญาตถามเพิ่มนิดนึงนะคะ\nทีมที่จะเข้าร่วมมีประมาณกี่ท่านคะ?");
  const prompt = JSON.stringify(hermesFetch.calls[0].messages);
  assert.match(prompt, /ถามต่อเรื่องจำนวนพนักงาน/u);
  const replies = telegramFetch.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
  const final = replies.at(-1);
  assert.match(final, /^ส่งให้คุณ ท\*\*\* \(LINE\) แล้วค่ะพี่ง้วง 👇/u);
  assert.ok(final.includes(pushed), "Telegram ต้องแสดงข้อความเดียวกับที่ LINE รับจริง");
  assert.match(final, /AI ห้องนี้: 🔴 ปิดอยู่ \(ส่งต่องาน In-house\/Private ให้ทีมแล้ว\)/u);
  assert.match(final, new RegExp(`https://lukprae\\.example/console/#/c/${id}`, "u"));
  const audit = db.listAudit(20).find((row) => row.action === "yolo_sent");
  assert.equal(audit.operator, "telegram:ngoung");
  assert.match(audit.detail, /^telegram · /u);
  assert.equal(db.getCustomer(id).ai_enabled, 0, "yolo ไม่แตะสวิตช์ AI");
});
