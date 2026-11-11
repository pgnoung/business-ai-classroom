// Stored chat threads and inert owner review; never calls an inference/send API.
import { el } from "./dom.mjs";
import { comparisonBadge, createReviewState, renderJevDecision, reviewIsDirty } from "./historyAudit.mjs";

const dateFormat = new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", dateStyle: "medium", timeStyle: "short" });
const when = value => Number.isFinite(Number(value)) && value != null ? dateFormat.format(new Date(Number(value))) : "ไม่ระบุเวลา";
const preview = row => String(row.preview || row.content || "").replace(/\s+/gu, " ").slice(0, 120);
const filters = [["all", "ทั้งหมด"], ["agreement", "JEV เห็นตรง"], ["disagreement", "JEV เห็นต่าง"], ["uncertain", "ยังเทียบไม่ครบ"], ["unreviewed", "พี่ยังไม่ตรวจ"], ["reviewed", "พี่ตรวจแล้ว"]];

export function createHistoryPage({ api, mount, pageHeader, tabBar, stopPolling, state, setView, channelName }) {
  let routeGen = 0, mode = "audit", batchId = "", batches = [], threads = [], nextCursor = null;
  let selected = null, transcript = null, decision = null, review = null, cases = [], caseNext = null;
  let error = "", notice = "", form, filter = "all", threadCursor = "", previousCursors = [], caseCursor = "", previousCases = [];
  let listRequest = 0, caseRequest = 0, roomRequest = 0, initRequest = 0, loadingRooms = false, loadingCases = false;
  const current = () => routeGen === state.routeGen && (location.hash || "#/history") === "#/history";
  const button = (label, click, disabled = false) => el("button", { class: "btn btn-ghost", onclick: click, disabled }, label);

  function mayLeave() {
    if (review?.saving) { error = "กำลังบันทึกความเห็น กรุณารอสักครู่"; render(); return false; }
    if (!reviewIsDirty(review)) return true;
    return globalThis.confirm?.("มีความเห็นที่ยังไม่ได้บันทึก ต้องการทิ้งแบบร่างและเปลี่ยนหน้าหรือไม่?") === true;
  }
  function clearRoom() {
    selected = transcript = decision = review = null;
    cases = []; caseNext = null; previousCases = []; caseCursor = "";
    ++caseRequest; ++roomRequest;
  }
  function dirtyGuard(event) {
    if (review?.saving || reviewIsDirty(review)) { event.preventDefault(); event.returnValue = ""; }
  }
  globalThis.addEventListener?.("beforeunload", dirtyGuard);
  document.addEventListener?.("click", event => {
    const href = event.target.closest?.("a")?.getAttribute("href");
    if (current() && href?.startsWith("#/") && href !== "#/history" && !mayLeave()) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);

  function roomRow(row) {
    const counts = row.counts;
    return el("button", { class: `history-thread${selected?.customerId === row.customerId ? " selected" : ""}`, onclick: () => openRoom(row) },
      el("strong", {}, row.customerName || row.displayName || "ไม่มีชื่อ"),
      el("span", {}, `${channelName(row.channelId) || row.channelId || ""} · ${when(row.latestAt)}`),
      counts ? el("div", { class: "history-thread-badges" },
        counts.agreement ? comparisonBadge("agree", `ตรง ${counts.agreement}`) : null,
        counts.disagreement ? comparisonBadge("disagree", `ต่าง ${counts.disagreement}`) : null,
        counts.uncertain ? comparisonBadge("unknown", `ยังเทียบไม่ครบ ${counts.uncertain}`) : null,
        el("small", {}, `พี่ตรวจ ${counts.reviewed || 0}/${counts.cases || 0} เหตุการณ์`)) : el("small", {}, preview(row)));
  }
  function message(row) {
    const actor = row.direction === "in" ? "ลูกค้า" : row.operator === "system" ? "ระบบ" : row.operator ? "แอดมิน" : "ลูกแพร AI";
    return el("article", { class: `history-bubble ${row.direction === "in" ? "in" : "out"}` },
      el("small", {}, actor), el("p", {}, row.content || `[${row.msgType || "ข้อความ"}]`), el("small", {}, when(row.createdAt)));
  }
  function selectBox(label, choices, value, change) {
    const input = el("select", { "aria-label": label, onchange: event => change(event.target.value) }, ...choices.map(([id, text]) => el("option", { value: id }, text)));
    input.value = value;
    return input;
  }
  function resetList(action) {
    if (!mayLeave()) { render(); return; }
    action(); clearRoom(); previousCursors = []; loadThreads();
  }
  function render() {
    if (!current() || !form) return;
    const batchChoices = batches.map(batch => [batch.batchId, batch.retainedFeedback ? `ความเห็นที่เก็บไว้ · ${String(batch.batchId).slice(0, 8)}` : `ตรวจถึง ${when(batch.cutoffMs)} · ${batch.counts?.cases ?? ""} เหตุการณ์`]);
    const left = el("aside", { class: "history-rooms" },
      el("form", { class: "history-thread-search", onsubmit: event => { event.preventDefault(); resetList(() => {}); } },
        form.q, form.channel,
        mode === "audit" ? selectBox("ชุดตรวจ JEV", batchChoices, batchId, value => resetList(() => { batchId = value; })) : null,
        mode === "audit" ? selectBox("ตัวกรอง JEV", filters, filter, value => resetList(() => { filter = value; })) : null,
        el("button", { class: "btn btn-primary", type: "submit", disabled: loadingRooms }, loadingRooms ? "กำลังค้นหา…" : "ค้นหา")),
      el("div", { class: "history-thread-list" }, ...threads.map(roomRow)),
      !threads.length && !loadingRooms ? el("p", { class: "history-muted" }, "ไม่พบห้องตามตัวกรองนี้") : null,
      el("div", { class: "history-pager" },
        button("ห้องก่อนหน้า", () => { if (mayLeave()) { clearRoom(); loadThreads(previousCursors.pop() || ""); } }, !previousCursors.length || loadingRooms),
        el("span", {}, `หน้า ${previousCursors.length + 1}`),
        button("ห้องถัดไป", () => { if (mayLeave()) { clearRoom(); previousCursors.push(threadCursor); loadThreads(nextCursor); } }, !nextCursor || loadingRooms)));
    const right = el("section", { class: `history-room${selected ? " open" : ""}` },
      selected ? el("button", { class: "history-room-back", onclick: () => { if (mayLeave()) { clearRoom(); render(); } } }, "← กลับไปรายชื่อห้อง") : null,
      selected ? el("header", { class: "history-room-head" }, el("h2", {}, selected.customerName || selected.displayName || "บทสนทนา"),
        el("div", {}, button("ประวัติล่าสุด", () => loadRoom(null)), decision ? button("บริบทก่อนจุดตัดสิน", () => loadRoom(decision.atMs)) : null)) : el("div", { class: "history-room-empty" }, "เลือกห้องสนทนาเพื่ออ่านต่อเนื่อง"),
      selected && mode === "audit" ? el("div", { class: "history-case-picker" },
        el("label", {}, "เหตุการณ์ในห้องนี้", selectBox("เหตุการณ์ JEV", cases.map(item => [item.id, `${when(item.atMs)} · ${item.comparison?.stop === "disagree" || item.comparison?.notify === "disagree" ? "เห็นต่าง" : item.comparison?.stop === "agree" && item.comparison?.notify === "agree" ? "เห็นตรง" : "ยังเทียบไม่ครบ"}`]), decision?.id || "", value => chooseCase(value))),
        el("div", { class: "history-pager" },
          button("เหตุการณ์ก่อนหน้า", () => pageCases(false), !previousCases.length || loadingCases),
          el("span", {}, `หน้า ${previousCases.length + 1}`),
          button("เหตุการณ์ถัดไป", () => pageCases(true), !caseNext || loadingCases))) : null,
      selected && decision ? el("div", { class: "history-decision-mount" }) : null,
      transcript ? el("div", { class: "history-messages" },
        button("ข้อความเก่ากว่า", () => loadRoom(null, transcript.olderCursor, "older"), !transcript.hasOlder),
        el("p", { class: "history-muted" }, transcript.rows.length ? `${when(transcript.rows[0].createdAt)} – ${when(transcript.rows.at(-1).createdAt)} · ${transcript.rows.length} ข้อความ` : "ไม่มีข้อความในช่วงนี้"),
        ...transcript.rows.map(message),
        button("ข้อความใหม่กว่า", () => loadRoom(null, transcript.newerCursor, "newer"), !transcript.hasNewer)) : selected ? el("p", {}, "กำลังโหลดบทสนทนา…") : null);
    const app = el("main", { class: `page-scroll history-shell history-${mode}` }, el("div", { class: "page-inner" },
      el("div", { class: "history-view-tabs" },
        el("button", { class: mode === "audit" ? "active" : "", disabled: !batchId, onclick: () => switchMode("audit") }, "ตรวจ JEV"),
        el("button", { class: mode === "all" ? "active" : "", onclick: () => switchMode("all") }, "ประวัติทั้งหมด")),
      el("p", { class: "history-caveat" }, notice || (mode === "audit" ? "เลือกห้องและเหตุการณ์เพื่อเทียบการตัดสิน แล้วมาร์กความเห็นของพี่ได้เลย" : "รวมทุกช่วงการสนทนาที่ระบบยังเก็บไว้ โหลดครั้งละ 50 ข้อความ")),
      error ? el("p", { class: "history-error", role: "alert" }, error) : null,
      el("div", { class: "history-two-pane" }, left, right)));
    mount(pageHeader(mode === "audit" ? "ตรวจ JEV" : "ประวัติแชท"), app, tabBar()); setView("page");
    const target = document.querySelector(".history-decision-mount");
    if (target && decision) {
      const activeDecision = decision, activeReview = review;
      renderJevDecision(target, { api, batchId, row: decision, review, isOwner: state.me?.role === "owner",
        onSaved: feedback => {
          if (!activeDecision.feedback && selected?.counts) selected.counts.reviewed = (selected.counts.reviewed || 0) + 1;
          activeDecision.feedback = feedback;
        },
        onReload: () => { if (mayLeave()) loadCases(caseCursor, decision?.id); },
        onDirty: () => { if (activeReview === review && !review.saving) error = ""; },
        onFinished: () => { if (activeReview === review) render(); } });
    }
  }

  async function loadThreads(cursor = "") {
    const seq = ++listRequest, expectedMode = mode, expectedBatch = batchId;
    error = ""; loadingRooms = true; render();
    const params = new URLSearchParams({ q: form.q.value.trim(), channel: form.channel.value, limit: "30", filter });
    if (cursor) params.set("cursor", cursor);
    const path = mode === "audit" ? `/console/api/jev-audits/${encodeURIComponent(batchId)}/threads?${params}` : `/console/api/history/threads?${params}`;
    try {
      const data = await api(path);
      if (!current() || seq !== listRequest || expectedMode !== mode || expectedBatch !== batchId) return;
      threads = (data.threads || []).slice(0, 30); nextCursor = data.nextCursor || null; threadCursor = cursor;
    } catch { if (current() && seq === listRequest) error = "โหลดรายชื่อห้องไม่สำเร็จ กรุณาค้นหาใหม่"; }
    finally { if (current() && seq === listRequest) { loadingRooms = false; render(); } }
  }
  async function openRoom(row) {
    if (!mayLeave()) return;
    clearRoom(); selected = row; error = ""; render();
    if (mode === "audit") await loadCases("", row.firstCaseId);
    else await loadRoom(null);
  }
  async function loadRoom(atMs = null, cursor = "", direction = "older") {
    if (!selected || review?.saving) return;
    const seq = ++roomRequest, customerId = selected.customerId;
    const params = new URLSearchParams({ customerId, limit: "50" });
    if (atMs != null && !cursor) params.set("atMs", String(atMs));
    if (cursor) { params.set("cursor", cursor); params.set("direction", direction); }
    try {
      const data = await api(`/console/api/history/transcript?${params}`);
      if (!current() || seq !== roomRequest || selected?.customerId !== customerId) return;
      transcript = { ...data, rows: (data.rows || []).slice(0, 50) }; error = ""; render();
    } catch { if (current() && seq === roomRequest) { error = "เปิดบทสนทนาไม่สำเร็จ กรุณาเลือกประวัติล่าสุดเพื่อลองใหม่"; render(); } }
  }
  async function loadCases(cursor = "", selectedId = "") {
    if (!selected) return;
    const seq = ++caseRequest, customerId = selected.customerId, expectedBatch = batchId;
    loadingCases = true;
    const params = new URLSearchParams({ customerId, limit: "30", filter, channel: form.channel.value });
    if (cursor) params.set("cursor", cursor);
    try {
      const data = await api(`/console/api/jev-audits/${encodeURIComponent(batchId)}/cases?${params}`);
      if (!current() || seq !== caseRequest || selected?.customerId !== customerId || batchId !== expectedBatch) return;
      cases = (data.rows || []).slice(0, 30); caseNext = data.nextCursor || null; caseCursor = cursor;
      decision = cases.find(item => item.id === selectedId) || cases[0] || null;
      review = createReviewState(decision); transcript = null;
      loadingCases = false; render();
      await loadRoom(decision?.atMs ?? null);
    } catch { if (current() && seq === caseRequest) { error = "โหลดจุดตัดสิน JEV ไม่สำเร็จ กรุณาเลือกห้องอีกครั้ง"; } }
    finally { if (current() && seq === caseRequest) { loadingCases = false; render(); } }
  }
  function chooseCase(id) {
    if (!mayLeave()) { render(); return; }
    decision = cases.find(item => item.id === id) || null;
    review = createReviewState(decision); transcript = null; render(); loadRoom(decision?.atMs ?? null);
  }
  function pageCases(next) {
    if (!mayLeave()) return;
    const cursor = next ? caseNext : previousCases.pop() || "";
    if (next) previousCases.push(caseCursor);
    loadCases(cursor);
  }
  function switchMode(next) {
    if (mode === next || !mayLeave() || (next === "audit" && !batchId)) return;
    mode = next; notice = ""; clearRoom(); previousCursors = []; loadThreads();
  }
  return async function renderHistory() {
    stopPolling(); routeGen = state.routeGen; const seq = ++initRequest;
    ++listRequest; ++caseRequest; ++roomRequest; error = "";
    if (form && reviewIsDirty(review)) { render(); return; }
    clearRoom(); threads = [];
    form = { q: el("input", { type: "search", placeholder: "ค้นหาชื่อห้อง หรือข้อความในประวัติทั้งหมด", maxlength: "160", "aria-label": "ค้นหา" }),
      channel: selectBox("สาขา", [["", "ทุกสาขา"], ...(state.channels || []).map(c => [c.id, c.name || c.id])], "", () => {}) };
    render();
    try {
      const data = await api("/console/api/jev-audits");
      if (!current() || seq !== initRequest) return;
      batches = data.batches || []; batchId = batches[0]?.batchId || "";
      if (!batchId) { mode = "all"; notice = "ยังไม่มีผลตรวจ JEV เปิดอ่านประวัติทั้งหมดได้ที่นี่"; }
    } catch {
      if (!current() || seq !== initRequest) return;
      mode = "all"; batchId = ""; notice = "โหลดผล JEV ไม่สำเร็จ ยังเปิดอ่านประวัติทั้งหมดได้";
    }
    await loadThreads();
  };
}
