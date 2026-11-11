// safety router + compliance guard (รวม price guard ตาม SPEC ข้อ 6)
import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPLAINT_TEMPLATE,
  PAYMENT_TEMPLATE,
  isDocumentNameQuestion,
  routeMessage,
  IDENTITY_TEMPLATE,
  resolveIdentityTemplate,
  templateAfterEscalation,
  URGENT_TEMPLATE,
} from "../src/safetyRouter.mjs";
import { createComplianceGuard, findPriceViolations, loadBannedWords, multipliableAmounts } from "../src/complianceGuard.mjs";
import { HERMES_DOWN_TEMPLATE, applyKnownFactsOverride } from "../src/pipeline.mjs";
import { poisonGlobalFetch } from "./helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

poisonGlobalFetch();

const BANNED_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "clinic-banned.json");

/* ------------------------------- safety router ----------------------------- */

test("safety: คำเสี่ยงการแพทย์ฉุกเฉิน -> urgent template มี 1669 + escalate", () => {
  const route = routeMessage({ text: "แม่หนูแน่นหน้าอก หายใจไม่ออกค่ะ ทำไงดี" });
  assert.equal(route.route, "urgent");
  assert.ok(route.template.includes("1669"));
  assert.equal(route.escalate.reason, "urgent_medical");
});

test("safety: complaint -> หยุดขาย + escalate", () => {
  const route = routeMessage({ text: "ไม่พอใจมากเลยค่ะ บริการแย่มาก จะร้องเรียน" });
  assert.equal(route.route, "complaint");
  assert.equal(route.escalate.reason, "complaint");
  assert.ok(route.template.includes("ขออภัย"));
});

test("safety: สลิป/โอนเงิน -> payment human review ห้าม OCR", () => {
  const route = routeMessage({ text: "โอนแล้วนะคะ แนบสลิปไว้ให้แล้ว" });
  assert.equal(route.route, "payment");
  assert.equal(route.escalate.reason, "payment_review");
});

test("safety: ขอใบเสร็จ -> payment เช่นกัน", () => {
  const route = routeMessage({ text: "ขอใบเสร็จหน่อยค่ะ" });
  assert.equal(route.route, "payment");
});

test("safety: รูปภาพ -> human review ไม่ตอบอัตโนมัติ (อาจเป็นสลิป)", () => {
  const route = routeMessage({ text: "", msgType: "image" });
  assert.equal(route.route, "payment");
  assert.equal(route.template, null);
  assert.equal(route.escalate.reason, "image_review");
});

test("safety: identity — บอทหรือเปล่า -> ตอบตรง + เสนอต่อสายคน", () => {
  const route = routeMessage({ text: "นี่บอทหรือเปล่าคะ" });
  assert.equal(route.route, "identity");
  assert.equal(route.template, IDENTITY_TEMPLATE);
  assert.ok(route.template.includes("AI"));
  assert.ok(route.template.includes("คนจริง"));
});

test("safety: identity — คนจริงไหม อีกสำนวน", () => {
  const route = routeMessage({ text: "ขอคุยกับคนจริงไหมคะ อันนี้ใช่บอทมั้ย" });
  assert.equal(route.route, "identity");
});

test("safety: identity template may be instance-specific only when AI disclosure and human handoff stay explicit", () => {
  const custom = "แพรเป็นผู้ช่วย AI ของพี่ง้วงค่ะ ถ้าอยากคุยกับทีมงานคนจริง บอกแพรได้เลยนะคะ";
  assert.equal(resolveIdentityTemplate(""), IDENTITY_TEMPLATE, "legacy instances retain their default");
  const route = routeMessage({ text: "นี่บอทหรอ", identityTemplate: custom });
  assert.equal(route.route, "identity");
  assert.equal(route.template, custom);
  assert.throws(() => resolveIdentityTemplate("แพรช่วยตอบอยู่นะคะ"), /explicitly disclose AI/u);
  assert.throws(() => resolveIdentityTemplate(`AI ทีมงาน ${"ก".repeat(400)}`), /bounded/u);
});

test("safety: urgent ชนะ identity เมื่อมาพร้อมกัน (ลำดับความสำคัญ)", () => {
  const route = routeMessage({ text: "แน่นหน้าอกมาก นี่บอทหรือเปล่า" });
  assert.equal(route.route, "urgent");
});

test("safety: Thai intent collision — ใบเสนอราคาชนะคำ generic ราคา (regression)", () => {
  const route = routeMessage({ text: "ขอใบเสนอราคาคอร์สหน่อยค่ะ ราคาเท่าไหร่คะ" });
  assert.equal(route.route, "ai");
  assert.equal(route.intent, "quotation"); // ห้ามเป็น pricing
});

test("safety: ใบกำกับภาษี / นิติบุคคล / เลขผู้เสียภาษี -> intent เฉพาะทาง", () => {
  // v1.4.44 (spec เปลี่ยนตามผลตัดสิน audit 360): คำขอใบกำกับภาษีคือคำขอเอกสารการเงิน
  // ที่พบบ่อยที่สุดในคลังจริง (หลายสิบข้อความ ส่วนใหญ่หลังชำระ) เอกสารต้องคนออกเสมอ
  // ห้ามบอทรับปาก — เดิมได้ intent tax_invoice แล้วไหลเข้า AI ตอบเองโดยไม่มีคนเห็น
  assert.equal(routeMessage({ text: "ขอใบกำกับภาษีเต็มรูปด้วยค่ะ" }).intent, "payment_review");
  assert.equal(routeMessage({ text: "ออกในนามนิติบุคคลได้ไหมคะ" }).intent, "corporate");
  assert.equal(routeMessage({ text: "ใส่เลขผู้เสียภาษีให้ด้วยนะคะ" }).intent, "tax_id");
});

test("safety: คำ generic ราคา -> intent pricing เข้า AI path", () => {
  const route = routeMessage({ text: "คอร์สนี้ราคาเท่าไหร่คะ" });
  assert.equal(route.route, "ai");
  assert.equal(route.intent, "pricing");
  assert.equal(route.template, null);
});

test("safety: ข้อความทั่วไป -> ai/general", () => {
  const route = routeMessage({ text: "สวัสดีค่ะ เปิดกี่โมงคะ" });
  assert.equal(route.route, "ai");
  assert.equal(route.intent, "general");
});

/* ----------------------------- compliance guard ---------------------------- */

function makeGuard(approved = [], bannedWords = loadBannedWords(BANNED_FILE)) {
  return createComplianceGuard({
    bannedWords,
    getApprovedPrices: () => approved.map((amount, i) => ({ label: `p${i}`, amount })),
  });
}

test("guard: banned word สบส. โดนบล็อก", () => {
  const guard = makeGuard();
  const result = guard.checkOutbound("คอร์สนี้การันตีผลแน่นอนค่ะ");
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "banned_word"));
});

test("guard: คำการันตีแบบ superlative (เห็นผล 100%) โดนบล็อก", () => {
  const guard = makeGuard();
  const result = guard.checkOutbound("ทำแล้วเห็นผล 100% เลยนะคะ");
  assert.ok(result.violations.some((v) => v.type === "banned_word" && v.detail === "เห็นผล 100%"));
});

test("guard: no-diagnosis heuristic — ฟันธงโรคโดนบล็อก", () => {
  const guard = makeGuard();
  assert.equal(guard.checkOutbound("จากที่เล่ามา น่าจะเป็นโรคภูมิแพ้ค่ะ").ok, false);
  assert.equal(guard.checkOutbound("หมอวินิจฉัยผ่านแชทให้ได้เลยค่ะ").ok, false);
});

test("guard: price guard — เลขตรงตาราง approve = ผ่าน", () => {
  const guard = makeGuard([2500]);
  const result = guard.checkOutbound("คอร์สนี้ราคา 2,500 บาทค่ะ");
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test("guard: price guard — เลขแปลกไม่อยู่ในตาราง = block", () => {
  const guard = makeGuard([2500]);
  const result = guard.checkOutbound("คอร์สนี้ราคา 2,590 บาทค่ะ");
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.type === "price" && v.detail === "2,590"));
});

test("guard: price guard — เลขที่ model คำนวณใหม่ (เฉลี่ย/ส่วนลด) = block", () => {
  const guard = makeGuard([2500]);
  // model หาร 2500/2 เองเป็นราคาเฉลี่ยต่อครั้ง — ห้ามปล่อย (บทเรียน hermes.md ข้อ 8)
  const average = guard.checkOutbound("เฉลี่ยครั้งละ 1,250 บาทเองนะคะ");
  assert.equal(average.ok, false);
  const discount = guard.checkOutbound("ลดพิเศษเหลือเพียง 1990 บาทค่ะ");
  assert.equal(discount.ok, false);
});

test("guard: ตาราง approve ว่าง = block ทุกเลขราคา (fail-closed)", () => {
  const guard = makeGuard([]);
  assert.equal(guard.checkOutbound("ราคา 500 บาทค่ะ").ok, false);
});

test("guard: 1669 / เวลา / เบอร์โทร ไม่ใช่ราคา — ต้องผ่าน", () => {
  const guard = makeGuard([]);
  assert.equal(guard.checkOutbound(URGENT_TEMPLATE).ok, true);
  assert.equal(guard.checkOutbound("พรุ่งนี้เจอกัน 14:30 นะคะ").ok, true);
  assert.equal(guard.checkOutbound("โทรหาแอดมินที่ 0812345678 ได้เลยค่ะ").ok, true);
});

test("guard: เลขมี comma = รูปแบบราคา แม้ไม่มีคำว่าราคาข้าง ๆ", () => {
  const violations = findPriceViolations("พิเศษ 12,900 เท่านั้นค่ะ", new Set([2500]));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].detail, "12,900");
});

test("guard: ข้อความปกติไม่มีเลข ไม่มีคำต้องห้าม = ผ่าน", () => {
  const guard = makeGuard([]);
  assert.equal(guard.checkOutbound("ได้เลยค่ะ เดี๋ยวเช็คคิวให้นะคะ").ok, true);
});

test("guard: template ระบบทุกตัวต้องผ่าน guard เอง (กัน template พังเอง)", () => {
  const guard = makeGuard([]);
  assert.equal(guard.checkOutbound(HERMES_DOWN_TEMPLATE).ok, true);
  assert.equal(guard.checkOutbound(IDENTITY_TEMPLATE).ok, true);
});

test("safety: ไม่มี handoff receipt ต้องตัด claim/promise แต่คงคำแนะนำสำคัญ", () => {
  const urgent = templateAfterEscalation(URGENT_TEMPLATE, false);
  assert.match(urgent, /1669/u);
  assert.doesNotMatch(urgent, /กำลังแจ้ง|เจ้าหน้าที่|ติดต่อกลับ/u);

  const complaint = templateAfterEscalation(COMPLAINT_TEMPLATE, false);
  assert.match(complaint, /ขออภัย/u);
  assert.doesNotMatch(complaint, /รับเรื่อง|เจ้าหน้าที่|ติดต่อกลับ/u);

  const payment = templateAfterEscalation(PAYMENT_TEMPLATE, false);
  assert.match(payment, /ตรวจสอบและยืนยัน/u);
  assert.doesNotMatch(payment, /ได้รับข้อมูล|เดี๋ยว|ยืนยันกลับ/u);
});

test("guard: checkInbound ติดธงคำถามเชิงวินิจฉัย/ขอส่วนลด", () => {
  const guard = makeGuard([]);
  assert.ok(guard.checkInbound("อาการแบบนี้เป็นโรคอะไรคะ").flags.includes("asks_diagnosis"));
  assert.ok(guard.checkInbound("ขอส่วนลดหน่อยได้ไหมคะ").flags.includes("asks_discount"));
  assert.deepEqual(guard.checkInbound("เปิดกี่โมงคะ").flags, []);
});

test("guard: ไฟล์ banned words จริงโหลดได้ครบ 10 คำ", () => {
  const words = loadBannedWords(BANNED_FILE);
  assert.equal(words.length, 10);
  assert.ok(words.includes("การันตีผล"));
});

test("guard: ไฟล์ banned words หาย = ลิสต์ว่าง ไม่ล้ม", () => {
  const words = loadBannedWords("/ไม่มีไฟล์นี้.json", { logger: { warn: () => {} } });
  assert.deepEqual(words, []);
});

/* ---------------------- price guard: จำนวน vs ราคา ------------------------- */
// BUG 2 (Airdog trial): "รับประกัน 3 ปี" โดนบล็อกเป็น price:3 ทั้งที่ไม่ใช่ราคา
// เลขตามด้วยหน่วยนับ/ระยะเวลา (ไม่ใช่บาท) และเลขในชื่อรุ่นสินค้า ต้อง exempt

test("guard: เลข+หน่วยเวลา (รับประกัน 3 ปี / ผ่อน 3 เดือน) ไม่ใช่ราคา — ผ่านแม้ตารางว่าง", () => {
  const guard = makeGuard([]);
  assert.equal(guard.checkOutbound("รับประกัน 3 ปีค่ะ").ok, true);
  assert.equal(guard.checkOutbound("ผ่อน 3 เดือนได้เลยนะคะ").ok, true);
  assert.equal(guard.checkOutbound("จัดส่งภายใน 2 วันค่ะ ใช้เวลาติดตั้ง 30 นาที").ok, true);
  assert.equal(guard.checkOutbound("กรองได้ 5 ชั้น เปลี่ยนไส้กรองปีละ 1 ครั้งค่ะ").ok, true);
});

test("guard: ชื่อรุ่นสินค้า + หน่วยพื้นที่ (X3 Pro / 30 ตร.ม.) ไม่ใช่ราคา — ผ่าน", () => {
  const guard = makeGuard([]);
  assert.equal(guard.checkOutbound("X3 Pro เหมาะกับห้อง 30 ตร.ม. ค่ะ").ok, true);
  assert.equal(guard.checkOutbound("แนะนำรุ่น X5 หรือ X8 Ultra ค่ะ ครอบคลุม 60 ตารางเมตร").ok, true);
  assert.equal(guard.checkOutbound("X 3 Pro ตัวนี้ขายดีสุดค่ะ").ok, true);
});

// H3: ช่องโหว่ exemption — isExemptNumber (QUANTITY_UNIT_AFTER) รันก่อน inPriceContext
// ทำให้ "ลดเหลือ 4,990 เครื่องสุดท้ายค่ะ" ถูกยกเว้นเพราะ "เครื่อง" ตามหลัง ทั้งที่ 4,990
// เป็นราคา comma-format ข้าง ๆ "ลดเหลือ" — เลข comma ต้องไม่ปลดล็อกด้วยหน่วยนับตามหลัง
test("guard H3: เลข comma + หน่วยนับตามหลัง (ลดเหลือ 4,990 เครื่องสุดท้าย) = ราคา -> BLOCKED", () => {
  const guard = makeGuard([]);
  const res = guard.checkOutbound("ลดเหลือ 4,990 เครื่องสุดท้ายค่ะ");
  assert.equal(res.ok, false, "เลข comma ข้างคำว่าลดเหลือ = ราคา ตารางว่างต้องบล็อก");
  assert.ok(res.violations.some((v) => v.type === "price" && v.detail === "4,990"));
  // ตรวจตรงชั้น findPriceViolations ด้วย (exemption ต้องไม่กินเลข comma)
  const v = findPriceViolations("ลดเหลือ 4,990 เครื่องสุดท้ายค่ะ", new Set());
  assert.equal(v.length, 1);
  assert.equal(v[0].detail, "4,990");
});

test("guard H3: หน่วยนับที่ 'ไม่มี comma' ยังยกเว้นตามเดิม (รับประกัน 3 ปี / 30 ตร.ม.)", () => {
  const guard = makeGuard([]);
  assert.equal(guard.checkOutbound("รับประกัน 3 ปีค่ะ").ok, true);
  assert.equal(guard.checkOutbound("เหมาะกับห้อง 30 ตร.ม. ค่ะ").ok, true);
  // ราคา comma ที่อยู่ในตาราง approve ต้องยังผ่าน (fix ไม่ทำให้ราคาที่อนุมัติแล้วพัง)
  assert.equal(makeGuard([4990]).checkOutbound("ลดเหลือ 4,990 บาทค่ะ").ok, true);
});

test("guard: เลขตามด้วยบาท/บริบทราคา ยังต้องเทียบตาราง approve เหมือนเดิม (ห้ามอ่อนลง)", () => {
  const guard = makeGuard([]);
  const price = guard.checkOutbound("ราคา 21,900 บาท");
  assert.equal(price.ok, false, "ตารางว่าง = เลขราคาทุกตัวต้องโดนบล็อก");
  assert.ok(price.violations.some((v) => v.type === "price" && v.detail === "21,900"));

  const discount = guard.checkOutbound("ลดเหลือ 18,990 บาทค่ะ");
  assert.equal(discount.ok, false);
  assert.ok(discount.violations.some((v) => v.type === "price" && v.detail === "18,990"));

  // approve แล้วผ่านตามเดิม — exemption ไม่ได้เปิดช่องให้ราคาหลุด
  const approved = makeGuard([21900]);
  assert.equal(approved.checkOutbound("ราคา 21,900 บาทค่ะ").ok, true);
});

test('guard: "เท่านั้น" ไม่ใช่หน่วยนับ — พิเศษ 12,900 เท่านั้น ยังเป็นราคา (กัน exempt กินเกิน)', () => {
  const guard = makeGuard([]);
  assert.equal(guard.checkOutbound("พิเศษ 12,900 เท่านั้นค่ะ").ok, false);
  // แต่ "2 เท่า" (จำนวนเท่า) ผ่านได้
  assert.equal(guard.checkOutbound("กรองฝุ่นได้ดีกว่าเดิม 2 เท่าค่ะ").ok, true);
});

// v1.2.3 (คำสั่งพี่ง้วง 2026-08-12): โหมดเทรนภายในให้ตอบด้วยข้อมูลตัวอย่างได้ทุกเรื่อง
// รวมถึงตัวเลขราคา ตราบใดที่ข้อความติดป้ายบอกลูกค้าชัดว่าเป็นตัวอย่างที่รอทีมงานยืนยัน
test("v1.2.3: โหมดเทรนยอมตัวเลขที่ติดป้ายข้อมูลตัวอย่าง แต่ยังบล็อกตัวเลขลอย ๆ", () => {
  const training = createComplianceGuard({
    getApprovedPrices: () => [{ amount: 15900 }],
    trainingMockMode: true,
    logger: { warn() {} },
  });
  const labelled = training.checkOutbound("early bird ลดเหลือ 13,900 บาทค่ะ (ข้อมูลตัวอย่างระหว่างเทรนค่ะ รบกวนทีมงานพี่ง้วงเติมข้อมูลจริง)");
  assert.equal(labelled.ok, true, "ติดป้ายแล้วต้องผ่านในโหมดเทรน");
  const unlabelled = training.checkOutbound("early bird ลดเหลือ 13,900 บาทค่ะ");
  assert.equal(unlabelled.ok, false, "ไม่ติดป้าย = ยังเป็นการอ้างราคาจริง");
  assert.equal(training.checkOutbound("ราคา 15,900 บาทค่ะ").ok, true, "ราคาที่อนุมัติแล้วผ่านตามปกติ");
});

test("v1.2.3: instance ปกติ (ไม่ใช่โหมดเทรน) ยังบล็อกราคาที่ไม่อนุมัติแม้ติดป้าย", () => {
  const live = createComplianceGuard({ getApprovedPrices: () => [{ amount: 15900 }] });
  const result = live.checkOutbound("early bird ลดเหลือ 13,900 บาทค่ะ (ข้อมูลตัวอย่าง)");
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].type, "price");
});

// ---- v1.3 (คู่มือแอดมินคนจริง 2026-08-13): ยอดรวมที่คำนวณถูกต้องไม่ใช่ราคาที่แต่งขึ้น ----
// คู่มือสั่งให้แจ้งยอดรวมให้ลูกค้าเห็นภาพ ("ท่านละ 11,900 รวม 2 ท่าน 23,800")
// ยอดรวมจึงต้องผ่านได้ ตราบใดที่เท่ากับราคาต่อท่านที่อนุมัติคูณจำนวนคนพอดี
const PLAYBOOK_PRICES = [
  [9900, "Online — ราคาปกติ"], [4900, "Online — Early Bird"],
  [19900, "Classroom — ราคาปกติ"], [12900, "AI Agent for Business — Early Bird"],
  [15900, "Workflow — Early Bird"], [11900, "AI Agent for Business — 2 ท่านขึ้นไป"],
  [14900, "Workflow — 2 ท่านขึ้นไป"], [25900, "Bundle 2 คลาส"],
  [5000, "Private — ค่าบริการท่านที่ 5 ขึ้นไป / นอกสถานที่"],
  [1000, "ส่วนลดมาเรียน 2 ท่านขึ้นไป"], [3000, "ส่วนลดนักเรียนเก่า"],
].map(([amount, label]) => ({ amount, label }));

test("v1.3: ยอดรวมจากราคาต่อท่านที่อนุมัติ ต้องส่งถึงลูกค้าได้", () => {
  const guard = createComplianceGuard({ getApprovedPrices: () => PLAYBOOK_PRICES });
  assert.equal(guard.checkOutbound("ท่านละ 11,900 บาท รวม 2 ท่านเป็น 23,800 บาทค่ะ").ok, true);
  assert.equal(guard.checkOutbound("ท่านละ 14,900 บาท 3 ท่านเป็น 44,700 บาทค่ะ").ok, true);
  assert.equal(guard.checkOutbound("Early Bird 12,900 บาท จากราคาปกติ 19,900 บาทค่ะ").ok, true);
});

test("v1.3: ราคาที่โมเดลแต่งเองยังต้องถูกบล็อกเหมือนเดิม", () => {
  const guard = createComplianceGuard({ getApprovedPrices: () => PLAYBOOK_PRICES });
  assert.equal(guard.checkOutbound("ลดพิเศษเหลือ 8,500 บาทค่ะ").ok, false);
  assert.equal(guard.checkOutbound("จ่ายมัดจำ 2,000 บาทก่อนได้ค่ะ").ok, false);
  // 10,000 = 5,000 x 2 แต่ 5,000 เป็นค่าบริการเสริม ไม่ใช่ราคาต่อท่าน จึงคูณไม่ได้
  assert.equal(guard.checkOutbound("ราคาพิเศษวันนี้ 10,000 บาทค่ะ").ok, false);
});

test("v1.3: ส่วนลดและค่าบริการเสริมไม่ถูกใช้เป็นฐานคูณ", () => {
  const units = multipliableAmounts(PLAYBOOK_PRICES);
  assert.equal(units.has(11900), true);
  assert.equal(units.has(5000), false, "ค่าบริการนอกสถานที่ห้ามเป็นฐานคูณ");
  assert.equal(units.has(1000), false, "ส่วนลดห้ามเป็นฐานคูณ");
  assert.equal(units.has(3000), false);
});

test("v1.3: จำนวนคนที่ตามด้วยคำไทยติดกัน ต้องไม่ถูกนับเป็นราคา", () => {
  const guard = createComplianceGuard({ getApprovedPrices: () => PLAYBOOK_PRICES });
  assert.equal(guard.checkOutbound("มา 3 ท่านเป็นทีมได้เลยค่ะ").ok, true);
  assert.equal(guard.checkOutbound("คลาสรับไม่เกิน 15 ท่านค่ะ").ok, true);
});

/* ---- v1.3.4: เลขภาษีที่คำนวณจากยอดที่อนุมัติแล้ว (เหตุจริง 2026-08-13) ---- */

test("price guard: เลขภาษีที่คำนวณถูกต้องต้องผ่าน ไม่ใช่บล็อกทั้งคำตอบ", () => {
  // เคสจริง: ลูกค้าถาม "หัก ณ ที่จ่ายไหม" ดราฟต์ถูกทุกตัวเลข แต่โดนบล็อกจนลูกค้าได้
  // ข้อความ "ข้อมูลตรงนี้ยังยืนยันไม่ได้ค่ะ" แทนคำตอบ — ทดสอบเดิมพบว่าบล็อก 11/11 ราคา
  const rows = [
    { amount: 12900, label: "AI Agent for Business — Early Bird" },
    { amount: 11900, label: "AI Agent for Business — Early Bird เมื่อมา 2 ท่านขึ้นไป" },
    { amount: 1000, label: "ส่วนลดมาเรียน 2 ท่านขึ้นไป" },
  ];
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => rows });

  const real = "ยอด 23,800 บาท รวม VAT แล้ว หากหัก ณ ที่จ่าย 3% จากยอดก่อน VAT จะหัก 667.29 บาท ยอดโอนสุทธิ 23,132.71 บาทค่ะ";
  assert.equal(guard.checkOutbound(real).ok, true, "เลขภาษีที่ถูกต้องต้องไม่ถูกบล็อก");

  // มัดจำครึ่งหนึ่งต้องมาจากตารางเอง — guard ห้ามหารราคาให้ (ชนบทเรียน "โมเดลคำนวณเอง")
  assert.equal(guard.checkOutbound("มัดจำครึ่งหนึ่ง 5,950 บาท จากยอด 11,900 บาทค่ะ").ok, false);
  assert.equal(guard.checkOutbound("ยอดก่อน VAT 12,056.07 บาท VAT 843.93 บาท รวม 12,900 บาทค่ะ").ok, true);
});

test("price guard: ยังต้องบล็อกราคาที่แต่งเองและส่วนต่างที่คำนวณเอง", () => {
  const rows = [{ amount: 12900, label: "Early Bird" }, { amount: 19900, label: "ราคาปกติ" }];
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => rows });

  assert.equal(guard.checkOutbound("ลดพิเศษให้เหลือ 9,500 บาทค่ะ").ok, false, "ราคาที่ไม่อยู่ในตารางต้องถูกบล็อก");
  // ส่วนต่าง 19,900-12,900 = 7,000 เป็นการตลาด ต้องมาจากตาราง ไม่ใช่ให้โมเดลลบเลขเอง
  assert.equal(guard.checkOutbound("ประหยัดไป 7,000 บาทเลยค่ะ").ok, false, "ยอดประหยัดที่คำนวณเองต้องถูกบล็อก");
});

test("price guard: ห้ามเปิดช่องให้ 'ราคาลดพิเศษ' ที่บังเอิญเท่ากับ VAT ของยอดคูณจำนวนคน", () => {
  // ตรวจปรปักษ์วัดได้ว่าสูตร base*7% เปิดเลขที่ผ่านด่านเพิ่ม 395 ตัว (100% ของช่องโหว่ใหม่)
  // เพราะแถวเลขกลมในตารางคูณจำนวนคนแล้วคูณ 7% ได้อนุกรมที่หน้าตาเหมือนราคาลดพิเศษพอดี
  const rows = [
    { amount: 110000, label: "Monthly Consult 2 เดือน" },
    { amount: 99000, label: "In-house training ราคาปกติ" },
    { amount: 79000, label: "Private Class ราคาปกติ" },
    { amount: 12900, label: "AI Agent for Business — Early Bird" },
  ];
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => rows });

  assert.equal(guard.checkOutbound("In-house ลดพิเศษเหลือ 77,000 บาทค่ะ").ok, false);
  assert.equal(guard.checkOutbound("Private Class ราคาพิเศษ 38,500 บาทค่ะ").ok, false);
  assert.equal(guard.checkOutbound("ลดเหลือ 15,400 บาทค่ะ").ok, false);

  // เลขภาษีที่ถูกต้องยังต้องผ่านเหมือนเดิม (ยอดก่อน VAT ของ 12,900 = 12,056.07)
  assert.equal(guard.checkOutbound("ยอดก่อน VAT 12,056.07 บาท จากยอดรวม 12,900 บาทค่ะ").ok, true);
});

test("price guard: สำนวนคิดเงินที่คู่มือระบุไว้ต้องผ่านทั้งหมด", () => {
  // ตรวจปรปักษ์พบว่า guard บล็อกสำนวนจากคู่มือ 11 จาก 28 ตัว รวมค่าธรรมเนียมบัตร 2.5%
  // ยอดผ่อน 10 เดือน 0% และยอดบวกค่าบริการเสริมที่ตารางตั้งใจให้บวกได้
  const rows = [
    { amount: 12900, label: "AI Agent for Business — Early Bird" },
    { amount: 79000, label: "Private Class ราคาปกติ / In-house โปรโมชั่น" },
    { amount: 59000, label: "Private Class โปรโมชั่น / Monthly Consult 1 เดือน" },
    { amount: 1000, label: "ส่วนลดมาเรียน 2 ท่านขึ้นไป / In-house ค่าบริการท่านที่ 11 ขึ้นไป" },
    { amount: 5000, label: "Private — ค่าบริการท่านที่ 5 ขึ้นไป / ค่าบริการนอกสถานที่ปกติ" },
  ];
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => rows });

  for (const text of [
    "ค่าธรรมเนียมบัตรเครดิต 2.5% ยอด 12,900 บาท เป็น 13,222.50 บาทค่ะ",
    "ผ่อน 10 เดือน 0% ยอด 12,900 บาท ตกเดือนละ 1,290 บาทค่ะ",
    "In-house 79,000 บาท ท่านที่ 11 เพิ่ม 1,000 บาท รวม 80,000 บาทค่ะ",
    "Private 59,000 บาท ท่านที่ 5 เพิ่ม 5,000 บาท รวม 64,000 บาทค่ะ",
    "In-house 79,000 บาท บวกค่าบริการนอกสถานที่ 5,000 บาท รวม 84,000 บาทค่ะ",
  ]) {
    assert.equal(guard.checkOutbound(text).ok, true, `สำนวนจากคู่มือต้องผ่าน: ${text}`);
  }
});

test("price guard: ยอดบวกส่วนเสริมต้องมีทั้งฐานและตัวบวกอยู่ในข้อความเดียวกัน", () => {
  // ถ้าไม่บังคับข้อนี้ 59,000 + 1,000×18 จะทำให้ "ลดพิเศษเหลือ 77,000" หลุดด่าน
  const rows = [
    { amount: 59000, label: "Private Class โปรโมชั่น" },
    { amount: 79000, label: "Private Class ราคาปกติ" },
    { amount: 1000, label: "ส่วนลดมาเรียน 2 ท่านขึ้นไป" },
  ];
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => rows });

  assert.equal(guard.checkOutbound("In-house ลดพิเศษเหลือ 77,000 บาทค่ะ").ok, false);
  assert.equal(guard.checkOutbound("ราคาพิเศษ 60,000 บาทค่ะ").ok, false);
  // มีทั้งฐานและตัวบวก = คิดเงินตามตารางจริง
  assert.equal(guard.checkOutbound("Private 59,000 บาท เพิ่มอีก 1,000 บาท รวม 60,000 บาทค่ะ").ok, true);
});

test("price guard: 'ท่านที่ 11' คือลำดับคน ไม่ใช่ราคา", () => {
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [{ amount: 79000, label: "In-house" }] });
  assert.equal(guard.checkOutbound("คิดค่าบริการเพิ่มตั้งแต่ท่านที่ 11 เป็นต้นไปค่ะ").ok, true);
  assert.equal(guard.checkOutbound("เริ่มจากท่านที่ 5 ค่ะ").ok, true);
});

test("price guard: ค่าธรรมเนียมบัตรกับยอดผ่อนต้องปลดล็อกตามบริบทเท่านั้น", () => {
  // การหารราคาโดยไม่มีบริบทผ่อน คือเคสที่ guard ตั้งขึ้นมาบล็อกตั้งแต่แรก (บทเรียนข้อ 8)
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [{ amount: 12900, label: "Early Bird" }] });
  assert.equal(guard.checkOutbound("ผ่อน 10 เดือน เดือนละ 1,290 บาทค่ะ").ok, true);
  assert.equal(guard.checkOutbound("เฉลี่ยครั้งละ 1,290 บาทเองนะคะ").ok, false, "ไม่มีบริบทผ่อน = ห้ามหาร");
});

/* ---- v1.3.5: brain pack ประกาศว่าราคา/รอบเรียน "ไม่มีข้อมูล" ซึ่งไม่จริงแล้ว ---- */

test("มีตารางราคาที่อนุมัติแล้ว = ต้องสั่งให้ตอบจากแหล่งจริง ไม่ใช่ให้รอทีมงาน", () => {
  // ทดสอบออฟไลน์กับสมองจริงพบว่าบรรทัดนี้ทำให้เกิดผลเสียทั้งสองทาง:
  //   โหมดเทรนปิด -> "ราคาต้องให้ทีมงานยืนยันค่ะ" ทั้งที่ราคาอยู่ใน prompt
  //   โหมดเทรนเปิด -> แต่งราคาเอง (12,900/9,900 ซึ่งผิดทั้งคู่)
  const pack = "UNAVAILABLE FACTS — do not infer or invent: exact price/promotion, date/schedule. "
    + "If asked, say only that this item requires team confirmation. Never promise a callback.";

  const withFacts = applyKnownFactsOverride(pack, { hasApprovedFacts: true });
  assert.doesNotMatch(withFacts, /say only that this item requires team confirmation/u);
  assert.match(withFacts, /AVAILABLE whenever the approved price table/u);
  assert.match(withFacts, /never round, recompute, merge or guess a number/u);
  assert.match(withFacts, /never attach a price to a different product/u);
  // ประโยคอื่นของ brain pack ต้องไม่ถูกแตะ
  assert.match(withFacts, /Never promise a callback\./u);
});

test("ไม่มีตารางราคา = กลับไป fail-closed ตามเดิม", () => {
  const pack = "UNAVAILABLE FACTS. If asked, say only that this item requires team confirmation.";
  assert.equal(applyKnownFactsOverride(pack, { hasApprovedFacts: false }), pack,
    "ตารางว่างและไม่ใช่โหมดเทรน = ต้องคงคำสั่งเดิมทุกตัวอักษร");

  // โหมดเทรนล้วน (ไม่มีข้อมูลจริง) ยังยกตัวอย่างพร้อมป้ายได้เหมือนเดิม
  const mockOnly = applyKnownFactsOverride(pack, { hasApprovedFacts: false, trainingMockMode: true });
  assert.match(mockOnly, /ข้อมูลตัวอย่างระหว่างเทรนค่ะ/u);
});

test("มีข้อมูลจริง + โหมดเทรน = ใช้ของจริงก่อน ป้ายตัวอย่างเหลือไว้เฉพาะที่ไม่มีจริง", () => {
  const pack = "If asked, say only that this item requires team confirmation.";
  const both = applyKnownFactsOverride(pack, { hasApprovedFacts: true, trainingMockMode: true });
  assert.match(both, /AVAILABLE whenever/u);
  assert.match(both, /absent from both sources/u, "ป้ายตัวอย่างต้องผูกกับกรณีที่ไม่มีข้อมูลจริงเท่านั้น");
});

test("v1.3.5: ด่านผูกราคา — 'ราคาปกติ' กับเลขที่เป็นราคาโปรเท่านั้น = ราคาผิดสินค้า ต้องบล็อก", () => {
  // เหตุจริง: โมเดลตอบ "ราคาปกติ 15,900 / โปร 12,900" — เลขทั้งคู่อยู่ในตารางจึงผ่าน guard เดิม
  // ทั้งที่ 15,900 คือ Early Bird ของ Workflow ไม่ใช่ราคาปกติของคลาสไหนเลย
  const rows = [
    { amount: 19900, label: "Classroom (ทั้ง 2 คลาส) — ราคาปกติ" },
    { amount: 12900, label: "AI Agent for Business — Early Bird" },
    { amount: 15900, label: "AI Agent Workflow Automation — Early Bird" },
  ];
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => rows });
  assert.equal(guard.checkOutbound("ราคาปกติ 15,900 บาท โปร 12,900 บาทค่ะ").ok, false);
  assert.equal(guard.checkOutbound("คลาสนี้ราคาเต็ม 12,900 บาทค่ะ").ok, false);
  assert.equal(guard.checkOutbound("ราคาปกติ 19,900 บาท Early Bird 12,900 บาทค่ะ").ok, true);
});

// ---- v1.4.6 (เคสจริง 2026-08-15): วิสามานยนาม + หน่วยนับตัวเลือก ----

test("v1.4.6: คำแบนในชื่อบริษัทของผู้รีวิว = ไม่บล็อก (กัน deadlock รีวิว)", () => {
  const guard = createComplianceGuard({
    bannedWords: ["ดีที่สุด"],
    getApprovedPrices: () => [],
  });
  const review = "คุณทดสอบสาม — Content Creator ที่ บริษัท ดีที่สุด ทดสอบ จำกัด\nhttps://www.facebook.com/share/r/1TstRe05Ee/";
  assert.equal(guard.checkOutbound(review).ok, true, "ชื่อนิติบุคคลต้องพิมพ์ได้");
  // prose ปกติยังโดนเหมือนเดิม
  assert.equal(guard.checkOutbound("คลาสเราดีที่สุดในไทยค่ะ").ok, false);
  // "จำกัดความ" ไม่ใช่ท้ายชื่อบริษัท — ห้ามหลุด
  assert.equal(guard.checkOutbound("บริษัทเราสอนดีที่สุด จำกัดความว่าเก่งเลย").ok, false);
});

test("v1.4.6: เลขนับจำนวน (2 ช่องทาง/2 แบบ) ใกล้คำว่า ชำระ ไม่ใช่ราคา", () => {
  const guard = createComplianceGuard({
    bannedWords: [],
    getApprovedPrices: () => [{ label: "Early Bird 2 ท่าน", amount: 11900 }],
  });
  const message = "ยอดสำหรับ 2 ท่าน รวม 23,800 บาท ชำระได้ 2 ช่องทางค่ะ มี 2 แบบ ให้เลือก 2 วิธี";
  assert.equal(guard.checkOutbound(message).ok, true, JSON.stringify(guard.checkOutbound(message).violations));
  // เลขราคาที่ไม่อนุมัติยังโดนตามเดิม
  assert.equal(guard.checkOutbound("ชำระเพียง 8,888 บาทค่ะ").ok, false);
});

test("v1.4.6b: quote ที่ยกมาเป๊ะจากคลังความรู้อนุมัติ — คำแบนข้างในไม่บล็อก (เคสจริง อันดับ 1)", () => {
  const who = "คุณทดสอบหนึ่ง — CEO at Test Print Studio - โรงพิมพ์ผลิตสื่อส่งเสริมการขาย อันดับ 1 ของประเทศไทย";
  const guard = createComplianceGuard({
    bannedWords: ["อันดับ 1", "ดีที่สุด"],
    getApprovedPrices: () => [],
    getApprovedQuotes: () => [who],
  });
  const review = `ขออนุญาตส่งรีวิวนะคะ\n${who}\nhttps://www.facebook.com/share/r/1TstRa01Aa/`;
  assert.equal(guard.checkOutbound(review).ok, true, "quote เป๊ะจากคลังต้องผ่าน");
  // โมเดลแต่งเอง (ไม่ตรง quote) = โดนตามเดิม
  assert.equal(guard.checkOutbound("เราคือโรงพิมพ์อันดับ 1 ของไทยค่ะ").ok, false);
  // quote สั้นเกิน (< 12 ตัว) ไม่ปลดล็อก
  const shortQuote = createComplianceGuard({
    bannedWords: ["อันดับ 1"], getApprovedPrices: () => [], getApprovedQuotes: () => ["อันดับ 1"],
  });
  assert.equal(shortQuote.checkOutbound("เราอันดับ 1 ค่ะ").ok, false);
});

/* -------- v1.4.9 (2026-08-17): price guard ต้องไม่จับเลขที่ไม่ใช่ราคา -------- */

test("v1.4.9: comma คั่นลิสต์/รหัสไปรษณีย์/วันที่ไทย ไม่ถูกจับเป็นราคา (เคสลูกค้า B)", () => {
  const approved = new Set([12900, 9900, 4900]);
  // RC1: comma คั่นลิสต์ "06, 08 หรือ 09" — เดิม token "06," กลายเป็นราคา
  assert.deepEqual(findPriceViolations("เบอร์มือถือ ขึ้นต้น 06, 08 หรือ 09 นะคะ", approved), []);
  // รหัสไปรษณีย์ในลิสต์ที่อยู่
  assert.deepEqual(findPriceViolations("จังหวัดเฮง 88888 รหัสไปรษณีย์ 10250, กรุงเทพฯ", approved), []);
  // เลขที่บ้าน + คำว่า "ชำระ" ในบริบท (เคสลูกค้า B 23:15)
  assert.deepEqual(findPriceViolations("ก่อนแจ้งชำระ ขอที่อยู่ เลขที่ 123 ซอยเลิศ 45 ค่ะ", approved), []);
  // RC2: วันที่/ปีไทยใกล้คำโปรโมชั่น — "2026" ที่พี่ง้วงเห็นส่งงงๆ
  assert.deepEqual(findPriceViolations("จองสิทธิ์โปรโมชั่นสำหรับรอบ 22 ส.ค. 2026 ไว้ก่อนไหมคะ?", approved), []);
  assert.deepEqual(findPriceViolations("รอบวันเสาร์ 22 สิงหาคม 2569 ชำระก่อนได้เลยค่ะ", approved), []);
});

test("v1.4.9: ราคานอกตารางยังถูกบล็อกเหมือนเดิม (กัน fail-open)", () => {
  const approved = new Set([12900, 9900, 4900]);
  assert.ok(findPriceViolations("คลาสนี้ 5900 บาทค่ะ", approved).length > 0);
  assert.ok(findPriceViolations("ลดเหลือ 4,990 บาท", approved).length > 0);
  // เลขราคาที่เขียนใกล้ชื่อเดือนแต่มีคำอื่นคั่น ยังต้องบล็อก
  assert.ok(findPriceViolations("ราคา ส.ค. นี้ 77,000 บาท", approved).length > 0);
  // ราคาอนุมัติต้องไม่ถูกจับ
  assert.deepEqual(findPriceViolations("ยอดชำระ 12,900 บาทค่ะ", approved), []);
});

test("v1.4.9b (รีวิว 2026-08-17): ราคานอกตารางติดชื่อเดือน = ยังบล็อก (กัน fail-open)", () => {
  const approved = new Set([12900, 9900, 4900]);
  // เดิม (v1.4.9) ยกเว้นทุกเลขติดเดือน -> ราคาหลุด. ต้องบล็อกกลับ
  assert.ok(findPriceViolations("โปรเดือน ส.ค. 5,900 บาท", approved).length > 0);
  assert.ok(findPriceViolations("ราคาพิเศษเดือนสิงหาคม 15,900 บาท", approved).length > 0);
  assert.ok(findPriceViolations("จ่าย 5,000 ส.ค.", approved).length > 0);
  assert.ok(findPriceViolations("เดือน ส.ค. 5900 บาท", approved).length > 0);
  // วันที่จริงยังผ่าน (วัน 1-31 / ปี 4 หลัก ไม่มี comma)
  assert.deepEqual(findPriceViolations("รอบ 22 ส.ค. 2026 ค่ะ", approved), []);
  assert.deepEqual(findPriceViolations("เสาร์ 22 สิงหาคม 2569", approved), []);
});

/* ---- v1.4.10 (เคสจริงคุณ Kunjinda 2026-08-17): เล่าโจทย์งาน ≠ แจ้งชำระเงิน ---- */

test("v1.4.10: เล่าโจทย์ให้ AI อ่านสลิป/ออกใบเสร็จ = ไม่ใช่ payment (เคสจริงโดน escalate ปลอม)", () => {
  const route = routeMessage({
    text: "และนำมาใช้กับงานระบบบัญชี; 1. อ่านสลิป ยอดเงินเข้าออก เทียบกับ statementให้ตรงกัน 2. นำส่งเพื่อแปลงเป็นไฟล์ excel ออกใบแจ้งหนี้, ใบเสร็จรับเงิน, ใบหัก ณ ที่จ่าย เพื่อต้องการแก้ไขปัญหาเอกสารตกหล่นค่ะ",
  });
  assert.notEqual(route?.route, "payment", "โจทย์งานบัญชีต้องไม่โดนจับเป็นการแจ้งโอน");
});

test("v1.4.10: อยากให้ AI ช่วยอ่านสลิป = use-case ไม่ใช่ payment แต่การจ่ายจริงยังจับครบ", () => {
  assert.notEqual(routeMessage({ text: "อยากให้ AI ช่วยอ่านสลิปเทียบ statement ค่ะ" })?.route, "payment");
  assert.notEqual(routeMessage({ text: "ในคลาสสอนออกใบเสร็จอัตโนมัติไหมคะ" })?.route, "payment");
  // การกระทำจ่ายจริงต้องจับเสมอ — แม้มีคำว่า AI/คลาสปนอยู่
  assert.equal(routeMessage({ text: "โอนแล้วนะคะ เดี๋ยว AI อ่านสลิปให้หน่อย" }).route, "payment");
  assert.equal(routeMessage({ text: "แนบสลิปไว้ให้แล้วค่ะ" }).route, "payment");
  assert.equal(routeMessage({ text: "ส่งสลิปแล้วนะคะ" }).route, "payment");
  assert.equal(routeMessage({ text: "สลิปโอนเงินค่ะ" }).route, "payment", "คำนามเงินโดด ๆ ไม่มีบริบทโจทย์ = จับเหมือนเดิม");
  assert.equal(routeMessage({ text: "ขอใบเสร็จหน่อยค่ะ" }).route, "payment", "ขอใบเสร็จ = เรื่องเงินจริง");
});

/* ---- v1.4.11: ลูกค้าขอคุยกับคนจริง = route เดียว template เดียว (เคสลูกค้า A) ---- */

test("v1.4.11: อยากคุยกับคน/ขอแอดมิน = human_handoff + escalate human_requested", () => {
  for (const text of ["อยากคุยกับคน", "ขอคุยกับแอดมินหน่อยค่ะ", "อยากคุยกับพี่ง้วงครับ", "ให้คนจริงมาตอบหน่อย", "ขอคุยกับคนจริงหน่อยค่ะ", "อยากคุยกับคนครับ"]) {
    const route = routeMessage({ text });
    assert.equal(route?.route, "human_handoff", `"${text}" ต้องเข้า human_handoff`);
    assert.equal(route.escalate.reason, "human_requested");
    assert.match(route.template, /ทีมงานคนจริง/u);
  }
  // ประโยคปกติที่มีคำว่า "คน" ห้ามโดน
  for (const text of ["คนเรียนเยอะมั้ยคะ", "มีคนสอนกี่คน", "เรียนกับคนอื่นได้ไหม"]) {
    assert.notEqual(routeMessage({ text })?.route, "human_handoff", `"${text}" ต้องไม่โดน`);
  }
});

test("v1.4.11b (audit): objection ปรึกษาคนรอบตัว + ประโยคขายที่มีคำ 'คุยกับคนจริง' ห้ามโดน handoff", () => {
  for (const text of [
    "ขอคุยกับคนที่บ้านก่อนนะคะ",
    "อยากคุยกับคนอื่นก่อนค่ะ",
    "ขอคุยกับคนที่เคยเรียนได้ไหมคะ",
    "อยากได้บอทที่ตอบเหมือนคุยกับคนจริงเลยค่ะ มีสอนไหมคะ",
    "ลูกค้าร้านผมไม่อยากคุยกับบอทเลย มีคลาสไหนแนะนำ",
  ]) {
    assert.notEqual(routeMessage({ text })?.route, "human_handoff", `"${text}" คือ objection/ประโยคขาย ห้ามปิด AI`);
  }
});

test("v1.4.11b (audit): คำถามตัวตนที่มีคำแทรก = identity ไม่ใช่ handoff", () => {
  for (const text of ["นี่คุยกับคนจริงอยู่ใช่ไหมคะ", "คุยกับคนจริงใช่มั้ยคะ", "ตอนนี้เราคุยกับคนจริงกันอยู่หรอ", "คนจริงหรือบอทคะ"]) {
    const route = routeMessage({ text });
    assert.equal(route?.route, "identity", `"${text}" คือคำถามตัวตน ต้องตอบเปิดเผย ไม่ใช่ปิด AI`);
  }
});

/* ---- v1.4.23: journey จับ handoff ที่หลุด (2026-08-19) ---- */

test("v1.4.23: 'คุยกับคนจริง' ที่มีคำต่อท้าย + ขอให้ทีมโทรกลับ = handoff", async () => {
  const { routeMessage } = await import("../src/safetyRouter.mjs");
  const route = (text) => routeMessage({ text, rules: [] })?.escalate?.reason ?? "";
  // เคสจริงจาก journey — เดิมหลุดเพราะ pattern ผูกท้ายประโยค
  assert.equal(route("เอาเป็นว่าขอคุยกับคนจริงเลยดีกว่าครับ แบบนี้ผมคุยกับบอทไม่จบ"), "human_requested");
  assert.equal(route("งั้นรบกวนให้ทีมโทรหาผมเลยได้มั้ยครับ เบอร์ 081-234-5678"), "human_requested");
  assert.equal(route("ขอให้แอดมินติดต่อกลับหน่อยครับ"), "human_requested");
  // ต้องไม่ชนเคสที่ไม่ใช่การขอ handoff (บทเรียนแบทช์ 2 — ปิด AI ผิดเคส = ฆ่าลีด)
  assert.notEqual(route("ขอคุยกับคนที่บ้านก่อนนะครับ"), "human_requested");
  assert.notEqual(route("ขอคุยกับทีมงานผมก่อนครับ"), "human_requested");
  assert.notEqual(route("ลูกค้าร้านผมไม่อยากคุยกับบอทเลย มีคลาสไหนแนะนำ"), "human_requested");
  assert.notEqual(route("ไม่ต้องต่อสายแอดมิน ถามตรงนี้แหละ"), "human_requested");
});

// ---- v1.4.49 (เคสจริงห้องเจ้าของ 2026-08-24 15:53): บอทถามเอง "ต้องการออกเอกสารในนาม
// บุคคลธรรมดาหรือบริษัทคะ?" ลูกค้าตอบ "ออกใบกำกับครับ" -> เดิมยิง PAYMENT_DOC_TEMPLATE
// + พัก AI 60 นาที ทั้งที่ยังไม่มีการจ่ายเงิน และกลืนคำถามส่วนลดที่มาคู่กันหายทั้งก้อน
//
// audit adversarial 2 รอบชี้ว่าออกแบบครั้งแรกกลับขั้วเป็น fail-open (ทุกคำที่นึกไม่ถึง =
// เงินหลุด) จึงเปลี่ยนเป็น allowlist แคบ: ผ่อนปรนเฉพาะตอน "บอทเพิ่งถามคำถามเอกสารเอง"
// ทุกเทสต์ด้านล่างล็อกทั้งสองทิศ — เคสจริงต้องหาย และเงินต้องไม่หลุดแม้แต่เคสเดียว ----
const DOC_Q = "คุณลูกค้า ต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?";

test("ตัวจับคำถามเอกสารของบอท: จับข้อความจริงที่ลูกแพรถาม ทั้งสองสำนวน", () => {
  assert.equal(isDocumentNameQuestion(DOC_Q), true);
  assert.equal(isDocumentNameQuestion("ต้องการออกใบกำกับภาษีในนามบุคคลธรรมดาหรือบริษัทคะ?"), true);
  assert.equal(isDocumentNameQuestion("สนใจรอบไหนดีคะ"), false, "คำถามอื่นต้องไม่ปลดล็อกเส้นเงิน");
});

test("เคสจริง: ลูกค้าตอบคำถามเอกสารของบอท ต้องไม่ปิด AI และไม่ยิง template เอกสาร", () => {
  const ctx = { paymentStarted: false, botAskedDocQuestion: true };
  for (const text of ["ออกใบกำกับครับ", "มา 2 ท่าน มีส่วนลดไหมครับ\nออกใบกำกับครับ", "บริษัทครับ ออกใบกำกับในนามบริษัท"]) {
    const r = routeMessage({ text, ...ctx });
    assert.notEqual(r.route, "payment", `ยังถูกเส้นเงินยึด: ${text}`);
    assert.equal(r.escalate, null);
  }
});

test("ถ้าบอทไม่ได้ถามคำถามเอกสาร = พฤติกรรมเดิมเป๊ะ (ไม่มีการผ่อนปรนลอย ๆ)", () => {
  for (const text of ["ออกใบกำกับครับ", "บริษัทครับ ออกใบกำกับในนามบริษัท"]) {
    assert.equal(routeMessage({ text, paymentStarted: false, botAskedDocQuestion: false }).route, "payment", text);
    assert.equal(routeMessage({ text }).route, "payment", `ไม่ส่งบริบทมาเลยก็ต้องเดิม: ${text}`);
  }
  // จ่ายเงินแล้ว = เอกสารจริง แม้บอทเพิ่งถามก็ตาม
  assert.equal(routeMessage({ text: "ออกใบกำกับครับ", paymentStarted: true, botAskedDocQuestion: true }).route, "payment");
});

test("เงินห้ามหลุดแม้บอทเพิ่งถามคำถามเอกสาร — ครบทุกเคสที่ audit 2 รอบจับได้", () => {
  const ctx = { paymentStarted: false, botAskedDocQuestion: true };
  const mustEscalate = [
    // ตามเอกสารหลังจ่าย
    "ยังไม่ได้ใบกำกับภาษีเลยครับ", "ตามใบกำกับที่คุยไว้ครับ", "แก้ไขใบกำกับภาษีหน่อยครับ ชื่อบริษัทผิด",
    "ที่อยู่ออกใบกำกับตามนี้นะคะ 123/4", "ใบกำกับยังไม่มาเลยครับ", "ใบเสร็จหายครับ ขอใหม่",
    "ต้องการใบกำกับภาษีครับ", "อยากได้ใบกำกับภาษีด้วยครับ", "ฝากออกใบกำกับให้ด้วยนะครับ",
    // ประกาศว่าจ่ายไปแล้วในรูปอดีต (PAYMENT_ACTION จับไม่ได้)
    "ใบเสร็จค่าคอร์สที่จ่ายไปเมื่อวานครับ", "เงินออกจากบัญชีแล้ว ใบเสร็จครับ",
    "ตัดเงินไปแล้ว ใบกำกับภาษีครับ", "ใบกำกับภาษีค่าอบรมที่ชำระไปครับ", "เรียบร้อยแล้วครับ ใบกำกับ",
    // ตามย้อนหลัง / แก้ไข / ทวง / เบิก-ลดหย่อน
    "ใบเสร็จเดือนที่แล้วครับ", "ใบกำกับย้อนหลังปีที่แล้วครับ", "ใบกำกับผิดชื่อครับ",
    "ใบกำกับภาษีเมื่อไหร่จะได้", "ใบเสร็จล่ะครับ", "เอาใบเสร็จไปเบิกครับ", "ใบกำกับภาษีเอาไปลดหย่อนภาษีครับ",
    // คำขอแบบไม่มีคำว่า "ขอ"
    "ใบกำกับหน่อยครับ", "ใบเสร็จหน่อยค่ะ", "เอาใบกำกับด้วยครับ", "ใบกำกับด้วยนะคะ",
    // คำพิมพ์ผิดของใบเสร็จ = การแจ้งเงินเสมอ (v1.4.44)
    "ไบเสดครับ", "ใบเสด ครับ",
    // หลักฐานการโอน รวมคำพิมพ์ผิด/พาราเฟรส
    "หลักฐานโอนตามนี้ครับ ใบกำกับออกในนามบริษัท", "สลิบครับ ใบกำกับด้วยนะ",
    "สริปค่ะ ใบเสร็จด้วยนะคะ", "ตามรูปที่ส่งไปนะครับ ออกใบกำกับด้วย",
    // ตัวอักษรความกว้างศูนย์แทรกกลางคำ (เลี่ยงตัวกรอง)
    "ข\u200bอใบกำกับภาษีครับ", "ยังไม่ไ\u200bด้ใบกำกับเลยครับ", "ใบกำกับ ส\u200bลิปครับ", "ที่อ\u200bยู่ในใบกำกับผิดครับ",
    // เส้นเงินคลาสสิกต้องไม่กระทบ
    "โอนแล้วนะครับ ออกใบกำกับด้วย", "ส่งสลิปแล้วครับ", "ยอดเข้ารึยังครับ",
  ];
  for (const text of mustEscalate) {
    assert.equal(routeMessage({ text, ...ctx }).route, "payment", `เงินหลุด: ${JSON.stringify(text)}`);
  }
});

test("คำถามความสามารถก่อนซื้อต้องไม่ถูกปิด AI (กันซ้ำรอย v1.4.44 ฆ่าลีด)", () => {
  const asks = [
    "ออกใบกำกับภาษีได้ไหมคะ", "ออกใบกำกับภาษีเต็มรูปแบบได้ไหมคะ", "มีใบกำกับภาษีเต็มรูปไหมครับ",
    "ผ่อนเป็นงวดได้มั้ย มีใบกำกับภาษีไหมคะ", "ส่งให้ทางอีเมลได้ไหมคะ ออกใบกำกับภาษีได้มั้ย",
    "ถ้าเอกสารหาย ออกใบกำกับใหม่ได้ไหมคะ",
  ];
  for (const text of asks) {
    assert.notEqual(routeMessage({ text, paymentStarted: false }).route, "payment", `ฆ่าลีด: ${text}`);
  }
});

test("ข้อความยาวไม่ใช่ 'คำตอบ' — ต้องกลับไปเส้นเดิมแม้บอทเพิ่งถาม", () => {
  const long = "ออกใบกำกับครับ พอดีบริษัทผมมีขั้นตอนเยอะมากเลยต้องขอเอกสารล่วงหน้าก่อนทุกครั้งนะครับ ขอบคุณครับ";
  assert.equal(routeMessage({ text: long, paymentStarted: false, botAskedDocQuestion: true }).route, "payment");
});
