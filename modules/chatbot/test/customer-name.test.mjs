// v1.4.8 — การ์ดชื่อบุคคลที่สาม (เคสคุณมนตรี 2026-08-16)
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractKnownName, nameLooksThirdParty, addressableCustomerName, customerAddressLabel,
} from "../src/customerName.mjs";

/* ---------------- v1.4.8 (เคสคุณมนตรี 2026-08-16): ชื่อบุคคลที่สาม ---------------- */

test("v1.4.8: nameLooksThirdParty — ชื่อคนที่ถูกส่งมาเรียน/ทีมงาน/คำนำหน้า = บุคคลที่สาม", () => {
  assert.equal(nameLooksThirdParty("มนตรี", "จะส่งทีมงานมาเรียนครับ\nชื่อมนตรีครับ"), true, "ทีมงาน+ชื่อ = คนอื่น");
  assert.equal(nameLooksThirdParty("มนตรี", "ให้คุณมนตรีมาเรียนแทนครับ"), true);
  assert.equal(nameLooksThirdParty("คุณมนตรี", "อะไรก็ได้"), true, "คนไม่เรียกตัวเองว่า คุณX");
  assert.equal(nameLooksThirdParty("แดง", "ภรรยาผมชื่อแดงครับ"), true);
  assert.equal(nameLooksThirdParty("สมชาย", "ผมชื่อสมชายครับ สนใจคลาสครับ"), false, "แนะนำตัวเองปกติต้องผ่าน");
  assert.equal(nameLooksThirdParty("ฝน", "ชื่อฝนค่ะ"), false);
});

test("v1.4.8: extractKnownName — สรรพนามต้องอยู่ต้นคำ (ภรรยาผมชื่อแดง ห้ามจับ)", () => {
  assert.equal(extractKnownName("ภรรยาผมชื่อแดงครับ"), "", "ผมชื่อ กลางคำ = บุคคลที่สาม");
  assert.equal(extractKnownName("หัวหน้าเราชื่อสมชาย"), "", "เราชื่อ กลางคำ — และ 'เรา' ไม่ใช่ตัวจับแล้ว");
  assert.equal(extractKnownName("ผมชื่อสมชายครับ"), "สมชาย", "แนะนำตัวปกติยังจับได้");
});

/* ------- 31 ส.ค. 2026: ลูกค้าพิมพ์คำถามขึ้นต้นด้วย "ชื่อ" แล้วโดนใช้เป็นชื่อเรียก -------
 * ของจริงบน Facebook: ลูกค้าพิมพ์ "ชื่อต่ออะไรไแอีกนอกจากline oa" (พิมพ์ผิด ตั้งใจถามว่า
 * คลาสต่ออะไรได้อีกนอกจาก LINE OA) ตัวจับอ่านว่าเป็นการบอกชื่อ แล้วบอทเรียกลูกค้าว่า
 * "คุณต่ออะไรไแอีกนอกจากline oa" ไป 8 ครั้งในดีลจริง
 *
 * มีสองรูรั่วต่อกัน: (1) ตัวจับยอมรับข้อความ 25 ตัวอักษรที่ไม่เหมือนชื่อคน
 * (2) addressableCustomerName เชื่อ known_name แบบไม่ตรวจอะไรเลย ทั้งที่ชื่อจากโปรไฟล์
 * ต้องผ่านด่าน 5 ชั้น — ด่านนั้นต้องครอบ known_name ด้วย เพราะมันคือด่านสุดท้ายก่อนพูดกับลูกค้า
 */
const REAL_CASE = "ต่ออะไรไแอีกนอกจากline oa";

test("ประโยคที่ขึ้นต้นด้วย 'ชื่อ' แต่ไม่ใช่การบอกชื่อ ต้องไม่ถูกเก็บเป็นชื่อ", () => {
  assert.equal(extractKnownName(`ชื่อ${REAL_CASE}`), "", "เคสจริง 31 ส.ค. — คำถามยาว ไม่ใช่ชื่อคน");
  assert.equal(extractKnownName("ชื่อคลาสนี้เรียนกี่วันครับ"), "", "คำถามที่ขึ้นต้นด้วย ชื่อ ก็ไม่ใช่ชื่อ");
  assert.equal(extractKnownName("ชื่อฝนค่ะ"), "ฝน", "การบอกชื่อจริงต้องยังจับได้เหมือนเดิม");
  assert.equal(extractKnownName("ผมชื่อสมชายครับ"), "สมชาย");
});

test("known_name ที่ไม่เหมือนชื่อคน ต้องตกเป็น 'คุณลูกค้า' ไม่ใช่เอาไปเรียกตรง ๆ", () => {
  assert.equal(customerAddressLabel({ knownName: REAL_CASE }), "คุณลูกค้า", "เคสจริง 31 ส.ค.");
  assert.equal(customerAddressLabel({ knownName: "ร้านเสื้อผ้าออนไลน์" }), "คุณลูกค้า", "ชื่อร้านไม่ใช่ชื่อคน");
  assert.equal(customerAddressLabel({ knownName: "0812345678" }), "คุณลูกค้า", "เบอร์โทรไม่ใช่ชื่อ");
  assert.equal(customerAddressLabel({ knownName: "สนใจคลาส AI Agent for Business" }), "คุณลูกค้า", "ประโยคยาว");
});

test("known_name ที่ใช้ได้จริงต้องไม่พัง (ชื่อที่แอดมินตั้งเอง/ลูกค้าบอกเอง)", () => {
  assert.equal(customerAddressLabel({ knownName: "ใบเตย" }), "คุณใบเตย");
  // 2026-09-28 (audit ก.ย. §4.2): ชื่อ-นามสกุลเต็มคือเสียงของระบบ CRM — เรียกชื่อต้นคำเดียวเท่านั้น
  assert.equal(customerAddressLabel({ knownName: "Nongnuch Poonark" }), "คุณNongnuch", "ชื่ออังกฤษที่แอดมินตั้ง: ตัดนามสกุล");
  assert.equal(customerAddressLabel({ knownName: "Amarit Klonmjit" }), "คุณAmarit");
  assert.equal(customerAddressLabel({ knownName: "พี่เบียร์" }), "พี่เบียร์", "มีคำนำหน้าแล้วห้ามเติม คุณ ซ้ำ");
});

test("คำนำหน้าสั้น อา ต้องมีวรรคคั่น ไม่ให้กลืนชื่อที่บังเอิญขึ้นต้นเหมือนกัน", () => {
  for (const name of ["อาท", "อาร์ต", "อารีย์"]) {
    assert.equal(customerAddressLabel({ knownName: name }), `คุณ${name}`, `${name} คือชื่อ ไม่ใช่คำนำหน้า`);
  }
  assert.equal(customerAddressLabel({ knownName: "อา แดง" }), "อา แดง");
  // 2026-09-28 (audit ก.ย. §4.2 — คำสั่งให้ตัด นาย/นาง/นางสาว/ดร./Mr.): คำนำหน้าทางการไม่ใช่คำเรียกคน
  // เดิมคงไว้เป็น "นายสมชาย" ซึ่งอ่านเหมือนหนังสือราชการ — ตอนนี้ตัดแล้วเรียก "คุณ" + ชื่อต้น
  assert.equal(customerAddressLabel({ knownName: "นายสมชาย" }), "คุณสมชาย", "คำนำหน้าทางการถูกตัด");
  assert.equal(customerAddressLabel({ knownName: "คุณสมชาย" }), "คุณสมชาย");
  assert.equal(customerAddressLabel({ knownName: "พี่เบียร์" }), "พี่เบียร์");
  assert.equal(customerAddressLabel({ knownName: "อาจารย์แดง" }), "อาจารย์แดง");
});

test("known_name ที่ใช้ไม่ได้ ต้องตกไปใช้ชื่อโปรไฟล์ ไม่ใช่ข้ามไป 'คุณลูกค้า' เลย", () => {
  assert.equal(
    addressableCustomerName({ knownName: REAL_CASE, displayName: "Somchai Jaidee" }),
    "Somchai Jaidee",
    "ชื่อที่จับมาผิดต้องหลีกทางให้ชื่อโปรไฟล์ที่ใช้ได้"
  );
  assert.equal(addressableCustomerName({ knownName: REAL_CASE, displayName: "" }), "");
});
