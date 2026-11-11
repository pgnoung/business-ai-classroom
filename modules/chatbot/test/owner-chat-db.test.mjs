// owner-chat-db — ความจำของ "คุยกับลูกแพร" ทาง Telegram (ตาราง owner_chat_turns ใหม่ แบบเติมอย่างเดียว)
// เก็บคู่ข้อความตามลำดับ · อ่านกลับเก่า→ใหม่ · แยกตามเจ้าของ · ตัดเก่าเกิน 200 เทิร์น/30 วันเอง
// · สิทธิ์ให้ลืมลูกค้ากวาดเทิร์นที่เอ่ยชื่อเต็มของคนนั้นด้วย
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";
import { OWNER_CHAT_KEEP_DAYS, OWNER_CHAT_KEEP_TURNS } from "../src/dbOwnerChat.mjs";

poisonGlobalFetch();

const NOON = Date.UTC(2026, 8, 28, 5, 0, 0);
const DAY = 86_400_000;

function world(t) {
  const clock = { now: NOON };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  return { db, clock };
}

test("ความจำแชทเจ้าของ: เก็บเป็นคู่ตามลำดับ · อ่านกลับเก่า→ใหม่ · แยกตามเจ้าของ", (t) => {
  const { db, clock } = world(t);
  db.addOwnerChatExchange({ ownerRef: "owner-a", userText: "วันนี้เป็นไงบ้าง", assistantText: "วันนี้ลูกค้าทักมา 3 ห้องค่ะพี่ง้วง" });
  clock.now += 60_000;
  db.addOwnerChatExchange({ ownerRef: "owner-a", userText: "เหนื่อยไหม", assistantText: "ไม่เหนื่อยค่ะ 😊" });
  db.addOwnerChatExchange({ ownerRef: "owner-b", userText: "ของคนอื่น", assistantText: "ห้ามปนกัน" });
  const turns = db.recentOwnerChatTurns("owner-a", { limit: 10 });
  assert.deepEqual(turns.map((turn) => [turn.role, turn.content]), [
    ["user", "วันนี้เป็นไงบ้าง"], ["assistant", "วันนี้ลูกค้าทักมา 3 ห้องค่ะพี่ง้วง"],
    ["user", "เหนื่อยไหม"], ["assistant", "ไม่เหนื่อยค่ะ 😊"],
  ]);
  assert.deepEqual(db.recentOwnerChatTurns("owner-a", { limit: 2 }).map((turn) => turn.content), ["เหนื่อยไหม", "ไม่เหนื่อยค่ะ 😊"],
    "limit เอาของล่าสุด แต่คืนตามลำดับเวลา");
  assert.equal(db.recentOwnerChatTurns("owner-b").length, 2);
  assert.equal(db.recentOwnerChatTurns("").length, 0, "ไม่มีเจ้าของ = ไม่มีความจำ");
});

test("ความจำแชทเจ้าของ: เกิน 200 เทิร์นตัดของเก่าสุด · เก่ากว่า 30 วันหายเอง (ทั้งตอนเขียนและตอนอ่าน)", (t) => {
  const { db, clock } = world(t);
  assert.equal(OWNER_CHAT_KEEP_TURNS, 200);
  assert.equal(OWNER_CHAT_KEEP_DAYS, 30);
  db.addOwnerChatExchange({ ownerRef: "o", userText: "เก่ามาก", assistantText: "ตอบเก่ามาก" });
  clock.now += 31 * DAY;
  assert.equal(db.recentOwnerChatTurns("o").length, 0, "อ่านไม่เห็นของเกิน 30 วัน");
  const rows = () => Number(db.raw.prepare("SELECT COUNT(*) AS n FROM owner_chat_turns").get().n);
  assert.equal(rows(), 0, "การอ่านตัดของหมดอายุทิ้งจริง ไม่ใช่แค่ซ่อน");
  for (let i = 0; i < 110; i += 1) {
    clock.now += 1_000;
    db.addOwnerChatExchange({ ownerRef: "o", userText: `ถาม ${i}`, assistantText: `ตอบ ${i}` });
  }
  assert.equal(rows(), OWNER_CHAT_KEEP_TURNS);
  const all = db.recentOwnerChatTurns("o", { limit: 500 });
  assert.equal(all.length, 40, "อ่านได้ไม่เกินเพดานต่อครั้ง");
  const newest = db.raw.prepare("SELECT content FROM owner_chat_turns ORDER BY created_at DESC, rowid DESC LIMIT 1").get().content;
  assert.equal(newest, "ตอบ 109");
  const oldest = db.raw.prepare("SELECT content FROM owner_chat_turns ORDER BY created_at ASC, rowid ASC LIMIT 1").get().content;
  assert.equal(oldest, "ถาม 10", "ตัดคู่เก่าสุดทิ้งทั้งคู่");
  assert.equal(db.pruneOwnerChatTurns(), 0);
});

test("ความจำแชทเจ้าของ: เก็บเฉพาะ user/assistant และตัดข้อความยาวเกินเพดาน", (t) => {
  const { db } = world(t);
  db.addOwnerChatExchange({ ownerRef: "o", userText: "ก".repeat(9_000), assistantText: "ข".repeat(9_000) });
  const [user, assistant] = db.recentOwnerChatTurns("o");
  assert.ok(user.content.length <= 4_000 && assistant.content.length <= 4_000);
  assert.throws(() => db.raw.prepare("INSERT INTO owner_chat_turns (id, owner_ref, role, content, created_at) VALUES ('x','o','system','x',1)").run());
});

test("สิทธิ์ให้ลืม: ลืมลูกค้า = เทิร์นแชทเจ้าของที่เอ่ยชื่อเต็มของคนนั้นหายด้วย · ชื่อสั้นกว่า 3 ตัวไม่กวาด", (t) => {
  const { db, clock } = world(t);
  db.upsertCustomer("U-forget", { displayName: "มานพ ใจดี" });
  db.setKnownName("U-forget", "มานพ");
  db.upsertCustomer("U-short", { displayName: "เอ" });
  db.addOwnerChatExchange({ ownerRef: "o", userText: "คุณมานพเป็นไงบ้าง", assistantText: "คุณ มาน*** ยังเงียบค่ะ" });
  clock.now += 1_000;
  db.addOwnerChatExchange({ ownerRef: "o", userText: "คุณเอด้วย", assistantText: "เอไอพร้อมค่ะ" });
  db.resetCustomer("U-forget", { forget: true });
  db.resetCustomer("U-short", { forget: true });
  const left = db.recentOwnerChatTurns("o").map((turn) => turn.content);
  assert.deepEqual(left, ["คุณเอด้วย", "เอไอพร้อมค่ะ"], "ลืมคนชื่อเต็ม = คู่ข้อความที่เอ่ยชื่อหายทั้งคู่ · ชื่อ 2 ตัวอักษรไม่กวาดทั้งแชท");
  db.resetCustomer("U-short");
  assert.equal(db.recentOwnerChatTurns("o").length, 2, "reset ธรรมดา (ไม่ใช่ลืม) ไม่แตะความจำแชท");
});

test("สิทธิ์ให้ลืม: ชื่อโปรไฟล์หลายคำแต่พี่ง้วงพิมพ์แค่ชื่อต้น (\"คุณสมหญิง\") ก็ต้องถูกกวาด (code review 28 ก.ย.)", (t) => {
  const { db, clock } = world(t);
  db.upsertCustomer("U-multi", { displayName: "คุณสมหญิง รักเรียน" });
  db.addOwnerChatExchange({ ownerRef: "o", userText: "สมหญิงถามเรื่องรอบหน้าไหม", assistantText: "ยังไม่ถามค่ะ" });
  clock.now += 1_000;
  db.addOwnerChatExchange({ ownerRef: "o", userText: "รักเรียนคือนามสกุลใคร", assistantText: "ไม่แน่ใจค่ะ" });
  clock.now += 1_000;
  db.addOwnerChatExchange({ ownerRef: "o", userText: "วันนี้เป็นไง", assistantText: "ดีค่ะ" });
  db.resetCustomer("U-multi", { forget: true });
  assert.deepEqual(db.recentOwnerChatTurns("o").map((turn) => turn.content), ["รักเรียนคือนามสกุลใคร", "ไม่แน่ใจค่ะ", "วันนี้เป็นไง", "ดีค่ะ"],
    "ชื่อต้น (ตัดคำว่าคุณ) ถูกกวาด · นามสกุลลอย ๆ ไม่ใช่รูปที่ใช้เรียกคน จึงไม่กวาดทั้งประวัติ");
});
