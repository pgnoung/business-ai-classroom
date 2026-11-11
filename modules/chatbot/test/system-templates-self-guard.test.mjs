// ข้อความที่ "ระบบแต่งเอง" ต้องผ่านด่านตรวจของระบบเองเสมอ
//
// เคสจริง 2026-08-28 (ชุดทดสอบสมองจริง + ทีมไล่โค้ดจับได้): PRICE_FINAL_PREFIX เขียนว่า
// "ราคาที่แจ้งไปเป็นโปรโมชั่นที่ดีที่สุดแล้วค่ะ" ซึ่งมีคำว่า "ดีที่สุด" อยู่ใน
// config/clinic-banned.json พอดี ผลคือ:
//   ลูกค้าต่อรองขอลด -> ดราฟต์ติดกฎเรื่องเงิน -> กู้ประโยคปลอดภัยไว้ได้
//   -> pipeline.mjs:1835 แปะ prefix นำหน้า -> :1850 ตรวจซ้ำ -> ชนคำต้องห้ามของตัวเอง
//   -> :1851 return ทิ้งทั้งก้อน -> ลูกค้าไม่ได้รับอะไรเลย
// ทั้งที่คอมเมนต์เหนือเส้นนั้นเขียนเจตนาไว้เองว่า "ลูกค้าต้องไม่เจอความเงียบ"
//
// เทสต์นี้ไม่ได้แก้แค่ประโยคเดียว แต่ทำให้ความผิดพลาดทรงนี้เกิดซ้ำไม่ได้:
// เพิ่มคำต้องห้ามใหม่แล้วไปชนข้อความระบบเมื่อไหร่ ชุดทดสอบตกทันทีตั้งแต่ตอนแก้
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import {
  HERMES_DOWN_TEMPLATE, HERMES_DOWN_RETRY_TEMPLATE, PRICE_REVIEW_TEMPLATE,
  PARTIAL_BLOCK_PREFIX, PRICE_FINAL_PREFIX, BLOCKED_FALLBACK_TEMPLATE,
  STYLE_BLOCK_TEMPLATE, AUDIO_FALLBACK_TEMPLATE, FILE_ACK_TEMPLATE, IMAGE_ACK_TEMPLATE,
  BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, JEV_HOLD_FALLBACK_TEMPLATE,
} from "../src/pipeline.mjs";
import {
  IDENTITY_TEMPLATE, URGENT_TEMPLATE, URGENT_MENTAL_TEMPLATE,
  COMPLAINT_TEMPLATE, PAYMENT_TEMPLATE, PAYMENT_DOC_TEMPLATE, OPTOUT_TEMPLATE,
} from "../src/safetyRouter.mjs";
import { closingStatement } from "../src/handoffClosing.mjs";
import { paymentNudgeText } from "../src/paymentGentleNudge.mjs";
import { IDENTITY_TEMPLATE_DEFAULTS } from "../src/identityLinkClasses.mjs";
import { enforceFemaleParticles, hasMaleParticle } from "../src/personaParticles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const bannedWords = JSON.parse(readFileSync(join(HERE, "..", "config", "clinic-banned.json"), "utf8"));

const SYSTEM_TEXTS = {
  HERMES_DOWN_TEMPLATE, HERMES_DOWN_RETRY_TEMPLATE, PRICE_REVIEW_TEMPLATE,
  PARTIAL_BLOCK_PREFIX, PRICE_FINAL_PREFIX, BLOCKED_FALLBACK_TEMPLATE,
  STYLE_BLOCK_TEMPLATE, AUDIO_FALLBACK_TEMPLATE,
  // 12 ต.ค. 2026 (พี่ง้วง ข้อ 3): ข้อความสำรองเมื่อด่านเงินบล็อกแต่ส่งเรื่องให้ทีมไม่สำเร็จ / ตัวตรวจคำตอบล่ม
  BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, JEV_HOLD_FALLBACK_TEMPLATE,
  // F5/F6 (ก.ย. 2026): ข้อความตอบรับไฟล์/รูปในห้องที่ AI ยังคุยต่อ
  FILE_ACK_TEMPLATE, IMAGE_ACK_TEMPLATE,
  IDENTITY_TEMPLATE, URGENT_TEMPLATE, URGENT_MENTAL_TEMPLATE,
  COMPLAINT_TEMPLATE, PAYMENT_TEMPLATE, PAYMENT_DOC_TEMPLATE, OPTOUT_TEMPLATE,
  // 5 ต.ค. 2026: ประโยคปิดเทิร์นส่งต่อถูกต่อท้าย "หลัง" humanizer และด่านทั้งหมด — ต้องสะอาดตั้งแต่ต้นทาง
  CLOSING_PROJECT: closingStatement("project"),
  CLOSING_PROJECT_PHONE: closingStatement("project", { phoneKnown: true }),
  CLOSING_BOOKING: closingStatement("booking"),
  CLOSING_CONTACT_TEAM: closingStatement("contact_team"),
  // ข้อความทวงโอนแบบนุ่มมีสองแบบ (สุ่มตาม hash ห้อง) — เก็บให้ครบทั้งสองแบบ ทั้งมีชื่อและไม่มีชื่อ
  PAYMENT_NUDGE_A: paymentNudgeText({ customerId: "U-nudge-a", bankAt: 1, name: "คุณเอ", roundShort: "10 ต.ค." }),
  PAYMENT_NUDGE_B: paymentNudgeText({ customerId: "U-nudge-b", bankAt: 1, name: "คุณเอ", roundShort: "10 ต.ค." }),
  PAYMENT_NUDGE_A_NO_NAME: paymentNudgeText({ customerId: "U-nudge-a", bankAt: 1 }),
  PAYMENT_NUDGE_B_NO_NAME: paymentNudgeText({ customerId: "U-nudge-b", bankAt: 1 }),
};

test("ข้อความที่ระบบแต่งเองต้องไม่มีคำต้องห้ามของระบบเอง", () => {
  const offenders = [];
  for (const [name, raw] of Object.entries(SYSTEM_TEXTS)) {
    const text = String(raw || "");
    for (const word of bannedWords) if (text.includes(word)) offenders.push(`${name} มีคำว่า "${word}"`);
  }
  assert.deepEqual(offenders, [], `ข้อความระบบชนคำต้องห้ามของตัวเอง = ลูกค้าเจอความเงียบ:\n  ${offenders.join("\n  ")}`);
});

test("ข้อความที่ระบบแต่งเองต้องผ่าน guard.checkOutbound ได้จริง", () => {
  const guard = createComplianceGuard({
    bannedWords, getApprovedPrices: () => [], getApprovedQuotes: () => [],
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const offenders = [];
  for (const [name, raw] of Object.entries(SYSTEM_TEXTS)) {
    const check = guard.checkOutbound(String(raw || ""));
    if (!check.ok) offenders.push(`${name}: ${check.violations.map((v) => `${v.type}(${v.detail})`).join(", ")}`);
  }
  assert.deepEqual(offenders, [], `ข้อความระบบไม่ผ่านด่านของตัวเอง:\n  ${offenders.join("\n  ")}`);
});

// 5 ต.ค. 2026 (คำสั่งพี่ง้วง "เพิ่มด่านกันคำว่าครับให้หน่อย"): ลูกแพรเป็นผู้หญิง — ข้อความที่ระบบแต่งเองหลายเส้น
// ไม่ผ่าน humanizer (แม่แบบความปลอดภัย ตอบรับไฟล์/รูป ประโยคปิดส่งต่อที่ต่อท้ายหลัง humanize ข้อความคลาสหลังเชื่อมแชท)
// ด่านคำลงท้ายตอนรันจึงช่วยไม่ได้ — ต้องจับตั้งแต่ตอนแก้แม่แบบ
const PERSONA_TEXTS = {
  ...SYSTEM_TEXTS,
  ...Object.fromEntries(Object.entries(IDENTITY_TEMPLATE_DEFAULTS).map(([key, text]) => [`IDENTITY_LINK_${key}`, text])),
};

test("แม่แบบข้อความระบบทั้งสองแบบของข้อความทวงโอนอยู่ในชุดตรวจจริง", () => {
  assert.notEqual(SYSTEM_TEXTS.PAYMENT_NUDGE_A, SYSTEM_TEXTS.PAYMENT_NUDGE_B, "ต้องได้คนละแบบ ไม่งั้นแบบที่สองไม่ถูกตรวจ");
  assert.ok(Object.keys(IDENTITY_TEMPLATE_DEFAULTS).length >= 3);
});

test("ข้อความที่ระบบแต่งเองต้องไม่มีคำลงท้ายผู้ชาย (ครับ/คร้าบ/ค้าบ/ฮะ/คับ) และไม่มี 'ผม' แทนตัวเอง", () => {
  const offenders = [];
  for (const [name, raw] of Object.entries(PERSONA_TEXTS)) {
    const text = String(raw || "");
    assert.ok(text.trim(), `${name} ว่าง`);
    if (hasMaleParticle(text)) offenders.push(`${name}: มีคำลงท้ายผู้ชาย`);
    const result = enforceFemaleParticles(text);
    if (result.text !== text) offenders.push(`${name}: ด่านจะแก้เป็น "${result.text}"`);
    for (const item of result.residual) offenders.push(`${name}: ${item.kind} (${item.sample})`);
  }
  assert.deepEqual(offenders, [], `ข้อความระบบเสียงผู้ชาย = ลูกแพรพูดผิดเพศโดยไม่มีด่านไหนจับ:\n  ${offenders.join("\n  ")}`);
});
