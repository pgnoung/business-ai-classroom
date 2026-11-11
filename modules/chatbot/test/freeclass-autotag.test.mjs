// ติดป้าย "คลาสฟรี" อัตโนมัติเมื่อส่งลิงก์คลาสฟรี (คำสั่งเจ้าของ 2026-08-29)
//
// "อยากให้ track จากสิ่งที่ลูกแพรพิมพ์ไป หรือแอดมินจริง ๆ พิมพ์
//  ถ้าส่งลิ้งค์คลาสเรียนฟรี ให้ขึ้นป้าย คลาสฟรี ได้เลย"
//
// ป้ายนี้ต่อเข้ากติกา FU เว้น 7 วัน (FREE_CLASS_QUIET_MS) โดยอัตโนมัติ
// ลิงก์ไหนคือ "คลาสฟรี" เป็นค่าตั้งใน Console (settings.freeclass_link_patterns)
// เพราะเดาลิงก์ผิด = กด FU เงียบใส่ลีดที่ไม่เกี่ยว — ค่าว่าง = ระบบเฉย ปลอดภัยเป็นค่าเริ่มต้น
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { FREE_CLASS_TAG, FREECLASS_PATTERNS_KEY } from "../src/db.mjs";
import { STICKY_AUTO_TAGS } from "../src/dbTags.mjs";

const LINK = "https://www.pngoung.com/p/free-ai-class";

function seedCustomer(db, id) {
  db.upsertCustomer(id, {});
  db.raw.prepare("UPDATE customers SET followup_enabled=1 WHERE line_user_id=?").run(id);
}
const tagRow = (db, id) => db.raw.prepare(
  "SELECT tag, source, created_at FROM customer_tags WHERE customer_id=? AND tag=?").get(id, FREE_CLASS_TAG);

test("บอทหรือแอดมินส่งลิงก์ที่ตั้งไว้ = ติดป้ายคลาสฟรีทันที (บอท=ai, คน=human)", () => {
  const db = memoryDb();
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["pngoung.com/p/free-ai-class"]));
  seedCustomer(db, "U-bot");
  db.insertMessage({ customerId: "U-bot", direction: "out", content: `สนใจลองเรียนก่อนได้ค่ะ ${LINK} นะคะ` });
  assert.equal(tagRow(db, "U-bot")?.source, "ai", "บอทส่ง = source ai");

  seedCustomer(db, "U-admin");
  db.insertMessage({ customerId: "U-admin", direction: "out", operator: "chom", content: `ของขวัญจากพี่ค่ะ ${LINK}` });
  assert.equal(tagRow(db, "U-admin")?.source, "human", "แอดมินส่ง = source human");
  db.close();
});

test("ติดป้ายแล้ว FU ต้องเงียบทันที (ต่อเข้ากติกา 7 วันโดยอัตโนมัติ)", () => {
  const db = memoryDb();
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["pngoung.com/p/free-ai-class"]));
  seedCustomer(db, "U-quiet");
  db.insertMessage({ customerId: "U-quiet", direction: "in", content: "สนใจค่ะ" });
  db.insertMessage({ customerId: "U-quiet", direction: "out", content: LINK });
  const ids = db.listStagedFollowupCandidates({ nowMs: Date.now(), activeWithinMs: 10 * 86400_000 })
    .map((c) => c.line_user_id);
  assert.ok(!ids.includes("U-quiet"), "เพิ่งได้ลิงก์คลาสฟรี ต้องหายจากคิว FU");
  db.close();
});

test("ส่งลิงก์ซ้ำ = รีเซ็ตหน้าต่าง 7 วัน (ให้ของขวัญรอบใหม่ นับใหม่)", () => {
  const db = memoryDb();
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["pngoung.com/p/free-ai-class"]));
  seedCustomer(db, "U-again");
  db.insertMessage({ customerId: "U-again", direction: "out", content: LINK });
  const first = tagRow(db, "U-again").created_at;
  db.raw.prepare("UPDATE customer_tags SET created_at=? WHERE customer_id=?").run(first - 30 * 86400_000, "U-again");
  db.insertMessage({ customerId: "U-again", direction: "out", content: `ส่งให้อีกรอบค่ะ ${LINK}` });
  assert.ok(tagRow(db, "U-again").created_at >= first, "ส่งซ้ำต้องรีเซ็ตเวลา ไม่ใช่คงของเก่า");
  db.close();
});

// v1.4.50 (บั๊กจริง เจอ 2026-08-30): scorer ยิงทุกเทิร์นที่บอทตอบ (pipeline.mjs:2119)
// แล้วเรียก replaceSourceTags(id,'ai',...) ซึ่ง "ลบป้าย source=ai ทั้งชุด" ก่อนเขียนใหม่
// ป้ายคลาสฟรีที่บอทติด (source=ai) จึงถูกล้างทิ้งในเทิร์นเดียวกัน = FU ไม่เคยเงียบจริง
// ในเส้นทางบอท ซึ่งเป็นเส้นทางหลักที่เจ้าของสั่ง — ป้ายนี้เป็น "บันทึกเหตุการณ์" ไม่ใช่
// ความเห็นของ scorer จึงต้องรอดจากการรีเฟรชป้าย intent เสมอ
// ชื่อป้ายอยู่สองไฟล์: db.mjs เป็นคนติด · dbTags.mjs เป็นคนกันไม่ให้ถูกล้าง
// ถ้าวันหน้าเปลี่ยนชื่อที่เดียว เกราะจะหลุดแบบเงียบ ๆ แล้วบั๊กเดิมกลับมาโดยไม่มีอะไรแดง
test("ชื่อป้ายคลาสฟรีต้องอยู่ในรายชื่อป้ายที่ห้ามถูกล้าง (กันสองไฟล์เลื่อนออกจากกัน)", () => {
  assert.ok(STICKY_AUTO_TAGS.includes(FREE_CLASS_TAG),
    `เปลี่ยนชื่อป้ายแล้วลืมอัปเดต STICKY_AUTO_TAGS — ป้าย "${FREE_CLASS_TAG}" จะโดน scorer ล้างอีก`);
});

test("scorer รีเฟรชป้าย intent แล้ว ป้ายคลาสฟรีต้องไม่หาย (บั๊กเดิม: บอทติดแล้วโดนล้างทันที)", () => {
  const db = memoryDb();
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["pngoung.com/p/free-ai-class"]));
  seedCustomer(db, "U-scored");
  db.insertMessage({ customerId: "U-scored", direction: "out", content: `ลองเรียนก่อนได้ค่ะ ${LINK}` });
  assert.ok(tagRow(db, "U-scored"), "ตั้งต้น: ต้องติดป้ายก่อน");

  db.replaceSourceTags("U-scored", "ai", ["สนใจสูง", "ถามราคา"]);
  assert.ok(tagRow(db, "U-scored"), "scorer เขียนป้าย intent ใหม่ ต้องไม่ล้างป้ายคลาสฟรี");

  db.replaceSourceTags("U-scored", "ai", []);
  assert.ok(tagRow(db, "U-scored"), "scorer ไม่มีป้ายเลย ก็ยังห้ามล้างป้ายคลาสฟรี");

  const intent = db.listTags("U-scored").map((t) => t.tag);
  assert.ok(!intent.includes("สนใจสูง"), "ป้าย intent เก่ายังต้องถูกล้างตามปกติ (อย่ากันเกิน)");
  db.close();
});

test("แอดมินติดป้ายคลาสฟรีเองไว้ก่อน บอทส่งลิงก์ทีหลัง ต้องไม่ลดชั้นเป็นของ AI", () => {
  const db = memoryDb();
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["pngoung.com/p/free-ai-class"]));
  seedCustomer(db, "U-mixed");
  db.addTag("U-mixed", FREE_CLASS_TAG, "human");
  db.insertMessage({ customerId: "U-mixed", direction: "out", content: LINK });
  assert.equal(tagRow(db, "U-mixed")?.source, "human", "ป้ายที่คนติดไว้ ระบบห้ามเปลี่ยนเจ้าของ");
  db.replaceSourceTags("U-mixed", "ai", []);
  assert.ok(tagRow(db, "U-mixed"), "ป้ายของคนต้องอยู่ยงเหมือนเดิม");
  db.close();
});

// เจ้าของวางลิงก์เต็มจากแถบที่อยู่ (ไม่มี www.) แต่ข้อความจริงอาจมี www. หรือ http://
// เทียบสตริงดิบจึงพลาดเงียบ ๆ — ตัดโปรโตคอลกับ www. ทิ้งทั้งสองฝั่งก่อนเทียบ
test("ลิงก์เดียวกันแต่เขียนต่างรูป (www. / http:// / ตัวพิมพ์ใหญ่) ต้องยังจับได้", () => {
  const db = memoryDb();
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["https://pngoungacademy.com/courses/teaser-6ced0a"]));
  const cases = [
    ["U-www", "https://www.pngoungacademy.com/courses/teaser-6ced0a"],
    ["U-http", "http://pngoungacademy.com/courses/teaser-6ced0a"],
    ["U-utm", "https://pngoungacademy.com/courses/teaser-6ced0a?utm_source=line"],
    ["U-caps", "https://PngoungAcademy.com/courses/teaser-6ced0a"],
  ];
  for (const [id, url] of cases) {
    seedCustomer(db, id);
    db.insertMessage({ customerId: id, direction: "out", content: `เชิญเลยค่ะ ${url}` });
    assert.ok(tagRow(db, id), `ต้องจับได้: ${url}`);
  }

  seedCustomer(db, "U-other");
  db.insertMessage({ customerId: "U-other", direction: "out", content: "https://pngoungacademy.com/courses/paid-course" });
  assert.equal(tagRow(db, "U-other"), undefined, "คอร์สอื่นห้ามติดป้าย — กันเหวี่ยงแหกว้างเกิน");
  db.close();
});

test("เส้นที่ห้ามติดป้าย: ประวัติย้ายระบบ · ข้อความ proactive · ขาเข้า · ไม่ได้ตั้งลิงก์", () => {
  const db = memoryDb();
  seedCustomer(db, "U-none");
  db.insertMessage({ customerId: "U-none", direction: "out", content: LINK }); // ยังไม่ตั้งลิงก์
  assert.equal(tagRow(db, "U-none"), undefined, "ไม่ได้ตั้งลิงก์ = ระบบเฉย");

  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["pngoung.com/p/free-ai-class"]));
  seedCustomer(db, "U-legacy");
  db.insertMessage({ customerId: "U-legacy", direction: "out", operator: "LINE OA (ย้ายข้อมูล)", content: LINK });
  assert.equal(tagRow(db, "U-legacy"), undefined, "ประวัติย้ายระบบห้ามติดป้าย — ลิงก์เก่าไม่ใช่ของขวัญวันนี้");

  seedCustomer(db, "U-broadcast");
  db.insertMessage({ customerId: "U-broadcast", direction: "out", messageClass: "proactive", content: LINK });
  assert.equal(tagRow(db, "U-broadcast"), undefined, "ข้อความเชิงรุก (FU/บรอดแคส) ไม่นับเป็นการให้ของขวัญรายคน");

  seedCustomer(db, "U-inbound");
  db.insertMessage({ customerId: "U-inbound", direction: "in", content: LINK });
  assert.equal(tagRow(db, "U-inbound"), undefined, "ลูกค้าส่งลิงก์เอง ไม่ใช่เราให้");
  db.close();
});
