// exportUi.mjs — ตัวเลือก Export ประวัติแชทเป็น CSV (ใช้ร่วมหน้าภาพรวมและหน้าแชท)
// ดาวน์โหลดผ่าน <a> ธรรมดา — session cookie ติดไปเอง (GET อ่านอย่างเดียว ไม่ต้องมี CSRF)
// เดือน = เวลาเครื่องแอดมิน (ทีมอยู่ไทย) — ฝั่ง server ตัดขอบเขตตามเที่ยงคืนกรุงเทพจริง
import { el } from "./dom.mjs";

const pad = (n) => String(n).padStart(2, "0");

// ค่า "YYYY-MM" ของเดือนปัจจุบัน (offset = -1 คือเดือนก่อน)
function monthValue(offset = 0) {
  const d = new Date();
  d.setDate(1); // กันวันที่ 31 ล้นเดือนตอนเลื่อน month
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// dropdown เดือน (เดือนนี้/เดือนก่อน/ทั้งหมด/เลือกเดือนเอง) + ปุ่มดาวน์โหลด <a>
// W3: channels >1 = มี dropdown สาขาเพิ่ม (ทุกสาขา/รายสาขา) — สาขาเดียวหน้าตาเดิมเป๊ะ
// G6: endpoint override สำหรับ export อื่น (เช่น orders) — scope null = ไม่ส่ง param scope
export function createExportControls({ scope = null, customerId = null, buttonLabel = "ดาวน์โหลด CSV", channels = [], endpoint = "/console/api/export" }) {
  const select = el("select", { class: "export-month keep-focus" },
    el("option", { value: monthValue(0) }, "เดือนนี้"),
    el("option", { value: monthValue(-1) }, "เดือนก่อน"),
    el("option", { value: "" }, "ทั้งหมด"),
    el("option", { value: "custom" }, "เลือกเดือนเอง…"),
  );
  const custom = el("input", {
    class: "export-custom keep-focus", type: "month", value: monthValue(0), hidden: "",
  });
  const branch = (channels?.length ?? 0) > 1
    ? el("select", { class: "export-month export-branch keep-focus", "aria-label": "เลือกสาขา" },
        el("option", { value: "" }, "ทุกสาขา"),
        channels.map((ch) => el("option", { value: ch.id }, ch.name || ch.id)),
      )
    : null;
  const link = el("a", { class: "btn btn-outline btn-mini export-link" }, buttonLabel);

  function refreshHref() {
    const params = new URLSearchParams();
    if (scope) params.set("scope", scope);
    if (customerId) params.set("customerId", customerId);
    const month = select.value === "custom" ? custom.value : select.value;
    if (month) params.set("month", month);
    if (branch?.value) params.set("channel", branch.value);
    link.href = `${endpoint}?${params.toString()}`;
  }
  select.addEventListener("change", () => {
    custom.hidden = select.value !== "custom";
    refreshHref();
  });
  custom.addEventListener("change", refreshHref);
  branch?.addEventListener("change", refreshHref);
  refreshHref();

  return el("div", { class: "export-controls" }, select, custom, branch, link);
}
