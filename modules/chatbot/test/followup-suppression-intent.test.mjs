import assert from "node:assert/strict";
import test from "node:test";

import { classifyFollowupSuppression } from "../src/followupSuppression.mjs";

test("suppresses clear customer deferrals only", () => {
  assert.deepEqual(classifyFollowupSuppression("เดี๋ยวติดต่อกลับไปนะคะ"), { reason: "customer_will_return" });
  assert.deepEqual(classifyFollowupSuppression("คิดดูก่อนครับ"), { reason: "customer_considering" });
  assert.deepEqual(classifyFollowupSuppression("ขอคิดดูก่อนครับ"), { reason: "customer_considering" });
  assert.deepEqual(classifyFollowupSuppression("ขอพิจารณาก่อนค่ะ"), { reason: "customer_considering" });
  assert.deepEqual(classifyFollowupSuppression("I'll get back to you later."), { reason: "customer_will_return" });
  assert.deepEqual(classifyFollowupSuppression("Let me think about it."), { reason: "customer_considering" });
  assert.deepEqual(classifyFollowupSuppression("ผมขอคิดดูก่อนครับ"), { reason: "customer_considering" });
  assert.deepEqual(classifyFollowupSuppression("ครับ เดี๋ยวผมติดต่อกลับไป"), { reason: "customer_will_return" });
  assert.deepEqual(classifyFollowupSuppression("ค่ะ เดี๋ยวให้ทีมงานของผมโทรกลับ"), { reason: "colleague_will_contact" });
});

test("suppresses a customer's own colleague handoff and post-sale accounting document follow-up", () => {
  assert.deepEqual(classifyFollowupSuppression("ผมเป็น CEO เดี๋ยวให้ทีมงานทักมา"), { reason: "colleague_will_contact" });
  assert.deepEqual(classifyFollowupSuppression("เดี๋ยวให้ลูกน้องติดต่อกลับไปครับ"), { reason: "colleague_will_contact" });
  assert.deepEqual(classifyFollowupSuppression("เดี๋ยวให้ลูกน้องทักไป"), { reason: "colleague_will_contact" });
  assert.deepEqual(
    classifyFollowupSuppression("ผมอยู่ฝ่ายบัญชี เดี๋ยวตามเอกสารการชำระเงินที่ค้างไว้ให้"),
    { reason: "accounting_documents" },
  );
  assert.deepEqual(
    classifyFollowupSuppression("ฝ่ายบัญชีบริษัทผมจะตามใบเสร็จที่ชำระแล้วให้"),
    { reason: "accounting_documents" },
  );
});

test("returns null for ambiguous, quoted, negated, and still-active sales questions", () => {
  for (const text of [
    "ตัวอย่างลูกค้าพูดว่า เดี๋ยวติดต่อกลับไป",
    "ช่วยเขียนข้อความ newsletter ว่า unsubscribe แล้วจะติดต่อกลับ",
    "AI เอาไปใช้กับงานบัญชีและเอกสารได้อย่างไร",
    "อยากใช้ AI ตามเอกสาร",
    "มีสอนระบบติดตามเอกสารไหม",
    "ไม่ได้บอกว่าจะติดต่อกลับนะคะ",
    "ไม่ติดต่อกลับนะครับ",
    "รบกวนให้ทีมงานของคุณติดต่อกลับหาผม",
    "ขอให้ติดต่อกลับหน่อย",
    "เดี๋ยวให้ทีมงานของคุณติดต่อกลับ",
    "เพื่อนจะขอคิดดูก่อน",
    "ขอคิดดูก่อน แต่ช่วยบอกราคาก่อน",
    "ขอคิดดูก่อนค่ะ แล้วคอร์สนี้เรียนอะไรบ้าง?",
    "ขอใบเสนอราคาก่อนตัดสินใจได้ไหม",
    "ออกใบกำกับภาษีหรือใบรับรองได้ไหมครับ",
    "จ่ายเงินแล้ว ขอใบเสร็จด้วยครับ",
    "invoice นี้ใช้ก่อนซื้อได้ไหม",
    "CEO ในข่าวบอกว่าจะให้ทีมงานทักมา",
    "CEO ของบริษัทบอกว่าจะให้ทีมงานติดต่อ",
    "ผมอยากใช้ AI ทำบัญชีตามเอกสาร",
    "ฝ่ายบัญชีขอตามเอกสารใบเสนอราคาก่อนตัดสินใจ",
    "ตามเอกสารเดิม",
  ]) {
    assert.equal(classifyFollowupSuppression(text), null, text);
  }
});

// 28 ก.ย. 2026: ตรวจ ก.ย. พบลูกค้าที่ขอคิด/ขอตัดสินใจก่อนยังถูกทักตามใน 72 ชม. — ตัวจับเดิมรับเฉพาะข้อความที่
// "ขึ้นต้นด้วย" (ขอ)คิดดูก่อน/พิจารณาก่อน รูปที่ลูกค้าพิมพ์จริงบ่อยกว่า (ขอคิดก่อน · ขอตัดสินใจก่อน · ขอปรึกษาแฟนก่อน ·
// เดี๋ยวผมคิดอีกที · ต้องขอคิดดูก่อน · มีคำนำหน้า "ค่ะ/ตอนนี้") หลุดทั้งหมด (ประโยคสังเคราะห์)
test("suppresses the common Thai deferral forms that the anchored patterns missed", () => {
  for (const text of [
    "ขอคิดก่อนนะครับ",
    "ขอตัดสินใจก่อนครับ",
    "ขอตัดสินใจก่อนนะคะ เพราะราคาค่อนข้างสูง",
    "ขอเวลาตัดสินใจอีกหน่อยนะคะ",
    "ต้องขอคิดดูก่อนค่ะ เพราะราคาค่อนข้างสูงมาก",
    "ค่ะ ขอปรึกษาก่อนนะคะ",
    "ขอปรึกษาแฟนก่อนนะครับ",
    "ขอพิจารณาและคุยกับทีมก่อน แล้วแจ้งกลับค่ะ",
    "เดี๋ยวผมคิดอีกทีนะครับ",
    "เดี๋ยวผมตัดสินใจอีกทีแล้วแจ้งกลับนะครับ",
    "เดี๋ยวผมขอลองตัดสินใจก่อนนะครับ",
    "ตอนนี้ขอหาข้อมูลและตัดสินใจก่อนนะคะ",
    "ยังไม่สะดวกเรียนตอนนี้ ขอตัดสินใจก่อนครับ",
  ]) assert.deepEqual(classifyFollowupSuppression(text), { reason: "customer_considering" }, text);
});

test("the broadened deferral forms still ignore requests, questions, undecided statements and third parties", () => {
  for (const text of [
    "จะขอปรึกษาค่ะ",
    "ขอคำปรึกษาได้ไหมครับ",
    "ขอสอบถามให้ชัดเจนก่อนตัดสินใจค่ะ หากเรียนครบสองคลาสราคาเท่าไหร่",
    "ขอคิดก่อนนะคะ มีส่วนลดไหมคะ",
    "ยังไม่ได้ตัดสินใจเลยค่ะ",
    "ช่วยผมตัดสินใจหน่อย",
    "ตัดสินใจได้แล้วค่ะ จะสมัคร",
    "ขอปรึกษาทางทีมสักครู่",
    "กำลังคิดว่าจะใช้ AI ทำอะไรดี",
    "เพื่อนขอตัดสินใจก่อน",
    "ขอเช็คคิวก่อนนะคะ",
    "เดี๋ยวผมขอเช็กตารางกับปรึกษาแฟนก่อนนะครับ",
    // ผู้ตรวจโค้ด 28 ก.ย.: ลูกค้ากำลังซื้อแต่ขอเลือกตัวเลือกก่อน (กี่คน/รอบไหน/รุ่นไหน) หรือบอกว่าจะโอน/สมัครเลย
    // = ผู้ซื้อที่ยังเดินหน้า ห้ามหยุดติดตามถาวร (พฤติกรรมเดิมก่อนแก้)
    "ต้องคิดเลขก่อนว่าจะซื้อกี่คอร์สดีค่ะ เดี๋ยวแจ้งจำนวนคนนะคะ",
    "เดี๋ยวคิดก่อนนะคะว่าจะเอารุ่นไหน จะรีบแจ้งเลยค่ะ",
    "ต้องตัดสินใจก่อนว่าจะเรียนรอบเช้าหรือรอบบ่ายดีค่ะ แล้วจะโอนเลยนะคะ",
    "ขอคิดก่อนว่าจะพาน้องไปด้วยกี่คน แล้วจะจองเลยค่ะ",
    "เดี๋ยวขอตัดสินใจก่อนว่าจะเอาคลาสสดหรือออนไลน์ดี",
  ]) assert.equal(classifyFollowupSuppression(text), null, text);
});

test("normalizes Thai spacing and does not infer intent from history", () => {
  assert.deepEqual(classifyFollowupSuppression("เดี๋ยว   ติดต่อ กลับ ไป ค่ะ"), { reason: "customer_will_return" });
  assert.equal(
    classifyFollowupSuppression("จ่ายเงินแล้วครับ", { history: ["เดี๋ยวติดต่อกลับไป"] }),
    null,
  );
});

test("respects explicit unavailability, declined interest, and promises to return", () => {
  for (const text of [
    "ตอนนี้ยังไม่พร้อมค่ะ",
    "ยัง ๆ ค่ะ ช่วงนี้ยังไม่พร้อม",
    "ไม่สะดวกค่ะ ขอบคุณค่ะ",
    "ตอนนี้ทำงาน ไม่มีเวลาเลยค่ะ",
    "ช่วงนี้งานยุ่ง ยังไม่มีเวลาคุยครับ",
    "ยังไม่สนใจครับ ขอบคุณครับ",
    "ช่วงนี้ขอพักการคุยก่อนค่ะ",
    "ช่วงนี้หมอให้พักสายตาค่ะ",
    "ตอนนี้ยังดู ๆ อยู่ครับ ขอบคุณครับ",
    "ไม่ว่างครับ",
    "ติดงานอยู่ค่ะ",
    "ไม่สะดวกครับผม",
    "ไม่สะดวกคุยค่ะ",
    "ยังไม่สนใจครับผม",
    "ยัง ๆ ค่ะพี่ตอนนี้ยังไม่พร้อมค่ะ",
    "ตอนนี่ทำงานครับไม่มีเวลาเลยครับ",
    "กำลังพักอยู่ช่วงนี้หมอให้พักสายตาค่ะ",
    "ยังไม่สนใจครับ ขอพักเรื่องนี้ก่อน",
  ]) assert.deepEqual(classifyFollowupSuppression(text), { reason: "customer_considering" }, text);
  for (const text of [
    "พร้อมแล้วจะติดต่อเองค่ะ",
    "ถ้าพร้อมแล้วจะติดต่อเองครับ",
    "ยังไม่พร้อมค่ะ ไว้พร้อมแล้วจะติดต่อเอง",
    "พร้อมแล้วจะทักมาเองครับ",
    "สะดวกแล้วเดี๋ยวแจ้งไปค่ะ",
    "ยังไม่พร้อมค่ะ ไว้พร้อมแล้วจะติดต่อมาเอง",
    "ถ้าพร้อมจะทักมาเองค่ะ",
    "พร้อมแล้วจะทักเองค่ะ",
    "ไว้พร้อมแล้วจะทักเองค่ะ",
    "ทักเองค่ะ",
    "เดี๋ยวผมทักกลับเองครับ",
  ]) assert.deepEqual(classifyFollowupSuppression(text), { reason: "customer_will_return" }, text);
});

test("unavailability words do not close active requests or third-party examples", () => {
  for (const text of [
    "ยังไม่พร้อมเรียนสด ขอรายละเอียดออนไลน์ค่ะ",
    "ไม่สะดวกไปเรียนสด แต่อยากเรียนออนไลน์ค่ะ",
    "ยังไม่สนใจคลาสพื้นฐาน สนใจคลาสต่อยอดค่ะ",
    "ไม่สะดวกวันนี้ พรุ่งนี้โทรมาได้ไหมครับ",
    "ยังไม่พร้อมจ่ายเต็ม ขอแบ่งชำระได้ไหม",
    "ไม่มีเวลาเขียนโพสต์ อยากใช้ AI ช่วยค่ะ",
    "ลูกค้าของผมบอกว่ายังไม่พร้อม ผมควรตอบอย่างไร",
    "เพื่อนยังไม่พร้อม แต่ผมจะสมัครครับ",
    "ช่วยเขียนข้อความว่าไม่สะดวกให้หน่อย",
    "สมมติว่าลูกค้าไม่สะดวก จะให้ AI ตอบอย่างไร",
    "ไม่ได้บอกว่ายังไม่สนใจครับ",
    "พักสายตาระหว่างเรียนได้ไหม",
    "เครื่องยังไม่พร้อมใช้งานค่ะ",
    "ยังไม่พร้อมค่ะ แต่จะโอนจองก่อน",
    "ไม่มีเวลาเลยค่ะ อยากได้รายละเอียดคลาส",
    "เพื่อนบอกตอนนี้ยังไม่พร้อมค่ะ",
    "เครื่องตอนนี้ยังไม่พร้อมค่ะ",
    "ตอนนี้ยังไม่พร้อมค่ะ แต่สนใจเรียนออนไลน์",
    "ยังไม่สนใจครับ หมายถึงคลาสพื้นฐาน ผมอยากเรียนตัวต่อยอด",
    "ตอนนี้ไม่พร้อมค่ะ แต่โทรมาได้วันจันทร์",
    "ตอนนี้ไม่สะดวกค่ะ ช่วยโทรกลับบ่ายสอง",
    "ช่วงนี้ไม่ว่างครับ ติดต่อพรุ่งนี้ได้",
    "ตอนนี้ยังไม่สนใจครับ ส่งโปรมาได้",
    "แฟนตอนนี้ยังไม่พร้อมค่ะ",
    "หัวหน้าตอนนี้ยังไม่พร้อมค่ะ",
    "แม่ตอนนี้ยังไม่พร้อมค่ะ",
    "ทีมงานตอนนี้ยังไม่พร้อมค่ะ",
  ]) assert.equal(classifyFollowupSuppression(text), null, text);
});
