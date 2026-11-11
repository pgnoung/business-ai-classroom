// handoff-closing.test.mjs — เทิร์นส่งไม้ต่อต้องจบด้วยสิ่งที่จะเกิดต่อ ห้ามถามแล้วปิด AI
//
// ที่มา (audit ก.ย. 2026 §6.3 · บัญชีคำติ #4 #43 · fix-spec F13): ลีด in-house ให้ชื่อบริษัท + เบอร์
// ตอนตี 3 วันอาทิตย์ ลูกแพรถาม "สะดวกให้ติดต่อกลับช่วงไหน" แล้ว AI ปิดทันที คำตอบของลูกค้าไม่มีใครรับ
// 19 ชม. — เดือน ก.ย. เทิร์นส่งต่องาน project มีคำถามค้าง 5 ใน 6 ครั้ง
// ข้อความทั้งหมดในไฟล์นี้สังเคราะห์ (บริษัท/เบอร์เป็นค่าตัวอย่าง ไม่ใช่ข้อมูลลูกค้า)
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkProjectPromise, closingStatement, createProjectPromiseWatch, enforceHandoffClosing, isClosingQuestion,
  predictProjectHandoff, projectHandoffClosingRule,
} from "../src/handoffClosing.mjs";
import { baseRules, looksLikeHandoverReply, looksLikeTeamPromise, PROMISE_NOTE_AUTHOR } from "../src/pipeline.mjs";
import { normalizeSalesSignals, validateSalesPolicy } from "../src/salesPolicy.mjs";
import { classifyPriceDirectives, withPriceDirectiveCapture } from "../src/priceDirectives.mjs";
import { detectHandoffHint } from "../src/handoffIntent.mjs";
import { countQuestions } from "../src/replyDeliveryPolicy.mjs";
import { createApp } from "../src/server.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, promptText, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
// โครงเดียวกับ sales-policy.json ของลูกแพร: ถาม 4 ช่องตามลำดับ แต่ส่งต่อทันทีที่ได้อย่างใดอย่างหนึ่ง
const HANDOFF_ANY = ["company_name", "contact_phone", "preferred_contact_time"];
const POLICY = validateSalesPolicy({
  schemaVersion: 1,
  businessId: "pngoung-tidkradum",
  customerJourneys: ["new_lead"],
  decisionRoles: ["owner"],
  courses: [{ id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic"] }],
  opportunities: [
    { type: "in_house_training", requiredSlots: ["business_need", ...HANDOFF_ANY], optionalSlots: ["participant_count"],
      upsize: true, handoffOnComplete: true, handoffSlots: [], handoffAnyOf: HANDOFF_ANY },
    { type: "private_class", requiredSlots: ["business_need", ...HANDOFF_ANY], optionalSlots: [],
      upsize: true, handoffOnComplete: true, handoffSlots: [], handoffAnyOf: HANDOFF_ANY },
  ],
});
const collecting = normalizeSalesSignals({}, POLICY, null, { latestCustomerText: "สนใจจัดอบรม in-house ให้ทีมขายค่ะ" });
// ไม่มีคำถามเหลือ = ไม่มีเครื่องหมายคำถาม ไม่มีรูปคำถามที่ตัวนับของ delivery policy รู้จัก และไม่มีบรรทัดที่ลงท้ายแบบคำถาม
const noQuestions = (texts) => texts.every((text) => countQuestions(text) === 0 && !/[?？]/u.test(text)
  && text.split(/\n+/u).every((line) => !isClosingQuestion(line)));

/* --------------------------------- ตัวจับคำถาม --------------------------------- */

test("ตัวจับคำถามของเทิร์นปิดท้าย: คำถามไทยทุกทรงที่เจอ vs ประโยคบอกเล่า", () => {
  for (const question of [
    "คุณลูกค้าสะดวกให้ทีมผู้ดูแลติดต่อกลับช่วงวันและเวลาใดคะ?",
    "สะดวกให้ติดต่อกลับช่วงเช้าหรือบ่ายคะ",
    "ขอเบอร์โทรสำหรับให้ทีมติดต่อกลับได้ไหมคะ",
    "เบอร์ไหนสะดวกที่สุดคะ 😊",
  ]) assert.equal(isClosingQuestion(question), true, question);
  for (const statement of [
    "ทีมงานผู้ดูแลโดยตรงจะติดต่อกลับตามเบอร์ที่ให้ไว้นะคะ",
    "ขอบคุณค่ะ",
    "ระหว่างนี้ฝากรายละเอียดไว้ในแชทนี้ได้ตลอดเลยค่ะ 🙏🏻",
    "รับทราบค่ะ ทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้ในแชทนี้นะคะ",
  ]) assert.equal(isClosingQuestion(statement), false, statement);
});

/* ------------------------------- ด่านก่อนส่ง ------------------------------- */

test("งาน project: คำถามในเทิร์นส่งต่อถูกตัด และเติมประโยคขั้นถัดไปเมื่อไม่มี", () => {
  const draft = [
    { text: "รับทราบค่ะ บริษัทตัวอย่าง 😊 ทีมผู้ดูแลจะออกแบบรายละเอียดให้แต่ละฝ่ายได้ตรงบริบทค่ะ", pauseSec: 1 },
    { text: "คุณลูกค้าสะดวกให้ทีมผู้ดูแลติดต่อกลับช่วงวันและเวลาใดคะ?", pauseSec: 1 },
  ];
  const closed = enforceHandoffClosing(draft, { kind: "project", phoneKnown: true });
  assert.equal(closed.changed, true);
  assert.equal(closed.removed, 1);
  const texts = closed.bubbles.map((bubble) => bubble.text);
  assert.ok(noQuestions(texts), `ต้องไม่เหลือคำถาม: ${texts.join(" | ")}`);
  assert.ok(texts.at(-1).endsWith(closingStatement("project", { phoneKnown: true })), "ปิดท้ายด้วยขั้นถัดไป");
  assert.match(texts.at(-1), /ติดต่อกลับตามเบอร์ที่ให้ไว้/u);
  assert.match(texts.at(-1), /ฝากไว้ในแชทนี้ได้ตลอด/u);
  assert.equal(closed.bubbles.length, 1, "ไม่เพิ่มบอลลูนใหม่เกินเพดาน — ต่อท้ายบอลลูนสุดท้าย");
});

test("ไม่มีเบอร์: ขั้นถัดไปบอกว่าทีมงานติดต่อกลับในแชทนี้ · ไม่มีอะไรเหลือ = ประโยคมาตรฐานบอลลูนเดียว", () => {
  const closed = enforceHandoffClosing([{ text: "ขอเบอร์โทรสำหรับให้ทีมติดต่อกลับได้ไหมคะ?", pauseSec: 1 }], { kind: "project" });
  assert.equal(closed.bubbles.length, 1);
  assert.equal(closed.bubbles[0].text, closingStatement("project", { phoneKnown: false }));
  assert.match(closed.bubbles[0].text, /ติดต่อกลับในแชทนี้/u);
});

test("จอง/ติดต่อทีมงาน: ตัดคำถามที่ค้างก่อนประโยคส่งไม้ต่อ ไม่เติมซ้ำ และกุญแจดอกที่ 2 คงผลเดิม", () => {
  const draft = [
    { text: "ได้เลยค่ะ ขอบคุณที่ไว้วางใจนะคะ สะดวกเรียนรอบเช้าหรือบ่ายคะ", pauseSec: 1 },
    { text: "ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ", pauseSec: 1 },
  ];
  assert.equal(looksLikeHandoverReply(draft), true, "ของเดิม: ห้องนี้ปิดทั้งที่มีคำถามค้าง");
  const closed = enforceHandoffClosing(draft, { kind: "booking" });
  assert.equal(closed.appended, false, "มีประโยคขั้นถัดไปอยู่แล้ว ห้ามเติมซ้ำ");
  assert.deepEqual(closed.bubbles.map((bubble) => bubble.text), [
    "ได้เลยค่ะ ขอบคุณที่ไว้วางใจนะคะ",
    "ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ",
  ]);
  assert.equal(looksLikeHandoverReply(closed.bubbles), true, "การตัดคำถามต้องไม่เปลี่ยนคำตัดสินปิดห้อง");
});

test("ข้อความปิดท้ายที่ไม่มีคำถาม ผ่านไปทุกไบต์ (ไม่เขียนใหม่ ไม่เติม)", () => {
  const draft = [{ text: "ลูกแพรส่งเรื่องให้ทีมงานคนจริงเข้ามาดูแลต่อในแชทนี้แล้วนะคะ 🙏🏻", pauseSec: 2 }];
  const closed = enforceHandoffClosing(draft, { kind: "contact_team" });
  assert.equal(closed.changed, false);
  assert.equal(closed.bubbles[0], draft[0]);
});

/* ---------------------------- ตัวทำนายเทิร์นส่งต่อ ---------------------------- */

test("ทำนายเทิร์นส่งต่องาน project ด้วยตัวสกัด slot ชุดเดียวกับ scorer", () => {
  assert.deepEqual(predictProjectHandoff({ salesPolicy: POLICY, salesState: collecting, text: "บริษัท ตัวอย่าง จำกัด เบอร์ 0812345678 ค่ะ" }),
    { type: "in_house_training", phoneKnown: true });
  assert.deepEqual(predictProjectHandoff({ salesPolicy: POLICY, salesState: collecting, text: "ชื่อบริษัท ตัวอย่างการค้า ค่ะ" }),
    { type: "in_house_training", phoneKnown: false }, "นโยบาย handoffAnyOf: อย่างใดอย่างหนึ่งก็ส่งต่อ");
  assert.equal(predictProjectHandoff({ salesPolicy: POLICY, salesState: collecting, text: "อยากให้ทีมขายตอบแชทเร็วขึ้นค่ะ" }), null);
  assert.deepEqual(predictProjectHandoff({ salesPolicy: POLICY, salesState: null, text: "อยากจัดอบรม AI ให้พนักงานที่บริษัท 20 คน ติดต่อ 0812345678 ค่ะ" }),
    { type: "in_house_training", phoneKnown: true }, "ข้อความแรกที่มีทั้งงานและเบอร์");
  assert.equal(predictProjectHandoff({ salesPolicy: null, salesState: null, text: "0812345678" }), null);
  assert.equal(predictProjectHandoff({ salesPolicy: POLICY, salesState: null, text: "เบอร์ 0812345678 ค่ะ" }), null, "ไม่มีงาน project = ไม่ใช่เทิร์นส่งต่อ");
});

// บทเรียน 13e233152 (3 ก.ย.): ตัวทำนายรุ่นแรกตอบ "ไม่" กับชื่อบริษัทแบบเปล่า ซึ่ง scorer ส่งต่อจริง
// (เคสจริง ก.ย.: ลูกค้าตอบชื่อบริษัทแบบไม่มีคำว่า "จำกัด") — คำตอบสั้นต่อคำถามขอชื่อบริษัทต้องนับ
test("คำตอบสั้นต่อคำถามขอชื่อบริษัท: ทำนายตามขอบบนของ scorer · คำตอบของคำถามอื่นไม่นับ", () => {
  const askedCompany = [{ role: "assistant", content: "ขอทราบชื่อบริษัทหรือแบรนด์เพื่อให้ทีมผู้ดูแลเตรียมข้อมูลได้ไหมคะ?" }];
  const askedScope = [{ role: "assistant", content: "อยากจัดให้ทั้งองค์กรหรือเฉพาะบางทีมคะ?" }];
  const bare = "บริษัท ตัวอย่างการค้า ค่ะ";
  assert.equal(predictProjectHandoff({ salesPolicy: POLICY, salesState: collecting, text: bare }), null, "ตัวสกัด deterministic ไม่มีคำจุดชนวน");
  assert.deepEqual(predictProjectHandoff({ salesPolicy: POLICY, salesState: collecting, text: bare, history: askedCompany }),
    { type: "in_house_training", phoneKnown: false });
  assert.equal(predictProjectHandoff({ salesPolicy: POLICY, salesState: collecting, text: "ทั้งองค์กรค่ะ", history: askedScope }), null);
  assert.equal(predictProjectHandoff({ salesPolicy: POLICY, salesState: collecting, text: "บริษัทอยู่ที่ไหนคะ", history: askedCompany }), null,
    "ลูกค้าถามกลับ ไม่ใช่คำตอบ");
  assert.equal(predictProjectHandoff({ salesPolicy: POLICY, salesState: collecting, history: askedCompany,
    text: "บริษัทเราอยากให้ทีมขายทุกคนใช้ AI ช่วยตอบแชทและทำรายงานสรุปยอดขายรายสัปดาห์ให้ผู้บริหารดูค่ะ" }), null,
    "ย่อหน้าเล่าโจทย์ยาว ๆ ไม่ใช่คำตอบชื่อบริษัท");
});

/* ------------------------------------ พรอมต์ ------------------------------------ */

test("พรอมต์เทิร์นส่งต่องาน project: ไม่สั่งเก็บข้อมูลต่อ ไม่สั่งถาม slot ปิดด้วยขั้นถัดไป และเงียบเรื่องราคา", () => {
  const args = { currentText: "บริษัท ตัวอย่าง จำกัด เบอร์ 0812345678 ค่ะ", history: [], salesPolicy: POLICY, salesState: collecting,
    approvedImageKeys: new Set(["ai-stage-ladder"]) };
  const captured = withPriceDirectiveCapture(() => baseRules("general", [], args));
  const prompt = captured.text;
  assert.doesNotMatch(prompt, /เก็บข้อมูลทีละหนึ่งคำถามต่อเทิร์น/u);
  assert.doesNotMatch(prompt, /Ask at most one missing qualification slot/u);
  assert.doesNotMatch(prompt, /แนบรูปบันได 7 Stage/u);
  assert.ok(prompt.includes(projectHandoffClosingRule({ phoneKnown: true })), "ต้องมีบรรทัดปิดท้ายของเทิร์นนี้");
  const { bySide, unclassified } = classifyPriceDirectives(captured);
  assert.deepEqual([bySide.quote, bySide.defer, unclassified], [[], [], []], "ลูกค้าไม่ได้ถามเรื่องเงิน = ไม่มีคำสั่งเรื่องราคาข้างไหนเลย");
});

test("พรอมต์ระหว่างเก็บข้อมูล (ยังไม่ส่งต่อ) เหมือนเดิม: ยังเก็บทีละคำถาม ไม่มีบรรทัดปิดท้าย", () => {
  const prompt = baseRules("general", [], { currentText: "อยากให้ทีมขายตอบแชทเร็วขึ้นค่ะ", history: [], salesPolicy: POLICY, salesState: collecting });
  assert.match(prompt, /เก็บข้อมูลทีละหนึ่งคำถามต่อเทิร์น/u);
  assert.match(prompt, /Ask at most one missing qualification slot/u);
  assert.doesNotMatch(prompt, /ข้อความนี้คือข้อความสุดท้ายของลูกแพร/u);
});

test("พรอมต์จอง/ติดต่อทีมงาน: ห้ามถามเฉพาะเมื่อส่งไม้ต่อ (มีเงื่อนไข ไม่ใช่คำสั่งสวนทาง)", () => {
  for (const hint of [detectHandoffHint("ขอจองไว้ก่อนค่ะ"), detectHandoffHint("ขอเบอร์ทีมงานหน่อยค่ะ")]) {
    const prompt = baseRules("general", [], { currentText: hint.matched, history: [], handoffIntent: hint });
    assert.match(prompt, /ถ้าส่งไม้ต่อด้วยประโยคข้างบน ข้อความนั้นต้องไม่มีคำถามเหลืออยู่เลย/u);
    assert.doesNotMatch(prompt, /ห้ามปิดท้ายด้วยคำถามใด ๆ/u, "คำสั่งสวนทางแบบไม่มีเงื่อนไขทำให้กุญแจดอกที่ 2 ไม่เป็นอิสระ");
  }
});

/* ---------------------------------- ไปป์ไลน์จริง ---------------------------------- */

function makeApp(reply) {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-12900", 12900);
  const hermesFetch = hermesFetchStub(reply);
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {}, salesPolicy: POLICY },
    logger: silent,
  });
  return { app, db, hermesFetch };
}
const sentTexts = (db, customerId) => db.messagesFor(customerId, 30)
  .filter((row) => row.direction === "out" && row.msg_type === "text").map((row) => row.content);

test("ไปป์ไลน์ in-house: โมเดลถามช่วงเวลาในเทิร์นส่งต่อ -> ลูกค้าได้ขั้นถัดไป ไม่มีคำถามค้าง", async (t) => {
  const { app, db, hermesFetch } = makeApp("รับทราบค่ะ ทีมผู้ดูแลจะออกแบบการอบรมให้ตรงกับทีมของคุณลูกค้าค่ะ 😊\n\nสะดวกให้ทีมผู้ดูแลติดต่อกลับช่วงวันและเวลาใดคะ?");
  t.after(() => db.close());
  const customerId = "U-inhouse-closing";
  const result = await app.pipeline.handleInboundText({
    customerId, text: "อยากจัดอบรม AI ให้พนักงานที่บริษัท 20 คน ติดต่อ 0812345678 ค่ะ", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(system, /ข้อความนี้คือข้อความสุดท้ายของลูกแพร/u, "พรอมต์ต้องรู้ว่าเทิร์นนี้ส่งต่อ");
  const texts = sentTexts(db, customerId);
  assert.ok(noQuestions(texts), `ลูกค้าต้องไม่ได้คำถามที่ไม่มีใครตอบ: ${texts.join(" | ")}`);
  assert.match(texts.join("\n"), /ติดต่อกลับตามเบอร์ที่ให้ไว้/u);
  assert.ok(db.listAudit(50).some((row) => row.action === "handoff_closing_repaired" && row.target === customerId));
  // บทเรียน 13e233152: ทำนาย "ใช่" ผิด (ในเทสต์นี้ scorer ไม่ได้ส่งต่อจริง) ต้องไม่ทิ้งลูกค้าไว้โดยไม่มีใบงาน —
  // ตาข่ายคำรับปากยังจับ "ทีมงาน…จะติดต่อกลับ" ได้เสมอ (ห้ามปิดตาข่ายนี้ในเทิร์นปิด)
  assert.ok(db.listAudit(50).some((row) => row.action === "promise_team_followup" && row.target === customerId),
    "ตาข่ายคำรับปากต้องยังทำงานในเทิร์นส่งต่อ");
});

test("ไปป์ไลน์จอง: คำถามก่อนประโยคส่งไม้ต่อถูกตัด แล้วห้องยังปิดตามกุญแจสองดอกเหมือนเดิม", async (t) => {
  const { app, db } = makeApp("ได้เลยค่ะ ขอบคุณที่ไว้วางใจนะคะ สะดวกเรียนรอบเช้าหรือบ่ายคะ\n\nทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ");
  t.after(() => db.close());
  const customerId = "U-booking-closing";
  const result = await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  const texts = sentTexts(db, customerId);
  assert.ok(noQuestions(texts), texts.join(" | "));
  assert.ok(!texts.join("\n").includes("สะดวกเรียนรอบเช้าหรือบ่ายคะ"), "คำถามที่ค้างก่อนปิดห้องต้องถูกตัด");
  assert.match(texts.join("\n"), /ทีมงาน \(คุณชมพู่\) จะติดต่อกลับในแชทนี้/u);
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 0, "ใคร/เมื่อไหร่ส่งต่อไม่เปลี่ยน: ห้องยังปิดเหมือนเดิม");
  assert.equal(customer.ai_off_reason, "booking_handoff");
});

test("ไปป์ไลน์จอง: ลูกแพรยังถามต่อ (ไม่ได้ส่งไม้ต่อ) -> ไม่ถูกแตะ ห้องยังเปิด", async (t) => {
  const { app, db } = makeApp("ได้เลยค่ะ ตอนนี้เปิดสองรอบนะคะ สนใจรอบไหนดีคะ");
  t.after(() => db.close());
  const customerId = "U-booking-open";
  await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt" });
  assert.match(sentTexts(db, customerId).join("\n"), /สนใจรอบไหนดีคะ/u, "คำถามที่ลูกแพรตั้งใจถามคงอยู่");
  assert.equal(db.getCustomer(customerId).ai_enabled, 1);
  assert.ok(!db.listAudit(50).some((row) => row.action === "handoff_closing_repaired"));
});

/* ------------------- ตาข่ายหลังเทิร์นส่งต่องาน project (eval จริง 28 ก.ย.) ------------------- */

// ถ้อยคำจริงจาก eval กับสมองจริง: "ทีมงานผู้ดูแล In-house Training โดยตรงจะติดต่อกลับ…" ห่างเกินที่ตาข่ายคำรับปาก
// เดิมจับได้ — ถ้า scorer ไม่ส่งต่อ (ล้ม/ตัดสินไม่ตรง) ลูกค้ารอสายที่ไม่มีใครรู้ว่าต้องโทร
const MODEL_OWN_CLOSING = "รับทราบค่ะ ขอบคุณสำหรับข้อมูลนะคะ 😊\nทีมงานผู้ดูแล In-house Training โดยตรงจะติดต่อกลับตามเบอร์ที่ให้ไว้ "
  + "เพื่อออกแบบรายละเอียดให้เหมาะกับทีม 20 ท่านค่ะ ระหว่างนี้ฝากรายละเอียดเพิ่มเติมไว้ในแชทนี้ได้ตลอดนะคะ";
const IN_HOUSE_WITH_PHONE = "อยากจัดอบรม AI ให้พนักงานที่บริษัท 20 คน ติดต่อ 0812345678 ค่ะ";
const promiseAudits = (db, customerId) => db.listAudit(100)
  .filter((row) => row.target === customerId && row.action === "promise_team_followup");
const promiseNotes = (db, customerId) => db.listHandoffNotes(customerId, 20).filter((note) => note.author === PROMISE_NOTE_AUTHOR);

test("ตาข่าย project: scorer ไม่ส่งต่อ + ถ้อยคำหลุดตัวจับเดิม -> โน้ต + audit + push หลัง scorer จบ", async (t) => {
  assert.equal(looksLikeTeamPromise(MODEL_OWN_CLOSING), false, "ยืนยันช่องโหว่ของตัวจับคำรับปากเดิม");
  const { app, db } = makeApp(MODEL_OWN_CLOSING);
  t.after(() => db.close());
  const customerId = "U-project-backstop";
  const result = await app.pipeline.handleInboundText({ customerId, text: IN_HOUSE_WITH_PHONE, replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.equal(promiseAudits(db, customerId).length, 0, "ยังไม่ตัดสินก่อน scorer จบ");
  await app.pipeline.scoreBurst(customerId); // stub ตอบข้อความแทน JSON = scorer ล้ม ไม่มีการส่งต่อ
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.getCustomer(customerId).state, "AI_ACTIVE", "scorer ไม่ได้ส่งต่อ");
  assert.equal(promiseAudits(db, customerId).length, 1, "ต้องมีคนรู้ว่าต้องติดต่อกลับ");
  assert.equal(promiseNotes(db, customerId).length, 1);
  await app.pipeline.scoreBurst(customerId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promiseAudits(db, customerId).length, 1, "เตือนครั้งเดียวต่อเทิร์นส่งต่อ");
});

test("ตาข่าย project: ตาข่ายคำรับปากเดิมจับได้แล้ว -> ไม่เตือนซ้ำ", async (t) => {
  const canonical = `รับทราบค่ะ ขอบคุณสำหรับข้อมูลนะคะ 😊\n${closingStatement("project", { phoneKnown: true })}`;
  assert.equal(looksLikeTeamPromise(canonical), true);
  const { app, db } = makeApp(canonical);
  t.after(() => db.close());
  const customerId = "U-project-noted";
  await app.pipeline.handleInboundText({ customerId, text: IN_HOUSE_WITH_PHONE, replyToken: "rt" });
  await app.pipeline.scoreBurst(customerId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promiseAudits(db, customerId).length, 1);
  assert.equal(promiseNotes(db, customerId).length, 1);
});

test("ตาข่าย project: เทิร์นปกติ (ไม่ใช่ส่งต่อ) ไม่ถูกตั้งตาข่าย", async (t) => {
  const { app, db } = makeApp("ยินดีค่ะ ทีมกี่ท่านคะ?");
  t.after(() => db.close());
  const customerId = "U-project-collecting";
  await app.pipeline.handleInboundText({ customerId, text: "สนใจจัดอบรม in-house ให้ทีมขายค่ะ", replyToken: "rt" });
  await app.pipeline.scoreBurst(customerId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promiseAudits(db, customerId).length, 0);
});

test("checkProjectPromise: ส่งต่อแล้ว / AI ปิด / มีโน้ตแล้ว = เงียบ · ที่เหลือ = โน้ต + audit + push", () => {
  const db = memoryDb();
  const pushes = [];
  const notifier = { fireLater: (payload) => pushes.push(payload) };
  const since = Date.now() - 1_000;
  db.upsertCustomer("U-handed", {});
  db.setNeedsHuman("U-handed", "opportunity_handoff", "ส่งต่อแล้ว");
  assert.equal(checkProjectPromise({ db, notifier, customerId: "U-handed", since, logger: silent }).skipped, "handed_off");
  db.upsertCustomer("U-off", {});
  db.setAiEnabled("U-off", false, "handoff_private_inhouse");
  assert.equal(checkProjectPromise({ db, notifier, customerId: "U-off", since, logger: silent }).skipped, "handed_off");
  db.upsertCustomer("U-noted", {});
  db.addHandoffNote({ customerId: "U-noted", author: PROMISE_NOTE_AUTHOR, text: "ตาข่ายเดิมจับได้แล้ว" });
  assert.equal(checkProjectPromise({ db, notifier, customerId: "U-noted", since, noteAuthor: PROMISE_NOTE_AUTHOR, logger: silent }).skipped,
    "already_noted");
  assert.equal(pushes.length, 0);
  db.upsertCustomer("U-alert", { displayName: "ลูกค้าสังเคราะห์" });
  assert.equal(checkProjectPromise({ db, notifier, customerId: "U-alert", since, noteAuthor: PROMISE_NOTE_AUTHOR, logger: silent }).alerted, true);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].reason, "promise_team_followup");
  assert.equal(promiseNotes(db, "U-alert").length, 1);
  db.close();
});

test("createProjectPromiseWatch: รอบ scorer ที่ค้างมาก่อนเทิร์นส่งต่อไม่นับ · ตรวจครั้งเดียว", () => {
  let clock = 10_000;
  const db = memoryDb({ now: () => clock });
  const watch = createProjectPromiseWatch({ db, notifier: null, logger: silent, now: () => clock });
  db.upsertCustomer("U-watch", {});
  watch.mark("U-watch", 9_000);
  assert.equal(watch.settle("U-watch", 9_500).skipped, "not_due", "รอบที่เริ่มก่อน mark ไม่ได้อ่านเทิร์นนี้");
  assert.equal(watch.size, 1);
  clock = 12_000;
  assert.equal(watch.settle("U-watch", 10_000).alerted, true);
  assert.equal(watch.size, 0);
  assert.equal(watch.settle("U-watch", 12_000).skipped, "not_due", "ตรวจแล้วไม่ตรวจซ้ำ");
  db.close();
});
