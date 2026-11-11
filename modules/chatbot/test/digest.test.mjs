// G7.1 Owner Daily Digest — due-time math เวลาไทย, เนื้อหาจาก fixture ใน DB,
// zero-activity skip, fail-closed (ไม่มี user id / สวิตช์ปิด), sync lock กันซ้อน,
// สวิตช์ runtime ผ่าน console (CSRF+audit) — ทุกอย่าง mock ห้ามแตะ network จริง
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createLineRegistry } from "../src/lineClient.mjs";
import { loadChannels } from "../src/channels.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  createDigest, parseDigestTimes, latestSlotMs, previousSlotMs, bangkokHHMM,
  digestGlobalEnabled, buildDigestBubbles,
  DIGEST_LAST_SENT_KEY, DIGEST_LAST_SLOT_KEY,
} from "../src/digest.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// เวลาอ้างอิงแบบ fix เสมอ (Asia/Bangkok = UTC+7) — ห้ามพึ่งเวลาจริงของเครื่อง
const T2005_BKK = Date.UTC(2026, 7, 10, 13, 5, 0); // 20:05 เวลาไทย 2026-08-10
const T0830_BKK = Date.UTC(2026, 7, 10, 1, 30, 0); // 08:30 เวลาไทย (slot เช้า)
const T2000_BKK = Date.UTC(2026, 7, 10, 13, 0, 0); // 20:00 เวลาไทย (slot เย็น)
const T0700_BKK = Date.UTC(2026, 7, 10, 0, 0, 0); // 07:00 เวลาไทย (ก่อน slot แรกของวัน)
const OWNER = "Uowner-line-id";

const PRICING = [{ id: "gpt-test", label: "gpt-test", inUsdPerM: 1, outUsdPerM: 2, verified: true }];

function makeDigest({ configOverrides = {}, lineFetch, now = () => T2005_BKK, fx = null } = {}) {
  const config = testConfig({
    DIGEST_LINE_USER_ID: OWNER,
    DIGEST_ENABLED: "true",
    THB_PER_USD: "36",
    ...configOverrides,
  });
  // นาฬิกาเดียว: db ต้องเขียนแถวบนแกนเวลาเดียวกับที่ digest ใช้ตัดสิน slot/ช่วงสรุป
  // (fixture ยังปัก created_at เองได้ตามใจ — นั่นคือการกำหนดอายุ ไม่ใช่ปะนาฬิกาสองตัว)
  const db = memoryDb({ now });
  const stub = lineFetch ?? lineFetchStub({ quota: { type: "limited", value: 5000 }, consumption: { totalUsage: 300 } });
  const lineRegistry = createLineRegistry({
    config, channels: loadChannels(config, { logger: silent }),
    fetchImpl: stub, sleep: async () => {}, logger: silent,
  });
  const digest = createDigest({
    config, db, lineRegistry, modelPricing: PRICING, fx, logger: silent, now,
  });
  return { digest, db, config, lineFetch: stub };
}

// fixture กิจกรรมในช่วงสรุป (หลัง sinceMs) — คืนค่าที่คาดไว้สำหรับ assert เนื้อหา
function seedActivity(db, { sinceMs }) {
  const t = sinceMs + 60_000;
  db.upsertCustomer("U-new", {});
  db.upsertCustomer("U-hot", {});
  db.setKnownName("U-hot", "โบว์");
  db.insertMessage({ customerId: "U-new", direction: "in", content: "สนใจเครื่องฟอกค่ะ" });
  db.insertMessage({ customerId: "U-hot", direction: "in", content: "โอนวันนี้ได้เลยค่ะ" });
  db.insertMessage({ customerId: "U-hot", direction: "in", content: "ขอเลขบัญชีด้วยนะคะ" });
  db.recordScore("U-hot", 9, JSON.stringify({
    score: 9, trend: "up", buying_signals: ["นัดโอน"],
    persona_read: { disc: "D", bank: "Action", reason: "พร้อมปิด" },
    next_move: "ส่งเลขบัญชีที่ approve แล้วนัดเวลาโอนเลย", suggested_question: "",
  }));
  db.setNeedsHuman("U-new", "image_review", "ลูกค้าส่งรูป");
  db.addSlipCheck({ customerId: "U-hot", messageId: "m-slip", status: "suspect", amount: 100 });
  const order = db.createOrder({ customerId: "U-hot", items: [{ name: "X5Pro", qty: 1, price: 2500 }], total: 2500, createdBy: "ai" });
  db.setOrderStatus(order.id, "draft", "confirmed");
  db.addLlmUsage({ customerId: "U-hot", kind: "draft", model: "gpt-test", tokensIn: 1_000_000, tokensOut: 500_000 });
  // ดันทุก timestamp เข้า "ช่วงสรุป" + วันนี้ (เวลาไทย) แบบ deterministic
  db.raw.prepare("UPDATE messages SET created_at = ?").run(t);
  db.raw.prepare("UPDATE customers SET created_at = ?, updated_at = ?").run(t, t);
  db.raw.prepare("UPDATE slip_checks SET created_at = ?").run(t);
  db.raw.prepare("UPDATE orders SET created_at = ?, updated_at = ?").run(t, t);
  db.raw.prepare("UPDATE llm_usage SET created_at = ?").run(t);
  // llm_usage 1M in @$1 + 0.5M out @$2 = $2 = ฿72 (rate 36)
  return { expectedCostThb: 72 };
}

/* ------------------------------ due-time math ------------------------------ */

test("digest: parseDigestTimes — ชุดดี/ปนขยะ/ซ้ำ/ว่าง", () => {
  assert.deepEqual(parseDigestTimes("08:30,20:00"), [8 * 60 + 30, 20 * 60]);
  assert.deepEqual(parseDigestTimes(" 20:00 , 08:30 ,08:30"), [8 * 60 + 30, 20 * 60], "trim + dedupe + sort");
  assert.deepEqual(parseDigestTimes("8:30,25:00,abc,12:60"), [], "รูปแบบผิดทุกตัว = ว่าง");
  assert.deepEqual(parseDigestTimes("bad,09:15"), [9 * 60 + 15], "ตัวดีรอด ตัวเสียถูกข้าม");
  assert.deepEqual(parseDigestTimes(""), []);
});

test("digest: latestSlotMs เวลาไทย — ก่อน/หลัง slot วันนี้ + ข้ามไปเมื่อวาน", () => {
  const times = parseDigestTimes("08:30,20:00");
  assert.equal(latestSlotMs(T2005_BKK, times), T2000_BKK, "20:05 -> slot 20:00 วันนี้");
  assert.equal(latestSlotMs(T0830_BKK, times), T0830_BKK, "ตรง 08:30 พอดี = slot 08:30");
  assert.equal(latestSlotMs(T0700_BKK, times), T2000_BKK - 86_400_000, "07:00 -> slot 20:00 เมื่อวาน");
  assert.equal(previousSlotMs(T2000_BKK, times), T0830_BKK, "slot ก่อน 20:00 คือ 08:30 วันเดียวกัน");
  assert.equal(latestSlotMs(T2005_BKK, []), null);
  assert.equal(bangkokHHMM(T2000_BKK), "20:00");
  assert.equal(bangkokHHMM(T0830_BKK), "08:30");
});

test("digest: global switch — DB runtime ชนะ env, DB พัง = ปิด (fail-closed)", () => {
  const db = memoryDb();
  assert.equal(digestGlobalEnabled({ db, config: { digestEnabled: true } }), true);
  assert.equal(digestGlobalEnabled({ db, config: { digestEnabled: false } }), false);
  db.setSetting("digest_enabled", "0");
  assert.equal(digestGlobalEnabled({ db, config: { digestEnabled: true } }), false, "DB '0' ชนะ env true");
  db.setSetting("digest_enabled", "1");
  assert.equal(digestGlobalEnabled({ db, config: { digestEnabled: false } }), true, "DB '1' ชนะ env false");
  db.close();
  const broken = { getSetting() { throw new Error("db down"); } };
  assert.equal(digestGlobalEnabled({ db: broken, config: { digestEnabled: true } }), false);
});

/* ------------------------------- fail-closed ------------------------------- */

test("digest: ไม่มี DIGEST_LINE_USER_ID = ปิดสนิท (สวิตช์เปิดก็ไม่ส่ง) + ไม่ arm scheduler", async () => {
  const { digest, db, lineFetch } = makeDigest({ configOverrides: { DIGEST_LINE_USER_ID: "" } });
  db.setSetting("digest_enabled", "1");
  const result = await digest.runDue();
  assert.deepEqual(result, { skipped: true, reason: "no_user" });
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(digest.start(), false, "ไม่มีปลายทาง = ไม่ arm interval");
  db.close();
});

test("digest: สวิตช์ปิด (env default false + ไม่มี runtime override) = ไม่ส่ง", async () => {
  const { digest, db, lineFetch } = makeDigest({ configOverrides: { DIGEST_ENABLED: "false" } });
  const result = await digest.runDue();
  assert.deepEqual(result, { skipped: true, reason: "digest_disabled" });
  assert.equal(lineFetch.sends.length, 0);
  db.close();
});

test("digest: DIGEST_TIMES ขยะทั้งหมด = ไม่ส่ง (no_valid_times)", async () => {
  const { digest, db, lineFetch } = makeDigest({ configOverrides: { DIGEST_TIMES: "junk" } });
  const result = await digest.runDue();
  assert.deepEqual(result, { skipped: true, reason: "no_valid_times" });
  assert.equal(lineFetch.sends.length, 0);
  db.close();
});

/* ------------------------------ ส่งจริง + เนื้อหา ------------------------------ */

test("suggestion OFF: digest retains score/activity but omits historical next_move", async t => {
  const { digest, db, lineFetch } = makeDigest();
  t.after(() => db.close());
  seedActivity(db, { sinceMs: T0830_BKK });
  const result = await digest.runDue();
  assert.equal(result.sent, true);
  const text = lineFetch.sends.flatMap(c => c.body.messages.map(m => m.text)).join("\n");
  assert.match(text, /แชทเข้า 3 ข้อความ จาก 2 คน/);
  assert.doesNotMatch(text, /ส่งเลขบัญชีที่ approve แล้วนัดเวลาโอนเลย/);
});

test("digest: fixture ครบ -> push ถึงเจ้าของ, ตัวเลขตรง DB, <=5 bubbles, audit + last_sent", async () => {
  const { digest, db, lineFetch } = makeDigest();
  db.setSetting("scorer_suggestions_enabled", "1"); // This fixture includes optional advice.
  const { expectedCostThb } = seedActivity(db, { sinceMs: T0830_BKK });

  const result = await digest.runDue();
  assert.equal(result.sent, true);
  assert.equal(result.slot, T2000_BKK, "slot = 20:00 วันนี้");
  assert.ok(result.bubbles <= 5);

  // ยิงเป็น push ถึง LINE user id ของเจ้าของ (ไม่ใช่ reply)
  assert.ok(lineFetch.sends.length >= 1);
  for (const call of lineFetch.sends) {
    assert.ok(call.url.endsWith("/v2/bot/message/push"));
    assert.equal(call.body.to, OWNER);
  }
  const text = lineFetch.sends.map((c) => c.body.messages.map((m) => m.text).join("\n")).join("\n");
  assert.ok(text.includes("วันนี้เป็นยังไง · 08:30-20:05"), `ช่วงสรุปต้องเป็นเวลาไทย: ${text}`);
  assert.ok(text.includes("แชทเข้า 3 ข้อความ จาก 2 คน"), text);
  assert.ok(text.includes("ลูกค้าใหม่ 2"), text);
  assert.ok(text.includes("สลิปน่าสงสัย 1"), text);  // ค่ำ: ขึ้นเป็นบรรทัดเตือนแยก
  assert.ok(text.includes("🔥 ควรตามต่อพรุ่งนี้"), text);
  assert.ok(text.includes("โบว์ (9/10)"), "hot ต้องมีชื่อ + score");
  assert.ok(text.includes("ส่งเลขบัญชีที่ approve แล้วนัดเวลาโอนเลย"), "next_move ต้องเข้า digest");
  // ยังไม่มีใครจ่ายวันนี้ = บอกตรง ๆ ว่ายังไม่ปิด แทนที่จะไล่ตัวเลขสามตัวให้ครบฟอร์ม
  assert.ok(text.includes("ยังไม่มีใครจ่ายวันนี้"), text);
  assert.ok(text.includes(`ค่า AI วันนี้ ฿${expectedCostThb}`), text);
  assert.ok(text.includes("โควตาคงเหลือ 4,700/5,000"), "quota คงเหลือ = value - totalUsage");

  // ห้ามปนตาราง messages (ข้อความถึงเจ้าของ ไม่ใช่ลูกค้า) — ร่องรอย = settings + audit
  assert.equal(db.messagesFor(OWNER).length, 0, "digest ห้าม insert ตาราง messages");
  assert.equal(db.getSetting(DIGEST_LAST_SENT_KEY), String(T2005_BKK));
  assert.equal(db.getSetting(DIGEST_LAST_SLOT_KEY), String(T2000_BKK));
  assert.ok(db.listAudit().some((a) => a.action === "digest_sent" && a.operator === "system"));

  // slot เดิมส่งแล้ว = รอบถัดไปข้าม (ครั้งเดียวต่อ slot)
  assert.deepEqual(await digest.runDue(), { skipped: true, reason: "not_due" });
  db.close();
});

test("digest: ลูกค้า canary ไม่ปนตัวเลข + hot ไม่มี = ไม่มี bubble 🔥", async () => {
  const { digest, db, lineFetch } = makeDigest();
  db.upsertCustomer("canary:synthetic", {});
  db.insertMessage({ customerId: "canary:synthetic", direction: "in", content: "[canary] ping" });
  db.upsertCustomer("U-real", {});
  db.insertMessage({ customerId: "U-real", direction: "in", content: "สวัสดีค่ะ" });
  db.raw.prepare("UPDATE messages SET created_at = ?").run(T0830_BKK + 60_000);
  db.raw.prepare("UPDATE customers SET created_at = ?, updated_at = ?").run(T0830_BKK + 60_000, T0830_BKK + 60_000);

  const result = await digest.runDue();
  assert.equal(result.sent, true);
  const text = lineFetch.sends.map((c) => c.body.messages.map((m) => m.text).join("\n")).join("\n");
  assert.ok(text.includes("แชทเข้า 1 ข้อความ จาก 1 คน"), `canary ต้องไม่ถูกนับ: ${text}`);
  assert.ok(text.includes("ลูกค้าใหม่ 1"), `canary ต้องไม่ถูกนับเป็นลูกค้าใหม่: ${text}`);
  assert.ok(!text.includes("🔥"), "ไม่มีลูกค้า hot = ไม่มี bubble ควรตามต่อ");
  db.close();
});

test("digest: ไม่มีความเคลื่อนไหว = ข้ามทั้งรอบ (skipped_no_activity) + mark slot กันเช็คซ้ำ", async () => {
  const { digest, db, lineFetch } = makeDigest();
  const first = await digest.runDue();
  assert.equal(first.skipped, true);
  assert.equal(first.reason, "no_activity");
  assert.equal(lineFetch.sends.length, 0, "zero activity ห้ามส่งอะไรเลย");
  assert.equal(db.getSetting(DIGEST_LAST_SLOT_KEY), String(T2000_BKK), "slot ถูก mark แม้ข้าม");
  assert.equal(db.getSetting(DIGEST_LAST_SENT_KEY), null, "last_sent ต้องไม่ขยับตอนข้าม — รอบหน้าสรุปช่วงยาวขึ้น");
  assert.deepEqual(await digest.runDue(), { skipped: true, reason: "not_due" });
  db.close();
});

test("digest: ช่วงสรุปเริ่มจาก digest ที่ส่งจริงครั้งก่อน (digest_last_sent)", async () => {
  const { digest, db, lineFetch } = makeDigest();
  db.setSetting(DIGEST_LAST_SENT_KEY, String(T0830_BKK));
  // กิจกรรม "ก่อน" last_sent = ต้องไม่ถูกนับ
  db.upsertCustomer("U-old", {});
  db.insertMessage({ customerId: "U-old", direction: "in", content: "ข้อความเก่า" });
  db.raw.prepare("UPDATE messages SET created_at = ?").run(T0830_BKK - 3_600_000);
  db.raw.prepare("UPDATE customers SET created_at = ?, updated_at = ?").run(T0830_BKK - 3_600_000, T0830_BKK - 3_600_000);
  // กิจกรรมใหม่หลัง last_sent
  db.upsertCustomer("U-fresh", {});
  db.insertMessage({ customerId: "U-fresh", direction: "in", content: "ข้อความใหม่" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = 'U-fresh'").run(T0830_BKK + 60_000);
  db.raw.prepare("UPDATE customers SET created_at = ?, updated_at = ? WHERE line_user_id = 'U-fresh'")
    .run(T0830_BKK + 60_000, T0830_BKK + 60_000);

  const result = await digest.runDue();
  assert.equal(result.sent, true);
  const text = lineFetch.sends.map((c) => c.body.messages.map((m) => m.text).join("\n")).join("\n");
  assert.ok(text.includes("แชทเข้า 1 ข้อความ"), `ของเก่าก่อน last_sent ต้องไม่ปน: ${text}`);
  db.close();
});

/* ------------------------------ lock กันซ้อน ------------------------------ */

test("digest: sync lock — รอบก่อนยังไม่จบ = รอบใหม่ข้าม (run_in_flight)", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowFetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/v2/bot/message/quota")) {
      await gate; // ค้างรอบแรกไว้ตรง quota fetch
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { digest, db } = makeDigest({ lineFetch: Object.assign(slowFetch, { sends: [] }) });
  db.upsertCustomer("U-a", {});
  db.insertMessage({ customerId: "U-a", direction: "in", content: "x" });
  db.raw.prepare("UPDATE messages SET created_at = ?").run(T0830_BKK + 1000);
  db.raw.prepare("UPDATE customers SET created_at = ?, updated_at = ?").run(T0830_BKK + 1000, T0830_BKK + 1000);

  const first = digest.runDue(); // ไม่ await — ค้างอยู่ใน quota
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(digest.busy, true);
  assert.deepEqual(await digest.runDue(), { skipped: true, reason: "run_in_flight" });
  release();
  await first;
  assert.equal(digest.busy, false, "lock ต้องถูกปล่อยใน finally");
  db.close();
});

test("digest: start/stop — arm เมื่อมีปลายทาง, unref, stop เคลียร์ timer", () => {
  const { digest, db } = makeDigest();
  assert.equal(digest.running, false);
  assert.equal(digest.start(), true);
  assert.equal(digest.running, true);
  assert.equal(digest.start(), false, "arm ซ้ำไม่ได้");
  digest.stop();
  assert.equal(digest.running, false);
  db.close();
});

/* ------------------------- สวิตช์ runtime ผ่าน console ------------------------- */

const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";

async function startConsole(t, configOverrides = {}) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: CONSOLE_SECRET,
    DIGEST_LINE_USER_ID: OWNER,
    ...configOverrides,
  });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: hashPassword(PASSWORD), displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server) {
  const res = await postJson(server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(res.status, 200);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

test("digest settings: auth/CSRF ครบ + toggle เขียน DB + audit; /health โชว์ armed", async (t) => {
  const { app, db } = await startConsole(t);

  // deny by default
  assert.equal((await httpRequest(app.server, { path: "/console/api/settings/digest" })).status, 401);
  assert.equal((await postJson(app.server, "/console/api/settings/digest", { enabled: true })).status, 401);

  const { cookie, csrf } = await login(app.server);
  assert.equal(
    (await postJson(app.server, "/console/api/settings/digest", { enabled: true }, { cookie })).status,
    403, "ไม่มี CSRF = 403");

  const before = await httpRequest(app.server, { path: "/console/api/settings/digest", headers: { cookie } });
  assert.equal(before.status, 200);
  assert.equal(before.json.enabled, false, "env default = ปิด (fail-closed)");
  assert.equal(before.json.configured, true);
  assert.equal(before.json.times, "08:30,20:00");

  const flip = await postJson(app.server, "/console/api/settings/digest", { enabled: true }, { cookie, "x-csrf-token": csrf });
  assert.equal(flip.status, 200);
  assert.equal(flip.json.enabled, true);
  assert.equal(db.getSetting("digest_enabled"), "1");
  assert.ok(db.listAudit().some((a) => a.action === "digest_global_toggle" && a.detail === "on"));

  assert.equal(
    (await postJson(app.server, "/console/api/settings/digest", { enabled: "on" }, { cookie, "x-csrf-token": csrf })).status,
    400, "enabled ต้องเป็น boolean");

  const health = await httpRequest(app.server, { path: "/health" });
  assert.equal(health.json.components.digest, "armed");
});

test("digest settings: ไม่ตั้ง DIGEST_LINE_USER_ID -> configured=false + /health off", async (t) => {
  const { app } = await startConsole(t, { DIGEST_LINE_USER_ID: "" });
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/settings/digest", headers: { cookie } });
  assert.equal(res.json.configured, false);
  const health = await httpRequest(app.server, { path: "/health" });
  assert.equal(health.json.components.digest, "off");
});

/* ------------------------------ bubbles builder ------------------------------ */

test("digest: buildDigestBubbles การันตี <=5 bubbles + โควตาหลายสาขาแตกบรรทัด", () => {
  const bubbles = buildDigestBubbles({
    stats: { inbound: 1, inboundCustomers: 1, newCustomers: 0, needsHuman: 0, suspectSlips: 0 },
    orders: { created: 0, confirmed: 0, paid: 0, revenue: 0 },
    costThb: null,
    quotaLines: ["สาขา A: 100/500", "สาขา B: ไม่จำกัด"],
    hotLines: ["1. โบว์ (9/10)", "2. บี (8/10)", "3. ซี (8/10)"],
    sinceMs: T0830_BKK, nowMs: T2005_BKK,
  });
  assert.ok(bubbles.length <= 5);
  assert.ok(bubbles.every((b) => typeof b.text === "string" && b.text.length > 0));
  const all = bubbles.map((b) => b.text).join("\n");
  assert.ok(all.includes("สาขา A: 100/500"));
  assert.ok(all.includes("สาขา B: ไม่จำกัด"));
  assert.ok(all.includes("ค่า AI วันนี้ — (คำนวณไม่ได้)"), "cost คำนวณไม่ได้ ต้องโชว์ให้เห็น ไม่ใช่หายเงียบ");
});
