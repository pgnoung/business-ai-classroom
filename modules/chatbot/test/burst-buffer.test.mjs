import test from "node:test";
import assert from "node:assert/strict";
import { createBurstBuffer } from "../src/burstBuffer.mjs";

// ---- v1.2.1: quoteToken ของข้อความล่าสุดใน burst ติดไปกับ leader ----
test("v1.2.1: leader ได้ quoteToken ของข้อความล่าสุดใน burst", async () => {
  const burst = createBurstBuffer({ debounceMs: 20, maxWaitMs: 100 });
  const first = burst.push({ key: "c1", text: "สนใจคลาสค่ะ", quoteToken: "qt-1" });
  const second = burst.push({ key: "c1", text: "ต้องเริ่มยังไง", quoteToken: "qt-2" });
  const [a, b] = await Promise.all([first, second]);
  const leader = a.role === "leader" ? a : b;
  assert.equal(leader.quoteToken, "qt-2");
  assert.equal(leader.combinedText, "สนใจคลาสค่ะ\nต้องเริ่มยังไง");
});
