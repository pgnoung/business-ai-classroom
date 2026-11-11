// nurture-images.test.mjs — ส่งรูปในจังหวะ nurture (คำสั่งพี่ง้วง 4 ต.ค. 2026 "ส่งรูปบ่อยหน่อย จะได้ดู humanize")
//
// สิ่งที่ด่านนี้ล็อก:
//   1. ปิด (ค่าเริ่มต้น) = คำตัดสินรูปเดิมทุกกรณี · กติกาเดิมทุกไบต์
//   2. เปิด: ลูกค้าเล่าโจทย์แล้ว = โปสเตอร์คลาสที่ตัวจัดเส้นทางเลือก · ลูกค้าไม่มั่นใจว่าเรียนได้ = รูปบรรยากาศคลาสจริงใบที่ยังไม่ส่ง
//   3. รูปแต่ละใบส่งครั้งเดียวต่อห้อง · ลูกค้าปฏิเสธรูป / เทิร์นส่งต่อทีม / โหมดดูแลใจ = ไม่เสนอ
// ข้อความลูกค้าทุกบรรทัดในไฟล์นี้เป็นประโยคสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { baseRules, decideImageOffer, reviewLinkShared } from "../src/pipeline.mjs";
import { planReviewJourney } from "../src/reviewJourney.mjs";

const bot = (content) => ({ role: "assistant", content });
const user = (content) => ({ role: "user", content });
const ALLOWED = new Set(["ai-agent-for-business", "ai-agent-workflow-automation", "online-custom-gpts", "private-class", "in-house-training",
  "monthly-consult", "flash-consult", "ai-stage-ladder", "classroom-atmosphere-1", "classroom-atmosphere-2", "payment-kbank"]);
const DISCOVERY = [bot("ไม่ทราบว่าเคยใช้ AI มาประมาณระดับที่เท่าไหร่แล้วคะ?"), user("3 ค่ะ"), bot("ปกติทำงานหรือธุรกิจด้านไหนอยู่คะ?")];
const GOAL = "ทำร้านกาแฟค่ะ อยากให้ AI ช่วยทำโพสต์";
const WORRY = "เป็นมือใหม่มาก กลัวตามไม่ทัน";
const offer = (currentText, extra = {}) => decideImageOffer({ currentText, history: DISCOVERY, allowedImages: ALLOWED, ...extra });

test("ปิด: ช่วง nurture ไม่เสนอรูปเหมือนเดิม", () => {
  for (const text of [GOAL, WORRY, "3", "ขายต้นไม้ออนไลน์ อยากทำคลิปเร็วขึ้น"]) assert.equal(offer(text), null, text);
});

test("เปิด: ลูกค้าเล่าโจทย์แล้ว = โปสเตอร์คลาสที่แนะนำ (ส่งครั้งเดียวต่อห้อง)", () => {
  assert.deepEqual(offer(GOAL, { nurture: true }),
    { key: "ai-agent-for-business", explicitAsk: false, mustAttach: false, servicePoster: false, nurture: "recommend" });
  assert.equal(offer(GOAL, { nurture: true, sentImageKeys: ["ai-agent-for-business"] }), null);
  assert.equal(offer("3", { nurture: true }), null, "ยังไม่รู้โจทย์ = ยังไม่ใช่จังหวะแนะนำ");
});

// พี่ง้วง: "อยากให้รีวิวคนจริงขึ้นก่อน บรรยากาศในคลาส"
test("เปิด: ลูกค้าไม่มั่นใจ = รีวิวคนจริงก่อน · รูปบรรยากาศคลาสจริงเฉพาะห้องที่เคยได้รีวิวแล้ว", () => {
  assert.equal(offer(WORRY, { nurture: true }), null, "ยังไม่เคยได้รีวิว = ยังไม่ส่งรูปบรรยากาศ");
  const plan = planReviewJourney({ text: WORRY, history: DISCOVERY, nurture: true });
  assert.deepEqual([plan.kinds, plan.purpose, plan.maxItems], [["testimonial"], "build_confidence", 1]);
  assert.equal(planReviewJourney({ text: WORRY, history: DISCOVERY }).maxItems, 0, "ปิด = ไม่ส่งรีวิวเหมือนเดิม");
  const shared = { nurture: true, reviewsShared: true };
  assert.equal(offer(WORRY, shared)?.key, "classroom-atmosphere-1");
  assert.equal(offer(WORRY, shared)?.nurture, "confidence");
  assert.equal(offer(WORRY, { ...shared, sentAtmosphereKeys: ["classroom-atmosphere-1"] })?.key, "classroom-atmosphere-2");
  assert.equal(offer(WORRY, { ...shared, sentImageKeys: ["classroom-atmosphere-1"], sentAtmosphereKeys: ["classroom-atmosphere-2"] }), null);
  assert.equal(planReviewJourney({ text: "ทดลองใช้แล้วแต่ยังไม่เก่งค่ะ", history: DISCOVERY, nurture: true }).maxItems, 0, "บอกระดับ ไม่ใช่กังวล");
  for (const text of ["ไม่เก่งคอมเลยค่ะ เรียนได้ไหม", "ไม่มีพื้นฐานเลย ยากไหมคะ", "เรียนคนเดียวได้ไหมคะ", "ยังลังเลอยู่ค่ะ คุ้มไหม"]) {
    assert.equal(offer(text, shared)?.nurture, "confidence", text);
    assert.equal(planReviewJourney({ text, history: DISCOVERY, nurture: true }).kinds[0], "testimonial", text);
  }
});

test("รู้ว่าห้องนี้เคยได้ลิงก์รีวิวแล้ว: จากบันทึกการส่ง หรือจากลิงก์รีวิวในประวัติ", () => {
  assert.equal(reviewLinkShared([], new Set()), false);
  assert.equal(reviewLinkShared([], new Set(["https://pngoungacademy.com/reviews/1234567890"])), true);
  assert.equal(reviewLinkShared([bot("ดูรีวิวคุณเอได้ที่นี่ค่ะ\nhttps://pngoungacademy.com/reviews/1234567890")]), true);
  assert.equal(reviewLinkShared([bot("สมัครได้ที่ https://pngoungacademy.com/courses")]), false, "ลิงก์อื่นไม่ใช่รีวิว");
  assert.equal(reviewLinkShared([user("https://pngoungacademy.com/reviews/1234567890")]), false, "ลูกค้าส่งเองไม่นับ");
});

test("เปิด: ลูกค้าปฏิเสธรูป / เทิร์นส่งต่อทีม / โหมดดูแลใจ = ไม่เสนอรูป", () => {
  assert.equal(offer("ไม่ต้องส่งรูปนะคะ ทำร้านกาแฟ อยากให้ AI ช่วยทำโพสต์", { nurture: true }), null);
  assert.equal(offer(GOAL, { nurture: true, closingTurn: true }), null);
  assert.equal(offer(WORRY, { nurture: true, careMode: "apology" }), null);
});

test("กติกา: ปิด = เหมือนไม่ส่งค่าทุกไบต์ · เปิด = บอกโมเดลให้แนบรูปประกอบพร้อมเหตุผล", () => {
  const args = { currentText: WORRY, history: DISCOVERY, closingQuestion: true, approvedImageKeys: ALLOWED, reviewsShared: true };
  const plain = baseRules("general", [], args);
  assert.equal(baseRules("general", [], { ...args, nurtureImages: false }), plain);
  assert.equal(baseRules("general", [], { ...args, nurtureImages: false, reviewsShared: false }), plain);
  assert.ok(!plain.includes("[IMAGE:classroom-atmosphere-1]"));
  const nurtured = baseRules("general", [], { ...args, nurtureImages: true });
  assert.ok(nurtured.includes("[IMAGE:classroom-atmosphere-1]"));
  assert.match(nurtured, /แนบรูปบรรยากาศคลาสจริงนี้ประกอบด้วย/u);
  assert.match(nurtured, /จบข้อความด้วยคำถามเดียว/u, "ตรงกับนโยบายส่ง: มีรูปต้องมีคำถามปิดหนึ่งข้อ");
  const recommend = baseRules("general", [], { ...args, currentText: GOAL, nurtureImages: true });
  assert.match(recommend, /\[IMAGE:ai-agent-for-business\] ถ้าคำตอบนี้แนะนำหรือพูดถึงคลาสนี้ ให้แนบโปสเตอร์นี้ประกอบด้วย/u);
});
