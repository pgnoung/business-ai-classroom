// F14 (ตรวจย้อนหลัง ก.ย. 2026 — D935 ผิด, D570 ก้ำกึ่ง): พัก AI เพราะ "สงสัยแอดมินตอบนอกระบบ" อ่านผิด
// และระหว่างพักกลืนคำขอติดต่อทีมงานเงียบ
//
// ของจริง: ลูกค้าเล่าว่า "พี่ง้วงพูดไว้ในงานเมื่อวาน" / "ที่โค้ชเปิดให้ดูท้ายสัมมนา" — scorer อ่านเป็นการอ้างถึง
// คำตอบแอดมินที่ไม่อยู่ในแชท -> พัก AI 30 นาที · ระหว่างพัก ลูกค้าขอติดต่อทีมงานแล้วไม่มีใครรู้ 15 ชม.
// กติกาใหม่:
//   1) การอ้างถึงสิ่งที่เจ้าของพูดในงาน/สัมมนา/เวที/คลาส/ไลฟ์ ไม่ใช่สัญญาณแอดมินตอบนอกระบบ = ไม่พัก
//   2) ระหว่าง AI พักโดยไม่มีคนจริงอยู่ในห้อง คำขอติดต่อทีมงาน/ขอจอง = ปักธง + ปลุกทีม (ยังไม่ตอบ ไม่ปิด AI)
// ข้อความทั้งหมดเป็นประโยคสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { OUT_OF_BAND_PAUSE_MS } from "../src/pipeline.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, lineFetchStub, promptText } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function scorerJson(overrides = {}) {
  return JSON.stringify({
    score: 5, trend: "flat", buying_signals: [],
    persona_read: { disc: "unknown", bank: "unknown", reason: "" },
    next_move: "", suggested_question: "", context_summary: "", ...overrides,
  });
}

function makeApp({ outOfBand = false } = {}) {
  const db = memoryDb();
  const notices = [];
  const hermesFetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const system = body.messages?.[0]?.role === "system" ? promptText(body.messages[0].content) : "";
    const content = system.includes("ระบบวิเคราะห์ความสนใจซื้อ")
      ? scorerJson({ out_of_band_reply: outOfBand })
      : "ได้เลยค่ะ ลูกแพรเล่ารายละเอียดให้นะคะ";
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  const lineFetch = lineFetchStub();
  const app = createApp({
    db, logger: silent, config: testConfig(),
    overrides: { hermesFetch, lineFetch, notifier: { fireLater: (n) => notices.push(n) }, sleep: async () => {} },
  });
  return { app, db, notices, lineFetch };
}

test("F14 ข้อ 1: อ้างถึงสิ่งที่เจ้าของพูดในงานสัมมนา = ไม่ใช่แอดมินตอบนอกระบบ ไม่พัก AI", async (t) => {
  const { app, db } = makeApp({ outOfBand: true });
  t.after(() => db.close());
  const id = "U-oob-seminar";
  db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "in", content: "อยากเรียนเรื่องที่พี่ง้วงพูดไว้เมื่องานสัมมนาเมื่อวานค่ะ" });
  await app.pipeline.scoreBurst(id);
  const row = db.getCustomer(id);
  assert.ok(!(Number(row.operator_active_until) > Date.now()), "ห้ามพัก AI เพราะการเล่าถึงงานสัมมนา");
  assert.doesNotMatch(String(row.handoff_summary || ""), /out_of_band/u);
  assert.ok(db.listAudit().some((a) => a.action === "out_of_band_skipped_event" && a.target === id));
});

test("F14 ข้อ 1 (คุมกลุ่ม): อ้างถึงคำตอบแอดมินที่ไม่อยู่ในแชท = ยังพัก AI เหมือนเดิม", async (t) => {
  const { app, db } = makeApp({ outOfBand: true });
  t.after(() => db.close());
  const id = "U-oob-admin";
  db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "in", content: "ได้ครับตามนั้น โอนตามที่แอดมินบอกเมื่อกี้เลยนะ" });
  const before = Date.now();
  await app.pipeline.scoreBurst(id);
  assert.ok(Number(db.getCustomer(id).operator_active_until) >= before + OUT_OF_BAND_PAUSE_MS - 1000);
});

test("F14 ข้อ 2: ระหว่าง AI พัก (ไม่มีคนจริงในห้อง) ลูกค้าขอคุยกับโค้ช = ปักธง + ปลุกทีม ไม่ตอบ ไม่ปิด AI", async (t) => {
  const { app, db, notices, lineFetch } = makeApp();
  t.after(() => db.close());
  const id = "U-paused-contact";
  db.upsertCustomer(id, {});
  db.setOperatorActiveUntil(id, Date.now() + OUT_OF_BAND_PAUSE_MS);
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "อยากคุยกับโค้ชค่ะ", replyToken: "rt" });
  assert.equal(result.suppressed, "operator_active", "ยังไม่ตอบระหว่างพักเหมือนเดิม");
  assert.equal(lineFetch.sends.length, 0);
  const row = db.getCustomer(id);
  assert.equal(row.ai_enabled, 1, "ไม่ปิด AI — แค่ให้คนรู้");
  assert.equal(row.state, "NEEDS_HUMAN");
  assert.match(row.handoff_summary, /paused_contact_request/u);
  assert.equal(notices.filter((n) => n.reason === "paused_contact_request").length, 1);
});

test("F14 ข้อ 2: คนจริงเพิ่งตอบในห้อง (พักเพราะคนกำลังคุย) = ไม่ปลุกซ้ำ ไม่ปักธงเพิ่ม", async (t) => {
  const { app, db, notices } = makeApp();
  t.after(() => db.close());
  const id = "U-human-chatting";
  db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "out", content: "สวัสดีค่ะ ชมพู่ดูแลต่อนะคะ", operator: "chom" });
  db.setOperatorActiveUntil(id, Date.now() + 15 * 60_000);
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "อยากคุยกับโค้ชค่ะ", replyToken: "rt" });
  assert.equal(result.suppressed, "operator_active");
  assert.equal(notices.length, 0);
  assert.doesNotMatch(String(db.getCustomer(id).handoff_summary || ""), /paused_contact_request/u);
});

test("F14 ข้อ 2: ระหว่างพัก คำถามทั่วไป = เงียบเหมือนเดิม (ไม่ปลุกทีม)", async (t) => {
  const { app, db, notices } = makeApp();
  t.after(() => db.close());
  const id = "U-paused-question";
  db.upsertCustomer(id, {});
  db.setOperatorActiveUntil(id, Date.now() + OUT_OF_BAND_PAUSE_MS);
  await app.pipeline.handleInboundText({ customerId: id, text: "คลาสเรียนกี่ชั่วโมงคะ", replyToken: "rt" });
  assert.equal(notices.length, 0);
});

test("F14: ระหว่างพัก ขอเบอร์โทรโค้ช = เส้นส่งต่อคนแบบ deterministic ตอบ + ปลุกทีม (F4)", async (t) => {
  const { app, db, notices } = makeApp();
  t.after(() => db.close());
  const id = "U-paused-phone";
  db.upsertCustomer(id, {});
  db.setOperatorActiveUntil(id, Date.now() + OUT_OF_BAND_PAUSE_MS);
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "ขอเบอร์โทรโค้ชด้วยนะคะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(notices.filter((n) => n.reason === "human_requested").length, 1);
});
