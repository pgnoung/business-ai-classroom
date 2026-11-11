// burst buffer + control gate
import test from "node:test";
import assert from "node:assert/strict";
import { createBurstBuffer, looksUnfinished, suggestDebounceMs } from "../src/burstBuffer.mjs";
import { createControlGate } from "../src/controlGate.mjs";
import { poisonGlobalFetch, memoryDb, sleep } from "./helpers.mjs";

poisonGlobalFetch();

/* ------------------------------- burst buffer ------------------------------ */

test("burst: ข้อความก่อนหน้า absorb เข้า burst, ตัวสุดท้ายเป็น leader รวมข้อความ", async () => {
  const buffer = createBurstBuffer({ debounceMs: 60, maxWaitMs: 2000 });
  const p1 = buffer.push({ key: "U1", text: "สวัสดีครับ" });
  const p2 = buffer.push({ key: "U1", text: "อยากถามเรื่องคอร์สหน่อยครับ" });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.role, "absorbed");
  assert.equal(r2.role, "leader");
  assert.equal(r2.combinedText, "สวัสดีครับ\nอยากถามเรื่องคอร์สหน่อยครับ");
  assert.deepEqual(r2.parts, ["สวัสดีครับ", "อยากถามเรื่องคอร์สหน่อยครับ"]);
});

test("burst: คนละ key ไม่ปนกัน", async () => {
  const buffer = createBurstBuffer({ debounceMs: 40, maxWaitMs: 2000 });
  const [a, b] = await Promise.all([
    buffer.push({ key: "U1", text: "ข้อความ A" }),
    buffer.push({ key: "U2", text: "ข้อความ B" }),
  ]);
  assert.equal(a.role, "leader");
  assert.equal(b.role, "leader");
  assert.equal(a.combinedText, "ข้อความ A");
  assert.equal(b.combinedText, "ข้อความ B");
});

test("burst: debounceMs=0 = ปิด buffer ทุกข้อความเป็น leader ทันที", async () => {
  const buffer = createBurstBuffer({ debounceMs: 0 });
  const result = await buffer.push({ key: "U1", text: "ทดสอบ" });
  assert.equal(result.role, "leader");
});

test("burst: maxWait ตัด burst ไม่ให้ยืดเกินเพดาน", async () => {
  const buffer = createBurstBuffer({ debounceMs: 5000, maxWaitMs: 120 });
  const start = Date.now();
  const result = await buffer.push({ key: "U1", text: "รอนานไม่ได้นะ" });
  const elapsed = Date.now() - start;
  assert.equal(result.role, "leader");
  assert.ok(elapsed < 1500, `ควร flush ที่ ~120ms ไม่ใช่ ${elapsed}ms`);
});

test("burst: ท้ายข้อความเป็นคำเชื่อม = รอนานขึ้น x2", async () => {
  const buffer = createBurstBuffer({ debounceMs: 60, maxWaitMs: 5000 });
  const start = Date.now();
  await buffer.push({ key: "U1", text: "เดี๋ยวขอจองพรุ่งนี้และ" });
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 100, `ต้องรอ ~120ms (x2) แต่รอแค่ ${elapsed}ms`);
});

test("looksUnfinished: สัญญาณคำเชื่อมไทย + เศษประโยคสั้น", () => {
  assert.equal(looksUnfinished("อยากได้อันนี้และ"), true);
  assert.equal(looksUnfinished("คือ"), true);
  assert.equal(looksUnfinished("พี่คะ"), true); // สั้น ไม่ใช่คำถาม
  assert.equal(looksUnfinished("สนใจคอร์สนี้,"), true);
  assert.equal(looksUnfinished("แล้วก็"), true);
  assert.equal(looksUnfinished("ราคาเท่าไหร่คะ"), false); // คำถามจบแล้ว
  assert.equal(looksUnfinished("กี่โมง"), false); // สั้นแต่เป็นคำถาม
  assert.equal(looksUnfinished("ขอบคุณมากครับผม"), false);
});

test("suggestDebounceMs: x2 เมื่อยังไม่จบ, เพดาน 10 วินาที", () => {
  assert.equal(suggestDebounceMs({ text: "ราคาเท่าไหร่", baseMs: 4000 }), 4000);
  assert.equal(suggestDebounceMs({ text: "อยากถามเรื่องและ", baseMs: 4000 }), 8000);
  assert.equal(suggestDebounceMs({ text: "อยากถามเรื่องและ", baseMs: 6000 }), 10000); // cap
  assert.equal(suggestDebounceMs({ text: "อะไรก็ได้", baseMs: 0 }), 0);
});

/* ------------------------------- control gate ------------------------------ */

test("controlGate: เปิดอยู่ = คิดได้ + ส่งได้", () => {
  const db = memoryDb();
  db.upsertCustomer("U1", {});
  const gate = createControlGate({ isAiEnabled: (id) => db.getCustomer(id)?.ai_enabled === 1 });
  const token = gate.open("U1");
  assert.equal(token.allowedToThink, true);
  assert.equal(token.confirmBeforeSend(), true);
  db.close();
});

test("controlGate: ปิดอยู่ตั้งแต่แรก = ไม่คิดเลย", () => {
  const db = memoryDb();
  db.upsertCustomer("U1", {});
  db.setAiEnabled("U1", false);
  const gate = createControlGate({ isAiEnabled: (id) => db.getCustomer(id)?.ai_enabled === 1 });
  const token = gate.open("U1");
  assert.equal(token.allowedToThink, false);
  assert.equal(token.confirmBeforeSend(), false);
  db.close();
});

test("controlGate: double-read race — ปิดระหว่างรอ = ห้ามส่ง", () => {
  const db = memoryDb();
  db.upsertCustomer("U1", {});
  const gate = createControlGate({ isAiEnabled: (id) => db.getCustomer(id)?.ai_enabled === 1 });
  const token = gate.open("U1");
  assert.equal(token.allowedToThink, true); // อ่านครั้ง 1 ผ่าน
  db.setAiEnabled("U1", false); // แอดมิน takeover ระหว่างบอทคิด
  assert.equal(token.confirmBeforeSend(), false); // อ่านครั้ง 2 ต้องจับได้
  db.close();
});

test("controlGate: FALSE sticky — เปิดกลับระหว่างรอบเดิมก็ยังห้ามส่ง", () => {
  const db = memoryDb();
  db.upsertCustomer("U1", {});
  const gate = createControlGate({ isAiEnabled: (id) => db.getCustomer(id)?.ai_enabled === 1 });
  const token = gate.open("U1");
  db.setAiEnabled("U1", false);
  assert.equal(token.confirmBeforeSend(), false);
  db.setAiEnabled("U1", true); // เปิดกลับแล้ว แต่รอบนี้ปิดตายไปแล้ว
  assert.equal(token.confirmBeforeSend(), false);
  // รอบใหม่ (burst ใหม่) กลับมาทำงานปกติ — ไม่ replay ของเก่า
  const fresh = gate.open("U1");
  assert.equal(fresh.allowedToThink, true);
  db.close();
});

test("controlGate: control lookup พัง (throw) = fail closed ไม่ตอบ", () => {
  const gate = createControlGate({
    isAiEnabled: () => {
      throw new Error("db หาย");
    },
    logger: { warn: () => {} },
  });
  const token = gate.open("U1");
  assert.equal(token.allowedToThink, false);
  assert.equal(token.confirmBeforeSend(), false);
});
