import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.mjs";

const REASONS = [
  "customer_will_return",
  "customer_considering",
  "colleague_will_contact",
  "accounting_documents",
];

test("existing database gains suppression metadata additively and reopens without resetting it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "followup-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "legacy.sqlite");
  let db = openDb({ file });
  db.upsertCustomer("legacy-synthetic", { displayName: "migration fixture" });
  db.setFollowupEnabled("legacy-synthetic", true);
  db.close();
  const raw = new DatabaseSync(file);
  raw.exec("ALTER TABLE customers DROP COLUMN followup_suppression_reason");
  raw.close();
  db = openDb({ file });
  assert.equal(db.getCustomer("legacy-synthetic").followup_enabled, 1);
  assert.equal(db.getCustomer("legacy-synthetic").followup_suppression_reason, "");
  db.suppressFollowupsForCustomer("legacy-synthetic", "customer_considering");
  db.close();
  db = openDb({ file });
  try {
    assert.equal(db.getCustomer("legacy-synthetic").followup_enabled, 0);
    assert.equal(db.getCustomer("legacy-synthetic").followup_suppression_reason, "customer_considering");
  } finally { db.close(); }
});

test("customer-requested suppression is bounded, atomic, and preserves unrelated customer controls", () => {
  let clock = 1_700_000_000_000;
  const db = memoryDb({ now: () => clock });
  const customerId = "U-no-followup";
  db.upsertCustomer(customerId, {});
  db.setDoNotDisturb(customerId, true);
  db.setAiEnabled(customerId, false, "human_requested");
  db.setNeedsHuman(customerId, "owner_review");
  const pending = db.createFollowup({ customerId, scheduledAt: clock + 60_000, createdBy: "owner" });
  const sent = db.createFollowup({ customerId, scheduledAt: clock - 60_000, createdBy: "owner" });
  db.setFollowupStatus(sent.id, "sent");

  clock += 1_000;
  const customer = db.suppressFollowupsForCustomer(customerId, "customer_considering");

  assert.equal(customer.followup_enabled, 0);
  assert.equal(customer.followup_suppression_reason, "customer_considering");
  assert.equal(customer.do_not_disturb, 1);
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.equal(customer.followup_choice_by_human, 0);
  assert.equal(db.getFollowup(pending.id).status, "cancelled");
  assert.equal(db.getFollowup(sent.id).status, "sent");
  db.close();
});

test("suppression accepts only closed reasons and repeating the same request does not rewrite customer time", () => {
  let clock = 1_700_000_000_000;
  const db = memoryDb({ now: () => clock });
  const customerId = "U-idempotent";
  db.upsertCustomer(customerId, {});

  for (const reason of REASONS) {
    const row = db.suppressFollowupsForCustomer(customerId, reason);
    assert.equal(row.followup_suppression_reason, reason);
    db.setFollowupEnabled(customerId, true);
  }

  db.suppressFollowupsForCustomer(customerId, "customer_will_return");
  const once = db.getCustomer(customerId);
  clock += 1_000;
  const twice = db.suppressFollowupsForCustomer(customerId, "customer_will_return");
  assert.equal(twice.updated_at, once.updated_at);
  assert.throws(() => db.suppressFollowupsForCustomer(customerId, "free-form"), /invalid followup suppression reason/);
  assert.equal(db.getCustomer(customerId).followup_suppression_reason, "customer_will_return");
  db.close();
});

test("manual enable clears suppression, while score-driven re-enable requires an empty reason and reset clears it", () => {
  const db = memoryDb();
  const customerId = "U-reenable";
  db.upsertCustomer(customerId, {});
  db.suppressFollowupsForCustomer(customerId, "accounting_documents");

  db.recordScore(customerId, 9, "{}");
  assert.equal(db.getCustomer(customerId).followup_enabled, 0);
  assert.equal(db.getCustomer(customerId).followup_suppression_reason, "accounting_documents");

  db.setFollowupEnabled(customerId, true);
  assert.equal(db.getCustomer(customerId).followup_enabled, 1);
  assert.equal(db.getCustomer(customerId).followup_suppression_reason, "");
  assert.equal(db.getCustomer(customerId).followup_choice_by_human, 1);

  db.suppressFollowupsForCustomer(customerId, "colleague_will_contact");
  db.setFollowupEnabled(customerId, false);
  assert.equal(db.getCustomer(customerId).followup_suppression_reason, "colleague_will_contact");
  const reset = db.resetCustomer(customerId);
  assert.equal(reset.followup_enabled, 1);
  assert.equal(reset.followup_suppression_reason, "");
  db.close();
});
