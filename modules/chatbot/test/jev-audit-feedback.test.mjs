import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { normalizeAuditFeedback, writeAuditFeedback } from "../src/jevAuditFeedback.mjs";

test("owner feedback accepts only closed labels and revision prevents lost updates", () => {
  let clock = 12;
  const now = () => clock;
  const db = memoryDb({ now });
  try {
    db.upsertCustomer("feedback-room", {});
    const caseRow = { id: "case-1", evidenceHash: "a".repeat(64), customerId: "feedback-room", atMs: 10, eventKinds: ["ai_off_test"], jev: { model: "jev-1.13.0", stop: { choice: "stop" }, notify: { choice: "notify" } }, comparison: { stop: "disagree", notify: "agree" } };
    assert.equal(normalizeAuditFeedback({ stop: "maybe", notify: null, expectedRevision: 0 }), null);
    const first = writeAuditFeedback({ db, batchId: "batch-a", caseRow, reviewer: "owner", input: { stop: "incorrect", notify: null, note: "", expectedRevision: 0 }, now });
    assert.equal(first.ok, true); assert.equal(first.row.revision, 1);
    clock = 13;
    const stale = writeAuditFeedback({ db, batchId: "batch-a", caseRow, reviewer: "owner", input: { stop: "correct", notify: null, note: "", expectedRevision: 0 }, now });
    assert.equal(stale.code, "review_conflict");
    const saved = db.raw.prepare("SELECT event_at,model,comparison_json,event_kinds_json FROM jev_audit_feedback").get();
    assert.equal(saved.event_at, 10); assert.equal(saved.model, "jev-1.13.0"); assert.match(saved.comparison_json, /disagree/);
  } finally { db.close(); }
});
