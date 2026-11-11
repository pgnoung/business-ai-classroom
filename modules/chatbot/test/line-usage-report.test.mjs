// line-usage-report — คณิตของการ์ด "LINE OA เดือนนี้" (28 ก.ย. 2026)
// ยืนยัน: โควตาไปไหนแยกตามคำถามพี่ง้วง (ทีม / บรอดแคสต์ / ลูกค้า) · ส่วนที่ต่อกันไม่ได้แสดงเป็น "ยังแยกไม่ได้" ไม่เกลี่ย ·
// ช่วงก่อนเริ่มบันทึกนับแจ้งเตือนทีมจาก audit โดยไม่นับซ้ำ · เงินคิดจากราคาที่เจ้าของกรอกเท่านั้น
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLineUsageReport, monthWindow, parsePlanInput, parseTeamPushAudit, preLedgerWindow, previousMonthKey,
  readPlan, resolveMonth,
} from "../src/lineUsageReport.mjs";

const HOUR = 3_600_000;
// 28 ก.ย. 2026 14:00 เวลาไทย
const NOW = Date.UTC(2026, 8, 28, 7, 0, 0);
const LEDGER_START = Date.UTC(2026, 8, 28, 1, 0, 0); // 08:00 ไทย วันที่ 28

const ledgerRow = (day, method, purpose, { detail = "", sends = 1, requests = 1, recipients = requests, objects = requests } = {}) => ({
  day, channel_id: "default", method, purpose, detail, counts_quota: method === "reply" ? 0 : 1,
  sends, requests, recipients, message_objects: objects, first_at: LEDGER_START, last_at: LEDGER_START,
});
const insightRow = (date, counts, status = "ready", channel = "default") => ({
  channel_id: channel, date, status, counts_json: JSON.stringify(counts), error: "", attempts: 1, last_attempt_at: 0, ready_at: 0,
});
const quota = (totalUsage, value = 15000) => [{ channelId: "default", name: "LINE", quota: { type: "limited", value, totalUsage, cachedAt: NOW } }];
const part = (report, key) => report.split.parts.find((p) => p.key === key)?.value ?? null;
const row = (report, purpose) => report.system.rows.find((r) => r.purpose === purpose);

test("เดือน: ค่าเริ่มต้น = เดือนนี้ (เวลาไทย) · ย้อนได้ 11 เดือน · อนาคต/รูปผิดถูกปฏิเสธ", () => {
  assert.deepEqual(resolveMonth(undefined, NOW), { ok: true, key: "2026-09", current: true });
  assert.deepEqual(resolveMonth("2026-08", NOW), { ok: true, key: "2026-08", current: false });
  assert.equal(resolveMonth("2025-10", NOW).ok, true);
  assert.equal(resolveMonth("2025-09", NOW).ok, false);
  assert.equal(resolveMonth("2026-10", NOW).ok, false);
  assert.equal(resolveMonth("2026-9", NOW).ok, false);
  assert.equal(resolveMonth("'; DROP TABLE", NOW).ok, false);
  assert.equal(previousMonthKey("2026-01"), "2025-12");
  // เที่ยงคืนไทยวันที่ 1 ต.ค. = เดือนใหม่แล้ว
  assert.equal(resolveMonth("", Date.UTC(2026, 8, 30, 17, 0, 0)).key, "2026-10");
});

test("หน้าต่างเดือน: วันไทยและวันของ LINE (เดือน LINE เริ่มเที่ยงคืนญี่ปุ่น = 22:00 ไทยของวันก่อน)", () => {
  const win = monthWindow("2026-09");
  assert.equal(win.days, 30);
  assert.deepEqual([win.fromDay, win.toDay, win.fromDate, win.toDate], ["2026-09-01", "2026-09-30", "20260901", "20260930"]);
  assert.equal(win.lineStartMs, Date.UTC(2026, 7, 31, 15, 0, 0));
  assert.equal(monthWindow("2024-02").days, 29);
  assert.equal(preLedgerWindow({ monthKey: "2026-09", nowMs: NOW, ledgerStartMs: Date.UTC(2026, 7, 1) }), null, "บัญชีครอบทั้งเดือนแล้ว");
  assert.deepEqual(preLedgerWindow({ monthKey: "2026-09", nowMs: NOW, ledgerStartMs: LEDGER_START }), { startMs: win.lineStartMs, endMs: LEDGER_START });
  assert.deepEqual(preLedgerWindow({ monthKey: "2026-09", nowMs: NOW, ledgerStartMs: null }), { startMs: win.lineStartMs, endMs: NOW });
});

test("audit ก่อนเริ่มบันทึก: นับเฉพาะคนที่ได้รับจริงของแจ้งเตือน + บอลลูนของสรุปรายวัน", () => {
  const out = parseTeamPushAudit([
    { action: "escalate_notify", detail: "complaint — push แจ้งทีม 2/3 คน · พยายาม 3 คน", created_at: Date.UTC(2026, 8, 3, 2) },
    { action: "escalate_notify", detail: "payment_review — push แจ้งทีม 0/2 คน · พยายาม 2 คน", created_at: Date.UTC(2026, 8, 3, 3) },
    { action: "digest_sent", detail: "slot=x bubbles=4 ช่วง=08:30-20:00", created_at: Date.UTC(2026, 8, 3, 13) },
    { action: "escalate_notify_skipped", detail: "push แจ้งทีม 9/9 คน", created_at: Date.UTC(2026, 8, 3, 4) },
  ]);
  assert.equal(out.alertEvents, 2);
  assert.equal(out.alertPushes, 2);
  assert.equal(out.digestSends, 1);
  assert.equal(out.digestPushes, 4);
  assert.deepEqual([...out.byLineDate.entries()], [["20260903", 6]]);
});

test("ราคาแพ็กเกจ: ว่าง = ล้าง · ตัวเลขมีจุลภาคได้ · ติดลบ/ข้อความ/ทศนิยมในจำนวนข้อความ/เกินเพดาน = ปฏิเสธ", () => {
  assert.deepEqual(parsePlanInput({ monthlyFeeThb: "1,280", includedMessages: "15000", extraPerMessageThb: "0.1" }),
    { ok: true, plan: { monthlyFeeThb: 1280, includedMessages: 15000, extraPerMessageThb: 0.1 } });
  assert.deepEqual(parsePlanInput({}), { ok: true, plan: { monthlyFeeThb: null, includedMessages: null, extraPerMessageThb: null } });
  for (const bad of [{ monthlyFeeThb: "-5" }, { monthlyFeeThb: "abc" }, { includedMessages: "10.5" }, { extraPerMessageThb: "5000" }, { monthlyFeeThb: "1e5" }]) {
    assert.equal(parsePlanInput(bad).ok, false, JSON.stringify(bad));
  }
  const settings = new Map([["line_plan_monthly_fee_thb", "1280"], ["line_plan_included_messages", ""], ["line_plan_extra_per_message_thb", "0.1"]]);
  assert.equal(readPlan((key) => settings.get(key) ?? null).configured, false, "ไม่มีจำนวนข้อความที่รวม = ยังคำนวณเงินไม่ได้");
  settings.set("line_plan_included_messages", "15000");
  assert.deepEqual(readPlan((key) => settings.get(key) ?? null), { monthlyFeeThb: 1280, includedMessages: 15000, extraPerMessageThb: 0.1, configured: true });
});

test("เดือนที่บัญชีครอบทั้งเดือน: โควตาไปไหน = ทีม/บรอดแคสต์/ลูกค้า + ยังแยกไม่ได้ ตรงกับยอดรวมของ LINE", () => {
  const report = buildLineUsageReport({
    nowMs: NOW, monthKey: "2026-09", ledgerStartMs: Date.UTC(2026, 7, 20), quotas: quota(1000),
    ledgerRows: [
      ledgerRow("2026-09-05", "push", "team_alert", { requests: 40, sends: 40 }),
      ledgerRow("2026-09-05", "push", "owner_digest", { requests: 10, sends: 2 }),
      ledgerRow("2026-09-05", "reply", "customer_reply", { requests: 300, sends: 300, objects: 700 }),
      ledgerRow("2026-09-06", "push", "customer_reply_fallback", { detail: "reply_rejected", requests: 90, sends: 40 }),
      ledgerRow("2026-09-06", "push", "customer_reply_fallback", { detail: "no_reply_token", requests: 10, sends: 10 }),
      ledgerRow("2026-09-07", "push", "followup", { requests: 200, sends: 200, objects: 450 }),
      ledgerRow("2026-09-07", "push", "operator", { requests: 150, sends: 100 }),
      ledgerRow("2026-09-08", "multicast", "broadcast", { requests: 1, sends: 1, recipients: 120, objects: 2 }),
    ],
    insightRows: [insightRow("20260915", { broadcast: 300, targeting: 50, chat: 12, autoResponse: 4, apiPush: 500, apiReply: 300 })],
  });
  assert.equal(part(report, "team"), 50);
  assert.equal(part(report, "customers"), 450, "fallback 100 + ทักตาม 200 + ทีมตอบ 150 · reply ไม่นับ");
  assert.equal(part(report, "broadcast"), 470, "OA Manager 350 + คอนโซล 120");
  assert.equal(part(report, "unknown"), 30);
  assert.equal(part(report, "systemUnsplit"), null, "บัญชีครอบทั้งเดือน ไม่มีช่วงก่อนเริ่มบันทึก");
  assert.equal(report.split.total, 1000);
  assert.equal(row(report, "customer_reply").free, 300);
  assert.equal(row(report, "customer_reply").counted, 0);
  assert.deepEqual(row(report, "customer_reply_fallback").details.map((d) => [d.key, d.value]), [["reply_rejected", 90], ["no_reply_token", 10]]);
  // push: ทีม 40/40 · สรุป 10/2 · ตอบหลุด 90/40 + 10/10 · ทักตาม 200/200 · ทีมตอบ 150/100 (คำขอ/ครั้งส่ง)
  assert.deepEqual(report.system.batching, { requests: 500, sends: 392, saving: 108 });
  assert.equal(report.system.sinceDay, null);
  assert.ok(!report.notes.some((note) => note.text.includes("นับตั้งแต่วันที่")));
  assert.equal(report.lineStats.oaCounted, 350);
  assert.equal(report.lineStats.free, 316);
  assert.equal(report.quota.left, 14000);
  assert.equal(report.cost, null, "ไม่ขอเงิน = ไม่มีตัวเลขเงินเลย");
});

test("บัญชีเริ่มกลางเดือน: แจ้งเตือนทีมก่อนหน้านับจาก audit · push อื่นของระบบเป็นยอดรวมจากสถิติ LINE · บอกวันเริ่มนับ", () => {
  const auditRows = [
    { action: "escalate_notify", detail: "complaint — push แจ้งทีม 2/2 คน · พยายาม 2 คน", created_at: Date.UTC(2026, 8, 10, 3) },
    { action: "escalate_notify", detail: "complaint — push แจ้งทีม 2/2 คน · พยายาม 2 คน", created_at: Date.UTC(2026, 8, 27, 3) },
    // หลังเริ่มบันทึกแล้ว — บัญชีนับเอง ห้ามนับซ้ำ
    { action: "escalate_notify", detail: "complaint — push แจ้งทีม 2/2 คน · พยายาม 2 คน", created_at: LEDGER_START + HOUR },
  ];
  const report = buildLineUsageReport({
    nowMs: NOW, monthKey: "2026-09", ledgerStartMs: LEDGER_START, quotas: quota(900), auditRows,
    ledgerRows: [ledgerRow("2026-09-28", "push", "team_alert", { requests: 2, sends: 2 }), ledgerRow("2026-09-28", "push", "followup", { requests: 5 })],
    insightRows: [
      insightRow("20260910", { apiPush: 100, broadcast: 400, apiMulticast: 30 }),
      insightRow("20260927", { apiPush: 60 }),
    ],
  });
  assert.equal(part(report, "team"), 6, "audit 2 ครั้งก่อนเริ่ม (4) + บัญชี 2 · แถวหลังเริ่มบันทึกไม่ถูกนับซ้ำ");
  assert.equal(part(report, "systemUnsplit"), 156, "API 160 ของวันก่อนเริ่มบันทึก − แจ้งเตือนทีมวันเดียวกัน 4");
  assert.equal(part(report, "broadcast"), 430, "OA Manager 400 + multicast ของคอนโซลก่อนเริ่มบันทึก 30");
  assert.equal(part(report, "customers"), 5);
  assert.equal(part(report, "unknown"), 900 - 6 - 156 - 430 - 5);
  assert.equal(report.system.sinceDay, "2026-09-28");
  assert.deepEqual(report.system.preLedger, { alertEvents: 2, alertPushes: 4, digestPushes: 0, apiCounted: 190, apiMulticast: 30 });
  assert.ok(report.notes.some((note) => note.text.includes("นับตั้งแต่วันที่ จ. 28 ก.ย.")));
  // รายวัน: ใหม่สุดก่อน · ก่อนเริ่มบันทึกยังเห็นแจ้งเตือนทีม แต่ช่องอื่นว่าง
  assert.equal(report.days[0].day, "2026-09-28");
  assert.equal(report.days[0].tracked, true);
  const day10 = report.days.find((d) => d.day === "2026-09-10");
  assert.deepEqual([day10.tracked, day10.team, day10.customers, day10.lineOaCounted, day10.lineApiCounted], [false, 2, null, 400, 130]);
  assert.equal(report.days.length, 28);
  // วันแรกของบัญชีนับเฉพาะหลังเวลาเริ่ม — แถวต้องบอกเวลาเริ่ม ไม่ใช่ดูเหมือนนับครบทั้งวัน (รีวิวโค้ด 28 ก.ย.)
  assert.equal(report.days[0].startsAt, LEDGER_START);
  assert.ok(report.days.slice(1).every((d) => d.startsAt === null));
  assert.equal(report.lineStats.readyDays, 2);
  assert.equal(report.lineStats.expectedDays, 27);
  assert.ok(report.notes.some((note) => note.text.includes("สถิติ LINE มีถึงวันที่ อา. 27 ก.ย. (2/27 วัน)")));
});

test("นับได้มากกว่ายอดของ LINE = ไม่มี 'ยังแยกไม่ได้' ติดลบ แต่บอกเหตุผล · อ่านโควตาไม่ได้ = ไม่เดายอดรวม", () => {
  const over = buildLineUsageReport({
    nowMs: NOW, monthKey: "2026-09", ledgerStartMs: Date.UTC(2026, 7, 1), quotas: quota(100),
    ledgerRows: [ledgerRow("2026-09-10", "push", "operator", { requests: 120 })],
  });
  assert.equal(part(over, "unknown"), null);
  assert.equal(over.split.overCount, 20);
  assert.ok(over.notes.some((note) => note.text.includes("LINE ไม่นับข้อความถึงคนที่บล็อก")));

  const noQuota = buildLineUsageReport({
    nowMs: NOW, monthKey: "2026-09", ledgerStartMs: Date.UTC(2026, 7, 1), quotas: [],
    ledgerRows: [ledgerRow("2026-09-10", "push", "operator", { requests: 12 })],
  });
  assert.equal(noQuota.quota, null);
  assert.equal(noQuota.split.total, null);
  assert.equal(part(noQuota, "unknown"), null);
  assert.equal(part(noQuota, "customers"), 12);
});

test("เดือนที่ผ่านมา: ไม่มีโควตาย้อนหลัง — ยอดรวมใช้สถิติ LINE เมื่อครบทุกวันเท่านั้น", () => {
  const full = Array.from({ length: 31 }, (_, i) => insightRow(`202608${String(i + 1).padStart(2, "0")}`, { apiPush: 10, broadcast: i === 0 ? 50 : 0 }));
  const report = buildLineUsageReport({ nowMs: NOW, monthKey: "2026-08", ledgerStartMs: LEDGER_START, insightRows: full });
  assert.equal(report.current, false);
  assert.equal(report.split.total, 360);
  assert.equal(part(report, "systemUnsplit"), 310);
  assert.equal(part(report, "unknown"), null, "ครบพอดี ไม่มีส่วนที่แยกไม่ได้");
  assert.ok(report.notes.some((note) => note.text.includes("โควตาย้อนหลังดูได้ใน LINE OA Manager")));
  const partial = buildLineUsageReport({ nowMs: NOW, monthKey: "2026-08", ledgerStartMs: LEDGER_START, insightRows: full.slice(0, 20) });
  assert.equal(partial.split.total, null);
});

test("หลาย OA: วันที่ OA หนึ่งยังไม่พร้อม = ยังไม่นับวันนั้น (ห้ามรวมครึ่งวัน)", () => {
  const report = buildLineUsageReport({
    nowMs: NOW, monthKey: "2026-09", ledgerStartMs: Date.UTC(2026, 7, 1),
    insightRows: [
      insightRow("20260920", { broadcast: 100 }, "ready", "default"),
      insightRow("20260920", {}, "unready", "branch2"),
      insightRow("20260921", { broadcast: 10 }, "ready", "default"),
      insightRow("20260921", { broadcast: 5 }, "ready", "branch2"),
    ],
  });
  assert.equal(report.lineStats.oaCounted, 15);
  assert.equal(report.lineStats.readyDays, 1);
});

test("เงิน: แพ็กเกจ + ส่วนเกิน × ราคา · ไม่รู้ราคาส่วนเกิน = ไม่เดา · ประหยัดจากย้ายแจ้งเตือนเฉพาะส่วนที่เกินแพ็กเกจ", () => {
  const plan = { monthlyFeeThb: 1280, includedMessages: 15000, extraPerMessageThb: 0.1, configured: true };
  const base = { nowMs: NOW, monthKey: "2026-09", ledgerStartMs: Date.UTC(2026, 7, 1), includeCost: true,
    ledgerRows: [ledgerRow("2026-09-10", "push", "team_alert", { requests: 560 })] };
  const over = buildLineUsageReport({ ...base, quotas: quota(16000, 20000), plan });
  assert.deepEqual(over.cost.now, { used: 16000, extraMessages: 1000, extraThb: 100, totalThb: 1380 });
  // ใช้ไป 27.x วันของ LINE → คาดทั้งเดือน ≈ 16000 / 27.375 × 30
  assert.equal(over.cost.projected.used, over.split.projectedUsed);
  assert.ok(over.cost.projected.totalThb > 1380);
  assert.equal(over.split.teamProjected, Math.round((560 / ((NOW - monthWindow("2026-09").lineStartMs) / 86_400_000)) * 30));
  assert.equal(over.cost.teamSavingThb, over.split.teamProjected * 0.1, "เกินแพ็กเกจมากกว่ายอดแจ้งเตือน = ประหยัดเต็มยอด");

  const within = buildLineUsageReport({ ...base, quotas: quota(4000), plan });
  assert.deepEqual(within.cost.now, { used: 4000, extraMessages: 0, extraThb: 0, totalThb: 1280 });
  assert.equal(within.cost.teamSavingThb, 0, "ยังอยู่ในโควตาแพ็กเกจ ย้ายแจ้งเตือนไม่ลดเงิน");

  const noExtraPrice = buildLineUsageReport({ ...base, quotas: quota(16000, 20000), plan: { ...plan, extraPerMessageThb: null } });
  assert.deepEqual(noExtraPrice.cost.now, { used: 16000, extraMessages: 1000, extraThb: null, totalThb: null });
  assert.equal(noExtraPrice.cost.teamSavingThb, null);

  const unset = buildLineUsageReport({ ...base, quotas: quota(16000), plan: { monthlyFeeThb: null, includedMessages: null, extraPerMessageThb: null, configured: false } });
  assert.equal(unset.cost.configured, false);
  assert.equal(unset.cost.now, null);
});

test("ไม่มีอะไรในบัญชีเลย (ขึ้นระบบแล้วยังไม่มีการส่ง) = บอกตรง ๆ ไม่ใช่ศูนย์เงียบ ๆ", () => {
  const report = buildLineUsageReport({ nowMs: NOW, monthKey: "2026-09", ledgerStartMs: null, quotas: quota(50) });
  assert.ok(report.notes[0].text.includes("ยังไม่มีการส่งที่ระบบบันทึกได้"));
  assert.equal(part(report, "unknown"), 50);
  assert.ok(report.days.every((day) => day.tracked === false));
});

test("มุมมองรายสาขา (เติม audit ไม่ได้): บอกตรง ๆ ว่ายอดก่อนเริ่มบันทึกยังรวมแจ้งเตือนทีม", () => {
  const report = buildLineUsageReport({
    nowMs: NOW, monthKey: "2026-09", ledgerStartMs: LEDGER_START, quotas: quota(500), auditBackfill: false,
    insightRows: [insightRow("20260910", { apiPush: 100 })],
  });
  const unsplit = report.split.parts.find((p) => p.key === "systemUnsplit");
  assert.equal(unsplit.value, 100, "ไม่มี audit ให้หักแจ้งเตือนทีม");
  assert.match(unsplit.hint, /รวมแจ้งเตือนทีม/u);
  const note = report.notes.find((n) => n.key === "ledger_since");
  assert.match(note.text, /มุมมองรายสาขาแยกแจ้งเตือนทีมย้อนหลังไม่ได้/u);
  assert.doesNotMatch(note.text, /จากบันทึกการแจ้งเตือน/u);
});
