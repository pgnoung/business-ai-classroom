// owner-review-daily-ui-review — สิ่งที่แก้จากรีวิวหน้าเว็บ "ตรวจแชทวันนี้" บน iPhone (13 ต.ค. 2026) · DOM จำลอง + api ปลอม
//   · แถบความคืบหน้าบาง (คำสั้น) · เลื่อนห้องถัดไปให้อยู่ใต้แถบ (ไม่เด้งบนสุด) · คืนตำแหน่งฟองหลังวาดการ์ดใหม่
//   · ต้องปรับไม่กางแชททั้งห้อง ฟองที่ AI ชี้ยังมีวง + "AI ชี้ข้อความนี้" · ปัญหาใต้ฟองเป็นบรรทัดเดียว (แตะอ่านเต็ม) ✓/✕ 44px
//   · แผ่นต้องปรับ: ร่างไม่หาย · แตะพื้นหลังตอนพิมพ์ = เก็บคีย์บอร์ด · "ลูกแพรจะจำว่า…" · คำตอบสั้นเกินไม่ใช่บทเรียน
//   · ดีที่เหลือทั้งหมด: ไม่รวมห้องที่ AI ชี้จุด/การ์ดที่เปิดอยู่ · แตะยืนยันสองครั้ง · สัปดาห์แรกเป็นปุ่มรอง
//   · พี่ง้วง/ชมพู่: "กำลังดูห้องนี้" ไม่เปิดห้องเดียวกันพร้อมกัน · รูปจากคลังที่ลูกแพรส่งเห็นเป็นภาพย่อ · ข้อความอัตโนมัติแก้ไม่ได้
// ทุกข้อความเป็นประโยคสังเคราะห์ · ไม่มีการเรียก provider
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHIPS, HOUR, NOW, TAPER, all, baseItems, bubblesOf, button, byClass, click, flush, hasClass, issue, qItem, renderDaily, textOf,
} from "./ownerReviewDailyUiFixture.mjs";

const TEACH = {
  curt: "ตอบให้อบอุ่นเป็นธรรมชาติแบบคนคุยแชท ไม่ห้วน ไม่แข็งเหมือนบอท",
  tell_price: "ลูกค้าถามราคาตรง ๆ ให้ตอบราคาได้เลย พร้อมบอกว่าได้อะไรและคุ้มยังไง",
};
const CHIPS_WITH_TEACH = CHIPS.map((chip) => ({ ...chip, teach: TEACH[chip.key] || `สอน ${chip.label}` }));
const scrimOf = (page) => byClass(page.body, "orv-scrim")[0];

async function openSheetOnA(page) {
  await click(button(page.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  await click(byClass(page.card(), "odr-bubble-pick")[0]);
  return page.sheet();
}

function typeInto(sheet, value) {
  const textarea = byClass(sheet, "odr-fix-text")[0];
  textarea.value = value;
  textarea.dispatch("input", {});
  return textarea;
}

/* ---------------------------------- ส่วน pure ---------------------------------- */

test("pure: คำตอบที่ควรเป็นต้องมีตัวอักษร ≥ 6 · สิ่งที่ลูกแพรจะจำเรียงตามชิปแบบเดียวกับเซิร์ฟเวอร์ · คำสั้นบนปุ่มระดับ", async () => {
  const { usableReply, lessonPreview, BETTER_REPLY_MIN } = await import("../public/console/ownerReviewDailySheet.mjs");
  const { composeFixLesson, OWNER_REVIEW_BETTER_REPLY_MIN } = await import("../src/ownerReviewLabels.mjs");
  const { taperShort } = await import("../public/console/ownerReviewDailyCard.mjs");
  assert.equal(BETTER_REPLY_MIN, OWNER_REVIEW_BETTER_REPLY_MIN, "เกณฑ์เดียวกับเซิร์ฟเวอร์");
  for (const junk of [".", "ok", "   ", "😀😀😀😀😀😀😀", "โอเค", "ได้ค่ะ", "- - -"]) assert.equal(usableReply(junk), "", JSON.stringify(junk));
  assert.equal(usableReply("  ราคา   12,900 บาทค่ะ "), "ราคา 12,900 บาทค่ะ");
  const chips = CHIPS_WITH_TEACH;
  // ลำดับตามรายการชิป (ไม่ใช่ลำดับที่แตะ) + คำตอบต่อท้าย — ตรงกับ composeFixLesson ของเซิร์ฟเวอร์ทุกตัวอักษร
  const preview = lessonPreview(chips, ["tell_price", "curt"], "บอกราคา 12,900 บาท พร้อมสิ่งที่ได้");
  const server = composeFixLesson(["curt", "tell_price"].map((key) => key), "บอกราคา 12,900 บาท พร้อมสิ่งที่ได้");
  assert.equal(preview, `${TEACH.curt} · ${TEACH.tell_price} · ในสถานการณ์แบบนี้ควรตอบประมาณว่า: บอกราคา 12,900 บาท พร้อมสิ่งที่ได้`);
  assert.equal(preview, server.teaching);
  assert.equal(lessonPreview(chips, ["curt"], "ok"), TEACH.curt, "คำตอบสั้นไม่ถูกจำ");
  assert.equal(lessonPreview(chips, [], ""), "");
  assert.equal(taperShort(TAPER), "วันที่ 3/7");
  assert.equal(taperShort({ ...TAPER, dayNumber: 0, inWarmup: false }), "เริ่มคืนนี้");
  assert.equal(taperShort({ ...TAPER, dayNumber: 9, inWarmup: false, level: 1 }), "น่าห่วง + สุ่ม 20%");
  assert.equal(taperShort({ ...TAPER, pinned: true, pin: 2, level: 2 }), "น่าห่วง + สุ่ม 10% (ปัก)");
});

test("pure: ห้องที่คนอื่นกำลังดูไม่ขึ้นก่อน (สลับห้องว่างใบแรกขึ้นหน้า) · ข้ามไปท้ายกอง · ขอบเขตดีที่เหลือ = ไม่ชี้จุด ไม่ใช่การ์ดบนจอ", async () => {
  const state = await import("../public/console/ownerReviewDailyState.mjs");
  const view = state.newDailyView({ items: [
    qItem("A", { viewingBy: "ชมพู่", flagged: true, bulkEligible: false }), qItem("B", { viewingBy: "ชมพู่" }), qItem("C"),
    qItem("D", { issueCount: 1, issues: [issue("curt_or_robotic", "ห้วน/เหมือนบอท", "normal", "d2", "ห้วน")], bulkEligible: false }),
    qItem("E"),
  ] });
  assert.equal(state.preferUnclaimed(view), true);
  assert.deepEqual(view.deck, ["C", "A", "B", "D", "E"], "ห้องว่างใบแรกขึ้นหน้า ที่เหลือคงลำดับ");
  assert.equal(state.preferUnclaimed(view), false, "ใบหน้าว่างอยู่แล้ว = ไม่สลับ");
  assert.deepEqual(state.bulkScope(view), { count: 2, smallIssues: 1, exceptId: "C" }, "C เปิดอยู่ · D มีจุดเล็ก · เหลือ B กับ E");
  assert.equal(state.deferCurrent(view), true);
  assert.deepEqual(view.deck, ["A", "B", "D", "E", "C"]);
  assert.equal(state.draftKey("A", "a3"), "A:a3");
  assert.equal(state.draftKey("A", ""), "A:room");
  const allClaimed = state.newDailyView({ items: [qItem("A", { viewingBy: "ชมพู่" }), qItem("B", { viewingBy: "ชมพู่" })] });
  assert.equal(state.preferUnclaimed(allClaimed), false, "ทุกห้องมีคนดู = คงลำดับเดิม");
  assert.equal(state.newDailyView({ betterReplyMin: 8 }).betterReplyMin, 8);
});

test("ตำแหน่งจอ: ฟองกลางจอกลับมาอยู่ที่เดิมหลังวาดใหม่ · ห้องถัดไปเลื่อนมาอยู่ใต้แถบ (ไม่ใช่บนสุด)", async () => {
  const { captureAnchor, restoreAnchor, scrollUnderBar } = await import("../public/console/ownerReviewDailyScroll.mjs");
  const scroller = {
    scrollTop: 400, getBoundingClientRect: () => ({ top: 64, bottom: 746, height: 682 }),
    scrollTo({ top }) { this.scrollTop = top; },
  };
  const bubble = (id, top) => ({
    getAttribute: (key) => (key === "data-msg" ? id : null), getBoundingClientRect: () => ({ top, bottom: top + 60 }),
  });
  let rows = [bubble("m1", 90), bubble("m2", 380), bubble("m3", 700)];
  const root = { closest: () => scroller, querySelectorAll: () => rows };
  const anchor = captureAnchor(root);
  assert.deepEqual({ id: anchor.id, top: anchor.top }, { id: "m2", top: 380 }, "ฟองใกล้กลางจอที่สุด");
  assert.equal(captureAnchor(root, { prefer: "m3" }).id, "m3", "ฟองที่อยากยึดชนะถ้ามองเห็น");
  rows = [bubble("m1", -2500), bubble("m2", 5505), bubble("m3", 5800)]; // วาดใหม่แล้วฟองเดิมไปอยู่ไกล (แบบที่รีวิวเจอ)
  assert.equal(restoreAnchor(root, anchor), true);
  assert.equal(scroller.scrollTop, 400 + 5505 - 380);
  const bar = { getBoundingClientRect: () => ({ height: 44 }) };
  scroller.scrollTop = 1200;
  const deck = { closest: () => scroller, getBoundingClientRect: () => ({ top: 300 }) };
  assert.equal(scrollUnderBar(deck, { bar }), true);
  assert.equal(scroller.scrollTop, 1200 + 300 - 64 - 44 - 8, "กองการ์ดอยู่ใต้แถบ 8px");
  assert.equal(scrollUnderBar({ closest: () => scroller, getBoundingClientRect: () => ({ top: 64 + 44 + 8 }) }, { bar }), false, "อยู่ที่แล้ว = ไม่เลื่อน");
  assert.equal(captureAnchor({ closest: () => null, querySelectorAll: () => [] }), null, "ไม่มีกล่องเลื่อน (DOM ปลอม) = ไม่ทำอะไร");
});

/* ---------------------------------- การ์ด ---------------------------------- */

test("ปัญหาใต้ฟอง = แถบสั้น: ชื่อ + โน้ต (แตะ = อ่านเต็ม + ฟองกะพริบ) + ปุ่ม ถูก/ผิด ขนาดนิ้ว · ไม่มีกล่องใหญ่ 'AI ชี้ถูกไหม [ใช่][ไม่ใช่]'", async (t) => {
  const page = await renderDaily(t);
  const pin = all(page.bubble("a3"), (node) => hasClass(node, "odr-issue"))[0];
  const main = byClass(pin, "odr-issue-main")[0];
  assert.equal(main.tagName, "button");
  assert.equal(main.attributes["aria-expanded"], "false");
  assert.equal(main.attributes["aria-label"], "ราคาผิด: ราคาไม่ตรงกับรอบนี้");
  assert.deepEqual(byClass(pin, "odr-verdict").map((node) => [textOf(node), node.attributes["aria-label"]]), [
    ["ถูก", "AI ชี้ถูก: ราคาผิด"], ["ผิด", "AI ชี้ไม่ถูก: ราคาผิด"],
  ]);
  assert.doesNotMatch(textOf(page.card()), /ใช่ไม่ใช่|AI ชี้ถูกไหม/u);
  await click(main);
  const opened = all(page.bubble("a3"), (node) => hasClass(node, "odr-issue"))[0];
  assert.ok(hasClass(opened, "is-open"));
  assert.equal(byClass(opened, "odr-issue-main")[0].attributes["aria-expanded"], "true");
  assert.ok(hasClass(page.bubble("a3"), "is-flash"), "แตะปัญหา = ฟองที่อ้างถึงกะพริบ");
  assert.equal(page.posts().length, 0, "แตะอ่านโน้ตไม่ใช่การตัดสิน");
  await click(byClass(opened, "odr-issue-main")[0]);
  assert.equal(hasClass(all(page.bubble("a3"), (node) => hasClass(node, "odr-issue"))[0], "is-open"), false, "แตะอีกครั้ง = พับ");
});

test("ต้องปรับในแชทยาว: ไม่กางแชททั้งห้อง (ดูข้อความก่อนหน้ายังกดได้) · ฟองที่ AI ชี้มีวง + 'AI ชี้ข้อความนี้' · ปัญหายังเห็นแบบไม่มีปุ่ม", async (t) => {
  const long = [];
  for (let i = 1; i <= 40; i += 1) {
    const out = i % 2 === 0;
    long.push({
      id: `L${i}`, ref: `m${i}`, speaker: out ? "ai" : "customer", direction: out ? "out" : "in", msgType: "text",
      text: out ? `ตอบข้อ ${i} ค่ะ` : `ถามข้อ ${i} ครับ`, at: NOW - 3 * HOUR + i * 60_000, proactive: false, inWindow: true, fixable: out,
      issueKeys: i === 36 ? ["curt_or_robotic@L36"] : [],
    });
  }
  const items = baseItems().map((item) => (item.id === "A"
    ? { ...item, issues: [issue("curt_or_robotic", "ห้วน/เหมือนบอท", "normal", "L36", "ห้วน")], issueCount: 1 } : item));
  const page = await renderDaily(t, { items, detail: { A: { bubbles: long, unanchoredIssueKeys: [] } } });
  assert.equal(byClass(page.card(), "odr-msg").length, 30, "แชทยาวโชว์ 30 ฟองล่าสุด");
  await click(button(page.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  assert.equal(byClass(page.card(), "odr-msg").length, 30, "เข้าโหมดเลือกฟองแล้วไม่กางแชททั้งห้อง (จอไม่กระโดด)");
  assert.ok(button(page.card(), "ดูข้อความก่อนหน้าอีก 10"), "ฟองเก่ายังกางเองได้ระหว่างเลือก");
  const flagged = all(page.bubble("L36"), (node) => hasClass(node, "odr-bubble-pick"))[0];
  assert.ok(hasClass(flagged, "is-ai-flagged"));
  assert.match(textOf(flagged), /AI ชี้ข้อความนี้ · แตะเพื่อแก้/u);
  assert.match(flagged.attributes["aria-label"], /^ข้อความนี้ต้องปรับ \(AI ชี้ไว้\): ตอบข้อ 36 ค่ะ/u);
  assert.ok(hasClass(page.bubble("L36"), "has-issue"), "วงสีของปัญหายังอยู่");
  const quiet = all(page.bubble("L36"), (node) => hasClass(node, "odr-issue"))[0];
  assert.ok(hasClass(quiet, "is-quiet"));
  assert.equal(byClass(quiet, "odr-verdict").length, 0, "โหมดเลือกฟอง = ไม่มีปุ่ม ✓/✕ ให้แตะพลาด");
  assert.match(textOf(byClass(all(page.bubble("L38"), (node) => hasClass(node, "odr-bubble-pick"))[0], "odr-pick-cue")[0]), /^✏️ แตะเพื่อแก้$/u);
  await click(button(page.card(), "ดูข้อความก่อนหน้าอีก 10"));
  assert.equal(byClass(page.card(), "odr-msg").length, 40);
  assert.equal(byClass(page.card(), "odr-bubble-pick").length, 20, "กางแล้วแตะฟองเก่าได้ด้วย");
});

test("รูปจากคลังที่ลูกแพรส่ง = ภาพย่อ (https · ขนาดตายตัว · no-referrer) + ชื่อรูป · ข้อความอัตโนมัติติดป้ายและแตะแก้ไม่ได้", async (t) => {
  const bubbles = [
    ...bubblesOf("A").slice(0, 3),
    {
      id: "img1", ref: "m4", speaker: "ai", direction: "out", msgType: "image", text: "[ส่งรูป: poster-ai-agent]", at: NOW - 2 * HOUR,
      proactive: false, inWindow: true, fixable: true, issueKeys: [], image: { key: "poster-ai-agent", url: "https://cdn.example.test/poster.jpg" },
    },
    {
      id: "auto1", ref: "m5", speaker: "ai", direction: "out", msgType: "text", text: "ขอบคุณที่ทักมานะคะ", at: NOW - 2 * HOUR + 60_000,
      proactive: true, inWindow: true, fixable: false, automated: true, issueKeys: [],
    },
    {
      id: "cust-img", ref: "m6", speaker: "customer", direction: "in", msgType: "image", text: "[ส่งรูป]", at: NOW - 2 * HOUR + 120_000,
      proactive: false, inWindow: true, fixable: false, issueKeys: [],
    },
  ];
  const page = await renderDaily(t, { detail: { A: { bubbles } } });
  const imgs = all(page.body, (node) => node.tagName === "img");
  assert.equal(imgs.length, 1, "รูปของลูกค้ายังเป็นป้าย ไม่โหลดรูป");
  assert.deepEqual([imgs[0].attributes.src, imgs[0].attributes.width, imgs[0].attributes.height, imgs[0].attributes.referrerpolicy, imgs[0].attributes.loading],
    ["https://cdn.example.test/poster.jpg", "160", "120", "no-referrer", "lazy"]);
  assert.equal(imgs[0].attributes.alt, "รูปที่ลูกแพรส่ง: poster-ai-agent");
  assert.match(textOf(page.bubble("img1")), /รูปจากคลัง · poster-ai-agent/u);
  imgs[0].dispatch("error", { target: imgs[0] });
  assert.equal(imgs[0].hidden, true, "โหลดไม่ได้ = เหลือชื่อรูป");
  assert.match(textOf(page.bubble("auto1")), /อัตโนมัติ/u);
  assert.match(textOf(page.bubble("cust-img")), /\[ส่งรูป\]/u);
  await click(button(page.body, "ต้องปรับ ห้องของ สมชาย ใจดี"));
  assert.ok(hasClass(page.bubble("auto1"), "is-unpickable"), "ข้อความอัตโนมัติไม่ใช่สิ่งที่ลูกแพรเขียนเอง");
  assert.ok(hasClass(page.bubble("img1"), "is-pickable"), "รูปที่ลูกแพรเลือกส่งแก้ได้ (ไม่ควรส่งรูป/รีวิว)");
  // URL ที่ไม่ใช่ https ไม่ถูกโหลดแม้มาจากเซิร์ฟเวอร์
  const bad = await renderDaily(t, { detail: { A: { bubbles: [{ ...bubbles[3], image: { key: "x", url: "http://plain.example.test/x.jpg" } }] } } });
  assert.equal(all(bad.body, (node) => node.tagName === "img").length, 0);
});

/* ---------------------------------- แผ่นต้องปรับ ---------------------------------- */

test("แผ่นต้องปรับ: แตะพื้นหลังตอนมีร่าง = ไม่ปิด · ตอนพิมพ์ = เก็บคีย์บอร์ด · ยกเลิกแล้วเปิดใหม่ = ร่างเดิมกลับมา · บันทึกแล้วร่างหาย", async (t) => {
  const page = await renderDaily(t, { queue: { chips: CHIPS_WITH_TEACH } });
  let sheet = await openSheetOnA(page);
  await click(button(sheet, "ห้วนไป"));
  const textarea = typeInto(sheet, "ราคารอบนี้ 12,900 บาท ได้เรียนสด 2 วัน");
  textarea.focus();
  await click(scrimOf(page));
  assert.ok(page.sheet(), "กำลังพิมพ์ = แตะพื้นหลังแค่เก็บคีย์บอร์ด");
  assert.equal(page.doc.activeElement, null);
  await click(scrimOf(page));
  assert.ok(page.sheet(), "มีร่าง = แตะพื้นหลังไม่ปิดแผ่น");
  await click(button(sheet, "ยกเลิก"));
  assert.equal(page.sheet(), null);
  await click(byClass(page.card(), "odr-bubble-pick")[0]);
  sheet = page.sheet();
  assert.equal(byClass(sheet, "odr-fix-text")[0].value, "ราคารอบนี้ 12,900 บาท ได้เรียนสด 2 วัน", "ร่างเดิมกลับมา");
  assert.equal(button(sheet, "ห้วนไป").attributes["aria-pressed"], "true");
  assert.ok(hasClass(button(sheet, "ห้วนไป"), "is-on"));
  assert.ok(textOf(sheet).includes(`${Array.from("ราคารอบนี้ 12,900 บาท ได้เรียนสด 2 วัน").length}/500`), "ตัวนับตรงกับร่าง");
  await click(button(sheet, "บันทึกแล้วไปห้องถัดไป"));
  assert.deepEqual(page.posts().at(-1).body, { messageId: "a3", reasonChips: ["curt"], betterReply: "ราคารอบนี้ 12,900 บาท ได้เรียนสด 2 วัน", revision: 0 });
  await click(button(page.undoToast(), "ย้อน"));
  assert.equal(page.card().attributes["data-item"], "A");
  sheet = await openSheetOnA(page);
  assert.equal(byClass(sheet, "odr-fix-text")[0].value, "", "บันทึกสำเร็จแล้วไม่เหลือร่าง");
  assert.equal(button(sheet, "ห้วนไป").attributes["aria-pressed"], "false");
  await click(scrimOf(page));
  assert.equal(page.sheet(), null, "แผ่นว่าง = แตะพื้นหลังปิดได้");
});

test("แผ่นต้องปรับ: ส่วนล่างที่ไม่เลื่อนมี 'ลูกแพรจะจำว่า…' + ปุ่ม · คำตอบสั้น (ok) ไม่ใช่บทเรียน · ระบบสอนปิด = ไม่โชว์สิ่งที่จะจำ", async (t) => {
  const page = await renderDaily(t, { queue: { chips: CHIPS_WITH_TEACH } });
  const sheet = await openSheetOnA(page);
  const foot = byClass(sheet, "odr-fix-foot")[0];
  assert.ok(foot && byClass(foot, "odr-fix-save").length === 1, "ปุ่มบันทึกอยู่ส่วนล่างที่ไม่เลื่อน");
  assert.ok(byClass(sheet, "odr-fix-body")[0], "เนื้อหาอยู่ส่วนที่เลื่อนได้");
  const learn = byClass(sheet, "odr-fix-learn")[0];
  assert.equal(learn.hidden, true, "ยังไม่เลือกอะไร = ยังไม่มีสิ่งที่จะจำ");
  const save = button(sheet, "บันทึกแล้วไปห้องถัดไป");
  typeInto(sheet, "ok");
  assert.equal(save.disabled, true, "คำตอบสั้นอย่างเดียว = บันทึกไม่ได้");
  assert.match(textOf(byClass(sheet, "odr-fix-short")[0]), /พิมพ์คำตอบที่ควรเป็นให้ชัดอีกนิด หรือเลือกเหตุผลก่อนนะคะ/u);
  await click(button(sheet, "ควรบอกราคา"));
  assert.equal(save.disabled, false);
  assert.match(textOf(byClass(sheet, "odr-fix-short")[0]), /คำตอบนี้สั้นไป ลูกแพรจะจำแค่เหตุผลที่เลือก/u);
  assert.equal(textOf(learn), `ลูกแพรจะจำว่า: ${TEACH.tell_price}`);
  typeInto(sheet, "บอกราคา 12,900 บาท พร้อมบอกว่าได้เรียนสด 2 วัน");
  assert.equal(byClass(sheet, "odr-fix-short")[0].hidden, true);
  assert.equal(textOf(learn), `ลูกแพรจะจำว่า: ${TEACH.tell_price} · ในสถานการณ์แบบนี้ควรตอบประมาณว่า: บอกราคา 12,900 บาท พร้อมบอกว่าได้เรียนสด 2 วัน`);

  const off = await renderDaily(t, { queue: { chips: CHIPS_WITH_TEACH }, detail: { "*": { canTeach: false, teachEnabled: false } } });
  const offSheet = await openSheetOnA(off);
  await click(button(offSheet, "ห้วนไป"));
  assert.equal(byClass(offSheet, "odr-fix-learn")[0].hidden, true, "ป้ายอย่างเดียว = ลูกแพรไม่ได้จำอะไร");
});

/* ---------------------------------- ดีที่เหลือทั้งหมด ---------------------------------- */

test("ดีที่เหลือทั้งหมด: นับเฉพาะห้องที่ AI ไม่ชี้จุด ไม่รวมการ์ดบนจอ · บอกห้องจุดเล็กที่ยังต้องดู · หลังสัปดาห์แรกเป็นปุ่มหลัก", async (t) => {
  const items = [
    qItem("A", { label: "good", revision: 1, flagged: true, bulkEligible: false }),
    qItem("D"),
    qItem("E", { issues: [issue("curt_or_robotic", "ห้วน/เหมือนบอท", "normal", "e2", "ห้วน")], issueCount: 1, bulkEligible: false }),
    qItem("F"),
    qItem("G"),
  ];
  const page = await renderDaily(t, { items, queue: { taper: { ...TAPER, dayNumber: 9, inWarmup: false, level: 1, levelLabel: "ห้องน่าห่วง + สุ่ม 20%" } } });
  assert.equal(page.card().attributes["data-item"], "D");
  const bulk = button(page.body, "ดีที่เหลือทั้งหมด (2)");
  assert.equal(hasClass(bulk, "is-quiet"), false, "หลังสัปดาห์แรก = ปุ่มหลัก");
  assert.match(textOf(bulk), /2 ห้องที่ AI อ่านแล้วไม่เจอจุดไหน · ไม่รวมห้องที่เปิดอยู่ · อีก 1 ห้องที่ AI ชี้จุดเล็ก ๆ ยังต้องดูเอง/u);
  await click(bulk);
  await click(button(page.body, "แตะอีกครั้งเพื่อยืนยัน · ดีแล้ว 2 ห้อง"));
  assert.deepEqual(page.posts().map((call) => call.body), [{ exceptId: "D" }]);
  assert.deepEqual(page.server.bulk.sort(), ["F", "G"], "ห้องที่ AI ชี้จุด (E) และการ์ดบนจอ (D) ไม่ถูกติดป้าย");
  assert.equal(page.card().attributes["data-item"], "D", "การ์ดที่อ่านอยู่ไม่หายใต้นิ้ว");
});

/* ---------------------------------- กำลังดูห้องนี้ ---------------------------------- */

test("พี่ง้วง/ชมพู่: ห้องที่อีกคนกำลังดูไม่ขึ้นเป็นการ์ดแรก · เปิดชนกัน = แถบ 'กำลังดูห้องนี้อยู่' + ข้ามไปห้องอื่น (ห้องนั้นไปท้ายกอง)", async (t) => {
  const items = baseItems().map((item) => (item.id === "A" ? { ...item, viewingBy: "พี่ง้วง" } : item));
  const chom = await renderDaily(t, { items, role: "operator" });
  assert.equal(chom.card().attributes["data-item"], "B", "ห้องน่าห่วงที่พี่ง้วงเปิดอยู่ = ชมพู่เริ่มห้องถัดไป");
  assert.deepEqual(chom.claims(), ["B"]);

  const page = await renderDaily(t, {
    handlers: { "POST /console/api/owner-review/daily/items/A/claim": () => ({ ok: true, claimed: false, viewingBy: "ชมพู่" }) },
  });
  await flush();
  assert.equal(page.card().attributes["data-item"], "A");
  const notice = byClass(page.card(), "odr-notice")[0];
  assert.match(textOf(notice), /ชมพู่ กำลังดูห้องนี้อยู่/u);
  assert.equal(button(page.body, "ดีแล้ว ห้องของ สมชาย ใจดี").disabled, false, "ไม่ล็อก — ตรวจต่อเองได้");
  await click(button(notice, "ข้ามไปห้องอื่น"));
  assert.equal(page.card().attributes["data-item"], "B");
  assert.equal(page.posts().length, 0, "ข้ามไม่ใช่การติดป้าย");
  for (const id of ["B", "C", "D", "E"]) {
    assert.equal(page.card().attributes["data-item"], id);
    await click(button(page.body, `ดีแล้ว ห้องของ ลูกค้า ${id}`));
  }
  assert.equal(page.card().attributes["data-item"], "A", "ห้องที่ข้ามรออยู่ท้ายกอง");
});

test("แถวชิปด้านบน: แชทสั้น = ไม่ซ้ำ (ปัญหาอยู่ใต้ฟอง/กล่องทั้งห้อง) · แชทยาว หรือฟองที่ AI ชี้ถูกพับอยู่ = มีแถวชิปไว้กระโดด", async (t) => {
  const short = await renderDaily(t);
  assert.equal(byClass(short.card(), "odr-chips").length, 0, "แชท 4 ฟอง");
  assert.equal(byClass(byClass(short.card(), "odr-room-issues")[0], "odr-issue").length, 1, "ปัญหาทั้งห้องยังอยู่ในกล่องของมัน");
  const long = [];
  for (let i = 1; i <= 36; i += 1) {
    const out = i % 2 === 0;
    long.push({
      id: `L${i}`, ref: `m${i}`, speaker: out ? "ai" : "customer", direction: out ? "out" : "in", msgType: "text", text: `ข้อ ${i}`,
      at: NOW - 3 * HOUR + i * 60_000, proactive: false, inWindow: true, fixable: out, issueKeys: i === 2 ? ["wrong_price@L2"] : [],
    });
  }
  const items = baseItems().map((item) => (item.id === "A"
    ? { ...item, issues: [issue("wrong_price", "ราคาผิด", "high", "L2", "ราคาไม่ตรง")], issueCount: 1 } : item));
  const page = await renderDaily(t, { items, detail: { A: { bubbles: long, unanchoredIssueKeys: [] } } });
  assert.deepEqual(byClass(page.card(), "odr-chip").map(textOf), ["!ราคาผิด"], "ฟองที่ AI ชี้ถูกพับอยู่ = ต้องมีทางลัด");
  await click(button(page.card(), "ราคาผิด — ดูข้อความที่ AI ชี้"));
  assert.ok(hasClass(page.bubble("L2"), "is-flash"), "แตะชิป = กางแชทเก่าแล้วฟองนั้นกะพริบ");
});
