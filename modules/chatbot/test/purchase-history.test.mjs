// purchase-history.test.mjs — "ซื้อครั้งที่" + "ซื้อล่าสุด" (คำสั่งพี่ง้วง 28 ก.ย. 2026) และ RFM ที่ต่อยอดจากตัวเดิม
// กติกากันนับซ้ำ: ออเดอร์ที่เดือน <= ป้ายเดือนของ LINE OA เดิม ถือว่าอยู่ในจำนวนครั้งของป้ายเดิมแล้ว (สูงสุดเท่าจำนวนนั้น)
import test from "node:test";
import assert from "node:assert/strict";
import {
  bangkokMonthKey, formatPurchaseMonth, isPurchaseEvidenceTag, parseCountTag, parseThaiMonthTag, purchaseTagsFor,
  summarizePurchases,
} from "../src/purchaseHistory.mjs";
import { computeRfmTags, refreshRfmTags, rfmTagsFromData } from "../src/tags.mjs";
import { validateTagFramework } from "../src/tagFramework.mjs";
import { fixtureInput, fixtureWithPurchase } from "./tagFrameworkFixture.mjs";
import { memoryDb } from "./helpers.mjs";

const fw = validateTagFramework(fixtureWithPurchase());
const purchase = fw.purchase;
// เที่ยงวันตามเวลาไทยของวันที่ให้ (เดือนนับ 1-12)
const bkk = (year, month, day = 15) => Date.UTC(year, month - 1, day, 5);

test("purchase history: Thai month tags from the old LINE OA parse to a month (CE or BE year, with or without dots)", () => {
  assert.equal(parseThaiMonthTag("ม.ค.2023"), "2023-01");
  assert.equal(parseThaiMonthTag("ก.ค. 2026"), "2026-07");
  assert.equal(parseThaiMonthTag("มค2023"), "2023-01", "รูปแบบที่พี่ง้วงพิมพ์ในแชท");
  assert.equal(parseThaiMonthTag("มี.ค.2566"), "2023-03", "ปี พ.ศ.");
  assert.equal(parseThaiMonthTag("เม.ย.2025"), "2025-04");
  assert.equal(parseThaiMonthTag("มิ.ย.2024"), "2024-06");
  assert.equal(parseThaiMonthTag("ธ.ค.2022"), "2022-12");
  for (const notMonth of ["26 ก.ย. 2026", "รอบ 12 ก.ย. 2026", "XAI (31AUG2025)", "ก.ย.", "MOS2026", "Sep2026", ""]) {
    assert.equal(parseThaiMonthTag(notMonth), "", notMonth);
  }
});

test("purchase history: count tags read the old ordinal words or a digit", () => {
  assert.equal(parseCountTag("ซื้อครั้งแรก", purchase.countTags), 1);
  assert.equal(parseCountTag("ซื้อครั้งที่สาม", purchase.countTags), 3);
  assert.equal(parseCountTag("ซื้อครั้งที่ 4", purchase.countTags), 4);
  assert.equal(parseCountTag("ซื้อแล้ว 1 ครั้ง (ลูกค้าใหม่)", purchase.countTags), 0, "ป้าย rfm แบบเดิมไม่ใช่หลักฐานของคน");
  assert.ok(isPurchaseEvidenceTag("ม.ค.2023", purchase));
  assert.ok(isPurchaseEvidenceTag("ซื้อครั้งที่สอง", purchase));
  assert.ok(!isPurchaseEvidenceTag("VIP", purchase));
  assert.ok(!isPurchaseEvidenceTag("ม.ค.2023", null), "ไม่มีกรอบ = ไม่มีการคำนวณ");
});

test("purchase history: months are Bangkok months and render like the owner's example (Sep2026)", () => {
  assert.equal(bangkokMonthKey(Date.UTC(2026, 8, 30, 17, 30)), "2026-10", "30 ก.ย. 17:30 UTC = 1 ต.ค. เวลาไทย");
  assert.equal(bangkokMonthKey(Date.UTC(2026, 8, 30, 16, 30)), "2026-09");
  assert.equal(formatPurchaseMonth("2026-09"), "Sep2026");
  assert.equal(formatPurchaseMonth("2023-01"), "Jan2023");
  assert.equal(formatPurchaseMonth("2026-13"), "");
});

const summary = (orders, tags) => summarizePurchases({ orderTimes: orders, humanTags: tags, purchase });

test("purchase history: each source alone", () => {
  assert.deepEqual([summary([bkk(2026, 9), bkk(2026, 9, 20)], []).count, summary([bkk(2026, 9)], []).lastMonth], [2, "2026-09"]);
  const history = summary([], ["ซื้อครั้งที่สอง", "ม.ค.2023"]);
  assert.deepEqual([history.count, history.lastMonth], [2, "2023-01"], "ป้ายเดือนของระบบเดิม = เดือนที่ซื้อล่าสุด");
  const monthOnly = summary([], ["ส.ค.2026"]);
  assert.deepEqual([monthOnly.count, monthOnly.lastMonth], [1, "2026-08"], "มีแต่ป้ายเดือน = ซื้อ 1 ครั้งในเดือนนั้น");
  const countOnly = summary([], ["ซื้อครั้งแรก"]);
  assert.deepEqual([countOnly.count, countOnly.lastMonth, countOnly.flags.noDate], [1, "", true], "รู้ว่าซื้อแต่ไม่รู้เดือน = ไม่ติดซื้อล่าสุด");
  assert.deepEqual(summary([], ["VIP"]), {
    count: 0, lastMonth: "", historyCount: 0, historyMonth: "", orders: 0,
    flags: { bothSources: false, absorbedOrders: 0, adjacentMonth: false, countWithoutMonthAndOrders: false, noDate: false, monthsExceedCount: false, markerOnly: false },
  });
});

test("purchase history: an order in (or before) the history month is the same purchase — never counted twice", () => {
  const same = summary([bkk(2026, 9)], ["ซื้อครั้งแรก", "ก.ย.2026"]);
  assert.deepEqual([same.count, same.lastMonth, same.flags.absorbedOrders], [1, "2026-09", 1]);
  const earlier = summary([bkk(2026, 7)], ["ซื้อครั้งที่สอง", "ส.ค.2026"]);
  assert.deepEqual([earlier.count, earlier.lastMonth], [2, "2026-08"], "ออเดอร์ก่อนป้ายเดือน = หนึ่งในสองครั้งของป้ายเดิม");
  const twoInMonth = summary([bkk(2026, 9, 3), bkk(2026, 9, 25)], ["ซื้อครั้งแรก", "ก.ย.2026"]);
  assert.equal(twoInMonth.count, 2, "ออเดอร์เกินจำนวนในป้ายเดิม = นับเพิ่ม");
});

test("purchase history: orders after the history month add up; the next month is flagged as possibly the same purchase", () => {
  const next = summary([bkk(2026, 9)], ["ซื้อครั้งแรก", "ส.ค.2026"]);
  assert.deepEqual([next.count, next.lastMonth, next.flags.bothSources, next.flags.adjacentMonth], [2, "2026-09", true, true]);
  const later = summary([bkk(2026, 9)], ["ซื้อครั้งแรก", "ม.ค.2023"]);
  assert.deepEqual([later.count, later.flags.adjacentMonth], [2, false]);
  const decemberToJanuary = summary([bkk(2026, 1)], ["ซื้อครั้งแรก", "ธ.ค.2025"]);
  assert.equal(decemberToJanuary.flags.adjacentMonth, true, "ข้ามปี");
  const noMonth = summary([bkk(2026, 9)], ["ซื้อครั้งแรก"]);
  assert.deepEqual([noMonth.count, noMonth.lastMonth, noMonth.flags.countWithoutMonthAndOrders], [2, "2026-09", true],
    "ไม่มีป้ายเดือน = ถือว่าป้ายเดิมเก่ากว่าออเดอร์ (นับเป็นกรณีกำกวม)");
  const odd = summary([], ["ซื้อครั้งแรก", "ม.ค.2023", "ส.ค.2026"]);
  assert.deepEqual([odd.count, odd.lastMonth, odd.flags.monthsExceedCount], [2, "2026-08", true]);
});

test("purchase history: a broken order time is skipped — never a phantom purchase in Jan 1970", () => {
  const broken = summary([0, Number.NaN, bkk(2026, 9)], []);
  assert.deepEqual([broken.count, broken.lastMonth, broken.orders], [1, "2026-09", 1]);
});

test("purchase history: tags are one value per dimension and nothing when there was no purchase", () => {
  assert.deepEqual(purchaseTagsFor(summary([bkk(2026, 9)], ["ซื้อครั้งแรก", "ส.ค.2026"]), purchase), ["ซื้อครั้งที่: 2", "ซื้อล่าสุด: Sep2026"]);
  assert.deepEqual(purchaseTagsFor(summary([], ["ซื้อครั้งแรก"]), purchase), ["ซื้อครั้งที่: 1"]);
  assert.deepEqual(purchaseTagsFor(summary([], []), purchase), []);
  assert.deepEqual(purchaseTagsFor(summary([bkk(2026, 9)], []), null), []);
});

/* ------------------------------- RFM ที่ต่อยอด ------------------------------- */

const order = (status, createdAt, name = "คลาส A", total = 4900) => ({
  status, total, created_at: createdAt, items_json: JSON.stringify([{ name, qty: 1, price: total }]),
});

test("rfm: without a framework the tags are byte-for-byte the old RFM set", () => {
  const now = () => bkk(2026, 9, 20);
  assert.deepEqual(rfmTagsFromData({ orders: [order("paid", bkk(2026, 9, 10)), order("cancelled", bkk(2026, 9, 11), "คลาส B")], now }), [
    "ซื้อแล้ว 1 ครั้ง (ลูกค้าใหม่)", "ซื้อล่าสุดใน 30 วัน", "ซื้อแล้ว: คลาส A", "AOV เริ่มต้น (ต่ำกว่า ฿5,000)",
  ]);
  assert.deepEqual(rfmTagsFromData({ orders: [order("draft", bkk(2026, 9, 10))], humanTags: ["ซื้อครั้งแรก"], now }), [], "ไม่มีกรอบ = ป้ายเดิมของคนไม่ถูกอ่าน");
});

test("rfm: with the framework frequency/recency become ซื้อครั้งที่/ซื้อล่าสุด; products and AOV stay", () => {
  const tags = rfmTagsFromData({
    orders: [order("paid", bkk(2026, 9, 10)), order("done", bkk(2026, 9, 12), "คลาส B", 12900), order("cancelled", bkk(2026, 9, 13), "คลาส C")],
    humanTags: ["ซื้อครั้งแรก", "ม.ค.2023"], purchase,
  });
  assert.deepEqual(tags, ["ซื้อครั้งที่: 3", "ซื้อล่าสุด: Sep2026", "ซื้อแล้ว: คลาส B", "ซื้อแล้ว: คลาส A", "AOV กลาง (฿5,000-19,999)"]);
  assert.deepEqual(rfmTagsFromData({ orders: [], humanTags: ["ซื้อครั้งที่สอง", "ก.พ.2024"], purchase }), ["ซื้อครั้งที่: 2", "ซื้อล่าสุด: Feb2024"],
    "ประวัติ LINE OA อย่างเดียวก็ได้ป้าย (ไม่มีสินค้า/AOV เพราะไม่มีออเดอร์)");
  assert.deepEqual(rfmTagsFromData({ orders: [order("draft", bkk(2026, 9, 10))], humanTags: [], purchase }), [], "ร่างไม่ใช่การซื้อ");
});

test("rfm: only the team's history tags count — AI tags and the system's own tags are never evidence", () => {
  const db = memoryDb();
  const id = "U-rfm";
  db.upsertCustomer(id, {});
  db.addTag(id, "ซื้อครั้งที่สาม", "ai");
  db.addTag(id, "ม.ค.2023", "ai");
  db.addTag(id, "ซื้อครั้งที่: 9", "rfm");
  assert.deepEqual(computeRfmTags(db, id, { framework: fw }), []);
  db.addTag(id, "ซื้อครั้งที่สอง", "human");
  assert.ok(refreshRfmTags(db, id, { framework: fw }));
  assert.deepEqual(db.listTags(id).filter((row) => row.source === "rfm").map((row) => row.tag), ["ซื้อครั้งที่: 2"]);
  assert.ok(refreshRfmTags(db, id, { framework: validateTagFramework(fixtureInput()) }), "กรอบที่ไม่มีมิติการซื้อ = RFM แบบเดิม");
  assert.deepEqual(db.listTags(id).filter((row) => row.source === "rfm"), []);
  db.close();
});
