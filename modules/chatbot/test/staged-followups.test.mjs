// v1.4.6 — Staged follow-up (sub-agent ตามสเตจ, คำสั่งพี่ง้วง 2026-08-16):
// บันได cold/warm/hot, timer รีเซ็ตเมื่อลูกค้าตอบ, กันรำคาญ (backoff เท่าตัว + เพดานวัน),
// รีวิว/รูปไม่ซ้ำ, guard ครบ, quiet hours, delivered subset — mock ทั้งหมด ไม่แตะ network
import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import {
  createStagedFollowups, parseReviewCatalog, pickReview, paymentHoldActive,
  previewStagedFollowup, stagedRules, COLD_LIFETIME_CAP, DAILY_PROACTIVE_CAP,
} from "../src/stagedFollowups.mjs";
import { poisonGlobalFetch, testConfig, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0); // 12:00 เวลาไทย
const TEN_PM_BKK = Date.UTC(2026, 0, 15, 15, 0, 0); // 22:00 เวลาไทย
const MIN = 60_000;

const REVIEW_KNOWLEDGE = [
  "[Classroom : AI Agent For Business]",
  "- คุณทดสอบหนึ่ง — CEO โรงพิมพ์ | รีวิว: https://www.facebook.com/share/r/AAA111/",
  "- คุณทดสอบสอง — เจ้าของธุรกิจส่วนตัว | รีวิว: https://www.facebook.com/share/r/BBB222/",
  "[Classroom : AI Agent Workflow Automation]",
  "- คุณเอ — CEO ร้านตัดผม | รีวิว: https://www.facebook.com/share/v/CCC333/",
].join("\n");

const CATALOG = [
  { key: "classroom-atmosphere-1", url: "https://img.test/c1.jpg", previewUrl: "https://img.test/c1p.jpg" },
  { key: "classroom-atmosphere-2", url: "https://img.test/c2.jpg", previewUrl: "https://img.test/c2p.jpg" },
];

function makeWorld({ score = 6, nowMs = NOON_BKK, onHermesCall = null, draftText = null, decisionReview = null, configOverrides = {} } = {}) {
  const clock = { now: nowMs };
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0", ...configOverrides });
  // นาฬิกาเดียวทั้งเทสต์ — db กับ engine ต้องอ่านเวลาตัวเดียวกัน ไม่งั้นข้อความที่ engine
  // เพิ่งเขียนจะไปโผล่บนแกนเวลาจริง (ก.ย.) แทนแกนของเทสต์ (ม.ค.) แล้วความเงียบไม่มีวันเดิน
  const db = memoryDb({ now: () => clock.now });
  db.addKnowledge({ title: "รีวิวนักเรียนจริง แยกตามคลาส", content: REVIEW_KNOWLEDGE, updatedBy: "test" });
  // คำถามต้องไม่ซ้ำทุก call — engine มี dedupe คำถามซ้ำ (ซ้ำ = ข้าม ซึ่งคือพฤติกรรมที่ต้องการ
  // ในโปรดักชัน แต่ในเทสต์ต้องการเดินบันไดให้ครบ)
  let drafts = 0;
  const draftModels = [];
  const hermesFetch = async (_url, options) => {
    try { draftModels.push(JSON.parse(options?.body || "{}").model); } catch { /* เทสต์เท่านั้น */ }
    if (onHermesCall) await onHermesCall(JSON.parse(options.body));
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: draftText ?? `ชวนคุยต่อรอบที่ ${drafts += 1} ค่ะ สนใจด้านไหนเพิ่มไหมคะ?` } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 70 } },
      }),
    };
  };
  // v1.4.9: ต่อ getter เหมือน server.mjs จริง — followup_model ว่าง = ตามตัวหลัก
  const hermes = createHermesBridge({
    config, fetchImpl: hermesFetch, logger: silent,
    getReplyModel: () => db.getSetting("reply_model") || config.hermesModel,
    getFollowupModel: () => db.getSetting("followup_model") || "",
  });
  const pushes = [];
  const lineCh = {
    sendBubbles: async (args) => {
      pushes.push(args);
      return lineCh.nextResult ?? { ok: true };
    },
    nextResult: null,
  };
  const engine = createStagedFollowups({
    config, db, hermes,
    lineRegistry: { forChannel: () => lineCh, rawUserId: (id) => id },
    // ต่อสายตารางราคาเหมือน server.mjs จริง — ไม่มีแถวในตาราง = พฤติกรรมเดิมเป๊ะ (fail-closed)
    guard: createComplianceGuard({ bannedWords: ["การันตี"], getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(),
    logger: silent,
    now: () => clock.now,
    imageCatalog: CATALOG,
    decisionReview,
  });
  const customerId = "U-staged";
  db.upsertCustomer(customerId, { displayName: "Somsak" });
  db.setFollowupEnabled(customerId, true);
  if (Number.isInteger(score)) db.recordScore(customerId, score, "{}");
  return { engine, db, clock, pushes, lineCh, customerId, draftModels };
}

// เขียนข้อความพร้อมกำหนดอายุเอง — insertMessage เดินตามนาฬิกาที่ฉีดให้ db แล้ว
// (= "ตอนนี้") บรรทัด UPDATE จึงมีไว้ย้อนข้อความไปอดีตตาม fixture เท่านั้น
test("staged cold/warm/hot follow-ups share campaign receipt policy without changing eligibility", async (t) => {
  for (const score of [3, 6, 9]) {
    const requests = [];
    const { engine, db, customerId } = makeWorld({ score, onHermesCall: (body) => requests.push(body) });
    t.after(() => db.close());
    exchangeAt(db, customerId, NOON_BKK - 25 * 60 * MIN);
    await engine.runOnce();
    assert.ok(requests.length > 0, `score ${score} must reach drafting`);
    for (const body of requests) {
      const prompt = JSON.stringify(body.messages);
      assert.match(prompt, /ห้ามเริ่มทวง ย้ำสิทธิ์/u);
      assert.match(prompt, /ไม่ถือว่าการร่วมกิจกรรมคือเจตนาซื้อ/u);
      assert.match(prompt, /หากลูกค้าบอกเองว่ายังไม่ได้รับ/u);
    }
  }
});

function messageAt(db, customerId, { direction, content = "x", atMs }) {
  const id = `m-${Math.random().toString(36).slice(2)}`;
  db.insertMessage({ id, customerId, direction, msgType: "text", content });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(atMs, id);
  return id;
}

function exchangeAt(db, customerId, atMs) {
  messageAt(db, customerId, { direction: "in", content: "สนใจครับ", atMs });
  messageAt(db, customerId, { direction: "out", content: "ยินดีค่ะ สนใจด้านไหนคะ", atMs: atMs + 1000 });
}

test("sales safety blocks bank instructions in staged followups even with reviewer off",async()=>{
  const w=makeWorld({configOverrides:{SALES_DECISION_GUARD_ENABLED:"true"},draftText:"เลขบัญชี: 0000000000 ค่ะ"});
  try {
    exchangeAt(w.db,w.customerId,NOON_BKK-5*60*MIN);
    const result=await w.engine.runOnce();
    assert.equal(w.pushes.length,0);
    assert.equal(result.results[0].skipped,"jev_review_required");
  } finally { w.db.close(); }
});

/* ------------------------------ review catalog ------------------------------ */

test("service boundary: staged pause before paid draft, during draft, and between bubbles", async () => {
  for (const when of ["before", "draft", "bubbles"]) {
    let world;
    const pause = () => world.db.setServiceBoundaryState(world.customerId, { topic: "story", paused: true });
    world = makeWorld({ score: 6, onHermesCall: async () => { if (when === "draft") pause(); } });
    const { db, engine, customerId, pushes, draftModels, lineCh } = world;
    try {
      exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
      if (when === "before") pause();
      let checked = false;
      if (when === "bubbles") lineCh.sendBubbles = async args => {
        assert.equal(args.stillRelevant(), true);
        pause();
        assert.equal(args.stillRelevant(), false);
        checked = true;
        return { ok: false, stoppedEarly: true, delivered: [] };
      };
      const out = await engine.runOnce();
      assert.equal(pushes.length, 0);
      if (when === "before") {
        assert.equal(draftModels.length, 0);
        assert.equal(out.results[0].skipped, "service_boundary");
      } else {
        assert.equal(draftModels.length, 1);
        if (when === "bubbles") assert.equal(checked, true);
        else assert.equal(out.results[0].skipped, "superseded_before_send");
      }
    } finally { db.close(); }
  }
});

test("parseReviewCatalog: อ่านรีวิวจาก knowledge entry ตามฟอร์แมตชีทชมพู่", () => {
  const reviews = parseReviewCatalog([{ title: "รีวิวนักเรียนจริง แยกตามคลาส", content: REVIEW_KNOWLEDGE, active: 1 }]);
  assert.equal(reviews.length, 3);
  assert.equal(reviews[0].url, "https://www.facebook.com/share/r/AAA111");
  assert.match(reviews[2].section, /Workflow/u);
});

test("pickReview: ไม่ซ้ำ URL ที่เคยส่ง และเลือก section ตามบริบท workflow", () => {
  const reviews = parseReviewCatalog([{ title: "รีวิวนักเรียนจริง", content: REVIEW_KNOWLEDGE, active: 1 }]);
  const sent = new Set(["https://www.facebook.com/share/r/AAA111"]);
  const plain = pickReview(reviews, { sentUrls: sent, history: [] });
  assert.equal(plain.url, "https://www.facebook.com/share/r/BBB222");
  const workflow = pickReview(reviews, { sentUrls: sent, history: [{ role: "user", content: "สนใจ workflow automation ครับ" }] });
  assert.equal(workflow.url, "https://www.facebook.com/share/v/CCC333");
  assert.equal(pickReview(reviews, { sentUrls: new Set(reviews.map((r) => r.url)) }), null, "หมดคลัง = null");
});

test("v1.4.41: pickReview ใช้ชื่อผู้รีวิวจริงเพื่อเลือกธุรกิจที่ตรง persona", () => {
  const reviews = parseReviewCatalog([{
    title: "รีวิวนักเรียนจริง",
    active: 1,
    content: [
      "[Classroom : AI Agent For Business]",
      "- คุณเอ — CEO ร้านตัดผม | รีวิว: https://www.facebook.com/share/r/HAIR111/",
      "- คุณบี — เจ้าของร้านค้าออนไลน์ | รีวิว: https://www.facebook.com/share/r/SHOP222/",
    ].join("\n"),
  }]);
  assert.equal(pickReview(reviews, { personaType: "online_seller" }).who, "คุณบี — เจ้าของร้านค้าออนไลน์");
});

test("v1.4.41: stagedRules ส่ง pain point และ persona เข้า brief โดยไม่เดา", () => {
  const rules = stagedRules({
    stage: "warm",
    scorePayload: {
      context_summary: "แม่ค้าออนไลน์ตอบลูกค้าไม่ทันช่วงกลางคืน",
      pain_point: "เสียออเดอร์เพราะตอบแชทไม่ทัน",
      persona_type: "online_seller",
      persona_read: { disc: "C" },
    },
  });
  assert.match(rules, /เสียออเดอร์เพราะตอบแชทไม่ทัน/u);
  assert.match(rules, /online_seller/u);
  assert.match(rules, /DISC\): C/u);
});

test("stagedRules ตัดข้อความเก่าโดยไม่ผ่า emoji เป็น Unicode ครึ่งตัว", () => {
  // เคสจริง 2026-08-22: ข้อความเดิมยาว 161 code units และ emoji เริ่มตรงตำแหน่ง 160
  // String#slice(0, 160) เดิมจึงเหลือ high surrogate เดี่ยว ทำให้ provider ตอบ invalid_json 400
  const previous = `${"ก".repeat(159)}😊`;
  const rules = stagedRules({ stage: "warm", previousTexts: [previous] });

  assert.equal(rules.isWellFormed(), true, "prompt ที่ส่ง provider ต้องเป็น Unicode scalar sequence ที่สมบูรณ์");
  assert.match(rules, /😊/u, "การตัดต้องรักษา emoji ทั้งตัวไว้หรือไม่ใส่เลย ห้ามเหลือครึ่งตัว");
});

// v1.4.12d (พี่ง้วงรายงาน 2026-08-18): badge ⏱ FU ไม่เคยโชว์ — listConversations ไม่ได้
// SELECT คอลัมน์ gate (followup_enabled ฯลฯ) ทำให้ previewStagedFollowup คืน null ทุกแถว
// เทสต์นี้ยิงเส้นเดียวกับ consoleApi.stagedPreviewFor: แถว inbox จริง → preview ต้องไม่ null
test("v1.4.12d: แถวจาก listConversations มีคอลัมน์ gate ครบ ให้ badge FU คำนวณได้", () => {
  const { db, customerId } = makeWorld({ score: 6 });
  exchangeAt(db, customerId, NOON_BKK - 10 * MIN);
  const row = db.listConversations().find((c) => c.line_user_id === customerId);
  for (const col of ["followup_enabled", "do_not_disturb", "marketing_consent", "ai_off_reason", "deal_status", "ai_enabled", "last_score", "handoff_summary"]) {
    assert.ok(col in row, `listConversations ต้องส่งคอลัมน์ ${col} (ขาด = badge ตายเงียบทั้ง inbox)`);
  }
  const preview = previewStagedFollowup({
    customer: row,
    state: db.getFollowupState(customerId),
    lastInboundAt: db.lastInboundAt(customerId),
    lastOutboundAt: db.lastOutboundAt(customerId),
    nowMs: NOON_BKK,
    delays: { cold: 60 * MIN, warm: 30 * MIN, hot: 30 * MIN },
  });
  assert.ok(preview, "ลูกค้า warm ที่เงียบอยู่ ต้องได้ preview (badge โชว์)");
  assert.equal(preview.stage, "warm");
  assert.ok(preview.dueAt > NOON_BKK, "dueAt ต้องเป็นเวลาข้างหน้า (นับถอยหลังได้)");
});

// v1.4.13 (พี่ง้วง "ทำไมไม่เห็น timer"): ระบบตั้งใจไม่ทัก = ต้องตอบ {blocked: เหตุผล}
// ไม่ใช่ null เงียบ — UI เอาไปโชว์ป้ายเทาบอกเหตุ (null จริง ๆ เหลือเฉพาะ AI ปิด/DND/ไม่มีแชท)
test("v1.4.13: preview บอกเหตุผลตอนไม่มี timer (ladder_done/daily_cap/cold_cap/dormant)", () => {
  const { db, customerId } = makeWorld({ score: 6 });
  exchangeAt(db, customerId, NOON_BKK - 10 * MIN);
  const row = db.listConversations().find((c) => c.line_user_id === customerId);
  const args = (state) => ({
    customer: row, state,
    lastInboundAt: db.lastInboundAt(customerId), lastOutboundAt: db.lastOutboundAt(customerId),
    nowMs: NOON_BKK, delays: { cold: 60 * MIN, warm: 30 * MIN, hot: 30 * MIN },
  });
  const base = {
    stage_key: "warm", episode_anchor: NOON_BKK, episodes_today: 1,
    sent_today: 0, today_key: "2026-01-15", cold_sent_total: 0, ladder_stage: 0,
  };
  assert.deepEqual(previewStagedFollowup(args({ ...base, ladder_stage: 3 })), { blocked: "ladder_done" });
  assert.deepEqual(previewStagedFollowup(args({ ...base, sent_today: DAILY_PROACTIVE_CAP })), { blocked: "daily_cap" });

  const coldRow = { ...row, last_score: 0 };
  assert.deepEqual(previewStagedFollowup({ ...args({ ...base, stage_key: "cold", cold_sent_total: COLD_LIFETIME_CAP }), customer: coldRow }),
    { blocked: "cold_cap" });

  // เงียบเกิน 10 วัน = เครื่องยิงจริงไม่หยิบ (ACTIVE_WITHIN_MS) — preview ห้ามโชว์ timer ผี
  const oldMs = NOON_BKK - 11 * 86_400_000;
  assert.deepEqual(previewStagedFollowup({
    customer: row, state: base,
    lastInboundAt: oldMs, lastOutboundAt: oldMs + 1000,
    nowMs: NOON_BKK, delays: { cold: 60 * MIN, warm: 30 * MIN, hot: 30 * MIN },
  }), { blocked: "dormant" });

  // เคสปิดจริง (AI off เหตุอื่น) ยังเป็น null — แถวนั้นมีป้าย "AI ปิด" อยู่แล้ว ไม่ต้องซ้ำ
  assert.equal(previewStagedFollowup({ ...args(base), customer: { ...row, ai_enabled: 0, ai_off_reason: "human_requested" } }), null);
});

/* ------------------------------ จังหวะราคา ------------------------------ */

// ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า, ข้อ 6): เส้นนี้มีช่องโหว่ทรงเดียวกับ followupEngine —
// ร่างด้วยความรู้ที่มีตารางราคาครบ ผ่าน guard ชุดเดียวกัน ส่งถึงลูกค้าจริง แต่ไม่เคยปักหมุด
test("จังหวะราคา: บันได FU ที่ส่งราคาถึงลูกค้าจริง ต้องปักหมุด price_quoted_at", async () => {
  const { engine, db, pushes, customerId } = makeWorld({
    score: 6,
    draftText: "คลาสนี้ราคา 19,900 บาท/ท่านค่ะ สนใจรอบไหนดีคะ?",
  });
  db.setApprovedPrice("AI Agent for Business", 19900);
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);

  const out = await engine.runOnce();
  assert.equal(out.results[0].sent, "review", "ฉากนี้ต้องส่งสำเร็จจริง ไม่งั้นวัดของผิดข้อ");
  assert.ok(pushes[0].bubbles.some((b) => b.text.includes("19,900")), "ตัวเลขต้องถึงมือลูกค้าจริงในรอบนี้");
  assert.ok(Number(db.getCustomer(customerId).price_quoted_at) > 0, "ราคาถึงมือลูกค้าแล้ว ต้องปักหมุด");
});

test("จังหวะราคา: บันได FU ที่ไม่มีตัวเลขราคาคลาส ห้ามปักหมุดว่าแจ้งราคาแล้ว", async () => {
  const { engine, db, customerId } = makeWorld({ score: 6 });
  db.setApprovedPrice("AI Agent for Business", 19900);
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);

  const out = await engine.runOnce();
  assert.equal(out.results[0].sent, "review");
  assert.equal(Number(db.getCustomer(customerId).price_quoted_at), 0, "รีวิว/คำถามชวนคุย ไม่ใช่การแจ้งราคา");
});

// 2026-10-03 (พี่ง้วง: "ตอบแชทแข็งเกินไป"): ห้องที่ไม่มีชื่อเรียกได้ — เดิมบอลลูนรีวิวเขียน "ของคุณลูกค้า"
// และคำถามที่โมเดลร่างก็เรียก "คุณลูกค้า" ได้ (ฟังเหมือนระบบส่งอัตโนมัติ) — ละการเรียกแบบแอดมินคนจริง
test("บันได FU ห้องที่ไม่มีชื่อเรียกได้: ไม่เรียก \"คุณลูกค้า\" ทั้งบอลลูนรีวิวและคำถาม", async () => {
  const { engine, db, pushes, customerId } = makeWorld({ score: 6, draftText: "คุณลูกค้าอยากให้ AI ช่วยงานส่วนไหนก่อนคะ?" });
  db.upsertCustomer(customerId, { displayName: "ร้านขายของชำลุงหมี" });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  const out = await engine.runOnce();
  assert.equal(out.results[0].sent, "review");
  const text = pushes[0].bubbles.map((b) => b.text).join("\n");
  assert.match(text, /ฝากรีวิวจากผู้เรียนจริงไว้ประกอบการเลือกนะคะ/u);
  assert.match(text, /อยากให้ AI ช่วยงานส่วนไหนก่อนคะ/u);
  assert.ok(!text.includes("คุณลูกค้า"), text);
  db.close();
});

/* ------------------------------ บันได warm ------------------------------ */

test("warm ladder: 4 ชม. → วันที่ 3 → วันที่ 7 แล้วจบ (คำสั่งเจ้าของ 2026-08-28)", async () => {
  const { engine, db, clock, pushes, customerId } = makeWorld({ score: 6 });
  const anchor = NOON_BKK - 5 * 60 * MIN;
  exchangeAt(db, customerId, anchor);

  // ขั้น 1: รีวิว — ครบ 4 ชม.หลังลูกค้าเงียบ
  let out = await engine.runOnce();
  assert.equal(out.results[0].sent, "review");
  assert.equal(pushes.length, 1);
  const reviewBubbles = pushes[0].bubbles.map((b) => b.text);
  assert.match(reviewBubbles[0], /ฝากรีวิวจากผู้เรียนจริง/u);
  assert.match(reviewBubbles[0], /https:\/\/www\.facebook\.com\/share\/r\/AAA111$/u, "ลิงก์ต้องเป็นบรรทัดสุดท้ายของก้อนรีวิว");
  assert.ok(reviewBubbles.length >= 2, "ต้องมีคำถามแยกบอลลูนตามหลัง — 1 ครั้งยังส่งได้หลายบับเบิลตาม funnel");

  // วันเดียวกันห้ามส่งซ้ำ (เพดาน 1 ครั้ง/วัน)
  clock.now += 3 * 60 * MIN;
  out = await engine.runOnce();
  assert.equal(out.results[0].skipped, "daily_cap");

  // ขั้น 2: รูปบรรยากาศ — วันที่ 3 นับจากลูกค้าเงียบ
  clock.now = anchor + 3 * 86_400_000 + 5 * 60 * MIN;
  out = await engine.runOnce();
  assert.equal(out.results[0].sent, "atmosphere");
  assert.equal(pushes[1].images[0].key, "classroom-atmosphere-1");

  // ขั้น 3: คำถาม — วันที่ 7
  clock.now = anchor + 7 * 86_400_000 + 5 * 60 * MIN;
  out = await engine.runOnce();
  assert.equal(out.results[0].sent, "question");

  // บันไดจบ — ไม่ส่งเพิ่มแม้เงียบต่อ
  clock.now = anchor + 9 * 86_400_000 + 5 * 60 * MIN;
  out = await engine.runOnce();
  assert.equal(out.results[0].skipped, "ladder_done");
  assert.equal(pushes.length, 3);
  db.close();
});

/* ------------------------------ hot + dedupe รีวิว ------------------------------ */

test("hot: เงียบ 45 นาที → รีวิวใบที่ยังไม่เคยส่ง + คำถาม (ใบเดิมใน DB ห้ามซ้ำ)", async () => {
  const { engine, db, clock, pushes, customerId } = makeWorld({ score: 9 });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  // เคยส่งรีวิวใบแรกไปแล้วในบทสนทนาปกติ
  messageAt(db, customerId, {
    direction: "out",
    content: "รีวิวค่ะ\nhttps://www.facebook.com/share/r/AAA111/",
    // ต้องเก่ากว่าพื้น "ห้ามทักซ้อนภายใน 45 นาทีหลังใครก็ตามเพิ่งพิมพ์"
    atMs: NOON_BKK - 3 * 60 * MIN,
  });
  const out = await engine.runOnce();
  assert.equal(out.results[0].sent, "review_question");
  assert.match(pushes[0].bubbles[0].text, /BBB222|CCC333/u, "ห้ามซ้ำใบ AAA111 ที่เคยส่ง");
});

test("AI pause ระหว่าง staged draft -> final boundary ไม่ส่ง", async () => {
  let releaseDraft;
  const gate = new Promise((resolve) => { releaseDraft = resolve; });
  let draftStarted = false;
  const world = makeWorld({ score: 6, onHermesCall: async () => { draftStarted = true; await gate; } });
  const { engine, db, pushes, customerId } = world;
  // 2026-08-28: จังหวะ warm ขั้นแรกยาวขึ้นเป็น 4 ชม. — fixture ต้องเงียบนานพอให้ถึงกำหนด
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  const pending = engine.runOnce();
  // ห้ามวนรอแบบไม่มีที่สิ้นสุด: ถ้า engine ไม่เรียก Hermes (เช่นยังไม่ถึงกำหนด) ลูปเดิม
  // จะหมุนกิน CPU ตลอดกาล และ npm test จะ "ค้าง" ไม่ใช่ "แดง" ซึ่งไล่หาสาเหตุยากกว่ามาก
  const waitStart = Date.now();
  while (!draftStarted) {
    if (Date.now() - waitStart > 5000) {
      throw new Error("engine ไม่เคยเรียก Hermes ภายใน 5 วิ — จังหวะ FU อาจยังไม่ถึงกำหนดตาม fixture");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  db.setSetting("ai_paused", "1");
  releaseDraft();
  const out = await pending;
  assert.equal(out.results[0].skipped, "ai_paused_before_send");
  assert.equal(pushes.length, 0);
  db.close();
});

/* ------------------------------ cold + เพดานตลอดชีพ ------------------------------ */

test("cold: วันละครั้ง 4 วันติด เพดานตลอดชีพ 4 ครั้ง (คำสั่งเจ้าของ 2026-08-28)", async () => {
  const { engine, db, clock, customerId, pushes } = makeWorld({ score: null });
  const anchor = NOON_BKK - 5 * 60 * MIN;
  exchangeAt(db, customerId, anchor);

  // วันที่ 1 — หลังลูกค้าเงียบ 3 ชม.
  assert.equal((await engine.runOnce()).results[0].sent, "question");

  // วันเดียวกันห้ามส่งซ้ำ
  clock.now += 4 * 60 * MIN;
  assert.equal((await engine.runOnce()).results[0].skipped, "daily_cap");

  // วันที่ 2, 3, 4 — วันละหนึ่งครั้ง
  for (const day of [1, 2, 3]) {
    clock.now = anchor + day * 86_400_000 + 5 * 60 * MIN;
    assert.equal((await engine.runOnce()).results[0].sent, "question", `วันที่ ${day + 1} ต้องได้รับ`);
  }
  assert.equal(pushes.length, 4, "รวม 4 ครั้ง วันละครั้ง");

  // บันไดจบ — เงียบต่อแค่ไหนก็ไม่ทักเพิ่มในรอบนี้
  clock.now = anchor + 6 * 86_400_000 + 5 * 60 * MIN;
  assert.equal((await engine.runOnce()).results[0].skipped, "ladder_done");

  // ลูกค้าตอบกลับ = บันไดรีเซ็ตเป็นขั้น 1 ตามปกติ แต่เพดานตลอดชีพของ cold ต้องยังกั้นอยู่
  // (ด่านนี้คือสิ่งเดียวที่กันไม่ให้ลูกค้า cold ถูกทักวนไม่รู้จบทุกครั้งที่เขาตอบ)
  exchangeAt(db, customerId, clock.now + 5 * MIN);
  clock.now += 6 * 60 * MIN;
  assert.equal((await engine.runOnce()).results[0].skipped, "cold_cap");
  assert.equal(COLD_LIFETIME_CAP, 4);
  db.close();
});

test("guards: dnd หลุดจากรายชื่อ, operator คุมอยู่ = ข้าม, quiet hours = ข้าม, เพดานวัน = ข้าม", async () => {
  const { engine, db, clock, customerId } = makeWorld({ score: 6 });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);

  db.setDoNotDisturb(customerId, true);
  assert.equal((await engine.runOnce()).results.length, 0, "do_not_disturb ต้องหลุดตั้งแต่รายชื่อ");
  db.setDoNotDisturb(customerId, false);

  db.setOperatorActiveUntil(customerId, clock.now + 10 * MIN);
  assert.equal((await engine.runOnce()).results[0].skipped, "operator_active");
  db.setOperatorActiveUntil(customerId, 0);

  clock.now = TEN_PM_BKK;
  assert.equal((await engine.runOnce()).results[0].skipped, "quiet_hours");
  clock.now = NOON_BKK;

  const st = db.getFollowupState(customerId);
  db.saveFollowupState(customerId, {
    ...(st ?? {}), sent_today: DAILY_PROACTIVE_CAP,
    today_key: new Date(clock.now + 7 * 3_600_000).toISOString().slice(0, 10),
  });
  assert.equal((await engine.runOnce()).results[0].skipped, "daily_cap");
});

test("สวิตช์: env ปิด = ทั้งรอบเงียบ, ค่า DB ชนะ env", async () => {
  const { engine, db, customerId } = makeWorld({ score: 6 });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  db.setSetting("staged_followup_enabled", "0");
  assert.equal((await engine.runOnce()).skipped, "disabled");
  db.setSetting("staged_followup_enabled", "1");
  assert.equal((await engine.runOnce()).results[0].sent, "review");
});

// 2026-08-21 (รีลีสนำร่อง 5 คน) เทสต์ตัวนี้เคยล็อกว่า "ลูกค้าใหม่ต้องไม่เข้า FU
// จนกว่าคนจะเปิดให้รายนั้น" — เหมาะกับตอนทดลองกับลูกค้าจริงแค่ 5 คน
//
// 2026-08-26 (คำสั่งพี่ง้วง ก่อนเปิดใช้จริง) เปลี่ยนเป็น: ห้องที่ "เกิดใหม่ตั้งแต่วันเปิดใช้"
// ได้ FU ตามปกติ ส่วนฐานเดิม 5,537 ห้องต้องเงียบต่อไป — ข้อหลังคือด่านกันแชทระเบิดตัวจริง
// จึงย้ายการล็อกมาไว้ที่นั่นแทน (ดู test/followup-new-customer-only.test.mjs ประกอบ)
test("ห้องที่เกิดใหม่เข้า staged FU ได้ · ฐานเดิมที่ปิดไว้ห้ามถูกเปิดย้อนหลัง", async () => {
  const { engine, db, clock, pushes } = makeWorld({ score: 6 });

  const freshId = "U-new-after-go-live";
  db.upsertCustomer(freshId, { displayName: "ลูกค้าใหม่" });
  db.recordScore(freshId, 6, "{}");
  exchangeAt(db, freshId, clock.now - 31 * MIN);
  assert.equal(db.getCustomer(freshId).followup_enabled, 1, "ห้องเกิดใหม่ = เปิด FU ให้เลย");
  assert.equal((await engine.runOnce()).results.some((row) => row.customerId === freshId), true);

  // ฐานเดิม: ปิดไว้แล้วทักซ้ำ ต้องไม่ถูกดึงกลับเข้า FU — ถ้าด่านนี้พัง ลูกค้า 5,537 คน
  // จะได้ข้อความพร้อมกันในวันเดียว ซึ่งเป็นความเสียหายที่กู้กลับไม่ได้
  const legacyId = "U-legacy-base";
  db.upsertCustomer(legacyId, { displayName: "ลูกค้าเก่า" });
  db.setFollowupEnabled(legacyId, false);
  db.recordScore(legacyId, 6, "{}");
  exchangeAt(db, legacyId, clock.now - 31 * MIN);
  db.upsertCustomer(legacyId, { displayName: "ลูกค้าเก่า (ทักซ้ำ)" });

  assert.equal(db.getCustomer(legacyId).followup_enabled, 0, "ห้ามเปิดย้อนหลัง");
  assert.equal((await engine.runOnce()).results.some((row) => row.customerId === legacyId), false);
  assert.equal(pushes.some((row) => row.to === legacyId), false);

  db.setFollowupEnabled(legacyId, true);
  assert.equal((await engine.runOnce()).results.some((row) => row.customerId === legacyId), true,
    "เปิดเองรายห้องได้ตามเดิม");
});

/* ------------------------------ ส่งล้มกลางลูป ------------------------------ */

test("ส่งล้มกลางลูป: บันทึกเฉพาะบอลลูนที่ถึงมือลูกค้าแล้ว (บทเรียนโควตาหมด)", async () => {
  const { engine, db, clock, lineCh, customerId } = makeWorld({ score: 6 });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  lineCh.nextResult = { ok: false, status: 429, delivered: [{ text: "ขออนุญาตส่งรีวิวค่ะ (ถึงแล้วก่อนล้ม)" }] };
  const out = await engine.runOnce();
  assert.equal(out.results[0].sent, "review", "ส่งได้บางส่วน = ถือว่าขั้นนี้เกิดแล้ว (กันรีวิวซ้ำ)");
  const outbound = db.raw.prepare(
    "SELECT content FROM messages WHERE customer_id = ? AND direction = 'out' AND message_class = 'proactive'",
  ).all(customerId);
  assert.equal(outbound.length, 1);
  assert.match(outbound[0].content, /ถึงแล้วก่อนล้ม/u);
});

/* ---------------- v1.4.6b: NEEDS_HUMAN ไม่ตัดระบบ / hold เฉพาะจังหวะเงิน ---------------- */

test("v1.4.6b: ธง NEEDS_HUMAN ค้าง (ไม่ใช่เรื่องเงิน) ต้องยังถูก nudge (เคสจริง 2026-08-16)", async () => {
  const { engine, db, customerId } = makeWorld({ score: 6 });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  db.setNeedsHuman(customerId, "compliance_block", "banned_word:ดีที่สุด");
  const out = await engine.runOnce();
  assert.equal(out.results[0].sent, "review", "ธงเรียกคนดู ≠ คนเป็นเจ้าของแชท — AI ต้องตาม lead ต่อได้");
});

test("urgent_mental handoff: preview และ engine ต้องหยุด proactive follow-up แม้แถวเก่ายัง ai_enabled", async () => {
  const { engine, db, customerId, pushes, draftModels } = makeWorld({ score: 6 });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  // รูปจริงจาก db.setNeedsHuman เมื่อไม่มี summary คือ `[ISO] urgent_mental` (ไม่มี colon)
  // ต้องยังเป็น sticky guard แม้ข้อมูลเก่าจะไม่ได้ปิด ai_enabled ไว้
  db.setNeedsHuman(customerId, "urgent_mental");

  const row = db.listConversations().find((entry) => entry.line_user_id === customerId);
  assert.deepEqual(previewStagedFollowup({
    customer: row,
    state: db.getFollowupState(customerId),
    lastInboundAt: db.lastInboundAt(customerId),
    lastOutboundAt: db.lastOutboundAt(customerId),
    nowMs: NOON_BKK,
    delays: { cold: 60 * MIN, warm: 30 * MIN, hot: 30 * MIN },
  }), { blocked: "urgent_mental" });

  const out = await engine.runOnce();
  assert.equal(out.results[0].skipped, "urgent_mental_handoff");
  assert.equal(draftModels.length, 0, "ห้ามเรียกโมเดลเพื่อร่างขายต่อ");
  assert.equal(pushes.length, 0, "ห้ามส่ง LINE proactive");
});

test("v1.4.6b: paymentHoldActive — hold เฉพาะจังหวะเงินที่ยังไม่มีการคุยต่อ", () => {
  const nowMs = NOON_BKK;
  const hold = `[${new Date(nowMs - 60 * MIN).toISOString()}] payment_requires_human_review: รอตรวจยอด`;
  assert.equal(paymentHoldActive({ handoffSummary: hold, nowMs, lastInboundAt: nowMs - 61 * MIN }), true, "ลูกค้าเงียบหลังแจ้งโอน = hold");
  assert.equal(paymentHoldActive({ handoffSummary: hold, nowMs, lastInboundAt: nowMs - 30 * MIN }), false, "ลูกค้าพิมพ์ใหม่หลัง hold >10 นาที = บทสนทนาเดินต่อแล้ว");
  const stale = `[${new Date(nowMs - 25 * 3_600_000).toISOString()}] payment_review: เก่าแล้ว`;
  assert.equal(paymentHoldActive({ handoffSummary: stale, nowMs, lastInboundAt: nowMs - 26 * 3_600_000 }), false, "เกิน 24 ชม. = ไม่ hold");
  assert.equal(paymentHoldActive({ handoffSummary: "[x] compliance_block: banned_word", nowMs, lastInboundAt: null }), false, "ธงชนิดอื่นไม่เกี่ยว");
});

test("v1.4.6b: จังหวะเงินยังรอคนตรวจ = engine ข้าม ไม่ nudge", async () => {
  const { engine, db, clock, customerId } = makeWorld({ score: 9 });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  db.setNeedsHuman(customerId, "payment_requires_human_review", "ลูกค้าแจ้งโอน");
  // setNeedsHuman ใช้เวลาจริง (ส.ค.) — ดึง timestamp ในบรรทัด hold มาอยู่บนแกนเวลาเทสต์
  const row = db.getCustomer(customerId);
  const retimed = row.handoff_summary.replace(/^\[[^\]]+\]/u, `[${new Date(clock.now - 20 * MIN).toISOString()}]`);
  db.raw.prepare("UPDATE customers SET handoff_summary = ? WHERE line_user_id = ?").run(retimed, customerId);
  const out = await engine.runOnce();
  assert.equal(out.results[0].skipped, "payment_in_human_review");
});

/* ------------------- v1.4.9: โมเดลแยกของเส้น follow-up ------------------- */

test("v1.4.9: FU ไม่ตั้ง followup_model = ใช้โมเดลตามตัวหลัก (reply_model)", async () => {
  const { engine, db, clock, customerId, draftModels } = makeWorld({ score: null });
  db.setSetting("reply_model", "gpt-5.6-terra");
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  assert.equal((await engine.runOnce()).results[0].sent, "question");
  assert.equal(draftModels.at(-1), "gpt-5.6-terra", "FU ต้องตามตัวหลักเมื่อไม่มี override");
});

test("v1.4.9: ตั้ง followup_model แล้ว FU ใช้โมเดลของตัวเอง ไม่แตะตัวหลัก + llm_usage บันทึกโมเดลจริง", async () => {
  const { engine, db, clock, customerId, draftModels } = makeWorld({ score: null });
  db.setSetting("reply_model", "gpt-5.6-sol");
  db.setSetting("followup_model", "gpt-5.6-luna");
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  assert.equal((await engine.runOnce()).results[0].sent, "question");
  assert.equal(draftModels.at(-1), "gpt-5.6-luna", "FU ต้องใช้ followup_model ของตัวเอง");
  const usage = db.llmUsageForCustomer(customerId);
  assert.equal(usage.at(-1).model, "gpt-5.6-luna", "หน้าเว็บต้องเห็นโมเดลที่ FU ใช้จริงจาก usage");
});

/* ------- 2026-09-05 (คำสั่งพี่ง้วง): AI ปิด = FU หยุดสนิท ไม่มีข้อยกเว้นแล้ว -------
 *
 * v1.4.11 (2026-08-18) เคยเปิดช่องให้ห้อง bank_sent ถูกทัก "ทวงโอน" ต่อได้ ทั้งที่ bot
 * หลักเงียบไปแล้ว — คำสั่งวันนี้กลับข้อยกเว้นนั้น: "ส่งให้ชมพู่ handle ต่อเอง
 * ไม่ต้อง follow up" ห้องที่ส่งต่อคนแล้วต้องไม่มีข้อความอัตโนมัติตามไปอีกเลย
 * (ของจริง 30 วัน: FU หลัง bank_sent ออกไปแค่ 1 ข้อความ — ราคาของการกลับกติกาต่ำมาก
 *  เทียบกับความเสียหายเวลาบอททักแทรกตอนชมพู่กำลังปิดการขายอยู่) */

test("2026-09-05: ai_off_reason=bank_sent + deal awaiting_payment -> FU หยุด ไม่ทักอีกเลย", async () => {
  const { engine, db, customerId, pushes } = makeWorld({ score: 9 });
  db.setAiEnabled(customerId, false, "bank_sent");
  db.setDealStatus(customerId, "awaiting_payment");
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  const out = await engine.runOnce();
  assert.ok(!out.results.length || !out.results[0]?.sent,
    `ห้องที่ส่งต่อคนแล้วห้ามมี FU ออก (ได้ ${JSON.stringify(out.results[0] ?? null)})`);
  assert.equal(pushes.length, 0, "ห้ามมีข้อความอัตโนมัติถึงลูกค้าเลย");
});

test("2026-09-05: AI ปิดด้วยเหตุใดก็ตาม (ขอคุยกับคน/จอง/ปิดมือ) -> FU หยุดสนิท", async () => {
  for (const reason of ["human_requested", "booking_handoff", "manual", ""]) {
    const { engine, db, customerId } = makeWorld({ score: 6 });
    db.setAiEnabled(customerId, false, reason);
    exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
    const out = await engine.runOnce();
    assert.ok(!out.results.length || !out.results[0]?.sent,
      `reason="${reason}" ห้ามมี FU ออก (ได้ ${JSON.stringify(out.results[0] ?? null)})`);
  }
});

test("2026-09-05: ห้องที่ AI ยังเปิดอยู่ต้องยังได้ FU ตามปกติ (กันเทสต์เขียวเพราะทุกอย่างตาย)", async () => {
  const { engine, db, customerId, pushes } = makeWorld({ score: 9 });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  const out = await engine.runOnce();
  assert.ok(out.results[0]?.sent, `ห้องปกติต้องยังถูกทัก (ได้ ${JSON.stringify(out.results[0] ?? null)})`);
  assert.equal(pushes.length, 1);
});

/* ------- v1.4.12 (คำสั่งพี่ง้วง 2026-08-18): FU = super empathy ห้ามทวง ------- */

// 2026-09-28: มุม "รักษาสิทธิ์ (ดูแลที่นั่ง/สิทธิ์ราคาไว้ให้)" ถูกแทนด้วย "ให้ลูกค้าตัดสินใจตามจังหวะของเขาเอง"
// เพราะชนกติกาเหล็กเรื่องที่นั่ง (เทสต์ถัดไป) — เจตนาเดิม "ใส่ใจ ไม่ใช่มาตามงาน" ยังอยู่ครบ
test("v1.4.12: stagedRules ทุกสเตจ = มุมใส่ใจ+อำนวยความสะดวก ห้ามทวง", async () => {
  const { stagedRules } = await import("../src/stagedFollowups.mjs");
  for (const stage of ["cold", "warm", "hot"]) {
    const rules = stagedRules({ stage });
    assert.match(rules, /ตัดสินใจตามจังหวะของเขาเอง/u, `${stage}: ต้องมีมุมไม่เร่ง ให้ลูกค้าคุมจังหวะ`);
    assert.match(rules, /อำนวยความสะดวก/u, `${stage}: ต้องมีมุมอำนวยความสะดวก`);
    assert.match(rules, /ห้ามทวงทุกวิธี/u, `${stage}: ต้องแบนการทวง`);
    assert.match(rules, /เห็นว่าค้างเรื่อง/u, `${stage}: ต้องแบนโครงประโยคเคสจริง`);
    assert.match(rules, /ไม่จำเป็นต้องเป็นคำถามทุกครั้ง/u, `${stage}: ปิดท้ายแบบเชิญชวนได้`);
  }
  // ขั้นรอชำระ: ห้ามถามว่าโอนหรือยัง — ใช้มุมอำนวยความสะดวกเท่านั้น
  const pay = stagedRules({ stage: "hot", dealStatus: "awaiting_payment", paymentNudge: true });
  assert.match(pay, /ห้ามทวงเด็ดขาด ห้ามถามว่าโอนหรือยัง/u);
  assert.match(pay, /ไม่ต้องรีบ/u);
  assert.doesNotMatch(pay, /ทวงอย่างนุ่มนวล/u, "คำว่า 'ทวง' เชิงสั่งให้ทำต้องหายไปจากกติกา");
});

// กติกาเหล็ก: ลูกแพรห้ามบอกหรือบอกเป็นนัยว่ากัน/จอง/เก็บที่นั่งไว้ให้ — ที่นั่งยืนยันโดยทีมงานหลังชำระเท่านั้น
// ผู้ตรวจโค้ด 28 ก.ย. 2026: brief ของ hot เคยสั่ง "สื่อสารว่าลูกแพรดูแลสิทธิ์/ที่นั่งไว้ให้เรียบร้อย" และกติกาขั้นรอชำระ
// สั่ง "แจ้งว่าลูกแพรดูแลสิทธิ์ราคา/ที่นั่งไว้ให้เรียบร้อยแล้ว" = คำสั่งให้พูดสิ่งที่ห้ามพูด (FU ก.ย. 2,616 ข้อความ
// ยังไม่หลุดสักข้อความ แต่คำสั่งเชิญให้หลุด)
const SEAT_HOLDING = /ที่นั่ง[^\n—]{0,20}ไว้ให้|สิทธิ์[^\n—]{0,20}ไว้ให้|ดูแลที่นั่ง|ดูแลสิทธิ์|รักษาสิทธิ์|กันที่นั่ง|กันที่ไว้|กันที่ให้|จอง[^\n—]{0,12}ไว้ให้|จองที่นั่งให้|(?:ล็อก|ล็อค)(?:ที่นั่ง|สิทธิ์)|เก็บที่นั่ง|สำรองที่นั่ง|\b(?:hold|reserve|keep)\w*\s+(?:your|a|the)\s+seat/iu;

test("กติกาที่นั่ง: brief ของ hot และกติกาขั้นรอชำระไม่มีคำที่แปลว่ากัน/จอง/เก็บที่นั่งไว้ให้", async () => {
  const { STAGE_QUESTION_BRIEF, PAYMENT_NUDGE_RULE } = await import("../src/stagedFollowups.mjs");
  // ตัวจับต้องจับถ้อยคำเดิมได้จริง ไม่งั้นเทสต์นี้ผ่านเพราะจับอะไรไม่ได้เลย
  for (const old of [
    "สื่อสารว่าลูกแพรดูแลสิทธิ์/ที่นั่งไว้ให้เรียบร้อย",
    "แจ้งว่าลูกแพรดูแลสิทธิ์ราคา/ที่นั่ง ไว้ให้เรียบร้อยแล้ว",
    "รักษาสิทธิ์ให้ (ดูแลที่นั่ง/สิทธิ์ราคาไว้ให้อยู่)",
    "ลูกแพรจองที่นั่งไว้ให้ก่อนได้ค่ะ",
    "we will hold your seat",
  ]) assert.match(old, SEAT_HOLDING, old);

  assert.doesNotMatch(STAGE_QUESTION_BRIEF.hot, SEAT_HOLDING);
  assert.match(STAGE_QUESTION_BRIEF.hot, /เชิญให้แจ้งรอบที่สะดวกได้เมื่อพร้อม/u, "เจตนาขายเดิม: ชวนยืนยันเมื่อพร้อม");
  assert.match(STAGE_QUESTION_BRIEF.hot, /ทีมงานเป็นผู้ยืนยันที่นั่ง/u, "ที่นั่งยืนยันโดยทีมงาน ไม่ใช่ลูกแพร");
  assert.doesNotMatch(PAYMENT_NUDGE_RULE, SEAT_HOLDING);
  assert.match(PAYMENT_NUDGE_RULE, /ทีมงานจะยืนยันที่นั่งให้หลังได้รับการชำระ/u);
  for (const brief of Object.values(STAGE_QUESTION_BRIEF)) assert.doesNotMatch(brief, SEAT_HOLDING, brief);

  // ทั้งชุดกติกา: คำพวกนี้โผล่ได้เฉพาะในบรรทัด "ห้าม..." เท่านั้น และทุกสเตจต้องมีบรรทัดห้ามนั้นจริง
  const { stagedRules } = await import("../src/stagedFollowups.mjs");
  for (const args of [
    { stage: "cold" }, { stage: "warm" }, { stage: "hot" }, { stage: "warm", dealStatus: "price_sent" },
    { stage: "hot", dealStatus: "awaiting_payment", paymentNudge: true },
  ]) {
    const rules = stagedRules(args);
    assert.match(rules, /^- ห้ามพูดหรือบอกเป็นนัยว่าลูกแพรจอง กัน ล็อก หรือเก็บที่นั่งไว้ให้/mu, JSON.stringify(args));
    assert.ok(rules.includes(STAGE_QUESTION_BRIEF[args.stage]));
    for (const line of rules.split("\n")) {
      if (SEAT_HOLDING.test(line)) assert.match(line, /^- ห้าม/u, `${JSON.stringify(args)}: ${line}`);
    }
  }
  assert.ok(stagedRules({ stage: "hot", dealStatus: "awaiting_payment", paymentNudge: true }).includes(PAYMENT_NUDGE_RULE));
});

// audit 2026-08-26 (วิกฤต): ตอน AI ถูกหยุดทั้งระบบ processCustomer เด้งออกก่อนเขียน
// สถานะใด ๆ = เครื่องยนต์ไม่ได้ "พัก" แต่ "ถูกแช่แข็ง" วินาทีที่เปิด AI กลับมา
// รอบถัดไปจะเห็นลูกค้าทุกคนที่คุยใน 3 วันครบทีเดียวและยิงข้อความทักตามพร้อมกันทั้งกอง
// พี่ง้วงมีลูกค้า 5,525 ราย — กองนั้นทั้งกินโควตา LINE และทำแบรนด์พังในนาทีเดียว
test("staged: กลับมาจากสถานะหยุด ต้องข้ามรอบแรกทั้งรอบ ไม่ยิงข้อความย้อนหลัง", async () => {
  const { engine, db, pushes, clock } = makeWorld({ score: 80 });
  db.setSetting("staged_followup_enabled", "1");

  db.setSetting("ai_paused", "1");
  assert.equal((await engine.runOnce()).skipped, "ai_paused");
  assert.equal(pushes.length, 0);

  // เปิด AI กลับมา — รอบแรกต้องไม่ส่งอะไรเลย
  db.setSetting("ai_paused", "0");
  const resumed = await engine.runOnce();
  assert.equal(resumed.skipped, "resume_grace", "รอบแรกหลังกลับมาต้องข้ามทั้งรอบ");
  assert.equal(pushes.length, 0, "ห้ามยิงข้อความทักตามย้อนหลังทันทีที่เปิด AI");

  // รอบถัดไปทำงานตามปกติ (จะส่งหรือไม่ส่งขึ้นกับเงื่อนไขอื่น แต่ต้องไม่ใช่ resume_grace)
  clock.now += 60_000;
  const next = await engine.runOnce();
  assert.notEqual(next.skipped, "resume_grace");
});

test("staged: มีผู้เข้าเกณฑ์เกินเพดาน ต้องทยอยทำ ไม่ยิงทั้งกองในรอบเดียว", async () => {
  const { engine, db } = makeWorld({ score: 80 });
  db.setSetting("staged_followup_enabled", "1");
  db.setSetting("ai_paused", "0");
  await engine.runOnce(); // กิน resume grace ไปก่อน (lastTickPaused เริ่มเป็น null)

  // สร้างผู้เข้าเกณฑ์ให้เกินเพดานชัด ๆ
  for (let i = 0; i < 12; i += 1) {
    const id = `U-flood-${i}`;
    db.upsertCustomer(id, { displayName: `ลูกค้า ${i}` });
    db.setFollowupEnabled(id, true);
    db.recordScore(id, 80, "{}");
    db.insertMessage({ customerId: id, direction: "in", msgType: "text", content: "สนใจค่ะ" });
  }
  const result = await engine.runOnce();
  assert.ok(Array.isArray(result.results), JSON.stringify(result));
  assert.ok(result.results.length <= 5, `ทำได้ไม่เกิน 5 คนต่อรอบ (ได้ ${result.results.length})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.4.49 (คำสั่งเจ้าของ 2026-08-29): "ถ้าเราให้คลาสฟรีไปแล้ว ให้หยุด FU ปกติ
// แต่ให้ FU หลังจากให้คลาสไปแล้ว 7 วัน แล้วค่อยตามต่อ"
//
// เหตุผลทางธุรกิจ: คนเพิ่งได้คลาสฟรี = กำลังอยู่ในช่วงได้รับของขวัญ การทวงถามซ้ำ
// ในจังหวะนั้นทั้งน่ารำคาญและทำลายน้ำใจของของขวัญ — เว้น 7 วันให้เขาได้ลองเรียนก่อน
//
// กลไก: ทีมงานติดป้ายที่มีคำว่า "คลาสฟรี" (ของจริงใช้ "รับคลาสฟรีจากlive" อยู่แล้ว 13 คน)
// → FU เงียบ 7 วันนับจากวันติดป้าย → พ้นแล้วกลับเข้าจังหวะปกติเอง
// ป้าย lead magnet เก่า ("รับ GEN AI ฟรี" 735 คน) ไม่มีคำว่า "คลาสฟรี" จึงไม่โดน
// และป้ายเก่าที่ติดมานานเกิน 7 วันก็พ้นหน้าต่างไปแล้วโดยนิยาม
import { FREE_CLASS_QUIET_MS } from "../src/db.mjs";

test("v1.4.49: ป้ายคลาสฟรีอายุไม่ถึง 7 วัน = หายจากรายชื่อ FU · ครบ 7 วัน = กลับมาเอง", () => {
  const now = 1_800_000_000_000;
  const db = memoryDb({ now: () => now });
  const seed = (id, tag, taggedAgoMs) => {
    db.upsertCustomer(id, {});
    db.raw.prepare("UPDATE customers SET followup_enabled=1 WHERE line_user_id=?").run(id);
    db.insertMessage({ id: `in:${id}`, customerId: id, direction: "in", msgType: "text", content: "สนใจค่ะ" });
    db.raw.prepare("UPDATE messages SET created_at=? WHERE customer_id=?").run(now - 3600_000, id);
    if (tag) db.raw.prepare("INSERT INTO customer_tags (customer_id, tag, source, created_at) VALUES (?,?,?,?)")
      .run(id, tag, "human", now - taggedAgoMs);
  };
  seed("U-fresh-gift", "รับคลาสฟรีจากlive", 2 * 86400_000);          // เพิ่งได้ 2 วัน
  seed("U-old-gift", "รับคลาสฟรีจากlive", FREE_CLASS_QUIET_MS + 3600_000); // พ้น 7 วันแล้ว
  seed("U-lead-magnet", "รับ GEN AI ฟรี", 3600_000);                  // ป้ายแจกของ ไม่ใช่คลาสฟรี
  seed("U-no-tag", null, 0);

  const ids = db.listStagedFollowupCandidates({ nowMs: now, activeWithinMs: 10 * 86400_000 })
    .map((c) => c.line_user_id);
  assert.ok(!ids.includes("U-fresh-gift"), "เพิ่งได้คลาสฟรี ต้องเงียบ");
  assert.ok(ids.includes("U-old-gift"), "ครบ 7 วันต้องกลับมาตามต่อเอง");
  assert.ok(ids.includes("U-lead-magnet"), "ป้ายแจกของเก่าห้ามโดนหางเลข");
  assert.ok(ids.includes("U-no-tag"), "คนไม่มีป้ายไม่กระทบ");
  db.close();
});

// 31 ส.ค. 2026: เส้น FU ลืมส่ง cachedIn ให้ addLlmUsage ทำให้รายงานต้นทุนของมัน
// แพงเกินจริง (โชว์แคช 0% ตลอด ทั้งที่ prompt ขึ้นต้นเหมือนเส้นแชทปกติที่แคชโดน 70%)
test("FU ต้องบันทึกจำนวนโทเคนที่ได้ราคาแคชด้วย ไม่ใช่แค่ยอดรวม", async () => {
  const { engine, db, customerId } = makeWorld({ score: null });
  exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
  assert.equal((await engine.runOnce()).results[0].sent, "question");
  const row = db.llmUsageSummary(0).find((r) => r.kind === "staged_followup");
  assert.ok(row, "ต้องมีแถว usage ของ staged_followup");
  assert.equal(row.tokens_in, 100);
  assert.equal(row.cached_in, 70, "ตัวเลขแคชจาก provider ต้องลงฐานข้อมูล ไม่งั้นบิลที่รายงานสูงเกินจริง");
});

function stagedJudge({ mode = "enforce", action = "allow", duringReview = null } = {}) {
  const calls = [];
  return {
    enabled: true,
    calls,
    async review(input) {
      calls.push(input);
      await duringReview?.();
      return { id: "jev-staged-fixture", mode, action };
    },
  };
}

test("JEV enforce staged follow-up judges after draft: reject blocks; allow sends", async () => {
  for (const [action, expectedSends] of [["human_review", 0], ["allow", 1]]) {
    const judge = stagedJudge({ action });
    const { engine, db, pushes, customerId } = makeWorld({ score: 6, decisionReview: judge });
    try {
      exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
      const result = await engine.runOnce();
      assert.equal(judge.calls.length, 1, "ต้องตัดสินหลังร่างหนึ่งครั้ง");
      assert.equal(judge.calls[0].stage, "followup");
      assert.equal(pushes.length, expectedSends);
      assert.equal(expectedSends ? result.results[0].sent : result.results[0].skipped, expectedSends ? "review" : "jev_review_required");
    } finally { db.close(); }
  }
});

test("JEV review rechecks inbound and operator takeover before staged send", async () => {
  for (const change of ["inbound", "operator_off"]) {
    let db;
    const judge = stagedJudge({ duringReview: () => {
      if (change === "inbound") messageAt(db, "U-staged", { direction: "in", content: "ขอหยุดก่อนค่ะ", atMs: NOON_BKK + 1 });
      else db.setAiEnabled("U-staged", false);
    } });
    const world = makeWorld({ score: 6, decisionReview: judge });
    db = world.db;
    try {
      exchangeAt(db, world.customerId, NOON_BKK - 5 * 60 * MIN);
      const result = await world.engine.runOnce();
      assert.equal(judge.calls.length, 1);
      assert.equal(world.pushes.length, 0, `${change} ระหว่าง judge ห้ามส่ง`);
      assert.equal(result.results[0].skipped, "jev_review_required");
    } finally { db.close(); }
  }
});

test("JEV shadow rejection leaves staged follow-up delivery unchanged", async () => {
  const judge = stagedJudge({ mode: "shadow", action: "human_review" });
  const { engine, db, pushes, customerId } = makeWorld({ score: 6, decisionReview: judge });
  try {
    exchangeAt(db, customerId, NOON_BKK - 5 * 60 * MIN);
    const result = await engine.runOnce();
    assert.equal(judge.calls.length, 1);
    assert.equal(pushes.length, 1, "shadow verdict ห้ามเปลี่ยนการส่งเดิม");
    assert.equal(result.results[0].sent, "review");
  } finally { db.close(); }
});
