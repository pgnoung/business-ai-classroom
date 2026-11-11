// channels.test.mjs — W3 multi-OA / หลายสาขา (ธุรกิจเดียว หลาย LINE OA ใน instance เดียว)
// ครอบ: loader tolerant, webhook สอง channel (secret ใคร verify ได้เฉพาะ channel นั้น),
// ลูกค้าคนเดียวทัก 2 OA = 2 แถว, reply จาก console ใช้ token ของสาขาถูกตัว + raw user id,
// inbox/counts กรองต่อสาขา, export มีคอลัมน์สาขา + กรองได้, destination mapping ถูก persist
// (โหมด legacy ไม่มี CHANNELS_FILE ถูกพิสูจน์โดย suite เดิมทั้งชุดอยู่แล้ว)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.mjs";
import { createConfig } from "../src/config.mjs";
import { loadChannels, customerKey, splitCustomerKey } from "../src/channels.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub,
  httpRequest, listen, signLine, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

const CHANNELS = [
  { id: "a", name: "สาขาเอ", channelSecret: "secret-a", channelAccessToken: "token-a", active: true },
  { id: "b", name: "สาขาบี", channelSecret: "secret-b", channelAccessToken: "token-b", active: true },
];

// stub fetch ฝั่ง LINE ที่เก็บ header ด้วย — ใช้ assert ว่า Bearer token ตรงสาขา
function lineFetchWithHeaders() {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      headers: opts.headers || {},
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  fn.calls = calls;
  fn.sends = () => calls.filter((c) => c.url.includes("/v2/bot/message/"));
  return fn;
}

function writeChannelsFile(t, channels = CHANNELS) {
  const dir = mkdtempSync(join(tmpdir(), "chassis-channels-"));
  const file = join(dir, "channels.json");
  writeFileSync(file, JSON.stringify(channels), { mode: 0o600 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

async function startMulti(t, { lineFetch = lineFetchWithHeaders() } = {}) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: CONSOLE_SECRET,
    CHANNELS_FILE: writeChannelsFile(t),
  });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, config, lineFetch };
}

function postWebhook(server, body, secret) {
  const raw = JSON.stringify(body);
  return httpRequest(server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, secret) },
    body: raw,
  });
}

const textEvent = (userId, id, text) => ({
  type: "message", replyToken: "", webhookEventId: `evt-${id}`,
  source: { userId }, message: { type: "text", id, text },
});

async function loginSession(server) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: PASSWORD }),
  });
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  const cookie = (res.headers["set-cookie"]?.[0] || "").split(";")[0];
  const me = await httpRequest(server, { path: "/console/api/me", headers: { cookie } });
  return { cookie, csrf: me.json.csrf };
}

/* --------------------------------- loader ---------------------------------- */

test("loadChannels: ไม่มี CHANNELS_FILE = โหมด legacy channel เดียว 'default' จาก env", () => {
  const config = createConfig({ LINE_CHANNEL_SECRET: "s", LINE_CHANNEL_ACCESS_TOKEN: "tk", LINE_CHANNEL_NAME: "OA ทดสอบ" });
  const channels = loadChannels(config, { logger: silent });
  assert.equal(channels.length, 1);
  assert.equal(channels[0].id, "default");
  assert.equal(channels[0].name, "OA ทดสอบ");
  assert.equal(channels[0].channelSecret, "s");
  assert.equal(channels[0].channelAccessToken, "tk");
});

test("loadChannels: ไฟล์พัง/ไม่ใช่ array/entry ผิดรูป = tolerant ไม่ล้ม + ข้าม entry เสีย", (t) => {
  const bad = mkdtempSync(join(tmpdir(), "chassis-badch-"));
  t.after(() => rmSync(bad, { recursive: true, force: true }));
  const badFile = join(bad, "bad.json");
  writeFileSync(badFile, "not-json{{{");
  const legacy = loadChannels(createConfig({ CHANNELS_FILE: badFile, LINE_CHANNEL_SECRET: "s" }), { logger: silent });
  assert.equal(legacy[0].id, "default", "ไฟล์พัง = ตกกลับ legacy");

  const mixedFile = join(bad, "mixed.json");
  // id มี ":" / คำสงวน canary / ซ้ำ — ต้องเหลือเฉพาะตัวที่ถูกต้อง
  writeFileSync(mixedFile, JSON.stringify([
    { id: "ok-1", channelSecret: "x" },
    { id: "has:colon", channelSecret: "x" },
    { id: "canary", channelSecret: "x" },
    { id: "ok-1", channelSecret: "dup" },
  ]));
  const mixed = loadChannels(createConfig({ CHANNELS_FILE: mixedFile }), { logger: silent });
  assert.deepEqual(mixed.map((c) => c.id), ["ok-1"]);
});

test("customerKey/splitCustomerKey: default = raw id, สาขาอื่น = prefix, canary ไม่โดน strip", () => {
  assert.equal(customerKey("default", "U123"), "U123");
  assert.equal(customerKey("b", "U123"), "b:U123");
  const known = new Set(["a", "b"]);
  assert.deepEqual(splitCustomerKey("b:U123", known), { channelId: "b", userId: "U123" });
  assert.deepEqual(splitCustomerKey("U123", known), { channelId: "default", userId: "U123" });
  assert.deepEqual(splitCustomerKey("canary:synthetic", known), { channelId: "default", userId: "canary:synthetic" });
});

/* --------------------------------- webhook --------------------------------- */

test("webhook สอง channel: secret ใคร verify ได้เฉพาะ channel นั้น + ลูกค้าคนเดียว 2 OA = 2 แถว", async (t) => {
  const { app, db } = await startMulti(t);

  // secret ผิดทั้งคู่ = 403
  const bad = await postWebhook(app.server, { destination: "Ubot-a", events: [textEvent("U-same", "m0", "hi")] }, "wrong-secret");
  assert.equal(bad.status, 403);

  // ลูกค้าคนเดียวกันทักเข้า OA สาขาเอ (sign ด้วย secret-a)
  const resA = await postWebhook(app.server, { destination: "Ubot-a", events: [textEvent("U-same", "m1", "สวัสดีสาขาเอ")] }, "secret-a");
  assert.equal(resA.status, 200);
  assert.equal(resA.json.accepted, 1);

  // และทักเข้า OA สาขาบี (sign ด้วย secret-b)
  const resB = await postWebhook(app.server, { destination: "Ubot-b", events: [textEvent("U-same", "m2", "สวัสดีสาขาบี")] }, "secret-b");
  assert.equal(resB.status, 200);

  // 2 แถวลูกค้า คนละสาขา — key ต่อสาขา (scheme ใน channels.mjs)
  const custA = db.getCustomer("a:U-same");
  const custB = db.getCustomer("b:U-same");
  assert.ok(custA && custB, "ลูกค้าคนเดียวทัก 2 OA ต้องเป็น 2 แถว");
  assert.equal(custA.channel_id, "a");
  assert.equal(custB.channel_id, "b");
  assert.equal(db.getCustomer("U-same"), null, "ต้องไม่มีแถว raw id หลุดมา");

  // ข้อความ log แยกสาขาถูกต้อง
  assert.equal(db.messagesFor("a:U-same", 10).length >= 1, true);
  assert.equal(db.messagesFor("a:U-same", 10)[0].content, "สวัสดีสาขาเอ");
  assert.equal(db.messagesFor("b:U-same", 10)[0].content, "สวัสดีสาขาบี");

  // destination -> channel mapping ถูก persist หลัง verify ครั้งแรก
  assert.equal(db.getSetting("line_dest:Ubot-a"), "a");
  assert.equal(db.getSetting("line_dest:Ubot-b"), "b");
});

test("webhook: mapping destination ที่ค้างผิด channel ถูกซ่อมเอง (fallback ไล่ secret แล้ว remap)", async (t) => {
  const { app, db } = await startMulti(t);
  // สมมุติ mapping เก่าชี้ผิด (เช่นย้าย OA ไปอีกสาขา) — secret จริงคือของ b
  db.setSetting("line_dest:Ubot-x", "a");
  const res = await postWebhook(app.server, { destination: "Ubot-x", events: [textEvent("U-heal", "h1", "ทดสอบ")] }, "secret-b");
  assert.equal(res.status, 200, "mapping ผิดต้องไม่ทำให้ 403 — ไล่ลองทุก channel ต่อ");
  assert.equal(db.getSetting("line_dest:Ubot-x"), "b", "mapping ต้องถูกซ่อมเป็น channel ที่ verify ได้จริง");
  assert.ok(db.getCustomer("b:U-heal"), "ลูกค้าต้องเข้าสาขา b ตาม secret ที่ verify ได้");
});

test("webhook: AI ตอบลูกค้าสาขาบีด้วย token-b และ push ไปที่ raw user id (ไม่ใช่ key)", async (t) => {
  const lineFetch = lineFetchWithHeaders();
  const { app } = await startMulti(t, { lineFetch });

  const res = await postWebhook(app.server, { destination: "Ubot-b", events: [textEvent("U-cust", "m9", "สนใจสินค้าค่ะ")] }, "secret-b");
  assert.equal(res.status, 200);

  // pipeline วิ่งหลังตอบ 200 — รอจน LINE ขาส่งถูกเรียก
  await waitFor(() => lineFetch.sends().length > 0);
  const send = lineFetch.sends()[0];
  assert.equal(send.headers.authorization, "Bearer token-b", "ต้องใช้ token ของสาขาบี");
  assert.equal(send.body.to, "U-cust", "ปลายทางต้องเป็น raw LINE user id ไม่ใช่ customer key");
});

/* ------------------------------ console scoping ----------------------------- */

test("console: reply ใช้ token ตรงสาขา + inbox/counts กรองต่อสาขา + ป้ายชื่อสาขา", async (t) => {
  const lineFetch = lineFetchWithHeaders();
  const { app, db } = await startMulti(t, { lineFetch });

  // seed ลูกค้า 2 สาขา + hot หนึ่งคนในสาขาเอ
  db.upsertCustomer("a:U-one", { displayName: "ลูกค้าเอ", channelId: "a" });
  db.upsertCustomer("b:U-two", { displayName: "ลูกค้าบี", channelId: "b" });
  db.recordScore("a:U-one", 9, "{}");
  db.insertMessage({ customerId: "a:U-one", direction: "in", content: "ทักจากสาขาเอ" });
  db.insertMessage({ customerId: "b:U-two", direction: "in", content: "ทักจากสาขาบี" });

  const { cookie, csrf } = await loginSession(app.server);

  // reply เข้าห้องสาขาบี — token ต้องเป็นของสาขาบี + to = raw id
  const reply = await httpRequest(app.server, {
    method: "POST", path: `/console/api/conversations/${encodeURIComponent("b:U-two")}/reply`,
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
    body: JSON.stringify({ text: "แอดมินตอบจากสาขาบีค่ะ" }),
  });
  assert.equal(reply.status, 200, reply.text);
  const sent = lineFetch.sends().at(-1);
  assert.equal(sent.headers.authorization, "Bearer token-b");
  assert.equal(sent.body.to, "U-two");

  // inbox ทุกสาขา = 2 / กรอง channel=a = 1 + counts ต่อสาขา
  const all = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  assert.equal(all.json.conversations.length, 2);
  assert.equal(all.json.counts.all, 2);
  const onlyA = await httpRequest(app.server, { path: "/console/api/inbox?channel=a", headers: { cookie } });
  assert.equal(onlyA.json.conversations.length, 1);
  assert.equal(onlyA.json.conversations[0].line_user_id, "a:U-one");
  assert.equal(onlyA.json.conversations[0].channel_id, "a");
  assert.equal(onlyA.json.counts.all, 1);
  assert.equal(onlyA.json.counts.hot, 1);
  const badCh = await httpRequest(app.server, { path: "/console/api/inbox?channel=zzz", headers: { cookie } });
  assert.equal(badCh.status, 400);

  // overview scoped ต่อสาขา
  const ovA = await httpRequest(app.server, { path: "/console/api/overview?channel=a", headers: { cookie } });
  assert.equal(ovA.json.stats.totalCustomers, 1);
  assert.equal(ovA.json.stats.hotCustomers, 1);
  const ovB = await httpRequest(app.server, { path: "/console/api/overview?channel=b", headers: { cookie } });
  assert.equal(ovB.json.stats.hotCustomers, 0);

  // รายการสาขา read-only (ไม่มี secret หลุด)
  const chs = await httpRequest(app.server, { path: "/console/api/channels", headers: { cookie } });
  assert.equal(chs.json.multi, true);
  assert.deepEqual(chs.json.channels.map((c) => c.id), ["a", "b"]);
  assert.ok(!chs.text.includes("secret-a") && !chs.text.includes("token-a"), "ห้ามมี secret ใน response");
});

test("overview ทุกสาขา: อ่าน quota ของแต่ละ OA พร้อมกันและไม่เรียก default ซ้ำ", async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  const quotaCalls = [];
  const delayedQuotaFetch = async (url) => {
    const path = String(url);
    if (!path.includes("/v2/bot/message/quota")) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    quotaCalls.push(path);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      json: async () => path.endsWith("/consumption")
        ? { totalUsage: 20 }
        : { type: "limited", value: 1_000 },
    };
  };
  const { app } = await startMulti(t, { lineFetch: delayedQuotaFetch });
  const { cookie } = await loginSession(app.server);

  const overview = await httpRequest(app.server, { path: "/console/api/overview", headers: { cookie } });
  assert.equal(overview.status, 200, overview.text);
  assert.equal(quotaCalls.length, 4, "2 OA × (quota + consumption) เท่านั้น");
  assert.equal(maxInFlight, 4, "quota ของ 2 OA ต้องเริ่มพร้อมกัน ไม่รอทีละสาขา");
  assert.deepEqual(overview.json.quotas.map((entry) => entry.quota.totalUsage), [20, 20]);
});

test("export: มีคอลัมน์สาขา (ชื่อสาขาอ่านรู้เรื่อง) + กรอง channel ได้ + ชื่อไฟล์ระบุสาขา", async (t) => {
  const { app, db } = await startMulti(t);
  db.upsertCustomer("a:U-one", { displayName: "ลูกค้าเอ", channelId: "a" });
  db.upsertCustomer("b:U-two", { displayName: "ลูกค้าบี", channelId: "b" });
  db.insertMessage({ customerId: "a:U-one", direction: "in", content: "ข้อความสาขาเอ" });
  db.insertMessage({ customerId: "b:U-two", direction: "in", content: "ข้อความสาขาบี" });

  const { cookie } = await loginSession(app.server);

  const full = await httpRequest(app.server, { path: "/console/api/export?scope=all", headers: { cookie } });
  assert.equal(full.status, 200);
  const header = full.text.replace(/^﻿/, "").split("\r\n")[0];
  assert.ok(header.endsWith(",สาขา"), `header ต้องมีคอลัมน์สาขา: ${header}`);
  assert.ok(full.text.includes("ข้อความสาขาเอ,สาขาเอ"), "แถวต้องลงท้ายด้วยชื่อสาขา");
  assert.ok(full.text.includes("ข้อความสาขาบี,สาขาบี"));

  const onlyB = await httpRequest(app.server, { path: "/console/api/export?scope=all&channel=b", headers: { cookie } });
  assert.ok(!onlyB.text.includes("ข้อความสาขาเอ"), "กรอง channel=b แล้วต้องไม่มีแถวสาขาเอ");
  assert.ok(onlyB.text.includes("ข้อความสาขาบี"));
  assert.match(onlyB.headers["content-disposition"], /filename="airdog-chat-all-b-all-\d{8}\.csv"/);

  const badCh = await httpRequest(app.server, { path: "/console/api/export?scope=all&channel=zzz", headers: { cookie } });
  assert.equal(badCh.status, 400);
});
