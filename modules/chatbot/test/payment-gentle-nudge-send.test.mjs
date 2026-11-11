// ทักเบา ๆ หลังส่งเลขบัญชี — เส้นส่งจริงบน DB ในหน่วยความจำ (LINE/FB stub · ลูกค้าสังเคราะห์)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createPaymentGentleNudge, PAYMENT_GENTLE_NUDGE_KEY, paymentNudgePreview } from "../src/paymentGentleNudge.mjs";
import { createStagedFollowups } from "../src/stagedFollowups.mjs";
import { bangkokIsoDate } from "../src/followupTiming.mjs";
import { poisonGlobalFetch, testConfig, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
const bkk = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 7, minute, 0); // ก.ย. 2026 เวลาไทย
const hm = (ts) => new Date(ts + 7 * HOUR).toISOString().slice(11, 16);

function roundsFile() {
  const dir = mkdtempSync(join(tmpdir(), "pay-rounds-"));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify({
    classes: { basic: { label: "Classroom AI Agent for Business", product: "AI Agent for Business" } },
    rounds: [{ date: "2026-10-10", class: "basic", status: "open" }],
  }));
  return file;
}

function makeWorld({ customerId = "U-pay", channelId = "default", bankAt = bkk(28, 10) } = {}) {
  const clock = { now: bankAt - 2 * MIN };
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0", CLASS_ROUNDS_FILE: roundsFile(), SALES_DECISION_GUARD_ENABLED: "true" });
  const db = memoryDb({ now: () => clock.now });
  const pushes = [];
  const lineCh = { sendBubbles: async (args) => { pushes.push(args); return { ok: true }; } };
  const lineRegistry = { forChannel: () => lineCh, rawUserId: (id) => id };
  const guard = createComplianceGuard({ bannedWords: ["การันตี"], getApprovedPrices: () => db.approvedPrices() });
  const nudge = createPaymentGentleNudge({ config, db, lineRegistry, guard, humanizer: createHumanizer(), logger: silent, now: () => clock.now });
  db.upsertCustomer(customerId, { displayName: "Somchai", channelId });
  // ห้องหลังส่งบัญชีในเส้น SALES_DECISION_GUARD: AI เปิด · รอชำระ · follow-up ปกติถูกปิด
  db.setDealStatus(customerId, "awaiting_payment");
  db.setFollowupEnabled(customerId, false);
  const at = (ms, fn) => { clock.now = ms; return fn(); };
  at(bankAt - MIN, () => db.insertMessage({ customerId, direction: "in", msgType: "text", content: "ขอช่องทางชำระเงินหน่อยค่ะ" }));
  at(bankAt, () => {
    db.insertMessage({ customerId, direction: "out", msgType: "text", messageClass: "reactive", agentMode: "ai",
      content: "สรุปคลาส AI Agent for Business รอบ 10 ต.ค. ค่ะ\nชำระผ่านช่องทางของบริษัทได้ตามนี้ค่ะ" });
    db.addAudit({ operator: "system", action: "bank_sent_info_continues", target: customerId, detail: "test" });
  });
  return { db, clock, pushes, nudge, customerId, config, lineRegistry, guard };
}

test("LINE: ส่งบัญชีแล้วเงียบ = ทักหนึ่งครั้งวันถัดไปช่วงสาย ๆ พร้อมรอบ · ไม่ทักซ้ำ · badge ตรงเวลาที่ยิง", async (t) => {
  const w = makeWorld();
  t.after(() => w.db.close());
  const customer = () => w.db.getCustomer(w.customerId);
  const preview = paymentNudgePreview({ db: w.db, config: w.config, customer: customer(), nowMs: bkk(28, 12) });
  assert.equal(preview.stage, "payment_nudge");
  assert.equal(bangkokIsoDate(preview.dueAt), "2026-09-29");
  assert.ok(hm(preview.dueAt) >= "10:00" && hm(preview.dueAt) <= "11:30");

  w.clock.now = bkk(28, 15);
  await w.nudge.runTick(w.clock.now);
  assert.equal(w.pushes.length, 0, "วันเดียวกันยังไม่ทัก");
  w.clock.now = preview.dueAt - MIN;
  await w.nudge.runTick(w.clock.now);
  assert.equal(w.pushes.length, 0);
  w.clock.now = preview.dueAt;
  const out = await w.nudge.runTick(w.clock.now);
  assert.equal(out.results[0].sent, "payment_gentle_nudge");
  assert.equal(w.pushes.length, 1);
  const text = w.pushes[0].bubbles.map((b) => b.text).join("\n");
  assert.match(text, /การสมัครรอบ 10 ต\.ค\./u);
  assert.match(text, /สลิป/u);
  assert.doesNotMatch(text, /บาท|\d{3,}|รีบ|ด่วน|ทวง/u);
  assert.equal(w.pushes[0].batch, true);
  const audit = w.db.listAudit(10).find((row) => row.action === "payment_gentle_nudge_sent");
  assert.match(audit.detail, /line/u);
  const logged = w.db.messagesFor(w.customerId, 10).filter((m) => m.message_class === "proactive");
  assert.equal(logged.length, w.pushes[0].bubbles.length);

  for (const at of [preview.dueAt + HOUR, bkk(30, 10, 45), bkk(1 + 30, 11)]) {
    w.clock.now = at;
    await w.nudge.runTick(at);
  }
  assert.equal(w.pushes.length, 1, "หนึ่งรอบส่งบัญชี = ข้อความเดียว");
  assert.deepEqual(paymentNudgePreview({ db: w.db, config: w.config, customer: customer(), nowMs: bkk(30, 12) }), { blocked: "payment_nudge_done" });
  assert.equal(customer().followup_enabled, 0, "บันไดปกติยังหยุดเหมือนเดิม");
});

test("คนในทีมตอบหลังส่งบัญชี = ไม่ทัก · จด audit ข้ามครั้งเดียว", async (t) => {
  const w = makeWorld({ customerId: "U-pay-human" });
  t.after(() => w.db.close());
  w.clock.now = bkk(28, 10, 20);
  w.db.insertMessage({ customerId: w.customerId, direction: "out", msgType: "text", messageClass: "reactive", operator: "admin-a", agentMode: "operator_ai_on", content: "ได้เลยค่ะ" });
  for (const at of [bkk(28, 11), bkk(29, 10, 30), bkk(29, 11, 20)]) {
    w.clock.now = at;
    await w.nudge.runTick(at);
  }
  assert.equal(w.pushes.length, 0);
  const skips = w.db.listAudit(20).filter((row) => row.action === "payment_gentle_nudge_skipped");
  assert.equal(skips.length, 1);
  assert.equal(skips[0].detail, "human_replied");
});

test("ลูกค้าส่งรูป (สลิป) หรือถามเรื่องใหม่หลังส่งบัญชี = ไม่ทัก", async (t) => {
  for (const [msgType, content, reason] of [["image", "[image]", "payment_evidence"], ["text", "ต้องโอนภายในวันไหนคะ", "customer_replied"]]) {
    const w = makeWorld({ customerId: `U-pay-${msgType}` });
    t.after(() => w.db.close());
    w.clock.now = bkk(28, 10, 30);
    w.db.insertMessage({ customerId: w.customerId, direction: "in", msgType, content });
    w.clock.now = bkk(29, 11, 25);
    await w.nudge.runTick(w.clock.now);
    assert.equal(w.pushes.length, 0, reason);
    assert.equal(w.db.listAudit(20).find((row) => row.action === "payment_gentle_nudge_skipped")?.detail, reason);
  }
});

test("เปิดฟีเจอร์/สวิตช์ทีหลัง: ห้องที่ช่องเวลาผ่านไปนานแล้วไม่ถูกยิงรวดเดียว · จด audit ข้ามครั้งเดียว", async (t) => {
  const w = makeWorld({ customerId: "U-pay-backlog", bankAt: bkk(25, 10) });
  t.after(() => w.db.close());
  w.clock.now = bkk(28, 15);
  await w.nudge.runTick(w.clock.now);
  await w.nudge.runTick(w.clock.now + MIN);
  assert.equal(w.pushes.length, 0);
  const skips = w.db.listAudit(20).filter((row) => row.action === "payment_gentle_nudge_skipped");
  assert.deepEqual(skips.map((row) => row.detail), ["slot_missed"]);
});

test("สถานะทาง Telegram เล่าเรื่องเดียวกับ badge: ห้องหลังส่งบัญชีบอกเวลาทักครั้งเดียว ไม่ใช่ 'ปิดการติดตาม'", async (t) => {
  const w = makeWorld({ customerId: "U-pay-status" });
  t.after(() => w.db.close());
  const { describeRoomStatus } = await import("../src/yoloStatus.mjs");
  const config = { ...w.config, stagedFollowupTickMs: 60_000 };
  const status = describeRoomStatus({ db: w.db, config, customerId: w.customerId, nowMs: bkk(28, 12) });
  assert.match(status.followup, /หลังส่งบัญชี/u);
  assert.doesNotMatch(status.followup, /ห้องนี้ปิดการติดตาม/u);
});

test("สวิตช์ payment_gentle_nudge = off → ไม่ทักเลย (พฤติกรรมก่อน 28 ก.ย.)", async (t) => {
  const w = makeWorld({ customerId: "U-pay-off" });
  t.after(() => w.db.close());
  w.db.setSetting(PAYMENT_GENTLE_NUDGE_KEY, "off");
  w.clock.now = bkk(29, 11, 29);
  const out = await w.nudge.runTick(w.clock.now);
  assert.deepEqual(out, { skipped: "disabled" });
  assert.equal(w.pushes.length, 0);
  assert.equal(paymentNudgePreview({ db: w.db, config: w.config, customer: w.db.getCustomer(w.customerId), nowMs: w.clock.now }), null);
});

test("FB: ทัก 5–8 ชม. หลังข้อความลูกค้าในหน้าต่าง 24 ชม. · ส่งบัญชีตอนหัวค่ำ = ไม่ทัก", async (t) => {
  const morning = makeWorld({ customerId: "facebook:1122334455", channelId: "facebook", bankAt: bkk(28, 10) });
  t.after(() => morning.db.close());
  const preview = paymentNudgePreview({ db: morning.db, config: morning.config, customer: morning.db.getCustomer(morning.customerId), nowMs: bkk(28, 11) });
  assert.ok(preview.dueAt - bkk(28, 10) >= 5 * HOUR - 2 * MIN && preview.dueAt - bkk(28, 10) <= 8 * HOUR, hm(preview.dueAt));
  morning.clock.now = preview.dueAt;
  await morning.nudge.runTick(morning.clock.now);
  assert.equal(morning.pushes.length, 1);

  const evening = makeWorld({ customerId: "facebook:5544332211", channelId: "facebook", bankAt: bkk(28, 17) });
  t.after(() => evening.db.close());
  evening.clock.now = bkk(28, 17, 5);
  await evening.nudge.runTick(evening.clock.now);
  assert.equal(evening.pushes.length, 0);
  assert.equal(evening.db.listAudit(20).find((row) => row.action === "payment_gentle_nudge_skipped")?.detail, "fb_no_daytime_slot");
});

test("เครื่องยนต์ follow-up เรียกตัวทักหลังส่งบัญชีในรอบเดียวกัน · สวิตช์รวม FU ปิด = ไม่ทัก", async (t) => {
  const w = makeWorld({ customerId: "U-pay-engine" });
  t.after(() => w.db.close());
  const hermes = createHermesBridge({ config: w.config, fetchImpl: async () => { throw new Error("ห้ามเรียกโมเดล"); }, logger: silent });
  const engine = createStagedFollowups({
    config: w.config, db: w.db, hermes, lineRegistry: w.lineRegistry, guard: w.guard, humanizer: createHumanizer(),
    logger: silent, now: () => w.clock.now, imageCatalog: [], paymentNudge: w.nudge,
  });
  w.db.setSetting("staged_followup_enabled", "0");
  w.clock.now = bkk(29, 11, 29);
  await engine.runOnce();
  assert.equal(w.pushes.length, 0, "สวิตช์รวม FU ปิด = ไม่มีข้อความอัตโนมัติชนิดใด");
  w.db.setSetting("staged_followup_enabled", "1");
  const out = await engine.runOnce();
  assert.equal(w.pushes.length, 1);
  assert.equal(out.payment.results[0].sent, "payment_gentle_nudge");
});
