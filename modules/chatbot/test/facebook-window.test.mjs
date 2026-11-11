// หน้าต่าง 24 ชม.ของ Facebook + ภาคผนวกสมองต่อช่องบนคลังกลาง (v1.5)
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { FB_MESSAGING_WINDOW_MS } from "../src/db.mjs";
import { composeBrandPackForChannel, brainAddendumKey, ADDENDUM_HEADER } from "../src/knowledgePack.mjs";

test("withinFacebookWindow — ใน/นอกหน้าต่าง + ไม่เคยทักเลย", () => {
  const db = memoryDb();
  db.upsertCustomer("facebook:p1", { channelId: "facebook" });
  const now = Date.now();

  assert.equal(db.withinFacebookWindow("facebook:p1", now), false, "ไม่มี inbound = ปิดเสมอ");

  db.insertMessage({ customerId: "facebook:p1", direction: "in", content: "สนใจค่ะ" });
  assert.equal(db.withinFacebookWindow("facebook:p1", now + 1000), true, "เพิ่งทัก = เปิด");
  assert.equal(
    db.withinFacebookWindow("facebook:p1", now + FB_MESSAGING_WINDOW_MS + 60_000),
    false,
    "เกินหน้าต่าง (รวม margin) = ปิด",
  );
  // ข้อความขาออกของเราเองต้องไม่รีเซ็ตหน้าต่าง — Meta นับจากข้อความลูกค้าเท่านั้น
  db.insertMessage({ customerId: "facebook:p1", direction: "out", content: "ตอบกลับ" });
  assert.equal(
    db.withinFacebookWindow("facebook:p1", now + FB_MESSAGING_WINDOW_MS + 60_000),
    false,
    "ขาออกไม่ยืดหน้าต่าง",
  );
  db.close();
});

test("margin 5 นาที: นาทีที่ 23:56 ต้องปิดแล้ว (งานที่หยิบช้าห้ามหลุดไปชนเส้น 24 ชม.จริง)", () => {
  const db = memoryDb();
  db.upsertCustomer("facebook:p2", { channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:p2", direction: "in", content: "x" });
  const inboundAt = db.lastInboundAt("facebook:p2");
  const at2356 = inboundAt + 24 * 60 * 60 * 1000 - 4 * 60 * 1000; // เหลือ 4 นาทีถึงเส้นจริง
  assert.equal(db.withinFacebookWindow("facebook:p2", at2356), false);
  db.close();
});

test("ภาคผนวกช่อง facebook ต่อท้าย brand pack ได้ทั้งที่ความรู้ยังเป็นคลังกลาง (shared)", () => {
  const db = memoryDb();
  db.setSetting(brainAddendumKey("facebook"), "ลูกค้า Facebook มักถามจาก quick reply เช่น 'ราคาเทอมละเท่าไหร่' — หมายถึงราคาคลาส");
  db.addKnowledge({ title: "ราคาคลาส", content: "One Day AI 4,900 บาท", updatedBy: "test" });

  const fbPack = composeBrandPackForChannel({ db, brandPack: "ฐาน", channelId: "facebook" });
  assert.ok(fbPack.includes(ADDENDUM_HEADER), "ต้องมีภาคผนวก");
  assert.ok(fbPack.includes("quick reply"), "เนื้อภาคผนวกต้องเข้า");
  assert.ok(fbPack.includes("One Day AI 4,900"), "ความรู้กลางต้องยังเข้าครบ (ไม่ใช่โหมดแยก)");

  // channel default (LINE เดิม) ไม่ตั้ง addendum = ผลลัพธ์เดิมทุกตัวอักษร
  const linePack = composeBrandPackForChannel({ db, brandPack: "ฐาน", channelId: "default" });
  assert.ok(!linePack.includes(ADDENDUM_HEADER), "LINE ไม่มีภาคผนวก — พฤติกรรมเดิมเป๊ะ");
  assert.ok(linePack.includes("One Day AI 4,900"));
  db.close();
});

// v1.5.1 (probe-memory-05): ข้อความแอดมินคนจริงต้องแยกจากของบอทในสายตาโมเดล
test("recentTurns ติดป้าย [แอดมินทีมงานพิมพ์เอง] เฉพาะข้อความที่คนจริงพิมพ์", () => {
  const db = memoryDb();
  db.upsertCustomer("U-hist", {});
  db.insertMessage({ customerId: "U-hist", direction: "in", content: "เลื่อนวันได้ไหมคะ" });
  db.insertMessage({ customerId: "U-hist", direction: "out", operator: "chompoo", content: "เลื่อนเป็นรุ่น 8 ให้แล้วนะคะ" });
  db.insertMessage({ customerId: "U-hist", direction: "out", content: "มีอะไรถามเพิ่มได้เลยนะคะ" });
  const turns = db.recentTurns("U-hist", 6);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].content, "เลื่อนวันได้ไหมคะ", "ข้อความลูกค้าห้ามแตะ");
  assert.ok(turns[1].content.startsWith("[แอดมินทีมงานพิมพ์เอง] "), "ของแอดมินต้องมีป้าย");
  assert.equal(turns[2].content, "มีอะไรถามเพิ่มได้เลยนะคะ", "ของบอทเอง (operator ว่าง) ห้ามติดป้าย");
  db.close();
});
