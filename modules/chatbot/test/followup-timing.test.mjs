// followupTiming.mjs — นาฬิกาเวลาไทย ช่องเวลากลางวัน และวันที่ที่ลูกค้าเอ่ย (28 ก.ย. 2026)
// ใช้ร่วมกันโดยข้อความทักเบา ๆ หลังส่งเลขบัญชี และการทักหนึ่งครั้งหลัง "ขอเช็คคิวก่อน"
import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY_MS, HOUR_MS, MINUTE_MS,
  bangkokIsoDate, daytimeIntervals, lateMorningDue, paymentDateHint, pickInIntervals,
  replyDateHint, resolveDateExpressions,
} from "../src/followupTiming.mjs";

// จันทร์ 28 ก.ย. 2026 เวลาไทย
const bkk = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 7, minute, 0);
const MON_10 = bkk(28, 10);
const hm = (ts) => new Date(ts + 7 * HOUR_MS).toISOString().slice(11, 16);

test("ช่วงกลางวันที่ใช้วางแผน = 09:00–20:30 ของแต่ละวันที่ตัดกับช่วงที่ขอ", () => {
  const spans = daytimeIntervals(bkk(28, 15), bkk(29, 10));
  assert.deepEqual(spans.map(([a, b]) => `${bangkokIsoDate(a)} ${hm(a)}-${hm(b)}`), [
    "2026-09-28 15:00-20:30",
    "2026-09-29 09:00-10:00",
  ]);
  assert.deepEqual(daytimeIntervals(bkk(28, 21), bkk(29, 8)), [], "กลางคืนล้วน = ไม่มีช่อง");
  assert.deepEqual(daytimeIntervals(bkk(28, 12), bkk(28, 12)), [], "ช่วงยาวศูนย์ = ไม่มีช่อง");
});

test("pickInIntervals เลือกจุดเดิมทุกครั้งสำหรับค่า unit เดิม และปัดเป็นนาที", () => {
  const spans = [[bkk(28, 10), bkk(28, 11)], [bkk(29, 9), bkk(29, 10)]];
  assert.equal(pickInIntervals(spans, 0), bkk(28, 10));
  assert.equal(pickInIntervals(spans, 0.5), bkk(29, 9));
  const late = pickInIntervals(spans, 0.9999);
  assert.ok(late >= bkk(29, 9) && late < bkk(29, 10));
  assert.equal(late % MINUTE_MS, 0);
  assert.equal(pickInIntervals([], 0.3), null);
});

test("ช่องสาย ๆ (10:00–11:30) วันแรกที่ยังทันหลังเวลาเริ่มได้", () => {
  assert.equal(hm(lateMorningDue({ earliestMs: bkk(29, 4), unit: 0 })), "10:00");
  const within = lateMorningDue({ earliestMs: bkk(29, 11), unit: 0 });
  assert.equal(bangkokIsoDate(within), "2026-09-29");
  assert.ok(within >= bkk(29, 11) && within < bkk(29, 11, 30));
  const nextDay = lateMorningDue({ earliestMs: bkk(29, 12), unit: 0.5 });
  assert.equal(bangkokIsoDate(nextDay), "2026-09-30", "เลยช่องของวันนั้น = วันถัดไป");
  assert.ok(nextDay >= bkk(30, 10) && nextDay < bkk(30, 11, 30));
  const fromDay = lateMorningDue({ earliestMs: bkk(28, 12), notBeforeMs: bkk(1 + 30, 0), unit: 0 });
  assert.equal(bangkokIsoDate(fromDay), "2026-10-01", "มีวันเป้าหมาย = เริ่มนับจากวันนั้น");
});

test("แปลวันที่ภาษาไทยที่ลูกค้าพิมพ์บ่อย โดยนับจากเวลาของข้อความ", () => {
  const iso = (text, ref = MON_10) => resolveDateExpressions(text, ref).map((hit) => hit.iso);
  assert.deepEqual(iso("พรุ่งนี้"), ["2026-09-29"]);
  assert.deepEqual(iso("มะรืนนี้"), ["2026-09-30"]);
  assert.deepEqual(iso("เย็นนี้"), ["2026-09-28"]);
  assert.deepEqual(iso("วันศุกร์"), ["2026-10-02"]);
  assert.deepEqual(iso("วันจันทร์"), ["2026-10-05"], "วันเดียวกับวันนี้โดยไม่มีคำว่า นี้ = สัปดาห์หน้า");
  assert.deepEqual(iso("วันจันทร์นี้"), ["2026-09-28"]);
  assert.deepEqual(iso("วันพุธหน้า"), ["2026-10-07"]);
  assert.deepEqual(iso("อาทิตย์หน้า"), ["2026-10-05"], "อาทิตย์หน้า (ไม่มีคำว่า วัน) = สัปดาห์หน้า");
  assert.deepEqual(iso("วันอาทิตย์หน้า"), ["2026-10-11"]);
  assert.deepEqual(iso("สิ้นเดือน"), ["2026-09-30"]);
  assert.deepEqual(iso("หลังเงินเดือนออก"), ["2026-09-30"]);
  assert.deepEqual(iso("ต้นเดือนหน้า"), ["2026-10-05"]);
  assert.deepEqual(iso("วันที่ 3"), ["2026-10-03"]);
  assert.deepEqual(iso("วันที่ 30"), ["2026-09-30"]);
  assert.deepEqual(iso("5 ต.ค."), ["2026-10-05"]);
  assert.deepEqual(iso("5 ตุลา"), ["2026-10-05"]);
  assert.deepEqual(iso("อีก 3 วัน"), ["2026-10-01"]);
  assert.deepEqual(iso("tomorrow"), ["2026-09-29"]);
  assert.deepEqual(iso("next week"), ["2026-10-05"]);
  assert.deepEqual(iso("ไม่มีวันที่เลย"), []);
  // ข้อความตอนดึก: "พรุ่งนี้" หมายถึงวันถัดจากวันของข้อความ (เวลาไทย) ไม่ใช่ 24 ชม.
  assert.deepEqual(iso("พรุ่งนี้", bkk(28, 23, 50)), ["2026-09-29"]);
});

test("วันที่จ่าย: ต้องมีคำเรื่องจ่ายอยู่ใกล้ ๆ และไม่ถูกปฏิเสธ", () => {
  assert.equal(paymentDateHint("พรุ่งนี้โอนให้นะคะ", MON_10), "2026-09-29");
  assert.equal(paymentDateHint("ได้ค่ะ เดี๋ยวโอนพรุ่งนี้นะคะ", MON_10), "2026-09-29");
  assert.equal(paymentDateHint("เดี๋ยวบ่าย ๆ เย็น ๆ โอนคับ", MON_10), "2026-09-28");
  assert.equal(paymentDateHint("ขอโอนหลังเงินเดือนออกนะคะ", MON_10), "2026-09-30");
  assert.equal(paymentDateHint("สิ้นเดือนจ่ายค่ะ", MON_10), "2026-09-30");
  assert.equal(paymentDateHint("พรุ่งนี้หรือมะรืนโอนค่ะ", MON_10), "2026-09-30", "หลายวัน = เอาวันหลังสุด (ทักทีหลังนุ่มกว่า)");
  assert.equal(paymentDateHint("โอนพรุ่งนี้ไม่ได้ค่ะ ขอเป็นสิ้นเดือน โอนนะคะ", MON_10), "2026-09-30");
  assert.equal(paymentDateHint("พรุ่งนี้ว่างไหมคะ", MON_10), null, "ไม่มีคำเรื่องจ่าย = ไม่ใช่วันจ่าย");
  assert.equal(paymentDateHint("ขอเรียนรอบ 10 ต.ค. ค่ะ", MON_10), null);
  assert.equal(paymentDateHint("", MON_10), null);
});

test("วันที่จะตอบกลับ: ต้องมีคำว่าแจ้ง/บอก/ตอบ อยู่ใกล้ ๆ — วันเรียนที่เอ่ยถึงไม่ใช่วันตอบ", () => {
  assert.equal(replyDateHint("ขอเช็คคิวก่อน เดี๋ยวพรุ่งนี้แจ้งนะคะ", MON_10), "2026-09-29");
  assert.equal(replyDateHint("ขอดูตารางก่อน วันศุกร์ตอบได้ค่ะ", MON_10), "2026-10-02");
  assert.equal(replyDateHint("ขอเช็คคิววันที่ 10 ก่อนนะคะ", MON_10), null);
  assert.equal(replyDateHint("เดี๋ยวเช็คตารางช่วงตุลาชัวร์ ๆ ค่ะ เดี๋ยวแจ้งวันที่", MON_10), null,
    "\"แจ้งวันที่\" ไม่มีตัวเลข = ไม่ใช่วันที่");
  assert.equal(replyDateHint("let me check my schedule, I'll get back to you tomorrow", MON_10), "2026-09-29");
});

test("ค่าคงที่เวลา", () => {
  assert.equal(DAY_MS, 24 * HOUR_MS);
  assert.equal(HOUR_MS, 60 * MINUTE_MS);
});
