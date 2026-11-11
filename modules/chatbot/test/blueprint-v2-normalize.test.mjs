// blueprint-v2-normalize.test.mjs — v2: normalize ซ่อมสิ่งที่ซ่อมได้เอง (ยาวเกิน · รายการเกิน · เลขใกล้คำเรื่องเงิน) แทนการเรียกโมเดลใหม่
// ที่มา: รอบจริงคืน 11 ต.ค. 2026 ทุกครั้งที่ตีกลับเพราะยาวเกิน = เผารอบเรียกโมเดล ("inputs[2].note: ยาว 75 เกิน 72",
// "authority.never[1]: ยาว 83 เกิน 60", "watchOuts[1]: ยาว 113 เกิน 96") · ไม่เรียกโมเดล ไม่เรียก LINE
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createComplianceGuard, loadBannedWords } from "../src/complianceGuard.mjs";
import {
  BLUEPRINT_LIMITS as L, normalizeBlueprint, parseBlueprintText, validateBlueprint, shortenThai, thaiQuantities,
  thaiNumberWord, priceSafeNumbers, textProblems, cpLength, isLegacyBlueprint,
} from "../src/blueprint/blueprintSchema.mjs";
import { SAMPLE_BLUEPRINT } from "./blueprint-fixtures.mjs";

const BANNED_FILE = fileURLToPath(new URL("../config/clinic-banned.json", import.meta.url));
const SILENT = Object.freeze({ warn() {}, info() {}, debug() {} });
const guard = createComplianceGuard({ bannedWords: loadBannedWords(BANNED_FILE, { logger: SILENT }), getApprovedPrices: () => [], logger: SILENT });
const clone = (value) => JSON.parse(JSON.stringify(value));
const SEGMENTER = new Intl.Segmenter("th", { granularity: "word" });
/** จุดตัดคำไทยทั้งหมดของข้อความ (ตำแหน่ง code point) */
const boundaries = (text) => {
  const out = new Set([0]);
  let at = 0;
  for (const part of SEGMENTER.segment(text)) {
    at += cpLength(part.segment);
    out.add(at);
  }
  return out;
};
/** ผลที่ตัดแล้วต้องเป็นส่วนต้นของต้นฉบับ และจบตรงขอบคำ (ไม่ตัดกลางคำ) */
function assertWordCut(original, cut, max) {
  assert.ok(cpLength(cut) <= max, `${cpLength(cut)} > ${max}: ${cut}`);
  assert.ok(cut.length > 0);
  assert.ok(original.startsWith(cut), `ไม่ใช่ส่วนต้นของต้นฉบับ: ${cut}`);
  assert.ok(boundaries(original).has(cpLength(cut)), `ตัดกลางคำ: ${cut}|${[...original].slice(cpLength(cut), cpLength(cut) + 4).join("")}`);
  assert.ok(!cut.endsWith("…") && !/\s$/u.test(cut));
}

/* ------------------------------- shortenThai ------------------------------ */

test("shortenThai: ไม่เกินเพดาน = คืนค่าเดิม · ไม่ใช่ข้อความ = คืนค่าเดิม", () => {
  assert.equal(shortenThai("ร่างคำตอบให้ทีมตรวจ", 60), "ร่างคำตอบให้ทีมตรวจ");
  assert.equal(shortenThai(42, 10), 42);
  assert.equal(shortenThai(null, 10), null);
});

test("shortenThai: เลือกจุดเว้นวรรค (จบวลี) ก่อน ไม่ตัดกลางคำ ไม่เติม …", () => {
  const text = "ใช้รหัสเคส วันนัดที่ทีมยืนยัน และสถานะการจอง เพื่อจัดลำดับคิวที่ต้องตามก่อนแล้วส่งให้คนตรวจทุกเช้า";
  const cut = shortenThai(text, 60);
  assertWordCut(text, cut, 60);
  assert.equal(cut, "ใช้รหัสเคส วันนัดที่ทีมยืนยัน และสถานะการจอง");
});

test("shortenThai: ไม่มีช่องว่างลึกพอ = ตัดที่ขอบคำ และทิ้งคำเชื่อมที่ค้างท้าย", () => {
  const text = "ร่างคำตอบพร้อมอ้างอิงเอกสารแยกข้อมูลขาดหรือขัดกันและส่งให้คนตรวจก่อนทุกครั้ง";
  for (const max of [20, 31, 40, 55, 70]) {
    const cut = shortenThai(text, max);
    assertWordCut(text, cut, max);
    assert.doesNotMatch(cut, /(?:และ|หรือ|ให้|ที่|ของ|กับ)$/u, `คำเชื่อมค้างท้าย: ${cut}`);
  }
});

test("shortenThai: วงเล็บไม่ปิด/เครื่องหมายค้างท้ายถูกตัดออก · คำเดียวยาวเกิน = ตัดที่ขอบตัวอักษร", () => {
  const cut = shortenThai("ตรวจใบงานกับบันทึกรับเงิน (เช่น ใบเสร็จ ใบโอน และสมุดรายวันของร้าน)", 40);
  assert.doesNotMatch(cut, /\(/u);
  assert.ok(cpLength(cut) <= 40);
  const latin = shortenThai("abcdefghijklmnopqrstuvwxyzabcdefghij", 20);
  assert.equal(latin, "abcdefghijklmnopqrst");
});

/* ------------------------- รอบจริงคืน 11 ต.ค. ไม่ตีกลับแล้ว ------------------------- */

test("normalize: สามช่องที่ตีกลับจริงคืน 11 ต.ค. (ยาวเกิน) ผ่าน parse ได้ทันที — ตัดที่ขอบคำ ไม่เรียกโมเดลใหม่", () => {
  const raw = clone(SAMPLE_BLUEPRINT);
  // inputs[2].note ยาว 75 (เพดานเดิม 72 · v2 = 80 ผ่านโดยไม่ต้องตัด)
  raw.inputs[2].note = "คัดคำถามที่ลูกค้าถามซ้ำทุกสัปดาห์ แล้วจับคู่กับคำตอบที่ทีมใช้และหัวหน้าตรวจ";
  // authority.never[1] ยาว 83 (เพดานเดิม 60 · v2 = 68 → ตัด)
  raw.authority.never = [raw.authority.never[0], "ขอหรือเก็บเบอร์โทร เลขบัตร ข้อมูลสุขภาพ หรือบัญชีธนาคารของลูกค้าไว้ในตารางงานและแชททีม"];
  // watchOuts[1] ยาว 113 (เพดานเดิม 96 · v2 = 106 → ตัด)
  raw.watchOuts = [raw.watchOuts[0], "ถ้าเมนูหรือเวลาเปิดเปลี่ยนกะทันหัน ให้หยุดร่างคำตอบเรื่องนั้นและแจ้งทีมหน้าร้านก่อน ไม่ตอบจากข้อมูลเดิมที่อาจหมดอายุแล้วโดยไม่มีใครรู้"];
  assert.equal(cpLength(raw.inputs[2].note), 75);
  assert.ok(cpLength(raw.authority.never[1]) > L.authority.item && cpLength(raw.watchOuts[1]) > L.watchOuts.item);
  assert.equal(validateBlueprint(raw).ok, false, "ค่าดิบยาวเกินเพดาน (ยืนยันว่าเคสนี้ต้องซ่อมจริง)");

  const parsed = parseBlueprintText(JSON.stringify(raw));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.value.inputs[2].note, raw.inputs[2].note, "ยาวไม่เกินเพดาน v2 = ไม่ตัด");
  assertWordCut(raw.authority.never[1], parsed.value.authority.never[1], L.authority.item);
  assertWordCut(raw.watchOuts[1], parsed.value.watchOuts[1], L.watchOuts.item);
});

test("normalize: ทุกช่องสตริงที่ยาวเกินถูกตัดที่ขอบคำ (สร้างจากข้อความไทยจริงยาวสองเท่าเพดาน)", () => {
  const long = (max) => "ตรวจใบงาน เทียบบันทึกรับเงิน แยกเรื่องที่ขาดหลักฐาน และร่างสรุปให้คุณตรวจก่อนปิดร้านทุกวัน ".repeat(Math.ceil((max * 2) / 80)).trim();
  const raw = clone(SAMPLE_BLUEPRINT);
  raw.businessLabel = long(L.businessLabel);
  raw.nextLevel = long(L.nextLevel);
  raw.sampleOutput = { title: long(L.sampleOutput.title), lines: [long(L.sampleOutput.line), "ลูกค้า ข: รอข้อมูล", "รอคุณตัดสิน: ลูกค้า ค"] };
  for (const key of ["headline", "businessRestated", "agentName", "mission", "whyThisFirst", "firstStepTomorrow", "toolsHint"]) raw[key] = long(L[key]);
  raw.steps[0].what = long(L.steps.what);
  raw.pilot7days[0].action = long(L.pilot7days.action);
  raw.metrics[0].how = long(L.metrics.how);
  const parsed = parseBlueprintText(JSON.stringify(raw));
  assert.deepEqual(parsed.errors, []);
  const v = parsed.value;
  for (const key of ["headline", "businessRestated", "agentName", "mission", "whyThisFirst", "firstStepTomorrow", "toolsHint", "businessLabel", "nextLevel"]) {
    assertWordCut(raw[key], v[key], L[key]);
  }
  assertWordCut(raw.sampleOutput.title, v.sampleOutput.title, L.sampleOutput.title);
  assertWordCut(raw.sampleOutput.lines[0], v.sampleOutput.lines[0], L.sampleOutput.line);
  assertWordCut(raw.steps[0].what, v.steps[0].what, L.steps.what);
  assertWordCut(raw.pilot7days[0].action, v.pilot7days[0].action, L.pilot7days.action);
  assertWordCut(raw.metrics[0].how, v.metrics[0].how, L.metrics.how);
});

test("normalize: รายการเกินจำนวนสูงสุด = ตัดส่วนเกิน · ขั้นตอนและแผน 7 วันเก็บข้อสุดท้าย (ส่งงาน/ตัดสินวัน 7)", () => {
  const raw = clone(SAMPLE_BLUEPRINT);
  raw.steps = ["อ่าน", "แยก", "ร่าง", "ตรวจ", "ส่งต่อ", "ส่งสรุปให้คุณตรวจ"].map((what) => ({ what }));
  raw.pilot7days = ["วัน 1", "วัน 2", "วัน 3", "วัน 4", "วัน 5-6", "วัน 7"].map((day) => ({ day, action: `ทำงานของ${day}` }));
  raw.inputs = [...raw.inputs, { source: "ข้อมูลที่สี่", note: "x" }, { source: "ข้อมูลที่ห้า", note: "y" }];
  raw.authority.canDo = ["ก", "ข", "ค", "ง"];
  raw.watchOuts = ["หนึ่ง", "สอง", "สาม"];
  raw.metrics = [...raw.metrics, { name: "สาม", how: "นับ" }, { name: "สี่", how: "นับ" }];
  const parsed = parseBlueprintText(JSON.stringify(raw));
  assert.deepEqual(parsed.errors, []);
  const v = parsed.value;
  assert.deepEqual(v.steps.map((s) => s.what), ["อ่าน", "แยก", "ร่าง", "ส่งสรุปให้คุณตรวจ"]);
  assert.deepEqual(v.pilot7days.map((p) => p.day), ["วัน 1", "วัน 2", "วัน 3", "วัน 4", "วัน 7"]);
  assert.equal(v.inputs.length, L.inputs.max);
  assert.deepEqual(v.authority.canDo, ["ก", "ข"]);
  assert.deepEqual(v.watchOuts, ["หนึ่ง", "สอง"]);
  assert.equal(v.metrics.length, L.metrics.max);
  // น้อยกว่าขั้นต่ำยังตีกลับ (ซ่อมเองไม่ได้)
  const few = clone(SAMPLE_BLUEPRINT);
  few.steps = [{ what: "อ่าน" }];
  assert.match(parseBlueprintText(JSON.stringify(few)).errors.join("\n"), /steps: มี 1 รายการ/u);
});

test("normalize: เนื้อหาผิดกติกายังตีกลับเหมือนเดิม (ตัดความยาวไม่ได้ช่วยให้ผ่าน)", () => {
  for (const [path, value, pattern] of [
    ["toolsHint", "ผู้ช่วย AI อย่าง ChatGPT สำหรับร่าง", /ค่ายหรือรุ่นโมเดล/u],
    ["mission", "ตอบลูกค้าเรื่อง确认คิว", /อักษรต่างภาษา/u],
    ["firstStepTomorrow", "ดูวิธีที่ https://example.com", /ลิงก์/u],
    ["headline", "การันตีผลภายในเจ็ดวัน", /คำที่ด่านตรวจข้อความบล็อก|รับประกัน/u],
    ["whyThisFirst", "ยอดมัดจำ 12,500 ต้องตามก่อน", /ตัวเลขแบบจำนวนเงิน/u],
  ]) {
    const raw = clone(SAMPLE_BLUEPRINT);
    raw[path] = value;
    const parsed = parseBlueprintText(JSON.stringify(raw));
    assert.equal(parsed.ok, false, value);
    assert.match(parsed.errors.join("\n"), pattern, value);
  }
});

test("normalize: ไม่แก้ object เดิม ไม่เติม/ลบช่อง · แผนรุ่นแรกจากเทสต์ผู้ส่ง parse แล้วได้ค่าเดิมทุกไบต์", () => {
  const raw = clone(SAMPLE_BLUEPRINT);
  raw.authority.never.push("ข้อที่สาม", "ข้อที่สี่");
  const before = JSON.stringify(raw);
  const out = normalizeBlueprint(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(Object.keys(out), Object.keys(raw));
  assert.equal(isLegacyBlueprint(out), true);
  // สัญญากับ blueprint-sender.test.mjs: draft.blueprint ต้อง deepEqual SAMPLE_BLUEPRINT
  assert.deepEqual(parseBlueprintText(JSON.stringify(SAMPLE_BLUEPRINT)).value, SAMPLE_BLUEPRINT);
  const extra = normalizeBlueprint({ ...clone(SAMPLE_BLUEPRINT), price: "x" });
  assert.equal(extra.price, "x", "ช่องแปลกยังอยู่ ให้ validate ตีกลับ");
  assert.equal(normalizeBlueprint(null), null);
  assert.deepEqual(normalizeBlueprint([1]), [1]);
});

/* ----------------------- เลขใกล้คำเรื่องเงิน (ด่านราคาของลูกแพร) ----------------------- */

test("thaiQuantities: เลข 1-2 หลักในช่องที่มีคำเรื่องเงินเป็นคำไทย · เวลา ร้อยละ รหัส และช่องอื่นไม่แตะ", () => {
  assert.equal(thaiQuantities("เลือกใบเสนอราคา 5 ใบที่ค้างเกิน 3 วัน"), "เลือกใบเสนอราคาห้าใบที่ค้างเกินสามวัน");
  assert.equal(thaiQuantities("ยอดขาย 2-3 สัปดาห์ล่าสุด"), "ยอดขายสองถึงสามสัปดาห์ล่าสุด");
  assert.equal(thaiQuantities("ยอดรวมก่อน 08:30 ของบิลกระดาษ A4"), "ยอดรวมก่อน 08:30 ของบิลกระดาษ A4");
  assert.equal(thaiQuantities("ส่วนลดเกิน 10% ให้คุณตัดสิน"), "ส่วนลดเกิน 10% ให้คุณตัดสิน");
  assert.equal(thaiQuantities("วัน 3-4"), "วัน 3-4", "ไม่มีคำเรื่องเงิน = ไม่แตะ");
  assert.equal(thaiQuantities("ไม่มีคำเรื่องเงิน 5 ใบ", { force: true }), "ไม่มีคำเรื่องเงินห้าใบ");
  for (const [n, word] of [[0, "ศูนย์"], [1, "หนึ่ง"], [10, "สิบ"], [11, "สิบเอ็ด"], [20, "ยี่สิบ"], [21, "ยี่สิบเอ็ด"], [35, "สามสิบห้า"], [99, "เก้าสิบเก้า"]]) {
    assert.equal(thaiNumberWord(n), word);
  }
  assert.equal(thaiNumberWord(100), "100");
});

test("normalize + ด่านจริง: ช่องที่ด่านราคาเคยบล็อกผ่านหลัง normalize · บรรทัดหน้าตางานแปลงทั้งชุดให้ตัวแทนเหมือนกัน", () => {
  assert.equal(guard.checkOutbound("เลือกใบเสนอราคา 5 ใบ", {}).ok, false, "ยืนยันว่าด่านจริงบล็อกค่าดิบ");
  const raw = { ...clone(SAMPLE_BLUEPRINT), businessLabel: "ร้านกาแฟ", nextLevel: "รับต่อถึงสรุปเมนูขายดี",
    sampleOutput: { title: "ร่างตอบแชท 11:00", lines: ["ลูกค้ารายที่ 1: ถามเมนู", "ลูกค้ารายที่ 2: ขอส่วนลดออเดอร์ใหญ่", "รอคุณตัดสิน: ลูกค้ารายที่ 2"] } };
  raw.firstStepTomorrow = "เลือกใบเสนอราคา 5 ใบที่ค้างเกิน 3 วัน";
  const parsed = parseBlueprintText(JSON.stringify(raw));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.value.firstStepTomorrow, "เลือกใบเสนอราคาห้าใบที่ค้างเกินสามวัน");
  assert.equal(guard.checkOutbound(parsed.value.firstStepTomorrow, {}).ok, true);
  assert.deepEqual(parsed.value.sampleOutput.lines, ["ลูกค้ารายที่หนึ่ง: ถามเมนู", "ลูกค้ารายที่สอง: ขอส่วนลดออเดอร์ใหญ่", "รอคุณตัดสิน: ลูกค้ารายที่สอง"]);
  assert.equal(parsed.value.sampleOutput.title, "ร่างตอบแชท 11:00");
});

test("priceSafeNumbers: ข้อความหลายบรรทัด — เลขที่ใกล้คำเรื่องเงินข้ามบรรทัดเป็นคำไทย/เลขไทย · ด่านจริงผ่าน", () => {
  const joined = "• ตีราคาทองตามป้ายร้าน\n• เก็บบิลย้อนหลัง 300 ใบ\n• สรุปยอด 5 รายการ\n• นัด 08:30 กระดาษ A4\n๑. อ่านแชท 3 ห้อง";
  assert.equal(guard.checkOutbound(joined, {}).ok, false, "ยืนยันว่าค่าดิบโดนด่าน");
  const safe = priceSafeNumbers(joined);
  assert.equal(safe, "• ตีราคาทองตามป้ายร้าน\n• เก็บบิลย้อนหลัง ๓๐๐ ใบ\n• สรุปยอดห้ารายการ\n• นัด 08:30 กระดาษ A4\n๑. อ่านแชท 3 ห้อง");
  assert.equal(guard.checkOutbound(safe, {}).ok, true);
  assert.equal(priceSafeNumbers("ไม่มีคำเรื่องเงิน 300 ใบ"), "ไม่มีคำเรื่องเงิน 300 ใบ");
});

test("textProblems: คำว่า รับประกัน/การันตี ผ่านได้เฉพาะในวลีห้าม (เจอจริงในรอบพิสูจน์: ข้อควรระวังของคลินิก)", () => {
  for (const ok of ["คำถามเรื่องอาการส่งต่อแพทย์ ไม่ร่างคำแนะนำรักษาหรือคำรับประกัน", "ห้ามให้คำการันตีกับลูกค้า", "ไม่รับประกันผลการรักษา"]) {
    assert.deepEqual(textProblems(ok), [], ok);
    assert.equal(guard.checkOutbound(ok, {}).ok, true, ok);
  }
  for (const bad of ["รับประกันยอดขายเพิ่ม", "ไม่ต้องห่วงรับประกันผล", "ไม่ต้องห่วง รับประกันผล", "การันตีว่าได้คิว", "guarantee results", "ได้ผลแน่นอน 100%"]) {
    assert.match(textProblems(bad).join(" "), /รับประกัน/u, bad);
  }
});
