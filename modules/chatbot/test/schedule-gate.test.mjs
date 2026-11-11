// Schedule Gate — เวลาทำการของบอท: คณิตช่วงเวลา (Bangkok, ข้ามคืนได้), ลำดับความสำคัญ
// ใน pipeline (takeover > operator-pause > schedule), ack ครั้งเดียวต่อช่วงปิด + ผ่าน guard,
// เส้นทางฉุกเฉิน bypass, inbound ยังถูก log ครบ, console API (CSRF/validate/audit)
// (ทุกอย่าง mock — ห้ามแตะ network จริง; fixture เวลาอิง "ตอนนี้" ห้าม hardcode วันที่)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { bangkokDayStartMs } from "../src/db.mjs";
import {
  parseActiveHours, inActiveWindow, offWindowStartMs, scheduleState,
  SCHEDULE_ENABLED_KEY, SCHEDULE_HOURS_KEY, SCHEDULE_ACK_KEY,
} from "../src/scheduleGate.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen, signLine, sleep, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/* ------------------------------ window math (unit) ------------------------------ */

test("parseActiveHours: รูปแบบถูก/ผิด + start==end ถือว่าใช้ไม่ได้", () => {
  assert.deepEqual(parseActiveHours("09:00-18:00"), { startMin: 540, endMin: 1080 });
  assert.deepEqual(parseActiveHours("20:00-08:00"), { startMin: 1200, endMin: 480 });
  assert.deepEqual(parseActiveHours("  09:30-21:45  "), { startMin: 570, endMin: 1305 }, "trim ได้");
  for (const bad of ["", "9:00-18:00", "09.00-18.00", "25:00-18:00", "09:60-18:00", "09:00", "09:00-18:00-20:00", "09:00-09:00", null, undefined]) {
    assert.equal(parseActiveHours(bad), null, `ต้อง null: ${bad}`);
  }
});

test("inActiveWindow: ช่วงปกติ — start รวม, end ไม่รวม (อิงเที่ยงคืนไทยของวันนี้)", () => {
  const dayStart = bangkokDayStartMs(Date.now());
  const at = (h, m = 0) => dayStart + h * HOUR_MS + m * MIN_MS;
  const w = parseActiveHours("09:00-18:00");
  assert.equal(inActiveWindow(at(9), w), true, "ขอบ start ต้องนับว่าเปิด");
  assert.equal(inActiveWindow(at(17, 59), w), true);
  assert.equal(inActiveWindow(at(18), w), false, "ขอบ end ต้องนับว่าปิดแล้ว");
  assert.equal(inActiveWindow(at(8, 59), w), false);
  assert.equal(inActiveWindow(at(23), w), false);
});

test("inActiveWindow: ช่วงข้ามคืน 20:00-08:00 — กลางคืนเปิด กลางวันปิด", () => {
  const dayStart = bangkokDayStartMs(Date.now());
  const at = (h, m = 0) => dayStart + h * HOUR_MS + m * MIN_MS;
  const w = parseActiveHours("20:00-08:00");
  assert.equal(inActiveWindow(at(21), w), true);
  assert.equal(inActiveWindow(at(3), w), true, "หลังเที่ยงคืนยังอยู่ในช่วง");
  assert.equal(inActiveWindow(at(20), w), true, "ขอบ start รวม");
  assert.equal(inActiveWindow(at(8), w), false, "ขอบ end ไม่รวม");
  assert.equal(inActiveWindow(at(12), w), false);
});

test("offWindowStartMs: จุดเริ่มช่วงปิดถูกต้องทั้งช่วงปกติ/ข้ามคืน — ในเวลาทำการ = null", () => {
  const dayStart = bangkokDayStartMs(Date.now());
  const at = (h, m = 0) => dayStart + h * HOUR_MS + m * MIN_MS;
  const w = parseActiveHours("09:00-18:00");
  assert.equal(offWindowStartMs(at(20), w), at(18), "หลังเลิก = ช่วงปิดเริ่มที่ 18:00 วันนี้");
  assert.equal(offWindowStartMs(at(7), w), at(18) - DAY_MS, "ก่อนเปิด = ช่วงปิดเริ่มตั้งแต่ 18:00 เมื่อวาน");
  assert.equal(offWindowStartMs(at(12), w), null, "ในเวลาทำการ = null");
  const overnight = parseActiveHours("20:00-08:00");
  assert.equal(offWindowStartMs(at(12), overnight), at(8), "ข้ามคืน: ช่วงปิดเริ่มที่ 08:00 วันเดียวกัน");
  assert.equal(offWindowStartMs(at(23), overnight), null);
});

test("scheduleState: default ปิด, เปิดแต่ hours พัง = gate ไม่ทำงาน, DB พัง = gate ปิด (บอทตอบปกติ)", () => {
  const db = memoryDb();
  assert.deepEqual(scheduleState({ db }).enabled, false, "ไม่มี settings = ปิด");
  db.setSetting(SCHEDULE_ENABLED_KEY, "1");
  assert.equal(scheduleState({ db }).enabled, false, "เปิดสวิตช์แต่ไม่มี hours = gate ไม่ทำงาน");
  db.setSetting(SCHEDULE_HOURS_KEY, "ผิดรูปแบบ");
  assert.equal(scheduleState({ db }).enabled, false);
  db.setSetting(SCHEDULE_HOURS_KEY, "09:00-18:00");
  assert.equal(scheduleState({ db }).enabled, true);
  db.close();
  const broken = { getSetting() { throw new Error("db down"); } };
  const state = scheduleState({ db: broken });
  assert.deepEqual({ enabled: state.enabled, active: state.active }, { enabled: false, active: true });
});

/* --------------------------- pipeline integration --------------------------- */

// สร้างสตริง "HH:MM-HH:MM" อิงนาทีปัจจุบันเวลาไทย — offsetStartMin นาทีจากตอนนี้
function windowFromNow(offsetStartMin, lengthMin, nowMs = Date.now()) {
  const minute = Math.floor(((nowMs + 7 * HOUR_MS) % DAY_MS) / MIN_MS);
  const start = (((minute + offsetStartMin) % 1440) + 1440) % 1440;
  const end = (start + lengthMin) % 1440;
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return `${fmt(start)}-${fmt(end)}`;
}
const WINDOW_EXCLUDES_NOW = () => windowFromNow(180, 120); // เปิดอีก 3 ชม.ข้างหน้า — ตอนนี้ปิดแน่นอน
const WINDOW_INCLUDES_NOW = () => windowFromNow(-60, 120); // เปิดมาแล้ว 1 ชม. — ตอนนี้เปิดแน่นอน

function makeApp({ configOverrides = {}, hermesFetch, lineFetch } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetch ?? lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} },
    logger: silent,
  });
  return { app, db, config, hermesFetch: hermes, lineFetch: line };
}

function armSchedule(db, { hours, ack = "" } = {}) {
  db.setSetting(SCHEDULE_ENABLED_KEY, "1");
  db.setSetting(SCHEDULE_HOURS_KEY, hours);
  if (ack) db.setSetting(SCHEDULE_ACK_KEY, ack);
}

test("นอกเวลาทำการ: suppressed schedule_off ไม่มีอะไรออกถึงลูกค้า / ในเวลา: ตอบปกติ", async () => {
  const off = makeApp();
  armSchedule(off.db, { hours: WINDOW_EXCLUDES_NOW() });
  const suppressed = await off.app.pipeline.handleInboundText({ customerId: "U-off", text: "สวัสดีค่ะ", replyToken: "rt" });
  assert.equal(suppressed.suppressed, "schedule_off");
  assert.equal(off.lineFetch.sends.length, 0, "ห้ามมีข้อความ/loading ออกนอกเวลา");
  off.db.close();

  const on = makeApp();
  armSchedule(on.db, { hours: WINDOW_INCLUDES_NOW() });
  const sent = await on.app.pipeline.handleInboundText({ customerId: "U-on", text: "สวัสดีค่ะ", replyToken: "rt" });
  assert.equal(sent.sent, true, "ในเวลาทำการต้องตอบปกติ");
  on.db.close();
});

test("เส้นทางฉุกเฉิน (template+escalate) ยังยิงตามปกติแม้นอกเวลา — ธง NEEDS_HUMAN ติด", async () => {
  const { app, db, lineFetch } = makeApp();
  armSchedule(db, { hours: WINDOW_EXCLUDES_NOW() });
  const result = await app.pipeline.handleInboundText({ customerId: "U-urgent", text: "หายใจไม่ออกมากค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true, "เคสฉุกเฉินห้ามเงียบ");
  assert.equal(result.deterministic, true);
  assert.ok(lineFetch.sends.length >= 1);
  assert.equal(db.getCustomer("U-urgent").state, "NEEDS_HUMAN");
  db.close();
});

test("ลำดับความสำคัญ: AI ปิด (takeover) และ operator-pause ชนะ schedule เสมอ", async () => {
  const { app, db } = makeApp();
  armSchedule(db, { hours: WINDOW_EXCLUDES_NOW() });

  db.upsertCustomer("U-ai-off", {});
  db.setAiEnabled("U-ai-off", false);
  const aiOff = await app.pipeline.respondToBurst({ customerId: "U-ai-off", text: "สวัสดี", replyToken: "" });
  assert.equal(aiOff.suppressed, "ai_disabled", "takeover ต้องรายงานก่อน schedule");

  db.upsertCustomer("U-op", {});
  db.setOperatorActiveUntil("U-op", Date.now() + 60_000);
  const opActive = await app.pipeline.respondToBurst({ customerId: "U-op", text: "สวัสดี", replyToken: "" });
  assert.equal(opActive.suppressed, "operator_active", "operator-pause ต้องรายงานก่อน schedule");
  db.close();
});

test("ack อัตโนมัติ: ส่งครั้งเดียวต่อลูกค้าต่อช่วงปิด + log ลง DB — ช่วงปิดใหม่ส่งได้อีกครั้ง", async () => {
  const ACK = "ตอนนี้นอกเวลาทำการนะคะ ทีมงานจะรีบตอบช่วงเช้าค่ะ";
  const { app, db, lineFetch } = makeApp();
  armSchedule(db, { hours: WINDOW_EXCLUDES_NOW(), ack: ACK });

  const first = await app.pipeline.handleInboundText({ customerId: "U-ack", text: "สนใจสินค้าค่ะ", replyToken: "rt1" });
  assert.equal(first.suppressed, "schedule_off");
  assert.equal(lineFetch.sends.length, 1, "ข้อความแรกของช่วงปิด = ได้ ack 1 ครั้ง");

  const second = await app.pipeline.handleInboundText({ customerId: "U-ack", text: "ยังอยู่ไหมคะ", replyToken: "rt2" });
  assert.equal(second.suppressed, "schedule_off");
  assert.equal(lineFetch.sends.length, 1, "ช่วงปิดเดิมห้ามส่ง ack ซ้ำ");

  const outbound = db.messagesFor("U-ack").filter((m) => m.direction === "out");
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].content, ACK);
  assert.equal(outbound[0].agent_mode, "ai");

  // เปลี่ยนช่วงเวลาทำการ -> จุดเริ่มช่วงปิดเปลี่ยน = ช่วงปิดใหม่ -> ack ได้อีกครั้ง
  db.setSetting(SCHEDULE_HOURS_KEY, windowFromNow(240, 120));
  const third = await app.pipeline.handleInboundText({ customerId: "U-ack", text: "เช็คอีกรอบค่ะ", replyToken: "rt3" });
  assert.equal(third.suppressed, "schedule_off");
  assert.equal(lineFetch.sends.length, 2, "ช่วงปิดใหม่ = ack ใหม่ได้ 1 ครั้ง");
  db.close();
});

test("ack template ไม่ผ่าน compliance guard (คำต้องห้าม/ตัวเลขนอกตาราง) = ไม่ส่งอะไรเลย", async () => {
  const { app, db, lineFetch } = makeApp();
  armSchedule(db, { hours: WINDOW_EXCLUDES_NOW(), ack: "ปิดร้านแล้วค่ะ สินค้าเราหายขาดทุกเคส" });
  const result = await app.pipeline.handleInboundText({ customerId: "U-guard", text: "สวัสดีค่ะ", replyToken: "rt" });
  assert.equal(result.suppressed, "schedule_off");
  assert.equal(lineFetch.sends.length, 0, "template ที่ guard บล็อกห้ามหลุดถึงลูกค้า");
  assert.equal(db.messagesFor("U-guard").filter((m) => m.direction === "out").length, 0);
  db.close();
});

test("นอกเวลาทำการ: ข้อความลูกค้าผ่าน webhook ยังถูก log ครบ (แค่ไม่ตอบ)", async (t) => {
  const { app, db, config, lineFetch } = makeApp();
  armSchedule(db, { hours: WINDOW_EXCLUDES_NOW() });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });

  const raw = JSON.stringify({
    events: [{
      type: "message", replyToken: "rt",
      source: { userId: "U-log" },
      message: { id: "msg-log-1", type: "text", text: "ทักนอกเวลาค่ะ" },
    }],
  });
  const res = await httpRequest(app.server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, config.lineChannelSecret) },
    body: raw,
  });
  assert.equal(res.status, 200);

  const row = await waitFor(() => db.messagesFor("U-log").find((m) => m.direction === "in"));
  assert.equal(row.content, "ทักนอกเวลาค่ะ", "inbound ต้องถูกบันทึกเสมอแม้บอทพัก");
  await sleep(30); // ให้ pipeline วิ่งจบ — ต้องไม่มีอะไรออก
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(db.messagesFor("U-log").filter((m) => m.direction === "out").length, 0);
});

/* ------------------------------ console API ------------------------------ */

const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db };
}

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server) {
  const res = await postJson(server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(res.status, 200);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

test("settings/schedule: GET default = ปิดหมด, POST บันทึกครบ + audit + activeNow ตอบตามจริง", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const before = await httpRequest(app.server, { path: "/console/api/settings/schedule", headers: { cookie } });
  assert.deepEqual(
    { enabled: before.json.enabled, activeHours: before.json.activeHours, ackTemplate: before.json.ackTemplate, valid: before.json.valid, activeNow: before.json.activeNow },
    { enabled: false, activeHours: "", ackTemplate: "", valid: false, activeNow: null },
  );

  const hours = WINDOW_INCLUDES_NOW();
  const saved = await postJson(app.server, "/console/api/settings/schedule",
    { enabled: true, activeHours: hours, ackTemplate: "นอกเวลาทำการค่ะ เดี๋ยวทีมรีบตอบนะคะ" }, headers);
  assert.equal(saved.status, 200);
  assert.deepEqual(
    { enabled: saved.json.enabled, activeHours: saved.json.activeHours, valid: saved.json.valid, activeNow: saved.json.activeNow },
    { enabled: true, activeHours: hours, valid: true, activeNow: true },
  );
  const audit = db.listAudit().find((a) => a.action === "schedule_config");
  assert.equal(audit.operator, "nok");
  assert.ok(audit.detail.includes("enabled=on"));
  assert.ok(audit.detail.includes(hours));

  // สลับเป็นช่วงที่ไม่คลุมตอนนี้ -> activeNow ต้องเป็น false
  const offHours = WINDOW_EXCLUDES_NOW();
  const off = await postJson(app.server, "/console/api/settings/schedule", { activeHours: offHours }, headers);
  assert.equal(off.json.activeNow, false);
});

test("settings/schedule: validate เข้ม — hours ผิด/ack ยาวเกิน = 400 ไม่เขียนอะไรลง DB, ไม่มี CSRF = 403", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  for (const badHours of ["9:00-18:00", "09:00-09:00", "เช้าถึงเย็น", 900]) {
    const res = await postJson(app.server, "/console/api/settings/schedule",
      { enabled: true, activeHours: badHours }, headers);
    assert.equal(res.status, 400, `ต้อง 400: ${badHours}`);
  }
  assert.equal(db.getSetting(SCHEDULE_ENABLED_KEY), null, "validate พังต้องไม่เขียนบางส่วน");

  const longAck = await postJson(app.server, "/console/api/settings/schedule", { ackTemplate: "ก".repeat(501) }, headers);
  assert.equal(longAck.status, 400);

  const empty = await postJson(app.server, "/console/api/settings/schedule", {}, headers);
  assert.equal(empty.status, 400, "ไม่มี field ไหนเลย = 400");

  const noCsrf = await postJson(app.server, "/console/api/settings/schedule", { enabled: true }, { cookie });
  assert.equal(noCsrf.status, 403);
  const noSession = await httpRequest(app.server, { path: "/console/api/settings/schedule" });
  assert.equal(noSession.status, 401);
});
