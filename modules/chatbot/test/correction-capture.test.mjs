// correction-capture.test.mjs — "กดส่งร่างเดิมทั้งดุ้น" ต้องไม่ถูกนับเป็นคำแก้ของทีม
//
// เกิดจริง 3 ก.ย. 2026: กล่องตรวจค้าง 170 ใบ ในนั้น 149 ใบต่างกันแค่ marker
// [IMAGE:ai-stage-ladder] ที่ chassis ถอดออกไปทำเป็นรูปก่อนส่ง — คือคนเห็นด้วยกับบอท
// แต่ระบบอ่านว่าคนแก้บอท เจ้าของเปิดจอมาเห็นสองก้อนเหมือนกันเป๊ะแล้วถามว่ามั่วหรือเปล่า
import test from "node:test";
import assert from "node:assert/strict";
import { formatSystemCorrectionSource, isHumanEdit, isRecognizedSystemCorrectionSource, isTeachableCorrection, normalizeOutboundText } from "../src/correctionCapture.mjs";

const DRAFT = "ลูกแพรขออนุญาตประเมินพื้นฐานสั้น ๆ นะคะ [IMAGE:ai-stage-ladder]";
const SENT = "ลูกแพรขออนุญาตประเมินพื้นฐานสั้น ๆ นะคะ";

test("ร่างที่มี marker รูป กับข้อความที่ส่งจริง = ไม่ใช่คำแก้", () => {
  assert.equal(isHumanEdit(DRAFT, SENT), false);
  assert.equal(isTeachableCorrection(DRAFT, SENT), false);
});

test("marker ตัวพิมพ์เล็กก็ต้องถอดเหมือนกัน (แคตตาล็อกรับทั้งสองแบบ)", () => {
  assert.equal(isHumanEdit("สวัสดีค่ะ [image:ai-stage-ladder]", "สวัสดีค่ะ"), false);
});

test("marker หลายตัวในร่างเดียว", () => {
  assert.equal(isHumanEdit("ก [IMAGE:a] ข [IMAGE:b] ค", "ก ข ค"), false);
});

test("ต่างแค่ช่องว่าง/ขึ้นบรรทัด = ไม่ใช่คำแก้", () => {
  assert.equal(isHumanEdit("สวัสดีค่ะ\n\nยินดีค่ะ", "สวัสดีค่ะ ยินดีค่ะ"), false);
});

test("คนแก้เนื้อความจริง = เป็นคำแก้", () => {
  assert.equal(isHumanEdit("สวัสดีค่ะคุณลูกค้า", "ยินดีต้อนรับค่ะคุณลูกค้า"), true);
  assert.equal(isTeachableCorrection("สวัสดีค่ะคุณลูกค้า", "ยินดีต้อนรับค่ะคุณลูกค้า"), true);
});

test("คนแก้เนื้อความจริงในร่างที่มี marker ด้วย = ยังเป็นคำแก้", () => {
  assert.equal(isHumanEdit(DRAFT, "ลูกแพรขอถามสั้น ๆ นะคะ"), true);
});

test("คนส่งแต่รูป/สติกเกอร์ ไม่ได้พิมพ์ข้อความ = ไม่ใช่คำแก้ข้อความ", () => {
  assert.equal(isHumanEdit(DRAFT, ""), false);
  assert.equal(isHumanEdit(DRAFT, "   "), false);
});

test("ไม่มีร่างให้เทียบ = ไม่ใช่คำแก้", () => {
  assert.equal(isHumanEdit("", "ข้อความที่คนพิมพ์เอง"), false);
  assert.equal(isHumanEdit(null, "ข้อความที่คนพิมพ์เอง"), false);
});

test("ร่างที่มีแต่ marker ล้วน = ไม่มีเนื้อความให้เทียบ", () => {
  assert.equal(isHumanEdit("[IMAGE:ai-stage-ladder]", "สวัสดีค่ะ"), false);
});

test("normalizeOutboundText ไม่ค้าง state ข้ามการเรียก (regex มี flag g)", () => {
  const text = "ก [IMAGE:x] ข";
  assert.equal(normalizeOutboundText(text), "ก ข");
  assert.equal(normalizeOutboundText(text), "ก ข");
  assert.equal(normalizeOutboundText(text), "ก ข");
});

test("ไม่โยน error กับ input แปลก ๆ", () => {
  for (const bad of [undefined, null, 0, false, {}, []]) {
    assert.doesNotThrow(() => isHumanEdit(bad, bad));
    assert.doesNotThrow(() => normalizeOutboundText(bad));
  }
});

test("source_reason ของระบบเป็นรหัสปิด เรียงและตัดชนิดที่ไม่อนุญาตโดยไม่เก็บ detail", () => {
  assert.equal(formatSystemCorrectionSource("system:price_revision_upward", [{ type: "price", detail: "99999" }]),
    "system:price_revision_upward");
  assert.equal(formatSystemCorrectionSource("system:compliance_block", [
    { type: "banned_word", detail: "คำต้องห้าม" }, { type: "price", detail: "12345" },
    { type: "price", detail: "67890" }, { type: "unknown", detail: "must-not-leak" },
  ]), "system:compliance_block:banned_word,price");
  assert.equal(formatSystemCorrectionSource("system:followup_compliance_block", ["diagnosis", "price_binding"]),
    "system:followup_compliance_block:diagnosis,price_binding");
  assert.equal(formatSystemCorrectionSource("system:not-a-real-path", ["price"]), "");
  assert.equal(isRecognizedSystemCorrectionSource("system:compliance_block:banned_word,price"), true);
  assert.equal(isRecognizedSystemCorrectionSource("system:compliance_block:price,banned_word"), false);
  assert.equal(isRecognizedSystemCorrectionSource("system:compliance_block:unreviewed"), false);
});
