import test from "node:test";
import assert from "node:assert/strict";
import { replyLeadContext } from "../src/replyLeadContext.mjs";
import { baseRules } from "../src/pipeline.mjs";

test("every regular reply receives the available interest score, including its limitations", () => {
  for (const [score, band] of [[1, "cold"], [5, "warm"], [8, "hot"]]) {
    const rules = baseRules("general", [], { customer: { last_score: score, last_score_at: 1790860000000 }, currentText: "ขอข้อมูลคลาสค่ะ" });
    assert.ok(rules.includes(`${score}/10 (${band})`));
    assert.match(rules, /scorer อาจยังไม่ประเมินข้อความล่าสุด/);
    assert.match(rules, /คำขอชัดเจนให้ทำตามได้โดยไม่รอคะแนนเพิ่ม/);
    assert.match(rules, /คะแนนสูงไม่อนุญาตให้เร่งขายหลังขอพัก/);
  }
});

test("missing and invalid scores stay unknown, never silently cold or invented", () => {
  for (const score of [undefined, null, -1, 11, NaN, "7"]) {
    assert.match(replyLeadContext({ last_score: score }), /unknown/);
  }
  assert.match(replyLeadContext({ last_score: 7, last_score_at: 9e20 }), /7\/10 \(warm\)/);
});
