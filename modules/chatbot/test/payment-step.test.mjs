// ขั้นชำระเงินที่ระบบประกอบเอง (audit ลูกแพร 18 ต.ค. 2026) — ตรรกะบริสุทธิ์ของ paymentStep.mjs
// ถ้อยคำลูกค้า/ร้านมาจากรูปแบบแชทจริงช่วง ส.ค.–ต.ค. (ปิดชื่อ) · เลขบัญชีในการ์ดเป็นเลขสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import {
  DOC_TYPE_QUESTION, botAskedDocType, classifyDocTypeAnswer, composePaymentMessage, extractPaymentKit, hasOtherAsk,
  mentionsRound, paymentAlreadyDelivered, planPaymentStep, readPin, resolvePaymentOffer, stripPaymentInstructions,
} from "../src/paymentStep.mjs";
import { checkPriceBeforeBank, paymentInstructionsIndex } from "../src/salesDecisionGuard.mjs";

import { AMOUNTS, CLOSING_CARD, COURSES, PRICES, ROUNDS } from "./paymentStepFixture.mjs";

const kit = extractPaymentKit([{ title: "อื่น ๆ", content: "ไม่มีบัญชี" }, CLOSING_CARD]);
const user = (content) => ({ role: "user", content });
const bot = (content) => ({ role: "assistant", content });
const QUOTE = "📌 AI Agent for Business\nราคาปกติ 19,900 บาท\nโปรโมชั่น Early Bird 12,900 บาท/ท่าน";
const plan = (overrides = {}) => planPaymentStep({ kit, courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS, ...overrides });

test("ชุดชำระเงินอ่านจากการ์ดของเจ้าของ: บล็อกบัญชี + ฟอร์มตามตัวอักษร + รูปช่องทางชำระ (ไม่เอาบรรทัดคำสั่งถึงโมเดล)", () => {
  assert.ok(kit);
  assert.equal(kit.bank, "สามารถโอนชำระได้ที่บัญชีนี้นะคะ\n\nธนาคาร : กสิกรไทย\nเลขที่บัญชี : 000-0-00000-0\nชื่อบัญชี : บจก. ตัวอย่าง");
  assert.match(kit.form, /^แจ้งโอนแล้ว ลูกแพรขออนุญาตรบกวน ขอข้อมูลเพิ่มเติมนะคะ\n\n🖋️ ข้อมูลลงทะเบียน\n\n- ชื่อ-นามสกุล\* :/u);
  assert.match(kit.form, /ขอบพระคุณมากค่ะ 🙏🏻😊$/u);
  assert.doesNotMatch(kit.form, /ตามตัวอักษร|บอลลูน/u);
  assert.equal(kit.imageKey, "payment-kbank");
});

test("การ์ดไม่ครบ (ไม่มีเลขบัญชีจริง/ไม่มีฟอร์ม) = ไม่มีชุด = ตัวประกอบไม่ทำงาน", () => {
  assert.equal(extractPaymentKit([{ title: "ขั้นตอนปิดการขาย", content: "(เลขที่บัญชีธนาคาร ตัดออกจากไฟล์นี้ — ส่งต่อทีมงาน)" }]), null);
  assert.equal(extractPaymentKit([{ title: "ขั้นตอนปิดการขาย", content: CLOSING_CARD.content.split("แจ้งโอนแล้ว")[0] }]), null);
  assert.equal(plan({ kit: null, text: "บุคคลธรรมดาค่ะ", history: [bot(DOC_TYPE_QUESTION)] }).action, "none");
});

test("คำถามประเภทเอกสารของร้าน: ถ้อยคำที่ใช้จริงทุกแบบ", () => {
  for (const asked of [
    "ต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?",
    "ก่อนส่งข้อมูลชำระเงิน ต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?",
    "สำหรับเอกสารค่าเรียน VDO ลูกแพรขอใช้ชื่อบุคคลหรือชื่อบริษัทดีคะ?",
    "ต้องการออกใบกำกับภาษีในนามบริษัท หรือ บุคคลธรรมดาคะ",
    "ได้เลยค่ะ รบกวนส่งข้อมูลบริษัทสำหรับออกเอกสารตามนี้นะคะ\n\nชื่อนิติบุคคล\nสำนักงานใหญ่ หรือสาขา",
  ]) assert.equal(botAskedDocType([user("สมัครค่ะ"), bot(asked)]), true, asked);
  assert.equal(botAskedDocType([bot(DOC_TYPE_QUESTION), user("ขอคิดก่อน"), bot("ได้เลยค่ะ")]), false, "คำถามเก่าที่ลูกค้าตอบไปแล้วไม่นับ");
  assert.equal(botAskedDocType([bot("บริษัทหรือบุคคลทั่วไปก็เรียนได้ค่ะ")]), false);
});

test("คำตอบประเภทเอกสาร: บุคคล/บริษัท/กำกวม/ยกเลิก", () => {
  for (const said of ["บุคคลธรรมดา", "บุคคลธรรมดาค่ะ", "นามบุคคลค่ะ", "เดี๋ยวเอาเป็นชื่อบุคคลธรรมดาก็ได้ครับ", "ส่วนตัวค่ะ", "บุคคลครับ"]) {
    assert.equal(classifyDocTypeAnswer(said), "person", said);
  }
  for (const said of ["บริษัทครับ", "นามบริษัทค่ะ", "ออกบริษัทใบกำกับได้ใช่ไหมคะ", "นิติบุคคลครับ บริษัท ตัวอย่าง จำกัด"]) {
    assert.equal(classifyDocTypeAnswer(said), "company", said);
  }
  for (const said of ["ไม่", "ยกเลิก", "ออกให้ด้วยครับ", "บุคคลธรรมดากับบริษัทต่างกันยังไงคะ", "ขอคิดก่อนนะคะ", "ขอรายละเอียดคอร์สค่า"]) {
    assert.equal(classifyDocTypeAnswer(said), null, said);
  }
  assert.equal(classifyDocTypeAnswer("บุคคลค่ะ\nรอบ 12 กย ค่ะ"), "person", "อ่านทีละบรรทัด");
  assert.equal(classifyDocTypeAnswer("ไม่ต้องออกเอกสารครับ เป็นการเรียนส่วนตัว"), "none");
});

test("คำถามอื่นที่พ่วงมา: ราคา/วิธีโอน/เอกสาร ข้อความชุดนี้ตอบเอง · รายละเอียดคอร์ส/ภาษี/ผ่อน ต้องให้โมเดลตอบก่อน", () => {
  assert.equal(hasOtherAsk(["นามบุคคลค่ะ", "ค่าเรียนเท่าไหร่คะ"]), false);
  assert.equal(hasOtherAsk(["ออกบริษัทใบกำกับได้ใช่ไหมคะ"]), false);
  assert.equal(hasOtherAsk(["โอนได้เลยไหมคะ"]), false);
  assert.equal(hasOtherAsk(["ขอรายละเอียดคอร์สได้ไหมครับ", "นามบริษัทครับ"]), true);
  assert.equal(hasOtherAsk(["บริษัทค่ะ หัก ณ ที่จ่ายได้ไหมคะ"]), true);
  assert.equal(hasOtherAsk(["บุคคลธรรมดา ผ่อนบัตรได้ไหม"]), true);
  assert.equal(hasOtherAsk(["บุคคลธรรมดา เรียนที่ไหนนะคะ"]), true);
});

test("ลูกค้าตอบบุคคลธรรมดาหลังถูกถาม = ข้อความเดียว: สรุปคลาส รอบ ค่าเรียนที่ห้องได้ + บัญชี + รูป + ฟอร์ม", () => {
  const history = [user("สอบถามคอร์สและราคา"), bot(QUOTE), user("14 พย"), bot("ได้เลยค่ะ รอบที่เลือกคือวันเสาร์ 14 พ.ย."), user("ส่งมาเลยจ้า"),
    bot("รายละเอียดครบดังนี้ค่ะ"), bot(DOC_TYPE_QUESTION)];
  const result = plan({ text: "บุคคลธรรมดาค่ะ", history });
  assert.equal(result.action, "compose");
  const [summary, bank, form, extra] = result.message.bubbles;
  assert.equal(summary, "ได้เลยค่ะ ลูกแพรสรุปรายละเอียดการสมัครให้นะคะ\n\nคลาส : AI Agent for Business\nรอบ : เสาร์ 14 พ.ย. 2026\nค่าเรียน : 12,900 บาท/ท่าน\nออกเอกสารในนาม : บุคคลธรรมดา");
  assert.equal(bank, kit.bank);
  assert.equal(form, kit.form);
  assert.equal(extra, undefined, "บุคคลธรรมดาไม่ต้องขอเอกสารเพิ่ม");
  assert.equal(result.message.imageAfter, 2, "รูปช่องทางชำระวางต่อจากบล็อกบัญชี");
  assert.match(result.message.text, /\[IMAGE:payment-kbank\]/u);
  const self = checkPriceBeforeBank({ text: result.message.text, approvedAmounts: AMOUNTS, approvedPrices: PRICES, courses: COURSES, latestText: "บุคคลธรรมดาค่ะ", history });
  assert.equal(self.ok, true);
  assert.equal(self.bank, true);
});

test("ข้อความชุดนี้ไม่เร่งโอน ไม่พูดภาษี/ผ่อน/บัตร ไม่ยืนยันที่นั่ง และไม่มียอดรวมที่คำนวณเอง", () => {
  const result = plan({ text: "บุคคลธรรมดา", history: [bot(QUOTE), bot(DOC_TYPE_QUESTION)] });
  assert.equal(result.action, "compose");
  const text = result.message.bubbles.join("\n");
  assert.doesNotMatch(text, /ด่วน|รีบ|ภายใน|วันนี้|ก่อนเต็ม|เหลือ\s*\d+\s*ที่|ภาษี|vat|ผ่อน|บัตร|หัก ณ|ยืนยันที่นั่ง|รวมทั้งสิ้น|ยอดรวม/iu);
});

test("บริษัท: บอกว่าออกในนามบริษัทได้ + ขอข้อมูลบริษัทต่อท้าย (ข้ามถ้าลูกค้าส่งข้อมูลมาแล้ว)", () => {
  const history = [bot(QUOTE), bot("ต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?")];
  const first = plan({ text: "ออกบริษัทใบกำกับได้ใช่ไหมคะ", history });
  assert.equal(first.action, "compose");
  assert.match(first.message.bubbles[0], /^ได้เลยค่ะ ออกเอกสารในนามบริษัทได้ค่ะ/u);
  assert.match(first.message.bubbles[0], /ออกเอกสารในนาม : บริษัท$/u);
  assert.match(first.message.bubbles[3], /ชื่อนิติบุคคล สำนักงานใหญ่หรือสาขาเลขที่/u);
  const withDetails = plan({ text: "นิติบุคคลครับ บริษัท ตัวอย่าง จำกัด เลขที่นิติบุคคล 0105555555555", history });
  assert.equal(withDetails.action, "compose");
  assert.equal(withDetails.message.bubbles.length, 3);
});

test("ค่าเรียนคือราคาที่ห้องนี้ได้จริง: ราคานักเรียนเก่าที่ทีมเสนอไว้ชนะราคาฐาน · ไม่มีราคาในห้อง = ราคาฐานแถวเดียว", () => {
  const relearn = resolvePaymentOffer({ latestText: "บุคคลธรรมดา", courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS,
    history: [user("เคยเรียน business แล้ว สนใจ AI Agent Workflow Automation"), bot("คลาส AI Agent Workflow Automation สำหรับนักเรียนเก่าลดเหลือ 12,900.- / ท่าน ค่ะ")] });
  assert.equal(relearn.ok, true);
  assert.equal(relearn.amount, 12900);
  assert.equal(relearn.displayName, "AI Agent Workflow Automation");
  assert.equal(relearn.priceSource, "quoted");
  const base = resolvePaymentOffer({ latestText: "บุคคลธรรมดา", courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS,
    history: [user("สนใจ AI Agent for Business ค่ะ"), bot(DOC_TYPE_QUESTION)] });
  assert.equal(base.ok, true);
  assert.equal(base.amount, 12900);
  assert.equal(base.priceSource, "approved_base");
  const twoQuoted = resolvePaymentOffer({ latestText: "บุคคลธรรมดา", courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS,
    history: [bot("AI Agent for Business Early Bird 12,900 บาท/ท่าน มา 2 ท่านขึ้นไปเหลือ 11,900 บาท/ท่าน")] });
  assert.equal(twoQuoted.amount, 12900, "คนเดียว = ราคาฐาน ไม่ใช่ราคากลุ่ม");
});

test("ไม่ต้องออกเอกสาร = ส่งชุดเดียวกันโดยไม่มีบรรทัดออกเอกสาร · ข้อมูลบริษัท (เลขที่ผู้เสียภาษี) ไม่ใช่คำถามภาษี · ขอใบเสนอราคา = ทีมทำ", () => {
  const none = plan({ text: "ไม่ต้องออกเอกสารครับ", history: [bot(QUOTE), bot(DOC_TYPE_QUESTION)] });
  assert.equal(none.action, "compose");
  assert.doesNotMatch(none.message.bubbles[0], /ออกเอกสารในนาม/u);
  const details = plan({ text: "บริษัท ตัวอย่าง จำกัด (สำนักงานใหญ่)\nเลขที่ผู้เสียภาษี 0105555555555", history: [bot(QUOTE), bot("รบกวนส่งชื่อนิติบุคคล สำนักงานใหญ่หรือสาขา สำหรับออกเอกสารในนามบริษัทค่ะ")] });
  assert.equal(details.action, "compose");
  assert.equal(details.message.bubbles.length, 3, "ส่งข้อมูลบริษัทมาแล้ว ไม่ขอซ้ำ");
  const quote = plan({ text: "บริษัทครับ ขอใบเสนอราคาก่อนครับ", history: [bot(QUOTE), bot(DOC_TYPE_QUESTION)] });
  assert.deepEqual([quote.action, quote.reason, quote.manual], ["pin", "quotation_requested", true]);
});

test("คลาสที่คุยล่าสุดของร้าน + ราคาไม่เอ่ยชื่อคลาส (\"คลาสนี้ … 12,900.-\") = ราคาของคลาสนั้น · ราคาล่าสุดเป็นของอย่างอื่น (ออนไลน์) = ไม่ย้อนไปหยิบราคาเก่า", () => {
  const offer = (history, latestText = "บุคคลธรรมดา") => resolvePaymentOffer({ latestText, history, courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS });
  const talked = offer([bot("คุณลูกค้าเหมาะกับคลาส AI Agent for Business ค่ะ"), user("ค่าเรียนเท่าไหร่ครับ"),
    bot("คลาสนี้ ปกติ 19,900 บาท/ท่าน\nPROMOTION Early Bird ลดเหลือ เพียง 12,900.- / ท่าน ค่ะ\nรวมคลาสออนไลน์ทบทวนไม่จำกัดเวลา"), bot(DOC_TYPE_QUESTION)]);
  assert.equal(talked.ok, true);
  assert.equal(talked.amount, 12900);
  const pivot = offer([bot(QUOTE), user("มีแบบออนไลน์ไหม"), bot("คลาสออนไลน์ VDO on demand ราคา 4,900 บาทค่ะ"), bot(DOC_TYPE_QUESTION)]);
  assert.equal(pivot.ok, false);
  const pricesWithOnline = [...PRICES, { label: "Online Custom GPTs — Early Bird", amount: 4900 }];
  const mismatch = resolvePaymentOffer({ latestText: "บุคคลธรรมดา", courses: COURSES, approvedPrices: pricesWithOnline, approvedAmounts: new Set(pricesWithOnline.map((r) => r.amount)), rounds: ROUNDS,
    history: [user("สนใจ AI Agent for Business"), bot(QUOTE), bot("อีกแบบคือวิดีโอ 4,900 บาทค่ะ"), bot(DOC_TYPE_QUESTION)] });
  assert.equal(mismatch.reason, "price_mismatch");
});

test("ลูกค้าถาม \"มีออนไลน์ไหม\" แล้วเลือกวันรอบสอนสดเอง = คลาสของรอบนั้น (แชทจริง ก.ย.: \"เรียนสดหรือออนไลน์คะ\" → \"รอบ12กยค่ะ\")", () => {
  const result = resolvePaymentOffer({ latestText: "บริษัทค่ะ", courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS,
    history: [user("สนใจคลาส ai agent ค่ะ"), bot(QUOTE), user("อันนี้เรียนสดหรือออนไลน์คะ"), bot("เป็นคลาสเรียนสดค่ะ มีรอบ 14 และ 21 พ.ย."), user("รอบ 21 พย ค่ะ"), bot(DOC_TYPE_QUESTION)] });
  assert.equal(result.ok, true);
  assert.equal(result.displayName, "AI Agent for Business");
  assert.equal(result.round.date, "2026-11-21");
  assert.equal(hasOtherAsk(["ในคลาส max กี่คน คะ"]), true, "กี่คน = คำถาม · กี่บาท = คำถามราคาที่ข้อความชุดนี้ตอบเอง");
  assert.equal(hasOtherAsk(["กี่บาทคะ"]), false);
});

test("รอบ: \"12 ค่ะ\" ตอบคำถาม 12/9 หรือ 19/9 (แชทจริง ก.ย.) · ลูกค้าเลือกเองชนะ · ร้านยืนยันคนละรอบ = ให้คนตัดสิน · ประโยคแนะนำรอบไม่ใช่การเลือก", () => {
  const offer = (history, latestText = "บุคคลธรรมดาค่ะ") => resolvePaymentOffer({ latestText, history, courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS });
  const dayOnly = offer([bot(QUOTE), bot("สนใจคลาสเรียนรอบวันที่ 14/11 หรือ 21/11 ดีคะ"), user("21 ค่ะ"), bot(DOC_TYPE_QUESTION)]);
  assert.equal(dayOnly.round.date, "2026-11-21");
  const restated = offer([user("ขอรอบ 14 พย"), bot(QUOTE), user("เปลี่ยนเป็นรอบหลังได้ไหม"), bot("ได้ค่ะ รอบวันเสาร์ที่ 21 พ.ย. 2026 สำหรับ 1 ท่านค่ะ"), bot(DOC_TYPE_QUESTION)]);
  assert.equal(restated.reason, "round_conflict", "ลูกค้าพิมพ์ 14 แต่ร้านยืนยัน 21 = ไม่เดา");
  const customerWins = offer([bot(QUOTE), user("ขอรอบ 14 พย ค่ะ"), bot("ได้ค่ะ มีรอบ 21 พ.ย. ด้วยนะคะ"), bot(DOC_TYPE_QUESTION)]);
  assert.equal(customerWins.round.date, "2026-11-14");
  const suggestion = offer([bot(QUOTE), bot("รอบใกล้สุดคือ 14 พ.ย. ค่ะ"), bot(DOC_TYPE_QUESTION)]);
  assert.equal(suggestion.round, null, "ร้านแนะนำรอบ ≠ ลูกค้าเลือก → ให้เลือกในข้อความ");
  assert.equal(offer([bot(QUOTE), user("12 ค่ะ"), bot(DOC_TYPE_QUESTION)]).round, null, "วันเดี่ยว ๆ ที่ร้านไม่ได้เสนอ = ไม่เดา");
});

test("ข้อความยาวที่เล่าเรื่องงานไม่นับเป็นคำตอบประเภทเอกสาร (แชทจริง 29 ก.ย. \"โครงการส่วนบุคคล\")", () => {
  assert.equal(classifyDocTypeAnswer("ตอนนี้โครงการนี้ผมยังพัฒนาในลักษณะ โครงการส่วนบุคคลครับ ใช้ทุนทรัพย์ส่วนตัวในการทำ แต่โจทย์มาจากบริษัทที่ผมทำงานอยู่"), null);
  assert.equal(classifyDocTypeAnswer("บริษัท ตัวอย่าง จำกัด (สำนักงานใหญ่) 99/1 หมู่ 14 ถนนบางนา-ตราด ตำบลบางพลีใหญ่ อำเภอบางพลี สมุทรปราการ 10540"), "company");
});

test("ข้อมูลไม่พอหรือกำกวม = ไม่ประกอบเอง (ต้องให้คน): หลายที่นั่ง · ขอใบเสนอราคา · หลายคลาส · คลาสออนไลน์ · รอบเต็ม", () => {
  const offer = (latestText, history) => resolvePaymentOffer({ latestText, history, courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS });
  assert.equal(offer("บุคคลธรรมดา", [user("มากัน 2 ท่านค่ะ"), bot(QUOTE)]).reason, "multi_seat");
  assert.equal(offer("บริษัทค่ะ", [user("ขอใบเสนอราคาด้วยค่ะ"), bot(QUOTE)]).reason, "quotation_requested");
  assert.equal(offer("บุคคลธรรมดา", [user("สนใจทั้ง AI Agent for Business และ AI Agent Workflow Automation")]).reason, "customer_course_ambiguous");
  assert.equal(offer("บุคคลธรรมดา", [user("มีคลาสออนไลน์ไหมคะ"), bot("คลาสออนไลน์ VDO on demand 4,900 บาทค่ะ")]).reason, "online_course");
  const full = ROUNDS.map((r) => (r.date === "2026-11-14" ? { ...r, fileStatus: "full" } : r));
  assert.equal(resolvePaymentOffer({ latestText: "บุคคลธรรมดา", history: [bot(QUOTE), user("14 พย")], courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: full }).reason, "round_unavailable");
  const manual = plan({ text: "บุคคลธรรมดาค่ะ", history: [user("มากัน 3 คน"), bot(QUOTE), bot(DOC_TYPE_QUESTION)] });
  assert.equal(manual.action, "pin");
  assert.equal(manual.manual, true);
});

test("รอบ: ลูกค้าเลือกเอง > ร้านยืนยันรอบเดียว > รอบเปิดรอบเดียว > ให้เลือกในข้อความ (ไม่เดา)", () => {
  assert.equal(mentionsRound("14 พย", ROUNDS[0]), true);
  assert.equal(mentionsRound("วันเสาร์ที่ 14 พ.ย. ค่ะ", ROUNDS[0]), true);
  assert.equal(mentionsRound("14/11", ROUNDS[0]), true);
  assert.equal(mentionsRound("114 พย", ROUNDS[0]), false);
  assert.equal(mentionsRound("14 พค", ROUNDS[0]), false);
  const ask = plan({ text: "บุคคลธรรมดา", history: [bot(QUOTE), bot("เปิดรอบเสาร์ 14 พ.ย. เสาร์ 21 พ.ย. และเสาร์ 19 ธ.ค. ค่ะ"), bot(DOC_TYPE_QUESTION)] });
  assert.equal(ask.action, "compose");
  assert.match(ask.message.bubbles[0], /รอบ : เลือกได้ เสาร์ 14 พ.ย. 2026 · เสาร์ 21 พ.ย. 2026 · เสาร์ 19 ธ.ค. 2026 \(แจ้งรอบที่สะดวกได้เลยค่ะ\)/u);
  const stated = plan({ text: "บุคคลธรรมดา", history: [bot(QUOTE), bot("รอบที่เลือกคือวันเสาร์ 21 พ.ย. ค่ะ"), bot(DOC_TYPE_QUESTION)] });
  assert.match(stated.message.bubbles[0], /รอบ : เสาร์ 21 พ.ย. 2026/u);
});

test("ไม่ส่งซ้ำ: ดีลเริ่มจ่ายแล้ว หรือมีบล็อกบัญชีในห้องแล้ว (จาก AI หรือทีม)", () => {
  assert.equal(paymentAlreadyDelivered({ customer: { deal_status: "awaiting_payment" } }), false, "lifecycle ตั้ง awaiting_payment เองตอนเลือกรอบ — ไม่ใช่หลักฐานว่าได้บัญชี");
  assert.equal(paymentAlreadyDelivered({ customer: { deal_status: "awaiting_payment" }, evidence: true }), true, "หลักฐานจาก DB ทั้งห้อง (audit/ข้อความเก่าเกินหน้าต่างประวัติ)");
  assert.equal(paymentAlreadyDelivered({ customer: { money_seen_at: 1 } }), true);
  assert.equal(plan({ text: "บริษัทค่ะ", delivered: true, history: [bot(QUOTE), bot(DOC_TYPE_QUESTION)] }).action, "none");
  assert.equal(paymentAlreadyDelivered({ history: [bot("👉 สามารถโอนชำระได้ที่บัญชีนี้นะคะ\nธนาคาร: กสิกรไทย\nเลขที่บัญชี: 000-0-00000-0")] }), true);
  assert.equal(plan({ text: "บุคคลธรรมดา", customer: { deal_status: "paid_confirmed" }, history: [bot(QUOTE), bot(DOC_TYPE_QUESTION)] }).action, "none");
  assert.equal(plan({ text: "บุคคลธรรมดา", history: [bot(`${QUOTE}\n\nเลขที่บัญชี : 000-0-00000-0`), bot(DOC_TYPE_QUESTION)] }).action, "none");
});

test("หมุด: ตอบประเภทเอกสาร + ถามเรื่องอื่น = เก็บหมุด · เทิร์นถัดไปที่พร้อม = ประกอบจากหมุด · ยกเลิก = ล้าง", () => {
  const history = [bot(QUOTE), bot(DOC_TYPE_QUESTION)];
  const mixed = plan({ text: "ขอรายละเอียดคอร์สได้ไหมครับ\nนามบริษัทครับ", history });
  assert.deepEqual([mixed.action, mixed.docType, mixed.reason, mixed.manual], ["pin", "company", "other_question", false]);
  const pin = { docType: "company", at: Date.now(), sessionId: "s1" };
  const later = [...history, user("ขอรายละเอียดคอร์สได้ไหมครับ"), bot("เนื้อหาคลาสมีดังนี้ค่ะ ...")];
  assert.deepEqual([plan({ text: "โอเคครับ", history: later, pin }).action, plan({ text: "ขอบคุณค่ะ", history: later, pin }).reason], ["pin", "not_ready"],
    "คำรับเฉย ๆ ไม่ใช่สัญญาณพร้อมจ่าย");
  const ready = plan({ text: "โอเคครับ สมัครเลยครับ", history: later, pin });
  assert.equal(ready.action, "compose");
  assert.equal(ready.fromPin, true);
  const deferred = plan({ text: "ขอคิดก่อนนะครับ", history: later, pin });
  assert.deepEqual([deferred.action, deferred.reason, deferred.manual], ["pin", "customer_deferred", false], "ขอเวลา = ไม่ส่งบัญชี ไม่ปักธง เก็บหมุดไว้");
  assert.equal(plan({ text: "ยกเลิกครับ", history: later, pin }).action, "clear");
  assert.equal(plan({ text: "เรียนกี่โมงครับ", history: later, pin }).action, "pin");
  assert.equal(plan({ text: "โอเคครับ", history: later, pin: null }).action, "none", "ไม่มีหมุด ไม่ได้ถาม = ไม่ใช่จังหวะ");
});

test("ผลตรวจโค้ด 18 ต.ค.: ขอเวลาทุกแบบ = ไม่ส่ง · ประโยคบอกข้อมูลของร้านไม่ใช่คำถาม · คำตอบใหม่ชนะหมุด · ตอบพ่วงเนื้อหาอื่น = คุยก่อน · ราคากลุ่มคนเดียวไม่ได้", () => {
  const asked = [bot(QUOTE), bot(DOC_TYPE_QUESTION)];
  for (const said of ["บุคคลธรรมดาค่ะ ขอเวลาคิดก่อน", "บริษัทค่ะ ขอเวลาตัดสินใจก่อน", "บุคคลธรรมดา ขอพิจารณาก่อนนะคะ", "บริษัทครับ ขอลองดูก่อน",
    "บริษัทค่ะ รอผู้บริหารอนุมัติก่อน", "บุคคลธรรมดาค่ะ ขออนุมัติที่บ้านก่อน"]) {
    assert.deepEqual([plan({ text: said, history: asked }).action, plan({ text: said, history: asked }).reason], ["pin", "customer_deferred"], said);
  }
  assert.equal(botAskedDocType([bot("ออกใบเสร็จในนามบุคคลธรรมดาหรือบริษัทได้ค่ะ")]), false);
  assert.equal(plan({ text: "ทำงานบริษัทประกันค่ะ", history: [bot(QUOTE), bot("ออกใบเสร็จในนามบุคคลธรรมดาหรือบริษัทได้ค่ะ")] }).action, "none");
  const pin = { docType: "person", at: Date.now() };
  const switched = plan({ text: "ขอเปลี่ยนเป็นนามบริษัทนะคะ โอนเลยค่ะ", history: [bot(QUOTE), bot("ได้เลยค่ะ")], pin });
  assert.equal(switched.docType, "company");
  assert.match(switched.message.bubbles[0], /ออกเอกสารในนาม : บริษัท/u);
  assert.deepEqual([plan({ text: "บริษัทครับ พอดีอยากเรียนกับเพื่อนอีกคนแต่ยังไม่แน่ใจวันไหน", history: asked }).action], ["pin"]);
  const group = resolvePaymentOffer({ latestText: "บุคคลธรรมดา", courses: COURSES, approvedPrices: PRICES, approvedAmounts: AMOUNTS, rounds: ROUNDS,
    history: [bot("AI Agent for Business มา 2 ท่านขึ้นไปเหลือ 11,900 บาท/ท่าน ค่ะ"), bot(DOC_TYPE_QUESTION)] });
  assert.equal(group.reason, "price_qualified");
});

test("หมุดหมดอายุ 7 วัน และไม่ข้าม session", () => {
  const now = Date.parse("2026-10-18T05:00:00Z");
  assert.ok(readPin(JSON.stringify({ docType: "person", at: now - 3_600_000, sessionId: "a" }), { now, sessionId: "a" }));
  assert.equal(readPin(JSON.stringify({ docType: "person", at: now - 8 * 86_400_000, sessionId: "a" }), { now, sessionId: "a" }), null);
  assert.equal(readPin(JSON.stringify({ docType: "person", at: now, sessionId: "a" }), { now, sessionId: "b" }), null);
  assert.equal(readPin("", { now }), null);
});

test("ร่างของโมเดลที่ยังพิมพ์บัญชีเอง: ตัดบล็อกบัญชี/ฟอร์มทิ้ง เหลือคำตอบส่วนอื่น", () => {
  const draft = `ได้เลยค่ะ ลูกแพรสรุปให้นะคะ\n\nสามารถโอนชำระได้ที่บัญชีนี้นะคะ\n\nธนาคาร : กสิกรไทย\nเลขที่บัญชี : 000-0-00000-0\nชื่อบัญชี : บจก. ตัวอย่าง\n[IMAGE:payment-kbank]\n\n${kit.form}`;
  const stripped = stripPaymentInstructions(draft);
  assert.equal(stripped, "ได้เลยค่ะ ลูกแพรสรุปให้นะคะ");
  assert.equal(paymentInstructionsIndex(stripped), -1);
});

test("ตัวประกอบไม่แปลงเลขบัญชี: ข้อความที่ส่งมีบล็อกบัญชีตรงตามการ์ดทุกตัวอักษร", () => {
  const message = composePaymentMessage({ docType: "person", kit,
    offer: { displayName: "AI Agent for Business", amount: 12900, round: ROUNDS[0], roundOptions: [] } });
  assert.ok(message.bubbles.includes(kit.bank));
  assert.ok(message.text.includes("เลขที่บัญชี : 000-0-00000-0"));
});
