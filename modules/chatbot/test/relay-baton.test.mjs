// relay-baton.test.mjs — "ไม้ต่อจากลูกแพร" + นาฬิกาเวลาทำการ (คำสั่งพี่ง้วง 3 พ.ย. 2026)
// พี่ง้วง: "สุดท้าย AI พิมพ์จบแล้ว ชมพู่ ใน 3-6 ชม ควรไปตอบต่อจาก AI" · ทุกห้อง · จ.–ส. ยกเว้นวันหยุด/วันที่ชมพู่ไม่มา
//          · เริ่มนับว่าคุยจบเมื่อลูกค้าเงียบ 2 ชม. ในเวลาทำการ
import test from "node:test";
import assert from "node:assert/strict";
import { addWorkMs, isWorkTime, parseOffDays, readOffDays, workMsBetween } from "../src/workClock.mjs";
import { conversationTurns, relayEpisode, relayStatus, summarizeRelay } from "../src/relayBaton.mjs";
import { relayList, summarizeRelayQuiet } from "../src/consoleAttentionApi.mjs";
import { RELAY_START_KEY } from "../src/relayBaton.mjs";
import { memoryDb } from "./helpers.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// เวลาไทย พ.ย. 2026 — 2 พ.ย. = จันทร์ · 3 = อังคาร · 4 = พุธ · 7 = เสาร์ · 8 = อาทิตย์
const bkk = (d, h, m = 0) => Date.UTC(2026, 10, d, h - 7, m, 0);

test("นาฬิกา: นับเฉพาะ จ.–ส. 09:00–18:00 · อาทิตย์และวันในรายการไม่นับ", () => {
  assert.equal(workMsBetween(bkk(2, 10), bkk(2, 13)), 3 * HOUR, "ในวันเดียวกัน");
  assert.equal(workMsBetween(bkk(2, 7), bkk(2, 10)), 1 * HOUR, "ก่อน 09:00 ไม่นับ");
  assert.equal(workMsBetween(bkk(2, 17), bkk(3, 10)), 2 * HOUR, "ข้ามคืน = 17–18 + 09–10");
  assert.equal(workMsBetween(bkk(7, 17), bkk(9, 10)), 2 * HOUR, "เสาร์ 17:00 → จันทร์ 10:00 ข้ามวันอาทิตย์");
  const offDays = parseOffDays("2026-11-03\n2026-11-04, nonsense");
  assert.deepEqual([...offDays], ["2026-11-03", "2026-11-04"]);
  assert.equal(workMsBetween(bkk(2, 17), bkk(5, 10), { offDays }), 2 * HOUR, "วันที่ชมพู่ไม่มาข้ามไปทั้งวัน");
  assert.equal(workMsBetween(bkk(3, 10), bkk(2, 10)), 0, "ย้อนเวลา = 0");
});

test("นาฬิกา: บวกเวลาทำการ — ลูกแพรจบ 22:00 วันจันทร์ เปิดไม้ 11:00 · เส้นตาย 15:00 วันอังคาร", () => {
  assert.equal(addWorkMs(bkk(2, 22), 2 * HOUR), bkk(3, 11));
  assert.equal(addWorkMs(bkk(2, 22), 6 * HOUR), bkk(3, 15));
  assert.equal(addWorkMs(bkk(2, 16), 6 * HOUR), bkk(3, 13), "16:00 + 6 ชม. = 2 ชม.วันนี้ + 4 ชม.พรุ่งนี้");
  assert.equal(addWorkMs(bkk(7, 17), 2 * HOUR), bkk(9, 10), "เสาร์เย็นข้ามอาทิตย์");
  assert.equal(addWorkMs(bkk(2, 10), 0), bkk(2, 10));
  assert.equal(isWorkTime(bkk(8, 10)), false, "อาทิตย์");
  assert.equal(isWorkTime(bkk(7, 10)), true, "เสาร์ทำงาน");
  assert.equal(isWorkTime(bkk(2, 10), { offDays: new Set(["2026-11-02"]) }), false);
  assert.equal(readOffDays({ getSetting() { throw new Error("db down"); } }).size, 0, "อ่านพัง = ไม่มีวันหยุดเพิ่ม");
});

test("สถานะไม้: ยังทัน ≤ 3 ชม. < ควรต่อแล้ว ≤ 6 ชม. < เกินเวลา (ขอบเดียวกับผลต่อทัน 3/6 ชม.)", () => {
  assert.equal(relayStatus(2 * HOUR), "ontrack");
  assert.equal(relayStatus(3 * HOUR), "ontrack");
  assert.equal(relayStatus(3 * HOUR + 1), "due");
  assert.equal(relayStatus(6 * HOUR), "due");
  assert.equal(relayStatus(6 * HOUR + 1), "overdue");
});

// [ทิศทาง, เวลา, คน(1)/ลูกแพร(0), ชนิด] — "ack" = ขอบคุณ · "proactive" = ข้อความทวง
function msgs(rows) {
  return rows.map(([direction, at, human = 0, kind = ""]) => ({
    direction, created_at: at, human,
    reactive: direction === "out" && kind !== "proactive" ? 1 : 0,
    type: direction === "in" ? "text" : null,
    text: direction === "in" ? (kind === "ack" ? "ขอบคุณค่ะ" : "สนใจคลาสค่ะ") : null,
  }));
}
const episodeOf = (rows, now, opts = {}) => relayEpisode(conversationTurns(msgs(rows))[0], { now, ...opts });

test("ไม้: นับจากข้อความสุดท้ายของลูกแพร · คนต่อภายใน 3/6 ชม./เกิน · ลูกค้าคุยต่อก่อน 2 ชม. = ไม่ใช่ไม้", () => {
  const now = bkk(4, 17);
  // ลูกแพรตอบสองข้อความ จบ 10:30 → ชมพู่ทัก 13:00 = 2.5 ชม.
  const fast = episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["out", bkk(2, 10, 30)], ["out", bkk(2, 13), 1]], now);
  assert.equal(fast.outcome, "within3");
  assert.equal(fast.lagWorkMs, 2.5 * HOUR);
  assert.equal(fast.aiEnd, bkk(2, 10, 30));
  const mid = episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["out", bkk(2, 15, 1), 1]], now);
  assert.equal(mid.outcome, "within6");
  // ลูกแพรจบ 17:00 จันทร์ → ชมพู่ทัก 14:00 อังคาร = 1 + 5 = 6 ชม. พอดี = ทัน
  assert.equal(episodeOf([["in", bkk(2, 16, 59)], ["out", bkk(2, 17)], ["out", bkk(3, 14), 1]], now).outcome, "within6");
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["out", bkk(3, 10), 1]], now).outcome, "late");
  // ลูกค้าพูดต่อภายใน 1 ชม. = บทสนทนายังเดิน ไม่ใช่ไม้
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["in", bkk(2, 11)]], now), null);
  // ลูกค้ากลับมาเองหลังเปิดไม้ ก่อนเส้นตาย = ไม่นับเป็นพลาด · หลังเส้นตาย = พลาด
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["in", bkk(2, 14)]], now).outcome, "cameBack");
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["in", bkk(3, 10)]], now).outcome, "missed");
  // ขอบคุณ/สติกเกอร์ไม่ใช่คำถามใหม่ — ไม้ยังเดินต่อ
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["in", bkk(2, 10, 5), 0, "ack"]], now).outcome, "missed");
  // ชมพู่เข้ามาคุยต่อ 10 นาทีหลังลูกแพร = ลูกค้ายังไม่ได้เงียบ 2 ชม. ไม้ไม่เคยเปิด (ไม่ใช่ "ต่อทัน" ฟรี)
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["out", bkk(2, 10, 11), 1]], now), null);
  // คนตอบเองตั้งแต่แรก / มีแต่ข้อความทวง = ไม่ใช่ไม้ของลูกแพร
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 5), 1]], now), null);
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(3, 10), 0, "proactive"]], now), null);
  // ยังไม่ครบเส้นตาย = pending · ยังไม่ครบ 2 ชม. = ยังไม่เปิด
  assert.equal(episodeOf([["in", bkk(4, 12)], ["out", bkk(4, 12, 1)]], now).outcome, "pending");
  assert.equal(episodeOf([["in", bkk(4, 16)], ["out", bkk(4, 16, 1)]], now), null);
  // Facebook เลย 7 วันแล้วยังไม่มีใครต่อ = หลุด
  assert.equal(episodeOf([["in", bkk(2, 10)], ["out", bkk(2, 10, 1)]], bkk(10, 12), { isFacebook: true }).outcome, "lost");
});

test("สรุป 7 วัน: % ต่อทัน 3/6 ชม. ตัวหาร = ไม้ที่ตัดสินแล้ว · อัตราตอบ · ห้องที่ลูกแพรคุยคนเดียวตลอด", () => {
  const now = bkk(7, 17);
  const room = (id, rows, extra = {}) => ({ room: { id, channel_id: "default", ever_human: 0, quiet_yellow: 0, ...extra }, rows });
  const data = [
    room("A", [["in", bkk(2, 10)], ["out", bkk(2, 10, 1)], ["out", bkk(2, 12, 31), 1]], { ever_human: 1 }), // within3
    room("B", [["in", bkk(3, 10)], ["out", bkk(3, 10, 1)], ["out", bkk(3, 15), 1]], { ever_human: 1 }), // within6
    room("C", [["in", bkk(3, 10)], ["out", bkk(3, 10, 1)]]), // missed · ลูกแพรคุยคนเดียว
    room("D", [["in", bkk(4, 10)], ["out", bkk(4, 10, 1)], ["in", bkk(4, 13)], ["out", bkk(4, 13, 1)]]), // cameBack แล้วรอบสอง missed
    room("E", [["in", bkk(7, 16, 30)]]), // ยังไม่มีใครตอบ
    room("Y", [["in", bkk(3, 10)], ["out", bkk(3, 10, 1)]], { quiet_yellow: 1 }), // ห้องเหลืองนิ่ง ไม่นับ
  ];
  const summary = summarizeRelay({
    rooms: data.map((d) => d.room),
    messages: data.flatMap((d) => msgs(d.rows).map((m) => ({ ...m, customer_id: d.room.id }))),
  }, { now });
  assert.equal(summary.windowDays, 7);
  assert.deepEqual(
    { w3: summary.relay.within3, w6: summary.relay.within6, missed: summary.relay.missed, back: summary.relay.cameBack, decided: summary.relay.decided },
    { w3: 1, w6: 1, missed: 2, back: 1, decided: 4 },
  );
  assert.equal(summary.relay.within6Pct, 50);
  assert.equal(summary.relay.within3Pct, 25);
  assert.equal(summary.relay.medianLagWorkMs, Math.round((2.5 * HOUR + 5 * HOUR - MIN) / 2));
  assert.equal(summary.reply.turns, 6, "ทุกคำถามของลูกค้าในช่วง (ไม่รวมห้องเหลือง)");
  assert.equal(summary.reply.unanswered, 1);
  assert.equal(summary.reply.byAi, 5);
  assert.equal(summary.reply.answeredPct, 83);
  assert.deepEqual(summary.aiAlone, { rooms: 2, roomsWithAi: 4 }, "C และ D ไม่เคยมีคนจริงพิมพ์เลย");
  assert.doesNotMatch(JSON.stringify(summary), /สนใจคลาส/u, "ไม่มีเนื้อความลูกค้าในผล");
});

test("รายการบนจอ: เปิดหลัง 2 ชม.ทำการ · เรียงเกินเวลา → ควรต่อ → ยังทัน · Facebook ใกล้หมดเวลาขึ้นก่อนสุด", () => {
  const now = bkk(4, 16);
  const row = (id, aiEnd, extra = {}) => ({
    line_user_id: id, display_name: id, channel_id: "default", last_score: 5, ai_enabled: 1, state: "AI_ACTIVE",
    last_in_at: aiEnd - MIN, last_reply_at: aiEnd, ai_reply_at: aiEnd, outs_after_in: 1, team_talked_before: 0,
    unanswered_json: "[]", unanswered_count: 0, ...extra,
  });
  const list = summarizeRelayQuiet([
    row("fresh", bkk(4, 15)), // 1 ชม. — ยังไม่เปิด
    row("ontrack", bkk(4, 13, 30)), // 2.5 ชม.
    row("due", bkk(4, 12)), // 4 ชม.
    row("overdue", bkk(3, 15)), // 3 + 7 = 10 ชม.
    row("hot-due", bkk(4, 11), { last_score: 9 }), // 5 ชม. คะแนนสูงอยู่บนในกลุ่มเดียวกัน
    row("fb-soon", bkk(4, 13, 30), { channel_id: "facebook", last_in_at: now - 6.5 * DAY }),
    row("asked-again", bkk(3, 10), { unanswered_json: JSON.stringify([{ type: "text", text: "แล้วราคาเท่าไหร่คะ" }]), unanswered_count: 1 }),
  ], { now, limit: 20 });
  assert.deepEqual(list.rooms.map((r) => r.id), ["fb-soon", "overdue", "hot-due", "due", "ontrack"]);
  assert.deepEqual({ total: list.total, overdue: list.overdue, due: list.due, ontrack: list.ontrack }, { total: 5, overdue: 1, due: 2, ontrack: 2 });
  const overdue = list.rooms.find((r) => r.id === "overdue");
  assert.equal(overdue.relayStatus, "overdue");
  assert.equal(overdue.workElapsedMs, 10 * HOUR);
  assert.equal(overdue.deadlineAt, bkk(4, 12), "จบ 15:00 อังคาร + 6 ชม. = 12:00 พุธ");
  // วันที่ชมพู่ไม่มา (พุธ 4 พ.ย.): นาฬิกาหยุดทั้งวัน — นับแค่ 15:00–18:00 วันอังคาร = 3 ชม. ยังไม่แดง
  const leave = summarizeRelayQuiet([row("overdue", bkk(3, 15))], { now, offDays: new Set(["2026-11-04"]) });
  assert.equal(leave.rooms[0].relayStatus, "ontrack", "3 ชม. พอดี = ยังทันเป้า");
  assert.equal(leave.rooms[0].workElapsedMs, 3 * HOUR);
});

test("อัตราตอบ: ลูกค้าพิมพ์รัว 3 ข้อความแล้วลูกแพรตอบครั้งเดียว = 1 รอบที่ได้คำตอบ (ไม่ใช่ค้าง 2)", () => {
  const now = bkk(2, 17);
  const rows = [["in", bkk(2, 10)], ["in", bkk(2, 10, 0) + 4000], ["in", bkk(2, 10, 0) + 9000], ["out", bkk(2, 10, 1)]];
  assert.equal(conversationTurns(msgs(rows)).length, 1);
  const summary = summarizeRelay({
    rooms: [{ id: "R", channel_id: "default", ever_human: 0, quiet_yellow: 0 }],
    messages: msgs(rows).map((m) => ({ ...m, customer_id: "R" })),
  }, { now });
  assert.deepEqual({ turns: summary.reply.turns, unanswered: summary.reply.unanswered, pct: summary.reply.answeredPct }, { turns: 1, unanswered: 0, pct: 100 });
  assert.equal(summary.relay.missed, 1, "ไม้ของรอบนั้นยังนับตามปกติ");
});

test("นับตั้งแต่วันเปิดใช้ (พี่ง้วง 3 พ.ย.): ไม้ที่ลูกแพรจบก่อน relay_start_at ไม่ขึ้นรายการ · คะแนน 8+ ค้างต่อ · ไม่มีค่า = ทุกห้อง", () => {
  let clock = Date.now() - 3 * DAY;
  const db = memoryDb({ now: () => clock });
  const room = (id, score, aiEndAgo) => {
    clock = Date.now() - 20 * DAY;
    db.upsertCustomer(id, { displayName: id });
    db.recordScore(id, score, "{}");
    clock = Date.now() - aiEndAgo - MIN;
    db.insertMessage({ customerId: id, direction: "in", content: "สนใจคลาสค่ะ" });
    clock = Date.now() - aiEndAgo;
    db.insertMessage({ customerId: id, direction: "out", content: "ยินดีค่ะ", agentMode: "ai" });
  };
  room("old-cold", 3, 3 * DAY); // ก่อนวันเปิด
  room("old-hot", 9, 3 * DAY); // ก่อนวันเปิด แต่คะแนน 8+
  room("new", 3, 2 * DAY); // หลังวันเปิด
  clock = Date.now();
  const ids = () => relayList(db, { now: Date.now(), limit: 20 }).rooms.map((r) => r.id).sort();
  assert.deepEqual(ids(), ["new", "old-cold", "old-hot"], "ยังไม่ตั้งวันเปิด = ทุกห้อง");
  db.setSetting(RELAY_START_KEY, String(Date.now() - 2.5 * DAY));
  assert.deepEqual(ids(), ["new", "old-hot"]);
  db.setSetting(RELAY_START_KEY, "เพี้ยน");
  assert.deepEqual(ids(), ["new", "old-cold", "old-hot"], "ค่าเพี้ยน = ไม่ตัด");
});
