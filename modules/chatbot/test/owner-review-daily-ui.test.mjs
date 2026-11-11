// owner-review-daily-ui — แท็บ "ตรวจแชทวันนี้" (#/owner-review/daily · เฟส B) เรนเดอร์จริงด้วย DOM จำลอง (12 ต.ค. 2026)
//   · ไฟล์ใหม่อยู่ใน allowlist ของ /console/static + index.html โหลด css · ไม่มี innerHTML · ไฟล์ไม่เกิน 800 บรรทัด
//   · การ์ดหนึ่งใบ = หนึ่งห้อง: ฟองลูกค้า/ลูกแพร/ทีมงาน · ชิปปัญหาปักใต้ฟอง (แตะชิป = ฟองกะพริบ) · ป้ายน่าห่วง/ปกติ · สรุปหนึ่งบรรทัด
//   · ดีแล้ว (ปุ่ม/ปัดขวา) → ห้องถัดไปทันที + ย้อน 10 วิ · ต้องปรับ → แตะฟอง → แผ่นชิป + ควรตอบว่า… → บทเรียน
//   · เจ้าของ: บทเรียนใช้ทันที + ปักระดับได้ · ชมพู่: บทเรียนรออนุมัติ ไม่มีปุ่มปักระดับ · ระบบสอนปิด = ป้ายอย่างเดียว
//   · ดีที่เหลือทั้งหมด (หลังห้องน่าห่วงครบ) + ย้อน · หน้าตรวจครบ + ขอบคุณ + ค้างตรวจ · กำลังเตรียม/ไม่พบวันนั้น
// ทุกข้อความเป็นประโยคสังเคราะห์ · api ปลอมคืนรูปข้อมูลเดียวกับ consoleOwnerReviewDailyApi.mjs · ไม่มีการเรียก provider
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONSOLE_STATIC_FILE_NAMES } from "../src/consoleStatic.mjs";
import {
  CHIPS, HOUR, LEVEL_LABELS, NOW, TAPER, all, apiError, baseItems, bubblesOf, button, byClass, click, flush, hasClass, issue, qItem,
  renderDaily, sleep, textOf,
} from "./ownerReviewDailyUiFixture.mjs";

const CONSOLE_DIR = new URL("../public/console/", import.meta.url);
const read = (name) => readFileSync(new URL(name, CONSOLE_DIR), "utf8");
const NEW_MODULES = [
  "ownerReviewDaily.mjs", "ownerReviewDailyCard.mjs", "ownerReviewDailySheet.mjs", "ownerReviewDailyState.mjs", "ownerReviewDailyScroll.mjs",
];

/* ------------------------------ ไฟล์ / allowlist / CSS ------------------------------ */

test("ไฟล์ใหม่ของแท็บรายวันอยู่ใน allowlist ของ /console/static และ index.html โหลด ownerReviewDaily.css", () => {
  const allow = new Set(CONSOLE_STATIC_FILE_NAMES);
  for (const name of [...NEW_MODULES, "ownerReviewDaily.css"]) assert.ok(allow.has(name), `${name} ต้องอยู่ใน STATIC_FILES`);
  assert.match(read("index.html"), /<link rel="stylesheet" href="\/console\/static\/ownerReviewDaily\.css">/u);
  assert.match(read("ownerReview.mjs"), /from "\.\/ownerReviewDaily\.mjs"/u, "หน้าห้องตรวจ import แท็บรายวัน");
  assert.doesNotMatch(read("ownerReviewCard.mjs"), /dailyPlaceholder|เริ่มคืนพรุ่งนี้/u, "หน้าบอกเวลาเริ่มถูกแทนแล้ว");
});

test("ไม่มี innerHTML/insertAdjacentHTML/outerHTML/style inline ในไฟล์ใหม่ — ทุกโหนดผ่าน el() · ไฟล์ไม่เกิน 800 บรรทัด", () => {
  for (const name of [...NEW_MODULES, "ownerReviewDaily.css"]) {
    const source = read(name);
    assert.doesNotMatch(source, /\.innerHTML|insertAdjacentHTML|\.outerHTML|document\.write/u, name);
    assert.ok(source.split("\n").length <= 800, `${name} ยาวเกิน 800 บรรทัด`);
  }
  for (const name of NEW_MODULES) {
    // CSP ของคอนโซล (style-src 'self') ห้าม style="" — ค่าที่เปลี่ยนต้องตั้งผ่าน style.setProperty
    assert.doesNotMatch(read(name), /\bstyle:\s*[`"']/u, name);
    assert.doesNotMatch(read(name), /localStorage|sessionStorage/u, `${name} ไม่เก็บข้อมูลแชทในเครื่อง`);
  }
});

test("CSS: โมชันเฉพาะ transform/opacity (+สี) · ปุ่มนิ้วโป้งใช้ความสูง 56px ของเฟส A · ช่องพิมพ์ 16px · ลดโมชันมีไฮไลต์นิ่ง · ไม่มีสี hex/position fixed", () => {
  const css = read("ownerReviewDaily.css");
  for (const match of css.matchAll(/transition:\s*([^;]+);/gu)) {
    for (const part of match[1].split(/,(?![^(]*\))/u)) {
      const prop = part.trim().split(/\s+/u)[0];
      assert.ok(["transform", "opacity", "background-color", "color", "border-color", "box-shadow", "none"].includes(prop), `transition ${prop}`);
    }
  }
  for (const match of css.matchAll(/@keyframes [\w-]+ \{([^@]*?)\}\s*\n/gu)) assert.doesNotMatch(match[1], /width|height|top|left|margin|padding/u);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu, "สีมาจาก token ของธีมเท่านั้น (สว่าง/มืด)");
  assert.doesNotMatch(css, /position:\s*fixed/u);
  assert.match(css, /\.odr-fix-text \{[^}]*font-size: 16px/u, "iPhone ไม่ซูมตอนแตะช่องพิมพ์");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.odr-msg\.is-flash \.odr-bubble \{ outline/u);
  assert.match(read("ownerReview.css"), /--orv-act-h: 56px/u);
  assert.match(css, /\.odr-bulk \{[^}]*min-height: 56px/u);
});

/* ---------------------------------- ส่วน pure ---------------------------------- */

test("สถานะ pure: batch จาก hash · ตัวเลขคิว · รวมผลเซิร์ฟเวอร์ (revision เก่าไม่ทับ · คนอื่นติดป้ายห้องที่ดูอยู่ = current) · โน้ตต้องปรับไม่เกินเพดาน", async () => {
  const state = await import("../public/console/ownerReviewDailyState.mjs");
  const { fixNote } = await import("../public/console/ownerReviewDailySheet.mjs");
  assert.equal(state.dailyBatchFromHash("#/owner-review/daily?batch=abc-1"), "abc-1");
  assert.equal(state.dailyBatchFromHash("#/owner-review/daily"), "");
  assert.equal(state.dailyBatchFromHash("#/owner-review/daily?batch=<x>"), "");
  assert.equal(state.dailyQueuePath("b 1"), "/console/api/owner-review/daily?batch=b%201");
  const counts = state.dailyCounts([qItem("a", { label: "good" }), qItem("b", { label: "needs_fix" }), qItem("c", { flagged: true, bulkEligible: false }), qItem("d")]);
  assert.deepEqual(counts, { total: 4, labelled: 2, remaining: 2, good: 1, needsFix: 1, flaggedRemaining: 1, bulkEligible: 1 });
  const view = state.newDailyView({ items: [qItem("a"), qItem("b"), qItem("c", { label: "good" })] });
  assert.deepEqual(view.deck, ["a", "b"]);
  assert.equal(state.mergeDailyItem(view, { ...qItem("b"), revision: -1, label: "good" }), "", "revision เก่ากว่า = ไม่ทับ");
  assert.equal(state.mergeDailyItem(view, { ...qItem("b"), revision: 1, label: "good" }), "dropped");
  assert.deepEqual(view.deck, ["a"]);
  assert.equal(state.mergeDailyItem(view, { ...qItem("a"), revision: 1, label: "good" }), "current", "ห้องที่ดูอยู่ไม่หายใต้นิ้ว");
  assert.deepEqual(view.deck, ["a"]);
  state.returnToDeck(view, "z", { behind: true });
  assert.deepEqual(view.deck, ["a", "z"]);
  assert.equal(fixNote(["ห้วนไป", "ข้อมูลผิด"], "  ตอบว่า   ราคา 12,900 บาทค่ะ "), "ห้วนไป · ข้อมูลผิด — ควรตอบว่า: ตอบว่า ราคา 12,900 บาทค่ะ");
  assert.equal(Array.from(fixNote([], "ก".repeat(900), 500)).length, 500);
  const { taperLine } = await import("../public/console/ownerReviewDailyCard.mjs");
  assert.equal(taperLine(TAPER), "ระดับตรวจ: ตรวจทุกห้อง · วันที่ 3/7 · ตรงกับ AI 7 วัน 88%");
  assert.equal(taperLine({ ...TAPER, dayNumber: 0, agreement7d: null }), "ระดับตรวจ: ตรวจทุกห้อง · เริ่มคืนนี้");
  assert.equal(taperLine({ ...TAPER, inWarmup: false, dayNumber: 9, level: 1, levelLabel: LEVEL_LABELS[1], pinned: true }),
    "ระดับตรวจ: ห้องน่าห่วง + สุ่ม 20% (ปักไว้) · ตรงกับ AI 7 วัน 88%");
});

/* ---------------------------------- เรนเดอร์ ---------------------------------- */

test("การ์ดแรก = ห้องน่าห่วง: ป้ายน่าห่วง · สรุปของ AI · ชิปปัญหา · ฟองลูกค้าซ้าย/ลูกแพรขวา/ทีมงานแบบที่สาม · ปัญหาปักใต้ฟอง · ข้อความลูกค้าเป็น text node", async (t) => {
  const page = await renderDaily(t);
  const card = page.card();
  assert.equal(card.attributes["data-item"], "A");
  assert.ok(hasClass(card, "tone-risk"));
  const text = textOf(card);
  assert.match(text, /สมชาย ใจดี/u);
  assert.match(textOf(byClass(card, "odr-risk")[0]), /น่าห่วง/u);
  assert.match(text, /AI สรุปลูกค้าถามราคา ลูกแพรตอบราคาผิด/u);
  // รีวิว 13 ต.ค.: แชทสั้น = ปัญหาอยู่ใต้ฟอง/กล่องทั้งห้องบนจอแล้ว ไม่มีแถวชิปซ้ำด้านบน (แชทยาวมี — ดู owner-review-daily-ui-review)
  assert.equal(byClass(card, "odr-chips").length, 0);
  assert.ok(hasClass(page.bubble("a1"), "is-context"), "ฟองก่อนช่วงจาง");
  assert.ok(hasClass(page.bubble("a2"), "is-customer"));
  assert.ok(hasClass(page.bubble("a3"), "is-ai") && hasClass(page.bubble("a3"), "has-issue") && hasClass(page.bubble("a3"), "sev-high"));
  assert.ok(hasClass(page.bubble("a4"), "is-team"));
  assert.match(textOf(page.bubble("a4")), /ทีมงาน/u);
  assert.match(textOf(byClass(page.bubble("a3"), "odr-issue")[0]), /ราคาผิดราคาไม่ตรงกับรอบนี้/u, "ปัญหาปักใต้ฟองที่อ้างถึง");
  assert.match(textOf(byClass(card, "odr-room-issues")[0]), /ยาวไปตอบยาวเกินแชท/u, "ปัญหาที่ไม่ผูกฟอง = ทั้งห้อง");
  assert.equal(all(page.body, (node) => node.tagName === "img").length, 0);
  assert.ok(byClass(card, "odr-bubble-text").some((node) => textOf(node) === "<img src=x onerror=alert(1)> ราคาเท่าไหร่ครับ"));
  // แถบบางติดขอบบน (รีวิว 13 ต.ค.): ความคืบหน้า · ชิปวันค้างหนึ่งชิป · ปุ่มระดับ (คำสั้น + aria-label เต็ม)
  const bar = byClass(page.body, "odr-bar")[0];
  assert.ok(bar && hasClass(bar.parent, "odr-bar-host"));
  assert.match(textOf(bar), /^ตรวจแล้ว 0 \/ 5/u, "คิวล่าสุดไม่ต้องบอกชื่อวัน");
  const stats = byClass(bar, "odr-stats")[0];
  assert.equal(textOf(stats), "วันที่ 3/7⌄");
  assert.match(stats.attributes["aria-label"], /^ระดับตรวจ: ตรวจทุกห้อง · วันที่ 3\/7 · ตรงกับ AI 7 วัน 88% — ดูรายละเอียด$/u);
  assert.match(textOf(byClass(page.body, "orv-seg")[0]), /ตรวจแชทวันนี้5/u, "ตัวเลขบนแท็บ = ห้องที่ยังไม่ติดป้าย");
  const backlogChip = byClass(bar, "odr-backlog-chip")[0];
  assert.equal(textOf(backlogChip), "ค้าง 11 ต.ค.3");
  assert.equal(backlogChip.attributes["aria-label"], "ยังค้าง 11 ต.ค. 3 ห้อง");
  assert.equal(backlogChip.attributes.href, "#/owner-review/daily?batch=b0");
  assert.equal(byClass(page.body, "odr-taper").length, 0, "รายละเอียดระดับซ่อนอยู่หลังปุ่ม");
  await click(stats);
  const panel = byClass(page.body, "odr-taper")[0];
  assert.match(textOf(panel), /ระดับตรวจ: ตรวจทุกห้อง · วันที่ 3\/7 · ตรงกับ AI 7 วัน 88%/u);
  assert.match(textOf(byClass(panel, "odr-backlog")[0]), /ยังค้าง11 ต\.ค\.3 ห้อง/u, "แผงรายละเอียดมีทุกวันที่ค้าง");
  assert.deepEqual(page.claims(), ["A"], "เปิดการ์ด = บอกเซิร์ฟเวอร์ว่ากำลังดูห้องนี้");
  assert.equal(byClass(page.body, "odr-bulk").length, 0, "ห้องน่าห่วงยังไม่ครบ = ยังไม่มีดีที่เหลือทั้งหมด");
  assert.equal(button(page.body, "ดีแล้ว ห้องของ สมชาย ใจดี").disabled, false);
  assert.equal(button(page.body, "ต้องปรับ ห้องของ สมชาย ใจดี").disabled, false);
  assert.ok(page.calls.some((call) => call.path === "/console/api/owner-review/summary"), "เปิดหน้า = เห็นแล้ว (ไม่ใช่ peek)");
  assert.ok(page.calls.some((call) => call.path === "/console/api/owner-review/daily/items/B"), "โหลดห้องถัดไปรอไว้");
  assert.equal(page.calls.some((call) => call.path.includes("/proposals")), false);
});

test("แตะชิปปัญหา = ฟองที่อ้างถึงกะพริบ (is-flash) · ชิปทั้งห้องไม่ทำให้ฟองไหนกะพริบ", async (t) => {
  // แถวชิปมีเฉพาะแชทยาว (> 6 ฟอง) — ต่อแชทของห้อง A ให้ยาวขึ้น
  const filler = Array.from({ length: 6 }, (_, i) => ({
    id: `af${i}`, ref: `m${i + 5}`, speaker: i % 2 ? "ai" : "customer", direction: i % 2 ? "out" : "in", msgType: "text",
    text: `ข้อความเติม ${i}`, at: NOW - 2 * HOUR + i * 60_000, proactive: false, inWindow: true, fixable: i % 2 === 1, issueKeys: [],
  }));
  const page = await renderDaily(t, { detail: { A: { bubbles: [...bubblesOf("A"), ...filler] } } });
  assert.deepEqual(byClass(page.card(), "odr-chip").map(textOf), ["!ราคาผิด", "•ยาวไป"]);
  await click(button(page.card(), "ราคาผิด — ดูข้อความที่ AI ชี้"));
  assert.ok(hasClass(page.bubble("a3"), "is-flash"));
  assert.equal(byClass(page.card(), "is-flash").length, 1);
  await click(button(page.card(), "ยาวไป — ทั้งห้อง"));
  assert.ok(hasClass(page.bubble("a3"), "is-flash"), "แตะชิปทั้งห้อง = ไม่วาดการ์ดใหม่");
});

test("ดีแล้ว: POST label ด้วย revision → ห้องถัดไปทันที · แถบย้อนด้านบน · ย้อน = POST undo แล้วการ์ดกลับมา", async (t) => {
  const page = await renderDaily(t);
  await click(button(page.body, "ดีแล้ว ห้องของ สมชาย ใจดี"));
  assert.deepEqual(page.posts().map((call) => [call.path, call.body]), [
    ["/console/api/owner-review/daily/items/A/label", { label: "good", revision: 0 }],
  ]);
  assert.equal(page.card().attributes["data-item"], "B", "ห้องที่ AI ยังไม่ได้อ่านมาต่อ");
  assert.ok(hasClass(page.card(), "tone-unread"));
  assert.match(textOf(page.card()), /AI ยังไม่ได้อ่านห้องนี้อ่านเองทั้งห้องนะคะ/u);
  assert.match(page.text(), /ตรวจแล้ว 1 \/ 5/u);
  assert.match(textOf(byClass(page.body, "orv-seg")[0]), /ตรวจแชทวันนี้4/u);
  const toastNode = page.undoToast();
  assert.match(textOf(toastNode), /ดีแล้ว · สมชาย ใจดี/u);
  assert.match(textOf(toastNode), /บันทึกแล้ว/u);
  assert.equal(byClass(toastNode, "orv-undo-why")[0].hidden, true, "ไม่มีปุ่มเหตุผลแบบเฟส A");
  await click(button(toastNode, "ย้อน"));
  assert.deepEqual(page.posts().at(-1), { path: "/console/api/owner-review/daily/items/A/undo", method: "POST", body: { revision: 1 } });
  assert.equal(page.card().attributes["data-item"], "A");
  assert.match(page.text(), /ตรวจแล้ว 0 \/ 5/u);
  assert.ok(page.toasts.includes("ย้อนแล้ว — ห้องนี้กลับมารอตรวจ"));
  await click(button(page.body, "ดีแล้ว ห้องของ สมชาย ใจดี"));
  assert.deepEqual(page.posts().at(-1).body, { label: "good", revision: 2 }, "กดใหม่ใช้ revision หลังย้อน");
});

test("ปัดการ์ดไปทางขวา = ดีแล้ว · ปัดไม่ถึงระยะ = การ์ดกลับที่เดิม ไม่บันทึก", async (t) => {
  const page = await renderDaily(t);
  const swipe = (card, dx) => {
    const base = { pointerId: 7, pointerType: "touch", button: 0, target: card };
    card.dispatch("pointerdown", { ...base, clientX: 10, clientY: 100 });
    card.dispatch("pointermove", { ...base, clientX: 10 + dx / 2, clientY: 101 });
    card.dispatch("pointermove", { ...base, clientX: 10 + dx, clientY: 102 });
    card.dispatch("pointerup", { ...base, clientX: 10 + dx, clientY: 102 });
  };
  swipe(page.card(), 40);
  await flush();
  assert.equal(page.posts().length, 0);
  swipe(page.card(), 140);
  await flush();
  assert.deepEqual(page.posts().map((call) => call.body), [{ label: "good", revision: 0 }]);
  assert.equal(page.card().attributes["data-item"], "B");
});

test("ต้องปรับ (พี่ง้วง): แตะฟองของลูกแพร → แผ่นชิป 7 แบบ + ควรตอบว่า… → POST fix → บอกว่าลูกแพรใช้ทันที → ห้องถัดไป · ย้อนถอนบทเรียน", async (t) => {
  const page = await renderDaily(t);
  await click(button(page.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  assert.match(page.text(), /แตะข้อความของลูกแพรที่ควรปรับ/u);
  assert.equal(byClass(page.body, "orv-thumb-btns")[0].hidden, true, "ปุ่มดีแล้ว/ต้องปรับหลบ");
  assert.ok(button(page.body, "ไม่ระบุข้อความ"));
  assert.ok(hasClass(page.bubble("a4"), "is-unpickable"), "ฟองของทีมงานแก้ไม่ได้");
  assert.ok(hasClass(page.bubble("a2"), "is-unpickable"));
  assert.equal(byClass(page.card(), "odr-bubble-pick").length, 1, "แตะได้เฉพาะฟองของลูกแพรในช่วงนั้น");
  await click(byClass(page.card(), "odr-bubble-pick")[0]);
  const sheet = page.sheet();
  assert.ok(sheet);
  assert.equal(sheet.attributes.role, "dialog");
  assert.match(textOf(sheet), /ข้อความนี้ควรปรับยังไง/u);
  assert.match(textOf(sheet), /คลาสละ 990 บาทค่ะ/u);
  assert.match(textOf(sheet), /AI ชี้ไว้: ราคาผิด — ราคาไม่ตรงกับรอบนี้/u);
  assert.match(textOf(sheet), /ลูกแพรใช้บทเรียนนี้ทันที/u, "เจ้าของ = ใช้ทันที (บอกก่อนกด)");
  assert.deepEqual(byClass(sheet, "odr-fix-chip").map(textOf), CHIPS.map((chip) => chip.label));
  const save = button(sheet, "บันทึกแล้วไปห้องถัดไป");
  assert.equal(save.disabled, true, "ยังไม่เลือกอะไร = บันทึกไม่ได้");
  await click(button(sheet, "ข้อมูลผิด"));
  await click(button(sheet, "ควรบอกราคา"));
  assert.equal(button(sheet, "ข้อมูลผิด").attributes["aria-pressed"], "true");
  const textarea = byClass(sheet, "odr-fix-text")[0];
  textarea.value = "คลาสนี้ 12,900 บาทค่ะ ได้เรียนสด 2 วันพร้อมใบประกาศฯ";
  textarea.dispatch("input", {});
  assert.ok(textOf(sheet).includes(`${Array.from(textarea.value).length}/500`), "ตัวนับนับตัวอักษรแบบเซิร์ฟเวอร์ (code point)");
  assert.equal(save.disabled, false);
  await click(save);
  assert.deepEqual(page.posts().map((call) => [call.path, call.body]), [
    ["/console/api/owner-review/daily/items/A/fix", {
      messageId: "a3", reasonChips: ["tell_price", "wrong_fact"], betterReply: "คลาสนี้ 12,900 บาทค่ะ ได้เรียนสด 2 วันพร้อมใบประกาศฯ", revision: 0,
    }],
  ]);
  assert.equal(page.card().attributes["data-item"], "B");
  assert.match(textOf(page.undoToast()), /ต้องปรับ · สมชาย ใจดี/u);
  assert.match(textOf(page.undoToast()), /บันทึกแล้ว — ลูกแพรจะใช้กับเรื่องคล้ายกันตั้งแต่ข้อความถัดไป/u);
  await click(button(page.undoToast(), "ย้อน"));
  assert.deepEqual(page.posts().at(-1), { path: "/console/api/owner-review/daily/items/A/undo", method: "POST", body: { revision: 1 } });
  assert.ok(page.toasts.includes("ย้อนแล้ว — ถอนบทเรียนที่เพิ่งสร้างแล้ว"));
  assert.equal(page.card().attributes["data-item"], "A");
});

test("ต้องปรับ (ชมพู่): แผ่นบอกว่ารอพี่ง้วงอนุมัติ · คำตอบบอกตรง ๆ · ไม่มีปุ่มปักระดับ", async (t) => {
  const page = await renderDaily(t, { role: "operator" });
  await click(button(page.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  await click(byClass(page.card(), "odr-bubble-pick")[0]);
  assert.match(textOf(page.sheet()), /บทเรียนนี้จะรอพี่ง้วงอนุมัติก่อน ลูกแพรจึงจะใช้/u);
  await click(button(page.sheet(), "ห้วนไป"));
  await click(button(page.sheet(), "บันทึกแล้วไปห้องถัดไป"));
  assert.deepEqual(page.posts().at(-1).body, { messageId: "a3", reasonChips: ["curt"], betterReply: "", revision: 0 });
  assert.match(textOf(page.undoToast()), /ส่งให้พี่ง้วงอนุมัติแล้ว — ลูกแพรจะใช้เมื่อพี่ง้วงอนุมัติ/u);
  await click(button(page.body, "ระดับตรวจ"));
  assert.match(textOf(byClass(page.body, "odr-taper")[0]), /สัปดาห์แรกตรวจทุกห้อง/u);
  assert.equal(byClass(page.body, "odr-pin").length, 0, "ปักระดับ = เจ้าของเท่านั้น");
});

test("ต้องปรับ: บทเรียนถูกปฏิเสธ = แผ่นยังเปิด ข้อความที่พิมพ์อยู่ครบ ไม่ไปห้องถัดไป · ระบบสอนปิด = ป้าย needs_fix พร้อมโน้ต", async (t) => {
  const refused = await renderDaily(t, {
    handlers: {
      "POST /console/api/owner-review/daily/items/A/fix": () => {
        throw apiError(400, { ok: false, code: "lesson_refused", error: "บทเรียนมีเบอร์โทร — ลบออกก่อนนะคะ", item: qItem("A") });
      },
    },
  });
  await click(button(refused.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  await click(byClass(refused.card(), "odr-bubble-pick")[0]);
  const textarea = byClass(refused.sheet(), "odr-fix-text")[0];
  textarea.value = "โทรหาเราที่เบอร์ร้าน";
  textarea.dispatch("input", {});
  await click(button(refused.sheet(), "บันทึกแล้วไปห้องถัดไป"));
  assert.match(textOf(refused.sheet()), /บทเรียนมีเบอร์โทร — ลบออกก่อนนะคะ/u);
  assert.equal(byClass(refused.sheet(), "odr-fix-text")[0].value, "โทรหาเราที่เบอร์ร้าน");
  assert.equal(refused.card().attributes["data-item"], "A");

  const off = await renderDaily(t, { detail: { "*": { canTeach: false, teachEnabled: false } } });
  await click(button(off.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  await click(byClass(off.card(), "odr-bubble-pick")[0]);
  assert.match(textOf(off.sheet()), /ระบบสอนลูกแพรปิดอยู่ — บันทึกเป็นป้าย "ต้องปรับ" อย่างเดียว/u);
  await click(button(off.sheet(), "ห้วนไป"));
  const textareaOff = byClass(off.sheet(), "odr-fix-text")[0];
  textareaOff.value = "ตอบให้อบอุ่นขึ้นค่ะ";
  textareaOff.dispatch("input", {});
  await click(button(off.sheet(), "บันทึกแล้วไปห้องถัดไป"));
  assert.deepEqual(off.posts().at(-1), {
    path: "/console/api/owner-review/daily/items/A/label", method: "POST",
    body: { label: "needs_fix", revision: 0, note: "ห้วนไป — ควรตอบว่า: ตอบให้อบอุ่นขึ้นค่ะ" },
  });
  assert.match(textOf(off.undoToast()), /บันทึกว่าต้องปรับแล้ว — ระบบสอนลูกแพรปิดอยู่/u);
});

test("ต้องปรับ › ไม่ระบุข้อความ = แผ่นของทั้งห้อง → ป้าย needs_fix + โน้ต (ไม่สร้างบทเรียน) · ยกเลิกเลือกฟอง = กลับปุ่มเดิม", async (t) => {
  const page = await renderDaily(t);
  await click(button(page.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  await click(button(page.body, "ยกเลิก"));
  assert.equal(byClass(page.body, "odr-pick-btns")[0].hidden, true);
  assert.equal(byClass(page.card(), "odr-bubble-pick").length, 0);
  await click(button(page.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  await click(button(page.body, "ไม่ระบุข้อความ"));
  assert.match(textOf(page.sheet()), /ห้องของ สมชาย ใจดี ต้องปรับตรงไหน/u);
  assert.match(textOf(page.sheet()), /ไม่ได้ระบุข้อความ/u);
  await click(button(page.sheet(), "ถามซ้ำ"));
  await click(button(page.sheet(), "บันทึกแล้วไปห้องถัดไป"));
  assert.deepEqual(page.posts().at(-1).body, { label: "needs_fix", revision: 0, note: "ถามซ้ำ" });
  assert.equal(page.card().attributes["data-item"], "B");
});

test("ใช่/ไม่ใช่ กับปัญหาที่ AI ชี้ = POST verdict ตาม issueKey · กดซ้ำ = ถอน (null)", async (t) => {
  const page = await renderDaily(t);
  await click(button(page.card(), "AI ชี้ถูก: ราคาผิด"));
  assert.deepEqual(page.posts().at(-1), { path: "/console/api/owner-review/daily/items/A/verdict", method: "POST", body: { issueKey: "wrong_price@a3", verdict: "agree" } });
  assert.equal(button(page.card(), "AI ชี้ถูก: ราคาผิด").attributes["aria-pressed"], "true");
  await click(button(page.card(), "AI ชี้ถูก: ราคาผิด"));
  assert.deepEqual(page.posts().at(-1).body, { issueKey: "wrong_price@a3", verdict: null });
  await click(button(page.card(), "AI ชี้ไม่ถูก: ยาวไป"));
  assert.deepEqual(page.posts().at(-1).body, { issueKey: "over_long@", verdict: "disagree" });
  assert.equal(page.card().attributes["data-item"], "A", "ใช่/ไม่ใช่ไม่ใช่ป้ายของห้อง");
});

test("ดีที่เหลือทั้งหมด: โผล่เมื่อห้องน่าห่วงครบ (ไม่รวมห้องสุ่ม/AI ไม่ได้อ่าน) → POST good-rest → โหลดคิวใหม่ · ย้อน = POST good-rest/undo", async (t) => {
  const items = baseItems().map((item) => (item.id === "A" ? { ...item, label: "needs_fix", revision: 1 } : item));
  const page = await renderDaily(t, { items });
  assert.equal(page.card().attributes["data-item"], "B");
  const bulk = button(page.body, "ดีที่เหลือทั้งหมด (2)");
  assert.match(textOf(bulk), /2 ห้องที่ AI อ่านแล้วไม่เจอจุดไหน · ไม่รวมห้องที่เปิดอยู่/u);
  assert.ok(hasClass(bulk, "is-quiet"), "สัปดาห์แรก = ปุ่มรอง");
  await click(bulk);
  assert.equal(page.posts().length, 0, "แตะครั้งแรก = ขอยืนยันเท่านั้น");
  const armed = button(page.body, "แตะอีกครั้งเพื่อยืนยัน · ดีแล้ว 2 ห้อง");
  assert.ok(hasClass(armed, "is-armed"));
  await click(armed);
  assert.deepEqual(page.posts().map((call) => [call.path, call.body]), [["/console/api/owner-review/daily/batches/b1/good-rest", { exceptId: "B" }]]);
  assert.ok(page.calls.filter((call) => call.path === "/console/api/owner-review/daily").length >= 2, "โหลดคิวใหม่หลังกด");
  assert.match(page.text(), /ตรวจแล้ว 3 \/ 5/u);
  assert.equal(page.card().attributes["data-item"], "B", "การ์ดที่ดูอยู่ไม่เปลี่ยนใต้นิ้ว");
  assert.equal(byClass(page.body, "odr-bulk").length, 0);
  assert.match(textOf(page.undoToast()), /ดีแล้ว 2 ห้อง/u);
  await click(button(page.undoToast(), "ย้อน"));
  assert.deepEqual(page.posts().at(-1), { path: "/console/api/owner-review/daily/batches/b1/good-rest/undo", method: "POST", body: { bulkId: "bulk-12345678" } });
  assert.match(page.text(), /ตรวจแล้ว 1 \/ 5/u);
});

test("ตรวจครบ: หน้าสรุปของรอบ (ดีแล้ว/ต้องปรับ/บทเรียน) + ขอบคุณ + ชิปวันค้าง + คิวถัดไป · ไม่มีปุ่มตัดสิน", async (t) => {
  const items = baseItems().map((item) => (item.id === "E" ? item : { ...item, label: item.id === "A" ? "needs_fix" : "good", revision: 1 }));
  const page = await renderDaily(t, { items });
  await click(button(page.body, "ต้องปรับ ห้องของ ลูกค้า E"));
  await click(byClass(page.card(), "odr-bubble-pick")[0]);
  await click(button(page.sheet(), "ยาวไป"));
  await click(button(page.sheet(), "บันทึกแล้วไปห้องถัดไป"));
  const done = byClass(page.body, "odr-done")[0];
  assert.ok(done, "หน้าตรวจครบ");
  const text = textOf(done);
  assert.match(text, /ตรวจครบทุกห้องของ 12 ต\.ค\. แล้ว/u);
  assert.match(text, /3ดีแล้ว/u);
  assert.match(text, /2ต้องปรับ/u);
  assert.match(text, /1บทเรียนใหม่ \(ใช้แล้ว\)/u);
  assert.match(text, /ขอบคุณที่ช่วยดูแชทของลูกแพรวันนี้นะคะ/u);
  assert.match(text, /คิวถัดไป/u);
  assert.equal(byClass(done, "odr-backlog-chip")[0].attributes.href, "#/owner-review/daily?batch=b0");
  assert.ok(byClass(page.body, "orv-thumb-btns").every((node) => node.hidden));
  assert.match(textOf(byClass(page.body, "orv-seg")[0]), /ตรวจแชทวันนี้0/u);
});

test("มีคนติดป้ายห้องนี้ไปก่อน: ดีแล้วได้ 409 = การ์ดไม่กลับมา บอกว่าใครตรวจแล้ว · รายละเอียดบอกว่าตรวจแล้ว = แถบ + ปุ่มไปห้องถัดไป", async (t) => {
  const page = await renderDaily(t, {
    handlers: {
      "POST /console/api/owner-review/daily/items/A/label": () => {
        throw apiError(409, { ok: false, code: "stale_revision", error: "มีคนตรวจห้องนี้ไปก่อนแล้ว", item: { ...qItem("A"), label: "good", revision: 1, labelledByName: "ชมพู่" } });
      },
    },
  });
  await click(button(page.body, "ดีแล้ว ห้องของ สมชาย ใจดี"));
  assert.equal(page.card().attributes["data-item"], "B");
  assert.ok(page.toasts.includes("ชมพู่ ตรวจห้องนี้ไปแล้ว (ดีแล้ว)"));
  assert.match(page.text(), /ตรวจแล้ว 1 \/ 5/u);

  const seen = await renderDaily(t, { detail: { A: { item: { ...qItem("A"), label: "good", revision: 1, labelledByName: "ชมพู่" } } } });
  assert.match(textOf(seen.card()), /ชมพู่ ตรวจห้องนี้แล้ว: ดีแล้ว/u);
  assert.equal(button(seen.body, "ดีแล้ว ห้องของ").disabled, true, "ห้องที่มีป้ายแล้วกดซ้ำไม่ได้");
  await click(button(seen.card(), "ไปห้องถัดไป"));
  assert.equal(seen.card().attributes["data-item"], "B");
  assert.equal(seen.posts().length, 0);
});

test("ดีแล้วบันทึกไม่ผ่าน (เน็ตหลุด) = การ์ดกลับมาพร้อมบอกเหตุ", async (t) => {
  const page = await renderDaily(t, {
    handlers: { "POST /console/api/owner-review/daily/items/A/label": () => { throw apiError(502, { ok: false, error: "เครือข่ายขัดข้อง" }); } },
  });
  await click(button(page.body, "ดีแล้ว ห้องของ สมชาย ใจดี"));
  assert.equal(page.card().attributes["data-item"], "A");
  assert.ok(page.toasts.some((message) => /บันทึก "ดีแล้ว" ของ สมชาย ใจดี ไม่สำเร็จ/u.test(message)));
  assert.match(page.text(), /ตรวจแล้ว 0 \/ 5/u);
});

test("การ์ดเพิ่งขึ้น: แตะ 'ดีแล้ว' สองทีติดกัน = ติดป้ายห้องเดียว (ห้องถัดไปที่ยังไม่เห็นไม่โดน)", async (t) => {
  const page = await renderDaily(t, { armMs: 300 });
  await sleep(320);
  const good = button(page.body, "ดีแล้ว ห้องของ สมชาย ใจดี");
  await click(good);
  await click(good);
  assert.equal(page.posts().length, 1);
  assert.equal(page.card().attributes["data-item"], "B");
});

test("เจ้าของ: แผงระดับการตรวจมีปุ่มปักระดับ → POST /daily/taper {pin} · บรรทัดระดับเปลี่ยนตาม", async (t) => {
  const page = await renderDaily(t);
  const toggle = button(page.body, "ระดับตรวจ");
  assert.equal(toggle.attributes["aria-expanded"], "false");
  await click(toggle);
  assert.equal(button(page.body, "ระดับตรวจ").attributes["aria-expanded"], "true");
  const panel = byClass(page.body, "odr-taper")[0];
  assert.match(textOf(panel), /120ห้องที่ติดป้าย 7 วัน/u);
  assert.match(textOf(panel), /AI ชี้ถูก: ราคาผิด 3\/4/u);
  assert.equal(button(panel, "อัตโนมัติ").attributes["aria-pressed"], "true");
  await click(button(panel, "น่าห่วง + 20%"));
  assert.deepEqual(page.posts().at(-1), { path: "/console/api/owner-review/daily/taper", method: "POST", body: { pin: 1 } });
  assert.match(page.text(), /ระดับตรวจ: ห้องน่าห่วง \+ สุ่ม 20% \(ปักไว้\)/u);
  assert.ok(page.toasts.some((message) => /มีผลคิวคืนถัดไป/u.test(message)));
});

test("ยังไม่มีคิว / กำลังเตรียมคิว / วันที่ขอไม่มีแล้ว (404) = หน้าบอกตรง ๆ ไม่มีปุ่มตัดสิน", async (t) => {
  const none = await renderDaily(t, { queue: { batch: null, items: [], backlog: [], building: null } });
  assert.match(none.text(), /ยังไม่มีคิวตรวจแชท/u);
  assert.match(none.text(), /คิวถัดไป/u);
  assert.equal(byClass(none.body, "odr-card").length, 0);

  const building = await renderDaily(t, { queue: { batch: null, items: [], backlog: [], building: { batchId: "b2", dayKey: "2026-10-12", dayLabel: "12 ต.ค.", done: 40, total: 118 } } });
  assert.match(building.text(), /กำลังเตรียมคิวตรวจแชท/u);
  assert.match(building.text(), /AI อ่านแล้ว 40 \/ 118 ห้อง/u);

  const missing = await renderDaily(t, {
    hash: "#/owner-review/daily?batch=gone",
    handlers: { "GET /console/api/owner-review/daily?batch=gone": () => { throw apiError(404, { ok: false, code: "not_found", error: "ไม่พบคิวของวันนั้น" }); } },
  });
  assert.match(missing.text(), /ไม่พบคิวของวันนั้น/u);
  assert.equal(all(missing.body, (node) => node.tagName === "a" && textOf(node) === "ไปคิวล่าสุด")[0].attributes.href, "#/owner-review/daily");
});

test("ดูวันที่ค้าง (?batch=) = ขอคิวของวันนั้น · มีลิงก์กลับคิวล่าสุด · ตัวเลขบนแท็บยังเป็นของคิวล่าสุด", async (t) => {
  const page = await renderDaily(t, { hash: "#/owner-review/daily?batch=b0" });
  assert.ok(page.calls.some((call) => call.path === "/console/api/owner-review/daily?batch=b0"));
  assert.ok(all(page.body, (node) => node.tagName === "a" && node.attributes.href === "#/owner-review/daily" && /กลับคิวล่าสุด/u.test(textOf(node))).length);
  await click(button(page.body, "ดีแล้ว ห้องของ สมชาย ใจดี"));
  assert.match(textOf(byClass(page.body, "orv-seg")[0]), /ตรวจแชทวันนี้5/u, "แท็บนับจาก summary ของคิวล่าสุด");
});

/* ------------------------------ ข้อมูลพรีวิว (ข้อ 7) ------------------------------ */

test("พรีวิว (scripts/preview-lukprae-ui.mjs): คิวจำลองพร้อม 9 ห้อง (น่าห่วง 2 · AI ไม่ได้อ่าน 1 · สุ่ม 1) + วันก่อนค้าง 2 ห้อง · โหมดกำลังเตรียม", async () => {
  const { memoryDb } = await import("./helpers.mjs");
  const { seedPreviewDailyReview, lastDailyCutoff } = await import("../scripts/preview-owner-review-daily.mjs");
  const { createOwnerReviewDailyRoutes } = await import("../src/consoleOwnerReviewDailyApi.mjs");
  const seed = (mode) => {
    let fixed = null;
    const db = memoryDb({ now: () => fixed ?? Date.now() });
    // ห้องอื่นของพรีวิวที่ลูกแพรตอบในช่วงเดียวกัน ต้องไม่หลุดเข้าคิวจำลอง
    db.upsertCustomer("demo-001", { displayName: "ห้องอื่นของพรีวิว" });
    const cutoff = lastDailyCutoff(Date.now());
    fixed = cutoff - 30 * 60_000;
    db.insertMessage({ customerId: "demo-001", direction: "out", content: "ยินดีค่ะ", agentMode: "ai", operator: "" });
    fixed = null;
    const at = (ms, fn) => { fixed = ms; try { return fn(); } finally { fixed = null; } };
    return { db, seeded: seedPreviewDailyReview({ db, at, mode }) };
  };
  const { db, seeded } = seed("ready");
  const routes = createOwnerReviewDailyRoutes({ db });
  const summary = routes.summary(null);
  assert.equal(summary.batch.id, seeded.batchId);
  assert.deepEqual([summary.progress.total, summary.progress.flagged, summary.progress.remaining], [9, 2, 9]);
  assert.deepEqual(summary.backlog.map((row) => row.remaining), [2]);
  assert.equal(summary.taper.dayNumber, 3);
  const queue = db.listOwnerReviewQueue(seeded.batchId).map((row) => routes.publicItem(row));
  assert.deepEqual(queue.slice(0, 3).map((item) => item.riskLabel), ["น่าห่วง", "น่าห่วง", "AI ยังไม่ได้อ่าน"]);
  assert.equal(queue.filter((item) => item.sampled).length, 1);
  assert.ok(queue.every((item) => item.customerId.startsWith("demo-odr-t-")));
  assert.ok(queue[0].issues.every((issue) => issue.messageId), "ปัญหาผูกฟองจริง");
  db.close();

  const building = seed("building");
  const buildingSummary = createOwnerReviewDailyRoutes({ db: building.db }).summary(null);
  assert.equal(buildingSummary.batch, null);
  assert.deepEqual([buildingSummary.building.done, buildingSummary.building.total], [4, 9]);
  building.db.close();
});
