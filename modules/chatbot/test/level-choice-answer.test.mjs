// level-choice-answer.test.mjs — เคสจริง 5 ต.ค. 2026: ตอบบันไดด้วย "ข้อ2ค่ะ…" ติดคำไทย ต้องอ่านเป็นระดับ 2 (ข้อความสังเคราะห์)
import test from "node:test";
import assert from "node:assert/strict";
import { detectAiLevel, resolveClassRouting } from "../src/salesMotion.mjs";

const LADDER = "ไม่ทราบว่า คุณลูกค้า\nเคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ?\n\n1️⃣ ยังไม่เคยใช้เลย\n\n2️⃣ เคยลองเล่นนิดหน่อย\n\n3️⃣ ใช้ช่วยงานจริงบ้างแล้ว\n\n4️⃣ ใช้ประจำ\n\n5️⃣ สร้าง AI ขององค์กรเอง";
const history = [{ role: "user", content: "ค่าเรียนเท่าไหร่ได้อะไรบ้างคะ" }, { role: "assistant", content: LADDER }];

test("ตอบบันไดด้วยเลขข้อติดคำไทย = ระดับนั้น และได้คลาสเดียวที่เหมาะ", () => {
  for (const [text, level] of [["ข้อ2ค่ะเคยนิดหน่อย", 2], ["ข้อ3ค่ะ", 3], ["เลือกข้อ 1 ค่ะ ยังไม่เคยใช้", 1], ["ตัวเลือกที่5ครับ", 5]]) {
    assert.equal(detectAiLevel(text, { history }), level, text);
  }
  assert.equal(resolveClassRouting({ text: "ข้อ2ค่ะเคยนิดหน่อย", history }).product, "ai_agent_for_business");
});

test("เลขข้อที่ไม่ได้ตอบคำถามบันได ไม่ถูกเดาเป็นระดับ", () => {
  const other = [{ role: "assistant", content: "สะดวกรอบไหนคะ?" }];
  assert.equal(detectAiLevel("ข้อ2ค่ะ", { history: other }), null);
  assert.equal(detectAiLevel("ข้อ 3 ในสัญญาหมายถึงอะไรคะ", { history: [] }), null);
});
