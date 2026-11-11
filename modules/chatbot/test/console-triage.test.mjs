// console-triage — คิว "รอตอบ" หน้าแชท = รายการหน้าภาพรวม · ปุ่มสแปม (= ป้าย null) · ข้อมูลหัวห้อง (28 ก.ย. 2026)
//
// คำขอพี่ง้วง: "tab รอตอบนานกว่า 24 ชม. (tab นี้กับหน้านี้ให้เหมือนกัน จะได้คุยง่าย ๆ)" · "ทำระบบ spam ลูกค้า
// เพื่อ screen คนออกจาก inbox" · "spam = null chat tag" — เทสต์นี้ยิง HTTP จริงผ่านเซิร์ฟเวอร์ทั้งตัว
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { generateKeyPairSync } from "node:crypto";
import { createConfig } from "../src/config.mjs";
import { createWebPushService } from "../src/webPush.mjs";
import { createEscalationNotifier } from "../src/notify.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PASSWORD = "triage-pass-123";
const silent = { log() {}, warn() {}, error() {} };

function clockDb() {
  let fixed = null;
  const db = memoryDb({ now: () => fixed ?? Date.now() });
  const at = (ms, fn) => { fixed = ms; try { return fn(); } finally { fixed = null; } };
  return { db, at };
}

function seed(db, at) {
  const now = Date.now();
  const room = (id, { score = null, channel = "default" } = {}) => {
    at(now - 40 * DAY, () => db.upsertCustomer(id, { displayName: `ชื่อ ${id}`, channelId: channel }));
    if (score != null) at(now - 40 * DAY + MIN, () => db.recordScore(id, score, "{}"));
  };
  const msg = (id, direction, ago, content, extra = {}) => at(now - ago, () => db.insertMessage({ customerId: id, direction, content, ...extra }));
  room("W-money", { score: 6 });
  msg("W-money", "in", 30 * HOUR, "โอนแล้วนะคะ");
  at(now - 30 * HOUR, () => db.setAiEnabled("W-money", false, "bank_sent"));
  room("W-hot", { score: 9 });
  msg("W-hot", "in", 3 * DAY, "สนใจคอนซัลค่ะ รบกวนติดต่อกลับ");
  room("W-fb", { channel: "facebook" });
  msg("W-fb", "in", 2 * DAY, "ขอรายละเอียดคลาสออนไลน์ค่ะ");
  room("W-recent");
  msg("W-recent", "in", 2 * HOUR, "Stage 4");
  at(now - 2 * HOUR, () => db.setAiEnabled("W-recent", false, "manual"));
  room("X-thumbs");
  msg("X-thumbs", "in", 5 * DAY, "(thumbs up)(hands together)");
  room("X-other", { score: 2 });
  msg("X-other", "in", 2 * DAY, "สวัสดีค่ะ");
  msg("X-other", "out", 2 * DAY - MIN, "สวัสดีค่ะ ลูกแพรยินดีให้ข้อมูลค่ะ", { agentMode: "ai" });
}

async function start(t) {
  const { db, at } = clockDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), role: "owner" });
  db.createOperator({ username: "staff", passHash: hashPassword(PASSWORD), role: "operator" });
  seed(db, at);
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "triage-secret-0123456789" }), db,
    overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, at };
}

async function login(server, username = "owner") {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

const get = async (server, auth, path) => (await httpRequest(server, { path, headers: { cookie: auth.cookie } })).json;
const post = (server, auth, path, body, { csrf = true } = {}) => httpRequest(server, {
  method: "POST", path,
  headers: { "content-type": "application/json", cookie: auth.cookie, ...(csrf ? { "x-csrf-token": auth.csrf } : {}) },
  body: JSON.stringify(body),
});
const ids = (list) => list.map((row) => row.line_user_id ?? row.id);

test("ชิปรอตอบ = รายการหน้าภาพรวมทุกห้อง ทุกลำดับ ทุกตัวเลข · ค้าง >24 ชม. = เซ็ตย่อย", async (t) => {
  const { app } = await start(t);
  const auth = await login(app.server);
  const overview = await get(app.server, auth, "/console/api/overview/attention?limit=20");
  const chip = await get(app.server, auth, "/console/api/inbox?segment=waiting");
  assert.deepEqual(ids(chip.conversations), ids(overview.waiting.rooms), "ลำดับเดียวกันเป๊ะ");
  assert.deepEqual(ids(chip.conversations), ["W-money", "W-hot", "W-fb", "W-recent"]);
  assert.equal(chip.counts.waiting, overview.waiting.total);
  assert.equal(chip.counts.waiting24, overview.waiting.over24);
  assert.deepEqual(chip.waitingOrder, ids(overview.waiting.rooms), "ลำดับทั้งคิวสำหรับปุ่มห้องถัดไป");
  // ตัวเลขบนชิปเท่ากันไม่ว่าเปิดชิปไหนอยู่
  const all = await get(app.server, auth, "/console/api/inbox");
  assert.equal(all.counts.waiting, 4);
  assert.equal(all.waitingOrder, undefined, "ชิปอื่นไม่ต้องแบกลำดับคิว");
  const long = await get(app.server, auth, "/console/api/inbox?segment=waiting24");
  assert.deepEqual(ids(long.conversations), ["W-money", "W-hot", "W-fb"], "W-recent เพิ่งรอ 2 ชม.");
  assert.equal(long.counts.waiting24, 3);
  // แถวในคิวบอกเวลารอ · มูลค่า · Facebook ตอบไม่ได้แล้ว · AI ปิดเพราะใคร
  const byId = new Map(chip.conversations.map((row) => [row.line_user_id, row]));
  assert.equal(byId.get("W-money").waiting.value, "money");
  assert.equal(byId.get("W-money").ai_off.by, "system");
  assert.equal(byId.get("W-recent").ai_off.by, "human");
  assert.equal(byId.get("W-fb").waiting.fbReplyClosed, true);
  assert.equal(byId.get("W-hot").waiting.fbReplyClosed, false);
  assert.ok(!ids(chip.conversations).includes("X-thumbs"), "LINE emoji ล้วนไม่ใช่เรื่องให้ตอบ");
  // หน้าละ 2 แถว + โหลดต่อ = ลำดับเดิม ไม่ซ้ำ
  const p1 = await get(app.server, auth, "/console/api/inbox?segment=waiting&limit=2");
  const p2 = await get(app.server, auth, "/console/api/inbox?segment=waiting&limit=2&offset=2");
  assert.equal(p1.hasMore, true);
  assert.equal(p2.hasMore, false);
  assert.deepEqual([...ids(p1.conversations), ...ids(p2.conversations)], ["W-money", "W-hot", "W-fb", "W-recent"]);
  // ค้นหาในคิว = กรองในลำดับคิว
  const search = await get(app.server, auth, `/console/api/inbox?segment=waiting&q=${encodeURIComponent("W-fb")}`);
  assert.deepEqual(ids(search.conversations), ["W-fb"]);
  assert.deepEqual(search.waitingOrder, ["W-fb"], "ค้นหาในคิว = ห้องถัดไปเดินตามผลค้น (รีวิวโค้ด 28 ก.ย.)");
});

test("สแปม: ป้าย null ผ่านเส้นเดียวกับแผงป้าย · AI ปิด (โดยคน) · หายจากทุกชิป/ตัวเลข/หน้าภาพรวม · audit", async (t) => {
  const { app, db } = await start(t);
  const auth = await login(app.server, "staff");
  const before = await get(app.server, auth, "/console/api/inbox");
  const res = await post(app.server, auth, "/console/api/customers/W-hot/spam", { spam: true });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.spam, true);
  assert.ok(res.json.tags.some((row) => row.tag === "null"));
  assert.equal(res.json.triage.spam, true);
  assert.equal(res.json.triage.aiOff.by, "human", "สแปม = คนตัดสินปิด (ม่วง)");
  const customer = db.getCustomer("W-hot");
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, "not_a_customer");
  const actions = db.listAudit().filter((row) => row.target === "W-hot").map((row) => row.action);
  for (const action of ["spam_marked", "tag_add", "ai_off_customer_handover"]) assert.ok(actions.includes(action), action);
  // หายจากทุก segment ปกติ และตัวเลขทุกตัว
  for (const segment of ["", "hot", "cold", "warm", "needs", "aioff", "notqualify", "resolved", "mine", "customer", "waiting", "waiting24"]) {
    const list = await get(app.server, auth, `/console/api/inbox${segment ? `?segment=${segment}` : ""}`);
    assert.ok(!ids(list.conversations).includes("W-hot"), `segment ${segment || "all"} ต้องไม่มีห้องสแปม`);
  }
  const after = await get(app.server, auth, "/console/api/inbox");
  assert.equal(after.counts.all, before.counts.all - 1);
  assert.equal(after.counts.hot, before.counts.hot - 1);
  assert.equal(after.counts.waiting, before.counts.waiting - 1);
  assert.equal(after.counts.spam, 1);
  const spamList = await get(app.server, auth, "/console/api/inbox?segment=spam");
  assert.deepEqual(ids(spamList.conversations), ["W-hot"]);
  const overview = await get(app.server, auth, "/console/api/overview/attention");
  assert.ok(!ids(overview.waiting.rooms).includes("W-hot"));
  assert.ok(!ids(overview.hotQuiet.rooms).includes("W-hot"));
  // กดซ้ำ = ไม่ติดป้ายซ้ำ ไม่ audit ซ้ำ
  const again = await post(app.server, auth, "/console/api/customers/W-hot/spam", { spam: true });
  assert.equal(again.json.already, true);
  assert.equal(db.listAudit().filter((row) => row.target === "W-hot" && row.action === "spam_marked").length, 1);
});

test("ไม่ใช่สแปม: ถอดป้าย null ทุกตัวพิมพ์ · AI ยังปิดจนกว่าคนกดเปิด · กลับเข้าคิว · audit", async (t) => {
  const { app, db } = await start(t);
  const auth = await login(app.server);
  db.addTag("W-fb", "Null", "human");
  db.addTag("W-fb", "NULL", "human");
  db.setAiEnabled("W-fb", false, "not_a_customer");
  assert.ok(!ids((await get(app.server, auth, "/console/api/inbox?segment=waiting")).conversations).includes("W-fb"),
    "ป้าย null ที่ติดไว้ก่อนมีปุ่มสแปม = สแปมด้วย");
  const res = await post(app.server, auth, "/console/api/customers/W-fb/spam", { spam: false });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.spam, false);
  assert.equal(res.json.aiEnabled, false, "ถอนสแปมไม่เปิด AI คืนเอง");
  assert.ok(!db.listTags("W-fb").some((row) => row.tag.toLowerCase() === "null"));
  assert.equal(db.getCustomer("W-fb").ai_enabled, 0);
  assert.ok(db.listAudit().some((row) => row.target === "W-fb" && row.action === "spam_unmarked"));
  const queue = await get(app.server, auth, "/console/api/inbox?segment=waiting");
  assert.ok(ids(queue.conversations).includes("W-fb"), "กลับเข้าคิวรอตอบ");
});

test("ติดป้าย null จากแผงป้าย = สแปมเหมือนกดปุ่ม (กติกาเดียว)", async (t) => {
  const { app } = await start(t);
  const auth = await login(app.server);
  const res = await post(app.server, auth, "/console/api/customers/W-recent/tags", { add: "null" });
  assert.equal(res.status, 200, res.text);
  const queue = await get(app.server, auth, "/console/api/inbox?segment=waiting");
  assert.ok(!ids(queue.conversations).includes("W-recent"));
  assert.equal(queue.counts.spam, 1);
});

test("เส้นสแปม: ต้องมี CSRF · spam ต้องเป็น boolean · ห้องต้องมีจริง · method POST เท่านั้น", async (t) => {
  const { app } = await start(t);
  const auth = await login(app.server);
  assert.equal((await post(app.server, auth, "/console/api/customers/W-hot/spam", { spam: true }, { csrf: false })).status, 403);
  assert.equal((await post(app.server, auth, "/console/api/customers/W-hot/spam", { spam: "yes" })).status, 400);
  assert.equal((await post(app.server, auth, "/console/api/customers/U-nobody/spam", { spam: true })).status, 404);
  const wrong = await httpRequest(app.server, { path: "/console/api/customers/W-hot/spam", headers: { cookie: auth.cookie } });
  assert.equal(wrong.status, 405);
  const segment = await httpRequest(app.server, { path: "/console/api/inbox?segment=nope", headers: { cookie: auth.cookie } });
  assert.equal(segment.status, 400);
});

test("หัวห้องแชท: รอตอบไหม · สแปมไหม · AI ปิดเพราะใคร · Facebook เกิน 24 ชม. · ปิดเคสแล้วลูกค้าทักกลับ = รอตอบอีกครั้ง", async (t) => {
  const { app, db, at } = await start(t);
  const auth = await login(app.server);
  const room = async (id) => (await get(app.server, auth, `/console/api/conversations/${id}/messages?seen=0`)).triage;
  const fb = await room("W-fb");
  assert.equal(fb.waiting.fbReplyClosed, true);
  assert.equal(fb.fbReplyClosed, true);
  assert.equal(fb.spam, false);
  assert.equal(fb.aiOff, null, "AI เปิด = ไม่มีป้ายปิด");
  assert.equal((await room("W-money")).aiOff.by, "system");
  assert.equal((await room("X-other")).waiting, null, "ลูกแพรตอบแล้ว = ไม่รอ");
  // ✓ เสร็จสิ้น → หลุดคิว · ลูกค้าทักกลับมา → กลับเข้าคิว ทั้งที่สถานะยัง RESOLVED
  assert.equal((await post(app.server, auth, "/console/api/customers/W-hot/resolve", { resolved: true })).status, 200);
  assert.equal((await room("W-hot")).waiting, null);
  assert.ok(!ids((await get(app.server, auth, "/console/api/inbox?segment=waiting")).conversations).includes("W-hot"));
  // เวลาผ่านไป: กดปิดเคสเมื่อ 20 นาทีก่อน แล้วลูกค้าทักกลับมาเมื่อ 10 นาทีก่อน (เกินช่วงผ่อนผัน 3 นาทีแล้ว)
  db.raw.prepare("UPDATE customers SET resolved_at = ? WHERE line_user_id = 'W-hot'").run(Date.now() - 20 * MIN);
  at(Date.now() - 10 * MIN, () => db.insertMessage({ customerId: "W-hot", direction: "in", content: "ขอเบอร์ติดต่อหน่อยค่ะ" }));
  const back = await room("W-hot");
  assert.ok(back.waiting, "ทักกลับหลังปิดเคส = รอตอบอีกครั้ง");
  assert.equal(db.getCustomer("W-hot").state, "RESOLVED");
  assert.ok(ids((await get(app.server, auth, "/console/api/inbox?segment=waiting")).conversations).includes("W-hot"));
});

function pushConfig() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return createConfig({
    WEB_PUSH_ENABLED: "true", WEB_PUSH_VAPID_PUBLIC_KEY: publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: jwk.d,
    WEB_PUSH_VAPID_SUBJECT: "https://admin.example.com",
  });
}

test("สแปมไม่ปลุกทีม: web push ข้าม · รายการรอแจ้งไม่นับ · สรุปเจ้าของไม่นับ · บันไดทวงไม่นับ", async (t) => {
  const { db, at } = clockDb();
  seed(db, at);
  db.setNeedsHuman("W-hot", "human_requested", "[human_requested] ลูกค้าขอคุยกับคน");
  db.addTag("W-hot", "null", "human");
  const push = createWebPushService({ db, config: pushConfig(), fetchImpl: async () => new Response(null, { status: 201 }), logger: silent });
  t.after(() => db.close());
  assert.equal(push.status().available, true);
  assert.deepEqual(await push.fire({ customerId: "W-hot" }), { skipped: "spam" }, "ลูกค้าสแปมทักมา = ไม่ปลุกมือถือทีม");
  assert.deepEqual(await push.fire({ customerId: "W-fb" }), { skipped: "no_active_subscriptions" }, "ห้องปกติเดินเส้นเดิม");
  assert.ok(db.isSpamCustomer("W-hot"));
  assert.ok(!db.unansweredCustomers(Date.now() - 30 * DAY, 50).some((row) => row.customer_id === "W-hot"));
  assert.ok(db.unansweredCustomers(Date.now() - 30 * DAY, 50).some((row) => row.customer_id === "W-fb"), "ห้องปกติยังเด้ง");
  assert.ok(!db.digestWaitingRooms(20).some((row) => row.customerId === "W-hot"));
  assert.ok(!db.listNeedsHumanSlaCandidates().some((row) => row.line_user_id === "W-hot"));
  // แจ้งเตือนทีมทาง LINE: สแปมไม่ปลุก · วิกฤตสุขภาพจิตยังปลุกเสมอ (กดสแปมผิดคนต้องไม่ทำให้เคสวิกฤตเงียบ)
  const notifier = createEscalationNotifier({ db, config: {}, logger: silent });
  assert.deepEqual(await notifier.fire({ customerId: "W-hot", reason: "human_requested" }), { skipped: "spam" });
  assert.deepEqual(await notifier.fire({ customerId: "W-hot", reason: "urgent_mental" }), { skipped: "no_recipients" },
    "วิกฤตสุขภาพจิตผ่านด่านสแปม (ไปติดแค่ไม่มีผู้รับในเทสต์นี้)");
});
