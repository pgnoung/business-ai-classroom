// step-messages.test.mjs — ข้อความตามขั้น (Step messages) (28 ก.ย. 2026)
// นาฬิกาปลอมตรึงไว้กลางวันเวลาไทย (ไม่งั้นเทสต์ที่รันตอนกลางคืนจะเจอช่วงเงียบ 21:00–09:00) · LINE = stub
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { keywordMatches, stepDueAt, validateStepSequenceInput } from "../src/stepMessages.mjs";
import { addCustomerTag } from "../src/customerTagActions.mjs";
import { hermesFetchStub, httpRequest, listen, memoryDb, poisonGlobalFetch, signLine, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "step-owner-pass-123";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// อังคาร 29 ก.ย. 2026 11:00 น. เวลาไทย
const T0 = Date.UTC(2026, 8, 29, 4, 0, 0);

function lineStub({ push = () => 200 } = {}) {
  const posts = [];
  const headers = (map = {}) => ({ get: (name) => map[String(name).toLowerCase()] ?? null });
  const fn = async (url, opts = {}) => {
    const u = String(url);
    if ((opts.method || "GET") === "GET") {
      if (u.includes("/quota/consumption")) return { ok: true, status: 200, headers: headers(), json: async () => ({ totalUsage: 100 }) };
      if (u.includes("/v2/bot/message/quota")) return { ok: true, status: 200, headers: headers(), json: async () => ({ type: "limited", value: 10_000 }) };
      return { ok: false, status: 404, headers: headers(), json: async () => ({}) };
    }
    const body = opts.body ? JSON.parse(opts.body) : null;
    posts.push({ url: u, body, headers: opts.headers || {} });
    const status = u.endsWith("/v2/bot/message/push") ? push(body) : 200;
    if (status === "throw") throw new Error("socket hang up");
    return { ok: status >= 200 && status < 300, status, headers: headers({ "x-line-request-id": "11111111-2222-4333-8444-555555555555" }), json: async () => ({}) };
  };
  fn.posts = posts;
  fn.pushes = () => posts.filter((p) => p.url.endsWith("/v2/bot/message/push"));
  return fn;
}

async function start(t, { stub = lineStub(), configEnv = {} } = {}) {
  let clock = T0;
  const now = () => clock;
  const db = memoryDb({ now });
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), displayName: "เจ้าของ", role: "owner" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "step-messages-console-secret-0123456789", MEDIA_PUBLIC_BASE_URL: "https://studio.example", ...configEnv }),
    db, logger: silent,
    overrides: { lineFetch: stub, hermesFetch: hermesFetchStub(), sleep: async () => {}, stepNow: now },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  const auth = { cookie: (login.headers["set-cookie"]?.[0] || "").split(";", 1)[0], csrf: login.json.csrf };
  return {
    app, db, stub, auth,
    at: () => clock,
    advance: (ms) => { clock += ms; },
    setClock: (ms) => { clock = ms; },
  };
}

const post = (server, path, auth, body) => httpRequest(server, {
  method: "POST", path, headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf, "content-type": "application/json" },
  body: JSON.stringify(body),
});

function webhook(server, event) {
  const raw = JSON.stringify({ events: [event] });
  return httpRequest(server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") }, body: raw,
  });
}

const followEvent = (userId, id = userId, timestamp = T0) => ({ type: "follow", webhookEventId: `f-${id}`, timestamp, follow: { isUnblocked: false }, source: { type: "user", userId } });

const TWO_STEPS = [
  { delay: { kind: "hours", hours: 1 }, messages: [{ type: "text", text: "ยินดีต้อนรับค่ะ ดูคลาสที่ https://pngoung.example/start" }] },
  { delay: { kind: "days", days: 1, at: "10:00" }, messages: [{ type: "sticker", packageId: "11537", stickerId: "52002734" }, { type: "text", text: "วันนี้มีเคล็ดลับมาฝากค่ะ" }] },
];

async function createAndActivate(env, body) {
  const created = await post(env.app.server, "/console/api/broadcast/steps", env.auth, { channelId: "default", ...body });
  assert.equal(created.status, 201, created.text);
  const id = created.json.sequence.id;
  const preview = await post(env.app.server, `/console/api/broadcast/steps/${id}/preview`, env.auth, {});
  assert.equal(preview.status, 200, preview.text);
  const activated = await post(env.app.server, `/console/api/broadcast/steps/${id}/activate`, env.auth, {
    confirm: true, confirmText: preview.json.summary.expectedConfirmText, confirmation: preview.json.confirmation,
  });
  assert.equal(activated.status, 200, activated.text);
  return { id, preview: preview.json, sequence: activated.json.sequence };
}

/* -------------------------------- pure -------------------------------- */

test("ตรวจลำดับ: ชื่อ/ทริกเกอร์/หน่วงเวลา/เวลาส่ง/คีย์เวิร์ด/จำนวนขั้น/ตัวกันราคา", () => {
  const ok = validateStepSequenceInput({ name: "ต้อนรับเพื่อนใหม่", triggerType: "follow", steps: TWO_STEPS });
  assert.equal(ok.error, undefined, ok.error);
  assert.deepEqual(ok.sequence.steps[1].delay, { kind: "days", days: 1, at: "10:00" });
  const refuse = (body, pattern) => assert.match(String(validateStepSequenceInput(body).error || ""), pattern);
  refuse({ name: "", triggerType: "follow", steps: TWO_STEPS }, /ชื่อ/u);
  refuse({ name: "x", triggerType: "birthday", steps: TWO_STEPS }, /ทริกเกอร์/u);
  refuse({ name: "x", triggerType: "follow", steps: [] }, /อย่างน้อย 1 ขั้น/u);
  refuse({ name: "x", triggerType: "follow", steps: Array.from({ length: 11 }, () => TWO_STEPS[0]) }, /ไม่เกิน 10/u);
  refuse({ name: "x", triggerType: "follow", steps: [{ ...TWO_STEPS[0], delay: { kind: "hours", hours: 0 } }] }, /1–72/u);
  refuse({ name: "x", triggerType: "follow", steps: [{ ...TWO_STEPS[0], delay: { kind: "days", days: 2, at: "22:00" } }] }, /09:00–20:30/u);
  refuse({ name: "x", triggerType: "keyword", triggerValue: "สอง คำ", steps: TWO_STEPS }, /คำเดียว/u);
  refuse({ name: "x", triggerType: "tag", triggerValue: "null", steps: TWO_STEPS }, /ป้าย/u);
  const guarded = validateStepSequenceInput({ name: "x", triggerType: "follow", steps: TWO_STEPS }, { guardCheck: () => ({ ok: false, error: "ราคาไม่ตรง" }) });
  assert.match(guarded.error, /ราคาไม่ตรง/u);
  assert.equal(validateStepSequenceInput({ name: "x", triggerType: "keyword", triggerValue: "#ของแจก", steps: TWO_STEPS }).sequence.triggerValue, "ของแจก");
});

test("เวลาถึงกำหนด: ชั่วโมง/วันที่+เวลา และไม่ตกช่วงเงียบ 21:00–09:00", () => {
  assert.equal(stepDueAt({ delay: { kind: "hours", hours: 3 } }, T0), T0 + 3 * HOUR);
  // วันถัดไป 10:00 เวลาไทย
  assert.equal(stepDueAt({ delay: { kind: "days", days: 1, at: "10:00" } }, T0), Date.UTC(2026, 8, 30, 3, 0, 0));
  // เข้าลำดับ 20:30 + 2 ชม. = 22:30 → เลื่อนไป 09:00–09:40 วันถัดไป
  const late = stepDueAt({ delay: { kind: "hours", hours: 2 } }, Date.UTC(2026, 8, 29, 13, 30, 0), "seed");
  assert.ok(late >= Date.UTC(2026, 8, 30, 2, 0, 0) && late <= Date.UTC(2026, 8, 30, 2, 40, 0), new Date(late).toISOString());
});

test("คีย์เวิร์ด: #คำ ต้องเป็นคำเต็ม · ต่อด้วยคำลงท้ายได้ · ไม่จับคำที่ยาวกว่า", () => {
  assert.equal(keywordMatches("#ของแจก", "ของแจก"), true);
  assert.equal(keywordMatches("สนใจ #ของแจกค่ะ", "ของแจก"), true);
  assert.equal(keywordMatches("#MOS2026 ครับ", "mos2026"), true, "ไม่สนตัวพิมพ์");
  assert.equal(keywordMatches("#ของแจกพิเศษ", "ของแจก"), false);
  assert.equal(keywordMatches("abc#ของแจก", "ของแจก"), false);
  assert.equal(keywordMatches("ของแจก", "ของแจก"), false, "ต้องมี #");
});

/* ------------------------------ end to end ------------------------------ */

test("เพิ่มเพื่อน → เข้าลำดับ → ส่งขั้น 1 ตามเวลา (push เหตุผล step_message + หน่วยสถิติ + ลิงก์นับคลิก) → ขั้น 2 วันถัดไป", async (t) => {
  const env = await start(t);
  const { id, preview } = await createAndActivate(env, { name: "ต้อนรับเพื่อนใหม่", triggerType: "follow", steps: TWO_STEPS });
  assert.match(preview.summary.warnings.join(" "), /OA Manager/u, "เตือนว่าถ้า OA Manager ยังเปิดชุดเดียวกัน ลูกค้าได้สองครั้ง");
  assert.equal((await webhook(env.app.server, followEvent("U-new"))).status, 200);
  const enrollment = env.db.raw.prepare("SELECT * FROM step_enrollments WHERE sequence_id = ?").get(id);
  assert.equal(enrollment.status, "active");
  assert.equal(enrollment.next_due_at, T0 + HOUR);

  await env.app.stepMessages.runOnce();
  assert.equal(env.stub.pushes().length, 0, "ยังไม่ถึงเวลา");
  env.advance(HOUR + 1);
  await env.app.stepMessages.runOnce();
  const [push] = env.stub.pushes();
  assert.ok(push, "ส่งขั้น 1");
  assert.equal(push.body.to, "U-new");
  assert.match(push.body.customAggregationUnits[0], /^lkp_s_[A-Za-z0-9]+_1$/u);
  assert.match(push.body.messages[0].text, /https:\/\/studio\.example\/r\/[A-Za-z]{12}/u, "ลิงก์ถูกแปลงเป็นลิงก์นับคลิก");
  assert.ok(push.headers["x-line-retry-key"]);
  const ledger = env.db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" });
  assert.deepEqual(ledger.map((r) => [r.method, r.purpose]), [["push", "step_message"]]);
  const history = env.db.messagesFor("U-new");
  assert.ok(history.some((m) => m.message_class === "proactive" && m.agent_mode === "step_message"), "ห้องแชทเห็นข้อความตามขั้น");
  assert.equal(env.db.getFollowupState("U-new").sent_today, 1, "ใช้โควตาทักอัตโนมัติวันนี้แล้ว (ทักตามจะไม่ซ้อน)");
  const after = env.db.getStepEnrollment(enrollment.id);
  assert.equal(after.next_step, 1);
  assert.equal(after.next_due_at, Date.UTC(2026, 8, 30, 3, 0, 0), "ขั้น 2 = วันถัดไป 10:00");

  env.setClock(Date.UTC(2026, 8, 30, 3, 5, 0));
  await env.app.stepMessages.runOnce();
  assert.equal(env.stub.pushes().length, 2, "ขั้น 2 ส่งตามเวลา");
  assert.equal(env.db.getStepEnrollment(enrollment.id).status, "completed");
  const detail = await httpRequest(env.app.server, { path: `/console/api/broadcast/steps/${id}`, headers: { cookie: env.auth.cookie } });
  assert.deepEqual(detail.json.sequence.stepStats.map((s) => [s.step, s.entered, s.sent]), [[1, 1, 1], [2, 1, 1]]);
  assert.doesNotMatch(detail.text, /U-new/u, "สถิติไม่มี id ลูกค้า");
});

test("เปิดใช้ลำดับที่เริ่มจากจุดเดียวกับลำดับที่ทำงานอยู่ = หน้ายืนยันเตือนชื่อชุดที่ซ้ำ", async (t) => {
  const env = await start(t);
  await createAndActivate(env, { name: "ต้อนรับชุดแรก", triggerType: "follow", steps: TWO_STEPS });
  const second = await post(env.app.server, "/console/api/broadcast/steps", env.auth, { channelId: "default", name: "ต้อนรับชุดสอง", triggerType: "follow", steps: TWO_STEPS });
  const preview = await post(env.app.server, `/console/api/broadcast/steps/${second.json.sequence.id}/preview`, env.auth, {});
  assert.equal(preview.status, 200, preview.text);
  assert.match(preview.json.summary.warnings.join(" "), /"ต้อนรับชุดแรก" เริ่มจากจุดเดียวกัน/u);
  const other = await post(env.app.server, "/console/api/broadcast/steps", env.auth, { channelId: "default", name: "คีย์เวิร์ด", triggerType: "keyword", triggerValue: "ของแจก", steps: TWO_STEPS });
  const clean = await post(env.app.server, `/console/api/broadcast/steps/${other.json.sequence.id}/preview`, env.auth, {});
  assert.doesNotMatch(clean.json.summary.warnings.join(" "), /เริ่มจากจุดเดียวกัน/u);
});

test("หยุดเอง: ซื้อแล้ว/สแปม/ขอหยุดทัก/บล็อก/ทีมรับห้อง/เรื่องเงิน/ลูกค้าตอบ (เลือกไว้)", async (t) => {
  const env = await start(t);
  const { id } = await createAndActivate(env, { name: "ต้อนรับ", triggerType: "follow", stopOnReply: true, steps: TWO_STEPS });
  const cases = [
    ["U-buy", (db) => db.addTag("U-buy", "customer", "human"), "purchased"],
    ["U-buy2", (db) => db.addTag("U-buy2", "ซื้อครั้งที่: 1", "rfm"), "purchased"],
    ["U-spam", (db) => db.addTag("U-spam", "NULL", "human"), "spam"],
    ["U-dnd", (db) => db.setDoNotDisturb("U-dnd", true), "dnd"],
    ["U-human", (db) => db.setAiEnabled("U-human", false), "human_takeover"],
    ["U-money", (db) => db.raw.prepare("UPDATE customers SET deal_status = 'awaiting_payment' WHERE line_user_id = ?").run("U-money"), "money_line"],
  ];
  for (const [userId] of cases) {
    env.db.upsertCustomer(userId, { channelId: "default" });
    await webhook(env.app.server, followEvent(userId));
  }
  await webhook(env.app.server, followEvent("U-block"));
  await webhook(env.app.server, followEvent("U-reply"));
  for (const [, mutate] of cases) mutate(env.db);
  await webhook(env.app.server, { type: "unfollow", webhookEventId: "unf-block", timestamp: T0, source: { type: "user", userId: "U-block" } });
  env.advance(5 * 60_000);
  await webhook(env.app.server, {
    type: "message", webhookEventId: "m-reply", replyToken: "rt-reply", source: { type: "user", userId: "U-reply" },
    message: { id: "msg-reply", type: "text", text: "ขอบคุณค่ะ" },
  });
  env.advance(3 * HOUR);
  await env.app.stepMessages.runOnce();
  const rows = env.db.raw.prepare("SELECT customer_id, status, stop_reason FROM step_enrollments WHERE sequence_id = ? ORDER BY customer_id").all(id);
  const reasons = Object.fromEntries(rows.map((row) => [row.customer_id, `${row.status}:${row.stop_reason}`]));
  for (const [userId, , reason] of cases) assert.equal(reasons[userId], `stopped:${reason}`, userId);
  assert.equal(reasons["U-block"], "stopped:unfollowed");
  assert.equal(reasons["U-reply"], "stopped:customer_replied");
  assert.equal(env.stub.pushes().length, 0, "ไม่มีใครได้ข้อความ");
});

test("ลำดับความสำคัญ: ช่วงเงียบ/คุยสด/วันนี้ทักไปแล้ว = เลื่อน ไม่ส่งซ้อน", async (t) => {
  const env = await start(t);
  await createAndActivate(env, { name: "ต้อนรับ", triggerType: "follow", steps: TWO_STEPS });
  await webhook(env.app.server, followEvent("U-live"));
  await webhook(env.app.server, followEvent("U-capped"));
  await webhook(env.app.server, followEvent("U-night"));
  env.db.insertMessage({ customerId: "U-live", direction: "in", content: "ถามราคาค่ะ" });
  env.advance(HOUR + 60_000);
  env.db.insertMessage({ customerId: "U-live", direction: "out", content: "ลูกแพรตอบค่ะ", agentMode: "ai" });
  env.db.insertMessage({ customerId: "U-capped", direction: "out", content: "ทักตามค่ะ", messageClass: "proactive", agentMode: "ai" });
  env.advance(3 * 60_000);
  await env.app.stepMessages.runOnce();
  const defer = (userId) => env.db.raw.prepare("SELECT defer_reason, next_due_at FROM step_enrollments WHERE customer_id = ?").get(userId);
  assert.equal(defer("U-live").defer_reason, "live_conversation");
  assert.equal(defer("U-capped").defer_reason, "daily_cap");
  assert.equal(env.stub.pushes().length, 1, "เฉพาะ U-night (เงียบ ไม่มีอะไรวันนี้) ได้ขั้น 1");
  // ช่วงเงียบ: คนใหม่เข้ามาตอน 20:50 หน่วง 1 ชม. = 21:50 → เลื่อนไปเช้า
  env.setClock(Date.UTC(2026, 8, 29, 13, 50, 0));
  await webhook(env.app.server, followEvent("U-late", "late", env.at()));
  const late = defer("U-late");
  assert.ok(late.next_due_at >= Date.UTC(2026, 8, 30, 2, 0, 0), "ไม่ส่งช่วง 21:00–09:00");
});

test("ป้ายเป็นทริกเกอร์: คนที่มีป้ายก่อนเปิดใช้ = baseline ไม่ได้รับ · ติดป้ายหลังเปิด = เข้าลำดับ · ป้ายหาย = หยุด", async (t) => {
  const env = await start(t);
  env.db.upsertCustomer("U-old", { channelId: "default" });
  env.db.addTag("U-old", "ของแจก: E-book", "human");
  const { id } = await createAndActivate(env, { name: "ส่งของแจก", triggerType: "tag", triggerValue: "ของแจก:*", steps: TWO_STEPS });
  assert.equal(env.db.raw.prepare("SELECT status FROM step_enrollments WHERE customer_id = 'U-old'").get().status, "baseline");
  env.advance(60_000);
  env.db.upsertCustomer("U-fresh", { channelId: "default" });
  env.db.addTag("U-fresh", "ของแจก: Prompt 50 แบบ", "human");
  env.db.upsertCustomer("U-gone", { channelId: "default" });
  env.db.addTag("U-gone", "ของแจก: Prompt 50 แบบ", "human");
  env.db.upsertCustomer("U-legacy", { channelId: "default" });
  env.db.addTag("U-legacy", "ย้ายจาก LINE OA", "human");
  env.db.addTag("U-legacy", "ของแจก: Prompt 50 แบบ", "human");
  await env.app.stepMessages.runOnce();
  const enrolled = env.db.raw.prepare("SELECT customer_id FROM step_enrollments WHERE sequence_id = ? AND status = 'active' ORDER BY customer_id").all(id);
  assert.deepEqual(enrolled.map((r) => r.customer_id), ["U-fresh", "U-gone"], "ห้องประวัติจาก OA เดิมไม่เข้าลำดับ (ส่งไม่ถึง)");
  env.db.removeTag("U-gone", "ของแจก: Prompt 50 แบบ");
  env.advance(2 * HOUR);
  await env.app.stepMessages.runOnce();
  assert.equal(env.db.raw.prepare("SELECT stop_reason FROM step_enrollments WHERE customer_id = 'U-gone'").get().stop_reason, "left_segment");
  assert.equal(env.stub.pushes().length, 1, "U-fresh ได้ขั้น 1 คนเดียว");
});

test("คีย์เวิร์ด: ลูกค้าพิมพ์ #ของแจก ผ่าน webhook = เข้าลำดับ", async (t) => {
  const env = await start(t);
  const { id } = await createAndActivate(env, { name: "คีย์เวิร์ดของแจก", triggerType: "keyword", triggerValue: "ของแจก", steps: TWO_STEPS });
  await webhook(env.app.server, {
    type: "message", webhookEventId: "m-kw", replyToken: "rt-kw", source: { type: "user", userId: "U-kw" },
    message: { id: "msg-kw", type: "text", text: "ขอรับ #ของแจกค่ะ" },
  });
  await webhook(env.app.server, {
    type: "message", webhookEventId: "m-nokw", replyToken: "rt-nokw", source: { type: "user", userId: "U-nokw" },
    message: { id: "msg-nokw", type: "text", text: "ขอรับของแจกค่ะ" },
  });
  const rows = env.db.raw.prepare("SELECT customer_id FROM step_enrollments WHERE sequence_id = ?").all(id);
  assert.deepEqual(rows.map((r) => r.customer_id), ["U-kw"]);
});

test("ผลส่งไม่ชัด = หยุดคนนั้น ไม่ส่งซ้ำ · 429 = ถอดด่านแล้วเลื่อน · ตัวกันราคาไม่ผ่านตอนส่ง = พักทั้งลำดับ", async (t) => {
  let mode = 503;
  const env = await start(t, { stub: lineStub({ push: () => mode }) });
  const { id } = await createAndActivate(env, { name: "ต้อนรับ", triggerType: "follow", steps: TWO_STEPS });
  await webhook(env.app.server, followEvent("U-ambiguous"));
  env.advance(HOUR + 1);
  await env.app.stepMessages.runOnce();
  const first = { ...env.db.raw.prepare("SELECT status, stop_reason FROM step_enrollments WHERE customer_id = 'U-ambiguous'").get() };
  assert.deepEqual(first, { status: "stopped", stop_reason: "delivery_unknown" });
  assert.equal(env.db.raw.prepare("SELECT status FROM step_deliveries WHERE customer_id = 'U-ambiguous'").get().status, "unknown");
  env.advance(DAY);
  await env.app.stepMessages.runOnce();
  assert.equal(env.stub.pushes().length, 1, "ไม่ส่งซ้ำอัตโนมัติ");
  const [stat] = env.db.stepSequenceStats(env.db.getStepSequence(id)).steps;
  assert.deepEqual([stat.entered, stat.failed, stat.stopped], [1, 1, 1], "คนเดียว = เข้าขั้น 1 ครั้ง (ไม่นับซ้ำ)");

  mode = 429;
  await webhook(env.app.server, followEvent("U-limited"));
  env.advance(HOUR + 1);
  await env.app.stepMessages.runOnce();
  const limited = { ...env.db.raw.prepare("SELECT status, defer_reason FROM step_enrollments WHERE customer_id = 'U-limited'").get() };
  assert.deepEqual(limited, { status: "active", defer_reason: "rate_limited" });
  assert.equal(env.db.raw.prepare("SELECT COUNT(*) AS n FROM step_deliveries WHERE customer_id = 'U-limited'").get().n, 0, "ด่านถูกถอด ลองใหม่ได้");

  mode = 200;
  env.db.raw.prepare("DELETE FROM approved_prices").run();
  env.db.raw.prepare("UPDATE step_sequences SET steps_json = ? WHERE id = ?").run(JSON.stringify([
    { delay: { kind: "hours", hours: 1 }, messages: [{ type: "text", text: "ราคาพิเศษเหลือ 4,900 บาทค่ะ" }] },
  ]), id);
  env.advance(2 * HOUR);
  await env.app.stepMessages.runOnce();
  assert.equal(env.db.getStepSequence(id).status, "paused", "ข้อความไม่ผ่านตัวกันราคา = พักลำดับให้คนแก้");
  assert.equal(env.db.raw.prepare("SELECT stop_reason FROM step_enrollments WHERE customer_id = 'U-limited'").get().stop_reason, "guard_blocked");
});

test("ออเดอร์ชำระแล้ว: ส่งถึงคนที่ซื้อ (ปิด AI ด้วยป้าย customer ไม่นับเป็นทีมรับห้อง) · ขั้นที่มีเงื่อนไขป้ายข้ามได้ · ปิด AI เหตุอื่น = หยุด", async (t) => {
  const env = await start(t);
  for (const id of ["U-paid", "U-takeover", "U-old-buyer"]) env.db.upsertCustomer(id, { channelId: "default" });
  const oldOrder = env.db.createOrder({ customerId: "U-old-buyer", status: "confirmed" });
  env.db.setOrderStatus(oldOrder.id, "confirmed", "paid");
  env.advance(60_000);
  const { id } = await createAndActivate(env, { name: "เตรียมเรียน", triggerType: "order_paid", steps: [
    { delay: { kind: "hours", hours: 1 }, condition: { hasTags: ["รอบ: ตุลา"] }, messages: [{ type: "text", text: "ข้อมูลรอบเดือนตุลาค่ะ" }] },
    { delay: { kind: "hours", hours: 2 }, messages: [{ type: "text", text: "เอกสารเตรียมเรียนค่ะ" }] },
  ] });
  env.advance(60_000);
  for (const customerId of ["U-paid", "U-takeover"]) {
    const order = env.db.createOrder({ customerId, status: "confirmed" });
    assert.ok(env.db.setOrderStatus(order.id, "confirmed", "paid"));
  }
  assert.equal(addCustomerTag({ db: env.db, customerId: "U-paid", tag: "customer", operator: "owner" }).aiSilenced, true);
  env.db.setAiEnabled("U-takeover", false, "operator_took_over");
  await env.app.stepMessages.runOnce();
  const status = (customerId) => env.db.raw.prepare("SELECT status, stop_reason, next_step FROM step_enrollments WHERE customer_id = ?").get(customerId);
  assert.equal(status("U-old-buyer").status, "baseline", "ซื้อก่อนเปิดใช้ = ไม่ได้รับย้อนหลัง");
  env.advance(HOUR + 60_000);
  await env.app.stepMessages.runOnce();
  assert.equal(status("U-takeover").stop_reason, "human_takeover");
  assert.equal(status("U-paid").next_step, 1, "ไม่มีป้ายรอบตุลา = ข้ามขั้น 1");
  assert.equal(env.stub.pushes().length, 0);
  env.advance(2 * HOUR + 60_000);
  await env.app.stepMessages.runOnce();
  const pushes = env.stub.pushes();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.messages[0].text, "เอกสารเตรียมเรียนค่ะ");
  assert.equal(status("U-paid").status, "completed");
  const stats = env.db.stepSequenceStats(env.db.getStepSequence(id)).steps;
  assert.deepEqual(stats.map((s) => [s.step, s.skipped, s.sent]), [[1, 1, 0], [2, 0, 1]]);
});

test("รีวิวโค้ด: โปรเซสตายกลางการส่ง (แถว sending ค้าง) = ไม่ส่งซ้ำ — ใหม่กว่า 10 นาทีถูกด่านกัน · เก่ากว่านั้นถูกกู้เป็น unknown", async (t) => {
  const env = await start(t);
  const { id } = await createAndActivate(env, { name: "ต้อนรับ", triggerType: "follow", steps: TWO_STEPS });
  await webhook(env.app.server, followEvent("U-crash-new"));
  await webhook(env.app.server, followEvent("U-crash-old"));
  env.advance(HOUR + 1);
  // จำลองโปรเซสที่ตายหลังลงด่านแต่ก่อนรู้ผล LINE: แถว sending ค้าง + lease ของคนนั้นหมดอายุแล้ว
  const enrollmentOf = (customerId) => env.db.raw.prepare("SELECT id FROM step_enrollments WHERE customer_id = ?").get(customerId).id;
  for (const [customerId, age] of [["U-crash-new", 60_000], ["U-crash-old", 11 * 60_000]]) {
    env.db.raw.prepare(`INSERT INTO step_deliveries (enrollment_id, sequence_id, step_no, customer_id, status, created_at, updated_at)
      VALUES (?, ?, 0, ?, 'sending', ?, ?)`).run(enrollmentOf(customerId), id, customerId, env.at() - age, env.at() - age);
  }
  await env.app.stepMessages.runOnce();
  assert.equal(env.stub.pushes().length, 0, "ไม่มีใครได้ขั้น 1 ซ้ำ");
  const row = (customerId) => ({ ...env.db.raw.prepare("SELECT status, stop_reason FROM step_enrollments WHERE customer_id = ?").get(customerId) });
  assert.deepEqual(row("U-crash-new"), { status: "stopped", stop_reason: "delivery_fenced" });
  assert.deepEqual(row("U-crash-old"), { status: "stopped", stop_reason: "delivery_unknown" });
  assert.equal(env.db.raw.prepare("SELECT status FROM step_deliveries WHERE customer_id = 'U-crash-old'").get().status, "unknown");
});

test("รีวิวโค้ด: ห้อง canary ไม่เข้าลำดับออเดอร์ชำระแล้ว · ช่อง Facebook สร้าง/เปิดใช้ลำดับไม่ได้", async (t) => {
  const env = await start(t, { configEnv: { FB_ENABLED: "true", FB_MOCK_URL: "http://facebook.mock", FB_APP_SECRET: "fb-app-secret", FB_PAGE_ACCESS_TOKEN: "fb-page-token" } });
  const { id } = await createAndActivate(env, { name: "เตรียมเรียน", triggerType: "order_paid", steps: TWO_STEPS });
  env.advance(60_000);
  env.db.upsertCustomer("canary:self-test", { channelId: "default" });
  env.db.raw.prepare(`INSERT INTO orders (id, customer_id, channel_id, items_json, status, created_at, updated_at)
    VALUES ('order-canary', 'canary:self-test', 'default', '[]', 'paid', ?, ?)`).run(env.at(), env.at());
  await env.app.stepMessages.runOnce();
  assert.equal(env.db.raw.prepare("SELECT COUNT(*) AS n FROM step_enrollments WHERE sequence_id = ? AND status <> 'baseline'").get(id).n, 0);
  // หน้าบรอดแคสต์ตัดช่อง Facebook ออกจากรายการสิทธิ์อยู่แล้ว (403) · API ของลำดับกันซ้ำอีกชั้น (400) — ทางไหนก็ต้องไม่เกิดลำดับ
  const facebook = await post(env.app.server, "/console/api/broadcast/steps", env.auth, { channelId: "facebook", name: "FB", triggerType: "follow", steps: TWO_STEPS });
  assert.ok([400, 403].includes(facebook.status), facebook.text);
  assert.equal(env.db.raw.prepare("SELECT COUNT(*) AS n FROM step_sequences WHERE channel_id = 'facebook'").get().n, 0);
});

test("สวิตช์รวม off = ไม่รับคนใหม่และไม่ส่ง · เปิดใช้ต้องพิมพ์ยืนยัน + ใบยืนยันผูกเวอร์ชัน · แก้ได้เฉพาะตอนพัก", async (t) => {
  const env = await start(t);
  const created = await post(env.app.server, "/console/api/broadcast/steps", env.auth, { channelId: "default", name: "ชุด", triggerType: "follow", steps: TWO_STEPS });
  const id = created.json.sequence.id;
  const preview = await post(env.app.server, `/console/api/broadcast/steps/${id}/preview`, env.auth, {});
  const wrongWord = await post(env.app.server, `/console/api/broadcast/steps/${id}/activate`, env.auth, { confirm: true, confirmText: "ok", confirmation: preview.json.confirmation });
  assert.equal(wrongWord.status, 400);
  await post(env.app.server, `/console/api/broadcast/steps/${id}`, env.auth, { name: "ชุดแก้แล้ว", triggerType: "follow", steps: TWO_STEPS });
  const stale = await post(env.app.server, `/console/api/broadcast/steps/${id}/activate`, env.auth, { confirm: true, confirmText: "เปิดใช้", confirmation: preview.json.confirmation });
  assert.equal(stale.status, 400, "แก้หลังตรวจ = ใบยืนยันเดิมใช้ไม่ได้");
  const fresh = await post(env.app.server, `/console/api/broadcast/steps/${id}/preview`, env.auth, {});
  const ok = await post(env.app.server, `/console/api/broadcast/steps/${id}/activate`, env.auth, { confirm: true, confirmText: "เปิดใช้", confirmation: fresh.json.confirmation });
  assert.equal(ok.status, 200, ok.text);
  const editActive = await post(env.app.server, `/console/api/broadcast/steps/${id}`, env.auth, { name: "x", triggerType: "follow", steps: TWO_STEPS });
  assert.equal(editActive.status, 409, "ลำดับที่ทำงานอยู่ต้องพักก่อนแก้");

  env.db.setSetting("step_messages_mode", "off");
  await webhook(env.app.server, followEvent("U-off"));
  assert.equal(env.db.raw.prepare("SELECT COUNT(*) AS n FROM step_enrollments WHERE customer_id = 'U-off'").get().n, 0);
  env.db.setSetting("step_messages_mode", "on");
  await webhook(env.app.server, followEvent("U-on", "on"));
  env.db.setSetting("step_messages_mode", "off");
  env.advance(2 * HOUR);
  assert.deepEqual(await env.app.stepMessages.runOnce(), { skipped: "mode_off" });
  assert.equal(env.stub.pushes().length, 0);
  const list = await httpRequest(env.app.server, { path: "/console/api/broadcast/steps?channel=default", headers: { cookie: env.auth.cookie } });
  assert.equal(list.json.mode, "off");
  assert.equal(list.json.canToggleMode, true);

  const archived = await post(env.app.server, `/console/api/broadcast/steps/${id}/archive`, env.auth, { confirm: true });
  assert.equal(archived.status, 200);
  assert.equal(env.db.raw.prepare("SELECT stop_reason FROM step_enrollments WHERE customer_id = 'U-on'").get().stop_reason, "sequence_archived");
});

test("PDPA: ลืมลูกค้า = ลบคนในลำดับและประวัติการส่งขั้นของคนนั้น", async (t) => {
  const env = await start(t);
  await createAndActivate(env, { name: "ต้อนรับ", triggerType: "follow", steps: TWO_STEPS });
  await webhook(env.app.server, followEvent("U-forget"));
  env.advance(HOUR + 1);
  await env.app.stepMessages.runOnce();
  assert.equal(env.db.raw.prepare("SELECT COUNT(*) AS n FROM step_deliveries WHERE customer_id = 'U-forget'").get().n, 1);
  env.db.resetCustomer("U-forget", { forget: true });
  for (const table of ["step_deliveries", "step_enrollments", "line_follow_state"]) {
    assert.equal(env.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE customer_id = 'U-forget'`).get().n, 0, table);
  }
});
