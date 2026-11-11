import test from "node:test";
import assert from "node:assert/strict";
import { selectFollowupKnowledge } from "../src/brain/followupKnowledge.mjs";
import { createFollowupEngine } from "../src/followupEngine.mjs";
import { createStagedFollowups } from "../src/stagedFollowups.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { memoryDb, testConfig } from "./helpers.mjs";

function card(id, content, metadata = null) {
  return {
    revId: `rev:${id}`, itemId: `fact:${id}`, kind: "fact", key: `fact:${id}`,
    inject: metadata ? "retrieve" : "pin", priority: 50,
    scope: { channel: "central" },
    body: { title: id, content, channel_id: null, provenance: metadata ? { knowledge: metadata } : {} },
  };
}

const BRAIN = {
  versionId: "brain-followup", bundle: {
    versionId: "brain-followup",
    guardTables: { approvedPrices: [{ label_th: "คลาส LINE", amount: 15900 }] },
    cards: [
      card("pin", "always"),
      card("line", "LINE only", { mode: "retrieve", domain: "LINE", offering: "OA", keywords: ["LINE"] }),
      card("fb", "FB only", { mode: "retrieve", domain: "Facebook", offering: "Ads", keywords: ["Facebook"] }),
    ],
  },
};

const db = { getSetting: () => "shared" };
const config = { brainRetrievalEnabled: true };

test("follow-up selection captures one ready brain and follows the latest user question", () => {
  let resolves = 0;
  const result = selectFollowupKnowledge({
    config, db, customerId: "opaque", channelId: "default", atMs: 1,
    brainRuntime: { resolve: () => { resolves += 1; return BRAIN; } },
    turns: [
      { role: "user", content: "Facebook" },
      { role: "assistant", content: "รับทราบ" },
      { role: "user", content: "ขอรายละเอียด LINE" },
    ],
  });
  assert.equal(resolves, 1);
  assert.equal(result.ok, true);
  assert.equal(result.brain.versionId, "brain-followup");
  assert.match(result.selection.knowledge, /always|LINE only/u);
  assert.doesNotMatch(result.selection.knowledge, /FB only/u);
  assert.equal(JSON.stringify(result.selection.trace).includes("รายละเอียด"), false);
});

test("follow-up retrieval holds before drafting when no immutable brain is ready", () => {
  const result = selectFollowupKnowledge({
    config, db, customerId: "opaque", channelId: "default", turns: [],
    brainRuntime: { resolve: () => null },
  });
  assert.deepEqual(result, { ok: false, reason: "brain_not_ready" });
});

test("follow-up retrieval holds when the runtime resolver throws", () => {
  const result = selectFollowupKnowledge({
    config, db, customerId: "opaque", channelId: "default", turns: [],
    brainRuntime: { resolve: () => { throw new Error("unavailable"); } },
  });
  assert.deepEqual(result, { ok: false, reason: "brain_not_ready" });
});

test("feature flag off leaves follow-up callers on their established path", () => {
  assert.equal(selectFollowupKnowledge({ config: { brainRetrievalEnabled: false } }), null);
});

test("regular follow-up uses selected facts, captured guard prices, and writes the selection receipt", async () => {
  const now = Date.UTC(2026, 0, 15, 5, 0, 0);
  const db = memoryDb({ now: () => now });
  db.upsertCustomer("U-fu-retrieval", {}); db.setFollowupEnabled("U-fu-retrieval", true);
  const due = db.createFollowup({ customerId: "U-fu-retrieval", scheduledAt: now - 1, createdBy: "test" });
  db.insertMessage({ customerId: "U-fu-retrieval", direction: "in", content: "สนใจ LINE" });
  let knowledge = ""; let approved = null; let sends = 0;
  const engine = createFollowupEngine({
    config: testConfig({ FOLLOWUP_ENABLED: "true", BRAIN_RETRIEVAL_ENABLED: "true" }), db, now: () => now,
    brainRuntime: { resolve: () => BRAIN },
    hermes: { draftReply: async (args) => { knowledge = args.knowledge; return { text: "ราคา 15,900 บาทค่ะ" }; } },
    line: { sendBubbles: async () => { sends += 1; return { ok: true }; } },
    guard: { checkOutbound: (_text, options) => { approved = options.approvedPrices; return { ok: true, violations: [] }; } },
    humanizer: createHumanizer(), logger: { warn() {}, error() {}, debug() {} },
  });
  const out = await engine.runDue();
  assert.equal(out.results[0].status, "sent"); assert.equal(sends, 1);
  assert.match(knowledge, /LINE only/u); assert.doesNotMatch(knowledge, /FB only/u);
  assert.deepEqual(approved, BRAIN.bundle.guardTables.approvedPrices);
  const message = db.messagesFor("U-fu-retrieval").find((row) => row.direction === "out");
  assert.equal(db.lastBrainVersionFor("U-fu-retrieval"), BRAIN.versionId);
  assert.equal(JSON.parse(message.metadata_json).brainRetrieval.versionId, BRAIN.versionId);
  assert.ok(Number(fixtureCustomer(db, "U-fu-retrieval").price_quoted_at) > 0, "must use captured version price even if global price table is empty");
  assert.equal(db.getFollowup(due.id).status, "sent"); db.close();
});

function fixtureCustomer(db, id) { return db.getCustomer(id); }

const OVERFLOW_BRAIN = { ...BRAIN, bundle: { ...BRAIN.bundle, cards: [card("huge-pin", "x".repeat(80_001))] } };

for (const reason of ["missing", "overflow", "read_failure"]) test(`regular retrieval ${reason} holds and leaves a due row pending`, async () => {
  const now = Date.UTC(2026, 0, 15, 5, 0, 0); const db = memoryDb({ now: () => now });
  db.upsertCustomer("U-fu-hold", {}); db.setFollowupEnabled("U-fu-hold", true);
  const due = db.createFollowup({ customerId: "U-fu-hold", scheduledAt: now - 1, createdBy: "test" });
  if (reason === "read_failure") db.recentTurns = () => { throw new Error("synthetic read failure"); };
  let drafts = 0;
  const engine = createFollowupEngine({
    config: testConfig({ FOLLOWUP_ENABLED: "true", BRAIN_RETRIEVAL_ENABLED: "true" }), db, now: () => now,
    brainRuntime: { resolve: () => reason === "missing" ? null : reason === "overflow" ? OVERFLOW_BRAIN : BRAIN }, hermes: { draftReply: async () => { drafts += 1; return null; } },
    line: { sendBubbles: async () => { throw new Error("must not send"); } }, guard: { checkOutbound: () => ({ ok: true, violations: [] }) },
    humanizer: createHumanizer(), logger: { warn() {}, error() {}, debug() {} },
  });
  assert.equal((await engine.runDue()).results[0].status, "held");
  assert.equal(drafts, 0); assert.equal(db.getFollowup(due.id).status, "pending"); db.close();
});

function stagedFixture({ brain = BRAIN, draftText = "ตอบ LINE ค่ะ", score = 1 } = {}) {
  const now = Date.UTC(2026, 0, 15, 5, 0, 0); const db = memoryDb({ now: () => now });
  const id = "U-staged-retrieval"; db.upsertCustomer(id, {}); db.setFollowupEnabled(id, true); db.recordScore(id, score, "{}");
  const inboundId = "in-staged-retrieval";
  db.insertMessage({ id: inboundId, customerId: id, direction: "in", msgType: "text", content: "สนใจ LINE" });
  db.raw.prepare("UPDATE messages SET created_at=? WHERE id=?").run(now - 4 * 3_600_000, inboundId);
  let draft = 0; let sent = 0; let approved = null; let knowledge = "";
  const engine = createStagedFollowups({
    config: testConfig({ STAGED_FOLLOWUP_ENABLED: "true", BRAIN_RETRIEVAL_ENABLED: "true" }), db, now: () => now,
    brainRuntime: { resolve: () => brain }, hermes: { draftReply: async (args) => { draft += 1; knowledge = args.knowledge; return { text: draftText }; } },
    lineRegistry: { forChannel: () => ({ sendBubbles: async () => { sent += 1; return { ok: true }; } }), rawUserId: (value) => value },
    guard: { checkOutbound: (_text, options) => { approved = options.approvedPrices; return { ok: true, violations: [] }; } },
    humanizer: createHumanizer(), logger: { warn() {}, error() {}, debug() {} }, imageCatalog: [],
  });
  return { engine, db, id, now, calls: () => ({ draft, sent, approved, knowledge }) };
}

test("staged follow-up uses captured selected brain facts and persists receipt", async () => {
  const fixture = stagedFixture({ draftText: "ราคา 15,900 บาทค่ะ" });
  const out = await fixture.engine.processCustomer(fixture.db.getCustomer(fixture.id), fixture.now);
  assert.equal(out.sent, "question"); assert.equal(fixture.calls().draft, 1); assert.equal(fixture.calls().sent, 1);
  assert.match(fixture.calls().knowledge, /LINE only/u); assert.doesNotMatch(fixture.calls().knowledge, /FB only/u);
  assert.deepEqual(fixture.calls().approved, BRAIN.bundle.guardTables.approvedPrices);
  const message = fixture.db.messagesFor(fixture.id).find((row) => row.direction === "out");
  assert.equal(fixture.db.lastBrainVersionFor(fixture.id), BRAIN.versionId);
  assert.equal(JSON.parse(message.metadata_json).brainRetrieval.versionId, BRAIN.versionId);
  assert.ok(Number(fixture.db.getCustomer(fixture.id).price_quoted_at) > 0);
  fixture.db.close();
});

for (const reason of ["missing", "overflow", "read_failure"]) test(`staged follow-up ${reason} holds without consuming ladder state`, async () => {
  const fixture = stagedFixture({ brain: reason === "missing" ? null : reason === "overflow" ? OVERFLOW_BRAIN : BRAIN });
  if (reason === "read_failure") fixture.db.recentTurns = () => { throw new Error("synthetic read failure"); };
  const before = fixture.db.getFollowupState(fixture.id);
  const out = await fixture.engine.processCustomer(fixture.db.getCustomer(fixture.id), fixture.now);
  assert.match(out.skipped, /brain_retrieval_hold/u); assert.deepEqual(fixture.calls(), { draft: 0, sent: 0, approved: null, knowledge: "" });
  assert.deepEqual(fixture.db.getFollowupState(fixture.id), before); fixture.db.close();
});

test("staged scheduler never drafts in a booking room with AI disabled", async () => {
  const fixture = stagedFixture();
  fixture.db.setAiEnabled(fixture.id, false, "booking_request");
  const before = fixture.db.getFollowupState(fixture.id);
  await fixture.engine.runOnce();
  assert.equal(fixture.calls().draft, 0);
  assert.equal(fixture.calls().sent, 0);
  assert.deepEqual(fixture.db.getFollowupState(fixture.id), before);
  fixture.db.close();
});

test("staged retrieval cannot send an unversioned legacy review", async () => {
  const fixture = stagedFixture({ score: 5 });
  fixture.db.addKnowledge({ title: "รีวิวนักเรียนจริง", content: "[Classroom : LINE]\n- คุณทดสอบ | รีวิว: https://www.facebook.com/share/r/LEGACY111/" });
  const out = await fixture.engine.processCustomer(fixture.db.getCustomer(fixture.id), fixture.now);
  assert.equal(out.sent, "question");
  assert.equal(fixture.calls().sent, 1);
  assert.equal(fixture.db.messagesFor(fixture.id).some((row) => row.direction === "out" && /LEGACY111|คุณทดสอบ/u.test(row.content)), false);
  fixture.db.close();
});
