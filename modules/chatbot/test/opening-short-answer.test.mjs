// opening-short-answer.test.mjs — คำตอบสั้นเปิดห้อง ("ยังครับ" / "3") ห้ามได้ "หมายถึงเรื่องไหนคะ?"
//
// ที่มา (audit ก.ย. 2026 §4.1, บัญชีคำติ #24 #34, fix-spec F16): ห้อง Facebook ใหม่ 18% เปิดด้วยคำตอบ
// คำเดียวของคำถามต้อนรับในโฆษณา ซึ่ง webhook ไม่ได้เก็บไว้ ตั้งแต่ 8b075f1d5 (15 ก.ย.) กติกา
// "ไม่พบคำถามก่อนหน้า → ขอให้ขยาย" ทำให้ลูกแพรถามกลับใน 34-41% ของห้องแบบนี้ (ก่อนหน้า 2%)
// ข้อความลูกค้าในไฟล์นี้เป็นประโยคสังเคราะห์ทั้งหมด ไม่มีข้อความจริงจากห้องแชท
import test from "node:test";
import assert from "node:assert/strict";
import { baseRules } from "../src/pipeline.mjs";
import { buildReplyFocusRules, isOpeningShortAnswer, resolveReplyFocus, roomHasBotQuestion } from "../src/conversationFocus.mjs";
import { buildClassRoutingRules, detectAiLevel } from "../src/salesMotion.mjs";
import { resolveContinuation } from "../src/continuationResolver.mjs";
import {
  AD_WELCOME_QUESTION_KEY, AD_WELCOME_QUESTION_MAX, adWelcomeQuestionFor, normalizeAdWelcomeQuestion,
} from "../src/adWelcomeQuestion.mjs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, promptText, testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();

const bot = (content) => ({ role: "assistant", content });
const user = (content) => ({ role: "user", content });
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const LADDER = "เคยใช้ AI มาประมาณระดับไหนแล้วคะ?\n1️⃣ ยังไม่เคยใช้\n2️⃣ เคยลอง\n3️⃣ ช่วยงานจริง\n4️⃣ ใช้ประจำ\n5️⃣ สร้าง Custom AI";
const OLD_CLARIFY_ORDER = /ขอให้ช่วยขยายคำตอบสั้น/u;
const AD_QUESTION = "เคยสร้าง AI เป็นผู้ช่วยส่วนตัวมาก่อนมั้ยคะ?";
// ทรงข้อความแรกที่เจอจริง (สังเคราะห์ใหม่ให้รูปเดียวกัน) ทั้งฝั่งปฏิเสธ ฝั่งเคย และตัวเลขบันได
const OPENING_SHAPES = [
  ["ยังครับ", "negative"], ["ยังค่ะ", "negative"], ["ยัง", "negative"], ["ไม่เคยครับ", "negative"],
  ["ไม่เคย", "negative"], ["ยังไม่เคยใช้ค่ะ", "negative"], ["ไม่ครับ", "negative"],
  ["เคยค่ะ", "positive"], ["เคยใช้ครับ", "positive"], ["ใช่ค่ะ", "positive"],
  ["3 ค่ะ", "number"], ["3️⃣", "number"], ["ข้อ 2 ครับ", "number"],
];
const SHAPE_LINE = {
  negative: /คำตอบแบบ ยัง\/ไม่เคย: ต้อนรับอย่างอบอุ่น/u,
  // 2026-10-03 (พี่ง้วง: ตอบแข็งเกินไป): เลิกสั่ง "รับรู้…" ที่ทำให้โมเดลแยกประโยคทวนคำตอบ
  positive: /คำตอบแบบ เคย\/ใช่: ตอบรับสั้น ๆ ด้วยคำที่มีชีวิต \(ไม่แยกประโยคทวน/u,
  number: /คำตอบเป็นตัวเลข: คือระดับการใช้ AI/u,
};

/* ------------------------------- ตัวตัดสินชนิด ------------------------------- */

for (const [text, shape] of OPENING_SHAPES) {
  test(`เปิดห้องด้วย "${text}" = คำตอบของคำถามต้อนรับ ไม่ใช่คำตอบลอย ๆ ที่ต้องขอให้ขยาย`, () => {
    for (const history of [
      [],
      // เพจส่ง echo ข้อความทักทายที่ไม่มีคำถาม (เจอจริง: "เบื้องต้น ลูกแพรขออนุญาตสอบถาม...")
      [bot("[แอดมินทีมงานพิมพ์เอง] เบื้องต้น ลูกแพรขออนุญาตสอบถามเพิ่มเติมนิดนึงนะคะ")],
    ]) {
      const focus = resolveReplyFocus({ text, history });
      assert.equal(focus.kind, "opening_short_answer");
      assert.equal(focus.level, null, "ไม่รู้คำถามจริง ห้ามเดาระดับเป็นข้อเท็จจริงถาวร");
      assert.equal(isOpeningShortAnswer({ text, history }), true);
      const rules = buildReplyFocusRules({ text, history }).join("\n");
      assert.doesNotMatch(rules, OLD_CLARIFY_ORDER, "ห้ามสั่งให้ขอขยายความ (ต้นเหตุ 15 ก.ย.)");
      assert.match(rules, /ห้ามถามกลับว่าคำตอบนี้หมายถึงอะไร ห้ามขอให้ขยายความ/u);
      assert.match(rules, SHAPE_LINE[shape]);
      // ความหมายต่อส่วนอื่นเท่ากับ unresolved เดิม: ไม่มีระดับ ไม่มีคำแนะนำคลาสจากการเดา
      assert.equal(detectAiLevel(text, { history }), null);
      assert.deepEqual(buildClassRoutingRules({ text, history }), []);
      assert.equal(resolveContinuation({ latestText: text, history }).action, "answer_previous_question");
    }
  });
}

test("คำตอบสั้นหลังคำถามจริงของเรา ยังผูกกับคำถามนั้นเหมือน 15 ก.ย. (ส่วนที่ถูกอยู่แล้ว)", () => {
  const focus = resolveReplyFocus({ text: "3", history: [bot(LADDER)] });
  assert.equal(focus.kind, "ai_level");
  assert.equal(focus.level, 3);
  assert.equal(resolveReplyFocus({ text: "ยังครับ", history: [bot(LADDER)] }).level, 1);
  // echo ของเพจที่มีคำถามอยู่ในตัว = คำถามจริงในห้อง ไม่ใช่เปิดห้อง
  const echoed = resolveReplyFocus({
    text: "ยังค่ะ", history: [bot(`[แอดมินทีมงานพิมพ์เอง] สวัสดีค่ะ ${AD_QUESTION}`)],
  });
  assert.notEqual(echoed.kind, "opening_short_answer");
  assert.equal(echoed.question, `สวัสดีค่ะ ${AD_QUESTION}`);
  const rules = buildReplyFocusRules({ text: "3", history: [bot(LADDER)] }).join("\n");
  assert.match(rules, /ลูกค้ากำลังตอบเรื่องพื้นฐาน AI/u);
  assert.doesNotMatch(rules, /ต้อนรับอย่างอบอุ่น/u);
});

test("กลางบทสนทนา คำถามของเราหลุดเทิร์นล่าสุดไปแล้ว: ห้ามขอให้ขยาย ให้อ่านเทียบข้อความล่าสุด (F16)", () => {
  const history = [
    bot("อยากเริ่มจากข้อความเกี่ยวกับเรื่องอะไรคะ?"), user("เรื่องการตลาดค่ะ"),
    bot("ลองเลือกใจความหลักเพียงหนึ่งคำ แล้วให้ภาพมีสัญลักษณ์หลักอย่างเดียว ภาพจะสื่อความหมายชัดขึ้นค่ะ"),
  ];
  assert.equal(roomHasBotQuestion(history), true);
  const focus = resolveReplyFocus({ text: "เคยครับ", history });
  assert.equal(focus.kind, "unresolved_short_answer", "มีคำถามของเราในห้องแล้ว จึงไม่ใช่คำตอบเปิดห้อง");
  const rules = buildReplyFocusRules({ text: "เคยครับ", history }).join("\n");
  assert.doesNotMatch(rules, OLD_CLARIFY_ORDER);
  assert.match(rules, /ห้ามถามกลับว่าหมายถึงอะไรหรือขอให้ขยายความ/u);
  assert.match(rules, /อ่านคำตอบสั้นนี้เทียบกับข้อความล่าสุดของลูกแพร/u);
  assert.doesNotMatch(rules, /ต้อนรับอย่างอบอุ่น/u, "กลางบทสนทนาไม่ใช่เทิร์นต้อนรับ");
});

test("เทิร์นส่งไม้ต่อ/ดูแลลูกค้า: ไม่สั่งชวนคุยต่อซ้อนคำสั่ง 'ห้ามถามต่อ' ของเทิร์นนั้น", () => {
  const closing = buildReplyFocusRules({ text: "ใช่ค่ะ", history: [], closingTurn: true }).join("\n");
  assert.match(closing, /ห้ามถามกลับว่าคำตอบนี้หมายถึงอะไร/u);
  assert.doesNotMatch(closing, /ชวนคุยต่อ/u);
  const history = [bot("อยากเริ่มจากเรื่องไหนคะ?"), user("เรื่องงานขายค่ะ"), bot("ลองเริ่มจากสรุปงานขายรายวันก่อนได้ค่ะ")];
  const care = buildReplyFocusRules({ text: "เคยครับ", history, careMode: "pause" }).join("\n");
  assert.match(care, /ห้ามถามกลับว่าหมายถึงอะไรหรือขอให้ขยายความ/u);
  assert.doesNotMatch(care, /ชวนคุยต่อ/u);
});

/* --------------------------------- พรอมต์เต็ม --------------------------------- */

const LADDER_RULE = /ข้อความแรกเท่านั้น: แนบรูปบันได 7 Stage/u;
const allowLadder = { approvedImageKeys: new Set(["ai-stage-ladder"]) };

test("เปิดห้องด้วยคำตอบสั้น: ไม่ส่งบันไดถามระดับซ้ำ แต่ห้องที่เปิดด้วยคำอื่นยังได้บันไดตามเดิม", () => {
  const opening = baseRules("general", [], { currentText: "ยังครับ", history: [], ...allowLadder });
  assert.doesNotMatch(opening, LADDER_RULE, "เขาเพิ่งตอบคำถามต้อนรับไป ห้ามถามคำถามเดิมซ้ำ");
  assert.doesNotMatch(opening, OLD_CLARIFY_ORDER);
  assert.match(opening, /ไม่ต้องส่งบันไดถามระดับซ้ำ/u);
  for (const text of ["สนใจ", "Get Started", "สวัสดีค่ะ สนใจคลาส AI"]) {
    assert.match(baseRules("general", [], { currentText: text, history: [], ...allowLadder }), LADDER_RULE, text);
  }
});

test("คำถามต้อนรับในโฆษณาที่ตั้งไว้ = บริบทของเทิร์นเปิดห้องเท่านั้น (ไม่ใช่คำพูดของลูกแพร)", () => {
  const withQuestion = baseRules("general", [], { currentText: "ยังครับ", history: [], adWelcomeQuestion: AD_QUESTION });
  assert.match(withQuestion, new RegExp(`ลูกค้ากำลังตอบคำถามต้อนรับในโฆษณา Facebook ที่ทีมงานตั้งไว้: "${AD_QUESTION.replace("?", "\\?")}"`, "u"));
  assert.match(withQuestion, /ไม่ใช่ข้อความที่ลูกแพรพิมพ์ในแชทนี้/u);
  assert.doesNotMatch(withQuestion, /ระบบไม่ได้เก็บไว้/u, "รู้คำถามแล้ว ห้ามบอกว่าไม่รู้");
  const unknown = baseRules("general", [], { currentText: "ยังครับ", history: [] });
  assert.match(unknown, /ระบบไม่ได้เก็บไว้ \(ส่วนใหญ่ถามเรื่องประสบการณ์ใช้ AI\)/u);
  // เทิร์นที่ไม่ใช่คำตอบเปิดห้อง: ตั้งคำถามไว้หรือไม่ พรอมต์ต้องเหมือนเดิมทุกไบต์
  for (const [text, history] of [["ราคาเท่าไหร่คะ", []], ["3", [bot(LADDER)]], ["สนใจ", []]]) {
    assert.equal(
      baseRules("general", [], { currentText: text, history, adWelcomeQuestion: AD_QUESTION }),
      baseRules("general", [], { currentText: text, history }),
      text,
    );
  }
});

test("ค่าคำถามต้อนรับ: ใช้กับห้อง Facebook เท่านั้น และทำให้เป็นบรรทัดเดียวที่ปลอดภัย", () => {
  const db = memoryDb();
  db.setSetting(AD_WELCOME_QUESTION_KEY, `  ${AD_QUESTION}\n1️⃣ ยัง\n2️⃣ เคย  `);
  assert.equal(adWelcomeQuestionFor({ db, customer: { channel_id: "facebook" } }), `${AD_QUESTION} 1️⃣ ยัง 2️⃣ เคย`);
  assert.equal(adWelcomeQuestionFor({ db, customer: { channel_id: "default" } }), "", "ห้อง LINE ไม่ได้มาจากโฆษณา Facebook");
  assert.equal(adWelcomeQuestionFor({ db, customer: null }), "");
  assert.equal(normalizeAdWelcomeQuestion('ถาม "ตรง ๆ"\u0007'), "ถาม ”ตรง ๆ”", "เครื่องหมายคำพูดห้ามปิดบรรทัดพรอมต์ก่อนเวลา");
  assert.equal([...normalizeAdWelcomeQuestion("ก".repeat(900))].length, AD_WELCOME_QUESTION_MAX);
  assert.equal(normalizeAdWelcomeQuestion(42), "");
  db.close();
});

/* ------------------------------- ไปป์ไลน์จริง ------------------------------- */

function makeApp() {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("ยินดีต้อนรับค่ะ เริ่มจากพื้นฐานได้เลย ทำธุรกิจด้านไหนอยู่คะ?");
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  return { app, db, hermesFetch };
}

test("ไปป์ไลน์: ห้อง Facebook ใหม่ตอบ \"ยังครับ\" — พรอมต์รู้คำถามโฆษณา และไม่มีคำสั่งขอให้ขยาย", async (t) => {
  const { app, db, hermesFetch } = makeApp();
  t.after(() => db.close());
  db.setSetting(AD_WELCOME_QUESTION_KEY, AD_QUESTION);
  const fb = "facebook:psid-opening";
  db.upsertCustomer(fb, { channelId: "facebook" });
  const result = await app.pipeline.handleInboundText({ customerId: fb, text: "ยังครับ", replyToken: "" });
  assert.equal(result.sent, true);
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(system, /opening_short_answer/u);
  assert.ok(system.includes(AD_QUESTION), "ห้อง Facebook ต้องเห็นคำถามโฆษณาที่ตั้งไว้");
  assert.doesNotMatch(system, OLD_CLARIFY_ORDER);

  const line = "U-opening-line";
  await app.pipeline.handleInboundText({ customerId: line, text: "ยังครับ", replyToken: "rt" });
  const lineSystem = promptText(hermesFetch.calls.at(-1).body.messages[0].content);
  assert.match(lineSystem, /opening_short_answer/u);
  assert.ok(!lineSystem.includes(AD_QUESTION), "ห้อง LINE ห้ามอ้างคำถามโฆษณา Facebook");
});

/* --------------------------------- คอนโซล --------------------------------- */

const PASSWORD = "opening-answer-test-password";

async function startConsole(t) {
  const db = memoryDb();
  for (const [username, role] of [["owner", "owner"], ["admin", "admin"], ["staff", "operator"]]) {
    db.createOperator({ username, passHash: hashPassword(PASSWORD), displayName: username, role });
  }
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "opening-answer-console-secret" }), db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const response = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 200, response.text);
  return { cookie: response.headers["set-cookie"][0].split(";")[0], csrf: response.json.csrf };
}

const post = (server, who, body) => httpRequest(server, {
  method: "POST", path: "/console/api/settings/fb-ad-welcome",
  headers: { cookie: who.cookie, ...(who.csrf ? { "x-csrf-token": who.csrf } : {}), "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("คอนโซล: ทุกบทบาทอ่านได้ · แก้ได้เฉพาะ Super Admin/Admin · CSRF · ตรวจค่า · audit ไม่เก็บข้อความ", async (t) => {
  const { app, db } = await startConsole(t);
  const [owner, admin, staff] = await Promise.all(["owner", "admin", "staff"].map((name) => login(app.server, name)));

  const read = await httpRequest(app.server, { path: "/console/api/settings/fb-ad-welcome", headers: { cookie: staff.cookie } });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.json.question, "");
  assert.equal(read.json.canEdit, false);

  assert.equal((await post(app.server, staff, { question: AD_QUESTION })).status, 403, "Staff แก้ไม่ได้");
  assert.equal((await post(app.server, { cookie: admin.cookie }, { question: AD_QUESTION })).status, 403, "ไม่มี CSRF");
  assert.equal((await post(app.server, admin, { question: 42 })).status, 400);

  const saved = await post(app.server, admin, { question: `${AD_QUESTION}\n\n1️⃣ ยัง` });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.question, `${AD_QUESTION} 1️⃣ ยัง`);
  assert.equal(saved.json.canEdit, true);
  assert.equal(db.getSetting(AD_WELCOME_QUESTION_KEY), `${AD_QUESTION} 1️⃣ ยัง`);
  const audit = db.listAudit(20).find((row) => row.action === "fb_ad_welcome_question_set");
  assert.ok(audit, "ทุกการแก้ต้องมีแถว audit");
  assert.ok(!audit.detail.includes("AI"), "audit เก็บแค่ความยาว ไม่เก็บข้อความ");

  const cleared = await post(app.server, owner, { question: "   " });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.question, "");
});
