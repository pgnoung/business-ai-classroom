// yoloHandoffPanel.mjs — แท็บ "🔔 ส่งต่อแอดมิน" ในกล่อง YOLO (คำสั่งพี่ง้วง 2026-10-15)
//
// "ปุ่ม yolo ให้มี option แจ้งเตือนเข้า admin เลย — เลือกปิด AI หรือไม่ปิดก็ได้ พร้อมคำพูดที่พี่ง้วงพิมพ์เข้าไปได้"
// ข้อความในช่องนี้ส่งถึงลูกค้า "ตามที่พิมพ์เป๊ะ" (ไม่ผ่านโมเดล) — เว้นว่าง = แจ้งแอดมินอย่างเดียว
// สถานะ (ข้อความ/ตัวเลือก/ผล) อยู่ใน room ของ yolo.mjs ระดับโมดูล — รอบ poll re-render หัวห้องแล้วไม่หาย
import { el } from "./dom.mjs";

export const HANDOFF_MAX_CHARS = 1000;
export const HANDOFF_SUGGESTION = "ได้เลยค่ะ เดี๋ยวลูกแพรส่งเรื่องให้แอดมินดูแลต่อนะคะ แอดมินจะทักกลับในแชทนี้เลยค่ะ";

const charCount = (value) => [...String(value || "")].length;

function notifyLine(notify = {}) {
  if (notify.sent > 0) return `🔔 แจ้งแอดมินทาง LINE แล้ว ${notify.sent}/${notify.total} คน`;
  if (notify.skipped === "no_recipients") return "⚠️ ยังไม่ได้ตั้งผู้รับแจ้งเตือนของสาขานี้ — ห้องขึ้นคิวรอคนในคอนโซลแล้ว แต่ไม่มี push ออกไป";
  if (notify.skipped === "spam") return "ห้องนี้อยู่ในสแปม — ไม่ส่ง push (ห้องขึ้นคิวรอคนในคอนโซลแล้ว)";
  return "⚠️ ส่ง push แจ้งแอดมินไม่สำเร็จ — ห้องขึ้นคิวรอคนในคอนโซลแล้ว";
}

// เหตุที่ข้อความไม่ถึง — ห้องถูกส่งต่อแอดมินแล้วทุกกรณี (การส่งไม่ถึงไม่ยกเลิกการส่งต่อ)
export function handoffTitle(result = {}) {
  if (result.reason === "send_failed") return "ส่งต่อแอดมินแล้ว — แต่ข้อความไม่ถึงลูกค้า";
  if (result.reason === "send_unknown") return "ส่งต่อแอดมินแล้ว — ไม่แน่ใจว่าข้อความถึงลูกค้า เปิดแชทเช็กก่อนส่งซ้ำ";
  if (result.reason) return `ส่งต่อแอดมินแล้ว — ไม่ได้ส่งข้อความ (${result.reasonText || result.reason})`;
  if (result.status === "partial") return `ส่งต่อแล้ว · ข้อความถึงลูกค้าบางส่วน (${result.delivered}/${result.expected}) — เปิดแชทดูก่อน`;
  return "ส่งต่อแอดมินแล้ว";
}

export function handoffResultPanel(result) {
  if (!result) return null;
  if (!result.ok) {
    return el("div", { class: "yolo-result is-refused", role: "alert" },
      el("strong", { class: "yolo-result-title" }, "ยังไม่ได้ส่งต่อ"),
      el("p", { class: "yolo-meta" }, result.reasonText || result.error || "ส่งต่อไม่สำเร็จ"));
  }
  return el("div", { class: `yolo-result ${result.status === "partial" ? "is-partial" : "is-sent"}`, role: "status" },
    el("strong", { class: "yolo-result-title" }, handoffTitle(result)),
    result.bubbles?.length ? el("div", { class: "yolo-sent" }, result.bubbles.map((text) => el("p", { class: "yolo-sent-bubble" }, text))) : null,
    el("p", { class: "yolo-meta" }, notifyLine(result.notify)),
    el("p", { class: "yolo-meta" }, result.customer?.aiEnabled
      ? "AI ห้องนี้ยังเปิด — ลูกค้าตอบมา ลูกแพรคุยต่อให้ระหว่างรอแอดมิน"
      : `AI ห้องนี้ปิด${result.aiClosed ? "แล้ว (ตามที่เลือก)" : "อยู่"} — แอดมินคุยเอง`));
}

function aiChoice(room, aiOn) {
  if (!aiOn) return el("p", { class: "yolo-meta is-muted" }, "AI ห้องนี้ปิดอยู่แล้ว — แอดมินคุยเอง");
  const option = (value, title, sub) => {
    const input = el("input", {
      type: "radio", name: "yolo-handoff-ai", class: "yolo-radio", value: value ? "close" : "keep",
      onchange: () => { room.closeAi = value; },
    });
    input.checked = room.closeAi === value;
    return el("label", { class: "yolo-choice" }, input,
      el("span", { class: "yolo-choice-text" }, el("strong", {}, title), el("span", { class: "yolo-choice-sub" }, sub)));
  };
  return el("fieldset", { class: "yolo-choices" },
    el("legend", { class: "yolo-label" }, "AI ห้องนี้"),
    option(true, "ปิด AI", "แอดมินคุยเองทั้งหมด ลูกแพรเงียบ"),
    option(false, "ไม่ปิด", "ลูกแพรคุยต่อระหว่างรอแอดมิน"));
}

// ส่วนกลางของกล่องเมื่ออยู่แท็บส่งต่อ — yolo.mjs ใส่หัว/บริบท/ผลให้
export function handoffBody({ room, aiOn, onSubmit, onClose }) {
  const counter = el("span", { class: "yolo-count", "aria-live": "polite" }, `${charCount(room.handoffMessage)}/${HANDOFF_MAX_CHARS}`);
  const textarea = el("textarea", {
    class: "yolo-input keep-focus", rows: "3", maxlength: String(HANDOFF_MAX_CHARS), id: "yolo-handoff-message",
    placeholder: "พิมพ์ข้อความที่จะส่งถึงลูกค้า (ส่งตามนี้เป๊ะ) — เว้นว่าง = แจ้งแอดมินอย่างเดียว",
    oninput: (event) => {
      room.handoffMessage = event.target.value;
      counter.textContent = `${charCount(room.handoffMessage)}/${HANDOFF_MAX_CHARS}`;
    },
    onkeydown: (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) onSubmit();
    },
  });
  textarea.value = room.handoffMessage;
  const fillSuggestion = () => {
    room.handoffMessage = HANDOFF_SUGGESTION;
    textarea.value = HANDOFF_SUGGESTION;
    counter.textContent = `${charCount(HANDOFF_SUGGESTION)}/${HANDOFF_MAX_CHARS}`;
    textarea.focus();
  };
  return [
    el("label", { class: "yolo-label", for: "yolo-handoff-message" }, "ข้อความถึงลูกค้า (ไม่ใส่ก็ได้)"),
    textarea,
    el("div", { class: "yolo-row" },
      el("button", { class: "yolo-suggest", type: "button", onclick: fillSuggestion }, "ใช้ประโยคมาตรฐาน"),
      counter),
    aiChoice(room, aiOn),
    el("p", { class: "yolo-hint" }, "กดแล้ว: ส่งข้อความนี้ถึงลูกค้า (ถ้ามี) · ห้องขึ้นคิว \"รอคน\" พร้อมโน้ต · push แจ้งแอดมินทาง LINE ทันที"),
    el("div", { class: "yolo-actions" },
      el("button", { class: "btn btn-ghost btn-mini", type: "button", onclick: onClose }, "ปิด"),
      el("button", {
        class: `btn btn-primary btn-mini yolo-send${room.busy ? " is-busy" : ""}`, type: "button",
        disabled: room.busy ? "disabled" : null, onclick: onSubmit,
      }, room.busy ? "กำลังส่งต่อ…" : "🔔 ส่งต่อแอดมิน")),
  ];
}
