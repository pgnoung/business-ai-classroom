// Facebook: ไม้ที่ถูกเลื่อนเพราะช่วงเงียบต้องไม่มากองยิงติดกันตอนเช้า (ผู้ตรวจโค้ด 28 ก.ย. 2026 · พี่ง้วง "ทำต่อได้เลยครับ")
//
// เคสจริง ก.ย.: ห้อง FB ระดับ cold ลูกค้าเงียบตอน 21:00 → ไม้ 1/6/11 ชม. ตกช่วงเงียบ (21:00-09:00) ทั้งหมด
// ถูกเลื่อนไป 09:00 แล้วยิงห่างกันแค่ 45 นาที (ด่านเว้นหลังความเคลื่อนไหวล่าสุด) = 3 รอบในเช้าเดียวภายใน
// 2 ชม. 17 นาที — ลูกค้ารู้สึกถูกตาม ซึ่งพี่ง้วงไม่เอา
//
// สิ่งที่เทสต์ล็อก:
//   1. หลังมีไม้ที่ถูกเลื่อนเพราะช่วงเงียบ ไม้ถัดไปห่างจากไม้ก่อนที่ส่งจริงอย่างน้อยเท่าระยะที่ออกแบบไว้
//   2. ไม้ที่ไม่ทันหน้าต่าง 24 ชม. ของ Meta (margin เดิม) = ข้ามทิ้ง บันไดจบเร็วขึ้น
//   3. ลูกค้าเงียบช่วงกลางวัน = เวลาเดิมทุกไม้เป๊ะ (เทียบกับตรรกะเดิมทีละไม้) · LINE ไม่เปลี่ยนเลย
//   4. เวลาที่ badge/สถานะ Telegram บอก = เวลาที่รอบ tick ส่งจริง
import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import {
  STAGE_SCHEDULE, FACEBOOK_STAGE_SCHEDULE, createStagedFollowups, facebookStepMissesWindow, lastSendWasYolo,
  previewStagedFollowup, resolveStepDueAt, scheduleFor, stepJitterMs,
} from "../src/stagedFollowups.mjs";
import { followupStateFromInboxRow } from "../src/consoleApi.mjs";
import { describeRoomStatus } from "../src/yoloStatus.mjs";
import { inQuietHours, nextQuietEnd } from "../src/followupEngine.mjs";
import { hashUnit } from "../src/followupTiming.mjs";
import { scheduleCheckFollowupEnabled } from "../src/scheduleCheck.mjs";
import { FB_MESSAGING_WINDOW_MS } from "../src/db.mjs";
import { poisonGlobalFetch, testConfig, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const bkk = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 7, minute, 0); // ก.ย. 2026 เวลาไทย
const hm = (ts) => new Date(ts + 7 * HOUR).toISOString().slice(8, 16).replace("T", " ");
const STAGES = ["cold", "warm", "hot"];
const CUSTOMERS = Array.from({ length: 24 }, (_, i) => `facebook:${String(7_700_000_000 + i * 7919)}`);

// ระยะที่ตารางออกแบบไว้ระหว่างไม้ติดกัน (cold 5 ชม. · warm 7 ชม. · hot 7 ชม. 15 นาที)
const designedGap = (stage, stepIndex) => FACEBOOK_STAGE_SCHEDULE[stage][stepIndex].at.ms
  - FACEBOOK_STAGE_SCHEDULE[stage][stepIndex - 1].at.ms;

// ตรรกะเดิมก่อน 28 ก.ย. (resolveStepDueAt ที่ 020310872) คัดลอกไว้เป็นตัวเทียบ — ห้ามแก้ตามโค้ดใหม่
function legacyDueAt({ schedule, stepIndex, anchorMs, lastActivityMs, customerId }) {
  const step = schedule[stepIndex];
  let due = step.at.type === "morning" ? nextQuietEnd(anchorMs + step.at.afterMs) : anchorMs + step.at.ms;
  due += stepJitterMs(customerId, anchorMs, stepIndex, step);
  due = Math.max(due, lastActivityMs + 45 * MIN);
  if (inQuietHours(due)) due = nextQuietEnd(due) + Math.round(hashUnit(customerId, anchorMs, stepIndex, "q") * 40 * MIN);
  return due;
}

// เดินบันไดแบบเดียวกับเส้นยิงจริง: ยิงตรงเวลาที่ถึงกำหนด · ไม้ถัดไปนับจากที่เพิ่งส่ง · ไม้ที่ไม่ทันหน้าต่าง = จบ
function walkFacebook({ stage, anchor, customerId }) {
  const schedule = scheduleFor(stage, null, "facebook");
  const sends = [];
  for (let i = 0; i < schedule.length; i += 1) {
    const due = resolveStepDueAt({
      schedule, stepIndex: i, anchorMs: anchor, lastActivityMs: sends.at(-1) ?? anchor, customerId,
      channelId: "facebook", previousSendMs: sends.at(-1) ?? null,
    });
    if (facebookStepMissesWindow({ channelId: "facebook", sendAt: due, lastInboundAt: anchor })) break;
    sends.push(due);
  }
  return sends;
}

test("ลูกค้าเงียบ 20:45 / 21:00: ทุกไม้ยิงเช้าวันถัดไปเป็นต้นไป และห่างกันเท่าระยะที่ออกแบบ ไม่ใช่ 45 นาที", () => {
  for (const [hour, minute] of [[20, 45], [21, 0]]) {
    const anchor = bkk(14, hour, minute);
    for (const stage of STAGES) {
      for (const customerId of CUSTOMERS) {
        const sends = walkFacebook({ stage, anchor, customerId });
        const label = `${stage} เงียบ ${hm(anchor)} (${customerId}): ${sends.map(hm).join(" → ")}`;
        assert.equal(sends.length, FACEBOOK_STAGE_SCHEDULE[stage].length, `ต้องยังได้ครบทุกไม้ในหน้าต่าง — ${label}`);
        assert.ok(sends[0] >= bkk(15, 9) && sends[0] < bkk(15, 9, 41), `ไม้แรกช่วงเช้า 09:00-09:40 — ${label}`);
        for (let i = 1; i < sends.length; i += 1) {
          assert.ok(sends[i] - sends[i - 1] >= designedGap(stage, i),
            `ไม้ ${i + 1} ต้องห่างไม้ก่อน ≥ ${designedGap(stage, i) / HOUR} ชม. — ${label}`);
        }
        for (const at of sends) {
          assert.equal(inQuietHours(at), false, `ห้ามตกช่วงเงียบ — ${label}`);
          assert.ok(at - anchor < FB_MESSAGING_WINDOW_MS, `ต้องอยู่ในหน้าต่าง 24 ชม. — ${label}`);
        }
      }
    }
  }
});

test("เคสจริง: cold เงียบ 21:00 เดิมได้ 3 รอบในเช้าเดียว — ตอนนี้กระจาย เช้า/บ่าย/เย็น", () => {
  const anchor = bkk(14, 21);
  const customerId = CUSTOMERS[0];
  const schedule = scheduleFor("cold", null, "facebook");
  const legacy = [];
  for (let i = 0; i < schedule.length; i += 1) {
    legacy.push(legacyDueAt({ schedule, stepIndex: i, anchorMs: anchor, lastActivityMs: legacy.at(-1) ?? anchor, customerId }));
  }
  assert.ok(legacy.at(-1) - legacy[0] < 2.5 * HOUR, `ตรรกะเดิมกองสามไม้ในเช้าเดียว: ${legacy.map(hm).join(" → ")}`);
  const now = walkFacebook({ stage: "cold", anchor, customerId });
  assert.equal(now.length, 3);
  assert.ok(now.at(-1) - now[0] >= 10 * HOUR, `ต้องกระจายทั้งวัน: ${now.map(hm).join(" → ")}`);
});

test("ลูกค้าเงียบเวลาไหนก็ตาม: สองไม้ติดกันห่าง ≥ 4 ชม. · ไม่ตกช่วงเงียบ · ไม่เลยหน้าต่าง", () => {
  // 4 ชม. = ระยะต่ำสุดที่ตารางกลางวันเดิมให้ได้ (cold 5 ชม. ลบสุ่มสองไม้ ±30 นาที) — ของเดิมตอนเย็นได้ 45 นาที
  for (let slot = 0; slot < 96; slot += 1) {
    const anchor = bkk(14, 0) + slot * 15 * MIN;
    for (const stage of STAGES) {
      for (const customerId of CUSTOMERS.slice(0, 8)) {
        const sends = walkFacebook({ stage, anchor, customerId });
        const label = `${stage} เงียบ ${hm(anchor)}: ${sends.map(hm).join(" → ")}`;
        assert.ok(sends.length >= 1, `ไม้แรกต้องได้เสมอ — ${label}`);
        for (let i = 1; i < sends.length; i += 1) {
          assert.ok(sends[i] - sends[i - 1] >= 4 * HOUR, `ห้ามกองติดกัน — ${label}`);
        }
        for (const at of sends) {
          assert.equal(inQuietHours(at), false, label);
          assert.ok(at - anchor < FB_MESSAGING_WINDOW_MS, label);
        }
      }
    }
  }
});

test("ลูกค้าเงียบช่วงกลางวัน: เวลาทุกไม้เท่าตรรกะเดิมเป๊ะ (เทียบทีละไม้ ทีละห้อง)", () => {
  for (const [hour, minute] of [[9, 0], [9, 30], [10, 0], [11, 0], [12, 0], [13, 0], [14, 0]]) {
    const anchor = bkk(14, hour, minute);
    for (const stage of STAGES) {
      const schedule = scheduleFor(stage, null, "facebook");
      for (const customerId of CUSTOMERS) {
        let previous = null;
        for (let i = 0; i < schedule.length; i += 1) {
          const lastActivityMs = previous ?? anchor;
          const legacy = legacyDueAt({ schedule, stepIndex: i, anchorMs: anchor, lastActivityMs, customerId });
          const due = resolveStepDueAt({
            schedule, stepIndex: i, anchorMs: anchor, lastActivityMs, customerId,
            channelId: "facebook", previousSendMs: previous,
          });
          assert.equal(due, legacy, `${stage} ไม้ ${i + 1} เงียบ ${hm(anchor)} ${customerId}: เดิม ${hm(legacy)} ใหม่ ${hm(due)}`);
          // ด่านหน้าต่างใหม่ข้ามเฉพาะไม้ที่ของเดิมก็ส่งไม่ได้อยู่แล้ว (withinFacebookWindow ตอนถึงเวลา)
          assert.equal(facebookStepMissesWindow({ channelId: "facebook", sendAt: due, lastInboundAt: anchor }),
            legacy - anchor >= FB_MESSAGING_WINDOW_MS);
          previous = due;
        }
      }
    }
  }
});

test("LINE ไม่เปลี่ยน: ทุกเวลาเงียบ ทุกระดับ เท่าตรรกะเดิม แม้ส่งเวลาไม้ก่อนหน้ามาด้วย", () => {
  for (let slot = 0; slot < 48; slot += 1) {
    const anchor = bkk(14, 0) + slot * 30 * MIN;
    for (const [stage, schedule] of Object.entries(STAGE_SCHEDULE)) {
      for (const customerId of ["U-line-a", "U-line-b", "U-line-c"]) {
        let previous = null;
        for (let i = 0; i < schedule.length; i += 1) {
          const lastActivityMs = previous ?? anchor;
          const legacy = legacyDueAt({ schedule, stepIndex: i, anchorMs: anchor, lastActivityMs, customerId });
          for (const channelId of ["", "default", "line-oa-2"]) {
            assert.equal(resolveStepDueAt({
              schedule, stepIndex: i, anchorMs: anchor, lastActivityMs, customerId, channelId, previousSendMs: previous,
            }), legacy, `${stage} ไม้ ${i + 1} ช่อง ${channelId || "(ว่าง)"}`);
            assert.equal(facebookStepMissesWindow({ channelId, sendAt: legacy + 30 * DAY, lastInboundAt: anchor }), false);
          }
          previous = legacy;
        }
      }
    }
  }
});

test("ไม้ที่เลื่อนแล้วไม่ทันหน้าต่าง 24 ชม. = ข้าม (บันไดจบเร็วขึ้น) · ถ้ายังทัน = ห่างไม้ก่อนเท่าระยะที่ออกแบบพอดี", () => {
  const anchor = bkk(14, 21);
  const customerId = CUSTOMERS[3];
  const schedule = scheduleFor("cold", null, "facebook");
  // ไม้ 2 ออกช้า (เช่น ทีมคุยอยู่ทั้งบ่าย) 16:30 → ไม้ 3 ต้องรอถึง 21:30 = ช่วงเงียบ → เช้าถัดไปเลยหน้าต่างแล้ว
  const late = resolveStepDueAt({
    schedule, stepIndex: 2, anchorMs: anchor, lastActivityMs: bkk(15, 16, 30), customerId,
    channelId: "facebook", previousSendMs: bkk(15, 16, 30),
  });
  assert.ok(late >= bkk(16, 9), `ต้องถูกเลื่อนพ้นคืน: ${hm(late)}`);
  assert.equal(facebookStepMissesWindow({ channelId: "facebook", sendAt: late, lastInboundAt: anchor }), true);
  // ไม้ 2 ออก 14:30 → ไม้ 3 = 19:30 พอดี (ยังทันก่อนประตูปิด 20:55)
  const fits = resolveStepDueAt({
    schedule, stepIndex: 2, anchorMs: anchor, lastActivityMs: bkk(15, 14, 30), customerId,
    channelId: "facebook", previousSendMs: bkk(15, 14, 30),
  });
  assert.equal(fits, bkk(15, 19, 30));
  assert.equal(facebookStepMissesWindow({ channelId: "facebook", sendAt: fits, lastInboundAt: anchor }), false);
  // ประตูปิดแล้ว (ตอนนี้เลย 24 ชม.) = ข้ามเสมอ แม้เวลาที่ถึงกำหนดจะผ่านมาแล้ว
  assert.equal(facebookStepMissesWindow({ channelId: "facebook", sendAt: anchor + DAY, lastInboundAt: anchor }), true);
  assert.equal(facebookStepMissesWindow({ channelId: "facebook", sendAt: anchor + FB_MESSAGING_WINDOW_MS - 1, lastInboundAt: anchor }), false);
});

/* ------------------------- เครื่องยนต์จริง + badge + Telegram ------------------------- */

// warm/hot ไม้แรกเป็นรีวิว — ไม่มีคลังรีวิว = ตกไปไม้คำถามแล้วบันไดจบในไม้เดียว (เดินได้ไม่ครบ)
const REVIEW_KNOWLEDGE = [
  "[Classroom : AI Agent For Business]",
  "- คุณทดสอบหนึ่ง — CEO โรงพิมพ์ | รีวิว: https://www.facebook.com/share/r/AAA111/",
  "- คุณทดสอบสอง — เจ้าของธุรกิจส่วนตัว | รีวิว: https://www.facebook.com/share/r/BBB222/",
].join("\n");

function makeWorld({ score = 2, customerId = CUSTOMERS[5], nowMs = bkk(14, 20) } = {}) {
  const clock = { now: nowMs };
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0" });
  const db = memoryDb({ now: () => clock.now });
  db.addKnowledge({ title: "รีวิวนักเรียนจริง แยกตามคลาส", content: REVIEW_KNOWLEDGE, updatedBy: "test" });
  let drafts = 0;
  const hermes = createHermesBridge({
    config, logger: silent,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      choices: [{ message: { content: `ชวนคุยต่อรอบที่ ${drafts += 1} ค่ะ สนใจด้านไหนเพิ่มไหมคะ?` } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }) }),
    getReplyModel: () => config.hermesModel, getFollowupModel: () => "",
  });
  const pushes = [];
  const lineCh = { sendBubbles: async (args) => { pushes.push({ ...args, at: clock.now }); return { ok: true }; } };
  const engine = createStagedFollowups({
    config, db, hermes,
    lineRegistry: { forChannel: () => lineCh, rawUserId: (id) => id },
    guard: createComplianceGuard({ bannedWords: ["การันตี"], getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(), logger: silent, now: () => clock.now, imageCatalog: [],
  });
  db.upsertCustomer(customerId, { displayName: "Somsri", channelId: "facebook" });
  db.setFollowupEnabled(customerId, true);
  db.recordScore(customerId, score, "{}");
  return { engine, db, clock, pushes, customerId, config };
}

function messageAt(db, customerId, { direction, content, atMs, messageClass = undefined }) {
  const id = `m-${Math.random().toString(36).slice(2)}`;
  db.insertMessage({ id, customerId, direction, msgType: "text", content, ...(direction === "out" ? { agentMode: "ai" } : {}), ...(messageClass ? { messageClass } : {}) });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(atMs, id);
}

const DELAYS = { cold: 60 * MIN, warm: 30 * MIN, hot: 30 * MIN };

// เส้นเดียวกับ Telegram/หัวห้อง (อ่าน followup_state เต็มแถว)
function previewFromState(world) {
  const { db, customerId, clock } = world;
  return previewStagedFollowup({
    customer: db.getCustomer(customerId), state: db.getFollowupState(customerId),
    lastInboundAt: db.lastInboundAt(customerId), lastOutboundAt: db.lastOutboundAt(customerId),
    nowMs: clock.now, delays: DELAYS, scheduleCheck: scheduleCheckFollowupEnabled(db),
  });
}

// เส้นเดียวกับ badge ในรายการแชท (แถว listConversations ที่แนบ fs_* มาแล้ว)
function previewFromInbox(world) {
  const { db, customerId, clock } = world;
  const row = db.listConversations({ limit: 50 }).find((c) => c.line_user_id === customerId);
  return previewStagedFollowup({
    customer: row, state: followupStateFromInboxRow(row),
    lastInboundAt: row.last_inbound_at, lastOutboundAt: row.last_outbound_at,
    nowMs: clock.now, delays: DELAYS, scheduleCheck: scheduleCheckFollowupEnabled(db),
  });
}

async function tickAt(world, atMs) {
  world.clock.now = atMs;
  return world.engine.runOnce();
}

// ไล่ทีละไม้: badge บอกเวลา → ก่อนเวลานั้นต้องไม่ยิงเลย (กวาดทุก 10 นาที) → ถึงเวลาพอดีต้องยิง
async function walkEngine(world, startMs) {
  const sends = [];
  let cursor = startMs;
  for (let round = 0; round < 6; round += 1) {
    const preview = previewFromState(world);
    assert.deepEqual(previewFromInbox(world), preview, "badge ในรายการแชทต้องเล่าเรื่องเดียวกับหัวห้อง/Telegram");
    if (!preview || preview.blocked) return { sends, final: preview };
    for (let at = cursor; at < preview.dueAt; at += 10 * MIN) await tickAt(world, at);
    await tickAt(world, preview.dueAt - 1);
    assert.equal(world.pushes.length, sends.length, `ห้ามยิงก่อนเวลาที่ badge บอก (${hm(preview.dueAt)})`);
    await tickAt(world, preview.dueAt);
    assert.equal(world.pushes.length, sends.length + 1, `ถึงเวลาที่ badge บอกพอดี (${hm(preview.dueAt)}) ต้องยิง`);
    sends.push(preview.dueAt);
    cursor = preview.dueAt + 10 * MIN;
  }
  throw new Error("บันไดไม่จบใน 6 รอบ");
}

for (const [label, hour, minute, score] of [["cold 21:00", 21, 0, 2], ["warm 20:45", 20, 45, 6], ["hot 20:45", 20, 45, 9]]) {
  test(`เครื่องยนต์จริง (${label}): badge = เวลาที่ยิงจริงทุกไม้ · ไม้ถัดไปห่างเท่าระยะที่ออกแบบ · ครบแล้วรอลูกค้าตอบ`, async (t) => {
    const world = makeWorld({ score });
    t.after(() => world.db.close());
    const { db, customerId } = world;
    const anchor = bkk(14, hour, minute);
    messageAt(db, customerId, { direction: "in", content: "สนใจคลาสค่ะ", atMs: anchor });
    messageAt(db, customerId, { direction: "out", content: "ยินดีค่ะ สนใจด้านไหนคะ", atMs: anchor + 30_000 });

    const { sends, final } = await walkEngine(world, anchor + MIN);
    const stage = label.split(" ")[0];
    assert.equal(sends.length, FACEBOOK_STAGE_SCHEDULE[stage].length, `ครบทุกไม้: ${sends.map(hm).join(" → ")}`);
    assert.ok(sends[0] >= bkk(15, 9), `ไม้แรกไม่ออกกลางดึก: ${hm(sends[0])}`);
    for (let i = 1; i < sends.length; i += 1) {
      assert.ok(sends[i] - sends[i - 1] >= designedGap(stage, i), `ห่างเท่าระยะที่ออกแบบ: ${sends.map(hm).join(" → ")}`);
    }
    assert.deepEqual(final, { blocked: "ladder_done" });
    for (const at of [bkk(15, 20, 30), anchor + FB_MESSAGING_WINDOW_MS - MIN]) await tickAt(world, at);
    assert.equal(world.pushes.length, sends.length, "ครบบันไดแล้วไม่มีไม้เพิ่ม");
  });
}

test("เครื่องยนต์จริง: ไม้ที่ไม่ทันหน้าต่างถูกข้าม · badge/Telegram บอกว่าบันไดจบ ไม่โชว์เวลาที่ไม่มีวันยิง", async (t) => {
  const world = makeWorld({ score: 2, nowMs: bkk(15, 17) });
  t.after(() => world.db.close());
  const { db, customerId } = world;
  const anchor = bkk(14, 21);
  messageAt(db, customerId, { direction: "in", content: "สนใจคลาสค่ะ", atMs: anchor });
  messageAt(db, customerId, { direction: "out", content: "ยินดีค่ะ สนใจด้านไหนคะ", atMs: anchor + 30_000 });
  messageAt(db, customerId, { direction: "out", content: "ทักรอบแรกค่ะ", atMs: bkk(15, 9, 20), messageClass: "proactive" });
  messageAt(db, customerId, { direction: "out", content: "ทักรอบสองค่ะ", atMs: bkk(15, 16, 30), messageClass: "proactive" });
  db.saveFollowupState(customerId, {
    ladder_stage: 2, last_nudge_at: bkk(15, 16, 30), nudge_count: 2, stage_key: "cold", episode_anchor: anchor,
    episodes_today: 1, sent_today: 2, today_key: "2026-09-15", cold_sent_total: 2, history_json: "[]",
  });

  assert.deepEqual(previewFromState(world), { blocked: "fb_window_ends" });
  assert.deepEqual(previewFromInbox(world), { blocked: "fb_window_ends" });
  const status = describeRoomStatus({
    db, config: { ...world.config, stagedFollowupTickMs: 60_000, stagedFollowupEnabled: true }, customerId, nowMs: bkk(15, 17),
  });
  assert.match(status.followup, /หน้าต่าง 24 ชม\. ของ Facebook/u, status.followup);

  for (const at of [bkk(15, 17), bkk(15, 19), bkk(15, 20, 50)]) {
    const out = await tickAt(world, at);
    assert.equal(out.results[0]?.skipped, "fb_window_ends", `${hm(at)}: ${JSON.stringify(out.results)}`);
  }
  assert.equal(world.pushes.length, 0, "ไม่ยิงไม้ที่เลยหน้าต่าง และไม่ยิงถี่ชดเชย");

  // ไม้สองออก 14:30 แทน → ไม้สามทันพอดี 19:30 และยิงตรงเวลาที่ badge บอก
  db.saveFollowupState(customerId, {
    ladder_stage: 2, last_nudge_at: bkk(15, 14, 30), nudge_count: 2, stage_key: "cold", episode_anchor: anchor,
    episodes_today: 1, sent_today: 2, today_key: "2026-09-15", cold_sent_total: 2, history_json: "[]",
  });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE content = ?").run(bkk(15, 14, 30), "ทักรอบสองค่ะ");
  world.clock.now = bkk(15, 15);
  const fits = previewFromState(world);
  assert.equal(fits.dueAt, bkk(15, 19, 30));
  assert.deepEqual(previewFromInbox(world), fits);
  await tickAt(world, bkk(15, 19, 29));
  assert.equal(world.pushes.length, 0);
  await tickAt(world, bkk(15, 19, 30));
  assert.equal(world.pushes.length, 1);
});

// ผู้ตรวจโค้ด 28 ก.ย. (รอบสอง): พี่ง้วงสั่ง YOLO (Telegram) ได้ทุกเวลา = ส่งนอกตาราง
// เดิมไม้อัตโนมัติถัดไปนับแค่ด่าน 45 นาทีหลังข้อความนั้น (YOLO 19:30 → ระบบทักซ้ำ 20:15) = รู้สึกถูกตาม
test("หลัง YOLO ไม้อัตโนมัติถัดไปนับระยะจากข้อความ YOLO เท่าที่ตารางออกแบบ (ไม่ใช่ 45 นาที) · badge = เส้นยิงจริง", async (t) => {
  const world = makeWorld({ score: 2, nowMs: bkk(15, 19, 31) });
  t.after(() => world.db.close());
  const { db, customerId } = world;
  const anchor = bkk(15, 9);
  messageAt(db, customerId, { direction: "in", content: "สนใจคลาสค่ะ", atMs: anchor });
  messageAt(db, customerId, { direction: "out", content: "ยินดีค่ะ สนใจด้านไหนคะ", atMs: anchor + 30_000 });
  messageAt(db, customerId, { direction: "out", content: "ทักรอบแรกค่ะ", atMs: bkk(15, 10, 5), messageClass: "proactive" });
  messageAt(db, customerId, { direction: "out", content: "พี่ง้วงฝากถามค่ะ", atMs: bkk(15, 19, 30), messageClass: "proactive" });
  const state = (historyJson) => db.saveFollowupState(customerId, {
    ladder_stage: 2, last_nudge_at: bkk(15, 19, 30), nudge_count: 2, stage_key: "cold", episode_anchor: anchor,
    episodes_today: 1, sent_today: 2, today_key: "2026-09-15", cold_sent_total: 2, history_json: historyJson,
  });

  // ไม้ก่อนหน้าเป็นไม้อัตโนมัติ (ตรรกะเดิม): ตามมา 45 นาทีหลังข้อความล่าสุด
  state("[]");
  const before = previewFromState(world);
  assert.ok(before.dueAt >= bkk(15, 20, 15) && before.dueAt <= bkk(15, 20, 45), `เดิม ${hm(before.dueAt)}`);

  // ไม้ก่อนหน้าเป็น YOLO: ต้องห่าง 5 ชม. (cold) → 00:30 ตกช่วงเงียบ → เช้าวันถัดไป = เลยหน้าต่าง 24 ชม. → จบบันได
  state(JSON.stringify([{ kind: "cold_q", at: bkk(15, 10, 5) }, { kind: "yolo", question: "พี่ง้วงฝากถามค่ะ", at: bkk(15, 19, 30) }]));
  assert.deepEqual(previewFromState(world), { blocked: "fb_window_ends" });
  assert.deepEqual(previewFromInbox(world), { blocked: "fb_window_ends" }, "badge ในรายการแชทต้องอ่านชนิดไม้ล่าสุดได้เหมือนกัน");
  for (const at of [bkk(15, 20, 15), bkk(15, 20, 50)]) {
    const out = await tickAt(world, at);
    assert.equal(out.results[0]?.skipped, "fb_window_ends", `${hm(at)}: ${JSON.stringify(out.results)}`);
  }
  assert.equal(world.pushes.length, 0, "ไม่ทักซ้ำตามหลังข้อความที่พี่ง้วงสั่ง");
});

test("lastSendWasYolo อ่านได้ทั้ง array และ history_json · ประวัติพัง = ไม่ใช่ YOLO", () => {
  assert.equal(lastSendWasYolo([{ kind: "cold_q" }, { kind: "yolo" }]), true);
  assert.equal(lastSendWasYolo(JSON.stringify([{ kind: "yolo" }, { kind: "warm_review" }])), false);
  assert.equal(lastSendWasYolo("ไม่ใช่ json"), false);
  assert.equal(lastSendWasYolo(""), false);
  assert.equal(lastSendWasYolo(null), false);
});
