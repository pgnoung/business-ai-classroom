// stepMessages.mjs — แท็บ "ข้อความตามขั้น" (Step messages) ของหน้าบรอดแคสต์ (28 ก.ย. 2026)
//
// พี่ง้วงขอ: "ให้สร้างระบบ STEP MESSAGE เหมือน LINE OA เลย โดยตอนนี้ step message สามารถทำได้ ใน LINE OA เท่านั้น"
// URL คือสถานะ: #/broadcast/steps = รายการ · …/steps/new[?starter=x] = สร้าง · …/steps/<id> = ผลรายขั้น · …/steps/<id>/edit = แก้
// ดูได้ทุกคนที่เข้าหน้าบรอดแคสต์ได้ · สร้าง/แก้/เปิดใช้/พัก ต้องมีสิทธิ์ส่งบรอดแคสต์ · สวิตช์รวมเฉพาะเจ้าของ
import { el } from "./dom.mjs";
import { put } from "./broadcastState.mjs";
import { formatCount } from "./broadcastCreate.mjs";
import { renderLinePreview, bubblesFromStored } from "./broadcastComposer.mjs";
import {
  STEP_STARTERS, STEP_TRIGGER_OPTIONS, createStepEditor, delayLabel, newStepDraft, stepDraftFromSequence,
} from "./stepEditor.mjs";
import { openActivationSheet } from "./stepActivation.mjs";

const LIST_HASH = "#/broadcast/steps";
export const STEP_STATUS = Object.freeze({
  draft: { label: "ร่าง", tone: "draft" },
  active: { label: "ทำงานอยู่", tone: "active" },
  paused: { label: "พักไว้", tone: "paused" },
  archived: { label: "ปิดแล้ว", tone: "archived" },
});

/** แยกเส้นทางย่อยของแท็บ — list / new / detail / edit */
export function stepRoute(hash = "") {
  const value = String(hash || "");
  const rest = value.startsWith(LIST_HASH) ? value.slice(LIST_HASH.length) : "";
  const match = /^\/([^/?#]+)(\/edit)?(?:\?(.*))?$/u.exec(rest);
  if (!match) return { view: "list" };
  const decode = (text) => { try { return decodeURIComponent(text); } catch { return ""; } };
  if (match[1] === "new") {
    const starter = new URLSearchParams(match[3] || "").get("starter") || "";
    return { view: "new", starter };
  }
  const id = decode(match[1]);
  if (!id) return { view: "list" };
  return { view: match[2] ? "edit" : "detail", id };
}

const stepHash = (id, suffix = "") => `${LIST_HASH}/${encodeURIComponent(id)}${suffix}`;
const triggerGlyph = (type) => STEP_TRIGGER_OPTIONS.find((option) => option.type === type)?.glyph || "•";

function statusChip(status) {
  const meta = STEP_STATUS[status] || { label: status, tone: "draft" };
  return el("span", { class: `sm-status is-${meta.tone}` }, meta.label);
}

function dateText(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  return new Date(value).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit", timeZone: "Asia/Bangkok" });
}

export function createStepMessagesTab(deps) {
  const { api, toast, uploadMedia, state: appState } = deps;
  const drafts = new Map();
  const draftKey = (channelId, id) => `${channelId}:${id || "new"}`;

  async function toggleMode(data) {
    const next = data.mode === "on" ? "off" : "on";
    const question = next === "off"
      ? "ปิดข้อความตามขั้นทั้งหมด? ทุกลำดับหยุดรับคนใหม่และหยุดส่งทันที (คนที่อยู่ในลำดับรออยู่ที่ขั้นเดิม)"
      : "เปิดข้อความตามขั้น? ระบบจะส่งเฉพาะลำดับที่กดเปิดใช้ไว้";
    if (!globalThis.window?.confirm?.(question)) return;
    try {
      await api("/console/api/settings/behavior-switches", { method: "POST", body: { key: data.modeKey, value: next } });
      toast(next === "off" ? "ปิดข้อความตามขั้นแล้ว" : "เปิดข้อความตามขั้นแล้ว");
      deps.rerender?.();
    } catch (error) {
      toast(error.message);
    }
  }

  function modeBar(data) {
    const on = data.mode === "on";
    const running = on && data.engineArmed === true;
    const activeCount = (data.sequences || []).filter((sequence) => sequence.status === "active").length;
    const text = running ? `ทำงานอยู่ · ${activeCount} ลำดับเปิดใช้ · ระบบตรวจคิวทุกนาที`
      : on ? `สวิตช์เปิด · ${activeCount} ลำดับเปิดใช้ · ตัวส่งไม่ได้ทำงานบนเซิร์ฟเวอร์นี้ (ยังไม่มีการส่ง)`
        : "ปิดอยู่ — ทุกลำดับหยุดรับคนใหม่และหยุดส่ง";
    return el("section", { class: `sm-modebar is-${running ? "on" : on ? "idle" : "off"}`, "aria-label": "สถานะข้อความตามขั้น" },
      el("span", { class: "sm-mode-dot", "aria-hidden": "true" }),
      el("div", { class: "sm-mode-copy" },
        el("strong", {}, "สวิตช์รวมข้อความตามขั้น"),
        el("span", {}, text)),
      data.canToggleMode
        ? el("button", { type: "button", class: `btn ${on ? "btn-outline" : "btn-primary"} btn-mini sm-mode-toggle`, onclick: () => toggleMode(data) },
            on ? "ปิดทั้งหมด" : "เปิดสวิตช์รวม")
        : null);
  }

  const oaNote = () => el("p", { class: "bs-oa-note sm-oa-note" },
    "LINE OA Manager ทำ step message ได้เฉพาะในแอปของ LINE — ที่นี่ทำได้เหมือนกัน และหยุดเองตามสถานะลูกค้าในลูกแพร ",
    "ถ้าย้ายลำดับมาจาก OA Manager ให้ย้ายทีละลำดับ และปิดชุดเดิมใน OA Manager ตอนเปิดที่นี่ ไม่งั้นลูกค้าได้สองชุด");

  function starters(data) {
    if (data.canEdit !== true) return null;
    return el("div", { class: "sm-starters" },
      el("span", { class: "bs-add-label" }, "เริ่มจากโครง"),
      STEP_STARTERS.map((starter) => el("a", { class: "bs-chip", href: `${LIST_HASH}/new?starter=${starter.key}` }, starter.title)));
  }

  function sequenceCard(sequence, data) {
    const editable = data.canEdit === true && ["draft", "paused"].includes(sequence.status);
    const totals = sequence.totals || {};
    return el("article", { class: `sm-seq-card is-${STEP_STATUS[sequence.status]?.tone || "draft"}` },
      el("header", { class: "sm-seq-head" },
        statusChip(sequence.status),
        el("span", { class: "sm-trigger-chip" }, el("span", { "aria-hidden": "true" }, triggerGlyph(sequence.triggerType)), sequence.triggerText)),
      el("h3", { class: "sm-seq-name" }, el("a", { href: stepHash(sequence.id) }, sequence.name)),
      el("ol", { class: "sm-mini-steps", "aria-label": `${sequence.steps.length} ขั้น` },
        sequence.steps.map((step, index) => el("li", {}, el("span", { class: "sm-mini-dot" }, String(index + 1)), el("span", {}, delayLabel(step.delay, index))))),
      sequence.status === "paused" && sequence.pausedBy === "system:guard"
        ? el("p", { class: "bs-warn sm-guard-note" }, "ระบบพักไว้เอง: ข้อความบางขั้นไม่ผ่านตัวกันราคาตอนจะส่ง — แก้ข้อความแล้วเปิดใช้ใหม่")
        : null,
      el("p", { class: "sm-seq-totals" },
        el("span", {}, el("strong", {}, formatCount(totals.active)), " อยู่ในลำดับ"),
        el("span", {}, el("strong", {}, formatCount(totals.completed)), " ครบทุกขั้น"),
        el("span", {}, el("strong", {}, formatCount(totals.stopped)), " หยุดกลางทาง")),
      el("div", { class: "sm-seq-actions" },
        el("a", { class: "btn btn-outline btn-mini", href: stepHash(sequence.id) }, "ดูผลรายขั้น"),
        editable ? el("a", { class: "btn btn-outline btn-mini", href: stepHash(sequence.id, "/edit") }, "แก้") : null,
        editable ? el("button", { type: "button", class: "btn btn-primary btn-mini", onclick: () => activate(sequence.id) }, "เปิดใช้…") : null,
        data.canEdit === true && sequence.status === "active"
          ? el("button", { type: "button", class: "btn btn-outline btn-mini", onclick: () => pause(sequence) }, "พักเพื่อแก้") : null));
  }

  function listView(data) {
    const live = (data.sequences || []).filter((sequence) => sequence.status !== "archived");
    const archived = (data.sequences || []).filter((sequence) => sequence.status === "archived");
    return el("div", { class: "sm-list" },
      el("div", { class: "sm-list-head" },
        el("div", {},
          el("h2", { class: "block-title" }, `ลำดับของ OA นี้ (${live.length})`),
          el("p", { class: "block-hint" }, "ทุกขั้นตรวจสถานะลูกค้าสดก่อนส่ง · 1 ห้องได้ข้อความอัตโนมัติไม่เกินวันละครั้ง (รวมทักตาม)")),
        data.canEdit === true ? el("a", { class: "btn btn-primary sm-new", href: `${LIST_HASH}/new` }, "+ สร้างลำดับใหม่") : null),
      starters(data),
      live.length
        ? el("div", { class: "sm-seq-grid" }, live.map((sequence) => sequenceCard(sequence, data)))
        : el("div", { class: "bs-empty sm-empty" },
            el("strong", {}, "ยังไม่มีลำดับข้อความ"),
            el("p", {}, "ตั้งครั้งเดียว ลูกแพรส่งให้เองตามเวลา เช่น ต้อนรับเพื่อนใหม่ · ส่งของแจกเมื่อพิมพ์ #ของแจก · ข้อมูลเตรียมเรียนหลังชำระ")),
      archived.length
        ? el("details", { class: "sm-archived" },
            el("summary", {}, `ลำดับที่ปิดแล้ว (${archived.length})`),
            el("div", { class: "sm-seq-grid" }, archived.map((sequence) => sequenceCard(sequence, data))))
        : null,
      oaNote());
  }

  async function activate(id) {
    const result = await openActivationSheet({ api, toast, sequenceId: id });
    if (result.activated) {
      if (location.hash === stepHash(id)) deps.rerender?.();
      else location.hash = stepHash(id);
    }
  }

  async function pause(sequence) {
    if (!globalThis.window?.confirm?.(`พัก "${sequence.name}"? คนที่อยู่ในลำดับรออยู่ที่ขั้นเดิม ไม่มีใครได้ข้อความจนกว่าจะเปิดใช้อีกครั้ง`)) return;
    try {
      await api(`/console/api/broadcast/steps/${encodeURIComponent(sequence.id)}/pause`, { method: "POST", body: {} });
      toast("พักลำดับแล้ว — แก้ไขได้");
      deps.rerender?.();
    } catch (error) {
      toast(error.message);
    }
  }

  async function archive(sequence) {
    if (!globalThis.window?.confirm?.(`ปิด "${sequence.name}" ถาวร? คนที่ยังอยู่ในลำดับจะหยุดทั้งหมด (ประวัติและสถิติยังอยู่)`)) return;
    try {
      await api(`/console/api/broadcast/steps/${encodeURIComponent(sequence.id)}/archive`, { method: "POST", body: { confirm: true } });
      toast("ปิดลำดับแล้ว");
      location.hash = LIST_HASH;
    } catch (error) {
      toast(error.message);
    }
  }

  function statRow(step, stat, data, onPick, picked) {
    const labels = data.stopReasonLabels || {};
    const stoppedBy = Object.entries(stat?.stoppedBy || {});
    const cell = (value, label, tone = "") => el("span", { class: `sm-stat${tone ? ` is-${tone}` : ""}` },
      el("strong", {}, formatCount(Number(value) || 0)), el("span", {}, label));
    return el("li", { class: `sm-stat-row${picked ? " is-picked" : ""}` },
      el("button", { type: "button", class: "sm-stat-step", "aria-pressed": picked ? "true" : "false", onclick: onPick },
        el("span", { class: "sm-step-dot", "aria-hidden": "true" }, String(step.index + 1)),
        el("span", { class: "sm-step-title" }, el("strong", {}, `ขั้นที่ ${step.index + 1}`), el("span", { class: "sm-wait" }, delayLabel(step.delay, step.index)))),
      el("div", { class: "sm-stat-cells" },
        cell(stat?.entered, "เข้าขั้น"),
        cell(stat?.sent, "ส่งแล้ว", "good"),
        cell(stat?.waiting, "รอส่ง"),
        cell(stat?.skipped, "ข้าม (เงื่อนไข)"),
        cell(stat?.replied, "ตอบใน 72 ชม."),
        cell(stat?.clicked, "คลิกลิงก์"),
        cell(stat?.failed, "ส่งไม่สำเร็จ", Number(stat?.failed) > 0 ? "bad" : "")),
      stoppedBy.length
        ? el("p", { class: "sm-stopped" }, "หยุดที่ขั้นนี้: ",
            stoppedBy.map(([reason, count]) => el("span", { class: "bs-badge is-warn" }, `${labels[reason] || reason} ${formatCount(count)}`)))
        : null);
  }

  function detailView(sequence, data, { meta, channelName }) {
    const stats = sequence.stepStats || [];
    const editable = data.canEdit === true && ["draft", "paused"].includes(sequence.status);
    const previewSlot = el("div", { class: "bs-preview-slot" });
    const statsList = el("ol", { class: "sm-stats" });
    let picked = 0;
    const renderStats = () => {
      put(statsList, sequence.steps.map((step, index) => statRow({ ...step, index }, stats[index], data, () => { picked = index; renderStats(); }, index === picked)));
      const step = sequence.steps[picked];
      put(previewSlot, renderLinePreview({
        bubbles: bubblesFromStored(step?.messages || []), meta, oaName: channelName, when: step ? delayLabel(step.delay, picked) : "",
      }));
    };
    renderStats();
    const totals = sequence.totals || {};
    const metric = (value, label, hint) => el("div", { class: "bs-metric" },
      el("span", { class: "bs-metric-value" }, formatCount(Number(value) || 0)),
      el("span", { class: "bs-metric-label" }, label), hint ? el("span", { class: "bs-metric-hint" }, hint) : null);
    return el("div", { class: "sm-detail bs-create" },
      el("div", { class: "bs-main" },
        el("section", { class: "block sm-detail-head" },
          el("a", { class: "sm-back", href: LIST_HASH }, "‹ ลำดับทั้งหมด"),
          el("div", { class: "sm-seq-head" }, statusChip(sequence.status),
            el("span", { class: "sm-trigger-chip" }, el("span", { "aria-hidden": "true" }, triggerGlyph(sequence.triggerType)), sequence.triggerText)),
          el("h2", { class: "sm-detail-title" }, sequence.name),
          el("p", { class: "block-hint" },
            `${sequence.steps.length} ขั้น · ${sequence.stopOnReply ? "หยุดเมื่อลูกค้าตอบ" : "ส่งต่อแม้ลูกค้าตอบ"}`,
            sequence.activatedAt ? ` · เปิดใช้ ${dateText(sequence.activatedAt)}` : "",
            sequence.pausedBy ? ` · พักโดย ${sequence.pausedBy === "system:guard" ? "ระบบ (ข้อความไม่ผ่านตัวกันราคา)" : sequence.pausedBy}` : ""),
          el("div", { class: "sm-seq-actions" },
            editable ? el("a", { class: "btn btn-outline btn-mini", href: stepHash(sequence.id, "/edit") }, "แก้ไข") : null,
            editable ? el("button", { type: "button", class: "btn btn-primary btn-mini", onclick: () => activate(sequence.id) }, "เปิดใช้…") : null,
            data.canEdit === true && sequence.status === "active"
              ? el("button", { type: "button", class: "btn btn-outline btn-mini", onclick: () => pause(sequence) }, "พักเพื่อแก้") : null,
            data.canEdit === true && sequence.status !== "archived"
              ? el("button", { type: "button", class: "btn btn-ghost btn-mini sm-archive", onclick: () => archive(sequence) }, "ปิดถาวร") : null)),
        el("div", { class: "bs-metrics" },
          metric(totals.active, "อยู่ในลำดับ", "รอขั้นถัดไป"),
          metric(totals.completed, "ครบทุกขั้น"),
          metric(totals.stopped, "หยุดกลางทาง", "ดูเหตุผลรายขั้นด้านล่าง"),
          metric(totals.baseline, "ตรงอยู่ก่อนเปิดใช้", "ไม่ได้รับย้อนหลัง")),
        el("section", { class: "block" },
          el("h2", { class: "block-title" }, "ผลรายขั้น"),
          el("p", { class: "block-hint" }, "ตัวเลขรวมเท่านั้น ไม่มีรายชื่อลูกค้า · กดที่ขั้นเพื่อดูข้อความของขั้นนั้น"),
          statsList),
        oaNote()),
      el("aside", { class: "bs-aside", "aria-label": "ข้อความของขั้นที่เลือก" },
        el("div", { class: "bs-aside-inner" }, previewSlot)));
  }

  async function editorView(route, ctx, data) {
    const key = draftKey(ctx.channelId, route.view === "new" ? `new:${route.starter || ""}` : route.id);
    let draft = drafts.get(key);
    if (!draft) {
      if (route.view === "new") {
        draft = newStepDraft(route.starter);
      } else {
        const response = await api(`/console/api/broadcast/steps/${encodeURIComponent(route.id)}`);
        if (!["draft", "paused"].includes(response.sequence.status)) {
          return el("div", { class: "bs-empty" }, "ลำดับที่ทำงานอยู่แก้ไม่ได้ — กดพักก่อน (คนในลำดับรออยู่ที่ขั้นเดิม)");
        }
        draft = stepDraftFromSequence(response.sequence);
      }
      drafts.set(key, draft);
    }
    return createStepEditor({
      api, toast, uploadMedia, meta: ctx.meta, data, channelId: ctx.channelId, channelName: ctx.channelName, draft,
      onCancel: () => { location.hash = route.view === "new" ? LIST_HASH : stepHash(route.id); },
      onSaved: async (sequence, { thenActivate }) => {
        drafts.delete(key);
        if (thenActivate) {
          await openActivationSheet({ api, toast, sequenceId: sequence.id });
        } else {
          toast("บันทึกร่างแล้ว — ยังไม่มีการส่งจนกว่าจะกดเปิดใช้");
        }
        location.hash = stepHash(sequence.id);
      },
    });
  }

  async function render(ctx) {
    const route = stepRoute(location.hash);
    const data = await api(`/console/api/broadcast/steps?channel=${encodeURIComponent(ctx.channelId)}`);
    let body;
    if (route.view === "list") {
      body = listView(data);
    } else if (route.view === "detail") {
      const response = await api(`/console/api/broadcast/steps/${encodeURIComponent(route.id)}`);
      body = detailView(response.sequence, data, ctx);
    } else {
      body = await editorView(route, ctx, data);
    }
    return el("div", { class: "sm-page" }, modeBar(data), body);
  }

  return { render, drafts, currentUser: () => appState?.me };
}
