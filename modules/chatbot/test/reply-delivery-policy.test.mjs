import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISABLED_REPLY_DELIVERY_POLICY,
  assessReplyDelivery,
  isRepairableDelivery,
  repairExcessQuestions,
  degradeToDeliverable,
  bubbleEndsWithQuestion,
  countQuestions,
  loadReplyDeliveryPolicy,
  validateReplyDeliveryPolicy,
} from "../src/replyDeliveryPolicy.mjs";

const enabled = validateReplyDeliveryPolicy({
  enabled: true,
  terminalRoutes: ["payment_review"],
  terminalIntents: ["human_handoff"],
  terminalReasons: ["completed"],
});

test("reply delivery policy: absent path is disabled compatibility", () => {
  assert.equal(loadReplyDeliveryPolicy(""), DISABLED_REPLY_DELIVERY_POLICY);
  assert.deepEqual(assessReplyDelivery({
    policy: DISABLED_REPLY_DELIVERY_POLICY,
    bubbles: ["ถามอะไรไหมคะ", "อีกคำถามอะไรคะ", "เกิน", "ก็ยังผ่าน"],
    images: [{}, {}, {}],
  }), { ok: true, disabled: true, violations: [], terminalException: false });
});

test("reply delivery policy: configured missing or invalid file fails closed", (t) => {
  assert.throws(() => loadReplyDeliveryPolicy("/no/such/reply-delivery-policy.json"), /does not exist/u);
  const dir = mkdtempSync(join(tmpdir(), "reply-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "policy.json");
  writeFileSync(file, "{bad json");
  assert.throws(() => loadReplyDeliveryPolicy(file), /invalid JSON/u);
  writeFileSync(file, JSON.stringify({ enabled: true, unexpected: true }));
  assert.throws(() => loadReplyDeliveryPolicy(file), /unknown key/u);
});

test("reply delivery policy: enabled defaults are strict and reviewable", () => {
  assert.equal(enabled.maxImages, 2);
  assert.equal(enabled.maxQuestions, 1);
  assert.equal(enabled.maxTextBubbles, 3);
  assert.equal(enabled.requireExactlyOneFinalQuestionWhenImages, true);
  assert.throws(() => validateReplyDeliveryPolicy({ enabled: false, maxImages: 2 }), /only enabled:false/u);
});

test("reply delivery policy: allows two images followed by exactly one final Thai question", () => {
  const result = assessReplyDelivery({
    policy: enabled,
    bubbles: [{ text: "แพรส่งตัวอย่างให้ดูนะคะ" }, { text: "อยากเริ่มจากงานไหนก่อนคะ" }],
    images: [{ key: "one" }, { key: "two" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.questionCount, 1);
});

test("reply delivery policy: final image question must be the terminal clause and may end in complex emoji", () => {
  const proseAfterQuestion = assessReplyDelivery({
    policy: enabled,
    bubbles: ["สะดวกไหมคะ แล้วแพรส่งรูปให้ดูค่ะ"],
    images: [{}],
  });
  assert.ok(proseAfterQuestion.violations.includes("image_reply_requires_final_question"));

  for (const text of ["สะดวกไหมคะ🙏🏻", "ดีไหมคะ👍🏽", "สะดวกไหมคะ1️⃣"]) {
    assert.equal(bubbleEndsWithQuestion(text), true, text);
    const result = assessReplyDelivery({ policy: enabled, bubbles: [text], images: [{}] });
    assert.equal(result.ok, true, text);
  }
});

test("reply delivery policy: rejects max image, max question, non-final question, and too many bubbles", () => {
  const result = assessReplyDelivery({
    policy: enabled,
    bubbles: ["อยากเริ่มจากงานไหนคะ", "แพรส่งตัวอย่างให้ดูค่ะ", "ต่อเลยค่ะ", "เกินแล้วค่ะ"],
    images: [{}, {}, {}],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    "max_images_exceeded",
    "max_text_bubbles_exceeded",
    "image_reply_requires_final_question",
  ]);
  const twoQuestions = assessReplyDelivery({
    policy: enabled,
    bubbles: ["ตอนนี้ใช้ LINE OA อยู่ไหมคะ แล้วอยากแก้งานอะไรคะ"],
    images: [{}],
  });
  assert.ok(twoQuestions.violations.includes("max_questions_exceeded"));
  assert.ok(twoQuestions.violations.includes("image_reply_requires_exactly_one_question"));
});

test("reply delivery policy: explicit terminal route, intent, or reason waives only image final-question rule", () => {
  for (const exception of [
    { route: "payment_review" },
    { intent: "human_handoff" },
    { reason: "completed" },
  ]) {
    const result = assessReplyDelivery({ policy: enabled, bubbles: ["ทีมงานรับเรื่องต่อให้แล้วค่ะ"], images: [{}], ...exception });
    assert.equal(result.ok, true, JSON.stringify(exception));
    assert.equal(result.terminalException, true);
  }
  const stillOneQuestion = assessReplyDelivery({
    policy: enabled,
    route: "payment_review",
    bubbles: ["ต้องการอะไรคะ แล้วสะดวกเมื่อไหร่คะ"],
    images: [{}],
  });
  assert.ok(stillOneQuestion.violations.includes("max_questions_exceeded"));
});

test("reply delivery policy: Thai question count handles question marks and natural markers", () => {
  assert.equal(countQuestions("อยากเริ่มจากอะไรคะ"), 1);
  assert.equal(countQuestions("เริ่มจากอะไรคะ แล้วใช้ LINE OA อยู่ไหมคะ"), 2);
  assert.equal(countQuestions("ได้ไหมคะ?"), 1, "Thai marker plus punctuation is one question");
  assert.equal(countQuestions("เราขายอะไร ลูกค้าคือใคร และอยากให้ช่วยอะไร แล้วแนบตัวอย่างที่ชอบไปด้วยค่ะ"), 0,
    "question words inside an explanatory list are not customer questions");
  assert.equal(countQuestions("ไม่มีอะไรเพิ่มเติมค่ะ"), 0);
  assert.equal(countQuestions("เราขายอะไร ลูกค้าคือใครค่ะ ตอนนี้อยากลองกับงานไหนก่อนคะ"), 1);
  assert.equal(countQuestions("อยากเริ่มจากงานไหนคะ😊"), 1, "emoji may end a natural LINE question");
  assert.equal(countQuestions("สะดวกไหม"), 1, "bare yes/no marker is a question");
  assert.equal(countQuestions("แบบนี้พอได้ไหมคะ✨"), 1, "polite yes/no question before emoji is detected");
});

// ---- v1.2.2 (เคสจริง 2026-08-12: "สนใจคับ ai" ได้ fallback template แทนคำตอบ) ----

test("v1.2.2: คำถามเกินโควตาถือเป็นความผิดที่ซ่อมได้ ไม่ใช่การบล็อกเนื้อหา", () => {
  assert.equal(isRepairableDelivery(["max_questions_exceeded"]), true);
  assert.equal(isRepairableDelivery(["max_questions_exceeded", "image_reply_requires_exactly_one_question"]), true);
  assert.equal(isRepairableDelivery(["max_images_exceeded"]), false);
  assert.equal(isRepairableDelivery(["max_questions_exceeded", "max_images_exceeded"]), false);
  assert.equal(isRepairableDelivery([]), false);
});

test("v1.2.2: ซ่อมโดยเก็บคำถามนำตัวสุดท้ายไว้ และตัดคำถามก่อนหน้าทิ้งเท่านั้น", () => {
  const bubbles = [
    { text: "สวัสดีค่ะ สนใจคลาสไหนเป็นพิเศษคะ", pauseSec: 2 },
    { text: "ลูกแพรช่วยดูให้ได้ค่ะ ตอนนี้ใช้ AI ตัวไหนอยู่บ้างคะ?", pauseSec: 4 },
  ];
  const repaired = repairExcessQuestions(bubbles, { maxQuestions: 1 });
  const joined = repaired.map((bubble) => bubble.text).join("\n");
  assert.equal(repaired.length, 2);
  assert.equal(repaired[0].pauseSec, 2, "จังหวะส่งของบับเบิลเดิมต้องคงไว้");
  assert.match(joined, /สวัสดีค่ะ/u, "เนื้อหาที่ไม่ใช่คำถามต้องไม่หาย");
  assert.doesNotMatch(joined, /สนใจคลาสไหนเป็นพิเศษ/u, "คำถามซ้ำซ้อนตัวแรกต้องถูกตัด");
  assert.match(joined, /ใช้ AI ตัวไหนอยู่บ้างคะ\?/u, "คำถามนำตัวสุดท้ายต้องอยู่ครบ");
  assert.equal(
    repaired.reduce((count, bubble) => count + countQuestions(bubble.text), 0),
    1,
  );
});

test("v1.2.2: ซ่อมแล้วต้องผ่านการประเมินใหม่จริง ๆ", () => {
  const policy = { enabled: true, maxImages: 2, maxQuestions: 1, maxTextBubbles: 3, requireExactlyOneFinalQuestionWhenImages: true, terminalRoutes: [], terminalIntents: [], terminalReasons: [] };
  const bubbles = [{ text: "คลาสนี้เหมาะกับทีมที่งานเอกสารเยอะค่ะ อยากให้เริ่มจากงานไหนก่อนคะ" }, { text: "สะดวกคุยต่อทางไหนดีคะ?" }];
  assert.deepEqual(assessReplyDelivery({ policy, bubbles }).violations, ["max_questions_exceeded"]);
  const repaired = repairExcessQuestions(bubbles, { maxQuestions: 1 });
  assert.equal(assessReplyDelivery({ policy, bubbles: repaired }).ok, true);
});

test("v1.2.2: ไม่มีคำถามเกินโควตา = ไม่ต้องซ่อม (คืน null)", () => {
  assert.equal(repairExcessQuestions([{ text: "รับทราบค่ะ" }], { maxQuestions: 1 }), null);
});

// ---- v1.2.4 (เคสจริง 2026-08-13): "หนึ่งคำถาม" คือหนึ่งคำถามที่ลูกค้าต้องตอบ ----
// ไม่ใช่จำนวนแพตเทิร์นที่ regex เจอ — ของเดิมนับเครื่องหมาย ? ท้ายประโยคเดียวกัน
// เป็นคำถามเพิ่มอีกข้อ แล้วทิ้งคำตอบทั้งก้อนตั้งแต่ข้อความทักทายแรกของลูกค้า
test("v1.2.4: คำถามเดียวที่มีตัวอย่างประกอบ นับเป็นหนึ่งคำถาม", () => {
  assert.equal(countQuestions("ตอนนี้เคยใช้ AI ช่วยงานอะไรบ้างแล้วคะ เช่น เขียนงาน สรุปเอกสาร หรือสร้างภาพ?"), 1);
  assert.equal(countQuestions("สนใจคลาสไหนคะ?"), 1);
  assert.equal(countQuestions("อยากให้ลูกแพรสรุปให้ดูไหมคะ?"), 1);
});

test("v1.2.4: สองคำถามจริงยังต้องถูกจับได้เหมือนเดิม", () => {
  assert.equal(countQuestions("สนใจคลาสไหนคะ สะดวกเรียนวันไหนคะ"), 2);
  assert.equal(countQuestions("ทำธุรกิจอะไรคะ\nแล้วทีมมีกี่คนคะ"), 2);
});

test("v1.2.4: ประโยคบอกเล่าที่มีคำว่า 'ไหม' อยู่ข้างใน ไม่ใช่คำถาม", () => {
  assert.equal(countQuestions("ไม่ว่าจะเคยใช้ AI มาไหมก็เริ่มเรียนได้ค่ะ"), 0);
});

test("v1.2.4: ดราฟต์จริงที่เคยถูกบล็อก ต้องผ่านการประเมินการส่ง", () => {
  const policy = {
    enabled: true, maxImages: 2, maxQuestions: 1, maxTextBubbles: 3,
    requireExactlyOneFinalQuestionWhenImages: true,
    terminalRoutes: [], terminalIntents: [], terminalReasons: [],
  };
  const bubbles = [
    { text: "สวัสดีค่ะ ลูกแพรเป็นผู้ช่วยของพี่ง้วง ดูแลให้คำปรึกษาข้อมูลคลาสเรียนค่ะ" },
    { text: "ตอนนี้เคยใช้ AI ช่วยงานอะไรบ้างแล้วคะ เช่น เขียนงาน สรุปเอกสาร หรือสร้างภาพคะ?" },
  ];
  assert.deepEqual(assessReplyDelivery({ policy, bubbles }).violations, []);
});

// ---- v1.2.5: ผลตรวจอิสระ 2026-08-13 (15 ข้อ ยืนยันด้วยการรันโค้ดจริงทั้งหมด) ----

test("v1.2.5: เครื่องหมาย ? ใน URL ไม่ใช่คำถาม", () => {
  assert.equal(countQuestions("ลงทะเบียนได้ที่ https://pngoung.com/register?ref=line ค่ะ"), 0);
  assert.equal(countQuestions("ดูคลิปที่ youtube.com/watch?v=abc ค่ะ สนใจรอบไหนคะ"), 1);
});

test("v1.2.5: 'นะคะ' คือคำลงท้ายบอกเล่า ไม่ใช่คำถาม", () => {
  assert.equal(countQuestions("เดี๋ยวลูกแพรเช็คให้ว่าเหลือกี่ที่นั่งนะคะ"), 0);
  assert.equal(countQuestions("เดี๋ยวทีมงานจะแจ้งว่าคลาสเริ่มกี่โมงนะคะ"), 0);
});

test("v1.2.5: วงเล็บที่เปิดค้างต้องไม่ถูกหั่นคนละประโยค (ป้ายข้อมูลตัวอย่าง)", () => {
  const text = "ราคาโปรอยู่ที่ 29,000 บาทค่ะ (ข้อมูลตัวอย่างระหว่างเทรนค่ะ รบกวนทีมงานเติมข้อมูลจริง)";
  const bubbles = [{ text }];
  assert.equal(repairExcessQuestions(bubbles, { maxQuestions: 1 }), null);
  assert.equal(countQuestions(text), 0);
});

test("v1.2.5: ประโยคที่มีคำตอบจริงห้ามถูกลบทิ้งเพื่อลดจำนวนคำถาม", () => {
  const bubbles = [
    { text: "คอร์สสอน Make ตั้งแต่พื้นฐานจนสร้าง agent ได้จริงค่ะ พี่อยากเริ่มจากงานไหนก่อนคะ" },
    { text: "สนใจรอบไหนคะ?" },
  ];
  const repaired = repairExcessQuestions(bubbles, { maxQuestions: 1 });
  const joined = repaired.map((bubble) => bubble.text).join(" ");
  assert.match(joined, /คอร์สสอน Make ตั้งแต่พื้นฐาน/u, "คำตอบจริงต้องอยู่ครบ");
  assert.match(joined, /พี่อยากเริ่มจากงานไหนก่อนคะ/u, "คำถามที่มีบริบทต้องอยู่ครบ");
  assert.doesNotMatch(joined, /สนใจรอบไหนคะ/u, "คำถามลอยตัวที่ไม่มีเนื้อหาถูกตัดแทน");
});

test("v1.2.5: กติการูปแบบต้องลดทอนแล้วส่งต่อ ไม่ใช่ทิ้งคำตอบทั้งก้อน", () => {
  const policy = {
    enabled: true, maxImages: 2, maxQuestions: 1, maxTextBubbles: 3,
    requireExactlyOneFinalQuestionWhenImages: true,
    terminalRoutes: [], terminalIntents: [], terminalReasons: [],
  };
  // รูป + ประโยคปิดแบบบอกเล่า: ต้องได้ทั้งข้อความและรูป
  const receipt = degradeToDeliverable({
    policy, bubbles: [{ text: "ขอบคุณมากค่ะ นี่รูปใบเสร็จที่พี่ขอนะคะ" }], images: [{ url: "u" }],
  });
  assert.equal(receipt.bubbles.length, 1);
  assert.equal(receipt.images.length, 1, "ลูกค้าที่ขอรูปต้องได้รูป");
  assert.ok(receipt.applied.includes("waived_image_question_rule"));

  // รูปเกินเพดาน: ตัดเหลือเท่าเพดาน ไม่ใช่ริบทั้งหมด
  const many = degradeToDeliverable({
    policy, bubbles: [{ text: "ดูรูปคลาสได้เลยค่ะ สนใจรอบไหนคะ?" }],
    images: [{ url: "a" }, { url: "b" }, { url: "c" }],
  });
  assert.equal(many.images.length, 2);
  assert.ok(many.applied.includes("trimmed_images"));

  // ไม่ผิดอะไรเลย = ไม่แตะต้อง
  const clean = degradeToDeliverable({ policy, bubbles: [{ text: "สนใจรอบไหนคะ?" }], images: [] });
  assert.deepEqual(clean.applied, []);
  assert.equal(clean.ok, true);
});

// ---- v1.4.5 (เคสจริง 2026-08-15): repair ห้ามทำลายฟอร์แมตบอลลูนที่จัดโครงไว้ ----

test("v1.4.5: repairExcessQuestions ไม่ flatten บอลลูนบันได/บล็อกจัดรูป", () => {
  const ladder = "ไม่ทราบว่า คุณสมชาย\nเคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ?\n\n1️⃣ ยังไม่เคยใช้เลย (แต่สนใจมากๆ อยากรู้ว่าใช้ยังไง)\n\n2️⃣ เคยลองเล่นนิดหน่อย\n\n3️⃣ ใช้ช่วยงานจริงบ้างแล้ว";
  const repaired = repairExcessQuestions([ladder, "สะดวกกี่โมงคะ?", "จองเลยไหมคะ?"], { maxQuestions: 1 });
  assert.ok(repaired, "มีคำถามเกิน ต้องซ่อม");
  assert.equal(repaired[0], ladder, "บอลลูนบันไดต้องคงต้นฉบับทุกตัวอักษร รวมบรรทัดว่าง");

  // บอลลูน prose ที่ไม่โดนตัดประโยคใดเลย ต้องไม่ถูก rebuild ให้ format เพี้ยน
  const formattedList = "🎯 สิ่งที่จะได้รับ\n\n✅ ข้อแรก\n✅ ข้อสอง";
  const noisy = "อยากเริ่มเมื่อไหร่คะ พร้อมไหมคะ";
  const second = repairExcessQuestions([formattedList, noisy], { maxQuestions: 1 });
  if (second) assert.equal(second[0], formattedList, "บล็อกรายการต้องรอดทั้งก้อน");
});
