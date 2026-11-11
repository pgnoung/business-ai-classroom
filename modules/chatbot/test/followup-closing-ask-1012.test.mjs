// followup-closing-ask-1012.test.mjs — เจน 12 ต.ค. ค่ำ: ทักตามส่งของค้าง + รีวิว ต้องปิดท้ายด้วยคำถาม ไม่ใช่ลิงก์รีวิว (ข้อความสังเคราะห์)
import test from "node:test";
import assert from "node:assert/strict";
import { attachBeforeClosingAsk } from "../src/stagedFollowups.mjs";

const REVIEW = "ฝากรีวิวจากผู้เรียนจริงไว้ประกอบการเลือกนะคะ\nคุณเอ · เจ้าของธุรกิจ\nhttps://pngoungacademy.com/reviews/x";

test("ย่อหน้าสุดท้ายเป็นคำถาม = ของค้าง → รีวิว → คำถาม", () => {
  const draft = "ส่งรายละเอียดค่าเรียนมาให้ค่ะ\n📌 AI Agent for Business\nโปรโมชั่น Early Bird 12,900 บาท/ท่าน\n\nอยากให้ลูกแพรส่งรอบที่เปิดเรียนให้ดูไหมคะ?";
  assert.deepEqual(attachBeforeClosingAsk(draft, REVIEW), [
    "ส่งรายละเอียดค่าเรียนมาให้ค่ะ\n📌 AI Agent for Business\nโปรโมชั่น Early Bird 12,900 บาท/ท่าน", REVIEW, "อยากให้ลูกแพรส่งรอบที่เปิดเรียนให้ดูไหมคะ?"]);
});

test("บรรทัดสุดท้ายเป็นคำถาม (ไม่มีย่อหน้า) ก็ย้ายคำถามไปท้าย", () => {
  assert.deepEqual(attachBeforeClosingAsk("ลูกแพรสรุปเส้นทางเรียนให้นะคะ\nสนใจคลาสไหนก่อนคะ?", REVIEW),
    ["ลูกแพรสรุปเส้นทางเรียนให้นะคะ", REVIEW, "สนใจคลาสไหนก่อนคะ?"]);
});

test("ไม่มีคำถามปิดท้าย = [ข้อความ, รีวิว] · ทั้งก้อนเป็นคำถามเดียว = [รีวิว, คำถาม]", () => {
  assert.deepEqual(attachBeforeClosingAsk("ส่งรายละเอียดให้แล้วนะคะ", REVIEW), ["ส่งรายละเอียดให้แล้วนะคะ", REVIEW]);
  assert.deepEqual(attachBeforeClosingAsk("สนใจรอบไหนคะ?", REVIEW), [REVIEW, "สนใจรอบไหนคะ?"]);
});

test("ย่อหน้าเดียวหลายประโยค = ตัดที่คำลงท้ายตัวสุดท้าย: ข้อความ → รีวิว → คำถาม", () => {
  assert.deepEqual(attachBeforeClosingAsk("ยินดีเลยค่ะ ผู้เรียนหลายท่านนำไปใช้กับงานร้านได้จริงค่ะ อยากให้ลูกแพรช่วยดูว่าคลาสไหนเหมาะไหมคะ?", REVIEW),
    ["ยินดีเลยค่ะ ผู้เรียนหลายท่านนำไปใช้กับงานร้านได้จริงค่ะ", REVIEW, "อยากให้ลูกแพรช่วยดูว่าคลาสไหนเหมาะไหมคะ?"]);
});
