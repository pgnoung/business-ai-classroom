// brain/gateSelfTest.mjs — G0: เครื่องมือตรวจต้องพิสูจน์ตัวเองก่อนที่ใครจะเชื่อผลของมัน
//
// แยกไฟล์จาก gate.mjs เพื่อคุมขนาด (< 400 บรรทัด) — เนื้อหาและเจตนาเหมือนเดิมทุกบรรทัด
// สมองปลอมที่ผลลัพธ์ถูก commit ไว้: ถ้าจับของพวกนี้ไม่ได้ แปลว่า normalizer เพี้ยน /
// regex ถูกแก้ / lint ถูกปิด = "เครื่องมือตรวจเสีย ห้ามเชื่อผลของด่านที่เหลือเลย" (R47)
import { findPriceViolations } from "../complianceGuard.mjs";
import { runBrainLints, BLOCK } from "./lint.mjs";
import { normalizeThai } from "./text.mjs";
import { checkTurn } from "./goldenAssert.mjs";

// สมองปลอมที่ผลลัพธ์ถูก commit ไว้: เครื่องมือตรวจต้องจับของพวกนี้ได้ทุกครั้ง
// ถ้าจับไม่ได้ (normalizer เพี้ยน / regex ถูกแก้ / lint ถูกปิด) แปลว่า "เครื่องมือตรวจเสีย"
// ห้ามเชื่อผลของด่านที่เหลือเลย — แบบแปลน G0 (R47)
const SELF_TEST_BUNDLE = Object.freeze({
  guardTables: { approvedAmounts: [19900] },
  budget: { usage: {}, knowledgeMaxChars: 0 },
});

function selfTestCards() {
  const fact = (id, title, content) => ({
    itemId: id, kind: "fact", key: id, scope: {}, inject: "pin", priority: 50,
    body: { kind: "fact", title, content, channel_id: null, source_created_at: 0, source_rowid: 0 },
    provenance: { source: "selftest" }, validUntil: null,
  });
  return [
    // 5 เคสอักขระซ่อน/รูปประกอบ ตามแบบแปลน G0
    fact("selftest:zwsp", "หัวข้อ", "ดี​ที่สุด"),
    fact("selftest:zwnj", "หัวข้อ", "ราคา‌ดี"),
    fact("selftest:bom", "หัวข้อ", "﻿เริ่มต้น"),
    fact("selftest:soft-hyphen", "หัวข้อ", "ค่า­เรียน"),
    fact("selftest:sara-ae", "หัวข้อ", "เเพง"),
    fact("selftest:money", "หัวข้อ", "ลดเหลือ 12,345 บาท"),
    fact("selftest:sentinel", "หัวข้อ", "ค่าเรียน undefined"),
    fact("selftest:pii", "หัวข้อ", "โทรหาพี่แอน 0812345678"),
  ];
}

const SELF_TEST_EXPECTED = Object.freeze([
  "L02:selftest:money",
  "L12:selftest:sentinel",
  "L15:selftest:pii",
  "L16:selftest:bom",
  "L16:selftest:sara-ae",
  "L16:selftest:soft-hyphen",
  "L16:selftest:zwnj",
  "L16:selftest:zwsp",
]);

/** ตรวจว่าเครื่องมือตรวจเองยังทำงานถูก — คืน {ok, problems[]} */
export function brainGateSelfTest() {
  const problems = [];
  const cards = selfTestCards();
  const found = runBrainLints({ cards, bundle: SELF_TEST_BUNDLE, todayIso: null, mode: "strict" })
    .filter((finding) => finding.severity === BLOCK)
    .map((finding) => `${finding.code}:${finding.cardId}`)
    .sort();
  for (const wanted of SELF_TEST_EXPECTED) {
    if (!found.includes(wanted)) problems.push(`lint ไม่จับ ${wanted}`);
  }
  // normalizer ต้องยังตัดของที่ L16 บอกว่าจะถูกตัดจริง ๆ (สองตัวนี้ต้องเห็นตรงกันเสมอ)
  if (normalizeThai("ดี​ที่สุด") !== "ดีที่สุด") problems.push("normalizeThai ไม่ตัดอักขระความกว้างศูนย์");
  if (normalizeThai("เเพง") !== "แพง") problems.push("normalizeThai ไม่รวม เ เ เป็น แ");
  // ด่านราคาที่ G4 ใช้ ต้องยังแยกออกว่าเลขไหนอยู่ในตารางและเลขไหนไม่อยู่
  if (findPriceViolations("ราคา 19,900 บาท", new Set([19900])).length !== 0) {
    problems.push("ด่านราคาบล็อกเลขที่อนุมัติแล้ว");
  }
  if (findPriceViolations("ราคา 9,999 บาท", new Set([19900])).length !== 1) {
    problems.push("ด่านราคาไม่จับเลขนอกตาราง");
  }
  // invariant ของชั้นเล่นซ้ำ (ย้ายมาจาก G8): อินพุตเดียวกันต้องให้ผลเดียวกันเสมอ
  // ถ้าวันไหนไม่จริง (วันที่เปลี่ยนกลางคัน ลำดับไม่คงที่ regex มี state) ผลของ G5 ทั้งชุด
  // เชื่อไม่ได้ — ต้องหยุดทั้งบันไดตรงนี้ ไม่ใช่รายงานเป็นสถิติทีหลัง
  const replayInput = {
    bubbles: [{ text: "ราคา 11,900 บาทค่ะ สนใจดูรอบเรียนไหมคะ" }], images: [], customer: {},
  };
  const replayExpect = [{ type: "must_have_price" }, { type: "ends_with_question" }];
  const replayTables = { approvedAmounts: new Set([11900]), bannedPhrases: ["ดีที่สุด"] };
  const first = JSON.stringify(checkTurn(replayInput, replayExpect, replayTables));
  const second = JSON.stringify(checkTurn(replayInput, replayExpect, replayTables));
  if (first !== second) problems.push("ชั้นเล่นซ้ำให้ผลไม่คงที่กับอินพุตเดียวกัน");
  if (first !== "[]") problems.push(`ชั้นเล่นซ้ำตัดสินเคสอ้างอิงผิด: ${first}`);
  return { ok: problems.length === 0, problems };
}
