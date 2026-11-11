// รูปเข้ามาแล้วเดินทางไปทางไหน — จุดที่พฤติกรรมจริงเปลี่ยน (คำสั่งเจ้าของ 2026-08-29)
//
// เดิม: รูปทุกใบ -> escalate image_review -> บอทเงียบ + ห้องติดธงเงินถาวร
// ใหม่: จำแนกก่อน · เฉพาะ "other" ที่จำแนกสำเร็จเท่านั้นที่ปล่อยให้ AI คุยต่อ
//
// สิ่งที่เทสต์นี้ต้องกันไว้ให้ได้ คือความล้มเหลวทุกแบบต้องตกกลับไปทางเดิมเสมอ
// เพราะพลาดจับสลิป = บอทอาจยืนยันยอดเอง เงินผิดกู้คืนไม่ได้
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { touchesMoney } from "../src/needsHumanSla.mjs";
import { routeMessage } from "../src/safetyRouter.mjs";
import { paymentStartedFromRow } from "../src/pipeline.mjs";
import { classifyImage } from "../src/imageClassifier.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function makeApp({ imageClassify } = {}) {
  const config = testConfig();
  const db = memoryDb();
  const line = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub("สวัสดีค่ะ รูปนี้เป็นโพสต์คลาสของพี่ง้วงค่ะ"), lineFetch: line, sleep: async () => {}, ...(imageClassify ? { imageClassify } : {}) },
    logger: silent,
  });
  return { app, db, line };
}
const imageEvent = (userId, id) => ({ type: "message", replyToken: "rt", source: { userId }, message: { type: "image", id } });
function seed(db, userId, id) {
  db.upsertCustomer(userId, {});
  db.insertMessage({ id: `in:${id}`, customerId: userId, direction: "in", msgType: "image", content: `[image] id=${id}` });
}

test("ปิดสวิตช์ (ค่าเริ่มต้น) — พฤติกรรมเดิมทุกอย่าง ไม่เรียกตัวจำแนกเลย", async () => {
  let called = 0;
  const { app, db } = makeApp({ imageClassify: { enabled: false, classify: async () => { called += 1; return { kind: "other" }; } } });
  seed(db, "U-off", "m1");
  const r = await app.pipeline.handleEvent(imageEvent("U-off", "m1"));
  assert.equal(r.route, "media_review");
  assert.equal(db.getCustomer("U-off").state, "NEEDS_HUMAN");
  assert.equal(called, 0, "ปิดแล้วต้องไม่เสียเงินเรียกโมเดล");
});

test("จำแนกว่าไม่ใช่เรื่องเงิน — บอทคุยต่อ ไม่ปักธง", async () => {
  const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => ({ kind: "other", description: "ภาพโพสต์โฆษณาคลาสสอน AI" }) } });
  seed(db, "U-other", "m2");
  const r = await app.pipeline.handleEvent(imageEvent("U-other", "m2"));
  assert.notEqual(r.route, "media_review", "ต้องไม่เข้าเส้นรอคนตรวจ");
  const c = db.getCustomer("U-other");
  assert.notEqual(c.state, "NEEDS_HUMAN", "ห้ามปักธงรอคน");
  assert.equal(Number(c.money_seen_at || 0), 0, "ห้ามปักธงเงิน — ปักแล้วปลดไม่ได้");
});

test("จำแนกว่าเป็นสลิป/เอกสาร — เหมือนเดิมทุกอย่าง", async () => {
  for (const kind of ["slip", "document"]) {
    const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => ({ kind, description: "x" }) } });
    seed(db, `U-${kind}`, `m-${kind}`);
    const r = await app.pipeline.handleEvent(imageEvent(`U-${kind}`, `m-${kind}`));
    assert.equal(r.route, "media_review", `${kind} ต้องเข้าเส้นรอคนตรวจ`);
    assert.equal(db.getCustomer(`U-${kind}`).state, "NEEDS_HUMAN");
  }
});

test("จำแนกไม่ได้ / ตัวจำแนกโยน error / คืนค่าเพี้ยน — ต้องตกกลับทางเดิมเสมอ", async () => {
  const cases = [
    ["unknown", async () => ({ kind: "unknown" })],
    ["throw", async () => { throw new Error("timeout"); }],
    ["null", async () => null],
    ["ค่าแปลก", async () => ({ kind: "ไม่รู้" })],
  ];
  for (const [label, classify] of cases) {
    const { app, db } = makeApp({ imageClassify: { enabled: true, classify } });
    const uid = `U-${label}`;
    seed(db, uid, `m-${label}`);
    const r = await app.pipeline.handleEvent(imageEvent(uid, `m-${label}`));
    assert.equal(r.route, "media_review", `${label} ต้อง fail closed`);
    assert.equal(db.getCustomer(uid).state, "NEEDS_HUMAN", `${label} ต้องยังปักธงรอคน`);
  }
});

// v1.5.2 (probe-money-02 ตกจริง 2026-08-30): สลิปเข้าแล้วธงติดแต่ AI ยังเปิด
// ลูกค้าจี้ถามยอดต่อ บอทตอบ template เงินซ้ำไปเรื่อย ๆ — จังหวะเงินต้องเป็น
// ของคนจริง 100% เหมือนเส้นแจ้งโอนด้วยข้อความ (sticky off จนกว่าแอดมินเปิดคืน)
// F6 (ตรวจย้อนหลัง ก.ย. 2026): "ปิด AI" ผูกกับบริบทเงินแล้ว — ห้องที่ยังไม่มีเรื่องเงินคุยต่อพร้อมข้อความ
// ตอบรับ (ดู test/media-no-money-room.test.mjs) · เทสต์นี้คุมห้องที่มีเรื่องเงินแล้ว ซึ่งต้องเหมือนเดิมทุกอย่าง
test("รูปเส้นเงิน (สลิป/เอกสาร/จำแนกไม่ได้) = ปิด AI ทันที ไม่ใช่แค่ติดธง", async () => {
  const { app, db } = makeApp();
  seed(db, "U-sticky", "m-sticky");
  db.setDealStatus("U-sticky", "awaiting_payment");
  await app.pipeline.handleEvent(imageEvent("U-sticky", "m-sticky"));
  const c = db.getCustomer("U-sticky");
  assert.equal(c.ai_enabled, 0, "สลิปเข้า = AI ปิดทันที รอคนจริง");
  assert.equal(c.ai_off_reason, "money_line");
});

// ---- เคสจริง 2026-09-05 (พี่ง้วงแจ้งเอง): ธงเงินถาวรจากรูปที่ไม่รู้ว่าอะไร ----
//
// IMAGE_CLASSIFY_ENABLED ไม่เคยถูกตั้งในโปรดักชันจนถึงคืน 5 ก.ย. รูปทุกใบจึงเดินเส้นเงินเต็ม
// (ปิด AI + ปักธงเงินถาวร) — 14 ห้องปิดใน 7 วัน และเมื่อจำแนกย้อนหลังด้วยตัวจำแนกจริง
// ได้ "other" 9 ใบ สลิปจริงใบเดียว อีก 3 ใบเกตเวย์ปฏิเสธเพราะรูป 1,067,264 ไบต์ใหญ่เกิน
//
// ธงเงินคือความเสียหายที่กู้ยากที่สุด: ปลดด้วยมือไม่ได้ (ต้องลบบทสนทนาทั้งห้อง) และ
// paymentStartedFor อ่านมันตลอดไป -> คำว่าใบเสร็จ/ใบกำกับ/สลิปหลังจากนั้นถูกปัดด้วยแม่แบบ
// ตรวจปรปักษ์ 2026-09-05 แก้เส้นแบ่งของเทสต์นี้: ไม่ใช่ "จำแนกได้/ไม่ได้" แต่เป็น
// "ระบบเคยเห็นไบต์ของรูปใบนี้หรือยัง" — สลิปจริง ~900KB ที่ตกด่านขนาดยังเป็นสลิปอยู่
// ถ้าไม่ปักธง ห้องนั้นจะไม่มีตรา 💰 ในคิวรอคน = ops มองไม่ออกว่าเป็นเรื่องเงิน (แย่กว่าเดิม)
// เหตุ 14 ห้องที่พี่ง้วงแจ้งคือฝั่ง "ไม่เคยเห็นเลย" ล้วน ๆ (สวิตช์ไม่เคยถูกเปิด)
test("ไม่เคยเห็นไบต์ของรูป (สวิตช์ปิด/ไฟล์ไม่มา) + ห้องยังไม่มีเรื่องเงิน = ห้ามปักธงเงินถาวร", async () => {
  for (const [label, verdict] of [
    ["สวิตช์ปิด", { kind: "unknown", reason: "สวิตช์จำแนกรูปปิดอยู่", reasonCode: "disabled" }],
    ["ไฟล์ยังไม่มา", { kind: "unknown", reason: "ไม่มีไฟล์รูปให้จำแนกทัน (ดาวน์โหลดไม่เสร็จหรือไฟล์ใช้ไม่ได้)", reasonCode: "no_file" }],
  ]) {
    const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => verdict } });
    seed(db, `U-noattempt-${verdict.reasonCode}`, `m-na-${verdict.reasonCode}`);
    const r = await app.pipeline.handleEvent(imageEvent(`U-noattempt-${verdict.reasonCode}`, `m-na-${verdict.reasonCode}`));
    assert.equal(r.route, "media_review", `${label}: fail-closed ยังอยู่ครบ`);
    const c = db.getCustomer(`U-noattempt-${verdict.reasonCode}`);
    assert.equal(c.state, "NEEDS_HUMAN", `${label}: ยังต้องปักธงรอคนตรวจ`);
    // F6 (ตรวจย้อนหลัง ก.ย. 2026 — D666, D775): ห้องที่ไม่มีเรื่องเงิน รูปที่ยังไม่รู้ว่าอะไรห้ามปิด AI
    assert.equal(c.ai_enabled, 1, `${label}: ห้องที่ยังไม่มีเรื่องเงิน AI ต้องคุยต่อ`);
    assert.equal(Number(c.money_seen_at || 0), 0, `${label}: ห้ามประทับตราถาวรว่าเป็นห้องเงิน`);
    db.close();
  }
});

// ตรวจปรปักษ์ 2026-09-05: เคสจริงที่ทำให้ต้องกลับด้าน — รูปสลิปจริงจากมือถือมักโต 900KB+
// เพดานใหม่ 700KB ทำให้มันตกตั้งแต่ต้นทาง ถ้าไม่ปักธงเงิน ห้องนั้นจะไปนั่งปนกับห้องรอคน
// อีกยี่สิบกว่าห้องโดยไม่มีสัญญาณอะไรเลยว่าเป็นเรื่องเงิน
test("เห็นไบต์แล้วแต่จำแนกไม่ออก (ใหญ่เกิน/เกตเวย์ล้ม) = ยังต้องปักธงเงิน ห้ามให้ตรา 💰 หายไป", async () => {
  for (const verdict of [
    { kind: "unknown", reason: "รูปใหญ่เกิน 900000>700000 (900000 ไบต์)", reasonCode: "too_large" },
    { kind: "unknown", reason: "เรียกโมเดลล้ม: HTTP 400 (1067264 ไบต์)", reasonCode: "model_error" },
    { kind: "unknown", reason: "อ่านคำตอบของโมเดลไม่ออก", reasonCode: "unparsable" },
  ]) {
    const uid = `U-tried-${verdict.reasonCode}`;
    const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => verdict } });
    seed(db, uid, `m-${verdict.reasonCode}`);
    await app.pipeline.handleEvent(imageEvent(uid, `m-${verdict.reasonCode}`));
    const c = db.getCustomer(uid);
    assert.ok(Number(c.money_seen_at) > 0, `${verdict.reasonCode}: สลิปจริงจะหลุดตราเงินในคิวรอคน`);
    assert.ok(touchesMoney(c), `${verdict.reasonCode}: คอนโซล/SLA ต้องอ่านออกว่าห้องนี้แตะเรื่องเงิน`);
    db.close();
  }
});

test("จำแนกไม่ได้ แต่เหตุผลต้องไปโผล่ใน audit — ops ต้องแยก 'เกตเวย์ปฏิเสธ' ออกจาก 'สวิตช์ปิด'", async () => {
  const gateway = makeApp({ imageClassify: { enabled: true, classify: async () => ({ kind: "unknown", reason: "เรียกโมเดลล้ม: HTTP 400 (1067264 ไบต์)", reasonCode: "model_error" }) } });
  seed(gateway.db, "U-why-1", "m-w1");
  await gateway.app.pipeline.handleEvent(imageEvent("U-why-1", "m-w1"));
  const detail1 = gateway.db.listAudit(50).find((row) => row.action === "ai_off_payment_image" && row.target === "U-why-1")?.detail || "";
  assert.match(detail1, /HTTP 400/u, "ต้องเห็นว่าเกตเวย์ปฏิเสธ");
  assert.match(detail1, /1067264/u, "ต้องเห็นขนาดไบต์จริง");
  assert.match(detail1, /ธงเงินถาวร=ปัก/u, "เห็นไบต์แล้ว = ยังเป็นสลิปได้");

  const off = makeApp();
  seed(off.db, "U-why-2", "m-w2");
  await off.app.pipeline.handleEvent(imageEvent("U-why-2", "m-w2"));
  // F6: ห้องที่ยังไม่มีเรื่องเงิน AI คุยต่อ จึงบันทึกเหตุผลในแถว image_review_ai_on แทน
  const detail2 = off.db.listAudit(50).find((row) => ["ai_off_payment_image", "image_review_ai_on"].includes(row.action) && row.target === "U-why-2")?.detail || "";
  assert.match(detail2, /สวิตช์จำแนกรูปปิดอยู่|ไม่ทราบสาเหตุ/u, "สวิตช์ปิดต้องอ่านออกว่าคนละเรื่องกับเกตเวย์ล้ม");
});

test("จำแนกได้ว่าเป็นสลิป/เอกสาร = ปักธงเงินถาวรเหมือนเดิม (นี่คือเงินจริง)", async () => {
  for (const kind of ["slip", "document"]) {
    const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => ({ kind, description: "x" }) } });
    seed(db, `U-flag-${kind}`, `m-flag-${kind}`);
    await app.pipeline.handleEvent(imageEvent(`U-flag-${kind}`, `m-flag-${kind}`));
    const c = db.getCustomer(`U-flag-${kind}`);
    assert.ok(Number(c.money_seen_at) > 0, `${kind} ต้องปักธงเงินถาวร (FU หยุดทวงโอน)`);
    assert.equal(c.ai_enabled, 0);
  }
});

test("จำแนกไม่ได้ แต่ห้องนี้มีเรื่องเงินค้างอยู่แล้ว = ปักธงเงินเหมือนเดิม (ห้ามผ่อนปรนถอยหลัง)", async () => {
  const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => ({ kind: "unknown", reason: "อ่านคำตอบของโมเดลไม่ออก" }) } });
  seed(db, "U-unknown-money", "m-um");
  db.setAiEnabled("U-unknown-money", false, "bank_sent"); // เลขบัญชีออกไปแล้ว = ห้องเงิน
  await app.pipeline.handleEvent(imageEvent("U-unknown-money", "m-um"));
  const c = db.getCustomer("U-unknown-money");
  assert.ok(Number(c.money_seen_at) > 0, "ห้องที่ส่งเลขบัญชีไปแล้ว รูปเข้ามาต้องเป็นเรื่องเงินเสมอ");
});

test("รูปที่จำแนกแล้วว่าไม่ใช่เรื่องเงิน — AI ต้องยังเปิดเหมือนเดิม (อย่ากันเกิน)", async () => {
  const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => ({ kind: "other", description: "โพสต์คลาส" }) } });
  seed(db, "U-open", "m-open");
  await app.pipeline.handleEvent(imageEvent("U-open", "m-open"));
  assert.equal(db.getCustomer("U-open").ai_enabled, 1, "รูปธรรมดาห้ามปิด AI");
});

/* ====== ตรวจปรปักษ์ 2026-09-05: handoff_summary วางยาห้องตัวเอง ====== */
//
// escalate(image_review) เขียนบรรทัด "[ts] image_review: ลูกค้าส่งรูป (อาจเป็นสลิป/เอกสาร)…"
// ลง handoff_summary เสมอ และตัวอ่านเดิมมองทั้งก้อนด้วย isMoneyLineReason ซึ่งจับทั้งคำว่า
// image_review และคำว่า "สลิป" ในสรุป — ผลคือรูปใบแรกที่ "ไม่ปักธงเงิน" ตามเจตนา กลับทำให้
// ห้องนั้นอ่านเป็นห้องเงินทันทีตั้งแต่ข้อความถัดไป การแก้ที่ตัวปักธงอย่างเดียวจึงไม่จบ

test("ตรวจปรปักษ์: ลูกค้าส่งรูปรวดเดียวสองใบ (จำแนกไม่ทัน) ห้องต้องยังไม่ใช่ห้องเงิน", async () => {
  const noFile = { kind: "unknown", reason: "ไม่มีไฟล์รูปให้จำแนกทัน", reasonCode: "no_file" };
  const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => noFile } });
  seed(db, "U-two-shots", "m-shot-1");
  await app.pipeline.handleEvent(imageEvent("U-two-shots", "m-shot-1"));
  assert.equal(Number(db.getCustomer("U-two-shots").money_seen_at || 0), 0, "ใบแรกต้องไม่ปักธง");
  seed(db, "U-two-shots", "m-shot-2");
  await app.pipeline.handleEvent(imageEvent("U-two-shots", "m-shot-2"));
  assert.equal(
    Number(db.getCustomer("U-two-shots").money_seen_at || 0), 0,
    "ใบที่สองอ่าน handoff_summary ของใบแรกแล้วปักธง = วงจรวางยาตัวเอง",
  );
  db.close();
});

// แอดมินกดเปิด AI คืนจากคอนโซล (consoleApi setAiEnabled) และ resolveNeedsHuman ไม่ล้าง
// handoff_summary — มีแต่การลบบทสนทนาทั้งห้องที่ล้าง ถ้าบรรทัด image_review ยังอ่านเป็นเงิน
// ห้องที่ ops เพิ่งเปิดคืนก็ยังโดนแม่แบบเอกสารการชำระเงินปัดเหมือนเดิมทุกครั้ง
test("ตรวจปรปักษ์: เปิด AI คืนแล้ว คำถามเอกสารก่อนซื้อต้องกลับมาคุยได้จริง", async () => {
  const noFile = { kind: "unknown", reason: "ไม่มีไฟล์รูปให้จำแนกทัน", reasonCode: "no_file" };
  const { app, db } = makeApp({ imageClassify: { enabled: true, classify: async () => noFile } });
  seed(db, "U-reopen", "m-reopen");
  await app.pipeline.handleEvent(imageEvent("U-reopen", "m-reopen"));
  db.setAiEnabled("U-reopen", true, "");
  const row = db.getCustomer("U-reopen");
  assert.equal(paymentStartedFromRow(row), false, "รูปที่ยังไม่รู้ว่าอะไร ไม่ใช่หลักฐานว่ามีเงิน");
  const r = routeMessage({
    text: "สอบถามค่ะ ออกใบเสร็จกับใบกำกับภาษี หักภาษีได้นะคะ แล้วถ้าลง 2 ท่าน ส่งคนอื่นไปแทนได้ไหมคะ",
    paymentStarted: paymentStartedFromRow(row),
  });
  assert.equal(r.intent, "document_presale", "ห้องที่เปิดคืนแล้วยังถูกเส้นเงินยึดอยู่");
  db.close();
});

// ตรวจปรปักษ์ 2026-09-05: โมเดลตอบ kind "other" แต่บรรยายว่าเป็นสลิป — ตัวแกะคำตอบเชื่อ kind
// อย่างเดียว รูปนั้นจึงกลายเป็นข้อความ "(ลูกค้าส่งรูปมา: …)" ซึ่ง safetyRouter ปิดด่านคำนาม
// ไว้พอดี = ชั้นกันพลาดหายทั้งชั้น ต้องดักที่ตัวจำแนกก่อนถึงไปป์ไลน์
test("ตรวจปรปักษ์: โมเดลบอก other แต่บรรยายว่าเป็นสลิป = เดินเส้นเงิน ไม่ใช่คุยต่อ", async () => {
  const { app, db } = makeApp({
    imageClassify: {
      enabled: true,
      classify: async () => classifyImage({
        bytes: Buffer.alloc(2048), mime: "image/png", logger: silent,
        callModel: async () => JSON.stringify({ kind: "other", description: "สลิปโอนเงินธนาคารกสิกร" }),
      }),
    },
  });
  seed(db, "U-contradict", "m-contradict");
  const r = await app.pipeline.handleEvent(imageEvent("U-contradict", "m-contradict"));
  assert.equal(r.route, "media_review", "คำบรรยายที่บอกว่าเป็นสลิปต้องชนะ kind");
  const c = db.getCustomer("U-contradict");
  assert.equal(c.state, "NEEDS_HUMAN");
  assert.ok(Number(c.money_seen_at) > 0, "สลิปที่โมเดลติดป้ายผิด ยังต้องเป็นเรื่องเงิน");
  db.close();
});
