import test from "node:test";
import assert from "node:assert/strict";
import { buildConversationStyleRules, buildWarmthRules } from "../src/conversationStyle.mjs";
import { buildClassRoutingRules, buildSalesMotionRules } from "../src/salesMotion.mjs";
import { resolveContinuation } from "../src/continuationResolver.mjs";
import { decidePriceDisclosure } from "../src/priceDisclosure.mjs";

const coldScreening = Object.freeze({
  mode: "defer", reason: "defer_cold_stranger_screening", volunteerPrice: false,
  withPromo: false, silent: false,
});

test("first cold price screen is one concise benefit-framed question, not a class lecture", () => {
  const rules = buildWarmthRules({ text: "ราคาเท่าไหร่คะ", priceDisclosure: coldScreening }).join("\n");

  assert.match(rules, /เพื่อแนะนำคลาสให้ตรงกับงานที่อยากนำไปใช้ ขอทราบว่าเคยใช้ AI มาบ้างไหมคะ/u);
  assert.match(rules, /ห้ามขึ้นต้นหรือรับปากด้วย "เรื่องราคาบอกได้เลยค่ะ"/u);
  assert.doesNotMatch(rules, /เล่าสั้น ๆ ว่าคลาสไหนเหมาะกับใคร/u);
  assert.doesNotMatch(rules, /เรื่องคลาสทดลองเรียน/u);
  assert.match(rules, /ต้องสั้นและมีคำถามเดียว/u);
});

test("care pause suppresses forced discovery, sales, review, urgency, and follow-up questions", () => {
  const disclosure = Object.freeze({
    mode: "defer", reason: "care_pause", volunteerPrice: false, withPromo: false,
    silent: true, careMode: "pause",
  });
  const warmth = buildWarmthRules({ text: "ขอพักก่อนค่ะ", score: 10, priceDisclosure: { ...disclosure, owed: true } }).join("\n");
  const style = buildConversationStyleRules({ text: "ขอพักก่อนค่ะ", leadScore: 10, priceDisclosure: { ...disclosure, owed: true } });
  const sales = buildSalesMotionRules({ text: "ขอพักก่อนค่ะ", leadScore: 10, priceDisclosure: { ...disclosure, owed: true } }).join("\n");

  assert.doesNotMatch(warmth, /รีวิวนักเรียนจริง|คลาสทดลองเรียน/u);
  assert.doesNotMatch(style, /ปกติปิดท้ายด้วยคำถามนำหนึ่งข้อ/u);
  assert.doesNotMatch(sales, /จองที่นั่ง|Early Bird|โปรโมชั่น early bird/u);
  assert.deepEqual(buildClassRoutingRules({ text: "ขอพักก่อนค่ะ", priceDisclosure: disclosure }), []);
});

test("care price question keeps an approved regular-price directive without promo or urgency", () => {
  const disclosure = Object.freeze({
    mode: "quote", reason: "care_pause_price", volunteerPrice: true, withPromo: false,
    projectPricing: false, silent: false, careMode: "pause",
  });
  const rules = [
    ...buildWarmthRules({ text: "ราคาเท่าไหร่คะ", priceDisclosure: disclosure }),
    ...buildSalesMotionRules({ text: "ราคาเท่าไหร่คะ", priceDisclosure: disclosure }),
  ].join("\n");

  assert.match(rules, /ราคาปกติที่อนุมัติ/u);
  assert.match(rules, /ห้ามเติมโปรโมชั่น/u);
  assert.match(rules, /ข้อมูลที่นั่งที่ไม่ได้ยืนยัน|ส่วนลด ที่นั่ง/u);
  assert.doesNotMatch(rules, /Early Bird/u);
  assert.doesNotMatch(rules, /ทีมผู้ดูแลเป็นผู้ออกใบเสนอราคา/u);
});

test("a regular no-promo quote is not rewritten as a project starting-price quote", () => {
  const disclosure = Object.freeze({
    mode: "quote", reason: "regular_price_no_promo", volunteerPrice: true, withPromo: false,
    projectPricing: false, silent: false, careMode: null,
  });
  const rules = buildWarmthRules({ text: "ราคาเท่าไหร่คะ", priceDisclosure: disclosure }).join("\n");

  assert.match(rules, /คลาสนี้ ราคา <ราคาปกติ> บาท\/ท่าน/u);
  assert.doesNotMatch(rules, /ทีมผู้ดูแลเป็นผู้ออกใบเสนอราคา/u);
});

test("a hot score alone cannot add an offer or Early Bird invitation to a non-commercial turn", () => {
  const disclosure = Object.freeze({
    mode: "quote", reason: "known_context", volunteerPrice: false, withPromo: true,
    silent: false, careMode: null,
  });
  const rules = buildSalesMotionRules({ text: "ขอใบเสร็จได้ไหมคะ", leadScore: 10, priceDisclosure: disclosure }).join("\n");

  assert.doesNotMatch(rules, /จองที่นั่ง|รายละเอียดการสมัคร|Early Bird|โปรโมชั่น early bird/u);
  assert.match(rules, /ตอบเฉพาะเรื่องที่ลูกค้าถาม/u);
});

test("general style answers the latest request and does not impose a closing question", () => {
  const rules = buildConversationStyleRules({ text: "ขอใบเสร็จได้ไหมคะ" });

  assert.match(rules, /ตอบคำถามล่าสุดก่อนเสมอ/u);
  assert.match(rules, /ถ้าขาดข้อมูลที่จำเป็นจริง ๆ/u);
  assert.doesNotMatch(rules, /ปกติปิดท้ายด้วยคำถามนำหนึ่งข้อ/u);
  assert.doesNotMatch(rules, /พร้อมคำถามชวนก้าวต่อหนึ่งข้อ/u);
});

test("owed price remains eligible for a direct approved-price answer", () => {
  const disclosure = Object.freeze({
    mode: "quote", reason: "quote_deferral_owed", deferredBefore: true, owed: true,
    volunteerPrice: true, withPromo: true, silent: false, careMode: null,
  });
  const rules = buildWarmthRules({ text: "เคยใช้ AI มาบ้างค่ะ", priceDisclosure: disclosure }).join("\n");

  assert.match(rules, /คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ/u);
});

test("short acknowledgement accepts a >140-character price offer and receives the price", () => {
  const offered = `เดี๋ยวส่งราคาให้ ${"รายละเอียด ".repeat(24)}ราคา 19,900 บาท/ท่านนะคะ`;
  const history = [{ role: "user", content: "สนใจคลาสค่ะ" }, { role: "assistant", content: offered }];
  const continuationHint = resolveContinuation({ latestText: "ค่ะ", history });
  const disclosure = decidePriceDisclosure({ text: "ค่ะ", history, customer: { price_deferred_at: 1 } });
  assert.equal(continuationHint.action, "continue_previous_offer");
  assert.equal(continuationHint.offerHasMoney, true, "ต้องอ่านราคาจาก offer เต็มก่อนตัด 140 ตัวอักษร");
  assert.equal(disclosure.acceptedPriceOffer, true);
  const rules = buildWarmthRules({ text: "ค่ะ", history, priceDisclosure: disclosure }).join("\n");
  const continuation = buildConversationStyleRules({
    text: "ค่ะ", history, priceDisclosure: disclosure, continuation: continuationHint,
  });

  assert.match(rules, /ลูกค้าตอบรับข้อเสนอที่มีราคา.*แจ้งราคาที่อนุมัติแล้ว/u);
  assert.match(continuation, /ลูกค้าเพิ่งตอบรับข้อเสนอล่าสุด/u);
});
