// สรุปเช้ากับสรุปค่ำต้องทำหน้าที่ต่างกัน
//
// คำสั่งเจ้าของ 2026-08-28: "2 อันควรเป็น useful insight จริง ๆ" — ถ้าส่งตัวเลขชุดเดียวกัน
// วันละสองรอบ อ่านสองวันก็เลิกอ่าน แล้ววันที่มีเรื่องสำคัญจริงก็จะไม่มีใครเปิด
//
//   เช้า 08:30 = "วันนี้ต้องทำอะไร"  — เรื่องที่ค้างคาคนอื่นอยู่
//   ค่ำ 20:00  = "วันนี้เกิดอะไรขึ้น" — ผลลัพธ์ และอะไรที่จะข้ามคืนไป
import test from "node:test";
import assert from "node:assert/strict";
import { buildDigestBubbles } from "../src/digest.mjs";

const NOW = Date.UTC(2026, 7, 28, 13, 0, 0); // 20:00 เวลาไทย
const SINCE = NOW - 12 * 3_600_000;
const HOUR = 3_600_000;

const baseStats = { inbound: 12, inboundCustomers: 5, newCustomers: 2, needsHuman: 3, suspectSlips: 0 };
const baseOrders = { created: 0, confirmed: 0, paid: 0, revenue: 0 };
const waiting = [
  { customerId: "U-a", name: "JP 2495", lastInboundAt: NOW - 89 * HOUR },
  { customerId: "U-b", name: "iito_ch", lastInboundAt: NOW - 67 * HOUR },
  { customerId: "U-c", name: "Pook", lastInboundAt: NOW - 40 * HOUR },
  { customerId: "U-d", name: "Palm", lastInboundAt: NOW - 15 * HOUR },
];
const textOf = (bubbles) => bubbles.map((b) => b.text).join("\n");

test("เช้า: นำด้วยลูกค้าที่รอคำตอบ เรียงคนรอนานสุดขึ้นก่อน", () => {
  const out = textOf(buildDigestBubbles({
    mode: "morning", stats: baseStats, orders: baseOrders,
    waiting, hotLines: [], quotaLines: [], costThb: 50, sinceMs: SINCE, nowMs: NOW,
  }));
  assert.match(out, /เช้านี้ต้องดู/u);
  assert.match(out, /ลูกค้ารอคำตอบ 4 คน/u);
  assert.ok(out.indexOf("JP 2495") < out.indexOf("iito_ch"), "คนรอนานสุดต้องอยู่บนสุด");
  assert.match(out, /JP 2495 — รอ 89 ชม\./u);
  assert.match(out, /และอีก 1 คน/u, "เกินสามคนต้องบอกว่ามีอีกกี่คน ไม่ใช่ตัดหายเงียบ");
});

test("เช้า: ไม่พูดเรื่องค่าใช้จ่าย/โควตา — ไม่ใช่สิ่งที่ต้องลงมือตอนเช้า", () => {
  const out = textOf(buildDigestBubbles({
    mode: "morning", stats: baseStats, orders: baseOrders,
    waiting, hotLines: [], quotaLines: ["4,700/5,000"], costThb: 72, sinceMs: SINCE, nowMs: NOW,
  }));
  assert.doesNotMatch(out, /ค่า AI/u);
  assert.doesNotMatch(out, /โควตา/u);
});

test("เช้า: ไม่มีอะไรค้าง = บอกตรง ๆ ไม่ใช่ส่งฟอร์มเปล่า", () => {
  const out = textOf(buildDigestBubbles({
    mode: "morning",
    stats: { inbound: 0, inboundCustomers: 0, newCustomers: 0, needsHuman: 0, suspectSlips: 0 },
    orders: baseOrders, waiting: [], hotLines: [], quotaLines: [], costThb: null,
    sinceMs: SINCE, nowMs: NOW,
  }));
  assert.match(out, /ไม่มีอะไรค้าง/u);
});

test("ค่ำ: บอกผลของวัน และสิ่งที่จะข้ามคืนไป", () => {
  const out = textOf(buildDigestBubbles({
    mode: "evening", stats: baseStats,
    orders: { created: 3, confirmed: 2, paid: 1, revenue: 12900 },
    waiting, hotLines: ["1. โบว์ (9/10)"], quotaLines: ["4,700/5,000"], costThb: 72,
    sinceMs: SINCE, nowMs: NOW,
  }));
  assert.match(out, /วันนี้เป็นยังไง/u);
  assert.match(out, /ปิดได้ 1 ราย/u);
  assert.match(out, /ค้างข้ามคืน/u, "สิ่งที่ค้างต้องถูกบอกก่อนนอน ไม่ใช่ปล่อยไปเจอเอาพรุ่งนี้");
  assert.match(out, /ควรตามต่อพรุ่งนี้/u);
  assert.match(out, /ค่า AI วันนี้/u);
});

test("ค่ำ: ยังไม่มีใครจ่าย ต้องบอกตรง ๆ ไม่ใช่โชว์เลขศูนย์ให้ครบฟอร์ม", () => {
  const out = textOf(buildDigestBubbles({
    mode: "evening", stats: baseStats,
    orders: { created: 2, confirmed: 1, paid: 0, revenue: 0 },
    waiting: [], hotLines: [], quotaLines: [], costThb: 10, sinceMs: SINCE, nowMs: NOW,
  }));
  assert.match(out, /ยังไม่มีใครจ่ายวันนี้/u);
  assert.doesNotMatch(out, /ปิดได้ 0/u);
});

test("เรื่องเงินที่น่าสงสัยต้องไม่ถูกตัดทิ้งเพราะเต็มโควตาก้อน", () => {
  // วันยุ่งที่สุด: มีครบทุกอย่าง — สลิปน่าสงสัยต้องยังอยู่
  const bubbles = buildDigestBubbles({
    mode: "evening",
    stats: { ...baseStats, suspectSlips: 2 },
    orders: { created: 5, confirmed: 4, paid: 3, revenue: 50000 },
    waiting, hotLines: ["1. ก", "2. ข", "3. ค"], quotaLines: ["1/2", "3/4"], costThb: 99,
    sinceMs: SINCE, nowMs: NOW,
  });
  assert.ok(bubbles.length <= 5, "ต้องไม่เกิน 5 ก้อนตามข้อจำกัดของ LINE");
  assert.match(textOf(bubbles), /สลิปน่าสงสัย 2/u, "ความเสี่ยงเรื่องเงินต้องรอดเสมอ");
});

test("ค่าใช้จ่ายคำนวณไม่ได้ ต้องโชว์ให้เห็น ไม่ใช่หายเงียบ", () => {
  const out = textOf(buildDigestBubbles({
    mode: "evening", stats: baseStats, orders: baseOrders,
    waiting: [], hotLines: [], quotaLines: [], costThb: null, sinceMs: SINCE, nowMs: NOW,
  }));
  assert.match(out, /คำนวณไม่ได้/u);
});
