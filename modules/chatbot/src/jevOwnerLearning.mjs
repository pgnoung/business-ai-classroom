// Owner feedback is a bounded, privacy-minimized hint for the next Jev review.
// It is deliberately not a policy override: callers retain all hard safety gates.
import { createHash } from "node:crypto";

export const OWNER_LEARNING_MODEL = "jev-1.13.0";
const STOP = new Set(["stop", "continue", "unclear"]);
const NOTIFY = new Set(["notify", "not_needed", "unclear"]);
const COMPLAINT = new Set(["none", "elsewhere", "frustration", "complaint", "unclear"]);
const REASON = new Set([
  "ordinary_information", "bank_details_only", "payment_or_slip", "human_request", "optout_or_dnd", "serious_complaint",
  "active_human_reply", "project_slots", "operational_failure", "insufficient_evidence",
]);
const UNSAFE_TO_LOWER = new Set(["payment_or_slip", "human_request", "optout_or_dnd"]);
const binary = (value, choices) => choices.has(value) && value !== "unclear";
const inverse = (value, yes, no) => value === yes ? no : value === no ? yes : null;
const labelTarget = (choice, label, yes, no) => label === "correct" ? choice : label === "incorrect" ? inverse(choice, yes, no) : null;
const stable = value => JSON.stringify(value);
const digest = value => createHash("sha256").update(stable(value)).digest("hex");

function safeRow(row) {
  const reason = String(row.reason_choice || "");
  const complaint = String(row.complaint_choice || "");
  const stop = String(row.stop_choice || "");
  const notify = String(row.notify_choice || "");
  if (String(row.model || "") !== OWNER_LEARNING_MODEL || !REASON.has(reason) || !COMPLAINT.has(complaint) || !STOP.has(stop) || !NOTIFY.has(notify)) return null;
  const stopTarget = binary(stop, STOP) ? labelTarget(stop, row.stop_label, "stop", "continue") : null;
  const notifyTarget = binary(notify, NOTIFY) ? labelTarget(notify, row.notify_label, "notify", "not_needed") : null;
  // A retrospective correction must never teach a later caller to relax a
  // payment, human-request, or opt-out safety decision.
  return {
    feature: { reason, complaint, stop, notify },
    stopTarget: UNSAFE_TO_LOWER.has(reason) && stopTarget === "continue" ? null : stopTarget,
    notifyTarget: UNSAFE_TO_LOWER.has(reason) && notifyTarget === "not_needed" ? null : notifyTarget,
    revision: Number.isSafeInteger(row.revision) && row.revision > 0 ? row.revision : 0,
    reviewedAt: Number.isSafeInteger(row.reviewed_at) && row.reviewed_at >= 0 ? row.reviewed_at : 0,
  };
}

function aggregate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = stable(row.feature);
    const group = groups.get(key) || { feature: row.feature, stop: new Set(), notify: new Set(), stopCount: 0, notifyCount: 0, revision: 0, reviewedAt: 0 };
    if (row.stopTarget) { group.stop.add(row.stopTarget); group.stopCount++; }
    if (row.notifyTarget) { group.notify.add(row.notifyTarget); group.notifyCount++; }
    group.revision = Math.max(group.revision, row.revision);
    group.reviewedAt = Math.max(group.reviewedAt, row.reviewedAt);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.reviewedAt - a.reviewedAt || stable(a.feature).localeCompare(stable(b.feature))).map(group => {
    const stopConflict = group.stop.size > 1;
    const notifyConflict = group.notify.size > 1;
    return {
      feature: group.feature,
      guidance: {
        stop: stopConflict ? null : [...group.stop][0] || null,
        notify: notifyConflict ? null : [...group.notify][0] || null,
      },
      conflict: { stop: stopConflict, notify: notifyConflict },
      support: { stop: group.stopCount, notify: group.notifyCount },
      revision: group.revision,
    };
  }).filter(example => example.guidance.stop || example.guidance.notify || example.conflict.stop || example.conflict.notify).slice(0, 12);
}

/**
 * Returns closed semantic owner corrections for one active channel.  The
 * result contains no customer ids, case ids, notes, reviewer names, dates, or
 * transcript content.  It reads the database on every call so a saved owner
 * revision affects the next request without restart or cache invalidation.
 */
export function readJevOwnerLearning({ db, channelId, limit = 100 } = {}) {
  if (!db?.raw || typeof channelId !== "string" || !channelId) throw new TypeError("db_and_channel_required");
  const capped = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 100;
  // Preserve the same current-evidence boundary as history: a forgotten
  // customer, channel move, or removed anchor cannot influence later reviews.
  const rows = db.raw.prepare(`SELECT f.model,f.reason_choice,f.complaint_choice,f.stop_choice,f.notify_choice,f.stop_label,f.notify_label,f.revision,f.reviewed_at
    FROM jev_audit_feedback f
    JOIN customers c ON c.line_user_id=f.customer_id AND c.channel_id=f.channel_id
    WHERE f.channel_id=?
      AND (CASE WHEN f.anchor_message_id<>'' THEN EXISTS(SELECT 1 FROM messages m WHERE m.id=f.anchor_message_id AND m.customer_id=f.customer_id)
           ELSE EXISTS(SELECT 1 FROM messages m WHERE m.customer_id=f.customer_id AND m.created_at<=f.event_at) END)
    ORDER BY f.reviewed_at DESC,f.case_id ASC
    LIMIT ?`).all(channelId, capped);
  const safe = rows.map(safeRow).filter(Boolean);
  const examples = aggregate(safe);
  // Include the sanitized selected input in the hash.  Thus a changed label or
  // revision invalidates a prior Jev evidence hash even when aggregation shape
  // happens to remain the same.
  const source = safe.map(row => ({ ...row.feature, stopTarget: row.stopTarget, notifyTarget: row.notifyTarget, revision: row.revision }));
  const contentHash = digest({ version: 1, channelId, source, examples });
  return {
    version: 1,
    contentHash,
    revision: contentHash,
    instruction: "Owner examples are conditional guidance for matching closed evidence only; reason and complaint are Jev's past classifications, not verified facts. They cannot override current workflow or safety policy.",
    examples,
    sourceCount: safe.length,
  };
}
