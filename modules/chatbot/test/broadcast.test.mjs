// broadcast.test.mjs — v1.2: audience engine + guard + multicast batching + API
import test from "node:test";
import assert from "node:assert/strict";
import { buildBroadcastMessages, createBroadcastEngine, BROADCAST_BATCH_SIZE } from "../src/broadcast.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { memoryDb } from "./helpers.mjs";
import { openDb } from "../src/db.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const silent = { log() {}, warn() {}, error() {}, debug() {} };

function seedCustomers(db) {
  db.upsertCustomer("U-a", { displayName: "เอ" });
  db.upsertCustomer("U-b", { displayName: "บี" });
  db.upsertCustomer("U-c", { displayName: "ซี" });
  db.upsertCustomer("U-dnd", { displayName: "ดี" });
  db.setDoNotDisturb("U-dnd", true);
  db.upsertCustomer("canary:x", {});
  db.addTag("U-a", "ซื้อแล้ว: X3", "rfm");
  db.addTag("U-b", "ซื้อแล้ว: X3", "rfm");
  db.addTag("U-b", "VIP", "human");
  db.addTag("U-dnd", "ซื้อแล้ว: X3", "rfm");
  db.addTag("canary:x", "ซื้อแล้ว: X3", "rfm");
}

/* ------------------------------- audience SQL ------------------------------- */

test("broadcastAudience: include/exclude + dnd/canary ตัดเสมอ", () => {
  const db = memoryDb();
  seedCustomers(db);
  const all = db.broadcastAudience({ channelId: "default" });
  assert.deepEqual(all.map((c) => c.line_user_id).sort(), ["U-a", "U-b", "U-c"],
    "include ว่าง = ทุกคนในสาขา ยกเว้น dnd/canary");
  const buyers = db.broadcastAudience({ channelId: "default", includeTags: ["ซื้อแล้ว: X3"] });
  assert.deepEqual(buyers.map((c) => c.line_user_id).sort(), ["U-a", "U-b"],
    "dnd มีป้ายตรงก็ห้ามติด audience");
  const noVip = db.broadcastAudience({ channelId: "default", includeTags: ["ซื้อแล้ว: X3"], excludeTags: ["VIP"] });
  assert.deepEqual(noVip.map((c) => c.line_user_id), ["U-a"], "exclude ตัด U-b (VIP)");
  assert.equal(db.broadcastAudience({ channelId: "shinchan" }).length, 0, "คนละสาขา = ว่าง");
  db.close();
});

/* ----------------------------- message validation ---------------------------- */

test("buildBroadcastMessages: text/รูปจากแคตตาล็อกเท่านั้น + เพดาน 5 บับเบิล", () => {
  const catalog = new Map([["x3_hero", { key: "x3_hero", url: "https://img.example/x3.jpg" }]]);
  const ok = buildBroadcastMessages(
    [{ type: "text", text: " โปรใหม่ค่ะ " }, { type: "image", key: "x3_hero" }],
    { imageCatalogByKey: catalog });
  assert.equal(ok.error, undefined);
  assert.equal(ok.messages[0].text, "โปรใหม่ค่ะ");
  assert.equal(ok.messages[1].originalContentUrl, "https://img.example/x3.jpg");
  assert.deepEqual(ok.stored[1], { type: "image", key: "x3_hero" });
  assert.ok(buildBroadcastMessages([], {}).error, "ว่าง = error");
  assert.ok(buildBroadcastMessages([{ type: "image", key: "แปลกปลอม" }], { imageCatalogByKey: catalog }).error,
    "รูปนอกแคตตาล็อก = ปฏิเสธ (ห้ามรับ URL อิสระ)");
  assert.ok(buildBroadcastMessages([{ type: "image", key: "pending" }], {
    imageCatalogByKey: new Map([["pending", {
      key: "pending", url: "https://img.example/pending.jpg", needsVerification: true,
    }]]),
  }).error, "needsVerification=true = ห้ามบรอดแคส");
  assert.ok(buildBroadcastMessages(Array.from({ length: 6 }, () => ({ type: "text", text: "x" })), {}).error,
    "เกิน 5 บับเบิล = ปฏิเสธ");
  assert.ok(buildBroadcastMessages([{ type: "video", url: "x" }], {}).error);
});

/* ------------------------------ guard + runSend ------------------------------ */

function makeEngine(db, { multicastResults = [] } = {}) {
  const guard = createComplianceGuard({ getApprovedPrices: () => db.approvedPrices() });
  const calls = [];
  let i = 0;
  const line = {
    sendAllowed: () => true,
    async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
    async multicast(args) {
      calls.push(args);
      return multicastResults[i++] ?? { ok: true };
    },
  };
  let uuidSeq = 0;
  const engine = createBroadcastEngine({
    db, config: {}, guard, line, logger: silent,
    uuid: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, "0")}`,
  });
  return { engine, calls };
}

function claimForRun(db, engine, audience, {
  messages = [], includeTags = [], excludeTags = [], createdBy = "nok",
} = {}) {
  const claim = db.claimBroadcast({
    channelId: "default", messages, includeTags, excludeTags, audience, createdBy,
    ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
  });
  assert.equal(claim.ok, true);
  return claim.row;
}

test("engine.guardCheck: ราคานอกตาราง approve = บล็อกทั้งบรอดแคส", () => {
  const db = memoryDb();
  db.setApprovedPrice("X3 โปร", 18990);
  const { engine } = makeEngine(db);
  assert.equal(engine.guardCheck([{ type: "text", text: "X3 โปรพิเศษ 18,990 บาทค่ะ" }]).ok, true, "ราคาตรงตาราง = ผ่าน");
  const blocked = engine.guardCheck([{ type: "text", text: "ลดพิเศษเหลือ 9,999 บาท วันนี้วันเดียว" }]);
  assert.equal(blocked.ok, false, "ราคาแต่งเอง = บล็อก");
  assert.match(blocked.error, /ตารางราคา/);
  db.close();
});

test("engine.runSend: แบ่ง batch + log ข้อความ proactive ต่อคน + progress/status", async () => {
  const db = memoryDb();
  seedCustomers(db);
  const { engine, calls } = makeEngine(db);
  const audience = db.broadcastAudience({ channelId: "default" });
  const row = claimForRun(db, engine, audience, {
    messages: [{ type: "text", text: "สวัสดีค่ะ" }],
  });
  const result = await engine.runSend({
    broadcastId: row.id, channelId: "default", audience,
    messages: [{ type: "text", text: "สวัสดีค่ะ" }],
    storedMessages: [{ type: "text", text: "สวัสดีค่ะ" }],
    operator: "nok", claimOwnerToken: engine.broadcastOwnerToken,
  });
  assert.equal(result.sent, 3);
  assert.equal(calls.length, 1, "3 คน < batch size = multicast ครั้งเดียว");
  assert.deepEqual(calls[0].to.sort(), ["U-a", "U-b", "U-c"]);
  const fresh = db.getBroadcast(row.id);
  assert.equal(fresh.status, "done");
  assert.equal(fresh.sent_count, 3);
  const msgs = db.messagesFor("U-a").filter((m) => m.direction === "out");
  assert.equal(msgs.length, 1, "ประวัติแชทเห็นบรอดแคส");
  assert.equal(msgs[0].message_class, "proactive");
  assert.ok(db.listAudit().some((r) => r.action === "broadcast_done"));
  db.close();
});

test("engine.runSend: provider ปฏิเสธแบบชัดเจน = นับ failed และสถานะ partial ตามจริง", async () => {
  const db = memoryDb();
  // ลูกค้า 2 batch (batch size ปกติ 150 — ทดสอบด้วยลูกค้าเกิน 1 batch จำลองยาก
  // จึงยิงผ่าน audience เกิน BROADCAST_BATCH_SIZE แบบ synthetic)
  const audience = Array.from({ length: BROADCAST_BATCH_SIZE + 5 }, (_, i) => {
    const id = `U-m${String(i).padStart(3, "0")}`;
    db.upsertCustomer(id, {});
    return { line_user_id: id, display_name: "", known_name: "" };
  });
  const { engine, calls } = makeEngine(db, { multicastResults: [{ ok: true }, { ok: false, status: 400 }] });
  const row = claimForRun(db, engine, audience);
  const result = await engine.runSend({
    broadcastId: row.id, channelId: "default", audience,
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
    claimOwnerToken: engine.broadcastOwnerToken,
  });
  assert.equal(calls.length, 2, "แบ่ง 2 batch");
  assert.equal(result.sent, BROADCAST_BATCH_SIZE);
  assert.equal(result.failed, 5);
  assert.equal(db.getBroadcast(row.id).status, "partial", "ส่งได้บางส่วนห้ามรายงานว่า done");
  assert.equal(db.getBroadcast(row.id).failed_count, 5);
  assert.equal(db.getBroadcast(row.id).last_sent_index, BROADCAST_BATCH_SIZE - 1);
  db.close();
});

test("engine.runSend: LINE 429 หยุดทุก batch ถัดไปและไม่ส่งซ้ำ", async () => {
  const db = memoryDb();
  const audience = Array.from({ length: (BROADCAST_BATCH_SIZE * 2) + 5 }, (_, i) => {
    const id = `U-429-${String(i).padStart(3, "0")}`;
    db.upsertCustomer(id, {});
    return { line_user_id: id, display_name: "", known_name: "" };
  });
  const { engine, calls } = makeEngine(db, {
    multicastResults: [{ ok: true }, { ok: false, status: 429 }, { ok: true }],
  });
  const row = claimForRun(db, engine, audience);
  const result = await engine.runSend({
    broadcastId: row.id, channelId: "default", audience,
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
    claimOwnerToken: engine.broadcastOwnerToken,
  });

  assert.equal(calls.length, 2, "429 ต้อง break ก่อน batch ที่สาม");
  assert.notEqual(calls[0].retryKey, calls[1].retryKey, "แต่ละ batch ใช้ retry key คนละ UUID");
  assert.equal(result.sent, BROADCAST_BATCH_SIZE);
  assert.equal(result.failed, BROADCAST_BATCH_SIZE + 5, "ผู้รับที่เหลือถูกปิดเป็นล้มเหลว ไม่ค้าง sending");
  const fresh = db.getBroadcast(row.id);
  assert.equal(fresh.status, "partial");
  assert.equal(fresh.last_sent_index, BROADCAST_BATCH_SIZE - 1);
  assert.match(fresh.last_error, /429/);
  db.close();
});

test("B-13 provider 0/5xx/throw becomes durable quarantine, stops later batches and blocks same audience", async (t) => {
  const cases = [
    { name: "status 0", outcome: { ok: false, status: 0 }, kind: "status_0" },
    { name: "HTTP 503", outcome: { ok: false, status: 503 }, kind: "server_error" },
    { name: "throw", error: new Error("socket closed after write"), kind: "exception" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const db = memoryDb();
      const audience = Array.from({ length: (BROADCAST_BATCH_SIZE * 2) + 1 }, (_, index) => {
        const lineUserId = `U-unknown-${scenario.kind}-${String(index).padStart(3, "0")}`;
        db.upsertCustomer(lineUserId, {});
        return { line_user_id: lineUserId, display_name: "", known_name: "" };
      });
      const guard = createComplianceGuard({ getApprovedPrices: () => [] });
      let providerCalls = 0;
      const engine = createBroadcastEngine({
        db, config: {}, guard, logger: silent,
        line: {
          sendAllowed: () => true,
          async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
          async multicast() {
            providerCalls += 1;
            if (scenario.error) throw scenario.error;
            return scenario.outcome;
          },
        },
        uuid: () => `00000000-0000-4000-8000-${scenario.kind.padEnd(12, "0").slice(0, 12)}`,
      });
      const claim = db.claimBroadcast({
        channelId: "default", messages: [{ type: "text", text: "x" }], audience, createdBy: "owner",
        ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
      });
      assert.equal(claim.ok, true);
      const result = await engine.runSend({
        broadcastId: claim.row.id, channelId: "default", audience,
        messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }],
        operator: "owner", claimOwnerToken: engine.broadcastOwnerToken,
      });
      assert.deepEqual(result, {
        sent: 0, failed: 0, skipped: 0, unknown: BROADCAST_BATCH_SIZE, quarantined: true,
      });
      assert.equal(providerCalls, 1, "ambiguous first batch stops all later provider calls");
      assert.equal(db.getBroadcast(claim.row.id).status, "failed");
      assert.match(db.getBroadcast(claim.row.id).last_error, /quarantine/);
      const quarantine = db.unresolvedBroadcastDeliveryQuarantine("default", audience);
      assert.ok(quarantine);
      assert.equal(quarantine.failure_kind, scenario.kind);
      assert.equal(quarantine.attempted_count, BROADCAST_BATCH_SIZE);
      assert.deepEqual(db.broadcastRecipientSummary(claim.row.id), {
        queued: BROADCAST_BATCH_SIZE + 1, sent: 0, failed: 0, skipped: 0, cancelled: 0,
        unknown: BROADCAST_BATCH_SIZE,
      });
      assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM broadcast_channel_claims").get().n, 0);

      const followOn = db.claimBroadcast({
        channelId: "default", messages: [{ type: "text", text: "retry" }], audience: [...audience].reverse(),
        createdBy: "owner", ownerToken: "follow-on-owner", leaseDurationMs: 60_000,
      });
      assert.equal(followOn.ok, false);
      assert.equal(followOn.reason, "delivery_quarantined");
      for (const [label, candidate, includeTags] of [
        ["subset", [audience[0]], []],
        ["superset", [...audience, { line_user_id: `U-new-${scenario.kind}` }], []],
        ["tag-drift-overlap", [{ line_user_id: `U-tag-new-${scenario.kind}` }, audience[1]], ["new-tag"]],
      ]) {
        const overlap = db.claimBroadcast({
          channelId: "default", messages: [{ type: "text", text: label }],
          includeTags, audience: candidate, createdBy: "owner",
          ownerToken: `overlap-${scenario.kind}-${label}`, leaseDurationMs: 60_000,
        });
        assert.equal(overlap.ok, false, label);
        assert.equal(overlap.reason, "delivery_quarantined", label);
      }
      assert.equal(providerCalls, 1, "exact/subset/superset/tag-drift overlap never reaches a second multicast");
      const disjointOwner = `disjoint-${scenario.kind}`;
      const disjoint = db.claimBroadcast({
        channelId: "default", messages: [{ type: "text", text: "disjoint" }],
        audience: audience.slice(BROADCAST_BATCH_SIZE), createdBy: "owner",
        ownerToken: disjointOwner, leaseDurationMs: 60_000,
      });
      assert.equal(disjoint.ok, true, "unattempted recipient is disjoint from unresolved unknown recipients");
      assert.equal(db.finalizeBroadcastClaim("default", disjoint.row.id, disjointOwner, { status: "failed" }), true);
      assert.equal(providerCalls, 1, "disjoint claim itself still does not call provider");
      const unknownAudienceClaim = db.claimBroadcast({
        channelId: "default", audienceCount: 1, createdBy: "legacy-caller",
        ownerToken: "unknown-audience-owner", leaseDurationMs: 60_000,
      });
      assert.equal(unknownAudienceClaim.reason, "delivery_quarantined",
        "caller without an exact audience cannot bypass an unresolved OA quarantine");

      if (scenario.kind === "server_error") {
        assert.throws(
          () => db.resolveBroadcastDeliveryQuarantine({
            id: quarantine.id, channelId: "default", resolvedBy: "",
            resolution: "confirmed_not_delivered", reason: "ตรวจจาก LINE แล้ว",
          }),
          /ต้องระบุผู้ตรวจ/,
        );
        const resolved = db.resolveBroadcastDeliveryQuarantine({
          id: quarantine.id, channelId: "default", resolvedBy: "owner",
          resolution: "confirmed_not_delivered", reason: "ตรวจจาก LINE แล้วว่าไม่ส่ง",
        });
        assert.equal(resolved.outcome, "resolved");
        assert.equal(resolved.row.resolution, "confirmed_not_delivered");
        const afterHumanResolution = db.claimBroadcast({
          channelId: "default", messages: [{ type: "text", text: "new approved attempt" }], audience,
          createdBy: "owner", ownerToken: "resolved-owner", leaseDurationMs: 60_000,
        });
        assert.equal(afterHumanResolution.ok, true, "only explicit human resolution opens the audience gate");
        assert.equal(db.finalizeBroadcastClaim("default", afterHumanResolution.row.id, "resolved-owner", { status: "failed" }), true);
      }
      db.close();
    });
  }
});

test("CRITICAL: quarantine finalization failure leaves pre-provider guard durable across reopen and lease expiry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "broadcast-guard-fault-"));
  let db2 = null;
  t.after(() => {
    db2?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, "live.sqlite");
  let clock = 10_000_000;
  const now = () => clock;
  const db1 = openDb({ file, now });
  const audience = ["U-critical-one", "U-critical-two"].map((lineUserId) => {
    db1.upsertCustomer(lineUserId, {});
    return { line_user_id: lineUserId };
  });
  let providerCalls = 0;
  const logs = [];
  const logger = {
    log() {}, debug() {},
    warn(message) { logs.push(String(message)); },
    error(message) { logs.push(String(message)); },
  };
  const engine = createBroadcastEngine({
    db: db1,
    config: {},
    guard: createComplianceGuard({ getApprovedPrices: () => [] }),
    logger,
    line: {
      sendAllowed: () => true,
      async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
      async multicast() { providerCalls += 1; return { ok: false, status: 503 }; },
    },
    uuid: () => "00000000-0000-4000-8000-000000009999",
  });
  const claim = db1.claimBroadcast({
    channelId: "default", audience, messages: [{ type: "text", text: "x" }],
    createdBy: "owner", ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
  });
  assert.equal(claim.ok, true);
  db1.raw.exec(`
    CREATE TRIGGER test_fail_quarantine_finalize
    BEFORE UPDATE OF failure_kind ON broadcast_delivery_quarantines
    WHEN OLD.failure_kind = 'ambiguous' AND NEW.failure_kind = 'server_error'
    BEGIN SELECT RAISE(ABORT, 'forced quarantine finalize failure'); END;
  `);

  await assert.rejects(engine.runSend({
    broadcastId: claim.row.id,
    channelId: "default",
    audience,
    messages: [{ type: "text", text: "x" }],
    storedMessages: [{ type: "text", text: "x" }],
    operator: "owner",
    claimOwnerToken: engine.broadcastOwnerToken,
  }), /forced quarantine finalize failure/u);
  assert.equal(providerCalls, 1);
  const armed = db1.raw.prepare(
    "SELECT id, failure_kind, resolved_at FROM broadcast_delivery_quarantines WHERE broadcast_id = ?",
  ).get(claim.row.id);
  assert.ok(armed?.id, "pre-provider guard must survive failed quarantine finalization");
  assert.equal(armed.failure_kind, "ambiguous");
  assert.equal(armed.resolved_at, null);
  assert.equal(db1.raw.prepare("SELECT COUNT(*) AS n FROM broadcast_channel_claims").get().n, 1,
    "failed finalization must not release the live claim");
  const logText = JSON.stringify(logs);
  for (const row of audience) assert.equal(logText.includes(row.line_user_id), false, "logs must not expose raw IDs");
  assert.equal(logText.includes("00000000-0000-4000-8000-000000009999"), false, "logs must not expose retry key");
  db1.close();

  clock += 120_000;
  db2 = openDb({ file, now });
  assert.equal(db2.getBroadcast(claim.row.id).status, "failed", "startup may terminalize the expired send job");
  assert.equal(db2.raw.prepare("SELECT COUNT(*) AS n FROM broadcast_channel_claims").get().n, 0,
    "startup may remove the expired claim, but not the durable delivery guard");
  assert.ok(db2.getBroadcastDeliveryQuarantine(armed.id));

  const overlap = db2.claimBroadcast({
    channelId: "default", audience: [audience[0]], createdBy: "owner",
    ownerToken: "future-manual", leaseDurationMs: 60_000, manual: true,
  });
  assert.equal(overlap.ok, false);
  assert.equal(overlap.reason, "delivery_quarantined");
  assert.equal(JSON.stringify(overlap).includes(audience[0].line_user_id), false);
  const unknownAudience = db2.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "legacy",
    ownerToken: "future-unproven", leaseDurationMs: 60_000,
  });
  assert.equal(unknownAudience.reason, "delivery_quarantined", "unproven future audience blocks the whole OA");

  const scheduleOwner = "future-schedule-worker";
  const schedule = db2.createBroadcastSchedule({
    channelId: "default", messages: [{ type: "text", text: "scheduled" }],
    scheduledAt: clock - 1, previewCount: 1,
    audienceFingerprint: "stale-preview-fingerprint",
    confirmationHash: "critical-fault-schedule-confirmation",
    confirmationExpiresAt: clock + 60_000, createdBy: "owner",
  });
  db2.claimDueBroadcastSchedule({ ownerToken: scheduleOwner, leaseDurationMs: 60_000, at: clock });
  const scheduled = db2.claimBroadcast({
    channelId: "default", audience: [audience[0]], createdBy: "owner",
    ownerToken: "future-scheduled-broadcast", leaseDurationMs: 60_000,
    scheduleId: schedule.id, scheduleOwnerToken: scheduleOwner,
  });
  assert.equal(scheduled.reason, "delivery_quarantined");
  assert.equal(providerCalls, 1, "neither reopen nor future manual/scheduled claims can replay provider call");

  assert.equal(db2.cancelBroadcastSchedule(schedule.id, "owner").outcome, "cancelled");
  const resolution = db2.resolveBroadcastDeliveryQuarantine({
    id: armed.id, channelId: "default", resolvedBy: "owner",
    resolution: "confirmed_not_delivered", reason: "ตรวจ provider log แล้วว่าไม่รับรายการ",
  });
  assert.equal(resolution.outcome, "resolved");
  const releasedOwner = "after-durable-human-resolution";
  const released = db2.claimBroadcast({
    channelId: "default", audience: [audience[0]], createdBy: "owner",
    ownerToken: releasedOwner, leaseDurationMs: 60_000, manual: true,
  });
  assert.equal(released.ok, true, "only a durable owner/admin resolution releases the guard");
  assert.equal(providerCalls, 1);
  assert.equal(db2.finalizeBroadcastClaim("default", released.row.id, releasedOwner, { status: "failed" }), true);
});

test("B-13 unresolved delivery quarantine survives DB reopen", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "broadcast-quarantine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "live.sqlite");
  const db1 = openDb({ file });
  const audience = Array.from({ length: BROADCAST_BATCH_SIZE + 1 }, (_, index) => {
    const lineUserId = `U-durable-${String(index).padStart(3, "0")}`;
    db1.upsertCustomer(lineUserId, {});
    return { line_user_id: lineUserId };
  });
  const engine = createBroadcastEngine({
    db: db1, config: {}, guard: createComplianceGuard({ getApprovedPrices: () => [] }), logger: silent,
    line: {
      sendAllowed: () => true,
      async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
      async multicast() { return { ok: false, status: 500 }; },
    },
  });
  const first = db1.claimBroadcast({
    channelId: "default", audience, createdBy: "owner",
    ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
  });
  await engine.runSend({
    broadcastId: first.row.id, channelId: "default", audience,
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }],
    operator: "owner", claimOwnerToken: engine.broadcastOwnerToken,
  });
  db1.close();

  const db2 = openDb({ file });
  const persisted = db2.unresolvedBroadcastDeliveryQuarantine("default", audience);
  assert.ok(persisted, "quarantine row remains after a fresh DB process opens the file");
  const blocked = db2.claimBroadcast({
    channelId: "default", audience, createdBy: "owner",
    ownerToken: "after-reopen", leaseDurationMs: 60_000,
  });
  assert.equal(blocked.reason, "delivery_quarantined");
  db2.close();
});

test("B-5/B-12: recipient ledger ครบ และ cancel หยุดก่อน batch ถัดไป", async () => {
  const db = memoryDb();
  const audience = Array.from({ length: BROADCAST_BATCH_SIZE + 1 }, (_, index) => {
    const lineUserId = `U-cancel-${String(index).padStart(3, "0")}`;
    db.upsertCustomer(lineUserId, {});
    return { line_user_id: lineUserId, display_name: "", known_name: "" };
  });
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  let calls = 0;
  let claim;
  const engine = createBroadcastEngine({
    db, config: {}, guard, logger: silent,
    line: {
      sendAllowed: () => true,
      async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
      async multicast() {
        calls += 1;
        db.requestBroadcastCancel(claim.row.id, "owner");
        return { ok: true };
      },
    },
  });
  claim = db.claimBroadcast({
    channelId: "default", audience, createdBy: "owner",
    ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
  });
  assert.equal(claim.ok, true);
  assert.deepEqual(db.broadcastRecipientSummary(claim.row.id), {
    queued: BROADCAST_BATCH_SIZE + 1, sent: 0, failed: 0, skipped: 0, cancelled: 0,
  });
  const result = await engine.runSend({
    broadcastId: claim.row.id, channelId: "default", audience,
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }],
    operator: "owner", claimOwnerToken: engine.broadcastOwnerToken,
  });
  assert.equal(calls, 1, "cancel request observed before second provider call");
  assert.deepEqual(result, { sent: BROADCAST_BATCH_SIZE, failed: 0, skipped: 0, cancelled: 1 });
  assert.deepEqual(db.broadcastRecipientSummary(claim.row.id), {
    queued: 0, sent: BROADCAST_BATCH_SIZE, failed: 0, skipped: 0, cancelled: 1,
  });
  assert.equal(db.getBroadcast(claim.row.id).status, "partial");
  db.close();
});

test("REGRESSION: cancel ระหว่าง provider call ที่ยังไม่รู้ผล ไม่ abort/retry และหยุดก่อน batch ถัดไป", async () => {
  const db = memoryDb();
  const audience = Array.from({ length: BROADCAST_BATCH_SIZE + 2 }, (_, index) => {
    const lineUserId = `U-inflight-${String(index).padStart(3, "0")}`;
    db.upsertCustomer(lineUserId, {});
    return { line_user_id: lineUserId, display_name: "", known_name: "" };
  });
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  let calls = 0;
  let resolveFirst;
  const firstResult = new Promise((resolve) => { resolveFirst = resolve; });
  const engine = createBroadcastEngine({
    db, config: {}, guard, logger: silent,
    line: {
      sendAllowed: () => true,
      async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
      async multicast() { calls += 1; return firstResult; },
    },
  });
  const claim = db.claimBroadcast({
    channelId: "default", audience, createdBy: "owner",
    ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
  });
  const run = engine.runSend({
    broadcastId: claim.row.id, channelId: "default", audience,
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }],
    operator: "owner", claimOwnerToken: engine.broadcastOwnerToken,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "first provider call is in flight");
  db.requestBroadcastCancel(claim.row.id, "owner");
  assert.equal(calls, 1, "cancel must not abort or make a second provider attempt while outcome is unresolved");
  resolveFirst({ ok: true });
  const result = await run;
  assert.deepEqual(result, { sent: BROADCAST_BATCH_SIZE, failed: 0, skipped: 0, cancelled: 2 });
  assert.equal(calls, 1, "resolved first batch must not be retried and next batch stays cancelled");
  assert.deepEqual(db.broadcastRecipientSummary(claim.row.id), {
    queued: 0, sent: BROADCAST_BATCH_SIZE, failed: 0, skipped: 0, cancelled: 2,
  });
  db.close();
});

test("REGRESSION: quota unknown ระหว่าง batch ต้อง fail-closed ก่อนแตะ LINE", async () => {
  const db = memoryDb();
  db.upsertCustomer("U-quota-unknown", {});
  const row = db.createBroadcast({ channelId: "default", messages: [], audienceCount: 1, createdBy: "nok" });
  let multicastCalls = 0;
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  const engine = createBroadcastEngine({
    db, config: {}, guard, logger: silent,
    line: {
      async getQuota() { return null; },
      async multicast() { multicastCalls += 1; return { ok: true }; },
    },
  });
  const result = await engine.runSend({
    broadcastId: row.id, channelId: "default", audience: db.broadcastAudience({ channelId: "default" }),
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
  });
  assert.equal(multicastCalls, 0);
  assert.deepEqual(result, { sent: 0, failed: 1, skipped: 0 });
  assert.match(db.getBroadcast(row.id).last_error, /โควตา LINE/);
  db.close();
});

test("lineClient.multicast ส่ง X-Line-Retry-Key ที่ caller ระบุ", async () => {
  const calls = [];
  const client = createLineClient({
    config: {
      lineMockUrl: "http://line.mock", lineLiveSend: false,
      lineChannelAccessToken: "", lineTimeoutMs: 1_000,
    },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200 };
    },
    logger: silent,
  });
  const retryKey = "00000000-0000-4000-8000-000000000001";
  const result = await client.multicast({
    to: ["U-one"], messages: [{ type: "text", text: "x" }], retryKey,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].options.headers["x-line-retry-key"], retryKey);
});

test("REGRESSION: runSend revalidates queued recipients before each batch when DND/consent changes", async () => {
  const db = memoryDb();
  const recipientCount = BROADCAST_BATCH_SIZE + 2;
  for (let i = 0; i < recipientCount; i += 1) {
    db.upsertCustomer(`U-r${String(i).padStart(3, "0")}`, {});
  }
  const audience = db.broadcastAudience({ channelId: "default" });
  const dndBeforeStart = audience[0].line_user_id;
  const consentBeforeStart = audience[1].line_user_id;
  const dndBetweenBatches = audience.at(-2).line_user_id;
  const consentBetweenBatches = audience.at(-1).line_user_id;
  db.setDoNotDisturb(dndBeforeStart, true);
  db.raw.prepare("UPDATE customers SET marketing_consent = -1 WHERE line_user_id = ?").run(consentBeforeStart);

  let multicastNumber = 0;
  // Change the final batch only after batch one has been revalidated and sent.
  const calls = [];
  const changingLine = {
    async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
    async multicast(args) {
      calls.push(args);
      multicastNumber += 1;
      if (multicastNumber === 1) {
        db.setDoNotDisturb(dndBetweenBatches, true);
        db.raw.prepare("UPDATE customers SET marketing_consent = -1 WHERE line_user_id = ?")
          .run(consentBetweenBatches);
      }
      return { ok: true };
    },
  };
  const guard = createComplianceGuard({ getApprovedPrices: () => db.approvedPrices() });
  const revalidationEngine = createBroadcastEngine({ db, config: {}, guard, line: changingLine, logger: silent });
  const row = claimForRun(db, revalidationEngine, audience);
  const result = await revalidationEngine.runSend({
    broadcastId: row.id, channelId: "default", audience,
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
    claimOwnerToken: revalidationEngine.broadcastOwnerToken,
  });

  assert.equal(calls.length, 1, "opt-out/consent ที่เปลี่ยนก่อนเริ่มและก่อน batch ถัดไปต้องไม่ถูกส่ง");
  assert.equal(result.sent, BROADCAST_BATCH_SIZE - 2);
  assert.equal(result.failed, 0, "ผู้รับที่สิทธิ์เปลี่ยนไม่ใช่ LINE failure");
  assert.equal(result.skipped, 4, "เก็บเป็น skipped เพื่อไม่ปนกับ LINE failure");
  assert.equal(calls[0].to.includes(dndBeforeStart), false);
  assert.equal(calls[0].to.includes(consentBeforeStart), false);
  for (const id of [dndBeforeStart, consentBeforeStart, dndBetweenBatches, consentBetweenBatches]) {
    assert.equal(db.messagesFor(id).filter((message) => message.direction === "out").length, 0, `${id} ไม่มี history ว่าส่ง`);
  }
  assert.match(db.listAudit().find((entry) => entry.action === "broadcast_done").detail, /ตัดสิทธิ์ระหว่างส่ง 4/);
  db.close();
});

test("REGRESSION: include/exclude tags ที่เปลี่ยนระหว่าง batches ถูกตัดก่อน multicast", async () => {
  const db = memoryDb();
  const recipientCount = BROADCAST_BATCH_SIZE + 2;
  for (let i = 0; i < recipientCount; i += 1) {
    const id = `U-tag-${String(i).padStart(3, "0")}`;
    db.upsertCustomer(id, {});
    db.addTag(id, "campaign", "human");
  }
  const includeTags = ["campaign"];
  const excludeTags = ["blocked"];
  const audience = db.broadcastAudience({ channelId: "default", includeTags, excludeTags });
  const lostInclude = audience.at(-2).line_user_id;
  const gainedExclude = audience.at(-1).line_user_id;
  const calls = [];
  const line = {
    async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
    async multicast(args) {
      calls.push(args);
      if (calls.length === 1) {
        db.removeTag(lostInclude, "campaign");
        db.addTag(gainedExclude, "blocked", "human");
      }
      return { ok: true };
    },
  };
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  const engine = createBroadcastEngine({ db, config: {}, guard, line, logger: silent });
  const row = claimForRun(db, engine, audience, { includeTags, excludeTags });

  const result = await engine.runSend({
    broadcastId: row.id, channelId: "default", audience, includeTags, excludeTags,
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
    claimOwnerToken: engine.broadcastOwnerToken,
  });

  assert.equal(calls.length, 1, "batch สองว่างหลัง tag recheck จึงห้ามเรียก LINE");
  assert.deepEqual(result, { sent: BROADCAST_BATCH_SIZE, failed: 0, skipped: 2 });
  for (const id of [lostInclude, gainedExclude]) {
    assert.equal(db.messagesFor(id).filter((message) => message.direction === "out").length, 0, `${id} ไม่มี outbound history`);
  }
  db.close();
});

test("REGRESSION: eligibility recheck พังต้อง fail-closed, ไม่ยิง LINE และปิดสถานะเป็น failed", async () => {
  const db = memoryDb();
  db.upsertCustomer("U-check-1", {});
  db.upsertCustomer("U-check-2", {});
  const audience = db.broadcastAudience({ channelId: "default" });
  const row = db.createBroadcast({ channelId: "default", messages: [], audienceCount: audience.length, createdBy: "nok" });
  db.broadcastAudience = () => { throw new Error("sqlite unavailable"); };
  let multicastCalls = 0;
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  const engine = createBroadcastEngine({
    db, config: {}, guard, logger: silent,
    line: { async getQuota() { return { type: "none", value: null, totalUsage: 0 }; }, async multicast() { multicastCalls += 1; return { ok: true }; } },
  });

  const result = await engine.runSend({
    broadcastId: row.id, channelId: "default", audience,
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
  });

  assert.equal(multicastCalls, 0, "ยืนยันสิทธิ์สดไม่ได้ = ห้ามแตะ LINE");
  assert.deepEqual(result, { sent: 0, failed: 2, skipped: 0 });
  const fresh = db.getBroadcast(row.id);
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.failed_count, 2);
  assert.match(fresh.last_error, /ตรวจสิทธิ์ผู้รับไม่สำเร็จ/);
  db.close();
});

/* --------------------------- v1.2 review fixes --------------------------- */

test("REVIEW FIX: consent — marketing_consent < 0 (ปฏิเสธ) ไม่มีวันติด audience", () => {
  const db = memoryDb();
  db.upsertCustomer("U-ok", {});
  db.upsertCustomer("U-refused", {});
  db.raw.prepare("UPDATE customers SET marketing_consent = -1 WHERE line_user_id = 'U-refused'").run();
  const audience = db.broadcastAudience({ channelId: "default" });
  assert.deepEqual(audience.map((c) => c.line_user_id), ["U-ok"], "คนปฏิเสธ marketing ต้องหลุดเสมอ");
  db.close();
});

test("REVIEW FIX: sendReady — ช่องส่ง fail-closed = ปฏิเสธตั้งแต่ต้น ไม่รับงานแล้วล้มเงียบ", () => {
  const db = memoryDb();
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  const engine = createBroadcastEngine({
    db, config: {}, guard, logger: silent,
    line: { sendAllowed: () => false, async multicast() { return { ok: true }; } },
  });
  const ready = engine.sendReady("default");
  assert.equal(ready.ok, false);
  assert.match(ready.error, /ยังไม่พร้อม/);
  db.close();
});

test("REVIEW FIX: runSend เก็บเหตุผลล้มเหลว (last_error) — blocked ต้องไม่หายเงียบ", async () => {
  const db = memoryDb();
  db.upsertCustomer("U-x", {});
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  const engine = createBroadcastEngine({
    db, config: {}, guard, logger: silent,
    line: { sendAllowed: () => true, async getQuota() { return { type: "none", value: null, totalUsage: 0 }; }, async multicast() { return { ok: false, blocked: true, reason: "live_send_disabled" }; } },
  });
  const row = claimForRun(db, engine, [{ line_user_id: "U-x" }]);
  await engine.runSend({
    broadcastId: row.id, channelId: "default",
    audience: [{ line_user_id: "U-x", display_name: "", known_name: "" }],
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
    claimOwnerToken: engine.broadcastOwnerToken,
  });
  const fresh = db.getBroadcast(row.id);
  assert.equal(fresh.status, "failed");
  assert.match(fresh.last_error, /live_send_disabled/, "เหตุผลต้องถูกเก็บ");
  db.close();
});

test("REVIEW FIX: activeBroadcastFor + lastBroadcastAt — lock กันส่งซ้อน/cooldown", () => {
  const db = memoryDb();
  const row = db.createBroadcast({ channelId: "default", messages: [], audienceCount: 5, createdBy: "nok" });
  assert.equal(db.activeBroadcastFor("default")?.id, row.id, "sending = active");
  assert.equal(db.activeBroadcastFor("shinchan"), null, "คนละสาขาไม่ล็อกกัน");
  assert.ok(db.lastBroadcastAt("default") > 0);
  db.updateBroadcastProgress(row.id, { status: "done" });
  assert.equal(db.activeBroadcastFor("default"), null, "จบแล้ว = ปลดล็อก");
  db.close();
});

test("REVIEW FIX: เปิด DB ใหม่ (จำลอง restart) — broadcasts ค้าง 'sending' ถูกปิดเป็น failed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bc-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "t.sqlite");
  const db1 = openDb({ file });
  const row = db1.createBroadcast({ channelId: "default", messages: [], audienceCount: 100, createdBy: "nok" });
  db1.updateBroadcastProgress(row.id, { sentCount: 40 });
  db1.close();
  const db2 = openDb({ file }); // จำลอง process restart
  const fresh = db2.getBroadcast(row.id);
  assert.equal(fresh.status, "failed", "ห้ามค้าง sending ตลอดกาล");
  assert.match(fresh.last_error, /lease/);
  assert.equal(fresh.sent_count, 40, "ยอดที่ส่งแล้วไม่หาย — คนอ่านรู้ว่าส่งถึงไหน");
  db2.close();
});

test("REGRESSION: DB connection ที่สองรักษา live lease และ reclaim ได้หลังหมดอายุเท่านั้น", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bc-two-process-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "live.sqlite");
  let clock = 1_000_000;
  const now = () => clock;
  const db1 = openDb({ file, now });
  const first = db1.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "one",
    ownerToken: "process-one", leaseDurationMs: 60_000,
  });
  assert.equal(first.ok, true);

  const db2 = openDb({ file, now });
  assert.equal(db2.getBroadcast(first.row.id).status, "sending", "second open must preserve a non-expired lease");
  const blocked = db2.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "two",
    ownerToken: "process-two", leaseDurationMs: 60_000,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "active");
  assert.equal(db2.listBroadcasts().length, 1);

  clock += 60_001;
  const reclaimed = db2.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "two",
    ownerToken: "process-two", leaseDurationMs: 60_000,
  });
  assert.equal(reclaimed.ok, true, "expired lease may be reclaimed atomically");
  assert.equal(db2.getBroadcast(first.row.id).status, "failed");
  assert.match(db2.getBroadcast(first.row.id).last_error, /lease/);
  assert.equal(db1.releaseBroadcastClaim("default", first.row.id, "process-one"), false,
    "old process cannot delete successor claim");
  assert.equal(db2.raw.prepare("SELECT owner_token FROM broadcast_channel_claims WHERE channel_id = 'default'").get().owner_token, "process-two");
  db2.close();
  db1.close();
});

test("REGRESSION: runSend exception finalizes failed row and releases only its matching claim", async () => {
  const db = memoryDb();
  db.upsertCustomer("U-finally", {});
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  let multicastCalls = 0;
  const engine = createBroadcastEngine({
    db, config: {}, guard, logger: silent,
    line: {
      async getQuota() { return { type: "none", value: null, totalUsage: 0 }; },
      async multicast() { multicastCalls += 1; return { ok: true }; },
    },
  });
  const claim = db.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "nok",
    ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
  });
  assert.equal(claim.ok, true);
  db.renewBroadcastClaim = () => { throw new Error("heartbeat crashed"); };
  await assert.rejects(engine.runSend({
    broadcastId: claim.row.id, channelId: "default", audience: db.broadcastAudience({ channelId: "default" }),
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
    claimOwnerToken: engine.broadcastOwnerToken,
  }), /heartbeat crashed/);
  assert.equal(multicastCalls, 0);
  const fresh = db.getBroadcast(claim.row.id);
  assert.equal(fresh.status, "failed");
  assert.match(fresh.last_error, /heartbeat crashed/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM broadcast_channel_claims").get().n, 0);
  db.close();
});

test("REGRESSION: atomic finalize failure rolls back and preserves claim until lease-expiry reclaim", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bc-finalize-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "live.sqlite");
  let clock = 3_000_000;
  const now = () => clock;
  const db1 = openDb({ file, now });
  db1.upsertCustomer("U-finalize-fail", {});
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  let multicastCalls = 0;
  const engine = createBroadcastEngine({
    db: db1, config: {}, guard, logger: silent,
    line: {
      async getQuota() { return null; },
      async multicast() { multicastCalls += 1; return { ok: true }; },
    },
  });
  const claim = db1.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "one",
    ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
  });
  db1.raw.exec(`CREATE TRIGGER fail_broadcast_finalize
    BEFORE UPDATE OF status ON broadcasts WHEN NEW.id = '${claim.row.id}'
    BEGIN SELECT RAISE(ABORT, 'injected finalize failure'); END`);

  const result = await engine.runSend({
    broadcastId: claim.row.id, channelId: "default", audience: db1.broadcastAudience({ channelId: "default" }),
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
    claimOwnerToken: engine.broadcastOwnerToken,
  });
  assert.deepEqual(result, { sent: 0, failed: 1, skipped: 0 });
  assert.equal(multicastCalls, 0);
  assert.equal(db1.getBroadcast(claim.row.id).status, "sending", "terminal update rollback keeps original row state");
  assert.equal(db1.raw.prepare("SELECT COUNT(*) AS n FROM broadcast_channel_claims WHERE broadcast_id = ?").get(claim.row.id).n, 1,
    "claim must remain when atomic terminal update fails");

  db1.raw.exec("DROP TRIGGER fail_broadcast_finalize");
  clock += 60_001;
  const db2 = openDb({ file, now });
  const successor = db2.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "two",
    ownerToken: "process-two", leaseDurationMs: 60_000,
  });
  assert.equal(successor.ok, true, "expired preserved claim is recoverable, not a permanent active lock");
  assert.equal(db2.getBroadcast(claim.row.id).status, "failed");
  db2.close();
  db1.close();
});

test("REGRESSION: claim-delete failure rolls terminal status back in the same transaction", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bc-finalize-delete-fail-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "live.sqlite");
  let clock = 4_000_000;
  const now = () => clock;
  const db1 = openDb({ file, now });
  db1.upsertCustomer("U-finalize-delete-fail", {});
  const guard = createComplianceGuard({ getApprovedPrices: () => [] });
  let multicastCalls = 0;
  const engine = createBroadcastEngine({
    db: db1, config: {}, guard, logger: silent,
    line: {
      async getQuota() { return null; },
      async multicast() { multicastCalls += 1; return { ok: true }; },
    },
  });
  const claim = db1.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "one",
    ownerToken: engine.broadcastOwnerToken, leaseDurationMs: 60_000,
  });
  db1.raw.exec(`CREATE TRIGGER fail_broadcast_claim_delete
    BEFORE DELETE ON broadcast_channel_claims WHEN OLD.broadcast_id = '${claim.row.id}'
    BEGIN SELECT RAISE(ABORT, 'injected claim delete failure'); END`);

  const result = await engine.runSend({
    broadcastId: claim.row.id, channelId: "default", audience: db1.broadcastAudience({ channelId: "default" }),
    messages: [{ type: "text", text: "x" }], storedMessages: [{ type: "text", text: "x" }], operator: "nok",
    claimOwnerToken: engine.broadcastOwnerToken,
  });
  assert.deepEqual(result, { sent: 0, failed: 1, skipped: 0 });
  assert.equal(multicastCalls, 0);
  assert.equal(db1.getBroadcast(claim.row.id).status, "sending",
    "claim delete failure must roll the preceding terminal status update back");
  assert.equal(db1.raw.prepare("SELECT COUNT(*) AS n FROM broadcast_channel_claims WHERE broadcast_id = ?").get(claim.row.id).n, 1,
    "claim delete failure must preserve the matching claim");

  db1.raw.exec("DROP TRIGGER fail_broadcast_claim_delete");
  clock += 60_001;
  const db2 = openDb({ file, now });
  const successor = db2.claimBroadcast({
    channelId: "default", audienceCount: 1, createdBy: "two",
    ownerToken: "process-two", leaseDurationMs: 60_000,
  });
  assert.equal(successor.ok, true, "expired claim remains recoverable after atomic rollback");
  assert.equal(db2.getBroadcast(claim.row.id).status, "failed");
  db2.close();
  db1.close();
});

test("migration: broadcasts เก่ารับสถานะ partial และเก็บ progress เดิมครบ", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bc-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE broadcasts (
      id TEXT PRIMARY KEY, channel_id TEXT NOT NULL DEFAULT 'default', messages_json TEXT NOT NULL DEFAULT '[]',
      include_tags_json TEXT NOT NULL DEFAULT '[]', exclude_tags_json TEXT NOT NULL DEFAULT '[]',
      audience_count INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'sending'
        CHECK (status IN ('sending','done','failed')), last_error TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO broadcasts (id, audience_count, sent_count, failed_count, status, created_at, updated_at)
    VALUES ('legacy-row', 10, 4, 1, 'done', 1, 1);
  `);
  legacy.close();

  const db = openDb({ file });
  const migrated = db.getBroadcast("legacy-row");
  assert.equal(migrated.sent_count, 4);
  assert.equal(migrated.failed_count, 1);
  assert.equal(migrated.last_sent_index, -1);
  assert.equal(db.updateBroadcastProgress("legacy-row", { status: "partial", lastSentIndex: 3 }), true);
  assert.equal(db.getBroadcast("legacy-row").status, "partial");
  assert.equal(db.getBroadcast("legacy-row").last_sent_index, 3);
  db.close();
});

test("REVIEW FIX: tagSummary รวมป้ายชื่อเดียวกันข้าม source เป็นชิปเดียว (นับคนไม่เบิ้ล)", () => {
  const db = memoryDb();
  db.upsertCustomer("U-1", {});
  db.upsertCustomer("U-2", {});
  db.addTag("U-1", "VIP", "human");
  db.addTag("U-2", "VIP", "rfm");
  const summary = db.tagSummary();
  assert.equal(summary.length, 1, "ป้ายเดียว ไม่แยกตาม source");
  assert.equal(summary[0].customer_count, 2);
  assert.equal(summary[0].source, "human", "source ลำดับสูงสุดชนะ");
  db.close();
});
