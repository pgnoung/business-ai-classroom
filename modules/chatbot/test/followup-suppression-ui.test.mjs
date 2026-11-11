import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";
import { followupSuppressionBadge, followupSuppressionLabel } from "../public/console/ui.mjs";

const textOf = (node) => [node?.textContent || "", ...(node?.children || []).map(textOf)].join("");

test("suppression badge describes a recorded stop, not a new unscored customer", (t) => {
  installBrowserGlobals(t);
  assert.equal(followupSuppressionBadge({ followup_enabled: 0 }), null);
  assert.equal(followupSuppressionBadge({ followup_enabled: 1, followup_suppression_reason: "customer_considering" }), null);
  const customer = { followup_enabled: 0, followup_suppression_reason: "customer_considering" };
  const badge = followupSuppressionBadge(customer);
  assert.equal(textOf(badge), "ไม่ต้องติดตาม");
  assert.match(badge.getAttribute("title"), /คิดดูก่อน/u);
  assert.equal(followupSuppressionLabel(customer), "ลูกค้าขอคิดดูก่อน");
});

test("unknown suppression reasons never render stored text or markup", (t) => {
  installBrowserGlobals(t);
  const customer = { followup_enabled: 0, followup_suppression_reason: "<script>private</script>" };
  const badge = followupSuppressionBadge(customer);
  assert.equal(textOf(badge), "ไม่ต้องติดตาม");
  assert.doesNotMatch(badge.getAttribute("title"), /script|private/);
  assert.equal(badge.querySelectorAll("script").length, 0);
});
