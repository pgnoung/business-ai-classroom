// hot-followup-push.test.mjs — push แจ้งทีม "ไม้ต่อจากลูกแพร" 09:10 / 13:10 / 18:10 (29 ก.ย. 2026 · ไม้ต่อ 3 พ.ย. 2026)
// พี่ง้วง: "push message เข้าแอดมินทุกคน ... สรุปมาว่ามีกี่ห้องที่ HOT แล้ว รอแอดมินไปตอบ ไปขุด ... gentle reminder
// ให้รู้ว่ารีบคุยน๊า ในตอนที่ลูกค้ากำลังสนใจสุด ๆ (ให้รู้ว่าเตือน แต่เอาแบบนุ่มนวล)"
import test from "node:test";
import assert from "node:assert/strict";
import {
  HOT_FOLLOWUP_PUSH_LAST_SLOT_KEY, HOT_FOLLOWUP_PUSH_MODE_KEY, buildHotFollowupPushText, createHotFollowupPush, gentleReminder,
} from "../src/hotFollowupPush.mjs";
import { memoryDb, testConfig } from "./helpers.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const bkk = (d, h, m) => Date.UTC(2026, 8, d, h - 7, m, 0); // เวลาไทย ก.ย. 2026
const ADMIN_A = `U${"a".repeat(32)}`;
const ADMIN_B = `U${"b".repeat(32)}`;
const silent = { log() {}, debug() {}, error() {} };

function setup({ rooms = true } = {}) {
  let clock = bkk(30, 9, 11);
  const db = memoryDb({ now: () => clock });
  const at = (ms, fn) => { const keep = clock; clock = ms; try { return fn(); } finally { clock = keep; } };
  const t0 = clock;
  if (rooms) {
    at(t0 - 20 * DAY, () => db.upsertCustomer("U-hot", { displayName: "คุณเอ\nปลอมเสียงระบบ\u202e\u0085" }));
    at(t0 - 20 * DAY, () => db.recordScore("U-hot", 9, "{}"));
    at(t0 - 3 * DAY, () => db.insertMessage({ customerId: "U-hot", direction: "in", content: "สนใจค่ะ" }));
    at(t0 - 3 * DAY + MIN, () => db.insertMessage({ customerId: "U-hot", direction: "out", content: "ยินดีค่ะ", agentMode: "ai" }));
    at(t0 - 20 * DAY, () => db.upsertCustomer("facebook:1", { displayName: "เฟซบุ๊กใกล้หมด", channelId: "facebook" }));
    at(t0 - 20 * DAY, () => db.recordScore("facebook:1", 8, "{}"));
    at(t0 - 6.8 * DAY, () => db.insertMessage({ customerId: "facebook:1", direction: "in", content: "ราคาเท่าไหร่คะ" }));
    at(t0 - 6.8 * DAY + MIN, () => db.insertMessage({ customerId: "facebook:1", direction: "out", content: "แจ้งราคาค่ะ", agentMode: "ai" }));
  }
  // สองสาขาตั้งรายชื่อไว้ซ้อนกัน — คนเดียวกันต้องได้ข้อความเดียว
  db.setSetting("escalate_notify:default", JSON.stringify([ADMIN_A, ADMIN_B]));
  db.setSetting("escalate_notify:facebook", JSON.stringify([ADMIN_A]));
  const sends = [];
  const lineRegistry = {
    channels: [{ id: "default", name: "LINE", provider: "line" }, { id: "facebook", name: "Facebook", provider: "facebook" }],
    forChannel: (id) => ({
      sendBubbles: async (args) => { sends.push({ channel: id, ...args }); return { ok: true }; },
    }),
  };
  const config = testConfig({ CONSOLE_PUBLIC_BASE_URL: "https://console.example/console" });
  const push = createHotFollowupPush({ config, db, lineRegistry, logger: silent, now: () => clock, intervalMs: 0 });
  return { db, push, sends, setClock: (ms) => { clock = ms; }, t0 };
}

test("รอบ 09:10: ส่งสรุปถึงแอดมินทุกคน (ไม่ซ้ำคน) ครั้งเดียวต่อรอบ ทาง LINE OA หลัก", async () => {
  const { db, push, sends } = setup();
  const result = await push.runDue();
  assert.equal(result.sent, 2);
  assert.equal(result.rooms, 2);
  assert.deepEqual(sends.map((s) => s.to).sort(), [ADMIN_A, ADMIN_B]);
  assert.ok(sends.every((s) => s.channel === "default" && s.purpose === "team_alert" && s.bubbles.length === 1));
  const text = sends[0].bubbles[0].text;
  assert.match(text, /🤝 ไม้ต่อจากลูกแพร 2 ห้อง \(เกินเวลา 2 · ควรต่อแล้ว 0 · ยังทัน 0\) · รอบ 09:10/u);
  assert.match(text, /เป้าต่อภายใน 3 ชม\. เส้นตาย 6 ชม\./u);
  assert.match(text, /⏰ ถึงเวลาต่อแล้ว\n· คุณคุณเอ ปลอมเสียงระบบ \(LINE · เกินเวลา/u, "ห้องที่เลยเส้นตายอยู่กลุ่มถึงเวลาต่อ");
  assert.match(text, /⏳ Facebook ใกล้หมดเวลาตอบ[\s\S]*คุณเฟซบุ๊กใกล้หมด/u, "ห้อง FB ที่เหลือไม่ถึงวันขึ้นหัวรายการ");
  assert.match(text, /คุณคุณเอ ปลอมเสียงระบบ \(/u, "ชื่อลูกค้ายุบขึ้นบรรทัดใหม่ ปลอมเป็นข้อความระบบไม่ได้");
  assert.doesNotMatch(text, /[\u202e\u0085]/u, "ตัดอักขระกลับทิศ/ควบคุมออกจากชื่อ");
  assert.match(text, /https:\/\/console\.example\/console\/#\/chat\/hotfollow\/U-hot/, "ลิงก์เปิดห้องในคิวไม้ต่อ");
  assert.match(text, /ไล่ต่อทีละห้อง 👉 https:\/\/console\.example\/console\/#\/chat\/hotfollow$/mu);
  assert.match(text, /กดเสร็จสิ้นไม่นับ/u);
  assert.match(text, /รีบทักหน่อยน้า/u, "เช้า = คำเตือนนุ่ม ๆ ของรอบเช้า");
  // 30 ก.ย. 2026 (พี่ง้วง): คำเตือน/วิธีทำ/ลิงก์ไล่ทัก ขึ้นก่อน แล้วค่อยรายชื่อแต่ละห้อง · ไม่มีคำ ร้อน/อุ่น/เย็น
  assert.ok(text.indexOf("รีบทักหน่อยน้า") < text.indexOf("⏳ Facebook ใกล้หมดเวลาตอบ"), "คำเตือนอยู่เหนือรายชื่อ");
  assert.ok(text.indexOf("ไล่ต่อทีละห้อง 👉") < text.indexOf("· คุณ"), "ลิงก์ไล่ต่ออยู่เหนือรายชื่อ");
  assert.doesNotMatch(text, /ร้อน|อุ่น ๆ|เย็นลง/u);
  assert.match(text, /พิมพ์คุยกับลูกค้าแล้วห้องจะหายจากรายการเอง/u);
  assert.equal((await push.runDue()).reason, "not_due", "รอบเดียวกันห้ามส่งซ้ำ");
  assert.equal(sends.length, 2);
  const audit = db.listAudit(10).find((row) => row.action === "hot_followup_push");
  assert.ok(audit, "มีร่องรอยในประวัติระบบ");
  assert.match(audit.detail, /ไม้ต่อ 2 ห้อง \(เกินเวลา 2 · FB ใกล้หมดเวลา 1\) · ส่งถึงทีม 2\/2 คน/u);
});

test("เครื่องเพิ่งเริ่มหลังรอบไปนาน (deploy/ล่ม) = ข้ามรอบนั้น ไม่ส่งรอบ 09:10 ตอนเกือบเที่ยง", async () => {
  const { db, push, sends, setClock } = setup();
  setClock(bkk(30, 11, 40));
  const result = await push.runDue();
  assert.equal(result.reason, "too_late");
  assert.equal(sends.length, 0);
  assert.equal(Number(db.getSetting(HOT_FOLLOWUP_PUSH_LAST_SLOT_KEY)), bkk(30, 9, 10));
  setClock(bkk(30, 13, 12));
  assert.equal((await push.runDue()).sent, 2, "รอบถัดไปตรงเวลา ส่งตามปกติ");
});

test("วันอาทิตย์ / วันที่อยู่ในรายการวันหยุด (นักขัตฤกษ์ หรือชมพู่ไม่มา) = ไม่ส่ง และไม่จองรอบ", async () => {
  const sunday = setup();
  sunday.setClock(bkk(27, 9, 11)); // อาทิตย์ 27 ก.ย. 2026
  assert.equal((await sunday.push.runDue()).reason, "off_day");
  assert.equal(sunday.sends.length, 0);
  assert.equal(sunday.db.getSetting(HOT_FOLLOWUP_PUSH_LAST_SLOT_KEY) ?? null, null, "ไม่จองรอบ");
  const leave = setup();
  leave.db.setSetting("kpi_holidays", "2026-09-30");
  assert.equal((await leave.push.runDue()).reason, "off_day");
  assert.equal(leave.sends.length, 0);
});

test("รอบ 18:10 ก่อนปิดวัน (หลัง 18:00) ของวันทำงานยังส่ง — ดูวันทำงาน ไม่ใช่เวลาทำการ", async () => {
  const { push, sends, setClock } = setup();
  setClock(bkk(30, 18, 11));
  const result = await push.runDue();
  assert.equal(result.sent, 2);
  assert.match(sends[0].bubbles[0].text, /ก่อนปิดวัน/u);
});

test("ไม่มีห้องค้าง = ไม่ส่ง · สวิตช์ปิด = ไม่ส่ง", async () => {
  const empty = setup({ rooms: false });
  assert.equal((await empty.push.runDue()).reason, "no_rooms");
  assert.equal(empty.sends.length, 0);
  const off = setup();
  off.db.setSetting(HOT_FOLLOWUP_PUSH_MODE_KEY, "off");
  assert.equal((await off.push.runDue()).reason, "switch_off");
  assert.equal(off.sends.length, 0);
});

test("ข้อความ: เกิน 8 ห้องบอกจำนวนที่เหลือ · ตัวชี้วัด 7 วัน · คำเตือนต่างกันตามรอบ", () => {
  const now = bkk(30, 18, 10);
  const rooms = Array.from({ length: 10 }, (_, i) => ({
    id: `U-${i}`, name: `ลูกค้า${i}`, channelName: "LINE", silentMs: (i + 1) * DAY, fbHumanUntil: null,
  }));
  const text = buildHotFollowupPushText({
    hot: { total: 10, rooms }, slotMs: now, now,
    rate: { windowDays: 7, relay: { decided: 12, touched: 3, within3Pct: 17, within6Pct: 25 } },
  });
  assert.match(text, /…และอีก 2 ห้อง/u);
  assert.match(text, /7 วันที่ผ่านมา ทีมต่อทันใน 6 ชม\. 25% · ทันใน 3 ชม\. 17% \(ต่อแล้ว 3 จาก 12 ไม้\)/u);
  assert.doesNotMatch(text, /👉/u, "ไม่มี URL คอนโซล = ไม่มีลิงก์");
  assert.match(text, /ก่อนปิดวัน/u);
  assert.notEqual(gentleReminder(bkk(30, 9, 10)), gentleReminder(bkk(30, 13, 10)));
  assert.notEqual(gentleReminder(bkk(30, 13, 10)), gentleReminder(bkk(30, 18, 10)));
});
