// settingsIdentityLink.mjs — ข้อความที่ลูกค้าได้ใน LINE หลังเชื่อมแชทจาก Facebook แยกตามคลาส (หน้าตั้งค่า · 28 ก.ย. 2026)
//
// คำตอบพี่ง้วง: หลังลูกค้าที่ซื้อแล้วเชื่อม LINE → "สวัสดีค่ะ คุณ{ชื่อ}" แล้วส่งรายละเอียดตามสิ่งที่ซื้อได้เลย
// ข้อความของแต่ละคลาสเป็นข้อความตายตัวที่เจ้าของอนุมัติ — แก้ที่นี่มีผลกับลูกค้าคนถัดไปทันที ไม่ต้อง deploy
//   · ทุกคนที่เข้าหน้าตั้งค่าอ่านได้ (ทีมควรรู้ว่าลูกค้าได้อะไรไปแล้ว) · แก้ได้เฉพาะ Super Admin
//   · ตัวอย่างฝั่งขวาคือบับเบิลที่ลูกค้าจะเห็นจริง (เซิร์ฟเวอร์แตกบับเบิลให้ — กติกาเดียวกับตอนส่ง)
//   · ว่าง = ลูกค้าได้คำทักทาย + "ทีมงานจะส่ง…ให้ในแชทนี้นะคะ" และทีมได้ธงให้ส่งเอง
// ทุกค่าเข้า DOM ผ่าน el() (text node) · ไม่มี inline style (CSP) — หน้าตาอยู่ที่ identityLinks.css
import { el } from "./dom.mjs";

const PATH = "/console/api/settings/identity-link-templates";
const PREVIEW_DELAY_MS = 250;

const dateText = (ms) => {
  const d = new Date(Number(ms));
  return Number(ms) > 0 && Number.isFinite(d.getTime())
    ? d.toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "";
};

function statusOf(template) {
  if (template.readError) return { cls: "is-empty", text: "อ่านข้อความไม่ได้ — ระบบจะส่งแค่คำทักทาย" };
  if (template.empty) return { cls: "is-empty", text: "ยังไม่มีข้อความ" };
  if (template.isDefault) return { cls: "is-default", text: "ค่าเริ่มต้นจากคลังความรู้ (รออนุมัติถ้อยคำ)" };
  const when = dateText(template.updatedAt);
  return { cls: "is-custom", text: `แก้โดย ${template.updatedBy || "เจ้าของ"}${when ? ` · ${when}` : ""}` };
}

function bubbleList(bubbles, error = "") {
  return el("div", { class: "idl-tpl-phone", role: "list", "aria-label": "ตัวอย่างข้อความใน LINE" },
    (bubbles || []).map((text) => el("p", { class: "idl-tpl-bubble", role: "listitem" }, text)),
    error ? el("p", { class: "idl-tpl-error", role: "alert" }, error) : null);
}

export async function identityLinkTemplatesBlock({ api, toast } = {}) {
  const data = await api(PATH).catch(() => null);
  if (!data?.templates?.length) return null;
  const canEdit = data.canEdit === true;

  function card(template) {
    const status = statusOf(template);
    const node = el("article", { class: "idl-tpl", "data-class": template.classType });
    const phone = el("div", { class: "idl-tpl-preview" }, bubbleList(template.preview));
    const counter = el("p", { class: "idl-tpl-count" });
    const setCount = (text, bubbles) => {
      counter.textContent = text.trim()
        ? `${text.length.toLocaleString("th-TH")} ตัวอักษร · ลูกค้าเห็น ${bubbles} ข้อความ · ขึ้นข้อความใหม่ด้วยบรรทัดที่มีแค่ ---`
        : `ว่าง = ลูกค้าได้ "สวัสดีค่ะ คุณ… 🙏 ${template.fallback}" และทีมได้ธงให้ส่งเอง`;
    };
    setCount(template.text, template.preview.length);
    let editor = null;
    let save = null;
    if (canEdit) {
      let timer = null;
      editor = el("textarea", {
        class: "note-input idl-tpl-input", rows: "12", maxlength: String(data.limits?.totalChars || 6000),
        "aria-label": `ข้อความหลังเชื่อม LINE ของ ${template.label}`, placeholder: `ยังไม่มีข้อความ — ${template.fallback}`,
        oninput: () => {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            try {
              const res = await api(`${PATH}/preview`, { method: "POST", body: { classType: template.classType, text: editor.value } });
              phone.replaceChildren(bubbleList(res.bubbles, res.valid ? "" : res.error));
              setCount(editor.value, res.bubbles?.length || 0);
              save.disabled = !res.valid;
            } catch (err) {
              phone.replaceChildren(bubbleList([], err.message));
            }
          }, PREVIEW_DELAY_MS);
        },
      });
      editor.value = template.text;
      save = el("button", {
        class: "btn btn-primary btn-mini idl-tpl-save",
        onclick: async () => {
          save.disabled = true;
          try {
            const res = await api(PATH, { method: "POST", body: { classType: template.classType, text: editor.value } });
            toast(`บันทึกข้อความของ ${template.label} แล้ว — ลูกค้าคนถัดไปได้ข้อความนี้ทันที`);
            node.replaceWith(card(res.template));
          } catch (err) {
            toast(err.message);
            save.disabled = false;
          }
        },
      }, "บันทึก");
    }
    const reset = canEdit && !template.isDefault
      ? el("button", {
        class: "btn btn-outline btn-mini idl-tpl-reset",
        onclick: async () => {
          if (!window.confirm(`กลับไปใช้ข้อความค่าเริ่มต้นของ ${template.label}?${template.defaultText ? "" : "\n(คลาสนี้ค่าเริ่มต้นว่าง — ลูกค้าจะได้แค่คำทักทาย + ทีมงานจะส่งให้)"}`)) return;
          try {
            const res = await api(PATH, { method: "POST", body: { classType: template.classType, reset: true } });
            toast(`${template.label}: กลับไปใช้ค่าเริ่มต้นแล้ว`);
            node.replaceWith(card(res.template));
          } catch (err) {
            toast(err.message);
          }
        },
      }, "ใช้ค่าเริ่มต้น")
      : null;
    node.append(
      el("header", { class: "idl-tpl-head" },
        el("h3", { class: "idl-tpl-title" }, template.label),
        el("span", { class: `idl-tpl-status ${status.cls}` }, status.text)),
      el("p", { class: "idl-tpl-hint" }, template.hint),
      el("div", { class: "idl-tpl-body" },
        el("div", { class: "idl-tpl-editor" },
          canEdit ? editor : el("pre", { class: "idl-tpl-readonly" }, template.text || "ยังไม่มีข้อความ"),
          counter,
          canEdit ? el("div", { class: "idl-tpl-actions" }, save, reset) : null),
        phone),
    );
    return node;
  }

  return el("section", { class: "block idl-tpl-block", "aria-labelledby": "idl-tpl-heading" },
    el("h2", { class: "block-title", id: "idl-tpl-heading" }, "ข้อความหลังลูกค้าเชื่อม LINE (แยกตามคลาสที่ซื้อ)"),
    el("p", { class: "block-hint" },
      "ลูกค้าที่ซื้อแล้วกดลิงก์จาก Facebook มาส่งรหัสใน LINE — ระบบตอบ \"สวัสดีค่ะ คุณ{ชื่อ} 🙏\" ตามด้วยข้อความของคลาสนั้นทันที "
      + "(ตอบด้วย reply token ไม่กินโควตา) · ส่งเมื่อเปิดสวิตช์ \"ส่งลิงก์ต่อแชท LINE\" เท่านั้น"),
    el("p", { class: "block-hint" },
      canEdit ? `ตัวอย่างใช้ชื่อ "${data.sampleName}" — ลูกค้าจริงเห็นชื่อสั้นของตัวเอง · แก้แล้วมีผลกับลูกค้าคนถัดไปทันที`
        : "เฉพาะ Super Admin เท่านั้นที่แก้ข้อความที่ส่งถึงลูกค้าได้ — ทีมดูได้อย่างเดียว"),
    el("div", { class: "idl-tpl-list" }, data.templates.map(card)),
  );
}
