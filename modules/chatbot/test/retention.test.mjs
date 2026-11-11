// M4: retention pruning — ลบข้อมูลเก่าเกินกรอบต่อรอบ (เส้นแบ่ง strict), สวิตช์ปิด = no-op,
// lock กันงานซ้อน, /health โชว์ lastPruneAt
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { createConfig } from "../src/config.mjs";
import { createRetention, RETENTION_LAST_PRUNE_KEY } from "../src/retention.mjs";
import { createApp } from "../src/server.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const DAY_MS = 86_400_000;

test("M4 config: RETENTION_ENABLED default true + วันต่อตาราง override ได้", () => {
  const def = createConfig({});
  assert.equal(def.retentionEnabled, true, "default ต้องเปิด");
  assert.deepEqual(def.retentionDays, {
    eventsDedupe: 30, llmUsage: 180, scoreHistory: 180, adminAudit: 365, operatorOutboundAttempts: 365, scheduleAck: 30, opportunityHandoff: 180, trainingCandidate: 90, messageMediaOrphan: 1,
  });
  const off = createConfig({ RETENTION_ENABLED: "false", RETENTION_ADMIN_AUDIT_DAYS: "30" });
  assert.equal(off.retentionEnabled, false);
  assert.equal(off.retentionDays.adminAudit, 30);
});

test("M4: แต่ละตารางถูกลบที่เส้นแบ่งพอดี — เก่ากว่า cutoff หาย, ที่ cutoff/ใหม่กว่าอยู่", () => {
  let clock = Date.UTC(2026, 7, 10); // เวลาปัจจุบันคงที่ — คุมอายุแถวได้เป๊ะ
  const db = openDb({ file: ":memory:", now: () => clock });
  const t0 = clock;
  const seed = (ageMs, fn) => {
    clock = t0 - ageMs;
    fn();
    clock = t0;
  };

  // events_dedupe (30 วัน): เก่ากว่า 1ms = หาย, ที่เส้นพอดี = อยู่, ใหม่ = อยู่
  seed(30 * DAY_MS + 1, () => db.markDedupe("old-evt"));
  seed(30 * DAY_MS, () => db.markDedupe("edge-evt"));
  seed(1 * DAY_MS, () => db.markDedupe("new-evt"));
  // llm_usage + score_history (180 วัน)
  seed(180 * DAY_MS + 1, () => db.addLlmUsage({ customerId: "U1", kind: "draft", tokensIn: 1 }));
  seed(179 * DAY_MS, () => db.addLlmUsage({ customerId: "U1", kind: "draft", tokensIn: 1 }));
  seed(180 * DAY_MS + 1, () => db.recordScore("U1", 5, "{}"));
  seed(179 * DAY_MS, () => db.recordScore("U1", 6, "{}"));
  // admin_audit (365 วัน)
  seed(365 * DAY_MS + 1, () => db.addAudit({ operator: "nok", action: "login" }));
  seed(364 * DAY_MS, () => db.addAudit({ operator: "nok", action: "login" }));
  // schedule_ack (30 วัน): ตัดสินจาก "ค่า" (จุดเริ่มช่วงปิด) ไม่ใช่เวลาเขียนแถว
  db.setSetting("schedule_ack:U-old", String(t0 - 31 * DAY_MS));
  db.setSetting("schedule_ack:U-new", String(t0 - 5 * DAY_MS));
  db.setSetting("schedule_ack:U-junk", "ไม่ใช่ตัวเลข"); // parse ไม่ได้ = ขยะ ลบทิ้ง
  // opportunity handoff (180 วัน): ตัดสินจาก createdAt ใน JSON; legacy/malformed
  // ไม่มีอายุที่เชื่อได้จึงต้องถูกลบด้วย
  db.setSetting("opportunity_handoff:U-old:private", JSON.stringify({ createdAt: t0 - 180 * DAY_MS - 1 }));
  db.setSetting("opportunity_handoff:U-edge:private", JSON.stringify({ createdAt: t0 - 180 * DAY_MS }));
  db.setSetting("opportunity_handoff:U-new:private", JSON.stringify({ createdAt: t0 - 5 * DAY_MS }));
  db.setSetting("opportunity_handoff:U-legacy:private", "already_handed_off");
  db.setSetting("followup_enabled", "1"); // settings อื่นห้ามโดนแตะ

  // training candidates (90 วัน): review artifact หมดอายุได้ แต่ customer chat
  // และ session ต้องอยู่ถาวร
  db.upsertCustomer("U-training-old", {});
  db.insertMessage({ customerId: "U-training-old", direction: "in", content: "เก่ามาก" });
  seed(90 * DAY_MS + 1, () => db.rotateTrainingSession({ customerId: "U-training-old", resetEventId: "training-old", feedback: "review-only note" }));
  db.upsertCustomer("U-training-edge", {});
  db.insertMessage({ customerId: "U-training-edge", direction: "in", content: "ขอบพอดี" });
  seed(90 * DAY_MS, () => db.rotateTrainingSession({ customerId: "U-training-edge", resetEventId: "training-edge" }));

  // inbound_turn_outcomes (30 วัน): ลบเฉพาะแถวที่ "ปิดแล้ว" — แถวที่ยังค้าง (owed/sending)
  // คือหนี้คำตอบที่ยังไม่มีใครสะสาง ห้ามลบตามอายุเด็ดขาด ไม่ว่าจะเก่าแค่ไหน
  const seedTurn = (messageId, status, ageMs) => db.raw.prepare(
    `INSERT INTO inbound_turn_outcomes
      (message_id, customer_id, channel_id, channel_kind, status, reason, process_id, created_at, updated_at)
     VALUES (?, 'U-turn', 'default', 'line', ?, '', 'p-old', ?, ?)`
  ).run(messageId, status, t0 - ageMs, t0 - ageMs);
  seedTurn("in:turn-old", "answered", 30 * DAY_MS + 1);
  seedTurn("in:turn-edge", "answered", 30 * DAY_MS);
  seedTurn("in:turn-owed", "owed", 400 * DAY_MS);

  const config = testConfig();
  const retention = createRetention({ config, db, logger: silent, now: () => clock });
  const result = retention.runOnce();
  assert.equal(result.ok, true);
  assert.deepEqual(result.pruned, {
    // old-evt + both 90-day-old training reset dedupe receipts (event dedupe itself keeps 30 days)
    eventsDedupe: 3, llmUsage: 1, scoreHistory: 1, adminAudit: 1, scheduleAck: 2, opportunityHandoff: 2, trainingCandidate: 1,
    messageAttachments: 0, orphanMessageAttachments: 0, attachmentDownloadTokens: 0, queuedMediaDeletes: 0,
    operatorOutboundAttempts: 0,
    // v1.2.6: กวาดความเห็นผู้ทดสอบที่ค้างจาก DB รุ่นก่อน (ปกติเป็น 0)
    trainingFeedbackOrphans: 0,
    // audit 2026-08-25: web_push_events เก็บ line_user_id ดิบ — ต้องถูกกวาดทุกวัน
    // ไม่ว่า Web Push จะเปิดหรือปิด (เดิมอยู่หลัง availability guard จึงไม่เคยลบเลย)
    expiredWebPushEvents: 0,
    // บัญชีผลลัพธ์เทิร์นขาเข้าที่ปิดแล้วหมดอายุ 30 วัน — แถวที่ยังค้างไม่นับ
    inboundTurnOutcomes: 1,
    // 6 ต.ค. 2026: referral ของแอดที่ไม่มีห้อง (ไม่มีแถวในเทสต์นี้ = 0 · เคสจริงอยู่ ad-referral-pdpa.test.mjs)
    orphanAdReferrals: 0,
  });

  const count = (sql) => db.raw.prepare(sql).get().n;
  assert.equal(count("SELECT COUNT(*) AS n FROM inbound_turn_outcomes WHERE message_id = 'in:turn-old'"), 0);
  assert.equal(count("SELECT COUNT(*) AS n FROM inbound_turn_outcomes WHERE message_id = 'in:turn-edge'"), 1, "cutoff is strict");
  assert.equal(count("SELECT COUNT(*) AS n FROM inbound_turn_outcomes WHERE message_id = 'in:turn-owed'"), 1, "หนี้คำตอบที่ยังค้างห้ามหายไปตามอายุ");
  assert.equal(count("SELECT COUNT(*) AS n FROM events_dedupe"), 2, "เฉพาะ event edge/new ในกรอบ 30 วันต้องอยู่");
  assert.equal(db.markDedupe("old-evt"), true, "แถวเก่าถูกลบจริง — insert ใหม่ได้");
  assert.equal(count("SELECT COUNT(*) AS n FROM llm_usage"), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM score_history"), 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM admin_audit"), 1);
  assert.equal(db.getSetting("schedule_ack:U-old"), null);
  assert.equal(db.getSetting("schedule_ack:U-junk"), null);
  assert.ok(db.getSetting("schedule_ack:U-new"), "ack ในกรอบต้องอยู่");
  assert.equal(db.getSetting("opportunity_handoff:U-old:private"), null);
  assert.equal(db.getSetting("opportunity_handoff:U-legacy:private"), null);
  assert.ok(db.getSetting("opportunity_handoff:U-edge:private"), "handoff ที่ cutoff ต้องอยู่");
  assert.ok(db.getSetting("opportunity_handoff:U-new:private"), "handoff ในกรอบต้องอยู่");
  assert.equal(db.getSetting("followup_enabled"), "1", "settings อื่นห้ามโดนแตะ");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM training_candidates WHERE reset_event_id = 'training-old'").get().n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM training_feedback WHERE customer_id = 'U-training-old'").get().n, 0, "review-only feedback expires with candidate");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_sessions WHERE customer_id = 'U-training-old'").get().n, 2, "ทั้ง rotated และ active session ต้องอยู่");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_sessions WHERE customer_id = 'U-training-old' AND status = 'rotated'").get().n, 1, "archived session must remain");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = 'U-training-old'").get().n, 1, "customer transcript must never be deleted by retention");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM training_candidates WHERE reset_event_id = 'training-edge'").get().n, 1, "cutoff is strict");
  assert.equal(db.getSetting(RETENTION_LAST_PRUNE_KEY), String(clock), "ต้องบันทึกเวลา prune");
  assert.equal(retention.lastPruneAt(), clock);
  db.close();
});

test("M4: วัน override ต่อตารางจาก env มีผลจริง", () => {
  let clock = Date.UTC(2026, 7, 10);
  const db = openDb({ file: ":memory:", now: () => clock });
  const t0 = clock;
  clock = t0 - 10 * DAY_MS;
  db.addAudit({ operator: "nok", action: "login" });
  clock = t0;
  const config = testConfig({ RETENTION_ADMIN_AUDIT_DAYS: "7" });
  const retention = createRetention({ config, db, logger: silent, now: () => clock });
  assert.equal(retention.runOnce().pruned.adminAudit, 1, "กรอบ 7 วันจาก env ต้องถูกใช้");
  db.close();
});

test("M4: RETENTION_ENABLED=false -> no-op ไม่ลบอะไรเลย", () => {
  let clock = Date.UTC(2026, 7, 10);
  const db = openDb({ file: ":memory:", now: () => clock });
  clock -= 400 * DAY_MS;
  db.markDedupe("ancient");
  db.addAudit({ operator: "nok", action: "login" });
  clock += 400 * DAY_MS;
  const config = testConfig({ RETENTION_ENABLED: "false" });
  const retention = createRetention({ config, db, logger: silent, now: () => clock });
  const result = retention.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "retention_disabled");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM events_dedupe").get().n, 1, "ห้ามลบตอนปิด");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM admin_audit").get().n, 1);
  assert.equal(db.getSetting(RETENTION_LAST_PRUNE_KEY), null, "ปิดอยู่ห้ามอัปเดตเวลา prune");
  db.close();
});

test("M4: sync lock — เรียกซ้อนระหว่างรอบกำลังเดิน = ข้าม (run_in_flight)", () => {
  const config = testConfig();
  let reentrant = null;
  // db ปลอมที่เรียก runOnce ซ้อนจากใน pruneRetention — จำลองงานทับรอบ
  const fakeDb = {
    pruneRetention() {
      reentrant = retention.runOnce();
      return { eventsDedupe: 0, llmUsage: 0, scoreHistory: 0, adminAudit: 0, scheduleAck: 0 };
    },
    setSetting() {},
    getSetting() { return null; },
  };
  const retention = createRetention({ config, db: fakeDb, logger: silent });
  const outer = retention.runOnce();
  assert.equal(outer.ok, true);
  assert.deepEqual(reentrant, { skipped: true, reason: "run_in_flight" }, "รอบซ้อนต้องถูกข้าม");
  assert.equal(retention.busy, false, "lock ต้องถูกปล่อยหลังจบรอบ (finally)");
  // หลังปล่อย lock แล้วรอบถัดไปเดินได้ปกติ
  assert.equal(retention.runOnce().ok, true);
});

test("M4: /health โชว์ retention.enabled + lastPruneAt (null ก่อนเดิน, เวลาเมื่อเดินแล้ว)", async (t) => {
  const config = testConfig();
  const db = memoryDb();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });

  const before = await httpRequest(app.server, { path: "/health" });
  assert.equal(before.status, 200);
  assert.equal(before.json.components.retention, "armed");
  assert.deepEqual(before.json.retention, { enabled: true, lastPruneAt: null });

  const run = app.retention.runOnce();
  assert.equal(run.ok, true);
  const after = await httpRequest(app.server, { path: "/health" });
  assert.equal(after.json.retention.enabled, true);
  assert.equal(after.json.retention.lastPruneAt, run.at, "เวลา prune ล่าสุดต้องออกทาง /health");
});
