import { reviewJevForWorkflow } from "./jevWorkflowReview.mjs";
// Proactive drafts share the judge and its concurrency budget with reactive
// work. A rejected follow-up is held, never rewritten into another unsolicited
// message. The caller rechecks consent/freshness after this await.
import { paymentInstructionsIndex } from "./salesDecisionGuard.mjs";
import { shouldNotifyJev, shouldStopJev } from "./jevDecisionReview.mjs";

function claimJevReceipt(db, id) {
  if (!id) return false;
  try {
    // Claim before any durable side effect. A cached/retried review with the
    // same receipt can therefore hold another proactive send but cannot page
    // the team or mutate the room a second time.
    return db.raw.prepare("UPDATE jev_decision_reviews SET applied=1 WHERE id=? AND applied=0").run(id).changes === 1;
  } catch { return false; }
}

export async function reviewFollowup({ reviewer, db, customerId, draftText, knowledge, turnId, isCurrent, notifier = null, threshold10 = 9, blockPaymentInstructions = false }) {
  // Payment instructions require a reactive, explicitly resolved course offer.
  if (blockPaymentInstructions && paymentInstructionsIndex(draftText) >= 0) return false;
  if (!reviewer?.enabled) return true;
  const history = db.recentTurns(customerId, 12);
  const latest = history.filter(row => row.role === "user").at(-1);
  const sessionId = db.activeConversationSession(customerId)?.id || "";
  const result = await reviewJevForWorkflow(reviewer, { customerId, sessionId, turnId,
    stage: "followup", customer: db.getCustomer(customerId),
    latestText: latest?.content || latest?.text || "", history,
    knowledge, draftText, proposedAction: "proactive_followup", isCurrent });
  if (result.mode !== "enforce") return true;
  if (!isCurrent()) return false;
  const stop = shouldStopJev(result, threshold10);
  const notify = shouldNotifyJev(result, threshold10);
  if (stop || notify) {
    if (!claimJevReceipt(db, result.id) || !isCurrent()) return false;
    const customer = db.getCustomer(customerId);
    if (!customer || customer.ai_enabled !== 1) return false;
    const reason = stop ? "jev_followup_stop" : "jev_followup_notify";
    const alreadyQueued = customer.state === "NEEDS_HUMAN";
    if (!alreadyQueued) {
      db.setNeedsHuman(customerId, reason, stop
        ? "JEV ตรวจพบว่า follow-up นี้ควรให้คนรับช่วงต่อ"
        : "JEV แนะนำให้ทีมตรวจ follow-up นี้ก่อนส่ง");
    }
    // A queued proactive message must never be sent after either verdict. A
    // notify-only decision keeps reactive AI available; a stop disables it.
    db.setFollowupEnabled(customerId, false);
    if (stop) db.setAiEnabled(customerId, false, reason);
    // NEEDS_HUMAN may be an old, unrelated hold (for example Hermes was down).
    // The atomic JEV receipt claim, plus the notifier's own cooldown, is the
    // correct deduplication boundary for this new JEV verdict.
    if (notify) {
      notifier?.fireLater?.({ customerId, channelId: customer.channel_id || "default", reason,
        customerName: customer.known_name || customer.display_name || "",
        reasonTextOverride: "JEV แนะนำให้ทีมตรวจ follow-up นี้ก่อนส่ง" });
    }
    return false;
  }
  // Normal allow/rewrite/uncertain outcomes retain the old proactive hold
  // behavior. Marking an ordinary allow is best-effort; only side effects need
  // an atomic receipt claim.
  try { if (result.id) db.raw.prepare("UPDATE jev_decision_reviews SET applied=1 WHERE id=?").run(result.id); } catch { /* no side effect */ }
  return result.action === "allow" && isCurrent();
}
