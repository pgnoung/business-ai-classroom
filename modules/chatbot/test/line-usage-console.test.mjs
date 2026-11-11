// line-usage-console — เส้นคอนโซล /console/api/line-usage + การ์ด "LINE OA เดือนนี้" (28 ก.ย. 2026)
// สิทธิ์: เจ้าของ+แอดมินเห็นจำนวนข้อความ · ตัวเลขเงิน/ตั้งราคาเฉพาะเจ้าของ · staff ไม่เห็นเลย
// การ์ดเรนเดอร์จริงด้วย DOM จำลองจากรายงานที่เซิร์ฟเวอร์ประกอบจริง (จับ ReferenceError/TypeError ก่อนถึงพี่ง้วง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { capabilitiesForRole } from "../src/operatorRoles.mjs";
import { SEND_PURPOSE } from "../src/lineSendLedger.mjs";
import { buildLineUsageReport } from "../src/lineUsageReport.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const PASSWORD = ["line", "usage", "pass", "123"].join("-");
const SESSION_KEY = ["line", "usage", "fixture", "0123456789"].join("-");
const PASS_HASH = hashPassword(PASSWORD);

async function start(t) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: PASS_HASH, displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "boss2", passHash: PASS_HASH, displayName: "แอดมิน", role: "admin" });
  db.createOperator({ username: "chompoo", passHash: PASS_HASH, displayName: "ชมพู่", role: "operator" });
  const lineFetch = lineFetchStub({ quota: { type: "limited", value: 15000 }, consumption: { totalUsage: 4210 } });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY }), db, logger: silent,
    overrides: { lineFetch, sleep: async () => {} },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, lineFetch };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

const call = (server, session, method, path, body = null, { csrf = true } = {}) => httpRequest(server, {
  method, path,
  headers: { cookie: session.cookie, ...(csrf ? { "x-csrf-token": session.csrf } : {}), ...(body ? { "content-type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : null,
});

test("สิทธิ์: line_usage.view = เจ้าของ + แอดมิน · staff ไม่มี", () => {
  assert.ok(capabilitiesForRole("owner").includes("line_usage.view"));
  assert.ok(capabilitiesForRole("admin").includes("line_usage.view"));
  assert.ok(!capabilitiesForRole("operator").includes("line_usage.view"));
});

test("API: เจ้าของเห็นโควตาสด + ที่มา + ช่องเงิน · แอดมินเห็นเฉพาะจำนวน · staff 403", async (t) => {
  const { app, db } = await start(t);
  // ส่งจริงผ่าน registry ของแอป (ตัวบันทึกเสียบไว้ใน server.mjs) — แจ้งเตือนทีม + ทีมตอบจากคอนโซล
  await app.lineRegistry.forChannel("default").sendBubbles({ to: `U${"1".repeat(32)}`, bubbles: [{ text: "แจ้งทีม" }], purpose: SEND_PURPOSE.teamAlert });
  db.upsertCustomer("U1", { displayName: "คุณลูกค้า" });
  const owner = await login(app.server, "ngoung");
  const sent = await call(app.server, owner, "POST", "/console/api/conversations/U1/reply", { text: "ทีมงานตอบเองค่ะ" });
  assert.equal(sent.status, 200, sent.text);

  const res = await call(app.server, owner, "GET", "/console/api/line-usage");
  assert.equal(res.status, 200, res.text);
  const report = res.json.report;
  assert.equal(report.current, true);
  assert.deepEqual([report.quota.used, report.quota.limit, report.quota.left], [4210, 15000, 10790]);
  const counted = Object.fromEntries(report.system.rows.map((row) => [row.purpose, row.counted]));
  assert.equal(counted.team_alert, 1);
  assert.equal(counted.operator, 1, "ข้อความที่ทีมพิมพ์ในคอนโซล = push นับโควตา ติดป้าย operator");
  assert.equal(res.json.canEditPlan, true);
  assert.equal(report.cost.configured, false);
  assert.deepEqual(res.json.channels, [{ id: "default", name: "default" }]);

  const admin = await login(app.server, "boss2");
  const adminRes = await call(app.server, admin, "GET", "/console/api/line-usage");
  assert.equal(adminRes.status, 200);
  assert.equal(adminRes.json.report.cost, null, "แอดมินไม่เห็นตัวเลขเงิน");
  assert.equal(adminRes.json.canEditPlan, false);

  const staff = await login(app.server, "chompoo");
  const staffRes = await call(app.server, staff, "GET", "/console/api/line-usage");
  assert.equal(staffRes.status, 403);
});

test("API: เดือน/สาขาที่ผิดถูกปฏิเสธ · เดือนก่อนไม่มีโควตาสด (ไม่ยิงถาม LINE)", async (t) => {
  const { app, lineFetch } = await start(t);
  const owner = await login(app.server, "ngoung");
  assert.equal((await call(app.server, owner, "GET", "/console/api/line-usage?month=2026-13")).status, 400);
  assert.equal((await call(app.server, owner, "GET", "/console/api/line-usage?month=2099-01")).status, 400);
  assert.equal((await call(app.server, owner, "GET", "/console/api/line-usage?channel=facebook")).status, 400);
  const d = new Date(Date.now() + 7 * 3_600_000);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const lastKey = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}`;
  const before = lineFetch.quotaCalls.length;
  const res = await call(app.server, owner, "GET", `/console/api/line-usage?month=${lastKey}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.report.current, false);
  assert.equal(res.json.report.quota, null);
  assert.equal(lineFetch.quotaCalls.length, before);
  assert.equal((await call(app.server, owner, "POST", "/console/api/line-usage")).status, 405);
  assert.equal((await call(app.server, owner, "GET", "/console/api/line-usage/nope")).status, 404);
});

test("API ตั้งราคาแพ็กเกจ: เจ้าของ + CSRF เท่านั้น · ตรวจตัวเลข · บันทึก audit · รายงานคิดเงินตามที่กรอก", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "ngoung");
  const plan = { monthlyFeeThb: "1,280", includedMessages: "15000", extraPerMessageThb: "0.1" };
  assert.equal((await call(app.server, owner, "PUT", "/console/api/line-usage/plan", plan, { csrf: false })).status, 403);
  assert.equal((await call(app.server, owner, "PUT", "/console/api/line-usage/plan", { monthlyFeeThb: "-1" })).status, 400);
  const admin = await login(app.server, "boss2");
  assert.equal((await call(app.server, admin, "PUT", "/console/api/line-usage/plan", plan)).status, 403);

  const saved = await call(app.server, owner, "PUT", "/console/api/line-usage/plan", plan);
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.plan, { monthlyFeeThb: 1280, includedMessages: 15000, extraPerMessageThb: 0.1, configured: true });
  assert.equal(db.getSetting("line_plan_monthly_fee_thb"), "1280");
  const audit = db.listAudit(10).find((row) => row.action === "line_plan_update");
  assert.equal(audit.operator, "ngoung");
  assert.match(audit.detail, /monthlyFeeThb=1280/u);

  const res = await call(app.server, owner, "GET", "/console/api/line-usage");
  assert.deepEqual(res.json.report.cost.now, { used: 4210, extraMessages: 0, extraThb: 0, totalThb: 1280 });

  // ล้างราคา = กลับไปแสดงเฉพาะจำนวน
  const cleared = await call(app.server, owner, "PUT", "/console/api/line-usage/plan", { monthlyFeeThb: "", includedMessages: "", extraPerMessageThb: "" });
  assert.equal(cleared.json.plan.configured, false);
});

/* ----------------------------------- การ์ด ----------------------------------- */

const bodyText = (node) => JSON.stringify(node, (key, value) => (key === "parent" ? undefined : value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const NOW = Date.UTC(2026, 8, 28, 7, 0, 0);

function sampleReport({ includeCost = true, plan = null } = {}) {
  const ledgerStart = Date.UTC(2026, 8, 28, 1, 0, 0);
  const row = (method, purpose, requests, extra = {}) => ({
    day: "2026-09-28", channel_id: "default", method, purpose, detail: "", counts_quota: method === "reply" ? 0 : 1,
    sends: requests, requests, recipients: requests, message_objects: requests, first_at: ledgerStart, last_at: ledgerStart, ...extra,
  });
  return buildLineUsageReport({
    nowMs: NOW, monthKey: "2026-09", ledgerStartMs: ledgerStart, includeCost,
    plan: plan || { monthlyFeeThb: null, includedMessages: null, extraPerMessageThb: null, configured: false },
    quotas: [{ channelId: "default", name: "LINE", quota: { type: "limited", value: 15000, totalUsage: 4210, cachedAt: NOW } }],
    ledgerRows: [
      row("push", "team_alert", 12), row("reply", "customer_reply", 40),
      row("push", "customer_reply_fallback", 6, { detail: "reply_rejected", sends: 2 }), row("push", "followup", 20),
    ],
    auditRows: [{ action: "escalate_notify", detail: "complaint — push แจ้งทีม 2/2 คน · พยายาม 2 คน", created_at: Date.UTC(2026, 8, 12, 3) }],
    insightRows: [{ channel_id: "default", date: "20260915", status: "ready", counts_json: JSON.stringify({ broadcast: 2000, chat: 30, apiPush: 700 }), error: "", attempts: 1, last_attempt_at: 0, ready_at: 0 }],
  });
}

async function mountCard(t, { payload, capabilities = ["line_usage.view", "finance.view"], api = async () => ({ ok: true }) } = {}) {
  const { doc } = installBrowserGlobals(t, { hash: "#/" });
  const mod = await import("../public/console/lineUsage.mjs");
  mod.resetLineUsageView();
  let rerenders = 0;
  const toasts = [];
  const panel = mod.createLineUsagePanel({
    api, toast: (m) => toasts.push(m), rerender: () => { rerenders += 1; },
    state: { me: { capabilities }, channel: null },
  });
  const node = panel.panel(payload);
  if (node) doc.body.append(node);
  return { doc, mod, panel, node, rerenders: () => rerenders, toasts };
}

test("การ์ด: ตอบคำถามพี่ง้วงก่อน (โควตาไปไหน) · แยกสองฝั่ง · บอกวันเริ่มนับ · ป้ายนับ/ฟรี", async (t) => {
  const view = await mountCard(t, { payload: { ok: true, report: sampleReport(), channels: [{ id: "default", name: "LINE" }], canEditPlan: true } });
  const text = bodyText(view.doc.body);
  for (const expected of ["LINE OA เดือนนี้", "โควตาไปไหน", "ส่งเข้าทีมงาน", "บรอดแคสต์", "ส่งหาลูกค้า",
    "จากระบบลูกแพร", "จาก LINE OA Manager", "นับตั้งแต่วันที่ 28 ก.ย. 08:00 น.", "ตั้งแต่ 08:00 น.", "ตอบช้าจน reply token หมดอายุ",
    "แชทแอดมินใน OA Manager", "นับโควตา", "ฟรี", "รายวัน (28 วัน)", "ตั้งราคาแพ็กเกจ LINE",
    "ยังไม่ได้กรอกราคาแพ็กเกจ", "ก่อนหน้านั้น แจ้งเตือนทีม"]) {
    assert.ok(text.includes(expected), `ต้องเห็น "${expected}"`);
  }
  const segments = view.doc.querySelectorAll(".lu-seg");
  assert.ok(segments.length >= 3, "แถบแยกสีต้องมีอย่างน้อยทีม/บรอดแคสต์/ลูกค้า");
  assert.ok(view.doc.querySelector(".lu-quota-fill"), "แถบโควตาใช้ transform (CSSOM) ไม่ใช่ style attribute");
});

test("การ์ดของแอดมิน: ไม่มีกล่องเงินและฟอร์มราคา · API พัง = บอกว่าโหลดไม่สำเร็จ ไม่หายเงียบ · ไม่มีสิทธิ์ = ไม่วาด", async (t) => {
  const admin = await mountCard(t, { payload: { ok: true, report: sampleReport({ includeCost: false }), channels: [], canEditPlan: false }, capabilities: ["line_usage.view"] });
  const text = bodyText(admin.doc.body);
  assert.ok(text.includes("โควตาไปไหน"));
  assert.ok(!text.includes("ค่าใช้จ่ายโดยประมาณ"));
  assert.ok(!text.includes("ตั้งราคาแพ็กเกจ LINE"));
  const failed = await mountCard(t, { payload: { __failed: "500 เซิร์ฟเวอร์ขัดข้อง" } });
  assert.ok(bodyText(failed.doc.body).includes("LINE OA เดือนนี้ — โหลดไม่สำเร็จ"));
  const none = await mountCard(t, { payload: null });
  assert.equal(none.node, null);
});

test("การ์ด: เลือกเดือนแล้ววาดใหม่พร้อม query เดือนนั้น · บันทึกราคาส่งตัวเลขจากช่องกรอก", async (t) => {
  const calls = [];
  const api = async (path, options = {}) => { calls.push({ path, options }); return { ok: true, plan: {} }; };
  const plan = { monthlyFeeThb: 1280, includedMessages: 15000, extraPerMessageThb: 0.1, configured: true };
  const view = await mountCard(t, { payload: { ok: true, report: sampleReport({ plan }), channels: [{ id: "default", name: "LINE" }], canEditPlan: true }, api });
  assert.equal(view.panel.query(), "/console/api/line-usage");
  const select = view.doc.querySelector(".lu-month");
  select.value = "2026-08";
  select.dispatch("change");
  assert.equal(view.rerenders(), 1);
  assert.equal(view.panel.query(), "/console/api/line-usage?month=2026-08");
  assert.ok(bodyText(view.doc.body).includes("ประมาณค่าใช้จ่ายเดือนนี้"));
  const inputs = view.doc.querySelectorAll("input");
  assert.equal(inputs.length, 3);
  inputs[2].value = "0.06";
  view.doc.querySelector(".lu-plan").querySelector("button").dispatch("click");
  await flush();
  const put = calls.find((c) => c.options.method === "PUT");
  assert.equal(put.path, "/console/api/line-usage/plan");
  assert.deepEqual(put.options.body, { monthlyFeeThb: "1280", includedMessages: "15000", extraPerMessageThb: "0.06" });
  assert.equal(view.toasts.at(-1), "บันทึกราคาแพ็กเกจ LINE แล้ว");
});

test("หน้าภาพรวม: ยิง /line-usage เฉพาะผู้มีสิทธิ์ และวางการ์ดไว้ในรายละเอียดสำหรับทีม", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/" });
  const { createOverviewPage } = await import("../public/console/overview.mjs");
  for (const [capabilities, expectCall] of [[["operations.use", "line_usage.view"], true], [["operations.use"], false]]) {
    const calls = [];
    const api = async (path) => {
      calls.push(path);
      if (path.startsWith("/console/api/line-usage")) return { ok: true, report: sampleReport({ includeCost: false }), channels: [], canEditPlan: false };
      if (path.startsWith("/console/api/overview/attention")) return { ok: true, waiting: { total: 0, rooms: [] }, hotQuiet: { total: 0, rooms: [] } };
      if (path.startsWith("/console/api/overview")) return { ok: true, stats: {}, orders: null, quota: null, quotas: null, series: [], canary: { enabled: false } };
      return { ok: true };
    };
    await createOverviewPage({
      api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
      pageHeader: (title) => Object.assign(doc.createElement("header"), { textContent: title }),
      tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {},
      state: { me: { username: "u", role: "admin", capabilities }, branding: { theme: "lukprae" }, channels: [], channel: null, routeGen: 0, features: {}, pollTimer: null },
    })();
    assert.equal(calls.some((p) => p.startsWith("/console/api/line-usage")), expectCall, JSON.stringify(capabilities));
    const card = doc.body.querySelector(".lu-card");
    assert.equal(Boolean(card), expectCall);
    if (card) assert.ok(card.closest("details")?.attributes?.id === "ov-team", "การ์ดอยู่ในรายละเอียดสำหรับทีม");
  }
});

test("หน้าภาพรวม: poll ที่ได้รายงานเดิม (ต่างแค่เวลา asOf) ไม่วาดหน้าใหม่ทับ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/" });
  const { createOverviewPage } = await import("../public/console/overview.mjs");
  let asOf = NOW;
  const api = async (path) => {
    if (path.startsWith("/console/api/line-usage")) {
      asOf += 1_000;
      return { ok: true, report: { ...sampleReport({ includeCost: false }), asOf }, channels: [], canEditPlan: false };
    }
    if (path.startsWith("/console/api/overview/attention")) return { ok: true, waiting: { total: 0, rooms: [] }, hotQuiet: { total: 0, rooms: [] } };
    if (path.startsWith("/console/api/overview")) return { ok: true, stats: {}, orders: null, quota: null, quotas: null, series: [], canary: { enabled: false } };
    return { ok: true };
  };
  let mounts = 0;
  const render = createOverviewPage({
    api, toast: () => {},
    mount: (...nodes) => { mounts += 1; doc.body.replaceChildren(...nodes.filter(Boolean)); },
    pageHeader: (title) => Object.assign(doc.createElement("header"), { textContent: title }),
    tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {},
    state: { me: { username: "u", role: "admin", capabilities: ["line_usage.view"] }, branding: { theme: "lukprae" }, channels: [], channel: null, routeGen: 0, features: {}, pollTimer: null },
  });
  await render();
  const page = doc.createElement("main");
  page.className = "page-scroll";
  doc.body.append(page); // poll ตรวจว่ายังอยู่หน้าเดิมด้วย .page-scroll
  await render({ poll: true });
  assert.equal(mounts, 1);
});
