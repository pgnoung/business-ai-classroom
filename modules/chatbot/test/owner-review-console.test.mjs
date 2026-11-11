// owner-review-console — API ห้องตรวจของพี่ง้วง (#/owner-review) + สิทธิ์ + แจ้งเตือนถึงเจ้าของคนเดียว (12 ต.ค. 2026 ค่ำ)
//   · owner/admin/staff (closes.confirm) เข้าได้ · staff เห็นเฉพาะสาขาที่ได้รับมอบ · ต้อง CSRF ทุก POST
//   · รายละเอียด = 8 ข้อความล่าสุด ปิดชื่อ/เบอร์ · ชื่อลูกค้าแบบย่อเท่านั้น · ข้อความลาที่จะส่งแสดงก่อนกด
//   · ปลุกมือถือเฉพาะเครื่องของ owner · /push/pending ของ owner มี "รอยืนยันปิด N ห้อง" (ทีมไม่มี) · ไม่มีข้อมูลลูกค้าในรายการแจ้งเตือน
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { createConsoleOwnerReviewRoutes, maskDisplayName, ownerReviewAccess } from "../src/consoleOwnerReviewApi.mjs";
import { canAccessConsoleRoute, capabilitiesForRole } from "../src/operatorRoles.mjs";
import { QUALIFY_SWEEP_MODE_KEY } from "../src/notQualified.mjs";
import { offtopicFallbackText } from "../src/offtopicClose.mjs";
import { hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";
import { bkk } from "./ownerReviewFixture.mjs";

poisonGlobalFetch();
const PASSWORD = "owner-review-console-pass";
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const ROOM = `U${"f8".repeat(16)}`;

function vapidFixture() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"),
    privateKey: jwk.d,
  };
}

async function start(t) {
  const keys = vapidFixture();
  const db = memoryDb();
  for (const [username, role] of [["nok", "owner"], ["admin", "admin"], ["chom", "operator"]]) {
    db.createOperator({ username, passHash: hashPassword(PASSWORD), displayName: username, role });
  }
  const pushCalls = [];
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig({
      CONSOLE_SESSION_SECRET: "owner-review-console-session-secret-0123",
      WEB_PUSH_ENABLED: "true", WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
      WEB_PUSH_VAPID_SUBJECT: "https://shop.example.com",
    }),
    db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch, sleep: async () => {},
      webPushFetch: async (url) => { pushCalls.push(String(url)); return new Response(null, { status: 201 }); },
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, pushCalls, lineFetch };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

const get = (server, path, auth) => httpRequest(server, { path, headers: { cookie: auth.cookie } });
const post = (server, path, body, auth, { csrf = true } = {}) => httpRequest(server, {
  method: "POST", path, body: JSON.stringify(body),
  headers: { "content-type": "application/json", cookie: auth.cookie, ...(csrf ? { "x-csrf-token": auth.csrf } : {}) },
});

function seedProposal(db, { id = ROOM, name = "สมชาย ใจดีมาก" } = {}) {
  db.upsertCustomer(id, { displayName: name });
  db.insertMessage({ customerId: id, direction: "out", content: "สวัสดีค่ะ ลูกแพรดูแลคลาสเรียน AI ค่ะ", agentMode: "ai" });
  const inbound = String(db.insertMessage({ customerId: id, direction: "in", content: "ผม สมชาย ใจดีมาก โทร 0812345678 ขอยืมเงินหน่อยครับ" }));
  const proposal = db.insertOwnerCloseProposal({ customerId: id, source: "cue_luna", category: "ask_money", cue: "ask_money",
    aiReason: "ขอยืมเงินจากเรา", baselineInboundId: inbound });
  return { proposal, inbound };
}

test("สิทธิ์: closes.confirm ของ owner/admin/staff · เส้น owner-review อยู่ในรายการเส้นของ staff · /me เปิดเมนู", async (t) => {
  for (const role of ["owner", "admin", "operator"]) assert.ok(capabilitiesForRole(role).includes("closes.confirm"), role);
  assert.equal(canAccessConsoleRoute({ role: "operator" }, ["owner-review", "summary"]), true);
  const { app } = await start(t);
  for (const username of ["nok", "admin", "chom"]) {
    const auth = await login(app.server, username);
    const me = await get(app.server, "/console/api/me", auth);
    assert.equal(me.json.features.ownerReview, true, username);
    assert.equal((await get(app.server, "/console/api/owner-review/summary", auth)).status, 200, username);
  }
  assert.equal((await httpRequest(app.server, { path: "/console/api/owner-review/summary" })).status, 401);
});

test("summary + รายการ + รายละเอียด: ตัวเลข/แท็บ/สวิตช์ · ชื่อย่อ · ข้อความปิดชื่อ/เบอร์ · ข้อความลาที่จะส่ง · จุดอ้างอิงสำหรับยืนยัน", async (t) => {
  const { app, db } = await start(t);
  const { proposal, inbound } = seedProposal(db);
  const auth = await login(app.server, "nok");
  const summary = await get(app.server, "/console/api/owner-review/summary", auth);
  assert.equal(summary.json.mode, "on");
  assert.equal(summary.json.scope, "all");
  assert.equal(summary.json.sweepOn, false, "ตัวกวาดยังไม่ on — หน้าเว็บต้องเตือน");
  assert.equal(summary.json.offtopicMode, "propose");
  assert.equal(summary.json.counts.pending, 1);
  // เฟส B (คิวตรวจแชทรายวัน 20:00) เปิดแล้ว — แท็บที่สองใช้ได้ · ยังไม่มีรอบ = ไม่มีห้องค้าง
  assert.deepEqual(summary.json.tabs.map((tab) => [tab.key, tab.available]), [["close", true], ["daily", true]]);
  assert.equal(summary.json.tabs[1].count, 0);
  assert.deepEqual(summary.json.scanTimes, ["09:00", "12:00", "15:00", "19:00"]);
  assert.equal(summary.json.undoMs, 10_000);

  const list = await get(app.server, "/console/api/owner-review/proposals?view=open", auth);
  assert.equal(list.status, 200);
  assert.equal(list.json.rows.length, 1);
  const item = list.json.rows[0];
  assert.equal(item.id, proposal.id);
  assert.equal(item.categoryLabel, "ขอเงิน/ขอยืมเงินจากเรา/ขอบริจาค");
  assert.equal(item.customer.displayNameMasked, maskDisplayName("สมชาย ใจดีมาก"));
  assert.equal(item.customer.displayName, "สมชาย ใจดีมาก", "หน้าห้องตรวจแสดงชื่อเต็มเหมือนหน้าแชท");
  // ชื่อเต็มอยู่ได้เฉพาะช่อง customer.displayName (เหมือนหน้าแชท) · เบอร์โทรไม่หลุดเลย
  assert.doesNotMatch(JSON.stringify(list.json), /0812345678/u);
  assert.equal((await get(app.server, "/console/api/owner-review/proposals?view=weird", auth)).status, 400);

  const detail = await get(app.server, `/console/api/owner-review/proposals/${proposal.id}`, auth);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.latestInboundId, inbound);
  assert.equal(detail.json.customerTypedSinceBaseline, false);
  assert.equal(detail.json.goodbyeText, offtopicFallbackText("ask_money"));
  assert.deepEqual(detail.json.messages.map((m) => m.speaker), ["ลูกแพร", "ลูกค้า"]);
  assert.doesNotMatch(JSON.stringify(detail.json.messages), /สมชาย ใจดีมาก|0812345678/u, "ชื่อ/เบอร์ในเนื้อข้อความยังถูกปิด");
  assert.doesNotMatch(JSON.stringify(detail.json), /0812345678/u);
  assert.equal(detail.json.room.canSendGoodbye, true);
  assert.equal((await get(app.server, "/console/api/owner-review/proposals/not-a-real-id", auth)).status, 404);
});

test("ตัดสินผ่าน API: ต้อง CSRF · ตัวกวาดไม่ on = 409 sweep_not_on (ไม่ส่ง) · ยืนยันแล้ว = ส่งคำลา + เหลือง · กดซ้ำ = 409", async (t) => {
  const { app, db, lineFetch } = await start(t);
  const { proposal, inbound } = seedProposal(db);
  const auth = await login(app.server, "chom");
  const path = `/console/api/owner-review/proposals/${proposal.id}/decide`;
  const body = { action: "confirm", seenMessageId: inbound, revision: 0 };
  assert.equal((await post(app.server, path, body, auth, { csrf: false })).status, 403);
  const refused = await post(app.server, path, body, auth);
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "sweep_not_on");
  assert.equal(lineFetch.sends.length, 0);
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  const current = db.ownerCloseProposal(proposal.id);
  const ok = await post(app.server, path, { ...body, revision: current.revision }, auth);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.proposal.status, "confirmed");
  assert.equal(ok.json.proposal.decidedBy, "chom");
  assert.equal(lineFetch.sends.length, 1);
  assert.match(lineFetch.sends[0].url, /\/v2\/bot\/message\/push$/u);
  assert.deepEqual(lineFetch.sends[0].body.messages.map((m) => m.text), [offtopicFallbackText("ask_money")]);
  assert.equal(db.getCustomer(ROOM).ai_off_reason, "not_qualified");
  const again = await post(app.server, path, { ...body, revision: current.revision }, auth);
  assert.equal(again.status, 409);
  assert.equal(lineFetch.sends.length, 1);
  const decided = await get(app.server, "/console/api/owner-review/proposals?view=decided", auth);
  assert.deepEqual(decided.json.rows.map((row) => row.status), ["confirmed"]);
});

test("ไม่ปิด + ย้อนผ่าน API", async (t) => {
  const { app, db } = await start(t);
  const { proposal } = seedProposal(db);
  const auth = await login(app.server, "admin");
  const rejected = await post(app.server, `/console/api/owner-review/proposals/${proposal.id}/decide`,
    { action: "reject", reason: "ลูกค้าเก่า", revision: 0 }, auth);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.proposal.status, "rejected");
  assert.ok(rejected.json.undoUntil > 0);
  const undone = await post(app.server, `/console/api/owner-review/proposals/${proposal.id}/undo`,
    { revision: rejected.json.proposal.revision }, auth);
  assert.equal(undone.status, 200, undone.text);
  assert.equal(undone.json.proposal.status, "pending");
});

test("staff เห็นเฉพาะสาขาที่ได้รับมอบ (รายการ/รายละเอียด/ตัดสิน) · owner เห็นทุกสาขา", async () => {
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: "x", role: "owner" });
  db.createOperator({ username: "chom", passHash: "x", role: "operator" });
  db.grantOperatorChannel("chom", "a");
  const a = seedProposal(db, { id: "a:U1" });
  db.raw.prepare("UPDATE customers SET channel_id = 'a' WHERE line_user_id = 'a:U1'").run();
  const b = seedProposal(db, { id: "b:U2" });
  db.raw.prepare("UPDATE customers SET channel_id = 'b' WHERE line_user_id = 'b:U2'").run();
  const routes = createConsoleOwnerReviewRoutes({ db, channels: [{ id: "a", active: true }, { id: "b", active: true }],
    closeService: { decide: async () => ({ status: 200, body: { ok: true } }), undo: () => ({ status: 200, body: { ok: true } }) } });
  const call = async (username, method, path, body = {}) => {
    let payload = null;
    const url = new URL(`http://test/console/api/${path}`);
    const route = url.pathname.replace("/console/api/", "").split("/");
    await routes.handle({ method }, {}, url, route, {
      username, operator: db.getOperator(username), readJson: async () => body, requireCsrf: () => true,
      json: (_res, status, json) => { payload = { status, json }; },
    });
    return payload;
  };
  try {
    assert.deepEqual((await call("chom", "GET", "owner-review/proposals")).json.rows.map((row) => row.customerId), ["a:U1"]);
    assert.equal((await call("chom", "GET", `owner-review/proposals/${b.proposal.id}`)).status, 404);
    assert.equal((await call("chom", "POST", `owner-review/proposals/${b.proposal.id}/decide`, { action: "reject", revision: 0 })).status, 404);
    assert.equal((await call("chom", "GET", `owner-review/proposals/${a.proposal.id}`)).status, 200);
    assert.equal((await call("chom", "GET", "owner-review/summary")).json.counts.pending, 1);
    assert.equal((await call("nok", "GET", "owner-review/proposals")).json.rows.length, 2);
  } finally {
    db.close();
  }
});

test("แจ้งเตือนถึงเจ้าของคนเดียว: notifyOwner ปลุกเฉพาะเครื่องของ owner · /push/pending ของ owner มีรายการนับจำนวน ทีมไม่มี · เปิดห้องตรวจแล้วหาย", async (t) => {
  const { app, db, pushCalls } = await start(t);
  seedProposal(db);
  const devices = { nok: "https://fcm.googleapis.com/fcm/send/owner-phone", admin: "https://fcm.googleapis.com/fcm/send/admin-phone",
    chom: "https://updates.push.services.mozilla.com/wpush/v2/staff-phone" };
  const auth = {};
  for (const [username, endpoint] of Object.entries(devices)) {
    auth[username] = await login(app.server, username);
    assert.equal((await post(app.server, "/console/api/push/subscribe", { endpoint }, auth[username])).status, 201);
  }
  assert.deepEqual(db.activeOwnerWebPushSubscriptions().map((row) => row.operator_username), ["nok"]);
  const result = await app.webPush.notifyOwner({ kind: "close" });
  assert.equal(result.sent, 1);
  assert.deepEqual(pushCalls, [devices.nok], "ทีม/admin ไม่ถูกปลุก");
  const ownerPending = await get(app.server, "/console/api/push/pending", auth.nok);
  const item = ownerPending.json.events.find((event) => event.tag === "lukprae-owner-review");
  assert.ok(item);
  assert.equal(item.url, "/console/#/owner-review");
  assert.match(item.body, /รอยืนยันปิด 1 ห้อง/u);
  assert.doesNotMatch(JSON.stringify(ownerPending.json), /สมชาย|ขอยืมเงิน|0812345678/u);
  for (const username of ["admin", "chom"]) {
    const pending = await get(app.server, "/console/api/push/pending", auth[username]);
    assert.equal(pending.json.events.some((event) => event.tag === "lukprae-owner-review"), false, username);
  }
  await get(app.server, "/console/api/owner-review/summary", auth.nok);
  const after = await get(app.server, "/console/api/push/pending", auth.nok);
  assert.equal(after.json.events.some((event) => event.tag === "lukprae-owner-review"), false, "เปิดห้องตรวจแล้ว = เห็นแล้ว");
});

test("/health: มีสถานะห้องตรวจแบบตัวเลขรวม · ชื่อย่อของลูกค้า", async (t) => {
  const { app, db } = await start(t);
  seedProposal(db);
  const health = await httpRequest(app.server, { path: "/health" });
  assert.equal(health.json.components.ownerReview, "on");
  assert.equal(health.json.ownerReview.pending, 1);
  assert.doesNotMatch(JSON.stringify(health.json.ownerReview), /U[f8]{8}|สมชาย/u);
  assert.equal(maskDisplayName(""), "ลูกค้า");
  assert.equal(maskDisplayName("ก"), "ก•");
  assert.equal(maskDisplayName("สมชาย"), "ส•••ย");
});

test("ต่อสายจริง (createApp): รอบตรวจของแอปเสนอห้องจาก Luna ปลอม → ชมพู่ยืนยันผ่าน API → คำลาทาง push + ห้องเหลือง", async (t) => {
  const clock = { t: bkk(8, 0) };
  const db = memoryDb({ now: () => clock.t });
  db.createOperator({ username: "chom", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  db.upsertCustomer(ROOM, { displayName: "ลูกค้าทดสอบ" });
  db.insertMessage({ customerId: ROOM, direction: "out", content: "สวัสดีค่ะ ลูกแพรดูแลคลาสเรียน AI ค่ะ", agentMode: "ai" });
  clock.t = bkk(8, 30);
  const inbound = String(db.insertMessage({ customerId: ROOM, direction: "in", content: "พี่ครับ ขอยืมเงินหน่อยได้ไหมครับ" }));
  clock.t = bkk(9, 5);
  const keys = [];
  const hermesFetch = async (_url, opts = {}) => {
    const key = JSON.parse(opts.body).prompt_cache_key;
    keys.push(key);
    const content = key === "lukprae-hermes-offtopic" ? JSON.stringify({ close: true, category: "ask_money", reason: "ขอยืมเงินจากเรา" })
      : JSON.stringify({ propose: false, category: "", reason: "" });
    return { ok: true, status: 200, headers: { get: () => "" },
      json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 40 } }) };
  };
  const lineFetch = lineFetchStub();
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "owner-review-wiring-session-secret-0123" }), db, logger: silent,
    overrides: { hermesFetch, lineFetch, sleep: async () => {}, now: () => clock.t } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const run = await app.ownerReviewScheduler.runDue();
  assert.equal(run.status, "ready", JSON.stringify(run));
  assert.deepEqual(keys, ["lukprae-hermes-offtopic"], "ห้องที่เจอคำ = ดอกที่ 2 ครั้งเดียว ไม่มีคำขออื่น");
  const [proposal] = db.listOwnerCloseProposals({}).rows;
  assert.equal(proposal.source, "cue_luna");
  const auth = await login(app.server, "chom");
  const decided = await post(app.server, `/console/api/owner-review/proposals/${proposal.id}/decide`,
    { action: "confirm", seenMessageId: inbound, revision: proposal.revision }, auth);
  assert.equal(decided.status, 200, decided.text);
  assert.equal(decided.json.closed, true);
  assert.equal(lineFetch.sends.length, 1);
  assert.equal(db.getCustomer(ROOM).ai_off_reason, "not_qualified");
  const ledger = db.raw.prepare("SELECT method, purpose FROM line_send_ledger").all().map((row) => ({ ...row }));
  assert.deepEqual(ledger, [{ method: "push", purpose: "owner_close" }]);
});

test("staff ที่ยังไม่ได้รับมอบสาขาเลย = เห็นทุกสาขา (production 12 ต.ค. ชมพู่ไม่มีการมอบ) · มอบไม่ครบ = summary บอกช่องทางที่มองไม่เห็น", async () => {
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: "x", role: "owner" });
  db.createOperator({ username: "chom", passHash: "x", role: "operator" });
  const channels = [{ id: "default", active: true }, { id: "facebook", active: true }];
  const access = (username) => ownerReviewAccess({ db, username, operator: db.getOperator(username), channels });
  try {
    assert.equal(access("nok"), true);
    assert.equal(access("chom"), true, "ไม่มีการมอบสาขาเลย = เห็นทุกสาขาเหมือนกล่องแชท (พี่ง้วงให้ชมพู่ยืนยันปิดได้)");
    assert.equal(ownerReviewAccess({ db, username: "ghost", operator: null, channels }), false, "ไม่มีบัญชี/สิทธิ์ closes.confirm");
    assert.equal(ownerReviewAccess({ db, username: "chom", operator: db.getOperator("chom"), channels: [{ id: "default", active: true }] }), true,
      "ร้านช่องทางเดียว = ไม่จำกัดสาขา");
    db.grantOperatorChannel("chom", "default");
    assert.equal(access("chom"), true);
    const broken = { listOperatorChannels() { throw new Error("SQLITE_BUSY"); } };
    assert.equal(ownerReviewAccess({ db: broken, username: "chom", operator: db.getOperator("chom"), channels }), false, "อ่านไม่ได้ = ไม่เดา");

    const routes = createConsoleOwnerReviewRoutes({ db, channels, channelLabel: (id) => (id === "facebook" ? "Facebook" : "LINE"),
      closeService: { decide: async () => ({ status: 200, body: { ok: true } }), undo: () => ({ status: 200, body: { ok: true } }) } });
    const summaryFor = async (username) => {
      let payload = null;
      const url = new URL("http://test/console/api/owner-review/summary?peek=1");
      await routes.handle({ method: "GET" }, {}, url, ["owner-review", "summary"], {
        username, operator: db.getOperator(username), readJson: async () => ({}), requireCsrf: () => true,
        json: (_res, status, json) => { payload = { status, json }; },
      });
      return payload;
    };
    assert.deepEqual((await summaryFor("chom")).json.channelScope, { limited: true, hidden: ["Facebook"] });
    assert.deepEqual((await summaryFor("nok")).json.channelScope, { limited: false, hidden: [] });
  } finally {
    db.close();
  }
});

test("รายละเอียด ?since=: หลัง 409 ลูกค้าพิมพ์ใหม่ (จุดอ้างอิงในฐานเลื่อนแล้ว) ข้อความที่ทำให้ 409 ยังติดป้าย ใหม่ · since ที่ไม่ใช่ข้อความขาเข้าของห้องนี้ = ใช้จุดอ้างอิงเดิม", async (t) => {
  const { app, db } = await start(t);
  const { proposal, inbound } = seedProposal(db);
  const fresh = String(db.insertMessage({ customerId: ROOM, direction: "in", content: "จริง ๆ อยากถามเรื่องคลาสครับ" }));
  // เวลาเดียวกันระดับมิลลิวินาทีกับ inbound ทำเทสต์สุ่มตก (afterBaseline ใช้ created_at >) — เลื่อนข้อความใหม่ไป 1 วินาที
  const baseAt = db.raw.prepare("SELECT created_at FROM messages WHERE id = ?").get(inbound).created_at;
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(baseAt + 1_000, fresh);
  // สิ่งที่ ownerCloseService ทำตอน 409 customer_typed: เลื่อนจุดอ้างอิงไปข้อความล่าสุด
  db.raw.prepare("UPDATE owner_close_proposals SET baseline_inbound_id = ? WHERE id = ?").run(fresh, proposal.id);
  const auth = await login(app.server, "chom");
  const plain = await get(app.server, `/console/api/owner-review/proposals/${proposal.id}`, auth);
  assert.equal(plain.json.messages.some((m) => m.afterBaseline), false, "ไม่ส่ง since = ไม่มีป้ายใหม่ (ปัญหาเดิม)");
  const since = await get(app.server, `/console/api/owner-review/proposals/${proposal.id}?since=${encodeURIComponent(inbound)}`, auth);
  assert.equal(since.status, 200);
  assert.deepEqual(since.json.messages.filter((m) => m.afterBaseline).map((m) => m.id), [fresh]);
  assert.equal(since.json.customerTypedSinceBaseline, true);
  const otherRoom = seedProposal(db, { id: `U${"a1".repeat(16)}` });
  const foreign = await get(app.server, `/console/api/owner-review/proposals/${proposal.id}?since=${encodeURIComponent(otherRoom.inbound)}`, auth);
  assert.equal(foreign.json.messages.some((m) => m.afterBaseline), false, "ข้อความของห้องอื่นใช้เป็นจุดอ้างอิงไม่ได้");
});
