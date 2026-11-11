import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";
import { createTrainingIntakePage } from "../public/console/trainingIntake.mjs";

function textOf(node) {
  if (!node) return "";
  if (node.nodeType === 3) return String(node.textContent || "");
  return (node.children || []).map(textOf).join(" ");
}

test("training intake collection mode stays available while publication is not ready", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach-intake" });
  const { createTrainingIntakePage } = await import("../public/console/trainingIntake.mjs");
  const calls = [];
  const api = async (path, options) => {
    calls.push({ path, options });
    if (path === "/console/api/teach/intake") return { ok: true, enabled: true, ready: true, publicationReady: false, message: "ยังรอการเปิดใช้ในขั้นถัดไป", channels: [{ id: "branch-a", label: "สาขา A" }] };
    if (path.endsWith("/preview")) return { ok: true, previewHash: "preview-1", canCommit: true, rows: [{ index: 0, title: "หัวข้อ" }], summary: { total: 1, ready: 1, blocked: 0, duplicates: 0 } };
    throw new Error("unexpected API");
  };
  const render = createTrainingIntakePage({ api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes), pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {} });
  await render();
  assert.match(textOf(doc.body), /ยังไม่เชื่อมประวัติหรือแท็ก LINE OA อัตโนมัติ/u);
  assert.match(textOf(doc.body), /ยังไม่เผยแพร่/u);
  assert.match(textOf(doc.body), /รับข้อเสนอได้ • ยังไม่เปิดใช้ตอบลูกค้า/u);
  assert.match(textOf(doc.body), /หมวดความรู้/u);
  assert.match(textOf(doc.body), /คลาสหรือบริการที่เกี่ยวข้อง/u);
  assert.match(textOf(doc.body), /คำค้นที่เกี่ยวข้อง/u);
  const preview = doc.querySelectorAll("button").find((node) => textOf(node) === "ตรวจตัวอย่างก่อนเสนอ");
  preview.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  const submit = doc.querySelectorAll("button").find((node) => textOf(node) === "เสนอเข้าคิวตรวจ");
  assert.equal(submit.disabled, true, "review checkbox remains a required human step");
  const check = doc.querySelector(".ti-reviewed");
  check.checked = true; check.dispatch("change");
  assert.equal(submit.disabled, false, "checked review allows a valid preview to be proposed");
  const firstInput = doc.querySelector(".ti-row").querySelector("input");
  firstInput.value = "แก้แล้ว";
  firstInput.dispatch("input");
  assert.equal(submit.disabled, true, "any row edit invalidates the preview receipt");
  assert.equal(calls.filter((call) => call.path.endsWith("/commit")).length, 0);
});

test("intake proposal waits for publication readiness while a generic proposal keeps approval", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/corrections" });
  doc.body.append(doc.createElement("div"));
  doc.body.children[0].setAttribute("id", "app");
  const previousFetch = globalThis.fetch;
  const previousRaf = globalThis.requestAnimationFrame;
  const requests = [];
  globalThis.fetch = async (path, options = {}) => {
    requests.push({ path: String(path), options });
    return { ok: true, status: 200, json: async () => ({ operator: null, features: {}, candidates: [], corrections: [], runs: [] }) };
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  // `reject` deliberately completes its normal rerender path; use a synchronous
  // frame in this narrow console-card test so that lifecycle finishes before
  // test cleanup restores browser globals.
  globalThis.requestAnimationFrame = (callback) => { callback(); return 0; };
  t.after(() => {
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  });
  const { learningCandidateCard } = await import("../public/console/console.js");
  const intake = learningCandidateCard({ id: "intake", created_at: Date.now(), title: "ทีมคัด", proposed_content: "คำตอบ", riskFlags: [], evidence: [{ type: "training_intake", knowledgeMetadata: {} }] }, { canPublish: false, message: "รับข้อเสนอได้ แต่ยังรอเปิดใช้" });
  const intakeButtons = intake.querySelectorAll("button");
  assert.equal(intakeButtons.find((node) => textOf(node) === "อนุมัติเข้าความรู้").disabled, true);
  assert.equal(intakeButtons.find((node) => textOf(node) === "ตรวจรายการนี้อีกครั้ง").disabled, true);
  assert.equal(intakeButtons.find((node) => textOf(node) === "ปัดตก").disabled, false);
  assert.match(textOf(intake), /รออนุมัติเข้าคลังความรู้/u);
  intakeButtons.find((node) => textOf(node) === "ตรวจรายการนี้อีกครั้ง").dispatch("click");
  intakeButtons.find((node) => textOf(node) === "อนุมัติเข้าความรู้").dispatch("click");
  assert.equal(requests.filter((request) => request.path.includes("/learning/intake/decide")).length, 0, "disabled intake actions must not POST when dispatched programmatically");
  intakeButtons.find((node) => textOf(node) === "ปัดตก").dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.filter((request) => request.path.includes("/learning/intake/decide")).length, 1, "reject remains available");
  const generic = learningCandidateCard({ id: "generic", created_at: Date.now(), title: "คำแก้", proposed_content: "คำตอบ", riskFlags: [], evidence: [] }, { canPublish: false, message: "unused" });
  assert.equal(generic.querySelectorAll("button").find((node) => textOf(node) === "อนุมัติเข้าความรู้").disabled, false);
});

test("training intake commits its immutable reviewed snapshot once and shows rejected rows safely", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach-intake" });
  const calls = [];
  const api = async (path, options) => {
    calls.push({ path, options });
    if (path === "/console/api/teach/intake") return { ok: true, enabled: true, ready: true, channels: [{ id: null, label: "กลาง" }] };
    if (path.endsWith("/preview")) return { ok: true, previewHash: "preview-1", canCommit: true,
      rows: [{ index: 0, title: "คำตอบปลอดภัย", content: "คำถาม: ตัวอย่าง\nคำตอบ: ทั่วไป" }, { index: 1, issueCodes: ["personal_or_financial_data"] }],
      summary: { total: 2, ready: 1, blocked: 1, duplicates: 0 } };
    if (path.endsWith("/commit")) return { ok: true, created: 1, published: false };
    throw new Error("unexpected API");
  };
  const render = createTrainingIntakePage({ api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes), pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {} });
  await render();
  doc.querySelectorAll("button").find((node) => textOf(node) === "ตรวจตัวอย่างก่อนเสนอ").dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(textOf(doc.body), /คำถาม: ตัวอย่าง/u);
  assert.match(textOf(doc.body), /อาจมีข้อมูลส่วนบุคคลหรือการเงิน/u);
  const check = doc.querySelector(".ti-reviewed"); check.checked = true; check.dispatch("change");
  const submit = doc.querySelectorAll("button").find((node) => textOf(node) === "เสนอเข้าคิวตรวจ");
  submit.dispatch("click"); submit.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  const commits = calls.filter((call) => call.path.endsWith("/commit"));
  assert.equal(commits.length, 1, "busy commit cannot send a duplicate proposal");
  assert.equal(commits[0].options.body.confirm, true);
  assert.equal(commits[0].options.body.previewHash, "preview-1");
  assert.equal(submit.disabled, true, "accepted preview is consumed after a successful commit");
  submit.dispatch("click");
  await Promise.resolve();
  assert.equal(calls.filter((call) => call.path.endsWith("/commit")).length, 1, "a settled success cannot be submitted again");
  const sample = doc.querySelectorAll("a").find((node) => textOf(node) === "ดาวน์โหลดตัวอย่างทั่วไป CSV");
  assert.equal(sample?.getAttribute("href"), "/console/static/training-intake-sample.csv", "sample must use a same-origin static asset, not a blocked data URL");
});

test("an edit during a deferred commit cannot change the already reviewed snapshot", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach-intake" });
  let resolveCommit;
  const pendingCommit = new Promise((resolve) => { resolveCommit = resolve; });
  const calls = [];
  const api = async (path, options) => {
    calls.push({ path, options });
    if (path === "/console/api/teach/intake") return { ok: true, enabled: true, ready: true, channels: [] };
    if (path.endsWith("/preview")) return { ok: true, previewHash: "reviewed-before-edit", canCommit: true, rows: [], summary: { total: 1, ready: 1 } };
    if (path.endsWith("/commit")) return pendingCommit;
    throw new Error("unexpected API");
  };
  const render = createTrainingIntakePage({ api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes), pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {} });
  await render();
  doc.querySelectorAll("button").find((node) => textOf(node) === "ตรวจตัวอย่างก่อนเสนอ").dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  const check = doc.querySelector(".ti-reviewed"); check.checked = true; check.dispatch("change");
  const submit = doc.querySelectorAll("button").find((node) => textOf(node) === "เสนอเข้าคิวตรวจ");
  submit.dispatch("click");
  const firstInput = doc.querySelector(".ti-row").querySelector("input");
  firstInput.value = "แก้หลังตรวจ"; firstInput.dispatch("input");
  resolveCommit({ ok: true, created: 1, published: false });
  await new Promise((resolve) => setImmediate(resolve));
  const commit = calls.find((call) => call.path.endsWith("/commit"));
  assert.equal(commit.options.body.previewHash, "reviewed-before-edit");
  assert.notEqual(commit.options.body.entries[0].title, "แก้หลังตรวจ");
  assert.match(textOf(doc.body), /ข้อมูลที่แก้ภายหลังยังไม่ได้เสนอ/u);
  assert.equal(submit.disabled, true);
});

test("a deferred preview cannot restore a receipt after the team edits the form", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach-intake" });
  let resolvePreview;
  const pending = new Promise((resolve) => { resolvePreview = resolve; });
  const api = async (path) => {
    if (path === "/console/api/teach/intake") return { ok: true, enabled: true, ready: true, channels: [] };
    if (path.endsWith("/preview")) return pending;
    throw new Error("unexpected API");
  };
  const render = createTrainingIntakePage({ api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes), pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {} });
  await render();
  doc.querySelectorAll("button").find((node) => textOf(node) === "ตรวจตัวอย่างก่อนเสนอ").dispatch("click");
  const firstInput = doc.querySelector(".ti-row").querySelector("input");
  firstInput.value = "แก้ระหว่างรอ"; firstInput.dispatch("input");
  resolvePreview({ ok: true, previewHash: "old", canCommit: true, rows: [], summary: { total: 1, ready: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(textOf(doc.body), /ผลตรวจก่อนเสนอ/u);
  assert.equal(doc.querySelectorAll("button").find((node) => textOf(node) === "เสนอเข้าคิวตรวจ").disabled, true);
});
