// "ขอเช็คคิวก่อน / ขอเช็ควันก่อน" (คำสั่งพี่ง้วง 28 ก.ย. 2026) — ตัวจับเจตนา + ตัวจับคำตอบรับสั้น
// + การเดินของหมุดในห้อง + สวิตช์ + บรรทัดสั่งงานของเทิร์นตอบ (ข้อความลูกค้าสังเคราะห์ทั้งหมด)
import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULE_CHECK_FOLLOWUP_KEY, classifyScheduleCheck, isAckOnly, nextScheduleCheckMarker,
  scheduleCheckFollowupEnabled, scheduleCheckFollowupMode, scheduleCheckReplyDirective,
} from "../src/scheduleCheck.mjs";
import { classifyFollowupSuppression } from "../src/followupSuppression.mjs";
import { ordersBannedPhrases, PRICE_MENTION } from "../src/priceDirectives.mjs";

const HOUR = 3_600_000;
const MON_10 = Date.UTC(2026, 8, 28, 3, 0, 0); // จันทร์ 28 ก.ย. 2026 10:00 เวลาไทย

test("จับลูกค้าที่ขอไปเช็คคิว/วัน/ตารางของตัวเองก่อน", () => {
  for (const text of [
    "ขอเช็คคิวก่อนนะคะ",
    "ขอเช็ควันก่อนค่ะ",
    "เดี๋ยวดูวันก่อนค่ะ",
    "เดี๋ยวผมขอเช็คเวลา",
    "เด๋วเชคเวลาอีกที",
    "ต้องเช็คตารางก่อนค่ะ",
    "ผมเช็คตารางงานก่อนนะครับ",
    "ขอดูตารางงานก่อนนะครับ",
    "ถ้างั้น เดะขอดูตารางก่อนนะครับ",
    "เดี๋ยวพี่ขอเช็ควันนิดนึงนะคะ^^",
    "ขอเช็คกับทีมก่อนว่าว่างวันไหน",
    "ขอเช็คกับที่ออฟฟิศก่อนว่าสะดวกวันไหนนะคะ",
    "เดี๋ยวดูคิวแล้วแจ้งนะครับ",
    "ไว้ดูวันแล้วจะแจ้งอีกทีนะคะ",
    "เดี๋ยวขอวางตารางตัวเองก่อนนะครับ",
    "ขอเช็คคิวก่อน มีรอบไหนบ้างคะ",
    "ขอเช็คคิวก่อนได้ไหมคะ",
    "Let me check my schedule first",
    "I'll check my calendar and get back to you",
  ]) assert.ok(classifyScheduleCheck(text), text);
});

test("ไม่จับ: ขอให้เราเช็ค · ขอดูตารางของเรา · ถามคิว · จองคิว · ขอคิดก่อนทั่วไป · ปฏิเสธ · ยกตัวอย่าง", () => {
  for (const text of [
    "จองคิวได้ไหม",
    "ตารางเรียน",
    "ขอตารางเรียนหน่อยค่ะ",
    "รบกวนขอดูตารางอีกครั้งค่ะ",
    "ช่วยเช็คคิวให้หน่อยได้ไหมคะ",
    "รบกวนเช็ควันว่างของพี่ง้วงให้หน่อยค่ะ",
    "คิวพรุ่งนี้เต็มรึยังครับ",
    "มีคิวว่างวันไหนบ้างคะ",
    "จะเช็คคิวยังไงคะ",
    "ขอคิดก่อนนะครับ",
    "ขอคิดดูก่อนค่ะ",
    "ไม่ต้องเช็คคิวแล้วค่ะ จองรอบ 10 ได้เลย",
    "ตัวอย่างลูกค้าพูดว่า ขอเช็คคิวก่อน",
    "อยากให้ AI ช่วยจัดตารางงานพนักงาน",
    "ทำ schedule ตารางติดตามงานได้ไหม",
    "",
  ]) assert.equal(classifyScheduleCheck(text), null, JSON.stringify(text));
});

test("ขอคิดก่อนทั่วไปยังเป็นการหยุดติดตามเต็มรูปแบบ ส่วนขอเช็คคิวไม่ใช่", () => {
  assert.ok(classifyFollowupSuppression("ขอคิดดูก่อนค่ะ"));
  assert.equal(classifyFollowupSuppression("ขอเช็คคิวก่อนนะคะ"), null);
  assert.equal(classifyFollowupSuppression("เดี๋ยวดูวันก่อนค่ะ"), null);
});

test("คำตอบรับสั้น ๆ (ไม่ใช่เรื่องใหม่)", () => {
  for (const text of ["ค่ะ", "ครับ", "โอเคค่ะ", "ได้ค่ะ ขอบคุณค่ะ", "ขอบคุณมากค่ะ 🙏", "รับทราบครับ", "👍", "ok thanks"]) {
    assert.equal(isAckOnly(text), true, text);
  }
  for (const text of ["", "สนใจรอบ 10 ต.ค. ค่ะ", "ขอบคุณค่ะ แล้วรอบหน้าวันไหนคะ", "โอเคค่ะ แต่อยากถามเรื่องราคา", "ค่ะ?"]) {
    assert.equal(isAckOnly(text), false, text);
  }
});

test("หมุดในห้อง: ตั้งเมื่อขอเช็คคิว · คงไว้เมื่อตอบรับสั้นหรือพิมพ์ต่อในไม่กี่นาที · ล้างเมื่อพูดเรื่องใหม่", () => {
  const set = nextScheduleCheckMarker({ markerJson: "", text: "ขอเช็คคิวก่อน เดี๋ยวพรุ่งนี้แจ้งนะคะ", atMs: MON_10 });
  assert.deepEqual(set, { kind: "schedule_check", at: MON_10, hint: "2026-09-29" });
  const json = JSON.stringify(set);
  assert.equal(nextScheduleCheckMarker({ markerJson: json, text: "ขอบคุณค่ะ", atMs: MON_10 + HOUR }), undefined, "ตอบรับ = คงไว้");
  assert.equal(nextScheduleCheckMarker({ markerJson: json, text: "มีรอบออนไลน์ไหมคะ", atMs: MON_10 + 60_000 }), undefined,
    "พิมพ์ต่อในก้อนเดียวกัน (ไม่เกิน 3 นาที) = คงไว้");
  assert.equal(nextScheduleCheckMarker({ markerJson: json, text: "มีรอบออนไลน์ไหมคะ", atMs: MON_10 + HOUR }), null, "เรื่องใหม่ = ล้าง");
  assert.equal(nextScheduleCheckMarker({ markerJson: "", text: "สวัสดีค่ะ", atMs: MON_10 }), undefined, "ไม่มีหมุด = ไม่แตะ");
  const sent = JSON.stringify({ ...set, sentAt: MON_10 + 48 * HOUR });
  assert.equal(nextScheduleCheckMarker({ markerJson: sent, text: "ค่ะ", atMs: MON_10 + 49 * HOUR }), null,
    "ทักไปแล้ว ลูกค้าตอบอะไรก็ตาม = จบรอบนี้ กลับสู่การคุยปกติ");
  const again = nextScheduleCheckMarker({ markerJson: sent, text: "ขอเช็ควันอีกทีนะคะ", atMs: MON_10 + 50 * HOUR });
  assert.equal(again.at, MON_10 + 50 * HOUR, "ขอเช็คคิวรอบใหม่ = ตั้งหมุดใหม่");
  assert.equal(nextScheduleCheckMarker({ markerJson: "{พัง", text: "ค่ะ", atMs: MON_10 }), undefined);
});

test("สวิตช์ schedule_check_followup: ไม่มีแถว = on · off = ปิด · อ่านพัง = off", () => {
  const dbWith = (value) => ({ getSetting: (key) => (key === SCHEDULE_CHECK_FOLLOWUP_KEY ? value : null) });
  assert.equal(scheduleCheckFollowupMode(dbWith(null)), "on");
  assert.equal(scheduleCheckFollowupMode(dbWith(" OFF ")), "off");
  assert.equal(scheduleCheckFollowupMode(dbWith("on")), "on");
  assert.equal(scheduleCheckFollowupMode({ getSetting: () => { throw new Error("db"); } }), "off");
  assert.equal(scheduleCheckFollowupEnabled(dbWith(null)), true);
  assert.equal(scheduleCheckFollowupEnabled(dbWith("off")), false);
});

const ROUNDS = [
  { date: "2026-10-03", classKey: "advance", label: "Classroom AI Agent Workflow Automation", product: "AI Agent Workflow Automation", fileStatus: "full", thai: "3 ต.ค. 2026", seatsLeft: 0 },
  { date: "2026-10-10", classKey: "basic", label: "Classroom AI Agent for Business", product: "AI Agent for Business", fileStatus: "open", thai: "10 ต.ค. 2026", seatsLeft: null },
  { date: "2026-10-17", classKey: "basic", label: "Classroom AI Agent for Business", product: "AI Agent for Business", fileStatus: "almost_full", thai: "17 ต.ค. 2026", seatsLeft: 4 },
  { date: "2026-10-24", classKey: "advance", label: "Classroom AI Agent Workflow Automation", product: "AI Agent Workflow Automation", fileStatus: "open", thai: "24 ต.ค. 2026", seatsLeft: null },
  { date: "2026-10-31", classKey: "advance", label: "Classroom AI Agent Workflow Automation", product: "AI Agent Workflow Automation", fileStatus: "closed", thai: "31 ต.ค. 2026", seatsLeft: null },
];

test("บรรทัดสั่งงานเทิร์นตอบ: ให้รอบที่เปิดอยู่จริง · ไม่ต้องรีบ · ห้ามปิดท้ายด้วยคำถาม · ห้ามเร่ง/ขาย", () => {
  const rule = scheduleCheckReplyDirective({ enabled: true, text: "ขอเช็คคิวก่อนนะคะ", rounds: ROUNDS });
  assert.match(rule, /ขอเช็คคิว/u);
  assert.match(rule, /ไม่ต้องรีบนะคะ/u);
  assert.match(rule, /พิมพ์วันที่/u);
  assert.match(rule, /ห้ามปิดท้ายด้วยคำถาม/u);
  assert.match(rule, /ห้ามพูดว่าที่นั่งใกล้เต็ม/u);
  assert.match(rule, /ห้ามบอกหรือบอกเป็นนัยว่าจอง/u);
  assert.match(rule, /10 ต\.ค\. 2026/u);
  assert.match(rule, /24 ต\.ค\. 2026/u);
  assert.doesNotMatch(rule, /3 ต\.ค\. 2026/u, "รอบที่เต็มแล้วต้องไม่อยู่ในรายการ");
  assert.doesNotMatch(rule, /31 ต\.ค\. 2026/u, "รอบที่ปิดรับต้องไม่อยู่ในรายการ");
  assert.doesNotMatch(rule, /เหลือ\s*\d+\s*ที่/u, "ไม่ยื่นจำนวนที่นั่งเหลือให้ลูกค้า");
  assert.equal(PRICE_MENTION.test(rule), false, "ไม่มีคำเรื่องเงิน — จังหวะราคาเป็นของ priceDisclosure ที่เดียว");
  assert.deepEqual(ordersBannedPhrases(rule), [], "ไม่สั่งให้พูดวลีที่เทิร์นคัดกรองแบน");
  assert.equal(scheduleCheckReplyDirective({ enabled: false, text: "ขอเช็คคิวก่อนนะคะ", rounds: ROUNDS }), "", "สวิตช์ปิด = พรอมต์เดิมทุกไบต์");
  assert.equal(scheduleCheckReplyDirective({ enabled: true, text: "สนใจคลาสค่ะ", rounds: ROUNDS }), "");
  const noRounds = scheduleCheckReplyDirective({ enabled: true, text: "ขอเช็คคิวก่อนนะคะ", rounds: [] });
  assert.match(noRounds, /ห้ามเดาวันที่/u);
  assert.doesNotMatch(noRounds, /ต\.ค\./u);
});
