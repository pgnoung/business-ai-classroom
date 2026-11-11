// owner-chat-lookups — คิวรี "ถามอะไรก็ค้นให้" กับฐานข้อมูลที่ปลูกไว้ (28 ก.ย. 2026 บ่าย)
// ทุกตัวเลขในผลต้องตรงกับ DB · ช่วงเวลาตัดตามวันเวลาไทยตรงกับป้ายที่บอก · ไม่นับ canary
// · ชื่อลูกค้าปิดเหลือ 3 ตัว เบอร์/อีเมล/ลิงก์ถูกซ่อน ไม่มี id ในข้อความ · ลิงก์ห้องแนบเฉพาะห้องที่คำตอบเอ่ยถึง
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";
import { runOwnerLookups, LOOKUP_RESULT_MAX_CHARS } from "../src/ownerChatLookups.mjs";
import { validateLookupPlan } from "../src/ownerChatLookupCatalog.mjs";
import { collectRooms, roomLinkLines } from "../src/ownerChatLinks.mjs";
import { loadModelPricing, pricingById } from "../src/modelPricing.mjs";

poisonGlobalFetch();

// จันทร์ 28 ก.ย. 2026 เวลา 12:00 น. (เวลาไทย)
const NOON = Date.UTC(2026, 8, 28, 5, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PHONE = "0812345678";
const FULL_NAMES = ["สมชาย ใจดี", "มานี มีนา", "ประยุทธ มั่นคง", "วิภาวดี รุ่งเรือง", "สุดารัตน์", "กานดา สายลม"];
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

function world(t) {
  const clock = { now: NOON };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  const config = testConfig({ CONSOLE_PUBLIC_BASE_URL: "https://console.example/console" });
  const at = (ms, fn) => { const saved = clock.now; clock.now = ms; try { return fn(); } finally { clock.now = saved; } };
  const msg = (customerId, direction, content, ms, extra = {}) => at(ms, () => db.insertMessage({ customerId, direction, content, ...extra }));
  const room = (id, name, { channel = "default" } = {}) => at(NOON - 60 * DAY, () => db.upsertCustomer(id, { displayName: name, channelId: channel }));

  // A: ลูกค้าใหม่ ทักวันนี้ครั้งแรก ถามราคา+รอบ ลูกแพรตอบ · ร้อน 9
  room("U-a", "สมชาย ใจดี");
  msg("U-a", "in", "สนใจคลาส AI ค่ะ ราคาเท่าไหร่", NOON - 3 * HOUR);
  msg("U-a", "in", "มีรอบเสาร์ไหมคะ", NOON - 3 * HOUR + MIN);
  msg("U-a", "out", "มีรอบ 10 ต.ค. ค่ะ", NOON - 3 * HOUR + 2 * MIN, { agentMode: "ai" });
  at(NOON - 3 * HOUR + 2 * MIN, () => db.recordScore("U-a", 9, "{}"));
  // B: ลูกค้าเก่า FB (ทักครั้งแรก 40 วันก่อน) โอนแล้ว ทีมตอบเอง · ปิด AI เพราะส่งเลขบัญชี · ติดป้ายลูกค้า · ออเดอร์จ่ายแล้ว
  room("U-b", "มานี มีนา", { channel: "facebook" });
  msg("U-b", "in", "สวัสดีค่ะ", NOON - 40 * DAY);
  msg("U-b", "in", "เมื่อวานค่ะ", NOON - 30 * HOUR);
  msg("U-b", "in", `โอนแล้วนะคะ ส่งสลิปให้ ${PHONE}`, NOON - 2 * HOUR);
  at(NOON - 2 * HOUR, () => db.markMoneySeen("U-b"));
  msg("U-b", "out", "ได้รับแล้วค่ะ", NOON - 90 * MIN, { operator: "chompoo", agentMode: "operator_ai_off" });
  at(NOON - 90 * MIN, () => db.setAiEnabled("U-b", false, "bank_sent"));
  at(NOON - HOUR, () => { db.addTag("U-b", "customer"); db.recordScore("U-b", 8, "{}"); });
  at(NOON - HOUR, () => db.createOrder({ customerId: "U-b", channelId: "facebook", total: 9900, status: "paid" }));
  at(NOON - 40 * DAY, () => db.createOrder({ customerId: "U-b", channelId: "facebook", total: 500, status: "draft" }));
  // canary: ต้องไม่ถูกนับที่ไหนเลย
  room("canary:probe", "canary");
  msg("canary:probe", "in", "ราคา ping", NOON - HOUR);
  // D: ลูกค้าเก่า (ทักครั้งแรก 10 วันก่อน) ขอคุยกับคน ยังไม่มีใครตอบ · ติดธงรอคน
  room("U-d", "ประยุทธ มั่นคง");
  msg("U-d", "in", "สนใจจัดอบรม in-house ให้พนักงาน", NOON - 10 * DAY);
  msg("U-d", "in", `ขอคุยกับคนจริงได้ไหม โทร ${PHONE}`, NOON - 2 * HOUR);
  at(NOON - 2 * HOUR, () => db.setNeedsHuman("U-d", "human_requested", "ลูกค้าขอคุยกับคน"));
  // E: ทักครั้งแรกเมื่อวาน ลูกแพรแจ้งราคา แล้วทักตามเช้านี้ ลูกค้ายังเงียบ · ร้อน 9
  room("U-e", "วิภาวดี รุ่งเรือง");
  msg("U-e", "in", "ราคาเท่าไหร่คะ", NOON - 20 * HOUR);
  msg("U-e", "out", "9,900 บาทค่ะ", NOON - 19 * HOUR, { agentMode: "ai" });
  at(NOON - 19 * HOUR, () => { db.recordScore("U-e", 9, "{}"); db.markPriceQuoted("U-e"); db.setDealStatus("U-e", "price_sent"); });
  msg("U-e", "out", "ยังสนใจอยู่ไหมคะ", NOON - 5 * HOUR, { agentMode: "ai", messageClass: "proactive" });
  // F: FB อุ่น 6 — YOLO ทักตาม 3 วันก่อน ลูกค้าตอบใน 2 ชม. แล้วยังไม่มีใครตอบต่อ
  room("U-f", "สุดารัตน์", { channel: "facebook" });
  msg("U-f", "in", "สนใจคลาสค่ะ", NOON - 4 * DAY);
  msg("U-f", "out", "ยินดีค่ะ", NOON - 4 * DAY + MIN, { agentMode: "ai" });
  at(NOON - 4 * DAY + MIN, () => db.recordScore("U-f", 6, "{}"));
  msg("U-f", "out", "มีรอบใหม่แล้วนะคะ", NOON - 3 * DAY, { agentMode: "ai", messageClass: "proactive", metadata: { yolo: true } });
  msg("U-f", "in", "เรียน online ได้ไหมคะ", NOON - 3 * DAY + 2 * HOUR);
  // G: ห้องค้าง 5 วัน ไม่มีใครตอบ
  room("U-g", "กานดา สายลม");
  msg("U-g", "in", "ยังรออยู่นะคะ", NOON - 5 * DAY);
  // ค่า AI: ตอบลูกค้า (sol) · แชทเจ้าของ (luna, customer_id ว่าง) · ให้คะแนน · เดือนก่อน (ไม่นับ) · โมเดลไม่มีราคา
  at(NOON - HOUR, () => db.addLlmUsage({ customerId: "U-a", kind: "draft", model: "gpt-5.6-sol", tokensIn: 250_000, cacheWriteIn: 0 }));
  at(NOON - HOUR, () => db.addLlmUsage({ customerId: "", kind: "draft", model: "gpt-5.6-luna", tokensIn: 100_000, tokensOut: 100_000, cacheWriteIn: 0 }));
  at(NOON - 2 * DAY, () => db.addLlmUsage({ customerId: "U-e", kind: "score", model: "gpt-5.6-luna", tokensIn: 250_000, cacheWriteIn: 0 }));
  at(NOON - 29 * DAY, () => db.addLlmUsage({ customerId: "U-a", kind: "draft", model: "gpt-5.6-sol", tokensIn: 250_000, cacheWriteIn: 0 }));
  at(NOON - HOUR, () => db.addLlmUsage({ customerId: "U-a", kind: "draft", model: "mystery-model", tokensIn: 1_000, cacheWriteIn: 0 }));

  const pricing = pricingById(loadModelPricing(config.modelPricingFile, { logger: silent }));
  const run = (queries, ownerText = "") => {
    const checked = validateLookupPlan(JSON.stringify({ queries }), { ownerText, nowMs: NOON });
    return runOwnerLookups({ db, config, queries: checked.queries, nowMs: NOON, pricing, thbPerUsd: 34, logger: silent });
  };
  return { db, config, at, msg, room, run };
}

function assertPrivate(text) {
  for (const name of FULL_NAMES.filter((n) => n.includes(" "))) assert.ok(!text.includes(name), `ชื่อเต็มหลุด: ${name}`);
  assert.ok(!text.includes(PHONE), "เบอร์หลุด");
  assert.doesNotMatch(text, /U-[a-g]\b|canary/u, "ไม่มี id ในข้อความที่โมเดลเห็น");
}

test("activity: ยอดทั้งช่วง + รายวัน ตรงกับ DB (ห้อง ไม่ใช่บอลลูน · ลูกค้าใหม่ = ทักครั้งแรกในชีวิต · ส่งต่อทีมตามเหตุ · ไม่นับ canary)", (t) => {
  const w = world(t);
  const out = w.run([{ name: "activity", args: { from: "2026-09-27", to: "2026-09-28" } }]);
  assert.equal(out.text, [
    "【สถิติแชท】อา. 27 ก.ย. – จ. 28 ก.ย. 2026 (วันนี้นับถึง 12:00 น.) · ทุกช่องทาง",
    "รวมทั้งช่วง: ลูกค้าทัก 4 ห้อง (6 ข้อความ · LINE 3 / FB 1 ห้อง) · ลูกค้าใหม่ (ทักครั้งแรก) 2 คน (LINE 2 / FB 0)"
      + " · ลูกแพรตอบ 2 ห้อง · ทีมตอบเอง 1 ห้อง · ลูกแพรทักตาม/YOLO 1 ห้อง",
    "ส่งต่อทีม (นับจากบันทึกส่งต่อที่ยังเก็บอยู่): ลูกค้าขอคุยกับคนจริง 1",
    "รายวัน:",
    "· อา. 27 ก.ย.: ทัก 2 ห้อง/2 ข้อความ · ใหม่ 1 · ลูกแพรตอบ 1 · ทีม 0 · ทักตาม 0",
    "· จ. 28 ก.ย.: ทัก 3 ห้อง/4 ข้อความ · ใหม่ 1 · ลูกแพรตอบ 1 · ทีม 1 · ทักตาม 1",
  ].join("\n"));
  assert.deepEqual(out.ran, ["activity"]);
  assert.deepEqual(out.rooms, []);

  const fb = w.run([{ name: "activity", args: { from: "2026-09-28", channel: "FB", byDay: false } }]).text;
  assert.match(fb, /^【สถิติแชท】จ\. 28 ก\.ย\. 2026 \(วันนี้นับถึง 12:00 น\.\) · Facebook$/mu);
  assert.match(fb, /รวมทั้งช่วง: ลูกค้าทัก 1 ห้อง \(1 ข้อความ\) · ลูกค้าใหม่ \(ทักครั้งแรก\) 0 คน · ลูกแพรตอบ 0 ห้อง · ทีมตอบเอง 1 ห้อง/u);
  assert.match(fb, /ส่งต่อทีม: ไม่มีบันทึกส่งต่อในช่วงนี้/u, "ห้องที่ส่งต่อเป็น LINE");
  assert.doesNotMatch(fb, /รายวัน/u);
});

test("topics: นับหัวข้อตามห้อง/ข้อความในช่วงวันเวลาไทย · ตัวอย่างสั้น ชื่อปิด เบอร์ซ่อน", (t) => {
  const w = world(t);
  const out = w.run([{ name: "topics", args: { days: 7 } }]).text;
  const lines = out.split("\n");
  assert.equal(lines[0], "【ลูกค้าถามเรื่องอะไร】7 วันล่าสุด (อ. 22 ก.ย. – จ. 28 ก.ย.) · ทุกช่องทาง");
  assert.equal(lines[1], "ข้อความตัวอักษรจากลูกค้า 9 ข้อความ จาก 6 ห้อง · ข้อความหนึ่งเข้าได้หลายหัวข้อ");
  assert.equal(lines[2], "· ราคา/ค่าเรียน/โปร: 2 ห้อง (2 ข้อความ) — ตัวอย่าง สมช*** (LINE, วันนี้ 09:00): \"สนใจคลาส AI ค่ะ ราคาเท่าไหร่\"");
  assert.match(lines[3], /^· รอบเรียน\/วันเวลา: 1 ห้อง \(1 ข้อความ\) — ตัวอย่าง สมช\*\*\* \(LINE, วันนี้ 09:01\): "มีรอบเสาร์ไหมคะ"$/u);
  assert.match(lines[4], /^· เรียนออนไลน์\/ดูย้อนหลัง: 1 ห้อง \(1 ข้อความ\) — ตัวอย่าง สุดา\*\*\* \(FB, 25 ก\.ย\. 14:00\)/u);
  assert.match(lines[5], /^· สมัคร\/จอง\/ชำระเงิน: 1 ห้อง \(1 ข้อความ\) — ตัวอย่าง มานี\*\*\* \(FB, วันนี้ 10:00\): "โอนแล้วนะคะ ส่งสลิปให้ /u);
  assert.equal(lines[6], "· ไม่เข้าหัวข้อไหน (ทักทาย/ตอบสั้น/เรื่องอื่น): 4 ข้อความ");
  assert.equal(lines.length, 7, "อบรมองค์กร (10 วันก่อน) อยู่นอกช่วง 7 วัน");
  assertPrivate(out);
});

test("search: นับข้อความ/ห้องที่มีคำนั้น + ตัวอย่างล่าสุด · ค้นเบอร์เจอแต่ไม่โชว์เบอร์ · % _ ไม่ใช่ wildcard", (t) => {
  const w = world(t);
  const price = w.run([{ name: "search", args: { keyword: "ราคา" } }]);
  assert.equal(price.text, [
    "【ค้นคำ \"ราคา\" ในข้อความลูกค้า】30 วันล่าสุด (อา. 30 ส.ค. – จ. 28 ก.ย.) · ทุกช่องทาง",
    "พบ 2 ข้อความ จาก 2 ห้อง — ล่าสุด:",
    "· สมช*** (LINE, วันนี้ 09:00): \"สนใจคลาส AI ค่ะ ราคาเท่าไหร่\"",
    "· วิภา*** (LINE, เมื่อวาน 16:00): \"ราคาเท่าไหร่คะ\"",
  ].join("\n"), "canary ที่พิมพ์คำว่าราคาไม่ถูกนับ");
  assert.deepEqual(price.rooms, [
    { id: "U-a", mask: "สมช***", channel: "LINE" }, { id: "U-e", mask: "วิภา***", channel: "LINE" },
  ]);
  const phone = w.run([{ name: "search", args: { keyword: "0812" } }]).text;
  assert.match(phone, /พบ 2 ข้อความ จาก 2 ห้อง/u);
  assertPrivate(phone);
  const wild = w.run([{ name: "search", args: { keyword: "%_" } }]).text;
  assert.match(wild, /พบ 0 ข้อความ จาก 0 ห้อง$/u);
  const inhouse = w.run([{ name: "search", args: { keyword: "in-house", days: 7 } }]).text;
  assert.match(inhouse, /พบ 0 ข้อความ/u, "10 วันก่อนอยู่นอกช่วง 7 วัน");
});

test("leads: กรองคะแนน/ช่วง/ช่องทาง/สถานะดีล/รอตอบ · ไม่เอาห้องที่เป็นลูกค้าแล้ว · ชื่อปิด · ห้องส่งต่อให้แนบลิงก์ได้", (t) => {
  const w = world(t);
  const hot = w.run([{ name: "leads", args: {} }]);
  const lines = hot.text.split("\n");
  assert.equal(lines[0], "【รายชื่อลีด】คะแนน 8–10 · คุยใน 7 วัน · ทุกช่องทาง · เรียงตามคะแนน");
  assert.equal(lines[1], "เข้าเงื่อนไข 2 ห้อง", "ห้อง FB คะแนน 8 ติดป้ายลูกค้าแล้ว = ไม่ใช่ลีด");
  assert.equal(lines[2], "· สมช*** (LINE) — 9/10 สนใจสูง — AI เปิด — ล่าสุด: ลูกแพรตอบ วันนี้ 09:02 (ลูกค้ายังไม่ตอบกลับ) — ทีมยังไม่เคยทัก");
  assert.equal(lines[3], "· วิภา*** (LINE) — 9/10 สนใจสูง · แจ้งราคาแล้ว — AI เปิด — ล่าสุด: ลูกแพรตอบ วันนี้ 07:00 (ลูกค้ายังไม่ตอบกลับ) — ทีมยังไม่เคยทัก");
  assert.deepEqual(hot.rooms.map((room) => room.id), ["U-a", "U-e"]);
  assertPrivate(hot.text);

  const warm = w.run([{ name: "leads", args: { minScore: 5, maxScore: 7 } }]).text;
  assert.match(warm, /เข้าเงื่อนไข 1 ห้อง\n· สุดา\*\*\* \(FB\) — 6\/10 กำลังพิจารณา — AI เปิด — ล่าสุด: ลูกค้าพิมพ์ 25 ก\.ย\. 14:00 \(ยังไม่มีใครตอบ\)/u);
  const waiting = w.run([{ name: "leads", args: { minScore: 0, waitingReply: true } }]).text;
  assert.match(waiting, /ลูกค้าพิมพ์ล่าสุดและยังไม่มีใครตอบ/u);
  assert.match(waiting, /เข้าเงื่อนไข 1 ห้อง/u, "ห้องที่ยังไม่มีคะแนนไม่ใช่ลีด");
  const deal = w.run([{ name: "leads", args: { dealStatus: "price_sent" } }]).text;
  assert.match(deal, /สถานะดีล แจ้งราคาแล้ว/u);
  assert.match(deal, /เข้าเงื่อนไข 1 ห้อง\n· วิภา\*\*\*/u);
  assert.match(w.run([{ name: "leads", args: { channel: "FB" } }]).text, /เข้าเงื่อนไข 0 ห้อง$/u);
  assert.match(w.run([{ name: "leads", args: { aiState: "off", minScore: 0 } }]).text, /เข้าเงื่อนไข 0 ห้อง$/u);
});

test("room: ชื่อที่พี่ง้วงพิมพ์ → ห้องเดียว = สรุปห้อง (ชื่อปิด เบอร์ซ่อน) · ชื่อซ้ำ = รายการให้ถามกลับ · ไม่เจอ = บอกตรง ๆ", (t) => {
  const w = world(t);
  const one = w.run([{ name: "room", args: { name: "ประยุทธ" } }], "เคสคุณประยุทธเป็นไง");
  assert.match(one.text, /^【ห้องลูกค้า "ประยุทธ"】\n/u);
  assert.match(one.text, /ประ\*\*\*/u);
  assert.deepEqual(one.rooms, [{ id: "U-d", mask: "ประ***", channel: "LINE" }]);
  assertPrivate(one.text);

  w.room("U-s1", "สมศรี ดีมาก");
  w.room("U-s2", "สมศรี ใจงาม", { channel: "facebook" });
  w.msg("U-s1", "in", "สวัสดี", NOON - 6 * HOUR);
  w.msg("U-s2", "in", "สวัสดีค่ะ", NOON - 7 * HOUR);
  const many = w.run([{ name: "room", args: { name: "สมศรี" } }], "สมศรีคุยถึงไหนแล้ว");
  assert.match(many.text, /ชื่อนี้ตรงกับ 2 ห้อง — ให้ถามพี่ง้วงก่อนว่าหมายถึงห้องไหน/u);
  assert.equal(many.rooms.length, 2);
  assert.ok(!many.text.includes("สมศรี ดีมาก") && !many.text.includes("สมศรี ใจงาม"));
  const none = w.run([{ name: "room", args: { name: "ไม่มีคนนี้" } }], "ไม่มีคนนี้ในระบบใช่ไหม");
  assert.match(none.text, /ไม่พบห้องชื่อนี้/u);
  assert.deepEqual(none.rooms, []);
});

test("funnel: ห้องที่คุย · ได้ราคา · แตะเรื่องเงิน · ปิด AI เพราะส่งเลขบัญชี · ธงรอคน · ป้ายลูกค้า · สถานะดีล · ออเดอร์ในช่วง", (t) => {
  const w = world(t);
  assert.equal(w.run([{ name: "funnel", args: {} }]).text, [
    "【ภาพรวมการขาย】ห้องที่ลูกค้าทักใน 30 วันล่าสุด (อา. 30 ส.ค. – จ. 28 ก.ย.) · ทุกช่องทาง",
    "ห้องที่คุย 6 · ได้รับราคาครั้งแรกในช่วงนี้ 1 · แตะเรื่องเงิน/ส่งช่องทางชำระในช่วงนี้ 1 · ตอนนี้ปิด AI เพราะส่งเลขบัญชีแล้ว (รอทีมดูแลเงิน) 1 · ติดธงรอคน 1",
    "ติดป้าย \"ลูกค้า\" (ชำระ/ลงเรียนแล้ว): 1 ห้อง (ติดป้ายในช่วงนี้ 1)",
    "สถานะดีล (เฉพาะที่ไม่ใช่ \"เพิ่งเริ่มคุย\"): แจ้งราคาแล้ว 1",
    "ออเดอร์ในช่วงนี้: สร้าง 1 · ยืนยัน 0 · จ่ายแล้ว 1 (฿9,900)",
    "(ไม่มีเลขบัญชีหรือยอดโอนรายคนในผลนี้โดยเจตนา)",
  ].join("\n"));
  assert.match(w.run([{ name: "funnel", args: { days: 7, channel: "LINE" } }]).text, /ห้องที่คุย 4 · ได้รับราคาครั้งแรกในช่วงนี้ 1 · แตะเรื่องเงิน\/ส่งช่องทางชำระในช่วงนี้ 0/u);
});

test("followups: ห้องที่ลูกแพรทักตาม (อัตโนมัติ + YOLO) แล้วลูกค้าตอบกลับภายในกี่ชั่วโมง แยกช่องทาง/คะแนน", (t) => {
  const w = world(t);
  assert.equal(w.run([{ name: "followups", args: {} }]).text, [
    "【ผลการทักตาม】14 วันล่าสุด (อ. 15 ก.ย. – จ. 28 ก.ย.) · ทุกช่องทาง · นับว่า \"ตอบกลับ\" เมื่อลูกค้าพิมพ์มาภายใน 24 ชม. หลังข้อความทักตาม",
    "ลูกแพรทักตาม 2 ห้อง (2 ข้อความ) · ลูกค้าตอบกลับ 1 ห้อง (50%)",
    "แยกช่องทาง (ตอบกลับ/ทักตาม): LINE 0/1 (0%) · FB 1/1 (100%)",
    "แยกตามคะแนนปัจจุบันของห้อง: สนใจสูง 0/1 (0%) · กำลังพิจารณา 1/1 (100%) · เพิ่งเริ่มคุย 0/0 (-)",
    "ในนี้เป็น YOLO ที่พี่ง้วงสั่ง 1 ห้อง (ตอบกลับ 1)",
  ].join("\n"));
  assert.match(w.run([{ name: "followups", args: { replyHours: 1 } }]).text, /ลูกค้าตอบกลับ 0 ห้อง \(0%\)/u, "ตอบหลัง 2 ชม. ไม่นับเมื่อขอ 1 ชม.");
});

test("waiting: ห้องที่ลูกค้าพิมพ์คนสุดท้ายแล้วยังไม่มีใครตอบ แยกเพิ่งรอ/ค้างนาน + เหตุ · ข้อความล่าสุดไม่มีเบอร์", (t) => {
  const w = world(t);
  const out = w.run([{ name: "waiting", args: {} }]);
  const lines = out.text.split("\n");
  assert.equal(lines[0], "【ห้องรอคำตอบ】ลูกค้าพิมพ์คนสุดท้ายแล้วยังไม่มีใครตอบ (30 วันล่าสุด): 3 ห้อง · รอไม่เกิน 48 ชม. 1 · ค้างนานกว่านั้น 2");
  assert.match(lines[1], /^แยกตามเหตุ: /u);
  assert.match(lines[2], /^· ประ\*\*\* \(LINE\) — รอ 2 ชม\. — /u, "ห้องที่เพิ่งรอขึ้นก่อน");
  assert.deepEqual(out.rooms.map((room) => room.id).sort(), ["U-d", "U-f", "U-g"]);
  assertPrivate(out.text);
  assert.match(w.run([{ name: "waiting", args: { freshHours: 168, limit: 1 } }]).text, /รอไม่เกิน 168 ชม\. 3 · ค้างนานกว่านั้น 0/u);
});

test("aiCost: บาทด้วยสูตรเดียวกับคอนโซล แยกงาน (แชทเจ้าของแยกจากตอบลูกค้า) / โมเดล / รายวัน · ไม่รวมเดือนก่อน · โมเดลไม่มีราคาบอกตรง ๆ", (t) => {
  const w = world(t);
  assert.equal(w.run([{ name: "aiCost", args: {} }]).text, [
    "【ค่า AI】อ. 1 ก.ย. – จ. 28 ก.ย. 2026 (วันนี้นับถึง 12:00 น.) · อัตรา 34 บาท/ดอลลาร์ (อัตราเดียวกับคอนโซล)",
    "รวม ฿40.46 (≈ $1.19)",
    "แยกตามงาน: ตอบลูกค้า ฿34.00 · แชทเจ้าของ (Telegram) ฿4.76 · ให้คะแนนลูกค้า ฿1.70",
    "แยกตามโมเดล: gpt-5.6-sol ฿34.00 · gpt-5.6-luna ฿6.46 · mystery-model ฿0.00",
    "(ยังไม่รวม 1,000 โทเคนที่ราคายังไม่ยืนยัน — โมเดลที่ไม่มีในไฟล์ราคา หรือครั้งที่เขียนแคชกับโมเดลที่ยังไม่มีราคาเขียนแคช · ยอดจริงสูงกว่านี้)",
  ].join("\n"));
  const daily = w.run([{ name: "aiCost", args: { from: "2026-09-26", byDay: true } }]).text;
  assert.match(daily, /รายวัน:\n· ส\. 26 ก\.ย\.: ฿1\.70\n· จ\. 28 ก\.ย\.: ฿38\.76/u);
  assert.match(w.run([{ name: "aiCost", args: { from: "2026-08-30", to: "2026-08-31" } }]).text, /รวม ฿34\.00/u, "เดือนก่อนค้นได้เมื่อขอเอง");

  // ครั้งที่เขียนแคชกับโมเดลที่ยังไม่มีราคาเขียนแคช (gpt-5.6-*) = ไม่ทราบราคาเฉพาะ token เขียนแคช ส่วนอื่นของครั้งนั้น
  // และค่าเรียกปกติวันเดียวกันยังนับครบ (28 ก.ย.: summarizeUsage แก้แล้ว คอนโซลจึงได้ยอดเดียวกัน ไม่ต้องมีบรรทัด
  // "หน้าคอนโซลแสดงต่าง" อีก) · ไม่มีข้อมูลเขียนแคช = บอกไว้
  w.at(NOON - HOUR, () => w.db.addLlmUsage({ customerId: "U-e", kind: "draft", model: "gpt-5.6-sol", tokensIn: 50_000, cacheWriteIn: 20_000 }));
  w.at(NOON - HOUR, () => w.db.addLlmUsage({ customerId: "U-e", kind: "draft", model: "gpt-5.6-sol", tokensIn: 10_000 }));
  const split = w.run([{ name: "aiCost", args: {} }]).text;
  // 40.46 เดิม + ครั้งเขียนแคช (input 30,000 × $4/M = ฿4.08 · เขียนแคช 20,000 × $5/M = ฿3.40 ตามกฎ 1.25× ของ OpenAI
  // ที่ใส่ไฟล์ราคาแล้ว 28 ก.ย.) + ครั้งปกติ (10,000 × $4/M = ฿1.36)
  assert.match(split, /^รวม ฿49\.30 \(≈ \$1\.45\)$/mu, "ค่าเรียกปกติ + ครั้งเขียนแคช นับครบ");
  assert.match(split, /\(ยังไม่รวม 1,000 โทเคนที่ราคายังไม่ยืนยัน/u, "ไม่ทราบราคาเหลือแค่โมเดลที่ไม่มีในไฟล์ราคา");
  assert.match(split, /\(1 ครั้งไม่มีข้อมูลการเขียนแคช/u);
  assert.doesNotMatch(split, /หน้าภาพรวมในคอนโซลคิดรวมทั้งช่วงเป็นก้อนเดียว/u, "คอนโซลใช้สูตรเดียวกันแล้ว ยอดตรงกัน");
});

test("รันหลายคิวรี: ผลต่อกันตามลำดับ · ตัวกรองที่ตัวตรวจตัดขอบถูกบอกไว้ · คิวรีไหนพัง = บอกว่าค้นไม่สำเร็จ ก้อนอื่นไปต่อ · มีเพดานตัวอักษร", (t) => {
  const w = world(t);
  const checked = validateLookupPlan(JSON.stringify({ queries: [
    { name: "funnel", args: {} }, { name: "topics", args: { days: 400 } }, { name: "waiting", args: {} },
  ] }), { nowMs: NOON });
  const logs = [];
  const broken = new Proxy(w.db, { get: (target, key) => (key === "lookupFunnel" ? () => { throw new Error("disk I/O error"); } : target[key]) });
  const out = runOwnerLookups({ db: broken, config: w.config, queries: checked.queries, nowMs: NOON, thbPerUsd: 34, logger: { warn: (m) => logs.push(m) } });
  assert.deepEqual(out.ran, ["funnel", "topics", "waiting"]);
  const blocks = out.text.split("\n\n");
  assert.equal(blocks[0], "【funnel】ค้นไม่สำเร็จรอบนี้ (ระบบขัดข้อง) — บอกพี่ง้วงตรง ๆ ว่ายังค้นเรื่องนี้ไม่ได้");
  assert.match(blocks[1], /^【ลูกค้าถามเรื่องอะไร】90 วันล่าสุด/u);
  assert.match(blocks[1], /\(ตัวกรองที่ใช้จริง: ขอ 400 — ใช้ 90 \(ขอบเขต 1–90\)\)$/u);
  assert.match(blocks[2], /^【ห้องรอคำตอบ】/u);
  assert.equal(logs.length, 1);
  assert.ok(blocks.every((block) => block.length <= LOOKUP_RESULT_MAX_CHARS));
  assert.equal(runOwnerLookups({ db: w.db, queries: [{ name: "nope", args: {} }] }).text, "", "ชื่อที่ไม่มีตัวรัน = ข้าม");
});

test("ลิงก์ห้อง: แนบเฉพาะห้องที่ชื่อปิดบังโผล่ในคำตอบ · ไม่มีฐาน URL = ไม่มีลิงก์ · ชื่อสำรอง 'ลูกค้า' ไม่ผูก · เพดาน 5", (t) => {
  const w = world(t);
  const rooms = collectRooms(w.run([{ name: "leads", args: {} }]).rooms, [{ id: "U-a", mask: "สมช***", channel: "LINE" }], [{ id: "x", mask: "ลูกค้า", channel: "LINE" }]);
  assert.equal(rooms.length, 3, "ไม่ซ้ำ id");
  assert.deepEqual(roomLinkLines("ห้องที่ควรตามก่อนคือ สมช*** ค่ะ ส่วนลูกค้าอีกคนรอได้", rooms, w.config), [
    "🔗 สมช*** (LINE) https://console.example/console/#/c/U-a",
  ]);
  assert.deepEqual(roomLinkLines("สมช*** กับ วิภา***", rooms, testConfig()), [], "ไม่มี CONSOLE_PUBLIC_BASE_URL");
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `U-${i}`, mask: `ห้อง${i}***`, channel: "LINE" }));
  assert.equal(roomLinkLines(many.map((room) => room.mask).join(" "), many, w.config).length, 5);
});
