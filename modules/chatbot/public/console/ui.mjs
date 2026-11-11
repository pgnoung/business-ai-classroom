// ui.mjs — ชิ้นส่วน UI กลางที่หลายหน้าใช้ร่วมกัน (แยกจาก console.js คุมขนาดไฟล์ <800 บรรทัด)
// ทุกค่า dynamic เรนเดอร์ผ่าน el() (text node เท่านั้น — ดู dom.mjs)
import { el, timeAgo } from "./dom.mjs";
import { isLukpraeTheme, moodPortrait } from "./lukpraeArt.mjs";

export function customerLabel(c) {
  return c.known_name || c.display_name || `ลูกค้า ${String(c.line_user_id).slice(-6)}`;
}

const FOLLOWUP_SUPPRESSION_LABELS = Object.freeze({
  customer_will_return: "ลูกค้าจะติดต่อกลับเอง",
  customer_considering: "ลูกค้าขอคิดดูก่อน",
  colleague_will_contact: "ลูกค้าจะให้เพื่อนร่วมงานติดต่อมา",
  accounting_documents: "ติดต่อเรื่องเอกสาร ไม่ใช่การขาย",
});

export function followupSuppressionLabel(customer) {
  const reason = String(customer?.followup_suppression_reason || "");
  if (Number(customer?.followup_enabled) !== 0 || !reason) return "";
  return FOLLOWUP_SUPPRESSION_LABELS[reason] || "ห้องนี้หยุดติดตามอยู่";
}

export function followupSuppressionBadge(customer) {
  const reason = followupSuppressionLabel(customer);
  return reason ? el("span", { class: "badge badge-gray", title: reason }, "ไม่ต้องติดตาม") : null;
}

/* ------------------------- G4: segment HOT/WARM/COLD ------------------------ */
// เกณฑ์เดียวกับ server (db.listConversations): hot >= 8, warm 5-7, cold <= 4 หรือไม่มี score
// 30 ก.ย. 2026 (พี่ง้วง: เปลี่ยน "ลูกค้าเย็น/อุ่น/ร้อน" เป็นคำแบบคน): สนใจสูง · กำลังพิจารณา · เพิ่งเริ่มคุย (คีย์ภายในคงเดิม)

export const SEGMENT_META = {
  hot: { label: "สนใจสูง", icon: "🔥", explain: "คะแนน 8–10 — สนใจสูง ใกล้ตัดสินใจ รีบคุยต่อ" },
  warm: { label: "กำลังพิจารณา", icon: "🤔", explain: "คะแนน 5–7 — กำลังพิจารณา ชวนคุยต่อ" },
  cold: { label: "เพิ่งเริ่มคุย", icon: "🌱", explain: "คะแนน 0–4 หรือยังไม่มีคะแนน — เพิ่งเริ่มคุย ยังไม่เห็นสัญญาณซื้อ" },
  // 2026-08-28 (คำสั่งเจ้าของ): ห้องที่ติดป้ายเงียบไม่ใช่ผู้สนใจเรียน การให้คะแนน
  // ความสนใจกับคนกลุ่มนี้ไม่มีความหมาย จึงแทนที่ไอคอนทั้งอันแทนที่จะเพิ่มป้ายซ้อน
  null: {
    label: "ไม่ทัก",
    icon: "🚫",
    explain: "ติดป้าย null หรือ customer — บอทไม่ตอบและไม่ทักตามทุกกรณี ทีมงานดูแลเอง",
  },
};

export function segmentOf(c) {
  // ป้ายเงียบมาก่อน score เสมอ — ห้องแบบนี้ไม่ได้อยู่ในกระบวนการขาย
  if (c?.silenced_tag_at) return "null";
  const s = Number(c?.last_score);
  if (Number.isInteger(s) && s >= 8) return "hot";
  if (Number.isInteger(s) && s >= 5) return "warm";
  return "cold";
}

// อวตารวงกลม: รูปโปรไฟล์ LINE ถ้ามี / ไม่มีก็อักษรแรกของชื่อ — ขอบเป็นวงแหวน score
// สีวงแหวนตรงกับ segment เสมอ (🔥 ส้มแดง / 🌤 เหลือง / ❄️ เทาฟ้า) — ยาว = score/10
export function avatarEl(c, { size = "" } = {}) {
  const seg = segmentOf(c);
  const score = Number(c?.last_score);
  const pct = Number.isInteger(score) ? Math.max(8, score * 10) : 0;
  const inner = c?.picture_url
    ? el("img", { class: "avatar-img", src: c.picture_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
    : el("span", { class: "avatar-txt" }, customerLabel(c).slice(0, 1));
  const node = el("span", {
    class: `avatar seg-${seg}${size ? ` avatar-${size}` : ""}${c?.ai_enabled !== 1 ? " is-off" : ""}`,
    title: Number.isInteger(score) ? `คะแนนความสนใจ ${score}/10` : "ยังไม่มี score",
  }, el("span", { class: "avatar-core" }, inner));
  // ยาววงแหวน = score/10 — ตั้งผ่าน CSSOM เท่านั้น (CSP style-src 'self' บล็อก style attribute)
  node.style.setProperty("--ring", `${pct}%`);
  return node;
}

// F3: badge คะแนนความสนใจ — 0-4 เทา, 5-7 เหลือง, 8-10 เขียว
export function scoreBadge(score) {
  if (!Number.isInteger(score)) return null;
  const cls = score >= 8 ? "score-high" : score >= 5 ? "score-mid" : "score-low";
  return el("span", { class: `score-badge ${cls}`, title: "คะแนนความสนใจซื้อ (0-10)" }, String(score));
}

export const TREND_LABELS = { up: "↑ กำลังมา", flat: "→ ทรงตัว", down: "↓ แผ่วลง" };

/* ------------------------------ ออเดอร์ (G6 P2) ------------------------------ */
// meta ต่อสถานะ — label ไทย + สีโทนความหมาย + ปุ่มขั้นถัดไป (flow: ร่าง → ยืนยัน →
// จ่าย → ส่ง → จบ; ยกเลิกได้ทุกขั้นที่ยังไม่จบ — กฎจริงบังคับฝั่ง server เสมอ)
export const ORDER_STATUS_META = {
  draft: { label: "ร่าง", tone: "draft", next: "confirmed", nextLabel: "ยืนยันออเดอร์" },
  confirmed: { label: "ยืนยันแล้ว", tone: "confirmed", next: "paid", nextLabel: "รับเงินแล้ว" },
  paid: { label: "จ่ายแล้ว", tone: "paid", next: "shipped", nextLabel: "จัดส่งแล้ว" },
  shipped: { label: "จัดส่งแล้ว", tone: "shipped", next: "done", nextLabel: "จบออเดอร์" },
  done: { label: "จบ", tone: "done" },
  cancelled: { label: "ยกเลิก", tone: "cancelled" },
};

// 7 ต.ค. 2026 โหมดคลาส (state.features.orderMode = "class"): ขายคลาส ไม่มีขั้นจัดส่ง — ค่าสถานะเดิม คำใหม่
export const ORDER_STATUS_META_CLASS = {
  draft: { label: "ร่าง", tone: "draft", next: "confirmed", nextLabel: "ยืนยันออเดอร์" },
  confirmed: { label: "ยืนยันแล้ว · รอชำระ", tone: "confirmed", next: "paid", nextLabel: "ชำระแล้ว" },
  paid: { label: "ชำระแล้ว", tone: "paid", next: "done", nextLabel: "ลงทะเบียนเรียนแล้ว" },
  shipped: { label: "จัดส่งแล้ว", tone: "shipped", next: "done", nextLabel: "ลงทะเบียนเรียนแล้ว" },
  done: { label: "ลงทะเบียนเรียนแล้ว", tone: "done" },
  cancelled: { label: "ยกเลิก", tone: "cancelled" },
};

export const orderStatusMetaFor = (mode) => (mode === "class" ? ORDER_STATUS_META_CLASS : ORDER_STATUS_META);

export function orderStatusBadge(status, mode = "shipping") {
  const meta = orderStatusMetaFor(mode)[status] || { label: status, tone: "draft" };
  return el("span", { class: `badge order-st order-st-${meta.tone}` }, meta.label);
}

// สรุปรายการของออเดอร์หนึ่งบรรทัด (แผงข้อมูล/การ์ด) — items_json พัง = ""
export function orderItemsSummary(order, max = 60) {
  let items = [];
  try {
    items = JSON.parse(order.items_json || "[]") || [];
  } catch {
    items = [];
  }
  const text = items.map((it) => `${it.name} ×${it.qty}`).join(", ");
  if (!text) return "ยังไม่มีรายการ";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ยอดเงินออเดอร์: null = ยังไม่ระบุ (ให้คนเติม) — บาทเต็มพอ (ราคาสินค้าไทย)
export function orderTotalLabel(total) {
  return total == null ? "ยังไม่ระบุยอด" : `฿${Number(total).toLocaleString("th-TH")}`;
}

// สวิตช์แบบเห็นแล้วรู้ทันทีว่าเปิด/ปิด (ใช้ใน button ที่มี role="switch")
export function switchDot(on) {
  return el("span", { class: `switch${on ? " is-on" : ""}`, "aria-hidden": "true" });
}

/* --------- สิทธิ์เผยแพร่ (คำสั่งพี่ง้วง 2 ก.ย. 2026) — ใช้ร่วมหลายหน้า --------- */
// ของที่เปลี่ยน "สมอง" ลูกแพร (ราคา สมองต่อสาขา กติกา รอบเรียน) เผยแพร่ได้เฉพาะเจ้าของ
// จงใจไม่ซ่อนทั้งกล่อง: ทีมงานต้องเปิดดูของปัจจุบันได้ระหว่างคุยกับลูกค้า จึงทำเป็น
// "อ่านได้แต่กดไม่ได้" + บรรทัดบอกว่าต้องส่งต่อให้ใคร
// (ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์ consoleSettingsApi.mjs — ตรงนี้แค่ไม่วาดปุ่มที่กดแล้วเด้ง 403)
//
// สถานะปัจจุบัน (Package K, 2 ก.ย. 2026): ทุกกล่องที่เคยใช้สองตัวนี้ย้ายไปใช้
// "คิวขออนุมัติ" แล้ว (publishQueue.mjs) — ทีมงานแก้ได้ กดแล้วกลายเป็นคำขอ
// เก็บสองตัวนี้ไว้เพราะยังเป็นคำตอบที่ถูกสำหรับของที่ "เสนอไม่ได้เลย" ในอนาคต
// (เช่นสวิตช์ที่ไม่มีรูปคำขอที่ปลอดภัย) — ไม่มีที่ไหนเรียกใช้อยู่ตอนนี้
export function publishLockedHint() {
  return el("p", { class: "block-hint publish-locked" }, "ส่งให้พี่ง้วงกดเผยแพร่");
}

// กดไม่ได้จริง ไม่ใช่แค่ไม่มีปุ่ม — คนที่แท็บมาถึงช่องนี้ต้องรู้ว่ามันอ่านอย่างเดียว
// คลาส is-locked ทำให้ "ดูออกด้วยตา" ด้วย: ช่องที่ดูเหมือนพิมพ์ได้แต่พิมพ์ไม่ได้
// คือของที่ทีมจะคิดว่าระบบพัง แล้วโทรหาพี่ง้วงตอนเช้าวันจันทร์
export function lockControl(node) {
  node.disabled = true;
  node.setAttribute("aria-readonly", "true");
  node.classList.add("is-locked");
  return node;
}

/* ------------------------- ภาพประกอบ empty state (W4) ------------------------ */
// data-URI SVG cannot inherit CSS variables, so resolve semantic theme tokens
// when it is rendered. This keeps both light and dark variants in sync.
function themeColor(token) {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

function emptyArtSvg() {
  const surface = themeColor("--surface");
  const surface2 = themeColor("--surface-2");
  const line = themeColor("--line");
  const ink = themeColor("--ink");
  const brand = themeColor("--brand");
  const purple = themeColor("--purple");
  const orange = themeColor("--orange");
  const green = themeColor("--green");
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 116 96">' +
    `<ellipse cx="58" cy="89" rx="34" ry="5" fill="${surface2}"/>` +
    `<rect x="18" y="14" width="80" height="54" rx="18" fill="${surface}" stroke="${line}" stroke-width="2.5"/>` +
    `<path d="M44 66 L38 82 L60 68 Z" fill="${surface}" stroke="${line}" stroke-width="2.5" stroke-linejoin="round"/>` +
    `<rect x="40" y="60" width="24" height="9" fill="${surface}"/>` +
    `<circle cx="45" cy="38" r="4" fill="${ink}"/><circle cx="71" cy="38" r="4" fill="${ink}"/>` +
    `<path d="M46 49 Q58 59 70 49" stroke="${brand}" stroke-width="3.5" fill="none" stroke-linecap="round"/>` +
    `<circle cx="24" cy="9" r="3" fill="${purple}"/>` +
    `<path d="M98 4 l2.2 5 5 2.2 -5 2.2 -2.2 5 -2.2 -5 -5 -2.2 5 -2.2 Z" fill="${orange}"/>` +
    `<circle cx="10" cy="46" r="2.5" fill="${brand}"/><circle cx="107" cy="54" r="2.5" fill="${green}"/>` +
    '</svg>';
}

// 28 ก.ย. 2026: ธีมลูกแพรใช้หน้าจริงของลูกแพร (ตัดจาก master ที่อนุมัติ) แทนหน้ายิ้มกราฟิก
// mood บอกอารมณ์ตามบริบท เช่น "thinking" ตอนหน้าไม่มีสิทธิ์/ยังไม่เปิด — instance อื่นได้ภาพเดิม
export function emptyArt({ mood = "smile" } = {}) {
  if (isLukpraeTheme()) {
    const art = moodPortrait(mood, { size: "lg", decorative: true });
    art.classList.add("empty-muse");
    return art;
  }
  return el("img", {
    class: "empty-art", alt: "", "aria-hidden": "true",
    src: `data:image/svg+xml;utf8,${encodeURIComponent(emptyArtSvg())}`,
  });
}

/* ----------------------------- ราคาโมเดล (B8) ------------------------------ */

// THB-first: ต่ำกว่า 10฿ โชว์ทศนิยม 2 ตำแหน่ง / ตั้งแต่ 10฿ ขึ้นไปปัดเป็นบาทเต็ม
export function fmtThb(value) {
  const v = Number(value) || 0;
  return Math.abs(v) < 10
    ? v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(v).toLocaleString("th-TH");
}

export function fmtUsd(value, digits = 2) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

export function hasPrice(model) {
  return model && Number.isFinite(model.inUsdPerM) && Number.isFinite(model.outUsdPerM);
}

// ป้ายราคา THB-first: "in ~180฿ / out ~1,080฿ ต่อ 1M" — ไม่มีราคา = "ยังไม่ยืนยันราคา"
export function priceLabelThb(model, thbPerUsd) {
  if (!hasPrice(model)) return "ยังไม่ยืนยันราคา";
  return `in ~${fmtThb(model.inUsdPerM * thbPerUsd)}฿ / out ~${fmtThb(model.outUsdPerM * thbPerUsd)}฿ ต่อ 1M`;
}

export function priceLabelUsd(model) {
  if (!hasPrice(model)) return "";
  return `($${model.inUsdPerM} / $${model.outUsdPerM} ต่อ 1M)`;
}

// บรรทัดบอก rate ที่ตัวเลขทั้งหมดใช้ — live โชว์เวลาอัปเดต / env = ค่าตั้งเอง
export function fxLine(data) {
  if (!data) return "";
  const rate = Number(data.thbPerUsd) || 0;
  if (data.fxSource === "live" && data.fxFetchedAt) {
    return `อัตราแลกเปลี่ยน ~${rate.toFixed(2)} ฿/$ (อัปเดต ${timeAgo(data.fxFetchedAt)})`;
  }
  if (data.fxSource === "live") return `อัตราแลกเปลี่ยน ~${rate.toFixed(2)} ฿/$`;
  return `อัตราแลกเปลี่ยน ~${rate.toFixed(2)} ฿/$ (ค่าตั้งเอง)`;
}

/* --------------------------- การ์ดผลตรวจสลิป (G3) --------------------------- */

// การ์ดใต้รูปที่ลูกค้าส่ง — เขียว ✅ ผ่าน / แดง ⚠️ น่าสงสัย / เทา ตรวจไม่ได้หรือกำลังตรวจ
// ผลตรวจเป็นตัวช่วยแอดมินเท่านั้น — การยืนยันยอดจริงยังเป็นหน้าที่คนเสมอ
export function slipCard(s) {
  if (!s) return null;
  let payload = {};
  try {
    payload = JSON.parse(s.payload_json || "{}") || {};
  } catch {
    payload = {};
  }
  const amount = Number(s.amount);
  if (s.status === "valid") {
    const meta = [
      Number.isFinite(amount) ? `ยอด ฿${amount.toLocaleString("th-TH")}` : null,
      payload.timestamp ? `เวลา ${payload.timestamp}` : null,
      payload.sender ? `จาก ${payload.sender}` : null,
      s.trans_ref ? `ref ${s.trans_ref}` : null,
    ].filter(Boolean).join(" · ");
    return el("div", { class: "slip-card slip-valid" },
      el("strong", { class: "slip-title" }, "✅ สลิปผ่านการตรวจอัตโนมัติ"),
      meta ? el("span", { class: "slip-meta" }, meta) : null,
      el("span", { class: "slip-note" }, "ตรวจเบื้องต้นโดยระบบ — ยืนยันยอดเข้าบัญชีจริงก่อนปิดรายการ"),
    );
  }
  if (s.status === "suspect") {
    return el("div", { class: "slip-card slip-suspect" },
      el("strong", { class: "slip-title" }, "⚠️ สลิปน่าสงสัย"),
      el("span", { class: "slip-meta" }, payload.reason || "ไม่ผ่านการตรวจอัตโนมัติ"),
      el("span", { class: "slip-note" }, "อย่าเพิ่งยืนยันรับเงิน — ตรวจกับบัญชีจริง/สอบถามลูกค้าก่อน"),
    );
  }
  if (s.status === "pending") {
    return el("div", { class: "slip-card slip-pending" },
      el("strong", { class: "slip-title" }, "กำลังตรวจสลิปอัตโนมัติ…"),
    );
  }
  return el("div", { class: "slip-card slip-error" },
    el("strong", { class: "slip-title" }, "ตรวจสลิปอัตโนมัติไม่ได้"),
    el("span", { class: "slip-note" }, "เปิดรูปใน LINE แล้วตรวจด้วยคนตามปกติ"),
  );
}
