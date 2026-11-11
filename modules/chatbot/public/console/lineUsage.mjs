// lineUsage.mjs — การ์ด "LINE OA เดือนนี้" ในรายละเอียดสำหรับทีมของหน้าภาพรวม (28 ก.ย. 2026)
//
// พี่ง้วงถาม: push ที่กินโควตามาจากระบบส่งเข้าทีมงาน บรอดแคสต์จาก LINE OA หรือส่งหาลูกค้าจริง
// การ์ดตอบคำถามนั้นก่อน (แถบ "โควตาไปไหน") แล้วค่อยแตกที่มาสองฝั่ง: ระบบลูกแพร (บันทึกของเรา) กับ
// LINE OA Manager (สถิติทางการของ LINE) · รายวัน · ค่าใช้จ่ายโดยประมาณ (เฉพาะเจ้าของ และเฉพาะเมื่อกรอกราคาเอง)
// ด่านสิทธิ์จริงอยู่ฝั่งเซิร์ฟเวอร์ (consoleLineUsageApi.mjs) — ไฟล์นี้แค่ไม่วาดของที่ผู้ใช้ไม่มีสิทธิ์
// CSP ห้าม style attribute: ความกว้างของแต่ละช่วงในแถบตั้งผ่าน CSSOM (node.style.*) เท่านั้น
import { el } from "./dom.mjs";

const COUNT_TONE = { team: "is-team", broadcast: "is-broadcast", customers: "is-customers", systemUnsplit: "is-unsplit", other: "is-other", unknown: "is-unknown" };
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
// จำการกาง/เลือกไว้ข้าม re-render (หน้าภาพรวม poll วาดใหม่ได้ทุก 15 วิ)
const view = { month: "", daysOpen: false, planOpen: false };

const num = (value) => (value === null || value === undefined ? "—" : Math.round(Number(value) || 0).toLocaleString("th-TH"));
const baht = (value) => (value === null || value === undefined ? "—"
  : `฿${Number(value).toLocaleString("th-TH", { maximumFractionDigits: 2 })}`);
const clock = (ms) => {
  const date = new Date(Number(ms) + 7 * 3_600_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} น.`;
};
const monthText = (key) => {
  const [y, m] = String(key).split("-").map(Number);
  return `${THAI_MONTHS[m - 1] || "?"} ${y}`;
};

export function canSeeLineUsage(state) {
  return state?.me?.capabilities?.includes("line_usage.view") === true;
}

// เดือนนี้ + สองเดือนก่อน (เวลาไทย) — เลือกย้อนดูบิลเดือนก่อนได้
function monthOptions(nowMs = Date.now()) {
  const date = new Date(nowMs + 7 * 3_600_000);
  const out = [];
  for (let back = 0; back < 3; back += 1) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - back, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

export function createLineUsagePanel({ api, toast, rerender, state }) {
  let lineIds = null; // OA ของ LINE จากคำตอบล่าสุด — ชิปสาขา Facebook ไม่ส่งไปกรอง

  /** query ของรอบนี้ (หน้าภาพรวมเรียกก่อนยิง) */
  function query() {
    const params = new URLSearchParams();
    if (view.month) params.set("month", view.month);
    const channel = state?.channel || "";
    if (channel && (lineIds ? lineIds.includes(channel) : channel !== "facebook")) params.set("channel", channel);
    const text = params.toString();
    return `/console/api/line-usage${text ? `?${text}` : ""}`;
  }

  function broken(payload) {
    const why = payload?.__failed || payload?.error || "ข้อมูลที่ได้ไม่ครบ";
    return el("section", { class: "kpi-hero kpi-hero-broken lu-card" },
      el("div", { class: "kpi-hero-head" },
        el("span", { class: "kpi-hero-title" }, "LINE OA เดือนนี้ — โหลดไม่สำเร็จ"),
        el("button", { class: "kpi-hero-link", type: "button", onclick: () => rerender() }, "ลองใหม่"),
      ),
      el("p", { class: "kpi-hero-note" }, `${why} · ถ้ายังไม่หายให้แจ้งทีมพัฒนา`),
    );
  }

  function monthPicker(report) {
    const select = el("select", { class: "roas-range keep-focus lu-month", "aria-label": "เลือกเดือนของการ์ด LINE OA" });
    for (const key of monthOptions(report.asOf)) {
      const option = el("option", { value: key }, key === monthOptions(report.asOf)[0] ? `เดือนนี้ (${monthText(key)})` : monthText(key));
      if (key === report.month) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", () => { view.month = select.value; rerender(); });
    return select;
  }

  function quotaBlock(report) {
    const q = report.quota;
    if (!q) {
      const text = report.current
        ? "ยังอ่านโควตาจาก LINE ไม่ได้ในรอบนี้ — ตัวเลขด้านล่างมาจากบันทึกของระบบและสถิติ LINE"
        : report.split.total !== null
          ? `ยอดทั้งเดือนตามสถิติ LINE ${num(report.split.total)} ข้อความ`
          : "เดือนที่ผ่านมา: LINE ไม่ให้ยอดโควตาย้อนหลัง และสถิติรายวันยังไม่ครบเดือน";
      return el("div", { class: "lu-quota is-unknown" }, el("p", { class: "lu-quota-note" }, text));
    }
    const fill = el("span", { class: `lu-quota-fill${q.ratio >= 0.9 ? " is-bad" : q.ratio >= 0.7 ? " is-warn" : ""}` });
    fill.style.transform = `scaleX(${q.ratio ?? 0})`;
    return el("div", { class: "lu-quota" },
      el("div", { class: "lu-quota-top" },
        el("span", { class: "lu-quota-value" }, num(q.used), q.limit !== null ? el("small", {}, ` / ${num(q.limit)}`) : null),
        el("span", { class: "lu-quota-left" }, q.limit !== null ? `เหลือ ${num(q.left)} ข้อความ` : "ไม่ได้ตั้งเพดานโควตา"),
      ),
      q.limit !== null ? el("span", { class: "lu-quota-track", role: "img", "aria-label": `ใช้ไป ${Math.round((q.ratio || 0) * 100)}%` }, fill) : null,
      el("p", { class: "lu-quota-note" },
        `ข้อความที่ LINE นับโควตาเดือนนี้${q.limit !== null ? ` · ใช้ไป ${Math.round((q.ratio || 0) * 100)}%` : ""}${q.at ? ` · ตัวเลข LINE ณ ${clock(q.at)}` : ""}`),
    );
  }

  function splitBlock(report) {
    const parts = report.split.parts.filter((part) => part.value > 0);
    const base = report.split.total ?? report.split.known;
    const bar = el("div", { class: `lu-split-bar${parts.length ? "" : " is-empty"}`, role: "img",
      "aria-label": parts.map((part) => `${part.label} ${num(part.value)}`).join(", ") || "ยังไม่มีข้อความที่นับโควตา" });
    for (const part of parts) {
      const seg = el("span", { class: `lu-seg ${COUNT_TONE[part.key] || ""}` });
      seg.style.flexGrow = String(part.value);
      bar.appendChild(seg);
    }
    const pct = (value) => (base > 0 ? `${Math.round((value / base) * 100)}%` : "");
    return el("div", { class: "lu-split" },
      el("h3", { class: "lu-subtitle" }, "โควตาไปไหน"),
      bar,
      el("ul", { class: "lu-legend" }, report.split.parts.map((part) => el("li", { class: `lu-legend-item ${COUNT_TONE[part.key] || ""}` },
        el("span", { class: "lu-dot", "aria-hidden": "true" }),
        el("span", { class: "lu-legend-text" },
          el("span", { class: "lu-legend-label" }, part.label),
          el("small", {}, part.hint)),
        el("span", { class: "lu-legend-num" }, num(part.value), el("small", {}, pct(part.value))),
      ))),
    );
  }

  const tag = (counted) => el("span", { class: `lu-tag ${counted ? "is-counted" : "is-free"}` }, counted ? "นับโควตา" : "ฟรี");

  function systemColumn(report) {
    const s = report.system;
    const rows = s.rows.filter((row) => row.purpose !== "other" || row.counted || row.free);
    return el("div", { class: "lu-col" },
      el("h3", { class: "lu-subtitle" }, "จากระบบลูกแพร"),
      el("ul", { class: "lu-rows" }, rows.map((row) => {
        // ตอบด้วย reply = ฟรีทั้งแถว · แถวอื่นโชว์ส่วนที่นับโควตา (ถ้ามีส่วนฟรีปนมาด้วย บอกเป็นบรรทัดเล็ก)
        const counted = row.purpose !== "customer_reply";
        const freeExtra = counted && row.free > 0 ? row.free : 0;
        return el("li", { class: `lu-row${row.counted || row.free ? "" : " is-zero"}` },
          el("span", { class: "lu-row-label" }, row.label, freeExtra ? el("small", { class: "lu-row-sub" }, ` (+ ฟรี ${num(freeExtra)})`) : null),
          el("span", { class: "lu-row-num" }, num(counted ? row.counted : row.free)),
          tag(counted),
          row.details.length ? el("ul", { class: "lu-details" }, row.details.map((d) =>
            el("li", {}, el("span", {}, d.label), el("span", { class: "lu-row-num" }, num(d.value))))) : null,
        );
      })),
      s.sinceDay ? el("p", { class: "lu-foot is-strong" }, `นับตั้งแต่วันที่ ${thaiDate(s.sinceDay)}${s.startMs ? ` ${clock(s.startMs)}` : ""} (วันที่เริ่มบันทึก)`) : null,
      s.preLedger && (s.preLedger.alertPushes || s.preLedger.digestPushes)
        ? el("p", { class: "lu-foot" }, `ก่อนหน้านั้น แจ้งเตือนทีม ${num(s.preLedger.alertPushes + s.preLedger.digestPushes)} ข้อความ (นับจากบันทึกการแจ้งเตือน${s.preLedger.alertEvents ? ` ${num(s.preLedger.alertEvents)} ครั้ง` : ""})`)
        : null,
      s.batching ? el("p", { class: "lu-foot is-hint" },
        `push ที่ส่งทีละบอลลูน ${num(s.batching.requests)} คำขอ จาก ${num(s.batching.sends)} ครั้งส่ง — LINE นับทีละคำขอ ถ้ารวมเป็นคำขอเดียวจะลดได้ ${num(s.batching.saving)} ข้อความ`) : null,
    );
  }

  function lineColumn(report) {
    const stats = report.lineStats;
    const oa = stats.fields.filter((field) => field.source === "oa");
    const api = stats.fields.filter((field) => field.source === "api" && field.value > 0);
    return el("div", { class: "lu-col" },
      el("h3", { class: "lu-subtitle" }, "จาก LINE OA Manager"),
      el("ul", { class: "lu-rows" }, oa.map((field) => el("li", { class: `lu-row${field.value ? "" : " is-zero"}` },
        el("span", { class: "lu-row-label" }, field.label),
        el("span", { class: "lu-row-num" }, num(field.value)),
        tag(field.counts === true),
      ))),
      el("p", { class: "lu-foot" }, stats.latestReady
        ? `สถิติทางการของ LINE ถึงวันที่ ${thaiDate(stats.latestReady)} (${stats.readyDays}/${stats.expectedDays} วัน · มาช้า ~1 วัน · นับวันตามเวลาญี่ปุ่น)`
        : "ยังไม่มีสถิติจาก LINE — ระบบดึงให้เองวันละครั้ง"),
      api.length ? el("p", { class: "lu-foot" },
        `ระบบที่ยิงผ่าน API ตามสถิติ LINE: ${api.map((field) => `${field.label} ${num(field.value)}`).join(" · ")}`) : null,
    );
  }

  function daysBlock(report) {
    const cell = (value) => el("td", {}, num(value));
    const details = el("details", { class: "kpi-details lu-days" },
      el("summary", {}, `รายวัน (${report.days.length} วัน)`),
      el("div", { class: "kpi-scroll" },
        el("table", { class: "kpi-table lu-table" },
          el("thead", {}, el("tr", {},
            el("th", {}, "วันที่"), el("th", {}, "ส่งเข้าทีม"), el("th", {}, "หาลูกค้า (นับ)"), el("th", {}, "ตอบฟรี"),
            el("th", {}, "บรอดแคสต์คอนโซล"), el("th", {}, "บรอดแคสต์ OA*"), el("th", {}, "API ตาม LINE*"))),
          el("tbody", {}, report.days.map((day) => el("tr", { class: day.tracked ? "" : "is-untracked" },
            el("th", { scope: "row" }, day.label, day.startsAt ? el("small", { class: "lu-day-since" }, ` ตั้งแต่ ${clock(day.startsAt)}`) : null),
            cell(day.team), cell(day.customers), cell(day.customersFree), cell(day.broadcastSystem),
            cell(day.lineOaCounted), cell(day.lineApiCounted),
          ))),
        ),
      ),
      el("p", { class: "block-hint" }, "* สถิติของ LINE นับวันตามเวลาญี่ปุ่น (เร็วกว่าไทย 2 ชม.) และมาช้าประมาณ 1 วัน · — = ยังไม่มีข้อมูล (ก่อนเริ่มบันทึก หรือ LINE ยังไม่ส่ง)"),
    );
    details.open = view.daysOpen;
    details.addEventListener("toggle", () => { view.daysOpen = details.open; });
    return details;
  }

  function costBlock(report, canEditPlan) {
    const cost = report.cost;
    if (!cost) return null;
    const lines = [];
    if (cost.configured && cost.now) {
      lines.push(el("p", { class: "lu-cost-main" }, "ประมาณค่าใช้จ่ายเดือนนี้ ",
        el("strong", {}, cost.now.totalThb === null ? "ยังคิดไม่ได้" : baht(cost.now.totalThb))));
      lines.push(el("p", { class: "lu-foot" },
        `แพ็กเกจ ${baht(cost.plan.monthlyFeeThb)} (รวม ${num(cost.plan.includedMessages)} ข้อความ) + ส่วนเกิน ${num(cost.now.extraMessages)} ข้อความ`
        + (cost.plan.extraPerMessageThb === null ? " (ยังไม่ได้กรอกราคาส่วนเกิน)" : ` × ${baht(cost.plan.extraPerMessageThb)}`)));
      if (cost.projected) {
        lines.push(el("p", { class: "lu-foot" }, `ถ้าใช้ด้วยอัตรานี้ทั้งเดือน ~${num(cost.projected.used)} ข้อความ${cost.projected.totalThb === null ? "" : ` ≈ ${baht(cost.projected.totalThb)}`}`));
      }
    } else if (cost.configured) {
      lines.push(el("p", { class: "lu-foot" }, "ยังไม่มียอดโควตาให้คำนวณในรอบนี้"));
    } else {
      lines.push(el("p", { class: "lu-foot" }, "ยังไม่ได้กรอกราคาแพ็กเกจ — การ์ดแสดงเฉพาะจำนวนข้อความ (ระบบไม่เดาราคาแทน)"));
    }
    if (report.split.teamProjected > 0) {
      lines.push(el("p", { class: "lu-foot is-hint" },
        `แจ้งเตือนทีมคาดทั้งเดือน ~${num(report.split.teamProjected)} ข้อความ — ถ้าย้ายไปแจ้งทาง Web Push/Telegram จะคืนโควตาส่วนนี้`
        + (cost.teamSavingThb > 0 ? ` (ประหยัด ≈ ${baht(cost.teamSavingThb)}/เดือน)` : cost.configured && cost.plan.extraPerMessageThb !== null ? " (ยังอยู่ในโควตาแพ็กเกจ จึงไม่ลดเงิน แต่เหลือโควตาให้ลูกค้ามากขึ้น)" : "")));
    }
    return el("div", { class: "lu-cost" },
      el("h3", { class: "lu-subtitle" }, "ค่าใช้จ่ายโดยประมาณ"),
      lines,
      canEditPlan ? planForm(cost.plan) : null,
    );
  }

  function planForm(plan) {
    const field = (name, label, value, hint) => {
      const input = el("input", { class: "roas-input keep-focus", type: "text", inputmode: "decimal", value: value ?? "", "aria-label": label });
      input.dataset.field = name;
      return el("label", { class: "roas-field" }, el("span", {}, label), input, el("small", {}, hint));
    };
    const wrap = el("div", { class: "roas-form" },
      field("monthlyFeeThb", "ค่าแพ็กเกจต่อเดือน (บาท)", plan.monthlyFeeThb, "ตามใบแจ้งหนี้ LINE (รวม/ไม่รวม VAT ตามที่ต้องการดู)"),
      field("includedMessages", "ข้อความที่รวมในแพ็กเกจ", plan.includedMessages, "จำนวนข้อความฟรีต่อเดือนของแพ็กเกจ"),
      field("extraPerMessageThb", "ราคาต่อข้อความส่วนเกิน (บาท)", plan.extraPerMessageThb, "เว้นว่างได้ถ้าแพ็กเกจไม่มีส่วนเกิน"),
    );
    const status = el("span", { class: "rv-status", role: "status" });
    const save = el("button", { class: "btn btn-outline", type: "button", onclick: async () => {
      const body = {};
      for (const input of wrap.querySelectorAll("input")) body[input.dataset.field] = String(input.value || "").trim();
      status.textContent = "กำลังบันทึก…"; status.className = "rv-status";
      try {
        await api("/console/api/line-usage/plan", { method: "PUT", body });
        status.textContent = "บันทึกแล้ว"; status.className = "rv-status rv-ok";
        toast?.("บันทึกราคาแพ็กเกจ LINE แล้ว");
        rerender();
      } catch (err) {
        status.textContent = String(err?.message || err); status.className = "rv-status rv-bad";
      }
    } }, "บันทึกราคาแพ็กเกจ");
    const details = el("details", { class: "kpi-details lu-plan" },
      el("summary", {}, "ตั้งราคาแพ็กเกจ LINE"),
      el("p", { class: "block-hint" }, "กรอกจากใบแจ้งหนี้หรือหน้าแพ็กเกจของ LINE เอง — ว่างทั้งหมด = ไม่ประมาณเป็นเงิน"),
      // ไม่ใช้ .rv-actions (แถบ sticky พื้นขาวของหน้ารีวิว) — ในกล่องพื้นเทามันกลายเป็นแถบขาวที่ไม่เหมือนปุ่ม
      wrap, el("div", { class: "lu-plan-actions" }, save, status),
    );
    details.open = view.planOpen;
    details.addEventListener("toggle", () => { view.planOpen = details.open; });
    return details;
  }

  /** การ์ดทั้งใบ — payload null = ผู้ใช้ไม่มีสิทธิ์ (ไม่วาดอะไรเลย) */
  function panel(payload) {
    if (payload === null || payload === undefined) return null;
    if (payload.__failed || payload.ok !== true || !payload.report?.split) return broken(payload);
    const report = payload.report;
    lineIds = Array.isArray(payload.channels) ? payload.channels.map((ch) => ch.id) : lineIds;
    return el("section", { class: "kpi-hero lu-card", "aria-labelledby": "lu-title" },
      el("div", { class: "kpi-hero-head lu-head" },
        el("div", { class: "lu-head-text" },
          el("h2", { class: "kpi-hero-title", id: "lu-title" }, report.current ? "LINE OA เดือนนี้" : `LINE OA · ${report.monthLabel}`),
          el("p", { class: "lu-lede" }, "ข้อความที่นับโควตาไปกับอะไร — ส่งเข้าทีม · บรอดแคสต์ · ส่งหาลูกค้า"),
        ),
        monthPicker(report),
      ),
      el("div", { class: "lu-top" }, quotaBlock(report), splitBlock(report)),
      el("div", { class: "lu-cols" }, systemColumn(report), lineColumn(report)),
      daysBlock(report),
      costBlock(report, payload.canEditPlan === true),
      notesList(report),
    );
  }

  return { query, panel };
}

// วันเริ่มบันทึกบอกไว้แล้วใต้คอลัมน์ "จากระบบลูกแพร" — ไม่พูดซ้ำท้ายการ์ด
function notesList(report) {
  const notes = (report.notes || []).filter((note) => note?.key !== "ledger_since");
  return notes.length ? el("ul", { class: "lu-notes" }, notes.map((note) => el("li", {}, note.text))) : null;
}

function thaiDate(isoDay) {
  const [y, m, d] = String(isoDay).split("-").map(Number);
  return y && m && d ? `${d} ${THAI_MONTHS[m - 1]}` : String(isoDay);
}

// เทสต์/พรีวิวรีเซ็ตสถานะที่จำไว้ได้
export function resetLineUsageView() {
  view.month = "";
  view.daysOpen = false;
  view.planOpen = false;
}
