// consoleBehaviorSwitchesApi.mjs — GET/POST /console/api/settings/behavior-switches (28 ก.ย. 2026)
//
// งานคืน 28 ก.ย. เพิ่มพฤติกรรมใหม่สามอย่างที่อ่านสวิตช์สดทุกข้อความจากตาราง settings:
//   coaching_brake_mode    — เบรกการสอนยาว แล้วพาไปคลาสอย่างนุ่มนวล (coachingBrake.mjs)
//   reply_closing_question — ปิดท้ายทุกคำตอบด้วยคำถามเบา ๆ หนึ่งข้อ (replyClosingQuestion.mjs)
//   pause_resume_answer    — ตอบข้อความที่ค้างระหว่างพัก 15 นาทีเมื่อหมดเวลาพัก (pauseHeld.mjs)
// เช้า 28 ก.ย. เพิ่มอีกสอง (คำสั่งพี่ง้วง — ทักตามแบบไม่ให้ลูกค้ารู้สึกถูกจี้):
//   payment_gentle_nudge    — ทักเบา ๆ หนึ่งครั้งหลังส่งเลขบัญชี (paymentGentleNudge.mjs)
//   schedule_check_followup — ลูกค้า "ขอเช็คคิวก่อน" = ตอบให้รอบ ไม่ถามปิดท้าย แล้วทักครั้งเดียวแทนบันได (scheduleCheck*.mjs)
// บ่าย 28 ก.ย. เพิ่ม (คำสั่งพี่ง้วง "ช่วยให้ลูกแพร telegram มีสมอง และคุยกับพี่ง้วงได้"):
//   owner_chat_mode         — ข้อความใน Telegram ที่ไม่ใช่คำสั่ง = คุยกับลูกแพร (ownerChat.mjs) · ปิด = รับแต่คำสั่ง
//   owner_chat_model        — โมเดลของแชทเจ้าของ: luna (ค่าตั้งต้น ไว/ถูก) · sol (โมเดลเดียวกับที่ตอบลูกค้า — ownerChatModel.mjs)
//   lesson_digest_mode      — ส่งสรุปบทเรียนรออนุมัติให้เจ้าของกดใน Telegram ทุกคืน 22:00 (telegramLessonDigest.mjs)
// เย็น 28 ก.ย. เพิ่ม (พี่ง้วงอนุมัติกรอบป้ายชุดเดียว):
//   tag_framework_mode      — ป้ายลูกค้าชุดเดียว (tagFrameworkMode.mjs) · โผล่เฉพาะเมื่อมีไฟล์กรอบป้าย
// ค่ำ 28 ก.ย. 2026 (คำสั่งพี่ง้วง "เทียบลูกค้าระหว่าง fb, LINE ... จะได้ seamless"):
//   identity_link_mode      — off (ค่าเริ่มต้น: ไม่มีข้อความถึงลูกค้า) · manual (ปุ่มส่งลิงก์ LINE ในห้อง Facebook)
//                             · auto (manual + ส่งให้เองหนึ่งครั้งเมื่อทีมติดป้าย customer/ยืนยันยอด) — identityLink.mjs
// เดิมเปิด/ปิดได้ทางเดียวคือยิงคำสั่งบน VPS — แผงนี้ให้เจ้าของกดเองในหน้าตั้งค่าได้ทันที ไม่ต้อง deploy
//
// อ่านได้ทุกบทบาทที่เข้าหน้าตั้งค่าได้ (ทีมควรรู้ว่าลูกแพรทำอะไรอยู่) · เปลี่ยนได้เฉพาะ Super Admin
// เพราะทุกตัวเปลี่ยนวิธีพูดกับลูกค้าจริงทันที — เหตุผลเดียวกับสวิตช์หยุด AI ทั้งระบบ
// ค่าที่อ่านกลับมาใช้ตัวอ่านของแต่ละโมดูลตรง ๆ (ไม่มีตรรกะชุดที่สองให้เพี้ยน)
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { activeBrand, brandText, isGenericProfile } from "./brand.mjs";
import { COACHING_BRAKE_MODE_KEY, coachingBrakeMode } from "./coachingBrake.mjs";
import { REPLY_CLOSING_QUESTION_KEY, replyClosingQuestionMode } from "./replyClosingQuestion.mjs";
import { PAUSE_RESUME_SETTING, pauseResumeMode } from "./pauseHeld.mjs";
import { PAYMENT_GENTLE_NUDGE_KEY, paymentGentleNudgeMode } from "./paymentGentleNudge.mjs";
import { SCHEDULE_CHECK_FOLLOWUP_KEY, scheduleCheckFollowupMode } from "./scheduleCheck.mjs";
import { OWNER_CHAT_MODE_KEY, ownerChatMode } from "./ownerChat.mjs";
import { OWNER_CHAT_MODEL_KEY, OWNER_CHAT_MODEL_MODES, ownerChatModelMode } from "./ownerChatModel.mjs";
import { LESSON_DIGEST_MODE_KEY, LESSON_DIGEST_MODES, lessonDigestMode } from "./telegramLessonDigest.mjs";
import { TAG_FRAMEWORK_MODE_KEY, TAG_FRAMEWORK_MODES, tagFrameworkMode } from "./tagFrameworkMode.mjs";
import { IDENTITY_LINK_MODE_KEY, IDENTITY_LINK_MODES, identityLinkMode } from "./identityLinkCodes.mjs";
// 28 ก.ย. 2026: สวิตช์รวมข้อความตามขั้น (Step messages) — ไม่มีแถว = on (ส่งเฉพาะลำดับที่คนกดเปิดใช้) · off = หยุดทุกชุดทันที
import { STEP_MESSAGES_MODE_KEY, stepMessagesMode } from "./stepMessages.mjs";
// 29 ก.ย. 2026: push แจ้งทีม "ลูกค้าร้อนรอทีมทักต่อ" 09:10/13:10/18:10 — ไม่มีแถว = on · off = หยุดส่งทันที
import { HOT_FOLLOWUP_PUSH_MODE_KEY, hotFollowupPushMode } from "./hotFollowupPush.mjs";
import { TEAM_REVIEW_MODE_KEY, teamReviewMode } from "./teamReplyReview.mjs";
// 4 ต.ค. 2026: น้ำเสียงคนคุยแชท (คำสั่งพี่ง้วง "ยกเครื่องการตอบแชทลูกแพร") — ไม่มีแถว = off = พรอมต์เดิมทุกไบต์
import { NATURAL_VOICE_MODE_KEY, NATURAL_VOICE_MODES, naturalVoiceMode } from "./writerVoice.mjs";
// 5 ต.ค. 2026 (คำสั่งพี่ง้วง "ทุกชั่วโมงให้ AI อีกตัวกวาดแชท ... ปิด AI ห้องที่ไม่มีศักยภาพเป็นสีเหลือง"):
//   qualify_sweep_mode — off (ไม่มีแถว/อ่านพัง: ไม่เรียกโมเดลเลย) · shadow (ทดลอง: ตัดสินแล้วจดไว้ ไม่ปิดห้องจริง) · on (ปิด/เปิดห้องสีเหลืองจริง)
import { QUALIFY_SWEEP_MODE_KEY, QUALIFY_SWEEP_MODES, qualifySweepMode } from "./notQualified.mjs";
// 4 ต.ค. 2026: เครื่องตอบแชท v3 (spec v3.1) — ไม่มีแถว = legacy = เครื่องตอบเดิมทุกไบต์ · ถอยกลับ = กดกลับเป็นเครื่องเดิม
import { REPLY_ENGINE_KEY, REPLY_ENGINE_MODES, replyEngineMode } from "./replyEngineV3/mode.mjs";
// 6 ต.ค. 2026 (แอดชุด QUALIFIED MSG — "แอดตัวไหนพาคนแบบไหนมา"):
//   ad_referral_capture — off (ไม่มีแถว/อ่านพัง: ไม่จดอะไร) · on (จดที่มาจากแอดของห้อง Facebook) — จดอย่างเดียว ไม่แตะการตอบ
//   order_mode — shipping (ค่าเริ่มต้น: ร้านส่งของ) · class (ขายคลาส: ไม่มีขั้นจัดส่ง ข้อมูลผู้เรียนแทนที่อยู่ ผูกรอบเรียน)
import { AD_REFERRAL_CAPTURE_KEY, AD_REFERRAL_CAPTURE_MODES, adReferralCaptureMode } from "./adReferral.mjs";
import { ORDER_MODE_KEY, ORDER_MODES, orderMode } from "./orderMode.mjs";
import { META_CAPI_MODE_KEY, META_CAPI_MODES, metaCapiMode } from "./metaCapi.mjs";
// 12 ต.ค. 2026 (คำสั่งพี่ง้วง "คุยไปเรื่อย ... ให้คุณตีจบได้เลย"): ตีจบแชทนอกเรื่อง — ไม่มีแถว = on · shadow = ทดลอง (จดอย่างเดียว) · off = ปิด
//   ปุ่มหยุดฉุกเฉินที่ไม่ต้องปิดตัวกวาด (ปิดตัวกวาด = คืน AI ให้ห้องเหลืองทุกห้อง)
import { OFFTOPIC_CLOSE_MODE_KEY, OFFTOPIC_CLOSE_MODES, offtopicCloseMode } from "./offtopicClose.mjs";
// 12 ต.ค. 2026 ค่ำ (พี่ง้วง: "ไม่มีอะไรปิดเองอีกแล้ว — AI เสนอ พี่ง้วง/ชมพู่ยืนยัน"): ตีจบแชทนอกเรื่อง ไม่มีแถว = propose
//   owner_review_mode — รอบตรวจ 09/12/15/19 + คิวตรวจแชท 20:00 (เฟส B): ไม่มีแถว = on (ปลุกมือถือพี่ง้วง) · shadow = เสนอ/จัดคิวอย่างเดียว
//                       ไม่ปลุก (ยังไม่นับวันที่ 1 ของสัปดาห์แรก) · off = ไม่ตรวจ
//   owner_review_scan_scope — all (ค่าเริ่มต้นสัปดาห์แรก: อ่านท่าทีทุกห้องที่มีข้อความใหม่) · cue_only (เฉพาะห้องที่เจอคำนอกเรื่อง)
// 19 ต.ค. 2026 (คำสั่งพี่ง้วง "เอาคลังรีวิวออกจาก prompt"): ปุ่มถอยกลับไม่ต้อง deploy —
//   review_catalog_in_prompt — off (ไม่มีแถว: แนบเฉพาะกติกาการใช้ + รายการที่โค้ดเลือก · คลังรีวิวมีงบแยก 40,000)
//                              · on (แบบเดิมทุกไบต์: แนบทั้งคลังทุกคำตอบ · นับรวมงบ 80,000)
import { REVIEW_CATALOG_IN_PROMPT_KEY, REVIEW_CATALOG_IN_PROMPT_MODES, reviewCatalogInPromptMode } from "./knowledgePack.mjs";
import {
  OWNER_REVIEW_MODE_KEY, OWNER_REVIEW_MODES, OWNER_REVIEW_SCAN_SCOPE_KEY, OWNER_REVIEW_SCAN_SCOPES, ownerReviewMode, ownerReviewScanScope,
} from "./ownerReviewScheduler.mjs";
// 20 ต.ค. 2026 (ขั้นที่ 3 ของแผน soul): เปิดใช้ soul รุ่นทดลองที่มากับ release — off (ไม่มีแถว: ทุกห้องรุ่นหลักทุกไบต์)
//   · canary (ห้องใหม่หลังเวลากด ตามสัดส่วน soul_candidate_percent ค่าเริ่มต้น 20%) · all (ทุกห้องและทุกเส้น)
//   โผล่เฉพาะเมื่อ release มีรุ่นทดลอง · กดเป็น canary = เริ่มนับห้องใหม่ตอนนั้น · ถอยกลับ = กด off ไม่ต้อง deploy
import { onSoulCandidateModeChange, SOUL_CANDIDATE_MODE_KEY, SOUL_CANDIDATE_MODES, soulCandidateMode } from "./soulRollout.mjs";
import { candidateSoul } from "./soul/index.mjs";
// 5 พ.ย. 2026 (คำสั่งพี่ง้วง "ฝากสอน sonnet ด้วย opus สไตล์ก่อน"): off (ไม่มีแถว: พรอมต์เดิมทุกไบต์) · on (การ์ดสไตล์ในบล็อกคงที่)
import { REPLY_STYLE_CARD_KEY, REPLY_STYLE_CARD_MODES, replyStyleCardMode } from "./replyStyle/styleCard.mjs";
// 7 พ.ย. 2026 (พี่ง้วง "อยากให้ 6.1 ใกล้ Opus ถึง 9–9.5"): off (ไม่มีแถว: พรอมต์เดิมทุกไบต์) · on (คำตอบจริงของครูที่คล้ายเทิร์นนี้จากคลังใน instance)
import { FOLLOWUP_TEACHER_KEY, FOLLOWUP_TEACHER_MODES, followupTeacherMode } from "./replyStyle/followupTeacher.mjs";
import { FOLLOWUP_STYLE_BANK_KEY, followupStyleBankMode, REPLY_STYLE_BANK_KEY, REPLY_STYLE_BANK_MODES, replyStyleBankMode } from "./replyStyle/styleBank.mjs";
// 7 พ.ย. 2026 (งานแคช): off (ไม่มีแถว: พรอมต์เดิมทุกไบต์) | on (ข้อมูลธุรกิจอยู่บล็อกแคชของตัวเอง)
import { REPLY_CACHE_LAYER_KEY, REPLY_CACHE_LAYER_MODES, replyCacheLayerMode } from "./replyEngineV3/mode.mjs";

export const BEHAVIOR_SWITCHES = Object.freeze([
  { key: COACHING_BRAKE_MODE_KEY, values: Object.freeze(["on", "off"]), read: coachingBrakeMode },
  { key: REPLY_CLOSING_QUESTION_KEY, values: Object.freeze(["on", "off"]), read: replyClosingQuestionMode },
  { key: PAUSE_RESUME_SETTING, values: Object.freeze(["on", "facebook", "off"]), read: pauseResumeMode },
  { key: PAYMENT_GENTLE_NUDGE_KEY, values: Object.freeze(["on", "off"]), read: paymentGentleNudgeMode },
  { key: SCHEDULE_CHECK_FOLLOWUP_KEY, values: Object.freeze(["on", "off"]), read: scheduleCheckFollowupMode },
  { key: OWNER_CHAT_MODE_KEY, values: Object.freeze(["on", "off"]), read: ownerChatMode },
  { key: OWNER_CHAT_MODEL_KEY, values: OWNER_CHAT_MODEL_MODES, read: ownerChatModelMode },
  { key: LESSON_DIGEST_MODE_KEY, values: LESSON_DIGEST_MODES, read: lessonDigestMode },
  { key: TAG_FRAMEWORK_MODE_KEY, values: TAG_FRAMEWORK_MODES, read: tagFrameworkMode, needsTagFramework: true },
  { key: IDENTITY_LINK_MODE_KEY, values: IDENTITY_LINK_MODES, read: identityLinkMode },
  { key: STEP_MESSAGES_MODE_KEY, values: Object.freeze(["on", "off"]), read: stepMessagesMode },
  { key: HOT_FOLLOWUP_PUSH_MODE_KEY, values: Object.freeze(["on", "off"]), read: hotFollowupPushMode },
  { key: NATURAL_VOICE_MODE_KEY, values: NATURAL_VOICE_MODES, read: naturalVoiceMode },
  { key: QUALIFY_SWEEP_MODE_KEY, values: QUALIFY_SWEEP_MODES, read: qualifySweepMode },
  { key: OFFTOPIC_CLOSE_MODE_KEY, values: OFFTOPIC_CLOSE_MODES, read: offtopicCloseMode },
  { key: OWNER_REVIEW_MODE_KEY, values: OWNER_REVIEW_MODES, read: (db) => ownerReviewMode(db) ?? "off" },
  { key: OWNER_REVIEW_SCAN_SCOPE_KEY, values: OWNER_REVIEW_SCAN_SCOPES, read: ownerReviewScanScope },
  // 3 พ.ย. 2026: Luna ตรวจคำตอบของทีมหลังรอบ 20:00 (teamReplyReview.mjs) — ไม่มีแถว = on · ห้องตรวจปิด = หยุดด้วย
  { key: TEAM_REVIEW_MODE_KEY, values: Object.freeze(["on", "off"]), read: teamReviewMode },
  { key: REPLY_ENGINE_KEY, values: REPLY_ENGINE_MODES, read: replyEngineMode },
  { key: AD_REFERRAL_CAPTURE_KEY, values: AD_REFERRAL_CAPTURE_MODES, read: adReferralCaptureMode },
  { key: ORDER_MODE_KEY, values: ORDER_MODES, read: orderMode },
  { key: META_CAPI_MODE_KEY, values: META_CAPI_MODES, read: metaCapiMode },
  { key: REVIEW_CATALOG_IN_PROMPT_KEY, values: REVIEW_CATALOG_IN_PROMPT_MODES, read: reviewCatalogInPromptMode },
  { key: REPLY_STYLE_CARD_KEY, values: REPLY_STYLE_CARD_MODES, read: replyStyleCardMode },
  { key: REPLY_STYLE_BANK_KEY, values: REPLY_STYLE_BANK_MODES, read: replyStyleBankMode },
  { key: FOLLOWUP_STYLE_BANK_KEY, values: REPLY_STYLE_BANK_MODES, read: followupStyleBankMode },
  { key: FOLLOWUP_TEACHER_KEY, values: FOLLOWUP_TEACHER_MODES, read: followupTeacherMode },
  { key: REPLY_CACHE_LAYER_KEY, values: REPLY_CACHE_LAYER_MODES, read: replyCacheLayerMode },
  { key: SOUL_CANDIDATE_MODE_KEY, values: SOUL_CANDIDATE_MODES, read: soulCandidateMode, needsSoulCandidate: true,
    onSet: onSoulCandidateModeChange },
]);

// White-label (8 ต.ค. 2026): สวิตช์ของฟีเจอร์ที่เขียนมาเฉพาะธุรกิจคอร์สของพี่ง้วง (พรอมต์/ข้อความผูกชื่อลูกแพร)
// โปรไฟล์ generic ไม่แสดงและไม่รับการเปลี่ยน — ตัวอ่านของแต่ละโมดูลก็คืนค่าปิดเองอีกชั้น
export const GENERIC_LOCKED_SWITCHES = Object.freeze(new Set([
  COACHING_BRAKE_MODE_KEY, SCHEDULE_CHECK_FOLLOWUP_KEY, OWNER_CHAT_MODE_KEY, OWNER_CHAT_MODEL_KEY,
  LESSON_DIGEST_MODE_KEY, IDENTITY_LINK_MODE_KEY, NATURAL_VOICE_MODE_KEY, QUALIFY_SWEEP_MODE_KEY,
  REPLY_ENGINE_KEY, AD_REFERRAL_CAPTURE_KEY, META_CAPI_MODE_KEY,
]));

const DENY_READ = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
const DENY_EDIT = "เฉพาะ Super Admin เท่านั้นที่เปลี่ยนพฤติกรรมของลูกแพรได้";
const DENY_GENERIC = "สวิตช์นี้ไม่มีในแพ็กเกจของร้านนี้";

// สวิตช์ที่ใช้ได้บนเครื่องนี้ — สวิตช์กรอบป้ายไม่มีความหมายถ้าไม่มีไฟล์กรอบ (เช่น instance อื่น)
function availableSwitches({ tagFramework = null } = {}) {
  const generic = isGenericProfile(activeBrand());
  return BEHAVIOR_SWITCHES.filter((item) => (!item.needsTagFramework || Boolean(tagFramework))
    && (!item.needsSoulCandidate || Boolean(candidateSoul()))
    && !(generic && GENERIC_LOCKED_SWITCHES.has(item.key)));
}

export function behaviorSwitchSnapshot(db, { tagFramework = null } = {}) {
  return availableSwitches({ tagFramework }).map(({ key, values, read }) => ({ key, values: [...values], value: read(db) }));
}

export function createBehaviorSwitchRoutes({ db, tagFramework = null } = {}) {
  const switches = availableSwitches({ tagFramework });
  const snapshot = () => behaviorSwitchSnapshot(db, { tagFramework });
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "settings" || route[1] !== "behavior-switches" || route.length !== 2) return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    if (!hasOperatorCapability(operator, "settings.manage")) {
      json(res, 403, { ok: false, error: DENY_READ });
      return true;
    }
    const canEdit = String(operator?.role || "") === "owner";
    if (req.method === "GET") {
      json(res, 200, { ok: true, canEdit, switches: snapshot() });
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!canEdit) {
      json(res, 403, { ok: false, error: brandText(DENY_EDIT) });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    const body = await readJson(req);
    if (isGenericProfile(activeBrand()) && GENERIC_LOCKED_SWITCHES.has(body?.key)) {
      json(res, 403, { ok: false, error: DENY_GENERIC });
      return true;
    }
    const target = switches.find((item) => item.key === body?.key);
    if (!target || typeof body?.value !== "string" || !target.values.includes(body.value)) {
      json(res, 400, { ok: false, error: "ต้องส่ง key และ value ที่รู้จัก" });
      return true;
    }
    const before = target.read(db);
    db.setSetting(target.key, body.value);
    target.onSet?.(db, before, body.value);
    db.addAudit({ operator: username, action: "behavior_switch", target: target.key, detail: `${before} → ${body.value}` });
    json(res, 200, { ok: true, canEdit, switches: snapshot() });
    return true;
  }
  return { handle };
}
