// kpiVisual.mjs — ภาพสรุปบนสุดของหน้าผลงาน (#/kpi) ก่อนตารางละเอียด — 28 ก.ย. 2026
//
// พี่ง้วง: "หลายระบบดูยาก ตัวเลขเยอะ" — ตารางเดิมยังอยู่ครบข้างล่าง (อ่านผิดยาก) แต่คนที่
// เปิดหน้านี้ควรรู้คำตอบสามข้อในห้าวินาที: ใครตอบเร็วแค่ไหน / ใครรออยู่ / พาไปปิดได้แค่ไหน
// กติกาความแฟร์ของหน้านี้ยังใช้ครบ: ความเร็วใช้ชุด "เวลาทำการ ในวันที่ทีมทำงาน",
// % ปิดการขายโชว์คู่จำนวนห้องเสมอ และตัวอย่างน้อยกว่า 20 ห้องมีป้ายบอกตรง ๆ
// แท่ง/วงแหวนตั้งค่าผ่าน CSSOM (style.transform / flexGrow) และ attribute ของ SVG เท่านั้น
// — CSP style-src 'self' ห้าม style="" แต่ไม่ห้ามการตั้งค่าผ่าน CSSOM
import { el } from "./dom.mjs";
import { svgNode } from "./charts.mjs";

const HOUR = 3_600_000;
const THIN_SAMPLE_ROOMS = 20;

export function speedText(ms) {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} วินาที`;
  if (ms < HOUR) return `${Math.round(ms / 60_000)} นาที`;
  const hours = ms / HOUR;
  return hours < 24 ? `${hours.toFixed(1)} ชม.` : `${(hours / 24).toFixed(1)} วัน`;
}

function speedCard(fair) {
  const ai = fair?.ai || {};
  const human = fair?.human || {};
  const max = Math.max(1, Number(ai.medianMs) || 0, Number(human.medianMs) || 0);
  const row = (who, entry, tone) => {
    const ratio = entry.medianMs == null ? 0 : Math.max(0.04, Number(entry.medianMs) / max);
    const fill = el("span", { class: "kv-bar-fill" });
    fill.style.transform = `scaleX(${ratio.toFixed(3)})`;
    return el("div", { class: `kv-speed is-${tone}` },
      el("span", { class: "kv-speed-who" }, who),
      el("span", { class: "kv-bar", "aria-hidden": "true" }, fill),
      el("span", { class: "kv-speed-value" },
        el("strong", {}, speedText(entry.medianMs)),
        el("small", {}, entry.count ? `${entry.count} ครั้ง` : "ไม่มีข้อมูล"),
      ),
    );
  };
  return el("section", { class: "kv-card kv-speed-card" },
    el("h3", { class: "kv-title" }, "ใครตอบเร็วแค่ไหน"),
    row("ลูกแพร", ai, "ai"),
    row("ทีมงาน", human, "human"),
    el("p", { class: "kv-note" }, "ค่ากลาง เฉพาะเวลาทำการในวันที่ทีมทำงาน · แท่งสั้นคือตอบเร็ว"),
  );
}

function backlogCard(backlog) {
  const buckets = Array.isArray(backlog?.buckets) ? backlog.buckets : [];
  const total = Number(backlog?.total) || 0;
  const tones = ["calm", "soft", "warn", "urgent"];
  const stack = el("span", { class: `kv-stack${total ? "" : " is-empty"}`, "aria-hidden": "true" },
    buckets.map((bucket, i) => {
      const part = el("span", { class: `kv-stack-part tone-${tones[i] || "urgent"}` });
      part.style.flexGrow = String(Number(bucket.rooms) || 0);
      return part;
    }));
  return el("section", { class: "kv-card kv-backlog-card" },
    el("h3", { class: "kv-title" }, "ลูกค้ารอคำตอบตอนนี้"),
    el("p", { class: "kv-big" },
      el("strong", {}, String(total)), el("span", {}, "ห้อง"),
      el("span", { class: `kv-big-sub${backlog?.waitingForHuman ? " is-alert" : ""}` },
        backlog?.waitingForHuman ? `ต้องให้คนไปตอบ ${backlog.waitingForHuman}` : "AI ดูแลได้ทุกห้อง"),
    ),
    stack,
    el("ul", { class: "kv-legend" }, buckets.map((bucket, i) => el("li", { class: `tone-${tones[i] || "urgent"}` },
      el("span", { class: "kv-legend-dot", "aria-hidden": "true" }),
      el("span", {}, bucket.label),
      el("strong", {}, String(bucket.rooms)),
    ))),
  );
}

function ring(entry, label, tone) {
  const pct = entry?.ratePct;
  const rooms = Number(entry?.rooms) || 0;
  const thin = rooms > 0 && rooms < THIN_SAMPLE_ROOMS;
  const circumference = 2 * Math.PI * 30;
  const svg = svgNode("svg", { class: "kv-ring-svg", viewBox: "0 0 72 72", "aria-hidden": "true", focusable: "false" });
  const share = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
  svg.append(svgNode("circle", { class: "kv-ring-track", cx: "36", cy: "36", r: "30" }));
  // 0% ต้องเป็นวงว่างจริง ๆ — เส้นยาวศูนย์ที่ปลายมนยังวาดเป็นจุดเล็ก ๆ ให้เข้าใจผิดว่ามีค่า
  if (share > 0) {
    svg.append(svgNode("circle", {
      class: "kv-ring-value", cx: "36", cy: "36", r: "30",
      "stroke-dasharray": `${(share * circumference).toFixed(2)} ${circumference.toFixed(2)}`,
      transform: "rotate(-90 36 36)",
    }));
  }
  return el("div", { class: `kv-ring is-${tone}${thin ? " is-thin" : ""}` },
    el("span", { class: "kv-ring-figure" }, svg, el("strong", { class: "kv-ring-pct" }, pct == null ? "—" : `${pct}%`)),
    el("span", { class: "kv-ring-label" }, label),
    el("span", { class: "kv-ring-sample" }, `${entry?.closed ?? 0} จาก ${rooms} ห้อง`),
  );
}

function closingCard(closing) {
  const sample = (Number(closing?.hybrid?.rooms) || 0) + (Number(closing?.fullyAi?.rooms) || 0);
  return el("section", { class: "kv-card kv-closing-card" },
    el("h3", { class: "kv-title" }, "พาไปถึงจุดปิดการขาย"),
    el("div", { class: "kv-rings" },
      ring(closing?.hybrid, "คน + ลูกแพร", "hybrid"),
      ring(closing?.fullyAi, "ลูกแพรล้วน", "ai"),
    ),
    el("p", { class: "kv-note" }, sample < THIN_SAMPLE_ROOMS
      ? "ตัวอย่างยังน้อย ใช้ดูทิศทางก่อน อย่าเพิ่งใช้ตัดสินผลงาน"
      : "วัดการพาไปถึงจุดปิด ไม่ใช่เงินเข้าบัญชีจริง"),
  );
}

export function kpiVisualSummary(data) {
  if (!data?.speed || !data?.backlog || !data?.closing) return null;
  return el("div", { class: "kpi-visual", role: "group", "aria-label": "ภาพสรุปผลงาน" },
    speedCard(data.speed.workingDays),
    backlogCard(data.backlog),
    closingCard(data.closing),
  );
}
