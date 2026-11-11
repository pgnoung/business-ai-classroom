import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, FB_MESSAGING_WINDOW_MS } from "../src/db.mjs";
import { createStagedFollowups } from "../src/stagedFollowups.mjs";
import { createFollowupEngine } from "../src/followupEngine.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createFacebookClient } from "../src/facebookClient.mjs";
import { summarizeUsage, pricingById, usageCostUsd } from "../src/modelPricing.mjs";
import { memoryDb, testConfig, poisonGlobalFetch } from "./helpers.mjs";
poisonGlobalFetch();
const NOON = Date.parse("2026-09-13T12:00:00+07:00");
const MIN = 60_000;
const DAY = 86_400_000;
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function world(t, { channel = "default", age = 2 * 60 * MIN, text = "สนใจคุยเรื่องการใช้งานต่อไหมคะ", onDraft, onSend } = {}) {
  const clock = { now: NOON };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  const id = `${channel}:synthetic-cost-audit`;
  db.upsertCustomer(id, { channelId: channel });
  db.setFollowupEnabled(id, true);
  db.recordScore(id, 7, "{}");
  clock.now -= age;
  db.insertMessage({ customerId: id, direction: "in", msgType: "text", content: "สนใจค่ะ" });
  clock.now += 1000;
  db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: "ยินดีค่ะ" });
  clock.now = NOON;
  const counts = { drafts: 0, sends: 0 };
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0", FOLLOWUP_ENABLED: "true" });
  const hermes = { async draftReply(args) {
    counts.drafts += 1;
    await onDraft?.({ db, id, clock, args });
    return { text, model: "gpt-5.6-sol", usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 70 } } };
  } };
  const line = { async sendBubbles(args) {
    counts.sends += 1;
    return onSend ? onSend({ db, id, clock, args }) : { ok: true, acceptedRequestMessages: args.bubbles.map(b => ({ type: "text", text: b.text })) };
  } };
  const deps = { config, db, hermes, line,
    lineRegistry: { forChannel: () => line, rawUserId: x => x },
    guard: createComplianceGuard({ bannedWords: ["การันตี"], getApprovedPrices: () => [] }),
    humanizer: createHumanizer(), logger: silent, now: () => clock.now, imageCatalog: [] };
  return { db, id, counts, clock, deps, engine: createStagedFollowups(deps) };
}

test("expired Facebook room: repeated ticks and restart make ZERO paid drafts or sends", async t => {
  const w = world(t, { channel: "facebook", age: 8 * DAY });
  for (let n = 0; n < 6; n++) {
    await createStagedFollowups(w.deps).runOnce();
    w.clock.now += MIN;
  }
  assert.deepEqual(w.counts, { drafts: 0, sends: 0 });
  assert.equal(w.db.llmUsageForCustomer(w.id).length, 0);
  assert.equal(w.db.getProactiveAttempt(w.id), null);
});

test("empty/duplicate draft cannot regenerate through each asset fallback or every tick", async t => {
  const w = world(t, { text: "" });
  w.db.addKnowledge({ title: "รีวิว", content: "[Classroom : AI Agent For Business]\n- ผู้เรียน — ธุรกิจ | รีวิว: https://www.facebook.com/share/r/TESTONLY/", updatedBy: "test" });
  await w.engine.runOnce();
  assert.equal(w.counts.drafts, 1);
  assert.equal(w.db.llmUsageForCustomer(w.id)[0].cached_in, 70, "empty text still cost money");
  for (let n = 0; n < 5; n++) { w.clock.now += MIN; await createStagedFollowups(w.deps).runOnce(); }
  assert.equal(w.counts.drafts, 1);
  w.clock.now = NOON + 15 * MIN;
  await w.engine.runOnce();
  w.clock.now = NOON + 45 * MIN;
  await w.engine.runOnce();
  w.clock.now = NOON + 110 * MIN;
  assert.equal((await w.engine.runOnce()).results[0].skipped, "attempt_limit");
  assert.equal(w.counts.drafts, 3);
  assert.equal(w.counts.sends, 0);
  w.db.insertMessage({ customerId: w.id, direction: "in", msgType: "text", content: "ขอข้อมูลต่อค่ะ" });
  w.clock.now += 50 * MIN;
  await w.engine.runOnce();
  assert.equal(w.counts.drafts, 4, "new inbound starts a new bounded episode");
});

test("guard-rejected drafts have durable backoff, not a paid loop", async t => {
  const w = world(t, { text: "การันตีผลค่ะ" });
  assert.match((await w.engine.runOnce()).results[0].skipped, /^guard_blocked/);
  w.clock.now += MIN;
  assert.equal((await createStagedFollowups(w.deps).runOnce()).results[0].skipped, "attempt_backoff");
  assert.deepEqual(w.counts, { drafts: 1, sends: 0 });
});

test("failed or ambiguous provider send is fenced before I/O and never automatically replayed", async t => {
  const w = world(t, { onSend: ({ db, id }) => {
    assert.equal(db.getProactiveAttempt(id).status, "sending");
    throw new Error("synthetic ambiguous timeout");
  } });
  await w.engine.runOnce();
  w.clock.now += 60 * MIN;
  assert.equal((await createStagedFollowups(w.deps).runOnce()).results[0].skipped, "delivery_fenced");
  assert.deepEqual(w.counts, { drafts: 1, sends: 1 });
});

test("partial acceptance followed by stop does not replay accepted bubbles", async t => {
  const w = world(t, { onSend: ({ args }) => ({ ok: false, stoppedEarly: true,
    delivered: [{ type: "text", text: args.bubbles[0].text }] }) });
  const first = await w.engine.runOnce();
  assert.equal(first.results[0].partial, true);
  w.clock.now += 60 * MIN;
  await createStagedFollowups(w.deps).runOnce();
  assert.deepEqual(w.counts, { drafts: 1, sends: 1 });
  assert.equal(w.db.messagesFor(w.id, 20).filter(m => m.message_class === "proactive").length, 1);
});

test("two concurrent ticks cannot double-draft or double-send", async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const w = world(t, { onDraft: () => pending });
  const first = w.engine.runOnce();
  const second = await w.engine.runOnce();
  assert.equal(second.skipped, "run_in_flight");
  release();
  await first;
  assert.deepEqual(w.counts, { drafts: 1, sends: 1 });
});

test("scheduled Facebook follow-up checks window and operator pause before paying", async t => {
  for (const channel of ["facebook", "default"]) {
    const w = world(t, { channel, age: 8 * DAY });
    if (channel === "default") w.db.raw.prepare("UPDATE customers SET operator_active_until=? WHERE line_user_id=?").run(NOON + 60 * MIN, w.id);
    const row = w.db.createFollowup({ customerId: w.id, scheduledAt: NOON - 1, createdBy: "test" });
    const result = await createFollowupEngine(w.deps).processFollowup(row);
    assert.equal(result.detail, channel === "facebook" ? "fb_window_closed" : "operator_active");
    assert.deepEqual(w.counts, { drafts: 0, sends: 0 });
  }
});

test("consent revoked while drafting prevents both staged and scheduled sends", async t => {
  for (const lane of ["staged", "scheduled"]) {
    const w = world(t, { onDraft: ({ db, id }) => db.raw.prepare("UPDATE customers SET marketing_consent=-1 WHERE line_user_id=?").run(id) });
    if (lane === "staged") await w.engine.runOnce();
    else {
      const row = w.db.createFollowup({ customerId: w.id, scheduledAt: NOON - 1, createdBy: "test" });
      await createFollowupEngine(w.deps).processFollowup(row);
    }
    assert.deepEqual(w.counts, { drafts: 1, sends: 0 });
  }
});

test("a real Facebook client rechecks the time window BETWEEN accepted messages", async t => {
  const w = world(t, { channel: "facebook", age: FB_MESSAGING_WINDOW_MS - 2000, text: "ยินดีค่ะ" });
  let providerCalls = 0;
  const facebook = createFacebookClient({ config: { ...w.deps.config, fbMockUrl: "http://fb.test", fbLiveSend: false }, logger: silent,
    fetchImpl: async () => { providerCalls++; w.clock.now += 3000; return { ok: true, status: 200 }; }, sleep: async () => {} });
  w.deps.humanizer = { humanize: () => [{ text: "ข้อความแรกค่ะ" }, { text: "ข้อความที่สองค่ะ" }] };
  w.deps.lineRegistry.forChannel = () => facebook;
  const result = await createStagedFollowups(w.deps).runOnce();
  assert.equal(providerCalls, 1, JSON.stringify(result));
  assert.equal(result.results[0].partial, true);
});

test("attempt fence survives actual DB reopen; reset clears only the target", t => {
  const dir = mkdtempSync(join(tmpdir(), "proactive-fence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "test.sqlite");
  let db = openDb({ file });
  for (const id of ["synthetic-a", "synthetic-b"]) {
    db.upsertCustomer(id, {});
    assert.equal(db.claimProactiveAttempt(id, "staged", "episode:step", NOON).ok, true);
    assert.equal(db.fenceProactiveSend(id, "staged", "episode:step", NOON), true);
  }
  db.close();
  db = openDb({ file });
  t.after(() => db.close());
  assert.equal(db.claimProactiveAttempt("synthetic-a", "staged", "different-job", NOON + DAY).ok, true);
  assert.equal(db.claimProactiveAttempt("synthetic-a", "staged", "episode:step", NOON + DAY).reason, "delivery_fenced");
  db.resetCustomer("synthetic-a");
  assert.equal(db.getProactiveAttempt("synthetic-a"), null);
  assert.equal(db.getProactiveAttempt("synthetic-b").status, "sending");
});

test("customer cost and overview use the SAME cached input totals", t => {
  const db = memoryDb(); t.after(() => db.close());
  db.upsertCustomer("synthetic-cost", {});
  const pricing = pricingById([{ id: "sol", inUsdPerM: 4, cachedInUsdPerM: 0.4, outUsdPerM: 20, verified: true }]);
  db.addLlmUsage({ customerId: "synthetic-cost", kind: "staged_followup", model: "sol", tokensIn: 100000, cachedIn: 90000, tokensOut: 1000 });
  const room = summarizeUsage(db.llmUsageForCustomer("synthetic-cost"), pricing);
  const overview = summarizeUsage(db.llmUsageSummary(), pricing);
  assert.equal(room.usd, overview.usd);
  assert.equal(room.breakdown[0].cachedIn, 90000);
  assert.equal(room.usd, 0.096);
});

test("negative/infinite usage and unverified prices cannot create fake money totals", () => {
  const pricing = pricingById([{ id: "unverified", inUsdPerM: 4, outUsdPerM: 20, verified: false },
    { id: "known", inUsdPerM: 4, outUsdPerM: 20, cachedInUsdPerM: 0.4, verified: true }]);
  assert.equal(usageCostUsd({ model: "unverified", tokensIn: 100 }, pricing), null);
  assert.equal(usageCostUsd({ model: "known", tokensIn: -100, tokensOut: -20 }, pricing), 0);
  assert.equal(usageCostUsd({ model: "known", tokensIn: Infinity, tokensOut: NaN }, pricing), 0);
});
