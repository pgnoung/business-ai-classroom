// บันได follow-up เฉพาะช่อง Facebook (คำสั่งพี่ง้วง 2026-08-30)
//
// Meta ปิดประตูหลังลูกค้าเงียบครบ 24 ชม. ตารางกลางถูกออกแบบมาสำหรับ LINE ที่ทักได้เป็นวัน ๆ
// (cold วันที่ 2/3/4 · warm 3/7 วัน) พอมาอยู่บน Facebook ไม้เหล่านั้นตกนอกหน้าต่างทั้งหมด
//
// ข้อจำกัดที่คุมการออกแบบ:
//   1. หน้าต่าง 24 ชม. นับจาก "ข้อความล่าสุดของลูกค้า" (ข้อความเราไม่รีเซ็ต)
//   2. ห้ามรบกวน 21:00-09:00 — ไม้ที่ตกกลางดึกถูกเลื่อนไป 09:00 ถัดไป
//   3. ข้อ 2 แปลว่าไม้สุดท้ายต้องไม่เกิน ~11-12 ชม. ไม่งั้น anchor ตอนเช้าจะโดนเลื่อน
//      ข้ามคืนไปชนกำแพง 24 ชม. พอดี แล้วถูกข้ามทิ้ง
//   4. เพดานทักวันละครั้ง (DAILY_PROACTIVE_CAP=1) ของ LINE ใช้กับ Facebook ไม่ได้ —
//      บันไดทั้งเส้นต้องจบในวันเดียว จึงต้องมีเพดานแยกของช่องนี้
import test from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_SCHEDULE, DAILY_PROACTIVE_CAP,
  scheduleFor, ladderFor, dailyProactiveCapFor, resolveStepDueAt, previewStagedFollowup,
} from "../src/stagedFollowups.mjs";
import { inQuietHours } from "../src/followupEngine.mjs";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const FB_WINDOW_MS = DAY - 5 * MIN; // ตรงกับ FB_MESSAGING_WINDOW_MS ใน db.mjs
const bkk = (hour) => Date.UTC(2026, 0, 15, hour - 7, 0, 0);

test("cold ของ Facebook = 1 / 6 / 11 ชม. (สั่ง 1ชม. แล้ว +6 +6 — ไม้ท้ายขยับเข้าให้พ้นกำแพง)", () => {
  const fb = scheduleFor("cold", null, "facebook");
  assert.deepEqual(fb.map((s) => s.at.ms), [1 * HOUR, 6 * HOUR, 11 * HOUR]);
  assert.deepEqual(ladderFor("cold", "facebook"), ["question", "question", "question"]);
});

test("warm ของ Facebook = 4 / 11 ชม. สองไม้ — คนกำลังชั่งใจของราคาสูง ห้ามเร่ง", () => {
  const fb = scheduleFor("warm", null, "facebook");
  assert.deepEqual(fb.map((s) => s.at.ms), [4 * HOUR, 11 * HOUR]);
  assert.deepEqual(ladderFor("warm", "facebook"), ["review", "question"],
    "ไม้ท้ายเป็นคำถาม — ลูกค้าตอบเมื่อไร หน้าต่าง 24 ชม. รีเซ็ตทันที");
});

test("hot ของ Facebook = 45 นาที / 8 ชม. สองไม้ตามปรัชญาเดิม (ไม่ใช่เช้าวันถัดไป)", () => {
  const fb = scheduleFor("hot", null, "facebook");
  assert.deepEqual(fb.map((s) => s.at.ms), [45 * MIN, 8 * HOUR]);
  assert.equal(fb[1].at.type, "after",
    "ห้ามใช้ 'เช้าวันถัดไป' บน Facebook — anchor ตอนเช้าจะเลยกำแพง 24 ชม.");
  assert.deepEqual(ladderFor("hot", "facebook"), ["review_question", "question"]);
});

test("เพดานทักต่อวันของ Facebook ต้องพอกับบันไดที่ยาวที่สุด ไม่งั้นไม้ 2-3 ไม่มีวันได้ยิง", () => {
  assert.equal(DAILY_PROACTIVE_CAP, 1, "ค่ากลาง (LINE) ยังวันละครั้ง");
  assert.equal(dailyProactiveCapFor("facebook"), 3, "Facebook บีบทั้งเส้นลงวันเดียว");
  for (const ch of ["default", "", null, undefined, "line-oa-2"]) {
    assert.equal(dailyProactiveCapFor(ch), DAILY_PROACTIVE_CAP, `ช่อง ${ch} ต้องไม่ถูกแตะ`);
  }
});

test("ช่องอื่นยังใช้ตารางเดิมทุกระดับ", () => {
  for (const ch of ["default", "", null, undefined, "line-oa-2"]) {
    for (const stage of ["cold", "warm", "hot"]) {
      assert.deepEqual(scheduleFor(stage, null, ch), STAGE_SCHEDULE[stage], `${stage} ของ ${ch}`);
    }
  }
});

test("ทุกไม้ทุกระดับต้องตกในหน้าต่าง 24 ชม. และไม่ตกช่วงเงียบ ไม่ว่าลูกค้าจะเงียบตอนไหน", () => {
  for (const stage of ["cold", "warm", "hot"]) {
    const schedule = scheduleFor(stage, null, "facebook");
    for (const hour of [9, 10, 12, 15, 18, 20, 22]) {
      const anchor = bkk(hour);
      let lastActivity = anchor;
      for (let i = 0; i < schedule.length; i += 1) {
        const due = resolveStepDueAt({
          schedule, stepIndex: i, anchorMs: anchor, lastActivityMs: lastActivity,
          customerId: "facebook:112233445566",
        });
        assert.ok(due - anchor < FB_WINDOW_MS,
          `${stage} ไม้ ${i + 1} (เงียบ ${hour}:00) ต้องอยู่ในหน้าต่าง — ได้ ${((due - anchor) / HOUR).toFixed(1)} ชม.`);
        assert.equal(inQuietHours(due), false, `${stage} ไม้ ${i + 1} (เงียบ ${hour}:00) ต้องไม่ตกช่วงเงียบ`);
        lastActivity = due; // ไม้ถัดไปนับต่อจากที่เพิ่งส่ง เหมือนเส้นยิงจริง
      }
    }
  }
});

// พี่ง้วงถามยืนยัน 2026-08-30: cold โดนไป 2 ไม้ แล้วลูกค้าทักกลับจนคะแนนขึ้นเป็น warm
// → ต้องเดินบันได warm ตั้งแต่ไม้ 1 (ไม่ใช่ไม้ 3 ของ cold) และถ้าทักอีกจนเป็น hot ก็เริ่ม hot ใหม่
// พฤติกรรมนี้มีอยู่แล้วตั้งแต่ v1.4.8 — เทสต์นี้ล็อกไว้ไม่ให้หลุดตอนแก้ตารางรายช่อง
test("เปลี่ยนระดับแล้วต้องเริ่มบันไดใหม่จากไม้ 1 ของระดับใหม่ (cold → warm → hot)", () => {
  const NINE_AM = bkk(9);
  const room = {
    line_user_id: "facebook:556677889900", channel_id: "facebook",
    ai_enabled: 1, do_not_disturb: 0, followup_enabled: 1, marketing_consent: 1,
    handoff_summary: "", deal_status: "", ai_off_reason: "", last_score: 2,
  };
  const call = (customer, state, anchorMs) => previewStagedFollowup({
    customer, state,
    lastInboundAt: anchorMs, lastOutboundAt: anchorMs,
    nowMs: anchorMs + 5 * MIN,
    delays: { cold: 60 * MIN, warm: 30 * MIN, hot: 30 * MIN },
  });
  const stateAfterTwoCold = {
    stage_key: "cold", episode_anchor: NINE_AM, ladder_stage: 2,
    episodes_today: 1, sent_today: 2, today_key: "2026-01-15", cold_sent_total: 2,
  };

  // ยังเป็น cold: ไม้ที่ 3 ของ cold = 11 ชม.
  const stillCold = call(room, stateAfterTwoCold, NINE_AM);
  assert.equal(stillCold.stage, "cold");
  assert.equal(stillCold.step, 3, "ยังไม่เปลี่ยนระดับ = เดินต่อไม้ 3");
  assert.ok(Math.abs(stillCold.dueAt - (NINE_AM + 11 * HOUR)) <= 31 * MIN);

  // ลูกค้าทักกลับ คะแนนขึ้นเป็น warm — anchor ขยับมาที่ข้อความใหม่ และบันไดเริ่มไม้ 1 ของ warm
  const warmAnchor = NINE_AM + 3 * HOUR;
  const warm = call({ ...room, last_score: 6 }, { ...stateAfterTwoCold }, warmAnchor);
  assert.equal(warm.stage, "warm");
  assert.equal(warm.step, 1, "ข้ามมา warm ต้องเริ่มไม้ 1 ไม่ใช่สืบเลขขั้นจาก cold");
  assert.ok(Math.abs(warm.dueAt - (warmAnchor + 4 * HOUR)) <= 31 * MIN,
    "ต้องใช้ตาราง warm ของ Facebook (4 ชม.) นับจากข้อความใหม่ของลูกค้า");

  // ทักอีก คะแนนขึ้น hot — เริ่มไม้ 1 ของ hot (45 นาที) นับจากข้อความล่าสุด
  const hotAnchor = warmAnchor + 30 * MIN;
  const hot = call({ ...room, last_score: 9 },
    { ...stateAfterTwoCold, stage_key: "warm", ladder_stage: 1 }, hotAnchor);
  assert.equal(hot.stage, "hot");
  assert.equal(hot.step, 1);
  assert.ok(Math.abs(hot.dueAt - (hotAnchor + 45 * MIN)) <= 11 * MIN);
});

// v1.4.x: ค่า STAGED_*_DELAY_MS (ดีฟอลต์ cold 1ชม. / warm 30น. / hot 30น.) ทับ "ไม้แรก" ของ
// ทุกระดับในช่องปกติ — บน Facebook ต้องไม่ทับ ไม่งั้นตารางที่คำนวณให้พอดีหน้าต่างจะเพี้ยน
test("ปุ่มปรับไม้แรกจาก env ต้องไม่แตะตารางของ Facebook (แต่ยังใช้กับช่องอื่นเหมือนเดิม)", () => {
  const override = 20 * HOUR; // ค่าสุดโต่งที่ถ้าหลุดเข้าไปจะทำให้ไม้สลับลำดับ
  for (const stage of ["cold", "warm", "hot"]) {
    assert.deepEqual(scheduleFor(stage, override, "facebook"), scheduleFor(stage, null, "facebook"),
      `${stage} ของ Facebook ต้องไม่ถูก override`);
    assert.equal(scheduleFor(stage, override, "default")[0].at.ms, override,
      `${stage} ของช่องปกติต้องยังปรับไม้แรกได้`);
  }
});
