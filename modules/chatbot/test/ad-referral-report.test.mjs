// adReferralReport — รายงาน "แอดตัวไหนพาคนแบบไหนมา" (อ่านอย่างเดียว · คำสั่งพี่ง้วง 6 ต.ค. 2026)
//
// นิยามที่เทสต์นี้ล็อกไว้ (ทุกตัวนับเป็น "ห้อง" ไม่ใช่ข้อความ):
//   ห้องเปิดจากแอด      = ห้องที่มี referral ในช่วง — ห้องหนึ่งนับให้แอดตัวแรกที่พาเข้ามา "ในช่วงนั้น" ตัวเดียว
//   ไม่เข้าเกณฑ์          = ตัวกวาดปิดเป็นสีเหลือง (audit ai_off_not_qualified) หลังคลิกแอด — ยังเหลืองอยู่ตอนนี้แยกอีกช่อง
//                          (ห้องที่เหลืองมาตั้งแต่ก่อนคลิกแอดตัวนี้ ไม่นับให้แอดตัวนี้)
//   ถึงขั้นราคา           = ราคาคลาสถึงมือลูกค้าแล้ว (price_quoted_at) หรือ lifecycle เดินถึง price_sent ขึ้นไป หลังคลิก
//   ถึงขั้นเลือกรอบ        = lifecycle เดินถึง awaiting_round_choice ขึ้นไป หลังคลิก
//   จ่าย/ลงเรียน          = ยืนยันยอด (paid_confirmed) · enrollments · ออเดอร์ที่ "สร้าง" หลังคลิกแล้วจ่าย ·
//                          ป้าย customer ที่คนติด (ป้ายที่ระบบโยงชื่อลูกค้าเก่าติดเองไม่นับ) — หลังคลิก
//   ห้องผี (กดแอดแต่ไม่เคยพิมพ์ = ไม่มีแถวลูกค้า) ไม่นับเป็นห้อง — ไม่งั้นช่วงเดิมจะหดเองเมื่อ retention กวาดแถวกำพร้า
// ผลที่เกิด "ก่อน" คลิกแอด (ลูกค้าเก่ากดแอดกลับมา) ไม่นับให้แอดตัวนั้น
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { SALES_DEAL_FLOW } from "../src/dbLifecycle.mjs";
import { AD_REFERRAL_PRICE_STAGES, AD_REFERRAL_ROUND_STAGES } from "../src/dbAdReferrals.mjs";
import { LEGACY_AUTO_CUSTOMER_NOTE, SYSTEM_LINK_AUTHOR } from "../src/legacyAutoTag.mjs";

const T0 = Date.parse("2026-10-07T00:00:00+07:00");
const H = 3_600_000;
const AD_A = "120210000000000001";
const AD_B = "120210000000000002";

function seedRoom(db, id, { adId = AD_A, at = T0 + H, firstContact = true, source = "ADS", ref = "", title = "แอด A" } = {}) {
  db.upsertCustomer(id, { channelId: "facebook", displayName: id });
  db.recordAdReferral({
    customerId: id, channelId: "facebook", source, type: "OPEN_THREAD", adId, ref, adTitle: title,
    eventKind: "message", firstContact, referralAt: at,
  });
}

const audit = (db, id, at) => db.raw.prepare(
  "INSERT INTO admin_audit (id, operator, action, target, detail, created_at) VALUES (?, 'system:qualify', 'ai_off_not_qualified', ?, '', ?)",
).run(`a-${id}-${at}`, id, at);
const lifecycleEvent = (db, id, toStatus, at, toStage = "sales") => db.raw.prepare(
  `INSERT INTO lifecycle_events (id, customer_id, from_stage, to_stage, from_status, to_status, trigger, actor, evidence, created_at)
   VALUES (?, ?, 'sales', ?, 'new', ?, 'test', 'system', '', ?)`,
).run(`l-${id}-${toStatus}-${at}`, id, toStage, toStatus, at);

function report(db, sinceMs = T0, untilMs = T0 + 24 * H) {
  return db.adReferralReport({ sinceMs, untilMs });
}
const rowFor = (r, adId) => r.rows.find((row) => row.adId === adId);

test("นับห้องต่อแอด + ห้องใหม่ vs ห้องเดิมที่กดแอดกลับมา", () => {
  const db = memoryDb();
  seedRoom(db, "facebook:a1");
  seedRoom(db, "facebook:a2");
  seedRoom(db, "facebook:a3", { firstContact: false });
  seedRoom(db, "facebook:b1", { adId: AD_B, title: "แอด B" });
  const r = report(db);
  assert.equal(rowFor(r, AD_A).roomsOpened, 3);
  assert.equal(rowFor(r, AD_A).newRooms, 2);
  assert.equal(rowFor(r, AD_A).adTitle, "แอด A");
  assert.equal(rowFor(r, AD_B).roomsOpened, 1);
  assert.equal(r.rows[0].adId, AD_A, "แอดที่พาห้องมามากสุดขึ้นก่อน");
  assert.equal(r.totals.roomsOpened, 4);
  db.close();
});

test("ห้องเดียวคลิกสองแอดในช่วง = นับให้แอดแรกตัวเดียว (รวมทุกแถวต้องเท่าจำนวนห้องจริง)", () => {
  const db = memoryDb();
  seedRoom(db, "facebook:x", { adId: AD_B, at: T0 + 2 * H });
  db.recordAdReferral({
    customerId: "facebook:x", channelId: "facebook", source: "ADS", type: "OPEN_THREAD", adId: AD_A,
    eventKind: "referral", firstContact: false, referralAt: T0 + 5 * H,
  });
  const r = report(db);
  assert.equal(rowFor(r, AD_B).roomsOpened, 1);
  assert.equal(rowFor(r, AD_A), undefined);
  assert.equal(r.totals.roomsOpened, 1);
  // ช่วงที่เริ่มหลังคลิกแรก = แอดที่สองเป็นตัวที่เปิดห้องในช่วงนั้น
  const later = report(db, T0 + 3 * H, T0 + 24 * H);
  assert.equal(rowFor(later, AD_A).roomsOpened, 1);
  assert.equal(rowFor(later, AD_B), undefined);
  db.close();
});

test("ขอบช่วงเวลา: since รวม · until ไม่รวม", () => {
  const db = memoryDb();
  seedRoom(db, "facebook:edge-in", { at: T0 });
  seedRoom(db, "facebook:edge-out", { at: T0 + 24 * H });
  const r = report(db);
  assert.equal(r.totals.roomsOpened, 1);
  db.close();
});

test("ไม่เข้าเกณฑ์: audit สีเหลืองหลังคลิก · ยังเหลืองตอนนี้แยกช่อง · เหลืองมาก่อนคลิกไม่นับให้แอดใหม่", () => {
  const db = memoryDb();
  seedRoom(db, "facebook:nq-audit");
  audit(db, "facebook:nq-audit", T0 + 3 * H);
  db.setAiEnabled("facebook:nq-audit", true, ""); // ตัวกวาดคืนเขียวทีหลัง — ยังนับว่าเคยถูกคัดออก
  seedRoom(db, "facebook:nq-now");
  audit(db, "facebook:nq-now", T0 + 2 * H);
  db.setAiEnabled("facebook:nq-now", false, "not_qualified");
  seedRoom(db, "facebook:nq-before", { at: T0 + 5 * H, firstContact: false });
  audit(db, "facebook:nq-before", T0 + 2 * H);
  db.setAiEnabled("facebook:nq-before", true, "");
  // เหลืองจากแอดเก่า ยังเหลืองค้าง แล้วกดแอดใหม่เข้ามา — ห้ามนับให้แอดใหม่ (รีวิว 6 ต.ค.)
  seedRoom(db, "facebook:nq-still-old", { at: T0 + 6 * H, firstContact: false });
  audit(db, "facebook:nq-still-old", T0 + 2 * H);
  db.setAiEnabled("facebook:nq-still-old", false, "not_qualified");
  seedRoom(db, "facebook:other-off");
  db.setAiEnabled("facebook:other-off", false, "fb_legacy_customer");
  const row = rowFor(report(db), AD_A);
  assert.equal(row.roomsOpened, 5);
  assert.equal(row.notQualified, 2);
  assert.equal(row.notQualifiedNow, 1);
  db.close();
});

test("ถึงขั้นราคา/รอบ: price_quoted_at หรือ lifecycle หลังคลิก · ก่อนคลิกไม่นับ", () => {
  const db = memoryDb();
  seedRoom(db, "facebook:p-col", { at: T0 + H });
  db.raw.prepare("UPDATE customers SET price_quoted_at = ? WHERE line_user_id = ?").run(T0 + 2 * H, "facebook:p-col");
  seedRoom(db, "facebook:p-life");
  lifecycleEvent(db, "facebook:p-life", "price_sent", T0 + 2 * H);
  seedRoom(db, "facebook:round");
  lifecycleEvent(db, "facebook:round", "awaiting_payment", T0 + 3 * H);
  seedRoom(db, "facebook:old-price", { at: T0 + 6 * H, firstContact: false });
  db.raw.prepare("UPDATE customers SET price_quoted_at = ? WHERE line_user_id = ?").run(T0 + 2 * H, "facebook:old-price");
  lifecycleEvent(db, "facebook:old-price", "awaiting_round_choice", T0 + 3 * H);
  seedRoom(db, "facebook:info-only");
  lifecycleEvent(db, "facebook:info-only", "collecting_info", T0 + 2 * H);
  const row = rowFor(report(db), AD_A);
  assert.equal(row.reachedPrice, 3, "p-col + p-life + round (awaiting_payment อยู่หลังขั้นราคา)");
  assert.equal(row.reachedRound, 1);
  assert.equal(row.reachedPriceOrRound, 3);
  db.close();
});

test("จ่าย/ลงเรียน: ยืนยันยอด · enrollments · ออเดอร์จ่ายแล้ว · ป้าย customer — หลังคลิกเท่านั้น", () => {
  const db = memoryDb({ now: () => T0 + 6 * H }); // enrollments ใช้นาฬิกาของฐาน = หลังคลิกแอด
  seedRoom(db, "facebook:paid-life");
  lifecycleEvent(db, "facebook:paid-life", "paid_confirmed", T0 + 4 * H, "enrolled");
  seedRoom(db, "facebook:paid-enroll");
  db.addEnrollment({ customerId: "facebook:paid-enroll", courseId: "ai-class", confirmedBy: "nok" });
  seedRoom(db, "facebook:paid-order");
  db.raw.prepare(
    "INSERT INTO orders (id, customer_id, channel_id, status, created_at, updated_at) VALUES ('o1', ?, 'facebook', 'paid', ?, ?)",
  ).run("facebook:paid-order", T0 + 2 * H, T0 + 3 * H);
  seedRoom(db, "facebook:paid-tag");
  db.raw.prepare("INSERT INTO customer_tags (customer_id, tag, source, created_at) VALUES (?, 'customer', 'human', ?)")
    .run("facebook:paid-tag", T0 + 5 * H);
  seedRoom(db, "facebook:draft-order");
  db.raw.prepare(
    "INSERT INTO orders (id, customer_id, channel_id, status, created_at, updated_at) VALUES ('o2', ?, 'facebook', 'draft', ?, ?)",
  ).run("facebook:draft-order", T0 + 2 * H, T0 + 3 * H);
  seedRoom(db, "facebook:paid-before", { at: T0 + 8 * H, firstContact: false });
  lifecycleEvent(db, "facebook:paid-before", "paid_confirmed", T0 + 2 * H, "enrolled");
  // ออเดอร์เก่าที่จ่ายก่อนคลิก แล้วแค่ "ส่งของ" หลังคลิก (updated_at ขยับ) — ไม่ใช่ยอดของแอดนี้ (รีวิว 6 ต.ค.)
  seedRoom(db, "facebook:old-order", { at: T0 + 4 * H, firstContact: false });
  db.raw.prepare(
    "INSERT INTO orders (id, customer_id, channel_id, status, created_at, updated_at) VALUES ('o3', ?, 'facebook', 'shipped', ?, ?)",
  ).run("facebook:old-order", T0 - 48 * H, T0 + 5 * H);
  // ป้าย customer ที่ระบบโยงชื่อลูกค้าเก่าติดเอง (legacyLink) — ไม่ใช่การซื้อจากแอดนี้
  seedRoom(db, "facebook:legacy-auto");
  db.raw.prepare("INSERT INTO customer_tags (customer_id, tag, source, created_at) VALUES (?, 'customer', 'human', ?)")
    .run("facebook:legacy-auto", T0 + 2 * H);
  db.raw.prepare("INSERT INTO handoff_notes (id, customer_id, author, text, created_at) VALUES ('n1', ?, ?, ?, ?)")
    .run("facebook:legacy-auto", SYSTEM_LINK_AUTHOR, LEGACY_AUTO_CUSTOMER_NOTE, T0 + 2 * H);
  const row = rowFor(report(db), AD_A);
  assert.equal(row.roomsOpened, 8);
  assert.equal(row.paid, 4);
  db.close();
});

test("referral ที่ไม่ใช่แอด (ลิงก์ m.me) แยกแถวตาม source+ref · ห้อง canary ไม่นับ", () => {
  const db = memoryDb();
  seedRoom(db, "facebook:link1", { adId: "", source: "SHORTLINK", ref: "bio_link" });
  seedRoom(db, "facebook:link2", { adId: "", source: "SHORTLINK", ref: "bio_link" });
  seedRoom(db, "canary:facebook:probe");
  const r = report(db);
  const link = r.rows.find((row) => row.key === "ref:SHORTLINK:bio_link");
  assert.equal(link.roomsOpened, 2);
  assert.equal(link.adId, "");
  assert.equal(link.source, "SHORTLINK");
  assert.equal(link.ref, "bio_link");
  assert.equal(r.totals.roomsOpened, 2);
  db.close();
});

test("ความครอบคลุม: ห้อง Facebook ใหม่ในช่วงที่ไม่มี referral เลย = ไม่ทราบที่มา (ไว้เช็กว่า webhook ส่ง referral มาจริง)", () => {
  const db = memoryDb({ now: () => T0 + 2 * H }); // created_at ของห้องอยู่ในช่วง
  seedRoom(db, "facebook:from-ad");
  db.upsertCustomer("facebook:organic", { channelId: "facebook" });
  db.upsertCustomer("U-line-only", { channelId: "default" });
  const r = report(db);
  assert.equal(r.coverage.newFacebookRooms, 2);
  assert.equal(r.coverage.newFacebookRoomsFromReferral, 1);
  db.close();
});

test("ไม่มีข้อมูล = แถวว่าง ตัวเลขรวมเป็นศูนย์ ไม่ใช่ null", () => {
  const db = memoryDb();
  const r = report(db);
  assert.deepEqual(r.rows, []);
  assert.equal(r.totals.roomsOpened, 0);
  assert.equal(r.totals.paid, 0);
  assert.equal(r.captureStartedAt, null);
  db.close();
});

test("ห้องผี: กดแอดแต่ไม่เคยพิมพ์ (ไม่มีแถวลูกค้า) ไม่นับเป็นห้อง · พิมพ์ทีหลังแล้วนับ", () => {
  const db = memoryDb();
  db.recordAdReferral({
    customerId: "facebook:ghost", channelId: "facebook", source: "ADS", type: "OPEN_THREAD", adId: AD_A,
    eventKind: "referral", firstContact: true, referralAt: T0 + H,
  });
  assert.equal(report(db).totals.roomsOpened, 0);
  db.upsertCustomer("facebook:ghost", { channelId: "facebook" });
  assert.equal(rowFor(report(db), AD_A).roomsOpened, 1);
  db.close();
});

test("ชื่อแอด: ใช้หัวข้อจากคลิกล่าสุดของแอดนั้น (แก้ชื่อแอดกลางแคมเปญแล้วเห็นชื่อใหม่)", () => {
  const db = memoryDb();
  seedRoom(db, "facebook:t1", { at: T0 + H, title: "ZZ ชื่อเก่า" });
  seedRoom(db, "facebook:t2", { at: T0 + 3 * H, title: "QUALIFIED MSG ชื่อใหม่" });
  assert.equal(rowFor(report(db), AD_A).adTitle, "QUALIFIED MSG ชื่อใหม่");
  db.close();
});

test("ขั้นราคา/รอบ ผูกกับลำดับ SALES_DEAL_FLOW จริง (เพิ่มขั้นใหม่แล้วรายงานต้องไม่เงียบผิด)", () => {
  const from = (status) => SALES_DEAL_FLOW.slice(SALES_DEAL_FLOW.indexOf(status));
  assert.deepEqual([...AD_REFERRAL_PRICE_STAGES], [...from("price_sent"), "paid_confirmed", "prep_sent"]);
  assert.deepEqual([...AD_REFERRAL_ROUND_STAGES], [...from("awaiting_round_choice"), "paid_confirmed", "prep_sent"]);
});

test("ความครอบคลุม: บอกจำนวน lifecycle event ในช่วง — ศูนย์ = ขั้นเลือกรอบนับไม่ได้ (lifecycle_mode ปิด)", () => {
  const db = memoryDb();
  seedRoom(db, "facebook:lc");
  assert.equal(report(db).coverage.lifecycleEvents, 0);
  lifecycleEvent(db, "facebook:lc", "collecting_info", T0 + 2 * H);
  lifecycleEvent(db, "facebook:lc", "price_sent", T0 + 30 * H); // นอกช่วง
  assert.equal(report(db).coverage.lifecycleEvents, 1);
  db.close();
});

test("ช่วงเวลาไม่ใช่ตัวเลข = โยน (ผู้เรียกตรงต้องไม่ได้รายงานว่างแบบเงียบ ๆ)", () => {
  const db = memoryDb();
  assert.throws(() => db.adReferralReport({ sinceMs: Number.NaN, untilMs: T0 }), /range/u);
  db.close();
});
