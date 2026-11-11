// overviewTeam.mjs — "รายละเอียดสำหรับทีม" ของหน้าภาพรวม (พับไว้ใต้ภาพรวมแบบ CEO)
//
// 28 ก.ย. 2026 (พี่ง้วงขอให้ภาพรวมดูง่าย ตัวเลขน้อยลง): การ์ดตัวเลข/แผง ROAS/โควตา/สวิตช์/
// Export ทั้งหมดย้ายมาไฟล์นี้แบบ "ไม่เปลี่ยนพฤติกรรม" — ข้อความ เงื่อนไขสิทธิ์ และการยิง API
// เหมือนเดิมทุกบรรทัด (ย้ายจาก overview.mjs) ต่างกันแค่ถูกวางไว้ใน <details> ที่กางได้
// ด่านเงินจริงยังอยู่ฝั่งเซิร์ฟเวอร์ (finance.view) — ไฟล์นี้แค่ไม่วาดของที่ผู้ใช้ไม่มีสิทธิ์
import { el, timeAgo } from "./dom.mjs";
import { fmtThb, fmtUsd, fxLine, switchDot } from "./ui.mjs";
import { createExportControls } from "./exportUi.mjs";
import { areaChart, barsChart } from "./charts.mjs";
import { createRoasPanel } from "./overviewRoas.mjs";

// qualify = ตัวกวาดคัดกรองลูกค้ารายชั่วโมง (5 ต.ค. 2026) — แยกบรรทัดจาก score ให้เห็นต้นทุนของงานนี้ชัด
// offtopic_check = ยืนยันแชทนอกเรื่อง · owner_review = รอบตรวจเสนอปิดห้อง (12 ต.ค. 2026)
const KIND_LABELS = { draft: "ตอบลูกค้า", score: "วิเคราะห์ score", followup: "follow-up", staged_followup: "Follow-up ตามสเตจ", qualify: "คัดกรองลูกค้า",
  offtopic_check: "ยืนยันแชทนอกเรื่อง", owner_review: "รอบตรวจเสนอปิดห้อง" };

// การ์ดสถิติมาตรฐาน: หัวข้อ -> คำอธิบายหนึ่งบรรทัด -> ตัวเลขใหญ่ -> บรรทัดเสริม
// href = การ์ดแตะได้ (เป็นลิงก์จริง) / ไม่มี href = การ์ดข้อมูลเฉย ๆ (ไม่มี pointer)
export function statCard(label, value, { explain = "", sub = "", href = null, urgent = false, warn = false, good = false } = {}) {
  const cls = `stat-card${urgent ? " is-urgent" : ""}${warn ? " is-warn" : ""}${good ? " is-good" : ""}`;
  const children = [
    el("span", { class: "stat-label" }, label),
    explain ? el("span", { class: "stat-explain" }, explain) : null,
    el("span", { class: "stat-value" }, String(value)),
    sub ? el("span", { class: "stat-sub" }, sub) : null,
  ];
  return href ? el("a", { class: cls, href }, children) : el("div", { class: cls }, children);
}

// ช่วงเวลาดูเป็นนาทีแบบคนอ่าน — ใช้ทั้งแผงผลงานและภาพรวมแบบ CEO
export function shortDuration(ms) {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} วิ`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} นาที`;
  return `${(ms / 3_600_000).toFixed(1)} ชม.`;
}

export function createTeamPanels({ api, toast, state, rerender, getRoasRange, setRoasRange }) {
  // F7 + v1.2: การ์ดโควตาข้อความ LINE พร้อมแถบ progress (เห็นสัดส่วนทันตา ไม่ต้องคิดเลข)
  // null = โชว์ "—" เฉย ๆ ห้ามพังหน้า
  function quotaCard(q, label = "โควตาข้อความเดือนนี้") {
    const explain = "ข้อความ LINE ที่ใช้ไปจากสิทธิ์รายเดือนของ OA";
    if (!q) {
      return statCard(label, "—", { explain, sub: "ยังอ่านค่าไม่ได้ (mock/ปิด live)" });
    }
    if (q.type === "none") {
      return statCard(label, "ไม่จำกัด", { explain, sub: `ใช้ไป ${q.totalUsage} ข้อความ` });
    }
    const left = Math.max(0, q.value - q.totalUsage);
    const ratio = q.value > 0 ? Math.min(1, q.totalUsage / q.value) : 0;
    const tone = ratio >= 0.9 ? "bad" : ratio >= 0.7 ? "warn" : "good";
    // ใช้ scaleX แทน width เพื่อไม่ให้ animation กระตุกจาก layout reflow
    const fill = el("span", { class: `quota-fill quota-${tone}` });
    fill.style.transform = `scaleX(${ratio})`;
    return el("div", { class: `stat-card quota-card${ratio >= 0.9 ? " is-urgent" : ratio >= 0.7 ? " is-warn" : ""}` },
      el("span", { class: "stat-label" }, label),
      el("span", { class: "stat-explain" }, explain),
      el("span", { class: "stat-value" }, `${q.totalUsage.toLocaleString("th-TH")} / ${q.value.toLocaleString("th-TH")}`),
      el("span", { class: "quota-track" }, fill),
      el("span", { class: "stat-sub" }, `เหลือ ${left.toLocaleString("th-TH")} ข้อความ (${Math.round(ratio * 100)}% ใช้ไป)`),
    );
  }

  // W3 + v1.2: server ส่งเฉพาะสาขาที่เลือกมาแล้ว — "ทุกสาขา" = การ์ดครบทุก OA
  function quotaCards(data) {
    if (Array.isArray(data.quotas) && data.quotas.length) {
      return data.quotas.map((entry) => quotaCard(entry.quota, `โควตา ${entry.name || entry.channelId}`));
    }
    return [quotaCard(data.quota)];
  }

  // การ์ดกราฟคู่ "แนวโน้ม 14 วัน" — series null = ไม่โชว์ (ห้ามลากหน้าล้ม)
  function trendBlock(series) {
    if (!Array.isArray(series) || !series.length) return null;
    const sum = (field) => series.reduce((s, p) => s + (Number(p[field]) || 0), 0);
    return el("section", { class: "trend-grid" },
      el("div", { class: "stat-card chart-card" },
        el("span", { class: "stat-label" }, "แชทเข้า 14 วันหลัง"),
        el("span", { class: "stat-explain" }, `รวม ${sum("inbound").toLocaleString("th-TH")} ข้อความ · ลูกค้าใหม่ ${sum("newCustomers")} คน`),
        areaChart(series, "inbound"),
      ),
      el("div", { class: "stat-card chart-card" },
        el("span", { class: "stat-label" }, "ยอดขาย 14 วันหลัง"),
        el("span", { class: "stat-explain" }, `รวม ฿${fmtThb(sum("revenue"))} · ${sum("orders")} ออเดอร์ (ยืนยันแล้วขึ้นไป)`),
        barsChart(series, "revenue"),
      ),
    );
  }

  // B8b: การ์ดค่าใช้จ่าย AI — แตะที่การ์ดเพื่อกาง/พับรายละเอียด (ไม่พาไปหน้าอื่น)
  function aiCostCard(aiCost) {
    if (!aiCost) {
      return statCard("ค่าใช้จ่าย AI", "—", { explain: "ค่าเรียกใช้สมอง AI (คิดเป็นบาท)", sub: "ยังอ่านค่าไม่ได้" });
    }
    const { today, month } = aiCost;
    const breakdownRows = (month.breakdown || []).map((row) =>
      el("div", { class: "cost-row" },
        el("span", { class: "cost-row-name" }, `${row.model || "?"} · ${KIND_LABELS[row.kind] || row.kind}`),
        el("span", { class: "cost-row-tokens" }, `${(row.tokensIn + row.tokensOut).toLocaleString("th-TH")} tk`),
        el("span", { class: "cost-row-thb" },
          row.usd === null ? "—" : `฿${fmtThb(row.usd * aiCost.thbPerUsd)}`),
      )
    );
    const breakdown = breakdownRows.length
      ? el("details", { class: "cost-breakdown" },
          el("summary", {}, "รายละเอียดเดือนนี้ (ต่อโมเดล/งาน)"),
          breakdownRows)
      : null;
    return el("div", {
      class: "stat-card ai-cost-card is-tappable",
      // แตะส่วนไหนของการ์ดก็กาง/พับ breakdown — ยกเว้นแตะใน details เอง (กันสั่งซ้ำ)
      onclick: breakdown
        ? (e) => {
            if (e.target.closest("details")) return;
            breakdown.open = !breakdown.open;
          }
        : null,
    },
      el("span", { class: "stat-label" }, "ค่าใช้จ่าย AI"),
      el("span", { class: "stat-explain" }, "ค่าเรียกใช้สมอง AI วันนี้/เดือนนี้ — แตะเพื่อดูรายละเอียดต่อโมเดล"),
      el("span", { class: "stat-value" }, `฿${fmtThb(today.thb)}`),
      el("span", { class: "stat-sub" },
        "วันนี้ ", el("small", {}, `($${fmtUsd(today.usd, 4)})`),
        ` · เดือนนี้ ฿${fmtThb(month.thb)} `, el("small", {}, `($${fmtUsd(month.usd, 4)})`)),
      el("span", { class: "stat-sub fx-line" }, fxLine(aiCost)),
      // 8 พ.ย. 2026: ทางเข้าหน้า Usage วันนี้ (การ์ดนี้โผล่เฉพาะ finance.view อยู่แล้ว) — มือถือไม่มีเมนูนี้บนแถบล่าง
      el("a", { class: "stat-sub usage-link", href: "#/usage", onclick: (e) => e.stopPropagation() }, "เปิดหน้า Usage วันนี้ →"),
      month.unknownTokens
        ? el("span", { class: "stat-sub" }, `+ ${month.unknownTokens.toLocaleString("th-TH")} token ราคายังไม่ยืนยัน (—)`)
        : null,
      breakdown,
      month.unknownCacheWriteCalls > 0
        ? el("span", { class: "stat-sub" }, `ยังไม่มีข้อมูลเขียนแคช ${month.unknownCacheWriteCalls.toLocaleString("th-TH")} รายการ — ต้นทุนส่วนนี้ยังไม่รวม ไม่ใช่ศูนย์`)
        : null,
    );
  }

  // บรรทัดย่อโมเดลปัจจุบัน — ตัวเลือกจริงย้ายไปหน้า "ตั้งค่า" (ลดความรกหน้าแรก)
  function modelLine(aiCost) {
    return el("a", { class: "model-line", href: "#/settings" },
      el("span", { class: "model-line-main" },
        el("span", { class: "model-line-label" }, "โมเดล AI ที่ใช้อยู่"),
        el("span", { class: "model-line-value" },
          aiCost?.replyModel
            ? `ตอบลูกค้า: ${aiCost.replyModel} · วิเคราะห์: ${aiCost.scorerModel || "—"}`
            : "ดู/สลับโมเดลได้ในหน้าตั้งค่า"),
      ),
      el("span", { class: "model-line-cta" }, "ตั้งค่า ›"),
    );
  }

  // Export ประวัติแชททั้งร้านเป็น CSV — เลือกเดือนได้ (server ตัดตามเที่ยงคืนกรุงเทพ)
  function exportBlock() {
    return el("section", { class: "block export-block" },
      el("h2", { class: "block-title" }, "Export ประวัติแชท"),
      createExportControls({ scope: "all", buttonLabel: "ดาวน์โหลดทั้งหมด (CSV)", channels: state.channels }),
      el("p", { class: "block-hint" }, "ไฟล์ CSV เปิดใน Excel ได้ทันที (เวลาไทย)"),
    );
  }

  /* การ์ดแทนเมื่อโหลดข้อมูลไม่สำเร็จ — เงียบหายคือสิ่งที่แย่ที่สุด เพราะมันดูเหมือน
   * "ฟีเจอร์นี้ไม่มี" ทั้งที่จริงคือพัง คนใช้เลยไม่รู้ว่าต้องแจ้ง */
  function panelBroken(title, payload) {
    const why = payload?.__failed || payload?.error || "ข้อมูลที่ได้ไม่ครบ";
    return el("section", { class: "kpi-hero kpi-hero-broken" },
      el("div", { class: "kpi-hero-head" },
        el("span", { class: "kpi-hero-title" }, `${title} — โหลดไม่สำเร็จ`),
        el("button", { class: "kpi-hero-link", onclick: () => rerender() }, "ลองใหม่"),
      ),
      el("p", { class: "kpi-hero-note" }, `${why} · ถ้ายังไม่หายให้แจ้งทีมพัฒนา`),
    );
  }

  /* ---- แผงผลงาน คน vs ลูกแพร (พี่ง้วงขอให้เห็นบนภาพรวม 1 ก.ย. 2026) ----
   * ตัวเลขความเร็วใช้ชุด "เวลาทำการ เฉพาะวันที่ทีมทำงาน" ซึ่งเป็นชุดเดียวที่เทียบกันได้แฟร์
   */
  function kpiPanel(kpi) {
    // กันที่ "รูปข้อมูลจริง" ไม่ใช่แค่ธง ok — ปลายทางที่ตอบ ok แต่ไม่มีตัวเลข
    // ต้องไม่ทำให้หน้าภาพรวมทั้งหน้าพัง (หน้านี้คือหน้าแรกหลังล็อกอิน)
    if (!kpi?.ok || !kpi.speed?.workingDays || !kpi.backlog || !kpi.closing || !kpi.days) {
      return panelBroken("ผลงานการตอบแชท", kpi);
    }
    const fair = kpi.speed.workingDays;
    const cell = (label, value, sub, tone) => el("div", { class: `kpi-hero-cell ${tone || ""}` },
      el("span", { class: "kpi-hero-label" }, label),
      el("span", { class: "kpi-hero-value" }, value),
      el("span", { class: "kpi-hero-sub" }, sub),
    );
    // ตัวอย่างน้อยกว่า 20 ห้องยังสรุปแนวโน้มไม่ได้ — แสดง % คู่จำนวนห้องเสมอ
    // เพื่อไม่ให้ตัวเลขเดี่ยว ๆ ถูกเอาไปตัดสินใจเรื่องคน
    const pct = (entry) => (entry?.ratePct == null ? "—" : `${entry.ratePct}%`);
    const waiting = kpi.backlog.waitingForHuman;
    return el("section", { class: "kpi-hero" },
      el("div", { class: "kpi-hero-head" },
        el("span", { class: "kpi-hero-title" }, "ผลงานการตอบแชท · 7 วัน"),
        el("a", { class: "kpi-hero-link", href: "#/kpi" }, "ดูทั้งหมด →"),
      ),
      el("div", { class: "kpi-hero-grid" },
        cell("ลูกแพรตอบใน", shortDuration(fair.ai.medianMs), `${fair.ai.count} ครั้ง`, "is-ai"),
        cell("ทีมงานตอบใน", shortDuration(fair.human.medianMs), `${fair.human.count} ครั้ง`, "is-human"),
        cell("ลูกค้ารออยู่", String(kpi.backlog.total), `ต้องให้คนตอบ ${waiting}`,
          waiting > 0 ? "is-alert" : ""),
        // พี่ง้วงขอเทียบ Hybrid กับลูกแพรล้วนเป็นคู่ — โชว์ตัวเดียวแล้วอ่านไม่ออกว่า
        // AI ทำได้แค่ไหนเมื่อไม่มีคนช่วย จึงต้องอยู่ข้างกันเสมอ พร้อมจำนวนห้องกำกับทุกตัว
        cell("ปิดได้ — Hybrid", pct(kpi.closing.hybrid),
          `คน+AI ${kpi.closing.hybrid.closed}/${kpi.closing.hybrid.rooms} ห้อง`, "is-human"),
        cell("ปิดได้ — ลูกแพรล้วน", pct(kpi.closing.fullyAi),
          `${kpi.closing.fullyAi.closed}/${kpi.closing.fullyAi.rooms} ห้อง`, "is-ai"),
      ),
      el("p", { class: "kpi-hero-note" },
        `เทียบเฉพาะเวลาทำการในวันที่ทีมทำงาน (ตัดวันอาทิตย์/วันหยุดออกแล้ว ${kpi.days.excluded.length} วัน)`),
    );
  }

  // แผง ROAS (เงิน) แยกไฟล์ไว้ที่ overviewRoas.mjs — ส่งตัววาดการ์ดโหลดพังให้ใช้ร่วมกัน
  const roasPanel = createRoasPanel({ api, rerender, getRoasRange, setRoasRange, panelBroken });

  // F5: สวิตช์ follow-up ทั้งระบบ — หน้าตาเป็นสวิตช์จริง (เปิด/ปิดเห็นชัดด้วยสี)
  function followupToggle(data) {
    const s = data.stats || {};
    const fuOn = data.followupGlobal === true;
    return el("button", {
      class: "stat-card stat-toggle",
      role: "switch",
      "aria-checked": fuOn ? "true" : "false",
      onclick: async () => {
        try {
          await api("/console/api/settings/followup", { method: "POST", body: { enabled: !fuOn } });
          toast(!fuOn ? "เปิด follow-up ทั้งระบบแล้ว" : "ปิด follow-up ทั้งระบบแล้ว");
          await rerender();
        } catch (err) {
          toast(err.message);
        }
      },
    },
      el("span", { class: "stat-label" }, "Follow-up ทั้งระบบ"),
      el("span", { class: "stat-explain" }, "สวิตช์รวมของการทักตามลูกค้าอัตโนมัติ"),
      el("span", { class: "switch-row" },
        switchDot(fuOn),
        el("span", { class: `switch-state ${fuOn ? "is-on-text" : "is-off-text"}` }, fuOn ? "เปิดอยู่" : "ปิดอยู่"),
      ),
      // audit 2026-08-26: ตัวจับเวลานัดหมายถูกตรึงเป็น 0 บนเครื่องนี้ นัดที่บันทึกไว้
      // จะไม่ถูกส่งเลย ต้องบอกตรง ๆ ไม่ใช่ปล่อยให้เห็นแค่ "เปิดอยู่" แล้วเข้าใจว่าทำงาน
      data.followupAppointmentArmed === false
        ? el("span", { class: "stat-sub is-warn" },
          `นัดค้าง ${s.pendingFollowups ?? 0} รายการ · ระบบนัดหมายยังไม่ติดเครื่อง นัดที่บันทึกไว้จะยังไม่ถูกส่ง`)
        : el("span", { class: "stat-sub" }, `นัดค้าง ${s.pendingFollowups ?? 0} รายการ · แตะเพื่อสลับ`),
    );
  }

  // ตารางการ์ดเดิมทั้งหมดของหน้าภาพรวม (ย้ายมาไว้ในรายละเอียดสำหรับทีม — ข้อความเดิมทุกใบ)
  function statGrid(data, { canFinance }) {
    const s = data.stats || {};
    const canary = data.canary || { enabled: false, status: "off" };
    // "ระบบเช็คตัวเองอัตโนมัติ" (canary) — การ์ดข้อมูลเฉย ๆ ไม่มีลิงก์
    const canaryValue = canary.enabled
      ? `${canary.status === "ok" ? "ปกติ" : canary.status}${Number.isFinite(canary.roundTripMs) ? ` · ${canary.roundTripMs}ms` : ""}`
      : "OFF";
    const canarySub = canary.enabled
      ? (canary.lastProbeAt ? `รอบล่าสุด ${timeAgo(canary.lastProbeAt)}` : "ยังไม่เคยยิงทดสอบ")
      : "ยังไม่เปิดใช้";
    return el("div", { class: "stat-grid" },
      statCard("แชทวันนี้", s.inboundToday ?? 0, {
        explain: "ข้อความที่ลูกค้าส่งเข้ามาวันนี้",
      }),
      statCard("ลูกค้าใหม่วันนี้", s.newCustomersToday ?? 0, {
        explain: "ลูกค้าที่เพิ่งทักเข้ามาครั้งแรกวันนี้",
      }),
      statCard("เคสรอคน", s.needsHuman ?? 0, {
        href: "#/chat/needs",
        urgent: (s.needsHuman ?? 0) > 0,
        explain: "แชทที่ระบบส่งต่อให้คนดูแลต่อ — แตะเพื่อเปิดรายการ",
      }),
      statCard("ลูกค้า hot (ใกล้ปิดการขาย)", s.hotCustomers ?? 0, {
        href: "#/chat/hot",
        good: (s.hotCustomers ?? 0) > 0,
        explain: "คะแนนความสนใจ 8 ขึ้นไป — แตะเพื่อดูรายชื่อ รีบตามต่อ",
      }),
      // G6: ออเดอร์วันนี้ + ยอดขายเดือนนี้ — ตัวเลขจาก SQL (db.orderStats)
      statCard("ออเดอร์วันนี้", data.orders ? data.orders.todayCount : "—", {
        href: "#/orders",
        explain: "ออเดอร์ที่เกิดขึ้นวันนี้ (ไม่นับที่ยกเลิก) — แตะเพื่อเปิดหน้าออเดอร์",
        sub: data.orders?.openDrafts ? `มีร่างรอตรวจ ${data.orders.openDrafts} รายการ` : "",
        warn: (data.orders?.openDrafts ?? 0) > 0,
      }),
      statCard("ยอดขายเดือนนี้", data.orders ? `฿${fmtThb(data.orders.monthRevenue)}` : "—", {
        href: "#/orders",
        explain: "ยอดรวมออเดอร์ที่ยืนยันแล้วขึ้นไป (ยืนยัน/จ่าย/ส่ง/จบ) ของเดือนนี้",
        sub: data.orders ? `${data.orders.monthConfirmedCount} ออเดอร์` : "ยังอ่านค่าไม่ได้",
        good: (data.orders?.monthRevenue ?? 0) > 0,
      }),
      statCard("คำตอบที่ระบบกันไว้ (รอรีวิว)", s.guardBlockedToday ?? 0, {
        href: "#/corrections",
        explain: "ร่างของ AI ที่ระบบกันไม่ให้ส่ง — แตะเพื่อรีวิวและสอนคำตอบที่ถูก",
        sub: `วันนี้ · รอรีวิวทั้งหมด ${s.guardBlockedTotal ?? 0}`,
      }),
      statCard("สลิปน่าสงสัยวันนี้", s.suspectSlipsToday ?? 0, {
        href: "#/chat/needs",
        urgent: (s.suspectSlipsToday ?? 0) > 0,
        explain: "สลิปที่ระบบตรวจแล้วไม่ผ่าน — เปิดแชทตรวจกับคนก่อนยืนยันยอด",
      }),
      quotaCards(data),
      // ห้ามพึ่ง aiCost: null อย่างเดียว — aiCostCard(null) จะวาดการ์ด "ยังอ่านค่าไม่ได้"
      // ซึ่งดูเหมือนระบบพัง ทั้งที่จริงคือไม่มีสิทธิ์
      canFinance ? aiCostCard(data.aiCost) : null,
      followupToggle(data),
      statCard("รูปที่ส่งวันนี้", s.imagesSentToday ?? 0, {
        explain: "จำนวนรูปสินค้า/บริการที่ส่งให้ลูกค้าวันนี้",
      }),
      statCard("ระบบเช็คตัวเองอัตโนมัติ", canaryValue, {
        explain: "ส่งข้อความทดสอบภายในเป็นรอบ ๆ เพื่อยืนยันว่าบอทยังตอบได้ — OFF คือยังไม่เปิดใช้",
        sub: canarySub,
      }),
      statCard("ลูกค้าปิด AI อยู่", s.aiOffCustomers ?? 0, {
        href: "#/chat/aioff",
        explain: "ห้องแชทที่ปิดให้ AI ตอบ (คนดูแลเอง) — แตะเพื่อดูรายชื่อ",
        sub: `จากทั้งหมด ${s.totalCustomers ?? 0} คน`,
      }),
      statCard("จบแชทโดยไม่ชวนคุยต่อ (score ต่ำ)", s.noQuestionLowScore ?? 0, {
        explain: "จำนวนครั้งที่ AI ตอบแล้วไม่ทิ้งคำถามชวนคุยต่อ (นับสะสม)",
      }),
      // v1.2: ทางเข้าบรอดแคส (มือถือไม่มีปุ่มในแถบล่าง — เข้าจากการ์ดนี้)
      statCard("บรอดแคสตาม segment", "📣", {
        href: "#/broadcast",
        explain: "ส่งข้อความหาลูกค้าตามป้าย (RFM/intent) — เลือก include/exclude ได้ แตะเพื่อเปิด",
      }),
    );
  }

  return { kpiPanel, roasPanel, trendBlock, statGrid, modelLine, exportBlock };
}
