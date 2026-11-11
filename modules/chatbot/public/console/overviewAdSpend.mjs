// overviewAdSpend.mjs — การ์ด "ค่าแอด" ใบใหญ่บนหน้าแรก (เจ้าของเท่านั้น · พี่ง้วง 7 ต.ค. 2026:
// "ปรับ dashboard ค่าแอดในหน้าแรก ให้เห็นชัดเจน ใหญ่ๆ ดูง่าย สะดุดตา")
//
// ข้อมูลจาก GET /console/api/roas/ad-summary (src/adSpendSummary.mjs) · แทนแถบ ROAS บรรทัดเดียวเดิม
// สีน้ำเงิน Meta = เรื่องแอด Facebook (ชุดเดียวกับแถบ "มาจากโฆษณา" ในห้องแชท — ad-referral.css)
import { el } from "./dom.mjs";
import { icon } from "./icons.mjs";
import { svgNode } from "./charts.mjs";

const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const baht = (value) => `฿${Math.round(Number(value) || 0).toLocaleString("th-TH")}`;
const count = (value) => Math.round(Number(value) || 0).toLocaleString("th-TH");
const shortDay = (day) => {
  const [, m, d] = String(day || "").split("-").map(Number);
  return m && d ? `${d} ${THAI_MONTHS[m - 1]}` : "";
};

function spendTile({ label, part, big = false }) {
  const incomplete = part && !part.complete && part.expectedDays > 0;
  return el("div", { class: `adsp-tile${big ? " is-big" : ""}` },
    el("span", { class: "adsp-tile-label" }, label),
    el("strong", { class: "adsp-tile-value" }, part?.days ? baht(part.thb) : "—"),
    incomplete
      ? el("span", { class: "adsp-tile-note is-warn" }, `ข้อมูลมา ${part.days}/${part.expectedDays} วัน`)
      : null,
  );
}

/** กราฟแท่ง 14 วัน — วันล่าสุด (เมื่อวาน) เข้มสุด · วันไม่มีข้อมูลเป็นขีดจาง ไม่ใช่ศูนย์ */
export function adSpendBars(series, { width = 280, height = 72 } = {}) {
  const points = Array.isArray(series) ? series : [];
  if (!points.length) return null;
  const max = Math.max(1, ...points.map((p) => Number(p.thb) || 0));
  const gap = 4;
  const barW = (width - gap * (points.length - 1)) / points.length;
  const svg = svgNode("svg", {
    class: "adsp-bars", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none",
    role: "img", "aria-label": `ค่าแอดรายวัน ${points.length} วันล่าสุด`,
  });
  points.forEach((p, i) => {
    const x = i * (barW + gap);
    const last = i === points.length - 1;
    if (p.thb == null) {
      svg.append(svgNode("rect", { x, y: height - 3, width: barW, height: 3, rx: 1.5, class: "adsp-bar is-empty" }));
      return;
    }
    const h = Math.max(3, (Number(p.thb) / max) * (height - 4));
    const bar = svgNode("rect", { x, y: height - h, width: barW, height: h, rx: Math.min(4, barW / 2), class: `adsp-bar${last ? " is-last" : ""}` });
    const title = svgNode("title", {});
    title.textContent = `${shortDay(p.day)} ${baht(p.thb)}`;
    bar.append(title);
    svg.append(bar);
  });
  return svg;
}

function funnelStep(label, value, tone = "") {
  return el("div", { class: `adsp-step${tone ? ` ${tone}` : ""}` },
    el("strong", { class: "adsp-step-value" }, value == null ? "—" : count(value)),
    el("span", { class: "adsp-step-label" }, label),
  );
}

function updatedNote(summary) {
  const at = Number(summary.updatedAt);
  if (!at) return "ยังไม่มียอดค่าแอดเข้ามา";
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `ยอดถึง ${shortDay(summary.spend?.yesterday?.day)} · อัปเดต ${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${hm}`;
}

/** การ์ดค่าแอด — summary null/พัง = null (หน้าแรกยังเปิดได้) · onOpenDetail = กางแผง ROAS/รายแอดของทีม */
export function adSpendCard(summary, { onOpenDetail } = {}) {
  if (!summary?.ok) return null;
  if (!summary.hasData) {
    return el("section", { class: "adsp adsp-empty", "aria-label": "ค่าแอด" },
      el("span", { class: "adsp-icon", "aria-hidden": "true" }, icon("megaphone", { size: 22 })),
      el("div", {},
        el("strong", {}, "ยังไม่มียอดค่าแอด"),
        el("p", {}, "ต่อ Make ให้ยิงยอดค่าแอดรายวันเข้ามาในแผง ROAS แล้วการ์ดนี้จะขึ้นเอง"),
      ),
    );
  }
  const f = summary.funnel;
  const roas = summary.roasMonth;
  const roasTone = roas == null ? "" : roas >= 3 ? "is-good" : roas >= 1 ? "is-mid" : "is-bad";
  return el("section", { class: "adsp", "aria-labelledby": "adsp-title" },
    el("header", { class: "adsp-head" },
      el("span", { class: "adsp-icon", "aria-hidden": "true" }, icon("megaphone", { size: 22 })),
      el("div", { class: "adsp-head-text" },
        el("h2", { id: "adsp-title", class: "adsp-title" }, "ค่าแอด Facebook"),
        el("span", { class: "adsp-sub" }, updatedNote(summary)),
      ),
      onOpenDetail
        ? el("button", { type: "button", class: "adsp-more", onclick: onOpenDetail }, "ดูรายแอด / ROAS ›")
        : null,
    ),
    el("div", { class: "adsp-body" },
      el("div", { class: "adsp-tiles" },
        spendTile({ label: "เมื่อวาน", part: summary.spend?.yesterday, big: true }),
        spendTile({ label: "7 วัน", part: summary.spend?.last7 }),
        spendTile({ label: "เดือนนี้", part: summary.spend?.month }),
      ),
      el("div", { class: "adsp-chart" },
        adSpendBars(summary.series),
        el("div", { class: "adsp-chart-axis" },
          el("span", {}, shortDay(summary.series?.[0]?.day)),
          el("span", {}, "เมื่อวาน"),
        ),
      ),
    ),
    el("div", { class: "adsp-foot" },
      el("div", { class: "adsp-funnel", role: "group", "aria-label": "ห้องจากแอด 7 วันล่าสุด" },
        el("span", { class: "adsp-foot-label" }, "7 วัน"),
        funnelStep("ห้องจากแอด", f?.rooms),
        el("span", { class: "adsp-arrow", "aria-hidden": "true" }, "→"),
        funnelStep("ถึงราคา/รอบ", f?.reachedPrice),
        el("span", { class: "adsp-arrow", "aria-hidden": "true" }, "→"),
        funnelStep("จ่ายแล้ว", f?.paid, "is-paid"),
      ),
      el("div", { class: "adsp-costs" },
        el("span", { class: "adsp-cost" }, "ต่อห้อง ", el("strong", {}, summary.perRoom == null ? "—" : baht(summary.perRoom))),
        el("span", { class: "adsp-cost" }, "ต่อคนจ่าย ", el("strong", {}, summary.perPaid == null ? "—" : baht(summary.perPaid))),
        el("span", { class: `adsp-roas ${roasTone}`, title: "ยอดขายเดือนนี้ ÷ ค่าแอดเดือนนี้ (ยังไม่หักต้นทุนอื่น — ROAS เต็มอยู่ในแผงทีม)" },
          "ขายเดือนนี้ ", el("strong", {}, baht(summary.revenueMonth)),
          roas == null ? null : el("span", { class: "adsp-roas-x" }, ` · ${roas.toFixed(2)}x`),
        ),
      ),
    ),
  );
}
