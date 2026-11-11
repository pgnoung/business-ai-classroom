// broadcast-studio-ui.test.mjs — หน้าสตูดิโอบรอดแคสต์เรนเดอร์จริงด้วย DOM จำลอง (28 ก.ย. 2026)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installBrowserGlobals } from "./console-dom.mjs";

const text = (node) => JSON.stringify(node, (key, value) => (key === "parent" ? undefined : value));

function studioMeta(overrides = {}) {
  return {
    ok: true, channelId: "default", channels: [{ id: "default", name: "OA หลัก" }],
    tagGroups: [
      { dimension: "สนใจ", label: "สนใจ", wildcard: "สนใจ:*", total: 7, tags: [
        { tag: "สนใจ: AI Agent for Business", value: "AI Agent for Business", count: 5 },
        { tag: "สนใจ: Excel", value: "Excel", count: 2 },
      ] },
      { dimension: "", label: "ป้ายอื่น ๆ", wildcard: "", total: 3, tags: [{ tag: "customer", value: "customer", count: 3, purchased: true }] },
    ],
    presets: [{ key: "not_purchased", label: "ยังไม่ซื้อ", hint: "", exclude: ["customer", "ซื้อครั้งที่:*"] }],
    reachableKnown: 12,
    images: [{ key: "hero", label: "รูปคลาส", previewSrc: "/media/x.jpg", uploaded: false, https: true }],
    stickers: [{ packageId: "11537", stickerId: "52002734", label: "ยินดีด้วยค่ะ", symbol: "🎉" }],
    mediaUpload: { enabled: false }, limits: { maxBubbles: 5, textMax: 1000, cardMax: 10, cardButtonMax: 3 },
    canSend: true, canTestSend: true, scheduling: { enabled: false, reason: "ยังไม่เปิดตั้งเวลา" },
    tracking: { enabled: true }, lineSide: { available: true }, quota: { type: "limited", limit: 1000, used: 100, remaining: 900 },
    followers: { date: "20260927", followers: 900, blocks: 100, targetedReaches: 600, reach: 800 },
    demographic: { options: { age: ["age_20", "age_30"], area: ["th_01"], subscriptionPeriod: ["day_7"] }, areaLabels: { th_01: "กรุงเทพฯ" } },
    ...overrides,
  };
}

function makeDeps(doc, { meta = studioMeta(), campaigns = [] } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/console/api/broadcast/studio/meta")) return meta;
    if (path.startsWith("/console/api/broadcast/studio/estimate")) return { ok: true, estimate: 5, estimateKind: "exact", quota: meta.quota };
    if (path.startsWith("/console/api/broadcast/studio/campaigns")) return { ok: true, campaigns };
    if (path.startsWith("/console/api/broadcast/studio/audiences")) return { ok: true, available: true, groups: [] };
    if (path.startsWith("/console/api/broadcast/steps")) return { ok: true, sequences: [], mode: "on", canEdit: true };
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("สตูดิโอ: แท็บสร้างข้อความมีโหมดผู้รับครบ 4 · ป้ายจัดตามมิติ · ตัวอย่างจอ LINE · ปุ่มส่งปิดจนพร้อม", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/broadcast" });
  const { createBroadcastPage } = await import("../public/console/broadcast.mjs");
  const { deps } = makeDeps(doc);
  await createBroadcastPage(deps)();
  const body = text(doc.body);
  for (const label of ["เพื่อนทุกคน", "ตามป้ายของเรา", "กลุ่มเป้าหมาย LINE", "ข้อมูลประชากร", "ส่งทั้งมิติ", "ยังไม่ซื้อ", "ตัวอย่างจะขึ้นตรงนี้"]) {
    assert.match(body, new RegExp(label, "u"), label);
  }
  assert.equal(doc.querySelectorAll(".bs-mode").length, 4);
  assert.equal(doc.querySelector(".bs-send").disabled, true, "ยังไม่มีข้อความ/ผู้รับ = ส่งไม่ได้");
  assert.ok(doc.querySelector(".bs-tab.is-active"), "แท็บที่อยู่ถูกไฮไลต์");
  assert.doesNotMatch(body, /"null"|>null</u, "ห้ามมีข้อความ null หลุดขึ้นจอ");
});

test("สตูดิโอ: ช่องส่งฝั่ง LINE ไม่พร้อม (โหมดนำร่อง) = ปิดโหมดเพื่อนทุกคน/กลุ่มเป้าหมาย/ประชากร เหลือตามป้าย", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/broadcast" });
  const { createBroadcastPage } = await import("../public/console/broadcast.mjs");
  const { deps } = makeDeps(doc, { meta: studioMeta({ lineSide: { available: false, reason: "pilot_mode" } }) });
  await createBroadcastPage(deps)();
  const modes = doc.querySelectorAll(".bs-mode");
  assert.deepEqual(modes.map((node) => node.attributes.disabled === "true"), [true, false, true, true]);
});

test("สตูดิโอ: แท็บผลลัพธ์แสดงแคมเปญพร้อมผู้รับ/คลิก/สถิติ LINE · ตัวเลขที่ LINE ปิด (<20) ไม่แสดงเป็น 0", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/broadcast/results" });
  const { createBroadcastPage } = await import("../public/console/broadcast.mjs");
  const { deps } = makeDeps(doc, { campaigns: [
    {
      id: "c1", broadcastNo: 7, mode: "all", modeLabel: "เพื่อนทุกคน", status: "done", createdAt: Date.now(), createdBy: "owner",
      messages: [{ type: "text", text: "ประกาศรอบใหม่" }], includeTags: [], excludeTags: [], target: {}, estimate: 800,
      audienceCount: 800, sentCount: 0, clicks: 12, linkCount: 1, line: { phase: "accepted" },
      insight: { overview: { delivered: 790, uniqueImpression: null, uniqueClick: 25 } },
    },
    {
      id: "c2", broadcastNo: 6, mode: "tags", modeLabel: "ตามป้ายของเรา", status: "sending", createdAt: Date.now(), createdBy: "owner",
      messages: [{ type: "card", cards: [{ title: "การ์ดใหม่" }] }], includeTags: ["สนใจ:*"], excludeTags: ["customer"], target: {},
      audienceCount: 10, sentCount: 3, clicks: 0, linkCount: 0, line: {}, insight: null,
    },
  ] });
  await createBroadcastPage(deps)();
  const body = text(doc.body);
  assert.match(body, /ประกาศรอบใหม่/u);
  assert.match(body, /790 คน/u, "โหมดเพื่อนทุกคนใช้ยอดส่งถึงจาก LINE");
  assert.match(body, /น้อยกว่า 20/u, "null ของ LINE = น้อยกว่า 20");
  assert.match(body, /\[การ์ด\] การ์ดใหม่/u);
  assert.match(body, /สนใจ: ทุกค่า/u);
  assert.match(body, /หยุดส่ง/u, "งานที่กำลังส่งมีปุ่มหยุด");
});

test("ตัวเขียน: บับเบิลพร้อมส่ง/ทรงที่ส่งเซิร์ฟเวอร์/แปลงประวัติกลับเป็นแม่แบบ", async () => {
  const { bubbleIsReady, serializeBubbles, bubblesFromStored, newBubble } = await import("../public/console/broadcastComposer.mjs");
  assert.equal(bubbleIsReady(newBubble("text")), false);
  assert.equal(bubbleIsReady({ type: "card", cards: [{ title: "x", buttons: [{ label: "ไป", kind: "uri", uri: "http://x" }] }] }), false, "ปุ่มต้อง https");
  const bubbles = [
    { type: "text", text: "  สวัสดี  " },
    { type: "sticker", packageId: "11537", stickerId: "52002734" },
    { type: "card", altText: "", cards: [{ imageKey: "", title: " หัวข้อ ", text: "", buttons: [{ label: "ตอบ", kind: "message", text: "สนใจ" }] }] },
    { type: "image", key: "" },
  ];
  assert.deepEqual(serializeBubbles(bubbles), [
    { type: "text", text: "สวัสดี" },
    { type: "sticker", packageId: "11537", stickerId: "52002734" },
    { type: "card", altText: "", cards: [{ imageKey: "", title: "หัวข้อ", text: "", buttons: [{ label: "ตอบ", kind: "message", text: "สนใจ" }] }] },
  ]);
  const round = bubblesFromStored(serializeBubbles(bubbles));
  assert.equal(round.length, 3);
  assert.equal(round[2].cards[0].buttons[0].kind, "message");
});

test("payload ของสตูดิโอส่งเฉพาะช่องของโหมดที่เลือก", async () => {
  const { createStudioStore, studioPayload } = await import("../public/console/broadcastCreate.mjs");
  const store = createStudioStore();
  const state = store.get("default");
  state.bubbles.splice(0, 1, { type: "text", text: "ข้อความ" });
  store.segments.toggle("default", "include", "สนใจ:*");
  assert.deepEqual(studioPayload(state, store.segments, "default"), {
    channelId: "default", mode: "tags", messages: [{ type: "text", text: "ข้อความ" }],
    notificationDisabled: false, trackClicks: true, includeTags: ["สนใจ:*"], excludeTags: [],
  });
  state.mode = "audience";
  state.audience.include.add(101);
  assert.deepEqual(studioPayload(state, store.segments, "default").target, { include: [101], exclude: [] });
  const applied = store.applyTemplate("default", { mode: "demographic", target: { gender: ["female"], age: { gte: "age_20" } }, bubbles: [] });
  assert.equal(applied.mode, "demographic");
  assert.deepEqual([...applied.demographic.gender], ["female"]);
  assert.equal(applied.bubbles.length, 1, "แม่แบบว่าง = เริ่มบับเบิลข้อความเปล่า");
});

test("ไฟล์ใหม่ของสตูดิโอ: ไม่มี innerHTML/inline style attribute · replaceChildren ผ่านตัวกรอง null", () => {
  for (const file of ["broadcast.mjs", "broadcastCreate.mjs", "broadcastAudience.mjs", "broadcastComposer.mjs", "broadcastResults.mjs", "broadcastBlocks.mjs"]) {
    const source = readFileSync(new URL(`../public/console/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|setAttribute\(\s*["']style|style\s*:\s*["'`]/u, `${file} ห้าม HTML ดิบ/inline style`);
    assert.doesNotMatch(source, /\.replaceChildren\(/u, `${file} ต้องใช้ put() (replaceChildren แปลง null เป็นข้อความ)`);
  }
  const css = readFileSync(new URL("../public/console/studio.css", import.meta.url), "utf8");
  assert.match(css, /\.bs-page \[hidden\] \{ display: none !important; \}/u);
  assert.match(css, /prefers-reduced-motion/u);
});
