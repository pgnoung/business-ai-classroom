// eval-failures-ui.test.mjs — เรนเดอร์แผง "บทสนทนาที่จะพัง" จริงด้วย DOM จำลอง
//
// เหตุผลเดียวกับ brain-versions-ui: `node --check` ตรวจแค่ไวยากรณ์ คนแรกที่เจอ
// ReferenceError ไม่ควรเป็นพี่ง้วงตอนเปิดหน้าตั้งค่า
//
// สิ่งที่ต้องกัน:
//   - หน้าจอต้องบอกเป็น "ห้องไหน พังยังไง" ภาษาไทย ไม่ใช่รหัสเคสกับชื่อกฎ
//   - ปุ่มปิดเกณฑ์ต้องไม่โผล่ให้ทีมงาน
//   - "ด่านปิดอยู่" กับ "ตรวจแล้วผ่าน" ต้องเขียนคนละอย่าง
import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";

const DETAIL = {
  caseId: "probe-price-01",
  title: "คุณเอ๋ เจ้าของโรงงาน",
  severity: "lead",
  origin: "eval_case",
  retired: null,
  blocksEvenWhenRetired: false,
  turns: [{
    turnId: "probe-price-01#1", turnNo: 1, fromRealRoom: false,
    customerSaid: "ราคาเท่าไหร่คะ",
    lukpraeAnswered: "คลาสราคา 11,900 บาทค่ะ",
    expectations: ["ต้องบอกราคาที่อยู่ในตารางอนุมัติ"],
  }],
};

const DATA = {
  enabled: true,
  canRetire: true,
  cases: [{
    caseId: "probe-price-01", severity: "lead", title: "คุณเอ๋ เจ้าของโรงงาน",
    broke: ["พูดตัวเลขที่ไม่อยู่ในตารางราคาของรุ่นนี้ — เลข 11,900 ไม่อยู่ในตารางราคาอนุมัติ"],
  }],
};

function render(node) {
  if (!node) return "";
  if (node.nodeType === 3) return node.textContent;
  return (node.children || []).map(render).join(" ");
}

test("แผงบอกเป็นห้องไหนและพังยังไง ไม่ใช่รหัสเคส", async (t) => {
  installBrowserGlobals(t);
  const { failingCasesBlock } = await import("../public/console/evalFailures.mjs");
  const node = failingCasesBlock(DATA, {
    api: async () => ({}), toast: () => {}, refresh: () => {},
    details: new Map([["probe-price-01", DETAIL]]),
  });
  const text = render(node);
  assert.match(text, /คุณเอ๋ เจ้าของโรงงาน/u, "ต้องเห็นว่าเป็นห้องไหน");
  assert.match(text, /พูดตัวเลขที่ไม่อยู่ในตารางราคา/u, "ต้องเห็นว่าพังยังไง เป็นประโยคไทย");
  assert.match(text, /ราคาเท่าไหร่คะ/u, "ต้องเห็นว่าลูกค้าถามอะไร");
  assert.match(text, /11,900/u, "ต้องเห็นว่าลูกแพรตอบไว้ว่าอะไร");
  assert.doesNotMatch(text, /price_not_approved/u, "ห้ามโผล่ชื่อกฎดิบให้คนอ่าน");
});

test("ทีมงานไม่เห็นปุ่มปิดเกณฑ์ (ปุ่มที่กดแล้วเด้ง 403 = ปุ่มที่สอนคนให้ไม่เชื่อหน้าจอ)", async (t) => {
  installBrowserGlobals(t);
  const { failingCasesBlock } = await import("../public/console/evalFailures.mjs");
  const staff = failingCasesBlock({ ...DATA, canRetire: false }, {
    api: async () => ({}), toast: () => {}, refresh: () => {},
    details: new Map([["probe-price-01", DETAIL]]),
  });
  assert.doesNotMatch(render(staff), /ล้าสมัย/u);
  const owner = failingCasesBlock(DATA, {
    api: async () => ({}), toast: () => {}, refresh: () => {},
    details: new Map([["probe-price-01", DETAIL]]),
  });
  assert.match(render(owner), /เกณฑ์นี้ล้าสมัย/u);
});

test("เคสที่ปิดแล้วแต่ยังบล็อก ต้องเขียนไว้ตรง ๆ", async (t) => {
  installBrowserGlobals(t);
  const { failingCaseCard } = await import("../public/console/evalFailures.mjs");
  const card = failingCaseCard({
    ...DETAIL, severity: "irreversible", blocksEvenWhenRetired: true,
    retired: { by: "pngoung", reason: "เกณฑ์เก่าเขียนผิดตั้งแต่แรก", at: 1 },
  }, { broke: ["ไม่ได้ปิด AI ส่งต่อคน"], canRetire: true, api: async () => ({}), toast: () => {}, refresh: () => {} });
  const text = render(card);
  assert.match(text, /ยังบล็อกอยู่/u);
  assert.match(text, /พังแล้วกู้ไม่ได้/u);
  assert.match(text, /เปิดเคสนี้กลับ/u, "ปิดแล้วต้องเปิดกลับได้");
});

test("'ด่านปิดอยู่' กับ 'ตรวจแล้วผ่าน' ต้องเขียนคนละอย่าง", async (t) => {
  installBrowserGlobals(t);
  const { failingCasesBlock } = await import("../public/console/evalFailures.mjs");
  assert.equal(failingCasesBlock({ enabled: false, cases: [] }, {}), null, "ด่านปิด = ไม่ต้องวาดอะไรเลย");
  const nothingChecked = render(failingCasesBlock({ enabled: true, cases: [] }, {}));
  assert.match(nothingChecked, /ยังไม่ได้ตรวจอะไรเลย/u, "ตรวจ 0 เทิร์น ห้ามเขียนว่าผ่าน");
  assert.doesNotMatch(nothingChecked, /ผ่านหมด/u);
  const reallyChecked = render(failingCasesBlock({
    enabled: true, cases: [], summary: { checkedTurns: 12, selectedTurns: 20 },
  }, {}));
  assert.match(reallyChecked, /ผ่านหมด/u);
  assert.match(reallyChecked, /ตรวจได้ 12 จาก 20 เทิร์น/u, "ต้องบอกความครอบคลุมเป็นตัวเลขเสมอ");
  const cantCheck = render(failingCasesBlock({
    enabled: true, cases: [], reason: "ยังไม่มีคำตอบที่บันทึกไว้ให้เล่นซ้ำ",
  }, {}));
  assert.match(cantCheck, /ยังไม่มีคำตอบที่บันทึกไว้/u);
  assert.doesNotMatch(cantCheck, /ผ่านหมด/u, "ตรวจไม่ได้ ห้ามเขียนว่าผ่าน");
});
