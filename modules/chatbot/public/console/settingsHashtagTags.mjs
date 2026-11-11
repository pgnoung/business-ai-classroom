// settingsHashtagTags.mjs — แผง "คีย์เวิร์ด # → ป้ายลูกค้า" (ข้อ 8 ของพี่ง้วง 28 ก.ย. 2026)
// พี่ง้วง: "มี option ให้เลือก ผมมาติ๊กเองว่า อันนี้ นับเป็นของแจกหรือไม่" — ค่าเริ่มต้นทุกคำ = ไม่ติดป้าย
// โหลดข้อมูลของตัวเอง (เส้น /settings/hashtag-tags) จึงไม่แตะ Promise.all ของหน้าตั้งค่า · CSP: ใช้คลาสเท่านั้น
import { el } from "./dom.mjs";

const NONE = "";

function ruleRow(item, { canEdit, active, api, toast, refresh }) {
  const current = item.rule || { dimension: NONE, value: "" };
  const meta = [
    item.configured ? "คีย์เวิร์ดกิจกรรมที่ตั้งไว้" : "",
    item.rooms ? `ลูกค้าพิมพ์ ${item.rooms} ห้อง (180 วัน)` : "",
  ].filter(Boolean).join(" · ");
  if (!canEdit) {
    return el("div", { class: "hashtag-tag-row" },
      el("strong", { class: "hashtag-tag-key" }, item.keyword),
      el("span", { class: current.dimension ? "is-on-text" : "is-off-text" },
        current.dimension ? `${current.dimension}: ${current.value}` : "ไม่ติดป้าย"),
      meta ? el("span", { class: "hashtag-tag-meta" }, meta) : null);
  }
  const suggested = item.keyword.replace(/^[#@]/u, "");
  const valueInput = el("input", {
    class: "order-in keep-focus hashtag-tag-value", type: "text", maxlength: "36",
    "aria-label": `ชื่อป้ายของ ${item.keyword}`, value: current.value || suggested,
  });
  const dimSelect = el("select", {
    class: "order-in keep-focus hashtag-tag-dim", "aria-label": `ป้ายของ ${item.keyword}`,
    onchange: (e) => { valueInput.disabled = e.target.value === NONE; },
  },
  el("option", { value: NONE, ...(current.dimension ? {} : { selected: "" }) }, "ไม่ติดป้าย"),
  el("option", { value: "ของแจก", ...(current.dimension === "ของแจก" ? { selected: "" } : {}) }, "ของแจก"),
  el("option", { value: "กิจกรรม", ...(current.dimension === "กิจกรรม" ? { selected: "" } : {}) }, "กิจกรรม"));
  valueInput.disabled = !current.dimension;
  const save = el("button", {
    class: "btn btn-outline btn-mini",
    onclick: async () => {
      const dimension = dimSelect.value;
      try {
        await api("/console/api/settings/hashtag-tags", {
          method: "POST", body: { keyword: item.keyword, dimension, value: valueInput.value },
        });
        toast(dimension
          ? `${item.keyword} → ${dimension}: ${valueInput.value.trim()}${active ? " — ติดให้ตั้งแต่ข้อความถัดไป" : " (บันทึกแล้ว — จะติดเมื่อเปิดป้ายชุดเดียว)"}`
          : `${item.keyword} → ไม่ติดป้าย`);
        await refresh?.();
      } catch (error) {
        toast(error.message);
      }
    },
  }, "บันทึก");
  return el("div", { class: "hashtag-tag-row" },
    el("div", { class: "hashtag-tag-head" },
      el("strong", { class: "hashtag-tag-key" }, item.keyword),
      meta ? el("span", { class: "hashtag-tag-meta" }, meta) : null),
    el("div", { class: "hashtag-tag-edit" }, dimSelect, valueInput, save));
}

export async function hashtagTagsBlock({ api, toast, refresh } = {}) {
  const data = await api("/console/api/settings/hashtag-tags").catch(() => null);
  if (!data?.ok) return null;
  const rows = data.keywords || [];
  return el("section", { class: "block" },
    el("h2", { class: "block-title" }, "คีย์เวิร์ด # → ป้ายลูกค้า"),
    el("p", { class: "block-hint" },
      "เลือกเองทีละคำว่าคีย์เวิร์ดไหนนับเป็นของแจกหรือกิจกรรม — ค่าเริ่มต้นทุกคำคือไม่ติดป้าย ระบบไม่เดาเอง "
      + "ลูกค้าพิมพ์คำนั้นเมื่อไหร่ ติดป้ายของทีมให้ทันที (ทั้งคำที่ลูกแพรตอบและคำที่ LINE OA ตอบเอง)"),
    data.active ? null : el("p", { class: "block-hint is-off-text" }, "ป้ายลูกค้าชุดเดียวปิดอยู่ — ตั้งไว้ล่วงหน้าได้ แต่จะยังไม่ติดป้ายให้ใครจนกว่าจะเปิด"),
    rows.length
      ? el("div", { class: "hashtag-tag-list" }, rows.map((item) => ruleRow(item, { canEdit: data.canEdit, active: data.active, api, toast, refresh })))
      : el("p", { class: "block-hint" }, "ยังไม่มีคีย์เวิร์ด — ตั้งคีย์เวิร์ดกิจกรรมก่อน หรือรอให้ลูกค้าพิมพ์ # เข้ามา"),
    data.canEdit ? null : el("p", { class: "block-hint" }, "เฉพาะ Super Admin เท่านั้นที่เปลี่ยนได้ — ทีมดูได้อย่างเดียว"),
  );
}
