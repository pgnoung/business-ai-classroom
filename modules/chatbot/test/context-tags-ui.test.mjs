// context-tags-ui.test.mjs — แผงป้ายในห้องแชทจัดกลุ่มตามมิติ (กรอบป้ายชุดเดียว 28 ก.ย. 2026)
// เรนเดอร์จริงด้วย DOM จำลอง: จัดกลุ่ม · เลือกมิติ → ค่าในรายการ → ส่ง "มิติ: ค่า" · ป้ายอิสระยังพิมพ์ได้
// · สวิตช์ปิด = แผงแบบเดิม · ไม่มี null หลุดเป็นข้อความในแผง (replaceChildren ของเบราว์เซอร์แปลงเป็น "null")
import test from "node:test";
import assert from "node:assert/strict";
import { frameworkView, validateTagFramework } from "../src/tagFramework.mjs";
import {
  createTagsPanel, dimensionMeta, exampleFor, groupTagsByDimension, resetTagFrameworkCache, TAG_SUGGESTIONS,
} from "../public/console/contextTags.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { fixtureWithPurchase } from "./tagFrameworkFixture.mjs";

const view = frameworkView(validateTagFramework(fixtureWithPurchase()));
const ROOM_TAGS = [
  { tag: "สนใจ: AI Agent for Business", source: "ai" },
  { tag: "ขั้น: ถามราคา", source: "ai" },
  { tag: "ซื้อครั้งที่: 2", source: "rfm" },
  { tag: "ซื้อล่าสุด: Sep2026", source: "rfm" },
  { tag: "ของแจก: Make Cheat Sheet", source: "human" },
  { tag: "VIP", source: "human" },
  { tag: "ม.ค.2023", source: "human" },
];

test("tags panel helpers: groups follow the framework order and everything else lands in 'อื่น ๆ'", () => {
  const { groups, other } = groupTagsByDimension(ROOM_TAGS, view);
  assert.deepEqual(groups.map((g) => g.dim.key), ["สนใจ", "ขั้น", "ของแจก", "ซื้อครั้งที่", "ซื้อล่าสุด"]);
  assert.deepEqual(other.map((row) => row.tag), ["VIP", "ม.ค.2023"]);
  assert.deepEqual(groupTagsByDimension(ROOM_TAGS, null).other.length, ROOM_TAGS.length, "ไม่มีกรอบ = ไม่มีกลุ่ม");
  const dim = (key) => view.dimensions.find((d) => d.key === key);
  assert.equal(dimensionMeta(dim("สนใจ")), "AI ติด · สะสม ≤3 · ทีมแก้ได้");
  assert.equal(dimensionMeta(dim("ขั้น")), "AI ติด · เดินหน้าเท่านั้น · ทีมแก้ได้");
  assert.equal(dimensionMeta(dim("ซื้อครั้งที่")), "ระบบคำนวณ · ค่าล่าสุดเสมอ");
  assert.equal(dimensionMeta(dim("ติดต่อ")), "ทีมติด · เลือกจากรายการ");
  assert.equal(exampleFor({ key: "ของแจก", guide: "ทีมงานติดเอง เช่น ของแจก: Make Cheat Sheet (ระบบไม่เดา)" }), "เช่น Make Cheat Sheet");
  assert.equal(exampleFor({ key: "รุ่น", guide: "" }), "ค่าของ รุ่น");
  assert.equal(TAG_SUGGESTIONS[0], "customer", "customer ต้องขึ้นก่อนเสมอ (ป้ายที่ทำให้บอทเงียบ)");
});

function harness(framework) {
  const calls = [];
  const notices = [];
  let refreshed = 0;
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body || null });
    if (path === "/console/api/customers/tag-framework") return { ok: true, mode: framework ? "on" : "off", available: true, framework };
    return { ok: true };
  };
  const tagsPanel = createTagsPanel({ api, toast: (text) => notices.push(text) });
  return { calls, notices, tagsPanel, refresh: async () => { refreshed += 1; }, refreshed: () => refreshed };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const textOf = (node) => (node?.nodeType === 3 ? node.textContent : (node?.children || []).map(textOf).join(""));
const nonNodes = (node) => (node.children || []).filter((kid) => !kid || typeof kid !== "object" || !kid.nodeType)
  .concat((node.children || []).filter((kid) => kid?.nodeType === 1).flatMap(nonNodes));

test("tags panel: groups the room's tags by dimension and adds a closed value as 'มิติ: ค่า'", async (t) => {
  installBrowserGlobals(t);
  resetTagFrameworkCache();
  const h = harness(view);
  const first = h.tagsPanel("U-room", ROOM_TAGS, h.refresh);
  await settle();
  // แผงแรกวาดแบบเดิมระหว่างโหลดกรอบ แล้ววาดใหม่ในที่เดิมเมื่อได้ข้อมูล
  assert.deepEqual(first.querySelectorAll(".tag-group-name").map((n) => textOf(n)), ["สนใจ", "ขั้น", "ของแจก", "ซื้อครั้งที่", "ซื้อล่าสุด", "อื่น ๆ"]);
  assert.deepEqual(nonNodes(first), [], "ห้ามมี null/ข้อความดิบปนในลูกของแผง");
  assert.equal(h.calls.filter((c) => c.path.endsWith("/tag-framework")).length, 1);

  const panel = h.tagsPanel("U-room", ROOM_TAGS, h.refresh);
  assert.ok(panel.querySelector(".tag-groups"), "แผงถัดไปใช้กรอบจากแคชทันที");
  assert.equal(h.calls.filter((c) => c.path.endsWith("/tag-framework")).length, 1, "ไม่โหลดซ้ำภายในหนึ่งนาที");
  const chips = panel.querySelectorAll(".tag-chip").map((chip) => textOf(chip).replace("✕", ""));
  assert.ok(chips.includes("AI Agent for Business") && chips.includes("2") && chips.includes("VIP"), "ชิปในกลุ่มโชว์แค่ค่า");
  const dims = panel.querySelector(".tag-dim-select").children.map((o) => o.attributes.value);
  assert.deepEqual(dims, ["", "สนใจ", "ขั้น", "ระดับAI", "อาชีพ", "ใช้ทำ", "ของแจก", "ติดต่อ"], "มิติของระบบเลือกเองไม่ได้");

  const select = panel.querySelector(".tag-dim-select");
  select.value = "สนใจ";
  select.dispatch("change", { target: select });
  const values = panel.querySelector(".tag-value-select");
  assert.ok(values, "เลือกมิติที่มีรายการ = ได้ตัวเลือกค่า");
  assert.deepEqual(values.children.map((o) => o.attributes.value), ["", "AI Agent for Business", "AI Workflow Automation", "คลาสออนไลน์ Custom GPTs", "In-house"],
    "ค่าที่พักไว้ไม่อยู่ในตัวเลือก");
  panel.querySelector(".tag-add-btn").dispatch("click");
  assert.match(h.notices.at(-1), /เลือกค่าของมิติ "สนใจ" ก่อน/u);
  values.value = "In-house";
  values.dispatch("change", { target: values });
  panel.querySelector(".tag-add-btn").dispatch("click");
  await settle();
  assert.deepEqual(h.calls.at(-1), { path: "/console/api/customers/U-room/tags", method: "POST", body: { add: "สนใจ: In-house" } });
  assert.equal(h.refreshed(), 1);

  // ป้ายอิสระยังพิมพ์ได้เหมือนเดิม
  const fresh = h.tagsPanel("U-room", ROOM_TAGS, h.refresh);
  assert.equal(fresh.querySelector(".tag-dim-select").children[0].attributes.selected, "", "ส่งแล้วกลับไปที่ป้ายอิสระ");
  const input = fresh.querySelector(".tag-add-grid .tag-input");
  input.value = "VIP2";
  fresh.querySelector(".tag-add-btn").dispatch("click");
  await settle();
  assert.deepEqual(h.calls.at(-1).body, { add: "VIP2" });
  assert.deepEqual(nonNodes(fresh), []);
});

test("tags panel: switch off (or no framework file) keeps the original flat panel", async (t) => {
  installBrowserGlobals(t);
  resetTagFrameworkCache();
  const h = harness(null);
  const panel = h.tagsPanel("U-off", ROOM_TAGS, h.refresh);
  await settle();
  assert.equal(panel.querySelector(".tag-groups"), null);
  assert.ok(panel.querySelector(".tag-add-row .tag-input"));
  assert.equal(panel.querySelectorAll(".tag-chip").length, ROOM_TAGS.length);
  assert.ok(textOf(panel).includes("ซื้อครั้งที่: 2"), "แบบเดิมโชว์ชื่อป้ายเต็ม");
});
