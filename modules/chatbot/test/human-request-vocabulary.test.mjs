// F4 (ตรวจย้อนหลัง ก.ย. 2026 — D762, D324, D851, D570/D636/D915/D390): คำขอคน/ขอช่องทางติดต่อ
// ที่ตัวจับไม่รู้จัก — "ขอคุยกับมนุษย์", "เอาเบอร์ทีมงานมา", "ขอไอดีไลน์", "โทรได้ไหม"
// ของจริง: บอทรับปากส่งต่อแต่ AI ยังเปิด ทักตามต่อ 4.5 ชม. คนมาถึงหลัง 11–25 ชม.
//
// F4b: "ไม่ต้องตอบกลับแล้วครับ" = หยุดเงียบ ๆ (ไม่ส่งแม่แบบส่งต่อใส่คนที่เพิ่งบอกว่าไม่ต้องตอบ)
// ปิด AI ด้วยเหตุ customer_asked_quiet + โน้ตทีม + push ธรรมดา + หยุด follow-up
// ข้อความในไฟล์นี้เป็นประโยคสังเคราะห์ทั้งหมด
import test from "node:test";
import assert from "node:assert/strict";
import { routeMessage } from "../src/safetyRouter.mjs";
import { detectHandoffIntent } from "../src/handoffIntent.mjs";
import { looksLikeHandoverReply } from "../src/pipeline.mjs";
import { createApp } from "../src/server.mjs";
import { isStickyAiOffReason, stickyOffPlanFor } from "../src/aiPausePolicy.mjs";
import { needsPersonReason } from "../src/needsPersonReason.mjs";
import { isWaitingForHuman } from "../src/needsHumanSla.mjs";
import { NOTIFY_REASON_TEXT } from "../src/notify.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

for (const text of [
  "ขอคุยกับมนุษย์ค่ะ",
  "เอาเบอร์ทีมงานมาหน่อยครับ จะส่งไฟล์ให้ดู",
  "ขอไลน์แอดมินได้ไหมคะ",
  "โทรคุยกันได้ไหมครับ พิมพ์แล้วกลัวไม่ตรง",
  "ขอเบอร์โทรโค้ชด้วยนะคะ",
  "ขอไอดีไลน์ค่ะ",
  "ขอเบอร์โทรศัพท์ติดต่อด้วยครับ",
  "มีเบอร์ติดต่อให้สอบถามได้ไหมครับ",
  "มีไลน์ไหมคะ",
  "ขอมนุษย์หน่อยค่ะ",
]) {
  test(`ขอคน/ขอช่องทางติดต่อคนของเรา → human_handoff — ${text}`, () => {
    const route = routeMessage({ text });
    assert.equal(route.route, "human_handoff");
    assert.equal(route.escalate?.reason, "human_requested");
  });
}

for (const text of [
  "ขอเบอร์บัญชีสำหรับโอนหน่อยครับ",
  "ลูกค้าร้านผมพิมพ์ว่าขอเบอร์แอดมิน บอทควรทำยังไง",
  "ใช้ AI ตอบลูกค้าแล้วลูกค้าบ่นว่าไม่จริงใจ แก้ยังไงดี",
  "ในคอร์สมีสอนให้บอทเรียกคนมาตอบแทนไหม",
  "มีเบอร์โทรของลูกค้าอยู่ในชีทแล้ว อยากให้ AI โทรหาได้ไหม",
  "บอทที่สอนในคลาสโทรได้ไหมครับ",
  "มีไลน์ค่ะ",
  "ขอไลน์กลุ่มคลาสหน่อยค่ะ",
  "ขอเบอร์ทำไมคะ",
]) {
  test(`ไม่ใช่การขอคนของเรา — ${text}`, () => {
    assert.notEqual(routeMessage({ text }).route, "human_handoff");
  });
}

test("F4b: ลูกค้าบอกว่าไม่ต้องตอบกลับ = หยุดเงียบ ไม่ใช่แม่แบบส่งต่อ", () => {
  for (const text of [
    "ไม่ต้องตอบกลับแล้วครับ",
    "ไม่ต้องตอบกลับครับลูกแพร งานผมจะไม่เสร็จ",
    "ไม่ต้องตอบแล้วค่ะ",
    "ไม่ต้องตอบนะ",
  ]) {
    const route = routeMessage({ text });
    assert.equal(route.route, "quiet_stop", text);
    assert.equal(route.template, null, `${text}: ห้ามมีข้อความตอบ`);
    assert.equal(route.escalate?.reason, "customer_asked_quiet", text);
  }
});

test("F4b: รูปที่ไม่ใช่คำสั่งหยุด ต้องคุยต่อ (ข้อความเล่า/สุภาพ/ยังไม่ต้อง)", () => {
  for (const text of [
    "ไม่ต้องตอบก็ได้ค่ะ แค่แจ้งให้ทราบว่าจะมาสายนิดนึง",
    "ยังไม่ต้องตอบนะคะ เดี๋ยวส่งรายละเอียดเพิ่ม",
    "ถ้าลูกค้าพิมพ์ว่าไม่ต้องตอบกลับ บอทจะหยุดเองได้ไหม",
    "ลูกค้าบอกว่าไม่ต้องตอบแล้ว ต้องทำยังไงต่อ",
    "บอทไม่ต้องตอบคำถามแบบนี้ก็ได้ใช่ไหมคะ",
  ]) assert.notEqual(routeMessage({ text }).route, "quiet_stop", text);
});

test("F4b: ไม่เชื่อใจ AI ที่ตอบเรา = ส่งต่อคน (แต่เรื่องเล่าลูกค้าของเขาไม่ใช่)", () => {
  assert.equal(routeMessage({ text: "ถ้าใช้เอไอตอบ คิดว่าไม่จริงใจกับผู้เรียนเท่าไหร่ครับ" }).route, "human_handoff");
  assert.equal(routeMessage({ text: "เป็นบอทตอบแบบนี้ไม่โอเคเลยค่ะ" }).route, "human_handoff");
  assert.notEqual(routeMessage({ text: "ใช้เอไอตอบลูกค้าแล้วลูกค้าบ่นว่าไม่จริงใจ ช่วยแนะนำหน่อย" }).route, "human_handoff");
});

test("ใบ้ส่งไม้ต่อ (กุญแจดอกที่ 1) รู้จักคำว่า โค้ช/มนุษย์ และ เอาเบอร์", () => {
  assert.equal(detectHandoffIntent("อยากติดต่อโค้ชค่ะ")?.kind, "contact_team");
  assert.equal(detectHandoffIntent("ขอติดต่อมนุษย์หน่อยค่ะ")?.kind, "contact_team");
  assert.equal(detectHandoffIntent("เอาเบอร์ทีมงานมาหน่อยครับ")?.kind, "contact_team");
  assert.equal(detectHandoffIntent("ลูกค้าผมอยากติดต่อโค้ช บอทช่วยได้ไหม"), null);
});

test("กุญแจดอกที่ 2 อ่านประโยคส่งไม้ต่อที่ลูกแพรพูดจริงออก (เข้ามาดูแลในแชทนี้)", () => {
  assert.equal(looksLikeHandoverReply(["ได้เลยค่ะ ลูกแพรส่งต่อให้ทีมงานคนจริงเข้ามาดูแลในแชทนี้นะคะ"]), true);
  assert.equal(looksLikeHandoverReply(["รับทราบค่ะ ลูกแพรส่งเรื่องให้ทีมงานเข้ามาดูแลในแชทนี้แล้วค่ะ"]), true);
  // ของเดิมที่ต้องยังไม่ผ่าน: คำสุภาพ / เงื่อนไข / คำถามท้าย
  assert.equal(looksLikeHandoverReply(["ทีมงานพร้อมช่วยดูแลทุกขั้นตอนค่ะ"]), false);
  assert.equal(looksLikeHandoverReply(["หากต้องการ ลูกแพรส่งต่อให้ทีมงานเข้ามาดูแลในแชทนี้ได้เลยค่ะ"]), false);
  assert.equal(looksLikeHandoverReply(["ลูกแพรส่งต่อให้ทีมงานเข้ามาดูแลในแชทนี้ได้ไหมคะ"]), false);
});

test("F4b registries: customer_asked_quiet เป็นเหตุปิดถาวร อยู่ในคิวรอคน แต่ไม่เข้าบันไดทวง SLA", () => {
  assert.equal(isStickyAiOffReason("customer_asked_quiet"), true);
  assert.deepEqual(stickyOffPlanFor("customer_asked_quiet"),
    { offReason: "customer_asked_quiet", auditAction: "ai_off_customer_asked_quiet" });
  const row = { ai_enabled: 0, ai_off_reason: "customer_asked_quiet", state: "NEEDS_HUMAN",
    handoff_summary: "[2026-09-28T01:00:00.000Z] customer_asked_quiet: x" };
  assert.equal(isWaitingForHuman(row), true, "ทีมต้องเห็นห้องนี้ในคิว");
  assert.equal(needsPersonReason(row), null, "ลูกค้าขอไม่ให้ตอบ — ห้ามทวงทีมให้รีบตอบ");
  assert.ok(NOTIFY_REASON_TEXT.customer_asked_quiet, "push ต้องมีข้อความบอกเหตุ");
});

test("F4b pipeline: หยุดเงียบจริง — ไม่ส่งอะไรเลย ปิด AI ยกเลิก follow-up โน้ตทีม push ธรรมดา", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const notices = [];
  const hermesFetch = hermesFetchStub("ไม่ควรถูกเรียก");
  const line = lineFetchStub();
  const app = createApp({
    db, logger: silent, config: testConfig(),
    overrides: { notifier: { fireLater: (n) => notices.push(n) }, hermesFetch, lineFetch: line, sleep: async () => {} },
  });
  const customerId = "U-synthetic-quiet";
  db.upsertCustomer(customerId, {});
  const fu = db.createFollowup({ customerId, scheduledAt: Date.now() + 3_600_000, createdBy: "test" });
  const text = "ไม่ต้องตอบกลับแล้วครับ";
  db.insertMessage({ customerId, direction: "in", content: text });
  const result = await app.pipeline.handleInboundText({ customerId, text, replyToken: "rt" });

  assert.equal(result.suppressed, "customer_asked_quiet");
  assert.equal(line.sends.length, 0, "ลูกค้าบอกว่าไม่ต้องตอบ — ห้ามส่งอะไรทั้งนั้น");
  assert.equal(hermesFetch.calls.length, 0);
  const row = db.getCustomer(customerId);
  assert.equal(row.ai_enabled, 0);
  assert.equal(row.ai_off_reason, "customer_asked_quiet");
  assert.equal(row.state, "NEEDS_HUMAN");
  assert.equal(db.getFollowup(fu.id)?.status, "cancelled", "follow-up ที่ค้างต้องหยุด");
  assert.ok(db.listHandoffNotes(customerId, 10).some((n) => n.author === "ai_auto" && /ขอให้หยุดตอบ/u.test(n.text)));
  assert.ok(db.listAudit().some((a) => a.action === "ai_off_customer_asked_quiet" && a.target === customerId));
  const quiet = notices.filter((n) => n.reason === "customer_asked_quiet");
  assert.equal(quiet.length, 1);
  assert.notEqual(quiet[0].force, true, "push ธรรมดา (ไม่ทะลุ cooldown)");
});
