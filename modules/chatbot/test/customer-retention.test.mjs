import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import {
  planCustomerForget,
} from "../src/customerRetention.mjs";
import { hashCustomerIdentity } from "../src/customerTombstones.mjs";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 23, 0, 0, 0);
function seedMessage(db, id, ageDays, content = "ข้อความทดสอบ") {
  db.upsertCustomer(id, { displayName: `ชื่อ ${id}`, pictureUrl: "https://example.test/avatar.jpg" });
  db.raw.prepare(
    `INSERT INTO messages (id,customer_id,direction,channel,msg_type,content,message_class,channel_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`m-${id}`, id, "in", "line", "text", content, "reactive", "default", NOW - ageDays * DAY);
}

test("customer retention uses strict last-message 90-day boundary (89/90/91)", () => {
  const db = memoryDb({ now: () => NOW });
  seedMessage(db, "U-89", 89);
  seedMessage(db, "U-90", 90);
  seedMessage(db, "U-91", 91);
  // A census-only row has no message clock and must never become eligible.
  db.upsertCustomer("U-no-message", { displayName: "census only" });
  const plan = planCustomerForget(db.raw, { now: NOW, days: 90 });
  assert.deepEqual(plan.candidates.map((row) => row.customerId), ["U-91"]);
  assert.equal(plan.staleCustomers, 1);
  db.close();
});

test("customer retention exemptions fail closed for human, deal, enrollment, paid, and unresolved followups", () => {
  const db = memoryDb({ now: () => NOW });
  for (const id of [
    "U-human", "U-deal", "U-enrolled", "U-order", "U-customer-tag", "U-customer-handover",
    "U-followup", "U-suggested", "U-approved", "U-ok",
  ]) seedMessage(db, id, 91);
  db.setNeedsHuman("U-human", "operator needed");
  db.applyLifecycleTransition({ customerId: "U-deal", toStatus: "price_sent", actor: "system" });
  db.addEnrollment({ customerId: "U-enrolled", courseId: "course", status: "enrolled", confirmedBy: "owner" });
  db.createOrder({ customerId: "U-order", items: [{ name: "course", qty: 1, price: 100 }], createdBy: "owner" });
  db.raw.prepare("INSERT INTO customer_tags (customer_id,tag,source,created_at) VALUES (?,?,?,?)")
    .run("U-customer-tag", "customer", "human", NOW);
  db.raw.prepare("UPDATE customers SET ai_off_reason=? WHERE line_user_id=?")
    .run("customer_handover", "U-customer-handover");
  db.raw.prepare(
    `INSERT INTO followups (id,customer_id,scheduled_at,status,created_by,note,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("f-pending", "U-followup", NOW + DAY, "pending", "owner", "check", NOW, NOW);
  db.raw.prepare(
    `INSERT INTO followup_suggestions (id,customer_id,suggested_at,status,created_at)
     VALUES (?,?,?,?,?)`,
  ).run("s-suggested", "U-suggested", NOW, "suggested", NOW);
  db.raw.prepare(
    `INSERT INTO followup_suggestions (id,customer_id,suggested_at,status,created_at)
     VALUES (?,?,?,?,?)`,
  ).run("s-approved", "U-approved", NOW, "approved", NOW);
  const plan = planCustomerForget(db.raw, { now: NOW, days: 90 });
  assert.deepEqual(plan.candidates.map((row) => row.customerId), ["U-ok"]);
  assert.deepEqual(plan.blocked, {
    needs_human: 1,
    unfinished_enrollment: 1,
    paid_policy_pending: 3,
    active_deal: 1,
    pending_followup: 1,
    pending_followup_suggestion: 2,
    unknown_state: 0,
  });
  db.close();
});

test("customer retention plan is read-only", () => {
  const db = memoryDb({ now: () => NOW });
  seedMessage(db, "U-dry", 91);
  const beforeCustomers = db.raw.prepare("SELECT COUNT(*) AS n FROM customers").get().n;
  const beforeMessages = db.raw.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  const beforeSettings = db.raw.prepare("SELECT COUNT(*) AS n FROM settings").get().n;
  const result = planCustomerForget(db.raw, { now: NOW });
  assert.equal(result.eligible, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM customers").get().n, beforeCustomers);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages").get().n, beforeMessages);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM settings").get().n, beforeSettings);
  assert.equal(db.messagesFor("U-dry", 10, { includeArchived: true }).length, 1);
  db.close();
});

test("forget primitive deletes raw customer identity and dependent history but retains anonymous aggregates", () => {
  const db = memoryDb();
  seedMessage(db, "U-forget", 91);
  db.setKnownName("U-forget", "ชื่อจริง");
  db.setLegacyLink("U-forget", "legacy:old-id");
  db.addLlmUsage({ customerId: "U-forget", kind: "draft", model: "model-a", tokensIn: 10, tokensOut: 5 });
  db.raw.prepare("INSERT INTO customer_tags (customer_id,tag,source,created_at) VALUES (?,?,?,?)")
    .run("U-forget", "สนใจ", "human", NOW);

  const result = db.resetCustomer("U-forget", { forget: true, forgetReason: "owner_pdpa_request" });
  assert.deepEqual(result, { forgotten: true });
  const customer = db.getCustomer("U-forget");
  assert.equal(customer, null);
  assert.equal(
    db.raw.prepare("SELECT COUNT(*) AS n FROM customers WHERE line_user_id=?").get("U-forget").n,
    0,
  );
  assert.equal(db.messagesFor("U-forget", 10, { includeArchived: true }).length, 0);
  assert.deepEqual(
    db.llmUsageSummary(0).map((row) => ({ ...row })),
    // cached_in อยู่ในสรุปด้วยตั้งแต่ 2026-08-31 (ใช้คิดส่วนลด prompt caching) — ยังเป็นตัวเลขรวมไม่ผูกตัวตน
    [{ model: "model-a", kind: "draft", tokens_in: 10, tokens_out: 5, cached_in: 0, cache_write_in: 0, long_context: 0, missing_cache_write_calls: 1 }],
  );
  assert.equal(db.getSetting("metric:retention_messages_in"), "1");
  assert.equal(db.getSetting("metric:retention_tag_assignments"), "1");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM followups WHERE customer_id=?").get("U-forget").n, 0);
  const tombstones = db.listCustomerTombstones().map((row) => ({ ...row }));
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].line_user_id_hash, hashCustomerIdentity("U-forget"));
  assert.equal(tombstones[0].reason, "owner_pdpa_request");
  assert.ok(Number.isSafeInteger(tombstones[0].forgotten_at));
  const serialized = JSON.stringify(tombstones);
  assert.equal(serialized.includes("U-forget"), false);
  db.close();
});

test("ordinary reset never writes a restore tombstone", () => {
  const db = memoryDb();
  seedMessage(db, "U-no-tombstone", 1);
  db.resetCustomer("U-no-tombstone");
  assert.equal(db.listCustomerTombstones().length, 0);
  db.close();
});

test("forget writes a restore tombstone even when the live customer is already absent", () => {
  const db = memoryDb();
  assert.equal(db.resetCustomer("U-absent-forget", { forget: true, forgetReason: "pdpa retry with private text" }), null);
  const rows = db.listCustomerTombstones();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line_user_id_hash, hashCustomerIdentity("U-absent-forget"));
  assert.equal(rows[0].reason, "pdpa_retry_with_private_text");
  assert.equal(JSON.stringify(rows).includes("U-absent-forget"), false);
  db.close();
});

test("forget primitive refuses erasure while private media remains", () => {
  const db = memoryDb();
  seedMessage(db, "U-media", 91);
  const messageId = db.messagesFor("U-media")[0].id;
  db.addMessageAttachment({
    customerId: "U-media", messageId, direction: "in", kind: "image", status: "ready",
    storageKey: "00000000-0000-4000-8000-000000000099.jpg",
  });
  assert.throws(() => db.resetCustomer("U-media", { forget: true }), /media deletion is incomplete/u);
  assert.equal(db.messagesFor("U-media").length, 1);
  assert.ok(db.getCustomer("U-media"));
  db.close();
});

test("unknown lifecycle or deal state is blocked rather than guessed", () => {
  const db = memoryDb({ now: () => NOW });
  seedMessage(db, "U-unknown", 91);
  db.raw.prepare("UPDATE customers SET lifecycle_stage=?, deal_status=? WHERE line_user_id=?")
    .run("unrecognized_stage", "unrecognized_status", "U-unknown");
  const plan = planCustomerForget(db.raw, { now: NOW });
  assert.equal(plan.eligible, 0);
  assert.equal(plan.blocked.unknown_state, 1);
  db.close();
});

test("ordinary reset keeps profile and legacy link for backward-compatible console reset", () => {
  const db = memoryDb();
  db.upsertCustomer("U-reset-normal", { displayName: "ชื่อเดิม", pictureUrl: "https://example.test/a.jpg" });
  db.raw.prepare("UPDATE customers SET picture_url=? WHERE line_user_id=?")
    .run("https://example.test/a.jpg", "U-reset-normal");
  db.setLegacyLink("U-reset-normal", "legacy:kept");
  const row = db.resetCustomer("U-reset-normal");
  assert.equal(row.display_name, "ชื่อเดิม");
  assert.equal(row.picture_url, "https://example.test/a.jpg");
  assert.equal(row.legacy_link, "legacy:kept");
  db.close();
});
