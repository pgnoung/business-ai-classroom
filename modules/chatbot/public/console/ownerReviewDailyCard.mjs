// ownerReviewDailyCard.mjs — ชิ้นหน้าตาของแท็บ "ตรวจแชทวันนี้" (#/owner-review/daily · เฟส B · 12 ต.ค. 2026)
//
// พี่ง้วง: ทุกคืน 20:00 ส่งแชททุกห้องของวันนั้นให้พี่ง้วงกับชมพู่ยืนยันว่าตอบดีแล้ว หรือต้องปรับอะไร
// ไฟล์นี้วาดอย่างเดียว ไม่ยิง API ไม่ถือสถานะ (ตัวคุมอยู่ใน ownerReviewDaily.mjs)
//   การ์ดหนึ่งใบ = หนึ่งห้อง: แชทของช่วงนั้นเป็นฟอง (ลูกค้าซ้าย · ลูกแพรขวา · ทีมงานแบบที่สาม)
//   ปัญหาที่ AI ชี้ปักอยู่ใต้ฟองที่อ้างถึง (แตะชิปด้านบน = เลื่อนไปที่ฟองนั้นแล้วกะพริบ) · ป้ายน่าห่วง/ปกติ · สรุปหนึ่งบรรทัด
// ข้อความแชท/สรุปของ AI มาจากลูกค้าและจากโมเดล (เซิร์ฟเวอร์ปิดชื่อ/เบอร์มาแล้ว) — ทุกค่าลง el() เป็น text node เท่านั้น
import { el, fmtTime } from "./dom.mjs";
import { scanWhen } from "./ownerReviewCard.mjs";

/** โทนสีของห้อง: น่าห่วง = แดง · ปกติ = เขียว · AI ยังไม่ได้อ่าน = ม่วงเทา (ต้องอ่านเองทั้งห้อง) */
export function riskTone(item) {
  if (item?.riskLevel === "high" || item?.flagged === true) return "risk";
  return item?.riskLevel === "normal" ? "calm" : "unread";
}

const SPEAKER_LABEL = Object.freeze({ customer: "ลูกค้า", ai: "ลูกแพร", team: "ทีมงาน" });
const speakerOf = (bubble) => (SPEAKER_LABEL[bubble?.speaker] ? bubble.speaker : bubble?.direction === "in" ? "customer" : "ai");
// แชทยาว: โชว์ฟองล่าสุดชุดนี้ก่อน (ฟองที่มีปัญหาที่อยู่ก่อนหน้า กางให้เองเมื่อแตะชิป)
export const DAILY_RECENT_BUBBLES = 30;
// แชทไม่เกินเท่านี้ฟอง = สั้นพอเห็นทุกปัญหาใต้ฟองได้ในจอเดียว (ไม่ต้องมีแถวชิปซ้ำด้านบน)
export const SHORT_THREAD_BUBBLES = 6;

export const nameOf = (item) => item?.customer?.displayName || item?.customer?.displayNameMasked || "ลูกค้า";

function avatarInitial(name) {
  const chars = Array.from(String(name || "").trim());
  if (/^[เแโใไ]$/u.test(chars[0] || "") && chars[1] && chars[1] !== "•") return `${chars[0]}${chars[1]}`;
  return chars[0] || "?";
}

export const percent = (value) => (Number.isFinite(Number(value)) && value !== null ? `${Math.round(Number(value) * 100)}%` : "");

/* --------------------------------- ป้ายความเสี่ยง --------------------------------- */

export function riskBadge(item) {
  const tone = riskTone(item);
  const risk = Number(item?.risk);
  const hasRisk = item?.risk !== null && item?.risk !== undefined && Number.isFinite(risk);
  return el("span", {
    class: `odr-risk is-${tone}`,
    ...(hasRisk ? { title: `คะแนนความน่าห่วง ${risk} จาก 100` } : {}),
  }, el("span", { class: "odr-risk-dot", "aria-hidden": "true" }), item?.riskLabel || (tone === "risk" ? "น่าห่วง" : tone === "calm" ? "ปกติ" : "AI ยังไม่ได้อ่าน"));
}

/* ------------------------------ ปัญหาที่ AI ชี้ ------------------------------ */

// รีวิว 13 ต.ค.: กล่องปัญหาเดิม (~100px ต่อข้อ: หัว + โน้ต + "AI ชี้ถูกไหม [ใช่][ไม่ใช่]") หั่นแชทเป็นท่อน อ่านช้า
// → แถบสั้นใต้ฟอง: จุดสี · ชื่อปัญหา · โน้ต (ไม่เกิน 2 บรรทัด แตะอ่านเต็ม + ฟองกะพริบ) · ปุ่ม "ถูก"/"ผิด" ขนาดนิ้ว (44px)
function verdictButtons(issue, { onVerdict, busy }) {
  const make = (value, word, aria) => {
    const button = el("button", {
      type: "button", class: `odr-verdict is-${value}${issue.verdict === value ? " is-on" : ""}`,
      "aria-pressed": issue.verdict === value ? "true" : "false", "aria-label": `${aria}: ${issue.label}`, title: aria,
      onclick: () => onVerdict?.(issue, value),
    }, word);
    button.disabled = Boolean(busy);
    return button;
  };
  return el("span", { class: "odr-verdicts", role: "group", "aria-label": `AI ชี้ถูกไหม: ${issue.label}` },
    make("agree", "ถูก", "AI ชี้ถูก"), make("disagree", "ผิด", "AI ชี้ไม่ถูก"));
}

/**
 * ปัญหาหนึ่งข้อ (ใต้ฟอง หรือในกลุ่ม "ทั้งห้อง") — picking = โหมดเลือกฟอง: เหลือบรรทัดบอกตำแหน่งอย่างเดียว (ไม่มีปุ่ม)
 * expanded = โน้ตเต็ม (แตะชื่อปัญหาสลับ)
 */
function issueNote(issue, { onVerdict, busyKeys, picking = false, expanded = false, onToggleIssue = null }) {
  const severity = issue.severity === "high" ? "high" : "normal";
  const parts = [el("span", { class: "odr-issue-text" },
    el("span", { class: "odr-issue-dot", "aria-hidden": "true" }),
    el("strong", { class: "odr-issue-label" }, issue.label),
    issue.note ? el("span", { class: "odr-issue-note" }, issue.note) : null)];
  const main = picking || !issue.note
    ? el("span", { class: "odr-issue-main" }, parts)
    : el("button", {
        type: "button", class: "odr-issue-main", "aria-expanded": expanded ? "true" : "false",
        "aria-label": `${issue.label}: ${issue.note}`, onclick: () => onToggleIssue?.(issue),
      }, parts);
  return el("div", { class: `odr-issue sev-${severity}${expanded ? " is-open" : ""}${picking ? " is-quiet" : ""}`, "data-issue": issue.key },
    main,
    picking ? null : verdictButtons(issue, { onVerdict, busy: busyKeys?.has?.(issue.key) }),
  );
}

/** ชิปสรุปด้านบนการ์ด — แตะ = เลื่อนไปที่ฟองที่อ้างถึง (ปัญหาที่ไม่ผูกฟองแตะแล้วไม่ไปไหน) */
function issueChips(issues, { anchored, onChipTap }) {
  if (!issues.length) return null;
  return el("ul", { class: "odr-chips", "aria-label": `AI ชี้ ${issues.length} จุด` },
    issues.map((issue) => {
      const canJump = anchored.has(issue.key);
      return el("li", {},
        el("button", {
          type: "button", class: `odr-chip sev-${issue.severity === "high" ? "high" : "normal"}${canJump ? "" : " is-room"}`,
          "aria-label": canJump ? `${issue.label} — ดูข้อความที่ AI ชี้` : `${issue.label} — ทั้งห้อง`,
          onclick: () => onChipTap?.(issue),
        }, el("span", { class: "odr-chip-mark", "aria-hidden": "true" }, issue.severity === "high" ? "!" : "•"), issue.label));
    }));
}

/* ---------------------------------- ฟองแชท ---------------------------------- */

/** รูปจากคลังที่ลูกแพรส่ง — ภาพย่อขนาดตายตัว (ไม่ดัน layout) · โหลดไม่ได้ = เหลือชื่อรูป */
function catalogImage(image) {
  const img = el("img", {
    class: "odr-img", src: image.url, alt: `รูปที่ลูกแพรส่ง: ${image.key}`, width: "160", height: "120",
    loading: "lazy", decoding: "async", referrerpolicy: "no-referrer",
    onerror: (event) => { if (event?.target) event.target.hidden = true; },
  });
  return el("span", { class: "odr-img-wrap" }, img, el("span", { class: "odr-img-cap" }, `รูปจากคลัง · ${image.key}`));
}

function bubbleBody(bubble, text) {
  const image = bubble.image && /^https:\/\//u.test(String(bubble.image.url || "")) ? bubble.image : null;
  return image ? catalogImage(image) : el("span", { class: "odr-bubble-text" }, text);
}

function bubbleNode(bubble, { issuesByKey, picking, flashId, onPick, onVerdict, busyKeys, expandedIssues, onToggleIssue }) {
  const speaker = speakerOf(bubble);
  const issues = (bubble.issueKeys || []).map((key) => issuesByKey.get(key)).filter(Boolean);
  const severity = issues.some((issue) => issue.severity === "high") ? "high" : "normal";
  const classes = ["odr-msg", `is-${speaker}`];
  if (!bubble.inWindow) classes.push("is-context");
  if (issues.length) classes.push("has-issue", `sev-${severity}`);
  if (flashId && flashId === bubble.id) classes.push("is-flash");
  const pickable = picking && bubble.fixable === true;
  if (picking) classes.push(pickable ? "is-pickable" : "is-unpickable");
  const text = String(bubble.text || "");
  // โหมดเลือกฟอง: ฟองที่ AI ชี้ยังมีวงสีและบอกตรง ๆ ว่า AI ชี้ข้อความนี้ (คนตรวจไม่หลงว่าต้องแตะฟองไหน)
  const cue = issues.length ? "AI ชี้ข้อความนี้ · แตะเพื่อแก้" : "✏️ แตะเพื่อแก้";
  const body = pickable
    ? el("button", {
        type: "button", class: `odr-bubble odr-bubble-pick${issues.length ? " is-ai-flagged" : ""}`,
        "aria-label": `ข้อความนี้ต้องปรับ${issues.length ? " (AI ชี้ไว้)" : ""}: ${text.slice(0, 80)}`,
        onclick: () => onPick?.(bubble),
      }, bubbleBody(bubble, text), el("span", { class: "odr-pick-cue", "aria-hidden": "true" }, cue))
    : el("p", { class: "odr-bubble" }, bubbleBody(bubble, text));
  return el("li", { class: classes.join(" "), "data-msg": String(bubble.id || "") },
    body,
    el("span", { class: "odr-meta" },
      el("span", { class: "odr-who" }, SPEAKER_LABEL[speaker]),
      bubble.at ? el("time", {}, fmtTime(bubble.at)) : null,
      bubble.automated ? el("span", { class: "odr-tag is-auto", title: "ข้อความที่ตั้งไว้ล่วงหน้า (ไม่ใช่ลูกแพรเขียนเอง) — แก้จากที่นี่ไม่ได้" }, "อัตโนมัติ")
        : bubble.proactive ? el("span", { class: "odr-tag" }, "ทักเอง") : null,
      el("span", { class: "odr-ref", "aria-hidden": "true" }, bubble.ref || ""),
    ),
    issues.map((issue) => issueNote(issue, {
      onVerdict, busyKeys, picking, expanded: expandedIssues?.has?.(issue.key), onToggleIssue,
    })),
  );
}

/**
 * แชทของห้องในช่วงนั้น — ฟองก่อนช่วง (บริบท) จาง + เส้นคั่น "ก่อนช่วงนี้"
 * showEarlier = กางฟองเก่าทั้งหมด (แชทยาวเกิน DAILY_RECENT_BUBBLES)
 */
export function dailyThread(detail, item, {
  picking = false, flashId = "", showEarlier = false, onShowEarlier = null, onPick = null, onVerdict = null, busyKeys = null,
  expandedIssues = null, onToggleIssue = null,
} = {}) {
  const bubbles = Array.isArray(detail?.bubbles) ? detail.bubbles : [];
  const issuesByKey = new Map((item?.issues || []).map((issue) => [issue.key, issue]));
  const hiddenCount = showEarlier ? 0 : Math.max(0, bubbles.length - DAILY_RECENT_BUBBLES);
  const shown = bubbles.slice(hiddenCount);
  const nodes = [];
  shown.forEach((bubble, index) => {
    const prev = shown[index - 1];
    if (bubble.inWindow && prev && !prev.inWindow) nodes.push(el("li", { class: "odr-divider", "aria-hidden": "true" }, el("span", {}, "แชทของช่วงนี้")));
    if (index === 0 && !bubble.inWindow) nodes.push(el("li", { class: "odr-divider is-before", "aria-hidden": "true" }, el("span", {}, "ก่อนช่วงนี้")));
    nodes.push(bubbleNode(bubble, { issuesByKey, picking, flashId, onPick, onVerdict, busyKeys, expandedIssues, onToggleIssue }));
  });
  return el("section", { class: `odr-thread${picking ? " is-picking" : ""}`, "aria-label": "แชทของห้องนี้ในช่วงที่ตรวจ" },
    detail?.truncated ? el("p", { class: "odr-thread-note" }, "แชทช่วงนี้ยาวมาก แสดง 200 ข้อความล่าสุด") : null,
    hiddenCount > 0
      ? el("button", { type: "button", class: "orv-more", "aria-expanded": "false", onclick: onShowEarlier }, `ดูข้อความก่อนหน้าอีก ${hiddenCount}`)
      : null,
    nodes.length ? el("ol", { class: "odr-msgs" }, nodes) : el("p", { class: "orv-thread-empty" }, "ห้องนี้ไม่มีข้อความในช่วงนี้"),
  );
}

function threadSkeleton() {
  return el("div", { class: "orv-thread is-loading", "aria-hidden": "true" },
    el("span", { class: "orv-skel is-in" }), el("span", { class: "orv-skel is-out" }), el("span", { class: "orv-skel is-in is-short" }));
}

/* ---------------------------------- การ์ดห้อง ---------------------------------- */

// ป้าย "AI สรุป" อยู่บรรทัดเดียวกับข้อความ (เดิมแยกบรรทัด กินความสูงทุกการ์ด)
function summaryLine(item) {
  if (item?.aiStatus !== "done") {
    return el("p", { class: "odr-summary is-unread" },
      el("span", { class: "odr-k" }, "AI ยังไม่ได้อ่านห้องนี้"),
      el("span", {}, "อ่านเองทั้งห้องนะคะ"));
  }
  return el("p", { class: "odr-summary" },
    el("span", { class: "odr-k" }, "AI สรุป"),
    el("span", {}, item.summary || (item.issueCount ? "มีจุดที่ควรดู" : "ตอบเรียบร้อย ไม่เจอจุดที่ควรปรับ")));
}

/**
 * การ์ดห้องหนึ่งใบ · detailState = "loading" | "ready" | "failed"
 * notice = { tone: "warn"|"info"|"danger", text, action?: { label, onClick } }
 */
export function dailyCard({
  item, detail = null, detailState = "loading", picking = false, flashId = "", showEarlier = false, notice = null,
  busyKeys = null, expandedIssues = null, onRetry = null, onChipTap = null, onVerdict = null, onPick = null, onShowEarlier = null,
  onToggleIssue = null,
}) {
  const tone = riskTone(item);
  const name = nameOf(item);
  const headingId = `odr-name-${String(item?.id || "x").replace(/[^\w-]/gu, "")}`;
  const issues = Array.isArray(item?.issues) ? item.issues : [];
  const shownIds = new Set((detail?.bubbles || []).map((bubble) => String(bubble.id)));
  const anchored = new Set(issues.filter((issue) => issue.messageId && shownIds.has(issue.messageId)).map((issue) => issue.key));
  const roomIssues = detailState === "ready" ? issues.filter((issue) => !anchored.has(issue.key)) : [];
  // แถวชิปด้านบน = ทางลัดไปฟองไกล ๆ — แชทสั้นที่ทุกปัญหาอยู่ใต้ฟองบนจอ/ในกล่อง "ทั้งห้อง" แล้ว = ไม่ซ้ำ (ประหยัดจอ)
  // แชทยาว หรือฟองที่ AI ชี้ถูกพับอยู่ใน "ดูข้อความก่อนหน้า" = มีแถวชิปไว้กระโดด (ไม่มีปัญหาผูกฟองเลย = ไม่มีที่ให้กระโดด)
  const rendered = (detail?.bubbles || []).slice(showEarlier ? 0 : Math.max(0, (detail?.bubbles || []).length - DAILY_RECENT_BUBBLES));
  const renderedIds = new Set(rendered.map((bubble) => String(bubble.id)));
  const chipsNeeded = detailState !== "ready" || (anchored.size > 0 && (rendered.length > SHORT_THREAD_BUBBLES
    || issues.some((issue) => anchored.has(issue.key) && !renderedIds.has(issue.messageId))));
  const body = detailState === "ready" && detail
    ? dailyThread(detail, item, { picking, flashId, showEarlier, onShowEarlier, onPick, onVerdict, busyKeys, expandedIssues, onToggleIssue })
    : detailState === "failed"
      ? el("div", { class: "orv-thread is-failed" },
          el("p", {}, "โหลดแชทของห้องนี้ไม่สำเร็จ"),
          onRetry ? el("button", { type: "button", class: "btn btn-outline btn-mini", onclick: onRetry }, "ลองโหลดอีกครั้ง") : null)
      : threadSkeleton();
  // ช่องทางแบบเฟส A: Facebook หรือ LINE (ชื่อสาขาดิบอย่าง "default" ไม่มีความหมายกับคนตรวจ)
  const facebook = /facebook/iu.test(`${item?.customer?.channelLabel || ""} ${detail?.room?.channelLabel || ""}`);
  return el("article", { class: `orv-card odr-card tone-${tone}`, "aria-labelledby": headingId, "data-item": String(item?.id || "") },
    el("span", { class: "orv-stamp is-keep", "aria-hidden": "true" }, "ดีแล้ว"),
    el("span", { class: "orv-stamp is-close", "aria-hidden": "true" }, "ต้องปรับ"),
    el("header", { class: "orv-card-head odr-head" },
      el("span", { class: "orv-avatar", "aria-hidden": "true" }, avatarInitial(name)),
      el("div", { class: "orv-who" },
        el("h2", { class: "orv-name", id: headingId, tabindex: "-1" }, name),
        el("p", { class: "orv-sub" },
          el("span", { class: `orv-chan ${facebook ? "is-fb" : "is-line"}` }, facebook ? "Facebook" : "LINE"),
          el("span", {}, `ลูกแพรตอบ ${Number(item?.aiMessages) || 0} ครั้ง`),
          item?.sampled ? el("span", { class: "odr-tag", title: "ห้องที่ระบบสุ่มมาวัดความแม่นของ AI — ต้องดูทีละห้อง" }, "สุ่มตรวจ") : null,
        ),
      ),
      riskBadge(item),
    ),
    el("div", { class: "odr-ai" },
      summaryLine(item),
      chipsNeeded ? issueChips(issues, { anchored, onChipTap }) : null,
      item?.offtopicHint
        ? el("p", { class: "odr-hint" }, `AI สังเกตว่าอาจนอกเรื่อง (${item.offtopicHint.label}) — ถ้าเข้าเกณฑ์จะไปรอที่แท็บรอยืนยันปิด`)
        : null,
      roomIssues.length
        ? el("div", { class: "odr-room-issues", "aria-label": "ปัญหาที่ AI ชี้ทั้งห้อง" },
            roomIssues.map((issue) => issueNote(issue, { onVerdict, busyKeys, picking, expanded: expandedIssues?.has?.(issue.key), onToggleIssue })))
        : null,
    ),
    notice
      ? el("div", { class: `orv-notice is-${notice.tone || "warn"} odr-notice`, role: "alert" },
          el("span", {}, notice.text),
          notice.action ? el("button", { type: "button", class: "odr-notice-btn", onclick: notice.action.onClick }, notice.action.label) : null)
      : null,
    picking ? el("p", { class: "odr-pick-hint", role: "status" }, "แตะข้อความของลูกแพรที่ควรปรับ") : null,
    body,
    el("footer", { class: "orv-card-foot" },
      el("span", {}, detail?.continuedAfterCutoff ? "คุยต่อหลังเวลาตัดรอบ (อยู่ในคิวพรุ่งนี้)" : ""),
      el("a", { class: "orv-open", href: detail?.room?.conversationHash || `#/c/${encodeURIComponent(String(item?.customerId || ""))}` }, "เปิดห้องเต็ม ›"),
    ),
  );
}

/* ------------------------------ แถบระดับการตรวจ ------------------------------ */

/** "ระดับตรวจ: ตรวจทุกห้อง · วันที่ 3/7 · ตรงกับ AI 7 วัน 88%" */
export function taperLine(taper) {
  if (!taper) return "";
  const parts = [`ระดับตรวจ: ${taper.levelLabel || "ตรวจทุกห้อง"}${taper.pinned ? " (ปักไว้)" : ""}`];
  const day = Number(taper.dayNumber) || 0;
  if (day > 0 && taper.inWarmup) parts.push(`วันที่ ${day}/${Number(taper.warmupDays) || 7}`);
  else if (day === 0) parts.push("เริ่มคืนนี้");
  const agreement = percent(taper.agreement7d);
  if (agreement) parts.push(`ตรงกับ AI 7 วัน ${agreement}`);
  return parts.join(" · ");
}

const SHORT_LEVEL = Object.freeze(["ตรวจทุกห้อง", "น่าห่วง + สุ่ม 20%", "น่าห่วง + สุ่ม 10%"]);

/** คำสั้นบนปุ่มของแถบความคืบหน้า — สัปดาห์แรกบอกวันที่ · หลังจากนั้นบอกระดับ */
export function taperShort(taper) {
  if (!taper) return "";
  const day = Number(taper.dayNumber) || 0;
  if (!taper.pinned && day === 0) return "เริ่มคืนนี้";
  if (!taper.pinned && taper.inWarmup && day > 0) return `วันที่ ${day}/${Number(taper.warmupDays) || 7}`;
  const level = Number.isInteger(taper.level) ? taper.level : 0;
  return `${SHORT_LEVEL[level] || SHORT_LEVEL[0]}${taper.pinned ? " (ปัก)" : ""}`;
}

/**
 * แถบความคืบหน้าแบบบาง ติดขอบบนขณะเลื่อน (รีวิว 13 ต.ค.: แถบระดับ + ชิปค้าง + ความคืบหน้า กินจอ ~200px เหนือการ์ด)
 *   ความคืบหน้า · ชิปวันค้าง (หนึ่งชิป — ที่เหลืออยู่ในแผงรายละเอียด) · ปุ่มระดับการตรวจ (กางแผงรายละเอียด)
 */
export function statusBar({ progressNode, taper = null, backlog = [], viewingOld = false, open = false, onToggle = null }) {
  const rows = (Array.isArray(backlog) ? backlog : []).filter((row) => Number(row?.remaining) > 0);
  const chip = viewingOld
    ? el("a", { class: "odr-backlog-chip is-home", href: dailyHref() }, "กลับคิวล่าสุด")
    : rows.length
      ? el("a", {
          class: "odr-backlog-chip", href: dailyHref(rows[0].batchId),
          "aria-label": `ยังค้าง ${rows.map((row) => `${row.dayLabel || row.dayKey} ${Number(row.remaining)} ห้อง`).join(" · ")}`,
        }, el("span", {}, "ค้าง"),
        // จอแคบ (≤360px) ซ่อนชื่อวัน ให้แถบอยู่บรรทัดเดียว — ชื่อเต็มอยู่ใน aria-label และแผงรายละเอียด
        el("span", { class: "odr-backlog-day" }, rows.length === 1 ? ` ${rows[0].dayLabel || rows[0].dayKey}` : ` ${rows.length} วัน`),
        el("strong", {}, String(rows.reduce((sum, row) => sum + Number(row.remaining), 0))))
      : null;
  const toggle = taper
    ? el("button", {
        type: "button", class: `odr-stats${open ? " is-open" : ""}`, "aria-expanded": open ? "true" : "false", "aria-controls": "odr-taper-panel",
        "aria-label": `${taperLine(taper)} — ${open ? "ซ่อนรายละเอียด" : "ดูรายละเอียด"}`, onclick: onToggle,
      }, el("span", { class: "odr-stats-text" }, taperShort(taper)), el("span", { class: "odr-stats-caret", "aria-hidden": "true" }, "⌄"))
    : null;
  return el("div", { class: "odr-bar" }, progressNode,
    chip ? el("nav", { class: "odr-backlog is-compact", "aria-label": "วันที่ยังตรวจไม่ครบ" }, chip) : null, toggle);
}

const PIN_OPTIONS = Object.freeze([[null, "อัตโนมัติ"], [0, "ทุกห้อง"], [1, "น่าห่วง + 20%"], [2, "น่าห่วง + 10%"]]);

/** แผงรายละเอียด: ระดับการตรวจเต็ม · วันที่ยังค้างทุกวัน · ตัวเลข 7 วัน · ปุ่มปักระดับ (เจ้าของเท่านั้น) */
export function taperPanel(taper, { canPin = false, busy = false, onPin = null, codes = {}, backlog = [] } = {}) {
  const needs = taper?.promoteNeeds || {};
  const perCode = Object.entries(taper?.perCode7d || {})
    .map(([code, row]) => ({ code, agree: Number(row?.agree) || 0, disagree: Number(row?.disagree) || 0 }))
    .filter((row) => row.agree + row.disagree > 0);
  return el("div", { class: "odr-taper", id: "odr-taper-panel" },
    el("p", { class: "odr-taper-line" }, taperLine(taper)),
    backlogChips(backlog),
    el("p", {}, `สัปดาห์แรกตรวจทุกห้อง หลังจากนั้นจะลดเหลือห้องน่าห่วง + สุ่ม เมื่อ 7 วันล่าสุดตรงกับ AI ตั้งแต่ ${percent(needs.minAgreement) || "90%"} จากอย่างน้อย ${Number(needs.minLabels) || 150} ห้อง และห้องสุ่มที่ AI ว่าปกติแต่จริง ๆ ต้องปรับไม่เกิน ${percent(needs.maxMissRate) || "5%"}`),
    el("ul", { class: "odr-taper-stats" },
      el("li", {}, el("strong", {}, String(Number(taper?.labels7d) || 0)), el("span", {}, "ห้องที่ติดป้าย 7 วัน")),
      el("li", {}, el("strong", {}, percent(taper?.agreement7d) || "–"), el("span", {}, "ตรงกับ AI")),
      el("li", {}, el("strong", {}, percent(taper?.missRate7d) || "–"), el("span", {}, "AI พลาด (ห้องสุ่ม)")),
    ),
    perCode.length
      ? el("p", { class: "odr-taper-codes" },
          `AI ชี้ถูก: ${perCode.map((row) => `${codes?.[row.code]?.label || row.code} ${row.agree}/${row.agree + row.disagree}`).join(" · ")}`)
      : null,
    canPin
      ? el("div", { class: "odr-pin", role: "group", "aria-label": "ปักระดับการตรวจ (เจ้าของ)" },
          PIN_OPTIONS.map(([value, label]) => {
            const active = value === null ? !taper?.pinned : taper?.pinned && taper?.pin === value;
            const button = el("button", {
              type: "button", class: `odr-pin-btn${active ? " is-active" : ""}`, "aria-pressed": active ? "true" : "false",
              onclick: () => onPin?.(value),
            }, label);
            button.disabled = Boolean(busy);
            return button;
          }))
      : null,
  );
}

/* ---------------------------------- ค้างตรวจ ---------------------------------- */

export function dailyHref(batchId = "") {
  return batchId ? `#/owner-review/daily?batch=${encodeURIComponent(String(batchId))}` : "#/owner-review/daily";
}

/** ชิปวันที่ยังตรวจไม่ครบ (เก็บไว้ 7 วัน) · viewingOld = กำลังดูวันเก่า → มีลิงก์กลับคิวล่าสุด */
export function backlogChips(backlog, { viewingOld = false } = {}) {
  const rows = (Array.isArray(backlog) ? backlog : []).filter((row) => Number(row?.remaining) > 0);
  if (!rows.length && !viewingOld) return null;
  return el("nav", { class: "odr-backlog", "aria-label": "วันที่ยังตรวจไม่ครบ" },
    rows.length ? el("span", { class: "odr-backlog-k" }, "ยังค้าง") : null,
    rows.map((row) => el("a", { class: "odr-backlog-chip", href: dailyHref(row.batchId) },
      el("span", {}, row.dayLabel || row.dayKey), el("strong", {}, `${Number(row.remaining)} ห้อง`))),
    viewingOld ? el("a", { class: "odr-backlog-chip is-home", href: dailyHref() }, "กลับคิวล่าสุด") : null,
  );
}

/* ---------------------------------- หน้าสถานะ ---------------------------------- */

function nextLine(nextDailyAt, now) {
  const when = scanWhen(nextDailyAt, now);
  return when ? el("p", { class: "orv-empty-next" }, el("span", {}, "คิวถัดไป"), el("strong", {}, when)) : null;
}

/** ยังไม่มีคิวที่พร้อม (ก่อนคืนแรก / หลังลบตาม 180 วัน) */
export function noBatchScreen({ nextDailyAt, now = Date.now() }) {
  return el("section", { class: "orv-empty odr-state", "aria-labelledby": "odr-state-title" },
    el("h2", { id: "odr-state-title", class: "orv-empty-title", tabindex: "-1" }, "ยังไม่มีคิวตรวจแชท"),
    el("p", { class: "odr-state-copy" },
      "ทุกคืนสองทุ่ม ลูกแพรจะรวมแชทของวันนั้นมาไว้ที่นี่ให้", el("span", { class: "orv-nowrap" }, "พี่ง้วง"),
      "และ", el("span", { class: "orv-nowrap" }, "ชมพู่"), "ตรวจทีละห้อง"),
    nextLine(nextDailyAt, now),
  );
}

/** กำลังเตรียมคิว — AI อ่านไปแล้วกี่ห้อง */
export function buildingBanner(building) {
  if (!building) return null;
  const total = Math.max(0, Number(building.total) || 0);
  const done = Math.min(total, Math.max(0, Number(building.done) || 0));
  // CSP ห้าม style="" แบบ inline — ตั้งค่าผ่าน CSSOM (style.setProperty) เหมือนแถบความคืบหน้าของเฟส A
  const fill = el("span", { class: "odr-building-fill" });
  fill.style.setProperty("--odr-building", total ? (done / total).toFixed(3) : "0");
  return el("div", { class: "odr-building", role: "status" },
    el("span", { class: "odr-building-copy" },
      el("strong", {}, `กำลังเตรียมคิวของ ${building.dayLabel || building.dayKey}`),
      el("span", {}, total ? `AI อ่านแล้ว ${done} / ${total} ห้อง` : "กำลังรวบรวมห้อง…")),
    el("span", { class: "odr-building-track", "aria-hidden": "true" }, fill),
  );
}

/** ตรวจครบแล้ว — ตัวเลขของรอบนี้ + ขอบคุณ + ค้างวันอื่น + เวลาคิวถัดไป */
export function doneScreen({ batch, counts, lessonsMade = 0, lessonsApplyNow = false, nextDailyAt, backlog = null, now = Date.now() }) {
  const empty = !counts.total;
  const tiles = [
    ["ดีแล้ว", counts.good, "is-good"],
    ["ต้องปรับ", counts.needsFix, "is-fix"],
    lessonsMade > 0 ? [lessonsApplyNow ? "บทเรียนใหม่ (ใช้แล้ว)" : "บทเรียนจากรอบนี้", lessonsMade, "is-lesson"] : null,
  ].filter(Boolean);
  return el("section", { class: "orv-empty odr-done", "aria-labelledby": "odr-state-title" },
    el("span", { class: "odr-done-mark", "aria-hidden": "true" }, empty ? "☕" : "🎉"),
    el("h2", { id: "odr-state-title", class: "orv-empty-title", tabindex: "-1" },
      empty ? `${batch?.dayLabel || "วันนี้"} ไม่มีแชทที่ลูกแพรตอบ` : `ตรวจครบทุกห้องของ ${batch?.dayLabel || "วันนี้"} แล้ว`),
    empty ? null : el("ul", { class: "odr-tally", "aria-label": "สรุปรอบนี้" },
      tiles.map(([label, value, cls]) => el("li", { class: cls }, el("strong", {}, String(Number(value) || 0)), el("span", {}, label)))),
    empty ? null : el("p", { class: "odr-thanks" }, "ขอบคุณที่ช่วยดูแชทของลูกแพรวันนี้นะคะ ทุกห้องที่ชี้ไว้ ลูกแพรเก็บไปเรียนต่อค่ะ 💗"),
    backlog,
    nextLine(nextDailyAt, now),
  );
}

/** โหลดคิวไม่สำเร็จ / ไม่พบวันนั้น */
export function errorScreen({ notFound = false, onRetry = null }) {
  return el("section", { class: "orv-empty odr-state", "aria-labelledby": "odr-state-title" },
    el("h2", { id: "odr-state-title", class: "orv-empty-title", tabindex: "-1" }, notFound ? "ไม่พบคิวของวันนั้น" : "โหลดคิวตรวจแชทไม่สำเร็จ"),
    el("p", { class: "odr-state-copy" }, notFound ? "คิวอาจเลย 180 วันแล้ว หรือถูกลบตามสิทธิ์ให้ลืม" : "เช็กอินเทอร์เน็ตแล้วลองอีกครั้งนะคะ"),
    notFound
      ? el("a", { class: "odr-backlog-chip is-home", href: dailyHref() }, "ไปคิวล่าสุด")
      : el("button", { type: "button", class: "btn btn-outline", onclick: onRetry }, "ลองอีกครั้ง"),
  );
}
