// tags.test.mjs — v1.1 (item 7): chat tags + RFM + กติกาสินค้าเข้า prompt
import test from "node:test";
import assert from "node:assert/strict";
import { computeRfmTags, refreshRfmTags, composeTagRules } from "../src/tags.mjs";
import { normalizeTag } from "../src/dbTags.mjs";
import { memoryDb } from "./helpers.mjs";

const DAY = 86_400_000;

function seed(db, id = "U-tag") {
  db.upsertCustomer(id, { displayName: "คุณแท็ก" });
  return id;
}

/* ------------------------------- DB methods ------------------------------- */

test("dbTags: add/list/remove — human ป้ายซ้ำไม่เบิ้ล, ทรงพังไม่เข้า", () => {
  const db = memoryDb();
  const id = seed(db);
  assert.equal(db.addTag(id, " VIP ", "human"), true, "trim แล้วเข้า");
  assert.equal(db.addTag(id, "VIP", "human"), false, "ซ้ำ = ไม่เข้า");
  assert.equal(db.addTag(id, "", "human"), false);
  assert.equal(db.addTag(id, "x", "hacker"), false, "source นอกลิสต์ = ไม่เข้า");
  assert.equal(db.listTags(id).length, 1);
  assert.equal(db.removeTag(id, "VIP"), true);
  assert.equal(db.listTags(id).length, 0);
  db.close();
});

test("dbTags: replaceSourceTags เขียนทับเฉพาะ source ระบบ — ป้าย human ไม่โดนแตะ", () => {
  const db = memoryDb();
  const id = seed(db);
  db.addTag(id, "VIP", "human");
  db.replaceSourceTags(id, "ai", ["สนใจ X5", "ถามผ่อน 0%"]);
  db.replaceSourceTags(id, "ai", ["สนใจ X8"]); // รอบใหม่ทับชุดเก่า
  const tags = db.listTags(id);
  assert.deepEqual(tags.map((t) => t.tag).sort(), ["VIP", "สนใจ X8"].sort());
  assert.equal(db.replaceSourceTags(id, "human", []), false, "ห้ามใช้กับ human เด็ดขาด");
  assert.equal(db.listTags(id).some((t) => t.tag === "VIP"), true);
  db.close();
});

test("dbTags: listCustomersByTag + tagSummary — ฐาน segment broadcast (ไม่นับ canary)", () => {
  const db = memoryDb();
  const a = seed(db, "U-a");
  const b = seed(db, "U-b");
  db.upsertCustomer("canary:x", {});
  db.addTag(a, "ซื้อซ้ำ (2 ครั้ง)", "rfm");
  db.addTag(b, "ซื้อซ้ำ (2 ครั้ง)", "rfm");
  db.addTag("canary:x", "ซื้อซ้ำ (2 ครั้ง)", "rfm");
  assert.equal(db.listCustomersByTag("ซื้อซ้ำ (2 ครั้ง)").length, 2, "canary ไม่ปน");
  const summary = db.tagSummary();
  assert.equal(summary[0].tag, "ซื้อซ้ำ (2 ครั้ง)");
  assert.equal(summary[0].customer_count, 2);
  db.close();
});

/* --------------------------------- RFM --------------------------------- */

test("computeRfmTags: ครบ 4 แกนตามหลักพี่ง้วง — กี่ครั้ง/เมื่อไหร่/สินค้าอะไร/AOV", () => {
  const db = memoryDb();
  const id = seed(db);
  const now = Date.now();
  // ซื้อจริง 2 ครั้ง: X3 (60 วันก่อน) + X8 (5 วันก่อน) — ร่าง/ยกเลิกต้องไม่นับ
  const o1 = db.createOrder({ customerId: id, items: [{ name: "Airdog X3 Pro", qty: 1, price: 18990 }], total: 18990, createdBy: "nok" });
  db.raw.prepare("UPDATE orders SET status = 'done', created_at = ? WHERE id = ?").run(now - 60 * DAY, o1.id);
  const o2 = db.createOrder({ customerId: id, items: [{ name: "Airdog X8 Pro Ultra", qty: 1, price: 63900 }], total: 63900, createdBy: "nok" });
  db.raw.prepare("UPDATE orders SET status = 'paid', created_at = ? WHERE id = ?").run(now - 5 * DAY, o2.id);
  db.createOrder({ customerId: id, items: [{ name: "ร่างที่ไม่ได้ซื้อ", qty: 1 }], createdBy: "ai" }); // draft — ไม่นับ

  const tags = computeRfmTags(db, id, { now: () => now });
  assert.ok(tags.includes("ซื้อซ้ำ (2 ครั้ง)"), `frequency: ${tags}`);
  assert.ok(tags.includes("ซื้อล่าสุดใน 30 วัน"), `recency: ${tags}`);
  assert.ok(tags.includes("ซื้อแล้ว: Airdog X8 Pro Ultra"), `product ล่าสุดก่อน: ${tags}`);
  assert.ok(tags.includes("ซื้อแล้ว: Airdog X3 Pro"), `product: ${tags}`);
  assert.ok(tags.includes("AOV สูงมาก (฿50,000+)") === false, "AOV เฉลี่ย 41,445 = สูง ไม่ใช่สูงมาก");
  assert.ok(tags.includes("AOV สูง (฿20,000-49,999)"), `AOV: ${tags}`);
  db.close();
});

test("computeRfmTags: ยังไม่เคยซื้อ = [] / refreshRfmTags เขียนทับชุด rfm + ข้าม canary", () => {
  const db = memoryDb();
  const id = seed(db);
  assert.deepEqual(computeRfmTags(db, id), [], "มีแต่ร่าง/ไม่มีออเดอร์ = ไม่มีป้าย");
  const order = db.createOrder({ customerId: id, items: [{ name: "X3", qty: 1, price: 100 }], total: 100, createdBy: "nok" });
  db.setOrderStatus(order.id, "draft", "confirmed");
  assert.equal(refreshRfmTags(db, id, { logger: { debug() {} } }), true);
  const tags = db.listTags(id);
  assert.ok(tags.some((t) => t.tag === "ซื้อแล้ว 1 ครั้ง (ลูกค้าใหม่)" && t.source === "rfm"));
  assert.equal(refreshRfmTags(db, "canary:x"), false);
  db.close();
});

/* ---------------------------- prompt composition ---------------------------- */

test("composeTagRules: ป้าย + กติกาห้ามขายซ้ำ + กติกาสินค้าจากทีม — ว่างหมด = []", () => {
  assert.deepEqual(composeTagRules({}), []);
  const lines = composeTagRules({
    tags: [{ tag: "ซื้อแล้ว: Airdog X3 Pro" }, { tag: "AOV สูง (฿20,000-49,999)" }],
    productRules: "ลูกค้าซื้อ X3 แล้ว เสนอไส้กรองแทน\n- ลูกค้าใหม่อย่ายิงสเปกทันที",
  });
  assert.match(lines[0], /ป้ายลูกค้า.*ซื้อแล้ว: Airdog X3 Pro/);
  assert.ok(lines.some((l) => /ห้ามเสนอขายตัวเดิมซ้ำ/.test(l)), "มีป้ายซื้อแล้ว = กติกากันขายซ้ำโผล่");
  assert.ok(lines.some((l) => /กติกาสินค้าจากทีมงาน/.test(l)));
  assert.ok(lines.some((l) => l === "- ลูกค้าซื้อ X3 แล้ว เสนอไส้กรองแทน"), "บรรทัดไม่มี dash ถูกเติมให้");
  const noBuy = composeTagRules({ tags: [{ tag: "สนใจ X5" }] });
  assert.equal(noBuy.some((l) => /ห้ามเสนอขายตัวเดิมซ้ำ/.test(l)), false, "ไม่มีป้ายซื้อแล้ว = ไม่ต้องมีกติกาขายซ้ำ");
});

test("normalizeTag: trim/ยุบช่องว่าง/ตัดความยาว", () => {
  assert.equal(normalizeTag("  สนใจ   X5  "), "สนใจ X5");
  assert.equal(normalizeTag("ก".repeat(100)).length, 60);
  assert.equal(normalizeTag(null), "");
});
