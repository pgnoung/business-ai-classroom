// yolo.mjs — ปุ่ม "⚡ YOLO" ในหัวห้องแชท: ให้ลูกแพรทักห้องนี้ต่อ 1 ครั้งทันที (2026-09-28)
//
// ทำไมแยกไฟล์: หน้าแชทมีคนแก้หลายคนพร้อมกัน — chat.mjs จึงมีแค่ hook สองบรรทัด (ปุ่ม + ชิปใต้ฟอง)
// สถานะกล่องเก็บระดับโมดูลต่อห้อง เพราะหน้าแชท re-render ทั้งหัวห้องทุกรอบ poll — ถ้าเก็บใน DOM
// กล่องที่เปิดค้าง/ข้อความที่พิมพ์ค้าง/ผลการส่ง จะหายทุก ~5 วินาที
// ช่องพิมพ์มีคลาส keep-focus = รอบ poll ข้ามการ re-render ระหว่างพิมพ์ (chat.mjs: chatRefreshMode)
// CSP style-src 'self': ห้าม inline style — ทุกหน้าตาอยู่ใน yolo.css
import { el, isGeneric } from "./dom.mjs";
import { handoffBody, handoffResultPanel } from "./yoloHandoffPanel.mjs";

const MAX_CHARS = 500;
// mode: "followup" (ทักต่อ 1 ครั้ง) | "handoff" (ส่งต่อแอดมิน — 2026-10-15)
const rooms = new Map(); // customerId -> { open, mode, instruction, enableAi, handoffMessage, closeAi, busy, preflight, result }

function roomState(customerId) {
  if (!rooms.has(customerId)) rooms.set(customerId, {
    open: false, mode: "followup", instruction: "", enableAi: false, handoffMessage: "", closeAi: true,
    busy: false, preflight: null, result: null,
  });
  return rooms.get(customerId);
}

export function canUseYolo(state) {
  // white-label: ร้านทั่วไปไม่มี YOLO (ช่องสั่งงานพิเศษของ production) — course เหมือนเดิม
  return !isGeneric(state) && state?.me?.capabilities?.includes("yolo.send") === true;
}

// ชิปใต้ฟองข้อความที่ส่งด้วย YOLO — ให้ทีมรู้ว่าข้อความนี้เกิดจากคำสั่งคน ไม่ใช่ลูกแพรทักเอง
export function yoloEvidenceChip(message = {}) {
  if (message.direction !== "out" || message.metadata?.yolo !== true) return null;
  const via = message.metadata?.yoloSource === "telegram" ? "Telegram" : "คอนโซล";
  if (message.metadata?.yoloHandoff === true) {
    return {
      kind: "yolo", tone: "yolo", label: "🔔 ส่งต่อแอดมิน",
      title: `ข้อความที่คนพิมพ์เองตอนกดส่งต่อแอดมิน (สั่งจาก${via}) — ส่งตามที่พิมพ์ ไม่ผ่านโมเดล`,
    };
  }
  return {
    kind: "yolo", tone: "yolo", label: "⚡ YOLO",
    title: `ลูกแพรพิมพ์ต่อตามคำสั่งพี่ง้วง (สั่งจาก${via}) — ส่งครั้งเดียว ไม่เปลี่ยนสวิตช์ AI เว้นแต่สั่งไว้`,
  };
}

function charCount(value) {
  return [...String(value || "")].length;
}

function noticeList(preflight) {
  if (!preflight) return null;
  const items = [];
  if (preflight.refusal) items.push(el("li", { class: "yolo-note is-refusal" }, "🚫 ", preflight.refusal.text));
  for (const item of preflight.confirm || []) items.push(el("li", { class: "yolo-note is-confirm" }, "⚠️ ", item.text));
  for (const item of preflight.warnings || []) items.push(el("li", { class: "yolo-note is-warning" }, item.text));
  return items.length ? el("ul", { class: "yolo-notes", "aria-label": "สิ่งที่ควรรู้ก่อนส่ง" }, items) : null;
}

function resultPanel(result, { onConfirm }) {
  if (!result) return null;
  if (result.status === "needs_confirmation") {
    return el("div", { class: "yolo-result is-confirm", role: "status" },
      el("strong", { class: "yolo-result-title" }, "ต้องยืนยันก่อนส่ง"),
      el("ul", { class: "yolo-result-list" }, (result.confirm || []).map((item) => el("li", {}, item.text))),
      el("button", { class: "btn btn-primary btn-mini yolo-confirm", type: "button", onclick: onConfirm }, "ยืนยันส่ง 1 ครั้ง"));
  }
  if (result.ok) {
    const bubbles = Array.isArray(result.bubbles) && result.bubbles.length ? result.bubbles : [result.sentText || ""];
    const ai = result.customer?.aiEnabled
      ? `AI ห้องนี้เปิดอยู่${result.aiChanged ? " (เพิ่งเปิดตามที่ติ๊ก)" : ""} — ลูกค้าตอบมา ลูกแพรคุยต่อให้`
      : "AI ห้องนี้ยังปิดอยู่ — ลูกค้าตอบมา ทีมต้องดูแลต่อเอง";
    return el("div", { class: `yolo-result ${result.status === "partial" ? "is-partial" : "is-sent"}`, role: "status" },
      el("strong", { class: "yolo-result-title" }, result.status === "partial"
        ? `ส่งได้บางส่วน (${result.delivered}/${result.expected}) — ตรวจในห้องก่อนสั่งซ้ำ`
        : "ส่งถึงลูกค้าแล้ว"),
      el("div", { class: "yolo-sent" }, bubbles.map((text) => el("p", { class: "yolo-sent-bubble" }, text))),
      result.images?.length ? el("p", { class: "yolo-meta" }, `🖼 รูป: ${result.images.join(", ")}`) : null,
      el("p", { class: "yolo-meta" }, ai),
      // FU อัตโนมัติทำงานเฉพาะห้องที่ AI เปิด — ห้องที่ทีมดูแลไม่ต้องรายงานเรื่องบันได
      result.ladder && result.ladder.after > result.ladder.before && result.customer?.aiEnabled
        ? el("p", { class: "yolo-meta" }, `FU อัตโนมัติเลื่อนไปขั้น ${result.ladder.after}/${result.ladder.ladderLength} — วันนี้ไม่ทักซ้ำ`)
        : null,
      (result.warnings || []).map((item) => el("p", { class: "yolo-meta is-warning" }, `⚠️ ${item.text}`)));
  }
  return el("div", { class: "yolo-result is-refused", role: "alert" },
    el("strong", { class: "yolo-result-title" }, "ยังไม่ได้ส่ง"),
    el("p", { class: "yolo-meta" }, result.reasonText || result.error || "ส่งไม่สำเร็จ"),
    result.detail ? el("p", { class: "yolo-meta is-muted" }, `รายละเอียด: ${result.detail}`) : null);
}

function modeTabs(ctx, room) {
  const tab = (mode, label) => el("button", {
    class: `yolo-tab${room.mode === mode ? " is-active" : ""}`, type: "button", role: "tab",
    "aria-selected": room.mode === mode ? "true" : "false",
    onclick: () => {
      if (room.mode === mode || room.busy) return;
      room.mode = mode;
      room.result = null;
      rerender(ctx);
      globalThis.document?.querySelector?.(".yolo-input")?.focus?.();
    },
  }, label);
  return el("div", { class: "yolo-tabs", role: "tablist", "aria-label": "เลือกสิ่งที่จะให้ทำ" },
    tab("followup", "⚡ ทักต่อ 1 ครั้ง"), tab("handoff", "🔔 ส่งต่อแอดมิน"));
}

function contextLine(customer, aiOn) {
  return el("p", { class: "yolo-context" },
    el("span", { class: `yolo-chip ${aiOn ? "is-on" : "is-off"}` }, aiOn ? "AI เปิด" : "AI ปิด"),
    " ", String(customer?.known_name || customer?.display_name || "ลูกค้า"),
    customer?.channel_id === "facebook" ? " · Facebook" : " · LINE");
}

function popoverHead(ctx, title) {
  return el("div", { class: "yolo-pop-head" },
    el("strong", { class: "yolo-title", id: "yolo-title" }, title),
    el("button", { class: "icon-btn yolo-close", type: "button", "aria-label": "ปิดกล่อง YOLO", onclick: () => close(ctx) }, "✕"));
}

function buildPopover(ctx) {
  const { customerId, customer, aiOn } = ctx;
  const room = roomState(customerId);
  if (room.mode === "handoff") {
    return el("div", { class: "yolo-pop", role: "dialog", "aria-modal": "false", "aria-labelledby": "yolo-title" },
      popoverHead(ctx, "🔔 ส่งต่อแอดมินเลย"),
      modeTabs(ctx, room),
      contextLine(customer, aiOn),
      // ผลอยู่บนสุด — กล่องมี max-height + scroll ถ้าวางท้ายกล่อง ผลจะตกใต้ขอบจอจนคนไม่เห็นว่าส่งแล้ว (ตรวจจริง 15 ต.ค.)
      handoffResultPanel(room.result),
      ...handoffBody({ room, aiOn, onSubmit: () => submitHandoff(ctx), onClose: () => close(ctx) }));
  }
  const counter = el("span", { class: "yolo-count", "aria-live": "polite" }, `${charCount(room.instruction)}/${MAX_CHARS}`);
  const textarea = el("textarea", {
    class: "yolo-input keep-focus", rows: "3", maxlength: String(MAX_CHARS), id: "yolo-instruction",
    placeholder: "เช่น ถามต่อเรื่องจำนวนพนักงาน · ตอบคำถามเรื่อง in-house ที่ค้างไว้",
    oninput: (event) => {
      room.instruction = event.target.value;
      counter.textContent = `${charCount(room.instruction)}/${MAX_CHARS}`;
    },
    onkeydown: (event) => {
      if (event.key === "Escape") close(ctx);
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) submit(ctx, false);
    },
  });
  textarea.value = room.instruction;
  const checkbox = el("input", {
    type: "checkbox", class: "yolo-check", id: "yolo-enable-ai",
    onchange: (event) => { room.enableAi = event.target.checked === true; },
  });
  checkbox.checked = room.enableAi;
  const refused = Boolean(room.preflight?.refusal);
  return el("div", { class: "yolo-pop", role: "dialog", "aria-modal": "false", "aria-labelledby": "yolo-title" },
    popoverHead(ctx, "⚡ ให้ลูกแพรทักต่อ 1 ครั้ง"),
    modeTabs(ctx, room),
    contextLine(customer, aiOn),
    room.preflight === null && !room.result ? el("p", { class: "yolo-meta is-muted" }, "กำลังตรวจห้องนี้…") : noticeList(room.preflight),
    el("label", { class: "yolo-label", for: "yolo-instruction" }, "อยากให้ลูกแพรทักอะไรต่อ (ไม่ใส่ก็ได้)"),
    textarea,
    el("div", { class: "yolo-row" },
      aiOn ? el("span", { class: "yolo-meta is-muted" }, "AI ห้องนี้เปิดอยู่แล้ว")
        : el("label", { class: "yolo-check-label", for: "yolo-enable-ai" }, checkbox, " เปิด AI ห้องนี้ต่อด้วย"),
      counter),
    el("p", { class: "yolo-hint" }, "ลูกแพรอ่านบริบททั้งห้อง (ความรู้ · โน้ตทีม · ประวัติแชท) แล้วส่งทันที 1 ข้อความผ่านด่านราคา/ความปลอดภัยชุดเดียวกับ follow-up — ไม่แตะสวิตช์ AI เว้นแต่ติ๊กด้านบน"),
    el("div", { class: "yolo-actions" },
      el("button", { class: "btn btn-ghost btn-mini", type: "button", onclick: () => close(ctx) }, "ปิด"),
      el("button", {
        class: `btn btn-primary btn-mini yolo-send${room.busy ? " is-busy" : ""}`, type: "button",
        disabled: room.busy || refused ? "disabled" : null,
        onclick: () => submit(ctx, false),
      }, room.busy ? "กำลังร่างและส่ง…" : "⚡ ส่ง 1 ครั้ง")),
    resultPanel(room.result, { onConfirm: () => submit(ctx, true) }));
}

function rerender(ctx) {
  const anchor = globalThis.document?.querySelector?.(".yolo-anchor");
  if (anchor && anchor.getAttribute("data-room") === String(ctx.customerId)) anchor.replaceWith(buildAnchor(ctx));
}

function close(ctx) {
  const room = roomState(ctx.customerId);
  room.open = false;
  room.result = null;
  rerender(ctx);
}

async function loadPreflight(ctx) {
  const room = roomState(ctx.customerId);
  try {
    const data = await ctx.api(`/console/api/customers/${encodeURIComponent(ctx.customerId)}/yolo`);
    room.preflight = { refusal: data.refusal || null, confirm: data.confirm || [], warnings: data.warnings || [] };
  } catch (err) {
    room.preflight = { refusal: null, confirm: [], warnings: [{ code: "preflight", text: `ตรวจห้องล่วงหน้าไม่สำเร็จ (${err.message}) — กดส่งได้ ระบบจะตรวจอีกรอบ` }] };
  }
  rerender(ctx);
}

async function submit(ctx, confirm) {
  const room = roomState(ctx.customerId);
  if (room.busy) return;
  room.busy = true;
  room.result = null;
  rerender(ctx);
  try {
    const data = await ctx.api(`/console/api/customers/${encodeURIComponent(ctx.customerId)}/yolo`, {
      method: "POST", body: { instruction: room.instruction, enableAi: room.enableAi === true, confirm: confirm === true },
    });
    room.result = data;
    room.instruction = "";
    room.enableAi = false;
    ctx.toast?.(data.status === "partial" ? "ส่งได้บางส่วน — ตรวจในห้องก่อนสั่งซ้ำ" : "ลูกแพรส่งข้อความแล้ว");
  } catch (err) {
    room.result = err?.data && typeof err.data === "object" ? { ...err.data, error: err.message } : { ok: false, status: "refused", reasonText: err?.message || "ส่งไม่สำเร็จ" };
  } finally {
    room.busy = false;
  }
  rerender(ctx);
  if (room.result?.ok) {
    room.preflight = null;
    await ctx.refresh?.();
    loadPreflight(ctx);
  }
}

async function submitHandoff(ctx) {
  const room = roomState(ctx.customerId);
  if (room.busy) return;
  room.busy = true;
  room.result = null;
  rerender(ctx);
  try {
    const data = await ctx.api(`/console/api/customers/${encodeURIComponent(ctx.customerId)}/yolo`, {
      method: "POST", body: { mode: "handoff", message: room.handoffMessage, closeAi: room.closeAi !== false },
    });
    room.result = data;
    room.handoffMessage = "";
    room.closeAi = true;
    ctx.toast?.(data.reason ? "ส่งต่อแอดมินแล้ว — ข้อความไม่ถึงลูกค้า (ดูในกล่อง)" : "ส่งต่อแอดมินแล้ว");
  } catch (err) {
    room.result = err?.data && typeof err.data === "object" ? { ...err.data, ok: false, error: err.message } : { ok: false, reasonText: err?.message || "ส่งต่อไม่สำเร็จ" };
  } finally {
    room.busy = false;
  }
  rerender(ctx);
  if (room.result?.ok) await ctx.refresh?.();
}

function buildAnchor(ctx) {
  const room = roomState(ctx.customerId);
  const button = el("button", {
    class: `yolo-btn${room.open ? " is-active" : ""}`, type: "button",
    title: "YOLO — ให้ลูกแพรทักห้องนี้ต่อ 1 ครั้งทันที", "aria-label": "YOLO: ให้ลูกแพรทักห้องนี้ต่อ 1 ครั้ง",
    "aria-haspopup": "dialog", "aria-expanded": room.open ? "true" : "false",
    onclick: () => {
      room.open = !room.open;
      if (room.open) {
        room.result = null;
        room.preflight = null;
        loadPreflight(ctx);
      }
      rerender(ctx);
      if (room.open) globalThis.document?.querySelector?.(".yolo-input")?.focus?.();
    },
  }, el("span", { class: "yolo-bolt", "aria-hidden": "true" }, "⚡"), el("span", { class: "yolo-btn-label" }, "YOLO"));
  return el("span", { class: "yolo-anchor", "data-room": String(ctx.customerId) }, button, room.open ? buildPopover(ctx) : null);
}

// hook ของ chat.mjs — คืน null เมื่อบัญชีไม่มีสิทธิ์ (พนักงานไม่เห็นปุ่มที่กดไม่ได้)
export function yoloHeadControl({ api, toast, state, customerId, customer, aiOn, refresh }) {
  if (!canUseYolo(state) || !customerId) return null;
  return buildAnchor({ api, toast, customerId, customer, aiOn, refresh });
}

// ให้เทสต์ล้างสถานะระหว่างกรณี (หน้าเว็บจริงไม่เรียก)
export function resetYoloState() {
  rooms.clear();
}
