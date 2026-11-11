// G2a Sales Intelligence — F1 profile fetch, F2 ชื่อจริง, F3 scorer, F4 จบด้วยคำถาม,
// F7 โควตา LINE + migration idempotency (ทุกอย่าง mock — ห้ามแตะ network จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/server.mjs";
import { openDb } from "../src/db.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { extractKnownName } from "../src/customerName.mjs";
import { REPLY_CLOSING_QUESTION_KEY } from "../src/replyClosingQuestion.mjs";
import {
  PERSONA_TYPES, buildScorerSystem, parseScorePayload, bubbleHasQuestion,
} from "../src/scoring.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  signLine, httpRequest, listen, waitFor, sleep, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const LINE_SECRET = "test-line-secret";

function makeApp({ configOverrides = {}, hermesFetch, lineFetch, approved = [2500] } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  for (const amount of approved) db.setApprovedPrice(`ราคา-${amount}`, amount);
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetch ?? lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} },
    logger: silent,
  });
  return { app, db, config, hermesFetch: hermes, lineFetch: line };
}

// stub Hermes สองบท: call ปกติ = draft reply / call ที่ system เป็น scorer = ตอบ JSON
function dualHermesStub({ reply = "ขอบคุณที่สนใจนะคะ ใช้ในห้องกี่ตารางเมตรคะ", scorer = "" } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const system = body.messages?.[0]?.role === "system" ? promptText(body.messages[0].content) : "";
    const isScorer = system.includes("ระบบวิเคราะห์ความสนใจซื้อ");
    calls.push({ url: String(url), body, isScorer });
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: isScorer ? scorer : reply } }] }),
    };
  };
  fn.calls = calls;
  fn.scorerCalls = () => calls.filter((c) => c.isScorer);
  fn.draftCalls = () => calls.filter((c) => !c.isScorer);
  return fn;
}

function webhookBody(messageId, { userId = "Uprof", text = "สนใจเครื่องฟอกอากาศค่ะ" } = {}) {
  return JSON.stringify({
    events: [{
      type: "message", webhookEventId: `w-${messageId}`, replyToken: `rt-${messageId}`,
      source: { type: "user", userId },
      message: { id: messageId, type: "text", text },
    }],
  });
}

async function postWebhook(server, raw) {
  return httpRequest(server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, LINE_SECRET) },
    body: raw,
  });
}

/* --------------------------------- F1: profile ----------------------------- */

test("F1: webhook ลูกค้าใหม่ -> ดึงโปรไฟล์ LINE เก็บ display_name + picture_url", async (t) => {
  const lineFetch = lineFetchStub({ profile: { displayName: "คุณโบว์", pictureUrl: "https://line.mock/p.jpg" } });
  const { app, db } = makeApp({ lineFetch });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const res = await postWebhook(app.server, webhookBody("m-prof-1"));
  assert.equal(res.status, 200);
  await waitFor(() => db.getCustomer("Uprof")?.display_name === "คุณโบว์");
  const customer = db.getCustomer("Uprof");
  assert.equal(customer.picture_url, "https://line.mock/p.jpg");
  assert.equal(lineFetch.profileCalls.length, 1);
  assert.ok(lineFetch.profileCalls[0].url.includes("/v2/bot/profile/Uprof"));
});

test("F1: โปรไฟล์ล้มเหลว (404) -> fallback ค่าว่างเดิม, reply ยังออกปกติ", async (t) => {
  const lineFetch = lineFetchStub(); // profile default = 404
  const { app, db } = makeApp({ lineFetch });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  await postWebhook(app.server, webhookBody("m-prof-2", { userId: "Ufail" }));
  await waitFor(() => lineFetch.sends.length >= 1);
  await sleep(30);
  assert.equal(db.getCustomer("Ufail").display_name, "", "โปรไฟล์พัง = คงค่าว่าง ใช้ fallback ฝั่ง UI");
});

test("F1: ลูกค้ามี display_name แล้ว -> ไม่ยิงโปรไฟล์ซ้ำ", async (t) => {
  const lineFetch = lineFetchStub({ profile: { displayName: "ชื่อใหม่" } });
  const { app, db } = makeApp({ lineFetch });
  db.upsertCustomer("Uknown", { displayName: "คุณเดิม" });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  await postWebhook(app.server, webhookBody("m-prof-3", { userId: "Uknown" }));
  await waitFor(() => lineFetch.sends.length >= 1);
  await sleep(30);
  assert.equal(lineFetch.profileCalls.length, 0, "มีชื่อแล้วห้ามยิงโปรไฟล์");
  assert.equal(db.getCustomer("Uknown").display_name, "คุณเดิม");
});

test("F1: fail-closed — ไม่มี mock + live send ปิด -> getProfile คืน null โดยไม่ fetch", async () => {
  let fetchCount = 0;
  const config = testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "false" });
  const line = createLineClient({
    config,
    fetchImpl: async () => { fetchCount += 1; return { ok: true, json: async () => ({}) }; },
    logger: silent,
  });
  assert.equal(await line.getProfile({ userId: "U1" }), null);
  assert.equal(fetchCount, 0, "fail-closed: ห้ามยิง LINE จริง");
});

/* ------------------------------ F2: known name ----------------------------- */

test("F2: extractKnownName จับรูปประโยคบอกชื่อภาษาไทย", () => {
  assert.equal(extractKnownName("ผมชื่อเบียร์ครับ"), "เบียร์");
  assert.equal(extractKnownName("ดิฉันชื่อ มะปราง ค่ะ"), "มะปราง");
  assert.equal(extractKnownName("ชื่อโบว์ค่ะ สนใจ X3Pro"), "โบว์");
  assert.equal(extractKnownName("เราชื่อว่าแนนนะคะ"), "แนน");
  assert.equal(extractKnownName("เรียกบีก็ได้"), "บี");
  assert.equal(extractKnownName("ผมชื่อเบียร์นะครับสนใจX5"), "เบียร์");
});

test("F2: extractKnownName ไม่จับคำถาม/ชื่อสินค้า (conservative)", () => {
  assert.equal(extractKnownName("ชื่ออะไรคะ"), "");
  assert.equal(extractKnownName("ชื่อรุ่นไหนดีคะ"), "");
  assert.equal(extractKnownName("ราคาเท่าไหร่คะ"), "");
  assert.equal(extractKnownName("สวัสดีค่ะ สนใจเครื่องฟอก"), "");
  assert.equal(extractKnownName(""), "");
  assert.equal(extractKnownName("เรียกเก็บเงินปลายทางได้ไหม"), "", "เรียกเก็บเงิน ไม่ใช่การบอกชื่อ");
});

test("F2: pipeline บันทึกชื่ออัตโนมัติ + inject บริบทชื่อเข้า prompt", async (t) => {
  const hermesFetch = dualHermesStub({});
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());

  const result = await app.pipeline.handleInboundText({
    customerId: "U-name", text: "ผมชื่อเบียร์ครับ สนใจเครื่องฟอกอากาศ", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  assert.equal(db.getCustomer("U-name").known_name, "เบียร์");

  const system = promptText(hermesFetch.draftCalls()[0].body.messages[0].content);
  assert.ok(system.includes('ชื่อที่ใช้เรียกลูกค้าคนนี้คือ "คุณเบียร์"'), "ชื่อที่ลูกค้าบอกเองต้องมาก่อนเสมอ");
  assert.ok(system.includes("ต้องเรียกชื่อลูกค้าในจังหวะทักทาย"), "ต้องระบุจังหวะที่บังคับให้เรียกชื่อ");
  assert.ok(system.includes("ไม่ต้องเรียกซ้ำ"), "จังหวะอื่นไม่ต้องเรียกซ้ำ");
});

// v1.2.3 (คำสั่งพี่ง้วง 2026-08-12): ใช้ชื่อโปรไฟล์ LINE เรียกลูกค้าได้ แต่ต้องถอด emoji
// และผ่านตัวกรอง "ดูเหมือนชื่อคน" ก่อน — ชื่อร้าน/คำกลอน/เบอร์ ต้องกลายเป็น "คุณลูกค้า"
test("F2: ชื่อโปรไฟล์ LINE ที่ดูเหมือนชื่อคนใช้เรียกลูกค้าได้ หลังถอดของตกแต่งออก", async (t) => {
  const hermesFetch = dualHermesStub({});
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());
  db.upsertCustomer("U-disp", { displayName: "🌸 ปุ๊กกี้ 🌸" });

  await app.pipeline.handleInboundText({ customerId: "U-disp", text: "สนใจ X3Pro ค่ะ", replyToken: "rt" });
  const system = promptText(hermesFetch.draftCalls()[0].body.messages[0].content);
  assert.ok(system.includes('ชื่อที่ใช้เรียกลูกค้าคนนี้คือ "คุณปุ๊กกี้"'), "ต้องถอด emoji แล้วเรียกด้วยชื่อจริง");
  assert.ok(system.includes("ข้อความแรกที่ทักกลับต้องมีชื่อนี้อยู่ด้วยเสมอ"), "เทิร์นแรกต้องบังคับเรียกชื่อ");
  assert.ok(!system.includes("🌸"), "ของตกแต่งห้ามหลุดเข้า prompt");
});

test("F2: ชื่อโปรไฟล์ที่ไม่ใช่ชื่อคนต้องกลายเป็น คุณลูกค้า", async (t) => {
  const hermesFetch = dualHermesStub({});
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());
  db.upsertCustomer("U-shop", { displayName: "ร้านขายของชำลุงหมี" });

  await app.pipeline.handleInboundText({ customerId: "U-shop", text: "สนใจ X3Pro ค่ะ", replyToken: "rt" });
  const system = promptText(hermesFetch.draftCalls()[0].body.messages[0].content);
  assert.match(system, /ยังไม่มีชื่อที่ใช้เรียกลูกค้าคนนี้ได้/u);
  assert.ok(!system.includes("ลุงหมี"), "ชื่อร้านห้ามถูกเอาไปเรียกลูกค้า");
});

/* -------------------------------- F3: scorer ------------------------------- */

const GOOD_SCORER_JSON = JSON.stringify({
  score: 7, trend: "up", buying_signals: ["ถามราคา", "ถามการติดตั้ง"],
  persona_read: { disc: "C", bank: "Knowledge", reason: "ถามสเปกละเอียดทุกข้อ" },
  next_move: "ส่งตารางเปรียบเทียบรุ่นพร้อมข้อมูลการกรอง แล้วถามขนาดห้องเพื่อสรุปรุ่น",
  suggested_question: "ห้องที่จะวางเครื่องกี่ตารางเมตรคะ",
});

test("F3: scorer JSON ดี -> เก็บ score_history + last_score (หลัง reply ออกแล้ว)", async (t) => {
  const hermesFetch = dualHermesStub({ scorer: GOOD_SCORER_JSON });
  const { app, db, lineFetch } = makeApp({ hermesFetch });
  db.setSetting("scorer_suggestions_enabled", "1"); // This scenario explicitly requests optional advice.
  t.after(() => db.close());

  // จำลองชั้น webhook: log inbound ก่อนเสมอ (scorer ต้องเห็นบทลูกค้าใน transcript)
  db.upsertCustomer("U-score", {});
  db.insertMessage({ customerId: "U-score", direction: "in", content: "X5Pro ติดตั้งยังไงคะ ราคาเท่าไหร่" });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-score", text: "X5Pro ติดตั้งยังไงคะ ราคาเท่าไหร่", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  assert.equal(lineFetch.sends.length, 1, "reply ต้องออกก่อน ไม่รอ scorer");
  // fire-and-forget: ตอนนี้ยังไม่มี score (scorer เป็น macrotask หลัง reply เสมอ)
  assert.equal(db.getCustomer("U-score").last_score, null);

  await waitFor(() => db.getCustomer("U-score").last_score === 7);
  const row = db.latestScoreRow("U-score");
  assert.equal(row.score, 7);
  const payload = JSON.parse(row.payload_json);
  assert.equal(payload.trend, "flat", "first observation has no prior score to rise from");
  assert.equal(payload.persona_read.disc, "C");
  assert.equal(payload.persona_read.bank, "Knowledge");
  assert.ok(payload.next_move.includes("ตารางเปรียบเทียบ"));
  assert.equal(hermesFetch.scorerCalls().length, 1);
  // scorer ต้องเห็น transcript + framework
  const scorerBody = hermesFetch.scorerCalls()[0].body;
  assert.ok(promptText(scorerBody.messages[0].content).includes("DISC"));
  assert.ok(scorerBody.messages.at(-1).content.includes("typed_customer;"));
});

test("F3: scorer ตอบไม่ใช่ JSON -> ทิ้งเงียบ ไม่มีผลกับแชท", async (t) => {
  const hermesFetch = dualHermesStub({ scorer: "ลูกค้าคนนี้สนใจมากค่ะ ประมาณ 8 คะแนน" });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());

  const result = await app.pipeline.handleInboundText({ customerId: "U-badjson", text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  await waitFor(() => hermesFetch.scorerCalls().length === 1);
  await sleep(30);
  assert.equal(db.getCustomer("U-badjson").last_score, null);
  assert.equal(db.latestScoreRow("U-badjson"), null);
});

test("F3: scorer score นอกช่วง (15) -> ทิ้งทั้งก้อน", async (t) => {
  const hermesFetch = dualHermesStub({ scorer: JSON.stringify({ score: 15, trend: "up" }) });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());

  await app.pipeline.handleInboundText({ customerId: "U-range", text: "สอบถามค่ะ", replyToken: "rt" });
  await waitFor(() => hermesFetch.scorerCalls().length === 1);
  await sleep(30);
  assert.equal(db.getCustomer("U-range").last_score, null);
});

test("F3: scorer fetch พัง -> reply ไม่กระทบ ไม่มี unhandled rejection", async (t) => {
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const isScorer = body.messages?.[0]?.content?.includes("ระบบวิเคราะห์ความสนใจซื้อ");
    if (isScorer) throw new Error("scorer ล่ม");
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ได้เลยค่ะ สนใจรุ่นไหนคะ" } }] }) };
  };
  const { app, db } = makeApp({ hermesFetch: fn });
  t.after(() => db.close());

  const result = await app.pipeline.handleInboundText({ customerId: "U-crash", text: "สวัสดีค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  await sleep(50); // ให้ scorer macrotask วิ่งแล้วพังแบบเงียบ
  assert.equal(db.getCustomer("U-crash").last_score, null);
});

test("F3: เส้นทาง template (identity/urgent) -> ไม่ยิง scorer", async (t) => {
  const hermesFetch = dualHermesStub({ scorer: GOOD_SCORER_JSON });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());

  await app.pipeline.handleInboundText({ customerId: "U-tmpl", text: "นี่บอทหรือเปล่าคะ", replyToken: "rt" });
  await sleep(50);
  assert.equal(hermesFetch.calls.length, 0, "template path ห้ามเรียก Hermes ทั้ง draft และ scorer");
  assert.equal(db.getCustomer("U-tmpl").last_score, null);
});

test("F3: parseScorePayload — defensive ครบทุกทรง", () => {
  // JSON ใน code fence + ข้อความแถม
  const fenced = "```json\n" + GOOD_SCORER_JSON + "\n```\nหมายเหตุ: วิเคราะห์แล้ว";
  assert.equal(parseScorePayload(fenced).score, 7);
  // trend มั่ว -> flat, persona มั่ว -> unknown
  const loose = parseScorePayload(JSON.stringify({ score: 3, trend: "sideways", persona_read: { disc: "X", bank: "Cash" } }));
  assert.equal(loose.trend, "flat");
  assert.equal(loose.persona_read.disc, "unknown");
  assert.equal(loose.persona_read.bank, "unknown");
  // ของพัง = null ทั้งหมด
  assert.equal(parseScorePayload("ไม่ใช่ json"), null);
  assert.equal(parseScorePayload(""), null);
  assert.equal(parseScorePayload(JSON.stringify({ score: -1 })), null);
  assert.equal(parseScorePayload(JSON.stringify({ score: 5.5 })), null);
  assert.equal(parseScorePayload(JSON.stringify({ trend: "up" })), null);
  assert.equal(parseScorePayload("[1,2,3]"), null);
});

test("v1.4.41: scorer prompt และ parser รองรับ persona ทั้ง 13 กลุ่มชุดเดียวกัน", () => {
  const prompt = buildScorerSystem({});
  for (const personaType of PERSONA_TYPES) {
    assert.match(prompt, new RegExp(`\\b${personaType}\\b`, "u"), `${personaType} ต้องอยู่ใน scorer contract`);
    const parsed = parseScorePayload(JSON.stringify({ score: 5, persona_type: personaType }));
    assert.equal(parsed.persona_type, personaType);
  }
  assert.equal(parseScorePayload(JSON.stringify({ score: 5, persona_type: "invented" })).persona_type, "unknown");
});

/* -------------------------- F4: จบด้วยคำถามเมื่อ score ต่ำ ------------------- */

test("F4: bubbleHasQuestion จับเครื่องหมาย/คำลงท้ายเชิงถาม", () => {
  assert.equal(bubbleHasQuestion("สนใจรุ่นไหนอยู่คะ?"), true);
  assert.equal(bubbleHasQuestion("ใช้ในห้องกี่ตารางเมตรคะ"), true);
  assert.equal(bubbleHasQuestion("มีสัตว์เลี้ยงไหมคะ"), true);
  assert.equal(bubbleHasQuestion("งบประมาณเท่าไหร่คะ"), true);
  assert.equal(bubbleHasQuestion("รับทราบค่ะ เดี๋ยวติดต่อกลับนะคะ"), false);
  assert.equal(bubbleHasQuestion(""), false);
});

test("F4: score ต่ำไม่บังคับคำถามและไม่ตีตราคำตอบตรงเป็นความผิด", async (t) => {
  const hermesFetch = dualHermesStub({ reply: "รับทราบค่ะ เดี๋ยวทีมงานติดต่อกลับนะคะ" });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());

  const result = await app.pipeline.handleInboundText({ customerId: "U-noq", text: "สวัสดีค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.equal(db.getMetric("no_question_low_score"), 0);
  assert.equal(db.overviewStats().noQuestionLowScore, 0);
});

test("F4: score ต่ำ + reply จบด้วยคำถาม -> ไม่นับ metric", async (t) => {
  const hermesFetch = dualHermesStub({ reply: "ได้เลยค่ะ ใช้ในห้องกี่ตารางเมตรคะ" });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());

  await app.pipeline.handleInboundText({ customerId: "U-q", text: "สวัสดีค่ะ", replyToken: "rt" });
  assert.equal(db.getMetric("no_question_low_score"), 0);
});

// คำสั่งพี่ง้วง 2026-09-13 ("ลงท้ายทุกคำตอบด้วยคำถาม") อยู่หลังสวิตช์ reply_closing_question (ค่าเริ่มต้น on)
// สองเทสต์ F4 ข้างล่างล็อกพฤติกรรมเดิมจึงตรึงสวิตช์ไว้ที่ off — ฝั่ง on ดูเทสต์ถัดไปและ reply-closing-question.test.mjs
test("F4: score สูงไม่บังคับจบด้วยคำถาม (สวิตช์ reply_closing_question = off)", async (t) => {
  const hermesFetch = dualHermesStub({ reply: "สรุปยอดตามนี้เลยค่ะ เดี๋ยวส่งลิงก์ชำระเงินให้นะคะ" });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());
  db.setSetting(REPLY_CLOSING_QUESTION_KEY, "off");
  db.upsertCustomer("U-hot", {});
  db.recordScore("U-hot", 8, "{}");

  await app.pipeline.handleInboundText({ customerId: "U-hot", text: "ตกลงเอา X5Pro ค่ะ", replyToken: "rt" });
  assert.equal(db.getMetric("no_question_low_score"), 0, "score สูงไม่นับ metric");
  const system = promptText(hermesFetch.draftCalls()[0].body.messages[0].content);
  assert.ok(!system.includes("จบคำตอบด้วยคำถาม"), "score สูงไม่ต้องมีกติกาจบด้วยคำถาม");
});

test("F4: score ต่ำ -> prompt ให้ถามเฉพาะเมื่อจำเป็น (สวิตช์ reply_closing_question = off)", async (t) => {
  const hermesFetch = dualHermesStub({});
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());
  db.setSetting(REPLY_CLOSING_QUESTION_KEY, "off");

  await app.pipeline.handleInboundText({ customerId: "U-rule", text: "สวัสดีค่ะ", replyToken: "rt" });
  const system = promptText(hermesFetch.draftCalls()[0].body.messages[0].content);
  // v1.2.1: สเปคเปลี่ยนตามคำสั่งพี่ง้วง — lead-forward question เป็นค่าปกติ
  assert.ok(system.includes("ถ้าขาดข้อมูลที่จำเป็นจริง ๆ"));
  assert.ok(!system.includes("จบคำตอบด้วยคำถามชวนคุยต่อ 1 คำถามเสมอ"));
});

test("F4 (คำสั่งพี่ง้วง 2 ต.ค.): คำถามเป็นทางเลือกสูงสุดหนึ่งข้อ ไม่เร่งขายและไม่ใช่แบบฟอร์ม", async (t) => {
  const hermesFetch = dualHermesStub({});
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());

  await app.pipeline.handleInboundText({ customerId: "U-rule-on", text: "สวัสดีค่ะ", replyToken: "rt" });
  const system = promptText(hermesFetch.draftCalls()[0].body.messages[0].content);
  assert.ok(system.includes("จึงถามได้สูงสุดหนึ่งข้อ"));
  assert.ok(!system.includes("ปิดท้ายทุกคำตอบด้วยคำถามนำหนึ่งข้อ"));
  assert.ok(system.includes("ห้ามถามกดดันให้ตัดสินใจ"));
  assert.ok(system.includes("คำถามต้องไม่ใช่แบบฟอร์มคัดกรอง"));
  assert.ok(!system.includes("ถ้าขาดข้อมูลที่จำเป็นจริง ๆ ต่อการช่วยในขั้นถัดไป"));
  assert.equal(db.getMetric("no_question_low_score"), 0);
});

test("human conversation prompt sanitizes the LINE display name and removes duplicate current inbound", async (t) => {
  const hermesFetch = dualHermesStub({ reply: "แพรสรุปให้ตรง ๆ ตามนี้นะคะ" });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());
  db.upsertCustomer("U-human", { displayName: "โปรโมชั่นลดราคาทั้งร้าน" });
  db.insertMessage({ customerId: "U-human", direction: "out", content: "ก่อนหน้านี้แพรเสนอว่าจะสรุปให้ค่ะ" });
  db.insertMessage({ customerId: "U-human", direction: "in", content: "ครับ" });

  await app.pipeline.respondToBurst({ customerId: "U-human", text: "ครับ", replyToken: "rt" });
  const body = hermesFetch.draftCalls()[0].body;
  const system = promptText(body.messages[0].content);
  assert.ok(!system.includes("ลดราคาทั้งร้าน"), "ชื่อโปรไฟล์เชิงโฆษณาห้ามหลุดเข้า prompt");
  assert.match(system, /ยังไม่มีชื่อที่ใช้เรียกลูกค้าคนนี้ได้/u);
  // handoff 2026-08-12 (F2): "ครับ" หลังข้อเสนอ ("เสนอว่าจะสรุปให้") ได้กติกา
  // continuation เจาะจงแทนกติกา generic เดิม — ทำต่อทันที ห้ามถามอนุญาตซ้ำ
  assert.ok(system.includes("ตอบรับข้อเสนอล่าสุด"));
  assert.deepEqual(body.messages.filter((message) => message.role === "user").map((message) => message.content), ["ครับ"]);
});

test("question fatigue produces a hard no-question instruction", async (t) => {
  const hermesFetch = dualHermesStub({ reply: "ขอโทษนะคะ แพรสรุปให้ตรง ๆ เลยค่ะ" });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());
  await app.pipeline.handleInboundText({ customerId: "U-fatigue", text: "ถามเยอะจัง ขอข้อมูลตรง ๆ ครับ", replyToken: "rt" });
  const system = promptText(hermesFetch.draftCalls()[0].body.messages[0].content);
  assert.ok(system.includes("ห้ามถามกลับในเทิร์นนี้"));
});

/* ------------------------------ F7: LINE quota ------------------------------ */

function quotaLineClient({ quota, consumption, now } = {}) {
  let fetchCount = 0;
  const config = testConfig();
  const fetchImpl = async (url) => {
    fetchCount += 1;
    const u = String(url);
    if (u.endsWith("/consumption")) {
      if (!consumption) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => consumption };
    }
    if (!quota) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => quota };
  };
  const line = createLineClient({ config, fetchImpl, logger: silent, now: now ?? Date.now });
  return { line, getFetchCount: () => fetchCount };
}

test("F7: quota limited -> {type, value, totalUsage, cachedAt}", async () => {
  const { line } = quotaLineClient({ quota: { type: "limited", value: 1000 }, consumption: { totalUsage: 250 } });
  const q = await line.getQuota();
  assert.equal(q.type, "limited");
  assert.equal(q.value, 1000);
  assert.equal(q.totalUsage, 250);
  assert.ok(Number.isFinite(q.cachedAt));
});

test("F7: quota type none (ไม่จำกัด) -> value = null", async () => {
  const { line } = quotaLineClient({ quota: { type: "none" }, consumption: { totalUsage: 42 } });
  const q = await line.getQuota();
  assert.equal(q.type, "none");
  assert.equal(q.value, null);
  assert.equal(q.totalUsage, 42);
});

test("F7: cache 5 นาที — call ที่สองใน TTL ไม่ fetch ซ้ำ, หมด TTL ค่อย fetch ใหม่", async () => {
  let fakeNow = 1_700_000_000_000;
  const { line, getFetchCount } = quotaLineClient({
    quota: { type: "limited", value: 500 }, consumption: { totalUsage: 100 },
    now: () => fakeNow,
  });
  await line.getQuota();
  assert.equal(getFetchCount(), 2, "รอบแรกยิง 2 endpoint");
  const cached = await line.getQuota();
  assert.equal(getFetchCount(), 2, "ใน TTL ต้องใช้ cache");
  assert.equal(cached.totalUsage, 100);
  fakeNow += 5 * 60_000 + 1; // เกิน TTL
  await line.getQuota();
  assert.equal(getFetchCount(), 4, "หมด TTL แล้วต้อง fetch ใหม่");
});

test("F7: endpoint พัง -> null และไม่ cache ค่าพัง", async () => {
  const { line, getFetchCount } = quotaLineClient({ quota: null, consumption: { totalUsage: 1 } });
  assert.equal(await line.getQuota(), null);
  const first = getFetchCount();
  assert.equal(await line.getQuota(), null);
  assert.ok(getFetchCount() > first, "error ไม่ถูก cache — ลองใหม่ได้");
});

test("F7: fail-closed — live ปิด + ไม่มี mock -> null โดยไม่ fetch", async () => {
  let fetchCount = 0;
  const config = testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "false" });
  const line = createLineClient({
    config, fetchImpl: async () => { fetchCount += 1; return { ok: true, json: async () => ({}) }; },
    logger: silent,
  });
  assert.equal(await line.getQuota(), null);
  assert.equal(fetchCount, 0);
});

/* --------------------------- migration idempotency -------------------------- */

test("migration: DB เก่า (ยังไม่มีคอลัมน์/ตาราง G2a) เปิดได้ + ALTER เพิ่มครบ + เปิดซ้ำได้", () => {
  const dir = mkdtempSync(join(tmpdir(), "chassis-mig-"));
  const file = join(dir, "old.sqlite");
  try {
    // จำลอง schema ยุค G1: ตาราง customers ไม่มีคอลัมน์ G2a
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE customers (
      line_user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      ai_enabled INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'AI_ACTIVE',
      human_owner TEXT NOT NULL DEFAULT '',
      handoff_summary TEXT NOT NULL DEFAULT '',
      marketing_consent INTEGER NOT NULL DEFAULT 0,
      do_not_disturb INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    raw.prepare("INSERT INTO customers (line_user_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("U-old", "ลูกค้าเก่า", 1, 1);
    raw.close();

    const db = openDb({ file });
    const customer = db.getCustomer("U-old");
    assert.equal(customer.display_name, "ลูกค้าเก่า", "ข้อมูลเดิมต้องอยู่ครบ");
    assert.equal(customer.known_name, "");
    assert.equal(customer.followup_enabled, 1);
    assert.equal(customer.last_score, null);
    // ตารางใหม่ใช้งานได้จริง
    db.recordScore("U-old", 5, "{}");
    const fu = db.createFollowup({ customerId: "U-old", scheduledAt: Date.now() + 1000, createdBy: "nok" });
    assert.equal(fu.status, "pending");
    db.close();

    // เปิดซ้ำ (migration ต้อง idempotent)
    const again = openDb({ file });
    assert.equal(again.getCustomer("U-old").last_score, 5);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ----------------------------- F6: reset (db ชั้นใน) ------------------------ */

// M3 (PDPA completeness): เทสต์นี้ enumerate ตารางที่มีคอลัมน์ customer_id จาก schema จริง —
// ใครเพิ่มตารางลูกใหม่โดยไม่อัปเดต resetCustomer (และลิสต์นี้) เทสต์ต้องแดงทันที
const RESET_COVERED_TABLES = [
  "conversation_sessions", "corrections",
  // 6 ต.ค. 2026: ที่มาของห้องจากแอด Meta (dbAdReferrals.mjs — resetCustomer ลบก่อนจบเร็วเมื่อไม่มีแถวลูกค้าด้วย)
  "customer_ad_referrals",
  // v1.4 Lifecycle: facts มีเลขภาษี/เบอร์/บริษัท — PDPA ลืมไม่ได้ (เทสต์ลึกใน lifecycle.test.mjs)
  "customer_facts",
  // 28 ก.ย. 2026: ลูกค้าคนเดียวกันข้าม Facebook ↔ LINE (dbIdentityLinks.mjs — resetCustomer เรียก detachIdentityOnReset)
  "customer_identity_links",
  "customer_tags", "enrollments", "followup_state", "followup_suggestions",
  "followups", "handoff_notes", "identity_link_attempts", "identity_link_codes", "inbound_image_classifications", "inbound_turn_outcomes", "jev_audit_feedback", "jev_decision_reviews", "jev_shadow", "lifecycle_events",
  // 28 ก.ย. 2026: สถานะเพื่อน (follow/unfollow) ของสตูดิโอบรอดแคสต์
  "line_follow_state",
  "llm_usage", "message_attachments", "message_media_deletion_queue", "messages", "operator_outbound_attempts", "orders",
  // 2026-09-28: บทเรียนจากแผง "ทำไมตอบแบบนี้" — reset ถอดคำลูกค้า/ตัวชี้ห้อง (คำสอนอยู่ต่อ)
  "owner_lessons", "proactive_attempts",
  "score_history", "slip_checks",
  // 28 ก.ย. 2026: ข้อความตามขั้น (คนในลำดับ + การส่งต่อขั้น)
  "step_deliveries", "step_enrollments",
  "tag_sync_state", "training_candidates", "training_feedback",
  "web_push_events",
];

test("F6+M3: resetCustomer ลบครบทุกตารางที่มี customer_id + audit อ้างถึงลูกค้า + schedule_ack", () => {
  const db = memoryDb();

  // ด่านกันถอยหลัง: ตารางที่มี customer_id ใน schema ต้องตรงกับลิสต์ที่ reset ครอบคลุมเป๊ะ
  const customerTables = db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .filter((name) => db.raw.prepare(`PRAGMA table_info(${name})`).all().some((c) => c.name === "customer_id"))
    .sort();
  assert.deepEqual(customerTables, RESET_COVERED_TABLES,
    "มีตารางใหม่ที่ผูกกับลูกค้า — ต้องเพิ่มเข้า resetCustomer (db.mjs) แล้วอัปเดตลิสต์นี้");

  db.upsertCustomer("U-reset", { displayName: "คุณรีเซ็ต" });
  db.setKnownName("U-reset", "บี");
  db.setAiEnabled("U-reset", false);
  db.setNeedsHuman("U-reset", "test");
  db.setDoNotDisturb("U-reset", true);
  db.setFollowupEnabled("U-reset", false);
  db.recordAdReferral({ customerId: "U-reset", source: "ADS", adId: "120210000000000001", eventKind: "message", referralAt: 1 });
  // seed ครบทุกตารางที่ enumerate ไว้ — reset แล้วต้องเหลือศูนย์ทุกตาราง
  const resetMessageId = db.insertMessage({ customerId: "U-reset", direction: "in", msgType: "image", content: "[image]" });
  const resetAttachmentId = db.addMessageAttachment({
    customerId: "U-reset", messageId: resetMessageId, direction: "in",
    kind: "image", status: "ready", mime: "image/png", storageKey: "00000000-0000-4000-8000-000000000000.png",
  });
  // Closed evidence values and the real message FK are intentional: a generic
  // placeholder would not exercise the production cascade constraint.
  db.raw.prepare(
    `INSERT INTO inbound_image_classifications
      (message_id,customer_id,provider_message_id,classification_state,classified_kind,diagnostic_code,action,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(resetMessageId, "U-reset", "pdpa-reset-image", "classified", "other", "valid", "text_pipeline", Date.now(), Date.now());
  db.createAttachmentDownloadToken({ tokenHash: "reset-token", attachmentId: resetAttachmentId, expiresAt: Date.now() + 60_000 });
  db.createOperatorOutboundAttempt({
    customerId: "U-reset", operator: "nok",
    payload: { historyRows: [{ id: "reset-attempt-message", customerId: "U-reset", direction: "out", content: "pending" }] },
  });
  const queuedMedia = db.queueCustomerMediaDeletion("U-reset", "pdpa_coverage_test");
  assert.equal(queuedMedia.length, 1, "PDPA reset ต้อง queue ไฟล์ก่อนลบข้อมูล");
  assert.equal(db.completeMessageMediaDeletion(queuedMedia[0]), true, "จำลอง physical delete สำเร็จก่อน reset DB");
  db.recordScore("U-reset", 9, "{}");
  db.raw.prepare(`INSERT INTO jev_shadow
    (id,customer_id,score_id,session_id,evidence_hash,policy,primary_model,primary_score,model,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("shadow-reset", "U-reset", db.latestScoreRow("U-reset").id, "session", "hash", "policy", "luna", 9, "jev", "pending", Date.now());
  db.raw.prepare(`INSERT INTO jev_decision_reviews
    (id,customer_id,session_id,turn_id,stage,policy,model,action,status,evidence_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("review-reset", "U-reset", "session", "turn", "draft", "policy", "jev", "rewrite", "reviewed", "hash", Date.now());
  db.raw.prepare(`INSERT INTO jev_audit_feedback
    (batch_id,case_id,evidence_hash,customer_id,stop_label,reviewer,reviewed_at)
    VALUES (?,?,?,?,?,?,?)`).run("reset-batch", "reset-case", "hash", "U-reset", "incorrect", "owner", Date.now());
  db.createFollowup({ customerId: "U-reset", scheduledAt: Date.now() + 1000 });
  db.addCorrection({ customerId: "U-reset", aiDraft: "ร่าง" });
  db.raw.prepare("INSERT INTO followup_state (customer_id) VALUES (?)").run("U-reset");
  db.claimProactiveAttempt("U-reset", "staged", "reset-test", Date.now());
  db.addHandoffNote({ customerId: "U-reset", author: "nok", text: "โน้ต" });
  // บทเรียนที่สอนจากห้องนี้: แถวอยู่ต่อ แต่ต้องไม่เหลือตัวชี้ไปหาลูกค้า (คำสอนเป็นของธุรกิจ)
  const resetLesson = db.addOwnerLesson({
    teaching: "ตอบสั้น ๆ ก่อนแล้วค่อยถามต่อ", teachingKey: "reset-lesson", customerId: "U-reset",
    customerText: "ถามเรื่องคลาส", aiText: "คำตอบเดิม", status: "active", createdBy: "nok",
  });
  // บัญชีผลลัพธ์เทิร์นขาเข้าอ้างถึงลูกค้าตรง ๆ — PDPA ต้องลบด้วย
  db.raw.prepare(
    `INSERT INTO inbound_turn_outcomes
      (message_id, customer_id, channel_id, channel_kind, status, reason, process_id, created_at, updated_at)
     VALUES ('in:pdpa-reset', 'U-reset', 'default', 'line', 'answered', '', 'p', ?, ?)`
  ).run(Date.now(), Date.now());
  db.addLlmUsage({ customerId: "U-reset", kind: "draft", model: "m", tokensIn: 10, tokensOut: 5 });
  db.addSlipCheck({ customerId: "U-reset", status: "suspect" });
  db.createOrder({ customerId: "U-reset", items: [{ name: "X3", qty: 1, price: 100 }], createdBy: "nok" }); // G6
  db.raw.prepare("INSERT INTO customer_tags (customer_id, tag, source, created_at) VALUES (?, ?, 'rfm', ?)")
    .run("U-reset", "ซื้อแล้ว:X3", Date.now()); // v1.1: tag ผูกลูกค้า
  db.addTrainingFeedback({ customerId: "U-reset", content: "ความเห็นผู้ทดสอบ" }); // v1.2.6
  db.rotateTrainingSession({ customerId: "U-reset", resetEventId: "pdpa-coverage-reset", feedback: "ปิดรอบแล้ว" });
  // M3: audit ที่อ้างถึงลูกค้า (ทั้ง target และ detail) + สถานะ ack เวลาทำการ
  db.addAudit({ operator: "nok", action: "ai_toggle", target: "U-reset", detail: "off" });
  db.addAudit({ operator: "nok", action: "reply", target: "อื่น", detail: "customer=U-reset ตอบแล้ว" });
  db.addAudit({ operator: "nok", action: "login", detail: "ip=1.2.3.4" }); // ไม่อ้างลูกค้า — ต้องอยู่ต่อ
  db.setSetting("schedule_ack:U-reset", "1723200000000");
  // 28 ก.ย. 2026: การเชื่อมห้องข้ามช่องทาง + รหัสเชื่อมแชท + ความพยายามส่งรหัส ผูกกับลูกค้าตรง ๆ
  db.upsertCustomer("facebook:reset-fb", { displayName: "ห้อง Facebook", channelId: "facebook" });
  db.runIdentityLinkTransaction(() => db.linkIdentityRowsInTx({ aId: "U-reset", bId: "facebook:reset-fb", via: "team", by: "nok" }));
  db.insertIdentityLinkCode({ customerId: "U-reset", codeHash: "reset-code-hash", via: "console", by: "nok", expiresAt: Date.now() + 60_000 });
  db.recordIdentityLinkAttempt({ customerId: "U-reset", outcome: "not_found" });
  // ลูกค้าคนอื่นห้ามโดนหางเลข
  db.upsertCustomer("U-keep", {});
  db.insertMessage({ customerId: "U-keep", direction: "in", content: "อยู่ต่อ" });
  db.setSetting("schedule_ack:U-keep", "1723200000000");

  const customer = db.resetCustomer("U-reset");
  assert.equal(customer.display_name, "คุณรีเซ็ต", "คง display_name");
  assert.equal(customer.known_name, "");
  assert.equal(customer.ai_enabled, 1);
  assert.equal(customer.state, "AI_ACTIVE");
  assert.equal(customer.do_not_disturb, 0);
  assert.equal(customer.followup_enabled, 1);
  assert.equal(customer.last_score, null);
  for (const table of RESET_COVERED_TABLES) {
    const left = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE customer_id = ?`).get("U-reset").n;
    assert.equal(left, 0, `ตาราง ${table} ต้องไม่เหลือแถวของลูกค้า`);
  }
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM attachment_download_tokens WHERE attachment_id = ?").get(resetAttachmentId).n, 0,
    "download capability ของไฟล์ลูกค้าต้องถูกลบด้วย");
  // audit ที่อ้างถึงลูกค้าต้องหายหมด — แถวอื่นอยู่ต่อ
  assert.ok(!db.listAudit().some((row) => row.target === "U-reset" || String(row.detail).includes("U-reset")),
    "audit ที่อ้างถึงลูกค้าต้องถูกลบ");
  assert.ok(db.listAudit().some((row) => row.action === "login"), "audit ที่ไม่อ้างลูกค้าห้ามโดนลบ");
  assert.equal(db.getSetting("schedule_ack:U-reset"), null, "สถานะ ack ของลูกค้าต้องถูกลบ");
  assert.equal(db.getSetting("schedule_ack:U-keep"), "1723200000000", "ack ของลูกค้าคนอื่นห้ามหาย");
  assert.equal(db.messagesFor("U-keep").length, 1, "ลูกค้าคนอื่นไม่โดนลบ");
  const keptLesson = db.getOwnerLesson(resetLesson.id);
  assert.equal(keptLesson.teaching, "ตอบสั้น ๆ ก่อนแล้วค่อยถามต่อ", "คำสอนอยู่ต่อหลัง reset");
  assert.equal(keptLesson.customer_text, "", "คำลูกค้าในบทเรียนต้องถูกล้าง");
  assert.equal(keptLesson.ai_text, "", "คำตอบเดิมในบทเรียนต้องถูกล้าง");
  assert.equal(db.resetCustomer("U-ghost"), null, "ลูกค้าไม่มีจริง = null");
  db.close();
});

// v1.2.3 (บั๊กจริง: ย้าย scorer ไปใช้โมเดลเดียวกับเส้นตอบลูกค้า แล้ว scorer ตายทันที
// เพราะได้งบโทเคนเท่าข้อความแชทสั้น ๆ): บทบาท ไม่ใช่ชื่อโมเดล คือสิ่งที่กำหนดงบ
test("F3: scorer ขอ budget โทเคนของตัวเองเสมอ ไม่ใช้งบของเส้นตอบลูกค้า", async (t) => {
  const hermesFetch = dualHermesStub({ scorer: GOOD_SCORER_JSON });
  const { app, db } = makeApp({ hermesFetch });
  t.after(() => db.close());

  await app.pipeline.handleInboundText({ customerId: "U-budget", text: "สนใจ X3Pro ค่ะ", replyToken: "rt" });
  await app.pipeline.scoreBurst("U-budget");

  const scorerCall = hermesFetch.scorerCalls()[0];
  assert.ok(scorerCall.body.max_completion_tokens >= 2000, "scorer ต้องมี headroom สำหรับคิดก่อนสรุป JSON");
  const draftCall = hermesFetch.draftCalls()[0];
  // v1.4.2 (เคสจริง 2026-08-16): เส้นตอบลูกค้าต้องประกาศงบเองเสมอ — default 800 ของ
  // เกตเวย์เคยทำให้โมเดล reasoning คิดจนงบหมด content ว่าง ลูกค้าเจอ template ค้าง 3 เทิร์น
  assert.ok(draftCall.body.max_completion_tokens >= 3000, "เส้นตอบลูกค้าต้องมี headroom สำหรับคิด+พิมพ์ 4 บอลลูน");
});
