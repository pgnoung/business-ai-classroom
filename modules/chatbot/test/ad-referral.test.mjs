// adReferral — อ่าน referral ของ Meta (แอดคลิกเข้าแชท) ออกจาก event Messenger (คำสั่งพี่ง้วง 6 ต.ค. 2026)
// ที่อยู่ของ referral ตามเอกสาร Meta มีสามที่: messaging[].referral (เธรดเดิมกดแอด/ลิงก์ m.me) ·
// message.referral (ข้อความแรกหลังคลิกแอด) · postback.referral (ปุ่มเริ่มต้นของเธรดใหม่)
import test from "node:test";
import assert from "node:assert/strict";
import {
  AD_REFERRAL_CAPTURE_KEY, adReferralCaptureMode, captureAdReferral, extractAdReferral,
} from "../src/adReferral.mjs";
import { memoryDb } from "./helpers.mjs";

const adsReferral = (over = {}) => ({
  ref: "qualified_msg_a", source: "ADS", type: "OPEN_THREAD", ad_id: "120210000000000001",
  ads_context_data: { ad_title: "คลาส AI สำหรับเจ้าของธุรกิจ", photo_url: "https://scontent.example/x.jpg", post_id: "1048_99" },
  ...over,
});

test("อ่าน referral ได้ทั้งสามที่ — event ระดับบน, ใน message, ใน postback", () => {
  const atEvent = extractAdReferral({ timestamp: 1_790_000_000_000, referral: adsReferral() });
  assert.equal(atEvent.kind, "referral");
  assert.equal(atEvent.adId, "120210000000000001");
  assert.equal(atEvent.source, "ADS");
  assert.equal(atEvent.type, "OPEN_THREAD");
  assert.equal(atEvent.ref, "qualified_msg_a");
  assert.equal(atEvent.adTitle, "คลาส AI สำหรับเจ้าของธุรกิจ");
  assert.equal(atEvent.referralAt, 1_790_000_000_000);

  const inMessage = extractAdReferral({ timestamp: 5, message: { mid: "m1", text: "สนใจค่ะ", referral: adsReferral() } });
  assert.equal(inMessage.kind, "message");
  assert.equal(inMessage.adId, "120210000000000001");

  const inPostback = extractAdReferral({
    timestamp: 6, postback: { title: "เริ่มต้นใช้งาน", payload: "GET_STARTED", referral: adsReferral({ ref: "" }) },
  });
  assert.equal(inPostback.kind, "postback");
  assert.equal(inPostback.ref, "");
});

test("ข้อความธรรมดาที่ไม่มี referral = null · echo ของเพจไม่นับ · referral สินค้า Shops ที่ไม่มีที่มา = null", () => {
  assert.equal(extractAdReferral({ message: { mid: "m", text: "สวัสดี" } }), null);
  assert.equal(extractAdReferral({ message: { mid: "m", is_echo: true, referral: adsReferral() } }), null);
  assert.equal(extractAdReferral({ message: { mid: "m", text: "x", referral: { product: { id: "p1" } } } }), null);
  assert.equal(extractAdReferral(null), null);
  assert.equal(extractAdReferral({ referral: "ADS" }), null);
});

test("ทำความสะอาดค่า: ad_id ต้องเป็นตัวเลขล้วน · ref ใช้ตัวอักษรตามที่ Meta อนุญาต · ความยาวมีเพดาน", () => {
  const dirty = extractAdReferral({
    timestamp: 7,
    referral: {
      ad_id: "12345<script>", source: "ads\u0000", type: "open_thread", ref: `a b<c>=d_${"x".repeat(400)}`,
      ads_context_data: { ad_title: `  หัว\nแอด\u0007 ${"ก".repeat(300)}` },
    },
  });
  assert.equal(dirty.adId, "", "ad_id ที่ไม่ใช่ตัวเลขล้วนต้องไม่ถูกเก็บ");
  assert.equal(dirty.source, "ADS");
  assert.equal(dirty.type, "OPEN_THREAD");
  assert.match(dirty.ref, /^[A-Za-z0-9_=-]*$/u);
  assert.ok(dirty.ref.length <= 200);
  assert.ok(!/[\u0000-\u001f]/u.test(dirty.adTitle));
  assert.ok([...dirty.adTitle].length <= 120);
  assert.ok(dirty.adTitle.startsWith("หัว แอด"));

  const numericId = extractAdReferral({ referral: { ad_id: 120210000000000001n.toString(), source: "ADS" } });
  assert.equal(numericId.adId, "120210000000000001");
  // Meta ส่ง ad_id เป็นสตริงเสมอ แต่ถ้ามาเป็นตัวเลขจะเสียความแม่นยำเกิน 2^53 — ไม่เดาค่า
  assert.equal(extractAdReferral({ referral: { ad_id: 120210000000000001, source: "ADS" } }).adId, "");
});

test("เวลา: ไม่มี timestamp หรือผิดรูป = ใช้เวลาที่ระบบรับ", () => {
  assert.equal(extractAdReferral({ referral: adsReferral() }, { nowMs: 42 }).referralAt, 42);
  assert.equal(extractAdReferral({ timestamp: "abc", referral: adsReferral() }, { nowMs: 43 }).referralAt, 43);
  assert.equal(extractAdReferral({ timestamp: -1, referral: adsReferral() }, { nowMs: 44 }).referralAt, 44);
});

test("สวิตช์ ad_referral_capture: ไม่มีแถว/ค่าแปลก/อ่านพัง = off · on เท่านั้นที่เปิด", () => {
  const db = memoryDb();
  assert.equal(adReferralCaptureMode(db), "off");
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "yes");
  assert.equal(adReferralCaptureMode(db), "off");
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  assert.equal(adReferralCaptureMode(db), "on");
  assert.equal(adReferralCaptureMode({ getSetting() { throw new Error("db down"); } }), "off");
  db.close();
});

test("captureAdReferral: สวิตช์ปิด = ไม่เขียนอะไร · เปิด = เขียนหนึ่งแถว · ส่งซ้ำ (Meta retry) = ยังหนึ่งแถว", () => {
  const db = memoryDb();
  const event = { timestamp: 1_790_000_000_000, message: { mid: "m1", text: "สนใจ", referral: adsReferral() } };
  const args = { event, customerId: "facebook:psid-1", channelId: "facebook", firstContact: true };
  assert.deepEqual(captureAdReferral(db, args), { captured: false, reason: "off" });
  assert.equal(db.listAdReferrals("facebook:psid-1").length, 0);

  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  assert.equal(captureAdReferral(db, args).captured, true);
  assert.equal(captureAdReferral(db, args).captured, false, "event เดิมซ้ำต้องไม่ได้แถวที่สอง");
  const rows = db.listAdReferrals("facebook:psid-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ad_id, "120210000000000001");
  assert.equal(rows[0].source, "ADS");
  assert.equal(rows[0].type, "OPEN_THREAD");
  assert.equal(rows[0].ref, "qualified_msg_a");
  assert.equal(rows[0].event_kind, "message");
  assert.equal(rows[0].first_contact, 1);
  assert.equal(rows[0].referral_at, 1_790_000_000_000);
  assert.equal(rows[0].channel_id, "facebook");
  db.close();
});

test("captureAdReferral ไม่มีวัน throw — DB พังคืนผลพร้อมเหตุ ให้เส้นรับข้อความเดินต่อ", () => {
  const warnings = [];
  const brokenDb = {
    getSetting: () => "on",
    recordAdReferral() { throw new Error("disk I/O error"); },
  };
  const result = captureAdReferral(brokenDb, {
    event: { referral: adsReferral() }, customerId: "facebook:p", channelId: "facebook",
    logger: { warn: (line) => warnings.push(line) },
  });
  assert.equal(result.captured, false);
  assert.equal(result.reason, "error");
  assert.equal(warnings.length, 1);
  assert.equal(captureAdReferral(null, { event: { referral: adsReferral() } }).captured, false);
});
