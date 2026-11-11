import test from "node:test";
import assert from "node:assert/strict";
import { parseScorePayload } from "../src/scoring.mjs";
import { buildScoreEvidence, normalizeScoreEvidence } from "../src/scoreEvidence.mjs";

const NOW = Date.UTC(2026, 8, 13, 8, 0, 0);
const presetPhrases = ["จองคิวได้ไหม", "ขอทราบราคา"];
const turn = (overrides = {}) => ({ id: "m1", role: "user", content: "จองคิวได้ไหม", created_at: NOW - 1_000, operator: "", msg_type: "text", ...overrides });

test("button-only score is insufficient and caps a model 9 without persona inference", () => {
  const evidence = buildScoreEvidence({ turns: [turn()], now: NOW, presetPhrases });
  const result = normalizeScoreEvidence({ score: 9, persona_type: "sme_owner", pain_point: "งานช้า", persona_read: { disc: "D", bank: "Action", reason: "x" }, known_name: "สมชาย", tags: ["พร้อมซื้อ"], order: { items: [{ name: "คอร์ส", qty: 1 }] }, out_of_band_reply: true, sales_signals: { customer_journey: "ready", decision_role: { role: "owner" }, opportunity: { type: "course" } } }, evidence, { lastScore: 7 });
  assert.equal(evidence.assessment.status, "insufficient_evidence");
  assert.equal(result.score, 2);
  assert.equal(result.score_assessment.raw_score, 9);
  assert.equal(result.persona_type, "unknown");
  assert.equal(result.pain_point, null);
  assert.equal(result.trend, "down");
  assert.equal(result.known_name, "");
  assert.deepEqual(result.tags, []);
  assert.equal(result.order, null);
  assert.equal(result.out_of_band_reply, false);
  assert.equal(result.sales_signals.opportunity, null);
});

test("mixed typed customer evidence retains score and calculates trend from persisted score", () => {
  const evidence = buildScoreEvidence({ turns: [turn(), turn({ id: "m2", content: "ทีมขายตอบลูกค้าไม่ทันค่ะ" })], now: NOW, presetPhrases });
  const result = normalizeScoreEvidence({ score: 8, trend: "down" }, evidence, { lastScore: 5 });
  assert.equal(evidence.assessment.typed_customer_count, 1);
  assert.equal(result.score, 8);
  assert.equal(result.trend, "up");
});

test("prior context or verified human note is sufficient; ai_auto is excluded", () => {
  const human = { author: "chompoo", text: "โทรยืนยันว่าต้องการใบเสนอราคา", created_at: NOW - 500 };
  const ai = { author: "ai_auto", text: "score=10", created_at: NOW - 400 };
  assert.equal(buildScoreEvidence({ turns: [turn()], now: NOW, presetPhrases, previousContextKnown: true }).assessment.status, "assessed");
  const evidence = buildScoreEvidence({ turns: [turn()], now: NOW, presetPhrases, handoffNotes: [ai, human] });
  assert.equal(evidence.assessment.human_note_count, 1);
  assert.match(evidence.transcript, /ใบเสนอราคา/u);
  assert.doesNotMatch(evidence.transcript, /score=10/u);
});

test("three adjacent preset taps collapse and absent timestamps stay honest", () => {
  const evidence = buildScoreEvidence({ turns: [turn({ id: "a", created_at: null }), turn({ id: "b", created_at: null }), turn({ id: "c", created_at: null })], now: null, presetPhrases });
  assert.equal(evidence.assessment.preset_count, 3);
  assert.equal(evidence.assessment.latest_customer_at, "unknown");
  assert.match(evidence.transcript, /\(x3\)/u);
  assert.equal((evidence.transcript.match(/\[preset;/gu) || []).length, 1);
});

test("preset matching follows reply-path punctuation normalization", () => {
  const evidence = buildScoreEvidence({ turns: [turn({ content: "จองคิวได้ไหม?! 😊" })], now: NOW, presetPhrases });
  assert.equal(evidence.assessment.preset_count, 1);
  assert.equal(evidence.assessment.typed_customer_count, 0);
});

test("image-only user event omits URL content and has insufficient evidence", () => {
  const evidence = buildScoreEvidence({ turns: [turn({ content: "https://private.example/image.jpg", msg_type: "image" })], now: NOW, presetPhrases });
  assert.equal(evidence.assessment.status, "insufficient_evidence");
  assert.equal(evidence.assessment.typed_customer_count, 0);
  assert.doesNotMatch(evidence.transcript, /private\.example/u);
});

test("human console and legacy-prefixed replies are evidence; unknown assistants remain honest", () => {
  const human = buildScoreEvidence({ turns: [turn({ role: "assistant", operator: "chompoo", content: "คุยทางโทรศัพท์แล้ว" })], now: NOW, presetPhrases });
  const legacy = buildScoreEvidence({ turns: [turn({ role: "assistant", operator: "", content: "[แอดมินทีมงานพิมพ์เอง] รับทราบโจทย์แล้ว" })], now: NOW, presetPhrases });
  const unknown = buildScoreEvidence({ turns: [turn({ role: "assistant", operator: "", content: "ข้อเสนอจากระบบ" })], now: NOW, presetPhrases });
  assert.equal(human.assessment.human_text_count, 1);
  assert.equal(legacy.assessment.human_text_count, 1);
  assert.equal(unknown.assessment.status, "insufficient_evidence");
  assert.match(unknown.transcript, /unknown_assistant/u);
});

test("non-human operators and nontext assistants cannot create human text evidence", () => {
  const evidence = buildScoreEvidence({ turns: [
    turn({ role: "assistant", operator: "ai_auto", content: "https://private.example/a.jpg", msg_type: "image" }),
    turn({ id: "m2", role: "assistant", operator: "chompoo", content: "https://private.example/b.jpg", msg_type: "image" }),
  ], now: NOW, presetPhrases });
  assert.equal(evidence.assessment.human_text_count, 0);
  assert.equal(evidence.assessment.status, "insufficient_evidence");
  assert.doesNotMatch(evidence.transcript, /private\.example/u);
});

test("score parser rejects coercible invalid shapes and allows only exact numeric strings", () => {
  for (const score of [null, true, false, "", [], {}, " 5", "5.0", "11", -1, 10.1]) {
    assert.equal(parseScorePayload(JSON.stringify({ score })), null, `must reject ${JSON.stringify(score)}`);
  }
  assert.equal(parseScorePayload(JSON.stringify({ score: "10" })).score, 10);
  assert.equal(parseScorePayload(JSON.stringify({ score: "0" })).score, 0);
});
