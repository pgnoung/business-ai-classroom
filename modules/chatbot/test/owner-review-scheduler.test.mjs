// owner-review-scheduler — รอบตรวจของพี่ง้วง 09:00/12:00/15:00/19:00 (คำสั่งพี่ง้วง 12 ต.ค. 2026 ค่ำ)
// นาฬิกาปลอม + ฐานจริง + ตัวตีจบจริง + Luna ปลอม: จองรอบครั้งเดียว · ทำต่อหลังรีสตาร์ต · ตามเก็บรอบล่าสุดภายใน 2 ชม. ·
// รอตัวกวาด · เพดาน 80 ห้อง/฿40 · ห้องที่ห้ามแตะไม่เรียก Luna · แจ้งเตือนเจ้าของคนเดียว (นับอย่างเดียว) · งานดูแลข้อเสนอ
import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_CLOSE_EXPIRE_MS, OWNER_REVIEW_MODE_KEY, OWNER_REVIEW_SCAN_SCOPE_KEY, createOwnerReviewScheduler, ownerReviewMode,
  ownerReviewNextScanAt, ownerReviewPushItems, ownerReviewScanScope, ownerReviewScanSlot,
} from "../src/ownerReviewScheduler.mjs";
import { createOwnerCloseService } from "../src/ownerCloseService.mjs";
import { QUALIFY_SWEEP_MODE_KEY } from "../src/notQualified.mjs";
import { rememberOfftopicOwnerKept } from "../src/offtopicClose.mjs";
import { LUNA_PRICING, bkk, fakeLineRegistry, makeWorld, silentLogger } from "./ownerReviewFixture.mjs";

const CUE_ROOM = "U-cue-room";
const QUIET_ROOM = "U-quiet-room";

function scheduler(world, { webPush = null, sweepBusy = () => false, roomCap, isDraining = () => false, dailyThbCap } = {}) {
  const closeService = createOwnerCloseService({ db: world.db, closer: world.closer, lineRegistry: fakeLineRegistry(), logger: silentLogger, now: () => world.clock.t });
  return createOwnerReviewScheduler({
    config: {}, db: world.db, closer: world.closer, hermes: world.hermes, webPush, closeService, logger: silentLogger,
    now: () => world.clock.t, isDraining, sweepBusy, modelPricing: LUNA_PRICING, intervalMs: 0,
    ...(roomCap ? { roomCap } : {}), ...(dailyThbCap !== undefined ? { dailyThbCap } : {}),
  });
}

function pushSpy() {
  const calls = [];
  return { calls, notifyOwner: async (args) => { calls.push(args); return { ok: true, sent: 1, retired: 0 }; } };
}

function seedRooms(world) {
  world.room(CUE_ROOM, { turns: [["out", "สวัสดีค่ะ ลูกแพรดูแลคลาสเรียน AI ค่ะ", bkk(8, 0)], ["in", "พี่ครับ ขอยืมเงินหน่อยได้ไหมครับ", bkk(8, 30)]] });
  world.room(QUIET_ROOM, { turns: [["out", "สวัสดีค่ะ", bkk(8, 0)], ["in", "วันนี้อากาศดีนะ", bkk(8, 40)]] });
}

test("เวลา/สวิตช์: รอบล่าสุด 09/12/15/19 เวลาไทย · ก่อน 09:00 = 19:00 เมื่อวาน · โหมดไม่มีแถว = on · ขอบเขตไม่มีแถว = all · อ่านพัง = null/cue_only", () => {
  assert.equal(ownerReviewScanSlot(bkk(9, 5)), bkk(9));
  assert.equal(ownerReviewScanSlot(bkk(14, 59)), bkk(12));
  assert.equal(ownerReviewScanSlot(bkk(8, 59)), bkk(19, 0, 11));
  assert.equal(ownerReviewScanSlot(bkk(23, 0)), bkk(19));
  assert.equal(ownerReviewNextScanAt(bkk(12, 30)), bkk(15));
  assert.equal(ownerReviewNextScanAt(bkk(19, 30)), bkk(9, 0, 13));
  const db = { value: {}, getSetting(key) { return this.value[key] ?? null; } };
  assert.equal(ownerReviewMode(db), "on");
  assert.equal(ownerReviewScanScope(db), "all");
  db.value[OWNER_REVIEW_MODE_KEY] = "shadow";
  db.value[OWNER_REVIEW_SCAN_SCOPE_KEY] = "cue_only";
  assert.equal(ownerReviewMode(db), "shadow");
  assert.equal(ownerReviewScanScope(db), "cue_only");
  db.value[OWNER_REVIEW_MODE_KEY] = "maybe";
  db.value[OWNER_REVIEW_SCAN_SCOPE_KEY] = "everything";
  assert.equal(ownerReviewMode(db), "off");
  assert.equal(ownerReviewScanScope(db), "all");
  const broken = { getSetting() { throw new Error("SQLITE_BUSY"); } };
  assert.equal(ownerReviewMode(broken), null);
  assert.equal(ownerReviewScanScope(broken), "cue_only");
});

test("รอบ 09:00: ห้องที่เจอคำนอกเรื่อง → judge (cue_luna) · ห้องที่ไม่มีคำ → อ่านท่าที (luna_screen) · จองรอบครั้งเดียว · ปลุกเจ้าของหนึ่งครั้ง", async () => {
  const world = makeWorld({
    start: bkk(9, 5),
    judge: { close: true, category: "ask_money", reason: "ขอยืมเงินจากเรา" },
    screen: { propose: true, category: "off_topic_personal", reason: "คุยเรื่องส่วนตัวไม่เกี่ยวกับการเรียน" },
  });
  seedRooms(world);
  const push = pushSpy();
  const runner = scheduler(world, { webPush: push });
  const result = await runner.runDue();
  assert.equal(result.status, "ready");
  assert.equal(world.hermes.calls.judge.length, 1, "ห้องที่มีคำ = ดอกที่ 2 หนึ่งครั้ง");
  assert.equal(world.hermes.calls.screen.length, 1, "ห้องที่ไม่มีคำ = อ่านท่าทีหนึ่งครั้ง");
  const open = world.db.listOwnerCloseProposals({ view: "open" }).rows;
  assert.deepEqual(open.map((row) => [row.customer_id, row.source, row.category]).sort(), [
    [CUE_ROOM, "cue_luna", "ask_money"], [QUIET_ROOM, "luna_screen", "off_topic_personal"],
  ].sort());
  const cueProposal = open.find((row) => row.customer_id === CUE_ROOM);
  const latestIn = world.db.raw.prepare("SELECT id FROM messages WHERE customer_id = ? AND direction = 'in' ORDER BY created_at DESC LIMIT 1").get(CUE_ROOM).id;
  assert.equal(cueProposal.baseline_inbound_id, latestIn);
  assert.equal(cueProposal.cue, "ask_money");
  assert.deepEqual(push.calls, [{ kind: "close" }], "ปลุกเจ้าของครั้งเดียวต่อรอบ");
  const batch = world.db.latestOwnerReviewBatch("scan");
  assert.equal(batch.slot_ms, bkk(9));
  assert.ok(batch.notified_at);
  const counts = JSON.parse(batch.counts_json);
  assert.equal(counts.proposed, 2);
  assert.equal(counts.newPending, 2);
  assert.deepEqual(world.db.llmUsageSummary(0).map((row) => row.kind).sort(), ["offtopic_check", "owner_review"]);
  // นาทีถัดไปของรอบเดียวกัน = ไม่ทำซ้ำ
  world.clock.t = bkk(9, 6);
  assert.equal((await runner.runDue()).skipped, "not_due");
  assert.equal(world.hermes.calls.judge.length + world.hermes.calls.screen.length, 2);
  // audit ไม่มีเนื้อหาแชท
  for (const row of world.db.listAudit().filter((a) => a.action === "owner_close_proposed")) {
    assert.doesNotMatch(row.detail, /ขอยืมเงิน|อากาศ/u);
  }
  world.db.close();
});

test("ขอบเขต cue_only: ห้องที่ไม่มีคำนอกเรื่องไม่ถูกอ่านท่าที (ไม่จ่าย) · Luna บอกไม่ปิด = จำไว้ ไม่ถามซ้ำรอบถัดไป", async () => {
  const world = makeWorld({ start: bkk(9, 5), judge: { close: false, category: "ask_money", reason: "เล่าเรื่องเงินของคนอื่น" } });
  seedRooms(world);
  world.db.setSetting(OWNER_REVIEW_SCAN_SCOPE_KEY, "cue_only");
  const runner = scheduler(world);
  await runner.runDue();
  assert.equal(world.hermes.calls.screen.length, 0);
  assert.equal(world.hermes.calls.judge.length, 1);
  assert.equal(world.db.listOwnerCloseProposals({}).rows.length, 0);
  // ลูกค้าพิมพ์คำเดิมอีกก่อนรอบ 12:00 — Luna เพิ่งบอกไม่ปิด = ไม่ถามซ้ำ
  world.say(CUE_ROOM, "in", "ขอยืมเงินหน่อยครับ อีกรอบ", bkk(11));
  world.clock.t = bkk(12, 1);
  const second = await runner.runDue();
  assert.equal(second.status, "ready");
  assert.equal(world.hermes.calls.judge.length, 1);
  assert.equal(JSON.parse(world.db.latestOwnerReviewBatch("scan").counts_json).skipped.kept_recently, 1);
  world.db.close();
});

test("ห้องที่ห้ามแตะไม่เรียก Luna เลย: คนถือห้อง · เงิน · คะแนนร้อน · AI ปิด/เหลือง · ห้องทดสอบ · มีข้อเสนอค้าง · เจ้าของเคยสั่งไม่ปิด", async () => {
  const world = makeWorld({ start: bkk(9, 5), screen: { propose: true, category: "ask_money", reason: "x" } });
  const ids = ["U-human", "U-money", "U-hot", "U-off", "canary:t", "U-open", "U-kept"];
  for (const id of ids) world.room(id, { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 30)]] });
  world.db.raw.prepare("UPDATE customers SET human_owner = 'chom' WHERE line_user_id = 'U-human'").run();
  world.db.raw.prepare("UPDATE customers SET money_seen_at = 5 WHERE line_user_id = 'U-money'").run();
  world.db.raw.prepare("UPDATE customers SET last_score = 8 WHERE line_user_id = 'U-hot'").run();
  world.db.raw.prepare("UPDATE customers SET ai_enabled = 0, ai_off_reason = 'not_qualified' WHERE line_user_id = 'U-off'").run();
  world.db.insertOwnerCloseProposal({ customerId: "U-open", source: "luna_screen", category: "monk" });
  rememberOfftopicOwnerKept(world.db, "U-kept", "monk", { by: "nok", proposalId: "old", nowMs: bkk(8) });
  const runner = scheduler(world);
  const result = await runner.runDue();
  assert.equal(result.status, "ready");
  assert.equal(world.hermes.calls.screen.length + world.hermes.calls.judge.length, 0);
  const skipped = result.counts.skipped;
  assert.equal(skipped.human_owner, 1);
  assert.equal(skipped.money, 1);
  assert.equal(skipped.score, 1);
  assert.equal(skipped.open_proposal, 1);
  assert.equal(skipped.owner_kept, 1);
  assert.equal(world.db.listOwnerCloseProposals({}).rows.length, 1, "มีแค่ข้อเสนอเดิม");
  world.db.close();
});

test("ตัวกวาดคัดกรองกำลังเดิน = รอ (ไม่จองรอบ) · เดินจบแล้วค่อยตรวจ · ตัวกวาดเริ่มกลางรอบ = พักแล้วทำต่อจาก cursor", async () => {
  const world = makeWorld({ start: bkk(9, 1), screen: { propose: false, category: "", reason: "" } });
  for (let i = 0; i < 3; i += 1) world.room(`U-r${i}`, { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 10 + i)]] });
  let busy = true;
  const runner = scheduler(world, { sweepBusy: () => busy });
  assert.equal((await runner.runDue()).skipped, "sweep_running");
  assert.equal(world.db.latestOwnerReviewBatch("scan"), null, "ยังไม่จองรอบ");
  busy = false;
  let calls = 0;
  world.hermes.ownerReviewCheck = async () => {
    calls += 1;
    if (calls === 1) busy = true; // ตัวกวาดเริ่มเดินหลังห้องแรก
    return { text: '{"propose":false,"category":"","reason":""}', usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "gpt-5.6-luna" };
  };
  const paused = await runner.runDue();
  assert.equal(paused.status, "building");
  assert.equal(paused.paused, "sweep_running");
  assert.equal(calls, 1);
  busy = false;
  world.clock.t = bkk(9, 3);
  const resumed = await runner.runDue();
  assert.equal(resumed.status, "ready");
  assert.equal(calls, 3, "ห้องที่ทำแล้วไม่ทำซ้ำ");
  assert.equal(resumed.counts.rooms, 3);
  world.db.close();
});

test("รีสตาร์ตกลางรอบ: ตัวตรวจตัวใหม่ทำต่อจาก cursor ในฐาน (ห้องที่ทำแล้วไม่จ่ายซ้ำ) · ค้างเกิน 12 ชม. = failed ไม่ทำต่อ", async () => {
  const world = makeWorld({ start: bkk(9, 2), screen: { propose: false, category: "", reason: "" } });
  for (let i = 0; i < 4; i += 1) world.room(`U-s${i}`, { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 10 + i)]] });
  let draining = false;
  const first = scheduler(world, { isDraining: () => draining });
  world.hermes.ownerReviewCheck = async () => {
    draining = world.hermes.calls.screen.push(1) >= 2; // ห้องที่สองแล้ว deploy เริ่ม
    return { text: '{"propose":false,"category":"","reason":""}', usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "gpt-5.6-luna" };
  };
  const stopped = await first.runDue();
  assert.equal(stopped.paused, "draining");
  assert.equal(world.hermes.calls.screen.length, 2);
  const restarted = scheduler(world);
  world.clock.t = bkk(9, 4);
  const done = await restarted.runDue();
  assert.equal(done.status, "ready");
  assert.equal(world.hermes.calls.screen.length, 4, "ทำต่ออีกสองห้อง ไม่ซ้ำสองห้องแรก");
  // รอบค้าง building นานเกิน → failed แล้วจองรอบล่าสุดแทน
  const stale = world.db.claimOwnerReviewBatch({ kind: "scan", slotMs: bkk(19, 0, 11), windowStartMs: 0, windowEndMs: 1, mode: "on" });
  world.db.raw.prepare("UPDATE owner_review_batches SET created_at = ? WHERE id = ?").run(bkk(19, 0, 11), stale.id);
  world.clock.t = bkk(12, 2);
  await restarted.runDue();
  assert.equal(world.db.ownerReviewBatch(stale.id).status, "failed");
  assert.equal(world.db.latestOwnerReviewBatch("scan").slot_ms, bkk(12));
  world.db.close();
});

test("เครื่องล่มข้ามรอบ: ตามเก็บเฉพาะรอบล่าสุดที่เลยมาไม่เกิน 2 ชม. · เกินกว่านั้นข้าม (รอบถัดไปดูต่อจากรอบก่อนหน้า ไม่ขาดช่วง)", async () => {
  const world = makeWorld({ start: bkk(10, 50), screen: { propose: false, category: "", reason: "" } });
  world.room("U-late", { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 10)]] });
  const runner = scheduler(world);
  const caught = await runner.runDue();
  assert.equal(caught.status, "ready", "09:00 เลยมา 1 ชม. 50 นาที = ยังตามเก็บ");
  const batch9 = world.db.latestOwnerReviewBatch("scan");
  assert.equal(batch9.window_end_ms, bkk(10, 50));
  world.clock.t = bkk(14, 30); // 12:00 เลยมา 2.5 ชม.
  assert.equal((await runner.runDue()).skipped, "too_late");
  world.say("U-late", "in", "ข้อความใหม่หลังรอบ 9 โมง", bkk(13));
  world.clock.t = bkk(15, 1);
  await runner.runDue();
  const batch15 = world.db.latestOwnerReviewBatch("scan");
  assert.equal(batch15.slot_ms, bkk(15));
  assert.equal(batch15.window_start_ms, bkk(10, 50), "ช่วงต่อจากรอบที่ทำจริงล่าสุด");
  assert.equal(JSON.parse(batch15.counts_json).rooms, 1);
  world.db.close();
});

test("เพดาน: ไม่เกิน roomCap ห้องที่เรียก AI ต่อรอบ (ที่เหลือนับ overflow) · ฿40/วัน ของการอ่านท่าที = หยุดรอบ ไม่เรียก Luna", async () => {
  const world = makeWorld({ start: bkk(9, 2), screen: { propose: false, category: "", reason: "" } });
  for (let i = 0; i < 5; i += 1) world.room(`U-c${i}`, { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 10 + i)]] });
  const capped = await scheduler(world, { roomCap: 2 }).runDue();
  assert.equal(world.hermes.calls.screen.length, 2);
  assert.equal(capped.counts.overflow, 3);
  world.db.close();

  const broke = makeWorld({ start: bkk(9, 2), screen: { propose: true, category: "monk", reason: "x" } });
  broke.room("U-b", { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 10)]] });
  broke.db.addLlmUsage({ customerId: "", kind: "owner_review", model: "gpt-5.6-luna", tokensIn: 100_000_000, tokensOut: 0 });
  const result = await scheduler(broke).runDue();
  assert.equal(broke.hermes.calls.screen.length, 0);
  assert.match(result.counts.stopped, /^budget:daily_cap/u);
  assert.equal(result.status, "ready");
  broke.db.close();
});

test("Luna ล้มติดกัน 3 ครั้ง = พักรอบ 20 นาที (รอบยัง building) แล้วทำต่อ", async () => {
  const world = makeWorld({ start: bkk(9, 2), screen: { failed: true } });
  for (let i = 0; i < 5; i += 1) world.room(`U-f${i}`, { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 10 + i)]] });
  const runner = scheduler(world);
  const first = await runner.runDue();
  assert.equal(first.paused, "breaker");
  assert.equal(world.hermes.calls.screen.length, 3);
  world.clock.t = bkk(9, 10);
  assert.equal((await runner.runDue()).skipped, "breaker_open");
  world.hermes.ownerReviewCheck = async () => ({ text: '{"propose":false,"category":"","reason":""}', usage: { prompt_tokens: 1, completion_tokens: 1 }, model: "gpt-5.6-luna" });
  world.clock.t = bkk(9, 25);
  const resumed = await runner.runDue();
  assert.equal(resumed.status, "ready");
  assert.equal(resumed.counts.failed, 3);
  assert.equal(resumed.counts.rooms, 5);
  world.db.close();
});

test("แจ้งเตือน: shadow = สร้างข้อเสนอแต่ไม่ปลุก · ตัวกวาดไม่ on = ไม่ปลุก (ยืนยันไม่ได้) · ไม่มีข้อเสนอใหม่ = ไม่ปลุก · off = ไม่ตรวจ", async () => {
  const cases = [
    [{ [OWNER_REVIEW_MODE_KEY]: "shadow" }, "mode_shadow", 1],
    [{ [QUALIFY_SWEEP_MODE_KEY]: "off" }, "sweep_not_on", 1],
  ];
  for (const [settings, push, proposals] of cases) {
    const world = makeWorld({ start: bkk(12, 2), screen: { propose: true, category: "monk", reason: "บวชอยู่" } });
    world.room("U-n", { turns: [["in", "วันนี้อากาศดีนะ", bkk(11)]] });
    for (const [key, value] of Object.entries(settings)) world.db.setSetting(key, value);
    const spy = pushSpy();
    const result = await scheduler(world, { webPush: spy }).runDue();
    assert.equal(result.counts.push, push);
    assert.equal(spy.calls.length, 0);
    assert.equal(world.db.listOwnerCloseProposals({}).rows.length, proposals);
    world.db.close();
  }
  const none = makeWorld({ start: bkk(12, 2), screen: { propose: false, category: "", reason: "" } });
  none.room("U-n", { turns: [["in", "วันนี้อากาศดีนะ", bkk(11)]] });
  const spy = pushSpy();
  const quiet = await scheduler(none, { webPush: spy }).runDue();
  assert.equal(quiet.counts.push, "nothing_new");
  assert.equal(spy.calls.length, 0);
  none.db.setSetting(OWNER_REVIEW_MODE_KEY, "off");
  none.clock.t = bkk(15, 2);
  assert.equal((await scheduler(none, { webPush: spy }).runDue()).skipped, "switch_off");
  none.db.close();
});

test("รายการแจ้งเตือนของเจ้าของ: มีเฉพาะเมื่อรอบตรวจเพิ่งปลุก + ยังมีข้อเสนอรอ · นับอย่างเดียว ไม่มีชื่อ/ข้อความลูกค้า · เปิดห้องตรวจแล้วหาย", () => {
  const { db, room, clock } = makeWorld();
  room("U-x", { name: "คุณลับมาก", turns: [["in", "ข้อความลับของลูกค้า", bkk(8)]] });
  db.createOperator({ username: "nok", passHash: "x", role: "owner" });
  assert.deepEqual(ownerReviewPushItems({ db, operatorUsername: "nok", nowMs: clock.t }), []);
  db.insertOwnerCloseProposal({ customerId: "U-x", source: "luna_screen", category: "monk", aiReason: "บวชอยู่" });
  assert.deepEqual(ownerReviewPushItems({ db, operatorUsername: "nok", nowMs: clock.t }), [], "ยังไม่มีการปลุก = ไม่เพิ่มรายการ");
  db.queueWebPushEvent({ id: "e1", operatorUsername: "nok", customerId: "", reason: "owner_review_close", dedupeKey: "d1", expiresAt: clock.t + 60_000 });
  const items = ownerReviewPushItems({ db, operatorUsername: "nok", nowMs: clock.t });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "/console/#/owner-review");
  assert.equal(items[0].tag, "lukprae-owner-review");
  assert.match(items[0].body, /รอยืนยันปิด 1 ห้อง/u);
  assert.doesNotMatch(JSON.stringify(items), /ลับ|U-x|บวช/u);
  db.clearOwnerReviewPushEvents("nok");
  assert.deepEqual(ownerReviewPushItems({ db, operatorUsername: "nok", nowMs: clock.t }), []);
  db.close();
});

test("งานดูแล: ข้อเสนอรอเกิน 72 ชม. = หมดอายุ · ห้องที่คนรับไปแล้ว/เหลืองแล้ว = หมดอายุ · ค้างยืนยันเกิน 5 นาที = กู้คืน", async () => {
  const world = makeWorld({ start: bkk(9, 30) });
  world.room("U-old", { turns: [["in", "สวัสดี", bkk(8)]] });
  world.room("U-taken", { turns: [["in", "สวัสดี", bkk(8)]] });
  world.room("U-stuck", { turns: [["in", "สวัสดี", bkk(8)]] });
  world.room("U-fine", { turns: [["in", "สวัสดี", bkk(8)]] });
  world.clock.t = bkk(9, 30) - OWNER_CLOSE_EXPIRE_MS - 60_000;
  const old = world.db.insertOwnerCloseProposal({ customerId: "U-old", source: "luna_screen", category: "monk" });
  world.clock.t = bkk(9, 0);
  const taken = world.db.insertOwnerCloseProposal({ customerId: "U-taken", source: "luna_screen", category: "monk" });
  const stuck = world.db.insertOwnerCloseProposal({ customerId: "U-stuck", source: "luna_screen", category: "monk" });
  const fine = world.db.insertOwnerCloseProposal({ customerId: "U-fine", source: "luna_screen", category: "monk" });
  world.db.casOwnerCloseProposal(stuck.id, { from: ["pending"], patch: { status: "confirming" } });
  world.db.raw.prepare("UPDATE customers SET human_owner = 'chom' WHERE line_user_id = 'U-taken'").run();
  world.clock.t = bkk(9, 30);
  world.db.setSetting(OWNER_REVIEW_MODE_KEY, "off"); // งานดูแลทำทุกโหมด
  const result = await scheduler(world).runDue();
  assert.equal(result.skipped, "switch_off");
  assert.deepEqual(result.maintenance, { expired: 1, blocked: 1, recovered: 1, pruned: { proposals: 0, batches: 0, items: 0 } });
  assert.equal(world.db.ownerCloseProposal(old.id).status, "expired");
  assert.equal(world.db.ownerCloseProposal(taken.id).outcome, "blocked:human_owner");
  assert.equal(world.db.ownerCloseProposal(stuck.id).status, "pending", "ยังไม่ข้ามเส้น provider = คืน pending");
  assert.equal(world.db.ownerCloseProposal(fine.id).status, "pending");
  world.db.close();
});

test("stats: ตัวเลขรวมเท่านั้น — ไม่มีรหัสห้อง/ข้อความ", async () => {
  const world = makeWorld({ start: bkk(9, 5), screen: { propose: true, category: "monk", reason: "บวชอยู่" } });
  world.room("U-secret-room", { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 30)]] });
  const runner = scheduler(world);
  await runner.runDue();
  const stats = runner.stats();
  assert.equal(stats.mode, "on");
  assert.equal(stats.pending, 1);
  assert.equal(stats.lastBatch.status, "ready");
  assert.equal(stats.inFlight, false);
  assert.ok(stats.today.thb >= 0);
  assert.doesNotMatch(JSON.stringify(stats), /U-secret-room|อากาศ/u);
  world.db.close();
});

// รีวิว 12 ต.ค. ค่ำ (PDPA): cursor ของรอบเคยเก็บ "<last_in>:<รหัสห้อง>" ค้างในแถวที่เก็บ 180 วัน แม้ลูกค้าขอให้ลืมแล้ว
function batchColumnsContaining(db, needle) {
  const columns = db.raw.prepare("PRAGMA table_info(owner_review_batches)").all().map((col) => col.name);
  return db.raw.prepare("SELECT * FROM owner_review_batches").all()
    .flatMap((row) => columns.filter((name) => String(row[name] ?? "").includes(needle)).map((name) => `${row.id}.${name}`));
}

test("PDPA: รอบจบแล้วไม่เก็บรหัสห้องใน cursor · ลูกค้าขอให้ลืมกลางรอบ = cursor เหลือแค่เวลา ทำต่อได้ ไม่มีรหัสห้องในตารางรอบ", async () => {
  const world = makeWorld({ start: bkk(9, 2), screen: { propose: false, category: "", reason: "" } });
  const rooms = ["U-pdpa-raw-identity-1", "U-pdpa-raw-identity-2", "U-pdpa-raw-identity-3"];
  rooms.forEach((id, i) => world.room(id, { turns: [["in", "วันนี้อากาศดีนะ", bkk(8, 30 - i)]] }));
  // รอบแรก: ห้องแรก (ข้อความล่าสุดสุด) แล้วเครื่องเริ่ม deploy → รอบค้าง building ที่ cursor ชี้ห้องนั้น
  let draining = false;
  const first = scheduler(world, { isDraining: () => draining });
  world.hermes.ownerReviewCheck = async () => {
    world.hermes.calls.screen.push(1);
    draining = true;
    return { text: '{"propose":false,"category":"","reason":""}', usage: { prompt_tokens: 10, completion_tokens: 5 }, model: "gpt-5.6-luna" };
  };
  assert.equal((await first.runDue()).paused, "draining");
  assert.deepEqual(batchColumnsContaining(world.db, rooms[0]).length, 1, "รอบที่ยังทำอยู่ต้องรู้ตำแหน่ง (ก่อนลืม)");
  world.db.resetCustomer(rooms[0], { forget: true });
  assert.deepEqual(batchColumnsContaining(world.db, rooms[0]), [], "ลืมแล้วไม่มีรหัสห้องค้างในตารางรอบ");
  assert.match(world.db.buildingOwnerReviewBatches("scan")[0].cursor, /^\d+:$/u, "เหลือแค่เวลา");
  // ทำต่อจากตำแหน่งเวลาเดิม: สองห้องที่เหลือ ไม่ย้อนไปห้องแรก (ห้องแรกถูกลบไปแล้วด้วย)
  const resumed = scheduler(world);
  world.clock.t = bkk(9, 4);
  const done = await resumed.runDue();
  assert.equal(done.status, "ready");
  assert.equal(world.hermes.calls.screen.length, 3, "ห้องละครั้ง");
  // รอบจบ = cursor ว่างเสมอ — ไม่มีรหัสห้องใดในตารางรอบเลย
  assert.equal(world.db.latestOwnerReviewBatch("scan").cursor, "");
  for (const id of rooms) assert.deepEqual(batchColumnsContaining(world.db, id), [], id);
  world.db.resetCustomer(rooms[1], { forget: true });
  assert.deepEqual(batchColumnsContaining(world.db, rooms[1]), []);
  world.db.close();
});
