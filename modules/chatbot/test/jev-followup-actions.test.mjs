import test from "node:test";
import assert from "node:assert/strict";
import { reviewFollowup } from "../src/jevFollowupReview.mjs";
import { createFollowupEngine } from "../src/followupEngine.mjs";
import { createStagedFollowups } from "../src/stagedFollowups.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { hermesFetchStub, memoryDb, testConfig } from "./helpers.mjs";

const NOW = Date.UTC(2026, 0, 15, 5, 0, 0);

function receipt(db, customerId, id) {
  db.raw.prepare(`INSERT INTO jev_decision_reviews
    (id,customer_id,session_id,turn_id,stage,policy,model,proposed_action,mode,action,status,result_json,evidence_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, customerId, "session", "turn", "followup", "test", "jev-1.13.0", "proactive_followup",
    "enforce", "allow", "reviewed", "{}", `hash-${id}`, NOW,
  );
}

function verdict({ id, action = "allow", stop = "continue", notify = "not_needed", confidence = .97, status = "reviewed" } = {}) {
  const check = choice => ({ choice, confidence, confidence10: Math.round(confidence * 100) / 10, probabilities: {} });
  return { id, mode: "enforce", status, action, checks: { stop: check(stop), notify: check(notify) } };
}

function world() {
  const db = memoryDb({ now: () => NOW });
  const customerId = "U-jev-followup";
  db.upsertCustomer(customerId, {});
  db.setFollowupEnabled(customerId, true);
  const pushes = [];
  return { db, customerId, pushes, notifier: { fireLater: item => pushes.push(item) } };
}

async function review(w, result, { current = () => true } = {}) {
  return reviewFollowup({
    reviewer: { enabled: true, mode: "enforce", review: async () => result },
    db: w.db, customerId: w.customerId, turnId: "turn", draftText: "ข้อความ follow-up", knowledge: "ความรู้",
    notifier: w.notifier, threshold10: 9, isCurrent: current,
  });
}

test("notify-only JEV follow-up holds scheduled or staged delivery, queues once, and leaves reactive AI on", async(t) => {
  const w = world(); t.after(() => w.db.close());
  receipt(w.db, w.customerId, "notify-once");
  const result = verdict({ id: "notify-once", notify: "notify" });
  assert.equal(await review(w, result), false, "both follow-up engines receive false and must skip their send");
  const customer = w.db.getCustomer(w.customerId);
  assert.equal(customer.ai_enabled, 1);
  assert.equal(customer.followup_enabled, 0);
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.equal(w.pushes.length, 1);
  assert.equal(w.pushes[0].reason, "jev_followup_notify");
  assert.equal(await review(w, result), false, "cached/retried receipt stays held");
  assert.equal(w.pushes.length, 1, "the receipt claim prevents duplicate admin pushes");
});

test("stop JEV follow-up holds delivery, disables follow-up and AI, without an independent notify", async(t) => {
  const w = world(); t.after(() => w.db.close());
  receipt(w.db, w.customerId, "stop-only");
  assert.equal(await review(w, verdict({ id: "stop-only", action: "human_review", stop: "stop" })), false);
  const customer = w.db.getCustomer(w.customerId);
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, "jev_followup_stop");
  assert.equal(customer.followup_enabled, 0);
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.equal(w.pushes.length, 0);
});

test("a new JEV notify still pages the team when an older unrelated NEEDS_HUMAN hold exists", async(t) => {
  const w = world(); t.after(() => w.db.close());
  w.db.setNeedsHuman(w.customerId, "hermes_down", "ร่างเก่าล้มเหลว");
  receipt(w.db, w.customerId, "notify-after-old-hold");
  assert.equal(await review(w, verdict({ id: "notify-after-old-hold", notify: "notify" })), false);
  assert.equal(w.db.getCustomer(w.customerId).ai_enabled, 1);
  assert.equal(w.pushes.length, 1);
  assert.equal(w.pushes[0].reason, "jev_followup_notify");
});

test("unavailable, low-confidence, or stale JEV follow-up creates no queue, push, or AI-off", async(t) => {
  const w = world(); t.after(() => w.db.close());
  assert.equal(await review(w, verdict({ id: "unavailable", action: "unavailable", status: "unavailable" })), false);
  assert.equal(await review(w, verdict({ id: "low", action: "human_review", stop: "stop", notify: "notify", confidence: .8 })), false);
  receipt(w.db, w.customerId, "stale");
  assert.equal(await review(w, verdict({ id: "stale", notify: "notify" }), { current: () => false }), false);
  const customer = w.db.getCustomer(w.customerId);
  assert.equal(customer.ai_enabled, 1);
  assert.equal(customer.followup_enabled, 1);
  assert.equal(customer.state, "AI_ACTIVE");
  assert.equal(w.pushes.length, 0);
  assert.equal(w.db.raw.prepare("SELECT applied FROM jev_decision_reviews WHERE id='stale'").get().applied, 0);
});

test("scheduled and staged engines forward their configured JEV threshold and notifier", async(t) => {
  for (const kind of ["scheduled", "staged"]) {
    const db = memoryDb({ now: () => NOW }); t.after(() => db.close());
    const customerId = `U-${kind}`;
    const config = testConfig({ FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0", JEV_REVIEW_MIN_CONFIDENCE: "9.8" });
    const pushes = []; let sends = 0;
    const id = `threshold-${kind}`;
    db.upsertCustomer(customerId, {}); db.setFollowupEnabled(customerId, true);
    receipt(db, customerId, id);
    const reviewer = { enabled: true, mode: "enforce", review: async () => verdict({ id, notify: "notify", confidence: .97 }) };
    const notifier = { fireLater: item => pushes.push(item) };
    const hermes = createHermesBridge({ config, fetchImpl: hermesFetchStub("สนใจคุยต่อไหมคะ"), logger: {} });
    const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [] });
    const humanizer = createHumanizer();
    if (kind === "scheduled") {
      const line = { sendBubbles: async () => { sends++; return { ok: true, delivered: [{ type: "text", text: "ok" }] }; } };
      const engine = createFollowupEngine({ config, db, hermes, line, guard, humanizer, decisionReview: reviewer, notifier, now: () => NOW, logger: {} });
      db.createFollowup({ customerId, scheduledAt: NOW - 1, createdBy: "test" });
      await engine.runDue();
    } else {
      const lineCh = { sendBubbles: async () => { sends++; return { ok: true, acceptedRequestMessages: [] }; } };
      const engine = createStagedFollowups({ config, db, hermes, lineRegistry: { forChannel: () => lineCh, rawUserId: value => value }, guard, humanizer, decisionReview: reviewer, notifier, now: () => NOW, logger: {} });
      db.recordScore(customerId, 6, "{}");
      db.insertMessage({ id: `in-${kind}`, customerId, direction: "in", content: "สนใจค่ะ" });
      db.insertMessage({ id: `out-${kind}`, customerId, direction: "out", content: "ยินดีค่ะ" });
      db.raw.prepare("UPDATE messages SET created_at=? WHERE id=?").run(NOW - 2 * 60 * 60_000, `in-${kind}`);
      db.raw.prepare("UPDATE messages SET created_at=? WHERE id=?").run(NOW - 2 * 60 * 60_000 + 1_000, `out-${kind}`);
      await engine.runOnce();
    }
    assert.equal(sends, 1, `${kind} must use configured 9.8 threshold, not helper default 9`);
    assert.equal(pushes.length, 0, `${kind} must not notify below its configured threshold`);
  }
});
