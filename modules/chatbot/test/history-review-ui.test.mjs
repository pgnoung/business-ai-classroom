import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";
import { createReviewState, renderJevDecision, reviewIsDirty } from "../public/console/historyAudit.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, api) {
  const { doc } = installBrowserGlobals(t, { hash: "#/history" });
  const row = { id: "case", canReview: true, original: { stop: "permanent", notify: "provider_accepted" }, comparison: { stop: "disagree", notify: "agree" },
    jev: { status: "reviewed", stop: { choice: "continue", confidence10: 9 }, notify: { choice: "notify", confidence10: 9 } },
    feedback: { stop: "incorrect", notify: "correct", note: "saved note", revision: 4 } };
  const review = createReviewState(row), container = doc.createElement("div"); doc.body.append(container);
  // The lightweight fixture DOM does not implement this browser property.
  container.isConnected = true;
  const render = () => renderJevDecision(container, { api, batchId: "batch", row, review, isOwner: true });
  render();
  const select = key => container.querySelectorAll("select").find(node => node.attributes["aria-label"] === key);
  const clickSave = () => container.querySelectorAll("button").find(node => node.attributes.type === "button").dispatch("click");
  return { row, review, container, render, select, clickSave };
}

test("review prefill and transcript rerender preserve draft and untouched saved labels", async t => {
  let payload;
  const f = fixture(t, async (_path, options) => { payload = options.body; return { review: { ...options.body, revision: 5 } }; });
  assert.equal(f.select("ความเห็นเรื่องหยุด AI").value, "incorrect");
  assert.equal(f.select("ความเห็นเรื่องแจ้งแอดมิน").value, "correct");
  const input = f.select("ความเห็นเรื่องหยุด AI"); input.value = "correct"; input.dispatch("change", { target: input });
  const note = f.container.querySelector("textarea"); note.value = "draft note"; note.dispatch("input", { target: note });
  assert.equal(reviewIsDirty(f.review), true);
  f.render();
  assert.equal(f.container.querySelector("textarea").value, "draft note");
  f.clickSave(); await flush();
  assert.deepEqual(payload, { stop: "correct", notify: "correct", note: "draft note", expectedRevision: 4 });
  assert.equal(reviewIsDirty(f.review), false);
});

test("conflict keeps draft and prevents repeated stale writes until explicit refresh", async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; const error = new Error("review_conflict"); error.status = 409; throw error; });
  const note = f.container.querySelector("textarea"); note.value = "do not lose me"; note.dispatch("input", { target: note });
  f.clickSave(); await flush();
  assert.equal(f.review.conflict, true); assert.equal(f.review.draft.note, "do not lose me");
  f.clickSave(); await flush(); assert.equal(calls, 1);
});

test("a native unclear question cannot be marked through its review control", t => {
  const f = fixture(t, async () => { throw new Error("must not call"); });
  f.row.jev.notify.choice = "unclear"; f.render();
  assert.equal(f.select("ความเห็นเรื่องแจ้งแอดมิน").attributes.disabled, "true");
});
