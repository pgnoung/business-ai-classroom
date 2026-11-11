// preset-buttons.test.mjs — ข้อความจากปุ่มคำถามสำเร็จรูปต้องถูกอ่านเป็น "การกดปุ่ม" ไม่ใช่การพิมพ์
//
// เคสจริง (Facebook, 2026-09-04 12:14 UTC): ลูกค้ากดปุ่ม "คิดค่าบริการเท่าไหร่" สามครั้งในสองวินาที
// โมเดลเห็นสามบรรทัดเหมือนกัน + กติกา "พิมพ์มา 3 ข้อความติดกัน ตอบให้ครบ" แล้วอ่านเป็นการทวง
// จึงเขียน "ขออภัยที่ยังไม่ได้ตอบราคาให้ตรง ๆ นะคะ" (ขอโทษกับการเลี่ยงที่ไม่เคยเกิด) แล้วเทราคาเต็ม
//
// แก้คำอ่านเคสนี้ 2026-09-04 (รอบตัวอ่านบันได): ตอนเขียนไฟล์นี้เราสรุปว่า "คำตัดสิน defer ถูกแล้ว
// โมเดลผิดฝ่ายเดียว" — สรุปนั้นผิดครึ่งหนึ่ง ห้องนี้ตอบบันไดระดับ AI ที่เราถามเองไปแล้วว่า
// "ยังไม่เคยครับ" (ห้าชั่วโมงก่อน) แต่ detectAiLevel อ่านคำนั้นไม่ออก คำตัดสินจึงเป็น defer
// เพราะ "เราไม่รู้จักเขา" ทั้งที่เรารู้ — ส่วนที่โมเดลผิดจริงคือการขอโทษกับการเลี่ยงที่ไม่เคยเกิด
// ไม่ใช่การแจ้งราคา ตัวอ่านถูกซ่อมที่ salesMotion.detectAiLevel แล้ว ฉากด้านล่างจึงคาดหวัง quote
//
// สามชั้นที่ไฟล์นี้พิสูจน์: (1) ตัวยุบเป็น pure function ที่แม่นและไม่โยน (2) คำตัดสินจังหวะราคา
// นับการกดปุ่มราคาเป็นการถาม "หนึ่งครั้ง" และไม่ให้ข้อความปุ่มปั้น "รู้จักเขาแล้ว" ขึ้นมาเอง
// (3) ไปป์ไลน์จริง (ฐานในหน่วยความจำ ไม่เรียกโมเดล) ยุบทั้งก้อนปัจจุบันและมุมมองประวัติ โดยแถว
// messages ที่เก็บไว้ไม่ถูกแตะแม้แต่แถวเดียว
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { baseRules } from "../src/pipeline.mjs";
import {
  asksAboutMoney, decidePriceDisclosure, knowsSomethingAboutCustomer, PRICE_DISCLOSURE_REASONS,
} from "../src/priceDisclosure.mjs";
import { buildConversationStyleRules } from "../src/conversationStyle.mjs";
import { detectAiLevel, detectHeadcount, hasRecentFatigue, resolveClassRouting } from "../src/salesMotion.mjs";
import { hasQuestionFatigue } from "../src/conversationStyle.mjs";
import {
  collapseInboundBurst, collapsePresetBurst, isPresetButtonTap, normalizeButtonText,
  normalizePresetButtonPhrases, PRESET_BUTTON_DEFAULTS, PRESET_BUTTON_PHRASES_KEY, PRESET_BURST_WINDOW_MS,
  presetButtonFact, presetButtonPhrases, presetButtonPhrasesConfigured,
} from "../src/presetButtons.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, promptText, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

const BUTTON = "คิดค่าบริการเท่าไหร่";
const user = (content, extra = {}) => ({ role: "user", content, ...extra });
const bot = (content) => ({ role: "assistant", content });
const stranger = (extra = {}) => ({
  line_user_id: "U-x", known_name: "", last_score: null,
  price_deferred_at: 0, price_quoted_at: 0, known_context_at: 0, price_pivot_deferred_at: 0, ...extra,
});
const SCORED = { painPoint: "งานเอกสารกินเวลาทีมทั้งวัน", personaType: "unknown" };

/* ------------------------------ 1. normalize / จับปุ่ม ------------------------------ */

test("normalize: ตัดช่องว่าง เครื่องหมาย และอีโมจิท้ายข้อความ แต่ **ไม่** ตัดคำลงท้ายภาษาไทย", () => {
  assert.equal(normalizeButtonText("  คิดค่าบริการ   เท่าไหร่ ?! "), "คิดค่าบริการ เท่าไหร่");
  assert.equal(normalizeButtonText("จองคิวได้ไหม 🙏✨"), "จองคิวได้ไหม");
  assert.equal(normalizeButtonText("ราคาเทอมละเท่าไหร่…"), "ราคาเทอมละเท่าไหร่");
  assert.equal(normalizeButtonText("ok 👍🏽"), "ok");
  // คำลงท้าย = มีคนพิมพ์ — ต้องอยู่ครบทุกตัว
  for (const typed of ["คิดค่าบริการเท่าไหร่ครับ", "คิดค่าบริการเท่าไหร่ค่ะ", "คิดค่าบริการเท่าไหร่คะ", "คิดค่าบริการเท่าไหร่นะ"]) {
    assert.equal(normalizeButtonText(typed), typed, `ห้ามตัดคำลงท้ายของ "${typed}"`);
  }
  // NFC: สระ/วรรณยุกต์ที่ประกอบต่างกันต้องเทียบเท่ากัน
  assert.equal(normalizeButtonText("จองคิวได้ไหม".normalize("NFD")), "จองคิวได้ไหม");
  assert.equal(normalizeButtonText(null), "");
  assert.equal(normalizeButtonText(undefined), "");
  assert.equal(normalizeButtonText(42), "42");
});

test("จับปุ่มแบบเป๊ะ: ข้อความปุ่มตรงตัวคือปุ่ม · เติมคำลงท้ายหรือคำอื่นคือคนพิมพ์", () => {
  for (const phrase of PRESET_BUTTON_DEFAULTS) {
    assert.equal(isPresetButtonTap(phrase), true, `"${phrase}" ต้องเป็นปุ่ม`);
    assert.equal(isPresetButtonTap(`${phrase}ครับ`), false, `"${phrase}ครับ" คือคนพิมพ์`);
    assert.equal(isPresetButtonTap(`${phrase} ค่ะ`), false);
  }
  assert.equal(isPresetButtonTap("คิดค่าบริการเท่าไหร่?"), true, "เครื่องหมายท้ายข้อความไม่ทำให้พ้นจากการเป็นปุ่ม");
  assert.equal(isPresetButtonTap("สนใจคลาส AI คิดค่าบริการเท่าไหร่"), false, "มีคำนำหน้า = พิมพ์เอง");
  assert.equal(isPresetButtonTap(""), false);
  assert.equal(isPresetButtonTap(undefined), false);
  // รายการที่ส่งมาเองชนะค่าตั้งต้น
  assert.equal(isPresetButtonTap("สนใจคลาสสอนสด", ["สนใจคลาสสอนสด"]), true);
  assert.equal(isPresetButtonTap(BUTTON, ["สนใจคลาสสอนสด"]), false);
});

test("รายการปุ่มตั้งต้นครบทั้งตระกูลที่เจ้าของไล่ให้ + วลีใน addendum ของ Facebook", () => {
  for (const phrase of ["คุณให้บริการอะไรบ้าง", "คิดค่าบริการเท่าไหร่", "จองคิวได้ไหม", "เทอมละเท่าไหร่", "ราคาเทอมละเท่าไหร่", "คุณมีบริการอะไรบ้าง"]) {
    assert.ok(PRESET_BUTTON_DEFAULTS.includes(phrase), `ค่าตั้งต้นต้องมี "${phrase}"`);
  }
  assert.ok(Object.isFrozen(PRESET_BUTTON_DEFAULTS));
});

test("ทำรายการให้สะอาด: ไม่ใช่สตริงทิ้ง · ว่างทิ้ง · ยาวเกินทิ้ง · ไม่ซ้ำ · ไม่ใช่อาร์เรย์ = ว่าง", () => {
  assert.deepEqual(
    normalizePresetButtonPhrases([" จองคิว ได้ไหม ", "คิดค่าบริการเท่าไหร่?", "คิดค่าบริการเท่าไหร่", 42, "", null, "ก".repeat(121)]),
    ["จองคิว ได้ไหม", "คิดค่าบริการเท่าไหร่"],
  );
  assert.deepEqual(normalizePresetButtonPhrases("คิดค่าบริการเท่าไหร่"), []);
  assert.deepEqual(normalizePresetButtonPhrases(null), []);
});

test("อ่านรายการจาก settings: JSON เสีย / ไม่ใช่อาร์เรย์ / ไม่มีแถว = ค่าตั้งต้น · อาร์เรย์ที่ตั้งใจเก็บชนะ · ไม่โยน", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  assert.deepEqual(presetButtonPhrases({ db }), [...PRESET_BUTTON_DEFAULTS], "ไม่มีแถว = ค่าตั้งต้น");
  assert.equal(presetButtonPhrasesConfigured({ db }), false);

  db.setSetting(PRESET_BUTTON_PHRASES_KEY, "{not json");
  assert.deepEqual(presetButtonPhrases({ db }), [...PRESET_BUTTON_DEFAULTS], "JSON เสีย = ค่าตั้งต้น");
  assert.equal(presetButtonPhrasesConfigured({ db }), false);

  db.setSetting(PRESET_BUTTON_PHRASES_KEY, JSON.stringify({ oops: true }));
  assert.deepEqual(presetButtonPhrases({ db }), [...PRESET_BUTTON_DEFAULTS], "ไม่ใช่อาร์เรย์ = ค่าตั้งต้น");

  db.setSetting(PRESET_BUTTON_PHRASES_KEY, JSON.stringify(["สนใจคลาสสอนสด", "  สนใจคลาสสอนสด", 7]));
  assert.deepEqual(presetButtonPhrases({ db }), ["สนใจคลาสสอนสด"], "แถวที่ตั้งเองชนะ และถูกทำสะอาด");
  assert.equal(presetButtonPhrasesConfigured({ db }), true);

  db.setSetting(PRESET_BUTTON_PHRASES_KEY, "[]");
  assert.deepEqual(presetButtonPhrases({ db }), [], "อาร์เรย์ว่างที่ตั้งใจเก็บ = ปิดการจับปุ่ม ไม่ใช่ค่าตั้งต้น");

  db.setSetting(PRESET_BUTTON_PHRASES_KEY, "");
  assert.deepEqual(presetButtonPhrases({ db }), [...PRESET_BUTTON_DEFAULTS], "สตริงว่าง = กลับไปค่าตั้งต้น");

  // ฐานพัง = ค่าตั้งต้น ไม่ใช่ throw กลางไปป์ไลน์
  const broken = { getSetting() { throw new Error("db closed"); } };
  assert.deepEqual(presetButtonPhrases({ db: broken }), [...PRESET_BUTTON_DEFAULTS]);
  assert.deepEqual(presetButtonPhrases({}), [...PRESET_BUTTON_DEFAULTS]);
  assert.deepEqual(presetButtonPhrases(), [...PRESET_BUTTON_DEFAULTS]);
});

/* ------------------------------ 2. ตัวยุบ (pure function) ------------------------------ */

test("ยุบการกดปุ่มเดิมซ้ำสามครั้งในหน้าต่างเป็นหนึ่ง พร้อมป้าย tapCount = 3", () => {
  const rows = [
    user(BUTTON, { created_at: 1_000 }),
    user(BUTTON, { created_at: 1_700 }),
    user(BUTTON, { created_at: 2_400 }),
  ];
  const snapshot = JSON.stringify(rows);
  const view = collapsePresetBurst(rows);
  assert.equal(view.length, 1);
  assert.equal(view[0].content, BUTTON, "เนื้อความเหลือบรรทัดเดียว ไม่มีบรรทัดซ้ำ");
  assert.equal(view[0].fromPresetButton, true);
  assert.equal(view[0].tapCount, 3);
  assert.deepEqual(view[0].distinctButtons, [BUTTON]);
  assert.equal(view[0].created_at, 1_000, "เวลาของแถวแรกในกลุ่มถูกคงไว้");
  assert.equal(JSON.stringify(rows), snapshot, "อินพุตต้องไม่ถูกแก้");
  assert.equal(rows[0].fromPresetButton, undefined, "แถวเดิมต้องไม่มีป้ายงอกขึ้นมา");
});

test("กดหลายปุ่มต่างกันติดกัน = หนึ่งเทิร์นที่ไล่ทุกเจตนาครั้งเดียวตามลำดับ (เคสจริง 2026-09-03)", () => {
  const view = collapsePresetBurst([
    user("จองคิวได้ไหม", { created_at: 0 }),
    user("คุณให้บริการอะไรบ้าง", { created_at: 800 }),
    user(BUTTON, { created_at: 1_900 }),
    user("คุณให้บริการอะไรบ้าง", { created_at: 2_900 }),
  ]);
  assert.equal(view.length, 1);
  assert.equal(view[0].content, `จองคิวได้ไหม\nคุณให้บริการอะไรบ้าง\n${BUTTON}`);
  assert.equal(view[0].tapCount, 4);
  assert.deepEqual(view[0].distinctButtons, ["จองคิวได้ไหม", "คุณให้บริการอะไรบ้าง", BUTTON]);
});

test("ขอบหน้าต่างเวลา: ห่าง 16 วิ = สองเทิร์น · ห่างไม่ถึง 15 วิ = เทิร์นเดียว · วัดจากแถวแรกของกลุ่ม", () => {
  const two = collapsePresetBurst([user(BUTTON, { created_at: 0 }), user(BUTTON, { created_at: 16_000 })]);
  assert.equal(two.length, 2, "16 วิ = คนกลับมากดใหม่ ไม่ใช่ burst เดียวกัน");
  assert.equal(two[0].tapCount, 1);
  assert.equal(two[1].tapCount, 1);
  const one = collapsePresetBurst([user(BUTTON, { created_at: 0 }), user(BUTTON, { created_at: 14_000 })]);
  assert.equal(one.length, 1);
  assert.equal(one[0].tapCount, 2);
  // 0 -> 10 -> 20 วิ: แถวที่สามห่างจากแถวแรก 20 วิ ต้องเริ่มกลุ่มใหม่ ไม่ใช่ต่อสายไปเรื่อย ๆ
  const chained = collapsePresetBurst([user(BUTTON, { created_at: 0 }), user(BUTTON, { created_at: 10_000 }), user(BUTTON, { created_at: 20_000 })]);
  assert.equal(chained.length, 2);
  assert.equal(PRESET_BURST_WINDOW_MS, 15_000);
  // ตั้งหน้าต่างเอง
  assert.equal(collapsePresetBurst([user(BUTTON, { created_at: 0 }), user(BUTTON, { created_at: 3_000 })], { windowMs: 2_000 }).length, 2);
});

test("แถวที่ไม่มีเวลา (มุมมองจาก db.recentTurns) ให้ความติดกันตัดสิน และคำตอบของเราตัดกลุ่มเสมอ", () => {
  const view = collapsePresetBurst([
    user(BUTTON), user(BUTTON),
    bot("เรื่องราคาบอกได้เลยค่ะ ขออนุญาตสอบถามเบื้องต้นหนึ่งข้อนะคะ"),
    user(BUTTON),
  ]);
  assert.equal(view.length, 3);
  assert.equal(view[0].tapCount, 2);
  assert.equal(view[1].role, "assistant");
  assert.equal(view[2].tapCount, 1, "หลังคำตอบของเรา การกดใหม่คือเทิร์นใหม่");
});

test("ข้อความพิมพ์เองไม่ยุบรวมกับปุ่ม และปุ่มไม่ยุบรวมกับข้อความพิมพ์เอง", () => {
  const typed = user("ผมทำสำนักงานบัญชีครับ", { created_at: 100 });
  const view = collapsePresetBurst([user(BUTTON, { created_at: 0 }), typed, user(BUTTON, { created_at: 200 })]);
  assert.equal(view.length, 3);
  assert.equal(view[0].fromPresetButton, true);
  assert.equal(view[1], typed, "แถวที่ไม่ถูกยุบต้องเป็นอ็อบเจกต์เดิม ไม่ใช่สำเนา");
  assert.equal(view[1].fromPresetButton, undefined);
  assert.equal(view[2].fromPresetButton, true);
  // คนพิมพ์คำเดียวกับปุ่มแต่มีคำลงท้าย = พิมพ์เอง — ต้องไม่ถูกดูดเข้ากลุ่มปุ่ม
  const mixed = collapsePresetBurst([user(BUTTON, { created_at: 0 }), user(`${BUTTON}ครับ`, { created_at: 500 })]);
  assert.equal(mixed.length, 2);
  assert.equal(mixed[1].fromPresetButton, undefined);
});

test("ข้อความพิมพ์เองที่เหมือนกันเป๊ะติดกันในหน้าต่างก็ยุบเหลือหนึ่ง (ไม่ใช่ปุ่ม) · ต่างกันไม่ยุบ", () => {
  const view = collapsePresetBurst([
    user("สวัสดีครับ", { created_at: 0 }), user("สวัสดีครับ", { created_at: 900 }),
    user("สนใจคลาสครับ", { created_at: 1_500 }),
  ]);
  assert.equal(view.length, 2);
  assert.equal(view[0].content, "สวัสดีครับ");
  assert.equal(view[0].fromPresetButton, false);
  assert.equal(view[0].tapCount, 2);
  assert.equal(view[1].content, "สนใจคลาสครับ");
  assert.equal(view[1].tapCount, undefined, "แถวเดี่ยวที่ไม่ถูกยุบไม่มีป้าย");
});

test("อินพุตว่าง/undefined/แถวเพี้ยน ไม่โยน", () => {
  assert.deepEqual(collapsePresetBurst(undefined), []);
  assert.deepEqual(collapsePresetBurst(null), []);
  assert.deepEqual(collapsePresetBurst([]), []);
  assert.deepEqual(collapsePresetBurst("ไม่ใช่อาร์เรย์"), []);
  const junk = [null, undefined, 42, { role: "user" }, { role: "user", content: null }, user(BUTTON)];
  const view = collapsePresetBurst(junk);
  assert.equal(view.length, junk.length, "แถวเพี้ยนผ่านไปตามเดิม ไม่หายและไม่ทำให้พัง");
  assert.equal(view[view.length - 1].fromPresetButton, true);
  assert.deepEqual(collapseInboundBurst(), { text: "", parts: [""], view: [{ content: "" }] });
  assert.deepEqual(collapseInboundBurst({ text: "สวัสดี" }).parts, ["สวัสดี"]);
  assert.deepEqual(presetButtonFact(undefined, undefined), {
    fromPresetButton: false, tapCount: 0, distinctButtons: [], typedAlongside: false, buttonsOnlySoFar: false,
  });
});

test("ก้อนปัจจุบัน: ข้อความพิมพ์เองผ่านไปทุกไบต์เหมือนเดิม (ไม่มีปุ่ม = ไม่มีอะไรเปลี่ยน)", () => {
  const parts = ["ผมทำสำนักงานบัญชี", "ช่วย แก้งาน", "ออเดอร์ ลูกหนี้", "ทั่วไปครับ"];
  const view = collapseInboundBurst({ text: parts.join("\n"), parts });
  assert.equal(view.text, parts.join("\n"));
  assert.deepEqual(view.parts, parts);
  assert.equal(presetButtonFact(view.view, []).fromPresetButton, false);
  // ข้อความบรรทัดเดียวที่มีขึ้นบรรทัดใหม่ข้างใน (เรียกตรงโดยไม่มี parts) ต้องไม่ถูกแตะ
  const multi = collapseInboundBurst({ text: "บรรทัดหนึ่ง\nบรรทัดสอง" });
  assert.equal(multi.text, "บรรทัดหนึ่ง\nบรรทัดสอง");
});

test("presetButtonFact: กดสามครั้ง + ไม่เคยพิมพ์อะไรเลย = buttonsOnlySoFar · มีข้อความพิมพ์เองปน = ไม่ใช่", () => {
  const taps = collapseInboundBurst({ parts: [BUTTON, BUTTON, BUTTON] });
  assert.deepEqual(presetButtonFact(taps.view, []), {
    fromPresetButton: true, tapCount: 3, distinctButtons: [BUTTON], typedAlongside: false, buttonsOnlySoFar: true,
  });
  // ประวัติมีปุ่มล้วน (ยุบแล้ว) = ยังไม่รู้จักเขา
  const buttonHistory = collapsePresetBurst([user("คุณให้บริการอะไรบ้าง"), bot("ยินดีค่ะ")]);
  assert.equal(presetButtonFact(taps.view, buttonHistory).buttonsOnlySoFar, true);
  // ประวัติมีสิ่งที่เขาพิมพ์เอง = รู้จักเขาบ้างแล้ว ห้ามอ้างว่าปุ่มล้วน
  const typedHistory = collapsePresetBurst([user("ยังไม่เคยครับ"), bot("รับทราบค่ะ")]);
  assert.equal(presetButtonFact(taps.view, typedHistory).buttonsOnlySoFar, false);
  // พิมพ์เองปนมาในก้อนเดียวกัน
  const mixed = collapseInboundBurst({ parts: [BUTTON, "ผมทำร้านอาหารครับ"] });
  const fact = presetButtonFact(mixed.view, []);
  assert.equal(fact.fromPresetButton, true);
  assert.equal(fact.typedAlongside, true);
  assert.equal(fact.buttonsOnlySoFar, false);
  assert.equal(mixed.text, `${BUTTON}\nผมทำร้านอาหารครับ`);
});

/* ------------------------------ 3. คำตัดสินจังหวะราคา ------------------------------ */

test("ข้อความปุ่มตั้งต้นไม่ทำให้ตัวอ่านคัดกรอง/ความหงุดหงิดอ่านออกเป็นอะไรเลย (ข้อความกลาง ๆ โดยโครงสร้าง)", () => {
  for (const phrase of PRESET_BUTTON_DEFAULTS) {
    assert.equal(detectAiLevel(phrase), null, `"${phrase}" ต้องไม่อ่านเป็นระดับการใช้ AI`);
    assert.equal(detectHeadcount(phrase), null, `"${phrase}" ต้องไม่อ่านเป็นจำนวนผู้เรียน`);
    assert.equal(hasQuestionFatigue(phrase, []), false);
    assert.equal(hasRecentFatigue({ text: phrase, history: [] }), false);
  }
  const buttonsOnly = collapsePresetBurst(PRESET_BUTTON_DEFAULTS.map((phrase) => user(phrase)));
  const screening = resolveClassRouting({ text: BUTTON, history: buttonsOnly });
  assert.deepEqual(screening, { level: null, headcount: null, product: null });
  // ปุ่มเรื่องเงินต้องอ่านเป็นการถามเรื่องเงิน (ครั้งเดียว) ส่วนปุ่มบริการ/จองคิวไม่ใช่
  for (const phrase of ["คิดค่าบริการเท่าไหร่", "เทอมละเท่าไหร่", "ราคาเทอมละเท่าไหร่"]) assert.equal(asksAboutMoney(phrase), true);
  for (const phrase of ["คุณให้บริการอะไรบ้าง", "คุณมีบริการอะไรบ้าง", "จองคิวได้ไหม"]) assert.equal(asksAboutMoney(phrase), false);
});

test("ห้องที่มีแต่ปุ่มล้วน: สัญญาณ scorer ไม่นับเป็น 'รู้จักเขาแล้ว' · หมุดถาวรและชื่อยังชนะ", () => {
  const buttonsOnly = { fromPresetButton: true, tapCount: 3, distinctButtons: [BUTTON], typedAlongside: false, buttonsOnlySoFar: true };
  assert.equal(knowsSomethingAboutCustomer({ customer: stranger(), scoreSignals: SCORED }), "scored_pain_point", "ปกติ scorer นับ");
  assert.equal(knowsSomethingAboutCustomer({ customer: stranger(), scoreSignals: SCORED, presetButton: buttonsOnly }), null, "ปุ่มล้วน = scorer ไม่นับ");
  assert.equal(knowsSomethingAboutCustomer({ customer: stranger(), scoreSignals: { painPoint: "", personaType: "owner" }, presetButton: buttonsOnly }), null);
  assert.equal(knowsSomethingAboutCustomer({ customer: stranger({ known_name: "คุณเอ" }), scoreSignals: SCORED, presetButton: buttonsOnly }), "known_name");
  assert.equal(knowsSomethingAboutCustomer({ customer: stranger({ known_context_at: 1 }), presetButton: buttonsOnly }), "known_context");
  // ก้อนที่มีข้อความพิมพ์เองปน = scorer มีของจริงให้อ่าน นับตามปกติ
  assert.equal(knowsSomethingAboutCustomer({ customer: stranger(), scoreSignals: SCORED, presetButton: { ...buttonsOnly, typedAlongside: true, buttonsOnlySoFar: false } }), "scored_pain_point");
});

test("กดปุ่มราคาสามครั้ง = ถามเรื่องเงินหนึ่งครั้ง: คัดกรองครั้งแรกตามนโยบายข้อ 1 ไม่ใช่ 'ถามซ้ำ'", () => {
  const view = collapseInboundBurst({ parts: [BUTTON, BUTTON, BUTTON] });
  const fact = presetButtonFact(view.view, []);
  const decision = decidePriceDisclosure({ text: view.text, history: [], customer: stranger(), presetButton: fact, score: 4 });
  assert.equal(decision.mode, "defer");
  assert.equal(decision.reason, PRICE_DISCLOSURE_REASONS.DEFER_SCREENING);
  assert.equal(decision.deferredBefore, false, "จำนวนครั้งที่กดต้องไม่ทำให้กลายเป็น 'เคยเลี่ยงแล้ว'");
  // แม้ข้อความดิบสามบรรทัดจะหลุดมาถึงคำตัดสินโดยไม่ยุบ ก็ยังเป็นการถามครั้งเดียว (ไม่มีการนับบรรทัดที่ไหน)
  const raw = decidePriceDisclosure({ text: [BUTTON, BUTTON, BUTTON].join("\n"), history: [], customer: stranger(), score: 4 });
  assert.equal(raw.mode, "defer");
  assert.equal(raw.reason, PRICE_DISCLOSURE_REASONS.DEFER_SCREENING);
  // scorer เคยปั้นโจทย์จากบทสนทนาที่มีแต่ปุ่ม — ต้องไม่เปิดประตูราคา
  const scored = decidePriceDisclosure({ text: view.text, history: [], customer: stranger(), presetButton: fact, scoreSignals: SCORED });
  assert.equal(scored.mode, "defer", "ปุ่มล้วน + สัญญาณ scorer = ยังคัดกรอง");
  // ไม่มีข้อเท็จจริงเรื่องปุ่มส่งมา (ผู้เรียกเก่า) = พฤติกรรมเดิมทุกประการ
  const legacy = decidePriceDisclosure({ text: view.text, history: [], customer: stranger(), scoreSignals: SCORED });
  assert.equal(legacy.mode, "quote");
});

test("หลังเคยคัดกรองไปแล้ว การกดปุ่มราคาครั้งถัดไป = แจ้งราคาทันที; คะแนน warm ล้วนยังคัดกรอง", () => {
  const view = collapseInboundBurst({ parts: [BUTTON] });
  const history = collapsePresetBurst([user(BUTTON), bot("เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ")]);
  const fact = presetButtonFact(view.view, history);
  const again = decidePriceDisclosure({ text: view.text, history, customer: stranger({ price_deferred_at: 1 }), presetButton: fact });
  assert.equal(again.mode, "quote");
  assert.equal(again.reason, PRICE_DISCLOSURE_REASONS.QUOTE_DEFERRAL_OWED);
  const warm = decidePriceDisclosure({ text: view.text, history: [], customer: stranger({ last_score: 6 }), score: 6, presetButton: presetButtonFact(view.view, []) });
  assert.equal(warm.mode, "defer");
  assert.equal(warm.reason, PRICE_DISCLOSURE_REASONS.DEFER_SCREENING);
});

/* ------------------------------ 4. บรรทัดที่บอกโมเดล ------------------------------ */

test("บรรทัดปุ่ม: บอกว่ามาจากปุ่ม กดกี่ครั้ง ปุ่มไหนบ้าง ห้ามอ่านเป็นการทวง ห้ามขอโทษ และชี้ไปที่กติกาจังหวะราคา", () => {
  const view = collapseInboundBurst({ parts: [BUTTON, BUTTON, BUTTON] });
  const fact = presetButtonFact(view.view, []);
  const rules = baseRules("pricing", [], { customer: stranger(), currentText: view.text, history: [], presetButton: fact, burstCount: view.parts.length });
  assert.match(rules, /กดปุ่มคำถามสำเร็จรูป/u);
  assert.match(rules, /กดมา 3 ครั้ง/u);
  assert.match(rules, new RegExp(`ปุ่มที่กดคือ "${BUTTON}"`, "u"));
  assert.match(rules, /ห้ามอ่านเป็นความหงุดหงิด และห้ามขอโทษว่ายังไม่ได้ตอบ/u);
  assert.match(rules, /ยังไม่ได้บอกอะไรเกี่ยวกับตัวเองเลย/u);
  assert.match(rules, /ระบบให้ถามคัดกรองก่อน/u, "คำตัดสิน defer = ชี้ไปที่การคัดกรองหนึ่งข้อ");
  assert.match(rules, /ได้ประโยชน์สูงสุดต่อผู้เรียน/u, "กรอบเหตุผลเป็นประโยชน์ของผู้เรียน");
  assert.doesNotMatch(rules, /พิมพ์มา 3 ข้อความติดกัน/u, "กดปุ่มเดิมสามครั้งต้องไม่ถูกนับเป็นสามข้อความ");

  // ตอนที่คำตัดสินเป็น quote บรรทัดเดียวกันต้องไม่ชี้ไปที่การคัดกรอง
  const history = collapsePresetBurst([user(BUTTON), bot("เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน ขออนุญาตสอบถามเบื้องต้นค่ะ")]);
  const owed = baseRules("pricing", [], {
    customer: stranger({ price_deferred_at: 1 }), currentText: BUTTON, history,
    presetButton: presetButtonFact(collapseInboundBurst({ parts: [BUTTON] }).view, history),
  });
  assert.match(owed, /ตอบตามกติกาจังหวะราคาในพรอมต์นี้ตรง ๆ/u);
  assert.doesNotMatch(owed, /ระบบให้ถามคัดกรองก่อน/u);

  // สี่ปุ่มต่างกัน = ไล่ทุกเจตนา
  const four = collapseInboundBurst({ parts: ["จองคิวได้ไหม", "คุณให้บริการอะไรบ้าง", BUTTON, "คุณให้บริการอะไรบ้าง"] });
  const fourRules = baseRules("pricing", [], { customer: stranger(), currentText: four.text, history: [], presetButton: presetButtonFact(four.view, []), burstCount: four.parts.length });
  assert.match(fourRules, /กดมา 4 ครั้ง/u);
  assert.match(fourRules, /"จองคิวได้ไหม" \/ "คุณให้บริการอะไรบ้าง" \/ "คิดค่าบริการเท่าไหร่"/u);
  assert.match(fourRules, /ตอบเจตนาจริงของทุกปุ่มให้ครบทีละข้อ/u);

  // ปุ่มที่ไม่ใช่เรื่องเงิน = ไม่สั่งอะไรเรื่องราคาเอง
  const service = collapseInboundBurst({ parts: ["คุณให้บริการอะไรบ้าง"] });
  const serviceRules = buildConversationStyleRules({ text: service.text, customer: stranger(), presetButton: presetButtonFact(service.view, []) });
  assert.match(serviceRules, /ปุ่มนี้ไม่ได้ถามเรื่องเงิน/u);

  // ไม่มีปุ่ม = ไม่มีบรรทัดนี้เลย (พรอมต์ของข้อความพิมพ์เองต้องไม่เปลี่ยนสักไบต์)
  const typed = buildConversationStyleRules({ text: "คิดค่าบริการเท่าไหร่ครับ", customer: stranger() });
  assert.doesNotMatch(typed, /กดปุ่มคำถามสำเร็จรูป/u);
  const typedFact = presetButtonFact(collapseInboundBurst({ parts: ["คิดค่าบริการเท่าไหร่ครับ"] }).view, []);
  assert.equal(buildConversationStyleRules({ text: "คิดค่าบริการเท่าไหร่ครับ", customer: stranger(), presetButton: typedFact }), typed);
});

/* ------------------------------ 5. ไปป์ไลน์จริง (ไม่เรียกโมเดล) ------------------------------ */

const REPLY = "รับทราบค่ะ เดี๋ยวลูกแพรดูให้นะคะ";

function bootApp(t, { clock }) {
  const db = memoryDb({ now: () => clock.at });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setApprovedPrice("Early Bird", 12900);
  const hermesFetch = hermesFetchStub(REPLY);
  const app = createApp({
    // debounce สั้น ๆ แต่ไม่ใช่ศูนย์ — ต้องให้ burst buffer รวมสามข้อความเป็นก้อนเดียวเหมือนโปรดักชัน
    config: testConfig({ BURST_DEBOUNCE_MS: "40", HISTORY_TURNS: "12" }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  t.after(() => db.close());
  // scorer เรียกโมเดลผ่าน stub ตัวเดียวกันหลังตอบเสร็จ (prompt_cache_key ลงท้าย -scorer) —
  // ไฟล์นี้สนใจเฉพาะ "พรอมต์ที่ใช้ร่างคำตอบ" จึงกรองด้วยคีย์ของเส้น reply
  const replyCalls = () => hermesFetch.calls.filter((call) => call.body?.prompt_cache_key === "lukprae-hermes");
  return { db, app, hermesFetch, replyCalls };
}

// webhook เขียนแถวขาเข้าลงฐาน "ก่อน" เรียกไปป์ไลน์เสมอ — จำลองลำดับเดียวกัน
function inbound(db, customerId, content, dedupeKey) {
  return db.persistLineInbound({ dedupeKey, customerId, msgType: "text", content, owesReply: true });
}

function promptOf(call) {
  const messages = call.body.messages;
  const system = messages.filter((m) => m.role === "system").map((m) => promptText(m.content)).join("\n");
  const userMessages = messages.filter((m) => m.role === "user").map((m) => promptText(m.content));
  return { messages, system, userMessages, current: userMessages[userMessages.length - 1] };
}

test("เคสจริง 2026-09-04: กดปุ่มราคาสามครั้งในสองวินาที = หนึ่งบรรทัด · ไม่ใช่ถามซ้ำ · เขาตอบบันไดไปแล้ว = แจ้งราคา", async (t) => {
  const clock = { at: Date.parse("2026-09-04T12:14:00Z") };
  const { db, app, replyCalls } = bootApp(t, { clock });
  const customerId = "U-fb-preset-real";

  // ประวัติจริงของห้อง: ตอบสองคำสั้น ๆ ไว้เมื่อหลายชั่วโมงก่อน แล้วเราตอบไป (เทิร์นก่อนหน้าปิดแล้ว)
  clock.at -= 5 * 3_600_000;
  // 15 Sep: this fixture models a recorded ladder, not a context-free opening.
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "out", msgType: "text", content: "เคยใช้ AI มาประมาณระดับไหนแล้วคะ?", operator: "system" });
  inbound(db, customerId, "ยังไม่เคยครับ", "m-old-1");
  clock.at += 30_000;
  inbound(db, customerId, "งานประจำ", "m-old-2");
  clock.at += 60_000;
  db.insertMessage({ customerId, direction: "out", msgType: "text", content: "รับทราบค่ะ", messageClass: "reactive", agentMode: "ai" });
  clock.at = Date.parse("2026-09-04T12:14:00Z");

  // สามแถวขาเข้าภายในสองวินาที ข้อความเดียวกันทุกตัวอักษร = กดปุ่มสามครั้ง
  const turns = [];
  for (let index = 0; index < 3; index += 1) {
    inbound(db, customerId, BUTTON, `m-tap-${index}`);
    turns.push(app.pipeline.handleInboundText({ customerId, text: BUTTON, replyToken: `rt-${index}` }));
    clock.at += 700;
  }
  const results = await Promise.all(turns);
  assert.equal(results.filter((r) => r?.absorbed).length, 2, "สองข้อความแรกถูก burst ดูดรวม");
  assert.equal(replyCalls().length, 1, "ก้อนเดียว = ร่างคำตอบครั้งเดียว");

  const first = promptOf(replyCalls()[0]);
  assert.equal(first.current, BUTTON, "ข้อความที่โมเดลเห็นในเทิร์นนี้ต้องเหลือบรรทัดเดียว ไม่ใช่สามบรรทัด");
  assert.doesNotMatch(first.current, /ลูกค้าส่งมา 3 ข้อความติดกัน/u);
  assert.doesNotMatch(first.system, /พิมพ์มา 3 ข้อความติดกัน/u);
  assert.match(first.system, /กดปุ่มคำถามสำเร็จรูป/u, "ต้องมีบรรทัดบอกว่าเป็นปุ่ม");
  assert.match(first.system, /กดมา 3 ครั้ง/u);
  assert.match(first.system, /ห้ามขอโทษว่ายังไม่ได้ตอบ/u);
  // เขาตอบบันไดระดับ AI ไปแล้ว = เรารู้จักเขาแล้ว จึงห้ามขอคัดกรองซ้ำในเทิร์นนี้
  assert.doesNotMatch(first.system, /ห้ามใส่ตัวเลขราคาในคำตอบนี้แม้จะรู้ราคาก็ตาม/u, "คนที่ตอบบันไดไปแล้วต้องไม่ถูกกั๊กราคา");
  assert.doesNotMatch(first.system, /ระบบให้ถามคัดกรองก่อน/u, "ห้ามขอคัดกรองซ้ำกับคนที่ตอบไปแล้ว");
  assert.match(first.system, /ระดับการใช้ AI = 1/u, "พรอมต์ต้องประกาศระดับที่อ่านได้จากคำว่า 'ยังไม่เคยครับ'");
  assert.doesNotMatch(first.system, /คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ/u, "'ถามซ้ำ' ต้องเป็นเท็จ — กดสามครั้งไม่ใช่การถามครั้งที่สอง");
  // ประวัติที่โมเดลเห็นยังมีสิ่งที่เขาเคยพิมพ์เองครบ (นี่ไม่ใช่ห้องปุ่มล้วน)
  assert.deepEqual(first.userMessages.slice(0, 2), ["ยังไม่เคยครับ", "งานประจำ"]);
  assert.doesNotMatch(first.system, /ยังไม่ได้บอกอะไรเกี่ยวกับตัวเองเลย/u, "เคยพิมพ์เองมาก่อน = ห้ามอ้างว่าปุ่มล้วน");

  // หลังส่งสำเร็จ: ไม่มีการคัดกรอง จึงไม่มีหมุดคัดกรอง — แต่หมุด "รู้จักเขาแล้ว" ต้องถูกปัก
  // และปักจาก **คำตอบบันไดที่เขาพิมพ์เอง** ไม่ใช่จากข้อความปุ่ม (ห้องปุ่มล้วนยังต้องเป็น 0
  //  ซึ่งเทสต์ 2026-09-03 ด้านล่างยืนยันไว้แยกต่างหาก)
  const afterFirst = db.getCustomer(customerId);
  assert.equal(Number(afterFirst.price_deferred_at || 0), 0, "เทิร์นนี้แจ้งราคา จึงไม่มีการคัดกรองให้บันทึก");
  assert.ok(Number(afterFirst.known_context_at || 0) > 0, "คำตอบบันไดที่เขาพิมพ์เองต้องปักหมุด 'รู้จักเขาแล้ว'");

  // แถวที่เก็บไว้ไม่ถูกแตะ: สามแถวขาเข้ายังอยู่ครบ (ความจริงของ audit)
  const stored = db.messagesFor(customerId, 50);
  assert.equal(stored.filter((row) => row.direction === "in" && row.content === BUTTON).length, 3);

  // ลูกค้าพิมพ์ถามจริงครั้งที่สอง = ต้องได้ราคาอีกเช่นกัน (คราวนี้มีหมุด known_context_at
  // ค้ำอยู่ด้วย จึงไม่ขึ้นกับว่าคำตอบบันไดยังอยู่ในหน้าต่างประวัติหรือไม่)
  clock.at += 90_000;
  inbound(db, customerId, "ราคาเท่าไหร่ครับ", "m-typed-ask");
  await app.pipeline.handleInboundText({ customerId, text: "ราคาเท่าไหร่ครับ", replyToken: "rt-ask" });
  assert.equal(replyCalls().length, 2);
  const second = promptOf(replyCalls()[1]);
  assert.equal(second.current, "ราคาเท่าไหร่ครับ");
  assert.doesNotMatch(second.system, /กดปุ่มคำถามสำเร็จรูป/u, "พิมพ์เอง = ไม่มีบรรทัดปุ่ม");
  assert.doesNotMatch(second.system, /ห้ามใส่ตัวเลขราคาในคำตอบนี้แม้จะรู้ราคาก็ตาม/u, "ห้ามคัดกรองรอบสอง");
  // เทิร์นที่ถามเรื่องเงินและประตูราคาเปิดแล้ว = แม่แบบแจ้งราคาทั้งก้อน (ฝั่ง quote)
  assert.match(second.system, /ตอนแจ้งราคา ใช้โครงนี้ทั้งก้อนในบอลลูนเดียว/u, "เรารู้จักเขาแล้วและเขาถามราคา = เทิร์นนี้ต้องแจ้งราคา");
  // burst ปุ่มเมื่อกี้ในประวัติที่โมเดลเห็น = บรรทัดเดียว ขณะที่แถวจริงยังมีสาม
  assert.equal(second.userMessages.filter((content) => content === BUTTON).length, 1, "ประวัติที่โมเดลเห็นต้องยุบ burst ปุ่มเหลือหนึ่ง");
  assert.equal(second.userMessages.filter((content) => content.includes(BUTTON)).length, 1);
  assert.equal(db.messagesFor(customerId, 50).filter((row) => row.direction === "in" && row.content === BUTTON).length, 3, "แถวที่เก็บไว้ต้องยังครบสาม");
});

test("เคสจริง 2026-09-03: กดสี่ปุ่มในสามวินาที = หนึ่งเทิร์นที่ไล่สามเจตนา · defer · ห้องปุ่มล้วน", async (t) => {
  const clock = { at: Date.parse("2026-09-03T09:00:00Z") };
  const { db, app, replyCalls } = bootApp(t, { clock });
  const customerId = "U-fb-preset-four";
  const taps = ["จองคิวได้ไหม", "คุณให้บริการอะไรบ้าง", BUTTON, "คุณให้บริการอะไรบ้าง"];
  const turns = [];
  for (const [index, tap] of taps.entries()) {
    inbound(db, customerId, tap, `m-four-${index}`);
    turns.push(app.pipeline.handleInboundText({ customerId, text: tap, replyToken: `rt-${index}` }));
    clock.at += 900;
  }
  await Promise.all(turns);
  assert.equal(replyCalls().length, 1);
  const prompt = promptOf(replyCalls()[0]);
  assert.equal(prompt.current, `จองคิวได้ไหม\nคุณให้บริการอะไรบ้าง\n${BUTTON}`, "หนึ่งเทิร์น ไล่ปุ่มที่ต่างกันครั้งเดียวตามลำดับ");
  assert.doesNotMatch(prompt.current, /ลูกค้าส่งมา 4 ข้อความติดกัน/u);
  assert.match(prompt.system, /กดมา 4 ครั้ง/u);
  assert.match(prompt.system, /"จองคิวได้ไหม" \/ "คุณให้บริการอะไรบ้าง" \/ "คิดค่าบริการเท่าไหร่"/u);
  assert.match(prompt.system, /ยังไม่ได้บอกอะไรเกี่ยวกับตัวเองเลย/u, "ห้องที่มีแต่ปุ่ม = เรายังไม่รู้อะไรเลย");
  assert.match(prompt.system, /ห้ามใส่ตัวเลขราคาในคำตอบนี้แม้จะรู้ราคาก็ตาม/u);
  assert.equal(db.messagesFor(customerId, 50).filter((row) => row.direction === "in").length, 4, "แถวจริงยังครบสี่");
  assert.equal(Number(db.getCustomer(customerId).known_context_at || 0), 0);
});

test("burst ปุ่มที่อยู่ในประวัติแล้ว: มุมมองยุบ แถวที่เก็บไว้เท่าเดิม (ทดสอบตรงที่ชั้นฐานข้อมูล)", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const customerId = "U-history-view";
  for (let index = 0; index < 3; index += 1) inbound(db, customerId, BUTTON, `h-${index}`);
  db.insertMessage({ customerId, direction: "out", msgType: "text", content: "ยินดีค่ะ", messageClass: "reactive", agentMode: "ai" });
  inbound(db, customerId, "ผมทำร้านอาหารครับ", "h-typed");

  const raw = db.recentTurns(customerId, 12);
  const rawSnapshot = JSON.stringify(raw);
  const view = collapsePresetBurst(raw);
  assert.equal(raw.filter((turn) => turn.role === "user" && turn.content === BUTTON).length, 3, "recentTurns เองไม่เปลี่ยน");
  assert.equal(view.filter((turn) => turn.role === "user" && turn.content === BUTTON).length, 1);
  assert.equal(view.length, 3);
  assert.equal(view[0].tapCount, 3);
  assert.equal(JSON.stringify(raw), rawSnapshot, "อาร์เรย์จาก recentTurns ต้องไม่ถูกแก้");
  assert.equal(db.messagesFor(customerId, 50).filter((row) => row.direction === "in").length, 4, "แถวที่เก็บไว้ครบ");
});

test("รายการปุ่มที่เจ้าของตั้งเองมีผลกับไปป์ไลน์จริง (LINE rich menu ส่งวลีของตัวเอง)", async (t) => {
  const clock = { at: Date.parse("2026-09-04T13:00:00Z") };
  const { db, app, replyCalls } = bootApp(t, { clock });
  db.setSetting(PRESET_BUTTON_PHRASES_KEY, JSON.stringify(["สนใจคลาสสอนสด"]));
  const customerId = "U-line-richmenu";
  const turns = [];
  for (let index = 0; index < 2; index += 1) {
    inbound(db, customerId, "สนใจคลาสสอนสด", `rm-${index}`);
    turns.push(app.pipeline.handleInboundText({ customerId, text: "สนใจคลาสสอนสด", replyToken: `rt-${index}` }));
    clock.at += 500;
  }
  await Promise.all(turns);
  assert.equal(replyCalls().length, 1);
  const prompt = promptOf(replyCalls()[0]);
  assert.equal(prompt.current, "สนใจคลาสสอนสด");
  assert.match(prompt.system, /กดมา 2 ครั้ง/u);
  assert.match(prompt.system, /ปุ่มนี้ไม่ได้ถามเรื่องเงิน/u);
  // วลีตั้งต้นของ Facebook ไม่อยู่ในรายการที่ตั้งเองแล้ว = ถือว่าพิมพ์เอง
  assert.equal(isPresetButtonTap(BUTTON, presetButtonPhrases({ db })), false);
});
