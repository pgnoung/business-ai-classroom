import { activeBrand, brandText, isGenericProfile } from "./brand.mjs";
import { selectReview, selectJourneyEvidence, parseCatalogText } from "./reviewSelection.mjs";
import { SYSTEM_SHOWCASE_LABEL, isSystemShowcase } from "./showcaseCases.mjs";
import { ENDS_WITH_QUESTION_RE } from "./bubbleOrder.mjs";
import { reviewFollowup } from "./jevFollowupReview.mjs";
import { serviceFollowupPaused } from "./serviceBoundary.mjs";
import { dropGenericAddress, enforceCustomerAddressAll, planCustomerAddress } from "./customerAddress.mjs";
// stagedFollowups.mjs — v1.4.6: sub-agent follow-up ตามสเตจลูกค้า (คำสั่งพี่ง้วง 2026-08-16
// แรงบันดาลใจจาก Klangtech: agent หลายตัวคุมจังหวะลูกค้าคนละสเตจ)
//
// หลักการ:
// - agent หลัก (เส้น reactive) คุยปกติ — engine นี้ทำงานเฉพาะตอน "ลูกค้าเงียบ"
// - สเตจอ่านจาก warmthBand(last_score) แหล่งเดียวกับ prompt (hot>=8, warm 5-7, cold อื่น ๆ)
// - บันไดต่อสเตจ (ทุกขั้นจบด้วยคำถามเสมอ):
//     cold: คำถามตามบริบท ทุก 1 ชม. — เพดานตลอดชีพ 3 ครั้ง (สเปคพี่ง้วง)
//     warm: เงียบ 30 นาที → รีวิวตรงบริบท; +30 → รูปบรรยากาศคลาส; +30 → คำถาม warm
//     hot:  เงียบ 30 นาที → รีวิวอีกใบ (ห้ามซ้ำใบเดิม) + คำถามแบบ hot
// - ตัวจับเวลา = ความเงียบตั้งแต่ข้อความล่าสุด "ทั้งสองทิศ" — ลูกค้าตอบ = เริ่ม episode ใหม่
// - กันรำคาญ (เคสพี่ง้วง: ตอบกลับแล้วโดน push ซ้ำใน 30 นาที):
//     episode ถัดไปในวันเดียวกันต้องเงียบนานขึ้นเท่าตัว (30→60→120 นาที เพดาน 4 ชม.)
//     + เพดานต่อวัน 3 "รอบทัก" ต่อลูกค้า + รีวิวไม่ซ้ำตลอดชีพ + รูปบรรยากาศไม่ซ้ำ
//
//     ระวังตรงนี้: เพดานนับ "รอบ" ไม่ใช่ "ข้อความ" — หนึ่งรอบส่งได้หลายบอลลูน
//     (รีวิว + คำถาม + รูป) ของจริงที่วัดได้ 2026-08-27 คือ 3 รอบ = 6 ข้อความถึงลูกค้า
//     คอมเมนต์เดิมเขียนว่า "3 ข้อความ" ซึ่งทำให้เข้าใจผิดว่าลูกค้าได้รับแค่ 3
//
//     พี่ง้วงตัดสินใจ 2026-08-27 ให้คงไว้แบบนี้: ต้องการให้รู้สึกเหมือนคนพิมพ์
//     หลายบรรทัดติดกัน ไม่ใช่บอทยิงทีละบรรทัด — อย่า "แก้ให้ถูก" เป็น 3 ข้อความ
//     โดยไม่ถามเจ้าของก่อน
// - guard ก่อนส่ง (แบบแผน followupEngine + operator_active_until ที่ engine เดิมไม่ได้เช็ค):
//     สวิตช์ global → followup_enabled รายตัว → ai_enabled+AI_ACTIVE → do_not_disturb →
//     marketing_consent → operator ไม่ได้คุมอยู่ → ไม่อยู่ quiet hours 21:00-09:00 →
//     compliance guard เต็ม → เช็คซ้ำสด ๆ ก่อนยิง
// - ส่งผ่าน lineRegistry เท่านั้น (pilot allowlist บังคับที่ชั้น lineClient — ห้ามยิง API ตรง)
// - ส่งล้มกลางลูป: บันทึก delivered subset เสมอ (บทเรียนโควตาหมด 2026-08-15)
import { aiPausedNow } from "./aiPause.mjs";
import { withCampaignReceiptPolicy } from "./campaignReceiptPolicy.mjs";
import { createLock } from "./locks.mjs";
import { composeBrandPackOnly, composeKnowledgeForChannel } from "./knowledgePack.mjs";
import { knowledgeForDraftReview, knowledgeForPrompt } from "./reviewCatalogPrompt.mjs";
import { applyKnownFactsOverride } from "./pipeline.mjs";
import { approvedClassAmounts, outboundCarriesClassPrice } from "./priceDisclosure.mjs";
import { selectRelevantBrandPack } from "./brainPackSelector.mjs";
import { createHash } from "node:crypto";
import { inQuietHours, nextQuietEnd } from "./followupEngine.mjs";
import { warmthBand } from "./conversationStyle.mjs";
import { chatStyleRule, readChatStyle } from "./chatStyle.mjs";
import { presetButtonPhrases } from "./presetButtons.mjs";
import { naturalVoiceMode } from "./writerVoice.mjs";
import { loadImageCatalog } from "./imageCatalog.mjs";
import { ATMOSPHERE_IMAGES } from "./imageSuggestion.mjs";
import { truncateCodePoints } from "./unicodeText.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { selectFollowupKnowledge } from "./brain/followupKnowledge.mjs";
import { formatSystemCorrectionSource } from "./correctionCapture.mjs";
import { ownerLessonMetadata, recordOwnerLessonUse, withOwnerLessonRules } from "./ownerLessons.mjs";
import { followupDecisionInstructions, parseFollowupDraftDecision } from "./followupDraftDecision.mjs";
// 2026-09-28 (คำสั่งพี่ง้วง "ขอเช็คคิวก่อน"): episode ที่ลูกค้าขอไปเช็คคิวเอง = ทักหนึ่งครั้งแทนบันได
import { scheduleCheckFollowupEnabled } from "./scheduleCheck.mjs";
import { FB_CHECKIN_MARGIN_MS, SCHEDULE_CHECK_STAGE, scheduleCheckEpisode, scheduleCheckInText } from "./scheduleCheckIn.mjs";
import { currentUpcomingRounds } from "./roundsSource.mjs";
import { bangkokIsoDate, daytimeIntervals, pickInIntervals } from "./followupTiming.mjs";
import { FB_MESSAGING_WINDOW_MS } from "./db.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
// รีวิวเคสจริง 6–7 ต.ค.: ทักตามกลับไปที่เรื่องที่ค้างเรื่องเดียว (ห้อง reply_engine = v3 เท่านั้น)
import { followupRows, followupThreadEnabled, GENERIC_FOLLOWUP_EXAMPLES, pickFollowupThread, stripGenericFollowup,
  threadDeliversItem, threadDeliversPrice, threadNeedsQuestion, threadRuleLines, THREAD_USER_TEXT } from "./followupThread.mjs";
// 12 ต.ค. 2026 (คำสั่งพี่ง้วง): ทักตามที่แจ้งราคาที่ค้าง ใช้บล็อกค่าเรียนจากชุดราคาที่อนุมัติ (ตัวเดียวกับช่อง {{ราคา}} ของ v3) — ไม่พิมพ์ตัวเลขเอง
import { knowledgeEntriesFor } from "./replyEngineV3/turnFacts.mjs";
import { priceFactsFromKnowledge, renderPriceSlot } from "./replyEngineV3/priceFacts.mjs";
// 12 ต.ค. 2026 (พี่ง้วง "รูปส่งได้มากกว่า 1 ครั้ง ไม่ว่าจะ follow หรือคุยปกติ"): ทักตามของห้อง v3 แนบรีวิวคนจริง → รูปบรรยากาศ
// → คำชวนทดลองเรียนฟรี (จำกัดสิทธิ์ต่อวันจริง) → รีวิวเพิ่ม — ตัวตัดสินเดียวกับเส้นตอบแชท (socialProof.mjs) + ด่านคำชวน (trialInvites.mjs)
import { atmosphereCaption, followupFading, followupReviewIntro, followupSocialRuleLines, planFollowupSocialProof, stripFakeScarcity,
  trialInviteBubble } from "./replyEngineV3/socialProof.mjs";
import { trialDeliveredText, trialInviteGate } from "./trialInvites.mjs";
import { legacyIdentityPending } from "./aiPausePolicy.mjs";
import { reviewUrlKey } from "./reviewSelection.mjs";
import { scopedPersona, withRoomSoul } from "./soul/index.mjs";
import { withFollowupTeacher } from "./replyStyle/followupTeacher.mjs";
import { FOLLOWUP_BANK_PLACEHOLDER, followupStyleBankMode, loadStyleBank, withFollowupExamples } from "./replyStyle/styleBank.mjs";
export { followupThreadEnabled };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ตารางเวลารายขั้น (คำสั่งเจ้าของ 2026-08-28 หลังทบทวนจังหวะของธุรกิจ high-ticket)
//
// ของเดิมใช้ "ความห่าง" ค่าเดียวต่อกลุ่ม ทุกขั้นจึงห่างเท่ากันหมด ผลคือ warm ได้
// 6-9 ข้อความภายในชั่วโมงเดียวแล้วเงียบหายไปเลย — ใช้กระสุนหมดก่อนลูกค้าเริ่มคิด
//
// ของใหม่นับ offset จาก episode_anchor (= ข้อความล่าสุดของ "ลูกค้า") ไม่ใช่ระยะห่าง
// จากครั้งก่อน คำว่า "วันที่ 3" จึงหมายถึงวันที่ 3 นับจากลูกค้าเงียบจริง ๆ
// ถ้าใช้ระยะห่างสะสม [4ชม., 3วัน, 7วัน] ครั้งสุดท้ายจะไปตกวันที่ 10 ซึ่งผิดคำสั่ง
//
//   at.type "after"   → anchor + ms
//   at.type "morning" → 09:00 ถัดไปหลัง anchor + afterMs
export const STAGE_SCHEDULE = Object.freeze({
  // cold: วันละครั้ง 4 วันติด (วันแรกหลังเงียบ 3 ชม.)
  cold: Object.freeze([
    { kind: "question", at: { type: "after", ms: 3 * HOUR_MS } },
    { kind: "question", at: { type: "after", ms: DAY_MS + 3 * HOUR_MS } },
    { kind: "question", at: { type: "after", ms: 2 * DAY_MS + 3 * HOUR_MS } },
    { kind: "question", at: { type: "after", ms: 3 * DAY_MS + 3 * HOUR_MS } },
  ]),
  // warm: ให้เวลาคิด — คนกำลังชั่งใจกับของราคาสูง ไม่ใช่คนที่ต้องถูกเร่ง
  warm: Object.freeze([
    { kind: "review", at: { type: "after", ms: 4 * HOUR_MS } },
    { kind: "atmosphere", at: { type: "after", ms: 3 * DAY_MS } },
    { kind: "question", at: { type: "after", ms: 7 * DAY_MS } },
  ]),
  // hot: บทสนทนายังเปิดอยู่ ทักเร็วได้ แต่แค่สองครั้ง แล้วปล่อยให้เขาคุมจังหวะ
  hot: Object.freeze([
    { kind: "review_question", at: { type: "after", ms: 45 * MINUTE_MS } },
    { kind: "question", at: { type: "morning", afterMs: 45 * MINUTE_MS } },
  ]),
});

// Facebook ปิดประตูเมื่อลูกค้าเงียบครบ 24 ชม. (withinFacebookWindow) — ตารางกลางของ cold
// ไปตกวันที่ 2/3/4 ซึ่งยิงไม่ได้เลย เหลือใช้จริงแค่ไม้แรก คำสั่งพี่ง้วง 2026-08-30 คือบีบ
// เฉพาะ cold ของช่องนี้ให้จบในหน้าต่าง: 1 ชม. → +6 ชม. → +6 ชม. (= 1/7/13 จาก anchor)
// warm/hot ยังใช้ตารางกลาง — hot อยู่ในหน้าต่างอยู่แล้ว ส่วน warm รอเจ้าของเคาะแยก
// เพดานเวลาของช่องนี้ไม่ใช่ 24 ชม. เต็ม แต่คือ ~11-12 ชม.: ไม้ที่ตกหลัง 21:00 จะถูกเลื่อน
// ไป 09:00 ถัดไป ซึ่งสำหรับ anchor ตอนเช้าจะกลายเป็น ~24 ชม. พอดี = ชนกำแพงแล้วถูกข้ามทิ้ง
// จึงวางไม้สุดท้ายของทุกระดับไว้ไม่เกิน 11 ชม. — พิสูจน์ทุก anchor ใน fb-fu-ladder.test.mjs
export const FACEBOOK_STAGE_SCHEDULE = Object.freeze({
  // cold: ทักมาถามแล้วหาย — ใช้วันเดียวให้คุ้ม 3 ไม้ (พี่ง้วงสั่ง 1 ชม. แล้วเว้น ~6 ชม.)
  cold: Object.freeze([
    { kind: "question", at: { type: "after", ms: 1 * HOUR_MS } },
    { kind: "question", at: { type: "after", ms: 6 * HOUR_MS } },
    { kind: "question", at: { type: "after", ms: 11 * HOUR_MS } },
  ]),
  // warm: กำลังชั่งใจของหลักหมื่น — คงเจตนาเดิม "ให้เวลาคิด ไม่เร่ง" จึงเหลือ 2 ไม้ ห่างกว่า cold
  // ไม้ท้ายเป็น "คำถาม" ไม่ใช่บรรยากาศ เพราะบน Facebook คำตอบของลูกค้า = รีเซ็ตหน้าต่าง 24 ชม.
  warm: Object.freeze([
    { kind: "review", at: { type: "after", ms: 4 * HOUR_MS } },
    { kind: "question", at: { type: "after", ms: 11 * HOUR_MS } },
  ]),
  // hot: บทสนทนายังเปิด ทักเร็วได้ แต่ "แค่สองครั้ง" ตามที่เจ้าของวางไว้ — ต่างจากตารางกลาง
  // ตรงที่ไม้สองย้ายจาก "เช้าวันถัดไป" (เสี่ยง ~24 ชม. จน Meta ปิดประตูก่อน) มาเป็นเย็นวันเดียวกัน
  hot: Object.freeze([
    { kind: "review_question", at: { type: "after", ms: 45 * MINUTE_MS } },
    { kind: "question", at: { type: "after", ms: 8 * HOUR_MS } },
  ]),
});

export const FACEBOOK_CHANNEL_ID = "facebook";

// LINE ทักได้วันละครั้งเพราะบันไดกินเวลาหลายวัน — Facebook บีบทั้งเส้นลงวันเดียว ถ้าใช้
// เพดานเดียวกันไม้ที่ 2-3 จะโดน daily_cap กินทุกครั้งและไม่มีวันได้ยิงก่อนประตูปิด
export const FACEBOOK_DAILY_PROACTIVE_CAP = 3;

export function dailyProactiveCapFor(channelId = "") {
  return String(channelId) === FACEBOOK_CHANNEL_ID ? FACEBOOK_DAILY_PROACTIVE_CAP : DAILY_PROACTIVE_CAP;
}

// ตารางที่ใช้จริงของช่องนั้น — ช่องที่ไม่มีตารางเฉพาะจะได้ตารางกลางทั้งชุด
export function scheduleTableFor(channelId = "") {
  return String(channelId) === FACEBOOK_CHANNEL_ID
    ? { ...STAGE_SCHEDULE, ...FACEBOOK_STAGE_SCHEDULE }
    : STAGE_SCHEDULE;
}

// คงรูปเดิมไว้ให้ผู้เรียกทุกตัว (ladder[i] / ladder.length) ไม่ต้องแก้ตาม
export const STAGE_LADDERS = Object.freeze(Object.fromEntries(
  Object.entries(STAGE_SCHEDULE).map(([stage, steps]) => [stage, steps.map((step) => step.kind)]),
));

// cold มี 4 ขั้นแล้ว เพดานตลอดชีพต้องขยับตาม ไม่งั้นขั้นที่ 4 ถูกตัดทิ้งทุกครั้ง
export const COLD_LIFETIME_CAP = 4;
// 1 รอบ/วัน/คน (ของเดิม 3) — 1 รอบยังส่งได้หลายบับเบิลตาม funnel เหมือนเดิม
export const DAILY_PROACTIVE_CAP = 1;
// เงียบเกิน 10 วันจึงเลิกทัก (ของเดิม 3 วัน) — จังหวะใหม่ยาวถึงวันที่ 7 ถ้าคง 3 วันไว้
// ขั้นท้าย ๆ จะไม่มีวันได้ยิงเลย
const ACTIVE_WITHIN_MS = 10 * DAY_MS;
// ห้ามทักซ้อนทันทีหลังใครก็ตามเพิ่งพิมพ์ (แอดมินเพิ่งตอบเอง หรือบับเบิลก่อนหน้าของเราเอง)
const MIN_QUIET_AFTER_ACTIVITY_MS = 45 * MINUTE_MS;

// --- สุ่มจังหวะ (คำสั่งเจ้าของ: "อย่าให้เป็นบอทแบบเป๊ะเกิน") ---
//
// ใช้ hash ของ (ห้อง, anchor, ขั้น) แทน Math.random เพราะต้องได้ค่าเดิมทุกครั้งที่ถาม
// เหตุผลสองข้อ: (1) badge บนคอนโซลกับเวลาที่ยิงจริงต้องตรงกัน ไม่งั้น badge โกหก
// (2) เทสต์ต้องคุมผลลัพธ์ได้ ไม่ flaky
const JITTER_RATIO = 0.15;
const JITTER_CAP_MS = 30 * MINUTE_MS;
const MORNING_JITTER_MS = 40 * MINUTE_MS;

function hashUnit(...parts) {
  return createHash("sha256").update(parts.map(String).join("|")).digest().readUInt32BE(0) / 2 ** 32;
}

export function stepJitterMs(customerId, anchorMs, stepIndex, step) {
  const unit = hashUnit(customerId, anchorMs, stepIndex);
  // ขั้น "เช้าวันถัดไป" บวกอย่างเดียว จะได้ไม่ถอยกลับเข้าช่วงเงียบ
  if (step?.at?.type === "morning") return Math.round(unit * MORNING_JITTER_MS);
  const span = Math.min(JITTER_RATIO * (step?.at?.ms ?? 0), JITTER_CAP_MS);
  return Math.round((unit * 2 - 1) * span);
}

// ค่าจาก env (STAGED_*_DELAY_MS) ปรับได้เฉพาะ "ขั้นที่ 1" ขั้นที่เหลืออยู่ในตารางนี้
// จงใจไม่เปิดให้ตั้งขั้นระดับวันผ่าน env เพราะตัวห่อ deploy บังคับเพดาน 24 ชม.
export function scheduleFor(stage, overrideStep1Ms = null, channelId = "") {
  const base = scheduleTableFor(channelId)[stage] ?? [];
  // Facebook ไม่รับค่า override ไม้แรกจาก env: ตารางของช่องนี้ถูกคำนวณให้พอดีหน้าต่าง 24 ชม.
  // ของ Meta (ไม้ท้าย ≤ 11 ชม. + เลี่ยงช่วงเงียบ) ถ้าปล่อยให้ปุ่มกลางมาดันไม้แรก ลำดับไม้
  // อาจสลับกันเองหรือทะลุกำแพงโดยไม่มีใครรู้ตัว — จะปรับต้องแก้ FACEBOOK_STAGE_SCHEDULE
  if (String(channelId) === FACEBOOK_CHANNEL_ID) return base;
  if (!Number.isFinite(overrideStep1Ms) || !base.length) return base;
  const head = base[0].at.type === "after"
    ? { ...base[0], at: { type: "after", ms: overrideStep1Ms } }
    : base[0];
  const rest = base.slice(1).map((step) => (
    step.at.type === "morning" ? { ...step, at: { type: "morning", afterMs: overrideStep1Ms } } : step
  ));
  return [head, ...rest];
}

// จำนวนไม้ของบันไดตามช่อง — ต้องอ่านคู่กับ scheduleFor เสมอ ไม่งั้น ladder.length
// (ตัวตัดว่า "บันไดจบ") จะไม่ตรงกับตารางที่ใช้ยิงจริง
export function ladderFor(stage, channelId = "") {
  return (scheduleTableFor(channelId)[stage] ?? []).map((step) => step.kind);
}

// เวลาตามตารางของไม้หนึ่ง (anchor + ระยะ + สุ่ม) ก่อนด่านเว้นหลังความเคลื่อนไหว/ช่วงเงียบ
function plannedStepAt(step, anchor, customerId, stepIndex) {
  // 2026-09-28: type "at" = เวลาที่วางแผนมาแล้วทั้งก้อน (scheduleCheckIn.mjs กระจายเวลาเองแล้ว) — ไม่บวก jitter ซ้ำ
  if (step.at.type === "at") return Number(step.at.dueAt);
  const base = step.at.type === "morning" ? nextQuietEnd(anchor + step.at.afterMs) : anchor + step.at.ms;
  return base + stepJitterMs(customerId, anchor, stepIndex, step);
}

// ผู้ตรวจโค้ด 28 ก.ย. 2026 (พี่ง้วง "ทำต่อได้เลยครับ"): ห้อง Facebook ระดับ cold ที่ลูกค้าเงียบตอน 21:00 โดนทัก
// 3 รอบในเช้าเดียวภายใน 2 ชม. 17 นาที — ไม้ 1/6/11 ชม. ตกช่วงเงียบทั้งหมด ถูกเลื่อนไป 09:00 แล้วเหลือระยะห่าง
// แค่ด่าน 45 นาที = รู้สึกเหมือนถูกตาม ซึ่งพี่ง้วงไม่เอา
// กติกา: พอมีไม้ในรอบนี้ที่ถูกเลื่อนเพราะช่วงเงียบแล้ว ไม้ถัดไปต้องห่างจากไม้ก่อนหน้าที่ "ส่งจริง" อย่างน้อย
// เท่าระยะที่ตารางออกแบบไว้ (cold 5 ชม. · warm 7 ชม. · hot 7 ชม. 15 นาที) — การเลื่อนจึงดันไม้ที่เหลือตามไปด้วย
// ไม้ที่ยังไม่เคยมีการเลื่อน (ลูกค้าเงียบกลางวัน) = null = ตารางเดิมเป๊ะ (fb-fu-ladder-spacing.test.mjs เทียบทีละไม้)
// ใช้เฉพาะ Facebook — ตารางของ LINE ยาวหลายวันและเพดานวันละครั้งกันไม้ซ้อนอยู่แล้ว
export function facebookSpacingFloor({ schedule, stepIndex, anchorMs, customerId, previousSendMs, previousWasYolo = false }) {
  const step = schedule?.[stepIndex];
  const previous = schedule?.[stepIndex - 1];
  const lastSend = Number(previousSendMs);
  if (!previous || !(lastSend > 0) || step?.at?.type !== "after" || previous.at?.type !== "after") return null;
  const planned = schedule.slice(0, stepIndex).map((s, i) => plannedStepAt(s, Number(anchorMs), customerId, i));
  // ถูกเลื่อน = ไม้ก่อน ๆ มีตัวที่ตารางวางไว้กลางช่วงเงียบ หรือไม้ก่อนหน้าส่งจริงหลังคืนที่ตามหลังเวลาที่วางไว้
  // (เช่น ด่าน 45 นาทีดันเข้า 21:00 หรือทีมคุยอยู่จนเลยเวลา) — ส่งอัตโนมัติไม่มีวันเกิดในช่วงเงียบ จึงนับแบบนี้ได้ตรง
  // ผู้ตรวจโค้ด 28 ก.ย. (รอบสอง): ไม้ก่อนหน้าเป็นข้อความที่พี่ง้วงสั่งเอง (YOLO/Telegram) = ส่งนอกตารางได้ทุกเวลา
  // เช่น YOLO 19:30 แล้วไม้อัตโนมัติถัดไปตามมา 20:15 (ด่าน 45 นาที) — ต้องนับระยะจากข้อความนั้นเสมอ
  const deferred = previousWasYolo === true || inQuietHours(lastSend)
    || planned.some((at) => inQuietHours(at)) || lastSend >= nextQuietEnd(planned.at(-1));
  return deferred ? lastSend + (step.at.ms - previous.at.ms) : null;
}

/** ไม้ล่าสุดในประวัติเป็นข้อความ YOLO ไหม — รับทั้ง array (loadState) และ history_json (แถว state / แถว inbox) */
export function lastSendWasYolo(history) {
  let list = history;
  if (typeof history === "string") {
    try { list = JSON.parse(history || "[]"); } catch { return false; }
  }
  return Array.isArray(list) && list.at(-1)?.kind === "yolo";
}

export function resolveStepDueAt({ schedule, stepIndex, anchorMs, lastActivityMs, customerId, channelId = "", previousSendMs = null, previousWasYolo = false }) {
  const step = schedule?.[stepIndex];
  if (!step || !Number.isFinite(Number(anchorMs))) return null;
  const anchor = Number(anchorMs);
  let due = plannedStepAt(step, anchor, customerId, stepIndex);
  due = Math.max(due, Number(lastActivityMs ?? 0) + MIN_QUIET_AFTER_ACTIVITY_MS);
  if (String(channelId) === FACEBOOK_CHANNEL_ID) {
    const floor = facebookSpacingFloor({ schedule, stepIndex, anchorMs: anchor, customerId, previousSendMs, previousWasYolo });
    if (floor !== null) due = Math.max(due, floor);
  }
  // ไม่นัดในช่วงเงียบ 21:00-09:00 — เลื่อนไป 09:00 ถัดไปแล้วกระจายออกไม่ให้ทุกคนตรงกันเป๊ะ
  if (inQuietHours(due)) {
    due = nextQuietEnd(due) + Math.round(hashUnit(customerId, anchor, stepIndex, "q") * MORNING_JITTER_MS);
  }
  return due;
}

// ---- จัดไม้ของห้องที่ทักตามแบบมีเรื่องค้าง (reply_engine = v3 · รีวิวเคสจริง 6–7 ต.ค. รอบรีวิว 8) ----
// แผนจาก followupThread.pickFollowupThread → ไม้ของบันไดที่ใช้ได้ + เวลาเร็วสุด (เส้นยิงจริงกับ badge คอนโซลเรียกตัวเดียวกัน)
//   ขอเวลาคิด/ขั้นสมัคร = ข้ามไม้เร็ว (minStep 1) · รอปรึกษา/รอเงิน = ไม้แรกที่ตามตารางไม่ก่อนวันที่ 2/3 (บันได hot ไม่มี = ไม้ท้ายเลื่อนไปวันนั้น)
//   · ครั้งที่สองของเรื่องเดิม = ไม่ก่อนครั้งแรก + 20 ชม. (floorAt)
function stepBaseAt(step, anchorMs) {
  if (step?.at?.type === "at") return Number(step.at.dueAt);
  return step?.at?.type === "morning" ? nextQuietEnd(anchorMs + step.at.afterMs) : anchorMs + Number(step?.at?.ms ?? 0);
}
// ---- Facebook (หน้าต่าง 24 ชม. หลังข้อความล่าสุดของลูกค้า · คำสั่งเจนเพื่อพี่ง้วง รอบรีวิว 8) ----
// ไม้จริง 148 จาก 155 ของ 6–7 ต.ค. เป็น Facebook — วันที่ 2–3 / ห่าง ≥20 ชม. หลังครั้งแรก ไม่มีวันทันหน้าต่าง จึงใช้ช่อง "ช้า" ช่องเดียว:
//   ราว +20–22 ชม. หลังข้อความลูกค้า (เวลากลางวัน) · ไม่เกิน +23 ชม. และไม่เลยหน้าต่าง−ระยะเผื่อเดิมของการทักหลังขอเช็คคิว
//   · ไม่มีช่องกลางวันในช่วงนั้น = ช่องกลางวันท้ายสุดก่อนเส้นตาย (≥12 ชม. หลังข้อความลูกค้า) · ไม่มีเลย = ไม่ทัก
//   ขอเวลาคิด / รอปรึกษา / ครั้งที่สองของเรื่องเดิม (ห่างครั้งแรก ≥12 ชม.) ใช้ช่องนี้ · รอเงินเดือน = ไม่ทักบน FB (+20 ชม. เร็วเกินสำหรับคนรอเงินเดือน)
//   · ครั้งแรกของเรื่องเดิมและขั้นสมัครใช้ไม้ของบันได FB ตามเดิม (อยู่ในหน้าต่างอยู่แล้ว)
const FB_LATE_FROM_MS = 20 * HOUR_MS;
const FB_LATE_TO_MS = 22 * HOUR_MS;
const FB_LATE_LATEST_MS = 23 * HOUR_MS;
const FB_LATE_EARLIEST_MS = 12 * HOUR_MS;
const FB_TOUCH_GAP_MS = 12 * HOUR_MS;
const FB_FALLBACK_TAIL_MS = 20 * MINUTE_MS;
// ช่องที่วางต้องจบก่อนเส้นตายเท่านี้ — รอบตรวจ 60 วินาที + ด่านสด ๆ ก่อนยิง ไม่ทำให้เลย +23 ชม.
const FB_SEND_SLACK_MS = 15 * MINUTE_MS;
/** เส้นตายของไม้ "ช้า" บน Facebook: +23 ชม. และไม่เลยหน้าต่าง−ระยะเผื่อ (FB_MESSAGING_WINDOW_MS − FB_CHECKIN_MARGIN_MS) */
export function facebookLateDeadline(lastInboundAt) {
  const lastIn = Number(lastInboundAt) || 0;
  return Math.min(lastIn + FB_LATE_LATEST_MS, lastIn + FB_MESSAGING_WINDOW_MS - FB_CHECKIN_MARGIN_MS);
}
/** เวลาทักช่อง "ช้า" ของห้อง Facebook — null = ไม่มีช่องกลางวันที่ทันหน้าต่าง */
export function facebookLateTouchAt({ customerId = "", lastInboundAt = 0, notBeforeMs = 0 } = {}) {
  const lastIn = Number(lastInboundAt) || 0;
  if (!lastIn) return null;
  const deadline = facebookLateDeadline(lastIn) - FB_SEND_SLACK_MS;
  const unit = hashUnit(customerId, lastIn, "fb_late_touch");
  const from = Math.max(lastIn + FB_LATE_FROM_MS, Number(notBeforeMs) || 0);
  const preferred = pickInIntervals(daytimeIntervals(from, Math.min(lastIn + FB_LATE_TO_MS, deadline)), unit);
  if (preferred !== null) return preferred;
  const fallback = daytimeIntervals(Math.max(lastIn + FB_LATE_EARLIEST_MS, Number(notBeforeMs) || 0), deadline).at(-1);
  return fallback ? pickInIntervals([[Math.max(fallback[0], fallback[1] - FB_FALLBACK_TAIL_MS), fallback[1]]], unit) : null;
}
function facebookThreadPlan({ plan, list, stepIndex, customerId, lastInboundAt }) {
  const last = Math.max(list.length - 1, 0);
  const current = Number(stepIndex) || 0;
  if (plan?.mode === "money_wait") return { stepIndex: current, floorAt: 0, skip: "fb_window_ends" };
  const prev = Number(plan?.prevTouchAt) || 0;
  const late = plan?.mode === "defer" || plan?.mode === "consult" || prev > 0;
  if (!late) return { stepIndex: Math.max(current, Math.min(Number(plan?.minStep) || 0, last)), floorAt: 0 };
  const at = facebookLateTouchAt({ customerId, lastInboundAt, notBeforeMs: prev ? prev + FB_TOUCH_GAP_MS : 0 });
  if (at === null) return { stepIndex: current, floorAt: 0, skip: "fb_window_ends" };
  // คงไม้ปัจจุบันไว้ (ไม้ท้ายของบันได FB ตกค่ำแล้วถูกเลื่อนเป็นเช้าวันถัดไป + สุ่ม — อาจเลยเส้นตาย) แล้วรอถึงช่อง "ช้า"
  return { stepIndex: current, floorAt: at, latestAt: facebookLateDeadline(lastInboundAt) };
}

// ---- 12 ต.ค. 2026 (คำสั่งพี่ง้วง): ห้องที่ได้ราคาแล้ว = ทักครั้งเดียว "เช้าวันถัดไป" ----
// เช้าถัดไปหลังข้อความที่ลูกค้าพิมพ์ล่าสุดอย่างน้อย 6 ชม. (พิมพ์ตีสาม = เช้าวันนั้น · พิมพ์ 08:50 = เช้าวันถัดไป) กระจาย 09:00–10:30
const MORNING_MIN_GAP_MS = 6 * HOUR_MS;
const MORNING_SPREAD_MS = 90 * MINUTE_MS;
export function morningTouchAt({ customerId = "", typedAt = 0 } = {}) {
  const typed = Number(typedAt) || 0;
  return nextQuietEnd(typed + MORNING_MIN_GAP_MS) + Math.floor(hashUnit(customerId, typed, "morning_after_price") * MORNING_SPREAD_MS / MINUTE_MS) * MINUTE_MS;
}
// Facebook: เช้าถัดไปที่ยังทันหน้าต่าง 24 ชม. · ไม่ทัน = ช่อง "ช้า" เดิม (ช่องกลางวันท้ายสุดก่อนเส้นตาย) · ไม่มีเลย = ไม่ทัก
function facebookMorningPlan({ plan, stepIndex, customerId, lastInboundAt }) {
  const current = Number(stepIndex) || 0;
  const latestAt = facebookLateDeadline(lastInboundAt);
  const morning = morningTouchAt({ customerId, typedAt: plan.morningAfter });
  if (morning <= latestAt - FB_SEND_SLACK_MS) return { stepIndex: current, floorAt: morning, latestAt };
  const at = facebookLateTouchAt({ customerId, lastInboundAt });
  if (at === null) return { stepIndex: current, floorAt: 0, skip: "fb_window_ends" };
  return { stepIndex: current, floorAt: at, latestAt };
}

/** { stepIndex, floorAt, skip? } — stepIndex ไม่ถอยหลังจากขั้นปัจจุบัน · floorAt 0 = ไม่มีเวลาเร็วสุดเพิ่ม · skip = ช่วงเงียบนี้ไม่ทัก (Facebook) */
export function threadStepPlan({ plan = null, schedule = [], stepIndex = 0, anchorMs = 0, channelId = "", customerId = "", lastInboundAt = null } = {}) {
  const list = Array.isArray(schedule) ? schedule : [];
  if (String(channelId) === FACEBOOK_CHANNEL_ID) {
    if (Number(plan?.morningAfter) > 0) return facebookMorningPlan({ plan, stepIndex, customerId, lastInboundAt: lastInboundAt ?? anchorMs });
    return facebookThreadPlan({ plan, list, stepIndex, customerId, lastInboundAt: lastInboundAt ?? anchorMs });
  }
  const last = list.length - 1;
  const current = Number(stepIndex) || 0;
  let index = Math.max(current, Math.min(Number(plan?.minStep) || 0, Math.max(last, 0)));
  let floorAt = Number(plan?.floorAt) || 0;
  if (Number(plan?.morningAfter) > 0) floorAt = Math.max(floorAt, morningTouchAt({ customerId, typedAt: plan.morningAfter }));
  const minOffset = Number(plan?.minOffsetMs) || 0;
  if (minOffset > 0 && last >= 0) {
    const target = Number(anchorMs) + minOffset;
    let found = -1;
    for (let i = index; i <= last; i += 1) {
      if (stepBaseAt(list[i], Number(anchorMs)) >= target) { found = i; break; }
    }
    if (found >= 0) index = found;
    else {
      index = Math.max(index, last);
      floorAt = Math.max(floorAt, target);
    }
  }
  return { stepIndex: index, floorAt };
}
/** เวลาส่งของไม้นั้นหลังเวลาเร็วสุดของแผน (ตกช่วงเงียบ = เลื่อนไป 09:00 ถัดไป + สุ่มแบบเดิม) */
export function threadDueAt({ floorAt = 0, ...args }) {
  const due = resolveStepDueAt(args);
  if (due === null || !(Number(floorAt) > due)) return due;
  const floor = Number(floorAt);
  return inQuietHours(floor)
    ? nextQuietEnd(floor) + Math.round(hashUnit(args.customerId, args.anchorMs, args.stepIndex, "thread_floor") * MORNING_JITTER_MS)
    : floor;
}
/** เรื่องที่ค้างของห้องนี้ (อ่าน DB เบา ๆ: ข้อความ 40 แถว + ผลอ่านลูกค้าล่าสุด + รอบที่ยังเปิด) — เส้นยิงจริงและ badge ใช้ตัวเดียวกัน */
export function followupThreadPickFor({ db, config, customer, history = [], nowMs = 0, bundle = null, rounds = null, logger = null }) {
  const customerId = customer.line_user_id;
  let painPoint = "";
  try {
    const row = db.scoreHistory(customerId, 1)?.[0];
    painPoint = String((row?.payload_json ? JSON.parse(row.payload_json) : null)?.pain_point || "");
  } catch { /* ผลอ่านพัง = ไม่มีเรื่องที่ลูกค้าเล่า */ }
  return pickFollowupThread({
    rows: followupRows(db.messagesFor(customerId, 40)),
    priceQuoted: Number(customer.price_quoted_at || 0) > 0,
    // 12 ต.ค. 2026: เคยแบ่งรับราคาไว้ (หมุดถาวรตัวเดียวกับ priceDisclosure) = ทักตามแจ้งราคาเลย
    priceOwed: Number(customer.price_deferred_at || 0) > 0 || Number(customer.price_pivot_deferred_at || 0) > 0,
    painPoint,
    rounds: Array.isArray(rounds) ? rounds : currentUpcomingRounds({ db, config, bundle, todayIso: bangkokIsoDate(nowMs), logger }),
    history,
  });
}
// ไม่มีเรื่องค้างให้ทัก ต้องบอกเหตุบน badge ให้ต่างจาก "ทักครบรอบนี้แล้ว" (รอบรีวิว 8 C3: เดิมขึ้นว่าทักครบทั้งที่ไม่ได้ส่งอะไร)
export function threadBlockedReason(reason = "") {
  if (reason === "thread_already_followed") return "ladder_done";
  return String(reason).startsWith("stop:") ? "followup_stop" : "no_thread";
}
function historyList(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Meta ให้ทักอัตโนมัติได้ภายใน 24 ชม. หลังข้อความล่าสุดของลูกค้าเท่านั้น (margin 5 นาทีเดิมของ withinFacebookWindow)
// ไม้ที่จะส่งได้จริงหลังประตูปิด (ถูกเว้นระยะ/เลื่อนพ้นคืนจนไม่ทัน) = ข้ามทิ้ง บันไดรอบนี้จบเร็วขึ้น
// sendAt = max(เวลาถึงกำหนด, ตอนนี้) — เส้นยิงจริงและ badge ใช้ตัวนี้ตัวเดียว เวลาที่ badge บอกจึงไม่มีวันเป็นเวลาที่ไม่ยิง
export function facebookStepMissesWindow({ channelId = "", sendAt, lastInboundAt }) {
  if (String(channelId) !== FACEBOOK_CHANNEL_ID) return false;
  const last = Number(lastInboundAt);
  return !(last > 0 && Number(sendAt) - last < FB_MESSAGING_WINDOW_MS);
}
// v1.4.9: ATMOSPHERE_IMAGES ย้ายไปเป็น single source ที่ imageSuggestion.mjs (import ด้านบน)

// v1.4.6b (เคสจริง 2026-08-16 11:26 "warm แล้ว ไม่มีการส่งหลัง 30 นาที"): ธง NEEDS_HUMAN
// ติดค้างได้นานหลายวัน (ทุก escalation ping ตั้งมัน) ขณะที่ AI ยังคุยต่อปกติ — จึงห้าม
// ใช้ธงนี้ตัด follow-up ทั้งระบบ; สิ่งเดียวที่ต้อง hold จริงคือ "จังหวะเงินที่ยังรอคนตรวจ":
// มี escalation สายชำระเงินภายใน 24 ชม. และลูกค้าไม่ได้พิมพ์อะไรใหม่หลังจังหวะนั้นเลย
// (พิมพ์ใหม่ >10 นาทีหลัง hold = บทสนทนาเดินต่อแล้ว ไม่ใช่กำลังรอยืนยันยอด)
const PAYMENT_HOLD_REASON = /(?:payment_review|image_review|payment_requires_human_review)/u;
const PAYMENT_HOLD_WINDOW_MS = 24 * 3_600_000;
const PAYMENT_HOLD_RESUME_BUFFER_MS = 10 * 60_000;

const truncatePromptText = truncateCodePoints;

export function paymentHoldActive({ handoffSummary = "", nowMs, lastInboundAt = null }) {
  for (const line of String(handoffSummary || "").split("\n")) {
    if (!PAYMENT_HOLD_REASON.test(line)) continue;
    const stamp = line.match(/^\[([^\]]+)\]/u)?.[1];
    const holdAt = stamp ? Date.parse(stamp) : NaN;
    if (!Number.isFinite(holdAt)) return true; // อ่านเวลาไม่ออก = ถือว่า hold (ปลอดภัยไว้ก่อน)
    if (nowMs - holdAt >= PAYMENT_HOLD_WINDOW_MS) continue;
    const resumed = Number(lastInboundAt) > holdAt + PAYMENT_HOLD_RESUME_BUFFER_MS;
    if (!resumed) return true;
  }
  return false;
}
// 1 ก.ย. 2026: เดิมรับเฉพาะ /share/ ทำให้รีวิวที่ชมพู่ใส่เป็นลิงก์ /reel/ ตกคลังเงียบ ๆ
// (อยู่ในคลังแต่บอทหยิบไม่ได้เลย) — รับ path ของ Facebook ที่ใช้แชร์รีวิวได้จริงทั้งหมด

// ---- parser: คลังรีวิวจาก knowledge entry (รูปแบบ "[Classroom : X]" + "- ชื่อ | รีวิว: URL") ----
export function parseReviewCatalog(knowledgeEntries = []) {
  const entry = (Array.isArray(knowledgeEntries) ? knowledgeEntries : [])
    .find((row) => String(row?.title || "").includes("รีวิวนักเรียนจริง") && row?.active !== 0);
  if (!entry) return [];
  return parseCatalogText(entry.content).map(r => ({ ...r, url: r.url.replace(/[/?#]+$/u, "") }));
}

// เลือกรีวิวที่ยังไม่เคยส่ง โดยเทียบคลาสที่ลูกค้ากำลังสนใจจาก history (ไม่มี match = ใบแรกที่เหลือ)
// v1.4.41: คำที่บ่งบอก "ธุรกิจแบบเดียวกัน" ในป้ายชื่อรีวิว — ใช้เลือกรีวิวให้ตรงกลุ่มลูกค้า
// เคสจริง: แม่ค้าออนไลน์ได้รีวิว "CEO ร้านตัดผม" ซึ่งไม่ผิดข้อเท็จจริงแต่ไม่โดนใจ
// รีวิวมีพลังก็ต่อเมื่อลูกค้าเห็นตัวเองในนั้น

export function pickReview(reviews, { sentUrls = new Set(), history = [], personaType = "" } = {}) {
  return selectReview(reviews, { sentUrls, history, personaType });
}

// v1.4.12 (คำสั่งพี่ง้วง 2026-08-18 "ห้ามทวง"): ทุกสเตจพูดจากมุมใส่ใจ+อำนวยความสะดวก
// 2026-09-28 (ผู้ตรวจโค้ด): hot เดิมสั่ง "สื่อสารว่าลูกแพรดูแลสิทธิ์/ที่นั่งไว้ให้เรียบร้อย" = ชนกติกาเหล็ก
// (ลูกแพรห้ามบอก/บอกเป็นนัยว่ากันที่นั่งไว้ให้ ที่นั่งยืนยันโดยคนหลังชำระเท่านั้น) — FU ก.ย. 2,616 ข้อความยังไม่หลุด
// แต่คำสั่งเชิญให้หลุด เปลี่ยนเป็นเจตนาขายเดิมแบบไม่อ้างการกันที่: ไม่ต้องรีบ + เชิญยืนยันรอบเมื่อพร้อม + ทีมงานยืนยันที่นั่ง
export const STAGE_QUESTION_BRIEF = Object.freeze({
  cold: "ลูกค้ายังเย็นอยู่ — ทักด้วยความใส่ใจสิ่งที่เขาเคยเล่า ชวนคุยเบา ๆ แบบเพื่อนที่พร้อมช่วย ห้ามพูดถึงราคา/โปรโมชั่นเด็ดขาด",
  warm: "ลูกค้ากำลังสนใจ — แสดงว่าเราจำโจทย์ของเขาได้และพร้อมช่วยให้เห็นภาพมากขึ้น เสนอความช่วยเหลือก่อน ค่อยชวนคุยต่อ ห้ามกดดัน",
  hot: "ลูกค้าใกล้ตัดสินใจ — สื่อสารว่าไม่ต้องรีบ ลูกแพรพร้อมช่วยทุกขั้นตอน และเชิญให้แจ้งรอบที่สะดวกได้เมื่อพร้อม " +
    "(ทีมงานเป็นผู้ยืนยันที่นั่งให้) ห้ามสร้างความเร่งด่วนปลอม",
});

// กติกาขั้นรอชำระ (โหมดทวงโอนที่ปิดใช้จริงตั้งแต่ 5 ก.ย. แต่เก็บไว้ครบ — ดู paymentNudgeMode ใน processCustomer)
// 2026-09-28: เดิม "แจ้งว่าลูกแพรดูแลสิทธิ์ราคา/ที่นั่งไว้ให้เรียบร้อยแล้ว" = อ้างว่ากันที่นั่งไว้ให้ (ชนกติกาเหล็ก)
// ตอนนี้ใช้กรอบเดียวกับข้อความทักเบา ๆ หลังส่งบัญชีที่พี่ง้วงอนุมัติเช้านี้: ทีมงานยืนยันที่นั่งหลังได้รับการชำระ
export const PAYMENT_NUDGE_RULE = "- ดีลอยู่ขั้นรอชำระ (ส่งเลขบัญชี/สรุปยอดไปแล้ว): ห้ามทวงเด็ดขาด ห้ามถามว่าโอนหรือยัง — " +
  "ใช้มุมอำนวยความสะดวกเท่านั้น เช่น บอกว่าไม่ต้องรีบนะคะ สะดวกเมื่อไหร่แจ้งได้เลย " +
  "ทีมงานจะยืนยันที่นั่งให้หลังได้รับการชำระ และถ้าติดขัดเรื่องการชำระหรือเอกสารตรงไหน ให้ลูกแพรช่วยได้เสมอ — " +
  "ห้ามพูดเรื่องอื่นนอกจากการดูแลขั้นนี้ ห้ามกลับไปถามเรื่องการนำ AI ไปใช้หรือ discovery เดิม";

// v1.4.8 (feedback พี่ง้วง 2026-08-16 เคสคุณมนตรี): deal เดินหน้าแล้ว (เห็นราคา/เลือกรอบ/
// กำลังจะโอน) — คำถาม follow-up ต้อง "เดินหน้าต่อจากจุดที่ค้าง" ห้ามถอยกลับไปถาม discovery
// ("จะเอา AI ไปใช้ด้านไหน") ซึ่งลูกค้าตอบไปแล้วและผิดจังหวะมาก
export const ADVANCED_DEAL_STATUSES = new Set([
  "price_sent", "awaiting_round_choice", "awaiting_team_decision", "quote_sent", "awaiting_payment",
]);

// v1.4.41 (คำถามพี่ง้วง 2026-08-21): follow-up ต้องพูดกับ "ความเจ็บที่อยู่ในใจลูกค้า"
// ไม่ใช่ตามเรื่องล่าสุดที่คุยค้างไว้
// เคสจริงที่พิสูจน์: ลูกค้าบอกตั้งแต่เทิร์นแรกว่าเป็นแม่ค้าออนไลน์ ลูกค้าทักตอนดึกแล้วตอบไม่ทัน
// เสียออเดอร์ทุกวัน — แต่คุยเรื่องที่จอดรถ/การเดินทางทับไป 3 เทิร์น พอ follow-up ยิงออกมา
// มันพูดถึง "การเดินทางจากรังสิต" และเลือกรีวิว CEO ร้านตัดผม ไม่แตะเรื่องเสียออเดอร์เลย
// ทั้งที่ scorer สรุปไว้ถูกต้องแล้วว่า "แม่ค้าออนไลน์ที่ต้องการให้ AI ช่วยตอบลูกค้านอกเวลางาน"
// สาเหตุ: stagedFollowups ได้แค่ประวัติแชทดิบ ไม่เคยได้รับผลอ่านของ scorer เลย
// (followupEngine ตัวเก่าใช้ persona_read อยู่แล้ว — ตัวที่ยิงจริงกลับไม่ได้ใช้)
// export 2026-09-28: YOLO (yoloPrompt.mjs) ใช้ผลอ่านลูกค้าชุดเดียวกับ follow-up — ห้ามแยกสองสำเนา
export function personaBrief(scorePayload, options = {}) {
  if (!scorePayload) return [];
  const lines = [];
  // รีวิวเคสจริง 6–7 ต.ค.: ทักตามแบบมีเรื่องค้าง (options.context) ใช้ผลอ่านลูกค้าเป็นบริบทเท่านั้น — บรรทัด "พูดกับความเจ็บ
  // ไม่ใช่หัวข้อที่คุยค้าง" ขัดกับงาน "กลับไปที่เรื่องที่ค้าง" ตรง ๆ (ข้อความทักตามเลยกลายเป็นทิปทั่วไปแทนคำถามที่ค้าง)
  const context = options.context === true;
  const summary = String(scorePayload.context_summary || "").trim();
  if (summary) {
    lines.push(`- ลูกค้าคนนี้คือใครและติดอะไรอยู่: ${truncatePromptText(summary, 300)}`);
    if (!context) {
      lines.push("- ให้ข้อความนี้พูดกับ \"โจทย์/ความเจ็บ\" ข้างต้นเป็นหลัก ไม่ใช่หัวข้อล่าสุดที่บังเอิญคุยค้างไว้ " +
        "(เรื่องที่จอดรถ การเดินทาง วันเรียน เป็นรายละเอียดประกอบ ไม่ใช่เหตุผลที่เขาสนใจคลาส)");
    }
  }
  // v1.4.41: กลุ่มอาชีพ + ความเจ็บที่ลูกค้าเล่าเอง = หัวใจของ follow-up ที่ "เข้าใจเขาจริง"
  // เรียงไว้ก่อน DISC โดยตั้งใจ เพราะ "เขาเจ็บอะไร" สำคัญกว่า "เขาพูดสไตล์ไหน"
  const painPoint = String(scorePayload.pain_point || "").trim();
  if (painPoint) {
    lines.push(`- ความเจ็บที่ลูกค้าเล่าเอง: ${truncatePromptText(painPoint, 200)}`);
    if (!context) lines.push("- ให้ข้อความนี้ช่วยเรื่องนั้นก่อน แล้วคลาสค่อยเป็นทางไปสู่คำตอบ — ห้ามขายคลาสตรง ๆ");
  }
  if (context && (summary || painPoint)) {
    lines.push("- ใช้ข้อมูลลูกค้าข้างบนเป็นบริบทเพื่อเลือกคำและตัวอย่าง — เรื่องที่ทักยังเป็นเรื่องที่ค้างอยู่เรื่องเดียว");
  }
  const ptype = String(scorePayload.persona_type || "");
  if (ptype && ptype !== "unknown") {
    lines.push(`- กลุ่มลูกค้า: ${ptype} — เลือกตัวอย่าง รีวิว และคำที่ใช้ให้ตรงกับคนกลุ่มนี้ ` +
      "ห้ามยกตัวอย่างจากธุรกิจคนละแบบ (เช่น แม่ค้าออนไลน์ไม่ควรได้ตัวอย่างงานโรงงาน)");
  }
  const disc = String(scorePayload.persona_read?.disc || "");
  // ธุรกิจที่เลิกใช้ DISC (4 ต.ค. 2026) — ผลเก่าที่ยังติดค่า C ในห้องเดิมก็ไม่ใช้แล้ว
  if (disc && disc !== "unknown" && scorePayload.disc_retired !== true && !options.chatStyleKnown) {
    lines.push(`- สไตล์การตัดสินใจ (DISC): ${disc} — ปรับน้ำเสียงให้เข้ากับเขา ` +
      "D=ตรงประเด็นสั้นกระชับ · I=อบอุ่นเป็นกันเอง · S=ค่อยเป็นค่อยไปไม่กดดัน · C=มีข้อมูลชัดเป็นขั้นตอน");
  }
  const tags = Array.isArray(scorePayload.tags)
    ? scorePayload.tags.filter(Boolean).slice(0, 6).map((tag) => truncatePromptText(tag, 100))
    : [];
  if (tags.length) lines.push(`- สิ่งที่ลูกค้าสนใจ/กังวลตามที่บันทึกไว้: ${tags.join(" · ")}`);
  return lines;
}

// White-label: โปรไฟล์ generic ไม่มีที่นั่ง/รอบเรียน/ระดับการใช้ AI — บรรทัดเฉพาะคอร์สถูกแทนด้วยถ้อยคำกลาง
// (แบรนด์เริ่มต้น/โปรไฟล์ course = กติกาเดิมทุกไบต์)
const GENERIC_STAGED_LINES = Object.freeze({
  seat: "- ห้ามพูดหรือบอกเป็นนัยว่าลูกแพรจอง กัน หรือเก็บสินค้า/คิวไว้ให้ — ทีมงานเป็นผู้ยืนยันรายการเสมอ",
  hot: "ลูกค้าใกล้ตัดสินใจ — สื่อสารว่าไม่ต้องรีบ ลูกแพรพร้อมช่วยทุกขั้นตอน และเชิญให้แจ้งได้เมื่อพร้อม " +
    "(ทีมงานเป็นผู้ยืนยันรายการให้) ห้ามสร้างความเร่งด่วนปลอม",
  noRepeat: "- อ่านประวัติแล้วถามต่อจาก 'จุดที่ค้างอยู่จริง' เท่านั้น — คำถามที่ลูกค้าเคยตอบไปแล้ว ห้ามถามซ้ำเด็ดขาด",
  advanced: "- ดีลเดินหน้าแล้ว (ลูกค้าเห็นราคา/กำลังเลือก/ใกล้ชำระ): คำถามต้องพาไปปิดขั้นที่ค้าง " +
    "เช่น ยืนยันรายการที่สนใจ สะดวกรับ/ส่งเมื่อไหร่ หรือมีอะไรให้ช่วยตัดสินใจเพิ่มไหม — " +
    "ห้ามถามคำถามสำรวจย้อนหลังเด็ดขาด",
  payment: "- ดีลอยู่ขั้นรอชำระ (ส่งเลขบัญชี/สรุปยอดไปแล้ว): ห้ามทวงเด็ดขาด ห้ามถามว่าโอนหรือยัง — " +
    "ใช้มุมอำนวยความสะดวกเท่านั้น เช่น บอกว่าไม่ต้องรีบนะคะ สะดวกเมื่อไหร่แจ้งได้เลย " +
    "ทีมงานจะยืนยันรายการให้หลังได้รับการชำระ และถ้าติดขัดเรื่องการชำระหรือเอกสารตรงไหน ให้ลูกแพรช่วยได้เสมอ — " +
    "ห้ามพูดเรื่องอื่นนอกจากการดูแลขั้นนี้",
});

export function stagedRules({ stage, previousTexts = [], dealStatus = "", paymentNudge = false, scorePayload = null, chatStyle = "" }) {
  const generic = isGenericProfile(activeBrand());
  const rules = [
    "งานนี้: ร่างข้อความ follow-up ที่แอดมินทักไปหาลูกค้าเอง (ลูกค้าไม่ได้ทักมาก่อน)",
    // v1.4.12 (คำสั่งพี่ง้วง 2026-08-18): follow-up = gentle reminder แบบ super empathy
    // เท่านั้น — ลูกแพรคือผู้ช่วยที่ใส่ใจและ \"อำนวยความสะดวก\" ให้ลูกค้า
    // ไม่ใช่คนทวงงาน (เคสจริง: \"เห็นว่าค้างเรื่อง...\" อ่านแล้วแรงและห้วน)
    // 2026-09-28: มุมเดิม "รักษาสิทธิ์ให้ (ดูแลที่นั่ง/สิทธิ์ราคาไว้ให้อยู่)" = สั่งให้อ้างว่ากันที่นั่งไว้ให้
    // (ชนกติกาเหล็ก) → เปลี่ยนเป็น "ให้ลูกค้าตัดสินใจตามจังหวะของเขาเอง" ซึ่งเป็นเจตนาจริงของมุมนั้น (ไม่เร่ง)
    "หัวใจ: ข้อความต้องอ่านแล้วรู้สึกว่าลูกแพรใส่ใจและพร้อมช่วย ไม่ใช่มาตามงาน — " +
    "มุมที่ใช้ได้คือ ให้ลูกค้าตัดสินใจตามจังหวะของเขาเอง (ไม่ต้องรีบ พร้อมเมื่อไหร่แจ้งลูกแพรได้เลย) " +
    "และอำนวยความสะดวก (พร้อมช่วยเตรียมข้อมูล/ตอบคำถาม/ช่วยเรื่องเอกสาร)",
    "กติกาที่ห้ามละเมิดเด็ดขาด:",
    // 2026-09-28 กติกาเหล็กเรื่องที่นั่ง — ลูกแพรไม่มีระบบกันที่ ที่นั่งเป็นของผู้ชำระก่อนและคนยืนยันเอง
    // ไม่ใส่คำว่า "ชำระ" ในบรรทัดนี้โดยเจตนา: บรรทัดนี้ไปทุกสเตจ และ FU cold/warm ห้ามแตะเรื่องเงิน
    // (เรื่องยืนยันที่นั่งหลังชำระอยู่ใน PAYMENT_NUDGE_RULE ของขั้นรอชำระที่เดียว)
    generic ? GENERIC_STAGED_LINES.seat
      : "- ห้ามพูดหรือบอกเป็นนัยว่าลูกแพรจอง กัน ล็อก หรือเก็บที่นั่งไว้ให้ — ทีมงานเป็นผู้ยืนยันที่นั่งเสมอ",
    "- ห้ามทวงทุกวิธี: ห้ามใช้โครงประโยคชี้ว่าลูกค้าค้างอะไร เช่น \"เห็นว่าค้างเรื่อง...\" " +
    "\"ขอติดตามเรื่อง...\" \"ยังไม่ได้...\" \"อย่าลืม...\" \"รบกวนยืนยัน...\" — " +
    "และห้ามอ้างถึงการรอทีมงาน/handoff เป็นหัวข้อทัก",
    "- ห้ามแต่งตัวเลขราคา ส่วนลด หรือโปรโมชั่นเอง",
    "- ห้าม hard sell ห้ามกดดัน ห้ามสร้างความเร่งด่วนปลอม ห้ามขอโทษที่ทักมา",
    "- สั้น 1-2 ประโยค ภาษาแชทไทยธรรมชาติ อบอุ่น อ้างถึงเรื่องที่คุยกันอย่างใส่ใจ",
    "- ปิดท้ายด้วยคำถามนุ่ม ๆ ที่ตอบง่าย หรือประโยคเชิญชวนแบบไม่บังคับตอบ " +
    "(เช่น \"บอกลูกแพรได้เสมอนะคะ 😊\") — ไม่จำเป็นต้องเป็นคำถามทุกครั้ง",
    `- ${generic && stage === "hot" ? GENERIC_STAGED_LINES.hot : (STAGE_QUESTION_BRIEF[stage] ?? STAGE_QUESTION_BRIEF.warm)}`,
    generic ? GENERIC_STAGED_LINES.noRepeat
      : "- อ่านประวัติแล้วถามต่อจาก 'จุดที่ค้างอยู่จริง' เท่านั้น — คำถามที่ลูกค้าเคยตอบไปแล้ว " +
      "(ระดับการใช้ AI, จะใช้กับงานด้านไหน, เรียนเองหรือพาทีม) ห้ามถามซ้ำเด็ดขาด",
    followupDecisionInstructions(),
  ].map((line) => brandText(line));
  rules.push(
    ...personaBrief(scorePayload, { chatStyleKnown: Boolean(chatStyle) }),
    // สไตล์การพิมพ์จริงของลูกค้า (chatStyle.mjs) แทน DISC — ว่าง = กติกาเดิมทุกไบต์
    ...(chatStyle ? [chatStyle] : []),
  );
  if (ADVANCED_DEAL_STATUSES.has(String(dealStatus))) {
    if (generic) rules.push(GENERIC_STAGED_LINES.advanced);
    else rules.push(
      "- ดีลเดินหน้าแล้ว (ลูกค้าเห็นราคา/กำลังเลือกวัน/ใกล้ชำระ): คำถามต้องพาไปปิดขั้นที่ค้าง " +
      "เช่น ยืนยันรอบเรียน สะดวกวันไหน หรือมีอะไรให้ช่วยตัดสินใจเพิ่มไหม — " +
      "ห้ามถามคำถามสำรวจย้อนหลัง (เช่น จะนำ AI ไปใช้ด้านไหน) เด็ดขาด"
    );
  }
  // v1.4.12 (คำสั่งพี่ง้วง 2026-08-18 "ห้ามทวง"): ขั้นรอชำระ = มุมอำนวยความสะดวกเท่านั้น (ข้อความเต็มที่ PAYMENT_NUDGE_RULE)
  if (paymentNudge && String(dealStatus) === "awaiting_payment") rules.push(brandText(generic ? GENERIC_STAGED_LINES.payment : PAYMENT_NUDGE_RULE));
  if (previousTexts.length) {
    rules.push("ข้อความ follow-up ที่เคยส่งไปแล้ว — ห้ามถามซ้ำหรือใกล้เคียงกับชุดนี้:");
    for (const text of previousTexts.slice(-5)) rules.push(`- ${truncatePromptText(text, 160)}`);
  }
  return rules.join("\n").toWellFormed();
}

// รีวิวเคสจริง 6–7 ต.ค. (คำสั่งพี่ง้วง 7 ต.ค. "ทำข้อ 1-4 ได้เลย"): กติกาทักตามเมื่อระบบเลือกเรื่องที่ค้างไว้แล้ว (followupThread.mjs)
// ใช้เฉพาะห้อง reply_engine = v3 — ต่างจาก stagedRules สามจุด: (1) หัวใจคือทักต่อจากเรื่องที่ค้างเรื่องเดียว (มุมเดิม "ไม่ต้องรีบ
// พร้อมเมื่อไหร่แจ้งลูกแพรได้เลย" ออกมาเป็น "ค่อย ๆ พิจารณาตามจังหวะที่สะดวก" แทบทุกห้อง) (2) ปิดด้วยคำถามเดียวของเรื่องนั้น
// (ชุดเดิมยกตัวอย่าง "บอกลูกแพรได้เสมอนะคะ 😊" ให้เอง) (3) ผลอ่านลูกค้าเป็นบริบท ไม่ใช่คำสั่งให้พูดเรื่องความเจ็บแทนเรื่องที่ค้าง
// กติกาเหล็ก (ที่นั่ง · ห้ามทวง · ห้ามแต่งราคา · ห้ามกดดัน) และกติกาไม่ส่ง [[NO_SEND]] คงเดิมทุกข้อ
export const THREAD_STAGE_BRIEF = Object.freeze({
  cold: "ลูกค้ายังเย็นอยู่ — ห้ามพูดตัวเลขราคาหรือโปรโมชั่น",
  warm: "ลูกค้ากำลังสนใจ — แสดงว่าจำเรื่องของเขาได้ ห้ามกดดัน",
  hot: "ลูกค้าใกล้ตัดสินใจ — ห้ามสร้างความเร่งด่วนปลอม (ทีมงานเป็นผู้ยืนยันที่นั่งให้)",
});
// 12 ต.ค. 2026 (คำสั่งพี่ง้วง): ทักตามที่ส่งของที่ค้าง (ราคา/รายละเอียด/ภาพรวมคลาส) ยาวกว่าคำถามเดียวได้ · ราคาที่ค้าง = แจ้งตามบล็อกที่อนุมัติ
// · ห้ามสั่งให้ลูกค้าตอบแบบใดแบบหนึ่ง และห้ามถามซ้ำคำถามที่ลูกแพรถามไว้แล้ว
export const THREAD_DEMAND_RULE = "- ห้ามสั่งให้ลูกค้าตอบแบบใดแบบหนึ่ง เช่น \"ตอบเป็นเลขเดียว\" \"ตอบแค่…\" \"ตอบสั้น ๆ แล้ว…\" "
  + "และห้ามถามซ้ำคำถามที่ลูกแพรถามไว้แล้วในห้องนี้หรือเรื่องที่ลูกค้าตอบไปแล้ว · ไม่พูดว่า \"ยังยืนยันไม่ได้\" หรือ \"ไม่มีข้อมูล\" ในเรื่องที่ข้อมูลที่อนุมัติมีอยู่ "
  + "— ทุกข้อความต้องอ่านแล้วเหมือนคนจริงที่ใส่ใจ ไม่ใช่ระบบอัตโนมัติ";
// (ถ้อยคำกลาง ๆ — เหตุที่ราคาค้างจริง (ถาม/เลือกรอบ/บอกว่าจะสมัคร) อยู่ในบรรทัดเรื่องที่ค้างของ followupThread)
const THREAD_PRICE_BRIEF = "ข้อความนี้แจ้งค่าเรียนที่ลูกค้ายังไม่ได้รับ — แจ้งตัวเลขได้เฉพาะตามบล็อกค่าเรียนที่ระบบเตรียมไว้ด้านล่าง";
export function stagedThreadRules({ stage, previousTexts = [], dealStatus = "", scorePayload = null, chatStyle = "", thread = null, priceBlock = "" }) {
  const delivers = threadDeliversItem(thread);
  const rules = [
    "งานนี้: ร่างข้อความ follow-up ที่แอดมินทักไปหาลูกค้าเอง (ลูกค้าไม่ได้ทักมาก่อน)",
    "หัวใจ: ข้อความต้องอ่านแล้วรู้สึกว่าลูกแพรจำเรื่องของเขาได้และพร้อมช่วยต่อ ไม่ใช่มาตามงาน — ทักต่อจากเรื่องที่ค้างอยู่เรื่องเดียว ด้วยคำถามที่ตอบง่าย",
    ...threadRuleLines(thread),
    // 12 ต.ค. 2026: ของที่ระบบแนบไปกับไม้นี้ (รีวิว/รูป/คำชวนทดลองเรียน) — ไม่มี = ไม่มีบรรทัดนี้ (พรอมต์เดิมทุกไบต์)
    ...followupSocialRuleLines(thread),
    "กติกาที่ห้ามละเมิดเด็ดขาด:",
    "- ห้ามพูดหรือบอกเป็นนัยว่าลูกแพรจอง กัน ล็อก หรือเก็บที่นั่งไว้ให้ — ทีมงานเป็นผู้ยืนยันที่นั่งเสมอ",
    "- ห้ามทวงทุกวิธี: ห้ามใช้โครงประโยคชี้ว่าลูกค้าค้างอะไร เช่น \"เห็นว่าค้างเรื่อง...\" " +
    "\"ขอติดตามเรื่อง...\" \"ยังไม่ได้...\" \"อย่าลืม...\" \"รบกวนยืนยัน...\" — " +
    "และห้ามอ้างถึงการรอทีมงาน/handoff เป็นหัวข้อทัก",
    "- ห้ามแต่งตัวเลขราคา ส่วนลด หรือโปรโมชั่นเอง",
    "- ห้าม hard sell ห้ามกดดัน ห้ามสร้างความเร่งด่วนปลอม ห้ามขอโทษที่ทักมา",
    delivers
      ? "- ส่งของที่ค้างให้ครบแต่กระชับ ไม่เกิน 6 บรรทัด ภาษาแชทไทยธรรมชาติ อบอุ่นและเป็นมืออาชีพ (เราขายคลาสหลักหมื่นถึงหลักแสน)"
      : "- สั้น 1-2 ประโยค ภาษาแชทไทยธรรมชาติ อบอุ่น",
    `- ปิดท้ายด้วยคำถามเดียวของเรื่องที่ค้าง ตอบได้ง่าย — ไม่ใช้ประโยคกว้าง ๆ ที่ไม่มีเรื่องของเขา เช่น ${GENERIC_FOLLOWUP_EXAMPLES.map((text) => `"${text}"`).join(" ")}`,
    `- ${threadDeliversPrice(thread) ? THREAD_PRICE_BRIEF : THREAD_STAGE_BRIEF[stage] ?? THREAD_STAGE_BRIEF.warm}`,
    "- คำถามที่ลูกค้าเคยตอบไปแล้ว (ระดับการใช้ AI, จะใช้กับงานด้านไหน, เรียนเองหรือพาทีม) ห้ามถามซ้ำเด็ดขาด",
    // ตรวจคิว 13 ต.ค.: ทักตามเขียน "ถ้าจะให้ทีมใช้ร่วมกัน…" กับพระที่ทำวิทยานิพนธ์คนเดียว
    // พี่ง้วง 13 ต.ค.: คำชวนเลือกรอบ + ห้ามชวนหาข้อติดใจเรื่องค่าเรียน
    "- คำถามชวนและข้อเสนอทุกแบบใช้รูปถ่อมตัว ขึ้นต้น \"ไม่ทราบว่าคุณ(ชื่อ) …\" เช่น \"ไม่ทราบว่าคุณ(ชื่อ) สนใจให้ลูกแพรส่ง…ไหมคะ ลูกแพรส่งให้ค่ะ\" · \"ไม่ทราบว่าคุณ(ชื่อ) สะดวกรอบ … หรือ … ดีนะคะ?\" (ไม่รู้ชื่อให้ตัดคำว่าคุณ(ชื่อ) ออก) — ไม่ใช้ \"อยากให้…ไหม\" \"สะดวกรอบไหน\" ห้วน ๆ",
    "- ห้ามถามว่าลูกค้าติดเรื่องเงิน งบ หรือค่าเรียนเด็ดขาด และห้ามยกค่าเรียนขึ้นมาเป็นข้อกังวลเอง",
    "- ใช้เฉพาะข้อเท็จจริงที่ลูกค้าพิมพ์เองในห้องนี้: ห้ามสมมติว่าเขามีทีม พนักงาน ธุรกิจ ตำแหน่ง จำนวนคน หรืองบ — ไม่เขียน \"ถ้าจะให้ทีม…\" กับลูกค้าที่ไม่เคยพูดถึงทีม",
    THREAD_DEMAND_RULE,
    followupDecisionInstructions(),
    ...personaBrief(scorePayload, { chatStyleKnown: Boolean(chatStyle), context: true }),
    ...(chatStyle ? [chatStyle] : []),
  ];
  if (ADVANCED_DEAL_STATUSES.has(String(dealStatus))) {
    rules.push("- ดีลเดินหน้าแล้ว (ลูกค้าเห็นราคา/กำลังเลือกวัน/ใกล้ชำระ): คำถามต้องพาไปปิดขั้นที่ค้าง — ห้ามถามคำถามสำรวจย้อนหลัง (เช่น จะนำ AI ไปใช้ด้านไหน) เด็ดขาด");
  }
  if (priceBlock) {
    rules.push("บล็อกค่าเรียนที่อนุมัติ (วางในข้อความตามนี้ทุกตัวอักษร ห้ามเปลี่ยนหรือเพิ่มตัวเลข):", priceBlock);
  } else if (threadDeliversPrice(thread)) {
    rules.push("- ระบบยังเตรียมบล็อกค่าเรียนไม่ได้: แจ้งค่าเรียนจากข้อมูลธุรกิจที่อนุมัติเท่านั้น ห้ามแต่งหรือปัดตัวเลขเอง");
  }
  if (previousTexts.length) {
    rules.push("ข้อความ follow-up ที่เคยส่งไปแล้ว — ห้ามถามซ้ำหรือใกล้เคียงกับชุดนี้:");
    for (const text of previousTexts.slice(-5)) rules.push(`- ${truncatePromptText(text, 160)}`);
  }
  return rules.join("\n").toWellFormed();
}

// v1.4.8: preview สำหรับ badge บนคอนโซล — คำนวณ "follow-up ถัดไปของลูกค้าคนนี้"
// แบบ pure (ไม่แตะ network/hermes) ด้วยตรรกะเดียวกับ processCustomer
// คืน { stage, step, kind, dueAt } หรือ null ถ้าไม่มีคิว (บันไดจบ/ติดเพดาน/ติด hold)
// dueAt เป็น epoch คงที่ (ไม่ใช่ dueIn) — จงใจ ให้ signature dedupe ของ console ไม่แตกทุก poll
export function previewStagedFollowup({
  customer,
  state: stateRow = null,
  lastInboundAt = null,
  lastOutboundAt = null,
  nowMs = 0,
  delays = { cold: 60 * MINUTE_MS, warm: 30 * MINUTE_MS, hot: 30 * MINUTE_MS },
  // 2026-09-28: สวิตช์ settings.schedule_check_followup (ผู้เรียกอ่านสดแล้วส่งมา — ฟังก์ชันนี้ไม่แตะ DB)
  scheduleCheck = false,
  // รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 C3): ห้อง reply_engine = v3 — ผู้เรียกส่งตัวเลือกเรื่องค้างมา ({ history }) => pick
  // (followupThreadPickFor) ให้ badge ใช้แผนเดียวกับเส้นยิงจริง · null = เส้นเดิมทุกไบต์ · เรียกเฉพาะตอนจะโชว์เวลาไม้ถัดไป
  threadPick = null,
} = {}) {
  if (!customer) return null;
  if (urgentMentalHandoffActive(customer)) return { blocked: "urgent_mental" };
  // คำสั่งพี่ง้วง 2026-09-05 (กลับข้อยกเว้น v1.4.11 ของ 2026-08-18): เดิม bank_sent
  // ได้รับอนุญาตให้ follow-up เดินต่อเพื่อทวงโอน — ตอนนี้ไม่แล้ว "ส่งให้ชมพู่ handle ต่อเอง
  // ไม่ต้อง follow up" ห้องที่ AI ปิดคือห้องของคนจริง ข้อความอัตโนมัติทุกชนิดต้องหยุดพร้อมกัน
  // (ของจริง 30 วัน: FU หลัง bank_sent ออกไปแค่ 1 ข้อความ — ราคาของการกลับกติกานี้จึงต่ำมาก
  //  เทียบกับความเสียหายเวลาบอททักแทรกตอนชมพู่กำลังปิดการขายอยู่)
  const aiAllowsFollowup = customer?.ai_enabled === 1;
  if (!aiAllowsFollowup || customer.do_not_disturb === 1 || customer.followup_enabled !== 1) return null;
  if (serviceFollowupPaused(customer)) return { blocked: "service_boundary" };
  if (Number(customer.marketing_consent ?? 0) < 0) return null;
  if (!lastInboundAt) return null;
  // v1.4.13 (พี่ง้วงถาม "ทำไมไม่เห็น timer"): เคสที่ระบบ "ตั้งใจไม่ทัก" ต้องบอกเหตุผล
  // ({blocked}) ไม่ใช่หายเงียบ ({blocked} = badge เทาบนเว็บ, null = ไม่แสดงอะไรเลย)
  // v1.4.11b (audit จับ): hold ต้อง "สมมาตร" กับเส้นส่งจริง (processCustomer) — ห้ามมี
  // bypass ฝั่ง preview; เคส bank_sent ยังไม่ทริกเกอร์ hold อยู่แล้ว (hold อ่านเฉพาะบรรทัด
  // payment_review/image_review ใน handoff ซึ่งเกิดเมื่อลูกค้าแจ้งโอน/ส่งสลิปจริง)
  if (paymentHoldActive({ handoffSummary: customer.handoff_summary, nowMs, lastInboundAt })) {
    return { blocked: "payment_hold" };
  }

  const state = {
    ladder_stage: Number(stateRow?.ladder_stage ?? 0),
    stage_key: String(stateRow?.stage_key ?? ""),
    episode_anchor: stateRow?.episode_anchor ?? null,
    episodes_today: Number(stateRow?.episodes_today ?? 0),
    sent_today: Number(stateRow?.sent_today ?? 0),
    today_key: String(stateRow?.today_key ?? ""),
    cold_sent_total: Number(stateRow?.cold_sent_total ?? 0),
    // 2026-09-28: เวลาไม้ก่อนหน้าที่ส่งจริง — Facebook เว้นระยะนับจากตัวนี้ (ผู้เรียกต้องส่ง last_nudge_at มาด้วย)
    last_nudge_at: stateRow?.last_nudge_at ?? null,
  };
  const today = new Date(nowMs + 7 * 3_600_000).toISOString().slice(0, 10);
  if (state.today_key !== today) {
    state.sent_today = 0;
    state.episodes_today = 0;
  }
  // 2026-08-28: เดิมบรรทัดนี้รีเซ็ตขั้นแต่ไม่เคยตั้ง episode_anchor ขณะที่เส้นยิงจริงตั้ง
  // ทั้งสองฝั่งจึงได้ anchor คนละค่า และเมื่อ jitter ผูกกับ anchor badge จะโกหกเวลาที่
  // ยิงจริงไปหลายสิบนาที — ต้องคำนวณเหมือนกันเป๊ะ
  const episodeAnchor = (!state.episode_anchor || lastInboundAt > state.episode_anchor)
    ? lastInboundAt
    : state.episode_anchor;
  if (!state.episode_anchor || lastInboundAt > state.episode_anchor) state.ladder_stage = 0;
  // ลูกค้าขอไปเช็คคิวเอง = บันไดของ episode นี้คือทักหนึ่งครั้ง (หรือไม่ทักเลย) — ตรรกะเดียวกับเส้นยิงจริง
  const deferral = scheduleCheckEpisode({
    enabled: scheduleCheck === true, deferJson: stateRow?.defer_json, lastInboundAt,
    channelId: customer?.channel_id || "", customerId: customer.line_user_id,
  });
  const stage = deferral ? deferral.stage : warmthBand(Number.isInteger(customer.last_score) ? customer.last_score : null);
  if (state.stage_key && state.stage_key !== stage) state.ladder_stage = 0;
  const ladder = deferral ? deferral.ladder : ladderFor(stage, customer?.channel_id || "");
  // เรียงจากถาวรสุด → ชั่วคราวสุด ให้ badge บอกเหตุที่หนักที่สุดก่อน
  if (stage === "cold" && state.cold_sent_total >= COLD_LIFETIME_CAP) return { blocked: "cold_cap" };
  // รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 C3): ห้อง v3 — แผนเรื่องค้างตัวเดียวกับเส้นยิงจริง (ไม่มีเรื่องค้าง/หยุดทัก = บอกเหตุนั้น ไม่ใช่ "ทักครบ")
  const bankNudge = String(customer.deal_status) === "awaiting_payment" && customer.ai_off_reason === "bank_sent";
  let pick = null;
  if (!deferral && !bankNudge && typeof threadPick === "function") {
    try { pick = threadPick({ history: historyList(stateRow?.history_json) }); } catch { pick = null; }
  }
  if (state.ladder_stage >= ladder.length) return { blocked: pick && !pick.thread ? threadBlockedReason(pick.reason) : "ladder_done" };
  if (pick && !pick.thread) return { blocked: threadBlockedReason(pick.reason) };
  if (state.sent_today >= dailyProactiveCapFor(customer?.channel_id || "")) return { blocked: "daily_cap" };

  const lastActivity = Math.max(lastInboundAt, lastOutboundAt ?? 0);
  // เงียบเกิน 3 วัน = เครื่องยิงจริงไม่หยิบเป็น candidate (ACTIVE_WITHIN_MS ใน SQL) —
  // preview ต้องไม่โชว์ timer ที่ไม่มีวันยิง (ก่อนหน้านี้เคยโชว์ "รอบถัดไป" ค้างผี ๆ)
  if (nowMs - lastActivity > ACTIVE_WITHIN_MS) return { blocked: "dormant" };
  const previewSchedule = deferral ? deferral.schedule : scheduleFor(stage, delays[stage], customer?.channel_id || "");
  const planned = pick?.thread
    ? threadStepPlan({ plan: pick.plan, schedule: previewSchedule, stepIndex: state.ladder_stage, anchorMs: episodeAnchor,
      channelId: customer?.channel_id || "", customerId: customer.line_user_id, lastInboundAt })
    : { stepIndex: state.ladder_stage, floorAt: 0 };
  // Facebook: ช่วงเงียบนี้ไม่มีไม้ที่ทันหน้าต่าง 24 ชม. (หรือรอเงินเดือน) = บันไดรอบนี้จบ — เหตุเดียวกับเส้นยิงจริง
  if (planned.skip) return { blocked: planned.skip };
  const dueAt = threadDueAt({
    floorAt: planned.floorAt,
    schedule: previewSchedule,
    stepIndex: planned.stepIndex,
    anchorMs: episodeAnchor,
    lastActivityMs: lastActivity,
    customerId: customer.line_user_id,
    channelId: customer?.channel_id || "",
    previousSendMs: state.last_nudge_at,
    previousWasYolo: lastSendWasYolo(stateRow?.history_json),
  });
  // ไม้ถัดไปไม่ทันหน้าต่าง Facebook = เส้นยิงจริงข้ามทิ้ง → badge ต้องบอกว่าบันไดจบ ไม่โชว์เวลาที่ไม่มีวันยิง
  // (รอบรีวิว 8: ไม้ "ช้า" ของห้อง v3 มีเส้นตาย +23 ชม. ของตัวเองด้วย)
  if (dueAt !== null && planned.latestAt && Math.max(dueAt, Number(nowMs) || 0) > planned.latestAt) return { blocked: "fb_window_ends" };
  if (dueAt !== null && facebookStepMissesWindow({
    channelId: customer?.channel_id, sendAt: Math.max(dueAt, Number(nowMs) || 0), lastInboundAt,
  })) return { blocked: "fb_window_ends" };
  return {
    stage,
    step: planned.stepIndex + 1,
    // v1.4.11b: badge ต้องตรงกับของที่ส่งจริง — จังหวะรอโอน (bank_sent) ทุกขั้นคือคำถามทวงโอน
    // 2026-09-05: เงื่อนไขนี้เป็นเท็จเสมอแล้วในทางปฏิบัติ (ห้อง bank_sent มี ai_enabled = 0
    // จึงถูกคัดออกตั้งแต่ด่านบนสุด) — เก็บไว้เพื่อให้ badge กับเส้นยิงจริงยังสมมาตรกันเป๊ะ
    // รอบรีวิว 8: ทักครั้งเดียว/ขั้นสมัคร = คำถามอย่างเดียว (ตรงกับเส้นยิงจริง)
    kind: bankNudge || pick?.plan?.questionOnly ? "question" : ladder[planned.stepIndex],
    dueAt,
    ...(pick?.thread ? { thread: pick.thread.kind, mode: pick.plan.mode } : {}),
  };
}

function urgentMentalHandoffActive(customer) {
  if (customer?.ai_off_reason === "urgent_mental") return true;
  return /(?:^|\n)\[[^\]]+\]\s*urgent_mental(?::|$)/u.test(String(customer?.handoff_summary || ""));
}

// จุดตัดประโยคสุดท้าย: หลังคำลงท้าย (ค่ะ/นะคะ/ครับ/นะครับ/อีโมจิ) ตัวสุดท้ายที่ตามด้วยช่องว่าง — ส่วนท้ายต้องยาวพอเป็นคำถาม
const SENTENCE_END_G = /(?:ค่ะ|นะคะ|ครับ|นะครับ|\p{Extended_Pictographic})\s+/gu;
function lastSentenceBreak(text) {
  let cut = -1;
  for (const match of text.matchAll(SENTENCE_END_G)) cut = match.index + match[0].length;
  return cut > 0 && [...text.slice(cut).trim()].length >= 8 && ENDS_WITH_QUESTION_RE.test(text.slice(cut)) ? cut : -1;
}

// เจน 12 ต.ค. ค่ำ (ดูทักตามจริงหลังขึ้น 19:34): ส่งของค้าง + รีวิว เคยออกเป็น [ของค้าง, คำถาม, รีวิว] — คำถามต้องปิดท้ายเสมอ
// (feedback 10 ส.ค.: จบด้วยลิงก์/รูปแล้วลูกค้ามักเงียบ) · ย่อหน้าสุดท้าย (หรือบรรทัดสุดท้าย) ที่เป็นคำถามย้ายไปหลังของที่แนบ
export function attachBeforeClosingAsk(text, attachment) {
  const value = String(text || "").trim();
  const paragraphs = value.split(/\n{2,}/u);
  const lines = value.split("\n");
  const [body, ask] = paragraphs.length > 1 && ENDS_WITH_QUESTION_RE.test(paragraphs.at(-1))
    ? [paragraphs.slice(0, -1).join("\n\n"), paragraphs.at(-1)]
    : lines.length > 1 && ENDS_WITH_QUESTION_RE.test(lines.at(-1)) ? [lines.slice(0, -1).join("\n"), lines.at(-1)] : ["", ""];
  if (body.trim() && ask.trim()) return [body.trim(), attachment, ask.trim()];
  if (!ENDS_WITH_QUESTION_RE.test(value)) return [value, attachment];
  // ย่อหน้าเดียวหลายประโยค ("ยินดีเลยค่ะ … ได้จริงค่ะ อยากให้…ไหมคะ?") = ตัดที่คำลงท้ายตัวสุดท้ายก่อนคำถาม
  const cut = lastSentenceBreak(value);
  if (cut > 0) return [value.slice(0, cut).trim(), attachment, value.slice(cut).trim()];
  // ทั้งก้อนเป็นคำถามเดียว = แนบก่อน แล้วคำถาม (แบบเดียวกับไม้แนบรีวิวทั่วไป)
  return [attachment, value];
}

export function createStagedFollowups({
  config,
  db,
  hermes,
  lineRegistry,
  guard,
  humanizer,
  persona = "",
  brandPack = "",
  brainRuntime = null,
  decisionReview = null,
  notifier = null,
  logger = console,
  now = Date.now,
  imageCatalog = null,
  // 2026-09-28: ทักเบา ๆ หลังส่งบัญชี (paymentGentleNudge.mjs) — เดินในรอบเดียวกัน ใต้สวิตช์รวม/สถานะหยุด AI ตัวเดียวกัน
  paymentNudge = null,
}) {
  const lock = createLock();
  let timer = null;
  const tickMs = config.stagedFollowupTickMs ?? 0;
  const stageDelayMs = Object.freeze({
    cold: config.stagedColdDelayMs ?? 60 * MINUTE_MS,
    warm: config.stagedWarmDelayMs ?? 30 * MINUTE_MS,
    hot: config.stagedHotDelayMs ?? 30 * MINUTE_MS,
  });
  const catalog = imageCatalog
    ?? (config.imageCatalogFile ? loadImageCatalog(config.imageCatalogFile, { logger }) : []);
  const catalogByKey = new Map((catalog || []).map((entry) => [entry.key, entry]));

  // เพดานจำนวนลูกค้าที่ยิงข้อความทักตามได้ต่อหนึ่งรอบ (รอบละ 60 วินาที)
  // ค่านี้เลือกให้ต่ำพอที่คนจะทันเห็นและกดหยุดได้ ถ้าอะไรผิดปกติ
  const MAX_PER_TICK = 5;
  // จำสถานะรอบก่อน เพื่อรู้ว่า "เพิ่งกลับมาจากสถานะหยุด" หรือไม่
  // null = ยังไม่เคยรัน (เพิ่งบูต) ซึ่งก็ถือว่าต้องผ่อนคลายรอบแรกเหมือนกัน
  let lastTickPaused = null;
  let candidateOffset = 0;

  // สวิตช์ 2 ชั้นแบบเดียวกับ followupEngine: ค่า runtime ใน DB ชนะ env, อ่านพัง = ปิด
  function globalEnabled() {
    try {
      const stored = db.getSetting("staged_followup_enabled");
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch {
      return false;
    }
    return config.stagedFollowupEnabled === true;
  }

  function bangkokDayKey(tsMs) {
    return new Date(tsMs + 7 * 3_600_000).toISOString().slice(0, 10);
  }

  function loadState(customerId, tsMs) {
    const row = db.getFollowupState(customerId) ?? {};
    const state = {
      ladder_stage: Number(row.ladder_stage ?? 0),
      last_nudge_at: row.last_nudge_at ?? null,
      nudge_count: Number(row.nudge_count ?? 0),
      stage_key: String(row.stage_key ?? ""),
      episode_anchor: row.episode_anchor ?? null,
      episodes_today: Number(row.episodes_today ?? 0),
      sent_today: Number(row.sent_today ?? 0),
      today_key: String(row.today_key ?? ""),
      cold_sent_total: Number(row.cold_sent_total ?? 0),
      // อ่านอย่างเดียว (saveFollowupState ไม่เขียนคอลัมน์นี้) — หมุด "ขอเช็คคิวก่อน" ของห้อง
      defer_json: String(row.defer_json ?? ""),
      history: [],
    };
    try {
      const parsed = JSON.parse(String(row.history_json ?? "[]"));
      if (Array.isArray(parsed)) state.history = parsed;
    } catch { /* ประวัติพัง = เริ่มลิสต์ใหม่ (dedupe รีวิวยังมีชั้น DB scan อีกชั้น) */ }
    const today = bangkokDayKey(tsMs);
    if (state.today_key !== today) {
      state.today_key = today;
      state.sent_today = 0;
      state.episodes_today = 0;
    }
    return state;
  }

  function saveState(customerId, state) {
    db.saveFollowupState(customerId, {
      ...state,
      history_json: JSON.stringify(state.history.slice(-20)),
    });
  }

  // ---- ประกอบเนื้อหาแต่ละขั้น — คืน { bubbles, images, record } หรือ null = ข้ามขั้นนี้ ----
  // Keep existing schedule, send quota and ownership gates. Only choose the evidence type.
  function pickFollowupReview({ customer, customerId, state, history, reviews }) {
    const sentUrls = db.sentReviewUrls(customerId);
    for (const item of state.history) if (item.review) sentUrls.add(item.review);
    const text = [...history].reverse().find(t => t?.role === "user")?.content || "";
    return selectJourneyEvidence(reviews, { sentUrls, history, text, score: customer.last_score,
      personaType: latestScorePayload(customerId)?.persona_type || "", proactive: true }).selected[0] || null;
  }
  // 12 ต.ค. 2026 (คำสั่งพี่ง้วง "ส่งรีวิวด้วย แล้วแต่บริบท"): รีวิวของทักตามแบบมีเรื่องค้าง เลือกก่อนร่าง เพื่อให้บรรทัดสั่งงานรู้ว่ามีคลิปแนบจริงไหม
  // เปิด retrieval (production) = อ่านคลังรีวิวจากการ์ดของสมองรุ่นที่ใช้อยู่ (versioned · แยกช่องทางตามโหมดสมอง · การ์ดที่ปิดอยู่ไม่นับ)
  // ไม่เปิด = คลังเดิม · อ่านพัง/ไม่มีรีวิวเหลือ = null (ข้อความไม่พูดถึงคลิป)
  function threadReviewFor({ customer, customerId, state, retrieval }) {
    try {
      const reviews = parseReviewCatalog(retrieval
        ? knowledgeEntriesFor({ brain: retrieval.brain, db, channelId: customer?.channel_id || "default" })
        : db.listKnowledge?.() ?? []);
      if (!reviews.length) return null;
      return pickFollowupReview({ customer, customerId, state, history: db.recentTurns(customerId, 12), reviews });
    } catch {
      return null;
    }
  }

  // ---- 12 ต.ค. 2026 (พี่ง้วง): ของที่ทักตามไม้นี้แนบเอง — ห้อง v3 ที่มีเรื่องค้างเท่านั้น (ตัวตัดสิน: socialProof.planFollowupSocialProof) ----
  // บัญชีของที่ห้องได้แล้ว: ลิงก์รีวิวทุก session (DB) + ไม้ทักตามที่จดไว้ · รูปทุก session · คลังรีวิว/ลิงก์ทดลองเรียนจากการ์ดที่เปิดใช้ของช่องนี้
  // (สมองรุ่นที่ใช้อยู่เมื่อเปิด retrieval · ไม่เปิด = การ์ด active ของช่องนี้ — ตัวอ่านเดียวกับเส้นตอบแชท ผู้ตรวจ 12 ต.ค.: เดิมอ่านการ์ดที่ปิดแล้ว/ช่องอื่นได้)
  // จาง ๆ = เงียบผ่านไม้ก่อนในช่วงเงียบนี้ หรือเงียบ ≥20 ชม. · คุยต่อ = ลูกค้าพิมพ์หลังของชิ้นล่าสุดที่ลูกแพรแนบ
  // ไม้สุดท้ายของช่วงเงียบ (ตามเพดานไม้ของแผน) = พ่วงคำชวนทดลองเรียนไปกับของชิ้นหลัก — ลูกค้าที่เงียบตลอดจึงถึงขั้นคำชวนโดยไม่เพิ่มไม้
  const ASSET_ROW = (row) => row.direction === "out" && (((row.msg_type || "text") === "image" && /^\[image:classroom-atmosphere-/u.test(String(row.content || "")))
    || ((row.msg_type || "text") === "text" && (String(row.content || "").match(/https:\/\/[^\s<>]+/gu) || []).some((url) => reviewUrlKey(url))));
  function followupSocialProofFor({ customer, customerId, state, retrieval, thread, threadPlan, tsMs, lastIn }) {
    try {
      const entries = knowledgeEntriesFor({ brain: retrieval?.brain ?? null, db, channelId: customer?.channel_id || "default" });
      const sentUrls = db.sentReviewUrls(customerId);
      for (const item of state.history) if (item.review) sentUrls.add(item.review);
      const imageKeys = new Set(db.recentImageKeys?.(customerId, 0) ?? []);
      for (const item of state.history) if (item.image) imageKeys.add(item.image);
      const rows = db.messagesFor(customerId, 60) || [];
      const lastAssetAt = Math.max(0, ...rows.filter(ASSET_ROW).map((row) => Number(row.created_at) || 0));
      const continued = !lastAssetAt || rows.some((row) => row.direction === "in" && (row.msg_type || "text") === "text" && Number(row.created_at) > lastAssetAt);
      const history = db.recentTurns(customerId, 12);
      const gate = trialInviteGate({ db, customerId, nowMs: tsMs, entries, logger });
      const classes = Array.isArray(thread?.priceClasses) ? thread.priceClasses : [];
      const classKey = classes.length === 1 ? classes[0] : null;
      const painPoint = String(latestScorePayload(customerId)?.pain_point || "").trim();
      const plan = planFollowupSocialProof({
        thread, plan: threadPlan, delivery: threadDeliversItem(thread), catalog: parseReviewCatalog(entries), sentUrls, imageKeys,
        allowedImages: new Set((catalog || []).filter((entry) => entry?.needs_verification !== true && entry?.needsVerification !== true).map((entry) => entry.key)),
        history, text: [...history].reverse().find((turn) => turn?.role === "user")?.content || "",
        personaType: latestScorePayload(customerId)?.persona_type || "", classKey,
        fading: followupFading({ typedAt: lastIn, nowMs: tsMs, priorTouchAts: state.history.map((item) => item?.at) }), continued,
        // ไม้สุดท้ายที่แผนของช่วงเงียบนี้อนุญาต (ปกติ 2 · ได้ราคาแล้ว/พิมพ์ข้อความเดียว 1) — หลังไม้นี้ไม่มีการทักอีกจนกว่าลูกค้าพิมพ์
        finalTouch: Number(thread?.touch) >= Math.max(1, Number(threadPlan?.maxTouches) || 1),
        // ห้องที่คุยกันแล้วเท่านั้น (ไม่ใช่ห้องที่พิมพ์มาข้อความเดียว) — กติกา 21 ส.ค.: คลาสทดลองไม่แจกตั้งแต่ยังไม่รู้จักกัน
        engaged: !thread?.openingOnly && Boolean(thread?.priceQuoted || thread?.goal || painPoint || classKey),
        trialInvite: gate, excluded: legacyIdentityPending(customer) ? "legacy_identity" : "",
      });
      const usedTexts = rows.filter((row) => row.direction === "out" && (row.msg_type || "text") === "text").map((row) => String(row.content || ""));
      return plan ? { ...plan, gate, classKey, usedTexts } : null;
    } catch (err) {
      logger.debug?.(`stagedFollowups: เลือกรีวิว/รูปของไม้นี้ไม่ได้ (${err?.message || err}) — ทักแบบไม่แนบ`);
      return null;
    }
  }
  // ประกอบไม้ที่แนบของ (โค้ดเขียนคำนำจากข้อมูลที่อนุมัติ · ข้อความทักตามที่โมเดลร่างตามเรื่องที่ค้าง):
  //   ส่งของค้าง + รีวิว = ข้อความก่อน แล้วรีวิว (ของค้างคือเนื้อหาหลัก — แบบเดียวกับเส้น withReview 12 ต.ค.)
  //   รีวิว/รูปของไม้ทั่วไป = ของที่แนบ (และคำชวนที่พ่วงมา) ก่อน แล้วปิดด้วยคำถาม — แคตตาล็อกรูปบรรยากาศ: "ต้องลงท้ายข้อความด้วยคำถามเดียว"
  //   (ผู้ตรวจ 12 ต.ค.: เดิมคำถามขึ้นก่อนแล้วรูป/การ์ดลิงก์อยู่ท้าย — feedback 10 ส.ค. จบด้วยรูปแล้วลูกค้ามักเงียบ)
  //   รูปวางต่อจากคำนำของมันเสมอ (imageAfter = จำนวนบอลลูนก่อนรูป) · คำชวนอย่างเดียว = ข้อความ แล้วคำชวนพร้อมลิงก์
  async function buildSocialStep({ social, getQuestion, retrieval }) {
    const question = await getQuestion();
    if (!question) return null;
    const trial = social.trial?.url ? trialInviteBubble(social.trial.url) : "";
    const extra = { social: social.step, ...(trial ? { trial: true } : {}) };
    if (social.kind === "review") {
      const reviewBubble = `${followupReviewIntro(social.fit, social.classKey, social.usedTexts)}\n${social.review.who}\n${social.review.url}`;
      const bubbles = social.delivery ? attachBeforeClosingAsk(question, reviewBubble) : [reviewBubble, ...(trial ? [trial] : []), question];
      return { bubbles, images: [], record: { kind: "review_question", review: social.review.url, question, ...extra }, retrieval };
    }
    if (social.kind === "atmosphere") {
      const entry = catalogByKey.get(social.imageKey);
      if (!entry) return null;
      return { bubbles: [atmosphereCaption(social.imageKey, social.usedTexts), ...(trial ? [trial] : []), question], images: [entry], imageAfter: 1,
        record: { kind: "atmosphere", image: social.imageKey, question, ...extra }, retrieval };
    }
    if (social.kind === "trial") {
      return { bubbles: [question, trialInviteBubble(social.url)], images: [], record: { kind: "trial", trial: true, question, social: social.step }, retrieval };
    }
    return null;
  }

  async function buildStep({ kind, stage, customer, customerId, state, getQuestion, paymentNudgeMode = false, retrieval = null, deferral = null, reviewAfter = false,
    presetReview = null }) {
    const history = db.recentTurns(customerId, 12);
    // 2026-09-28: ทักหนึ่งครั้งหลัง "ขอเช็คคิวก่อน" — ข้อความคงที่ (เหตุผลที่ไม่ให้โมเดลร่างอยู่ใน scheduleCheckIn.mjs)
    // รอบที่ยกมาอ่านสด ณ เวลาส่ง (ตัดรอบที่ผ่าน/เต็ม/ปิดแล้ว) จากแหล่งเดียวกับเส้นตอบ
    if (kind === SCHEDULE_CHECK_STAGE) {
      const address = planCustomerAddress({ knownName: customer.known_name || "", displayName: customer.display_name || "", history });
      const text = scheduleCheckInText({
        channelId: customer.channel_id || "", customerId, anchorMs: deferral?.marker?.at ?? state.episode_anchor ?? 0,
        name: !address.generic && address.mayUseName ? `${address.pronoun}${address.name}` : "",
        rounds: currentUpcomingRounds({ db, config, bundle: retrieval?.brain?.bundle ?? null, todayIso: bangkokIsoDate(now()), logger }),
        recentTexts: history.map((turn) => String(turn?.content || "")),
      });
      return { bubbles: [text], images: [], record: { kind, question: text }, retrieval };
    }
    if (kind === "review" || kind === "review_question") {
      // Review catalog still reads legacy knowledge rows and has no versioned/channel-scoped projection.
      // While query retrieval is enabled, skip this asset step and let the ladder try its question step.
      // 12 ต.ค. 2026: ทักตามแบบมีเรื่องค้างเลือกรีวิวไว้ก่อนร่าง (presetReview — จากการ์ดของสมองรุ่นที่ใช้อยู่เมื่อเปิด retrieval)
      if (retrieval && !presetReview) return null;
      const review = presetReview || pickFollowupReview({ customer, customerId, state, history, reviews: parseReviewCatalog(db.listKnowledge?.() ?? []) });
      if (!review) return null; // รีวิวหมดคลัง — ตกไปขั้นถัดไป
      // 2026-09-28 (audit ก.ย. §4.2): เดิม "คุณ" + known_name ดิบ (ได้ทั้งชื่อ-นามสกุลเต็มและ "คุณคุณ…")
      // ตอนนี้ชื่อต้นคำเดียว และไม่เรียกชื่อถ้าเพิ่งเรียกไปในเทิร์นก่อน ๆ (ตัวตัดสินเดียวกับเส้นตอบปกติ)
      const address = planCustomerAddress({ knownName: customer.known_name || "", history });
      const evidenceLabel = isGenericProfile(activeBrand()) ? "รีวิวจากลูกค้าจริง"
        : isSystemShowcase(review) ? SYSTEM_SHOWCASE_LABEL
        : review.kind === "showcase" ? "ตัวอย่างงาน/บรรยากาศเพื่อให้เห็นภาพ" : review.kind === "profile" ? "คลิปแนะนำผู้สอน" : "รีวิวจากผู้เรียนจริง";
      // 2026-10-03 (พี่ง้วง: ตอบแข็งเกินไป): ไม่มีชื่อ/เพิ่งเรียกชื่อไป = ละการเรียกแบบแอดมินคนจริง
      // (เดิมใส่ "ของคุณลูกค้า" ซึ่งฟังเป็นระบบส่งอัตโนมัติ)
      const intro = !address.generic && address.mayUseName
        ? `ฝาก${evidenceLabel}ไว้ประกอบการเลือกของ${address.label}นะคะ`
        : `ฝาก${evidenceLabel}ไว้ประกอบการเลือกนะคะ`;
      const reviewBubble = `${intro}\n${review.who}\n${review.url}`;
      const question = await getQuestion();
      if (!question) return null;
      return {
        // 12 ต.ค. 2026: ทักตามที่แจ้งราคา/ส่งของที่ค้าง = ข้อความของลูกแพรก่อน แล้วฝากรีวิวต่อท้าย
        bubbles: reviewAfter ? attachBeforeClosingAsk(question, reviewBubble) : [reviewBubble, question],
        images: [],
        record: { kind, review: review.url, question }, retrieval,
      };
    }
    // White-label: รูปบรรยากาศคลาสเป็นของธุรกิจคอร์สเท่านั้น — โปรไฟล์ generic ข้ามไปขั้นคำถาม
    if (kind === "atmosphere" && isGenericProfile(activeBrand())) return null;
    if (kind === "atmosphere") {
      const sentKeys = new Set(db.recentImageKeys?.(customerId, 0) ?? []);
      for (const item of state.history) if (item.image) sentKeys.add(item.image);
      const key = ATMOSPHERE_IMAGES.find((candidate) => catalogByKey.has(candidate) && !sentKeys.has(candidate));
      if (!key) return null; // รูปบรรยากาศส่งครบแล้ว — ตกไปขั้นคำถาม
      const question = await getQuestion();
      if (!question) return null;
      return {
        bubbles: ["ส่งบรรยากาศคลาสจริงให้ดูค่ะ พี่ง้วงสอนกลุ่มเล็ก ดูแลใกล้ชิดทุกท่านเลยนะคะ", question],
        images: [catalogByKey.get(key)],
        record: { kind, image: key, question }, retrieval,
      };
    }
    // question ล้วน
    const question = await getQuestion();
    if (!question) return null;
    return { bubbles: [question], images: [], record: { kind, question }, retrieval };
  }

  // อ่านผลอ่านลูกค้าล่าสุดของ scorer — อ่านพังหรือยังไม่มี ให้คืน null แล้วทำงานต่อได้ปกติ
  // (follow-up ห้ามล้มเพราะเรื่องเสริม)
  function latestScorePayload(customerId) {
    try {
      const row = db.scoreHistory(customerId, 1)?.[0];
      return row?.payload_json ? JSON.parse(row.payload_json) : null;
    } catch { return null; }
  }

  // 12 ต.ค. 2026: บล็อกค่าเรียนของทักตามที่แจ้งราคาที่ค้าง — ตัวเลขทุกตัวจากการ์ดราคาที่อนุมัติ (ช่อง {{ราคา}} ของ v3) · อ่านไม่ได้ = ""
  function threadPriceBlock({ thread, customer, retrieval }) {
    if (!threadDeliversPrice(thread)) return { block: "", amounts: new Set() };
    try {
      const amounts = approvedClassAmounts(retrieval ? retrieval.brain.bundle.guardTables.approvedPrices : db.approvedPrices() ?? []);
      const entries = knowledgeEntriesFor({ brain: retrieval?.brain ?? null, db, channelId: customer?.channel_id || "default" });
      const pf = priceFactsFromKnowledge(entries, amounts);
      if (!pf.ok) return { block: "", amounts };
      const products = (thread.priceClasses || ["business"]).filter((key) => pf.classes?.[key]?.normal != null);
      const block = renderPriceSlot(pf, { products, withPromo: true }) || renderPriceSlot(pf, { products, withPromo: false }) || "";
      return { block, amounts };
    } catch {
      return { block: "", amounts: new Set() };
    }
  }

  // 8 พ.ย. 2026 (พี่ง้วง "พวก follow up ด้วย … ให้ opus ช่วย"): สวิตช์ followup_style_bank = แนบข้อความทักตามจริงของ Opus
  // ที่คล้ายห้องนี้ไว้ท้ายกติกา · ปิด/ไม่มีไฟล์ = กติกาเดิมทุกไบต์
  function withFollowupBank(recentHistory, thread, rules) {
    if (followupStyleBankMode(db) !== "on" || !config.followupStyleBankFile) return rules;
    const bank = loadStyleBank(config.followupStyleBankFile, logger);
    if (!bank.length) return rules;
    const last = (role) => String([...recentHistory].reverse().find((turn) => turn?.role === role)?.content || "");
    return withFollowupExamples(rules, bank, { threadKind: thread?.kind || "", userText: last("user"), prevBot: last("assistant") });
  }

  async function draftQuestion({ stage, customerId, state, paymentNudgeMode = false, retrieval = null, lessonSink = null, thread = null }) {
    const customer = db.getCustomer(customerId);
    const price = thread ? threadPriceBlock({ thread, customer, retrieval }) : { block: "", amounts: new Set() };
    const dealStatus = String(customer?.deal_status || "");
    let hasApprovedFacts = false;
    try {
      hasApprovedFacts = retrieval
        ? (retrieval.brain.bundle.guardTables.approvedPrices?.length ?? 0) > 0
        : (db.approvedPrices()?.length ?? 0) > 0;
    } catch { /* fail-closed เหมือนเส้นหลัก */ }
    const previousTexts = state.history.map((item) => item.question).filter(Boolean);
    const recentHistory = db.recentTurns(customerId, config.historyTurns);
    const result = await hermes.draftReply({
      persona: scopedPersona(persona),
      // 19 ต.ค. 2026: ร่างคำถามทักตามไม่ต้องเห็นรายการคลังรีวิว — รีวิว/ตัวอย่างที่แนบ โค้ดเลือกและประกอบบอลลูนเอง
      // (pickFollowupReview / followupSocialProofFor) · สวิตช์ review_catalog_in_prompt=on = ข้อความเดิม
      knowledge: knowledgeForPrompt({ db, knowledge: applyKnownFactsOverride(retrieval ? retrieval.selection.knowledge : composeKnowledgeForChannel({
        db, channelId: customer?.channel_id || "default", logger,
      }), { hasApprovedFacts, trainingMockMode: config.trainingMockMode, logger }) }),
      brandPack: selectRelevantBrandPack(applyKnownFactsOverride(composeBrandPackOnly({
        db, brandPack, channelId: customer?.channel_id || "default",
      }), { hasApprovedFacts, trainingMockMode: config.trainingMockMode, logger }), "ติดตามลูกค้า", {
        recentContext: recentHistory.slice(-4).map((turn) => ({
          role: turn.role, content: String(turn.content || "").slice(0, 300),
        })),
      }),
      // 2026-09-28: บทเรียนที่เจ้าของสอนชุดเดียวกับเส้นตอบ (ownerLessons.mjs) — ไม่มีบทเรียน = สตริงเดิม
      // 8 พ.ย. 2026: สวิตช์ followup_teacher_rules = กติกาแบบครูท้ายสุด (ปิด = กติกาเดิมทุกไบต์)
      rules: withFollowupTeacher(withFollowupBank(recentHistory, thread, withOwnerLessonRules(db, withCampaignReceiptPolicy((thread ? stagedThreadRules : stagedRules)({ stage, previousTexts, dealStatus, paymentNudge: paymentNudgeMode, scorePayload: latestScorePayload(customerId),
        // เฉพาะธุรกิจคอร์สที่เลิก DISC (มีไฟล์ sales policy) — ธุรกิจอื่นได้กติกาเดิมทุกไบต์
        chatStyle: naturalVoiceMode(db) === "on" && config.salesPolicyFile
          ? chatStyleRule(readChatStyle(recentHistory, "", { presetPhrases: presetButtonPhrases({ db }) })) : "", thread, priceBlock: price.block }), config),
        { channelId: customer?.channel_id || "default", history: recentHistory.slice(-4), sink: lessonSink, logger })), db),
      history: recentHistory,
      userText: thread ? THREAD_USER_TEXT : "(ระบบ) ลูกค้าเงียบไปสักพักแล้ว ช่วยร่างข้อความชวนคุยต่อ 1 ข้อความตามกติกาด้านบน",
      // v1.4.9: เส้น follow-up ใช้ followup_model (ไม่ตั้ง = ตามตัวหลักเหมือนเดิม)
      role: "followup",
      // 7 พ.ย. 2026 (งานแคช): เส้นนี้ค้นการ์ดด้วยคำคงที่ "ติดตามลูกค้า" การ์ดเหมือนกันทุกห้อง จึงแคชได้ ข้อความไม่เปลี่ยน
      cacheBrandPack: true,
    });
    // Paid usage exists even when the text is empty, duplicate or later blocked.
    if (result?.usage) {
      try {
        db.addLlmUsage({
          customerId, kind: "staged_followup", model: result.model || "",
          ...usageFields(result.usage),
        });
      } catch { /* พังห้ามล้มรอบ */ }
    }
    const text = String(result?.text || "").trim();
    if (!text) return null;
    let decision = parseFollowupDraftDecision(text);
    if (decision.action === "skip") return decision;
    // 8 พ.ย. 2026: ร่างที่ลอกป้ายจากคลังทักตามของครูมา ([รอบตามข้อมูลจริง] ฯลฯ) = ไม่ส่ง
    if (FOLLOWUP_BANK_PLACEHOLDER.test(decision.text || "")) return { action: "skip", reason: "bank_placeholder" };
    // รีวิวเคสจริง 6–7 ต.ค.: ด่านหลังร่างของทักตามแบบมีเรื่องค้าง — ตัดประโยคกว้าง ๆ ทิ้ง ไม่เหลือคำถามของเรื่องนั้น = ไม่ส่ง
    // (ค่าร่างจ่ายไปแล้ว แต่ข้อความกว้าง ๆ ที่ส่งออกไปเสียห้องมากกว่า — เส้นไม่ส่งเดียวกับ [[NO_SEND]])
    // 12 ต.ค. 2026: ทักตามที่ส่งของที่ค้างไม่บังคับปิดด้วยคำถาม · แจ้งราคาที่ค้างแต่ร่างไม่มีตัวเลขที่อนุมัติ = วางบล็อกค่าเรียนให้เอง
    if (thread) {
      let kept = stripGenericFollowup(decision.text, { needsQuestion: threadNeedsQuestion(thread) });
      if (!kept) return { action: "skip", reason: "generic_draft" };
      if (price.block && !outboundCarriesClassPrice(kept, price.amounts)) {
        const parts = kept.split(/\n{2,}/u);
        kept = parts.length > 1 ? [parts[0], price.block, ...parts.slice(1)].join("\n\n") : `${price.block}\n\n${kept}`;
      }
      decision = { action: "send", text: kept };
    }
    if (previousTexts.some((previous) => previous === decision.text)) return null;
    return decision;
  }

  // ---- ประเมินลูกค้าหนึ่งคน — คืนสรุปสำหรับ log/เทสต์ ----
  // 12 ต.ค. 2026: สิทธิ์ชวนทดลองเรียนที่จองไว้แต่ไม่ได้ส่งถึงมือ (ร่างไม่ผ่าน/ด่านบล็อก/ลูกค้าพิมพ์แทรก) คืนทุกทางออก
  // 20 ต.ค. 2026 (ขั้นที่ 3 ของแผน soul): ทักตามของห้องนี้เขียนด้วย soul รุ่นของห้อง (รุ่นหลัก หรือรุ่นทดลองเมื่อห้องอยู่ในกลุ่มทดลอง)
  function processCustomer(customer, tsMs) {
    return withRoomSoul(customer?.line_user_id, () => processCustomerHeld(customer, tsMs));
  }
  async function processCustomerHeld(customer, tsMs) {
    const held = { gate: null };
    try {
      return await processCustomerOnce(customer, tsMs, held);
    } finally {
      held.gate?.release();
    }
  }
  async function processCustomerOnce(customer, tsMs, held) {
    const customerId = customer.line_user_id;
    // Preserve the turn that existed when this background draft began.  Do not
    // look it up after drafting, when a new customer message could mis-link it.
    let correctionInboundMessageId = "";
    try { correctionInboundMessageId = String(db.latestInboundMessageId?.(customerId) || ""); } catch { /* unavailable is honest */ }
    if (urgentMentalHandoffActive(customer)) return { customerId, skipped: "urgent_mental_handoff" };
    // v1.4.47: AI paused ทั้งระบบ (cutover) = ห้ามทักตามสเตจ
    if (aiPausedNow({ db, config })) return { customerId, skipped: "ai_paused" };
    if (Number(customer.marketing_consent ?? 0) < 0) return { customerId, skipped: "marketing_optout" };
    if ((Number(customer.operator_active_until) || 0) > tsMs) return { customerId, skipped: "operator_active" };
    if (customer.ai_enabled !== 1 || customer.followup_enabled !== 1 || customer.do_not_disturb === 1) {
      return { customerId, skipped: "customer_disabled" };
    }
    if (db.isBotSilencedByTag(customerId)) return { customerId, skipped: "tag_silenced" };
    if (serviceFollowupPaused(customer)) return { customerId, skipped: "service_boundary" };
    // Check BEFORE a paid draft, not only before sending. Closed Facebook rooms
    // previously generated a new paid draft on every tick for up to ten days.
    if (customer.channel_id === "facebook" && !db.withinFacebookWindow(customerId, tsMs)) {
      return { customerId, skipped: "fb_window_closed" };
    }

    const lastIn = customer.last_inbound_at ?? db.lastInboundAt(customerId);
    const lastOut = db.lastOutboundAt(customerId);
    if (!lastIn) return { customerId, skipped: "no_inbound_history" };
    if (paymentHoldActive({ handoffSummary: customer.handoff_summary, nowMs: tsMs, lastInboundAt: lastIn })) {
      return { customerId, skipped: "payment_in_human_review" };
    }
    const lastActivity = Math.max(lastIn, lastOut ?? 0);

    const state = loadState(customerId, tsMs);
    // ลูกค้าตอบหลัง episode เดิม = เริ่ม episode ใหม่ (บันไดกลับไปขั้นแรก)
    if (!state.episode_anchor || lastIn > state.episode_anchor) {
      state.episode_anchor = lastIn;
      state.ladder_stage = 0;
    }

    // 2026-09-28 (คำสั่งพี่ง้วง): ลูกค้าบอกว่าขอไปเช็คคิว/วันก่อน = บันไดของ episode นี้คือทักหนึ่งครั้ง
    // (หรือไม่ทักเลยถ้าไม่มีช่องที่เหมาะ) แทน cold/warm/hot — สวิตช์ settings.schedule_check_followup อ่านสดทุกรอบ
    const deferral = scheduleCheckEpisode({
      enabled: scheduleCheckFollowupEnabled(db), deferJson: state.defer_json, lastInboundAt: lastIn,
      channelId: customer?.channel_id || "", customerId,
    });
    const stage = deferral ? deferral.stage : warmthBand(Number.isInteger(customer.last_score) ? customer.last_score : null);
    // v1.4.8 (ทวน logic กับพี่ง้วง 2026-08-16): สเตจเปลี่ยน (เช่น cold → warm) = บันได
    // สเตจเดิม "จบ" ทันที บันไดของสเตจใหม่เริ่มนับขั้น 1 ใหม่ — ห้ามสืบทอดเลขขั้นข้ามสเตจ
    // (ไม่งั้น cold ที่ส่งไป 2 ขั้นแล้วขยับเป็น warm จะโดดไปขั้น 3 ข้ามรีวิว/บรรยากาศ)
    if (state.stage_key && state.stage_key !== stage) state.ladder_stage = 0;
    const ladder = deferral ? deferral.ladder : ladderFor(stage, customer?.channel_id || "");
    if (state.ladder_stage >= ladder.length) return { customerId, skipped: "ladder_done" };
    if (stage === "cold" && state.cold_sent_total >= COLD_LIFETIME_CAP) return { customerId, skipped: "cold_cap" };
    if (state.sent_today >= dailyProactiveCapFor(customer?.channel_id || "")) return { customerId, skipped: "daily_cap" };

    // ถึงกำหนดของ "ขั้นนี้" หรือยัง — ตารางรายขั้น + สุ่มบวกลบเล็กน้อย
    // (เพดาน 1 รอบ/วัน ทำให้ตรรกะถอยห่างรายวันแบบเดิมไม่มีวันได้ทำงาน จึงถอดออก)
    const schedule = deferral ? deferral.schedule : scheduleFor(stage, stageDelayMs[stage], customer?.channel_id || "");
    const dueAt = resolveStepDueAt({
      schedule,
      stepIndex: state.ladder_stage,
      anchorMs: state.episode_anchor,
      lastActivityMs: lastActivity,
      customerId,
      channelId: customer?.channel_id || "",
      previousSendMs: state.last_nudge_at,
      previousWasYolo: lastSendWasYolo(state.history),
    });
    if (dueAt == null) return { customerId, skipped: "not_silent_enough" };
    // Facebook: ไม้ที่เว้นระยะแล้วไม่ทันหน้าต่าง 24 ชม. = ข้าม (บันไดจบเร็วขึ้น) — ตัวตัดสินเดียวกับ badge
    if (facebookStepMissesWindow({ channelId: customer?.channel_id, sendAt: Math.max(dueAt, tsMs), lastInboundAt: lastIn })) {
      return { customerId, skipped: "fb_window_ends" };
    }
    if (tsMs < dueAt) return { customerId, skipped: "not_silent_enough" };
    // ด่านสำรอง: ต่อให้คำนวณพลาด ก็ห้ามยิงในช่วงเงียบเด็ดขาด
    if (inQuietHours(tsMs)) return { customerId, skipped: "quiet_hours" };

    const retrieval = config.brainRetrievalEnabled === true
      ? selectFollowupKnowledge({
        config, brainRuntime, db, customerId, channelId: customer.channel_id || "default",
        atMs: tsMs,
      })
      : null;
    if (retrieval && !retrieval.ok) return { customerId, skipped: `brain_retrieval_hold:${retrieval.reason}` };

    // v1.4.11: ดีลจบที่ขั้นรอโอน (คำอธิบายเต็มอยู่ตรงลูปเลือกขั้นด้านล่าง) — คำนวณก่อนเลือกเรื่องที่ค้าง
    const paymentNudgeMode = String(customer?.deal_status) === "awaiting_payment"
      && customer?.ai_off_reason === "bank_sent";
    // รีวิวเคสจริง 6–7 ต.ค. (คำสั่งพี่ง้วง 7 ต.ค.): ห้อง reply_engine = v3 ทักตามได้เฉพาะตอนมีเรื่องที่ค้างอยู่จริงหนึ่งเรื่อง
    // (คำถามที่ลูกแพรถามค้าง · คำถามคัดกรองก่อนแจ้งราคา · รอบที่ชวนเลือก · เรื่องที่ลูกค้าเล่าเอง) และเรื่องนั้นยังไม่เคยทักตามในช่วงเงียบนี้
    // ไม่มีเรื่องค้าง / ลูกแพรปิดห้องหรือลา / ลูกค้าปฏิเสธ เงินตึง ดูแลใจ = จบบันไดของช่วงเงียบนี้ก่อนเรียกโมเดล (ฟรี) — ลูกค้าพิมพ์มา = ช่วงเงียบใหม่
    // รอบรีวิว 8 (นโยบายทักตามที่เจนเคาะ): แผนของเรื่องที่ค้างบอกไม้ที่ใช้ได้ — ขอเวลาคิด/ขั้นสมัครข้ามไม้เร็ว · รอปรึกษา/รอเงินรอถึงวันที่ 2/3
    // · ครั้งที่สองของเรื่องเดิมห่างครั้งแรก ≥20 ชม. · ทักครั้งเดียว/ขั้นสมัคร = คำถามอย่างเดียว (ตัวเลือก/จัดไม้ชุดเดียวกับ badge คอนโซล)
    let thread = null;
    let threadPlan = null;
    if (!deferral && !paymentNudgeMode && followupThreadEnabled(db)) {
      const pick = followupThreadPickFor({ db, config, customer, history: state.history, nowMs: tsMs, bundle: retrieval?.brain?.bundle ?? null, logger });
      if (!pick.thread) {
        state.ladder_stage = ladder.length;
        state.stage_key = stage;
        saveState(customerId, state);
        try {
          db.addAudit({ operator: "system", action: "staged_followup_no_thread", target: customerId, detail: `${stage} ${pick.reason}` });
        } catch { /* audit พังห้ามล้มรอบ */ }
        return { customerId, skipped: `no_thread:${pick.reason}` };
      }
      const planned = threadStepPlan({ plan: pick.plan, schedule, stepIndex: state.ladder_stage, anchorMs: state.episode_anchor,
        channelId: customer?.channel_id || "", customerId, lastInboundAt: lastIn });
      // Facebook: ไม่มีไม้ที่ทันหน้าต่าง 24 ชม. ในช่วงเงียบนี้ (หรือรอเงินเดือน) = ไม่ทัก ไม่ร่าง — เหตุเดียวกับ badge
      if (planned.skip) return { customerId, skipped: planned.skip };
      if (planned.stepIndex > state.ladder_stage) {
        // ไม้เร็วของช่วงเงียบนี้ไม่ใช้ — ขยับบันไดไปไม้ที่ใช้ได้ (ฟรี ไม่ร่าง) แล้วรอเวลาของไม้นั้น
        state.ladder_stage = planned.stepIndex;
        state.stage_key = stage;
        saveState(customerId, state);
        try {
          db.addAudit({ operator: "system", action: "staged_followup_wait", target: customerId,
            detail: `${stage} ${pick.plan.mode} ${pick.thread.kind} → ขั้น ${planned.stepIndex + 1}/${ladder.length}` });
        } catch { /* audit พังห้ามล้มรอบ */ }
        return { customerId, skipped: `thread_wait:${pick.plan.mode}` };
      }
      if (planned.floorAt > 0) {
        const due = threadDueAt({ floorAt: planned.floorAt, schedule, stepIndex: planned.stepIndex, anchorMs: state.episode_anchor,
          lastActivityMs: lastActivity, customerId, channelId: customer?.channel_id || "", previousSendMs: state.last_nudge_at,
          previousWasYolo: lastSendWasYolo(state.history) });
        if ((planned.latestAt && Math.max(due, tsMs) > planned.latestAt)
          || facebookStepMissesWindow({ channelId: customer?.channel_id, sendAt: Math.max(due, tsMs), lastInboundAt: lastIn })) {
          return { customerId, skipped: "fb_window_ends" };
        }
        if (tsMs < due || inQuietHours(tsMs)) return { customerId, skipped: "thread_wait:spacing" };
      }
      thread = pick.thread;
      threadPlan = pick.plan;
    }

    const attemptKey = `${lastIn}:${stage}:${state.ladder_stage}`;
    const claim = db.claimProactiveAttempt(customerId, "staged", attemptKey, tsMs);
    if (!claim.ok) return { customerId, skipped: claim.reason };

    // เลือกขั้น — ขั้นที่ประกอบไม่ได้ (รีวิวหมด/รูปหมด) ตกไปขั้นถัดไปในบันไดเดียวกัน
    // v1.4.11 (คำสั่งพี่ง้วง 2026-08-18): ดีลจบที่ขั้นรอโอน (หน้าต่าง bank_sent) —
    // ทุกขั้นของบันไดกลายเป็น "คำถามทวงโอน" ห้ามส่งรีวิว/รูปแทรก
    // 2026-09-05 (คำสั่งพี่ง้วง): ห้อง bank_sent ไม่ถูกคัดมาถึงตรงนี้อีกแล้ว (ai_enabled = 0)
    // โหมดนี้จึงเป็นเท็จเสมอ — จงใจไม่ลบทิ้ง เพราะถ้าวันหนึ่งมีคนเปิดข้อยกเว้นกลับมา
    // กติกา "ทวงโอนแล้วห้ามแทรกรีวิว/รูป" ต้องยังอยู่ครบ ไม่ใช่ต้องเขียนใหม่จากความจำ
    let step = null;
    let stepIndex = state.ladder_stage;
    // Asset fallbacks share ONE draft, including a null/duplicate result.
    let questionPromise;
    const lessonSink = { ids: [] }; // บทเรียนที่ร่างคำถามของรอบนี้ใช้ — จดลง metadata ตอนส่งสำเร็จ
    // รีวิวที่จะแนบกับทักตามแบบมีเรื่องค้าง — เลือกก่อนร่าง แล้วบอกบรรทัดสั่งงาน (ไม่มีรีวิวแนบ = ห้ามพูดถึง/สัญญาคลิป)
    const threadReview = thread && threadPlan?.withReview && !paymentNudgeMode ? threadReviewFor({ customer, customerId, state, retrieval }) : null;
    if (thread) thread = { ...thread, reviewAttached: Boolean(threadReview) };
    // 12 ต.ค. 2026: ไม้นี้แนบอะไร (รีวิว → รูปบรรยากาศ → คำชวนทดลองเรียนฟรี → รีวิวเพิ่ม) — คำชวนต้องจองสิทธิ์ของวันนี้ได้ก่อนร่าง
    let social = thread && !paymentNudgeMode ? followupSocialProofFor({ customer, customerId, state, retrieval, thread, threadPlan, tsMs, lastIn }) : null;
    if (social?.kind === "trial" || social?.trial) {
      // จองสิทธิ์ของวันนี้ก่อนร่าง — จองไม่ได้ (ครบเพดาน/ห้องได้แล้ว) = ไม้นี้ไม่ชวน (คำชวนที่พ่วงมาหลุด ของชิ้นหลักยังส่ง)
      if (social.gate.reserve().ok) held.gate = social.gate;
      else social = social.kind === "trial" ? null : { ...social, trial: null };
    }
    if (social) social = { ...social, delivery: threadDeliversItem(thread) };
    if (thread && social) thread = { ...thread, socialAttach: social.kind, socialTrial: social.kind === "trial" || Boolean(social.trial) };
    const getQuestionDecision = () => questionPromise ??= draftQuestion({ stage, customerId, state, paymentNudgeMode, retrieval, lessonSink, thread });
    // ไม้ที่มีคำชวนทดลองเรียน: ประโยคที่ร่างอ้างจำนวนสิทธิ์/ที่นั่งเอง = ตัดทิ้ง (คำว่า "จำกัดต่อวัน" อยู่ในคำชวนที่โค้ดเขียน — จริงตามเพดาน)
    // ตัดแล้วไม่เหลือข้อความ = ไม้นี้ไม่ส่ง (ผู้ตรวจ 12 ต.ค.: เดิมตกไปเส้นคำถามอย่างเดียวแล้วส่งร่างที่ยังไม่ตัด)
    const trialAttached = Boolean(thread?.socialTrial);
    const getQuestion = async () => {
      const decision = await getQuestionDecision();
      if (decision?.action !== "send") return null;
      if (!trialAttached) return decision.text;
      const honest = stripFakeScarcity(decision.text);
      return /\p{L}/u.test(honest) ? honest : null;
    };
    while (stepIndex < ladder.length && !step) {
      // รอบรีวิว 8 (U5): ทักครั้งเดียว (ขอเวลาคิด/รอปรึกษา/รอเงิน) และขั้นสมัคร = คำถามอย่างเดียว ไม่มีรีวิว/รูปบรรยากาศแทรก
      const ladderKind = paymentNudgeMode || threadPlan?.questionOnly ? "question" : ladder[stepIndex];
      // 12 ต.ค. 2026 (คำสั่งพี่ง้วง "ส่งรีวิวด้วย แล้วแต่บริบท"): แจ้งราคาที่ค้าง/ลูกค้าขอคลิปรีวิว = ฝากรีวิวผู้เรียนจริงต่อท้ายถ้ามีในคลัง
      // ไม่มีรีวิวให้ส่ง = คำถาม/ข้อความอย่างเดียวในไม้เดียวกัน (ไม่ข้ามไม้ของบันได)
      if (thread && threadPlan?.withReview && !paymentNudgeMode) {
        step = (threadReview ? await buildStep({ kind: "review_question", stage, customer, customerId, state, getQuestion, retrieval, reviewAfter: true,
          presetReview: threadReview }) : null)
          ?? await buildStep({ kind: "question", stage, customer, customerId, state, getQuestion, retrieval });
      } else if (thread && !paymentNudgeMode && !threadPlan?.questionOnly) {
        // 12 ต.ค. 2026: ห้อง v3 — ของที่แนบมาจากตัวตัดสินเดียว (ไม่ใช่ชนิดไม้ของบันไดเดิม) · ไม่มีของให้แนบ = ข้อความทักตามอย่างเดียว
        step = (social ? await buildSocialStep({ social, getQuestion, retrieval }) : null)
          ?? await buildStep({ kind: "question", stage, customer, customerId, state, getQuestion, retrieval });
      } else {
        step = await buildStep({ kind: ladderKind, stage, customer, customerId, state, getQuestion, paymentNudgeMode, retrieval, deferral });
      }
      if (!step) stepIndex += 1;
    }
    if (!step) {
      const decision = questionPromise ? await questionPromise : null;
      if (decision?.action === "skip") {
        try {
          db.closeProactiveAttempt?.(customerId, "staged", attemptKey, tsMs);
          db.addAudit({
            operator: "system", action: "staged_followup_no_send", target: customerId,
            detail: `reason=${decision.reason}`,
          });
        } catch (err) {
          logger.debug?.(`stagedFollowups: บันทึก no-send decision ไม่สำเร็จ (${err?.message || err})`);
        }
        // รอบรีวิว 8 (C3): ห้อง v3 — ร่างกว้าง ๆ/โมเดลบอกไม่ส่ง = ไม้นี้จบ (ขยับบันไดไปไม้ถัดไปของแผน) ไม่ค้างอยู่ขั้นเดิม
        // (เดิมแถวพยายามปิดแล้ว ทุกรอบได้ delivery_fenced และ badge ค้าง "รอไม้นี้" ตลอดไป) · ไม่นับเป็นการทัก
        if (thread) {
          state.ladder_stage = Math.min(ladder.length, state.ladder_stage + 1);
          state.stage_key = stage;
          saveState(customerId, state);
        }
        return { customerId, skipped: `no_send:${decision.reason}` };
      }
      return { customerId, skipped: "no_content" };
    }
    // 2026-09-28 (audit ก.ย. §4.2): คำถามที่โมเดลร่างลอกชื่อเต็มจากประวัติได้ — ด่านเดียวกับเส้นตอบปกติ
    // (บอลลูนรีวิว + บอลลูนคำถามใช้โควตาเรียกชื่อก้อนเดียวกัน)
    const followupAddress = planCustomerAddress({
      knownName: customer.known_name || "", displayName: customer.display_name || "",
      history: db.recentTurns(customerId, 12),
    });
    // 2026-10-03: ห้องที่ไม่มีชื่อเรียกได้ — ตัด "คุณลูกค้า" จากคำถามที่โมเดลร่าง (ด่านเดียวกับเส้นตอบปกติ)
    step.bubbles = enforceCustomerAddressAll(step.bubbles, followupAddress)
      .map((bubble) => dropGenericAddress(bubble, followupAddress));

    // P2: ตารางราคาของห้องนี้ (ดู complianceGuard.checkOutbound) ไม่ใช่ตารางกลาง
    const check = guard.checkOutbound(step.bubbles.join("\n\n"), {
      customerId, channelId: customer?.channel_id || "",
      ...(retrieval ? { approvedPrices: retrieval.brain.bundle.guardTables.approvedPrices } : {}),
    });
    if (!check.ok) {
      const summary = check.violations.map((v) => `${v.type}:${v.detail ?? ""}`).join(", ");
      try {
        db.addCorrection({
          customerId, aiDraft: step.bubbles.join("\n\n"), humanFinal: "",
          sourceReason: formatSystemCorrectionSource("system:staged_followup_compliance_block", check.violations),
          inboundMessageId: correctionInboundMessageId,
        });
      } catch { /* บันทึกพังห้ามล้มรอบ */ }
      logger.warn?.(`stagedFollowups: guard บล็อก (${summary}) customer=${customerId}`);
      return { customerId, skipped: `guard_blocked:${summary}`.slice(0, 160) };
    }

    const humanized = step.bubbles.map((text) => humanizer.humanize({ customerId, text }));
    const bubbles = humanized.flat();
    if (!bubbles.length) return { customerId, skipped: "empty_after_humanize" };
    // รูปของไม้ที่แนบของ: วางต่อจากบอลลูนคำนำของมัน (นับหลังตัวแบ่งบอลลูน) — ไม่ระบุ = ตัวส่งวางตามกติกาเดิม
    const imageAfter = Number.isInteger(step.imageAfter)
      ? humanized.slice(0, step.imageAfter).reduce((n, parts) => n + parts.length, 0) : undefined;

    // เช็คซ้ำสด ๆ ก่อนยิง — ร่างกินเวลาได้เป็นนาที ลูกค้า/แอดมินอาจแทรกระหว่างนั้น
    // (NEEDS_HUMAN ไม่อยู่ในเช็คนี้โดยเจตนา — เหตุผลเดียวกับ candidates ด้านบน)
    const fresh = db.getCustomer(customerId);
    if (urgentMentalHandoffActive(fresh)) return { customerId, skipped: "urgent_mental_handoff" };
    // ป้ายเงียบ (customer = ซื้อแล้ว · null = ไม่ได้มาคุย) — ทีมงานอาจเพิ่งติดระหว่างที่ร่างอยู่
    if (db.isBotSilencedByTag(customerId)) return { customerId, skipped: "tag_silenced" };
    if (
      // 2026-09-05 (คำสั่งพี่ง้วง): ด่านสุดท้ายก่อนข้ามเส้น provider — เดิมยอมให้ห้อง
      // bank_sent ผ่าน ตอนนี้ AI ปิด = หยุดทุกกรณี (ต้องสมมาตรกับ previewStagedFollowup
      // และ SQL คัดห้องใน db.mjs เสมอ ไม่งั้น badge บนเว็บกับของที่ส่งจริงจะเล่าคนละเรื่อง)
      !fresh || fresh.ai_enabled !== 1
      || fresh.do_not_disturb === 1 || fresh.followup_enabled !== 1
      || serviceFollowupPaused(fresh)
      || Number(fresh.marketing_consent ?? 0) < 0
      || (Number(fresh.operator_active_until) || 0) > now()
    ) return { customerId, skipped: "superseded_before_send" };
    const freshInbound = db.lastInboundAt(customerId);
    if (freshInbound && freshInbound > lastIn) return { customerId, skipped: "superseded_before_send" };
    // Pause can change while the staged agent is drafting. This is the final
    // fail-closed check before crossing the LINE provider boundary.
    if (aiPausedNow({ db, config })) return { customerId, skipped: "ai_paused_before_send" };
    // v1.5: Facebook — FU ออกได้เฉพาะในหน้าต่าง 24 ชม. (นโยบาย Meta — เสี่ยงแบนทั้งเพจ)
    // เกินแล้วข้ามถาวร: ลูกค้าทักใหม่เมื่อไหร่ บันไดขั้นถัดไปตั้งนัดใหม่ให้เองตามปกติ
    if ((fresh.channel_id || "") === "facebook" && !db.withinFacebookWindow(customerId, now())) {
      return { customerId, skipped: "fb_window_closed" };
    }

    const stillRelevant = () => {
      const current = db.getCustomer(customerId);
      const currentInboundAt = db.lastInboundAt(customerId);
      return Boolean(
        current
        && current.ai_enabled === 1
        && current.do_not_disturb === 0
        && current.followup_enabled === 1
        && !serviceFollowupPaused(current)
        && Number(current.marketing_consent ?? 0) >= 0
        && (Number(current.operator_active_until) || 0) <= now()
        && (current.channel_id !== "facebook" || db.withinFacebookWindow(customerId, now()))
        && globalEnabled()
        && !db.isBotSilencedByTag(customerId)
        && !(currentInboundAt && currentInboundAt > lastIn)
        && !aiPausedNow({ db, config })
      );
    };
    const lineCh = lineRegistry.forChannel(fresh.channel_id || "default");
    const to = lineRegistry.rawUserId(customerId);
    if (!stillRelevant()) return { customerId, skipped: "superseded_before_send" };
    if (!await reviewFollowup({ reviewer: decisionReview, db, customerId, turnId: correctionInboundMessageId,
      notifier, threshold10: config.jevReviewThreshold,
      blockPaymentInstructions: config.salesDecisionGuardEnabled === true,
      draftText: [...bubbles.map(b => b.text), ...(step.images || []).map(image => `[IMAGE:${image.key}]`)].join("\n"),
      // 19 ต.ค. 2026: ด่านตรวจเห็นเฉพาะรายการคลังที่อยู่ในร่างนี้จริง (บอลลูนรีวิวที่โค้ดเลือก)
      knowledge: knowledgeForDraftReview({ db, draftText: [...bubbles.map(b => b.text)].join("\n"),
        knowledge: retrieval?.selection?.knowledge || composeKnowledgeForChannel({ db, channelId: fresh.channel_id || "default", logger }) }),
      isCurrent: stillRelevant })) return { customerId, skipped: "jev_review_required" };
    if (!stillRelevant()) return { customerId, skipped: "superseded_after_jev" };
    if (!db.fenceProactiveSend(customerId, "staged", attemptKey, now())) {
      return { customerId, skipped: "delivery_fenced" };
    }
    const sendResult = await lineCh.sendBubbles({
      // follow-up: ลูกค้าไม่ได้อยู่หน้าจอ ส่งทั้งชุดในคำขอเดียว ผลที่เห็นเหมือนเดิม
      // แต่ไม่มีกรณีได้ข้อความครึ่งเดียวเวลาล้มกลางทาง
      batch: true,
      to, replyToken: "", bubbles,
      images: (step.images || []).map((entry) => ({ key: entry.key, url: entry.url, previewUrl: entry.preview_url ?? entry.previewUrl })),
      ...(imageAfter !== undefined ? { imageAfter } : {}),
      stillRelevant,
      purpose: SEND_PURPOSE.followup,
    });
    db.settleProactiveSend(customerId, "staged", attemptKey, now());
    // ส่งล้มกลางลูป: บันทึกส่วนที่ถึงมือลูกค้าแล้วเสมอ (บทเรียนโควตาหมด 2026-08-15)
    const expectedMessages = [
      ...bubbles.map((bubble) => ({ type: "text", text: bubble.text })),
      ...(step.images || []).map((image) => ({
        type: "image", originalContentUrl: image.url, previewImageUrl: image.preview_url ?? image.previewUrl ?? image.url,
      })),
    ];
    const delivered = Array.isArray(sendResult.delivered)
      ? sendResult.delivered
      : sendResult.ok && Array.isArray(sendResult.acceptedRequestMessages)
        ? sendResult.acceptedRequestMessages
        : sendResult.ok ? expectedMessages : [];
    if (!delivered.length) {
      // ส่งล้มทั้งชุด: ผลกำกวม (0/5xx) = คำชวนอาจถึงแล้ว → จดว่าส่งแล้ว · ล้มชัดเจน = คืนสิทธิ์
      if (held.gate) {
        held.gate.settle(trialDeliveredText({ sendResult, delivered: [], intended: bubbles.map((bubble) => bubble.text) }));
        held.gate = null;
      }
      return { customerId, skipped: sendResult.stoppedEarly
        ? "superseded_before_send"
        : `send_failed:${sendResult.status ?? sendResult.reason ?? "?"}` };
    }
    const imageByUrl = new Map((step.images || []).map((image) => [image.url, image]));
    const deliveredText = [];
    let logged = 0;
    for (const message of delivered) {
      // Preserve the existing accepted-text bubble form without `type`.
      // Require actual text so an image can never create an undefined text row.
      if ((message?.type === "text" || message?.type === undefined || message?.type === null) && typeof message?.text === "string") {
        db.insertMessage({
          customerId, direction: "out", msgType: "text",
          content: message.text, messageClass: "proactive", agentMode: "ai",
          ...(retrieval ? { brainVersionId: retrieval.brain.versionId, metadata: { brainRetrieval: retrieval.selection.trace } } : {}),
          ...ownerLessonMetadata(lessonSink.ids, { brainRetrieval: retrieval?.selection?.trace }),
        });
        deliveredText.push(message.text);
        logged += 1;
      } else if (message?.type === "image") {
        const image = imageByUrl.get(message.originalContentUrl);
        if (!image) continue;
        db.insertMessage({
          customerId, direction: "out", msgType: "image",
          content: `[image:${image.key}] ${image.url}`, messageClass: "proactive", agentMode: "ai",
          ...(retrieval ? { brainVersionId: retrieval.brain.versionId, metadata: { brainRetrieval: retrieval.selection.trace } } : {}),
          ...ownerLessonMetadata(lessonSink.ids, { brainRetrieval: retrieval?.selection?.trace }),
        });
        logged += 1;
      }
    }
    // จังหวะราคา: บันไดขั้นที่มีตัวเลขราคาอยู่ในตัว (ร่างด้วยความรู้ชุดเดียวกับเส้นตอบปกติ
    // และผ่าน guard ตัวเดียวกัน) ต้องปักหมุดเหมือนกัน ไม่งั้นห้องนั้นติดค้างราคาตลอดไป
    // — เหตุผลเต็มอยู่ที่ followupEngine.mjs ซึ่งมีช่องโหว่ทรงเดียวกันเป๊ะ ๆ
    try {
      const amounts = approvedClassAmounts(retrieval
        ? retrieval.brain.bundle.guardTables.approvedPrices
        : db.approvedPrices() ?? []);
      if (outboundCarriesClassPrice(deliveredText.join("\n"), amounts)) db.markPriceQuoted?.(customerId);
    } catch (err) {
      logger.debug?.(`stagedFollowups: ปักหมุดจังหวะราคาไม่สำเร็จ (${err?.message || err}) — ไม่มีผลกับรอบนี้`);
    }
    recordOwnerLessonUse(db, lessonSink.ids, { logger });
    // คำชวนทดลองเรียน: ลิงก์ถึงมือแล้ว = นับเป็นคำชวนของวันนี้ (ห้องนี้ไม่ได้คำชวนอีก) · ไม่ถึง = คืนสิทธิ์
    // ผลส่งกำกวม (0/5xx — LINE อาจรับไปแล้ว) = ถือว่าอาจถึงแล้ว ไม่คืนสิทธิ์
    if (held.gate) {
      held.gate.settle(sendResult.ok ? deliveredText.join("\n")
        : trialDeliveredText({ sendResult, delivered: deliveredText, intended: bubbles.map((bubble) => bubble.text) }));
      held.gate = null;
    }
    const partial = !sendResult.ok
      || sendResult.stoppedEarly === true
      || delivered.length < expectedMessages.length
      || logged < expectedMessages.length;
    // A relevance change means later items were deliberately withheld; preserve the
    // ladder so the next eligible turn can decide afresh. A provider failure after
    // accepted messages is different: advancing prevents those accepted messages
    // (especially reviews/media) from being sent a second time.
    if (partial && (sendResult.stoppedEarly === true || logged === 0)) {
      return { customerId, partial: true, delivered: logged, expected: expectedMessages.length };
    }

    if (state.ladder_stage === 0) state.episodes_today += 1;
    // v1.4.11b: โหมดทวงโอน = หนึ่ง nudge ต่อหนึ่งช่วงเงียบ (ลูกค้าตอบค่อยเริ่ม episode ใหม่)
    // — audit จับว่าบันได warm 3 ขั้นจะกลายเป็นทวงโอน 3 รอบใน ~90 นาที ซึ่งรำคาญเกิน
    state.ladder_stage = paymentNudgeMode ? ladder.length : stepIndex + 1;
    state.stage_key = stage;
    state.last_nudge_at = tsMs;
    state.nudge_count += 1;
    state.sent_today += 1;
    if (stage === "cold") state.cold_sent_total += 1;
    state.history.push({ ...step.record, ...(thread ? { thread: thread.kind, mode: threadPlan.mode } : {}), at: tsMs, stage });
    saveState(customerId, state);
    // ทักครั้งเดียวของ "ขอเช็คคิวก่อน" ถึงมือแล้ว — จดเวลาไว้ในหมุด ลูกค้าพิมพ์อะไรหลังจากนี้ = คุยปกติ
    // (คอนโซลอ่านหมุดตัวเดียวกันจึงเล่าเรื่องเดียวกับเส้นยิงจริง)
    if (deferral && step.record.kind === SCHEDULE_CHECK_STAGE) {
      try {
        db.setFollowupDefer?.(customerId, JSON.stringify({ ...deferral.marker, sentAt: tsMs }));
      } catch (err) {
        logger.warn?.(`stagedFollowups: จดเวลาทักหลังขอเช็คคิวไม่สำเร็จ (${err?.message || err}) customer=${customerId}`);
      }
    }
    try {
      db.addAudit({
        operator: "system", action: partial ? "staged_followup_partial" : "staged_followup_sent", target: customerId,
        detail: `${stage} ขั้น ${stepIndex + 1}/${ladder.length} (${step.record.kind}${thread ? ` · ${thread.kind}` : ""})`,
      });
    } catch { /* audit พังห้ามล้มรอบ */ }
    return {
      customerId, sent: step.record.kind, stage, step: stepIndex + 1,
      ...(partial ? { partial: true, delivered: logged, expected: expectedMessages.length } : {}),
    };
  }

  async function runTick() {
    const tsMs = now();
    if (!globalEnabled()) return { skipped: "disabled" };

    // audit 2026-08-26 (วิกฤต): ตอน AI ถูกหยุดทั้งระบบ processCustomer เด้งออกก่อน
    // เขียนสถานะใด ๆ ทั้งสิ้น = เครื่องยนต์ไม่ได้ "พัก" แต่ "ถูกแช่แข็ง"
    // วินาทีที่เปิด AI กลับมา รอบถัดไป (60 วินาที) จะเห็นลูกค้าทุกคนที่คุยใน 3 วัน
    // ครบทีเดียวและยิงข้อความทักตามออกไปพร้อมกันทั้งกอง ไม่มีเพดาน ไม่เช็คโควตา LINE
    //
    // สองด่านใหม่:
    //  (ก) รอบแรกหลังกลับมาทำงาน = ไม่ส่งอะไรเลย แค่ตั้งนาฬิกาให้ทุกคนใหม่
    //      (ปล่อยให้ processCustomer เขียน state ตามปกติในรอบถัดไป)
    //  (ข) เพดานจำนวนคนต่อรอบ กันกองใหญ่ทะลักในรอบเดียวแม้ไม่ใช่จังหวะกลับมา
    const paused = aiPausedNow({ db, config });
    const wasPaused = lastTickPaused;
    lastTickPaused = paused;
    if (paused) return { skipped: "ai_paused" };
    if (wasPaused === true) {
      // กลับมาทำงานพอดี — ข้ามรอบนี้ทั้งรอบโดยตั้งใจ ให้คนได้ตั้งหลักก่อน
      logger.log?.("stagedFollowups: เพิ่งกลับมาจากสถานะหยุด — ข้ามรอบนี้ ไม่ยิงข้อความทักตามย้อนหลัง");
      return { skipped: "resume_grace" };
    }

    let candidates;
    try {
      candidates = db.listStagedFollowupCandidates({ nowMs: tsMs, activeWithinMs: ACTIVE_WITHIN_MS });
    } catch (err) {
      logger.error?.(`stagedFollowups: อ่านรายชื่อลูกค้าไม่ได้ (${err?.message || err})`);
      return { skipped: "candidates_error" };
    }
    // Expired/blocked rooms must not consume all five candidate slots forever.
    candidates = candidates.filter((customer) => customer.channel_id !== "facebook"
      || db.withinFacebookWindow(customer.line_user_id, tsMs));
    const total = candidates.length;
    if (total > MAX_PER_TICK) {
      logger.warn?.(`stagedFollowups: มีผู้เข้าเกณฑ์ ${total} คน เกินเพดานต่อรอบ ${MAX_PER_TICK} — ทยอยทำรอบละ ${MAX_PER_TICK}`);
    }
    // Fair scanning: permanently held/uncertain rows cannot monopolise the
    // first five positions and starve every other eligible room.
    const startAt = total ? candidateOffset % total : 0;
    candidates = [...candidates.slice(startAt), ...candidates.slice(0, startAt)].slice(0, MAX_PER_TICK);
    candidateOffset = total ? (startAt + candidates.length) % total : 0;
    const results = [];
    for (const customer of candidates) {
      try {
        results.push(await processCustomer(customer, tsMs));
      } catch (err) {
        // ลูกค้าเดียวพังห้ามล้มทั้งรอบ
        logger.error?.(`stagedFollowups: ${customer.line_user_id} ล้มเหลว (${err?.message || err})`);
        results.push({ customerId: customer.line_user_id, skipped: "error" });
      }
    }
    // ห้องหลังส่งบัญชีไม่ใช่ candidate ของบันได (followup_enabled = 0) — ตัวทักเบา ๆ คัดห้องของตัวเอง
    let payment = null;
    if (paymentNudge) {
      try {
        payment = await paymentNudge.runTick(tsMs);
      } catch (err) {
        logger.error?.(`stagedFollowups: ทักหลังส่งบัญชีล้มเหลว (${err?.message || err})`);
        payment = { skipped: "error" };
      }
    }
    return { results, deferred: Math.max(0, total - results.length), ...(payment ? { payment } : {}) };
  }

  async function runOnce() {
    if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
    try { return await runTick(); } finally { lock.release(); }
  }

  function start() {
    if (!(tickMs > 0)) return null;
    timer = setInterval(async () => {
      try {
        await runOnce();
      } catch (err) {
        logger.error?.(`stagedFollowups: รอบล้มเหลว (${err?.message || err})`);
      }
    }, tickMs);
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce, processCustomer };
}
