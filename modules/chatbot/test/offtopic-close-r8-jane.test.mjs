// offtopic-close-r8-jane.test.mjs — เจน 12 ต.ค. ค่ำ: ผู้ซื้อพาคนมาเรียน/ถามความคุ้มของคลาส ไม่ใช่ชวนเราทำธุรกิจ (ข้อความสังเคราะห์)
import test from "node:test";
import assert from "node:assert/strict";
import { detectOfftopicCue } from "../src/offtopicCues.mjs";

test("business_pitch: ชวนคนมาเรียน / ลงทุนเรียนคุ้มไหม = ไม่มี cue · ชวนเราทำธุรกิจยังเป็น cue", () => {
  for (const text of ["อยากชวนน้องมาเรียนด้วยกัน", "ผมยอมลงทุนครับ จะชวนพี่ชายมาเรียนด้วย", "สนใจลงทุนค่ะ คุ้มไหมคะ", "คุ้มค่าไหมครับ ลงทุนเรียน"]) {
    assert.equal(detectOfftopicCue(text), "", text);
  }
  for (const text of ["สนใจมาทำธุรกิจกับผมไหมครับ ลงทุนน้อย ปันผลทุกเดือน มีดาวน์ไลน์ช่วยสร้าง", "สนใจมาทำธุรกิจกับผมไหมครับ คุ้มค่าแน่นอน"]) {
    assert.equal(detectOfftopicCue(text), "business_pitch", text);
  }
});
