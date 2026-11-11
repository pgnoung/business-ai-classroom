// step-messages-ui.test.mjs — แท็บ "ข้อความตามขั้น" เรนเดอร์จริงด้วย DOM จำลอง (28 ก.ย. 2026)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installBrowserGlobals } from "./console-dom.mjs";

const text = (node) => JSON.stringify(node, (key, value) => (key === "parent" ? undefined : value));
// setTimeout ของ DOM จำลองถูก unref — ใช้ setImmediate ให้ event loop รอ microtask ของการบันทึกจนจบ
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const META = {
  ok: true, channelId: "default", channels: [{ id: "default", name: "OA หลัก" }],
  tagGroups: [
    { dimension: "ของแจก", label: "ของแจก", wildcard: "ของแจก:*", total: 4, tags: [{ tag: "ของแจก: E-book", value: "E-book", count: 4 }] },
    { dimension: "", label: "ป้ายอื่น ๆ", wildcard: "", total: 2, tags: [{ tag: "VIP", value: "VIP", count: 2 }] },
  ],
  presets: [], reachableKnown: 10, images: [], stickers: [], mediaUpload: { enabled: false },
  limits: { maxBubbles: 5, textMax: 1000, cardMax: 10, cardButtonMax: 3 },
  canSend: true, canTestSend: false, scheduling: { enabled: false }, tracking: { enabled: true }, lineSide: { available: true },
  quota: { type: "limited", limit: 1000, used: 100, remaining: 900 }, followers: null, demographic: { options: {}, areaLabels: {} },
};

const STEP_TEXT = [{ type: "text", text: "ขอบคุณที่เพิ่มเพื่อนค่ะ" }];
const SEQUENCES = [
  {
    id: "seq-active", channelId: "default", name: "ต้อนรับเพื่อนใหม่", triggerType: "follow", triggerValue: "", triggerText: "เพิ่มเพื่อนใหม่",
    stopOnReply: false, status: "active", version: 1, activatedAt: Date.UTC(2026, 8, 20), pausedBy: "",
    steps: [
      { delay: { kind: "hours", hours: 1 }, condition: null, messages: STEP_TEXT },
      { delay: { kind: "days", days: 1, at: "10:00" }, condition: { hasTags: [], hasNotTags: ["customer"] }, messages: STEP_TEXT },
    ],
    totals: { active: 4, completed: 9, stopped: 3, baseline: 0 },
  },
  {
    id: "seq-guard", channelId: "default", name: "ติดตามคนสนใจ", triggerType: "tag", triggerValue: "ของแจก:*", triggerText: "ติดป้าย ของแจก: ทุกค่า",
    stopOnReply: true, status: "paused", version: 2, pausedBy: "system:guard",
    steps: [{ delay: { kind: "hours", hours: 2 }, condition: null, messages: STEP_TEXT }], totals: { active: 0, completed: 0, stopped: 1, baseline: 5 },
  },
  {
    id: "seq-draft", channelId: "default", name: "เตรียมตัวก่อนเรียน", triggerType: "order_paid", triggerValue: "", triggerText: "ออเดอร์ชำระแล้ว",
    stopOnReply: false, status: "draft", version: 1, pausedBy: "",
    steps: [{ delay: { kind: "hours", hours: 1 }, condition: null, messages: STEP_TEXT }], totals: { active: 0, completed: 0, stopped: 0, baseline: 0 },
  },
  {
    id: "seq-old", channelId: "default", name: "ลำดับเก่า", triggerType: "keyword", triggerValue: "เก่า", triggerText: "ลูกค้าพิมพ์ #เก่า",
    stopOnReply: false, status: "archived", version: 1, pausedBy: "",
    steps: [{ delay: { kind: "hours", hours: 1 }, condition: null, messages: STEP_TEXT }], totals: { active: 0, completed: 2, stopped: 0, baseline: 0 },
  },
];

function listData(overrides = {}) {
  return {
    ok: true, mode: "on", modeKey: "step_messages_mode", canEdit: true, canToggleMode: true, engineArmed: true,
    limits: { maxSteps: 10, maxActivePerChannel: 20, maxDelayDays: 30, maxDelayHours: 72, minDelayHours: 1, nameMax: 60, keywordMax: 40, conditionTagsMax: 5 },
    stopReasonLabels: { purchased: "ซื้อแล้ว", customer_replied: "ลูกค้าตอบกลับ", unfollowed: "บล็อก OA" },
    deferReasonLabels: {}, triggerLabels: {}, sequences: SEQUENCES, ...overrides,
  };
}

function makeDeps(doc, { data = listData() } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/console/api/broadcast/studio/meta")) return META;
    if (path.startsWith("/console/api/broadcast/steps?")) return data;
    if (path === "/console/api/broadcast/steps" && options.method === "POST") {
      return { ok: true, sequence: { ...SEQUENCES[2], id: "seq-new", name: options.body.name, status: "draft" } };
    }
    if (path.startsWith("/console/api/broadcast/steps/seq-active")) {
      return {
        ok: true,
        sequence: {
          ...SEQUENCES[0],
          stepStats: [
            { step: 1, entered: 16, waiting: 2, sent: 14, skipped: 0, failed: 0, stopped: 2, stoppedBy: { purchased: 2 }, replied: 5, clicked: 7 },
            { step: 2, entered: 9, waiting: 0, sent: 8, skipped: 1, failed: 0, stopped: 0, stoppedBy: {}, replied: 1, clicked: 0 },
          ],
        },
      };
    }
    return { ok: true };
  };
  return {
    calls,
    deps: {
      api, uploadMedia: async () => ({ ok: true }), toast: () => {},
      mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
      pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
      tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {}, channelName: () => "OA หลัก",
      state: { me: { username: "owner", role: "owner", capabilities: ["broadcast.send"] }, routeGen: 0, channels: [], features: { broadcast: true } },
    },
  };
}

test("เส้นทางย่อย: รายการ/สร้าง(+โครง)/ผลรายขั้น/แก้ · id แปลก ๆ ไม่ทำพัง", async () => {
  const { stepRoute } = await import("../public/console/stepMessages.mjs");
  assert.deepEqual(stepRoute("#/broadcast/steps"), { view: "list" });
  assert.deepEqual(stepRoute("#/broadcast/steps/new"), { view: "new", starter: "" });
  assert.deepEqual(stepRoute("#/broadcast/steps/new?starter=welcome"), { view: "new", starter: "welcome" });
  assert.deepEqual(stepRoute("#/broadcast/steps/seq-1"), { view: "detail", id: "seq-1" });
  assert.deepEqual(stepRoute("#/broadcast/steps/seq-1/edit"), { view: "edit", id: "seq-1" });
  assert.deepEqual(stepRoute("#/broadcast/steps/%E0%A4%A"), { view: "list" }, "decode ไม่ได้ = กลับรายการ");
  assert.deepEqual(stepRoute("#/broadcast"), { view: "list" });
});

test("ร่างลำดับ: โครงเริ่มต้นไม่มีข้อความสำเร็จรูป · ปัญหาที่ต้องแก้ก่อนบันทึก · ทรงที่ส่งเซิร์ฟเวอร์", async () => {
  const { newStepDraft, stepDraftProblems, stepDraftPayload, stepDraftFromSequence, delayLabel } = await import("../public/console/stepEditor.mjs");
  const welcome = newStepDraft("welcome");
  assert.equal(welcome.triggerType, "follow");
  assert.deepEqual(welcome.steps.map((step) => step.delay), [{ kind: "hours", hours: 1 }, { kind: "days", days: 1, at: "10:00" }, { kind: "days", days: 3, at: "19:00" }]);
  assert.ok(welcome.steps.every((step) => step.bubbles.length === 1 && step.bubbles[0].text === ""), "โครงไม่เติมข้อความให้ — ต้องเขียนเอง");
  assert.deepEqual(stepDraftProblems(welcome).slice(0, 2), ["ขั้นที่ 1: ยังไม่มีข้อความ", "ขั้นที่ 2: ยังไม่มีข้อความ"]);

  const draft = newStepDraft("giveaway");
  draft.triggerValue = "#ของแจก";
  draft.steps.forEach((step) => { step.bubbles[0].text = "  นี่ค่ะ  "; });
  draft.steps[1].delay = { kind: "days", days: 2, at: "22:00" };
  assert.deepEqual(stepDraftProblems(draft), ["ขั้นที่ 2: เวลาส่งต้องอยู่ช่วง 09:00–20:30"]);
  draft.steps[1].delay.at = "10:00";
  draft.steps[1].condition.hasTags.push("VIP");
  assert.deepEqual(stepDraftProblems(draft), []);
  const payload = stepDraftPayload(draft, "default");
  assert.equal(payload.triggerValue, "ของแจก", "ตัด # หน้าคีย์เวิร์ด");
  assert.deepEqual(payload.steps[0], { delay: { kind: "hours", hours: 1 }, condition: null, messages: [{ type: "text", text: "นี่ค่ะ" }] });
  assert.deepEqual(payload.steps[1].condition, { hasTags: ["VIP"], hasNotTags: [] });

  const tagDraft = { ...newStepDraft(), name: "x", triggerType: "tag", triggerValue: "" };
  tagDraft.steps[0].bubbles[0].text = "สวัสดี";
  assert.deepEqual(stepDraftProblems(tagDraft), ["เลือกป้ายที่เป็นจุดเริ่ม"]);
  const round = stepDraftFromSequence(SEQUENCES[0]);
  assert.equal(round.steps[1].condition.hasNotTags[0], "customer");
  assert.equal(round.steps[0].bubbles[0].text, "ขอบคุณที่เพิ่มเพื่อนค่ะ");
  assert.equal(delayLabel({ kind: "days", days: 2, at: "10:00" }, 1), "2 วันหลังขั้นก่อนหน้า · 10:00 น.");
  assert.equal(delayLabel({ kind: "hours", hours: 3 }, 0), "3 ชม. หลังเข้าลำดับ");
});

test("รายการ: สวิตช์รวม + การ์ดตามสถานะ · พักโดยระบบบอกเหตุ · ร่าง/พักเท่านั้นที่แก้/เปิดใช้ได้ · ลำดับที่ปิดแล้วพับไว้", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/broadcast/steps" });
  const { createBroadcastPage } = await import("../public/console/broadcast.mjs");
  const { deps } = makeDeps(doc);
  await createBroadcastPage(deps)();
  const body = text(doc.body);
  for (const label of ["สวิตช์รวมข้อความตามขั้น", "ทำงานอยู่ · 1 ลำดับเปิดใช้", "ปิดทั้งหมด", "+ สร้างลำดับใหม่", "เริ่มจากโครง",
    "ระบบพักไว้เอง", "ลำดับที่ปิดแล้ว (1)", "OA Manager"]) {
    assert.match(body, new RegExp(label.replace(/[+()]/gu, "\\$&"), "u"), label);
  }
  const cards = doc.querySelectorAll(".sm-seq-card");
  assert.equal(cards.length, 4);
  const editLinks = cards.map((card) => card.querySelectorAll("a").filter((a) => a.attributes.href?.endsWith("/edit")).length);
  assert.deepEqual(editLinks, [0, 1, 1, 0], "ทำงานอยู่/ปิดแล้ว = แก้ไม่ได้");
  assert.doesNotMatch(body, /"null"|>null</u);
});

test("รายการ: บัญชีที่ไม่มีสิทธิ์ส่ง = ดูได้อย่างเดียว · สวิตช์ปิด = บอกว่าหยุดทุกลำดับ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/broadcast/steps" });
  const { createBroadcastPage } = await import("../public/console/broadcast.mjs");
  const { deps } = makeDeps(doc, { data: listData({ canEdit: false, canToggleMode: false, mode: "off" }) });
  await createBroadcastPage(deps)();
  const body = text(doc.body);
  assert.match(body, /ปิดอยู่ — ทุกลำดับหยุดรับคนใหม่และหยุดส่ง/u);
  assert.doesNotMatch(body, /สร้างลำดับใหม่|เปิดใช้…|พักเพื่อแก้|ปิดทั้งหมด|เปิดสวิตช์รวม/u);
});

test("ผลรายขั้น: ตัวเลขต่อขั้น + เหตุที่หยุด (ป้ายภาษาคน) + ตัวอย่างข้อความของขั้นที่เลือก · ไม่มี id ลูกค้า", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/broadcast/steps/seq-active" });
  const { createBroadcastPage } = await import("../public/console/broadcast.mjs");
  const { deps } = makeDeps(doc);
  await createBroadcastPage(deps)();
  const rows = doc.querySelectorAll(".sm-stat-row");
  assert.equal(rows.length, 2);
  const first = text(rows[0]);
  assert.match(first, /"16"[\s\S]*เข้าขั้น/u);
  assert.match(first, /ซื้อแล้ว 2/u);
  assert.match(text(doc.body), /ขอบคุณที่เพิ่มเพื่อนค่ะ/u, "ตัวอย่างจอ LINE ของขั้นที่เลือก");
  assert.ok(doc.querySelector(".sm-stat-row.is-picked"));
  rows[1].querySelector(".sm-stat-step").dispatch("click");
  assert.ok(doc.querySelectorAll(".sm-stat-row")[1].classList.contains("is-picked"), "กดขั้นที่ 2 = เลือกขั้นที่ 2");
});

test("ตัวแก้: โครง #ของแจก → ช่องคีย์เวิร์ด + 2 ขั้น · ปุ่มบันทึกปิดจนข้อความครบ · บันทึกส่งทรงที่ถูก", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/broadcast/steps/new?starter=giveaway" });
  const { createBroadcastPage } = await import("../public/console/broadcast.mjs");
  const { deps, calls } = makeDeps(doc);
  await createBroadcastPage(deps)();
  assert.ok(doc.querySelector(".sm-editor"));
  assert.equal(doc.querySelectorAll(".sm-step").length, 2);
  const save = doc.querySelector(".sm-save");
  assert.equal(save.disabled, true, "ยังไม่มีข้อความ = บันทึกไม่ได้");
  assert.match(text(doc.querySelector(".sm-problems")), /ขั้นที่ 1: ยังไม่มีข้อความ/u);
  const keyword = doc.querySelectorAll("input").find((input) => input.attributes["aria-label"]?.startsWith("คีย์เวิร์ด"));
  assert.equal(keyword.value, "ของแจก");
  // เติมข้อความทั้งสองขั้นผ่านร่างที่แท็บถือไว้ (ช่องพิมพ์ของ composer ผูกกับอาร์เรย์เดียวกัน)
  const textarea = doc.querySelector(".bs-textarea");
  textarea.value = "นี่ค่ะ E-book";
  textarea.dispatch("input", { target: textarea });
  doc.querySelector(".sm-step-summary").dispatch("click");
  const second = doc.querySelector(".sm-step.is-active .bs-textarea");
  second.value = "ลองใช้แล้วเป็นยังไงบ้างคะ";
  second.dispatch("input", { target: second });
  assert.equal(doc.querySelector(".sm-save").disabled, false);
  doc.querySelector(".sm-save").dispatch("click");
  await flush();
  const saved = calls.find((call) => call.path === "/console/api/broadcast/steps" && call.options.method === "POST");
  assert.ok(saved, "บันทึกร่างใหม่ = POST /steps");
  assert.equal(saved.options.body.triggerType, "keyword");
  assert.equal(saved.options.body.triggerValue, "ของแจก");
  assert.deepEqual(saved.options.body.steps.map((step) => step.messages[0].text), ["นี่ค่ะ E-book", "ลองใช้แล้วเป็นยังไงบ้างคะ"]);
  assert.equal(location.hash, "#/broadcast/steps/seq-new", "บันทึกแล้วไปหน้าผลของลำดับนั้น (ยังไม่เปิดใช้)");
});

test("ไฟล์ใหม่ของข้อความตามขั้น: ไม่มี innerHTML/inline style · replaceChildren ผ่าน put() · CSS มีจอเล็กและลดการเคลื่อนไหว", () => {
  for (const file of ["stepMessages.mjs", "stepEditor.mjs", "stepActivation.mjs"]) {
    const source = readFileSync(new URL(`../public/console/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|setAttribute\(\s*["']style|style\s*:\s*["'`]/u, `${file} ห้าม HTML ดิบ/inline style`);
    assert.doesNotMatch(source, /\.replaceChildren\(/u, `${file} ต้องใช้ put()`);
  }
  const css = readFileSync(new URL("../public/console/steps.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 720px\)/u);
  assert.match(css, /prefers-reduced-motion/u);
  const html = readFileSync(new URL("../public/console/index.html", import.meta.url), "utf8");
  assert.match(html, /\/console\/static\/steps\.css/u);
});
