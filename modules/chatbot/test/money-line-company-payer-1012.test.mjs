// เคสจริง 12 ต.ค. 13:14: "ใบเสร็จ จ่ายโดยบริษัทได้ไหมคะ" ในห้องที่ยังไม่มีเงิน = คำถามก่อนซื้อ ลูกแพรตอบเอง ห้ามแม่แบบรับเอกสาร/พัก AI
// การแจ้งโอน/ส่งสลิป/ตามใบเสร็จหลังจ่าย ยังไปคนเหมือนเดิม
import assert from "node:assert/strict";
import test from "node:test";

import { routeMessage, PAYMENT_DOC_TEMPLATE } from "../src/safetyRouter.mjs";

const presale = (text) => routeMessage({ text, paymentStarted: false });

test("ถามว่าให้บริษัทจ่าย/ออกใบเสร็จในนามบริษัทได้ไหม (ยังไม่มีเงิน) = ลูกแพรตอบเอง", () => {
  for (const text of ["ใบเสร็จ จ่ายโดยบริษัทได้ไหมคะ", "ใบเสร็จ บริษัทจ่ายได้ไหมครับ", "ขอใบกำกับภาษี บริษัทเป็นคนจ่ายได้มั้ยคะ".replace("ขอ", ""),
    "ใบกำกับภาษีชำระในนามบริษัทได้ไหมคะ", "ใบเสร็จ ให้องค์กรจ่ายได้ไหมคะ"]) {
    const r = presale(text);
    assert.notEqual(r?.template, PAYMENT_DOC_TEMPLATE, text);
    assert.notEqual(r?.route, "payment", text);
  }
});

test("เงินขยับแล้ว/ส่งหลักฐาน/ตามเอกสารหลังจ่าย ยังไปคน", () => {
  for (const text of ["บริษัทจ่ายไปแล้วค่ะ ขอใบเสร็จด้วย", "ใบเสร็จ โอนแล้วค่ะ 12,900", "ส่งสลิปให้แล้วค่ะ ใบเสร็จออกในนามบริษัทนะคะ"]) {
    assert.equal(presale(text)?.route, "payment", text);
  }
  // ห้องที่จ่ายเงินแล้ว (paymentStarted ค่าเริ่มต้น true) = พฤติกรรมเดิม
  assert.equal(routeMessage({ text: "ใบเสร็จ จ่ายโดยบริษัทได้ไหมคะ" })?.route, "payment");
});

test("ตัวจับวลีผู้จ่ายเร็วกับข้อความยาว", () => {
  const started = performance.now();
  presale(`ใบเสร็จ ${"จ่ายโดย ".repeat(600)}บริษัทได้ไหมคะ`);
  assert.ok(performance.now() - started < 50);
});
