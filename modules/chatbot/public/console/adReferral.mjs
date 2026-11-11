// adReferral.mjs — แถบ "มาจากโฆษณา" ใต้หัวห้อง + ป้ายบนแถวรายการแชท (พี่ง้วง 6 ต.ค. 2026 ค่ำ:
// "ads id ให้อยู่ในหน้าแชทของลูกค้าได้ไหม เหมือน facebook ... มองง่ายเห็นง่าย ว่ามาจาก ads ไหน สวยงาม สะดุดตา")
//
// ข้อมูลมาจาก /conversations/:id/messages → adReferral และแถวรายการ → ad_referral (src/adReferralView.mjs)
// ชื่อแอดคือชื่อในตัวจัดการโฆษณาเป๊ะ ๆ (ไม่ตัดคำ ไม่แปล) — ทีมต้องเอาไปค้นใน Ads Manager ได้ตรงตัว
// รูปแอด: สำเนาในฐานข้อมูล (/console/api/ad-thumbs — src/adThumbs.mjs) หรือลิงก์ CDN ของ Meta ระหว่างรอเก็บ
// ลิงก์ CDN หมดอายุได้ → โหลดไม่ขึ้นก็สลับเป็นภาพสำรองเอง ไม่มีรูปแตก
import { el, isGeneric } from "./dom.mjs";

const COMPACT_KEY = "lk.adBanner.compact";
// ห้องแชทสร้าง DOM ใหม่ทั้งใบเมื่อมีข้อความเข้า (chat.mjs) — แอนิเมชันเข้าเล่นครั้งเดียวต่อห้องต่อการเปิดหน้า
const enteredRooms = new Set();
// รายการ "เคยกดแอดอื่น" ที่เปิดค้างไว้ — DOM สร้างใหม่ทุกข้อความเข้า ต้องไม่พับกลับเองต่อหน้าทีม
const openedOthers = new Set();
const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

const NARROW_SCREEN = "(max-width: 720px)";

function readCompact() {
  try {
    const stored = globalThis.localStorage?.getItem(COMPACT_KEY);
    if (stored === "1" || stored === "0") return stored === "1";
  } catch { /* โหมดส่วนตัว — ใช้ค่าตามขนาดจอ */ }
  // ยังไม่เคยกดเลือก: มือถือเริ่มแบบย่อ (แถบเต็มกินจอแชทราวหนึ่งในสาม) · จอใหญ่เริ่มแบบเต็ม
  try { return Boolean(globalThis.matchMedia?.(NARROW_SCREEN)?.matches); } catch { return false; }
}
function writeCompact(on) {
  try { globalThis.localStorage?.setItem(COMPACT_KEY, on ? "1" : "0"); } catch { /* โหมดส่วนตัว — จำไม่ได้ก็ไม่เป็นไร */ }
}

/** "วันนี้ 21:15" / "เมื่อวาน 09:02" / "6 ต.ค. 21:15" ตามนาฬิกาเครื่องที่เปิดดู */
export function clickTimeLabel(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return "";
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (dayKey(d) === dayKey(today)) return `วันนี้ ${hm}`;
  if (dayKey(d) === dayKey(yesterday)) return `เมื่อวาน ${hm}`;
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${hm}`;
}

/** ตัวอักษรบนภาพสำรอง: ชุดแอดแบบ "A | ..." ใช้ตัวชุด (A/B/C) · อย่างอื่นใช้ไอคอนโทรโข่ง */
export function adMonogram(title) {
  const match = /^\s*([A-Za-z0-9]{1,2})\s*\|/u.exec(String(title || ""));
  return match ? match[1].toUpperCase() : "📣";
}

/** ชื่อที่โชว์: ชื่อแอดจริง · ไม่มีชื่อ = บอกว่ามาจากลิงก์/แอดแบบไหน */
export function adDisplayTitle(ad) {
  if (ad?.adTitle) return ad.adTitle;
  if (ad?.adId) return "แอดที่ไม่มีชื่อ";
  if (ad?.ref) return `ลิงก์ ${ad.ref}`;
  return "ลิงก์เข้าแชท";
}

function fallbackTile(ad) {
  return el("span", { class: "adref-thumb adref-thumb-fallback", "aria-hidden": "true" }, adMonogram(ad.adTitle));
}

function thumb(ad) {
  if (!ad.photoUrl) return fallbackTile(ad);
  const frame = el("span", { class: `adref-thumb${ad.mediaType === "video" ? " is-video" : ""}`, "aria-hidden": "true" });
  const img = el("img", {
    src: ad.photoUrl, alt: "", loading: "eager", decoding: "async", referrerpolicy: "no-referrer",
    width: "56", height: "56",
    // ลิงก์ CDN หมดอายุ/โดนบล็อก → ภาพสำรองแทนที่ทั้งกรอบ (ไม่ทิ้งไอคอนรูปแตกไว้)
    onerror: () => frame.replaceWith(fallbackTile(ad)),
  });
  frame.append(img);
  return frame;
}

function linkButton(href, label, extraClass = "") {
  if (!href) return null;
  return el("a", { class: `adref-link${extraClass}`, href, target: "_blank", rel: "noopener noreferrer" }, label);
}

function otherAds(card, now, roomId) {
  const others = card.ads.slice(1);
  if (!others.length) return null;
  const hidden = Math.max(0, (Number(card.adCount) || 0) - card.ads.length);
  const details = el("details", {
    class: "adref-others",
    open: roomId && openedOthers.has(roomId) ? "" : null,
    ontoggle: () => {
      if (!roomId) return;
      if (details.open) openedOthers.add(roomId);
      else openedOthers.delete(roomId);
    },
  },
    el("summary", {}, `เคยกดแอดอื่นด้วย ${others.length + hidden} ตัว`),
    el("ul", {},
      others.map((ad) => el("li", {},
        el("span", { class: "adref-others-title" }, adDisplayTitle(ad)),
        el("span", { class: "adref-others-time" }, clickTimeLabel(ad.lastAt, now)),
        linkButton(ad.adsManagerUrl, "ตัวจัดการโฆษณา ↗", " adref-link-quiet"),
      )),
      hidden ? el("li", { class: "adref-others-more" }, `และอีก ${hidden} ตัวที่เก่ากว่า`) : null,
    ),
  );
  return details;
}

/** แถบใต้หัวห้อง — card = null คืน null (ห้องที่ไม่ได้มาจากแอดไม่มีอะไรเพิ่มบนจอ) */
export function adReferralBanner(card, { now = Date.now(), roomId = "" } = {}) {
  const ad = card?.ads?.[0];
  if (!ad || isGeneric()) return null; // white-label: ร้านทั่วไปไม่จดที่มาจากแอด
  const title = adDisplayTitle(ad);
  const entering = roomId && !enteredRooms.has(roomId);
  if (entering) enteredRooms.add(roomId);
  const banner = el("section", {
    class: `adref-banner${readCompact() ? " is-compact" : ""}${entering ? " is-entering" : ""}`,
    role: "note",
    "aria-label": `ห้องนี้มาจากโฆษณา: ${title}`,
  });
  const toggle = el("button", {
    type: "button", class: "adref-toggle", "aria-expanded": readCompact() ? "false" : "true",
    title: "ย่อ/ขยายแถบโฆษณา", "aria-label": "ย่อหรือขยายแถบโฆษณา",
    onclick: () => {
      const compact = !banner.classList.contains("is-compact");
      banner.classList.toggle("is-compact", compact);
      toggle.setAttribute("aria-expanded", compact ? "false" : "true");
      writeCompact(compact);
    },
  }, el("span", { class: "adref-chevron", "aria-hidden": "true" }, "⌃"));

  banner.append(
    thumb(ad),
    el("div", { class: "adref-body" },
      el("div", { class: "adref-eyebrow" },
        el("span", { class: "adref-pill" }, el("span", { "aria-hidden": "true" }, "📣 "), "มาจากโฆษณา"),
        el("span", { class: `adref-who ${card.firstContact ? "is-new" : "is-back"}` },
          card.firstContact ? "ลูกค้าใหม่จากแอด" : "ลูกค้าเดิมกดแอดกลับมา"),
        el("span", { class: "adref-time" }, `กดแอด ${clickTimeLabel(ad.lastAt, now)}`),
      ),
      el("strong", { class: "adref-title", title }, title),
      el("div", { class: "adref-meta" },
        ad.adId ? el("code", { class: "adref-id", title: "เลขแอด (ad_id) — ค้นในตัวจัดการโฆษณาได้" }, `ad_id ${ad.adId}`) : null,
        !ad.adId && ad.ref ? el("code", { class: "adref-id" }, `ref ${ad.ref}`) : null,
        el("span", { class: "adref-actions" },
          linkButton(ad.postUrl, "ดูโพสต์ ↗"),
          linkButton(ad.adsManagerUrl, "ตัวจัดการโฆษณา ↗", " adref-link-strong"),
        ),
      ),
      otherAds(card, now, roomId),
    ),
    toggle,
  );
  return banner;
}

/** ป้ายบนแถวรายการแชท — null = ห้องไม่ได้มาจากแอด */
export function adReferralChip(chip) {
  if (!chip || isGeneric()) return null;
  const title = adDisplayTitle(chip);
  const more = Number(chip.adCount) > 1 ? ` · กดแอด ${chip.adCount} ตัว` : "";
  return el("span", {
    class: "badge badge-ad",
    title: `มาจากโฆษณา: ${title}${chip.adId ? ` · ad_id ${chip.adId}` : ""}${more}`,
  },
  el("span", { class: "badge-ad-mark", "aria-hidden": "true" }, "AD"),
  el("span", { class: "badge-ad-text" }, title));
}
