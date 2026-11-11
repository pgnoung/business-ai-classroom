// review-diff-focus.test.mjs — กล่องตรวจต้องแสดง "ตรงที่ต่าง" ไม่ใช่ 240 ตัวแรก
//
// ที่มา (3 ก.ย. 2026): พี่ง้วงเปิดกล่องตรวจแล้วถามว่า "อันนี้มั่วหรือเปล่า" เพราะร่างของ
// ลูกแพรกับคำตอบที่ทีมพิมพ์ขึ้นจอเป็นข้อความเดียวกันเป๊ะทั้งสองก้อน
// วัดจากตารางจริง: คำแก้ที่ค้างอยู่ 151 ใบซึ่งมีคำตอบของคน มี 78 ใบ (52%) ที่ตัวอักษร
// ตัวแรกซึ่งต่างกันอยู่หลังตำแหน่งที่ 240 กลางค่าอยู่ที่ 274 ความยาวเฉลี่ยราว 500 ตัว
// แปลว่าการตัดหัว 240 ตัวคืนของที่ "เหมือนกัน" ให้คนตรวจดูบนแถวเกินครึ่ง — ข้อมูลถูก
// แต่วิธีแสดงพัง
//
// สิ่งที่ไฟล์นี้ล็อกไว้:
//   1. ช่วงที่ต่างต้องอยู่ในสตริงที่คืนออกไป ไม่ว่ามันจะอยู่ตำแหน่งไหนของข้อความ
//   2. ตำแหน่งใน mark ต้อง slice ได้ตรงตัว รวมตอนที่มี "…" เติมข้างหน้า
//   3. ของเดิม (เหมือนกัน / ว่าง / แถวที่ไม่มีคำตอบของคน) ต้องไม่เปลี่ยนพฤติกรรม
import test from "node:test";
import assert from "node:assert/strict";
import { collectReviewRows, focusedPair, snippet } from "../src/brain/reviewSources.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";

const NOW = 1_788_000_000_000;
const CUSTOMER = "U00000000000000000000000000000a02";

/* ---------------------------------- focusedPair ---------------------------------- */

test("จุดที่ต่างอยู่ตัวแรก: ยกทั้งก้อนมาแสดงเหมือนเดิม และทำเครื่องหมายตั้งแต่ตัวที่ 0", () => {
  const pair = focusedPair("ราคา 9,500 บาทค่ะ", "ค่าเรียน 9,500 บาทค่ะ");
  assert.equal(pair.before, "ราคา 9,500 บาทค่ะ");
  assert.equal(pair.after, "ค่าเรียน 9,500 บาทค่ะ");
  assert.equal(pair.beforeMark[0], 0, "ต่างตั้งแต่ตัวแรก = เครื่องหมายต้องเริ่มที่ 0");
  assert.equal(pair.before.slice(...pair.beforeMark), "ราคา");
  assert.equal(pair.after.slice(...pair.afterMark), "ค่าเรียน");
});

test("จุดที่ต่างอยู่กลางประโยค: ทำเครื่องหมายเฉพาะช่วงที่ต่าง ไม่ลามไปทั้งประโยค", () => {
  const pair = focusedPair("จอดฟรี 2 ชั่วโมงค่ะ", "จอดฟรี 4 ชั่วโมงค่ะ");
  assert.equal(pair.before.slice(...pair.beforeMark), "2");
  assert.equal(pair.after.slice(...pair.afterMark), "4");
});

test("จุดที่ต่างอยู่หลังตัวที่ 240 (เคสจริงของ 52% ของแถว): ต้องยังเห็นตัวที่ต่าง", () => {
  const head = "สวัสดีค่ะ ".repeat(40); // ยาวเกิน 240 ตัวก่อนถึงจุดที่ต่าง
  assert.ok(head.length > 240, "หัวที่เหมือนกันต้องยาวเกินงบเดิม ไม่งั้นเทสต์นี้ไม่ได้ทดสอบอะไร");
  const draft = `${head}คลาสนี้ 19,900 บาทค่ะ`;
  const final = `${head}คลาสนี้ 25,000 บาทค่ะ`;

  // ของเดิม: ตัดหัว 240 ตัวแล้วสองก้อนเหมือนกันเป๊ะ — นี่คือหน้าจอที่คนตรวจไม่เชื่อ
  assert.equal(snippet(draft), snippet(final), "ของเดิมต้องยังเหมือนกัน (นี่คือบั๊กที่กำลังแก้)");

  const pair = focusedPair(draft, final);
  assert.notEqual(pair.before, pair.after, "หน้าต่างใหม่ต้องไม่คืนของที่เหมือนกันสองก้อน");
  assert.match(pair.before, /19,900/u, "ต้องเห็นตัวเลขที่ลูกแพรจะพูด");
  assert.match(pair.after, /25,000/u, "ต้องเห็นตัวเลขที่ทีมงานพิมพ์");
  // เทียบทีละตัวอักษร ท้ายที่เหมือนกัน ("00 บาทค่ะ") จึงถูกนับเป็นบริบท ไม่ใช่ของที่แก้ —
  // ตั้งใจให้เป็นแบบนี้ ไฮไลต์จะได้ชี้ตรงตัวที่เปลี่ยนจริง ไม่ใช่ลามไปทั้งก้อน
  assert.equal(pair.before.slice(...pair.beforeMark), "19,9");
  assert.equal(pair.after.slice(...pair.afterMark), "25,0");

  // คำที่ไม่มีหัวท้ายซ้ำกัน จะถูกไฮไลต์ทั้งคำตามที่คนอ่านคาด
  const words = focusedPair(`${head}จอดฟรีสองชั่วโมงค่ะ`, `${head}จอดฟรีสี่ชั่วโมงค่ะ`);
  assert.equal(words.before.slice(...words.beforeMark), "สอง");
  assert.equal(words.after.slice(...words.afterMark), "สี่");
});

test("หน้าต่างที่ไม่ได้เริ่มที่ตัวแรก ต้องมี … นำหน้า และ mark ต้องบวกออฟเซ็ตของ … แล้ว", () => {
  const head = "ก".repeat(400);
  const pair = focusedPair(`${head}แดง`, `${head}เขียว`);
  assert.ok(pair.before.startsWith("…"), "หน้าต่างที่ตัดหัวมาแล้วต้องบอกว่ายังมีข้างหน้า");
  assert.ok(pair.after.startsWith("…"));
  // ข้อพิสูจน์ของออฟเซ็ต: slice ตรง ๆ ต้องได้คำที่ต่าง ไม่ใช่เลื่อนไปหนึ่งตัวเพราะ "…"
  assert.equal(pair.before.slice(...pair.beforeMark), "แดง");
  assert.equal(pair.after.slice(...pair.afterMark), "เขียว");
  assert.ok(pair.beforeMark[0] > 0);
});

test("ช่วงที่ต่างยาวกว่างบทั้งก้อน: เก็บหัวของช่วงไว้ให้เห็น แล้วตัดหางด้วย …", () => {
  const pair = focusedPair(`เกริ่นเหมือนกัน ${"ก".repeat(400)}`, `เกริ่นเหมือนกัน ${"ข".repeat(400)}`);
  assert.ok(pair.before.endsWith("…"), "ของที่ตัดหางต้องบอกว่ายังมีต่อ");
  assert.ok(pair.before.slice(...pair.beforeMark).startsWith("ก"), "หัวของช่วงที่ต่างต้องยังอยู่");
  assert.ok(!pair.before.slice(...pair.beforeMark).includes("ข"), "ห้ามเอาของอีกก้อนมาปน");
  assert.ok(pair.before.length <= 242, `ก้อนที่คืนต้องไม่เกินงบ + "…" หัวท้าย (ได้ ${pair.before.length})`);
  assert.ok(pair.after.slice(...pair.afterMark).startsWith("ข"));
});

test("ข้อความเหมือนกันทุกตัว: ตัดหัวแบบเดิม ไม่มีอะไรให้ทำเครื่องหมาย", () => {
  const same = "จอดฟรี 2 ชั่วโมงค่ะ";
  assert.deepEqual(focusedPair(same, same), {
    before: same, after: same, beforeMark: null, afterMark: null,
  });
  const long = "ก".repeat(400);
  const pair = focusedPair(long, long);
  assert.equal(pair.before, snippet(long), "ต้องเป็นการตัดหัวชุดเดิมเป๊ะ");
  assert.equal(pair.beforeMark, null);
});

test("ฝั่งใดฝั่งหนึ่งว่าง: ตัดหัวแบบเดิม และไม่โยน error", () => {
  const draft = "ก".repeat(400);
  const noHuman = focusedPair(draft, "");
  assert.equal(noHuman.before, snippet(draft));
  assert.equal(noHuman.after, "");
  assert.equal(noHuman.beforeMark, null);
  assert.equal(noHuman.afterMark, null);

  const noDraft = focusedPair("", "ทีมงานพิมพ์ตอบเองค่ะ");
  assert.equal(noDraft.before, "");
  assert.equal(noDraft.after, "ทีมงานพิมพ์ตอบเองค่ะ");
  assert.equal(noDraft.afterMark, null);
});

test("ค่าที่ไม่ใช่สตริง (null/undefined/ตัวเลข) ต้องไม่ทำให้กล่องตรวจล่มทั้งหน้า", () => {
  for (const [a, b] of [[null, undefined], [undefined, null], [0, 0], [{}, []], [12345, "12345"]]) {
    const pair = focusedPair(a, b);
    assert.equal(typeof pair.before, "string");
    assert.equal(typeof pair.after, "string");
  }
});

test("ข้อความซ้ำ ๆ: ท้ายที่เหมือนกันต้องไม่เดินย้อนทับหัว จนช่วงที่ต่างติดลบ", () => {
  for (const [a, b] of [["ค่ะ ค่ะ ค่ะ ค่ะ", "ค่ะ ค่ะ"], ["aa", "aaaa"], ["aaaa", "aa"]]) {
    const pair = focusedPair(a, b);
    for (const mark of [pair.beforeMark, pair.afterMark]) {
      if (mark === null) continue;
      assert.ok(mark[1] > mark[0], `ช่วงที่ต่างต้องเป็นบวกเสมอ (${JSON.stringify(mark)})`);
      assert.ok(mark[1] <= (mark === pair.beforeMark ? pair.before : pair.after).length,
        "และต้องไม่เลยปลายสตริงที่คืนออกไป");
    }
  }
  // "aa" กับ "aaaa" คือการเติมของ ไม่ใช่การแก้ของเดิม — ฝั่งที่ไม่มีอะไรเปลี่ยนจึงไม่มีเครื่องหมาย
  assert.equal(focusedPair("aa", "aaaa").beforeMark, null);
  assert.deepEqual(focusedPair("aa", "aaaa").afterMark, [2, 4]);
});

test("ภาษาไทยที่มีสระ/วรรณยุกต์ลอย: ไม่ล่ม และไฮไลต์ต้องพาพยัญชนะที่สระเกาะมาด้วย", () => {
  const pair = focusedPair("ราคากันนะคะ", "ราคากินนะคะ");
  // ต่างกันแค่สระ ั กับ ิ — ถ้าตัดตรงนั้น จะได้สระเปล่าที่ไม่มีตัวเกาะ
  assert.equal(pair.before.slice(...pair.beforeMark), "กั");
  assert.equal(pair.after.slice(...pair.afterMark), "กิ");

  const long = "ก".repeat(300);
  const deep = focusedPair(`${long}ค่าเรียนถูกลงค่ะ`, `${long}ค่าเรียนขึ้นแล้วค่ะ`);
  assert.ok(deep.before.slice(...deep.beforeMark).length > 0);
  assert.match(deep.after, /ขึ้นแล้ว/u, "ต้องยังอ่านออกว่าคนแก้เป็นอะไร");

  // อีโมจิหนึ่งตัวคือสองหน่วยรหัส — ห้ามตัดครึ่งจนได้ตัวอักษรพัง
  const emoji = focusedPair("ยินดีค่ะ 🙂 นะคะ", "ยินดีค่ะ 🙃 นะคะ");
  assert.equal(emoji.before.slice(...emoji.beforeMark), "🙂");
  assert.equal(emoji.after.slice(...emoji.afterMark), "🙃");
});

/* ------------------------------- แถวที่ส่งขึ้นหน้าเว็บ ------------------------------- */

function stubDb(corrections, { prices = [] } = {}) {
  return {
    listCorrectionWorkQueue: () => ({ corrections, hiddenNoopCount: 0 }),
    approvedPrices: () => prices,
    listLearningCandidates: () => [],
    listBrainRedactions: () => [],
    listPublishRequests: () => [],
    getBrainPointer: () => null,
  };
}

test("แถวคำแก้ที่ส่งขึ้นหน้าเว็บ ต้องพกตำแหน่งที่ต่างไปด้วย ไม่ใช่แค่ข้อความที่ถูกตัดหัว", () => {
  const head = "สวัสดีค่ะ ".repeat(40);
  const db = stubDb([{
    id: 7, ai_draft: `${head}จอดฟรีสองชั่วโมงค่ะ`, human_final: `${head}จอดฟรีสี่ชั่วโมงค่ะ`,
    created_at: NOW, customer_id: CUSTOMER, taught_version_id: null,
  }]);
  const [row] = collectReviewRows(db).rows;
  assert.equal(row.source, "correction");
  assert.notEqual(row.before, row.detail, "สองก้อนบนแถวเดียวกันต้องไม่เหมือนกันเป๊ะ");
  assert.equal(row.before.slice(...row.beforeMark), "สอง");
  assert.equal(row.detail.slice(...row.afterMark), "สี่");
});

test("แถวร่างที่ตัวกรองกันไว้ (ไม่มีคำตอบของคน) ต้องเหมือนเดิมทุกอย่าง", () => {
  const db = stubDb([{
    id: 9, ai_draft: "คลาสนี้ลดเหลือ 9,500 บาทค่ะ", human_final: "",
    created_at: NOW, customer_id: CUSTOMER, taught_version_id: null,
  }]);
  const [row] = collectReviewRows(db).rows;
  assert.equal(row.source, "guard_block");
  assert.equal(row.detail, snippet("คลาสนี้ลดเหลือ 9,500 บาทค่ะ"), "ยังเป็นการตัดหัวชุดเดิม");
  assert.equal(row.before, "", "แถวแบบนี้ไม่มีร่างเทียบ");
  assert.equal(row.beforeMark, undefined, "และต้องไม่มีฟิลด์ใหม่งอกมาเปลี่ยนรูปของแถว");
  assert.equal(row.afterMark, undefined);
});

test("ร่างระบบที่ไม่ใช่ราคาแต่ provenance ได้รับรอง เปิดให้บันทึกคำแก้โดยไม่เผย detail", () => {
  const db = stubDb([{
    id: 10, ai_draft: "ร่างที่ติดคำต้องห้าม", human_final: "",
    source_reason: "system:compliance_block:banned_word", created_at: NOW,
    customer_id: CUSTOMER, taught_version_id: null,
  }]);
  const [row] = collectReviewRows(db).rows;
  assert.equal(row.source, "guard_block");
  assert.equal(row.risk, "yellow");
  assert.equal(row.title, "ร่างของลูกแพรที่ระบบกันไว้ — รอทีมพิมพ์คำตอบที่ถูกต้อง");
  assert.equal(row.detail, snippet("ร่างที่ติดคำต้องห้าม"));
  assert.equal(row.amounts, undefined, "non-price row must not invent numeric evidence");
  assert.equal(row.actions.teach, true, "Teach opens only to save a human correction; server still blocks auto-teach");
});

test("ร่างที่ไม่มี provenance หรือ provenance นอกทะเบียน ยังไม่ถูกยกเข้ากล่องตรวจ", () => {
  const db = stubDb([{
    id: 11, ai_draft: "ร่างที่ไม่ทราบที่มา", human_final: "",
    source_reason: "system:compliance_block:free_text_leak", created_at: NOW,
    customer_id: CUSTOMER, taught_version_id: null,
  }]);
  assert.equal(collectReviewRows(db).rows.length, 0);
});

/* --------------------------------- หน้าเว็บจริง --------------------------------- */

function reviewPayload(rows) {
  return { ok: true, rows, counts: {}, total: rows.length, hasMore: false, cursor: 0, canPublish: { knowledge: true }, queueInstead: false };
}

function makeDeps(doc, review) {
  return {
    api: async () => review,
    toast: () => {},
    mount: (...nodes) => doc.body.replaceChildren(...nodes.flat(Infinity).filter(Boolean)),
    pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
    tabBar: () => doc.createElement("nav"),
    stopPolling: () => {},
    setView: () => {},
  };
}

// textContent ของ DOM จำลองไม่ไหลลงลูก — เก็บ text node เองเพื่ออ่าน "ข้อความที่คนเห็นจริง"
const innerText = (node) => (node?.nodeType === 3
  ? String(node.textContent)
  : (node?.children || []).map(innerText).join(""));

test("กล่องตรวจ: ช่วงที่ต่างถูกไฮไลต์จริงบนหน้าเว็บ และคำนำหน้าไม่ทำให้ตำแหน่งเลื่อน", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const review = reviewPayload([{
    id: "correction:c1", source: "correction", refId: "c1", kind: "fact", risk: "green",
    title: "ทีมงานแก้คำตอบของลูกแพร แต่ยังไม่ได้สอนให้จำ",
    before: "…ราคา 19,900 ค่ะ", beforeMark: [6, 12],
    detail: "…ราคา 25,000 ค่ะ", afterMark: [6, 12],
    at: NOW, customerId: CUSTOMER, ownerOnly: false,
    actions: { teach: true, dismiss: true, openChat: true }, blockedWhy: "",
  }]);
  await createReviewPage(makeDeps(doc, review))();

  const diffs = doc.querySelectorAll(".ri-diff").map(innerText);
  assert.deepEqual(diffs, ["19,900", "25,000"], "ต้องไฮไลต์ตัวเลขทั้งสองฝั่ง ไม่ใช่เลื่อนไปโดนคำอื่น");
  // คำนำหน้าเป็นคนละ node กัน ข้อความทั้งบรรทัดจึงต้องยังครบเหมือนเดิม
  assert.equal(innerText(doc.querySelector(".ri-before")), "ลูกแพรตอบไว้: …ราคา 19,900 ค่ะ");
  assert.equal(innerText(doc.querySelector(".ri-after")), "…ราคา 25,000 ค่ะ");
});

test("กล่องตรวจ: แถวที่ไม่มีตำแหน่งที่ต่าง (หรือส่งมาพัง) ต้องวาดเหมือนเดิม ไม่ใช่หน้าเปล่า", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/review" });
  const { createReviewPage } = await import("../public/console/review.mjs");
  const broken = [
    { mark: null, why: "ไม่มีเครื่องหมาย" },
    { mark: [5, 5], why: "ช่วงว่าง" },
    { mark: [3, 999], why: "เลยปลายสตริง" },
    { mark: "6,12", why: "ไม่ใช่อาเรย์" },
  ];
  const review = reviewPayload(broken.map((one, index) => ({
    id: `correction:c${index}`, source: "correction", refId: `c${index}`, kind: "fact", risk: "green",
    title: `กรณี ${one.why}`,
    before: "ราคา 19,900 ค่ะ", beforeMark: one.mark,
    detail: "ราคา 25,000 ค่ะ", afterMark: one.mark,
    at: NOW, customerId: CUSTOMER, ownerOnly: false,
    actions: { teach: true, dismiss: true, openChat: true }, blockedWhy: "",
  })));
  await createReviewPage(makeDeps(doc, review))();

  assert.equal(doc.querySelectorAll(".ri-card").length, broken.length);
  assert.equal(doc.querySelectorAll(".ri-diff").length, 0, "ค่าที่ใช้ไม่ได้ = ไม่ไฮไลต์ ดีกว่าไฮไลต์ผิดที่");
  for (const line of doc.querySelectorAll(".ri-after")) {
    assert.equal(innerText(line), "ราคา 25,000 ค่ะ", "ข้อความต้องยังครบทุกตัว");
  }
});
