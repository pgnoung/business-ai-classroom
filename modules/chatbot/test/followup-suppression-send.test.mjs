import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createFollowupEngine } from "../src/followupEngine.mjs";
import { createStagedFollowups, previewStagedFollowup } from "../src/stagedFollowups.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0);
const HOUR = 60 * 60 * 1000;
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function manualWorld({ onHermesCall, line = null } = {}) {
  const db = memoryDb({ now: () => NOON_BKK });
  const config = testConfig({ FOLLOWUP_ENABLED: "true" });
  const lineFetch = lineFetchStub();
  const hermesFetch = hermesFetchStub("วันก่อนคุยกันค้างไว้ สะดวกคุยต่อไหมคะ", { onCall: onHermesCall });
  const engine = createFollowupEngine({
    config, db,
    hermes: createHermesBridge({ config, fetchImpl: hermesFetch, logger: silent }),
    line: line ?? createLineClient({ config, fetchImpl: lineFetch, sleep: async () => {}, logger: silent }),
    guard: createComplianceGuard({ getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(), logger: silent, now: () => NOON_BKK,
  });
  return { db, engine, lineFetch };
}

function stagedWorld({ onHermesCall, sendBubbles, imageCatalog = [] } = {}) {
  const db = memoryDb({ now: () => NOON_BKK });
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0" });
  const hermesFetch = hermesFetchStub("วันก่อนคุยกันค้างไว้ สะดวกคุยต่อไหมคะ", { onCall: onHermesCall });
  const pushes = [];
  const engine = createStagedFollowups({
    config, db,
    hermes: createHermesBridge({ config, fetchImpl: hermesFetch, logger: silent }),
    lineRegistry: {
      forChannel: () => ({ sendBubbles: async (args) => {
        pushes.push(args);
        return sendBubbles ? sendBubbles(args) : { ok: true };
      } }),
      rawUserId: (id) => id,
    },
    guard: createComplianceGuard({ getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(), logger: silent, now: () => NOON_BKK, imageCatalog,
  });
  return { db, engine, pushes };
}

test("customer suppression cancels the manual job without changing DND, consent, or broadcast eligibility", () => {
  const { db } = manualWorld();
  const customerId = "U-manual-suppression";
  db.upsertCustomer(customerId, {});
  db.raw.prepare("UPDATE customers SET marketing_consent = 1 WHERE line_user_id = ?").run(customerId);
  const pending = db.createFollowup({ customerId, scheduledAt: NOON_BKK + HOUR, createdBy: "owner" });
  const audienceBefore = db.broadcastAudience({ channelId: "default" }).map((row) => row.line_user_id);

  db.suppressFollowupsForCustomer(customerId, "customer_will_return");

  const customer = db.getCustomer(customerId);
  assert.equal(db.getFollowup(pending.id).status, "cancelled");
  assert.equal(customer.do_not_disturb, 0);
  assert.equal(customer.marketing_consent, 1);
  assert.deepEqual(db.broadcastAudience({ channelId: "default" }).map((row) => row.line_user_id), audienceBefore);
  db.close();
});

test("manual follow-up suppression during draft cancels the job and blocks the provider send", async () => {
  let db;
  const world = manualWorld({ onHermesCall: () => db.suppressFollowupsForCustomer("U-manual-race", "customer_considering") });
  db = world.db;
  db.upsertCustomer("U-manual-race", {});
  const followup = db.createFollowup({ customerId: "U-manual-race", scheduledAt: NOON_BKK - 1, createdBy: "owner" });

  const result = await world.engine.runDue();

  assert.equal(result.results[0].status, "skipped");
  assert.equal(db.getFollowup(followup.id).status, "cancelled");
  assert.equal(world.lineFetch.sends.length, 0);
  db.close();
});

test("suppression after the first provider batch prevents later batches and returns only the delivered subset", async () => {
  const db = memoryDb();
  const customerId = "U-provider-interleave";
  db.upsertCustomer(customerId, {});
  let calls = 0;
  const client = createLineClient({
    config: testConfig(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) db.suppressFollowupsForCustomer(customerId, "accounting_documents");
      return { ok: true, status: 200, json: async () => ({}) };
    },
    logger: silent,
  });

  const result = await client.sendBubbles({
    to: customerId, batch: true,
    bubbles: Array.from({ length: 7 }, (_, index) => ({ text: `ข้อความ ${index + 1}` })),
    stillRelevant: () => db.getCustomer(customerId).followup_enabled === 1,
  });

  assert.equal(calls, 1, "suppression between provider batches must block the second request");
  assert.equal(result.ok, true);
  assert.equal(result.stoppedEarly, true);
  assert.deepEqual(result.delivered.map((message) => message.text), ["ข้อความ 1", "ข้อความ 2", "ข้อความ 3", "ข้อความ 4", "ข้อความ 5"]);
  db.close();
});

test("manual follow-up records a provider-reported partial delivery before completing the job", async () => {
  const partialLine = {
    sendBubbles: async () => ({ ok: false, status: 429, delivered: [{ type: "text", text: "ข้อความแรกถึงลูกค้าแล้ว" }] }),
  };
  const world = manualWorld({ line: partialLine });
  const customerId = "U-manual-partial";
  world.db.upsertCustomer(customerId, {});
  const followup = world.db.createFollowup({ customerId, scheduledAt: NOON_BKK - 1, createdBy: "owner" });

  const result = await world.engine.runDue();
  const row = world.db.getFollowup(followup.id);
  const delivered = world.db.messagesFor(customerId).filter((message) => message.direction === "out");

  assert.equal(result.results[0].status, "sent");
  assert.equal(result.results[0].partial, true);
  assert.equal(row.status, "sent");
  assert.equal(row.detail, "partial_delivery:1/1");
  assert.deepEqual(delivered.map((message) => message.content), ["ข้อความแรกถึงลูกค้าแล้ว"]);
  world.db.close();
});

test("manual follow-up stopped before any provider acceptance is skipped rather than marked sent", async () => {
  const world = manualWorld({ line: { sendBubbles: async () => ({ ok: true, stoppedEarly: true, delivered: [] }) } });
  const customerId = "U-manual-stopped-empty";
  world.db.upsertCustomer(customerId, {});
  const followup = world.db.createFollowup({ customerId, scheduledAt: NOON_BKK - 1, createdBy: "owner" });

  const result = await world.engine.runDue();

  assert.equal(result.results[0].status, "skipped");
  assert.equal(world.db.getFollowup(followup.id).status, "skipped");
  assert.equal(world.db.messagesFor(customerId).filter((message) => message.direction === "out").length, 0);
  world.db.close();
});

test("staged LINE-shaped partial delivery records only accepted text and image and does not advance the ladder", async () => {
  const customerId = "U-staged-image-partial-line";
  const image = { key: "classroom-atmosphere-1", url: "https://img.test/classroom.jpg", previewUrl: "https://img.test/classroom-preview.jpg" };
  const world = stagedWorld({
    imageCatalog: [image],
    sendBubbles: (args) => ({
      ok: true,
      stoppedEarly: true,
      delivered: [
        { type: "text", text: args.bubbles[0].text },
        { type: "image", originalContentUrl: args.images[0].url, previewImageUrl: args.images[0].previewUrl },
      ],
    }),
  });
  world.db.upsertCustomer(customerId, {});
  world.db.recordScore(customerId, 6, "{}");
  world.db.insertMessage({ customerId, direction: "in", content: "สนใจค่ะ" });
  world.db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(NOON_BKK - 3 * 24 * HOUR - HOUR, customerId);
  world.db.saveFollowupState(customerId, {
    ladder_stage: 1, stage_key: "warm", episode_anchor: NOON_BKK - 3 * 24 * HOUR - HOUR,
    today_key: "2026-01-15", history_json: "[]",
  });

  const result = await world.engine.runOnce();
  const delivered = world.db.messagesFor(customerId).filter((message) => message.direction === "out");
  const state = world.db.getFollowupState(customerId);

  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].delivered, 2);
  assert.deepEqual(delivered.map((message) => [message.msg_type, message.content]), [
    ["text", world.pushes[0].bubbles[0].text],
    ["image", `[image:${image.key}] ${image.url}`],
  ]);
  assert.equal(state.ladder_stage, 1, "partial send must not advance the ladder");
  assert.equal(world.db.listAudit(20).some((row) => row.action === "staged_followup_sent" && row.target === customerId), false);
  world.db.close();
});

test("staged Facebook-shaped partial delivery records only accepted text and image", async () => {
  const customerId = "U-staged-image-partial-facebook";
  const image = { key: "classroom-atmosphere-1", url: "https://img.test/fb-classroom.jpg", previewUrl: "https://img.test/fb-classroom-preview.jpg" };
  const world = stagedWorld({
    imageCatalog: [image],
    sendBubbles: (args) => ({
      ok: false, status: 500,
      delivered: [
        { type: "text", text: args.bubbles[0].text },
        { type: "image", originalContentUrl: args.images[0].url, previewImageUrl: args.images[0].previewUrl },
      ],
    }),
  });
  world.db.upsertCustomer(customerId, {});
  world.db.recordScore(customerId, 6, "{}");
  world.db.insertMessage({ customerId, direction: "in", content: "สนใจค่ะ" });
  world.db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(NOON_BKK - 3 * 24 * HOUR - HOUR, customerId);
  world.db.saveFollowupState(customerId, {
    ladder_stage: 1, stage_key: "warm", episode_anchor: NOON_BKK - 3 * 24 * HOUR - HOUR,
    today_key: "2026-01-15", history_json: "[]",
  });

  const result = await world.engine.runOnce();
  const delivered = world.db.messagesFor(customerId).filter((message) => message.direction === "out");

  assert.equal(result.results[0].partial, true);
  assert.equal(result.results[0].delivered, 2);
  assert.deepEqual(delivered.map((message) => [message.msg_type, message.content]), [
    ["text", world.pushes[0].bubbles[0].text],
    ["image", `[image:${image.key}] ${image.url}`],
  ]);
  assert.equal(world.db.getFollowupState(customerId).ladder_stage, 2, "accepted provider prefix must advance to prevent resend");
  assert.equal(world.db.listAudit(20).some((row) => row.action === "staged_followup_partial" && row.target === customerId), true);
  world.db.close();
});

test("staged follow-up suppression during draft blocks send and removes candidate and preview", async () => {
  let db;
  const world = stagedWorld({ onHermesCall: () => db.suppressFollowupsForCustomer("U-staged-race", "colleague_will_contact") });
  db = world.db;
  const customerId = "U-staged-race";
  db.upsertCustomer(customerId, {});
  db.recordScore(customerId, 6, "{}");
  db.insertMessage({ customerId, direction: "in", content: "สนใจค่ะ" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(NOON_BKK - 5 * HOUR, customerId);

  const result = await world.engine.runOnce();
  const customer = db.getCustomer(customerId);
  const preview = previewStagedFollowup({
    customer,
    state: db.getFollowupState(customerId),
    lastInboundAt: db.lastInboundAt(customerId),
    lastOutboundAt: db.lastOutboundAt(customerId),
    nowMs: NOON_BKK,
  });

  assert.equal(result.results[0].skipped, "superseded_before_send");
  assert.equal(world.pushes.length, 0);
  assert.equal(preview, null);
  assert.ok(!db.listStagedFollowupCandidates({ nowMs: NOON_BKK, activeWithinMs: 3 * 24 * HOUR })
    .some((row) => row.line_user_id === customerId));
  db.close();
});
