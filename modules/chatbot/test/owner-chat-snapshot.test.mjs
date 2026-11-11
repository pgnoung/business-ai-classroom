// owner-chat-snapshot — "ข้อมูลสด" ที่ลูกแพรเห็นตอนคุยกับพี่ง้วง: ทุกตัวเลขต้องมาจาก DB ตรง ๆ
// รอบ/ที่นั่งมาจากหน้า "ที่นั่ง" (settings) เท่านั้น · กิจกรรมวันนี้ตัดตามเวลาไทย · ไม่นับ canary
// · ห้องรอคำตอบพร้อมเหตุ · ลีดร้อน · สิ่งที่สั่งผ่าน Telegram/YOLO ล่าสุด · ชื่อลูกค้าปิดบางส่วนเสมอ
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";
import { buildOwnerSnapshot, OWNER_SNAPSHOT_MAX_CHARS } from "../src/ownerChatSnapshot.mjs";
import { writeEnrolled, writeManualRounds } from "../src/classRounds.mjs";

poisonGlobalFetch();

// จันทร์ 28 ก.ย. 2026 เวลา 12:00 น. (เวลาไทย) = 05:00 UTC
const NOON = Date.UTC(2026, 8, 28, 5, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

function roundsFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "owner-snapshot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "class-rounds.json");
  // รอบในไฟล์ = ของเก่าก่อนมีหน้าที่นั่ง — ต้องไม่โผล่เมื่อหน้าที่นั่งมีรอบแล้ว
  writeFileSync(file, JSON.stringify({ seatsPerRound: 20, classes: { old: { label: "คลาสจากไฟล์เก่า" } }, rounds: [{ date: "2026-10-03", class: "old" }] }), "utf8");
  return file;
}

function world(t, { withRounds = true } = {}) {
  const clock = { now: NOON };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  const config = testConfig({ CLASS_ROUNDS_FILE: roundsFile(t) });
  const at = (ms, fn) => { const saved = clock.now; clock.now = ms; try { return fn(); } finally { clock.now = saved; } };
  const msg = (customerId, direction, content, ms, extra = {}) => at(ms, () => db.insertMessage({ customerId, direction, content, ...extra }));
  const room = (id, name, { channel = "default", createdAt = NOON - 60 * DAY } = {}) => at(createdAt, () => db.upsertCustomer(id, { displayName: name, channelId: channel }));
  if (withRounds) {
    writeManualRounds(db, [
      { date: "2026-09-20", label: "AI Agent for Business", status: "open", capacity: 15 },
      { date: "2026-09-28", label: "AI Agent for Business", status: "open", capacity: 15 },
      { date: "2026-10-10", label: "AI Agent for Business", status: "open", capacity: 15 },
      { date: "2026-10-17", label: "AI Agent Workflow Automation", status: "almost_full", capacity: null },
      { date: "2026-10-24", label: "AI Agent for Business", status: "open", capacity: 12 },
      { date: "2026-10-31", label: "AI Agent for Business", status: "open", capacity: 15 },
    ]);
    writeEnrolled(db, { "2026-09-28": 14, "2026-10-10": 7, "2026-10-17": 12, "2026-10-24": 12 });
  }
  return { db, clock, config, msg, room, at };
}

function seedDay(w) {
  const { db, msg, room, at } = w;
  // A: ลูกค้าใหม่ทักวันนี้ครั้งแรก ลูกแพรตอบ
  room("U-a", "สมชาย ใจดี", { createdAt: NOON - 3 * HOUR });
  msg("U-a", "in", "สนใจคลาส AI ค่ะ", NOON - 3 * HOUR);
  msg("U-a", "in", "มีรอบไหนบ้าง", NOON - 3 * HOUR + 60_000);
  msg("U-a", "out", "มีรอบ 10 ต.ค. ค่ะ", NOON - 3 * HOUR + 90_000, { agentMode: "ai" });
  // B: ลูกค้าเก่า (FB) ทักวันนี้ ทีมตอบเอง
  room("U-b", "มานี มีนา", { channel: "facebook" });
  msg("U-b", "in", "เมื่อวานค่ะ", NOON - 30 * HOUR);
  msg("U-b", "in", "โอนแล้วนะคะ", NOON - 2 * HOUR);
  msg("U-b", "out", "ได้รับแล้วค่ะ", NOON - 90 * 60_000, { operator: "chompoo", agentMode: "operator_ai_off" });
  // C: canary ต้องไม่ถูกนับ
  room("canary:probe", "canary");
  msg("canary:probe", "in", "ping", NOON - HOUR);
  // D: ติดธงรอคน ลูกค้าพิมพ์คนสุดท้าย ยังไม่มีใครตอบ
  room("U-d", "ประยุทธ มั่นคง");
  msg("U-d", "in", "ขอคุยกับคนจริงได้ไหม โทร 0812345678", NOON - 2 * HOUR);
  at(NOON - 2 * HOUR, () => db.setNeedsHuman("U-d", "human_requested", "ลูกค้าขอคุยกับคน"));
  // E: ลีดร้อน เงียบไปตั้งแต่เมื่อวาน ทีมยังไม่เคยทัก
  room("U-e", "วิภาวดี รุ่งเรือง");
  msg("U-e", "in", "ราคาเท่าไหร่คะ", NOON - 20 * HOUR);
  msg("U-e", "out", "9,900 บาทค่ะ", NOON - 19 * HOUR, { agentMode: "ai" });
  at(NOON - 19 * HOUR, () => db.recordScore("U-e", 9, JSON.stringify({ score: 9 })));
  // F: ลีดอุ่นทักวันนี้
  room("U-f", "สุดารัตน์", { channel: "facebook" });
  msg("U-f", "in", "สนใจค่ะ", NOON - HOUR);
  at(NOON - HOUR, () => db.recordScore("U-f", 6, JSON.stringify({ score: 6 })));
  msg("U-f", "out", "ยินดีค่ะ", NOON - HOUR + 30_000, { agentMode: "ai" });
  // G: ทักตามอัตโนมัติวันนี้ (ไม่ใช่ห้องที่ลูกค้าทัก)
  room("U-g", "กิตติ");
  msg("U-g", "in", "ขอคิดก่อน", NOON - 3 * DAY);
  msg("U-g", "out", "ได้เลยค่ะ", NOON - 3 * DAY + 60_000, { agentMode: "ai" });
  msg("U-g", "out", "มีอะไรให้ช่วยไหมคะ", NOON - 4 * HOUR, { agentMode: "ai", messageClass: "proactive" });
  // H: ลีดร้อนแต่คุยครั้งสุดท้าย 10 วันก่อน = ไม่ใช่ "7 วันล่าสุด"
  room("U-h", "เก่าแก่");
  msg("U-h", "in", "สนใจ", NOON - 10 * DAY);
  msg("U-h", "out", "ยินดีค่ะ", NOON - 10 * DAY + 60_000, { agentMode: "ai" });
  at(NOON - 10 * DAY, () => db.recordScore("U-h", 10, JSON.stringify({ score: 10 })));
  // การกระทำล่าสุด (audit) — YOLO จาก Telegram + ปิด AI จาก Telegram + ของเก่าเกิน 24 ชม.
  at(NOON - 50 * 60_000, () => db.addAudit({ operator: "telegram:ngoung", action: "yolo_sent", target: "U-a", detail: "telegram · hash=abc · \"ถามต่อเรื่องจำนวนพนักงาน\" · ส่ง 1/1 · FU cold 0→1/4 · AI on" }));
  at(NOON - 40 * 60_000, () => db.addAudit({ operator: "telegram:ngoung", action: "ai_toggle", target: "U-b", detail: "off · telegram" }));
  at(NOON - 30 * HOUR, () => db.addAudit({ operator: "telegram:ngoung", action: "ai_toggle", target: "U-e", detail: "off · telegram" }));
  at(NOON - 10 * 60_000, () => db.addAudit({ operator: "ngoung", action: "knowledge_update", target: "k1", detail: "ไม่เกี่ยว" }));
}

test("ข้อมูลสด: ตัวเลขกิจกรรมวันนี้ตรงกับ DB (ตัดตามเวลาไทย · ไม่นับ canary · ห้องต่อคน ไม่ใช่ต่อบอลลูน)", (t) => {
  const w = world(t);
  seedDay(w);
  const { facts } = buildOwnerSnapshot({ db: w.db, config: w.config, nowMs: NOON, logger: silent });
  assert.deepEqual(facts.today, {
    inboundRooms: 4, // A, B, D, F (canary ไม่นับ · B ทักเมื่อวานด้วยแต่นับวันนี้ครั้งเดียว)
    inboundMessages: 5,
    firstTimeRooms: 3, // A, D, F — B ทักครั้งแรกเมื่อวาน
    aiRooms: 2, // A, F (ข้อความทักตามของ G ไม่นับว่าตอบ)
    humanRooms: 1, // B
    proactiveRooms: 1, // G
  });
  assert.equal(facts.needsHuman, 1);
  // เทียบกับ SQL ตรง ๆ อีกชั้น — ตัวเลขห้ามมาจากที่อื่น
  const dayStart = Date.UTC(2026, 8, 27, 17, 0, 0);
  const raw = w.db.raw.prepare("SELECT COUNT(DISTINCT customer_id) AS n FROM messages WHERE direction='in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'").get(dayStart).n;
  assert.equal(facts.today.inboundRooms, raw);
});

test("ข้อมูลสด: รอบ/ที่นั่งมาจากหน้า 'ที่นั่ง' เท่านั้น — รอบวันนี้ติดป้าย · รอบผ่านไปแล้วหาย · ไฟล์เก่าไม่โผล่", (t) => {
  const w = world(t);
  const { facts, text } = buildOwnerSnapshot({ db: w.db, config: w.config, nowMs: NOON, logger: silent });
  assert.deepEqual(facts.rounds.map((round) => [round.date, round.enrolled, round.capacity, round.seatsLeft, round.today]), [
    ["2026-09-28", 14, 15, 1, true],
    ["2026-10-10", 7, 15, 8, false],
    ["2026-10-17", 12, null, null, false],
    ["2026-10-24", 12, 12, 0, false],
    ["2026-10-31", null, 15, null, false],
  ]);
  assert.match(text, /จันทร์ 28 ก\.ย\. 2026 — AI Agent for Business — เรียนวันนี้ \(ปิดรับสมัครแล้ว\) — ลงทะเบียน 14\/15 คน/u);
  assert.match(text, /เสาร์ 10 ต\.ค\. 2026 — AI Agent for Business — เปิดรับสมัคร — ลงทะเบียน 7\/15 คน เหลือ 8 ที่/u);
  assert.match(text, /เสาร์ 17 ต\.ค\. 2026 — AI Agent Workflow Automation — ใกล้เต็ม — ออนไลน์ ไม่จำกัดที่นั่ง ลงทะเบียน 12 คน/u);
  assert.match(text, /เสาร์ 24 ต\.ค\. 2026 — AI Agent for Business — เต็มแล้ว — ลงทะเบียน 12\/12 คน/u);
  assert.match(text, /เสาร์ 31 ต\.ค\. 2026 — AI Agent for Business — เปิดรับสมัคร — ความจุ 15 ที่ \(ยังไม่กรอกจำนวนคนลง\)/u);
  assert.ok(!text.includes("20 ก.ย."), "รอบที่ผ่านไปแล้วต้องไม่อยู่ในข้อมูลสด");
  assert.ok(!text.includes("คลาสจากไฟล์เก่า"), "หน้าที่นั่งมีรอบแล้ว = ไม่อ่านไฟล์เก่า");
  assert.match(text, /ราคาพิเศษมีจำนวนจำกัด/u, "บอกว่ากับลูกค้าลูกแพรพูดถึงรอบออนไลน์ยังไง");

  const none = world(t, { withRounds: false });
  writeFileSync(none.config.classRoundsFile, JSON.stringify({ seatsPerRound: 20, classes: {}, rounds: [] }), "utf8");
  const empty = buildOwnerSnapshot({ db: none.db, config: none.config, nowMs: NOON, logger: silent });
  assert.deepEqual(empty.facts.rounds, []);
  assert.match(empty.text, /ยังไม่มีรอบเรียนที่ประกาศในหน้า "ที่นั่ง"/u);
});

test("ข้อมูลสด: ห้องที่ลูกค้ารอคำตอบพร้อมเหตุ · ลีดร้อน 7 วันเรียงตามคะแนน · ชื่อปิดบางส่วน · เบอร์ถูกซ่อน", (t) => {
  const w = world(t);
  seedDay(w);
  const { facts, text } = buildOwnerSnapshot({ db: w.db, config: w.config, nowMs: NOON, logger: silent });
  assert.equal(facts.waiting.total, 1);
  assert.deepEqual(facts.waiting.rooms.map((room) => [room.name, room.channel, room.reason]), [["ประ***", "LINE", "ลูกค้าขอคุยกับคนจริง"]]);
  assert.match(text, /ประ\*\*\* \(LINE\) — รอ 2 ชม\. — ลูกค้าขอคุยกับคนจริง/u);
  assert.ok(!text.includes("0812345678"), "เบอร์ลูกค้าต้องไม่หลุดเข้าบริบท");
  assert.deepEqual(facts.hotLeads.map((lead) => [lead.name, lead.channel, lead.score]), [["วิภา***", "LINE", 9], ["สุดา***", "FB", 6]]);
  assert.match(text, /วิภา\*\*\* \(LINE\) — 9\/10 สนใจสูง — AI เปิด — ล่าสุด: ลูกแพรตอบ เมื่อวาน 17:00 \(ลูกค้ายังไม่ตอบกลับ\) — ทีมยังไม่เคยทัก/u);
  assert.ok(!text.includes("เก่าแก่"), "ลีดที่เงียบเกิน 7 วันไม่อยู่ในรายการ");
  // ปิดบางส่วนแบบเดียวกับรายการเลือกห้องใน Telegram (เห็น 3 ตัวแรก) — ชื่อเต็ม/นามสกุลต้องไม่หลุด
  for (const full of ["สมชาย", "มีนา", "ประยุทธ", "มั่นคง", "วิภาวดี", "รุ่งเรือง", "สุดารัตน์"]) assert.ok(!text.includes(full), `ห้ามชื่อเต็ม: ${full}`);
});

test("ข้อมูลสด: สิ่งที่สั่งผ่าน Telegram/YOLO ใน 24 ชม. (ไม่เอา audit อื่น) · สถานะหยุด AI ทั้งระบบ", (t) => {
  const w = world(t);
  seedDay(w);
  let snap = buildOwnerSnapshot({ db: w.db, config: w.config, nowMs: NOON, logger: silent });
  assert.deepEqual(snap.facts.actions.map((action) => action.text), [
    "ปิด AI → มานี*** (FB) · สั่งทาง Telegram",
    "YOLO ส่งแล้ว → สมช*** (LINE) · เรื่อง \"ถามต่อเรื่องจำนวนพนักงาน\" · สั่งทาง Telegram",
  ]);
  assert.match(snap.text, /ลูกแพรตอบลูกค้าตามปกติ/u);
  w.db.setSetting("ai_paused", "1");
  snap = buildOwnerSnapshot({ db: w.db, config: w.config, nowMs: NOON, logger: silent });
  assert.match(snap.text, /ลูกแพรถูกหยุดตอบลูกค้าทั้งระบบ/u);
});

test("ข้อมูลสด: กระชับ (ไม่เกินเพดานตัวอักษร) แม้ห้อง/รอบเยอะ และ DB อ่านพังไม่ล้ม", (t) => {
  const w = world(t);
  seedDay(w);
  for (let i = 0; i < 40; i += 1) {
    w.room(`U-many-${i}`, `ลูกค้าคนที่${i}`);
    w.msg(`U-many-${i}`, "in", "ขอข้อมูลหน่อยค่ะ ".repeat(10), NOON - 2 * HOUR);
    w.at(NOON - 2 * HOUR, () => w.db.recordScore(`U-many-${i}`, 8, JSON.stringify({ score: 8 })));
  }
  const { text, facts } = buildOwnerSnapshot({ db: w.db, config: w.config, nowMs: NOON, logger: silent });
  assert.ok(text.length <= OWNER_SNAPSHOT_MAX_CHARS, `ยาว ${text.length}`);
  assert.equal(facts.hotLeads.length, 5);
  assert.equal(facts.waiting.rooms.length, 5);
  assert.ok(facts.waiting.total >= 40);
  const broken = { ...w.db, getSetting() { throw new Error("boom"); }, raw: w.db.raw };
  const safe = buildOwnerSnapshot({ db: broken, config: w.config, nowMs: NOON, logger: silent });
  assert.equal(typeof safe.text, "string");
});

test("ข้อมูลสด: ห้องที่เพิ่งรอ (≤ 48 ชม.) ขึ้นก่อนห้องค้างธงเป็นเดือน แม้ห้องเก่ามีเรื่องเงิน · ยอดรวมยังนับครบ", (t) => {
  const w = world(t);
  seedDay(w);
  w.room("U-old", "เงินค้างนาน");
  w.msg("U-old", "in", "โอนแล้วนะคะ", NOON - 20 * DAY);
  w.at(NOON - 20 * DAY, () => w.db.setAiEnabled("U-old", false, "bank_sent"));
  const { facts, text } = buildOwnerSnapshot({ db: w.db, config: w.config, nowMs: NOON, logger: silent });
  assert.equal(facts.waiting.total, 2);
  assert.equal(facts.waiting.fresh, 1);
  assert.deepEqual(facts.waiting.rooms.map((room) => room.name), ["ประ***", "เงิน***"]);
  assert.match(text, /30 วันล่าสุด\): 2 ห้อง · ในนี้เพิ่งรอไม่เกิน 48 ชม\. 1 ห้อง/u);
  assert.match(text, /เงิน\*\*\* \(LINE\) — รอ 20 วัน — AI ปิด — ส่งเลขบัญชีแล้ว รอทีมดูแลเรื่องเงิน .* — \[มีเรื่องเงิน \(ส่งบัญชี\/รอโอน\)\]/u);
});
