// yolo-core — แกน YOLO: ส่ง 1 ครั้งผ่านเส้น proactive เดิม, ตารางเหตุที่ไม่ส่ง, การยืนยันเส้นเงิน,
// สวิตช์ AI ต้องคงเดิม (เว้นแต่สั่งเปิด), audit/แถวข้อความ, และการเลื่อนบันได FU
// provider ทั้งหมดเป็น stub — ไม่มีเครือข่าย ไม่มีโมเดลจริง
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createYolo } from "../src/yolo.mjs";
import { writeEnrolled } from "../src/classRounds.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createStagedFollowups } from "../src/stagedFollowups.mjs";
import { handoffHintResetKey } from "../src/pipeline.mjs";
import { YOLO_LANE } from "../src/dbYolo.mjs";
import { memoryDb, poisonGlobalFetch, promptText, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const NOON = Date.UTC(2026, 8, 28, 5, 0, 0); // 12:00 เวลาไทย
const MIN = 60_000;
const HOUR = 60 * MIN;
const CLEAN = "ขออนุญาตถามเพิ่มนิดนึงนะคะ ทีมที่จะเข้าร่วมมีประมาณกี่ท่านคะ";

function makeWorld(t, { now = NOON, drafts = null, hermesDown = false, onDraft = null, catalog = [], configOverrides = {}, pipeline = null } = {}) {
  const clock = { now };
  const config = testConfig({ ...configOverrides });
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  const hermesCalls = [];
  const queue = Array.isArray(drafts) ? [...drafts] : null;
  const hermes = createHermesBridge({
    config, logger: silent,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      hermesCalls.push(body);
      if (hermesDown) return { ok: false, status: 503, json: async () => ({}) };
      if (onDraft) await onDraft(body, hermesCalls.length);
      const content = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : CLEAN;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) };
    },
  });
  const pushes = [];
  const lineCh = { next: null, sendBubbles: async (args) => { pushes.push(args); return lineCh.next ?? { ok: true }; } };
  const lineRegistry = { forChannel: () => lineCh, rawUserId: (id) => String(id).replace(/^facebook:/u, "") };
  const guard = createComplianceGuard({ bannedWords: ["การันตี"], getApprovedPrices: () => db.approvedPrices() });
  const humanizer = createHumanizer();
  const yolo = createYolo({
    config, db, hermes, lineRegistry, guard, humanizer, imageCatalog: catalog,
    logger: silent, now: () => clock.now, pipeline,
  });
  let n = 0;
  const message = (customerId, direction, content, atMs, extra = {}) => {
    const id = `m-${n += 1}`;
    db.insertMessage({ id, customerId, direction, content, ...extra });
    db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(atMs, id);
    return id;
  };
  const room = (id, { display = "คุณทดสอบ", channel = "default", inboundAt = clock.now - 50 * MIN, score = null } = {}) => {
    db.upsertCustomer(id, { displayName: display, channelId: channel });
    if (inboundAt) message(id, "in", "สนใจ in-house สำหรับทีมค่ะ", inboundAt);
    if (inboundAt) message(id, "out", "ยินดีค่ะ ขอทราบรายละเอียดเพิ่มเติมนะคะ", inboundAt + 1000);
    if (Number.isInteger(score)) db.recordScore(id, score, "{}");
    return id;
  };
  const staged = () => createStagedFollowups({
    config: { ...config, stagedFollowupEnabled: true }, db, hermes, lineRegistry, guard, humanizer,
    logger: silent, now: () => clock.now, imageCatalog: [],
  });
  return { db, yolo, clock, pushes, lineCh, hermesCalls, room, message, config, staged };
}

const systemText = (body) => promptText(body.messages[0].content);
const yoloAudits = (db) => db.listAudit(50).filter((row) => row.action.startsWith("yolo_"));

test("ห้อง in-house ที่ AI ปิด: ส่ง 1 ครั้ง, สวิตช์/ธงคงเดิม, บันทึกแบบ proactive + audit", async (t) => {
  const w = makeWorld(t);
  const id = w.room("U-inhouse");
  w.db.addHandoffNote({ customerId: id, author: "ชมพู่", text: "ลูกค้าอยากได้ in-house 20 คน รอเสนอราคา" });
  w.db.setAiEnabled(id, false, "handoff_private_inhouse");
  w.db.setNeedsHuman(id, "handoff_private_inhouse", "ส่งต่อทีม");
  w.db.setOperatorActiveUntil(id, NOON + 5 * MIN);

  const result = await w.yolo.run({ customerId: id, instruction: "ถามต่อเรื่องจำนวนพนักงาน", actor: "ngoung", source: "console" });

  assert.equal(result.status, "sent", result.reasonText);
  assert.equal(result.sentText, CLEAN.replace(" ", "\n") + "?", "ข้อความที่รายงานต้องตรงกับที่ provider รับ");
  assert.equal(w.pushes.length, 1);
  assert.equal(w.pushes[0].batch, true);
  assert.equal(w.pushes[0].to, id);
  assert.equal(w.pushes[0].replyToken, "");
  const after = w.db.getCustomer(id);
  assert.equal(after.ai_enabled, 0, "YOLO ห้ามแตะสวิตช์ AI เอง");
  assert.equal(after.ai_off_reason, "handoff_private_inhouse");
  assert.equal(after.state, "NEEDS_HUMAN");
  assert.equal(after.operator_active_until, NOON + 5 * MIN);
  assert.equal(result.aiChanged, false);
  assert.ok(result.warnings.some((warning) => warning.code === "operator_active"));

  const rows = w.db.raw.prepare("SELECT * FROM messages WHERE customer_id = ? AND direction = 'out' AND message_class = 'proactive'").all(id);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.agent_mode, "ai");
    assert.equal(row.operator, "", "ข้อความที่ลูกแพรร่างห้ามถูกป้ายว่าเป็นแอดมินพิมพ์เอง");
    const metadata = JSON.parse(row.metadata_json);
    assert.equal(metadata.yolo, true);
    assert.equal(metadata.yoloSource, "console");
    assert.equal(metadata.yoloRequestId, result.requestId);
  }
  const [audit] = yoloAudits(w.db);
  assert.equal(audit.action, "yolo_sent");
  assert.equal(audit.operator, "ngoung");
  assert.equal(audit.target, id);
  assert.match(audit.detail, /console · hash=[0-9a-f]{12} · "ถามต่อเรื่องจำนวนพนักงาน" · ส่ง 2\/2/u);
  assert.match(audit.detail, /AI off/u);

  const prompt = systemText(w.hermesCalls[0]);
  assert.match(prompt, /คำสั่งภายในจากพี่ง้วงสำหรับข้อความนี้ \(ความลับภายใน/u);
  assert.match(prompt, /ถามต่อเรื่องจำนวนพนักงาน/u);
  assert.match(prompt, /\[ชมพู่\] ลูกค้าอยากได้ in-house 20 คน/u, "โน้ตส่งต่อของทีมต้องเข้าพรอมต์");
  assert.match(prompt, /ห้องนี้ทีมงานรับช่วงดูแลอยู่/u);
  assert.equal(w.hermesCalls[0].model, w.config.hermesModel, "followup_model ว่าง = ตามตัวหลัก เหมือน FU");
  const usage = w.db.raw.prepare("SELECT kind FROM llm_usage").all().map((row) => row.kind);
  assert.deepEqual(usage, ["followup"], "llm_usage.kind เป็นชุดปิด — YOLO ใช้บทบาท followup");
  const fence = w.db.getProactiveAttempt(id, YOLO_LANE, result.requestId);
  assert.equal(fence.status, "settled", "รั้วต้องปิดหลังส่ง — ห้ามถูกส่งซ้ำอัตโนมัติ");
});

test("แล้วคุยต่อ: เปิด AI ด้วยเส้นเดียวกับปุ่มคอนโซล (ล้างธง + รีเซ็ตใบ้ + audit ai_toggle)", async (t) => {
  const w = makeWorld(t);
  const id = w.room("U-continue");
  w.db.setAiEnabled(id, false, "booking_handoff");
  w.db.setNeedsHuman(id, "booking_handoff", "จอง");
  const result = await w.yolo.run({ customerId: id, instruction: "", actor: "telegram:ngoung", source: "telegram", alsoEnableAi: true });
  assert.equal(result.status, "sent");
  assert.equal(result.aiChanged, true);
  const after = w.db.getCustomer(id);
  assert.equal(after.ai_enabled, 1);
  assert.equal(after.ai_off_reason, "");
  assert.equal(after.state, "AI_ACTIVE");
  assert.equal(w.db.getSetting(handoffHintResetKey(id)), String(NOON));
  const toggle = w.db.listAudit(20).find((row) => row.action === "ai_toggle");
  assert.equal(toggle.operator, "telegram:ngoung");
  assert.equal(toggle.detail, "on · yolo·telegram");
  assert.match(systemText(w.hermesCalls[0]), /ไม่มีคำสั่งเฉพาะ — อ่านบริบทแล้วเลือกเองว่าควรพิมพ์อะไรต่อ/u);
});

test("ตารางเหตุที่ไม่ส่งเด็ดขาด — ไม่เรียกโมเดล ไม่ยิง provider ไม่เลื่อนบันได", async (t) => {
  const cases = [
    ["unknown_customer", (w) => "U-nobody"],
    ["unknown_customer", (w) => { w.db.upsertCustomer("canary:probe", {}); return "canary:probe"; }],
    ["legacy_room", (w) => { const id = w.room("U-legacy"); w.db.addTag(id, "ย้ายจาก LINE OA", "human"); return id; }],
    ["do_not_disturb", (w) => { const id = w.room("U-dnd"); w.db.setDoNotDisturb(id, true); return id; }],
    ["opted_out", (w) => { const id = w.room("U-consent"); w.db.raw.prepare("UPDATE customers SET marketing_consent = -1 WHERE line_user_id = ?").run(id); return id; }],
    ["opted_out", (w) => { const id = w.room("U-optout"); w.db.setAiEnabled(id, false, "optout"); return id; }],
    ["urgent_mental", (w) => { const id = w.room("U-crisis"); w.db.setAiEnabled(id, false, "urgent_mental"); return id; }],
    ["urgent_mental", (w) => { const id = w.room("U-crisis2"); w.db.setNeedsHuman(id, "urgent_mental", "สายด่วน"); return id; }],
    ["no_conversation", (w) => w.room("U-new", { inboundAt: null })],
    ["ai_paused", (w) => { const id = w.room("U-paused"); w.db.setSetting("ai_paused", "1"); return id; }],
    ["fb_window_closed", (w) => w.room("facebook:9001", { channel: "facebook", inboundAt: NOON - 25 * HOUR })],
    // เปิดอยู่ตามนาฬิกาปกติ (เหลือ ~5 นาที) แต่ไม่พอเวลาร่าง — margin ของ YOLO ต้องปฏิเสธก่อนจ่ายค่าโมเดล
    ["fb_window_closed", (w) => w.room("facebook:9002", { channel: "facebook", inboundAt: NOON - (23 * HOUR + 50 * MIN) })],
    ["invalid_instruction", (w) => w.room("U-long"), "ก".repeat(501)],
  ];
  for (const [reason, setup, instruction = "ทักทาย"] of cases) {
    const w = makeWorld(t);
    const id = setup(w);
    const result = await w.yolo.run({ customerId: id, instruction, actor: "ngoung" });
    assert.equal(result.status, "refused", `${reason}: ${result.status}`);
    assert.equal(result.reason, reason);
    assert.ok(result.reasonText.length > 5, "ต้องมีเหตุผลภาษาไทยให้เจ้าของอ่าน");
    assert.equal(w.hermesCalls.length, 0, `${reason}: ห้ามเสียค่าโมเดล`);
    assert.equal(w.pushes.length, 0, `${reason}: ห้ามยิง provider`);
    assert.equal(w.db.getFollowupState(id), null);
    assert.equal(yoloAudits(w.db)[0]?.action, "yolo_refused");
  }
});

test("Facebook ในหน้าต่าง: ส่งได้ พร้อมเตือนเมื่อใกล้ปิด และส่งด้วย PSID ดิบ", async (t) => {
  const w = makeWorld(t);
  const id = w.room("facebook:7001", { channel: "facebook", inboundAt: NOON - 23 * HOUR });
  const result = await w.yolo.run({ customerId: id, instruction: "ถามต่อ", actor: "ngoung" });
  assert.equal(result.status, "sent");
  assert.equal(w.pushes[0].to, "7001");
  assert.ok(result.warnings.some((warning) => warning.code === "fb_window_short"));
});

test("เพดาน: ห้องละ 1 ครั้ง/10 นาที · ทั้งร้าน 30 ครั้ง/วัน · ร่าง 60 ครั้ง/วัน", async (t) => {
  const w = makeWorld(t);
  const id = w.room("U-rate");
  assert.equal((await w.yolo.run({ customerId: id, actor: "a" })).status, "sent");
  const again = await w.yolo.run({ customerId: id, actor: "a" });
  assert.equal(again.reason, "rate_limited_room");
  w.clock.now += 11 * MIN;
  assert.equal((await w.yolo.run({ customerId: id, actor: "a" })).status, "sent", "ครบ 10 นาทีแล้วส่งได้อีก");

  const cap = makeWorld(t);
  const target = cap.room("U-cap");
  for (let i = 0; i < 30; i += 1) {
    cap.db.upsertCustomer(`U-other-${i}`, {});
    cap.db.raw.prepare("INSERT INTO proactive_attempts (customer_id, lane, attempt_key, attempts, next_attempt_at, status, updated_at) VALUES (?, 'yolo', ?, 1, 0, 'settled', ?)")
      .run(`U-other-${i}`, `k-${i}`, NOON - HOUR);
  }
  assert.equal((await cap.yolo.run({ customerId: target, actor: "a" })).reason, "rate_limited_daily");

  const budget = makeWorld(t);
  const room = budget.room("U-budget");
  for (let i = 0; i < 60; i += 1) {
    budget.db.upsertCustomer(`U-d-${i}`, {});
    budget.db.raw.prepare("INSERT INTO proactive_attempts (customer_id, lane, attempt_key, attempts, next_attempt_at, status, updated_at) VALUES (?, 'yolo', ?, 1, 0, 'drafting', ?)")
      .run(`U-d-${i}`, `d-${i}`, NOON - HOUR);
  }
  assert.equal((await budget.yolo.run({ customerId: room, actor: "a" })).reason, "draft_budget");
});

test("ด่านร่าง: ราคานอกตาราง ร่างใหม่ 1 ครั้งแล้วยังผิด = ไม่ส่ง · คำแบนแก้ได้ในร่างที่สอง = ส่ง", async (t) => {
  const bad = makeWorld(t, { drafts: ["คลาสนี้ราคา 99,999 บาทค่ะ"] });
  const id = bad.room("U-price");
  const blocked = await bad.yolo.run({ customerId: id, instruction: "บอกราคา", actor: "a" });
  assert.equal(blocked.reason, "guard_blocked");
  assert.deepEqual(blocked.violations, ["price"]);
  assert.equal(bad.hermesCalls.length, 2, "ร่างใหม่ได้ครั้งเดียว — ไม่เกินสองร่างต่อคำสั่ง");
  assert.match(systemText(bad.hermesCalls[1]), /ห้ามพิมพ์ตัวเลขราคา\/ยอดเงินที่ไม่อยู่ในความรู้ที่อนุมัติ/u);
  assert.equal(bad.pushes.length, 0);
  assert.equal(bad.db.raw.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE kind='followup'").get().n, 2, "ร่างที่ถูกทิ้งก็ต้องนับเงิน");

  const fixed = makeWorld(t, { drafts: ["เรียนแล้วการันตีผลแน่นอนค่ะ", CLEAN] });
  const room = fixed.room("U-banned");
  const sent = await fixed.yolo.run({ customerId: room, actor: "a" });
  assert.equal(sent.status, "sent");
  assert.match(systemText(fixed.hermesCalls[1]), /ห้ามใช้คำต่อไปนี้เด็ดขาด.*การันตี/u);
});

test("ด่านร่าง: เลขบัญชี/รูปชำระเงิน และคำสั่งภายในที่หลุด ห้ามถึงลูกค้า", async (t) => {
  const bank = makeWorld(t, { drafts: ["โอนเข้าเลขบัญชี: 123-4-56789-0 ได้เลยค่ะ"] });
  const a = bank.room("U-bank");
  const refusedBank = await bank.yolo.run({ customerId: a, actor: "x" });
  assert.equal(refusedBank.reason, "payment_instructions");
  assert.match(systemText(bank.hermesCalls[1]), /ห้ามใส่เลขบัญชี พร้อมเพย์ QR/u);

  const marker = makeWorld(t, { drafts: ["สะดวกโอนตามนี้ค่ะ [IMAGE:payment-kbank]"] });
  const b = marker.room("U-marker");
  assert.equal((await marker.yolo.run({ customerId: b, actor: "x" })).reason, "payment_instructions");

  const leak = makeWorld(t, { drafts: ["พี่ง้วงสั่งให้ลูกแพรถามว่าทีมมีกี่ท่านคะ", CLEAN] });
  const c = leak.room("U-leak");
  const repaired = await leak.yolo.run({ customerId: c, instruction: "ถามจำนวนคน", actor: "x" });
  assert.equal(repaired.status, "sent", "ร่างที่สองสะอาด = ส่งได้");
  assert.doesNotMatch(repaired.sentText, /พี่ง้วงสั่ง/u);

  const stubborn = makeWorld(t, { drafts: ["ได้รับคำสั่งให้มาถามค่ะ"] });
  const d = stubborn.room("U-leak2");
  assert.equal((await stubborn.yolo.run({ customerId: d, actor: "x" })).reason, "instruction_leak");
  assert.equal(stubborn.pushes.length, 0);
});

test("ด่านร่าง: กลับคำราคาให้แพงขึ้น / ร่างว่างหลังถอด marker / สมองล่ม", async (t) => {
  const up = makeWorld(t, { drafts: ["ขอแก้ไขข้อมูลนะคะ ราคาที่ถูกต้องคือ 15,900 บาทค่ะ"] });
  up.db.setApprovedPrice("คลาส A", 12900);
  up.db.setApprovedPrice("คลาส B", 15900);
  const id = up.room("U-up");
  up.message(id, "out", "คลาสนี้ราคา 12,900 บาทค่ะ", NOON - 10 * MIN);
  assert.equal((await up.yolo.run({ customerId: id, actor: "x" })).reason, "price_revision_upward");
  assert.equal(up.hermesCalls.length, 1, "ราคาแพงขึ้นต้องให้คนตัดสิน — ไม่ร่างใหม่เอง");

  const empty = makeWorld(t, { drafts: ["[IMAGE:no-such-key]"] });
  const e = empty.room("U-empty");
  assert.equal((await empty.yolo.run({ customerId: e, actor: "x" })).reason, "empty_draft");

  const down = makeWorld(t, { hermesDown: true });
  const f = down.room("U-down");
  const result = await down.yolo.run({ customerId: f, actor: "x" });
  assert.equal(result.reason, "hermes_down");
  assert.equal(down.pushes.length, 0);
});

test("ห้องเปลี่ยนระหว่างร่าง: ลูกค้าพิมพ์ใหม่ / ขอ DND / หน้าต่าง FB ปิด = ไม่ส่ง", async (t) => {
  const typed = makeWorld(t, { onDraft: () => typed.message("U-typed", "in", "เดี๋ยวก่อนค่ะ", NOON + 1000) });
  typed.room("U-typed");
  typed.clock.now = NOON + 2000;
  const superseded = await typed.yolo.run({ customerId: "U-typed", actor: "x" });
  assert.equal(superseded.reason, "superseded");
  assert.equal(typed.pushes.length, 0);

  // AI ห้องนี้เปิดอยู่และเพิ่งตอบคำถามเดียวกันไประหว่างร่าง = ไม่ส่งซ้ำความ
  const answered = makeWorld(t, { onDraft: () => answered.message("U-answered", "out", "ตอบไปแล้วค่ะ", NOON + 1000) });
  answered.room("U-answered");
  answered.clock.now = NOON + 2000;
  assert.equal((await answered.yolo.run({ customerId: "U-answered", actor: "x" })).reason, "superseded");
  assert.equal(answered.pushes.length, 0);

  const dnd = makeWorld(t, { onDraft: () => dnd.db.setDoNotDisturb("U-dnd-mid", true) });
  dnd.room("U-dnd-mid");
  assert.equal((await dnd.yolo.run({ customerId: "U-dnd-mid", actor: "x" })).reason, "do_not_disturb");
  assert.equal(dnd.pushes.length, 0);

  const fb = makeWorld(t, { onDraft: () => { fb.clock.now += 30 * MIN; } });
  fb.room("facebook:555", { channel: "facebook", inboundAt: NOON - (23 * HOUR + 30 * MIN) });
  assert.equal((await fb.yolo.run({ customerId: "facebook:555", actor: "x" })).reason, "fb_window_closed");
  assert.equal(fb.pushes.length, 0);
});

test("เส้นเงิน/ลูกค้าไม่พอใจ/ลูกค้าขอคิดก่อน: ต้องยืนยันก่อน (ยังไม่ร่าง) · ยืนยันแล้วส่ง", async (t) => {
  const setups = [
    ["money_line", (w, id) => w.db.setDealStatus(id, "awaiting_payment")],
    ["money_line", (w, id) => w.db.setNeedsHuman(id, "payment_review", "สลิป")],
    ["money_line", (w, id) => w.db.setAiEnabled(id, false, "bank_sent")],
    ["complaint", (w, id) => w.db.setAiEnabled(id, false, "complaint")],
    ["followup_suppressed", (w, id) => w.db.suppressFollowupsForCustomer(id, "customer_considering")],
  ];
  for (const [reason, setup] of setups) {
    const w = makeWorld(t);
    const id = w.room(`U-${reason}`);
    setup(w, id);
    const first = await w.yolo.run({ customerId: id, instruction: "ทักทาย", actor: "x" });
    assert.equal(first.status, "needs_confirmation", reason);
    assert.ok(first.confirm.some((item) => item.code === reason), reason);
    assert.equal(w.hermesCalls.length, 0, `${reason}: ยังไม่ยืนยัน = ยังไม่จ่ายค่าโมเดล`);
    assert.equal(yoloAudits(w.db).length, 0, "การขอยืนยันไม่ใช่การปฏิเสธ");
    const confirmed = await w.yolo.run({ customerId: id, instruction: "ทักทาย", actor: "x", confirm: true });
    assert.equal(confirmed.status, "sent", reason);
    assert.equal(w.pushes.length, 1);
  }
});

test("คำเตือน (ส่งได้): ทีมเพิ่งตอบ · ช่วงดึก · ป้ายเงียบ · ธงรอคน", async (t) => {
  const w = makeWorld(t, { now: Date.UTC(2026, 8, 28, 15, 0, 0) }); // 22:00 ไทย
  const id = w.room("U-warn");
  w.message(id, "out", "ชมพู่ตอบเองค่ะ", w.clock.now - 5 * MIN, { operator: "chompoo" });
  w.db.addTag(id, "customer", "human");
  w.db.setNeedsHuman(id, "human_requested", "ขอคน");
  w.db.createFollowup({ customerId: id, scheduledAt: w.clock.now + 12 * HOUR, createdBy: "chompoo", note: "โทรตาม" });
  const result = await w.yolo.run({ customerId: id, actor: "x" });
  assert.equal(result.status, "sent");
  const codes = result.warnings.map((warning) => warning.code).sort();
  assert.deepEqual(codes, ["appointment_soon", "human_recent", "needs_human", "quiet_hours", "tag_silenced"]);
  assert.equal(w.db.listFollowupsFor(id)[0].status, "pending", "YOLO ไม่ยกเลิกนัดที่คนตั้ง");
  assert.match(result.warnings.find((warning) => warning.code === "human_recent").text, /5 นาทีก่อน/u);
});

test("บันไดเลื่อน: YOLO ใช้ขั้น FU ที่กำลังจะถึง — FU อัตโนมัติไม่ยิงตามติด", async (t) => {
  const w = makeWorld(t, { configOverrides: { STAGED_FOLLOWUP_ENABLED: "true" } });
  const id = w.room("U-ladder", { inboundAt: NOON - 60 * MIN });
  w.db.setFollowupEnabled(id, true);
  const result = await w.yolo.run({ customerId: id, instruction: "ถามต่อ", actor: "x" });
  assert.deepEqual(result.ladder, { stage: "cold", before: 0, after: 1, ladderLength: 4 });
  const state = w.db.getFollowupState(id);
  assert.equal(state.ladder_stage, 1);
  assert.equal(state.sent_today, 1);
  assert.equal(state.stage_key, "cold");
  assert.equal(state.episode_anchor, NOON - 60 * MIN);
  const history = JSON.parse(state.history_json);
  assert.equal(history.at(-1).kind, "yolo");
  assert.equal(history.at(-1).question, result.sentText);

  // ไม้ cold แรกเดิมนัดไว้ที่ anchor + 3 ชม. — หลัง YOLO ต้องไม่ยิงในวันเดียวกัน
  w.clock.now = NOON + 2 * HOUR + 30 * MIN;
  const engine = w.staged();
  const tick = await engine.runOnce();
  const mine = tick.results.find((row) => row.customerId === id);
  assert.ok(mine?.skipped, "FU อัตโนมัติต้องข้าม");
  assert.equal(w.pushes.length, 1, "มีแค่ข้อความ YOLO ข้อความเดียว");
});

test("บันไดเลื่อน: สเตจเปลี่ยน/ลูกค้าตอบใหม่ = เริ่มนับตามกติกาเดียวกับ FU แล้วค่อย +1", async (t) => {
  const w = makeWorld(t);
  const id = w.room("U-warm", { score: 6, inboundAt: NOON - 30 * MIN });
  w.db.saveFollowupState(id, { ladder_stage: 2, stage_key: "cold", episode_anchor: NOON - 30 * MIN, today_key: "2026-09-28", sent_today: 0, history_json: "[]" });
  const warm = await w.yolo.run({ customerId: id, actor: "x" });
  assert.deepEqual(warm.ladder, { stage: "warm", before: 0, after: 1, ladderLength: 3 });

  const v = makeWorld(t);
  const room = v.room("U-new-episode", { inboundAt: NOON - 10 * MIN });
  v.db.saveFollowupState(room, { ladder_stage: 3, stage_key: "cold", episode_anchor: NOON - 5 * HOUR, today_key: "2026-09-28", sent_today: 0, history_json: "[]" });
  const fresh = await v.yolo.run({ customerId: room, actor: "x" });
  assert.equal(fresh.ladder.before, 0, "ลูกค้าตอบหลัง anchor เดิม = episode ใหม่");
  assert.equal(v.db.getFollowupState(room).episode_anchor, NOON - 10 * MIN);
});

test("รูปจากแคตตาล็อก: ส่งและบันทึก · รูปที่เพิ่งส่งใน 7 วันถูกตัด เว้นแต่คำสั่งขอรูป", async (t) => {
  const catalog = [{ key: "classroom-atmosphere-1", url: "https://img.test/c1.jpg", previewUrl: "https://img.test/c1p.jpg" }];
  const w = makeWorld(t, { catalog, drafts: ["ส่งบรรยากาศคลาสให้ดูค่ะ [IMAGE:classroom-atmosphere-1] สนใจรอบไหนคะ"] });
  const id = w.room("U-img");
  const result = await w.yolo.run({ customerId: id, actor: "x" });
  assert.equal(result.status, "sent");
  assert.deepEqual(w.pushes[0].images, [{ key: "classroom-atmosphere-1", url: "https://img.test/c1.jpg", previewUrl: "https://img.test/c1p.jpg" }]);
  assert.deepEqual(result.images, ["classroom-atmosphere-1"]);
  const imageRow = w.db.raw.prepare("SELECT content FROM messages WHERE customer_id = ? AND msg_type = 'image'").get(id);
  assert.equal(imageRow.content, "[image:classroom-atmosphere-1] https://img.test/c1.jpg");

  w.clock.now += 11 * MIN;
  await w.yolo.run({ customerId: id, actor: "x" });
  assert.deepEqual(w.pushes[1].images, [], "รูปเดิมใน 7 วัน = ตัดทิ้ง");
  w.clock.now += 11 * MIN;
  await w.yolo.run({ customerId: id, instruction: "ส่งรูปบรรยากาศอีกที", actor: "x" });
  assert.equal(w.pushes[2].images.length, 1, "พี่ง้วงขอรูปเอง = ส่งได้");
});

test("ส่งได้บางส่วน / provider ปฏิเสธ: บันทึกเฉพาะที่รับจริง และไม่ส่งซ้ำอัตโนมัติ", async (t) => {
  const w = makeWorld(t);
  const id = w.room("U-partial");
  w.lineCh.next = { ok: false, status: 429, delivered: [{ type: "text", text: "ขออนุญาตถามเพิ่มนิดนึงนะคะ" }] };
  const partial = await w.yolo.run({ customerId: id, actor: "x" });
  assert.equal(partial.status, "partial");
  assert.equal(partial.delivered, 1);
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ? AND message_class='proactive'").get(id).n, 1);
  assert.equal(yoloAudits(w.db)[0].action, "yolo_partial");

  const v = makeWorld(t);
  const room = v.room("U-blocked");
  v.lineCh.next = { ok: false, blocked: true, reason: "live_send_disabled" };
  const failed = await v.yolo.run({ customerId: room, actor: "x" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "send_failed");
  assert.equal(failed.detail, "live_send_disabled");
  assert.equal(v.db.getProactiveAttempt(room, YOLO_LANE, failed.requestId).status, "settled");
  assert.equal(v.db.getFollowupState(room), null, "ไม่ถึงลูกค้า = ไม่เลื่อนบันได");
  assert.equal(v.db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ? AND message_class='proactive'").get(room).n, 0);
});

test("ส่งครั้งก่อนค้างผลกำกวม (ระบบดับระหว่างส่ง): ห้ามหลุดช่วงกันแล้วส่งซ้ำเงียบ ๆ — ต้องยืนยันก่อน", async (t) => {
  const w = makeWorld(t);
  const id = w.room("U-crash");
  // ระบบดับหลังลงรั้ว sending แต่ก่อนปิดรั้ว — provider อาจรับข้อความไปแล้วก็ได้
  w.db.claimProactiveAttempt(id, YOLO_LANE, "crashed", NOON - 2 * MIN);
  assert.equal(w.db.fenceProactiveSend(id, YOLO_LANE, "crashed", NOON - 2 * MIN), true);
  assert.equal((await w.yolo.run({ customerId: id, actor: "a" })).reason, "rate_limited_room", "10 นาทีแรก = ช่วงกันปกติ");
  w.clock.now += 20 * MIN;
  const pre = w.yolo.preflight(id);
  assert.equal(pre.refusal, null);
  assert.equal(pre.confirm[0].code, "unresolved_send");
  const ask = await w.yolo.run({ customerId: id, actor: "a" });
  assert.equal(ask.status, "needs_confirmation");
  assert.equal(ask.reason, "unresolved_send");
  assert.match(ask.reasonText, /ไม่แน่ใจว่าถึงลูกค้าหรือยัง/u);
  assert.equal(w.hermesCalls.length, 0, "ยังไม่ยืนยัน = ยังไม่ร่าง ไม่เสียค่าโมเดล");
  assert.equal(w.pushes.length, 0);
  assert.equal((await w.yolo.run({ customerId: id, actor: "a", confirm: true })).status, "sent", "คนดูแชทแล้วยืนยัน = ส่งได้");
  w.clock.now += 11 * MIN;
  assert.deepEqual(w.yolo.preflight(id).confirm, [], "ส่งครั้งใหม่สำเร็จแล้ว ความกำกวมเก่าไม่ต้องถามซ้ำ");

  const old = makeWorld(t);
  const room = old.room("U-old-crash");
  old.db.claimProactiveAttempt(room, YOLO_LANE, "old", NOON - 25 * HOUR);
  old.db.fenceProactiveSend(room, YOLO_LANE, "old", NOON - 25 * HOUR);
  assert.deepEqual(old.yolo.preflight(room).confirm, [], "ค้างเกิน 24 ชม. = ข้อความใหม่ไม่ใช่การส่งซ้ำในสายตาลูกค้า");
});

test("กันซ้อน: ห้องเดียวกันระหว่างกำลังร่าง = in_flight · ร่างนอกคิว แต่ช่วงส่งเข้าคิวเดียวกับเส้นตอบลูกค้า", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queued = [];
  const pipeline = { runExclusive: (key, work) => { queued.push(key); return work(); } };
  const w = makeWorld(t, { onDraft: () => gate, pipeline });
  const id = w.room("U-flight");
  const first = w.yolo.run({ customerId: id, actor: "x" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await w.yolo.run({ customerId: id, actor: "x" });
  assert.equal(second.reason, "in_flight");
  assert.deepEqual(queued, [], "ระหว่างรอโมเดล ห้ามจองคิวของห้อง (ข้อความฉุกเฉินต้องแซงได้)");
  release();
  assert.equal((await first).status, "sent");
  assert.deepEqual(queued, [id], "ช่วงส่งต้องวิ่งในคิวของลูกค้าคนนั้น");
});

test("สมองแบบ retrieval ยังไม่พร้อม = ไม่ร่าง (ไม่ถอยไปใช้ความรู้ทั้งก้อนเอง)", async (t) => {
  const w = makeWorld(t, { configOverrides: { BRAIN_RETRIEVAL_ENABLED: "true" } });
  const id = w.room("U-brain");
  const result = await w.yolo.run({ customerId: id, actor: "x" });
  assert.equal(result.reason, "brain_not_ready");
  assert.equal(w.hermesCalls.length, 0);
});

test("preflight (สำหรับคอนโซล): บอกเหตุ/การยืนยัน/คำเตือนโดยไม่ร่าง ไม่เขียนอะไร", async (t) => {
  const w = makeWorld(t);
  const id = w.room("U-pre");
  w.db.setDealStatus(id, "awaiting_payment");
  const view = w.yolo.preflight(id);
  assert.equal(view.refusal, null);
  assert.equal(view.confirm[0].code, "money_line");
  assert.equal(view.customer.channel, "LINE");
  assert.equal(w.hermesCalls.length, 0);
  assert.equal(w.db.listAudit(10).length, 0);
  assert.equal(w.yolo.preflight("U-ghost").refusal.code, "unknown_customer");
});

// real-model check 2026-09-28 (สำเนา VPS, ลูกค้าสังเคราะห์): คลังความรู้ที่ YOLO ได้ยังโชว์รอบ 22 ส.ค.–26 ก.ย.
// ว่า "เปิดรับสมัคร" ทั้งที่ผ่านไปแล้ว และพรอมต์ YOLO ไม่มีทั้งวันที่วันนี้และตัวทับรอบ/ที่นั่งล่าสุด
// ที่เส้นตอบลูกค้าใส่ทุกเทิร์น (pipeline.currentSeatRules) — "ส่งรอบที่ใกล้ที่สุด" จึงขึ้นกับการเดาของโมเดล
// และรอบที่เต็มแล้วก็มองไม่เห็น ต้องได้ชุดเดียวกับเส้นตอบลูกค้า
function roundsFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "yolo-rounds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify({
    seatsPerRound: 15,
    classes: { basic: { label: "Classroom AI Agent for Business", product: "AI Agent for Business" } },
    rounds: [
      { date: "2026-09-19", class: "basic", status: "open" },
      { date: "2026-10-10", class: "basic", status: "open" },
      { date: "2026-10-17", class: "basic", status: "open" },
    ],
  }));
  return file;
}

test("ร่าง YOLO รู้วันเวลาไทยตอนนี้ + รอบ/ที่นั่งล่าสุดชุดเดียวกับเส้นตอบลูกค้า (ตัดรอบที่ผ่านแล้ว บอกรอบเต็ม)", async (t) => {
  const w = makeWorld(t, { configOverrides: { CLASS_ROUNDS_FILE: roundsFile(t) } });
  writeEnrolled(w.db, { "2026-09-19": 3, "2026-10-10": 2, "2026-10-17": 15 });
  const id = w.room("U-rounds", { score: 6 });

  const result = await w.yolo.run({ customerId: id, instruction: "ส่งรอบเรียนที่ใกล้ที่สุดให้ แล้วถามว่าสะดวกรอบไหน", actor: "ngoung" });

  assert.equal(result.status, "sent", result.reasonText);
  const prompt = systemText(w.hermesCalls[0]);
  assert.match(prompt, /ตอนนี้ \(เวลาไทย\): จันทร์ 28 ก\.ย\. 2026 เวลา 12:00 น\./u, "โมเดลต้องรู้ว่าวันนี้วันไหน");
  assert.match(prompt, /10 ต\.ค\. 2026 \(Classroom AI Agent for Business\) เหลือ 13 ที่นั่ง/u);
  assert.match(prompt, /17 ต\.ค\. 2026 \(Classroom AI Agent for Business\) เต็มแล้ว/u, "รอบเต็มต้องเห็นว่าเต็ม");
  assert.doesNotMatch(prompt, /19 ก\.ย\. 2026/u, "รอบที่ผ่านไปแล้วห้ามอยู่ในข้อมูลรอบล่าสุด");
});

test("ไม่มีไฟล์รอบเรียน: ยังบอกวันเวลาไทย แต่ไม่มีหัวข้อรอบเรียน (ธุรกิจที่ไม่มีรอบไม่เห็นเรื่องนี้)", async (t) => {
  const w = makeWorld(t, { now: Date.UTC(2026, 8, 27, 12, 40, 0) }); // อาทิตย์ 19:40 เวลาไทย
  const id = w.room("U-no-rounds");

  const result = await w.yolo.run({ customerId: id, instruction: "ทักต่อเบา ๆ", actor: "ngoung" });

  assert.equal(result.status, "sent", result.reasonText);
  const prompt = systemText(w.hermesCalls[0]);
  assert.match(prompt, /ตอนนี้ \(เวลาไทย\): อาทิตย์ 27 ก\.ย\. 2026 เวลา 19:40 น\./u);
  assert.doesNotMatch(prompt, /ข้อมูลรอบเรียนล่าสุด/u);
});

// 2026-10-03 (พี่ง้วง: "ตอบแชทแข็งเกินไป"): YOLO ใช้ด่านชื่อเดียวกับ follow-up — ห้องที่ไม่มีชื่อเรียกได้ไม่เรียก "คุณลูกค้า"
test("ห้องที่ไม่มีชื่อเรียกได้: ร่าง YOLO ที่เรียก \"คุณลูกค้า\" ถูกตัดก่อนส่ง", async (t) => {
  const w = makeWorld(t, { drafts: ["ขออนุญาตถามเพิ่มนิดนึงนะคะ คุณลูกค้าสะดวกให้ทีมโทรกลับช่วงไหนคะ"] });
  const id = w.room("U-generic-yolo", { display: "ร้านขายของชำลุงหมี" });
  const result = await w.yolo.run({ customerId: id, instruction: "ถามเวลาสะดวก", actor: "ngoung", source: "console" });
  assert.equal(result.status, "sent", result.reasonText);
  assert.ok(!result.sentText.includes("คุณลูกค้า"), result.sentText);
  assert.match(result.sentText, /สะดวกให้ทีมโทรกลับช่วงไหนคะ/u);
});
