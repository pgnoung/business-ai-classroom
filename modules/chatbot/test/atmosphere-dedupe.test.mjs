// v1.4.9 (2026-08-17): รูปบรรยากาศต้องกันซ้ำข้ามเส้น reactive/staged FU และข้าม session
// (พี่ง้วง: "ส่ง atmosphere ได้แม้ warm/hot แต่ไม่ให้ซ้อนกัน")
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { suggestImageKey, ATMOSPHERE_IMAGES } from "../src/imageSuggestion.mjs";

test("ATMOSPHERE_IMAGES = single source (2 ใบ) export จาก imageSuggestion", () => {
  assert.deepEqual([...ATMOSPHERE_IMAGES], ["classroom-atmosphere-1", "classroom-atmosphere-2"]);
});

// จำลองการส่งรูป: เขียนแถว message รูปใน 'session ที่กำหนด'
function sendImageAt(db, customerId, key, { sessionId }) {
  const id = `img-${Math.random().toString(36).slice(2)}`;
  db.insertMessage({ id, customerId, direction: "out", msgType: "image", content: `[image:${key}] https://x/${key}.png`, sessionId });
  return id;
}

test("reactive dedup atmosphere แบบ all-time ข้าม session (RED กับโค้ดเก่า)", () => {
  const db = memoryDb();
  const cid = "U-atmos";
  db.upsertCustomer(cid, { displayName: "เทส" });
  // staged FU ส่ง atmosphere-1 ใน session S1
  const s1 = db.ensureActiveConversationSession(cid).id;
  sendImageAt(db, cid, "classroom-atmosphere-1", { sessionId: s1 });
  // rotate ไป session ใหม่ (จำลอง /reset)
  db.rotateTrainingSession({ customerId: cid, resetEventId: "reset-1" });
  const s2 = db.ensureActiveConversationSession(cid).id;
  assert.notEqual(s1, s2, "ต้อง rotate session จริง");

  // reactive อ่าน session-scoped (S2) = ว่างเปล่า -> เดิมจะเสนอ atmosphere-1 ซ้ำ
  const sessionScoped = db.recentImageKeys(cid, Date.now() - 7 * 86400000, s2);
  assert.deepEqual(sessionScoped, [], "session S2 ยังไม่มีรูป (จุดที่บั๊กเก่าเกิด)");
  // all-time atmosphere = เห็น atmosphere-1 ที่ส่งใน S1
  const allTimeAtmosphere = db.recentImageKeys(cid, 0).filter((k) => ATMOSPHERE_IMAGES.includes(k));
  assert.deepEqual(allTimeAtmosphere, ["classroom-atmosphere-1"]);

  const allowed = new Set(ATMOSPHERE_IMAGES);
  // โค้ดใหม่: union all-time -> เสนอ atmosphere-2 (ไม่ซ้ำ)
  const withUnion = suggestImageKey("บรรยากาศห้องเรียนเป็นยังไงคะ", null, allowed, {
    sentKeys: [...sessionScoped, ...allTimeAtmosphere],
  });
  assert.equal(withUnion, "classroom-atmosphere-2", "ต้องสลับไปใบที่ยังไม่ส่ง");
  // โค้ดเก่า (session-scoped อย่างเดียว) จะเสนอ -1 ซ้ำ = พิสูจน์ว่า fix จำเป็น
  const oldBehavior = suggestImageKey("บรรยากาศห้องเรียนเป็นยังไงคะ", null, allowed, { sentKeys: sessionScoped });
  assert.equal(oldBehavior, "classroom-atmosphere-1", "ยืนยัน: ถ้าไม่ union จะส่งซ้ำ");
  db.close();
});

test("atmosphere ถามได้ทุก stage (ไม่มี stage gate) — คง reactive-any-stage", () => {
  const allowed = new Set(ATMOSPHERE_IMAGES);
  // suggestImageKey ไม่รับ stage เลย — ถามบรรยากาศได้เสมอ
  assert.equal(suggestImageKey("บรรยากาศห้องเรียน", null, allowed, {}), "classroom-atmosphere-1");
});
