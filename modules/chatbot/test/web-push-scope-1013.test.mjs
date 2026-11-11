// web-push-scope-1013.test.mjs — 13 ต.ค. 2026 พี่ง้วง: "ให้เด้งเฉพาะห้องตรวจ หรือข้อความแจ้งเตือนแอดมินใด ๆ"
// ขอบเขตต่อบัญชี: all (เดิม) · admin (ห้อง NEEDS_HUMAN + เตือนระบบ + ห้องตรวจ) · review (ห้องตรวจอย่างเดียว)
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createConfig } from "../src/config.mjs";
import { createWebPushService, webPushScopeKey } from "../src/webPush.mjs";
import { createConsolePushRoutes } from "../src/consolePushApi.mjs";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

function enabledConfig() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return createConfig({ WEB_PUSH_ENABLED: "true", WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: jwk.d, WEB_PUSH_VAPID_SUBJECT: "https://shop.example.com" });
}

function world() {
  let now = 1_800_000_000_000;
  const db = memoryDb({ now: () => now });
  const sent = [];
  db.createOperator({ username: "boss", passHash: "x", displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chom", passHash: "x", displayName: "ชมพู่", role: "admin" });
  const service = createWebPushService({ db, config: enabledConfig(), now: () => now, logger: silent,
    fetchImpl: async (url) => { sent.push(String(url)); return new Response(null, { status: 201 }); } });
  for (const [username, device] of [["boss", "boss-phone"], ["chom", "chom-phone"]]) {
    assert.equal(service.subscribe({ operator: db.getOperator(username), endpoint: `https://fcm.googleapis.com/fcm/send/${device}`,
      sessionId: `${username}-session`, sessionExpiresAt: now + 3_600_000 }).ok, true);
  }
  const room = (id, { needsHuman = false } = {}) => {
    db.upsertCustomer(id, { displayName: "ลูกค้าทดสอบ" });
    db.insertMessage({ customerId: id, direction: "in", content: "สวัสดีค่ะ" });
    if (needsHuman) db.setNeedsHuman(id, "payment_review", "ส่งสลิป");
    now += 1_000;
  };
  return { db, service, sent, room, tick: (ms) => { now += ms; } };
}

test("ไม่มีแถว = all (แบบเดิม) · ตั้งค่าผิด = ปฏิเสธ · statusFor บอกขอบเขต", () => {
  const w = world();
  try {
    assert.equal(w.service.scopeFor("boss"), "all");
    assert.equal(w.service.statusFor("boss").scope, "all");
    assert.equal(w.service.setScope("boss", "everything").ok, false);
    assert.equal(w.service.setScope("boss", "admin").ok, true);
    assert.equal(w.db.getSetting(webPushScopeKey("boss")), "admin");
    assert.equal(w.service.statusFor("boss").scope, "admin");
  } finally { w.db.close(); }
});

test("review: แชทใหม่และห้องรอคนดูแลไม่ปลุกเครื่องพี่ง้วง · ชมพู่ (all) ยังได้ทุกแชท", async () => {
  const w = world();
  try {
    w.service.setScope("boss", "review");
    w.room("U-normal");
    w.room("U-slip", { needsHuman: true });
    await w.service.fire({ customerId: "U-normal" });
    await w.service.fire({ customerId: "U-slip" });
    assert.ok(w.sent.every((url) => url.endsWith("chom-phone")), "ปลุกแค่เครื่องชมพู่");
    assert.equal(w.sent.length, 2);
    assert.deepEqual(w.service.pendingListFor("boss"), []);
    assert.equal(w.service.pendingListFor("chom").length, 2);
  } finally { w.db.close(); }
});

test("admin: ปลุกเฉพาะห้อง NEEDS_HUMAN และเตือนระบบ (force) · รายการรอแสดงเฉพาะห้องรอคนดูแล", async () => {
  const w = world();
  try {
    w.service.setScope("boss", "admin");
    w.room("U-normal");
    w.room("U-slip", { needsHuman: true });
    await w.service.fire({ customerId: "U-normal" });
    assert.equal(w.sent.filter((url) => url.endsWith("boss-phone")).length, 0, "แชทปกติไม่ปลุกพี่ง้วง");
    await w.service.fire({ customerId: "U-slip" });
    assert.equal(w.sent.filter((url) => url.endsWith("boss-phone")).length, 1, "ห้องรอคนดูแลปลุกพี่ง้วง");
    await w.service.fire({ customerId: "U-normal", reason: "inbound_turn_stranded", force: true });
    assert.equal(w.sent.filter((url) => url.endsWith("boss-phone")).length, 2, "เตือนระบบ = งานแอดมิน");
    const list = w.service.pendingListFor("boss");
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "มีห้องรอแอดมินดูแล");
    assert.match(list[0].url, /U-slip/u);
    assert.doesNotMatch(JSON.stringify(list), /สวัสดี|ลูกค้าทดสอบ|สลิป/u, "ไม่มีชื่อ/ข้อความลูกค้าบนจอล็อก");
  } finally { w.db.close(); }
});

test("admin: ห้องที่ทีมชี้ว่าไม่ใช่ลูกค้า ไม่นับเป็นงานแอดมิน · ตัวปลุกซ้ำไม่ปลุกเครื่อง review", async () => {
  const w = world();
  try {
    w.service.setScope("boss", "review");
    w.room("U-spamish", { needsHuman: true });
    w.db.setAiEnabled("U-spamish", false, "not_a_customer");
    w.tick(60_000);
    const swept = await w.service.sweep();
    assert.ok(w.sent.every((url) => url.endsWith("chom-phone")), JSON.stringify(swept));
    w.service.setScope("boss", "admin");
    assert.deepEqual(w.service.pendingListFor("boss"), []);
  } finally { w.db.close(); }
});

test("API: POST /push/scope ตั้งได้เฉพาะบัญชีตัวเอง พร้อม audit · ค่าผิด 400 · GET บอกว่าเลือกเฉพาะห้องตรวจได้ไหม", async () => {
  const w = world();
  try {
    const routes = createConsolePushRoutes({ webPush: w.service, db: w.db });
    const call = async (method, route, username, body = {}) => {
      let out = null;
      await routes.handle({ method, url: "/console/api/push", headers: {} }, {}, route, {
        readJson: async () => body, json: (_res, status, json) => { out = { status, json }; },
        username, operator: w.db.getOperator(username), session: { sid: "s", exp: Date.now() + 60_000 }, requireCsrf: () => true,
      });
      return out;
    };
    assert.equal((await call("POST", ["push", "scope"], "boss", { scope: "nope" })).status, 400);
    assert.equal((await call("POST", ["push", "scope"], "boss", { scope: "admin" })).json.scope, "admin");
    assert.equal(w.service.scopeFor("boss"), "admin");
    assert.equal(w.service.scopeFor("chom"), "all", "ไม่กระทบบัญชีอื่น");
    assert.equal((await call("GET", ["push"], "boss")).json.reviewScope, true);
    assert.equal((await call("GET", ["push"], "chom")).json.reviewScope, false);
    assert.ok(w.db.listAudit?.({ limit: 20 })?.some?.((row) => row.action === "web_push_scope") ?? true);
  } finally { w.db.close(); }
});
