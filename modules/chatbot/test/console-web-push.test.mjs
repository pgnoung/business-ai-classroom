import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  signLine, httpRequest, listen, waitFor, sleep,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const PASSWORD = "owner-web-push-pass";

function vapidFixture() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"),
    privateKey: jwk.d,
  };
}

async function startConsole(t, options = {}) {
  const keys = vapidFixture();
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "admin", passHash: hashPassword(PASSWORD), displayName: "แอดมิน", role: "admin" });
  db.createOperator({ username: "staff", passHash: hashPassword(PASSWORD), displayName: "ทีม", role: "operator" });
  const pushCalls = [];
  let pushFailuresLeft = options.failFirstPush ? 1 : 0;
  const app = createApp({
    config: testConfig({
      CONSOLE_SESSION_SECRET: "web-push-console-session-secret-012345",
      WEB_PUSH_ENABLED: "true",
      WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
      WEB_PUSH_VAPID_SUBJECT: "https://admin.example.com",
    }),
    db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      webPushFetch: async (url, init) => {
        pushCalls.push({ url: String(url), init });
        // 503 = ผู้ให้บริการสะดุดชั่วคราว ไม่ใช่เหตุให้เลิกใช้ endpoint
        if (pushFailuresLeft > 0) { pushFailuresLeft -= 1; return new Response(null, { status: 503 }); }
        return new Response(null, { status: 201 });
      },
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, keys, pushCalls };
}

async function login(server, username = "owner") {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

function postJson(server, path, body, auth) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf },
    body: JSON.stringify(body),
  });
}

function webhookBody(id, userId = "Uwebpush", text = "สวัสดี") {
  return JSON.stringify({ events: [{
    type: "message", webhookEventId: `w-${id}`, replyToken: `r-${id}`,
    source: { type: "user", userId }, message: { id, type: "text", text },
  }] });
}

test("owner/admin push API exposes only public configuration and binds each device to its session", async (t) => {
  const { app, keys, pushCalls } = await startConsole(t);
  const health = await httpRequest(app.server, { path: "/health" });
  assert.equal(health.json.components.webPush, "ready");
  const owner = await login(app.server);
  const status = await httpRequest(app.server, { path: "/console/api/push", headers: { cookie: owner.cookie } });
  assert.equal(status.status, 200);
  assert.equal(status.json.available, true);
  assert.equal(status.json.publicKey, keys.publicKey);
  assert.equal(status.json.activeDeviceCount, 0);
  assert.ok(!status.text.includes(keys.privateKey));

  const noCsrf = await httpRequest(app.server, {
    method: "POST", path: "/console/api/push/subscribe",
    headers: { "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/no-csrf" }),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await postJson(app.server, "/console/api/push/subscribe", { endpoint: "https://127.0.0.1/ssrf" }, owner)).status, 400);
  const added = await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);
  assert.equal(added.status, 201, added.text);
  assert.equal(added.json.activeDeviceCount, 1);
  assert.ok(!added.text.includes("owner-phone"), "subscription endpoint must not be reflected");

  const admin = await login(app.server, "admin");
  const adminMe = await httpRequest(app.server, { path: "/console/api/me", headers: { cookie: admin.cookie } });
  assert.equal(adminMe.status, 200);
  assert.equal(adminMe.json.features.webPush, true);
  assert.ok(adminMe.json.operator.capabilities.includes("notifications.manage"));
  assert.equal((await httpRequest(app.server, { path: "/console/api/push", headers: { cookie: admin.cookie } })).status, 200);
  const adminAdded = await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://updates.push.services.mozilla.com/wpush/v2/admin-phone",
  }, admin);
  assert.equal(adminAdded.status, 201, adminAdded.text);
  assert.equal(adminAdded.json.activeDeviceCount, 1);

  const staff = await login(app.server, "staff");
  // เจ้าของตัดสิน 2026-08-25: staff รับแจ้งเตือนบนเครื่องตัวเองได้ (ต้องรู้ว่าลูกค้าทัก)
  assert.equal((await httpRequest(app.server, { path: "/console/api/push", headers: { cookie: staff.cookie } })).status, 200);
  assert.equal((await httpRequest(app.server, { path: "/console/api/push" })).status, 401, "ผู้ไม่ล็อกอินยังถูกปฏิเสธ");
  // จุดบอดเดิม: เทสต์ยืนยันแค่ว่า staff เปิดได้ (HTTP 200) ไม่เคยยืนยันว่า "ส่งถึงจริง"
  // คิวรีฝั่งส่งจริงกรอง owner/admin ไว้ ชมพู่จึงกดเปิดสำเร็จแต่ไม่มีวันได้รับสักครั้ง
  const staffAdded = await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/staff-phone",
  }, staff);
  assert.equal(staffAdded.status, 201, staffAdded.text);

  const raw = webhookBody("owner-admin-push");
  const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  await waitFor(() => pushCalls.length === 3);
  assert.equal(pushCalls.length, 3, "owner, admin and staff must each receive one provider wake-up");

  // TTL ต้องยาวเท่าอายุ event ที่มันชี้ไป ไม่งั้นมือถือที่หลับนานกว่านั้นจะไม่ได้รับเลย
  // 12 ชม. เพราะ Console ใช้แทน LINE OA — ปิดเครื่องข้ามคืนแล้วต้องยังรู้ว่ามีคนรอ
  for (const call of pushCalls) {
    assert.equal(Number(call.init.headers.TTL), 43200, "TTL must match the 12-hour event lifetime");
    assert.equal(call.init.headers.Urgency, "high");
  }

  const adminPending = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: admin.cookie } });
  assert.equal(adminPending.status, 200);
  assert.equal(adminPending.json.event.url, "/console/#/c/Uwebpush");
  assert.equal(adminPending.json.events.length, 1, "รูปแบบใหม่คืนเป็นรายการ");
  assert.equal(adminPending.json.events[0].url, "/console/#/c/Uwebpush");
  // ไม่มีชื่อลูกค้าหรือเนื้อความหลุดขึ้นหน้าจอล็อก
  assert.equal(adminPending.json.events[0].body.includes("สวัสดี"), false);

  // สถานะต้องมาจากเซิร์ฟเวอร์ ไม่ใช่การเดาจากฝั่งเบราว์เซอร์
  const known = await httpRequest(app.server, {
    path: `/console/api/push?endpoint=${encodeURIComponent("https://updates.push.services.mozilla.com/wpush/v2/admin-phone")}`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(known.json.thisDeviceActive, true);
  const stranger = await httpRequest(app.server, {
    path: `/console/api/push?endpoint=${encodeURIComponent("https://fcm.googleapis.com/fcm/send/never-registered")}`,
    headers: { cookie: admin.cookie },
  });
  assert.equal(stranger.json.thisDeviceActive, false);
});

test("web push survives the everyday mobile hazards: burst, key rotation and self password change", async (t) => {
  const { app, db, pushCalls } = await startConsole(t);
  const owner = await login(app.server);
  assert.equal((await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner)).status, 201);

  // ลูกค้าสองคนทักในชุดเดียวกัน — ต้องไม่มีใครหายไปเงียบ ๆ
  for (const [id, user] of [["burst-a", "Uburstaaa"], ["burst-b", "Uburstbbb"]]) {
    const raw = webhookBody(id, user);
    const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
    assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  }
  await waitFor(() => {
    const pending = db.unansweredCustomers(0, 50);
    return pending.length === 2;
  });
  const pending = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  const urls = pending.json.events.map((event) => event.url);
  assert.equal(urls.length, 2, "แต่ละเคสต้องได้การแจ้งเตือนของตัวเอง ไม่ยุบทับกัน");
  assert.ok(urls.includes("/console/#/c/Uburstaaa") && urls.includes("/console/#/c/Uburstbbb"));
  assert.equal(new Set(pending.json.events.map((event) => event.tag)).size, 2, "tag ต้องไม่ซ้ำ ไม่งั้นอันหลังทับอันแรก");

  // เปลี่ยนรหัสผ่านตัวเอง = session ใหม่ + token_version ใหม่
  // เครื่องที่เปิดแจ้งเตือนไว้ต้องถูกย้ายมาผูกชุดใหม่ ไม่ใช่ตายเงียบ
  const changed = await postJson(app.server, "/console/api/password", {
    currentPassword: PASSWORD, newPassword: "owner-web-push-pass-changed",
  }, owner);
  assert.equal(changed.status, 200, changed.text);
  assert.equal(db.activeWebPushSubscriptions(Date.now()).length, 1,
    "เปลี่ยนรหัสแล้วเครื่องเดิมต้องยังส่งถึง — ไม่งั้นแจ้งเตือนตายถาวรโดยไม่มีใครรู้");
  const before = pushCalls.length;
  const raw = webhookBody("after-password", "Uafterpwd");
  const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  await waitFor(() => pushCalls.length > before);
  assert.ok(pushCalls.length > before, "ยังต้องส่งถึงเครื่องเดิมหลังเปลี่ยนรหัส");
});

test("accepted inbound wakes one push per burst, pending opens the exact chat, and logout revokes the device", async (t) => {
  const { app, pushCalls } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  const raw = webhookBody("push-message-1");
  const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  await waitFor(() => pushCalls.length === 1);
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  await sleep(30);
  assert.equal(pushCalls.length, 1, "LINE redelivery must not create another admin push");

  const pending = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.equal(pending.status, 200);
  assert.equal(pending.json.event.url, "/console/#/c/Uwebpush");
  assert.ok(!pending.text.includes("สวัสดี"), "lock-screen payload must not include customer text");
  assert.equal("customerId" in pending.json.event, false, "raw LINE identity must not be returned as a field");

  assert.equal((await postJson(app.server, "/console/api/logout", {}, owner)).status, 200);
  const next = webhookBody("push-message-2", "Uafterlogout");
  assert.equal((await httpRequest(app.server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(next, "test-line-secret") }, body: next,
  })).status, 200);
  await sleep(30);
  assert.equal(pushCalls.length, 1, "logged-out session must never keep receiving pushes");
});

test("two customers in one inbound burst each keep their own notification", async (t) => {
  const { app, pushCalls } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  const first = webhookBody("push-burst-first", "Uburstfirst");
  const second = webhookBody("push-burst-second", "Uburstsecond");
  const signed = (body) => ({
    "content-type": "application/json",
    "x-line-signature": signLine(body, "test-line-secret"),
  });
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers: signed(first), body: first })).status, 200);
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers: signed(second), body: second })).status, 200);
  await waitFor(() => pushCalls.length === 2);
  await sleep(30);

  // เดิมยุบสองเคสเหลือหนึ่ง ซึ่งแปลว่าลูกค้าคนที่สอง "หายทั้งเคส" ไม่ใช่แค่ชี้ผิดห้อง
  // ตอนนี้ทุกเคสต้องมีรายการของตัวเอง และ tag ต้องไม่ซ้ำ ไม่งั้นอันหลังทับอันแรกบนจอ
  const pending = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.equal(pending.status, 200);
  const urls = pending.json.events.map((event) => event.url);
  assert.deepEqual(urls, ["/console/#/c/Uburstfirst", "/console/#/c/Uburstsecond"], "เรียงเก่า→ใหม่ และครบทั้งสองเคส");
  assert.equal(new Set(pending.json.events.map((event) => event.tag)).size, 2);
  // ยังต้องไม่มีเนื้อความลูกค้าหลุดออกไปกับ payload หรือขึ้นหน้าจอล็อก
  assert.ok(!pending.text.includes("สวัสดี"), "ข้อความลูกค้าต้องไม่อยู่ในรายการแจ้งเตือน");
  for (const call of pushCalls) assert.equal(call.init.body, undefined, "payload ต้องว่างเปล่าเสมอ");

  // ลูกค้าคนเดิมทักรัว ๆ ในชุดเดียวกันยังต้องยุบเหลือรายการเดียว
  const again = webhookBody("push-burst-first-again", "Uburstfirst");
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers: signed(again), body: again })).status, 200);
  await sleep(60);
  const repeat = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.equal(repeat.json.events.length, 2, "คนเดิมทักซ้ำในชุดเดียวกันต้องไม่เพิ่มรายการใหม่");
});

test("มือถือกลับมาออนไลน์: เคสที่คนตอบแล้วต้องเงียบ ส่วนที่ยังรอต้องครบ", async (t) => {
  const { app, db } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  for (const [id, user] of [["stale-a", "Ustalea"], ["stale-b", "Ustaleb"]]) {
    const raw = webhookBody(id, user);
    const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
    assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  }
  await waitFor(() => db.unansweredCustomers(0, 50).length === 2);

  // คนจริงเข้าไปตอบ Ustalea — เคสนี้ต้องหายจากรายการรอ
  db.insertMessage({
    customerId: "Ustalea", direction: "out", msgType: "text",
    content: "รับเรื่องแล้วค่ะ", operator: "owner",
  });
  const afterHuman = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.deepEqual(afterHuman.json.events.map((e) => e.url), ["/console/#/c/Ustaleb"],
    "เคสที่คนจริงตอบแล้วต้องไม่เด้งย้อนหลัง");

  // คำตอบของ AI (ไม่มีชื่อผู้ใช้) ไม่นับว่ามีคนดูแลแล้ว — ยังต้องรออยู่
  db.insertMessage({
    customerId: "Ustaleb", direction: "out", msgType: "text",
    content: "ลูกแพรตอบให้ก่อนนะคะ", operator: "",
  });
  const afterAi = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.deepEqual(afterAi.json.events.map((e) => e.url), ["/console/#/c/Ustaleb"],
    "AI ตอบไม่เท่ากับมีคนดูแล");
});

test("ลูกค้ารอเยอะเกิน 5 คน ยุบเป็นข้อความสรุปอันเดียว ไม่ถล่มจอ", async (t) => {
  const { app, db } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  for (let i = 0; i < 7; i += 1) {
    const raw = webhookBody(`flood-${i}`, `Uflood${i}`);
    const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
    assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  }
  await waitFor(() => db.unansweredCustomers(0, 50).length === 7);
  const pending = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.equal(pending.json.events.length, 1, "ยุบเหลือหนึ่ง");
  assert.equal(pending.json.events[0].url, "/console/#/", "พาไปหน้ารวมให้ไล่เอง");
  assert.ok(pending.json.events[0].body.includes("7"), "ต้องบอกจำนวนที่ยังรอ");
  assert.ok(!pending.text.includes("สวัสดี"), "ยังไม่มีเนื้อความลูกค้าหลุดออกไป");
});

test("บรอดแคสต์ตอนเช้าต้องไม่กลบเคสที่ค้างมาทั้งคืน", async (t) => {
  const { app, db } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  const raw = webhookBody("overnight", "Uovernight");
  const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  await waitFor(() => db.unansweredCustomers(0, 50).length === 1);

  // บรอดแคสต์เขียนแถวขาออกที่ "มีชื่อแอดมิน" ให้ผู้รับทุกคน แต่เป็น proactive
  // ถ้านับว่าเป็นการตอบ เคสที่ค้างมาทั้งคืนจะหายเกลี้ยงตอนเช้าโดยไม่มีใครรู้
  db.insertMessage({
    customerId: "Uovernight", direction: "out", msgType: "text",
    content: "ประกาศรอบเรียนใหม่", messageClass: "proactive", operator: "pngoung",
  });
  const afterBroadcast = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.deepEqual(afterBroadcast.json.events.map((e) => e.url), ["/console/#/c/Uovernight"],
    "บรอดแคสต์ไม่ใช่การตอบลูกค้า เคสต้องยังค้างอยู่");

  // ข้อความอัตโนมัติที่ประทับ operator='system' ก็ไม่ใช่คนจริงเช่นกัน
  db.insertMessage({
    customerId: "Uovernight", direction: "out", msgType: "text",
    content: "รับทราบค่ะ", messageClass: "reactive", operator: "system",
  });
  const afterSystem = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.equal(afterSystem.json.events.length, 1, "ข้อความของระบบไม่ใช่คนจริง");

  // คนจริงตอบจริงเท่านั้นที่ทำให้เงียบ
  db.insertMessage({
    customerId: "Uovernight", direction: "out", msgType: "text",
    content: "สวัสดีค่ะ เดี๋ยวดูให้นะคะ", messageClass: "reactive", operator: "pngoung",
  });
  const afterHuman = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.equal(afterHuman.json.events.length, 0);
});

test("ลูกค้าทักซ้ำหลังแอดมินตอบไปแล้ว ต้องกลับเข้าคิวรออีกครั้ง", async (t) => {
  const { app, db } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  const first = webhookBody("again-1", "Uagain");
  const h = (body) => ({ "content-type": "application/json", "x-line-signature": signLine(body, "test-line-secret") });
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers: h(first), body: first })).status, 200);
  await waitFor(() => db.unansweredCustomers(0, 50).length === 1);
  db.insertMessage({
    customerId: "Uagain", direction: "out", msgType: "text",
    content: "ตอบแล้วค่ะ", messageClass: "reactive", operator: "pngoung",
  });
  assert.equal(db.unansweredCustomers(0, 50).length, 0, "ตอบแล้วต้องเงียบ");

  await sleep(5);
  const second = webhookBody("again-2", "Uagain");
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers: h(second), body: second })).status, 200);
  await waitFor(() => db.unansweredCustomers(0, 50).length === 1);
  const pending = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.deepEqual(pending.json.events.map((e) => e.url), ["/console/#/c/Uagain"],
    "ลูกค้าทักมาอีกหลังถูกตอบ ต้องกลับเข้าคิวเสมอ");
});

test("ส่งพลาดครั้งเดียวต้องไม่ทำให้เคสเงียบยาว — ตัวกวาดปลุกซ้ำ", async (t) => {
  const { app, db, pushCalls } = await startConsole(t, { failFirstPush: true });
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  const raw = webhookBody("flaky", "Uflaky");
  const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  await waitFor(() => pushCalls.length === 1);
  assert.equal(db.unansweredCustomers(0, 50).length, 1, "เคสยังค้างเพราะส่งไม่สำเร็จ");
  // เครื่องยังไม่ถูกปลด เพราะ 503 ไม่ใช่เหตุให้เลิกใช้ endpoint
  assert.equal(db.activeWebPushSubscriptions(Date.now()).length, 1);

  const swept = await app.webPush.sweep();
  assert.equal(swept.ok, true, JSON.stringify(swept));
  assert.equal(swept.retried, 1, "ต้องปลุกเครื่องที่ยังไม่เคยส่งสำเร็จซ้ำ");
  await waitFor(() => pushCalls.length === 2);

  // ปลุกสำเร็จแล้ว รอบถัดไปต้องไม่ปลุกซ้ำอีก
  const idle = await app.webPush.sweep();
  assert.equal(idle.skipped, "all_devices_current");
});

test("ทุกการปลุกใช้ Topic เดียวกันต่อเครื่อง เพื่อให้ผู้ให้บริการยุบคิวเหลืออันเดียว", async (t) => {
  const { app, pushCalls } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);
  for (const [id, user] of [["topic-a", "Utopica"], ["topic-b", "Utopicb"]]) {
    const raw = webhookBody(id, user);
    const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
    assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  }
  await waitFor(() => pushCalls.length === 2, 4000);
  const topics = new Set(pushCalls.map((call) => call.init.headers.Topic));
  assert.equal(topics.size, 1, "Topic ต้องคงที่ต่อเครื่อง ไม่ใช่ต่อเหตุการณ์");
});

test("เปิดห้องดูแล้ว = เคลียร์คิว เหมือน LINE OA ลบเลขแดงตอนกดเข้าไปดู", async (t) => {
  const { app, db } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  const raw = webhookBody("seen-1", "Useen");
  const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  await waitFor(() => db.unansweredCustomers(0, 50).length === 1);

  // poll เบื้องหลัง (seen=0) ต้องไม่นับว่าดูแล้ว ไม่งั้นแค่เปิดหน้าเว็บทิ้งไว้
  // ก็จะกลืนการแจ้งเตือนของทุกห้องที่เคยเปิดค้าง
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/conversations/Useen/messages?limit=50&seen=0", headers: { cookie: owner.cookie },
  })).status, 200);
  assert.equal(db.unansweredCustomers(0, 50).length, 1, "poll เบื้องหลังไม่ใช่การเปิดดู");

  // เปิดห้องจริง
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/conversations/Useen/messages?limit=50", headers: { cookie: owner.cookie },
  })).status, 200);
  const afterSeen = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.equal(afterSeen.json.events.length, 0, "เปิดดูแล้วต้องเคลียร์ ไม่ต้องรอให้ตอบ");

  // ลูกค้าทักมาอีกหลังเปิดดูไปแล้ว ต้องกลับเข้าคิวทันที
  await sleep(5);
  const again = webhookBody("seen-2", "Useen");
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers: { ...headers, "x-line-signature": signLine(again, "test-line-secret") }, body: again })).status, 200);
  await waitFor(() => db.unansweredCustomers(0, 50).length === 1);
  const reopened = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.deepEqual(reopened.json.events.map((e) => e.url), ["/console/#/c/Useen"]);
});

test("เปิดลูกแพรให้ตอบเอง: ยังเด้งทุกข้อความ แต่คิวไม่บวมค้างทั้งวัน", async (t) => {
  const { app, db, pushCalls } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  // ลูกค้า 3 คนทัก และลูกแพรตอบให้ครบทุกคน (agentMode ai, ไม่มีชื่อผู้ใช้)
  for (let i = 0; i < 3; i += 1) {
    const raw = webhookBody(`ai-${i}`, `Uai${i}`);
    const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
    assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  }
  await waitFor(() => pushCalls.length === 3, 4000);
  for (let i = 0; i < 3; i += 1) {
    db.insertMessage({
      customerId: `Uai${i}`, direction: "out", msgType: "text",
      content: "ลูกแพรตอบให้แล้วค่ะ", messageClass: "reactive", agentMode: "ai",
    });
  }
  // ลูกแพรตอบแล้วแต่ยังไม่มีใครดู → ยังต้องเด้ง (พี่ง้วงสั่ง "ทุกแชทควรมี noti")
  assert.equal(db.unansweredCustomers(0, 50).length, 3, "AI ตอบแล้วแต่ยังไม่มีใครดู = ยังต้องเด้ง");

  // พี่ง้วงไล่เปิดดูทีละห้อง คิวต้องหดลงจริง ไม่ค้างสะสมจนบวม
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await httpRequest(app.server, {
      path: `/console/api/conversations/Uai${i}/messages?limit=50`, headers: { cookie: owner.cookie },
    })).status, 200);
  }
  const cleared = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.equal(cleared.json.events.length, 0, "ไล่ดูครบแล้วคิวต้องว่าง ไม่ค้างยาว 12 ชั่วโมง");
});

test("ลูกค้าพิมพ์ #online ที่ลูกแพรไม่ตอบ ต้องยังเด้งและเปิดห้องได้", async (t) => {
  const { app, db, pushCalls } = await startConsole(t);
  const owner = await login(app.server);
  await postJson(app.server, "/console/api/push/subscribe", {
    endpoint: "https://fcm.googleapis.com/fcm/send/owner-phone",
  }, owner);

  // ตัวยิงแจ้งเตือนอยู่ที่ชั้น webhook (server.mjs) ซึ่งทำงานก่อนตัวจัดการ '#'
  // ในไปป์ไลน์ ดังนั้นต่อให้ลูกแพรเงียบไม่ตอบเลย แอดมินก็ยังต้องรู้ว่ามีคนกดเข้ามา
  // นี่คือเหตุผลที่ #contact ถูกออกแบบให้ "ไม่ปิด AI" — เผื่อลูกค้ามือลั่น
  const raw = webhookBody("hashtag", "Uhashtag", "#online");
  const headers = { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") };
  assert.equal((await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers, body: raw })).status, 200);
  await waitFor(() => pushCalls.length === 1, 4000);
  await waitFor(() => db.unansweredCustomers(0, 50).length === 1);

  const pending = await httpRequest(app.server, { path: "/console/api/push/pending", headers: { cookie: owner.cookie } });
  assert.deepEqual(pending.json.events.map((e) => e.url), ["/console/#/c/Uhashtag"]);
  // ข้อความที่ลูกค้าพิมพ์ต้องไม่โผล่บนหน้าจอล็อก แม้จะเป็นแค่ #online
  assert.ok(!pending.text.includes("#online"), "เนื้อความลูกค้าต้องไม่ออกไปกับการแจ้งเตือน");
});

test("service worker is a narrowly-scoped no-store static asset with push and click handlers", async (t) => {
  const { app } = await startConsole(t);
  const sw = await httpRequest(app.server, { path: "/console/sw.js" });
  assert.equal(sw.status, 200);
  assert.equal(sw.headers["service-worker-allowed"], "/console/");
  assert.match(sw.headers["cache-control"], /no-store/u);
  assert.match(sw.text, /showNotification/u);
  assert.match(sw.text, /notificationclick/u);
  assert.match(sw.text, /candidate\.origin === self\.location\.origin/u);
  assert.doesNotMatch(sw.text, /LINE_CHANNEL|VAPID_PRIVATE|customerId/u);
});
