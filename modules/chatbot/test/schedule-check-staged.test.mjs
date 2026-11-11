// "ขอเช็คคิวก่อน" ในเครื่องยนต์ follow-up จริง (คำสั่งพี่ง้วง 28 ก.ย. 2026) — mock ทั้งหมด ไม่แตะ network
// ห้อง hot ปกติโดนทักใน ~45 นาที; ห้องที่ขอเช็คคิวต้องได้ทักครั้งเดียวสองวันถัดไปช่วงสาย ๆ แล้วหยุด
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createStagedFollowups, previewStagedFollowup } from "../src/stagedFollowups.mjs";
import { SCHEDULE_CHECK_FOLLOWUP_KEY } from "../src/scheduleCheck.mjs";
import { bangkokIsoDate } from "../src/followupTiming.mjs";
import { poisonGlobalFetch, testConfig, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
const bkk = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 7, minute, 0); // ก.ย. 2026 เวลาไทย
const hm = (ts) => new Date(ts + 7 * HOUR).toISOString().slice(11, 16);

function roundsFile() {
  const dir = mkdtempSync(join(tmpdir(), "sched-rounds-"));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify({
    seatsPerRound: 15,
    classes: {
      basic: { label: "Classroom AI Agent for Business", product: "AI Agent for Business" },
      advance: { label: "Classroom AI Agent Workflow Automation", product: "AI Agent Workflow Automation" },
    },
    rounds: [
      { date: "2026-09-26", class: "basic", status: "open" },
      { date: "2026-10-10", class: "basic", status: "open" },
      { date: "2026-10-17", class: "basic", status: "full" },
      { date: "2026-10-24", class: "advance", status: "open" },
    ],
  }));
  return file;
}

function makeWorld({ score = 9, channelId = "default", customerId = "U-sched", nowMs = bkk(28, 10) } = {}) {
  const clock = { now: nowMs };
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0", CLASS_ROUNDS_FILE: roundsFile() });
  const db = memoryDb({ now: () => clock.now });
  let drafts = 0;
  const hermesCalls = [];
  const hermes = createHermesBridge({
    config, logger: silent,
    fetchImpl: async (_url, options) => {
      hermesCalls.push(options);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `ชวนคุยต่อรอบที่ ${drafts += 1} ค่ะ สนใจด้านไหนเพิ่มไหมคะ?` } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    },
    getReplyModel: () => config.hermesModel, getFollowupModel: () => "",
  });
  const pushes = [];
  const lineCh = { sendBubbles: async (args) => { pushes.push(args); return { ok: true }; } };
  const engine = createStagedFollowups({
    config, db, hermes,
    lineRegistry: { forChannel: () => lineCh, rawUserId: (id) => id },
    guard: createComplianceGuard({ bannedWords: ["การันตี"], getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(), logger: silent, now: () => clock.now, imageCatalog: [],
  });
  db.upsertCustomer(customerId, { displayName: "Somchai", channelId });
  db.setFollowupEnabled(customerId, true);
  db.recordScore(customerId, score, "{}");
  return { engine, db, clock, pushes, customerId, hermesCalls, config };
}

function messageAt(db, customerId, { direction, content, atMs }) {
  const id = `m-${Math.random().toString(36).slice(2)}`;
  db.insertMessage({ id, customerId, direction, msgType: "text", content, ...(direction === "out" ? { agentMode: "ai" } : {}) });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(atMs, id);
}

// ลูกค้าขอเช็คคิว → ลูกแพรตอบพร้อมรอบ (หมุดตั้งแบบเดียวกับที่เส้นรับข้อความตั้ง)
function deferralExchange(db, customerId, atMs, { hint = null } = {}) {
  messageAt(db, customerId, { direction: "in", content: "ขอเช็คคิวก่อนนะคะ", atMs });
  messageAt(db, customerId, { direction: "out", content: "ได้เลยค่ะ รอบที่เปิดอยู่มี 10 ต.ค. ค่ะ ไม่ต้องรีบนะคะ", atMs: atMs + MIN });
  db.setFollowupDefer(customerId, JSON.stringify({ kind: "schedule_check", at: atMs, hint }));
}

async function tickAt(world, atMs) {
  world.clock.now = atMs;
  return world.engine.runOnce();
}

test("LINE hot: ขอเช็คคิวแล้ว บันไดปกติไม่ทัก · ทักครั้งเดียวสองวันถัดไปช่วงสาย ๆ พร้อมรอบที่ยังเปิด · แล้วหยุด", async (t) => {
  const world = makeWorld({ score: 9 });
  t.after(() => world.db.close());
  const { db, customerId, pushes } = world;
  deferralExchange(db, customerId, bkk(28, 10));

  for (const at of [bkk(28, 11), bkk(28, 16), bkk(29, 10, 30), bkk(29, 15)]) await tickAt(world, at);
  assert.equal(pushes.length, 0, "ห้องที่ขอเช็คคิวต้องไม่โดนบันได hot (45 นาที / เช้าวันถัดไป)");
  assert.equal(world.hermesCalls.length, 0, "ไม่มีการร่างด้วยโมเดล");

  const preview = previewStagedFollowup({
    customer: db.getCustomer(customerId), state: db.getFollowupState(customerId),
    lastInboundAt: db.lastInboundAt(customerId), lastOutboundAt: db.lastOutboundAt(customerId),
    nowMs: bkk(29, 15), scheduleCheck: true,
  });
  assert.equal(preview.stage, "schedule_check");
  assert.equal(preview.kind, "schedule_check");
  assert.equal(bangkokIsoDate(preview.dueAt), "2026-09-30");
  assert.ok(hm(preview.dueAt) >= "10:00" && hm(preview.dueAt) <= "11:30", hm(preview.dueAt));

  await tickAt(world, preview.dueAt - MIN);
  assert.equal(pushes.length, 0, "ก่อนเวลาที่ badge บอก = ยังไม่ทัก");
  await tickAt(world, preview.dueAt);
  assert.equal(pushes.length, 1, "ถึงเวลาที่ badge บอกพอดี = ทัก");
  const sent = pushes[0].bubbles.map((bubble) => bubble.text).join("\n");
  assert.match(sent, /ไม่ทราบว่าได้เช็คคิวแล้วสะดวกรอบไหนดีนะคะ/u);
  assert.match(sent, /10 ต\.ค\./u, "รอบที่ลูกแพรส่งให้ดูและยังเปิดอยู่");
  assert.doesNotMatch(sent, /26 ก\.ย\.|17 ต\.ค\./u, "รอบที่ผ่านไปแล้ว/เต็มแล้วต้องไม่ถูกเสนอ");
  const state = db.getFollowupState(customerId);
  assert.equal(state.stage_key, "schedule_check");
  assert.equal(JSON.parse(state.defer_json).sentAt, preview.dueAt, "จดเวลาทักลงหมุด");
  const audit = db.listAudit(20).find((row) => row.action === "staged_followup_sent");
  assert.match(audit.detail, /schedule_check/u);
  const logged = db.messagesFor(customerId, 10).filter((row) => row.message_class === "proactive");
  assert.equal(logged.length, pushes[0].bubbles.length);

  for (const at of [bkk(30, 16), bkk(31, 10, 30), bkk(31 + 2, 11)]) await tickAt(world, at);
  assert.equal(pushes.length, 1, "ทักครั้งเดียวแล้วหยุด");
  const after = previewStagedFollowup({
    customer: db.getCustomer(customerId), state: db.getFollowupState(customerId),
    lastInboundAt: db.lastInboundAt(customerId), lastOutboundAt: db.lastOutboundAt(customerId),
    nowMs: bkk(31, 12), scheduleCheck: true,
  });
  assert.deepEqual(after, { blocked: "ladder_done" }, "badge ต้องบอกว่ารอลูกค้าตอบ");

  // ลูกค้าตอบกลับ = คุยปกติ: บันได hot กลับมาทำงานนับจากข้อความใหม่
  messageAt(db, customerId, { direction: "in", content: "ยังไม่ได้เช็คเลยค่ะ งานยุ่งมาก", atMs: bkk(31, 13) });
  messageAt(db, customerId, { direction: "out", content: "เข้าใจเลยค่ะ", atMs: bkk(31, 13, 1) });
  await tickAt(world, bkk(31, 14, 30));
  assert.equal(pushes.length, 2, "หลังลูกค้าตอบ บันไดปกติกลับมา");
});

test("สวิตช์ schedule_check_followup = off → บันไดปกติทำงานเหมือนเดิมทุกอย่าง", async (t) => {
  const world = makeWorld({ score: 9 });
  t.after(() => world.db.close());
  world.db.setSetting(SCHEDULE_CHECK_FOLLOWUP_KEY, "off");
  deferralExchange(world.db, world.customerId, bkk(28, 10));
  await tickAt(world, bkk(28, 11));
  assert.equal(world.pushes.length, 1, "hot ไม้แรก ~45 นาทีเหมือนก่อนมีฟีเจอร์นี้");
});

test("FB: ลูกค้าบอกว่าจะแจ้งหลังประตูปิด = ไม่ทักเลย และบันไดปกติไม่กลับมาใน episode นี้", async (t) => {
  const customerId = "facebook:556677889900";
  const world = makeWorld({ score: 9, channelId: "facebook", customerId });
  t.after(() => world.db.close());
  deferralExchange(world.db, customerId, bkk(28, 12), { hint: "2026-10-02" });
  for (const at of [bkk(28, 13), bkk(28, 18), bkk(29, 9, 30), bkk(29, 11)]) await tickAt(world, at);
  assert.equal(world.pushes.length, 0);
  const preview = previewStagedFollowup({
    customer: world.db.getCustomer(customerId), state: world.db.getFollowupState(customerId),
    lastInboundAt: world.db.lastInboundAt(customerId), lastOutboundAt: world.db.lastOutboundAt(customerId),
    nowMs: bkk(28, 13), scheduleCheck: true,
  });
  assert.deepEqual(preview, { blocked: "ladder_done" });
});

test("FB: ทักครั้งเดียวในหน้าต่าง 24 ชม. (18–22 ชม. หลังข้อความลูกค้า) ข้อความสั้นกว่า LINE", async (t) => {
  const customerId = "facebook:998877665544";
  const world = makeWorld({ score: 6, channelId: "facebook", customerId });
  t.after(() => world.db.close());
  deferralExchange(world.db, customerId, bkk(28, 12));
  for (const at of [bkk(28, 16), bkk(28, 20)]) await tickAt(world, at);
  assert.equal(world.pushes.length, 0, "warm ของ FB (4 ชม.) ต้องไม่ทัก");
  const preview = previewStagedFollowup({
    customer: world.db.getCustomer(customerId), state: world.db.getFollowupState(customerId),
    lastInboundAt: world.db.lastInboundAt(customerId), lastOutboundAt: world.db.lastOutboundAt(customerId),
    nowMs: bkk(28, 20), scheduleCheck: true,
  });
  assert.ok(preview.dueAt - bkk(28, 12) >= 18 * HOUR && preview.dueAt - bkk(28, 12) <= 22 * HOUR);
  await tickAt(world, preview.dueAt);
  assert.equal(world.pushes.length, 1);
  assert.doesNotMatch(world.pushes[0].bubbles.map((b) => b.text).join(" "), /พิมพ์บอกลูกแพร/u, "FB ใช้ข้อความสั้น");
});
