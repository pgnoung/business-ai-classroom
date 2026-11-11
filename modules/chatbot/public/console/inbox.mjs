// inbox.mjs — รายการแชท (convo pane) ของ chat workspace
// มือถือ: เป็นหน้า "แชท" เต็มจอ / เดสก์ท็อป: sidebar ซ้าย 360px คู่กับห้องแชท
// Volume-ready (G4): server-side pagination 30 แถว/หน้า + โหลดเพิ่ม (ปุ่ม/เลื่อนใกล้ท้าย),
// ค้นหาชื่อ/ข้อความ, จุด unread, chip segment HOT/WARM/COLD/รอคน/AI ปิด พร้อมจำนวนจริงจาก SQL
import { el, timeAgo } from "./dom.mjs";
import { customerLabel, avatarEl, followupSuppressionBadge } from "./ui.mjs";
import { adReferralChip } from "./adReferral.mjs";
import {
  aiOffBadge, aiStateBadge, fbClosedBadge, isHotFollowFilter, isWaitingFilter, RELAY_TONE, relayStatusLabel, roomHash, rowQuickActions,
  spanLabel, valueBadge,
} from "./triage.mjs";

export const PAGE_SIZE = 30;

export function captureInboxLoadScope(state) {
  return {
    channel: state.channel ?? null,
    filter: state.inbox.filter ?? null,
    q: state.inbox.q || "",
    routeGen: state.routeGen ?? 0,
  };
}

export function isInboxLoadScopeCurrent(state, scope) {
  return (state.channel ?? null) === scope.channel &&
    (state.inbox.filter ?? null) === scope.filter &&
    (state.inbox.q || "") === scope.q &&
    (state.routeGen ?? 0) === scope.routeGen;
}

function inboxScopeKey(state) {
  const scope = captureInboxLoadScope(state);
  return JSON.stringify([scope.channel, scope.filter, scope.q, scope.routeGen]);
}

function inboxPageParams(scope, offset) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (scope.channel) params.set("channel", scope.channel);
  if (scope.filter) params.set("segment", scope.filter);
  if (scope.q) {
    params.set("q", scope.q);
    if (scope.q.length >= 2) params.set("deep", "1");
  }
  return params;
}

export const FILTERS = [
  { key: null, hash: "#/chat", label: "ทั้งหมด", countKey: "all",
    explain: "ทุกบทสนทนา เรียงตามความเคลื่อนไหวล่าสุด (ไม่รวมห้องที่ย้ายไปสแปม)" },
  // 28 ก.ย. 2026 (พี่ง้วง: "tab รอตอบ กับหน้าภาพรวมให้เหมือนกัน"): รายการ/ลำดับ/จำนวนชุดเดียวกับ
  // "ลูกค้ารอคนตอบตอนนี้" บนหน้าภาพรวม (src/waitingRooms.mjs) — เปิดห้องจากคิวนี้แล้วทำเสร็จ
  // (ตอบ/✓ เสร็จสิ้น/สแปม) ห้องถัดไปเปิดให้เอง ไม่ต้องกดกลับมาที่รายการ
  { key: "waiting", hash: "#/chat/waiting", label: "⏳ รอตอบ", countKey: "waiting", tone: "waiting",
    explain: "ลูกค้าพิมพ์คนสุดท้ายแล้วยังไม่มีใครตอบ (30 วันล่าสุด) — เรื่องเงิน > ร้อน > อุ่น แล้วรอนานสุดก่อน · ไม่รวมสติกเกอร์/ขอบคุณเฉย ๆ" },
  { key: "waiting24", hash: "#/chat/waiting24", label: "ค้าง >24 ชม.", countKey: "waiting24", tone: "waiting24",
    explain: "คิวรอตอบเฉพาะห้องที่ค้างเกิน 24 ชม. — ห้อง Facebook กลุ่มนี้ต้องตอบใน Business Suite" },
  // 30 ก.ย. 2026 (พี่ง้วง: ปุ่ม "ไล่ทักทีละห้อง"): ชุดเดียวกับการ์ด "ลูกค้าร้อนเงียบไป — รอทีมทักต่อ" บนหน้าภาพรวม
  // และ push แจ้งทีม 09:10/13:10/18:10 — ห้องออกจากคิวได้ทางเดียวคือคนพิมพ์คุยกับลูกค้า แล้วห้องถัดไปเปิดเอง
  // 3 พ.ย. 2026: กลายเป็น "ไม้ต่อจากลูกแพร" — ทุกห้อง (ไม่ใช่เฉพาะสนใจสูง) เปิดไม้หลังลูกค้าเงียบ 2 ชม.ทำการ
  { key: "hotfollow", hash: "#/chat/hotfollow", label: "🤝 ไม้ต่อจากลูกแพร", countKey: "hotfollow", tone: "hotfollow",
    explain: "ทุกห้องที่ลูกแพรคุยจบแล้ว ลูกค้าเงียบครบ 2 ชม. (เวลาทำการ จ.–ส. 09:00–18:00) และยังไม่มีทีมเข้าไปคุยต่อ — เป้าต่อภายใน 3 ชม. เส้นตาย 6 ชม. หลังลูกแพรจบ · เกินเวลาขึ้นก่อน · พิมพ์คุย (คอนโซล/Business Suite/YOLO) แล้วห้องหายเอง" },
  // 30 ก.ย. 2026 (พี่ง้วง): คำแบบคนแทนอุณหภูมิ — สนใจสูง · กำลังพิจารณา · เพิ่งเริ่มคุย (เกณฑ์คะแนนเดิม)
  { key: "hot", hash: "#/chat/hot", label: "🔥 สนใจสูง", countKey: "hot", tone: "hot",
    explain: "คะแนน 8–10 — สนใจสูง ใกล้ตัดสินใจ รีบคุยต่อ" },
  { key: "warm", hash: "#/chat/warm", label: "🤔 กำลังพิจารณา", countKey: "warm", tone: "warm",
    explain: "คะแนน 5–7 — กำลังพิจารณา ชวนคุยต่อ" },
  { key: "cold", hash: "#/chat/cold", label: "🌱 เพิ่งเริ่มคุย", countKey: "cold", tone: "cold",
    explain: "คะแนน 0–4 หรือยังไม่มีคะแนน — เพิ่งเริ่มคุย ยังไม่เห็นสัญญาณซื้อ" },
  { key: "needs", hash: "#/chat/needs", label: "รอคน", countKey: "needs", tone: "needs",
    explain: "ระบบส่งต่อให้คนดูแล — เปิดดูก่อนใคร" },
  { key: "mine", hash: "#/chat/mine", label: "ของฉัน", countKey: "mine", tone: "mine",
    explain: "บทสนทนาที่มอบหมายให้บัญชีที่กำลังใช้งาน" },
  { key: "resolved", hash: "#/chat/resolved", label: "เสร็จสิ้น", countKey: "resolved", tone: "resolved",
    explain: "เคสที่ทีมกดปิดงานแล้ว เปิดย้อนดูหรือเปิดเคสใหม่ได้" },
  { key: "aioff", hash: "#/chat/aioff", label: "AI ปิด", countKey: "aioff", tone: "aioff",
    explain: "ห้องที่ AI ปิดอยู่ — ป้ายม่วง = คนปิดเอง · ป้ายแดง = ระบบปิดเพราะสัญญาณเสี่ยง · ป้ายเหลือง = AI คัดกรองว่ายังไม่เข้าเกณฑ์ (เหตุอยู่ในคิวรอตอบ/หัวห้อง)" },
  // 5 ต.ค. 2026 (คำสั่งพี่ง้วง: ตัวกวาดรายชั่วโมงปิด AI ห้องที่ไม่มีศักยภาพ เป็นป้ายเหลือง "AI off (not qualify)"
  // และเปิดคืนเองเมื่อเห็นศักยภาพ): ห้องเหลืองมีที่ของตัวเอง ทีมเปิดดูได้ว่า AI คัดใครออกไป แล้วกดเปิด AI ทับได้
  // optionalCount: เซิร์ฟเวอร์รุ่นที่ยังไม่นับห้องเหลือง = ชิปไม่มีตัวเลข (ดีกว่าขึ้น 0 ทั้งที่ไม่รู้จริง)
  { key: "notqualify", hash: "#/chat/notqualify", label: "ไม่เข้าเกณฑ์", countKey: "notqualify", tone: "notqualify", optionalCount: true,
    explain: "ห้องที่ AI คัดกรองแล้วว่ายังไม่เข้าเกณฑ์ลูกค้า (ป้ายเหลือง AI off (not qualify)) — ตัวกวาดรายชั่วโมงปิด AI เอง และเปิดคืนเองเมื่อเห็นศักยภาพ · เห็นต่างกด \"เปิด AI\" ที่หัวห้องได้ แล้วตัวกวาดจะไม่ปิดห้องนั้นอีก" },
  // v1.4.33 (พี่ง้วงสั่ง 2026-08-19): กลุ่มลูกค้าที่ซื้อแล้ว — คนละโหมดกับที่เหลือทั้งหมด
  // (บอทเงียบถาวร ทีมงานคุยเอง) จึงควรมีที่ของตัวเอง ไม่ปนกับรายการไล่งานขายประจำวัน
  { key: "customer", hash: "#/chat/customer", label: "💎 Customer", countKey: "customer", tone: "customer",
    explain: "ลูกค้าที่ติดป้าย customer — บอทเงียบถาวร ทีมงานดูแลเอง" },
  // 28 ก.ย. 2026: สแปม = ป้าย null — หายจากทุกคิวด้านบนและตัวเลขทั้งหมด เหลือที่เดียวคือตรงนี้
  { key: "spam", hash: "#/chat/spam", label: "🚫 สแปม", countKey: "spam", tone: "spam",
    explain: "ห้องที่ย้ายไปสแปม (ป้าย null) — AI ปิด ไม่ทักตาม ไม่นับในตัวเลขไหน · กด \"ไม่ใช่สแปม\" เพื่อคืน" },
];

// ตัวเลขบนชิป — ชิปทั่วไปขึ้น 0 เมื่อเซิร์ฟเวอร์ไม่ส่งตัวเลข (แบบเดิมทุกตัวอักษร)
// ชิป optionalCount (ไม่เข้าเกณฑ์ 5 ต.ค. 2026): ฝั่งนับ SQL เป็นอีกงานที่ขึ้นทีหลังได้ — รับทั้ง counts.notqualify
// (รูปเดียวกับ aioff) และ counts.notqualify_n (ชื่อคอลัมน์ SQL) · ไม่มีทั้งคู่ = null แล้วชิปไม่ขึ้นตัวเลข
// (ขึ้น 0 ทั้งที่ยังไม่ได้นับ = ทีมเข้าใจผิดว่าไม่มีห้องเหลือง)
export function chipCount(counts, filter = {}) {
  if (!filter?.optionalCount) return counts?.[filter?.countKey] ?? 0;
  for (const key of [filter.countKey, `${filter.countKey}_n`]) {
    const value = counts?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function chipCountEl(count) {
  return count == null ? null : el("span", { class: "fchip-count" }, String(count));
}

// 28 ก.ย. 2026: แถวชิปมี 12 ชิปและเลื่อนซ้ายขวาได้ — ชิปท้ายแถว (สแปม/AI ปิด/Customer) เคยถูกเลือกอยู่นอกจอ
// คนดูไม่รู้ว่ากำลังดูรายการไหน · เรียกหลังวางหน้าจอทุกครั้ง (แถวชิปถูกสร้างใหม่ทุกรอบ poll)
export function revealActiveChip(doc = globalThis.document) {
  const chip = doc?.querySelector?.("nav.inbox-filters:not(.branch-filters) a.fchip.is-active");
  const nav = chip?.closest?.("nav");
  if (!chip || !nav || typeof chip.getBoundingClientRect !== "function") return;
  const c = chip.getBoundingClientRect();
  const n = nav.getBoundingClientRect();
  if (c.left < n.left || c.right > n.right) nav.scrollLeft += c.left - n.left - 12;
}

// ระบบตั้งใจไม่ทัก = ต้องบอกเหตุผลบนคอนโซล ไม่ปล่อยให้ timer หายเงียบ
export const FU_BLOCKED_LABEL = Object.freeze({
  ladder_done: ["⏱ FU รอลูกค้าตอบ", "ทักตามครบรอบนี้แล้ว — ลูกค้าตอบกลับเมื่อไหร่ เริ่มนับรอบใหม่"],
  // รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8): ห้อง v3 ทักตามเฉพาะตอนมีเรื่องค้าง — ไม่ทักโดยเจตนาต้องไม่ขึ้นว่า "ทักครบแล้ว"
  no_thread: ["⏱ FU ไม่มีเรื่องค้าง", "ไม่มีเรื่องที่ค้างให้ทักต่อ (ลูกค้าพิมพ์ล่าสุด/ทีมดูแลอยู่/คุยจบเรื่องแล้ว) — ลูกค้าตอบกลับเมื่อไหร่ เริ่มนับรอบใหม่"],
  followup_stop: ["⏱ FU หยุดตามลูกค้า", "ลูกค้าลาเอง ปฏิเสธ รู้สึกถูกเร่ง หรืออยู่ในช่วงที่ต้องดูแลใจ — ระบบไม่ทักตาม ลูกค้าทักมาเมื่อไหร่คุยต่อตามปกติ"],
  // 28 ก.ย. 2026: เพดานต่างกันตามช่องทาง (stagedFollowups.dailyProactiveCapFor) — ป้ายเดิมเขียน 1/วัน ทุกห้อง
  daily_cap: ["⏱ FU ครบเพดานวันนี้", "ทักตามครบเพดานของวันนี้แล้ว (LINE วันละ 1 · Facebook วันละ 3) — พรุ่งนี้นับใหม่"],
  cold_cap: ["⏱ FU Cold ครบ", "ลูกค้า Cold ทักตามครบ 4 ครั้งตลอดชีพแล้ว — ที่เหลือเป็นเรื่องแคมเปญ"],
  payment_hold: ["⏱ FU พักช่วงจ่ายเงิน", "ลูกค้าเพิ่งแจ้งโอน/ส่งสลิป — ระบบพักการทักให้ทีมดูแลเอง"],
  service_boundary: ["⏸ พักทักขาย", "กำลังขอความช่วยเหลือทำชิ้นงาน — ยังตอบเมื่อทักมา และประเมินใหม่เมื่อสนใจเรียน"],
  dormant: ["⏱ FU เงียบเกิน 10 วัน", "แชทเงียบเกิน 10 วัน ระบบไม่ปลุกด้วย follow-up (เป็นจังหวะแคมเปญ)"],
  tag_silenced: ["🚫 ไม่ทัก", "ห้องนี้ติดป้าย null หรือ customer — บอทไม่ตอบและไม่ทักตามทุกกรณี"],
  urgent_mental: ["⏱ FU ส่งต่อคนดูแล", "พบสัญญาณวิกฤตสุขภาพจิต — ระบบหยุดทักอัตโนมัติและให้คนจริงดูแลต่อ"],
  // 28 ก.ย. 2026: ทักเบา ๆ หลังส่งบัญชี (ครั้งเดียวต่อรอบ) — บอกทีมว่าทักไปแล้ว/ตั้งใจไม่ทัก จะได้ไม่ส่งซ้อน
  payment_nudge_done: ["💳 ทักหลังส่งบัญชีแล้ว", "ลูกแพรทักเบา ๆ หลังส่งเลขบัญชีไปแล้วหนึ่งครั้ง — จะไม่ทักเรื่องการโอนอีก"],
  payment_nudge_skipped: ["💳 ไม่ทักเรื่องโอน", "ห้องนี้ไม่เข้าเงื่อนไขทักหลังส่งบัญชี (ลูกค้าถามต่อ/ส่งสลิป/ทีมตอบแล้ว/ไม่มีเวลาที่เหมาะ) — ทีมดูแลต่อ"],
  // 28 ก.ย. 2026: Facebook เว้นระยะไม้หลังถูกเลื่อนพ้นคืน (ไม่กองยิงตอนเช้า) — ไม้ที่ไม่ทันประตู 24 ชม. ถูกข้าม
  fb_window_ends: ["⏱ FU รอลูกค้าตอบ (FB)", "Facebook ให้ทักอัตโนมัติได้ภายใน 24 ชม. หลังข้อความล่าสุดของลูกค้า — ไม้ถัดไปไม่ทันเวลากลางวันในหน้าต่างนี้ บันไดรอบนี้จึงจบ ลูกค้าตอบกลับเมื่อไหร่ เริ่มนับรอบใหม่"],
});

// 2026-09-02: คิว "รอคน" บอกไม่ได้ว่าใครรอมานานแค่ไหน และไม่บอกว่าห้องไหนแตะเรื่องเงิน
// ของจริงวันนี้: 28 ห้องรอคน 11 ห้องไม่เคยมีคนตอบ สองห้องที่คุยเรื่องเงินรอ 30 และ 169 ชม.
// ข้อมูลอยู่บนจอมาตลอด แต่ต้องเปิดทีละห้องถึงจะรู้ — คนกวาดตาดูรายการจึงไม่มีทางเห็น
//
// ห้องที่ AI คุยต่อได้ให้นับคำตอบล่าสุดด้วย ส่วนงานที่ต้องให้คนตรวจยังรอหลักฐาน
// คำตอบคนในคอนโซล; ประวัติการตอบจากช่องทางภายนอกอาจยังมาไม่ครบ
export function waitingForHumanSince(c) {
  const lastInbound = Number(c?.last_inbound_at) || 0;
  if (!lastInbound) return 0;
  const lastHumanReply = Number(c?.last_operator_outbound_at) || 0;
  const aiMayContinue = Number(c?.ai_enabled) === 1 &&
    (Number(c?.operator_active_until) || 0) <= Date.now() && !requiresHumanReview(c);
  const lastAccountedReply = aiMayContinue
    ? (Number(c?.last_outbound_at) || 0)
    : lastHumanReply;
  return lastInbound > lastAccountedReply ? lastInbound : 0;
}

// สัญญาณเหล่านี้ต้องให้คนตรวจ แม้ระบบจะเคยส่งข้อความออกหลังลูกค้าทักแล้ว
// ตรวจเฉพาะ token ของระบบ ไม่อ่านข้อความสรุปอิสระของลูกค้า/ทีมมาเดาเอง.
function requiresHumanReview(c) {
  if (Number(c?.has_unkept_promise) === 1) return true;
  if (Number(c?.money_seen_at) > 0 || c?.ai_off_reason === "bank_sent" || Boolean(String(c?.last_slip_status ?? "").trim())) return true;
  return /\[[^\]]{0,40}\]\s*(?:payment_review|image_review|payment_requires_human_review)\b/iu
    .test(String(c?.handoff_summary || ""));
}

// NEEDS_HUMAN เป็นเพียงธงแจ้งทีม ไม่ใช่หลักฐานว่ามีคนกำลังทำงานอยู่
// จึงแปลสถานะจากหลักฐานที่เห็นได้จริงบน inbox: ข้อความคนล่าสุด, การมอบหมาย
// และช่วงที่ AI ถูกพักไว้.  null หมายถึงไม่มีข้อสรุปที่พูดได้อย่างซื่อตรง
// (เช่น AI ปิด แต่ยังไม่มีชื่อผู้รับผิดชอบหรือข้อความจากคนหลังลูกค้าทัก).
export function humanQueueStatus(c, { inNeedsQueue = false, now = Date.now() } = {}) {
  const needsHuman = String(c?.state || "") === "NEEDS_HUMAN";
  const lastInbound = Number(c?.last_inbound_at) || 0;
  const lastHumanReply = Number(c?.last_operator_outbound_at) || 0;
  const lastOutbound = Number(c?.last_outbound_at) || 0;
  const assignedTo = String(c?.human_owner || "").trim();
  const aiOn = Number(c?.ai_enabled) === 1;
  const aiPaused = aiOn && (Number(c?.operator_active_until) || 0) > Number(now);
  const aiMayContinue = aiOn && !aiPaused;
  const criticalReview = requiresHumanReview(c);
  const humanAnswered = lastHumanReply > 0 && lastHumanReply >= lastInbound;
  const aiAnswered = lastInbound > 0 && lastOutbound >= lastInbound;
  const lastAccountedReply = aiMayContinue && !criticalReview ? lastOutbound : lastHumanReply;
  const needsReply = lastInbound > lastAccountedReply;

  if (Number(c?.has_unkept_promise) === 1) {
    return {
      key: "needs_followup", label: "ต้องติดตาม", className: "badge-red",
      title: "ยังมีคำสัญญาให้ทีมรับต่อที่ไม่พบหลักฐานการรับช่วงในคอนโซล",
    };
  }
  if (criticalReview && needsHuman && !humanAnswered) {
    return {
      key: "needs_review", label: "ต้องตรวจผู้ดูแล", className: "badge-orange",
      title: "คอนโซลบันทึกสัญญาณที่ต้องให้คนตรวจ แม้ระบบจะเคยส่งข้อความออกแล้ว",
    };
  }
  if (humanAnswered && needsHuman) {
    return {
      key: "human_answered",
      label: "คนตอบแล้ว",
      className: "badge-green",
      title: "คอนโซลบันทึกข้อความจากคนจริงหลังข้อความล่าสุดของลูกค้า — ตรวจประวัติภายนอกเพิ่มเติมหากทีมคุยนอกระบบ",
    };
  }
  if (aiAnswered && aiMayContinue && !criticalReview && needsHuman) {
    return {
      key: "ai_continues",
      label: "แจ้งทีม · AI ตอบต่อ",
      className: "badge-orange",
      title: "คอนโซลบันทึกว่าระบบตอบหลังข้อความล่าสุดของลูกค้า และ AI ยังเปิดอยู่ — ธงแจ้งทีมนี้ไม่ยืนยันว่าคนกำลังดูแล",
    };
  }
  if (needsReply && (needsHuman || inNeedsQueue)) {
    return {
      key: "needs_action",
      label: "ต้องตอบ",
      className: "badge-red",
      title: "ข้อความล่าสุดของลูกค้ายังไม่มีข้อความตอบที่คอนโซลบันทึกไว้ตามสถานะห้องนี้",
    };
  }
  if (!needsHuman && inNeedsQueue) {
    return {
      key: "needs_followup",
      label: "ต้องติดตาม",
      className: "badge-orange",
      title: "ระบบพบเรื่องที่ต้องให้ทีมติดตาม แต่ไม่ได้ยืนยันว่ามีคนกำลังดูแลอยู่",
    };
  }
  if (!needsHuman) return null;
  if (criticalReview) {
    return {
      key: "needs_review",
      label: "ต้องตรวจผู้ดูแล",
      className: "badge-orange",
      title: "คอนโซลบันทึกสัญญาณที่ต้องให้คนตรวจ แม้ระบบจะเคยส่งข้อความออกแล้ว",
    };
  }
  if (assignedTo) {
    return {
      key: "assigned",
      label: `มอบหมาย ${assignedTo}`,
      className: "badge-owner",
      title: "มีการมอบหมายเจ้าของห้องแล้ว แต่ยังไม่มีหลักฐานในคอนโซลว่าตอบลูกค้าแล้ว",
    };
  }
  if (aiPaused) {
    return {
      key: "ai_paused",
      label: "AI พัก · ตรวจคนดูแล",
      className: "badge-orange",
      title: "AI ถูกพักชั่วคราว แต่ข้อมูลที่คอนโซลบันทึกอย่างเดียวไม่ยืนยันว่ามีคนกำลังดูแลอยู่",
    };
  }
  if (aiOn) {
    return {
      key: "ai_continues",
      label: "แจ้งทีม · AI ตอบต่อ",
      className: "badge-orange",
      title: "ห้องมีธงแจ้งทีม แต่ AI ยังเปิดและไม่ได้ถูกพัก — ข้อมูลที่คอนโซลบันทึกไม่ยืนยันว่าคนกำลังดูแล",
    };
  }
  // 28 ก.ย. 2026: ป้าย "AI ปิด · โดยคน/โดยระบบ" แยกขึ้นทุกแถวแล้ว — ป้ายนี้จึงบอกแค่สิ่งที่ต้องทำ
  return {
    key: "owner_unknown",
    label: "ตรวจผู้ดูแล",
    className: "badge-gray",
    title: "AI ปิดแล้ว แต่คอนโซลยังไม่พบชื่อผู้รับผิดชอบหรือข้อความจากคนจริงหลังลูกค้าทัก",
  };
}

// ห้องนี้แตะเรื่องเงินแล้วหรือยัง — เห็นยอด/ขอเลขบัญชี, ส่งเลขบัญชีไปแล้ว, หรือมีสลิป
export function touchesMoney(c) {
  return Number(c?.money_seen_at) > 0
    || c?.ai_off_reason === "bank_sent"
    || Boolean(String(c?.last_slip_status ?? "").trim());
}

const EMPTY_TEXT = {
  all: "ยังไม่มีบทสนทนา — ลูกค้าทักมาเมื่อไหร่จะขึ้นที่นี่",
  hot: "ยังไม่มีลูกค้าสนใจสูง (คะแนน 8 ขึ้นไป)",
  warm: "ยังไม่มีลูกค้ากำลังพิจารณา (คะแนน 5–7)",
  cold: "ไม่มีลูกค้าเพิ่งเริ่มคุยตอนนี้",
  needs: "ไม่มีเคสรอคนตอนนี้ — ดีแล้ว!",
  aioff: "ไม่มีห้องที่ปิด AI อยู่",
  notqualify: "ไม่มีห้องที่ AI คัดกรองว่ายังไม่เข้าเกณฑ์ — ป้ายเหลืองจะขึ้นที่นี่เมื่อตัวกวาดรายชั่วโมงปิด AI ห้องไหน",
  customer: "ยังไม่มีห้องที่ติดป้าย customer — ติดป้ายจากหน้าแชทได้เลย",
  waiting: "ไม่มีลูกค้าค้างรอคำตอบ — เคลียร์คิวหมดแล้ว",
  waiting24: "ไม่มีห้องที่ค้างเกิน 24 ชม.",
  hotfollow: "ไม่มีไม้ค้าง — ทีมต่อจากลูกแพรครบทุกห้องแล้ว",
  spam: "ยังไม่มีห้องในสแปม — กด \"สแปม\" ที่หัวห้องแชทเพื่อคัดคนที่ไม่ต้องตอบออกจากรายการ",
  search: "ไม่พบบทสนทนาที่ตรงกับคำค้น",
};

export function createConvoPane({ api, toast, state, channelName }) {
  let searchTimer = null;
  let loadingMore = false;
  let scopeSerial = 0;
  let renderedScopeKey = inboxScopeKey(state);

  function syncScope() {
    const next = inboxScopeKey(state);
    if (next === renderedScopeKey) return;
    renderedScopeKey = next;
    scopeSerial += 1;
    loadingMore = false;
  }

  // โหลดหน้าเพิ่ม (offset ต่อจากที่มี) — เรียกจากปุ่มและจาก scroll ใกล้ท้ายรายการ
  async function loadMore(rerender) {
    syncScope();
    if (loadingMore || !state.inbox.hasMore) return;
    loadingMore = true;
    const requestSerial = scopeSerial;
    const requestScope = captureInboxLoadScope(state);
    try {
      const params = inboxPageParams(requestScope, PAGE_SIZE + state.inbox.extra.length);
      const data = await api(`/console/api/inbox?${params.toString()}`);
      if (requestSerial !== scopeSerial || !isInboxLoadScopeCurrent(state, requestScope)) return;
      state.inbox.extra = [...state.inbox.extra, ...(data.conversations || [])];
      state.inbox.hasMore = data.hasMore === true;
      await rerender();
    } catch (err) {
      if (requestSerial === scopeSerial && isInboxLoadScopeCurrent(state, requestScope)) toast(err.message);
    } finally {
      if (requestSerial === scopeSerial) loadingMore = false;
    }
  }

  function filterChips(counts, activeKey) {
    return el("nav", { class: "inbox-filters", "aria-label": "กรองรายการแชท" },
      FILTERS.map((f) => {
        const isActive = (f.key ?? null) === (activeKey ?? null);
        return el("a", {
          class: `fchip${isActive ? " is-active" : ""}${f.tone ? ` fchip-${f.tone}` : ""}`,
          href: f.hash, title: f.explain,
          ...(isActive ? { "aria-current": "true" } : {}),
        }, f.label, chipCountEl(chipCount(counts, f)));
      }),
    );
  }

  // W3: chip เลือกสาขา (ทุกสาขา | ชื่อสาขา…) — โผล่เฉพาะ instance ที่มี >1 สาขา
  // เลือกแล้วมีผลทั้ง list + ตัวเลขบน chip segment (server scope ให้ตรงกัน)
  function channelChips(state, rerender) {
    if ((state.channels?.length ?? 0) <= 1) return null;
    const pick = (id) => () => {
      if (state.channel === id) return;
      state.channel = id;
      state.inbox.extra = [];
      rerender();
    };
    const chip = (id, label) => el("button", {
      class: `fchip fchip-branch${(state.channel ?? null) === id ? " is-active" : ""}`,
      onclick: pick(id),
      ...((state.channel ?? null) === id ? { "aria-current": "true" } : {}),
    }, label);
    return el("nav", { class: "inbox-filters branch-filters", "aria-label": "เลือกสาขา" },
      chip(null, "ทุกสาขา"),
      state.channels.map((ch) => chip(ch.id, ch.name || ch.id)),
    );
  }

  // v1.4.8 (คำสั่งพี่ง้วง 2026-08-16): badge นับถอยหลัง follow-up ถัดไป (cold/warm/hot)
  // เวลาเป็น label ตอน render — ใต้ signature dedupe ค่าอาจ stale ได้เท่า timeAgo (ยอมรับ)
  // 28 ก.ย. 2026: schedule_check = ลูกค้าขอเช็คคิวก่อน (ทักครั้งเดียว) · payment_nudge = ทักเบา ๆ หลังส่งบัญชี
  const FU_STAGE_LABEL = { cold: "Cold", warm: "Warm", hot: "Hot", schedule_check: "เช็คคิว", payment_nudge: "หลังส่งบัญชี" };
  const FU_KIND_LABEL = { question: "คำถาม", review: "รีวิว", atmosphere: "รูปคลาส", review_question: "รีวิว+คำถาม",
    schedule_check: "ถามครั้งเดียวว่าสะดวกรอบไหน", payment_gentle_nudge: "ถามเบา ๆ ว่ามีอะไรให้ช่วยไหม" };
  function stagedFollowupBadge(preview) {
    if (!preview) return null;
    if (preview.blocked) {
      const [label, title] = FU_BLOCKED_LABEL[preview.blocked] ?? [];
      return label ? el("span", { class: "badge badge-gray badge-fu-off", title }, label) : null;
    }
    if (!preview.dueAt) return null;
    const mins = Math.round((preview.dueAt - Date.now()) / 60000);
    const when = mins <= 0 ? "รอบถัดไป" : mins < 60 ? `~${mins} นาที` : `~${Math.round(mins / 60)} ชม.`;
    const cls = preview.stage === "hot" ? "badge-orange" : preview.stage === "warm" ? "badge-green" : "badge-gray";
    return el("span", {
      class: `badge ${cls}`,
      title: `Follow-up ${FU_STAGE_LABEL[preview.stage] ?? preview.stage} ขั้น ${preview.step} (${FU_KIND_LABEL[preview.kind] ?? preview.kind})`,
    }, `⏱ FU ${FU_STAGE_LABEL[preview.stage] ?? preview.stage} ${when}`);
  }

  // ป้าย "สรุปจาก LINE OA" (คำสั่งพี่ง้วง 2026-08-26) — กติกาคำนวณฝั่งเซิร์ฟเวอร์
  // ใน src/lineOaContext.mjs แล้ว ตรงนี้แค่วาด ส้ม = เรื่องยังไม่ถูกพากลับเข้าคอนโซล
  // เขียว = สรุปแล้ว ลูกแพรได้ context ครบ (โน้ตส่งต่อ หรือแอดมินตอบในคอนโซลเอง)
  function lineOaContextBadge(context) {
    if (!context) return null;
    if (!context.synced) {
      return el("span", {
        class: "badge badge-orange",
        title: "ห้องนี้คนดูแลเอง และยังไม่มีใครสรุปเรื่องกลับเข้าคอนโซลหลังข้อความล่าสุด"
          + " — ถ้าเพิ่งไปคุยในแอป LINE OA มา ให้เขียนโน้ตส่งต่อ ลูกแพรจะได้รู้เรื่องด้วย",
      }, "🟠 รอสรุป");
    }
    const via = context.reason === "note" ? "มีโน้ตส่งต่อ" : "แอดมินตอบในคอนโซลแล้ว";
    return el("span", {
      class: "badge badge-green",
      title: `${via} หลังข้อความล่าสุดของลูกค้า — ลูกแพรได้ context ครบแล้ว`,
    }, "🟢 สรุปแล้ว");
  }

  // 28 ก.ย. 2026: แถวในคิวรอตอบ — เวลารอ · มูลค่า · AI ปิดเพราะใคร · Facebook ตอบจากคอนโซลไม่ได้แล้ว
  // + ปุ่มลัด ✓ เสร็จสิ้น / สแปม (อยู่นอกลิงก์ของแถว) · ลำดับมาจากเซิร์ฟเวอร์ (ห้ามเรียงใหม่ที่นี่)
  function waitingRow(c, activeId, multiChannel, onRowDone) {
    const unread = Number(c.unread) === 1;
    const wait = c.waiting || {};
    const since = Number(wait.since) || Number(c.last_inbound_at) || 0;
    const room = { id: c.line_user_id, name: customerLabel(c) };
    const link = el("a", {
      class: `convo-row is-waiting${unread ? " is-unread" : ""}${c.line_user_id === activeId ? " is-active" : ""}`,
      href: roomHash(state.inbox.filter, c.line_user_id),
    },
      avatarEl(c),
      el("span", { class: "convo-main" },
        el("span", { class: "convo-top" },
          el("strong", { class: "convo-name" }, customerLabel(c)),
          el("span", { class: "convo-top-end" },
            el("span", { class: `convo-wait${since && Date.now() - since >= 86_400_000 ? " is-long" : ""}` },
              since ? `รอ ${spanLabel(Date.now() - since)}` : ""),
            // จุดยังไม่อ่านอยู่คู่เวลารอ — เดิมลอยทับท้ายบรรทัดเหตุ AI ปิด
            unread ? el("span", { class: "unread-dot", "aria-label": "มีข้อความใหม่" }) : null,
          ),
        ),
        el("span", { class: "convo-badges" },
          multiChannel && c.channel_id
            ? el("span", { class: "badge badge-branch" }, channelName?.(c.channel_id) || c.channel_id)
            : el("span", { class: "badge badge-channel" }, c.channel_id === "facebook" ? "Facebook" : "LINE"),
          valueBadge(wait.value, wait.score),
          aiStateBadge({ aiOff: c.ai_off, aiOn: c.ai_enabled === 1, aiPaused: wait.aiPaused === true }, { withReason: true }),
          wait.fbReplyClosed ? fbClosedBadge() : null,
          c.human_owner ? el("span", { class: "badge badge-owner", title: "มอบหมายเจ้าของห้องแล้ว" }, `👤 ${c.human_owner}`) : null,
        ),
        el("span", { class: "preview" }, wait.preview ? `“${wait.preview}”` : (c.last_message || "—")),
      ),
    );
    return el("div", { class: `convo-item${c.line_user_id === activeId ? " is-active" : ""}` },
      link,
      rowQuickActions({ api, toast, room, onDone: () => onRowDone?.(room) }),
    );
  }

  // 30 ก.ย. 2026: แถวในคิวรอทีมทักต่อ — ลูกค้าเงียบนานเท่าไร / Facebook ตอบได้อีกเท่าไร · ลูกแพรทำอะไรไปแล้ว
  // ไม่มีปุ่มลัด ✓ เสร็จสิ้น: ห้องออกจากคิวนี้ได้ทางเดียวคือคนพิมพ์คุยกับลูกค้า (พี่ง้วง 30 ก.ย.)
  function hotFollowRow(c, activeId, multiChannel) {
    const unread = Number(c.unread) === 1;
    const hot = c.hot_follow || {};
    const fbLeft = hot.fbHumanUntil != null ? Number(hot.fbHumanUntil) - Date.now() : null;
    const replies = Number(hot.aiReplies) || 0;
    return el("div", { class: `convo-item${c.line_user_id === activeId ? " is-active" : ""}` },
      el("a", {
        class: `convo-row is-hotfollow${unread ? " is-unread" : ""}${c.line_user_id === activeId ? " is-active" : ""}`,
        href: roomHash(state.inbox.filter, c.line_user_id),
      },
        avatarEl(c),
        el("span", { class: "convo-main" },
          el("span", { class: "convo-top" },
            el("strong", { class: "convo-name" }, customerLabel(c)),
            el("span", { class: "convo-top-end" },
              fbLeft != null && fbLeft < 86_400_000
                ? el("span", { class: "convo-wait is-long" }, `FB ตอบได้อีก ${spanLabel(fbLeft)}`)
                : hot.relayStatus
                  ? el("span", { class: `convo-wait${RELAY_TONE[hot.relayStatus] === "calm" ? "" : " is-long"}` }, relayStatusLabel(hot.relayStatus, hot.workElapsedMs))
                  : el("span", { class: "convo-wait" }, `เงียบ ${spanLabel(hot.silentMs)}`),
              unread ? el("span", { class: "unread-dot", "aria-label": "มีข้อความใหม่" }) : null,
            ),
          ),
          el("span", { class: "convo-badges" },
            multiChannel && c.channel_id
              ? el("span", { class: "badge badge-branch" }, channelName?.(c.channel_id) || c.channel_id)
              : el("span", { class: "badge badge-channel" }, c.channel_id === "facebook" ? "Facebook" : "LINE"),
            valueBadge(hot.value || "other", hot.score ?? c.last_score),
            el("span", { class: "badge badge-hotfollow" },
              `${hot.teamTalkedBefore ? "เคยคุยกับทีม · " : ""}${replies > 1 ? `ลูกแพรตอบ + ทักตาม ${replies}` : "ลูกแพรตอบแล้ว"}`),
            c.human_owner ? el("span", { class: "badge badge-owner", title: "มอบหมายเจ้าของห้องแล้ว" }, `👤 ${c.human_owner}`) : null,
          ),
          el("span", { class: "preview" }, hot.preview ? `“${hot.preview}”` : (c.last_message || "—")),
        ),
      ),
    );
  }

  // คิวสแปม: แถวปกติ + ปุ่ม "ไม่ใช่สแปม" (คืนห้องโดยไม่ต้องเปิด)
  function spamRow(c, activeId, multiChannel, onRowDone) {
    const room = { id: c.line_user_id, name: customerLabel(c) };
    return el("div", { class: `convo-item is-spam${c.line_user_id === activeId ? " is-active" : ""}` },
      convoRow(c, activeId, multiChannel),
      rowQuickActions({ api, toast, room, spamQueue: true, onDone: () => onRowDone?.(room) }),
    );
  }

  function convoRow(c, activeId, multiChannel) {
    const needsHuman = c.state === "NEEDS_HUMAN";
    const aiOff = c.ai_enabled !== 1;
    const unread = Number(c.unread) === 1;
    // ป้ายเวลารอ/เส้นเงินขึ้นเฉพาะห้องที่อยู่ในคิวรอคนจริง ๆ — ห้องที่บอทดูแลอยู่
    // ไม่ได้ "รอคน" ถ้าติดทุกแถวจะกลายเป็นป้ายที่ทุกคนเลิกมอง
    const inWaitingQueue = needsHuman || (state.inbox.filter ?? null) === "needs";
    const waitingSince = inWaitingQueue ? waitingForHumanSince(c) : 0;
    const queueStatus = humanQueueStatus(c, { inNeedsQueue: inWaitingQueue });
    return el("a", {
      class: `convo-row${unread ? " is-unread" : ""}${c.line_user_id === activeId ? " is-active" : ""}`,
      href: roomHash(state.inbox.filter, c.line_user_id),
    },
      avatarEl(c),
      el("span", { class: "convo-main" },
        el("span", { class: "convo-top" },
          el("strong", { class: "convo-name" }, customerLabel(c)),
          el("time", { class: "convo-time" }, timeAgo(c.activity_at ?? c.last_message_at)),
        ),
        el("span", { class: "convo-bottom" },
          // W3: หลายสาขาค่อยติดป้ายสาขาบนแถว — สาขาเดียวไม่ต้องรก
          multiChannel && c.channel_id
            ? el("span", { class: "badge badge-branch" }, channelName?.(c.channel_id) || c.channel_id)
            : null,
          queueStatus ? el("span", { class: `badge ${queueStatus.className}`, title: queueStatus.title }, queueStatus.label) : null,
          waitingSince
            ? el("span", {
                class: "badge badge-red badge-wait",
                title: "ลูกค้าทักไว้แล้วยังไม่มีคนตอบ — นับจากข้อความล่าสุดของลูกค้า",
              }, `⏳ รอ ${timeAgo(waitingSince)}`)
            : null,
          inWaitingQueue && touchesMoney(c)
            ? el("span", {
                class: "badge badge-orange badge-money",
                title: "ห้องนี้แตะเรื่องเงินแล้ว (เห็นยอด/ส่งเลขบัญชี/มีสลิป) — พลาดแล้วเสียหายที่สุด",
              }, "💰 เส้นเงิน")
            : null,
          c.last_slip_status === "suspect"
            ? el("span", { class: "badge badge-orange", title: "สลิปล่าสุดตรวจแล้วน่าสงสัย" }, "⚠ สลิป")
            : null,
          // 28 ก.ย. 2026 (พี่ง้วง): AI ปิดต้องบอกว่าใครปิด — ม่วง = คนปิดเอง · แดง = ระบบปิด (เหตุอยู่ใน tooltip)
          // 5 ต.ค. 2026: เหลือง "AI off (not qualify)" = ตัวกวาดคัดกรองปิดเอง (สีมาจาก aiOffBadge ชุดเดียวกับทุกจุด)
          aiOff ? (aiOffBadge(c.ai_off) || el("span", { class: "badge badge-gray" }, "AI ปิด")) : null,
          followupSuppressionBadge(c),
          lineOaContextBadge(c.line_oa_context),
          // 6 ต.ค. 2026 ค่ำ: ป้าย AD + ชื่อแอดที่พาห้องนี้มา (แบบป้าย ad_id ในกล่องข้อความ Meta)
          adReferralChip(c.ad_referral),
          c.is_legacy ? el("span", { class: "badge badge-gray" }, "ระบบเก่า · อ่านอย่างเดียว") : null,
          c.human_owner && queueStatus?.key !== "assigned"
            ? el("span", { class: "badge badge-owner", title: "มอบหมายเจ้าของห้องแล้ว" }, `👤 ${c.human_owner}`)
            : null,
          stagedFollowupBadge(c.staged_followup_preview),
          el("span", { class: "preview" }, /^\[(?:sticker|สติกเกอร์)\]/iu.test(String(c.last_message || "")) ? "🙂 สติกเกอร์" : (c.last_message || "—")),
          unread ? el("span", { class: "unread-dot", "aria-label": "มีข้อความใหม่" }) : null,
        ),
      ),
    );
  }

  function searchBox(rerender) {
    const input = el("input", {
      class: "convo-search-input keep-focus", type: "search",
      placeholder: "ค้นหาชื่อ หรือทุกข้อความ…", value: state.inbox.q,
      "aria-label": "ค้นหาบทสนทนา",
      oninput: (e) => {
        clearTimeout(searchTimer);
        const value = e.target.value.trim();
        searchTimer = setTimeout(() => {
          if (value === state.inbox.q) return;
          state.inbox.q = value;
          state.inbox.extra = [];
          rerender();
        }, 350);
      },
    });
    return el("div", { class: "convo-search" },
      el("span", { class: "convo-search-icon", "aria-hidden": "true" }, "⌕"),
      input,
      state.inbox.q
        ? el("button", {
            class: "convo-search-clear", "aria-label": "ล้างคำค้น",
            onclick: () => {
              state.inbox.q = "";
              state.inbox.extra = [];
              rerender();
            },
          }, "✕")
        : null,
    );
  }

  // build หนึ่งรอบ render — head 30 แถวสด + หน้าเพิ่มที่โหลดไว้ (dedupe กันแถวขยับหน้า)
  // onRowDone(room) = หลังกดปุ่มลัดบนแถว (✓ เสร็จสิ้น/สแปม/ไม่ใช่สแปม) — หน้าแชทใช้ไปห้องถัดไปเมื่อเป็นห้องที่เปิดอยู่
  function build({ data, activeId = null, rerender, onRowDone = null }) {
    syncScope();
    const active = FILTERS.find((f) => f.key === (state.inbox.filter ?? null)) || FILTERS[0];
    const seen = new Set();
    const rows = [];
    for (const row of [...(data.conversations || []), ...state.inbox.extra]) {
      if (seen.has(row.line_user_id)) continue;
      seen.add(row.line_user_id);
      rows.push(row);
    }
    if (!state.inbox.extra.length) state.inbox.hasMore = data.hasMore === true;

    const emptyKey = state.inbox.q ? "search" : (active.key || "all");
    const multiChannel = (state.channels?.length ?? 0) > 1;
    const scrollKey = `inbox:${state.channel || "all"}:${active.key || "all"}:${state.inbox.q || ""}`;
    const list = el("div", { class: "convo-list", "data-scroll-key": scrollKey },
      rows.length === 0
        ? el("p", { class: "empty" }, EMPTY_TEXT[emptyKey])
        : rows.map((c) => {
            const done = onRowDone || (() => rerender());
            if (isWaitingFilter(active.key)) return waitingRow(c, activeId, multiChannel, done);
            if (isHotFollowFilter(active.key)) return hotFollowRow(c, activeId, multiChannel);
            if (active.key === "spam") return spamRow(c, activeId, multiChannel, done);
            return convoRow(c, activeId, multiChannel);
          }),
      state.inbox.hasMore
        ? el("button", {
            class: "btn btn-outline convo-more",
            onclick: () => loadMore(rerender),
          }, `โหลดเพิ่ม (แสดง ${rows.length} รายการ)`)
        : null,
    );
    // auto-load เมื่อเลื่อนใกล้ท้ายรายการ — ปุ่มยังอยู่เผื่อคนถนัดกด
    list.addEventListener("scroll", () => {
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 160) loadMore(rerender);
    }, { passive: true });

    return el("aside", { class: "convo-pane", "aria-label": "รายการแชท" },
      el("div", { class: "convo-head" }, searchBox(rerender)),
      channelChips(state, rerender),
      filterChips(data.counts, active.key),
      el("p", { class: "filter-explain" }, active.explain),
      list,
    );
  }

  return { build, loadMore };
}
