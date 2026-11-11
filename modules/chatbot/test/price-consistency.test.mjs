// เทสต์ชุดนี้เกิดจากการตรวจบทสนทนาจริง 2026-08-13
//
// ลูกแพรบอก "ยังไม่มีส่วนลดคู่ รวม 25,800 บาท" แล้ว 44 วินาทีต่อมาบอก
// "ขอแก้ไขข้อมูลส่วนลดเมื่อสักครู่นะคะ ... รวม 23,800 บาท" — ครั้งนั้นแก้ให้ถูกลง ซึ่งถูกต้อง
// แต่ตรวจแล้วพบว่าทิศทางตรงข้าม (เคยบอกถูก แล้วมาบอกแพงขึ้น) ไม่มีอะไรกันเลยแม้แต่ชั้นเดียว
// เพราะ compliance guard ไม่มีความจำระดับเซสชัน และกฎ "ราคาอนุมัติ × จำนวนคน" ปล่อยผ่าน
// ทั้ง 25,800 / 23,800 / 39,800 ทั้งที่ไม่มีเลขไหนอยู่ในตารางโดยตรง
import test from "node:test";
import assert from "node:assert/strict";

import {
  announcesCorrection,
  detectUpwardPriceRevision,
  extractQuotedPrices,
} from "../src/priceConsistency.mjs";
import { stripViolatingSentences, createComplianceGuard } from "../src/complianceGuard.mjs";

const PRIOR = ["ราคาปกติท่านละ 19,900 บาท ตอนนี้ Early Bird ท่านละ 12,900 บาท เรียน 2 ท่านรวม 25,800 บาทค่ะ"];

test("อ่านเฉพาะเลขที่อยู่ในบริบทราคา ไม่ใช่ทุกเลขในข้อความ", () => {
  assert.deepEqual(extractQuotedPrices("ราคา 12,900 บาทค่ะ").sort(), [12900]);
  assert.deepEqual(extractQuotedPrices("เรียน 2 ท่าน รวม 23,800 บาท").sort(), [23800]);
  // เลขที่ไม่ใช่ราคาต้องไม่ถูกจับ (เวลา จำนวนคน เบอร์โทร วันที่)
  assert.deepEqual(extractQuotedPrices("เรียน 10:00-17:00 น. กลุ่มไม่เกิน 15 ท่าน"), []);
  assert.deepEqual(extractQuotedPrices("โทร 021234567 ได้เลยค่ะ"), []);
});

test("จับสำนวนที่ประกาศว่ากำลังแก้ข้อมูลเดิม", () => {
  assert.equal(announcesCorrection("ขอแก้ไขข้อมูลส่วนลดเมื่อสักครู่นะคะ"), true);
  assert.equal(announcesCorrection("ขอปรับราคาที่แจ้งไปนะคะ"), true);
  assert.equal(announcesCorrection("ราคาปกติ 19,900 บาท โปร 12,900 บาทค่ะ"), false);
});

test("แก้ราคาให้ถูกลง = ผ่าน (การแก้ให้ถูกคือสิ่งที่ควรทำ)", () => {
  const revision = detectUpwardPriceRevision(
    "ขอแก้ไขข้อมูลส่วนลดเมื่อสักครู่นะคะ เหลือท่านละ 11,900 บาท รวม 23,800 บาทค่ะ", PRIOR);
  assert.equal(revision.raised, false);
});

test("แก้ราคาให้แพงขึ้น = ต้องหยุดไว้ให้คนจริงตัดสิน", () => {
  const revision = detectUpwardPriceRevision(
    "ขอแก้ไขข้อมูลเมื่อสักครู่นะคะ ราคาจริงคือท่านละ 19,900 บาท รวม 39,800 บาทค่ะ", PRIOR);
  assert.equal(revision.raised, true);
  assert.equal(revision.previous, 25800);
  assert.equal(revision.next, 39800);
});

test("เอ่ยราคาปกติคู่กับราคาโปรตามปกติ ต้องไม่ถูกมองว่ากลับคำ", () => {
  // ถ้าดักกว้างเกิน การขายปกติจะถูกบล็อกทั้งวัน
  for (const text of [
    "ราคาปกติ 19,900 บาท ตอนนี้ Early Bird 12,900 บาทค่ะ",
    "Bundle 2 คลาสราคา 25,900 บาท จากราคาเต็ม 28,800 บาทค่ะ",
    "ถ้ามา 2 ท่าน รวม 23,800 บาทค่ะ",
  ]) {
    assert.equal(detectUpwardPriceRevision(text, PRIOR).raised, false, `ต้องผ่าน: ${text}`);
  }
});

test("ไม่มีประวัติราคา = ไม่มีอะไรให้ขัดแย้ง", () => {
  assert.equal(detectUpwardPriceRevision("ขอแก้ไขนะคะ ราคา 39,800 บาทค่ะ", []).raised, false);
});

/* ---- กู้ประโยคที่ปลอดภัยแทนการทิ้งคำตอบทั้งก้อน ---- */

test("guard บล็อกแล้วต้องกู้ประโยคปิดการขายที่ถูกต้องไว้ได้", () => {
  // ดราฟต์จริงที่ถูกทิ้งทั้งก้อนเมื่อ 2026-08-13 — ประโยคปิดการขายหายไปด้วยและไม่เคยถูกลองใหม่
  const guard = createComplianceGuard({
    bannedWords: [], getApprovedPrices: () => [{ amount: 12900, label: "Early Bird" }],
  });
  const draft = "ตอนนี้ลดพิเศษเหลือ 8,500 บาทค่ะ "
    + "รอบที่เปิดรับคือวันเสาร์ที่ 15 หรือ 22 สิงหาคม เวลา 10:00-17:00 น. สะดวกรอบไหนคะ?";
  assert.equal(guard.checkOutbound(draft).ok, false, "ดราฟต์นี้ต้องถูกบล็อก");

  const salvaged = stripViolatingSentences(draft, (part) => guard.checkOutbound(part));
  assert.ok(salvaged, "ต้องกู้ประโยคที่ปลอดภัยได้");
  assert.match(salvaged.text, /สะดวกรอบไหนคะ/u, "ประโยคปิดการขายต้องรอด");
  assert.doesNotMatch(salvaged.text, /8,500/u, "ราคาที่ไม่อนุมัติต้องหาย");
  assert.equal(salvaged.droppedCount, 1);
});

test("กู้ไม่ได้ = คืน null ให้ใช้ fallback ห้ามส่งเศษข้อความ", () => {
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [] });
  assert.equal(stripViolatingSentences("ราคา 8,500 บาทค่ะ", (t) => guard.checkOutbound(t)), null);
  assert.equal(stripViolatingSentences("", (t) => guard.checkOutbound(t)), null);
});

test("รูปของดราฟต์ที่ถูกบล็อกห้ามติดไปกับประโยคที่กู้มา", () => {
  const guard = createComplianceGuard({
    bannedWords: [], getApprovedPrices: () => [{ amount: 12900, label: "Early Bird" }],
  });
  const draft = "ลดเหลือ 8,500 บาทค่ะ สนใจดูรายละเอียดเพิ่มไหมคะ [IMAGE:ai-agent-for-business]";
  const salvaged = stripViolatingSentences(draft, (part) => guard.checkOutbound(part));
  assert.ok(salvaged);
  assert.doesNotMatch(salvaged.text, /\[\s*image\s*:/iu, "marker รูปต้องถูกตัดออก");
});
