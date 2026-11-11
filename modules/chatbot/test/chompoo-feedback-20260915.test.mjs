import test from "node:test";
import assert from "node:assert/strict";
import { resolveReplyFocus, latestQuestion, learningGoal } from "../src/conversationFocus.mjs";
import { detectAiLevel, resolveClassRouting, buildClassRoutingRules, buildSalesMotionRules } from "../src/salesMotion.mjs";
import { resolveContinuation } from "../src/continuationResolver.mjs";
import { decidePriceDisclosure } from "../src/priceDisclosure.mjs";
import { focusReviewKnowledge, selectReview, parseCatalogText, reviewUrlKey } from "../src/reviewSelection.mjs";
import { baseRules } from "../src/pipeline.mjs";
import { createLifecycle } from "../src/lifecycle.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { createApp } from "../src/server.mjs";
import { memoryDb, testConfig, hermesFetchStub, lineFetchStub, poisonGlobalFetch, promptText } from "./helpers.mjs";
poisonGlobalFetch();
const bot = content => ({ role: "assistant", content });
const user = content => ({ role: "user", content });
const CUSTOM = "เคยใช้ ChatGPT แบบสร้าง AI ของตัวเองหรือยังคะ?";
const LADDER = "เคยใช้ AI มาประมาณระดับไหนแล้วคะ?\n1️⃣ ยังไม่เคยใช้\n2️⃣ เคยลอง\n3️⃣ ช่วยงานจริง\n4️⃣ ใช้ประจำ\n5️⃣ สร้าง Custom AI";
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

test("stage alone cannot force a workflow poster; a real content goal does not become automation", () => {
  const args={currentText:"ขอดูรูปหน่อยค่ะ",history:[user("ระดับ 5 ค่ะ")],approvedImageKeys:new Set(["ai-agent-for-business","ai-agent-workflow-automation"])};
  const ungrounded=baseRules("general",[],args);
  assert.doesNotMatch(ungrounded,/เรื่องที่กำลังคุยกันอยู่: \[IMAGE:ai-agent-workflow-automation\]/);
  const content=baseRules("general",[],{...args,history:[user("ระดับ 5 ค่ะ อยากทำคอนเทนต์")]});
  assert.match(content,/เรื่องที่กำลังคุยกันอยู่: \[IMAGE:ai-agent-for-business\]/);
});

test("delivered review dedupe covers share, reel and watch across the history window", t => {
  const db = memoryDb(); t.after(() => db.close());
  const id = "U-review-dedupe"; db.upsertCustomer(id, {});
  const urls = ["https://www.facebook.com/share/r/test?mibextid=a", "https://web.facebook.com/reel/12345/", "https://www.facebook.com/watch/?v=789"];
  for (const content of urls) db.insertMessage({customerId:id,direction:"out",msgType:"text",content,operator:"system"});
  db.insertMessage({customerId:id,direction:"in",msgType:"text",content:"https://www.facebook.com/reel/99999"});
  for (let i=0;i<20;i++) db.insertMessage({customerId:id,direction:"out",msgType:"text",content:"ข้อความทดสอบ",operator:"system"});
  const sent=db.sentReviewUrls(id);
  assert.equal(sent.size,3);
  for (const url of urls) assert.ok(sent.has(reviewUrlKey(url)));
  assert.equal(selectReview([{section:"Classroom",who:"ผู้เรียนทดสอบ",url:"https://facebook.com/reel/12345?tracking=new"}],{sentUrls:sent}),null);
});

test("lifecycle facts follow only a pending ladder, not custom AI or an already answered ladder", () => {
  for (const [history, value, expected] of [
    [[bot(LADDER), user("3")], "3", "3"],
    [[bot(CUSTOM), user("ยังครับ")], "ยังครับ", null],
    [[bot(LADDER), user("3"), user("ยังครับ")], "ยังครับ", null],
  ]) {
    const facts = [];
    const db = { getSetting: () => "shadow", recentTurns: () => [...history],
      setCustomerFact: data => { facts.push(data); return { written: true }; },
      getLifecycle: () => null };
    createLifecycle({ db, logger: silent }).applyInbound({ customerId: "synthetic", text: value });
    assert.equal(facts.find(f => f.factKey === "ai_level")?.value ?? null, expected);
  }
});

test("latest question controls numbered options, goals and fatigue without resurrecting old goals", () => {
  assert.equal(detectAiLevel("ข้อ 3 ครับ"), null);
  assert.equal(detectAiLevel("ข้อ 3 ครับ", { history: [bot(LADDER)] }), 3);
  assert.equal(learningGoal({ text: "คอนเทนต์ค่ะ", history: [bot("อยากนำ AI ไปช่วยงานอะไรคะ?")] })?.kind, "content");
  assert.equal(learningGoal({ text: "ไม่ต้องการ workflow แล้ว", history: [user("อยากเชื่อมระบบ automation")] }), null);
  const unrelated = buildClassRoutingRules({ text: "ยังครับ", history: [user("ระดับ 4"), bot("ส่งสลิปแล้วหรือยังคะ?")] }).join("\n");
  assert.equal(unrelated, "");
  const fatigue = buildClassRoutingRules({ text: "ไม่ต้องถามแล้ว ราคาเท่าไหร่", history: [user("ระดับ 4")] }).join("\n");
  assert.doesNotMatch(fatigue, /ถามท้ายข้อความ/);
});

test("review identity preserves watch video IDs and rejects an old explicitly declined course", () => {
  assert.notEqual(reviewUrlKey("https://www.facebook.com/watch/?v=123"), reviewUrlKey("https://www.facebook.com/watch/?v=456"));
  const reviews = [
    { section: "Classroom Workflow Automation", who: "ผู้เรียนทดสอบ", url: "https://www.facebook.com/share/r/workflow" },
    { section: "Classroom AI Agent for Business", who: "ผู้เรียนทดสอบ", url: "https://www.facebook.com/share/r/business" },
  ];
  assert.equal(selectReview(reviews, { history: [user("สนใจ Workflow")], text: "ไม่เอา workflow แล้ว ขอรีวิวอื่น" })?.url, reviews[1].url);
});

for (const answer of ["ยังครับ", "ยังค่ะ", "ไม่เคยครับ", "ยังไม่เคยเลยค่ะ", "เคยครับ", "ใช่ค่ะ"]) {
  test(`short answer ${answer}: custom-AI question is not general AI level or a sales decision`, () => {
    const history = [user("มีสาขาไหนอีกไหม"), bot("มีสถานที่เรียนตามข้อมูลที่แจ้งค่ะ"), bot(CUSTOM)];
    const focus = resolveReplyFocus({ text: answer, history });
    assert.equal(focus.kind, "custom_ai_experience");
    assert.equal(detectAiLevel(answer, { history }), null);
    assert.equal(resolveClassRouting({ text: answer, history }).level, null);
    const continuation = resolveContinuation({ latestText: answer, history });
    assert.equal(continuation.action, "answer_previous_question");
    assert.equal(continuation.retrievalText, CUSTOM);
    assert.doesNotMatch(continuation.retrievalText, /สาขา/);
  });
}

test("all ladder choices require the ladder, including emoji digits; latest real answer wins", () => {
  for (let n = 1; n <= 5; n++) {
    for (const text of [`${n}`, `${n}️⃣`, `${n} ค่ะ`]) {
      assert.equal(detectAiLevel(text, { history: [bot(LADDER)] }), n);
      assert.equal(detectAiLevel(text, { history: [bot("สะดวกรอบไหนคะ?")] }), null);
      assert.equal(detectAiLevel(text), null);
    }
  }
  assert.equal(resolveClassRouting({ text: "4", history: [bot(LADDER), user("1"), bot(LADDER)] }).level, 4);
  assert.equal(detectAiLevel("ยังครับ", { history: [bot(LADDER)] }), 1);
});

test("latest question wins, not a historical AI question or a completed pending offer", () => {
  assert.equal(latestQuestion([bot(CUSTOM), user("ยังค่ะ"), bot("สะดวกเรียนรอบไหนคะ?")]).kind, "other");
  assert.equal(resolveReplyFocus({ text: "ยังค่ะ", history: [bot(CUSTOM), user("ตอบแล้วค่ะ")] }).kind, "unresolved_short_answer");
  assert.equal(resolveContinuation({ latestText: "ครับ", history: [bot("ให้ส่งราคาไหมคะ?"), user("ขอเรื่องที่จอดรถแทนครับ")] }).action, "acknowledge_only");
  assert.equal(detectAiLevel("ยังค่ะ", { history: [bot("โอนเงินแล้วหรือยังคะ?")] }), null);
  assert.equal(latestQuestion([bot(CUSTOM + " สะดวกเรียนรอบไหนคะ?")]).kind, "other");
});

test("stage alone does not recommend or close; owing a price still quotes", () => {
  const history = [user("คิดค่าบริการเท่าไหร่"), bot(LADDER)];
  const customer = { last_score: 8, price_deferred_at: 100, price_quoted_at: 0 };
  const priceDisclosure = decidePriceDisclosure({ text: "3", history, customer });
  assert.equal(priceDisclosure.owed, true); assert.equal(priceDisclosure.volunteerPrice, true);
  const classRules = buildClassRoutingRules({ text: "3", history, customer, priceDisclosure }).join("\n");
  assert.match(classRules, /ยังไม่ทราบเป้าหมายงาน/);
  assert.doesNotMatch(classRules, /แนะนำคลาส AI Agent for Business \(คลาสพื้นฐาน\)/);
  const sales = buildSalesMotionRules({ text: "3", history, customer, priceDisclosure, leadScore: 8 }).join("\n");
  assert.doesNotMatch(sales, /พร้อมคุยเรื่องตัดสินใจแล้ว|เลิกสำรวจ/);
  assert.match(baseRules("general", [], { currentText: "3", history, customer, priceDisclosure }), /คำตอบนี้ต้องมีราคา/);
});

test("goals outrank stage: content is not workflow, automation is not inferred proficiency", () => {
  assert.equal(learningGoal({ text: "อยากทำคอนเทนต์ให้ร้านค่ะ" }).kind, "content");
  assert.equal(learningGoal({ text: "อยากเชื่อมระบบลดงานซ้ำค่ะ" }).kind, "automation");
  assert.equal(learningGoal({ text: "ราคาเท่าไหร่" }), null);
  const rules = buildClassRoutingRules({ text: "อยากทำคอนเทนต์ให้ร้านค่ะ", history: [bot(LADDER), user("5")] }).join("\n");
  assert.match(rules, /ไม่ผลักไป Workflow/);
  assert.doesNotMatch(rules, /ห้ามเสนอคลาสพื้นฐาน/);
});

const CATALOG = `[รีวิวนักเรียนจริง]\nวิธีใช้: ใช้เป็นหลักฐานเท่านั้น\n[Classroom : AI Agent for Business]\n- ผู้เรียนหลากหลายธุรกิจ | รีวิว: https://www.facebook.com/share/r/general/\n- พนักงานฝ่ายบัญชี | รีวิว: https://www.facebook.com/reel/accounts/\n[Classroom : AI Agent Workflow Automation]\n- เจ้าของร้านกาแฟ | รีวิว: https://www.facebook.com/share/r/cafe/\n[Private Class : AI Agent Workflow Automation]\n- ทีมงานฝ่ายบัญชี | รีวิว: https://www.facebook.com/share/r/private/\n[ตัวอย่างวิดีโอ บรรยากาศ Classroom : AI Agent for Business]\n- ภาพบรรยากาศ | รีวิว: https://www.facebook.com/share/r/demo/\n[วิดีโอแนะนำพี่ง้วงจากสำนักข่าว]\n- รายการข่าว | รีวิว: https://www.facebook.com/share/v/news/\n[ข้อมูลอื่น]\nสถานที่ที่อนุมัติ`;
const reviews = parseCatalogText(CATALOG);

test("review selection follows latest customer class/format, not a bot pitch", () => {
  const picked = selectReview(reviews, { history: [bot("เสนอ Workflow ค่ะ"), user("สนใจ AI Agent for Business งานบัญชีครับ")] });
  assert.match(picked.url, /accounts/);
  assert.match(selectReview(reviews, { text: "ขอรีวิว Private Workflow ค่ะ" }).url, /private/);
  assert.match(selectReview(reviews, { text: "ขอรีวิว Classroom Workflow ค่ะ" }).url, /cafe/);
});

test("same URL with tracking/trailing slash is one review; don't substitute an unrelated course", () => {
  assert.equal(reviewUrlKey("https://web.facebook.com/share/r/cafe/?mibextid=123"), reviewUrlKey("https://www.facebook.com/share/r/cafe"));
  assert.equal(selectReview(reviews, { text: "Classroom Workflow", sentUrls: new Set(["https://www.facebook.com/share/r/cafe?mibextid=abc"]) }), null);
  assert.equal(reviewUrlKey("https://www.facebook.com.evil.test/share/r/x"), null);
  assert.equal(reviewUrlKey("https://user:password@facebook.com/share/r/x"), null);
});

test("showcase/news cannot be passed off as a testimonial; reactive context keeps at most one item", () => {
  assert.equal(selectReview(reviews.filter(r => r.kind !== "testimonial")), null);
  const focused = focusReviewKnowledge(CATALOG, { text: "ขอรีวิวคลาส AI Agent for Business งานบัญชีค่ะ" });
  assert.equal((focused.match(/\| รีวิว:/g) || []).length, 1);
  assert.match(focused, /accounts/); assert.match(focused, /สถานที่ที่อนุมัติ/);
  for (const context of [{ text: "3", history: [bot(LADDER)] }, { text: "ยังค่ะ", history: [bot(CUSTOM)] }, { text: "ขอรีวิว", closingTurn: true }, { text: "ขอรีวิว", careMode: "pause" }]) {
    assert.equal((focusReviewKnowledge(CATALOG, context).match(/\| รีวิว:/g) || []).length, 0);
  }
});

for (const versioned of [false, true]) for (const question of [CUSTOM, LADDER, "โอนเงินแล้วหรือยังคะ?"]) test(`real pipeline ${versioned ? "versioned" : "legacy"}: bounded focus, no extra model request (${question.slice(0, 15)})`, async t => {
  const db = memoryDb();
  const hermes = hermesFetchStub("เข้าใจแล้วค่ะ อยากนำ AI ไปช่วยงานอะไรเป็นอย่างแรกคะ?");
  const line = lineFetchStub();
  db.addKnowledge({ title: "รีวิวนักเรียนจริง", content: CATALOG, updatedBy: "owner" });
  if (versioned) importCurrentSourcesAsVersion1(db, { logger: silent });
  const app = createApp({ db, config: testConfig({ HISTORY_TURNS: "12", ...(versioned ? { BRAIN_READ: "versioned", KNOWLEDGE_VERSIONED: "true" } : {}) }), overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} }, logger: silent });
  t.after(() => { app.server.close(); db.close(); });
  const id = "synthetic-chompoo-feedback";
  db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "out", content: question, operator: "facebook_page_echo" });
  const answer = question === LADDER ? "3" : "ยังค่ะ";
  db.insertMessage({ customerId: id, direction: "in", content: answer });
  await app.pipeline.handleInboundText({ customerId: id, text: answer, replyToken: "synthetic" });
  assert.equal(hermes.calls.length, 1, "focus/review selection must not create another model call");
  const system = promptText(hermes.calls[0].body.messages.find(m => m.role === "system")?.content);
  assert.match(system, /บริบทคำตอบสั้น/);
  assert.equal((system.match(/\| รีวิว:/g) || []).length, 0);
  assert.doesNotMatch(system, /"suggested_question"/);
  if (question === CUSTOM) { assert.match(system, /custom_ai_experience/); assert.doesNotMatch(system, /ระดับการใช้ AI = 1/); }
  if (question === LADDER) assert.match(system, /ระดับการใช้ AI = 3/);
  assert.ok(line.sends.length > 0, "normal reactive replies remain enabled");
});
