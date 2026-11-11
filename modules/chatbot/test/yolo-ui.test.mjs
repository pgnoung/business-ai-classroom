// yolo-ui — เรนเดอร์กล่อง ⚡ YOLO และบล็อก "Telegram สั่งงานลูกแพร" ด้วย DOM จำลอง
// จับ ReferenceError/TypeError ที่การอ่านซอร์สจับไม่ได้ + ขั้นยืนยันเส้นเงิน + สิทธิ์ของปุ่ม
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

const textOf = (node) => JSON.stringify(node, (key, value) => (key === "parent" ? undefined : value));
// DOM จำลอง unref timer ทุกตัว — ใช้ setImmediate (ไม่ถูกห่อ) ไม่งั้น event loop จบก่อนเทสต์
const flush = () => new Promise((resolve) => setImmediate(resolve));
const CUSTOMER = { line_user_id: "U-ui", display_name: "คุณทดสอบ", known_name: "", channel_id: "default" };

async function mountYolo(t, { capabilities = ["yolo.send"], api, aiOn = false }) {
  const { doc } = installBrowserGlobals(t, { hash: "#/c/U-ui" });
  const yolo = await import("../public/console/yolo.mjs");
  yolo.resetYoloState();
  const toasts = [];
  let refreshed = 0;
  const control = yolo.yoloHeadControl({
    api, toast: (message) => toasts.push(message), state: { me: { capabilities } },
    customerId: "U-ui", customer: CUSTOMER, aiOn, refresh: async () => { refreshed += 1; },
  });
  if (control) doc.body.append(control);
  return { doc, yolo, control, toasts, refreshed: () => refreshed };
}

test("ไม่มีสิทธิ์ yolo.send = ไม่มีปุ่ม (พนักงานไม่เห็นปุ่มที่กดไม่ได้)", async (t) => {
  const { control } = await mountYolo(t, { capabilities: ["operations.use"], api: async () => ({}) });
  assert.equal(control, null);
});

test("เปิดกล่อง: ตรวจห้องล่วงหน้า · ส่งแล้วโชว์ข้อความที่ส่งจริง + สถานะ AI + รีเฟรชห้อง", async (t) => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (!options.method) return { ok: true, refusal: null, confirm: [], warnings: [{ code: "human_recent", text: "ทีมเพิ่งตอบห้องนี้ (5 นาทีก่อน)" }] };
    return {
      ok: true, status: "sent", sentText: "ขออนุญาตถามเพิ่มค่ะ\nทีมมีกี่ท่านคะ?", bubbles: ["ขออนุญาตถามเพิ่มค่ะ", "ทีมมีกี่ท่านคะ?"],
      images: [], warnings: [], aiChanged: false, ladder: { stage: "cold", before: 0, after: 1, ladderLength: 4 },
      customer: { aiEnabled: true },
    };
  };
  const view = await mountYolo(t, { api });
  view.doc.querySelector(".yolo-btn").dispatch("click");
  await flush();
  assert.equal(calls[0].path, "/console/api/customers/U-ui/yolo");
  const pop = view.doc.querySelector(".yolo-pop");
  assert.ok(pop, "กดแล้วต้องมีกล่อง");
  assert.match(textOf(pop), /อยากให้ลูกแพรทักอะไรต่อ \(ไม่ใส่ก็ได้\)/u);
  assert.match(textOf(pop), /เปิด AI ห้องนี้ต่อด้วย/u);
  assert.match(textOf(pop), /ทีมเพิ่งตอบห้องนี้/u);

  const input = view.doc.querySelector(".yolo-input");
  input.value = "ถามต่อเรื่องจำนวนพนักงาน";
  input.dispatch("input", { target: input });
  const check = view.doc.querySelector(".yolo-check");
  check.checked = true;
  check.dispatch("change", { target: check });
  view.doc.querySelector(".yolo-send").dispatch("click");
  await flush(); await flush();
  const post = calls.find((call) => call.options.method === "POST");
  assert.deepEqual(post.options.body, { instruction: "ถามต่อเรื่องจำนวนพนักงาน", enableAi: true, confirm: false });
  const after = textOf(view.doc.querySelector(".yolo-pop"));
  assert.match(after, /ส่งถึงลูกค้าแล้ว/u);
  assert.match(after, /ขออนุญาตถามเพิ่มค่ะ/u);
  assert.match(after, /AI ห้องนี้เปิดอยู่/u);
  assert.match(after, /FU อัตโนมัติเลื่อนไปขั้น 1\/4/u);
  assert.equal(view.refreshed(), 1, "ส่งเสร็จต้องโหลดห้องใหม่ให้เห็นข้อความ");
  assert.equal(view.doc.querySelector(".yolo-input").value, "", "ส่งแล้วล้างช่อง");
});

test("ห้องที่ส่งไม่ได้: ปุ่มส่งถูกปิดพร้อมเหตุผล · 422 จากเซิร์ฟเวอร์ขึ้นกล่องแดง", async (t) => {
  const api = async (path, options = {}) => {
    if (!options.method) return { ok: true, refusal: { code: "fb_window_closed", text: "ห้อง Facebook นี้ลูกค้าเงียบเกิน 24 ชม.แล้ว" }, confirm: [], warnings: [] };
    const error = new Error("DND");
    error.status = 422;
    error.data = { ok: false, status: "refused", reason: "do_not_disturb", reasonText: "ลูกค้าขอไม่ให้รบกวน (DND)" };
    throw error;
  };
  const view = await mountYolo(t, { api });
  view.doc.querySelector(".yolo-btn").dispatch("click");
  await flush();
  const send = view.doc.querySelector(".yolo-send");
  assert.equal(send.attributes.disabled, "disabled");
  assert.match(textOf(view.doc.querySelector(".yolo-pop")), /เงียบเกิน 24 ชม/u);
});

test("เส้นเงิน: 409 → กล่องส้มพร้อมปุ่ม 'ยืนยันส่ง 1 ครั้ง' → ส่งซ้ำด้วย confirm:true", async (t) => {
  const posts = [];
  const api = async (path, options = {}) => {
    if (!options.method) return { ok: true, refusal: null, confirm: [{ code: "money_line", text: "ห้องนี้อยู่ในเส้นเงิน" }], warnings: [] };
    posts.push(options.body);
    if (!options.body.confirm) {
      const error = new Error("ต้องยืนยัน");
      error.status = 409;
      error.data = { ok: false, status: "needs_confirmation", reason: "money_line", confirm: [{ code: "money_line", text: "ห้องนี้อยู่ในเส้นเงิน — เรื่องเงินเป็นงานของคน" }] };
      throw error;
    }
    return { ok: true, status: "sent", bubbles: ["สวัสดีค่ะ"], sentText: "สวัสดีค่ะ", warnings: [], customer: { aiEnabled: false } };
  };
  const view = await mountYolo(t, { api });
  view.doc.querySelector(".yolo-btn").dispatch("click");
  await flush();
  view.doc.querySelector(".yolo-send").dispatch("click");
  await flush(); await flush();
  const confirmBox = textOf(view.doc.querySelector(".yolo-result"));
  assert.match(confirmBox, /ต้องยืนยันก่อนส่ง/u);
  assert.match(confirmBox, /เรื่องเงินเป็นงานของคน/u);
  view.doc.querySelector(".yolo-confirm").dispatch("click");
  await flush(); await flush();
  assert.deepEqual(posts.map((body) => body.confirm), [false, true]);
  assert.match(textOf(view.doc.querySelector(".yolo-pop")), /ส่งถึงลูกค้าแล้ว/u);
});

test("ชิป ⚡ YOLO ใต้ฟองข้อความ: เฉพาะข้อความขาออกที่มี metadata.yolo", async (t) => {
  installBrowserGlobals(t);
  const { messageEvidenceChips } = await import("../public/console/chat.mjs");
  const chips = messageEvidenceChips({ direction: "out", metadata: { yolo: true, yoloSource: "telegram" } });
  assert.equal(chips[0].label, "⚡ YOLO");
  assert.match(chips[0].title, /สั่งจากTelegram/u);
  assert.equal(messageEvidenceChips({ direction: "out", metadata: {} }).length, 0);
  assert.equal(messageEvidenceChips({ direction: "in", metadata: { yolo: true } }).length, 0);
});

test("แท็บ 🔔 ส่งต่อแอดมิน: พิมพ์ข้อความ · เลือกไม่ปิด AI · ส่ง mode handoff · โชว์ผลแจ้งแอดมิน", async (t) => {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (!options.method) return { ok: true, refusal: { code: "rate_limited_room", text: "ห้องนี้เพิ่งได้ YOLO ไป" }, confirm: [], warnings: [] };
    return {
      ok: true, mode: "handoff", status: "handed_off", reason: "", bubbles: ["รับทราบค่ะ ส่งให้แอดมินแล้วนะคะ"],
      delivered: 1, expected: 1, aiClosed: false, notify: { sent: 2, total: 2, skipped: "" }, customer: { aiEnabled: true },
    };
  };
  const view = await mountYolo(t, { api, aiOn: true });
  view.doc.querySelector(".yolo-btn").dispatch("click");
  await flush();
  const tabs = view.doc.querySelectorAll(".yolo-tab");
  assert.equal(tabs.length, 2);
  tabs[1].dispatch("click");
  const pop = view.doc.querySelector(".yolo-pop");
  assert.match(textOf(pop), /ส่งต่อแอดมินเลย/u);
  assert.match(textOf(pop), /ข้อความถึงลูกค้า \(ไม่ใส่ก็ได้\)/u);
  assert.doesNotMatch(textOf(pop), /เพิ่งได้ YOLO/u, "ด่านของการทักต่อไม่ขวางการส่งต่อแอดมิน");
  const send = view.doc.querySelector(".yolo-send");
  assert.notEqual(send.attributes.disabled, "disabled", "ปุ่มส่งต่อกดได้แม้ห้องติดเพดาน YOLO");
  const radios = view.doc.querySelectorAll(".yolo-radio");
  assert.equal(radios.length, 2);
  assert.equal(radios[0].checked, true, "ค่าเริ่มต้น = ปิด AI");

  view.doc.querySelector(".yolo-suggest").dispatch("click");
  assert.match(view.doc.querySelector(".yolo-input").value, /ส่งเรื่องให้แอดมินดูแลต่อ/u);
  const input = view.doc.querySelector(".yolo-input");
  input.value = "รับทราบค่ะ ส่งให้แอดมินแล้วนะคะ";
  input.dispatch("input", { target: input });
  radios[1].dispatch("change", { target: radios[1] });
  view.doc.querySelector(".yolo-send").dispatch("click");
  await flush(); await flush();
  const posted = calls.find((call) => call.options.method === "POST");
  assert.deepEqual(posted.options.body, { mode: "handoff", message: "รับทราบค่ะ ส่งให้แอดมินแล้วนะคะ", closeAi: false });
  const after = textOf(view.doc.querySelector(".yolo-pop"));
  assert.match(after, /ส่งต่อแอดมินแล้ว/u);
  assert.match(after, /แจ้งแอดมินทาง LINE แล้ว 2\/2 คน/u);
  assert.match(after, /AI ห้องนี้ยังเปิด/u);
  assert.equal(view.refreshed(), 1);
  assert.deepEqual(view.toasts, ["ส่งต่อแอดมินแล้ว"]);
});

test("ชิปใต้ฟองของข้อความส่งต่อแอดมิน = 🔔 ส่งต่อแอดมิน (ไม่ใช่ ⚡ YOLO)", async (t) => {
  installBrowserGlobals(t);
  const { messageEvidenceChips } = await import("../public/console/chat.mjs");
  const chips = messageEvidenceChips({ direction: "out", metadata: { yolo: true, yoloHandoff: true, yoloSource: "console" } });
  assert.equal(chips[0].label, "🔔 ส่งต่อแอดมิน");
});

test("บล็อก Telegram: ยังไม่ตั้ง → ขั้นตอนตั้งค่า · ตั้งแล้ว → โทเคนปิดบัง · กดสร้างรหัส → รหัส + ลิงก์บอท", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/settings" });
  const { telegramControlBlock } = await import("../public/console/telegramSettings.mjs");
  let view = { ok: true, configured: false, tokenHint: "", botUsername: "", paired: null, pairing: null };
  const posts = [];
  const api = async (path, options = {}) => {
    if (options.method) posts.push({ path, body: options.body });
    if (path.endsWith("/pairing")) {
      view = { ...view, pairing: { expiresAt: Date.now() + 900_000 } };
      return { ok: true, code: "K7M2Q9XBTR", botUsername: "lukprae_boss_bot", deepLink: "https://t.me/lukprae_boss_bot?start=K7M2Q9XBTR" };
    }
    if (options.body?.token) {
      view = { ok: true, configured: true, tokenHint: "123456789:••••••••", botUsername: "lukprae_boss_bot", paired: null, pairing: null };
      return { ...view };
    }
    return { ...view };
  };
  const block = telegramControlBlock({ api, toast: () => {} });
  doc.body.append(block);
  await flush();
  let text = textOf(block);
  assert.ok(block.children.every((child) => child && typeof child === "object"), "ห้ามมี null ในลูกของบล็อก (DOM จริงจะพิมพ์คำว่า null ออกจอ)");
  assert.match(text, /Telegram สั่งงานลูกแพร/u);
  assert.match(text, /@BotFather/u);
  assert.match(text, /ยังไม่ตั้ง/u);
  const input = block.querySelector(".tg-input");
  assert.equal(input.attributes.type, "password");
  assert.equal(input.attributes.autocomplete, "new-password");
  const typed = ["123456789", "AAfake"].join(":"); // ประกอบจากชิ้น — ไม่มีรูป "token: ค่าจริง" ในซอร์ส
  input.value = typed;
  block.querySelectorAll("button").find((button) => textOf(button).includes("บันทึกโทเคน")).dispatch("click", {});
  await flush(); await flush();
  assert.deepEqual(posts[0], { path: "/console/api/settings/telegram", body: { token: typed } });
  text = textOf(block);
  assert.ok(block.children.every((child) => child && typeof child === "object"));
  assert.match(text, /@lukprae_boss_bot · 123456789:••••••••/u);
  assert.doesNotMatch(text, /AAfake/u, "โทเคนที่พิมพ์ต้องไม่ค้างบนจอ");
  block.querySelectorAll("button").find((button) => textOf(button).includes("สร้างรหัสจับคู่")).dispatch("click", {});
  await flush(); await flush();
  text = textOf(block);
  assert.match(text, /K7M2Q9XBTR/u);
  assert.match(text, /https:\/\/t\.me\/lukprae_boss_bot\?start=K7M2Q9XBTR/u);
  assert.match(text, /รอส่งรหัส/u);
});

test("บล็อก Telegram: รหัสจับคู่ถูกยกเลิกเพราะส่งผิดเกินกำหนด = บอกบนจอ (บอทเงียบกับทุกคนก่อนจับคู่)", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/settings" });
  const { telegramControlBlock } = await import("../public/console/telegramSettings.mjs");
  const view = {
    ok: true, configured: true, tokenHint: "123456789:••••••••", botUsername: "lukprae_boss_bot",
    paired: null, pairing: null, pairingLockedAt: Date.now(),
  };
  const block = telegramControlBlock({ api: async () => ({ ...view }), toast: () => {} });
  doc.body.append(block);
  await flush();
  const text = textOf(block);
  assert.match(text, /รหัสถูกยกเลิก/u);
  assert.match(text, /ส่งรหัสผิดเกิน 5 ครั้ง/u);
  assert.match(text, /สร้างรหัสจับคู่/u, "ต้องมีปุ่มสร้างรหัสใหม่ให้กดต่อได้ทันที");
});

test("หน้าตั้งค่า: บล็อก Telegram มีเฉพาะบัญชีที่มี integrations.manage และ CSS ไม่มี inline style", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/settings" });
  const { createSettingsPage } = await import("../public/console/settings.mjs");
  const render = async (capabilities) => {
    const calls = [];
    await createSettingsPage({
      api: async (path) => { calls.push(path); return { ok: true }; },
      toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
      pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"),
      stopPolling: () => {}, setView: () => {},
      state: { me: { username: "u", role: "x", capabilities }, csrf: "t", branding: {}, channels: [], channel: null, pollTimer: null, routeGen: 0, features: {}, ui: {} },
    })();
    await flush();
    return { calls, text: textOf(doc.body) };
  };
  const staff = await render(["operations.use", "settings.manage"]);
  assert.ok(!staff.calls.includes("/console/api/settings/telegram"));
  assert.doesNotMatch(staff.text, /Telegram สั่งงานลูกแพร/u);
  const owner = await render(["operations.use", "settings.manage", "integrations.manage"]);
  assert.ok(owner.calls.includes("/console/api/settings/telegram"));
  assert.match(owner.text, /Telegram สั่งงานลูกแพร/u);
  for (const file of ["yolo.mjs", "telegramSettings.mjs"]) {
    const source = readFileSync(new URL(`../public/console/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /style\s*:/u, `${file}: CSP style-src 'self' — ห้าม inline style`);
    assert.doesNotMatch(source, /innerHTML/u);
  }
  const html = readFileSync(new URL("../public/console/index.html", import.meta.url), "utf8");
  assert.match(html, /\/console\/static\/yolo\.css/u);
});
