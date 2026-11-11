import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashPassword } from "../src/auth.mjs";
import { openDb } from "../src/db.mjs";
import { createApp } from "../src/server.mjs";
import { quarantineResolutionConfirmationText } from "../src/consoleBroadcastApi.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb,
  poisonGlobalFetch, testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "quarantine-review-pass-123";
const SECRET = "quarantine-review-console-secret-012345";

async function login(server, username) {
  const response = await httpRequest(server, {
    method: "POST",
    path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 200, response.text);
  return {
    cookie: (response.headers["set-cookie"]?.[0] || "").split(";", 1)[0],
    csrf: response.json.csrf,
  };
}

function post(server, path, auth, body, { csrf = auth.csrf } = {}) {
  return httpRequest(server, {
    method: "POST",
    path,
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function seedQuarantine(db, suffix, {
  failureKind = "server_error", providerStatus = 503,
} = {}) {
  const audience = [
    { line_user_id: `U-private-${suffix}-first` },
    { line_user_id: `U-private-${suffix}-second` },
  ];
  const ownerToken = `claim-${suffix}`;
  const claim = db.claimBroadcast({
    channelId: "default",
    messages: [{ type: "text", text: `PRIVATE-BODY-${suffix}-DO-NOT-LEAK` }],
    audience,
    createdBy: "owner",
    ownerToken,
    leaseDurationMs: 60_000,
  });
  assert.equal(claim.ok, true);
  const quarantine = db.quarantineBroadcastClaim("default", claim.row.id, ownerToken, {
    lineUserIds: [audience[0].line_user_id],
    batchNo: 0,
    retryKey: `PRIVATE-RETRY-${suffix}-DO-NOT-LEAK`,
    providerStatus,
    failureKind,
    lastError: "provider outcome ambiguous",
  });
  assert.ok(quarantine?.id);
  return { audience, broadcastId: claim.row.id, quarantine };
}

async function setup(t) {
  const db = memoryDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "owner", passHash, displayName: "Owner", role: "owner" });
  db.createOperator({ username: "admin", passHash, displayName: "Admin", role: "admin" });
  db.createOperator({ username: "staff", passHash, displayName: "Staff", role: "operator" });
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig({
      CONSOLE_SESSION_SECRET: SECRET,
      BROADCAST_SCHEDULE_ENABLED: "false",
    }),
    db,
    overrides: { lineFetch, hermesFetch: hermesFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { db, lineFetch, server: app.server };
}

test("B-13 quarantine review is owner/admin-only, aggregate-only and available while scheduler is off", async (t) => {
  const { db, lineFetch, server } = await setup(t);
  const seeded = seedQuarantine(db, "list");
  const owner = await login(server, "owner");
  const admin = await login(server, "admin");
  const staff = await login(server, "staff");

  const anonymous = await httpRequest(server, { path: "/console/api/broadcast/quarantines?channel=default" });
  assert.equal(anonymous.status, 401);
  // เจ้าของตัดสิน 2026-08-25: staff ตรวจ quarantine ได้ แต่ผู้ไม่ล็อกอินยังต้องถูกปฏิเสธ (401 ด้านบน)
  const staffReview = await httpRequest(server, {
    path: "/console/api/broadcast/quarantines?channel=default",
    headers: { cookie: staff.cookie },
  });
  assert.equal(staffReview.status, 200, "staff reviews quarantine after the 2026-08-25 role decision");
  assert.ok(Array.isArray(staffReview.json.quarantines), "review stays aggregate-only for staff too");

  for (const auth of [owner, admin]) {
    const response = await httpRequest(server, {
      path: "/console/api/broadcast/quarantines?channel=default",
      headers: { cookie: auth.cookie },
    });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.quarantines.length, 1);
    assert.deepEqual(Object.keys(response.json.quarantines[0]).sort(), [
      // 28 ก.ย. 2026: lineSide = ส่งฝั่ง LINE (เพื่อนทุกคน/กลุ่มเป้าหมาย) ไม่มีรายชื่อ — ยังเป็นค่า boolean รวม ไม่มีข้อมูลคน
      "channelId", "channelName", "createdAt", "id", "lineSide", "outcomeCategory",
      "recipientCount", "resolution", "resolvedAt", "status",
    ]);
    assert.deepEqual(response.json.quarantines[0], {
      id: seeded.quarantine.id,
      channelId: "default",
      channelName: "default",
      status: "unresolved",
      recipientCount: 1,
      lineSide: false,
      outcomeCategory: "provider_server_error",
      createdAt: seeded.quarantine.created_at,
      resolvedAt: null,
      resolution: null,
    });
    const serialized = JSON.stringify(response.json);
    for (const secret of [
      ...seeded.audience.map((row) => row.line_user_id),
      "PRIVATE-BODY-list-DO-NOT-LEAK",
      "PRIVATE-RETRY-list-DO-NOT-LEAK",
      seeded.broadcastId,
      "audience_fingerprint",
      "retry_key_hash",
    ]) assert.equal(serialized.includes(secret), false, `must not leak ${secret}`);
  }
  assert.equal(lineFetch.sends.length, 0);
});

test("B-13 quarantine resolve validates capability, CSRF, reason and id-bound typed confirmation", async (t) => {
  const { db, lineFetch, server } = await setup(t);
  const { quarantine } = seedQuarantine(db, "validation", { failureKind: "status_0", providerStatus: 0 });
  const owner = await login(server, "owner");
  const staff = await login(server, "staff");
  const path = `/console/api/broadcast/quarantines/${quarantine.id}/resolve`;
  const valid = {
    resolution: "confirmed_delivered",
    reason: "ตรวจหลักฐาน provider ภายนอกแล้ว",
    confirmation: quarantineResolutionConfirmationText(quarantine.id, "confirmed_delivered"),
  };

  // staff แก้ quarantine ได้แล้ว แต่ CSRF/ข้อความยืนยัน/เหตุผล ยังบังคับเหมือนเดิมทุกบทบาท
  assert.equal((await post(server, path, staff, valid, { csrf: "wrong" })).status, 403, "CSRF still enforced for staff");
  assert.equal((await post(server, path, staff, { ...valid, confirmation: "ไม่ตรง" })).status, 400, "typed confirmation still enforced for staff");
  assert.equal((await post(server, path, owner, valid, { csrf: "wrong" })).status, 403);
  assert.equal((await post(server, path, owner, { ...valid, resolution: "retry_now" })).status, 400);
  assert.equal((await post(server, path, owner, { ...valid, reason: "สั้น" })).status, 400);
  assert.equal((await post(server, path, owner, { ...valid, confirmation: `${valid.confirmation}-wrong` })).status, 400);
  assert.equal((await post(server, "/console/api/broadcast/quarantines/missing/resolve", owner, valid)).status, 404);

  assert.equal(db.getBroadcastDeliveryQuarantine(quarantine.id).resolved_at, null);
  assert.equal(db.listAudit().filter((row) => row.action === "broadcast_delivery_quarantine_resolved").length, 0);
  assert.equal(lineFetch.sends.length, 0);
});

test("B-13 unresolved recipient intersection blocks exact/subset/superset/tag drift but permits disjoint audience", async (t) => {
  const { db, lineFetch } = await setup(t);
  const seeded = seedQuarantine(db, "intersection");
  const unknownId = seeded.audience[0].line_user_id;
  const disjointId = seeded.audience[1].line_user_id;
  const overlapCases = [
    { name: "exact", audience: seeded.audience },
    { name: "subset", audience: [{ line_user_id: unknownId }] },
    { name: "superset", audience: [...seeded.audience, { line_user_id: "U-new-superset" }] },
    {
      name: "tag-drift",
      audience: [{ line_user_id: "U-new-from-tag" }, { line_user_id: unknownId }],
      includeTags: ["tag-changed-after-preview"],
    },
  ];
  for (const scenario of overlapCases) {
    const claim = db.claimBroadcast({
      channelId: "default",
      messages: [{ type: "text", text: `follow-on-${scenario.name}` }],
      includeTags: scenario.includeTags || [],
      audience: scenario.audience,
      createdBy: "owner",
      ownerToken: `overlap-${scenario.name}`,
      leaseDurationMs: 60_000,
      manual: true,
    });
    assert.equal(claim.ok, false, scenario.name);
    assert.equal(claim.reason, "delivery_quarantined", scenario.name);
    assert.equal(JSON.stringify(claim).includes(unknownId), false, "gate response must not reveal raw recipient IDs");
  }
  const unproven = db.claimBroadcast({
    channelId: "default",
    messages: [{ type: "text", text: "malformed candidate" }],
    audience: [{ line_user_id: disjointId }, {}],
    createdBy: "legacy-caller",
    ownerToken: "unproven-candidate-owner",
    leaseDurationMs: 60_000,
    manual: true,
  });
  assert.equal(unproven.ok, false);
  assert.equal(unproven.reason, "delivery_quarantined",
    "partially malformed candidate IDs cannot prove disjointness and must block the whole OA");

  const disjointOwner = "disjoint-owner";
  const disjoint = db.claimBroadcast({
    channelId: "default",
    messages: [{ type: "text", text: "explicit disjoint audience" }],
    audience: [{ line_user_id: disjointId }, { line_user_id: "U-new-disjoint" }],
    createdBy: "owner",
    ownerToken: disjointOwner,
    leaseDurationMs: 60_000,
    manual: true,
  });
  assert.equal(disjoint.ok, true, "candidate proven disjoint from every unresolved unknown recipient may proceed");
  assert.equal(lineFetch.sends.length, 0, "claim gates never call provider");
  assert.equal(db.finalizeBroadcastClaim("default", disjoint.row.id, disjointOwner, { status: "failed" }), true);
});

test("B-13 recipient-overlap gate is shared by scheduled claims and remains safe across two DB connections", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-quarantine-race-"));
  const file = join(dir, "state.db");
  const db1 = openDb({ file });
  const db2 = openDb({ file });
  t.after(() => {
    db2.close();
    db1.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const seeded = seedQuarantine(db1, "two-connection");
  const unknown = [{ line_user_id: seeded.audience[0].line_user_id }];

  const attempts = await Promise.all([
    new Promise((resolve) => setImmediate(() => resolve(db1.claimBroadcast({
      channelId: "default", audience: unknown, ownerToken: "process-one",
      leaseDurationMs: 60_000, createdBy: "owner", manual: true,
    })))),
    new Promise((resolve) => setImmediate(() => resolve(db2.claimBroadcast({
      channelId: "default", audience: unknown, ownerToken: "process-two",
      leaseDurationMs: 60_000, createdBy: "owner", manual: true,
    })))),
  ]);
  assert.deepEqual(attempts.map((claim) => claim.reason), ["delivery_quarantined", "delivery_quarantined"]);
  assert.equal(db1.listBroadcasts().length, 1, "neither DB connection creates a follow-on broadcast row");

  const scheduleOwner = "schedule-worker";
  const schedule = db1.createBroadcastSchedule({
    channelId: "default",
    messages: [{ type: "text", text: "scheduled overlap" }],
    scheduledAt: Date.now() - 1,
    previewCount: 1,
    audienceFingerprint: "old-whole-audience-fingerprint",
    confirmationHash: "schedule-overlap-confirmation",
    confirmationExpiresAt: Date.now() + 60_000,
    createdBy: "owner",
  });
  assert.equal(db1.claimDueBroadcastSchedule({
    ownerToken: scheduleOwner,
    leaseDurationMs: 60_000,
    at: Date.now(),
  }).id, schedule.id);
  const scheduledClaim = db2.claimBroadcast({
    channelId: "default",
    messages: [{ type: "text", text: "scheduled overlap" }],
    audience: unknown,
    createdBy: "owner",
    ownerToken: "scheduled-broadcast-owner",
    leaseDurationMs: 60_000,
    scheduleId: schedule.id,
    scheduleOwnerToken: scheduleOwner,
  });
  assert.equal(scheduledClaim.ok, false);
  assert.equal(scheduledClaim.reason, "delivery_quarantined");
  assert.equal(db1.getBroadcastSchedule(schedule.id).status, "preparing");
  assert.equal(db1.listBroadcasts().length, 1, "scheduled overlap also creates no second send job");
});

test("B-13 confirmed_delivered resolves atomically once, keeps ledger truthful and only releases a later explicit action", async (t) => {
  const { db, lineFetch, server } = await setup(t);
  const seeded = seedQuarantine(db, "delivered");
  const owner = await login(server, "owner");
  const path = `/console/api/broadcast/quarantines/${seeded.quarantine.id}/resolve`;
  const reason = "ตรวจ delivery log ภายนอกแล้วโดยไม่บันทึกข้อมูลลูกค้า";
  const body = {
    resolution: "confirmed_delivered",
    reason,
    confirmation: quarantineResolutionConfirmationText(seeded.quarantine.id, "confirmed_delivered"),
  };

  const responses = await Promise.all([
    post(server, path, owner, body),
    post(server, path, owner, body),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const success = responses.find((response) => response.status === 200);
  assert.match(success.json.notice, /ไม่มีการส่ง LINE/u);
  assert.doesNotMatch(success.json.notice, /อ่านแล้ว|ส่งถึงแล้ว/u);

  const resolved = db.getBroadcastDeliveryQuarantine(seeded.quarantine.id);
  assert.equal(resolved.resolution, "confirmed_delivered");
  assert.equal(resolved.resolved_by, "owner");
  assert.ok(resolved.resolved_at > 0);
  assert.deepEqual(db.broadcastRecipientSummary(seeded.broadcastId), {
    queued: 0, sent: 1, failed: 0, skipped: 0, cancelled: 1,
  });
  const broadcast = db.getBroadcast(seeded.broadcastId);
  assert.equal(broadcast.status, "partial");
  assert.equal(broadcast.sent_count, 1);
  assert.equal(broadcast.failed_count, 0);

  const audits = db.listAudit().filter((row) => row.action === "broadcast_delivery_quarantine_resolved");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operator, "owner");
  assert.equal(audits[0].target, "default");
  assert.match(audits[0].detail, /resolution=confirmed_delivered/u);
  assert.match(audits[0].detail, /reason_recorded=true/u);
  assert.equal(audits[0].detail.includes(reason), false);
  for (const row of seeded.audience) assert.equal(audits[0].detail.includes(row.line_user_id), false);

  const remaining = await httpRequest(server, {
    path: "/console/api/broadcast/quarantines?channel=default",
    headers: { cookie: owner.cookie },
  });
  assert.deepEqual(remaining.json.quarantines, []);
  assert.equal(lineFetch.sends.length, 0);

  const laterOwner = "later-explicit-owner";
  const later = db.claimBroadcast({
    channelId: "default",
    messages: [{ type: "text", text: "separate explicit action" }],
    audience: seeded.audience,
    createdBy: "owner",
    ownerToken: laterOwner,
    leaseDurationMs: 60_000,
    manual: true,
  });
  assert.equal(later.ok, true, "human resolution only releases the quarantine gate; it does not send");
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(db.finalizeBroadcastClaim("default", later.row.id, laterOwner, { status: "failed" }), true);
});

test("B-13 confirmed_not_delivered marks attempted recipients failed, never retries, and admin can release a later explicit action", async (t) => {
  const { db, lineFetch, server } = await setup(t);
  const seeded = seedQuarantine(db, "not-delivered", { failureKind: "exception", providerStatus: 0 });
  const admin = await login(server, "admin");
  const resolution = "confirmed_not_delivered";
  const response = await post(
    server,
    `/console/api/broadcast/quarantines/${seeded.quarantine.id}/resolve`,
    admin,
    {
      resolution,
      reason: "provider reconciliation ยืนยันว่าไม่รับรายการ",
      confirmation: quarantineResolutionConfirmationText(seeded.quarantine.id, resolution),
    },
  );
  assert.equal(response.status, 200, response.text);
  assert.equal(db.getBroadcastDeliveryQuarantine(seeded.quarantine.id).resolved_by, "admin");
  assert.deepEqual(db.broadcastRecipientSummary(seeded.broadcastId), {
    queued: 0, sent: 0, failed: 1, skipped: 0, cancelled: 1,
  });
  const broadcast = db.getBroadcast(seeded.broadcastId);
  assert.equal(broadcast.status, "failed");
  assert.equal(broadcast.sent_count, 0);
  assert.equal(broadcast.failed_count, 1);
  assert.equal(lineFetch.sends.length, 0);

  const laterOwner = "later-not-delivered-owner";
  const later = db.claimBroadcast({
    channelId: "default",
    messages: [{ type: "text", text: "new manual broadcast" }],
    audience: seeded.audience,
    createdBy: "admin",
    ownerToken: laterOwner,
    leaseDurationMs: 60_000,
    manual: true,
  });
  assert.equal(later.ok, true);
  assert.equal(lineFetch.sends.length, 0, "resolution and later claim never invoke provider by themselves");
  assert.equal(db.finalizeBroadcastClaim("default", later.row.id, laterOwner, { status: "failed" }), true);
});

test("B-13 resolution rollback includes ledger, quarantine and audit in one transaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-quarantine-atomic-"));
  const file = join(dir, "state.db");
  const db = openDb({ file });
  let raw = null;
  try {
    const seeded = seedQuarantine(db, "atomic");
    raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TRIGGER test_abort_quarantine_audit
      BEFORE INSERT ON admin_audit
      WHEN NEW.action = 'broadcast_delivery_quarantine_resolved'
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END;
    `);
    assert.throws(() => db.resolveBroadcastDeliveryQuarantine({
      id: seeded.quarantine.id,
      channelId: "default",
      resolvedBy: "owner",
      resolution: "confirmed_delivered",
      reason: "force atomic rollback test",
    }), /forced audit failure/u);
    assert.equal(db.getBroadcastDeliveryQuarantine(seeded.quarantine.id).resolved_at, null);
    assert.deepEqual(db.broadcastRecipientSummary(seeded.broadcastId), {
      queued: 1, sent: 0, failed: 0, skipped: 0, cancelled: 0, unknown: 1,
    });
    assert.equal(db.listAudit().some((row) => row.action === "broadcast_delivery_quarantine_resolved"), false);
  } finally {
    raw?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
