// ROAS ต้องไม่โกหกเจ้าของ (คำสั่งพี่ง้วง 1 ก.ย. 2026)
//
// ตัวเลขกำไรที่ผิดอันตรายกว่าไม่มีตัวเลข เพราะมันถูกเอาไปตัดสินใจว่าจะเพิ่มหรือลดงบแอด
// กติกาของไฟล์นี้: ข้อมูลไม่ครบ = null พร้อมบอกว่าขาดอะไร ห้ามคืนตัวเลขที่ดูเหมือนใช้ได้
import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRoas, splitLineUsage, lineCostForWindow, manualAdsForWindow, DEFAULT_LINE_RATE_THB,
} from "../src/roas.mjs";

test("คิด ROAS ครบทุกก้อนเมื่อข้อมูลครบ", () => {
  const r = computeRoas({
    revenueThb: 200_000,
    revenueByChannel: { default: 150_000, facebook: 50_000 },
    adsThb: 100_000, aiThb: 2_200, lineThb: 1_500, miscThb: 2_000,
  });
  assert.equal(r.totalCostThb, 105_700);
  assert.equal(r.roas, 1.89);
  assert.equal(r.profitThb, 94_300);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.revenueByChannel, { default: 150_000, facebook: 50_000 });
});

test("ขาดค่าแอด = ไม่คืน ROAS และบอกว่าขาดอะไร", () => {
  const r = computeRoas({ revenueThb: 100_000, adsThb: null, aiThb: 700, lineThb: 1_500 });
  assert.equal(r.roas, null, "ROAS ที่ขาดค่าแอดคือ ROAS ที่ผิด ห้ามโชว์");
  assert.equal(r.totalCostThb, null);
  assert.equal(r.profitThb, null);
  assert.deepEqual(r.missing, ["ค่าแอด"]);
});

test("ขาดค่าส่งข้อความ LINE ก็ต้องไม่คืนตัวเลข", () => {
  const r = computeRoas({ revenueThb: 100_000, adsThb: 50_000, lineThb: null });
  assert.deepEqual(r.missing, ["ค่าส่งข้อความ LINE"]);
  assert.equal(r.roas, null);
});

test("ค่าใช้จ่ายอื่น ๆ ยังไม่กรอก = 0 และไม่นับว่าข้อมูลขาด (ไม่บังคับกรอก)", () => {
  const r = computeRoas({ revenueThb: 100_000, adsThb: 50_000, aiThb: 700, lineThb: 300, miscThb: null });
  assert.deepEqual(r.missing, [], "ช่องนี้เป็นตัวเลือก ไม่ใช่ของบังคับ");
  assert.equal(r.costs.miscThb, 0);
  assert.equal(r.totalCostThb, 51_000);
});

test("ยังไม่มียอดขาย ต้องไม่พัง และ ROAS ต้องเป็น 0 ไม่ใช่ null", () => {
  const r = computeRoas({ revenueThb: 0, adsThb: 100_000, aiThb: 740, lineThb: 1_500 });
  assert.equal(r.roas, 0, "ใช้เงินไปแล้วแต่ยังไม่มียอด = ROAS ศูนย์ ซึ่งเป็นความจริงที่ควรเห็น");
  assert.equal(r.profitThb, -102_240);
});

/* ---- แยกบรอดแคส กับ ข้อความที่ AI ส่ง (คำสั่งพี่ง้วง 1 ก.ย. 2026) ----
 * พี่ง้วงบรอดแคสจาก manager.line.biz ใช้โควตาก้อนเดียวกับบอท LINE บอกได้แค่ยอดรวมเดือน
 * จึงหาส่วนบรอดแคสด้วยการลบส่วนที่ระบบเรารู้ว่าเป็นของเราออก
 */
test("แยกยอดบรอดแคสออกจากข้อความที่ AI ส่งได้", () => {
  const s = splitLineUsage({ monthTotalUsage: 5_000, monthAiMessages: 800 });
  assert.equal(s.totalMsgs, 5_000);
  assert.equal(s.aiMsgs, 800);
  assert.equal(s.broadcastMsgs, 4_200, "ส่วนที่เหลือคือบรอดแคสจาก LINE OA");
  assert.equal(s.aiExceedsTotal, false);
});

test("AI ส่งมากกว่ายอดโควตาได้จริง เพราะข้อความที่ตอบด้วย reply ไม่กินโควตา", () => {
  const s = splitLineUsage({ monthTotalUsage: 100, monthAiMessages: 900 });
  assert.equal(s.broadcastMsgs, 0, "ห้ามติดลบ");
  assert.equal(s.aiExceedsTotal, true, "ต้องยกธงให้หน้าจอเตือน ไม่ใช่ซ่อน");
});

test("อ่านโควตาไม่ได้ = ไม่เดายอดบรอดแคส", () => {
  const s = splitLineUsage({ monthTotalUsage: null, monthAiMessages: 800 });
  assert.equal(s.totalMsgs, null);
  assert.equal(s.broadcastMsgs, null, "ไม่รู้ยอดรวม = ไม่รู้ว่าบรอดแคสไปเท่าไร ห้ามเดา");
  assert.equal(s.aiMsgs, 800, "ฝั่งที่เรารู้ ยังบอกได้");
});

/* ---- ค่าส่ง LINE: คิดจากช่วงที่ทับกับข้อมูลที่ LINE มีจริงเท่านั้น ----
 * LINE ให้แค่ยอดรวมตั้งแต่ต้นเดือนถึงตอนนี้ ก้อนเดียว ไม่มีรายวันและไม่มีย้อนเดือน
 */
const D = 86_400_000;
const MONTH_START = Date.UTC(2026, 8, 0, 17, 0, 0);   // 1 ก.ย. 2026 00:00 เวลาไทย
const NOW = MONTH_START + 10 * D;                      // 11 ก.ย. 2026 00:00 เวลาไทย

test("ค่าส่ง LINE คิดที่ 0.06 บาทต่อข้อความตามที่พี่ง้วงกำหนด", () => {
  assert.equal(DEFAULT_LINE_RATE_THB, 0.06);
  const s = splitLineUsage({ monthTotalUsage: 5_000, monthAiMessages: 800 });
  const c = lineCostForWindow({
    split: s, windowStartMs: MONTH_START, windowEndMs: NOW, monthStartMs: MONTH_START, nowMs: NOW,
  });
  assert.equal(c.thb, 300, "5,000 ข้อความ × 0.06");
  assert.equal(c.estimated, false, "ช่วงตรงกับข้อมูลที่มีพอดี = ยอดจริง");
  assert.equal(c.coverage, 1);
});

test("ช่วงสั้นกว่าข้อมูลที่มี = เฉลี่ยรายวัน และต้องติดป้ายว่าเป็นค่าประมาณ", () => {
  const s = splitLineUsage({ monthTotalUsage: 3_000, monthAiMessages: 0 });
  const c = lineCostForWindow({
    split: s, windowStartMs: NOW - D, windowEndMs: NOW, monthStartMs: MONTH_START, nowMs: NOW,
  });
  assert.equal(c.windowMsgs, 300, "3,000 ÷ 10 วัน × 1 วัน");
  assert.equal(Number(c.thb.toFixed(2)), 18);
  assert.equal(c.estimated, true, "LINE ไม่มียอดรายวัน ต้องบอกว่าเฉลี่ยเอา");
});

test("ช่วงยาวกว่าข้อมูลที่มี ต้องคิดเฉพาะส่วนที่รู้ และห้ามบอกว่าเป็นยอดจริง", () => {
  // เลือก 30 วัน แต่เดือนเพิ่งผ่านมา 10 วัน — เรารู้แค่ 10 วัน
  const s = splitLineUsage({ monthTotalUsage: 3_000, monthAiMessages: 0 });
  const c = lineCostForWindow({
    split: s, windowStartMs: NOW - 30 * D, windowEndMs: NOW, monthStartMs: MONTH_START, nowMs: NOW,
  });
  assert.equal(c.windowMsgs, 3_000, "รู้แค่ยอดเดือนนี้ ห้ามคูณขยายไปเป็น 30 วัน");
  assert.equal(c.estimated, true, "ของเดิมตอบ estimated=false ทั้งที่ข้อมูลไม่ครบช่วง");
  assert.ok(c.coverage < 0.5, "ต้องบอกได้ว่าครอบคลุมช่วงแค่ไหน");
});

test("เลือกวันของเดือนก่อน = ไม่มีข้อมูล ต้องคืน null ห้ามเอายอดเดือนนี้ไปตอบแทน", () => {
  const s = splitLineUsage({ monthTotalUsage: 3_000, monthAiMessages: 0 });
  const c = lineCostForWindow({
    split: s, windowStartMs: MONTH_START - 5 * D, windowEndMs: MONTH_START - 4 * D,
    monthStartMs: MONTH_START, nowMs: NOW,
  });
  assert.equal(c.thb, null, "โควตาเดือนกันยาไม่ใช่ค่าส่งของวันในเดือนสิงหา");
  assert.match(c.reason, /เดือนปัจจุบัน/u);
});

test("อ่านโควตาไม่ได้ = ไม่คืนค่าส่ง LINE (ROAS จะได้ไม่ออกตัวเลขผิด)", () => {
  const c = lineCostForWindow({
    split: splitLineUsage({ monthTotalUsage: null }),
    windowStartMs: MONTH_START, windowEndMs: NOW, monthStartMs: MONTH_START, nowMs: NOW,
  });
  assert.equal(c.thb, null);
});

test("เปลี่ยนเรตต่อข้อความได้ ถ้าแพ็กเกจ LINE เปลี่ยนราคา", () => {
  const s = splitLineUsage({ monthTotalUsage: 1_000, monthAiMessages: 0 });
  const c = lineCostForWindow({
    split: s, ratePerMsg: 0.08,
    windowStartMs: MONTH_START, windowEndMs: NOW, monthStartMs: MONTH_START, nowMs: NOW,
  });
  assert.equal(Number(c.thb.toFixed(2)), 80);
  assert.equal(c.ratePerMsg, 0.08);
});

/* ---- ค่าแอดที่กรอกมือต้องปรับตามช่วงที่เลือก ----
 * บั๊กที่ตรวจเจอ 1 ก.ย. 2026: กรอกยอดทั้งเดือนแล้วเลือกดู "เมื่อวาน" ระบบเอายอดแอดทั้งเดือน
 * ไปหารรายได้วันเดียว ได้ ROAS ต่ำกว่าจริงหลายสิบเท่า และหน้าจอไม่ได้บอกว่ามันผิด
 */
test("ค่าแอดที่กรอกมือต้องเฉลี่ยตามจำนวนวันของช่วงที่เลือก", () => {
  const a = manualAdsForWindow({ adsThb: 100_000, adsWindowDays: 30, windowDays: 1 });
  assert.equal(Number(a.thb.toFixed(2)), 3333.33, "ยอด 30 วัน หารมาเป็นวันเดียว");
  assert.equal(a.estimated, true);
  const b = manualAdsForWindow({ adsThb: 100_000, adsWindowDays: 30, windowDays: 30 });
  assert.equal(b.thb, 100_000);
  assert.equal(b.estimated, false, "ช่วงตรงกับที่กรอกพอดี = ไม่ใช่ค่าประมาณ");
  assert.equal(manualAdsForWindow({ adsThb: null, windowDays: 7 }).thb, null);
});

/* ---- กันตัวเลขที่ทำให้ธุรกิจดูดีเกินจริง ---- */
test("ต้นทุนติดลบต้องถูกปัดเป็นศูนย์ ไม่ใช่ทำให้กำไรมากกว่ายอดขาย", () => {
  const r = computeRoas({ revenueThb: 100_000, adsThb: "-1000", aiThb: 500, lineThb: 2_000 });
  assert.equal(r.costs.adsThb, 0, "ยอดคืนเงินหรือพิมพ์ผิดต้องไม่กลายเป็นส่วนลดต้นทุน");
  assert.equal(r.totalCostThb, 2_500);
  assert.ok(r.profitThb <= r.revenueThb, "กำไรมากกว่ายอดขายไม่มีอยู่จริง");
});

test("ปัด ROAS ลงเสมอ — 0.996 ต้องไม่กลายเป็น 1.00x ที่อ่านว่าเสมอตัว", () => {
  const r = computeRoas({ revenueThb: 99_600, adsThb: 100_000, aiThb: 0, lineThb: 0 });
  assert.equal(r.roas, 0.99, "ของเดิมปัดขึ้นเป็น 1.00 ทั้งที่ขาดทุน 400 บาท");
  assert.ok(r.profitThb < 0);
});

test("ต้นทุนเป็นศูนย์ = บอกเหตุผลให้ตรง ไม่ใช่ขึ้นว่า 'ขาด' ทั้งที่ไม่ขาดอะไร", () => {
  const r = computeRoas({ revenueThb: 50_000, adsThb: "0", aiThb: 0, lineThb: 0 });
  assert.deepEqual(r.missing, []);
  assert.equal(r.roas, null);
  assert.equal(r.noCost, true, "หน้าจอต้องแยกได้ว่า 'ยังไม่มีต้นทุน' ต่างจาก 'ข้อมูลขาด'");
});
