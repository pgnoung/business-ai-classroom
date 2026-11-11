import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword } from "../src/auth.mjs";
import { createApp } from "../src/server.mjs";
import {
  createBroadcastScheduler,
  broadcastAudienceFingerprint,
  isBangkokQuietHours,
  nextBangkokNineMs,
  validFutureBangkokSchedule,
} from "../src/broadcastSchedule.mjs";
import { makeScheduleConfirmation, scheduleConfirmationMatches } from "../src/consoleBroadcastApi.mjs";
import { formatBangkokDatetimeLocal, parseBangkokDatetimeLocal } from "../public/console/broadcast.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb,
  poisonGlobalFetch, testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "owner-pass-123";
const SECRET = "broadcast-schedule-console-secret-012345";
let confirmationSequence = 0;

function bkkMs(day, hour, minute = 0) {
  return Date.UTC(2026, 7, day, hour - 7, minute, 0, 0);
}

function seed(db, id = "U-schedule") {
  db.upsertCustomer(id, { channelId: "default" });
  db.addTag(id, "กลุ่มทดสอบ", "human");
  return db.broadcastAudience({ channelId: "default", includeTags: ["กลุ่มทดสอบ"] });
}

function createSchedule(db, { scheduledAt, audience = null } = {}) {
  const current = audience || db.broadcastAudience({ channelId: "default", includeTags: ["กลุ่มทดสอบ"] });
  return db.createBroadcastSchedule({
    channelId: "default",
    messages: [{ type: "text", text: "ทดสอบตั้งเวลา" }],
    includeTags: ["กลุ่มทดสอบ"],
    excludeTags: [],
    scheduledAt,
    previewCount: current.length,
    audienceFingerprint: broadcastAudienceFingerprint(current),
    confirmationHash: `confirmation-hash-${confirmationSequence += 1}`,
    confirmationExpiresAt: scheduledAt - 1,
    createdBy: "owner",
  });
}

function engine({
  runSend = async () => {},
  quota = { type: "none", totalUsage: 0 },
  quotaFor = async () => quota,
} = {}) {
  return {
    broadcastOwnerToken: "broadcast-owner",
    guardCheck: () => ({ ok: true }),
    sendReady: () => ({ ok: true }),
    quotaFor,
    runSend,
  };
}

async function login(server, username = "owner") {
  const response = await httpRequest(server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  return {
    cookie: (response.headers["set-cookie"]?.[0] || "").split(";", 1)[0],
    csrf: response.json.csrf,
  };
}

function post(server, path, auth, body, { csrf = auth.csrf } = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { cookie: auth.cookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("B-13 config is default-off and tick is clamped to at least 15 seconds", () => {
  assert.equal(testConfig().broadcastScheduleEnabled, false);
  assert.equal(testConfig({ BROADCAST_SCHEDULE_TICK_MS: "100" }).broadcastScheduleTickMs, 15_000);
});

test("B-13 Bangkok quiet boundaries and next 09:00 are exact", () => {
  assert.equal(isBangkokQuietHours(bkkMs(25, 8, 59)), true);
  assert.equal(isBangkokQuietHours(bkkMs(25, 9)), false);
  assert.equal(isBangkokQuietHours(bkkMs(25, 20, 59)), false);
  assert.equal(isBangkokQuietHours(bkkMs(25, 21)), true);
  assert.equal(nextBangkokNineMs(bkkMs(25, 22)), bkkMs(26, 9));
  assert.equal(nextBangkokNineMs(bkkMs(25, 3)), bkkMs(25, 9));
  assert.equal(validFutureBangkokSchedule(bkkMs(25, 21), bkkMs(25, 20)).ok, false);
  assert.equal(formatBangkokDatetimeLocal(bkkMs(25, 10, 30)), "2026-08-25T10:30");
  assert.equal(parseBangkokDatetimeLocal("2026-08-25T10:30"), bkkMs(25, 10, 30));
  assert.equal(parseBangkokDatetimeLocal("2026-02-31T10:30"), null);
});

test("B-13 confirmation binds session, channel, tags, audience, messages and scheduledAt", () => {
  const now = () => bkkMs(25, 10);
  const base = {
    secret: SECRET, sessionId: "session-a", channelId: "default",
    includeTags: ["กลุ่มทดสอบ"], excludeTags: [],
    audience: [{ line_user_id: "U-a" }],
    messages: [{ type: "text", text: "ข้อความเดิม" }],
    scheduledAt: bkkMs(25, 11), now,
  };
  const token = makeScheduleConfirmation(base);
  assert.equal(scheduleConfirmationMatches({ token, ...base }), true);
  for (const changed of [
    { sessionId: "session-b" }, { channelId: "other" }, { includeTags: ["อื่น"] },
    { audience: [{ line_user_id: "U-b" }] },
    { messages: [{ type: "text", text: "เปลี่ยนแล้ว" }] },
    { scheduledAt: bkkMs(25, 12) },
  ]) assert.equal(scheduleConfirmationMatches({ token, ...base, ...changed }), false);
});

test("B-13 default-off route is 503 and scheduling never calls LINE", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), role: "owner" });
  seed(db);
  const lineFetch = lineFetchStub({ quota: { type: "none" }, consumption: { totalUsage: 0 } });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SECRET }), db,
    overrides: { lineFetch, hermesFetch: hermesFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const auth = await login(app.server);
  const response = await post(app.server, "/console/api/broadcast/schedule/preview", auth, {
    channelId: "default", includeTags: ["กลุ่มทดสอบ"], excludeTags: [],
    messages: [{ type: "text", text: "ทดสอบ" }], scheduledAt: Date.now() + 86_400_000,
  });
  assert.equal(response.status, 503);
  assert.equal(lineFetch.sends.length, 0);
});

test("B-13 health reports enabled separately from armed scheduler state", async (t) => {
  const db = memoryDb();
  const app = createApp({
    config: testConfig({ BROADCAST_SCHEDULE_ENABLED: "true" }), db,
    overrides: {
      lineFetch: lineFetchStub(), hermesFetch: hermesFetchStub(), sleep: async () => {},
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.broadcastScheduler.stop(); app.server.close(); db.close(); });
  const before = await httpRequest(app.server, { path: "/health" });
  assert.equal(before.json.broadcastSchedule.enabled, true);
  assert.equal(before.json.broadcastSchedule.armed, false);
  assert.equal(before.json.components.broadcastSchedule, "off");
  assert.equal(app.broadcastScheduler.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  const after = await httpRequest(app.server, { path: "/health" });
  assert.equal(after.json.broadcastSchedule.armed, true);
  assert.equal(after.json.components.broadcastSchedule, "armed");
});

test("B-13 schedule preview/create require fresh CSRF/count/HMAC and create no provider call", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), role: "owner" });
  db.createOperator({ username: "staff", passHash: hashPassword(PASSWORD), role: "operator" });
  seed(db);
  const lineFetch = lineFetchStub({ quota: { type: "none" }, consumption: { totalUsage: 0 } });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SECRET, BROADCAST_SCHEDULE_ENABLED: "true" }), db,
    overrides: { lineFetch, hermesFetch: hermesFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const auth = await login(app.server);
  const tomorrowBangkokTen = (() => {
    const shifted = new Date(Date.now() + 7 * 60 * 60_000 + 86_400_000);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 10 - 7, 0, 0, 0);
  })();
  const body = {
    channelId: "default", includeTags: ["กลุ่มทดสอบ"], excludeTags: [],
    messages: [{ type: "text", text: "ทดสอบตั้งเวลา" }], scheduledAt: tomorrowBangkokTen,
  };
  const unauthenticated = await httpRequest(app.server, { method: "GET", path: "/console/api/broadcast/schedule" });
  assert.equal(unauthenticated.status, 401);
  const staff = await login(app.server, "staff");
  // เจ้าของตัดสิน 2026-08-25: staff ตั้งเวลาได้ แต่ขอบเขต OA และ CSRF ยังบังคับ (ยืนยันสองบรรทัดถัดไป)
  assert.equal((await post(app.server, "/console/api/broadcast/schedule/preview", staff, body)).status, 200);
  assert.equal((await post(app.server, "/console/api/broadcast/schedule/preview", staff, body, { csrf: "bad" })).status, 403, "CSRF still enforced for staff");
  assert.equal((await post(app.server, "/console/api/broadcast/schedule/preview", auth, { ...body, channelId: "not-granted" })).status, 403);
  assert.equal((await post(app.server, "/console/api/broadcast/schedule/preview", auth, body, { csrf: "bad" })).status, 403);
  const preview = await post(app.server, "/console/api/broadcast/schedule/preview", auth, body);
  assert.equal(preview.status, 200, preview.text);
  const mismatch = await post(app.server, "/console/api/broadcast/schedule", auth, {
    ...body, confirm: true, confirmCount: 2, scheduleConfirmation: preview.json.scheduleConfirmation,
  });
  assert.equal(mismatch.status, 400);
  const created = await post(app.server, "/console/api/broadcast/schedule", auth, {
    ...body, confirm: true, confirmCount: 1, scheduleConfirmation: preview.json.scheduleConfirmation,
  });
  assert.equal(created.status, 201, created.text);
  const replay = await post(app.server, "/console/api/broadcast/schedule", auth, {
    ...body, confirm: true, confirmCount: 1, scheduleConfirmation: preview.json.scheduleConfirmation,
  });
  assert.equal(replay.status, 409, replay.text);
  assert.equal(db.listBroadcastSchedules().length, 1);
  assert.equal(db.listBroadcasts().length, 0);
  assert.equal(lineFetch.sends.length, 0);

  const concurrentPreview = await post(app.server, "/console/api/broadcast/schedule/preview", auth, body);
  const concurrentBody = {
    ...body, confirm: true, confirmCount: 1,
    scheduleConfirmation: concurrentPreview.json.scheduleConfirmation,
  };
  const concurrent = await Promise.all([
    post(app.server, "/console/api/broadcast/schedule", auth, concurrentBody),
    post(app.server, "/console/api/broadcast/schedule", auth, concurrentBody),
  ]);
  assert.equal(concurrent.filter((response) => response.status === 201).length, 1);
  assert.equal(concurrent.filter((response) => response.status === 409).length, 1);
  assert.equal(db.listBroadcastSchedules().length, 2);
  assert.equal(lineFetch.sends.length, 0);
});

test("B-13 disabled scheduler still allows authenticated GET/cancel of a due intent and unblocks manual claim", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), role: "owner" });
  const audience = seed(db);
  const lineFetch = lineFetchStub({ quota: { type: "none" }, consumption: { totalUsage: 0 } });
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, BROADCAST_SCHEDULE_ENABLED: "true" });
  const app = createApp({
    config, db,
    overrides: { lineFetch, hermesFetch: hermesFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.broadcastScheduler.stop(); app.server.close(); db.close(); });
  const auth = await login(app.server);
  const shifted = new Date(Date.now() + 7 * 60 * 60_000 + 86_400_000);
  const scheduledAt = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 10 - 7, 0, 0, 0);
  const body = {
    channelId: "default", includeTags: ["กลุ่มทดสอบ"], excludeTags: [],
    messages: [{ type: "text", text: "งานที่จะยกเลิก" }], scheduledAt,
  };
  const preview = await post(app.server, "/console/api/broadcast/schedule/preview", auth, body);
  assert.equal(preview.status, 200, preview.text);
  const created = await post(app.server, "/console/api/broadcast/schedule", auth, {
    ...body, confirm: true, confirmCount: audience.length,
    scheduleConfirmation: preview.json.scheduleConfirmation,
  });
  assert.equal(created.status, 201, created.text);

  db.raw.prepare("UPDATE broadcast_schedules SET scheduled_at = 1 WHERE id = ?").run(created.json.schedule.id);
  config.broadcastScheduleEnabled = false;
  assert.equal((await app.broadcastScheduler.runOnce()).state, "disabled");
  const listed = await httpRequest(app.server, {
    method: "GET", path: "/console/api/broadcast/schedule", headers: { cookie: auth.cookie },
  });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.scheduling.enabled, false);
  assert.equal(listed.json.schedules[0].status, "scheduled");
  assert.equal((await post(app.server, "/console/api/broadcast/schedule/preview", auth, body)).status, 503,
    "disabled mode blocks new preview");

  const cancelled = await post(
    app.server, `/console/api/broadcast/schedule/${created.json.schedule.id}/cancel`, auth, {},
  );
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.json.outcome, "cancelled");
  assert.equal(lineFetch.sends.length, 0, "GET/cancel and disabled due tick never cross provider boundary");

  const manual = db.claimBroadcast({
    channelId: "default", messages: [{ type: "text", text: "manual" }],
    includeTags: ["กลุ่มทดสอบ"], audience, createdBy: "owner", manual: true,
    ownerToken: "manual-after-cancel", leaseDurationMs: 60_000,
  });
  assert.equal(manual.ok, true, "cancelled due intent no longer blocks manual claim");
  assert.equal(db.finalizeBroadcastClaim("default", manual.row.id, "manual-after-cancel", { status: "failed" }), true);
});

test("B-13 due/early, two scheduler instances, audience drift and quiet wake are fail-closed", async () => {
  // นาฬิกาเดียวกันทั้ง scheduler และ DB — `claimBroadcast` เทียบ
  // `preparing_lease_expires_at > now()` ใน SQL ถ้า DB ยังใช้ wall clock
  // lease ที่ออกจากนาฬิกาตรึงจะหมดอายุทันทีเมื่อวันจริงเดินผ่าน bkkMs()
  let clock = bkkMs(26, 10);
  const db = memoryDb({ now: () => clock });
  const audience = seed(db);
  const early = createSchedule(db, { scheduledAt: clock + 60_000, audience });
  let sends = 0;
  const sharedEngine = engine({ runSend: async () => { sends += 1; } });
  const first = createBroadcastScheduler({ db, config: { broadcastScheduleEnabled: true, broadcastScheduleTickMs: 15_000 }, engine: sharedEngine, now: () => clock, ownerToken: "scheduler-a" });
  const second = createBroadcastScheduler({ db, config: { broadcastScheduleEnabled: true, broadcastScheduleTickMs: 15_000 }, engine: sharedEngine, now: () => clock, ownerToken: "scheduler-b" });
  assert.equal((await first.runOnce()).state, "idle");
  clock += 60_000;
  const results = await Promise.all([first.runOnce(), second.runOnce()]);
  assert.equal(results.filter((row) => row.state === "dispatched").length, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.equal(db.getBroadcastSchedule(early.id).status, "dispatched");

  clock += 120_000;
  const drift = createSchedule(db, { scheduledAt: clock, audience: db.broadcastAudience({ channelId: "default", includeTags: ["กลุ่มทดสอบ"] }) });
  db.setDoNotDisturb("U-schedule", true);
  assert.equal((await first.runOnce()).state, "failed");
  assert.equal(db.getBroadcastSchedule(drift.id).last_failure_phase, "audience_drift");
  assert.equal(sends, 1);

  db.setDoNotDisturb("U-schedule", false);
  clock += 120_000;
  const tagDrift = createSchedule(db, { scheduledAt: clock });
  db.removeTag("U-schedule", "กลุ่มทดสอบ");
  assert.equal((await first.runOnce()).state, "failed");
  assert.equal(db.getBroadcastSchedule(tagDrift.id).last_failure_phase, "audience_drift");
  db.addTag("U-schedule", "กลุ่มทดสอบ", "human");

  clock += 120_000;
  const quotaDrift = createSchedule(db, { scheduledAt: clock });
  const quotaScheduler = createBroadcastScheduler({
    db,
    config: { broadcastScheduleEnabled: true, broadcastScheduleTickMs: 15_000 },
    engine: engine({ quota: { type: "limited", value: 0, totalUsage: 0 } }),
    now: () => clock,
    ownerToken: "scheduler-quota",
  });
  assert.equal((await quotaScheduler.runOnce()).state, "failed");
  assert.equal(db.getBroadcastSchedule(quotaDrift.id).last_failure_phase, "quota");

  clock = bkkMs(25, 21);
  const quiet = createSchedule(db, { scheduledAt: clock });
  assert.equal((await first.runOnce()).state, "deferred_quiet");
  const deferred = db.getBroadcastSchedule(quiet.id);
  assert.equal(deferred.status, "scheduled");
  assert.equal(deferred.scheduled_at, bkkMs(26, 9));
  assert.equal(sends, 1);
  db.close();
});

test("B-13 cancel/stale recovery/manual conflict never crosses provider boundary", async () => {
  const clock = bkkMs(25, 10);
  const db = memoryDb({ now: () => clock });
  const audience = seed(db);
  const cancelled = createSchedule(db, { scheduledAt: clock, audience });
  assert.equal(db.cancelBroadcastSchedule(cancelled.id, "owner").outcome, "cancelled");
  assert.equal(db.claimDueBroadcastSchedule({ ownerToken: "worker", leaseDurationMs: 60_000, at: clock }), null);

  const stale = createSchedule(db, { scheduledAt: clock, audience });
  db.claimDueBroadcastSchedule({ ownerToken: "dead-worker", leaseDurationMs: 60_000, at: clock });
  assert.equal(db.recoverStalePreparingBroadcastSchedules(clock + 60_001), 1);
  assert.equal(db.getBroadcastSchedule(stale.id).status, "failed");

  const due = createSchedule(db, { scheduledAt: 1, audience });
  const manual = db.claimBroadcast({
    channelId: "default", messages: [{ type: "text", text: "manual" }],
    includeTags: ["กลุ่มทดสอบ"], audience, createdBy: "owner",
    ownerToken: "broadcast-owner", leaseDurationMs: 60_000, manual: true,
  });
  assert.equal(manual.ok, false);
  assert.equal(manual.reason, "schedule_due");
  assert.equal(db.listBroadcasts().length, 0);
  assert.equal(db.getBroadcastSchedule(due.id).status, "scheduled");
  db.close();
});

test("B-13 owner cancel while preparing quota is awaited creates no broadcast and never runs send", async () => {
  const clock = bkkMs(26, 10);
  const db = memoryDb({ now: () => clock });
  const audience = seed(db);
  const row = createSchedule(db, { scheduledAt: clock, audience });
  let quotaCalls = 0;
  let runSendCalls = 0;
  let providerCalls = 0;
  const scheduler = createBroadcastScheduler({
    db,
    config: { broadcastScheduleEnabled: true, broadcastScheduleTickMs: 15_000 },
    engine: engine({
      quotaFor: async () => {
        quotaCalls += 1;
        assert.equal(db.getBroadcastSchedule(row.id).status, "preparing");
        assert.equal(db.cancelBroadcastSchedule(row.id, "owner").outcome, "cancelled");
        // This counter represents the provider send boundary, not the read-only
        // quota lookup. Cancellation must prevent reaching it entirely.
        return { type: "none", totalUsage: 0 };
      },
      runSend: async () => {
        runSendCalls += 1;
        providerCalls += 1;
      },
    }),
    logger: silent,
    now: () => clock,
    ownerToken: "scheduler-cancel-during-quota",
  });

  const result = await scheduler.runOnce();
  assert.equal(result.state, "cancelled");
  assert.equal(db.getBroadcastSchedule(row.id).status, "cancelled");
  assert.equal(quotaCalls, 1);
  assert.equal(db.listBroadcasts().length, 0);
  assert.equal(runSendCalls, 0);
  assert.equal(providerCalls, 0);
  db.close();
});

test("B-13 ambiguous/provider-side failure remains dispatched and is never auto-replayed", async () => {
  const clock = bkkMs(26, 10);
  const db = memoryDb({ now: () => clock });
  const audience = seed(db);
  const row = createSchedule(db, { scheduledAt: clock, audience });
  let attempts = 0;
  const scheduler = createBroadcastScheduler({
    db,
    config: { broadcastScheduleEnabled: true, broadcastScheduleTickMs: 15_000 },
    engine: engine({ runSend: async () => { attempts += 1; throw new Error("provider outcome unknown"); } }),
    logger: silent,
    now: () => clock,
    ownerToken: "scheduler-unknown",
  });
  assert.equal((await scheduler.runOnce()).state, "dispatched");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(db.getBroadcastSchedule(row.id).status, "dispatched");
  assert.equal((await scheduler.runOnce()).state, "idle");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1, "dispatched schedule must never be selected again");
  db.close();
});
