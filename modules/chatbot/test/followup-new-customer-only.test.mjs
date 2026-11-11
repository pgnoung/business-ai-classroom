// FU cold/warm/hot เปิดเฉพาะ "ห้องที่เกิดใหม่" — ฐานลูกค้าเดิมต้องเงียบต่อไป
//
// โจทย์จากพี่ง้วง (2026-08-26) ก่อนเปิดใช้จริง: "ถ้ามีแชทเข้ามาใหม่ (ยกเว้น customer)
// ค่อย follow up ปกติ จะได้ไม่แชทระเบิด" — ระบบมีลูกค้า 5,537 คนอยู่แล้ว ถ้า FU
// เปิดย้อนหลังทั้งฐานพร้อมกันคือหายนะ ทั้งชื่อเสียงและโควตาข้อความ
//
// เทสต์ชุดนี้ล็อกสามอย่างไว้:
//   1. ลูกค้าใหม่ = เปิด FU
//   2. ลูกค้าเดิมที่ทักซ้ำ = ห้ามถูกเปิดย้อนหลัง (ON CONFLICT ต้องไม่แตะคอลัมน์นี้)
//   3. ห้องที่คนดูแลเอง (AI ปิด / ป้าย customer) = ไม่เข้าเกณฑ์ FU ถึงคอลัมน์จะเป็น 1
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";

const HOUR = 3_600_000;

function fixture(t) {
  let clock = 1_700_000_000_000;
  const db = openDb({ file: ":memory:", now: () => clock });
  t.after(() => db.close?.());
  return { db, at: (ms) => { clock = ms; }, now: () => clock };
}

test("ลูกค้าที่ทักครั้งแรก = เปิด FU ให้เลย", (t) => {
  const f = fixture(t);
  f.db.upsertCustomer("U-new", { displayName: "ลูกค้าใหม่" });
  assert.equal(f.db.getCustomer("U-new").followup_enabled, 1);
});

test("ลูกค้าเดิมที่ปิด FU ไว้ ทักซ้ำแล้วต้องไม่ถูกเปิดย้อนหลัง", (t) => {
  // นี่คือด่านที่กัน "แชทระเบิด" จริง ๆ: ฐานเดิม 5,537 ห้องเป็น 0 ทั้งหมด
  // ถ้า ON CONFLICT เผลอเขียนคอลัมน์นี้ ทุกห้องจะถูกเปิดทันทีที่ลูกค้าทักมา
  const f = fixture(t);
  f.db.upsertCustomer("U-old", { displayName: "ลูกค้าเก่า" });
  f.db.setFollowupEnabled("U-old", false);
  assert.equal(f.db.getCustomer("U-old").followup_enabled, 0);

  f.at(1_700_000_000_000 + HOUR);
  f.db.upsertCustomer("U-old", { displayName: "ลูกค้าเก่า (ชื่อใหม่)" });
  assert.equal(f.db.getCustomer("U-old").followup_enabled, 0, "ห้ามเปิดย้อนหลัง");
  assert.equal(f.db.getCustomer("U-old").display_name, "ลูกค้าเก่า (ชื่อใหม่)", "ชื่อยังอัปเดตได้");
});

test("ห้องที่คนดูแลเอง ไม่เข้าเกณฑ์ FU ถึงคอลัมน์จะเปิดอยู่", (t) => {
  const f = fixture(t);
  const base = 1_700_000_000_000;
  const eligible = () => f.db
    .listStagedFollowupCandidates({ nowMs: f.now(), activeWithinMs: 7 * 24 * HOUR })
    .map((row) => row.line_user_id);

  for (const id of ["U-ai", "U-tagged", "U-aioff", "U-dnd"]) {
    f.db.upsertCustomer(id, {});
    f.db.insertMessage({ customerId: id, direction: "in", content: "สวัสดีค่ะ" });
  }
  // ป้าย customer = ทีมงานดูแลเอง บอทเงียบถาวร (pipeline.mjs) — สวิตช์ AI ถูกปิดตาม
  f.db.addTag("U-tagged", "customer");
  f.db.setAiEnabled("U-tagged", false, { reason: "customer_handover" });
  f.db.setAiEnabled("U-aioff", false, { reason: "manual" });
  f.db.setDoNotDisturb?.("U-dnd", true);

  const ids = eligible();
  assert.ok(ids.includes("U-ai"), "ห้องที่ AI ยังทำงานต้องเข้าเกณฑ์");
  assert.ok(!ids.includes("U-tagged"), "ห้องติดป้าย customer ต้องถูกคัดออก");
  assert.ok(!ids.includes("U-aioff"), "ห้องที่ปิด AI ต้องถูกคัดออก");
});

test("ห้องที่ยังไม่เคยมีข้อความเข้า ไม่เข้าเกณฑ์ FU", (t) => {
  const f = fixture(t);
  f.db.upsertCustomer("U-silent", {});
  const ids = f.db
    .listStagedFollowupCandidates({ nowMs: f.now(), activeWithinMs: 7 * 24 * HOUR })
    .map((row) => row.line_user_id);
  assert.ok(!ids.includes("U-silent"));
});

test("ฐานลูกค้าเดิมทั้งชุดต้องไม่เข้าเกณฑ์ แม้จะทักเข้ามาใหม่", (t) => {
  // จำลองสถานการณ์วันเปิดใช้จริง: ฐานเดิมปิด FU ไว้ทั้งหมด แล้ววันนั้นมีคนทักมา 50 คน
  // ต้องไม่มีใครในฐานเดิมเข้าเกณฑ์เลยสักคน มีแต่ห้องใหม่ 3 ห้องที่เพิ่งเกิด
  const f = fixture(t);
  const base = 1_700_000_000_000;
  for (let i = 0; i < 50; i += 1) {
    const id = `U-legacy-${i}`;
    f.db.upsertCustomer(id, {});
    f.db.setFollowupEnabled(id, false);
  }
  f.at(base + HOUR);
  for (let i = 0; i < 50; i += 1) {
    f.db.upsertCustomer(`U-legacy-${i}`, {});
    f.db.insertMessage({ customerId: `U-legacy-${i}`, direction: "in", content: "ทักมาใหม่" });
  }
  for (const id of ["U-fresh-1", "U-fresh-2", "U-fresh-3"]) {
    f.db.upsertCustomer(id, {});
    f.db.insertMessage({ customerId: id, direction: "in", content: "สนใจคอร์สค่ะ" });
  }

  const ids = f.db
    .listStagedFollowupCandidates({ nowMs: f.now(), activeWithinMs: 7 * 24 * HOUR })
    .map((row) => row.line_user_id)
    .sort();
  assert.deepEqual(ids, ["U-fresh-1", "U-fresh-2", "U-fresh-3"],
    "ต้องมีแต่ห้องที่เกิดใหม่เท่านั้น ฐานเดิม 50 ห้องห้ามหลุดเข้ามาแม้แต่ห้องเดียว");
});

/* --------- ห้องเก่ากลับเข้า FU เมื่อ "คุยกันจริง" จนมี score --------- */
// คำสั่งพี่ง้วง 2026-08-26: "ถ้าเค้าทักมา FU ยังไม่ทำงาน แต่ถ้าคุยไปแล้ว มี score
// cold warm hot, FU ต้องทำงานปกติ" — จุดยึดคือ score ไม่ใช่แค่ข้อความเข้า

test("ลูกค้าเก่าทักมาเฉย ๆ ยังไม่เข้า FU — ต้องมี score ก่อน", (t) => {
  const f = fixture(t);
  f.db.upsertCustomer("U-back", {});
  f.db.setFollowupEnabled("U-back", false);
  f.db.insertMessage({ customerId: "U-back", direction: "in", content: "สวัสดีค่ะ" });
  assert.equal(f.db.getCustomer("U-back").followup_enabled, 0, "ทักเฉย ๆ ยังไม่พอ");
});

test("พอได้ score (คุยกันจริง) FU เปิดให้เอง", (t) => {
  const f = fixture(t);
  f.db.upsertCustomer("U-talk", {});
  // ห้องฐานเดิม: ปิดไว้แบบ "ยังไม่มีใครตัดสินใจ" ไม่ใช่คนสั่งปิด
  f.db.raw.prepare("UPDATE customers SET followup_enabled=0 WHERE line_user_id=?").run("U-talk");
  f.db.insertMessage({ customerId: "U-talk", direction: "in", content: "สนใจคอร์สค่ะ ราคาเท่าไร" });

  f.db.recordScore("U-talk", 6, "{}");
  const row = f.db.getCustomer("U-talk");
  assert.equal(row.followup_enabled, 1, "มี score = คุยกันจริง = FU ทำงาน");
  assert.equal(row.last_score, 6);
});

test("score ทุกระดับ cold/warm/hot เปิด FU ได้เหมือนกัน", (t) => {
  const f = fixture(t);
  for (const [id, score] of [["U-cold", 2], ["U-warm", 6], ["U-hot", 9]]) {
    f.db.upsertCustomer(id, {});
    f.db.raw.prepare("UPDATE customers SET followup_enabled=0 WHERE line_user_id=?").run(id);
    f.db.recordScore(id, score, "{}");
    assert.equal(f.db.getCustomer(id).followup_enabled, 1, `score ${score} ต้องเปิด FU`);
  }
});

test("ห้องที่คนกดปิดเอง ต้องไม่ถูกเปิดคืนแม้จะได้ score ใหม่", (t) => {
  // ด่านนี้สำคัญ: ถ้าพัง ระบบจะลบล้างการตัดสินใจของชมพู่เงียบ ๆ ทุกครั้งที่ลูกค้าคุยด้วย
  const f = fixture(t);
  f.db.upsertCustomer("U-optout", {});
  f.db.setFollowupEnabled("U-optout", false);
  assert.equal(f.db.getCustomer("U-optout").followup_choice_by_human, 1, "ต้องปักธงว่าคนตัดสินใจ");

  f.db.recordScore("U-optout", 9, "{}");
  assert.equal(f.db.getCustomer("U-optout").followup_enabled, 0, "ห้ามเปิดคืน");
  f.db.recordScore("U-optout", 10, "{}");
  assert.equal(f.db.getCustomer("U-optout").followup_enabled, 0, "ซ้ำอีกกี่ครั้งก็ห้ามเปิด");
});

test("ห้องที่เปิด FU อยู่แล้ว ได้ score ใหม่ก็ยังเปิดอยู่ ไม่มีอะไรเปลี่ยน", (t) => {
  const f = fixture(t);
  f.db.upsertCustomer("U-on", {});
  assert.equal(f.db.getCustomer("U-on").followup_enabled, 1);
  f.db.recordScore("U-on", 7, "{}");
  assert.equal(f.db.getCustomer("U-on").followup_enabled, 1);
  assert.equal(f.db.getCustomer("U-on").followup_choice_by_human, 0, "ระบบเปิดเอง ไม่ใช่คน");
});

test("ห้องติดป้าย customer ได้ score แล้ว FU ก็ยังไม่ยิง (AI ปิดอยู่)", (t) => {
  const f = fixture(t);
  f.db.upsertCustomer("U-cust", {});
  f.db.addTag("U-cust", "customer");
  f.db.setAiEnabled("U-cust", false, { reason: "customer_handover" });
  f.db.insertMessage({ customerId: "U-cust", direction: "in", content: "ถามเรื่องรอบเรียนค่ะ" });
  f.db.recordScore("U-cust", 8, "{}");

  assert.equal(f.db.getCustomer("U-cust").followup_enabled, 1, "คอลัมน์เปิดได้");
  const ids = f.db
    .listStagedFollowupCandidates({ nowMs: f.now(), activeWithinMs: 7 * 24 * HOUR })
    .map((row) => row.line_user_id);
  assert.ok(!ids.includes("U-cust"), "แต่ต้องไม่เข้าเกณฑ์ เพราะคนดูแลเอง");
});
