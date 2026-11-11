import { el } from "./dom.mjs";
import { parseIntakeCsv, rowsFromIntakeCsv, suggestedIntakeColumns } from "./intakeCsv.mjs";

const MAX_ROWS = 40;
const ISSUE_LABELS = Object.freeze({
  money: "มีข้อมูลราคา/การเงิน", promotion_or_terms: "มีเงื่อนไขหรือโปรโมชั่น",
  schedule_or_capacity: "มีวันหรือจำนวนที่นั่ง", policy_or_promise: "มีนโยบายหรือคำสัญญา",
  personal_or_financial_data: "อาจมีข้อมูลส่วนบุคคลหรือการเงิน", regulated_or_safety: "เป็นเรื่องที่ต้องให้ทีมตรวจ",
  system_policy: "เป็นข้อมูลภายในระบบ",
});

function metadataValue(fields) {
  return {
    mode: "retrieve",
    domain: fields.domain.value.trim(),
    offering: fields.offering.value.trim(),
    keywords: fields.keywords.value.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

function rowEditor(row, index, onChange, onRemove) {
  const title = el("input", { class: "ti-input", type: "text", maxlength: "200", value: row.title, placeholder: "หัวข้อ" });
  const question = el("textarea", { class: "ti-input", rows: "2", maxlength: "2000", placeholder: "คำถามที่ทีมคัดแล้ว" }, row.question);
  const answer = el("textarea", { class: "ti-input", rows: "3", maxlength: "8000", placeholder: "คำตอบทั่วไปที่ทีมตรวจแล้ว" }, row.answer);
  const sync = () => { row.title = title.value; row.question = question.value; row.answer = answer.value; onChange(); };
  [title, question, answer].forEach((node) => node.addEventListener("input", sync));
  const remove = el("button", { class: "btn btn-outline btn-mini", type: "button" }, "ลบ");
  remove.addEventListener("click", () => onRemove());
  return el("article", { class: "ti-row" },
    el("div", { class: "ti-row-head" }, el("strong", {}, `รายการ ${index + 1}`), remove), title, question, answer,
  );
}

function columnSelect(label, headers, value, onChange) {
  const select = el("select", { class: "ti-input", "aria-label": label },
    el("option", { value: "" }, `เลือกคอลัมน์${label}`),
    headers.map((header) => el("option", { value: header }, header)),
  );
  select.value = value || "";
  select.addEventListener("change", () => onChange(select.value));
  return el("label", { class: "ti-field" }, label, select);
}

export function createTrainingIntakePage({ api, toast, mount, pageHeader, tabBar, stopPolling, setView }) {
  async function render() {
    stopPolling();
    let data;
    try { data = await api("/console/api/teach/intake"); }
    catch (err) {
      mount(pageHeader("รับข้อมูลเพื่อสอน"), el("main", { class: "page-scroll" }, el("div", { class: "page-inner" },
        el("section", { class: "block" }, el("h2", { class: "block-title" }, "เปิดหน้ารับข้อมูลไม่ได้"), el("p", { class: "block-hint" }, err.message)))), tabBar());
      return;
    }
    if (data?.enabled === false || data?.ready === false || data?.ok === false) {
      mount(pageHeader("รับข้อมูลเพื่อสอน"), el("main", { class: "page-scroll" }, el("div", { class: "page-inner" },
        el("section", { class: "block" }, el("h2", { class: "block-title" }, "ยังไม่พร้อมรับข้อมูล"), el("p", { class: "block-hint" }, data?.message || "สิทธิ์หรือการตั้งค่าระบบยังไม่พร้อม")))), tabBar());
      return;
    }

    const publicationReady = data.publicationReady === true;
    const readinessMessage = String(data.message || "").trim();

    const form = { rows: [{ title: "", question: "", answer: "" }], parsed: null, mapping: {}, preview: null, busy: false, revision: 0 };
    const source = el("select", { class: "ti-input", "aria-label": "ที่มาข้อมูล" },
      el("option", { value: "team_notes" }, "ทีมคัดจากโน้ตภายใน"),
      el("option", { value: "line_oa_curated" }, "ทีมคัดจาก LINE OA แล้ว"),
    );
    const channels = data.channels || data.channelChoices || [];
    const channel = el("select", { class: "ti-input", "aria-label": "ขอบเขตความรู้" },
      el("option", { value: "" }, "สมองกลาง (ใช้ร่วมกัน)"),
      channels.filter((item) => (item?.id ?? item?.channelId) != null && (item?.id ?? item?.channelId) !== "")
        .map((item) => el("option", { value: item.id ?? item.channelId }, item.name || item.label || item.id || item.channelId)),
    );
    const fields = {
      domain: el("input", { class: "ti-input", type: "text", maxlength: "64", placeholder: "เช่น LINE" }),
      offering: el("input", { class: "ti-input", type: "text", maxlength: "64", placeholder: "เช่น LINE Basic" }),
      keywords: el("input", { class: "ti-input", type: "text", maxlength: "1619", placeholder: "คั่นด้วยจุลภาค" }),
    };
    const rowsBox = el("div", { class: "ti-rows" });
    const mappingBox = el("div", { class: "ti-mapping" });
    const previewBox = el("section", { class: "ti-preview", hidden: "" });
    const reviewed = el("input", { type: "checkbox", class: "ti-reviewed" });
    const previewButton = el("button", { class: "btn btn-outline", type: "button" }, "ตรวจตัวอย่างก่อนเสนอ");
    const submitButton = el("button", { class: "btn btn-primary", type: "button", disabled: "" }, "เสนอเข้าคิวตรวจ");
    const addButton = el("button", { class: "btn btn-outline", type: "button" }, "เพิ่มรายการ");

    function updateSubmit() {
      const receipt = form.preview?.receipt;
      submitButton.disabled = form.busy || !(receipt?.canCommit && receipt.previewHash && reviewed.checked);
    }
    function invalidate() {
      form.revision += 1;
      form.preview = null;
      reviewed.checked = false;
      previewBox.hidden = true;
      updateSubmit();
    }
    function renderRows() {
      rowsBox.replaceChildren(...form.rows.map((row, index) => rowEditor(row, index, invalidate, () => {
        form.rows.splice(index, 1); if (!form.rows.length) form.rows.push({ title: "", question: "", answer: "" }); invalidate(); renderRows();
      })));
    }
    function renderMapping() {
      if (!form.parsed) { mappingBox.replaceChildren(); return; }
      mappingBox.replaceChildren(
        el("p", { class: "block-hint" }, "เลือกว่าคอลัมน์ใดคือข้อมูลแต่ละช่องก่อนนำเข้า"),
        columnSelect("หัวข้อ", form.parsed.headers, form.mapping.title, (value) => { form.mapping.title = value; invalidate(); }),
        columnSelect("คำถาม", form.parsed.headers, form.mapping.question, (value) => { form.mapping.question = value; invalidate(); }),
        columnSelect("คำตอบ", form.parsed.headers, form.mapping.answer, (value) => { form.mapping.answer = value; invalidate(); }),
        el("button", { class: "btn btn-outline", type: "button", onclick: () => {
          try {
            const rows = rowsFromIntakeCsv(form.parsed, form.mapping);
            if (rows.length > MAX_ROWS) throw new Error(`รับได้ไม่เกิน ${MAX_ROWS} รายการ`);
            form.rows = rows; invalidate(); renderRows(); toast(`นำเข้ารายการ ${form.rows.length} รายการแล้ว`);
          }
          catch (err) { toast(err.message); }
        } }, "ใช้ตารางนี้"),
      );
    }
    function payloadSnapshot() {
      const metadata = metadataValue(fields);
      return Object.freeze({
        origin: source.value, channelId: channel.value || null,
        knowledgeMetadata: Object.freeze({ ...metadata, keywords: Object.freeze([...metadata.keywords]) }),
        entries: Object.freeze(form.rows.map((row) => Object.freeze({ title: row.title, question: row.question, answer: row.answer }))),
      });
    }
    function renderPreview(result) {
      const summary = result.summary || {};
      previewBox.replaceChildren(
        el("h2", { class: "block-title" }, "ผลตรวจก่อนเสนอ"),
        el("p", { class: "block-hint" }, `พร้อม ${summary.ready ?? 0} จาก ${summary.total ?? form.rows.length} รายการ · ซ้ำ ${summary.duplicates ?? 0} · ติดด่าน ${summary.blocked ?? 0}`),
        el("div", { class: "ti-preview-rows" }, (result.rows || []).map((row) => {
          const issues = (row.issueCodes || row.riskFlags || []).map((code) => ISSUE_LABELS[code] || String(code));
          return el("article", { class: "ti-preview-row" },
            el("strong", {}, `รายการ ${Number(row.index) + 1}: ${row.title || "ต้องแก้ไขก่อนเสนอ"}`),
            row.content ? el("pre", { class: "ti-preview-content" }, row.content) : null,
            issues.length ? el("p", { class: "block-hint" }, `ติดด่าน: ${issues.join(" · ")}`) : null,
          );
        })),
        el("label", { class: "ti-review-check" }, reviewed, "ฉันตรวจเนื้อหาที่เลือกแล้ว และเข้าใจว่าการส่งครั้งนี้เป็นเพียงข้อเสนอรอเจ้าของตรวจ"),
      );
      previewBox.hidden = false;
      updateSubmit();
    }
    [source, channel, ...Object.values(fields)].forEach((node) => node.addEventListener("input", invalidate));
    source.addEventListener("change", invalidate); channel.addEventListener("change", invalidate);
    reviewed.addEventListener("change", updateSubmit);
    addButton.addEventListener("click", () => { if (form.rows.length >= MAX_ROWS) return toast(`รับได้ไม่เกิน ${MAX_ROWS} รายการ`); form.rows.push({ title: "", question: "", answer: "" }); invalidate(); renderRows(); });
    previewButton.addEventListener("click", async () => {
      if (form.busy) return;
      invalidate();
      const requestRevision = form.revision;
      const input = payloadSnapshot();
      form.busy = true; previewButton.disabled = true; updateSubmit();
      try {
        const receipt = await api("/console/api/teach/intake/preview", { method: "POST", body: input });
        if (form.revision !== requestRevision) return;
        form.preview = Object.freeze({ receipt: Object.freeze({ ...receipt }), input, revision: requestRevision });
        renderPreview(receipt);
      }
      catch (err) { toast(err.message); }
      finally { form.busy = false; previewButton.disabled = false; updateSubmit(); }
    });
    submitButton.addEventListener("click", async () => {
      const preview = form.preview;
      if (form.busy) return;
      if (!preview?.receipt?.canCommit || !preview.receipt.previewHash || !reviewed.checked) return toast("ตรวจตัวอย่างและติ๊กยืนยันก่อนค่ะ");
      form.busy = true; updateSubmit();
      try {
        const result = await api("/console/api/teach/intake/commit", { method: "POST", body: { ...preview.input, previewHash: preview.receipt.previewHash, confirm: true } });
        // Keep the captured receipt until this request settles: a staff edit
        // during the request must never change what is committed.  Once it is
        // accepted, consume that receipt so finally cannot re-enable a repeat
        // submit; the edited form remains available but needs a fresh preview.
        const changedWhileSubmitting = form.revision !== preview.revision;
        form.lastSubmitted = preview;
        form.preview = null;
        reviewed.checked = false;
        toast(`รับข้อเสนอ ${result.created ?? 0} รายการเข้าคิวแล้ว — ยังไม่เปิดใช้ตอบลูกค้า`);
        previewBox.replaceChildren(el("h2", { class: "block-title" }, "เสนอเข้าคิวตรวจแล้ว"),
          el("p", { class: "block-hint" }, changedWhileSubmitting
            ? "ระบบเสนอข้อมูลจากตัวอย่างที่ตรวจไว้ก่อนแก้ไขล่าสุดแล้ว ข้อมูลที่แก้ภายหลังยังไม่ได้เสนอ และต้องตรวจตัวอย่างใหม่"
            : "ข้อเสนอเข้าคิวแล้ว แต่ยังไม่เปิดใช้ตอบลูกค้า เจ้าของต้องตรวจและตัดสินใจในคิวเรียนรู้ก่อน"),
          el("a", { class: "btn btn-outline", href: "#/review" }, "ไปกล่องตรวจ"));
        previewBox.hidden = false;
      } catch (err) {
        toast(err.message);
        if (Number(err?.status) === 409) invalidate();
      } finally { form.busy = false; updateSubmit(); }
    });
    const file = el("input", { class: "ti-file", type: "file", accept: ".csv,text/csv" });
    file.addEventListener("change", () => {
      invalidate();
      const fileRevision = form.revision;
      const picked = file.files?.[0]; if (!picked) return;
      if (picked.size > 1024 * 1024) { form.parsed = null; form.mapping = {}; renderMapping(); toast("ไฟล์ใหญ่เกิน 1 MiB"); return; }
      const reader = new FileReader();
      reader.onload = () => {
        if (form.revision !== fileRevision) return;
        try { form.parsed = parseIntakeCsv(String(reader.result || "")); form.mapping = suggestedIntakeColumns(form.parsed.headers); renderMapping(); }
        catch (err) { form.parsed = null; form.mapping = {}; renderMapping(); toast(err.message); }
      };
      reader.onerror = () => {
        if (form.revision !== fileRevision) return;
        form.parsed = null; form.mapping = {}; renderMapping(); toast("อ่านไฟล์ไม่สำเร็จ");
      }; reader.readAsText(picked, "utf-8"); file.value = "";
    });
    const sample = el("a", { class: "btn btn-outline", href: "/console/static/training-intake-sample.csv", download: "training-intake-synthetic-sample.csv" }, "ดาวน์โหลดตัวอย่างทั่วไป CSV");
    renderRows();
    mount(pageHeader("รับข้อมูลเพื่อสอน"), el("main", { class: "page-scroll" }, el("div", { class: "page-inner ti-page" },
      el("section", { class: "block" }, el("h2", { class: "block-title" }, "คัดความรู้ก่อนเข้าคิว"),
        !publicationReady ? el("p", { class: "ti-stage", role: "status" }, "รับข้อเสนอได้ • ยังไม่เปิดใช้ตอบลูกค้า") : null,
        readinessMessage ? el("p", { class: "block-hint" }, readinessMessage) : null,
        el("p", { class: "block-hint" }, "รับเฉพาะคำถาม-คำตอบที่ทีมคัดและตัดข้อมูลส่วนบุคคลแล้ว ระบบนี้ยังไม่เชื่อมประวัติหรือแท็ก LINE OA อัตโนมัติ ข้อมูลที่กรอกยังไม่เผยแพร่จนกว่าเจ้าของจะอนุมัติ"),
        el("label", { class: "ti-field" }, "ที่มา", source), el("label", { class: "ti-field" }, "ขอบเขต", channel),
        el("fieldset", { class: "ti-metadata" }, el("legend", {}, "ให้ระบบเลือกใช้เมื่อถามเรื่องนี้"),
          el("label", { class: "ti-field" }, "หมวดความรู้", fields.domain),
          el("label", { class: "ti-field" }, "คลาสหรือบริการที่เกี่ยวข้อง", fields.offering),
          el("label", { class: "ti-field" }, "คำค้นที่เกี่ยวข้อง", fields.keywords))),
      el("section", { class: "block" }, el("h2", { class: "block-title" }, "นำเข้าตารางหรือพิมพ์เอง"), file, mappingBox, el("div", { class: "block-actions" }, addButton, sample), el("p", { class: "block-hint" }, "ไฟล์ตัวอย่างเป็นข้อมูลทั่วไปสมมติ ใช้เพื่อดูรูปแบบเท่านั้น และไม่ได้ถูกนำเข้าอัตโนมัติ"), rowsBox),
      el("section", { class: "block" }, el("div", { class: "block-actions" }, previewButton, submitButton), previewBox),
    )), tabBar());
    setView("page");
  }
  return render;
}
