// customer-resolver — หา "ห้องลูกค้า" จากชื่อที่พี่ง้วงพิมพ์: ความกำกวม คำนำหน้า ตัวกรองช่องทาง
// และการหาขอบ "ชื่อ + สิ่งที่ให้ทำ" ที่พิมพ์ติดกัน — ส่งผิดคนคือความเสียหายที่แพงที่สุด
import test from "node:test";
import assert from "node:assert/strict";
import { matchTier, nameVariants, resolveCustomer, resolveLeadingName, similarity } from "../src/customerResolver.mjs";
import { LEGACY_REFERENCE_TAG } from "../src/dbYolo.mjs";
import { LEGACY_SOURCE_TAG } from "../src/legacyLink.mjs";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

const T0 = Date.UTC(2026, 8, 28, 3, 0, 0);

function world(t) {
  const clock = { now: T0 };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  let n = 0;
  const room = (id, { display = "", known = "", channel = "default", at = T0, inbound = true, text = "สวัสดีค่ะ" } = {}) => {
    db.upsertCustomer(id, { displayName: display, channelId: channel });
    if (known) db.setKnownName(id, known);
    if (inbound) {
      const mid = `m-${n += 1}`;
      db.insertMessage({ id: mid, customerId: id, direction: "in", content: text });
      db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, mid);
    }
    return id;
  };
  return { db, room, clock };
}

test("ป้ายห้องเก่าของ dbYolo ต้องตรงกับ legacyLink ทุกตัวอักษร", () => {
  assert.equal(LEGACY_REFERENCE_TAG, LEGACY_SOURCE_TAG);
});

test("ชื่อตรงเป๊ะคนเดียว = unique · ใช้ได้ทั้ง known_name และ display_name + คำนำหน้า 'คุณ'", (t) => {
  const { db, room } = world(t);
  room("U-somchai", { display: "Somchai K.", known: "สมชาย" });
  room("U-other", { display: "วิไล" });
  for (const query of ["สมชาย", "คุณสมชาย", "คุณ สมชาย", "somchai k", "Somchai"]) {
    const result = resolveCustomer(db, { query });
    assert.equal(result.status, "unique", query);
    assert.equal(result.matches[0].id, "U-somchai", query);
  }
});

test("หลายห้องชื่อเดียวกัน = ambiguous เรียงห้องที่เพิ่งคุยก่อน และบอกจำนวนทั้งหมด", (t) => {
  const { db, room } = world(t);
  room("U-a1", { display: "เอ", at: T0 - 3_600_000 });
  room("U-a2", { display: "เอ", at: T0 - 60_000, text: "ขอรายละเอียดคลาสค่ะ" });
  room("U-a3", { known: "เอ", display: "A Shop", at: T0 - 86_400_000 });
  const result = resolveCustomer(db, { query: "คุณเอ" });
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.matches.map((m) => m.id), ["U-a2", "U-a1", "U-a3"]);
  assert.equal(result.total, 3);
  assert.equal(result.matches[0].lastMessage, "ขอรายละเอียดคลาสค่ะ");
});

test("ชื่อตรงคนเดียว แต่มีชื่อคล้าย = unique + hasSimilar (ให้ผู้เรียกถามก่อนส่ง)", (t) => {
  const { db, room } = world(t);
  room("U-ae", { display: "เอ" });
  room("U-aek", { display: "เอก" });
  const result = resolveCustomer(db, { query: "เอ" });
  assert.equal(result.status, "unique");
  assert.equal(result.matches[0].id, "U-ae");
  assert.equal(result.hasSimilar, true);
  assert.deepEqual(result.similar.map((m) => m.id), ["U-aek"]);
  const partial = resolveCustomer(db, { query: "เอก" });
  assert.equal(partial.hasSimilar, false, "ชื่อยาวกว่า = ไม่มีคนคล้าย");
});

test("ขึ้นต้น/มีอยู่ในชื่อ: คนเดียว = unique, หลายคน = ambiguous · สั้นไป = invalid", (t) => {
  const { db, room } = world(t);
  room("U-pim", { display: "พิมพ์ลดา" });
  room("U-noi", { display: "น้อยหน่า" });
  room("U-noi2", { display: "น้อย ร้านกาแฟ" });
  assert.equal(resolveCustomer(db, { query: "พิมพ์" }).matches[0].id, "U-pim");
  const middle = resolveCustomer(db, { query: "ลดา" });
  assert.equal(middle.matches[0].id, "U-pim", "มีอยู่กลางชื่อก็หาเจอ");
  assert.equal(middle.loose, true, "เดาจากชื่อบางส่วน = ติดธง loose ให้ผู้เรียกถามก่อนทำคำสั่งที่เปลี่ยนสถานะ");
  assert.equal(resolveCustomer(db, { query: "พิมพ์ลดา" }).loose, false, "ชื่อตรงเป๊ะ = ไม่ใช่การเดา");
  const noi = resolveCustomer(db, { query: "น้อ" });
  assert.equal(noi.status, "ambiguous");
  assert.equal(resolveCustomer(db, { query: "ก" }).status, "invalid");
});

test("ขอบชื่อกำกวม: คำที่สั้นกว่าเป็นชื่อเต็มของอีกห้อง = ambiguous (split) พร้อมคำสั่งของแต่ละตัวเลือก", (t) => {
  const { db, room } = world(t);
  room("U-a", { display: "สมชาย" });
  room("U-b", { display: "สมชาย ใจดี" });
  // พี่ง้วงหมายถึงคุณสมชาย + "ใจดีมาก…" ก็ได้ หรือคุณสมชาย ใจดี + "มาก…" ก็ได้ — ห้ามเดาเอง
  const r = resolveLeadingName(db, { text: "สมชาย ใจดีมาก ขอบคุณที่ทัก" });
  assert.equal(r.status, "ambiguous");
  assert.equal(r.split, true);
  assert.deepEqual(r.matches.map((m) => [m.id, m.instruction]), [["U-b", "มาก ขอบคุณที่ทัก"], ["U-a", "ใจดีมาก ขอบคุณที่ทัก"]]);
  assert.equal(r.total, 2);

  // ห้องอื่นที่ตรงแค่ "คำแรก" ไม่นับ — ไม่งั้นทุกคำสั่งถึงคุณสมชาย ใจดี จะต้องถามถึงคุณสมชาย รักดีด้วย
  const other = world(t);
  other.room("U-b", { display: "สมชาย ใจดี" });
  other.room("U-c", { display: "สมชาย รักดี" });
  const plain = resolveLeadingName(other.db, { text: "สมชาย ใจดี ถามต่อ" });
  assert.equal(plain.status, "unique");
  assert.equal(plain.matches[0].id, "U-b");
  assert.equal(plain.instruction, "ถามต่อ");
});

test("ตัวกรองช่องทาง: LINE ไม่เห็นห้อง Facebook และกลับกัน", (t) => {
  const { db, room } = world(t);
  room("U-line-bee", { display: "บี" });
  room("facebook:1001", { display: "บี", channel: "facebook" });
  assert.equal(resolveCustomer(db, { query: "บี" }).status, "ambiguous");
  assert.equal(resolveCustomer(db, { query: "บี", channel: "LINE" }).matches[0].id, "U-line-bee");
  assert.equal(resolveCustomer(db, { query: "บี", channel: "FB" }).matches[0].id, "facebook:1001");
  assert.equal(resolveCustomer(db, { query: "บี", channel: "FB" }).matches[0].channelId, "facebook");
});

test("ห้องที่สั่งไม่ได้ถูกคัดออก: ห้องอ้างอิงระบบเก่า, canary, ห้องที่ลูกค้าไม่เคยทัก", (t) => {
  const { db, room } = world(t);
  room("U-legacy", { display: "ต้น" });
  db.addTag("U-legacy", LEGACY_REFERENCE_TAG, "human");
  room("canary:probe", { display: "ต้น" });
  room("U-silent", { display: "ต้น", inbound: false });
  room("U-real", { display: "ต้นกล้า" });
  const result = resolveCustomer(db, { query: "ต้น" });
  assert.equal(result.status, "unique");
  assert.equal(result.matches[0].id, "U-real");
});

test("ไม่เจอ = none พร้อมชื่อใกล้เคียง (พิมพ์ผิดหนึ่งสองตัว)", (t) => {
  const { db, room } = world(t);
  room("U-somchai", { display: "สมชาย" });
  room("U-far", { display: "วิไลวรรณ" });
  const result = resolveCustomer(db, { query: "สมชัย" });
  assert.equal(result.status, "none");
  assert.deepEqual(result.suggestions.map((s) => s.id), ["U-somchai"]);
  assert.ok(similarity("สมชัย", "สมชาย") > similarity("สมชัย", "วิไลวรรณ"));
});

test("ชื่อ + สิ่งที่ให้ทำ: เว้นวรรค / พิมพ์ติดกัน / ชื่อสองคำ / วงเล็บ / โคลอน", (t) => {
  const { db, room } = world(t);
  room("U-test", { display: "คุณทดสอบ" });
  room("U-somchai", { display: "สมชาย ใจดี" });
  room("U-ae", { display: "เอ" });
  room("U-pumpui", { display: "ปุ้มปุ้ย" });

  let r = resolveLeadingName(db, { text: "คุณทดสอบ ถามต่อเรื่องจำนวนพนักงาน" });
  assert.equal(r.matches[0].id, "U-test");
  assert.equal(r.instruction, "ถามต่อเรื่องจำนวนพนักงาน");

  r = resolveLeadingName(db, { text: "คุณเอถามต่อเรื่องราคา" });
  assert.equal(r.matches[0].id, "U-ae", "ICU แบ่งคำไทย: คุณ|เอ|ถาม|ต่อ");
  assert.equal(r.instruction, "ถามต่อเรื่องราคา");

  r = resolveLeadingName(db, { text: "สมชาย ใจดี ส่งรีวิวให้หน่อย" });
  assert.equal(r.matches[0].id, "U-somchai");
  assert.equal(r.instruction, "ส่งรีวิวให้หน่อย");

  r = resolveLeadingName(db, { text: "สมชาย ถามต่อ" });
  assert.equal(r.matches[0].id, "U-somchai", "ชื่อต้นอย่างเดียวก็พอ");
  assert.equal(r.instruction, "ถามต่อ");

  r = resolveLeadingName(db, { text: "ปุ้มปุ้ยทักหน่อย" });
  assert.equal(r.matches[0].id, "U-pumpui", "ชื่อที่ไม่อยู่ในพจนานุกรม (ICU ตัดเป็นสองคำ) ยังต่อกันเจอ");
  assert.equal(r.instruction, "ทักหน่อย");

  r = resolveLeadingName(db, { text: "(คุณสมชาย ใจดี) ตอบเรื่อง in-house ต่อ" });
  assert.equal(r.matches[0].id, "U-somchai");
  assert.equal(r.instruction, "ตอบเรื่อง in-house ต่อ");

  r = resolveLeadingName(db, { text: "เอ: นัดโทรคุยพรุ่งนี้" });
  assert.equal(r.matches[0].id, "U-ae");
  assert.equal(r.instruction, "นัดโทรคุยพรุ่งนี้");
});

test("คำไทยที่ขึ้นต้นเหมือนชื่อ ('เอกสาร' ≠ ลูกค้า 'เอ') และเวลา 10:00 ไม่ถูกตัดเป็นชื่อ", (t) => {
  const { db, room } = world(t);
  room("U-ae", { display: "เอ" });
  room("U-somchai", { display: "สมชาย" });
  const doc = resolveLeadingName(db, { text: "เอกสารส่งให้หน่อย" });
  assert.notEqual(doc.status, "unique", "ห้ามอ่าน 'เอกสาร' เป็นลูกค้าชื่อเอ");
  const time = resolveLeadingName(db, { text: "สมชาย ยืนยันนัด 10:00 ได้ไหม" });
  assert.equal(time.matches[0].id, "U-somchai");
  assert.equal(time.instruction, "ยืนยันนัด 10:00 ได้ไหม");
});

test("nameVariants/matchTier: ชื่อเต็ม + คำแรก และเทียบแบบไม่สนช่องว่าง", () => {
  assert.deepEqual(nameVariants({ display_name: "คุณสมชาย ใจดี", known_name: "" }), ["สมชาย ใจดี", "สมชาย"]);
  assert.equal(matchTier("สมชายใจดี", ["สมชาย ใจดี"]), 1);
  assert.equal(matchTier("สม", ["สมชาย"]), 2);
  assert.equal(matchTier("ชาย", ["สมชาย"]), 3);
  assert.equal(matchTier("วิไล", ["สมชาย"]), 0);
});
