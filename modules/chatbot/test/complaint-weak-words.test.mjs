// F1 (ตรวจย้อนหลัง ก.ย. 2026 — D799, D952): คำร้องเรียน "อ่อน" (หลอก/โดนโกง/เสียความรู้สึก)
// ต้องมีเป้าเป็นเราก่อนจึงจะนับเป็นข้อร้องเรียน
//
// ของจริง: ผู้เสียหายจากมิจฉาชีพสองคนมาขอคำปรึกษา คนหนึ่งพิมพ์ว่ากลัวจะถูกหลอกอีก อีกคน
// ขอบคุณบอทที่ช่วยให้สแกมหลอกไม่ได้แล้ว — ทั้งคู่โดนแม่แบบ "ต้องขออภัยอย่างยิ่ง…" + ปิด AI ถาวร
// + push + ทวง SLA ทั้งที่ไม่ได้บ่นเราเลย (ทั้งเดือนไม่มีข้อร้องเรียนจริงสักเคส)
// ข้อความในไฟล์นี้เป็นประโยคสังเคราะห์ทั้งหมด ไม่มีข้อความลูกค้าจริง
import test from "node:test";
import assert from "node:assert/strict";
import { routeMessage } from "../src/safetyRouter.mjs";
import { createApp } from "../src/server.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

for (const text of [
  "หนูกลัวว่าจะถูกหลอกค่ะ โดนมา 2 ครั้งแล้ว ไม่กล้ากดอะไรเลย",
  "ขอบคุณที่เป็นห่วงนะคะ เดี๋ยวนี้พวกสแกมหลอกป้าไม่ได้แล้ว",
  "มีคนแปลกหน้าทักมาชวนลงทุน เป็นเรื่องจริงหรือเรื่องหลอกคะ",
  "เพื่อนโดนโกงจากแอปกู้เงิน อยากให้ AI ช่วยเตือนคนในกลุ่ม",
  "โดนแก๊งคอลเซ็นเตอร์หลอก เลยไปแจ้งความมาแล้วค่ะ",
  "ผมโดนหลอกมาครับ ช่วยดูหน่อยว่าข้อความแบบนี้ใช่มิจฉาชีพไหม",
  "เสียความรู้สึกกับเพื่อนร่วมงานมากค่ะ เลยอยากหาอะไรใหม่ ๆ เรียน",
]) {
  test(`weak complaint word inside a third-party scam story stays AI — ${text.slice(0, 30)}`, () => {
    const route = routeMessage({ text });
    assert.equal(route.route, "ai");
    assert.equal(route.escalate, null);
  });
}

for (const text of [
  "โดนหลอกจากพี่ง้วงหรือเปล่าครับ จ่ายเงินแล้วไม่ได้ลิงก์เข้าเรียน",
  "ทางร้านหลอกให้โอนก่อนแล้วเงียบ ขอเงินคืน",
  "คลาสนี้โกงเงินชัด ๆ จะไปแจ้งความ",
  "เสียความรู้สึกมากกับแอดมินที่นี่",
  // เดิมอยู่ในชุดทดสอบ safety-rules — ไม่มีคำเป้าหมายตรง ๆ แต่ "จ่ายไปแล้วไม่ได้ของ" คือธุรกรรมกับเรา
  "โดนโกง จ่ายเงินไปแล้วไม่ได้ของ",
  "โดนหลอกค่ะ โอนเงินไปแล้วไม่ได้ลิงก์เข้าเรียน",
  // คำแรง (strong) ยังจับได้เหมือนเดิมแม้ในข้อความมีคำว่าสแกม ถ้าพุ่งมาที่เรา
  "พวกสแกมยังไม่แย่เท่าที่นี่เลย โกหกกันชัด ๆ ขอเงินคืนด้วยครับ",
]) {
  test(`complaint aimed at us still escalates — ${text.slice(0, 30)}`, () => {
    const route = routeMessage({ text });
    assert.equal(route.route, "complaint");
    assert.equal(route.escalate?.reason, "complaint");
  });
}

// เส้นเต็ม: ผู้เสียหายจากมิจฉาชีพต้องได้คำตอบจากลูกแพร ไม่ใช่แม่แบบขออภัย + ปิด AI + push
test("scam-victim story: pipeline keeps AI on, no complaint template, no push", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const notices = [];
  const hermesFetch = hermesFetchStub("เข้าใจเลยค่ะ ถ้าไม่แน่ใจอย่าเพิ่งกดลิงก์นะคะ เดี๋ยวลูกแพรช่วยดูให้ค่ะ");
  const line = lineFetchStub();
  const app = createApp({
    db, logger: silent, config: testConfig(),
    overrides: { notifier: { fireLater: (n) => notices.push(n) }, hermesFetch, lineFetch: line, sleep: async () => {} },
  });
  const customerId = "U-synthetic-scam-victim";
  db.upsertCustomer(customerId, {});
  const text = "หนูกลัวว่าจะถูกหลอกค่ะ โดนมา 2 ครั้งแล้ว ไม่กล้ากดอะไรเลย";
  db.insertMessage({ customerId, direction: "in", content: text });
  const result = await app.pipeline.handleInboundText({ customerId, text, replyToken: "rt" });
  assert.equal(result.route, "ai");
  assert.equal(result.sent, true);
  const row = db.getCustomer(customerId);
  assert.equal(row.ai_enabled, 1);
  assert.notEqual(row.state, "NEEDS_HUMAN");
  assert.equal(notices.filter((n) => n.reason === "complaint").length, 0);
  assert.equal(hermesFetch.calls.length, 1, "ลูกแพรต้องได้คิดคำตอบเอง");
  assert.doesNotMatch(JSON.stringify(line.sends.map((s) => s.body)), /ต้องขออภัยอย่างยิ่ง/u);
});
