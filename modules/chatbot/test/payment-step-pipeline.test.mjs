// ขั้นชำระเงินที่ระบบประกอบเอง ผ่าน pipeline จริง (audit ลูกแพร 18 ต.ค. 2026)
// ต้นเหตุ: ตั้งแต่ 27 ก.ย. 12:45 (เปิด SALES_DECISION_GUARD_ENABLED) โมเดลไม่ร่างบล็อกบัญชีอีกเลย — ลูกค้าตอบ
// "บุคคลธรรมดา/บริษัท" แล้วไม่ได้บัญชี · ไฟล์นี้ผูกว่าระบบส่งเอง ส่งครั้งเดียว และปิดสวิตช์แล้วกลับเป็นแบบเดิม
// ข้อความทั้งหมดเป็นประโยคสังเคราะห์ · เลขบัญชีในการ์ดเป็นเลขสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { DOC_TYPE_QUESTION, PAYMENT_STEP_PIN_PREFIX, PAYMENT_STEP_SETTING } from "../src/paymentStep.mjs";
import { poisonGlobalFetch, memoryDb, testConfig, lineFetchStub } from "./helpers.mjs";
import { CLOSING_CARD, COURSES, PRICES } from "./paymentStepFixture.mjs";

poisonGlobalFetch();
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const ACCOUNT = "000-0-00000-0";
const QUOTE = "📌 AI Agent for Business\nโปรโมชั่น Early Bird 12,900 บาท/ท่าน";

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

// รอบเรียนสดหนึ่งรอบต่อคลาสในอนาคต (ระบบอ่านรอบจากไฟล์ — ไม่มีรอบเปิด = ไม่ประกอบเอง ส่งให้คน)
function roundsFile() {
  const iso = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const file = join(mkdtempSync(join(tmpdir(), "payment-step-")), "class-rounds.json");
  writeFileSync(file, JSON.stringify({ seatsPerRound: 15,
    classes: { basic: { label: "Classroom AI Agent for Business", product: "AI Agent for Business" },
      advance: { label: "Classroom AI Agent Workflow Automation", product: "AI Agent Workflow Automation" } },
    rounds: [{ date: iso(30), class: "basic", status: "open" }, { date: iso(37), class: "advance", status: "open" }] }), "utf8");
  return file;
}

// รูปช่องทางชำระในแค็ตตาล็อก (URL สังเคราะห์) — ใช้ยืนยันว่ารูปวางต่อจากบล็อกบัญชี ก่อนฟอร์ม
function catalogFile() {
  const file = join(mkdtempSync(join(tmpdir(), "payment-step-img-")), "image-catalog.json");
  writeFileSync(file, JSON.stringify([{ key: "payment-kbank", url: "https://img.test/payment-kbank.jpg", preview_url: "https://img.test/payment-kbank-preview.jpg",
    description: "การ์ดช่องทางชำระเงิน", needs_verification: false }]), "utf8");
  return file;
}

function fixture(replies = ["ได้เลยค่ะ"], { guard = true, card = true } = {}) {
  const db = memoryDb();
  for (const row of PRICES) db.setApprovedPrice(row.label, row.amount);
  if (card) db.addKnowledge({ title: CLOSING_CARD.title, content: CLOSING_CARD.content, updatedBy: "ngoung" });
  const lineFetch = lineFetchStub();
  const notices = [];
  const hermesFetch = sequenceHermes(replies);
  const app = createApp({
    db, logger: silent,
    config: testConfig({ SALES_DECISION_GUARD_ENABLED: String(guard), CLASS_ROUNDS_FILE: roundsFile(), IMAGE_CATALOG_FILE: catalogFile() }),
    overrides: {
      hermesFetch, lineFetch, notifier: { fireLater(notice) { notices.push(notice); } }, sleep: async () => {},
      salesPolicy: { businessId: "pngoung-tidkradum", decisionRoles: [], customerJourneys: [], opportunities: [], courses: COURSES },
    },
  });
  return { app, db, lineFetch, notices, hermesFetch };
}
const sentMessages = (lineFetch) => lineFetch.sends.flatMap((call) => call.body?.messages || []);
const sentText = (lineFetch) => sentMessages(lineFetch).map((m) => m.text || "").join("\n");
const audits = (db, id) => db.listAudit().filter((a) => a.target === id).map((a) => a.action);
function seed(db, id, turns) {
  for (const [direction, content] of turns) db.insertMessage({ customerId: id, direction, msgType: "text", content });
}
const draftCalls = (hermesFetch) => hermesFetch.calls.filter((call) => JSON.stringify(call.body).includes("ลูกแพร"));

test("ลูกค้าตอบ \"บุคคลธรรมดาค่ะ\" หลังถูกถาม -> ระบบส่งสรุป + บัญชีตามการ์ด + ฟอร์ม ในชุดเดียว · ดีลรอชำระ · AI ยังตอบข้อมูลต่อ", async (t) => {
  const { app, db, lineFetch, notices } = fixture();
  t.after(() => db.close());
  const id = "U-pay-person";
  seed(db, id, [["in", "สอบถามราคาคลาส AI Agent for Business ค่ะ"], ["out", QUOTE], ["in", "สมัครค่ะ"], ["out", DOC_TYPE_QUESTION]]);
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "บุคคลธรรมดาค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  const texts = sentMessages(lineFetch).filter((m) => m.type === "text").map((m) => m.text);
  assert.match(texts[0], /คลาส : AI Agent for Business\n.*ค่าเรียน : 12,900 บาท\/ท่าน\nออกเอกสารในนาม : บุคคลธรรมดา$/su);
  assert.equal(texts[1], `สามารถโอนชำระได้ที่บัญชีนี้นะคะ\n\nธนาคาร : กสิกรไทย\nเลขที่บัญชี : ${ACCOUNT}\nชื่อบัญชี : บจก. ตัวอย่าง`);
  assert.match(texts[2], /^แจ้งโอนแล้ว ลูกแพรขออนุญาตรบกวน[\s\S]*ขอบพระคุณมากค่ะ 🙏🏻😊$/u);
  const order = sentMessages(lineFetch).map((m) => (m.type === "image" ? `image:${m.originalContentUrl}` : m.type));
  assert.deepEqual(order, ["text", "text", "image:https://img.test/payment-kbank.jpg", "text"], "สรุป → บัญชี → รูปช่องทางชำระ → ฟอร์ม");
  const row = db.getCustomer(id);
  assert.equal(row.deal_status, "awaiting_payment");
  assert.equal(row.ai_enabled, 1, "ด่านเงินเปิด = AI ยังตอบคำถามทั่วไปได้ (ไม่ปิดห้องเงียบ)");
  assert.equal(row.followup_enabled, 0, "ไม่ทวงโอนด้วย follow-up");
  const actions = audits(db, id);
  assert.ok(actions.includes("payment_step_composed"), actions.join(","));
  assert.ok(actions.includes("bank_sent_info_continues"), "ตัวทักเบา ๆ/ตัวนับส่งบัญชีอ่านแถวนี้");
  const bankNotice = notices.find((n) => n.reason === "bank_sent");
  assert.match(bankNotice.reasonTextOverride, /รอทีมตรวจยอดโอนจริง/u);
  assert.doesNotMatch(bankNotice.reasonTextOverride, /หยุดตอบถาวร/u);
});

test("ส่งครั้งเดียว: เทิร์นถัดไปไม่ส่งบัญชีซ้ำ ถึงลูกค้าพิมพ์บุคคลธรรมดาอีก", async (t) => {
  const { app, db, lineFetch } = fixture(["รับทราบค่ะ ทีมงานจะตรวจยอดให้นะคะ"]);
  t.after(() => db.close());
  const id = "U-pay-once";
  seed(db, id, [["out", QUOTE], ["out", DOC_TYPE_QUESTION]]);
  await app.pipeline.handleInboundText({ customerId: id, text: "บุคคลธรรมดา", replyToken: "rt1" });
  const firstCount = (sentText(lineFetch).match(new RegExp(ACCOUNT, "gu")) || []).length;
  assert.equal(firstCount, 1);
  await app.pipeline.handleInboundText({ customerId: id, text: "บุคคลธรรมดาค่ะ ขอบคุณค่ะ", replyToken: "rt2" });
  assert.equal((sentText(lineFetch).match(new RegExp(ACCOUNT, "gu")) || []).length, 1);
  assert.equal(audits(db, id).filter((a) => a === "payment_step_composed").length, 1);
});

test("ผลตรวจโค้ด 18 ต.ค.: ห้องที่ lifecycle ตั้ง \"รอชำระ\" ตอนเลือกรอบ (ยังไม่เคยได้บัญชี) ยังได้ชุดชำระเงิน · บัญชีเก่ากว่าหน้าต่างประวัติ = ไม่ส่งซ้ำ", async (t) => {
  const { app, db, lineFetch } = fixture(["รับทราบค่ะ"]);
  t.after(() => db.close());
  const fresh = "U-pay-round-chosen";
  seed(db, fresh, [["out", QUOTE], ["in", "เอารอบใกล้สุดค่ะ"], ["out", DOC_TYPE_QUESTION]]);
  db.setDealStatus(fresh, "awaiting_payment");
  await app.pipeline.handleInboundText({ customerId: fresh, text: "บุคคลธรรมดาค่ะ", replyToken: "rt1" });
  assert.equal((sentText(lineFetch).match(new RegExp(ACCOUNT, "gu")) || []).length, 1);
  const old = "U-pay-old-bank";
  seed(db, old, [["out", `${QUOTE}\n\nสามารถโอนชำระได้ที่บัญชีนี้นะคะ\n\nธนาคาร : กสิกรไทย\nเลขที่บัญชี : ${ACCOUNT}\nชื่อบัญชี : บจก. ตัวอย่าง`]]);
  for (let i = 0; i < 40; i += 1) seed(db, old, [["in", `คำถามที่ ${i}`], ["out", `คำตอบที่ ${i}`]]);
  seed(db, old, [["out", DOC_TYPE_QUESTION]]);
  await app.pipeline.handleInboundText({ customerId: old, text: "บริษัทค่ะ", replyToken: "rt2" });
  assert.equal((sentText(lineFetch).match(new RegExp(ACCOUNT, "gu")) || []).length, 1, "บัญชีที่ส่งไปนานแล้วยังนับว่าได้แล้ว");
  assert.ok(!audits(db, old).includes("payment_step_composed"));
});

test("ตอบประเภทเอกสาร + ถามเรื่องอื่น -> โมเดลตอบก่อน (ห้ามถามเอกสารซ้ำ) · ลูกค้าตอบรับ -> ระบบส่งชุดบริษัท + ขอข้อมูลบริษัท", async (t) => {
  const { app, db, lineFetch, hermesFetch } = fixture(["คลาสนี้เป็น Workshop 1 วันค่ะ ได้ลงมือทำจริงทั้งวัน"]);
  t.after(() => db.close());
  const id = "U-pay-mixed";
  seed(db, id, [["out", QUOTE], ["out", DOC_TYPE_QUESTION]]);
  await app.pipeline.handleInboundText({ customerId: id, text: "ขอรายละเอียดคอร์สได้ไหมครับ\nนามบริษัทครับ", replyToken: "rt1" });
  assert.doesNotMatch(sentText(lineFetch), new RegExp(ACCOUNT));
  assert.ok(db.getSetting(`${PAYMENT_STEP_PIN_PREFIX}${id}`).includes("company"));
  const prompt = JSON.stringify(draftCalls(hermesFetch).at(-1)?.body || {});
  assert.match(prompt, /ห้ามถามประเภทเอกสารซ้ำ/u);
  assert.match(prompt, /ระบบเป็นผู้ส่งสรุปคลาส/u, "กติกาใหม่แทนที่ PRICE_BEFORE_BANK_RULE");
  assert.doesNotMatch(prompt, /ขั้นตอนปิดการขายเก่า/u);
  await app.pipeline.handleInboundText({ customerId: id, text: "โอเคครับ สมัครเลยครับ", replyToken: "rt2" });
  const all = sentText(lineFetch);
  assert.match(all, /ออกเอกสารในนามบริษัทได้ค่ะ/u);
  assert.match(all, new RegExp(ACCOUNT));
  assert.match(all, /ชื่อนิติบุคคล สำนักงานใหญ่หรือสาขาเลขที่/u);
  assert.equal(db.getSetting(`${PAYMENT_STEP_PIN_PREFIX}${id}`), "", "ส่งแล้วล้างหมุด");
});

test("ข้อมูลไม่พอ (หลายที่นั่ง) -> ไม่ประกอบเอง · ปักธงให้ทีมส่งบัญชีครั้งเดียว · โมเดลตอบโดยไม่มีบัญชี", async (t) => {
  const { app, db, lineFetch, notices } = fixture(["ได้เลยค่ะ ทีมงานจะส่งรายละเอียดการชำระสำหรับ 3 ท่านให้นะคะ"]);
  t.after(() => db.close());
  const id = "U-pay-group";
  seed(db, id, [["in", "มากัน 3 คนค่ะ"], ["out", QUOTE], ["out", DOC_TYPE_QUESTION]]);
  await app.pipeline.handleInboundText({ customerId: id, text: "บุคคลธรรมดาค่ะ", replyToken: "rt" });
  assert.doesNotMatch(sentText(lineFetch), new RegExp(ACCOUNT));
  const row = db.getCustomer(id);
  assert.equal(row.state, "NEEDS_HUMAN");
  assert.match(row.handoff_summary, /payment_step_manual/u);
  assert.equal(notices.filter((n) => n.reason === "payment_step_manual").length, 1);
  assert.ok(audits(db, id).includes("payment_step_pending"));
});

test("การ์ดมีชุดชำระเงิน = โมเดลห้ามพิมพ์บัญชีเอง: ร่างที่มีบล็อกบัญชีถูกแก้/ตัดก่อนส่ง", async (t) => {
  const bankDraft = `AI Agent for Business ค่าเรียน 12,900 บาทค่ะ\n\nสามารถโอนชำระได้ที่บัญชีนี้นะคะ\n\nธนาคาร : กสิกรไทย\nเลขที่บัญชี : ${ACCOUNT}\nชื่อบัญชี : บจก. ตัวอย่าง`;
  const { app, db, lineFetch } = fixture([bankDraft, bankDraft]);
  t.after(() => db.close());
  const id = "U-pay-model-bank";
  const result = await app.pipeline.handleInboundText({ customerId: id, text: "AI Agent for Business ราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  const sent = sentText(lineFetch);
  assert.doesNotMatch(sent, new RegExp(ACCOUNT));
  assert.match(sent, /12,900/u, "คำตอบเรื่องราคายังถึงลูกค้า");
  assert.ok(audits(db, id).includes("payment_model_draft_blocked"));
  assert.notEqual(db.getCustomer(id).deal_status, "awaiting_payment");
});

test("ปิดสวิตช์ payment_step_composer หรือการ์ดไม่มีเลขบัญชี -> เส้นเดิมทุกอย่าง (ไม่ประกอบ ไม่ตัด)", async (t) => {
  for (const variant of ["setting_off", "no_card"]) {
    const { app, db, lineFetch } = fixture(["ขอบคุณค่ะ ทีมงานจะส่งรายละเอียดให้นะคะ"], { card: variant !== "no_card" });
    if (variant === "setting_off") db.setSetting(PAYMENT_STEP_SETTING, "off");
    const id = `U-pay-${variant}`;
    seed(db, id, [["out", QUOTE], ["out", DOC_TYPE_QUESTION]]);
    await app.pipeline.handleInboundText({ customerId: id, text: "บุคคลธรรมดาค่ะ", replyToken: "rt" });
    assert.doesNotMatch(sentText(lineFetch), new RegExp(ACCOUNT), variant);
    assert.match(sentText(lineFetch), /ขอบคุณค่ะ/u, variant);
    assert.ok(!audits(db, id).includes("payment_step_composed"), variant);
    db.close();
  }
  t.diagnostic("composer inactive paths keep the model reply");
});

test("ด่านเงินปิด (SALES_DECISION_GUARD_ENABLED=false) -> ไม่มีตัวประกอบ กติกาเดิมทุกไบต์", async (t) => {
  const { app, db, hermesFetch } = fixture(["ได้เลยค่ะ"], { guard: false });
  t.after(() => db.close());
  const id = "U-pay-guard-off";
  seed(db, id, [["out", QUOTE], ["out", DOC_TYPE_QUESTION]]);
  await app.pipeline.handleInboundText({ customerId: id, text: "บุคคลธรรมดาค่ะ", replyToken: "rt" });
  assert.ok(!audits(db, id).includes("payment_step_composed"));
  const prompt = JSON.stringify(draftCalls(hermesFetch).at(-1)?.body || {});
  assert.doesNotMatch(prompt, /ระบบเป็นผู้ส่งสรุปคลาส/u);
});
