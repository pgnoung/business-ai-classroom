// stepActivation.mjs — หน้ายืนยัน "เปิดใช้" ลำดับข้อความตามขั้น (28 ก.ย. 2026)
// ตรวจ (preview) → สรุปจุดเริ่ม ขั้น ประมาณข้อความต่อเดือน โควตา คนที่ตรงอยู่แล้ว คำเตือน → พิมพ์ "เปิดใช้"
// ใบยืนยันของเซิร์ฟเวอร์อายุ 45 วิ ผูกกับเวอร์ชันลำดับ — ขอใบใหม่อัตโนมัติก่อนหมด (แบบเดียวกับหน้ายืนยันบรอดแคสต์)
import { el } from "./dom.mjs";
import { formatCount, quotaBar } from "./broadcastCreate.mjs";

const RECONFIRM_AFTER_MS = 38_000;

function conditionText(condition) {
  if (!condition) return "";
  const text = (list) => list.map((tag) => String(tag).replace(/\s*:\s*\*$/u, ": ทุกค่า")).join(", ");
  const parts = [];
  if (condition.hasTags?.length) parts.push(`ต้องมี ${text(condition.hasTags)}`);
  if (condition.hasNotTags?.length) parts.push(`ต้องไม่มี ${text(condition.hasNotTags)}`);
  return parts.join(" · ");
}

/** เปิดหน้ายืนยัน — คืน Promise ที่จบเมื่อปิดหน้า (activated = true ถ้าเปิดใช้สำเร็จ) */
export async function openActivationSheet({ api, toast, sequenceId, onActivated }) {
  const base = `/console/api/broadcast/steps/${encodeURIComponent(sequenceId)}`;
  let preview;
  try {
    preview = await api(`${base}/preview`, { method: "POST", body: {} });
  } catch (error) {
    toast(error.message);
    return { activated: false };
  }
  let issuedAt = Date.now();
  const s = preview.summary;
  const typed = el("input", {
    class: "order-in bs-input bs-confirm-input keep-focus", autocomplete: "off", "aria-label": "พิมพ์เพื่อยืนยัน",
    oninput: () => { go.disabled = typed.value.trim() !== s.expectedConfirmText; },
  });
  const status = el("p", { class: "bs-confirm-status", "aria-live": "polite" });
  const go = el("button", { type: "button", class: "btn btn-primary", disabled: true }, "เปิดใช้");
  const cancel = el("button", { type: "button", class: "btn btn-ghost" }, "ยกเลิก");
  const estimate = s.estimate || {};
  const dialog = el("dialog", { class: "bs-sheet sm-sheet", "aria-labelledby": "sm-sheet-title" },
    el("form", { class: "bs-sheet-body", method: "dialog", onsubmit: (event) => event.preventDefault() },
      el("h2", { id: "sm-sheet-title", class: "bs-sheet-title" }, `เปิดใช้ "${s.name}"`),
      el("dl", { class: "bs-facts" },
        el("dt", {}, "LINE OA"), el("dd", {}, s.channelName),
        el("dt", {}, "เริ่มเมื่อ"), el("dd", {}, s.triggerText),
        el("dt", {}, "หยุดเมื่อลูกค้าตอบ"), el("dd", {}, s.stopOnReply ? "หยุด" : "ส่งต่อจนครบ (ยกเว้นเข้าเงื่อนไขหยุดอื่น)"),
        el("dt", {}, "ประมาณต่อเดือน"), el("dd", {},
          `${formatCount(estimate.enrollmentsPerMonth)} คนเข้าลำดับ · ${formatCount(estimate.messagesPerMonth)} ข้อความ`,
          estimate.basis ? el("span", { class: "sm-basis" }, ` (${estimate.basis})`) : null),
        el("dt", {}, "ตรงอยู่แล้ว"), el("dd", {}, s.baseline > 0 ? `${formatCount(s.baseline)} คน — ไม่ได้รับย้อนหลัง` : "—")),
      el("ol", { class: "sm-sheet-steps" }, (s.steps || []).map((step) => el("li", {},
        el("strong", {}, `ขั้นที่ ${step.step}`), ` · ${step.delayText} · ${step.bubbles} บับเบิล`,
        step.condition ? el("span", { class: "sm-basis" }, ` · ${conditionText(step.condition)}`) : null))),
      quotaBar(s.quota, estimate.messagesPerMonth || 0, { useLabel: "ลำดับนี้ต่อเดือนประมาณ", afterLabel: "ถ้าคิดเป็นเดือนนี้เหลือ" }),
      s.warnings?.length ? el("ul", { class: "bs-warn-list" }, s.warnings.map((text) => el("li", {}, text))) : null,
      el("label", { class: "bs-confirm" },
        el("span", {}, "พิมพ์ ", el("strong", { class: "bs-confirm-code" }, s.expectedConfirmText), " เพื่อยืนยัน — หลังเปิดใช้ ระบบส่งเองตามเวลาของแต่ละขั้น"),
        typed),
      status,
      el("div", { class: "bs-sheet-actions" }, cancel, go)));

  return new Promise((resolve) => {
    const close = (activated) => {
      try { dialog.close?.(); } catch { /* ปิดไปแล้ว */ }
      dialog.remove();
      resolve({ activated });
    };
    cancel.addEventListener("click", () => close(false));
    dialog.addEventListener("cancel", () => close(false));
    go.addEventListener("click", async () => {
      go.disabled = true;
      cancel.disabled = true;
      try {
        if (Date.now() - issuedAt > RECONFIRM_AFTER_MS) {
          status.textContent = "ใบยืนยันใกล้หมดอายุ — กำลังตรวจใหม่…";
          preview = await api(`${base}/preview`, { method: "POST", body: {} });
          issuedAt = Date.now();
        }
        const response = await api(`${base}/activate`, {
          method: "POST", body: { confirm: true, confirmText: typed.value.trim(), confirmation: preview.confirmation },
        });
        toast(response.baseline > 0
          ? `เปิดใช้แล้ว — ${formatCount(response.baseline)} คนที่ตรงอยู่แล้วไม่ได้รับย้อนหลัง`
          : "เปิดใช้แล้ว — ระบบเริ่มนับคนที่เข้าเงื่อนไขตั้งแต่ตอนนี้");
        onActivated?.(response.sequence);
        close(true);
      } catch (error) {
        status.textContent = error.message;
        cancel.disabled = false;
        go.disabled = typed.value.trim() !== s.expectedConfirmText;
      }
    });
    globalThis.document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    queueMicrotask(() => typed.focus?.());
  });
}
