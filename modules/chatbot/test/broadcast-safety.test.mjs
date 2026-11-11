import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb,
  poisonGlobalFetch, signLine, testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "owner-pass-123";
const SESSION_SECRET = "broadcast-safety-console-secret-012345";

function sessionHashFromAuth(auth) {
  const token = String(auth.cookie || "").split("=", 2)[1] || "";
  const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
  return createHmac("sha256", SESSION_SECRET).update(String(payload.sid || "")).digest("hex");
}

async function login(server) {
  const response = await httpRequest(server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  assert.equal(response.status, 200, response.text);
  return {
    cookie: (response.headers["set-cookie"]?.[0] || "").split(";", 1)[0],
    csrf: response.json.csrf,
  };
}

function post(server, path, auth, body) {
  return httpRequest(server, {
    method: "POST", path,
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function start(t, { quota = null, consumption = null, configEnv = {} } = {}) {
  const db = memoryDb();
  db.createOperator({
    username: "owner", passHash: hashPassword(PASSWORD), displayName: "เจ้าของ", role: "owner",
  });
  db.upsertCustomer("U-segment", { channelId: "default" });
  db.addTag("U-segment", "กลุ่มทดสอบ", "human");
  const lineFetch = lineFetchStub({ quota, consumption });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_SECRET, ...configEnv }), db,
    overrides: { lineFetch, hermesFetch: hermesFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, lineFetch, auth: await login(app.server) };
}

async function previewConfirmation(server, auth, { includeTags = ["กลุ่มทดสอบ"], excludeTags = [] } = {}) {
  const preview = await post(server, "/console/api/broadcast/preview", auth, {
    channelId: "default", includeTags, excludeTags, messageCount: 1,
  });
  assert.equal(preview.status, 200, preview.text);
  assert.equal(typeof preview.json.audienceConfirmation, "string");
  return preview.json.audienceConfirmation;
}

async function inboundText(server, { text, userId = "U-self-test", eventId = `evt-${Math.random().toString(16).slice(2)}` } = {}) {
  const raw = JSON.stringify({ events: [{
    type: "message", webhookEventId: eventId, replyToken: `reply-${eventId}`,
    source: { type: "user", userId },
    message: { id: `msg-${eventId}`, type: "text", text },
  }] });
  return httpRequest(server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") },
    body: raw,
  });
}

test("B-1/B-2: include ว่างส่งไม่ได้ และ confirmCount ต้องตรง audience ที่ server คำนวณ", async (t) => {
  const { app, db, auth } = await start(t);
  const emptyPreview = await post(app.server, "/console/api/broadcast/preview", auth, {
    channelId: "default", includeTags: [], excludeTags: [], messageCount: 1,
  });
  assert.equal(emptyPreview.status, 400);

  const emptySend = await post(app.server, "/console/api/broadcast/send", auth, {
    confirm: true, confirmCount: 1, channelId: "default",
    includeTags: [], excludeTags: [], messages: [{ type: "text", text: "ทดสอบ" }],
  });
  assert.equal(emptySend.status, 400);

  const mismatch = await post(app.server, "/console/api/broadcast/send", auth, {
    confirm: true, confirmCount: 999, channelId: "default",
    includeTags: ["กลุ่มทดสอบ"], excludeTags: [], messages: [{ type: "text", text: "ทดสอบ" }],
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.json.error, /จำนวน/);
  assert.equal(db.listBroadcasts().length, 0, "ทุก guard ต้องทำงานก่อนสร้าง broadcast row");
});

test("B-3: preview บอก quota และ send block ก่อนสร้างงานเมื่อโควตาไม่พอ", async (t) => {
  const { app, db, auth } = await start(t, {
    quota: { type: "limited", value: 10 }, consumption: { totalUsage: 10 },
  });
  const preview = await post(app.server, "/console/api/broadcast/preview", auth, {
    channelId: "default", includeTags: ["กลุ่มทดสอบ"], excludeTags: [], messageCount: 2,
  });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.json.quota, {
    type: "limited", limit: 10, used: 10, remaining: 0,
    estimatedUse: 1, remainingAfter: -1,
  });

  const blocked = await post(app.server, "/console/api/broadcast/send", auth, {
    confirm: true, confirmCount: 1, channelId: "default",
    audienceConfirmation: preview.json.audienceConfirmation,
    includeTags: ["กลุ่มทดสอบ"], excludeTags: [],
    messages: [{ type: "text", text: "หนึ่ง" }, { type: "text", text: "สอง" }],
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.json.error, /โควตา/);
  assert.equal(db.listBroadcasts().length, 0);
});

test("REGRESSION: audience confirmation ผูกกับ session และ recipient fingerprint ไม่ใช่แค่จำนวน", async (t) => {
  const { app, db, auth } = await start(t);
  db.upsertCustomer("U-replacement", { channelId: "default" });
  db.addTag("U-replacement", "กลุ่มทดสอบ", "human");
  const confirmation = await previewConfirmation(app.server, auth);
  db.setDoNotDisturb("U-segment", true); // เหลือ 1 คนเท่าเดิม แต่เป็นคนละราย
  const swapped = await post(app.server, "/console/api/broadcast/send", auth, {
    confirm: true, confirmCount: 1, audienceConfirmation: confirmation, channelId: "default",
    includeTags: ["กลุ่มทดสอบ"], excludeTags: [], messages: [{ type: "text", text: "ทดสอบ" }],
  });
  assert.equal(swapped.status, 400, swapped.text);
  assert.match(swapped.json.error, /preview ใหม่/);
  assert.equal(db.listBroadcasts().length, 0);
});

test("REGRESSION: audience confirmation หมดก่อน cooldown 60 วิ จึง replay หลัง cooldown ไม่ได้", async (t) => {
  let clock = 2_000_000_000_000;
  t.mock.method(Date, "now", () => clock);
  const { app, db, auth } = await start(t, {
    quota: { type: "none" }, consumption: { totalUsage: 0 },
  });
  const confirmation = await previewConfirmation(app.server, auth);
  clock += 45_001;
  const expired = await post(app.server, "/console/api/broadcast/send", auth, {
    confirm: true, confirmCount: 1, audienceConfirmation: confirmation, channelId: "default",
    includeTags: ["กลุ่มทดสอบ"], excludeTags: [], messages: [{ type: "text", text: "ทดสอบ" }],
  });
  assert.equal(expired.status, 400, expired.text);
  assert.match(expired.json.error, /หมดอายุ/);
  assert.equal(db.listBroadcasts().length, 0);
});

test("REGRESSION: quota unknown/malformed fail-closed before create", async (t) => {
  const { app, db, auth } = await start(t, {
    quota: { type: "limited", value: "bad" }, consumption: { totalUsage: 0 },
  });
  const confirmation = await previewConfirmation(app.server, auth);
  const blocked = await post(app.server, "/console/api/broadcast/send", auth, {
    confirm: true, confirmCount: 1, audienceConfirmation: confirmation, channelId: "default",
    includeTags: ["กลุ่มทดสอบ"], excludeTags: [], messages: [{ type: "text", text: "ทดสอบ" }],
  });
  assert.equal(blocked.status, 400, blocked.text);
  assert.match(blocked.json.error, /โควตา LINE/);
  assert.equal(db.listBroadcasts().length, 0);
});

test("REGRESSION: concurrent send claims one channel atomically", async (t) => {
  const { app, db, auth } = await start(t, {
    quota: { type: "none" }, consumption: { totalUsage: 0 },
  });
  const confirmation = await previewConfirmation(app.server, auth);
  const body = {
    confirm: true, confirmCount: 1, audienceConfirmation: confirmation, channelId: "default",
    includeTags: ["กลุ่มทดสอบ"], excludeTags: [], messages: [{ type: "text", text: "ทดสอบ" }],
  };
  const [first, second] = await Promise.all([
    post(app.server, "/console/api/broadcast/send", auth, body),
    post(app.server, "/console/api/broadcast/send", auth, body),
  ]);
  const statuses = [first.status, second.status];
  assert.equal(statuses.filter((status) => status === 200).length, 1);
  assert.ok(statuses.some((status) => status === 409 || status === 429),
    "request ที่แพ้ race ต้องถูก active claim หรือ cooldown ปฏิเสธ");
  assert.equal(db.listBroadcasts().length, 1, "only one request creates/schedules a broadcast");
});

test("REGRESSION: >2,000 recipients rejects before row or LINE", async (t) => {
  const { app, db, lineFetch, auth } = await start(t, {
    quota: { type: "none" }, consumption: { totalUsage: 0 },
  });
  for (let index = 0; index < 2_000; index += 1) {
    const id = `U-cap-${index}`;
    db.upsertCustomer(id, { channelId: "default" });
    db.addTag(id, "กลุ่มทดสอบ", "human");
  }
  const preview = await post(app.server, "/console/api/broadcast/preview", auth, {
    channelId: "default", includeTags: ["กลุ่มทดสอบ"], excludeTags: [], messageCount: 1,
  });
  assert.equal(preview.json.count, 2_001);
  assert.equal(preview.json.overAudienceCap, true);
  const blocked = await post(app.server, "/console/api/broadcast/send", auth, {
    confirm: true, confirmCount: 2_001, audienceConfirmation: preview.json.audienceConfirmation, channelId: "default",
    includeTags: ["กลุ่มทดสอบ"], excludeTags: [], messages: [{ type: "text", text: "ทดสอบ" }],
  });
  assert.equal(blocked.status, 400, blocked.text);
  assert.equal(db.listBroadcasts().length, 0);
  assert.equal(lineFetch.sends.length, 0, "hard cap must stop before any LINE mock send");
});

test("B-12 route: owner ขอ cancel งาน active ได้แบบ idempotent และงานจบยกเลิกย้อนหลังไม่ได้", async (t) => {
  const { app, db, auth } = await start(t);
  const claim = db.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "owner",
    ownerToken: "route-test-owner", leaseDurationMs: 60_000,
  });
  assert.equal(claim.ok, true);
  const first = await post(app.server, `/console/api/broadcast/cancel/${claim.row.id}`, auth, {});
  assert.equal(first.status, 200, first.text);
  assert.equal(db.getBroadcast(claim.row.id).cancel_requested_by, "owner");
  const repeated = await post(app.server, `/console/api/broadcast/cancel/${claim.row.id}`, auth, {});
  assert.equal(repeated.status, 200, repeated.text);
  db.finalizeBroadcastClaim("default", claim.row.id, "route-test-owner", {
    sentCount: 0, failedCount: 1, status: "failed", lastError: "cancelled",
  });
  const terminal = await post(app.server, `/console/api/broadcast/cancel/${claim.row.id}`, auth, {});
  assert.equal(terminal.status, 409);
  const missing = await post(app.server, "/console/api/broadcast/cancel/missing", auth, {});
  assert.equal(missing.status, 404);
});

test("B-12 self-test: bind only one fresh exact inbound challenge and Push exactly one private destination", async (t) => {
  const { app, db, auth, lineFetch } = await start(t, {
    quota: { type: "none" }, consumption: { totalUsage: 0 }, configEnv: { AI_PAUSED: "true" },
  });
  const before = await post(app.server, "/console/api/broadcast/self-test/send", auth, {
    channelId: "default", text: "ยังไม่มีปลายทาง", confirm: true,
  });
  assert.equal(before.status, 409);
  const issued = await post(app.server, "/console/api/broadcast/self-test/challenge", auth, { channelId: "default" });
  assert.equal(issued.status, 201, issued.text);
  assert.match(issued.json.challenge, /^LKP-SELF-[A-Za-z0-9_-]+$/);
  const wrong = await inboundText(app.server, { text: `${issued.json.challenge}-wrong`, userId: "U-wrong" });
  assert.equal(wrong.status, 200);
  assert.equal(db.broadcastSelfTestStatus({ operatorUsername: "owner", sessionHash: sessionHashFromAuth(auth), channelId: "default" }).verified, false);
  const received = await inboundText(app.server, { text: issued.json.challenge, userId: "U-self-real" });
  assert.equal(received.status, 200);
  const status = await httpRequest(app.server, {
    path: "/console/api/broadcast/self-test?channel=default", headers: { cookie: auth.cookie },
  });
  assert.equal(status.status, 200, status.text);
  assert.deepEqual(status.json.destination.verified, true);
  assert.equal(JSON.stringify(status.json).includes("U-self-real"), false, "private LINE id must never enter API output");
  const push = await post(app.server, "/console/api/broadcast/self-test/send", auth, {
    channelId: "default", text: "ทดสอบหนึ่งบับเบิล", confirm: true,
  });
  assert.equal(push.status, 200, push.text);
  assert.equal(push.json.state, "accepted");
  assert.equal(lineFetch.sends.length, 1, "exactly one provider attempt");
  assert.deepEqual(lineFetch.sends[0].body, {
    to: "U-self-real", messages: [{ type: "text", text: "ทดสอบหนึ่งบับเบิล" }],
  });
  const replay = await inboundText(app.server, { text: issued.json.challenge, userId: "U-attacker" });
  assert.equal(replay.status, 200);
  const privateRow = db.getBroadcastSelfTestDestination({ operatorUsername: "owner", sessionHash: sessionHashFromAuth(auth), channelId: "default" });
  assert.equal(privateRow.line_user_id, "U-self-real", "single-use challenge cannot be rebound");
  assert.equal(db.listAudit().some((row) => /U-self-real|LKP-SELF/u.test(`${row.target} ${row.detail}`)), false,
    "audit must not retain raw id or challenge");
});

test("B-12 self-test: post-provider audit failure cannot report false failure or invite a duplicate retry", async (t) => {
  const { app, db, auth, lineFetch } = await start(t, {
    quota: { type: "none" }, consumption: { totalUsage: 0 }, configEnv: { AI_PAUSED: "true" },
  });
  const issued = await post(app.server, "/console/api/broadcast/self-test/challenge", auth, { channelId: "default" });
  assert.equal(issued.status, 201, issued.text);
  assert.equal((await inboundText(app.server, { text: issued.json.challenge, userId: "U-audit-failure" })).status, 200);

  const originalAddAudit = db.addAudit.bind(db);
  db.addAudit = (entry) => {
    if (entry.action === "broadcast_self_test_push") throw new Error("audit unavailable after provider acceptance");
    return originalAddAudit(entry);
  };
  const push = await post(app.server, "/console/api/broadcast/self-test/send", auth, {
    channelId: "default", text: "ผล provider ต้องมาก่อน audit", confirm: true,
  });
  assert.equal(push.status, 200, push.text);
  assert.equal(push.json.state, "accepted");
  assert.equal(lineFetch.sends.length, 1, "the response must not suggest retry after an accepted Push");
});

test("B-12 self-test: normal webhook text remains ordinary inbound when no exact challenge exists", async (t) => {
  const { app, db, auth } = await start(t, { configEnv: { AI_PAUSED: "true" } });
  const response = await inboundText(app.server, { text: "ข้อความลูกค้าปกติ", userId: "U-ordinary" });
  assert.equal(response.status, 200, response.text);
  const messages = db.messagesFor("U-ordinary");
  assert.ok(messages.some((message) => message.direction === "in" && message.content === "ข้อความลูกค้าปกติ"));
  assert.equal(db.broadcastSelfTestStatus({ operatorUsername: "owner", sessionHash: sessionHashFromAuth(auth), channelId: "default" }).verified, false);
});

test("B-12 self-test: destination is valid only in the session that issued the challenge", async (t) => {
  const { app, lineFetch, auth: firstSession } = await start(t, {
    quota: { type: "none" }, consumption: { totalUsage: 0 }, configEnv: { AI_PAUSED: "true" },
  });
  const issued = await post(app.server, "/console/api/broadcast/self-test/challenge", firstSession, { channelId: "default" });
  assert.equal(issued.status, 201, issued.text);
  assert.equal((await inboundText(app.server, { text: issued.json.challenge, userId: "U-first-session" })).status, 200);

  const secondSession = await login(app.server);
  const secondStatus = await httpRequest(app.server, {
    path: "/console/api/broadcast/self-test?channel=default", headers: { cookie: secondSession.cookie },
  });
  assert.equal(secondStatus.status, 200, secondStatus.text);
  assert.equal(secondStatus.json.destination.verified, false);
  const blocked = await post(app.server, "/console/api/broadcast/self-test/send", secondSession, {
    channelId: "default", text: "session ใหม่ห้ามใช้ปลายทางเดิม", confirm: true,
  });
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(lineFetch.sends.length, 0);

  const originalStatus = await httpRequest(app.server, {
    path: "/console/api/broadcast/self-test?channel=default", headers: { cookie: firstSession.cookie },
  });
  assert.equal(originalStatus.json.destination.verified, true);
});

test("B-12 self-test: an expired challenge cannot bind or send", async (t) => {
  let clock = 2_000_000_000_000;
  t.mock.method(Date, "now", () => clock);
  const { app, lineFetch, auth } = await start(t, {
    quota: { type: "none" }, consumption: { totalUsage: 0 }, configEnv: { AI_PAUSED: "true" },
  });
  const issued = await post(app.server, "/console/api/broadcast/self-test/challenge", auth, { channelId: "default" });
  assert.equal(issued.status, 201, issued.text);
  clock += 5 * 60_000 + 1;
  assert.equal((await inboundText(app.server, { text: issued.json.challenge, userId: "U-expired" })).status, 200);
  const status = await httpRequest(app.server, {
    path: "/console/api/broadcast/self-test?channel=default", headers: { cookie: auth.cookie },
  });
  assert.equal(status.json.destination.verified, false);
  const blocked = await post(app.server, "/console/api/broadcast/self-test/send", auth, {
    channelId: "default", text: "expired", confirm: true,
  });
  assert.equal(blocked.status, 409);
  assert.equal(lineFetch.sends.length, 0);
});

test("B-12 self-test: a matched control challenge is stored but never reaches the AI reply pipeline", async (t) => {
  const { app, db, auth, lineFetch } = await start(t, {
    quota: { type: "none" }, consumption: { totalUsage: 0 },
    configEnv: { AI_PAUSED: "false" },
  });
  const issued = await post(app.server, "/console/api/broadcast/self-test/challenge", auth, { channelId: "default" });
  assert.equal(issued.status, 201, issued.text);
  const inbound = await inboundText(app.server, { text: issued.json.challenge, userId: "U-control-only" });
  assert.equal(inbound.status, 200, inbound.text);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const messages = db.messagesFor("U-control-only");
  assert.equal(messages.filter((row) => row.direction === "in").length, 1, "control text remains durable");
  assert.equal(messages.filter((row) => row.direction === "out").length, 0, "control text must not create an AI reply");
  assert.equal(lineFetch.sends.length, 0, "binding itself must not send LINE");
});
