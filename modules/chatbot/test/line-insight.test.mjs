// line-insight — ดึงสถิติทางการรายวันของ LINE (Get number of message deliveries) มาเก็บ (28 ก.ย. 2026)
// ยืนยัน: วันของ LINE เป็นเวลาญี่ปุ่น · เติมย้อนทั้งเดือนแบบไม่ชนเพดาน 60 คำขอ/ชม. · ยังไม่พร้อม/ล้ม = จดแล้วรอรอบหน้า
// ตัวเลขแปลก ๆ จาก LINE ไม่หลุดเข้าฐาน · ภาพโควตาถูกเก็บให้แชทเจ้าของอ่าน
import test from "node:test";
import assert from "node:assert/strict";
import { createLineClient } from "../src/lineClient.mjs";
import {
  INSIGHT_MAX_ATTEMPTS, MAX_REQUESTS_PER_RUN, QUOTA_SNAPSHOT_PREFIX,
  createLineInsightSync, insightDatesToFetch, jstDateKey, jstDayStartMs, lineChannelsOf,
} from "../src/lineInsight.mjs";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const HOUR = 3_600_000;
// 28 ก.ย. 2026 10:00 เวลาญี่ปุ่น
const NOW = Date.UTC(2026, 8, 28, 1, 0, 0);

test("วันของ LINE = เวลาญี่ปุ่น (เที่ยงคืนญี่ปุ่น = 15:00 UTC ของวันก่อน = 22:00 ไทย)", () => {
  assert.equal(jstDateKey(Date.UTC(2026, 8, 27, 14, 59, 59)), "20260927");
  assert.equal(jstDateKey(Date.UTC(2026, 8, 27, 15, 0, 0)), "20260928");
  assert.equal(jstDayStartMs("20260928"), Date.UTC(2026, 8, 27, 15, 0, 0));
});

test("วันที่ต้องยิง: เมื่อวานย้อนถึงต้นเดือน ใหม่สุดก่อน · ข้ามวันที่นิ่งแล้ว/เพิ่งลอง/ลองครบเพดาน", () => {
  const all = insightDatesToFetch({ nowMs: NOW });
  assert.equal(all[0], "20260927");
  assert.equal(all.at(-1), "20260901");
  assert.equal(all.length, 27);
  const rows = [
    { date: "20260927", status: "unready", attempts: 1, last_attempt_at: NOW - HOUR }, // เพิ่งลอง = รอก่อน
    { date: "20260926", status: "unready", attempts: 2, last_attempt_at: NOW - 4 * HOUR }, // ครบเวลาแล้ว = ลองใหม่
    { date: "20260925", status: "ready", attempts: 1, last_attempt_at: NOW - 30 * HOUR },
    { date: "20260924", status: "error", attempts: INSIGHT_MAX_ATTEMPTS, last_attempt_at: NOW - 30 * HOUR }, // พอแล้ว
    { date: "20260923", status: "out_of_service", attempts: 1, last_attempt_at: NOW - 30 * HOUR },
  ];
  const due = insightDatesToFetch({ nowMs: NOW, rows });
  assert.deepEqual(due.slice(0, 2), ["20260926", "20260922"]);
  assert.equal(due.length, 27 - 4);
});

test("วันที่ต้องยิง: ข้ามเดือนยังตามเก็บ 7 วันท้ายเดือนก่อน (วันที่ 30 ยังไม่นิ่งตอนขึ้นเดือนใหม่)", () => {
  const due = insightDatesToFetch({ nowMs: Date.UTC(2026, 9, 1, 1, 0, 0) });
  assert.deepEqual(due, ["20260930", "20260929", "20260928", "20260927", "20260926", "20260925", "20260924"]);
});

function insightFetch(responder) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method, auth: opts.headers?.authorization });
    return responder(String(url));
  };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("client: GET /v2/bot/insight/message/delivery?date= · เก็บเฉพาะตัวเลขจำนวนเต็มไม่ติดลบ", async () => {
  const fetchImpl = insightFetch(() => json(200, {
    status: "ready", broadcast: 5385, targeting: 522, chat: 40, apiPush: 17, apiReply: 900,
    weird: "12", negative: -3, fraction: 1.5, "bad key": 9, newFieldFromLine: 4,
  }));
  const client = createLineClient({ config: testConfig(), fetchImpl, logger: silent });
  const result = await client.getDeliveryInsight({ date: "20260927" });
  assert.equal(fetchImpl.calls[0].url, "http://line.mock/v2/bot/insight/message/delivery?date=20260927");
  assert.equal(fetchImpl.calls[0].method, "GET");
  assert.match(fetchImpl.calls[0].auth, /^Bearer /u);
  assert.deepEqual(result, {
    ok: true, status: "ready",
    counts: { broadcast: 5385, targeting: 522, chat: 40, apiPush: 17, apiReply: 900, newFieldFromLine: 4 },
  });
});

test("client: unready ไม่มีตัวเลข · 429/รูปผิด/วันที่ผิด = ok:false ไม่ throw · ปิด live = ไม่ยิง", async () => {
  const unready = createLineClient({ config: testConfig(), fetchImpl: insightFetch(() => json(200, { status: "unready" })), logger: silent });
  assert.deepEqual(await unready.getDeliveryInsight({ date: "20260927" }), { ok: true, status: "unready", counts: {} });
  const limited = createLineClient({ config: testConfig(), fetchImpl: insightFetch(() => json(429, {})), logger: silent });
  assert.deepEqual(await limited.getDeliveryInsight({ date: "20260927" }), { ok: false, httpStatus: 429, reason: "http_error" });
  const odd = createLineClient({ config: testConfig(), fetchImpl: insightFetch(() => json(200, { status: "done" })), logger: silent });
  assert.equal((await odd.getDeliveryInsight({ date: "20260927" })).reason, "bad_shape");
  const broken = createLineClient({ config: testConfig(), fetchImpl: async () => { throw new TypeError("fetch failed"); }, logger: silent });
  assert.equal((await broken.getDeliveryInsight({ date: "20260927" })).reason, "network_error");
  const never = insightFetch(() => json(200, { status: "ready" }));
  const guarded = createLineClient({ config: testConfig(), fetchImpl: never, logger: silent });
  assert.equal((await guarded.getDeliveryInsight({ date: "2026-09-27" })).reason, "invalid_date");
  const closed = createLineClient({ config: testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "false" }), fetchImpl: never, logger: silent });
  assert.equal((await closed.getDeliveryInsight({ date: "20260927" })).reason, "live_send_disabled");
  assert.equal(never.calls.length, 0);
});

// registry จำลอง: client ต่อ channel พร้อมบันทึกวันที่ที่ถูกขอ
function fakeRegistry(byChannel) {
  return {
    forChannel(id) {
      const spec = byChannel[id];
      return {
        async getDeliveryInsight({ date }) {
          spec.asked.push(date);
          return spec.insight(date);
        },
        async getQuota() { return spec.quota ?? null; },
      };
    },
  };
}

test("รอบดึง: ครั้งแรกขอไม่เกินเพดานต่อรอบ ใหม่สุดก่อน · รอบถัดไปเติมต่อ · เก็บภาพโควตา", async () => {
  let t = NOW;
  const db = memoryDb({ now: () => t });
  const spec = {
    asked: [],
    insight: (date) => (date === "20260927" ? { ok: true, status: "unready", counts: {} }
      : { ok: true, status: "ready", counts: { broadcast: 100, apiPush: Number(date.slice(6)) } }),
    quota: { type: "limited", value: 15000, totalUsage: 4210 },
  };
  const sync = createLineInsightSync({
    config: {}, db, channels: [{ id: "default", active: true }, { id: "facebook", provider: "facebook", active: true }],
    lineRegistry: fakeRegistry({ default: spec }), logger: silent, now: () => t,
  });
  const first = await sync.runOnce();
  assert.equal(first.channels, 1, "Facebook ไม่มีสถิตินี้ ต้องไม่ถูกขอ");
  assert.equal(spec.asked.length, MAX_REQUESTS_PER_RUN);
  assert.deepEqual(spec.asked.slice(0, 2), ["20260927", "20260926"]);
  assert.equal(first.ready, MAX_REQUESTS_PER_RUN - 1);
  assert.equal(first.unready, 1);
  const snapshot = JSON.parse(db.getSetting(`${QUOTA_SNAPSHOT_PREFIX}default`));
  assert.deepEqual({ ...snapshot, at: 0 }, { type: "limited", value: 15000, totalUsage: 4210, at: 0 });

  t += 10 * 60_000;
  spec.asked.length = 0;
  await sync.runOnce();
  // วันที่ ready แล้วและวันที่เพิ่งลองไม่ถูกขอซ้ำ — รอบสองเริ่มต่อจากวันที่รอบแรกไปไม่ถึง
  assert.equal(spec.asked[0], `202609${String(27 - MAX_REQUESTS_PER_RUN).padStart(2, "0")}`);
  const rows = db.lineInsightRows({ fromDate: "20260901", toDate: "20260930" });
  const firstReady = MAX_REQUESTS_PER_RUN - 1;
  assert.equal(rows.filter((row) => row.status === "ready").length, firstReady + Math.min(MAX_REQUESTS_PER_RUN, 27 - MAX_REQUESTS_PER_RUN));
  const unready = rows.find((row) => row.date === "20260927");
  assert.equal(unready.status, "unready");
  assert.equal(unready.attempts, 1);
});

test("รอบดึง: 429 = หยุด OA นั้นทั้งรอบและพักชั่วโมงหนึ่ง · ข้อผิดพลาดถูกจดเป็นแถว error", async () => {
  let t = NOW;
  const db = memoryDb({ now: () => t });
  const spec = { asked: [], insight: () => ({ ok: false, httpStatus: 429, reason: "http_error" }) };
  const sync = createLineInsightSync({ config: {}, db, channels: [{ id: "default", active: true }], lineRegistry: fakeRegistry({ default: spec }), logger: silent, now: () => t });
  const first = await sync.runOnce();
  assert.equal(spec.asked.length, 1);
  assert.equal(first.errors, 1);
  const [row] = db.lineInsightRows({ fromDate: "20260927", toDate: "20260927" });
  assert.equal(row.status, "error");
  assert.equal(row.error, "http_error_429");
  t += 30 * 60_000;
  const paused = await sync.runOnce();
  assert.equal(paused.paused, 1);
  assert.equal(spec.asked.length, 1, "ระหว่างพักห้ามยิงซ้ำ");
});

test("รอบดึง: token ไม่มี/ปิด live = ไม่จดแถวขยะ · ข้อผิดพลาดในรอบไม่โยนออกมา · รอบซ้อนกันไม่ได้", async () => {
  const db = memoryDb({ now: () => NOW });
  const spec = { asked: [], insight: () => ({ ok: false, httpStatus: 0, reason: "no_access_token" }) };
  const sync = createLineInsightSync({ config: {}, db, channels: [{ id: "default", active: true }], lineRegistry: fakeRegistry({ default: spec }), logger: silent, now: () => NOW });
  const summary = await sync.runOnce();
  assert.equal(summary.skipped, 1);
  assert.equal(db.lineInsightRows({ fromDate: "20260801", toDate: "20261231" }).length, 0);

  let release;
  const slow = { asked: [], insight: () => new Promise((resolve) => { release = () => resolve({ ok: true, status: "unready", counts: {} }); }) };
  const busy = createLineInsightSync({ config: {}, db, channels: [{ id: "default", active: true }], lineRegistry: fakeRegistry({ default: slow }), logger: silent, now: () => NOW });
  const running = busy.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await busy.runOnce(), { skipped: "run_in_flight" });
  release();
  // ปล่อยทุกคำขอที่เหลือในรอบนั้นให้จบ
  for (let i = 0; i < MAX_REQUESTS_PER_RUN; i += 1) { await new Promise((resolve) => setImmediate(resolve)); release?.(); }
  await running;

  const exploding = createLineInsightSync({
    config: {}, db, channels: [{ id: "default", active: true }], logger: silent, now: () => NOW,
    lineRegistry: { forChannel() { return { getDeliveryInsight() { throw new Error("boom"); } }; } },
  });
  const result = await exploding.runOnce();
  assert.equal(result.errors, 1);
});

test("arm เฉพาะ instance ที่ยิง LINE จริง (ไม่ใช่ mock) และ tick > 0 · เทสต์/dev ไม่ arm", () => {
  const channels = [{ id: "default", active: true }];
  const make = (config) => createLineInsightSync({ config, db: memoryDb(), channels, lineRegistry: fakeRegistry({}), logger: silent });
  assert.equal(make(testConfig()).armed(), false, "mock");
  assert.equal(make(testConfig()).start(), false);
  assert.equal(make(testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "true" })).armed(), true);
  assert.equal(make(testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "true", LINE_INSIGHT_TICK_MS: "0" })).armed(), false);
  assert.equal(testConfig({ LINE_INSIGHT_TICK_MS: "5" }).lineInsightTickMs, 600_000, "ขั้นต่ำ 10 นาที กันชนเพดาน 60 คำขอ/ชม.");
  const live = make(testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "true" }));
  assert.equal(live.start(), true);
  assert.equal(live.running, true);
  live.stop();
  assert.equal(live.running, false);
  assert.deepEqual(lineChannelsOf([{ id: "a" }, { id: "b", provider: "facebook" }, { id: "c", active: false }]).map((c) => c.id), ["a"]);
});

test("health บอกสถานะตัวดึงสถิติ (off ในเทสต์เพราะใช้ mock)", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { httpRequest, listen, lineFetchStub, hermesFetchStub } = await import("./helpers.mjs");
  const db = memoryDb();
  const app = createApp({ config: testConfig(), db, logger: silent, overrides: { lineFetch: lineFetchStub(), hermesFetch: hermesFetchStub(), sleep: async () => {} } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const res = await httpRequest(app.server, { path: "/health" });
  assert.equal(res.json.components.lineInsight, "off");
});
