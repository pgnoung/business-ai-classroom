// เส้นคอนโซล GET /console/api/roas/ad-referrals — รายงานรายแอด อ่านอย่างเดียว (คำสั่งพี่ง้วง 6 ต.ค. 2026)
// สิทธิ์เท่าหน้า ROAS (finance.view = เจ้าของ) · แอดมิน/ทีมงานไม่เห็น · ไม่มีเส้นเขียนใด ๆ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { AD_REFERRAL_CAPTURE_KEY } from "../src/adReferral.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { httpRequest, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const PASSWORD = ["ad", "ref", "pass", "123"].join("-");
const SESSION_KEY = ["ad", "ref", "fixture", "0123456789"].join("-");
const PASS_HASH = hashPassword(PASSWORD);
const AD = "120210000000000555";
// DOM จำลองไม่คำนวณ textContent จากลูก — ไล่อ่านเองทั้งต้น
const textOf = (node) => (node?.nodeType === 3 ? node.textContent
  : `${node?.textContent || ""}${(node?.children || []).map(textOf).join(" ")}`);

async function start(t) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: PASS_HASH, displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "boss2", passHash: PASS_HASH, displayName: "แอดมิน", role: "admin" });
  db.createOperator({ username: "chompoo", passHash: PASS_HASH, displayName: "ชมพู่", role: "operator" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY }), db, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

const get = (server, session, path, method = "GET") => httpRequest(server, {
  method, path, headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
});

function seed(db) {
  const at = Date.parse("2026-10-07T10:00:00+07:00");
  db.upsertCustomer("facebook:ad-room", { channelId: "facebook" });
  db.recordAdReferral({
    customerId: "facebook:ad-room", channelId: "facebook", source: "ADS", type: "OPEN_THREAD", adId: AD,
    adTitle: "คลาส AI", eventKind: "message", firstContact: true, referralAt: at,
  });
  // ตัวกวาดปิดเหลือง = CAS + audit ai_off_not_qualified เสมอ (qualifySweep.mjs) — จำลองครบทั้งคู่
  db.setAiEnabled("facebook:ad-room", false, "not_qualified");
  db.raw.prepare("INSERT INTO admin_audit (id, operator, action, target, detail, created_at) VALUES ('nq-1', 'system:qualify', 'ai_off_not_qualified', ?, '', ?)")
    .run("facebook:ad-room", at + 3_600_000);
}

test("เจ้าของ: ได้รายงานรายแอดตามช่วงวันที่ (ขอบวันเวลาไทย) + สถานะสวิตช์เก็บข้อมูล", async (t) => {
  const { app, db } = await start(t);
  seed(db);
  const owner = await login(app.server, "ngoung");
  const res = await get(app.server, owner, "/console/api/roas/ad-referrals?from=2026-10-07&to=2026-10-07");
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.range.from, "2026-10-07");
  assert.equal(res.json.range.to, "2026-10-07");
  assert.equal(res.json.range.sinceMs, Date.parse("2026-10-07T00:00:00+07:00"));
  assert.equal(res.json.range.untilMs, Date.parse("2026-10-08T00:00:00+07:00"));
  assert.equal(res.json.captureMode, "off");
  const row = res.json.report.rows.find((r) => r.adId === AD);
  assert.equal(row.roomsOpened, 1);
  assert.equal(row.notQualified, 1);
  assert.equal(row.adTitle, "คลาส AI");
  // ไม่มี id ลูกค้า/ชื่อ ในคำตอบเลย — รายงานเป็นตัวเลขรวมต่อแอด
  assert.ok(!res.text.includes("facebook:ad-room"));

  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  const outside = await get(app.server, owner, "/console/api/roas/ad-referrals?from=2026-10-08&to=2026-10-09");
  assert.equal(outside.status, 200);
  assert.equal(outside.json.captureMode, "on");
  assert.deepEqual(outside.json.report.rows, []);
});

test("ช่วงเวลาแบบเดียวกับหน้า ROAS: days=N และ date=YYYY-MM-DD ใช้ได้", async (t) => {
  const { app, db } = await start(t);
  seed(db);
  const owner = await login(app.server, "ngoung");
  const one = await get(app.server, owner, "/console/api/roas/ad-referrals?date=2026-10-07");
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.report.totals.roomsOpened, 1);
  const days = await get(app.server, owner, "/console/api/roas/ad-referrals?days=7");
  assert.equal(days.status, 200, days.text);
  assert.ok(days.json.range.untilMs - days.json.range.sinceMs <= 7 * 86_400_000 + 1);
});

test("วันที่ผิดรูป/ไม่มีจริง/กลับหัว/เกิน 92 วัน = 400 · เขียน = 405", async (t) => {
  const { app } = await start(t);
  const owner = await login(app.server, "ngoung");
  // เพดาน 92 วัน: คิวรีรันบน event loop เดียวกับแชทลูกค้า (รีวิว 6 ต.ค.: 365 วัน ~0.5–3 วิ)
  const ok92 = await get(app.server, owner, "/console/api/roas/ad-referrals?from=2026-07-08&to=2026-10-07");
  assert.equal(ok92.status, 200, ok92.text);
  for (const query of ["from=2026-13-01&to=2026-13-02", "from=2026-02-30&to=2026-03-02", "from=2026-10-09&to=2026-10-01",
    "from=2026-07-07&to=2026-10-07", "from=abc&to=2026-10-01", "days=400"]) {
    const res = await get(app.server, owner, `/console/api/roas/ad-referrals?${query}`);
    assert.equal(res.status, 400, query);
  }
  const post = await get(app.server, owner, "/console/api/roas/ad-referrals?days=7", "POST");
  assert.equal(post.status, 405);
});

test("สวิตช์ ad_referral_capture อยู่ในแผงสวิตช์พฤติกรรม: เจ้าของเปิดได้ + audit · แอดมินเปลี่ยนไม่ได้", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "ngoung");
  const post = (session, value) => httpRequest(app.server, {
    method: "POST", path: "/console/api/settings/behavior-switches",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
    body: JSON.stringify({ key: AD_REFERRAL_CAPTURE_KEY, value }),
  });
  const admin = await login(app.server, "boss2");
  assert.equal((await post(admin, "on")).status, 403);
  assert.equal(db.getSetting(AD_REFERRAL_CAPTURE_KEY), null);
  assert.equal((await post(owner, "maybe")).status, 400);
  const on = await post(owner, "on");
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.switches.find((s) => s.key === AD_REFERRAL_CAPTURE_KEY).value, "on");
  const report = await get(app.server, owner, "/console/api/roas/ad-referrals?days=7");
  assert.equal(report.json.captureMode, "on");
  const audit = db.raw.prepare("SELECT detail FROM admin_audit WHERE action = 'behavior_switch' AND target = ?").all(AD_REFERRAL_CAPTURE_KEY);
  assert.deepEqual(audit.map((row) => row.detail), ["off → on"]);
});

test("แอดมินและทีมงาน = 403 (ตัวเลขผลแอดเป็นของเจ้าของ เหมือนหน้า ROAS)", async (t) => {
  const { app, db } = await start(t);
  seed(db);
  for (const username of ["boss2", "chompoo"]) {
    const session = await login(app.server, username);
    const res = await get(app.server, session, "/console/api/roas/ad-referrals?days=7");
    assert.equal(res.status, 403, username);
  }
});

test("หน้า ROAS: กล่องแอดรายตัวเรนเดอร์ได้จากคำตอบจริง (ไม่มี ReferenceError/TypeError)", async (t) => {
  const { app, db } = await start(t);
  seed(db);
  const owner = await login(app.server, "ngoung");
  const res = await get(app.server, owner, "/console/api/roas/ad-referrals?from=2026-10-07&to=2026-10-07");
  installBrowserGlobals(t, { hash: "#/" });
  const { adReferralTable } = await import("../public/console/overviewAdReferrals.mjs");
  const node = adReferralTable(res.json);
  const text = textOf(node);
  assert.ok(text.includes("คลาส AI"));
  assert.ok(text.includes(AD.slice(-6)), "แสดงท้ายเลขแอดให้จับคู่กับ Ads Manager ได้");
  assert.ok(text.includes("ยังไม่ได้เปิดเก็บ"), "สวิตช์ปิดต้องบอกตรง ๆ ว่ายังไม่เก็บข้อมูล");
  const empty = adReferralTable({ ok: true, captureMode: "on", report: { rows: [], totals: { roomsOpened: 0 }, coverage: {} } });
  assert.ok(textOf(empty).includes("ยังไม่มีห้องที่มาจากแอด"));
});

test("แผง ROAS: กล่องแอดรายตัวโหลดเมื่อกดเปิดเท่านั้น และใช้ช่วงวันเดียวกับตัวเลือกของแผง", async (t) => {
  const { app, db } = await start(t);
  seed(db);
  const owner = await login(app.server, "ngoung");
  const roas = await get(app.server, owner, "/console/api/roas?date=2026-10-07");
  assert.equal(roas.status, 200, roas.text);
  installBrowserGlobals(t, { hash: "#/" });
  const { createRoasPanel } = await import("../public/console/overviewRoas.mjs");
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    const res = await get(app.server, owner, path);
    return res.json;
  };
  const panel = createRoasPanel({
    api, rerender() {}, getRoasRange: () => "date:2026-10-07", setRoasRange() {}, panelBroken: () => null,
  })(roas.json);
  const box = panel.querySelectorAll("details").find((node) => textOf(node).includes("แอดตัวไหนพาคนแบบไหนมา"));
  assert.ok(box, "แผง ROAS ต้องมีกล่องรายแอด");
  assert.deepEqual(calls, [], "ยังไม่กดเปิด = ยังไม่ยิงคิวรี");
  box.open = true;
  for (const fn of box.listeners.toggle || []) await fn({});
  assert.deepEqual(calls, ["/console/api/roas/ad-referrals?date=2026-10-07"]);
  assert.ok(textOf(box).includes("คลาส AI"));
});
