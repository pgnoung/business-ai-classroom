// reply-style-bank.test.mjs — คลังคำตอบจริงของครู: สวิตช์ · อ่านไฟล์ · เลือกตามขั้นและความคล้าย · ปิด = ไม่มีอะไรเปลี่ยน
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStyleBank, renderStyleExamples, replyStyleBankMode, REPLY_STYLE_BANK_KEY, selectStyleExamples, STYLE_BANK_HEADER } from "../src/replyStyle/styleBank.mjs";
import { BEHAVIOR_SWITCHES } from "../src/consoleBehaviorSwitchesApi.mjs";

const settingDb = (value) => ({ getSetting: (key) => (key === REPLY_STYLE_BANK_KEY ? value : null) });
const BANK = {
  version: "test",
  items: [
    { id: "a", stage: "DISCOVERY", user: "กิจการส่วนตัวค่ะ", prev: "ทำงานด้านไหนอยู่คะ", reply: "เป็นเจ้าของกิจการเองเลยนะคะ แบบนี้ AI ช่วยได้เยอะเลยค่ะ" },
    { id: "b", stage: "DISCOVERY", user: "ไม่มีครับ", prev: "", reply: "ไม่เป็นไรเลยค่ะ เริ่มจากตรงนี้ได้สบาย ๆ นะคะ" },
    { id: "c", stage: "BRIDGE", user: "ขายของออนไลน์ค่ะ", prev: "", reply: "ขายของออนไลน์เป็นโจทย์ที่ชัดและใช้ได้จริงเลยค่ะ" },
    { id: "d", stage: "PRICE", user: "ราคาเท่าไหร่", prev: "", reply: "ได้เลยค่ะ" },
    { id: "bad", stage: "DISCOVERY", user: "x" },
  ],
};
function bankFile(data = BANK) {
  const dir = mkdtempSync(join(tmpdir(), "style-bank-"));
  const file = join(dir, "bank.json");
  writeFileSync(file, JSON.stringify(data));
  return file;
}

test("สวิตช์ reply_style_bank: ไม่มีแถว/ค่าแปลก = off · on ต้องสะกดตรง · คอนโซลตั้งได้", () => {
  assert.equal(replyStyleBankMode(settingDb(null)), "off");
  assert.equal(replyStyleBankMode(settingDb("yes")), "off");
  assert.equal(replyStyleBankMode(settingDb(" ON ")), "on");
  assert.equal(replyStyleBankMode({ getSetting() { throw new Error("db"); } }), "off");
  const item = BEHAVIOR_SWITCHES.find((entry) => entry.key === REPLY_STYLE_BANK_KEY);
  assert.ok(item);
  assert.deepEqual([...item.values], ["on", "off"]);
});

test("อ่านคลัง: ข้ามแถวที่ไม่มีคำตอบ · ไม่มีไฟล์/ไฟล์พัง = []", () => {
  const items = loadStyleBank(bankFile());
  assert.deepEqual(items.map((item) => item.id), ["a", "b", "c", "d"]);
  assert.deepEqual(loadStyleBank(""), []);
  assert.deepEqual(loadStyleBank("/no/such/file.json"), []);
  const dir = mkdtempSync(join(tmpdir(), "style-bank-bad-"));
  writeFileSync(join(dir, "b.json"), "{not json");
  const warn = [];
  assert.deepEqual(loadStyleBank(join(dir, "b.json"), { warn: (m) => warn.push(m) }), []);
  assert.equal(warn.length, 1);
});

test("เลือก: ขั้นเดียวกันก่อน แล้วข้อความลูกค้าที่คล้ายที่สุด · ไม่เกิน k · ขั้นที่ไม่เกี่ยวไม่มา", () => {
  const bank = loadStyleBank(bankFile());
  const picked = selectStyleExamples(bank, { stage: "DISCOVERY", userText: "เป็นกิจการส่วนตัวครับ", k: 2 });
  assert.deepEqual(picked.map((item) => item.id), ["a", "b"]);
  const pitch = selectStyleExamples(bank, { stage: "BRIDGE", userText: "ขายของออนไลน์ครับ", k: 4 });
  assert.equal(pitch[0].id, "c");
  assert.ok(!pitch.some((item) => item.id === "d" && item.stage !== "BRIDGE" && false));
  assert.deepEqual(selectStyleExamples([], { stage: "DISCOVERY", userText: "x" }), []);
});

test("แสดงผล: มีหัวข้อกำกับว่าข้อเท็จจริงใช้จากเทิร์นนี้ และห้ามลอก · ไม่มีตัวอย่าง = สตริงว่าง", () => {
  const bank = loadStyleBank(bankFile());
  const text = renderStyleExamples(selectStyleExamples(bank, { stage: "DISCOVERY", userText: "กิจการส่วนตัว", k: 1 }));
  assert.ok(text.startsWith(STYLE_BANK_HEADER));
  assert.ok(text.includes("ครูตอบ: เป็นเจ้าของกิจการเองเลยนะคะ"));
  assert.ok(STYLE_BANK_HEADER.includes("ใช้จากข้อมูลและงานของเทิร์นนี้เท่านั้น"));
  assert.ok(STYLE_BANK_HEADER.includes("ห้ามลอก"));
  assert.equal(renderStyleExamples([]), "");
});

test("การ์ดเปิด: งานของเทิร์นใช้ 'ข้อเสนอแบบถามความสนใจ' · ช่องที่ไม่ใช่ข้อความไม่ถูกแตะ", async () => {
  const { interestWording } = await import("../src/replyEngineV3/engine.mjs");
  const plan = { thai: "เชื่อมโจทย์", band: [320, 600], closingShort: "ข้อเสนอแบบขออนุญาตหนึ่งข้อ", text: "ปิดด้วยข้อเสนอแบบขออนุญาตหนึ่งข้อ: x" };
  const out = interestWording(plan);
  assert.equal(out.closingShort, "ข้อเสนอแบบถามความสนใจหนึ่งข้อ");
  assert.equal(out.text, "ปิดด้วยข้อเสนอแบบถามความสนใจหนึ่งข้อ: x");
  assert.deepEqual(out.band, [320, 600]);
  assert.equal(plan.text, "ปิดด้วยข้อเสนอแบบขออนุญาตหนึ่งข้อ: x", "ของเดิมไม่ถูกแก้");
});

test("การ์ดเปิด: ช่วงความยาวขยาย 25% ปัดหลักสิบ · ค่าแปลกคืนเดิม", async () => {
  const { teacherBand } = await import("../src/replyEngineV3/engine.mjs");
  assert.deepEqual(teacherBand([170, 280]), [210, 350]);
  assert.deepEqual(teacherBand([320, 600]), [400, 750]);
  assert.equal(teacherBand(null), null);
});

test("การ์ดเปิด: คำสั่ง 'รับ…ด้วยคำของเขา' กลายเป็นสูตรครู · จังหวะเห็นใจไม่ถูกแตะ", async () => {
  const { interestWording } = await import("../src/replyEngineV3/engine.mjs");
  const text = "รับคำตอบของเขาสั้น ๆ ด้วยคำของเขา (\"งานเอกสารครับ\") หนึ่งประโยค — ไม่ยกตัวอย่างงานที่ AI ช่วยได้ และไม่สอนวิธีทำ\nรับรู้ความกังวลด้วยคำของเขาอย่างเข้าใจ";
  const out = interestWording({ text }).text.split("\n");
  assert.match(out[0], /^รับคำตอบของเขา \("งานเอกสารครับ"\) หนึ่งประโยคแบบครู: หยิบคำของเขามาบอกว่าแปลว่าอะไร/u);
  assert.match(out[0], /ไม่ใช่แค่ทวนคำ — ไม่ไล่รายการตัวอย่างงาน และไม่สอนวิธีทำ$/u);
  assert.equal(out[1], "รับรู้ความกังวลด้วยคำของเขาอย่างเข้าใจ");
});

test("สถานการณ์เดียวกับที่ครูเคยตอบ: ตัวอย่างแรกเป็นแบบได้ · ถามคนละเรื่อง = ตัวอย่างธรรมดา", () => {
  const bank = loadStyleBank(bankFile());
  const same = selectStyleExamples(bank, { stage: "DISCOVERY", userText: "กิจการส่วนตัวครับ", prevBot: "ทำงานด้านไหนอยู่คะ", k: 2 });
  assert.equal(same[0].id, "a");
  assert.equal(same[0].strong, true);
  assert.ok(renderStyleExamples(same).includes("ใช้คำตอบนั้นเป็นแบบได้"));
  const other = selectStyleExamples(bank, { stage: "DISCOVERY", userText: "กิจการส่วนตัวครับ", prevBot: "สนใจคลาสรอบไหนคะ", k: 2 });
  assert.ok(!other.some((item) => item.strong));
  assert.ok(!renderStyleExamples(other).includes("ใช้คำตอบนั้นเป็นแบบได้"));
});

test("ทักตาม: สวิตช์แยก followup_style_bank · ไม่มีคลัง = กติกาเดิม · มีคลัง = ตัวอย่างตามชนิดเรื่องที่ค้าง", async () => {
  const { followupStyleBankMode, FOLLOWUP_STYLE_BANK_KEY, withFollowupExamples, FOLLOWUP_BANK_PLACEHOLDER } = await import("../src/replyStyle/styleBank.mjs");
  const db = (v) => ({ getSetting: (k) => (k === FOLLOWUP_STYLE_BANK_KEY ? v : null) });
  assert.equal(followupStyleBankMode(db(null)), "off");
  assert.equal(followupStyleBankMode(db("on")), "on");
  assert.equal(withFollowupExamples("กติกาเดิม", [], { threadKind: "work" }), "กติกาเดิม");
  const fu = loadStyleBank(bankFile({ items: [
    { id: "w1", stage: "work", user: "งานเอกสาร", prev: "ทำงานด้านไหนคะ", reply: "งานเอกสารเริ่มให้ AI ช่วยได้เร็วเลยค่ะ ไม่ทราบว่าทำเอกสารแบบไหนบ่อยคะ?" },
    { id: "r1", stage: "round_choice", user: "สนใจ", prev: "สะดวกรอบไหนคะ", reply: "รอบที่เปิดอยู่คือ [รอบตามข้อมูลจริง] ค่ะ สะดวกรอบไหนดีคะ?" },
  ] }));
  const out = withFollowupExamples("กติกาเดิม", fu, { threadKind: "work", userText: "งานเอกสาร", prevBot: "ทำงานด้านไหนคะ", k: 1 });
  assert.ok(out.startsWith("กติกาเดิม\n\n## ข้อความทักตามจริงของครู"));
  assert.ok(out.includes("ครูทักตาม: งานเอกสารเริ่มให้ AI ช่วยได้เร็ว"));
  assert.ok(FOLLOWUP_BANK_PLACEHOLDER.test("รอบที่เปิดคือ [รอบตามข้อมูลจริง] ค่ะ"));
  assert.ok(FOLLOWUP_BANK_PLACEHOLDER.test("ไม่ทราบว่าคุณ(ชื่อ) สนใจไหมคะ"));
  assert.ok(!FOLLOWUP_BANK_PLACEHOLDER.test("รอบที่เปิดคือเสาร์ 14 พ.ย. ค่ะ"));
});
