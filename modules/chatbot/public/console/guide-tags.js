// guide-tags.js — ปุ่มคัดลอกแม่แบบกติกาสินค้า + ตารางมิติ/ค่าที่ใช้ได้จริงตอนนี้ (แยกไฟล์ตาม CSP script-src 'self')
// ตารางอ่านจากเส้นเดียวกับแผงป้ายในห้องแชท (/console/api/customers/tag-framework) — คู่มือจึงตรงกับไฟล์กรอบที่
// ระบบโหลดอยู่เสมอ ไม่ต้องแก้หน้านี้ทุกครั้งที่เพิ่มค่า · ทุกค่าลง textContent (ไม่มี innerHTML)
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function memoryOf(dim) {
  if (dim.setBy === "system") return dim.dynamic ? "ระบบคำนวณ · ค่าเดียว เปลี่ยนตามการซื้อล่าสุด" : "ระบบติดจากออเดอร์จริง";
  if (dim.setBy === "human") return dim.open ? "ทีมติด · พิมพ์ค่าเอง" : "ทีมติด · เลือกจากรายการ";
  const memory = dim.merge === "funnel" ? "เดินหน้าอย่างเดียว" : dim.merge === "latest" ? "ค่าล่าสุดที่มีหลักฐาน" : `สะสม สูงสุด ${dim.max} ค่า`;
  return `AI ติด · ${memory} · ทีมติด/แก้เองได้`;
}

function renderFramework(box, data) {
  box.replaceChildren();
  if (!data || !data.framework) {
    box.append(node("p", "tight", data && data.available
      ? "สวิตช์ \"ป้ายลูกค้าชุดเดียว\" ปิดอยู่ — AI ติดป้ายอิสระแบบเดิม ทีมติดป้ายอะไรก็ได้"
      : "ร้านนี้ยังไม่ได้เปิดกรอบป้ายชุดเดียว — ป้ายทำงานแบบเดิม"));
    return;
  }
  // การ์ดต่อมิติ (ไม่ใช่ตาราง) — จอมือถือ 390px อ่านได้โดยไม่ต้องเลื่อนข้าง
  for (const dim of data.framework.dimensions) {
    const card = node("section", "dim-card");
    const head = node("div", "dim-head");
    head.append(node("strong", "dim-key", dim.key));
    if (dim.label && dim.label !== dim.key) head.append(node("span", "dim-label", dim.label));
    card.append(head, node("p", "dim-rule", memoryOf(dim)));
    if (dim.open) {
      card.append(node("p", "dim-rule muted", dim.guide || "พิมพ์ค่าเอง"));
    } else {
      const list = node("div", "value-list");
      for (const value of dim.values) {
        const chip = node("span", `chip ${value.setBy === "human" || dim.setBy === "human" ? "chip-human" : "chip-ai"}`, value.value);
        if (value.hint) chip.title = value.hint;
        list.append(chip);
      }
      card.append(list);
      for (const old of dim.archived || []) {
        card.append(node("p", "dim-rule muted small", `พักไว้: ${old.value} → นับเป็น ${old.replacedBy}`));
      }
    }
    box.append(card);
  }
  box.append(node("p", "tight muted small", "ค่าสีเขียวในมิติของ AI = ทีมติดเท่านั้น · ชี้ค้างที่ค่าเพื่อดูคำอธิบาย"));
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.querySelector(".copy-btn");
  if (btn) {
    btn.addEventListener("click", () => {
      const text = document.getElementById("starter").innerText.replace(/คัดลอก(แล้ว ✓)?$/, "").trim();
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "คัดลอกแล้ว ✓";
        setTimeout(() => { btn.textContent = "คัดลอก"; }, 1500);
      });
    });
  }
  const box = document.getElementById("live-framework");
  if (!box) return;
  fetch("/console/api/customers/tag-framework", { credentials: "same-origin" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => renderFramework(box, data))
    .catch(() => renderFramework(box, null));
});
