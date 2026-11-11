// golden-turns.test.mjs — คลังเทิร์นตรวจซ้ำ + baseline + ใบเสร็จด่าน (เฟส 3)
//
// สิ่งที่เทสต์นี้ต้องกันไว้ให้ได้:
//   - ลายนิ้วมือข้อความต้องเป็น HMAC ที่มีกุญแจ ไม่ใช่ sha เปล่า (ย้อนกลับด้วย dictionary ได้)
//   - ไม่มีกุญแจ = เขียนไม่ได้ ไม่ใช่ตกกลับไปใช้ของที่อ่อนกว่าเงียบ ๆ
//   - เทิร์นที่ชี้ข้อความจริง ต้องหายไปกับสิทธิ์ให้ลืม (คู่กับ pdpa-cascade)
//   - คะแนนความไม่นิ่งต้องคิดจากผลจริงทุกรอบ ไม่ใช่รอบล่าสุด
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryDb } from "./helpers.mjs";
import { flakeScore, goldenTextHmac } from "../src/brain/goldenStore.mjs";
import { poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

// คลังเทิร์นตรวจซ้ำปฏิเสธการเขียนเมื่อไม่มีกุญแจของ instance (sha เปล่าย้อนกลับได้)
const GOLDEN_DB = { teachHashSecret: "test-instance-secret" };

const TEXT = "ราคาเท่าไหร่คะ";

test("ลายนิ้วมือข้อความเป็น HMAC ที่มีกุญแจ ไม่ใช่ sha เปล่า", () => {
  const withKey = goldenTextHmac(TEXT, "secret-a");
  const otherKey = goldenTextHmac(TEXT, "secret-b");
  assert.notEqual(withKey, otherKey, "กุญแจคนละดอกต้องให้ค่าคนละตัว ไม่งั้นกุญแจไม่มีความหมาย");
  const bare = createHash("sha256").update(TEXT).digest("hex");
  assert.notEqual(withKey, bare, "ห้ามตรงกับ sha เปล่าของข้อความ");
  // normalize ก่อนเสมอ: ข้อความเดียวกันที่ต่างแค่อักขระความกว้างศูนย์ต้องได้ค่าเดียวกัน
  assert.equal(goldenTextHmac("ดี​ที่สุด", "k"), goldenTextHmac("ดีที่สุด", "k"));
});

test("ไม่มีกุญแจของ instance = เขียนคลังไม่ได้เลย (fail-closed)", () => {
  assert.throws(() => goldenTextHmac(TEXT, ""), /กุญแจของ instance/u);
  const db = memoryDb({ teachHashSecret: "" });
  assert.throws(() => db.upsertGoldenTurn({
    caseId: "c1", syntheticText: TEXT, expected: [], origin: "eval_case",
  }), /กุญแจของ instance/u);
  db.close();
});

test("เทิร์นต้องเล่นซ้ำได้: ไม่มีทั้งข้อความจริงและข้อความสังเคราะห์ = ปฏิเสธ", () => {
  const db = memoryDb(GOLDEN_DB);
  assert.throws(() => db.upsertGoldenTurn({ caseId: "c1", expected: [], origin: "eval_case" }),
    /messageRef .* syntheticText|อย่างน้อยหนึ่ง/u);
  db.close();
});

test("เขียนซ้ำ turn_id เดิม = ทับของเดิม (seeder รันซ้ำได้ ไม่เกิดของซ้ำ)", () => {
  const db = memoryDb(GOLDEN_DB);
  db.upsertGoldenTurn({ caseId: "probe-price-01", turnNo: 1, syntheticText: TEXT, expected: [{ type: "must_have_price" }], origin: "eval_case" });
  db.upsertGoldenTurn({ caseId: "probe-price-01", turnNo: 1, syntheticText: TEXT, expected: [{ type: "no_price" }], origin: "eval_case" });
  assert.equal(db.countGoldenTurns(), 1);
  assert.equal(JSON.parse(db.getGoldenTurn("probe-price-01#1").expected_json)[0].type, "no_price");
  db.close();
});

test("PDPA: เทิร์นที่ชี้ข้อความจริงหายไปกับสิทธิ์ให้ลืม · เทิร์นสังเคราะห์อยู่ต่อ", () => {
  const db = memoryDb(GOLDEN_DB);
  const id = "U-golden-pdpa";
  db.upsertCustomer(id, { displayName: "ลูกค้า" });
  const messageId = db.insertMessage({ customerId: id, direction: "in", content: TEXT });
  db.upsertGoldenTurn({
    caseId: "ledger-01", messageRef: messageId, text: TEXT,
    expected: [{ type: "ai_off" }], severity: "irreversible", origin: "ledger_payment",
  });
  db.upsertGoldenTurn({ caseId: "probe-price-01", syntheticText: TEXT, expected: [], origin: "eval_case" });
  assert.equal(db.countGoldenTurns(), 2);

  db.resetCustomer(id, { forget: true });

  assert.equal(db.countGoldenTurns(), 1, "เทิร์นที่ผูกข้อความของคนที่ขอให้ลืมต้องหาย");
  assert.ok(db.getGoldenTurn("probe-price-01#1"), "เทิร์นสังเคราะห์ไม่ใช่ของลูกค้า ต้องอยู่ต่อ");
  db.close();
});

test("เจ้าของปิดเคสได้ ต้องเขียนเหตุผล และปิดทั้งเคสไม่ใช่ทีละเทิร์น", () => {
  const db = memoryDb(GOLDEN_DB);
  db.upsertGoldenTurn({ caseId: "probe-old", turnNo: 1, syntheticText: "a", expected: [], origin: "eval_case" });
  db.upsertGoldenTurn({ caseId: "probe-old", turnNo: 2, syntheticText: "b", expected: [], origin: "eval_case" });
  assert.throws(() => db.retireGoldenCase("probe-old", { reason: "สั้น" }), /เหตุผล/u);
  assert.equal(db.retireGoldenCase("probe-old", { by: "owner", reason: "ราคาเปลี่ยนแล้วตั้งแต่ 1 ก.ย." }), 2);
  assert.equal(db.listGoldenTurns().length, 0, "ทางอ่านปกติต้องไม่เห็นเคสที่ปิดแล้ว");
  assert.equal(db.listGoldenTurns({ includeRetired: true }).length, 2);
  db.restoreGoldenCase("probe-old");
  assert.equal(db.listGoldenTurns().length, 2);
  db.close();
});

test("คะแนนความไม่นิ่งคิดจากผลทุกรอบ ไม่ใช่รอบล่าสุด", () => {
  assert.equal(flakeScore(["pass"]), 0, "รอบเดียวยังไม่มีอะไรให้เถียงกัน");
  assert.equal(flakeScore(["pass", "pass", "pass"]), 0);
  assert.equal(flakeScore(["pass", "fail", "pass"]), Number((1 / 3).toFixed(4)));
  assert.equal(flakeScore(["pass", "fail"]), 0.5);

  const db = memoryDb(GOLDEN_DB);
  db.recordEvalResult({ caseId: "c1", versionId: "v1", verdict: "pass" });
  db.recordEvalResult({ caseId: "c1", versionId: "v1", verdict: "fail", fails: [{ rule: "price_not_approved", detail: "12,345" }] });
  db.recordEvalResult({ caseId: "c1", versionId: "v1", verdict: "pass" });
  const baseline = db.getEvalBaseline("c1", "v1");
  assert.equal(baseline.results.length, 3, "ต้องเก็บทุกรอบ ไม่ใช่ทับ");
  assert.equal(baseline.flakeScore, Number((1 / 3).toFixed(4)));
  assert.equal(baseline.results[1].fails[0].rule, "price_not_approved");
  db.close();
});

test("ใบเสร็จของด่านเก็บค่าใช้จ่ายเป็นบาทและรวมได้", () => {
  const db = memoryDb(GOLDEN_DB);
  db.recordGateRun({ versionId: "v1", kind: "G5", verdict: "pass", costThb: 0 });
  db.recordGateRun({ versionId: "v1", kind: "G5b", verdict: "needs_ack", costThb: 18.5, finishedAt: 1000 });
  assert.equal(db.listGateRuns("v1").length, 2);
  assert.equal(db.gateCostSince(0), 18.5, "ด่านที่ไม่เสียเงินต้องบันทึก 0 ไม่ใช่ไม่บันทึก");
  assert.throws(() => db.recordGateRun({ versionId: "v1", kind: "G5", verdict: "maybe" }), /verdict/u);
  db.close();
});
