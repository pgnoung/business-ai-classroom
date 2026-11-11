// ตารางเวลารายขั้น + การสุ่มจังหวะ (คำสั่งเจ้าของ 2026-08-28)
//
// เจ้าของสั่งให้สุ่มเวลาส่ง "จะได้ไม่เป็นบอทแบบเป๊ะเกิน" แต่การสุ่มสด ๆ ทุกครั้งที่ถาม
// จะทำให้เวลาที่ badge บนคอนโซลบอก ไม่ตรงกับเวลาที่ยิงจริง และเทสต์จะไม่เสถียร
// จึงสุ่มด้วย hash ของ (ห้อง + จังหวะที่ลูกค้าเงียบ + ขั้นที่เท่าไร) — คงที่ต่อห้องต่อขั้น
// แต่ต่างกันไปในแต่ละห้อง จากภายนอกจึงดูสุ่มเหมือนกัน
import test from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_SCHEDULE, STAGE_LADDERS, COLD_LIFETIME_CAP, DAILY_PROACTIVE_CAP,
  stepJitterMs, scheduleFor, resolveStepDueAt,
} from "../src/stagedFollowups.mjs";
import { inQuietHours } from "../src/followupEngine.mjs";
import { SEGMENT_META, segmentOf } from "../public/console/ui.mjs";

const NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;

test("จังหวะตรงกับที่เจ้าของสั่ง", () => {
  assert.equal(STAGE_LADDERS.cold.length, 4, "cold ทัก 4 ครั้ง");
  assert.equal(STAGE_LADDERS.warm.length, 3);
  assert.equal(STAGE_LADDERS.hot.length, 2, "hot เพิ่มไม้สองเช้าวันถัดไป");
  assert.equal(COLD_LIFETIME_CAP, 4);
  assert.equal(DAILY_PROACTIVE_CAP, 1, "วันละ 1 ครั้ง");

  assert.equal(STAGE_SCHEDULE.cold[0].at.ms, 3 * HOUR);
  assert.equal(STAGE_SCHEDULE.cold[1].at.ms, DAY + 3 * HOUR, "วันที่ 2");
  assert.equal(STAGE_SCHEDULE.cold[3].at.ms, 3 * DAY + 3 * HOUR, "วันที่ 4");
  assert.equal(STAGE_SCHEDULE.warm[0].at.ms, 4 * HOUR);
  assert.equal(STAGE_SCHEDULE.warm[1].at.ms, 3 * DAY, "วันที่ 3");
  assert.equal(STAGE_SCHEDULE.warm[2].at.ms, 7 * DAY, "วันที่ 7");
  assert.equal(STAGE_SCHEDULE.hot[0].at.ms, 45 * 60_000);
  assert.equal(STAGE_SCHEDULE.hot[1].at.type, "morning", "hot ไม้สองคือเช้าวันถัดไป");
});

test("สุ่ม: ถามซ้ำต้องได้ค่าเดิมเสมอ (ไม่งั้น badge จะโกหกเวลาที่ยิงจริง)", () => {
  const step = STAGE_SCHEDULE.warm[0];
  const a = stepJitterMs("U-aaa", NOON_BKK, 0, step);
  const b = stepJitterMs("U-aaa", NOON_BKK, 0, step);
  assert.equal(a, b, "seed เดิมต้องได้ค่าเดิม");
});

test("สุ่ม: คนละห้องต้องได้เวลาต่างกัน ไม่ยิงพร้อมกันเป็นแถว", () => {
  const step = STAGE_SCHEDULE.warm[0];
  const values = new Set(
    Array.from({ length: 40 }, (_, i) => stepJitterMs(`U-${i}`, NOON_BKK, 0, step)),
  );
  assert.ok(values.size > 30, `ต้องกระจายจริง (ได้ค่าไม่ซ้ำ ${values.size}/40)`);
});

test("สุ่ม: อยู่ในกรอบ ±15% และไม่เกินครึ่งชั่วโมง", () => {
  const step = STAGE_SCHEDULE.warm[0];
  for (let i = 0; i < 200; i += 1) {
    const jitter = stepJitterMs(`U-${i}`, NOON_BKK, 0, step);
    assert.ok(Math.abs(jitter) <= 30 * 60_000, `เกินเพดาน: ${jitter}`);
  }
});

test("สุ่ม: ขั้นเช้าวันถัดไปต้องบวกอย่างเดียว จะได้ไม่ถอยกลับเข้าช่วงเงียบ", () => {
  const step = STAGE_SCHEDULE.hot[1];
  for (let i = 0; i < 100; i += 1) {
    assert.ok(stepJitterMs(`U-${i}`, NOON_BKK, 1, step) >= 0);
  }
});

test("ทุกขั้นของทุกกลุ่ม ต้องไม่มีวันตกในช่วงเงียบ 21:00-09:00", () => {
  for (const [stage, steps] of Object.entries(STAGE_SCHEDULE)) {
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      for (let i = 0; i < 60; i += 1) {
        // สุ่ม anchor ให้กระจายทั่วทั้งวัน รวมถึงกลางดึก
        const anchor = NOON_BKK + i * 37 * 60_000;
        const due = resolveStepDueAt({
          schedule: steps, stepIndex, anchorMs: anchor,
          lastActivityMs: anchor, customerId: `U-${stage}-${i}`,
        });
        assert.ok(due != null);
        assert.equal(inQuietHours(due), false, `${stage} ขั้น ${stepIndex + 1} ตกในช่วงเงียบ`);
      }
    }
  }
});

test("ห้ามทักซ้อนภายใน 45 นาทีหลังใครก็ตามเพิ่งพิมพ์", () => {
  // แอดมินเพิ่งตอบเอง — ขั้นถัดไปต้องเลื่อนออกไป ไม่ใช่ยิงทับทันที
  const anchor = NOON_BKK - 10 * DAY;
  const justNow = NOON_BKK;
  const due = resolveStepDueAt({
    schedule: STAGE_SCHEDULE.cold, stepIndex: 0,
    anchorMs: anchor, lastActivityMs: justNow, customerId: "U-x",
  });
  assert.ok(due >= justNow + 45 * 60_000, "ต้องเว้นอย่างน้อย 45 นาทีหลังความเคลื่อนไหวล่าสุด");
});

test("ค่า env ปรับได้เฉพาะขั้นแรก ขั้นที่เหลือคงตามตาราง", () => {
  const custom = scheduleFor("warm", 90 * 60_000);
  assert.equal(custom[0].at.ms, 90 * 60_000, "ขั้นแรกรับค่า env");
  assert.equal(custom[1].at.ms, 3 * DAY, "ขั้นสองยังเป็นวันที่ 3");
  assert.equal(custom[2].at.ms, 7 * DAY);
});

test("badge: ห้องที่ติดป้ายเงียบต้องเป็น 🚫 ไม่ใช่ cold/warm/hot", () => {
  assert.equal(segmentOf({ last_score: 9, silenced_tag_at: 1 }), "null",
    "ป้ายเงียบต้องมาก่อน score เสมอ");
  assert.equal(SEGMENT_META.null.icon, "🚫");
  // ห้องปกติต้องไม่เปลี่ยนพฤติกรรม
  assert.equal(segmentOf({ last_score: 9 }), "hot");
  assert.equal(segmentOf({ last_score: 6 }), "warm");
  assert.equal(segmentOf({ last_score: 1 }), "cold");
  assert.equal(segmentOf({}), "cold");
});
