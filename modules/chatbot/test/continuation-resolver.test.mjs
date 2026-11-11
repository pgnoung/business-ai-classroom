// continuation-resolver.test.mjs — LuKprae training F2 (handoff 2026-08-12):
// "ครับ/โอเค" หลังข้อเสนอ = ทำต่อจากข้อเสนอเดิม ไม่ใช่ query ว่างเปล่า
// resolver เป็น pure function: ห้าม derive ราคา/ตาราง/สิทธิ์ทางการค้า และห้าม
// เดา topic เมื่อความมั่นใจไม่พอ (คืน acknowledge_only แทน)
import test from "node:test";
import assert from "node:assert/strict";
import { resolveContinuation } from "../src/continuationResolver.mjs";

const OFFER_TURN = {
  role: "assistant",
  content: "ส่งรูปคลาสให้แล้วนะคะ อยากให้สรุปกิจกรรม Workshop ในคลาส AI Agent for Business ไหมคะ",
};
const TOPIC_TURN = { role: "user", content: "สนใจคลาส AI Agent for Business ครับ ทำ Workshop อะไรบ้าง" };

test("F2: ครับ หลังข้อเสนอ -> continue_previous_offer พร้อม retrieval จากข้อเสนอ+หัวข้อเดิม", () => {
  const hint = resolveContinuation({
    latestText: "ครับ",
    history: [TOPIC_TURN, OFFER_TURN],
  });
  assert.equal(hint.isShortAck, true);
  assert.equal(hint.action, "continue_previous_offer");
  assert.match(hint.retrievalText, /Workshop/u, "retrieval ต้องมาจากข้อเสนอเดิม");
  assert.match(hint.retrievalText, /AI Agent for Business/u);
  assert.match(hint.offerText, /สรุปกิจกรรม Workshop/u, "offerText = ประโยคข้อเสนอ (ให้ prompt hint)");
  assert.ok(hint.offerText.length <= 140, "offerText ต้อง bounded");
  assert.ok(!hint.offerText.includes("\n"), "ห้ามมี newline หลุดเข้า system rule");
});

test("F2 (fixture 3): ครับ หลังประโยคบอกเล่าเฉย ๆ -> acknowledge_only ห้ามเดา topic ใหม่", () => {
  const hint = resolveContinuation({
    latestText: "โอเคครับ",
    history: [
      { role: "user", content: "ขอบคุณสำหรับข้อมูลครับ" },
      { role: "assistant", content: "ยินดีค่ะ ทีมงานบันทึกข้อมูลเรียบร้อยแล้วนะคะ" },
    ],
  });
  assert.equal(hint.isShortAck, true);
  assert.equal(hint.action, "acknowledge_only");
  assert.equal(hint.retrievalText, "", "ไม่มีข้อเสนอค้าง = ห้ามยิง retrieval มั่ว");
});

test("ข้อความปกติ (ไม่ใช่คำรับสั้น) -> null ให้เส้นทางเดิมทำงานเป๊ะ", () => {
  assert.equal(resolveContinuation({ latestText: "ขอรายละเอียดคอร์สหน่อยครับ", history: [OFFER_TURN] }), null);
});

test("ไม่มี assistant turn ในประวัติ -> acknowledge_only (ไม่พัง ไม่เดา)", () => {
  const hint = resolveContinuation({ latestText: "ครับ", history: [] });
  assert.equal(hint.action, "acknowledge_only");
  assert.equal(hint.retrievalText, "");
});

test("หัวข้อลูกค้าก่อนหน้าที่เป็นคำรับสั้นเอง ต้องไม่ถูกนับเป็น topic", () => {
  const hint = resolveContinuation({
    latestText: "ครับ",
    history: [
      { role: "user", content: "โอเค" },
      TOPIC_TURN,
      { role: "assistant", content: "คลาสนี้มี Workshop ลงมือทำจริงค่ะ อยากให้เล่ากิจกรรมไหมคะ" },
    ],
  });
  assert.equal(hint.action, "continue_previous_offer");
  assert.match(hint.retrievalText, /AI Agent for Business/u, "topic จริงคือข้อความยาว ไม่ใช่ 'โอเค'");
});

// 2026-09-28 (ข้อสังเกตจากทีมตรวจ audit ก.ย.): "ได้เลยค่ะ" = ตอบรับข้อเสนอ เหมือน "ได้ค่ะ" / "ได้เลย"
test("ได้เลยค่ะ / ได้เลยครับ หลังข้อเสนอ = ตอบรับข้อเสนอ (เดิมหลุดเพราะมีคำลงท้าย)", () => {
  for (const latestText of ["ได้เลยค่ะ", "ได้เลยครับ", "ได้เลยนะคะ", "ได้เลยค่ะ 🙏"]) {
    const hint = resolveContinuation({ latestText, history: [TOPIC_TURN, OFFER_TURN] });
    assert.equal(hint?.action, "continue_previous_offer", latestText);
  }
  // คำที่ไม่ใช่คำตอบรับล้วน ยังเดินเส้นทางปกติเหมือนเดิม
  assert.equal(resolveContinuation({ latestText: "ได้เลยค่ะ แต่ขอถามก่อนว่าสอนกี่วัน", history: [OFFER_TURN] }), null);
});
