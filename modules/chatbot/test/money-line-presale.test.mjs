// เส้นเงินปัดลูกค้าที่ยังไม่ได้จ่าย — เคสจริงที่พี่ง้วงแจ้งเอง เย็น 2026-09-05
//
// อาการที่เจ้าของเห็นในห้องจริง: "หลายแชท มีทั้งหยุดแชท และลูกค้าพิมพ์เรื่องการจัดการสลิป
// หรือใด ๆ แต่ลูกแพรปัดเป็น เช็คสลิปสักครู่ ทำให้เสียหาย"
//
// สองรากที่ไล่เจอในวันนั้น:
//   1) deal_status อะไรก็ได้ที่ไม่ใช่ "new" ถูกอ่านว่า "จ่ายเงินกันแล้ว" — ห้องที่แค่ส่งราคา
//      ให้ดู (price_sent) จึงถูกปฏิบัติเหมือนลูกค้าที่โอนเงินมาแล้ว
//   2) คำนามเงินโดด ๆ ในห้องที่ไม่เคยมีเงินเลย ยังยิงแม่แบบ "รับเรื่องเอกสารการชำระเงินแล้วค่ะ"
//
// ทิศทางความเสียหายของสองฝั่งไม่เท่ากัน และไฟล์นี้ล็อกไว้ทั้งสองฝั่ง:
//   พลาดจับเงินจริง -> บอทยืนยันยอดเอง เงินผิดกู้ไม่ได้   (ต้องไม่หลุดแม้แต่เคสเดียว)
//   จับเกิน         -> ลีดที่กำลังจะซื้อตายเงียบ           (คือความเสียหายที่เจ้าของแจ้ง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { baseRules, paymentStartedFromRow, PAYMENT_STARTED_DEAL_STATUSES, DOC_PRESALE_NOTE_PREFIX } from "../src/pipeline.mjs";
import { routeMessage, PAYMENT_DOC_TEMPLATE } from "../src/safetyRouter.mjs";
import { DEAL_STATUSES } from "../src/dbLifecycle.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

/* ------------------------- F2: deal_status = เงินขยับจริงไหม ------------------------- */

// ตารางเต็มของ deal_status ที่มีอยู่จริง (dbLifecycle.DEAL_STATUSES) — ไม่ใช่แค่ตัวที่นึกออก
// เพราะบั๊กเดิมเกิดจากการเขียนเงื่อนไขแบบ "ไม่ใช่ new = จ่ายแล้ว" ซึ่งกวาดทุกตัวที่เพิ่มมาทีหลัง
test("F2: มีแค่สถานะที่เงินขยับจริง/ส่งเลขบัญชีแล้วเท่านั้นที่นับว่าเริ่มจ่าย", () => {
  const started = new Set(["awaiting_payment", "paid_confirmed", "prep_sent"]);
  assert.deepEqual([...PAYMENT_STARTED_DEAL_STATUSES].sort(), [...started].sort());
  for (const status of DEAL_STATUSES) {
    assert.equal(
      paymentStartedFromRow({ deal_status: status }),
      started.has(status),
      `deal_status "${status}" ตัดสินผิดข้าง`,
    );
  }
  // สถานะก่อนเงินที่พังจริงในโปรดักชัน — ล็อกไว้ด้วยชื่อ เผื่อมีคนกลับไปเขียน !== "new" อีก
  for (const status of ["new", "collecting_info", "class_recommended", "details_sent", "price_sent", "quote_sent"]) {
    assert.equal(paymentStartedFromRow({ deal_status: status }), false, `"${status}" ไม่ใช่เรื่องเงิน`);
  }
});

test("F2: สัญญาณเงินตัวจริงยังตัดสินว่า 'จ่ายแล้ว' เหมือนเดิมทุกตัว", () => {
  assert.equal(paymentStartedFromRow(null), true, "ไม่มีแถว = fail-closed ทางเงิน");
  assert.equal(paymentStartedFromRow({ money_seen_at: 1 }), true);
  assert.equal(paymentStartedFromRow({ ai_off_reason: "bank_sent" }), true);
  // หมายเหตุ: ai_off_reason "money_line" เพียว ๆ ไม่นับ (isMoneyLineReason ไม่มีคำนี้ในรายการ)
  // และต้องเป็นแบบนั้นต่อไป — เส้นรูปที่จำแนกไม่ได้ปิด AI ด้วยเหตุนี้โดยไม่ปักธงเงิน (F4)
  // ถ้าเปลี่ยนให้มันนับ ห้องที่โดนปิดเพราะรูปมั่ว ๆ จะกลายเป็นห้องเงินทันทีเหมือนเดิม
  assert.equal(paymentStartedFromRow({ ai_off_reason: "money_line" }), false);
  assert.equal(paymentStartedFromRow({ ai_off_reason: "payment_requires_human_review" }), true, "ชื่อเหตุตั้งเองได้ต่อ instance");
  assert.equal(paymentStartedFromRow({ handoff_summary: "[x] payment_review: รอตรวจยอด" }), true);
  assert.equal(paymentStartedFromRow({ handoff_summary: "[x] bank_sent" }), true);
  assert.equal(paymentStartedFromRow({}), false, "แถวเปล่า = ยังไม่เคยมีเงิน");
  assert.equal(paymentStartedFromRow({ deal_status: "price_sent", money_seen_at: 0, handoff_summary: "" }), false);
});

/* ------------------- F3: คำถามเอกสารก่อนซื้อ ต้องได้คำตอบ ไม่ใช่แม่แบบ ------------------- */

// พาราเฟรสจากสองข้อความจริงที่โดนปัดในวันเดียวกัน (ไม่คัดลอกคำต่อคำ)
const REAL_PRESALE_TEXTS = [
  // (ก) ห้อง price_sent — คำถามปิดการขายแท้ ๆ เรื่องเอกสาร + เงื่อนไขที่นั่ง
  "สอบถามค่ะ ออกใบเสร็จกับใบกำกับภาษี หักภาษีได้นะคะ แล้วถ้าลง 2 ท่าน วันจริงอีกท่านติดธุระ ส่งคนอื่นไปแทนได้ไหมคะ",
  // (ข) ห้อง deal=new — ลูกค้าไล่รายการงานที่อยากให้ AI ทำให้
  "สรุปเอกสาร รัน ใบเสร็จ วิเคราะห์ข้อมูล",
];

test("F3: ข้อความจริงทั้งสองที่โดนปัดวันนั้น ต้องได้คุยต่อ ไม่ใช่แม่แบบเอกสารการชำระเงิน", () => {
  for (const text of REAL_PRESALE_TEXTS) {
    const r = routeMessage({ text, paymentStarted: false });
    assert.equal(r.route, "ai", `ยังถูกเส้นเงินยึด: ${text}`);
    assert.equal(r.template, null, "ห้ามยิงแม่แบบ");
    assert.equal(r.escalate, null, "ห้ามปักธงรอคน");
  }
});

test("F3: ห้องที่จ่ายเงินแล้ว ข้อความเดียวกันยังต้องถึงคนจริงเหมือนเดิม", () => {
  for (const text of REAL_PRESALE_TEXTS) {
    const r = routeMessage({ text, paymentStarted: true });
    assert.equal(r.route, "payment", `เงินหลุด: ${text}`);
    assert.equal(r.template, PAYMENT_DOC_TEMPLATE);
  }
});

test("F3: การแจ้งจ่ายเงินจริงไม่เปลี่ยนเลย ไม่ว่าห้องจะเคยมีเงินหรือไม่", () => {
  const declarations = ["โอนแล้วนะครับ", "ส่งสลิปให้แล้วค่ะ", "แจ้งโอนครับ", "ยอดเข้ารึยังคะ", "สลิปนี้ครับ"];
  for (const text of declarations) {
    for (const paymentStarted of [true, false]) {
      const r = routeMessage({ text, paymentStarted });
      assert.equal(r.route, "payment", `เงินหลุด (paymentStarted=${paymentStarted}): ${text}`);
      assert.equal(r.escalate.reason, "payment_review");
    }
  }
});

// ด่านนี้เป็น allowlist โดยตั้งใจ — "ไม่ติดรายการยกเว้น" ต้องไม่แปลว่าปล่อยผ่าน
// (บทเรียน audit 2026-08-24: ตอนกลับขั้วเป็น denylist คำที่นึกไม่ถึงทุกคำกลายเป็นเงินหลุด)
test("F3: คำนามเอกสารเปล่า ๆ ที่ไม่มีสัญญาณก่อนซื้อ ยังเดินเส้นเงินเหมือนเดิม", () => {
  for (const text of ["ออกใบกำกับครับ", "บริษัทครับ ออกใบกำกับในนามบริษัท", "ใบเสร็จครับ", "ไบเสดครับ"]) {
    assert.equal(routeMessage({ text, paymentStarted: false }).route, "payment", `ผ่อนปรนเกิน: ${text}`);
  }
});

// ประโยคที่มี "สัญญาณก่อนซื้อ" ครบ แต่พ่วงร่องรอยเงินมาด้วย — ด่านใหม่ต้องไม่แตะเลย
// (สลิป/หลักฐานโอน = คำหลังจ่ายเสมอ · คำทวงเอกสาร · การประกาศว่าจ่ายไปแล้ว)
test("F3: สัญญาณเงินพ่วงมาเมื่อไหร่ ด่านเอกสารก่อนซื้อต้องไม่รับเคสนั้นเด็ดขาด", () => {
  const money = [
    "สอบถามค่ะ สลิปที่ส่งไป ตรวจแล้วยังคะ",
    "สอบถามค่ะ ขอใบกำกับภาษีด้วยนะคะ",
    "สอบถามครับ ใบเสร็จที่โอนไปเมื่อวาน ได้เมื่อไหร่ครับ",
    "สอบถามค่ะ ใบกำกับยังไม่ได้เลยนะคะ ลง 2 ท่าน",
    "สอบถามครับ ราคาที่ชำระไปแล้ว ขอใบเสร็จด้วยครับ",
  ];
  for (const text of money) {
    const r = routeMessage({ text, paymentStarted: false });
    assert.notEqual(r.intent, "document_presale", `ด่านเอกสารก่อนซื้อรับเคสเงินไปแล้ว: ${text}`);
    assert.equal(r.route, "payment", `เงินหลุด: ${text}`);
  }
});

// เส้นทางรูป: ไปป์ไลน์เขียนข้อความสังเคราะห์ "(ลูกค้าส่งรูปมา: …)" เอง คำอธิบายในนั้นเป็นคำของ
// ตัวจำแนก ไม่ใช่คำลูกค้า — ถ้ามันลากเข้าเส้นเงินได้ รูปที่จำแนกแล้วว่า "ไม่ใช่เงิน" จะวนกลับ
test("F3: คำอธิบายรูปที่ระบบเขียนเอง ต้องไม่ถูกอ่านเป็นคำนามเงิน", () => {
  for (const text of [
    "(ลูกค้าส่งรูปมา: ภาพหน้าจอที่ไม่ใช่สลิป)",
    "(ลูกค้าส่งรูปมา: โพสต์โฆษณาที่มีคำว่าใบเสร็จอยู่ในภาพ)",
  ]) {
    for (const paymentStarted of [true, false]) {
      assert.equal(routeMessage({ text, paymentStarted }).route, "ai", text);
    }
  }
});

test("F3: สติกเกอร์/ปุ่มไลก์ (msgType ที่ไม่ใช่ text/image) คืน route ignore ไม่แตะเส้นเงิน", () => {
  const r = routeMessage({ text: "[sticker]", msgType: "sticker" });
  assert.equal(r.route, "ignore");
  assert.equal(r.intent, "unsupported_media");
  assert.equal(r.escalate, null);
  assert.equal(r.template, null);
});

test("F3: พรอมต์ของเทิร์นเอกสารก่อนซื้อ ต้องสั่งให้ตอบได้ แต่ห้ามยืนยันยอด/ห้ามรับปากว่าออกให้แล้ว", () => {
  const rules = baseRules("document_presale", []);
  assert.match(rules, /ห้ามยืนยันยอดเงิน/u);
  assert.match(rules, /ห้ามบอกว่าออกเอกสารให้แล้ว/u);
  assert.match(rules, /ทีมงานจะดูแลเรื่องเอกสารให้ตอนสมัคร/u);
  assert.doesNotMatch(baseRules("general", []), /ห้ามบอกว่าออกเอกสารให้แล้ว/u, "เทิร์นอื่นห้ามแบกกฎนี้ไปด้วย");
});

// ตรวจปรปักษ์ 2026-09-05: ถ้อยคำรุ่นแรกประกาศแทนลูกค้าว่า "ยังไม่มีการชำระเงินกับเรา"
// ห้องที่ได้เลขบัญชีจากริชเมนู/โพสต์/แอดมินพิมพ์เอง แล้วโอนจริง ก็ยังอ่านว่าไม่มีเงิน
// -> โมเดลจะไปบอกคนที่เพิ่งโอนว่ายังไม่ได้จ่าย ซึ่งแย่กว่าเงียบ
test("F3: พรอมต์ต้องพูดแค่ว่า 'ระบบยังไม่พบรายการ' ห้ามฟันธงแทนลูกค้าว่ายังไม่ได้จ่าย", () => {
  const rules = baseRules("document_presale", []);
  assert.match(rules, /ระบบยังไม่พบรายการชำระเงินในห้องนี้/u);
  assert.doesNotMatch(rules, /ยังไม่มีการชำระเงินกับเรา/u, "ห้ามประกาศข้อเท็จจริงเรื่องเงินแทนลูกค้า");
  assert.match(rules, /ห้ามยืนยันและห้ามปฏิเสธว่าเงินเข้าแล้วหรือยัง/u);
  assert.match(rules, /ส่งต่อทีมงานตรวจสอบ/u, "ถ้าลูกค้าบอกว่าโอนแล้ว ต้องมีทางออกที่ไม่ใช่การเถียง");
});

/* ------------------- F3 ระดับไปป์ไลน์: ตอบจริง ไม่ปิดห้อง แต่ทีมต้องเห็น ------------------- */

function makeApp() {
  const config = testConfig();
  const db = memoryDb();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub("ออกใบกำกับภาษีให้ได้ค่ะ ทีมงานจะดูแลตอนสมัครนะคะ"), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  return { app, db };
}

test("F3: ห้องที่แค่ส่งราคาไปให้ดู ถามเรื่องเอกสาร -> ตอบจริง AI ยังเปิด ไม่ปักธงรอคน", async () => {
  const { app, db } = makeApp();
  db.upsertCustomer("U-presale", {});
  db.applyLifecycleTransition({ customerId: "U-presale", toStatus: "price_sent", trigger: "test", actor: "system" });
  const r = await app.pipeline.handleInboundText({ customerId: "U-presale", text: REAL_PRESALE_TEXTS[0], replyToken: "rt" });
  assert.equal(r.sent, true, "ลูกค้าต้องได้คำตอบ ไม่ใช่ความเงียบ");
  assert.notEqual(r.deterministic, true, "ห้ามเป็นแม่แบบสำเร็จรูป");
  const c = db.getCustomer("U-presale");
  assert.notEqual(c.state, "NEEDS_HUMAN", "ห้ามปักธงรอคน");
  assert.equal(c.ai_enabled, 1, "ห้ามปิด AI");
  assert.equal(Number(c.money_seen_at || 0), 0, "ห้ามประทับตราว่าเป็นห้องเงิน");
  db.close();
});

test("F3: ทีมงานต้องเห็นว่าห้องนี้ถามเรื่องเอกสาร — โน้ต ai_auto หนึ่งใบ ไม่ยิงซ้ำทุกเทิร์น", async () => {
  const { app, db } = makeApp();
  db.upsertCustomer("U-note", {});
  await app.pipeline.handleInboundText({ customerId: "U-note", text: REAL_PRESALE_TEXTS[0], replyToken: "rt-1" });
  await app.pipeline.handleInboundText({ customerId: "U-note", text: REAL_PRESALE_TEXTS[1], replyToken: "rt-2" });
  const notes = db.listHandoffNotes("U-note", 20)
    .filter((note) => String(note.text || "").startsWith(DOC_PRESALE_NOTE_PREFIX));
  assert.equal(notes.length, 1, "คูลดาวน์ต้องกันโน้ตซ้ำ ไม่งั้น handoff_summary ของจริงถูกดันตกขอบ");
  assert.equal(notes[0].author, "ai_auto");
  assert.match(notes[0].text, /ระบบยังไม่พบรายการชำระเงิน/u);
  db.close();
});

test("F3: โน้ตเรื่องเอกสารต้องไม่วนกลับเข้าพรอมต์ในฐานะ 'บันทึกจากทีมงาน'", () => {
  const notes = [{ author: "ai_auto", text: `${DOC_PRESALE_NOTE_PREFIX} (ระบบยังไม่พบรายการชำระเงินในห้องนี้) — ลูกค้าถามว่า: "..."` }];
  const rules = baseRules("document_presale", [], { handoffNotes: notes });
  assert.doesNotMatch(rules, /บันทึกจากทีมงาน/u, "คำของระบบเองห้ามกลายเป็นคำของทีมงานในพรอมต์");
});

/* ============ ตรวจปรปักษ์ 2026-09-05: รูรั่วของ allowlist รุ่นแรก ============ */
//
// รอบตรวจแพตช์เดียวกันในเย็นวันนั้นจับได้ว่า allowlist เอกสารก่อนซื้อ "ดีกว่าเดิม" ในเคสที่
// ตั้งใจไว้ แต่ "แย่กว่าโปรดักชัน" ในเคสที่นึกไม่ถึง — เพราะข้อ 2 ของ allowlist พึ่ง
// แพตเทิร์นเจตนา (PAYMENT_ACTION_PATTERNS / PAST_PAYMENT_DECLARATION) ซึ่งไม่รู้จักช่องทาง
// จ่ายเงินทุกแบบ ทุกคำที่มันจับไม่ได้จึงกลายเป็น "ให้บอทตอบ" แทนที่จะตกกลับเส้นเดิม
//
// ห้องแบบนี้มีจริงและ paymentStarted ยังเป็น false: ลูกค้าได้เลขบัญชีจากริชเมนู LINE
// โพสต์เฟซบุ๊ก หรือแอดมินพิมพ์ให้เองในคอนโซล — ตัวจับ bank_sent อ่านเฉพาะบับเบิลของบอท

test("ตรวจปรปักษ์: ประกาศว่าจ่ายมาแล้วทุกช่องทาง ต้องไปหาคนเสมอ แม้ห้องยังไม่มีสัญญาณเงิน", () => {
  const paid = [
    "สแกนจ่ายผ่านแอปธนาคารเมื่อกี้ค่ะ ใบเสร็จออกในนามบริษัทได้นะคะ",
    "โอนเข้าบัญชีกสิกรตามที่พี่ให้มาแล้ว ใบเสร็จออกในนามบริษัทได้นะคะ",
    "ชำระผ่านพร้อมเพย์ 5,900 บาท ใบเสร็จออกในนามบริษัทได้นะคะ",
    "ยอด 5,900 ใบกำกับภาษีในนามบริษัทได้นะคะ",
    "สมัครไปแล้วค่ะ ใบเสร็จออกในนามบริษัทได้นะคะ",
  ];
  for (const text of paid) {
    const r = routeMessage({ text, paymentStarted: false });
    assert.equal(r.route, "payment", `คนเพิ่งจ่ายแล้วโดนบอทตอบเอง: ${text}`);
    assert.equal(r.template, PAYMENT_DOC_TEMPLATE);
    assert.notEqual(r.intent, "document_presale");
  }
});

// กฎ Fern ข้อแรก: บอทห้ามตอบว่าเงินเข้าหรือยัง ไม่ว่าคำถามจะมาในรูปไหน
test("ตรวจปรปักษ์: 'เงินเข้าแล้วใช่ไหม' ที่พ่วงคำนามเอกสาร ต้องไม่หลุดไปให้บอทตอบ", () => {
  for (const text of [
    "เงินเข้าแล้วใช่ไหมคะ ใบกำกับภาษีในนามบริษัทได้นะคะ",
    "ยอดเข้าแล้วใช่ไหมครับ",
    "เงินเข้ายังคะ",
  ]) {
    for (const paymentStarted of [true, false]) {
      const r = routeMessage({ text, paymentStarted });
      assert.equal(r.route, "payment", `บอทได้สิทธิ์ตอบเรื่องยอด: ${text} (paymentStarted=${paymentStarted})`);
      assert.equal(r.escalate.reason, "payment_review");
    }
  }
});

// ลูกค้าที่ "สมัคร/ลงทะเบียนแล้ว" คือคนที่จ่ายนอกสายตาบอทได้ (เงินสดหน้างาน สลิปช่องทางอื่น
// แอดมินปิดดีลเอง) — คำขอใบเสร็จของเขาคือเอกสารจริงที่คนต้องออก ห้ามหล่นออกจากคิวคน
test("ตรวจปรปักษ์: ขอใบเสร็จหลังสมัคร/ลงทะเบียนแล้ว ต้องอยู่ในคิวคนเหมือนโปรดักชันเดิม", () => {
  for (const text of [
    "สมัครไปแล้ว ใบเสร็จ",
    "ลงทะเบียนแล้ว ใบเสร็จออกในนามบริษัทได้ไหม",
    "จองไปแล้วค่ะ ใบกำกับภาษีออกในนามบริษัทได้ไหมคะ",
  ]) {
    const r = routeMessage({ text, paymentStarted: false });
    assert.equal(r.route, "payment", `คำขอเอกสารของคนที่สมัครแล้วหายจากคิวคน: ${text}`);
  }
});

// ด่านใหม่ต้องไม่กินเคสที่แพตช์นี้เกิดมาเพื่อแก้ — สองข้อความจริงยังต้องได้คุยต่อ
test("ตรวจปรปักษ์: ด่านปฏิเสธใหม่ต้องไม่กลืนสองข้อความจริงที่โดนปัดวันนั้น", () => {
  for (const text of REAL_PRESALE_TEXTS) {
    assert.equal(routeMessage({ text, paymentStarted: false }).intent, "document_presale", text);
  }
});
