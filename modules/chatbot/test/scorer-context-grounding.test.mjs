import assert from "node:assert/strict";
import test from "node:test";

import { COURSE_SCORING_FRAMEWORKS } from "../src/scoring.mjs";
import { buildScoreEvidence } from "../src/scoreEvidence.mjs";

test("course scorer separates current AI level from Automation experience and desired level", () => {
  const prompt = COURSE_SCORING_FRAMEWORKS;
  assert.match(prompt, /ไม่เคย(?:ทำ|รู้จัก)\s*Automation[\s\S]*ไม่ใช่หลักฐานว่าไม่เคยใช้ AI/u);
  assert.match(prompt, /ระดับที่อยากไปถึง[\s\S]*ไม่ใช่ระดับปัจจุบัน/u);
});

test("course scorer gives the latest explicit customer correction or choice precedence", () => {
  const prompt = COURSE_SCORING_FRAMEWORKS;
  assert.match(prompt, /คำยืนยันหรือการแก้ข้อมูลล่าสุดที่ลูกค้าพิมพ์เอง[\s\S]*ชนะ/u);
  assert.match(prompt, /คำถามของลูกค้า[\s\S]*ไม่ใช่คำยืนยัน/u);
  assert.match(prompt, /ข้อความของบอท[\s\S]*ไม่ใช่ตัวเลือกของลูกค้า/u);
});

test("score evidence states chronological precedence without upgrading assistant context to customer fact", () => {
  const evidence = buildScoreEvidence({ turns: [
    { id: "a", role: "assistant", content: "แปลว่าเคยใช้ AI ระดับ 5 ใช่ไหมคะ", created_at: 1 },
    { id: "b", role: "user", content: "พื้นฐานระดับ 3 เองค่ะ", created_at: 2 },
  ], now: 3 });
  assert.match(evidence.transcript, /เรียงตามเวลา/u);
  assert.match(evidence.transcript, /ข้อความลูกค้าที่แก้ข้อมูลภายหลังชนะ/u);
  assert.match(evidence.transcript, /assistant[^\n]*บริบท[^\n]*ไม่ใช่ข้อเท็จจริงของลูกค้า/iu);
});
