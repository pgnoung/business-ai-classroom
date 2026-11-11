// console-whitelabel-ui — คอนโซลชุดเดียวใช้ได้หลายร้าน (8 ต.ค. 2026)
//
// สัญญา: profile "course" (production ลูกแพร) ต้องเหมือนเดิมทุกไบต์
//        profile "generic" (ร้านอื่น) ห้ามมีชื่อ ลูกแพร / พี่ง้วง / ติดกระดุม / Pngoung บนจอ
//        และต้องเรียก AI แอดมินด้วยชื่อของร้านนั้นเอง (เช่น "น้องมะลิ")
// เรนเดอร์หน้าเว็บจริงด้วย DOM จำลองแบบเดียวกับ console-role-ui-hiding.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installBrowserGlobals } from "./console-dom.mjs";
import {
  agentLabel, brandCopy, businessLabel, el, isGeneric, ownerLabel, rawText, setBrandingContext,
} from "../public/console/dom.mjs";
import { GENERIC_HIDDEN_SWITCHES, visibleSwitches } from "../public/console/settingsBehaviorSwitches.mjs";

const GENERIC = Object.freeze({
  name: "ร้านกาแฟมะลิ", mark: "ML", agent: "น้องมะลิ", theme: "starter",
  profile: "generic", agentName: "น้องมะลิ", ownerName: "พี่ส้ม", businessName: "ร้านกาแฟมะลิ",
});
const COURSE = Object.freeze({ name: "พี่ง้วง ติดกระดุม", mark: "P", agent: "ลูกแพร", theme: "lukprae" });
const BRAND_LEAK = /ลูกแพร|LuKprae|Lukprae|พี่ง้วง|Pngoung|ติดกระดุม/u;

const OWNER_CAPS = [
  "operations.use", "settings.manage", "knowledge.manage", "notifications.manage",
  "finance.view", "integrations.manage", "prices.manage", "brain.publish", "rules.manage",
  "knowledge.publish", "publish.approve", "users.manage", "ai_pause.manage", "yolo.send",
];

const pageText = (doc) => JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));

function withBranding(t, branding) {
  setBrandingContext(branding);
  t.after(() => setBrandingContext(null));
}

/* ------------------------------ helper ระดับข้อความ ------------------------------ */

test("white-label helpers: course คืนชื่อเดิมทุกไบต์ และ brandCopy ไม่แตะข้อความ", (t) => {
  withBranding(t, COURSE);
  assert.equal(isGeneric(), false);
  assert.equal(agentLabel(), "ลูกแพร");
  assert.equal(ownerLabel(), "พี่ง้วง");
  assert.equal(businessLabel(), "พี่ง้วง ติดกระดุม");
  const text = "ลูกแพรตอบแล้ว ส่งให้พี่ง้วงกดเผยแพร่ · พี่ง้วง ติดกระดุม";
  assert.equal(brandCopy(text), text);
  // ไม่มี context เลย (เทสต์เก่า/หน้าโหลดไม่ทัน) = course เสมอ
  setBrandingContext(null);
  assert.equal(agentLabel(), "ลูกแพร");
  assert.equal(brandCopy(text), text);
});

test("white-label helpers: generic ใช้ชื่อของร้าน และ state ชนะ context กลาง", (t) => {
  withBranding(t, GENERIC);
  assert.equal(isGeneric(), true);
  assert.equal(agentLabel(), "น้องมะลิ");
  assert.equal(ownerLabel(), "พี่ส้ม");
  assert.equal(businessLabel(), "ร้านกาแฟมะลิ");
  assert.equal(brandCopy("ลูกแพรตอบแล้ว ส่งให้พี่ง้วงกดเผยแพร่"), "น้องมะลิตอบแล้ว ส่งให้พี่ส้มกดเผยแพร่");
  assert.equal(brandCopy("ผู้ช่วยของพี่ง้วง ติดกระดุม"), "ผู้ช่วยของร้านกาแฟมะลิ");
  assert.equal(brandCopy("เปิดจากไอคอน LuKprae"), "เปิดจากไอคอน น้องมะลิ");
  // ไม่มีชื่อ AI = ใช้ agent แล้วค่อย "แอดมิน"
  assert.equal(agentLabel({ branding: { profile: "generic", agent: "บอทร้าน" } }), "บอทร้าน");
  assert.equal(agentLabel({ branding: { profile: "generic" } }), "แอดมิน");
  assert.equal(ownerLabel({ branding: { profile: "generic" } }), "เจ้าของร้าน");
  // state แบบ course ที่ส่งมาตรง ๆ ชนะ context กลาง
  assert.equal(agentLabel({ branding: COURSE }), "ลูกแพร");
});

test("white-label el(): generic แปลงข้อความและ title/aria-label แต่ rawText (คำพูดลูกค้า) ไม่แตะ", (t) => {
  installBrowserGlobals(t, { hash: "#/" });
  withBranding(t, GENERIC);
  const node = el("p", { title: "ลูกแพรกำลังดูแลแชท", "aria-label": "พี่ง้วง", href: "#/x" },
    "ลูกแพรตอบแล้ว", rawText("ลูกค้าพิมพ์ว่า ลูกแพร"));
  assert.equal(node.attributes.title, "น้องมะลิกำลังดูแลแชท");
  assert.equal(node.attributes["aria-label"], "พี่ส้ม");
  assert.equal(node.children[0].textContent, "น้องมะลิตอบแล้ว");
  assert.equal(node.children[1].textContent, "ลูกค้าพิมพ์ว่า ลูกแพร");
  setBrandingContext(COURSE);
  assert.equal(el("p", {}, "ลูกแพรตอบแล้ว").children[0].textContent, "ลูกแพรตอบแล้ว");
});

/* ------------------------------------ หน้าภาพรวม ------------------------------------ */

function overviewPayload() {
  return {
    ok: true,
    stats: { todayChats: 3, needsHuman: 1, hotCustomers: 1, totalCustomers: 10, activeCustomersToday: 3 },
    orders: { todayCount: 1, monthRevenue: 23800, monthConfirmedCount: 4, openDrafts: 0 },
    quota: { value: 15000, totalUsage: 1200, type: "limited" }, quotas: null,
    series: [{ day: "2026-10-07", inbound: 12, outbound: 10, revenue: 100 }],
    channel: null,
    aiCost: {
      thbPerUsd: 40, fxSource: "env", fxFetchedAt: Date.now(),
      today: { thb: 67, usd: 1.6, tokensIn: 1000, tokensOut: 500, breakdown: [] },
      month: { thb: 1200, usd: 30, tokensIn: 20000, tokensOut: 9000, breakdown: [] },
    },
    followupGlobal: false, followupAppointmentArmed: true, aiPaused: false,
    roomsAwaitingLegacyConfirm: 0, roomsAwaitingLegacyConfirmList: [], lastInboundAt: Date.now() - 60000,
  };
}

function kpiPayload() {
  return {
    ok: true,
    window: { days: 7, sinceMs: 0, nowMs: Date.now(), attributionStartMs: 0 },
    holidays: [],
    speed: { workingDays: { ai: { medianMs: 4000, count: 12 }, human: { medianMs: 90000, count: 5 } }, all: {}, workingHours: {} },
    backlog: { total: 2, waitingForHuman: 1 },
    closing: { hybrid: { ratePct: 40, closed: 2, rooms: 5 }, fullyAi: { ratePct: 20, closed: 1, rooms: 5 } },
    days: { excluded: [] },
  };
}

function attentionPayload() {
  return {
    ok: true,
    waiting: { total: 0, rooms: [] },
    hotQuiet: { total: 1, rooms: [{ id: "U-hot", display_name: "คุณเอ", last_score: 9, last_at: Date.now() - 2 * 86_400_000, aiReplies: 2 }] },
  };
}

async function renderOverview(t, branding) {
  const { doc } = installBrowserGlobals(t, { hash: "#/" });
  withBranding(t, branding);
  const { createOverviewPage } = await import("../public/console/overview.mjs");
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith("/console/api/overview/attention")) return attentionPayload();
    if (path.startsWith("/console/api/overview")) return overviewPayload();
    if (path.startsWith("/console/api/kpi")) return kpiPayload();
    if (path.startsWith("/console/api/inbox")) return { ok: true, counts: { all: 10, hot: 1, warm: 2, cold: 7 } };
    if (path.startsWith("/console/api/roas/ad-summary")) return { ok: true, days: [], totalThb: 1000 };
    if (path.startsWith("/console/api/roas")) return { ok: false };
    return { ok: true };
  };
  await createOverviewPage({
    api, toast: () => {},
    mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
    tabBar: () => doc.createElement("nav"),
    stopPolling: () => {}, setView: () => {},
    state: {
      me: { username: "owner", displayName: "เจ้าของ", role: "owner", capabilities: OWNER_CAPS },
      csrf: "t", branding, channels: [], channel: null, pollTimer: null, routeGen: 0,
      features: { intro: true }, ui: { exportOpen: false },
    },
  })();
  return { text: pageText(doc), calls };
}

test("ภาพรวม generic: ไม่มีชื่อแบรนด์ production เรียกผู้ช่วยว่าน้องมะลิ และไม่ยิงเส้นค่าแอด/ROAS", async (t) => {
  const { text, calls } = await renderOverview(t, GENERIC);
  assert.doesNotMatch(text, BRAND_LEAK, "หน้าภาพรวมของร้านอื่นห้ามมีชื่อแบรนด์ production");
  assert.match(text, /น้องมะลิ/u, "ต้องเรียก AI แอดมินด้วยชื่อของร้าน");
  assert.ok(!calls.some((p) => p.startsWith("/console/api/roas")), "ร้านทั่วไปไม่มีค่าแอด/ROAS");
  assert.doesNotMatch(text, /จักรวาล|เมนู Intro/u, "ไม่มีทางเข้า/สวิตช์หน้า Intro");
  assert.doesNotMatch(text, /brand\/lukprae/u, "ไม่มีภาพตัวละครลูกแพร");
});

test("ภาพรวม course: ยังเรียกลูกแพรและยิงเส้นค่าแอดเหมือนเดิม", async (t) => {
  const { text, calls } = await renderOverview(t, COURSE);
  assert.match(text, /ลูกแพร/u);
  assert.ok(calls.some((p) => p.startsWith("/console/api/roas/ad-summary")), "เจ้าของ course ยังเห็นการ์ดค่าแอด");
  assert.ok(calls.some((p) => /\/console\/api\/roas\?/u.test(p)), "เจ้าของ course ยังเห็นแผง ROAS");
  assert.doesNotMatch(text, /น้องมะลิ/u);
});

/* ------------------------------------ หน้าตั้งค่า ------------------------------------ */

const ALL_SWITCHES = [
  "coaching_brake_mode", "owner_chat_mode", "owner_chat_model", "step_messages_mode", "natural_voice_mode",
  "qualify_sweep_mode", "reply_engine", "order_mode", "meta_capi_mode", "lesson_digest_mode",
  "identity_link_mode", "ad_referral_capture", "hot_followup_push_mode", "tag_framework_mode",
].map((key) => ({ key, value: "off", values: ["off", "on"] }));

async function renderSettings(t, branding) {
  const { doc } = installBrowserGlobals(t, { hash: "#/settings" });
  withBranding(t, branding);
  const { createSettingsPage } = await import("../public/console/settings.mjs");
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith("/console/api/settings/behavior-switches")) return { ok: true, canEdit: true, switches: ALL_SWITCHES };
    if (path.startsWith("/console/api/settings/ai-pause")) return { ok: true, paused: false };
    if (path.startsWith("/console/api/channels")) return { ok: true, multi: false, channels: [{ id: "default", name: "OA หลัก", active: true }] };
    return { ok: true };
  };
  await createSettingsPage({
    api, toast: () => {},
    mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
    tabBar: () => doc.createElement("nav"),
    stopPolling: () => {}, setView: () => {},
    state: {
      me: { username: "owner", role: "owner", capabilities: OWNER_CAPS },
      csrf: "t", branding, channels: [], channel: null, pollTimer: null, routeGen: 0, features: {}, ui: {},
    },
  })();
  return { text: pageText(doc), calls };
}

test("ตั้งค่า generic: ไม่มีชื่อแบรนด์ ไม่มี Telegram/ตัวทดสอบ Claude/คำถามต้อนรับแอด/ข้อความเชื่อม FB และสวิตช์เฉพาะ course", async (t) => {
  const { text, calls } = await renderSettings(t, GENERIC);
  assert.doesNotMatch(text, BRAND_LEAK, "หน้าตั้งค่าของร้านอื่นห้ามมีชื่อแบรนด์ production");
  assert.match(text, /สวิตช์พฤติกรรมน้องมะลิ/u, "หัวข้อสวิตช์ต้องใช้ชื่อ AI ของร้าน");
  assert.ok(!calls.some((p) => p.includes("claude-export-testers")), "ไม่ยิงเส้นตัวทดสอบ Claude export");
  assert.ok(!calls.some((p) => /telegram|ad-welcome|identity-link/u.test(p)), `ไม่ยิงเส้นที่ซ่อน: ${calls.join(", ")}`);
  assert.doesNotMatch(text, /Telegram|เครื่องตอบแชท v3|Meta CAPI/u);
  assert.match(text, /เบรกโค้ช|coaching_brake_mode|สวิตช์/u, "สวิตช์ทั่วไปยังอยู่");
});

test("ตั้งค่า course: สวิตช์ทุกตัวและตัวทดสอบ Claude export ยังอยู่", async (t) => {
  const { text, calls } = await renderSettings(t, COURSE);
  assert.match(text, /สวิตช์พฤติกรรมลูกแพร/u);
  assert.match(text, /เครื่องตอบแชท v3/u);
  assert.ok(calls.some((p) => p.includes("claude-export-testers")), "course ยังโหลดตัวทดสอบ Claude export");
});

test("สวิตช์พฤติกรรม: generic ตัดคีย์เฉพาะ course ออกครบ course ไม่ตัดอะไรเลย", () => {
  const generic = visibleSwitches(ALL_SWITCHES, { branding: GENERIC }).map((s) => s.key);
  for (const key of ["owner_chat_mode", "lesson_digest_mode", "qualify_sweep_mode", "identity_link_mode",
    "natural_voice_mode", "meta_capi_mode", "ad_referral_capture", "reply_engine"]) {
    assert.ok(GENERIC_HIDDEN_SWITCHES.has(key), `${key} ต้องอยู่ในรายการซ่อน`);
    assert.ok(!generic.includes(key), `${key} ต้องไม่โผล่ใน generic`);
  }
  assert.ok(generic.includes("coaching_brake_mode") && generic.includes("step_messages_mode"));
  assert.deepEqual(visibleSwitches(ALL_SWITCHES, { branding: COURSE }), ALL_SWITCHES);
});

/* --------------------------------- shell: เมนู + route --------------------------------- */

async function bootShell(t, { branding, hash, tag }) {
  const { doc } = installBrowserGlobals(t, { hash });
  const app = doc.createElement("div");
  app.setAttribute("id", "app");
  doc.body.append(app);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    const body = path === "/console/api/me"
      ? {
          operator: { username: "owner", displayName: "เจ้าของ", role: "owner", capabilities: OWNER_CAPS },
          csrf: "t", branding,
          features: { classRounds: true, intro: true, teach: true, lessons: true, chatHistory: true },
        }
      : { ok: true, channels: [] };
    return { status: 200, ok: true, json: async () => body };
  };
  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.requestAnimationFrame = previousRaf;
    setBrandingContext(null);
  });
  await import(`../public/console/console.js?${tag}`);
  // boot() เดินแบบ async — รอให้ route แรก mount เสร็จ
  for (let i = 0; i < 50 && !pageText(doc).includes("topnav"); i += 1) await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  const topnav = doc.body.querySelector(".topnav");
  const links = (topnav?.children || []).map((a) => a.attributes.href);
  return { doc, links, text: pageText(doc) };
}

test("shell generic: เมนูไม่มีที่นั่ง/Intro และเปิด #/rounds ตรง ๆ ได้หน้า ไม่มีในแพ็กเกจนี้", async (t) => {
  const { doc, links, text } = await bootShell(t, { branding: GENERIC, hash: "#/rounds", tag: "generic" });
  assert.ok(links.length > 3, "ต้องเรนเดอร์เมนูจริง");
  assert.ok(!links.includes("#/rounds"), "ร้านทั่วไปไม่มีเมนูที่นั่ง");
  assert.ok(!links.includes("#/intro"), "ร้านทั่วไปไม่มีเมนู Intro");
  assert.match(text, /ไม่มีในแพ็กเกจนี้/u);
  assert.doesNotMatch(text, BRAND_LEAK);
  assert.match(text, /ร้านกาแฟมะลิ/u);
  assert.equal(doc.documentElement.classList.contains("theme-starter"), true);
  assert.equal(doc.documentElement.classList.contains("theme-lukprae"), false);
});

test("shell course: เมนูที่นั่งและ Intro ยังอยู่ตามฟีเจอร์เดิม", async (t) => {
  const { doc, links } = await bootShell(t, { branding: COURSE, hash: "#/settings", tag: "course" });
  assert.ok(links.includes("#/rounds"));
  assert.ok(links.includes("#/intro"));
  assert.equal(doc.documentElement.classList.contains("theme-lukprae"), true);
  assert.equal(doc.documentElement.classList.contains("theme-starter"), false);
});

/* ------------------------------------ ธีม starter ------------------------------------ */

test("theme-starter.css: scope ของตัวเอง ไม่อ้างภาพ/ฟอนต์ลูกแพร และนิยาม token หลักครบ", () => {
  const css = readFileSync(new URL("../public/console/theme-starter.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /lukprae|https?:\/\//iu);
  const block = css.match(/:root\.theme-starter\s*\{([\s\S]*?)\n\}/u)?.[1] || "";
  for (const token of ["--bg", "--surface", "--surface-2", "--ink", "--ink-2", "--line", "--brand", "--brand-700",
    "--brand-50", "--brand-ink", "--on-brand", "--danger", "--green", "--hot", "--warm", "--cold", "--qualify",
    "--neutral-soft", "--chart-inbound", "--chart-revenue"]) {
    assert.match(block, new RegExp(`${token}:`, "u"), `${token} ต้องอยู่ในธีม starter`);
  }
  // ทุกกฎในไฟล์ต้องอยู่ใต้ :root.theme-starter — ไม่รั่วไปธีมอื่น
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//gu, "").split("}").map((r) => r.trim()).filter(Boolean)) {
    assert.match(rule, /^:root\.theme-starter/u, `กฎนี้ต้อง scope ใต้ theme-starter: ${rule.slice(0, 60)}`);
  }
});
