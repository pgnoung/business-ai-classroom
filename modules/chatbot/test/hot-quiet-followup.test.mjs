// hot-quiet-followup.test.mjs — "ลูกค้าร้อนเงียบไป รอทีมทักต่อ" (29 ก.ย. 2026)
// พี่ง้วง: "ห้อง HOT ที่เก่าๆ บางแชท AI ตอบไปแล้วนะ ทำไมถึงยังขึ้นครับ ช่วยดู Logic ให้ถูกต้องด้วย"
// ของจริง 29 ก.ย.: 19 ห้อง (FB 17) ทุกห้อง AI ตอบ + ทักตามแล้ว ลูกค้าเงียบ — ป้ายเดิม "ยังไม่มีคนทัก" จึงผิดความหมาย
// กติกาใหม่: เป็นรายการ "ถึงตาทีมทักต่อ" — บอกว่า AI ทำอะไรไปแล้ว · Facebook ทักอัตโนมัติไม่ได้แล้ว
// คนตอบใน Business Suite ได้ถึง 7 วันหลังข้อความล่าสุดของลูกค้า เกินนั้นติดต่อไม่ได้ = ไม่ต้องขึ้นรายการ
import test from "node:test";
import assert from "node:assert/strict";
import { FB_HUMAN_REPLY_MS, summarizeHotQuiet } from "../src/consoleAttentionApi.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 8, 29, 4, 0, 0);

test("ห้อง Facebook ที่ลูกค้าเงียบเกิน 7 วัน ติดต่อไม่ได้แล้ว = ไม่ขึ้นรายการ · ในหน้าต่าง = บอกเส้นตายตอบใน Business Suite", () => {
  const hot = summarizeHotQuiet([
    { line_user_id: "facebook:gone", channel_id: "facebook", last_score: 9, last_at: now - 6.9 * DAY, last_in_at: now - 7.2 * DAY, outs_after_in: 3 },
    { line_user_id: "facebook:open", channel_id: "facebook", last_score: 9, last_at: now - 5 * DAY, last_in_at: now - 5 * DAY - HOUR, outs_after_in: 4 },
  ], { now });
  assert.deepEqual(hot.rooms.map((room) => room.id), ["facebook:open"]);
  assert.equal(hot.total, 1);
  const [room] = hot.rooms;
  assert.equal(room.fbHumanUntil, now - 5 * DAY - HOUR + FB_HUMAN_REPLY_MS);
  assert.equal(room.aiReplies, 4, "บอกได้ว่า AI ตอบ/ทักตามไปแล้วกี่ข้อความหลังลูกค้าพูดล่าสุด");
});

// 29 ก.ย. 2026 รอบสอง (พี่ง้วง: "อยากให้ขึ้นค้างไว้ ... รีบคุยตอนที่ลูกค้ากำลังสนใจสุด ๆ"): ห้อง Facebook ที่ตอบได้อีกไม่ถึงวัน
// จะหลุดถาวรถ้าไม่มีใครทัก จึงขึ้นก่อนทุกห้อง (ใกล้หมดก่อน) · ที่เหลือคะแนนมากก่อน แล้วลูกค้าพูดล่าสุดใหม่กว่าก่อน
test("ห้อง LINE ไม่มีเส้นตาย ค้างได้ไม่จำกัดวัน · Facebook ใกล้หมดเวลาขึ้นก่อน แล้วคะแนน แล้วความสดของความสนใจ", () => {
  const hot = summarizeHotQuiet([
    { line_user_id: "U-line", channel_id: "default", last_score: 9, last_at: now - 6 * DAY, last_in_at: now - 6 * DAY, outs_after_in: 1 },
    { line_user_id: "U-old", channel_id: "default", last_score: 9, last_at: now - 30 * DAY, last_in_at: now - 30 * DAY, outs_after_in: 2 },
    { line_user_id: "facebook:later", channel_id: "facebook", last_score: 9, last_at: now - 2 * DAY, last_in_at: now - 2 * DAY, outs_after_in: 2 },
    { line_user_id: "facebook:soon", channel_id: "facebook", last_score: 9, last_at: now - 6 * DAY, last_in_at: now - 6.5 * DAY, outs_after_in: 3 },
    { line_user_id: "facebook:low", channel_id: "facebook", last_score: 8, last_at: now - 6 * DAY, last_in_at: now - 6.8 * DAY, outs_after_in: 3 },
    { line_user_id: "U-talked", channel_id: "default", last_score: 8, last_at: now - DAY, last_in_at: now - 1.5 * DAY, outs_after_in: 1, team_talked_before: 1 },
  ], { now });
  assert.deepEqual(hot.rooms.map((room) => room.id), ["facebook:low", "facebook:soon", "facebook:later", "U-line", "U-old", "U-talked"]);
  assert.equal(hot.total, 6);
  assert.equal(hot.urgent, 2, "นับห้อง Facebook ที่ตอบได้อีกไม่ถึงวันแยกไว้ให้ push/หน้าจอเตือน");
  assert.equal(hot.rooms.find((room) => room.id === "U-line").fbHumanUntil, null);
  assert.equal(hot.rooms.find((room) => room.id === "U-old").silentMs, 30 * DAY, "LINE เงียบ 30 วันก็ยังค้าง — เงียบนับจากลูกค้าพูดล่าสุด");
  assert.equal(hot.rooms.find((room) => room.id === "U-talked").teamTalkedBefore, true);
});
