// not-qualified-team-label-lists — ป้ายห้องเหลือง "รอทีม" ต้องตรงกันทุกรายการของคอนโซล
//
// รีวิวปรปักษ์รอบ 3 5 ต.ค. (f9-stuck-label): ห้องเหลืองที่มีแต่ทีมปลดได้ (ทีมตอบหลังเหลือง / มีคนถือห้อง / เริ่มจ่ายเงิน /
// NEEDS_HUMAN) ได้ข้อความ "รอทีม" แล้วที่คิวรอตอบกับหัวห้อง — แต่รายการแชทซ้าย (consoleApi inbox) และการ์ด
// "ลูกค้าร้อนรอทีมทักต่อ" + การ์ดรอตอบของหน้าภาพรวม (consoleAttentionApi) ยังบอกว่า "ตัวกวาดเปิดคืนเอง" ห้องเดียวกันจึงขึ้นสองคำตอบ
// ทั้งที่ consoleApi เขียนกติกาไว้ว่ารายการซ้ายกับหัวห้องต้องไม่ตัดสินคนละแบบ — เทสต์นี้ยิง HTTP จริงทั้งสองรายการ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { roomTriage } from "../src/consoleTriageApi.mjs";
import { NOT_QUALIFIED_WAITING_TEAM_TEXT } from "../src/aiOffActor.mjs";
import { summarizeHotQuiet } from "../src/consoleAttentionApi.mjs";
import { NOT_QUALIFIED_BY, NOT_QUALIFIED_REASON, NOT_QUALIFIED_REASON_TEXT, qualifyStateKey } from "../src/notQualified.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PASSWORD = "label-pass-123";
const VERDICT_REASON = "ตกงาน";
const silent = { log() {}, warn() {}, error() {} };

function seed(db, at, now) {
  const msg = (id, direction, ago, content, extra = {}) =>
    at(now - ago, () => db.insertMessage({ customerId: id, direction, content, ...extra }));
  const yellow = (id, { score = 9 } = {}) => {
    at(now - 10 * DAY, () => db.upsertCustomer(id, { displayName: `ชื่อ ${id}` }));
    at(now - 10 * DAY + MIN, () => db.recordScore(id, score, "{}"));
    msg(id, "in", 3 * DAY, "สนใจคลาสค่ะ ตอนนี้ตกงานอยู่");
    msg(id, "out", 3 * DAY - MIN, "เข้าใจค่ะ", { agentMode: "ai" });
    const offAt = now - 2 * DAY;
    at(offAt, () => db.setAiEnabled(id, false, NOT_QUALIFIED_REASON));
    db.setSetting(qualifyStateKey(id), JSON.stringify({
      verdict: "not_qualified", confidence: 0.9, reason: VERDICT_REASON, lastInboundId: "x", at: offAt, mode: "on", offAt,
    }));
  };
  // ทีมตอบหลังเป็นเหลือง แล้วลูกค้าพิมพ์ต่อ = คิวรอตอบ + รายการแชท
  yellow("Y-staff");
  msg("Y-staff", "out", DAY, "ทีมดูแลต่อนะคะ", { operator: "nok", agentMode: "operator_ai_off" });
  msg("Y-staff", "in", 2 * HOUR, "ตอนนี้มีร้านกาแฟสองสาขาแล้วค่ะ");
  // มีคนถือห้อง ลูกค้าเงียบหลังคำตอบของลูกแพร = การ์ดลูกค้าร้อน + รายการแชท
  yellow("Y-owner");
  db.raw.prepare("UPDATE customers SET human_owner = 'nok' WHERE line_user_id = 'Y-owner'").run();
  // เหลืองปกติ (ตัวกวาดเปิดคืนเองได้) และเหลืองที่มีแค่บรอดแคสต์ (ไม่ใช่ทีมรับห้อง)
  yellow("Y-plain");
  yellow("Y-broadcast");
  msg("Y-broadcast", "out", DAY, "โปรเดือนตุลา", { operator: "nok", messageClass: "proactive", agentMode: "operator_ai_on" });
}

async function start(t) {
  let fixed = null;
  const db = memoryDb({ now: () => fixed ?? Date.now() });
  const at = (ms, fn) => { fixed = ms; try { return fn(); } finally { fixed = null; } };
  const now = Date.now();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), role: "owner" });
  seed(db, at, now);
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "label-secret-0123456789" }), db,
    overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, now };
}

async function login(server) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers["set-cookie"][0].split(";")[0] };
}

const get = async (server, auth, path) => (await httpRequest(server, { path, headers: { cookie: auth.cookie } })).json;

test("รีวิวปรปักษ์รอบ 3 5 ต.ค.: รายการแชทซ้ายบอก 'รอทีม' ตรงกับหัวห้องสำหรับห้องเหลืองที่ทีมรับแล้ว", async (t) => {
  const { app, db, now } = await start(t);
  const auth = await login(app.server);
  const inbox = await get(app.server, auth, "/console/api/inbox?limit=100");
  const byId = new Map(inbox.conversations.map((row) => [row.line_user_id, row]));
  const expected = {
    "Y-staff": NOT_QUALIFIED_WAITING_TEAM_TEXT,
    "Y-owner": NOT_QUALIFIED_WAITING_TEAM_TEXT,
    "Y-plain": VERDICT_REASON,
    "Y-broadcast": VERDICT_REASON,
  };
  for (const [id, reasonText] of Object.entries(expected)) {
    const row = byId.get(id);
    assert.ok(row, `${id} ต้องอยู่ในรายการแชท`);
    assert.equal(row.ai_off?.by, NOT_QUALIFIED_BY, `${id}: ยังเป็นป้ายเหลือง`);
    assert.equal(row.ai_off.reasonText, reasonText, `${id}: รายการซ้าย`);
    const header = roomTriage({ db, customer: db.getCustomer(id), now });
    assert.equal(header.aiOff.reasonText, row.ai_off.reasonText, `${id}: รายการซ้ายกับหัวห้องต้องตัดสินแบบเดียวกัน`);
  }
});

test("รีวิวปรปักษ์รอบ 3 5 ต.ค.: การ์ดลูกค้าร้อนรอทีมทักต่อ = ข้อความเดียวกับคิวรอตอบสำหรับห้องเหลืองที่ทีมรับแล้ว", async (t) => {
  const { app } = await start(t);
  const auth = await login(app.server);
  const overview = await get(app.server, auth, "/console/api/overview/attention?limit=20");
  const hot = new Map(overview.hotQuiet.rooms.map((room) => [room.id, room]));
  assert.ok(hot.has("Y-owner") && hot.has("Y-plain"), JSON.stringify([...hot.keys()]));
  assert.equal(hot.get("Y-owner").aiOff.reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT, "มีคนถือห้อง = ตัวกวาดไม่เปิดคืนเอง");
  assert.equal(hot.get("Y-plain").aiOff.reasonText, NOT_QUALIFIED_REASON_TEXT, "เหลืองปกติ = ถ้อยคำเดิม");
  assert.equal(hot.get("Y-broadcast")?.aiOff.reasonText ?? NOT_QUALIFIED_REASON_TEXT, NOT_QUALIFIED_REASON_TEXT,
    "บรอดแคสต์ไม่ใช่ทีมรับห้อง");
  // การ์ดรอตอบบนหน้าเดียวกัน: เดิมเรียก summarizeWaiting ตรงโดยไม่ส่ง teamBlockedOf (ชิปรอตอบหน้าแชทได้ข้อความรอทีมแล้ว)
  const waiting = new Map(overview.waiting.rooms.map((room) => [room.id, room]));
  assert.equal(waiting.get("Y-staff")?.aiOff?.reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT);
});

test("รีวิวปรปักษ์รอบ 3 5 ต.ค.: summarizeHotQuiet ไม่มี DB = ถ้อยคำเดิม · teamBlockedOf ใช้กับห้องเหลืองผ่านตัวเลือก", () => {
  const now = Date.UTC(2026, 9, 5, 5, 0, 0);
  const row = {
    line_user_id: "Y-x", ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON, last_score: 9, channel_id: "default",
    last_in_at: now - 3 * DAY, last_at: now - 3 * DAY + MIN, ai_reply_at: now - 3 * DAY + MIN, outs_after_in: 1,
  };
  assert.equal(summarizeHotQuiet([row], { now }).rooms[0].aiOff.reasonText, NOT_QUALIFIED_REASON_TEXT);
  const blocked = summarizeHotQuiet([row], { now, teamBlockedOf: (item) => item.line_user_id === "Y-x" });
  assert.equal(blocked.rooms[0].aiOff.reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT);
});
