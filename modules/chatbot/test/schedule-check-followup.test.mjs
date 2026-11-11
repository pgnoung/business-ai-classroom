// "ขอเช็คคิวก่อน" → ทักหนึ่งครั้งแทนบันไดปกติ (คำสั่งพี่ง้วง 28 ก.ย. 2026) — เวลาของ LINE/FB + ข้อความทัก
import test from "node:test";
import assert from "node:assert/strict";
import {
  FB_CHECKIN_MARGIN_MS, planScheduleCheckIn, scheduleCheckEpisode, scheduleCheckInText,
} from "../src/scheduleCheckIn.mjs";
import { FB_MESSAGING_WINDOW_MS } from "../src/db.mjs";
import { inQuietHours } from "../src/followupEngine.mjs";
import { bangkokIsoDate } from "../src/followupTiming.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const bkk = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 7, minute, 0); // ก.ย. 2026 เวลาไทย
const hm = (ts) => new Date(ts + 7 * HOUR).toISOString().slice(11, 16);
const FB = "facebook:112233445566";
const LINE = "U0123456789abcdef0123456789abcdef";

test("LINE: ไม่มีวันที่ = อีกสองวัน ช่วงสาย ๆ (10:00–11:30)", () => {
  for (const hour of [0, 9, 10, 13, 18, 20, 21, 23]) {
    const at = bkk(28, hour);
    const plan = planScheduleCheckIn({ channelId: "default", customerId: LINE, deferralAt: at, lastInboundAt: at });
    assert.equal(bangkokIsoDate(plan.dueAt), "2026-09-30", `ขอเช็คคิวตอน ${hour}:00`);
    assert.ok(hm(plan.dueAt) >= "10:00" && hm(plan.dueAt) <= "11:30", hm(plan.dueAt));
  }
});

test("LINE: ลูกค้าบอกวันที่จะแจ้ง = วันถัดจากวันนั้น · เกิน 7 วัน = ไม่ทัก", () => {
  const at = bkk(28, 10);
  const tomorrow = planScheduleCheckIn({ channelId: "default", customerId: LINE, deferralAt: at, lastInboundAt: at, hintIso: "2026-09-29" });
  assert.equal(bangkokIsoDate(tomorrow.dueAt), "2026-09-30");
  const friday = planScheduleCheckIn({ channelId: "default", customerId: LINE, deferralAt: at, lastInboundAt: at, hintIso: "2026-10-02" });
  assert.equal(bangkokIsoDate(friday.dueAt), "2026-10-03");
  const today = planScheduleCheckIn({ channelId: "default", customerId: LINE, deferralAt: at, lastInboundAt: at, hintIso: "2026-09-28" });
  assert.equal(bangkokIsoDate(today.dueAt), "2026-09-29", "บอกว่าจะแจ้งวันนี้ = ทักพรุ่งนี้สาย ๆ");
  const far = planScheduleCheckIn({ channelId: "default", customerId: LINE, deferralAt: at, lastInboundAt: at, hintIso: "2026-10-10" });
  assert.deepEqual(far, { skip: "beyond_7_days" });
});

test("FB: ทุกเวลาที่ลูกค้าเงียบ (ทุก 30 นาที 00:00–23:30) ต้องอยู่ในหน้าต่าง 24 ชม. เผื่อ 30 นาที และไม่ตกช่วงเงียบ", () => {
  const deadlineGap = FB_MESSAGING_WINDOW_MS - FB_CHECKIN_MARGIN_MS;
  for (let minute = 0; minute < 24 * 60; minute += 30) {
    const at = bkk(28, 0, minute);
    const plan = planScheduleCheckIn({ channelId: "facebook", customerId: FB, deferralAt: at, lastInboundAt: at });
    if (plan.skip) {
      assert.fail(`ต้องมีช่องเสมอสำหรับ FB (เงียบ ${hm(at)}) — ได้ ${plan.skip}`);
    }
    assert.ok(plan.dueAt - at <= deadlineGap, `เงียบ ${hm(at)} → ${((plan.dueAt - at) / HOUR).toFixed(2)} ชม.`);
    assert.ok(plan.dueAt - at >= 6 * HOUR, `เงียบ ${hm(at)} → เร็วเกินไป`);
    assert.equal(inQuietHours(plan.dueAt), false, `เงียบ ${hm(at)} → ${hm(plan.dueAt)} ตกช่วงเงียบ`);
    assert.ok(hm(plan.dueAt) <= "20:30", `เงียบ ${hm(at)} → ${hm(plan.dueAt)} ชิด 21:00 เกินไป`);
  }
});

test("FB: ช่วง 18–22 ชม. หลังข้อความลูกค้าเมื่อตกกลางวัน ไม่งั้นช่องกลางวันช่วงท้ายสุดก่อนประตูปิด", () => {
  const noon = planScheduleCheckIn({ channelId: "facebook", customerId: FB, deferralAt: bkk(28, 12), lastInboundAt: bkk(28, 12) });
  assert.ok(noon.dueAt - bkk(28, 12) >= 18 * HOUR && noon.dueAt - bkk(28, 12) <= 22 * HOUR, hm(noon.dueAt));
  const nine = planScheduleCheckIn({ channelId: "facebook", customerId: FB, deferralAt: bkk(28, 9), lastInboundAt: bkk(28, 9) });
  assert.equal(bangkokIsoDate(nine.dueAt), "2026-09-28", "18–22 ชม. ตกกลางคืน = เย็นวันเดียวกันก่อน 20:30");
  assert.ok(hm(nine.dueAt) >= "20:00" && hm(nine.dueAt) <= "20:30", hm(nine.dueAt));
  const ten = planScheduleCheckIn({ channelId: "facebook", customerId: FB, deferralAt: bkk(28, 10), lastInboundAt: bkk(28, 10) });
  assert.equal(bangkokIsoDate(ten.dueAt), "2026-09-29", "ช่องท้ายสุดก่อนประตูปิดคือเช้าวันถัดไป");
  assert.ok(hm(ten.dueAt) >= "09:00" && ten.dueAt <= bkk(28, 10) + FB_MESSAGING_WINDOW_MS - FB_CHECKIN_MARGIN_MS, hm(ten.dueAt));
});

test("FB: ลูกค้าบอกว่าจะแจ้งวันหลังกว่าวันที่ทักได้ = ไม่ทัก (ไม่จี้ก่อนวันที่เขาให้ไว้)", () => {
  const at = bkk(28, 12);
  assert.deepEqual(planScheduleCheckIn({ channelId: "facebook", customerId: FB, deferralAt: at, lastInboundAt: at, hintIso: "2026-10-02" }),
    { skip: "customer_named_later_date" });
  assert.ok(planScheduleCheckIn({ channelId: "facebook", customerId: FB, deferralAt: at, lastInboundAt: at, hintIso: "2026-09-29" }).dueAt);
});

test("episode: ใช้หมุดเฉพาะเมื่อสวิตช์เปิด · ทักแล้วลูกค้าตอบ = กลับสู่ปกติ · ทักแล้วยังเงียบ = บันไดจบ", () => {
  const at = bkk(28, 10);
  const marker = JSON.stringify({ kind: "schedule_check", at, hint: null });
  const on = scheduleCheckEpisode({ enabled: true, deferJson: marker, lastInboundAt: at, channelId: "default", customerId: LINE });
  assert.equal(on.stage, "schedule_check");
  assert.deepEqual(on.ladder, ["schedule_check"]);
  assert.equal(on.schedule[0].at.type, "at");
  assert.equal(bangkokIsoDate(on.schedule[0].at.dueAt), "2026-09-30");
  assert.equal(scheduleCheckEpisode({ enabled: false, deferJson: marker, lastInboundAt: at, channelId: "default", customerId: LINE }), null);
  assert.equal(scheduleCheckEpisode({ enabled: true, deferJson: "", lastInboundAt: at, channelId: "default", customerId: LINE }), null);
  const sentAt = bkk(30, 10, 30);
  const sentJson = JSON.stringify({ kind: "schedule_check", at, hint: null, sentAt });
  assert.equal(scheduleCheckEpisode({ enabled: true, deferJson: sentJson, lastInboundAt: sentAt + HOUR, channelId: "default", customerId: LINE }), null,
    "ลูกค้าตอบหลังเราทักแล้ว = คุยปกติ");
  const quiet = scheduleCheckEpisode({ enabled: true, deferJson: sentJson, lastInboundAt: at, channelId: "default", customerId: LINE });
  assert.equal(quiet.stage, "schedule_check", "ทักแล้วยังเงียบ = episode เดิม (บันไดจบที่ขั้นเดียว)");
  const skipped = scheduleCheckEpisode({ enabled: true, deferJson: JSON.stringify({ kind: "schedule_check", at, hint: "2026-10-20" }), lastInboundAt: at, channelId: "default", customerId: LINE });
  assert.deepEqual(skipped.ladder, [], "เกิน 7 วัน = ไม่ทักเลย และบันไดปกติไม่กลับมา");
  assert.equal(skipped.skip, "beyond_7_days");
});

const ROUNDS = [
  { date: "2026-10-03", classKey: "advance", label: "Classroom AI Agent Workflow Automation", product: "AI Agent Workflow Automation", fileStatus: "full", thai: "3 ต.ค. 2026", seatsLeft: 0 },
  { date: "2026-10-10", classKey: "basic", label: "Classroom AI Agent for Business", product: "AI Agent for Business", fileStatus: "open", thai: "10 ต.ค. 2026", seatsLeft: null },
  { date: "2026-10-17", classKey: "basic", label: "Classroom AI Agent for Business", product: "AI Agent for Business", fileStatus: "almost_full", thai: "17 ต.ค. 2026", seatsLeft: 4 },
  { date: "2026-10-24", classKey: "advance", label: "Classroom AI Agent Workflow Automation", product: "AI Agent Workflow Automation", fileStatus: "open", thai: "24 ต.ค. 2026", seatsLeft: null },
];
const BANNED = /รีบ(?!ร้อน)|ด่วน|ใกล้เต็ม|เหลือน้อย|เหลือ\s*\d+\s*ที่|หมดเขต|ภายในวันที่|ก่อนวันที่|จอง(?:ที่)?ไว้ให้|กันที่|ล็อกที่|ทวง|บาท|\d{3,}/u;

test("ข้อความทัก: รอบที่ลูกแพรเพิ่งส่งให้ดูและยังเปิดอยู่ · คำถามนุ่มเดียว · ไม่มีคำเร่ง/ตัวเลขเงิน", () => {
  const text = scheduleCheckInText({
    channelId: "default", customerId: LINE, anchorMs: bkk(28, 10), name: "คุณเอ",
    rounds: ROUNDS,
    recentTexts: ["รอบที่เปิดอยู่มีวันเสาร์ที่ 3 ต.ค. กับ 10 ต.ค. และ 17 ต.ค. ค่ะ ไม่ต้องรีบนะคะ"],
  });
  assert.match(text, /คุณเอ/u);
  assert.match(text, /ไม่ทราบว่าได้เช็คคิวแล้วสะดวกรอบไหนดีนะคะ/u);
  assert.match(text, /10 ต\.ค\./u);
  assert.match(text, /17 ต\.ค\./u);
  assert.doesNotMatch(text, /3 ต\.ค\./u, "รอบที่เต็มแล้วต้องไม่ถูกเสนอ");
  assert.doesNotMatch(text, /24 ต\.ค\./u, "ไม่เสนอรอบของอีกคลาสที่ไม่ได้คุยกัน");
  assert.doesNotMatch(text.replace("ไม่ต้องรีบ", ""), BANNED);
  // "ไหนดีนะคะ" (รูปถ่อมตัว 29 ต.ค.) มีคำเติม 4 ตัวก่อน "คะ"
  const questions = text.match(/(?:ไหน|ไหม|มั้ย|อะไร|ยังไง|เมื่อไ(?:หร่|ร))\S{0,4}คะ|\?/gu) || [];
  assert.equal(questions.length, 1, "คำถามนุ่ม ๆ ข้อเดียว");
});

test("ข้อความทัก: ไม่รู้รอบ = ไม่ระบุวันที่ · FB สั้นกว่า · ไม่มีชื่อ = ไม่เรียกชื่อ", () => {
  const none = scheduleCheckInText({ channelId: "default", customerId: LINE, anchorMs: 1, name: "", rounds: ROUNDS, recentTexts: ["สนใจคลาสค่ะ"] });
  assert.doesNotMatch(none, /ต\.ค\./u);
  assert.doesNotMatch(none, /คุณ(?=\s|ค่ะ|คะ)/u);
  const fb = scheduleCheckInText({ channelId: "facebook", customerId: FB, anchorMs: 1, name: "", rounds: ROUNDS, recentTexts: ["คลาส AI Agent for Business ค่ะ"] });
  const line = scheduleCheckInText({ channelId: "default", customerId: FB, anchorMs: 1, name: "", rounds: ROUNDS, recentTexts: ["คลาส AI Agent for Business ค่ะ"] });
  assert.ok(fb.length < line.length, "FB สั้นกว่า");
  assert.match(fb, /10 ต\.ค\./u, "ไม่มีรอบในข้อความเก่า = รอบใกล้สุดของคลาสที่คุยกัน");
  assert.doesNotMatch(fb, BANNED);
});
