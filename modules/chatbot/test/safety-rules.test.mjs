// กฎฉุกเฉินเฉพาะธุรกิจ (SAFETY_RULES_FILE) — เคสจริงจาก Airdog dev test 2026-08-09:
// "เครื่องมีกลิ่นไหม้" ต้องเข้าเส้นทาง deterministic ก่อนถึง AI เสมอ
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { routeMessage, loadSafetyRules, templateAfterEscalation, isPaymentActionText, PAYMENT_TEMPLATE, PAYMENT_DOC_TEMPLATE } from "../src/safetyRouter.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {} };

const FIRE_RULE = {
  keywords: ["กลิ่นไหม้", "ควัน", "ประกายไฟ", "ไฟช็อต"],
  template: "เพื่อความปลอดภัยรบกวนถอดปลั๊กและหยุดใช้เครื่องทันทีนะคะ ทีมงานจะรีบติดต่อกลับด่วนที่สุดค่ะ",
  reason: "device_fire",
};

test("routeMessage: extra rule ชนะทุกอย่าง แม้ข้อความมีคำว่าราคาปนมา", () => {
  const route = routeMessage({ text: "ราคาเท่าไหร่ครับ แล้วเครื่องผมมีกลิ่นไหม้ด้วย", extraRules: [FIRE_RULE] });
  assert.equal(route.route, "urgent");
  assert.equal(route.intent, "device_fire");
  assert.ok(route.template.includes("ถอดปลั๊ก"));
  assert.equal(route.escalate.reason, "device_fire");
});

test("routeMessage: ไม่มี extra rule -> ข้อความเดิมไปเส้นทาง AI ปกติ (ไม่ใช่ urgent)", () => {
  const route = routeMessage({ text: "ราคาเท่าไหร่ครับ แล้วเครื่องผมมีกลิ่นไหม้ด้วย" });
  assert.notEqual(route.route, "urgent");
});

test("loadSafetyRules: อ่านไฟล์จริง + ข้าม rule ที่ไม่ครบ + ไฟล์พังคืน []", () => {
  const dir = mkdtempSync(join(tmpdir(), "afl-safety-"));
  const file = join(dir, "rules.json");
  writeFileSync(file, JSON.stringify([FIRE_RULE, { keywords: [], template: "x" }, { template: "no-kw" }]));
  const rules = loadSafetyRules(file, { logger: silent });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].reason, "device_fire");
  writeFileSync(file, "{not-json");
  assert.deepEqual(loadSafetyRules(file, { logger: silent }), []);
  assert.deepEqual(loadSafetyRules("", { logger: silent }), []);
  rmSync(dir, { recursive: true, force: true });
});

test("pipeline e2e: กลิ่นไหม้ -> template ถอดปลั๊กถูกส่ง, Hermes ไม่ถูกเรียก, NEEDS_HUMAN", async () => {
  const config = testConfig();
  const db = memoryDb();
  const hermesFetch = hermesFetchStub();
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {}, safetyRules: [FIRE_RULE] },
    logger: silent,
  });
  const result = await app.pipeline.handleInboundText({
    customerId: "Ufire", text: "Airdog X5 ราคาเท่าไหร่ครับ แล้วเครื่องมีกลิ่นไหม้ด้วย", replyToken: "rt-f",
  });
  assert.equal(result.sent, true);
  assert.equal(result.deterministic, true);
  assert.equal(result.intent, "device_fire");
  assert.equal(hermesFetch.calls.length, 0, "เคสไฟไหม้ห้ามผ่าน model");
  const sentText = lineFetch.calls.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(sentText.includes("ถอดปลั๊ก"));
  assert.equal(db.getCustomer("Ufire").state, "NEEDS_HUMAN");
  db.close();
});

// ---- v1.2.2 (เคสจริง 2026-08-12): ภาษาไทยไม่เว้นวรรค คีย์เวิร์ดจึงชนคำอื่นได้ ----
test("v1.2.2: excludeKeywords กันคีย์เวิร์ดชนบริบทอื่น ('ใบเสนอราคา' ไม่ใช่การถามค่าเรียน)", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-exclude-"));
  const file = join(dir, "rules.json");
  try {
    writeFileSync(file, JSON.stringify([{
      keywords: ["ราคา"],
      excludeKeywords: ["ใบเสนอราคา"],
      template: "เรื่องราคาต้องให้ทีมงานยืนยันค่ะ",
      reason: "price_requires_human",
    }]), "utf8");
    const rules = loadSafetyRules(file);
    assert.equal(rules[0].excludeKeywords.length, 1);
    assert.equal(routeMessage({ text: "เอกสาร ทำใบเสนอราคา ครับ", extraRules: rules }).template, null);
    assert.equal(routeMessage({ text: "ราคาเท่าไหร่คะ", extraRules: rules }).intent, "price_requires_human");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// v1.2.2: ตัดคำสัญญาแล้วต้องเหลือ "ประโยคที่จบจริง" ไม่ใช่เศษคำ
// (เคสจริง: template ที่ขึ้นต้นด้วย "ลูกแพรบันทึก..." เคยเหลือแค่คำว่า "ลูก")
test("v1.2.2: template ที่ส่งต่อไม่สำเร็จ ต้องไม่ปล่อยเศษประโยคถึงลูกค้า", () => {
  const payment = "ลูกแพรบันทึกเรื่องการชำระเงินไว้ให้ทีมงานตรวจแล้วนะคะ ทีมงานจะยืนยันกลับให้อีกครั้งค่ะ";
  const degraded = templateAfterEscalation(payment, false);
  assert.equal(degraded, "ข้อมูลนี้ต้องให้ทีมงานยืนยันค่ะ");

  const custom = "งานแบบนี้พี่ง้วงกับทีมงานดูแลเองโดยตรงค่ะ รบกวนขอเบอร์โทรและช่วงเวลาที่สะดวกให้ทีมงานหน่อยนะคะ ติดต่อกลับไปคุยรายละเอียดให้ค่ะ";
  const customDegraded = templateAfterEscalation(custom, false);
  assert.match(customDegraded, /ขอเบอร์โทรและช่วงเวลาที่สะดวก/u, "คำขอเบอร์ต้องรอด (ไม่ใช่คำสัญญา)");
  assert.doesNotMatch(customDegraded, /ติดต่อกลับ/u, "คำสัญญาว่าจะโทรกลับต้องถูกตัดเมื่อไม่มี receipt");
  assert.match(customDegraded, /ค่ะ$/u, "ต้องจบประโยคสุภาพเสมอ");
});

// v1.2.5 (ตรวจอิสระ 2026-08-13): ตัวดักคำแบบ substring ในภาษาไทยยิงผิดเป้าเสมอ
test("v1.2.5: ลูกค้าเล่า pain ตัวเองว่า 'แย่มาก' ต้องไม่ถูกตีเป็นข้อร้องเรียน", () => {
  assert.equal(routeMessage({ text: "ตอนนี้เขียนคอนเทนต์เองแย่มากเลยครับ" }).route, "ai");
  assert.equal(routeMessage({ text: "ยอดขายเดือนนี้แย่มากครับ อยากใช้ AI ช่วย" }).route, "ai");
  assert.equal(routeMessage({ text: "บริการแย่มาก ไม่พอใจเลย" }).route, "complaint");
});

test("v1.2.5: คำว่า AI ในบทสนทนาคอร์ส AI ต้องไม่ยิง template ถามตัวตน", () => {
  assert.equal(routeMessage({ text: "สนใจคลาส AI agent for business ครับ" }).route, "ai");
  assert.equal(routeMessage({ text: "อยากเรียนใช้ AI ครับ เป็น AI agent ได้ไหม" }).route, "ai");
  assert.equal(routeMessage({ text: "นี่บอทหรือเปล่าคะ" }).route, "identity");
  assert.equal(routeMessage({ text: "คุณเป็น AI ใช่ไหม" }).route, "identity");
});

// v1.4.29 (eval แบทช์ 6 จับได้ 2026-08-19): ลูกค้าสั่งตรง ๆ พร้อมเอ่ยคำว่า "บอท"
// ในประโยคเดียวกัน — เดิมเส้น "คำถามตัวตน" ชนะ แล้วตอบว่า "ถ้าอยากคุยกับทีมงานคนจริง
// บอกลูกแพรได้เลยค่ะ" ทั้งที่ลูกค้าเพิ่งบอกไปแล้ว = บังคับให้ลูกค้าขอซ้ำ
// และ AI ยังเปิดคุยต่อทั้งที่ state เป็น NEEDS_HUMAN แล้ว
//
// เทสต์นี้ต้องแดงกับโค้ดก่อน v1.4.29 — และต้องกันไม่ให้แก้เกินจนปิด AI ผิดเคส
// (บทเรียนแบทช์ 2: เคยพยายามแก้เรื่องเดียวกันแล้วชนประโยคปกติจนต้อง revert)
test("v1.4.29: คำสั่งขอคนจริงชนะคำถามตัวตน แต่ต้องไม่กินประโยคปกติ", async () => {
  const { routeMessage } = await import("../src/safetyRouter.mjs");
  const route = (text) => routeMessage({ text }).route;

  // ต้องส่งต่อคนจริง — ลูกค้าสั่งเอง ไม่ได้แค่สงสัย
  assert.equal(route("โอเคครับ ขอคุยกับคนจริงหน่อยได้มั้ย ไม่อยากคุยกับบอท"), "human_handoff");
  assert.equal(route("ขอคุยกับคนจริงหน่อย ไม่อยากคุยกับ ai"), "human_handoff");
  assert.equal(route("เอาคนมาคุยหน่อยค่ะ"), "human_handoff");

  // ยังต้องเป็นคำถามตัวตนเหมือนเดิม — ไม่มีคำขอ แค่สงสัยว่าคุยกับใครอยู่
  assert.equal(route("นี่บอทหรอครับ"), "identity");
  assert.equal(route("คุยกับคนจริงอยู่ป่าวคะ"), "identity");

  // ห้ามปิด AI: เล่าโจทย์ธุรกิจ / ปฏิเสธ handoff / หมายถึงทีมของลูกค้าเอง
  assert.equal(route("ลูกค้าร้านผมไม่อยากคุยกับบอทเลย ทำไงดี"), "ai");
  assert.equal(route("ไม่ต้องต่อสายแอดมินนะครับ"), "ai");
  assert.equal(route("ขอคุยกับทีมงานผมก่อนนะครับ"), "ai");
});

/* ============ v1.4.38: "ขอคนหน่อย" — สำนวนสั้นที่สุดที่เคยหลุดทั้งหมด ============ */
//
// เจอโดย probe-handoff-09 (2026-08-19): ลูกค้าพิมพ์ "ไม่อยากคุยกับบอทแล้ว ขอคนหน่อยค่ะ"
// บอทตอบว่า "ขอส่งต่อให้ทีมงานคนจริงเข้ามาดูแล" แต่ AI ไม่ปิด แล้วคุยต่อในเทิร์นถัดไป
// ต้นเหตุ: ทุก pattern เดิมบังคับว่าต้องมีกริยาตามหลังคำว่า "คน" (ตอบ/คุย/ดูแล/ช่วย)
// "ขอคนหน่อย" จึงหลุดหมด ทั้งที่เป็นสำนวนที่สั้นและเป็นธรรมชาติที่สุดในไลน์

const SHORT_HUMAN_REQUESTS = [
  "ไม่อยากคุยกับบอทแล้ว ขอคนหน่อยค่ะ",
  "ขอคนหน่อยค่ะ",
  "ขอพนักงานหน่อยค่ะ",
  "เรียกแอดมินหน่อยครับ",
  "ขอคนจริงที",
];

for (const line of SHORT_HUMAN_REQUESTS) {
  test(`handoff สั้น: ปิด AI ให้คนจริง — "${line.slice(0, 34)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.escalate?.reason, "human_requested");
  });
}

// ฝั่งปล่อย — "ขอคน" ที่ไม่ได้แปลว่าขอคุยกับคนจริง ถ้าจับผิดจะปิด AI ใส่ลูกค้าที่ยังคุยดีอยู่
// ซึ่งเป็นความเสียหายที่แพงกว่าการพลาดจับ (บทเรียนแบทช์ 2)
const NOT_HUMAN_REQUESTS = [
  "ขอคนละ 1 ที่นั่งได้ไหมคะ",
  "ทีมผมขอคนเพิ่มอีก 2 คนครับ",
  "ไม่ต้องต่อสายแอดมินนะครับ",
  "ขอคุยกับคนที่บ้านก่อนนะคะ",
  "อยากให้ทีมงานของผมมาเรียนด้วยครับ",
];

for (const line of NOT_HUMAN_REQUESTS) {
  test(`handoff สั้น: ไม่ปิด AI ผิดเคส — "${line.slice(0, 34)}…"`, () => {
    assert.notEqual(routeMessage({ text: line })?.escalate?.reason, "human_requested");
  });
}

/* ====== v1.4.40: "แล้ว" ที่แปลว่า "then" ไม่ใช่ "เสร็จแล้ว" ====== */
//
// เคสจริง 2026-08-21: "ถ้าผมไม่จ่ายแล้วแอบเข้าไปเรียนได้มั้ย" ตรงกับ /จ่ายแล้ว/
// บอทจึงตอบด้วยแม่แบบแจ้งโอนที่ขึ้นต้นว่า "ได้เลยค่ะ 🙏" = อ่านได้ว่าอนุญาตให้แอบเข้าเรียน
// ถ้าลูกค้าแคปไปโพสต์คือเสียหายต่อชื่อเสียงทันที
//
// ฝั่ง "ต้องจับ" สำคัญกว่าฝั่งปล่อยในไฟล์นี้ — พลาดจับ = เงินลูกค้าหาย ไม่มีคนตรวจสลิป
// จึงล็อกทุกสำนวนแจ้งโอนที่เจอในข้อความลูกค้าจริง 13,558 ข้อความไว้ด้วย

for (const line of [
  "ถ้าผมไม่จ่ายแล้วแอบเข้าไปเรียนได้มั้ย",
  "ถ้าไม่โอนแล้วไปเรียนเลยได้ไหม",
  "ยังไม่ได้จ่ายแล้วจะเรียนได้มั้ย",
  "ยังไม่โอนแล้วจองที่ไว้ก่อนได้ไหม",
]) {
  test(`payment: "แล้ว" หลังคำปฏิเสธ ไม่ใช่การแจ้งโอน — "${line.slice(0, 32)}…"`, () => {
    assert.equal(isPaymentActionText(line), false);
  });
}

for (const line of [
  "โอนแล้วนะครับ",
  "โอนเรียบร้อยแล้วค่ะ",
  "ชำระเงินแล้วค่ะ",
  "จ่ายเงินแล้วครับ",
  "ส่งสลิปให้แล้วนะคะ",
  "แจ้งโอนครับ",
  "โอนแล้วครับ ถ้ามีปัญหาบอกได้ไหม",
]) {
  test(`payment: การแจ้งโอนจริงต้องจับได้เสมอ — "${line.slice(0, 32)}…"`, () => {
    assert.equal(isPaymentActionText(line), true);
  });
}

/* ===== v1.4.40: ขอเอกสาร ไม่ใช่การแจ้งโอน — ต้องคนละถ้อยคำ ===== */
//
// เดิมทุกอย่างที่มีคำว่าสลิป/ใบเสร็จ ได้แม่แบบเดียวกับการแจ้งโอน ผลคือ
// "ขอใบเสร็จย้อนหลังปีที่แล้ว" -> "ได้เลยค่ะ โอนเรียบร้อยแล้วส่งสลิปมา" = ตอบไม่ตรงคำถาม
// การส่งต่อคนถูกแล้ว (เอกสารต้องให้คนออก) แต่ถ้อยคำต้องตรงกับสิ่งที่ลูกค้าขอ

for (const line of ["โอนแล้วนะครับ", "ส่งสลิปให้แล้วนะคะ", "แจ้งโอนครับ"]) {
  test(`payment: แจ้งโอน -> แม่แบบขอสลิป — "${line}"`, () => {
    assert.equal(routeMessage({ text: line })?.template, PAYMENT_TEMPLATE);
  });
}

for (const line of ["ขอใบเสร็จด้วยค่ะ", "ขอใบเสร็จย้อนหลังปีที่แล้ว จะเอาไปลดหย่อนภาษี"]) {
  test(`payment: ขอเอกสาร -> แม่แบบรับเรื่องเอกสาร — "${line.slice(0, 30)}…"`, () => {
    const route = routeMessage({ text: line });
    assert.equal(route?.template, PAYMENT_DOC_TEMPLATE);
    // ยังต้องส่งต่อคนเหมือนเดิม — เอกสารต้องให้คนออก ห้ามให้ AI รับปากเอง
    assert.equal(route?.intent, "payment_review");
  });
}

/* ===== v1.4.42: เล่าเนื้องานตัวเอง ไม่ใช่เรื่องจ่ายเงินกับเรา ===== */
//
// เคสจริงบน VPS 2026-08-21 23:42 — รุนแรงที่สุดเท่าที่เจอมา
// บอทถามเองว่า "งานส่วนไหนใช้เวลามากที่สุดในแต่ละวันคะ?"
// ลูกค้าตอบ "เอกสารครับ ทำใบเสร็จ และใบวางบิล" -> ระบบอ่านเป็นเรื่องจ่ายเงิน
// -> escalate payment_review -> ปิด AI ถาวรกลางบทสนทนา ทั้งที่ยังไม่มีการซื้อขายใด ๆ
//
// ฝั่ง "ต้องยังจับ" สำคัญกว่าเสมอในไฟล์นี้ — พลาดจับ = ไม่มีคนตรวจสลิป เงินลูกค้าค้าง

for (const line of [
  "เอกสารครับ ทำใบเสร็จ และใบวางบิล",
  "งานประจำผมคือทำใบเสร็จกับพิมพ์ใบวางบิลครับ",
  "ทุกวันต้องคีย์ใบแจ้งหนี้เป็นร้อยใบเลยครับ",
]) {
  test(`payment: เล่าเนื้องานตัวเอง ต้องไม่ปิด AI — "${line.slice(0, 34)}…"`, () => {
    assert.notEqual(routeMessage({ text: line })?.route, "payment");
  });
}

for (const line of [
  "ขอใบเสร็จด้วยค่ะ",
  "รบกวนทำใบเสร็จให้หน่อยครับ",
  "ออกใบเสร็จรับเงินกับใบกำกับภาษีสำหรับบริษัทได้ใช่มั้ยครับ",
  "ส่งสลิปให้แล้วนะคะ",
  "โอนแล้วนะครับ",
]) {
  test(`payment: เรื่องเงิน/เอกสารกับเรา ต้องยังจับได้ — "${line.slice(0, 34)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "payment");
  });
}

/* ===== v1.4.42 (รอบตรวจละเอียด): โรคเดียวกันนี้อยู่ในเส้นอื่นด้วย ===== */
//
// หลังแก้เคสใบวางบิล จึงไล่ตรวจ "ทุกเส้นที่ปิด AI ได้" ด้วยข้อความแบบเดียวกัน
// คือลูกค้าตอบคำถาม discovery ของบอทด้วยการเล่าเนื้องานตัวเอง
// พบพลาดเพิ่มอีก 6 เคส กระจายอยู่ 3 เส้น — ไม่ใช่ปัญหาเฉพาะเรื่องเงิน
//
// อาการเหมือนกันหมด: ตัวจับทำงานถูกต้องตามคำที่เห็น แต่บริบทอยู่ในเทิร์นก่อนหน้า
// (คำถามที่บอทถามเอง) ซึ่งตัวจับมองไม่เห็น

for (const line of [
  "งานผมคือตรวจสลิปโอนเงินของลูกค้าทุกวันครับ",
  "ธุรกิจผมต้องเช็คสลิปวันละเป็นร้อยรายการ",
]) {
  test(`payment: เล่าว่างานตัวเองเกี่ยวกับสลิป ต้องไม่ปิด AI — "${line.slice(0, 34)}…"`, () => {
    assert.notEqual(routeMessage({ text: line })?.route, "payment");
  });
}

for (const line of [
  "มีลูกค้าร้องเรียนเข้ามาเยอะ อยากให้ AI ช่วยจัดการ",
  "ลูกค้าผิดหวังมากเวลาของส่งช้าครับ อยากได้ระบบแจ้งเตือน",
  "เคยโดนโกงจากเอเจนซี่ ธุรกิจผมเลยอยากทำระบบเอง",
]) {
  test(`complaint: เล่าปัญหาของธุรกิจตัวเอง ไม่ใช่ร้องเรียนเรา — "${line.slice(0, 34)}…"`, () => {
    assert.notEqual(routeMessage({ text: line })?.route, "complaint");
  });
}

// ข้อร้องเรียนที่พุ่งมาที่เราจริง ต้องยังไปหาคนทันที — ห้ามให้ AI ตอบเอง
for (const line of [
  "ไม่พอใจมากครับ จะฟ้อง",
  "บริการแย่มาก",
  "โดนโกง จ่ายเงินไปแล้วไม่ได้ของ",
]) {
  test(`complaint: ร้องเรียนที่พุ่งมาที่เรา ต้องยังจับได้ — "${line.slice(0, 34)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "complaint");
  });
}

// เส้นฉุกเฉินอันตรายสองทาง: ปิด AI ผิดใส่ลูกค้าที่คุยเรื่องคลาสอยู่ก็เสียหาย
// แต่พลาดจับเหตุจริง = กู้คืนไม่ได้ จึงยกเว้นเฉพาะเมื่อมีวลีเล่าโจทย์ธุรกิจชัดเจนเท่านั้น
for (const line of [
  "ผมทำคลินิกครับ คนไข้โทรมาบอกหายใจไม่ออกบ่อย อยากให้ AI ช่วยคัดกรอง",
  "งานผมรับเคสผู้ป่วยหมดสติครับ อยากให้ AI ช่วยสรุปเวร",
]) {
  test(`urgent: เจ้าของคลินิกเล่าเคสงาน ไม่ใช่เหตุฉุกเฉิน — "${line.slice(0, 34)}…"`, () => {
    assert.notEqual(routeMessage({ text: line })?.route, "urgent");
  });
}

for (const line of [
  "หายใจไม่ออก ช่วยด้วย",
  "แม่หายใจไม่ออก ทำยังไงดี",
  "แน่นหน้าอกมาก",
]) {
  test(`urgent: เหตุฉุกเฉินจริง ต้องยังจับได้ทันที — "${line.slice(0, 34)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "urgent");
  });
}

// เจอระหว่างตรวจรอบเดียวกัน แต่เป็นช่องโหว่ "ทิศตรงข้าม" ที่มีมาก่อนหน้านี้แล้ว
// ตัวกรองบริบทของเส้นเงินมีคำว่า สอน/คลาส/เรียน อยู่ (ตั้งใจไว้สำหรับ "อยากให้ AI ช่วยสอน")
// แต่มันไปกิน "ค่าเรียน/ค่าคลาส" ซึ่งเป็นคำขอใบเสร็จที่พบบ่อยที่สุด เพราะคลาสคือสิ่งที่เราขาย
// ผลคือลูกค้าที่จ่ายเงินแล้วขอใบเสร็จ จะไม่ถูกส่งต่อให้คนจริง
for (const line of [
  "ขอใบเสร็จค่าเรียนครับ",
  "ขอใบเสร็จค่าคลาสด้วยค่ะ",
  "รบกวนขอใบเสร็จค่าอบรมหน่อยครับ",
]) {
  test(`payment: ขอใบเสร็จค่าเรียน ต้องถึงคนจริง — "${line.slice(0, 34)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "payment");
  });
}

// แต่คำขอต้องชนะเฉพาะตอนที่ "ขอเอกสารจากเรา" เท่านั้น
// ถ้าเป็นการเล่าโจทย์ว่าอยากให้ AI ช่วยออกใบเสร็จให้ลูกค้าของเขา ต้องคุยขายต่อได้
test("payment: อยากให้ AI ช่วยออกใบเสร็จในธุรกิจตัวเอง ยังต้องคุยขายต่อ", () => {
  assert.notEqual(
    routeMessage({ text: "อยากให้ AI ช่วยออกใบเสร็จให้ลูกค้าของผมครับ" })?.route,
    "payment",
  );
});

/* ===== v1.4.42: เส้นเลิกติดตาม — คำอังกฤษที่หมายถึงบริการเจ้าอื่น ===== */
//
// เจอจากการไล่คลังแชทจริง 13,558 ข้อความ ไม่ได้เดาเอา
// ลูกค้าถามก่อนซื้อว่า "ผม subscription Claude อยู่ กำลังจะ unsubscribe จำเป็นมั้ย"
// = กำลังถามเรื่องเตรียมเครื่องมือก่อนมาเรียน แต่ระบบอ่านว่าขอเลิกติดตามเรา
// ผลคือตัดคิว follow-up ทิ้ง + ตอบ template ลาจาก ทั้งที่เป็นลีดร้อน
//
// ในคลังทั้งหมด การขอเลิกติดตามจริงมาเป็นภาษาไทย 100% จึงกันเฉพาะคำอังกฤษ
// และไม่แตะแพตเทิร์นไทยเลย

test("optout: unsubscribe ที่พูดถึงบริการเจ้าอื่น ต้องไม่ตัดเราออก (เคสจริง)", () => {
  const text = "คือตอนนี้ผม subscription Claude อยู่ และคิดว่ากำลังจะ unsubscribe ก็เลยถามก่อนว่า จำเป็นมั้ยคับ";
  const result = routeMessage({ text });
  assert.notEqual(result?.route, "optout");
  assert.notEqual(result?.optOut, true, "ห้ามตัดคิว follow-up ของลีดที่กำลังถามก่อนซื้อ");
});

for (const line of ["unsubscribe", "please unsubscribe me"]) {
  test(`optout: unsubscribe ลอย ๆ ที่ไม่ได้พูดถึงเจ้าอื่น ยังต้องจับ — "${line}"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "optout");
  });
}

test("optout: workflow newsletter ของเจ้าของธุรกิจไม่ใช่การถอนความยินยอมของผู้ถาม", () => {
  const text = "ผมกำลังทำ newsletter marketing เพื่อเพิ่ม conversion ให้ธุรกิจ ถ้าส่ง email ไปหาลูกค้าแล้วเขา mark spam หรือ unsubscribe ระบบควรออกแบบอย่างไรครับ";
  const result = routeMessage({ text });
  assert.notEqual(result?.route, "optout");
  assert.notEqual(result?.optOut, true, "ห้ามตั้ง DND จากความเสี่ยงของผู้รับ newsletter ของเขา");
});

for (const line of [
  "ลูกค้าพิมพ์ว่า unsubscribe แล้วระบบต้องเอาออกจากรายชื่อยังไงครับ",
  "ลูกค้าผมบอกว่าอย่าทักมา ระบบควรเอาออกจากรายชื่อยังไงครับ",
  "I do not want to unsubscribe พี่ง้วงนะครับ แค่ถามว่าลูกค้าของผมจะยกเลิกอีเมลไหม",
  "ถ้าใช้ Mailchimp ทำ email campaign แล้วลูกค้ากด unsubscribe ระบบควรทำอะไรต่อครับ",
  "ในคลาสสอนทำ newsletter ที่ลูกค้า mark spam หรือ unsubscribe ไหมครับ",
]) {
  test(`optout: reported/negated/third-party/business context ไม่ใช่ direct consent — "${line.slice(0, 45)}…"`, () => {
    const result = routeMessage({ text: line });
    assert.notEqual(result?.route, "optout");
    assert.notEqual(result?.optOut, true);
  });
}

test("optout: direct unsubscribe ที่พูดถึง email ของตัวเองยังต้องหยุดทัก", () => {
  const result = routeMessage({ text: "unsubscribe my email newsletter" });
  assert.equal(result?.route, "optout");
  assert.equal(result?.optOut, true);
});

for (const text of ["I do not want to unsubscribe", "I do not want to unsubscribe my newsletter"]) {
  test(`optout: English negation is not direct consent withdrawal — ${text}`, () => {
    const result = routeMessage({ text });
    assert.notEqual(result?.optOut, true);
    assert.notEqual(result?.route, "optout");
  });
}

test("optout: multiline quote preserves reported customer subject around bare unsubscribe", () => {
  const result = routeMessage({ text: "ลูกค้าพิมพ์ว่า\nunsubscribe\nระบบต้องเอาออกจากรายชื่อยังไงครับ" });
  assert.notEqual(result?.optOut, true);
  assert.notEqual(result?.route, "optout");
});

for (const text of [
  "ลูกค้าพิมพ์ว่า please unsubscribe me แล้วระบบต้องเอาออกจากรายชื่อยังไงครับ",
  "ลูกค้าพิมพ์ว่า\nplease unsubscribe me\nแล้วระบบต้องเอาออกจากรายชื่อยังไงครับ",
  "Customer said\nplease unsubscribe me\nthen how should the workflow remove them?",
  "Customer said:\nplease unsubscribe me",
  "ลูกค้าพิมพ์ว่า:\nplease unsubscribe me",
  "ลูกค้าพิมพ์ว่า\nแต่สำหรับผม ไม่ต้องส่งข้อความมาอีกนะครับ",
]) {
  test(`optout: quoted explicit English command is not the speaker's consent — ${text.includes("\n") ? "multiline" : "inline"}`, () => {
    const result = routeMessage({ text });
    assert.notEqual(result?.optOut, true);
    assert.notEqual(result?.route, "optout");
  });
}

test("optout: workflow newsletter ไม่กลบคำขอหยุดทักจริงในบรรทัดถัดไป", () => {
  const text = [
    "ผมกำลังทำ newsletter marketing เพื่อเพิ่ม conversion ให้ธุรกิจ ถ้าส่ง email ไปหาลูกค้าแล้วเขา mark spam หรือ unsubscribe ระบบควรออกแบบอย่างไรครับ",
    "แต่สำหรับผม ไม่ต้องส่งข้อความมาอีกนะครับ",
  ].join("\n");
  const result = routeMessage({ text });
  assert.equal(result?.optOut, true);
  assert.equal(result?.route, "optout");
});

test("optout: newsletter context remains non-consent when แต่ separates a bare workflow token", () => {
  const text = "ผมทำ newsletter เพื่อเพิ่ม conversion แต่ไม่รู้ว่าส่งจริงไหม ถ้าลูกค้า mark spam หรือ unsubscribe ควรจัดการยังไงครับ";
  const result = routeMessage({ text });
  assert.notEqual(result?.optOut, true);
  assert.notEqual(result?.route, "optout");
});

test("optout: service subscription context ไม่กลบ direct opt-out คนละ clause", () => {
  const result = routeMessage({ text: "ผมมี subscription Claude อยู่. please unsubscribe me" });
  assert.equal(result?.optOut, true);
  assert.equal(result?.route, "optout");
});

for (const line of [
  "ไม่ต้องทักมาแล้วนะคะ",
  "หยุดส่งข้อความหาผมที",
  "อย่าส่งข้อความมาอีก",
  "ยกเลิกการติดตามค่ะ",
]) {
  test(`optout: คำขอเลิกติดตามภาษาไทย ต้องไม่ถูกกระทบ — "${line}"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "optout");
  });
}

/* ===== v1.4.44: audit 360 องศา (2026-08-22) — ระดมหาเคสครบทุกเส้น ===== */
//
// หลังเคสจริง "ทำใบเสร็จ และใบวางบิล" บน VPS จึงตรวจแบบ 360: adversarial 6 มิติ
// + ขุดคลังแชทจริง 13,558 ข้อความ + กรรมการตัดสินตามหลักธุรกิจ
// พบบั๊กจริง 65 เคส (จับพลาด 43 · ปิด AI ผิด 22) — ล็อกไว้ทั้งหมดที่นี่
//
// หลักที่ใช้ตัดสิน (อย่าแก้เทสต์โดยไม่ทบทวนหลักนี้):
// 1. เส้นฉุกเฉิน: "กำลังเกิดตอนนี้/เกิดกับคนในครอบครัว" ชนะทุก guard เพราะพลาดจับ = กู้คืนไม่ได้
//    ส่วนเรื่องเล่าคนไข้/มุกตลก/สำนวน "งานเยอะจนหายใจไม่ออก" ต้องไปต่อได้
// 2. เส้นเงินฝั่งต้องจับ: แจ้งโอน/ชำระทุกสำนวน (รวม typo เเ, "โอนละ", เว้นช่วงคำ) ห้ามหลุด
// 3. ร้องเรียนที่พุ่งมาที่เรา ต้องถึงคนแม้ประโยคมีคำว่า "ใช้ AI" (นักเรียนจริงย่อมพิมพ์)
// 4. คำพูดลูกค้าของเขา / เรื่องเล่าธุรกิจเขา / คำถามฟีเจอร์ที่เราสอน ต้องไปต่อได้เสมอ

// ---- เหตุฉุกเฉินจริง ต้องจับทันที (8 เคส) ----
for (const line of [
  "อาจารย์ครับ ผมลองใช้ AI ถามอาการตัวเองแล้วมันตอบไม่ชัด ตอนนี้เจ็บหน้าอกร้าวไปแขนซ้าย เหงื่อแตก ควรรีบไป รพ. เลยมั้ยครับ",
  "น้องพนักงานร้านผมเป็นลมล้มไปเมื่อกี้ ตอนนี้ยังไม่ฟื้นเลยครับ เขย่าตัวเรียกก็ไม่ตื่น โทรเรียกใครก่อนดี",
  "เดี๋ยวนะคะ ลูกชักเกร็งตาลอยอยู่ตอนนี้ ทำอะไรไม่ถูกเลยค่ะ",
  "ขอโทษที่ถามนอกเรื่องนะคะ พ่ออยู่ ๆ พูดไม่ชัด ปากเบี้ยว ยกแขนไม่ขึ้นข้างนึง แบบนี้ต้องรีบพาไป รพ. เลยมั้ยคะ",
  "ขอโทษนะคะที่มาระบาย ธุรกิจเจ๊งหมดตัว เหนื่อยจนไม่อยากอยู่ต่อแล้วค่ะ คิดวนแบบนี้ทุกคืน",
  "อยู่ที่ห้องสัมมนาตอนนี้ค่ะ ใจสั่นแรงมาก เหงื่อแตกเย็นทั้งตัว จะอ้วกด้วย นั่งพักแล้วไม่ดีขึ้นเลย",
  "พ่อล้มหัวฟาดพื้นค่ะ แผลแตก เลือดไหลเยอะมากกดแล้วก็ไม่หยุด แถวบ้านต้องโทรเบอร์ไหนคะ",
  "ช่วงนี้มีอาการแน่นหน้าอกบ่อย หมอนัดตรวจหัวใจอยู่ค่ะ กลัวเรียนเต็มวันไม่ไหว มีรอบครึ่งวันหรือเรียนออนไลน์แทนได้มั้ยคะ",
]) {
  test(`audit360: urgent — "${line.slice(0, 40)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "urgent");
  });
}

// ---- เรื่องเงินกับเราจริง ต้องถึงคน (16 เคส) ----
for (const line of [
  "โอนค่าเรียนแล้วนะครับ",
  "ลงทะเบียนและชำระเงินเรียบร้อยค่ะ",
  "จ่ายเงินเเล้วครับ",
  "โอนไปตั้งแต่เมื่อวานแล้วครับ ยังไม่ได้ลิงก์เข้ากลุ่มเลย",
  "เมื่อกี้โอนไปนะคะ ยอดเข้ารึยังคะ",
  "รบกวนขอใบกำกับภาษีด้วยนะคะ ทางบัญชีจะเอาไปทำหัก ณ ที่จ่ายค่ะ",
  "โอนเกินไป 1,000 ค่ะ ต้องทำเรื่องขอคืนเงินยังไงคะ",
  "บัตรเครดิตถูกตัดแล้ว แต่ไม่แน่ใจว่าระบบได้รับการยืนยันรึเปล่าครับ",
  "Slip การโอนเงินค่าอบรมค่ะ",
  "แจ้งชำระเงินนะคะ",
  "ส่งหลักฐานการโอนไปทางเมลแล้วนะครับ รบกวนเช็คให้ทีครับ",
  "โอนละคับ",
  "เดี๋ยวเย็นนี้โอนเลยค่ะ ใช้บัญชีเดิมที่เคยส่งให้ใช่มั้ยคะ",
  "เตรียมใบเสร็จ/ใบกำกับไว้ เดี่ยวพี่เข้าไปรับงานเรียน ทีเดียวเลยนะครับ",
  "ทางบัญชีแจ้งว่าจะโอนให้ภายในวันที่ 17 นะคะคุณลูกแพร",
  "โอนเงินออกใบเสดได้ปะคะ",
]) {
  test(`audit360: payment — "${line.slice(0, 40)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "payment");
  });
}

// ---- ร้องเรียนพุ่งมาที่เรา ต้องถึงคน (9 เคส) ----
for (const line of [
  "เรียนจบแล้วลองใช้ AI ทำตามทุกขั้นตอน ทำไม่ได้จริงสักอย่างครับ ผิดหวังมากครับ แบบนี้ต้องขอเงินคืนแล้วนะ",
  "จ้าง consult ให้ทีมพี่ง้วงมาวางระบบของเราให้ แต่บอทตอบมั่วจนลูกค้าประจำหายไปเลยค่ะ ไม่พอใจมากนะคะ",
  "ผมปรึกษาทนายมาแล้วนะครับ ถ้าพรุ่งนี้ยังไม่ได้เงินคืน เจอกันที่ สคบ. แน่นอน",
  "เรียนจบไปแล้วแต่รู้สึกว่าไม่เหมือนที่โฆษณาไว้เลยครับ อยากได้เงินคืน",
  "ถ้าไม่แก้ให้ ผมจะเอาเรื่องนี้ไปโพสต์ลงกลุ่ม CEO ที่ผมอยู่ กับลงพันทิปด้วย ให้คนอื่นเขารู้ไว้",
  "ผิดหวังกับคลาสนี้จริง ๆ ค่ะ อุตส่าห์ลางานมาเรียนทั้งวัน",
  "เมื่อวานที่สอนมาแย่มากเลยครับ เสียงหลุดตลอด ฟังไม่รู้เรื่องเลย",
  "โฆษณาบอกมีทีมงานดูแลตลอด แต่จริง ๆ ให้บอทตอบอย่างเดียวเลยนี่ โกหกกันชัด ๆ ครับ",
  "จะมาบอกว่าแจ้งล่วงหน้าแบบนี้ไม่น่ารักเลยค่ะ",
]) {
  test(`audit360: complaint — "${line.slice(0, 40)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "complaint");
  });
}

// ---- ขอคนจริง ต้องส่งต่อ (9 เคส) ----
for (const line of [
  "ให้ทาง Hr สมัคร คอร์สไป 2 คอร์ส แต่ติดต่อเจ้าหน้าที่ไม่ได้ จะเรียนวันที่ 21 กับ 28 นี้ ส่วนค่าใช้จ่ายรบกวนติดต่อกลับมาด้วยครับ",
  "รบกวนขอเบอร์แอดมินได้ไหมคะ",
  "ทีมเราคุยกันเรียบร้อยแล้วค่ะ ตกลงเอาคอร์ส 149,000 ขอคุยกับเจ้าหน้าที่เรื่องเอกสารสัญญาหน่อยค่ะ",
  "ขอคนครับ",
  "ไม่อยากคุยกับบอทค่ะ",
  "ขอสายแอดมินหน่อยครับ",
  "รบกวนโทรกลับหน่อยครับ 0891234567",
  "ขอคุยกะคนจริงหน่อยครับ บอทตอบวนไปวนมา",
  "นี่บอทใช่มั้ยคะ ถ้าใช่ขอคุยกับแอดมินที่เป็นคนจริงหน่อยค่ะ",
]) {
  test(`audit360: human_handoff — "${line.slice(0, 40)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "human_handoff");
  });
}

// ---- ขอเลิกติดตามจริง ต้องหยุดทัก (2 เคส) ----
for (const line of [
  "ไม่สนใจแล้วค่ะ อย่าส่งมาอีกนะคะ",
  "ส่งมาทุกวันเลยค่ะ เดี๋ยวจะบล็อกละนะคะ",
]) {
  test(`audit360: optout — "${line.slice(0, 40)}…"`, () => {
    const result = routeMessage({ text: line });
    assert.equal(result?.route === "optout" || result?.optOut === true, true);
  });
}

// ---- ต้องไปต่อได้ (ห้ามปิด AI / ห้ามตัด follow-up) (22 เคส) ----
for (const line of [
  "เอกสารครับ ทำพวกใบเสร็จ ใบกำกับภาษี ส่งให้ลูกค้าทุกสิ้นเดือน",
  "Make.com สามารถ Verify สลิปโอนเงินลูกค้าได้ไหมครับ หรือว่าพอจะมีวิธีการเช็คลูกค้าที่โอนเงินเรียบร้อยแล้วไหมครับ",
  "เคสกลางคืนค่ะ มีคนไข้โทรมาบอกหายใจไม่ออกบ้าง เจ็บแผลผ่าตัดบ้าง ต้องตื่นมารับสายเองตลอด",
  "คลินิกผิวหนังค่ะ เคสส่วนใหญ่เป็นลมพิษเรื้อรังกับสิว อยากให้แอดมินบอทช่วยคัดว่าเคสไหนต้องรีบส่งหาหมอค่ะ",
  "งานเยอะจนหายใจไม่ออกเลยครับ ตอบแชทเองคนเดียวทั้งวัน เลยอยากได้ ai ช่วยตอบแชทแบบที่พี่ง้วงสอน",
  "ในคอร์สมีสอนตั้งค่าให้บอทหยุดคุย แล้วเรียกคนมาตอบแทนตอนลูกค้าเริ่มหงุดหงิดมั้ยครับ",
  "เมื่อคืนลูกค้าทักมาตีสอง ไม่มีใครตอบ เช้ามาผมต้องเรียกคนมาช่วยตอบย้อนหลัง เหนื่อยมากครับ",
  "ขอคนที่บ้านไปเรียนแทนได้ไหมคะ",
  "จัดอบรมถึงบริษัทได้มั้ยครับ อยากเรียกคนมาสอนถึงที่แบบ in-house ให้ทีมขายอะครับ",
  "เอ๊ะ ตกลงตอนนี้ผมคุยกับคนจริงหรือ AI อยู่ครับ",
  "อยากได้แบบที่ลูกค้าพิมพ์ว่า ขอคุยกับแอดมิน แล้วระบบเด้งแจ้งเตือนหาผมทันทีเลย ในคลาสสอนทำมั้ยครับ",
  "มีลูกค้าร้องเรียนเรื่องส่งของช้าแทบทุกวันครับ แอดมินคนเดียวตอบไม่ทันจริง ๆ",
  "ถ้าเรียนแล้วทำตามไม่ได้ หรือไม่พอใจ มีนโยบายคืนเงินไหมคะ",
  "น้องเคยไปเรียนคอร์ส AI กับโค้ชอีกท่านมา รู้สึกไม่คุ้มเลยค่ะ ผิดหวังมาก ของพี่ง้วงต่างจากที่อื่นยังไงคะ",
  "งานที่กินเวลาสุดคือไล่ตอบแชทค่ะ โดยเฉพาะเวลาลูกค้าทักมาบอกเลิกทักได้แล้ว ต้องมานั่งเอาออกจากลิสต์บรอดแคสต์เองทีละคน",
  "ผมยกเลิกติดตามเพจสอน AI เจ้าอื่นหมดแล้วครับ เหลือของพี่ง้วงเจ้าเดียว 555",
  "วันเรียนไม่ต้องทักมาเตือนก็ได้ค่ะ จดไว้แล้ว เจอกันวันเสาร์นะคะ",
  "อยากได้ระบบที่หยุดส่งข้อความหาลูกค้าอัตโนมัติเวลาเขาบอกว่าไม่สนใจครับ ในคลาสสอนส่วนนี้มั้ยครับ",
  "ถ้าคนไข้พิมพ์คำว่า หายใจไม่ออก หรือ เจ็บหน้าอก เข้ามาในไลน์ บอทที่สอนในคลาสจะรีบส่งต่อให้พยาบาลเลยได้มั้ยครับ",
  "ไม่ได้อยากเรียกคนมาตอบนะครับ ผมแค่ลองถามดูว่าบอทฉลาดแค่ไหน",
  "ถ้าโอนแล้วติดธุระไปวันจริงไม่ได้ ขอเลื่อนไปรุ่นถัดไปได้มั้ยคะ",
  "ช่วงน้ำท่วมขนส่งหยุดส่งของไปสามวัน โดนลูกค้าด่ายับเลยค่ะ",
]) {
  test(`audit360: ต้องไปต่อได้ — "${line.slice(0, 40)}…"`, () => {
    const result = routeMessage({ text: line });
    assert.equal(["payment", "complaint", "urgent", "human_handoff", "optout"].includes(result?.route), false,
      `ห้ามเข้าเส้นรุนแรง แต่ได้ ${result?.route}`);
    assert.notEqual(result?.optOut, true, "ห้ามตัด follow-up");
  });
}

// ---- จากการวัดคลังจริงหลังแก้ (พบว่าการแก้รอบแรกทำพังเอง 4 จุด) ----
for (const line of [
  // "Paid" = คำตอบ discovery ว่าใช้เครื่องมือแบบเสียเงิน ไม่ใช่แจ้งจ่ายเรา (คลังจริง 5 ข้อความ)
  "Paid ครับ",
  "Chat gpt /paidค่ะ",
  "ใช้ gemini , claude , chatgpt ใช้แบบ paid tools ทั้งหมด",
  "ใช้เองเล่น ๆ ครับสมัครแบบจ่ายเงินไปแล้วครับ",
  // "แล้ว = then" ข้ามประโยค — โรค v1.4.40 ที่ gap กว้างเปิดกลับมา
  "มีค่าใช้จ่ายแต่ละขายังไงบ้างคะ แล้วมีรอบว่างวันไหนบ้างคะ",
]) {
  test(`audit360: คำตอบ discovery/คำถามทั่วไป ไม่ใช่เรื่องเงิน — "${line.slice(0, 40)}…"`, () => {
    assert.notEqual(routeMessage({ text: line })?.route, "payment");
  });
}

// คำถามความสามารถก่อนซื้อ = buying signal ให้ AI ตอบ "ได้ค่ะ" ทันที (คลังจริง ~30 ข้อความ)
for (const line of ["ออกใบกำกับภาษีได้ไหมคะ", "มีใบกำกับภาษีให้ไหมคะ", "สามารถออกใบกำกับภาษีในนามบริษัทได้ด้วยไม๊คะ"]) {
  test(`audit360: ถามว่าออกใบกำกับได้ไหม = จังหวะขาย ให้ AI ตอบ — "${line.slice(0, 36)}…"`, () => {
    const result = routeMessage({ text: line });
    assert.equal(result?.route, "ai");
    assert.equal(result?.intent, "tax_invoice");
  });
}

// แต่คำขอ/การตามเอกสารจริง ยังต้องถึงคนเสมอ
for (const line of ["รบกวนขอใบกำกับภาษีด้วยนะคะ", "ออกใบกำกับภาษีตามนี้ค่ะ", "ใบกำกับยังไม่ได้มานะคะ"]) {
  test(`audit360: คำขอ/ตามใบกำกับจริง ต้องถึงคน — "${line.slice(0, 36)}…"`, () => {
    assert.equal(routeMessage({ text: line })?.route, "payment");
  });
}

// วิกฤตสุขภาพจิตได้ template สายด่วน 1323 ไม่ใช่ 1669
test("audit360: วิกฤตสุขภาพจิต -> intent urgent_mental + template 1323", () => {
  const result = routeMessage({ text: "ขอโทษนะคะที่มาระบาย ธุรกิจเจ๊งหมดตัว เหนื่อยจนไม่อยากอยู่ต่อแล้วค่ะ คิดวนแบบนี้ทุกคืน" });
  assert.equal(result?.intent, "urgent_mental");
  assert.match(result?.template || "", /1323/u);
  assert.doesNotMatch(result?.template || "", /1669/u);
});

for (const line of [
  "ธุรกิจผมเจ๊งหมดตัว เหนื่อยจนไม่อยากอยู่ต่อแล้ว",
  "อยากให้ AI ช่วย แต่ผมอยากฆ่าตัวตาย",
]) {
  test(`audit360: first-person mental crisis ชนะ use-case framing — "${line.slice(0, 36)}…"`, () => {
    const result = routeMessage({ text: line });
    assert.equal(result?.intent, "urgent_mental");
    assert.match(result?.template || "", /1323/u);
  });
}

test("audit360: เรื่องเล่าบุคคลที่สามเรื่องสุขภาพจิตยังเป็น use case ไม่ยึดแชทของผู้เล่า", () => {
  const result = routeMessage({ text: "คลินิกผมมีคนไข้บอกว่าอยากฆ่าตัวตาย อยากให้ AI ช่วยคัดกรอง" });
  assert.equal(result?.route, "ai");
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.4.45 (ชุดทดสอบสมองจริงจับได้ 2026-08-28, probe-money-07 ตกทั้งสองเทิร์น):
// กฎเฉพาะธุรกิจเทียบคีย์เวิร์ดแบบ substring ล้วน ไม่ดูบริบทเลย — ต่างจากเส้นฉุกเฉิน
// เส้นร้องเรียน และเส้น opt-out ที่เช็ค USE_CASE_FRAMING หมดแล้ว
// ผลคือเจ้าของธุรกิจที่ "เล่าโจทย์ตัวเอง" ด้วยคำว่า "สลิป" โดนยิง template เรื่องชำระเงิน
// ซึ่งเป็นลูกค้ากลุ่มหลักของธุรกิจนี้พอดี (ขายคลาส AI ให้เจ้าของร้าน/คลินิก) = เสียลีดเงียบ ๆ
//
// ทิศทางความเสียหายต่างกันต่อกฎ จึงเป็น opt-in ต่อกฎ ไม่ใช่เปลี่ยนพฤติกรรมทุกกฎ:
//   กฎเงิน  — พลาดจับ = บอทพูดเรื่องเงินเอง (แก้ได้) / จับเกิน = ลีดตายเงียบ  -> ยกเว้นได้
//   กฎไฟไหม้ — พลาดจับ = อันตรายถึงตัว กู้คืนไม่ได้                          -> ห้ามยกเว้น
const PAYMENT_RULE = {
  keywords: ["โอนแล้ว", "สลิป", "ชำระเงินแล้ว", "จ่ายเงินแล้ว", "ขอคืนเงิน", "รีฟันด์"],
  template: "ลูกแพรบันทึกเรื่องการชำระเงินไว้ให้ทีมงานตรวจแล้วนะคะ ทีมงานจะยืนยันกลับให้อีกครั้งค่ะ",
  reason: "payment_requires_human_review",
  excludeUseCaseFraming: true,
};

test("v1.4.45: เจ้าของธุรกิจเล่าโจทย์ตัวเองด้วยคำว่า 'สลิป' ต้องไม่โดน template เรื่องเงิน", () => {
  const rules = [PAYMENT_RULE];
  for (const text of [
    "ร้านผมต้องนั่งคีย์สลิปเองทุกวัน อยากรู้ว่า AI ช่วยได้ไหมครับ",
    "อยากได้ระบบที่อ่านสลิปลูกค้าให้อัตโนมัติ",
    "ธุรกิจผมรับโอนวันละร้อยกว่ารายการ อยากให้ AI ช่วยเช็คสลิป",
  ]) {
    const r = routeMessage({ text, extraRules: rules });
    assert.equal(r.route, "ai", `ต้องปล่อยให้ AI คุยต่อ: ${text}`);
    assert.equal(r.template, null, "ต้องไม่ยิง template สำเร็จรูป");
  }
});

test("v1.4.45: ลูกค้าจ่ายเงินจริง ยังต้องเข้าเส้นเงินเหมือนเดิม", () => {
  const rules = [PAYMENT_RULE];
  for (const text of ["โอนแล้วนะคะ", "ส่งสลิปให้แล้วค่ะ", "ขอคืนเงินได้ไหมคะ"]) {
    const r = routeMessage({ text, extraRules: rules });
    assert.equal(r.route, "urgent", `ต้องเข้าเส้นเงิน: ${text}`);
    assert.equal(r.escalate?.reason, "payment_requires_human_review");
  }
});

test("v1.4.45: กฎที่ไม่ได้ขอยกเว้น (ไฟไหม้) ต้องยิงเหมือนเดิมแม้ลูกค้าเล่าโจทย์ธุรกิจ", () => {
  const r = routeMessage({ text: "โรงงานผมอยากได้ระบบเตือนเวลามีควันครับ", extraRules: [FIRE_RULE] });
  assert.equal(r.route, "urgent", "เส้นอันตรายต้องจับไว้ก่อนเสมอ พลาดแล้วกู้คืนไม่ได้");
  assert.equal(r.escalate?.reason, "device_fire");
});

test("v1.4.45: loadSafetyRules ต้องไม่ทิ้งธง excludeUseCaseFraming", () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-rules-"));
  try {
    const file = join(dir, "rules.json");
    writeFileSync(file, JSON.stringify([PAYMENT_RULE, FIRE_RULE]), "utf8");
    const [payment, fire] = loadSafetyRules(file, { logger: silent });
    assert.equal(payment.excludeUseCaseFraming, true, "กฎที่ขอยกเว้นต้องรอดจากตัวโหลด");
    assert.equal(fire.excludeUseCaseFraming, false, "กฎที่ไม่ได้ขอ ต้องได้ค่า false ไม่ใช่ undefined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.4.48 (คำสั่งเจ้าของ 2026-08-29): เดิมรูป "ทุกใบ" ถูกตีเป็นเรื่องเงิน — บอทเงียบ
// ห้องเข้าคิวคน และปักธงเงินถาวรที่ปลดได้ทางเดียวคือลบบทสนทนาทั้งห้องทิ้ง
// ของจริงลูกค้าส่งรูปโพสต์ของพี่ง้วงมาถามว่า "สอนอันนี้ไหม" บ่อยกว่าส่งสลิป
//
// ตัวตัดสินใจยังคงเป็นฟังก์ชันบริสุทธิ์ที่ให้ผลเดิมทุกครั้ง — ไม่เรียกโมเดลเอง
// แต่ "รับผลจำแนก" เข้ามาเป็นข้อมูล ฝั่งไปป์ไลน์เป็นคนไปวิเคราะห์แล้วส่งค่ามาให้
//
// ทิศทางความเสียหายไม่สมมาตร จึงต้อง fail closed:
//   จำแนกไม่ได้ / ยังไม่รู้ / วิเคราะห์ล้ม  ->  ถือเป็นเรื่องเงินไว้ก่อนเสมอ
//   เพราะพลาดจับสลิป = บอทอาจยืนยันยอดผิด เงินผิดกู้คืนไม่ได้
//   ส่วนจับเกิน = เสียลีด ซึ่งแก้ได้ด้วยคน
test("v1.4.48: รูปที่ยังไม่รู้ว่าคืออะไร ต้องเข้าเส้นเงินไว้ก่อน (fail closed)", () => {
  for (const extra of [{}, { imageKind: "unknown" }, { imageKind: null }, { imageKind: "" }]) {
    const r = routeMessage({ text: "", msgType: "image", ...extra });
    assert.equal(r.route, "payment", `ต้อง fail closed: ${JSON.stringify(extra)}`);
    assert.equal(r.escalate?.reason, "image_review");
    assert.equal(r.template, null, "ยังต้องไม่ตอบอัตโนมัติ");
  }
});

test("v1.4.48: จำแนกแล้วว่าเป็นสลิป/เอกสาร ต้องเข้าเส้นเงินเหมือนเดิมทุกอย่าง", () => {
  for (const kind of ["slip", "document"]) {
    const r = routeMessage({ text: "", msgType: "image", imageKind: kind });
    assert.equal(r.route, "payment");
    assert.equal(r.escalate?.reason, "image_review");
    assert.equal(r.template, null);
  }
});

test("v1.4.48: จำแนกแล้วว่าไม่ใช่เรื่องเงิน ต้องปล่อยให้ AI คุยต่อ ไม่ปักธง", () => {
  const r = routeMessage({ text: "", msgType: "image", imageKind: "other" });
  assert.equal(r.route, "ai", "ต้องคุยต่อได้");
  assert.equal(r.escalate, null, "ห้ามปักธงเงิน — ปลดไม่ได้ถ้าปักผิด");
});

test("v1.4.48: ผลจำแนกไม่กระทบข้อความตัวอักษร", () => {
  assert.equal(routeMessage({ text: "ราคาเท่าไหร่คะ", msgType: "text", imageKind: "other" }).route, "ai");
  assert.equal(routeMessage({ text: "โอนแล้วนะคะ", msgType: "text", imageKind: "other" }).route, "payment");
});
