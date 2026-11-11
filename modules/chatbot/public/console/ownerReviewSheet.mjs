// ownerReviewSheet.mjs — ตัวโต้ตอบของห้องตรวจ: แผ่นยืนยันปิด (bottom sheet) · แถบย้อน "ไม่ปิด" 10 วิ · ปัดการ์ด
//
// ทำไมต้องมีแผ่นยืนยันก่อนปิด: คำลาที่ส่งถึงลูกค้าแล้วย้อนไม่ได้ — คนกดต้องเห็นข้อความจริงที่จะส่งก่อนเสมอ
// และเลือก "ปิดเงียบ" ได้ (ห้องเหลืองโดยไม่ส่งอะไร) · "ไม่ปิด" ย้อนได้ 10 วิ จึงไม่ต้องถามซ้ำ
// โมชันใช้ transform/opacity เท่านั้น และเคารพ prefers-reduced-motion (console.css ปิด transition ทั้งหมดอยู่แล้ว)
import { el } from "./dom.mjs";
import { setText } from "./ownerReviewCard.mjs";

export function prefersReducedMotion() {
  try {
    return globalThis.window?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

/** รอให้โมชันจบ (transitionend หรือหมดเวลา) — ลดโมชัน = ไปต่อทันที */
export function afterMotion(node, ms = 240) {
  if (!node || prefersReducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    node.addEventListener?.("transitionend", finish, { once: true });
    node.addEventListener?.("animationend", finish, { once: true });
    setTimeout(finish, ms + 60);
  });
}

/* --------------------------------- แผ่นยืนยันปิด --------------------------------- */

const FOCUSABLE = "button";
/**
 * ปุ่มในแผ่น (ส่งคำลา/ปิดเงียบ) ยังไม่รับการกดจนกว่าแผ่นจะเปิดได้สักพัก (รีวิว 12 ต.ค. ค่ำ):
 * กด Enter สองที / แตะสองที ที่ปุ่ม "ปิดแชท" เคยส่งคำลาโดยไม่ได้อ่านแผ่นเลย — ปุ่มปิดเงียบอยู่ตำแหน่งเดียวกับปิดแชทพอดี
 * มากกว่าโมชันเปิดแผ่น (260ms) + ช่วงแตะสองทีทั่วไป · ไม่ขึ้นกับลดโมชัน (นี่คือเจตนา ไม่ใช่แอนิเมชัน)
 */
export const SHEET_ARM_MS = 450;

/** ปุ่มที่ค้าง Enter/Space ไว้ (key repeat) ต้องไม่กดซ้ำเอง — ห้ามคลิกจากการกดค้าง */
export function blockKeyRepeat(event) {
  if (event?.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault?.();
}

/**
 * host = โหนดว่างในหน้า (แผ่นอยู่ข้างในจนกว่าจะปิด — เปลี่ยนหน้าแล้วหายไปพร้อม mount)
 * armMs = เวลาก่อนปุ่มส่ง/ปิดเงียบรับการกด · onDetachedFail = แจ้งผลผิดพลาดเมื่อแผ่นปิดไปแล้ว (ใช้ toast ทั่วไป)
 * open({ name, goodbyeText, canSend, sendBlockedText, sweepOn, onSend, onSilent, returnFocus })
 */
export function createCloseSheet({ host, armMs = SHEET_ARM_MS, onDetachedFail = null, clock = () => Date.now() }) {
  let current = null;

  // ฉากหลัง/Escape ระหว่างคำขอยังไม่จบ = ไม่ปิด (ปิดแล้วผลผิดพลาดหายไปกับแผ่น — คนกดไม่รู้ว่าคำลาออกไปหรือยัง)
  function dismiss() {
    if (!current || current.busy) return;
    close();
  }

  function onKey(event) {
    if (!current) return;
    // เปลี่ยนหน้าไปแล้ว (mount ทิ้งแผ่นไปพร้อมหน้าเก่า) — ถอดตัวฟังคีย์บอร์ดออก
    if (current.layer.isConnected === false) { close({ restore: false }); return; }
    if (event.key === "Escape") {
      event.preventDefault?.();
      dismiss();
      return;
    }
    if (event.key !== "Tab") return;
    // NodeList ของเบราว์เซอร์ไม่มี .filter — แปลงเป็น array ก่อน
    const buttons = Array.from(current.sheet.querySelectorAll(FOCUSABLE)).filter((node) => !node.disabled && !node.hidden);
    if (!buttons.length) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    const active = globalThis.document?.activeElement;
    if (event.shiftKey && active === first) { event.preventDefault?.(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault?.(); first.focus(); }
  }

  function close({ restore = true } = {}) {
    if (!current) return;
    const { layer, returnFocus } = current;
    current = null;
    globalThis.document?.removeEventListener?.("keydown", onKey);
    layer.classList.add("is-closing");
    afterMotion(layer, 180).then(() => layer.remove());
    if (restore) returnFocus?.focus?.();
  }

  function open({ name, goodbyeText = "", canSend = true, sendBlockedText = "", sweepOn = true, onSend, onSilent, returnFocus = null }) {
    close({ restore: false });
    const error = el("p", { class: "orv-sheet-error", role: "alert" });
    error.hidden = true;
    const sendBtn = el("button", { type: "button", class: "orv-sheet-btn is-close", "aria-describedby": "orv-sheet-warn", onkeydown: blockKeyRepeat }, "ส่งคำลาและปิด");
    const silentBtn = el("button", { type: "button", class: "orv-sheet-btn is-silent", onkeydown: blockKeyRepeat }, "ปิดเงียบ (ไม่ส่งข้อความ)");
    const cancelBtn = el("button", { type: "button", class: "orv-sheet-btn is-cancel", onclick: () => close() }, "ยกเลิก");
    // โฟกัสแรก = หัวแผ่น (ไม่ใช่ปุ่มส่ง) — Enter ครั้งที่สองจากปุ่มปิดแชทต้องไม่ส่งคำลาที่ยังไม่ได้อ่าน
    const title = el("h2", { class: "orv-sheet-title", id: "orv-sheet-title", tabindex: "-1" }, `ปิดแชทของ ${name}`);
    const blocked = el("p", { class: "orv-sheet-blocked" }, sendBlockedText);
    const warn = el("p", { class: "orv-sheet-warn", id: "orv-sheet-warn" }, "ส่งคำลาแล้วย้อนไม่ได้");
    blocked.hidden = canSend || !sendBlockedText;
    const caption = el("figcaption", { class: "orv-goodbye-cap" }, canSend ? "ลูกแพรจะส่งข้อความนี้" : "คำลาที่ส่งไม่ได้ในห้องนี้");
    const goodbye = el("figure", { class: "orv-goodbye" },
      caption,
      el("p", { class: "orv-goodbye-text" }, goodbyeText || "—"),
    );
    const sheet = el("section", {
      class: "orv-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "orv-sheet-title", "aria-describedby": "orv-sheet-desc",
    },
      el("span", { class: "orv-sheet-grab", "aria-hidden": "true" }),
      title,
      el("p", { class: "orv-sheet-desc", id: "orv-sheet-desc" },
        "ห้องจะเป็นสีเหลือง ลูกแพรหยุดตอบห้องนี้ ทีมยังเปิดคุยต่อเองได้เสมอ"),
      goodbye,
      blocked,
      warn,
      error,
      el("div", { class: "orv-sheet-actions" }, sendBtn, silentBtn, cancelBtn),
    );
    const layer = el("div", { class: "orv-sheet-layer" },
      el("div", { class: "orv-scrim", "aria-hidden": "true", onclick: () => dismiss() }),
      sheet,
    );
    const state = { layer, sheet, returnFocus, canSend, sweepOn, blockedText: sendBlockedText, busy: false, armedAt: clock() + Math.max(0, Number(armMs) || 0) };
    current = state;

    function refreshButtons(busy = "") {
      sendBtn.hidden = !state.canSend;
      sendBtn.disabled = Boolean(busy) || !state.sweepOn;
      silentBtn.disabled = Boolean(busy) || !state.sweepOn;
      cancelBtn.disabled = Boolean(busy);
      setText(sendBtn, busy === "send" ? "กำลังส่งคำลา…" : "ส่งคำลาและปิด");
      setText(silentBtn, busy === "silent" ? "กำลังปิด…" : "ปิดเงียบ (ไม่ส่งข้อความ)");
      goodbye.classList.toggle("is-muted", !state.canSend);
      warn.hidden = !state.canSend;
      blocked.hidden = state.canSend || !state.blockedText;
    }
    const run = (kind, handler) => async () => {
      if (current !== state || state.busy || (kind === "send" && sendBtn.disabled) || (kind === "silent" && silentBtn.disabled)) return;
      // ยังไม่ครบเวลาเปิดแผ่น = แตะ/Enter ที่ตามมาจากปุ่มปิดแชท ไม่ใช่การตัดสินใจหลังอ่านคำลา — ไม่ทำอะไร
      if (clock() < state.armedAt) return;
      error.hidden = true;
      state.busy = true;
      refreshButtons(kind);
      try {
        await handler(controller);
      } finally {
        state.busy = false;
        if (current === state) refreshButtons("");
      }
    };
    sendBtn.addEventListener("click", run("send", onSend));
    silentBtn.addEventListener("click", run("silent", onSilent));

    const controller = {
      /** ข้อความผิดพลาดในแผ่น (ไม่ปิดแผ่น) · silentOnly = ส่งคำลาไม่ได้แล้ว เหลือปิดเงียบ/ยกเลิก */
      fail(message, { silentOnly = false, blockAll = false } = {}) {
        // แผ่นปิดไปแล้ว (เปลี่ยนหน้า ฯลฯ) — ผลผิดพลาดต้องไม่เงียบหาย: แจ้งผ่าน toast ทั่วไปของคอนโซล
        if (current !== state) { onDetachedFail?.(message || "ทำรายการไม่สำเร็จ ลองอีกครั้งนะคะ"); return; }
        if (silentOnly) {
          state.canSend = false;
          setText(caption, "คำลาที่ส่งไม่ได้ในห้องนี้");
          state.blockedText = "";
        }
        if (blockAll) state.sweepOn = false;
        setText(error, message || "ทำรายการไม่สำเร็จ ลองอีกครั้งนะคะ");
        error.hidden = false;
        // ปุ่มที่เหลือเปลี่ยนความหมาย (ส่ง → ปิดเงียบ) — ให้อ่านข้อความผิดพลาดก่อน: โฟกัสหัวแผ่น + ตั้งเวลารับการกดใหม่
        state.armedAt = clock() + Math.max(0, Number(armMs) || 0);
        refreshButtons("");
        title.focus?.();
      },
      close,
    };

    if (!sweepOn) {
      setText(error, "ตัวคัดกรองรายชั่วโมงปิดอยู่ จึงปิดห้องเป็นสีเหลืองไม่ได้ตอนนี้ (ยังไม่ส่งอะไรถึงลูกค้า)");
      error.hidden = false;
    }
    refreshButtons("");
    host.replaceChildren(layer);
    globalThis.document?.addEventListener?.("keydown", onKey);
    title.focus?.();
    return controller;
  }

  return { open, close, isOpen: () => Boolean(current), isBusy: () => current?.busy === true };
}

/* ------------------------------ แถบย้อน "ไม่ปิด" ------------------------------ */

export const KEEP_REASONS = Object.freeze(["เป็นลูกค้าจริง", "ถามเรื่องคลาสอยู่", "ให้ทีมดูเอง"]);
// เผื่อเวลาเดินทางของคำขอ — แถบหายก่อนเซิร์ฟเวอร์ปิดหน้าต่าง 10 วิ ไม่ให้กดย้อนแล้วได้ "เลยเวลา"
const UNDO_MARGIN_MS = 900;

/**
 * แถบย้อนแบบบรรทัดเดียว อยู่ "ในแถบปุ่มล่าง" (ไม่ลอยทับการ์ด) — รีวิว 12 ต.ค. ค่ำ: แถบเดิมสูง 136px ลอยทับ
 * ข้อความล่าสุดของห้องถัดไปเกือบ 10 วิ (บรรทัดที่ตัดสินเคส) และทับแผ่นยืนยันปิดจนแตะผิดห้อง
 * ชิปเหตุผลซ่อนหลังปุ่ม "เหตุผล" (กางเมื่อแตะเท่านั้น)
 * show({ name, undoMs, onUndo, onReason }) → แถบสถานะ "กำลังบันทึก" จนกว่า ready()
 * ready() = เซิร์ฟเวอร์รับแล้ว เริ่มนับถอยหลัง · failed() · hide()
 * คิวตรวจแชท (เฟส B) ใช้แถบเดียวกัน: title/readyText/undoLabel แทนคำของ "ไม่ปิด" · reasons [] = ไม่มีปุ่มเหตุผล
 */
export function createUndoToast({ host }) {
  let current = null;
  let seq = 0;

  function hide() {
    if (!current) return;
    const { node, timers } = current;
    current = null;
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    node.classList.remove("is-shown");
    afterMotion(node, 200).then(() => node.remove());
  }

  function show({
    name, undoMs = 10_000, onUndo, onReason,
    title: titleText = `ไม่ปิด ${name}`, readyText = "จะไม่ถูกเสนอซ้ำ 30 วัน", undoLabel = `ย้อน ไม่ปิดห้อง ${name}`,
    reasons: reasonList = KEEP_REASONS,
  }) {
    hide();
    seq += 1;
    const reasonsId = `orv-undo-reasons-${seq}`;
    const title = el("span", { class: "orv-undo-title" }, titleText);
    const sub = el("span", { class: "orv-undo-sub" }, "กำลังบันทึก…");
    const count = el("span", { class: "orv-undo-count", "aria-hidden": "true" });
    const undoBtn = el("button", { type: "button", class: "orv-undo-btn", "aria-label": undoLabel, onkeydown: blockKeyRepeat },
      el("span", {}, "ย้อน"), count);
    undoBtn.disabled = true;
    const whyBtn = el("button", {
      type: "button", class: "orv-undo-why", "aria-expanded": "false", "aria-controls": reasonsId,
      "aria-label": `ใส่เหตุผลที่ไม่ปิดห้อง ${name} (ไม่บังคับ)`,
    }, "เหตุผล");
    whyBtn.disabled = true;
    whyBtn.hidden = reasonList.length === 0;
    const reasons = el("div", { class: "orv-undo-reasons", id: reasonsId, role: "group", "aria-label": "เหตุที่ไม่ปิด (ไม่บังคับ)" });
    reasons.hidden = true;
    const setExpanded = (open) => {
      reasons.hidden = !open;
      whyBtn.setAttribute("aria-expanded", open ? "true" : "false");
      whyBtn.classList.toggle("is-open", open);
    };
    whyBtn.addEventListener("click", () => {
      if (!current || whyBtn.disabled) return;
      setExpanded(reasons.hidden);
      if (!reasons.hidden) chips[0]?.focus?.();
    });
    const chips = reasonList.map((reason) => {
      const chip = el("button", { type: "button", class: "orv-reason-chip", "aria-pressed": "false" }, reason);
      chip.disabled = true;
      chip.addEventListener("click", async () => {
        if (!current || chip.disabled) return;
        for (const other of chips) other.disabled = true;
        const ok = await onReason?.(reason);
        if (!current) return;
        if (ok) {
          chip.setAttribute("aria-pressed", "true");
          chip.classList.add("is-picked");
          setText(sub, `จำไว้แล้ว: ${reason}`);
          setExpanded(false);
          whyBtn.hidden = true;
          undoBtn.focus?.();
        } else {
          for (const other of chips) other.disabled = false;
        }
      });
      return chip;
    });
    reasons.append(...chips);
    const bar = el("span", { class: "orv-undo-bar", "aria-hidden": "true" });
    const node = el("div", { class: "orv-undo", role: "status", "aria-live": "polite" },
      el("div", { class: "orv-undo-row" }, el("p", { class: "orv-undo-copy" }, title, sub), whyBtn, undoBtn),
      reasons,
      bar,
    );
    undoBtn.addEventListener("click", async () => {
      if (!current || undoBtn.disabled) return;
      undoBtn.disabled = true;
      whyBtn.disabled = true;
      for (const chip of chips) chip.disabled = true;
      const ok = await onUndo?.();
      if (ok) hide();
      else if (current) { undoBtn.disabled = false; whyBtn.disabled = false; for (const chip of chips) chip.disabled = false; }
    });
    const state = { node, timers: new Set() };
    current = state;
    host.replaceChildren(node);
    // เฟรมถัดไปค่อยใส่ is-shown ให้โมชันเลื่อนขึ้นทำงาน (ใส่ทันที = เบราว์เซอร์ข้ามสถานะเริ่มต้น)
    const raf = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    raf(() => { if (current === state) node.classList.add("is-shown"); });

    return {
      ready() {
        if (current !== state) return;
        const total = Math.max(1000, Number(undoMs) - UNDO_MARGIN_MS);
        const endAt = Date.now() + total;
        setText(sub, readyText);
        undoBtn.disabled = false;
        whyBtn.disabled = false;
        for (const chip of chips) chip.disabled = false;
        bar.style.setProperty("--orv-undo-ms", `${total}ms`);
        raf(() => { if (current === state) bar.classList.add("is-running"); });
        const tick = () => setText(count, ` ${Math.max(0, Math.ceil((endAt - Date.now()) / 1000))}`);
        tick();
        state.timers.add(setInterval(tick, 1000));
        state.timers.add(setTimeout(() => { if (current === state) hide(); }, total));
      },
      failed() { if (current === state) hide(); },
      isCurrent: () => current === state,
    };
  }

  return { show, hide, isShown: () => Boolean(current) };
}

/* ---------------------------------- ปัดการ์ด ---------------------------------- */

const SWIPE_COMMIT_PX = 96;
const SWIPE_LOCK_PX = 10;

function setSwipe(card, dx) {
  card.style.setProperty("--swipe-x", `${dx}px`);
  card.style.setProperty("--swipe-r", `${(dx / 26).toFixed(2)}deg`);
  card.style.setProperty("--swipe-keep", String(Math.min(1, Math.max(0, dx / SWIPE_COMMIT_PX)).toFixed(2)));
  card.style.setProperty("--swipe-close", String(Math.min(1, Math.max(0, -dx / SWIPE_COMMIT_PX)).toFixed(2)));
}

export function resetSwipe(card) {
  for (const key of ["--swipe-x", "--swipe-r", "--swipe-keep", "--swipe-close"]) card.style.removeProperty(key);
}

/**
 * ปัดขวา = ไม่ปิด · ปัดซ้าย = เปิดแผ่นยืนยันปิด (ปุ่มยังเป็นทางหลักเสมอ — การปัดเป็นทางลัด)
 * แตะ/เลื่อนแนวตั้งต้องไม่ถูกกิน: ล็อกแกนหลังขยับเกิน 10px และ CSS ใส่ touch-action: pan-y
 */
export function attachSwipe(card, { onKeep, onClose, isLocked = () => false }) {
  let start = null;
  let axis = "";
  let dx = 0;
  card.addEventListener("pointerdown", (event) => {
    if (isLocked() || (event.button !== undefined && event.button !== 0) || event.pointerType === "mouse") return;
    if (event.target?.closest?.("button, a, summary, input, textarea")) return;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    axis = "";
    dx = 0;
  });
  card.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const mx = event.clientX - start.x;
    const my = event.clientY - start.y;
    if (!axis) {
      if (Math.abs(mx) < SWIPE_LOCK_PX && Math.abs(my) < SWIPE_LOCK_PX) return;
      axis = Math.abs(mx) > Math.abs(my) * 1.2 ? "x" : "y";
      if (axis === "x") {
        card.classList.add("is-dragging");
        try { card.setPointerCapture?.(event.pointerId); } catch { /* บางเครื่องไม่รองรับ */ }
      }
    }
    if (axis !== "x") return;
    dx = mx;
    setSwipe(card, dx);
  });
  const finish = (event, cancelled = false) => {
    if (!start || event.pointerId !== start.id) return;
    const horizontal = axis === "x";
    start = null;
    axis = "";
    card.classList.remove("is-dragging");
    if (!horizontal) return;
    // onKeep คืน false = ไม่ได้ตัดสิน (ยังไม่พร้อม/กำลังส่ง) → คืนการ์ดกลับที่เดิม ไม่ค้างนอกจอ
    if (!cancelled && dx >= SWIPE_COMMIT_PX) { if (onKeep?.() === false) resetSwipe(card); return; }
    resetSwipe(card);
    if (!cancelled && dx <= -SWIPE_COMMIT_PX) onClose?.();
  };
  card.addEventListener("pointerup", (event) => finish(event));
  card.addEventListener("pointercancel", (event) => finish(event, true));
}
