// ตัวเลข "จะส่งถึง N คน" ต้องเป็นจำนวนคนที่ได้รับจริง
//
// เหตุการณ์จริง 2026-08-28: เจ้าของจะใช้ป้าย customer เป็นกลุ่มเป้าหมายบรอดแคส
// ตรวจแล้วพบว่าตัวนับกับตัวส่งเขียนเงื่อนไขแยกกัน และตัวนับขาดเงื่อนไขห้องที่ย้ายมาจาก
// LINE OA เดิม — ตัวนับบอก 5,551 คน แต่คนที่ได้รับจริงมี 79 คน
// ห้องที่เหลือเป็นบันทึกประวัติจากระบบเดิม ซึ่ง userId คนละชุดกับ Messaging API ส่งไปไม่ถึง
//
// การตัดสินใจว่าแคมเปญไหนจะส่งถึงกลุ่มไหน เป็นเรื่องของ includeTags/excludeTags
// ไม่ใช่หน้าที่ของชั้นนี้ ชั้นนี้กันเฉพาะ "ส่งไปก็ไม่ถึง" กับ "ห้ามส่ง" เท่านั้น
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";

const LEGACY_TAG = "ย้ายจาก LINE OA";

function seed(db, id, { tags = [], dnd = 0, consent = 0 } = {}) {
  db.upsertCustomer(id, { displayName: id });
  db.raw.prepare("UPDATE customers SET do_not_disturb = ?, marketing_consent = ? WHERE line_user_id = ?")
    .run(dnd, consent, id);
  for (const tag of tags) db.addTag(id, tag, "human");
  return id;
}

const bothAgree = (db, filter = {}) => {
  const count = db.broadcastAudienceCount(filter);
  const list = db.broadcastAudience(filter).length;
  assert.equal(count, list, `ตัวเลขที่โชว์ (${count}) ต้องเท่ากับคนที่ได้รับจริง (${list})`);
  return count;
};

test("ตัวเลขที่โชว์ก่อนกดส่ง ต้องเท่ากับคนที่ได้รับจริงเสมอ", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seed(db, "U-now-1");
  seed(db, "U-now-2", { tags: ["customer"] });
  // ห้องอ้างอิงจากระบบเดิม — ส่งไปไม่ถึง ต้องไม่ถูกนับ
  seed(db, "U-old-1", { tags: [LEGACY_TAG] });
  seed(db, "U-old-2", { tags: [LEGACY_TAG, "customer"] });

  assert.equal(bothAgree(db), 2, "ทั้งร้านต้องนับเฉพาะห้องปัจจุบัน");
  assert.equal(bothAgree(db, { includeTags: ["customer"] }), 1,
    "เลือกป้าย customer ต้องได้เฉพาะคนที่ส่งถึงจริง");
  assert.equal(bothAgree(db, { excludeTags: ["customer"] }), 1);
});

test("ป้าย customer เลือกเข้าหรือเอาออกก็ได้ — เป็นเรื่องของแต่ละแคมเปญ", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seed(db, "U-a", { tags: ["customer"] });
  seed(db, "U-b", { tags: ["customer"] });
  seed(db, "U-c");

  assert.equal(bothAgree(db, { includeTags: ["customer"] }), 2, "ส่งเฉพาะลูกค้าเก่าได้");
  assert.equal(bothAgree(db, { excludeTags: ["customer"] }), 1, "ยกเว้นลูกค้าเก่าได้");
  assert.equal(bothAgree(db), 3, "ไม่ระบุ = ถึงทุกคนที่ส่งถึงได้");
});

test("คนที่ปฏิเสธการตลาดหรือขอไม่ให้รบกวน ต้องไม่ถูกนับและไม่ถูกส่ง", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seed(db, "U-ok");
  seed(db, "U-dnd", { dnd: 1 });
  seed(db, "U-refused", { consent: -1 });

  assert.equal(bothAgree(db), 1, "เหลือคนเดียวที่ส่งได้");
});
