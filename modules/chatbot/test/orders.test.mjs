// orders.test.mjs — G6 P2: ระบบออเดอร์ v1
// ครอบ: status flow legality (ห้ามข้ามขั้น, ยกเลิกได้ทุกขั้นที่ยังไม่จบ), CRUD + CAS,
// AI จับร่างออเดอร์จาก scorer (happy / กันซ้ำ / score ต่ำไม่สร้าง / ทรงพัง = ทิ้ง),
// เทียบราคา approved_prices แบบ fuzzy, จับคู่สลิป-ออเดอร์, webhook (ยิงตอน confirm/paid,
// ปิดสนิทเมื่อไม่มี env, ล้มเหลวไม่ throw), CSV export formula-safe, console API auth/CSRF,
// overview stats (ทุกอย่าง mock — ห้ามแตะ network จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  canTransition, normalizeOrderItems, resolveApprovedPrice, priceOrderItems,
  maybeCaptureDraftOrder, createOrderWebhook,
} from "../src/orders.mjs";
import { pickOrder, parseScorePayload } from "../src/scoring.mjs";
import { createSlipChecker } from "../src/slipCheck.mjs";
import { createConfig } from "../src/config.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen, waitFor, promptText,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

/* ------------------------------ unit: กติกา flow ------------------------------ */

test("canTransition: เดินตามขั้นเท่านั้น — ข้ามขั้นไม่ได้, ยกเลิกได้ทุกขั้นที่ยังไม่จบ", () => {
  assert.ok(canTransition("draft", "confirmed"));
  assert.ok(canTransition("confirmed", "paid"));
  assert.ok(canTransition("paid", "shipped"));
  assert.ok(canTransition("shipped", "done"));
  for (const from of ["draft", "confirmed", "paid", "shipped"]) {
    assert.ok(canTransition(from, "cancelled"), `${from} -> cancelled ต้องได้`);
  }
  assert.ok(!canTransition("draft", "paid"), "ห้ามข้าม confirmed");
  assert.ok(!canTransition("draft", "shipped"));
  assert.ok(!canTransition("confirmed", "done"));
  assert.ok(!canTransition("done", "cancelled"), "จบแล้วยกเลิกไม่ได้");
  assert.ok(!canTransition("cancelled", "confirmed"), "ยกเลิกแล้วฟื้นไม่ได้");
  assert.ok(!canTransition("paid", "confirmed"), "ถอยหลังไม่ได้");
});

test("normalizeOrderItems: validate ครบทุกทรง", () => {
  assert.deepEqual(
    normalizeOrderItems([{ name: " X3 Pro ", qty: 2, price: "12900" }]),
    [{ name: "X3 Pro", qty: 2, price: 12900 }]
  );
  assert.deepEqual(
    normalizeOrderItems([{ name: "X5", qty: 1, price: null }]),
    [{ name: "X5", qty: 1, price: null }]
  );
  assert.deepEqual(normalizeOrderItems([{ name: "X5", qty: 1, price: "" }]), [{ name: "X5", qty: 1, price: null }]);
  assert.equal(normalizeOrderItems([{ name: "", qty: 1 }]), null, "ชื่อว่าง = ทิ้งทั้งชุด");
  assert.equal(normalizeOrderItems([{ name: "X", qty: 0 }]), null);
  assert.equal(normalizeOrderItems([{ name: "X", qty: 1.5 }]), null);
  assert.equal(normalizeOrderItems([{ name: "X", qty: 1, price: -5 }]), null);
  assert.equal(normalizeOrderItems("ไม่ใช่ array"), null);
  assert.equal(normalizeOrderItems(Array.from({ length: 21 }, () => ({ name: "X", qty: 1 }))), null, "เกิน 20 รายการ");
});

test("resolveApprovedPrice: exact -> contains (สองทาง) -> label เจาะจงสุดชนะ -> ไม่เจอ = null", () => {
  const prices = [
    { label: "X3 Pro ราคาเต็ม", amount: 15900 },
    { label: "X3", amount: 9900 },
    { label: "ค่าติดตั้ง", amount: 500 },
  ];
  assert.equal(resolveApprovedPrice(prices, "X3"), 9900, "exact ชนะ");
  assert.equal(resolveApprovedPrice(prices, "x3  pro ราคาเต็ม"), 15900, "case/ช่องว่างไม่มีผล");
  assert.equal(resolveApprovedPrice(prices, "X3 Pro"), 15900, "ชื่อสั้นกว่า match label ที่มีมัน");
  assert.equal(resolveApprovedPrice(prices, "ติดตั้ง"), 500);
  assert.equal(resolveApprovedPrice(prices, "Y9"), null);
  assert.equal(resolveApprovedPrice([], "X3"), null);
});

test("priceOrderItems: total เฉพาะเมื่อรู้ราคาครบทุกแถว — ขาดแถวเดียว = null", () => {
  const prices = [{ label: "X3", amount: 9900 }, { label: "ค่าติดตั้ง", amount: 500 }];
  const full = priceOrderItems([{ name: "X3", qty: 2 }, { name: "ค่าติดตั้ง", qty: 1 }], prices);
  assert.equal(full.total, 9900 * 2 + 500);
  assert.deepEqual(full.items.map((it) => it.price), [9900, 500]);
  const partial = priceOrderItems([{ name: "X3", qty: 1 }, { name: "Y9", qty: 1 }], prices);
  assert.equal(partial.total, null, "ราคาไม่ครบ = ให้คนเติม");
  assert.equal(partial.items[1].price, null);
});

test("pickOrder + parseScorePayload: ก้อน order defensive — ทรงพัง = null, field อื่นรอด", () => {
  assert.deepEqual(
    pickOrder({ items: [{ name: "X3", qty: 2 }], total_hint: 19800 }),
    { items: [{ name: "X3", qty: 2 }], total_hint: 19800, shipping: null }
  );
  // v1.1: shipping แนบมากับ order — sanitize แล้ว; ทรงพัง = shipping หายเฉย ๆ order รอด
  assert.deepEqual(
    pickOrder({ items: [{ name: "X3", qty: 1 }], shipping: { name: " สมศักดิ์ ", phone: "0812345678", address: "99/9 เขตทดสอบ กรุงเทพฯ 10110", email: "a@b.co" } }).shipping,
    { name: "สมศักดิ์", phone: "0812345678", address: "99/9 เขตทดสอบ กรุงเทพฯ 10110", email: "a@b.co" }
  );
  assert.equal(pickOrder({ items: [{ name: "X3", qty: 1 }], shipping: "broken" }).shipping, null);
  assert.equal(pickOrder({ items: [{ name: "X", qty: 0 }] }).items[0].qty, 1, "qty เพี้ยน = ปรับเป็น 1");
  assert.equal(pickOrder({ items: [] }), null);
  assert.equal(pickOrder({ items: [{ qty: 2 }] }), null, "ไม่มีชื่อ = ทิ้ง");
  assert.equal(pickOrder(null), null);
  assert.equal(pickOrder("x3"), null);
  assert.equal(pickOrder({ items: [{ name: "X", qty: 1 }], total_hint: -5 }).total_hint, null);

  const payload = parseScorePayload(JSON.stringify({
    score: 9, order: { items: [{ name: "X3", qty: 1 }], total_hint: null },
  }));
  assert.equal(payload.score, 9);
  assert.deepEqual(payload.order.items, [{ name: "X3", qty: 1 }]);
  assert.equal(parseScorePayload(JSON.stringify({ score: 5 })).order, null, "ไม่มี order = null");
});

/* ------------------------------- DB + capture ------------------------------- */

test("orders DB: CRUD + CAS + counts + stats + แก้ได้เฉพาะร่าง", () => {
  const db = memoryDb();
  db.upsertCustomer("U-o", { displayName: "คุณเอ" });
  const order = db.createOrder({
    customerId: "U-o", items: [{ name: "X3", qty: 1, price: 9900 }], total: 9900, createdBy: "nok",
  });
  assert.equal(order.status, "draft");
  assert.equal(order.order_no, 1, "เลขออเดอร์ที่คนอ่าน = rowid");
  assert.equal(order.display_name, "คุณเอ", "join ชื่อลูกค้ามาให้");

  assert.ok(db.updateOrderDraft(order.id, { items: [{ name: "X5", qty: 2, price: 100 }], total: 200 }));
  assert.equal(JSON.parse(db.getOrder(order.id).items_json)[0].name, "X5");

  // CAS: from ต้องตรงของจริง
  assert.ok(!db.setOrderStatus(order.id, "confirmed", "paid"), "from ผิด = ไม่เปลี่ยน");
  assert.ok(db.setOrderStatus(order.id, "draft", "confirmed"));
  assert.ok(!db.updateOrderDraft(order.id, { total: 999 }), "ยืนยันแล้วแก้รายการไม่ได้");

  db.createOrder({ customerId: "U-o", items: [], createdBy: "ai" });
  const counts = db.orderCounts();
  assert.equal(counts.all, 2);
  assert.equal(counts.draft, 1);
  assert.equal(counts.confirmed, 1);

  const open = db.listOpenOrdersFor("U-o");
  assert.equal(open.length, 2);
  assert.equal(db.openConfirmedOrder("U-o").id, order.id);

  const stats = db.orderStats();
  assert.equal(stats.todayCount, 2);
  assert.equal(stats.monthRevenue, 200, "นับเฉพาะยืนยันแล้วขึ้นไป");
  assert.equal(stats.openDrafts, 1);

  // ลูกค้า canary ไม่ปนทุกตัวเลข
  db.upsertCustomer("canary:synthetic", {});
  db.createOrder({ customerId: "canary:synthetic", createdBy: "ai" });
  assert.equal(db.orderCounts().all, 2);
  assert.equal(db.listOrders().length, 2);
  db.close();
});

test("maybeCaptureDraftOrder: score>=8 + order -> ร่างพร้อมราคา approve / กันซ้ำ / score ต่ำไม่สร้าง", () => {
  const db = memoryDb();
  db.upsertCustomer("U-cap", {});
  db.setApprovedPrice("X3 Pro", 15900);
  const payload = { score: 9, order: { items: [{ name: "x3 pro", qty: 2 }], total_hint: 31800 } };

  const order = maybeCaptureDraftOrder({ db, customerId: "U-cap", payload, logger: silent });
  assert.ok(order);
  assert.equal(order.status, "draft");
  assert.equal(order.created_by, "ai");
  const items = JSON.parse(order.items_json);
  assert.equal(items[0].price, 15900, "ราคามาจากตาราง approve (fuzzy match)");
  assert.equal(order.total, 31800, "รู้ราคาครบ = รวมให้เลย");
  assert.ok(db.listAudit().some((row) => row.action === "order_ai_draft" && row.target === "U-cap"));

  // มีร่างค้าง = ไม่สร้างซ้ำ
  assert.equal(maybeCaptureDraftOrder({ db, customerId: "U-cap", payload, logger: silent }), null);
  assert.equal(db.orderCounts().all, 1);

  // score ต่ำ / ไม่มี order / canary = ไม่สร้าง
  db.upsertCustomer("U-low", {});
  assert.equal(maybeCaptureDraftOrder({ db, customerId: "U-low", payload: { ...payload, score: 7 }, logger: silent }), null);
  assert.equal(maybeCaptureDraftOrder({ db, customerId: "U-low", payload: { score: 9, order: null }, logger: silent }), null);
  assert.equal(maybeCaptureDraftOrder({ db, customerId: "canary:synthetic", payload, logger: silent }), null);

  // ราคาเทียบไม่ได้ = price null + total null + คำใบ้ยอดจากแชทลงโน้ต (ไม่ตั้งเป็นยอดจริง)
  db.upsertCustomer("U-nop", {});
  const noPrice = maybeCaptureDraftOrder({
    db, customerId: "U-nop",
    payload: { score: 8, order: { items: [{ name: "รุ่นลึกลับ", qty: 1 }], total_hint: 5000 } },
    logger: silent,
  });
  assert.equal(JSON.parse(noPrice.items_json)[0].price, null);
  assert.equal(noPrice.total, null, "ห้ามใช้ตัวเลขที่ model เดาเป็นยอดจริง");
  assert.ok(noPrice.note.includes("5,000"), "ยอดจากแชทเป็นคำใบ้ในโน้ตให้คนตรวจ");
  db.close();
});

/* --------------------- pipeline: scorer -> ร่างออเดอร์ (e2e mock) --------------------- */

// stub Hermes ที่แยกคำตอบ reply กับ scorer (ดูจาก system prompt ของ scorer)
function hermesDualStub({ reply, score }) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    const isScorer = promptText(body.messages?.[0]?.content || "").includes("ระบบวิเคราะห์ความสนใจซื้อ");
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: isScorer ? score : reply } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    };
  };
  fn.calls = calls;
  return fn;
}

test("pipeline: ลูกค้าตกลงซื้อ (score 9 + order) -> ร่างออเดอร์โผล่เอง — ไม่มีข้อความถึงลูกค้าเพิ่ม", async (t) => {
  const config = testConfig();
  const db = memoryDb();
  db.setApprovedPrice("X3", 9900);
  const lineFetch = lineFetchStub();
  const hermesFetch = hermesDualStub({
    reply: "รับออเดอร์ไว้แล้วนะคะ เดี๋ยวทีมงานยืนยันอีกครั้งค่ะ",
    score: JSON.stringify({
      score: 9, trend: "up",
      order: { items: [{ name: "X3", qty: 1 }], total_hint: 9900 },
    }),
  });
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {} },
    logger: silent,
  });
  t.after(() => db.close());

  // Mirror the webhook: persist customer evidence before invoking the reply seam.
  db.upsertCustomer("U-buy", {});
  db.insertMessage({ customerId: "U-buy", direction: "in", content: "เอา X3 หนึ่งเครื่องค่ะ โอนเลยได้ไหม" });
  await app.pipeline.handleInboundText({ customerId: "U-buy", text: "เอา X3 หนึ่งเครื่องค่ะ โอนเลยได้ไหม", replyToken: "rt" });
  const order = await waitFor(() => db.openDraftOrder("U-buy"));
  assert.equal(order.created_by, "ai");
  assert.equal(JSON.parse(order.items_json)[0].price, 9900);
  const sendsAfterCapture = lineFetch.sends.length;

  // ข้อความถัดไป (ยังมีร่างค้าง, เส้นทาง AI ปกติ — คำว่า "โอนแล้ว" จะเข้า template
  // payment_review ซึ่งไม่เรียก scorer) — scorer รอบสองต้องไม่สร้างออเดอร์ซ้ำ
  db.insertMessage({ customerId: "U-buy", direction: "in", content: "ตกลงเอาตามนี้เลยค่ะ" });
  await app.pipeline.handleInboundText({ customerId: "U-buy", text: "ตกลงเอาตามนี้เลยค่ะ", replyToken: "rt2" });
  await waitFor(() => hermesFetch.calls.filter((c) =>
    promptText(c.body.messages?.[0]?.content || "").includes("ระบบวิเคราะห์ความสนใจซื้อ")).length >= 2);
  assert.equal(db.orderCounts().all, 1, "ห้ามมีร่างซ้ำ");
  assert.equal(
    lineFetch.sends.length - sendsAfterCapture, 1,
    "มีแค่ reply ปกติ — ระบบออเดอร์ห้ามส่งอะไรถึงลูกค้าเอง"
  );
});

test("pipeline: score ต่ำ (5) แม้มีก้อน order -> ไม่สร้างร่าง", async (t) => {
  const config = testConfig();
  const db = memoryDb();
  const hermesFetch = hermesDualStub({
    reply: "รับทราบค่ะ สนใจรุ่นไหนเป็นพิเศษไหมคะ",
    score: JSON.stringify({ score: 5, order: { items: [{ name: "X3", qty: 1 }] } }),
  });
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  t.after(() => db.close());
  db.upsertCustomer("U-maybe", {});
  db.insertMessage({ customerId: "U-maybe", direction: "in", content: "ขอดูก่อนนะคะ" });
  await app.pipeline.handleInboundText({ customerId: "U-maybe", text: "ขอดูก่อนนะคะ", replyToken: "rt" });
  await waitFor(() => db.getCustomer("U-maybe")?.last_score === 5);
  assert.equal(db.orderCounts().all, 0);
});

/* ----------------------------- slip <-> order matching ----------------------------- */

function slipFetchStub({ amount }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/content")) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
    return { ok: true, status: 200, json: async () => ({ valid: true, amount }) };
  };
  fn.calls = calls;
  return fn;
}

test("slip-order: สลิปมาถึงตอนมีออเดอร์ confirmed -> แนบ slip_check_id + สรุปยอดตรง/ไม่ตรง", async () => {
  const config = createConfig({
    LINE_MOCK_URL: "http://line.mock", SLIP_CHECK_URL: "http://slip.check", DB_FILE: ":memory:",
  });
  const db = memoryDb();
  db.upsertCustomer("U-slip", {});
  const order = db.createOrder({ customerId: "U-slip", items: [{ name: "X3", qty: 1, price: 12900 }], total: 12900 });
  db.setOrderStatus(order.id, "draft", "confirmed");

  // เคสยอดตรง
  const okChecker = createSlipChecker({ config, db, fetchImpl: slipFetchStub({ amount: 12900 }), logger: silent });
  const okResult = await okChecker.checkImage({ customerId: "U-slip", messageId: "m1" });
  assert.equal(okResult.status, "valid");
  const linked = db.getOrder(order.id);
  assert.ok(linked.slip_check_id, "ต้องแนบผลตรวจเข้าออเดอร์");
  assert.ok(db.getCustomer("U-slip").handoff_summary.includes(`ยอดตรงออเดอร์ #${order.order_no} ✅`));

  // เคสยอดไม่ตรง (ออเดอร์ใหม่)
  db.upsertCustomer("U-slip2", {});
  const order2 = db.createOrder({ customerId: "U-slip2", items: [], total: 15900 });
  db.setOrderStatus(order2.id, "draft", "confirmed");
  const badChecker = createSlipChecker({ config, db, fetchImpl: slipFetchStub({ amount: 12000 }), logger: silent });
  await badChecker.checkImage({ customerId: "U-slip2", messageId: "m2" });
  const summary2 = db.getCustomer("U-slip2").handoff_summary;
  assert.ok(summary2.includes(`ยอดไม่ตรงออเดอร์ #${order2.order_no} ⚠️`), summary2);
  assert.ok(summary2.includes("คาด 15,900 ได้ 12,000"));

  // ไม่มีออเดอร์ confirmed = พฤติกรรมเดิมทุกอย่าง (ไม่มีบรรทัดออเดอร์)
  db.upsertCustomer("U-noorder", {});
  const plainChecker = createSlipChecker({ config, db, fetchImpl: slipFetchStub({ amount: 500 }), logger: silent });
  await plainChecker.checkImage({ customerId: "U-noorder", messageId: "m3" });
  assert.ok(!db.getCustomer("U-noorder").handoff_summary.includes("ออเดอร์"));
  db.close();
});

/* ------------------------------- order webhook ------------------------------- */

test("createOrderWebhook: ไม่มี env = ปิดสนิท / มี env = POST payload ครบ + bearer / พัง = ไม่ throw", async () => {
  const offCalls = [];
  const off = createOrderWebhook({
    config: createConfig({ DB_FILE: ":memory:" }),
    fetchImpl: async (...args) => { offCalls.push(args); return { ok: true }; },
    logger: silent,
  });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.fireStatusChange({ order: {} }), { skipped: "disabled" });
  assert.equal(offCalls.length, 0, "ปิดอยู่ห้ามยิงอะไรเลย");

  const calls = [];
  const hook = createOrderWebhook({
    config: createConfig({ DB_FILE: ":memory:", ORDER_WEBHOOK_URL: "http://bridge.example/hook", ORDER_WEBHOOK_TOKEN: "tok-1" }),
    fetchImpl: async (url, opts) => {
      calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    },
    logger: silent,
  });
  const order = {
    id: "oid-1", order_no: 7, status: "confirmed", total: 12900,
    items_json: JSON.stringify([{ name: "X3", qty: 1, price: 12900 }]),
  };
  const result = await hook.fireStatusChange({ order, customerName: "คุณเอ", channelName: "สาขาเอ" });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "http://bridge.example/hook");
  assert.equal(calls[0].headers.authorization, "Bearer tok-1");
  assert.equal(calls[0].body.orderId, "oid-1");
  assert.equal(calls[0].body.orderNo, 7);
  assert.equal(calls[0].body.status, "confirmed");
  assert.deepEqual(calls[0].body.customer, { name: "คุณเอ", channel: "สาขาเอ" });
  assert.equal(calls[0].body.items[0].name, "X3");
  assert.equal(calls[0].body.total, 12900);
  assert.ok(Number.isFinite(calls[0].body.ts));

  const broken = createOrderWebhook({
    config: createConfig({ DB_FILE: ":memory:", ORDER_WEBHOOK_URL: "http://down.example" }),
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    logger: silent,
  });
  const failed = await broken.fireStatusChange({ order });
  assert.equal(failed.ok, false, "พัง = คืน ok:false ห้าม throw");
});

/* ------------------------------- console API ------------------------------- */

async function startConsole(t, extraEnv = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, ...extraEnv });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const webhookCalls = [];
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      orderWebhookFetch: async (url, opts) => {
        webhookCalls.push({ url: String(url), body: JSON.parse(opts.body) });
        return { ok: true, status: 200 };
      },
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, webhookCalls };
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

test("orders API: ไม่มี session = 401, mutation ไม่มี CSRF = 403", async (t) => {
  const { app, db } = await startConsole(t);
  assert.equal((await httpRequest(app.server, { path: "/console/api/orders" })).status, 401);
  assert.equal((await httpRequest(app.server, { path: "/console/api/orders/export" })).status, 401);

  const { cookie } = await login(app.server);
  db.upsertCustomer("U-c", {});
  const order = db.createOrder({ customerId: "U-c", createdBy: "ai" });
  for (const [path, body] of [
    ["/console/api/orders", { customerId: "U-c" }],
    [`/console/api/orders/${order.id}`, { note: "x" }],
    [`/console/api/orders/${order.id}/status`, { status: "confirmed" }],
  ]) {
    assert.equal((await postJson(app.server, path, body, { cookie })).status, 403, path);
  }
  assert.equal(db.getOrder(order.id).status, "draft", "ห้ามมี mutation เกิดขึ้น");
});

test("orders API: list+counts+filter, สร้าง, แก้ร่าง, flow ถูกกฎ + audit + webhook ยิงตอน confirm/paid", async (t) => {
  const { app, db, webhookCalls } = await startConsole(t, { ORDER_WEBHOOK_URL: "http://bridge.example/hook" });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  db.upsertCustomer("U-flow", { displayName: "คุณโฟลว์" });

  // สร้างร่าง
  const created = await postJson(app.server, "/console/api/orders",
    { customerId: "U-flow", items: [{ name: "X3", qty: 1, price: 9900 }], note: "จากแชท" }, headers);
  assert.equal(created.status, 200);
  const id = created.json.order.id;
  assert.equal(created.json.order.created_by, "nok");
  assert.equal((await postJson(app.server, "/console/api/orders", { customerId: "U-ghost" }, headers)).status, 404);

  // แก้ร่าง
  const edited = await postJson(app.server, `/console/api/orders/${id}`,
    { items: [{ name: "X3", qty: 2, price: 9900 }], total: 19800 }, headers);
  assert.equal(edited.status, 200);
  assert.equal(edited.json.order.total, 19800);
  const badItems = await postJson(app.server, `/console/api/orders/${id}`, { items: [{ name: "", qty: 1 }] }, headers);
  assert.equal(badItems.status, 400);

  // ข้ามขั้น = 409
  const skip = await postJson(app.server, `/console/api/orders/${id}/status`, { status: "paid" }, headers);
  assert.equal(skip.status, 409, "draft -> paid ต้องผ่าน confirmed ก่อน");

  // draft -> confirmed: audit + webhook
  const confirm = await postJson(app.server, `/console/api/orders/${id}/status`, { status: "confirmed" }, headers);
  assert.equal(confirm.status, 200);
  assert.ok(db.listAudit().some((row) => row.action === "order_status" && row.detail.includes("draft -> confirmed")));
  await waitFor(() => webhookCalls.length === 1);
  assert.equal(webhookCalls[0].body.status, "confirmed");
  assert.equal(webhookCalls[0].body.customer.name, "คุณโฟลว์");

  // ยืนยันแล้วแก้รายการไม่ได้
  assert.equal((await postJson(app.server, `/console/api/orders/${id}`, { total: 5 }, headers)).status, 409);

  // confirmed -> paid: webhook ยิงอีกรอบ / paid -> shipped -> done: ไม่ยิงเพิ่ม
  assert.equal((await postJson(app.server, `/console/api/orders/${id}/status`, { status: "paid" }, headers)).status, 200);
  await waitFor(() => webhookCalls.length === 2);
  assert.equal(webhookCalls[1].body.status, "paid");
  assert.equal((await postJson(app.server, `/console/api/orders/${id}/status`, { status: "shipped" }, headers)).status, 200);
  assert.equal((await postJson(app.server, `/console/api/orders/${id}/status`, { status: "done" }, headers)).status, 200);
  assert.equal(webhookCalls.length, 2, "shipped/done ไม่ยิง webhook");

  // จบแล้วยกเลิกไม่ได้ / ยกเลิกจาก confirmed ได้
  assert.equal((await postJson(app.server, `/console/api/orders/${id}/status`, { status: "cancelled" }, headers)).status, 409);
  const o2 = db.createOrder({ customerId: "U-flow", createdBy: "ai" });
  db.setOrderStatus(o2.id, "draft", "confirmed");
  assert.equal((await postJson(app.server, `/console/api/orders/${o2.id}/status`, { status: "cancelled" }, headers)).status, 200);

  // list + counts + filter
  const list = await httpRequest(app.server, { path: "/console/api/orders", headers: { cookie } });
  assert.equal(list.json.orders.length, 2);
  assert.equal(list.json.counts.done, 1);
  assert.equal(list.json.counts.cancelled, 1);
  const doneOnly = await httpRequest(app.server, { path: "/console/api/orders?status=done", headers: { cookie } });
  assert.equal(doneOnly.json.orders.length, 1);
  assert.equal((await httpRequest(app.server, { path: "/console/api/orders?status=weird", headers: { cookie } })).status, 400);
});

test("orders API: ไม่ตั้ง ORDER_WEBHOOK_URL = confirm แล้วไม่ยิงอะไรเลย (fail-closed)", async (t) => {
  const { app, db, webhookCalls } = await startConsole(t); // ไม่มี env
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  db.upsertCustomer("U-off", {});
  const order = db.createOrder({ customerId: "U-off", createdBy: "ai" });
  assert.equal((await postJson(app.server, `/console/api/orders/${order.id}/status`, { status: "confirmed" }, headers)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30)); // ให้ macrotask ของ webhook (ถ้ามี) ได้วิ่ง
  assert.equal(webhookCalls.length, 0);
});

test("orders ในหน้าแชท + overview: conversations คืน orders ค้าง / overview มีการ์ดออเดอร์", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie } = await login(app.server);
  db.upsertCustomer("U-panel", {});
  db.insertMessage({ customerId: "U-panel", direction: "in", content: "สวัสดี" });
  const order = db.createOrder({ customerId: "U-panel", items: [{ name: "X3", qty: 1, price: 100 }], total: 100 });
  db.setOrderStatus(order.id, "draft", "confirmed");

  const convo = await httpRequest(app.server, {
    path: `/console/api/conversations/${encodeURIComponent("U-panel")}/messages`, headers: { cookie },
  });
  assert.equal(convo.status, 200);
  assert.equal(convo.json.orders.length, 1);
  assert.equal(convo.json.orders[0].status, "confirmed");

  const overview = await httpRequest(app.server, { path: "/console/api/overview", headers: { cookie } });
  assert.equal(overview.status, 200);
  assert.equal(overview.json.orders.todayCount, 1);
  assert.equal(overview.json.orders.monthRevenue, 100);
});

test("orders export CSV: BOM + header + formula-injection-safe + audit", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie } = await login(app.server);
  db.upsertCustomer("U-csv", { displayName: "คุณซี" });
  db.createOrder({
    customerId: "U-csv",
    items: [{ name: "=HYPERLINK(\"http://evil\")", qty: 1, price: null }],
    note: "+ยอดพิเศษ", createdBy: "nok",
  });

  const res = await httpRequest(app.server, { path: "/console/api/orders/export", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.ok(res.headers["content-type"].includes("text/csv"));
  assert.ok(res.headers["content-disposition"].includes("orders-all-"));
  assert.ok(res.text.startsWith("﻿"), "ต้องมี BOM ให้ Excel ไทย");
  const lines = res.text.trim().split("\r\n");
  assert.ok(lines[0].includes("เลขออเดอร์") && lines[0].includes("สาขา"));
  assert.ok(lines[1].includes("\"'=HYPERLINK"), "เซลล์ขึ้นต้น = ต้องถูกกัน formula injection");
  assert.ok(lines[1].includes("'+ยอดพิเศษ"), "โน้ตขึ้นต้น + ก็ต้องถูกกัน");
  assert.ok(db.listAudit().some((row) => row.action === "orders_export" && row.detail.includes("rows=1")));

  assert.equal(
    (await httpRequest(app.server, { path: "/console/api/orders/export?month=2026-13", headers: { cookie } })).status,
    400, "month ผิดรูปแบบ = 400"
  );
});

// regression เคสจริง 2026-08-10: "Airdog X3Pro" เคยถูกจับคู่ราคาประกันแพ็คคู่ 2,790
test("resolveApprovedPrice: ชื่อสินค้าเพียวต้องได้ราคาสินค้า ไม่ใช่ประกัน/คูปอง/แพ็คพ่วง", () => {
  const prices = [
    { label: "Airdog X3 Pro (White)", amount: 21900 },
    { label: "Airdog X3 Pro (White) Pack 2", amount: 38500 },
    { label: "Airdog X3 Pro (White) คูปองลด", amount: 500 },
    { label: "Airdog X3 Pro (White) ราคาซื้อการรับประกันเพิ่ม 3 ปี", amount: 1095 },
    { label: "Airdog X3 Pro (White) + Airdog X5 Pro (White) ราคาซื้อการรับประกันเพิ่ม 3 ปี", amount: 2790 },
  ];
  assert.equal(resolveApprovedPrice(prices, "Airdog X3Pro"), 21900, "ต้องได้ราคาสินค้าจริง");
  assert.equal(
    resolveApprovedPrice(prices, "Airdog X3 Pro (White) ราคาซื้อการรับประกันเพิ่ม 3 ปี"),
    1095,
    "เอ่ยประกันเองแบบเต็มชื่อ = จับคู่ประกันได้ (exact)",
  );
  assert.equal(resolveApprovedPrice(prices, "เครื่องซักผ้า"), null, "ไม่เจอ = null ให้คนเติม");
});

// REVIEW FIX v1.1 (atomic): non-draft + ขอแก้ items/total/note มาพร้อม shipping
// = ปฏิเสธทั้งก้อนก่อนแตะอะไร — ห้ามมี partial write แล้วตอบ error
test("orders API: combined patch บนออเดอร์ non-draft = 409 ทั้งก้อน shipping ต้องไม่ถูกเขียน", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  db.upsertCustomer("U-atomic", {});
  const order = db.createOrder({
    customerId: "U-atomic", items: [{ name: "X3", qty: 1, price: 100 }], total: 100,
    shipping: { name: "เดิม", phone: "0812345678", address: "", email: "" }, createdBy: "nok",
  });
  db.setOrderStatus(order.id, "draft", "confirmed");

  const res = await postJson(app.server, `/console/api/orders/${order.id}`,
    { shipping: { name: "ใหม่", phone: "0899999999", address: "", email: "" }, total: 999 }, headers);
  assert.equal(res.status, 409, "non-draft + total = ปฏิเสธทั้งก้อน");
  const fresh = db.getOrder(order.id);
  assert.equal(JSON.parse(fresh.shipping_json).name, "เดิม", "shipping ห้ามถูกเขียนแม้แต่นิดเดียว");
  assert.equal(fresh.total, 100, "total นิ่งตามเดิม");

  // shipping ล้วน ๆ บน confirmed ยังแก้ได้ตามกติกา (source = human)
  const shipOnly = await postJson(app.server, `/console/api/orders/${order.id}`,
    { shipping: { name: "ใหม่", phone: "0899999999", address: "", email: "" } }, headers);
  assert.equal(shipOnly.status, 200);
  assert.equal(JSON.parse(db.getOrder(order.id).shipping_json).name, "ใหม่");
  assert.equal(db.getOrder(order.id).shipping_source, "human");
});
