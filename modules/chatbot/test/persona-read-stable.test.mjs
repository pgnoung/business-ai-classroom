// ผลอ่านลักษณะลูกค้า (DISC / B.A.N.K.) ต้องนิ่ง
//
// วัดจากข้อมูลจริง 2026-08-28: scorer อ่านใหม่ทั้งหมดทุกรอบโดยไม่เอาผลเดิมมาต่อยอด
// ผลคือ 5 จาก 10 ห้องได้ผลอ่านเปลี่ยนไปมา เคสที่ชัดที่สุดคือห้องหนึ่งเปลี่ยนจาก C
// เป็น S ภายใน 2 นาที (คนละขั้วของ DISC) และหลายห้องอ่านได้แล้วรอบถัดไปกลับเป็น unknown
//
// นิสัยคนไม่เปลี่ยนทุกสองนาที การอ่านใหม่ทั้งหมดทุกเทิร์นจึงรับประกันว่าได้สัญญาณรบกวน
import test from "node:test";
import assert from "node:assert/strict";
import { stabilizePersonaRead, applyStablePersonaRead } from "../src/personaRead.mjs";
import { memoryDb } from "./helpers.mjs";

const read = (disc, bank, reason = "") => ({ disc, bank, reason });
const prev = (stable, raw) => ({ persona_read: stable, persona_read_raw: raw ?? stable });

test("อ่านครั้งแรก รับค่าไปเลย", () => {
  const { stable } = stabilizePersonaRead(read("C", "Knowledge"), null);
  assert.equal(stable.disc, "C");
  assert.equal(stable.bank, "Knowledge");
});

test("รอบนี้อ่านไม่ออก ต้องคงค่าเดิม ไม่ถอยกลับเป็น unknown", () => {
  // เคสจริง: ห้องที่อ่านได้ C ติดกัน 6 ครั้ง แล้วครั้งที่ 7 กลับเป็น unknown
  const { stable } = stabilizePersonaRead(read("unknown", "unknown"), prev(read("C", "Knowledge", "ชอบข้อมูล")));
  assert.equal(stable.disc, "C", "ห้ามทิ้งสิ่งที่เพิ่งรู้");
  assert.equal(stable.bank, "Knowledge");
  assert.equal(stable.reason, "ชอบข้อมูล", "เหตุผลเดิมยังอธิบายค่าที่คงไว้ได้");
});

test("อ่านได้ค่าใหม่ครั้งเดียว ยังไม่เปลี่ยน (เคส C→S ใน 2 นาที)", () => {
  const { stable } = stabilizePersonaRead(read("S", "Nurturing"), prev(read("C", "Knowledge"), read("C", "Knowledge")));
  assert.equal(stable.disc, "C", "ค่าที่ขัดกับของเดิมครั้งเดียวยังไม่พอให้เปลี่ยน");
  assert.equal(stable.bank, "Knowledge");
});

test("อ่านได้ค่าใหม่ซ้ำสองรอบติด จึงเปลี่ยน (คนเปลี่ยนจริง)", () => {
  // รอบก่อน: ค่านิ่งยังเป็น C แต่ผลดิบเริ่มอ่านได้ S แล้ว
  const { stable } = stabilizePersonaRead(read("S", "Nurturing"), prev(read("C", "Knowledge"), read("S", "Nurturing")));
  assert.equal(stable.disc, "S", "อ่านได้เหมือนเดิมสองรอบติด = หลักฐานพอ");
  assert.equal(stable.bank, "Nurturing");
});

test("DISC กับ BANK นิ่งแยกกัน", () => {
  // DISC ยืนยันเดิม แต่ BANK เปลี่ยนครั้งแรก
  const { stable } = stabilizePersonaRead(read("C", "Blueprint"), prev(read("C", "Knowledge"), read("C", "Knowledge")));
  assert.equal(stable.disc, "C");
  assert.equal(stable.bank, "Knowledge", "BANK เปลี่ยนครั้งเดียวยังไม่พอ");
});

test("เก็บค่าดิบไว้เสมอ — ใช้ประเมินทีหลังว่า B.A.N.K. เพิ่มความแม่นจริงไหม", () => {
  const out = applyStablePersonaRead(
    { score: 7, persona_read: read("S", "Nurturing") },
    prev(read("C", "Knowledge"), read("C", "Knowledge")),
  );
  assert.equal(out.persona_read.disc, "C", "ค่าที่เอาไปใช้ยังนิ่ง");
  assert.equal(out.persona_read_raw.disc, "S", "แต่ต้องไม่ทิ้งสิ่งที่โมเดลเห็นจริง");
  assert.equal(out.score, 7, "ฟิลด์อื่นต้องไม่หาย");
});

test("payload พังต้องไม่ทำให้การบันทึกคะแนนล้ม", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-broken", {});
  db.recordScore("U-broken", 5, "{ ไม่ใช่ JSON");
  assert.equal(db.getCustomer("U-broken").last_score, 5, "คะแนนต้องถูกบันทึกตามปกติ");
});

test("ผ่าน recordScore จริง: อ่านได้แล้วรอบถัดไปอ่านไม่ออก ค่ายังอยู่", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const id = "U-sticky";
  db.upsertCustomer(id, {});
  db.recordScore(id, 7, JSON.stringify({ persona_read: read("C", "Knowledge", "ขอข้อมูลก่อนตัดสินใจ") }));
  db.recordScore(id, 8, JSON.stringify({ persona_read: read("unknown", "unknown") }));

  const latest = db.raw.prepare(
    "SELECT payload_json FROM score_history WHERE customer_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(id);
  const parsed = JSON.parse(latest.payload_json);
  assert.equal(parsed.persona_read.disc, "C", "ค่าที่ผู้ใช้ปลายทางอ่าน ต้องยังเป็น C");
  assert.equal(parsed.persona_read_raw.disc, "unknown", "ค่าดิบต้องบอกความจริงว่ารอบนี้อ่านไม่ออก");
});
