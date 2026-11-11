// telegram-lesson-digest — บทเรียนรออนุมัติทาง Telegram ทุกคืน 22:00 (คำสั่งพี่ง้วง 28 ก.ย. 2026 เย็น)
// "แอดมินหรือทีมสอน → เข้าไปรอใน 'รออนุมัติ' … ให้พี่ง้วง สื่อสารผ่าน telegram ได้ไหม · ทุกวัน ส่งมา ให้พี่ง้วง approve ส่งสัก 22:00"
// · สรุป: เก่าสุดก่อน ≤ 10 เรื่อง บอกว่าเหลือกี่เรื่อง · ชื่อปิด เบอร์ซ่อน · ไม่มีเรื่องรอ = ไม่ส่ง
// · วันละครั้ง (รีสตาร์ตไม่ซ้ำ) · ดับตอน 22:00 = ส่งตอนกลับมาถึง 23:59 · ส่งไม่ถึง = ลองใหม่ 5 นาที
// · ปุ่ม: ทางเดียวกับคอนโซล · ตรวจสิทธิ์ใหม่ตอนกด · ปุ่มเก่า/แก้แล้ว = บอกสุภาพ ไม่ทำอะไร · คนอื่นกด = เงียบ
// Telegram เป็น stub ทั้งหมด (poisonGlobalFetch) — ไม่มีการส่งจริง
import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramControl } from "../src/telegramControl.mjs";
import {
  LESSON_DIGEST_DAY_KEY, LESSON_NONE_TEXT, LESSON_STALE_ALL_TEXT, LESSON_TEACH_OFF_TEXT, lessonDigestMode,
} from "../src/telegramLessonDigest.mjs";
import { buildOwnerSnapshot } from "../src/ownerChatSnapshot.mjs";
import { lessonTeachingKey } from "../src/ownerLessons.mjs";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// จันทร์ 28 ก.ย. 2026 22:00 เวลาไทย = 15:00 UTC
const TEN_PM = Date.UTC(2026, 8, 28, 15, 0, 0);
const FAKE_BOT = ["123456789", "AAfakeLessonDigestOnly_abcdefghijklmno"].join(":");
const OWNER_ID = 515151;
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function world(t, { teach = true, clock = { now: TEN_PM - 2 * HOUR }, db = null } = {}) {
  const ownDb = !db;
  const store = db ?? memoryDb({ now: () => clock.now });
  if (ownDb) {
    t.after(() => store.close());
    store.createOperator({ username: "ngoung", passHash: "x", displayName: "พี่ง้วง", role: "owner" });
    store.createOperator({ username: "chompoo", passHash: "x", displayName: "ชมพู่ แอดมิน", role: "operator" });
    store.upsertCustomer("U-a", { displayName: "สมชาย ใจดี" });
  }
  const config = testConfig({ CONSOLE_PUBLIC_BASE_URL: "https://console.example/console", TEACH_ENABLED: teach ? "true" : "false" });
  const api = [];
  // failSend: true/false หรือฟังก์ชันของลำดับครั้งที่ส่ง (ให้ส่งไม่ถึงเฉพาะบางข้อความได้)
  const net = { failSend: false };
  let messageId = 700;
  let sendAttempts = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = String(url).split("/").pop();
    const body = options.body ? JSON.parse(options.body) : {};
    const call = { method, body };
    api.push(call);
    if (method === "getMe") return json({ ok: true, result: { id: 7777, is_bot: true, username: "lukprae_owner_bot" } });
    if (method === "sendMessage") {
      sendAttempts += 1;
      if (typeof net.failSend === "function" ? net.failSend(sendAttempts) : net.failSend) {
        return json({ ok: false, error_code: 502, description: "Bad Gateway" }, 502);
      }
      messageId += 1;
      call.messageId = messageId;
      return json({ ok: true, result: { message_id: messageId } });
    }
    return json({ ok: true, result: true });
  };
  const yolo = { preflight: () => ({ refusal: null, confirm: [], warnings: [] }), run: async () => ({ ok: false, status: "refused", reason: "x", customer: null, warnings: [] }) };
  const control = createTelegramControl({ config, db: store, yolo, hermes: null, fetchImpl, logger: silent, now: () => clock.now });
  let updateId = 9000;
  const chat = { id: OWNER_ID, type: "private" };
  const say = (text) => control.handleUpdate({
    update_id: updateId += 1,
    message: { message_id: updateId, date: Math.floor(clock.now / 1000), text, from: { id: OWNER_ID, is_bot: false }, chat },
  });
  // ปุ่มที่กดมาจากข้อความไหน — Telegram ส่งข้อความนั้น (พร้อมชุดปุ่มปัจจุบัน) มากับ callback เสมอ
  const tap = (data, message, { fromId = OWNER_ID } = {}) => control.handleUpdate({
    update_id: updateId += 1,
    callback_query: {
      id: `cb-${updateId}`, data, from: { id: fromId, is_bot: false },
      message: { message_id: message.messageId, chat: { id: fromId, type: "private" }, reply_markup: { inline_keyboard: message.keyboard } },
    },
  });
  async function pair(username = "ngoung") {
    await control.saveToken(FAKE_BOT);
    const { code } = control.createPairing(username);
    await say(`/start ${code}`);
  }
  // ข้อความที่บอทส่งถึงจริง (พร้อม message_id ที่ stub ให้) ตั้งแต่ตำแหน่ง from
  const sentSince = (from = 0) => api.slice(from).filter((call) => call.method === "sendMessage" && call.messageId)
    .map((call) => ({ messageId: call.messageId, text: call.body.text, keyboard: call.body.reply_markup?.inline_keyboard || [] }));
  const lastText = () => sentSince().at(-1)?.text || "";
  let seq = 0;
  const lesson = ({ teaching, topic = "", createdBy = "chompoo", customerText = "", aiText = "", customerId = "" }) => {
    seq += 1;
    const saved = clock.now;
    clock.now = TEN_PM - 10 * DAY + seq * MIN; // สร้างเรียงตามลำดับ (เก่า → ใหม่)
    try {
      return store.addOwnerLesson({ teaching, teachingKey: lessonTeachingKey(teaching), topic, status: "pending", createdBy, customerText, aiText, customerId });
    } finally {
      clock.now = saved;
    }
  };
  const audits = () => store.raw.prepare("SELECT operator, action, target FROM admin_audit ORDER BY rowid").all()
    .map((row) => ({ ...row })).filter((row) => row.action.startsWith("lesson_"));
  return { db: store, clock, config, api, net, control, say, tap, pair, sentSince, lastText, lesson, audits, attempts: () => sendAttempts };
}

const buttonsOf = (keyboard) => keyboard.flat().map((button) => button.callback_data);
const shape = (keyboard) => buttonsOf(keyboard).map((value) => (value.startsWith("L:all:") ? "L:all" : value.split(":").slice(0, 3).join(":")));

test("สรุป 22:00: เก่าสุดก่อน ≤ 10 เรื่อง + เหลือกี่เรื่อง · ใครสอน/เมื่อไหร่ · บริบทชื่อปิด เบอร์ซ่อน · ปุ่มต่อเรื่อง + อนุมัติทั้งหมด · ลิงก์หน้าบทเรียน", async (t) => {
  const w = world(t);
  await w.pair();
  w.lesson({
    topic: "ที่จอดรถ", teaching: "ถ้าลูกค้าถามเรื่องที่จอดรถ ให้บอกว่าจอดใต้ตึกได้ฟรี 3 ชั่วโมง",
    customerText: "สมชาย ใจดี นะครับ โทร 0812345678 ที่จอดรถมีไหม", aiText: "มีค่ะคุณสมชาย เดี๋ยวแอดมินส่งแผนที่ให้ https://maps.example/x", customerId: "U-a",
  });
  for (let i = 2; i <= 12; i += 1) w.lesson({ topic: `เรื่องที่ ${i}`, teaching: `ถ้าลูกค้าถามเรื่องที่ ${i} ให้ตอบแบบสุภาพและสั้น` });

  w.clock.now = TEN_PM - MIN;
  assert.equal((await w.control.lessonDigestTick()).reason, "not_yet");
  assert.equal(w.sentSince(w.api.length).length, 0);

  w.clock.now = TEN_PM;
  const before = w.api.length;
  const result = await w.control.lessonDigestTick();
  assert.equal(result.total, 12);
  const pages = w.sentSince(before);
  assert.equal(pages.length, result.sent);
  const text = pages.map((page) => page.text).join("\n\n");
  assert.match(pages[0].text, /^📚 สรุปบทเรียนรออนุมัติประจำวัน — 12 เรื่อง\n\(แสดง 10 เรื่องที่รอนานที่สุดก่อน · เหลืออีก 2 เรื่อง/u);
  assert.match(text, /^1\) ที่จอดรถ\nสอน: "ถ้าลูกค้าถามเรื่องที่จอดรถ ให้บอกว่าจอดใต้ตึกได้ฟรี 3 ชั่วโมง"\nโดย ชมพู่ แอดมิน · 18 ก\.ย\. 22:01/mu);
  assert.match(text, /ลูกค้าพิมพ์: "สมช\*\*\* นะครับ โทร /u);
  assert.match(text, /ลูกแพรตอบเดิม: "มีค่ะคุณสมช\*\*\* เดี๋ยวแอดมินส่งแผนที่ให้ \[ลิงก์\]"/u);
  assert.ok(!text.includes("สมชาย ใจดี") && !text.includes("0812345678") && !text.includes("maps.example"));
  assert.match(text, /^10\) เรื่องที่ 10$/mu);
  assert.doesNotMatch(text, /เรื่องที่ 11|เรื่องที่ 12/u, "เรื่องที่ใหม่กว่า 10 เรื่องแรกรอรอบถัดไป");
  assert.match(pages.at(-1).text, /👉 https:\/\/console\.example\/console\/#\/lessons$/u);
  assert.ok(pages.every((page) => page.text.length <= 4096));

  const buttons = pages.flatMap((page) => buttonsOf(page.keyboard));
  assert.equal(buttons.filter((data) => data.startsWith("L:a:")).length, 10);
  assert.equal(buttons.filter((data) => data.startsWith("L:d:")).length, 10);
  assert.ok(buttons.every((data) => Buffer.byteLength(data) <= 64), "callback_data ไม่เกิน 64 ไบต์");
  assert.deepEqual(pages.at(-1).keyboard.at(-1).map((button) => button.text), ["✅ อนุมัติทั้งหมด"]);
  assert.deepEqual(pages[0].keyboard[0].map((button) => button.text), ["✅ อนุมัติ 1", "🗑 ไม่ใช้ 1"]);
  assert.equal(w.db.getSetting(LESSON_DIGEST_DAY_KEY), "2026-09-28");
  assert.equal(w.audits().length, 0, "ส่งรายการ ≠ ตัดสินอะไร");
});

test("วันละครั้ง: ไม่มีเรื่องรอ = ไม่ส่ง (วันนั้นจบ) · รีสตาร์ตไม่ส่งซ้ำ · ดับตอน 22:00 ส่งตอนกลับมาถึง 23:59 · ข้ามวันไม่ส่งย้อนหลัง", async (t) => {
  const w = world(t);
  await w.pair();
  w.clock.now = TEN_PM;
  let before = w.api.length;
  assert.equal((await w.control.lessonDigestTick()).reason, "none");
  assert.equal(w.sentSince(before).length, 0, "ไม่มีเรื่องรอ = ไม่ส่งอะไรเลย");
  w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องใบเสร็จ ให้บอกว่าออกได้ทุกคอร์ส" });
  w.clock.now = TEN_PM + 30 * MIN;
  assert.equal((await w.control.lessonDigestTick()).reason, "already", "ตรวจแล้ววันนี้ — เรื่องที่เพิ่งมารอรอบพรุ่งนี้");

  // วันถัดไป: ระบบดับตอน 22:00 กลับมา 23:30 = ยังส่งได้
  w.clock.now = TEN_PM + DAY - HOUR;
  assert.equal((await w.control.lessonDigestTick()).reason, "not_yet");
  w.clock.now = TEN_PM + DAY + 90 * MIN;
  before = w.api.length;
  assert.equal((await w.control.lessonDigestTick()).sent, 1);
  assert.match(w.sentSince(before)[0].text, /^📚 สรุปบทเรียนรออนุมัติประจำวัน — 1 เรื่อง/u);
  // รีสตาร์ต (ตัวควบคุมใหม่ ฐานเดิม) = ไม่ส่งซ้ำ
  const restarted = world(t, { db: w.db, clock: w.clock });
  w.clock.now = TEN_PM + DAY + 100 * MIN;
  assert.equal((await restarted.control.lessonDigestTick()).reason, "already");
  assert.equal(restarted.sentSince().length, 0);

  // วันที่สาม: ดับทั้งคืน กลับมา 00:05 = ไม่ส่งของเมื่อวานย้อนหลัง · คืนนั้น 23:59 ส่งได้
  w.clock.now = TEN_PM + 3 * DAY - 22 * HOUR + 5 * MIN;
  assert.equal((await w.control.lessonDigestTick()).reason, "not_yet");
  w.clock.now = TEN_PM + 3 * DAY + 119 * MIN;
  assert.equal((await w.control.lessonDigestTick()).sent, 1);
});

test("ส่งไม่ถึง = คืนสิทธิ์ ลองใหม่หลัง 5 นาที · สำเร็จแล้วไม่ส่งซ้ำ · ยังไม่จับคู่/บัญชีไม่มีสิทธิ์อนุมัติ = ไม่ส่ง", async (t) => {
  const w = world(t);
  w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องใบเสร็จ ให้บอกว่าออกได้ทุกคอร์ส" });
  w.clock.now = TEN_PM;
  assert.equal((await w.control.lessonDigestTick()).reason, "not_paired");
  await w.pair();
  w.net.failSend = true;
  assert.equal((await w.control.lessonDigestTick()).reason, "send_failed");
  assert.equal(w.db.getSetting(LESSON_DIGEST_DAY_KEY) ?? "", "", "คืนสิทธิ์ให้รอบถัดไป");
  w.net.failSend = false;
  w.clock.now = TEN_PM + 2 * MIN;
  assert.equal((await w.control.lessonDigestTick()).reason, "retry_wait");
  w.clock.now = TEN_PM + 6 * MIN;
  assert.equal((await w.control.lessonDigestTick()).sent, 1);
  w.clock.now = TEN_PM + 7 * MIN;
  assert.equal((await w.control.lessonDigestTick()).reason, "already");

  const staff = world(t);
  staff.lesson({ teaching: "ถ้าลูกค้าถามเรื่องใบเสร็จ ให้บอกว่าออกได้ทุกคอร์ส" });
  await staff.pair("chompoo");
  staff.clock.now = TEN_PM;
  assert.equal((await staff.control.lessonDigestTick()).reason, "no_approver");
  await staff.say("บทเรียนรออนุมัติ");
  assert.match(staff.lastText(), /ไม่มีสิทธิ์อนุมัติบทเรียน/u);
});

test("กดอนุมัติ/ไม่ใช้: ทางเดียวกับคอนโซล (audit ในนาม telegram:<บัญชี>) · ปุ่มเรื่องนั้นหาย · ยืนยันสั้น ๆ · กดซ้ำ/เรื่องถูกแก้ = บอกสุภาพ ไม่ทำอะไร", async (t) => {
  const w = world(t);
  await w.pair();
  const [a, b, c] = [
    w.lesson({ topic: "ที่จอดรถ", teaching: "ถ้าลูกค้าถามเรื่องที่จอดรถ ให้บอกว่าจอดใต้ตึกได้" }),
    w.lesson({ topic: "ใบเสร็จ", teaching: "ถ้าลูกค้าถามเรื่องใบเสร็จ ให้บอกว่าออกได้ทุกคอร์ส" }),
    w.lesson({ topic: "เด็ก", teaching: "ถ้าลูกค้าถามว่าเด็กเรียนได้ไหม ให้บอกว่า 15 ปีขึ้นไป" }),
  ];
  w.clock.now = TEN_PM;
  const start = w.api.length;
  await w.control.lessonDigestTick();
  const [digest] = w.sentSince(start);
  const data = (op, lesson) => buttonsOf(digest.keyboard).find((value) => value.startsWith(`L:${op}:${lesson.id}:`));

  let mark = w.api.length;
  await w.tap(data("a", a), digest);
  assert.equal(w.db.getOwnerLesson(a.id).status, "active");
  assert.equal(w.db.getOwnerLesson(a.id).decided_by, "ngoung");
  assert.deepEqual(w.audits(), [{ operator: "telegram:ngoung", action: "lesson_approved", target: a.id }]);
  assert.equal(w.lastText(), "✅ อนุมัติ \"ที่จอดรถ\" แล้วค่ะ — ลูกแพรใช้ตั้งแต่ข้อความถัดไป");
  const edit = w.api.slice(mark).find((call) => call.method === "editMessageReplyMarkup");
  assert.equal(edit.body.message_id, digest.messageId);
  assert.deepEqual(shape(edit.body.reply_markup.inline_keyboard),
    [`L:a:${b.id}`, `L:d:${b.id}`, `L:a:${c.id}`, `L:d:${c.id}`, "L:all"], "ปุ่มเรื่องที่ตัดสินแล้วหาย · เหลือ 2 เรื่อง = ยังมีอนุมัติทั้งหมด");

  const afterFirst = { messageId: digest.messageId, keyboard: edit.body.reply_markup.inline_keyboard };
  mark = w.api.length;
  await w.tap(data("d", b), afterFirst);
  assert.equal(w.db.getOwnerLesson(b.id), null, "ไม่ใช้ = ลบคำขอ (เหมือนปุ่มในคอนโซล)");
  assert.deepEqual(w.audits().at(-1), { operator: "telegram:ngoung", action: "lesson_declined", target: b.id });
  assert.equal(w.lastText(), "🗑 ไม่ใช้ \"ใบเสร็จ\" — ลบคำขอนี้แล้วค่ะ");
  const edit2 = w.api.slice(mark).find((call) => call.method === "editMessageReplyMarkup");
  assert.deepEqual(shape(edit2.body.reply_markup.inline_keyboard),
    [`L:a:${c.id}`, `L:d:${c.id}`], "เหลือเรื่องเดียว = ไม่มีปุ่มอนุมัติทั้งหมดแล้ว");

  const auditCount = w.audits().length;
  await w.tap(data("a", a), digest);
  assert.match(w.lastText(), /^บทเรียน "ที่จอดรถ" ถูกตัดสินไปแล้วค่ะ \(ตอนนี้ใช้อยู่\)/u);
  await w.tap(data("d", b), digest);
  assert.match(w.lastText(), /^บทเรียนนี้ไม่อยู่ในคิวแล้วค่ะ/u);
  w.db.updateOwnerLesson(c.id, { teaching: "ถ้าลูกค้าถามว่าเด็กเรียนได้ไหม ให้บอกว่า 12 ปีขึ้นไป", teachingKey: "x", topic: "เด็ก", channelId: null });
  await w.tap(data("a", c), digest);
  assert.match(w.lastText(), /ถูกแก้ไขหลังจากส่งรายการนี้/u);
  assert.equal(w.db.getOwnerLesson(c.id).status, "pending", "ฉบับที่พี่ง้วงยังไม่เห็นไม่ถูกอนุมัติ");
  assert.equal(w.audits().length, auditCount, "ปุ่มเก่าไม่เขียนอะไรเลย");
});

test("อนุมัติทั้งหมด: เฉพาะเรื่องในรายการที่ส่ง (เรื่องที่มาทีหลังไม่โดน) · ปุ่มทุกข้อความหาย · กดซ้ำ = ปุ่มเก่า", async (t) => {
  const w = world(t);
  await w.pair();
  const shown = [
    w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องที่จอดรถ ให้บอกว่าจอดใต้ตึกได้" }),
    w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องใบเสร็จ ให้บอกว่าออกได้ทุกคอร์ส" }),
    w.lesson({ teaching: "ถ้าลูกค้าถามว่าเด็กเรียนได้ไหม ให้บอกว่า 15 ปีขึ้นไป" }),
  ];
  w.clock.now = TEN_PM;
  const start = w.api.length;
  await w.control.lessonDigestTick();
  const [digest] = w.sentSince(start);
  const later = w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องผ่อนจ่าย ให้บอกว่าผ่อนได้ 3 เดือน" });
  w.db.deleteOwnerLesson(shown[2].id); // มีคนลบในคอนโซลระหว่างนั้น
  const all = buttonsOf(digest.keyboard).find((value) => value.startsWith("L:all:"));
  const mark = w.api.length;
  await w.tap(all, digest);
  assert.deepEqual(shown.slice(0, 2).map((lesson) => w.db.getOwnerLesson(lesson.id).status), ["active", "active"]);
  assert.equal(w.db.getOwnerLesson(later.id).status, "pending", "เรื่องที่พี่ง้วงยังไม่เห็นไม่ถูกอนุมัติ");
  assert.deepEqual(w.audits().map((row) => [row.operator, row.action]), [["telegram:ngoung", "lesson_approved"], ["telegram:ngoung", "lesson_approved"]]);
  assert.ok(w.api.slice(mark).some((call) => call.method === "editMessageReplyMarkup" && call.body.message_id === digest.messageId
    && call.body.reply_markup.inline_keyboard.length === 0));
  assert.equal(w.lastText(), "✅ อนุมัติแล้ว 2 เรื่องค่ะ — ลูกแพรใช้ตั้งแต่ข้อความถัดไป\n(ข้าม 1 เรื่องที่ถูกตัดสิน ลบ หรือแก้ไขไปแล้ว)\nยังมีบทเรียนรออนุมัติอีก 1 เรื่อง — พิมพ์ \"บทเรียนรออนุมัติ\" เพื่อดูต่อ");
  await w.tap(all, digest);
  assert.equal(w.lastText(), LESSON_STALE_ALL_TEXT);
  assert.equal(w.audits().length, 2);
});

test("สิทธิ์ตรวจใหม่ตอนกด: บัญชีที่จับคู่ถูกลดสิทธิ์/ปิด = ไม่ตัดสิน บอกให้ไปอนุมัติในคอนโซล · คนอื่นกดปุ่ม = เงียบ ไม่ทำอะไร", async (t) => {
  const w = world(t);
  await w.pair();
  const lesson = w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องที่จอดรถ ให้บอกว่าจอดใต้ตึกได้" });
  w.clock.now = TEN_PM;
  const start = w.api.length;
  await w.control.lessonDigestTick();
  const [digest] = w.sentSince(start);
  const approve = buttonsOf(digest.keyboard).find((value) => value.startsWith("L:a:"));

  const before = w.api.length;
  await w.tap(approve, digest, { fromId: 999_999 });
  assert.equal(w.api.length, before, "คนแปลกหน้ากด = ไม่มีแม้แต่ answerCallbackQuery");
  assert.equal(w.db.getOwnerLesson(lesson.id).status, "pending");

  w.db.raw.prepare("UPDATE operators SET role = 'operator' WHERE username = 'ngoung'").run();
  await w.tap(approve, digest);
  assert.match(w.lastText(), /ไม่มีสิทธิ์อนุมัติบทเรียนแล้วค่ะ — อนุมัติในคอนโซล เมนู "บทเรียน" นะคะ\n👉 https:\/\/console\.example\/console\/#\/lessons/u);
  assert.equal(w.db.getOwnerLesson(lesson.id).status, "pending");
  w.db.raw.prepare("UPDATE operators SET role = 'owner', disabled = 1 WHERE username = 'ngoung'").run();
  await w.tap(approve, digest);
  assert.match(w.lastText(), /ไม่มีสิทธิ์อนุมัติบทเรียน/u, "บัญชีถูกปิด = เหมือนไม่มีสิทธิ์");
  assert.equal(w.audits().length, 0);
});

test("คำสั่ง 'บทเรียนรออนุมัติ' / 'รออนุมัติ': ได้ทุกเวลา · ไม่มี = บอกว่าไม่มี · สวิตช์สรุปปิด = ไม่ส่ง 22:00 แต่คำสั่งยังได้ · ช่วยด้วยบอกคำสั่ง", async (t) => {
  const w = world(t);
  await w.pair();
  w.clock.now = TEN_PM - 12 * HOUR;
  await w.say("บทเรียนรออนุมัติ");
  assert.equal(w.lastText(), LESSON_NONE_TEXT);
  w.lesson({ topic: "ที่จอดรถ", teaching: "ถ้าลูกค้าถามเรื่องที่จอดรถ ให้บอกว่าจอดใต้ตึกได้" });
  for (const text of ["รออนุมัติ", "มีบทเรียนรออนุมัติไหม", "ขอดูบทเรียนที่รออนุมัติหน่อย"]) {
    const start = w.api.length;
    await w.say(text);
    const [list] = w.sentSince(start);
    assert.match(list.text, /^📚 บทเรียนรออนุมัติตอนนี้ 1 เรื่อง/u, text);
    assert.deepEqual(list.keyboard.map((row) => row.map((button) => button.text)), [["✅ อนุมัติ 1", "🗑 ไม่ใช้ 1"]], "เรื่องเดียว = ไม่มีปุ่มอนุมัติทั้งหมด");
  }

  await w.say("ช่วยด้วย");
  assert.match(w.lastText(), /📚 บทเรียนรออนุมัติ\n {3}ดูบทเรียนที่ทีมสอนลูกแพรไว้ แล้วกดอนุมัติ\/ไม่ใช้ในแชทนี้ได้เลย \(ถ้ามีเรื่องรอ ลูกแพรส่งสรุปให้ทุกคืน 22:00\)/u);
  w.db.setSetting("lesson_digest_mode", "off");
  await w.say("ช่วยด้วย");
  assert.ok(!w.lastText().includes("22:00"), "ปิดสรุปรายวัน = ไม่บอกว่าจะส่ง 22:00");
  w.clock.now = TEN_PM;
  assert.equal((await w.control.lessonDigestTick()).reason, "off");
  const start = w.api.length;
  await w.say("บทเรียนรออนุมัติ");
  assert.equal(w.sentSince(start).length, 1, "คำสั่งยังใช้ได้เมื่อปิดสรุปรายวัน");
  assert.equal(lessonDigestMode({ getSetting() { throw new Error("db down"); } }), "off", "อ่านสวิตช์พัง = ไม่ส่งเอง");
});

test("จอสอนปิด = ไม่มีสรุป ไม่มีปุ่มที่ใช้ได้ ไม่บอกคำสั่งใน 'ช่วยด้วย'", async (t) => {
  const w = world(t, { teach: false });
  await w.pair();
  w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องที่จอดรถ ให้บอกว่าจอดใต้ตึกได้" });
  w.clock.now = TEN_PM;
  assert.equal((await w.control.lessonDigestTick()).reason, "teach_off");
  await w.say("บทเรียนรออนุมัติ");
  assert.equal(w.lastText(), LESSON_TEACH_OFF_TEXT);
  await w.say("ช่วยด้วย");
  assert.ok(!w.lastText().includes("บทเรียนรออนุมัติ"));
});

test("สมองแชทรู้จำนวนบทเรียนรออนุมัติ (ข้อมูลสด) — จอสอนปิด = ไม่พูดถึง", (t) => {
  const w = world(t);
  w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องที่จอดรถ ให้บอกว่าจอดใต้ตึกได้" });
  w.lesson({ teaching: "ถ้าลูกค้าถามเรื่องใบเสร็จ ให้บอกว่าออกได้ทุกคอร์ส" });
  const on = buildOwnerSnapshot({ db: w.db, config: w.config, nowMs: TEN_PM, logger: silent });
  assert.equal(on.facts.lessonsPending, 2);
  assert.match(on.text, /บทเรียนที่ทีมสอนรอพี่ง้วงอนุมัติ: 2 เรื่อง — พี่ง้วงพิมพ์ "บทเรียนรออนุมัติ" ในแชทนี้เพื่อดูและกดอนุมัติ\/ไม่ใช้ได้ \(ลูกแพรส่งสรุปให้ทุกคืน 22:00 ด้วย\)/u);
  const off = buildOwnerSnapshot({ db: w.db, config: testConfig({ TEACH_ENABLED: "false" }), nowMs: TEN_PM, logger: silent });
  assert.equal(off.facts.lessonsPending, null);
  assert.doesNotMatch(off.text, /บทเรียน/u);
});

test("สรุปยาวหลายข้อความส่งไม่ถึงกลางทาง = ส่งต่อจากหน้าที่ค้างใน 5 นาที ไม่ส่งหน้าแรกซ้ำ (รีวิวโค้ด 28 ก.ย.) · อนุมัติทั้งหมดเก็บปุ่มทุกหน้า", async (t) => {
  const w = world(t);
  await w.pair();
  const long = (i) => `ถ้าลูกค้าถามเรื่องที่ ${i} ให้ตอบตามนี้ ${"รายละเอียดคำตอบที่ยาวมาก ".repeat(30)}`.slice(0, 590);
  for (let i = 1; i <= 10; i += 1) w.lesson({ topic: `เรื่องยาว ${i}`, teaching: long(i) });
  w.clock.now = TEN_PM;
  const start = w.api.length;
  const base = w.attempts();
  w.net.failSend = (attempt) => attempt === base + 2; // หน้าที่ 2 ส่งไม่ถึง
  assert.deepEqual(await w.control.lessonDigestTick(), { sent: 1, total: 10, reason: "partial" });
  w.net.failSend = false;
  w.clock.now = TEN_PM + 2 * MIN;
  assert.equal((await w.control.lessonDigestTick()).reason, "retry_wait");
  w.clock.now = TEN_PM + 6 * MIN;
  assert.equal((await w.control.lessonDigestTick()).reason, "resumed");
  const pages = w.sentSince(start);
  assert.ok(pages.length >= 2, "10 เรื่องยาวแบ่งหลายข้อความ");
  assert.ok(pages.every((page) => page.text.length <= 3500));
  assert.equal(pages.filter((page) => page.text.startsWith("📚 สรุปบทเรียนรออนุมัติประจำวัน")).length, 1, "หน้าแรกไม่ถูกส่งซ้ำ");
  assert.equal(pages.flatMap((page) => buttonsOf(page.keyboard)).filter((data) => data.startsWith("L:a:")).length, 10, "ครบทุกเรื่อง");
  const all = buttonsOf(pages.at(-1).keyboard).find((data) => data.startsWith("L:all:"));
  await w.tap(all, pages.at(-1));
  assert.match(w.lastText(), /^✅ อนุมัติแล้ว 10 เรื่องค่ะ/u);
  const cleared = new Set(w.api.filter((call) => call.method === "editMessageReplyMarkup").map((call) => call.body.message_id));
  assert.deepEqual([...cleared].sort(), pages.map((page) => page.messageId).sort(), "ปุ่มของทุกหน้าถูกเก็บ (รวมหน้าที่ส่งตอนต่อ)");
  w.clock.now = TEN_PM + 10 * MIN;
  assert.equal((await w.control.lessonDigestTick()).reason, "already");
});

test("หน้าที่ค้างของเมื่อคืนไม่ส่งย้อนหลัง (คืนถัดไปส่งชุดใหม่) · DB สะดุดตอนเตรียมสรุป = คืนสิทธิ์ ลองใหม่ใน 5 นาที", async (t) => {
  const w = world(t);
  await w.pair();
  const long = (i) => `ถ้าลูกค้าถามเรื่องที่ ${i} ให้ตอบตามนี้ ${"รายละเอียดคำตอบที่ยาวมาก ".repeat(30)}`.slice(0, 590);
  for (let i = 1; i <= 10; i += 1) w.lesson({ topic: `เรื่องยาว ${i}`, teaching: long(i) });
  w.clock.now = TEN_PM + 118 * MIN; // 23:58
  const base = w.attempts();
  w.net.failSend = (attempt) => attempt > base + 1;
  assert.equal((await w.control.lessonDigestTick()).reason, "partial");
  w.net.failSend = false;
  w.clock.now = TEN_PM + 123 * MIN; // 00:03 วันถัดไป
  assert.equal((await w.control.lessonDigestTick()).reason, "not_yet");
  const nextNight = w.api.length;
  w.clock.now = TEN_PM + DAY;
  const fresh = await w.control.lessonDigestTick();
  assert.equal(fresh.reason, undefined, "คืนใหม่ = ส่งชุดใหม่ทั้งชุด");
  const pages = w.sentSince(nextNight);
  assert.match(pages[0].text, /^📚 สรุปบทเรียนรออนุมัติประจำวัน — 10 เรื่อง/u, "ไม่มีหน้า (ต่อ) ของเมื่อคืนโผล่ก่อน");
  assert.equal(pages.filter((page) => page.text.startsWith("📚 บทเรียนรออนุมัติ (ต่อ)")).length, pages.length - 1);

  const hiccup = world(t);
  await hiccup.pair();
  hiccup.lesson({ teaching: "ถ้าลูกค้าถามเรื่องใบเสร็จ ให้บอกว่าออกได้ทุกคอร์ส" });
  const original = hiccup.db.countOwnerLessons;
  hiccup.db.countOwnerLessons = () => { throw new Error("database is locked"); };
  hiccup.clock.now = TEN_PM;
  assert.equal((await hiccup.control.lessonDigestTick()).reason, "send_failed");
  assert.equal(hiccup.db.getSetting(LESSON_DIGEST_DAY_KEY) ?? "", "", "ไม่เผาสิทธิ์ของคืนนี้");
  hiccup.db.countOwnerLessons = original;
  hiccup.clock.now = TEN_PM + 6 * MIN;
  assert.equal((await hiccup.control.lessonDigestTick()).sent, 1);
});
