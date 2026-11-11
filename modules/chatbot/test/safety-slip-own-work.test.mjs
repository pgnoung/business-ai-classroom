// "สลิป" ในประโยคเล่างานของลูกค้าเอง ≠ หลักฐานการจ่ายให้เรา (เคสจริง Facebook 28 ก.ย. 2026 09:27)
//
// บอทถาม "อยากนำ AI ไปช่วยงานอะไร" ลูกค้าตอบว่าอยากจดรายรับรายจ่ายและเก็บสลิปผ่าน LINE
// แล้วได้แม่แบบ "บันทึกเรื่องการชำระเงินไว้ให้ทีมงานตรวจแล้ว" + push แจ้งทีม ทั้งที่ยังไม่มีเงินสักบาท
// ต้นเหตุ: กฎเงินเฉพาะธุรกิจ (safety-rules.json) ทำงานก่อนเส้นเงินกลาง และจับคำว่า "สลิป" ตรง ๆ
// วัดกับข้อความ "สลิป" ในคลังจริงทั้ง 28 ข้อความ: ยกเว้นตรง 3 ข้อความที่เป็นโจทย์งาน ที่เหลือเหมือนเดิม
import test from "node:test";
import assert from "node:assert/strict";
import { routeMessage } from "../src/safetyRouter.mjs";

// รูปเดียวกับที่ loadSafetyRules คืนจาก safety-rules.json ของลูกแพร
const PAYMENT_RULE = Object.freeze({
  keywords: ["โอนแล้ว", "สลิป", "ชำระเงินแล้ว", "จ่ายเงินแล้ว", "ขอคืนเงิน", "รีฟันด์"],
  excludeKeywords: [],
  excludeUseCaseFraming: true,
  template: "ลูกแพรบันทึกเรื่องการชำระเงินไว้ให้ทีมงานตรวจแล้วนะคะ ทีมงานจะยืนยันกลับให้อีกครั้งค่ะ",
  reason: "payment_requires_human_review",
});
const route = (text, paymentStarted = false) => routeMessage({ text, msgType: "text", extraRules: [PAYMENT_RULE], paymentStarted });

test("เล่าโจทย์ระบบเก็บ/จดสลิปของตัวเอง = ให้ AI คุยต่อ ไม่ใช่เส้นเงิน", () => {
  for (const text of [
    "อยากจดรายรับรายจ่ายเก็บสลิป ผ่าน Line ครับ",
    "แล้วถ้าเราทำให้ google sheet เก็บไฟล์รูปสลิป แยกด้วยได้ไหมคะ",
    "Make.com สามารถ Verify สลิปโอนเงินลูกค้าได้ไหมครับ หรือพอมีวิธีเช็คลูกค้าที่โอนเงินเรียบร้อยแล้วไหม",
    "อยากให้ flowaccount ดึงข้อมูลจากสลิปอัตโนมัติ",
  ]) {
    for (const paymentStarted of [false, true]) {
      const result = route(text, paymentStarted);
      assert.equal(result.route, "ai", `${text} (paymentStarted=${paymentStarted}) → ${result.route}/${result.intent}`);
      assert.equal(result.escalate, null);
    }
  }
});

test("แจ้งจ่ายเงินจริงยังเข้าเส้นเงินทุกแบบ แม้ประโยคมีคำเล่างานปน", () => {
  const cases = [
    ["สลิปค่ะ", "payment_requires_human_review"],
    ["สลิปโอนค่ะ", "payment_requires_human_review"],
    ["เดี๋ยวเย็นนี้ส่งสลิปไปให้นะคะ", "payment_requires_human_review"],
    ["ส่งรายละเอียดพร้อมสลิปแล้วนะคะ", "payment_requires_human_review"],
    ["สลิปธนาคารส่งทางอีเมลได้ไหม", "payment_requires_human_review"],
    // กริยาจ่ายเงินให้เรา ชนะคำเล่างานเสมอ
    ["โอนแล้วค่ะ เก็บสลิปไว้ให้แล้ว", "payment_requires_human_review"],
    // คำที่ชนกฎไม่ใช่คำนามหลักฐาน ("ขอคืนเงิน") = ตัวยกเว้นใหม่ไม่แตะ แม้มีคำเล่างาน "ทำใบเสร็จ" ปน
    ["ผมทำใบเสร็จเองทุกเดือน แต่ขอคืนเงินคลาสได้ไหมคะ", "payment_requires_human_review"],
    ["ส่งสลิปใน google sheet ที่แชร์ไว้แล้วนะคะ", "payment_requires_human_review"],
  ];
  for (const [text, reason] of cases) {
    const result = route(text);
    assert.equal(result.escalate?.reason, reason, `${text} → ${result.route}/${result.intent}`);
  }
});

test("ส่ง payment slip ภาษาอังกฤษ = ยื่นสลิปให้เรา (เคยหลุดไป AI เพราะคำว่า เรียน ชนตัวกรองบริบท)", () => {
  for (const text of ["ผมส่ง payment slip ค่าคอร์สเรียนวันที่ 4 มาให้ครับ", "แนบ slip ให้แล้วนะคะ"]) {
    const result = routeMessage({ text, msgType: "text", extraRules: [], paymentStarted: false });
    assert.equal(result.route, "payment", `${text} → ${result.route}/${result.intent}`);
    assert.equal(result.escalate?.reason, "payment_review");
  }
});

test("เส้นเงินกลาง (ไม่มีกฎเฉพาะธุรกิจ) ก็ไม่จับระบบงานที่มีเครื่องมือจริง แต่คำขอเอกสารตรง ๆ ยังชนะ", () => {
  const story = routeMessage({ text: "อยากให้ google sheet เก็บรูปสลิปแยกไฟล์ด้วยได้ไหมคะ", msgType: "text", extraRules: [], paymentStarted: true });
  assert.equal(story.route, "ai", `${story.route}/${story.intent}`);
  const request = routeMessage({ text: "ขอใบเสร็จเป็นไฟล์ excel ได้ไหมคะ", msgType: "text", extraRules: [], paymentStarted: true });
  assert.equal(request.route, "payment", `${request.route}/${request.intent}`);
});
