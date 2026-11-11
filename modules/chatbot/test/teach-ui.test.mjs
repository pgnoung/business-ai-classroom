// teach-ui.test.mjs — เรนเดอร์กล่องตรวจ จอสอน และแผง "ทำไมตอบแบบนี้" ด้วย DOM จำลอง
//
// เหตุผลเดียวกับ console-render-smoke: `node --check` ตรวจแค่ไวยากรณ์ และการอ่านซอร์ส
// ด้วย regex มองไม่เห็น ReferenceError — คนแรกที่เจอไม่ควรเป็นพี่ง้วงตอนเปิดกล่องตรวจ
// จากมือถือ
//
// สิ่งที่ไฟล์นี้กันเพิ่มจาก smoke ทั่วไป:
//   1. ปุ่มที่ไม่ควรมี (สอนเรื่องที่เฟสนี้ยังเขียนไม่ได้) ต้องไม่ถูกวาด
//   2. จอสอนต้องอธิบายสีและคำที่ทำให้ยกระดับ ไม่ใช่แค่บล็อกเงียบ
//   3. Step 0 ต้องพิมพ์ตามที่เซิร์ฟเวอร์บอก — ห้ามเติมคำว่า "รุ่นสมอง" ให้เทิร์นที่ไม่มี
//   4. ทุกจอต้องเรนเดอร์จบที่ 375 px โดยไม่มีองค์ประกอบที่บังคับความกว้างคงที่
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installBrowserGlobals } from "./console-dom.mjs";

const NOW = 1_788_000_000_000;
const CUSTOMER = "U00000000000000000000000000000a02";

function reviewPayload(rows = defaultRows()) {
  return { ok: true, rows, canPublish: { knowledge: true, prices: true }, queueInstead: false };
}

function defaultRows() {
  return [
    {
      id: "correction:c1", source: "correction", refId: "c1", kind: "fact", risk: "green",
      title: "ทีมงานแก้คำตอบของลูกแพร แต่ยังไม่ได้สอนให้จำ",
      detail: "จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ", before: "จอดฟรี 2 ชั่วโมงค่ะ",
      at: NOW - 60_000, customerId: CUSTOMER, ownerOnly: false,
      actions: { teach: true, dismiss: true, openChat: true }, blockedWhy: "",
    },
    {
      id: "correction:c2", source: "guard_block", refId: "c2", kind: "price", risk: "red",
      title: "ลูกแพรจะพูดตัวเลข 9,500 ที่ไม่อยู่ในตารางราคา — ตัวกรองกันไว้",
      detail: "คลาสนี้ลดเหลือ 9,500 บาทค่ะ", before: "", amounts: ["9,500"],
      at: NOW - 120_000, customerId: CUSTOMER, ownerOnly: true,
      actions: { teach: true, dismiss: true, openChat: true }, blockedWhy: "",
    },
    {
      id: "lint:L03:schedule:1", source: "lint", refId: "schedule:1", kind: "schedule", risk: "yellow",
      title: "รอบ 2020-01-10 (รอบเก่า) ผ่านไปแล้วแต่ยังเปิดรับสมัคร — ปิดรอบหรือเลื่อนวัน",
      detail: "ยังเผยแพร่ได้ แต่ควรเก็บก่อนกลายเป็นของค้าง", before: "", at: 0,
      customerId: "", ownerOnly: true,
      actions: { teach: false, dismiss: false, openChat: false }, goTo: "#/rounds", blockedWhy: "",
    },
  ];
}

function sessionPayload(overrides = {}) {
  return {
    ok: true,
    chips: [
      { id: "wrong_fact", label: "ข้อมูลผิด", kind: "fact", writable: true },
      { id: "wrong_price", label: "ราคาผิด", kind: "price", writable: true },
      { id: "should_handoff", label: "ควรส่งต่อคน", kind: "route_label", writable: false, why: "ยังไม่เปิดในเฟสนี้" },
    ],
    source: "correction", ref: "c1",
    aiDraft: "จอดฟรี 2 ชั่วโมงค่ะ",
    correctText: "จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ",
    selectedChips: [],
    proposal: {
      kind: "fact", risk: "green", riskLabel: "เขียว", blocked: false, blockReason: "",
      writable: true, notWritableWhy: "", flags: [], escalatedBy: [], chipKind: null, splitHint: "",
    },
    related: [{
      id: "k1", title: "ที่จอดรถและการเดินทาง", score: 0.42, weak: false,
      content: "จอดฟรี 2 ชั่วโมงที่อาคาร B", chars: 26, excerpt: "จอดฟรี 2 ชั่วโมงที่อาคาร B",
    }],
    searchIsWeak: false,
    prices: [{ label: "AI Agent for Business", amount: 19900 }],
    customerId: CUSTOMER, at: NOW - 60_000, decidedAt: null, status: "candidate",
    canPublish: { knowledge: true, prices: true },
    ...overrides,
  };
}

function makeDeps(doc, { review = reviewPayload(), session = sessionPayload(), why = null } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/console/api/teach/review")) return review;
    if (path.startsWith("/console/api/teach/session")) return session;
    if (path.startsWith("/console/api/teach/plan")) {
      return { ok: true, proposal: session.proposal, related: session.related };
    }
    if (path.startsWith("/console/api/teach/why")) return { ok: true, why };
    return { ok: true };
  };
  return {
    calls,
    deps: {
      api,
      uploadMedia: async () => ({ ok: true }),
      toast: () => {},
      mount: (...nodes) => doc.body.replaceChildren(...nodes.flat(Infinity).filter(Boolean)),
      pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
      tabBar: () => doc.createElement("nav"),
      stopPolling: () => {},
      setView: () => {},
      channelName: () => "default",
      state: {
        me: { username: "ngoung", role: "owner", capabilities: ["knowledge.publish", "prices.manage", "corrections.review"] },
        features: { teach: true },
      },
    },
  };
}

const textOf = (node) => JSON.stringify(node, (key, value) => (key === "parent" ? undefined : value));

/* --------------------------------- กล่องตรวจ --------------------------------- */

test("กล่องตรวจ: เรนเดอร์ครบทุกแหล่ง และแต่ละแถวบอกว่าเกิดอะไรขึ้นเป็นภาษาคน", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { deps } = makeDeps(doc);
  await createReviewPage(deps)();

  const text = textOf(doc.body);
  assert.match(text, /ทีมงานแก้คำตอบของลูกแพร/u, "คำแก้ของทีมต้องขึ้น");
  assert.match(text, /ไม่อยู่ในตารางราคา/u, "ร่างที่ตัวกรองกันต้องขึ้น");
  assert.match(text, /ผ่านไปแล้วแต่ยังเปิดรับสมัคร/u, "ของค้างในสมองต้องขึ้น");
  assert.equal(doc.querySelectorAll(".ri-card").length, 3);
  assert.equal(doc.querySelectorAll(".ri-red").length, 1, "แถวสีแดงต้องมีเส้นขอบของตัวเอง");
});

test("กล่องตรวจ: แถวที่สอนจากจอนี้ไม่ได้ ต้องไม่มีปุ่มสอน แต่ต้องมีทางไปแก้", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { deps } = makeDeps(doc);
  await createReviewPage(deps)();

  const lintCard = doc.querySelectorAll(".ri-card")[2];
  assert.equal(lintCard.querySelectorAll(".ri-teach").length, 0, "แถวของค้างต้องไม่มีปุ่มสอน");
  assert.match(textOf(lintCard), /ไปหน้าที่แก้ได้/u, "ต้องมีทางไปหน้าที่แก้ได้จริง");
});

test("กล่องตรวจ: ปุ่มสอนลิงก์ไปจอสอนพร้อมที่มา ไม่ใช่หน้ากลาง ๆ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { deps } = makeDeps(doc);
  await createReviewPage(deps)();

  const teachLinks = doc.querySelectorAll(".ri-teach").map((a) => a.getAttribute("href"));
  assert.deepEqual(teachLinks, ["#/teach/correction/c1", "#/teach/guard_block/c2"]);
});

test("กล่องตรวจ: กล่องว่างต้องบอกว่าไม่มีอะไรรอ ไม่ใช่หน้าโล่ง", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { deps } = makeDeps(doc, { review: reviewPayload([]) });
  await createReviewPage(deps)();
  assert.match(textOf(doc.body), /ไม่มีอะไรรอตัดสิน/u);
});

test("กล่องตรวจ: บัญชีที่เผยแพร่เองไม่ได้ ต้องรู้ล่วงหน้าว่ากดแล้วจะเข้าคิว", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { deps } = makeDeps(doc, {
    review: { ...reviewPayload(), canPublish: { knowledge: false, prices: false }, queueInstead: true },
  });
  await createReviewPage(deps)();
  assert.match(textOf(doc.body), /คำขอให้พี่ง้วงกดอนุมัติ/u);
});

/* ----------------------------------- จอสอน ----------------------------------- */

test("จอสอน: เติมคำตอบที่ทีมพิมพ์ไว้ให้แล้ว และบอกว่าลูกแพรเคยตอบว่าอะไร", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc);
  await createTeachPage(deps)({ source: "correction", ref: "c1" });

  assert.equal(doc.querySelector(".kn-content").value, "จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ");
  assert.match(textOf(doc.body), /ลูกแพรตอบไว้ว่า/u);
  assert.match(textOf(doc.body), /ที่จอดรถและการเดินทาง/u, "ต้องเห็นการ์ดที่น่าจะเกี่ยว");
  assert.match(textOf(doc.body), /ไม่ใช่หลักฐานว่าลูกแพรใช้ใบไหนตอบ/u, "ต้องพูดตรง ๆ ว่าเป็นการจับคำ");
});

test("จอสอน: ปุ่มส่งบอกสิ่งที่จะเกิดขึ้นจริง — สร้างใบใหม่ vs แก้ใบเดิม", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc);
  await createTeachPage(deps)({ source: "correction", ref: "c1" });

  const send = doc.querySelector(".tc-send");
  assert.equal(send.textContent, "เพิ่มเป็นความรู้ใหม่");
  const picks = doc.querySelectorAll(".tc-pick");
  assert.equal(picks.length, 2, "ต้องมีตัวเลือกสร้างใหม่ + การ์ดที่น่าจะเกี่ยว");
  picks[1].dispatch("click");
  assert.equal(doc.querySelector(".tc-send").textContent, "แทนที่ข้อความทั้งใบ");
});

test("จอสอน: correction ที่ยังไม่มีคำแก้ บันทึกได้แต่สอนไม่ได้จนกว่าจะต่างจากร่าง", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/guard_block/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc, {
    session: sessionPayload({
      source: "guard_block", correctText: "", teachingBlocked: true,
      teachingBlockedReason: "บันทึกคำแก้ของคนที่ต่างจากร่างเดิมก่อน จึงจะสอนลูกแพรจากรายการนี้ได้",
      inboundSource: { available: false },
    }),
  });
  await createTeachPage(deps)({ source: "guard_block", ref: "c1" });
  assert.equal(doc.querySelector(".tc-send").disabled, true);
  assert.ok(doc.querySelector(".tc-save-correction"), "ต้องมีทางบันทึก human_final โดยไม่เผยแพร่");
  assert.match(textOf(doc.body), /ข้อความต้นทางที่เชื่อมไว้: ยังไม่มีข้อมูล/u);
});

test("จอสอน: ป้าย provenance ระบบแยกจากเหตุผลของทีม และร่างยังไม่ส่งไม่ถูกเรียกว่าตอบแล้ว", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/guard_block/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc, {
    session: sessionPayload({
      source: "guard_block", correctText: "", draftLabel: "ร่างของลูกแพร:",
      provenance: { recorded: true, label: "ที่มาร่างของระบบ: ด่านตรวจคำตอบ (คำต้องห้าม)" },
      humanDecisionReason: "ทีมขอปรับน้ำเสียง", teachingBlocked: true,
    }),
  });
  await createTeachPage(deps)({ source: "guard_block", ref: "c1" });
  const text = textOf(doc.body);
  assert.match(text, /ร่างของลูกแพร:/u);
  assert.match(text, /ที่มาร่างของระบบ: ด่านตรวจคำตอบ \(คำต้องห้าม\)/u);
  assert.match(text, /เหตุผลที่ทีมบันทึก: ทีมขอปรับน้ำเสียง/u);
  assert.doesNotMatch(text, /ลูกแพรตอบไว้ว่า: จอดฟรี 2 ชั่วโมง/u);
});

test("จอสอน: source รูปบอกชนิดและเปิดทั้งห้อง ไม่แต่งข้อความในรูป", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/guard_block/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc, {
    session: sessionPayload({ source: "guard_block", inboundSource: { available: true, kind: "image", text: "ต้องไม่ขึ้น" } }),
  });
  await createTeachPage(deps)({ source: "guard_block", ref: "c1" });
  const text = textOf(doc.body);
  assert.match(text, /ข้อความต้นทางที่เชื่อมไว้\/ข้อความล่าสุดในชุด: รูปภาพ/u);
  assert.match(text, /เปิดบทสนทนาทั้งห้อง/u);
  assert.doesNotMatch(text, /ต้องไม่ขึ้น/u);
});

test("จอสอน: บัญชีที่เผยแพร่เองไม่ได้ เห็นปุ่มว่า 'ส่งให้พี่ง้วงอนุมัติ'", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc);
  deps.state.me.capabilities = ["corrections.review"];
  await createTeachPage(deps)({ source: "correction", ref: "c1" });
  assert.equal(doc.querySelector(".tc-send").textContent, "ส่งให้พี่ง้วงอนุมัติ");
});

test("จอสอน: เรื่องสีแดงต้องบอกคำที่ทำให้ยกระดับ และคำเตือนให้แยกใบ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc, {
    session: sessionPayload({
      proposal: {
        kind: "price", risk: "red", riskLabel: "แดง", blocked: false, blockReason: "",
        writable: true, notWritableWhy: "", flags: ["money"],
        escalatedBy: [{ flag: "money", word: "ส่วนลด" }],
        chipKind: "fact", splitHint: "ชิปที่เลือกบอกว่าเป็น \"ข้อเท็จจริง\" แต่ข้อความมีเนื้อของ \"ราคา\" ด้วย — แยกเป็นสองใบจะปลอดภัยกว่า",
      },
    }),
  });
  await createTeachPage(deps)({ source: "correction", ref: "c1" });

  const text = textOf(doc.body);
  assert.match(text, /คำว่า “ส่วนลด” ทำให้เรื่องนี้ต้องให้พี่ง้วงอนุมัติ/u);
  assert.match(text, /แยกเป็นสองใบจะปลอดภัยกว่า/u);
  assert.ok(doc.querySelector(".tc-risk-red"), "ต้องมีบรรทัดสีแดงให้เห็นด้วยตา");
});

test("จอสอน: ข้อความที่มีข้อมูลส่วนบุคคล ปุ่มส่งต้องกดไม่ได้ พร้อมบอกเหตุผล", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc, {
    session: sessionPayload({
      proposal: {
        kind: "fact", risk: "red", riskLabel: "แดง", blocked: true,
        blockReason: "ข้อความนี้มีข้อมูลที่อาจระบุตัวบุคคล — ลบส่วนนั้นออกก่อนค่ะ",
        writable: false, notWritableWhy: "", flags: ["personal_or_financial_data"],
        escalatedBy: [], chipKind: null, splitHint: "",
      },
    }),
  });
  await createTeachPage(deps)({ source: "correction", ref: "c1" });

  const send = doc.querySelector(".tc-send");
  assert.equal(send.disabled, true);
  assert.equal(send.textContent, "ยังส่งไม่ได้");
  assert.match(textOf(doc.body), /ข้อมูลที่อาจระบุตัวบุคคล/u);
});

test("จอสอน: เปิดเรื่องที่ไม่มีอยู่แล้ว ต้องบอกตรง ๆ ไม่ใช่หน้าเปล่า", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/zz" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc);
  deps.api = async () => { throw new Error("ไม่พบคำแก้นี้ (อาจถูกตัดสินหรือถูกลบไปแล้ว)"); };
  await createTeachPage(deps)({ source: "correction", ref: "zz" });
  assert.match(textOf(doc.body), /ไม่พบคำแก้นี้/u);
  assert.match(textOf(doc.body), /กลับกล่องตรวจ/u);
});

/* ------------------------- Step 0 "ทำไมตอบแบบนี้" ------------------------- */

// setTimeout ใน DOM จำลองถูก unref ไว้ (ไม่งั้น process ของเทสต์ไม่จบ) จึงรอด้วย
// microtask ล้วน — ตัว handler ของแผงเป็น async ที่ await เส้น api ซึ่ง resolve ทันที
async function flush() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function openWhy(doc, why) {
  const { whyPanel } = await import("../public/console/whyPanel.mjs");
  const { deps } = makeDeps(doc, { why });
  const panel = whyPanel({ api: deps.api, message: { id: "m2" } });
  doc.body.replaceChildren(panel);
  panel.open = true;
  panel.dispatch("toggle");
  await flush();
  return panel;
}

test("Step 0: เทิร์นที่ไม่ได้ใช้สมอง ต้องเขียนว่าอ่านจากตารางเดิม ไม่ใช่เลขรุ่น", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const panel = await openWhy(doc, {
    messageId: "m2", at: NOW,
    route: { answeredBy: "AI", operator: "", agentMode: "ai", messageClass: "reactive" },
    unknown: ["ระบบไม่รู้ว่าโมเดลหยิบการ์ดใบไหนไปใช้"],
    brain: {
      known: false, label: "อ่านจากตารางเดิม",
      why: "ตอนนี้ระบบยังอ่านคลังความรู้และตารางราคาโดยตรง ยังไม่ได้อ่านจากรุ่นสมอง",
      sources: [],
    },
  });
  const text = textOf(panel);
  assert.match(text, /อ่านจากตารางเดิม/u);
  assert.doesNotMatch(text, /รุ่นสมอง \d/u, "ห้ามเติมเลขรุ่นให้เทิร์นที่ไม่มี");
  assert.ok(panel.querySelector(".why-legacy"), "ต้องอ่านออกว่าเป็นสถานะ ไม่ใช่ error");
});

test("Step 0: เทิร์นที่ใช้สมองจริง ต้องบอกรุ่นและแหล่งที่ป้อนคำตอบ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const panel = await openWhy(doc, {
    messageId: "m2", at: NOW,
    route: { answeredBy: "AI", operator: "", agentMode: "ai", messageClass: "reactive" },
    unknown: ["ระบบไม่รู้ว่าโมเดลหยิบการ์ดใบไหนไปใช้"],
    brain: {
      known: true, label: "รุ่นสมอง 14", versionId: "v14", seq: 14, versionLabel: "แก้ที่จอดรถ",
      why: "เทิร์นนี้ถูกตอบด้วยรุ่นสมองใบนี้",
      sources: [{ kind: "fact", count: 21 }, { kind: "price", count: 11 }],
    },
  });
  const text = textOf(panel);
  assert.match(text, /รุ่นสมอง 14/u);
  assert.match(text, /ความรู้ 21 · ราคา 11/u, "ต้องบอกแหล่งที่ป้อนคำตอบเป็นภาษาคน");
  assert.match(text, /ไม่รู้ว่าโมเดลหยิบการ์ดใบไหน/u, "ต้องคงคำสารภาพไว้แม้จะรู้รุ่นแล้ว");
  assert.equal(panel.querySelector(".why-teach").getAttribute("href"), "#/teach/message/m2");
});

test("Step 0: ยังไม่กาง = ยังไม่ยิงเส้น (ห้องหนึ่งมีหลายสิบฟอง)", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { whyPanel } = await import("../public/console/whyPanel.mjs");
  const { deps, calls } = makeDeps(doc);
  const panel = whyPanel({ api: deps.api, message: { id: "m2" } });
  doc.body.replaceChildren(panel);
  panel.dispatch("toggle"); // ปิดอยู่
  await flush();
  assert.equal(calls.length, 0, "ยังไม่กางต้องไม่ยิงเส้นเลย");
});

/* --------------------------------- มือถือ 375 px --------------------------------- */

// เรนเดอร์ที่ความกว้าง 375 แล้วไล่ทุก element หา "สิ่งที่บังคับความกว้างคงที่"
// DOM จำลองไม่มี layout engine จริง จึงตรวจสิ่งที่ตรวจได้จริง: ไม่มี inline width/min-width
// ที่เกิน 375, ไม่มี white-space: nowrap บนข้อความที่คนพิมพ์เอง, และไม่มีตาราง
function fixedWidthOffenders(node, out = []) {
  for (const child of node.children || []) {
    if (child?.nodeType !== 1) continue;
    const style = String(child.getAttribute?.("style") || "");
    const width = /(?:^|;)\s*(?:min-)?width:\s*(\d+)px/u.exec(style);
    if (width && Number(width[1]) > 375) out.push(`${child.tagName} ${style}`);
    if (child.tagName === "table") out.push("table");
    fixedWidthOffenders(child, out);
  }
  return out;
}

test("มือถือ 375 px: กล่องตรวจและจอสอนไม่มีอะไรบังคับให้จอเลื่อนซ้ายขวา", async (t) => {
  const { doc, window } = installBrowserGlobals(t, { hash: "#/review" });
  window.innerWidth = 375;
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc);

  await createReviewPage(deps)();
  assert.deepEqual(fixedWidthOffenders(doc.body), [], "กล่องตรวจต้องไม่มีความกว้างคงที่");

  await createTeachPage(deps)({ source: "correction", ref: "c1" });
  assert.deepEqual(fixedWidthOffenders(doc.body), [], "จอสอนต้องไม่มีความกว้างคงที่");
});

test("มือถือ 375 px: CSS ของสองจอนี้ไม่มีความกว้างคงที่ และข้อความที่คนพิมพ์ตัดบรรทัดเสมอ", async () => {
  const css = readFileSync(fileURLToPath(new URL("../public/console/console.css", import.meta.url)), "utf8");
  const section = css.slice(css.indexOf("เฟส 3: กล่องตรวจ"));
  assert.ok(section.length > 500, "ต้องเจอบล็อก CSS ของเฟส 3");

  // ความกว้างคงที่เกินจอ 375 = จอเลื่อนซ้ายขวาทันที
  for (const match of section.matchAll(/(?:^|\s)(?:min-)?width:\s*(\d+)px/gu)) {
    assert.ok(Number(match[1]) <= 375, `มีความกว้างคงที่ ${match[1]}px ในบล็อกเฟส 3`);
  }
  // ทุกคลาสที่แสดง "ข้อความที่คนพิมพ์เอง" ต้องตัดบรรทัด ไม่งั้นคำแก้ยาว ๆ ดันจอ
  for (const cls of [".ri-title", ".ri-before, .ri-after", ".ri-blocked", ".tc-draft",
    ".tc-risk", ".tc-blocked", ".tc-pick-title", ".tc-pick-hint", ".why-line, .why-sub"]) {
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const rule = new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "u").exec(section);
    assert.ok(rule, `ไม่พบกฎ CSS ของ ${cls}`);
    assert.match(rule[0], /overflow-wrap:\s*anywhere/u, `${cls} ต้องตัดบรรทัดได้`);
  }
  // ปุ่มบนจอแคบต้องกดโดนด้วยนิ้วโป้ง
  assert.match(section, /@media \(max-width: 400px\)/u, "ต้องมีกฎสำหรับจอแคบ");
});

/* ============ รอบตรวจที่สอง: จอสอนต้องไม่ทำให้ของหายโดยไม่ตั้งใจ ============ */

// ข้อ 5: เลือกการ์ดแล้ว "แก้ใบนี้" เดิมทับข้อความทั้งใบด้วยคำแก้สั้น ๆ โดยไม่มีใครเห็นก่อน
test("เลือกการ์ดแล้ว ต้องยกข้อความเดิมมาให้แก้ พร้อมบอกว่าจะแทนที่กี่ตัวอักษร", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc);
  await createTeachPage(deps)({ source: "correction", ref: "c1" });

  doc.querySelectorAll(".tc-pick")[1].dispatch("click");
  const box = doc.querySelector(".kn-content").value;
  assert.match(box, /จอดฟรี 2 ชั่วโมงที่อาคาร B/u, "ต้องยกข้อความเดิมของการ์ดมาให้เห็น");
  assert.match(box, /จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ/u, "และต้องมีคำแก้ต่อท้ายให้เรียบเรียง");
  assert.equal(doc.querySelector(".tc-send").textContent, "แทนที่ข้อความทั้งใบ");
  assert.match(textOf(doc.body), /ข้อความเดิม 26 ตัวอักษรจะถูกแทนที่/u);
  assert.equal(doc.querySelector(".kn-title").value, "ที่จอดรถและการเดินทาง",
    "หัวข้อต้องถูกเติมจากการ์ดที่เลือก คนจะได้ไม่ต้องพิมพ์เอง");
});

test("กลับไปเลือกสร้างใบใหม่ ต้องคืนข้อความที่คนพิมพ์ไว้ ไม่ใช่ค้างข้อความของการ์ดเดิม", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc);
  await createTeachPage(deps)({ source: "correction", ref: "c1" });
  doc.querySelectorAll(".tc-pick")[1].dispatch("click");
  doc.querySelectorAll(".tc-pick")[0].dispatch("click");
  assert.equal(doc.querySelector(".kn-content").value, "จอดฟรี 4 ชั่วโมงที่อาคาร B ค่ะ");
  assert.equal(doc.querySelector(".tc-send").textContent, "เพิ่มเป็นความรู้ใหม่");
});

// ข้อ 6 (ฝั่งจอ): ผลค้นอ่อน ต้องไม่พูดว่า "ไม่มี"
test("ผลค้นอ่อน จอต้องบอกว่าระบบหาไม่เจอ ไม่ใช่ยืนยันว่าไม่มีการ์ดที่เกี่ยว", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps } = makeDeps(doc, { session: sessionPayload({ related: [], searchIsWeak: true }) });
  await createTeachPage(deps)({ source: "correction", ref: "c1" });
  const text = textOf(doc.body);
  assert.match(text, /ระบบหาไม่เจอ ไม่ได้แปลว่าไม่มี/u);
  assert.doesNotMatch(text, /ไม่พบการ์ดที่พูดเรื่องเดียวกัน/u);
});

// ข้อ 7: ราคาต้องแก้ของเดิมได้ ไม่ใช่เพิ่มได้อย่างเดียว
test("เรื่องราคา: ต้องเลือกได้ว่าจะแก้ยอดของรายการเดิม แล้วยิงไปเส้นแก้ราคา", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps, calls } = makeDeps(doc, {
    session: sessionPayload({
      proposal: {
        kind: "price", risk: "red", riskLabel: "แดง", blocked: false, blockReason: "",
        writable: true, notWritableWhy: "", flags: ["money"], escalatedBy: [], chipKind: null, splitHint: "",
      },
    }),
  });
  await createTeachPage(deps)({ source: "correction", ref: "c1" });

  const picker = doc.querySelector(".tc-price-pick");
  assert.ok(picker, "ต้องมีตัวเลือกรายการราคา");
  picker.value = "AI Agent for Business";
  picker.dispatch("change");
  doc.querySelector(".tc-amount").value = "21900";
  doc.querySelector(".tc-send").dispatch("click");
  await flush();
  const write = calls.find((call) => call.options?.method === "POST" && call.path.startsWith("/console/api/prices"));
  assert.ok(write, `ต้องยิงเส้นราคา — ${JSON.stringify(calls.map((c) => c.path))}`);
  assert.equal(write.path, `/console/api/prices/${encodeURIComponent("AI Agent for Business")}`,
    "แก้ของเดิมต้องไปเส้นแก้ ไม่ใช่เส้นเพิ่ม");
  assert.equal(write.options.body.amount, 21900);
});

test("เรื่องราคา: ชื่อใหม่ที่ซ้ำกับของเดิมแบบต่างแค่ช่องว่าง ต้องถูกกันตั้งแต่บนจอ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const toasts = [];
  const { deps, calls } = makeDeps(doc, {
    session: sessionPayload({
      proposal: {
        kind: "price", risk: "red", riskLabel: "แดง", blocked: false, blockReason: "",
        writable: true, notWritableWhy: "", flags: ["money"], escalatedBy: [], chipKind: null, splitHint: "",
      },
    }),
  });
  deps.toast = (message) => toasts.push(message);
  await createTeachPage(deps)({ source: "correction", ref: "c1" });
  doc.querySelector(".kn-title").value = "ai agent  for business";
  doc.querySelector(".tc-amount").value = "21900";
  doc.querySelector(".tc-send").dispatch("click");
  await flush();
  assert.ok(toasts.some((message) => /มีรายการนี้อยู่แล้ว/u.test(message)), `${JSON.stringify(toasts)}`);
  assert.equal(calls.filter((call) => call.options?.method === "POST" && call.path.startsWith("/console/api/prices")).length, 0);
});

// ข้อ 8: กดส่งทันทีหลังพิมพ์ = ส่งภายใต้การจัดชนิดของรอบก่อน
test("กดส่งทันทีหลังพิมพ์ ต้องรอผลจัดชนิดรอบใหม่ก่อนเสมอ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps, calls } = makeDeps(doc);
  // แผนรอบใหม่บอกว่าเป็นเรื่องเงิน (แดง) — ของที่ส่งต้องเดินตามแผนใหม่ ไม่ใช่แผนเก่าที่เขียว
  deps.api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/console/api/teach/session")) return sessionPayload();
    if (path.startsWith("/console/api/teach/plan")) {
      return {
        ok: true, searchIsWeak: false, related: [],
        proposal: {
          kind: "price", risk: "red", riskLabel: "แดง", blocked: false, blockReason: "",
          writable: true, notWritableWhy: "", flags: ["money"], escalatedBy: [], chipKind: null, splitHint: "",
        },
      };
    }
    return { ok: true };
  };
  await createTeachPage(deps)({ source: "correction", ref: "c1" });
  doc.querySelector(".kn-title").value = "ส่วนลดศิษย์เก่า";
  const content = doc.querySelector(".kn-content");
  content.value = "ลดเหลือ 15,900 บาทค่ะ";
  content.dispatch("input");
  doc.querySelector(".tc-send").dispatch("click");
  await flush();
  const wrote = calls.find((call) => call.options?.method === "POST" && !call.path.includes("/teach/plan"));
  assert.equal(wrote, undefined,
    "แผนใหม่บอกว่าเป็นราคา = ต้องหยุดถามก่อน ไม่ใช่ส่งเป็นความรู้เขียวตามแผนเก่า");
});

// ข้อ 9: ปุ่มถูกเปิดใหม่ระหว่างที่คำขอยังค้างอยู่ = กดสองทีได้การ์ดสองใบ
test("ระหว่างกำลังส่ง ปุ่มต้องกดซ้ำไม่ได้ และคำขอต้องพกกุญแจกันส่งซ้ำไปด้วย", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/teach/correction/c1" });
  const { createTeachPage } = await import("../public/console/teach.mjs");
  const { deps, calls } = makeDeps(doc);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const base = deps.api;
  deps.api = async (path, options = {}) => {
    if (path === "/console/api/knowledge" && options?.method === "POST") {
      calls.push({ path, options });
      await held;
      return { ok: true };
    }
    return base(path, options);
  };
  await createTeachPage(deps)({ source: "correction", ref: "c1" });
  doc.querySelector(".kn-title").value = "ที่จอดรถ (แก้แล้ว)";
  const send = doc.querySelector(".tc-send");
  send.dispatch("click");
  await flush();
  assert.equal(send.disabled, true, "ระหว่างส่งต้องกดซ้ำไม่ได้");
  send.dispatch("click");
  await flush();
  const writes = calls.filter((call) => call.path === "/console/api/knowledge" && call.options?.method === "POST");
  assert.equal(writes.length, 1, "กดสองทีต้องยิงครั้งเดียว");
  assert.ok(writes[0].options.body.teachKey, "ต้องพกกุญแจกันส่งซ้ำไปให้เซิร์ฟเวอร์ด้วย");
  release();
});

/* ============ รอบตรวจที่สอง: กล่องตรวจบนมือถือ ============ */

// ข้อ 16: ownerOnly ถูกส่งมาแต่ไม่เคยถูกวาด และคำเตือนเรื่องคิวหายเมื่อกดชิปกรอง
test("กล่องตรวจ: แถวของเจ้าของต้องบอกว่าใครกดได้ และคำเตือนคิวต้องอยู่ข้ามการกรอง", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { deps } = makeDeps(doc, {
    review: { ...reviewPayload(), canPublish: { knowledge: false, prices: false }, queueInstead: true },
  });
  await createReviewPage(deps)();
  assert.match(textOf(doc.body), /ของคุณจะเข้าคิว/u, "แถวสีแดงต้องบอกว่าเจ้าของเท่านั้นที่กดใช้ได้");

  // กดชิปกรอง แล้วคำเตือนต้องยังอยู่ (เดิมหายเพราะสถานะจากเซิร์ฟเวอร์ไม่ถูกเก็บไว้)
  doc.querySelectorAll(".ri-filters .fchip")[2].dispatch("click");
  await flush();
  assert.match(textOf(doc.body), /คำขอให้พี่ง้วงกดอนุมัติ/u, "คำเตือนเรื่องคิวต้องไม่หายเมื่อกรอง");
});

// ข้อ 12 (ฝั่งจอ)
test("กล่องตรวจ: ต้องบอกว่าแสดงกี่จากทั้งหมด และมีปุ่มดูเพิ่มเมื่อยังมีต่อ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { deps } = makeDeps(doc, {
    review: { ...reviewPayload(), total: 138, hasMore: true, cursor: 60 },
  });
  await createReviewPage(deps)();
  assert.match(textOf(doc.body), /แสดง 3 จาก 138/u);
  assert.ok(doc.querySelector(".ri-more"), "ต้องมีปุ่มดูเพิ่ม");
});

// ข้อ 11 (ฝั่งจอ)
test("กล่องตรวจ: แถวที่ส่งเข้าคิวแล้ว ต้องบอกสถานะและไม่มีปุ่มสอน", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const rows = defaultRows();
  rows[0] = {
    ...rows[0], pendingNote: "ส่งให้พี่ง้วงแล้ว รออนุมัติ",
    actions: { teach: false, dismiss: false, openChat: true },
  };
  const { deps } = makeDeps(doc, { review: reviewPayload(rows) });
  await createReviewPage(deps)();
  const card = doc.querySelectorAll(".ri-card")[0];
  assert.match(textOf(card), /ส่งให้พี่ง้วงแล้ว รออนุมัติ/u);
  assert.equal(card.querySelectorAll(".ri-teach").length, 0);
});

// "ไม่ต้องสอน" ต้องไม่ใช่ window.prompt — บนมือถือมันคือกล่องที่ปัดทิ้งง่ายที่สุด
test("กล่องตรวจ: ไม่ต้องสอน ใช้ช่องกรอกในหน้า ไม่ใช่กล่อง prompt ของเบราว์เซอร์", async (t) => {
  const { doc, window } = installBrowserGlobals(t, { hash: "#/review" });
  let prompted = 0;
  window.prompt = () => { prompted += 1; return "เหตุผล"; };
  const { createReviewPage } = await import("../public/console/review.mjs");
  const { deps, calls } = makeDeps(doc);
  await createReviewPage(deps)();

  doc.querySelectorAll(".ri-card")[0].querySelector(".ri-dismiss").dispatch("click");
  assert.equal(prompted, 0, "ห้ามใช้ window.prompt");
  const form = doc.querySelector(".ri-dismiss-form");
  assert.ok(form, "ต้องมีช่องกรอกเหตุผลในหน้า");
  const reason = form.querySelector(".ri-dismiss-reason");
  reason.value = "เป็นเคสเฉพาะราย";
  form.querySelector(".ri-dismiss-confirm").dispatch("click");
  await flush();
  const write = calls.find((call) => call.path.includes("/corrections/") && call.options?.method === "POST");
  assert.ok(write, `ต้องยิงเส้นตัดสินคำแก้ — ${JSON.stringify(calls.map((c) => c.path))}`);
  assert.equal(write.options.body.reason, "เป็นเคสเฉพาะราย");
  assert.equal(write.options.body.action, "reject");
});

test("กล่องตรวจ: ไม่ใส่เหตุผลแล้วกดยืนยัน ต้องไม่ส่ง และบอกว่าต้องใส่เหตุผล", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const toasts = [];
  const { deps, calls } = makeDeps(doc);
  deps.toast = (message) => toasts.push(message);
  await createReviewPage(deps)();
  doc.querySelectorAll(".ri-card")[0].querySelector(".ri-dismiss").dispatch("click");
  doc.querySelector(".ri-dismiss-confirm").dispatch("click");
  await flush();
  assert.equal(calls.filter((call) => call.path.includes("/corrections/")).length, 0);
  assert.ok(toasts.some((message) => /เหตุผล/u.test(message)), JSON.stringify(toasts));
});
