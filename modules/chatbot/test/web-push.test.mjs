import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createConfig } from "../src/config.mjs";
import { createWebPushService, validWebPushEndpoint } from "../src/webPush.mjs";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function vapidFixture() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
  return { publicKey, privateKey: jwk.d };
}

function enabledConfig(overrides = {}) {
  const keys = vapidFixture();
  return createConfig({
    WEB_PUSH_ENABLED: "true",
    WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
    WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
    WEB_PUSH_VAPID_SUBJECT: "https://admin.example.com",
    ...overrides,
  });
}

test("web push config is fail-closed and never exposes a half-configured service", () => {
  const off = createConfig({});
  assert.equal(off.webPushEnabled, false);
  assert.equal(off.webPushVapidPublicKey, "");
  const half = createConfig({ WEB_PUSH_ENABLED: "true", WEB_PUSH_VAPID_PUBLIC_KEY: "bad" });
  const db = memoryDb();
  const service = createWebPushService({ db, config: half, fetchImpl: async () => new Response(null, { status: 201 }), logger: silent });
  assert.equal(service.status().available, false);
  const left = vapidFixture();
  const right = vapidFixture();
  const mismatched = createConfig({
    WEB_PUSH_ENABLED: "true",
    WEB_PUSH_VAPID_PUBLIC_KEY: left.publicKey,
    WEB_PUSH_VAPID_PRIVATE_KEY: right.privateKey,
    WEB_PUSH_VAPID_SUBJECT: "https://admin.example.com",
  });
  assert.equal(createWebPushService({ db, config: mismatched, fetchImpl: async () => new Response(null, { status: 201 }), logger: silent }).status().available, false);
  db.close();
});

test("push endpoint validation allows known browser push services and rejects SSRF targets", () => {
  assert.equal(validWebPushEndpoint("https://fcm.googleapis.com/fcm/send/abc").ok, true);
  assert.equal(validWebPushEndpoint("https://web.push.apple.com/QE/test").ok, true);
  assert.equal(validWebPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/test").ok, true);
  for (const endpoint of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://127.0.0.1/push",
    "https://example.com/push",
    "https://user:pass@fcm.googleapis.com/push",
    "https://fcm.googleapis.com/push#secret",
  ]) assert.equal(validWebPushEndpoint(endpoint).ok, false, endpoint);
});

test("owner subscription is session-bound, wakes on every inbound, and sends an empty VAPID push", async () => {
  // ใช้เวลาจริงเป็นฐาน เพราะรายการ "ใครยังรออยู่" อ่านจาก messages ซึ่งประทับเวลาจริง
  let now = Date.now();
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: "x", displayName: "Owner", role: "owner" });
  const calls = [];
  const service = createWebPushService({
    db,
    config: enabledConfig(),
    now: () => now,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 201 });
    },
    logger: silent,
  });
  const endpoint = "https://fcm.googleapis.com/fcm/send/device-one";
  const saved = service.subscribe({
    operator: db.getOperator("owner"), endpoint, sessionId: "session-one",
    sessionExpiresAt: now + 60_000, userAgent: "Mobile Safari",
  });
  assert.equal(saved.ok, true);
  assert.equal(service.statusFor("owner").activeDeviceCount, 1);

  // ความจริงของ "ใครยังรออยู่" มาจากตาราง messages ซึ่งของจริงถูกบันทึกในธุรกรรม
  // เดียวกับข้อความลูกค้าก่อนจะเรียก fire() เสมอ — จำลองลำดับนั้นให้ตรง
  db.insertMessage({ customerId: "U-customer", direction: "in", msgType: "text", content: "สวัสดีค่ะ" });
  const first = await service.fire({ customerId: "U-customer", channelId: "default" });
  const duplicate = await service.fire({ customerId: "U-customer", channelId: "default" });
  // audit 2026-08-25: เดิมข้ามการปลุกครั้งที่สองในหน้าต่าง 10 วินาที ซึ่งอันตราย
  // เพราะการปลุกครั้งแรกอาจล้มเหลว แล้วครั้งที่ถูกข้ามคือครั้งเดียวที่เหลืออยู่
  // ตอนนี้ปลุกทุกครั้ง — payload ว่าง tag ผูกกับห้องแชท การปลุกซ้ำจึงไม่สร้างของซ้ำ
  assert.equal(first.sent, 1);
  assert.equal(duplicate.sent, 1, "ทุกข้อความของลูกค้าต้องปลุกเครื่อง ไม่มีการข้าม");
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map((call) => call.init.headers.Topic)).size, 1,
    "Topic คงที่ต่อเครื่อง ผู้ให้บริการจึงยุบคิวเหลืออันเดียว");
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error", "provider redirects must never be followed");
  assert.match(calls[0].init.headers.Authorization, /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=/u);
  assert.equal(calls[0].init.body, undefined, "v1 intentionally sends no encrypted customer payload");

  const pending = service.pendingFor("owner");
  assert.equal(pending.url, "/console/#/c/U-customer");
  assert.equal("customerId" in pending, false, "API payload must not expose raw LINE identity");

  service.disableSession({ operatorUsername: "owner", sessionId: "session-one" });
  now += 10_000;
  assert.equal((await service.fire({ customerId: "U-other" })).skipped, "no_active_subscriptions");
  db.close();
});

test("admin subscription is invalidated immediately by role downgrade or account disable", async () => {
  let now = 1_800_000_000_000;
  const db = memoryDb();
  db.createOperator({ username: "admin", passHash: "x", displayName: "Admin", role: "admin" });
  const service = createWebPushService({
    db, config: enabledConfig(), now: () => now,
    fetchImpl: async () => new Response(null, { status: 201 }),
    logger: silent,
  });
  const endpoint = "https://fcm.googleapis.com/fcm/send/admin-device";
  assert.equal(service.subscribe({
    operator: db.getOperator("admin"), endpoint, sessionId: "admin-session",
    sessionExpiresAt: now + 60_000,
  }).ok, true);
  assert.equal(service.statusFor("admin").activeDeviceCount, 1);

  db.updateOperatorAccount("admin", { displayName: "Admin", role: "operator", disabled: false });
  assert.equal(service.statusFor("admin").activeDeviceCount, 0);
  now += 10_000;
  assert.equal((await service.fire({ customerId: "U-after-demotion" })).skipped, "no_active_subscriptions");

  db.updateOperatorAccount("admin", { displayName: "Admin", role: "admin", disabled: false });
  assert.equal(service.subscribe({
    operator: db.getOperator("admin"), endpoint, sessionId: "admin-session-2",
    sessionExpiresAt: now + 60_000,
  }).ok, true);
  assert.equal(service.statusFor("admin").activeDeviceCount, 1);
  db.updateOperatorAccount("admin", { displayName: "Admin", role: "admin", disabled: true });
  assert.equal(service.statusFor("admin").activeDeviceCount, 0);
  db.close();
});

test("410 provider response retires the stale endpoint and is never retried automatically", async () => {
  const now = 1_800_000_000_000;
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: "x", displayName: "Owner", role: "owner" });
  let calls = 0;
  const service = createWebPushService({
    db, config: enabledConfig(), now: () => now,
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 410 }); },
    logger: silent,
  });
  service.subscribe({
    operator: db.getOperator("owner"), endpoint: "https://web.push.apple.com/QE/stale",
    sessionId: "session-stale", sessionExpiresAt: now + 60_000,
  });
  const result = await service.fire({ customerId: "U-stale" });
  assert.equal(result.sent, 0);
  assert.equal(result.retired, 1);
  assert.equal(calls, 1);
  assert.equal(service.statusFor("owner").activeDeviceCount, 0);
  db.close();
});
