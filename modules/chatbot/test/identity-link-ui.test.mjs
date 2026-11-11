// identity-link-ui — แผง "ช่องทางอื่นของลูกค้าคนนี้" + กล่องข้อความหลังเชื่อมในหน้าตั้งค่า ด้วย DOM จำลอง
// (จับ ReferenceError/TypeError ที่อ่านซอร์สไม่เจอ) · เลือกคลาสก่อนส่งลิงก์เสมอ · ยกเลิก/เชื่อมต้องยืนยัน (confirm:true)
// · staff ไม่เห็นปุ่มจัดการ · ข้อความของคลาสแก้ได้เฉพาะ Super Admin พร้อมตัวอย่างบับเบิล LINE
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { installBrowserGlobals } from "./console-dom.mjs";
import { poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

const textOf = (node) => JSON.stringify(node, (key, value) => (key === "parent" ? undefined : value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const FB_ROOM = { line_user_id: "facebook:p1", display_name: "คุณเฟซบุ๊ก", known_name: "", channel_id: "facebook" };
const LINE_ROOM = { line_user_id: "U-line", display_name: "คุณไลน์", known_name: "", channel_id: "default" };

async function mount(t, { customer = FB_ROOM, data, api = async () => ({ ok: true }) } = {}) {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${customer.line_user_id}` });
  const { createIdentityLinksPanel } = await import("../public/console/identityLinks.mjs");
  const toasts = [];
  let refreshed = 0;
  const panel = createIdentityLinksPanel({ api, toast: (message) => toasts.push(message), state: { ui: {} } });
  const node = panel.build({ customerId: customer.line_user_id, customer, data, refresh: async () => { refreshed += 1; } });
  if (node) doc.body.append(node);
  return { doc, node, toasts, refreshed: () => refreshed };
}

const CLASSES = [
  { type: "online", label: "AI Agent for Business Online", hint: "คลาสออนไลน์" },
  { type: "live_business", label: "Classroom AI Agent for Business", hint: "คลาสสอนสด 1 วัน (พื้นฐาน)" },
  { type: "live_workflow", label: "Classroom AI Agent Workflow Automation", hint: "คลาสสอนสด 1 วัน (ต่อยอด)" },
  { type: "live_private", label: "Private Class / In-house", hint: "สอนสดส่วนตัว" },
];
const inviteData = (over = {}) => ({
  blocker: "", lastSentAt: null, lastExpiresAt: null, lastStatus: "", lastClassType: "",
  classes: CLASSES, suggestedClass: "", suggestedFrom: "", candidates: [], buyerEvidence: true,
  previews: Object.fromEntries(CLASSES.map((row) => [row.type, `ตัวอย่าง ${row.type} LK-•••••-•••••`])), ...over,
});
const baseData = (over = {}) => ({
  mode: "manual", canManage: false, linked: [], lineBasicId: "@lukprae", purchasedClass: null,
  invite: inviteData(), ...over,
});

test("ไม่มีข้อมูลจากเซิร์ฟเวอร์ = ไม่มีแผง (ห้องแชทยังเปิดได้)", async (t) => {
  const view = await mount(t, { data: null });
  assert.equal(view.node, null);
});

test("ห้อง Facebook ที่ยังไม่เชื่อม: เลือกคลาสก่อน (ไม่มีคำใบ้ = ปุ่มส่งกดไม่ได้) → POST /identity/invite พร้อม classType แล้วรีเฟรช", async (t) => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { ok: true }; };
  const view = await mount(t, { data: baseData(), api });
  assert.match(textOf(view.node), /ช่องทางอื่นของลูกค้าคนนี้/u);
  const radios = view.doc.querySelectorAll(".idl-class");
  assert.deepEqual(radios.map((node) => node.attributes["data-class"]), ["online", "live_business", "live_workflow", "live_private"]);
  assert.ok(radios.every((node) => node.attributes["aria-checked"] === "false"));
  const group = view.doc.querySelector(".idl-classes");
  assert.equal(group.attributes.role, "radiogroup");
  assert.equal(view.doc.querySelector(`#${group.attributes["aria-labelledby"]}`).children[0].textContent, "ลูกค้าซื้อคลาสไหน", "กลุ่มตัวเลือกมีป้ายที่มองเห็นได้");
  const button = view.doc.querySelector(".idl-invite");
  assert.equal(button.disabled, true, "ยังไม่เลือกคลาส = ส่งไม่ได้");
  assert.match(textOf(view.node), /เลือกคลาสที่ลูกค้าซื้อก่อนส่ง/u);
  radios[2].dispatch("click");
  assert.equal(radios[2].attributes["aria-checked"], "true");
  assert.equal(button.disabled, false);
  assert.equal(view.doc.querySelector(".idl-preview-text").textContent, "ตัวอย่าง live_workflow LK-•••••-•••••");
  button.dispatch("click");
  await flush();
  assert.equal(calls[0].path, "/console/api/customers/facebook%3Ap1/identity/invite");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(calls[0].options.body, { classType: "live_workflow" });
  assert.equal(view.refreshed(), 1);
  assert.match(view.toasts[0], /ส่งลิงก์แล้ว \(Classroom AI Agent Workflow Automation\)/u);
  assert.equal(view.doc.querySelector(".idl-unlink"), null, "staff ไม่เห็นปุ่มจัดการ");
  assert.equal(view.doc.querySelector(".idl-suggest-box"), null);
});

test("คลาสที่เลือกไว้ให้จากหลักฐาน + คำเตือนเมื่อห้องยังไม่ติดป้าย customer · ลูกศรเลื่อนตัวเลือกได้", async (t) => {
  const data = baseData({ invite: inviteData({ suggestedClass: "online", suggestedFrom: "interest", buyerEvidence: false }) });
  const view = await mount(t, { data });
  const radios = view.doc.querySelectorAll(".idl-class");
  assert.equal(radios[0].attributes["aria-checked"], "true");
  assert.equal(view.doc.querySelector(".idl-invite").disabled, false);
  assert.match(textOf(view.node), /เลือกไว้ให้จากป้ายสนใจ — ตรวจให้ตรงกับที่ลูกค้าซื้อจริงก่อนส่ง/u);
  assert.match(textOf(view.node), /ยังไม่ได้ติดป้าย customer/u);
  radios[0].dispatch("keydown", { key: "ArrowDown", currentTarget: radios[0], preventDefault() {} });
  assert.equal(radios[1].attributes["aria-checked"], "true");
  assert.equal(radios[0].attributes["aria-checked"], "false");
});

test("ส่งลิงก์ไปแล้ว: คลาสของลิงก์ครั้งก่อน (คนเลือกเอง) ชนะคำใบ้จากป้าย", async (t) => {
  const data = baseData({ invite: inviteData({ lastSentAt: Date.now() - 60_000, lastExpiresAt: Date.now() + 86_400_000, lastStatus: "active",
    lastClassType: "live_private", suggestedClass: "online", suggestedFrom: "interest" }) });
  const view = await mount(t, { data });
  const checked = view.doc.querySelectorAll(".idl-class").filter((node) => node.attributes["aria-checked"] === "true");
  assert.deepEqual(checked.map((node) => node.attributes["data-class"]), ["live_private"]);
  assert.match(textOf(view.node), /เลือกไว้ให้ตามลิงก์ที่ทีมส่งครั้งก่อน/u);
  assert.match(textOf(view.node), /\(Private Class \/ In-house\)/u);
});

test("สวิตช์ปิด/นอก 24 ชม.: ปุ่มและตัวเลือกคลาสกดไม่ได้ และบอกเหตุผลเป็นภาษาคน", async (t) => {
  const off = await mount(t, { data: baseData({ mode: "off", invite: inviteData({ blocker: "mode_off", suggestedClass: "online", suggestedFrom: "purchase" }) }) });
  assert.equal(off.doc.querySelector(".idl-invite").disabled, true);
  assert.ok(off.doc.querySelectorAll(".idl-class").every((node) => node.attributes.disabled === "true"));
  assert.match(textOf(off.node), /ยังปิดอยู่ — เปิดได้ที่ ตั้งค่า/u);
  assert.equal(off.doc.querySelector(".idl-preview"), null);
});

test("ห้องที่เชื่อมแล้ว: ป้ายช่องทาง + ลิงก์เปิดห้อง · owner ยกเลิกได้หลังยืนยัน (confirm:true)", async (t) => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { ok: true, reopened: ["U-line"] }; };
  const data = baseData({
    canManage: true,
    invite: inviteData({ blocker: "already_linked" }),
    linked: [{ id: "U-line", channelId: "default", channelLabel: "LINE", name: "คุณไลน์", linkedVia: "code", linkedBy: "", linkedAt: Date.UTC(2026, 8, 28), aiEnabled: false, needsHuman: true, classType: "live_business", classLabel: "Classroom AI Agent for Business" }],
  });
  const view = await mount(t, { data, api });
  assert.equal(view.doc.querySelector(".idl-invite"), null, "เชื่อมแล้วไม่ต้องมีปุ่มส่งลิงก์");
  assert.ok(view.doc.querySelector(".idl-badge-line"));
  assert.equal(view.doc.querySelector(".idl-open").attributes.href, "#/c/U-line");
  assert.match(textOf(view.node), /ลูกค้าส่งรหัสยืนยันเอง/u);
  assert.match(textOf(view.node), /ซื้อ Classroom AI Agent for Business/u, "ทีมเห็นคลาสที่ซื้อบนแถวห้องที่เชื่อม");
  view.doc.querySelector(".idl-unlink").dispatch("click");
  await flush();
  assert.equal(calls[0].path, "/console/api/customers/facebook%3Ap1/identity/unlink");
  assert.deepEqual(calls[0].options.body, { confirm: true });
  assert.match(view.toasts[0], /เปิด AI คืน/u);
});

test("ยกเลิกไม่ยืนยัน = ไม่ยิงอะไรเลย", async (t) => {
  const calls = [];
  const data = baseData({ canManage: true, invite: inviteData({ blocker: "already_linked" }),
    linked: [{ id: "U-line", channelId: "default", channelLabel: "LINE", name: "คุณไลน์", linkedVia: "team", linkedBy: "nok", linkedAt: 1, aiEnabled: true }] });
  const view = await mount(t, { data, api: async (path) => { calls.push(path); return { ok: true }; } });
  globalThis.window.confirm = () => false;
  view.doc.querySelector(".idl-unlink").dispatch("click");
  await flush();
  assert.equal(calls.length, 0);
});

test("ห้อง LINE + owner: เปิดรายการแนะนำ = โหลดเมื่อเปิดครั้งแรก · เบอร์ตรง = เชื่อมแบบ suggestion", async (t) => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.includes("/suggestions")) {
      return { ok: true, suggestions: [
        { id: "facebook:p1", channelId: "facebook", channelLabel: "Facebook", name: "คุณเฟซบุ๊ก", reasons: ["phone"], strong: true, lastMessageAt: Date.now() - 60_000, linkedElsewhere: false },
        { id: "facebook:p2", channelId: "facebook", channelLabel: "Facebook", name: "คุณไลน", reasons: ["name"], strong: false, lastMessageAt: null, linkedElsewhere: true },
      ] };
    }
    return { ok: true, buyer: true };
  };
  const view = await mount(t, { customer: LINE_ROOM, data: baseData({ canManage: true, invite: null, purchasedClass: { type: "online", label: "AI Agent for Business Online" } }), api });
  assert.equal(view.doc.querySelector(".idl-invite"), null, "ห้อง LINE ไม่มีปุ่มส่งลิงก์");
  assert.match(textOf(view.doc.querySelector(".idl-purchased")), /AI Agent for Business Online/u);
  const box = view.doc.querySelector(".idl-suggest-box");
  box.dispatch("toggle", { target: { open: true } });
  await flush();
  assert.equal(calls[0].path, "/console/api/customers/U-line/identity/suggestions");
  assert.match(textOf(view.node), /เบอร์ตรงกัน/u);
  assert.match(textOf(view.node), /ชื่อคล้าย \(ไม่ใช่หลักฐาน\)/u);
  assert.match(textOf(view.node), /มีห้องเชื่อมอยู่แล้ว/u);
  view.doc.querySelectorAll(".idl-link")[0].dispatch("click");
  await flush();
  const link = calls.find((call) => call.path.endsWith("/identity/link"));
  assert.deepEqual(link.options.body, { otherId: "facebook:p1", via: "suggestion", confirm: true });
  assert.match(view.toasts.at(-1), /ติดป้าย customer และ AI เงียบ/u);
  const input = view.doc.querySelector(".idl-search");
  input.value = "ไลน์";
  input.dispatch("keydown", { key: "Enter", isComposing: false });
  await flush();
  assert.equal(calls.at(-1).path, "/console/api/customers/U-line/identity/suggestions?q=%E0%B9%84%E0%B8%A5%E0%B8%99%E0%B9%8C");
});

test("CSP: แผง/กล่องตั้งค่าไม่มี inline style และสไตล์อยู่ในไฟล์ที่ index.html โหลด + อยู่ในรายชื่อไฟล์ที่เสิร์ฟได้", () => {
  for (const file of ["identityLinks.mjs", "settingsIdentityLink.mjs"]) {
    const source = readFileSync(new URL(`../public/console/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /style:|\.style\.|innerHTML/u, file);
  }
  const settings = readFileSync(new URL("../public/console/settings.mjs", import.meta.url), "utf8");
  assert.ok(settings.includes('from "./settingsIdentityLink.mjs"'));
  const html = readFileSync(new URL("../public/console/index.html", import.meta.url), "utf8");
  assert.ok(html.includes("/console/static/identityLinks.css"));
  const allow = readFileSync(new URL("../src/consoleStatic.mjs", import.meta.url), "utf8");
  assert.ok(allow.includes('"identityLinks.mjs", "identityLinks.css"'));
  assert.ok(allow.includes('"settingsIdentityLink.mjs"'), "ลืมใส่ = หน้าตั้งค่าค้าง");
});

const TEMPLATES = (over = {}) => ({
  ok: true, canEdit: true, sampleName: "มาลี", limits: { maxBubbles: 5, bubbleChars: 2000, lineChars: 5000, totalChars: 6000 },
  templates: [
    { classType: "online", label: "AI Agent for Business Online", format: "online", hint: "คลาสออนไลน์", text: "", isDefault: true, updatedBy: "", updatedAt: 0,
      empty: true, readError: false, preview: ["สวัสดีค่ะ คุณมาลี 🙏\nทีมงานจะส่งขั้นตอนลงทะเบียนให้ในแชทนี้นะคะ"], fallback: "ทีมงานจะส่งขั้นตอนลงทะเบียนให้ในแชทนี้นะคะ", defaultText: "" },
    { classType: "live_business", label: "Classroom AI Agent for Business", format: "live", hint: "คลาสสอนสด", text: "เตรียมตัว\n---\nข้อสอง", isDefault: false, updatedBy: "ngoung",
      updatedAt: Date.UTC(2026, 8, 28, 14), empty: false, readError: false, preview: ["สวัสดีค่ะ คุณมาลี 🙏\nเตรียมตัว", "ข้อสอง"], fallback: "x", defaultText: "ค่าเริ่มต้น" },
  ],
  ...over,
});

async function mountSettings(t, api) {
  const { doc } = installBrowserGlobals(t, { hash: "#/settings" });
  const { identityLinkTemplatesBlock } = await import("../public/console/settingsIdentityLink.mjs");
  const toasts = [];
  const node = await identityLinkTemplatesBlock({ api, toast: (message) => toasts.push(message) });
  if (node) doc.body.append(node);
  return { doc, node, toasts };
}

test("ตั้งค่า: เจ้าของเห็นช่องแก้ + ตัวอย่างบับเบิล LINE · พิมพ์แล้วตัวอย่างอัปเดตจากเซิร์ฟเวอร์ · บันทึก/ใช้ค่าเริ่มต้น", async (t) => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith("/preview")) return { ok: true, valid: true, error: "", bubbles: ["สวัสดีค่ะ คุณมาลี 🙏\nลงทะเบียนที่นี่", "ข้อสอง"] };
    if (options.method === "POST") {
      return { ok: true, template: { ...TEMPLATES().templates[0], text: options.body.text ?? "", isDefault: options.body.reset === true, empty: false,
        updatedBy: "ngoung", updatedAt: Date.now(), preview: ["สวัสดีค่ะ คุณมาลี 🙏\nลงทะเบียนที่นี่"] } };
    }
    return TEMPLATES();
  };
  const view = await mountSettings(t, api);
  assert.match(textOf(view.node), /ข้อความหลังลูกค้าเชื่อม LINE \(แยกตามคลาสที่ซื้อ\)/u);
  const cards = view.doc.querySelectorAll(".idl-tpl");
  assert.equal(cards.length, 2);
  assert.match(textOf(cards[0]), /ยังไม่มีข้อความ/u);
  assert.match(textOf(cards[1]), /แก้โดย ngoung/u);
  assert.deepEqual(cards[1].querySelectorAll(".idl-tpl-bubble").map((node) => node.children[0].textContent), ["สวัสดีค่ะ คุณมาลี 🙏\nเตรียมตัว", "ข้อสอง"]);
  assert.equal(cards[0].querySelector(".idl-tpl-reset"), null, "ค่าเริ่มต้นอยู่แล้ว = ไม่ต้องมีปุ่มใช้ค่าเริ่มต้น");
  assert.ok(cards[1].querySelector(".idl-tpl-reset"));
  const input = cards[0].querySelector(".idl-tpl-input");
  input.value = "ลงทะเบียนที่นี่\n---\nข้อสอง";
  input.dispatch("input");
  await sleep(320); // ตัวจับเวลาของหน้าเว็บถูก unref ในเทสต์ — ต้องใช้ตัวจับเวลาจริงที่ค้าง event loop ไว้
  const preview = calls.find((call) => call.path.endsWith("/preview"));
  assert.deepEqual(preview.options.body, { classType: "online", text: "ลงทะเบียนที่นี่\n---\nข้อสอง" });
  assert.equal(cards[0].querySelectorAll(".idl-tpl-bubble").length, 2);
  cards[0].querySelector(".idl-tpl-save").dispatch("click");
  await flush();
  const saved = calls.find((call) => call.path === "/console/api/settings/identity-link-templates" && call.options.method === "POST");
  assert.deepEqual(saved.options.body, { classType: "online", text: "ลงทะเบียนที่นี่\n---\nข้อสอง" });
  assert.match(view.toasts[0], /ลูกค้าคนถัดไปได้ข้อความนี้ทันที/u);
  cards[1].querySelector(".idl-tpl-reset").dispatch("click");
  await flush();
  assert.deepEqual(calls.at(-1).options.body, { classType: "live_business", reset: true });
});

test("ตั้งค่า: ทีมที่ไม่ใช่เจ้าของเห็นข้อความแบบอ่านอย่างเดียว ไม่มีช่องแก้/ปุ่มบันทึก · เซิร์ฟเวอร์ไม่ตอบ = ไม่มีกล่อง", async (t) => {
  const view = await mountSettings(t, async () => TEMPLATES({ canEdit: false }));
  assert.equal(view.doc.querySelector(".idl-tpl-input"), null);
  assert.equal(view.doc.querySelector(".idl-tpl-save"), null);
  assert.equal(view.doc.querySelectorAll(".idl-tpl-readonly").length, 2);
  assert.match(textOf(view.node), /เฉพาะ Super Admin เท่านั้นที่แก้ข้อความที่ส่งถึงลูกค้าได้/u);
  const none = await mountSettings(t, async () => { throw new Error("403"); });
  assert.equal(none.node, null);
});
