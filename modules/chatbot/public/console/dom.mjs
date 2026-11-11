// dom.mjs — ตัวสร้าง DOM ทางเดียวของ console (บทเรียน Team Pulse)
//
// ข้อความแชทคือ input จากคนแปลกหน้า (ลูกค้า LINE) และจากโมเดล — ทุกค่า dynamic
// ต้องลง createTextNode เท่านั้น helper นี้ "ฉีด HTML ไม่ได้โดยดีไซน์":
// - ไม่มี innerHTML / insertAdjacentHTML ทุกกรณี
// - on* รับเฉพาะ function — สตริง on* ถูกทิ้ง (กัน inline handler)
// - href/src ที่เป็น javascript:/vbscript:/data:text ถูกทิ้ง
// (อีกชั้น: CSP ของ console บล็อก inline script อยู่แล้ว — นี่คือ defense in depth)

const URL_ATTRS = new Set(["href", "src", "action", "formaction"]);

/* ------------------------------ white-label (8 ต.ค. 2026) ------------------------------ */
// คอนโซลชุดเดียวใช้ได้หลายร้าน: profile "course" (ค่าเริ่มต้น = production ลูกแพร) ต้องเหมือนเดิมทุกไบต์
// ส่วน profile "generic" (ร้านอื่น) เปลี่ยนชื่อแบรนด์ในข้อความที่คนเห็นเป็นชื่อของร้านนั้น
// console.js เรียก setBrandingContext() ตอนได้ branding จาก /me — โมดูลที่ไม่มี state ก็ใช้ helper ได้
let brandingContext = null;

const cleanName = (value) => (typeof value === "string" ? value.trim() : "");

export function setBrandingContext(branding) {
  brandingContext = branding && typeof branding === "object" ? { ...branding } : null;
}

function brandingOf(state) {
  return state?.branding && typeof state.branding === "object" ? state.branding : brandingContext;
}

// state ไม่บังคับ — ไม่ส่งมา = ใช้ branding ที่ console.js ตั้งไว้ตอน boot
export function isGeneric(state) {
  return brandingOf(state)?.profile === "generic";
}

// ชื่อ AI แอดมินที่คนเห็น — course = "ลูกแพร" เสมอ (ข้อความเดิมทุกไบต์)
export function agentLabel(state) {
  const b = brandingOf(state);
  if (b?.profile !== "generic") return "ลูกแพร";
  return cleanName(b.agentName) || cleanName(b.agent) || "แอดมิน";
}

// ชื่อเจ้าของที่คนเห็น — course = "พี่ง้วง"
export function ownerLabel(state) {
  const b = brandingOf(state);
  if (b?.profile !== "generic") return "พี่ง้วง";
  return cleanName(b.ownerName) || "เจ้าของร้าน";
}

// ชื่อธุรกิจที่คนเห็น — course = "พี่ง้วง ติดกระดุม"
export function businessLabel(state) {
  const b = brandingOf(state);
  if (b?.profile !== "generic") return "พี่ง้วง ติดกระดุม";
  return cleanName(b.businessName) || cleanName(b.name) || "ร้านของเรา";
}

// แปลงชื่อแบรนด์ของ production ในข้อความเป็นชื่อร้านนี้ — course คืนสตริงเดิมทุกไบต์
// (ตัวพิมพ์เล็ก "pngoung"/"lukprae" ไม่แตะ: เป็น id/URL/คีย์ ไม่ใช่ชื่อที่คนอ่าน)
export function brandCopy(text, state) {
  if (typeof text !== "string" || !isGeneric(state)) return text;
  if (!/ลูกแพร|LuKprae|Lukprae|พี่ง้วง|ติดกระดุม|Pngoung|pngoung\.com/u.test(text)) return text;
  const business = businessLabel(state);
  return text
    .replace(/พี่ง้วง\s*ติดกระดุม/gu, business)
    .replace(/ลูกแพร|LuKprae|Lukprae/gu, agentLabel(state))
    .replace(/พี่ง้วง/gu, ownerLabel(state))
    .replace(/ติดกระดุม|Pngoung/gu, business)
    .replace(/pngoung\.com/gu, "yourshop.com");
}

// ข้อความจากคนนอก (ลูกค้า/ทีม/ข้อมูลร้าน) ที่ต้องแสดงตามจริงแม้มีคำที่บังเอิญตรงชื่อแบรนด์
// el() จะไม่ผ่าน brandCopy กับ node นี้
export function rawText(value) {
  return globalThis.document.createTextNode(String(value ?? ""));
}

// แอตทริบิวต์ที่คนอ่าน/โปรแกรมอ่านหน้าจออ่าน — แปลงชื่อแบรนด์ด้วย (value/href/src ไม่แตะ)
const COPY_ATTRS = new Set(["title", "aria-label", "placeholder", "alt"]);
const BLOCKED_URL = /^\s*(?:javascript|vbscript|data:\s*text)/i;

export function el(tag, attrs = {}, ...children) {
  const doc = globalThis.document;
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") {
      node.className = String(value);
    } else if (key.startsWith("on")) {
      // event handler ต้องเป็น function เท่านั้น — สตริงคือความพยายามฉีดโค้ด ทิ้ง
      if (typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (URL_ATTRS.has(key) && BLOCKED_URL.test(String(value))) {
      // javascript: URL ฯลฯ — ทิ้งเงียบ
    } else {
      node.setAttribute(key, COPY_ATTRS.has(key) ? brandCopy(String(value)) : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    // ไม่ใช่ DOM node = แปลงเป็น text node เสมอ (จุดที่ทำให้ XSS เป็นไปไม่ได้)
    node.append(typeof child === "object" && child.nodeType ? child : doc.createTextNode(brandCopy(String(child))));
  }
  return node;
}

// เวลาแบบสั้นสำหรับ inbox: "ตอนนี้", "5 นาที", "2 ชม.", หรือ วัน/เดือน
export function timeAgo(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "";
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return "ตอนนี้";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} นาที`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ชม.`;
  const d = new Date(t);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function fmtTime(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
