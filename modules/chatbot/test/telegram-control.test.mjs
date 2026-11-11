// telegram-control — ช่องสั่งงานลูกแพรทาง Telegram: ใครสั่งได้ (จับคู่/หมดอายุ/เล่นซ้ำ), offset ของ
// long poll, โทเคนต้องไม่หลุดลง log/สถานะ, และคำสั่ง yolo/เลือกเลข/ยืนยัน/mini AI/เปิดปิด AI/สถานะ
// Telegram/โมเดลเป็น stub ทั้งหมด (poisonGlobalFetch) — ไม่มีการส่งจริงใด ๆ
import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramControl } from "../src/telegramControl.mjs";
import { TG_SETTING_BOT, TG_SETTING_OFFSET, TG_SETTING_OWNER } from "../src/telegramStore.mjs";
import { maskBotToken, redactBotSecrets } from "../src/telegramClient.mjs";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const NOON = Date.UTC(2026, 8, 28, 5, 0, 0);
const MIN = 60_000;
// โทเคนปลอมสำหรับเทสต์ (ประกอบจากชิ้น — ไม่มีรูป "ชื่อ token = ค่าจริง" ในซอร์ส)
const FAKE_BOT = ["123456789", "AAfakeUnitTestOnly_abcdefghijklmnopqrstu"].join(":");
const OWNER_ID = 424242;
const STRANGER_ID = 999001;

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function world(t, { yoloRun = null, preflight = null, parseText = null } = {}) {
  const clock = { now: NOON };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  const config = testConfig({ CONSOLE_PUBLIC_BASE_URL: "https://console.example/console" });
  const api = [];
  const updates = [];
  let failNext = null;
  const fetchImpl = async (url, options = {}) => {
    const method = String(url).split("/").pop();
    const body = options.body ? JSON.parse(options.body) : {};
    api.push({ method, body, url: String(url) });
    if (failNext) { const fail = failNext; failNext = null; return fail(); }
    if (method === "getMe") return json({ ok: true, result: { id: 7777, is_bot: true, username: "lukprae_owner_bot" } });
    if (method === "getUpdates") return json({ ok: true, result: updates.splice(0) });
    if (method === "sendMessage") return json({ ok: true, result: { message_id: 500 + api.length } });
    return json({ ok: true, result: true });
  };
  const runs = [];
  const yolo = {
    preflight: (id) => preflight?.(id) ?? { refusal: null, confirm: [], warnings: [], customer: null },
    run: async (args) => {
      runs.push(args);
      if (yoloRun) return yoloRun(args, runs.length);
      const row = db.getCustomer(args.customerId);
      return {
        ok: true, status: "sent", requestId: `r-${runs.length}`, sentText: "ขออนุญาตถามเพิ่มนิดนึงนะคะ\nทีมมีกี่ท่านคะ?",
        images: [], warnings: [], aiChanged: false, ladder: { stage: "cold", before: 0, after: 1, ladderLength: 4 },
        customer: { id: row.line_user_id, name: row.known_name || row.display_name, channel: row.channel_id === "facebook" ? "FB" : "LINE", aiEnabled: row.ai_enabled === 1, aiOffReason: row.ai_off_reason },
      };
    },
  };
  const parses = [];
  const hermes = {
    scoreCustomer: async (args) => {
      parses.push(args);
      return parseText == null ? null : { text: parseText, usage: { prompt_tokens: 50, completion_tokens: 10 }, model: "luna-mini" };
    },
  };
  const logs = [];
  const logger = Object.fromEntries(["log", "warn", "error", "debug", "info"].map((level) => [level, (...args) => logs.push(args.join(" "))]));
  const make = () => createTelegramControl({ config, db, yolo, hermes, fetchImpl, logger, now: () => clock.now });
  const control = make();
  let updateId = 1000;
  const msg = (text, { from = OWNER_ID, chatType = "private", dateMs = clock.now } = {}) => ({
    update_id: updateId += 1,
    message: { message_id: updateId, date: Math.floor(dateMs / 1000), text, from: { id: from, is_bot: false, first_name: "x" }, chat: { id: from, type: chatType } },
  });
  const tap = (data, { from = OWNER_ID } = {}) => ({
    update_id: updateId += 1,
    callback_query: { id: `cb-${updateId}`, data, from: { id: from, is_bot: false }, message: { message_id: 1, chat: { id: from, type: "private" } } },
  });
  const sent = () => api.filter((call) => call.method === "sendMessage").map((call) => call.body);
  const lastText = () => sent().at(-1)?.text || "";
  async function pair() {
    await control.saveToken(FAKE_BOT);
    const { code } = control.createPairing("ngoung");
    await control.handleUpdate(msg(`/start ${code}`));
    return code;
  }
  const room = (id, display, { channel = "default", at = clock.now - 30 * MIN } = {}) => {
    db.upsertCustomer(id, { displayName: display, channelId: channel });
    const mid = `in-${id}`;
    db.insertMessage({ id: mid, customerId: id, direction: "in", content: `ข้อความของ ${display}` });
    db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, mid);
    return id;
  };
  return {
    db, clock, api, updates, control, make, msg, tap, sent, lastText, pair, runs, parses, logs, room,
    failWith: (fn) => { failNext = fn; },
  };
}

test("บันทึกโทเคน: ตรวจรูป + getMe ก่อนเก็บ, คอนโซลเห็นแบบปิดบังเท่านั้น", async (t) => {
  const w = world(t);
  const bad = await w.control.saveToken("not-a-token");
  assert.equal(bad.ok, false);
  assert.equal(w.db.getSetting(TG_SETTING_BOT), null);
  w.failWith(() => json({ ok: false, error_code: 401, description: "Unauthorized" }, 401));
  assert.equal((await w.control.saveToken(FAKE_BOT)).status, 400, "Telegram ไม่รับ = ไม่เก็บ");
  const ok = await w.control.saveToken(FAKE_BOT);
  assert.equal(ok.ok, true);
  assert.equal(ok.botUsername, "lukprae_owner_bot");
  const view = w.control.view();
  assert.equal(view.tokenHint, "123456789:••••••••");
  assert.equal(view.configured, true);
  assert.ok(!JSON.stringify(view).includes(FAKE_BOT.split(":")[1]), "view ห้ามมีส่วนลับของโทเคน");
  assert.equal(maskBotToken("garbage"), "");
});

test("คนแปลกหน้า/ยังไม่จับคู่: ไม่ทำอะไร ไม่ตอบ และไม่ log เนื้อความ", async (t) => {
  const w = world(t);
  await w.control.saveToken(FAKE_BOT);
  w.room("U-a", "คุณทดสอบ");
  await w.control.handleUpdate(w.msg("yolo LINE คุณทดสอบ ถามต่อเรื่องลับสุดยอด", { from: STRANGER_ID }));
  await w.control.handleUpdate(w.tap("y:abc:ok", { from: STRANGER_ID }));
  assert.equal(w.sent().length, 0);
  assert.equal(w.runs.length, 0);
  assert.ok(!w.logs.join("\n").includes("ลับสุดยอด"), "ห้าม log ข้อความของคนอื่น");
  assert.ok(!w.logs.join("\n").includes(String(STRANGER_ID)), "ไม่ log id คนแปลกหน้า");
});

test("จับคู่: รหัสใช้ได้ครั้งเดียว · ผิดเกิน 5 ครั้งถูกทิ้ง · หมดอายุ 15 นาที · กลุ่มแชทใช้ไม่ได้", async (t) => {
  const w = world(t);
  await w.control.saveToken(FAKE_BOT);
  const { code } = w.control.createPairing("ngoung");
  await w.control.handleUpdate(w.msg(`/start ${code}`, { chatType: "group" }));
  assert.equal(w.db.getSetting(TG_SETTING_OWNER) || "", "", "กลุ่มแชทจับคู่ไม่ได้");
  await w.control.handleUpdate(w.msg("/start WRONG12345", { from: STRANGER_ID }));
  assert.equal(w.sent().length, 0, "รหัสผิด = เงียบ");
  await w.control.handleUpdate(w.msg(`/start ${code.toLowerCase()}`));
  assert.match(w.lastText(), /จับคู่สำเร็จแล้วค่ะพี่ง้วง/u);
  const owner = JSON.parse(w.db.getSetting(TG_SETTING_OWNER));
  assert.deepEqual({ userId: owner.userId, chatId: owner.chatId, pairedBy: owner.pairedBy }, { userId: String(OWNER_ID), chatId: String(OWNER_ID), pairedBy: "ngoung" });
  const audit = w.db.listAudit(5).find((row) => row.action === "telegram_paired");
  assert.equal(audit.operator, "ngoung");
  assert.ok(!audit.detail.includes(code) && !audit.detail.includes(String(OWNER_ID)));
  // เล่นซ้ำรหัสเดิมจากบัญชีอื่น = ไม่มีผล
  const before = w.sent().length;
  await w.control.handleUpdate(w.msg(`/start ${code}`, { from: STRANGER_ID }));
  assert.equal(w.sent().length, before);
  assert.equal(JSON.parse(w.db.getSetting(TG_SETTING_OWNER)).userId, String(OWNER_ID));

  const lock = world(t);
  await lock.control.saveToken(FAKE_BOT);
  const second = lock.control.createPairing("ngoung");
  for (let i = 0; i < 5; i += 1) await lock.control.handleUpdate(lock.msg(`/start BAD${i}XXXXXX`, { from: STRANGER_ID }));
  await lock.control.handleUpdate(lock.msg(`/start ${second.code}`));
  assert.equal(lock.db.getSetting(TG_SETTING_OWNER) || "", "", "ผิดครบ 5 ครั้ง = รหัสถูกทิ้ง ใช้รหัสถูกก็ไม่ได้แล้ว");
  assert.equal(lock.control.view().pairingLockedAt, NOON, "บอทเงียบกับทุกคนก่อนจับคู่ — คอนโซลต้องบอกว่ารหัสถูกยกเลิก");
  lock.control.createPairing("ngoung");
  assert.equal(lock.control.view().pairingLockedAt, null, "สร้างรหัสใหม่ = ล้างสถานะถูกยกเลิก");

  const late = world(t);
  await late.control.saveToken(FAKE_BOT);
  const third = late.control.createPairing("ngoung");
  late.clock.now += 16 * MIN;
  await late.control.handleUpdate(late.msg(`/start ${third.code}`));
  assert.equal(late.db.getSetting(TG_SETTING_OWNER) || "", "", "เกิน 15 นาที = หมดอายุ");
  assert.equal(late.control.view().pairing, null);
});

test("long poll: offset บันทึกก่อนทำคำสั่ง · update เก่า/ซ้ำถูกทิ้ง · รีสตาร์ตแล้วต่อจาก offset เดิม", async (t) => {
  let offsetSeenDuringRun = null;
  const w = world(t, {
    yoloRun: (args) => {
      offsetSeenDuringRun = w.db.getSetting(TG_SETTING_OFFSET);
      return { ok: false, status: "refused", reason: "do_not_disturb", reasonText: "DND", customer: null, warnings: [] };
    },
  });
  await w.pair();
  w.room("U-test", "คุณทดสอบ");
  const first = w.msg("yolo LINE คุณทดสอบ ทักทาย");
  w.updates.push(first);
  await w.control.pollOnce({ timeoutSec: 0 });
  assert.equal(offsetSeenDuringRun, String(first.update_id + 1), "ต้องบันทึก offset ก่อนเริ่มทำ (ดับกลางทาง = ไม่ทำซ้ำ)");
  assert.equal(w.runs.length, 1);
  const poll = w.api.filter((call) => call.method === "getUpdates").at(-1);
  assert.deepEqual(poll.body.allowed_updates, ["message", "callback_query"]);

  w.updates.push(first); // Telegram ส่งซ้ำ
  await w.control.pollOnce({ timeoutSec: 0 });
  assert.equal(w.runs.length, 1, "update ที่เคยทำแล้วห้ามทำซ้ำ");

  const restarted = w.make();
  await restarted.pollOnce({ timeoutSec: 0 });
  assert.equal(w.api.filter((call) => call.method === "getUpdates").at(-1).body.offset, first.update_id + 1);
});

test("โทเคนไม่หลุด: error 401/เครือข่ายที่แนบ URL ไม่ลง log และไม่ลงสถานะ · หยุดยิงด้วยโทเคนที่ถูกปฏิเสธ", async (t) => {
  const w = world(t);
  await w.control.saveToken(FAKE_BOT);
  w.failWith(() => { throw new TypeError(`fetch failed https://api.telegram.org/bot${FAKE_BOT}/getUpdates`); });
  const network = await w.control.pollOnce({ timeoutSec: 0 });
  assert.equal(network.reason, "network");
  w.failWith(() => json({ ok: false, error_code: 401, description: `Unauthorized bot${FAKE_BOT}` }, 401));
  const rejected = await w.control.pollOnce({ timeoutSec: 0 });
  assert.equal(rejected.errorCode, 401);
  const everything = [...w.logs, JSON.stringify(w.control.view()), w.db.getSetting("telegram_control_status"), JSON.stringify(rejected)].join("\n");
  assert.ok(!everything.includes(FAKE_BOT.split(":")[1]), "ส่วนลับของโทเคนห้ามปรากฏที่ไหนเลย");
  assert.match(w.control.view().lastError, /โทเคนใช้ไม่ได้แล้ว/u);
  const calls = w.api.length;
  assert.equal((await w.control.pollOnce({ timeoutSec: 0 })).reason, "token_rejected");
  assert.equal(w.api.length, calls, "โทเคนที่ Telegram ปฏิเสธแล้ว ห้ามยิงซ้ำจนกว่าจะเปลี่ยน");
  assert.equal(redactBotSecrets(`x ${FAKE_BOT} y`), "x [token] y");
});

test("เปลี่ยนโทเคนระหว่าง long poll: ผลของบอทเก่าถูกทิ้ง ไม่เขียน offset ให้บอทใหม่", async (t) => {
  const w = world(t);
  await w.control.saveToken(FAKE_BOT);
  const other = ["223456789", "AAsecondFakeBot_abcdefghijklmnopqrstu"].join(":");
  w.updates.push({ update_id: 900, message: { message_id: 1, date: Math.floor(NOON / 1000), text: "hi", from: { id: OWNER_ID }, chat: { id: OWNER_ID, type: "private" } } });
  w.failWith(async () => {
    await w.control.saveToken(other); // เจ้าของวางโทเคนใหม่ขณะ getUpdates ของบอทเก่ายังค้าง
    return json({ ok: true, result: [{ update_id: 900 }] });
  });
  const result = await w.control.pollOnce({ timeoutSec: 0 });
  assert.equal(result.reason, "token_changed");
  assert.equal(w.db.getSetting(TG_SETTING_OFFSET), "", "offset ของบอทใหม่ต้องยังว่าง");
});

test("yolo รูปแบบมาตรฐาน: เรียก YOLO ด้วยห้องที่ตัวหาชื่อเลือก + ตอบเป็นลูกแพร ชื่อปิดบัง + ลิงก์ห้อง", async (t) => {
  const w = world(t);
  await w.pair();
  w.room("U-test", "คุณทดสอบ");
  await w.control.handleUpdate(w.msg("yolo LINE คุณทดสอบ ถามต่อเรื่องจำนวนพนักงาน แล้วคุยต่อ"));
  assert.equal(w.runs.length, 1);
  assert.deepEqual(w.runs[0], {
    customerId: "U-test", instruction: "ถามต่อเรื่องจำนวนพนักงาน", actor: "telegram:ngoung", source: "telegram",
    alsoEnableAi: true, confirm: false,
  });
  const texts = w.sent().map((body) => body.text);
  assert.match(texts.at(-2), /กำลังอ่านห้องคุณ ท\*\*\* \(LINE\)/u);
  const reply = texts.at(-1);
  assert.match(reply, /^ส่งให้คุณ ท\*\*\* \(LINE\) แล้วค่ะพี่ง้วง 👇/u);
  assert.match(reply, /ขออนุญาตถามเพิ่มนิดนึงนะคะ\nทีมมีกี่ท่านคะ\?/u, "ต้องแสดงข้อความที่ส่งจริงทั้งหมด");
  assert.match(reply, /https:\/\/console\.example\/console\/#\/c\/U-test/u);
  assert.ok(!reply.includes("ทดสอบ"), "ชื่อลูกค้าห้องออกนอกระบบแบบเต็ม");
});

test("ชื่อซ้ำ: รายการให้เลือก (เลข/ปุ่ม) · ปุ่มใช้ครั้งเดียว · รายการหมดอายุ 10 นาที", async (t) => {
  const w = world(t);
  await w.pair();
  w.room("U-a1", "เอ", { at: NOON - 2 * 3_600_000 });
  w.room("U-a2", "เอ", { at: NOON - 5 * MIN });
  await w.control.handleUpdate(w.msg("yolo LINE คุณเอ ทักทาย"));
  const list = w.sent().at(-1);
  assert.match(list.text, /เจอ 2 ห้องที่ชื่อเข้ากับ/u);
  assert.match(list.text, /1\) เ\*\*\* · LINE · 5 นาทีก่อน · "ข้อความของ เอ"/u);
  const nonce = list.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
  assert.equal(w.runs.length, 0, "ยังไม่ส่งจนกว่าจะเลือก");
  await w.control.handleUpdate(w.tap(`y:${nonce}:2`));
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].customerId, "U-a1", "เลข 2 = ห้องที่คุยล่าสุดอันดับสอง");
  assert.equal(w.runs[0].instruction, "ทักทาย");
  await w.control.handleUpdate(w.tap(`y:${nonce}:1`));
  assert.equal(w.runs.length, 1, "กดซ้ำ/เล่นซ้ำ = ไม่มีผล");
  assert.match(w.lastText(), /ทำไปแล้วหรือหมดอายุแล้ว/u);

  await w.control.handleUpdate(w.msg("yolo LINE เอ ถามราคา"));
  await w.control.handleUpdate(w.msg("๑"));
  assert.equal(w.runs.at(-1).customerId, "U-a2", "พิมพ์เลขไทยก็เลือกได้");

  await w.control.handleUpdate(w.msg("yolo LINE เอ ถามราคา"));
  w.clock.now += 11 * MIN;
  const count = w.runs.length;
  await w.control.handleUpdate(w.msg("1"));
  assert.equal(w.runs.length, count, "เกิน 10 นาที = เลือกไม่ได้");
});

test("ชื่อตรงคนเดียวแต่มีชื่อคล้าย: yolo ต้องให้เลือกก่อน · สถานะไม่ต้อง", async (t) => {
  const w = world(t);
  await w.pair();
  w.room("U-ae", "เอ");
  w.room("U-aek", "เอก");
  await w.control.handleUpdate(w.msg("yolo LINE เอ ทักทาย"));
  assert.equal(w.runs.length, 0);
  assert.match(w.lastText(), /มีชื่อคล้าย/u);
  await w.control.handleUpdate(w.msg("สถานะ เอ"));
  assert.match(w.lastText(), /^🔎 คุณ เ\*\*\* \(LINE\)/u);
});

test("เดาจากชื่อบางส่วนได้ห้องเดียว: yolo/ปิด AI ต้องกดเลือกก่อน · สถานะดูได้เลย · เลขเกินรายการ = บอกช่วง", async (t) => {
  const w = world(t);
  await w.pair();
  w.room("U-pim", "พิมพ์ลดา");
  await w.control.handleUpdate(w.msg("yolo LINE ลดา ทักทาย"));
  assert.equal(w.runs.length, 0, "ชื่อบางส่วน = ห้ามส่งทันที");
  const ask = w.sent().at(-1);
  assert.match(ask.text, /ไม่มีห้องชื่อ "ลดา" ตรงตัวค่ะ/u);
  assert.match(ask.text, /1\) พิมพ์\*\*\* · LINE · /u);
  assert.equal(ask.reply_markup.inline_keyboard[0].length, 1);
  await w.control.handleUpdate(w.msg("3"));
  assert.match(w.lastText(), /มีให้เลือกแค่เลข 1 ค่ะ/u, "เลขเกินรายการต้องบอก ไม่ใช่เงียบ");
  assert.equal(w.runs.length, 0);
  await w.control.handleUpdate(w.msg("1"));
  assert.equal(w.runs.length, 1, "รายการยังอยู่หลังพิมพ์เลขผิด");
  assert.equal(w.runs[0].customerId, "U-pim");
  assert.equal(w.runs[0].instruction, "ทักทาย");

  const before = w.db.getCustomer("U-pim").ai_enabled;
  await w.control.handleUpdate(w.msg("ปิด AI ลดา"));
  assert.equal(w.db.getCustomer("U-pim").ai_enabled, before, "ยังไม่เลือก = ยังไม่แตะสวิตช์");
  assert.match(w.lastText(), /ไม่มีห้องชื่อ "ลดา" ตรงตัว/u);
  await w.control.handleUpdate(w.msg("ยกเลิก"));
  await w.control.handleUpdate(w.msg("สถานะ ลดา"));
  assert.match(w.lastText(), /^🔎 คุณ /u, "ดูสถานะไม่เปลี่ยนอะไร = ไม่ต้องถาม");
});

test("ขอบชื่อกำกวม: ให้เลือกพร้อม 'เรื่อง' ของแต่ละตัวเลือก และส่งด้วยคำสั่งของตัวที่เลือก", async (t) => {
  const w = world(t);
  await w.pair();
  w.room("U-a", "สมชาย", { at: NOON - 5 * MIN });
  w.room("U-b", "สมชาย ใจดี", { at: NOON - 60 * MIN });
  await w.control.handleUpdate(w.msg("yolo LINE สมชาย ใจดีมาก ขอบคุณที่ทัก"));
  assert.equal(w.runs.length, 0);
  const list = w.sent().at(-1);
  assert.match(list.text, /อ่านได้มากกว่าหนึ่งแบบ/u);
  assert.match(list.text, /↳ เรื่อง: มาก ขอบคุณที่ทัก/u);
  assert.match(list.text, /↳ เรื่อง: ใจดีมาก ขอบคุณที่ทัก/u);
  const nonce = list.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
  await w.control.handleUpdate(w.tap(`y:${nonce}:2`));
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].customerId, "U-a");
  assert.equal(w.runs[0].instruction, "ใจดีมาก ขอบคุณที่ทัก");
});

test("เส้นเงิน: YOLO ขอยืนยัน → ปุ่มยืนยัน = ส่งด้วย confirm:true · พิมพ์ 'ยืนยัน' ก็ได้", async (t) => {
  const w = world(t, {
    preflight: () => ({ refusal: null, confirm: [{ code: "money_line", text: "เส้นเงิน" }], warnings: [] }),
    yoloRun: (args) => (args.confirm
      ? { ok: true, status: "sent", sentText: "ข้อความ", images: [], warnings: [], customer: { id: args.customerId, name: "ทดสอบ", channel: "LINE", aiEnabled: false, aiOffReason: "bank_sent" } }
      : { ok: false, status: "needs_confirmation", reason: "money_line", reasonText: "เส้นเงิน", confirm: [{ code: "money_line", text: "ห้องนี้อยู่ในเส้นเงิน" }], warnings: [], customer: { id: args.customerId, name: "ทดสอบ", channel: "LINE" } }),
  });
  await w.pair();
  w.room("U-money", "ทดสอบ");
  await w.control.handleUpdate(w.msg("yolo LINE ทดสอบ ทักทาย"));
  const ask = w.sent().at(-1);
  assert.match(ask.text, /ขอยืนยันก่อนนะคะ/u);
  assert.ok(!w.sent().some((body) => /กำลังอ่านห้อง/u.test(body.text)), "ยังไม่ยืนยัน = ไม่บอกว่ากำลังร่าง");
  const nonce = ask.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
  await w.control.handleUpdate(w.tap(`y:${nonce}:ok`));
  assert.equal(w.runs.at(-1).confirm, true);
  assert.match(w.lastText(), /^ส่งให้คุณ/u);

  await w.control.handleUpdate(w.msg("yolo LINE ทดสอบ ทักทายอีกครั้ง"));
  await w.control.handleUpdate(w.msg("ยืนยัน"));
  assert.equal(w.runs.at(-1).confirm, true);
  await w.control.handleUpdate(w.msg("yolo LINE ทดสอบ ทักทาย"));
  await w.control.handleUpdate(w.msg("ยกเลิก"));
  assert.equal(w.lastText(), "ยกเลิกแล้วค่ะ 👌");
});

test("ภาษาพูด → mini AI: ทวนความเข้าใจให้กดยืนยันก่อน · ชื่อที่โมเดลแต่งเอง = ไม่ทำ", async (t) => {
  const w = world(t, { parseText: "{\"action\":\"yolo\",\"channel\":null,\"customerQuery\":\"ทดสอบ\",\"instruction\":\"ถามว่าสนใจรอบหน้าไหม\",\"alsoEnableAi\":false}" });
  await w.pair();
  w.room("U-test", "คุณทดสอบ");
  await w.control.handleUpdate(w.msg("ช่วยทักคุณทดสอบหน่อยว่าสนใจรอบหน้าไหม"));
  assert.equal(w.parses.length, 1);
  assert.match(w.parses[0].system, /Never invent a customer/u);
  const ask = w.sent().at(-1);
  assert.match(ask.text, /ลูกแพรเข้าใจว่า 👇\n⚡ yolo → คุณ ท\*\*\* \(LINE\)\nเรื่อง: ถามว่าสนใจรอบหน้าไหม/u);
  assert.equal(w.runs.length, 0, "คำสั่งจากโมเดลห้ามส่งก่อนพี่ง้วงยืนยัน");
  const nonce = ask.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1];
  await w.control.handleUpdate(w.tap(`y:${nonce}:ok`));
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].instruction, "ถามว่าสนใจรอบหน้าไหม");
  const usage = w.db.raw.prepare("SELECT kind FROM llm_usage").all().map((row) => row.kind);
  assert.deepEqual(usage, ["score"]);

  const invent = world(t, { parseText: "{\"action\":\"yolo\",\"customerQuery\":\"สมชาย\",\"instruction\":\"x\"}" });
  await invent.pair();
  invent.room("U-s", "สมชาย");
  await invent.control.handleUpdate(invent.msg("ช่วยทักลูกค้าคนเมื่อเช้าหน่อย"));
  assert.equal(invent.runs.length, 0);
  assert.match(invent.lastText(), /ยังไม่เข้าใจคำสั่งนี้/u);

  const cheap = world(t, { parseText: "{}" });
  await cheap.pair();
  await cheap.control.handleUpdate(cheap.msg("โอ"));
  assert.equal(cheap.parses.length, 0, "ข้อความสั้นมากไม่ต้องเสียค่าโมเดล");
});

test("เปิด/ปิด AI: เส้นเดียวกับคอนโซล + audit · สั่งซ้ำสถานะเดิม = ไม่เขียนซ้ำ", async (t) => {
  const w = world(t);
  await w.pair();
  w.room("U-sw", "คุณทดสอบ");
  await w.control.handleUpdate(w.msg("ปิด AI LINE คุณทดสอบ"));
  let row = w.db.getCustomer("U-sw");
  assert.equal(row.ai_enabled, 0);
  assert.equal(row.ai_off_reason, "manual");
  assert.match(w.lastText(), /🔴 ปิด AI ห้องคุณ ท\*\*\* \(LINE\) แล้วค่ะ/u);
  await w.control.handleUpdate(w.msg("ปิด AI LINE คุณทดสอบ"));
  assert.match(w.lastText(), /AI ปิดอยู่แล้วค่ะ/u);
  const toggles = w.db.listAudit(20).filter((a) => a.action === "ai_toggle");
  assert.equal(toggles.length, 1);
  assert.equal(toggles[0].operator, "telegram:ngoung");
  assert.equal(toggles[0].detail, "off · telegram");
  w.db.setNeedsHuman("U-sw", "human_requested", "x");
  await w.control.handleUpdate(w.msg("เปิด AI คุณทดสอบ"));
  row = w.db.getCustomer("U-sw");
  assert.equal(row.ai_enabled, 1);
  assert.equal(row.state, "AI_ACTIVE", "เปิด AI = ล้างธงรอคน เหมือนปุ่มคอนโซล");
});

test("สถานะ: AI + เหตุ, เวลาลูกค้า/ทีมล่าสุด, FU, 3 ข้อความล่าสุด (ย่อ) + ลิงก์", async (t) => {
  const w = world(t);
  await w.pair();
  w.room("U-st", "คุณทดสอบ");
  w.db.insertMessage({ id: "o1", customerId: "U-st", direction: "out", content: "ยินดีค่ะ ".repeat(20) });
  w.db.insertMessage({ id: "o2", customerId: "U-st", direction: "out", content: "ชมพู่รับเรื่องค่ะ", operator: "chompoo" });
  w.db.setAiEnabled("U-st", false, "handoff_private_inhouse");
  await w.control.handleUpdate(w.msg("สถานะ คุณทดสอบ"));
  const text = w.lastText();
  assert.match(text, /AI: 🔴 ปิด — ส่งต่องาน In-house\/Private ให้ทีมแล้ว/u);
  assert.match(text, /ทีมตอบล่าสุด: เมื่อสักครู่/u);
  assert.match(text, /FU อัตโนมัติ: /u);
  assert.match(text, /3 ข้อความล่าสุด:\n👤 ลูกค้า: ข้อความของ คุณทดสอบ\n🤖 ลูกแพร: ยินดีค่ะ/u);
  assert.match(text, /🙋 ทีม: ชมพู่รับเรื่องค่ะ/u);
  assert.match(text, /…/u, "ข้อความยาวถูกย่อ");
  assert.match(text, /#\/c\/U-st/u);
});

test("คำสั่งค้างนานระหว่างระบบดับ = ข้ามพร้อมบอก · ไม่พบชื่อ = เสนอชื่อใกล้เคียง · help", async (t) => {
  const w = world(t);
  await w.pair();
  w.room("U-somchai", "สมชาย");
  await w.control.handleUpdate(w.msg("yolo LINE สมชาย ทักทาย", { dateMs: NOON - 15 * MIN }));
  assert.equal(w.runs.length, 0);
  assert.match(w.lastText(), /ลูกแพรขอข้ามไว้ก่อน/u);
  await w.control.handleUpdate(w.msg("yolo LINE สมชัย ทักทาย"));
  assert.match(w.lastText(), /ไม่พบห้องชื่อ "สมชัย" ใน LINE/u);
  assert.match(w.lastText(), /1\) สมช\*\*\*/u);
  await w.control.handleUpdate(w.msg("ช่วยด้วย"));
  assert.match(w.lastText(), /yolo LINE คุณเอ ถามต่อเรื่องจำนวนพนักงาน/u);
  await w.control.handleUpdate(w.msg("/start"));
  assert.match(w.lastText(), /ลูกแพรพร้อมรับคำสั่ง/u);
  await w.control.handleUpdate(w.msg("yolo LINE"));
  assert.match(w.lastText(), /ขอชื่อลูกค้าด้วยนะคะ/u);
});

test("ตัวรับข้อความ: ไม่มีโทเคน = ไม่ยิง Telegram · ใส่โทเคนแล้วปลุกให้เริ่มรับ · stop หยุดจริง", async (t) => {
  const w = world(t);
  const control = w.make();
  control.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.api.filter((call) => call.method === "getUpdates").length, 0, "ยังไม่มีโทเคน = ไม่ยิงเลย");
  await control.saveToken(FAKE_BOT);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(w.api.some((call) => call.method === "getUpdates"), "บันทึกโทเคนแล้วต้องเริ่มรับทันที");
  control.stop();
  assert.equal(control.running, false);
});
