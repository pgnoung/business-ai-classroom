// yolo-handoff — ตัวเลือก "🔔 ส่งต่อแอดมิน" ของปุ่ม YOLO (คำสั่งพี่ง้วง 2026-10-15)
// ผ่าน HTTP จริงของ createApp: ส่งคำของคนตามนั้นเป๊ะ · เลือกปิด/ไม่ปิด AI · ธงรอคน + โน้ต + push แอดมิน
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { createYoloHandoff, handoffBubbles, handoffNotifyText, handoffSendLine, YOLO_HANDOFF_REASON } from "../src/yoloHandoff.mjs";
import { NEEDS_HUMAN_SLA_PERSON_REASONS } from "../src/needsPersonReason.mjs";
import { NOTIFY_REASON_TEXT } from "../src/notify.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const PASSWORD = ["operator", "pass", "456"].join("-");
const SESSION_KEY = ["yolo", "handoff", "fixture", "0123456789"].join("-");
const PASS_HASH = hashPassword(PASSWORD);
const CUSTOMER = "U0123456789abcdef0123456789abcdef";
const ADMIN_LINE = "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function hermesNeverCalled() {
  const fn = async () => { throw new Error("handoff ต้องไม่เรียกโมเดล"); };
  return fn;
}

// ลูกค้าได้ 500 ได้ตามสั่ง (ทดสอบส่งไม่ถึง) — แอดมินยังได้ push ปกติ
function lineStub({ failCustomer = false } = {}) {
  const base = lineFetchStub();
  const fn = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (failCustomer && body?.to === CUSTOMER) {
      base.calls.push({ url: String(url), body });
      return { ok: false, status: 500, json: async () => ({ message: "boom" }) };
    }
    return base(url, opts);
  };
  Object.defineProperty(fn, "sends", { get: () => base.sends });
  return fn;
}

async function start(t, { failCustomer = false } = {}) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: PASS_HASH, displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: PASS_HASH, displayName: "ชมพู่", role: "operator" });
  db.setSetting("escalate_notify:default", JSON.stringify([ADMIN_LINE]));
  const lineFetch = lineStub({ failCustomer });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY, CONSOLE_PUBLIC_BASE_URL: "https://lukprae.example/console" }),
    db, logger: silent,
    overrides: { lineFetch, hermesFetch: hermesNeverCalled(), sleep: async () => {} },
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

const post = (server, session, body) => httpRequest(server, {
  method: "POST", path: `/console/api/customers/${CUSTOMER}/yolo`,
  headers: { cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" },
  body: JSON.stringify(body),
});

function seedRoom(db, { aiOn = true } = {}) {
  db.upsertCustomer(CUSTOMER, { displayName: "คุณทดสอบ" });
  db.insertMessage({ id: "in-1", customerId: CUSTOMER, direction: "in", content: "อยากคุยกับทีมเรื่อง in-house ค่ะ" });
  db.insertMessage({ id: "out-1", customerId: CUSTOMER, direction: "out", content: "ยินดีค่ะ" });
  db.setAiEnabled(CUSTOMER, aiOn, aiOn ? "" : "manual");
}

const toCustomer = (lineFetch) => lineFetch.sends.filter((call) => call.body?.to === CUSTOMER);
const toAdmin = (lineFetch) => lineFetch.sends.filter((call) => call.body?.to === ADMIN_LINE);

test("ส่งต่อแอดมิน (ค่าเริ่มต้น): คำของคนถึงลูกค้าตามนั้นเป๊ะ · ปิด AI · ธงรอคน + โน้ต + push แอดมิน", async (t) => {
  const { app, db, lineFetch } = await start(t);
  seedRoom(db, { aiOn: true });
  const owner = await login(app.server, "ngoung");
  const message = "ได้เลยค่ะ เดี๋ยวแอดมินโทรกลับภายในวันนี้นะคะ\n\nขอบคุณที่รอค่ะ";
  const res = await post(app.server, owner, { mode: "handoff", message });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.status, "handed_off");
  assert.equal(res.json.aiClosed, true);

  const sent = toCustomer(lineFetch);
  assert.equal(sent.length, 1, "ส่งถึงลูกค้าครั้งเดียว");
  assert.deepEqual(sent[0].body.messages.map((m) => m.text), ["ได้เลยค่ะ เดี๋ยวแอดมินโทรกลับภายในวันนี้นะคะ", "ขอบคุณที่รอค่ะ"],
    "ไม่ผ่าน humanizer — ตัดฟองตามบรรทัดว่างที่คนเว้นเองเท่านั้น");

  const admin = toAdmin(lineFetch);
  assert.equal(admin.length, 1, "push แจ้งแอดมิน 1 ครั้ง");
  const alert = admin[0].body.messages[0].text;
  assert.match(alert, /ถูกส่งต่อให้แอดมินโดย พี่ง้วง \(ปุ่ม YOLO\)/u);
  assert.match(alert, /AI ห้องนี้ปิดแล้ว/u);
  assert.match(alert, /ข้อความที่ส่งให้ลูกค้าแล้ว: "ได้เลยค่ะ/u);
  assert.match(alert, /lukprae\.example\/console\/#\/c\//u, "กดเข้าห้องได้เลย");
  assert.deepEqual(res.json.notify, { sent: 1, total: 1, skipped: "" });

  const row = db.getCustomer(CUSTOMER);
  assert.equal(row.ai_enabled, 0);
  assert.equal(row.ai_off_reason, "manual", "ปิดเส้นเดียวกับปุ่มในห้อง — เส้นอัตโนมัติเปิดคืนไม่ได้");
  assert.equal(row.state, "NEEDS_HUMAN");
  assert.match(row.handoff_summary, /owner_handoff: ส่งต่อแอดมินจากปุ่ม YOLO โดย พี่ง้วง/u);
  const note = db.listHandoffNotes(CUSTOMER, 5).find((item) => item.author === "ngoung");
  assert.match(note.text, /🔔 ส่งต่อแอดมิน/u);
  const out = db.messagesFor(CUSTOMER, 10).filter((m) => m.direction === "out" && m.operator === "ngoung");
  assert.equal(out.length, 2, "บันทึกเป็นข้อความของคน (operator) ทุกฟอง");
  assert.equal(JSON.parse(out[0].metadata_json).yoloHandoff, true);
  const audit = db.listAudit(30).find((item) => item.action === "yolo_handoff");
  assert.equal(audit.operator, "ngoung");
  assert.match(audit.detail, /AI off \(ปิดตามที่เลือก\) · แจ้งแอดมิน 1\/1/u);
});

test("ไม่ปิด AI: ห้องขึ้นคิวรอคน + push แอดมิน แต่ลูกแพรคุยต่อได้", async (t) => {
  const { app, db, lineFetch } = await start(t);
  seedRoom(db, { aiOn: true });
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, owner, { mode: "handoff", message: "รับทราบค่ะ ส่งเรื่องให้แอดมินแล้วนะคะ", closeAi: false });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.aiClosed, false);
  assert.equal(res.json.customer.aiEnabled, true);
  assert.equal(db.getCustomer(CUSTOMER).ai_enabled, 1);
  assert.equal(db.getCustomer(CUSTOMER).state, "NEEDS_HUMAN");
  assert.match(toAdmin(lineFetch)[0].body.messages[0].text, /AI ห้องนี้ยังเปิด \(ลูกแพรคุยต่อได้\)/u);
});

test("ไม่ใส่ข้อความ = แจ้งแอดมินอย่างเดียว ไม่มีอะไรถึงลูกค้า", async (t) => {
  const { app, db, lineFetch } = await start(t);
  seedRoom(db, { aiOn: false });
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, owner, { mode: "handoff", message: "   " });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.status, "handed_off");
  assert.equal(res.json.aiClosed, false, "AI ปิดอยู่แล้ว ไม่ต้องปิดซ้ำ");
  assert.equal(toCustomer(lineFetch).length, 0);
  assert.equal(toAdmin(lineFetch).length, 1);
  assert.match(toAdmin(lineFetch)[0].body.messages[0].text, /ยังไม่ได้ส่งข้อความหาลูกค้า/u);
});

test("ส่งถึงลูกค้าไม่สำเร็จ ≠ ยกเลิก: ห้องยังไปถึงแอดมิน พร้อมบอกว่าข้อความไม่ถึง", async (t) => {
  const { app, db, lineFetch } = await start(t, { failCustomer: true });
  seedRoom(db, { aiOn: true });
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, owner, { mode: "handoff", message: "เดี๋ยวแอดมินติดต่อกลับค่ะ" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.status, "partial");
  assert.equal(res.json.reason, "send_failed");
  assert.equal(db.getCustomer(CUSTOMER).state, "NEEDS_HUMAN");
  assert.match(toAdmin(lineFetch)[0].body.messages[0].text, /ข้อความถึงลูกค้าส่งไม่สำเร็จ/u);
  assert.equal(db.messagesFor(CUSTOMER, 10).filter((m) => m.operator === "ngoung").length, 0, "ไม่บันทึกข้อความที่ไม่ถึง");
});

test("ด่าน: พนักงาน 403 · ชนิดข้อมูลผิด 400 · ลูกค้าขอหยุดทักแต่ใส่ข้อความ = ปฏิเสธโดยไม่แตะห้อง", async (t) => {
  const { app, db, lineFetch } = await start(t);
  seedRoom(db, { aiOn: false });
  const staff = await login(app.server, "chompoo");
  assert.equal((await post(app.server, staff, { mode: "handoff" })).status, 403);
  const owner = await login(app.server, "ngoung");
  assert.equal((await post(app.server, owner, { mode: "admin" })).status, 400);
  assert.equal((await post(app.server, owner, { mode: "handoff", message: 7 })).status, 400);
  assert.equal((await post(app.server, owner, { mode: "handoff", closeAi: "yes" })).status, 400);

  db.setAiEnabled(CUSTOMER, false, "optout");
  const refused = await post(app.server, owner, { mode: "handoff", message: "สวัสดีค่ะ" });
  assert.equal(refused.status, 422);
  assert.equal(refused.json.reason, "opted_out");
  assert.match(refused.json.error, /ลบข้อความออกแล้วกดส่งต่อแอดมินอย่างเดียวได้/u);
  assert.notEqual(db.getCustomer(CUSTOMER).state, "NEEDS_HUMAN");
  assert.equal(lineFetch.sends.length, 0);
  assert.ok(db.listAudit(30).some((item) => item.action === "yolo_handoff_refused"));

  const notifyOnly = await post(app.server, owner, { mode: "handoff", message: "" });
  assert.equal(notifyOnly.status, 200, "ห้องที่ขอหยุดทัก ยังส่งให้แอดมินดูแลได้");
  assert.equal(toCustomer(lineFetch).length, 0);
});

test("ทะเบียนเหตุ: owner_handoff เป็นเหตุที่ต้องใช้คน (ทวงตาม SLA) และแจ้งได้", () => {
  assert.ok(NEEDS_HUMAN_SLA_PERSON_REASONS.includes(YOLO_HANDOFF_REASON));
  assert.ok(NOTIFY_REASON_TEXT[YOLO_HANDOFF_REASON]);
});

test("handoffBubbles: แบ่งตามบรรทัดว่าง · ไม่เกิน 4 ฟอง (เกินรวมฟองท้าย)", () => {
  assert.deepEqual(handoffBubbles("ก\nข"), ["ก\nข"]);
  assert.deepEqual(handoffBubbles("ก\n\nข\n \nค"), ["ก", "ข", "ค"]);
  assert.deepEqual(handoffBubbles("1\n\n2\n\n3\n\n4\n\n5"), ["1", "2", "3", "4\n\n5"]);
  assert.deepEqual(handoffBubbles(""), []);
});

test("handoffNotifyText: ชื่อคนส่งยุบบรรทัด (กันปลอมเสียงระบบ) · ตัดข้อความยาว", () => {
  const text = handoffNotifyText({ actorName: "พี่\nง้วง", aiOn: false, sentText: "ก".repeat(200), send: { outcome: "sent" } });
  assert.match(text, /^ถูกส่งต่อให้แอดมินโดย พี่ ง้วง/u);
  assert.match(text, /ก{160}…"/u);
});

test("handoffSendLine: ไม่แน่ใจว่าถึง ≠ ส่งไม่สำเร็จ · ถูกด่านกันในคิว = บอกเหตุ", () => {
  assert.match(handoffSendLine({ outcome: "unknown" }), /ไม่แน่ใจว่าข้อความถึงลูกค้าหรือยัง/u);
  assert.match(handoffSendLine({ outcome: "failed" }), /ส่งไม่สำเร็จ/u);
  assert.match(handoffSendLine({ outcome: "blocked", blocked: "opted_out" }), /ไม่ได้ส่งข้อความหาลูกค้า \(ลูกค้าขอให้หยุดทัก/u);
  assert.match(handoffSendLine({ outcome: "none" }), /ยังไม่ได้ส่งข้อความหาลูกค้า/u);
});

// รีวิว 15 ต.ค. #1/#2: ด่านซ้ำ "ในคิวของห้อง" + ขั้นหลังส่งพังห้ามล้มการส่งต่อ (หน่วยเดี่ยว ไม่ผ่าน HTTP)
function fakeDb(overrides = {}) {
  const row = { line_user_id: CUSTOMER, channel_id: "default", ai_enabled: 1, ai_off_reason: "", do_not_disturb: 0, marketing_consent: 0, display_name: "คุณทดสอบ" };
  const log = { needsHuman: 0, notes: 0, inserted: 0 };
  const db = {
    row, log,
    getCustomer: () => ({ ...row }),
    isLegacyReferenceRoom: () => false,
    lastInboundAt: () => 1,
    withinFacebookWindow: () => true,
    claimProactiveAttempt: () => ({ ok: true }),
    fenceProactiveSend: () => true,
    settleProactiveSend: () => {},
    insertMessage: () => { log.inserted += 1; },
    setNeedsHuman: () => { log.needsHuman += 1; },
    addHandoffNote: () => { log.notes += 1; },
    addAudit: () => {},
    setAiEnabled: (_id, on, reason) => { row.ai_enabled = on ? 1 : 0; row.ai_off_reason = reason; },
    clearNeedsHuman: () => {},
    setSetting: () => {},
    ...overrides,
  };
  return db;
}

test("ลูกค้าขอหยุดทักระหว่างรอคิว: ไม่ยิงข้อความ แต่ห้องยังถูกส่งต่อแอดมิน + push บอกว่าไม่ได้ส่ง", async () => {
  const db = fakeDb();
  const sends = [];
  const pushes = [];
  const lineRegistry = { forChannel: () => ({ sendBubbles: async (args) => { sends.push(args); return { ok: true }; } }), rawUserId: (id) => id };
  // จำลองไปป์ไลน์: ระหว่างที่ handoff รอคิว เทิร์นของลูกค้าตั้ง optout
  const pipeline = { runExclusive: async (_id, fn) => { db.row.ai_off_reason = "optout"; db.row.ai_enabled = 0; return fn(); } };
  const notifier = { fire: async (args) => { pushes.push(args); return { ok: true, sent: 1, total: 1 }; } };
  const { handoff } = createYoloHandoff({ db, lineRegistry, notifier, pipeline, logger: silent });
  const result = await handoff({ customerId: CUSTOMER, message: "เดี๋ยวแอดมินติดต่อกลับค่ะ", closeAi: false, actor: "ngoung" });
  assert.equal(sends.length, 0, "ไม่ยิงหาลูกค้าที่เพิ่งขอหยุด");
  assert.equal(result.ok, true);
  assert.equal(result.reason, "opted_out");
  assert.equal(db.log.needsHuman, 1);
  assert.match(pushes[0].reasonTextOverride, /ไม่ได้ส่งข้อความหาลูกค้า/u);
});

test("ส่งถึงแล้วแต่ DB พังตอนบันทึก/ตั้งธง: ยังไปถึงขั้น push แอดมิน และรายงานว่าส่งต่อแล้ว (ไม่ชวนกดซ้ำ)", async () => {
  const boom = () => { throw new Error("SQLITE_BUSY"); };
  const db = fakeDb({ insertMessage: boom, setNeedsHuman: boom, addHandoffNote: boom });
  const pushes = [];
  const lineRegistry = { forChannel: () => ({ sendBubbles: async () => ({ ok: true }) }), rawUserId: (id) => id };
  const notifier = { fire: async (args) => { pushes.push(args); return { ok: true, sent: 1, total: 1 }; } };
  const { handoff } = createYoloHandoff({ db, lineRegistry, notifier, logger: silent });
  const result = await handoff({ customerId: CUSTOMER, message: "รับทราบค่ะ", closeAi: false, actor: "ngoung" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "handed_off");
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].reasonTextOverride, /ข้อความที่ส่งให้ลูกค้าแล้ว: "รับทราบค่ะ"/u);
});

test("provider โยน error = ไม่แน่ใจว่าถึง (send_unknown) ไม่ใช่ 'ไม่ถึง'", async () => {
  const db = fakeDb();
  const lineRegistry = { forChannel: () => ({ sendBubbles: async () => { throw new Error("timeout"); } }), rawUserId: (id) => id };
  const { handoff } = createYoloHandoff({ db, lineRegistry, notifier: { fire: async () => ({ sent: 1, total: 1 }) }, logger: silent });
  const result = await handoff({ customerId: CUSTOMER, message: "รับทราบค่ะ", actor: "ngoung" });
  assert.equal(result.reason, "send_unknown");
  assert.equal(result.status, "partial");
});
