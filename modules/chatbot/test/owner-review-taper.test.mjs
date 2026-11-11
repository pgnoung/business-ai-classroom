// owner-review-taper — ลดจำนวนห้องที่ต้องตรวจตามที่ลูกแพรเก่งขึ้น (ห้องตรวจ เฟส B · คำสั่งพี่ง้วง 12 ต.ค. 2026)
// pure ทั้งไฟล์: นโยบายพัง = ค่าตั้งต้น (ตรวจทุกห้อง) · วันที่ 1–7 = ระดับ 0 · สุ่มด้วย hmac ทำซ้ำได้ · เลื่อนทีละขั้นไม่เกินขั้นละ 7 วัน ·
// ลดระดับทันทีเมื่อพลาดในชุดสุ่ม > 10% · เจ้าของปักระดับชนะทุกกติกา · ป้าย "ดีที่เหลือทั้งหมด" ไม่นับในความแม่น
import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_REVIEW_TAPER_DEFAULTS, bangkokDayKey, evaluateTaper, includeDecision, isFlagged, parseTaperPolicy, parseTaperState,
  reviewDayNumber, sampleUnit, shiftDayKey, taperMetrics,
} from "../src/ownerReviewTaper.mjs";
import { OWNER_REVIEW_CODES } from "../src/ownerReviewDailyPrompt.mjs";

const policy = parseTaperPolicy("");
const label = (overrides = {}) => ({
  day_key: "2026-10-12", ai_status: "done", flagged: 0, sampled: 0, included: "all", label: "good", label_via: "single",
  issues_json: "[]", issue_verdicts_json: "{}", ...overrides,
});
const many = (count, overrides) => Array.from({ length: count }, () => label(overrides));

test("นโยบาย: ว่าง/JSON พัง/ไม่ใช่ object = ค่าตั้งต้นทุกช่อง · ช่องผิดใช้ค่าตั้งต้นเฉพาะช่องนั้น · รหัสร้ายแรงนอกรายการถูกทิ้ง", () => {
  for (const raw of ["", "{", "[]", "null", "42", null, undefined]) {
    const parsed = parseTaperPolicy(raw);
    assert.equal(parsed.flagRisk, 60);
    assert.deepEqual(parsed.sampleRates, [0.2, 0.2, 0.1]);
    assert.equal(parsed.warmupDays, 7);
    assert.equal(parsed.pin, null);
    assert.deepEqual(parsed.highSeverityCodes, ["wrong_price", "wrong_fact", "promise_risk", "missed_handoff"]);
  }
  const mixed = parseTaperPolicy(JSON.stringify({
    flagRisk: 150, sampleRates: [0.5, 2, 0.1], warmupDays: 3, pin: 7, promote: { minLabels: 40, minAgreement: "x" },
    highSeverityCodes: ["wrong_price", "made_up_code"],
  }), { codes: OWNER_REVIEW_CODES });
  assert.equal(mixed.flagRisk, 60, "เกิน 100 = ค่าตั้งต้น");
  assert.deepEqual(mixed.sampleRates, [0.2, 0.2, 0.1], "มีค่าเกิน 1 = ค่าตั้งต้นทั้งชุด");
  assert.equal(mixed.warmupDays, 3);
  assert.equal(mixed.pin, null, "ระดับนอก 0–2 = ไม่ปัก");
  assert.equal(mixed.promote.minLabels, 40);
  assert.equal(mixed.promote.minAgreement, 0.9);
  assert.deepEqual(mixed.highSeverityCodes, ["wrong_price"]);
  assert.equal(parseTaperPolicy({ pin: 2 }).pin, 2);
  assert.equal(parseTaperPolicy({ pin: 0 }).pin, 0);
  assert.deepEqual(parseTaperState("garbage"), { level: 0, changedDay: "" });
  assert.deepEqual(parseTaperState('{"level":2,"changedDay":"2026-10-20"}'), { level: 2, changedDay: "2026-10-20" });
  assert.deepEqual(parseTaperState('{"level":9,"changedDay":"yesterday"}'), { level: 0, changedDay: "" });
});

test("วัน: dayKey เวลาไทย · วันที่ N นับจากวันเริ่ม (วันเริ่ม = 1) · ยังไม่เริ่ม = 0", () => {
  assert.equal(bangkokDayKey(Date.UTC(2026, 9, 12, 13, 0)), "2026-10-12", "20:00 ไทย");
  assert.equal(bangkokDayKey(Date.UTC(2026, 9, 12, 17, 30)), "2026-10-13", "00:30 ไทยของวันถัดไป");
  assert.equal(reviewDayNumber("2026-10-12", "2026-10-12"), 1);
  assert.equal(reviewDayNumber("2026-10-12", "2026-10-18"), 7);
  assert.equal(reviewDayNumber("", "2026-10-18"), 0);
  assert.equal(reviewDayNumber("2026-10-20", "2026-10-18"), 0);
  assert.equal(shiftDayKey("2026-10-12", -7), "2026-10-05");
  assert.equal(shiftDayKey("2026-10-31", 1), "2026-11-01");
});

test("น่าห่วง = คะแนน ≥ 60 หรือรหัสร้ายแรง · AI ไม่ได้อ่าน = ไม่ใช่น่าห่วงแต่เข้าคิวเสมอ", () => {
  assert.equal(isFlagged({ aiStatus: "done", risk: 60, issues: [] }, policy), true);
  assert.equal(isFlagged({ aiStatus: "done", risk: 59, issues: [] }, policy), false);
  assert.equal(isFlagged({ aiStatus: "done", risk: 10, issues: [{ code: "wrong_price" }] }, policy), true);
  assert.equal(isFlagged({ aiStatus: "done", risk: 10, issues: [{ code: "over_long" }] }, policy), false);
  assert.equal(isFlagged({ aiStatus: "failed", risk: null, issues: [] }, policy), false);
  for (const level of [0, 1, 2]) {
    assert.deepEqual(includeDecision({ aiStatus: "skipped", risk: null, issues: [], customerId: "U1" }, level, "2026-10-20", policy).included, "all");
  }
  assert.deepEqual(includeDecision({ aiStatus: "done", risk: 90, issues: [], customerId: "U1" }, 2, "2026-10-20", policy),
    { flagged: true, sampled: false, included: "flagged" });
});

test("สุ่ม: hmac(dayKey, customerId) ได้ค่าเดิมทุกครั้ง · ระดับ 1 ≈ 20% · ระดับ 2 ≈ 10% · ระดับ 0 ทุกห้องเข้าคิวแต่ยังสุ่ม 20% ไว้วัดผล", () => {
  assert.equal(sampleUnit("2026-10-20", "U-a"), sampleUnit("2026-10-20", "U-a"));
  assert.notEqual(sampleUnit("2026-10-20", "U-a"), sampleUnit("2026-10-21", "U-a"));
  const rooms = Array.from({ length: 4000 }, (_, i) => ({ aiStatus: "done", risk: 5, issues: [], customerId: `U-${i}` }));
  const rate = (level) => rooms.filter((room) => includeDecision(room, level, "2026-10-20", policy).included === "sample").length / rooms.length;
  assert.ok(Math.abs(rate(1) - 0.2) < 0.03, `level 1 ≈ 20% (${rate(1)})`);
  assert.ok(Math.abs(rate(2) - 0.1) < 0.03, `level 2 ≈ 10% (${rate(2)})`);
  const level0 = rooms.map((room) => includeDecision(room, 0, "2026-10-20", policy));
  assert.ok(level0.every((decision) => decision.included === "all"));
  const measured = level0.filter((decision) => decision.sampled).length / rooms.length;
  assert.ok(Math.abs(measured - 0.2) < 0.03, `level 0 สุ่มวัดผล ≈ 20% (${measured})`);
  // ระดับ 2 ⊂ ระดับ 1 ในวันเดียวกัน (สุ่มตัวเดียวกัน เกณฑ์ต่ำกว่า)
  const two = rooms.filter((room) => includeDecision(room, 2, "2026-10-20", policy).sampled);
  assert.ok(two.every((room) => includeDecision(room, 1, "2026-10-20", policy).sampled));
});

test("ความแม่น: ตรงกับ AI / พลาดในชุดสุ่ม · ป้าย bulk และห้องที่ AI อ่านไม่สำเร็จไม่นับ · เห็นด้วยต่อรหัส", () => {
  const rows = [
    label({ flagged: 1, label: "needs_fix" }), // ตรง
    label({ flagged: 1, label: "good" }), // ไม่ตรง
    label({ sampled: 1, label: "good" }), // ตรง · ชุดสุ่ม
    label({ sampled: 1, label: "needs_fix" }), // ไม่ตรง · พลาด
    label({ label: "good", label_via: "bulk" }), // ไม่นับ
    label({ ai_status: "failed", label: "needs_fix" }), // ไม่นับ
    label({
      flagged: 1, label: "needs_fix", issues_json: JSON.stringify([{ code: "wrong_price", messageId: "m-1" }, { code: "pushy", messageId: "m-2" }]),
      issue_verdicts_json: JSON.stringify({ "wrong_price@m-1": "agree", "pushy@m-2": "disagree" }),
    }),
  ];
  const metrics = taperMetrics(rows);
  assert.equal(metrics.labels, 5);
  assert.equal(metrics.agreement, 0.6);
  assert.equal(metrics.sampleLabels, 2);
  assert.equal(metrics.missRate, 0.5);
  assert.deepEqual(metrics.perCode, { wrong_price: { agree: 1, disagree: 0 }, pushy: { agree: 0, disagree: 1 } });
  assert.deepEqual(taperMetrics([]), { labels: 0, agreement: null, sampleLabels: 0, missRate: null, flaggedLabels: 0, flaggedPrecision: null, perCode: {} });
});

const goodWeek = () => taperMetrics([...many(140, { flagged: 0, label: "good" }), ...many(20, { flagged: 1, label: "needs_fix" }),
  ...many(40, { sampled: 1, label: "good" })]);

test("วันที่ 1–7 = ระดับ 0 เสมอแม้ตัวเลขดี · ยังไม่เริ่ม (โหมด shadow) = ระดับ 0", () => {
  for (let day = 0; day < 7; day += 1) {
    const out = evaluateTaper({ policy, metrics: goodWeek(), dayKey: shiftDayKey("2026-10-13", day), startedDay: "2026-10-13" });
    assert.equal(out.level, 0);
    assert.equal(out.reason, "warmup");
    assert.equal(out.dayNumber, day + 1);
  }
  assert.equal(evaluateTaper({ policy, metrics: goodWeek(), dayKey: "2026-10-20", startedDay: "" }).reason, "not_started");
});

test("วันที่ 8 ตัวเลขผ่านทุกข้อ = ขึ้นระดับ 1 · ขึ้นได้ไม่เกินหนึ่งขั้นต่อ 7 วัน · ตัวเลขไม่ถึง = คงระดับ", () => {
  const startedDay = "2026-10-13";
  const day8 = evaluateTaper({ policy, state: { level: 0, changedDay: startedDay }, metrics: goodWeek(), dayKey: "2026-10-20", startedDay });
  assert.deepEqual([day8.level, day8.reason, day8.state], [1, "promoted", { level: 1, changedDay: "2026-10-20" }]);
  const day9 = evaluateTaper({ policy, state: day8.state, metrics: goodWeek(), dayKey: "2026-10-21", startedDay });
  assert.deepEqual([day9.level, day9.reason], [1, "hold"], "ยังไม่ครบ 7 วันหลังขึ้นระดับ");
  const day15 = evaluateTaper({ policy, state: day8.state, metrics: goodWeek(), dayKey: "2026-10-27", startedDay });
  assert.deepEqual([day15.level, day15.reason], [2, "promoted"]);
  const top = evaluateTaper({ policy, state: { level: 2, changedDay: "2026-10-27" }, metrics: goodWeek(), dayKey: "2026-11-20", startedDay });
  assert.equal(top.level, 2, "ระดับ 2 สูงสุด");

  const fewLabels = taperMetrics([...many(100, { label: "good" }), ...many(40, { sampled: 1, label: "good" })]);
  assert.equal(evaluateTaper({ policy, state: { level: 0, changedDay: startedDay }, metrics: fewLabels, dayKey: "2026-10-20", startedDay }).level, 0, "ป้าย < 150");
  const lowAgreement = taperMetrics([...many(140, { label: "good" }), ...many(30, { flagged: 1, label: "good" }), ...many(40, { sampled: 1, label: "good" })]);
  assert.equal(evaluateTaper({ policy, state: { level: 0, changedDay: startedDay }, metrics: lowAgreement, dayKey: "2026-10-20", startedDay }).level, 0, "ตรงกัน < 90%");
  const fewSample = taperMetrics([...many(180, { label: "good" }), ...many(10, { sampled: 1, label: "good" })]);
  assert.equal(evaluateTaper({ policy, state: { level: 0, changedDay: startedDay }, metrics: fewSample, dayKey: "2026-10-20", startedDay }).level, 0, "ชุดสุ่มน้อยไป");
  const bulkOnly = taperMetrics([...many(300, { label: "good", label_via: "bulk" }), ...many(40, { sampled: 1, label: "good" })]);
  assert.equal(bulkOnly.labels, 40);
  assert.equal(evaluateTaper({ policy, state: { level: 0, changedDay: startedDay }, metrics: bulkOnly, dayKey: "2026-10-20", startedDay }).level, 0,
    "กดดีที่เหลือทั้งหมดอย่างเดียวไม่ทำให้ลดการตรวจ");
});

test("พลาดในชุดสุ่ม > 10% = กลับระดับ 0 ทันที (ไม่รอ 7 วัน) · ≤ 10% ไม่ลด · ชุดสุ่มยังน้อย = ไม่ตัดสิน", () => {
  const startedDay = "2026-10-13";
  const missing = taperMetrics([...many(150, { label: "good" }), ...many(9, { sampled: 1, label: "good" }), ...many(2, { sampled: 1, label: "needs_fix" })]);
  assert.ok(missing.missRate > 0.1);
  const out = evaluateTaper({ policy, state: { level: 2, changedDay: "2026-11-01" }, metrics: missing, dayKey: "2026-11-02", startedDay });
  assert.deepEqual([out.level, out.reason, out.state], [0, "demoted", { level: 0, changedDay: "2026-11-02" }]);
  const fine = taperMetrics([...many(150, { label: "good" }), ...many(19, { sampled: 1, label: "good" }), ...many(2, { sampled: 1, label: "needs_fix" })]);
  assert.ok(fine.missRate <= 0.1);
  assert.equal(evaluateTaper({ policy, state: { level: 2, changedDay: "2026-11-01" }, metrics: fine, dayKey: "2026-11-02", startedDay }).level, 2);
  const tiny = taperMetrics([...many(3, { sampled: 1, label: "needs_fix" })]);
  assert.equal(evaluateTaper({ policy, state: { level: 1, changedDay: "2026-11-01" }, metrics: tiny, dayKey: "2026-11-02", startedDay }).level, 1);
});

test("เจ้าของปักระดับ = ใช้ระดับนั้นแม้อยู่ในสัปดาห์แรกหรือพลาดเยอะ · ไม่แตะสถานะที่จำไว้", () => {
  const pinned = parseTaperPolicy({ pin: 1 });
  const missing = taperMetrics([...many(20, { sampled: 1, label: "needs_fix" })]);
  const out = evaluateTaper({ policy: pinned, state: { level: 0, changedDay: "2026-10-13" }, metrics: missing, dayKey: "2026-10-14", startedDay: "2026-10-13" });
  assert.deepEqual([out.level, out.reason, out.state], [1, "pinned", { level: 0, changedDay: "2026-10-13" }]);
  assert.equal(OWNER_REVIEW_TAPER_DEFAULTS.pin, null);
});
