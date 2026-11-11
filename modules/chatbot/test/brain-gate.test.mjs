// brain-gate.test.mjs — บันไดด่านตรวจ G0–G4 ของเฟส 1b
//
// สิ่งที่เทสต์นี้ต้องกันไว้ให้ได้:
//   - ด่านที่เสียเองต้องบอกว่าเสีย ไม่ใช่ตอบ "ผ่าน" (G0 — R47)
//   - "หนี้ความรู้ที่มีอยู่ก่อน" ห้ามบล็อกงานประจำวัน แต่ห้ามเงียบด้วย -> needs_ack
//   - ของที่ "การแก้ครั้งนี้" ทำพัง ต้องบล็อก ไม่ว่าการ์ดใบนั้นจะมาจากการนำเข้าหรือไม่
//   - รับทราบหนี้ก้อนเดิมแล้ว ครั้งต่อไปต้องไม่ถามซ้ำ (ไม่งั้นด่านกลายเป็นปุ่มที่คนกดปิดตา)
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { collectCurrentSourceCards } from "../src/brain/sources.mjs";
import { compileCards, sourceCardToCard } from "../src/brain/compile.mjs";
import { runBrainGates, brainGateSelfTest, findingKey, BRAIN_CODE_CONTRACT_REGISTRY } from "../src/brain/gate.mjs";
import { BRAIN_CODE_CONTRACT } from "../src/brain/import.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

const QUIET = { warn() {}, debug() {}, log() {} };
const TODAY = "2026-09-03";

function seed(db) {
  db.addKnowledge({ title: "แคตตาล็อกคลาส", content: "คลาส AI Agent for Business", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบสอนสด", product: "AI Agent for Business", status: "open", capacity: 15 },
  ]));
}

function gateNow(db, { touched = [], acks = [], previousBundle = null } = {}) {
  const cards = collectCurrentSourceCards(db, { logger: QUIET }).map(sourceCardToCard);
  const bundle = compileCards({
    cards, versionId: "candidate", treeSha256: "t", codeContract: BRAIN_CODE_CONTRACT,
    db, todayIso: TODAY, logger: QUIET,
  });
  return runBrainGates({ cards, bundle, touched, inheritedAcks: acks, previousBundle, todayIso: TODAY });
}

test("G4: เลขในลิงก์รีวิวไม่รับหนี้ราคาของใบอื่น แต่หนี้เก่ายังต้องรับทราบ", () => {
  const db = memoryDb();
  try {
    seed(db);
    db.setSetting(PRODUCT_RULES_KEY, "ถ้าลูกค้าถามราคาโปร 9900 ให้ตอบว่ายืนราคานี้");
    const fresh = db.addKnowledge({ title: "รีวิวนักเรียนจริง", content: "รีวิว: https://www.facebook.com/reel/1000000001", updatedBy: "owner" });
    const report = gateNow(db, { touched: [`fact:${fresh.id}`] });
    assert.equal(report.verdict, "needs_ack");
    assert.equal(report.blocking.length, 0);
    assert.ok(report.needsAck.some(f => f.code === "G4" && f.amountText === "9900"));
    const acks = [{ by: "owner", at: 1, items: report.needsAck.map(findingKey) }];
    assert.equal(gateNow(db, { touched: [`fact:${fresh.id}`], acks }).verdict, "pass");
  } finally { db.close(); }
});

test("G4: รับทราบเลขเก่าแล้วก็ห้ามเพิ่มราคาผิดเลขเดียวกันในใบที่เพิ่งแก้", () => {
  const db = memoryDb();
  try {
    seed(db);
    db.setSetting(PRODUCT_RULES_KEY, "ถ้าลูกค้าถามราคาโปร 9900 ให้ตอบว่ายืนราคานี้");
    const acks = [{ by: "owner", at: 1, items: gateNow(db).needsAck.map(findingKey) }];
    const fresh = db.addKnowledge({ title: "ราคาพิเศษ", content: "ราคาโปร 9900", updatedBy: "owner" });
    const report = gateNow(db, { touched: [`fact:${fresh.id}`], acks });
    assert.equal(report.verdict, "block");
    assert.ok(report.blocking.some(f => f.code === "G4" && f.amountText === "9900"));
  } finally { db.close(); }
});

test("G4: ลบราคาที่อนุมัติทำให้กติกาเดิมผิด ต้องเป็นปัญหาใหม่ไม่ใช่หนี้เก่า", () => {
  const db = memoryDb();
  try {
    seed(db);
    db.setApprovedPrice("ราคาเดิม", 9900);
    db.setSetting(PRODUCT_RULES_KEY, "ถ้าลูกค้าถามราคาโปร 9900 ให้ตอบว่ายืนราคานี้");
    const cards = collectCurrentSourceCards(db, { logger: QUIET }).map(sourceCardToCard);
    const previousBundle = compileCards({ cards, db, codeContract: BRAIN_CODE_CONTRACT, todayIso: TODAY, logger: QUIET });
    db.deleteApprovedPrice("ราคาเดิม");
    for (const baseline of [previousBundle, null]) {
      const report = gateNow(db, { touched: ["price:ราคาเดิม"], previousBundle: baseline });
      assert.equal(report.verdict, "block");
      assert.ok(report.blocking.some(f => f.code === "G4" && f.amountText === "9900"));
    }
  } finally { db.close(); }
});

test("G4: วันที่และ provenance ไม่ใช่ราคาที่เพิ่งเพิ่ม", () => {
  const db = memoryDb();
  try {
    seed(db);
    db.setSetting(PRODUCT_RULES_KEY, "ถ้าลูกค้าถามราคาโปร 2026 ให้ตอบว่ายืนราคานี้");
    const fresh = db.addKnowledge({ title: "บทเรียน", content: "บทเรียนประจำปี 2026", updatedBy: "owner" });
    const report = gateNow(db, { touched: [`fact:${fresh.id}`] });
    assert.equal(report.verdict, "needs_ack");
    assert.equal(report.blocking.length, 0);
  } finally { db.close(); }
});

test("G0 ตรวจตัวเองผ่านกับเครื่องมือที่ยังดีอยู่", () => {
  const report = brainGateSelfTest();
  assert.equal(report.ok, true, `G0 ต้องผ่านบนโค้ดปัจจุบัน — ${JSON.stringify(report.problems)}`);
});

test("แหล่งข้อมูลที่สะอาด + ไม่แตะอะไรเลย -> ผ่านทั้งบันได", () => {
  const db = memoryDb();
  seed(db);
  const report = gateNow(db);
  assert.equal(report.verdict, "pass", `ต้องผ่าน — ${JSON.stringify(report.blocking)} / ${JSON.stringify(report.needsAck)}`);
  assert.deepEqual(report.gates.map((g) => g.id), ["G0", "G1", "G2", "G3", "G4", "G5", "G8"]);
  // เฟส 3: ด่านเล่นซ้ำโผล่ในรายงานเสมอ แต่ตอนแฟล็กปิดต้องเป็น "ไม่เกี่ยวกับการแก้นี้" (เทา)
  // ไม่ใช่หายไปเฉย ๆ และไม่ใช่ติ๊กเขียว — เจ้าของต้องรู้ว่ามีตาข่ายอยู่แต่ยังไม่ได้เปิด
  for (const id of ["G5", "G8"]) {
    assert.equal(report.gates.find((g) => g.id === id).verdict, "not_applicable");
  }
  db.close();
});

test("การ์ดที่ 'การแก้ครั้งนี้' แตะ แล้วมีตัวเลขเงินนอกตารางราคา -> บล็อก", () => {
  const db = memoryDb();
  seed(db);
  const entry = db.addKnowledge({ title: "โปรใหม่", content: "ลดเหลือ 12,345 บาท", updatedBy: "chompoo" });
  const report = gateNow(db, { touched: [`fact:${entry.id}`] });
  assert.equal(report.verdict, "block");
  assert.ok(report.blocking.some((f) => f.code === "L02"), "ต้องบล็อกด้วย L02");
  db.close();
});

test("การ์ดใบเดียวกันแต่ 'ไม่ได้แตะครั้งนี้' -> ไม่บล็อก แต่ต้องรับทราบ ไม่ใช่เงียบ", () => {
  const db = memoryDb();
  seed(db);
  db.addKnowledge({ title: "โปรเก่า", content: "ลดเหลือ 12,345 บาท", updatedBy: "owner" });
  const fresh = db.addKnowledge({ title: "ที่จอดรถ", content: "จอดได้ 4 ชั่วโมง", updatedBy: "chompoo" });
  const report = gateNow(db, { touched: [`fact:${fresh.id}`] });
  assert.equal(report.verdict, "needs_ack");
  assert.equal(report.blocking.length, 0, "หนี้เก่าห้ามบล็อกงานประจำวัน");
  assert.ok(report.needsAck.some((f) => f.code === "L02"));
  db.close();
});

test("รับทราบหนี้ก้อนเดิมแล้ว รอบถัดไปไม่ถามซ้ำ — แต่หนี้ก้อนใหม่ยังถาม", () => {
  const db = memoryDb();
  seed(db);
  const old = db.addKnowledge({ title: "โปรเก่า", content: "ลดเหลือ 12,345 บาท", updatedBy: "owner" });
  const first = gateNow(db);
  assert.equal(first.verdict, "needs_ack");
  const acks = [{ by: "ngoung", at: 1, items: first.needsAck.map(findingKey) }];

  const second = gateNow(db, { acks });
  assert.equal(second.verdict, "pass", "หนี้ที่รับทราบแล้วต้องไม่ถามซ้ำ");

  db.addKnowledge({ title: "โปรอีกใบ", content: "แถมอีก 9,999 บาท", updatedBy: "owner" });
  const third = gateNow(db, { acks });
  assert.equal(third.verdict, "needs_ack", "หนี้ก้อนใหม่ต้องถามใหม่");
  assert.ok(!third.needsAck.some((f) => f.cardId === `fact:${old.id}`), "ก้อนที่รับทราบแล้วต้องไม่กลับมา");
  db.close();
});

test("G1 ปฏิเสธ code_contract ที่โค้ดชุดนี้ไม่รู้จัก และ enforcement.ref นอกทะเบียน", () => {
  const db = memoryDb();
  seed(db);
  const cards = collectCurrentSourceCards(db, { logger: QUIET }).map(sourceCardToCard);
  const bundle = compileCards({
    cards, versionId: "candidate", treeSha256: "t", codeContract: "brain-from-the-future-9",
    db, todayIso: TODAY, logger: QUIET,
  });
  const wrongContract = runBrainGates({ cards, bundle, touched: [], todayIso: TODAY });
  assert.equal(wrongContract.verdict, "block");
  assert.ok(wrongContract.blocking.some((f) => f.code === "G1"));

  const tampered = cards.map((card) => (card.key === "policy:product_rules"
    ? { ...card, body: { ...card.body, enforcement: { kind: "route", ref: "code.doesNotExist" } } }
    : card));
  const refBundle = compileCards({
    cards: tampered, versionId: "candidate", treeSha256: "t", codeContract: BRAIN_CODE_CONTRACT,
    db, todayIso: TODAY, logger: QUIET,
  });
  const badRef = runBrainGates({ cards: tampered, bundle: refBundle, touched: ["policy:product_rules"], todayIso: TODAY });
  assert.equal(badRef.verdict, "block");
  assert.ok(badRef.blocking.some((f) => f.code === "G1" && /code\.doesNotExist/u.test(f.message)));
  assert.ok(BRAIN_CODE_CONTRACT_REGISTRY.includes("tags.composeTagRules"));
  db.close();
});

test("G4 จับเลขที่ L02 มองไม่เห็น — ด่านราคาตัวจริงอ่าน 'ข้อความทั้งก้อน' ไม่ใช่การ์ดทีละใบ", () => {
  const db = memoryDb();
  seed(db);
  // "9900" ไม่มีคอมมาและไม่มีคำว่าบาท -> L02 (ที่จับรูปเงินในการ์ดใบเดียว) มองไม่เห็น
  // แต่ด่านราคาตัวจริงอ่านบริบท "ราคาโปร ..." แล้วตัดประโยคนี้ทิ้งตอนตอบลูกค้า
  db.setSetting(PRODUCT_RULES_KEY, "ถ้าลูกค้าถามราคาโปร 9900 ให้ตอบว่ายืนราคานี้");
  const report = gateNow(db, { touched: ["policy:product_rules"] });
  assert.equal(report.verdict, "block");
  assert.ok(report.blocking.some((f) => f.code === "G4" && /9900/u.test(f.message)),
    `ต้องมีข้อ G4 ที่ชี้ตัวเลข — ${JSON.stringify(report.blocking)}`);
  assert.ok(!report.blocking.some((f) => f.code === "L02"), "เคสนี้ต้องมาจาก G4 ไม่ใช่ L02");
  db.close();
});

test("G4 ที่มาจากข้อความเก่า ไม่บล็อกการแก้ที่ไม่เกี่ยวกัน", () => {
  const db = memoryDb();
  seed(db);
  db.setSetting(PRODUCT_RULES_KEY, "ถ้าลูกค้าถามราคาโปร 9900 ให้ตอบว่ายืนราคานี้");
  const fresh = db.addKnowledge({ title: "ที่จอดรถ", content: "จอดได้ 4 ชั่วโมง", updatedBy: "chompoo" });
  const report = gateNow(db, { touched: [`fact:${fresh.id}`] });
  assert.equal(report.verdict, "needs_ack");
  assert.equal(report.blocking.length, 0);
  assert.ok(report.needsAck.some((f) => f.code === "G4"));
  db.close();
});

test("L07 งบตัวอักษร: ล้นอยู่ก่อนแล้วต้องไม่ล็อกการแก้ที่ทำให้เล็กลง", () => {
  const db = memoryDb();
  seed(db);
  // ทำให้คลังความรู้ล้นเพดานตั้งแต่ก่อนแก้ (เพดานเทียบเป็น "ก่อนตัด" ตามเจตนาของ L07)
  const filler = "ก".repeat(400);
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(db.addKnowledge({ title: `ยาว ${i}`, content: filler, updatedBy: "owner" }).id);
  }
  const smallCap = { maxChars: 500 };
  const cardsOf = () => collectCurrentSourceCards(db, { logger: QUIET }).map(sourceCardToCard);
  const bundleOf = (cards) => compileCards({
    cards, versionId: "c", treeSha256: "t", codeContract: BRAIN_CODE_CONTRACT,
    db, todayIso: TODAY, logger: QUIET, ...smallCap,
  });

  const beforeCards = cardsOf();
  const previousBundle = bundleOf(beforeCards);
  assert.ok(previousBundle.lints.some((f) => f.code === "L07"), "ต้องล้นอยู่ก่อนแล้วจริง");

  // ปิดรายการหนึ่งใบ = คลังเล็กลง — ต้องไม่ถูกบล็อก
  db.updateKnowledge(ids[0], { active: false, updatedBy: "owner" });
  const smaller = cardsOf();
  const shrink = runBrainGates({
    cards: smaller, bundle: bundleOf(smaller), touched: [`fact:${ids[0]}`],
    todayIso: TODAY, previousBundle,
  });
  assert.equal(shrink.blocking.some((f) => f.code === "L07"), false,
    "ทางแก้ทางเดียวที่มีคือลบเนื้อออก ห้ามบล็อกทางนั้น");
  assert.ok(shrink.needsAck.some((f) => f.code === "L07"), "แต่ต้องยังบอกว่ายังล้นอยู่");

  // เพิ่มเนื้อเข้าไปอีก = ทำให้แย่ลง — ต้องบล็อก
  const added = db.addKnowledge({ title: "ยาวอีก", content: filler, updatedBy: "owner" });
  const bigger = cardsOf();
  const grow = runBrainGates({
    cards: bigger, bundle: bundleOf(bigger), touched: [`fact:${added.id}`],
    todayIso: TODAY, previousBundle,
  });
  assert.ok(grow.blocking.some((f) => f.code === "L07"), "เพิ่มจนล้นขึ้นต้องถูกบล็อกที่คนเพิ่ม");
  db.close();
});

// G4 เคยเตือนเลขที่ด่านจริงไม่เคยแตะ เพราะเอาคลังทั้งคลังมาต่อกันแล้วบริบทราคาข้ามใบ
// (ของจริง 3 ก.ย. 2026: 20 จาก 27 ข้อเป็นเลขอย่าง 1 / 2 / 17 / 2026) คำเตือนที่ไม่มีวัน
// เกิดจริงอันตรายกว่าไม่มีคำเตือน — มันสอนให้คนกด "รับทราบ" โดยไม่อ่าน
test("G4: บริบทราคาไม่รั่วข้ามการ์ด แต่ยังจับเลขในใบเดียวกันได้", () => {
  const db = memoryDb();
  seed(db);
  // ใบก่อนจบด้วย "บาท" — ใบถัดไปขึ้นต้นด้วยเลขลำดับที่ไม่ใช่ราคา
  db.addKnowledge({ title: "ราคา", content: "In-house ราคา 19,900 บาทค่ะ", updatedBy: "owner" });
  db.addKnowledge({ title: "ขั้นตอน", content: "ขั้นตอนที่ 1 กรอกฟอร์ม แล้วรอทีมงานยืนยัน", updatedBy: "owner" });
  const flagged = gateNow(db).gates.find((g) => g.id === "G4").detail.map((f) => f.amountText);
  assert.deepEqual(flagged, [], `G4 ไม่ควรเตือนเลขลำดับ แต่เตือน: ${flagged.join(", ")}`);

  // ของจริงที่ต้องยังจับได้: เลขในบริบทเงินภายในการ์ดใบเดียว
  db.addKnowledge({ title: "ข้อโต้แย้ง", content: "เคสจริงเคยเสียเงินราว 8,000 บาท/หัว", updatedBy: "owner" });
  const after = gateNow(db).gates.find((g) => g.id === "G4").detail.map((f) => f.amountText);
  assert.deepEqual(after, ["8,000"]);
});
