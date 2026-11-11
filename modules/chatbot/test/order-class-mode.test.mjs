// โหมดออเดอร์คลาส (พี่ง้วง 7 ต.ค. 2026: "ออเดอร์เป็นระบบของคลาสพี่ง้วง ไม่ได้มีส่งของ ... แค่ยืนยันออเดอร์"
// + "ใบกำกับภาษี ใบเสนอราคา อาจจะยังมีที่อยู่") — สวิตช์ order_mode · ขั้นสถานะ · คำเตือน · รอบเรียน → enrollments
import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_MODE_KEY, classModeCanTransition, orderInfoWarnings, orderMode, normalizeClassRound } from "../src/orderMode.mjs";
import { canTransition, maybeCaptureDraftOrder } from "../src/orders.mjs";
import { baseRules } from "../src/pipeline.mjs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { httpRequest, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

test("สวิตช์ order_mode: ไม่มีแถว/ค่าแปลก/อ่านพัง = shipping (ร้านเดิมทำงานเหมือนเดิม)", () => {
  const db = memoryDb();
  assert.equal(orderMode(db), "shipping");
  db.setSetting(ORDER_MODE_KEY, "weird");
  assert.equal(orderMode(db), "shipping");
  db.setSetting(ORDER_MODE_KEY, "class");
  assert.equal(orderMode(db), "class");
  assert.equal(orderMode({ getSetting() { throw new Error("locked"); } }), "shipping");
  db.close();
});

test("ขั้นสถานะโหมดคลาส: ชำระแล้ว → ลงทะเบียนเรียนแล้วตรง ๆ · โหมดส่งของยังต้องผ่านจัดส่ง", () => {
  assert.equal(classModeCanTransition("paid", "done"), true);
  assert.equal(classModeCanTransition("paid", "shipped"), false);
  assert.equal(classModeCanTransition("draft", "paid"), false, "ข้ามขั้นไม่ได้เหมือนเดิม");
  assert.equal(classModeCanTransition("shipped", "done"), true, "ออเดอร์เก่าที่ค้างจัดส่งยังปิดได้");
  assert.equal(canTransition("paid", "done"), false);
  assert.equal(canTransition("paid", "done", "class"), true);
  assert.equal(canTransition("paid", "shipped", "shipping"), true);
});

test("คำเตือนโหมดคลาส: ตรวจเบอร์/อีเมล ไม่เตือนที่อยู่ (ไม่บังคับ — ใบกำกับ/ใบเสนอราคา)", () => {
  const info = { name: "คุณเจนนี่", phone: "061408298", email: "a@gmail.con", address: "กรุงเทพ" };
  const cls = orderInfoWarnings(info, "class");
  assert.ok(cls.some((w) => /gmail/u.test(w)));
  assert.ok(!cls.some((w) => /ไปรษณีย์|จังหวัด/u.test(w)));
  assert.ok(orderInfoWarnings(info, "shipping").some((w) => /ไปรษณีย์/u.test(w)));
});

test("รอบเรียน: รับเฉพาะวันที่ ISO + classKey ปลอดภัย", () => {
  assert.deepEqual(normalizeClassRound({ date: "2026-10-17", classKey: "basic", label: "AI Agent for Business" }),
    { date: "2026-10-17", classKey: "basic", label: "AI Agent for Business" });
  assert.equal(normalizeClassRound({ date: "17/10/2026", classKey: "basic" }), null);
  assert.equal(normalizeClassRound({ date: "2026-10-17", classKey: "<script>" }), null);
  assert.equal(normalizeClassRound(null), null);
});

test("พรอมต์: โหมดคลาสห้ามขอที่อยู่จัดส่ง (ขอเฉพาะใบกำกับ/ใบเสนอราคา) · โหมดส่งของคงกฎเดิม", () => {
  const cls = String(baseRules("general", [], { orderMode: "class" }));
  assert.match(cls, /ข้อมูลผู้เรียน/u);
  assert.match(cls, /ห้ามขอที่อยู่จัดส่ง/u);
  assert.doesNotMatch(cls, /ที่อยู่ต้องมีจังหวัดและรหัสไปรษณีย์/u);
  const ship = String(baseRules("general", [], {}));
  assert.match(ship, /ที่อยู่ต้องมีจังหวัดและรหัสไปรษณีย์ 5 หลัก/u);
});

test("AI เติมข้อมูลเข้าร่าง: โหมดคลาสโน้ตบอก 'ข้อมูลผู้เรียน' และไม่เตือนที่อยู่", () => {
  const db = memoryDb();
  db.setSetting(ORDER_MODE_KEY, "class");
  db.upsertCustomer("facebook:u1", { channelId: "facebook" });
  db.createOrder({ customerId: "facebook:u1", channelId: "facebook", items: [{ name: "คลาส", qty: 1, price: 12900 }], createdBy: "ai" });
  maybeCaptureDraftOrder({ db, customerId: "facebook:u1", logger: silent, payload: {
    score: 9, order: { items: [{ name: "คลาส", qty: 1 }], shipping: { name: "เจน", email: "jen@gmail.con", address: "บ้าน" } },
  } });
  const notes = db.listHandoffNotes("facebook:u1", 5).map((n) => n.text).join("\n");
  assert.match(notes, /ข้อมูลผู้เรียน/u);
  assert.doesNotMatch(notes, /ไปรษณีย์|จังหวัด/u);
  db.close();
});

const PASSWORD = ["class", "mode", "pass", "1"].join("-");
const SESSION_KEY = ["class", "mode", "fixture", "0123456789"].join("-");

test("API โหมดคลาส: ผูกรอบเรียน → ชำระแล้ว → ลงชื่อเข้า enrollments → ลงทะเบียนเรียนแล้ว (ข้ามจัดส่ง)", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.setSetting(ORDER_MODE_KEY, "class");
  db.upsertCustomer("facebook:u1", { channelId: "facebook" });
  const order = db.createOrder({ customerId: "facebook:u1", channelId: "facebook", items: [{ name: "Classroom AI Agent", qty: 1, price: 12900 }], total: 12900, createdBy: "chom" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY }), db, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = await httpRequest(app.server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ngoung", password: PASSWORD }) });
  const headers = { cookie: login.headers["set-cookie"][0].split(";")[0], "x-csrf-token": login.json.csrf, "content-type": "application/json" };
  const post = (path, body) => httpRequest(app.server, { method: "POST", path, headers, body: JSON.stringify(body) });

  const list = await httpRequest(app.server, { path: "/console/api/orders", headers });
  assert.equal(list.json.orderMode, "class");
  assert.ok(Array.isArray(list.json.classRounds));

  assert.equal((await post(`/console/api/orders/${order.id}`, { classRound: { date: "2026-10-17", classKey: "basic", label: "AI Agent for Business" } })).status, 200);
  assert.equal((await post(`/console/api/orders/${order.id}`, { classRound: { date: "bad", classKey: "x" } })).status, 400);
  for (const to of ["confirmed", "paid"]) assert.equal((await post(`/console/api/orders/${order.id}/status`, { status: to })).status, 200, to);
  const enrolled = db.listEnrollments("facebook:u1");
  assert.equal(enrolled.length, 1);
  assert.equal(enrolled[0].course_id, "basic");
  assert.equal(enrolled[0].round_date, "2026-10-17");
  const shipped = await post(`/console/api/orders/${order.id}/status`, { status: "shipped" });
  assert.equal(shipped.status, 409);
  assert.match(shipped.json.error, /ลงทะเบียนเรียนแล้ว/u);
  const done = await post(`/console/api/orders/${order.id}/status`, { status: "done" });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.order.classRound.date, "2026-10-17");

  const me = await httpRequest(app.server, { path: "/console/api/me", headers });
  assert.equal(me.json.features?.orderMode, "class");
});

function findAll(node, predicate, out = []) {
  for (const child of node?.children || []) {
    if (child?.nodeType !== 1) continue;
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}
const textOf = (node) => (node?.nodeType === 3 ? node.textContent : `${node?.textContent || ""}${(node?.children || []).map(textOf).join("")}`);

test("หน้าเว็บ: ป้ายสถานะโหมดคลาส", async (t) => {
  installBrowserGlobals(t);
  const { orderStatusBadge, orderStatusMetaFor } = await import("../public/console/ui.mjs");
  assert.equal(textOf(orderStatusBadge("paid", "class")), "ชำระแล้ว");
  assert.equal(textOf(orderStatusBadge("done", "class")), "ลงทะเบียนเรียนแล้ว");
  assert.equal(textOf(orderStatusBadge("paid")), "จ่ายแล้ว");
  assert.equal(orderStatusMetaFor("class").paid.next, "done");
  assert.equal(orderStatusMetaFor("shipping").paid.next, "shipped");
  assert.ok(findAll);
});

test("API โหมดคลาส: ผูกรอบหลังชำระ = ลงชื่อ · เปลี่ยนรอบ = ยกเลิกแถวเก่า · ยกเลิกออเดอร์ = ยกเลิกแถว · ลงไว้แล้วไม่ซ้ำ (รีวิว 7 ต.ค.)", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.setSetting(ORDER_MODE_KEY, "class");
  db.upsertCustomer("facebook:u2", { channelId: "facebook" });
  db.addEnrollment({ customerId: "facebook:u2", courseId: "basic", roundDate: "2026-10-17", confirmedBy: "chom" });
  const order = db.createOrder({ customerId: "facebook:u2", channelId: "facebook", items: [{ name: "คลาส", qty: 1, price: 12900 }], total: 12900, createdBy: "chom" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY }), db, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = await httpRequest(app.server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ngoung", password: PASSWORD }) });
  const headers = { cookie: login.headers["set-cookie"][0].split(";")[0], "x-csrf-token": login.json.csrf, "content-type": "application/json" };
  const post = (path, body) => httpRequest(app.server, { method: "POST", path, headers, body: JSON.stringify(body) });
  const enrolled = () => db.listEnrollments("facebook:u2").filter((r) => r.status === "enrolled").map((r) => `${r.course_id}@${r.round_date}`).sort();

  for (const to of ["confirmed", "paid"]) assert.equal((await post(`/console/api/orders/${order.id}/status`, { status: to })).status, 200);
  assert.deepEqual(enrolled(), ["basic@2026-10-17"], "ชำระแล้วแต่ยังไม่มีรอบ = แถวเดิมของทีมอยู่ครบ ไม่เพิ่ม");
  assert.equal((await post(`/console/api/orders/${order.id}`, { classRound: { date: "2026-10-17", classKey: "basic", label: "x" } })).status, 200);
  assert.deepEqual(enrolled(), ["basic@2026-10-17"], "ลงรอบนี้ไว้แล้ว = ไม่สร้างซ้ำ");
  assert.equal((await post(`/console/api/orders/${order.id}`, { classRound: { date: "2026-11-07", classKey: "workflow", label: "y" } })).status, 200);
  assert.deepEqual(enrolled(), ["basic@2026-10-17", "workflow@2026-11-07"], "ผูกรอบหลังชำระ = ลงชื่อ");
  assert.equal((await post(`/console/api/orders/${order.id}`, { classRound: { date: "2026-11-21", classKey: "workflow", label: "y" } })).status, 200);
  assert.deepEqual(enrolled(), ["basic@2026-10-17", "workflow@2026-11-21"], "เปลี่ยนรอบ = ยกเลิกแถวที่ออเดอร์สร้าง แล้วลงรอบใหม่");
  assert.equal((await post(`/console/api/orders/${order.id}`, { classRound: { date: "2026-12-05", classKey: "basic", label: "z" }, shipping: { name: "x".repeat(5) }, items: [] })).status, 409);
  assert.deepEqual(enrolled(), ["basic@2026-10-17", "workflow@2026-11-21"], "คำขอที่ตอบ error ไม่เปลี่ยนรอบ");
  assert.equal((await post(`/console/api/orders/${order.id}/status`, { status: "cancelled" })).status, 200);
  assert.deepEqual(enrolled(), ["basic@2026-10-17"], "ยกเลิกออเดอร์ = ยกเลิกแถวที่ออเดอร์สร้าง แถวของทีมไม่แตะ");
});
