// brain-parity-watch.test.mjs — ตัวเฝ้าสมองเงา (เฟส 1a): ตัวนับ "ตรงกี่วันติด",
// การปลุกทีมเมื่อเริ่มไม่ตรง, และทางที่คนเห็นผลจริง (/health + สรุปรายวันถึงเจ้าของ)
//
// สิ่งที่ต้องไม่พลาด:
// - ตัวนับต้องขยับ "วันละครั้ง" ไม่ใช่ทุก tick (tick 6 ชม. = 4 รอบต่อวัน)
// - ไม่ตรงแบบเดิมต้องปลุกครั้งเดียว ไม่ใช่ทุกรอบ (ไม่งั้นทีมปิดเสียงทิ้ง)
// - ปิดสวิตช์ = ไม่แตะฐาน ไม่ปลุกใคร และสรุปรายวันต้องเหมือนเดิมทุกไบต์
import test from "node:test";
import assert from "node:assert/strict";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { createApp } from "../src/server.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import {
  createBrainParityWatch, nextParityStreak, parityDriftSignature,
  BRAIN_PARITY_LAST_KEY, BRAIN_PARITY_STREAK_KEY,
} from "../src/brain/parityWatch.mjs";
import { buildDigestBubbles, brainParityDigestLine } from "../src/digest.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const QUIET = { warn() {}, debug() {}, log() {} };
const DAY_MS = 86_400_000;
// 03:00 UTC = 10:00 เวลาไทย — กลางวันแน่นอน ไม่คร่อมเส้นวันของ Asia/Bangkok
// เดิมตรึงไว้เป็นปีไกล ๆ ในอนาคตเพื่อ "วิ่งหนี" wall clock ของ db — ตอนนี้ db รับนาฬิกา
// ตัวเดียวกันแล้ว จึงใช้วันจริงที่อ่านออกได้ ไม่ต้องหนีอีก
const CLOCK = Date.UTC(2026, 0, 15, 3, 0, 0);

// นาฬิกาเดียว: ฐานข้อมูลกับตัวเฝ้าต้องอ่านเวลาตัวเดียวกัน เทสต์ที่เดินนาฬิกาเองส่ง
// closure ของตัวเข้ามา (seeded(() => clock)) แถวสมองจึงอยู่บนแกนเวลาเดียวกับที่ตรวจ
function seeded(now = () => CLOCK) {
  const db = memoryDb({ now });
  db.addKnowledge({ title: "แคตตาล็อก", content: "คลาส AI Agent for Business", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  importCurrentSourcesAsVersion1(db, { now, logger: QUIET });
  return db;
}

function fakeNotifier() {
  const calls = [];
  return { calls, fireLater: (args) => calls.push(args) };
}

function watchOn(db, { now, notifier = fakeNotifier(), overrides = {} } = {}) {
  const config = testConfig({ BRAIN_SHADOW_PARITY: "true", ...overrides });
  return { watch: createBrainParityWatch({ db, config, notifier, logger: silent, now }), notifier, config };
}

/* ------------------------------ ตัวนับวันติดกัน ------------------------------ */

test("ตรงแล้วนับ 'วันติด' เพิ่มตามเส้นวัน ไม่ใช่ตาม tick", () => {
  let clock = CLOCK;
  const db = seeded(() => clock);
  const { watch } = watchOn(db, { now: () => clock });

  const first = watch.runOnce();
  assert.equal(first.ok, true, `ต้องตรงตั้งแต่รอบแรก (${first.reason})`);
  assert.equal(first.streakDays, 1);

  // อีกสาม tick ที่ยังอยู่ในวันเดียวกันตามเวลาไทย (10:00 -> 14:00 -> 18:00 -> 22:00)
  // — ตัวนับต้องไม่ขยับ เพราะด่านนับเป็น "คืน" ไม่ใช่ "จำนวนรอบที่ตรวจแล้วตรง"
  for (let i = 0; i < 3; i += 1) {
    clock += 4 * 3_600_000;
    assert.equal(watch.runOnce().streakDays, 1, "tick ในวันเดียวกันห้ามเพิ่มตัวนับ");
  }
  // ข้ามวันแล้วค่อย +1
  clock = CLOCK + DAY_MS;
  assert.equal(watch.runOnce().streakDays, 2);
  clock = CLOCK + 2 * DAY_MS;
  assert.equal(watch.runOnce().streakDays, 3);

  const last = JSON.parse(db.getSetting(BRAIN_PARITY_LAST_KEY));
  assert.equal(last.ok, true);
  assert.equal(last.reason, "match");
  assert.deepEqual(last.mismatches, []);
  assert.ok(last.version, "ต้องบันทึกเวอร์ชันที่ตรวจไว้ด้วย");
  assert.equal(JSON.parse(db.getSetting(BRAIN_PARITY_STREAK_KEY)).days, 3);
  db.close();
});

test("nextParityStreak: ไม่ตรง = ล้างเป็นศูนย์ · ยังไม่มีเวอร์ชันสมอง = ไม่นับและไม่ล้าง", () => {
  const stored = { days: 4, lastDay: "2026-01-15" };
  assert.deepEqual(nextParityStreak(stored, { ok: false, hasVersion: true, todayIso: "2026-01-16" }), { days: 0, lastDay: null });
  assert.deepEqual(nextParityStreak(stored, { ok: true, hasVersion: false, todayIso: "2026-01-16" }), stored);
  assert.deepEqual(nextParityStreak(null, { ok: true, hasVersion: true, todayIso: "2026-01-16" }), { days: 1, lastDay: "2026-01-16" });
  assert.deepEqual(nextParityStreak({ days: "พัง" }, { ok: true, hasVersion: true, todayIso: "2026-01-16" }), { days: 1, lastDay: "2026-01-16" });
});

/* -------------------------------- เมื่อไม่ตรง -------------------------------- */

test("ไม่ตรง = ปลุกทีมครั้งเดียวต่ออาการหนึ่งแบบ และล้างตัวนับ", () => {
  let clock = CLOCK;
  const db = seeded(() => clock);
  const { watch, notifier } = watchOn(db, { now: () => clock });
  assert.equal(watch.runOnce().streakDays, 1);

  // แหล่งความจริงขยับ แต่สมองยังเป็นเวอร์ชันเดิม = ไม่ตรง
  db.setApprovedPrice("AI Agent for Business", 21900);
  clock += 6 * 3_600_000;
  const drift = watch.runOnce();
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.mismatches, ["guardTables.approvedPrices"]);
  assert.equal(drift.streakDays, 0, "ไม่ตรง = ล้มกระดาน");
  assert.equal(drift.notified, true);
  assert.equal(notifier.calls.length, 1);

  const call = notifier.calls[0];
  assert.equal(call.customerId, "ops:brain");
  assert.equal(call.reason, "brain_parity_drift");
  assert.equal(call.force, true);
  assert.match(call.reasonTextOverride, /สมองเงาไม่ตรงกับตารางที่ระบบใช้จริง/u);
  assert.match(call.reasonTextOverride, /guardTables\.approvedPrices/u);

  // อาการเดิมอีกสามรอบ (ข้ามวันด้วย) = ไม่ปลุกซ้ำ
  for (let i = 1; i <= 3; i += 1) {
    clock = CLOCK + i * DAY_MS;
    const again = watch.runOnce();
    assert.equal(again.notified, false, "อาการเดิมห้ามปลุกซ้ำ");
    assert.equal(again.streakDays, 0);
  }
  assert.equal(notifier.calls.length, 1);

  // อาการเปลี่ยน (มีส่วนที่ต่างเพิ่ม) = ปลุกใหม่ได้
  db.setSetting("product_rules", "กติกาใหม่ที่สมองยังไม่รู้");
  clock += DAY_MS;
  const worse = watch.runOnce();
  assert.equal(worse.notified, true, "อาการใหม่ = ลายเซ็นใหม่ = ปลุกได้อีกครั้ง");
  assert.ok(worse.mismatches.length > 1);
  assert.equal(notifier.calls.length, 2);

  // บันทึก audit ไว้ให้ตามย้อนได้ (ไม่มีเนื้อความรู้ในนั้น)
  const audit = db.listAudit(10).filter((row) => row.action === "brain_parity_drift");
  assert.equal(audit.length, 2);
  assert.match(audit[0].detail, /guardTables\.approvedPrices|rules\./u);
  db.close();
});

test("ลายเซ็นอาการไม่ขึ้นกับลำดับ และรอบที่ตรงมีลายเซ็นว่าง", () => {
  const a = { ok: false, reason: "mismatch", mismatches: ["b", "a"] };
  const b = { ok: false, reason: "mismatch", mismatches: ["a", "b"] };
  assert.equal(parityDriftSignature(a), parityDriftSignature(b));
  assert.equal(parityDriftSignature({ ok: true, reason: "match", mismatches: [] }), "");
  assert.equal(parityDriftSignature(null), "");
});

test("ยังไม่มีเวอร์ชันสมองเลย = ไม่ปลุกใคร และตัวนับไม่ขยับ", () => {
  const db = memoryDb({ now: () => CLOCK });
  const { watch, notifier } = watchOn(db, { now: () => CLOCK });
  const result = watch.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.reason, "no_brain_version");
  assert.equal(result.streakDays, 0);
  assert.equal(notifier.calls.length, 0);
  assert.equal(watch.snapshot().parity, "none");
  db.close();
});

/* ---------------------------------- ปิดอยู่ ---------------------------------- */

test("ปิด BRAIN_SHADOW_PARITY = ไม่ตรวจ ไม่เขียน ไม่ปลุก และไม่ตั้ง timer", () => {
  const db = seeded();
  const notifier = fakeNotifier();
  const watch = createBrainParityWatch({
    db, config: testConfig(), notifier, logger: silent, now: () => CLOCK,
  });
  assert.deepEqual(watch.runOnce(), { skipped: "disabled" });
  assert.equal(db.getSetting(BRAIN_PARITY_LAST_KEY), null);
  assert.equal(db.getSetting(BRAIN_PARITY_STREAK_KEY), null);
  assert.equal(notifier.calls.length, 0);
  assert.equal(watch.start(), false, "ปิดอยู่ต้องไม่ arm");
  assert.equal(watch.running, false);
  assert.deepEqual(watch.snapshot(), { parity: "none", streakDays: 0, lastAt: null, version: null, mismatches: [] });
  db.close();
});

test("BRAIN_PARITY_TICK_MS: default 6 ชม., ตั้ง 0 = ไม่ arm, เปิดแล้ว arm/stop ได้", () => {
  assert.equal(testConfig().brainParityTickMs, 6 * 60 * 60_000);
  assert.equal(testConfig({ BRAIN_PARITY_TICK_MS: "900000" }).brainParityTickMs, 900_000);

  const db = seeded();
  const off = createBrainParityWatch({
    db, config: testConfig({ BRAIN_SHADOW_PARITY: "true", BRAIN_PARITY_TICK_MS: "0" }), logger: silent,
  });
  assert.equal(off.start(), false, "tick 0 = ไม่ตั้งตัวเฝ้า");

  const { watch } = watchOn(db, { now: () => CLOCK });
  assert.equal(watch.start(), true);
  assert.equal(watch.running, true);
  assert.equal(watch.start(), false, "เรียกซ้ำต้องไม่ตั้ง timer ซ้อน");
  watch.stop();
  assert.equal(watch.running, false);
  db.close();
});

test("รอบซ้อนถูกข้าม และ lock ถูกปล่อยเสมอ", () => {
  const db = seeded();
  let inner = null;
  const brokenDb = {
    getBrainPointer() { inner = watch.runOnce(); throw new Error("db ล่ม"); },
    getSetting: db.getSetting.bind(db),
    setSetting: db.setSetting.bind(db),
  };
  const watch = createBrainParityWatch({
    db: brokenDb, config: testConfig({ BRAIN_SHADOW_PARITY: "true" }), logger: silent, now: () => CLOCK,
  });
  // getBrainPointer โยน error -> parity.mjs กลืนเป็น brain_tables_unavailable (ok:true)
  const outer = watch.runOnce();
  assert.deepEqual(inner, { skipped: "run_in_flight" });
  assert.equal(outer.reason, "brain_tables_unavailable");
  assert.equal(watch.busy, false, "lock ต้องถูกปล่อยใน finally");
  db.close();
});

/* --------------------------------- /health --------------------------------- */

// เฟส 2 เพิ่ม brain.read เข้า /health (โหมด, รุ่นที่ใช้, จำนวนครั้งที่ตกกลับทางเดิม,
// หน้าต่างเฝ้าดูหลังสลับรุ่น) — ค่าเริ่มต้นของทุก instance วันนี้คือทางเดิมล้วน
const LEGACY_READ = Object.freeze({
  mode: "legacy", ok: true, holdReason: null,
  versionId: null, seq: null, pointer: null,
  consecutive: 0, fallbacks: 0, contractFallbacks: 0,
  lastOkAt: null, lastFailureAt: null, soakUntil: null, pointers: {},
});

test("/health: brain.parity + streakDays + lastAt + version", async (t) => {
  const db = seeded();
  const config = testConfig({ BRAIN_SHADOW_PARITY: "true" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const before = await httpRequest(app.server, { path: "/health" });
  assert.deepEqual(before.json.brain, { parity: "none", streakDays: 0, lastAt: null, version: null, read: LEGACY_READ });

  const ok = app.brainParity.runOnce();
  assert.equal(ok.ok, true);
  const after = await httpRequest(app.server, { path: "/health" });
  assert.equal(after.json.brain.parity, "ok");
  assert.equal(after.json.brain.streakDays, 1);
  assert.equal(after.json.brain.version, ok.version);
  assert.equal(typeof after.json.brain.lastAt, "number");

  db.setApprovedPrice("AI Agent for Business", 21900);
  app.brainParity.runOnce();
  const drifted = await httpRequest(app.server, { path: "/health" });
  assert.equal(drifted.json.brain.parity, "drift");
  assert.equal(drifted.json.brain.streakDays, 0);
});

test("/health: ปิดฟีเจอร์อยู่ = brain.parity 'none' เสมอ", async (t) => {
  const db = seeded();
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const res = await httpRequest(app.server, { path: "/health" });
  assert.deepEqual(res.json.brain, { parity: "none", streakDays: 0, lastAt: null, version: null, read: LEGACY_READ });
});

/* ------------------------------ สรุปรายวันเจ้าของ ------------------------------ */

test("บรรทัดสมองเงาในสรุปรายวัน: มีเมื่อเปิดฟีเจอร์ · ไม่มีเลยเมื่อปิด", () => {
  assert.equal(brainParityDigestLine(null), "");
  assert.equal(brainParityDigestLine({ parity: "none", streakDays: 0 }), "");
  assert.equal(brainParityDigestLine({ parity: "ok", streakDays: 7 }), "🧠 สมองเงา: ตรง 7 วันติด");
  assert.equal(
    brainParityDigestLine({ parity: "drift", streakDays: 0, mismatches: ["guardTables.approvedPrices"] }),
    "🧠 สมองเงา: ไม่ตรง (ส่วน: guardTables.approvedPrices)",
  );

  const base = {
    stats: { inbound: 12, inboundCustomers: 4, newCustomers: 1, needsHuman: 0, suspectSlips: 0, knowledgeDropped: 0, hotTop: [] },
    orders: { created: 0, confirmed: 0, paid: 0, revenue: 0 },
    costThb: 12, quotaLines: ["ไม่จำกัด"], hotLines: [], waiting: [],
    sinceMs: CLOCK - 3_600_000, nowMs: CLOCK,
  };
  for (const mode of ["morning", "evening"]) {
    const off = buildDigestBubbles({ ...base, mode });
    // ปิดฟีเจอร์ = ต้องได้ก้อนเดิมทุกไบต์ (ทั้ง null และ snapshot ที่บอกว่า none)
    assert.deepEqual(buildDigestBubbles({ ...base, mode, brainParity: { parity: "none", streakDays: 0 } }), off);
    assert.equal(JSON.stringify(off).includes("สมองเงา"), false, `${mode}: ปิดอยู่ห้ามมีบรรทัดนี้`);

    const on = buildDigestBubbles({ ...base, mode, brainParity: { parity: "ok", streakDays: 5, mismatches: [] } });
    assert.equal(on.length, off.length, `${mode}: จำนวนก้อนต้องไม่เปลี่ยน (เพดาน 5 ก้อน)`);
    assert.match(on[0].text, /🧠 สมองเงา: ตรง 5 วันติด/u);

    const drift = buildDigestBubbles({
      ...base, mode, brainParity: { parity: "drift", streakDays: 0, mismatches: ["rules.productRules"] },
    });
    assert.match(drift[0].text, /🧠 สมองเงา: ไม่ตรง \(ส่วน: rules\.productRules\)/u);
  }
});
