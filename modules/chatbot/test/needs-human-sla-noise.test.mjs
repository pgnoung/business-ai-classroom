// F9 (ตรวจย้อนหลัง ก.ย. 2026): บันไดทวง SLA — 24 จาก 29 push เป็นเสียงรบกวน
//
// ของจริง: แฮชแท็ก/สติกเกอร์/คำตอบเมนูในห้องที่คนดูแลอยู่แล้วเริ่มบันไดทวงใหม่ทุกครั้ง
// (ครั้งละ 3 push) และบันไดยังเดินต่อบนห้องที่คนเปิด AI คืนแล้ว
// กติกาใหม่ของ "ข้อความที่ควรทวง" (anchor):
//   1) แฮชแท็กล้วน / สติกเกอร์ / คำรับสั้น ๆ ไม่เริ่มบันไดใหม่
//   2) คนเปิด AI คืนหลังเหตุ = เหตุหมดอายุ · คนตอบแล้วหลังเหตุ = ห้องของคน ทวงเฉพาะคำถามใหม่
//   3) วันเดียวกันครบบันไดแล้ว เริ่มใหม่ได้เฉพาะเมื่อมีคำถามใหม่
// แถวที่ไม่มีข้อมูลข้อความ (ผู้เรียกเก่า) = พฤติกรรมเดิมทุกอย่าง
import test from "node:test";
import assert from "node:assert/strict";
import {
  NEEDS_HUMAN_REMINDER_KEY_PREFIX, formatReminderState, isNoiseInbound, isQuestionLikeInbound,
  runNeedsHumanSla, selectDueReminders,
} from "../src/needsHumanSla.mjs";
import { parseActiveHours } from "../src/scheduleGate.mjs";
import { createApp } from "../src/server.mjs";
import { memoryDb, testConfig, hermesFetchStub, lineFetchStub, httpRequest, listen } from "./helpers.mjs";

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
// 2026-09-23 12:00 เวลาไทย (05:00Z) — เวลาทำการ
const T = Date.UTC(2026, 8, 23, 5, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const slaConfig = { needsHumanSlaEnabled: true, needsHumanSlaMinutes: 30, needsHumanSlaMaxReminders: 3, needsHumanSlaHours: "00:00-23:59" };

test("F9: สัญญาณรบกวนกับคำถาม — แยกด้วยรูปข้อความ ไม่ใช่ความยาว", () => {
  for (const [type, text] of [["text", "#bootcamp"], ["text", "@online"], ["sticker", ""], ["text", "ค่ะ"], ["text", "โอเคครับ"], ["text", "ขอบคุณมากค่ะ 🙏"], ["text", "ok"], ["text", "👍"]]) {
    assert.equal(isNoiseInbound({ type, text }), true, `${type}:${text}`);
  }
  for (const [type, text] of [["text", "ขอลิงก์เข้าเรียนด้วยค่ะ"], ["text", "#inhouse 20 คนครับ"], ["image", ""], ["file", ""], ["text", "ข้าวผัดกะเพราค่ะ"]]) {
    assert.equal(isNoiseInbound({ type, text }), false, `${type}:${text}`);
  }
  assert.equal(isQuestionLikeInbound("ขอลิงก์เข้าเรียนด้วยค่ะ"), true);
  assert.equal(isQuestionLikeInbound("เริ่มกี่โมงคะ"), true);
  assert.equal(isQuestionLikeInbound("ข้าวผัดกะเพราค่ะ"), false);
});

function room({ id = "U-room", summaryAt = T - 5 * HOUR, reason = "human_requested", aiOn = false, inbound = [], lastOperatorAt = null, reopenedAt = null } = {}) {
  const sorted = [...inbound].sort((a, b) => b.at - a.at);
  return {
    line_user_id: id, display_name: "ห้องทดสอบ", known_name: "", state: "NEEDS_HUMAN",
    handoff_summary: `[${iso(summaryAt)}] ${reason}: เคสทดสอบ`,
    ai_enabled: aiOn ? 1 : 0, ai_off_reason: aiOn ? "" : reason,
    money_seen_at: 0, human_owner: "", channel_id: "default", last_slip_status: null,
    last_inbound_at: sorted[0]?.at ?? null,
    last_operator_outbound_at: lastOperatorAt,
    unkept_promise: 0,
    recent_inbound_json: JSON.stringify(sorted.map((m) => ({ at: m.at, type: m.type || "text", text: m.text || "" }))),
    ai_reopened_at: reopenedAt,
  };
}
const select = (rows, reminderState) => selectDueReminders(rows, {
  now: T, waitMs: 30 * MIN, maxReminders: 3, window: parseActiveHours("00:00-23:59"), reminderState,
});

test("F9 ข้อ 1: แฮชแท็กหลังครบบันไดแล้ว ห้ามเริ่มบันไดใหม่", () => {
  const row = room({ inbound: [{ at: T - 5 * HOUR, text: "ขอคุยกับทีมงานหน่อยค่ะ" }, { at: T - HOUR, text: "#bootcamp" }] });
  const done = () => ({ count: 3, lastAt: T - 3 * HOUR });
  assert.deepEqual(select([row], done), []);
  // ข้อความที่มีเนื้อหาจริงยังเริ่มบันไดใหม่เหมือนเดิม
  const asked = room({ inbound: [{ at: T - 5 * HOUR, text: "ขอคุยกับทีมงานหน่อยค่ะ" }, { at: T - HOUR, text: "ตกลงเริ่มเรียนวันไหนคะ" }] });
  assert.equal(select([asked], done).length, 1);
});

test("F9 ข้อ 1: สติกเกอร์/คำรับสั้น ๆ ไม่ดันเวลารอ และไม่เริ่มบันไดใหม่", () => {
  const row = room({ inbound: [{ at: T - 5 * HOUR, text: "ขอคุยกับทีมงานหน่อยค่ะ" }, { at: T - 10 * MIN, type: "sticker" }, { at: T - 5 * MIN, text: "ค่ะ" }] });
  const due = select([row], () => ({ count: 0, lastAt: 0 }));
  assert.equal(due.length, 1, "ข้อความจริงเมื่อ 5 ชม. ก่อนยังรอคนอยู่");
  assert.equal(due[0].waitedMs, 5 * HOUR, "เวลารอนับจากข้อความจริง ไม่ใช่สติกเกอร์");
});

test("F9 ข้อ 2: คนเปิด AI คืนหลังเหตุ = เหตุหมดอายุ ไม่ทวงอีก", () => {
  const row = room({ aiOn: true, reopenedAt: T - 4 * HOUR, inbound: [{ at: T - 2 * HOUR, text: "เริ่มเรียนกี่โมงคะ" }] });
  assert.deepEqual(select([row], () => ({ count: 0, lastAt: 0 })), []);
});

test("F9 ข้อ 2: คนตอบแล้วหลังเหตุ = ห้องของคน — คำตอบเมนู/แฮชแท็กไม่ทวง คำถามใหม่ยังทวง", () => {
  const base = { lastOperatorAt: T - 4 * HOUR };
  const menu = room({ ...base, inbound: [{ at: T - 5 * HOUR, text: "ขอคุยกับทีมงานหน่อยค่ะ" }, { at: T - 2 * HOUR, text: "ข้าวผัดกะเพราค่ะ" }] });
  assert.deepEqual(select([menu], () => ({ count: 0, lastAt: 0 })), []);
  const question = room({ ...base, inbound: [{ at: T - 5 * HOUR, text: "ขอคุยกับทีมงานหน่อยค่ะ" }, { at: T - 2 * HOUR, text: "ขอลิงก์เข้าเรียนด้วยค่ะ" }] });
  assert.equal(select([question], () => ({ count: 0, lastAt: 0 })).length, 1);
});

test("F9 ข้อ 2: คนตอบแล้วหลังเหตุ แต่ลูกค้าส่งรูป/ไฟล์ตามมา = ยังทวง (ไฟล์แนบคือสิ่งที่คนต้องเปิดดู)", () => {
  const base = { reason: "opportunity_handoff", lastOperatorAt: T - 3 * HOUR };
  const image = room({ ...base, inbound: [{ at: T - 5 * HOUR, text: "สนใจอบรมในองค์กรค่ะ" }, { at: T - 2 * HOUR, type: "image" }] });
  assert.equal(select([image], () => ({ count: 0, lastAt: 0 })).length, 1);
  const file = room({ ...base, inbound: [{ at: T - 5 * HOUR, text: "สนใจอบรมในองค์กรค่ะ" }, { at: T - 2 * HOUR, type: "file" }] });
  assert.equal(select([file], () => ({ count: 0, lastAt: 0 })).length, 1);
  // วันเดียวกับบันไดที่ครบแล้ว ไฟล์แนบใหม่ก็เริ่มบันไดใหม่ได้เหมือนคำถาม
  assert.equal(select([image], () => ({ count: 3, lastAt: T - 2.5 * HOUR })).length, 1);
});

test("F9 ข้อ 3: วันเดียวกันครบบันไดแล้ว ข้อความที่ไม่ใช่คำถามไม่เริ่มบันไดใหม่ · คำถามใหม่เริ่มได้", () => {
  const done = () => ({ count: 3, lastAt: T - HOUR });
  const answer = room({ inbound: [{ at: T - 5 * HOUR, text: "ขอคุยกับทีมงานหน่อยค่ะ" }, { at: T - 40 * MIN, text: "ได้ทราบแล้วค่ะ รอทีมงานนะคะ" }] });
  assert.deepEqual(select([answer], done), []);
  const question = room({ inbound: [{ at: T - 5 * HOUR, text: "ขอคุยกับทีมงานหน่อยค่ะ" }, { at: T - 40 * MIN, text: "ยังไม่มีใครติดต่อมาเลย ทำยังไงดีคะ" }] });
  assert.equal(select([question], done).length, 1);
});

test("F9 DB: ห้องที่คนดูแลแล้ว ลูกค้าพิมพ์ #bootcamp = ไม่ทวง · พิมพ์ขอลิงก์ = ทวง", (t) => {
  let clock = T;
  const db = memoryDb({ now: () => clock });
  t.after(() => db.close());
  const id = "U-sla-bootcamp";
  db.upsertCustomer(id, { displayName: "ลูกค้าบูทแคมป์" });
  const inbound = (text, at) => {
    const msgId = db.insertMessage({ customerId: id, direction: "in", content: text });
    db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, msgId);
  };
  inbound("ขอคุยกับทีมงานหน่อยค่ะ", T - 5 * HOUR);
  db.raw.prepare(`UPDATE customers SET state = 'NEEDS_HUMAN', ai_enabled = 0, ai_off_reason = 'human_requested',
    handoff_summary = ? WHERE line_user_id = ?`).run(`[${iso(T - 5 * HOUR)}] human_requested: ขอคน`, id);
  const reply = db.insertMessage({ customerId: id, direction: "out", content: "สวัสดีค่ะ ชมพู่ดูแลต่อนะคะ", operator: "chom" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(T - 4 * HOUR, reply);
  inbound("#bootcamp", T - 2 * HOUR);

  const calls = [];
  const notifier = { fireLater: (n) => calls.push(n) };
  const quiet = runNeedsHumanSla({ db, notifier, config: slaConfig, logger: silent, now: () => T });
  assert.equal(quiet.notified, 0, "แฮชแท็กในห้องที่คนดูแลแล้วไม่ใช่เหตุให้ปลุกทีม");

  inbound("ขอลิงก์เข้าเรียนด้วยค่ะ", T - HOUR);
  const asked = runNeedsHumanSla({ db, notifier, config: slaConfig, logger: silent, now: () => T });
  assert.equal(asked.notified, 1, "คำถามใหม่ที่ยังไม่มีใครตอบต้องถูกทวง");
  assert.equal(calls[0].reason, "needs_human_sla");
});

test("F9 DB: เปิด AI คืนจากคีย์แดชบอร์ด (ธงยังค้าง) = ไม่ทวงต่อ", (t) => {
  const db = memoryDb({ now: () => T });
  t.after(() => db.close());
  const id = "U-sla-reopened";
  db.upsertCustomer(id, { displayName: "ห้องเปิดคืน" });
  const msgId = db.insertMessage({ customerId: id, direction: "in", content: "ขอคุยกับทีมงานหน่อยค่ะ" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(T - 3 * HOUR, msgId);
  db.raw.prepare(`UPDATE customers SET state = 'NEEDS_HUMAN', ai_enabled = 1, ai_off_reason = '',
    handoff_summary = ? WHERE line_user_id = ?`).run(`[${iso(T - 3 * HOUR)}] human_requested: ขอคน`, id);
  db.setSetting(`handoff_hint_reset:${id}`, String(T - 2 * HOUR));
  db.setSetting(`${NEEDS_HUMAN_REMINDER_KEY_PREFIX}${id}`, formatReminderState({ count: 1, lastAt: T - 2.5 * HOUR }));
  const calls = [];
  const result = runNeedsHumanSla({ db, notifier: { fireLater: (n) => calls.push(n) }, config: slaConfig, logger: silent, now: () => T });
  assert.equal(result.notified, 0);
});

test("F9 DB: กดเปิด AI คืนผ่านคีย์แดชบอร์ดจริง = หมุดเปิดคืนถูกปัก บันไดทวงหยุด", async (t) => {
  const db = memoryDb();
  const app = createApp({
    db, logger: silent, config: testConfig(),
    overrides: { hermesFetch: hermesFetchStub("ได้เลยค่ะ"), lineFetch: lineFetchStub(), sleep: async () => {} },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const id = "U-sla-dashboard-reopen";
  const now = Date.now();
  db.upsertCustomer(id, { displayName: "ห้องเปิดคืนจากแดชบอร์ด" });
  const msgId = db.insertMessage({ customerId: id, direction: "in", content: "ขอคุยกับทีมงานหน่อยค่ะ" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(now - 3 * HOUR, msgId);
  db.raw.prepare(`UPDATE customers SET state = 'NEEDS_HUMAN', ai_enabled = 0, ai_off_reason = 'human_requested',
    handoff_summary = ? WHERE line_user_id = ?`).run(`[${iso(now - 3 * HOUR)}] human_requested: ขอคน`, id);
  const res = await httpRequest(app.server, {
    method: "POST", path: `/api/customers/${id}/ai`,
    headers: { "x-dashboard-key": "test-dashboard-key", "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(res.status, 200);
  assert.ok(Number(db.getSetting(`handoff_hint_reset:${id}`) || 0) >= now, "เปิดคืนจากแดชบอร์ดต้องปักหมุดเหมือนคอนโซล");
  const calls = [];
  const result = runNeedsHumanSla({ db, notifier: { fireLater: (n) => calls.push(n) }, config: slaConfig, logger: silent, now: () => now });
  assert.equal(result.notified, 0, "ห้องที่คนเปิด AI คืนแล้วต้องไม่ถูกทวงต่อ");
});
