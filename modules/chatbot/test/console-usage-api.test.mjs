// console-usage-api.test.mjs — หน้า "Usage วันนี้" ของเจ้าของ (8 พ.ย. 2026 พี่ง้วง "ทำ dashboard ใน lukprae console
// ก็ได้ครับ พี่ง้วงเห็นคนเดียว ... ไม่กระทบกับ performance ของ ระบบตอบแชทนะครับ")
//
// สิ่งที่ด่านนี้ล็อก:
//   1. ตัวเลขรวมถูก: ลูกค้า/ข้อความ/ลูกค้าใหม่/คำตอบ/ทักตาม/รายชั่วโมง/ค่า AI ตามงาน/คุณภาพ/คัดกรอง · ไม่นับห้อง canary
//   2. ผลไม่มีรหัสหรือชื่อลูกค้า และไม่มีค่ากุญแจจากเกตเวย์
//   3. เห็นได้เฉพาะ finance.view (เจ้าของ) · แคช 30 วิ (poll/หลายแท็บไม่ยิง SQLite ซ้ำ) · เกตเวย์ล่ม = หน้ายังขึ้น
//   4. หน้าเว็บถูกผูกครบ: เสิร์ฟได้ · โหลด css · route + แท็บกันด้วย finance.view · ไม่มี innerHTML · ไฟล์ไม่เกิน 800 บรรทัด
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { memoryDb } from "./helpers.mjs";
import { buildUsageToday } from "../src/usageToday.mjs";
import { createConsoleUsageRoutes, keysFromHealth } from "../src/consoleUsageApi.mjs";
import { AUDIT_AI_OFF_NOT_QUALIFIED, QUALIFY_AUDIT_OPERATOR, QUALIFY_SWEEP_MODE_KEY } from "../src/notQualified.mjs";

const BKK = (h, m = 0, day = 8) => Date.UTC(2026, 10, day, h - 7, m);
const NOW = BKK(12, 15);
const RATE = 34;
// ราคาสมมติ: $1 ต่อ token เข้า 1,000 — พอให้ตรวจการรวม/แยกงานได้โดยไม่ผูกกับตารางราคาจริง
const costReport = (rows, rate) => {
  const breakdown = rows.map((row) => ({ model: row.model, kind: row.kind, usd: Number(row.tokens_in) / 1000 }));
  const usd = breakdown.reduce((total, row) => total + row.usd, 0);
  return { usd, thb: usd * rate, unknownTokens: 0, breakdown };
};

function world() {
  const clock = { t: BKK(8, 0, 7) };
  const db = memoryDb({ now: () => clock.t });
  const at = (t, fn) => { clock.t = t; return fn(); };
  // เมื่อวาน: ลูกค้าเก่า 2 ห้อง + ห้องเหลืองของตัวคัดกรอง
  at(BKK(9, 0, 7), () => {
    db.upsertCustomer("U-old", { displayName: "คุณเก่า" });
    db.upsertCustomer("U-back", { displayName: "คุณกลับมา" });
    db.upsertCustomer("U-yellow", { displayName: "คุณเหลือง" });
  });
  db.raw.prepare("UPDATE customers SET ai_enabled = 0, ai_off_reason = 'not_qualified' WHERE line_user_id = 'U-yellow'").run();
  at(BKK(10, 5, 7), () => db.insertMessage({ customerId: "U-old", direction: "in", content: "สวัสดีค่ะ" }));
  at(BKK(10, 6, 7), () => db.insertMessage({ customerId: "U-old", direction: "in", content: "ราคาเท่าไหร่คะ" }));
  at(BKK(10, 7, 7), () => db.addLlmUsage({ customerId: "U-old", kind: "draft", model: "gpt-6.1-sol", tokensIn: 2000, tokensOut: 100 }));
  at(BKK(15, 0, 7), () => db.insertMessage({ customerId: "U-old", direction: "in", content: "ขอคิดก่อนค่ะ" }));
  // วันนี้: ลูกค้าใหม่ 1 คน + ลูกค้าเก่ากลับมา 1 คน + ห้องทดสอบ (ต้องไม่ถูกนับ)
  at(BKK(9, 0), () => {
    db.upsertCustomer("U-new", { displayName: "คุณใหม่" });
    db.upsertCustomer("canary:probe", { displayName: "ทดสอบ" });
  });
  at(BKK(9, 5), () => db.insertMessage({ customerId: "U-new", direction: "in", content: "สนใจคลาสค่ะ" }));
  at(BKK(9, 6), () => db.insertMessage({ customerId: "U-new", direction: "in", content: "เรียนวันไหนคะ" }));
  at(BKK(9, 30), () => db.insertMessage({ customerId: "canary:probe", direction: "in", content: "ping" }));
  at(BKK(9, 7), () => db.insertMessage({ customerId: "U-new", direction: "out", content: "เสาร์นี้ค่ะ", agentMode: "ai", metadata: {
    replyEngine: { engine: "v3", calls: 2, styleCard: "opus-style-v9.3:abc", styleBank: ["b1"], firstDraft: { hard: ["H1"], soft: ["S2"] } },
  } }));
  at(BKK(9, 7), () => db.addLlmUsage({ customerId: "U-new", kind: "draft", model: "gpt-6.1-sol", tokensIn: 3000, tokensOut: 200 }));
  at(BKK(10, 10), () => db.insertMessage({ customerId: "U-back", direction: "in", content: "กลับมาถามต่อค่ะ" }));
  at(BKK(10, 11), () => db.insertMessage({ customerId: "U-back", direction: "out", content: "ได้เลยค่ะ", agentMode: "ai", metadata: {
    replyEngine: { engine: "v3", calls: 1, styleCard: "opus-style-v9.3:abc" },
  } }));
  at(BKK(10, 11), () => db.addLlmUsage({ customerId: "U-back", kind: "draft", model: "gpt-6.1-sol", tokensIn: 1000, tokensOut: 100 }));
  at(BKK(10, 30), () => db.addLlmUsage({ customerId: "U-back", kind: "qualify", model: "gpt-6.1-sol", tokensIn: 500, tokensOut: 50 }));
  at(BKK(11, 0), () => db.insertMessage({ customerId: "U-back", direction: "out", content: "ทักมาถามต่อนะคะ", agentMode: "ai", messageClass: "proactive" }));
  at(BKK(11, 0), () => db.addLlmUsage({ customerId: "U-back", kind: "staged_followup", model: "gpt-6.1-sol", tokensIn: 1500, tokensOut: 100 }));
  at(BKK(11, 30), () => db.insertMessage({ customerId: "U-back", direction: "out", content: "แอดมินตอบเองค่ะ", agentMode: "operator", operator: "chompoo" }));
  at(BKK(11, 40), () => db.addAudit({ operator: QUALIFY_AUDIT_OPERATOR, action: AUDIT_AI_OFF_NOT_QUALIFIED, target: "U-yellow", detail: "unemployed" }));
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  clock.t = NOW;
  return { db, clock };
}

const models = { replyModel: "gpt-6.1-sol", followupModel: "gpt-6.1-sol", scorerModel: "gpt-5.6-luna" };

test("ตัวเลขรวมวันนี้: ลูกค้า/ข้อความ/ลูกค้าใหม่/คำตอบ/ทักตาม · ไม่นับห้องทดสอบ · เทียบเมื่อวานเวลาเดียวกัน", () => {
  const { db } = world();
  const u = buildUsageToday({ db, nowMs: NOW, costReport, thbPerUsd: RATE, models, qualifyModel: "gpt-6.1-sol", qualifyDailyCapThb: 100 });
  assert.deepEqual(u.today, { customers: 2, inbound: 3, newCustomers: 1, aiReplies: 2, followups: 1, teamMessages: 1,
    costThb: Math.round((3000 + 1000 + 500 + 1500) / 1000 * RATE * 100) / 100 });
  assert.equal(u.yesterdaySameTime.inbound, 2, "เมื่อวานถึง 12:15 = สองข้อความตอนสิบโมง (ไม่นับบ่ายสาม)");
  assert.equal(u.yesterday.inbound, 3);
  assert.equal(u.yesterday.costThb, 2 * RATE);
});

test("รายชั่วโมง: แท่งของวันนี้ + เส้นเมื่อวาน · ชั่วโมงที่ยังไม่ถึงติดป้าย future · ค่า AI แยกชั่วโมง", () => {
  const { db } = world();
  const u = buildUsageToday({ db, nowMs: NOW, costReport, thbPerUsd: RATE, models });
  assert.equal(u.hourly.length, 24);
  assert.equal(u.hourly[9].inbound, 2);
  assert.equal(u.hourly[9].aiReplies, 1);
  assert.equal(u.hourly[10].inbound, 1);
  assert.equal(u.hourly[11].followups, 1);
  assert.equal(u.hourly[10].yesterdayInbound, 2);
  assert.equal(u.hourly[15].yesterdayInbound, 1);
  assert.equal(u.hourly[9].costThb, 3 * RATE);
  assert.equal(u.hourly[10].costThb, 1.5 * RATE);
  assert.equal(u.hourly[10].yesterdayCostThb, 2 * RATE);
  assert.equal(u.hourly[12].future, false);
  assert.equal(u.hourly[13].future, true);
});

test("ค่า AI ตามงาน + ใครทำงานอะไร: จำนวนครั้งต่องาน รุ่นตามที่ตั้ง · ตรวจก่อนส่งคือกติกาในโค้ด", () => {
  const { db } = world();
  const u = buildUsageToday({ db, nowMs: NOW, costReport, thbPerUsd: RATE, models, qualifyModel: "gpt-6.1-sol" });
  const draft = u.costByJob.find((row) => row.kind === "draft");
  assert.equal(draft.job, "ตอบแชท");
  assert.equal(draft.calls, 2);
  assert.equal(draft.costThb, 4 * RATE);
  assert.equal(u.costByJob[0].kind, "draft", "เรียงจากแพงสุด");
  const role = Object.fromEntries(u.roles.map((row) => [row.id, row]));
  assert.equal(role.reply.model, "gpt-6.1-sol");
  assert.equal(role.reply.calls, 2);
  assert.equal(role.followup.calls, 1);
  assert.equal(role.score.model, "gpt-5.6-luna");
  assert.equal(role.qualify.model, "gpt-6.1-sol");
  assert.equal(role.check.model, "กติกาในโค้ด");
});

test("คุณภาพนับต่อคำตอบ ไม่ใช่ต่อบับเบิล: คำตอบเดียวสามบับเบิลที่เขียนใหม่ = 1 คำตอบ 1 ครั้งเขียนใหม่", () => {
  const { db, clock } = world();
  const engine = { engine: "v3", calls: 2, styleCard: "opus-style-v9.3:abc", styleBank: ["b1"], firstDraft: { hard: [], soft: ["S2"] } };
  const at = (t, fn) => { clock.t = t; return fn(); };
  at(BKK(11, 50), () => db.insertMessage({ customerId: "U-new", direction: "in", content: "ขอรายละเอียดค่ะ" }));
  for (const [minute, content] of [[51, "ก"], [51, "ข"], [52, "ค"]]) {
    at(BKK(11, minute), () => db.insertMessage({ customerId: "U-new", direction: "out", content, agentMode: "ai", metadata: { replyEngine: engine } }));
  }
  // ลูกค้าถามต่อแล้วได้คำตอบใหม่ = นับเป็นอีกคำตอบ แม้ห่างกันไม่กี่วินาที
  at(BKK(11, 53), () => db.insertMessage({ customerId: "U-new", direction: "in", content: "แล้ววันไหนคะ" }));
  at(BKK(11, 53), () => db.insertMessage({ customerId: "U-new", direction: "out", content: "เสาร์ค่ะ", agentMode: "ai", metadata: { replyEngine: { ...engine, calls: 1, firstDraft: { hard: [], soft: [] } } } }));
  clock.t = NOW;
  const u = buildUsageToday({ db, nowMs: NOW, costReport, thbPerUsd: RATE, models, qualifyModel: "gpt-6.1-sol", qualifyDailyCapThb: 100 });
  assert.equal(u.quality.replies, 4, "เดิม 2 + คำตอบสามบับเบิล 1 + คำตอบถัดไป 1");
  assert.equal(u.quality.rewritten, 2);
  assert.equal(u.quality.bankUsed, 3);
  assert.deepEqual(u.quality.topRules, [{ id: "S2", n: 2 }, { id: "H1", n: 1 }]);
  assert.ok(!JSON.stringify(u.quality).includes("U-new"), "ผลต้องไม่มีรหัสลูกค้า");
});

test("คุณภาพ + คัดกรอง: เขียนใหม่/ผ่านรอบแรก/คลังคำตอบ/การ์ด/กติกาที่ผิดบ่อย · ห้องเหลืองตอนนี้ ปิดวันนี้ ตรวจแล้ว", () => {
  const { db } = world();
  const u = buildUsageToday({ db, nowMs: NOW, costReport, thbPerUsd: RATE, models, qualifyModel: "gpt-6.1-sol", qualifyDailyCapThb: 100 });
  assert.deepEqual(u.quality, { replies: 2, rewritten: 1, firstTry: 1, rewriteRate: 0.5, fallback: 0, bankUsed: 1,
    card: "opus-style-v9.3", topRules: [{ id: "H1", n: 1 }, { id: "S2", n: 1 }] });
  assert.equal(u.qualify.mode, "on");
  assert.equal(u.qualify.yellowNow, 1);
  assert.equal(u.qualify.closedToday, 1);
  assert.equal(u.qualify.reopenedToday, 0);
  assert.equal(u.qualify.checked, 1);
  assert.equal(u.qualify.costThb, 0.5 * RATE);
  assert.equal(u.qualify.dailyCapThb, 100);
  assert.equal(u.qualify.nextRoundAt, BKK(13, 0));
});

test("ผลไม่มีรหัสหรือชื่อลูกค้า", () => {
  const { db } = world();
  const text = JSON.stringify(buildUsageToday({ db, nowMs: NOW, costReport, thbPerUsd: RATE, models }));
  for (const secret of ["U-new", "U-back", "U-old", "U-yellow", "canary", "คุณใหม่", "คุณเก่า", "สนใจคลาส", "chompoo"]) {
    assert.ok(!text.includes(secret), `ไม่มี ${secret} ในผล`);
  }
});

/* --------------------------------- เส้นทาง --------------------------------- */

function routes({ db, now, fetchImpl, counter }) {
  const spy = counter ? new Proxy(db, { get(target, key) {
    if (key === "llmUsageSummary") return (...args) => { counter.n += 1; return target.llmUsageSummary(...args); };
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  } }) : db;
  return createConsoleUsageRoutes({
    db: spy, now, costReport, fxNow: () => ({ thbPerUsd: RATE, source: "test" }), currentModels: () => models,
    qualifyModel: "gpt-6.1-sol", qualifyDailyCapThb: 100, gatewayBase: "http://127.0.0.1:8650/v1", gatewayToken: "local-test",
    fetchImpl, logger: { warn() {} },
  });
}
async function call(r, { role = "owner", method = "GET", path = ["usage", "today"] } = {}) {
  const out = {};
  const handled = await r.handle({ method }, {}, new URL("http://x/console/api/usage/today"), path,
    { json: (res, status, body) => Object.assign(out, { status, body }), operator: { role } });
  return { handled, ...out };
}
const HEALTH = {
  ok: true, openaiKeys: [{ slot: 1, active: true }, { slot: 2, active: false }], anthropicKeys: [{ slot: 1, active: true }],
  openaiKeyLastSwitchAt: "", modelFailures: { "claude-opus-5-5": { code: "x" } }, upstreamApiKey: "sk-should-never-leak",
};

test("เห็นได้เฉพาะเจ้าของ (finance.view) · method อื่น 405 · เส้นอื่นไม่ใช่ของไฟล์นี้", async () => {
  const { db, clock } = world();
  const r = routes({ db, now: () => clock.t, fetchImpl: async () => ({ ok: true, json: async () => HEALTH }) });
  assert.equal((await call(r, { role: "operator" })).status, 403);
  assert.equal((await call(r, { role: "admin" })).status, 403, "admin แจกได้จาก dropdown — ไม่เห็นเงิน");
  const ok = await call(r);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.usage.today.customers, 2);
  assert.equal((await call(r, { method: "POST" })).status, 405);
  assert.equal((await call(r, { path: ["line-usage"] })).handled, false);
});

test("แคช 30 วิ: เรียกซ้ำไม่คิวรีซ้ำ · พ้น 30 วิประกอบใหม่ · คำขอซ้อนรอผลเดียวกัน", async () => {
  const { db, clock } = world();
  const counter = { n: 0 };
  const r = routes({ db, now: () => clock.t, counter, fetchImpl: async () => ({ ok: true, json: async () => HEALTH }) });
  await Promise.all([call(r), call(r), call(r)]);
  const perBuild = counter.n;
  assert.ok(perBuild > 0);
  clock.t += 29_000;
  await call(r);
  assert.equal(counter.n, perBuild, "ภายใน 30 วิ ใช้ผลเดิม");
  clock.t += 2_000;
  await call(r);
  assert.equal(counter.n, perBuild * 2);
});

test("สถานะกุญแจ: เหลือแค่เลขชุด/ใช้อยู่/รุ่นที่มีปัญหา ไม่มีค่ากุญแจ · เกตเวย์ล่ม = หน้ายังขึ้น keys เป็น null", async () => {
  const keys = keysFromHealth(HEALTH);
  assert.deepEqual(keys.openai, [{ slot: 1, active: true }, { slot: 2, active: false }]);
  assert.deepEqual(keys.failingModels, ["claude-opus-5-5"]);
  assert.ok(!JSON.stringify(keys).includes("sk-"));
  assert.equal(keysFromHealth(null), null);
  const { db, clock } = world();
  let auth = "";
  const seen = routes({ db, now: () => clock.t, fetchImpl: async (url, init) => {
    auth = init.headers.authorization;
    assert.equal(url, "http://127.0.0.1:8650/v1/models/health");
    return { ok: true, json: async () => HEALTH };
  } });
  const good = await call(seen);
  assert.equal(auth, "Bearer local-test");
  assert.equal(good.body.usage.keys.anthropic.length, 1);
  assert.ok(!JSON.stringify(good.body).includes("sk-should-never-leak"));
  const down = routes({ db, now: () => clock.t, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  const result = await call(down);
  assert.equal(result.status, 200);
  assert.equal(result.body.usage.keys, null);
});

/* -------------------------------- หน้าเว็บ -------------------------------- */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("หน้าเว็บผูกครบ: เสิร์ฟได้ · index โหลด css · route/แท็บกันด้วย finance.view · ไม่มี innerHTML · ไม่เกิน 800 บรรทัด", () => {
  const statics = read("src/consoleStatic.mjs");
  assert.match(statics, /"usage\.mjs", "usage\.css"/u);
  assert.match(read("public/console/index.html"), /href="\/console\/static\/usage\.css"/u);
  const shell = read("public/console/console.js");
  assert.match(shell, /import \{ createUsagePage \} from "\.\/usage\.mjs";/u);
  assert.match(shell, /hash: "#\/usage".*capability: "finance\.view"/u);
  assert.match(shell, /startsWith\("#\/usage"\)\) state\.me\?\.capabilities\?\.includes\("finance\.view"\)/u);
  assert.match(read("src/consoleApi.mjs"), /usageRoutes\.handle\(req, res, url, route/u);
  for (const file of ["public/console/usage.mjs", "public/console/usage.css", "src/usageToday.mjs", "src/consoleUsageApi.mjs"]) {
    const text = read(file);
    assert.ok(text.split("\n").length <= 800, `${file} ไม่เกิน 800 บรรทัด`);
    assert.ok(!/innerHTML|insertAdjacentHTML|setAttribute\("style"/u.test(text), `${file} ไม่ฉีด HTML/สไตล์ inline`);
  }
  assert.match(read("public/console/usage.css"), /prefers-reduced-motion: reduce/u, "ลดการเคลื่อนไหว = นิ่ง");
});
