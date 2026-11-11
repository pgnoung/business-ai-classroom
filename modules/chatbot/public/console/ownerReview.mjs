// ownerReview.mjs — "ห้องตรวจ" (#/owner-review) · เฟส A: ห้องที่ AI เสนอปิด รอพี่ง้วง/ชมพู่ยืนยัน (12 ต.ค. 2026 ค่ำ)
//
// ออกแบบสำหรับ iPhone ก่อน: ทีละห้องเป็นกองการ์ด (ใบถัดไปโผล่ขอบใต้ใบบน) · ปุ่มใหญ่สองปุ่มติดขอบล่างระยะนิ้วโป้ง
//   ปิดแชท  → แผ่นยืนยันโชว์ "คำลาที่จะส่งจริง" ก่อนเสมอ (ส่งแล้วย้อนไม่ได้) · มีปิดเงียบ (ไม่ส่งข้อความ)
//   ไม่ปิด  → ไปห้องถัดไปทันที + แถบย้อน 10 วิ + ชิปเหตุผลแบบแตะ (ไม่บังคับ) ให้ AI จำเป็นตัวอย่างห้ามปิด
//   ปัดขวา = ไม่ปิด · ปัดซ้าย = เปิดแผ่นยืนยันปิด (ปุ่มยังเป็นทางหลัก)
// แท็บที่สอง "ตรวจแชทวันนี้" (#/owner-review/daily) = เฟส B — คิว 20:00 ทีละห้อง (ตัวคุมอยู่ใน ownerReviewDaily.mjs)
// ทุกโหนดสร้างผ่าน el() (ไม่มี innerHTML) · ข้อความลูกค้ามาจากเซิร์ฟเวอร์แบบปิดชื่อ/เบอร์แล้ว
import { el } from "./dom.mjs";
import { categoryMeta, createProgress, emptyDeck, proposalCard, reviewTabs, setText, statusBanners } from "./ownerReviewCard.mjs";
import { SHEET_ARM_MS, afterMotion, attachSwipe, blockKeyRepeat, createCloseSheet, createUndoToast, prefersReducedMotion } from "./ownerReviewSheet.mjs";
import { createDailyReview, dailyBatchFromHash, dailyQueuePath } from "./ownerReviewDaily.mjs";

const BASE = "/console/api/owner-review";
const OPEN_STATUSES = new Set(["pending", "send_failed"]);
const LIST_LIMIT = 100;
// คิวว่าง = ดูรอบใหม่เงียบ ๆ ทุกนาที (มีการ์ดอยู่ = ไม่ดึงทับ ห้ามการ์ดเปลี่ยนใต้นิ้วคนที่กำลังตัดสิน)
const EMPTY_POLL_MS = 60_000;
const CUSTOMER_TYPED_TEXT = "ลูกค้าเพิ่งพิมพ์ใหม่ — ดูข้อความล่าสุดก่อนนะคะ";
// การ์ดใหม่เพิ่งขึ้น = ยังไม่มีใครอ่านทัน — แตะสองทีที่ "ไม่ปิด" ต้องไม่ตัดสินห้องถัดไปที่ยังไม่เห็น (ปัดก็เช่นกัน)
const CARD_ARM_MS = 350;
// ส่งคำลาไม่ได้แต่ "ปิดเงียบ" ยังได้ — แผ่นยืนยันเหลือปุ่มปิดเงียบ/ยกเลิก
const SILENT_ONLY_CODES = new Set(["fb_window_closed", "opted_out", "ai_paused", "delivery_fenced", "send_failed"]);
// ห้องนี้จบแล้ว (คนอื่นตัดสิน/ห้องเปลี่ยน/หาไม่เจอ) — เอาออกจากกองแล้วไปห้องถัดไป
const DROP_CODES = new Set(["room_changed", "blocked", "not_found", "already_decided"]);

/** แท็บจาก hash — URL คือสถานะ (แชร์ลิงก์/กดย้อนแล้วกลับแท็บเดิม) */
export function ownerReviewTab(hash) {
  return /^#\/owner-review\/daily(?:$|[/?])/u.test(String(hash || "")) ? "daily" : "close";
}

/** ลำดับการ์ด: ส่งคำลาไม่สำเร็จก่อน (ค้างครึ่งทาง) แล้วรอยืนยันที่เก่าสุดก่อน (ใกล้หมดอายุ 72 ชม.) */
export function sortDeck(rows) {
  const failedFirst = (row) => (row.status === "send_failed" ? 0 : 1);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && OPEN_STATUSES.has(row.status))
    .slice()
    .sort((a, b) => failedFirst(a) - failedFirst(b)
      || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
      || String(a.id).localeCompare(String(b.id)));
}

const nameOf = (item) => item?.customer?.displayName || item?.customer?.displayNameMasked || "ลูกค้า";
const proposalPath = (id, tail = "") => `${BASE}/proposals/${encodeURIComponent(String(id))}${tail}`;

// armMs = เวลาก่อนการ์ด/แผ่นยืนยันรับการกด (เทสต์ส่ง 0) — ดู SHEET_ARM_MS / CARD_ARM_MS
export function createOwnerReviewPage({ api, toast, mount, pageHeader, tabBar, stopPolling, setView, state, armMs = null }) {
  const sheetArmMs = armMs ?? SHEET_ARM_MS;
  const cardArmMs = armMs ?? CARD_ARM_MS;
  let gen = 0;
  let view = null;
  let nodes = null;
  let sheet = null;
  let undo = null;
  let daily = null;

  /* ------------------------------- สถานะกองการ์ด ------------------------------- */

  const current = () => view?.deck[0] ?? null;
  const total = () => (view ? view.done + view.deck.length : 0);
  const onPage = () => String(globalThis.location?.hash || "").startsWith("#/owner-review");

  function replaceItem(fresh) {
    if (!fresh?.id || !view) return;
    view.deck = view.deck.map((row) => (row.id === fresh.id ? { ...row, ...fresh } : row));
  }

  function dropItem(id) {
    if (!view) return false;
    const wasCurrent = current()?.id === id;
    view.deck = view.deck.filter((row) => row.id !== id);
    view.details.delete(id);
    view.detailState.delete(id);
    view.since.delete(id);
    return wasCurrent;
  }

  const cardSettled = () => Date.now() - (view?.shownAt || 0) >= cardArmMs;

  /** หลังตัดสิน โฟกัสหัวการ์ดใบใหม่ (ไม่ใช่ปุ่มปิดแชท — Enter ค้าง/กดซ้ำต้องไม่ไปตัดสินห้องที่ยังไม่ได้อ่าน) */
  function focusCardHeading() {
    const heading = nodes?.stack.querySelector(".orv-name") || nodes?.stack.querySelector(".orv-empty-title");
    heading?.focus?.();
  }

  /* ---------------------------------- วาดหน้า ---------------------------------- */

  function updateHeaderBits() {
    nodes.tabs.replaceChildren(reviewTabs({
      tab: view.tab, summary: view.summary, waiting: view.tab === "close" ? view.deck.length : undefined, dailyWaiting: view.dailyWaiting,
    }));
    nodes.banners.replaceChildren(...statusBanners(view.summary, { tab: view.tab }));
    if (view.tab === "close") nodes.progress.set(view.done, total());
  }

  function setActions(item) {
    const name = nameOf(item);
    const detailReady = item && view.detailState.get(item.id) === "ready";
    nodes.closeBtn.disabled = !item || view.busy || !detailReady;
    nodes.keepBtn.disabled = !item || view.busy;
    nodes.closeBtn.setAttribute("aria-label", item ? `ปิดแชทของ ${name}` : "ปิดแชท");
    nodes.keepBtn.setAttribute("aria-label", item ? `ไม่ปิดห้องของ ${name}` : "ไม่ปิด");
  }

  function buildCard(item) {
    const card = proposalCard({
      item,
      detail: view.details.get(item.id) ?? null,
      detailState: view.detailState.get(item.id) || "loading",
      expanded: view.expanded,
      notice: view.notice?.id === item.id ? view.notice : null,
      onToggleMore: () => { view.expanded = !view.expanded; refreshCard(); },
      onRetry: () => { void ensureDetail(item, { force: true }); refreshCard(); },
    });
    attachSwipe(card, {
      onKeep: () => { if (!view || view.busy || sheet?.isOpen() === true || !cardSettled()) return false; void keep(); return true; },
      onClose: () => openSheet(),
      // เจน 12 ต.ค.: การ์ดใหม่ยังไม่พร้อม (กันแตะซ้อน) = ไม่เริ่มปัด — เดิมปัดเร็วแล้วการ์ดค้างนอกจอโดยไม่มีการตัดสิน
      isLocked: () => !view || view.busy || sheet?.isOpen() === true || !cardSettled(),
    });
    return card;
  }

  function stackTone() {
    const next = view.deck[1];
    const classes = ["orv-stack"];
    if (view.deck.length > 1) classes.push("has-next", `next-tone-${categoryMeta(next?.category).tone}`);
    if (view.deck.length > 2) classes.push("has-next2");
    return classes.join(" ");
  }

  function refreshCard() {
    const item = current();
    if (!item || !nodes) return;
    nodes.stack.className = stackTone();
    nodes.stack.replaceChildren(buildCard(item));
    setActions(item);
  }

  function showCurrent({ motion = "" } = {}) {
    if (!view || !nodes) return;
    updateHeaderBits();
    const item = current();
    view.shownAt = Date.now();
    if (!item) {
      nodes.stack.className = "orv-stack is-empty";
      nodes.stack.replaceChildren(emptyDeck({ summary: view.summary, finished: view.done }));
      // แถบปุ่มหายแต่แถบย้อนของห้องสุดท้ายยังต้องกดได้ — ซ่อนแค่กลุ่มปุ่ม
      nodes.thumbBtns.hidden = true;
      nodes.thumb.classList.add("is-bare");
      nodes.hint.hidden = true;
      setText(nodes.live, view.done ? "ตรวจครบทุกห้องแล้ว" : "ไม่มีห้องรอยืนยัน");
      armEmptyPoll();
      return;
    }
    nodes.thumbBtns.hidden = false;
    nodes.thumb.classList.remove("is-bare");
    // คำใบ้การปัดบอกครั้งเดียวตอนเริ่ม (อยู่เหนือกอง ไม่ใช่ใต้แถบปุ่ม) · จอเมาส์ซ่อนด้วย CSS
    nodes.hint.hidden = view.done > 0;
    nodes.stack.className = stackTone();
    const card = buildCard(item);
    nodes.stack.replaceChildren(card);
    if (motion) {
      const calm = prefersReducedMotion();
      if (!calm) card.classList.add(motion === "return" ? "is-returning" : "is-entering");
      // ห้องใหม่ต้องเริ่มอ่านจากหัวการ์ด — ไม่ค้างตำแหน่งเลื่อนของห้องก่อน
      const scroller = nodes.stack.closest?.(".page-scroll");
      if (scroller && scroller.scrollTop > 0) scroller.scrollTo?.({ top: 0, behavior: calm ? "auto" : "smooth" });
    }
    setActions(item);
    setText(nodes.live, `ห้อง ${view.done + 1} จาก ${total()}: ${nameOf(item)} · ${categoryMeta(item.category).short}`);
    void ensureDetail(item);
    if (view.deck[1]) void ensureDetail(view.deck[1]);
  }

  async function leave(direction) {
    const card = nodes?.stack.querySelector(".orv-card");
    if (!card) return;
    card.classList.remove("is-dragging");
    card.classList.add(direction === "left" ? "is-leaving-left" : "is-leaving-right");
    await afterMotion(card, 220);
  }

  /* --------------------------------- รายละเอียดห้อง --------------------------------- */

  async function ensureDetail(item, { force = false } = {}) {
    if (!item || !view || (!force && view.detailState.has(item.id))) return;
    const mine = view;
    mine.detailState.set(item.id, "loading");
    // หลัง 409 ลูกค้าพิมพ์ใหม่ จุดอ้างอิงในฐานเลื่อนไปข้อความล่าสุดแล้ว — ส่งข้อความที่คนตรวจเห็นไปให้ติดป้าย "ใหม่" ถูกบรรทัด
    const since = mine.since.get(item.id);
    try {
      const detail = await api(proposalPath(item.id, since ? `?since=${encodeURIComponent(since)}` : ""));
      if (view !== mine) return;
      if (detail?.proposal && !OPEN_STATUSES.has(detail.proposal.status)) {
        // คนอื่นตัดสินห้องนี้ไปแล้ว (หรือหมดอายุ) ระหว่างที่การ์ดรออยู่
        const wasCurrent = dropItem(item.id);
        if (wasCurrent) {
          toast(`ห้อง ${nameOf(item)} ถูกตัดสินไปแล้ว (${detail.proposal.statusLabel || detail.proposal.status})`);
          showCurrent({ motion: "enter" });
        } else updateHeaderBits();
        return;
      }
      mine.details.set(item.id, detail);
      mine.detailState.set(item.id, "ready");
      if (detail?.proposal) replaceItem(detail.proposal);
    } catch (err) {
      if (view !== mine) return;
      if (err?.status === 404) {
        if (dropItem(item.id)) showCurrent({ motion: "enter" });
        else updateHeaderBits();
        return;
      }
      mine.detailState.set(item.id, "failed");
    }
    if (current()?.id === item.id) refreshCard();
  }

  /* ---------------------------------- ไม่ปิด ---------------------------------- */

  async function keep() {
    const item = current();
    if (!item || view.busy || sheet.isOpen() || !cardSettled()) return;
    const mine = view;
    const record = { item, revision: null };
    mine.busy = true;
    setActions(item);
    const toastCtl = undo.show({
      name: nameOf(item), undoMs: mine.summary?.undoMs,
      onUndo: () => undoKeep(record, mine), onReason: (reason) => noteKeep(record, reason),
    });
    // ไปห้องถัดไปทันที (ไม่รอเซิร์ฟเวอร์) — ถ้าบันทึกไม่ผ่าน การ์ดกลับมาพร้อมบอกเหตุ
    const request = api(proposalPath(item.id, "/decide"), { method: "POST", body: { action: "reject", revision: item.revision } });
    request.catch(() => {}); // จัดการด้านล่าง — กัน unhandled rejection ระหว่างรอโมชัน
    await leave("right");
    if (view !== mine) return;
    mine.deck = mine.deck.filter((row) => row.id !== item.id);
    mine.done += 1;
    mine.notice = null;
    mine.expanded = false;
    mine.busy = false;
    showCurrent({ motion: "enter" });
    try {
      const res = await request;
      record.revision = Number.isInteger(res?.proposal?.revision) ? res.proposal.revision : null;
      if (record.revision === null) toastCtl.failed();
      else toastCtl.ready();
      if (view === mine && !current()) void refreshEmptySummary();
    } catch (err) {
      toastCtl.failed();
      if (view !== mine) return;
      keepFailed(item, err);
    }
  }

  function keepFailed(item, err) {
    const code = err?.data?.code || "";
    if (DROP_CODES.has(code) || code === "stale_revision") {
      // มีคนตัดสินห้องนี้ก่อน — ไม่ต้องคืนการ์ด
      toast(err?.data?.error || err?.message || "ห้องนี้ถูกตัดสินไปแล้ว");
      view.done = Math.max(0, view.done - 1);
      updateHeaderBits();
      return;
    }
    // คืนการ์ด: ถ้ากำลังตัดสินห้องอื่นอยู่ (แผ่นเปิด) ให้กลับมาเป็นใบถัดไป ไม่แทรกใต้นิ้ว
    const back = { ...item, ...(err?.data?.proposal || {}) };
    view.done = Math.max(0, view.done - 1);
    const rest = view.deck.filter((row) => row.id !== back.id);
    view.deck = sheet.isOpen() || view.busy ? [rest[0], back, ...rest.slice(1)].filter(Boolean) : [back, ...rest];
    toast(`บันทึก "ไม่ปิด" ของ ${nameOf(item)} ไม่สำเร็จ — ห้องกลับมารอแล้ว`);
    if (view.deck[0]?.id === back.id) showCurrent({ motion: "return" });
    else updateHeaderBits();
  }

  async function undoKeep(record, mine) {
    // กำลังตัดสินห้องอื่นอยู่ (คำขอยังไม่จบ/แผ่นเปิด) — ย้อนตอนนี้ = การ์ดที่คืนมาถูกพาออกไปพร้อมผลของห้องนั้น
    if (record.revision === null || view?.busy || sheet?.isOpen()) return false;
    try {
      const res = await api(proposalPath(record.item.id, "/undo"), { method: "POST", body: { revision: record.revision } });
      if (view !== mine) return true;
      const back = { ...record.item, ...(res?.proposal || {}) };
      sheet.close({ restore: false });
      view.deck = [back, ...view.deck.filter((row) => row.id !== back.id)];
      view.done = Math.max(0, view.done - 1);
      view.notice = null;
      view.expanded = false;
      showCurrent({ motion: "return" });
      nodes.keepBtn.focus?.();
      toast("ย้อนแล้ว — ห้องนี้กลับมารอยืนยัน");
      return true;
    } catch (err) {
      toast(err?.data?.error || err?.message || "ย้อนไม่สำเร็จ");
      // เลยเวลา/คนอื่นเปลี่ยนแล้ว = ปิดแถบ · เน็ตหลุด = ให้กดย้อนได้อีกครั้ง
      return err?.status === 409 || err?.status === 404;
    }
  }

  async function noteKeep(record, reason) {
    if (record.revision === null || view?.busy) return false;
    try {
      const res = await api(proposalPath(record.item.id, "/note"), { method: "POST", body: { reason, revision: record.revision } });
      if (Number.isInteger(res?.proposal?.revision)) record.revision = res.proposal.revision;
      return true;
    } catch (err) {
      toast(err?.data?.error || err?.message || "บันทึกเหตุไม่สำเร็จ");
      return false;
    }
  }

  /* ---------------------------------- ปิดแชท ---------------------------------- */

  function openSheet() {
    const item = current();
    if (!item || view.busy || sheet.isOpen() || !cardSettled()) return;
    const detail = view.details.get(item.id);
    if (!detail) {
      toast("รอโหลดข้อความของห้องนี้สักครู่นะคะ");
      return;
    }
    const failedBefore = item.status === "send_failed";
    const canSend = !failedBefore && detail.room?.canSendGoodbye !== false;
    const sendBlockedText = failedBefore
      ? "ส่งคำลาครั้งก่อนไม่สำเร็จ ระบบจะไม่ส่งซ้ำเอง — เลือกปิดเงียบ หรือกดยกเลิกแล้วเลือกไม่ปิด"
      : detail.room?.facebook
        ? "ห้อง Facebook นี้เลย 24 ชม. แล้ว ส่งข้อความไม่ได้ — ปิดเงียบได้ (ห้องเป็นสีเหลืองโดยไม่ส่งอะไร)"
        : "ห้องนี้ส่งคำลาไม่ได้ — ปิดเงียบได้";
    sheet.open({
      name: nameOf(item),
      goodbyeText: detail.goodbyeText,
      canSend, sendBlockedText,
      sweepOn: typeof detail.sweepOn === "boolean" ? detail.sweepOn : view.summary?.sweepOn !== false,
      onSend: (ctl) => decideClose(item.id, "confirm", ctl),
      onSilent: (ctl) => decideClose(item.id, "silent", ctl),
      returnFocus: nodes.closeBtn,
    });
  }

  async function decideClose(id, action, ctl) {
    const mine = view;
    const item = mine.deck.find((row) => row.id === id);
    if (!item) { ctl.close(); return; }
    const detail = mine.details.get(id);
    mine.busy = true;
    setActions(item);
    let res;
    const seenMessageId = detail?.latestInboundId || item.baselineInboundId;
    try {
      res = await api(proposalPath(id, "/decide"), {
        method: "POST",
        body: { action, seenMessageId, revision: item.revision },
      });
    } catch (err) {
      if (view !== mine) { ctl.fail(err?.data?.error || err?.message || "ทำรายการไม่สำเร็จ"); return; }
      mine.busy = false;
      closeFailed(item, err, ctl, seenMessageId);
      return;
    }
    if (view !== mine) return;
    ctl.close({ restore: false });
    if (action === "confirm" && res?.closed === false) {
      toast("ส่งคำลาแล้ว แต่ห้องนี้ปิดเป็นสีเหลืองไม่ได้ (มีคนรับห้อง/สถานะเปลี่ยนระหว่างส่ง) — เปิดห้องดูต่อนะคะ");
    } else if (action === "confirm" && res?.customerTypedDuringSend) {
      toast("ส่งคำลาแล้ว ห้องเป็นสีเหลือง · ลูกค้าพิมพ์เข้ามาระหว่างส่ง ระบบจะอ่านข้อความใหม่ให้เอง");
    } else {
      toast(action === "confirm" ? "ส่งคำลาแล้ว ห้องเป็นสีเหลือง" : "ปิดเงียบแล้ว ห้องเป็นสีเหลือง");
    }
    await leave("left");
    if (view !== mine) return;
    dropItem(id);
    mine.done += 1;
    mine.notice = null;
    mine.expanded = false;
    mine.busy = false;
    showCurrent({ motion: "enter" });
    focusCardHeading();
    if (!current()) void refreshEmptySummary();
  }

  function closeFailed(item, err, ctl, seenMessageId = "") {
    const code = err?.data?.code || "";
    const message = err?.data?.error || err?.message || "ทำรายการไม่สำเร็จ ลองอีกครั้งนะคะ";
    if (err?.data?.proposal) replaceItem(err.data.proposal);
    if (code === "customer_typed") {
      ctl.close({ restore: false });
      if (seenMessageId) view.since.set(item.id, String(seenMessageId));
      view.notice = { id: item.id, tone: "warn", text: CUSTOMER_TYPED_TEXT };
      view.expanded = false;
      void ensureDetail(item, { force: true });
      refreshCard();
      nodes.stack.querySelector(".orv-notice")?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (code === "sweep_not_on") {
      view.summary = { ...view.summary, sweepOn: false };
      updateHeaderBits();
      ctl.fail(message, { blockAll: true });
      setActions(current());
      return;
    }
    if (SILENT_ONLY_CODES.has(code) && err?.data?.canSilent !== false) {
      ctl.fail(message, { silentOnly: true });
      refreshCard();
      return;
    }
    if (DROP_CODES.has(code) || code === "stale_revision" || (code === "send_failed" && err?.data?.canSilent === false)) {
      ctl.close({ restore: false });
      toast(message);
      if (code === "stale_revision" || code === "send_failed") { void reloadDeck(); return; }
      if (dropItem(item.id)) showCurrent({ motion: "enter" });
      else updateHeaderBits();
      return;
    }
    ctl.fail(message);
    setActions(current());
  }

  /* ------------------------------ โหลดคิว / รอบใหม่ ------------------------------ */

  // ตรวจครบแล้ว — ตัวเลข "วันนี้ปิดแล้ว/ไม่ปิด" บนหน้าว่างต้องนับห้องที่เพิ่งกดด้วย (หลังคำขอสุดท้ายจบ)
  async function refreshEmptySummary() {
    const mine = view;
    if (!mine || current()) return;
    const summary = await api(`${BASE}/summary?peek=1`).catch(() => null);
    if (view !== mine || !summary || current()) return;
    mine.summary = summary;
    nodes.banners.replaceChildren(...statusBanners(summary));
    nodes.stack.replaceChildren(emptyDeck({ summary, finished: mine.done }));
  }

  async function reloadDeck({ peek = false } = {}) {
    const mine = view;
    const [summary, list] = await Promise.all([
      api(`${BASE}/summary${peek ? "?peek=1" : ""}`).catch(() => null),
      api(`${BASE}/proposals?view=open&limit=${LIST_LIMIT}`).catch(() => null),
    ]);
    if (view !== mine || !list) return;
    if (summary) mine.summary = summary;
    mine.deck = sortDeck(list.rows);
    mine.notice = null;
    showCurrent({ motion: "enter" });
  }

  function armEmptyPoll() {
    stopPolling();
    if (!view || view.tab !== "close") return;
    const mine = view;
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = null;
      if (view !== mine || !onPage() || current()) return;
      if (globalThis.document?.visibilityState === "hidden") { armEmptyPoll(); return; }
      try {
        // peek: หน้าเปิดค้างไว้ไม่ใช่ "เจ้าของเพิ่งเปิดดู" — ห้ามล้างแจ้งเตือนที่มือถือยังไม่ได้อ่าน
        await reloadDeck({ peek: true });
      } finally {
        if (view === mine && !current() && !state.pollTimer && onPage()) armEmptyPoll();
      }
    }, EMPTY_POLL_MS);
  }

  /* ---------------------------------- เข้าหน้า ---------------------------------- */

  function buildShell() {
    const progress = createProgress();
    const stack = el("div", { class: "orv-stack" });
    const closeBtn = el("button", { type: "button", class: "orv-act is-close", onclick: () => openSheet(), onkeydown: blockKeyRepeat },
      el("span", { class: "orv-act-hint", "aria-hidden": "true" }, "‹"), el("span", {}, "ปิดแชท"));
    const keepBtn = el("button", { type: "button", class: "orv-act is-keep", onclick: () => keep(), onkeydown: blockKeyRepeat },
      el("span", {}, "ไม่ปิด"), el("span", { class: "orv-act-hint", "aria-hidden": "true" }, "›"));
    const thumbBtns = el("div", { class: "orv-thumb-btns", role: "group", "aria-label": "ตัดสินห้องนี้" }, closeBtn, keepBtn);
    // แถบย้อนอยู่ในแถบปุ่มล่าง (ในโฟลว์ ไม่ลอยทับ) — เลื่อนการ์ดขึ้นมาเหนือแถบได้เสมอ และอยู่ใต้แผ่นยืนยันปิด
    const toastHost = el("div", { class: "orv-toast-host" });
    const thumb = el("div", { class: "orv-thumb" }, toastHost, thumbBtns);
    const tabs = el("div", { class: "orv-tabs" });
    const banners = el("div", { class: "orv-banners" });
    const live = el("p", { class: "orv-sr", role: "status", "aria-live": "polite" });
    const sheetHost = el("div", { class: "orv-sheet-host" });
    const hint = el("p", { class: "orv-swipe-hint" }, "ปัดการ์ดไปทางขวา = ไม่ปิด · ปัดซ้าย = ปิดแชท");
    const content = view.tab === "close"
      ? [progress.node, hint, stack, thumb]
      : daily.content;
    mount(
      pageHeader("ห้องตรวจ"),
      el("main", { class: "page-scroll orv-scroll" },
        el("div", { class: `orv orv-tab-${view.tab}` }, tabs, banners, content)),
      sheetHost, live, daily ? daily.overlay : null,
      tabBar(),
    );
    setView("page");
    nodes = { progress, stack, hint, thumb, thumbBtns, closeBtn, keepBtn, tabs, banners, live };
    sheet = createCloseSheet({ host: sheetHost, armMs: sheetArmMs, onDetachedFail: (message) => toast(message) });
    undo = createUndoToast({ host: toastHost });
  }

  async function render({ tab = ownerReviewTab(globalThis.location?.hash) } = {}) {
    stopPolling();
    sheet?.close({ restore: false });
    undo?.hide();
    daily?.destroy();
    daily = null;
    const mine = ++gen;
    const routeGen = state.routeGen;
    // คิวตรวจแชทล้ม (เช่นวันที่ขอไม่มีแล้ว = 404) ไม่ทำให้ทั้งหน้าล้ม — แท็บบอกเองแล้วให้ลองใหม่/กลับคิวล่าสุด
    const [summary, list, queue] = await Promise.all([
      api(`${BASE}/summary`),
      tab === "close" ? api(`${BASE}/proposals?view=open&limit=${LIST_LIMIT}`) : Promise.resolve(null),
      tab === "daily"
        ? api(dailyQueuePath(dailyBatchFromHash(globalThis.location?.hash))).then((data) => ({ data }), (error) => ({ error }))
        : Promise.resolve(null),
    ]);
    // มีการเปิดหน้าใหม่กว่า หรือผู้ใช้ไปหน้าอื่นแล้ว — ทิ้งผลชุดนี้
    if (mine !== gen || routeGen !== state.routeGen) return;
    view = {
      tab, summary, deck: tab === "close" ? sortDeck(list?.rows) : [], done: 0, dailyWaiting: undefined,
      details: new Map(), detailState: new Map(), since: new Map(), expanded: false, notice: null, busy: false, shownAt: 0,
    };
    if (tab === "daily") {
      const owner = view;
      daily = createDailyReview({
        api, toast, state, stopPolling, armMs,
        onWaiting: (count) => { if (view === owner && nodes) { owner.dailyWaiting = count; updateHeaderBits(); } },
      });
    }
    buildShell();
    if (tab === "close") showCurrent();
    else {
      updateHeaderBits();
      daily.start(queue?.data ?? null, { error: queue?.error ?? null });
    }
  }

  return render;
}
