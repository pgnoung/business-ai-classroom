// owner-review-ui — หน้า "ห้องตรวจ" (#/owner-review) เรนเดอร์จริงด้วย DOM จำลอง (12 ต.ค. 2026 ค่ำ)
//   · ไฟล์ใหม่อยู่ใน allowlist ของ /console/static (ขาดตัวเดียว = คอนโซลค้าง "กำลังโหลด...") · ไม่มี innerHTML
//   · เมนู/เส้นทางเปิดตาม features.ownerReview (สิทธิ์ closes.confirm) · การ์ดหน้าภาพรวม peek ไม่ล้างแจ้งเตือน
//   · ปิดแชท = เห็นคำลาจริงก่อนส่ง · ไม่ปิด = ไปต่อทันที + ย้อน/เหตุผล · ลูกค้าพิมพ์ใหม่ = เตือนแล้วโหลดใหม่
// ข้อความลูกค้าทุกบรรทัดเป็นประโยคสังเคราะห์ · ไม่มีการเรียก provider จริง
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { CONSOLE_STATIC_FILE_NAMES } from "../src/consoleStatic.mjs";
import { createConsoleOwnerReviewRoutes } from "../src/consoleOwnerReviewApi.mjs";
import { OWNER_CLOSE_NOTE_WINDOW_MS, createOwnerCloseService } from "../src/ownerCloseService.mjs";
import { bkk, fakeLineRegistry, makeWorld, silentLogger } from "./ownerReviewFixture.mjs";

const CONSOLE_DIR = new URL("../public/console/", import.meta.url);
const read = (name) => readFileSync(new URL(name, CONSOLE_DIR), "utf8");
const NEW_MODULES = ["ownerReview.mjs", "ownerReviewCard.mjs", "ownerReviewSheet.mjs"];
const NOW = Date.now();
// นาฬิกาจริง (ก่อน installBrowserGlobals ห่อ setTimeout แบบ unref) — ใช้รอด่านกดเร็วของแผ่น/การ์ด
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

/* --------------------------------- ตัวช่วย DOM --------------------------------- */

function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (node.nodeType === 3) return String(node.textContent ?? "");
  return (node.children || []).map(textOf).join("");
}

function all(root, predicate, out = []) {
  for (const child of root?.children || []) {
    if (child?.nodeType !== 1) continue;
    if (predicate(child)) out.push(child);
    all(child, predicate, out);
  }
  return out;
}

const hasClass = (node, name) => String(node.className || "").split(/\s+/u).includes(name);
const byClass = (root, name) => all(root, (node) => hasClass(node, name));
const buttons = (root) => all(root, (node) => node.tagName === "button");
function button(root, label) {
  const found = buttons(root).find((node) => textOf(node).includes(label) || String(node.attributes?.["aria-label"] || "").includes(label));
  assert.ok(found, `ต้องมีปุ่ม "${label}"`);
  return found;
}
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
async function click(node) {
  node.dispatch("click", { preventDefault() {}, target: node });
  await flush();
}

/* --------------------------------- ข้อมูลจำลอง --------------------------------- */

function item(id, over = {}) {
  return {
    id, customerId: `U-${id}`, channelId: "default", batchId: "b1", source: "cue_luna", sourceLabel: "เจอคำนอกเรื่อง + AI ยืนยัน",
    category: "ask_money", categoryLabel: "ขอเงิน/ขอยืมเงินจากเรา/ขอบริจาค", cue: "ask_money", reason: "ขอยืมเงินจากเรา ไม่ได้ถามเรื่องคลาส",
    status: "pending", statusLabel: "รอยืนยัน", outcome: "", note: "", baselineInboundId: `in-${id}`, decidedBy: "", decidedAt: null,
    revision: 0, createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000,
    customer: { displayNameMasked: "ส•••ย", channelLabel: "default", aiEnabled: true },
    lastInboundAt: NOW - 600_000, newSinceProposal: false, ...over,
  };
}

const MESSAGES = [
  { id: "m1", direction: "out", speaker: "ลูกแพร", msgType: "text", text: "สวัสดีค่ะ ลูกแพรดูแลคลาสเรียน AI ค่ะ", at: NOW - 9_000_000, proactive: false, afterBaseline: false },
  { id: "m2", direction: "in", speaker: "ลูกค้า", msgType: "text", text: "<img src=x onerror=alert(1)>", at: NOW - 8_000_000, proactive: false, afterBaseline: false },
  { id: "m3", direction: "out", speaker: "ลูกแพร", msgType: "text", text: "สนใจคลาสแบบไหนคะ", at: NOW - 7_000_000, proactive: false, afterBaseline: false },
  { id: "m4", direction: "in", speaker: "ลูกค้า", msgType: "text", text: "ช่วงนี้ลำบากครับ", at: NOW - 6_000_000, proactive: false, afterBaseline: false },
  { id: "m5", direction: "in", speaker: "ลูกค้า", msgType: "text", text: "ขอยืมเงินสักสองพันได้ไหมครับ", at: NOW - 600_000, proactive: false, afterBaseline: false },
];

function detailOf(row, over = {}) {
  return {
    ok: true, proposal: row, latestInboundId: row.baselineInboundId, customerTypedSinceBaseline: false, messages: MESSAGES,
    room: { aiEnabled: true, yellow: false, channelId: "default", channelLabel: "default", facebook: false, fbWindowOpen: null, canSendGoodbye: true },
    goodbyeText: "ลูกแพรขอตัวก่อนนะคะ แชทนี้ดูแลเฉพาะเรื่องคลาสเรียน AI ค่ะ", sweepOn: true, ...over,
  };
}

function summaryOf(over = {}) {
  return {
    ok: true, canConfirm: true, mode: "on", scope: "all", sweepOn: true, offtopicMode: "propose",
    counts: { pending: 2, sendFailed: 0, today: { confirmed: 1, closedSilent: 0, rejected: 2, expired: 0 } },
    lastScan: { slotAt: bkk(12), status: "ready", readyAt: bkk(12, 4), rooms: 23, evaluated: 9, proposed: 2 },
    nextScanAt: bkk(15), scanTimes: ["09:00", "12:00", "15:00", "19:00"], roomCap: 80, costToday: { thb: 3, capThb: 40 },
    inFlight: false, categories: {}, undoMs: 10_000,
    tabs: [{ key: "close", label: "รอยืนยันปิด", count: 2, available: true }, { key: "daily", label: "ตรวจแชทวันนี้", count: 0, available: false }],
    ...over,
  };
}

function apiError(status, data) {
  const error = new Error(data?.error || `เกิดข้อผิดพลาด (${status})`);
  error.status = status;
  error.data = data;
  return error;
}

/**
 * api ปลอมแบบเดียวกับ console.js: GET/POST ตาม path · handlers ใส่ทับได้ทีละเส้น
 * decide/undo/note คืน revision +1 ทุกครั้ง (เหมือน CAS จริง)
 */
function makeApi({ rows = [item("A", { createdAt: NOW - 7_200_000 }), item("B")], summary = summaryOf(), details = {}, decide = null, undo = null, note = null } = {}) {
  const calls = [];
  const revisions = new Map(rows.map((row) => [row.id, row.revision]));
  const bump = (id) => { const next = (revisions.get(id) ?? 0) + 1; revisions.set(id, next); return next; };
  const api = async (path, { method = "GET", body = null } = {}) => {
    calls.push({ path, method, body });
    if (path.startsWith("/console/api/owner-review/summary")) return summary;
    if (path.startsWith("/console/api/owner-review/proposals?")) return { ok: true, view: "open", rows, hasMore: false, nextCursor: null };
    const match = /^\/console\/api\/owner-review\/proposals\/([^/?]+)(?:\/(\w+))?(?:\?.*)?$/u.exec(path);
    if (!match) return { ok: true };
    const [, id, action] = match;
    const row = rows.find((candidate) => candidate.id === id) || item(id);
    if (!action) {
      const custom = details[id];
      return typeof custom === "function" ? custom(calls) : (custom || detailOf(row));
    }
    if (action === "decide") {
      if (decide) return decide(id, body, calls);
      const revision = bump(id);
      if (body.action === "reject") return { ok: true, undoUntil: Date.now() + 10_000, proposal: { ...row, status: "rejected", revision } };
      return { ok: true, sent: body.action === "confirm", closed: true, outcome: "yellow", proposal: { ...row, status: body.action === "confirm" ? "confirmed" : "closed_silent", revision } };
    }
    if (action === "undo") return undo ? undo(id, body, calls) : { ok: true, proposal: { ...row, status: "pending", revision: bump(id) } };
    if (action === "note") return note ? note(id, body, calls) : { ok: true, proposal: { ...row, status: "rejected", note: body.reason, revision: bump(id) } };
    return { ok: true };
  };
  return { api, calls, posts: () => calls.filter((call) => call.method === "POST") };
}

async function renderPage(t, { tab = "close", armMs = 0, ...apiOptions } = {}) {
  const { doc } = installBrowserGlobals(t, { hash: tab === "daily" ? "#/owner-review/daily" : "#/owner-review" });
  const { createOwnerReviewPage } = await import("../public/console/ownerReview.mjs");
  const { el } = await import("../public/console/dom.mjs");
  const stub = makeApi(apiOptions);
  const toasts = [];
  const state = { routeGen: 0, pollTimer: null, features: { ownerReview: true }, me: { username: "chom", role: "operator", capabilities: ["closes.confirm"] } };
  const render = createOwnerReviewPage({
    api: stub.api,
    toast: (message) => toasts.push(String(message)),
    mount: (...nodes) => doc.body.replaceChildren(...nodes.flat(Infinity).filter(Boolean)),
    pageHeader: (title) => el("header", { class: "topbar" }, el("h1", {}, title)),
    tabBar: () => el("nav", { class: "tabbar" }),
    stopPolling: () => { clearTimeout(state.pollTimer); state.pollTimer = null; },
    setView: () => {},
    state,
    armMs, // เทสต์ส่วนใหญ่กดทันที — เทสต์ด่านกดเร็ว (แตะสองที) ส่งค่าเองด้านล่าง
  });
  await render({ tab });
  await flush();
  const body = doc.body;
  return {
    doc, body, toasts, state, ...stub,
    text: () => textOf(body),
    card: () => byClass(body, "orv-card")[0] ?? null,
    sheet: () => byClass(body, "orv-sheet")[0] ?? null,
    undoToast: () => byClass(body, "orv-undo")[0] ?? null,
  };
}

/* ------------------------------ ไฟล์ / allowlist / สิทธิ์ ------------------------------ */

test("ไฟล์หน้าใหม่อยู่ใน allowlist ของ /console/static ครบ และ index.html โหลด css", () => {
  const allow = new Set(CONSOLE_STATIC_FILE_NAMES);
  for (const name of [...NEW_MODULES, "ownerReview.css"]) assert.ok(allow.has(name), `${name} ต้องอยู่ใน STATIC_FILES`);
  assert.match(read("index.html"), /<link rel="stylesheet" href="\/console\/static\/ownerReview\.css">/u);
});

test("ไม่มี innerHTML/insertAdjacentHTML/outerHTML ในไฟล์หน้าใหม่ — ทุกโหนดผ่าน el() · ไฟล์ไม่เกิน 800 บรรทัด", () => {
  for (const name of [...NEW_MODULES, "ownerReview.css"]) {
    const source = read(name);
    assert.doesNotMatch(source, /\.innerHTML|insertAdjacentHTML|\.outerHTML|document\.write/u, name);
    assert.ok(source.split("\n").length <= 800, `${name} ยาวเกิน 800 บรรทัด`);
  }
});

test("console.js: เมนู/เส้นทาง #/owner-review เปิดตาม features.ownerReview (closes.confirm) · แถบล่างมือถือไม่เพิ่มปุ่ม", () => {
  const source = read("console.js");
  assert.match(source, /import \{ createOwnerReviewPage, ownerReviewTab \} from "\.\/ownerReview\.mjs";/u);
  assert.match(source, /lessons: false, intro: false, ownerReview: false \}/u, "ค่าเริ่มต้นต้องปิด");
  assert.match(source, /ownerReview: me\.features\?\.ownerReview === true/u, "boot อ่านจาก /me");
  const tabLine = source.split("\n").find((line) => line.includes('hash: "#/owner-review"'));
  assert.ok(tabLine, "ต้องมีเมนูห้องตรวจ");
  assert.match(tabLine, /desktopOnly: true/u, "มือถือเข้าจากแจ้งเตือน/การ์ดหน้าภาพรวม ไม่เพิ่มปุ่มแถบล่าง");
  assert.match(tabLine, /feature: "ownerReview"/u);
  assert.match(source, /hash\.startsWith\("#\/owner-review"\)\) state\.features\.ownerReview\s*\? await renderOwnerReview/u);
  assert.match(source, /renderUnavailable\("ห้องตรวจยังไม่เปิด"/u, "ไม่มีสิทธิ์ = หน้าบอกว่าไม่เปิด ไม่ยิง API");
  // ลำดับ: #/owner-review ต้องถูกจับก่อน #/review (คนละเส้น แต่กันพลาดตอนแก้ภายหลัง)
  assert.ok(source.indexOf('hash.startsWith("#/owner-review")') < source.indexOf('hash.startsWith("#/review")'));
});

test("การ์ดหน้าภาพรวม: ยิง summary?peek=1 เฉพาะคนที่มีห้องตรวจ · โผล่เฉพาะตอนมีห้องรอ · ลิงก์ไป #/owner-review", async (t) => {
  installBrowserGlobals(t);
  const overview = read("overview.mjs");
  assert.match(overview, /state\.features\?\.ownerReview === true\s*\? api\("\/console\/api\/owner-review\/summary\?peek=1"\)/u);
  const { ownerReviewOverviewCard } = await import("../public/console/ownerReviewCard.mjs");
  assert.equal(ownerReviewOverviewCard(null), null, "ไม่มีสิทธิ์/โหลดไม่ได้ = ไม่มีการ์ด");
  assert.equal(ownerReviewOverviewCard(summaryOf({ counts: { pending: 0, sendFailed: 0, today: {} } })), null, "ไม่มีห้องรอ = หน้าแรกไม่รก");
  const card = ownerReviewOverviewCard(summaryOf({ counts: { pending: 2, sendFailed: 1, today: {} } }));
  assert.equal(card.tagName, "a");
  assert.equal(card.attributes.href, "#/owner-review");
  assert.match(textOf(card), /รอยืนยันปิด 3 ห้อง/u);
});

/* ---------------------------------- เรนเดอร์หน้า ---------------------------------- */

test("ลำดับการ์ด: ส่งคำลาไม่สำเร็จก่อน แล้วรอยืนยันที่เก่าสุดก่อน · กำลังส่ง (confirming) ไม่อยู่ในกอง · แท็บจาก hash", async (t) => {
  installBrowserGlobals(t);
  const { ownerReviewTab, sortDeck } = await import("../public/console/ownerReview.mjs");
  const deck = sortDeck([
    item("new", { createdAt: 300 }), item("old", { createdAt: 100 }), item("busy", { status: "confirming", createdAt: 50 }),
    item("failed", { status: "send_failed", createdAt: 400 }), item("done", { status: "confirmed", createdAt: 10 }),
  ]);
  assert.deepEqual(deck.map((row) => row.id), ["failed", "old", "new"]);
  assert.equal(ownerReviewTab("#/owner-review"), "close");
  assert.equal(ownerReviewTab("#/owner-review/daily"), "daily");
  assert.equal(ownerReviewTab("#/owner-reviewdaily"), "close");
});

test("การ์ดห้อง: ชื่อย่อ · ชิปหมวดสั้น · เหตุผล AI · 3 ข้อความล่าสุด → ดูเพิ่ม = 5 · ข้อความลูกค้าเป็น text node เสมอ · ปุ่มเป็น <button> มี aria-label", async (t) => {
  const page = await renderPage(t);
  const text = page.text();
  assert.match(text, /ส•••ย/u);
  assert.match(text, /ขอเงิน/u);
  assert.match(text, /ขอยืมเงินจากเรา ไม่ได้ถามเรื่องคลาส/u);
  assert.match(text, /1 \/ 2/u, "แถบความคืบหน้า");
  assert.match(text, /LINE/u);
  const card = page.card();
  assert.equal(card.attributes["data-proposal"], "A", "ห้องที่เก่ากว่าขึ้นก่อน");
  assert.equal(byClass(card, "orv-msg").length, 3);
  const more = button(card, "ดูเพิ่ม");
  assert.equal(more.attributes["aria-expanded"], "false");
  await click(more);
  assert.equal(byClass(page.card(), "orv-msg").length, 5);
  // XSS: ข้อความลูกค้าที่หน้าตาเป็น HTML ต้องเป็นตัวหนังสือ ไม่มี <img> เกิดขึ้นจริง
  assert.equal(all(page.body, (node) => node.tagName === "img").length, 0);
  assert.ok(byClass(page.card(), "orv-msg-text").some((node) => textOf(node) === "<img src=x onerror=alert(1)>"));
  assert.equal(button(page.body, "ปิดแชทของ ส•••ย").tagName, "button");
  assert.equal(button(page.body, "ไม่ปิดห้องของ ส•••ย").tagName, "button");
  assert.ok(page.calls.some((call) => call.path === "/console/api/owner-review/summary"), "เปิดหน้า = เห็นแล้ว (ไม่ใช่ peek)");
});

test("ปิดแชท: แผ่นยืนยันโชว์คำลาจริงก่อนส่ง → 'ส่งคำลาและปิด' = POST confirm พร้อม seenMessageId/revision → ห้องถัดไป", async (t) => {
  const page = await renderPage(t, { details: { A: detailOf(item("A"), { latestInboundId: "in-A-latest" }) } });
  const closeBtn = button(page.body, "ปิดแชทของ");
  assert.equal(closeBtn.disabled, false, "โหลดข้อความแล้วปุ่มต้องกดได้");
  await click(closeBtn);
  const sheet = page.sheet();
  assert.ok(sheet, "ต้องมีแผ่นยืนยัน");
  assert.equal(sheet.attributes.role, "dialog");
  assert.equal(sheet.attributes["aria-modal"], "true");
  assert.match(textOf(sheet), /ลูกแพรขอตัวก่อนนะคะ แชทนี้ดูแลเฉพาะเรื่องคลาสเรียน AI ค่ะ/u, "เห็นคำลาที่จะส่งจริง");
  assert.match(textOf(sheet), /ส่งคำลาแล้วย้อนไม่ได้/u);
  assert.equal(page.posts().length, 0, "เปิดแผ่นยังไม่ส่งอะไร");
  await click(button(sheet, "ส่งคำลาและปิด"));
  assert.deepEqual(page.posts().map((call) => [call.path, call.body]), [
    ["/console/api/owner-review/proposals/A/decide", { action: "confirm", seenMessageId: "in-A-latest", revision: 0 }],
  ]);
  assert.equal(page.card().attributes["data-proposal"], "B");
  assert.match(page.text(), /2 \/ 2/u);
  assert.ok(page.toasts.includes("ส่งคำลาแล้ว ห้องเป็นสีเหลือง"));
  assert.ok(page.sheet() === null || hasClass(byClass(page.body, "orv-sheet-layer")[0], "is-closing"), "แผ่นปิดแล้ว");
});

test("ยกเลิกในแผ่น = ไม่ส่งอะไร · ปุ่ม Escape ปิดแผ่น", async (t) => {
  const page = await renderPage(t);
  await click(button(page.body, "ปิดแชทของ"));
  await click(button(page.sheet(), "ยกเลิก"));
  assert.equal(page.posts().length, 0);
  await click(button(page.body, "ปิดแชทของ"));
  page.doc.dispatch("keydown", { key: "Escape", preventDefault() {} });
  await flush();
  assert.equal(page.posts().length, 0);
  assert.ok(byClass(page.body, "orv-sheet-layer").every((layer) => hasClass(layer, "is-closing")), "Escape ปิดแผ่น");
});

test("ไม่ปิด: ไปห้องถัดไปทันที → แถบย้อน · ชิปเหตุผล = POST note ด้วย revision ล่าสุด · ย้อน = POST undo แล้วการ์ดกลับมา", async (t) => {
  const page = await renderPage(t);
  await click(button(page.body, "ไม่ปิดห้องของ"));
  assert.deepEqual(page.posts().map((call) => call.body), [{ action: "reject", revision: 0 }], "ไม่ปิดไม่ต้องส่ง seenMessageId");
  assert.equal(page.card().attributes["data-proposal"], "B", "ไปห้องถัดไปทันที");
  const toastNode = page.undoToast();
  assert.ok(toastNode);
  assert.equal(toastNode.attributes.role, "status");
  assert.match(textOf(toastNode), /ไม่ปิด ส•••ย/u);
  assert.match(textOf(toastNode), /ไม่ถูกเสนอซ้ำ 30 วัน/u);
  const reasons = byClass(toastNode, "orv-undo-reasons")[0];
  assert.equal(reasons.hidden, true, "ชิปเหตุผลซ่อนไว้ — แถบย้อนบรรทัดเดียว ไม่ทับข้อความของห้องถัดไป");
  const why = button(toastNode, "เหตุผล");
  assert.equal(why.attributes["aria-expanded"], "false");
  await click(why);
  assert.equal(reasons.hidden, false);
  assert.equal(why.attributes["aria-expanded"], "true");
  await click(button(toastNode, "เป็นลูกค้าจริง"));
  assert.deepEqual(page.posts().at(-1), { path: "/console/api/owner-review/proposals/A/note", method: "POST", body: { reason: "เป็นลูกค้าจริง", revision: 1 } });
  assert.match(textOf(page.undoToast()), /จำไว้แล้ว: เป็นลูกค้าจริง/u);
  await click(button(page.undoToast(), "ย้อน"));
  assert.deepEqual(page.posts().at(-1), { path: "/console/api/owner-review/proposals/A/undo", method: "POST", body: { revision: 2 } });
  assert.equal(page.card().attributes["data-proposal"], "A", "การ์ดกลับมาเป็นใบบน");
  assert.match(page.text(), /1 \/ 2/u);
});

test("ไม่ปิดแต่บันทึกไม่ผ่าน (เน็ตหลุด) = การ์ดกลับมาพร้อมบอกเหตุ · มีคนตัดสินไปก่อน = ไม่คืนการ์ด", async (t) => {
  let mode = "network";
  const page = await renderPage(t, {
    decide: () => { throw mode === "network" ? new Error("Failed to fetch") : apiError(409, { ok: false, code: "already_decided", error: "ข้อเสนอนี้ถูกตัดสินไปแล้ว — โหลดใหม่เพื่อดูผล" }); },
  });
  await click(button(page.body, "ไม่ปิดห้องของ"));
  assert.equal(page.card().attributes["data-proposal"], "A");
  assert.ok(page.toasts.some((message) => /ไม่สำเร็จ — ห้องกลับมารอแล้ว/u.test(message)));
  mode = "decided";
  await click(button(page.body, "ไม่ปิดห้องของ"));
  assert.equal(page.card().attributes["data-proposal"], "B");
  assert.ok(page.toasts.includes("ข้อเสนอนี้ถูกตัดสินไปแล้ว — โหลดใหม่เพื่อดูผล"));
});

test("ลูกค้าพิมพ์ใหม่ (409 customer_typed): แผ่นปิด · การ์ดเตือน · โหลดข้อความใหม่ · ยืนยันรอบสองใช้จุดอ้างอิง/revision ใหม่", async (t) => {
  let decideCount = 0;
  let detailCount = 0;
  const fresh = item("A", { revision: 1, baselineInboundId: "in-A-new" });
  const page = await renderPage(t, {
    details: {
      A: () => {
        detailCount += 1;
        return detailCount === 1
          ? detailOf(item("A"))
          : detailOf(fresh, { latestInboundId: "in-A-new", customerTypedSinceBaseline: true,
            messages: [...MESSAGES, { id: "m6", direction: "in", speaker: "ลูกค้า", msgType: "text", text: "จริง ๆ อยากถามเรื่องคลาสด้วยครับ", at: NOW, afterBaseline: true }] });
      },
    },
    decide: (id, body) => {
      decideCount += 1;
      if (decideCount === 1) {
        throw apiError(409, { ok: false, code: "customer_typed", error: "ลูกค้าพิมพ์ใหม่ — อ่านข้อความล่าสุดก่อนตัดสินอีกครั้งนะคะ", latestInboundId: "in-A-new", proposal: fresh });
      }
      return { ok: true, sent: true, closed: true, outcome: "yellow", proposal: { ...fresh, status: "confirmed", revision: body.revision + 1 } };
    },
  });
  await click(button(page.body, "ปิดแชทของ"));
  await click(button(page.sheet(), "ส่งคำลาและปิด"));
  assert.match(page.text(), /ลูกค้าเพิ่งพิมพ์ใหม่ — ดูข้อความล่าสุดก่อนนะคะ/u);
  assert.equal(detailCount, 2, "โหลดข้อความของห้องใหม่");
  assert.ok(page.calls.some((call) => call.method === "GET" && call.path === "/console/api/owner-review/proposals/A?since=in-A"),
    "โหลดใหม่บอกข้อความที่คนตรวจเห็น — ข้อความที่ทำให้ 409 ติดป้ายใหม่ถูกบรรทัด");
  assert.match(textOf(page.card()), /จริง ๆ อยากถามเรื่องคลาสด้วยครับ/u);
  assert.ok(byClass(page.card(), "orv-msg-new").length >= 1, "ข้อความใหม่ติดป้าย ใหม่");
  assert.equal(page.card().attributes["data-proposal"], "A", "ยังอยู่ห้องเดิม");
  await click(button(page.body, "ปิดแชทของ"));
  await click(button(page.sheet(), "ส่งคำลาและปิด"));
  assert.deepEqual(page.posts().map((call) => call.body), [
    { action: "confirm", seenMessageId: "in-A", revision: 0 },
    { action: "confirm", seenMessageId: "in-A-new", revision: 1 },
  ]);
  assert.equal(page.card().attributes["data-proposal"], "B");
});

test("ตัวคัดกรองไม่ on: แถบเตือนบนหัว · ปุ่มในแผ่นกดไม่ได้ · ยังไม่ส่งอะไร", async (t) => {
  const page = await renderPage(t, { summary: summaryOf({ sweepOn: false }), details: { A: detailOf(item("A"), { sweepOn: false }) } });
  assert.match(page.text(), /ตอนนี้ยังปิดห้องไม่ได้/u);
  await click(button(page.body, "ปิดแชทของ"));
  const sheet = page.sheet();
  assert.equal(button(sheet, "ส่งคำลาและปิด").disabled, true);
  assert.equal(button(sheet, "ปิดเงียบ").disabled, true);
  await click(button(sheet, "ส่งคำลาและปิด"));
  assert.equal(page.posts().length, 0);
});

test("Facebook เลย 24 ชม.: แผ่นไม่มีปุ่มส่งคำลา บอกเหตุ · ปิดเงียบ = POST silent", async (t) => {
  const fb = item("A", { channelId: "facebook" });
  const page = await renderPage(t, {
    rows: [fb],
    details: { A: detailOf(fb, { room: { aiEnabled: true, yellow: false, channelId: "facebook", channelLabel: "facebook", facebook: true, fbWindowOpen: false, canSendGoodbye: false } }) },
  });
  assert.match(textOf(page.card()), /Facebook/u);
  await click(button(page.body, "ปิดแชทของ"));
  const sheet = page.sheet();
  assert.equal(button(sheet, "ส่งคำลาและปิด").hidden, true);
  assert.match(textOf(sheet), /เลย 24 ชม\./u);
  await click(button(sheet, "ปิดเงียบ"));
  assert.deepEqual(page.posts().map((call) => call.body), [{ action: "silent", seenMessageId: "in-A", revision: 0 }]);
  assert.ok(page.toasts.includes("ปิดเงียบแล้ว ห้องเป็นสีเหลือง"));
  assert.match(page.text(), /ไม่มีห้องรอยืนยัน 🎉/u);
});

test("ส่งคำลาไม่สำเร็จ (502): แผ่นเหลือปิดเงียบ · การ์ดขึ้นสถานะส่งไม่สำเร็จ · ปิดเงียบใช้ revision ใหม่", async (t) => {
  let decideCount = 0;
  const failed = item("A", { status: "send_failed", revision: 2 });
  const page = await renderPage(t, {
    decide: (id, body) => {
      decideCount += 1;
      if (decideCount === 1) throw apiError(502, { ok: false, code: "send_failed", canSilent: true, error: "ส่งคำลาไม่สำเร็จ — ยังไม่ได้ปิดห้อง", proposal: failed });
      return { ok: true, sent: false, closed: true, outcome: "yellow", proposal: { ...failed, status: "closed_silent", revision: 3 } };
    },
  });
  await click(button(page.body, "ปิดแชทของ"));
  await click(button(page.sheet(), "ส่งคำลาและปิด"));
  const sheet = page.sheet();
  assert.match(textOf(sheet), /ส่งคำลาไม่สำเร็จ — ยังไม่ได้ปิดห้อง/u);
  assert.equal(button(sheet, "ส่งคำลาและปิด").hidden, true, "ห้ามส่งซ้ำ");
  assert.match(textOf(page.card()), /ส่งคำลาไม่สำเร็จ/u);
  await click(button(sheet, "ปิดเงียบ"));
  assert.deepEqual(page.posts().at(-1).body, { action: "silent", seenMessageId: "in-A", revision: 2 });
});

test("คิวว่าง: ไม่มีห้องรอยืนยัน 🎉 · รอบถัดไป · ตรวจล่าสุด · ตัวเลขวันนี้ · ไม่มีปุ่มตัดสิน", async (t) => {
  const page = await renderPage(t, { rows: [], summary: summaryOf({ counts: { pending: 0, sendFailed: 0, today: { confirmed: 1, closedSilent: 0, rejected: 2, expired: 0 } } }) });
  const text = page.text();
  assert.match(text, /ไม่มีห้องรอยืนยัน 🎉/u);
  assert.match(text, /รอบถัดไป/u);
  assert.match(text, /15:00/u);
  assert.match(text, /ตรวจล่าสุดรอบ 12:00 · ดู 23 ห้อง · เสนอปิด 2/u);
  assert.match(text, /1ปิดแล้ว/u);
  assert.equal(byClass(page.body, "orv-thumb-btns")[0].hidden, true, "ไม่มีห้อง = ไม่มีปุ่มตัดสิน");
  assert.ok(page.state.pollTimer, "คิวว่าง = ตั้งรอดูรอบใหม่");
});

test("แท็บตรวจแชทวันนี้ (เฟส B): ดึงคิว /daily ไม่ดึงรายการปิดห้อง · ยังไม่มีคิว = บอกตรง ๆ ไม่มีปุ่มตัดสิน · แท็บที่เลือกมี aria-current", async (t) => {
  // รายละเอียดการ์ด/ป้าย/ต้องปรับ อยู่ใน owner-review-daily-ui.test.mjs — ที่นี่ดูแค่ว่าแท็บที่สองไม่ใช่หน้าบอกเวลาเริ่มแล้ว
  const page = await renderPage(t, { tab: "daily" });
  assert.match(page.text(), /ยังไม่มีคิวตรวจแชท/u);
  assert.doesNotMatch(page.text(), /เริ่มคืนพรุ่งนี้ 20:00/u);
  assert.ok(page.calls.some((call) => call.path === "/console/api/owner-review/daily"), "ดึงคิวรอบล่าสุด");
  assert.equal(page.calls.some((call) => call.path.includes("/proposals")), false);
  const current = all(page.body, (node) => node.tagName === "a" && node.attributes["aria-current"] === "page");
  assert.deepEqual(current.map((node) => node.attributes.href), ["#/owner-review/daily"]);
  assert.ok(byClass(page.body, "orv-thumb-btns").every((node) => node.hidden), "ไม่มีห้อง = ไม่มีปุ่มตัดสิน");
});

/* ------------------------------------ API ------------------------------------ */

test("summary?peek=1 (การ์ดหน้าภาพรวม) ไม่ล้างแจ้งเตือน 'รอยืนยันปิด' ของเจ้าของ · เปิดหน้าจริงจึงล้าง", async () => {
  const world = makeWorld({ start: bkk(9, 10) });
  const cleared = [];
  world.db.clearOwnerReviewPushEvents = (username) => { cleared.push(username); return 1; };
  world.db.createOperator({ username: "nok", passHash: "x", role: "owner" });
  const routes = createConsoleOwnerReviewRoutes({ db: world.db, now: () => world.clock.t });
  const call = async (path) => {
    let payload = null;
    const url = new URL(`http://test/console/api/${path}`);
    await routes.handle({ method: "GET" }, {}, url, url.pathname.replace("/console/api/", "").split("/"), {
      username: "nok", operator: world.db.getOperator("nok"), readJson: async () => ({}), requireCsrf: () => true,
      json: (_res, status, json) => { payload = { status, json }; },
    });
    return payload;
  };
  try {
    assert.equal((await call("owner-review/summary?peek=1")).status, 200);
    assert.deepEqual(cleared, []);
    await call("owner-review/summary");
    assert.deepEqual(cleared, ["nok"]);
  } finally {
    world.db.close();
  }
});

test("เติมเหตุ 'ไม่ปิด' (note): เฉพาะคนที่กดเอง ภายใน 10 นาที · ปิดชื่อ/เบอร์ · CAS revision · ย้อนต่อได้ด้วย revision ใหม่ · ผ่าน API ได้", async () => {
  const world = makeWorld({ start: bkk(9, 10) });
  const ROOM = `U${"c3".repeat(16)}`;
  const baseline = world.room(ROOM, { name: "สมชาย ใจดีมาก", turns: [["in", "ขอยืมเงินหน่อยครับ", bkk(9)]] });
  const proposal = world.db.insertOwnerCloseProposal({ customerId: ROOM, source: "cue_luna", category: "ask_money", cue: "ask_money", aiReason: "ขอเงิน", baselineInboundId: baseline });
  const service = createOwnerCloseService({ db: world.db, closer: world.closer, lineRegistry: fakeLineRegistry(), logger: silentLogger, now: () => world.clock.t });
  try {
    const pendingNote = service.note({ proposalId: proposal.id, operator: { username: "chom" }, revision: 0, reason: "เป็นลูกค้าจริง" });
    assert.equal(pendingNote.status, 409, "ยังไม่ได้กดไม่ปิด = เติมเหตุไม่ได้");
    assert.equal(pendingNote.body.code, "not_notable");
    const rejected = await service.decide({ proposalId: proposal.id, action: "reject", operator: { username: "chom" }, revision: 0 });
    assert.equal(rejected.status, 200);
    const revision = rejected.body.proposal.revision;
    assert.equal(service.note({ proposalId: proposal.id, operator: { username: "nok" }, revision, reason: "x" }).body.code, "not_notable", "คนอื่นเติมแทนไม่ได้");
    assert.equal(service.note({ proposalId: proposal.id, operator: { username: "chom" }, revision, reason: "" }).status, 400);
    assert.equal(service.note({ proposalId: proposal.id, operator: { username: "chom" }, revision: revision + 5, reason: "x" }).body.code, "stale_revision");
    const noted = service.note({ proposalId: proposal.id, operator: { username: "chom" }, revision, reason: "สมชาย ใจดีมาก 0812345678 เป็นลูกค้าจริง" });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    assert.equal(noted.body.proposal.status, "rejected");
    assert.equal(noted.body.proposal.revision, revision + 1);
    assert.doesNotMatch(noted.body.proposal.note, /สมชาย ใจดีมาก|0812345678/u, "ปิดชื่อ/เบอร์ก่อนเก็บ");
    assert.match(noted.body.proposal.note, /เป็นลูกค้าจริง/u);
    assert.ok(world.db.listAudit().some((row) => row.action === "owner_close_note" && row.operator === "chom"));
    const undone = service.undo({ proposalId: proposal.id, operator: { username: "chom" }, revision: noted.body.proposal.revision });
    assert.equal(undone.status, 200, "ย้อนด้วย revision หลังเติมเหตุได้");
    // เลยหน้าต่าง 10 นาที = เติมไม่ได้
    const again = await service.decide({ proposalId: proposal.id, action: "reject", operator: { username: "chom" }, revision: undone.body.proposal.revision });
    world.clock.t += OWNER_CLOSE_NOTE_WINDOW_MS + 1;
    assert.equal(service.note({ proposalId: proposal.id, operator: { username: "chom" }, revision: again.body.proposal.revision, reason: "x" }).body.code, "note_expired");

    // เส้น API: POST proposals/:id/note ส่งต่อให้ service (ต้อง CSRF)
    const routes = createConsoleOwnerReviewRoutes({ db: world.db, closeService: service, now: () => world.clock.t });
    world.db.createOperator({ username: "chom", passHash: "x", role: "operator" });
    let payload = null;
    const url = new URL(`http://test/console/api/owner-review/proposals/${proposal.id}/note`);
    await routes.handle({ method: "POST" }, {}, url, url.pathname.replace("/console/api/", "").split("/"), {
      username: "chom", operator: world.db.getOperator("chom"), readJson: async () => ({ reason: "x", revision: 0 }), requireCsrf: () => false,
      json: (_res, status, json) => { payload = { status, json }; },
    });
    assert.equal(payload.status, 403, "ไม่มี CSRF = 403");
    await routes.handle({ method: "POST" }, {}, url, url.pathname.replace("/console/api/", "").split("/"), {
      username: "chom", operator: world.db.getOperator("chom"), readJson: async () => ({ reason: "x", revision: again.body.proposal.revision }), requireCsrf: () => true,
      json: (_res, status, json) => { payload = { status, json }; },
    });
    assert.equal(payload.status, 409);
    assert.equal(payload.json.code, "note_expired");
    assert.equal(payload.json.proposal.status, "rejected", "ตอบพร้อมข้อเสนอฉบับล่าสุด");
  } finally {
    world.db.close();
  }
});

/* ------------------------------ รีวิว 12 ต.ค. ค่ำ: ด่านกดพลาด ------------------------------ */

test("แผ่นยืนยัน: เปิดแล้วโฟกัสหัวแผ่น (ไม่ใช่ปุ่มส่ง) · แตะ/Enter ที่ตามมาก่อนครบเวลาเปิดแผ่น = ไม่ส่ง · ครบแล้วส่งได้ · Enter ค้างถูกกัน", async (t) => {
  const page = await renderPage(t, { armMs: 60 });
  await sleep(80); // การ์ดเพิ่งขึ้นก็มีด่านเดียวกัน
  await click(button(page.body, "ปิดแชทของ"));
  const sheet = page.sheet();
  assert.ok(sheet, "ต้องเปิดแผ่น");
  assert.equal(page.doc.activeElement?.attributes?.id, "orv-sheet-title", "Enter ครั้งที่สองต้องไม่ตกที่ปุ่มส่ง");
  assert.equal(page.doc.activeElement?.attributes?.tabindex, "-1");
  await click(button(sheet, "ส่งคำลาและปิด"));
  await click(button(sheet, "ปิดเงียบ"));
  assert.equal(page.posts().length, 0, "แตะสองที/กด Enter สองทีจากปุ่มปิดแชท ห้ามส่งคำลาหรือปิดเงียบ");
  let prevented = false;
  button(sheet, "ส่งคำลาและปิด").dispatch("keydown", { key: "Enter", repeat: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "Enter ค้าง (key repeat) ไม่กลายเป็นคลิก");
  await sleep(80);
  await click(button(sheet, "ส่งคำลาและปิด"));
  assert.deepEqual(page.posts().map((call) => call.body.action), ["confirm"]);
  assert.equal(page.card().attributes["data-proposal"], "B");
  assert.ok(hasClass(page.doc.activeElement, "orv-name"), "หลังส่ง โฟกัสชื่อห้องใหม่ ไม่ใช่ปุ่มปิดแชท");
});

test("การ์ดเพิ่งขึ้น: แตะ 'ไม่ปิด' สองทีติดกัน = ตัดสินห้องเดียว (ห้องถัดไปที่ยังไม่เห็นไม่โดน)", async (t) => {
  const page = await renderPage(t, { armMs: 60 });
  await sleep(80);
  const keep = button(page.body, "ไม่ปิดห้องของ");
  await click(keep);
  await click(button(page.body, "ไม่ปิดห้องของ"));
  assert.deepEqual(page.posts().map((call) => call.path), ["/console/api/owner-review/proposals/A/decide"]);
  assert.equal(page.card().attributes["data-proposal"], "B");
});

test("แถบย้อนอยู่ในแถบปุ่มล่าง (ไม่ลอยทับการ์ด/แผ่น) · ย้อนห้องก่อนระหว่างแผ่นปิดห้องถัดไปเปิดอยู่/กำลังส่ง = ไม่ทำอะไร", async (t) => {
  let release = null;
  const page = await renderPage(t, {
    rows: [item("A", { createdAt: NOW - 7_200_000 }), item("B"), item("C")],
    decide: (id, body) => {
      if (body.action === "reject") return { ok: true, proposal: { ...item(id), status: "rejected", revision: 1 } };
      return new Promise((resolve) => { release = () => resolve({ ok: true, sent: true, closed: true, outcome: "yellow", proposal: { ...item(id), status: "confirmed", revision: 1 } }); });
    },
  });
  await click(button(page.body, "ไม่ปิดห้องของ"));
  const toastNode = page.undoToast();
  let parent = toastNode.parent;
  while (parent && !hasClass(parent, "orv-thumb")) parent = parent.parent;
  assert.ok(parent, "แถบย้อนอยู่ใน .orv-thumb (ในโฟลว์) — เลื่อนการ์ดขึ้นมาอ่านเหนือแถบได้");
  assert.equal(page.card().attributes["data-proposal"], "B");
  await click(button(page.body, "ปิดแชทของ"));
  await click(button(toastNode, "ย้อน"));
  assert.equal(page.posts().filter((call) => call.path.endsWith("/undo")).length, 0, "แผ่นเปิดอยู่ = ย้อนไม่ได้");
  assert.equal(page.card().attributes["data-proposal"], "B");
  await click(button(page.sheet(), "ส่งคำลาและปิด"));
  assert.ok(release, "กำลังส่ง");
  await click(button(toastNode, "ย้อน"));
  assert.equal(page.posts().filter((call) => call.path.endsWith("/undo")).length, 0, "กำลังส่ง = ย้อนไม่ได้ (การ์ดที่คืนมาจะถูกพาออกไปกับผลของห้อง B)");
  release();
  await flush();
  assert.equal(page.card().attributes["data-proposal"], "C");
  assert.ok(page.toasts.includes("ส่งคำลาแล้ว ห้องเป็นสีเหลือง"));
});

test("ระหว่างกำลังส่ง: แตะฉากหลัง/Escape ไม่ปิดแผ่น (ผลผิดพลาดต้องเห็น) · ผลผิดพลาดหลังแผ่นหายไปแล้ว = toast", async (t) => {
  let reject = null;
  const page = await renderPage(t, {
    decide: () => new Promise((_resolve, fail) => { reject = fail; }),
  });
  await click(button(page.body, "ปิดแชทของ"));
  await click(button(page.sheet(), "ส่งคำลาและปิด"));
  page.doc.dispatch("keydown", { key: "Escape", preventDefault() {} });
  byClass(page.body, "orv-scrim")[0].dispatch("click", {});
  await flush();
  const layer = byClass(page.body, "orv-sheet-layer")[0];
  assert.ok(layer && !hasClass(layer, "is-closing"), "แผ่นยังเปิด");
  reject(apiError(502, { ok: false, code: "close_failed", error: "ปิดห้องเป็นสีเหลืองไม่สำเร็จ — ยังไม่ได้ส่งอะไรถึงลูกค้า" }));
  await flush();
  assert.match(textOf(page.sheet()), /ปิดห้องเป็นสีเหลืองไม่สำเร็จ/u, "ผลผิดพลาดอยู่ในแผ่น");

  // หน่วยของแผ่น: ถูกปิดจากข้างนอก (เปลี่ยนหน้า) ระหว่างรอ → ผลผิดพลาดไปที่ toast ทั่วไป
  const { createCloseSheet } = await import("../public/console/ownerReviewSheet.mjs");
  const { el } = await import("../public/console/dom.mjs");
  const host = el("div", {});
  const detached = [];
  const sheet = createCloseSheet({ host, armMs: 0, onDetachedFail: (message) => detached.push(message) });
  let ctlRef = null;
  const ctl = sheet.open({ name: "ส•••ย", goodbyeText: "ลาก่อนค่ะ", onSend: async (c) => { ctlRef = c; }, onSilent: async () => {} });
  sheet.close({ restore: false });
  ctl.fail("ส่งคำลาไม่สำเร็จ");
  assert.deepEqual(detached, ["ส่งคำลาไม่สำเร็จ"]);
  void ctlRef;
});

test("ลูกค้าพิมพ์แทรกระหว่างส่งคำลา (customerTypedDuringSend) = บอกว่าห้องเหลืองแล้ว ระบบอ่านข้อความใหม่ให้เอง", async (t) => {
  const page = await renderPage(t, {
    decide: (id) => ({ ok: true, sent: true, closed: true, outcome: "yellow:customer_typed_during_send", customerTypedDuringSend: true, proposal: { ...item(id), status: "confirmed", revision: 1 } }),
  });
  await click(button(page.body, "ปิดแชทของ"));
  await click(button(page.sheet(), "ส่งคำลาและปิด"));
  assert.ok(page.toasts.some((message) => /ห้องเป็นสีเหลือง · ลูกค้าพิมพ์เข้ามาระหว่างส่ง/u.test(message)));
});

test("staff เห็นไม่ครบทุกช่องทาง = แถบบอกช่องทางที่มองไม่เห็น", async (t) => {
  const page = await renderPage(t, { summary: summaryOf({ channelScope: { limited: true, hidden: ["Facebook"] } }) });
  assert.match(page.text(), /บัญชีนี้เห็นไม่ครบทุกช่องทาง/u);
  assert.match(page.text(), /ห้องของ Facebook ไม่อยู่ในสิทธิ์ของบัญชีนี้/u);
});

test("CSS: แถบย้อนไม่ลอย (ไม่ fixed/ไม่ z-toast) · ใบถัดไปโผล่เหนือขอบบน (ไม่ใช่ใต้แถบปุ่ม) · โมชันเฉพาะ transform/opacity", () => {
  const css = read("ownerReview.css");
  const undoBlock = /\.orv-undo \{[^}]*\}/u.exec(css)?.[0] || "";
  assert.ok(undoBlock, "มีบล็อก .orv-undo");
  assert.doesNotMatch(undoBlock, /position:\s*fixed|z-toast/u);
  assert.match(css, /\.orv-stack::before \{ top: \d+px;/u);
  assert.doesNotMatch(css, /\.orv-stack::before \{ bottom:/u);
  for (const match of css.matchAll(/transition:\s*([^;]+);/gu)) {
    for (const part of match[1].split(/,(?![^(]*\))/u)) {
      const prop = part.trim().split(/\s+/u)[0];
      assert.ok(["transform", "opacity", "background-color", "color", "border-color", "box-shadow", "none"].includes(prop), `transition ${prop}`);
    }
  }
});
