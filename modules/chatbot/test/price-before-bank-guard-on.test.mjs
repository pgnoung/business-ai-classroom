// F12 (ตรวจย้อนหลัง ก.ย. 2026 — D1003 ผิด, D860 ก้ำกึ่ง): เลขบัญชีออกก่อนราคา แล้วห้องถูกปิด
//
// ของจริง: ลูกค้าถามค่าเรียน โมเดลส่งบล็อกเลขบัญชีแทนราคา -> ปิด AI ด้วย bank_sent -> คำถามซ้ำของลูกค้าตกหล่น
// และอีกห้องได้บล็อกบัญชีทั้งที่ยอดยัง "รอยืนยัน" · ตอนนั้นสวิตช์ SALES_DECISION_GUARD_ENABLED ยังปิด
// ตั้งแต่ 27 ก.ย. 12:45 โปรดักชันเปิดสวิตช์นี้แล้ว — ด่าน "ราคาก่อนเลขบัญชี" ครอบทั้งสองเคสโดยไม่ต้องเพิ่มโค้ด
// ไฟล์นี้ผูกพฤติกรรมตอนสวิตช์เปิดไว้ (ถ้าใครปิดสวิตช์หรือแก้ด่านจนหลุด เทสต์ตกทันที)
// ส่วน "ส่งเลขบัญชีก่อนลูกค้าตัดสินใจ" (D853) เป็นการตัดสินใจเชิงนโยบายของเจ้าของ ไม่ได้ผูกไว้ที่นี่
// ข้อความทั้งหมดเป็นประโยคสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { poisonGlobalFetch, memoryDb, testConfig, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const COURSE = "AI Agent Workflow Automation";
const ACCOUNT = "0000000000";

// ตอบตามลำดับที่ส่งมา แล้วค้างที่คำตอบสุดท้าย (คำขอหลังจากนั้น เช่น scorer ได้คำตอบเดิม)
function sequenceHermes(replies) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    const content = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) };
  };
  fn.calls = calls;
  return fn;
}

function fixture(replies, { guard = true } = {}) {
  const db = memoryDb();
  db.setApprovedPrice(`${COURSE} — Early Bird`, 15900);
  const lineFetch = lineFetchStub();
  const app = createApp({
    db, logger: silent,
    config: testConfig({ SALES_DECISION_GUARD_ENABLED: String(guard) }),
    overrides: {
      hermesFetch: sequenceHermes(replies), lineFetch, notifier: { fireLater() {} }, sleep: async () => {},
      salesPolicy: { businessId: "pngoung-tidkradum", decisionRoles: [], customerJourneys: [], opportunities: [],
        courses: [{ id: "workflow", name: COURSE, aliases: [] }] },
    },
  });
  return { app, db, lineFetch };
}
const sentText = (lineFetch) => lineFetch.sends.flatMap((call) => call.body?.messages || []).map((m) => m.text || "").join("\n");
const audits = (db, id) => db.listAudit().filter((a) => a.target === id).map((a) => a.action);

test("F12: ถามค่าเรียน แต่โมเดลส่งเลขบัญชีแทนราคา -> เลขบัญชีไม่ออก ตอบราคาแทน ห้องไม่ปิด", async (t) => {
  const { app, db, lineFetch } = fixture([
    `โอนค่าเรียนเข้าบัญชีได้เลยค่ะ\n\nเลขบัญชี: ${ACCOUNT}`,
    `${COURSE} ค่าเรียน 15,900 บาทค่ะ สนใจรอบไหนดีคะ`,
  ]);
  t.after(() => db.close());
  const id = "U-f12-price-question";
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "ค่าเรียนเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  const sent = sentText(lineFetch);
  assert.doesNotMatch(sent, new RegExp(ACCOUNT), "เลขบัญชีห้ามออกก่อนราคา");
  assert.match(sent, /15,900/, "ลูกค้าต้องได้คำตอบเรื่องราคาที่ถาม");
  assert.equal(db.getCustomer(id).ai_enabled, 1);
  const actions = audits(db, id);
  assert.ok(actions.includes("price_before_bank_blocked"));
  assert.ok(!actions.includes("ai_off_bank_sent"), `ห้ามปิดห้องด้วย bank_sent (ได้ ${actions.join(",")})`);
});

test("F12: สรุปยอดยัง \"รอยืนยัน\" แต่มีเลขบัญชี -> กันเลขบัญชี + ธงให้ทีมตรวจยอด ห้องไม่ปิด", async (t) => {
  const draft = `${COURSE}\nสรุปยอด: รอยืนยันจากทีม\n\nเลขบัญชี: ${ACCOUNT}`;
  const { app, db, lineFetch } = fixture([draft, draft]);
  t.after(() => db.close());
  const id = "U-f12-unconfirmed-amount";
  await app.pipeline.handleInboundText({ customerId: id, text: "ขอใบเสนอราคาสำหรับทีม 5 คนค่ะ", replyToken: "rt" });
  assert.doesNotMatch(sentText(lineFetch), new RegExp(ACCOUNT));
  const row = db.getCustomer(id);
  assert.equal(row.ai_enabled, 1);
  assert.equal(row.state, "NEEDS_HUMAN");
  assert.match(row.handoff_summary, /price_before_bank/u);
  assert.ok(!audits(db, id).includes("ai_off_bank_sent"));
});

test("F12: ลูกค้าตัดสินใจแล้ว + ข้อความมีราคาของคอร์สนั้นก่อนเลขบัญชี -> ส่งได้ AI ยังตอบข้อมูลต่อ หยุดแค่ follow-up", async (t) => {
  const { app, db, lineFetch } = fixture([`${COURSE} ค่าเรียน 15,900 บาทค่ะ\n\nเลขบัญชี: ${ACCOUNT}`]);
  t.after(() => db.close());
  const id = "U-f12-decided";
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "โอนวันนี้เลยค่ะ ขอเลขบัญชีด้วยค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.match(sentText(lineFetch), new RegExp(ACCOUNT));
  const row = db.getCustomer(id);
  assert.equal(row.ai_enabled, 1, "สวิตช์เปิด = หลังส่งเลขบัญชี AI ยังตอบคำถามต่อได้ (ไม่ปิดห้องเงียบ)");
  assert.equal(row.followup_enabled, 0, "แต่ follow-up ทวงโอนต้องหยุด");
  assert.ok(!audits(db, id).includes("ai_off_bank_sent"));
});
