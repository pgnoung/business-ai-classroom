// brain-gate5.test.mjs — G5: เล่นซ้ำบทสนทนาจริงด้วยตารางของรุ่นใหม่ โดยไม่เรียกโมเดล
//
// สิ่งที่เทสต์นี้ต้องกันไว้ให้ได้:
//   - **ไม่มีการเรียกโมเดลเลย** (fetch ถูกวางยาไว้ทั้งไฟล์ — ถ้ามีใครเผลอเรียก เทสต์แดงทันที)
//   - เคสจริงของโครงการนี้: แก้ราคาแล้วคำตอบเก่าที่พูดราคาเดิมต้อง "ตกใหม่" ไม่ใช่ผ่านเงียบ
//   - กติกาการเลือกต้องไม่ใช่ทั้งคลัง และต้องไม่พลาดเคสที่พังกู้ไม่ได้ (floor)
//   - ไม่มีคำตอบให้เล่นซ้ำ + การแก้แตะเนื้อคำตอบ = not_applicable (เทา) ห้ามเป็น pass
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";
import { collectCurrentSourceCards } from "../src/brain/sources.mjs";
import { compileCards, sourceCardToCard } from "../src/brain/compile.mjs";
import { BRAIN_CODE_CONTRACT } from "../src/brain/import.mjs";
import { runGate5, selectGoldenCases, replayGoldenTurn } from "../src/brain/gate5.mjs";
import { runBrainGates } from "../src/brain/gate.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

poisonGlobalFetch();

// คลังเทิร์นตรวจซ้ำปฏิเสธการเขียนเมื่อไม่มีกุญแจของ instance (sha เปล่าย้อนกลับได้)
const GOLDEN_DB = { teachHashSecret: "test-instance-secret" };

const QUIET = { warn() {}, debug() {}, log() {} };
const TODAY = "2026-09-03";

function seed(db) {
  db.addKnowledge({ title: "แคตตาล็อกคลาส", content: "คลาส AI Agent for Business สอนสร้างผู้ช่วย", updatedBy: "owner" });
  db.addKnowledge({ title: "ที่จอดรถ", content: "จอดฟรี 2 ชั่วโมงที่อาคารข้างเคียง", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 11900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
}

function bundleOf(db) {
  const cards = collectCurrentSourceCards(db, { logger: QUIET }).map(sourceCardToCard);
  return {
    cards,
    bundle: compileCards({
      cards, versionId: "candidate", treeSha256: "t", codeContract: BRAIN_CODE_CONTRACT,
      db, todayIso: TODAY, logger: QUIET,
    }),
  };
}

// บทสนทนาที่ "ลูกแพรเคยตอบไว้แล้ว" — ของจริงมาจากรอบ eval ที่จ่ายเงินไปแล้ว
function seedGolden(db) {
  db.upsertGoldenTurn({
    caseId: "probe-price-01", title: "ถามราคาก่อนรู้จักคลาส", turnNo: 1,
    syntheticText: "ราคาเท่าไหร่คะ",
    recordedModelOutput: JSON.stringify([
      "คลาส AI Agent for Business ราคา 11,900 บาทค่ะ",
      "สนใจดูรอบเรียนไหมคะ",
    ]),
    expected: [{ type: "must_have_price" }, { type: "ends_with_question" }],
    severity: "lead", origin: "eval_case", scope: { product: ["AI Agent for Business"] },
  });
  db.upsertGoldenTurn({
    caseId: "probe-logistics-01", title: "ถามที่จอดรถ", turnNo: 1,
    syntheticText: "ที่จอดรถมีไหมคะ",
    recordedModelOutput: JSON.stringify(["มีที่จอดฟรี 2 ชั่วโมงค่ะ สะดวกมาช่วงเช้าไหมคะ"]),
    expected: [{ type: "ends_with_question" }],
    severity: "style", origin: "eval_case", scope: { product: ["คลาสสด"] },
  });
  db.upsertGoldenTurn({
    caseId: "ledger-money-01", title: "ลูกค้าแจ้งโอนเงิน", turnNo: 1,
    syntheticText: "โอนแล้วนะคะ ส่งสลิปให้แล้ว",
    recordedModelOutput: JSON.stringify(["รับเรื่องแล้วค่ะ เดี๋ยวทีมงานตรวจสลิปให้นะคะ"]),
    expected: [{ type: "team_notified" }],
    severity: "irreversible", origin: "ledger_payment", scope: { product: "*" },
  });
}

test("เคสจริง: แก้ราคาแล้วคำตอบเก่ายังพูดราคาเดิม -> ตกใหม่ = บล็อก", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  seedGolden(db);
  const before = bundleOf(db);

  // พี่ง้วงขึ้นราคา — ตารางที่ด่านราคายอมรับเปลี่ยนทั้งชุด
  db.setApprovedPrice("AI Agent for Business", 12900);
  const after = bundleOf(db);

  const report = runGate5({
    turns: db.listGoldenTurns(), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched: ["price:AI Agent for Business"], db,
  });

  assert.equal(report.verdict, "block", `ต้องบล็อก — ${JSON.stringify(report.summary)}`);
  const priceFail = report.blocking.find((f) => f.cardId === "probe-price-01" && f.detail === "price_not_approved");
  assert.ok(priceFail, `ต้องชี้ว่า probe-price-01 พังเรื่องราคา — ${JSON.stringify(report.blocking)}`);
  assert.match(priceFail.message, /ตารางราคา/u, "ข้อความต้องเป็นภาษาไทยที่คนอ่านออก");
  assert.equal(priceFail.attributed, true, "ต้องระบุว่าเกิดจากการแก้ครั้งนี้ ไม่ใช่หนี้เก่า");
  db.close();
});

test("ราคาที่ยังไม่เปลี่ยน -> ผ่าน และไม่มี finding ปลอม", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  seedGolden(db);
  const { cards, bundle } = bundleOf(db);
  const report = runGate5({
    turns: db.listGoldenTurns(), cards, bundle, previousBundle: bundle,
    touched: ["price:AI Agent for Business"], db,
  });
  assert.equal(report.verdict, "pass", JSON.stringify(report.blocking.concat(report.needsAck)));
  db.close();
});

test("หนี้เก่า (ตกทั้งสองรุ่น) = ต้องรับทราบ ไม่ใช่บล็อกงานประจำวัน", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  // คำตอบที่บันทึกไว้พูดเลขที่ไม่เคยอยู่ในตารางเลย ตั้งแต่ก่อนการแก้ครั้งนี้
  db.upsertGoldenTurn({
    caseId: "probe-old-debt", title: "ราคาเก่าที่ไม่มีในตาราง", syntheticText: "เท่าไหร่",
    recordedModelOutput: JSON.stringify(["ราคา 7,777 บาทค่ะ"]),
    expected: [], severity: "lead", origin: "eval_case", scope: { product: "*" },
  });
  const before = bundleOf(db);
  db.setApprovedPrice("AI Agent for Business", 12900);
  const after = bundleOf(db);
  const report = runGate5({
    turns: db.listGoldenTurns(), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched: ["price:AI Agent for Business"], db,
  });
  assert.equal(report.verdict, "needs_ack", JSON.stringify(report.blocking));
  assert.equal(report.needsAck[0].attributed, false);
  db.close();
});

test("กติกาการเลือก: ไม่ใช่ทั้งคลัง แต่ไม่พลาดเคสที่กู้ไม่ได้", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  seedGolden(db);
  const { cards } = bundleOf(db);
  const turns = db.listGoldenTurns();

  // แก้ความรู้เรื่องที่จอดรถ: ต้องดึงเคสที่จอดรถ (จับคำ) + เคส floor เท่านั้น
  const parking = cards.find((card) => card.kind === "fact" && card.body.title === "ที่จอดรถ");
  const picked = selectGoldenCases({ turns, cards, touched: [parking.itemId] });
  assert.deepEqual([...picked.keys()].sort(), ["ledger-money-01", "probe-logistics-01"],
    "การแก้เรื่องที่จอดรถต้องไม่ลากบทสนทนาเรื่องราคามาตรวจ");
  assert.deepEqual(picked.get("ledger-money-01").reasons, ["floor"]);
  assert.deepEqual(picked.get("probe-logistics-01").reasons, ["keyword"]);

  // แก้ราคา: ตารางตัวเลขเป็นชุดเดียวทั้งธุรกิจ -> ทุกเคสที่พูดเรื่องเงินต้องถูกดึงมา
  const priced = selectGoldenCases({ turns, cards, touched: ["price:AI Agent for Business"] });
  assert.ok(priced.has("probe-price-01"), "เคสราคาต้องถูกเลือกเมื่อแก้ราคา");
  assert.ok(priced.has("ledger-money-01"), "เคส floor ถูกเลือกเสมอ");
  db.close();
});

test("ลบราคาทิ้ง = การแก้ที่อันตรายที่สุด ต้องยังเลือกบทสนทนาที่พูดราคานั้นได้", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  seedGolden(db);
  const before = bundleOf(db);
  // การ์ดที่ถูกลบไม่อยู่ใน cards ของรุ่นใหม่แล้ว — ถ้าเลือกจากรุ่นใหม่อย่างเดียว
  // ด่านจะมองไม่เห็นว่ามีอะไรถูกแตะ แล้วรายงานว่าปลอดภัยทั้งที่ทุกคำตอบที่พูดราคานั้นพัง
  db.raw.prepare("DELETE FROM approved_prices WHERE amount = 11900").run();
  const after = bundleOf(db);
  const touched = ["price:AI Agent for Business"];
  const report = runGate5({
    turns: db.listGoldenTurns(), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched, db,
  });
  assert.equal(report.verdict, "block", `ต้องบล็อก — ${JSON.stringify(report.summary)}`);
  assert.ok(report.blocking.some((f) => f.cardId === "probe-price-01" && f.detail === "price_not_approved"),
    `ต้องจับได้ว่าคำตอบเดิมพูดราคาที่ถูกลบไปแล้ว — ${JSON.stringify(report.blocking)}`);
  db.close();
});

test("เคส irreversible ที่เจ้าของปิดไปแล้ว ต้องยังบล็อกอยู่ (สัญญาที่เขียนไว้สี่ที่)", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  db.upsertGoldenTurn({
    caseId: "ledger-money-02", title: "ลูกค้าโอนเงิน", syntheticText: "ราคาเท่าไหร่คะ",
    recordedModelOutput: JSON.stringify(["ราคา 11,900 บาทค่ะ"]),
    expected: [], severity: "irreversible", origin: "ledger_payment", scope: { product: "*" },
  });
  const before = bundleOf(db);
  db.setApprovedPrice("AI Agent for Business", 12900);
  const after = bundleOf(db);
  const run = () => runGate5({
    turns: db.listGoldenTurns({ includeRetired: true }), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched: ["price:AI Agent for Business"], db,
  });
  assert.equal(run().verdict, "block", "ก่อนปิดเคส: บล็อก");

  assert.ok(db.retireGoldenCase("ledger-money-02", { by: "owner", reason: "เกณฑ์นี้ล้าสมัยแล้วจริง ๆ" }) > 0);
  const afterRetire = run();
  assert.equal(afterRetire.verdict, "block",
    "ปิดเกณฑ์ที่ไม่ทันสมัยได้ แต่ปิดด่านที่กันเรื่องกู้ไม่ได้ไม่ได้ — สัญญาข้อนี้เขียนไว้ทั้งใน schema/store/API/จอ");
  assert.ok(afterRetire.cases.some((row) => row.reasons.includes("floor_retired")));
  db.close();
});

test("เคสที่ไม่ใช่ floor เมื่อถูกปิดแล้ว ต้องไม่ถูกตรวจอีก", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  seedGolden(db);
  db.retireGoldenCase("probe-price-01", { by: "owner", reason: "ราคาเปลี่ยนแล้ว เกณฑ์เดิมล้าสมัย" });
  const before = bundleOf(db);
  db.setApprovedPrice("AI Agent for Business", 12900);
  const after = bundleOf(db);
  const report = runGate5({
    turns: db.listGoldenTurns({ includeRetired: true }), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched: ["price:AI Agent for Business"], db,
  });
  assert.equal(report.cases.some((row) => row.caseId === "probe-price-01"), false,
    "เคสที่ปิดแล้วและไม่ใช่ floor ต้องหลุดออกจากการตรวจ — นั่นคือความหมายของการปิด");
  db.close();
});

test("กฎที่ตารางของรุ่นทำให้พลิกไม่ได้ ต้องไม่กลายเป็น finding", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  // คำตอบที่ตกกฎ 'ไม่จบด้วยคำถาม' ซึ่งไม่มีทางเกี่ยวกับตารางราคาเลย
  db.upsertGoldenTurn({
    caseId: "probe-style", title: "สำนวน", syntheticText: "ราคาเท่าไหร่คะ",
    recordedModelOutput: JSON.stringify(["ราคา 11,900 บาทค่ะ"]),
    expected: [{ type: "ends_with_question" }], severity: "lead",
    origin: "eval_case", scope: { product: "*" },
  });
  const before = bundleOf(db);
  db.setApprovedPrice("AI Agent for Business", 12900);
  const after = bundleOf(db);
  const report = runGate5({
    turns: db.listGoldenTurns(), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched: ["price:AI Agent for Business"], db,
  });
  assert.ok(report.summary.outOfScope.includes("ends_with_question"),
    "ต้องรายงานว่ามีข้อที่ด่านนี้ตัดสินแทนไม่ได้ ไม่ใช่เงียบ");
  assert.equal(report.blocking.some((f) => f.detail === "ends_with_question"), false,
    "กฎที่ตารางทำให้พลิกไม่ได้ ห้ามกลายเป็นข้อที่บล็อกคนแก้");
  assert.deepEqual(report.summary.judged, ["price_not_approved", "must_have_price", "banned_phrase"]);
  db.close();
});

test("ไม่มีคำตอบให้เล่นซ้ำ + แก้เนื้อคำตอบ = เทา (not_applicable) ห้ามเป็น pass", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  db.upsertGoldenTurn({
    caseId: "probe-no-record", title: "ยังไม่เคยรัน", syntheticText: "ราคาเท่าไหร่คะ",
    expected: [{ type: "must_have_price" }], severity: "lead", origin: "eval_case", scope: { product: "*" },
  });
  const before = bundleOf(db);
  db.setApprovedPrice("AI Agent for Business", 12900);
  const after = bundleOf(db);
  const report = runGate5({
    turns: db.listGoldenTurns(), cards: after.cards, bundle: after.bundle,
    previousBundle: before.bundle, touched: ["price:AI Agent for Business"], db,
  });
  assert.equal(report.verdict, "not_applicable");
  assert.match(report.summary.reason, /ยังไม่มีคำตอบที่บันทึกไว้/u);
  db.close();
});

test("เทิร์นที่ชี้ข้อความจริงซึ่งถูกลบไปแล้ว = unresolvable ไม่ใช่ผ่าน", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  const id = "U-gate5";
  db.upsertCustomer(id, { displayName: "ลูกค้า" });
  const messageId = db.insertMessage({ customerId: id, direction: "in", content: "โอนแล้วค่ะ" });
  db.upsertGoldenTurn({
    caseId: "real-01", title: "ห้องจริง", messageRef: messageId, text: "โอนแล้วค่ะ",
    expected: [{ type: "team_notified" }], severity: "irreversible", origin: "ledger_payment",
  });
  const turn = db.getGoldenTurn("real-01#1");
  const { bundle } = bundleOf(db);
  // ยังไม่มีคำตอบที่บันทึกไว้ = ตรวจได้แค่เส้นทาง แต่ "อ่านข้อความได้" ซึ่งคือประเด็นของเทสต์นี้
  assert.equal(replayGoldenTurn(turn, bundle, { db }).status, "route_only");

  // ลบข้อความทิ้ง (จำลองว่ามันหายไปด้วยเหตุอื่นที่ไม่ใช่ cascade) -> ต้องบอกว่าอ่านไม่ได้
  db.raw.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
  assert.equal(replayGoldenTurn(turn, bundle, { db }).status, "unresolvable");
  db.close();
});

test("แฟล็กปิด = บันไดตัดสินเหมือนเฟส 1b ทุกไบต์ (G5/G8 เป็นเทา)", () => {
  const db = memoryDb(GOLDEN_DB);
  seed(db);
  seedGolden(db);
  db.setApprovedPrice("AI Agent for Business", 12900);
  const { cards, bundle } = bundleOf(db);
  const off = runBrainGates({
    cards, bundle, touched: ["price:AI Agent for Business"], todayIso: TODAY,
    goldenTurns: db.listGoldenTurns(), db,
  });
  assert.equal(off.gates.find((g) => g.id === "G5").verdict, "not_applicable");
  assert.match(off.gates.find((g) => g.id === "G5").detail.reason, /ยังปิดอยู่/u);

  const on = runBrainGates({
    cards, bundle, previousBundle: bundle, touched: ["price:AI Agent for Business"], todayIso: TODAY,
    gateMode: "offline", goldenTurns: db.listGoldenTurns(), db, recordEvalRuns: false,
  });
  assert.notEqual(on.gates.find((g) => g.id === "G5").verdict, "not_applicable");
  db.close();
});
