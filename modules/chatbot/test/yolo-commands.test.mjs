// yolo-commands — ตัวแยกคำสั่งของพี่ง้วง (รูปแบบมาตรฐาน + ภาษาไทยแปลก ๆ) และด่านตรวจผล mini AI
// ไม่มีโมเดล/เครือข่ายในไฟล์นี้ — ทุกกรณีต้องได้ผลเดิมทุกครั้ง
import test from "node:test";
import assert from "node:assert/strict";
import { parseOwnerCommand, takeChannel, takeEnableAiSuffix, validateMiniAiCommand } from "../src/yoloCommands.mjs";
import { cleanInstruction, formatBangkokTime, maskName, nameKey, normalizeForMatch, previewText, stripHonorific } from "../src/yoloText.mjs";
import { poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

test("canonical yolo: ช่องทาง + ชื่อ + สิ่งที่ให้ทำ ส่งต่อให้ตัวหาชื่อแยกขอบเอง", () => {
  assert.deepEqual(parseOwnerCommand("yolo LINE คุณทดสอบ ถามต่อเรื่องจำนวนพนักงาน"), {
    action: "yolo", channel: "LINE", target: "คุณทดสอบ ถามต่อเรื่องจำนวนพนักงาน", form: "leading", alsoEnableAi: false,
  });
  // รูปแบบในข้อความของพี่ง้วงเอง: วงเล็บครอบทั้งช่องทางและชื่อ
  const owner = parseOwnerCommand("yolo (FB) (คุณสมชาย ใจดี) ตอบเรื่อง in-house ต่อ");
  assert.equal(owner.channel, "FB");
  assert.equal(owner.target, "(คุณสมชาย ใจดี) ตอบเรื่อง in-house ต่อ");
  assert.equal(parseOwnerCommand("/yolo@lukprae_bot line คุณเอ").channel, "LINE");
  assert.equal(parseOwnerCommand("YOLO ไลน์ คุณเอ ทักทาย").channel, "LINE");
  assert.equal(parseOwnerCommand("yolo เฟสบุ๊ค คุณเอ").channel, "FB");
  assert.equal(parseOwnerCommand("yolo messenger: คุณเอ").channel, "FB");
  assert.equal(parseOwnerCommand("yolo คุณเอ ทักทาย").channel, "", "ไม่ระบุช่อง = หาได้ทุกช่อง");
});

test("channel token ต้องเป็นคำเดี่ยว — ชื่อที่ขึ้นต้นด้วย line ไม่ถูกตีเป็นช่องทาง", () => {
  assert.deepEqual(takeChannel("Linda ถามต่อ"), { channel: "", rest: "Linda ถามต่อ" });
  assert.deepEqual(takeChannel("lineman ถามต่อ"), { channel: "", rest: "lineman ถามต่อ" });
  assert.deepEqual(takeChannel("(line) คุณเอ"), { channel: "LINE", rest: "คุณเอ" });
  assert.deepEqual(takeChannel("FB คุณเอ"), { channel: "FB", rest: "คุณเอ" });
});

test("แล้วคุยต่อ / เปิด AI ด้วย ท้ายคำสั่ง = เปิด AI หลังส่ง แต่ 'ชวนคุยต่อ' เป็นเนื้อคำสั่ง", () => {
  assert.deepEqual(takeEnableAiSuffix("ถามต่อเรื่องราคา แล้วคุยต่อ"), { text: "ถามต่อเรื่องราคา", alsoEnableAi: true });
  assert.deepEqual(takeEnableAiSuffix("ถามต่อเรื่องราคาแล้วคุยต่อเลยนะ"), { text: "ถามต่อเรื่องราคา", alsoEnableAi: true });
  assert.deepEqual(takeEnableAiSuffix("ทักทาย เปิด AI ด้วย"), { text: "ทักทาย", alsoEnableAi: true });
  assert.deepEqual(takeEnableAiSuffix("ทักทาย และเปิดเอไอ"), { text: "ทักทาย", alsoEnableAi: true });
  assert.deepEqual(takeEnableAiSuffix("ทักทาย +ai"), { text: "ทักทาย", alsoEnableAi: true });
  assert.deepEqual(takeEnableAiSuffix("ชวนคุยต่อ"), { text: "ชวนคุยต่อ", alsoEnableAi: false });
  assert.deepEqual(takeEnableAiSuffix("บอกว่าเปิด AI แล้ว"), { text: "บอกว่าเปิด AI แล้ว", alsoEnableAi: false });
  assert.deepEqual(takeEnableAiSuffix("แล้วคุยต่อเรื่องราคา"), { text: "แล้วคุยต่อเรื่องราคา", alsoEnableAi: false });
  assert.equal(parseOwnerCommand("yolo LINE คุณเอ ถามต่อ แล้วคุยต่อ").alsoEnableAi, true);
});

test("เปิด/ปิด AI และสถานะ: ตัดคำเติม/คำลงท้าย แต่ไม่ตัดชื่อที่ลงท้ายเหมือนคำลงท้าย", () => {
  assert.deepEqual(parseOwnerCommand("เปิด AI LINE คุณเอ ด้วย"), { action: "ai_on", channel: "LINE", target: "คุณเอ", form: "name" });
  assert.deepEqual(parseOwnerCommand("ปิดAI เฟสบุ๊ค มานะ"), { action: "ai_off", channel: "FB", target: "มานะ", form: "name" });
  assert.equal(parseOwnerCommand("ปิด ai ห้อง คุณนก หน่อย").target, "คุณนก");
  assert.equal(parseOwnerCommand("เปิดบอท คุณเอ").action, "ai_on");
  assert.equal(parseOwnerCommand("ai off LINE คุณเอ").action, "ai_off");
  // "เปิด AI" มีคำว่า "ปิด AI" ซ่อนอยู่ — ต้องไม่ถูกอ่านเป็นปิด
  assert.equal(parseOwnerCommand("เปิด AI คุณเอ").action, "ai_on");
  assert.deepEqual(parseOwnerCommand("สถานะ คุณเอ"), { action: "status", channel: "", target: "คุณเอ", form: "name" });
  assert.deepEqual(parseOwnerCommand("สถานะ"), { action: "status", channel: "", target: "", form: "name" });
});

test("help / empty / unknown", () => {
  for (const text of ["ช่วยด้วย", "help", "/help", "/start", "เมนู", "?"]) {
    assert.equal(parseOwnerCommand(text).action, "help", text);
  }
  assert.equal(parseOwnerCommand("   ").action, "empty");
  assert.equal(parseOwnerCommand("ทักคุณเอหน่อยว่าสนใจรอบหน้าไหม").action, "unknown");
  assert.equal(parseOwnerCommand("/start ABCD1234").action, "unknown", "/start พร้อมรหัสเป็นเรื่องของการจับคู่");
});

test("mini AI: ยอมรับเฉพาะ JSON ที่ชื่อลูกค้ามาจากข้อความของพี่ง้วงจริง", () => {
  const owner = "ทักคุณเอหน่อยว่าสนใจรอบหน้าไหม";
  const ok = validateMiniAiCommand("```json\n{\"action\":\"yolo\",\"channel\":null,\"customerQuery\":\"คุณเอ\",\"instruction\":\"ถามว่าสนใจรอบหน้าไหม\",\"alsoEnableAi\":false}\n```", owner);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.command, { action: "yolo", channel: "", target: "คุณเอ", form: "name", viaModel: true, instruction: "ถามว่าสนใจรอบหน้าไหม", alsoEnableAi: false });
  // โมเดลแต่งชื่อที่ไม่มีในข้อความ = ปฏิเสธ (ตัวเลือกห้องต้องไม่ใช่โมเดล)
  assert.equal(validateMiniAiCommand("{\"action\":\"yolo\",\"customerQuery\":\"สมชาย\"}", owner).reason, "target_not_in_text");
  // เปิด AI ลอย ๆ โดยที่พี่ง้วงไม่ได้พูดถึง = ไม่เชื่อ
  const flag = validateMiniAiCommand("{\"action\":\"yolo\",\"customerQuery\":\"เอ\",\"alsoEnableAi\":true}", owner);
  assert.equal(flag.command.alsoEnableAi, false);
  const said = validateMiniAiCommand("{\"action\":\"yolo\",\"customerQuery\":\"เอ\",\"alsoEnableAi\":true}", "ทักคุณเอแล้วเปิด AI ด้วย");
  assert.equal(said.command.alsoEnableAi, true);
  assert.equal(validateMiniAiCommand("ไม่ใช่ json", owner).reason, "not_json");
  assert.equal(validateMiniAiCommand("{\"action\":\"delete_all\",\"customerQuery\":\"เอ\"}", owner).reason, "bad_action");
  assert.equal(validateMiniAiCommand("{\"action\":\"unknown\"}", owner).reason, "model_unknown");
  assert.equal(validateMiniAiCommand("{\"action\":\"ai_on\",\"channel\":\"IG\",\"customerQuery\":\"เอ\"}", owner).reason, "bad_channel");
  assert.equal(validateMiniAiCommand("{\"action\":\"status\",\"customerQuery\":\"\"}", owner).reason, "bad_target");
  assert.equal(validateMiniAiCommand("{\"action\":\"yolo\",\"customerQuery\":\"เอ\",\"instruction\":42}", owner).reason, "bad_instruction");
  assert.deepEqual(validateMiniAiCommand("{\"action\":\"help\"}", "ใช้ยังไง").command, { action: "help" });
  const status = validateMiniAiCommand("{\"action\":\"status\",\"channel\":\"FB\",\"customerQuery\":\"คุณ เอ\"}", "ห้องคุณ เอ เป็นไงบ้าง");
  assert.equal(status.command.channel, "FB");
  assert.equal(status.command.instruction, undefined, "สถานะไม่มีคำสั่งส่งข้อความ");
});

test("normalize ชื่อไทย: คุณ/khun, เ+เ, ตัวล่องหน, emoji และ 'คุณากร' ไม่ถูกตัดผิด", () => {
  assert.equal(nameKey("คุณสมชาย"), "สมชาย");
  assert.equal(nameKey("คุณ สมชาย"), "สมชาย");
  assert.equal(nameKey("Khun Pim"), "pim");
  assert.equal(nameKey("K. Pim"), "pim");
  assert.equal(nameKey("คุณากร"), "คุณากร");
  assert.equal(normalizeForMatch("เเพร"), "แพร");
  assert.equal(normalizeForMatch("นํ้า"), "นํ้า".normalize("NFC"));
  assert.equal(normalizeForMatch("กํา"), "กำ");
  assert.equal(normalizeForMatch("🌸 Pim​ ✨"), "pim");
  assert.equal(stripHonorific("คุณ"), "คุณ", "ชื่อที่มีแต่คำนำหน้า ห้ามกลายเป็นค่าว่าง");
});

test("mask/preview/เวลาไทย/ตัดคำสั่ง", () => {
  assert.equal(maskName("คุณสมชาย ใจดี"), "ส***");
  assert.equal(maskName("สมชาย", 3), "สมช***");
  assert.equal(maskName("นก", 3), "น***", "ห้ามเปิดชื่อทั้งชื่อ");
  assert.equal(maskName("กี้", 1), "กี้***");
  assert.equal(maskName(""), "ลูกค้า");
  assert.equal(previewText("ก".repeat(50), 10), `${"ก".repeat(9)}…`);
  assert.equal(previewText("  สวัสดี\nค่ะ  ", 40), "สวัสดี ค่ะ");
  const now = Date.UTC(2026, 8, 28, 7, 0, 0); // 14:00 ไทย
  assert.equal(formatBangkokTime(now - 30_000, now), "เมื่อสักครู่");
  assert.equal(formatBangkokTime(now - 12 * 60_000, now), "12 นาทีก่อน");
  assert.equal(formatBangkokTime(now - 3 * 3_600_000, now), "วันนี้ 11:00");
  assert.equal(formatBangkokTime(now - 20 * 3_600_000, now), "เมื่อวาน 18:00");
  assert.equal(formatBangkokTime(now + 22 * 3_600_000, now), "พรุ่งนี้ 12:00");
  assert.equal(formatBangkokTime(Date.UTC(2026, 8, 20, 2, 5), now), "20 ก.ย. 09:05");
  assert.equal(formatBangkokTime(0, now), "-");
  assert.equal(cleanInstruction("ถาม\u0007ต่อ\n\n\n\nนะ"), "ถาม ต่อ\n\nนะ");
  assert.equal([...cleanInstruction("ก".repeat(600))].length, 500);
});
