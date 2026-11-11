// usage.mjs — หน้า "Usage วันนี้" ของเจ้าของ (#/usage · 8 พ.ย. 2026 พี่ง้วง "ขอสวยงาม สะดุดตา impressive, motion สวยๆได้เลย
// แต่ไม่กระทบกับ performance ของ ระบบตอบแชทนะครับ")
//
// · ข้อมูลจาก GET /console/api/usage/today (finance.view · เซิร์ฟเวอร์แคช 30 วิ) — หน้านี้ poll ทุก 60 วิเฉพาะตอนแท็บเปิดอยู่
// · motion ทั้งหมดอยู่ฝั่งเบราว์เซอร์ (transform/opacity + rAF นับเลข) ไม่มีงานเพิ่มบนเซิร์ฟเวอร์ · ผู้ใช้ตั้งลดการเคลื่อนไหว = ไม่ขยับ
// · รอบ poll วาดใหม่แบบ "นิ่ง" (ไม่เล่นท่าเปิดซ้ำ) ตัวเลขไหลจากค่าเดิมไปค่าใหม่
// · สร้าง DOM ผ่าน el() เท่านั้น (ไม่ฉีด HTML) · สไตล์ไดนามิกใช้ CSSOM (style.setProperty) ผ่าน CSP style-src 'self'
import { el } from "./dom.mjs";
import { svgNode } from "./charts.mjs";

const POLL_MS = 60_000;
const COUNT_MS = 900;
const HOUR_MS = 3_600_000;
const QUALIFY_MODE_LABEL = Object.freeze({ on: "เปิดอยู่", shadow: "โหมดเงา (ไม่ปิดห้องจริง)", off: "ปิดอยู่" });
const SERIES = Object.freeze([
  { field: "inbound", label: "ลูกค้าทัก", cls: "is-in" },
  { field: "aiReplies", label: "ลูกแพรตอบ", cls: "is-reply" },
  { field: "followups", label: "ทักตาม", cls: "is-fu" },
]);

const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
const fmtInt = (value) => Math.round(Number(value) || 0).toLocaleString("th-TH");
const fmtThb = (value) => `฿${(Number(value) || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
const clock = (ms) => new Date(Number(ms) + 7 * HOUR_MS).toISOString().slice(11, 16);
const hh = (hour) => `${String(hour).padStart(2, "0")}:00`;
const ease = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));

/* --------------------------- ตัวเลขไหล (count-up) --------------------------- */

const shown = new Map(); // id -> ค่าที่โชว์ล่าสุด (รอบ poll ไหลต่อจากตรงนี้)

function counter(id, value, format, cls = "") {
  const node = el("span", { class: `uz-num ${cls}`.trim(), "data-count": id }, format(value));
  const from = shown.has(id) ? shown.get(id) : 0;
  shown.set(id, Number(value) || 0);
  // แท็บซ่อนอยู่ = rAF ไม่เดิน ตัวเลขจะค้างที่ค่าเริ่ม — โชว์ค่าจริงเลย
  if (reducedMotion() || document.visibilityState === "hidden" || from === Number(value)) return node;
  node.textContent = format(from);
  const start = performance.now();
  const step = (t) => {
    if (!node.isConnected && t - start > 50) return; // หน้าเปลี่ยนแล้ว เลิกนับ
    const p = ease(Math.min(1, (t - start) / COUNT_MS));
    node.textContent = format(from + (Number(value) - from) * p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return node;
}

const staggered = (node, index) => {
  node.style.setProperty("--i", String(index));
  return node;
};

/* --------------------------------- hero --------------------------------- */

function paceChip(today, before) {
  const a = Number(today) || 0;
  const b = Number(before) || 0;
  if (b <= 0) return null;
  const diff = (a - b) / b;
  if (Math.abs(diff) < 0.05) return el("span", { class: "uz-chip is-even" }, "ใกล้เคียงเมื่อวานเวลาเดียวกัน");
  return el("span", { class: `uz-chip ${diff < 0 ? "is-down" : "is-up"}` },
    `${diff < 0 ? "▼" : "▲"} ${fmtPct(Math.abs(diff))} ${diff < 0 ? "ต่ำกว่า" : "สูงกว่า"}เมื่อวานเวลาเดียวกัน`);
}

function heroStat(id, label, value, before) {
  return el("div", { class: "uz-hero-stat" },
    el("dt", {}, label),
    el("dd", {}, counter(id, value, fmtInt)),
    el("small", {}, `เมื่อวานถึงเวลานี้ ${fmtInt(before)}`));
}

function hero(usage) {
  const { today, yesterdaySameTime: same, yesterday } = usage;
  const perReply = today.aiReplies + today.followups > 0 ? today.costThb / (today.aiReplies + today.followups) : 0;
  return el("section", { class: "uz-hero uz-rise", "aria-labelledby": "uz-hero-title" },
    el("div", { class: "uz-aurora", "aria-hidden": "true" }, el("span", { class: "uz-blob is-a" }), el("span", { class: "uz-blob is-b" })),
    el("div", { class: "uz-hero-inner" },
      el("p", { class: "uz-eyebrow" },
        el("span", { class: "uz-live", "aria-hidden": "true" }),
        el("span", {}, `LIVE · ตัวเลขถึง ${clock(usage.asOf)} น.`)),
      el("h1", { id: "uz-hero-title", class: "uz-hero-title" }, "ลูกแพรใช้ AI ไปแล้ววันนี้"),
      el("p", { class: "uz-hero-cost" }, counter("cost", today.costThb, fmtThb, "is-hero")),
      el("p", { class: "uz-hero-sub" },
        `เมื่อวานเวลาเดียวกัน ${fmtThb(same.costThb)} · เมื่อวานทั้งวัน ${fmtThb(yesterday.costThb)}`,
        paceChip(today.costThb, same.costThb)),
      el("dl", { class: "uz-hero-stats" },
        heroStat("customers", "ลูกค้าทัก (คน)", today.customers, same.customers),
        heroStat("replies", "ลูกแพรตอบ", today.aiReplies, same.aiReplies),
        heroStat("followups", "ทักตาม", today.followups, same.followups),
        el("div", { class: "uz-hero-stat" },
          el("dt", {}, "เฉลี่ยต่อข้อความ"),
          el("dd", {}, counter("perReply", perReply, fmtThb)),
          el("small", {}, `คนใหม่วันนี้ ${fmtInt(today.newCustomers)} คน`)),
      ),
    ),
  );
}

/* ------------------------------ จังหวะรายชั่วโมง ------------------------------ */

function hourDetail(row) {
  if (!row) return "แตะแท่งเพื่อดูรายชั่วโมง";
  return `${hh(row.hour)}–${String(row.hour).padStart(2, "0")}:59 · ทัก ${fmtInt(row.inbound)} · ตอบ ${fmtInt(row.aiReplies)} · ทักตาม ${fmtInt(row.followups)} · ${fmtThb(row.costThb)} (เมื่อวาน ทัก ${fmtInt(row.yesterdayInbound)})`;
}

function pulseChart(hours, nowHour) {
  const W = 720; const H = 220; const top = 12; const bottom = 26; const left = 8; const right = 8;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...hours.map((r) => Math.max(r.inbound, r.aiReplies, r.followups, r.yesterdayInbound)));
  const band = (W - left - right) / 24;
  const barW = Math.max(2, (band - 6) / 3);
  const y = (v) => top + plotH - (Number(v) / max) * plotH;
  const svg = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, class: "uz-pulse-svg", role: "img", "aria-label": "ข้อความรายชั่วโมงวันนี้เทียบเมื่อวาน" });
  for (const frac of [0.25, 0.5, 0.75, 1]) svg.append(svgNode("line", { x1: left, x2: W - right, y1: y(max * frac), y2: y(max * frac), class: "uz-gridline" }));
  const now = svgNode("rect", { x: left + nowHour * band, y: top - 6, width: band, height: plotH + 6, rx: 8, class: "uz-now-col" });
  svg.append(now);
  const ghost = hours.map((r, i) => `${left + i * band + band / 2},${y(r.yesterdayInbound)}`).join(" ");
  svg.append(svgNode("polyline", { points: ghost, class: "uz-ghost" }));
  const detail = el("p", { class: "uz-pulse-detail", "aria-live": "polite" }, hourDetail(hours[nowHour]));
  hours.forEach((row, i) => {
    const g = svgNode("g", { class: `uz-hour${row.future ? " is-future" : ""}${i === nowHour ? " is-now" : ""}`, tabindex: row.future ? "-1" : "0" });
    SERIES.forEach((series, s) => {
      const value = Number(row[series.field]) || 0;
      const rect = svgNode("rect", {
        x: left + i * band + 3 + s * barW, y: y(value), width: Math.max(1, barW - 1), height: Math.max(0, top + plotH - y(value)),
        rx: Math.min(3, barW / 2), class: `uz-bar ${series.cls}`,
      });
      rect.style.setProperty("--d", `${i * 22 + s * 40}ms`);
      g.append(rect);
    });
    g.append(svgNode("rect", { x: left + i * band, y: top, width: band, height: plotH, class: "uz-hit" }));
    if (i % 3 === 0) g.append(Object.assign(svgNode("text", { x: left + i * band + band / 2, y: H - 8, class: "uz-tick", "text-anchor": "middle" }), { textContent: hh(i) }));
    const show = () => { detail.textContent = hourDetail(row); };
    g.addEventListener("pointerenter", show);
    g.addEventListener("focus", show);
    svg.append(g);
  });
  return { svg, detail };
}

function pulseCard(usage) {
  const nowHour = Math.floor(((usage.asOf + 7 * HOUR_MS) % 86_400_000) / HOUR_MS);
  const { svg, detail } = pulseChart(usage.hourly || [], nowHour);
  return el("section", { class: "uz-card uz-pulse uz-rise", "aria-labelledby": "uz-pulse-title" },
    el("header", { class: "uz-card-head" },
      el("h2", { id: "uz-pulse-title" }, "จังหวะวันนี้"),
      el("ul", { class: "uz-legend" },
        SERIES.map((series) => el("li", {}, el("span", { class: `uz-swatch ${series.cls}` }), series.label)),
        el("li", {}, el("span", { class: "uz-swatch is-ghost" }), "เมื่อวาน (ลูกค้าทัก)"))),
    el("div", { class: "uz-pulse-frame" }, svg),
    detail);
}

/* -------------------------------- ค่า AI ตามงาน -------------------------------- */

function jobsCard(usage) {
  const jobs = (usage.costByJob || []).filter((row) => row.calls > 0 || row.costThb > 0);
  const max = Math.max(0.01, ...jobs.map((row) => row.costThb));
  return el("section", { class: "uz-card uz-jobs uz-rise", "aria-labelledby": "uz-jobs-title" },
    el("header", { class: "uz-card-head" }, el("h2", { id: "uz-jobs-title" }, "ค่า AI ตามงาน"),
      el("span", { class: "uz-card-note" }, "วันนี้ เรียงจากแพงสุด")),
    jobs.length ? el("ol", { class: "uz-job-list" }, jobs.map((row, i) => {
      const fill = el("span", { class: "uz-job-fill" });
      fill.style.setProperty("--w", String(Math.max(0.02, row.costThb / max)));
      fill.style.setProperty("--d", `${120 + i * 70}ms`);
      return el("li", { class: "uz-job" },
        el("div", { class: "uz-job-top" },
          el("strong", {}, row.job), el("span", { class: "uz-model" }, row.model),
          el("span", { class: "uz-job-cost" }, row.priced === false ? "ยังไม่มีราคา" : fmtThb(row.costThb))),
        el("div", { class: "uz-job-track" }, fill),
        el("small", {}, `${fmtInt(row.calls)} ครั้ง`));
    })) : el("p", { class: "uz-empty" }, "วันนี้ยังไม่มีการเรียกโมเดล"));
}

/* ------------------------------- ใครทำงานอะไร ------------------------------- */

const vendorOf = (model) => (/^claude/u.test(model) ? "is-claude" : /luna/u.test(model) ? "is-luna" : /^gpt/u.test(model) ? "is-sol" : "is-rule");

function rolesCard(usage) {
  return el("section", { class: "uz-card uz-roles uz-rise", "aria-labelledby": "uz-roles-title" },
    el("header", { class: "uz-card-head" }, el("h2", { id: "uz-roles-title" }, "ใครทำงานอะไร")),
    el("ul", { class: "uz-role-grid" }, (usage.roles || []).map((role, i) => staggered(el("li", { class: `uz-role ${vendorOf(role.model)}` },
      el("span", { class: "uz-role-job" }, role.job),
      el("strong", { class: "uz-role-model" }, role.model || "—"),
      el("span", { class: "uz-role-how" }, role.how),
      role.calls > 0 ? el("span", { class: "uz-role-today" }, `${fmtInt(role.calls)} ครั้ง · ${fmtThb(role.costThb)}`) : null,
    ), i))));
}

/* ------------------------------- คุณภาพคำตอบ ------------------------------- */

function qualityRing(quality) {
  const r = 42; const c = 2 * Math.PI * r;
  const share = quality.replies ? quality.firstTry / quality.replies : 0;
  const svg = svgNode("svg", { viewBox: "0 0 100 100", class: "uz-ring", role: "img", "aria-label": `ผ่านรอบแรก ${fmtPct(share)}` });
  svg.append(svgNode("circle", { cx: 50, cy: 50, r, class: "uz-ring-track" }));
  const arc = svgNode("circle", { cx: 50, cy: 50, r, class: "uz-ring-arc", "stroke-dasharray": `${c}`, "stroke-dashoffset": `${c * (1 - share)}` });
  arc.style.setProperty("--c", String(c));
  svg.append(arc);
  return { svg, share };
}

function qualityCard(usage) {
  const q = usage.quality || {};
  const { svg, share } = qualityRing(q);
  return el("section", { class: "uz-card uz-quality uz-rise", "aria-labelledby": "uz-quality-title" },
    el("header", { class: "uz-card-head" }, el("h2", { id: "uz-quality-title" }, "คุณภาพคำตอบ"),
      el("span", { class: "uz-card-note" }, "กติกาในโค้ดตรวจทุกข้อความก่อนส่ง")),
    el("div", { class: "uz-quality-body" },
      el("div", { class: "uz-ring-wrap" }, svg, el("span", { class: "uz-ring-label" }, counter("firstTry", share * 100, (v) => `${Math.round(v)}%`), el("small", {}, "ผ่านรอบแรก"))),
      el("dl", { class: "uz-quality-facts" },
        el("div", {}, el("dt", {}, "คำตอบวันนี้"), el("dd", {}, fmtInt(q.replies))),
        el("div", {}, el("dt", {}, "เขียนใหม่ 1 ครั้ง"), el("dd", {}, fmtInt(q.rewritten))),
        el("div", {}, el("dt", {}, "ถอยไปเครื่องเดิม"), el("dd", {}, fmtInt(q.fallback))),
        el("div", {}, el("dt", {}, "ใช้คลังคำตอบ Opus"), el("dd", {}, fmtInt(q.bankUsed))),
        el("div", {}, el("dt", {}, "การ์ดสไตล์"), el("dd", {}, q.card || "—")))),
    (q.topRules || []).length ? el("div", { class: "uz-rules" }, el("span", {}, "ร่างแรกผิดบ่อย:"),
      q.topRules.map((rule) => el("span", { class: "uz-rule" }, `${rule.id} ×${rule.n}`))) : null);
}

/* -------------------------------- คัดกรอง -------------------------------- */

function qualifyCard(usage) {
  const q = usage.qualify || {};
  const capShare = q.dailyCapThb > 0 ? Math.min(1, q.costThb / q.dailyCapThb) : 0;
  const meter = el("span", { class: "uz-meter-fill" });
  meter.style.setProperty("--w", String(Math.max(0.01, capShare)));
  const minutes = Math.max(0, Math.round((q.nextRoundAt - usage.asOf) / 60_000));
  return el("section", { class: `uz-card uz-qualify uz-rise is-${q.mode || "off"}`, "aria-labelledby": "uz-qualify-title" },
    el("header", { class: "uz-card-head" }, el("h2", { id: "uz-qualify-title" }, "คัดกรองเข้าเกณฑ์"),
      el("span", { class: "uz-mode" }, QUALIFY_MODE_LABEL[q.mode] || "ไม่ทราบ")),
    el("div", { class: "uz-qualify-hero" },
      el("span", { class: "uz-qualify-dot", "aria-hidden": "true" }),
      el("div", {}, counter("yellow", q.yellowNow, fmtInt, "is-big"), el("small", {}, "ห้อง AI off (not qualify) ตอนนี้"))),
    el("dl", { class: "uz-qualify-facts" },
      el("div", {}, el("dt", {}, "ปิดวันนี้"), el("dd", {}, fmtInt(q.closedToday))),
      el("div", {}, el("dt", {}, "เปิดคืนวันนี้"), el("dd", {}, fmtInt(q.reopenedToday))),
      el("div", {}, el("dt", {}, "ตรวจแล้ว"), el("dd", {}, `${fmtInt(q.checked)} ครั้ง`)),
      el("div", {}, el("dt", {}, "รุ่น"), el("dd", {}, q.model || "—"))),
    el("div", { class: "uz-meter", title: "งบต่อวันของตัวคัดกรอง" }, meter),
    el("p", { class: "uz-card-note" }, `${fmtThb(q.costThb)} จากงบ ${fmtThb(q.dailyCapThb)}/วัน · รอบถัดไป ${clock(q.nextRoundAt)} (อีก ${minutes} นาที)`),
    el("p", { class: "uz-card-note" }, "ปิดเฉพาะห้องคะแนน 0–5 ที่บอกเองว่าไม่มีงบ ว่างงาน อยากหารายได้ หรือเกษียณ และไม่มีสัญญาณซื้อ · ทักตามหยุดเองเมื่อ AI ปิด"));
}

/* -------------------------------- กุญแจ API -------------------------------- */

function keyPill(provider, key) {
  return el("li", { class: `uz-key ${key.active ? "is-active" : "is-standby"}` },
    el("span", { class: "uz-key-led", "aria-hidden": "true" }),
    el("strong", {}, `${provider} ชุด ${key.slot}`),
    el("span", {}, key.active ? "ใช้อยู่" : "สำรอง พร้อมสลับ"));
}

function keysCard(usage) {
  const k = usage.keys;
  return el("section", { class: "uz-card uz-keys uz-rise", "aria-labelledby": "uz-keys-title" },
    el("header", { class: "uz-card-head" }, el("h2", { id: "uz-keys-title" }, "กุญแจ API"),
      el("span", { class: "uz-card-note" }, "ชุดหลักหมดหรือถูกปฏิเสธ = สลับชุดสำรองในคำขอเดียวกัน")),
    k ? el("ul", { class: "uz-key-list" },
      (k.openai || []).map((key) => keyPill("OpenAI", key)),
      (k.anthropic || []).map((key) => keyPill("Claude", key))) : el("p", { class: "uz-empty" }, "อ่านสถานะจากเกตเวย์ไม่ได้ตอนนี้"),
    k?.failingModels?.length ? el("p", { class: "uz-warn" }, `รุ่นที่มีปัญหาล่าสุด: ${k.failingModels.join(", ")}`) : null,
    k && (k.lastSwitchAt.openai || k.lastSwitchAt.anthropic)
      ? el("p", { class: "uz-card-note" }, `สลับชุดล่าสุด ${[k.lastSwitchAt.openai, k.lastSwitchAt.anthropic].filter(Boolean).map((t) => clock(Date.parse(t))).join(" · ")} น.`) : null);
}

/* ---------------------------------- หน้า ---------------------------------- */

function notes(usage) {
  return el("details", { class: "uz-notes" },
    el("summary", {}, "ตัวเลขมาจากไหน"),
    el("ul", {},
      el("li", {}, "ข้อความนับเป็นฟอง: ลูกแพรตอบ = ตอบเมื่อลูกค้าทัก · ทักตาม = ลูกแพรทักไปเอง · ไม่นับห้องทดสอบ"),
      el("li", {}, `ค่า AI = token ที่บันทึก × ราคาต่อรุ่น × ${usage.thbPerUsd ? usage.thbPerUsd.toFixed(2) : "—"} บาทต่อดอลลาร์ (ค่าประมาณ ไม่ใช่ใบแจ้งหนี้)`),
      usage.unpricedTokens > 0 ? el("li", {}, `มี ${fmtInt(usage.unpricedTokens)} token ที่ยังไม่มีราคาในตาราง จึงไม่อยู่ในยอด`) : null,
      el("li", {}, "หน้านี้อ่านอย่างเดียว อัปเดตทุก 1 นาทีตอนเปิดดู และไม่แตะงานตอบแชท")));
}

function pageBody(usage, settled) {
  const sections = [hero(usage), pulseCard(usage), jobsCard(usage), rolesCard(usage), qualityCard(usage), qualifyCard(usage), keysCard(usage)];
  sections.forEach(staggered);
  return el("main", { class: "page-scroll" }, el("div", { class: `page-inner uz${settled ? " is-settled" : ""}` },
    sections[0],
    el("div", { class: "uz-grid" }, sections[1], sections[2]),
    sections[3],
    el("div", { class: "uz-grid is-three" }, sections[4], sections[5], sections[6]),
    notes(usage)));
}

export function createUsagePage({ api, mount, pageHeader, tabBar, stopPolling, setView, state }) {
  let renderGen = 0;
  const onPage = () => (location.hash || "").startsWith("#/usage");

  async function render({ poll = false } = {}) {
    const gen = ++renderGen;
    const routeGen = state.routeGen;
    stopPolling();
    let usage = null;
    let error = "";
    try {
      usage = (await api("/console/api/usage/today"))?.usage ?? null;
    } catch (err) {
      error = String(err?.message || err);
    }
    if (gen !== renderGen || routeGen !== state.routeGen || !onPage()) return;
    if (!usage) {
      if (!poll) mount(pageHeader("Usage วันนี้"), el("main", { class: "page-scroll" }, el("div", { class: "page-inner" },
        el("p", { class: "empty" }, `โหลดตัวเลขไม่สำเร็จ: ${error || "ไม่มีข้อมูล"}`))), tabBar());
      armPoll();
      return;
    }
    if (!poll) shown.clear(); // เข้าหน้าใหม่ = ตัวเลขไหลจากศูนย์ · รอบ poll ไหลจากค่าเดิม
    mount(pageHeader("Usage วันนี้"), pageBody(usage, poll), tabBar());
    setView("page");
    armPoll();
  }

  function armPoll() {
    stopPolling();
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = null;
      if (!onPage()) return;
      try {
        if (document.visibilityState !== "hidden") await render({ poll: true });
      } catch { /* เงียบ — rearm ด้านล่างเสมอ */ }
      finally {
        if (!state.pollTimer && onPage()) armPoll();
      }
    }, POLL_MS);
  }

  return render;
}
