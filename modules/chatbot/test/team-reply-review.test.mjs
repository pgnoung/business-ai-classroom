// team-reply-review.test.mjs — Luna ตรวจคำตอบของทีม (คำสั่งพี่ง้วง 3 พ.ย. 2026: "พี่ง้วงเห็นคนเดียว" · "ใช้ luna ดีกว่า")
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  TEAM_REVIEW_LAST_DAY_KEY, TEAM_REVIEW_MODE_KEY, buildTeamReviewUser, createTeamReplyReviewRunner, parseTeamReview, teamReviewSystemPrompt,
} from "../src/teamReplyReview.mjs";
import { summarizeTeamReviews } from "../src/consoleTeamReviewApi.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const MIN = 60_000;
const HOUR = 60 * MIN;
const bkk = (d, h, m = 0) => Date.UTC(2026, 10, d, h - 7, m, 0); // เวลาไทย พ.ย. 2026
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "team-review-pass-123";

function seed() {
  let clock = bkk(3, 20, 5);
  const db = memoryDb({ now: () => clock });
  const at = (ms, fn) => { const keep = clock; clock = ms; try { return fn(); } finally { clock = keep; } };
  const msg = (id, ago, direction, content, extra = {}) => at(ago, () => db.insertMessage({ customerId: id, direction, content, ...extra }));
  at(bkk(1, 9), () => db.upsertCustomer("U-team", { displayName: "คุณสมชาย" }));
  msg("U-team", bkk(3, 10), "in", "สนใจคลาส AI รอบเดือนหน้าค่ะ ราคาเท่าไหร่");
  msg("U-team", bkk(3, 10, 1), "out", "รอบเดือนหน้ามีวันที่ 20 ค่ะ ราคา 12,900 บาท", { agentMode: "ai" });
  msg("U-team", bkk(3, 14), "out", "สวัสดีค่ะ ชมพู่เองนะคะ สนใจรอบไหนคะ", { operator: "chom", agentMode: "operator_ai_on" });
  // ห้องที่มีแต่ลูกแพร = ไม่ใช่งานตรวจทีม
  at(bkk(1, 9), () => db.upsertCustomer("U-ai-only", { displayName: "คุณเอไอ" }));
  msg("U-ai-only", bkk(3, 11), "in", "มีรอบไหนคะ");
  msg("U-ai-only", bkk(3, 11, 1), "out", "รอบเดือนหน้าค่ะ", { agentMode: "ai" });
  // ทีมคุยเมื่อวานซืน (นอกช่วง 24 ชม.) = ไม่เข้า
  at(bkk(1, 9), () => db.upsertCustomer("U-old", { displayName: "คุณเก่า" }));
  msg("U-old", bkk(1, 15), "in", "สวัสดีค่ะ");
  msg("U-old", bkk(1, 15, 5), "out", "สวัสดีค่ะ", { operator: "chom", agentMode: "operator_ai_on" });
  return { db, at, setClock: (ms) => { clock = ms; } };
}

function runnerFor(db, { reply, budgetOk = true } = {}) {
  const calls = [];
  const hermes = {
    async ownerReviewCheck(args) {
      calls.push(args);
      return { text: reply ?? JSON.stringify({ score: 2, summary: "ลูกค้าถามราคา ทีมถามซ้ำ", good: "ทักทายอบอุ่น",
        issues: [{ code: "repeated_question", ref: "m3", note: "ลูกแพรบอกรอบไปแล้ว ควรชวนสมัครรอบวันที่ 20 เลย" }, { code: "made_up", ref: "m3" }] }),
      usage: { prompt_tokens: 800, completion_tokens: 60 }, model: "gpt-5.6-luna" };
    },
  };
  const usage = [];
  const runner = createTeamReplyReviewRunner({
    db, hermes, logger: silent, now: () => db.__now?.() ?? Date.now(),
    budgetCheck: () => (budgetOk ? { ok: true } : { ok: false, reason: "daily_cap" }),
    recordUsage: (id, result) => { usage.push(id); return true; },
    noteUnmetered: () => {}, breakerOpen: () => false, noteModel: () => {},
  });
  return { runner, calls, usage };
}

test("พรอมต์: ตรวจเฉพาะแอดมิน · บทสนทนาปิดชื่อลูกค้า · แถวของแอดมินอยู่ใน teamIds", () => {
  const system = teamReviewSystemPrompt();
  assert.match(system, /ตรวจเฉพาะข้อความของแอดมิน/u);
  assert.match(system, /contradicts_lukprae/u);
  const rows = [
    { id: "a", direction: "in", msg_type: "text", content: "สวัสดีค่ะ ฉันชื่อสมชาย", created_at: 100 },
    { id: "b", direction: "out", msg_type: "text", content: "สวัสดีค่ะ", operator: "", created_at: 200 },
    { id: "c", direction: "out", msg_type: "text", content: "ชมพู่เองค่ะ คุณสมชาย", operator: "chom", created_at: 300 },
  ];
  const built = buildTeamReviewUser({ rows, windowStartMs: 150, nowMs: 400, names: ["สมชาย"] });
  assert.doesNotMatch(built.user, /สมชาย/u, "ชื่อลูกค้าไม่ออกจากเครื่อง");
  assert.deepEqual([...built.teamIds], ["c"]);
  assert.deepEqual([...built.reviewIds], ["b", "c"]);
});

test("ตัวแปลงผล: คะแนนต้องเป็นจำนวนเต็ม 1–5 · รหัสนอกรายการทิ้ง · ref นอกช่วงไม่ผูกฟอง", () => {
  const refs = new Map([["m1", "a"], ["m3", "c"]]);
  const ok = parseTeamReview('{"score":4,"summary":"ดี","good":"ต่อเนียน","issues":[{"code":"curt","ref":"m3","note":"สั้นไป"},{"code":"nope"},{"code":"other","ref":"m1"}]}',
    { refs, reviewIds: new Set(["c"]) });
  assert.equal(ok.score, 4);
  assert.deepEqual(ok.issues.map((i) => [i.code, i.messageId]), [["curt", "c"], ["other", ""]]);
  for (const bad of ["", "ไม่ใช่ json", '{"score":0}', '{"score":6}', '{"score":3.5}', '{"score":"4"}', "[]"]) {
    assert.equal(parseTeamReview(bad), null, bad);
  }
});

test("รอบหลัง 20:00: สร้างแถวเฉพาะห้องที่ทีมคุยใน 24 ชม. · Luna อ่าน · บันทึกคะแนน · ไม่สร้างซ้ำ", async () => {
  const { db } = seed();
  const { runner, calls, usage } = runnerFor(db);
  const first = await runner.runDue(bkk(3, 20, 5));
  assert.equal(first.status, "team_reviewed");
  assert.equal(first.done, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, "team");
  assert.doesNotMatch(calls[0].user, /สมชาย/u);
  assert.deepEqual(usage, ["U-team"], "บันทึกต้นทุนทุกครั้ง");
  assert.equal(db.getSetting(TEAM_REVIEW_LAST_DAY_KEY), "2026-11-03");
  const [row] = db.listTeamReviews({ sinceDayKey: "2026-11-01" });
  assert.equal(row.customer_id, "U-team");
  assert.equal(row.operators, "chom");
  assert.equal(row.score, 2);
  const issues = JSON.parse(row.issues_json);
  assert.deepEqual(issues.map((i) => i.code), ["repeated_question"], "รหัสนอกรายการถูกทิ้ง");
  assert.match(issues[0].note, /ชวนสมัคร/u);
  const again = await runner.runDue(bkk(3, 20, 10));
  assert.equal(again.skipped, "team_no_work");
  assert.equal(calls.length, 1, "วันเดียวกันไม่อ่านซ้ำ");
});

test("ก่อน 20:00 / เลยมาเกิน 3 ชม. ไม่สร้างรอบ · สวิตช์ปิด = ไม่เรียก Luna · เงินหมด = แถวค้างไว้รอบหน้า", async () => {
  const early = seed();
  const a = runnerFor(early.db);
  assert.equal((await a.runner.runDue(bkk(3, 19, 59))).skipped, "team_no_work", "รอบของเมื่อวานเลยเวลาไปแล้ว");
  const late = seed();
  const b = runnerFor(late.db);
  assert.equal((await b.runner.runDue(bkk(3, 23, 30))).skipped, "team_no_work");
  assert.equal(b.calls.length, 0);
  const off = seed();
  off.db.setSetting(TEAM_REVIEW_MODE_KEY, "off");
  const c = runnerFor(off.db);
  assert.equal((await c.runner.runDue(bkk(3, 20, 5))).skipped, "team_switch_off");
  const capped = seed();
  const d = runnerFor(capped.db, { budgetOk: false });
  const result = await d.runner.runDue(bkk(3, 20, 5));
  assert.equal(result.paused, "capped");
  assert.equal(d.calls.length, 0, "เกินเพดานเงิน = ไม่เรียก Luna");
  assert.equal(capped.db.pendingTeamReviews({}).length, 1, "แถวยังรอ ไม่หาย");
});

test("Luna ตอบผิดรูป = failed ไม่ค้าง pending", async () => {
  const { db } = seed();
  const { runner } = runnerFor(db, { reply: "ขอโทษค่ะ" });
  const result = await runner.runDue(bkk(3, 20, 5));
  assert.equal(result.invalid, 1);
  assert.equal(db.listTeamReviews({ sinceDayKey: "2026-11-01" })[0].status, "failed");
});

test("สรุป: เฉลี่ยทั้งทีม · แยกตามคน · ปัญหาที่เจอบ่อย · รายห้องคะแนนต่ำก่อน", () => {
  const rows = [
    { status: "done", score: 2, operators: "chom", customer_id: "A", day_key: "2026-11-03", issues_json: '[{"code":"repeated_question","note":"x"}]' },
    { status: "done", score: 5, operators: "chom,pilot-owner", customer_id: "B", day_key: "2026-11-03", issues_json: "[]" },
    { status: "failed", score: null, operators: "chom", customer_id: "C", day_key: "2026-11-03", issues_json: "[]" },
  ];
  const s = summarizeTeamReviews(rows);
  assert.equal(s.reviewed, 2);
  assert.equal(s.notReviewed, 1);
  assert.equal(s.avgScore, 3.5);
  assert.deepEqual(s.operators.map((o) => [o.operator, o.rooms, o.avgScore]), [["chom", 2, 3.5], ["pilot-owner", 1, 5]]);
  assert.deepEqual(s.topIssues, [{ code: "repeated_question", label: "ถามซ้ำ", count: 1 }]);
  assert.deepEqual(s.rooms.map((r) => r.id), ["A", "B"]);
});

test("API: เจ้าของอ่านได้ · admin และ staff ได้ 403 (ชมพู่ไม่เห็นคะแนนตัวเอง)", async (t) => {
  const db = memoryDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "owner", passHash, role: "owner" });
  db.createOperator({ username: "admin1", passHash, role: "admin" });
  db.createOperator({ username: "chom", passHash, role: "operator" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "team-review-secret-123" }), db,
    overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = async (username) => {
    const res = await httpRequest(app.server, {
      method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    assert.equal(res.status, 200);
    return res.headers["set-cookie"][0].split(";")[0];
  };
  const owner = await httpRequest(app.server, { path: "/console/api/team-review?days=7", headers: { cookie: await login("owner") } });
  assert.equal(owner.status, 200);
  assert.equal(owner.json.reviewed, 0);
  for (const username of ["admin1", "chom"]) {
    const res = await httpRequest(app.server, { path: "/console/api/team-review", headers: { cookie: await login(username) } });
    assert.equal(res.status, 403, username);
  }
  const anonymous = await httpRequest(app.server, { path: "/console/api/team-review" });
  assert.equal(anonymous.status, 401);
});
