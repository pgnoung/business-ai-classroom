// F8 (ตรวจย้อนหลัง ก.ย. 2026): push จากคำรับปาก "ทีมงานจะ…" ปลุกคนเฉพาะเมื่อมีงานที่คนต้องทำจริง
//
// ของจริง: 28 จาก 65 push เป็นเสียงรบกวน — บอทไม่รู้คำตอบเรื่องความรู้ (Telegram, Gemini, e-book)
// แล้วพูดว่า "ขอให้ทีมงานยืนยันรายละเอียด" ระบบ push ทุกครั้งจนทีมชินกับเสียงเตือน
// ประตูใหม่: โน้ตยังเขียนทุกครั้ง (คิวคำสัญญาค้างในคอนโซลยังเห็น) แต่ push เฉพาะเมื่อ
//   (ก) ฝั่งลูกค้าขอ/ให้สิ่งที่คนต้องทำ (เบอร์ ลิงก์ ใบเสนอราคา สิทธิ์เข้าเรียน นัดคุย โอน ฯลฯ) หรือ
//   (ข) ประโยครับปากของบอทมีเบอร์/เวลานัด (ลูกค้าตอบเวลาสั้น ๆ อย่าง "18:00")
// ข้อความในไฟล์นี้เป็นประโยคสังเคราะห์ทั้งหมด
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { PROMISE_NOTE_AUTHOR } from "../src/pipeline.mjs";
import { customerOwesHumanAction, promiseIsScheduled, promiseNeedsPush } from "../src/promisePushGate.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function makeApp(reply) {
  const db = memoryDb();
  const notices = [];
  const app = createApp({
    db, logger: silent, config: testConfig(),
    overrides: { notifier: { fireLater: (n) => notices.push(n) }, hermesFetch: hermesFetchStub(reply), lineFetch: lineFetchStub(), sleep: async () => {} },
  });
  return { app, db, notices };
}

test("F8: คำถามความรู้ที่บอทตอบไม่ได้ -> โน้ตอย่างเดียว ไม่ปลุกทีม", async (t) => {
  const { app, db, notices } = makeApp("สำหรับ Telegram ลูกแพรขอให้ทีมงานยืนยันรายละเอียดอีกครั้งนะคะ");
  t.after(() => db.close());
  const customerId = "U-promise-knowledge";
  db.upsertCustomer(customerId, {});
  const result = await app.pipeline.handleInboundText({ customerId, text: "เชื่อม Telegram ได้ไหม", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.ok(db.listHandoffNotes(customerId, 10).some((n) => n.author === PROMISE_NOTE_AUTHOR), "โน้ตยังต้องมี");
  assert.equal(notices.filter((n) => n.reason === "promise_team_followup").length, 0);
  assert.ok(db.listAudit().some((a) => a.action === "promise_team_note" && a.target === customerId));
  assert.equal(db.getCustomer(customerId).ai_enabled, 1);
});

test("F8: ลูกค้าทิ้งเบอร์ขอนัดโทร + บอทรับปากพร้อมเวลา -> ปลุกทีมหนึ่งครั้ง", async (t) => {
  const { app, db, notices } = makeApp("ทีมงานจะติดต่อกลับที่เบอร์ 081-234-5678 พรุ่งนี้ 14:00 นะคะ");
  t.after(() => db.close());
  const customerId = "U-promise-callback";
  db.upsertCustomer(customerId, {});
  await app.pipeline.handleInboundText({ customerId, text: "081-234-5678 โทรพรุ่งนี้ได้ไหม", replyToken: "rt" });
  assert.equal(notices.filter((n) => n.reason === "promise_team_followup").length, 1);
  assert.ok(db.listAudit().some((a) => a.action === "promise_team_followup" && a.target === customerId));
});

test("F8: ลูกค้าตอบแค่เวลา แต่บอทรับปากนัดพร้อมเวลา -> ยังปลุกทีม (นัดโทรที่ต้องมีคนทำ)", () => {
  assert.equal(promiseNeedsPush({
    customerTexts: ["18:00"],
    promiseLine: "ทีมงานจะโทรหาคุณลูกค้าตอน 18:00 นะคะ",
  }), true);
});

test("F8: สัญญาณฝั่งลูกค้า — จับของที่คนต้องทำ ไม่กินคำที่มีตัวอักษรซ้อน", () => {
  for (const text of [
    "ขอลิงก์เข้าเรียนด้วยค่ะ", "0812345678", "สะดวกคุยพรุ่งนี้บ่าย", "ขอใบเสนอราคาหน่อยครับ",
    "โอนแล้วนะคะ", "เข้าไม่ได้ค่ะ กดลิงก์แล้วขึ้น error", "อยากคุยกับแอดมิน",
    "ขอไลน์ทีมงานหน่อยค่ะ", "แอดไลน์ไปแล้วนะคะ", "มีไลน์ไหมคะ",
  ]) assert.equal(customerOwesHumanAction([text]), true, text);
  for (const text of [
    "เชื่อม Telegram ได้ไหม", "ใช้ Gemini ได้ไหมคะ", "ผมไม่ถนัดพิมพ์ยาว ๆ",
    "เรียนออนไลน์ได้ไหมคะ", "มี e-book แจกไหมครับ",
    // ธุรกิจนี้สอนเรื่อง LINE — "ไลน์" ที่เป็นหัวข้อความรู้/พิมพ์ผิดจาก "ออนไลน์" ไม่ใช่การขอช่องทางติดต่อ
    "ไลน์วูมปิดแล้วโพสต์เก่าจะหายไหมคะ", "สอนทำไลน์ OA ไหมคะ", "เรียนอินไลน์ได้ไหมคะ",
  ]) assert.equal(customerOwesHumanAction([text]), false, text);
});

test("F8: สัญญาณฝั่งบอท — เบอร์/เวลานัดในประโยครับปาก", () => {
  assert.equal(promiseIsScheduled("ทีมงานจะติดต่อกลับที่เบอร์ 081-234-5678 ค่ะ"), true);
  assert.equal(promiseIsScheduled("ทีมงานจะโทรหาช่วง 15.30 นะคะ"), true);
  assert.equal(promiseIsScheduled("ทีมงานจะติดต่อกลับพรุ่งนี้ช่วงบ่ายนะคะ"), true);
  assert.equal(promiseIsScheduled("ทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้นะคะ"), true, "รับปากว่าจะติดต่อกลับ = มีคนต้องทำแม้ไม่มีเวลา");
  assert.equal(promiseIsScheduled("ขอให้ทีมงานยืนยันรายละเอียดอีกครั้งนะคะ"), false);
  assert.equal(promiseIsScheduled("คลาสราคา 12,900 บาท ทีมงานจะยืนยันให้ค่ะ"), false, "ราคาไม่ใช่เวลานัด");
  assert.equal(promiseIsScheduled("รอบถัดไปเรียน 10:00–16:00 น. ทีมงานจะยืนยันที่นั่งตามลำดับการชำระค่ะ"), false,
    "เวลาเรียนของรอบไม่ใช่นัดติดต่อ — ต้องมีกริยาติดต่อ/โทร/นัดคู่กับเวลา");
});

test("F8: คำสัญญาในนามตัวเอง (ล็อกที่นั่ง) ยังปลุกทีมทุกครั้ง — ระบบไม่มีตัวทำให้", async (t) => {
  const { app, db, notices } = makeApp("ลูกแพรล็อกที่นั่งรอบ 26 ให้แล้วนะคะ");
  t.after(() => db.close());
  const customerId = "U-self-promise";
  db.upsertCustomer(customerId, {});
  await app.pipeline.handleInboundText({ customerId, text: "เอารอบ 26 ค่ะ", replyToken: "rt" });
  assert.equal(notices.filter((n) => n.reason === "promise_self_action").length, 1);
});
