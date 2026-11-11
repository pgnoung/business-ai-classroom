// brain-versions-ui.test.mjs — เรนเดอร์แผง "รุ่นสมองลูกแพร" จริงด้วย DOM จำลอง
//
// เหตุผลเดียวกับ console-render-smoke: `node --check` ตรวจแค่ไวยากรณ์ และการอ่านซอร์ส
// ด้วย regex มองไม่เห็น ReferenceError — คนแรกที่เจอไม่ควรเป็นพี่ง้วงตอนเปิดหน้าตั้งค่า
//
// สิ่งที่ต้องกัน: ปุ่มของเจ้าของต้องไม่โผล่ให้ทีมงาน และปุ่มย้อนกลับต้องไม่โผล่บนรุ่นที่
// ใช้งานอยู่ (กดแล้วไม่มีอะไรเกิดขึ้น = ปุ่มที่สอนคนให้ไม่เชื่อหน้าจอ)
import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";

const NOW = 1_760_000_000_000;

function payload({ canManage = true, canary = false, proposed = false } = {}) {
  const versions = [
    {
      versionId: "v3", parentId: "v2", seq: 3, label: "เพิ่มความรู้ ที่จอดรถ",
      status: canary ? "canary" : "live", pointer: canary ? "canary" : "live",
      verdict: "pass", gates: [], findingCount: 0, ackCount: 0,
      createdBy: canary ? "chompoo" : "ngoung", createdAt: NOW - 60_000, publishedAt: NOW - 60_000,
    },
    {
      versionId: "v2", parentId: "v1", seq: 2, label: "แก้ราคา Early Bird",
      status: canary ? "live" : "retired", pointer: canary ? "live" : null,
      verdict: "pass", gates: [], findingCount: 0, ackCount: 0,
      createdBy: "ngoung", createdAt: NOW - 120_000, publishedAt: NOW - 120_000,
    },
    {
      versionId: "v1", parentId: null, seq: 1, label: "นำเข้าจากตารางเดิม",
      status: "retired", pointer: null, verdict: "pass", gates: [], findingCount: 0, ackCount: 0,
      createdBy: "import", createdAt: NOW - 600_000, publishedAt: NOW - 600_000,
    },
  ];
  if (proposed) {
    versions.unshift({
      versionId: "v4", parentId: "v3", seq: 4, label: "เพิ่มความรู้ ที่จอดรถ 2",
      status: "proposed", pointer: null, verdict: "needs_ack", gates: [], findingCount: 1, ackCount: 0,
      createdBy: "ngoung", createdAt: NOW, publishedAt: null,
      findings: [{ code: "L02", severity: "block", message: "การ์ด \"โปรเก่า\" มีตัวเลข 9,500 ที่ไม่อยู่ในตารางราคา" }],
    });
  }
  return {
    ok: true, canManage, enabled: true,
    pending: versions.filter((row) => row.pointer === "canary" || row.status === "proposed").length,
    delegation: { configured: true, active: true, roles: ["operator"], kinds: ["fact"], expiresAt: NOW + 86_400_000 },
    versions,
    findings: {
      live: [{ code: "L02", severity: "warn", message: "การ์ด fact:1 พูดถึงเงื่อนไขเงิน", cardId: "fact:1" }],
      canary: [],
    },
  };
}

function deps(data) {
  const calls = [];
  return {
    calls,
    data,
    api: async (path, options) => { calls.push({ path, options }); return data; },
    toast: () => {},
    refresh: async () => {},
  };
}

function textOf(node) {
  if (!node) return "";
  if (node.nodeType === 3) return node.textContent;
  return (node.children || []).map(textOf).join(" ");
}

function buttons(node) {
  return node.querySelectorAll("button").map((b) => textOf(b).trim());
}

test("เจ้าของเห็นรุ่นที่ใช้อยู่ ผลตรวจ และปุ่มย้อนกลับเฉพาะรุ่นเก่า", async (t) => {
  installBrowserGlobals(t);
  const { brainVersionsBlock } = await import("../public/console/brainVersions.mjs");
  const block = brainVersionsBlock(deps(payload()));
  assert.ok(block, "ต้องวาดแผง");
  const text = textOf(block);
  assert.match(text, /ตอนนี้ลูกแพรใช้สมองรุ่น 3/u);
  assert.match(text, /ผลตรวจของรุ่นที่ใช้อยู่ \(1\)/u);
  assert.match(text, /พูดถึงเงื่อนไขเงิน/u);
  const labels = buttons(block);
  assert.equal(labels.filter((l) => l === "ใช้รุ่นนี้แทน").length, 2, "รุ่นที่ผ่านด่านและไม่ได้ใช้อยู่ = เอามาใช้แทนได้");
  assert.equal(labels.includes("ใช้ทั้งหมดเลย"), false, "ไม่มีรุ่นทดลอง = ไม่ต้องมีปุ่มเลื่อนขั้น");
});

test("มีรุ่นทดลอง: ขึ้นป้ายเตือน + ปุ่มเลื่อนขั้นบนใบนั้นใบเดียว", async (t) => {
  installBrowserGlobals(t);
  const { brainVersionsBlock } = await import("../public/console/brainVersions.mjs");
  const block = brainVersionsBlock(deps(payload({ canary: true })));
  assert.match(textOf(block), /มีรุ่นค้าง 1/u);
  assert.equal(buttons(block).filter((l) => l === "ใช้ทั้งหมดเลย").length, 1);
});

test("รุ่นที่รอรับทราบ: มีปุ่มรับทราบและใช้งาน", async (t) => {
  installBrowserGlobals(t);
  const { brainVersionsBlock } = await import("../public/console/brainVersions.mjs");
  const block = brainVersionsBlock(deps(payload({ proposed: true })));
  assert.match(textOf(block), /รอรับทราบ/u);
  assert.equal(buttons(block).filter((l) => l === "รับทราบและใช้งาน").length, 1);
  // ข้อ 16: ห้ามให้กดรับทราบตาบอด — ข้อค้างต้องอยู่ในการ์ดเดียวกับปุ่ม
  assert.match(textOf(block), /ข้อค้างที่ต้องรับทราบ \(1\)/u);
  assert.match(textOf(block), /9,500/u);
  assert.equal(buttons(block).filter((l) => l === "ปัดตก").length, 1, "รุ่นที่ค้างต้องปัดตกได้");
});

test("ทีมงาน: อ่านได้ครบ แต่ไม่มีปุ่มของเจ้าของสักปุ่ม", async (t) => {
  installBrowserGlobals(t);
  const { brainVersionsBlock } = await import("../public/console/brainVersions.mjs");
  const block = brainVersionsBlock(deps(payload({ canManage: false, canary: true, proposed: true })));
  assert.match(textOf(block), /ตอนนี้ลูกแพรใช้สมองรุ่น 2/u);
  assert.deepEqual(buttons(block), [], "ทีมงานต้องไม่เห็นปุ่มที่กดแล้วเด้ง 403");
});

test("ยังไม่มีรุ่นสมองเลย (แฟล็กปิด) -> ไม่วาดกล่องว่างเกะกะ", async (t) => {
  installBrowserGlobals(t);
  const { brainVersionsBlock } = await import("../public/console/brainVersions.mjs");
  assert.equal(brainVersionsBlock(deps({ ok: true, enabled: true, versions: [] })), null);
  assert.equal(brainVersionsBlock({
    data: null, api: async () => {}, toast: () => {}, refresh: async () => {},
  }), null, "เส้นล้มต้องไม่ลากหน้าตั้งค่าทั้งหน้าให้พัง");
  // แฟล็กปิด: ปุ่มทุกปุ่มตอบ 409 อยู่แล้ว ห้ามวาดปุ่มที่กดแล้วไม่มีอะไรเกิดขึ้น
  assert.equal(brainVersionsBlock(deps({ ...payload(), enabled: false })), null,
    "แฟล็กปิดต้องไม่วาดแผงและปุ่มเลย");
});

test("รุ่นทดลองที่ถูกแทนที่แล้ว ต้องไม่แสดงว่ายัง 'ทดลอง' อยู่", async (t) => {
  installBrowserGlobals(t);
  const { versionStatusKey } = await import("../public/console/brainVersions.mjs");
  assert.equal(versionStatusKey({ pointer: "canary", status: "canary" }), "canary");
  assert.equal(versionStatusKey({ pointer: null, status: "canary" }), "canary_retired");
  assert.equal(versionStatusKey({ pointer: "live", status: "live" }), "live");
  assert.equal(versionStatusKey({ pointer: null, status: "retired" }), "retired");
});

test("toast ต้องพูดความจริงตามผลที่เซิร์ฟเวอร์ตอบ ไม่ใช่ 'บันทึกแล้ว' ทุกกรณี", async (t) => {
  installBrowserGlobals(t);
  const { publishToast, PUBLISH_SUBMIT_TOAST } = await import("../public/console/publishQueue.mjs");
  const saved = "บันทึกแล้ว — AI จะใช้ตอบตั้งแต่ข้อความถัดไป";

  assert.equal(publishToast({ ok: true }, saved), saved, "ทำจริงแล้วก็พูดตามเดิม");
  assert.equal(publishToast({ ok: true, brain: { outcome: "live" } }, saved), saved);
  assert.equal(publishToast({ queued: true, message: PUBLISH_SUBMIT_TOAST }, saved), PUBLISH_SUBMIT_TOAST);
  assert.equal(publishToast({ ok: true, brain: { outcome: "canary" } }, saved),
    "ส่งเป็นรุ่นทดลองแล้ว รอพี่ง้วงกดใช้");
  assert.match(publishToast({ ok: true, brain: { outcome: "needs_ack" } }, saved), /รับทราบ/u);
  // แฟล็กปิด = ไม่มีคีย์ brain เลย ต้องได้ข้อความเดิมเป๊ะ
  assert.equal(publishToast({ ok: true, entry: {} }, saved), saved);
});

test("คิวคำขอ: สถานะรอรับทราบต้องเป็นภาษาคน ไม่ใช่โทเคนดิบ pending_ack", async (t) => {
  installBrowserGlobals(t);
  const { publishQueueBlock } = await import("../public/console/publishQueue.mjs");
  const request = {
    id: "r1", kind: "knowledge_add", method: "POST", route: ["knowledge"], body: { title: "ที่จอดรถ" },
    summary: "เพิ่มความรู้ ที่จอดรถ", proposedBy: "chompoo", status: "pending_ack",
    decidedBy: "ngoung", decidedAt: NOW, decisionNote: "รอพี่ง้วงรับทราบรุ่นสมอง 2",
    result: null, createdAt: NOW - 1000, awaitingVersionId: "v2",
  };
  const block = await publishQueueBlock({
    api: async (path) => (path.includes("status=pending")
      ? { ok: true, canApprove: true, pending: 1, requests: [request] }
      : { ok: true, canApprove: true, pending: 0, requests: [] }),
    toast: () => {}, refresh: async () => {}, now: NOW,
  });
  const text = textOf(block);
  assert.match(text, /รอพี่ง้วงรับทราบรุ่นสมอง/u, "ต้องแปลสถานะเป็นภาษาคน");
  assert.doesNotMatch(text, /pending_ack/u, "ห้ามโชว์โทเคนดิบให้คนอ่าน");
});
