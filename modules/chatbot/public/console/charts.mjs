// charts.mjs — กราฟ SVG ล้วน (ไม่มีไลบรารี) ที่หน้าภาพรวม/ผลงานใช้ร่วมกัน
// ย้ายออกจาก overview.mjs (28 ก.ย. 2026) ตอนแยกหน้าภาพรวมแบบ CEO — โค้ดกราฟเดิมไม่เปลี่ยนพฤติกรรม
// สีทุกเส้นมาจาก token ของธีม (var(--chart-*)) เพื่อให้ตามธีมสว่าง/มืดของแต่ละ instance เสมอ

const SVG_NS = "http://www.w3.org/2000/svg";

// SVG ต้องสร้างด้วย createElementNS ทั้ง root และลูก — el() ธรรมดาได้ namespace ผิด ไม่ render
export function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function tickLabels(svg, series, width, height) {
  // ป้ายวันซ้ายสุด/ขวาสุด (สั้น ๆ พอเห็นช่วง)
  const dayLabel = (p) => `${Number(p.day.slice(8, 10))}/${Number(p.day.slice(5, 7))}`;
  svg.append(
    Object.assign(svgNode("text", { x: 12, y: height - 6, class: "chart-tick" }), { textContent: dayLabel(series[0]) }),
    Object.assign(svgNode("text", { x: width - 12, y: height - 6, class: "chart-tick", "text-anchor": "end" }), { textContent: "วันนี้" }),
  );
}

// SVG inherits console tokens, so charts track the selected operator theme.
export function areaChart(series, field, { width = 560, height = 150, color = "var(--chart-inbound)", fill = "var(--chart-inbound-fill)" } = {}) {
  const values = series.map((p) => Number(p[field]) || 0);
  const max = Math.max(1, ...values);
  const px = (i) => 12 + (i * (width - 24)) / Math.max(1, values.length - 1);
  const py = (v) => height - 22 - (v / max) * (height - 40);
  const points = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const area = `M ${px(0)},${height - 22} L ${points.join(" L ")} L ${px(values.length - 1)},${height - 22} Z`;
  const line = `M ${points.join(" L ")}`;
  const svg = svgNode("svg", {
    class: "chart-svg", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none",
    role: "img", "aria-label": "กราฟแนวโน้มรายวัน",
  });
  svg.append(
    svgNode("path", { d: area, fill }),
    svgNode("path", { d: line, fill: "none", stroke: color, "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    svgNode("circle", { cx: px(values.length - 1), cy: py(values.at(-1) ?? 0), r: "4.5", fill: color }),
  );
  tickLabels(svg, series, width, height);
  return svg;
}

// Revenue bars use a separate semantic token from inbound chat volume.
export function barsChart(series, field, { width = 560, height = 150, color = "var(--chart-revenue)" } = {}) {
  const values = series.map((p) => Number(p[field]) || 0);
  const max = Math.max(1, ...values);
  const slot = (width - 24) / values.length;
  const barW = Math.max(6, Math.min(22, slot * 0.55));
  const svg = svgNode("svg", {
    class: "chart-svg", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none",
    role: "img", "aria-label": "กราฟแท่งรายวัน",
  });
  values.forEach((v, i) => {
    const h = v > 0 ? Math.max(4, (v / max) * (height - 40)) : 2.5;
    svg.append(svgNode("rect", {
      x: (12 + i * slot + (slot - barW) / 2).toFixed(1),
      y: (height - 22 - h).toFixed(1),
      width: barW.toFixed(1), height: h.toFixed(1),
      rx: Math.min(5, barW / 2), fill: v > 0 ? color : "var(--chart-revenue-muted)",
    }));
  });
  tickLabels(svg, series, width, height);
  return svg;
}

// เส้นเล็กข้างประโยค "วันนี้คุยกับลูกค้า" — เห็นทิศทาง 14 วันโดยไม่ต้องอ่านแกน
// ไม่มีป้ายวัน ไม่มีแกน: เป็นเครื่องประดับที่มีความหมาย ไม่ใช่กราฟให้อ่านค่า
export function sparkline(series, field, { width = 120, height = 34, label = "แนวโน้ม 14 วัน" } = {}) {
  const values = (Array.isArray(series) ? series : []).map((p) => Number(p?.[field]) || 0);
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const px = (i) => 2 + (i * (width - 4)) / (values.length - 1);
  const py = (v) => height - 3 - (v / max) * (height - 8);
  const points = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const svg = svgNode("svg", {
    class: "spark", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none",
    role: "img", "aria-label": label,
  });
  svg.append(
    svgNode("path", {
      d: `M ${px(0)},${height} L ${points.join(" L ")} L ${px(values.length - 1)},${height} Z`,
      fill: "var(--chart-inbound-fill)",
    }),
    svgNode("path", {
      d: `M ${points.join(" L ")}`, fill: "none", stroke: "var(--chart-inbound)",
      "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke",
    }),
    svgNode("circle", { cx: px(values.length - 1), cy: py(values.at(-1)), r: "2.6", fill: "var(--chart-inbound)" }),
  );
  return svg;
}
