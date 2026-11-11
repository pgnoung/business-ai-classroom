// ownerReviewDaily.mjs — แท็บ "ตรวจแชทวันนี้" (#/owner-review/daily · เฟส B · คำสั่งพี่ง้วง 12 ต.ค. 2026)
//
// ทุกคืน 20:00 ระบบรวมแชททุกห้องที่ลูกแพรตอบในวันนั้น (AI อ่านก่อน ชี้จุดน่าห่วง) → พี่ง้วง/ชมพู่ตรวจทีละห้องบน iPhone
//   ✅ ดีแล้ว  → ไปห้องถัดไปทันที (ไม่รอเซิร์ฟเวอร์) + แถบย้อน 10 วิ ด้านบน · ปัดการ์ดไปทางขวา = ดีแล้ว
//   ✏️ ต้องปรับ → แตะฟองของลูกแพรที่ผิด → แผ่นล่าง (ชิปเหตุผล + ควรตอบว่า…) → บทเรียนของลูกแพร → ห้องถัดไป
//   ดีที่เหลือทั้งหมด (N) โผล่เมื่อห้องน่าห่วงตรวจครบ · ตรวจครบ = หน้าสรุป + ขอบคุณ · วันที่ยังค้างเป็นชิป (เก็บ 7 วัน)
// ตัวคุมนี้ถือสถานะของคิวหนึ่งรอบ — หน้าตาอยู่ใน ownerReviewDailyCard.mjs · แผ่นต้องปรับอยู่ใน ownerReviewDailySheet.mjs
// ทุกโหนดผ่าน el() (ไม่มี innerHTML) · ข้อความแชทมาจากเซิร์ฟเวอร์แบบปิดชื่อ/เบอร์แล้ว · ไม่เก็บแชทไว้ในเบราว์เซอร์
// รีวิว 13 ต.ค. (iPhone): แถบความคืบหน้าบางติดขอบบน · ห้องถัดไปเลื่อนมาอยู่ใต้แถบ (ไม่เด้งกลับบนสุด) · ต้องปรับไม่ทำจอกระโดด ·
//   ดีที่เหลือทั้งหมดต้องแตะยืนยัน ไม่รวมห้องที่ AI ชี้จุดและการ์ดที่เปิดอยู่ · พี่ง้วง/ชมพู่ไม่เปิดห้องเดียวกันพร้อมกัน ("กำลังดู")
import { el } from "./dom.mjs";
import { createProgress, setText } from "./ownerReviewCard.mjs";
import { SHEET_ARM_MS, afterMotion, attachSwipe, blockKeyRepeat, createUndoToast, prefersReducedMotion } from "./ownerReviewSheet.mjs";
import {
  DAILY_RECENT_BUBBLES, backlogChips, buildingBanner, dailyCard, dailyHref, doneScreen, errorScreen, nameOf, noBatchScreen,
  riskTone, statusBar, taperPanel,
} from "./ownerReviewDailyCard.mjs";
import { createFixSheet, fixNote } from "./ownerReviewDailySheet.mjs";
import { captureAnchor, restoreAnchor, scrollUnderBar } from "./ownerReviewDailyScroll.mjs";
import {
  DAILY_BASE, applyDailyMeta, applyDailyQueue, bulkScope, currentItem, dailyBatchFromHash, dailyBatchPath, dailyCounts, dailyItemPath,
  dailyItems, dailyQueuePath, deferCurrent, draftKey, dropDailyItem, fixCopy, fixDoneText, labelWord, lessonsCreated, mergeDailyItem,
  newDailyView, preferUnclaimed, returnToDeck,
} from "./ownerReviewDailyState.mjs";

export { dailyBatchFromHash, dailyQueuePath } from "./ownerReviewDailyState.mjs";

// การ์ดใหม่เพิ่งขึ้น = ยังไม่มีใครอ่านทัน — แตะสองทีที่ "ดีแล้ว" ต้องไม่ติดป้ายห้องถัดไปที่ยังไม่เห็น (เหมือนเฟส A)
export const DAILY_CARD_ARM_MS = 350;
// ดูป้ายที่คนอื่นกด (พี่ง้วงกับชมพู่ตรวจพร้อมกัน) · คิวว่าง/รอคิวใหม่ดูห่างขึ้น — คำตอบนี้ไม่มีข้อความแชท
const SYNC_MS = 30_000;
const IDLE_SYNC_MS = 60_000;
const FLASH_MS = 1_600;
// "ดีที่เหลือทั้งหมด" แตะครั้งแรก = ขอยืนยัน · แตะอีกครั้งภายในเวลานี้ = ติดป้ายจริง
export const BULK_CONFIRM_MS = 4_000;
// ต่ออายุ "กำลังดูห้องนี้" (เซิร์ฟเวอร์เก็บ 3 นาที) เมื่อการ์ดยังเปิดอยู่นานเกินนี้
const CLAIM_RENEW_MS = 60_000;
const onDailyTab = () => String(globalThis.location?.hash || "").startsWith("#/owner-review/daily");

/**
 * สร้างแท็บรายวันหนึ่งครั้งต่อการเปิดหน้า — ownerReview.mjs วาง content/overlay ลงหน้าแล้วเรียก start(queue)
 * onWaiting(count) = ห้องที่ยังไม่ติดป้าย (ตัวเลขบนแท็บ) · armMs = เวลาก่อนการ์ด/แผ่นรับการกด (เทสต์ส่ง 0)
 */
export function createDailyReview({ api, toast, state, stopPolling, armMs = null, onWaiting = () => {} }) {
  const cardArmMs = armMs ?? DAILY_CARD_ARM_MS;
  const sheetArmMs = armMs ?? SHEET_ARM_MS;
  let alive = true;
  let view = null;
  let flashTimer = null;

  /* ---------------------------------- โหนดของแท็บ ---------------------------------- */

  // แถบความคืบหน้า (ติดขอบบน) + แผงรายละเอียดที่กางจากแถบ · ชื่อวันโผล่เฉพาะตอนดูวันที่ค้าง (คิวล่าสุดไม่ต้องบอก)
  const barHost = el("div", { class: "odr-bar-host" });
  const panelHost = el("div", { class: "odr-panel-host" });
  const bannerHost = el("div", { class: "odr-banner-host" });
  const progress = createProgress({ format: (done, total) => `${view?.requested && view?.batch?.dayLabel ? `${view.batch.dayLabel} · ` : ""}ตรวจแล้ว ${done} / ${total}` });
  progress.node.classList.add("odr-progress");
  const bulkHost = el("div", { class: "odr-bulk-host" });
  const hint = el("p", { class: "orv-swipe-hint" }, "ปัดขวา = ดีแล้ว · ปัดซ้าย = ต้องปรับ");
  const stack = el("div", { class: "orv-stack" });
  const fixBtn = el("button", { type: "button", class: "orv-act odr-act is-fix", onclick: () => startPick(), onkeydown: blockKeyRepeat },
    el("span", { class: "odr-act-ico", "aria-hidden": "true" }, "✏️"), el("span", {}, "ต้องปรับ"));
  const goodBtn = el("button", { type: "button", class: "orv-act odr-act is-good", onclick: () => labelGood(), onkeydown: blockKeyRepeat },
    el("span", { class: "odr-act-ico", "aria-hidden": "true" }, "✅"), el("span", {}, "ดีแล้ว"));
  const thumbBtns = el("div", { class: "orv-thumb-btns", role: "group", "aria-label": "ตรวจห้องนี้" }, fixBtn, goodBtn);
  const cancelPickBtn = el("button", { type: "button", class: "orv-act odr-act is-cancel", onclick: () => cancelPick() }, "ยกเลิก");
  const wholeRoomBtn = el("button", { type: "button", class: "orv-act odr-act is-room", onclick: () => openFix(null) }, "ไม่ระบุข้อความ");
  const pickBtns = el("div", { class: "orv-thumb-btns odr-pick-btns", role: "group", "aria-label": "เลือกข้อความที่ต้องปรับ" }, cancelPickBtn, wholeRoomBtn);
  pickBtns.hidden = true;
  const toastHost = el("div", { class: "orv-toast-host" });
  const thumb = el("div", { class: "orv-thumb odr-thumb" }, toastHost, thumbBtns, pickBtns);
  const sheetHost = el("div", { class: "orv-sheet-host" });
  const live = el("p", { class: "orv-sr", role: "status", "aria-live": "polite" });
  const fixSheet = createFixSheet({ host: sheetHost, armMs: sheetArmMs });
  const undo = createUndoToast({ host: toastHost });

  /* ---------------------------------- สถานะคิว ---------------------------------- */

  const current = () => currentItem(view);
  const counts = () => dailyCounts(dailyItems(view));
  const detailReady = (item) => Boolean(item) && view?.detailState.get(item.id) === "ready";
  const cardSettled = () => Date.now() - (view?.shownAt || 0) >= cardArmMs;
  // ห้องที่คนอื่นเพิ่งติดป้าย (แถบ "ตรวจห้องนี้แล้ว") กดซ้ำไม่ได้ — ไปห้องถัดไปจากปุ่มในแถบ
  const canAct = () => Boolean(view) && !view.busy && !fixSheet.isOpen() && cardSettled() && detailReady(current()) && !current()?.label;
  const adopt = (queue) => { view = newDailyView(queue, { requested: dailyBatchFromHash(globalThis.location?.hash) }); };

  /** ผลของห้องจากเซิร์ฟเวอร์ — คนอื่นติดป้ายห้องที่ดูอยู่ = แถบบอก + ปุ่มไปต่อ (ห้ามการ์ดหายใต้นิ้ว) */
  function mergeServerItem(fresh) {
    const result = mergeDailyItem(view, fresh);
    if (result === "current") {
      view.notice = {
        id: fresh.id, tone: "info", text: `${fresh.labelledByName || "ทีม"} ตรวจห้องนี้แล้ว: ${labelWord(fresh.label)}`,
        action: { label: "ไปห้องถัดไป", onClick: () => skipCurrent() },
      };
    }
    return result;
  }

  /* ---------------------------------- วาดส่วนหัว ---------------------------------- */

  function renderStats() {
    if (!view?.batch) { barHost.replaceChildren(); panelHost.replaceChildren(); return; }
    // หน้าตรวจครบมีชิปวันค้างของตัวเองแล้ว — แถบไม่ซ้ำ
    barHost.replaceChildren(statusBar({
      progressNode: progress.node, taper: view.taper, backlog: current() ? view.backlog : [], viewingOld: Boolean(view.requested) && Boolean(current()),
      open: view.taperOpen,
      onToggle: () => { view.taperOpen = !view.taperOpen; renderStats(); },
    }));
    panelHost.replaceChildren(...(view.taperOpen && view.taper
      ? [taperPanel(view.taper, { canPin: view.canPin, busy: view.pinBusy, onPin: (value) => pin(value), codes: view.codes, backlog: view.backlog })]
      : []));
  }

  function bannerNode() {
    if (view?.newBatch) {
      return el("button", { type: "button", class: "odr-newbatch", onclick: () => openLatest() },
        el("strong", {}, `คิวของ ${view.newBatch.dayLabel || "วันนี้"} พร้อมแล้ว`), el("span", {}, "แตะเพื่อเปิด ›"));
    }
    // กำลังเตรียมคิวใหม่ระหว่างที่ดูคิวเก่าอยู่ (ไม่มีคิวพร้อมเลย = หน้าสถานะในกองแทน)
    return view?.batch && view.building && view.building.batchId !== view.batch.id ? buildingBanner(view.building) : null;
  }

  // ห้องปกติที่ AI ไม่ชี้จุดใด ไม่รวมการ์ดที่เปิดอยู่ · แตะครั้งแรก = ขอยืนยัน · สัปดาห์แรก (ตั้งใจตรวจทุกห้อง) เป็นปุ่มรอง
  function renderBulk() {
    const c = counts();
    const scope = bulkScope(view);
    const show = Boolean(view?.batch) && current() && c.flaggedRemaining === 0 && scope.count > 0 && !view.picking;
    if (!show) {
      bulkHost.replaceChildren();
      if (view) view.bulkArmedUntil = 0;
      return;
    }
    const armed = view.bulkArmedUntil > Date.now();
    const warmup = view.taper?.inWarmup === true || Number(view.taper?.dayNumber) === 0;
    const sub = [
      `${scope.count} ห้องที่ AI อ่านแล้วไม่เจอจุดไหน · ไม่รวมห้องที่เปิดอยู่`,
      scope.smallIssues ? `อีก ${scope.smallIssues} ห้องที่ AI ชี้จุดเล็ก ๆ ยังต้องดูเอง` : "",
      warmup && !armed ? "สัปดาห์แรกตั้งใจตรวจทุกห้อง — ใช้เมื่อไม่มีเวลาจริง ๆ" : "",
    ].filter(Boolean).join(" · ");
    const button = el("button", {
      type: "button", class: `odr-bulk${armed ? " is-armed" : ""}${warmup ? " is-quiet" : ""}`, onclick: () => bulkTap(),
      "aria-describedby": "odr-bulk-sub",
    }, el("span", { class: "odr-bulk-main" }, armed ? `แตะอีกครั้งเพื่อยืนยัน · ดีแล้ว ${scope.count} ห้อง` : `✅ ดีที่เหลือทั้งหมด (${scope.count})`),
    el("span", { class: "odr-bulk-sub", id: "odr-bulk-sub" }, sub));
    button.disabled = view.bulkBusy || view.busy;
    bulkHost.replaceChildren(button);
  }

  function renderHeader() {
    if (!view) return;
    const c = counts();
    progress.set(c.labelled, c.total);
    progress.node.hidden = !view.batch || c.total === 0;
    renderStats();
    bannerHost.replaceChildren(...[bannerNode()].filter(Boolean));
    renderBulk();
    onWaiting(view.batch && !view.requested ? c.remaining : undefined);
  }

  /* ---------------------------------- การ์ด ---------------------------------- */

  function setActions(item) {
    const name = item ? nameOf(item) : "";
    const blocked = !item || view.busy || !detailReady(item) || Boolean(item.label);
    goodBtn.disabled = blocked;
    fixBtn.disabled = blocked;
    goodBtn.setAttribute("aria-label", item ? `ดีแล้ว ห้องของ ${name}` : "ดีแล้ว");
    fixBtn.setAttribute("aria-label", item ? `ต้องปรับ ห้องของ ${name}` : "ต้องปรับ");
  }

  function setThumbMode() {
    const empty = !current();
    thumbBtns.hidden = empty || view.picking;
    pickBtns.hidden = empty || !view.picking;
    thumb.classList.toggle("is-bare", empty);
  }

  function stackClass() {
    const classes = ["orv-stack"];
    const next = view.items.get(view.deck[1]);
    if (next) classes.push("has-next", `next-tone-${riskTone(next)}`);
    if (view.deck.length > 2) classes.push("has-next2");
    return classes.join(" ");
  }

  function buildCard(item) {
    const card = dailyCard({
      item, detail: view.details.get(item.id) ?? null, detailState: view.detailState.get(item.id) || "loading",
      picking: view.picking, flashId: view.flashId, showEarlier: view.showEarlier.has(item.id),
      notice: view.notice?.id === item.id ? view.notice : null, busyKeys: view.busyKeys, expandedIssues: view.expandedIssues,
      onRetry: () => { void ensureDetail(item, { force: true }); refreshCard({ keep: false }); },
      onChipTap: (issue) => jumpTo(issue),
      onVerdict: (issue, value) => verdict(item, issue, value),
      onPick: (bubble) => openFix(bubble),
      onShowEarlier: () => { view.showEarlier.add(item.id); refreshCard({ keep: false }); },
      // แตะปัญหาใต้ฟอง = อ่านโน้ตเต็ม + ฟองที่อ้างถึงกะพริบ (ไม่เลื่อนจอ)
      onToggleIssue: (issue) => {
        const opening = !view.expandedIssues.has(issue.key);
        if (opening) view.expandedIssues.add(issue.key); else view.expandedIssues.delete(issue.key);
        if (opening && issue.messageId) flash(issue.messageId); else refreshCard();
      },
    });
    attachSwipe(card, {
      onKeep: () => { if (!canAct() || view.picking) return false; void labelGood(); return true; },
      onClose: () => { if (canAct() && !view.picking) startPick(); },
      isLocked: () => !canAct() || view.picking,
    });
    return card;
  }

  // วาดการ์ดใหม่โดยฟองกลางจอยังอยู่ที่เดิม (Safari ไม่มี scroll anchoring) — keep:false = ตั้งใจให้ตำแหน่งเปลี่ยน (กางแชทเก่า/ลองโหลดใหม่)
  function refreshCard({ keep = true, prefer = "" } = {}) {
    const item = current();
    if (!item || !alive) return;
    const anchor = keep ? captureAnchor(stack, { prefer }) : null;
    stack.className = stackClass();
    stack.replaceChildren(buildCard(item));
    setActions(item);
    restoreAnchor(stack, anchor);
  }

  function focusCardHeading() {
    (stack.querySelector(".orv-name") || stack.querySelector(".orv-empty-title"))?.focus?.();
  }

  function showEmpty() {
    stack.className = "orv-stack is-empty";
    hint.hidden = true;
    if (view.error) {
      stack.replaceChildren(errorScreen({ notFound: view.error.status === 404, onRetry: () => void openLatest({ keepRequested: true }) }));
      return;
    }
    if (!view.batch) {
      stack.replaceChildren(view.building
        ? el("section", { class: "orv-empty odr-state", "aria-labelledby": "odr-state-title" },
            el("h2", { id: "odr-state-title", class: "orv-empty-title", tabindex: "-1" }, "กำลังเตรียมคิวตรวจแชท"),
            buildingBanner(view.building))
        : noBatchScreen({ nextDailyAt: view.nextDailyAt }));
      setText(live, view.building ? "กำลังเตรียมคิวตรวจแชท" : "ยังไม่มีคิวตรวจแชท");
      return;
    }
    const c = counts();
    stack.replaceChildren(doneScreen({
      batch: view.batch, counts: c, lessonsMade: lessonsCreated(dailyItems(view)), lessonsApplyNow: view.lessonsApplyNow, nextDailyAt: view.nextDailyAt,
      backlog: backlogChips(view.backlog, { viewingOld: Boolean(view.requested) }),
    }));
    setText(live, c.total ? `ตรวจครบทุกห้องแล้ว ดีแล้ว ${c.good} ต้องปรับ ${c.needsFix}` : "รอบนี้ไม่มีแชทให้ตรวจ");
  }

  function showCurrent({ motion = "" } = {}) {
    if (!view || !alive) return;
    view.picking = false;
    view.flashId = "";
    // ห้องถัดไปที่อีกคนกำลังดูอยู่ = ข้ามไปห้องว่างก่อน (เฉพาะตอนเปลี่ยนห้อง — การ์ดที่เปิดอยู่ไม่สลับใต้นิ้ว)
    if (motion !== "return" && view.notice?.id !== view.deck[0]) preferUnclaimed(view);
    renderHeader();
    setThumbMode();
    const item = current();
    view.shownAt = Date.now();
    if (!item) { showEmpty(); armSync(); return; }
    // คำใบ้การปัดบอกครั้งเดียวตอนเริ่ม · จอเมาส์ซ่อนด้วย CSS
    hint.hidden = view.sessionLabels > 0;
    stack.className = stackClass();
    const card = buildCard(item);
    stack.replaceChildren(card);
    if (motion) {
      const calm = prefersReducedMotion();
      if (!calm) card.classList.add(motion === "return" ? "is-returning" : "is-entering");
      // ห้องถัดไปเริ่มใต้แถบความคืบหน้า (แท็บ/ระดับการตรวจเลื่อนขึ้นไปดูได้) — เดิมเด้งบนสุด แชทจมใต้ปุ่มทุกห้อง
      scrollUnderBar(bulkHost.children?.length ? bulkHost : stack, { bar: barHost, behavior: calm ? "auto" : "smooth" });
    }
    setActions(item);
    const c = counts();
    setText(live, `ห้อง ${c.labelled + 1} จาก ${c.total}: ${nameOf(item)} · ${item.riskLabel || ""}`);
    void ensureDetail(item);
    void claimCurrent();
    const next = view.items.get(view.deck[1]);
    if (next) void ensureDetail(next);
    armSync();
  }

  /** "กำลังดูห้องนี้" — คนอื่นเปิดห้องนี้ก่อน = แถบบอก + ปุ่มข้ามไปห้องอื่น (ห้องไม่ถูกล็อก กดตรวจต่อได้) */
  async function claimCurrent({ renew = false } = {}) {
    const mine = view;
    const item = current();
    if (!mine || !item || item.label) return;
    if (renew ? Date.now() - mine.claimedAt < CLAIM_RENEW_MS || mine.claimedId !== item.id : mine.claimedId === item.id) return;
    mine.claimedId = item.id;
    mine.claimedAt = Date.now();
    const res = await api(dailyItemPath(item.id, "/claim"), { method: "POST", body: {} }).catch(() => null);
    if (view !== mine || current()?.id !== item.id || !res) return;
    const who = typeof res.viewingBy === "string" && res.viewingBy ? res.viewingBy : "";
    mine.items.set(item.id, { ...mine.items.get(item.id), viewingBy: who || null });
    if (!who || mine.notice?.id === item.id) return;
    mine.notice = {
      id: item.id, tone: "info", text: `${who} กำลังดูห้องนี้อยู่`,
      action: mine.deck.length > 1 ? { label: "ข้ามไปห้องอื่น", onClick: () => skipViewed() } : null,
    };
    refreshCard();
  }

  function skipViewed() {
    if (!view || view.busy || !deferCurrent(view)) return;
    view.notice = null;
    showCurrent({ motion: "enter" });
    focusCardHeading();
  }

  async function leave(direction) {
    const card = stack.querySelector(".orv-card");
    if (!card) return;
    card.classList.remove("is-dragging");
    card.classList.add(direction === "left" ? "is-leaving-left" : "is-leaving-right");
    await afterMotion(card, 220);
  }

  function skipCurrent() {
    const item = current();
    if (!item || view.busy) return;
    view.deck = view.deck.slice(1);
    view.notice = null;
    showCurrent({ motion: "enter" });
    focusCardHeading();
  }

  async function ensureDetail(item, { force = false } = {}) {
    if (!item || !view || (!force && view.detailState.has(item.id))) return;
    const mine = view;
    mine.detailState.set(item.id, "loading");
    try {
      const detail = await api(dailyItemPath(item.id));
      if (view !== mine) return;
      mine.details.set(item.id, detail);
      mine.detailState.set(item.id, "ready");
      if (detail?.item) mergeServerItem(detail.item);
    } catch (err) {
      if (view !== mine) return;
      if (err?.status === 404) {
        const wasCurrent = current()?.id === item.id;
        dropDailyItem(view, item.id);
        if (wasCurrent) { toast("ห้องนี้ไม่อยู่ในคิวแล้ว (อาจถูกลบตามสิทธิ์ให้ลืม)"); showCurrent({ motion: "enter" }); } else renderHeader();
        return;
      }
      mine.detailState.set(item.id, "failed");
    }
    if (current()?.id === item.id) refreshCard();
  }

  /* ---------------------------------- ดีแล้ว ---------------------------------- */

  async function labelGood() {
    const item = current();
    if (!item || !canAct() || view.picking) return;
    const mine = view;
    const name = nameOf(item);
    const record = { id: item.id, revision: null };
    mine.busy = true;
    setActions(item);
    const toastCtl = undo.show({
      name, title: `ดีแล้ว · ${name}`, readyText: "บันทึกแล้ว", undoLabel: `ย้อน ดีแล้ว ห้องของ ${name}`, reasons: [], undoMs: mine.undoMs,
      onUndo: () => undoLabel(record, mine),
    });
    // ไปห้องถัดไปทันที (ไม่รอเซิร์ฟเวอร์) — ถ้าบันทึกไม่ผ่าน การ์ดกลับมาพร้อมบอกเหตุ
    const request = api(dailyItemPath(item.id, "/label"), { method: "POST", body: { label: "good", revision: item.revision } });
    request.catch(() => {});
    await leave("right");
    if (view !== mine) return;
    mine.items.set(item.id, { ...item, label: "good" });
    mine.deck = mine.deck.filter((id) => id !== item.id);
    mine.sessionLabels += 1;
    mine.busy = false;
    mine.notice = null;
    showCurrent({ motion: "enter" });
    try {
      const res = await request;
      if (view === mine && res?.item) mergeServerItem(res.item);
      record.revision = Number.isInteger(res?.item?.revision) ? res.item.revision : null;
      if (record.revision === null) toastCtl.failed(); else toastCtl.ready();
      if (view === mine) renderHeader();
    } catch (err) {
      toastCtl.failed();
      if (view === mine) labelFailed(item, err);
    }
  }

  function labelFailed(item, err) {
    const fresh = err?.data?.item;
    const code = err?.data?.code || "";
    if (fresh?.label) {
      // มีคนติดป้ายห้องนี้ไปก่อน — ไม่ต้องคืนการ์ด
      view.items.set(item.id, { ...view.items.get(item.id), ...fresh });
      renderHeader();
      toast(`${fresh.labelledByName || "ทีม"} ตรวจห้องนี้ไปแล้ว (${labelWord(fresh.label)})`);
      return;
    }
    if (err?.status === 404 && code === "not_found") {
      dropDailyItem(view, item.id);
      renderHeader();
      toast(err?.data?.error || "ห้องนี้ไม่อยู่ในคิวแล้ว");
      return;
    }
    view.items.set(item.id, { ...view.items.get(item.id), ...(fresh || {}), label: null });
    view.sessionLabels = Math.max(0, view.sessionLabels - 1);
    returnToDeck(view, item.id, { behind: view.busy || fixSheet.isOpen() || view.picking });
    toast(code === "stale_revision"
      ? "ห้องนี้มีการเปลี่ยนแปลง — ดูอีกครั้งแล้วกดใหม่นะคะ"
      : `บันทึก "ดีแล้ว" ของ ${nameOf(item)} ไม่สำเร็จ — ห้องกลับมารอแล้ว`);
    if (code === "not_ready" || code === "not_queued") { void reload(); return; }
    if (view.deck[0] === item.id) showCurrent({ motion: "return" }); else renderHeader();
  }

  async function undoLabel(record, mine) {
    // กำลังทำห้องอื่นอยู่ (คำขอยังไม่จบ/แผ่นเปิด) — ย้อนตอนนี้ = การ์ดที่คืนมาถูกพาออกไปพร้อมผลของห้องนั้น
    if (record.revision === null || view !== mine || mine.busy || fixSheet.isOpen()) return false;
    try {
      const res = await api(dailyItemPath(record.id, "/undo"), { method: "POST", body: { revision: record.revision } });
      if (view !== mine) return true;
      const local = mine.items.get(record.id);
      if (!local) return true;
      mine.items.set(record.id, { ...local, ...(res?.item || {}), label: null });
      mine.deck = [record.id, ...mine.deck.filter((id) => id !== record.id)];
      mine.sessionLabels = Math.max(0, mine.sessionLabels - 1);
      const withdrawn = Number(res?.lessonsWithdrawn) || 0;
      mine.notice = null;
      showCurrent({ motion: "return" });
      goodBtn.focus?.();
      toast(withdrawn ? "ย้อนแล้ว — ถอนบทเรียนที่เพิ่งสร้างแล้ว" : "ย้อนแล้ว — ห้องนี้กลับมารอตรวจ");
      return true;
    } catch (err) {
      toast(err?.data?.error || err?.message || "ย้อนไม่สำเร็จ");
      if (view === mine && err?.data?.item) mergeServerItem(err.data.item);
      // เลยเวลา/คนอื่นเปลี่ยนแล้ว = ปิดแถบ · เน็ตหลุด = ให้กดย้อนได้อีกครั้ง
      return err?.status === 409 || err?.status === 404;
    }
  }

  /* ---------------------------------- ต้องปรับ ---------------------------------- */

  function startPick() {
    const item = current();
    if (!item || !canAct() || view.picking) return;
    const fixable = (view.details.get(item.id)?.bubbles || []).filter((bubble) => bubble.fixable === true);
    if (!fixable.length) { openFix(null); return; }
    view.picking = true;
    // รีวิว 13 ต.ค.: ไม่กางแชททั้งห้องอีกแล้ว (แชท 80 ข้อความเคยพาจอไปอยู่ต้นห้อง) — ฟองที่ดูอยู่ค้างที่เดิม
    // ฟองเก่าที่ซ่อนอยู่ยังกาง "ดูข้อความก่อนหน้า" ได้ระหว่างเลือก
    refreshCard();
    setThumbMode();
    renderBulk();
    void claimCurrent({ renew: true });
    setText(live, "แตะข้อความของลูกแพรที่ควรปรับ หรือกด ไม่ระบุข้อความ");
    // ปุ่มต้องปรับที่ถือโฟกัสอยู่ถูกซ่อน — ให้คีย์บอร์ด/VoiceOver ไปต่อที่ฟองแรกที่แตะได้ (ไม่เลื่อนหน้าใต้นิ้ว)
    (stack.querySelector(".odr-bubble-pick.is-ai-flagged") || stack.querySelector(".odr-bubble-pick"))?.focus?.({ preventScroll: true });
  }

  function cancelPick() {
    if (!view?.picking) return;
    view.picking = false;
    refreshCard();
    setThumbMode();
    renderBulk();
    fixBtn.focus?.();
  }

  function openFix(bubble) {
    const item = current();
    if (!item || !view || view.busy || fixSheet.isOpen()) return;
    const detail = view.details.get(item.id);
    if (!detail) return;
    const lessonPath = Boolean(bubble) && detail.canTeach === true;
    const aiNotes = bubble
      ? (bubble.issueKeys || []).map((key) => (item.issues || []).find((issue) => issue.key === key)).filter(Boolean)
        .map((issue) => (issue.note ? `${issue.label} — ${issue.note}` : issue.label))
      : [];
    const mine = view;
    const key = draftKey(item.id, bubble?.id);
    fixSheet.open({
      name: nameOf(item), bubble, chips: view.chips, max: view.betterReplyMax, min: view.betterReplyMin, aiNotes, preview: lessonPath,
      copy: fixCopy(detail, { lessonPath, bubble }), draft: view.drafts.get(key) ?? null,
      onDraft: (draft) => { if (view === mine) mine.drafts.set(key, draft); },
      onSave: (ctl, picked) => saveFix(item.id, { bubble, lessonPath, detail }, picked, ctl),
      returnFocus: view.picking ? cancelPickBtn : fixBtn,
    });
  }

  async function saveFix(id, { bubble, lessonPath, detail }, picked, ctl) {
    const mine = view;
    const item = mine?.items.get(id);
    if (!item || current()?.id !== id) { ctl.close({ restore: false }); return; }
    mine.busy = true;
    setActions(item);
    let res;
    try {
      res = lessonPath
        ? await api(dailyItemPath(id, "/fix"), {
            method: "POST", body: { messageId: bubble.id, reasonChips: picked.chips, betterReply: picked.betterReply, revision: item.revision },
          })
        : await api(dailyItemPath(id, "/label"), {
            method: "POST", body: { label: "needs_fix", revision: item.revision, note: fixNote(picked.chipLabels, picked.betterReply, mine.betterReplyMax) },
          });
    } catch (err) {
      mine.busy = false;
      if (view !== mine) { ctl.fail(err?.data?.error || err?.message || "บันทึกไม่สำเร็จ"); return; }
      fixFailed(item, err, ctl);
      return;
    }
    if (view !== mine) return;
    ctl.close({ restore: false });
    mine.drafts.delete(draftKey(id, bubble?.id));
    const fresh = res?.item;
    mine.items.set(id, { ...item, ...(fresh || {}), label: "needs_fix" });
    if (lessonPath && detail?.lessonsApplyNow) mine.lessonsApplyNow = true;
    const name = nameOf(item);
    const doneText = fixDoneText(res, { lessonPath, detail });
    const record = { id, revision: Number.isInteger(fresh?.revision) ? fresh.revision : null };
    const toastCtl = undo.show({
      name, title: `ต้องปรับ · ${name}`, readyText: doneText, undoLabel: `ย้อน ต้องปรับ ห้องของ ${name}`, reasons: [], undoMs: mine.undoMs,
      onUndo: () => undoLabel(record, mine),
    });
    if (record.revision === null) toastCtl.failed(); else toastCtl.ready();
    await leave("left");
    if (view !== mine) return;
    mine.deck = mine.deck.filter((row) => row !== id);
    mine.sessionLabels += 1;
    mine.busy = false;
    mine.notice = null;
    showCurrent({ motion: "enter" });
    focusCardHeading();
    setText(live, doneText);
  }

  function fixFailed(item, err, ctl) {
    const code = err?.data?.code || "";
    const message = err?.data?.error || err?.message || "บันทึกไม่สำเร็จ ลองอีกครั้งนะคะ";
    const fresh = err?.data?.item;
    if (code === "stale_revision") {
      ctl.close({ restore: false });
      if (fresh?.label) {
        view.items.set(item.id, { ...item, ...fresh });
        view.deck = view.deck.filter((id) => id !== item.id);
        toast(`${fresh.labelledByName || "ทีม"} ตรวจห้องนี้ไปแล้ว (${labelWord(fresh.label)})`);
        showCurrent({ motion: "enter" });
        return;
      }
      if (fresh) mergeServerItem(fresh);
      toast("ห้องนี้มีการเปลี่ยนแปลง — กดต้องปรับอีกครั้งนะคะ");
      view.picking = false;
      refreshCard();
      setThumbMode();
      return;
    }
    if (err?.status === 404 && code === "not_found") {
      ctl.close({ restore: false });
      dropDailyItem(view, item.id);
      toast(message);
      showCurrent({ motion: "enter" });
      return;
    }
    if (code === "not_ready" || code === "not_queued") {
      ctl.close({ restore: false });
      toast(message);
      void reload();
      return;
    }
    if (fresh) mergeServerItem(fresh);
    // บทเรียนถูกปฏิเสธ (มีเบอร์/ชื่อ/ยาวเกิน ฯลฯ) — แผ่นยังเปิด สิ่งที่พิมพ์ไว้อยู่ครบ แก้แล้วกดใหม่ได้
    ctl.fail(message);
    setActions(current());
  }

  /* ------------------------------ ใช่/ไม่ใช่ กับปัญหาที่ AI ชี้ ------------------------------ */

  async function verdict(item, issue, value) {
    const mine = view;
    if (!mine || mine.busyKeys.has(issue.key)) return;
    const next = issue.verdict === value ? null : value;
    mine.busyKeys.add(issue.key);
    refreshCard();
    try {
      const res = await api(dailyItemPath(item.id, "/verdict"), { method: "POST", body: { issueKey: issue.key, verdict: next } });
      if (view === mine && res?.item) mergeServerItem(res.item);
    } catch (err) {
      if (view === mine) toast(err?.data?.error || err?.message || "บันทึกไม่สำเร็จ");
    } finally {
      mine.busyKeys.delete(issue.key);
      if (view === mine && current()?.id === item.id) {
        refreshCard();
        // การ์ดถูกวาดใหม่ — คืนโฟกัสให้ปุ่มเดิม (คนใช้คีย์บอร์ด/VoiceOver ไม่หลุดกลับไปหัวหน้า)
        const host = Array.from(stack.querySelectorAll(".odr-issue")).find((node) => node.getAttribute?.("data-issue") === issue.key);
        host?.querySelector?.(`.odr-verdict.is-${value}`)?.focus?.({ preventScroll: true });
      }
    }
  }

  /** แตะชิปปัญหา = เลื่อนไปที่ฟองที่อ้างถึง (กางแชทเก่าให้ถ้าซ่อนอยู่) แล้วกะพริบ */
  function jumpTo(issue) {
    const item = current();
    if (!item || view.picking) return;
    const behavior = prefersReducedMotion() ? "auto" : "smooth";
    const bubbles = view.details.get(item.id)?.bubbles || [];
    const index = issue?.messageId ? bubbles.findIndex((bubble) => bubble.id === issue.messageId) : -1;
    if (index < 0) {
      stack.querySelector(".odr-room-issues")?.scrollIntoView?.({ block: "nearest", behavior });
      return;
    }
    if (index < bubbles.length - DAILY_RECENT_BUBBLES) view.showEarlier.add(item.id);
    flash(issue.messageId, { scroll: behavior });
  }

  /** ฟองนี้กะพริบ (scroll = เลื่อนไปกลางจอด้วย behavior นั้น) — ลดโมชัน = ไฮไลต์นิ่งตาม CSS */
  function flash(messageId, { scroll = "" } = {}) {
    const mine = view;
    mine.flashId = messageId;
    refreshCard({ keep: !scroll });
    const node = Array.from(stack.querySelectorAll(".odr-msg")).find((row) => row.getAttribute?.("data-msg") === messageId);
    if (scroll) node?.scrollIntoView?.({ block: "center", behavior: scroll });
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (view === mine && mine.flashId === messageId) { mine.flashId = ""; node?.classList?.remove("is-flash"); }
    }, FLASH_MS);
  }

  /* ---------------------------------- ดีที่เหลือทั้งหมด ---------------------------------- */

  /** แตะครั้งแรก = ปุ่มกลายเป็น "แตะอีกครั้งเพื่อยืนยัน" (BULK_CONFIRM_MS) · แตะซ้ำภายในเวลา = ติดป้ายจริง */
  function bulkTap() {
    const mine = view;
    if (!mine?.batch || mine.bulkBusy || mine.busy || fixSheet.isOpen()) return;
    if (mine.bulkArmedUntil > Date.now()) { mine.bulkArmedUntil = 0; void bulkGood(); return; }
    mine.bulkArmedUntil = Date.now() + BULK_CONFIRM_MS;
    renderBulk();
    setTimeout(() => { if (view === mine && mine.bulkArmedUntil && mine.bulkArmedUntil <= Date.now()) { mine.bulkArmedUntil = 0; renderBulk(); } },
      BULK_CONFIRM_MS + 50);
  }

  async function bulkGood() {
    const mine = view;
    if (!mine?.batch || mine.bulkBusy || mine.busy || fixSheet.isOpen()) return;
    const scope = bulkScope(mine);
    mine.bulkBusy = true;
    renderBulk();
    try {
      const res = await api(dailyBatchPath(mine.batch.id, "/good-rest"), { method: "POST", body: { exceptId: scope.exceptId } });
      if (view !== mine) return;
      const labelled = Number(res?.labelled) || 0;
      const record = { bulkId: String(res?.bulkId || "") };
      const toastCtl = undo.show({
        name: "", title: `ดีแล้ว ${labelled} ห้อง`, readyText: "ห้องปกติที่เหลือของรอบนี้", undoLabel: `ย้อน ดีที่เหลือทั้งหมด ${labelled} ห้อง`,
        reasons: [], undoMs: mine.undoMs, onUndo: () => undoBulk(record, mine),
      });
      if (record.bulkId) toastCtl.ready(); else toastCtl.failed();
      mine.sessionLabels += labelled;
      await reload();
    } catch (err) {
      if (view !== mine) return;
      toast(err?.data?.error || err?.message || "บันทึกไม่สำเร็จ");
      if (err?.data?.code === "flagged_remaining" || err?.data?.code === "nothing_left") await reload();
    } finally {
      if (view === mine) { mine.bulkBusy = false; renderBulk(); }
    }
  }

  async function undoBulk(record, mine) {
    if (!record.bulkId || view !== mine || mine.busy || fixSheet.isOpen() || !mine.batch) return false;
    try {
      await api(dailyBatchPath(mine.batch.id, "/good-rest/undo"), { method: "POST", body: { bulkId: record.bulkId } });
      toast("ย้อนแล้ว — ห้องปกติกลับมารอตรวจ");
      await reload();
      return true;
    } catch (err) {
      toast(err?.data?.error || err?.message || "ย้อนไม่สำเร็จ");
      return err?.status === 409 || err?.status === 404;
    }
  }

  /* ---------------------------------- ปักระดับ (เจ้าของ) ---------------------------------- */

  async function pin(value) {
    const mine = view;
    if (!mine?.canPin || mine.pinBusy) return;
    mine.pinBusy = true;
    renderStats();
    try {
      const res = await api(`${DAILY_BASE}/taper`, { method: "POST", body: { pin: value } });
      if (view !== mine) return;
      if (res?.taper) mine.taper = res.taper;
      toast(value === null ? "กลับเป็นปรับระดับอัตโนมัติแล้ว — มีผลคิวคืนถัดไป" : `ปักไว้ที่ "${res?.taper?.levelLabel || ""}" — มีผลคิวคืนถัดไป`);
    } catch (err) {
      if (view === mine) toast(err?.data?.error || err?.message || "ปักระดับไม่สำเร็จ");
    } finally {
      if (view === mine) { mine.pinBusy = false; renderStats(); }
    }
  }

  /* ------------------------------ โหลดใหม่ / ดูป้ายของคนอื่น ------------------------------ */

  async function reload() {
    const mine = view;
    if (!mine) return;
    const queue = await api(dailyQueuePath(mine.requested)).catch(() => null);
    if (!alive || view !== mine || !queue) return;
    if ((queue.batch?.id ?? null) !== (mine.batch?.id ?? null)) { adopt(queue); showCurrent({ motion: "enter" }); return; }
    const changed = applyDailyQueue(view, queue);
    if (changed) showCurrent({ motion: "enter" });
    else { renderHeader(); setThumbMode(); if (!current()) showEmpty(); }
  }

  /** เปิดคิวล่าสุด (แบนเนอร์ "คิวใหม่พร้อมแล้ว" / ลองโหลดใหม่หลังผิดพลาด) */
  async function openLatest({ keepRequested = false } = {}) {
    if (view?.requested && !keepRequested) { globalThis.location.hash = dailyHref(); return; }
    const path = dailyQueuePath(keepRequested ? view?.requested : "");
    try {
      const queue = await api(path);
      if (!alive) return;
      adopt(queue);
      showCurrent({ motion: "enter" });
    } catch (err) {
      if (alive) start(null, { error: err });
    }
  }

  async function syncOnce(mine) {
    void claimCurrent({ renew: true });
    const queue = await api(dailyQueuePath(mine.requested)).catch(() => null);
    if (!queue || view !== mine || !alive || mine.busy || fixSheet.isOpen()) return;
    if ((queue.batch?.id ?? null) !== (mine.batch?.id ?? null)) {
      if (!current()) { adopt(queue); showCurrent({ motion: "enter" }); return; }
      if (!mine.requested && queue.batch) mine.newBatch = queue.batch;
      renderHeader();
      return;
    }
    applyDailyMeta(mine, queue);
    let currentChanged = false;
    for (const fresh of Array.isArray(queue.items) ? queue.items : []) {
      if (mergeServerItem(fresh) === "current") currentChanged = true;
    }
    renderHeader();
    if (!current()) showEmpty();
    else if (currentChanged) refreshCard();
  }

  function armSync() {
    if (!alive || !view) return;
    clearTimeout(state.pollTimer);
    const mine = view;
    const delay = current() || mine.building ? SYNC_MS : IDLE_SYNC_MS;
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = null;
      if (!alive || view !== mine || !onDailyTab()) return;
      try {
        if (globalThis.document?.visibilityState !== "hidden" && !mine.busy && !fixSheet.isOpen() && !mine.picking) await syncOnce(mine);
      } finally {
        if (alive && view && !state.pollTimer && onDailyTab()) armSync();
      }
    }, delay);
  }

  /* ---------------------------------- เริ่ม/เลิก ---------------------------------- */

  /** queue = คำตอบของ GET /daily · error = คำขอนั้นล้ม (404 = ไม่พบวันนั้น) */
  function start(queue, { error = null } = {}) {
    if (!alive) return;
    stopPolling?.();
    adopt(error ? null : queue);
    if (error) view.error = { status: Number(error?.status) || 0, message: String(error?.data?.error || error?.message || "") };
    showCurrent();
  }

  function destroy() {
    alive = false;
    clearTimeout(flashTimer);
    fixSheet.close({ restore: false });
    undo.hide();
  }

  return {
    content: [barHost, panelHost, bannerHost, bulkHost, hint, stack, thumb],
    overlay: [sheetHost, live],
    start, destroy,
    // ให้เทสต์/ตัวคุมหน้าอ่านสถานะได้ (ไม่ใช้เขียน)
    peek: () => (view ? { deck: view.deck.slice(), counts: counts(), picking: view.picking } : null),
  };
}
