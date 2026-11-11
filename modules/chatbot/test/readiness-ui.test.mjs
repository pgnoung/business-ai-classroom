import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";
import { createReadinessPage } from "../public/console/readiness.mjs";

function textOf(node) {
  if (!node) return "";
  if (node.nodeType === 3) return String(node.textContent || "");
  return (node.children || []).map(textOf).join(" ");
}

test("readiness page renders only owner-safe brain and LINE OA status, with no mutation control", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/readiness" });
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === "/console/api/brain/readiness") return { ok: true, readiness: {
      live: { exists: true, seq: 7 }, flags: { knowledgeVersioned: true, brainRetrievalEnabled: false, brainRead: "legacy" },
      parity: { ok: true, reason: "ok", mismatchParts: [], streakDays: 3 }, debt: { pending: true, countsByCode: { L02: 17 } },
      selfEdit: { blockingCount: 2 }, publication: { ownerReviewRequired: true, inheritedAckRequired: true }, activation: { status: "not_evaluated" },
    } };
    if (path === "/console/api/line-oa/status") return { ok: true, scope: "one_business_per_instance", channels: [{
      id: "main", label: "LINE OA หลัก", active: true,
      webhook: { configured: true, provenConnected: false, status: "configured" },
      managerDirect: { observed: false, status: "unobserved" }, curatedQa: { enabled: true, status: "queue_available", href: "#/teach-intake" },
      nativeBackup: { status: "schema_unverified", message: "ยังไม่มีตัวอ่านไฟล์ backup ของ LINE OA" }, nativePerChatTags: { status: "not_available", message: "ระบบไม่มี API สำหรับอ่านหรือเขียน native tag รายห้องของ LINE OA" },
    }], roomNote: { href: "#/chat", message: "บันทึกสรุปส่งต่อในห้องลูกค้านั้น" }, localTagSafety: { status: "local_only", message: "ป้ายในคอนโซลเป็นข้อมูลภายใน" }, notices: [] };
    throw new Error("unexpected API");
  };
  const render = createReadinessPage({ api, mount: (...nodes) => doc.body.replaceChildren(...nodes), pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {} });
  await render();
  const output = textOf(doc.body);
  assert.match(output, /ความพร้อมสมองและ LINE OA/u);
  assert.match(output, /ประเด็นสืบทอดที่ยังรอเจ้าของตรวจ 17 รายการ/u);
  assert.match(output, /จำนวนนี้ไม่ใช่จำนวนลูกค้าที่มีปัญหา/u);
  assert.match(output, /ยังไม่ยืนยันจากผู้ให้บริการ/u);
  assert.match(output, /คำตอบจาก OA Manager/u);
  assert.match(output, /ยังไม่มีตัวอ่านไฟล์ backup ของ LINE OA/u);
  assert.match(output, /ยังไม่มีช่องทางซิงก์แท็กรายห้องจาก LINE/u);
  assert.equal(doc.querySelectorAll("button").map(textOf).join(" "), "รีเฟรชข้อมูล");
  assert.deepEqual(calls.sort(), ["/console/api/brain/readiness", "/console/api/line-oa/status"].sort());
});

test("readiness ignores a deferred response after navigation away", async (t) => {
  installBrowserGlobals(t, { hash: "#/readiness" });
  let resolveBrain; let resolveLine;
  const brain = new Promise((resolve) => { resolveBrain = resolve; });
  const line = new Promise((resolve) => { resolveLine = resolve; });
  const mounted = [];
  const render = createReadinessPage({ api: (path) => path.includes("brain") ? brain : line, mount: (...nodes) => mounted.push(nodes), pageHeader: () => null, tabBar: () => null, stopPolling: () => {}, setView: () => {} });
  const pending = render();
  location.hash = "#/chat";
  resolveBrain({ ok: true, readiness: {} }); resolveLine({ ok: true, channels: [] });
  await pending;
  assert.equal(mounted.length, 0);
});

test("readiness keeps only the latest refresh when requests resolve out of order", async (t) => {
  installBrowserGlobals(t, { hash: "#/readiness" });
  const first = []; const second = [];
  const api = (path) => {
    const queue = calls === 0 ? first : second;
    const slot = {};
    queue.push(slot);
    if (queue.length === 2) calls += 1;
    return new Promise((resolve) => { slot.resolve = resolve; });
  };
  let calls = 0;
  const mounted = [];
  const render = createReadinessPage({ api, mount: (...nodes) => mounted.push(nodes), pageHeader: () => null, tabBar: () => null, stopPolling: () => {}, setView: () => {} });
  const older = render();
  const newer = render();
  second.forEach((slot, index) => slot.resolve(index === 0 ? { ok: true, readiness: {} } : { ok: true, channels: [] }));
  await newer;
  first.forEach((slot, index) => slot.resolve(index === 0 ? { ok: true, readiness: {} } : { ok: true, channels: [] }));
  await older;
  assert.equal(mounted.length, 1);
});
