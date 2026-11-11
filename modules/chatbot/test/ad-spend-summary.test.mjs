// การ์ด "ค่าแอด" ใบใหญ่บนหน้าแรก (พี่ง้วง 7 ต.ค. 2026) — ตัวเลขถูก · เจ้าของเท่านั้น · หน้าเว็บเรนเดอร์จริง
import test from "node:test";
import assert from "node:assert/strict";
import { buildAdSpendSummary } from "../src/adSpendSummary.mjs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { httpRequest, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
// 15 ต.ค. 2026 10:00 เวลาไทย → เมื่อวาน = 14 ต.ค. · เดือนนี้ = 1–14 ต.ค. (14 วัน)
const NOW = Date.parse("2026-10-15T10:00:00+07:00");
const dayOf = (offset) => new Date(NOW + 7 * 3_600_000 - offset * 86_400_000).toISOString().slice(0, 10);

function seedSpend(db, days, thb = 1000) {
  for (let i = 1; i <= days; i += 1) db.upsertAdsSpend({ day: dayOf(i), spendThb: thb + i, accountId: "act_1" });
}

test("ยอดเมื่อวาน / 7 วัน / เดือนนี้ถูก · กราฟ 14 วันเรียงเก่า→ใหม่ · วันไม่มีข้อมูล = null ไม่ใช่ 0", () => {
  const db = memoryDb({ now: () => NOW });
  seedSpend(db, 10);
  const s = buildAdSpendSummary(db, NOW);
  assert.equal(s.spend.yesterday.day, "2026-10-14");
  assert.equal(s.spend.yesterday.thb, 1001);
  assert.equal(s.spend.last7.thb, [1, 2, 3, 4, 5, 6, 7].reduce((a, i) => a + 1000 + i, 0));
  assert.equal(s.spend.last7.complete, true);
  assert.equal(s.spend.month.expectedDays, 14);
  assert.equal(s.spend.month.days, 10);
  assert.equal(s.spend.month.complete, false, "เดือนนี้มีข้อมูลแค่ 10/14 วัน");
  assert.equal(s.roasMonth, null, "ข้อมูลไม่ครบห้ามคำนวณ ROAS");
  assert.equal(s.series.length, 14);
  assert.equal(s.series.at(-1).day, "2026-10-14");
  assert.equal(s.series[0].thb, null);
  assert.equal(s.hasData, true);
  db.close();
});

test("ต้นทุนต่อห้อง/ต่อคนจ่ายจากห้องจากแอด 7 วัน · ROAS เดือนนี้ = ยอดขาย ÷ ค่าแอด", () => {
  const db = memoryDb({ now: () => NOW });
  seedSpend(db, 14, 1000);
  for (const id of ["a", "b"]) {
    db.upsertCustomer(`facebook:${id}`, { channelId: "facebook" });
    db.recordAdReferral({ customerId: `facebook:${id}`, source: "ADS", adId: "120000000000000001", eventKind: "referral", firstContact: true, referralAt: NOW - 3 * 86_400_000 });
  }
  const order = db.createOrder({ customerId: "facebook:a", channelId: "facebook", items: [{ name: "คลาส", qty: 1, price: 50000 }], total: 50000, createdBy: "test" });
  // ยอดขายนับถึงเมื่อวาน (ช่วงเดียวกับค่าแอด) — ออเดอร์เมื่อวาน
  db.raw.prepare("UPDATE orders SET status = 'paid', created_at = ? WHERE id = ?").run(NOW - 86_400_000, order.id ?? order);
  const today = db.createOrder({ customerId: "facebook:b", channelId: "facebook", items: [{ name: "คลาส", qty: 1, price: 9999 }], total: 9999, createdBy: "test" });
  db.raw.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(today.id);
  const s = buildAdSpendSummary(db, NOW);
  assert.equal(s.funnel.rooms, 2);
  assert.equal(s.perRoom, Math.round(s.spend.last7.thb / 2));
  assert.equal(s.revenueMonth, 50000);
  assert.equal(s.spend.month.complete, true);
  assert.equal(s.roasMonth, Math.floor((50000 / s.spend.month.thb) * 100) / 100);
  db.close();
});

test("วันที่ 1 ของเดือน: เดือนนี้ยังไม่มีวันเต็ม = 0 วัน ไม่ใช่ข้อมูลไม่ครบ", () => {
  const first = Date.parse("2026-11-01T09:00:00+07:00");
  const db = memoryDb({ now: () => first });
  db.upsertAdsSpend({ day: "2026-10-31", spendThb: 900 });
  const s = buildAdSpendSummary(db, first);
  assert.equal(s.spend.month.expectedDays, 0);
  assert.equal(s.spend.month.complete, true);
  assert.equal(s.spend.yesterday.thb, 900);
  db.close();
});

const PASSWORD = ["spend", "pass", "123", "x"].join("-");
const SESSION_KEY = ["spend", "fixture", "0123456789"].join("-");

test("API: เจ้าของได้การ์ด · แอดมิน/ทีมงาน 403", async (t) => {
  const db = memoryDb();
  const hash = hashPassword(PASSWORD);
  db.createOperator({ username: "ngoung", passHash: hash, displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "boss2", passHash: hash, displayName: "แอดมิน", role: "admin" });
  db.createOperator({ username: "chompoo", passHash: hash, displayName: "ชมพู่", role: "operator" });
  db.upsertAdsSpend({ day: new Date(Date.now() + 7 * 3_600_000 - 86_400_000).toISOString().slice(0, 10), spendThb: 2700 });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY }), db, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = async (username) => (await httpRequest(app.server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  })).headers["set-cookie"][0].split(";")[0];
  const owner = await httpRequest(app.server, { path: "/console/api/roas/ad-summary", headers: { cookie: await login("ngoung") } });
  assert.equal(owner.status, 200, owner.text);
  assert.equal(owner.json.spend.yesterday.thb, 2700);
  for (const who of ["boss2", "chompoo"]) {
    const res = await httpRequest(app.server, { path: "/console/api/roas/ad-summary", headers: { cookie: await login(who) } });
    assert.equal(res.status, 403, who);
  }
});

function findAll(node, predicate, out = []) {
  for (const child of node?.children || []) {
    if (child?.nodeType !== 1) continue;
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}
const textOf = (node) => (node?.nodeType === 3 ? node.textContent : `${node?.textContent || ""}${(node?.children || []).map(textOf).join("")}`);

test("หน้าเว็บ: การ์ดโชว์ยอดใหญ่ + ทางเดินห้อง + ต้นทุน · ข้อมูลไม่ครบบอกจำนวนวัน · ไม่มีข้อมูล = การ์ดชวนต่อ Make", async (t) => {
  installBrowserGlobals(t);
  const { adSpendCard, adSpendBars } = await import("../public/console/overviewAdSpend.mjs");
  const db = memoryDb({ now: () => NOW });
  seedSpend(db, 10);
  const summary = { ok: true, ...buildAdSpendSummary(db, NOW) };
  db.close();
  let opened = 0;
  const card = adSpendCard(summary, { onOpenDetail: () => { opened += 1; } });
  const text = textOf(card);
  assert.match(text, /ค่าแอด Facebook/u);
  assert.match(text, /เมื่อวาน/u);
  assert.match(text, /฿1,001/u);
  assert.match(text, /ข้อมูลมา 10\/14 วัน/u);
  assert.match(text, /ห้องจากแอด.*ถึงราคา\/รอบ.*จ่ายแล้ว/u);
  const more = findAll(card, (n) => n.tagName === "button")[0];
  for (const fn of more.listeners.click || []) fn();
  assert.equal(opened, 1);
  assert.ok(adSpendBars(summary.series));
  assert.equal(adSpendCard(null), null);
  assert.match(textOf(adSpendCard({ ok: true, hasData: false })), /ยังไม่มียอดค่าแอด/u);
});
