import { el } from "./dom.mjs";

const stop = { permanent: "ปิด AI", temporary: "พัก AI ชั่วคราว", none: "ให้ AI ตอบต่อ", unknown: "ไม่มีหลักฐาน" };
const notify = { provider_accepted: "ผู้ให้บริการรับคำขอแจ้งแล้ว", attempted: "พยายามแจ้งแอดมิน", not_observed: "ไม่พบหลักฐานการแจ้ง", unknown: "ไม่มีหลักฐาน" };
const jevStop = { stop: "ควรหยุด AI", continue: "ควรให้ AI ตอบต่อ", unclear: "ยังตัดสินไม่ได้" };
const jevNotify = { notify: "ควรแจ้งแอดมิน", not_needed: "ไม่จำเป็นต้องแจ้ง", unclear: "ยังตัดสินไม่ได้" };
const confidence = value => Number.isFinite(value) ? `${Number(value).toFixed(1)}/10` : "ไม่มีคะแนน";
const values = feedback => ({ stop: feedback?.stop || null, notify: feedback?.notify || null, note: feedback?.note || "" });
const reasons = { ordinary_information: "คำถามข้อมูลทั่วไป", bank_details_only: "ส่งบัญชีและยังตอบข้อมูลได้", payment_or_slip: "เงินหรือสลิปต้องให้คนตรวจ", human_request: "ลูกค้าขอคุยคนจริง", serious_complaint: "ข้อร้องเรียนที่ต้องรับช่วง", active_human_reply: "คนจริงกำลังตอบ", project_slots: "รายละเอียดงานโครงการ", insufficient_evidence: "หลักฐานไม่พอ", redaction_ambiguous: "ปิดข้อมูลส่วนตัวแล้วบริบทไม่ชัด", evidence_absent_or_too_large: "หลักฐานไม่พอหรือเกินขอบเขต", optout_or_dnd: "ลูกค้าขอหยุดติดต่อ", operational_failure: "ปัญหาระบบหรือผู้ให้บริการ" };

export function comparisonBadge(value, label) {
  const kind = value === "agree" ? "agree" : value === "disagree" ? "disagree" : "unknown";
  return el("span", { class: `jev-badge jev-${kind}` }, label || ({ agree: "ตรงกัน", disagree: "ต่างกัน", unknown: "ยังเทียบไม่ครบ" }[kind]));
}

export function createReviewState(row) {
  return { saved: row?.feedback || null, draft: values(row?.feedback), saving: false, error: "", conflict: false };
}

export function reviewIsDirty(review) {
  return Boolean(review && JSON.stringify(review.draft) !== JSON.stringify(values(review.saved)));
}

function decisionRow(title, original, judgment, comparison) {
  return el("div", { class: "jev-decision-row" }, el("strong", {}, title),
    el("div", {}, el("span", { class: "jev-label" }, "ที่ระบบทำ"), el("span", {}, original)),
    el("div", {}, el("span", { class: "jev-label" }, "JEV เห็น"), el("span", {}, judgment)), comparisonBadge(comparison));
}

// The page owns one review state. Replacing transcript DOM cannot discard a
// draft. Owner labels can feed the live reviewer when enabled on the server.
export function renderJevDecision(container, { api, batchId, row, review = createReviewState(row), isOwner = false, onSaved = () => {}, onReload = () => {}, onDirty = () => {}, onFinished = () => {} }) {
  const current = () => container.isConnected;
  function render() {
    if (!current() || !row) return;
    const differs = row.comparison?.stop === "disagree" || row.comparison?.notify === "disagree";
    const agrees = row.comparison?.stop === "agree" && row.comparison?.notify === "agree";
    const savedLabel = label => label === "correct" ? "JEV ตัดสินถูก" : label === "incorrect" ? "JEV ตัดสินผิด" : "ยังไม่ตัดสิน";
    container.replaceChildren(el("section", { class: "jev-inspector" },
      el("div", { class: "jev-inspector-head" }, el("h3", {}, "ผลตรวจ JEV"), comparisonBadge(differs ? "disagree" : agrees ? "agree" : "unknown")),
      decisionRow("การหยุด AI", stop[row.original?.stop] || "ไม่มีหลักฐาน", `${jevStop[row.jev?.stop?.choice] || "ยังตัดสินไม่ได้"} · ${confidence(row.jev?.stop?.confidence10)}`, row.comparison?.stop),
      decisionRow("การแจ้งแอดมิน", notify[row.original?.notify] || "ไม่มีหลักฐาน", `${jevNotify[row.jev?.notify?.choice] || "ยังตัดสินไม่ได้"} · ${confidence(row.jev?.notify?.confidence10)}`, row.comparison?.notify),
      el("p", { class: "history-muted" }, "คะแนนเต็ม 10 คือความมั่นใจของ JEV ผลต่างยังไม่ใช่ข้อผิดพลาดที่ยืนยันแล้ว"),
      el("details", { class: "jev-evidence" }, el("summary", {}, "เหตุผลและหลักฐานที่ JEV ใช้"),
        el("p", {}, reasons[row.jev?.reason] || "ตรวจตามบริบทที่มี"),
        el("p", {}, `ข้อร้องเรียน: ${{ none: "ไม่พบ", elsewhere: "ปัญหานอกบริการ", frustration: "หงุดหงิดแต่ยังตอบข้อมูลได้", complaint: "ควรให้คนรับช่วง", unclear: "ยังตัดสินไม่ได้" }[row.jev?.complaint?.choice] || "ยังตัดสินไม่ได้"} · ${confidence(row.jev?.complaint?.confidence10)}`),
        row.coverage?.messageCount != null ? el("p", {}, `ใช้ข้อความก่อนเหตุการณ์ ${row.coverage.messageCount} รายการ${row.coverage.omittedCount > 0 ? ` · อีก ${row.coverage.omittedCount} รายการไม่ได้อยู่ในรอบตรวจ` : ""}`) : null,
        row.coverage?.imageUnreviewed ? el("p", {}, "มีรูปหรือไฟล์ที่ JEV ไม่ได้ตรวจเนื้อหา") : null),
      review.saved ? el("p", { class: "jev-saved" }, `บันทึกแล้ว · หยุด AI: ${savedLabel(review.saved.stop)} · แจ้งแอดมิน: ${savedLabel(review.saved.notify)}`) : null,
      review.error ? el("p", { class: "history-error", role: "alert" }, review.error) : null,
      review.conflict ? el("button", { class: "btn btn-ghost", onclick: onReload }, "เปิดความเห็นล่าสุด") : null,
      isOwner && row.canReview ? feedbackForm() : el("p", { class: "history-muted" }, !isOwner ? "เฉพาะเจ้าของระบบที่บันทึกความเห็นได้" : row.jev?.status !== "reviewed" ? "หลักฐานไม่พอให้ JEV ตัดสิน จึงยังมาร์กถูกหรือผิดไม่ได้" : "ผลที่เก็บไว้สำหรับอ่านย้อนหลัง ไม่เปิดแก้ไขความเห็น"),
    ));
  }

  function feedbackForm() {
    const field = (label, key, choices) => {
      const input = el("select", { "aria-label": label, disabled: review.saving || !choices.includes(row.jev?.[key]?.choice), onchange: event => { review.draft[key] = event.target.value || null; onDirty(); } },
        el("option", { value: "" }, "ยังไม่ตัดสิน"), el("option", { value: "correct" }, "JEV ตัดสินถูก"), el("option", { value: "incorrect" }, "JEV ตัดสินผิด"));
      input.value = review.draft[key] || "";
      return el("label", {}, label, input);
    };
    const note = el("textarea", { maxlength: "1000", disabled: review.saving, placeholder: "บันทึกเหตุผลเพิ่มเติม (ไม่บังคับ)", "aria-label": "บันทึกเหตุผล", oninput: event => { review.draft.note = event.target.value; onDirty(); } });
    note.value = review.draft.note;
    const save = el("button", { class: "btn btn-primary", type: "button", disabled: review.saving || review.conflict, onclick: async () => {
      if (review.saving || review.conflict) return;
      if (!review.draft.stop && !review.draft.notify) { review.error = "เลือกความเห็นอย่างน้อยหนึ่งเรื่องก่อนบันทึก"; render(); return; }
      const payload = { ...review.draft, expectedRevision: review.saved?.revision ?? 0 };
      review.saving = true; review.error = ""; render();
      try {
        const result = await api(`/console/api/jev-audits/${encodeURIComponent(batchId)}/cases/${encodeURIComponent(row.id)}/review`, { method: "PUT", body: payload });
        review.saved = result.review;
        review.draft = values(result.review);
        review.formOpen = false;
        onSaved(result.review);
      } catch (cause) {
        review.conflict = cause?.status === 409 || cause?.message === "review_conflict" || cause?.data?.error === "review_conflict";
        review.error = review.conflict ? "มีความเห็นฉบับใหม่กว่า แบบร่างของพี่ยังอยู่ เปิดความเห็นล่าสุดก่อนตัดสินใหม่" : "บันทึกไม่สำเร็จ แบบร่างยังอยู่ กรุณาลองใหม่";
      } finally {
        review.saving = false; onDirty(); render(); onFinished();
      }
    } }, review.saving ? "กำลังบันทึก…" : "บันทึกความเห็น");
    return el("details", { class: "jev-feedback", open: review.formOpen || reviewIsDirty(review) || review.saving || Boolean(review.error), ontoggle: event => { review.formOpen = event.target.open; } }, el("summary", {}, "มาร์ก JEV ถูกหรือผิด"),
      field("ความเห็นเรื่องหยุด AI", "stop", ["stop", "continue"]),
      field("ความเห็นเรื่องแจ้งแอดมิน", "notify", ["notify", "not_needed"]), note, save,
      el("small", { class: "history-muted" }, row.ownerLearningEnabled
        ? "บันทึกแล้ว JEV ใช้คำตัดสินของพี่ประกอบเคสถัดไปทันที ไม่ต้องสอนซ้ำ · โน้ตเก็บไว้ให้อ่าน ไม่ส่งไปเทรน"
        : "เก็บคำตัดสินไว้ทบทวน การเรียนรู้จากมาร์กยังไม่ได้เปิดใช้"));
  }
  render();
}
