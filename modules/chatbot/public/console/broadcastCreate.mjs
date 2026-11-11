// broadcastCreate.mjs — แท็บ "สร้างบรอดแคสต์" ของสตูดิโอ (28 ก.ย. 2026)
// ① เลือกผู้รับ (4 โหมด) ② เขียนข้อความ (สูงสุด 5 บับเบิล) ③ ส่งเมื่อไร → ตัวอย่างหน้าจอ LINE + ผู้รับ/โควตาสด
// การส่งจริง: ตรวจ (preview) → หน้ายืนยันสรุปทุกอย่าง + พิมพ์ยืนยัน → ส่ง · เซิร์ฟเวอร์ตรวจซ้ำทุกด่าน
import { el } from "./dom.mjs";
import { createBroadcastSegmentStore, formatBangkokDatetimeLocal, parseBangkokDatetimeLocal, put } from "./broadcastState.mjs";
import { bubbleIsReady, createComposer, newBubble, renderLinePreview, serializeBubbles } from "./broadcastComposer.mjs";
import {
  AUDIENCE_MODES, allFriendsPanel, audienceGroupPanel, audienceTargetPayload, createAudienceState, demographicPanel, tagPanel,
} from "./broadcastAudience.mjs";

const RECONFIRM_AFTER_MS = 38_000; // ใบยืนยันอายุ 45 วิ — ขอใบใหม่ก่อนหมดเสมอ

export function createStudioStore() {
  const byChannel = new Map();
  const segments = createBroadcastSegmentStore();
  return {
    segments,
    get(channelId) {
      const key = String(channelId || "default");
      if (!byChannel.has(key)) {
        byChannel.set(key, {
          ...createAudienceState(),
          bubbles: [newBubble("text")],
          when: "now", scheduleAt: "", notificationDisabled: false, trackClicks: true,
        });
      }
      return byChannel.get(key);
    },
    // ใช้เป็นแม่แบบจากประวัติ — ไม่ส่งอะไร แค่เติมฟอร์ม
    applyTemplate(channelId, { mode = "tags", includeTags = [], excludeTags = [], target = {}, bubbles = [] } = {}) {
      const state = this.get(channelId);
      state.mode = mode;
      segments.replace(channelId, { includeTags, excludeTags });
      state.audience.include = new Set((target.include || []).map(Number));
      state.audience.exclude = new Set((target.exclude || []).map(Number));
      const d = state.demographic;
      d.gender = new Set(target.gender || []);
      d.appType = new Set(target.appType || []);
      d.area = new Set(target.area || []);
      d.age = { gte: target.age?.gte || "", lt: target.age?.lt || "" };
      d.subscriptionPeriod = { gte: target.subscriptionPeriod?.gte || "", lt: target.subscriptionPeriod?.lt || "" };
      state.bubbles = bubbles.length ? bubbles : [newBubble("text")];
      return state;
    },
  };
}

/** payload ร่วมของ estimate/preview/send — ผูกกับโหมดที่เลือกเท่านั้น */
export function studioPayload(state, segments, channelId) {
  const base = {
    channelId, mode: state.mode, messages: serializeBubbles(state.bubbles),
    notificationDisabled: state.notificationDisabled === true, trackClicks: state.trackClicks !== false,
  };
  if (state.mode === "tags") {
    const snapshot = segments.snapshot(channelId);
    return { ...base, includeTags: snapshot.includeTags, excludeTags: snapshot.excludeTags };
  }
  return { ...base, target: audienceTargetPayload(state) };
}

export function tagLabel(tag) {
  if (tag === "*") return "ทุกคนที่ระบบรู้จัก";
  return String(tag).replace(/\s*:\s*\*$/u, ": ทุกค่า");
}

export function formatCount(value) {
  return Number.isSafeInteger(value) ? value.toLocaleString("th-TH") : "—";
}

export function quotaBar(quota, use, { unknownUse = false, useLabel = "ครั้งนี้ประมาณ", afterLabel = "เหลือหลังส่ง" } = {}) {
  if (quota?.type !== "limited") {
    return el("p", { class: "bs-quota-line" }, quota?.type === "unlimited" ? "โควตา LINE แบบไม่จำกัด" : "ยังอ่านโควตา LINE ไม่ได้ — ระบบตรวจอีกครั้งก่อนรับงาน");
  }
  const limit = Math.max(1, Number(quota.limit) || 1);
  const used = Math.min(limit, Number(quota.used) || 0);
  const planned = Math.max(0, Math.min(limit - used, Number(use) || 0));
  const after = Number(quota.remaining) - (Number(use) || 0);
  const track = el("span", { class: "bs-quota-track", "aria-hidden": "true" });
  const usedFill = el("span", { class: "bs-quota-used" });
  const planFill = el("span", { class: `bs-quota-plan${after < 0 ? " is-over" : ""}` });
  // CSP ห้าม style attribute — ความยาวแถบตั้งผ่าน CSSOM (แบบเดียวกับการ์ด LINE OA เดือนนี้)
  usedFill.style.transform = `scaleX(${used / limit})`;
  planFill.style.transform = `translateX(${(used / limit) * 100}%) scaleX(${planned / limit})`;
  track.append(usedFill, planFill);
  return el("div", { class: "bs-quota" },
    el("div", { class: "bs-quota-top" },
      el("span", {}, "โควตาเดือนนี้"),
      el("strong", { class: after < 0 ? "is-bad" : "" }, after < 0 ? `ไม่พอ ${formatCount(-after)}` : `${afterLabel} ${formatCount(after)}`)),
    track,
    el("span", { class: "bs-quota-legend" }, `ใช้ไปแล้ว ${formatCount(used)} / ${formatCount(limit)} · ${unknownUse
      ? "ครั้งนี้ LINE คำนวณตอนส่ง (ไม่ส่งแบบแหว่งถ้าโควตาไม่พอ)"
      : `${useLabel} ${formatCount(Number(use) || 0)}`}`));
}

export function createBroadcastCreateTab(deps, store) {
  const { api, toast, uploadMedia, state: appState } = deps;
  let estimateGen = 0;
  let estimateTimer = null;

  function render({ meta, channelId, channelName, onSent, selfTestNode = null }) {
    const state = store.get(channelId);
    const segments = store.segments;
    if (meta.tracking?.enabled !== true) state.trackClicks = false;
    const lineSideAvailable = meta.lineSide?.available === true;
    if (!lineSideAvailable && state.mode !== "tags") state.mode = "tags";
    const summary = { data: null, loading: false };

    const previewSlot = el("div", { class: "bs-preview-slot" });
    const summarySlot = el("div", { class: "bs-summary", "aria-live": "polite" });
    const modePanelSlot = el("div", { class: "bs-mode-panel" });
    const sendButton = el("button", { type: "button", class: "btn btn-primary bs-send" }, "ตรวจและส่ง");
    const testButton = el("button", { type: "button", class: "btn btn-outline bs-test" }, "ส่งทดสอบถึงตัวเอง");

    const whenLabel = () => (state.when === "later" && state.scheduleAt
      ? `ตั้งเวลา ${state.scheduleAt.replace("T", " ")} น.` : "ส่งทันที");

    const renderPreview = () => {
      put(previewSlot, renderLinePreview({
        bubbles: state.bubbles, meta, oaName: channelName, when: state.when === "later" ? whenLabel() : "ตอนนี้",
      }));
    };

    const canSubmit = () => {
      const ready = state.bubbles.some(bubbleIsReady) && state.bubbles.every(bubbleIsReady);
      const d = summary.data;
      if (!meta.canSend || !ready || summary.loading || !d) return false;
      if (d.invalid || d.unselected || d.overCap) return false;
      if (state.mode === "tags" && !(d.estimate > 0)) return false;
      if (state.mode === "all" && !Number.isSafeInteger(d.estimate)) return false;
      if (state.when === "later" && !parseBangkokDatetimeLocal(state.scheduleAt)) return false;
      return true;
    };

    const syncButtons = () => {
      sendButton.disabled = !canSubmit();
      sendButton.textContent = state.when === "later" ? "ตรวจและตั้งเวลา" : "ตรวจและส่ง";
      testButton.disabled = !(meta.canTestSend && state.bubbles.some(bubbleIsReady) && state.bubbles.every(bubbleIsReady));
    };

    const renderSummary = () => {
      const d = summary.data;
      const modeMeta = AUDIENCE_MODES.find((entry) => entry.mode === state.mode);
      let headline = "—";
      let caption = "";
      if (summary.loading) {
        headline = "…";
        caption = "กำลังคำนวณ";
      } else if (d?.unselected) {
        caption = "ยังไม่ได้เลือกผู้รับ";
      } else if (d?.invalid) {
        caption = d.invalid;
      } else if (d) {
        headline = Number.isSafeInteger(d.estimate) ? formatCount(d.estimate) : "LINE คำนวณ";
        caption = d.estimateKind === "exact" ? "คน (นับจากรายชื่อจริง)"
          : d.estimateKind === "line_estimate" ? (d.upperBound ? "คน (สูงสุด ตามจำนวนในกลุ่ม)" : "คน (ประมาณจากสถิติ LINE)")
            : d.reason === "followers_unavailable" ? "อ่านจำนวนเพื่อนจาก LINE ไม่ได้"
              : "ผู้รับตอนส่ง";
      }
      put(summarySlot, 
        el("div", { class: "bs-summary-head" },
          el("span", { class: "bs-summary-mode" }, modeMeta?.title || ""),
          el("span", { class: "bs-summary-when" }, whenLabel())),
        el("div", { class: "bs-summary-reach" },
          el("span", { class: "bs-summary-num" }, headline),
          el("span", { class: "bs-summary-cap" }, caption)),
        d?.overCap ? el("p", { class: "bs-warn" }, `เกินเพดาน ${formatCount(meta.limits?.tagAudienceCap)} คนต่อครั้งของการส่งตามป้าย — ใช้โหมดเพื่อนทุกคน/กลุ่มเป้าหมาย`) : null,
        d?.targetedReaches !== null && d?.targetedReaches !== undefined && state.mode === "demographic"
          ? el("p", { class: "bs-muted" }, `เพื่อนที่ LINE ระบุข้อมูลได้ ${formatCount(d.targetedReaches)} คน (เพดานบน)`) : null,
        d?.sample?.length ? el("p", { class: "bs-muted bs-sample" }, `เช่น ${d.sample.join(" · ")}`) : null,
        quotaBar(d?.quota || meta.quota, Number.isSafeInteger(d?.estimate) ? d.estimate : 0, {
          unknownUse: Boolean(d) && !d.unselected && !d.invalid && !Number.isSafeInteger(d.estimate),
        }),
      );
      syncButtons();
    };

    const refreshEstimate = () => {
      clearTimeout(estimateTimer);
      const gen = ++estimateGen;
      summary.loading = true;
      renderSummary();
      estimateTimer = setTimeout(async () => {
        try {
          const payload = studioPayload(state, segments, channelId);
          const data = await api("/console/api/broadcast/studio/estimate", { method: "POST", body: payload });
          if (gen !== estimateGen) return;
          summary.data = data;
        } catch (error) {
          if (gen !== estimateGen) return;
          summary.data = { invalid: error.message };
        }
        summary.loading = false;
        renderSummary();
      }, 280);
    };

    const renderModePanel = () => {
      const onChange = () => refreshEstimate();
      const panel = state.mode === "all" ? allFriendsPanel({ meta })
        : state.mode === "audience" ? audienceGroupPanel({ api, channelId, state, onChange, toast })
          : state.mode === "demographic" ? demographicPanel({ meta, state, onChange })
            : tagPanel({ meta, segments, channelId, onChange });
      put(modePanelSlot, panel);
    };

    const modeCards = el("div", { class: "bs-modes", role: "radiogroup", "aria-label": "เลือกผู้รับ" },
      AUDIENCE_MODES.map((entry) => {
        const disabled = entry.lineSide && !lineSideAvailable;
        const card = el("button", {
          type: "button", role: "radio", class: `bs-mode${state.mode === entry.mode ? " is-active" : ""}`,
          "aria-checked": state.mode === entry.mode ? "true" : "false", disabled: disabled ? true : null,
          title: disabled ? (meta.lineSide?.reason === "pilot_mode" ? "โหมดนำร่องเปิดอยู่" : "ช่องส่ง LINE ยังไม่เปิด") : null,
          onclick: () => {
            if (state.mode === entry.mode) return;
            state.mode = entry.mode;
            for (const node of modeCards.children) {
              const active = node === card;
              node.classList.toggle("is-active", active);
              node.setAttribute("aria-checked", active ? "true" : "false");
            }
            summary.data = null;
            renderModePanel();
            refreshEstimate();
          },
        },
          el("span", { class: "bs-mode-glyph", "aria-hidden": "true" }, entry.glyph),
          el("span", { class: "bs-mode-copy" }, el("strong", {}, entry.title), el("span", {}, entry.sub)));
        return card;
      }));

    const composer = createComposer({
      meta, bubbles: state.bubbles, toast, uploadMedia, tracking: state.trackClicks,
      onChange: () => {
        renderPreview();
        syncButtons();
      },
    });

    const scheduleEnabled = meta.scheduling?.enabled === true;
    const timeInput = el("input", {
      class: "order-in bs-input keep-focus", type: "datetime-local", step: "60", "aria-label": "วันและเวลาส่ง (เวลาไทย)",
      disabled: state.when === "later" ? null : true,
      oninput: (event) => { state.scheduleAt = event.target.value; renderPreview(); renderSummary(); },
    });
    timeInput.value = state.scheduleAt || "";
    const whenRadio = (value, label, disabled = false) => {
      const input = el("input", {
        type: "radio", name: "bs-when", value, checked: state.when === value ? "checked" : null, disabled: disabled ? true : null,
        onchange: () => {
          state.when = value;
          timeInput.disabled = value !== "later";
          if (value === "later" && !state.scheduleAt) {
            state.scheduleAt = formatBangkokDatetimeLocal(Date.now() + 3_600_000).replace(/:\d{2}$/u, ":00");
            timeInput.value = state.scheduleAt;
          }
          renderPreview();
          renderSummary();
        },
      });
      return el("label", { class: `bs-radio${disabled ? " is-disabled" : ""}` }, input, el("span", {}, label));
    };
    const toggle = (label, hint, checked, onToggle, disabled = false) => el("label", { class: `bs-toggle${disabled ? " is-disabled" : ""}` },
      el("input", { type: "checkbox", checked: checked ? "checked" : null, disabled: disabled ? true : null, onchange: (event) => onToggle(event.target.checked) }),
      el("span", { class: "bs-toggle-copy" }, el("strong", {}, label), el("span", {}, hint)));

    const whenSection = el("div", { class: "bs-when" },
      el("div", { class: "bs-when-options" },
        whenRadio("now", "ส่งทันที"),
        whenRadio("later", "ตั้งเวลาส่ง", !scheduleEnabled),
        timeInput),
      scheduleEnabled
        ? el("p", { class: "block-hint" }, "ตั้งได้ 09:00–20:59 น. เวลาไทย · ถึงเวลาแล้วระบบตรวจผู้รับ ข้อความ และโควตาใหม่ก่อนส่งจริง")
        : el("p", { class: "block-hint" }, meta.scheduling?.reason || "ระบบตั้งเวลายังปิดอยู่"),
      toggle("ส่งแบบไม่มีเสียงแจ้งเตือน", "ลูกค้าเห็นข้อความแต่มือถือไม่เด้งเสียง (LINE notificationDisabled)",
        state.notificationDisabled, (value) => { state.notificationDisabled = value; }),
      toggle("นับคลิกลิงก์", meta.tracking?.enabled ? "ลิงก์ในข้อความ/ปุ่มถูกแปลงเป็นลิงก์สั้นของเราเพื่อนับคลิก (ไม่มีข้อมูลลูกค้าในลิงก์)" : "ยังไม่ได้ตั้งโดเมนสาธารณะ — ส่งลิงก์ตามจริงโดยไม่นับ",
        state.trackClicks, (value) => { state.trackClicks = value; composer.render(); }, meta.tracking?.enabled !== true),
    );

    /* -------------------------- ยืนยันก่อนส่ง -------------------------- */

    // แถว "ตัดออกไม่ได้" แสดงเรื่องเดียวกันเป็นตัวเลขแล้ว — ไม่พูดซ้ำในรายการคำเตือน
    const sheetWarnings = (s) => (s.warnings || []).filter((text) => !(s.unprotected && String(text).startsWith("LINE เป็นคนเลือกผู้รับ")));

    // ใครถูกตัดออกบ้าง — โหมดตามป้ายตัดให้ครบ · โหมดฝั่ง LINE ตัดไม่ได้ ต้องเห็นตัวเลขก่อนกดยืนยัน
    function exclusionFacts(s) {
      if (s.mode === "tags") return [el("dt", {}, "ตัดออกให้"), el("dd", {}, "ขอหยุดทัก · ปฏิเสธการตลาด · สแปม (null) · คนที่บล็อก")];
      const u = s.unprotected;
      const text = u && u.total > 0
        ? `${formatCount(u.total)} ห้องที่ปกติเราไม่ส่งจะได้รับด้วยถ้าอยู่ในกลุ่มนี้ (ขอหยุดทัก ${formatCount(u.dnd)} · ปฏิเสธการตลาด ${formatCount(u.optout)} · สแปม ${formatCount(u.spam)})`
        : "LINE เลือกผู้รับเอง ระบบตัดใครออกให้ไม่ได้ (ตอนนี้ยังไม่พบห้องที่ขอหยุดทัก/สแปม)";
      return [el("dt", {}, "ตัดออกไม่ได้"), el("dd", { class: u?.total > 0 ? "bs-fact-alert" : "" }, text)];
    }

    async function openConfirm() {
      const payload = { ...studioPayload(state, segments, channelId) };
      const forSchedule = state.when === "later";
      if (forSchedule) payload.scheduledAt = parseBangkokDatetimeLocal(state.scheduleAt);
      sendButton.disabled = true;
      let preview;
      try {
        preview = await api("/console/api/broadcast/studio/preview", { method: "POST", body: payload });
      } catch (error) {
        toast(error.message);
        syncButtons();
        return;
      }
      syncButtons();
      let issuedAt = Date.now();
      const s = preview.summary;
      const typed = el("input", {
        class: "order-in bs-input bs-confirm-input keep-focus", inputmode: /^\d+$/u.test(s.expectedConfirmText) ? "numeric" : "text",
        autocomplete: "off", "aria-label": "พิมพ์เพื่อยืนยัน",
        oninput: () => { go.disabled = typed.value.trim() !== s.expectedConfirmText; },
      });
      const status = el("p", { class: "bs-confirm-status", "aria-live": "polite" });
      const go = el("button", { type: "button", class: "btn btn-primary", disabled: true }, forSchedule ? "ตั้งเวลา" : "ส่งเลย");
      const cancel = el("button", { type: "button", class: "btn btn-ghost" }, "ยกเลิก");
      const dialog = el("dialog", { class: "bs-sheet", "aria-labelledby": "bs-sheet-title" },
        el("form", { class: "bs-sheet-body", method: "dialog", onsubmit: (event) => event.preventDefault() },
          el("h2", { id: "bs-sheet-title", class: "bs-sheet-title" }, forSchedule ? "ยืนยันตั้งเวลาบรอดแคสต์" : "ยืนยันส่งบรอดแคสต์"),
          el("dl", { class: "bs-facts" },
            el("dt", {}, "LINE OA"), el("dd", {}, s.channelName),
            el("dt", {}, "ผู้รับ"), el("dd", {},
              `${s.modeLabel} · ${Number.isSafeInteger(s.estimate) ? `${formatCount(s.estimate)} คน${s.estimateKind === "exact" ? "" : " (ประมาณ)"}` : "LINE คำนวณตอนส่ง"}`),
            s.includeTags?.length ? el("dt", {}, "ป้าย") : null,
            s.includeTags?.length ? el("dd", {}, `ส่ง: ${s.includeTags.map(tagLabel).join(", ")}${s.excludeTags?.length ? ` · เว้น: ${s.excludeTags.map(tagLabel).join(", ")}` : ""}`) : null,
            el("dt", {}, "ข้อความ"), el("dd", {}, `${s.bubbles} บับเบิล${s.notificationDisabled ? " · ไม่มีเสียงแจ้งเตือน" : ""}${s.trackClicks ? " · นับคลิกลิงก์" : ""}`),
            el("dt", {}, "โควตา"), el("dd", {}, s.quota?.type === "limited"
              ? `ใช้ประมาณ ${Number.isSafeInteger(s.estimate) ? formatCount(s.estimate) : "ตามที่ LINE คำนวณ"} · คงเหลือตอนนี้ ${formatCount(s.quota.remaining)}`
              : (s.quota?.type === "unlimited" ? "ไม่จำกัด" : "ตรวจอีกครั้งตอนส่ง")),
            el("dt", {}, "เวลา"), el("dd", {}, forSchedule ? `${state.scheduleAt.replace("T", " ")} น. (เวลาไทย)` : "ทันทีหลังกดส่ง"),
            ...exclusionFacts(s)),
          sheetWarnings(s).length ? el("ul", { class: "bs-warn-list" }, sheetWarnings(s).map((text) => el("li", {}, text))) : null,
          el("div", { class: "bs-sheet-preview" }, renderLinePreview({ bubbles: state.bubbles, meta, oaName: s.channelName, when: forSchedule ? whenLabel() : "ตอนนี้" })),
          el("label", { class: "bs-confirm" },
            el("span", {}, "พิมพ์ ", el("strong", { class: "bs-confirm-code" }, s.expectedConfirmText), " เพื่อยืนยัน — ส่งแล้วเรียกคืนไม่ได้"),
            typed),
          status,
          el("div", { class: "bs-sheet-actions" }, cancel, go)));
      const close = () => {
        try { dialog.close?.(); } catch { /* ปิดไปแล้ว */ }
        dialog.remove();
      };
      cancel.addEventListener("click", close);
      go.addEventListener("click", async () => {
        go.disabled = true;
        cancel.disabled = true;
        try {
          if (Date.now() - issuedAt > RECONFIRM_AFTER_MS) {
            status.textContent = "ใบยืนยันใกล้หมดอายุ — กำลังตรวจใหม่…";
            const fresh = await api("/console/api/broadcast/studio/preview", { method: "POST", body: payload });
            if (fresh.summary.expectedConfirmText !== s.expectedConfirmText) {
              status.textContent = `จำนวนผู้รับเปลี่ยนเป็น ${fresh.summary.expectedConfirmText} — ปิดแล้วตรวจใหม่อีกครั้ง`;
              cancel.disabled = false;
              return;
            }
            preview = fresh;
            issuedAt = Date.now();
          }
          const path = forSchedule ? "/console/api/broadcast/studio/schedule" : "/console/api/broadcast/studio/send";
          const response = await api(path, {
            method: "POST",
            body: { ...payload, confirm: true, confirmText: typed.value.trim(), studioConfirmation: preview.studioConfirmation },
          });
          close();
          toast(forSchedule ? "ตั้งเวลาแล้ว — ยังไม่มีการส่ง LINE ในขั้นตอนนี้" : `รับงานบรอดแคสต์ #${response.broadcast?.broadcastNo ?? ""} แล้ว — ดูผลได้ที่แท็บผลลัพธ์`);
          state.bubbles.splice(0, state.bubbles.length, newBubble("text"));
          onSent?.({ scheduled: forSchedule, response });
        } catch (error) {
          status.textContent = error.message;
          cancel.disabled = false;
          go.disabled = typed.value.trim() !== s.expectedConfirmText;
        }
      });
      globalThis.document.body.append(dialog);
      if (typeof dialog.showModal === "function") dialog.showModal();
      queueMicrotask(() => typed.focus?.());
    }

    sendButton.addEventListener("click", openConfirm);
    testButton.addEventListener("click", async () => {
      if (!globalThis.window?.confirm?.("ส่งข้อความนี้ถึง LINE ทดสอบของคุณ (ที่ยืนยันไว้กับ OA นี้) 1 ครั้ง — เป็นการส่งจริงและนับโควตา 1 ข้อความ")) return;
      testButton.disabled = true;
      try {
        const response = await api("/console/api/broadcast/studio/test", {
          method: "POST", body: { channelId, confirm: true, messages: serializeBubbles(state.bubbles) },
        });
        toast(response.notice || "LINE รับคำขอส่งทดสอบแล้ว");
      } catch (error) {
        toast(error.message);
      } finally {
        syncButtons();
      }
    });

    renderPreview();
    renderModePanel();
    renderSummary();
    refreshEstimate();

    const section = (no, title, hint, ...children) => el("section", { class: "block bs-step" },
      el("header", { class: "bs-step-head" },
        el("span", { class: "bs-step-no", "aria-hidden": "true" }, no),
        el("span", {}, el("h2", { class: "block-title" }, title), hint ? el("p", { class: "block-hint" }, hint) : null)),
      ...children);

    return el("div", { class: "bs-create" },
      el("div", { class: "bs-main" },
        section("1", "ส่งถึงใคร", lineSideAvailable ? "" : "ช่องส่งฝั่ง LINE (เพื่อนทุกคน/กลุ่มเป้าหมาย/ข้อมูลประชากร) ยังไม่พร้อมใน OA นี้ — ใช้ตามป้ายได้",
          modeCards, modePanelSlot),
        section("2", "ข้อความ", "สูงสุด 5 บับเบิลต่อครั้ง (กติกา LINE) · ตัวกันราคา/คำต้องห้ามตรวจทุกบับเบิลก่อนส่ง", composer.node),
        section("3", "ส่งเมื่อไร", "", whenSection),
      ),
      el("aside", { class: "bs-aside", "aria-label": "ตัวอย่างและสรุป" },
        el("div", { class: "bs-aside-inner" },
          previewSlot,
          summarySlot,
          el("div", { class: "bs-cta" }, sendButton, meta.canTestSend ? testButton : null),
          meta.canSend ? null : el("p", { class: "block-hint" }, "บัญชีนี้ร่างข้อความได้ แต่ส่งจริงไม่ได้"),
          selfTestNode,
          el("p", { class: "bs-oa-note" }, "ข้อความจากหน้านี้ออกผ่าน LINE OA เดียวกับ OA Manager — ถ้าตั้งบรอดแคสต์เดียวกันไว้ใน OA Manager ด้วย ลูกค้าจะได้สองครั้ง"),
        )),
    );
  }

  return { render, store, currentUser: () => appState?.me };
}
