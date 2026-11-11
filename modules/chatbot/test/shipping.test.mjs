// shipping.test.mjs — v1.1: ตัวตรวจข้อมูลจัดส่งไทย + จับ shipping เข้าออเดอร์
// เคสอ้างอิงจากบทสนทนาจริง (ลูกค้า A 2026-08-10): เบอร์ 9 หลัก + อีเมล gmail.con
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeShipping, checkThaiPhone, checkThaiPostal, checkEmail,
  shippingWarnings, shippingLabel, parseShippingJson,
} from "../src/shipping.mjs";
import { maybeCaptureDraftOrder } from "../src/orders.mjs";
import { memoryDb } from "./helpers.mjs";

/* ------------------------------- ตัวตรวจรายช่อง ------------------------------ */

test("checkThaiPhone: มือถือ 10 หลัก/บ้าน 9 หลัก ผ่าน — 9 หลักแบบมือถือ (เคสจริง) โดนเตือน", () => {
  assert.equal(checkThaiPhone("0812345678").ok, true, "มือถือ 10 หลัก");
  assert.equal(checkThaiPhone("081-234-5678").ok, true, "มีขีดคั่น = ปกติ");
  assert.equal(checkThaiPhone("+66812345678").ok, true, "+66 แปลงเป็น 0");
  assert.equal(checkThaiPhone("021234567").ok, true, "เบอร์บ้าน กทม. 9 หลัก");
  const bad = checkThaiPhone("081234567"); // เคสจริง — ลูกค้าพิมพ์ตกหนึ่งหลัก
  assert.equal(bad.ok, false);
  assert.match(bad.warning, /9 หลัก/, "ต้องบอกชัดว่ามีกี่หลัก");
  assert.equal(checkThaiPhone("").warning, null, "ช่องว่าง = ไม่เตือน (คนตัดสินเอง)");
  assert.equal(checkThaiPhone("1112223334").ok, false, "ไม่ขึ้นต้น 0 = ไม่ใช่เบอร์ไทย");
});

test("checkThaiPostal: 5 หลัก 10xxx-96xxx เท่านั้น", () => {
  assert.equal(checkThaiPostal("10540").ok, true);
  assert.equal(checkThaiPostal("96110").ok, true);
  assert.equal(checkThaiPostal("00540").ok, false, "ต่ำกว่า 10xxx");
  assert.equal(checkThaiPostal("1054").ok, false, "4 หลัก");
  assert.equal(checkThaiPostal("").warning, null);
});

test("checkEmail: จับโดเมนพิมพ์ผิดยอดฮิต (เคสจริง gmail.con) พร้อมคำที่น่าจะตั้งใจ", () => {
  assert.equal(checkEmail("somchai.test@gmail.com").ok, true);
  const typo = checkEmail("somchai.test@gmail.con");
  assert.equal(typo.ok, false);
  assert.match(typo.warning, /gmail\.com/, "ต้องเสนอโดเมนที่ถูก");
  assert.equal(checkEmail("ไม่ใช่อีเมล").ok, false);
  assert.equal(checkEmail("").warning, null);
});

test("shippingWarnings: ที่อยู่จริงครบ = ไม่เตือน / ขาดจังหวัด-ปณ. = เตือน / ว่างหมด = []", () => {
  assert.deepEqual(shippingWarnings({
    name: "สมศักดิ์ ทดสอบ", phone: "0812345678",
    address: "99/9 ถนนทดสอบ แขวงทดสอบ เขตทดสอบ กรุงเทพฯ 10110",
    email: "somchai.test@gmail.com",
  }), [], "ข้อมูลจริงที่ถูกครบ ห้ามเตือนสักข้อ");
  const warnings = shippingWarnings({ phone: "081234567", address: "99/9 ถนนทดสอบ", email: "a@gmail.con" });
  assert.equal(warnings.length, 4, "เบอร์ 9 หลัก + อีเมล typo + ไม่มี ปณ. + ไม่มีจังหวัด = 4 เตือน");
  assert.deepEqual(shippingWarnings(null), []);
  assert.deepEqual(shippingWarnings({}), []);
});

test("normalizeShipping + label + parse json: sanitize/round-trip", () => {
  assert.equal(normalizeShipping({ name: "  ", phone: "" }), null, "ว่างหมด = null");
  assert.equal(normalizeShipping("x"), null);
  const s = normalizeShipping({ name: "ก".repeat(200), phone: "081", address: "a", email: "" });
  assert.equal(s.name.length, 100, "ตัดตามเพดาน");
  assert.equal(shippingLabel({ name: "บี", phone: "0812345678" }), "บี · 0812345678");
  assert.equal(parseShippingJson("{broken"), null, "JSON พัง = null เงียบ");
  assert.deepEqual(parseShippingJson(JSON.stringify({ name: "บี" })).name, "บี");
});

/* --------------------- capture: shipping มากับ/หลังร่าง --------------------- */

function seedCustomer(db, id = "U-ship") {
  db.upsertCustomer(id, { displayName: "คุณชิป" });
  db.raw.prepare("INSERT INTO approved_prices (label, amount) VALUES (?, ?)").run("Airdog X3 Pro", 18990);
  return id;
}

test("maybeCaptureDraftOrder: ร่างใหม่แนบ shipping จาก scorer ทันที", () => {
  const db = memoryDb();
  const id = seedCustomer(db);
  const order = maybeCaptureDraftOrder({
    db, customerId: id, logger: { log() {}, debug() {} },
    payload: {
      score: 9,
      order: {
        items: [{ name: "Airdog X3 Pro", qty: 1 }], total_hint: null,
        shipping: { name: "สมศักดิ์", phone: "0812345678", address: "บางพลี สมุทรปราการ 10540", email: "" },
      },
    },
  });
  assert.ok(order, "ต้องสร้างร่าง");
  assert.equal(JSON.parse(order.shipping_json).name, "สมศักดิ์");
  db.close();
});

test("maybeCaptureDraftOrder: มีร่างค้าง + ที่อยู่มาทีหลัง = เติมเข้าร่างเดิม (เคสลูกค้า A) + เตือนเมื่อข้อมูลผิด", () => {
  const db = memoryDb();
  const id = seedCustomer(db);
  const logger = { log() {}, debug() {} };
  const first = maybeCaptureDraftOrder({
    db, customerId: id, logger,
    payload: { score: 9, order: { items: [{ name: "Airdog X3 Pro", qty: 1 }], total_hint: null, shipping: null } },
  });
  assert.ok(first, "ร่างแรกเกิดตอนตกลงซื้อ — ยังไม่มีที่อยู่");
  assert.equal(first.shipping_json, "");

  // scorer รอบถัดมา: ลูกค้าพิมพ์ที่อยู่แล้ว แต่เบอร์ตกหนึ่งหลัก (เคสจริง)
  const updated = maybeCaptureDraftOrder({
    db, customerId: id, logger,
    payload: {
      score: 10,
      order: {
        items: [{ name: "Airdog X3 Pro", qty: 1 }], total_hint: null,
        shipping: { name: "สมศักดิ์", phone: "081234567", address: "99/9 ถนนทดสอบ แขวงทดสอบ เขตทดสอบ กรุงเทพฯ 10110", email: "" },
      },
    },
  });
  assert.ok(updated, "ต้องอัปเดตร่างเดิม ไม่ใช่เงียบ");
  assert.equal(updated.id, first.id, "ร่างเดิม — ห้ามสร้างร่างใหม่ซ้อน");
  assert.equal(JSON.parse(updated.shipping_json).phone, "081234567");
  // เบอร์ผิดต้องมีโน้ตเตือนทีมงาน (handoff note จาก ai_auto)
  const notes = db.listHandoffNotes(id, 5);
  assert.ok(notes.some((n) => n.author === "ai_auto" && /ต้องทวน/.test(n.text)), "ต้องธงข้อมูลผิดให้คนเห็น");

  // รอบถัดไปข้อมูลเดิมเป๊ะ = จบเงียบ (ไม่เขียนซ้ำ ไม่เตือนซ้ำ)
  const same = maybeCaptureDraftOrder({
    db, customerId: id, logger,
    payload: {
      score: 10,
      order: {
        items: [{ name: "Airdog X3 Pro", qty: 1 }], total_hint: null,
        shipping: { name: "สมศักดิ์", phone: "081234567", address: "99/9 ถนนทดสอบ แขวงทดสอบ เขตทดสอบ กรุงเทพฯ 10110", email: "" },
      },
    },
  });
  assert.equal(same, null, "ข้อมูลไม่เปลี่ยน = ไม่ทำอะไร");
  assert.equal(db.listHandoffNotes(id, 10).filter((n) => /ต้องทวน/.test(n.text)).length, 1, "เตือนครั้งเดียวพอ");
  db.close();
});

test("REVIEW FIX: แอดมินแก้ shipping แล้ว (source human) — scorer ห้ามทับเด็ดขาด", () => {
  const db = memoryDb();
  const id = seedCustomer(db);
  const logger = { log() {}, debug() {} };
  // 1) scorer สร้างร่างพร้อม shipping จากแชท (เบอร์ผิด 9 หลัก)
  const draft = maybeCaptureDraftOrder({
    db, customerId: id, logger,
    payload: {
      score: 9,
      order: {
        items: [{ name: "Airdog X3 Pro", qty: 1 }], total_hint: null,
        shipping: { name: "สมศักดิ์", phone: "081234567", address: "บางพลี สมุทรปราการ 10540", email: "" },
      },
    },
  });
  assert.equal(draft.shipping_source, "ai");
  // 2) แอดมินโทรหาลูกค้า ได้เบอร์ที่ถูก แล้วแก้จาก console (source = human)
  assert.equal(db.updateOrderShipping(draft.id, { name: "สมศักดิ์", phone: "0812345678", address: "บางพลี สมุทรปราการ 10540", email: "" }, "human"), true);
  // 3) ลูกค้าพิมพ์ "ขอบคุณครับ" -> scorer รอบใหม่ยังเห็นเบอร์ผิดเดิมในแชท -> ต้องไม่ทับ
  const overwritten = maybeCaptureDraftOrder({
    db, customerId: id, logger,
    payload: {
      score: 10,
      order: {
        items: [{ name: "Airdog X3 Pro", qty: 1 }], total_hint: null,
        shipping: { name: "สมศักดิ์", phone: "081234567", address: "บางพลี สมุทรปราการ 10540", email: "" },
      },
    },
  });
  assert.equal(overwritten, null, "human แก้แล้ว — scorer ต้องเงียบ");
  const fresh = db.getOrder(draft.id);
  assert.equal(JSON.parse(fresh.shipping_json).phone, "0812345678", "เบอร์ที่คนแก้ต้องอยู่");
  assert.equal(fresh.shipping_source, "human");
  // ชั้น SQL guard: เขียนแบบ ai ตรง ๆ ก็ต้องโดนกัน
  assert.equal(db.updateOrderShipping(draft.id, { name: "x", phone: "1", address: "", email: "" }, "ai"), false,
    "SQL guard: ai เขียนทับแถว human ไม่ได้แม้เรียกตรง");
  db.close();
});

test("updateOrderShipping: แก้ได้ถึง paid — shipped แล้วห้ามแตะ", () => {
  const db = memoryDb();
  const id = seedCustomer(db);
  const order = db.createOrder({ customerId: id, items: [{ name: "X3", qty: 1, price: 100 }], createdBy: "nok" });
  assert.equal(db.updateOrderShipping(order.id, { name: "บี", phone: "0812345678", address: "", email: "" }), true);
  db.setOrderStatus(order.id, "draft", "confirmed");
  assert.equal(db.updateOrderShipping(order.id, { name: "ซี", phone: "0812345678", address: "", email: "" }), true, "confirmed ยังแก้ได้");
  db.setOrderStatus(order.id, "confirmed", "paid");
  assert.equal(db.updateOrderShipping(order.id, null), true, "paid ยังแก้ได้ (ล้างได้)");
  db.setOrderStatus(order.id, "paid", "shipped");
  assert.equal(db.updateOrderShipping(order.id, { name: "ดี" }), false, "shipped = ที่อยู่ต้องนิ่ง");
  db.close();
});
