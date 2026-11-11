// stepEditor.mjs — ตัวสร้าง/แก้ "ข้อความตามขั้น" (Step messages) (28 ก.ย. 2026)
// ① ตั้งชื่อ + จุดเริ่ม (เพิ่มเพื่อน / #คีย์เวิร์ด / ได้ป้าย / ชำระเงิน) ② ขั้นตอน (รอกี่ชม./กี่วัน + เวลา · เงื่อนไขป้าย · บับเบิล)
// ③ หยุด/เลื่อนเอง → ตัวอย่างจอ LINE ของขั้นที่เลือก · บันทึกเป็นร่างก่อนเสมอ (เปิดใช้ = อีกขั้นที่ต้องยืนยัน)
// ทุกค่าที่พิมพ์ผ่าน el() (text node) · ไม่มี inline style (CSP) · เซิร์ฟเวอร์ตรวจซ้ำทุกอย่างตอนบันทึก/เปิดใช้/ส่ง
import { el } from "./dom.mjs";
import { put } from "./broadcastState.mjs";
import {
  bubbleIsReady, bubblesFromStored, createComposer, newBubble, renderLinePreview, serializeBubbles,
} from "./broadcastComposer.mjs";

export const STEP_TRIGGER_OPTIONS = Object.freeze([
  { type: "follow", glyph: "＋", title: "เพิ่มเพื่อนใหม่", sub: "เริ่มเมื่อมีคนเพิ่มเพื่อน OA หลังกดเปิดใช้" },
  { type: "keyword", glyph: "#", title: "พิมพ์ #คีย์เวิร์ด", sub: "ลูกค้าพิมพ์ เช่น #ของแจก ในแชท" },
  { type: "tag", glyph: "◈", title: "ได้ป้าย", sub: "เมื่อห้องได้ป้าย เช่น ของแจก: …" },
  { type: "order_paid", glyph: "✓", title: "ชำระเงินแล้ว", sub: "ข้อมูลเตรียมเรียน/เอกสาร หลังออเดอร์ชำระ" },
]);

// โครงเริ่มต้น — เติมแค่จุดเริ่มกับระยะรอ ข้อความต้องเขียนเอง (ไม่มีข้อความสำเร็จรูปที่เผลอเปิดใช้ได้)
export const STEP_STARTERS = Object.freeze([
  {
    key: "welcome", title: "ต้อนรับเพื่อนใหม่ 3 ขั้น", name: "ต้อนรับเพื่อนใหม่", triggerType: "follow", triggerValue: "",
    delays: [{ kind: "hours", hours: 1 }, { kind: "days", days: 1, at: "10:00" }, { kind: "days", days: 3, at: "19:00" }],
  },
  {
    key: "giveaway", title: "ส่งของแจกเมื่อพิมพ์ #ของแจก", name: "ส่งของแจก", triggerType: "keyword", triggerValue: "ของแจก",
    delays: [{ kind: "hours", hours: 1 }, { kind: "days", days: 2, at: "10:00" }],
  },
  {
    key: "prep", title: "เตรียมตัวก่อนเรียน (หลังชำระ)", name: "เตรียมตัวก่อนเรียน", triggerType: "order_paid", triggerValue: "",
    delays: [{ kind: "hours", hours: 1 }, { kind: "days", days: 1, at: "10:00" }],
  },
]);

const DEFAULT_LIMITS = Object.freeze({ maxSteps: 10, maxDelayDays: 30, maxDelayHours: 72, minDelayHours: 1, nameMax: 60, conditionTagsMax: 5 });
const KEYWORD_RE = /^[\p{L}\p{N}_-]{1,40}$/u;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/u;

const emptyCondition = () => ({ hasTags: [], hasNotTags: [] });
const newStep = (delay = { kind: "hours", hours: 1 }) => ({ delay: { ...delay }, condition: emptyCondition(), bubbles: [newBubble("text")] });

export function newStepDraft(starterKey = "") {
  const starter = STEP_STARTERS.find((entry) => entry.key === starterKey);
  return {
    id: null, status: "draft", name: starter?.name || "", triggerType: starter?.triggerType || "follow",
    triggerValue: starter?.triggerValue || "", stopOnReply: false,
    steps: (starter?.delays || [{ kind: "hours", hours: 1 }]).map((delay) => newStep(delay)),
    active: 0,
  };
}

export function stepDraftFromSequence(sequence) {
  return {
    id: sequence.id, status: sequence.status, name: sequence.name || "", triggerType: sequence.triggerType,
    triggerValue: sequence.triggerValue || "", stopOnReply: sequence.stopOnReply === true,
    steps: (sequence.steps || []).map((step) => ({
      delay: { ...step.delay },
      condition: { hasTags: [...(step.condition?.hasTags || [])], hasNotTags: [...(step.condition?.hasNotTags || [])] },
      bubbles: bubblesFromStored(step.messages),
    })),
    active: 0,
  };
}

/** ทรงที่ส่งให้เซิร์ฟเวอร์ (POST /console/api/broadcast/steps[/:id]) */
export function stepDraftPayload(draft, channelId) {
  const value = String(draft.triggerValue || "").trim();
  return {
    channelId, name: String(draft.name || "").trim(), triggerType: draft.triggerType,
    triggerValue: draft.triggerType === "keyword" ? value.replace(/^#/u, "") : draft.triggerType === "tag" ? value : "",
    stopOnReply: draft.stopOnReply === true,
    steps: draft.steps.map((step) => ({
      delay: step.delay.kind === "days"
        ? { kind: "days", days: Number(step.delay.days), at: String(step.delay.at || "") }
        : { kind: "hours", hours: Number(step.delay.hours) },
      condition: step.condition.hasTags.length || step.condition.hasNotTags.length
        ? { hasTags: [...step.condition.hasTags], hasNotTags: [...step.condition.hasNotTags] } : null,
      messages: serializeBubbles(step.bubbles),
    })),
  };
}

export function delayLabel(delay, index) {
  const from = index === 0 ? "เข้าลำดับ" : "ขั้นก่อนหน้า";
  if (delay?.kind === "days") return `${delay.days} วันหลัง${from} · ${delay.at || "10:00"} น.`;
  return `${delay?.hours || 1} ชม. หลัง${from}`;
}

function delayProblem(delay, limits) {
  if (delay?.kind === "days") {
    const days = Number(delay.days);
    if (!Number.isInteger(days) || days < 1 || days > limits.maxDelayDays) return `จำนวนวันต้อง 1–${limits.maxDelayDays}`;
    const match = TIME_RE.exec(String(delay.at || ""));
    const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : -1;
    if (minutes < 9 * 60 || minutes > 20 * 60 + 30) return "เวลาส่งต้องอยู่ช่วง 09:00–20:30";
    return "";
  }
  const hours = Number(delay?.hours);
  if (!Number.isInteger(hours) || hours < limits.minDelayHours || hours > limits.maxDelayHours) {
    return `รอเป็นชั่วโมงได้ ${limits.minDelayHours}–${limits.maxDelayHours} ชม.`;
  }
  return "";
}

/** ปัญหาที่เห็นได้ก่อนส่งเซิร์ฟเวอร์ (เซิร์ฟเวอร์ตรวจละเอียดกว่า + ตัวกันราคา) */
export function stepDraftProblems(draft, rawLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...rawLimits };
  const problems = [];
  const name = String(draft.name || "").trim();
  if (!name) problems.push("ตั้งชื่อลำดับก่อน");
  else if (name.length > limits.nameMax) problems.push(`ชื่อยาวเกิน ${limits.nameMax} ตัวอักษร`);
  const value = String(draft.triggerValue || "").trim().replace(/^#/u, "");
  if (draft.triggerType === "keyword" && !KEYWORD_RE.test(value)) problems.push("คีย์เวิร์ดต้องเป็นคำเดียว เช่น ของแจก");
  if (draft.triggerType === "tag" && !value) problems.push("เลือกป้ายที่เป็นจุดเริ่ม");
  if (!draft.steps.length) problems.push("ต้องมีอย่างน้อย 1 ขั้น");
  if (draft.steps.length > limits.maxSteps) problems.push(`มีได้ไม่เกิน ${limits.maxSteps} ขั้น`);
  draft.steps.forEach((step, index) => {
    const delay = delayProblem(step.delay, limits);
    if (delay) problems.push(`ขั้นที่ ${index + 1}: ${delay}`);
    if (!step.bubbles.some(bubbleIsReady)) problems.push(`ขั้นที่ ${index + 1}: ยังไม่มีข้อความ`);
    else if (!step.bubbles.every(bubbleIsReady)) problems.push(`ขั้นที่ ${index + 1}: มีบับเบิลที่ยังไม่ครบ`);
  });
  return problems;
}

/** ตัวเลือกป้ายจาก meta ของสตูดิโอ — ทั้งมิติ (มิติ:*) ก่อน แล้วค่าย่อย */
export function stepTagOptions(meta = {}) {
  const options = [];
  for (const group of meta.tagGroups || []) {
    if (group.wildcard) options.push({ value: group.wildcard, label: `${group.label}: ทุกค่า`, count: group.total });
    for (const tag of group.tags || []) options.push({ value: tag.tag, label: tag.tag, count: tag.count });
  }
  return options;
}

const tagText = (value) => String(value).replace(/\s*:\s*\*$/u, ": ทุกค่า");

function bubbleSummary(bubbles) {
  const ready = bubbles.filter(bubbleIsReady);
  if (!ready.length) return "ยังไม่มีข้อความ";
  const first = ready[0];
  const head = first.type === "text" ? first.text.trim().split("\n")[0]
    : first.type === "image" ? "[รูป]" : first.type === "sticker" ? "[สติกเกอร์]" : `[การ์ด] ${first.cards?.[0]?.title || ""}`.trim();
  return ready.length > 1 ? `${head} (+${ready.length - 1} บับเบิล)` : head;
}

/* ------------------------------- ตัวแก้ ------------------------------- */

export function createStepEditor({ api, toast, uploadMedia = null, meta = {}, data = {}, channelId, channelName, draft, onSaved, onCancel }) {
  const limits = { ...DEFAULT_LIMITS, ...(data.limits || {}) };
  const tagOptions = stepTagOptions(meta);
  const previewSlot = el("div", { class: "bs-preview-slot" });
  const previewLabel = el("p", { class: "sm-preview-label" });
  const problemsSlot = el("div", { class: "sm-problems", "aria-live": "polite" });
  const timeline = el("ol", { class: "sm-timeline", "aria-label": "ขั้นของลำดับ" });
  const triggerPanel = el("div", { class: "sm-trigger-panel" });
  const saveButton = el("button", { type: "button", class: "btn btn-outline sm-save" }, "บันทึกร่าง");
  const activateButton = el("button", { type: "button", class: "btn btn-primary sm-save-activate" }, "บันทึกแล้วตรวจเปิดใช้");
  let busy = false;

  const renderPreview = () => {
    const step = draft.steps[draft.active] || draft.steps[0];
    const index = draft.steps.indexOf(step);
    previewLabel.textContent = step ? `ขั้นที่ ${index + 1} · ${delayLabel(step.delay, index)}` : "";
    put(previewSlot, renderLinePreview({ bubbles: step?.bubbles || [], meta, oaName: channelName, when: step ? delayLabel(step.delay, index) : "" }));
  };

  const renderProblems = () => {
    const problems = stepDraftProblems(draft, limits);
    put(problemsSlot, problems.length
      ? el("ul", { class: "sm-problem-list" }, problems.slice(0, 4).map((text) => el("li", {}, text)))
      : el("p", { class: "sm-ready" }, "พร้อมบันทึก — ยังไม่มีการส่งจนกว่าจะกดเปิดใช้และยืนยัน"));
    const disabled = busy || problems.length > 0 || data.canEdit !== true;
    saveButton.disabled = disabled;
    activateButton.disabled = disabled;
  };

  const touched = () => {
    renderPreview();
    renderProblems();
  };

  /* ---- ① จุดเริ่ม ---- */
  const nameInput = el("input", {
    class: "order-in bs-input keep-focus sm-name", maxlength: String(limits.nameMax), value: draft.name,
    placeholder: "เช่น ต้อนรับเพื่อนใหม่", "aria-label": "ชื่อลำดับ",
    oninput: (event) => { draft.name = event.target.value; renderProblems(); },
  });

  function tagSelect({ current = "", placeholder, onPick, exclude = [] }) {
    const select = el("select", { class: "order-in bs-select sm-tag-select", "aria-label": placeholder },
      el("option", { value: "" }, placeholder),
      tagOptions.filter((option) => !exclude.includes(option.value)).map((option) => el("option", { value: option.value },
        Number.isSafeInteger(option.count) ? `${tagText(option.label)} (${option.count})` : tagText(option.label))));
    select.value = current;
    select.addEventListener("change", () => onPick(select.value, select));
    return select;
  }

  const renderTriggerPanel = () => {
    let panel;
    if (draft.triggerType === "keyword") {
      panel = el("label", { class: "bs-field" },
        el("span", { class: "bs-field-label" }, "คีย์เวิร์ด"),
        el("span", { class: "sm-hash-input" },
          el("span", { class: "sm-hash", "aria-hidden": "true" }, "#"),
          el("input", {
            class: "order-in bs-input keep-focus", maxlength: "41", value: String(draft.triggerValue || "").replace(/^#/u, ""),
            placeholder: "ของแจก", "aria-label": "คีย์เวิร์ด (ไม่ต้องพิมพ์ #)",
            oninput: (event) => { draft.triggerValue = event.target.value; renderProblems(); },
          })),
        el("span", { class: "block-hint" }, "ลูกค้าพิมพ์ #คำนี้ในแชท (ต่อคำลงท้ายได้ เช่น #ของแจกค่ะ · ไม่สนตัวพิมพ์เล็กใหญ่)"));
    } else if (draft.triggerType === "tag") {
      panel = el("div", { class: "bs-field" },
        el("span", { class: "bs-field-label" }, "ป้ายที่เป็นจุดเริ่ม"),
        tagOptions.length
          ? tagSelect({ current: draft.triggerValue, placeholder: "เลือกป้าย…", onPick: (value) => { draft.triggerValue = value; renderProblems(); } })
          : el("p", { class: "bs-empty" }, "ยังไม่มีป้ายในระบบ"),
        el("span", { class: "block-hint" }, "คนที่มีป้ายนี้อยู่แล้วก่อนเปิดใช้ไม่ได้รับย้อนหลัง · ป้ายหลุดกลางทาง = หยุดลำดับของคนนั้น"));
    } else if (draft.triggerType === "order_paid") {
      panel = el("p", { class: "bs-warn" }, "ลูกค้าที่ซื้อแล้วทีมดูแล 100% — ใช้ส่งข้อมูลเตรียมเรียน/เอกสารเท่านั้น ห้ามขายเพิ่มในลำดับนี้");
    } else {
      panel = el("p", { class: "block-hint" }, "นับเฉพาะคนที่เพิ่มเพื่อนหลังกดเปิดใช้ · คนที่เลิกบล็อกไม่นับเป็นเพื่อนใหม่");
    }
    put(triggerPanel, panel);
  };

  const triggerCards = el("div", { class: "bs-modes sm-triggers", role: "radiogroup", "aria-label": "จุดเริ่มของลำดับ" },
    STEP_TRIGGER_OPTIONS.map((option) => {
      const card = el("button", {
        type: "button", role: "radio", class: `bs-mode sm-trigger${draft.triggerType === option.type ? " is-active" : ""}`,
        "aria-checked": draft.triggerType === option.type ? "true" : "false",
        onclick: () => {
          if (draft.triggerType === option.type) return;
          draft.triggerType = option.type;
          draft.triggerValue = "";
          for (const node of triggerCards.children) {
            const active = node === card;
            node.classList.toggle("is-active", active);
            node.setAttribute("aria-checked", active ? "true" : "false");
          }
          renderTriggerPanel();
          renderStopList();
          renderProblems();
        },
      },
        el("span", { class: "bs-mode-glyph", "aria-hidden": "true" }, option.glyph),
        el("span", { class: "bs-mode-copy" }, el("strong", {}, option.title), el("span", {}, option.sub)));
      return card;
    }));

  /* ---- ② ขั้นตอน ---- */
  function delayEditor(step, index) {
    const hoursInput = el("input", {
      class: "order-in bs-input keep-focus sm-num", type: "number", inputmode: "numeric", min: String(limits.minDelayHours),
      max: String(limits.maxDelayHours), step: "1", value: String(step.delay.kind === "hours" ? step.delay.hours : 1), "aria-label": "จำนวนชั่วโมง",
      oninput: (event) => { step.delay = { kind: "hours", hours: Number(event.target.value) }; refreshWait(); },
    });
    const daysInput = el("input", {
      class: "order-in bs-input keep-focus sm-num", type: "number", inputmode: "numeric", min: "1", max: String(limits.maxDelayDays), step: "1",
      value: String(step.delay.kind === "days" ? step.delay.days : 1), "aria-label": "จำนวนวัน",
      oninput: (event) => { step.delay = { kind: "days", days: Number(event.target.value), at: timeInput.value }; refreshWait(); },
    });
    const timeInput = el("input", {
      class: "order-in bs-input keep-focus sm-time", type: "time", min: "09:00", max: "20:30", step: "60",
      value: step.delay.kind === "days" ? step.delay.at : "10:00", "aria-label": "เวลาส่ง (เวลาไทย)",
      oninput: (event) => { step.delay = { kind: "days", days: Number(daysInput.value), at: event.target.value }; refreshWait(); },
    });
    const hoursRow = el("span", { class: "sm-delay-fields" }, "รอ", hoursInput, "ชม.");
    const daysRow = el("span", { class: "sm-delay-fields" }, "อีก", daysInput, "วัน เวลา", timeInput, "น.");
    const sync = () => {
      hoursRow.hidden = step.delay.kind !== "hours";
      daysRow.hidden = step.delay.kind !== "days";
    };
    const kindRadio = (kind, label) => el("label", { class: "bs-radio" },
      el("input", {
        type: "radio", name: `sm-delay-kind-${index}`, value: kind, checked: step.delay.kind === kind ? "checked" : null,
        onchange: () => {
          step.delay = kind === "days"
            ? { kind: "days", days: Number(daysInput.value) || 1, at: timeInput.value || "10:00" }
            : { kind: "hours", hours: Number(hoursInput.value) || 1 };
          sync();
          refreshWait();
        },
      }), el("span", {}, label));
    const refreshWait = () => {
      const wait = timeline.children[index]?.querySelector?.(".sm-wait");
      if (wait) wait.textContent = delayLabel(step.delay, index);
      touched();
    };
    sync();
    return el("div", { class: "sm-delay" },
      el("div", { class: "sm-delay-kinds", role: "radiogroup", "aria-label": "รอแบบไหน" },
        kindRadio("hours", "นับเป็นชั่วโมง"), kindRadio("days", "นับเป็นวัน + เวลา")),
      el("div", { class: "sm-delay-row" }, hoursRow, daysRow),
      el("p", { class: "block-hint" }, index === 0
        ? "นับจากเวลาที่ลูกค้าเข้าลำดับ · ถึงเวลาช่วง 21:00–09:00 ระบบเลื่อนไปเช้าวันถัดไป"
        : "นับจากเวลาที่ขั้นก่อนหน้าส่งจริง · ช่วง 21:00–09:00 เลื่อนไปเช้า"));
  }

  function conditionEditor(step) {
    const box = el("div", { class: "sm-condition" });
    const render = () => {
      const row = (key, title, kindClass) => el("div", { class: "sm-cond-row" },
        el("span", { class: "sm-cond-label" }, title),
        el("span", { class: "bs-chips" },
          step.condition[key].map((tag) => el("button", {
            type: "button", class: `bs-chip is-active ${kindClass}`, "aria-label": `เอา ${tagText(tag)} ออก`,
            onclick: () => { step.condition[key] = step.condition[key].filter((t) => t !== tag); render(); },
          }, tagText(tag), el("span", { "aria-hidden": "true" }, "×"))),
          step.condition[key].length < limits.conditionTagsMax
            ? tagSelect({
                placeholder: "+ เพิ่มป้าย…", exclude: [...step.condition.hasTags, ...step.condition.hasNotTags],
                onPick: (value) => { if (value) { step.condition[key] = [...step.condition[key], value]; render(); } },
              })
            : null));
      put(box,
        row("hasTags", "ต้องมีป้าย", "is-include"),
        row("hasNotTags", "ต้องไม่มีป้าย", "is-exclude"),
        el("p", { class: "block-hint" }, "ไม่ตรงเงื่อนไข = ข้ามขั้นนี้แล้วไปขั้นถัดไป (ไม่หยุดทั้งลำดับ)"));
    };
    render();
    const open = step.condition.hasTags.length > 0 || step.condition.hasNotTags.length > 0;
    return el("details", { class: "sm-cond", open: open ? "open" : null },
      el("summary", { class: "sm-cond-head" }, "ส่งขั้นนี้เฉพาะบางคน (ไม่บังคับ)"), box);
  }

  function moveStep(from, to) {
    if (to < 0 || to >= draft.steps.length) return;
    const [step] = draft.steps.splice(from, 1);
    draft.steps.splice(to, 0, step);
    draft.active = to;
    renderTimeline();
    touched();
  }

  function stepItem(step, index) {
    const active = index === draft.active;
    const tools = el("span", { class: "bs-bubble-tools" },
      el("button", { type: "button", class: "icon-btn bs-tool", "aria-label": "เลื่อนขึ้น", disabled: index === 0 ? true : null, onclick: () => moveStep(index, index - 1) }, "↑"),
      el("button", { type: "button", class: "icon-btn bs-tool", "aria-label": "เลื่อนลง", disabled: index === draft.steps.length - 1 ? true : null, onclick: () => moveStep(index, index + 1) }, "↓"),
      el("button", {
        type: "button", class: "icon-btn bs-tool bs-tool-del", "aria-label": `ลบขั้นที่ ${index + 1}`, disabled: draft.steps.length === 1 ? true : null,
        onclick: () => {
          draft.steps.splice(index, 1);
          draft.active = Math.max(0, Math.min(draft.active, draft.steps.length - 1));
          renderTimeline();
          touched();
        },
      }, "×"));
    const head = el("div", { class: "sm-step-head" },
      el("span", { class: "sm-step-dot", "aria-hidden": "true" }, String(index + 1)),
      el("span", { class: "sm-step-title" }, el("strong", {}, `ขั้นที่ ${index + 1}`), el("span", { class: "sm-wait" }, delayLabel(step.delay, index))),
      tools);
    if (!active) {
      return el("li", { class: `sm-step${step.bubbles.every(bubbleIsReady) && step.bubbles.some(bubbleIsReady) ? "" : " is-incomplete"}` },
        head,
        el("button", {
          type: "button", class: "sm-step-summary",
          onclick: () => { draft.active = index; renderTimeline(); renderPreview(); },
        }, el("span", { class: "sm-step-text" }, bubbleSummary(step.bubbles)), el("span", { class: "sm-step-open" }, "แก้ขั้นนี้")));
    }
    const composer = createComposer({
      meta, bubbles: step.bubbles, toast, uploadMedia, tracking: meta.tracking?.enabled === true, idPrefix: `sm${index}`,
      onChange: () => touched(),
    });
    return el("li", { class: "sm-step is-active" }, head, delayEditor(step, index), conditionEditor(step), composer.node);
  }

  const addStepButton = el("button", {
    type: "button", class: "btn btn-outline sm-add-step",
    onclick: () => {
      if (draft.steps.length >= limits.maxSteps) return;
      draft.steps.push(newStep({ kind: "days", days: 1, at: "10:00" }));
      draft.active = draft.steps.length - 1;
      renderTimeline();
      touched();
    },
  });

  function renderTimeline() {
    put(timeline, draft.steps.map((step, index) => stepItem(step, index)));
    addStepButton.textContent = `+ เพิ่มขั้น (${draft.steps.length}/${limits.maxSteps})`;
    addStepButton.disabled = draft.steps.length >= limits.maxSteps;
  }

  /* ---- ③ หยุด/เลื่อนเอง ---- */
  const stopList = el("ul", { class: "sm-rules" });
  function renderStopList() {
    const stops = [
      draft.triggerType === "order_paid" ? "ออเดอร์ถูกยกเลิก" : "ซื้อแล้ว (ป้าย customer / ซื้อครั้งที่)",
      "ห้องสแปม (null)", "ขอหยุดการทัก / ปฏิเสธการตลาด", "บล็อก OA", "ทีมรับห้องต่อ / ปิด AI",
      "เรื่องเงินอยู่กับทีม (ส่งเลขบัญชี รอโอน ส่งสลิป)",
      draft.triggerType === "tag" ? "ป้ายจุดเริ่มหลุดจากห้อง" : null,
    ].filter(Boolean);
    put(stopList, stops.map((text) => el("li", {}, text)));
  }
  const stopOnReply = el("label", { class: "bs-toggle" },
    el("input", { type: "checkbox", checked: draft.stopOnReply ? "checked" : null, onchange: (event) => { draft.stopOnReply = event.target.checked; } }),
    el("span", { class: "bs-toggle-copy" },
      el("strong", {}, "หยุดเมื่อลูกค้าตอบกลับ"),
      el("span", {}, "ลูกค้าพิมพ์อะไรมาหลังเข้าลำดับ = ลูกแพร/ทีมคุยต่อเอง ไม่ส่งขั้นที่เหลือ")));

  /* ---- บันทึก ---- */
  async function save({ thenActivate }) {
    const problems = stepDraftProblems(draft, limits);
    if (problems.length) {
      toast(problems[0]);
      return;
    }
    busy = true;
    renderProblems();
    try {
      const path = draft.id ? `/console/api/broadcast/steps/${encodeURIComponent(draft.id)}` : "/console/api/broadcast/steps";
      const response = await api(path, { method: "POST", body: stepDraftPayload(draft, channelId) });
      if (!response?.sequence?.id) throw new Error("เซิร์ฟเวอร์ไม่ตอบข้อมูลลำดับ — โหลดหน้าใหม่แล้วลองอีกครั้ง");
      draft.id = response.sequence.id;
      await onSaved?.(response.sequence, { thenActivate });
    } catch (error) {
      toast(error.message);
    } finally {
      busy = false;
      renderProblems();
    }
  }
  saveButton.addEventListener("click", () => save({ thenActivate: false }));
  activateButton.addEventListener("click", () => save({ thenActivate: true }));

  renderTriggerPanel();
  renderTimeline();
  renderStopList();
  renderPreview();
  renderProblems();

  const section = (no, title, hint, ...children) => el("section", { class: "block bs-step" },
    el("header", { class: "bs-step-head" },
      el("span", { class: "bs-step-no", "aria-hidden": "true" }, no),
      el("span", {}, el("h2", { class: "block-title" }, title), hint ? el("p", { class: "block-hint" }, hint) : null)),
    ...children);

  return el("div", { class: "sm-editor bs-create" },
    el("div", { class: "bs-main" },
      section("1", "ชื่อและจุดเริ่ม", "",
        el("label", { class: "bs-field" }, el("span", { class: "bs-field-label" }, "ชื่อลำดับ (ลูกค้าไม่เห็น)"), nameInput),
        triggerCards, triggerPanel),
      section("2", "ขั้นตอน", `สูงสุด ${limits.maxSteps} ขั้น · ขั้นละไม่เกิน 5 บับเบิล · ตัวกันราคาตรวจทุกขั้นตอนบันทึกและก่อนส่งจริง`,
        timeline, addStepButton),
      section("3", "หยุดและเลื่อนเอง", "ตรวจสดทุกครั้งก่อนส่งแต่ละขั้น — LINE OA Manager ทำแบบนี้ไม่ได้เพราะไม่รู้สถานะในลูกแพร",
        el("div", { class: "sm-rule-grid" },
          el("div", { class: "sm-rule-box" }, el("strong", { class: "sm-rule-title" }, "หยุดลำดับของคนนั้นเมื่อ"), stopList),
          el("div", { class: "sm-rule-box" }, el("strong", { class: "sm-rule-title" }, "เลื่อนไปก่อน (ไม่ส่งซ้อน)"),
            el("ul", { class: "sm-rules" },
              el("li", {}, "ช่วงเงียบ 21:00–09:00"),
              el("li", {}, "กำลังคุยกันอยู่ (ภายใน 2 ชม.) หรือทีมคุมห้องอยู่"),
              el("li", {}, "วันนี้ห้องนั้นได้ข้อความอัตโนมัติไปแล้ว 1 ครั้ง"),
              el("li", {}, "วันที่บันไดทักตามถึงคิว — ทักตามได้ก่อน")))),
        stopOnReply),
    ),
    el("aside", { class: "bs-aside", "aria-label": "ตัวอย่างและบันทึก" },
      el("div", { class: "bs-aside-inner" },
        previewLabel,
        previewSlot,
        el("div", { class: "bs-summary sm-save-box" },
          problemsSlot,
          el("div", { class: "bs-cta" }, activateButton, saveButton,
            el("button", { type: "button", class: "btn btn-ghost", onclick: () => onCancel?.() }, "กลับไปรายการ"))),
        data.canEdit === true ? null : el("p", { class: "block-hint" }, "บัญชีนี้ดูได้ แต่สร้าง/แก้ลำดับไม่ได้"),
      )),
  );
}
