// v1.4.9c (พี่ง้วงอนุมัติ 2026-08-17): ตรรกะแกน sync tag เว็บ->LINE OA
// "ห้ามผิดพลาดเด็ดขาด" — เทสต์ทุกกรณีขอบของ non-destructive merge + cap 30 + readback
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TAGS_PER_CHAT, tagGroup, isBareTag, buildManagedIndex,
  computeDesiredLineTags, tagSetHash, shouldPush, verifyReadback,
} from "../src/tagSync.mjs";
import { memoryDb } from "./helpers.mjs";

// registry จำลอง: green-label 2 ตัว (bare, sync) + chassis tag 1 ตัว (group/, ยังไม่ sync)
const REGISTRY = [
  { canonical_key: "ลงทะเบียนแล้ว", sync_to_line: 1, line_tag_id: "L-reg", line_bot_id: "U-bot", active: 1 },
  { canonical_key: "ซื้อครั้งแรก", sync_to_line: 1, line_tag_id: "L-buy1", line_bot_id: "U-bot", active: 1 },
  { canonical_key: "stage/price_sent", sync_to_line: 0, line_tag_id: null, line_bot_id: "U-bot", active: 1 },
  { canonical_key: "รอโอน", sync_to_line: 1, line_tag_id: "", line_bot_id: "U-bot", active: 1 }, // ยังไม่จับคู่ id
];
const INDEX = buildManagedIndex(REGISTRY, { lineBotId: "U-bot" });

test("namespace: bare = green-label, group/ = chassis-only", () => {
  assert.equal(tagGroup("ลงทะเบียนแล้ว"), "");
  assert.equal(tagGroup("stage/price_sent"), "stage");
  assert.equal(isBareTag("ลงทะเบียนแล้ว"), true);
  assert.equal(isBareTag("rfm/aov:high"), false);
});

test("buildManagedIndex: เฉพาะ sync_to_line=1 + มี line_tag_id + active", () => {
  assert.equal(INDEX.keyToLineId.get("ลงทะเบียนแล้ว"), "L-reg");
  assert.equal(INDEX.keyToLineId.has("stage/price_sent"), false, "chassis-only ไม่เข้า");
  assert.equal(INDEX.keyToLineId.has("รอโอน"), false, "ยังไม่จับคู่ id = sync ไม่ได้");
  assert.deepEqual([...INDEX.managedLineIds].sort(), ["L-buy1", "L-reg"]);
});

test("NON-DESTRUCTIVE: ครั้งแรก (ไม่เคย push) = add-only เก็บทุก tag เดิมครบ", () => {
  // ห้องนี้บน LINE มี: L-reg (managed), L-human-vip (คนติดเอง นอก namespace)
  const plan = computeDesiredLineTags({
    chassisTags: ["ลงทะเบียนแล้ว", "ซื้อครั้งแรก", "stage/price_sent"],
    currentLineTagIds: ["L-reg", "L-human-vip"],
    previouslyPushedIds: [], // ครั้งแรก
    index: INDEX,
  });
  assert.equal(plan.ok, true);
  // L-human-vip ต้องอยู่ครบ + เพิ่ม L-buy1 (managed ใหม่); stage/price_sent ไม่ sync
  assert.deepEqual(plan.desiredTagIds.sort(), ["L-buy1", "L-human-vip", "L-reg"]);
  assert.deepEqual(plan.added, ["L-buy1"]);
  assert.deepEqual(plan.removed, [], "ครั้งแรกห้ามลบอะไรเลย");
});

test("CRITICAL: tag managed บน LINE ที่ chassis ไม่เคย push (ทีมติดเอง) = สงวนเด็ดขาด", () => {
  // เคสรีวิว: ทีมติด "ลงทะเบียนแล้ว"(L-reg) ตรงใน LINE, chassis ไม่มี tag นี้ในตัวลูกค้า,
  // ลูกค้า dirty จากเหตุอื่น. L-reg เป็น managed แต่ chassis ไม่เคย push -> ห้ามลบ
  const plan = computeDesiredLineTags({
    chassisTags: [], // chassis ไม่มี tag
    currentLineTagIds: ["L-reg"], // แต่ LINE มี (ทีมติด)
    previouslyPushedIds: [], // chassis ไม่เคย push
    index: INDEX,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.removed, [], "tag ทีมต้องไม่โดนลบ (บั๊ก critical ที่รีวิวจับ)");
  assert.deepEqual(plan.desiredTagIds, ["L-reg"]);
  assert.equal(plan.changed, false);
});

test("ลบ managed tag ได้เฉพาะที่ chassis เคย push เอง + หายจาก chassis แล้ว", () => {
  // chassis เหลือแค่ ลงทะเบียนแล้ว; LINE มี L-reg + L-buy1 + L-human
  // L-buy1 chassis เคย push (previouslyPushed) -> ลบได้; L-human ไม่เคย push -> สงวน
  const plan = computeDesiredLineTags({
    chassisTags: ["ลงทะเบียนแล้ว"],
    currentLineTagIds: ["L-reg", "L-buy1", "L-human"],
    previouslyPushedIds: ["L-reg", "L-buy1"], // chassis เคย push 2 ตัวนี้
    index: INDEX,
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.removed, ["L-buy1"], "ลบเฉพาะ managed ที่เคย push + หายจาก chassis");
  assert.deepEqual(plan.desiredTagIds.sort(), ["L-human", "L-reg"], "L-human (ทีม) รอด");
});

test("stale id: managed tagId ที่ถูกลบใน LINE แล้ว (ไม่อยู่ใน validManagedLineIds) ไม่ push", () => {
  const plan = computeDesiredLineTags({
    chassisTags: ["ลงทะเบียนแล้ว", "ซื้อครั้งแรก"],
    currentLineTagIds: ["L-reg"],
    previouslyPushedIds: ["L-reg"],
    validManagedLineIds: new Set(["L-reg"]), // L-buy1 ถูกลบใน LINE แล้ว
    index: INDEX,
  });
  assert.ok(!plan.desiredTagIds.includes("L-buy1"), "id ที่ไม่มีใน LINE แล้วต้องไม่ push");
  assert.equal(plan.changed, false);
});

test("CAP 30: เกินแล้วห้าม push (error ให้คนดู ไม่ตัดมั่ว)", () => {
  const many = Array.from({ length: 31 }, (_, i) => `L-x${i}`);
  const plan = computeDesiredLineTags({ chassisTags: [], currentLineTagIds: many, previouslyPushedIds: [], index: INDEX });
  assert.equal(plan.ok, false);
  assert.equal(plan.error, "exceeds_tag_cap");
  assert.equal(plan.count, 31);
  assert.equal(shouldPush(plan).push, false);
  assert.equal(MAX_TAGS_PER_CHAT, 30);
});

test("IDEMPOTENT: ไม่เปลี่ยน หรือ hash ตรงกับที่เคยส่ง = ข้าม", () => {
  const plan = computeDesiredLineTags({
    chassisTags: ["ลงทะเบียนแล้ว"], currentLineTagIds: ["L-reg"], previouslyPushedIds: ["L-reg"], index: INDEX,
  });
  assert.equal(plan.changed, false);
  assert.equal(shouldPush(plan).push, false, "ไม่เปลี่ยน = ไม่ push");

  const plan2 = computeDesiredLineTags({
    chassisTags: ["ลงทะเบียนแล้ว", "ซื้อครั้งแรก"], currentLineTagIds: ["L-reg"], previouslyPushedIds: ["L-reg"], index: INDEX,
  });
  assert.equal(shouldPush(plan2).push, true);
  assert.equal(shouldPush(plan2, { lastPushedHash: plan2.hash }).push, false, "hash ตรง = เคย push แล้ว ข้าม");
});

test("hash นิ่ง ไม่ขึ้นกับลำดับ input", () => {
  assert.equal(tagSetHash(["a", "b", "c"]), tagSetHash(["c", "a", "b"]));
  assert.notEqual(tagSetHash(["a", "b"]), tagSetHash(["a", "b", "c"]));
});

test("readback: LINE ต้องคืน tagIds ตรงเป๊ะ ไม่งั้นถือว่าไม่สำเร็จ", () => {
  assert.equal(verifyReadback({ desiredTagIds: ["a", "b"], readbackTagIds: ["b", "a"] }).ok, true);
  assert.equal(verifyReadback({ desiredTagIds: ["a", "b"], readbackTagIds: ["a"] }).ok, false);
  assert.equal(verifyReadback({ desiredTagIds: ["a"], readbackTagIds: ["a", "b"] }).ok, false);
});

/* ---------------- db registry + dirty flag ---------------- */

test("db: registry CRUD + dirty flag ตอน tag เปลี่ยน", () => {
  const db = memoryDb();
  db.upsertCustomer("U-1", { displayName: "เทส" });
  db.upsertTagRegistry({ canonicalKey: "ลงทะเบียนแล้ว", syncToLine: true, lineTagId: "L-reg", lineBotId: "U-bot" });
  db.upsertTagRegistry({ canonicalKey: "stage/price_sent", tagGroup: "stage", sourceDefault: "ai" });
  const syncable = db.listTagRegistry({ lineBotId: "U-bot", syncableOnly: true });
  assert.equal(syncable.length, 1);
  assert.equal(syncable[0].canonical_key, "ลงทะเบียนแล้ว");

  // addTag ต้อง mark dirty
  db.addTag("U-1", "ลงทะเบียนแล้ว", "human");
  assert.equal(db.listTagDirtyCustomers().length, 1);
  db.clearTagsDirty("U-1");
  assert.equal(db.listTagDirtyCustomers().length, 0);
  // removeTag ก็ mark dirty
  db.removeTag("U-1", "ลงทะเบียนแล้ว");
  assert.equal(db.listTagDirtyCustomers().length, 1);

  // sync state idempotency
  db.saveTagSyncState({ customerId: "U-1", lineBotId: "U-bot", lastPushedHash: "abc" });
  assert.equal(db.getTagSyncState("U-1", "U-bot").last_pushed_hash, "abc");
  db.close();
});
