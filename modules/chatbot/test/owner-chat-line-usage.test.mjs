// owner-chat-line-usage — พี่ง้วงถามทาง Telegram "เดือนนี้ LINE ใช้ไปเท่าไหร่ แยกตามอะไร" (28 ก.ย. 2026)
// ยืนยัน: ตัววางแผนเลือกคิวรี lineUsage ได้ (ผ่านตัวตรวจ) · ผลค้นอ่านจาก DB อย่างเดียว (ภาพโควตาที่เก็บไว้ ไม่ยิง LINE) ·
// ไม่มีชื่อ/ id ลูกค้า · เงินเฉพาะราคาที่เจ้าของกรอก · ไม่กรอก = บอกให้ตอบเป็นจำนวนข้อความ
import test from "node:test";
import assert from "node:assert/strict";
import { LOOKUP_CATALOG, lookupPlannerSystem, needsLookup, validateLookupPlan } from "../src/ownerChatLookupCatalog.mjs";
import { runOwnerLookups } from "../src/ownerChatLookups.mjs";
import { createLineSendRecorder } from "../src/lineSendLedger.mjs";
import { QUOTA_SNAPSHOT_PREFIX } from "../src/lineInsight.mjs";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const NOW = Date.UTC(2026, 8, 28, 7, 5, 0); // 28 ก.ย. 14:05 ไทย

function seeded({ snapshot = true, plan = false } = {}) {
  let t = Date.UTC(2026, 8, 12, 3, 0, 0);
  const db = memoryDb({ now: () => t });
  db.upsertCustomer("Uabcdef0123456789abcdef0123456789", { displayName: "คุณสมศรี ลูกค้าจริง" });
  db.addAudit({ operator: "system", action: "escalate_notify", target: "Uabcdef0123456789abcdef0123456789", detail: "complaint — push แจ้งทีม 2/2 คน · พยายาม 2 คน" });
  t = Date.UTC(2026, 8, 28, 1, 0, 0);
  const record = createLineSendRecorder({ db, now: () => t, logger: silent });
  for (let i = 0; i < 5; i += 1) record({ channelId: "default", method: "push", purpose: "team_alert", sends: 1 });
  for (let i = 0; i < 30; i += 1) record({ channelId: "default", method: "reply", purpose: "customer_reply", sends: 1, messageObjects: 2 });
  for (let i = 0; i < 4; i += 1) record({ channelId: "default", method: "push", purpose: "customer_reply", detail: "reply_rejected", sends: 1 });
  for (let i = 0; i < 9; i += 1) record({ channelId: "default", method: "push", purpose: "followup", sends: 1 });
  db.saveLineInsight({ channelId: "default", date: "20260915", status: "ready", counts: { broadcast: 2000, targeting: 100, chat: 20, apiPush: 300 }, at: t });
  if (snapshot) db.setSetting(`${QUOTA_SNAPSHOT_PREFIX}default`, JSON.stringify({ type: "limited", value: 15000, totalUsage: 4210, at: Date.UTC(2026, 8, 28, 7, 0, 0) }));
  if (plan) {
    db.setSetting("line_plan_monthly_fee_thb", "1280");
    db.setSetting("line_plan_included_messages", "15000");
    db.setSetting("line_plan_extra_per_message_thb", "0.1");
  }
  t = NOW;
  return db;
}

const run = (db, args = {}) => runOwnerLookups({ db, config: {}, nowMs: NOW, logger: silent, queries: [{ name: "lineUsage", args: { month: "this", byDay: false, ...args }, notes: [] }] });

test("ตัววางแผน: คำถามเรื่องโควตา LINE ต้องไปถึงตัววางแผน และเลือก lineUsage ได้", () => {
  for (const question of ["เดือนนี้ LINE ใช้ไปเท่าไหร่ แยกตามอะไร", "โควต้าไลน์เหลือเท่าไร", "push เยอะเพราะอะไร", "บรอดแคสต์เดือนนี้กินโควตาไปกี่ข้อความ"]) {
    assert.equal(needsLookup(question), true, question);
  }
  assert.ok(LOOKUP_CATALOG.lineUsage);
  assert.match(lookupPlannerSystem({ nowMs: NOW }), /lineUsage \{month: this\|last, byDay: true\|false\}/u);
  const plan = validateLookupPlan('{"queries":[{"name":"lineUsage","args":{"month":"last","byDay":true}}]}', { ownerText: "เดือนก่อน LINE", nowMs: NOW });
  assert.deepEqual(plan.queries, [{ name: "lineUsage", args: { month: "last", byDay: true }, notes: [] }]);
  const fallback = validateLookupPlan('{"queries":[{"name":"lineUsage","args":{"month":"2026-07","sql":"DROP"}}]}', { ownerText: "x", nowMs: NOW });
  assert.deepEqual(fallback.queries[0].args, { month: "this", byDay: false }, "ค่าที่ไม่รู้จักใช้ค่าตั้งต้น · อาร์กิวเมนต์แปลกถูกทิ้ง");
});

test("ผลค้น: โควตาจากภาพล่าสุด + โควตาไปไหน + แยกประเภท + ฟรี · ไม่มีชื่อ/ id ลูกค้า · ไม่มีราคา = ห้ามเดา", () => {
  const result = run(seeded());
  assert.deepEqual(result.ran, ["lineUsage"]);
  const text = result.text;
  assert.match(text, /【LINE OA】ก\.ย\. 2026/u);
  assert.match(text, /โควตา: ใช้ไป 4,210 จาก 15,000 ข้อความ \(เหลือ 10,790\) — ตัวเลข LINE ณ 14:00 น\./u);
  assert.match(text, /ส่งเข้าทีมงาน 7/u, "แจ้งเตือนก่อนเริ่มบันทึก (audit 2) + บัญชี 5");
  assert.match(text, /บรอดแคสต์ 2,100/u);
  assert.match(text, /ลูกแพรตอบ แต่ต้องใช้ push 4 \(ตอบช้าจน reply token หมดอายุ 4\)/u);
  assert.match(text, /ไม่นับโควตา \(ฟรี\): ลูกแพรตอบทันด้วย reply 30 · แชทแอดมินใน OA Manager 20/u);
  assert.match(text, /ยังไม่ได้กรอกราคาแพ็กเกจในคอนโซล — ตอบเป็นจำนวนข้อความเท่านั้น ห้ามเดาราคา/u);
  assert.match(text, /นับตั้งแต่วันที่ จ\. 28 ก\.ย\./u);
  assert.doesNotMatch(text, /สมศรี|Uabcdef/u, "ผลค้นเรื่องโควตาต้องไม่มีข้อมูลลูกค้า");
  assert.deepEqual(result.rooms, []);
});

test("ผลค้น: เจ้าของกรอกราคาแล้ว = ประมาณเงินตามราคานั้น · ไม่มีภาพโควตา = บอกตรง ๆ · รายวัน/เดือนก่อน", () => {
  const priced = run(seeded({ plan: true })).text;
  assert.match(priced, /ค่าใช้จ่ายโดยประมาณ \(ตามราคาที่พี่ง้วงกรอกในคอนโซล\): แพ็กเกจ ฿1,280 \+ ส่วนเกิน 0 ข้อความ ฿0 = ฿1,280/u);
  const blind = run(seeded({ snapshot: false })).text;
  assert.match(blind, /โควตา: ยังไม่มีตัวเลขล่าสุดจาก LINE/u);
  const daily = run(seeded(), { byDay: true }).text;
  assert.match(daily, /รายวัน \(ใหม่→เก่า\):\n· จ\. 28 ก\.ย\. \(นับตั้งแต่ 08:00 น\.\): ทีม 5 · ลูกค้า 13 \(ฟรี 30\)/u);
  const last = run(seeded(), { month: "last" }).text;
  assert.match(last, /【LINE OA】ส\.ค\. 2026/u);
  assert.doesNotMatch(last, /โควตา: ใช้ไป/u, "เดือนก่อนไม่มีโควตาย้อนหลัง");
});
