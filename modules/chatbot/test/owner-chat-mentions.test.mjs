// owner-chat-mentions — พี่ง้วงเอ่ยชื่อลูกค้าในแชท: เจอห้องเดียวแน่นอน = แนบสถานะห้อง + ข้อความล่าสุด (ย่อ ปิดชื่อ
// ซ่อนเบอร์) · ชื่อซ้ำ = แนบรายการให้ลูกแพรถามกลับ · ไม่ตรงเป๊ะ/ชื่อทีมงาน/ไม่มีคำนำหน้า = ไม่แนบอะไรเลย (ห้ามเดาลูกค้า)
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";
import { findMentionedCustomers, mentionContextLines } from "../src/ownerChatMentions.mjs";
import { resolveExactLeadingName } from "../src/customerResolver.mjs";

poisonGlobalFetch();

const NOON = Date.UTC(2026, 8, 28, 5, 0, 0);
const MIN = 60_000;

function world(t) {
  const clock = { now: NOON };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  const config = testConfig();
  const room = (id, name, { channel = "default", at = NOON - 30 * MIN, text = `ข้อความของ ${name}` } = {}) => {
    clock.now = at;
    db.upsertCustomer(id, { displayName: name, channelId: channel });
    db.insertMessage({ customerId: id, direction: "in", content: text });
    clock.now = NOON;
    return id;
  };
  return { db, clock, config, room };
}

test("เอ่ยชื่อพร้อมคำนำหน้า (คุณ/ลูกค้า/เคส/ห้อง/พี่/น้อง) = เจอห้องเดียวแน่นอน · ชื่อทีม/คำทั่วไปไม่ใช่ลูกค้า", (t) => {
  const w = world(t);
  w.room("U-som", "สมชาย ใจดี");
  w.room("U-mana", "มานะ");
  w.room("U-ngoung", "ง้วง"); // ลูกค้าบังเอิญชื่อเดียวกับเจ้าของ — "พี่ง้วง" ต้องไม่ถูกอ่านเป็นลูกค้า
  const one = findMentionedCustomers(w.db, "คุณสมชายเป็นไงบ้าง น่าปิดไหม");
  assert.deepEqual(one.map((m) => [m.status, m.room?.id]), [["unique", "U-som"]]);
  assert.deepEqual(findMentionedCustomers(w.db, "เคสพี่มานะคืบหน้าไหม").map((m) => m.room?.id), ["U-mana"]);
  assert.deepEqual(findMentionedCustomers(w.db, "ห้องของ สมชาย ใจดี ล่ะ").map((m) => m.room?.id), ["U-som"]);
  assert.deepEqual(findMentionedCustomers(w.db, "พี่ง้วงเหนื่อยจัง ขอบคุณมากนะ"), [], "ชื่อทีมงานและ 'ขอบคุณ' ไม่ใช่การเอ่ยถึงลูกค้า");
  assert.deepEqual(findMentionedCustomers(w.db, "สมชายเป็นไงบ้าง"), [], "ไม่มีคำนำหน้า = ไม่เดา (ทางคำสั่ง 'สถานะ' ยังใช้ได้)");
  assert.deepEqual(findMentionedCustomers(w.db, "คุณสมชัยล่ะ"), [], "ชื่อไม่ตรงเป๊ะ = ไม่แนบห้องที่ชื่อคล้าย");
  assert.deepEqual(findMentionedCustomers(w.db, "คุณสมชาย กับ คุณมานะ แล้วก็ คุณสมชาย อีกที").map((m) => m.room.id), ["U-som", "U-mana"], "ไม่ซ้ำ และไม่เกิน 2 ห้อง");
});

test("ชื่อซ้ำหลายห้อง = แนบรายการให้ถามกลับ (ไม่เลือกให้เอง) · resolveExactLeadingName ไม่รับชื่อบางส่วน", (t) => {
  const w = world(t);
  w.room("U-a1", "เอ", { at: NOON - 5 * MIN });
  w.room("U-a2", "เอ", { channel: "facebook", at: NOON - 2 * 3_600_000 });
  w.room("U-pim", "พิมพ์ลดา");
  const [mention] = findMentionedCustomers(w.db, "คุณเอสนใจรอบไหน");
  assert.equal(mention.status, "ambiguous");
  assert.deepEqual(mention.rooms.map((room) => room.id), ["U-a1", "U-a2"]);
  const lines = mentionContextLines({ db: w.db, config: w.config, mentions: [mention], nowMs: NOON }).join("\n");
  assert.match(lines, /ชื่อ "เอ" ตรงกับ 2 ห้อง/u);
  assert.match(lines, /ให้ถามพี่ง้วงกลับก่อนว่าหมายถึงห้องไหน/u);
  assert.equal(resolveExactLeadingName(w.db, { text: "ลดา ถามอะไร" }), null, "ชื่อบางส่วนต้องไม่นับว่าเจอ");
  assert.equal(resolveExactLeadingName(w.db, { text: "พิมพ์ลดา ถามอะไร" }).matches[0].id, "U-pim");
});

test("ห้องที่เจอ: สถานะ AI/ธง/FU + คะแนน + ข้อความล่าสุดแบบย่อ ชื่อปิดบางส่วน เบอร์/อีเมลถูกซ่อน", (t) => {
  const w = world(t);
  w.room("U-som", "สมชาย ใจดี", { at: NOON - 40 * MIN, text: "สนใจ in-house ค่ะ ติดต่อ 0812345678 หรือ som@example.com" });
  w.clock.now = NOON - 39 * MIN;
  w.db.insertMessage({ customerId: "U-som", direction: "out", content: "ยินดีค่ะคุณสมชาย ".repeat(20), agentMode: "ai" });
  w.db.insertMessage({ customerId: "U-som", direction: "out", content: "ชมพู่รับเรื่องนะคะ", operator: "chompoo", agentMode: "operator_ai_off" });
  w.db.recordScore("U-som", 8, JSON.stringify({ score: 8, context_summary: "คุณสมชาย ใจดี อยากอบรมทีม 20 คน", pain_point: "ทีมทำงานซ้ำเยอะ" }));
  w.db.setAiEnabled("U-som", false, "handoff_private_inhouse");
  w.clock.now = NOON;
  const mentions = findMentionedCustomers(w.db, "คุณสมชายคืบหน้าไหม");
  const text = mentionContextLines({ db: w.db, config: w.config, mentions, nowMs: NOON }).join("\n");
  assert.match(text, /ห้อง สมช\*\*\* \(LINE\) — คะแนนความสนใจ 8\/10 \(สนใจสูง\)/u);
  assert.match(text, /AI: ปิด — ส่งต่องาน In-house\/Private ให้ทีมแล้ว/u);
  assert.match(text, /สรุปห้องจากตัวอ่านแชท: คุณสมช\*\*\* อยากอบรมทีม 20 คน/u);
  assert.match(text, /เรื่องที่ลูกค้าอยากแก้: ทีมทำงานซ้ำเยอะ/u);
  assert.match(text, /- ลูกค้า \(40 นาทีก่อน\): สนใจ in-house ค่ะ ติดต่อ \[เลขยาวถูกซ่อน\] หรือ \[อีเมล\]/u);
  assert.match(text, /- ทีม \(39 นาทีก่อน\): ชมพู่รับเรื่องนะคะ/u);
  assert.match(text, /- ลูกแพร \(39 นาทีก่อน\): ยินดีค่ะคุณสมช\*\*\*/u, "ชื่อต้น (คำแรกของชื่อโปรไฟล์) ก็ต้องถูกปิด");
  assert.ok(!text.includes("0812345678") && !text.includes("som@example.com"), "ข้อมูลติดต่อห้ามเข้าบริบท");
  assert.ok(!text.includes("สมชาย"), "ชื่อเต็มต้องไม่หลุดไป Telegram ผ่านโมเดล");
  assert.ok(text.length < 1_800, `ห้องเดียวต้องกระชับ (${text.length})`);
});
