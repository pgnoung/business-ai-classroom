import test from "node:test";
import assert from "node:assert/strict";
import { codePointLength, truncateCodePoints, wellFormedMessages, wellFormedText } from "../src/unicodeText.mjs";

test("Unicode prompt helpers ซ่อม surrogate ที่เสียและตัดตาม code point โดยไม่ผ่า emoji", () => {
  const emojiAtBoundary = `${"ก".repeat(159)}😊`;
  assert.equal(codePointLength(emojiAtBoundary), 160);
  assert.equal(truncateCodePoints(emojiAtBoundary, 160).endsWith("😊"), true);
  assert.equal(truncateCodePoints(emojiAtBoundary, 160).isWellFormed(), true);

  const loneSurrogate = "ก่อน\uD83Dหลัง";
  const repaired = wellFormedText(loneSurrogate);
  assert.equal(repaired.isWellFormed(), true);
  assert.match(repaired, /�/u);
});

test("Unicode prompt helpers ซ่อมทั้งข้อความปกติและ content block ก่อน provider", () => {
  const loneSurrogate = "\uD83D";
  const messages = wellFormedMessages([
    { role: "system", content: loneSurrogate },
    { role: "user", content: [loneSurrogate, { type: "text", text: loneSurrogate, prompt_cache_breakpoint: { mode: "explicit" } }] },
  ]);
  assert.equal(messages[0].content.isWellFormed(), true);
  assert.equal(messages[1].content[0].isWellFormed(), true);
  assert.equal(messages[1].content[1].text.isWellFormed(), true);
});
