// G2a F5 — Follow-up Engine v1: guard ครบทุกชั้น (global/customer/human/dnd/consent/
// replied/quiet hours), guard block -> skipped + NEEDS_HUMAN, opt-out ผ่าน safety router,
// sync lock, scheduler arming (ทุกอย่าง mock — ห้ามแตะ network จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import {
  createFollowupEngine, followupGlobalEnabled, inQuietHours, nextQuietEnd, bangkokHour,
} from "../src/followupEngine.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, sleep, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// เวลาอ้างอิงแบบ fix เสมอ — ห้ามให้ผลเทสต์ขึ้นกับเวลาจริงของเครื่อง (quiet hours!)
const NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0); // 12:00 เวลาไทย
const TEN_PM_BKK = Date.UTC(2026, 0, 15, 15, 0, 0); // 22:00 เวลาไทย
const FIVE_AM_BKK = Date.UTC(2026, 0, 15, 22, 0, 0); // 05:00 เวลาไทย (วันถัดไป)

function makeEngine({ configOverrides = {}, hermesFetch, lineFetch, now, decisionReview = null } = {}) {
  const config = testConfig({ FOLLOWUP_ENABLED: "true", ...configOverrides });
  // นาฬิกาเดียวทั้งเทสต์ — db ต้องอ่านเวลาตัวเดียวกับ engine ไม่งั้นแถวที่ engine เขียน
  // จะไปอยู่บนแกน wall clock แล้วเทสต์เน่าเองเมื่อวันจริงเดินผ่านวันที่ตรึงไว้
  const clock = now ?? (() => NOON_BKK);
  const db = memoryDb({ now: clock });
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermes = createHermesBridge({
    config,
    fetchImpl: hermesFetch ?? hermesFetchStub("สวัสดีค่ะ วันก่อนคุยกันเรื่องเครื่องฟอกค้างไว้ สนใจรุ่นเดิมอยู่ไหมคะ"),
    logger: silent,
  });
  const line = createLineClient({ config, fetchImpl: lineFetch ?? lineFetchStub(), sleep: async () => {}, logger: silent });
  const guard = createComplianceGuard({ bannedWords: ["การันตี"], getApprovedPrices: () => db.approvedPrices() });
  const engine = createFollowupEngine({
    config, db, hermes, line, guard,
    humanizer: createHumanizer(),
    logger: silent,
    now: clock,
    decisionReview,
  });
  return { engine, db, config, hermesFetch: hermesFetch ?? null, lineFetch: lineFetch ?? null };
}

// ตั้งนัดที่ "ถึงเวลาแล้ว" เทียบกับ now ของ engine
test("scheduled follow-up receives campaign no-chasing policy despite an old reminder note", async (t) => {
  const hermesFetch = hermesFetchStub("สนใจนำ AI ไปช่วยงานด้านไหนคะ?");
  const { engine, db } = makeEngine({ hermesFetch });
  t.after(() => db.close());
  dueFollowup(db, "U-campaign-fu", { note: "ถามว่าได้รับเอกสารจากกิจกรรมหรือยัง" });
  const result = await engine.runDue();
  assert.equal(result.results[0].status, "sent");
  const prompt = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(prompt, /ห้ามเริ่มทวง ย้ำสิทธิ์/u);
  assert.match(prompt, /แม้โน้ตกิจกรรม ประวัติเก่า/u);
  assert.match(prompt, /หากลูกค้าบอกเองว่ายังไม่ได้รับ/u);
});

function dueFollowup(db, customerId, { note = "", atMs = NOON_BKK - 1000 } = {}) {
  db.upsertCustomer(customerId, {});
  db.setFollowupEnabled(customerId, true);
  // created_at เดินตามนาฬิกาที่ฉีดให้ db แล้ว (= "ตอนนี้" ของ engine) ด่าน customer_replied
  // จึงเทียบกับเวลาเดียวกันทั้งสองฝั่ง ไม่ต้องปะ created_at ด้วยมืออีก
  const fu = db.createFollowup({ customerId, scheduledAt: atMs, createdBy: "nok", note });
  return db.getFollowup(fu.id);
}

/* ------------------------------- quiet hours -------------------------------- */

test("service boundary: scheduled follow-up pauses before paid draft and rechecks after draft", async () => {
  for (const duringDraft of [false, true]) {
    let db;
    const lineFetch = lineFetchStub();
    const hermesFetch = hermesFetchStub("สนใจเรียนหัวข้อไหนคะ?", { onCall: () => {
      if (duringDraft) db.setServiceBoundaryState("U-service", { topic: "song", paused: true });
    } });
    const world = makeEngine({ hermesFetch, lineFetch });
    db = world.db;
    try {
      const fu = dueFollowup(db, "U-service");
      if (!duringDraft) db.setServiceBoundaryState("U-service", { topic: "song", paused: true });
      await world.engine.runDue();
      assert.equal(db.getFollowup(fu.id).status, "skipped");
      assert.equal(lineFetch.sends.length, 0);
      assert.equal(hermesFetch.calls.length, duringDraft ? 1 : 0);
      if (!duringDraft) assert.equal(db.getFollowup(fu.id).detail, "service_boundary");
    } finally { db.close(); }
  }
});

test("quiet hours: 21:00-09:00 เวลาไทย + nextQuietEnd เลื่อนไป 09:00 ที่ใกล้ที่สุด", () => {
  assert.equal(bangkokHour(NOON_BKK), 12);
  assert.equal(inQuietHours(NOON_BKK), false);
  assert.equal(inQuietHours(TEN_PM_BKK), true);
  assert.equal(inQuietHours(FIVE_AM_BKK), true);
  // ขอบพอดี: 21:00 = quiet, 09:00 = ไม่ quiet
  assert.equal(inQuietHours(Date.UTC(2026, 0, 15, 14, 0, 0)), true, "21:00 ไทยต้อง quiet");
  assert.equal(inQuietHours(Date.UTC(2026, 0, 15, 2, 0, 0)), false, "09:00 ไทยต้องส่งได้");
  // 22:00 คืนนี้ -> 09:00 พรุ่งนี้ / 05:00 เช้ามืด -> 09:00 วันเดียวกัน
  assert.equal(bangkokHour(nextQuietEnd(TEN_PM_BKK)), 9);
  assert.ok(nextQuietEnd(TEN_PM_BKK) > TEN_PM_BKK);
  assert.equal(bangkokHour(nextQuietEnd(FIVE_AM_BKK)), 9);
  assert.ok(nextQuietEnd(FIVE_AM_BKK) - FIVE_AM_BKK < 5 * 3_600_000, "เช้ามืดเลื่อนไป 09:00 วันเดียวกัน");
});

/* ------------------------------ global switch ------------------------------- */

test("global switch: DB runtime ชนะ env, อ่าน DB พัง = ปิด (fail-closed)", () => {
  const db = memoryDb();
  const onCfg = { followupEnabled: true };
  const offCfg = { followupEnabled: false };
  assert.equal(followupGlobalEnabled({ db, config: onCfg }), true, "ไม่มี override = ตาม env");
  assert.equal(followupGlobalEnabled({ db, config: offCfg }), false);
  db.setSetting("followup_enabled", "0");
  assert.equal(followupGlobalEnabled({ db, config: onCfg }), false, "DB '0' ชนะ env true");
  db.setSetting("followup_enabled", "1");
  assert.equal(followupGlobalEnabled({ db, config: offCfg }), true, "DB '1' ชนะ env false");
  db.close();
  const broken = { getSetting() { throw new Error("db down"); } };
  assert.equal(followupGlobalEnabled({ db: broken, config: onCfg }), false, "DB พัง = ปิด");
});

/* -------------------------------- happy path -------------------------------- */

test("F5: นัดถึงเวลา + ทุก guard ผ่าน -> push proactive + status sent", async () => {
  const lineFetch = lineFetchStub();
  const hermesFetch = hermesFetchStub("สวัสดีค่ะคุณบี วันก่อนคุยเรื่อง X5Pro ค้างไว้ ตอนนี้สะดวกคุยต่อไหมคะ");
  const { engine, db } = makeEngine({ hermesFetch, lineFetch });
  db.setSetting("scorer_suggestions_enabled", "1"); // Advice reuse is now opt-in.
  db.upsertCustomer("U-fu", {});
  db.setKnownName("U-fu", "บี");
  db.insertMessage({ customerId: "U-fu", direction: "in", content: "สนใจ X5Pro ค่ะ" });
  db.recordScore("U-fu", 6, JSON.stringify({
    score: 6, trend: "flat", buying_signals: [],
    persona_read: { disc: "S", bank: "Nurturing", reason: "ห่วงลูกเล็ก" },
    next_move: "เน้นความปลอดภัยและประกัน", suggested_question: "",
  }));
  const fu = dueFollowup(db, "U-fu", { note: "ลูกค้ารอเทียบรุ่นกับ X3Pro" });
  // ข้อความเข้าเก่ากว่านัด — ไม่ติด guard customer_replied
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(fu.created_at - 5000, "U-fu");

  const result = await engine.runDue();
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].status, "sent");
  assert.equal(db.getFollowup(fu.id).status, "sent");
  // ส่งแบบ push (ไม่มี reply token) + log เป็น proactive
  assert.ok(lineFetch.sends.every((c) => c.url.endsWith("/v2/bot/message/push")));
  const outbound = db.messagesFor("U-fu").filter((m) => m.direction === "out");
  assert.ok(outbound.length >= 1);
  assert.ok(outbound.every((m) => m.message_class === "proactive"), "follow-up ต้องเป็น proactive");
  // context ที่ส่งให้ Hermes ต้องมีโน้ต + persona + next_move
  const rules = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(rules.includes("ลูกค้ารอเทียบรุ่นกับ X3Pro"), "note ต้องเข้า prompt");
  assert.ok(rules.includes("(DISC): S"), "persona read ต้องเข้า prompt");
  assert.ok(rules.includes("เน้นความปลอดภัยและประกัน"), "next_move ต้องเข้า prompt");
  db.close();
});

// ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า, ข้อ 6): db.markPriceQuoted เคยมีผู้เรียกอยู่ที่เดียว
// คือเส้น reactive ทั้งที่เส้นนี้ร่างด้วยความรู้ที่มีตารางราคาครบและผ่าน guard ชุดเดียวกัน
// ห้องที่ได้ราคาไปทาง follow-up จึงยัง "ติดค้างราคา" ในสายตาระบบตลอดไป แล้วเทิร์นถัดไป
// ของเส้นตอบปกติจะสั่ง "คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ" ซ้ำ ทั้งที่เพิ่งบอกไปเมื่อกี้
test("จังหวะราคา: follow-up ที่มีราคาถึงมือลูกค้าจริง ต้องปักหมุด price_quoted_at", async () => {
  const hermesFetch = hermesFetchStub("คลาส AI Agent for Business ราคา 19,900 บาท/ท่านค่ะ สนใจรอบไหนดีคะ");
  const { engine, db } = makeEngine({ hermesFetch });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.upsertCustomer("U-fu-price", {});
  // ห้องนี้เคยถูกคัดกรองไปแล้วแต่ยังไม่เคยได้ตัวเลข = ติดค้างราคาอยู่
  db.markPriceDeferred("U-fu-price");
  const fu = dueFollowup(db, "U-fu-price");
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(fu.created_at - 5000, "U-fu-price");

  const result = await engine.runDue();
  assert.equal(result.results[0].status, "sent", "ฉากนี้ต้องส่งสำเร็จจริง ไม่งั้นวัดของผิดข้อ");
  assert.ok(Number(db.getCustomer("U-fu-price").price_quoted_at) > 0, "ราคาถึงมือลูกค้าแล้ว ต้องปักหมุด");
  db.close();
});

test("จังหวะราคา: follow-up ที่ไม่มีตัวเลขราคาคลาส ห้ามปักหมุดว่าแจ้งราคาแล้ว", async () => {
  const hermesFetch = hermesFetchStub("วันก่อนคุยกันค้างไว้ ตอนนี้สะดวกคุยต่อไหมคะ");
  const { engine, db } = makeEngine({ hermesFetch });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.upsertCustomer("U-fu-noprice", {});
  const fu = dueFollowup(db, "U-fu-noprice");
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(fu.created_at - 5000, "U-fu-noprice");

  const result = await engine.runDue();
  assert.equal(result.results[0].status, "sent");
  assert.equal(Number(db.getCustomer("U-fu-noprice").price_quoted_at), 0, "ข้อความชวนคุยเปล่า ๆ ไม่ใช่การแจ้งราคา");
  db.close();
});

/* --------------------------------- guards ----------------------------------- */

test("suggestion OFF: follow-up still runs but never reads stale scorer advice", async t => {
  const hermesFetch = hermesFetchStub("สะดวกคุยเรื่องคลาสต่อไหมคะ");
  const lineFetch = lineFetchStub();
  const { engine, db } = makeEngine({ hermesFetch, lineFetch });
  t.after(() => db.close());
  const fu = dueFollowup(db, "U-advice-off", { note: "นัดคุยเรื่องคลาส" });
  db.recordScore("U-advice-off", 6, JSON.stringify({ score: 6, trend: "flat", persona_read: { disc: "S" },
    next_move: "STALE_ADVICE_MUST_NOT_REENTER", suggested_question: "STALE_QUESTION" }));
  const result = await engine.runDue();
  assert.equal(result.results[0].status, "sent");
  assert.equal(db.getFollowup(fu.id).status, "sent");
  assert.equal(hermesFetch.calls.length, 1);
  const rules = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.doesNotMatch(rules, /STALE_ADVICE|STALE_QUESTION/);
  assert.match(rules, /นัดคุยเรื่องคลาส/);
  assert.ok(lineFetch.sends.length > 0);
});

test("F5 guard: global ปิด (env default false, ไม่มี override) -> ไม่แตะนัดเลย", async () => {
  const { engine, db } = makeEngine({ configOverrides: { FOLLOWUP_ENABLED: "false" } });
  const fu = dueFollowup(db, "U-goff");
  const result = await engine.runDue();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "followup_disabled");
  assert.equal(db.getFollowup(fu.id).status, "pending", "global ปิด = นัดค้างไว้ ไม่ยกเลิก");
  db.close();
});

test("F5 guard: สวิตช์ runtime ใน DB เปิดทับ env ปิด -> ส่งได้", async () => {
  const { engine, db } = makeEngine({ configOverrides: { FOLLOWUP_ENABLED: "false" } });
  db.setSetting("followup_enabled", "1");
  const fu = dueFollowup(db, "U-gon");
  const result = await engine.runDue();
  assert.equal(result.processed, 1);
  assert.equal(db.getFollowup(fu.id).status, "sent");
  db.close();
});

test("F5 guard: customer followup_enabled=0 -> skipped customer_disabled", async () => {
  const { engine, db } = makeEngine({});
  const fu = dueFollowup(db, "U-coff");
  db.setFollowupEnabled("U-coff", false);
  await engine.runDue();
  const row = db.getFollowup(fu.id);
  assert.equal(row.status, "skipped");
  assert.equal(row.detail, "customer_disabled");
  db.close();
});

test("F5 guard: human-owned (AI ปิด หรือ NEEDS_HUMAN) -> skipped human_owned", async () => {
  const { engine, db } = makeEngine({});
  const fu1 = dueFollowup(db, "U-aioff");
  db.setAiEnabled("U-aioff", false);
  const fu2 = dueFollowup(db, "U-needs");
  db.setNeedsHuman("U-needs", "complaint");
  await engine.runDue();
  assert.equal(db.getFollowup(fu1.id).status, "skipped");
  assert.equal(db.getFollowup(fu1.id).detail, "human_owned");
  assert.equal(db.getFollowup(fu2.id).status, "skipped");
  assert.equal(db.getFollowup(fu2.id).detail, "human_owned");
  db.close();
});

test("F5 guard: do_not_disturb -> skipped", async () => {
  const { engine, db } = makeEngine({});
  const fu = dueFollowup(db, "U-dnd");
  db.setDoNotDisturb("U-dnd", true);
  await engine.runDue();
  assert.equal(db.getFollowup(fu.id).detail, "do_not_disturb");
  db.close();
});

test("F5 guard: marketing_consent ถูกปฏิเสธ (-1) -> skipped consent_refused", async () => {
  const { engine, db } = makeEngine({});
  const fu = dueFollowup(db, "U-consent");
  db.raw.prepare("UPDATE customers SET marketing_consent = -1 WHERE line_user_id = ?").run("U-consent");
  await engine.runDue();
  assert.equal(db.getFollowup(fu.id).detail, "consent_refused");
  db.close();
});

test("F5 guard: ลูกค้าตอบหลังตั้งนัด -> skipped customer_replied (ไม่ทักซ้ำ)", async () => {
  const lineFetch = lineFetchStub();
  const { engine, db } = makeEngine({ lineFetch });
  const fu = dueFollowup(db, "U-replied");
  // ลูกค้าทักเข้ามา "หลัง" นัดถูกสร้าง
  db.insertMessage({ customerId: "U-replied", direction: "in", content: "ขอบคุณค่ะ ได้ของแล้ว" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(fu.created_at + 5000, "U-replied");
  await engine.runDue();
  assert.equal(db.getFollowup(fu.id).status, "skipped");
  assert.equal(db.getFollowup(fu.id).detail, "customer_replied");
  assert.equal(lineFetch.sends.length, 0);
  db.close();
});

// H2: race — guard ทุกชั้นผ่านตอนเริ่ม แต่ระหว่าง Hermes ร่าง (นานได้ถึง 90s) สถานะเปลี่ยน
// ต้องเช็คซ้ำก่อนยิงจริง: แอดมิน takeover (ai_enabled ปิด) = ทิ้งนัด superseded_before_send ไม่ push
test("H2 race: ai_enabled ถูกปิดระหว่างร่าง -> superseded_before_send ไม่ส่ง", async () => {
  const lineFetch = lineFetchStub();
  let db; // ผูกภายหลัง — ใช้ปิด AI ตอน Hermes กำลังร่าง (จังหวะระหว่าง draft กับ send)
  const hermesFetch = hermesFetchStub("ทักตามนัดค่ะ สะดวกคุยต่อไหมคะ", {
    onCall: () => db.setAiEnabled("U-race", false),
  });
  const engineBundle = makeEngine({ hermesFetch, lineFetch });
  db = engineBundle.db;
  const fu = dueFollowup(db, "U-race");
  await engineBundle.engine.runDue();
  const row = db.getFollowup(fu.id);
  assert.equal(row.status, "skipped");
  assert.equal(row.detail, "superseded_before_send");
  assert.equal(lineFetch.sends.length, 0, "AI ถูกปิดระหว่างร่าง = ห้าม push");
  db.close();
});

test("H2 race: ลูกค้าทักเข้ามาใหม่ระหว่างร่าง -> superseded_before_send ไม่ส่ง", async () => {
  const lineFetch = lineFetchStub();
  let db;
  const hermesFetch = hermesFetchStub("ทักตามนัดค่ะ สะดวกคุยต่อไหมคะ", {
    onCall: () => {
      // ลูกค้าส่งข้อความเข้ามา "หลัง" นัดถูกสร้าง ระหว่างที่ Hermes กำลังร่าง
      const mid = db.insertMessage({ customerId: "U-race2", direction: "in", content: "สนใจค่ะ" });
      db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?")
        .run(db.getFollowup(fu.id).created_at + 10_000, mid);
    },
  });
  const engineBundle = makeEngine({ hermesFetch, lineFetch });
  db = engineBundle.db;
  const fu = dueFollowup(db, "U-race2");
  await engineBundle.engine.runDue();
  const row = db.getFollowup(fu.id);
  assert.equal(row.status, "skipped");
  assert.equal(row.detail, "superseded_before_send");
  assert.equal(lineFetch.sends.length, 0, "ลูกค้าทักใหม่ระหว่างร่าง = ห้าม push ซ้ำ");
  db.close();
});

test("F5 guard: quiet hours (22:00 ไทย) -> เลื่อนไป 09:00 ถัดไป ยัง pending ไม่ยกเลิก", async () => {
  const hermesFetch = hermesFetchStub();
  const { engine, db } = makeEngine({ hermesFetch, now: () => TEN_PM_BKK });
  const fu = dueFollowup(db, "U-quiet", { atMs: TEN_PM_BKK - 1000 });
  const result = await engine.runDue();
  assert.equal(result.results[0].status, "deferred");
  const row = db.getFollowup(fu.id);
  assert.equal(row.status, "pending", "quiet hours = เลื่อน ไม่ยกเลิก");
  assert.equal(row.scheduled_at, nextQuietEnd(TEN_PM_BKK));
  assert.equal(row.detail, "quiet_hours_deferred");
  assert.equal(hermesFetch.calls.length, 0, "ยังไม่ถึงเวลาส่ง ห้ามเปลือง Hermes");
  db.close();
});

test("F5 guard: compliance guard บล็อก draft -> skipped + NEEDS_HUMAN + correction", async () => {
  const lineFetch = lineFetchStub();
  const hermesFetch = hermesFetchStub("รุ่นนี้การันตีผล ลดพิเศษเหลือ 9,999 บาทค่ะ");
  const { engine, db } = makeEngine({ hermesFetch, lineFetch });
  const fu = dueFollowup(db, "U-guard");
  await engine.runDue();
  const row = db.getFollowup(fu.id);
  assert.equal(row.status, "skipped");
  assert.ok(row.detail.startsWith("guard_blocked"));
  assert.equal(db.getCustomer("U-guard").state, "NEEDS_HUMAN");
  assert.equal(db.listCorrections("candidate").length, 1, "draft ที่โดนบล็อกเข้าคิวรีวิว");
  assert.equal(lineFetch.sends.length, 0, "draft ห้ามหลุดถึงลูกค้า");
  db.close();
});

test("F5 guard: Hermes ล่ม -> skipped hermes_down (ไม่ส่งมั่ว)", async () => {
  const lineFetch = lineFetchStub();
  const { engine, db } = makeEngine({
    lineFetch,
    hermesFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const fu = dueFollowup(db, "U-hdown");
  await engine.runDue();
  assert.equal(db.getFollowup(fu.id).detail, "hermes_down");
  assert.equal(lineFetch.sends.length, 0);
  db.close();
});

/* ------------------------------ lock / scheduler ---------------------------- */

test("F5: sync lock — รอบก่อนยังไม่จบ = รอบใหม่ข้าม (run_in_flight)", async () => {
  const hermesFetch = hermesFetchStub("ทักไปตามนัดค่ะ สะดวกคุยต่อไหมคะ", { onCall: () => sleep(60) });
  const { engine, db } = makeEngine({ hermesFetch });
  dueFollowup(db, "U-lock");
  const first = engine.runDue(); // ค้างอยู่ที่ Hermes 60ms
  await sleep(10);
  const second = await engine.runDue();
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "run_in_flight");
  const result = await first;
  assert.equal(result.processed, 1);
  // lock ถูกปล่อยแล้ว — รอบถัดไปทำงานปกติ
  const third = await engine.runDue();
  assert.equal(third.processed, 0);
  db.close();
});

test("AI pause ระหว่าง Hermes ร่าง manual follow-up -> final boundary ไม่ส่ง", async () => {
  let releaseDraft;
  const gate = new Promise((resolve) => { releaseDraft = resolve; });
  const hermesFetch = hermesFetchStub("ทักไปตามนัดค่ะ สะดวกคุยต่อไหมคะ", { onCall: () => gate });
  const lineFetch = lineFetchStub();
  const { engine, db } = makeEngine({ hermesFetch, lineFetch });
  const fu = dueFollowup(db, "U-pause-fu-race");
  const pending = engine.runDue();
  while (hermesFetch.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  db.setSetting("ai_paused", "1");
  releaseDraft();
  const result = await pending;
  assert.equal(result.results[0].status, "skipped");
  assert.equal(db.getFollowup(fu.id).detail, "ai_paused_before_send");
  assert.equal(lineFetch.sends.length, 0);
  db.close();
});

test("F5: scheduler arm เฉพาะ interval > 0 + stop ได้", () => {
  const armed = makeEngine({ configOverrides: { FOLLOWUP_INTERVAL_MS: "60000" } });
  assert.equal(armed.engine.start(), true);
  assert.equal(armed.engine.running, true);
  assert.equal(armed.engine.start(), false, "arm ซ้ำไม่ได้");
  armed.engine.stop();
  assert.equal(armed.engine.running, false);
  armed.db.close();

  const off = makeEngine({ configOverrides: { FOLLOWUP_INTERVAL_MS: "0" } });
  assert.equal(off.engine.start(), false, "interval 0 = ไม่ arm");
  off.db.close();
});

test("sales safety forbids payment instructions in scheduled followups even with review off", async () => {
  const lineFetch = lineFetchStub();
  const { engine, db } = makeEngine({ configOverrides: { SALES_DECISION_GUARD_ENABLED: "true" },
    hermesFetch: hermesFetchStub("เลขบัญชี: 0000000000 ค่ะ"), lineFetch });
  try {
    const row = dueFollowup(db, "U-no-proactive-bank");
    await engine.runDue();
    assert.equal(db.getFollowup(row.id).status, "skipped");
    assert.equal(lineFetch.sends.length, 0);
  } finally { db.close(); }
});

test("F5: นัดเดียวพังกลางทาง -> ปิดเป็น skipped แล้วนัดอื่นในรอบเดียวกันไปต่อ", async () => {
  const lineFetch = lineFetchStub();
  const { engine, db } = makeEngine({ lineFetch });
  const bad = dueFollowup(db, "U-boom");
  const good = dueFollowup(db, "U-fine");
  // ทำให้ลูกค้าคนแรกพังตอนอ่าน history (จำลอง DB error เฉพาะจุด)
  const originalRecentTurns = db.recentTurns.bind(db);
  db.recentTurns = (customerId, turns) => {
    if (customerId === "U-boom") throw new Error("boom");
    return originalRecentTurns(customerId, turns);
  };
  const result = await engine.runDue();
  assert.equal(result.processed, 2);
  assert.equal(db.getFollowup(bad.id).status, "skipped");
  assert.equal(db.getFollowup(good.id).status, "sent");
  db.close();
});

/* ------------------------- opt-out ผ่าน safety router ----------------------- */

function makeApp({ hermesFetch, lineFetch } = {}) {
  const config = testConfig();
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch: hermesFetch ?? hermesFetchStub(),
      lineFetch: lineFetch ?? lineFetchStub(),
      sleep: async () => {},
    },
    logger: silent,
  });
  return { app, db };
}

test("F5 opt-out: 'อย่าทักมาอีก' -> dnd + ยกเลิกนัดค้าง + ตอบรับสุภาพ + audit", async () => {
  const lineFetch = lineFetchStub();
  const { app, db } = makeApp({ lineFetch });
  db.upsertCustomer("U-optout", {});
  const fu1 = db.createFollowup({ customerId: "U-optout", scheduledAt: Date.now() + 3_600_000, createdBy: "nok" });
  const fu2 = db.createFollowup({ customerId: "U-optout", scheduledAt: Date.now() + 7_200_000, createdBy: "nok" });

  const result = await app.pipeline.handleInboundText({ customerId: "U-optout", text: "อย่าทักมาอีกนะคะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.equal(result.route, "optout");
  assert.equal(result.deterministic, true, "opt-out เป็น template ไม่ผ่าน model");
  assert.equal(db.getCustomer("U-optout").do_not_disturb, 1);
  assert.equal(db.getFollowup(fu1.id).status, "cancelled");
  assert.equal(db.getFollowup(fu2.id).status, "cancelled");
  const sentText = lineFetch.calls.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(sentText.includes("จะไม่ทักไปรบกวน"));
  const audit = db.listAudit().find((a) => a.action === "followup_optout");
  assert.equal(audit.operator, "system");
  assert.equal(audit.target, "U-optout");
  db.close();
});

test("F5 opt-out ปนเรื่องร้องเรียน -> complaint ชนะเส้นทาง แต่ dnd + ยกเลิกนัดยังทำงาน", async (t) => {
  const { app, db } = makeApp({});
  t.after(() => db.close());
  db.upsertCustomer("U-mad", {});
  const fu = db.createFollowup({ customerId: "U-mad", scheduledAt: Date.now() + 3_600_000, createdBy: "nok" });

  const result = await app.pipeline.handleInboundText({
    customerId: "U-mad", text: "บริการแย่มาก อย่าทักมาอีก", replyToken: "rt",
  });
  assert.equal(result.route, "complaint", "ความปลอดภัย (complaint escalate) ต้องชนะ");
  assert.equal(db.getCustomer("U-mad").state, "NEEDS_HUMAN");
  assert.equal(db.getCustomer("U-mad").do_not_disturb, 1, "ธง opt-out ยังทำงาน");
  assert.equal(db.getFollowup(fu.id).status, "cancelled");
});

test("F5: ส่ง follow-up แล้วลูกค้าตอบกลับ = แชทปกติ (reactive)", async (t) => {
  const { app, db } = makeApp({});
  t.after(() => db.close());
  db.upsertCustomer("U-back", {});
  db.insertMessage({ customerId: "U-back", direction: "out", content: "ทักไปตามนัดค่ะ", messageClass: "proactive" });

  const result = await app.pipeline.handleInboundText({ customerId: "U-back", text: "ยังสนใจอยู่ค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  const outbound = db.messagesFor("U-back").filter((m) => m.direction === "out");
  assert.equal(outbound.at(-1).message_class, "reactive", "reply ตอบกลับเป็น reactive ปกติ");
});

// 2026-08-28: ป้าย "customer" (ซื้อแล้ว) ต้องกันนัดที่ตั้งค้างไว้ด้วย
//
// ด่าน human_owned ด้านบนกันได้โดยอ้อมอยู่แล้ว เพราะการติดป้ายปิด AI ทันที
// แต่ในระบบมีอย่างน้อย 4 จุดที่เปิด AI กลับได้โดยไม่ดูป้าย (ปุ่มเปิด AI ในคอนโซล,
// operator API, และการเชื่อม/ปฏิเสธห้องเก่าใน legacyLink) — วันที่ใครกดจุดพวกนั้น
// นัดเก่าที่ยังค้างคิวจะยิงหาลูกค้าที่ซื้อไปแล้วทันที จึงต้องมีด่านตรงด้วย
test("F5 guard: ห้องที่ติดป้าย customer -> skipped tag_silenced", async () => {
  const { engine, db } = makeEngine({});
  const fu = dueFollowup(db, "U-bought");
  db.addTag("U-bought", "customer", "human");
  // จำลองกรณีที่ AI ถูกเปิดกลับมาหลังติดป้าย — ด่านอ้อมจะไม่ทำงาน
  db.setAiEnabled("U-bought", true);
  await engine.runDue();
  const row = db.getFollowup(fu.id);
  assert.equal(row.status, "skipped");
  assert.equal(row.detail, "tag_silenced");
  db.close();
});

test("F5 guard: ห้องปกติที่ไม่ได้ติดป้าย ยังส่งนัดได้ตามเดิม", async () => {
  const { engine, db } = makeEngine({});
  const fu = dueFollowup(db, "U-normal");
  await engine.runDue();
  const row = db.getFollowup(fu.id);
  assert.notEqual(row.detail, "tag_silenced", "ด่านใหม่ต้องไม่ไปกันห้องปกติ");
  db.close();
});

function followupJudge({ mode = "enforce", action = "allow", duringReview = null } = {}) {
  const calls = [];
  return {
    enabled: true,
    calls,
    async review(input) {
      calls.push(input);
      await duringReview?.();
      return { id: "jev-followup-fixture", mode, action };
    },
  };
}

test("JEV enforce scheduled follow-up judges after draft: reject blocks; allow sends", async () => {
  for (const [action, expectedSends] of [["human_review", 0], ["allow", 1]]) {
    const lineFetch = lineFetchStub();
    const judge = followupJudge({ action });
    const { engine, db } = makeEngine({ lineFetch, decisionReview: judge });
    try {
      const followup = dueFollowup(db, `U-jev-${action}`);
      const result = await engine.runDue();
      assert.equal(judge.calls.length, 1, "ต้องตัดสินหลังร่างหนึ่งครั้ง");
      assert.equal(judge.calls[0].stage, "followup");
      if (expectedSends) {
        assert.ok(lineFetch.sends.length > 0, "allow ต้องส่งได้");
      } else {
        assert.equal(lineFetch.sends.length, 0, "คำตัดสินห้ามส่งต้องไม่มี send");
      }
      assert.equal(db.getFollowup(followup.id).status, expectedSends ? "sent" : "skipped");
    } finally { db.close(); }
  }
});

test("JEV review rechecks inbound and operator takeover before scheduled send", async () => {
  for (const change of ["inbound", "operator_off"]) {
    const lineFetch = lineFetchStub();
    let db;
    const judge = followupJudge({ duringReview: () => {
      if (change === "inbound") {
        db.insertMessage({ customerId: "U-jev-race", direction: "in", content: "ขอหยุดก่อนค่ะ" });
        db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ? AND direction = 'in'").run(NOON_BKK + 1, "U-jev-race");
      } else db.setAiEnabled("U-jev-race", false);
    } });
    const world = makeEngine({ lineFetch, decisionReview: judge });
    db = world.db;
    try {
      const followup = dueFollowup(db, "U-jev-race");
      await world.engine.runDue();
      assert.equal(judge.calls.length, 1);
      assert.equal(lineFetch.sends.length, 0, `${change} ระหว่าง judge ห้ามส่ง`);
      assert.equal(db.getFollowup(followup.id).status, "skipped");
    } finally { db.close(); }
  }
});

test("JEV shadow rejection leaves scheduled follow-up delivery unchanged", async () => {
  const lineFetch = lineFetchStub();
  const judge = followupJudge({ mode: "shadow", action: "human_review" });
  const { engine, db } = makeEngine({ lineFetch, decisionReview: judge });
  try {
    const followup = dueFollowup(db, "U-jev-shadow");
    await engine.runDue();
    assert.equal(judge.calls.length, 1);
    assert.ok(lineFetch.sends.length > 0, "shadow verdict ห้ามเปลี่ยนการส่งเดิม");
    assert.equal(db.getFollowup(followup.id).status, "sent");
  } finally { db.close(); }
});
