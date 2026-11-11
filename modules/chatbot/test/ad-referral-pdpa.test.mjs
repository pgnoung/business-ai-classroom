// customer_ad_referrals กับสิทธิ์ให้ลืม + retention (คำสั่งพี่ง้วง 6 ต.ค. 2026)
//
// pdpa-cascade.test.mjs จับตารางนี้ได้เองเพราะมีคอลัมน์ customer_id — ไฟล์นี้คุมกรณีที่ cascade มองไม่เห็น:
// เธรดเดิมกดแอดแล้วไม่เคยพิมพ์อะไรเลย = มีแถว referral แต่ "ไม่มีแถวลูกค้า" (resetCustomer เดิมจบเร็วเมื่อไม่พบลูกค้า)
// แถวกำพร้าแบบนี้ไม่มีหน้าจอไหนเห็น จึงต้องหายได้ทั้งทางคำขอลืมและทาง retention อัตโนมัติ
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { AD_REFERRAL_ORPHAN_RETENTION_DAYS } from "../src/dbAdReferrals.mjs";

const DAY = 86_400_000;
const record = (db, customerId, at, adId = "120210000000000001") => db.recordAdReferral({
  customerId, channelId: "facebook", source: "ADS", type: "OPEN_THREAD", adId, eventKind: "referral",
  firstContact: true, referralAt: at,
});
const count = (db, id) => db.raw.prepare("SELECT COUNT(*) AS n FROM customer_ad_referrals WHERE customer_id = ?").get(id).n;

test("ลืมลูกค้าที่มีห้อง = แถว referral หายทั้งหมด · ลูกค้าคนอื่นอยู่ครบ", () => {
  const db = memoryDb();
  db.upsertCustomer("facebook:forget-me", { channelId: "facebook" });
  db.upsertCustomer("facebook:keep-me", { channelId: "facebook" });
  record(db, "facebook:forget-me", 1);
  record(db, "facebook:forget-me", 2, "120210000000000002");
  record(db, "facebook:keep-me", 1);
  db.resetCustomer("facebook:forget-me", { forget: true });
  assert.equal(count(db, "facebook:forget-me"), 0);
  assert.equal(count(db, "facebook:keep-me"), 1);
  db.close();
});

// ปุ่มในคอนโซลตอบ 404 ก่อนถึง resetCustomer เมื่อไม่มีแถวลูกค้า — ทางหลักของแถวกำพร้าคือ retention 7 วัน (เทสต์ถัดไป)
// เทสต์นี้คุมชั้นฐานข้อมูล: เครื่องมือ/runbook ที่เรียก resetCustomer ด้วย id ตรง ๆ ต้องลบได้ด้วย
test("ชั้นฐานข้อมูล: แถวกำพร้า (กดแอดแต่ไม่เคยพิมพ์ = ไม่มีแถวลูกค้า) ลบได้ทั้ง reset ธรรมดาและคำขอลืม", () => {
  const db = memoryDb();
  record(db, "facebook:orphan-reset", 1);
  record(db, "facebook:orphan-forget", 1);
  assert.equal(db.resetCustomer("facebook:orphan-reset"), null);
  assert.equal(count(db, "facebook:orphan-reset"), 0);
  db.resetCustomer("facebook:orphan-forget", { forget: true });
  assert.equal(count(db, "facebook:orphan-forget"), 0);
  const tombstones = db.raw.prepare("SELECT COUNT(*) AS n FROM customer_tombstones").get().n;
  assert.equal(tombstones, 1, "คำขอลืมยังเขียน tombstone ตามเดิม");
  db.close();
});

test("retention: แถวกำพร้าเก่ากว่ากรอบถูกกวาด · กำพร้าที่ยังใหม่และแถวของห้องจริงอยู่ต่อ", () => {
  let clock = 1_800_000_000_000;
  const db = memoryDb({ now: () => clock });
  record(db, "facebook:old-orphan", 1);
  db.upsertCustomer("facebook:real-room", { channelId: "facebook" });
  record(db, "facebook:real-room", 1);
  clock += (AD_REFERRAL_ORPHAN_RETENTION_DAYS + 1) * DAY;
  record(db, "facebook:young-orphan", 1);
  const result = db.pruneRetention({ now: clock });
  assert.equal(result.orphanAdReferrals, 1);
  assert.equal(count(db, "facebook:old-orphan"), 0);
  assert.equal(count(db, "facebook:young-orphan"), 1);
  assert.equal(count(db, "facebook:real-room"), 1, "ห้องจริงไม่มีอายุ referral — อยู่ตามประวัติแชท");
  db.close();
});

test("ทุกคอลัมน์ของตารางไม่มีข้อความแชท/ชื่อ/รูปของลูกค้า — เก็บแค่ที่มาของแอด (+ โพสต์/รูปของแอดเราเอง)", () => {
  const db = memoryDb();
  const columns = db.raw.prepare("PRAGMA table_info(customer_ad_referrals)").all().map((col) => col.name).sort();
  // post_id/photo_url/media_type (6 ต.ค. ค่ำ): โพสต์และรูปของ "แอดเรา" สำหรับแถบในหน้าแชท ไม่ใช่ข้อมูลลูกค้า
  assert.deepEqual(columns, [
    "ad_id", "ad_title", "channel_id", "created_at", "customer_id", "event_kind", "first_contact", "id",
    "media_type", "photo_url", "post_id", "ref", "referral_at", "source", "type",
  ]);
  db.close();
});

test("เพดาน 20 แถวต่อห้อง: ลิงก์ m.me?ref= ที่ใครก็กดได้ ห้ามทำให้ห้องเดียวโตไม่จำกัด", async () => {
  const { AD_REFERRAL_MAX_PER_CUSTOMER } = await import("../src/dbAdReferrals.mjs");
  const db = memoryDb();
  db.upsertCustomer("facebook:spam", { channelId: "facebook" });
  let stored = 0;
  for (let i = 1; i <= AD_REFERRAL_MAX_PER_CUSTOMER + 5; i += 1) {
    if (db.recordAdReferral({ customerId: "facebook:spam", source: "SHORTLINK", ref: `r${i}`, eventKind: "referral", referralAt: i })) stored += 1;
  }
  assert.equal(stored, AD_REFERRAL_MAX_PER_CUSTOMER);
  assert.equal(count(db, "facebook:spam"), AD_REFERRAL_MAX_PER_CUSTOMER);
  db.close();
});
