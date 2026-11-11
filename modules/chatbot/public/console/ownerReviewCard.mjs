// ownerReviewCard.mjs — ชิ้นหน้าตาของ "ห้องตรวจ" (#/owner-review): การ์ดห้อง · ฟองแชท · ชิปหมวด · หน้าว่าง · การ์ดหน้าภาพรวม
//
// ไฟล์นี้วาดอย่างเดียว ไม่ยิง API ไม่ถือสถานะ (ตัวคุมอยู่ใน ownerReview.mjs)
// ข้อความแชท/เหตุผลของ AI มาจากลูกค้าและจากโมเดล (เซิร์ฟเวอร์ปิดชื่อ/เบอร์มาแล้ว) — ทุกค่าลง el() เป็น text node เท่านั้น
import { el, fmtTime, timeAgo } from "./dom.mjs";
import { icon } from "./icons.mjs";

// ชิปหมวดแบบสั้น (คำของพี่ง้วง) — คำอธิบายเต็มจากเซิร์ฟเวอร์อยู่ใน title/aria-label ของชิป
// tone = กลุ่มสีที่สื่อความหมาย: money เรื่องเงิน/หางาน · sell มาขายของให้เรา · monk พระ · gamble พนัน · harass คุกคาม · personal ส่วนตัว
export const CATEGORY_META = Object.freeze({
  ask_money: { short: "ขอเงิน", icon: "coins", tone: "money" },
  no_budget_drift: { short: "ไม่มีงบแล้วลากยาว", icon: "wallet", tone: "money" },
  monk: { short: "พระ", icon: "bowl", tone: "monk" },
  survival_income: { short: "หางาน", icon: "briefcase", tone: "money" },
  business_pitch: { short: "ชวนทำธุรกิจ", icon: "pitch", tone: "sell" },
  ai_vendor: { short: "ขายบัญชี AI", icon: "chip", tone: "sell" },
  gambling: { short: "พนัน", icon: "dice", tone: "gamble" },
  adult_harassment: { short: "แซว/คุกคาม", icon: "shieldx", tone: "harass" },
  off_topic_personal: { short: "เรื่องส่วนตัว", icon: "chatheart", tone: "personal" },
});
const FALLBACK_META = Object.freeze({ short: "นอกเรื่อง", icon: "chat", tone: "personal" });

export function categoryMeta(category) {
  return CATEGORY_META[category] || FALLBACK_META;
}

/** เปลี่ยนข้อความในโหนดเดิม — แทนลูกด้วย text node (ไม่ใช้ innerHTML และ DOM จำลองในเทสต์เห็นค่าใหม่จริง) */
export function setText(node, value) {
  node?.replaceChildren(globalThis.document.createTextNode(String(value ?? "")));
}

/* ---------------------------------- เวลา ---------------------------------- */

// รอบตรวจผูกกับเวลาไทยเสมอ (09/12/15/19) — ไม่ใช้เขตเวลาของเครื่องที่เปิดดู
const BKK_CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const BKK_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" });
const DAY_MS = 86_400_000;

export function bangkokClock(ms) {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? BKK_CLOCK.format(new Date(value)) : "";
}

/** "15:00" ถ้าเป็นวันนี้ · "พรุ่งนี้ 09:00" ถ้าเป็นพรุ่งนี้ (เวลาไทย) */
export function scanWhen(ms, now = Date.now()) {
  const clock = bangkokClock(ms);
  if (!clock) return "";
  const day = BKK_DAY.format(new Date(Number(ms)));
  if (day === BKK_DAY.format(new Date(now))) return clock;
  return day === BKK_DAY.format(new Date(now + DAY_MS)) ? `พรุ่งนี้ ${clock}` : clock;
}

/** "ทักล่าสุด 12 นาทีที่แล้ว" — timeAgo คืน "ตอนนี้" / "5 นาที" / "2 ชม." / "12/10" */
export function sinceText(ts, now = Date.now()) {
  const ago = timeAgo(ts, now);
  if (!ago) return "";
  if (ago === "ตอนนี้") return "ทักล่าสุดเมื่อกี้";
  return /นาที|ชม\./u.test(ago) ? `ทักล่าสุด ${ago}ที่แล้ว` : `ทักล่าสุด ${ago}`;
}

/* --------------------------------- ส่วนหัวหน้า --------------------------------- */

const pendingCount = (summary) => Number(summary?.counts?.pending || 0) + Number(summary?.counts?.sendFailed || 0);

const dailyCount = (summary) => Number(summary?.tabs?.find?.((row) => row?.key === "daily")?.count) || 0;

/**
 * สวิตช์สองแท็บบนหัว — เป็นลิงก์ (สถานะอยู่ใน URL) · waiting = ห้องรอยืนยันปิดที่เหลือในกอง
 * dailyWaiting = ห้องที่ยังไม่ติดป้ายในคิวตรวจแชท (เฟส B นับสดตอนกด) · ไม่ส่ง = ใช้ตัวเลขจาก summary
 */
export function reviewTabs({ tab, summary, waiting, dailyWaiting }) {
  const count = Number.isFinite(Number(waiting)) ? Number(waiting) : pendingCount(summary);
  const daily = Number.isFinite(Number(dailyWaiting)) ? Number(dailyWaiting) : dailyCount(summary);
  const badge = (value) => el("span", { class: `orv-seg-count${value ? "" : " is-zero"}` }, String(value));
  const link = (key, href, label, extra = null) => el("a", {
    class: `orv-seg-btn${tab === key ? " is-active" : ""}`, href,
    ...(tab === key ? { "aria-current": "page" } : {}),
  }, el("span", { class: "orv-seg-label" }, label), extra);
  return el("nav", { class: "orv-seg", "aria-label": "เลือกงานในห้องตรวจ" },
    link("close", "#/owner-review", "รอยืนยันปิด", badge(count)),
    link("daily", "#/owner-review/daily", "ตรวจแชทวันนี้", badge(daily)),
  );
}

/**
 * แถบเตือนที่ต้องเห็นก่อนกด — ตัวคัดกรองไม่ on = ทุกการปิดถูกปฏิเสธ (ยังไม่ส่งอะไรถึงลูกค้า)
 * tab "daily" = ไม่เกี่ยวกับการปิดห้อง (ไม่โชว์แถบตัวคัดกรอง) และคำบอกโหมดพูดถึงคิว 20:00
 */
export function statusBanners(summary, { tab = "close" } = {}) {
  const banners = [];
  const daily = tab === "daily";
  if (!daily && summary?.sweepOn === false) {
    banners.push(el("p", { class: "orv-banner is-warn", role: "status" },
      el("strong", {}, "ตอนนี้ยังปิดห้องไม่ได้"),
      el("span", {}, "ตัวคัดกรองรายชั่วโมงปิดอยู่ ระบบจะไม่ยอมปิดห้องและยังไม่ส่งอะไรถึงลูกค้า — เปิดได้ที่ ตั้งค่า › สวิตช์พฤติกรรม"),
    ));
  }
  // staff ที่ได้รับมอบไม่ครบทุกสาขา — บอกตรง ๆ ว่ารายการนี้ไม่ใช่ทุกห้อง (ไม่ใช่ "ไม่มีห้องรอ")
  const hidden = Array.isArray(summary?.channelScope?.hidden) ? summary.channelScope.hidden.filter(Boolean) : [];
  if (summary?.channelScope?.limited === true && hidden.length) {
    banners.push(el("p", { class: "orv-banner is-info", role: "status" },
      el("strong", {}, "บัญชีนี้เห็นไม่ครบทุกช่องทาง"),
      el("span", {}, `ห้องของ ${hidden.join(", ")} ไม่อยู่ในสิทธิ์ของบัญชีนี้ — ให้เจ้าของมอบสิทธิ์ช่องทางนั้นถ้าต้องการตรวจด้วย`)));
  }
  if (summary?.mode === "shadow") {
    banners.push(el("p", { class: "orv-banner is-info", role: "status" },
      el("strong", {}, "รอบตรวจอยู่โหมดทดลอง"),
      el("span", {}, daily ? "คิวตรวจแชทยังเตรียมทุกคืน 20:00 แต่ยังไม่เด้งแจ้งเตือนมือถือ" : "มีข้อเสนอให้ดูได้ แต่ยังไม่เด้งแจ้งเตือนมือถือ")));
  } else if (summary?.mode === "off") {
    banners.push(el("p", { class: "orv-banner is-info", role: "status" },
      el("strong", {}, "รอบตรวจปิดอยู่"),
      el("span", {}, daily ? "จะไม่มีคิวตรวจแชทใหม่จนกว่าจะเปิดที่ตั้งค่า (คิวเก่ายังตรวจต่อได้)" : "จะไม่มีข้อเสนอใหม่จนกว่าจะเปิดที่ตั้งค่า")));
  }
  return banners;
}

const positionLabel = (done, total) => `${Math.min(done + 1, total)} / ${total}`;

/**
 * แถบความคืบหน้า — คืนตัวคุมเพื่ออัปเดตโหนดเดิม (แถบเลื่อนแบบมีโมชัน ไม่วาดใหม่ทั้งก้อน)
 * format(done, total) = ข้อความหน้าแถบ · ค่าเริ่มต้น "3 / 7" (ห้องที่กำลังดู) · คิวตรวจแชทใช้ "ตรวจแล้ว 12 / 118"
 */
export function createProgress({ format = positionLabel } = {}) {
  const label = el("span", { class: "orv-progress-label" });
  const fill = el("span", { class: "orv-progress-fill" });
  const track = el("span", {
    class: "orv-progress-track", role: "progressbar", "aria-label": "ตรวจไปแล้ว", "aria-valuemin": "0",
  }, fill);
  const node = el("div", { class: "orv-progress" }, label, track);
  function set(done, total) {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeDone = Math.min(Math.max(0, Number(done) || 0), safeTotal);
    node.hidden = safeTotal === 0;
    setText(label, format(safeDone, safeTotal));
    track.setAttribute("aria-valuemax", String(safeTotal));
    track.setAttribute("aria-valuenow", String(safeDone));
    track.setAttribute("aria-valuetext", `ตรวจแล้ว ${safeDone} จาก ${safeTotal} ห้อง`);
    fill.style.setProperty("--orv-progress", String(safeTotal ? safeDone / safeTotal : 0));
  }
  return { node, set };
}

/* ---------------------------------- การ์ดห้อง ---------------------------------- */

function speakerOf(message) {
  if (message?.direction === "in") return "ลูกค้า";
  return message?.speaker === "แอดมิน" ? "แอดมิน" : "ลูกแพร";
}

function bubble(message) {
  const speaker = speakerOf(message);
  const side = message?.direction === "in" ? "is-in" : "is-out";
  return el("li", { class: `orv-msg ${side}${speaker === "แอดมิน" ? " is-staff" : ""}${message?.afterBaseline ? " is-new" : ""}` },
    el("p", { class: "orv-msg-text" }, String(message?.text || "")),
    el("span", { class: "orv-msg-meta" },
      message?.afterBaseline ? el("span", { class: "orv-msg-new" }, "ใหม่") : null,
      el("span", {}, speaker),
      message?.at ? el("time", {}, fmtTime(message.at)) : null,
    ),
  );
}

export const THREAD_PREVIEW = 3;

/** บทสนทนาย่อ: 3 ข้อความล่าสุด · "ดูเพิ่ม" กางได้ถึง 8 (ข้อความเก่ากว่าโผล่ด้านบน เหมือนแอปแชท) */
export function chatThread(messages, { expanded = false, onToggle = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const hidden = expanded ? 0 : Math.max(0, list.length - THREAD_PREVIEW);
  return el("section", { class: "orv-thread", "aria-label": "ข้อความล่าสุดในห้อง" },
    list.length > THREAD_PREVIEW
      ? el("button", {
          type: "button", class: "orv-more", "aria-expanded": expanded ? "true" : "false", onclick: onToggle,
        }, expanded ? "ย่อเหลือ 3 ข้อความล่าสุด" : `ดูเพิ่ม · อีก ${hidden} ข้อความก่อนหน้า`)
      : null,
    list.length
      ? el("ol", { class: "orv-msgs" }, list.slice(hidden).map(bubble))
      : el("p", { class: "orv-thread-empty" }, "ห้องนี้ยังไม่มีข้อความให้ดู"),
  );
}

function threadSkeleton() {
  return el("div", { class: "orv-thread is-loading", "aria-hidden": "true" },
    el("span", { class: "orv-skel is-in" }), el("span", { class: "orv-skel is-out" }), el("span", { class: "orv-skel is-in is-short" }));
}

export function channelInfo(item, detail) {
  const facebook = detail?.room ? detail.room.facebook === true : String(item?.channelId || "") === "facebook";
  return { facebook, label: facebook ? "Facebook" : "LINE" };
}

function avatarInitial(name) {
  const chars = Array.from(String(name || "").trim());
  // สระหน้า (เ แ โ ใ ไ) ยืนเดี่ยวอ่านไม่ออก — พ่วงตัวถัดไปถ้าไม่ใช่จุดปิดชื่อ
  if (/^[เแโใไ]$/u.test(chars[0] || "") && chars[1] && chars[1] !== "•") return `${chars[0]}${chars[1]}`;
  return chars[0] || "?";
}

/**
 * การ์ดห้องหนึ่งใบ (ยังไม่ตัดสิน)
 * notice = { tone: "warn"|"info"|"danger", text } — ข้อความจากการกดที่ไม่ผ่าน (เช่นลูกค้าพิมพ์ใหม่)
 * detailState = "loading" | "ready" | "failed"
 */
export function proposalCard({ item, detail = null, detailState = "loading", expanded = false, onToggleMore = null, onRetry = null, notice = null, now = Date.now() }) {
  const meta = categoryMeta(item?.category);
  const name = item?.customer?.displayName || item?.customer?.displayNameMasked || "ลูกค้า";
  const channel = channelInfo(item, detail);
  const headingId = `orv-name-${String(item?.id || "x").replace(/[^\w-]/gu, "")}`;
  const typedAfter = detail?.customerTypedSinceBaseline === true;
  const body = detailState === "ready" && detail
    ? chatThread(detail.messages, { expanded, onToggle: onToggleMore })
    : detailState === "failed"
      ? el("div", { class: "orv-thread is-failed" },
          el("p", {}, "โหลดข้อความของห้องนี้ไม่สำเร็จ"),
          onRetry ? el("button", { type: "button", class: "btn btn-outline btn-mini", onclick: onRetry }, "ลองโหลดอีกครั้ง") : null)
      : threadSkeleton();
  return el("article", { class: `orv-card tone-${meta.tone}`, "aria-labelledby": headingId, "data-proposal": String(item?.id || "") },
    el("span", { class: "orv-stamp is-keep", "aria-hidden": "true" }, "ไม่ปิด"),
    el("span", { class: "orv-stamp is-close", "aria-hidden": "true" }, "ปิดแชท"),
    el("header", { class: "orv-card-head" },
      el("span", { class: "orv-avatar", "aria-hidden": "true" }, avatarInitial(name)),
      el("div", { class: "orv-who" },
        // tabindex -1: หลังตัดสินห้องก่อนหน้า โฟกัสย้ายมาที่ชื่อห้องใหม่ (ไม่ใช่ปุ่มตัดสิน)
        el("h2", { class: "orv-name", id: headingId, tabindex: "-1" }, name),
        el("p", { class: "orv-sub" },
          el("span", { class: `orv-chan ${channel.facebook ? "is-fb" : "is-line"}` }, channel.label),
          el("span", { class: "orv-sub-time" }, sinceText(item?.lastInboundAt, now)),
        ),
      ),
    ),
    el("div", { class: "orv-why" },
      el("span", { class: "orv-chip", title: item?.categoryLabel || meta.short, "aria-label": `หมวด: ${item?.categoryLabel || meta.short}` },
        icon(meta.icon, { size: 16, className: "ico orv-chip-ico" }), el("span", {}, meta.short)),
      item?.reason ? el("p", { class: "orv-reason" }, el("span", { class: "orv-reason-k" }, "AI เห็นว่า"), el("span", {}, item.reason)) : null,
    ),
    notice ? el("p", { class: `orv-notice is-${notice.tone || "warn"}`, role: "alert" }, notice.text) : null,
    !notice && item?.status === "send_failed"
      ? el("p", { class: "orv-notice is-danger" }, "ส่งคำลาไม่สำเร็จ — ยังไม่ได้ปิดห้อง เลือกปิดเงียบหรือไม่ปิดได้")
      : null,
    !notice && typedAfter
      ? el("p", { class: "orv-notice is-info" }, "ลูกค้าพิมพ์มาใหม่หลัง AI เสนอ — อ่านข้อความล่าสุดก่อนตัดสินนะคะ")
      : null,
    body,
    el("footer", { class: "orv-card-foot" },
      el("span", { class: "orv-source" }, item?.sourceLabel || ""),
      el("a", { class: "orv-open", href: `#/c/${encodeURIComponent(String(item?.customerId || ""))}` }, "เปิดห้องเต็ม ›"),
    ),
  );
}

/* ---------------------------------- หน้าว่าง ---------------------------------- */

function lastScanText(summary) {
  const last = summary?.lastScan;
  if (!last) return "ยังไม่เคยตรวจ — รอบแรกจะเริ่มตามเวลาด้านบน";
  const at = bangkokClock(last.slotAt);
  if (summary?.inFlight || last.status === "building") return `กำลังตรวจรอบ ${at}…`;
  if (last.status === "failed") return `รอบ ${at} ตรวจไม่จบ — รอบถัดไปจะลองใหม่เอง`;
  return `ตรวจล่าสุดรอบ ${at} · ดู ${Number(last.rooms) || 0} ห้อง · เสนอปิด ${Number(last.proposed) || 0}`;
}

function todayLine(today = {}) {
  const parts = [
    ["ปิดแล้ว", Number(today.confirmed) || 0],
    ["ปิดเงียบ", Number(today.closedSilent) || 0],
    ["ไม่ปิด", Number(today.rejected) || 0],
  ].filter(([, count]) => count > 0);
  if (!parts.length) return null;
  return el("ul", { class: "orv-today", "aria-label": "วันนี้ตัดสินไปแล้ว" },
    parts.map(([label, count]) => el("li", {}, el("strong", {}, String(count)), el("span", {}, label))));
}

export function emptyDeck({ summary, now = Date.now(), finished = 0 }) {
  const next = scanWhen(summary?.nextScanAt, now);
  return el("section", { class: "orv-empty", "aria-labelledby": "orv-empty-title" },
    el("h2", { id: "orv-empty-title", class: "orv-empty-title", tabindex: "-1" }, "ไม่มีห้องรอยืนยัน 🎉"),
    finished > 0 ? el("p", { class: "orv-empty-done" }, `รอบนี้ตรวจครบ ${finished} ห้องแล้ว ขอบคุณค่ะ`) : null,
    next ? el("p", { class: "orv-empty-next" }, el("span", {}, "รอบถัดไป"), el("strong", {}, next)) : null,
    el("p", { class: "orv-empty-last" }, lastScanText(summary)),
    todayLine(summary?.counts?.today),
  );
}

/* ------------------------------ การ์ดหน้าภาพรวม ------------------------------ */

/** ทางเข้าห้องตรวจบนหน้าภาพรวม — โผล่เฉพาะตอนมีห้องรอ (หน้าแรกต้องไม่รก) */
export function ownerReviewOverviewCard(summary) {
  const waiting = pendingCount(summary);
  if (!summary || summary.ok === false || waiting <= 0) return null;
  return el("a", { class: "ov-orv", href: "#/owner-review" },
    el("span", { class: "ov-orv-ico", "aria-hidden": "true" }, icon("scan", { size: 22 }) || "🔎"),
    el("span", { class: "ov-orv-copy" },
      el("span", { class: "ov-orv-title" }, `รอยืนยันปิด ${waiting} ห้อง`),
      el("span", { class: "ov-orv-sub" }, "AI เสนอห้องที่ท่าทีไม่น่าไปต่อ — แตะเพื่อตรวจทีละห้อง"),
    ),
    el("span", { class: "ov-orv-go", "aria-hidden": "true" }, "›"),
  );
}
