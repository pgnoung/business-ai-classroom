// broadcast-studio.test.mjs — สตูดิโอบรอดแคสต์ (28 ก.ย. 2026)
// ทุกการยิง LINE ในไฟล์นี้วิ่งเข้า stub (LINE_MOCK_URL) — ไม่มี network จริง
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { buildBroadcastMessages, guardTextOf, findUrls, safeLinkUrl } from "../src/broadcastMessages.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createLineSendRecorder, SEND_PURPOSE } from "../src/lineSendLedger.mjs";
import { groupTagsByDimension } from "../src/consoleBroadcastStudioApi.mjs";
import {
  aggregationUnitFor, createLinkCollector, isLinkToken, narrowcastPayload, normalizeStudioTarget, trackingBaseUrl,
} from "../src/broadcastStudio.mjs";
import { hermesFetchStub, httpRequest, listen, memoryDb, poisonGlobalFetch, signLine, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "studio-owner-pass-1";
const SESSION_SECRET = "broadcast-studio-console-secret-0123456789";
const REQUEST_ID = "0b4a3e8f-1d2c-4e5f-8a9b-0c1d2e3f4a5b";

/* ------------------------------ LINE stub ------------------------------ */

function studioLineStub({
  quota = { type: "limited", value: 10_000 }, consumption = { totalUsage: 1_000 },
  followers = { status: "ready", followers: 900, targetedReaches: 600, blocks: 100 },
  audiences = [], progress = null, broadcastStatus = 200, narrowcastStatus = 202, insight = null,
} = {}) {
  const posts = [];
  const gets = [];
  const headers = (map = {}) => ({ get: (name) => map[String(name).toLowerCase()] ?? null });
  const fn = async (url, opts = {}) => {
    const u = String(url);
    if ((opts.method || "GET") === "GET") {
      gets.push(u);
      if (u.includes("/v2/bot/message/quota/consumption")) return { ok: true, status: 200, headers: headers(), json: async () => consumption };
      if (u.includes("/v2/bot/message/quota")) return { ok: true, status: 200, headers: headers(), json: async () => quota };
      if (u.includes("/v2/bot/insight/followers")) return { ok: true, status: 200, headers: headers(), json: async () => followers };
      if (u.includes("/v2/bot/audienceGroup/list")) {
        return { ok: true, status: 200, headers: headers(), json: async () => ({ audienceGroups: audiences, hasNextPage: false }) };
      }
      if (u.includes("/v2/bot/message/progress/narrowcast")) {
        return progress ? { ok: true, status: 200, headers: headers(), json: async () => progress } : { ok: false, status: 404, headers: headers(), json: async () => ({}) };
      }
      if (u.includes("/v2/bot/insight/message/event")) {
        return insight ? { ok: true, status: 200, headers: headers(), json: async () => insight } : { ok: false, status: 404, headers: headers(), json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: headers(), json: async () => ({}) };
    }
    const body = opts.body ? JSON.parse(opts.body) : null;
    posts.push({ url: u, body, headers: opts.headers || {} });
    if (u.endsWith("/v2/bot/message/broadcast")) {
      const status = typeof broadcastStatus === "function" ? broadcastStatus() : broadcastStatus;
      if (status === "throw") throw new Error("socket hang up");
      return { ok: status >= 200 && status < 300, status, headers: headers({ "x-line-request-id": REQUEST_ID }), json: async () => ({}) };
    }
    if (u.endsWith("/v2/bot/message/narrowcast")) {
      const status = typeof narrowcastStatus === "function" ? narrowcastStatus() : narrowcastStatus;
      return { ok: status >= 200 && status < 300, status, headers: headers({ "x-line-request-id": REQUEST_ID }), json: async () => ({}) };
    }
    return { ok: true, status: 200, headers: headers({ "x-line-request-id": REQUEST_ID }), json: async () => ({}) };
  };
  fn.posts = posts;
  fn.gets = gets;
  return fn;
}

/* ------------------------------ app helpers ------------------------------ */

async function start(t, { stub = studioLineStub(), configEnv = {}, role = "owner" } = {}) {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), displayName: "เจ้าของ", role: "owner" });
  db.createOperator({ username: "staffer", passHash: hashPassword(PASSWORD), displayName: "ทีมงาน", role: "operator" });
  for (const [id, tags] of [
    ["U-ai-1", ["สนใจ: AI Agent for Business"]],
    ["U-ai-2", ["สนใจ: AI Agent for Business", "ซื้อครั้งที่: 1"]],
    ["U-ai-3", ["สนใจ: AI Agent for Business", "customer"]],
    ["U-excel", ["สนใจ: Excel"]],
    ["U-spam", ["สนใจ: AI Agent for Business", "null"]],
  ]) {
    db.upsertCustomer(id, { channelId: "default", displayName: id });
    for (const tag of tags) db.addTag(id, tag, "human");
  }
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_SECRET, MEDIA_PUBLIC_BASE_URL: "https://studio.example", ...configEnv }),
    db, logger: silent,
    overrides: { lineFetch: stub, hermesFetch: hermesFetchStub(), sleep: async () => {} },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const auth = await login(app.server, role === "owner" ? "owner" : "staffer");
  return { app, db, stub, auth };
}

async function login(server, username) {
  const response = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 200, response.text);
  return { cookie: (response.headers["set-cookie"]?.[0] || "").split(";", 1)[0], csrf: response.json.csrf };
}

const post = (server, path, auth, body) => httpRequest(server, {
  method: "POST", path,
  headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const get = (server, path, auth) => httpRequest(server, { path, headers: { cookie: auth.cookie } });

async function waitFor(check, { timeoutMs = 2_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function previewAndSend(server, auth, payload) {
  const preview = await post(server, "/console/api/broadcast/studio/preview", auth, payload);
  assert.equal(preview.status, 200, preview.text);
  const send = await post(server, "/console/api/broadcast/studio/send", auth, {
    ...payload, confirm: true, confirmText: preview.json.summary.expectedConfirmText,
    studioConfirmation: preview.json.studioConfirmation,
  });
  return { preview, send };
}

/* ------------------------------ message builder ------------------------------ */

test("builder: สติกเกอร์ต้องอยู่ในชุดที่อนุมัติ · การ์ดประกอบเป็น Flex ครบ + altText อัตโนมัติ", () => {
  const catalog = new Map([["hero", { key: "hero", url: "https://img.example/hero.jpg" }], ["http_only", { key: "http_only", url: "http://img.example/x.jpg" }]]);
  const ok = buildBroadcastMessages([
    { type: "sticker", packageId: "11537", stickerId: "52002734" },
    {
      type: "card", cards: [
        { imageKey: "hero", title: "คลาสใหม่เดือนหน้า", text: "สมัครล่วงหน้าได้แล้ว", buttons: [
          { label: "ดูรายละเอียด", kind: "uri", uri: "https://pngoung.example/class" },
          { label: "สนใจ", kind: "message", text: "สนใจคลาสค่ะ" },
        ] },
        { title: "คลาสออนไลน์", text: "เรียนที่บ้านได้" },
      ],
    },
  ], { imageCatalogByKey: catalog });
  assert.equal(ok.error, undefined, ok.error);
  assert.deepEqual(ok.messages[0], { type: "sticker", packageId: "11537", stickerId: "52002734" });
  const flex = ok.messages[1];
  assert.equal(flex.type, "flex");
  assert.equal(flex.altText, "[การ์ด] คลาสใหม่เดือนหน้า");
  assert.equal(flex.contents.type, "carousel");
  assert.equal(flex.contents.contents[0].hero.url, "https://img.example/hero.jpg");
  assert.equal(flex.contents.contents[0].footer.contents[0].action.uri, "https://pngoung.example/class");
  assert.deepEqual(flex.contents.contents[0].footer.contents[1].action, { type: "message", label: "สนใจ", text: "สนใจคลาสค่ะ" });
  assert.deepEqual(ok.stored[1].cards[1], { imageKey: "", title: "คลาสออนไลน์", text: "เรียนที่บ้านได้", buttons: [] });

  const refuse = (messages, pattern, label) => {
    const result = buildBroadcastMessages(messages, { imageCatalogByKey: catalog });
    assert.match(String(result.error || ""), pattern, label);
  };
  refuse([{ type: "sticker", packageId: "446", stickerId: "1988" }], /สติกเกอร์/u, "สติกเกอร์นอกชุด");
  refuse([{ type: "card", cards: [{}] }], /อย่างน้อยหนึ่ง/u, "การ์ดว่าง");
  refuse([{ type: "card", cards: [{ title: "x", buttons: [{ label: "ไป", kind: "uri", uri: "javascript:alert(1)" }] }] }], /https/u, "ลิงก์ไม่ปลอดภัย");
  refuse([{ type: "card", cards: [{ title: "x", buttons: [{ label: "ไป", kind: "uri", uri: "http://plain.example" }] }] }], /https/u, "ปุ่มต้อง https");
  refuse([{ type: "card", cards: [{ title: "x", buttons: Array.from({ length: 4 }, () => ({ label: "ก", kind: "message", text: "ก" })) }] }], /ไม่เกิน 3/u, "เกิน 3 ปุ่ม");
  refuse([{ type: "card", cards: [{ imageKey: "http_only", title: "x" }] }], /https/u, "รูปในการ์ดต้อง https");
  refuse([{ type: "card", cards: Array.from({ length: 11 }, () => ({ title: "x" })) }], /ไม่เกิน 10/u, "เกิน 10 ใบ");
  refuse([{ type: "video", url: "https://x" }], /ไม่รองรับ/u, "ชนิดอื่น");
});

test("builder: ลิงก์ในข้อความ/ปุ่มถูกแปลงเป็นลิงก์นับคลิก · ไม่กลืนภาษาไทยท้ายลิงก์ · ทรงที่เก็บยังเป็นลิงก์เดิม", () => {
  const collector = createLinkCollector("https://studio.example");
  const built = buildBroadcastMessages([
    { type: "text", text: "ดูคลาสที่ https://pngoung.example/a?x=1ครับ และ https://pngoung.example/b." },
    { type: "card", cards: [{ title: "ปุ่ม", buttons: [{ label: "เปิด", kind: "uri", uri: "https://pngoung.example/c" }] }] },
  ], { linkTracker: collector.tracker });
  assert.equal(built.error, undefined, built.error);
  assert.equal(collector.links.length, 3);
  assert.deepEqual(collector.links.map((link) => link.url), [
    "https://pngoung.example/a?x=1", "https://pngoung.example/b", "https://pngoung.example/c",
  ]);
  for (const link of collector.links) assert.ok(isLinkToken(link.token), "token ตัวอักษรล้วน 12 ตัว");
  const [first, second] = collector.links;
  assert.equal(built.messages[0].text, `ดูคลาสที่ https://studio.example/r/${first.token}ครับ และ https://studio.example/r/${second.token}.`);
  assert.equal(built.messages[1].contents.footer.contents[0].action.uri, `https://studio.example/r/${collector.links[2].token}`);
  assert.equal(built.stored[0].text, "ดูคลาสที่ https://pngoung.example/a?x=1ครับ และ https://pngoung.example/b.");
  assert.equal(built.stored[1].cards[0].buttons[0].uri, "https://pngoung.example/c");
  assert.deepEqual(findUrls("ไม่มีลิงก์"), []);
  assert.equal(safeLinkUrl("https://user:pw@evil.example"), "", "ห้ามลิงก์ที่มี credential");
  assert.equal(trackingBaseUrl({ mediaPublicBaseUrl: "http://insecure.example" }), "", "ฐานลิงก์ต้องเป็น https");
  assert.equal(createLinkCollector("").tracker, null, "ไม่มีฐาน = ไม่นับคลิก");
  assert.match(aggregationUnitFor("broadcast", "8d9c0f5e-1234-4abc-8def-0123456789ab"), /^[A-Za-z0-9_]{1,30}$/u);
  assert.match(aggregationUnitFor("step", "8d9c0f5e-1234-4abc-8def-0123456789ab", 7), /^[A-Za-z0-9_]{1,30}$/u);
});

test("guard: การ์ดตรวจทั้งใบรวมกัน — ราคาในข้อความที่ไม่ได้อนุมัติถูกบล็อก", () => {
  const guard = createComplianceGuard({ getApprovedPrices: () => [{ label: "คลาส", amount: 9900 }] });
  const built = buildBroadcastMessages([
    { type: "card", cards: [{ title: "ราคาพิเศษ", text: "เหลือเพียง 5,900 บาท" }] },
  ]);
  const text = guardTextOf(built.messages[0]);
  assert.match(text, /ราคาพิเศษ/u);
  assert.equal(guard.checkOutbound(text).ok, false, "5,900 ไม่อยู่ในตาราง");
  const approved = buildBroadcastMessages([{ type: "card", cards: [{ title: "ราคาคลาส", text: "9,900 บาท" }] }]);
  assert.equal(guard.checkOutbound(guardTextOf(approved.messages[0])).ok, true);
});

/* ------------------------------ targets + helpers ------------------------------ */

test("target: กลุ่มเป้าหมาย/ข้อมูลประชากร → ทรง narrowcast ตามเอกสาร LINE (ครบหรือไม่ส่งเลย)", () => {
  const audience = normalizeStudioTarget("audience", { include: [111, "222", -1], exclude: [333, 111] });
  assert.deepEqual(audience.target, { include: [111, 222], exclude: [333] });
  assert.deepEqual(narrowcastPayload("audience", audience.target), {
    recipient: {
      type: "operator",
      and: [
        { type: "operator", or: [{ type: "audience", audienceGroupId: 111 }, { type: "audience", audienceGroupId: 222 }] },
        { type: "operator", not: { type: "audience", audienceGroupId: 333 } },
      ],
    },
    filter: null,
    limit: { upToRemainingQuota: true, forbidPartialDelivery: true },
  });
  assert.ok(normalizeStudioTarget("audience", { include: [] }).error);
  assert.ok(normalizeStudioTarget("audience", { include: Array.from({ length: 11 }, (_, i) => i + 1) }).error);
  const demo = normalizeStudioTarget("demographic", {
    gender: ["female"], age: { gte: "age_25", lt: "age_45" }, area: ["th_01", "xx_99"], appType: ["ios", "android"],
  });
  assert.deepEqual(demo.target, { gender: ["female"], age: { gte: "age_25", lt: "age_45" }, area: ["th_01"] },
    "เลือกครบทุกค่า (ios+android) = ไม่กรอง · ค่าที่ไม่รู้จักถูกทิ้ง");
  assert.deepEqual(narrowcastPayload("demographic", demo.target).filter, {
    demographic: {
      type: "operator",
      and: [
        { type: "gender", oneOf: ["female"] },
        { type: "age", gte: "age_25", lt: "age_45" },
        { type: "area", oneOf: ["th_01"] },
      ],
    },
  });
  assert.ok(normalizeStudioTarget("demographic", { age: { gte: "age_40", lt: "age_20" } }).error, "ช่วงกลับด้าน");
  assert.ok(normalizeStudioTarget("demographic", {}).error, "ไม่มีเงื่อนไข");
});

test("ป้าย: จัดกลุ่มตามมิติ 'มิติ: ค่า' เอง ไม่ hard-code · ซ่อนสแปม/ห้องย้ายระบบ", () => {
  const groups = groupTagsByDimension([
    { tag: "สนใจ: AI Agent for Business", customer_count: 5 }, { tag: "สนใจ: Excel", customer_count: 2 },
    { tag: "ขั้น: ถามราคา", customer_count: 3 }, { tag: "customer", customer_count: 4 }, { tag: "null", customer_count: 9 },
    { tag: "ย้ายจาก LINE OA", customer_count: 900 }, { tag: "VIP", customer_count: 1 },
  ]);
  assert.deepEqual(groups.map((g) => g.dimension), ["สนใจ", "ขั้น", ""]);
  assert.deepEqual(groups[0].tags.map((t) => t.value), ["AI Agent for Business", "Excel"]);
  assert.equal(groups[0].wildcard, "สนใจ:*");
  assert.deepEqual(groups[2].tags.map((t) => t.tag), ["customer", "VIP"]);
});

/* ------------------------------ audience rules ------------------------------ */

test("กลุ่มผู้รับ: สแปม (null) กับคนที่บล็อก OA ถูกตัดเสมอ ทั้งตัวนับและตัวส่ง · ทั้งมิติ/ยังไม่ซื้อ", () => {
  const db = memoryDb();
  const add = (id, tags) => { db.upsertCustomer(id, {}); for (const tag of tags) db.addTag(id, tag, "human"); };
  add("U1", ["สนใจ: AI"]); add("U2", ["สนใจ: AI", "NULL"]); add("U3", ["สนใจ: Excel", "ซื้อครั้งที่: 2"]);
  add("U4", ["สนใจ: AI"]); add("U5", ["สนใจ: AI", "Customer"]);
  db.recordLineFollow({ customerId: "U4", followed: false });
  const ids = (options) => db.broadcastAudience({ channelId: "default", ...options }).map((c) => c.line_user_id).sort();
  assert.deepEqual(ids({ includeTags: ["สนใจ: AI"] }), ["U1", "U5"]);
  assert.deepEqual(ids({ includeTags: ["สนใจ:*"], excludeTags: ["customer", "ซื้อครั้งที่:*"] }), ["U1"],
    "ยังไม่ซื้อ = ตัด customer (ไม่สนตัวพิมพ์) + ทุกค่าของ ซื้อครั้งที่");
  assert.equal(db.broadcastAudienceCount({ channelId: "default", includeTags: ["สนใจ:*"] }), 3);
  assert.deepEqual(ids({ includeTags: ["*"] }), ["U1", "U3", "U5"], "* = ทุกคนที่ส่งถึงได้ (ยังตัดสแปม/บล็อก)");
  db.recordLineFollow({ customerId: "U4", followed: true, unblocked: true });
  assert.deepEqual(ids({ includeTags: ["สนใจ: AI"] }), ["U1", "U4", "U5"], "เลิกบล็อกแล้วกลับมาได้รับ");
  db.close();
});

/* ------------------------------ LINE client ------------------------------ */

test("lineClient: push/broadcast/narrowcast ส่งทรงที่ถูก + บันทึกบัญชีการส่ง + โหมดนำร่องปิดการส่งทั้ง OA", async () => {
  const db = memoryDb();
  const stub = studioLineStub();
  const client = createLineClient({
    config: testConfig(), fetchImpl: stub, logger: silent, onSend: createLineSendRecorder({ db, logger: silent }),
  });
  const messages = [{ type: "text", text: "สวัสดีค่ะ" }];
  const push = await client.pushMessages({ to: "Uself", messages, aggregationUnit: "lkp_test", purpose: SEND_PURPOSE.stepMessage });
  assert.equal(push.ok, true);
  assert.deepEqual(stub.posts[0].body, { to: "Uself", messages, customAggregationUnits: ["lkp_test"] });
  const broadcast = await client.broadcastMessages({ messages, retryKey: REQUEST_ID, notificationDisabled: true });
  assert.equal(broadcast.ok, true);
  assert.equal(broadcast.requestId, REQUEST_ID, "เก็บ X-Line-Request-Id ไว้ถามสถิติ");
  assert.equal(stub.posts[1].headers["x-line-retry-key"], REQUEST_ID);
  assert.deepEqual(stub.posts[1].body, { messages, notificationDisabled: true });
  const narrow = await client.narrowcast({ messages, recipient: { type: "audience", audienceGroupId: 5 }, limit: { upToRemainingQuota: true } });
  assert.equal(narrow.ok, true);
  assert.equal(stub.posts[2].url, "http://line.mock/v2/bot/message/narrowcast");
  assert.ok((await client.pushMessages({ to: "U", messages, aggregationUnit: "bad-name!" })).blocked, "ชื่อหน่วยสถิติผิดกติกา");
  const rows = db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" })
    .map((r) => ({ method: r.method, purpose: r.purpose, recipients: r.recipients, counts: r.counts_quota }));
  assert.deepEqual(rows.sort((a, b) => a.method.localeCompare(b.method)), [
    { method: "broadcast", purpose: "broadcast", recipients: 0, counts: 1 },
    { method: "narrowcast", purpose: "broadcast", recipients: 0, counts: 1 },
    { method: "push", purpose: "step_message", recipients: 1, counts: 1 },
  ]);
  const pilot = createLineClient({
    config: testConfig(), fetchImpl: stub, logger: silent, outboundAllowed: ({ to }) => to === "Ukept",
  });
  assert.equal((await pilot.broadcastMessages({ messages })).reason, "pilot_mode_blocks_broadcast");
  assert.equal((await pilot.narrowcast({ messages })).reason, "pilot_mode_blocks_broadcast");
  db.close();
});

/* ------------------------------ studio API ------------------------------ */

test("studio meta: ป้ายจัดกลุ่มตามมิติ + ชุด 'ยังไม่ซื้อ' + เพื่อนประมาณจากสถิติ LINE (followers − blocks)", async (t) => {
  const { app, auth } = await start(t);
  const meta = await get(app.server, "/console/api/broadcast/studio/meta?channel=default", auth);
  assert.equal(meta.status, 200, meta.text);
  assert.equal(meta.json.canSend, true);
  assert.equal(meta.json.canTestSend, true);
  assert.ok(meta.json.tagGroups.some((group) => group.dimension === "สนใจ" && group.wildcard === "สนใจ:*"));
  assert.ok(!JSON.stringify(meta.json.tagGroups).includes("\"null\""), "สแปมไม่อยู่ในตัวเลือก");
  assert.equal(meta.json.presets[0].key, "not_purchased");
  assert.deepEqual(meta.json.followers.reach, 800);
  assert.equal(meta.json.tracking.enabled, true);
  assert.equal(meta.json.reachableKnown, 4, "สแปมไม่ถูกนับ");
  assert.doesNotMatch(meta.text, /U-ai-1/u, "ไม่มี id ลูกค้าในคำตอบ");
});

test("studio ตามป้าย: preview → send → multicast มีหน่วยสถิติ + ลิงก์นับคลิก · คลิกผ่าน /r/ นับรวม (บอทไม่นับ)", async (t) => {
  const { app, db, stub, auth } = await start(t);
  const payload = {
    channelId: "default", mode: "tags", includeTags: ["สนใจ:*"], excludeTags: ["customer", "ซื้อครั้งที่:*"],
    messages: [
      { type: "text", text: "คลาสใหม่มาแล้วค่ะ ดูที่ https://pngoung.example/next" },
      { type: "sticker", packageId: "11537", stickerId: "52002735" },
    ],
  };
  const { preview, send } = await previewAndSend(app.server, auth, payload);
  assert.equal(preview.json.summary.estimate, 2, "U-ai-1 + U-excel (ตัดคนซื้อ/สแปม)");
  assert.equal(preview.json.summary.expectedConfirmText, "2");
  assert.equal(send.status, 200, send.text);
  const id = send.json.broadcast.id;
  await waitFor(() => db.getBroadcast(id)?.status === "done");
  const multicast = stub.posts.find((call) => call.url.endsWith("/v2/bot/message/multicast"));
  assert.ok(multicast, "ส่งผ่าน multicast");
  assert.deepEqual(multicast.body.to.sort(), ["U-ai-1", "U-excel"]);
  assert.match(multicast.body.customAggregationUnits[0], /^lkp_b_[A-Za-z0-9]+$/u);
  const token = /\/r\/([A-Za-z]{12})/u.exec(multicast.body.messages[0].text)?.[1];
  assert.ok(token, "ลิงก์ในข้อความถูกแปลงเป็นลิงก์นับคลิก");
  assert.equal(multicast.body.messages[1].type, "sticker");
  const history = db.messagesFor("U-ai-1").map((m) => `${m.msg_type}:${m.content}`);
  assert.ok(history.includes("sticker:[sticker]"), "ห้องแชทเห็นสติกเกอร์ที่บรอดแคสต์ไป");

  const click = (ua) => httpRequest(app.server, { path: `/r/${token}`, headers: { "user-agent": ua } });
  const bot = await click("facebookexternalhit/1.1;line-poker/1.0");
  assert.equal(bot.status, 302);
  assert.equal(bot.headers.location, "https://pngoung.example/next");
  const human = await click("Mozilla/5.0 (iPhone) Line/14.0");
  assert.equal(human.status, 302);
  await click("Mozilla/5.0 (iPhone) Line/14.0"); // คลิกซ้ำเครื่องเดิมใน 10 วิ = ครั้งเดียว
  assert.equal(db.trackedLinks("broadcast", id)[0].clicks, 1, "นับเฉพาะคนจริง ครั้งเดียว");
  assert.equal((await httpRequest(app.server, { path: "/r/AAAAAAAAAAAA" })).status, 404);
  assert.equal((await httpRequest(app.server, { path: "/r/../../etc" })).status, 404);

  const detail = await get(app.server, `/console/api/broadcast/studio/campaigns/${id}`, auth);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.campaign.mode, "tags");
  assert.equal(detail.json.campaign.clicks, 1);
  assert.equal(detail.json.campaign.links[0].url, "https://pngoung.example/next");
  assert.equal(detail.json.campaign.outcomes.basis, "recipients");
  assert.doesNotMatch(detail.text, /U-ai-1|U-excel/u, "ไม่มี id ลูกค้าในผลลัพธ์");
});

test("studio: ใบยืนยันต้องตรง · พิมพ์ยืนยันผิด = ไม่ส่ง · staff ไม่มี broadcast.send ส่งไม่ได้", async (t) => {
  const { app, db, auth } = await start(t);
  const payload = { channelId: "default", mode: "tags", includeTags: ["สนใจ: Excel"], messages: [{ type: "text", text: "สวัสดีค่ะ" }] };
  const preview = await post(app.server, "/console/api/broadcast/studio/preview", auth, payload);
  const wrongText = await post(app.server, "/console/api/broadcast/studio/send", auth, {
    ...payload, confirm: true, confirmText: "999", studioConfirmation: preview.json.studioConfirmation,
  });
  assert.equal(wrongText.status, 400);
  const changedMessage = await post(app.server, "/console/api/broadcast/studio/send", auth, {
    ...payload, messages: [{ type: "text", text: "ข้อความอื่น" }], confirm: true, confirmText: "1",
    studioConfirmation: preview.json.studioConfirmation,
  });
  assert.equal(changedMessage.status, 400);
  assert.match(changedMessage.json.error, /ใบยืนยัน/u);
  assert.equal(db.listBroadcasts().length, 0, "ทุกด่านทำงานก่อนสร้างงานส่ง");
});

test("studio: staff (ไม่มีสิทธิ์ส่ง) ดู meta/ประมาณผู้รับได้ แต่ preview-send/ทดสอบ ไม่ได้", async (t) => {
  const { app } = await start(t);
  const staff = await login(app.server, "staffer");
  // staff ในคอนโซลนี้มี broadcast.send ตามตารางสิทธิ์ (คำสั่งพี่ง้วง 25 ส.ค.) แต่ส่งทดสอบถึงตัวเองได้เฉพาะ Owner/Admin
  const meta = await get(app.server, "/console/api/broadcast/studio/meta", staff);
  assert.equal(meta.status, 200);
  assert.equal(meta.json.canTestSend, false);
  const testSend = await post(app.server, "/console/api/broadcast/studio/test", staff, {
    channelId: "default", confirm: true, messages: [{ type: "text", text: "ทดสอบ" }],
  });
  assert.equal(testSend.status, 403);
});

test("studio เพื่อนทุกคน: ใช้ broadcast API + retry key · เก็บเลขคำขอ · ส่งไม่ได้ถ้าอ่านจำนวนเพื่อนไม่ได้หรือโควตาไม่พอ", async (t) => {
  const { app, db, stub, auth } = await start(t);
  const payload = { channelId: "default", mode: "all", messages: [{ type: "text", text: "ประกาศถึงเพื่อนทุกคนค่ะ" }], notificationDisabled: true };
  const { preview, send } = await previewAndSend(app.server, auth, payload);
  assert.equal(preview.json.summary.estimate, 800);
  assert.equal(preview.json.summary.estimateKind, "line_estimate");
  assert.equal(send.status, 200, send.text);
  const id = send.json.broadcast.id;
  await waitFor(() => db.getBroadcast(id)?.status === "done");
  const call = stub.posts.find((c) => c.url.endsWith("/v2/bot/message/broadcast"));
  assert.ok(call);
  assert.match(call.headers["x-line-retry-key"], /^[0-9a-f-]{36}$/u);
  assert.equal(call.body.notificationDisabled, true);
  const campaign = db.getBroadcastCampaign(id);
  assert.equal(campaign.mode, "all");
  assert.equal(campaign.line_request_id, REQUEST_ID);
  assert.equal(campaign.line_phase, "accepted");
  assert.equal(db.listUnresolvedBroadcastDeliveryQuarantines({ channel: "default" }).length, 0, "ด่านก่อนส่งถูกปิดหลังรู้ผล");

  const noFollowers = await start(t, { stub: studioLineStub({ followers: { status: "unready" } }) });
  const blocked = await post(noFollowers.app.server, "/console/api/broadcast/studio/preview", noFollowers.auth, payload);
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /จำนวนเพื่อน/u);

  const tight = await start(t, { stub: studioLineStub({ quota: { type: "limited", value: 1_000 }, consumption: { totalUsage: 900 } }) });
  const overQuota = await post(tight.app.server, "/console/api/broadcast/studio/preview", tight.auth, payload);
  assert.equal(overQuota.status, 400);
  assert.match(overQuota.json.error, /โควตา/u);
});

test("studio เพื่อนทุกคน: LINE ตอบไม่ชัด = quarantine กันทุกการส่งของ OA (รวมตามป้าย) จนเจ้าของตรวจผล", async (t) => {
  const { app, db, auth } = await start(t, { stub: studioLineStub({ broadcastStatus: 503 }) });
  const payload = { channelId: "default", mode: "all", messages: [{ type: "text", text: "ประกาศค่ะ" }] };
  const { send } = await previewAndSend(app.server, auth, payload);
  assert.equal(send.status, 200, send.text);
  const id = send.json.broadcast.id;
  await waitFor(() => db.getBroadcast(id)?.status === "failed");
  const [quarantine] = db.listUnresolvedBroadcastDeliveryQuarantines({ channel: "default" });
  assert.ok(quarantine, "ต้องค้าง quarantine");
  assert.equal(db.getBroadcastCampaign(id).line_phase, "unknown");

  const again = await post(app.server, "/console/api/broadcast/studio/preview", auth, {
    channelId: "default", mode: "tags", includeTags: ["สนใจ: Excel"], messages: [{ type: "text", text: "ตามป้าย" }],
  });
  const confirmText = again.json.summary.expectedConfirmText;
  // cooldown 60 วิ ยังไม่หมด — ปลดด้วยการเลื่อนเวลาแถวเดิมไปก่อนหน้า (ทดสอบเฉพาะด่าน quarantine)
  db.raw.prepare("UPDATE broadcasts SET created_at = created_at - 120000").run();
  const blocked = await post(app.server, "/console/api/broadcast/studio/send", auth, {
    channelId: "default", mode: "tags", includeTags: ["สนใจ: Excel"], messages: [{ type: "text", text: "ตามป้าย" }],
    confirm: true, confirmText, studioConfirmation: again.json.studioConfirmation,
  });
  assert.equal(blocked.status, 409, blocked.text);
  assert.match(blocked.json.error, /ยืนยันไม่ได้/u);

  const list = await get(app.server, "/console/api/broadcast/quarantines?channel=default", auth);
  assert.equal(list.json.quarantines[0].lineSide, true);
  const resolution = "confirmed_delivered";
  const resolved = await post(app.server, `/console/api/broadcast/quarantines/${quarantine.id}/resolve`, auth, {
    resolution, reason: "ตรวจใน OA Manager แล้วว่าส่งออกไป", confirmation: `RESOLVE:${quarantine.id}:${resolution}`,
  });
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(db.getBroadcast(id).status, "done");
  assert.equal(db.getBroadcastCampaign(id).line_phase, "confirmed_delivered");
  assert.equal(db.listUnresolvedBroadcastDeliveryQuarantines({ channel: "default" }).length, 0);
});

test("studio กลุ่มเป้าหมาย: รายการจาก LINE ติดชนิด/ที่มา · narrowcast ครบหรือไม่ส่ง · ความคืบหน้าอัปเดตยอดส่งจริง", async (t) => {
  const audiences = [
    { audienceGroupId: 1001, type: "CHAT_TAG", createRoute: "OA_MANAGER", description: "แท็ก สนใจคลาส", status: "READY", audienceCount: 320, created: 1_700_000_000, permission: "READ" },
    { audienceGroupId: 1002, type: "UPLOAD", createRoute: "MESSAGING_API", description: "กำลังอัปโหลด", status: "IN_PROGRESS", audienceCount: 0, created: 1_700_000_000, permission: "READ_WRITE" },
  ];
  const stub = studioLineStub({
    audiences,
    progress: { phase: "succeeded", successCount: 301, failureCount: 4, targetCount: 305, acceptedTime: "2026-09-28T03:00:00.000Z" },
    insight: { overview: { requestId: REQUEST_ID, delivered: 301, uniqueImpression: 150, uniqueClick: 22 }, messages: [], clicks: [] },
  });
  const { app, db, auth } = await start(t, { stub });
  const list = await get(app.server, "/console/api/broadcast/studio/audiences?channel=default", auth);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.groups[0].typeLabel, "แท็กแชท (OA Manager)");
  assert.equal(list.json.groups[0].usable, true);
  assert.equal(list.json.groups[1].usable, false);

  const notReady = await post(app.server, "/console/api/broadcast/studio/preview", auth, {
    channelId: "default", mode: "audience", target: { include: [1002] }, messages: [{ type: "text", text: "x" }],
  });
  assert.equal(notReady.status, 409);
  assert.match(notReady.json.error, /READY/u);

  const payload = { channelId: "default", mode: "audience", target: { include: [1001] }, messages: [{ type: "text", text: "ถึงคนที่สนใจคลาสค่ะ" }] };
  const { preview, send } = await previewAndSend(app.server, auth, payload);
  assert.equal(preview.json.summary.estimate, 320);
  assert.equal(send.status, 200, send.text);
  const id = send.json.broadcast.id;
  await waitFor(() => db.getBroadcast(id)?.status === "done");
  const call = stub.posts.find((c) => c.url.endsWith("/v2/bot/message/narrowcast"));
  assert.deepEqual(call.body.recipient, { type: "audience", audienceGroupId: 1001 });
  assert.deepEqual(call.body.limit, { upToRemainingQuota: true, forbidPartialDelivery: true });

  const detail = await get(app.server, `/console/api/broadcast/studio/campaigns/${id}?refresh=1`, auth);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.campaign.line.phase, "succeeded");
  assert.equal(detail.json.campaign.line.successCount, 301);
  assert.equal(detail.json.campaign.sentCount, 301);
  assert.equal(detail.json.campaign.insight.overview.uniqueClick, 22);
  assert.equal(detail.json.campaign.outcomes.basis, "unknown_recipients");
  const ledger = db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" }).filter((r) => r.method === "narrowcast");
  assert.equal(ledger.reduce((s, r) => s + r.recipients, 0), 301, "บัญชีการส่งปรับเป็นยอดจริงครั้งเดียว");
  await get(app.server, `/console/api/broadcast/studio/campaigns/${id}?refresh=1`, auth);
  assert.equal(db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" }).filter((r) => r.method === "narrowcast")
    .reduce((s, r) => s + r.recipients, 0), 301, "ไม่ปรับซ้ำ");
});

test("studio ข้อมูลประชากร: ไม่มีเงื่อนไข = ปฏิเสธ · เพื่อนที่ระบุได้ < 100 = ปฏิเสธก่อนถึง LINE", async (t) => {
  const small = await start(t, { stub: studioLineStub({ followers: { status: "ready", followers: 120, targetedReaches: 60, blocks: 5 } }) });
  const none = await post(small.app.server, "/console/api/broadcast/studio/preview", small.auth, {
    channelId: "default", mode: "demographic", target: {}, messages: [{ type: "text", text: "x" }],
  });
  assert.equal(none.status, 400);
  const tooSmall = await post(small.app.server, "/console/api/broadcast/studio/preview", small.auth, {
    channelId: "default", mode: "demographic", target: { gender: ["female"] }, messages: [{ type: "text", text: "x" }],
  });
  assert.equal(tooSmall.status, 409);
  assert.match(tooSmall.json.error, /100/u);
  assert.equal(small.stub.posts.length, 0, "ไม่มีคำขอส่งถึง LINE");
});

test("studio ส่งทดสอบ: ต้องยืนยัน LINE ทดสอบของตัวเองก่อน · ส่งทุกบับเบิลในคำขอเดียวถึงปลายทางนั้นเท่านั้น", async (t) => {
  const { app, stub, auth } = await start(t);
  const body = { channelId: "default", confirm: true, messages: [{ type: "text", text: "ทดสอบการ์ด" }, { type: "card", cards: [{ title: "หัวข้อ" }] }] };
  const before = await post(app.server, "/console/api/broadcast/studio/test", auth, body);
  assert.equal(before.status, 409);
  const challenge = await post(app.server, "/console/api/broadcast/self-test/challenge", auth, { channelId: "default" });
  assert.equal(challenge.status, 201, challenge.text);
  const raw = JSON.stringify({ events: [{
    type: "message", webhookEventId: "evt-self", replyToken: "rt-self", source: { type: "user", userId: "U-owner-phone" },
    message: { id: "m-self", type: "text", text: challenge.json.challenge },
  }] });
  const hook = await httpRequest(app.server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") }, body: raw,
  });
  assert.equal(hook.status, 200);
  const sent = await post(app.server, "/console/api/broadcast/studio/test", auth, body);
  assert.equal(sent.status, 200, sent.text);
  const push = stub.posts.filter((c) => c.url.endsWith("/v2/bot/message/push")).at(-1);
  assert.equal(push.body.to, "U-owner-phone");
  assert.match(push.headers["x-line-retry-key"], /^[0-9a-f-]{36}$/u, "ส่งทดสอบมี retry key กันเครื่องตัวเองได้ซ้ำ");
  assert.equal(push.body.messages.length, 2);
  assert.equal(push.body.messages[1].type, "flex");
  const spoof = await post(app.server, "/console/api/broadcast/studio/test", auth, { ...body, to: "U-someone-else" });
  assert.equal(spoof.status, 400, "กำหนดผู้รับเองไม่ได้");
});

test("รีวิวโค้ด: โหมดฝั่ง LINE บอกจำนวนห้องที่ตัดออกไม่ได้ก่อนยืนยัน · ตามป้ายตัดให้ครบจึงไม่มีคำเตือนนี้", async (t) => {
  const { app, db, auth } = await start(t);
  db.setDoNotDisturb("U-excel", true);
  db.raw.prepare("UPDATE customers SET marketing_consent = -1 WHERE line_user_id = 'U-ai-1'").run();
  const all = await post(app.server, "/console/api/broadcast/studio/preview", auth, { channelId: "default", mode: "all", messages: [{ type: "text", text: "ประกาศค่ะ" }] });
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(all.json.summary.unprotected, { dnd: 1, optout: 1, spam: 1, total: 3 });
  assert.match(all.json.summary.warnings.join(" "), /LINE เป็นคนเลือกผู้รับ.*3 ห้อง/u);
  const tags = await post(app.server, "/console/api/broadcast/studio/preview", auth, {
    channelId: "default", mode: "tags", includeTags: ["สนใจ:*"], excludeTags: [], messages: [{ type: "text", text: "ประกาศค่ะ" }],
  });
  assert.equal(tags.status, 200, tags.text);
  assert.equal(tags.json.summary.unprotected, null);
  assert.doesNotMatch(tags.json.summary.warnings.join(" "), /LINE เป็นคนเลือกผู้รับ/u);
});

test("รีวิวโค้ด: เพื่อนทุกคนกันโควตาเผื่อเพื่อนใหม่หลังสถิติ (2% อย่างน้อย 20) — /broadcast ห้ามส่งไม่ครบไม่ได้", async (t) => {
  const payload = { channelId: "default", mode: "all", messages: [{ type: "text", text: "ประกาศค่ะ" }] };
  const tight = await start(t, { stub: studioLineStub({ quota: { type: "limited", value: 10_000 }, consumption: { totalUsage: 9_190 } }) });
  const refused = await post(tight.app.server, "/console/api/broadcast/studio/preview", tight.auth, payload);
  assert.equal(refused.status, 400, "เหลือ 810 แต่ต้องกัน 800 + 20");
  assert.match(refused.json.error, /โควตา/u);
  const enough = await start(t, { stub: studioLineStub({ quota: { type: "limited", value: 10_000 }, consumption: { totalUsage: 9_100 } }) });
  const ok = await post(enough.app.server, "/console/api/broadcast/studio/preview", enough.auth, payload);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.summary.estimate, 800, "ตัวเลขที่ให้พิมพ์ยืนยันยังเป็นยอดประมาณจริง");
});

test("รีวิวโค้ด: เขียนด่านก่อนส่งไม่ได้ (DB พัง) = งานจบเป็น failed ทันที ไม่เรียก LINE และไม่ค้าง quarantine", async (t) => {
  const { app, db, stub, auth } = await start(t);
  db.armLineSideGuard = () => { throw new Error("disk I/O error"); };
  const { send } = await previewAndSend(app.server, auth, { channelId: "default", mode: "all", messages: [{ type: "text", text: "ประกาศค่ะ" }] });
  assert.equal(send.status, 200, send.text);
  const id = send.json.broadcast.id;
  await waitFor(() => db.getBroadcast(id)?.status === "failed");
  assert.equal(stub.posts.filter((c) => c.url.endsWith("/v2/bot/message/broadcast")).length, 0);
  assert.equal(db.listUnresolvedBroadcastDeliveryQuarantines({ channel: "default" }).length, 0);
});

test("webhook follow/unfollow → สถานะเพื่อน · คนที่บล็อกหลุดจากกลุ่มผู้รับทันที", async (t) => {
  const { app, db } = await start(t);
  const send = (event) => {
    const raw = JSON.stringify({ events: [event] });
    return httpRequest(app.server, {
      method: "POST", path: "/webhooks/line",
      headers: { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") }, body: raw,
    });
  };
  assert.equal((await send({ type: "unfollow", webhookEventId: "w-unf", timestamp: Date.now(), source: { type: "user", userId: "U-excel" } })).status, 200);
  assert.equal(db.lineFollowState("U-excel").state, "unfollowed");
  assert.equal(db.broadcastAudience({ channelId: "default", includeTags: ["สนใจ: Excel"] }).length, 0);
  await send({ type: "follow", webhookEventId: "w-fol", timestamp: Date.now(), follow: { isUnblocked: true }, source: { type: "user", userId: "U-excel" } });
  const state = db.lineFollowState("U-excel");
  assert.equal(state.state, "followed");
  assert.equal(state.unblocked, 1);
  assert.equal(db.broadcastAudience({ channelId: "default", includeTags: ["สนใจ: Excel"] }).length, 1);
});
