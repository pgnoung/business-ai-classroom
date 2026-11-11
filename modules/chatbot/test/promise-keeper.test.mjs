// v1.4.26 "ผู้รักษาสัญญา" — บอทพูดว่าทีมงานจะดูแล = ต้องมีคนจริงรู้เสมอ
//
// ที่มา (วัดจริง 2026-08-19 จาก transcript ชุด eval 2,320 เทิร์น): บอทรับปากว่า
// "จะส่งเรื่องให้ทีมงาน / ทีมงานจะติดต่อกลับ" 147 ครั้ง แต่ 15 ครั้ง (10%) ระบบไม่ได้
// เปิดเคสให้ใครเลย ลูกค้าจึงถูกรับปากแล้วไม่มีใครตามต่อ
//
// เคสจริงที่ล็อกไว้ในไฟล์นี้มาจาก transcript ตรง ๆ ทั้งฝั่งที่ต้องจับและฝั่งที่ต้องปล่อย
// โดยเฉพาะฝั่งปล่อย: ก่อนหน้านี้เคยพยายามแก้ปัญหาเดียวกันด้วยการดัก "คำของลูกค้า"
// แล้วชนประโยคธรรมดา ("ลูกค้าร้านผมไม่อยากคุยกับบอทเลย") จนต้อง revert — รอบนี้จึงดัก
// จาก "คำของบอทเอง" และต้องพิสูจน์ว่าไม่กินคำว่า "ทีม" ที่หมายถึงทีมของลูกค้า
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { looksLikeTeamPromise, looksLikeSelfPromise, PROMISE_NOTE_AUTHOR } from "../src/pipeline.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {} };

function makeApp({ reply } = {}) {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-12900", 12900);
  const hermesFetch = hermesFetchStub(reply);
  const app = createApp({
    config: testConfig(),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  return { app, db, hermesFetch };
}

const promiseNotes = (db, customerId) =>
  db.listHandoffNotes(customerId, 20).filter((note) => note.author === PROMISE_NOTE_AUTHOR);

/* ------------------------- ต้องจับ (คำรับปากจริง) ------------------------- */

const REAL_PROMISES = [
  "ลูกแพรส่งเรื่องให้ทีมงานช่วยพิจารณาสิทธิ์เป็นกรณีพิเศษนะคะ",
  "ลูกแพรจะส่งต่อให้ทีมงานคนจริงเข้ามาดูแลต่อทันทีนะคะ",
  "เรื่องขอคืนเงินต้องให้ทีมงานพิจารณาและยืนยันตามกรณีนะคะ",
  "ทีมงานจะเป็นผู้ยืนยันสิทธิ์ให้ค่ะ",
  "ลูกแพรขอให้ทีมงานยืนยันรายละเอียดหัวข้อนี้อีกครั้งนะคะ",
  "ลูกแพรส่งให้ทีมงานตรวจสอบยอด 12,900 บาทและยืนยันที่นั่งให้นะคะ",
];

for (const line of REAL_PROMISES) {
  test(`promise: จับคำรับปากจริง — "${line.slice(0, 32)}…"`, () => {
    assert.equal(looksLikeTeamPromise(line), true);
  });
}

/* --------------- ต้องปล่อย (ไม่ใช่คำรับปาก — เคยหลอกตัวจับจริง) --------------- */

const NOT_PROMISES = [
  // หัวข้อในลิสต์ขายของ = เนื้อหาคลาส ไม่ใช่คำสัญญา (probe-scope-05 t3 ของจริง)
  "👩‍💼 ออกแบบจังหวะส่งต่อให้ทีมงานดูแลเคสสำคัญ",
  "คลาสสอนออกแบบระบบส่งต่อให้ทีมงานดูแลเคสสำคัญ",
  // "ทีม" เฉย ๆ = ทีมของลูกค้าเอง — กับดักเดิมที่เคยทำให้ปิด AI ผิดเคส
  "ทีมบัญชีของคุณลูกค้าจะตรวจสอบได้เร็วขึ้นค่ะ",
  "AI ช่วยสรุปให้ทีมตรวจสอบได้ค่ะ",
  "ทีมขายของคุณลูกค้าจะติดต่อลูกค้าได้ไวขึ้นมากค่ะ",
  // ตอบปกติที่ไม่ได้รับปากอะไร
  "คลาส AI Agent for Business ราคา 12,900 บาทค่ะ สนใจรอบไหนดีคะ?",
];

for (const line of NOT_PROMISES) {
  test(`promise: ไม่จับสิ่งที่ไม่ใช่คำรับปาก — "${line.slice(0, 32)}…"`, () => {
    assert.equal(looksLikeTeamPromise(line), false);
  });
}

/* ------------------------------ เส้นทางจริง ------------------------------ */

test("promise: บอทรับปากแต่ยังไม่มี handoff -> สร้างโน้ตให้ทีม + AI ยังคุยต่อ", async () => {
  const { app, db } = makeApp({
    reply: "เข้าใจเลยค่ะ ลูกแพรส่งเรื่องให้ทีมงานช่วยพิจารณาสิทธิ์เลื่อนรอบให้นะคะ",
  });
  await app.pipeline.handleInboundText({
    customerId: "U-promise-1",
    text: "พรุ่งนี้เรียนแล้วแต่ผมป่วยหนักมาก ขอเลื่อนอีกรอบได้ปะครับ",
    replyToken: "rt-1",
  });

  const notes = promiseNotes(db, "U-promise-1");
  assert.equal(notes.length, 1, "ต้องมีโน้ตแจ้งทีม 1 ใบ");
  // โน้ตต้อง "ชัดเจน" ตามที่พี่ง้วงสั่ง: บอกทั้งสิ่งที่ลูกค้าถามและสิ่งที่บอทรับปาก
  assert.match(notes[0].text, /ป่วยหนัก/u, "ต้องมีคำถามลูกค้าในโน้ต");
  assert.match(notes[0].text, /ทีมงาน/u, "ต้องมีคำรับปากของบอทในโน้ต");

  // พี่ง้วงเลือกทรง "ไม่ตัดบทลูกค้า" — AI ต้องยังเปิดอยู่
  const customer = db.getCustomer("U-promise-1");
  assert.equal(customer.ai_enabled, 1, "AI ต้องยังคุยต่อได้");
  assert.notEqual(customer.state, "NEEDS_HUMAN");
  db.close();
});

test("promise: มี handoff จริงอยู่แล้ว -> ไม่ต้องสร้างโน้ตซ้ำ (ทีมเห็นอยู่แล้ว)", async () => {
  const { app, db } = makeApp({
    reply: "ได้เลยค่ะ ลูกแพรจะส่งต่อให้ทีมงานคนจริงเข้ามาดูแลต่อในแชทนี้นะคะ",
  });
  // ต้องมีแถวลูกค้าก่อน setNeedsHuman ถึงจะติด (ไม่งั้นเป็น no-op เงียบ ๆ)
  db.upsertCustomer("U-promise-2", {});
  db.setNeedsHuman("U-promise-2", "human_requested", "ลูกค้าขอคุยกับคนจริง");
  await app.pipeline.handleInboundText({
    customerId: "U-promise-2", text: "สอบถามเพิ่มครับ", replyToken: "rt-2",
  });
  assert.equal(promiseNotes(db, "U-promise-2").length, 0);
  db.close();
});

test("promise: รับปากติดกันหลายเทิร์น -> โน้ตใบเดียว (กันสแปมแอดมิน)", async () => {
  const { app, db } = makeApp({
    reply: "ลูกแพรขอให้ทีมงานยืนยันรายละเอียดอีกครั้งนะคะ",
  });
  for (const text of ["สอนอันนี้ด้วยมั้ยครับ", "แล้วอันนั้นล่ะครับ", "อีกเรื่องนึงครับ"]) {
    await app.pipeline.handleInboundText({ customerId: "U-promise-3", text, replyToken: "" });
  }
  assert.equal(promiseNotes(db, "U-promise-3").length, 1, "ภายใน cooldown ต้องมีใบเดียว");
  db.close();
});

test("promise: โน้ตของระบบห้ามวนกลับเข้า prompt เป็น 'บันทึกจากทีมงาน'", async () => {
  const db = memoryDb();
  const hermes = hermesFetchStub("ลูกแพรส่งเรื่องให้ทีมงานช่วยตรวจสอบให้นะคะ");
  const app = createApp({
    config: testConfig(),
    db,
    overrides: { hermesFetch: hermes, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await app.pipeline.handleInboundText({ customerId: "U-promise-4", text: "ขอถามเรื่องคืนเงินครับ", replyToken: "" });
  assert.equal(promiseNotes(db, "U-promise-4").length, 1);

  await app.pipeline.handleInboundText({ customerId: "U-promise-4", text: "แล้วยังไงต่อครับ", replyToken: "" });
  const lastPrompt = JSON.stringify(hermes.calls.at(-1).body);
  assert.doesNotMatch(lastPrompt, /ลูกแพรรับปากลูกค้าว่า/u, "โน้ตใบสั่งงานของทีมห้ามเข้า prompt");
  db.close();
});

/* ---------------- v1.4.30: ป้าย "customer" = ทีมงานรับช่วงคุยเอง ---------------- */
// เฟสขึ้นระบบ (พี่ง้วงกำหนด 2026-08-19): ลูกค้าที่ซื้อแล้วให้ชมพู่คุยเองยาว ๆ
// บอทต้องเงียบสนิท แต่ประวัติแชทต้องไม่ขาดตอน เพื่อเอาไปทำบอทลูกค้าเก่าในเฟสถัดไป

test("ป้าย customer: บอทเงียบสนิท แต่ยังบันทึกข้อความลูกค้าไว้ครบ", async () => {
  const { app, db, hermesFetch } = makeApp({ reply: "สวัสดีค่ะ" });
  db.upsertCustomer("U-tagged", {});
  db.addTag("U-tagged", "customer", "human");

  const result = await app.pipeline.handleInboundText({
    customerId: "U-tagged", text: "พี่คะ ขอถามเรื่องคลาสรอบหน้าหน่อย", replyToken: "rt",
  });

  assert.equal(result.sent, undefined, "บอทต้องไม่ตอบ");
  assert.equal(result.suppressed, "ai_disabled");
  assert.equal(hermesFetch.calls.length, 0, "ต้องไม่ยิงโมเดลเลย — ประหยัดทั้งเงินและโควตา");

  const customer = db.getCustomer("U-tagged");
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, "customer_handover");
  db.close();
});

test("ป้าย customer: ไม่มีป้าย = บอททำงานปกติ (กันปิดบอทผิดคน)", async () => {
  const { app, db, hermesFetch } = makeApp({ reply: "สวัสดีค่ะ ยินดีดูแลนะคะ" });
  db.upsertCustomer("U-plain", {});
  db.addTag("U-plain", "hot", "ai"); // ป้ายอื่นต้องไม่ทำให้บอทเงียบ

  const result = await app.pipeline.handleInboundText({
    customerId: "U-plain", text: "สนใจคลาสค่ะ", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  assert.ok(hermesFetch.calls.length >= 1);
  assert.equal(db.getCustomer("U-plain").ai_enabled, 1);
  db.close();
});

test("ป้าย customer: ปลดป้ายแล้วบอทยังเงียบจนกว่าคนจะเปิด AI เอง", async () => {
  const { app, db } = makeApp({ reply: "สวัสดีค่ะ" });
  db.upsertCustomer("U-untag", {});
  db.addTag("U-untag", "customer", "human");
  await app.pipeline.handleInboundText({ customerId: "U-untag", text: "ทักครั้งแรก", replyToken: "" });
  assert.equal(db.getCustomer("U-untag").ai_enabled, 0);

  // ปลดป้ายไม่ควรปลุกบอทเอง — คนต้องเป็นคนตัดสินใจว่าพร้อมให้บอทคุยต่อแล้วจริง
  db.removeTag("U-untag", "customer");
  const again = await app.pipeline.handleInboundText({ customerId: "U-untag", text: "ทักอีกครั้ง", replyToken: "" });
  assert.equal(again.suppressed, "ai_disabled", "ต้องรอคนกดเปิด AI ในคอนโซลเท่านั้น");
  db.close();
});

/* ===================== v1.4.37: คำสัญญาที่พูดในนามตัวเอง ===================== */
//
// ที่มา (แชทจริง 2026-08-19): ตัวจับด้านบนผูกกับคำว่า "ทีมงาน" จึงมองไม่เห็นประโยคที่
// ลูกแพรรับปากในนามตัวเอง ซึ่งอันตรายกว่า — "ทีมงานจะติดต่อกลับ" อย่างน้อยมีคนอยู่
// ปลายทาง แต่ "ลูกแพรล็อกสิทธิ์ให้แล้ว" ไม่มีทั้งคนและระบบ
// เคสจริง: ลูกค้าให้ชื่อ+เบอร์เพื่อจองรอบ 19 ก.ย. บอทตอบว่าล็อกให้แล้ว -> ไม่มีโน้ต
// ไม่มีแจ้งเตือน ไม่มีระบบล็อกที่นั่งอยู่จริง
//
// ทุกบรรทัดฝั่ง "ต้องจับ" คัดมาจากข้อความที่ลูกแพรส่งออกจริง ไม่ใช่ตัวอย่างที่แต่งขึ้น
// (วัดกับข้อความจริง 1,202 ข้อความ: ยิง 6 = 0.50% ของจริงทั้ง 6 ไม่มียิงผิด)

const REAL_SELF_PROMISES = [
  "ได้ค่ะคุณทดสอบ 😊 ลูกแพรล็อกสิทธิ์โปรโมชั่นรอบวันที่ 22 สิงหาคมไว้ก่อนได้ โดยที่นั่งจริงจะยืนยันตามลำดับการชำระนะคะ",
  "ยินดีค่ะ คุณทดสอบ 😊 ลูกแพรล็อกสิทธิ์ Early Bird รอบวันที่ 19 ก.ย. 2026 ไว้เบื้องต้นแล้วนะคะ หากพร้อมดำเนินการแจ้งได้เลยค่ะ",
  "ได้เลยค่ะ ลูกแพรจองสิทธิ์โปรโมชั่นคลาส AI Agent Workflow Automation ไว้ให้เบื้องต้นนะคะ",
  "ได้ค่ะคุณทดสอบ ลูกแพรจัดทำใบเสนอราคาคลาส AI Agent for Business ให้ได้ค่ะ",
  "ราคานี้เป็นโปรโมชั่นที่จัดให้สูงสุดแล้ว จึงลดเพิ่มไม่ได้ค่ะ แต่ลูกแพรล็อกสิทธิ์ราคานี้ไว้ให้ก่อนได้",
];

for (const line of REAL_SELF_PROMISES) {
  test(`self-promise: จับคำรับปากในนามตัวเอง — "${line.slice(0, 30)}…"`, () => {
    assert.equal(looksLikeSelfPromise(line), true);
  });
}

const NOT_SELF_PROMISES = [
  // คำเสนอ/คำถาม ยังไม่มีใครตกลงอะไร — ถ้าจับ โน้ตจะท่วมจนแอดมินเลิกอ่าน
  "คุณทดสอบให้ลูกแพรล็อกสิทธิ์ Early Bird ไว้ก่อนไหมคะ?",
  "คุณSomsak ต้องการให้ลูกแพรล็อกสิทธิ์โปรโมชั่นรอบ 29 ส.ค. ไว้ก่อนไหมคะ?",
  // ลูกแพรเป็น "ผู้ถูกทัก" ไม่ใช่ผู้ทำ — ประโยคชวนลูกค้าติดต่อ
  "หากสะดวกวันที่ 22 สิงหาคมแล้ว ทักลูกแพรเพื่อดำเนินการจองได้เลยค่ะ",
  // เงื่อนไขนำหน้า = ชวนลูกค้าทำก่อน ยังไม่มีใครรับปากอะไร
  "หากพร้อมสมัคร ส่งวันที่ต้องการเรียนมาได้เลยค่ะ ลูกแพรจะดำเนินการจองที่นั่งให้ค่ะ",
  // ข้อเท็จจริงเรื่องที่นั่ง ไม่ใช่คำรับปากว่าไปล็อกมาแล้ว — ห้ามจับ ไม่งั้นยิงทุกครั้งที่พูดราคา
  "รอบวันที่ 22 ส.ค. เหลือ 5 ที่นั่งค่ะ ที่นั่งยืนยันตามลำดับการชำระนะคะ",
  "คลาส AI Agent for Business ราคา 12,900 บาทค่ะ สนใจรอบไหนดีคะ?",
];

for (const line of NOT_SELF_PROMISES) {
  test(`self-promise: ไม่จับสิ่งที่ไม่ใช่คำรับปาก — "${line.slice(0, 30)}…"`, () => {
    assert.equal(looksLikeSelfPromise(line), false);
  });
}

// ทั้งสองตัวจับต้องไม่ทับกัน — คนละสาเหตุ คนละข้อความแจ้งเตือน
test("self-promise: ตัวจับทีมงานกับตัวจับตัวเอง แยกกันจริง", () => {
  assert.equal(looksLikeTeamPromise("ลูกแพรล็อกสิทธิ์รอบ 22 ส.ค. ไว้ให้แล้วนะคะ"), false);
  assert.equal(looksLikeSelfPromise("ลูกแพรส่งเรื่องให้ทีมงานช่วยพิจารณานะคะ"), false);
});

// 2026-09-05 (คำสั่งพี่ง้วง): ข้อความขาเข้าของเคสจริงเดิม ("ทดสอบ 0812345678
// จองรอบ 19 ก.ย. ค่ะ") ตอนนี้ถูกอ่านเป็น "ลูกค้าจองแล้ว" — ห้องนั้นจึงถูกส่งต่อชมพู่
// และปิด AI ถาวรก่อนถึงบล็อกคำรับปาก ซึ่งเป็นผลลัพธ์ที่ดีกว่าโน้ตใบเดียว
// (เส้นนั้นถูกล็อกไว้ใน test/booking-handoff.test.mjs แล้ว)
// เทสต์นี้จึงเปลี่ยนข้อความขาเข้าเป็นการ "ถามรายละเอียดรอบ" ซึ่งยังไม่ใช่การตัดสินใจ
// เพื่อให้ยังพิสูจน์สิ่งที่มันถูกเขียนมาเพื่อพิสูจน์: คำรับปากในนามตัวเองของลูกแพร
// ต้องมีใบสั่งงานถึงคนจริงเสมอ แม้ลูกค้าจะยังไม่ได้จอง
test("self-promise: บอทบอกว่าล็อกที่นั่งให้แล้ว -> ต้องมีโน้ตถึงคนจริง", async () => {
  const { app, db } = makeApp({
    reply: "ได้ค่ะ 😊 ลูกแพรล็อกสิทธิ์ Early Bird รอบวันเสาร์ที่ 19 ก.ย. 2026 ไว้ให้แล้วนะคะ",
  });
  const customerId = "U-self-promise-01";
  db.upsertCustomer(customerId, { displayName: "ผู้ทดสอบ" });
  await app.pipeline.handleInboundText({ customerId, text: "ขอรายละเอียดรอบ 19 ก.ย. หน่อยค่ะ" });
  const notes = promiseNotes(db, customerId);
  assert.equal(notes.length, 1, "ต้องมีใบสั่งงานถึงคนจริงพอดี 1 ใบ");
  assert.ok(notes[0].text.includes("ระบบไม่มีการล็อกที่นั่ง"), "โน้ตต้องบอกว่าไม่มีระบบรองรับ");
  assert.equal(db.getCustomer(customerId).ai_enabled, 1, "AI ต้องยังคุยต่อ ไม่ตัดบทลูกค้า");
});
