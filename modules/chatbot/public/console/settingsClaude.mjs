import { el } from "./dom.mjs";

export function claudeExportTestersBlock(data, { api, toast, refresh } = {}) {
  if (!data) return null;
  const ids = [...(data.ids || [])];
  const chipList = el("div", { class: "notify-chip-list" });
  const render = () => {
    const chips = ids.map((id) => el("span", { class: "notify-chip" },
      `${id.slice(0, 8)}…${id.slice(-6)}`,
      el("button", {
        class: "tag-del",
        "aria-label": "ลบผู้ทดสอบ",
        onclick: () => {
          ids.splice(ids.indexOf(id), 1);
          render();
        },
      }, "✕"),
    ));
    if (!chips.length) chips.push(el("span", { class: "block-hint" }, "ยังไม่มี tester — export ทุกคนจะถูกใช้นามแฝง"));
    chipList.replaceChildren(...chips);
  };
  render();
  const input = el("input", {
    class: "order-in keep-focus notify-id-input",
    type: "text",
    maxlength: "40",
    autocomplete: "off",
    placeholder: "วาง LINE user ID ของ tester แล้วกด Enter",
    onkeydown: (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const id = input.value.trim();
      if (!/^U[0-9a-f]{32}$/iu.test(id)) return toast("LINE user ID ไม่ถูกต้อง");
      if (ids.includes(id)) return toast("มี tester คนนี้แล้ว");
      if (ids.length >= Number(data.max || 50)) return toast("รายชื่อ tester ถึงเพดานแล้ว");
      ids.push(id);
      input.value = "";
      render();
    },
  });
  const save = el("button", {
    class: "btn btn-primary btn-mini",
    onclick: async () => {
      save.disabled = true;
      try {
        await api("/console/api/settings/claude-export-testers", { method: "POST", body: { ids } });
        toast(`บันทึก tester แล้ว ${ids.length} คน`);
        await refresh();
      } catch (error) {
        toast(error.message);
        save.disabled = false;
      }
    },
  }, "บันทึก");
  return el("section", { class: "block" },
    el("h2", { class: "block-title" }, "ผู้ทดสอบสำหรับ Claude Builder"),
    el("p", { class: "block-hint" },
      "เฉพาะรายชื่อนี้ export จะคงชื่อและข้อความจริง แต่ยังปิดบังเบอร์ บัญชี เลขบัตร ที่อยู่ สลิป และ LINE ID เสมอ คนอื่นใช้นามแฝงอัตโนมัติ"),
    el("p", { class: "block-hint" }, "เฉพาะ Super Admin แก้ไขได้ · audit เก็บเพียงจำนวน ไม่เก็บ LINE ID"),
    chipList,
    el("div", { class: "notify-add-row" }, input, save),
  );
}
