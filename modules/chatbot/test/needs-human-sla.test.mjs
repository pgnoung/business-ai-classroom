// needs-human-sla.test.mjs — นาฬิกา SLA ของคิว "รอคน"
//
// เหตุจริง 2026-09-02: ห้อง NEEDS_HUMAN 28 ห้อง — 11 ห้องไม่เคยมีคนตอบเลย
// สองห้องที่คุยเรื่องเงินรออยู่ 30 ชม. และ 169 ชม. เพราะ escalate_notify ยิงครั้งเดียว
// ตอนส่งต่อแล้วจบ ไม่มีอะไรทวงซ้ำ และหน้ารายการไม่บอกว่าใครรอมานานแค่ไหน
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createApp } from "../src/server.mjs";
import { openDb } from "../src/db.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  isWaitingForHuman,
  NEEDS_HUMAN_REMINDER_KEY_PREFIX,
  NEEDS_HUMAN_SLA_DEFAULT_MAX,
  parseReminderState,
  runNeedsHumanSla,
  selectDueReminders,
} from "../src/needsHumanSla.mjs";
import { needsPersonReason } from "../src/needsPersonReason.mjs";
import { runBackfill } from "../tools/needs-human-sla-backfill.mjs";
import { FB_HUMAN_OPERATOR } from "../src/facebookWebhook.mjs";
import { parseActiveHours } from "../src/scheduleGate.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
const WAIT_MS = 30 * MIN;
const WINDOW = parseActiveHours("08:00-20:00");
// 2026-09-02 10:00 และ 03:00 เวลาไทย (UTC+7 ไม่มี DST) — เวลาทำการ / ดึกสงัด
const DAYTIME = Date.UTC(2026, 8, 2, 3, 0, 0);
const NIGHT = Date.UTC(2026, 8, 2, 20, 0, 0);

function row(overrides = {}) {
  return {
    line_user_id: "U-wait",
    display_name: "ลูกค้ารอคน",
    known_name: "",
    state: "NEEDS_HUMAN",
    // setNeedsHuman เขียนเหตุไว้แบบนี้เสมอ — เหตุคือสิ่งที่ตัดสินว่าจะเสียค่า push ไหม
    handoff_summary: "[2026-09-02T01:00:00.000Z] complaint: ลูกค้าไม่พอใจเรื่องรอบเรียน",
    ai_enabled: 1,
    ai_off_reason: "",
    money_seen_at: 0,
    human_owner: "",
    channel_id: "default",
    last_slip_status: null,
    last_inbound_at: DAYTIME - HOUR,
    last_operator_outbound_at: null,
    unkept_promise: 0,
    ...overrides,
  };
}

const select = (rows, opts = {}) => selectDueReminders(rows, {
  now: DAYTIME, waitMs: WAIT_MS, maxReminders: 3, window: WINDOW, ...opts,
});
const idsOf = (due) => due.map((d) => d.row.line_user_id);

/* ------------------------------- ตัวเลือกบริสุทธิ์ ------------------------------- */

test("SLA: ห้องที่รอคนครบกำหนดแล้วยังไม่มีใครตอบ = ถึงกำหนดเตือน", () => {
  const due = select([row()]);
  assert.equal(due.length, 1);
  assert.equal(due[0].reminderNumber, 1);
  assert.equal(due[0].waitedMs, HOUR);
});

test("SLA: push เฉพาะห้องที่ต้องใช้คน — ครบทุกเหตุที่เจ้าของอนุมัติ", () => {
  const summary = (reason) => `[2026-09-02T01:00:00.000Z] ${reason}: เคสทดสอบ`;
  const rows = [
    row({ line_user_id: "U-complaint", handoff_summary: summary("complaint") }),
    row({ line_user_id: "U-optout", state: "AI_ACTIVE", handoff_summary: "", ai_enabled: 0, ai_off_reason: "optout" }),
    row({ line_user_id: "U-human-req", state: "AI_ACTIVE", handoff_summary: "", ai_enabled: 0, ai_off_reason: "human_requested" }),
    row({ line_user_id: "U-inhouse", state: "AI_ACTIVE", handoff_summary: "", ai_enabled: 0, ai_off_reason: "handoff_private_inhouse" }),
    row({ line_user_id: "U-opportunity", handoff_summary: summary("opportunity_handoff") }),
    row({ line_user_id: "U-mental", state: "AI_ACTIVE", handoff_summary: "", ai_enabled: 0, ai_off_reason: "urgent_mental" }),
  ];
  assert.equal(select(rows).length, 6);
  assert.deepEqual(select(rows).map((d) => d.reason).sort(), [
    "complaint", "handoff_private_inhouse", "human_requested", "opportunity_handoff", "optout", "urgent_mental",
  ].sort());
});

test("SLA: ห้องรอคนแบบทั่วไปห้าม push — เจ้าของสั่งว่าไม่คุ้มค่า push (2026-09-02)", () => {
  const summary = (reason) => `[2026-09-02T01:00:00.000Z] ${reason}: เคสทดสอบ`;
  const rows = [
    // ห้อง NEEDS_HUMAN ธรรมดา (คุยนอกเรื่องขาย) รอมา 3 ชม. ก็ยังไม่ push
    row({ line_user_id: "U-out-of-band", last_inbound_at: DAYTIME - 3 * HOUR, handoff_summary: summary("out_of_band") }),
    row({ line_user_id: "U-promise", state: "AI_ACTIVE", handoff_summary: "", unkept_promise: 1 }),
    row({ line_user_id: "U-promise-team", handoff_summary: summary("promise_team_followup") }),
    row({ line_user_id: "U-identity", state: "AI_ACTIVE", handoff_summary: "", ai_enabled: 0, ai_off_reason: "identity_question" }),
    // เส้นเงินทุกชนิด: มีป้าย 💰 บนคอนโซลอยู่แล้ว จึงไม่ต้องเสียค่า push ซ้ำ
    // (2026-09-05: เส้น follow-up ทวงโอนของ bank_sent ถูกยกเลิกตามคำสั่งพี่ง้วงแล้ว
    //  แต่ด่าน push ยังตัดสินเหมือนเดิมทุกไบต์ — ห้องเงินยังไม่ถูก push ซ้ำ)
    row({ line_user_id: "U-money", handoff_summary: summary("money_line"), money_seen_at: 1 }),
    row({ line_user_id: "U-bank", state: "AI_ACTIVE", handoff_summary: "", ai_enabled: 0, ai_off_reason: "bank_sent" }),
    row({ line_user_id: "U-payment", handoff_summary: summary("payment_review") }),
    row({ line_user_id: "U-legacy", handoff_summary: summary("legacy_pending_reply") }),
  ];
  assert.deepEqual(idsOf(select(rows)), []);
  // แต่ทุกห้องยังอยู่ใน "คิวรอคน" ของคอนโซลเหมือนเดิม — แค่ไม่เสียค่า push
  assert.ok(rows.filter(isWaitingForHuman).length >= 6);
});

test("SLA: ห้องที่ไม่ได้รอคนต้องไม่ถูกเตือน", () => {
  const rows = [
    row({ line_user_id: "U-active", state: "AI_ACTIVE" }),               // บอทดูแลอยู่
    row({ line_user_id: "U-resolved", state: "RESOLVED" }),
    // AI ปิดด้วยเหตุเส้นเงิน = เห็นได้จากป้าย 💰 บนคอนโซลอยู่แล้ว
    row({ line_user_id: "U-bank", state: "AI_ACTIVE", ai_enabled: 0, ai_off_reason: "bank_sent" }),
    row({ line_user_id: "U-fresh", last_inbound_at: DAYTIME - 5 * MIN }), // ยังไม่ครบ 30 นาที
    row({ line_user_id: "U-no-inbound", last_inbound_at: null }),
  ];
  assert.deepEqual(idsOf(select(rows)), []);
});

test("SLA: คนตอบไปแล้วหลังลูกค้าทัก = หลุดคิวทันที (ข้อความของบอทไม่นับว่ามีคนตอบ)", () => {
  const answered = row({
    line_user_id: "U-answered",
    last_inbound_at: DAYTIME - 3 * HOUR,
    last_operator_outbound_at: DAYTIME - 2 * HOUR,
  });
  assert.deepEqual(idsOf(select([answered])), []);
  // ลูกค้าทักกลับมาอีกหลังคนตอบ = กลับเข้าคิวใหม่
  const askedAgain = { ...answered, last_inbound_at: DAYTIME - HOUR };
  assert.deepEqual(idsOf(select([askedAgain])), ["U-answered"]);
});

test("SLA: นอกเวลาทำการไม่ยิงเลย แล้วยิงในรอบแรกที่เข้าเวลาทำการ", () => {
  const waited = row({ last_inbound_at: NIGHT - 5 * HOUR });
  assert.deepEqual(select([waited], { now: NIGHT }), [], "ตี 3 ต้องเงียบสนิท");
  const morning = Date.UTC(2026, 8, 3, 1, 0, 0); // 08:00 เวลาไทย
  assert.equal(select([waited], { now: morning }).length, 1, "เข้าเวลาทำการรอบแรกต้องได้เตือน");
});

test("SLA: เตือนครบเพดานแล้วหยุด และครั้งถัดไปต้องห่างอย่างน้อยหนึ่งช่วงรอ", () => {
  const state = new Map([["U-wait", { count: 1, lastAt: DAYTIME - 5 * MIN }]]);
  const reminderState = (id) => state.get(id) || { count: 0, lastAt: 0 };
  assert.deepEqual(idsOf(select([row()], { reminderState })), [],
    "เพิ่งเตือนไป 5 นาทีที่แล้ว ห้ามยิงซ้ำทุก tick");

  state.set("U-wait", { count: 1, lastAt: DAYTIME - 31 * MIN });
  assert.equal(select([row()], { reminderState })[0].reminderNumber, 2);

  // lastAt ต้องใหม่กว่าข้อความล่าสุดของลูกค้า ไม่งั้นตัวนับหมดอายุด้วยกติกา "เรื่องใหม่"
  state.set("U-wait", { count: 3, lastAt: DAYTIME - 45 * MIN });
  assert.deepEqual(idsOf(select([row()], { reminderState })), [], "ครบ 3 ครั้งแล้วต้องหยุด");
});

test("SLA: ลูกค้าพิมพ์มาใหม่หลังการเตือนครั้งล่าสุด = เริ่มบันไดใหม่ ไม่ใช่เงียบตลอดชีพ", () => {
  const t0 = DAYTIME - 6 * HOUR;
  const reminderState = () => ({ count: 3, lastAt: t0 });
  // (ก) ข้อความใหม่หลังการเตือนครั้งล่าสุด -> ถึงกำหนดอีกครั้ง และเริ่มนับหนึ่งใหม่
  const fresh = select([row({ last_inbound_at: t0 + HOUR })], { reminderState });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].reminderNumber, 1, "เรื่องใหม่ต้องเริ่มบันไดที่ครั้งที่ 1");
  // (ข) ไม่มีข้อความใหม่หลังการเตือน -> ยังเงียบเหมือนเดิม
  assert.deepEqual(idsOf(select([row({ last_inbound_at: t0 - HOUR })], { reminderState })), []);
});

test("SLA: เรียงคนรอนานสุดขึ้นก่อน (เพดานต่อรอบจะได้ตัดคนที่เพิ่งรอ)", () => {
  const rows = [
    row({ line_user_id: "U-2h", last_inbound_at: DAYTIME - 2 * HOUR }),
    row({ line_user_id: "U-9h", last_inbound_at: DAYTIME - 9 * HOUR }),
    row({ line_user_id: "U-1h", last_inbound_at: DAYTIME - HOUR }),
  ];
  assert.deepEqual(idsOf(select(rows)), ["U-9h", "U-2h", "U-1h"]);
});

/* --------------------------- รอบทำงานจริงกับฐานข้อมูล --------------------------- */

function stubNotifier() {
  const calls = [];
  return { calls, fireLater: (args) => calls.push(args), fire: async (args) => calls.push(args) };
}

// ลูกค้าที่ทักไว้แล้วไม่มีใครตอบมา waitedHours ชั่วโมง และห้องรอคนอยู่
function seedWaiting(db, id, waitedHours, { channelId = "default", extra = "", reason = "complaint", nowMs = Date.now() } = {}) {
  const at = nowMs - waitedHours * HOUR;
  db.upsertCustomer(id, { displayName: `รอ${waitedHours}ชม`, channelId });
  db.insertMessage({ customerId: id, direction: "in", content: "สอบถามหน่อยค่ะ" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(at, id);
  // ผ่าน setNeedsHuman จริง เพื่อให้ handoff_summary มี token เหตุแบบเดียวกับ production
  db.setNeedsHuman(id, reason, "เคสทดสอบ");
  db.raw.prepare(`UPDATE customers SET state = 'NEEDS_HUMAN', updated_at = ?${extra} WHERE line_user_id = ?`)
    .run(at, id);
  return id;
}

const slaConfig = (overrides = {}) => ({
  needsHumanSlaEnabled: true,
  needsHumanSlaMinutes: 30,
  needsHumanSlaMaxReminders: 3,
  // เทสต์ต้องไม่แพ้เวลาบนเครื่องที่รัน: ช่วงเวลานี้กว้างทั้งวันแต่ยัง parse ได้
  needsHumanSlaHours: "00:00-23:59",
  ...overrides,
});

test("SLA: รอบทำงานจริงยิงแจ้งทีม + จด audit + ตัวนับอยู่ใน DB", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedWaiting(db, "U-sla-1", 3);
  const notifier = stubNotifier();

  const result = runNeedsHumanSla({ db, notifier, config: slaConfig(), logger: silent });
  assert.equal(result.notified, 1);
  assert.equal(notifier.calls.length, 1);
  assert.equal(notifier.calls[0].customerId, "U-sla-1");
  assert.equal(notifier.calls[0].reason, "needs_human_sla");
  assert.equal(notifier.calls[0].force, true, "cooldown 10 นาทีของ notify ห้ามกลืนการทวงตามกำหนด");
  assert.match(notifier.calls[0].reasonTextOverride, /รอคนตอบมา 3 ชม\./u);
  assert.match(notifier.calls[0].reasonTextOverride, /เตือนครั้งที่ 1\/3/u);
  assert.ok(db.listAudit().some((r) => r.action === "needs_human_reminder" && r.target === "U-sla-1"),
    "ต้องเป็น action ของตัวเอง ไม่ใช่ escalate_notify");
  assert.equal(parseReminderState(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-sla-1`)).count, 1);
});

test("SLA: ตัวนับอยู่ใน DB — รีสตาร์ทแล้วห้องเดิมต้องไม่ถูกทวงซ้ำทันที", (t) => {
  // นาฬิกาเดียว: ฐานข้อมูล, fixture และทุกรอบประเมินอ่านจาก DAYTIME ตัวเดียวกัน
  const db = memoryDb({ now: () => DAYTIME });
  t.after(() => db.close());
  seedWaiting(db, "U-restart", 3, { nowMs: DAYTIME });
  const first = stubNotifier();
  runNeedsHumanSla({ db, notifier: first, config: slaConfig(), logger: silent, now: () => DAYTIME });
  assert.equal(first.calls.length, 1);

  // "รีสตาร์ท" = ตัวเรียกใหม่ทั้งชุด (notifier ใหม่ = cooldown in-memory ว่างเปล่า)
  // ฐานข้อมูลเดิมต้องเป็นคนจำเองว่าเคยทวงไปแล้วเมื่อไร
  const afterRestart = stubNotifier();
  const second = runNeedsHumanSla({ db, notifier: afterRestart, config: slaConfig(), logger: silent, now: () => DAYTIME });
  assert.equal(afterRestart.calls.length, 0, "รีสตาร์ทแล้วห้ามทวงซ้ำ");
  assert.equal(second.due, 0);

  // ผ่านไปอีกช่วงรอหนึ่ง = ทวงครั้งที่สองได้
  const later = stubNotifier();
  runNeedsHumanSla({ db, notifier: later, config: slaConfig(), logger: silent, now: () => DAYTIME + 31 * MIN });
  assert.equal(later.calls.length, 1);
  assert.match(later.calls[0].reasonTextOverride, /เตือนครั้งที่ 2\/3/u);
});

test("SLA: ลบข้อมูลลูกค้าตาม PDPA ต้องล้างตัวนับการเตือนด้วย", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedWaiting(db, "U-forget", 3);
  seedWaiting(db, "U-forget-2", 3); // คีย์ของคนอื่นต้องไม่หายไปด้วย
  runNeedsHumanSla({ db, notifier: stubNotifier(), config: slaConfig(), logger: silent });
  assert.ok(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-forget`));

  db.resetCustomer("U-forget", { forget: true });
  assert.equal(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-forget`), null,
    "คีย์ settings ของคนที่ถูกลืมต้องไม่เหลือเลย");
  assert.ok(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-forget-2`),
    "ห้ามกวาดคีย์ของลูกค้าคนอื่นไปด้วย");
});

test("SLA: มีคนตอบแล้วห้องหลุดคิว — ไม่มีการทวงรอบถัดไป", (t) => {
  // นาฬิกาเดียว: ข้อความขาออกของคนถูกเขียนด้วยนาฬิกาของ db ตัวเดียวกับที่รอบถัดไปใช้ประเมิน
  const db = memoryDb({ now: () => DAYTIME });
  t.after(() => db.close());
  seedWaiting(db, "U-answered", 3, { nowMs: DAYTIME });
  const first = stubNotifier();
  runNeedsHumanSla({ db, notifier: first, config: slaConfig(), logger: silent, now: () => DAYTIME });
  assert.equal(first.calls.length, 1);

  db.insertMessage({ customerId: "U-answered", direction: "out", content: "ขอโทษที่ตอบช้าค่ะ", operator: "chompoo" });
  const after = stubNotifier();
  runNeedsHumanSla({ db, notifier: after, config: slaConfig(), logger: silent, now: () => DAYTIME + 5 * HOUR });
  assert.equal(after.calls.length, 0, "คนตอบแล้วต้องหยุดทวงทันที");
});

test("SLA: ห้อง Facebook ต้องส่ง channel จริงเข้า notifier ไม่ใช่ default", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedWaiting(db, "U-fb", 4, { channelId: "fb-page" });
  const notifier = stubNotifier();
  runNeedsHumanSla({ db, notifier, config: slaConfig(), logger: silent });
  assert.equal(notifier.calls.length, 1);
  assert.equal(notifier.calls[0].channelId, "fb-page",
    "notify.mjs ใช้ค่านี้ติดป้าย 'เคสจาก Facebook' — ส่ง default ไปคนอ่านจะหาห้องผิดฝั่ง");
});

test("SLA: ห้องเส้นเงินต้องมี 💰 ในข้อความแจ้งทีม", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedWaiting(db, "U-money", 30, { extra: ", money_seen_at = 1" });
  const notifier = stubNotifier();
  runNeedsHumanSla({ db, notifier, config: slaConfig(), logger: silent });
  assert.match(notifier.calls[0].reasonTextOverride, /💰/u);
  assert.match(notifier.calls[0].reasonTextOverride, /รอคนตอบมา 1 วัน/u);
});

test("SLA: ปิดสวิตช์แล้วต้องไม่แตะอะไรเลย", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedWaiting(db, "U-off", 5);
  const notifier = stubNotifier();
  const result = runNeedsHumanSla({ db, notifier, config: slaConfig({ needsHumanSlaEnabled: false }), logger: silent });
  assert.deepEqual(result, { skipped: "disabled" });
  assert.equal(notifier.calls.length, 0);
  assert.equal(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-off`), null);
});

test("SLA: ตัวเตือนล้มเหลวห้ามโยน error ออกมา (งานเฝ้าห้ามล้มทั้ง tick)", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedWaiting(db, "U-boom", 5);
  const exploding = { fireLater: () => { throw new Error("push ล่ม"); } };
  const result = runNeedsHumanSla({ db, notifier: exploding, config: slaConfig(), logger: silent });
  assert.equal(result.notified, 0);
  assert.equal(result.due, 1);
});

test("SLA: แอดมินตอบจาก Business Suite นับเป็นคนตอบ — ห้อง Facebook นั้นต้องไม่ถูกทวง", (t) => {
  // ข้อความที่แอดมินพิมพ์ในแอป Business Suite ถูกบันทึกเป็นขาออกของ operator ชื่อนี้
  // ถ้าระบบไม่นับว่าเป็น "คน" ห้องที่ทีมงานตอบไปแล้วจะโดนทวงซ้ำทุกรอบ = เสียงหลอก
  const db = memoryDb();
  t.after(() => db.close());
  seedWaiting(db, "U-fb-answered", 6, { channelId: "fb-page" });
  db.insertMessage({
    customerId: "U-fb-answered", direction: "out", content: "รับเรื่องแล้วค่ะ",
    operator: FB_HUMAN_OPERATOR, channelId: "fb-page",
  });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ? AND direction = 'out'")
    .run(Date.now() - 5 * HOUR, "U-fb-answered");
  const notifier = stubNotifier();
  const result = runNeedsHumanSla({ db, notifier, config: slaConfig(), logger: silent });
  assert.equal(notifier.calls.length, 0, `"${FB_HUMAN_OPERATOR}" ต้องนับเป็นคนตอบ`);
  assert.equal(result.due, 0);

  // ลูกค้าทักกลับมาใหม่หลังแอดมินตอบ = กลับเข้าคิวตามปกติ (กันเทสต์ผ่านเพราะเหตุอื่น)
  db.insertMessage({ customerId: "U-fb-answered", direction: "in", content: "แล้วเมื่อไหร่คะ" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ? AND direction = 'in'")
    .run(Date.now() - HOUR, "U-fb-answered");
  const after = stubNotifier();
  runNeedsHumanSla({ db, notifier: after, config: slaConfig(), logger: silent });
  assert.equal(after.calls.length, 1);
});

test("SLA: ห้องที่ถูก backfill ปิดไว้ กลับมาได้เตือนเมื่อลูกค้าทักใหม่ และคีย์ถูกเขียนทับเป็น 1|now", (t) => {
  const T = Date.UTC(2026, 8, 2, 5, 0, 0); // 12:00 เวลาไทย — ในเวลาทำการ
  const db = memoryDb({ now: () => T }); // นาฬิกาเดียวกับที่ส่งให้ runNeedsHumanSla
  t.after(() => db.close());
  const t0 = T - 6 * HOUR;
  seedWaiting(db, "U-backfilled", 1, { nowMs: T }); // ลูกค้าทักล่าสุดเมื่อชั่วโมงที่แล้ว (ใหม่กว่า t0)
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(T - HOUR, "U-backfilled");
  db.setSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-backfilled`, `${NEEDS_HUMAN_SLA_DEFAULT_MAX}|${t0}`);

  const notifier = stubNotifier();
  runNeedsHumanSla({ db, notifier, config: slaConfig(), logger: silent, now: () => T });
  assert.equal(notifier.calls.length, 1, "ข้อความใหม่ที่ไม่มีใครตอบต้องได้บันไดเตือนของตัวเอง");
  assert.match(notifier.calls[0].reasonTextOverride, /เตือนครั้งที่ 1\/3/u);
  assert.equal(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-backfilled`), `1|${T}`,
    "คีย์ต้องถูกเขียนทับจากตัวนับใหม่ ไม่ใช่บวกต่อจากของเก่า");

  // ห้องที่ข้อความล่าสุดเก่ากว่าการเตือนครั้งล่าสุด ยังต้องเงียบ (หนี้เก่าที่ backfill ปิดไว้)
  seedWaiting(db, "U-old-debt", 60, { nowMs: T });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(t0 - HOUR, "U-old-debt");
  db.setSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-old-debt`, `${NEEDS_HUMAN_SLA_DEFAULT_MAX}|${t0}`);
  const after = stubNotifier();
  runNeedsHumanSla({ db, notifier: after, config: slaConfig(), logger: silent, now: () => T + 2 * HOUR });
  const notified = after.calls.map((c) => c.customerId);
  assert.ok(!notified.includes("U-old-debt"), "หนี้เก่าที่ยังไม่มีข้อความใหม่ต้องเงียบต่อ");
  // ห้องที่เพิ่งเริ่มบันไดใหม่เดินต่อเป็นครั้งที่ 2 ตามปกติ (ยืนยันว่าเทสต์ไม่ได้ผ่านเพราะรอบนี้เงียบทั้งกระดาน)
  assert.deepEqual(notified, ["U-backfilled"]);
  assert.match(after.calls[0].reasonTextOverride, /เตือนครั้งที่ 2\/3/u);
});

test("SLA: ลูกค้าเก่า 300 ห้องต้องไม่กินโควตาการอ่านจนห้องร้องเรียนไม่เคยถูกเห็น", (t) => {
  // บั๊กของจริง 2026-09-02 (เจอตอนรัน backfill dry-run กับฐานข้อมูลจริง):
  // เครื่องจริงมีห้อง ai_enabled=0 / ai_off_reason='customer_handover' ~818 ห้อง
  // WHERE เดิมกวาด ai_enabled != 1 ทั้งหมด เรียงเก่าสุดก่อน แล้ว LIMIT 200
  // = ห้องเก่าล้วนเต็มโควตา ห้องที่ต้องใช้คนจริงไม่เคยหลุดเข้ามาเลยสักรอบ
  const db = memoryDb();
  t.after(() => db.close());
  for (let i = 0; i < 300; i += 1) {
    const id = `U-handover-${String(i).padStart(4, "0")}`;
    db.upsertCustomer(id, { displayName: "ลูกค้าเก่า" });
    db.insertMessage({ customerId: id, direction: "in", content: "สวัสดีค่ะ" });
    db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?")
      .run(Date.now() - (500 + i) * HOUR, id); // เก่ากว่าห้องจริงทุกห้อง
    db.setAiEnabled(id, false, "customer_handover");
  }
  seedWaiting(db, "U-real-complaint", 2, { reason: "complaint" });

  const rows = db.listNeedsHumanSlaCandidates();
  assert.deepEqual(rows.map((r) => r.line_user_id), ["U-real-complaint"],
    "ตัวอ่านต้องคืนเฉพาะห้องที่ต้องใช้คน ไม่ใช่ลูกค้าเก่าที่ปิด AI ไว้");

  const notifier = stubNotifier();
  const result = runNeedsHumanSla({ db, notifier, config: slaConfig(), logger: silent });
  assert.equal(result.scanned, 1);
  assert.deepEqual(notifier.calls.map((c) => c.customerId), ["U-real-complaint"]);
  assert.equal(needsPersonReason(rows[0]), "complaint");
});

/* ------------------------- เครื่องมือปิดบันไดเตือนหนี้เก่า ------------------------- */

test("backfill: ห้องเก่าเกินเกณฑ์ถูกปิดบันไดเตือน ส่วนห้องที่เพิ่งรอยังได้บันไดเต็ม", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const now = Date.now();
  seedWaiting(db, "U-old-48h", 48);
  seedWaiting(db, "U-new-2h", 2);
  seedWaiting(db, "U-answered-70h", 70);
  db.insertMessage({ customerId: "U-answered-70h", direction: "out", content: "ดูแลต่อให้แล้วค่ะ", operator: "chompoo" });

  // dry-run ต้องไม่เขียนอะไรเลย
  const lines = [];
  const dry = runBackfill({ db, olderThanHours: 24, now, log: (line) => lines.push(line) });
  assert.equal(dry.marked, 1);
  assert.equal(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-old-48h`), null, "dry-run ห้ามเขียน");
  assert.ok(lines.some((line) => line.includes("…ld-48h")), "ต้องพิมพ์ id แบบตัดเหลือ 6 ตัวท้าย");
  assert.ok(lines.every((line) => !line.includes("U-old-48h")), "ห้ามพิมพ์ id เต็มลง log");

  const applied = runBackfill({ db, olderThanHours: 24, apply: true, now, log: () => {} });
  assert.equal(applied.marked, 1);
  // ห้องที่คนตอบไปแล้วถูกกรองตั้งแต่ SQL — ไม่มาถึงเครื่องมือให้ต้อง "ข้าม" ด้วยซ้ำ
  assert.equal(applied.skipped, 1, "เหลือแค่ห้องที่รอ 2 ชม. ที่ถูกข้ามเพราะยังไม่ถึงเกณฑ์");
  assert.equal(applied.scanned, 2);
  assert.equal(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-old-48h`), `${NEEDS_HUMAN_SLA_DEFAULT_MAX}|${now}`);
  assert.equal(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-new-2h`), null);
  assert.equal(db.getSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}U-answered-70h`), null);
  assert.ok(db.listAudit().some((r) => r.action === "needs_human_reminder_backfill"), "ต้องมีร่องรอยว่าใครสั่ง");

  // หลัง backfill: ห้องเก่าเงียบ ห้องที่ตอบแล้วเงียบ เหลือแค่ห้องที่รอ 2 ชม.
  const due = selectDueReminders(db.listNeedsHumanSlaCandidates(), {
    now, waitMs: WAIT_MS, maxReminders: NEEDS_HUMAN_SLA_DEFAULT_MAX,
    reminderState: (id) => parseReminderState(db.getSetting(NEEDS_HUMAN_REMINDER_KEY_PREFIX + id)),
  });
  assert.deepEqual(idsOf(due), ["U-new-2h"]);
});

/* --------------------------------- ฝั่งคอนโซล --------------------------------- */

const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";

test("คอนโซล: รายการแชทต้องส่ง money_seen_at ออกมาให้หน้าเว็บติดป้ายเส้นเงินได้", async (t) => {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: hashPassword(PASSWORD), displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.needsHumanSla.stop(); app.server.close(); db.close(); });
  seedWaiting(db, "U-inbox-money", 30, { extra: ", money_seen_at = 1" });

  const login = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: PASSWORD }),
  });
  const cookie = (login.headers["set-cookie"]?.[0] || "").split(";")[0];
  const res = await httpRequest(app.server, { path: "/console/api/inbox?segment=needs", headers: { cookie } });
  assert.equal(res.status, 200);
  const room = res.json.conversations.find((c) => c.line_user_id === "U-inbox-money");
  assert.ok(room, "ห้องต้องอยู่ในคิวรอคน");
  assert.equal(Number(room.money_seen_at), 1);
  assert.ok(room.last_inbound_at > 0, "หน้าเว็บต้องได้เวลาที่ลูกค้าทักล่าสุดไปคำนวณเวลารอ");
});

/* ------------------------ เรียกเครื่องมือผ่าน symlink บนเครื่องจริง ------------------------ */

const execFileAsync = promisify(execFile);
const CHASSIS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ของจริง 2026-09-02: บน VPS สคริปต์ถูกเรียกผ่าน /opt/app/current/chassis/tools/...
// โดย `current` เป็น symlink — ด่าน `import.meta.url === \`file://${process.argv[1]}\``
// จึงเป็นเท็จเสมอ (Node คลี่ symlink ให้แล้ว) main() ไม่ถูกเรียก สคริปต์เงียบสนิท
// ไม่มี error ไม่มี output คนสั่งจึงเข้าใจว่า "ไม่มีอะไรต้องทำ" ทั้งที่ยังไม่ได้รันเลย
for (const tool of ["needs-human-sla-backfill.mjs", "reopen-fb-human-replying.mjs"]) {
  test(`เครื่องมือ ${tool}: เรียกผ่านพาธที่เป็น symlink แล้วต้องทำงานจริง ไม่ใช่เงียบ`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "lukprae-symlink-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const dbFile = join(dir, "chassis.sqlite");
    const db = openDb({ file: dbFile }); // ไฟล์จริง — โปรเซสลูกต้องเปิดอ่านได้
    seedWaiting(db, "U-symlink", 3);
    db.close();

    symlinkSync(CHASSIS_ROOT, join(dir, "current")); // เลียนแบบ /opt/app/current
    const { stdout } = await execFileAsync(process.execPath, [
      join(dir, "current", "tools", tool), "--db", dbFile, "--dry-run",
    ]);
    assert.match(stdout, /รวม/u, "ต้องพิมพ์บรรทัดสรุป ไม่ใช่ไม่ทำอะไรเลย");
  });
}
