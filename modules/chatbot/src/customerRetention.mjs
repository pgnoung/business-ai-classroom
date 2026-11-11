// Customer-history retention is deliberately a read-only planning boundary.
// It must never contain an apply switch, confirmation phrase, scheduler, or a
// writable DB path: a separately reviewed Codex production runbook owns any
// future deletion execution.

import { DEAL_STATUSES, LIFECYCLE_STAGES } from "./dbLifecycle.mjs";

export const CUSTOMER_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;
const KNOWN_LIFECYCLE_STAGES = new Set(LIFECYCLE_STAGES);
const KNOWN_DEAL_STATUSES = new Set(DEAL_STATUSES);
// A customer that has progressed beyond the fresh-sales state remains out of
// scope. The list derives from the closed lifecycle enum rather than becoming a
// second, drifting list of status strings.
const ACTIVE_DEAL_STATUSES = new Set(DEAL_STATUSES.filter((status) => status !== "new"));

function boundedDays(value) {
  const days = Math.trunc(Number(value));
  if (!Number.isFinite(days) || days < 1 || days > 3650) throw new Error("customer retention days out of range");
  return days;
}

export function planCustomerForget(rawDb, { now = Date.now(), days = CUSTOMER_RETENTION_DAYS } = {}) {
  if (!rawDb?.prepare) throw new Error("read-only SQLite handle is required");
  const normalizedDays = boundedDays(days);
  const nowMs = Number(now);
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error("invalid retention clock");
  const cutoff = nowMs - normalizedDays * DAY_MS;
  const rows = rawDb.prepare(
    `SELECT c.line_user_id,c.state,c.lifecycle_stage,c.deal_status,c.ai_off_reason,
            MAX(m.created_at) AS last_message_at,
            EXISTS(SELECT 1 FROM enrollments e WHERE e.customer_id=c.line_user_id AND e.status='enrolled') AS unfinished_enrollment,
            EXISTS(SELECT 1 FROM enrollments e WHERE e.customer_id=c.line_user_id) AS has_enrollment,
            EXISTS(SELECT 1 FROM orders o WHERE o.customer_id=c.line_user_id) AS has_order,
            EXISTS(SELECT 1 FROM customer_tags t
                    WHERE t.customer_id=c.line_user_id AND lower(t.tag)='customer') AS customer_tag,
            EXISTS(SELECT 1 FROM followups f WHERE f.customer_id=c.line_user_id AND f.status='pending') AS pending_followup,
            EXISTS(SELECT 1 FROM followup_suggestions s
                    WHERE s.customer_id=c.line_user_id AND s.status IN ('suggested','approved')) AS pending_followup_suggestion
       FROM customers c
       JOIN messages m ON m.customer_id=c.line_user_id
      WHERE c.line_user_id NOT LIKE 'canary:%'
      GROUP BY c.line_user_id
     HAVING MAX(m.created_at) < ?
      ORDER BY MAX(m.created_at),c.line_user_id`,
  ).all(cutoff);

  const candidates = [];
  const blocked = {
    needs_human: 0,
    unfinished_enrollment: 0,
    paid_policy_pending: 0,
    pending_followup: 0,
    pending_followup_suggestion: 0,
    active_deal: 0,
    unknown_state: 0,
  };
  for (const row of rows) {
    let reason = "";
    // Imported/runtime drift must never silently become eligible. These are
    // closed enums owned by dbLifecycle; old/unknown data needs human review.
    if (!KNOWN_LIFECYCLE_STAGES.has(row.lifecycle_stage) || !KNOWN_DEAL_STATUSES.has(row.deal_status)) reason = "unknown_state";
    else if (row.state !== "AI_ACTIVE" && row.state !== "NEEDS_HUMAN") reason = "unknown_state";
    else if (row.state === "NEEDS_HUMAN") reason = "needs_human";
    else if (Number(row.unfinished_enrollment) === 1) reason = "unfinished_enrollment";
    // Owner policy is unresolved: fail closed for every order or historical
    // enrollment, including completed/cancelled rows.
    else if (
      Number(row.has_order) === 1 ||
      Number(row.has_enrollment) === 1 ||
      Number(row.customer_tag) === 1 ||
      row.ai_off_reason === "customer_handover" ||
      ["enrolled", "alumni"].includes(row.lifecycle_stage)
    ) {
      reason = "paid_policy_pending";
    } else if (Number(row.pending_followup) === 1) reason = "pending_followup";
    else if (Number(row.pending_followup_suggestion) === 1) reason = "pending_followup_suggestion";
    else if (ACTIVE_DEAL_STATUSES.has(row.deal_status)) reason = "active_deal";
    if (reason) blocked[reason] += 1;
    else candidates.push({ customerId: row.line_user_id, lastMessageAt: Number(row.last_message_at) });
  }
  return {
    days: normalizedDays,
    now: nowMs,
    cutoff,
    staleCustomers: rows.length,
    eligible: candidates.length,
    blocked,
    candidates,
  };
}

export function retentionReadback(plan) {
  return {
    days: plan.days,
    now: plan.now,
    cutoff: plan.cutoff,
    staleCustomers: plan.staleCustomers,
    eligible: plan.eligible,
    blocked: { ...plan.blocked },
  };
}
