// persona-particles-softeners — ด่านคำลงท้ายผู้หญิง × PHRASE_SOFTENERS ของ humanizer
//
// รีวิวปรปักษ์รอบ 3 5 ต.ค.: ด่านเปลี่ยน "แน่นอนครับ" เป็น "แน่นอนค่ะ" ก่อน stripAiTells (ตั้งใจ ให้ข้อความ legacy
// โดนกฎเดียวกับข้อความของลูกแพร) แต่กฎลบ "แน่นอนค่ะ"/"ยินดีให้บริการค่ะ" เดิมจับกลางประโยคและกินวรรคถัดไป
// เปิดสวิตช์แล้ว "แน่นอนครับ" กลายเป็นข้อความว่าง (ลูกค้าไม่ได้คำตอบ) "ลูกแพรยินดีให้บริการครับ" เหลือ "ลูกแพร"
// และ "ไม่ได้ครับ เอ้ย แน่นอนค่ะ" เหลือ "ไม่ได้ค่ะ เอ้ยค่ะ" (ความหมายกลับด้าน)
// ทางแก้อยู่หลังสวิตช์เท่านั้น: ปิดสวิตช์ต้องเท่า a5005211 ทุกไบต์ (ทุกร้านที่ไม่ได้เปิด)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createHumanizer, stripAiTells } from "../src/humanizer.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const texts = (bubbles) => bubbles.map((bubble) => bubble.text);
const humanizeOnce = (femaleParticles, text) =>
  texts(createHumanizer({ femaleParticles, logger: silent }).humanize({ customerId: "soft", text }));

// [ข้อความจากโมเดล, ผลตอนปิดสวิตช์ (= a5005211 วัดจากสำเนา base), ผลตอนเปิดสวิตช์หลังแก้]
const ROWS = [
  ["แน่นอนครับ", ["แน่นอนครับ"], ["แน่นอนค่ะ"]],
  ["แน่นอนครับ!", ["แน่นอนครับ!"], ["แน่นอนค่ะ!"]],
  ["แน่นอนครับ 😊", ["แน่นอนครับ 😊"], ["แน่นอนค่ะ 😊"]],
  ["**แน่นอนครับ**", ["แน่นอนครับ"], ["แน่นอนค่ะ"]],
  ["ยินดีให้บริการครับ", ["ยินดีให้บริการครับ"], ["ยินดีให้บริการค่ะ"]],
  ["ยินดีให้บริการครับ 😊", ["ยินดีให้บริการครับ 😊"], ["ยินดีให้บริการค่ะ 😊"]],
  ["ลูกแพรยินดีให้บริการครับ", ["ลูกแพรยินดีให้บริการครับ"], ["ลูกแพรยินดีให้บริการค่ะ"]],
  ["ใช้ได้แน่นอนครับ ลองดูได้เลยครับ", ["ใช้ได้แน่นอนครับ ลองดูได้เลยครับ"], ["ใช้ได้แน่นอนค่ะ ลองดูได้เลยค่ะ"]],
  ["ได้แน่นอนครับ", ["ได้แน่นอนครับ"], ["ได้แน่นอนค่ะ"]],
  ["เรียนจบแล้วทำได้แน่นอนครับ", ["เรียนจบแล้วทำได้แน่นอนครับ"], ["เรียนจบแล้วทำได้แน่นอนค่ะ"]],
  // คำเปิด/ปิดแบบผู้ช่วย AI ที่ยืนเป็นประโยคเอง ยังโดนตัดเหมือนเดิม (เจตนาเดิมของกฎ)
  ["แน่นอนครับ คลาสนี้มีเวิร์กช็อปค่ะ", ["แน่นอนครับ คลาสนี้มีเวิร์กช็อปค่ะ"], ["คลาสนี้มีเวิร์กช็อปค่ะ"]],
  ["แน่นอนค่ะ! เรียนออนไลน์ได้เลยค่ะ", ["เรียนออนไลน์ได้เลยค่ะ"], ["เรียนออนไลน์ได้เลยค่ะ"]],
  ["ขอบคุณที่ทักมานะคะ ยินดีให้บริการค่ะ", ["ขอบคุณที่ทักมานะคะ"], ["ขอบคุณที่ทักมานะคะ"]],
  ["ได้ค่ะ\nแน่นอนค่ะ\nเดี๋ยวส่งรายละเอียดให้นะคะ", ["ได้ค่ะ\nเดี๋ยวส่งรายละเอียดให้นะคะ"], ["ได้ค่ะ\nเดี๋ยวส่งรายละเอียดให้นะคะ"]],
  // คำที่ติดคำหน้า (ไม่ได้ยืนเอง) ห้ามตัด — เดิมเหลือ "ลูกแพร😊" · การแตกบอลลูนเท่ากับ
  // "สวัสดีค่ะ ลูกแพรยินดีช่วยเหลือค่ะ 😊 สนใจคลาสไหนคะ" ตอนปิดสวิตช์ (พฤติกรรมเดิมของ humanizer)
  ["สวัสดีค่ะ ลูกแพรยินดีให้บริการค่ะ 😊 สนใจคลาสไหนคะ", ["สวัสดีค่ะ", "ลูกแพร😊 สนใจคลาสไหนคะ?"], ["สวัสดีค่ะ ลูกแพรยินดีให้บริการค่ะ", "😊 สนใจคลาสไหนคะ?"]],
  // คู่แก้คำผิด: ห้ามตัดฝั่งไหนของคู่ ไม่งั้นคำแก้หาย ("ไม่ได้ค่ะ เอ้ยค่ะ" = ความหมายกลับด้าน)
  ["ไม่ได้ครับ เอ้ย แน่นอนค่ะ", ["ไม่ได้ครับ เอ้ยค่ะ"], ["ไม่ได้ค่ะ เอ้ย แน่นอนค่ะ"]],
  ["แน่นอนครับ เอ้ย ไม่ได้ค่ะ", ["แน่นอนครับ เอ้ย ไม่ได้ค่ะ"], ["แน่นอนค่ะ เอ้ย ไม่ได้ค่ะ"]],
  ["ยินดีให้บริการครับ เอ่อ บริการค่ะ", ["ยินดีให้บริการครับ เอ่อ บริการค่ะ"], ["ยินดีให้บริการค่ะ เอ่อ บริการค่ะ"]],
  // ทั้งข้อความเหลือแต่คำที่ถูกตัด = เก็บข้อความไว้ (ลูกค้าเจอความเงียบแย่กว่าคำเปิดแบบ AI)
  ["แน่นอนค่ะ", [], ["แน่นอนค่ะ"]],
  ["ยินดีให้บริการค่ะ 😊", ["😊"], ["ยินดีให้บริการค่ะ 😊"]],
];

test("รีวิวปรปักษ์รอบ 3 5 ต.ค.: เปิดสวิตช์แล้ว PHRASE_SOFTENERS ไม่ทำให้คำตอบว่าง/ขาดกลางคำ/คำแก้หาย", () => {
  for (const [input, , expectedOn] of ROWS) {
    assert.deepEqual(humanizeOnce(true, input), expectedOn, input);
  }
});

test("รีวิวปรปักษ์รอบ 3 5 ต.ค.: ปิดสวิตช์ = ผลเดิมของ a5005211 ทุกแถว (รวมแถวที่เดิมพังเอง)", () => {
  for (const [input, expectedOff] of ROWS) {
    assert.deepEqual(humanizeOnce(false, input), expectedOff, input);
    assert.deepEqual(texts(createHumanizer().humanize({ customerId: "soft", text: input })), expectedOff, `default ${input}`);
  }
  // stripAiTells ที่ export ออกไปเรียกแบบเดิม (ไม่ส่งตัวเลือก) ต้องตัดแบบเดิมทุกตัวอักษร
  assert.equal(stripAiTells("ใช้ได้แน่นอนค่ะ ลองดูได้เลยค่ะ"), "ใช้ได้ลองดูได้เลยค่ะ");
  assert.equal(stripAiTells("แน่นอนค่ะ"), "");
});

test("รีวิวปรปักษ์รอบ 3 5 ต.ค.: ตัวเลือก tellPhrases ของ stripAiTells — standalone/keep ไม่แตะกฎ softener ตัวอื่น", () => {
  const draft = "กรุณารอสักครู่ แน่นอนค่ะ หากมีข้อสงสัยเพิ่มเติมทักได้ค่ะ";
  assert.equal(stripAiTells(draft, { tellPhrases: "standalone" }), "รบกวนรอสักครู่ ถ้าติดตรงไหนทักได้ค่ะ");
  assert.equal(stripAiTells(draft, { tellPhrases: "keep" }), "รบกวนรอสักครู่ แน่นอนค่ะ ถ้าติดตรงไหนทักได้ค่ะ");
  assert.equal(stripAiTells(draft), stripAiTells(draft, { tellPhrases: "anywhere" }));
});

test("รีวิวปรปักษ์รอบ 3 5 ต.ค.: PERSONA_PARTICLES=female + โมเดลตอบ 'แน่นอนครับ' = ส่งถึงลูกค้า ไม่ใช่ empty_after_humanize", async () => {
  for (const [env, expected] of [[{ PERSONA_PARTICLES: "female" }, "แน่นอนค่ะ"], [{}, "แน่นอนครับ"]]) {
    const db = memoryDb();
    db.setApprovedPrice("ราคา-2500", 2500);
    const lineFetch = lineFetchStub();
    const app = createApp({
      config: testConfig(env), db, logger: silent,
      overrides: { hermesFetch: hermesFetchStub("แน่นอนครับ"), lineFetch, sleep: async () => {} },
    });
    const result = await app.pipeline.handleInboundText({ customerId: "U-soft", text: "เรียนออนไลน์ได้ไหมคะ", replyToken: "rt" });
    assert.equal(result.sent, true, JSON.stringify(result));
    const sent = lineFetch.sends.flatMap((call) => (call.body?.messages || []).map((message) => message.text || ""));
    assert.deepEqual(sent, [expected]);
    db.close();
  }
});
