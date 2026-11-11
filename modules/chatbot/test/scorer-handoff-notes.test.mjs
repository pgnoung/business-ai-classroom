// บันทึกส่งต่อของทีมงานต้องมีผลกับการให้คะแนน
//
// คำสั่งพี่ง้วง 2026-08-26: "การ handoff จากชมพู่ ยังคงเอาไว้คำนวณ score ได้อยู่นะครับ"
//
// ทำไมสำคัญ: ทีมงานยังคุยกับลูกค้านอกระบบอยู่จริง (โทรศัพท์ / แอป LINE OA ที่ Messaging API
// มองไม่เห็น) ถ้า scorer อ่านแค่บทสนทนาในแชท ห้องที่ร้อนที่สุด — คนที่โทรคุยจนตกลงแล้ว —
// จะได้คะแนนต่ำสุด เพราะในแชทแทบไม่มีอะไร
//
// สิ่งที่ห้ามพลาดฝั่งตรงข้าม: โน้ตของเครื่อง (ai_auto = context_summary ที่ scorer เขียนเอง
// รอบก่อน, ai_promise = คำรับปากของบอท) ต้องไม่วนกลับเข้าไป ไม่งั้นได้คะแนนที่ยืนยันตัวเอง
import test from "node:test";
import assert from "node:assert/strict";
import { buildScorerSystem } from "../src/scoring.mjs";

const note = (author, text) => ({ author, text, created_at: 1_700_000_000_000 });

test("โน้ตที่คนเขียนต้องอยู่ใน prompt ของ scorer", () => {
  const system = buildScorerSystem({
    displayName: "ลูกค้า",
    handoffNotes: [note("chomphu", "โทรคุยแล้ว ลูกค้าจะโอนพรุ่งนี้เช้า")],
  });
  assert.match(system, /บันทึกจากทีมงาน/u);
  assert.match(system, /โทรคุยแล้ว ลูกค้าจะโอนพรุ่งนี้เช้า/u);
  assert.match(system, /\[chomphu\]/u);
});

test("ไม่มีโน้ต = ไม่มีหัวข้อนี้ใน prompt เลย (ไม่เปลืองโทเคนเปล่า)", () => {
  const system = buildScorerSystem({ displayName: "ลูกค้า", handoffNotes: [] });
  assert.doesNotMatch(system, /บันทึกจากทีมงาน/u);
  const noArg = buildScorerSystem({ displayName: "ลูกค้า" });
  assert.doesNotMatch(noArg, /บันทึกจากทีมงาน/u);
});

test("โน้ตของเครื่องต้องไม่วนกลับเข้า scorer", () => {
  // ai_auto = context_summary ที่ scorer เขียนเองรอบก่อน · ai_promise = คำรับปากของบอท
  // ถ้าหลุดเข้าไป คะแนนจะอ้างอิงคำพูดของตัวเองเป็นหลักฐาน
  const system = buildScorerSystem({
    displayName: "ลูกค้า",
    handoffNotes: [
      note("ai_auto", "ลูกค้าสนใจคอร์ส รอตัดสินใจ"),
      note("ai_promise", "ลูกแพรรับปากว่าจะล็อกที่นั่งให้"),
      note("LINE OA (ย้ายข้อมูล)", "สรุปตอนย้ายระบบ"),
      note("ระบบ (โยงระบบเก่าด้วยชื่อ)", "โยงห้องเก่าด้วยชื่อ"),
    ],
  });
  assert.doesNotMatch(system, /บันทึกจากทีมงาน/u, "ไม่มีโน้ตของคนเลย = ไม่ต้องมีหัวข้อ");
  assert.doesNotMatch(system, /รอตัดสินใจ/u);
  assert.doesNotMatch(system, /ล็อกที่นั่งให้/u);
});

test("คนกับเครื่องปนกัน ต้องเหลือแต่ของคน", () => {
  const system = buildScorerSystem({
    displayName: "ลูกค้า",
    handoffNotes: [
      note("ai_auto", "สรุปอัตโนมัติที่ห้ามวนกลับ"),
      note("chomphu", "ลูกค้าขอใบเสนอราคาทางโทรศัพท์"),
      note("ai_promise", "คำรับปากของบอทที่ห้ามวนกลับ"),
      note("pilot-owner", "นัดโทรกลับวันจันทร์"),
    ],
  });
  assert.match(system, /ลูกค้าขอใบเสนอราคาทางโทรศัพท์/u);
  assert.match(system, /นัดโทรกลับวันจันทร์/u);
  assert.doesNotMatch(system, /ห้ามวนกลับ/u);
});

test("โน้ตเยอะเกินไปต้องถูกตัด และข้อความยาวต้องถูกตัดความยาว", () => {
  // system prompt ที่โตไม่จำกัด = ค่าโมเดลโตตามทุกครั้งที่ให้คะแนน
  const many = Array.from({ length: 20 }, (_, i) => note("chomphu", `โน้ตที่ ${i}`));
  const system = buildScorerSystem({ displayName: "ลูกค้า", handoffNotes: many });
  const shown = (system.match(/^- \[chomphu\]/gmu) || []).length;
  assert.ok(shown <= 6, `ต้องไม่เกิน 6 ใบ (ได้ ${shown})`);
  assert.match(system, /โน้ตที่ 19/u, "ต้องเก็บใบล่าสุดไว้");
  assert.doesNotMatch(system, /โน้ตที่ 0\b/u, "ใบเก่าสุดต้องถูกตัด");

  const long = buildScorerSystem({
    displayName: "ลูกค้า",
    handoffNotes: [note("chomphu", "ก".repeat(1000))],
  });
  const line = long.split("\n").find((l) => l.startsWith("- [chomphu]"));
  assert.ok(line.length < 400, `บรรทัดต้องถูกตัดความยาว (ได้ ${line.length})`);
});

test("ต้องกำกับข้อจำกัดไว้ด้วย — ห้ามเอาชื่อจากโน้ตมาเป็นชื่อลูกค้า", () => {
  // โน้ตมักมีชื่อบุคคลที่สาม (ทีมงาน ผู้ติดต่อ คนที่ถูกส่งมาเรียน) ถ้าไม่กำกับไว้
  // scorer จะหยิบไปใส่ known_name แล้วระบบจะเรียกลูกค้าผิดชื่อในแชทจริง
  const system = buildScorerSystem({
    displayName: "ลูกค้า",
    handoffNotes: [note("chomphu", "คุณเอกจากฝ่ายบุคคลโทรมาถามแทน")],
  });
  assert.match(system, /known_name ต้องมาจากสิ่งที่ลูกค้าพิมพ์เองในแชทเท่านั้น/u);
  assert.match(system, /ห้ามใช้บันทึกเป็นเหตุผลของ out_of_band_reply/u);
});

test("โน้ตข้อความว่างต้องถูกข้าม", () => {
  const system = buildScorerSystem({
    displayName: "ลูกค้า",
    handoffNotes: [note("chomphu", "   "), note("chomphu", ""), note("chomphu", "ของจริง")],
  });
  assert.match(system, /ของจริง/u);
  assert.equal((system.match(/^- \[chomphu\]/gmu) || []).length, 1);
});
