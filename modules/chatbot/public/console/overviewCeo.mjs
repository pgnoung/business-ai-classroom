// overviewCeo.mjs — ภาพรวมแบบ "วันนี้เป็นยังไง" สำหรับพี่ง้วง (CEO) — 28 ก.ย. 2026
//
// คำสั่งพี่ง้วง: "หลายระบบดูยาก ตัวเลขเยอะ อยากให้ CEO ดูง่าย visual สวย ๆ"
// หลักที่ใช้:
// - ลูกแพรเป็นคนเล่า: ทักทาย + ประโยคเดียวสรุปเรื่องที่สำคัญที่สุด + สีหน้าตามสถานการณ์จริง
// - เงินรั่วสองทางที่ใหญ่ที่สุดจากข้อมูลจริงเดือนกันยายนต้องเห็นทันที (ไม่ต้องกางอะไร):
//     ลูกค้ารอคนตอบ (พูดคนสุดท้ายแล้วไม่มีใครตอบ) และลูกค้าร้อนที่ยังไม่มีคนจริงทัก
//   รายชื่อแบบเห็นหน้า + ช่องทาง + รอนานเท่าไร + ข้อความสั้น แตะแล้วเข้าห้องทันที
// - ประโยคภาษาคนทีละบรรทัด หนึ่งบรรทัดหนึ่งตัวเลข · เส้นทางลูกค้า เย็น → อุ่น → ร้อน → ซื้อแล้ว
// ข้อมูลมาจาก overview / overview/attention / inbox counts / kpi / roas — ไม่มีการคำนวณเงินใหม่
// ตัวเลขเงินระดับบริษัท (ROAS/กำไร) โผล่เฉพาะผู้มี finance.view ซึ่งเซิร์ฟเวอร์กันซ้ำอีกชั้นอยู่แล้ว
import { agentLabel, el, isGeneric, timeAgo } from "./dom.mjs";
import { avatarEl, fmtThb } from "./ui.mjs";
import { sparkline } from "./charts.mjs";
import { icon } from "./icons.mjs";
import { isLukpraeTheme, moodPortrait } from "./lukpraeArt.mjs";
import { shortDuration } from "./overviewTeam.mjs";
import { aiStateBadge, fbClosedBadge, RELAY_TONE, relayStatusLabel, roomHash, rowQuickActions, spanLabel } from "./triage.mjs";

// spanLabel ย้ายไป triage.mjs (หน้าแชทใช้ร่วม) — ส่งต่อชื่อเดิมให้ผู้เรียกเดิม
export { spanLabel };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const QUIET_WARN_MIN = 180;
const LONG_WAIT_MS = 30 * MIN;
export const LIST_PREVIEW = 5;

const n = (value) => Number(value || 0).toLocaleString("th-TH");
const bangkokHour = (ms) => new Date(Number(ms) + 7 * HOUR).getUTCHours();

// ประโยคของลูกแพรเคยขึ้นบรรทัดใหม่ระหว่าง "11" กับ "วัน" อ่านสะดุด — เว้นวรรคแบบไม่ตัดบรรทัด
const NBSP = "\u00a0";

export function greetingFor(nowMs, name = "") {
  const hour = bangkokHour(nowMs);
  const part = hour >= 5 && hour < 12 ? "สวัสดีตอนเช้าค่ะ"
    : hour >= 12 && hour < 17 ? "สวัสดีตอนบ่ายค่ะ"
      : hour >= 17 && hour < 21 ? "สวัสดีตอนเย็นค่ะ" : "ดึกแล้วนะคะ";
  return name ? `${part} ${name}` : part;
}

/**
 * สีหน้า + ประโยคสรุปของลูกแพร — เลือกเรื่องที่เสียเงิน/เสียลูกค้ามากที่สุดก่อนเสมอ
 * (หยุดทั้งระบบ > สลิปน่าสงสัย > ลูกค้ารอนาน > ลูกค้าร้อนไม่มีคนทัก > เงียบผิดปกติ > รอคำตอบ
 *  > คิวรอทีม > ห้องระบบเก่า > ขายได้ > ปกติ)
 */
export function pickMood({ aiPaused = false, suspectSlips = 0, waiting = 0, oldestWaitMs = 0, hotQuiet = 0,
  quietDaytime = false, needsCount = 0, awaitingLegacy = 0, ordersToday = 0, hot = 0 } = {}) {
  if (aiPaused) {
    return { mood: "pout", tone: "alert", headline: "ตอนนี้ลูกแพรถูกพักการตอบทั้งระบบอยู่ค่ะ ลูกค้าที่ทักมาต้องให้ทีมตอบเองก่อนนะคะ" };
  }
  if (suspectSlips > 0) {
    return { mood: "surprised", tone: "alert", headline: `วันนี้มีสลิปน่าสงสัย ${n(suspectSlips)} ใบค่ะ ตรวจกับบัญชีจริงก่อนยืนยันยอดนะคะ` };
  }
  if (waiting > 0 && oldestWaitMs >= LONG_WAIT_MS) {
    return { mood: "surprised", tone: "alert", headline: `มีลูกค้ารอคนตอบ ${n(waiting)}${NBSP}ห้อง นานสุด ${spanLabel(oldestWaitMs)}ค่ะ ช่วยตอบห้องบนสุดก่อนนะคะ` };
  }
  if (hotQuiet > 0) {
    // 29 ก.ย. 2026: ลูกแพรตอบห้องเหล่านี้ไปแล้ว — ที่ขาดคือทีมงานทักต่อ (Facebook ระบบทักเองได้แค่ 24 ชม.)
    // 3 พ.ย. 2026: รายการนี้เป็นไม้ต่อทุกห้อง (ไม่ใช่เฉพาะสนใจสูง) — ลูกแพรคุยจบแล้ว ถึงตาทีมคุยต่อ
    return { mood: "thinking", tone: "warn", headline: `ลูกแพรคุยจบแล้ว ${n(hotQuiet)}${NBSP}ห้อง รอทีมเข้าไปคุยต่อค่ะ ได้ยินเสียงคนจริงแล้วลูกค้าจะมั่นใจขึ้นนะคะ` };
  }
  if (quietDaytime) {
    return { mood: "thinking", tone: "warn", headline: "ลูกค้าเงียบไปนานผิดปกติค่ะ ลองเช็กว่าระบบยังรับข้อความจาก LINE อยู่ไหมนะคะ" };
  }
  if (waiting > 0) {
    return { mood: "thinking", tone: "warn", headline: `มีลูกค้าเพิ่งทักมารอคำตอบ ${n(waiting)} ห้องค่ะ` };
  }
  if (needsCount > 0) {
    return { mood: "thinking", tone: "warn", headline: `มี ${n(needsCount)} ห้องรอทีมดูแลอยู่ค่ะ ห้องที่เหลือลูกแพรดูแลให้แล้วนะคะ` };
  }
  if (awaitingLegacy > 0) {
    return { mood: "thinking", tone: "warn", headline: `มีห้องจากระบบเก่ารอยืนยัน ${n(awaitingLegacy)} ห้องค่ะ ยืนยันแล้วลูกแพรจะดูแลต่อให้นะคะ` };
  }
  if (ordersToday > 0) {
    return { mood: "wink", tone: "good", headline: `วันนี้ปิดได้ ${n(ordersToday)} ออเดอร์แล้วค่ะ ทีมเก่งมากเลย` };
  }
  return {
    mood: "smile", tone: "calm",
    headline: hot > 0
      ? `ทุกห้องมีคนดูแลแล้วค่ะ วันนี้มีลูกค้าสนใจสูง ${n(hot)} คนรอให้คุยต่อนะคะ`
      : "ทุกห้องมีคนดูแลแล้วค่ะ วันนี้เรียบร้อยดี",
  };
}

// สรุปข้อมูลดิบเป็นก้อนเดียวที่ส่วนอื่นของหน้าใช้ — แยกไว้เพื่อให้เทสต์ตรวจเงื่อนไขได้ตรง ๆ
export function summarizeDay({ data = {}, counts = null, attention = null, kpi = null, now = Date.now() } = {}) {
  const s = data.stats || {};
  const lastIn = Number(data.lastInboundAt) || 0;
  const quietMin = lastIn ? Math.floor((now - lastIn) / MIN) : null;
  const hour = bangkokHour(now);
  const fair = kpi?.ok ? kpi.speed?.workingDays : null;
  const waiting = attention?.waiting && typeof attention.waiting === "object" ? attention.waiting : { total: 0, over24: 0, oldestWaitMs: 0, rooms: [] };
  const hotQuiet = attention?.hotQuiet && typeof attention.hotQuiet === "object" ? attention.hotQuiet : { total: 0, rooms: [] };
  const day = {
    stats: s,
    counts: counts && typeof counts === "object" ? counts : null,
    waiting: {
      total: Number(waiting.total) || 0, over24: Number(waiting.over24) || 0,
      oldestWaitMs: Number(waiting.oldestWaitMs) || 0, rooms: Array.isArray(waiting.rooms) ? waiting.rooms : [],
    },
    // 3 พ.ย. 2026: ไม้ต่อจากลูกแพร — overdue/due/ontrack มีเฉพาะเซิร์ฟเวอร์รุ่นใหม่ (null = ถ้อยคำเดิม)
    hotQuiet: {
      total: Number(hotQuiet.total) || 0, rooms: Array.isArray(hotQuiet.rooms) ? hotQuiet.rooms : [],
      teamRate: hotQuiet.teamRate && typeof hotQuiet.teamRate === "object" ? hotQuiet.teamRate : null,
      overdue: hotQuiet.overdue == null ? null : Number(hotQuiet.overdue) || 0,
      due: hotQuiet.due == null ? null : Number(hotQuiet.due) || 0,
      ontrack: hotQuiet.ontrack == null ? null : Number(hotQuiet.ontrack) || 0,
    },
    attentionBroken: attention?.__failed ? String(attention.__failed) : "",
    lastIn,
    quietMin,
    quiet: quietMin !== null && quietMin >= QUIET_WARN_MIN,
    needsCount: Number(counts?.needs ?? s.needsHuman ?? 0) || 0,
    hot: Number(counts?.hot ?? s.hotCustomers ?? 0) || 0,
    ordersToday: Number(data.orders?.todayCount ?? 0) || 0,
    awaitingLegacy: Number(data.roomsAwaitingLegacyConfirm) || 0,
    aiSpeedMs: fair?.ai?.medianMs ?? null,
    teamSpeedMs: fair?.human?.medianMs ?? null,
  };
  day.mood = pickMood({
    aiPaused: data.aiPaused === true,
    suspectSlips: Number(s.suspectSlipsToday) || 0,
    waiting: day.waiting.total,
    oldestWaitMs: day.waiting.oldestWaitMs,
    hotQuiet: day.hotQuiet.total,
    // ตีสองลูกค้าเงียบเป็นเรื่องปกติ — เตือนเฉพาะช่วงที่ปกติมีคนทัก
    quietDaytime: day.quiet && hour >= 9 && hour < 22,
    needsCount: day.needsCount,
    awaitingLegacy: day.awaitingLegacy,
    ordersToday: day.ordersToday,
    hot: day.hot,
  });
  return day;
}

/* ------------------------------ ส่วนหัว: ลูกแพรเล่า ------------------------------ */

function heroNotes(data, day) {
  const notes = [];
  // audit 2026-08-26: ห้องที่ถูกปิด AI เองจากการจับคู่ชื่อระบบเก่า จะเงียบต่อไปแม้เปิด AI ทั้งระบบแล้ว
  // ต้องเห็นตัวเลขนี้ก่อน ไม่งั้นลูกค้ากลุ่มนี้จะไม่มีใครตอบโดยไม่มีใครรู้ (ข้อความเดิมจากการ์ดเก่า)
  if (day.awaitingLegacy > 0) {
    const rooms = Array.isArray(data.roomsAwaitingLegacyConfirmList) ? data.roomsAwaitingLegacyConfirmList : [];
    notes.push(el("div", { class: "ov-note is-warn" },
      el("p", { class: "ov-note-title" }, `รอยืนยันห้องระบบเก่า ${n(day.awaitingLegacy)} ห้อง`),
      el("p", { class: "ov-note-text" },
        "ห้องเหล่านี้ถูกปิด AI ไว้เองจากการจับคู่ชื่อ — เปิด AI ทั้งระบบแล้วก็ยังเงียบ กดชื่อเพื่อเข้าไปยืนยัน"),
      // v1.4.49 (คำสั่งเจ้าของ): แจ้งเตือนต้องกดเข้าห้องแชทได้ ไม่ใช่โชว์เฉย ๆ
      rooms.length ? el("div", { class: "stat-links" },
        ...rooms.map((room) => el("a", { class: "stat-room-link", href: `#/c/${encodeURIComponent(room.id)}` }, `💬 ${room.name}`))) : null,
    ));
  }
  // audit 2026-08-26 (วิกฤต): webhook ตาย = ข้อความลูกค้าหายถาวร การ์ดนี้แยก "เงียบผิดปกติ" ออกจาก "ลูกค้าน้อย"
  if (day.quiet) {
    notes.push(el("div", { class: "ov-note is-warn" },
      el("p", { class: "ov-note-title" }, "เงียบนานผิดปกติ — ตรวจว่าระบบยังรับข้อความจาก LINE อยู่จริงไหม"),
    ));
  }
  return notes.length ? el("div", { class: "ov-notes" }, notes) : null;
}

function pulseLine(day) {
  const ago = day.lastIn ? timeAgo(day.lastIn) : "";
  const text = !day.lastIn ? "ลูกค้าทักล่าสุด — ยังไม่มีข้อความเข้า"
    : /นาที|ชม\./u.test(ago) ? `ลูกค้าทักล่าสุด ${ago}ที่แล้ว` : `ลูกค้าทักล่าสุด ${ago}`;
  return el("p", { class: `ov-pulse${day.quiet ? " is-quiet" : ""}` },
    el("span", { class: "ov-pulse-dot", "aria-hidden": "true" }),
    text,
  );
}

export function heroDialog({ state, data, day }) {
  const lukprae = isLukpraeTheme();
  const paused = data.aiPaused === true;
  const agent = String(state.branding?.agent || "").trim();
  const name = String(state.me?.displayName || state.me?.username || "").trim();
  const muse = lukprae
    ? moodPortrait(day.mood.mood, { size: "xl" })
    : el("span", { class: "ov-mark", "aria-hidden": "true" }, state.branding?.mark || "FD");
  return el("div", { class: `ov-dialog is-${day.mood.tone}` },
    el("div", { class: "ov-muse-wrap" },
      muse,
      el("span", {
        class: `ov-status ${paused ? "is-paused" : "is-on"}`,
        title: paused ? "ลูกแพรถูกพักการตอบทั้งระบบ" : "ลูกแพรกำลังดูแลแชท",
      }, paused ? "พักอยู่" : "ออนไลน์"),
    ),
    el("div", { class: "ov-dialog-body" },
      el("p", { class: "ov-nametag" },
        el("span", { class: "ov-nametag-name" }, lukprae ? "ลูกแพร"
          : (isGeneric(state) ? agentLabel(state) : (agent || state.branding?.name || "ผู้ช่วย"))),
        el("span", { class: "ov-nametag-role" }, lukprae ? "พี่สาวคนโต · ดูแลหน้าบ้าน" : "สรุปวันนี้"),
      ),
      el("p", { class: "ov-hello" }, greetingFor(Date.now(), name)),
      el("h2", { class: "ov-headline" }, day.mood.headline),
      heroNotes(data, day),
      pulseLine(day),
    ),
  );
}

/* ------------------------------ วันนี้ในไม่กี่บรรทัด ------------------------------ */

function line({ key, glyph, lead, value, unit = "", sub = "", href = null, onclick = null, tone = "", extra = null }) {
  const inner = [
    el("span", { class: "ov-line-icon", "aria-hidden": "true" }, icon(glyph, { size: 20 })),
    el("span", { class: "ov-line-text" },
      el("span", { class: "ov-line-lead" }, lead),
      el("span", { class: "ov-line-figure" },
        el("strong", { class: "ov-line-value" }, String(value)),
        unit ? el("span", { class: "ov-line-unit" }, unit) : null,
      ),
      sub ? el("span", { class: "ov-line-sub" }, sub) : null,
    ),
    extra,
    href || onclick ? el("span", { class: "ov-line-go", "aria-hidden": "true" }, icon("arrow", { size: 18 })) : null,
  ];
  const target = href
    ? el("a", { class: "ov-line-link", href }, inner)
    : onclick ? el("button", { class: "ov-line-link", type: "button", onclick }, inner) : el("div", { class: "ov-line-link" }, inner);
  return el("li", { class: `ov-line is-${key}${tone ? ` tone-${tone}` : ""}` }, target);
}

// ปุ่มในบรรทัดสรุปพาไปที่รายชื่อด้านล่าง (ไม่ใช้ #anchor — hash เป็นเส้นทางของ router)
function scrollToId(id) {
  const target = document.getElementById(id);
  if (!target) return;
  const calm = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  target.scrollIntoView?.({ behavior: calm ? "auto" : "smooth", block: "start" });
  target.querySelector?.("a, button")?.focus?.({ preventScroll: true });
}

export function todayLines({ data, day, kpiOk, roas, canFinance, openTeam }) {
  const s = day.stats;
  const talked = s.activeCustomersToday;
  const orders = data.orders || null;
  const items = [
    line({
      key: "talk", glyph: "people", href: "#/chat",
      lead: talked == null ? "วันนี้ลูกค้าทักมา" : "วันนี้คุยกับลูกค้า",
      value: n(talked ?? s.inboundToday ?? 0), unit: talked == null ? "ข้อความ" : "คน",
      sub: `ลูกค้าใหม่ ${n(s.newCustomersToday)} คน · ข้อความเข้า ${n(s.inboundToday)}`,
      extra: sparkline(data.series, "inbound", { label: "จำนวนข้อความเข้า 14 วันล่าสุด" }),
    }),
    line({
      key: "wait", glyph: "hourglass", onclick: () => scrollToId("ov-waiting"),
      tone: day.waiting.total > 0 ? "attention" : "",
      lead: "ลูกค้ารอคนตอบ", value: n(day.waiting.total), unit: "ห้อง",
      sub: day.waiting.total > 0 ? `นานสุด ${spanLabel(day.waiting.oldestWaitMs)} · ดูรายชื่อด้านล่าง` : "ไม่มีใครค้างรอคำตอบ",
    }),
    line({
      key: "hot", glyph: "flame", onclick: () => scrollToId("ov-hotquiet"),
      tone: day.hotQuiet.total > 0 ? "attention" : "",
      lead: "ไม้ต่อจากลูกแพร รอทีมคุยต่อ", value: n(day.hotQuiet.total), unit: "ห้อง",
      sub: day.hotQuiet.overdue != null
        ? `เกินเส้นตาย 6 ชม. ${n(day.hotQuiet.overdue)} ห้อง · ลูกแพรคุยจบแล้ว ลูกค้าเงียบ 2 ชม.+ ยังไม่มีทีมต่อ`
        : `ลูกแพรตอบแล้ว ยังไม่มีทีมทัก · คะแนน 8+ เงียบ 1–7 วัน · สนใจสูงทั้งหมด ${n(day.hot)} คน`,
    }),
    line({
      key: "sold", glyph: "bag", href: "#/orders",
      tone: day.ordersToday > 0 ? "good" : "",
      lead: "ขายได้วันนี้", value: orders ? n(orders.todayCount) : "—", unit: "ออเดอร์",
      sub: orders
        ? `เดือนนี้ ฿${fmtThb(orders.monthRevenue)} จาก ${n(orders.monthConfirmedCount)} ออเดอร์${orders.openDrafts ? ` · ร่างรอตรวจ ${n(orders.openDrafts)}` : ""}`
        : "ยังอ่านค่าไม่ได้",
    }),
    kpiOk && day.aiSpeedMs != null ? line({
      key: "speed", glyph: "bolt", href: "#/kpi",
      lead: "ลูกแพรตอบลูกค้าใน", value: shortDuration(day.aiSpeedMs),
      sub: `ค่ากลาง 7 วันในเวลาทำการ · ทีมงาน ${shortDuration(day.teamSpeedMs)}`,
    }) : null,
  ];
  return el("section", { class: "ov-today", "aria-label": "วันนี้โดยสรุป" },
    el("ol", { class: "ov-lines" }, items),
    // 7 ต.ค. 2026: แถบ ROAS บรรทัดเดียวย้ายไปอยู่ในการ์ดค่าแอดใบใหญ่บนสุด (overviewAdSpend.mjs)
  );
}

/* ------------------------------ เงินรั่ว: รายชื่อที่ต้องลงมือ ------------------------------ */

const VALUE_CHIP = { money: ["เรื่องเงิน", "is-money"], hot: ["สนใจสูง", "is-hot"], warm: ["กำลังพิจารณา", "is-warm"] };

// 29 ก.ย. 2026 (พี่ง้วง: "บางแชท AI ตอบไปแล้ว ทำไมถึงยังขึ้น"): บอกบนแถวเลยว่าลูกแพรทำอะไรไปแล้ว และทีมต้องทำอะไรต่อ
function hotFollowupMeta(room) {
  const replies = Number(room.aiReplies) || 0;
  const did = el("span", { class: "ov-q-note" }, (room.teamTalkedBefore ? "เคยคุยกับทีมแล้ว · รอบล่าสุด " : "")
    + (replies > 1 ? `ลูกแพรตอบ + ทักตามแล้ว ${replies} ข้อความ` : "ลูกแพรตอบแล้ว"));
  if (room.fbHumanUntil == null) return [did, el("span", { class: "ov-q-note" }, "ทีมทักต่อจากคอนโซลหรือกด YOLO ได้")];
  const left = Math.max(0, Number(room.fbHumanUntil) - Date.now());
  return [did, el("span", { class: `ov-q-note${left < DAY ? " is-urgent" : ""}` }, `FB ทักอัตโนมัติไม่ได้แล้ว · ตอบใน Business Suite ได้อีก ${spanLabel(left)}`)];
}

// 29 ก.ย. 2026 (พี่ง้วง: "แอดมินจริง ๆ ได้ขุดลูกค้าบ่อยมั้ย % rate กี่ %"): นับตอนที่ลูกแพรตอบแล้วลูกค้าเงียบเกินวัน
// ว่าทีมกลับไปทักต่อกี่ห้อง — ไม่ใช่ "ห้องที่ทีมเคยพิมพ์" ซึ่งดูสูงแต่หลอก (hotFollowupRate.mjs)
// 3 พ.ย. 2026 ไม้ต่อ (src/relayBaton.mjs): % ไม้ที่ทีมต่อทันเส้นตาย 6 ชม.ทำการ (และทันเป้า 3 ชม.) — ตัวหารคือไม้ที่
// ตัดสินแล้ว (ลูกค้ากลับมาเองก่อนเส้นตาย/ยังไม่ถึงเส้นตาย ไม่นับ) · รายละเอียดเต็มอยู่หน้าผลงาน
// แถวจากเซิร์ฟเวอร์รุ่นเก่า (มีแต่ touched/entered) ใช้ถ้อยคำเดิม
function teamRateNote(rate) {
  if (rate?.relay) {
    const r = rate.relay;
    if (!(Number(r.decided) > 0)) return null;
    return el("span", {
      class: "ov-sec-note ov-team-rate",
      title: "นับไม้ต่อ 7 วันล่าสุด: ลูกแพรคุยจบ ลูกค้าเงียบ 2 ชม. แล้วทีมเข้าไปคุยต่อภายในกี่ชั่วโมงทำการ",
    }, `ทีมต่อทัน 6 ชม. ${n(r.within6Pct)}% · ทัน 3 ชม. ${n(r.within3Pct)}% (ต่อแล้ว ${n(r.touched)}/${n(r.decided)} ไม้ · ${n(rate.windowDays || 7)} วัน)`);
  }
  if (!rate || !(Number(rate.entered) > 0)) return null;
  const pct = Number.isFinite(Number(rate.ratePct)) ? ` (${n(rate.ratePct)}%)` : "";
  const lost = Number(rate.lost) > 0 ? ` · หลุดเวลาตอบ FB ${n(rate.lost)}` : "";
  return el("span", { class: "ov-sec-note ov-team-rate", title: "นับห้องลูกค้าสนใจสูงที่ลูกแพรตอบแล้วลูกค้าเงียบเกิน 1 วัน ว่าทีมกลับไปทักต่อก่อนลูกค้ากลับมาเองกี่ห้อง" },
    `ทีมทักต่อ ${n(rate.windowDays || 7)} วันล่าสุด ${n(rate.touched)}/${n(rate.entered)} ห้อง${pct}${lost}`);
}

// 28 ก.ย. 2026 (พี่ง้วง: กดห้องค้างแล้วเข้าห้องแชทปกติ เคสอื่นต้อง back กลับมาเอง): แถว "รอตอบ" พาเข้า
// หน้าแชทแบบคิวรอตอบ (#/chat/waiting/<ห้อง>) — ชิปรอตอบเปิดค้าง ห้องนั้นเปิดอยู่ ทำเสร็จแล้วไปห้องถัดไปเอง
// และมีปุ่มลัด ✓ เสร็จสิ้น / สแปม บนแถวสำหรับเคลียร์ห้องที่จบแล้วโดยไม่ต้องเปิด
function roomRow(room, { kind, actions = null }) {
  // avatarEl รับหน้าตาแถวของ inbox — แปลงห้องจาก API ให้เป็นรูปเดียวกัน (วงแหวนคะแนน + รูป/ตัวอักษรแรก)
  const avatar = avatarEl({
    line_user_id: room.id, known_name: room.name, picture_url: room.pictureUrl,
    last_score: room.score, ai_enabled: room.aiOn ? 1 : 0,
  }, { size: "sm" });
  const chip = VALUE_CHIP[room.value];
  const isWaiting = kind === "waiting";
  const ms = isWaiting ? room.waitMs : room.silentMs;
  const relay = !isWaiting && room.relayStatus ? room.relayStatus : null;
  const tone = isWaiting
    ? (ms >= DAY ? "urgent" : ms >= LONG_WAIT_MS ? "warn" : "calm")
    : relay ? RELAY_TONE[relay] : (ms >= 5 * DAY ? "urgent" : ms >= 3 * DAY ? "warn" : "calm");
  // AI ปิดเพราะใคร + Facebook ตอบจากคอนโซลไม่ได้แล้ว — บรรทัดเดียวใต้ข้อความตัวอย่าง
  const meta = isWaiting
    ? [aiStateBadge(room, { withReason: true }), room.fbReplyClosed ? fbClosedBadge() : null].flat().filter(Boolean)
    : hotFollowupMeta(room);
  return el("li", { class: `ov-q-item${isWaiting && actions ? " has-actions" : ""}` },
    // 30 ก.ย. 2026: แถวลูกค้าร้อนพาเข้าคิว "รอทีมทักต่อ" — พิมพ์คุยเสร็จแล้วห้องถัดไปเปิดเอง
    el("a", { class: "ov-q-row", href: roomHash(isWaiting ? "waiting" : "hotfollow", room.id) },
      avatar,
      el("span", { class: "ov-q-main" },
        el("span", { class: "ov-q-top" },
          el("span", { class: "ov-q-name" }, room.name),
          chip ? el("span", { class: `ov-q-value ${chip[1]}` }, room.value === "money" ? chip[0] : `${chip[0]} ${room.score ?? ""}`.trim()) : null,
        ),
        el("span", { class: "ov-q-preview" }, room.preview ? `“${room.preview}”` : "—"),
        meta.length ? el("span", { class: "ov-q-meta" }, meta) : null,
      ),
      el("span", { class: "ov-q-side" },
        el("span", { class: `ov-q-wait tone-${tone}` },
          relay ? relayStatusLabel(relay, room.workElapsedMs) : `${isWaiting ? "รอ" : "เงียบ"} ${spanLabel(ms)}`),
        el("span", { class: "ov-q-channel" }, room.channelName || room.channelId),
      ),
    ),
    isWaiting && actions
      ? rowQuickActions({ api: actions.api, toast: actions.toast, room, onDone: actions.onChanged })
      : null,
  );
}

/**
 * รายชื่อห้องที่เงินกำลังรั่ว — kind "waiting" (ลูกค้ารอคนตอบ) หรือ "hot" (ร้อนแต่ไม่มีคนทัก)
 * โชว์ 5 ห้องแรกที่มูลค่าสูงสุด กด "ดูเพิ่ม" กางได้ถึง 20 ห้องในหน้าเดิม ไม่ต้องไปหน้าอื่น
 * actions = { api, toast, onChanged } → ปุ่มลัด ✓ เสร็จสิ้น / สแปม บนแถวรอตอบ
 */
export function attentionSection({ kind, day, expanded = false, onToggle = null, actions = null }) {
  const isWaiting = kind === "waiting";
  const list = isWaiting ? day.waiting : day.hotQuiet;
  const rooms = expanded ? list.rooms : list.rooms.slice(0, LIST_PREVIEW);
  const title = isWaiting ? "ลูกค้ารอคนตอบตอนนี้" : "ไม้ต่อจากลูกแพร — ถึงตาทีมคุยต่อ";
  const summary = isWaiting
    ? (list.total
      ? `${n(list.total)} ห้อง${list.over24 ? ` · ค้างเกินวัน ${n(list.over24)}` : ""} · นานสุด ${spanLabel(list.oldestWaitMs)}`
      : "ไม่มีใครค้างรอ")
    : (list.total
      ? (list.overdue != null
        ? `${n(list.total)} ห้อง · เกินเวลา ${n(list.overdue)} · ควรต่อแล้ว ${n(list.due)} · ยังทัน ${n(list.ontrack)}`
        : `${n(list.total)} คน · ลูกแพรตอบแล้วเกิน 1 วัน ยังไม่มีทีมทักต่อ`)
      : "ไม่มีไม้ค้าง ทีมต่อครบแล้ว");
  const head = el("div", { class: "ov-sec-head" },
    el("h2", { class: "ov-sec-title" }, title),
    el("span", { class: `ov-sec-count${list.total ? " is-alert" : ""}` }, summary),
  );
  const empty = el("div", { class: "ov-empty" },
    isLukpraeTheme() ? moodPortrait(isWaiting ? "smile" : "wink", { size: "sm", decorative: true }) : null,
    el("p", { class: "ov-empty-text" }, day.attentionBroken
      ? "ยังอ่านรายชื่อไม่ได้ในรอบนี้ ลูกแพรจะลองใหม่เองใน 15 วินาที"
      : isWaiting ? "ไม่มีลูกค้าค้างรอคำตอบค่ะ" : "ไม่มีห้องที่ลูกแพรคุยจบแล้วรอทีมต่อค่ะ"),
  );
  const more = list.rooms.length > LIST_PREVIEW && onToggle
    ? el("button", { class: "ov-more", type: "button", "aria-expanded": expanded ? "true" : "false", onclick: onToggle },
        expanded ? "ย่อรายชื่อ" : `ดูอีก ${n(list.rooms.length - LIST_PREVIEW)} ห้อง`)
    : null;
  // คิวรอตอบในหน้าแชทคือรายการเดียวกันเป๊ะ (ลำดับ/จำนวน) — กดแล้วเปิดห้องบนสุดของคิวเลย
  // ทำเสร็จทีละห้องแล้วห้องถัดไปเปิดเอง ไม่ต้องกลับมาหน้านี้
  const foot = isWaiting
    ? el("span", { class: "ov-sec-links" },
        list.rooms.length
          ? el("a", { class: "ov-sec-link is-primary", href: roomHash("waiting", list.rooms[0].id) }, "ไล่ตอบทีละห้องในหน้าแชท ›")
          : null,
        el("a", { class: "ov-sec-link", href: "#/chat/needs" }, `คิวรอคน (ส่งต่อให้ทีม) ${n(day.needsCount)} ห้อง ›`),
      )
    : el("span", { class: "ov-sec-links" },
        teamRateNote(list.teamRate),
        list.rooms.length
          ? el("a", { class: "ov-sec-link is-primary", href: roomHash("hotfollow", list.rooms[0].id) }, "ไล่ต่อทีละห้องในหน้าแชท ›")
          : null,
        el("a", { class: "ov-sec-link", href: "#/chat/hot" }, `ลูกค้าสนใจสูงทั้งหมด ${n(day.hot)} คน ›`),
      );
  const overflow = list.total > list.rooms.length && expanded
    ? el("p", { class: "ov-sec-note" }, `และอีก ${n(list.total - list.rooms.length)} ห้อง — ไล่ต่อได้ในคิวรอตอบหน้าแชท`)
    : null;
  return el("section", {
    class: `ov-panel ov-attention is-${kind}${list.total ? " has-items" : ""}`,
    id: isWaiting ? "ov-waiting" : "ov-hotquiet",
  },
    head,
    rooms.length ? el("ul", { class: "ov-q-list" }, rooms.map((room) => roomRow(room, { kind: isWaiting ? "waiting" : "hot", actions }))) : empty,
    overflow,
    el("div", { class: "ov-sec-foot" }, more, foot),
  );
}

/* ------------------------------ เส้นทางลูกค้า ------------------------------ */

export function funnelSection({ day, data }) {
  const c = day.counts;
  const orders = data.orders || null;
  const stages = [
    // 30 ก.ย. 2026 (พี่ง้วง): ไม่ใช้คำ เย็น/อุ่น/ร้อน — ไอคอนบนแท่ง + ชื่อแบบคน (เกณฑ์คะแนนเดิม)
    { key: "cold", temp: "🌱", label: "เพิ่งเริ่มคุย", hint: "คะแนน 0–4 หรือยังไม่มีคะแนน", value: c?.cold, href: "#/chat/cold" },
    { key: "warm", temp: "🤔", label: "กำลังพิจารณา", hint: "คะแนน 5–7 ชวนคุยต่อ", value: c?.warm, href: "#/chat/warm" },
    { key: "hot", temp: "🔥", label: "สนใจสูง", hint: "คะแนน 8–10 รีบคุยต่อ", value: c?.hot ?? day.hot, href: "#/chat/hot" },
    { key: "won", temp: "💎", label: "ซื้อแล้ว", hint: "ออเดอร์ยืนยันเดือนนี้", value: orders?.monthConfirmedCount, href: "#/orders" },
  ];
  return el("section", { class: "ov-panel ov-funnel" },
    el("div", { class: "ov-sec-head" },
      el("h2", { class: "ov-sec-title" }, "เส้นทางลูกค้า"),
      el("span", { class: "ov-sec-note" }, "นับจากสถานะล่าสุดของลูกค้าทุกคน"),
    ),
    el("ol", { class: "ov-stages" }, stages.map((stage) => el("li", { class: `ov-stage is-${stage.key}` },
      el("a", { class: "ov-stage-link", href: stage.href },
        el("span", { class: "ov-stage-bar" },
          el("span", { class: "ov-stage-temp" }, stage.temp),
          el("strong", { class: "ov-stage-value" }, stage.value == null ? "—" : n(stage.value)),
        ),
        el("span", { class: "ov-stage-copy" },
          el("span", { class: "ov-stage-label" }, stage.label),
          el("span", { class: "ov-stage-hint" }, stage.hint),
        ),
      ),
    ))),
  );
}
