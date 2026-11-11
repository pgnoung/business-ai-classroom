import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { writeAuditFeedback } from "../src/jevAuditFeedback.mjs";
import { readJevOwnerLearning } from "../src/jevOwnerLearning.mjs";

function caseRow(id, customerId, channelId, { stop = "stop", notify = "notify", reason = "ordinary_information", complaint = "none" } = {}) {
  return { id, evidenceHash: id.padEnd(64, "a").slice(0, 64), customerId, channelId, atMs: 100, anchorMessageId: `anchor-${id}`, eventKinds: ["fixture"],
    jev: { model: "jev-1.13.0", stop: { choice: stop }, notify: { choice: notify }, complaint: { choice: complaint }, reason: { choice: reason } }, comparison: {} };
}
function seed(db, row) {
  db.upsertCustomer(row.customerId, { channelId: row.channelId });
  db.insertMessage({ id: row.anchorMessageId, customerId: row.customerId, direction: "in", content: "private fixture" });
}
function save(db, row, input, revision = 0) {
  const result = writeAuditFeedback({ db, batchId: "batch", caseRow: row, reviewer: "private-owner", input: { note: "MUST_NOT_EXPORT", expectedRevision: revision, ...input }, now: () => 111 });
  assert.equal(result.ok, true);
  return result;
}

test("owner labels immediately produce closed, per-channel guidance without private fields", () => {
  const db = memoryDb();
  try {
    const one = caseRow("one", "private-customer-a", "line-a", { stop: "stop", notify: "notify" });
    const two = caseRow("two", "private-customer-b", "line-b");
    seed(db, one); seed(db, two);
    save(db, one, { stop: "incorrect", notify: "correct" });
    save(db, two, { stop: "correct", notify: "incorrect" });
    const learning = readJevOwnerLearning({ db, channelId: "line-a" });
    assert.deepEqual(learning.examples, [{ feature: { reason: "ordinary_information", complaint: "none", stop: "stop", notify: "notify" }, guidance: { stop: "continue", notify: "notify" }, conflict: { stop: false, notify: false }, support: { stop: 1, notify: 1 }, revision: 1 }]);
    assert.match(learning.instruction, /conditional guidance.*past classifications/u);
    const exported = JSON.stringify(learning);
    assert.doesNotMatch(exported, /private-customer|private-owner|MUST_NOT_EXPORT|anchor-one|batch|111/u);
  } finally { db.close(); }
});

test("updates, separate labels, deleted evidence and conflicts are handled on the next read", () => {
  const db = memoryDb();
  try {
    const one = caseRow("one", "a", "default", { stop: "stop", notify: "not_needed" });
    const two = caseRow("two", "b", "default", { stop: "stop", notify: "not_needed" });
    seed(db, one); seed(db, two);
    save(db, one, { stop: "correct", notify: null });
    const before = readJevOwnerLearning({ db, channelId: "default" });
    assert.equal(before.examples[0].guidance.stop, "stop"); assert.equal(before.examples[0].guidance.notify, null);
    save(db, one, { stop: null, notify: "correct" }, 1);
    const changed = readJevOwnerLearning({ db, channelId: "default" });
    assert.notEqual(changed.contentHash, before.contentHash);
    assert.deepEqual(changed.examples[0].guidance, { stop: null, notify: "not_needed" });
    assert.equal(changed.examples[0].support.stop, 0, "cleared stop label must disappear");
    save(db, one, { stop: "incorrect", notify: "correct" }, 2);
    save(db, two, { stop: "correct", notify: null });
    const conflict = readJevOwnerLearning({ db, channelId: "default" }).examples[0];
    assert.equal(conflict.guidance.stop, null); assert.equal(conflict.conflict.stop, true);
    db.raw.prepare("DELETE FROM messages WHERE id=?").run(one.anchorMessageId);
    const afterDelete = readJevOwnerLearning({ db, channelId: "default" });
    assert.equal(afterDelete.examples[0].guidance.stop, "stop");
    db.raw.prepare("DELETE FROM customers WHERE line_user_id='b'").run();
    assert.deepEqual(readJevOwnerLearning({ db, channelId: "default" }).examples, []);
  } finally { db.close(); }
});

test("outbound examples are capped at twelve without carrying labels or notes", () => {
  const db = memoryDb();
  try {
    const reasons = ["ordinary_information", "bank_details_only", "active_human_reply", "project_slots", "operational_failure", "insufficient_evidence"];
    const complaints = ["none", "elsewhere", "frustration"];
    for (let index = 0; index < 18; index++) {
      const row = caseRow(`many-${index}`, `customer-${index}`, "default", { reason: reasons[index % reasons.length], complaint: complaints[Math.floor(index / reasons.length)], stop: index % 2 ? "continue" : "stop", notify: index % 3 ? "notify" : "not_needed" });
      seed(db, row);
      save(db, row, { stop: "correct", notify: index % 2 ? null : "correct" });
    }
    const learning = readJevOwnerLearning({ db, channelId: "default" });
    assert.equal(learning.examples.length, 12);
    const serialized = JSON.stringify(learning);
    assert.doesNotMatch(serialized, /customer-|MUST_NOT_EXPORT|private-owner|correct|incorrect/u);
  } finally { db.close(); }
});

test("unsafe reasons never teach a lower stop or notify decision", () => {
  const db = memoryDb();
  try {
    const row = caseRow("payment", "payment-customer", "default", { reason: "payment_or_slip", stop: "stop", notify: "notify" });
    seed(db, row); save(db, row, { stop: "incorrect", notify: "incorrect" });
    assert.deepEqual(readJevOwnerLearning({ db, channelId: "default" }).examples, []);
  } finally { db.close(); }
});

test("a false-positive serious complaint correction remains usable guidance", () => {
  const db = memoryDb();
  try {
    const row = caseRow("complaint", "complaint-customer", "default", { reason: "serious_complaint", complaint: "complaint", stop: "stop", notify: "notify" });
    seed(db, row); save(db, row, { stop: "incorrect", notify: "incorrect" });
    const example = readJevOwnerLearning({ db, channelId: "default" }).examples[0];
    assert.deepEqual(example.guidance, { stop: "continue", notify: "not_needed" });
  } finally { db.close(); }
});
