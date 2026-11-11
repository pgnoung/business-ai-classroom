// console.js — Operator Console SPA (shell): api/toast/mount + nav + routing
// Redesign G4 (2026-08-10): light messaging workspace สไตล์ respond.io
//   มือถือ = ทีละหน้า + bottom tab bar (นิ้วโป้งเอื้อมถึง)
//   เดสก์ท็อป ≥1024px = split view (รายการแชท | ห้องแชท | แผงข้อมูล)
// เส้นทาง hash: #/            = ภาพรวม (หน้าแรกหลัง login)
//               #/chat        = รายการแชท (#/chat/hot|warm|cold|needs|aioff|notqualify|waiting|waiting24|hotfollow|spam = segment)
//               #/chat/<segment>/<id> = ห้องแชทที่เปิดจากคิว (คิวรอตอบ: ห้องถัดไปอัตโนมัติ)
//               #/c/<id>      = ห้องแชทลูกค้า (deep link เดิมยังใช้ได้)
//               #/orders      = ออเดอร์ (G6) | #/corrections = คิวรีวิวคำแก้
//               #/knowledge   = คลังความรู้ | #/settings = ตั้งค่า
// ทุกข้อความ dynamic เรนเดอร์ผ่าน el() (text node เท่านั้น — ดู dom.mjs)
import { brandCopy, el, isGeneric, setBrandingContext, timeAgo } from "./dom.mjs";
import { emptyArt } from "./ui.mjs";
import { createOverviewPage } from "./overview.mjs";
import { createSettingsPage } from "./settings.mjs";
import { createKnowledgePage } from "./knowledge.mjs";
import { createKpiPage } from "./kpi.mjs";
import { createRoundsPage } from "./rounds.mjs";
import { createChatWorkspace } from "./chat.mjs";
import { createOrdersPage } from "./orders.mjs";
import { createBroadcastPage } from "./broadcast.mjs";
import { createTrainingReviewPage } from "./training.mjs";
import { createReviewPage } from "./review.mjs";
import { createTeachPage } from "./teach.mjs";
import { createTrainingIntakePage } from "./trainingIntake.mjs";
import { createReadinessPage } from "./readiness.mjs";
import { createBackupPage } from "./backup.mjs";
import { createSoulPage } from "./soul.mjs";
import { createHistoryPage } from "./history.mjs";
import { createLessonsPage } from "./lessons.mjs";
import { captureScroll, restoreScroll } from "./scrollKeeper.mjs";
import { refreshExistingWebPushBinding } from "./webPushUi.mjs";
import { createIntroPage } from "./intro.mjs";
import { createOwnerReviewPage, ownerReviewTab } from "./ownerReview.mjs";
import { createUsagePage } from "./usage.mjs";
import { icon, navIcon } from "./icons.mjs";

const app = document.getElementById("app");
const state = {
  me: null, csrf: "", branding: { name: "Front Desk", mark: "FD", agent: "", theme: "airdog" }, pollTimer: null, draft: null, routeGen: 0,
  // W3 multi-OA: รายการสาขาจาก /console/api/channels (0-1 สาขา = โหมดเดิม ไม่มี chip)
  // channel = สาขาที่เลือกดูอยู่ (แชร์กันทั้ง inbox/ภาพรวม/export) — null = ทุกสาขา
  channels: [], channel: null, settingsChannel: null, operators: [],
  features: { broadcast: false, classRounds: false, imageUpload: false, fileUpload: false, stickers: false, webPush: false, teach: false, jevReview: false, trainingIntake: false, chatHistory: false, lessons: false, intro: false, ownerReview: false },
  webPushPublicKey: "",
  // เปิด/ปิด panel — คงสถานะข้าม poll re-render
  // contextOpen = null คือยังไม่ตัดสิน — chat.mjs ตัดสินตอนเปิดห้องแรก (จอกว้าง = เปิด)
  ui: { salesOpen: false, fuOpen: false, notesOpen: false, exportOpen: false, contextOpen: null, theme: "light" },
  inbox: { filter: null, q: "", extra: [], hasMore: false },
  chat: { id: null, head: [], older: [], hasMoreOlder: false, atBottom: true, keepFromBottom: null },
  // ข้อความที่พิมพ์ค้าง แยกตามห้อง (customerId -> ข้อความ)
  // เดิมเก็บก้อนเดียวแล้วกู้ข้ามห้องได้ = ข้อความของลูกค้าคนหนึ่งไปโผล่ในกล่องของอีกคน
  chatDrafts: new Map(),
  // บันทึก "ส่งแล้วแต่ไม่แน่ใจว่าถึงลูกค้าไหม" แยกตามห้อง — ต้องอยู่ข้ามการสลับห้อง
  // เพราะเป็นกรณีที่ห้ามส่งซ้ำโดยไม่เข้าไปตรวจห้อง LINE ก่อน
  chatUncertain: new Map(),
};

function themeStorageKey() {
  const username = String(state.me?.username || "operator").replace(/[^a-z0-9_.-]/giu, "_");
  return `lukprae.ui_theme:${username}`;
}

function savedTheme() {
  try {
    return localStorage.getItem(themeStorageKey()) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function applyUiTheme(theme, { persist = false } = {}) {
  state.ui.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.classList.toggle("theme-dark", state.ui.theme === "dark");
  document.documentElement.style.colorScheme = state.ui.theme;
  if (persist) {
    try {
      localStorage.setItem(themeStorageKey(), state.ui.theme);
      // หน้าเข้าสู่ระบบยังไม่รู้ชื่อผู้ใช้ — จำ "ธีมล่าสุดของเครื่องนี้" แยกไว้ให้หน้านั้นใช้ (28 ก.ย. 2026)
      localStorage.setItem("lukprae.ui_theme:last", state.ui.theme);
    } catch { /* private browser storage can fail */ }
  }
}

// ธีมมืดเป็นตัวเลือกต่อคนของ Pngoung และลูกแพร (28 ก.ย. 2026: ลูกแพรได้โหมด "ค่ำคืนพลัม" แล้ว)
const hasDarkOption = () => state.branding.theme === "pngoung" || state.branding.theme === "lukprae";

// white-label (8 ต.ค. 2026): profile "generic" = ร้านอื่นที่ใช้คอนโซลชุดนี้ (ชื่อ AI แอดมิน/เจ้าของ/ร้าน ของเขาเอง)
// ไม่มี profile = course (production) — state.branding มีแค่ 4 ฟิลด์เดิมเหมือนทุกวันนี้
const textOrEmpty = (value) => (typeof value === "string" ? value : "");

export function normalizeBranding(branding) {
  const next = branding && typeof branding === "object" ? branding : {};
  const generic = next.profile === "generic";
  const known = next.theme === "pngoung" || next.theme === "lukprae" || next.theme === "starter";
  // ธีม lukprae พกภาพตัวละครลูกแพร — ร้านทั่วไปได้ธีม starter แทน
  const theme = generic && next.theme === "lukprae" ? "starter" : (known ? next.theme : "airdog");
  const base = {
    name: typeof next.name === "string" ? next.name : "Front Desk",
    mark: typeof next.mark === "string" ? next.mark : "FD",
    agent: typeof next.agent === "string" ? next.agent : "",
    theme,
  };
  if (!generic) return base;
  return {
    ...base,
    profile: "generic",
    agentName: textOrEmpty(next.agentName),
    ownerName: textOrEmpty(next.ownerName),
    businessName: textOrEmpty(next.businessName),
  };
}

function applyBranding(branding) {
  state.branding = normalizeBranding(branding);
  setBrandingContext(state.branding);
  document.documentElement.classList.toggle("theme-pngoung", state.branding.theme === "pngoung");
  document.documentElement.classList.toggle("theme-lukprae", state.branding.theme === "lukprae");
  document.documentElement.classList.toggle("theme-starter", state.branding.theme === "starter");
  applyUiTheme(hasDarkOption() ? savedTheme() : "light");
  document.title = `${state.branding.name} Console`;
}

// ชื่อสาขาไว้โชว์บนหัวห้อง/แถว — ไม่รู้จัก id = โชว์ id ตรง ๆ
function channelName(channelId) {
  const ch = state.channels.find((c) => c.id === channelId);
  return ch?.name || channelId || "";
}

/* ---------------------------------- api ----------------------------------- */

// แตะการแจ้งเตือนตอนเซสชันหมด แล้วถูกส่งไปหน้า login — ของเดิมทิ้ง hash ทิ้ง
// พอล็อกอินเสร็จจึงเด้งไปหน้ารวม ไม่รู้ว่าเมื่อกี้เป็นห้องแชทของใคร
// เก็บเฉพาะ hash รูปแบบ "#/..." เท่านั้น กัน open-redirect
function loginUrlKeepingPlace() {
  const hash = String(location.hash || "");
  return /^#\/[\w\-./%]*$/.test(hash) && hash.length <= 200
    ? `/console/login?next=${encodeURIComponent(hash)}`
    : "/console/login";
}

async function api(path, { method = "GET", body = null } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-csrf-token"] = state.csrf;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    location.href = loginUrlKeepingPlace();
    throw new Error("ต้องเข้าสู่ระบบ");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`);
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function uploadMedia(path, file) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": file.type,
      "x-media-size": String(file.size),
      "x-csrf-token": state.csrf,
    },
    body: file,
  });
  if (res.status === 401) {
    location.href = loginUrlKeepingPlace();
    throw new Error("ต้องเข้าสู่ระบบ");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `อัปโหลดไม่สำเร็จ (${res.status})`);
  return data;
}

let toastTimer = null;
function toast(message) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = el("div", { class: "toast" });
    document.body.append(node);
  }
  node.textContent = brandCopy(message);
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

// replaceChildren ที่ข้าม null/undefined ได้ — ทุกหน้า mount ผ่านตัวนี้
//
// REVIEW FIX v1.2 (พี่ง้วงเจอรอบสอง: แผงข้อมูลลูกค้า + หน้าภาพรวมเด้งขึ้นเองหลัง poll):
// การจำตำแหน่ง scroll ต้องเกิด "ที่ตัวกลาง" ไม่ใช่ไล่แก้ทีละหน้า — mount จับ scrollTop
// ของทุก container ที่เลื่อนได้จาก DOM เก่า แล้วคืนให้ DOM ใหม่เสมอ ทุกหน้าได้ฟรีอัตโนมัติ
// (.bubbles ไม่อยู่ในลิสต์ — ห้องแชทมี logic เฉพาะของตัวเอง: ตามล่าสุด/ค้างตำแหน่ง ใน chat.mjs)
// REVIEW FIX รอบสอง: จำตำแหน่งต้องผูกกับ "หน้า/ห้องเดียวกัน" — ไม่ใช่แค่ชื่อ class
// (ไม่งั้นเลื่อนหน้าภาพรวมไว้ลึก ๆ แล้วเปิดตั้งค่า = ตั้งค่าเปิดมาก็เลื่อนลึกตาม)
// scope: page-scroll = เส้นทางหน้า (#/settings ฯลฯ), ctx-scroll = ต่อห้องลูกค้า,
// convo-list = ตระกูลแชททั้งหมด (เลื่อนรายการค้างไว้ เปิดห้องแล้วกลับมาต้องอยู่ที่เดิม)
let lastMountHash = "#/";
let mountGen = 0;
const keptScroll = new Map();
function mount(...nodes) {
  const prevHash = lastMountHash;
  const hash = location.hash || "#/";
  captureScroll(app, prevHash, keptScroll);
  app.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  lastMountHash = hash;
  const gen = ++mountGen;
  // คืนทันทีเพื่อลดภาพกระพริบ แล้วคืนซ้ำหลัง layout หนึ่งเฟรม (รายละเอียด/รูปอาจทำให้ความสูงเปลี่ยน)
  restoreScroll(app, hash, keptScroll);
  requestAnimationFrame(() => {
    if (gen !== mountGen || (location.hash || "#/") !== hash) return;
    restoreScroll(app, hash, keptScroll);
  });
}

// view บอก CSS ว่ากำลังโชว์อะไร: "page" (ภาพรวม/ตั้งค่า…), "list" (รายการแชท), "room" (ห้องแชท)
// มือถือใช้ซ่อน topbar/tabbar ตอนอยู่ในห้อง — เต็มจอเหมือนแอปแชทจริง
function setView(view) {
  app.dataset.view = view;
}

/* -------------------------------- navigation ------------------------------- */

// G6 IA: แถบล่างมือถือคงไว้ 5 ปุ่ม (นิ้วโป้งเอื้อมถึง) — "ออเดอร์" (งานเงิน ใช้ทุกวัน)
// เข้าแทนที่ "คำแก้" ซึ่งเป็นคิวรีวิวเป็นครั้งคราว; มือถือยังถึงคำแก้ใน 2 แตะผ่านการ์ด
// "คำตอบที่ระบบกันไว้" หน้าภาพรวม — เดสก์ท็อป topnav โชว์ครบทั้ง 6 เมนู
// v1.4.33 (พี่ง้วงสั่ง 2026-08-19): เรียงแบบ LINE — ภาพรวมก่อน แล้วแชท
// และแชทเป็นปุ่มเด่นกว่าเพื่อน (accent) เพราะเป็นงานที่แอดมินกดบ่อยที่สุดทั้งวัน
const TABS = [
  { hash: "#/", icon: "📊", label: "ภาพรวม", isActive: (h) => h === "" || h === "#" || h === "#/" },
  { hash: "#/chat", icon: "💬", label: "แชท", accent: true, isActive: (h) => h.startsWith("#/chat") || h.startsWith("#/c/") },
  { hash: "#/orders", icon: "🧾", label: "ออเดอร์", isActive: (h) => h.startsWith("#/orders") },
  { hash: "#/broadcast", icon: "📣", label: "บรอดแคส", desktopOnly: true, feature: "broadcast", isActive: (h) => h.startsWith("#/broadcast") },
  // เฟส 3: กล่องตรวจอยู่บนแถบล่างของมือถือด้วย (ไม่ใช่ desktopOnly) — งานสอนลูกแพร
  // เกิดตอนพี่ง้วงอยู่บนมือถือ ถ้าเข้าถึงได้เฉพาะเดสก์ท็อป มันจะไม่เกิดขึ้นเลย
  { hash: "#/review", icon: "🩺", label: "กล่องตรวจ", isActive: (h) => h.startsWith("#/review") || h.startsWith("#/teach") },
  // 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง (closes.confirm) — มือถือเข้าจากแจ้งเตือน/การ์ดหน้าภาพรวม แถบล่างไม่รก
  { hash: "#/owner-review", icon: "🔎", label: "ห้องตรวจ", desktopOnly: true, feature: "ownerReview", isActive: (h) => h.startsWith("#/owner-review") },
  { hash: "#/corrections", icon: "🧠", label: "เรียนรู้", desktopOnly: true, capability: "corrections.review", isActive: (h) => h.startsWith("#/corrections") },
  { hash: "#/training", icon: "🧪", label: "เทรนนิ่ง", desktopOnly: true, capability: "training.review", isActive: (h) => h.startsWith("#/training") },
  { hash: "#/rounds", icon: "🪑", label: "ที่นั่ง", feature: "classRounds", courseOnly: true, isActive: (h) => h.startsWith("#/rounds") },
  { hash: "#/kpi", icon: "📊", label: "ผลงาน", desktopOnly: true, capability: "knowledge.manage", isActive: (h) => h.startsWith("#/kpi") },
  { hash: "#/history", icon: "🗂", label: "ประวัติ", desktopOnly: true, feature: "chatHistory", isActive: (h) => h.startsWith("#/history") },
  { hash: "#/knowledge", icon: "📚", label: "ความรู้", capability: "knowledge.manage", isActive: (h) => h.startsWith("#/knowledge") },
  // 18 ต.ค. 2026 (ขั้นที่ 2 ของแผน soul): ตัวตนของ AI อ่านอย่างเดียว — มือถือเข้าจากลิงก์ในหน้าความรู้
  { hash: "#/soul", icon: "🪪", label: "ตัวตน", desktopOnly: true, capability: "knowledge.manage", isActive: (h) => h.startsWith("#/soul") },
  // 2026-09-28: บทเรียนที่สอนจากแผง "ทำไมตอบแบบนี้" (lessons.mjs) — มือถือเข้าผ่านลิงก์ในแผงนั้น
  { hash: "#/lessons", icon: "🎓", label: "บทเรียน", desktopOnly: true, feature: "lessons", isActive: (h) => h.startsWith("#/lessons") },
  { hash: "#/readiness", icon: "🧭", label: "ความพร้อม", desktopOnly: true, ownerOnly: true, isActive: (h) => h.startsWith("#/readiness") },
  // 8 พ.ย. 2026 (พี่ง้วง "ทำ dashboard ใน lukprae console ... พี่ง้วงเห็นคนเดียว"): ค่า AI/การใช้งานวันนี้ — finance.view เท่านั้น
  // มือถือเข้าจากลิงก์ใต้การ์ดค่า AI หน้าภาพรวม (แถบล่างเต็มแล้ว)
  { hash: "#/usage", icon: "⚡", label: "Usage", desktopOnly: true, capability: "finance.view", isActive: (h) => h.startsWith("#/usage") },
  { hash: "#/backup", icon: "🔐", label: "สำรอง", desktopOnly: true, capability: "backup.view", isActive: (h) => h.startsWith("#/backup") },
  { hash: "#/settings", icon: "⚙️", label: "ตั้งค่า", isActive: (h) => h.startsWith("#/settings") },
  // 28 ก.ย. 2026 (พี่ง้วงสั่ง): เมนูใหม่ขวาสุด "Intro" — ปิดไว้จนเจ้าของเปิด (features.intro)
  // มือถือเข้าจากการ์ด "จักรวาลลูกแพร" บนหน้าภาพรวม แถบล่างเต็มแล้ว
  { hash: "#/intro", icon: "✨", label: "Intro", desktopOnly: true, feature: "intro", courseOnly: true, isActive: (h) => h.startsWith("#/intro") },
];

// white-label: หน้าที่เป็นของ production course เท่านั้น (รอบเรียน/ที่นั่ง, จักรวาลลูกแพร)
// ร้านทั่วไปไม่เห็นเมนู และเปิดด้วย hash ตรง ๆ ก็ได้หน้า "ไม่มีในแพ็กเกจนี้" (ดู route)
export const COURSE_ONLY_ROUTES = Object.freeze(["#/rounds", "#/intro"]);

function tabIsVisible(tab) {
  return !(tab.courseOnly && isGeneric(state))
    && (!tab.feature || state.features?.[tab.feature] === true)
    && (tab.hash !== "#/review" || state.features?.teach === true || state.features?.jevReview === true)
    && (!tab.capability || state.me?.capabilities?.includes(tab.capability))
    && (!tab.ownerOnly || state.me?.role === "owner");
}

// มือถือ: แถบล่าง 5 ปุ่ม (ซ่อนบนเดสก์ท็อป — เมนูย้ายขึ้น topbar)
function tabBar() {
  const hash = location.hash || "#/";
  return el("nav", { class: "tabbar", "aria-label": "เมนูหลัก" },
  TABS.filter((tab) => !tab.desktopOnly && tabIsVisible(tab)).map((tab) => el("a", {
      class: `tab${tab.isActive(hash) ? " is-active" : ""}${tab.accent ? " is-accent" : ""}`,
      href: tab.hash,
      ...(tab.isActive(hash) ? { "aria-current": "page" } : {}),
    },
      // ไอคอนเส้นชุดใหม่เฉพาะธีมลูกแพร — instance อื่นคงอีโมจิเดิม ไม่เปลี่ยนหน้าตาโดยไม่ได้ขอ (28 ก.ย. 2026)
      el("span", { class: "tab-icon", "aria-hidden": "true" }, (state.branding.theme === "lukprae" && navIcon(tab.hash)) || tab.icon),
      el("span", { class: "tab-label" }, tab.label),
    )),
  );
}

// ตัวอักษรย่อบนป้ายผู้ใช้ — สระหน้า (เ แ โ ใ ไ) ยืนเดี่ยวอ่านไม่ออก จึงพ่วงพยัญชนะตัวถัดไป
function initialOf(name) {
  const chars = Array.from(String(name || "").trim() || "?");
  return /^[เแโใไ]$/u.test(chars[0]) && chars[1] ? `${chars[0]}${chars[1]}` : chars[0];
}

// หัวบน: โลโก้ + เมนู (เดสก์ท็อป) / ชื่อหน้า (มือถือ) + ผู้ใช้ + ออกจากระบบ
function pageHeader(title) {
  const hash = location.hash || "#/";
  return el("header", { class: "topbar" },
    el("a", { class: "brand", href: "#/" },
      el("span", { class: "brand-mark", "aria-hidden": "true" }, state.branding.mark),
      // brand-agent ซ่อนไว้ในธีมตั้งต้น — ธีมลูกแพรโชว์ชื่อผู้ช่วยคู่ชื่อธุรกิจ (instance-theme CSS)
      el("span", { class: "brand-text" },
        el("span", { class: "brand-name" }, state.branding.name),
        state.branding.agent ? el("span", { class: "brand-agent" }, state.branding.agent) : null,
      ),
    ),
    el("nav", { class: "topnav", "aria-label": "เมนูหลัก" },
      TABS.filter(tabIsVisible).map((tab) => el("a", {
        class: `topnav-link${tab.isActive(hash) ? " is-active" : ""}${tab.accent ? " is-accent" : ""}`,
        href: tab.hash,
        ...(tab.isActive(hash) ? { "aria-current": "page" } : {}),
      }, tab.label)),
    ),
    el("h1", { class: "page-title" }, title),
    el("span", { class: "topbar-right" },
      hasDarkOption()
        ? el("button", {
            class: "icon-btn theme-toggle",
            title: state.ui.theme === "dark" ? "เปลี่ยนเป็นธีมสว่าง" : "เปลี่ยนเป็นธีมมืด",
            "aria-label": state.ui.theme === "dark" ? "เปลี่ยนเป็นธีมสว่าง" : "เปลี่ยนเป็นธีมมืด",
            onclick: () => {
              applyUiTheme(state.ui.theme === "dark" ? "light" : "dark", { persist: true });
              route();
            },
          }, (state.branding.theme === "lukprae" && icon(state.ui.theme === "dark" ? "sun" : "moon", { size: 18 }))
            || (state.ui.theme === "dark" ? "☀" : "☾"))
        : null,
      el("span", { class: "me" },
        el("span", { class: "me-initial", "aria-hidden": "true" }, initialOf(state.me?.displayName || state.me?.username)),
        el("span", { class: "me-name" }, state.me?.displayName || state.me?.username || ""),
      ),
      el("button", { class: "btn btn-ghost btn-logout", onclick: logout }, "ออก"),
    ),
  );
}

async function logout() {
  try { await api("/console/api/logout", { method: "POST", body: {} }); } catch { /* เดินต่อ */ }
  location.href = "/console/login";
}

/* ----------------------------- หน้าแยกไฟล์ (page modules) ----------------------------- */

const pageDeps = { api, uploadMedia, toast, mount, pageHeader, tabBar, stopPolling, state, setView, channelName };
const renderOverview = createOverviewPage(pageDeps);
const renderSettings = createSettingsPage(pageDeps);
const renderKnowledge = createKnowledgePage(pageDeps);
const renderKpi = createKpiPage(pageDeps);
const renderRounds = createRoundsPage(pageDeps);
const renderChat = createChatWorkspace(pageDeps);
const renderOrders = createOrdersPage(pageDeps);
const renderBroadcast = createBroadcastPage(pageDeps);
const renderTrainingReview = createTrainingReviewPage(pageDeps);
const renderReview = createReviewPage(pageDeps);
const renderTeach = createTeachPage(pageDeps);
const renderTrainingIntake = createTrainingIntakePage(pageDeps);
const renderReadiness = createReadinessPage(pageDeps);
const renderBackup = createBackupPage(pageDeps);
const renderSoul = createSoulPage(pageDeps);
const renderHistory = createHistoryPage(pageDeps);
const renderLessons = createLessonsPage(pageDeps);
const renderIntro = createIntroPage(pageDeps);
const renderOwnerReview = createOwnerReviewPage(pageDeps);
const renderUsage = createUsagePage(pageDeps);

/* ----------------------------- correction queue ---------------------------- */

function correctionCard(row) {
  // "คำตอบที่ควรเป็น" — แก้ได้ก่อนอนุมัติ (prefill ด้วยคำแก้ของคนถ้ามี)
  const fix = el("textarea", {
    class: "fix-input", rows: "2",
    placeholder: "คำตอบที่ควรเป็น (ไม่บังคับ — บันทึกตอนอนุมัติ)",
  });
  if (row.human_final) fix.value = row.human_final;

  const approveBtn = el("button", { class: "btn btn-primary", onclick: () => decide("approve") }, "อนุมัติ");
  const rejectBtn = el("button", { class: "btn btn-danger", onclick: () => decide("reject") }, "ปัดตก");

  async function decide(action) {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      const body = { action };
      const humanFinal = fix.value.trim();
      if (action === "approve" && humanFinal) body.humanFinal = humanFinal;
      await api(`/console/api/corrections/${encodeURIComponent(row.id)}/decide`, { method: "POST", body });
      toast(action === "approve" ? "อนุมัติเป็นข้อมูลวิเคราะห์ — จะปรากฏในข้อเสนอเรียนรู้รายวัน" : "ปัดตกแล้ว");
      await renderCorrections();
    } catch (err) {
      toast(err.message);
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
    }
  }

  return el("article", { class: "correction-card" },
    el("div", { class: "correction-head" },
      el("a", { class: "correction-customer", href: `#/c/${encodeURIComponent(row.customer_id)}` },
        `ลูกค้า ${String(row.customer_id).slice(-6)} ›`),
      el("time", {}, timeAgo(row.created_at)),
    ),
    el("p", { class: "correction-label" }, "ร่าง AI ที่โดนบล็อก"),
    el("p", { class: "correction-draft" }, row.ai_draft || "—"),
    fix,
    el("div", { class: "correction-actions" }, rejectBtn, approveBtn),
  );
}

export function learningCandidateCard(row, trainingIntake = {}) {
  const intake = row.evidence?.find((item) => item?.type === "training_intake");
  const metadata = intake?.knowledgeMetadata;
  // Generic learning candidates retain their current owner-review controls.
  // Intake proposals need a second publication-readiness gate from the server.
  const intakeCanPublish = !intake || trainingIntake?.canPublish === true;
  const intakeWaitMessage = String(trainingIntake?.message || "รอเปิดความพร้อมก่อนอนุมัติเข้าคลังความรู้");
  const title = el("input", {
    class: "learning-title", value: row.title || "", maxlength: "200",
    "aria-label": "หัวข้อความรู้ที่เสนอ",
  });
  const content = el("textarea", {
    class: "learning-content", rows: "4", maxlength: "20000",
    "aria-label": "เนื้อหาความรู้ที่เสนอ",
  });
  content.value = row.proposed_content || "";
  if (intake) { title.readOnly = true; content.readOnly = true; }
  const riskFlags = Array.isArray(row.riskFlags) ? row.riskFlags : [];
  const conflicts = Array.isArray(row.conflicts) ? row.conflicts : [];
  const editBtn = el("button", {
    class: "btn btn-ghost", disabled: intake && !intakeCanPublish,
    title: intake && !intakeCanPublish ? intakeWaitMessage : "",
    onclick: () => decide("edit"),
  }, intake ? "ตรวจรายการนี้อีกครั้ง" : "บันทึกการแก้");
  const rejectBtn = el("button", { class: "btn btn-danger", onclick: () => decide("reject") }, "ปัดตก");
  const approveBtn = el("button", {
    class: "btn btn-primary",
    disabled: riskFlags.length > 0 || (intake && !intakeCanPublish),
    title: riskFlags.length ? "ข้อมูลเสี่ยงต้องเพิ่มเข้าคลังด้วยคนโดยตรง" : (intake && !intakeCanPublish ? intakeWaitMessage : "อนุมัติให้เข้าคลังความรู้"),
    onclick: () => decide("approve"),
  }, "อนุมัติเข้าความรู้");
  // Set the DOM property too: browsers reflect disabled attributes, while the
  // lightweight console DOM used for regression tests deliberately does not.
  if (intake && !intakeCanPublish) {
    editBtn.disabled = true;
    approveBtn.disabled = true;
  }
  // Require an explicit save/review after editing, so approval cannot silently
  // publish the older server copy while the operator sees different text.
  const hasUnsavedEdits = () => title.value.trim() !== (row.title || "").trim()
    || content.value.trim() !== (row.proposed_content || "").trim();
  const refreshApproval = () => { approveBtn.disabled = riskFlags.length > 0 || (intake && !intakeCanPublish) || hasUnsavedEdits(); };
  title.addEventListener("input", refreshApproval);
  content.addEventListener("input", refreshApproval);

  async function callDecision(action, extra = {}) {
    return api(`/console/api/learning/${encodeURIComponent(row.id)}/decide`, {
      method: "POST",
      body: {
        action,
        ...(action === "edit" ? { title: title.value.trim(), content: content.value.trim() } : {}),
        ...extra,
      },
    });
  }

  async function decide(action) {
    // A disabled DOM control is not an authorization boundary: synthetic
    // events (or a stale UI) can still invoke this handler. Intake proposals
    // must not edit/publish until the server has declared publication ready.
    if (intake && !intakeCanPublish && (action === "edit" || action === "approve")) return;
    for (const button of [editBtn, rejectBtn, approveBtn]) button.disabled = true;
    try {
      await callDecision(action);
      toast(action === "approve" ? "อนุมัติเข้าคลังความรู้แล้ว" : action === "reject" ? "ปัดตกแล้ว" : "บันทึกข้อเสนอแล้ว");
      await renderCorrections();
    } catch (err) {
      if (err.data?.code === "supersede_required" && err.data.conflictId
          && window.confirm("หัวข้อนี้ชนกับความรู้ที่ระบบเคยเรียน ต้องการแทนที่รายการเดิมหรือไม่?")) {
        try {
          await callDecision("supersede", { supersedesId: err.data.conflictId });
          toast("แทนที่ความรู้เดิมแล้ว");
          await renderCorrections();
          return;
        } catch (supersedeError) {
          toast(supersedeError.message);
        }
      } else {
        toast(err.message);
      }
      editBtn.disabled = false;
      rejectBtn.disabled = false;
      refreshApproval();
    }
  }

  return el("article", { class: `learning-card${riskFlags.length ? " is-risky" : ""}` },
    el("div", { class: "learning-card-head" },
      el("span", { class: "learning-kicker" }, intake ? "ข้อเสนอจากข้อมูลที่ทีมนำเข้า — ยังไม่อนุมัติ" : "ข้อเสนอจากคำแก้ที่ทีมอนุมัติแล้ว"),
      el("time", {}, timeAgo(row.created_at)),
    ),
    title,
    content,
    intake ? el("p", { class: "learning-meta" }, "ข้อความที่เสนอถูกล็อกเพื่อรักษาที่มา หากต้องแก้เนื้อหา ให้ปัดตกและเสนอใหม่ผ่านหน้ารับข้อมูล") : null,
    intake && !intakeCanPublish ? el("p", { class: "learning-risk", role: "status" }, `รออนุมัติเข้าคลังความรู้: ${intakeWaitMessage}`) : null,
    el("div", { class: "learning-evidence" },
      el("span", {}, `หลักฐาน ${row.evidence?.length || 0} รายการ`),
      intake ? el("span", { class: "learning-chip" }, intake.origin === "line_oa_curated" ? "ทีมระบุว่าคัดจาก LINE OA" : "ความรู้ที่ทีมคัดแล้ว") : null,
      metadata ? el("span", { class: "learning-chip" }, `${metadata.domain} · ${metadata.offering}`) : null,
      metadata ? el("span", { class: "learning-chip" }, `เลือกใช้ตามคำถาม · คำค้น: ${metadata.keywords?.join(", ") || "ไม่มี"}`) : null,
      row.channel_id ? el("span", { class: "learning-chip" }, `สาขา ${channelName(row.channel_id)}`) : el("span", { class: "learning-chip" }, "สมองกลาง"),
      conflicts.length ? el("span", { class: "learning-chip is-warn" }, `ชนความรู้ ${conflicts.length}`) : null,
    ),
    riskFlags.length
      ? el("div", { class: "learning-risk", role: "alert" },
          el("strong", {}, "ต้องตรวจด้วยคนโดยตรง"),
          el("span", {}, `ระบบกันการอนุมัติอัตโนมัติ: ${riskFlags.join(", ")}`),
        )
      : el("p", { class: "learning-safe" }, "✓ ไม่พบข้อมูลราคา โปร วันที่ ที่นั่ง นโยบาย หรือข้อมูลส่วนบุคคลจากกฎตรวจเบื้องต้น"),
    el("div", { class: "correction-actions learning-actions" }, rejectBtn, editBtn, approveBtn),
  );
}

function learningControl(data) {
  const isOwner = state.me?.role === "owner";
  const latest = data.runs?.[0] || null;
  const effectiveMode = String(latest?.mode || data.mode || "");
  const modeLabel = effectiveMode.startsWith("model_assisted")
    ? "โมเดลช่วยจัดกลุ่ม (ยังต้องให้คนอนุมัติ)"
    : "สำรองแบบ deterministic (ไม่เรียกโมเดล)";
  const toggle = el("button", {
    class: `btn ${data.enabled ? "btn-danger" : "btn-primary"}`,
    disabled: !isOwner,
    onclick: async () => {
      toggle.disabled = true;
      try {
        await api("/console/api/learning/toggle", { method: "POST", body: { enabled: !data.enabled } });
        toast(data.enabled ? "ปิดการสร้างข้อเสนอรายวันแล้ว" : "เปิดการสร้างข้อเสนอรายวันแล้ว");
        await renderCorrections();
      } catch (err) { toast(err.message); toggle.disabled = !isOwner; }
    },
  }, data.enabled ? "ปิดระบบเรียนรู้" : "เปิดระบบเรียนรู้");
  const run = el("button", {
    class: "btn btn-ghost", disabled: !isOwner || !data.enabled,
    onclick: async () => {
      run.disabled = true;
      try {
        const result = await api("/console/api/learning/run", { method: "POST", body: {} });
        toast(result.result?.skipped ? "ไม่มีข้อมูลใหม่ให้ประมวลผล" : `สร้างข้อเสนอใหม่ ${result.result?.candidatesCreated || 0} รายการ`);
        await renderCorrections();
      } catch (err) { toast(err.message); run.disabled = false; }
    },
  }, "ประมวลผลตอนนี้");
  const rollback = el("button", {
    class: "btn btn-ghost learning-rollback", disabled: !isOwner,
    onclick: async () => {
      const confirmation = window.prompt("การย้อนจะปิดเฉพาะความรู้ที่ระบบเรียนใน 7 วันล่าสุด\nพิมพ์ ROLLBACK เพื่อยืนยัน");
      if (confirmation !== "ROLLBACK") return;
      rollback.disabled = true;
      try {
        const result = await api("/console/api/learning/rollback-week", { method: "POST", body: { confirm: confirmation } });
        toast(`ปิดความรู้ที่ระบบเรียน ${result.deactivated || 0} รายการ`);
        await renderCorrections();
      } catch (err) { toast(err.message); rollback.disabled = false; }
    },
  }, "ย้อน 7 วัน");
  const exportProbes = el("button", {
    class: "btn btn-ghost", disabled: !isOwner,
    onclick: async () => {
      exportProbes.disabled = true;
      try {
        const payload = await api("/console/api/learning/probes");
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = `lukprae-learning-probes-${payload.dayKey || "latest"}.json`;
        anchor.click();
        URL.revokeObjectURL(href);
        toast(`ส่งออกคำถามประเมิน ${payload.probes?.length || 0} ข้อแล้ว`);
      } catch (err) { toast(err.message); }
      finally { exportProbes.disabled = !isOwner; }
    },
  }, "ส่งออก Probe");
  return el("section", { class: "learning-control" },
    el("div", { class: "learning-control-copy" },
      el("div", { class: "learning-control-title" },
        el("span", { class: `learning-status ${data.enabled ? "is-on" : "is-off"}` }, data.enabled ? "เปิดอยู่" : "ปิดอยู่"),
        el("h2", {}, "เรียนรู้รายวันแบบคนอนุมัติ"),
      ),
      el("p", {}, "ระบบอ่านเฉพาะคำแก้ที่ทีมอนุมัติแล้ว สร้างเป็นข้อเสนอ และจะไม่เปลี่ยนคลังความรู้จนกว่าคนจะกดอนุมัติ"),
      el("p", { class: "learning-meta" },
        // 1 ก.ย. 2026: เซิร์ฟเวอร์ตัด budgetUsd ออกสำหรับคนที่ไม่มีสิทธิ์เห็นตัวเลขต้นทุน
        // ถ้ายังพิมพ์ต่อจะขึ้น "เพดาน $0.00/วัน" ซึ่งเป็นตัวเลขที่ผิดและชวนเข้าใจผิด
        `${latest ? "รอบล่าสุด" : "โหมดพร้อมใช้"}: ${modeLabel} · `,
        data.budgetUsd != null ? `เพดาน $${Number(data.budgetUsd).toFixed(2)}/วัน · ` : "",
        data.lastRunAt ? `รอบล่าสุด ${timeAgo(data.lastRunAt)}` : "ยังไม่เคยประมวลผล",
      ),
      latest ? el("p", { class: "learning-meta" },
        `KPI รอบล่าสุด: hedge ${(Number(latest.hedge_rate || 0) * 100).toFixed(1)}% · `
        + `คำรับปาก ${Number(latest.promise_notes_per_100 || 0).toFixed(1)}/100 เทิร์น · `
        + `คนแก้ ${Number(latest.operator_override_per_100 || 0).toFixed(1)}/100 เทิร์น · `
        + `probe ${Number(latest.probe_count || 0)} ข้อ`,
      ) : null,
    ),
    el("div", { class: "learning-control-actions" }, run, exportProbes, toggle, rollback),
  );
}

async function renderCorrections() {
  stopPolling();
  const [data, learning] = await Promise.all([
    api("/console/api/corrections?status=candidate"),
    api("/console/api/learning"),
  ]);
  const rows = data.corrections || [];
  const hiddenNoopCount = Number(data.hiddenNoopCount || 0);
  const proposals = (learning.candidates || []).filter((row) => row.status === "proposed");
  mount(
    pageHeader("เรียนรู้และคำแก้"),
    el("main", { class: "page-scroll" },
      el("div", { class: "page-inner correction-list" },
        state.features.trainingIntake ? el("a", { class: "btn btn-primary", href: "#/teach-intake" }, "นำเข้าความรู้จากทีม") : null,
        learningControl(learning),
        el("div", { class: "learning-section-head" },
          el("div", {},
            el("h2", {}, `ข้อเสนอรออนุมัติ ${proposals.length}`),
            el("p", {}, "แก้ข้อความได้ก่อนอนุมัติ รายการเสี่ยงจะถูกบล็อกและต้องเพิ่มผ่านหน้าความรู้ด้วยคน"),
          ),
        ),
        proposals.length
          ? proposals.map((row) => learningCandidateCard(row, learning.trainingIntake || {}))
          : el("div", { class: "learning-empty" }, "ยังไม่มีข้อเสนอเรียนรู้รออนุมัติ"),
        el("div", { class: "learning-section-head correction-queue-head" },
          el("div", {},
            el("h2", {}, `คำแก้รอรีวิว ${rows.length}`),
            el("p", {}, hiddenNoopCount
              ? `ในชุดที่ตรวจ ไม่นับรายการที่ไม่มีคำแก้จริง ${hiddenNoopCount} รายการ — เก็บประวัติไว้ตรวจสอบได้`
              : "อนุมัติคำตอบที่ควรเป็นก่อน แล้วระบบจึงนำไปสร้างข้อเสนอเรียนรู้ในรอบถัดไป"),
          ),
        ),
        rows.length === 0
          ? el("div", { class: "empty-state" },
              emptyArt(),
              el("p", { class: "empty-title" }, "ไม่มีคำแก้รอรีวิว"),
              el("p", { class: "empty-sub" }, "เมื่อระบบกันคำตอบของ AI ไว้ จะมาเข้าคิวให้รีวิวที่นี่"))
          : rows.map(correctionCard),
      ),
    ),
    tabBar(),
  );
  setView("page");
  // ไม่ poll หน้านี้ — operator อาจกำลังพิมพ์คำตอบที่ควรเป็น ห้าม re-render ทับ
}

function renderUnavailable(title, message) {
  stopPolling();
  mount(
    pageHeader(title),
    el("main", { class: "page-scroll" },
      el("div", { class: "page-inner" },
        el("div", { class: "empty-state" },
          emptyArt({ mood: "thinking" }),
          el("p", { class: "empty-title" }, title),
          el("p", { class: "empty-sub" }, message),
        ),
      ),
    ),
    tabBar(),
  );
  setView("page");
}

/* --------------------------------- routing --------------------------------- */

// 28 ก.ย. 2026: waiting/waiting24 = คิวรอตอบ (ชุดเดียวกับหน้าภาพรวม) · spam = ห้องที่ย้ายไปสแปม (ป้าย null)
// 5 ต.ค. 2026: notqualify = ห้องเหลือง "AI off (not qualify)" ที่ตัวกวาดรายชั่วโมงปิด (คีย์ต้องเป็น \w+ ตาม regex ด้านล่าง)
const SEGMENT_ROUTES = new Set(["hot", "warm", "cold", "needs", "aioff", "notqualify", "customer", "mine", "resolved", "waiting", "waiting24", "hotfollow", "spam"]);

// #/teach/<แหล่ง>/<id> — แยกด้วย hash ไม่ใช่ query string เพราะ router ทั้งไฟล์อ่านจาก hash
// (ค่าที่ถอดไม่ออกกลายเป็นค่าว่าง แล้วจอสอนจะขึ้น "เปิดเรื่องนี้ไม่ได้" แทนที่จะพัง)
function teachTarget(hash) {
  const parts = String(hash).split("/");
  const decode = (value) => { try { return decodeURIComponent(value || ""); } catch { return ""; } };
  return { source: decode(parts[2]), ref: decode(parts[3]) };
}

async function route() {
  const gen = ++state.routeGen;
  stopPolling();
  const hash = location.hash || "#/";
  try {
    const convo = hash.match(/^#\/c\/(.+)$/);
    const seg = hash.match(/^#\/chat\/(\w+)$/);
    // #/chat/<คิว>/<ห้อง> — เปิดห้องโดยจำคิวไว้ใน URL (คิวรอตอบ: ทำเสร็จแล้วไปห้องถัดไปเอง ไม่ต้อง back)
    const queued = hash.match(/^#\/chat\/(\w+)\/(.+)$/);
    if (isGeneric(state) && COURSE_ONLY_ROUTES.some((prefix) => hash.startsWith(prefix))) {
      renderUnavailable("ไม่มีในแพ็กเกจนี้", "หน้านี้ไม่ได้เปิดให้ร้านนี้ใช้ — กลับไปที่ภาพรวมได้จากเมนูด้านบน");
    } else if (convo) await renderChat({ customerId: decodeURIComponent(convo[1]), filter: state.inbox.filter });
    else if (queued && SEGMENT_ROUTES.has(queued[1])) await renderChat({ customerId: decodeURIComponent(queued[2]), filter: queued[1] });
    else if (seg && SEGMENT_ROUTES.has(seg[1])) await renderChat({ filter: seg[1] });
    else if (hash.startsWith("#/chat")) await renderChat({});
    else if (hash.startsWith("#/orders")) await renderOrders();
    else if (hash.startsWith("#/broadcast")) state.features.broadcast
      ? await renderBroadcast()
      : renderUnavailable("บรอดแคสยังปิดอยู่", "ระบบจริงปิดการส่งบรอดแคสไว้เพื่อป้องกันการส่งหาลูกค้าโดยไม่ตั้งใจ");
    else if (hash.startsWith("#/corrections")) state.me?.capabilities?.includes("corrections.review")
      ? await renderCorrections()
      : renderUnavailable("ไม่มีสิทธิ์เข้าคิวคำแก้", "บัญชี Staff ใช้งานส่วนงานประจำวันเท่านั้น");
    else if (hash.startsWith("#/owner-review")) state.features.ownerReview
      ? await renderOwnerReview({ tab: ownerReviewTab(hash) })
      : renderUnavailable("ห้องตรวจยังไม่เปิด", "บัญชีนี้ไม่มีสิทธิ์ยืนยันปิดห้องที่ AI เสนอ");
    else if (hash.startsWith("#/review")) (state.features.teach || state.features.jevReview)
      ? await renderReview()
      : renderUnavailable("กล่องตรวจยังไม่เปิด", "ระบบนี้ยังไม่ได้เปิดหน้ากล่องตรวจและจอสอนลูกแพร");
    else if (hash.startsWith("#/teach-intake")) state.features.trainingIntake
      ? await renderTrainingIntake()
      : renderUnavailable("นำเข้าความรู้ยังไม่เปิด", "ระบบนี้ยังไม่ได้เปิดการเสนอความรู้จากทีม");
    else if (hash.startsWith("#/usage")) state.me?.capabilities?.includes("finance.view")
      ? await renderUsage()
      : renderUnavailable("หน้านี้สำหรับเจ้าของ", "ตัวเลขค่า AI และการใช้งานวันนี้ เห็นได้เฉพาะเจ้าของ");
    else if (hash.startsWith("#/readiness")) state.me?.role === "owner"
      ? await renderReadiness()
      : renderUnavailable("ไม่มีสิทธิ์ดูความพร้อม", "หน้านี้สำหรับเจ้าของเพื่อดูสถานะสมองและ LINE OA");
    else if (hash.startsWith("#/teach")) state.features.teach
      ? await renderTeach(teachTarget(hash))
      : renderUnavailable("จอสอนยังไม่เปิด", "ระบบนี้ยังไม่ได้เปิดหน้ากล่องตรวจและจอสอนลูกแพร");
    else if (hash.startsWith("#/training")) state.me?.capabilities?.includes("training.review")
      ? await renderTrainingReview()
      : renderUnavailable("ไม่มีสิทธิ์เข้าเทรนนิ่ง", "เฉพาะ Super Admin รีวิวข้อมูลเทรนนิ่งได้");
    else if (hash.startsWith("#/rounds")) state.features.classRounds
      ? await renderRounds()
      : renderUnavailable("ยังไม่มีข้อมูลรอบเรียน", "ระบบนี้ยังไม่ได้ตั้งไฟล์รอบเรียน จึงไม่มีข้อมูลที่นั่งให้แก้ไข");
    else if (hash.startsWith("#/kpi")) state.me?.capabilities?.includes("knowledge.manage")
      ? await renderKpi()
      : renderUnavailable("ไม่มีสิทธิ์ดูผลงาน", "หน้านี้สรุปผลการทำงานของทีมและ AI — เฉพาะผู้ดูแลระบบ");
    else if (hash.startsWith("#/history")) state.features.chatHistory
      ? await renderHistory()
      : renderUnavailable("ประวัติแชทยังไม่เปิด", "ผู้ดูแลยังไม่ได้เปิดการค้นหาประวัติแชททั้งหมด");
    else if (hash.startsWith("#/lessons")) state.features.lessons
      ? await renderLessons()
      : renderUnavailable("บทเรียนยังไม่เปิด", "ระบบนี้ยังไม่ได้เปิดจอสอนลูกแพร จึงยังสอนจากแผง \"ทำไมตอบแบบนี้\" ไม่ได้");
    else if (hash.startsWith("#/knowledge")) state.me?.capabilities?.includes("knowledge.manage")
      ? await renderKnowledge()
      : renderUnavailable("ไม่มีสิทธิ์แก้คลังความรู้", "บัญชี Staff ดูแลแชท ลูกค้า และออเดอร์ได้ แต่แก้ความรู้ไม่ได้");
    else if (hash.startsWith("#/soul")) state.me?.capabilities?.includes("knowledge.manage")
      ? await renderSoul()
      : renderUnavailable("ไม่มีสิทธิ์ดูตัวตนของ AI", "หน้านี้แสดงตัวตนและวิธีคุยที่ส่งให้โมเดล — สิทธิ์เดียวกับหน้าความรู้");
    else if (hash.startsWith("#/backup")) state.me?.capabilities?.includes("backup.view")
      ? await renderBackup()
      : renderUnavailable("ไม่มีสิทธิ์ดูข้อมูลสำรอง", "เฉพาะ Super Admin ตรวจสถานะ backup และ restore drill ได้");
    else if (hash.startsWith("#/settings")) await renderSettings();
    else if (hash.startsWith("#/intro")) state.features.intro
      ? await renderIntro()
      : renderUnavailable("หน้า Intro ยังไม่เปิด", "พี่ง้วงเปิดได้จากหน้าภาพรวม หัวข้อรายละเอียดสำหรับทีม");
    else await renderOverview(); // #/ (default) = ภาพรวม — หน้าแรกหลัง login
  } catch (err) {
    if (gen === state.routeGen) mount(el("p", { class: "empty" }, `โหลดไม่สำเร็จ: ${err.message}`));
  }
}

async function boot() {
  try {
    const me = await api("/console/api/me");
    state.me = me.operator;
    state.operators = Array.isArray(me.operators) ? me.operators : [];
    state.csrf = me.csrf;
    state.features = {
      broadcast: me.features?.broadcast === true,
      classRounds: me.features?.classRounds === true,
      imageUpload: me.features?.imageUpload === true,
      fileUpload: me.features?.fileUpload === true,
      stickers: me.features?.stickers === true,
      webPush: me.features?.webPush === true,
      teach: me.features?.teach === true,
      jevReview: me.features?.jevReview === true,
      trainingIntake: me.features?.trainingIntake === true,
      chatHistory: me.features?.chatHistory === true,
      lessons: me.features?.lessons === true,
      intro: me.features?.intro === true,
      ownerReview: me.features?.ownerReview === true,
    };
    // ต้องมีกุญแจตั้งแต่ boot เพื่อให้ซ่อมการสมัครที่หลุดได้เอง โดยไม่ต้องรอให้ผู้ใช้
    // เดินไปหน้าตั้งค่าและกดปุ่ม (คนไม่มีทางรู้ว่าต้องกด เพราะไม่มีอะไรบอกว่ามันหลุด)
    state.webPushPublicKey = String(me.webPushPublicKey || "");
    state.introMedia = { video: me.introMedia?.video === true, poster: me.introMedia?.poster === true };
    applyBranding(me.branding);
  } catch {
    return; // 401 ถูกพาไปหน้า login แล้ว
  }
  // W3: โหลดรายการสาขาครั้งเดียวตอน boot — พัง = โหมดสาขาเดียว (ไม่มี chip)
  try {
    const ch = await api("/console/api/channels");
    state.channels = Array.isArray(ch.channels) ? ch.channels : [];
  } catch {
    state.channels = [];
  }
  await refreshExistingWebPushBinding({ api, state });
  window.addEventListener("hashchange", route);
  await route();
}

boot();
