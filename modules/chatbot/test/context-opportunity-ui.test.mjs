// Opportunity Layer is console-only: it renders normalized policy state, never
// raw scorer candidates.  These tests intentionally import the pure extractor
// rather than requiring a browser DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizedOpportunityState } from "../public/console/context.mjs";

test("Opportunity Layer: renders normalized policy state with verified/unknown labels", () => {
  const state = normalizedOpportunityState({
    salesState: {
      enabled: true,
      customerJourney: "returning_student",
      decisionRole: "owner",
      opportunity: {
        type: "private_inhouse",
        slots: { organization_context: "ทีมขาย", audience_size: "20 คน", ignored: "" },
        missingSlots: ["business_need"],
        handoffReady: false,
        upsizeEligible: false,
      },
    },
  });

  assert.equal(state.customerJourney, "ผู้เรียนเดิม (ยืนยันแล้ว)");
  assert.equal(state.decisionRole, "owner");
  assert.equal(state.opportunity.type, "private inhouse");
  assert.deepEqual(state.opportunity.slots, { "organization context": "ทีมขาย", "audience size": "20 คน" });
  assert.deepEqual(state.opportunity.missingSlots, ["business need"]);
  assert.equal(state.opportunity.handoffReady, false);
  assert.equal(state.opportunity.upsizeEligible, false);
});

test("Opportunity Layer: raw scorer sales_signals never masquerades as normalized state", () => {
  assert.equal(normalizedOpportunityState({
    sales_signals: {
      customer_journey: "returning_student",
      decision_role: { role: "owner", explicit: false },
      opportunity: { type: "private_inhouse", slots: { audience_size: "20" } },
    },
  }), null);

  const unknown = normalizedOpportunityState({ sales: { enabled: true, customerJourney: "untrusted-value" } });
  assert.equal(unknown.customerJourney, "ยังไม่ทราบ / ยังไม่ยืนยัน");
  assert.equal(unknown.decisionRole, "ยังไม่มีการยืนยัน");
  assert.equal(unknown.opportunity, null);
});
