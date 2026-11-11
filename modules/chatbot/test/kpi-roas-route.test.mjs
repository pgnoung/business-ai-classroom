// kpi-roas-route — ยิงเส้น /console/api/kpi และ /console/api/roas ผ่าน HTTP จริงพร้อม session
//
// ทำไมต้องมีไฟล์นี้ (บทเรียนของจริง 1 ก.ย. 2026):
// เส้น kpi เขียน `now()` ไว้ทั้งที่ consoleSettingsApi.mjs ไม่ได้รับ now มาเป็น dependency
// ผลคือ 500 ทุกครั้งบนเครื่องจริงอยู่หลายสิบนาที แต่ไม่มีใครเห็น เพราะ:
//   1) เทสต์หน้าเว็บ (console-render-smoke) mock ชั้น api ไว้ จึงไม่เคยแตะ handler จริง
//   2) หน้าภาพรวมเรียกด้วย .catch(() => null) แล้วซ่อนการ์ดเงียบ ๆ เมื่อ API พัง
// เทสต์ชุดนี้จึงต้องยิงผ่าน HTTP จริง ไม่ mock handler และต้องเช็ค "รูปข้อมูล" ให้ตรง
// กับเงื่อนไขที่หน้าเว็บใช้ตัดสินใจแสดงการ์ด ไม่ใช่แค่ status 200
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";
import { qualifyHoldKey } from "../src/notQualified.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const PASSWORD = "operator-pass-123";

async function start(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: "test-console-secret-0123456789" });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: hashPassword(PASSWORD), displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const res = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: PASSWORD }),
  });
  assert.equal(res.status, 200, "login ต้องผ่านก่อน ไม่งั้นเทสต์ที่เหลือไม่มีความหมาย");
  return { app, db, cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0] };
}

const get = (server, path, cookie) => httpRequest(server, { path, headers: { cookie } });

test("GET /console/api/kpi: ตอบ 200 และรูปข้อมูลครบตามที่หน้าภาพรวมต้องใช้", async (t) => {
  const { app, db, cookie } = await start(t);
  db.upsertCustomer("U-1", {});
  db.insertMessage({ customerId: "U-1", direction: "in", msgType: "text", content: "สนใจคลาสค่ะ" });
  db.insertMessage({ customerId: "U-1", direction: "out", msgType: "text", content: "ยินดีค่ะ", agentMode: "ai" });

  const res = await get(app.server, "/console/api/kpi?days=7", cookie);
  assert.equal(res.status, 200, `ต้องไม่ 500 — ได้ ${JSON.stringify(res.json)}`);
  const kpi = res.json;
  // เงื่อนไขชุดนี้ลอกมาจาก kpiPanel() ใน public/console/overview.mjs ตรง ๆ
  // ถ้าข้อไหนหลุด การ์ดบนหน้าภาพรวมจะหายเงียบโดยไม่มี error ให้เห็น
  assert.equal(kpi.ok, true);
  assert.ok(kpi.speed?.workingDays, "ต้องมี speed.workingDays");
  assert.ok(kpi.speed?.all && kpi.speed?.workingHours, "หน้าผลงานใช้อีกสองชุดนี้");
  assert.ok(kpi.backlog, "ต้องมี backlog");
  assert.ok(kpi.closing, "ต้องมี closing");
  assert.ok(kpi.days, "ต้องมี days");
  assert.ok(kpi.window?.attributionStartMs != null, "หน้าผลงานโชว์วันเริ่มนับ");
  assert.ok(Array.isArray(kpi.holidays), "ช่องวันหยุดต้องเป็นอาร์เรย์เสมอ");
  // พี่ง้วงสั่งให้เทียบ Hybrid กับลูกแพรล้วน — สองก้อนนี้ต้องมีเสมอ
  assert.ok(kpi.closing.hybrid && kpi.closing.fullyAi, "ต้องมีทั้ง hybrid และ fullyAi");
});

test("GET /console/api/kpi: ทุกช่วงวันที่หน้าเว็บมีปุ่มให้กด ต้องไม่พัง", async (t) => {
  const { app, cookie } = await start(t);
  for (const days of [7, 14, 30, 90]) {
    const res = await get(app.server, `/console/api/kpi?days=${days}`, cookie);
    assert.equal(res.status, 200, `days=${days} ต้องไม่พัง`);
    assert.equal(res.json.window.days, days);
  }
  // ค่าเพี้ยนต้องถูกบีบเข้าในช่วง ไม่ใช่ 500
  const zero = await get(app.server, "/console/api/kpi?days=0", cookie);
  assert.equal(zero.status, 200);
  const huge = await get(app.server, "/console/api/kpi?days=99999", cookie);
  assert.equal(huge.status, 200);
  assert.ok(huge.json.window.days <= 90);
});

// รีวิวปรปักษ์ 5 ต.ค. #20 (ต่อสายตอนรวมงาน): summarizeKpi ตัดห้องเหลืองได้เฉพาะเมื่อได้ค่าหมุด qualify_hold
// เส้นจริงเคยไม่ส่งค่านี้ = ห้องเหลืองนิ่งที่ตัวกวาดยืนยันแล้วนับเป็นงานค้างของทีมทุกห้อง (ไม่ตรงกับคิวรอตอบ)
test("GET /console/api/kpi: ห้องเหลืองที่ตัวกวาดยืนยันแล้วไม่นับ backlog · ห้องเหลืองไม่มีหมุด/หมุดเก่ากว่าข้อความ = นับ", async (t) => {
  const { app, db, cookie } = await start(t);
  db.upsertCustomer("U-1", {});
  db.insertMessage({ customerId: "U-1", direction: "in", msgType: "text", content: "สนใจคลาสค่ะ" });
  db.insertMessage({ customerId: "U-1", direction: "out", msgType: "text", content: "ยินดีค่ะ", agentMode: "ai" });
  for (const id of ["U-y-hold", "U-y-nohold", "U-y-stale"]) {
    db.upsertCustomer(id, {});
    db.insertMessage({ customerId: id, direction: "in", msgType: "text", content: "ตกงานอยู่ค่ะ" });
    db.setAiEnabled(id, false, "not_qualified");
  }
  db.setSetting(qualifyHoldKey("U-y-hold"), String(Date.now() + 60_000));
  db.setSetting(qualifyHoldKey("U-y-stale"), "1");

  const res = await get(app.server, "/console/api/kpi?days=7", cookie);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.backlog.excluded.notQualifiedRooms, 1);
  const top = res.json.backlog.top.map((item) => item.customerId);
  assert.ok(!top.includes("U-y-hold"), "ยืนยันแล้ว = ไม่ใช่งานค้างของทีม");
  for (const id of ["U-y-nohold", "U-y-stale"]) assert.ok(top.includes(id), `${id} ต้องอยู่ใน backlog`);
});

test("GET /console/api/roas: ตอบ 200 และรูปข้อมูลครบตามที่หน้าภาพรวมต้องใช้", async (t) => {
  const { app, cookie } = await start(t);
  const res = await get(app.server, "/console/api/roas?days=30", cookie);
  assert.equal(res.status, 200, `ต้องไม่ 500 — ได้ ${JSON.stringify(res.json)}`);
  const r = res.json;
  // ลอกมาจาก roasPanel() ใน public/console/overview.mjs
  assert.equal(r.ok, true);
  assert.ok(r.window, "ต้องมี window");
  assert.ok(r.costs, "ต้องมี costs");
  assert.ok(r.line, "ต้องมี line");
  assert.ok(Array.isArray(r.missing), "missing ต้องเป็นอาร์เรย์เสมอ");
});

test("ไม่มี session: ทั้งสองเส้นตอบ 401 ไม่ใช่ 500 และไม่รั่วข้อมูล", async (t) => {
  const { app } = await start(t);
  for (const path of ["/console/api/kpi?days=7", "/console/api/roas?days=30"]) {
    const res = await httpRequest(app.server, { path });
    assert.equal(res.status, 401, path);
    assert.ok(!res.json.speed && !res.json.costs, "ห้ามมีข้อมูลติดมากับ 401");
  }
});

/* ---- ค่าแอด: ห้ามเดาเมื่อข้อมูลรายวันไม่ครบช่วง (เคสจริง 2 ก.ย. 2026) ----
 *
 * พี่ง้วงเปิดคอนโซลเลือก "วันนี้" แล้วเห็นค่าแอด ฿3,344 ทั้งที่ Ads Manager บอก ฿1,319
 * ต้นเหตุ: Make ยิงค่าแอดของ "เมื่อวาน" ตอน 05:00 วันนี้จึงยังไม่มีแถว ระบบเลยตกกลับไป
 * ใช้ตัวเลขที่กรอกมือไว้ตอนยังไม่มีระบบอัตโนมัติ (฿100,315 ÷ 30 วัน = ฿3,343.86)
 *
 * และอีกทางที่อันตรายกว่า: ช่วง 30 วันมีข้อมูลจริงแค่ 2 วัน ของเดิมเอา 2 วันนั้นมาเป็น
 * ค่าแอดทั้ง 30 วัน = ต้นทุนต่ำเกินจริง = ROAS สูงเกินจริงหลายเท่า ซึ่งเป็นทิศที่
 * อันตรายที่สุด เพราะเอาไปตัดสินใจเพิ่มงบแอด
 *
 * กติกาใหม่: ครบทุกวัน = ใช้ยอดจริง / ไม่ครบแต่ท่อเดินแล้ว = ไม่สรุป (null) พร้อมบอกเหตุผล
 * / ยังไม่เคยมีข้อมูลอัตโนมัติเลย = ใช้ค่ากรอกมือเหมือนเดิม
 */
const ADS_KEY = "cost_ads_thb";

test("ค่าแอด: มีข้อมูลรายวันบางวันในช่วง 30 วัน = ไม่สรุปตัวเลข ไม่ใช่เอาเฉพาะวันที่มีมาแทนทั้งช่วง", async (t) => {
  const { app, db, cookie } = await start(t);
  db.setSetting(ADS_KEY, "100000");
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  db.upsertAdsSpend({ day: today, spendThb: 1000, accountId: "act_1", source: "make", raw: "{}" });

  const res = await get(app.server, "/console/api/roas?days=30", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.json.costs.adsThb, null, "2 วันจาก 30 สรุปไม่ได้ ห้ามเดา");
  assert.ok(res.json.missing.includes("ค่าแอด"), "ต้องบอกว่าขาดค่าแอด");
  assert.equal(res.json.roas, null, "ขาดต้นทุน = ห้ามโชว์ ROAS ที่ผิด");
  assert.ok(res.json.ads.reason, "ต้องมีเหตุผลให้คนอ่านเข้าใจว่าทำไมไม่มีตัวเลข");
});

test("ค่าแอด: ท่ออัตโนมัติเดินแล้วแต่ช่วงที่เลือกไม่มีข้อมูล = ห้ามตกกลับไปใช้ค่ากรอกมือ", async (t) => {
  const { app, db, cookie } = await start(t);
  db.setSetting(ADS_KEY, "100000"); // ค่าเก่าจากตอนยังไม่มีระบบดึงอัตโนมัติ
  db.upsertAdsSpend({ day: "2026-08-31", spendThb: 2517.51, accountId: "act_1", source: "make", raw: "{}" });

  const res = await get(app.server, "/console/api/roas?date=2026-09-02", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.json.costs.adsThb, null, "วันที่ยังไม่มีข้อมูล ห้ามเอาค่าเฉลี่ยที่กรอกมือมาแทน");
  assert.notEqual(res.json.ads.source, "manual", "ท่ออัตโนมัติเดินแล้ว ค่ากรอกมือต้องไม่ถูกใช้อีก");
});

test("ค่าแอด: ข้อมูลครบทุกวันในช่วง = ใช้ยอดจริง", async (t) => {
  const { app, db, cookie } = await start(t);
  db.upsertAdsSpend({ day: "2026-09-01", spendThb: 3279.73, accountId: "act_1", source: "make", raw: "{}" });

  const res = await get(app.server, "/console/api/roas?date=2026-09-01", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.json.costs.adsThb, 3279.73, "วันเดียวที่มีข้อมูลครบ = ใช้ยอดจริง");
  assert.equal(res.json.ads.source, "daily");
});

test("ค่าแอด: ยังไม่เคยมีข้อมูลอัตโนมัติเลย = ใช้ค่ากรอกมือเหมือนเดิม (ห้ามทำของเดิมพัง)", async (t) => {
  const { app, db, cookie } = await start(t);
  db.setSetting(ADS_KEY, "3000");
  db.setSetting("cost_ads_window_days", "30");

  const res = await get(app.server, "/console/api/roas?days=30", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.json.ads.source, "manual");
  assert.equal(Math.round(res.json.costs.adsThb), 3000, "ไม่มีข้อมูลอัตโนมัติเลย = พฤติกรรมเดิม");
});
