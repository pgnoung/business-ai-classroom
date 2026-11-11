// overviewAdReferrals.mjs — กล่อง "แอดตัวไหนพาคนแบบไหนมา" ในแผง ROAS (คำสั่งพี่ง้วง 6 ต.ค. 2026)
//
// ข้อมูลจาก GET /console/api/roas/ad-referrals (อ่านอย่างเดียว · เฉพาะเจ้าของ) — ช่วงเดียวกับตัวเลือกของแผง ROAS
// โหลดเมื่อกดเปิดกล่องเท่านั้น: หน้าภาพรวมรีเฟรชทุกนาที ไม่ต้องยิงคิวรีนี้ทุกรอบ
// ใช้คลาสเดิมของแผง ROAS ทั้งหมด (CSP บล็อก inline style)
import { el } from "./dom.mjs";

const n = (value) => Number(value || 0).toLocaleString("th-TH");
const pct = (part, whole) => (whole > 0 ? ` (${Math.round((Number(part) || 0) * 100 / whole)}%)` : "");

// เลขแอดยาว 15–18 หลัก — โชว์หัวข้อแอด + ท้ายเลข 6 หลักไว้จับคู่กับ Ads Manager (เลขเต็มอยู่ใน title)
function adLabel(row) {
  if (row.adId) {
    const tail = `…${row.adId.slice(-6)}`;
    return el("span", { title: row.adId }, row.adTitle ? `${row.adTitle} · ${tail}` : `แอด ${tail}`);
  }
  const via = row.source === "SHORTLINK" ? "ลิงก์ m.me" : (row.source || "ไม่ระบุ");
  return el("span", {}, row.ref ? `${via} · ${row.ref}` : via);
}

/** เรนเดอร์จากคำตอบของเซิร์ฟเวอร์ — แยกออกมาให้เทสต์เรียกตรงได้ */
export function adReferralTable(payload) {
  if (!payload?.ok || !payload.report || !Array.isArray(payload.report.rows)) {
    return el("p", { class: "block-hint kpi-caveat" }, "อ่านรายงานรายแอดไม่สำเร็จ ลองเปิดใหม่อีกครั้ง");
  }
  const { rows, totals = {}, coverage = {} } = payload.report;
  const notes = [];
  if (payload.captureMode !== "on") {
    notes.push(el("p", { class: "block-hint kpi-caveat" },
      "ยังไม่ได้เปิดเก็บที่มาจากแอด — เปิดสวิตช์ \"จดว่าห้อง Facebook มาจากแอดตัวไหน\" ในหน้าตั้งค่าก่อน ตัวเลขถึงจะเริ่มนับ"));
  }
  if (Number(coverage.newFacebookRooms) > 0) {
    notes.push(el("p", { class: "block-hint" },
      `ห้อง Facebook ใหม่ในช่วงนี้ ${n(coverage.newFacebookRooms)} ห้อง รู้ว่ามาจากแอด/ลิงก์ ${n(coverage.newFacebookRoomsFromReferral)} ห้อง`));
  }
  if (rows.length && Number(coverage.lifecycleEvents) === 0) {
    notes.push(el("p", { class: "block-hint kpi-caveat" },
      "ช่วงนี้ไม่มีบันทึกขั้นการขาย (lifecycle) เลย — ช่อง \"ถึงราคา/เลือกรอบ\" นับได้แค่ห้องที่ได้ราคาแล้ว ขั้นเลือกรอบจะเป็นศูนย์"));
  }
  if (!rows.length) {
    return el("div", {}, ...notes, el("p", { class: "block-hint" }, "ยังไม่มีห้องที่มาจากแอดในช่วงนี้"));
  }
  const cells = (row) => {
    const rooms = Number(row.roomsOpened) || 0;
    return [
      el("td", {}, `${n(rooms)} (ใหม่ ${n(row.newRooms)})`),
      el("td", {}, `${n(row.notQualified)}${pct(row.notQualified, rooms)}`),
      el("td", {}, `${n(row.reachedPriceOrRound)}${pct(row.reachedPriceOrRound, rooms)}`),
      el("td", {}, `${n(row.paid)}${pct(row.paid, rooms)}`),
    ];
  };
  return el("div", {},
    ...notes,
    el("div", { class: "kpi-scroll" },
      el("table", { class: "kpi-table" },
        el("thead", {}, el("tr", {},
          el("th", {}, "แอด"), el("th", {}, "ห้องที่เปิด"), el("th", {}, "ไม่เข้าเกณฑ์ (เหลือง)"),
          el("th", {}, "ถึงราคา/เลือกรอบ"), el("th", {}, "จ่าย/ลงเรียน"))),
        el("tbody", {},
          ...rows.map((row) => el("tr", {}, el("th", { scope: "row" }, adLabel(row)), ...cells(row))),
          el("tr", {}, el("th", { scope: "row" }, "รวม"), ...cells(totals))),
      ),
    ),
    el("p", { class: "block-hint" },
      "นับเป็นห้อง: ห้องหนึ่งนับให้แอดตัวแรกที่พาเข้ามาในช่วงนี้ · กดแอดแต่ไม่เคยพิมพ์ไม่นับ · "
      + "เหลือง/ราคา/จ่าย นับเฉพาะที่เกิดหลังคลิกแอด (ถึงวันนี้)"),
  );
}

/** กล่องพับในแผง ROAS — rangeQuery() คืน query ของช่วงที่เลือกอยู่ เช่น "days=30" หรือ "date=2026-10-07" */
export function adReferralBox({ api, rangeQuery }) {
  const body = el("div", {}, el("p", { class: "block-hint" }, "กดเปิดเพื่อโหลด…"));
  const box = el("details", { class: "kpi-details" },
    el("summary", {}, "แอดตัวไหนพาคนแบบไหนมา (Facebook)"),
    body,
  );
  let loading = false;
  box.addEventListener("toggle", async () => {
    if (!box.open || loading) return;
    loading = true;
    body.replaceChildren(el("p", { class: "block-hint" }, "กำลังโหลด…"));
    try {
      body.replaceChildren(adReferralTable(await api(`/console/api/roas/ad-referrals?${rangeQuery()}`)));
    } catch (err) {
      body.replaceChildren(el("p", { class: "block-hint kpi-caveat" }, String(err?.message || err)));
    } finally {
      loading = false;
    }
  });
  return box;
}
