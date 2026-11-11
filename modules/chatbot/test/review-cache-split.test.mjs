import test from "node:test";
import assert from "node:assert/strict";
import { focusReviewKnowledge, splitReviewKnowledge } from "../src/reviewSelection.mjs";

const section = (name, entries) => `[${name}]\n` + entries.map(([who, id]) => `- ${who} | รีวิว: https://www.facebook.com/reel/${id}`).join("\n");
const knowledge = [
  "[ความรู้ทั่วไป]\nคลาสสอนสดกลุ่มเล็ก มี TA ช่วย",
  "[คลังรีวิว]\nใช้ลิงก์ตรงตามรายการนี้เป๊ะ ๆ",
  section("Classroom - AI Agent For Business", [["เจ้าของร้านกาแฟ", "cafe"], ["ผู้เรียนหลากหลายธุรกิจ", "general"]]),
  section("Classroom - Workflow Automation", [["ทีมบัญชี โรงงาน", "workflow"]]),
  "[ปิดท้าย]\nจบความรู้",
].join("\n\n");
const contexts = [
  { text: "สวัสดีค่ะ สนใจคลาส" },
  { text: "มือใหม่เรียนได้ไหม กลัวตามไม่ทัน", nurture: true },
  { text: "ทำร้านกาแฟ ขอดูรีวิวคนที่เรียนแล้ว" },
  { text: "ขอรีวิว workflow automation" },
].map((context) => ({ history: [], sentUrls: new Set(), ...context }));
const reviewLines = (text) => text.split("\n").filter((line) => /\| รีวิว:/u.test(line)).sort();

test("ก้อนความรู้หลังแยกรีวิวเหมือนกันทุกเทิร์น และไม่มีรายการรีวิวเหลือ (แคช Claude ติดทั้งก้อน)", () => {
  const stable = contexts.map((context) => splitReviewKnowledge(knowledge, context).knowledge);
  assert.ok(stable.every((text) => text === stable[0]));
  assert.deepEqual(reviewLines(stable[0]), []);
  assert.match(stable[0], /คลาสสอนสดกลุ่มเล็ก/u);
  assert.match(stable[0], /\[Classroom - Workflow Automation\]/u);
});

test("รีวิวที่เลือกตรงกับ focusReviewKnowledge ทุกเทิร์น พร้อมหัวหมวดของรีวิว", () => {
  for (const context of contexts) {
    const { focus } = splitReviewKnowledge(knowledge, context);
    assert.deepEqual(reviewLines(focus), reviewLines(focusReviewKnowledge(knowledge, context)));
    assert.match(focus, /\[ข้อกำกับหลักฐานที่เลือกในเทิร์นนี้\]/u);
  }
  const cafe = splitReviewKnowledge(knowledge, contexts[2]).focus;
  assert.match(cafe, /\[Classroom - AI Agent For Business\]\n- เจ้าของร้านกาแฟ \| รีวิว: https:\/\/www\.facebook\.com\/reel\/cafe/u);
});

test("ไม่มีคลังรีวิว = ความรู้เดิมทุกไบต์ ไม่มีก้อนรีวิว", () => {
  assert.deepEqual(splitReviewKnowledge("[ความรู้]\nไม่มีรีวิว", contexts[0]), { knowledge: "[ความรู้]\nไม่มีรีวิว", focus: "" });
});
