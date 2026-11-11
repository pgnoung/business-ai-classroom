// settingsAdWelcome.mjs — กล่อง "คำถามต้อนรับในโฆษณา Facebook" (audit ก.ย. 2026 §4.1)
// โหลดข้อมูลของตัวเอง (เส้น /settings/fb-ad-welcome) จึงไม่แตะ Promise.all ของหน้าตั้งค่า
// ใช้คลาสที่มีอยู่แล้วทั้งหมด — CSP style-src 'self' บล็อก inline style
import { el } from "./dom.mjs";

export async function adWelcomeQuestionBlock({ api, toast, refresh } = {}) {
  const data = await api("/console/api/settings/fb-ad-welcome").catch(() => null);
  if (!data) return null;
  const input = el("textarea", {
    class: "order-in keep-focus product-rules-input", rows: "3",
    maxlength: String(data.maxChars || 400),
    placeholder: "เช่น ไม่ทราบว่าเคยใช้ AI ช่วยงานมาก่อนไหมคะ?",
    disabled: data.canEdit ? null : "disabled",
  });
  input.value = data.question || "";
  const save = data.canEdit ? el("button", {
    class: "btn btn-primary btn-mini",
    onclick: async () => {
      save.disabled = true;
      try {
        await api("/console/api/settings/fb-ad-welcome", { method: "POST", body: { question: input.value } });
        toast(input.value.trim() ? "บันทึกคำถามต้อนรับแล้ว — มีผลกับห้อง Facebook ใหม่ทันที" : "ล้างคำถามต้อนรับแล้ว");
        await refresh?.();
      } catch (error) {
        toast(error.message);
        save.disabled = false;
      }
    },
  }, "บันทึก") : null;
  return el("section", { class: "block" },
    el("h2", { class: "block-title" }, "คำถามต้อนรับในโฆษณา Facebook"),
    el("p", { class: "block-hint" },
      "ลูกค้าจากโฆษณามักตอบคำถามต้อนรับสั้น ๆ เช่น \"ยังครับ\" หรือ \"3\" เป็นข้อความแรก — ใส่คำถามที่โฆษณาถามไว้ตรงนี้ "
      + "ลูกแพรจะเข้าใจว่าลูกค้ากำลังตอบคำถามนี้ (ใช้เป็นบริบทเท่านั้น ไม่ถูกส่งเป็นข้อความในแชท) เว้นว่าง = ระบบเดาจากคำตอบเอง"),
    data.canEdit ? null : el("p", { class: "block-hint" }, "เฉพาะ Super Admin หรือ Admin เท่านั้นที่แก้ได้"),
    input,
    save ? el("div", { class: "block-actions" }, save) : null,
  );
}
