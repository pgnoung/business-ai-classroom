import test from "node:test";
import assert from "node:assert/strict";
import { selectBrainKnowledgeForTurn } from "../src/brain/retrieval.mjs";
import { knowledgeExpectedHash, knowledgeMetadataFromRow, mergeKnowledgeMetadata, normalizeKnowledgeMetadata } from "../src/brain/knowledgeMetadata.mjs";
import { collectCurrentSourceCards } from "../src/brain/sources.mjs";
import { memoryDb } from "./helpers.mjs";

const CLOCK = 1_700_000_000_000;

function dbWithMode(mode = "shared") {
  return { getSetting: () => mode };
}

function fact({ id, title = id, content = "", channelId = null, inject = "pin", priority = 50, metadata = null, validFrom = null, validUntil = null, scope = undefined } = {}) {
  return {
    revId: `rev:${id}`, itemId: `fact:${id}`, kind: "fact", key: `fact:${id}`,
    inject, priority, validFrom, validUntil, ...(scope === undefined ? {} : { scope }), body: {
      title, content, channel_id: channelId,
      provenance: metadata === null ? {} : { knowledge: metadata },
    },
  };
}

function bundle(cards) { return { versionId: "v-retrieval", cards }; }

test("knowledge metadata is closed, normalized, and leaves absent legacy provenance unconfigured", () => {
  const normalized = normalizeKnowledgeMetadata({ mode: "retrieve", domain: "LINE", offering: "oa", keywords: [" LINE OA ", "line oa"] });
  assert.deepEqual(normalized, { mode: "retrieve", domain: "LINE", offering: "oa", keywords: ["LINE OA"] });
  assert.deepEqual(
    normalizeKnowledgeMetadata({ mode: "pin", domain: "การตลาด Facebook", offering: "คลาสพื้นฐาน", keywords: [] }),
    { mode: "pin", domain: "การตลาด Facebook", offering: "คลาสพื้นฐาน", keywords: [] },
  );
  assert.throws(() => normalizeKnowledgeMetadata({ mode: "pin", domain: "line\u0000", offering: "oa", keywords: [] }), /เมทาดาทา/u);
  assert.throws(() => normalizeKnowledgeMetadata({ mode: "retrieve", domain: "line", offering: "oa", keywords: [], extra: true }), /เมทาดาทา/u);
  assert.equal(knowledgeMetadataFromRow({ provenance_json: "{}" }), null);
  assert.equal(knowledgeMetadataFromRow({ provenance_json: '{"knowledge":{"mode":"retrieve"}}' }), null);
  assert.deepEqual(mergeKnowledgeMetadata({ source: "review" }, normalized), { source: "review", knowledge: normalized });
  assert.notEqual(
    knowledgeExpectedHash({ title: "เดิม", content: "เนื้อหา", active: 1, channel_id: null, provenance_json: "{}", version: 1 }),
    knowledgeExpectedHash({ title: "ใหม่", content: "เนื้อหา", active: 1, channel_id: null, provenance_json: "{}", version: 1 }),
  );
});

test("source import changes only configured retrieve facts and fails closed on malformed configured metadata", () => {
  const db = memoryDb({ now: () => CLOCK });
  const legacy = db.addKnowledge({ title: "legacy", content: "pin", updatedBy: "owner" });
  const retrieve = db.addKnowledge({
    title: "retrieve", content: "find", updatedBy: "owner",
    provenance: { knowledge: { mode: "retrieve", domain: "line", offering: "oa", keywords: ["LINE OA"] } },
  });
  const malformed = db.addKnowledge({ title: "malformed", content: "hold", updatedBy: "owner", provenance: { knowledge: { mode: "retrieve" } } });
  const cards = collectCurrentSourceCards(db);
  assert.equal(cards.find((card) => card.itemId === `fact:${legacy.id}`).inject, "pin");
  assert.equal(cards.find((card) => card.itemId === `fact:${retrieve.id}`).inject, "retrieve");
  assert.equal(cards.find((card) => card.itemId === `fact:${malformed.id}`).inject, "never");
  db.close();
});

test("pins remain while retrieve cards use only the current Thai query", () => {
  const result = selectBrainKnowledgeForTurn({
    bundle: bundle([
      fact({ id: "pinned", content: "กติกากลาง" }),
      fact({ id: "untrusted", content: "must stay absent", inject: "retrieve" }),
      fact({ id: "line", content: "LINE content", inject: "retrieve", metadata: { mode: "retrieve", domain: "line", offering: "oa", keywords: ["LINE OA"] } }),
      fact({ id: "ads", content: "ads content", inject: "retrieve", metadata: { mode: "retrieve", domain: "ads", offering: "meta", keywords: ["Facebook Ads"] } }),
    ]),
    db: dbWithMode(), queryText: "ช่วยดู LINE OA", recentContext: [{ role: "user", content: "Facebook Ads" }], atMs: CLOCK,
  });
  assert.equal(result.ok, true);
  assert.match(result.knowledge, /กติกากลาง/u);
  assert.match(result.knowledge, /LINE content/u);
  assert.doesNotMatch(result.knowledge, /ads content/u);
  assert.doesNotMatch(result.knowledge, /must stay absent/u);
  assert.equal(JSON.stringify(result.trace).includes("LINE OA"), false, "trace must not retain query or keywords");
});

test("unknown queries include only explicit and legacy pins", () => {
  const result = selectBrainKnowledgeForTurn({
    bundle: bundle([
      fact({ id: "legacy", content: "legacy pin" }),
      fact({ id: "explicit", content: "explicit pin", metadata: { mode: "pin", domain: "", offering: "", keywords: [] } }),
      fact({ id: "retrieve", content: "must not appear", inject: "retrieve", metadata: { mode: "retrieve", domain: "line", offering: "oa", keywords: ["LINE OA"] } }),
    ]), db: dbWithMode(), queryText: "คำถามที่ไม่มีคีย์เวิร์ด", atMs: CLOCK,
  });
  assert.match(result.knowledge, /legacy pin|explicit pin/u);
  assert.doesNotMatch(result.knowledge, /must not appear/u);
});

test("shared generic keywords stay ambiguous until a unique keyword or full label selects a group", () => {
  const cards = [
    fact({ id: "line-basic", content: "LINE basic", inject: "retrieve", metadata: { mode: "retrieve", domain: "LINE", offering: "Basic", keywords: ["LINE", "ราคา"] } }),
    fact({ id: "line-advanced", content: "LINE advanced", inject: "retrieve", metadata: { mode: "retrieve", domain: "LINE", offering: "Advanced", keywords: ["LINE", "ราคา"] } }),
    fact({ id: "line-general", content: "LINE general", inject: "retrieve", metadata: { mode: "retrieve", domain: "LINE", offering: "", keywords: ["LINE", "ราคา"] } }),
    fact({ id: "fb", content: "FB price", inject: "retrieve", metadata: { mode: "retrieve", domain: "Facebook", offering: "Ads", keywords: ["Facebook", "ราคา"] } }),
  ];
  const generic = selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode(), queryText: "ราคา", atMs: CLOCK });
  assert.equal(generic.trace.ambiguous, true);
  assert.equal(generic.knowledge, "");

  const line = selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode(), queryText: "LINE ราคา", atMs: CLOCK });
  assert.match(line.knowledge, /LINE general/u);
  assert.doesNotMatch(line.knowledge, /LINE basic|LINE advanced|FB price/u);

  const offering = selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode(), queryText: "Basic", atMs: CLOCK });
  assert.match(offering.knowledge, /LINE basic/u);
  assert.doesNotMatch(offering.knowledge, /LINE advanced|FB price/u);
});

test("duplicate offering labels require their domain, while an explicit comparison may select both", () => {
  const cards = [
    fact({ id: "line-basic", content: "LINE basic", inject: "retrieve", metadata: { mode: "retrieve", domain: "LINE", offering: "Basic", keywords: ["ราคา"] } }),
    fact({ id: "fb-basic", content: "FB basic", inject: "retrieve", metadata: { mode: "retrieve", domain: "Facebook", offering: "Basic", keywords: ["ราคา"] } }),
  ];
  const bare = selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode(), queryText: "Basic", atMs: CLOCK });
  assert.equal(bare.knowledge, ""); assert.equal(bare.trace.ambiguous, true);
  const line = selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode(), queryText: "LINE Basic", atMs: CLOCK });
  assert.match(line.knowledge, /LINE basic/u); assert.doesNotMatch(line.knowledge, /FB basic/u);
  const both = selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode(), queryText: "LINE Basic และ Facebook Basic", atMs: CLOCK });
  assert.match(both.knowledge, /LINE basic/u); assert.match(both.knowledge, /FB basic/u);
});

test("shared reads central and separate reads its own channel only", () => {
  const cards = [
    fact({ id: "central", content: "central pin" }),
    fact({ id: "fb", content: "facebook pin", channelId: "facebook" }),
  ];
  assert.match(selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode("shared"), channelId: "facebook" }).knowledge, /central pin/u);
  assert.doesNotMatch(selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode("shared"), channelId: "facebook" }).knowledge, /facebook pin/u);
  assert.match(selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode("separate"), channelId: "facebook" }).knowledge, /facebook pin/u);
  assert.doesNotMatch(selectBrainKnowledgeForTurn({ bundle: bundle(cards), db: dbWithMode("separate"), channelId: "facebook" }).knowledge, /central pin/u);
});

test("scope restrictions cannot widen a conflicting fact channel", () => {
  const result = selectBrainKnowledgeForTurn({
    bundle: bundle([
      fact({ id: "wrong-scope", content: "must stay absent", scope: { channel: ["facebook"] } }),
      fact({ id: "right-scope", content: "allowed", scope: { channel: "central" } }),
    ]), db: dbWithMode("shared"), channelId: "default", atMs: CLOCK,
  });
  assert.match(result.knowledge, /allowed/u);
  assert.doesNotMatch(result.knowledge, /must stay absent/u);
});

test("never and expired fact cards never enter retrieval", () => {
  const result = selectBrainKnowledgeForTurn({
    bundle: bundle([
      fact({ id: "never", content: "do not show", inject: "never" }),
      fact({ id: "expired", content: "expired", validUntil: CLOCK - 1 }),
      fact({ id: "iso-expired", content: "iso expired", validUntil: "2023-11-14T22:13:19.999Z" }),
      fact({ id: "pin", content: "allowed" }),
    ]), db: dbWithMode(), atMs: CLOCK,
  });
  assert.match(result.knowledge, /allowed/u);
  assert.doesNotMatch(result.knowledge, /do not show|expired/u);
});

test("Latin matching uses token boundaries while Thai phrases remain supported", () => {
  const result = selectBrainKnowledgeForTurn({
    bundle: bundle([
      fact({ id: "line", content: "line", inject: "retrieve", metadata: { mode: "retrieve", domain: "line", offering: "LINE OA", keywords: ["LINE OA"] } }),
      fact({ id: "thai", content: "thai", inject: "retrieve", metadata: { mode: "retrieve", domain: "course", offering: "prompt", keywords: ["เปิดคลาส"] } }),
    ]), db: dbWithMode(), queryText: "online oa ... เปิดคลาสใหม่", atMs: CLOCK,
  });
  assert.doesNotMatch(result.knowledge, /\[line\]\nline/u, "line must not match inside online");
  assert.match(result.knowledge, /\[thai\]\nthai/u);
});

test("only two bounded prior user messages are fallback when current query has no keyword", () => {
  const result = selectBrainKnowledgeForTurn({
    bundle: bundle([fact({ id: "fb", content: "retrieved", inject: "retrieve", metadata: { mode: "retrieve", domain: "ads", offering: "meta", keywords: ["Facebook Ads"] } })]),
    db: dbWithMode(), queryText: "แล้วล่ะ", recentContext: [
      { role: "assistant", content: "Facebook Ads" },
      { role: "user", content: "old unrelated" },
      { role: "user", content: "Facebook Ads" },
      { role: "user", content: "Facebook Ads" },
    ], atMs: CLOCK,
  });
  assert.match(result.knowledge, /retrieved/u);
  assert.equal(result.trace.retrieved.count, 1);
});

test("pinned overflow fails closed and retrieved cards stay whole within the budget", () => {
  const overflow = selectBrainKnowledgeForTurn({ bundle: bundle([fact({ id: "pin", content: "x".repeat(50) })]), db: dbWithMode(), maxChars: 10 });
  assert.deepEqual({ ok: overflow.ok, knowledge: overflow.knowledge, reason: overflow.reason }, { ok: false, knowledge: "", reason: "pinned_knowledge_over_budget" });

  const bounded = selectBrainKnowledgeForTurn({
    bundle: bundle([
      fact({ id: "pin", content: "keep" }),
      fact({ id: "first", content: "A".repeat(30), inject: "retrieve", priority: 90, metadata: { mode: "retrieve", domain: "x", offering: "x", keywords: ["x"] } }),
      fact({ id: "second", content: "B".repeat(30), inject: "retrieve", priority: 80, metadata: { mode: "retrieve", domain: "x", offering: "x", keywords: ["x"] } }),
    ]), db: dbWithMode(), queryText: "x", maxChars: 80,
  });
  assert.equal(bounded.ok, true);
  assert.match(bounded.knowledge, /A{30}/u);
  assert.doesNotMatch(bounded.knowledge, /B{30}/u);
});

test("selection and privacy-safe trace are deterministic", () => {
  const input = {
    bundle: bundle([
      fact({ id: "b", content: "B", inject: "retrieve", priority: 50, metadata: { mode: "retrieve", domain: "d", offering: "o", keywords: ["needle"] } }),
      fact({ id: "a", content: "A", inject: "retrieve", priority: 50, metadata: { mode: "retrieve", domain: "d", offering: "o", keywords: ["needle"] } }),
    ]), db: dbWithMode(), queryText: "private needle question", atMs: CLOCK,
  };
  const first = selectBrainKnowledgeForTurn(input);
  const second = selectBrainKnowledgeForTurn(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.trace.retrieved.ids, ["rev:a", "rev:b"]);
  assert.equal(first.trace.retrieved.omittedCount, 0);
  assert.equal(JSON.stringify(first.trace).includes("private"), false);
});
