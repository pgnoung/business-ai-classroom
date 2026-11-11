// Purchase → Meta Conversions API ตอนออเดอร์ "ชำระแล้ว" (พี่ง้วง 7 ต.ค. 2026)
import test from "node:test";
import assert from "node:assert/strict";
import {
  META_CAPI_DATASET_KEY, META_CAPI_MODE_KEY, META_CAPI_TEST_CODE_KEY, buildPurchaseEvent, createMetaCapi, metaCapiMode, psidOf,
} from "../src/metaCapi.mjs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { httpRequest, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const PSID = "10000000000000201";
const PAGE = "100000000000101";

function stub(response = { events_received: 1, fbtrace_id: "T1" }, status = 200) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify(response), { status }); };
  fn.calls = calls;
  return fn;
}
function setup({ mode = "live", fetchImpl = stub(), dataset = "100000000000301", testCode = "TEST123" } = {}) {
  const NOW = 1_791_000_000_000;
  const db = memoryDb({ now: () => NOW });
  db.setSetting(META_CAPI_MODE_KEY, mode);
  if (dataset) db.setSetting(META_CAPI_DATASET_KEY, dataset);
  if (testCode) db.setSetting(META_CAPI_TEST_CODE_KEY, testCode);
  const capi = createMetaCapi({ db, fetchImpl, logger: silent, getPageToken: () => "page-token", getPageId: async () => PAGE, now: () => NOW });
  return { db, capi, fetchImpl };
}
const order = (over = {}) => ({ id: "ord-1", customer_id: `facebook:${PSID}`, total: 12900, ...over });

test("สวิตช์: ไม่มีแถว/ค่าแปลก/อ่านพัง = off · PSID มาจากห้อง Messenger เท่านั้น", () => {
  const db = memoryDb();
  assert.equal(metaCapiMode(db), "off");
  db.setSetting(META_CAPI_MODE_KEY, "yes");
  assert.equal(metaCapiMode(db), "off");
  assert.equal(metaCapiMode({ getSetting() { throw new Error("x"); } }), "off");
  assert.equal(psidOf(`facebook:${PSID}`), PSID);
  assert.equal(psidOf("default:Uabc"), "");
  assert.equal(psidOf("facebook:abc"), "");
  db.close();
});

test("payload แบบ Business Messaging: Purchase + page_id/PSID + ยอด THB + event_id คงที่ต่อออเดอร์", () => {
  const e = buildPurchaseEvent({ order: order(), psid: PSID, pageId: PAGE, nowMs: 1_791_000_000_500 });
  assert.deepEqual(e, {
    event_name: "Purchase", event_time: 1_791_000_000, event_id: "lukprae-order-ord-1",
    action_source: "business_messaging", messaging_channel: "messenger",
    user_data: { page_id: PAGE, page_scoped_user_id: PSID },
    custom_data: { currency: "THB", value: 12900 },
  });
});

test("live: ส่งครั้งเดียวต่อออเดอร์ (กดซ้ำ = duplicate) · ใบเสร็จ sent พร้อม trace", async () => {
  const { db, capi, fetchImpl } = setup();
  assert.deepEqual(await capi.onOrderPaid(order()), { status: "sent", detail: "events_received=1 trace=T1" });
  assert.deepEqual(await capi.onOrderPaid(order()), { status: "duplicate" });
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /\/100000000000301\/events$/u, "โทเค็นต้องไม่อยู่ใน URL");
  assert.equal(fetchImpl.calls[0].body.access_token, "page-token");
  assert.equal(fetchImpl.calls[0].body.test_event_code, undefined, "live ห้ามแนบ test code");
  assert.equal(db.capiEventFor("ord-1")[0].status, "sent");
  db.close();
});

test("test: แนบ test_event_code · ไม่มี code = ข้าม (ไม่ส่งจริงแทน)", async () => {
  const a = setup({ mode: "test" });
  await a.capi.onOrderPaid(order());
  assert.equal(a.fetchImpl.calls[0].body.test_event_code, "TEST123");
  a.db.close();
  const b = setup({ mode: "test", testCode: "" });
  assert.deepEqual(await b.capi.onOrderPaid(order()), { status: "skipped", detail: "no_test_code" });
  assert.equal(b.fetchImpl.calls.length, 0);
  b.db.close();
});

test("ข้าม: ปิดอยู่ / ห้อง LINE / ไม่มียอด / ยังไม่ตั้งชุดข้อมูล — ไม่ยิงอะไรเลย", async () => {
  const off = setup({ mode: "off" });
  assert.deepEqual(await off.capi.onOrderPaid(order()), { status: "off" });
  off.db.close();
  for (const [over, reason] of [[{ customer_id: "default:Uabc" }, "not_messenger"], [{ total: null }, "no_total"]]) {
    const s = setup();
    assert.equal((await s.capi.onOrderPaid(order(over))).detail, reason);
    assert.equal(s.fetchImpl.calls.length, 0);
    s.db.close();
  }
  const noDataset = setup({ dataset: "" });
  assert.equal((await noDataset.capi.onOrderPaid(order())).detail, "no_dataset");
  noDataset.db.close();
});

test("Meta ตอบพัง / เครือข่ายล้ม = ใบเสร็จ failed ไม่ throw", async () => {
  const bad = setup({ fetchImpl: stub({ error: { code: 100, message: "Invalid parameter" } }, 400) });
  const r = await bad.capi.onOrderPaid(order());
  assert.equal(r.status, "failed");
  assert.match(r.detail, /HTTP 400 100 Invalid parameter/u);
  bad.db.close();
  const down = setup({ fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal((await down.capi.onOrderPaid(order())).status, "failed");
  assert.equal(down.db.capiEventFor("ord-1")[0].status, "failed");
  down.db.close();
});

test("ลองใหม่: ยังไม่ตั้งชุดข้อมูล/Meta พัง = ลองใหม่ได้หลังเว้นระยะ สูงสุด 5 ครั้ง · ส่งสำเร็จ/ห้อง LINE ไม่ลองซ้ำ", async () => {
  let clock = 1_791_000_000_000;
  const db = memoryDb({ now: () => clock });
  db.setSetting(META_CAPI_MODE_KEY, "live");
  db.upsertCustomer(`facebook:${PSID}`, { channelId: "facebook" });
  const o = db.createOrder({ customerId: `facebook:${PSID}`, channelId: "facebook", items: [{ name: "คลาส", qty: 1, price: 12900 }], total: 12900, status: "paid" });
  const fetchImpl = stub();
  const capi = createMetaCapi({ db, fetchImpl, logger: silent, getPageToken: () => "page-token", getPageId: async () => PAGE, now: () => clock });

  assert.equal((await capi.onOrderPaid(db.getOrder(o.id))).detail, "no_dataset");
  db.setSetting(META_CAPI_DATASET_KEY, "100000000000301");
  assert.equal((await capi.sweep()).tried, 0, "ยังไม่ครบระยะเว้น 25 นาที");
  clock += 26 * 60_000;
  assert.equal((await capi.sweep()).tried, 1);
  assert.equal(db.capiEventFor(o.id)[0].status, "sent");
  clock += 60 * 60_000;
  assert.equal((await capi.sweep()).tried, 0, "ส่งสำเร็จแล้วไม่ส่งซ้ำ");
  assert.equal(fetchImpl.calls.length, 1);

  const failing = memoryDb({ now: () => clock });
  failing.setSetting(META_CAPI_MODE_KEY, "live");
  failing.setSetting(META_CAPI_DATASET_KEY, "100000000000301");
  failing.upsertCustomer(`facebook:${PSID}`, { channelId: "facebook" });
  const f = failing.createOrder({ customerId: `facebook:${PSID}`, channelId: "facebook", items: [{ name: "คลาส", qty: 1, price: 1 }], total: 1, status: "paid" });
  const down = createMetaCapi({ db: failing, fetchImpl: async () => { throw new Error("down"); }, logger: silent, getPageToken: () => "t", getPageId: async () => PAGE, now: () => clock });
  for (let i = 0; i < 8; i += 1) { await down.sweep(); clock += 30 * 60_000; }
  assert.equal(failing.capiEventFor(f.id)[0].attempts, 5, "เพดาน 5 ครั้ง");
  db.close();
  failing.close();
});

const PASSWORD = ["capi", "pass", "123", "z"].join("-");
const SESSION_KEY = ["capi", "fixture", "0123456789"].join("-");

test("API: กด ชำระแล้ว → ยิง Purchase หนึ่งครั้ง · สถานะเงินเดินต่อแม้ Meta พัง", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.setSetting(META_CAPI_MODE_KEY, "live");
  db.setSetting(META_CAPI_DATASET_KEY, "100000000000301");
  db.upsertCustomer(`facebook:${PSID}`, { channelId: "facebook" });
  const o = db.createOrder({ customerId: `facebook:${PSID}`, channelId: "facebook", items: [{ name: "คลาส", qty: 1, price: 12900 }], total: 12900, createdBy: "chom" });
  const capiFetch = async () => { throw new Error("meta down"); };
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY }), db, logger: silent, overrides: { capiFetch } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = await httpRequest(app.server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ngoung", password: PASSWORD }) });
  const headers = { cookie: login.headers["set-cookie"][0].split(";")[0], "x-csrf-token": login.json.csrf, "content-type": "application/json" };
  for (const to of ["confirmed", "paid"]) {
    const res = await httpRequest(app.server, { method: "POST", path: `/console/api/orders/${o.id}/status`, headers, body: JSON.stringify({ status: to }) });
    assert.equal(res.status, 200, res.text);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  const rows = db.capiEventFor(o.id);
  assert.equal(rows.length, 1);
  assert.ok(["failed", "skipped"].includes(rows[0].status), rows[0].status);
});
