import test from "node:test";
import assert from "node:assert/strict";
import { selectRelevantBrandPack } from "../src/brainPackSelector.mjs";

const PACK = [
  "LUKPRAE_BRAIN_PACK_JSON_V1",
  JSON.stringify({ entries: [
    {
      id: "course-agent", titleTh: "AI Agent for Business",
      answerTh: "คลาสกลุ่มสำหรับสร้าง AI ช่วยงานธุรกิจจากโจทย์จริงค่ะ",
      tags: ["รายละเอียดคอร์ส", "คลาส AI", "สอน AI", "รูปคลาส"],
      questionPatterns: ["ขอรายละเอียดคอร์ส แต่ละอัน", "สอนไรบ้าง", "ส่งรูปคลาสให้ดูหน่อย"],
      approvedImageKeys: ["ai-agent-card"],
    },
    {
      id: "course-workflow", titleTh: "AI Workflow Automation",
      answerTh: "คลาสกลุ่มระดับต่อยอดสำหรับออกแบบ workflow automation ค่ะ",
      tags: ["รายละเอียดคอร์ส", "คลาส AI", "สอน AI", "รูปคลาส"],
      questionPatterns: ["ขอรายละเอียดคอร์ส แต่ละอัน", "สอนไรบ้าง", "ส่งรูปคลาสให้ดูหน่อย"],
      approvedImageKeys: ["workflow-card"],
    },
    {
      id: "course-location", titleTh: "สถานที่เรียนคลาส AI",
      answerTh: "สถานที่เรียนให้ยึดตามรอบที่ทีมงานยืนยันค่ะ",
      tags: ["เรียนที่ไหน", "สถานที่เรียน"], questionPatterns: ["เรียนที่ไหน"],
    },
    {
      id: "rice", titleTh: "RICE Prompt Framework",
      answerTh: "RICE ใช้บรีฟ AI ค่ะ [ต่อ] อยากลองใช้กับงานไหนคะ",
      tags: ["RICE", "เขียน prompt"], questionPatterns: ["RICE คืออะไร"],
    },
    {
      id: "maturity", titleTh: "AI Maturity Ladder", answerTh: "บันไดวุฒิภาวะ AI ค่ะ",
      tags: ["Maturity", "ระดับ AI"], questionPatterns: ["Maturity คืออะไร"],
    },
  ] }),
  "END_LUKPRAE_BRAIN_PACK_JSON_V1",
  "Commercial prices are absent and require a human.",
].join("\n");

test("generic brand packs remain byte-compatible", () => {
  assert.equal(selectRelevantBrandPack("ordinary brand pack", "อะไรก็ได้"), "ordinary brand pack");
});

test("brand pack selector ตัดที่ cap โดยไม่ผ่า emoji เป็น Unicode ครึ่งตัว", () => {
  const pack = [
    "LUKPRAE_BRAIN_PACK_JSON_V1",
    JSON.stringify({ entries: [{
      id: "emoji-boundary",
      titleTh: "ทดสอบขอบเขต",
      answerTh: "ข้อมูลก่อน emoji 😊 และข้อความหลัง",
      tags: ["ทดสอบขอบเขต"],
      questionPatterns: ["ทดสอบขอบเขต"],
    }] }),
    "END_LUKPRAE_BRAIN_PACK_JSON_V1",
  ].join("\n");
  const full = selectRelevantBrandPack(pack, "ทดสอบขอบเขต", { maxChars: 10_000 });
  const throughEmoji = [...full].findIndex((char) => char === "😊") + 1;
  assert.ok(throughEmoji > 0, "fixture ต้องมี emoji ในผลที่เลือกแล้ว");

  const bounded = selectRelevantBrandPack(pack, "ทดสอบขอบเขต", { maxChars: throughEmoji });
  assert.equal(bounded.isWellFormed(), true);
  assert.equal(bounded.endsWith("😊"), true, "emoji ที่ชน cap ต้องอยู่ครบทั้งตัว");
});

test("Thai tokenization removes zero-width separators without breaking the word", () => {
  const selected = selectRelevantBrandPack(PACK, "ขอรายละเอียดคอร์\u200Bส แต่ละอัน");
  assert.match(selected, /AI Agent for Business[\s\S]*AI Workflow Automation/u);
  assert.doesNotMatch(selected, /RICE ใช้บรีฟ|บันไดวุฒิภาวะ/u);
});

test("LuKprae pack selects only relevant facts and strips script cadence markers", () => {
  const selected = selectRelevantBrandPack(PACK, "เขียน prompt แบบ RICE ยังไงครับ");
  assert.match(selected, /RICE/u);
  assert.match(selected, /ข้อมูลอ้างอิง/u);
  assert.doesNotMatch(selected, /\[ต่อ\]/u);
  assert.doesNotMatch(selected, /อยากลองใช้กับงานไหน/u, "canned follow-up after [ต่อ] must not enter the live prompt");
  assert.ok(selected.length < PACK.length / 2, `selected context should be bounded (${selected.length}/${PACK.length})`);
  assert.doesNotMatch(selected, /AI Maturity Ladder 7 ขั้น/u, "unrelated entries must not ride into every prompt");
});

for (const [query, expected] of [
  ["ขอรายละเอียดคอร์ส แต่ละอัน", /AI Agent for Business[\s\S]*AI Workflow Automation/u],
  ["สอนไรบ้าง", /AI Agent for Business[\s\S]*AI Workflow Automation/u],
  ["เรียนที่ไหน", /สถานที่เรียนคลาส AI/u],
]) {
  test(`Thai query retrieves the course fact without framework drift: ${query}`, () => {
    const selected = selectRelevantBrandPack(PACK, query);
    assert.match(selected, expected);
    assert.doesNotMatch(selected, /RICE ใช้บรีฟ|บันไดวุฒิภาวะ/u);
  });
}

test("generic Thai follow-up uses bounded recent context at lower weight", () => {
  const selected = selectRelevantBrandPack(PACK, "แล้วอันนี้ล่ะ", {
    recentContext: [{ role: "user", content: "สนใจ AI Workflow Automation ค่ะ" }],
  });
  assert.match(selected, /AI Workflow Automation/u);
  assert.doesNotMatch(selected, /RICE ใช้บรีฟ|AI Agent for Business/u);

  const currentWins = selectRelevantBrandPack(PACK, "RICE คืออะไร", {
    recentContext: [{ role: "user", content: "สนใจ AI Workflow Automation ค่ะ" }],
  });
  assert.match(currentWins, /RICE ใช้บรีฟ/u);
  assert.doesNotMatch(currentWins, /AI Workflow Automation/u);

  const ignoresAssistant = selectRelevantBrandPack(PACK, "แล้วอันนี้ล่ะ", {
    recentContext: [
      { role: "assistant", content: "AI Workflow Automation ค่ะ" },
      { role: "user", content: "สนใจ RICE ครับ" },
    ],
  });
  assert.match(ignoresAssistant, /RICE ใช้บรีฟ/u);
  assert.doesNotMatch(ignoresAssistant, /AI Workflow Automation/u);
});

test("course image hints require the caller allowlist and exclude held keys", () => {
  const withoutAllowlist = selectRelevantBrandPack(PACK, "ส่งรูปคลาสให้ดูหน่อย");
  assert.doesNotMatch(withoutAllowlist, /\[IMAGE:/u);

  // v1.3.4: ค่าเริ่มต้นยังไม่เสนอรูป — ไปป์ไลน์ต้องบอกว่าเทิร์นนี้ควรเสนอ (offerImages)
  const detailsOnly = selectRelevantBrandPack(PACK, "สอนไรบ้าง", {
    approvedImageKeys: new Set(["ai-agent-card"]),
  });
  assert.doesNotMatch(detailsOnly, /\[IMAGE:/u, "ค่าเริ่มต้นห้ามเสนอรูปเอง");

  // แต่เมื่อไปป์ไลน์บอกว่าเป็นจังหวะที่ภาพช่วยขาย โมเดลต้องเห็นตัวเลือกรูป
  const proactive = selectRelevantBrandPack(PACK, "สอนไรบ้าง", {
    approvedImageKeys: new Set(["ai-agent-card"]),
    offerImages: true,
  });
  assert.match(proactive, /\[IMAGE:ai-agent-card\]/u, "จังหวะที่ควรมีภาพต้องเห็น marker");
  assert.match(proactive, /ไม่ต้องรอให้ลูกค้าขอ/u);

  for (const query of ["รูปแบบคลาส AI Agent for Business เป็นยังไง", "ขอทราบรูปแบบคอร์ส AI Agent for Business"]) {
    const formatQuestion = selectRelevantBrandPack(PACK, query, {
      approvedImageKeys: new Set(["ai-agent-card"]),
    });
    assert.doesNotMatch(formatQuestion, /\[IMAGE:/u, "รูปแบบ is a format question, not an image request");
  }

  const selected = selectRelevantBrandPack(PACK, "ส่งรูปคลาสให้ดูหน่อย", {
    approvedImageKeys: new Set(["ai-agent-card"]),
  });
  assert.match(selected, /\[IMAGE:ai-agent-card\]/u);
  assert.match(selected, /จบข้อความด้วยคำถามเดียว/u);
  assert.doesNotMatch(selected, /\[IMAGE:workflow-card\]/u);
  assert.doesNotMatch(selected, /RICE ใช้บรีฟ|บันไดวุฒิภาวะ/u);

  const shortVariant = selectRelevantBrandPack(PACK, "รูปคลาส AI", {
    approvedImageKeys: new Set(["ai-agent-card"]),
  });
  assert.match(shortVariant, /AI Agent for Business/u);
  assert.doesNotMatch(shortVariant, /RICE ใช้บรีฟ|บันไดวุฒิภาวะ/u);
});

test("generic course follow-ups do not match unrelated Thai question particles", () => {
  for (const query of ["คนเรียนเยอะมั้ย", "มีรีวิวไหม"]) {
    const selected = selectRelevantBrandPack(PACK, query, {
      recentContext: [{ role: "user", content: "สนใจ AI Agent for Business ค่ะ" }],
    });
    assert.match(selected, /AI Agent for Business/u);
    assert.doesNotMatch(selected, /RICE ใช้บรีฟ|บันไดวุฒิภาวะ/u);
  }
});

test("no-match LuKprae query keeps only the safety boundary, not all canned answers", () => {
  const pack = [
    "LUKPRAE_BRAIN_PACK_JSON_V1",
    JSON.stringify({ entries: [{ id: "one", titleTh: "RICE", answerTh: "วิธีเขียน prompt ค่ะ [ต่อ] อยากลองไหมคะ", tags: ["prompt"] }] }),
    "END_LUKPRAE_BRAIN_PACK_JSON_V1",
    "Commercial prices are absent and require a human.",
  ].join("\n");
  const selected = selectRelevantBrandPack(pack, "ซ่อมหลังคารั่ว");
  assert.doesNotMatch(selected, /วิธีเขียน prompt/u);
  assert.match(selected, /Commercial prices are absent/u);
});

/* ---------- LuKprae training handoff 2026-08-12: F1 media intent + F2 fallback ---------- */

// fixture 4+5: ทุกสำนวนขอรูป -> การ์ดรูปอนุมัติใบเดียวกัน; รูป held ไม่หลุดทุกสำนวน
test("F1: ทุกสำนวนขอรูปคลาส ได้การ์ดรูปที่อนุมัติเหมือนกัน แม้คำล้วนเป็น stopword", () => {
  const approved = new Set(["ai-agent-card"]); // workflow-card ถูก held (ไม่อยู่ใน approved)
  for (const phrase of ["มีรูปคลาสมั้ย", "ขอดูรูปคลาส", "ส่งรูปคลาสให้ดูหน่อย", "ขอดูบรรยากาศหน่อยค่ะ"]) {
    const selected = selectRelevantBrandPack(PACK, phrase, { approvedImageKeys: approved });
    assert.match(selected, /\[IMAGE:ai-agent-card\]/u, `"${phrase}" ต้องได้รูปอนุมัติ`);
    assert.doesNotMatch(selected, /\[IMAGE:workflow-card\]/u, `"${phrase}" รูป held ต้องไม่หลุด`);
  }
});

test("F1: ไม่มีรูปอนุมัติเลย -> ไม่มี IMAGE marker (fail-closed เดิม)", () => {
  const selected = selectRelevantBrandPack(PACK, "มีรูปคลาสมั้ย", { approvedImageKeys: new Set() });
  assert.doesNotMatch(selected, /\[IMAGE:/u);
});

// fixture 2: "ครับ" ไม่มี token -> fallbackQuery (ข้อเสนอเดิมจาก resolver) ต้องดึงการ์ดคอร์สได้
test("F2: query คำรับสั้น + fallbackQuery จากข้อเสนอเดิม -> ได้การ์ดคอร์สที่ถูกต้อง", () => {
  const selected = selectRelevantBrandPack(PACK, "ครับ", {
    fallbackQuery: "อยากให้สรุปกิจกรรม Workshop ในคลาส AI Agent for Business ไหมคะ",
  });
  assert.match(selected, /AI Agent for Business/u, "การ์ดคอร์สต้องถูกเลือกผ่าน fallback");
  assert.doesNotMatch(selected, /RICE ใช้บรีฟ/u, "ห้ามลากเรื่องไม่เกี่ยวเข้ามา");
});

test("F2: query ปกติที่ match ได้เอง -> fallbackQuery ต้องไม่แทรกแซง", () => {
  const selected = selectRelevantBrandPack(PACK, "เขียน prompt แบบ RICE ยังไงครับ", {
    fallbackQuery: "อยากให้สรุปกิจกรรม Workshop ไหมคะ",
  });
  assert.match(selected, /RICE/u);
  assert.doesNotMatch(selected, /AI Agent for Business —|คลาสกลุ่มสำหรับสร้าง AI/u, "fallback ใช้เฉพาะตอนหลัก match ไม่ได้");
});
