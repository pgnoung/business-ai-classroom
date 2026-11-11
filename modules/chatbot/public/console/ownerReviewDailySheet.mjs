// ownerReviewDailySheet.mjs — แผ่น "ต้องปรับ" ของคิวตรวจแชท (#/owner-review/daily · เฟส B · 12 ต.ค. 2026)
//
// ต้องปรับ → แตะฟองของลูกแพรที่ผิด → แผ่นล่าง: ชิปเหตุผลแบบแตะ (ห้วนไป · ไม่ตอบคำถาม · ควรบอกราคา · …) + "ควรตอบว่า…"
//   บันทึก = บทเรียนของลูกแพร (ของเจ้าของใช้ทันที · ของทีมรอพี่ง้วงอนุมัติ — แผ่นบอกตรง ๆ ก่อนกด) แล้วไปห้องถัดไป
// ใช้โครงแผ่นเดียวกับแผ่นยืนยันปิดของเฟส A (.orv-sheet-layer/.orv-sheet) · ทุกโหนดผ่าน el() · ข้อความลูกค้าเป็น text node
// ปุ่มบันทึกรอ SHEET_ARM_MS หลังเปิดแผ่น — การแตะสองทีที่ฟองต้องไม่บันทึกแผ่นที่ยังไม่ได้อ่าน
// รีวิว 13 ต.ค. (iPhone):
//   · ร่างไม่หาย: ชิป/ข้อความที่พิมพ์ส่งกลับให้ตัวคุมเก็บต่อฟอง (onDraft) เปิดใหม่ได้ของเดิม · แตะพื้นหลังตอนพิมพ์ = เก็บคีย์บอร์ด ไม่ปิดแผ่น
//   · ปุ่มบันทึกอยู่ในส่วนล่างที่ไม่เลื่อน + แผ่นสูงตามส่วนที่มองเห็นจริง (คีย์บอร์ดขึ้นแล้วปุ่มไม่จม)
//   · บรรทัด "ลูกแพรจะจำว่า: …" ก่อนกดบันทึก (สร้างแบบเดียวกับ composeFixLesson ของเซิร์ฟเวอร์)
import { el, fmtTime } from "./dom.mjs";
import { setText } from "./ownerReviewCard.mjs";
import { SHEET_ARM_MS, afterMotion, blockKeyRepeat } from "./ownerReviewSheet.mjs";
import { followVisualViewport } from "./ownerReviewDailyScroll.mjs";

// fake DOM ของเทสต์แยกตัวเลือกด้วยช่องว่าง — ห้ามมีช่องว่างหลังจุลภาค
const FOCUSABLE = "button,textarea";
// เกณฑ์เดียวกับเซิร์ฟเวอร์ (meaningfulBetterReply — ส่งมาใน GET /daily เป็น betterReplyMin)
export const BETTER_REPLY_MIN = 6;
const MEANINGFUL_CHAR_RE = /[\p{L}\p{N}]/gu;
const REPLY_PREFIX = "ในสถานการณ์แบบนี้ควรตอบประมาณว่า: ";

/** โน้ตป้าย "ต้องปรับ" แบบไม่สร้างบทเรียน (ระบบสอนปิด/บัญชีสอนไม่ได้/ไม่ระบุฟอง) — ไม่เกิน max ตัวอักษร */
export function fixNote(chipLabels = [], betterReply = "", max = 500) {
  const reply = String(betterReply || "").replace(/\s+/gu, " ").trim();
  const text = [chipLabels.filter(Boolean).join(" · "), reply ? `ควรตอบว่า: ${reply}` : ""].filter(Boolean).join(" — ");
  return Array.from(text).slice(0, max).join("");
}

/** "ควรตอบว่า…" ที่ยาวพอเป็นบทเรียน (ตัวอักษร/ตัวเลข ≥ min) → ข้อความที่ล้างแล้ว · "" = สั้น/ว่างเกินไป */
export function usableReply(value, min = BETTER_REPLY_MIN) {
  const reply = String(value || "").replace(/\s+/gu, " ").trim();
  return (reply.match(MEANINGFUL_CHAR_RE) || []).length >= min ? reply : "";
}

/** สิ่งที่ลูกแพรจะจำ (pure) — ลำดับชิปตามรายการของเซิร์ฟเวอร์ แล้วตามด้วยคำตอบที่ควรเป็น */
export function lessonPreview(chips = [], pickedKeys = [], betterReply = "", min = BETTER_REPLY_MIN) {
  const picked = new Set(pickedKeys);
  const parts = chips.filter((chip) => picked.has(chip.key) && chip.teach).map((chip) => String(chip.teach));
  const reply = usableReply(betterReply, min);
  if (reply) parts.push(`${REPLY_PREFIX}${reply}`);
  return parts.join(" · ");
}

/**
 * host = โหนดว่างในหน้า · armMs = เวลาก่อนปุ่มบันทึกรับการกด
 * open({ name, bubble, chips, max, copy, aiNotes, onSave, returnFocus }) → controller { fail, close }
 *   bubble = ฟองที่แตะ (null = ทั้งห้อง) · copy = บรรทัดบอกว่าบันทึกแล้วจะเกิดอะไร (ใช้ทันที/รออนุมัติ/ป้ายอย่างเดียว)
 *   onSave(controller, { chips: string[], chipLabels: string[], betterReply })
 */
export function createFixSheet({ host, armMs = SHEET_ARM_MS, clock = () => Date.now() }) {
  let current = null;

  function dismiss() {
    if (!current || current.busy) return;
    close();
  }

  function onKey(event) {
    if (!current) return;
    if (current.layer.isConnected === false) { close({ restore: false }); return; }
    if (event.key === "Escape") { event.preventDefault?.(); dismiss(); return; }
    if (event.key !== "Tab") return;
    const nodes = Array.from(current.sheet.querySelectorAll(FOCUSABLE)).filter((node) => !node.disabled && !node.hidden);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = globalThis.document?.activeElement;
    if (event.shiftKey && active === first) { event.preventDefault?.(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault?.(); first.focus(); }
  }

  function close({ restore = true } = {}) {
    if (!current) return;
    const { layer, returnFocus, unfollow } = current;
    current = null;
    unfollow?.();
    globalThis.document?.removeEventListener?.("keydown", onKey);
    layer.classList.add("is-closing");
    afterMotion(layer, 180).then(() => layer.remove());
    if (restore) returnFocus?.focus?.();
  }

  function open({
    name, bubble = null, chips = [], max = 500, min = BETTER_REPLY_MIN, copy = "", aiNotes = [], preview = false,
    draft = null, onDraft = null, onSave, returnFocus = null,
  }) {
    close({ restore: false });
    const picked = new Set((Array.isArray(draft?.chips) ? draft.chips : []).filter((key) => chips.some((chip) => chip.key === key)));
    const error = el("p", { class: "orv-sheet-error", role: "alert" });
    error.hidden = true;
    const title = el("h2", { class: "orv-sheet-title", id: "odr-fix-title", tabindex: "-1" },
      bubble ? "ข้อความนี้ควรปรับยังไง" : `ห้องของ ${name} ต้องปรับตรงไหน`);
    const quote = bubble
      ? el("figure", { class: "orv-goodbye odr-fix-quote" },
          el("figcaption", { class: "orv-goodbye-cap" }, `ลูกแพรตอบ ${name}${bubble.at ? ` · ${fmtTime(bubble.at)}` : ""}`),
          el("p", { class: "orv-goodbye-text" }, String(bubble.text || "")))
      : null;
    const notes = aiNotes.length
      ? el("p", { class: "odr-fix-ai" }, `AI ชี้ไว้: ${aiNotes.join(" · ")}`)
      : null;
    const chipButtons = chips.map((chip) => {
      const on = picked.has(chip.key);
      const button = el("button", {
        type: "button", class: `odr-fix-chip${on ? " is-on" : ""}`, "aria-pressed": on ? "true" : "false", "data-chip": chip.key,
      }, chip.label);
      button.addEventListener("click", () => {
        if (!current || current.busy) return;
        const next = !picked.has(chip.key);
        if (next) picked.add(chip.key); else picked.delete(chip.key);
        button.setAttribute("aria-pressed", next ? "true" : "false");
        button.classList.toggle("is-on", next);
        refresh();
      });
      return button;
    });
    const textarea = el("textarea", {
      class: "odr-fix-text", id: "odr-fix-text", rows: "3", maxlength: String(max),
      placeholder: "ควรตอบว่า… (ไม่บังคับ)", "aria-describedby": "odr-fix-count",
    });
    textarea.value = String(draft?.text || "");
    const counter = el("span", { class: "odr-fix-count", id: "odr-fix-count" }, `0/${max}`);
    const short = el("p", { class: "odr-fix-short", role: "status" });
    short.hidden = true;
    const learn = el("p", { class: "odr-fix-learn" });
    learn.hidden = true;
    const saveBtn = el("button", { type: "button", class: "orv-sheet-btn odr-fix-save", onkeydown: blockKeyRepeat }, "บันทึกแล้วไปห้องถัดไป");
    const cancelBtn = el("button", { type: "button", class: "orv-sheet-btn is-cancel", onclick: () => close() }, "ยกเลิก");
    // ส่วนบนเลื่อนได้ · ส่วนล่าง (สิ่งที่ลูกแพรจะจำ + ปุ่ม) อยู่กับที่เสมอ
    const sheet = el("section", { class: "orv-sheet odr-fix", role: "dialog", "aria-modal": "true", "aria-labelledby": "odr-fix-title" },
      el("span", { class: "orv-sheet-grab", "aria-hidden": "true" }),
      el("div", { class: "odr-fix-body" },
        title,
        quote,
        notes,
        el("fieldset", { class: "odr-fix-chips" },
          el("legend", { class: "odr-fix-legend" }, "เลือกเหตุผล (เลือกได้หลายข้อ)"),
          el("div", { class: "odr-fix-chip-row" }, chipButtons)),
        el("label", { class: "odr-fix-label", for: "odr-fix-text" }, el("span", {}, "ควรตอบว่า…"), counter),
        textarea,
        short,
        copy ? el("p", { class: "odr-fix-copy" }, copy) : null),
      el("div", { class: "odr-fix-foot" },
        learn,
        error,
        el("div", { class: "orv-sheet-actions odr-fix-actions" }, cancelBtn, saveBtn)),
    );
    const scrim = el("div", { class: "orv-scrim", "aria-hidden": "true", onclick: () => scrimTap() });
    const layer = el("div", { class: "orv-sheet-layer" }, scrim, sheet);
    const state = {
      layer, sheet, returnFocus, busy: false, armedAt: clock() + Math.max(0, Number(armMs) || 0), unfollow: () => {},
    };
    current = state;

    const replyText = () => String(textarea.value || "");
    const dirty = () => picked.size > 0 || replyText().trim() !== "";
    // แตะพื้นหลัง: กำลังพิมพ์ = เก็บคีย์บอร์ด · มีร่าง = ไม่ปิด (กันนิ้วพลาด) · ว่าง = ปิด
    function scrimTap() {
      if (!current || current.busy) return;
      if (globalThis.document?.activeElement === textarea) { textarea.blur?.(); return; }
      if (dirty()) return;
      close();
    }
    function refresh(busy = false) {
      const length = Array.from(replyText()).length;
      setText(counter, `${length}/${max}`);
      const reply = usableReply(replyText(), min);
      const typedShort = replyText().trim() !== "" && !reply;
      const empty = picked.size === 0 && !reply;
      saveBtn.disabled = busy || empty || length > max;
      cancelBtn.disabled = busy;
      textarea.disabled = busy;
      for (const chip of chipButtons) chip.disabled = busy;
      setText(saveBtn, busy ? "กำลังบันทึก…" : "บันทึกแล้วไปห้องถัดไป");
      short.hidden = !typedShort;
      setText(short, typedShort
        ? picked.size ? "คำตอบนี้สั้นไป ลูกแพรจะจำแค่เหตุผลที่เลือก" : "พิมพ์คำตอบที่ควรเป็นให้ชัดอีกนิด หรือเลือกเหตุผลก่อนนะคะ"
        : "");
      const lesson = preview ? lessonPreview(chips, [...picked], replyText(), min) : "";
      learn.hidden = !lesson;
      learn.replaceChildren(...(lesson ? [el("strong", {}, "ลูกแพรจะจำว่า: "), lesson] : []));
      onDraft?.({ chips: chips.filter((chip) => picked.has(chip.key)).map((chip) => chip.key), text: replyText() });
    }
    textarea.addEventListener("input", () => refresh());
    saveBtn.addEventListener("click", async () => {
      if (current !== state || state.busy || saveBtn.disabled) return;
      if (clock() < state.armedAt) return;
      error.hidden = true;
      state.busy = true;
      refresh(true);
      const keys = chips.filter((chip) => picked.has(chip.key));
      try {
        await onSave?.(controller, { chips: keys.map((chip) => chip.key), chipLabels: keys.map((chip) => chip.label), betterReply: replyText() });
      } finally {
        state.busy = false;
        if (current === state) refresh(false);
      }
    });

    const controller = {
      /** ข้อความผิดพลาดในแผ่น (ไม่ปิดแผ่น — สิ่งที่พิมพ์ไว้ยังอยู่) */
      fail(message) {
        if (current !== state) return;
        setText(error, message || "บันทึกไม่สำเร็จ ลองอีกครั้งนะคะ");
        error.hidden = false;
        state.armedAt = clock() + Math.max(0, Number(armMs) || 0);
        title.focus?.();
      },
      close,
    };

    refresh(false);
    host.replaceChildren(layer);
    state.unfollow = followVisualViewport(layer);
    globalThis.document?.addEventListener?.("keydown", onKey);
    title.focus?.();
    return controller;
  }

  return { open, close, isOpen: () => Boolean(current), isBusy: () => current?.busy === true };
}
