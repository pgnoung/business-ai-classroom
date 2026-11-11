// ต้นทุนที่รายงานต้องตรงกับบิลจริง (31 ส.ค. 2026)
//
// เมื่อวานแก้ "เครื่องคิดเงิน" ให้รู้จักส่วนลด prompt caching แล้ว แต่ไม่ได้ตรวจว่า
// "คนเขียนตัวเลขลงฐานข้อมูล" มี 4 จุด และ 2 จุดไม่เคยกรอก cachedIn เลย —
// เส้น follow-up จึงโชว์แคช 0% มาตลอด ทั้งที่ prompt ขึ้นต้นด้วย persona+คลังความรู้
// ก้อนเดียวกับเส้นแชทปกติที่แคชโดน 70%
import test from "node:test";
import assert from "node:assert/strict";
import { usageFields } from "../src/llmUsageFields.mjs";

test("อ่าน cached_tokens ได้ทั้งสองชื่อฟิลด์ที่ผู้ให้บริการใช้", () => {
  assert.deepEqual(
    usageFields({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 700 } }),
    { tokensIn: 1000, tokensOut: 50, cachedIn: 700 }
  );
  assert.deepEqual(
    usageFields({ input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 700 } }),
    { tokensIn: 1000, tokensOut: 50, cachedIn: 700 }
  );
});

test("ไม่มีข้อมูลแคช = 0 (ห้ามเดา ไม่งั้นต้นทุนจะต่ำกว่าจริง)", () => {
  assert.deepEqual(
    usageFields({ prompt_tokens: 1000, completion_tokens: 50 }),
    { tokensIn: 1000, tokensOut: 50, cachedIn: 0 }
  );
  assert.deepEqual(usageFields({}), { tokensIn: 0, tokensOut: 0, cachedIn: 0 });
  assert.deepEqual(usageFields(), { tokensIn: 0, tokensOut: 0, cachedIn: 0 });
});

test("ตัวเลขเพี้ยนจาก provider ต้องไม่ทำให้บิลผิด", () => {
  assert.equal(usageFields({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 999 } }).cachedIn, 100,
    "แคชเกินยอด input จริงไม่ได้");
  assert.equal(usageFields({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: -5 } }).cachedIn, 0);
  assert.equal(usageFields({ prompt_tokens: "ไม่ใช่ตัวเลข", completion_tokens: null }).tokensIn, 0);
});
