// scheduleCheckIn.mjs — "ขอเช็คคิวก่อน" → ทักหนึ่งครั้งแทนบันไดปกติ (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//
// บันไดปกติ (stagedFollowups) ยังทำงานกับลูกค้าที่บอกว่าขอไปเช็คคิวก่อน: hot ของ FB ทักใน ~45 นาที
// cold ของ FB ที่เงียบตอนหัวค่ำโดนสามไม้ติดกันในเช้าเดียว — ลูกค้ารู้สึกถูกจี้ทั้งที่บอกแล้วว่าจะกลับมาเอง
// ไฟล์นี้แทนบันไดของ "episode นั้น" ด้วยการทักหนึ่งครั้ง แล้วหยุด (ลูกค้าพิมพ์อะไรก็ตาม = คุยปกติ)
//
// เวลา (ต่างกันตามช่องเพราะกติกา follow-up ของสองช่องต่างกัน):
//   LINE — ไม่มีหน้าต่างส่ง: อีกสองวันช่วงสาย ๆ 10:00–11:30 (หรือวันถัดจากวันที่ลูกค้าบอกว่าจะแจ้ง)
//          เกิน 7 วันนับจากวันที่ลูกค้าขอ = ไม่ทัก (ปล่อยให้เขากลับมาเอง)
//   FB   — Meta ให้ข้อความอัตโนมัติได้ภายใน 24 ชม. หลังข้อความล่าสุดของลูกค้าเท่านั้น (HUMAN_AGENT 7 วัน
//          เป็นของคนตอบเอง ห้ามบอทใช้): 18–22 ชม. หลังข้อความลูกค้าถ้าตกช่วงกลางวัน ไม่งั้นช่องกลางวัน
//          "ท้ายสุด" ที่ห่างอย่างน้อย 6 ชม. และก่อนประตูปิด (เผื่อ 30 นาที) — ไม่มีช่อง = ไม่ทัก
import { brandText } from "./brand.mjs";
import { SCHEDULE_CHECK_KIND, parseScheduleMarker } from "./scheduleCheck.mjs";
import {
  DAY_MS, HOUR_MS, MINUTE_MS, bangkokDayStart, bangkokIsoDate, daytimeIntervals, hashUnit, isoDayStart,
  lateMorningDue, pickInIntervals,
} from "./followupTiming.mjs";
import { isOpenRound, roundShortThai, roundsMentionedIn, roundsOfDiscussedClass } from "./openRounds.mjs";

export const SCHEDULE_CHECK_STAGE = SCHEDULE_CHECK_KIND;
// ต้องตรงกับ FB_MESSAGING_WINDOW_MS ใน db.mjs (เทสต์ยืนยัน) — ไม่ import db.mjs เพื่อให้ไฟล์นี้ pure
const FB_WINDOW_MS = 24 * HOUR_MS - 5 * MINUTE_MS;
export const FB_CHECKIN_MARGIN_MS = 30 * MINUTE_MS;
const FB_PREFERRED_FROM_MS = 18 * HOUR_MS;
const FB_PREFERRED_TO_MS = 22 * HOUR_MS;
const FB_FALLBACK_MIN_MS = 6 * HOUR_MS;
const FB_FALLBACK_TAIL_MS = 20 * MINUTE_MS;
const LINE_DEFAULT_DAYS = 2;
const LINE_MIN_GAP_MS = 12 * HOUR_MS;
const MAX_AHEAD_MS = 7 * DAY_MS;

const isFacebook = (channelId) => String(channelId || "") === "facebook";

function planFacebook({ customerId, lastInboundAt, hintIso }) {
  const deadline = lastInboundAt + FB_WINDOW_MS - FB_CHECKIN_MARGIN_MS;
  const unit = hashUnit(customerId, lastInboundAt, "schedule_check");
  const preferred = daytimeIntervals(lastInboundAt + FB_PREFERRED_FROM_MS, Math.min(lastInboundAt + FB_PREFERRED_TO_MS, deadline));
  let dueAt = pickInIntervals(preferred, unit);
  if (dueAt === null) {
    const fallback = daytimeIntervals(lastInboundAt + FB_FALLBACK_MIN_MS, deadline);
    const last = fallback.at(-1);
    if (!last) return { skip: "fb_no_daytime_slot" };
    dueAt = pickInIntervals([[Math.max(last[0], last[1] - FB_FALLBACK_TAIL_MS), last[1]]], unit);
  }
  // ลูกค้าบอกเองว่าจะแจ้งวันหลังกว่านั้น = ห้ามทักก่อนวันที่เขาให้ไว้ (และหลังจากนั้นประตูก็ปิดแล้ว)
  if (hintIso && hintIso > bangkokIsoDate(dueAt)) return { skip: "customer_named_later_date" };
  return { dueAt };
}

function planLine({ customerId, deferralAt, lastInboundAt, hintIso }) {
  const baseDay = hintIso ? isoDayStart(hintIso) + DAY_MS : bangkokDayStart(deferralAt) + LINE_DEFAULT_DAYS * DAY_MS;
  const dueAt = lateMorningDue({
    earliestMs: Math.max(lastInboundAt, deferralAt) + LINE_MIN_GAP_MS,
    notBeforeMs: baseDay,
    unit: hashUnit(customerId, deferralAt, "schedule_check"),
  });
  if (dueAt === null || dueAt - deferralAt > MAX_AHEAD_MS) return { skip: "beyond_7_days" };
  return { dueAt };
}

/** เวลาทักหนึ่งครั้ง — { dueAt } หรือ { skip: เหตุผล } (pure: badge กับเวลายิงจริงต้องตรงกัน) */
export function planScheduleCheckIn({ channelId = "", customerId = "", deferralAt, lastInboundAt, hintIso = null }) {
  const deferral = Number(deferralAt);
  const lastIn = Math.max(Number(lastInboundAt) || 0, deferral);
  if (!Number.isFinite(deferral)) return { skip: "invalid_marker" };
  return isFacebook(channelId)
    ? planFacebook({ customerId, lastInboundAt: lastIn, hintIso })
    : planLine({ customerId, deferralAt: deferral, lastInboundAt: lastIn, hintIso });
}

/**
 * episode ของห้องนี้เป็น "ขอเช็คคิวก่อน" ไหม — null = ใช้บันไดปกติ
 * คืน { stage, ladder, schedule, marker, skip? } ที่ stagedFollowups ใช้แทนบันไดของ episode นี้:
 *   ladder ["schedule_check"] = ทักหนึ่งครั้ง · ladder [] = ไม่ทักเลย (บันไดปกติก็ไม่กลับมาใน episode นี้)
 */
export function scheduleCheckEpisode({ enabled = false, deferJson = "", lastInboundAt = null, channelId = "", customerId = "" } = {}) {
  if (enabled !== true) return null;
  const marker = parseScheduleMarker(deferJson);
  const lastIn = Number(lastInboundAt) || 0;
  if (!marker || !lastIn || marker.at > lastIn + MINUTE_MS) return null;
  // ทักไปแล้ว และลูกค้าพิมพ์กลับมาหลังจากนั้น = คุยกันต่อตามปกติ
  if (marker.sentAt && lastIn > marker.sentAt) return null;
  const plan = planScheduleCheckIn({ channelId, customerId, deferralAt: marker.at, lastInboundAt: lastIn, hintIso: marker.hint });
  if (plan.skip) return { stage: SCHEDULE_CHECK_STAGE, ladder: [], schedule: [], marker, skip: plan.skip };
  return {
    stage: SCHEDULE_CHECK_STAGE,
    ladder: [SCHEDULE_CHECK_KIND],
    schedule: [{ kind: SCHEDULE_CHECK_KIND, at: { type: "at", dueAt: plan.dueAt } }],
    marker,
  };
}

/* ------------------------------- ข้อความทัก ------------------------------- */
// ข้อความคงที่ ไม่ให้โมเดลร่าง: เนื้อหาคือเรื่องเดียว (ได้เช็คคิวแล้วสะดวกรอบไหน) + รอบที่ยังเปิดจริง
// โมเดลเสี่ยงเติมคำเร่ง/ที่นั่งเหลือ/กันที่ให้ ซึ่งเป็นกติกาเหล็ก ส่วนข้อความคงที่ตรวจด้วยเทสต์ได้ทุกตัวอักษร
// (ยังผ่าน compliance guard + humanizer + ตัวตรวจ JEV + ด่านสด ๆ ก่อนส่งเหมือน follow-up ทุกข้อความ)

function roundsForCheckIn(rounds, recentTexts) {
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const mentioned = roundsMentionedIn(recentTexts, rounds).filter(isOpenRound).sort(byDate).slice(0, 3);
  if (mentioned.length) return mentioned;
  return roundsOfDiscussedClass(recentTexts, rounds).filter(isOpenRound).sort(byDate).slice(0, 2);
}

// พี่ง้วง 29 ต.ค.: คำถามรอบต้องถ่อมตัว — เดิม "ได้เช็คคิวแล้วสะดวกรอบไหนคะ" (ห้วน)
const CHECKIN_ASK = "ไม่ทราบว่าได้เช็คคิวแล้วสะดวกรอบไหนดีนะคะ";

function joinThai(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} และ ${items.at(-1)}`;
}

/**
 * ข้อความทักหนึ่งครั้ง — name = คำเรียกที่ผ่าน planCustomerAddress แล้ว ("คุณเอ") หรือ "" (ไม่เรียกชื่อ)
 * rounds = รอบในอนาคตจากแหล่งเดียวกับเส้นตอบ · recentTexts = ข้อความล่าสุดของห้อง (หารอบที่เพิ่งส่งให้ดู)
 */
export function scheduleCheckInText({ channelId = "", customerId = "", anchorMs = 0, name = "", rounds = [], recentTexts = [] } = {}) {
  const chosen = roundsForCheckIn(rounds, recentTexts).map(roundShortThai);
  const roundsLine = chosen.length ? `ตอนนี้รอบ ${joinThai(chosen)} ยังเปิดรับอยู่ค่ะ` : "";
  const greeting = `สวัสดีค่ะ${name ? name : ""} 😊`;
  if (isFacebook(channelId)) {
    return [`${greeting} ${CHECKIN_ASK}`, roundsLine].filter(Boolean).join(" ");
  }
  const variant = hashUnit(customerId, anchorMs, "schedule_check_text") < 0.5 ? 0 : 1;
  const opener = variant === 0
    ? `${greeting} ${CHECKIN_ASK}`
    : `${name ? `${name}คะ` : "สวัสดีค่ะ"} ${CHECKIN_ASK} 😊`;
  const closer = brandText("ไม่ต้องรีบนะคะ ได้วันไหนพิมพ์บอกลูกแพรได้เลยค่ะ");
  return [opener, [roundsLine, closer].filter(Boolean).join(" ")].join("\n");
}
