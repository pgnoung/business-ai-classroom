import { orderMode as orderModeOf } from "./orderMode.mjs";
import { activeBrand, agentNamePattern, brandText, isGenericProfile } from "./brand.mjs";
import { reviewJevForWorkflow } from "./jevWorkflowReview.mjs";
// pipeline.mjs — เดินข้อความลูกค้า 1 burst ผ่านทุกด่านตามลำดับแผนแม่บท §4:
// burst -> control gate (อ่านครั้ง 1) -> safety router -> hermes/template ->
// compliance guard -> humanizer -> control gate (อ่านครั้ง 2) -> LINE ออก
import { createHash } from "node:crypto";
import { withCampaignReceiptPolicy } from "./campaignReceiptPolicy.mjs";
import { truncateCodePoints } from "./unicodeText.mjs";
import { isPaymentActionText, routeMessage, templateAfterEscalation, isDocumentNameQuestion, QUIET_STOP_REASON, normalizeThai } from "./safetyRouter.mjs";
import { extractImageMarkers } from "./imageCatalog.mjs";
import { isMoneyImageKind } from "./imageClassifier.mjs";
import { createKeyedQueue } from "./locks.mjs";
import { classifyFollowupSuppression } from "./followupSuppression.mjs";
import { createJevShadow } from "./jevShadow.mjs";
import { createJevDecisionReview, shouldStopJev, shouldNotifyJev } from "./jevDecisionReview.mjs";
import { PRICE_BEFORE_BANK_RULE, BANK_INFO_RULE, SYSTEM_PAYMENT_RULE, checkPriceBeforeBank, isBankInfoConversation, paymentInstructionsIndex } from "./salesDecisionGuard.mjs";
import { DOC_TYPE_LABEL, DOC_TYPE_QUESTION, PAYMENT_STEP_AUDIT, classifyDocTypeAnswer, PAYMENT_STEP_PIN_PREFIX, PAYMENT_STEP_SETTING, extractPaymentKit, planPaymentStep, readPin, stripPaymentInstructions, withRegistrationAsk } from "./paymentStep.mjs";
import { pauseSecondsForBubble } from "./humanizer.mjs";
import { classifyServiceIntent, nextServiceState, serviceBoundaryReply, serviceBoundaryState, SERVICE_SCOPE_RULE } from "./serviceBoundary.mjs";
import { coachingBrakeDirective } from "./coachingBrake.mjs";
import { replyClosingQuestionEnabled } from "./replyClosingQuestion.mjs";
import { naturalVoiceArgs, naturalVoiceMode } from "./writerVoice.mjs";
import { replyStyleCardMode } from "./replyStyle/styleCard.mjs";
import { loadStyleBank, replyStyleBankMode } from "./replyStyle/styleBank.mjs";
import { nextScheduleCheckMarker, scheduleCheckFollowupEnabled, scheduleCheckReplyDirective } from "./scheduleCheck.mjs";
import { currentUpcomingRounds } from "./roundsSource.mjs";
import { extractKnownName, nameLooksThirdParty } from "./customerName.mjs";
import { customerKey } from "./channels.mjs";
import { scheduleState } from "./scheduleGate.mjs";
import { catalogOutOfPrompt, composeBrandPackForChannel, composeBrandPackOnly, composeKnowledgeForChannel } from "./knowledgePack.mjs";
import { asksAboutPrice, asksForExtraDiscount, buildConversationStyleRules, buildWarmthRules, historyBeforeCurrentInbound, liveClassInterest, recentAskedQuestions } from "./conversationStyle.mjs";
import { buildClassRoutingRules, buildSalesMotionRules, hasRecentFatigue, resolveClassRouting } from "./salesMotion.mjs";
import { approvedClassAmounts, decidePriceDisclosure, knowsSomethingAboutCustomer, outboundCarriesClassPrice, shouldRecordOnlinePivotDeferral, shouldRecordPriceDeferral } from "./priceDisclosure.mjs";
import { priceRule } from "./priceDirectives.mjs";
import { applyOwnerLessons, ownerLessonMetadata, recordOwnerLessonUse } from "./ownerLessons.mjs";
import { collapseInboundBurst, collapsePresetBurst, presetButtonFact, presetButtonPhrases, isPresetButtonTap } from "./presetButtons.mjs";
import { detectHandoffHint, splitThaiSentences } from "./handoffIntent.mjs";
import { promiseNeedsPush } from "./promisePushGate.mjs";
import { handoffReasonsSince, personReasonRaisedAt } from "./needsPersonReason.mjs";
import { suggestImageKey, imageOfferRule, namedServicePoster, explicitPosterAsk, explicitPosterNegated, withoutNonImageWords, ATMOSPHERE_IMAGES } from "./imageSuggestion.mjs";
import { dropGenericAddress, enforceCustomerAddress, genericAddressRule, nameRestRule, planCustomerAddress } from "./customerAddress.mjs";
import { resolveContinuation } from "./continuationResolver.mjs";
import { buildReplyFocusRules, isOpeningShortAnswer, learningGoal } from "./conversationFocus.mjs";
import { adWelcomeQuestionFor } from "./adWelcomeQuestion.mjs";
import { createProjectPromiseWatch, enforceHandoffClosing, predictProjectHandoff, projectHandoffClosingRule } from "./handoffClosing.mjs";
import { focusReviewKnowledge, reviewUrlKey, splitReviewKnowledge } from "./reviewSelection.mjs";
import { isShowcaseUrlKey } from "./showcaseCases.mjs";
import { arrivalNoteFor } from "./showcaseArrival.mjs";
import { chatStyleRule, readChatStyle } from "./chatStyle.mjs";
import { CONFIDENCE_TURN } from "./reviewJourney.mjs";
import { detectDeliveredCourseOutlines, planCourseOutline } from "./courseOutlinePlan.mjs";
import { replyLeadContext } from "./replyLeadContext.mjs";
import { assetUrls, hasUnapprovedAssetUrl } from "./approvedAssetUrls.mjs";
import { selectRelevantBrandPack, IMAGE_REQUEST } from "./brainPackSelector.mjs";
// P2: ทางอ่านสมองที่มีเวอร์ชัน — ตัวประกอบบล็อกความรู้/บรรทัดที่นั่งตัวเดียวกับคอมไพเลอร์
// (ห้ามเขียนตัวประกอบที่สองแล้วหวังว่าจะตรงกัน — เหตุผลเต็มอยู่ใน brain/compile.mjs)
import { knowledgeBlockFor, upcomingRoundsFor } from "./brain/compile.mjs";
import { selectBrainKnowledgeForTurn } from "./brain/retrieval.mjs";
import { maybeCaptureDraftOrder } from "./orders.mjs";
import { stripViolatingSentences } from "./complianceGuard.mjs";
import { detectUpwardPriceRevision } from "./priceConsistency.mjs";
import { formatSystemCorrectionSource } from "./correctionCapture.mjs";
import { composeTagRules, PRODUCT_RULES_KEY } from "./tags.mjs";
import { mergeFrameworkTags } from "./tagFramework.mjs";
import { activeTagFramework } from "./tagFrameworkMode.mjs";
import { applyHashtagTagRule } from "./hashtagTagRules.mjs";
import { assessReplyDelivery, degradeToDeliverable } from "./replyDeliveryPolicy.mjs";
import { detectDirectOpportunityType, extractContactPhoneQuote, normalizeSalesSignals, PROJECT_OPPORTUNITY_TYPES, renderHandoffPing, renderSalesPolicyReplySummary, renderSalesState, staleOnSitePin } from "./salesPolicy.mjs";
import { createLifecycle } from "./lifecycle.mjs";
import { announcedRoundsLines, seatRuleLines, todayRoundsLine, upcomingRounds } from "./classRounds.mjs";
import {
  buildScorerSystem, parseScorePayload, scorerSystemBlocks,
} from "./scoring.mjs";
import { buildScoreEvidence, normalizeScoreEvidence } from "./scoreEvidence.mjs";
import { buildReplyContextEnvelope, hasVerifiedPriorAssessment, latestCommittedReplyMeta, legacyOfferBootstrapAllowed } from "./replyContextEnvelope.mjs";
// 2026-10-04: เครื่องตอบแชท v3 (สวิตช์ reply_engine · ไม่มีแถว = เครื่องเดิมทุกไบต์) — โมดูลพวกนี้ไม่ import ไฟล์นี้กลับ
import { replyCacheLayerMode, replyEngineMode } from "./replyEngineV3/mode.mjs";
import { chooseLane } from "./replyEngineV3/lanes.mjs";
import { silentAckTurn } from "./replyEngineV3/stage.mjs";
import { buildTurnFacts, knowledgeEntriesFor, V3_FACT_HISTORY_TURNS } from "./replyEngineV3/turnFacts.mjs";
import { createReplyEngineV3, withReplyEngineMeta, committedReplyMeta } from "./replyEngineV3/engine.mjs";
// 12 ต.ค. 2026 (คำสั่งพี่ง้วง "คุยไปเรื่อย ... ให้คุณตีจบได้เลย"): จังหวะตีจบของ v3 — ตัวตัดสินฉีดเข้ามาเป็น offtopicCloser (server.mjs)
import { OFFTOPIC_CLOSE_REASON, OFFTOPIC_FOLLOWUP_STOP, withOfftopicClose } from "./replyEngineV3/offtopicTurn.mjs";

// fallback เมื่อ Hermes ล่ม/timeout — ต้องไม่มีตัวเลข ไม่มีคำต้องห้าม (ผ่าน guard ได้เสมอ)
//
// v1.3.3: เดิมเขียนว่า "ระบบตอบอัตโนมัติขัดข้องชั่วคราว" ซึ่งประกาศให้ลูกค้ารู้ว่า
// เขากำลังคุยกับระบบที่พัง — เจ้าของเห็นแล้วถามว่า "ทำไมบอก error ตลอดเวลา"
// แอดมินคนจริงไม่เคยพูดแบบนี้ เขาพูดว่าขอเวลาเช็คแป๊บนึง ซึ่งจริงด้วยและไม่ทำลาย
// ความเชื่อมั่น ทีมงานยังรู้เหตุจริงจาก log/คอนโซลเหมือนเดิม
// เทิร์นที่ "ภาพช่วยให้ลูกค้าเห็นภาพ" — อิงบทสนทนาจริง 2026-08-13 ที่ลูกค้าต้องขอรูปเอง
// ทั้งที่ก่อนหน้านั้นมีสามจังหวะที่ควรมีภาพประกอบ (แนะนำคลาส / รายละเอียดการสอน / แจ้งราคา)
// v1.4.1 (เคสจริง 2026-08-14): "แล้วให้ไปสอนที่บริษัท มีไหม" / "มีแบบ สอนสด อย่างเดียวเหรอ"
// ไม่ผ่าน gate เดิมเลย ทำให้เทิร์นถามบริการตรง ๆ ไม่มีทางได้รูป — เพิ่มคำถามเชิงรูปแบบ/สถานที่
export const IMAGE_WORTHY_TURN = /(?:สอนอะไร|สอนอะไรบ้าง|รายละเอียด|เนื้อหา|หลักสูตร|เรียนอะไร|เหมาะกับ|คลาสไหน|คอร์สไหน|ราคา|กี่บาท|เท่าไหร่|แพงไหม|โปรโมชั่น|ส่วนลด|สนใจ|สอนสด|เรียนสด|สอนที่|เรียนที่|อบรม|มีแบบ|รูปแบบ|in\s*-?\s*house|onsite|ออนไซต์|บรรยากาศ|ห้องเรียน|กี่คน|กลุ่มเล็ก|ใกล้ชิด|สอนยังไง|เรียนยังไง|ชำระ|จ่ายเงิน|(?:เลขที่|เลข|ขอ|แจ้ง)บัญชี|บัญชีธนาคาร|โอน(?:เข้า|ยังไง|ไป))/iu;
// v1.4.5: เทิร์นที่ลูกค้าถามรายละเอียดคลาสตรง ๆ — โปสเตอร์คลาสเป็นภาคบังคับ
const COURSE_DETAIL_TURN = /(?:สอนอะไร|สอนไรบ้าง|รายละเอียด|เนื้อหา|หลักสูตร|เรียนอะไร|คลาสไหน|คอร์สไหน|เหมาะกับ|ต่างกัน)/iu;
// ลูกค้าขอรูปเองจริง ๆ ในข้อความนี้ (ปลดตัวกันรูปซ้ำ + ถ้อยคำ "ลูกค้าขอรูปเอง") — รีวิว 2026-10-03 รอบ 3–4:
// "ขอภาพรวม" "เน้นคุณภาพ" ไม่ใช่ขอรูป และ "ไม่ต้องส่งรูป/ขอข้อความอย่างเดียว" คือปฏิเสธรูป (เดิมนับเป็นขอรูปทั้งหมด)
// IMAGE_REQUEST ตัวเดิมยังใช้เลือกการ์ดความรู้ตามเดิม (ไม่แตะพรอมต์ส่วนความรู้)
export function customerAsksForImage(text) {
  return IMAGE_REQUEST.test(withoutNonImageWords(text)) && !explicitPosterNegated(text);
}
const COURSE_POSTER_KEYS = new Set(["ai-agent-for-business", "ai-agent-workflow-automation"]);

// v1.4.16 (ชุดทดสอบสมองจริงจับได้ 2026-08-18): safety-rules.json ของแต่ละ instance ตั้งชื่อ
// reason เองได้ (ลูกแพรใช้ "payment_requires_human_review") แต่โค้ดเดิมเทียบสตริงเป๊ะกับ
// "payment_review" เท่านั้น → sticky AI-off ไม่เคยทำงานตอนลูกค้า "แจ้งโอนเอง" บอทจึงคุยต่อ
// ได้เรื่อย ๆ ทั้งที่จังหวะเงินต้องเป็นคนจริง 100% — เทียบด้วยความหมาย ไม่ใช่ชื่อเป๊ะ
export function isMoneyLineReason(reason = "") {
  return /payment|slip|installment|สลิป|ชำระ|โอน|ผ่อน|refund|image_review/iu.test(String(reason));
}

// ---- เคสจริง 2026-09-05 (พี่ง้วงแจ้งเอง): เส้นเงินปัดลูกค้าที่ยังไม่ได้จ่าย ----
//
// เดิมโค้ดถือว่า deal_status อะไรก็ได้ที่ "ไม่ใช่ new" = จ่ายเงินกันแล้ว ทั้งที่ใต้แกน sales
// มีสถานะก่อนเงินอยู่หลายขั้น (collecting_info / class_recommended / details_sent /
// price_sent / awaiting_round_choice / awaiting_team_decision / quote_sent)
// ห้องที่แค่ "ส่งราคาให้ดู" จึงถูกอ่านว่าจ่ายแล้ว แล้วคำถามก่อนซื้อเรื่องใบเสร็จ/ใบกำกับ
// ก็โดนแม่แบบ "รับเรื่องเอกสารการชำระเงินแล้วค่ะ ทีมงานคนจริงจะตรวจสอบ…" ปัดทิ้ง (เจอจริง 2 ห้องวันนี้)
//
// นับเฉพาะสถานะที่แปลว่า "เงินขยับจริง หรือเลขบัญชีออกไปแล้ว" เท่านั้น:
//   awaiting_payment = ลูกค้าเลือกรอบแล้ว รอโอน (เลขบัญชีถึงมือลูกค้าแล้ว)
//   paid_confirmed / prep_sent = ใต้แกน enrolled คือจ่ายจบแล้ว
// quote_sent จงใจไม่นับ: ใบเสนอราคาคือเอกสารก่อนซื้อ ยังไม่มีเงินและยังไม่มีเลขบัญชี
// not_ready / waiting_next_round เป็นสถานะพักของคน ไม่ใช่เรื่องเงิน
// สัญญาณเงินตัวจริง (money_seen_at / bank_sent / money_line / handoff_summary) ยังอ่านเหมือนเดิมทุกตัว
export const PAYMENT_STARTED_DEAL_STATUSES = Object.freeze(["awaiting_payment", "paid_confirmed", "prep_sent"]);

/**
 * ตัดสินจากแถวลูกค้าหนึ่งแถวว่า "เคยมีเงินกับเราหรือยัง" — ฟังก์ชันบริสุทธิ์เพื่อให้เทสต์
 * ไล่ได้ครบทุกสถานะจริงในตาราง ไม่ใช่แค่สองสามตัวที่นึกออก (เคสจริง 2026-09-05)
 * ไม่มีแถว = ถือว่าจ่ายแล้ว (fail-closed ทางเงินเหมือนเดิม)
 */
export function paymentStartedFromRow(row) {
  if (!row) return true;
  // ธงถาวร (แหล่งความจริงหลัก) — ไม่ถูก buffer ตัดทิ้งและไม่ถูกทับเหมือน ai_off_reason
  if (Number(row.money_seen_at) > 0) return true;
  if (PAYMENT_STARTED_DEAL_STATUSES.includes(String(row.deal_status || ""))) return true;
  // ชื่อเหตุปิด AI ตั้งเองได้ต่อ instance — เทียบด้วยความหมาย ไม่ใช่สตริงเป๊ะ (v1.4.16)
  if (isMoneyLineReason(String(row.ai_off_reason || ""))) return true;
  if (String(row.ai_off_reason || "") === "bank_sent") return true;
  return handoffSummaryTouchesMoney(row.handoff_summary);
}

// ---- ตรวจปรปักษ์ 2026-09-05: handoff_summary วางยาห้องตัวเองผ่านคำว่า "สลิป" ----
//
// เดิมอ่าน handoff_summary ทั้งก้อนด้วย isMoneyLineReason ซึ่งจับคำว่า image_review และ "สลิป"
// แต่บรรทัดที่เส้นรูปเขียนเองคือ "[ts] image_review: ลูกค้าส่งรูป (อาจเป็นสลิป/เอกสาร) — รอคนตรวจ"
// ผลคือรูปใบแรกที่จำแนกไม่ได้ (ซึ่ง F4 ตั้งใจ "ไม่" ปักธงเงิน) กลับทำให้ห้องนั้นอ่านเป็นห้องเงิน
// ทันทีที่มีข้อความถัดไป — รูปใบที่สองในชุดเดียวกันจึงโดนปักธงถาวร และหลังแอดมินกดเปิด AI คืน
// (ซึ่งไม่ล้าง handoff_summary) คำถามใบกำกับก่อนซื้อก็ยังโดนแม่แบบเอกสารการชำระเงินอยู่ดี
//
// setNeedsHuman ต่อท้ายเป็นบรรทัด "[ISO] <reason>: <สรุป>" เสมอ (db.mjs) จึงอ่านที่ token
// หัวบรรทัดเท่านั้น ไม่ใช่คำในสรุปของคน — เหตุเงินจริง (payment_review ฯลฯ) ปักธง money_seen_at
// ตั้งแต่ตอน escalate อยู่แล้ว ไม่มีอะไรหายไปจากการเลิกอ่านคำในสรุป
const HANDOFF_REASON_LINE = /^\[[^\]]{0,40}\]\s*([a-z][a-z0-9_]*)/iu;
// รูปที่ยังไม่รู้ว่าเป็นอะไร = ยังไม่ใช่หลักฐานว่ามีเงิน (นี่คือทั้งหมดของ F4)
const NOT_MONEY_HANDOFF_REASONS = new Set(["image_review", "file_review"]);
// สรุปของเส้นรูปเมื่อบรรทัดถูกตัดหัวทิ้งจนไม่เหลือ token — คำว่า "อาจเป็นสลิป" คือลายเซ็นของมัน
const IMAGE_REVIEW_SUMMARY_FRAGMENT = /อาจเป็นสลิป/u;
export function handoffSummaryTouchesMoney(summary) {
  const text = String(summary || "");
  if (!text) return false;
  for (const line of text.split("\n")) {
    const matched = HANDOFF_REASON_LINE.exec(line);
    if (matched) {
      const reason = matched[1].toLowerCase();
      if (NOT_MONEY_HANDOFF_REASONS.has(reason)) continue;
      if (isMoneyLineReason(reason) || reason === "bank_sent" || reason === "money_line") return true;
      continue;
    }
    // บรรทัดรูปแบบเก่า/ถูก buffer 2000 ตัวอักษรตัดหัวทิ้ง — ถอยไปเทียบทั้งบรรทัดแบบเดิม
    // (ยกเว้นเศษสรุปของเส้นรูป ซึ่งเป็นต้นเหตุของบั๊กนี้พอดี)
    if (IMAGE_REVIEW_SUMMARY_FRAGMENT.test(line)) continue;
    if (isMoneyLineReason(line) || /bank_sent|money_line/u.test(line)) return true;
  }
  return false;
}

export const HERMES_DOWN_TEMPLATE =
  "ขอเวลาลูกแพรตรวจข้อมูลให้สักครู่นะคะ เดี๋ยวรีบกลับมาตอบให้ค่ะ";
// v1.4.2: ครั้งที่สองติดกันต้องไม่ใช่ประโยคเดิม — ขอโทษตรง ๆ
// F11 (ตรวจย้อนหลัง ก.ย. 2026 — D884, D886, D981): ถ้อยคำเดิม "ทีมงานกำลังเข้ามาดูแลแชทนี้" รับปากคน
// ที่ไม่ได้มา (สมองล่มปลุกแค่ ops:hermes ไม่มีใครถูกส่งเข้าห้องนี้) — บอกความจริงว่าตอบช้า และให้ทางลัด
// หาคนที่ใช้ได้จริง: "ขอคุยกับทีมงาน" เข้าเส้น human_handoff แบบ deterministic ไม่ต้องใช้สมองเลย (มีเทสต์ผูกไว้)
export const HERMES_DOWN_RETRY_TEMPLATE =
  "ขออภัยที่ให้รอนะคะ 🙏 ตอนนี้ลูกแพรตอบได้ช้ากว่าปกติ ขอเวลาสักครู่นะคะ ถ้าเรื่องด่วน พิมพ์ว่า \"ขอคุยกับทีมงาน\" ได้เลยค่ะ";
// ถ้อยคำครั้งสองรุ่นก่อน — ห้องที่ได้รับไปแล้วช่วงเปลี่ยนรุ่นยังต้องนับเป็น "เพิ่งขอเวลาไป" (กันนกแก้ว)
const LEGACY_HERMES_DOWN_RETRY_TEXTS = ["ขออภัยที่ให้รอนะคะ 🙏 ทีมงานกำลังเข้ามาดูแลแชทนี้ต่อให้เร็วที่สุดค่ะ"];
// F11: ธงรอคนที่ "สมองล่มตั้งเอง" (ห้องไม่ได้รอคนด้วยเหตุอื่นอยู่ก่อน) — ค่า = เวลาของบรรทัด hermes_down แรก
// สมองกลับมาตอบได้แล้วปลดให้เอง ไม่งั้นคิวคอนโซลค้างห้องที่บอทคุยปกติแล้วเป็นวัน ("0" = ปลดแล้ว)
const HERMES_DOWN_FLAG_PREFIX = "hermes_down_flag:";

// fallback เมื่อ compliance guard บล็อก draft — draft ห้ามหลุดถึงลูกค้า
// แต่ลูกค้าต้องไม่เจอความเงียบ (บทเรียน "ระบบต้องไม่เงียบ" + Fern failure policy)
// v1.2.5 (ตรวจอิสระ 2026-08-13): brain pack ขึ้นต้น system prompt ด้วยบรรทัด
// "UNAVAILABLE FACTS ... say only that this item requires team confirmation" ซึ่งเป็น
// คำสั่งตรงข้ามกับโหมดเทรนด้วยรายการหัวข้อชุดเดียวกันเป๊ะ (ราคา/รอบเรียน/ที่นั่ง/รีวิว)
// นี่คือเหตุผลที่โมเดลตอบ "ต้องให้ทีมงานยืนยัน" ซ้ำ ๆ ทั้งที่ persona สั่งห้าม —
// คำสั่งที่มาก่อนและอยู่ในชั้น "ข้อเท็จจริง" ชนะคำสั่งที่อยู่ท้าย prompt เสมอ
// brain pack (อนุมัติ 2026-07-17) ขึ้นต้น prompt ด้วยบรรทัด UNAVAILABLE FACTS ที่ประกาศว่า
// ราคา/โปรโมชั่น/วันเวลา/สถานที่/จำนวนที่นั่ง "ไม่มีข้อมูล ให้บอกว่าต้องรอทีมงานยืนยัน"
// ตอนเขียนบรรทัดนั้นเป็นความจริง — เดือนกรกฎาคมยังไม่มีตารางราคาและยังไม่มีคู่มือ
//
// วันนี้ไม่จริงแล้ว: approved_prices มี 21 รายการ และคลังความรู้มีคู่มือของชมพู่ครบ
// ทดสอบออฟไลน์กับสมองจริงยืนยันผลเสียทั้งสองทาง
//   - โหมดเทรนปิด -> "ราคาต้องให้ทีมงานยืนยันค่ะ" ทั้งที่ราคาอยู่ใน prompt ตรงหน้า
//   - โหมดเทรนเปิด -> แต่งราคาเอง (บอก "ปกติ 12,900 Early Bird 9,900" ซึ่งผิดทั้งคู่)
//     เพราะคำสั่งกลายเป็น "ยกตัวอย่างสมมติ" แทนที่จะเป็น "อ่านจากแหล่งที่อนุมัติ"
//
// จึงเขียนทับบรรทัดนั้นตอนรันไทม์ให้ตรงกับความจริงปัจจุบัน แทนการรื้อแพ็กที่ผ่านการอนุมัติ
// ตรวจปรปักษ์ 2026-08-14: เขียนทับแค่ประโยค "If asked..." ไม่พอ — ประโยคแรกของย่อหน้า
// ("UNAVAILABLE FACTS — do not infer or invent: exact price/promotion, date/schedule...")
// ยังค้างใน prompt ทุกใบ วางชนตรง ๆ กับ knowledge ที่มีราคาครบ จึงต้องเขียนทับทั้งย่อหน้า
// จบก่อน "Never promise a callback" ซึ่งเป็นกติกาที่ยังจริงเสมอ ต้องคงไว้
const UNAVAILABLE_FACTS_SENTENCE = /(?:UNAVAILABLE FACTS[^\n]*?)?If asked, say only that this item requires team confirmation\./u;

export function applyKnownFactsOverride(brandPackText, { hasApprovedFacts = false, trainingMockMode = false, logger = null } = {}) {
  const value = String(brandPackText || "");
  if (!value) return value;
  if (hasApprovedFacts) {
    const replaced = value.replace(
      UNAVAILABLE_FACTS_SENTENCE,
      brandText("KNOWN FACTS POLICY: price, promotion, schedule, location, seat and student-review data are AVAILABLE whenever the approved price table "
      + "or the team knowledge section below contains them — answer from that source exactly as written, never round, recompute, "
      + "merge or guess a number, and never attach a price to a different product than the source states. Say an item requires "
      + "team confirmation only when it is genuinely absent from both sources."
      + (trainingMockMode
        ? " During internal training only, an item absent from both sources may be answered with a clearly labelled illustrative "
          + "example plus the Thai label (ข้อมูลตัวอย่างระหว่างเทรนค่ะ รบกวนทีมงานพี่ง้วงเติมข้อมูลจริง: ...)."
        : "")),
    );
    // override ผูกกับถ้อยคำใน pack — pack รุ่นถัดไปเปลี่ยนคำ = no-op เงียบแล้วบั๊ก
    // "ราคาต้องรอทีมยืนยัน" กลับมาโดยไม่มีใครรู้ ต้องดังทันทีที่มันหยุดทำงาน
    if (replaced === value && /UNAVAILABLE FACTS/u.test(value)) {
      logger?.warn?.("applyKnownFactsOverride: พบ UNAVAILABLE FACTS แต่เขียนทับไม่สำเร็จ — pack เปลี่ยนถ้อยคำ? prompt กำลังประกาศว่าไม่มีข้อมูลทั้งที่ตารางราคามีของ");
    }
    return replaced;
  }
  if (!trainingMockMode) return value;
  return value.replace(
    UNAVAILABLE_FACTS_SENTENCE,
    brandText("If asked during internal training mode, answer with a reasonable illustrative example and append the Thai label (ข้อมูลตัวอย่างระหว่างเทรนค่ะ รบกวนทีมงานพี่ง้วงเติมข้อมูลจริง: ...). Never tell the customer to wait for team confirmation."),
  );
}

// ชื่อเดิมยังใช้ได้เพื่อไม่ให้เส้นอื่นพัง — ความหมายคือ "โหมดเทรนล้วน ไม่มีข้อมูลจริง"
export function applyTrainingMockMode(brandPackText, trainingMockMode = false) {
  return applyKnownFactsOverride(brandPackText, { hasApprovedFacts: false, trainingMockMode });
}

// ราคาที่กลับคำให้แพงขึ้นต้องไม่ถึงลูกค้าเลย — และห้ามพูดถึงตัวเลขใด ๆ ในข้อความนี้
export const PRICE_REVIEW_TEMPLATE =
  "ขอลูกแพรเช็คยอดกับทีมงานให้ชัดอีกครั้งก่อนนะคะ เดี๋ยวแจ้งกลับให้ถูกต้องค่ะ";

// ใช้เมื่อกู้บางประโยคได้ — บอกลูกค้าตรง ๆ ว่าตัวเลขบางส่วนขอยืนยันก่อน แล้วคุยต่อได้ทันที
export const PARTIAL_BLOCK_PREFIX = "ขอลูกแพรเช็คตัวเลขกับทีมงานอีกครั้งนะคะ";

// v1.4.39 (เจอตอนพิสูจน์ 2026-08-19): ลูกค้าต่อรอง "10000 พอดีมั้ย" -> ตัวกันราคาบล็อก
// ประโยคที่มีเลขนั้นถูกต้องแล้ว แต่คำนำหน้า "ขอเช็คตัวเลขกับทีมงาน" ทำให้ลูกค้าเข้าใจว่า
// อาจมีราคาที่ดีกว่ารออยู่ ซึ่งไม่มีวันมา = สร้างความหวังลม ๆ แล้วเงียบหาย
// จังหวะต่อรองต้องบอกความจริงว่าราคานี้ดีที่สุดแล้ว ส่วนจังหวะอื่นที่ตัวเลขต้องยืนยันจริง
// ("ขอเช็คตัวเลข") ยังใช้คำเดิม เพราะตรงนั้นมีของให้เช็คจริง
// v1.4.45: ห้ามใช้คำขั้นสุด ("ดีที่สุด") — อยู่ใน config/clinic-banned.json พอดี
// ทำให้ประโยคนี้ตกด่านตรวจของระบบเอง แล้ว pipeline คืนค่าเปล่า = ลูกค้าเจอความเงียบ
// ตอนกำลังต่อรองราคา ซึ่งเป็นจังหวะที่เขาอยากซื้อที่สุด (test/system-templates-self-guard)
export const PRICE_FINAL_PREFIX = "ราคาที่แจ้งไปเป็นราคาโปรโมชั่นที่ลดให้แล้วค่ะ ไม่มีส่วนลดเพิ่มนะคะ";

// v1.4.12: คีย์เวิร์ดกิจกรรม = ข้อความที่ "ขึ้นต้น" ด้วย # ติดตัวอักษร (เช่น #horeca)
// — จงใจไม่จับ # กลางประโยค ("สอน C# ไหม" ต้องได้คำตอบปกติ)
export const HASHTAG_KEYWORD = /^\s*#\S/u;
// v1.4.46 (คำสั่งพี่ง้วง 2026-08-28): กรีตติ้งใหม่ใช้ @ แทน # เพราะ "ลูกแพรตอบต่อได้เลย"
// # ยังเป็นของ LINE OA auto-response (ไม่รู้จัก = เงียบ ห้ามตอบซ้อน) ส่วน @ ไม่มีใคร
// ตอบแทน -> ไม่รู้จักต้องคุยต่อตามปกติ ห้ามเงียบ ไม่งั้นซ้ำรอย #inhouse/#FOUNDER ที่เงียบใส่ลูกค้าจริง
export const CAMPAIGN_KEYWORD = /^\s*[#@]\S/u;

// v1.4.12b: สวิตช์ # runtime — ค่าใน DB (จากหน้า Settings) ชนะ env เหมือนสวิตช์ follow-up
import { aiPausedDraftModeOn, aiPausedForReactiveCustomer, aiPausedNow } from "./aiPause.mjs";
import { scorerSuggestionsEnabled, withoutScorerSuggestions } from "./scorerSuggestions.mjs";
import {
  LEGACY_PENDING_RULE, OPERATOR_PAUSE_MS, legacyIdentityPending, stickyOffPlanFor, templateStickyAiOffReason,
} from "./aiPausePolicy.mjs";
import { linkLegacyByName } from "./legacyLink.mjs";
import { heldPausePartsForTurn } from "./pauseHeld.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
// 5 ต.ค. 2026 (คำสั่งพี่ง้วง): ห้องสีเหลือง "AI off (not qualify)" — ไปป์ไลน์รู้จักแค่สัญญากลาง + ตัวเปิดเขียวทันที
// (ห้าม import qualifySweep.mjs: ตัวกวาด import ไฟล์นี้อยู่แล้ว)
import { isNotQualifiedRow } from "./notQualified.mjs";
import { handleNotQualifiedTurn } from "./qualifyFastReclaim.mjs";
// 12 ต.ค. 2026: คำชวนทดลองเรียนฟรี (จำกัดสิทธิ์ต่อวันจริง) — ด่านเดียวกับเส้นทักตาม
import { trialDeliveredText, trialInviteGate } from "./trialInvites.mjs";
import { lastBurstImageKeys, stripTrialInvite } from "./replyEngineV3/socialProof.mjs";
import { scopedPersona, withRoomSoul } from "./soul/index.mjs";
import { NON_AI_SERVICE_TOPIC } from "./serviceTopic.mjs";

// v1.4.50 (คำสั่งพี่ง้วง 2026-08-25): greeting message ของ OA บอกลูกค้าให้พิมพ์
// #online / #onsite / #inhouse / #contact เพื่อเลือกเรื่องที่สนใจ — คำพวกนี้คือ
// "เจตนาซื้อ" ไม่ใช่คีย์เวิร์ดกิจกรรม ถ้าปล่อยให้กฎ # เดิมทำงาน ลูกแพรจะเงียบทั้งหมด
//
// ทิศทางความเสี่ยงต้องคงเดิม: # ที่ไม่อยู่ในรายการยังเงียบเหมือนเดิมทุกประการ
// (auto-response ของ LINE OA ตอบ) เปลี่ยนพฤติกรรมเฉพาะคำที่เจ้าของใส่ในรายการเอง
// ค่าเริ่มต้นคือรายการว่าง = ไม่มีอะไรเปลี่ยนจนกว่าเจ้าของจะเปิดใช้ในหน้า Settings
//
// วิธีทำงาน: แทนคีย์เวิร์ดด้วย "ประโยคเจตนา" แล้วปล่อยเข้าเส้นปกติ ไม่มี template ใหม่
// ข้อความส่วนที่เหลือของลูกค้าถูกต่อท้ายไว้ ("#inhouse 20 คนครับ" ไม่หายข้อมูล)
// seed ถูกเลือกให้ตรงตัวจับที่มีอยู่แล้ว (ยืนยันด้วย detectDirectOpportunityType และ
// routeMessage) โดยมีข้อบังคับสองข้อจากเจ้าของ:
//
// 1) คีย์เวิร์ดคลาสสอนสดใช้ #class ไม่ใช่ #onsite — และ seed ต้องไม่มีคำว่า "onsite"
//    เพราะ IN_HOUSE_INTENT (salesPolicy.mjs) จับ on[-\s]?site เป็น "งานอบรมองค์กร"
//    ลูกค้าที่แค่สนใจคลาสสอนสดจะถูกลากเข้าโหมดคัดกรองงานบริษัทผิดเส้น
//
// 2) #contact ต้อง "ไม่ปิด AI ทันที" (คำสั่งพี่ง้วง 2026-08-25: เผื่อลูกค้ามือลั่นกด)
//    seed จึงจงใจเลี่ยงทุกรูปประโยคใน HUMAN_HANDOFF_PATTERNS — ลูกแพรจะถามก่อนว่า
//    ต้องการให้ทีมช่วยเรื่องอะไร แล้วค่อยเข้าเส้นส่งต่อคนตามกติกาเดิมเมื่อลูกค้ายืนยัน
export const HASHTAG_BUSINESS_DEFAULTS = Object.freeze({
  "#online": "สนใจคลาสเรียนออนไลน์",
  "#class": "สนใจคลาสสอนสด",
  "#inhouse": "สนใจอบรม in-house ให้ทีมที่บริษัท",
  "#contact": "สนใจติดต่อทีมงานพี่ง้วง",
  // v1.4.46: ชุด @ ของกรีตติ้งใหม่ — ความหมายเดียวกับ # ทุกคำ
  "@online": "สนใจคลาสเรียนออนไลน์",
  "@class": "สนใจคลาสสอนสด",
  "@inhouse": "สนใจอบรม in-house ให้ทีมที่บริษัท",
  "@contact": "สนใจติดต่อทีมงานพี่ง้วง",
});

// White-label: โปรไฟล์ generic ไม่มีคลาส/อบรม — ค่าแนะนำเหลือแค่ "ติดต่อทีมงาน" ที่ใช้ได้ทุกร้าน
export const HASHTAG_BUSINESS_DEFAULTS_GENERIC = Object.freeze({
  "#contact": "สนใจติดต่อทีมงาน",
  "@contact": "สนใจติดต่อทีมงาน",
});
export function hashtagBusinessDefaults(brand = activeBrand()) {
  return isGenericProfile(brand) ? HASHTAG_BUSINESS_DEFAULTS_GENERIC : HASHTAG_BUSINESS_DEFAULTS;
}

const CAMPAIGN_DELIVERY_TEXT_MAX = 2000;

// รับเฉพาะรูปแบบที่ปลอดภัย: คีย์เดิมเป็น #/@ คำเดียว หรือ bare ASCII สำหรับรหัสกิจกรรม,
// seed เป็นข้อความสั้น และข้อความส่งตรงมีเพดานคงที่
export function normalizeHashtagBusinessKeywords(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = String(rawKey || "").trim().toLowerCase();
    // v1.4.52 (คำสั่งเจ้าของ 2026-08-28): รับสองรูปแบบ
    //   "#online": "สนใจคลาสเรียนออนไลน์"                        ← แบบเดิม ยังใช้ได้
    //   "#horeca": { "seed": "...", "note": "งานสัมมนา ..." }    ← เพิ่มโน้ตกิจกรรม
    //
    // ทำไมต้องแยกสองช่อง: seed ถูกใช้ "แทนข้อความของลูกค้า" ระบบจะอ่านเหมือนลูกค้าพิมพ์มาเอง
    // ถ้าเอาคำอธิบายงานไปใส่ช่องนั้น ลูกแพรจะเข้าใจว่าลูกค้าเป็นคนพูดประโยคนั้น แล้วตอบเพี้ยน
    // โน้ตจึงต้องเป็นคนละช่อง และถูกส่งเข้าไปในฐานะ "บริบทที่ทีมงานบอกไว้" ไม่ใช่คำของลูกค้า
    const isObject = rawValue && typeof rawValue === "object" && !Array.isArray(rawValue);
    const seed = String((isObject ? rawValue.seed : rawValue) || "").trim();
    const note = String((isObject ? rawValue.note : "") || "").trim();
    const deliveryText = String((isObject ? rawValue.deliveryText : "") || "").trim();
    const prefixed = /^[#@][^\s#@]{1,40}$/u.test(key);
    const bareAscii = /^[a-z0-9][a-z0-9_-]{0,40}$/u.test(key);
    if (!prefixed && !bareAscii) continue;
    if (!seed || seed.length > 200) continue;
    if (note.length > 600) continue;
    if (deliveryText.length > CAMPAIGN_DELIVERY_TEXT_MAX) continue;
    out[key] = note || deliveryText
      ? { seed, ...(note ? { note } : {}), ...(deliveryText ? { deliveryText } : {}) }
      : seed;
  }
  return out;
}

// brain (P2) = ผลของสมองรุ่นที่เทิร์นนี้ใช้ · ไม่ส่งมา = อ่าน settings เหมือนเดิมทุกไบต์
// keywordsConfigured=false แปลว่า "รุ่นนี้ไม่มีการ์ดคีย์เวิร์ด" ซึ่งเท่ากับ settings ว่าง
// จึงตกไปที่ env ต่อ — ไม่ใช่ "มีรายการว่าง" ที่จะทำให้ # ทุกตัวหลุดพฤติกรรมเดิม
export function hashtagBusinessKeywords({ db, config, brain = null }) {
  if (brain) {
    const { businessKeywords, keywordsConfigured } = brain.bundle.rules.hashtag;
    if (keywordsConfigured) return normalizeHashtagBusinessKeywords(businessKeywords);
    return normalizeHashtagBusinessKeywords(config?.hashtagBusinessKeywords);
  }
  try {
    const stored = db.getSetting("hashtag_business_keywords");
    if (stored) return normalizeHashtagBusinessKeywords(JSON.parse(stored));
  } catch {
    // อ่าน/แปลงไม่ได้ = ถือว่าไม่มีรายการ (คงพฤติกรรม # เดิม) ห้ามเดา
  }
  return normalizeHashtagBusinessKeywords(config?.hashtagBusinessKeywords);
}

// คืนข้อความที่ถูกแทนคีย์เวิร์ดแล้ว หรือ null ถ้าไม่เข้ารายการ
// คืน { text, note, tag } — text ใช้แทนข้อความลูกค้า ส่วน note เป็นบริบทของกิจกรรม
// (คืน null ถ้าไม่ใช่ hashtag ที่อยู่ในรายการอนุญาต)
export function resolveBusinessHashtag(text, keywords = {}) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  const exact = trimmed.toLowerCase();
  const ownEntry = (key) => Object.hasOwn(keywords, key) ? keywords[key] : null;
  let tag = "";
  let rest = "";
  // Bare campaign codes are deliberately exact-only. A leading # is an alias
  // only when no explicit # entry exists; it never inherits the legacy suffix match.
  if (/^[a-z0-9][a-z0-9_-]{0,40}$/u.test(exact) && ownEntry(exact)) {
    tag = exact;
  } else if (/^#[a-z0-9][a-z0-9_-]{0,40}$/u.test(exact)
      && !ownEntry(exact) && ownEntry(exact.slice(1))) {
    tag = exact.slice(1);
  } else {
    const match = raw.match(/^\s*([#@][^\s#@]{1,40})([\s\S]*)$/u);
    if (!match) return null;
    tag = match[1].toLowerCase();
    rest = String(match[2] || "").trim();
  }
  const entry = ownEntry(tag);
  if (!entry) return null;
  const isObject = entry && typeof entry === "object";
  const seed = String((isObject ? entry.seed : entry) || "").trim();
  if (!seed) return null;
  const note = String((isObject ? entry.note : "") || "").trim();
  const deliveryText = String((isObject ? entry.deliveryText : "") || "").trim();
  return { tag, text: rest ? `${seed} ${rest}` : seed, note, ...(deliveryText ? { deliveryText } : {}) };
}

export function hashtagSilenceEnabled({ db, config, brain = null }) {
  const stored = brain ? brain.bundle.rules.hashtag.silence : readSilenceSetting(db);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return config.hashtagAutoResponseSilence === true;
}

function readSilenceSetting(db) {
  try {
    return db.getSetting("hashtag_silence");
  } catch {
    return null; // อ่าน DB ไม่ได้ — ตกไปใช้ค่า env เงียบ ๆ (พฤติกรรมเดิม)
  }
}

// พี่ง้วง 12 ต.ค. (ข้อ 3: "ห้ามตอบ ยังยืนยันไม่ได้ เมื่อระบบมีข้อมูล — ทุกอย่างคือ human touch, human sense"):
// ข้อความสำรองของระบบไม่บอกว่าข้อมูลไม่มี/ยืนยันไม่ได้ (ระบบมีข้อมูล แค่ร่างรอบนี้ไม่ผ่านด่าน) และรับปากเท่าที่เกิดขึ้นจริง
// - ด่านเงินบล็อก + ส่งเรื่องให้ทีมสำเร็จ (ห้องขึ้นรอคนแล้ว) = บอกได้ว่าขอเช็คกับทีมงานและจะกลับมาแจ้ง
//   (ยังมีคำรับปากแทนทีมงานที่ตัวจับ v1.4.26 อ่านออก — booking-handoff.test ล็อกไว้ว่าห้ามปิดห้อง)
export const BLOCKED_FALLBACK_TEMPLATE =
  "ขอลูกแพรเช็คเรื่องนี้กับทีมงานให้ชัวร์ก่อนนะคะ จะได้แจ้งได้ถูกต้อง 🙏 บันทึกเรื่องไว้ให้ทีมแล้ว เดี๋ยวรีบกลับมาแจ้งค่ะ";
// - ด่านเงินบล็อกแต่ส่งเรื่องให้ทีมไม่สำเร็จ (DB เขียนไม่ได้) = ไม่มีใครตามเรื่องให้ ห้ามอ้างทีมหรือรับปากว่าจะกลับมา
//   รีวิวรอบ 2: ไม่เอ่ยถึง "ตัวเลข" (ลูกค้าไม่เคยเห็นร่างที่ถูกบล็อก) — ขอเรียบเรียงคำตอบใหม่ แล้วชวนพิมพ์คำถามมาอีกครั้ง
//   (ข้อความถัดไปของลูกค้าได้ร่างใหม่จริง)
export const BLOCKED_FALLBACK_UNTRACKED_TEMPLATE =
  "ขอโทษค่ะ ลูกแพรขอเรียบเรียงคำตอบเรื่องนี้ใหม่ให้ถูกต้องนะคะ 🙏 รบกวนพิมพ์คำถามมาอีกครั้งได้เลยค่ะ";
// - ตัวตรวจคำตอบ (JEV) ล่มหรือไม่แน่ใจ แต่ไม่ได้สั่งหยุด = ไม่มีคนถูกปลุก (ดูคอมเมนต์ที่จุดใช้) จึงไม่อ้างทีมงาน
//   ขอโทษที่สะดุดแล้วชวนพิมพ์มาอีกครั้ง — ทรงเดียวกับ STYLE_BLOCK_TEMPLATE ที่ใช้มาตั้งแต่ v1.4.3
export const JEV_HOLD_FALLBACK_TEMPLATE =
  "ขอโทษที่สะดุดไปนิดนึงนะคะ 🙏 รบกวนพิมพ์มาอีกครั้งได้ไหมคะ ลูกแพรพร้อมดูแลต่อค่ะ";

// v1.4.3: บล็อกเชิงถ้อยคำ (ไม่ใช่เรื่องเงิน) — ประโยค "ข้อมูลยังยืนยันไม่ได้" อ่านไม่รู้เรื่อง
// ในบริบทแชทปกติ ใช้คำขอโทษสั้น ๆ แล้วชวนคุยต่อแทน (ห้ามมีคำว่า ขัดข้อง/ระบบ/error)
export const STYLE_BLOCK_TEMPLATE =
  "ขออภัยที่ชะงักไปนิดนึงนะคะ 🙏 คุยต่อได้เลยค่ะ ลูกแพรพร้อมดูแลต่อค่ะ";

// วินาทีของ LINE loading animation ("กำลังพิมพ์...") — ครอบ burst + Hermes p95
// LINE เลิกโชว์เองทันทีที่ reply มาถึง จึงไม่ต้องมี wait เพิ่มฝั่งเรา
export const LOADING_SECONDS = 20;

// B3: ถอดความเสียงพัง/ปิดอยู่ — ตอบสุภาพแล้วโยนให้คน (ห้ามเงียบ + ห้ามเดาเนื้อหาเสียง)
export const AUDIO_FALLBACK_TEMPLATE =
  "ขออภัยค่ะ ยังฟังข้อความเสียงไม่ชัด ลูกแพรบันทึกไว้ให้ทีมงานตรวจแล้ว รบกวนพิมพ์สั้น ๆ ได้ไหมคะ";

// F5/F6 (ตรวจย้อนหลัง ก.ย. 2026): ไฟล์/รูปในห้องที่ยังไม่มีเรื่องเงิน AI คุยต่อได้ แต่ลูกค้าต้องได้
// ข้อความตอบรับหนึ่งบรรทัด — ของจริงลูกค้าส่งเอกสารแล้วเจอความเงียบทุกครั้ง พิมพ์ตามอีกสามข้อความ
// ถ้อยคำบอกความจริงเท่าที่ระบบทำจริง: เรื่องเงินมีคนตรวจ (รูปถูกปลุกคนตรวจ / ไฟล์อยู่ในคิว)
// ส่วนเนื้อหาในไฟล์ชวนให้เล่าสั้น ๆ แทนการบอกว่า "เปิดไม่ได้" (กติกาน้ำเสียง: พูดสิ่งที่ทำได้)
// 21 ต.ค. 2026 (พี่ง้วง "ทำต่อเลย" — ต่อจากคำตอบ C4 ข้อ 12): ไม่รับปากแทนทีมว่าจะยืนยัน ใช้ถ้อยคำเดียวกับข้อความสลิป
// ใช้เฉพาะตอนอ่านไฟล์/รูปไม่ได้ในห้องที่ยังไม่มีเรื่องเงิน (รูปทั่วไปที่อ่านได้ ลูกแพรคุยต่อตามคำบรรยายของรูป)
export const FILE_ACK_TEMPLATE =
  "ได้รับไฟล์แล้วนะคะ 🙏 ถ้าเป็นเอกสารการชำระเงิน ลูกแพรรับเรื่องและตรวจสอบให้นะคะ ถ้าอยากให้ลูกแพรช่วยดูเรื่องในไฟล์ พิมพ์เล่าสั้น ๆ ได้เลยนะคะ";
export const IMAGE_ACK_TEMPLATE =
  "ได้รับรูปแล้วนะคะ 🙏 ถ้าเป็นสลิปหรือเอกสารการชำระเงิน ลูกแพรรับเรื่องและตรวจสอบให้นะคะ ถ้าอยากให้ลูกแพรช่วยเรื่องในรูป พิมพ์เล่าสั้น ๆ ได้เลยนะคะ";
// รีวิวเคสจริง 6–7 ต.ค.: ลูกค้าส่งไฟล์ 7 ไฟล์ติดกันแล้วได้ "ได้รับไฟล์แล้วนะคะ…" ข้อความเดิมเป๊ะ ๆ ทุกไฟล์ — ตอบรับครั้งเดียวต่อชุด:
// ข้อความตอบรับเดียวกันที่ลูกแพรเพิ่งส่งภายในหน้าต่างนี้ และหลังจากนั้นไม่มีใครพิมพ์อะไรอีก (มีแต่ไฟล์/รูปที่ส่งตามมา) = ไม่ส่งซ้ำ
// ธงคิวรอคน โน้ตทีม และการแจ้งเตือนของแต่ละไฟล์เดินเหมือนเดิมทุกไฟล์ — เปลี่ยนแค่ข้อความที่ถึงมือลูกค้า
export const MEDIA_ACK_REPEAT_WINDOW_MS = 10 * 60_000;

// B2: แอดมินตอบเองจาก console -> AI พักภายในหน้าต่างนี้ (ต่ออายุทุกครั้งที่แอดมินตอบ)
// 2026-09-02: ค่าจริงย้ายไปอยู่ aiPausePolicy.mjs (แหล่งเดียวของนโยบายพัก/ปิด)
// ชื่อเดิมคงไว้เพราะคอนโซลและเทสต์อ้างถึงอยู่
export const OPERATOR_ACTIVE_MS = OPERATOR_PAUSE_MS;

// M2: เรื่องเงิน escalate = "หยุดขาย รอคนจริงตรวจยอด" จริง — reuse กลไก
// operator_active_until เดิม (ไม่มีคอลัมน์ใหม่): AI พัก 60 นาทีสำหรับข้อความถัดไป
// เส้นทาง template+escalate (urgent/กฎเฉพาะธุรกิจ) ยังยิงระหว่างพักตามเดิม;
// escalation จาก guard-block (compliance_block) ไม่พัก — fallback+correction เพียงพอ
//
// 2026-09-02 (คำสั่งเจ้าของ): "ร้องเรียน" ย้ายออกจากลิสต์นี้ไปเป็นการปิดถาวร —
// พักตามเวลาแปลว่าอีก 60 นาทีบอทจะกลับมาขายต่อใส่คนที่เพิ่งบ่นว่าไม่พอใจ
export const ESCALATION_PAUSE_MS = 60 * 60_000;
const ESCALATION_PAUSE_REASONS = new Set(["payment_review"]);

// B1: รูป key เดิมที่เคยส่งภายในช่วงนี้ = ห้ามส่งซ้ำ (ลูกค้าบ่น "ส่งมาเยอะจัง")
export const IMAGE_DEDUPE_WINDOW_MS = 7 * 86_400_000;

// G7.2: out-of-band admin reply detection — mitigation ของ "OA Manager blindness"
// (ข้อความที่แอดมินพิมพ์ใน OA Manager ไม่เข้า webhook): scorer ชี้ว่า "ลูกค้าอ้างถึง
// คำตอบแอดมินที่ไม่อยู่ในประวัติ" -> พัก AI 30 นาที + ธง NEEDS_HUMAN + โน้ตให้คนเติมบริบท
// - advisory ล้วน ๆ หลัง scorer (วิ่งหลังตอบเสร็จเสมอ) — ไม่ยกเลิก reply ที่กำลังส่ง
// - conservative: trigger ได้มากสุดครั้งเดียวต่อลูกค้าต่อ 24 ชม. (settings oob_last:<id>)
export const OUT_OF_BAND_PAUSE_MS = 30 * 60_000;
export const OUT_OF_BAND_COOLDOWN_MS = 24 * 3_600_000;
export const OUT_OF_BAND_NOTE =
  "ระบบสงสัยว่าแอดมินคุยกับลูกค้านอกระบบ (OA Manager) — AI พักชั่วคราว ตรวจสอบและเติมบริบทด้วย";
export const oobLastKey = (customerId) => `oob_last:${customerId}`;
// F14 (ตรวจย้อนหลัง ก.ย. 2026 — D935, D570): ลูกค้าเล่าถึงสิ่งที่เจ้าของพูด/สอน/โชว์ในงาน สัมมนา เวที คลาส ไลฟ์
// scorer อ่านเป็น "อ้างถึงคำตอบแอดมินที่ไม่อยู่ในแชท" แล้วพัก AI 30 นาที ทั้งที่ไม่มีใครคุยนอกระบบเลย
// ตัวกรองแบบ deterministic บนข้อความลูกค้าล่าสุด (ไม่แตะพรอมต์ scorer) — เจอ = ไม่พัก + audit
// ไม่ใช้ "ในงาน" เพราะชนกับ "ใช้ในงาน" ที่ลูกค้าพูดบ่อยมาก · "บอก/ตอบ" เป็นกริยาของแอดมินในแชท จึงไม่นับ
const OUT_OF_BAND_EVENT_REFERENCE = new RegExp([
  "เมื่องาน", "ไปงาน", "ออกงาน", "งานสัมมนา", "สัมมนา", "บนเวที", "ในคลาส", "ตอนเรียน",
  "ในไลฟ์", "ตอนไลฟ์", "ไลฟ์สด", "webinar", "เว็บบินาร์", "workshop", "เวิร์กช็อป", "เวิร์คช็อป",
  "ออกบูธ", "ที่บูธ", "หน้าบูธ", "เมื่อวาน[^\\n]{0,24}?(?:พูด|สอน|เล่า|โชว์|เปิดให้ดู)",
].join("|"), "iu");
export function mentionsOwnerEventReference(texts = []) {
  return (Array.isArray(texts) ? texts : [texts])
    .some((value) => OUT_OF_BAND_EVENT_REFERENCE.test(normalizeThai(String(value || ""))));
}
// F14: คำขอติดต่อทีมงาน/ขอจองที่มาถึงระหว่าง AI พัก (ไม่มีคนจริงอยู่ในห้อง) — ปักธง + ปลุกทีม ไม่ตอบ ไม่ปิด AI
export const PAUSED_CONTACT_REASON = "paused_contact_request";

// ---- v1.4.26 "ผู้รักษาสัญญา" (วัดจริง 2026-08-19 จาก transcript 2,320 เทิร์น) ----
// บอทพูดว่า "จะส่งเรื่องให้ทีมงาน / ทีมงานจะติดต่อกลับ" 147 ครั้ง แต่ 15 ครั้ง (10%)
// ไม่มี handoff เกิดขึ้นจริง — ลูกค้าถูกรับปากแล้วไม่มีใครในทีมรู้เลย เคสหนักสุดคือ
// ขอเลื่อนคลาสครั้งที่ 2 แบบกระชั้นชิด และ "ไม่อยากคุยกับบอทแล้ว ขอคนหน่อยค่ะ"
// (เคสหลังคือ regression ที่เคยพยายามแก้ฝั่ง "คำลูกค้า" แล้วชนกับประโยคปกติ
// "ลูกค้าร้านผมไม่อยากคุยกับบอทเลย" จนต้อง revert — แบทช์ 2)
//
// จึงดักจาก "คำพูดของบอทเอง" แทน: บอทเข้าใจถูกและพูดถูกอยู่แล้ว ขาดแค่ระบบไม่ทำตาม
// ข้อดีคือไม่ต้องเดาเจตนาลูกค้า จึงไม่ซ้ำรอย over-trigger เดิม
//
// กติกาสำคัญ 2 ข้อที่วัดมาแล้ว:
// 1. ต้องเป็นคำว่า "ทีมงาน" เท่านั้น — คำว่า "ทีม" เฉย ๆ ส่วนใหญ่คือทีมของลูกค้าเอง
//    ("ทีมบัญชีคีย์มือกันหมด") ถ้าจับคำนี้ด้วยจะยิงโน้ตผิดทันที
// 2. ต้องมีคำแสดงการรับปากในบรรทัดเดียวกัน — กันหัวข้อในลิสต์ขายของ
//    ("ออกแบบจังหวะส่งต่อให้ทีมงานดูแลเคสสำคัญ" = เนื้อหาคลาส ไม่ใช่คำสัญญา)
const TEAM_PROMISE_VERB = "ดูแล|ตรวจสอบ|ตรวจ|ยืนยัน|พิจารณา|สรุป|ติดต่อ|โทร|ประสาน|เสนอราคา|แจ้งกลับ|รับช่วง|เข้ามา";
// v1.4.30 (พี่ง้วงกำหนด 2026-08-19): "ทีมงาน" กับ "ทีมผู้ดูแล" คือทีมเดียวกัน ต้องนับเท่ากัน
// เดิมจับแค่ "ทีมงาน" แล้วพลาดลีดองค์กรทั้งใบ — เคสจริง probe-edge-09: ลูกค้า In-house
// ให้ชื่อบริษัท เบอร์ และเวลาที่สะดวกครบ บอทตอบว่า "ทีมผู้ดูแลจะติดต่อคุณโต้งที่เบอร์...
// ช่วงบ่ายวันจันทร์" แล้วไม่มี handoff เกิดขึ้นเลย = ไม่มีใครโทรจริง
// ยังคงห้ามจับคำว่า "ทีม" เดี่ยว ๆ เพราะส่วนใหญ่หมายถึงทีมของลูกค้าเอง
const TEAM_WORDS = "ทีมงาน|ทีมผู้ดูแล|ทีมดูแล|ทีมที่ดูแล";
export const TEAM_PROMISE_RE = new RegExp(
  `(?:ส่ง(?:เรื่อง|ต่อ)|ให้|ขอให้|กับ|เช็คกับ|คุยกับ)\\s*(?:${TEAM_WORDS})`
  + `|(?:${TEAM_WORDS})[^\\n]{0,14}?(?:จะ|เป็นผู้|ช่วย)\\s*(?:${TEAM_PROMISE_VERB})`,
  "u",
);
// คำเสนอ/คำถาม ไม่ใช่คำรับปาก — "ให้ทีมผู้ดูแลออกแบบให้ไหมคะ?" ยังไม่มีใครตกลงอะไร
// ถ้าไม่กรองออก โน้ตจะท่วมแอดมินจนเลิกอ่าน ซึ่งอันตรายกว่าไม่แจ้งเลย
const TEAM_PROMISE_OFFER = /[?？]\s*$|ไหมคะ|ไหมครับ|มั้ยคะ|มั้ยครับ|ดีไหม|ดีมั้ย/u;
const TEAM_PROMISE_COMMITMENT = /ลูกแพร|เดี๋ยว|ขอ|ต้องให้|จะ/u;
// ป้ายที่แอดมินกดเองในคอนโซลเพื่อบอกว่า "คนรับช่วงต่อแล้ว" — ชื่อป้ายต้องตรงกับที่ชมพู่เห็น
export const CUSTOMER_HANDOVER_TAG = "customer";
export const CUSTOMER_HANDOVER_REASON = "customer_handover";
// ป้ายที่สั่งให้บอทเงียบ กับเหตุผลที่บันทึกไว้ว่าปิดเพราะอะไร
//
// เหตุผลต้องแยกกัน ไม่ใช่ใช้ customer_handover ทั้งคู่ — customerRetention.mjs ใช้
// customer_handover เป็นสัญญาณว่า "จ่ายเงินแล้ว ห้ามลบข้อมูล" ถ้าพนักงานบัญชีที่ติดป้าย
// null ใช้เหตุเดียวกัน จะถูกจัดเป็นลูกค้าที่จ่ายแล้ว ซึ่งตรงข้ามกับความหมายที่ตั้งใจ
export const SILENT_TAG_REASON = Object.freeze({
  customer: CUSTOMER_HANDOVER_REASON,
  null: "not_a_customer",
});
export function silentTagReason(tag) {
  return SILENT_TAG_REASON[String(tag ?? "").trim().toLowerCase()] ?? null;
}

// v1.4.37 (แชทจริง 2026-08-19): ตัวจับด้านบนผูกกับคำว่า "ทีมงาน" จึงมองไม่เห็นคำสัญญา
// ที่ลูกแพรพูด "ในนามตัวเอง" — ซึ่งเป็นกลุ่มที่อันตรายกว่า เพราะ "ทีมงานจะติดต่อกลับ"
// อย่างน้อยมีคนอยู่ปลายทาง แต่ "ลูกแพรล็อกสิทธิ์ให้แล้ว" ไม่มีทั้งคนและระบบ
// เกิดจริง: ลูกค้าให้ชื่อ+เบอร์เพื่อจองรอบ 19 ก.ย. บอทตอบว่าล็อกให้แล้ว → ไม่มีโน้ต
// ไม่มีแจ้งเตือน ไม่มีระบบล็อกที่นั่งอยู่จริง = ลูกค้ารอเก้อแบบเดียวกับบั๊กเส้นเงิน
//
// จำกัดไว้เฉพาะการกระทำที่ "ระบบทำเองไม่ได้จริง ๆ" เท่านั้น ไม่ใช่ทุกคำที่ขึ้นต้นด้วยลูกแพร
// (วัดกับข้อความจริง 1,202 ข้อความ: ยิง 6 = 0.50% · ของจริงทั้ง 6 · ไม่มียิงผิด)
const SELF_PROMISE_ACT = "ล็อก(?:สิทธิ์)?|จอง|สำรอง|จัดทำใบเสนอราคา|ออกใบเสนอราคา|ทำใบเสนอราคา";
// ลูกแพรต้องเป็น "ผู้ทำ" ไม่ใช่ "ผู้ถูกทัก" — กัน "ทักลูกแพรเพื่อดำเนินการจองได้เลยค่ะ"
// ซึ่งเป็นการชวนลูกค้าติดต่อ ไม่ใช่การรับปากว่าทำให้แล้ว
export const SELF_PROMISE_RE = new RegExp(
  `(?<!ทัก|แจ้ง|บอก|ถาม|กับ)ลูกแพร(?:จะ)?[^\\n]{0,16}?(?:${SELF_PROMISE_ACT})`,
  "u",
);
// White-label: ตัวจับคำของบอทเองต้องรู้จักชื่อแอดมิน AI ของร้าน — แบรนด์เริ่มต้น = regex ตัวเดิมเป๊ะ
const BRANDED_RE_CACHE = new Map();
function brandedRegex(key, base, build) {
  const name = activeBrand().agentName;
  if (name === "ลูกแพร") return base;
  const cacheKey = `${key}|${name}`;
  if (!BRANDED_RE_CACHE.has(cacheKey)) BRANDED_RE_CACHE.set(cacheKey, build(agentNamePattern()));
  return BRANDED_RE_CACHE.get(cacheKey);
}
function selfPromiseRe() {
  return brandedRegex("self", SELF_PROMISE_RE, (agent) => new RegExp(
    `(?<!ทัก|แจ้ง|บอก|ถาม|กับ)${agent}(?:จะ)?[^\\n]{0,16}?(?:${SELF_PROMISE_ACT})`, "u"));
}
function teamPromiseCommitmentRe() {
  return brandedRegex("commit", TEAM_PROMISE_COMMITMENT, (agent) => new RegExp(`${agent}|เดี๋ยว|ขอ|ต้องให้|จะ`, "u"));
}
// "หากพร้อมสมัคร ส่งวันมา ลูกแพรจะจองให้" = ชวนลูกค้าทำก่อน ยังไม่มีใครรับปากอะไร
// นับเฉพาะเงื่อนไขที่มา *ก่อน* คำรับปาก — ถ้ามาทีหลังคือรับปากแล้วค่อยชวนต่อ (ต้องยิง)
const SELF_PROMISE_CONDITIONAL = /หาก|ถ้า|เมื่อพร้อม/u;

// เคสจริง 2026-09-05: เมื่อเลิกปัดคำถามเอกสารก่อนซื้อด้วยแม่แบบ ทีมงานจะไม่เห็นห้องพวกนี้อีกเลย
// (แม่แบบเดิมปักธง NEEDS_HUMAN ให้อัตโนมัติ) — โน้ตนี้แทนที่ธงนั้น: ทีมเห็นความสนใจ แต่ AI ยังคุยต่อ
export const DOC_PRESALE_NOTE_PREFIX = "สนใจเอกสารก่อนซื้อ";
export const DOC_PRESALE_NOTE_COOLDOWN_MS = 6 * 60 * 60_000;
// F4b (ตรวจย้อนหลัง ก.ย. 2026): โน้ตที่ไปป์ไลน์เขียนเองตอนลูกค้าขอให้หยุดตอบ — ใบสั่งงานของทีม
// ห้ามวนกลับเข้าพรอมต์ (โรคเดียวกับโน้ตผู้รักษาสัญญา) ถ้าทีมเปิด AI คืน ลูกแพรต้องไม่อ่านมันเป็น
// "บันทึกจากทีมงาน" แล้วไปขอโทษหรือเล่าเรื่องภายในให้ลูกค้าฟัง
export const QUIET_STOP_NOTE_PREFIX = "ลูกค้าขอให้หยุดตอบ";
// F5: โน้ตที่ไปป์ไลน์เขียนเองเมื่อไฟล์เข้าห้องที่ยังไม่มีเรื่องเงิน (ทีมเปิดดูไฟล์เมื่อสะดวก)
export const FILE_REVIEW_NOTE_PREFIX = "ลูกค้าส่งไฟล์แนบ";
// โน้ต ai_auto ที่ไปป์ไลน์เขียนเองเป็นใบสั่งงานทีม — ห้ามวนกลับเข้าพรอมต์ในฐานะ "บันทึกจากทีมงาน"
const PIPELINE_TEAM_NOTE_PREFIXES = Object.freeze([QUIET_STOP_NOTE_PREFIX, FILE_REVIEW_NOTE_PREFIX]);

// ---- ตรวจปรปักษ์ 2026-09-05: ตราเงินในคิวรอคน ไม่ใช่ของเดียวกับธงเงินถาวร ----
//
// คอนโซล (public/console/inbox.mjs touchesMoney) และ SLA push อ่าน money_seen_at/bank_sent
// เป็นตัวตัดสินว่าจะติดตรา 💰 ให้ห้องไหน. ถ้ารูปสลิปจริงขนาด ~900KB ตกด่านขนาดแล้วไม่ปักธงเลย
// ห้องนั้นจะไปนั่งปนกับห้องรอคนอีก ~28 ห้องโดยไม่มีสัญญาณว่าเป็นเรื่องเงิน = แย่กว่าโปรดักชันเดิม
//
// เส้นแบ่งที่ถูกจึงไม่ใช่ "จำแนกได้/ไม่ได้" แต่เป็น "ระบบเคยเห็นไบต์ของรูปใบนี้หรือยัง":
//   เคยเห็นแล้วจำแนกไม่ออก (ใหญ่เกิน/เกตเวย์ล้ม/อ่านคำตอบไม่ออก) = ยังเป็นสลิปได้ -> ปักธง
//   ไม่เคยเห็นเลย (สวิตช์ปิด / ไฟล์ยังดาวน์โหลดไม่เสร็จ)        = ไม่มีหลักฐานอะไรทั้งนั้น -> ไม่ปัก
// เหตุการณ์ 14 ห้องที่พี่ง้วงแจ้งคือกรณีหลังล้วน ๆ (IMAGE_CLASSIFY_ENABLED ไม่เคยถูกตั้ง)
const IMAGE_NO_ATTEMPT_CODES = new Set(["disabled", "no_file"]);

export const PROMISE_NOTE_AUTHOR = "ai_promise";
export const PROMISE_NOTE_COOLDOWN_MS = 30 * 60_000;

export function looksLikeTeamPromise(text = "") {
  return String(text)
    .split(/\n+/u)
    .some((line) => TEAM_PROMISE_RE.test(line)
      && teamPromiseCommitmentRe().test(line)
      && !TEAM_PROMISE_OFFER.test(line.trim()));
}

export function looksLikeSelfPromise(text = "") {
  return String(text).split(/\n+/u).some((line) => {
    const match = selfPromiseRe().exec(line);
    if (!match) return false;
    if (TEAM_PROMISE_OFFER.test(line.trim())) return false;
    return !SELF_PROMISE_CONDITIONAL.test(line.slice(0, match.index));
  });
}

/* ---- R2 (คำสั่งพี่ง้วง 2026-09-05 รอบสาม): กุญแจดอกที่ 2 ฉบับเข้ม ---- */
//
// รอบสองใช้ looksLikeTeamPromise/looksLikeSelfPromise (ตัวจับ v1.4.26) เป็นกุญแจดอกที่ 2
// ซึ่งผิดหน้าที่: ตัวจับคู่นั้นถูกออกแบบมาเพื่อ "ออกใบสั่งงานให้ทีมงานตามเรื่อง" จึงตั้งใจ
// หลวมไว้ (จับให้ครบดีกว่าพลาด เพราะราคาของการจับเกินคือโน้ตหนึ่งใบ) แต่ราคาของการจับเกิน
// ที่นี่คือ **ปิดปากลูกแพรถาวร** ผู้ตรวจปรปักษ์รอบสองยกตัวอย่างที่มันผ่านทั้งที่ไม่ใช่
// การส่งไม้ต่อจริง:
//   · "หากต้องการจอง แจ้งชื่อ...มาได้เลยค่ะ เดี๋ยวลูกแพรส่งเรื่องให้ทีมงานยืนยันที่นั่งให้นะคะ"
//     = ข้อเสนอแบบมีเงื่อนไข ลูกค้ายังไม่ได้แจ้งอะไรเลย ห้องยังต้องคุยต่อ
//   · "ทีมงานพร้อมช่วยดูแลทุกขั้นตอนค่ะ สะดวกรอบไหนดีคะ" = คำสุภาพ + คำถาม ไม่ใช่การส่งไม้ต่อ
//
// ตัวนี้จึงเป็นของใหม่แยกไฟล์หน้าที่กันชัด ๆ: ใช้กับ "การปิดห้อง" เท่านั้น ส่วนเส้น v1.4.26
// (โน้ต ai_promise + push แต่ AI ยังเปิด) ยังใช้ตัวจับเดิมทุกไบต์ ไม่ถูกแตะเลย
//
// อ่านราย "ประโยค" ไม่ใช่รายบรรทัด — humanizer ยุบประโยคสั้นเข้าเป็นบอลลูนเดียวเสมอ
// ถ้าอ่านรายบรรทัด เงื่อนไขที่อยู่ประโยคก่อนหน้าจะกลายเป็นส่วนหนึ่งของคำรับปากทันที
// ---- รอบสาม (ผู้ตรวจ 2026-09-05): กุญแจดอกที่ 2 ต้องเป็น "การส่งมอบเคสของคนนี้ ตอนนี้" ----
//
// ชุดคำรับปากรอบสองหลวมไปสองจุดใหญ่ ทั้งสองจุดถูกพิสูจน์ด้วยการรันโค้ดจริง:
//   · "ขอ" ไปแมตช์อยู่กลางคำว่า "ของ" — วลีที่ลูกแพรพูดทุกวันอย่าง "ทีมงานของเราดูแลต่อ
//     ให้หลังเรียนจบค่ะ" จึงผ่านกุญแจดอกที่ 2 ทั้งที่เป็นการเล่าคุณสมบัติสินค้า
//   · "จะ" เปล่า ๆ ทำให้ประโยคเล่า *ขั้นตอน* ผ่านหมด — "หลังจากนั้นทีมงานจะติดต่อกลับ
//     เพื่อยืนยันที่นั่งนะคะ" คือคำตอบของคำถาม "สมัครยังไง" ไม่ใช่การส่งไม้ต่อ ณ ตอนนี้
//     (กฎ v1.4.37 ในพรอมต์เดียวกันสั่งให้พูดแบบนี้ด้วยซ้ำ)
// ราคาของการจับเกินคือ "ปิดปากลีดถาวร" จึงเหลือเฉพาะคำที่ผูกกับตัวลูกแพรหรือห้องนี้เท่านั้น
// ประโยคที่พรอมต์กำหนดคำต่อคำยังผ่านครบ: ประโยคจองมี "ในแชทนี้" ประโยคติดต่อมี "ลูกแพร"
const HANDOVER_COMMIT = /ลูกแพร|เดี๋ยว|ส่งเรื่อง|ส่งต่อ|ในแชทนี้/u;
const HANDOVER_TEAM = /ทีมงาน|ทีมผู้ดูแล|ทีมดูแล|ทีมที่ดูแล|คุณชมพู่|ชมพู่/u;
// สี่การกระทำนี้เท่านั้น — ทั้งหมดเป็นสิ่งที่ "คนจริงเท่านั้นทำได้" (บทเรียน v1.4.37)
// F4 (ตรวจย้อนหลัง ก.ย. 2026 — D762): ลูกแพรพูดจริงว่า "ส่งต่อให้ทีมงานคนจริงเข้ามาดูแลในแชทนี้"
// (ไม่มีคำว่า "ต่อ") กุญแจดอกที่ 2 จึงไม่ไข ห้องยังเปิด แล้ว follow-up ทักซ้ำ 4.5 ชม. ถัดมา
const HANDOVER_ACTION = /ติดต่อกลับ|ดูแลต่อ|ยืนยันที่นั่ง|จัดทำใบเสนอราคา|เข้ามาดูแล|ดูแลในแชทนี้|ส่งต่อให้ทีมงานคนจริง/u;
// คำสุภาพประจำร้าน ไม่ใช่การส่งมอบเคส — "ทีมงานพร้อมช่วยดูแล" พูดได้ทุกเทิร์นตั้งแต่ทักทาย
const HANDOVER_COURTESY = /ทีมงานพร้อม|พร้อมช่วยดูแล|พร้อมดูแล|พร้อมให้บริการ|ยินดีให้บริการ|ยินดีดูแล/u;
// ธุรกิจนี้ *ขาย* ระบบส่งต่อลูกค้าให้ทีมงาน ลูกแพรจึงพูดคำว่า "ส่งต่อให้ทีมงานดูแลต่อ" ใน
// ฐานะคำโฆษณาสินค้าได้ทั้งวัน — ประโยคที่มีกรอบ "ในคลาส/สอน/บอท/อัตโนมัติ" ไม่ใช่การส่งมอบ
const HANDOVER_PRODUCT = /ในคลาส|ในคอร์ส|ในหลักสูตร|ในเวิร์กช็อป|สอนให้|สอนวิธี|สอนเรื่อง|เรียนจบ|บอท|อัตโนมัติ/u;
// เงื่อนไข/ข้อเสนอ = ลูกค้ายังต้องทำอะไรอีกอย่างก่อน ห้องจึงยังไม่จบ
// "ได้เลย" ต้องผูกกับกริยาสั่งการเสมอ ("แจ้งชื่อได้เลยค่ะ") — "ได้เลยค่ะ" เดี่ยว ๆ คือคำตอบรับ
const HANDOVER_CONDITIONAL =
  /หาก|ถ้า|กรณีที่|เมื่อ|(?:^|\s)พอ|แล้วค่อย|(?:แจ้ง|ส่ง|บอก|พิมพ์|กรอก|ทัก)[^\n]{0,24}?(?:มา)?ได้เลย/u;
// คำเชื่อมลำดับ/ขั้นตอนที่มาก่อนคำว่า "ทีมงาน" = ประโยคกำลังเล่ากระบวนการ ไม่ได้ส่งมอบ
const HANDOVER_PROCESS = /ขั้นตอน|หลังจาก|หลัง|ก่อน|จากนั้น|โอน|สลิป|มัดจำ/u;
// คำถามปิดท้าย = ลูกแพรยังรอคำตอบอยู่ ห้ามปิดปากเธอกลางบทสนทนา
const HANDOVER_QUESTION_END = /(?:ไหมคะ|ไหมครับ|มั้ยคะ|มั้ยครับ|ดีคะ|ดีค่ะ|ดีครับ|ไหนคะ|ไหนครับ|หรือเปล่า|รึเปล่า|ยังไงดี)$/u;

function endsWithQuestionToCustomer(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  if (/[?？]\s*$/u.test(value)) return true;
  // อิโมจิ/เครื่องหมายท้ายประโยคไม่ได้ทำให้คำถามเลิกเป็นคำถาม ("สะดวกรอบไหนดีคะ 😊")
  return HANDOVER_QUESTION_END.test(value.replace(/[\s\p{P}\p{S}]+$/gu, ""));
}

/**
 * บอลลูนที่ "ถึงมือลูกค้าแล้ว" ชุดนี้ เป็นการส่งไม้ต่อให้คนจริงแบบไม่มีเงื่อนไขหรือเปล่า
 *
 * ใช้เป็นกุญแจดอกที่ 2 ของการปิดห้องเท่านั้น (คำสั่งพี่ง้วง 2026-09-05)
 *
 * @param {Array<{text?: string}|string>} bubbles บอลลูนที่ส่งสำเร็จจริง เรียงตามลำดับที่ส่ง
 * @returns {boolean}
 */
export function looksLikeHandoverReply(bubbles = []) {
  const texts = (Array.isArray(bubbles) ? bubbles : [bubbles])
    .map((bubble) => String(typeof bubble === "string" ? bubble : (bubble?.text ?? "")))
    .filter((value) => value.trim());
  if (!texts.length) return false;
  // ข้อความสุดท้ายที่เขาเห็นเป็นคำถาม = เรากำลังรอคำตอบเขาอยู่ ปิดห้องตรงนี้คือทิ้งเขากลางคัน
  if (endsWithQuestionToCustomer(texts[texts.length - 1])) return false;
  // แบนประโยคของ "ทุกบอลลูน" เป็นเส้นเดียว — humanizer ตัดย่อหน้าเป็นคนละบอลลูน และพรอมต์
  // สั่งให้ประโยคปิดท้ายอยู่ย่อหน้าของตัวเอง ข้อเสนอที่ค้างอยู่ย่อหน้าก่อนจึงเคยหายไปทั้งใบ
  // (ตัวอย่างที่ผู้ตรวจรอบสองยกมาเองก็หลุดด้วยรูนี้ เพราะรอบสองดูแค่ในบอลลูนเดียวกัน)
  const sentences = texts
    .flatMap((bubble) => splitThaiSentences(bubble))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    if (!brandedRegex("handover", HANDOVER_COMMIT, (agent) => new RegExp(`${agent}|เดี๋ยว|ส่งเรื่อง|ส่งต่อ|ในแชทนี้`, "u")).test(sentence)) continue;
    const team = sentence.match(HANDOVER_TEAM);
    if (!team) continue;
    if (!HANDOVER_ACTION.test(sentence)) continue;
    if (HANDOVER_COURTESY.test(sentence)) continue;
    if (HANDOVER_PRODUCT.test(sentence)) continue;
    const beforeTeam = sentence.slice(0, team.index);
    if (HANDOVER_CONDITIONAL.test(beforeTeam)) continue;
    if (HANDOVER_PROCESS.test(beforeTeam)) continue;
    // เงื่อนไขที่ค้างอยู่ในประโยคก่อนหน้า *ของการส่งชุดเดียวกัน* ไม่ว่าจะอยู่บอลลูนไหน
    if (sentences.slice(0, index).some((prior) => HANDOVER_CONDITIONAL.test(prior))) continue;
    return true;
  }
  return false;
}

// A conversational customer turn may contain several LINE messages absorbed by
// one burst. Scoring runs after the reply is stored, so skip trailing assistant
// bubbles, then collect the contiguous inbound group immediately before them.
// Stopping at the previous assistant is the session boundary that prevents
// completed-enquiry evidence from leaking into a later turn.
export function latestInboundTurnText(turns = []) {
  let index = Array.isArray(turns) ? turns.length - 1 : -1;
  while (index >= 0 && turns[index]?.role !== "user") index -= 1;
  const inbound = [];
  while (index >= 0 && turns[index]?.role === "user") {
    inbound.unshift(String(turns[index]?.content || ""));
    index -= 1;
  }
  return inbound.filter(Boolean).join("\n");
}

// v1.4.45 (เคสจริงพี่ง้วงเทสเอง 2026-08-22 22:03): ลูกค้าพิมพ์ 4 บอลลูนติด
// "ผมทำสำนักงานบัญชี / ช่วย แก้งาน / ออเดอร์ ลูกหนี้ / ทั่วไปครับ" — burst รวมครบ 4
// แต่พรอมต์ส่งให้โมเดลเป็นก้อนเดียว 4 บรรทัดไม่มีอะไรบอกว่าเป็นคนละข้อความ บรรทัดท้าย ๆ
// ที่สั้น ("ออเดอร์ ลูกหนี้") เลยถูกอ่านเป็นเศษประโยคแล้วไม่ถูกตอบ ทั้งที่มันคือ
// "คำตอบ" ของคำถามที่เราถามเอง — อาการเหมือนบอทอ่านได้แค่ 2-3 บอลลูน
// ประวัติใน DB ยังเป็นข้อความแยกรายตัวเหมือนเดิม (เปลี่ยนเฉพาะสิ่งที่โมเดลเห็นในเทิร์นนี้)
export function renderBurstForModel(text, parts = []) {
  const list = (Array.isArray(parts) ? parts : []).map((p) => String(p || "").trim()).filter(Boolean);
  if (list.length <= 1) return String(text || "");
  return `ลูกค้าส่งมา ${list.length} ข้อความติดกัน (อ่านรวมเป็นเจตนาเดียว ตอบให้ครบทุกข้อความ):\n`
    + list.map((p, i) => `${i + 1}) ${p}`).join("\n");
}

/**
 * "เทิร์นนี้เป็นงาน project ที่ทีมผู้ดูแลต้องออกใบเสนอราคาไหม" — คำตอบเดียวของทั้งไปป์ไลน์
 *
 * ของเดิมคำนวณอยู่กลาง baseRules แล้วแกนโปรโมชั่นใน priceDisclosure มีตัวจับของตัวเอง
 * (PROJECT_PRICE_CONTEXT) ซึ่งไม่ตรงกัน — ผลคือพรอมต์ก้อนเดียวแบกทั้งแม่แบบ
 * "PROMOTION Early Bird 📌" และ "ห้ามยกตารางราคา ราคาโปร" พร้อมกันได้ (ตรวจปรปักษ์ 2026-09-04)
 */
export function resolveProjectOpportunity({ currentText = "", salesPolicy = null, salesState = null } = {}) {
  const active = salesState?.opportunity?.type && PROJECT_OPPORTUNITY_TYPES.has(salesState.opportunity.type)
    && salesState.opportunity.handoffReady !== true
    ? salesState.opportunity.type
    : null;
  const direct = salesPolicy ? detectDirectOpportunityType(currentText, salesPolicy) : null;
  const type = direct || active;
  return type && PROJECT_OPPORTUNITY_TYPES.has(type) ? type : null;
}

/**
 * เทิร์นนี้เป็น "เทิร์นส่งไม้ต่อ" หรือเปล่า — คำตอบเดียวที่ทั้งพรอมต์และการปิดห้องต้องใช้
 *
 * คำสั่งพี่ง้วง 2026-09-05 ครอบสองเจตนา (จอง/สมัคร กับ ขอติดต่อทีมงาน) แต่ **ไม่** ครอบงาน
 * project (in-house / private class / งานบรรยาย): flow นั้นมีการส่งต่อของตัวเองครบอยู่แล้ว
 * (เก็บ slot ทีละข้อ -> maybeHandoffOpportunity ปิด AI + push ชมพู่ พร้อมสรุปที่โทรกลับได้เลย)
 * ถ้าปล่อยให้สองกลไกทับกัน พรอมต์ก้อนเดียวจะสั่งทั้ง "เก็บข้อมูลทีละหนึ่งคำถามต่อเทิร์น"
 * และ "ห้ามถามคำถามคัดกรองเพิ่ม" พร้อมกัน แล้วห้องจะถูกปิดกลางคันโดยที่ทีมไม่ได้ slot อะไรเลย
 * (ข้อ 18 ของการตรวจปรปักษ์ 2026-09-05)
 */
export function isClosingHandoffTurn(handoffIntent, projectOpportunity = null) {
  return Boolean(handoffIntent) && !projectOpportunity;
}

/**
 * R6: "ใบ้ดอกนี้ปิดห้องได้ไหม" — คนละคำถามกับ "พรอมต์ควรเปลี่ยนทรงไหม"
 *
 * งาน project เป็นเจ้าของ **พรอมต์** ของตัวเองเสมอ (เก็บ slot ทีละข้อ) จึงห้ามให้ใบ้ไปแย่ง
 * แต่การ **ปิดห้อง** เป็นอีกเรื่อง: ลีดองค์กรที่พิมพ์ว่า "ขอเบอร์ทีมงานหน่อยค่ะ" กลางการ
 * เก็บ slot คือคนที่อยากคุยกับคนจริงเดี๋ยวนี้ ปล่อยให้บอทไล่ถาม slot ต่อคือการฝืน
 * — และปิดได้ก็ต่อเมื่อลูกแพรส่งไม้ต่อจริงในข้อความที่ถึงมือเขาแล้วเท่านั้น (กุญแจดอกที่ 2)
 *
 * ฝั่งจอง/สมัครยังยกเว้นเหมือนเดิม: flow ของ project ปิด AI + push ชมพู่ให้อยู่แล้ว
 * เมื่อ slot ครบ การปิดก่อนจึงทำให้ทีมได้ใบสั่งงานที่ไม่มีข้อมูล (ข้อ 18 ของรอบสอง)
 */
export function handoffClosureIntent(handoffHint, projectOpportunity = null) {
  if (!handoffHint) return null;
  if (handoffHint.kind === "contact_team") return handoffHint;
  return projectOpportunity ? null : handoffHint;
}

/**
 * R3(d): หมุดเวลา "ใบ้ย้อนหลังเริ่มนับใหม่ตรงนี้"
 *
 * คนกดเปิด AI คืนในคอนโซล หรือสั่ง /reset = ห้องเริ่มรอบใหม่ ใบ้จากบทสนทนาก่อนหน้าจึง
 * ต้องมองไม่เห็น ไม่งั้นข้อความแรกหลังเปิดคืนอาจถูกปิดซ้ำด้วยใบ้เก่าทันที (ลูปที่คนกู้ไม่ทัน)
 * เก็บใน settings ไม่ใช่คอลัมน์ใหม่ — resetCustomer กวาดคีย์รูปแบบ `<ชื่อ>:<id>` ให้เองอยู่แล้ว
 */
export const handoffHintResetKey = (customerId) => `handoff_hint_reset:${customerId}`;

/** ปักหมุดว่า "ใบ้ย้อนหลังเริ่มนับใหม่เดี๋ยวนี้" (เรียกจากคอนโซลและจาก /reset) */
export function stampHandoffHintReset(db, customerId, nowMs = Date.now()) {
  try {
    db.setSetting(handoffHintResetKey(customerId), String(nowMs));
    return true;
  } catch {
    return false;
  }
}

// กติกาเดียวของ "โน้ตส่งต่อที่เข้าพรอมต์ได้" — เส้นตอบปกติและ YOLO (yoloPrompt.mjs) ใช้ตัวเดียวกัน
// (2026-09-28 ย้ายออกมาจาก baseRules โดยไม่เปลี่ยนเงื่อนไข เพื่อไม่ให้สองเส้นกรองต่างกัน)
export function promptSafeHandoffNotes(handoffNotes = []) {
  return (Array.isArray(handoffNotes) ? handoffNotes : []).filter((note) => !(
    note?.author === PROMISE_NOTE_AUTHOR
  ) && !(
    note?.author === "ai_auto" &&
    /^Opportunity\s+[a-z_]+\s+พร้อมส่งต่อทีมแล้ว:/u.test(String(note?.text || ""))
  ) && !(
    // โน้ต "สนใจเอกสารก่อนซื้อ" เกิดจากเส้นทางของเทิร์นนี้เอง ไม่ใช่คำของทีมงาน — ถ้าวนกลับ
    // เข้าพรอมต์ ลูกแพรจะอ่านคำของตัวเองเป็น "บันทึกจากทีมงาน" (โรคเดียวกับโน้ตผู้รักษาสัญญา)
    note?.author === "ai_auto" && String(note?.text || "").startsWith(DOC_PRESALE_NOTE_PREFIX)
  ) && !(
    // F4b/F5 (ตรวจย้อนหลัง ก.ย. 2026): โน้ตหยุดเงียบ/ไฟล์แนบเป็นเสียงของไปป์ไลน์ ไม่ใช่คำของทีมงาน
    note?.author === "ai_auto" && PIPELINE_TEAM_NOTE_PREFIXES.some((prefix) => String(note?.text || "").startsWith(prefix))
  ));
}

/**
 * รูปที่จะเสนอในเทิร์นนี้ (หรือ null) — ใช้ทั้งตอนประกอบพรอมต์ (baseRules) และตอนตรวจหลังโมเดลตอบ
 * 2026-10-03: แยกออกมาจาก baseRules เพื่อให้สองจุดตัดสินจากตรรกะเดียวกันเสมอ
 * (พี่ง้วงทดลอง "สนใจ Private Class" แล้วไม่ได้รูป — โมเดลข้ามโปสเตอร์แม้พรอมต์สั่งให้ใส่)
 * @returns {{key: string, explicitAsk: boolean, mustAttach: boolean, servicePoster: boolean} | null}
 *   servicePoster = ลูกค้าเอ่ยชื่อบริการเองแบบไม่กำกวม — ระบบแนบให้เองถ้าโมเดลลืม
 */
// คำสั่งพี่ง้วง 2026-10-04 ("ส่งรูปบ่อยหน่อย หลัง ๆ เห็นแต่แชท จะได้ดู humanize"): ช่วง nurture ที่ลูกค้าเล่าโจทย์
// หรือกังวลว่าเรียนได้ไหม ไม่มีคำในตัวจับรูปเดิมเลย จึงไม่เคยได้รูป — ทีมจริงส่งโปสเตอร์คลาสตอนแนะนำ และรูปห้องเรียน
// จริงตอนลูกค้าไม่มั่นใจ · เปิดเฉพาะสวิตช์ natural_voice_mode · แต่ละรูปยังส่งครั้งเดียวต่อห้อง (ตัวกันซ้ำเดิม)
// พี่ง้วง (ต่อ): "อยากให้รีวิวคนจริงขึ้นก่อน บรรยากาศในคลาส" — รูปห้องเรียนเฉพาะห้องที่เคยได้ลิงก์รีวิวแล้ว
// (เทิร์นที่ยังไม่เคยได้รีวิว ตัวเลือกหลักฐาน reviewJourney ส่งรีวิวคนจริงให้ก่อน)
// 19 ต.ค. 2026: ตัวอย่างระบบที่ทำด้วย AI Agent ไม่ใช่รีวิวคนจริง — ไม่นับเป็น "เคยได้รีวิวแล้ว"
/** บริบทลูกค้าที่กดมาจากหน้าเว็บสำหรับเครื่องเดิม — อ่านการ์ดพัง = ไม่มีบริบท (ตอบได้ตามปกติ) */
function legacyArrivalNote({ brain, db, customer, text, history, approvedKnowledge }) {
  try {
    const entries = knowledgeEntriesFor({ brain, db, channelId: customer?.channel_id || "default" });
    return arrivalNoteFor({ text, history, entries, knowledgeText: approvedKnowledge || "" });
  } catch {
    try { return arrivalNoteFor({ text, history, knowledgeText: approvedKnowledge || "" }); } catch { return ""; }
  }
}

export function reviewLinkShared(history = [], sentReviewUrls = null) {
  const isReview = (key) => Boolean(key) && !isShowcaseUrlKey(key);
  if ([...(sentReviewUrls || [])].some((url) => isReview(reviewUrlKey(url)))) return true;
  return history.some((turn) => turn?.role === "assistant"
    && (String(turn.content || "").match(/https:\/\/[^\s<>]+/gu) || []).some((url) => isReview(reviewUrlKey(url))));
}
function nurtureImageOffer({ currentText, history, allowedImages, sentImageKeys, sentAtmosphereKeys, reviewsShared }) {
  const atmosphereSeen = new Set([...(sentImageKeys || []), ...(sentAtmosphereKeys || [])]);
  if (CONFIDENCE_TURN.test(currentText)) {
    if (!reviewsShared) return null;
    const key = ATMOSPHERE_IMAGES.find((item) => allowedImages.has(item) && !atmosphereSeen.has(item));
    if (key) return { key, explicitAsk: false, mustAttach: false, servicePoster: false, nurture: "confidence" };
  }
  // รู้โจทย์แล้ว = จังหวะแนะนำคลาส — โปสเตอร์ของคลาสที่ตัวจัดเส้นทางเลือก (กฎกันเทราคาออนไลน์เดิมยังใช้)
  const goal = learningGoal({ text: currentText, history });
  if (!goal) return null;
  const { product } = resolveClassRouting({ text: currentText, history });
  const posterProduct = goal.kind !== "automation" && product === "workflow_automation_or_higher" ? "ai_agent_for_business" : product;
  const key = suggestImageKey("", posterProduct, allowedImages);
  if (!key || (sentImageKeys || []).includes(key)) return null;
  if (key === "online-custom-gpts" && liveClassInterest({ text: currentText, history })) return null;
  return { key, explicitAsk: false, mustAttach: false, servicePoster: false, nurture: "recommend" };
}

export function decideImageOffer({ currentText = "", history = [], allowedImages = new Set(), sentImageKeys = [], sentAtmosphereKeys = [], closingTurn = false, careMode = null, nurture = false, reviewsShared = false } = {}) {
  // White-label: ตัวเลือกรูปผูกกับคีย์โปสเตอร์คลาสของพี่ง้วง — โปรไฟล์ generic ไม่บังคับ/ไม่เสนอรูปอัตโนมัติ
  if (isGenericProfile(activeBrand())) return null;
  // ลูกค้าบอกไม่เอารูปในข้อความนี้ = ไม่เสนอรูปใด ๆ (รีวิวรอบ 4: เดิมพรอมต์ยังบอกโมเดลว่าแนบได้)
  if (explicitPosterNegated(currentText)) return null;
  const explicitAsk = customerAsksForImage(currentText);
  // 2026-10-03: ลูกค้าเอ่ยชื่อบริการเอง ("Flash consult คืออะไร" / "มีคลาสออนไลน์ไหม") ก็เป็นเทิร์นที่ควรมีรูป
  const namedPoster = namedServicePoster(currentText, allowedImages);
  if (!explicitAsk && !IMAGE_WORTHY_TURN.test(currentText) && !namedPoster) {
    return nurture && !closingTurn && !careMode
      ? nurtureImageOffer({ currentText, history, allowedImages, sentImageKeys, sentAtmosphereKeys, reviewsShared })
      : null;
  }
  const { product } = resolveClassRouting({ text: currentText, history });
  const goal = learningGoal({ text: currentText, history });
  // Stage alone must not silently choose a course poster. Explicit course/image asks
  // still win in suggestImageKey; this only bounds the inferred-product fallback.
  const posterProduct = goal ? (goal.kind !== "automation" && product === "workflow_automation_or_higher"
    ? "ai_agent_for_business" : product) : null;
  // v1.4.9: รูปบรรยากาศ dedup แบบ all-time ข้ามเส้น (reactive+staged FU ใช้แหล่งเดียว)
  // — เดิม reactive อ่านแบบ session-scoped 7 วัน พอ session rotate (/reset) จะมองไม่เห็น
  // รูปที่ staged FU ส่งใน session ก่อน แล้วส่งซ้ำ. กันเฉพาะคีย์ atmosphere ไม่แตะรูปอื่น
  // (กันบั๊กเก่า v1.4.1 ที่รูปจาก session เก่าบล็อกบทสนทนาใหม่)
  const atmosphereSeen = new Set([...(sentImageKeys || []), ...(sentAtmosphereKeys || [])]);
  const suggested = suggestImageKey(currentText, posterProduct, allowedImages, { sentKeys: [...atmosphereSeen] });
  // ห้ามเสนอรูปที่เพิ่งส่งไปแล้ว เว้นแต่ลูกค้าขอเอง (กติกาเดิมของตัวกันรูปซ้ำ)
  const alreadySent = ATMOSPHERE_IMAGES.includes(suggested)
    ? atmosphereSeen.has(suggested)
    : (sentImageKeys || []).includes(suggested);
  // 2026-10-03: โปสเตอร์คลาสออนไลน์ของจริงมี 4,900 ตัวใหญ่ — ลูกค้าที่สนใจ/คุยเส้นสอนสดห้ามได้รูปนี้
  // (คือการเทราคาออนไลน์เดี่ยวให้ downgrade เอง — กติกา v1.4.9 เคสเสียเงินจริง) เว้นแต่ขอรูปเองจริง ๆ
  // รีวิว: ต้นกรวยยังไม่มีเลขราคาสอนสดในประวัติ จึงนับคำของลูกค้าที่พูดถึงสอนสดด้วย และ "ภาพรวม" ไม่ใช่การขอรูป
  const onlineDowngrade = suggested === "online-custom-gpts" && !explicitPosterAsk(currentText)
    && liveClassInterest({ text: currentText, history });
  if (!suggested || (!explicitAsk && alreadySent) || onlineDowngrade) return null;
  // 2026-10-03 (พี่ง้วงทดลอง "สนใจ Private Class" แล้วไม่ได้รูป): ลูกค้าเอ่ยชื่อบริการเอง =
  // โปสเตอร์บริการนั้นภาคบังคับ ยกเว้นเทิร์นปิดท้ายส่งต่อทีม และโหมดดูแลใจลูกค้า
  const servicePoster = namedPoster === suggested && !closingTurn && !careMode;
  // v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): เทิร์นแนะนำรายละเอียดคลาส = โปสเตอร์คลาส
  // เป็นภาคบังคับ ไม่ใช่ทางเลือก (replay จริงพบโมเดลข้ามรูปเมื่อภาษาปล่อยให้เลือก)
  const mustAttach = (COURSE_POSTER_KEYS.has(suggested) && COURSE_DETAIL_TURN.test(currentText)) || servicePoster;
  return { key: suggested, explicitAsk, mustAttach, servicePoster };
}

export function baseRules(intent, inboundFlags, { customer = null, currentText = "", continuation = null, askedQuestions = [], history = [], trainingMockMode = false, burstCount = 1, sentImageKeys = [], sentAtmosphereKeys = [], handoffNotes = [], customerTags = [], productRules = "", salesPolicy = null, salesState = null, approvedImageKeys = null, hasApprovedFacts = false, roundFacts = [], seatRules = [], priceDisclosure = null, approvedAmounts = null, scoreSignals = null, presetButton = null, handoffIntent = null, closingQuestion = false, adWelcomeQuestion = "", nurtureImages = false, reviewsShared = false, orderMode = "shipping", arrivalNote = "" } = {}) {
  // จังหวะราคาตัดสินครั้งเดียวต่อเทิร์น แล้วส่งคำตัดสินเดียวกันให้ตัวประกอบทุกตัว —
  // ห้ามให้ตัวไหนตัดสินเอง ไม่งั้นพรอมต์ก้อนเดียวจะมีคำสั่งเรื่องราคาสวนกันเหมือนเดิม
  const projectOpportunity = resolveProjectOpportunity({ currentText, salesPolicy, salesState });
  // คำสั่งพี่ง้วง 2026-09-05: ตอบครั้งเดียวว่าเทิร์นนี้เป็นการส่งไม้ต่อไหม แล้วส่งคำตอบ
  // เดียวกันให้ตัวประกอบทุกตัว — ตัวไหนตัดสินเองเมื่อไหร่ พรอมต์ก้อนเดียวจะสวนกันทันที
  // 2026-09-28 (audit ก.ย. §6.3): งาน project ที่ข้อความนี้ทำให้ส่งต่อได้ (scorer จะปิด AI หลังตอบ)
  // ก็เป็นเทิร์นปิดท้ายเช่นกัน — ตัวประกอบทุกตัวต้องหยุดสั่งให้ถาม (ตัวตัดสินอยู่ที่ handoffClosing.mjs)
  const projectHandoff = predictProjectHandoff({ salesPolicy, salesState, text: currentText, history });
  const closingTurn = isClosingHandoffTurn(handoffIntent, projectOpportunity) || Boolean(projectHandoff);
  const disclosure = priceDisclosure
    || decidePriceDisclosure({ text: currentText, history, score: Number.isInteger(customer?.last_score) ? customer.last_score : null, knownName: customer?.known_name || "", customer, inboundFlags, approvedAmounts, scoreSignals, projectOpportunity, presetButton, closingTurn });
  // คำสั่งพี่ง้วง 13 ก.ย.: คำถามปิดท้ายทุกคำตอบ (สวิตช์ reply_closing_question อ่านที่ไปป์ไลน์) —
  // ไม่ใช้กับ: เส้นเงิน (ห้องรอโอน = ห้ามเร่ง/ทวงโอน · คำถามเอกสารก่อนซื้อ) และห้องที่ลูกค้าเพิ่งบอกว่า
  // ถูกถามมากไปในไม่กี่เทิร์นก่อน (salesMotion: ห้ามถามจนกว่าเขาจะถามกลับเอง) — คงถ้อยคำเดิมทุกไบต์
  // ข้อยกเว้นระดับข้อความ (ขอบคุณ/ส่งไม้ต่อ/คัดกรอง ฯลฯ) อยู่ที่ closingQuestionTurn ใน conversationStyle.mjs
  const closingQuestionOn = closingQuestion === true && intent !== "document_presale"
    && !isBankInfoConversation(customer) && !hasRecentFatigue({ text: currentText, history });
  const rules = [
    "กติกาที่ห้ามละเมิดเด็ดขาด:",
    ...replyLeadContext(customer).split("\n").map(line => priceRule("neutral", line)),
    ...buildReplyFocusRules({ text: currentText, history, closingTurn, careMode: disclosure.careMode, adWelcomeQuestion }).map(line => priceRule("neutral", line)),
    // v1.2.5: ในโหมดเทรน ปลายทางของกฎนี้ต้องเป็น "ยกตัวอย่างพร้อมป้าย" ไม่ใช่ "รอทีมงาน"
    // ไม่งั้น prompt เดียวกันมีสองคำสั่งขัดกัน แล้วโมเดลเลือกข้างที่อยู่ใต้หัวข้อ "ห้ามละเมิด"
    // 2026-09-04 (ตรวจปรปักษ์): ท่อนท้าย "ถ้าไม่มีข้อมูลให้บอกว่าขอเช็คกับทีมก่อน" เคยถูกยิง
    // ทุกเทิร์นแบบไม่มีเงื่อนไข ใต้หัวข้อ "กติกาที่ห้ามละเมิดเด็ดขาด" — รวมถึงเทิร์นคัดกรอง
    // ซึ่งแบนวลีนั้นด้วยชื่ออยู่ห่างกันไม่กี่บรรทัด ความล้มเหลว v1.4.39 ที่บันทึกไว้
    // ("ขอลูกแพรเช็คตัวเลขกับทีมงานอีกครั้งนะคะ") คือผลผลิตของบรรทัดนี้ตรง ๆ
    //
    // 2026-09-04 รอบที่ห้า: รอบก่อนแก้ผิดข้าง — วลีนั้นถูกเก็บไว้ใน "สาขา quote" ทั้งที่
    // เคสจริงที่พังคือเทิร์นแจ้งราคาพอดี (ลูกค้าต่อรองต่ำกว่าตารางที่อนุมัติ) และเทิร์นเดียวกัน
    // นั้นแบก "ห้ามหลบ ห้ามบอกให้รอทีมงาน" อยู่ด้วย = พรอมต์สวนกับตัวเอง
    // ตอนนี้ตัดทิ้งทุกเทิร์น: ตารางราคาที่อนุมัติคือคำตอบสุดท้าย ไม่มีใครให้เช็คเพิ่มจริง ๆ
    // ส่วนที่เป็นข้อห้าม (ห้ามแต่งตัวเลขเอง) จริงทุกเทิร์นและอยู่ครบทั้งสองฉบับเสมอ
    priceRule("neutral", trainingMockMode
      ? "- ห้ามแต่งตัวเลขราคาหรือส่วนลดแล้วอ้างว่าเป็นราคาจริง ถ้าไม่มีข้อมูล ให้ยกตัวอย่างพร้อมป้าย (ข้อมูลตัวอย่างระหว่างเทรนค่ะ ...) ห้ามบอกให้รอทีมงานยืนยัน"
      : "- ห้ามแต่งตัวเลขราคา ส่วนลด หรือคำนวณราคาใหม่เอง — ตัวเลขทุกตัวต้องมาจากตารางราคาที่อนุมัติแล้วเท่านั้น "
        + "และตารางนั้นคือคำตอบสุดท้าย ห้ามบอกว่าขอเช็คกับทีมก่อน"),
    "- ห้ามวินิจฉัยโรค ห้ามการันตีผลลัพธ์ ห้ามใช้คำเกินจริง",
    // v1.5.1 (probe-memory-05/06 + feedback ชมพู่): บอทเคยปฏิเสธสิ่งที่แอดมิน
    // เพิ่งรับปากลูกค้า และเคยยึดข้อตกลงรอบเก่าแทนรอบล่าสุด — สองกฎนี้คู่กับ
    // ป้าย [แอดมินทีมงานพิมพ์เอง] ที่ recentTurns ติดให้ใน db.mjs
    "- ข้อความในประวัติที่ขึ้นต้นด้วย [แอดมินทีมงานพิมพ์เอง] คือคำของทีมงานคนจริง ไม่ใช่ของคุณ — " +
      "สิ่งที่ทีมงานรับปากหรือตกลงกับลูกค้าไว้ถือเป็นข้อผูกพันของบริษัท ห้ามปฏิเสธ ห้ามตอบขัด " +
      "ห้ามบอกว่าไม่มีบริการนั้น แม้คลังความรู้จะไม่ได้พูดถึง — ถ้าไม่แน่ใจรายละเอียด ให้ยืนยันตามที่ทีมงานรับปาก " +
      "แล้วบอกว่าทีมงานดูแลเรื่องนี้ให้อยู่ค่ะ",
    "- ข้อตกลงเรื่องเดียวกันที่เปลี่ยนหลายรอบในประวัติ (เช่น เลื่อนวันเรียนหลายครั้ง) ให้ยึดครั้งล่าสุดเสมอ " +
      "และตอบด้วยค่าล่าสุดเท่านั้น ห้ามหยิบค่ารอบเก่าที่ถูกแทนที่ไปแล้วมาตอบ",
    // v1.4.1 (feedback พี่ง้วง): เดิมห้าม bullet เฉย ๆ ทำให้เนื้อหาหลายหัวข้อกลายเป็น
    // ประโยคพืดเดียว — รายการต้องขึ้นบรรทัดใหม่พร้อม emoji นำสายตา (รูปแบบเดียว
    // ที่รอดทุกชั้นของระบบ: humanizer ตัด -/•/เลขข้อทิ้ง แต่คง emoji นำบรรทัด)
    priceRule("neutral", "- ตอบแบบแชทสั้น ๆ ภาษาคนจริง ไม่ใช้ markdown และไม่ใช้เครื่องหมาย bullet (-, •, เลขข้อ) " +
    "— เนื้อหาหลายหัวข้อ (เช่น หัวข้อที่สอน ทางเลือก ราคาหลายรายการ) ให้ขึ้นบรรทัดใหม่ทีละรายการ " +
    "นำหน้าด้วย emoji ที่เข้ากับเนื้อหา ไม่ใช่เขียนต่อกันด้วยลูกน้ำยาว ๆ"),
    "- ถามกลับได้ครั้งละ 1 คำถามเท่านั้น",
    // v1.1 (เคสจริง: เบอร์ 9 หลัก/gmail.con หลุดผ่านการสรุป): ทวนข้อมูลจัดส่งทุกครั้ง
    // 7 ต.ค. 2026 โหมดคลาส (orderMode.mjs): ขายคลาส ไม่มีส่งของ — ขอแค่ข้อมูลผู้เรียน ที่อยู่เฉพาะลูกค้าขอเอกสาร
    orderMode === "class"
      ? "- เมื่อรับข้อมูลผู้เรียน (ชื่อ-นามสกุล เบอร์ อีเมล) ตรวจก่อนสรุปเสมอ: เบอร์มือถือไทยต้องมี 10 หลักขึ้นต้น 06/08/09, " +
        "อีเมลต้องรูปแบบถูก (ระวังโดเมนสะกดผิดเช่น gmail.con) — พบผิดหรือไม่ครบ ให้แจ้งจุดผิดแล้วขอใหม่อย่างสุภาพทันที; " +
        "คลาสไม่มีการจัดส่ง ห้ามขอที่อยู่จัดส่ง — ขอที่อยู่เฉพาะเมื่อลูกค้าขอใบกำกับภาษีหรือใบเสนอราคา"
      : "- เมื่อรับข้อมูลจัดส่ง ตรวจก่อนสรุปเสมอ: เบอร์มือถือไทยต้องมี 10 หลักขึ้นต้น 06/08/09, " +
        "ที่อยู่ต้องมีจังหวัดและรหัสไปรษณีย์ 5 หลัก, อีเมลต้องรูปแบบถูก (ระวังโดเมนสะกดผิดเช่น gmail.con) — " +
        "พบผิดหรือไม่ครบ ให้แจ้งจุดผิดแล้วขอใหม่อย่างสุภาพทันที ห้ามสรุปว่าข้อมูลถูกต้องทั้งที่ยังผิด",
    // v1.1 (พี่ง้วงสั่ง): ปิดการขายสำเร็จ = ขอบคุณให้เป็น — อย่าจบห้วน ๆ และอย่าขายต่อ
    "- เมื่อลูกค้าซื้อเสร็จสมบูรณ์ (ยืนยันออเดอร์/แจ้งโอนครบ/ข้อมูลครบแล้ว) ปิดบทสนทนาอย่างอบอุ่น: " +
      `ขอบคุณลูกค้าด้วยชื่อ บอกขั้นถัดไปสั้น ๆ (เช่น ${orderMode === "class" ? "ทีมงานตรวจยอดแล้วยืนยันที่นั่งในรอบเรียน" : "ทีมงานตรวจยอด/จัดส่งเมื่อไหร่"}) และชวนให้ทักมาได้เสมอ — ` +
      "ห้ามเสนอขายเพิ่มในจังหวะนี้ และไม่ต้องจบด้วยคำถาม",
  ];
  if (intent && intent !== "general") rules.push(`- บริบทเรื่องที่ลูกค้าถาม: ${intent}`);
  // เคสจริง 2026-09-05: ลูกค้าที่ยังไม่ได้จ่ายถามเรื่องใบเสร็จ/ใบกำกับ เคยโดนแม่แบบ
  // "รับเรื่องเอกสารการชำระเงินแล้วค่ะ" ปัดทิ้ง = คำถามปิดการขายถูกตอบด้วยความเงียบ
  // ตอนนี้ลูกแพรตอบเองได้ แต่ต้องไม่ข้ามเส้นที่อันตรายจริง (ยืนยันยอด / รับปากว่าออกเอกสารแล้ว)
  // ตรวจปรปักษ์ 2026-09-05: ถ้อยคำรุ่นแรกสั่งโมเดลว่า "ยังไม่มีการชำระเงินกับเรา" ซึ่งเป็น
  // การประกาศข้อเท็จจริงเรื่องเงินแทนลูกค้า — ระบบรู้แค่ว่า "ยังไม่พบรายการ" เท่านั้น
  // ห้องที่ได้เลขบัญชีมาจากริชเมนู/โพสต์/แอดมินพิมพ์เอง แล้วลูกค้าโอนจริง ก็ยังอ่านว่าไม่มีเงิน
  // ถ้าโมเดลเชื่อบรรทัดนั้น มันจะไปบอกคนที่เพิ่งโอนว่า "ยังไม่ได้ชำระ" ซึ่งแย่กว่าเงียบ
  if (intent === "document_presale") {
    rules.push(priceRule("neutral",
      "- ลูกค้าถามเรื่องเอกสาร/ใบเสร็จ/ใบกำกับภาษีโดยที่ระบบยังไม่พบรายการชำระเงินในห้องนี้: "
      + "ตอบข้อมูลทั่วไปจากคลังความรู้ได้ (เช่น ออกใบกำกับภาษีได้ ต้องใช้ข้อมูลอะไร) "
      + "ห้ามยืนยันยอดเงิน ห้ามบอกว่าออกเอกสารให้แล้ว "
      + "ถ้าลูกค้าบอกว่าโอน/จ่ายมาแล้ว ให้บอกว่าส่งต่อทีมงานตรวจสอบให้ "
      + "ห้ามยืนยันและห้ามปฏิเสธว่าเงินเข้าแล้วหรือยัง "
      + "และบอกว่าทีมงานจะดูแลเรื่องเอกสารให้ตอนสมัคร"));
  }
  if (inboundFlags?.includes("asks_diagnosis")) {
    rules.push("- ลูกค้ากำลังถามเชิงวินิจฉัย: ห้ามฟันธงโรค แนะนำให้ปรึกษาแพทย์/ผู้เชี่ยวชาญเท่านั้น");
  }
  if (inboundFlags?.includes("asks_discount")) {
    // ตรวจปรปักษ์ 2026-08-14: สาขาเดิมสั่ง "ขอเช็คกับทีมก่อน" สวนทาง override ใหม่
    // ทั้งที่ตารางมีแถวส่วนลดครบ — ส่วนลดที่อยู่ในแหล่งอนุมัติต้องแจ้งได้เลย
    // 2026-09-04: กฎนี้นั่งอยู่ใต้หัวข้อ "ห้ามละเมิดเด็ดขาด" จึงอ่านเป็นคำสั่งเด็ดขาด —
    // เดิมมันสั่งไล่ตัวเลขส่วนลดให้คนแปลกหน้าที่พิมพ์ "ลดหน่อยได้ไหม" มาเป็นข้อความแรก
    // สวนกับสาขาคัดกรองของ warmth ในพรอมต์ก้อนเดียวกัน
    if (disclosure.mode !== "quote") {
      rules.push(priceRule(["defer", "no_promo"],
        "- ลูกค้าขอส่วนลดตั้งแต่ยังไม่รู้จักกัน: รับรู้คำถามอย่างอบอุ่นและห้ามทำเป็นไม่ได้ยิน "
        + "แต่ยังไม่ต้องใส่ตัวเลขราคา ส่วนลด หรือโปรโมชั่นในเทิร์นนี้ — ขอถามคัดกรองหนึ่งข้อก่อนตามกติกาจังหวะราคา "
        + "แล้วรอบหน้าที่เขาถามอีก ระบบจะสั่งให้แจ้งตัวเลขทันทีเอง"));
    } else if (!disclosure.withPromo) {
      // 2026-09-04 (ตรวจปรปักษ์): สาขานี้เคยดูแค่ mode จึงสั่ง "ไล่ตารางส่วนลด/โปรโมชั่น"
      // ในเทิร์นงาน project ที่กติกาอื่นในพรอมต์เดียวกันสั่ง "ห้ามยกตารางโปรโมชั่นทั้งชุด"
      // — แกนโปรโมชั่นเป็นแกนของตัวเอง ไม่ใช่ผลพลอยได้ของ mode
      rules.push(priceRule("no_promo",
        "- ลูกค้าขอส่วนลด: งานลักษณะนี้ทีมผู้ดูแลเป็นผู้ออกใบเสนอราคาเสมอ จึงยังไม่ยกตารางโปรโมชั่นทั้งชุด "
        + "— รับรู้คำถามอย่างอบอุ่น แจ้งได้เฉพาะราคาเริ่มต้นจากแหล่งอนุมัติ แล้วบอกว่าส่วนลดจริงขึ้นกับ "
        + "จำนวนคน สถานที่ และเนื้อหา ซึ่งทีมงานจะประเมินให้หลังคุยรายละเอียด"));
    } else rules.push(hasApprovedFacts
      // 2026-09-04 (รอบที่ห้า): ท่อนท้ายเดิม "ถ้าไม่มีในแหล่งจึงบอกว่าขอเช็คกับทีมงาน" คือ
      // วลีเดียวกับความล้มเหลว v1.4.39 อีกฉบับหนึ่ง และมันยิงในเทิร์นที่ลูกค้า *ต่อรองราคา*
      // ซึ่งเป็นฉากของเคสจริงเป๊ะ ๆ — ตารางคือคำตอบสุดท้าย สิ่งที่ช่วยได้จริงคือสิทธิ์ที่มีอยู่
      ? priceRule("promo", "- ลูกค้าขอส่วนลด: แจ้งเฉพาะส่วนลด/โปรโมชั่นที่อยู่ในตารางราคาอนุมัติหรือคลังความรู้ตามนั้นเป๊ะ ๆ "
        + "ห้ามเสนอตัวเลขนอกแหล่ง และถ้าไม่มีส่วนลดอื่นในแหล่ง ให้ตอบอย่างอบอุ่นว่าราคานี้คือดีที่สุดที่มีอยู่แล้ว "
        + "ห้ามบอกว่าขอเช็คกับทีม — สิ่งที่เสนอแทนได้คือสิทธิ์มาเรียนตั้งแต่ 2 ท่าน สิทธิ์นักเรียนเก่า หรือการผ่อนชำระผ่านบัตรเครดิต")
      : trainingMockMode
        ? priceRule("neutral", "- ลูกค้าขอส่วนลด: ยกตัวอย่างเงื่อนไขที่เป็นไปได้พร้อมป้าย (ข้อมูลตัวอย่างระหว่างเทรนค่ะ ...) ห้ามบอกให้รอทีมงานยืนยัน")
        // ระยะห่างของคำปฏิเสธกับวลีต้องห้ามสำคัญ: ด่านมองย้อนกลับได้ไม่เกินหนึ่งอนุประโยค
        // จึงต้องแปะ "ห้าม" ไว้หน้าวลีต้องห้ามทีละวลี ไม่ใช่ห้ามทีเดียวแล้วไล่รายการยาว ๆ
        : priceRule("neutral", "- ลูกค้าขอส่วนลด: ห้ามเสนอตัวเลขส่วนลดเอง ห้ามบอกให้รอทีมงาน และห้ามบอกว่าขอเช็คกับทีม "
          + "— ตอบด้วยสิ่งที่มีในแหล่งอนุมัติเท่านั้น แล้วเสนอสิทธิ์ที่ตรวจสอบได้จริง (มาเรียนตั้งแต่ 2 ท่าน สิทธิ์นักเรียนเก่า หรือการผ่อนชำระผ่านบัตรเครดิต)"));
  }

  // F2: LINE display name is UI metadata, not a verified personal name.
  // Only a name explicitly supplied in chat may enter the customer-facing prompt.
  // v1.2.3 (คำสั่งพี่ง้วง 2026-08-12): เรียกลูกค้าด้วยชื่อได้ — ชื่อที่ลูกค้าบอกเองมาก่อน
  // ถัดมาคือชื่อโปรไฟล์ LINE ที่ถอด emoji แล้วและผ่านการตรวจว่า "ดูเหมือนชื่อคน"
  // ชื่อที่เป็นคำกลอน ประโยคยาว ชื่อร้าน หรือคำสุ่มเสี่ยง จะกลายเป็น "คุณลูกค้า" อัตโนมัติ
  // 2026-09-28 (audit ก.ย. §4.2): ชื่อต้นคำเดียว (ไม่มีนามสกุล/คำนำหน้าทางการ/handle) และพักการ
  // เรียกชื่อหลังเพิ่งเรียก — ตัวตัดสินเดียวกับด่านหลังร่างใน respondToBurst (customerAddress.mjs)
  const addressPlan = planCustomerAddress({
    knownName: customer?.known_name || "",
    displayName: customer?.display_name || "",
    history,
  });
  const addressLabel = addressPlan.label;
  // v1.2.4 (เคสจริง 2026-08-13: display name ใช้ได้แต่บอทไม่เรียกชื่อเลยสักครั้ง):
  // กติกาเดิมบอกแค่ "ไม่ต้องเรียกทุกประโยค" ซึ่งโมเดลตีความเป็น "ไม่ต้องเรียกเลยก็ได้"
  // ต้องระบุจังหวะที่ "ต้องเรียก" ให้ชัด แล้วค่อยบอกว่าจังหวะอื่นไม่ต้อง
  const firstContact = !Array.isArray(history) || history.length === 0;
  // 2026-10-03 (พี่ง้วง: แชทแข็งเกินไป): ห้องที่ไม่มีชื่อเรียกได้ ไม่สั่งให้เรียก "คุณลูกค้า" อีก
  rules.push(addressPlan.generic ? genericAddressRule() :
    `- ชื่อที่ใช้เรียกลูกค้าคนนี้คือ "${addressLabel}" — ใช้คำนี้ตรงตัว ห้ามดัดแปลงหรือเดาชื่ออื่น` +
    (firstContact && addressLabel !== "คุณลูกค้า" ? " และข้อความแรกที่ทักกลับต้องมีชื่อนี้อยู่ด้วยเสมอ" : "") +
    (addressPlan.mayUseName
      ? "\n- ต้องเรียกชื่อลูกค้าในจังหวะทักทาย จังหวะเสนอทางเลือก และจังหวะชวนตัดสินใจ " +
        "ส่วนประโยคอื่น ๆ ไม่ต้องเรียกซ้ำ และห้ามถามชื่อลูกค้าเพื่อหาเรื่องคุยต่อ"
      : `\n${nameRestRule(addressPlan)}`)
  );
  // 2026-09-04: ตัวประกอบตัวที่ห้าก็ต้องได้รับคำตัดสินก้อนเดียวกัน — ก่อนหน้านี้มันไม่รับ
  // พารามิเตอร์จังหวะราคาเลยสักตัว แล้วปล่อยคำสั่ง "ตอบราคา/ส่วนลด/สิทธิ์นักเรียนเก่า"
  // ลงไปในทุกพรอมต์ รวมถึงเทิร์นคัดกรองที่เพิ่งสั่งห้ามใส่ตัวเลขไปเมื่อไม่กี่บรรทัดก่อน
  rules.push(buildConversationStyleRules({
    text: currentText, customer, continuation, askedQuestions, burstCount,
    history, leadScore: Number.isInteger(customer?.last_score) ? customer.last_score : null,
    inboundFlags, priceDisclosure: disclosure, approvedAmounts,
    // 2026-09-04: ข้อเท็จจริง "ข้อความนี้มาจากปุ่มสำเร็จรูป" (presetButtons.mjs) — ตัวประกอบ
    // สไตล์เป็นคนบอกโมเดล ส่วนคำตัดสินข้างบนได้ก้อนเดียวกันไปแล้ว
    presetButton,
    closingTurn,
    closingQuestion: closingQuestionOn,
  }));
  // v1.4.52 (คำสั่งเจ้าของ 2026-08-28): ลูกค้าที่ทักมาด้วย #hashtag จากงานสัมมนา/บูธ
  // มักพิมพ์แค่คำเดียวเป็นข้อความแรก ระบบไม่มีอะไรให้อ้างอิงเลย และเคยตอบผิดบริบท
  // โน้ตนี้ทีมงานเป็นคนเขียนไว้ล่วงหน้า ต้องส่งเป็น "บริบทที่รู้มา" ไม่ใช่คำพูดของลูกค้า
  // 19 ต.ค. 2026: ลูกค้ากดปุ่มทักไลน์จากหน้าเคส/หน้ารีวิวบนเว็บ (showcaseArrival.mjs) — ผู้เรียกคำนวณจากข้อความ+การ์ด
  if (arrivalNote) rules.push(`- ${arrivalNote}`);
  if (customer?.hashtag_note) {
    rules.push(
      `- ที่มาของลูกค้ารายนี้ (ทีมงานบันทึกไว้ ลูกค้าไม่ได้พูดเอง): ${truncateCodePoints(String(customer.hashtag_note), 600)}`
      + " ใช้เป็นบริบทตั้งต้นได้ แต่ห้ามพูดเหมือนลูกค้าเล่าให้ฟัง และห้ามเดาต่อเกินจากนี้",
    );
  }
  // v1.2.2 (คำสั่งพี่ง้วง): คะแนนความสนใจต้องมีผลกับ "จังหวะที่ส่งอะไรต่อ" จริง ๆ
  // ไม่ใช่แค่ตัวเลขในหน้า console — โดยเฉพาะจังหวะเปิดราคา
  rules.push(...buildWarmthRules({
    score: Number.isInteger(customer?.last_score) ? customer.last_score : null,
    text: currentText,
    knownName: customer?.known_name || "",
    trainingMockMode,
    // v1.4.6: จังหวะราคาต้องรู้ว่า "เคยเล่าข้อมูลคลาสไปแล้วหรือยัง" จาก history จริง
    history,
    customer,
    inboundFlags,
    priceDisclosure: disclosure,
    approvedAmounts,
    closingTurn,
    closingQuestion: closingQuestionOn,
  }));
  // v1.2.3: จังหวะการขายอ่านจากสัญญาณซื้อสด ไม่ต้องรอ scorer (คะแนนช้ากว่าบทสนทนาเสมอ)
  // v1.3: แผนผังเลือกคลาสจากคู่มือแอดมินคนจริง — ระดับการใช้ AI และจำนวนผู้เรียน
  // เป็นตัวตัดสินคลาส ไม่ใช่ให้โมเดลเดาเอง
  // White-label: แผนผังเลือกคลาส (PRODUCT_GUIDANCE/recommendProduct) เป็นของธุรกิจคอร์สเท่านั้น
  const genericProfile = isGenericProfile(activeBrand());
  if (!genericProfile) rules.push(...buildClassRoutingRules({ text: currentText, history, priceDisclosure: disclosure, approvedAmounts, closingTurn }));
  // v1.3.4: ผูกภาพกับบริการที่กำลังคุยอยู่โดยตรง — รูป 5 จาก 7 ใบไม่มี pack entry ไหน
  // อ้างถึงเลย จึงไม่มีวันถูกเสนอถ้าพึ่งการจับคู่การ์ดอย่างเดียว
  if (!genericProfile && (Array.isArray(approvedImageKeys) || approvedImageKeys instanceof Set)) {
    const allowedImages = approvedImageKeys instanceof Set ? approvedImageKeys : new Set(approvedImageKeys);
    // v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): ข้อความแรกต้องแนบอินโฟกราฟิกบันได 7 Stage
    // คู่กับคำถามคัดกรองเสมอ — persona ชี้มาที่กติกานี้ ("ถ้าระบบแจ้งว่ามีรูปนี้ให้ใช้")
    // ข้อ 17 ของการตรวจปรปักษ์ 2026-09-05: บรรทัดนี้สั่งแนบคำถามคัดกรอง "เสมอ" ในข้อความแรก
    // ส่วนกติกาส่งไม้ต่อข้างล่างสั่ง "ห้ามถามคำถามคัดกรองเพิ่ม" — ลูกค้าที่จองตั้งแต่ข้อความแรก
    // ("ขอจองไว้ก่อนค่ะ" เป็นข้อความเปิดห้อง เกิดจริงจากโฆษณา) จึงเคยได้คำถามที่ไม่มีวันมีใคร
    // อ่านคำตอบ เพราะห้องถูกส่งต่อไปแล้วในวินาทีถัดมา
    // 2026-09-28: คำตอบเปิดห้อง ("ยังครับ" / "3") คือลูกค้าตอบคำถามต้อนรับในโฆษณาไปแล้ว —
    // ส่งบันไดถามระดับซ้ำคือถามคำถามที่เขาเพิ่งตอบ (กติกาของเทิร์นนี้อยู่ที่ buildReplyFocusRules)
    // soul v1.1 C6 (20 ต.ค. 2026): เปิดเรื่อง LINE / Facebook / ที่ปรึกษา / วางระบบ = Private หรือที่ปรึกษา ไม่ใช่การวัดระดับ AI — ไม่ส่งบันได
    const ladderRule = firstContact && !closingTurn && !disclosure.careMode && allowedImages.has("ai-stage-ladder")
      && !isOpeningShortAnswer({ text: currentText, history }) && !NON_AI_SERVICE_TOPIC.test(String(currentText || ""));
    if (ladderRule) {
      rules.push(
        "- ข้อความแรกเท่านั้น: แนบรูปบันได 7 Stage ด้วย marker [IMAGE:ai-stage-ladder] "
        + "ไว้ในข้อความเดียวกับคำถามคัดกรองระดับการใช้ AI เสมอ (ใบเดียวพอ ห้ามส่งรูปนี้ซ้ำในเทิร์นหลังจากนี้)"
      );
    }
    // 2026-10-03: ตัดสินด้วย decideImageOffer ตัวเดียวกับที่ตรวจหลังโมเดลตอบ (โปสเตอร์ภาคบังคับที่ลืมแนบ)
    const offer = decideImageOffer({
      currentText, history, allowedImages, sentImageKeys, sentAtmosphereKeys,
      closingTurn, careMode: disclosure.careMode, nurture: nurtureImages, reviewsShared,
    });
    if (offer) {
      rules.push(imageOfferRule(offer.key, {
        explicitAsk: offer.explicitAsk, mustAttach: offer.mustAttach, nurture: offer.nurture || "",
        alongsideLadder: ladderRule && offer.key !== "ai-stage-ladder",
      }));
    }
  }
  rules.push(...buildSalesMotionRules({
    text: currentText,
    history,
    leadScore: Number.isInteger(customer?.last_score) ? customer.last_score : null,
    addressLabel,
    // v1.4.9b (รีวิว 2026-08-17) เคยส่ง suppressDirectPriceAnswer ที่ผูกกับเคส pivot
    // สอนสด->online เคสเดียว — ตอนนี้ส่งคำตัดสินก้อนเดียวกับที่ warmth ใช้ ทั้งพรอมต์
    // จึงพูดเรื่องจังหวะราคาเป็นเสียงเดียวกันเสมอ (เคส pivot ยังชนะเป็นอันดับแรกเหมือนเดิม)
    priceDisclosure: disclosure,
    approvedAmounts,
    closingTurn,
  }));
  if (trainingMockMode) {
    rules.push(priceRule("neutral", brandText(
      "โหมดเทรนภายใน (ยังไม่ใช่ลูกค้าจริง): ถ้าข้อมูลที่ลูกค้าถามยังไม่มีในข้อมูลอ้างอิง " +
      "ให้ตอบด้วยตัวอย่างที่สมเหตุสมผลไปเลยเพื่อให้เห็นบทสนทนาทั้งเส้น ห้ามตอบว่าต้องรอทีมงานยืนยัน " +
      "และต้องปิดท้ายส่วนที่สมมติด้วยป้ายในวงเล็บว่า (ข้อมูลตัวอย่างระหว่างเทรนค่ะ รบกวนทีมงานพี่ง้วงเติมข้อมูลจริง: ระบุสิ่งที่ขาด) " +
      "ป้ายนี้ใช้ได้กับทุกเรื่องรวมถึงราคา โปรโมชั่น จำนวนที่นั่ง วันเรียน และรีวิว"
    )));
  }

  // B1: บอกโมเดลว่ารูปไหนส่งไปแล้ว — กันเลือก [IMAGE:key] ซ้ำตั้งแต่ต้นทาง
  // v1.2.1 (เคสจริงลูกแพร: ลูกค้าขอดูรูปอีกครั้งแล้วโดนปฏิเสธ "เคยส่งไปแล้ว" — robotic):
  // dedupe มีไว้กัน "บอทยัดรูปซ้ำเอง" ไม่ใช่กัน "ลูกค้าขอดูใหม่" — ขอเอง = ส่งซ้ำได้เสมอ
  if (sentImageKeys.length) {
    rules.push(
      `- รูปที่เคยส่งให้ลูกค้าแล้ว: ${sentImageKeys.join(", ")} — ` +
      "ไม่ต้องส่งซ้ำเองโดยลูกค้าไม่ได้ขอ แต่ถ้าลูกค้าขอดูรูปอีกครั้ง ให้ใส่ marker ส่งซ้ำได้ทันที " +
      "ห้ามตอบว่าเคยส่งไปแล้วหรือให้ลูกค้าเลื่อนกลับไปหาเอง"
    );
  }

  // B6: บันทึกส่งต่อจากทีมงาน (ล่าสุด 10 รายการ เก่า -> ใหม่) — บริบทที่ AI ต้องรู้ก่อนตอบ
  // Opportunity note ของ ai_auto เป็นข้อมูลสำหรับ staff UI เท่านั้น: มันเกิดจาก
  // candidate ของ scorer จึงห้ามวนกลับเข้า system prompt ในฐานะ "บันทึกจากทีมงาน".
  // โน้ตของคนจริงและ ai_auto ประเภทอื่นยังคงใช้ตามพฤติกรรมเดิม.
  // v1.4.26: โน้ต "ผู้รักษาสัญญา" เป็นใบสั่งงานของทีมงานล้วน ๆ ห้ามวนกลับเข้า prompt —
  // ไม่งั้นบอทจะอ่านคำพูดของตัวเองเมื่อกี้เป็น "บันทึกจากทีมงาน" แล้วเล่าขั้นตอนภายใน
  // ให้ลูกค้าฟัง (และโน้ตที่เปลี่ยนทุกเทิร์นยังทำให้ prompt cache เสียเปล่าด้วย)
  const promptSafeNotes = promptSafeHandoffNotes(handoffNotes);
  if (promptSafeNotes.length) {
    rules.push("บันทึกจากทีมงาน:");
    for (const note of promptSafeNotes) {
      rules.push(`- [${note.author || "ทีมงาน"}] ${note.text}`);
    }
  }

  // v1.1 (item 7): ป้ายลูกค้า (RFM/intent/คนติด) + กติกาสินค้าจากทีมงาน
  // — AI รู้ว่ากำลังคุยกับใคร ซื้ออะไรไปแล้ว และสินค้าไหนควร/ไม่ควรเสนอ
  // v1.4.31: ที่นั่งคงเหลือที่ทีมงานกรอกเอง — วางในกติกา ไม่ใช่คลังความรู้ โดยตั้งใจ
  // (คลังความรู้เป็นส่วนคงที่ที่ prompt cache จับไว้ ถ้าเอาตัวเลขที่แก้บ่อยไปไว้ตรงนั้น
  // การกรอกที่นั่งครั้งเดียวจะทำให้ค่าโมเดลของทุกบทสนทนาเด้งขึ้น)
  // ที่นั่งคงเหลือเป็น "ข้อเท็จจริงของรอบ" ไม่ใช่คำสั่งจังหวะราคา — แต่บรรทัดของรอบออนไลน์
  // เอ่ยคำว่า "ราคาพิเศษมีจำนวนจำกัด" จึงต้องประกาศข้างไว้ ไม่งั้นด่านความครบถ้วนจะเห็นเป็น
  // บรรทัดที่พูดเรื่องเงินโดยไม่มีข้าง (ซึ่งถูกต้องแล้วที่มันเห็น — ทุกบรรทัดต้องมีเจ้าของ)
  // 28 ก.ย. (พี่ง้วง: รอบเรียนกรอกที่หน้าที่นั่งที่เดียว): "วันนี้ + รอบที่ประกาศแล้ว" คือข้อเท็จจริงที่เดิมอยู่ใน
  // การ์ดคลังความรู้ (เห็นทุกเทิร์น) — ย้ายแหล่งแล้วต้องเห็นทุกเทิร์นเหมือนเดิม รวมจังหวะดูแล (ลูกค้าขอเลื่อนรอบ
  // ต้องรู้ว่ารอบไหนยังเปิด) ส่วนตัวเลขที่นั่งยังตัดในจังหวะดูแลเหมือนเดิม (ตัวตรวจโค้ด 28 ก.ย.)
  rules.push(...roundFacts.map((line) => priceRule("neutral", line)));
  if (!disclosure.careMode) rules.push(...seatRules.map((line) => priceRule("neutral", line)));
  rules.push(...composeTagRules({ tags: customerTags, productRules }));
  if (salesPolicy) {
    // reply prompt ได้เฉพาะสรุปธุรกิจ — ฉบับเต็ม (ภาษาสั่ง scorer) อยู่ใน scoring.mjs เท่านั้น
    rules.push(priceRule("neutral", renderSalesPolicyReplySummary(salesPolicy)));
    // v1.4.1 (เคสจริง 2026-08-14): ลูกค้าเอ่ยงาน project ("ให้ไปสอนที่บริษัท") แล้วบอท
    // เทราคาทั้งชุด + เข้าโหมดเอกสารเอง — sales state ช้าหนึ่งเทิร์น (scorer รันหลังตอบ)
    // จึงตรวจข้อความปัจจุบันตรงนี้เลย แล้วประกาศโหมดคัดกรองก่อนกฎราคาอื่นทั้งหมด
    // โหมดคัดกรองต้อง "ค้าง" ตลอดช่วงเก็บข้อมูล ไม่ใช่เฉพาะเทิร์นที่เอ่ยชื่องาน —
    // เคสจริง: เทิร์นบอกชื่อบริษัท (ไม่มีคำ in-house) บอทหลุดกลับไปเทราคาเต็มชุด
    const projectType = projectOpportunity;
    if (projectType) {
      const definition = salesPolicy.opportunities.find((item) => item.type === projectType);
      const knownSlots = salesState?.opportunity?.type === projectType
        ? Object.keys(salesState.opportunity.slots || {})
        : [];
      const missing = (definition?.requiredSlots || []).filter((slot) => !knownSlots.includes(slot));
      rules.push(...[
        priceRule("neutral", `ลูกค้ากำลังถามถึงงาน ${PROJECT_TYPE_LABEL[projectType] || projectType} ในข้อความนี้ — ` +
        "โหมดคัดกรองก่อนเสนอ (กติกาชุดนี้ชนะกติกาจังหวะราคาอื่นทั้งหมดในเทิร์นนี้):"),
        "- ยืนยันสั้น ๆ อย่างอบอุ่นว่ามีบริการนี้ และทีมงานผู้ดูแลโดยตรงจะออกแบบรายละเอียดให้ตรงโจทย์",
        // บล็อกนี้ประกาศตัวว่าชนะกติกาจังหวะราคาอื่นทั้งหมด และมันถูก push เป็นก้อนท้าย ๆ
        // จึงเป็นคำสั่งเรื่องราคาที่โมเดลอ่านทีหลังสุดจริง ๆ — ต้องพูดข้างเดียวกับคำตัดสินเสมอ
        // เทิร์นส่งต่อที่ลูกค้าไม่ได้ถามเรื่องเงิน = เงียบเรื่องราคาทั้งเทิร์น (เหมือนเทิร์นจอง)
        projectHandoff && disclosure.silent ? null : disclosure.mode === "quote"
          ? priceRule("no_promo", "- ห้ามยกตารางราคา ราคาโปร หรือค่าบริการเพิ่มเติมขึ้นเองทั้งชุด " +
            "ถ้าลูกค้าถามราคาตรง ๆ ให้บอกเฉพาะราคาเริ่มต้นหนึ่งตัวเลขจากแหล่งอนุมัติ " +
            "แล้วบอกว่าราคาจริงขึ้นกับจำนวนคน สถานที่ และเนื้อหา ทีมงานจะประเมินให้หลังคุยรายละเอียด")
          : priceRule(["defer", "no_promo"], "- ห้ามยกตารางราคา ราคาโปร หรือค่าบริการเพิ่มเติมขึ้นเองทั้งชุด " +
            "และยังไม่ต้องใส่ตัวเลขราคา ส่วนลด หรือโปรโมชั่นในเทิร์นนี้ " +
            "— บอกว่าราคาจริงขึ้นกับจำนวนคน สถานที่ และเนื้อหา ทีมงานจะประเมินให้หลังคุยรายละเอียด"),
        // เทิร์นที่ส่งต่อแล้วไม่มีเทิร์นหน้าให้เก็บข้อมูลต่อ — บรรทัดปิดท้ายของเทิร์นนี้อยู่ท้ายพรอมต์
        projectHandoff ? null : `- เก็บข้อมูลทีละหนึ่งคำถามต่อเทิร์น แทรกไปกับการคุยปกติ ตามลำดับที่ยังขาด: ${missing.join(", ") || "ครบแล้ว"}`,
        priceRule("neutral", "- ห้ามพูดเรื่องเอกสาร ใบเสนอราคา ใบแจ้งหนี้ ชื่อนิติบุคคล หรือหนังสือรับรองบริษัทในขั้นนี้ " +
        "— เรื่องเอกสารทั้งหมดเป็นงานของทีมงานคนจริงหลังติดต่อกลับ"),
        projectHandoff ? null : "- เมื่อได้เบอร์และช่วงเวลาสะดวกครบแล้ว ปิดอย่างอบอุ่นว่าทีมงานจะติดต่อกลับตามช่วงเวลาที่ลูกค้าสะดวก",
      ].filter((line) => line !== null));
    }
    // สถานะ opportunity สั่ง "ถาม slot ที่ขาดหนึ่งข้อ" — เทิร์นส่งต่อไม่มีใครตอบคำถามนั้นแล้ว
    if (salesState && !projectHandoff) rules.push("สถานะ opportunity ล่าสุด:", priceRule("neutral", renderSalesState(salesState)));
  }
  // ---- คำสั่งพี่ง้วง 2026-09-05: ใบ้ให้ลูกแพรตัดสินว่าถึงเวลาส่งไม้ต่อหรือยัง ----
  //
  // "ให้สุดท้าย ลูกแพร คุยได้ และ ส่งต่อให้ชมพู่ ... แต่ให้ปิด AI ตัวนั้นไปเลย"
  //
  // บรรทัดนี้ **ไม่ใช่** คำสั่งให้ปิดการขาย มันคือใบ้ว่า "ลูกค้ากำลังพูดเรื่องนี้อยู่" แล้วให้
  // ลูกแพรเป็นคนแยกเองว่าเขายืนยันแล้วหรือแค่ถาม — บทเรียนรอบแรกคือ regex แยกสองอย่างนี้
  // ไม่ออก แต่โมเดลที่อ่านทั้งบทสนทนาแยกออก และคำตอบของมันคือกุญแจดอกที่สองที่ปิดห้องจริง
  //
  // ถ้าเขายืนยันแล้ว เทิร์นนี้จะเป็นข้อความสุดท้ายที่ลูกแพรได้พูดในห้องนี้ จึงต้อง
  // (1) ตอบสิ่งที่เขาถามให้ครบ (2) ส่งไม้ต่อให้ชัดว่าใครจะมาต่อ (3) ไม่ถามคัดกรองเพิ่ม
  // เพราะจะไม่มีใครอ่านคำตอบนั้น (4) ห้ามอ้างว่าล็อกที่นั่งให้แล้ว — ระบบไม่มีตัวล็อกที่นั่ง
  // จริง (บทเรียน v1.4.37) · ถ้ายังไม่ยืนยัน ให้คุยต่อตามปกติและห้ามรับปากแทนทีมงาน
  // push ไปตรงท้ายสุดของก้อนโดยเจตนา: โมเดลอ่านคำสั่งท้ายสุดหนักที่สุด
  //
  // R1 (รอบสาม): บรรทัดนี้คือ **กติกาเดียว** ที่เกี่ยวกับการส่งไม้ต่อในพรอมต์ทั้งก้อน
  // ทุกบรรทัดอื่นที่รอบสองเพิ่มเข้ามาแบบไม่มีเงื่อนไข ("ห้ามปิดท้ายด้วยคำถามใด ๆ",
  // "ห้ามสำรวจโจทย์เพิ่ม", "ห้ามเสนอเส้นทาง/ขั้นถัดไป") ถูกถอดออกหมด เพราะมันบังคับให้
  // ลูกแพรเขียนประโยคส่งไม้ต่อ แล้วกุญแจดอกที่ 2 ก็ไม่มีอะไรให้ตัดสินอีก
  //
  // ประโยคส่งไม้ต่อถูกกำหนดคำต่อคำโดยเจตนา — กุญแจดอกที่ 2 (looksLikeHandoverReply)
  // ต้องอ่านมันออกอย่างแน่นอน และคนที่มาสอบทีหลังต้องเทียบสองฝั่งได้ด้วยตาเปล่า
  if (closingTurn && handoffIntent?.kind === "booking") {
    rules.push(brandText("- ลูกค้าเอ่ยถึงการจอง/สมัคร: ถ้าเขายืนยันชัดว่าจะจอง/สมัคร "
      + "(ไม่ใช่แค่ถาม สนใจเฉย ๆ หรือยังลังเล) ให้ตอบสิ่งที่ถามให้ครบ ขอบคุณ "
      + "แล้วปิดท้ายด้วยประโยคนี้เท่านั้น: "
      + "\"ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ\" "
      + "และไม่ถามคำถามคัดกรองเพิ่ม "
      // 2026-09-28 (audit ก.ย. §6.3): ปิดห้องแล้วคำถามที่ค้างในข้อความเดียวกันไม่มีใครตอบ — มีเงื่อนไข
      // "ถ้าส่งไม้ต่อ" เสมอ ไม่ใช่คำสั่งสวนทาง (กุญแจดอกที่ 2 ต้องยังเป็นการตัดสินใจของลูกแพร)
      + "(ถ้าส่งไม้ต่อด้วยประโยคข้างบน ข้อความนั้นต้องไม่มีคำถามเหลืออยู่เลย เพราะหลังจากนี้ไม่มีใครตอบคำถามนั้น) "
      + "· ถ้ายังเป็นคำถาม แค่สนใจ หรือยังลังเล ให้ตอบตามปกติและห้ามพูดว่าทีมงานจะติดต่อกลับ "
      + "· ห้ามพูดว่าลูกแพรล็อกที่นั่ง/จองให้แล้ว"));
  } else if (closingTurn && handoffIntent?.kind === "contact_team") {
    rules.push(brandText("- ลูกค้าเอ่ยถึงการติดต่อทีมงาน: ถ้าเขาขอให้ทีมงานติดต่อหรือขอช่องทางติดต่อ "
      + "ให้ตอบรับสั้น ๆ ด้วยประโยคนี้: "
      + "\"ลูกแพรส่งเรื่องให้ทีมงานคนจริงเข้ามาดูแลต่อในแชทนี้แล้วนะคะ\" "
      + "(แจ้งช่องทางได้ถ้าคลังความรู้ระบุ) และไม่ชวนคุยขายต่อ "
      + "(ถ้าส่งไม้ต่อด้วยประโยคข้างบน ข้อความนั้นต้องไม่มีคำถามเหลืออยู่เลย เพราะหลังจากนี้ไม่มีใครตอบคำถามนั้น) "
      + "· ถ้าเขาแค่เล่าว่าทีมงานเคยติดต่อไปแล้ว ขอบคุณทีมงาน หรือพูดถึงทีมของเขาเอง "
      + "ให้ตอบตามปกติ"));
  }
  if (projectHandoff) rules.push(projectHandoffClosingRule({ phoneKnown: projectHandoff.phoneKnown }));
  return rules.join("\n");
}

// งานออกแบบเฉพาะราย — โหมดคัดกรองก่อนเสนอ (คำสั่งพี่ง้วง 2026-08-14: ทีมงานคนจริงปิดเอง)
// ชุดชนิดงานย้ายไปอยู่ salesPolicy.mjs ที่เดียวแล้ว เพื่อให้แกนโปรโมชั่นใน priceDisclosure
// อ่านคำตอบเดียวกับที่ pipeline ใช้ประกาศโหมดนี้ (ของเดิมมีตัวจับคนละตัวแล้วสั่งสวนกัน)
const PROJECT_TYPE_LABEL = Object.freeze({
  in_house_training: "In-house Training",
  private_class: "Private Class",
  speaker_engagement: "งานวิทยากร",
});
// เหตุที่ปิด AI แบบ sticky เมื่อส่งต่องาน project — เขียนจากที่เดียว (maybeHandoffOpportunity)
// จึงใช้เป็นหลักฐานได้ว่า "ห้องนี้อยู่ระหว่างรอทีมงานรับช่วงต่อ"
export const HANDOFF_AI_OFF_REASON = "handoff_private_inhouse";
// เหตุปิดที่ "การส่งไม้ต่อให้ชมพู่" เขียนไว้ (คำสั่งพี่ง้วง 2026-09-05) — ห้องที่ปิดด้วย
// เหตุพวกนี้ถูกส่งต่อไปแล้วหนึ่งใบ ทีมไม่ควรถูกปลุกซ้ำ และเหตุปิดต้องไม่ถูกเขียนทับ
const CLOSING_HANDOFF_REASONS = new Set(["booking_handoff", "human_requested"]);
// ผู้ตรวจรอบสาม (ข้อ 6): ตั๋ว "ปลุกทีมงานเมื่อลูกค้าพิมพ์ต่อหลังห้องปิด" เดิมมีแต่กับงาน
// project ห้องที่ปิดเพราะจอง/ขอติดต่อทีมงานจึงเงียบสนิท ทั้งที่เป็นห้องที่ลูกค้า *มักจะ*
// พิมพ์ชื่อ/รอบ/วันโอนตามมาทันทีในนาทีถัดไป — เหตุปิดสามตัวนี้ใช้ตั๋วใบเดียวกันได้หมด
const HANDOFF_REPLY_WAKE_REASONS = new Set([HANDOFF_AI_OFF_REASON, ...CLOSING_HANDOFF_REASONS]);

export function createPipeline({
  config,
  db,
  hermes,
  jevFetch = globalThis.fetch,
  decisionReview = null,
  line,
  lineRegistry = null, // W3: multi-OA — ไม่ส่งมา = ใช้ line เดิมทุกเส้น (backward compatible)
  humanizer,
  guard,
  burst,
  controlGate,
  transcriber = null,
  slipCheck = null,
  imageClassify = null,
  inboundImageOutcome = null,
  notifier = null, // v1.1 (bug 5): push แจ้งทีมเมื่อลูกค้าต้องการคน — ไม่ส่งมา = ปิด
  persona = "",
  brandPack = "",
  safetyRules = [],
  identityTemplate = "",
  // 20 ต.ค. 2026 (คำตอบ C4 ข้อ 12): ถ้อยคำแจ้งโอนของร้าน — ว่าง = ค่ากลางของ safetyRouter
  paymentTemplate = "",
  imageCatalog = [],
  replyDeliveryPolicy = null,
  salesPolicy = null,
  // กรอบป้ายชุดเดียว (พี่ง้วงอนุมัติ 28 ก.ย. 2026) — null หรือสวิตช์ tag_framework_mode ปิด
  // = ป้าย AI แบบข้อความอิสระเดิมทุกไบต์ (อ่านสวิตช์สดทุกรอบผ่าน activeTagFramework)
  tagFramework = null,
  // boot id ของโปรเซสนี้ — ใช้บอกว่าเทิร์นที่ค้างอยู่เป็นของเราเองหรือของโปรเซสที่ตายไปแล้ว
  processId = "",
  // P2 (BRAIN_READ=versioned): ตัวอ่านสมองที่มีเวอร์ชัน — null = อ่านตารางเดิมทุกไบต์
  brainRuntime = null,
  // 11 ต.ค. 2026 แคมเปญ #AIAGENT (blueprintCampaign.mjs) — null หรือไม่มีแคมเปญที่เปิดอยู่ = เส้นเดิมทุกไบต์
  blueprintCampaign = null,
  // 12 ต.ค. 2026: ตีจบแชทนอกเรื่อง (offtopicClose.mjs — กุญแจสองดอก) — null = เส้นเดิมทุกไบต์
  offtopicCloser = null,
  now = Date.now,
  logger = console,
}) {
  // v1.4 Lifecycle เฟส 1 (shadow): เขียน facts/สถานะอย่างเดียว ไม่มีเส้นทางไหนอ่านเข้า prompt
  const lifecycle = createLifecycle({ db, salesPolicy, logger });
  const jevShadow = createJevShadow({ config, db, fetchImpl: jevFetch, now, logger });
  const jevReview = decisionReview || createJevDecisionReview({ config, db, fetchImpl: jevFetch, now, logger });
  function markJevApplied(result) {
    if (result?.id && result.mode === "enforce") {
      return db.raw.prepare("UPDATE jev_decision_reviews SET applied=1 WHERE id=? AND applied=0").run(result.id).changes === 1;
    }
    return false;
  }
  // JEV's customer-impacting decisions are intentionally independent from the
  // draft-quality action.  A low-confidence / unavailable judge may require a
  // safe reply, but must not manufacture a queue item, a push, or an AI-off
  // state.  Deterministic money, manual, urgent, and explicit-human routes are
  // handled before this helper and remain stronger than any JEV verdict.
  function jevChoiceAtThreshold(result, key, choice) {
    const check = result?.checks?.[key];
    return result?.mode === "enforce"
      && ["reviewed", "cached"].includes(result?.status)
      && check?.choice === choice
      && Number.isFinite(check.confidence)
      && check.confidence * 10 >= config.jevReviewThreshold;
  }
  const shouldContinueJev = (result) => jevChoiceAtThreshold(result, "stop", "continue");
  // Older DBs and direct unit calls may not have a canonical inbound row.  In
  // that case provenance stays unavailable; never guess or backfill it.
  function safeLatestInboundMessageId(customerId) {
    try { return db.latestInboundMessageId?.(customerId) || ""; } catch { return ""; }
  }
  // งานของลูกค้าคนเดียวกันวิ่งทีละงาน — กัน reply สอง burst สลับลำดับ/ซ้อนกัน
  const queue = createKeyedQueue();
  // Deterministic safety messages must not sit behind an expensive Hermes call.
  // They still use the same customer queue for DB/LINE ordering; ingress only
  // aborts the active draft and flushes any debounce that currently owns it.
  // A LINE request that already started is never aborted/retried because its
  // provider outcome is ambiguous; safety runs immediately after that boundary.
  const pendingPrioritySafety = new Map(); // customerId -> queued/active safety tasks
  const activeReplyDrafts = new Map(); // customerId -> AbortController for Hermes reply only
  function bumpPrioritySafety(customerId, delta) {
    const next = (pendingPrioritySafety.get(customerId) || 0) + delta;
    if (next <= 0) pendingPrioritySafety.delete(customerId); else pendingPrioritySafety.set(customerId, next);
  }
  function prioritySafetyPending(customerId) {
    return (pendingPrioritySafety.get(customerId) || 0) > 0;
  }
  function isPrioritySafetyRoute(route) {
    return Boolean(route?.template && route?.escalate
      && ["urgent", "complaint", "human_handoff", "payment"].includes(route.route));
  }
  // v1.4.49: "จ่ายเงินกับเราไปแล้วหรือยัง" — ใช้แยกคำถามเอกสารก่อนซื้อ (AI ตอบได้)
  // ออกจากคำขอเอกสารจริงหลังจ่าย (คนต้องออกเสมอ). อ่านไม่ได้ = ถือว่าจ่ายแล้ว (fail-closed
  // ทางเงิน: เอสคาเลตเกินดีกว่าปล่อยบอทคุยเรื่องเอกสารของคนที่โอนเงินมาแล้ว)
  function paymentStartedFor(customerId) {
    try {
      // ไม่พบแถว = ยังไม่รู้จักลูกค้า แต่ทางเงินต้องเดาไปทางปลอดภัยเสมอ (fail-closed
      // เหมือน branch catch ด้านล่าง) — audit 2026-08-24 จับว่าเดิม return false ขัดกันเอง
      return paymentStartedFromRow(db.getCustomer(customerId));
    } catch (err) {
      logger.warn?.(`pipeline: อ่านสถานะการจ่ายเงินไม่ได้ (${err?.message || err}) -> ถือว่าจ่ายแล้ว`);
      return true;
    }
  }

  // ---- 18 ต.ค. 2026 (audit ลูกแพร): ขั้นชำระเงินที่ระบบประกอบเอง (paymentStep.mjs) ----
  // เปิดเมื่อด่านเงินเปิด (SALES_DECISION_GUARD_ENABLED) + การ์ดของเจ้าของมีบล็อกบัญชีและฟอร์มครบ + สวิตช์ไม่ถูกปิด
  // ไม่ครบข้อใด = null = ทุกอย่างเดินแบบเดิมทุกไบต์ (ธุรกิจอื่นที่ไม่มีการ์ดนี้ไม่เห็นความต่าง)
  function paymentKitFor({ brain, customer }) {
    if (config.salesDecisionGuardEnabled !== true) return null;
    try {
      if (String(db.getSetting(PAYMENT_STEP_SETTING) || "").trim().toLowerCase() === "off") return null;
      return extractPaymentKit(knowledgeEntriesFor({ brain, db, channelId: customer?.channel_id || "default" }));
    } catch (err) {
      logger.warn?.(`pipeline: อ่านชุดชำระเงินจากการ์ดไม่สำเร็จ (${err?.message || err}) — ใช้เส้นเดิม`);
      return null;
    }
  }

  // ตัดสินเทิร์นนี้ + เก็บ/ล้างหมุดของห้อง · ข้อมูลไม่พอให้ประกอบเอง = ปักธงให้ทีมส่งบัญชีเอง (ครั้งเดียวต่อหมุด)
  function planPaymentTurn({ customerId, customer, text, parts, sessionId, brain, kit }) {
    const pinKey = `${PAYMENT_STEP_PIN_PREFIX}${customerId}`;
    try {
      const presetList = presetButtonPhrases({ db });
      const history = collapsePresetBurst(historyBeforeCurrentInbound(db.recentTurns(customerId, config.historyTurns)), { list: presetList });
      const priceRows = (brain ? brain.bundle.guardTables.approvedPrices : db.approvedPrices()) ?? [];
      const amounts = approvedClassAmounts(priceRows);
      const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
      const pin = readPin(db.getSetting(pinKey), { sessionId });
      // หลักฐานทั้งห้อง (audit/ข้อความบัญชีเก่ากว่าหน้าต่างประวัติ) — deal_status อย่างเดียวไม่พอ (lifecycle ตั้งเองตอนเลือกรอบ)
      const delivered = db.paymentDeliveredEvidence?.(customerId) === true;
      const plan = planPaymentStep({ text, parts, history, customer, pin, kit, delivered, courses: salesPolicy?.courses || [],
        approvedPrices: priceRows, approvedAmounts: amounts,
        rounds: currentUpcomingRounds({ db, config, bundle: brain?.bundle ?? null, todayIso, logger }) });
      if (plan.action === "clear" && pin) db.setSetting(pinKey, "");
      if (plan.action === "pin") {
        const firstManual = plan.manual && !pin?.manualNotified;
        db.setSetting(pinKey, JSON.stringify({ docType: plan.docType, at: pin?.docType === plan.docType ? Number(pin.at) : Date.now(),
          sessionId, manualNotified: Boolean(pin?.manualNotified || plan.manual) }));
        if (!pin || pin.docType !== plan.docType || firstManual) {
          db.addAudit({ operator: "system", action: PAYMENT_STEP_AUDIT.pending, target: customerId,
            detail: `doc=${plan.docType} reason=${plan.reason}${plan.manual ? " manual" : ""}` });
        }
        if (firstManual) {
          const summary = `ลูกค้าแจ้งประเภทเอกสารแล้ว (${DOC_TYPE_LABEL[plan.docType] || plan.docType}) แต่ระบบประกอบยอด+บัญชีเองไม่ได้ (${plan.reason}) — รบกวนทีมส่งสรุปค่าเรียนและช่องทางชำระให้ลูกค้า`;
          if (escalate(customerId, "payment_step_manual", summary, { markMoney: false })) {
            notifier?.fireLater({ customerId, channelId: customer?.channel_id || "default", reason: "payment_step_manual",
              customerName: customer?.known_name || customer?.display_name || "", reasonTextOverride: summary });
          }
        }
      }
      return { plan, history, priceRows, amounts, pinKey, delivered };
    } catch (err) {
      logger.warn?.(`pipeline: ตัดสินขั้นชำระเงินไม่สำเร็จ (${err?.message || err}) — ใช้เส้นเดิม`);
      // ตัวประกอบล้มตอนลูกค้าเพิ่งตอบประเภทเอกสาร = ห้ามปล่อยให้ห้องเงียบเรื่องบัญชี — ส่งให้คน (ครั้งเดียวต่อ 10 นาทีตามตัวแจ้งเตือน)
      try {
        if (classifyDocTypeAnswer(text)) {
          const summary = "ลูกค้าอาจแจ้งประเภทเอกสารแล้ว แต่ตัวประกอบข้อความชำระเงินล้ม — รบกวนทีมตรวจและส่งสรุปค่าเรียนกับช่องทางชำระ";
          if (escalate(customerId, "payment_step_manual", summary, { markMoney: false })) {
            notifier?.fireLater({ customerId, channelId: customer?.channel_id || "default", reason: "payment_step_manual",
              customerName: customer?.known_name || customer?.display_name || "", reasonTextOverride: summary });
          }
        }
      } catch { /* ปักธงไม่สำเร็จ = log ข้างบนพอแล้ว ห้ามล้มเส้นแชท */ }
      return null;
    }
  }

  // ข้อความขาออกล่าสุดเป็นคำถามเอกสารของบอทเองหรือไม่ — ถ้าใช่ ข้อความถัดไปของลูกค้า
  // คือ "คำตอบ" ไม่ใช่ "คำขอเอกสาร" (อ่านพังต้องไม่ผ่อนปรน: return false = เส้นเดิม)
  function botAskedDocQuestionFor(customerId) {
    try {
      const latest = db.lastOutboundMessage(customerId);
      if (!latest || String(latest.agent_mode || "") !== "ai") return false;
      return isDocumentNameQuestion(latest.content);
    } catch (err) {
      logger.warn?.(`pipeline: อ่านข้อความขาออกล่าสุดไม่ได้ (${err?.message || err}) -> ไม่ผ่อนปรน`);
      return false;
    }
  }

  // ทุกจุดที่ "เงินเข้ามาเกี่ยวข้องจริง" ต้องปักธงถาวร — พังห้ามล้มเส้นแชท
  function markMoneySeen(customerId, why = "") {
    try {
      db.markMoneySeen(customerId);
    } catch (err) {
      logger.warn?.(`pipeline: ปักธงเรื่องเงินไม่สำเร็จ (${why}) (${err?.message || err})`);
    }
  }

  // เครื่องตอบ v3: ตัวตรวจคำรับปาก/ส่งไม้ต่อ/ด่านราคา ส่งเข้าไปเป็นฟังก์ชัน (ไม่ย้ายโค้ดออกจากไฟล์นี้ ไม่มีวงวน import)
  // config.replyEngineV3 = hook ของชุดวัดผลเท่านั้น (V3NP = ไม่มี <plan> · leave-one-out บน dev) — production ไม่มีคีย์นี้
  const v3EvalHook = config.replyEngineV3 || {};
  const replyEngineV3 = createReplyEngineV3({ hermes, logger,
    outputFormat: v3EvalHook.outputFormat === "reply_only" ? "reply_only" : "plan_reply",
    predicates: {
      looksLikeTeamPromise, looksLikeSelfPromise, looksLikeHandoverReply,
      checkOutbound: (text, scope) => guard.checkOutbound(text, scope),
    } });
  const v3ExcludeCaseIds = Array.isArray(v3EvalHook.excludeCaseIds) ? v3EvalHook.excludeCaseIds.map(String) : [];

  async function draftReplyForCustomer(customerId, args) {
    const controller = new AbortController();
    activeReplyDrafts.set(customerId, controller);
    try {
      // args ไม่มีคีย์ v3 = เส้นเดิมทุกไบต์ (สวิตช์ปิด / เทิร์นเลนเครื่องเดิม)
      if (args.v3) {
        const { v3, repair, ...legacyArgs } = args;
        // 5 พ.ย. 2026: สวิตช์ reply_style_card อ่านสดทุกเทิร์น (ไม่มีแถว = ปิด = พรอมต์เดิมทุกไบต์)
        // 7 พ.ย. 2026: สวิตช์ reply_style_bank อ่านสดทุกเทิร์น · คลังจากไฟล์ใน instance (จำไว้จนไฟล์เปลี่ยน) · ปิด/ไม่มีไฟล์ = ไม่ส่งคีย์
        const styleBank = replyStyleBankMode(db) === "on" ? loadStyleBank(config.replyStyleBankFile, logger) : [];
        return await replyEngineV3.draft({ ...v3, styleCard: replyStyleCardMode(db) === "on", businessCacheLayer: replyCacheLayerMode(db) === "on",
          ...(styleBank.length ? { styleBank } : {}),
          legacyArgs, guardRepair: repair || "", excludeCaseIds: v3ExcludeCaseIds,
          signal: controller.signal, shouldYield: () => laterTextPending(customerId) });
      }
      return await hermes.draftReply({ ...args, signal: controller.signal });
    } finally {
      if (activeReplyDrafts.get(customerId) === controller) activeReplyDrafts.delete(customerId);
    }
  }
  // scorer มี state ที่อ่าน/เขียน DB จึงต้องเป็น single-flight ต่อ customer ด้วย:
  // scheduled score และการเรียก scoreBurst ตรง ๆ ต้องใช้ promise เดียวกัน เพื่อไม่ให้
  // transcript/state เก่ากว่ามาเขียนทับผลใหม่แบบ out-of-order.
  const scoringQueue = createKeyedQueue();
  // v1.4.46 (เคสจริงลูกค้า A 2026-08-22 22:03 บน VPS): ลูกค้าพิมพ์ต่อระหว่างบอทกำลังคิด
  // ก้อนถัดไปต้องต่อคิวหลังคำตอบแรก พอถึงคิวลูกค้าพิมพ์ต่อไปอีกแล้ว -> คำตอบของก้อนเก่า
  // ออกมาช้าจนดูเหมือนตอบผิดคิว และคำตอบของก้อนใหม่ดูเหมือนตอบซ้ำ
  // กลไก "รวมก้อนไปข้างหน้า": ถ้าตอนจะคิด/จะส่ง (เส้น AI เท่านั้น) พบว่ามีก้อนใหม่รออยู่
  // ให้ยกข้อความของก้อนนี้ไปรวมกับก้อนใหม่ แล้วไม่ส่ง — ลูกค้าได้คำตอบเดียวที่ครอบทุกอย่าง
  // template ความปลอดภัย (เงิน/ฉุกเฉิน/ขอคน) ไม่เข้ากลไกนี้ และแซงทุกงานที่ยังไม่เริ่ม
  // LINE send; request ที่ถึง provider แล้วต้องรอผลเดิมเพื่อไม่สร้าง ambiguous-send ซ้ำ
  const waitingTextTasks = new Map(); // customerId -> จำนวนงานข้อความที่รอคิว ยังไม่เริ่ม
  const carryParts = new Map(); // customerId -> { parts, at } ข้อความที่พักไว้รอรวม
  const MERGE_FORWARD_TTL_MS = 3 * 60_000;
  // รีวิวเคสจริงทั้งวัน 5 ต.ค. (ห้อง LINE ช่วงค่ำ): ลูกค้าพิมพ์ต่อ 20 วิหลังข้อความแรก ระหว่างที่คำตอบ v3 กำลังทยอยส่ง —
  // ด่านกันตอบทับหยุดไว้ที่บับเบิลแรก (ถูกตามเจตนา) แต่ก้อนถัดไปคิดจากข้อความใหม่ข้อความเดียว ไม่รู้ว่าลูกค้าเห็นอะไรไปแล้ว
  // ผลคือรับรู้เรื่องเดิมซ้ำเกือบทั้งประโยค และส่วนที่ยังไม่ได้ส่ง (ชื่อคลาส/ข้อเสนอ) หายไปกลายเป็นถามทำความรู้จักใหม่
  // จดเฉพาะเทิร์นที่ v3 เขียน แล้วส่งให้เทิร์น v3 ถัดไป (เครื่องเดิมไม่อ่าน · ล้างเมื่อคำตอบถัดไปถึงมือลูกค้า · หมดอายุเท่ากับการรวมก้อน)
  const v3Overlaps = new Map(); // customerId -> { at, stage, delivered: string[], undelivered: string[] }
  function v3OverlapFor(customerId) {
    const entry = v3Overlaps.get(customerId);
    if (entry && Date.now() - entry.at > MERGE_FORWARD_TTL_MS) { v3Overlaps.delete(customerId); return null; }
    return entry || null;
  }
  // ---- Drain-to-Finish: สถานะตอนระบบกำลังปิด ----
  // draining = ปิดปากทางเข้าแล้ว งานที่เหลือต้องปิดให้จบภายในงบเวลา
  // drainAborted แยกจาก abort ของ priority-safety โดยเจตนา เพราะผลลัพธ์ต่างกันคนละเรื่อง
  // (safety = มีงานใหม่มาแทน / drain = ไม่มีใครมาแทน ต้องปักธงให้คนรับต่อ)
  let draining = false;
  const drainAborted = new Set();
  function beginDrain({ deadlineAt = Infinity } = {}) {
    draining = true;
    return { draining, deadlineAt };
  }
  // เส้นตายของการคิด: ยกเลิกเฉพาะ Hermes call ที่ยังไม่ถึงจุดส่ง
  // AbortController ตัวนี้ครอบแค่ hermes.draftReply ไม่เคยครอบการเรียก LINE — ต้องรักษาไว้
  function abortDraftsNotSending() {
    let aborted = 0;
    for (const [customerId, controller] of [...activeReplyDrafts.entries()]) {
      drainAborted.add(customerId);
      try { controller.abort(new Error("ระบบกำลังปิด — หยุดคิดคำตอบ")); aborted += 1; }
      catch { /* ยกเลิกไม่ได้ก็ปล่อยให้เดินจนหมดงบเวลา */ }
    }
    return aborted;
  }
  // รอคิวลูกค้าจนว่าง (scoringQueue เป็นข้อมูลอนุมาน ทิ้งได้ ไม่รอ)
  function idle({ deadlineAt = Infinity } = {}) {
    return queue.idle({ deadlineAt });
  }
  // คอมมิต 'sending' ลงดิสก์ก่อนไบต์แรกถึง LINE — ต้องเรียกจาก "ทุก" เส้นที่ส่งถึงลูกค้าจริง
  // (เส้นหลัก + เส้น template เสียง) เส้นไหนลืมเรียก เทิร์นนั้นจะค้างเป็น 'owed' ตลอดการส่ง
  // แล้วบูตครั้งหน้าจะบอกแอดมินว่า "ยังไม่มีใครตอบ" ทั้งที่ลูกค้าได้ข้อความไปแล้ว = ตอบซ้ำ
  function markSendingIfNeeded(turnId) {
    if (!turnId) return false;
    try { return db.markInboundTurnSending(turnId, processId); }
    catch (err) {
      logger.warn?.(`pipeline: จดสถานะกำลังส่งไม่สำเร็จ (${err?.message || err})`);
      return false;
    }
  }
  function bumpWaiting(customerId, delta) {
    const next = (waitingTextTasks.get(customerId) || 0) + delta;
    if (next <= 0) waitingTextTasks.delete(customerId); else waitingTextTasks.set(customerId, next);
  }
  function laterTextPending(customerId) {
    return (waitingTextTasks.get(customerId) || 0) > 0 || (burst?.pendingSize?.(customerId) || 0) > 0;
  }
  function takeCarry(customerId) {
    const entry = carryParts.get(customerId);
    carryParts.delete(customerId);
    if (!entry) return [];
    if (Date.now() - entry.at > MERGE_FORWARD_TTL_MS) return []; // เก่าเกิน = บริบทเปลี่ยนแล้ว
    return entry.parts;
  }
  function mergeForward(customerId, parts, stage) {
    const existing = carryParts.get(customerId)?.parts || [];
    carryParts.set(customerId, { parts: [...existing, ...parts], at: Date.now() });
    logger.debug?.(`pipeline: รวมก้อนไปข้างหน้า (${stage}) customer=${customerId} parts=${parts.length}`);
    return { suppressed: "merged_forward", stage };
  }
  const scoringRuns = new Map();
  // 2026-09-28: เทิร์นส่งต่องาน project ที่บอกลูกค้าว่าทีมจะติดต่อกลับ — ตรวจซ้ำหลัง scorer ว่าทีมรู้จริง
  const projectPromises = createProjectPromiseWatch({ db, notifier, noteAuthor: PROMISE_NOTE_AUTHOR, logger });
  // ข้อความใหม่ระหว่าง scorer ทำงานต้องได้รอบถัดไปเสมอ ไม่ใช่เพียง coalesce
  // เข้ากับ snapshot เก่า. Set นี้เก็บได้แค่หนึ่ง dirty bit ต่อ customer เพราะ
  // rerun จะอ่าน recent turns สดทั้งหมดอยู่แล้ว.
  const trailingScheduledScores = new Set();
  // lookup แคตตาล็อกรูปเตรียมไว้ครั้งเดียว — model เลือกได้เฉพาะ key ในนี้
  const imageCatalogByKey = new Map(imageCatalog.map((entry) => [entry.key, entry]));
  const approvedImageKeys = new Set(imageCatalog
    .filter((entry) => entry?.needsVerification !== true)
    .map((entry) => entry?.key)
    .filter(Boolean));

  // W3: ขาออกของลูกค้าคนนี้ต้องใช้ client/token ของสาขานั้น + ถอด raw LINE user id
  // จาก customer key ก่อนยิง (channel default: key = raw id — พฤติกรรมเดิมทุกอย่าง)
  function outboundFor(customerId, customerRow = null) {
    if (!lineRegistry) return { lineCh: line, to: customerId, accessToken: config.lineChannelAccessToken };
    const channelId = customerRow?.channel_id || lineRegistry.channelIdOf(customerId);
    return {
      lineCh: lineRegistry.forChannel(channelId),
      to: lineRegistry.rawUserId(customerId),
      accessToken: lineRegistry.tokenFor(channelId),
    };
  }

  function capturedSession(customerId) {
    return db.activeConversationSession(customerId)?.id || null;
  }

  // A reset rotates the active session while Hermes/scorer may be awaiting a
  // provider.  Never let that older job send, write, or mutate the new session.
  function sessionStillCurrent(customerId, sessionId) {
    return sessionId != null && capturedSession(customerId) === sessionId;
  }

  // markMoney = false ใช้ได้ที่เดียว: รูปที่ "จำแนกไม่ได้" ในห้องที่ไม่เคยมีเรื่องเงินเลย
  // (เคสจริง 2026-09-05) — ยังปักธงรอคนตรวจเหมือนเดิมทุกประการ แค่ไม่ประทับตราถาวรว่า
  // ห้องนี้เป็นห้องเงิน เพราะตราถาวรปลดด้วยมือไม่ได้ ต้องลบบทสนทนาทั้งห้องเท่านั้น
  function escalate(customerId, reason, summary, { markMoney = true } = {}) {
    try {
      // เรื่องเงิน/สลิป/รูปที่อาจเป็นสลิป = ปักธงถาวรทันที ไม่พึ่ง handoff_summary ที่ถูกตัดได้
      if (markMoney && isMoneyLineReason(reason)) markMoneySeen(customerId, `escalate:${reason}`);
      db.setNeedsHuman(customerId, reason, summary);
      const receipt = db.getCustomer(customerId);
      return receipt?.state === "NEEDS_HUMAN"
        && String(receipt?.handoff_summary || "").includes(String(reason));
    } catch (err) {
      logger.error?.(`pipeline: escalate ล้มเหลว (${err?.message || err})`);
      return false;
    }
  }

  // F14 (ตรวจย้อนหลัง ก.ย. 2026 — D570): ระหว่าง AI พัก ลูกค้าขอติดต่อทีมงาน/ขอจองแล้วถูกกลืนเงียบ 15 ชม.
  // ใบ้จากข้อความเทิร์นนี้เท่านั้น · ไม่มีคนจริงส่งข้อความในหน้าต่างพักของคอนโซล (= พักเพราะระบบ ไม่ใช่เพราะ
  // คนกำลังคุย) -> ปักธง + ปลุกทีม ยังไม่ตอบ ไม่ปิด AI (การตอบระหว่างพักเป็นงานของเส้น resume)
  function notePausedHandoffRequest(customerId, hint, customer) {
    try {
      if (hint?.from !== "current" || !["contact_team", "booking"].includes(hint.kind)) return;
      const lastHuman = Number(db.lastOperatorOutboundAt?.(customerId) || 0);
      if (lastHuman > 0 && Date.now() - lastHuman < OPERATOR_ACTIVE_MS) return;
      const what = hint.kind === "booking" ? "ขอจอง/ขอใบเสนอราคา" : "ขอติดต่อทีมงาน";
      const persisted = escalate(customerId, PAUSED_CONTACT_REASON,
        brandText(`ลูกค้า${what}ระหว่างที่ AI พักอยู่ — ลูกแพรยังไม่ได้ตอบ`), { markMoney: false });
      db.addAudit({ operator: "system", action: PAUSED_CONTACT_REASON, target: customerId,
        detail: `ลูกค้า${what}ระหว่างที่ AI พัก (ไม่มีคนจริงในห้อง) — ปักธง + ปลุกทีม ไม่ตอบ ไม่ปิด AI` });
      if (persisted) {
        notifier?.fireLater({ customerId, channelId: customer?.channel_id || "default", reason: PAUSED_CONTACT_REASON,
          customerName: customer?.known_name || customer?.display_name || "" });
      }
    } catch (err) {
      logger.warn?.(`pipeline: บันทึกคำขอระหว่างพักไม่สำเร็จ (${err?.message || err})`);
    }
  }

  // F11 (ตรวจย้อนหลัง ก.ย. 2026): ปลดธงรอคนที่สมองล่มตั้งเอง เมื่อสมองกลับมาตอบได้ — เฉพาะเมื่อทุกเหตุ
  // ที่ถูกยกตั้งแต่สมองล่มครั้งแรกเป็น hermes_down ล้วน ๆ (มีเหตุอื่นแทรก = คนต้องดูเอง ไม่แตะ)
  function releaseOutageFlag(customerId) {
    try {
      const key = HERMES_DOWN_FLAG_PREFIX + customerId;
      const since = Number(db.getSetting(key) || 0);
      if (!(since > 0)) return;
      db.setSetting(key, "0");
      const row = db.getCustomer(customerId);
      if (row?.state !== "NEEDS_HUMAN") return;
      const reasons = handoffReasonsSince(row.handoff_summary, since);
      if (!reasons.length || reasons.some((reason) => reason !== "hermes_down")) return;
      db.clearNeedsHuman(customerId);
      db.addAudit({ operator: "system", action: "hermes_down_recovered", target: customerId,
        detail: "สมองกลับมาตอบได้แล้ว — ปลดธงรอคนที่ตั้งจากสมองล่มให้อัตโนมัติ (ไม่มีเหตุอื่นระหว่างนั้น)" });
    } catch (err) {
      logger.warn?.(`pipeline: ปลดธงสมองล่มไม่สำเร็จ (${err?.message || err}) — ธงยังอยู่ให้คนดู`);
    }
  }

  // Persist deterministic safety state before any global reply suppression.
  // AI_PAUSED means "do not think or send"; it must not erase an urgent,
  // payment, complaint, identity, or human-request handoff from the console.
  function persistRouteEscalation(customerId, route, text) {
    if (route.route === "identity") {
      // คำสั่งพี่ง้วง 2026-09-28: ตอบความจริงแล้วคุยต่อ — ไม่ตั้งธงรอคน ไม่ปลุกทีม (ลูกค้าแค่ถาม ยังไม่ได้ขอคน)
      // เก็บร่องรอยไว้ใน audit ให้คอนโซลเห็นว่าห้องนี้ได้คำตอบเปิดเผยแล้ว
      try {
        db.addAudit({ operator: "system", action: "identity_disclosed", target: customerId, detail: "ลูกค้าถามว่าคุยกับบอทไหม — ตอบตามจริงแล้วคุยต่อ ไม่ปิด AI (ส่งจริงหรือไม่ดูที่ข้อความในห้อง)" });
      } catch (err) {
        logger.warn?.(`pipeline: บันทึก identity_disclosed ไม่สำเร็จ (${err?.message || err})`);
      }
    }

    let routeEscalationPersisted = null;
    let stickyAiOffReason = null;
    if (route.escalate) {
      routeEscalationPersisted = escalate(customerId, route.escalate.reason, route.escalate.summary);
      if (ESCALATION_PAUSE_REASONS.has(route.escalate.reason)) {
        try {
          db.setOperatorActiveUntil(customerId, Date.now() + ESCALATION_PAUSE_MS);
          db.addAudit({
            operator: "system", action: "escalation_pause", target: customerId,
            detail: `${route.escalate.reason} — AI พัก ${ESCALATION_PAUSE_MS / 60_000} นาที รอคนจริงดูแล`,
          });
        } catch (err) {
          logger.error?.(`pipeline: ตั้ง escalation pause ล้มเหลว (${err?.message || err})`);
        }
      }
      if (isMoneyLineReason(route.escalate.reason) && isPaymentActionText(text)) {
        stickyAiOffReason = route.escalate.reason;
      } else if (route.escalate.reason === "human_requested") {
        stickyAiOffReason = "human_requested";
      } else if (route.escalate.reason === "urgent_mental") {
        stickyAiOffReason = "urgent_mental";
      } else if (route.escalate.reason === "complaint") {
        // 2026-09-02: ลูกค้าไม่พอใจ = ห้องของคนจริง ไม่ใช่ห้องที่บอทกลับมาได้เองใน 60 นาที
        stickyAiOffReason = "complaint";
      } else if (route.escalate.reason === QUIET_STOP_REASON) {
        // F4b (ก.ย. 2026): ลูกค้าขอให้หยุดตอบ = ปิดเงียบ ๆ รอคนตัดสินต่อ
        stickyAiOffReason = QUIET_STOP_REASON;
      }
    }
    return { routeEscalationPersisted, stickyAiOffReason };
  }

  function applyStickyAiOff(customerId, stickyAiOffReason) {
    if (!stickyAiOffReason) return;
    try {
      // ตารางแผนอยู่ใน aiPausePolicy.mjs — เหตุที่ไม่อยู่ในตาราง = เส้นเงิน (พฤติกรรมเดิม)
      const { offReason, auditAction } = stickyOffPlanFor(stickyAiOffReason);
      db.setAiEnabled(customerId, false, offReason);
      db.addAudit({
        operator: "system", action: auditAction, target: customerId,
        detail: `${stickyAiOffReason} — ปิด AI ถาวร รอคนจริงดูแลต่อ (เปิดคืนได้ใน console)`,
      });
    } catch (err) {
      logger.error?.(`pipeline: ปิด AI หลัง escalate ล้มเหลว (${err?.message || err})`);
    }
  }

  // ---- F4b (ตรวจย้อนหลัง ก.ย. 2026 — D324): "ไม่ต้องตอบกลับครับลูกแพร งานผมจะไม่เสร็จ" ----
  //
  // ของจริง: ตัวจับไม่รู้จักประโยคนี้ บอทจึงคุยต่อใส่คนที่เพิ่งขอให้หยุด และคนจริงมาถึงหลัง 25 ชม.
  // เส้นนี้ต่างจาก "ขอคุยกับคน" ตรงที่ **ห้ามตอบอะไรเลย** แม้แต่แม่แบบส่งต่อ (ตอบคนที่บอกว่า
  // ไม่ต้องตอบ = ไม่ฟังเขา) ปิด AI ถาวร (เหตุแยก customer_asked_quiet) · ยกเลิกนัด follow-up ที่ค้าง
  // (ห้อง AI ปิดไม่ถูกทักตามอยู่แล้ว แต่นัดที่คนตั้งไว้ในตาราง followups ต้องหยุดด้วย)
  // · โน้ตให้ทีมรู้ว่าทำไมห้องเงียบ · push ธรรมดาครั้งเดียว (ไม่ทะลุ cooldown — ไม่ใช่เรื่องด่วน)
  function finishQuietStop(customerId, text) {
    try {
      const cancelled = db.cancelPendingFollowups(customerId, QUIET_STOP_REASON);
      db.addHandoffNote({
        customerId, author: "ai_auto",
        text: `${QUIET_STOP_NOTE_PREFIX}: "${String(text || "").replace(/\s+/gu, " ").trim().slice(0, 120)}"\n`
          + brandText(`ลูกแพรหยุดทันทีโดยไม่ส่งข้อความตอบ · AI ปิด · follow-up หยุด (ยกเลิกนัดค้าง ${cancelled} รายการ)\n`)
          + "ถ้าลูกค้ากลับมาคุยต่อ เปิด AI คืนได้ในคอนโซล",
      });
      const customer = db.getCustomer(customerId);
      notifier?.fireLater({
        customerId,
        channelId: customer?.channel_id || "default",
        reason: QUIET_STOP_REASON,
        customerName: customer?.known_name || customer?.display_name || "",
      });
    } catch (err) {
      logger.error?.(`pipeline: บันทึกการหยุดเงียบไม่สำเร็จ (${err?.message || err}) — AI ปิดแล้ว ไม่มีผลกับลูกค้า`);
    }
    return { suppressed: QUIET_STOP_REASON, route: "quiet_stop" };
  }

  const todayInBangkok = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());

  // ---- P2: สมองของ "เทิร์นนี้" ----------------------------------------------
  // brainRuntime.resolve คืน null ได้เสมอ (ปิดแฟล็ก / ไม่มีรุ่น / คอมไพล์ไม่ผ่าน)
  // retrieval ปิด = ใช้เส้นเดิม; retrieval เปิด = พักก่อนร่างผ่าน holdBrainKnowledge
  // channelId = undefined -> อ่านจากแถวลูกค้า **ข้างใน try** โดยเจตนา: ถ้าอ่านเป็น argument
  // มันจะอยู่นอก try แล้ว DB ที่อ่านไม่ได้จะกลายเป็น throw แบบ synchronous ในเส้น ingress
  // (handleInboundText ไม่ใช่ async และมีเส้นที่เรียกจาก setTimeout เปล่า ๆ = โปรเซสตาย)
  function resolveBrain(customerId, channelId = undefined) {
    if (!brainRuntime?.enabled) return null;
    try {
      const id = channelId === undefined ? db.getCustomer(customerId)?.channel_id : channelId;
      return brainRuntime.resolve?.(customerId, id || "default", Date.now()) ?? null;
    } catch (err) {
      logger.debug?.(`pipeline: อ่านสมองรุ่นปัจจุบันไม่สำเร็จ — ${config.brainRetrievalEnabled === true ? "พักการร่างที่ต้องเลือกความรู้" : "ใช้ทางเดิม"}`);
      return null;
    }
  }

  function holdBrainKnowledge(customerId, reason) {
    escalate(customerId, "brain_knowledge_unavailable",
      "ความรู้ที่อนุมัติยังใช้ตอบไม่ได้ — พักคำตอบเพื่อให้ทีมตรวจสอบ");
    logger.error?.(`pipeline: brain retrieval held (${reason})`);
    notifier?.fireLater?.({
      customerId: "ops:brain", channelId: "default", reason: "brain_knowledge_unavailable",
      reasonTextOverride: "ความรู้ที่อนุมัติยังใช้ตอบไม่ได้ กรุณาตรวจสมองและพื้นที่ความรู้ก่อนเปิดตอบต่อ",
    });
    return { suppressed: "brain_knowledge_unavailable", stage: "before_draft" };
  }

  // ห้องที่กำลังคุยเรื่องเงินอยู่ แล้ว "รุ่นสมองที่ห้องนี้ใช้" เปลี่ยนไป (ออกจากกลุ่มทดลอง,
  // เผยแพร่รุ่นใหม่, ย้อนกลับ) — ถ้าตารางราคาของสองรุ่นต่างกัน ตัวเลขที่เพิ่งเสนอไปอาจไม่มี
  // อยู่แล้ว เลือก "ปักธงให้คนจริงยืนยัน" แทน "ตรึงห้องไว้กับรุ่นเดิม" โดยเจตนา:
  // การตรึงจะทำให้ห้องยังเสิร์ฟรุ่นที่เจ้าของเพิ่งถอนทิ้ง ซึ่งเป็นเหตุผลทั้งหมดของการถอน
  // (เช่น ถอนเพราะราคาผิด) ปักธงครั้งเดียวพอ เพราะข้อความถัดไปจะปั๊มรุ่นใหม่ทับให้เอง
  const MONEY_STAGE = new Set(["price_sent", "awaiting_round_choice", "awaiting_payment"]);
  function noteBrainVersionSwitch(customerId, brain, customer) {
    if (!brain || !brainRuntime?.enabled) return;
    try {
      const inMoneyStage = Number(customer?.money_seen_at) > 0 || MONEY_STAGE.has(String(customer?.deal_status));
      if (!inMoneyStage) return;
      const previous = db.lastBrainVersionFor?.(customerId);
      if (!previous || previous === brain.versionId) return;
      // พิสูจน์ไม่ได้ (คอมไพล์รุ่นเก่าไม่ผ่าน) = ถือว่าเปลี่ยน — เรื่องเงินต้อง fail-closed
      if (brainRuntime.priceDriftBetween?.(previous, brain.versionId, Date.now()) === false) return;
      escalate(customerId, "brain_version_switch",
        `รุ่นสมองของห้องนี้เปลี่ยนระหว่างคุยเรื่องเงิน (${previous} -> ${brain.versionId}) — ตารางราคาไม่เหมือนเดิม`);
      notifier?.fireLater?.({
        customerId, channelId: customer?.channel_id || "default", reason: "brain_version_switch",
        customerName: customer?.known_name || customer?.display_name || "",
      });
    } catch (err) {
      logger.debug?.(`pipeline: ตรวจการเปลี่ยนรุ่นสมองของห้องไม่สำเร็จ (${err?.message || err})`);
    }
  }

  // ชุดตัวเลขที่ guard ยอมรับในเทิร์นนี้ — มาจาก bundle เดียวกับที่ประกอบ prompt
  // ไม่มีสมอง = undefined -> guard อ่านตารางกลางเหมือนเดิม (ไม่ใช่ [] ซึ่งแปลว่า "ห้ามทุกเลข")
  function guardScope(brain) {
    return brain ? { approvedPrices: brain.bundle.guardTables.approvedPrices } : undefined;
  }

  // คืน { roundFacts, seatRules } ให้ baseRules — ข้อเท็จจริงรอบ (เห็นทุกเทิร์น) แยกจากตัวเลขที่นั่ง (ตัดในจังหวะดูแล)
  function currentRoundsRules(brain = null) {
    if (!config.classRoundsFile) return { roundFacts: [], seatRules: [] };
    try {
      const todayIso = todayInBangkok();
      // ตัวประกอบเดียวกัน (seatRuleLines) ต่างกันแค่ "รอบมาจากไหน" — จำนวนคนที่ลงทะเบียน
      // ยังอ่านสดจาก settings ทั้งสองทาง เพราะทีมงานแก้ระหว่างวันได้
      const rounds = brain
        ? upcomingRoundsFor(db, brain.bundle, todayIso)
        : upcomingRounds({ file: config.classRoundsFile, db, todayIso, logger });
      // 28 ก.ย.: รายการรอบมาจากหน้าที่นั่งที่เดียว (announcedRoundsLines) — การ์ดคลังไม่ต้องมีวันเรียนอีก
      return {
        roundFacts: [todayRoundsLine(todayIso), ...announcedRoundsLines(rounds)].filter(Boolean),
        seatRules: seatRuleLines(rounds),
      };
    } catch (err) {
      logger.warn?.(`pipeline: อ่านที่นั่งคงเหลือไม่สำเร็จ (${err?.message || err}) — ตอบต่อโดยไม่บอกตัวเลข`);
      return { roundFacts: [], seatRules: [] };
    }
  }

  // สัญญาณมีโครงสร้างจาก scorer สำหรับคำตัดสินจังหวะราคา — แทน regex ภาษาไทยเขียนมือชุดเดิม
  // ที่การตรวจปรปักษ์เจาะได้ทุกรอบ (ดู knowsSomethingAboutCustomer ใน priceDisclosure.mjs)
  // parseScorePayload ทิ้งทั้งก้อนเมื่อ score ไม่ใช่ 0-10 จึงไม่มีทางได้ payload ครึ่งใบมาใช้
  function latestScoreSignals(customerId) {
    try {
      const row = db.latestScoreRow?.(customerId);
      const payload = row ? parseScorePayload(row.payload_json) : null;
      if (!payload) return null;
      // ข้อ 6 (12 ต.ค.): การอ่านความพร้อมรับราคาของแถวล่าสุด (ไม่มี = null) — เครื่องตอบ v3 ใช้ปรับถ้อยคำแบ่งรับ/แจ้งราคาเท่านั้น
      return { painPoint: payload.pain_point || "", personaType: payload.persona_type || "", priceRead: payload.price_read || null };
    } catch (err) {
      logger.debug?.(`pipeline: อ่านสัญญาณ scorer ไม่สำเร็จ (${err?.message || err})`);
      return null;
    }
  }

  // ---- กุญแจดอกที่ 1 มองย้อนหลังได้ (คำสั่งพี่ง้วง 2026-09-05, ออกแบบรอบสอง) ----
  //
  // บทสนทนาจริงแทบไม่เคยจบในเทิร์นเดียว: "ขอจองค่ะ" -> "รอบไหนดีคะ" -> "รอบ 26 ค่ะ"
  // แล้วลูกแพรถึงจะส่งไม้ต่อให้ชมพู่ในเทิร์นที่สาม ถ้าอ่านแค่ข้อความล่าสุด กุญแจสองดอก
  // จะไม่มีวันครบพร้อมกันในบทสนทนาทรงนี้เลย — ซึ่งคือทรงที่พบบ่อยที่สุด
  //
  // อ่านจาก messages โดยตรง (ไม่ใช่ recentTurns) เพราะต้องใช้เวลาจริงมาตัดหน้าต่าง 24 ชม.
  // messagesFor ผูกกับ session ที่ใช้งานอยู่แล้ว /reset จึงล้างความจำก้อนนี้ให้เองอัตโนมัติ
  // ข้อความของเทิร์นนี้เองถูกคัดออกด้วยการเทียบเนื้อความ (webhook เขียนลง DB ก่อนเรียกไปป์ไลน์
  // แต่เส้น handleInboundText ตรง ๆ ไม่เขียน — เทียบเนื้อความจึงถูกต้องทั้งสองเส้น)
  const HANDOFF_HINT_LOOKBACK_MS = 24 * 60 * 60_000;
  const HANDOFF_HINT_TURNS = 2;
  function recentInboundTexts(customerId, { currentText = "", nowMs = Date.now() } = {}) {
    try {
      const own = new Set(String(currentText).split(/\n+/u).map((line) => line.trim()).filter(Boolean));
      // R3(d): คนกดเปิด AI คืน / สั่ง /reset = เริ่มนับใหม่ ใบ้ก่อนหน้านั้นมองไม่เห็น
      const resetAt = Number(db.getSetting(handoffHintResetKey(customerId)) || 0);
      // ขอเกินมาหนึ่งแถว เผื่อข้อความของเทิร์นนี้เองถูกเขียนลง DB ไปแล้ว (เส้น webhook)
      const rows = db.recentInboundTextsForHandoff?.(customerId, {
        limit: HANDOFF_HINT_TURNS + 1,
        sinceMs: Math.max(nowMs - HANDOFF_HINT_LOOKBACK_MS, resetAt),
      }) || [];
      const out = [];
      for (const row of rows) {
        const content = String(row || "").trim();
        if (!content || own.has(content)) continue;
        out.push(content);
        if (out.length >= HANDOFF_HINT_TURNS) break;
      }
      return out;
    } catch (err) {
      logger.debug?.(`pipeline: อ่านข้อความขาเข้าย้อนหลังไม่สำเร็จ (${err?.message || err}) — ใช้เฉพาะเทิร์นนี้`);
      return [];
    }
  }

  function latestSalesState(customerId) {
    if (!salesPolicy) return null;
    try {
      const row = db.latestScoreRow?.(customerId);
      const previous = row ? parseScorePayload(row.payload_json) : null;
      let storedState = null;
      try {
        const stored = row?.payload_json ? JSON.parse(row.payload_json) : null;
        storedState = stored?.salesState?.enabled === true ? stored.salesState : null;
      } catch {
        storedState = null;
      }
      const state = normalizeSalesSignals(previous?.sales_signals, salesPolicy, storedState);
      // พี่ง้วง 13 ต.ค. (Classroom = On-site): หมุด in-house ที่ค้างจาก "online หรือ onsite" เปล่า ๆ = ไม่ใช่งานองค์กร
      // ล้างตอนอ่าน (ไม่แก้แถวคะแนนเดิม) — ทุกทางที่อ่านสถานะขาย (พรอมต์ · ส่งต่อ · ราคา) เห็นค่าเดียวกัน
      if (state?.opportunity && staleOnSitePin(state.opportunity,
        (db.messagesFor?.(customerId, 200) || []).filter((row) => row.direction === "in").map((row) => row.content))) {
        return Object.freeze({ ...state, opportunity: null });
      }
      return state;
    } catch (err) {
      logger.debug?.(`pipeline: อ่าน sales state ไม่สำเร็จ (${err?.message || err})`);
      return normalizeSalesSignals({}, salesPolicy);
    }
  }

  // "__reply" ไม่ใช่ opportunity type ที่ถูกต้อง (ID ต้องขึ้นต้นด้วยตัวอักษรพิมพ์เล็ก)
  // จึงชนกับคีย์ opportunity_handoff:<id>:<type> ของจริงไม่ได้เลย
  const handoffReplyKey = (customerId) => `opportunity_handoff:${customerId}:__reply`;

  // v1.5.x (บั๊กจริง 3 ก.ย. 2026): หลังส่งต่องาน project ห้องนี้ AI ปิดสนิทและ scorer ไม่รันอีก
  // ลูกค้าที่ตอบต่อ — ซึ่งบ่อยที่สุดคือ "เบอร์" ที่บอทเพิ่งขอไปในข้อความเดียวกับที่ปิด —
  // จึงถูกบันทึกเงียบ ๆ ไม่มีใครรู้จนกว่าจะมีคนเปิดคิว NEEDS_HUMAN เอง
  //
  // แยกสองอย่างออกจากกันตามที่ผู้ตรวจสั่ง (3 ก.ย.):
  //   อ่าน+บันทึก = ทำ "ทุกข้อความ" — ถูก เงียบ และเป็นของถาวรที่ทีมงานเปิดดูย้อนได้
  //   push ปลุกคน = จำกัดจำนวน — หนึ่งครั้งตอนลูกค้าตอบ และอีกครั้งเดียวตอนเบอร์โผล่ครั้งแรก
  // เหตุที่ต้องมีรอบสอง: ลูกค้าไทยพิมพ์ "ค่ะ" มาก่อนแล้วค่อยส่งเบอร์ตามเป็นข้อความที่สอง
  // ถ้าตั๋วถูกใช้ไปกับ "ค่ะ" เบอร์จะไม่มีวันถึงทีมงาน ซึ่งคือบั๊กเดิมย้ายที่เฉย ๆ
  function maybeNotifyHandoffReply(customerId, text) {
    const key = handoffReplyKey(customerId);
    try {
      const customer = db.getCustomer(customerId);
      // ผู้ตรวจ (b): ผูกกับ "สถานะห้อง ณ ตอนนี้" ไม่ใช่แค่การมีอยู่ของตั๋ว — ห้องที่คนจริง
      // เปิด AI คืนแล้วภายหลังถูกปิดด้วยเหตุอื่น (money_line / bank_sent / complaint)
      // ต้องไม่ถูกนับเป็น "ข้อความหลังส่งต่อ" เด็ดขาด เหตุปิดนี้เขียนจากที่เดียวคือการส่งต่อ
      if (!HANDOFF_REPLY_WAKE_REASONS.has(String(customer?.ai_off_reason || ""))) return false;

      // (a) อ่านก่อนเสมอ ห้ามเผาตั๋วทิ้งก่อนได้อ่านข้อความ
      const phone = extractContactPhoneQuote(text);
      const raw = db.getSetting(key);
      // ตั๋วสังเคราะห์ (legacy) มีไว้สำหรับห้อง project ที่ถูกปิดไปก่อนฟีเจอร์นี้จะมีเท่านั้น
      // เหตุปิดของการส่งไม้ต่อ (booking_handoff / human_requested) ต้องมีตั๋วจริงที่บล็อกปิดห้อง
      // วางไว้ — ไม่งั้นห้องที่ safetyRouter ปิดด้วย human_requested มาแต่ไหนแต่ไรจะถูกปลุกใหม่
      // ทั้งกอง ซึ่งไม่ใช่สิ่งที่ผู้ตรวจขอ
      if (!raw && customer?.ai_off_reason !== HANDOFF_AI_OFF_REASON) return false;
      let ticket = { createdAt: Date.now(), legacy: !raw, notified: false, phones: [] };
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            ticket = { ...ticket, ...parsed, phones: Array.isArray(parsed.phones) ? parsed.phones : [] };
          }
        } catch {
          // ค่าพัง = เริ่มตั๋วใหม่ ดีกว่าเงียบใส่ลูกค้าที่กำลังรออยู่
        }
      }

      // บันทึกเบอร์ใหม่ทุกครั้งที่เจอ (ถาวร เงียบ ไม่ผูกกับโควตา push)
      const freshPhone = phone && !ticket.phones.includes(phone) ? phone : "";
      if (freshPhone) {
        db.addHandoffNote({
          customerId, author: "ai_auto",
          text: `ลูกค้าพิมพ์เบอร์มาหลังส่งต่อแล้ว: ${freshPhone}`,
        });
      }

      // push: ครั้งแรกที่ลูกค้าตอบ + อีกครั้งเดียวเมื่อเบอร์โผล่ครั้งแรก
      const firstReply = ticket.notified !== true;
      const phoneArrived = Boolean(freshPhone) && ticket.phoneNotified !== true;
      const nextTicket = {
        ...ticket,
        notified: true,
        phoneNotified: ticket.phoneNotified === true || Boolean(freshPhone),
        phones: freshPhone ? [...ticket.phones, freshPhone].slice(-5) : ticket.phones,
      };
      db.setSetting(key, JSON.stringify(nextTicket));
      if (!firstReply && !phoneArrived) return false;

      db.addAudit({
        operator: "system", action: "opportunity_handoff_reply", target: customerId,
        detail: freshPhone ? "ลูกค้าตอบหลังส่งต่อ — มีเบอร์ในข้อความ" : "ลูกค้าตอบหลังส่งต่อ",
      });
      notifier?.fireLater({
        customerId,
        channelId: customer?.channel_id || "default",
        reason: "opportunity_handoff_reply",
        customerName: customer?.known_name || customer?.display_name || "",
        reasonTextOverride: freshPhone
          ? `ตอบกลับมาหลังส่งต่อแล้ว และพิมพ์เบอร์มาด้วย: ${freshPhone}\nAI ปิดอยู่ ไม่มีใครตอบให้ — โทรกลับหรือเปิดห้องแชทตอบได้เลย`
          : "",
        force: true,
      });
      return true;
    } catch (err) {
      logger.error?.(`pipeline: แจ้งทีมเรื่องข้อความหลังส่งต่อล้มเหลว (${err?.message || err}) — ไม่มีผลกับแชท`);
      return false;
    }
  }

  function closedByHandoff(customerId) {
    try {
      const row = db.getCustomer(customerId);
      return row?.ai_enabled === 0 && CLOSING_HANDOFF_REASONS.has(String(row.ai_off_reason || ""));
    } catch {
      return false;
    }
  }

  function maybeHandoffOpportunity(customerId, signals) {
    const opportunity = signals?.opportunity;
    if (!opportunity?.handoffOnComplete || !opportunity.handoffReady) return false;
    // ข้อ 26 ของการตรวจปรปักษ์ 2026-09-05: scorer วิ่งหลังตอบเสร็จ ถ้าห้องเพิ่งถูกปิดเพราะ
    // ลูกค้าจอง/ขอติดต่อทีมงาน บล็อกนี้เคยยิง push ใบที่สอง แล้วเขียนเหตุปิดทับเป็น
    // handoff_private_inhouse ซึ่งไม่ตรงกับ audit และป้ายในคิวรอคน — หนึ่งเทิร์น = ปลุกใบเดียว
    if (closedByHandoff(customerId)) return false;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([opportunity.type, opportunity.courseId, opportunity.slots]))
      .digest("hex");
    const key = `opportunity_handoff:${customerId}:${opportunity.type}`;
    try {
      let priorFingerprint = db.getSetting(key);
      try {
        priorFingerprint = JSON.parse(priorFingerprint || "null")?.fingerprint || priorFingerprint;
      } catch {
        // Backward-compatible with the earlier plain-hash value.
      }
      // ผู้ตรวจ (c): fingerprint กันแค่ "ส่งต่อซ้ำเรื่องเดิมทั้งที่ยังปิดอยู่" เท่านั้น
      // ห้องที่คนจริงกดเปิด AI คืน (ai_enabled = 1) แล้วลีดเดิมกลับมาพร้อมข้อมูลชุดเดิมเป๊ะ
      // คือ "การส่งต่อครั้งใหม่" ตามความหมายทางธุรกิจ ถ้าปล่อยให้ fingerprint กลืน
      // ห้องจะไม่ถูกปิดอีก ทีมงานไม่ได้รับแจ้ง และตั๋วปลุกไม่ถูกติดอาวุธใหม่ = เงียบซ้ำรอบสอง
      const releasedByHuman = db.getCustomer(customerId)?.ai_enabled === 1;
      if (priorFingerprint === fingerprint && !releasedByHuman) return false;
      const slotSummary = Object.entries(opportunity.slots)
        .map(([slot, value]) => `${slot}=${String(value).slice(0, 120)}`)
        .join("; ")
        .slice(0, 420);
      db.setOperatorActiveUntil(customerId, Date.now() + ESCALATION_PAUSE_MS);
      db.addAudit({ operator: "ai_auto", action: "opportunity_handoff", target: customerId, detail: `type=${opportunity.type}; slots=${Object.keys(opportunity.slots).join(",")}` });
      db.addHandoffNote({ customerId, author: "ai_auto", text: `Opportunity ${opportunity.type} พร้อมส่งต่อทีมแล้ว: ${slotSummary}` });
      db.setNeedsHuman(customerId, "opportunity_handoff", `ข้อมูล ${opportunity.type} ครบตาม policy — ให้ทีมรับช่วงต่อ`);
      // Opportunity ที่เก็บ requirement ครบคือ human takeover แบบ sticky ไม่ใช่แค่พัก
      // เป็นเวลา: คนจริงต้องกดเปิด AI เองหากต้องการ release กลับไปตอบอัตโนมัติ.
      db.setAiEnabled(customerId, false, HANDOFF_AI_OFF_REASON);
      db.addAudit({ operator: "ai_auto", action: "opportunity_handoff_takeover", target: customerId, detail: "AI disabled pending explicit human release" });
      db.setSetting(key, JSON.stringify({ fingerprint, createdAt: Date.now() }));
      // v1.5.x: เปิด "ตั๋วปลุกทีมงานหนึ่งใบ" ให้ห้องนี้ — ข้อความแรกที่ลูกค้าพิมพ์มาหลังจากนี้
      // จะใช้ตั๋วนี้ปลุกทีมงาน (ดู maybeNotifyHandoffReply — เพดานสองครั้ง: ตอนตอบ + ตอนเบอร์มา)
      // คีย์อยู่ใต้ prefix เดิมโดยตั้งใจ เพื่อให้ทั้ง retention prune และ PDPA cascade
      // ที่กวาด opportunity_handoff:% อยู่แล้วเก็บกวาดให้ครบโดยไม่ต้องแก้สองที่
      db.setSetting(handoffReplyKey(customerId), JSON.stringify({
        createdAt: Date.now(), notified: false, phoneNotified: false, phones: [],
      }));
      // คำสั่งพี่ง้วง 2026-08-14: งาน project ให้ทีมงานคนจริง (ชมพู่) รับช่วงเอง —
      // ข้อมูลครบเมื่อไหร่ ping ทาง LINE ทันที พร้อมสรุปที่อ่านแล้วโทรกลับได้เลย
      // force: เหตุนี้กันซ้ำด้วย fingerprint แล้ว ถ้าโดน cooldown กลืนจะไม่มีรอบสอง
      if (notifier) {
        const customer = db.getCustomer(customerId);
        notifier.fireLater({
          customerId,
          channelId: customer?.channel_id || "default",
          reason: "opportunity_handoff",
          customerName: customer?.known_name || customer?.display_name || "",
          reasonTextOverride: renderHandoffPing(opportunity),
          force: true,
        });
      }
      return true;
    } catch (err) {
      logger.error?.(`pipeline: opportunity handoff ล้มเหลว (${err?.message || err})`);
      return false;
    }
  }

  // Schedule Gate: ack อัตโนมัติช่วงปิดทำการ — ครั้งเดียวต่อลูกค้าต่อช่วงปิดหนึ่งช่วง
  // (กุญแจ = เวลาเริ่มช่วงปิด) + ต้องผ่าน compliance guard เสมอ; ล้มเหลว = เงียบ ไม่ retry
  async function maybeSendScheduleAck({ customerId, gate, sched, replyToken, guardTurn = undefined, brainRows = {} }) {
    // โหมดร่าง (2026-08-24): flow ไหลถึงตรงนี้ได้ระหว่าง pause — ack เป็น send ตรง ห้ามหลุด
    if (aiPausedNow({ db, config })) return false;
    const template = String(sched.ackTemplate || "").trim();
    if (!template || sched.offPeriodStart == null) return false;
    const ackKey = `schedule_ack:${customerId}`;
    try {
      if (db.getSetting(ackKey) === String(sched.offPeriodStart)) return false; // ส่งแล้วช่วงนี้
    } catch {
      return false; // อ่านสถานะไม่ได้ — ไม่เสี่ยงส่งซ้ำ
    }
    // ack นี้คือข้อความที่ถึงลูกค้าจริงในเทิร์นนี้ จึงต้องตัดสินด้วยชุดตัวเลขของเทิร์นเดียวกัน
    const check = guard.checkOutbound(template, guardTurn);
    if (!check.ok) {
      logger.warn?.("scheduleGate: ack template ไม่ผ่าน compliance guard — ไม่ส่ง (แก้ template ในหน้าตั้งค่า)");
      return false;
    }
    if (!gate.confirmBeforeSend()) return false; // takeover ระหว่างรอ — เงียบ
    const { lineCh, to } = outboundFor(customerId);
    const sendResult = await lineCh.sendBubbles({
      to, replyToken, bubbles: [{ text: template }], images: [], purpose: SEND_PURPOSE.customerReply,
    });
    if (!sendResult.ok) return false;
    db.insertMessage({
      customerId, direction: "out", msgType: "text",
      content: template, messageClass: "reactive", agentMode: "ai",
      ...brainRows,
    });
    try {
      db.setSetting(ackKey, String(sched.offPeriodStart));
    } catch (err) {
      logger.debug?.(`scheduleGate: บันทึกสถานะ ack ไม่สำเร็จ (${err?.message || err})`);
    }
    return true;
  }

  // B8.3: บันทึก token usage จากผล Hermes — ไม่มี usage = ข้ามเงียบ, พังห้ามกระทบแชท
  function recordUsage(customerId, kind, result, brainVersionId = null) {
    if (!result?.usage) return;
    try {
      db.addLlmUsage({
        customerId,
        kind,
        model: result.model || "",
        // P2: แถวนี้เกิดจากเทิร์นที่อ่านสมองรุ่นไหน (null = อ่านตารางเดิม) —
        // "ผล 24 ชม. ของรุ่น N" เป็น query บนคอลัมน์นี้ ไม่ใช่ตาราง release_watch แยก
        brainVersionId,
        // v1.4.25: OpenAI รายงานส่วนที่ hit cache มาด้วย — ใช้วัดว่าลำดับ prompt ยังดีอยู่ไหม
        // 31 ส.ค. 2026: ย้ายมาใช้ตัวช่วยร่วม เพราะตัวเขียนอีก 2 จุดเคยลืมกรอกช่องนี้
        ...usageFields(result.usage),
      });
    } catch (err) {
      logger.debug?.(`pipeline: บันทึก llm_usage ไม่สำเร็จ (${err?.message || err})`);
    }
  }

  // F3: interest scorer — call แยกจาก reply, ผลพัง/ไม่ใช่ JSON = ทิ้งเงียบ ไม่มีผลกับแชท
  function verifiedLearningFor(customerId) {
    // Optional and deliberately server-owned. This chassis currently has no
    // enrollment table requirement; deployments that provide the method may
    // pass a verified record, while model output can never manufacture one.
    if (typeof db.getVerifiedLearning !== "function") return null;
    try {
      return db.getVerifiedLearning(customerId) || null;
    } catch (err) {
      logger.debug?.(`pipeline: อ่าน verified learning ไม่สำเร็จ (${err?.message || err})`);
      return null;
    }
  }

  // อ่านบันทึกส่งต่อแบบไม่ล้ม — ใช้ร่วมกันทั้งเส้นตอบแชทและเส้นให้คะแนน
  // อ่านพังต้องไม่ทำให้ทั้งสองเส้นตาย (บันทึกเป็นข้อมูลเสริม ไม่ใช่เงื่อนไขบังคับ)
  function safeHandoffNotesFor(customerId, limit = 10) {
    try {
      return db.listHandoffNotes(customerId, limit);
    } catch (err) {
      logger.debug?.(`pipeline: อ่าน handoff notes ไม่สำเร็จ (${err?.message || err})`);
      return [];
    }
  }

  async function scoreBurstImpl(customerId) {
    const customer = db.getCustomer(customerId);
    if (!customer) return null;
    const sessionId = capturedSession(customerId);
    if (!sessionId) return null;
    const scoringInboundId = safeLatestInboundMessageId(customerId);
    const turns = typeof db.scoringEvidenceTurns === "function"
      ? db.scoringEvidenceTurns(customerId, config.scoreTurns ?? 16)
      : db.recentTurns(customerId, config.scoreTurns ?? 16);
    if (!turns.length) return null;
    const previousSalesState = latestSalesState(customerId);
    const handoffNotes = safeHandoffNotesFor(customerId);
    // กรอบป้ายชุดเดียว: สวิตช์ tag_framework_mode อ่านสดทุกรอบ (ปิด = ป้ายอิสระแบบเดิมตั้งแต่รอบถัดไป)
    const tagFrameworkNow = activeTagFramework(db, tagFramework);
    const scoreEvidence = buildScoreEvidence({
      turns, now: now(), presetPhrases: presetButtonPhrases({ db }), handoffNotes,
      previousContextKnown: hasVerifiedPriorAssessment(db.latestScoreRow?.(customerId), db.activeConversationSession?.(customerId)),
    });
    const suggestionsEnabled = scorerSuggestionsEnabled(db);
    const scorerRequest = {
      system: buildScorerSystem({
        displayName: customer.display_name,
        knownName: customer.known_name,
        lastScore: Number.isInteger(customer.last_score) ? customer.last_score : null,
        salesPolicy,
        salesState: previousSalesState,
        // คำสั่งพี่ง้วง 2026-08-26: โน้ตส่งต่อของชมพู่ต้องมีผลกับคะแนนด้วย
        // ทีมงานยังคุยนอกระบบอยู่ (โทร/แอป LINE OA) บทสนทนาในแชทจึงไม่ใช่เรื่องทั้งหมด
        // scoring.mjs กรองเอาเฉพาะโน้ตที่คนเขียนจริงอีกชั้น — อ่านพังห้ามล้มการให้คะแนน
        // Note content is already included once in the annotated evidence transcript.
        scoreAssessment: scoreEvidence.assessment,
        suggestionsEnabled,
        tagFramework: tagFrameworkNow,
      }),
      transcript: scoreEvidence.transcript,
    };
    if (config.serviceBoundaryEnabled) scorerRequest.system += "\nแยกความสนใจเรียนจากการขอให้ผลิตหรือแก้ชิ้นงาน: จำนวนข้อความและความซับซ้อนของงานไม่ใช่หลักฐานซื้อ ห้ามเพิ่มคะแนนเพียงเพราะขอแต่งเพลง/ละคร/คอนเทนต์หลายรอบ และห้ามลดคุณค่าลูกค้าจากอายุ การเกษียณ หรือการยังไม่มีงบ หากยังไม่พบเจตนาเรียนให้คงความไม่แน่ใจ ไม่สรุปว่าลูกค้าหลอกถาม";
    scorerRequest.system = withCampaignReceiptPolicy(scorerRequest.system, config);
    let result = await hermes.scoreCustomer({ ...scorerRequest, system: scorerSystemBlocks(scorerRequest.system) });
    recordUsage(customerId, "score", result);
    if (!sessionStillCurrent(customerId, sessionId) || safeLatestInboundMessageId(customerId) !== scoringInboundId) return null;
    let fallbackReason = "";
    let fallbackAllowed = true;
    let payload = null;
    if (result?.failed) {
      fallbackAllowed = result.retryable === true;
      fallbackReason = result.failureClass || "primary_rejected";
      result = null;
    } else if (result) {
      payload = parseScorePayload(result.text, { tagFramework: tagFrameworkNow, discRetired: Boolean(salesPolicy) });
      if (!payload) {
        fallbackReason = "invalid_primary_payload";
        // v1.4.10 (เหตุ 2026-08-17: scorer ล้ม 61/61 ทั้งวันแบบไร้ร่องรอย เพราะไม่เคยเก็บ
        // หลักฐานว่าโมเดลตอบอะไร): log เฉพาะ "รูปทรง" ของ payload — ห้าม log เนื้อหาเต็ม
        // (มีข้อมูลลูกค้า) แต่พอให้แยกได้ว่า prose / JSON ขาด / ว่าง
        const raw = String(result.text || "");
        logger.warn?.(`scorer: payload ใช้ไม่ได้ (model=${result.model || "?"}, len=${raw.length}, ` +
          `hasBraces=${raw.includes("{")}/${raw.includes("}")}, head="${raw.slice(0, 12).replace(/[\r\n]+/g, " ")}")`);
      }
    } else {
      fallbackReason = "primary_unavailable";
    }
    if (!payload && fallbackAllowed && typeof hermes.scoreCustomerFallback === "function") {
      const fallback = await hermes.scoreCustomerFallback(scorerRequest);
      recordUsage(customerId, "score", fallback);
      if (!sessionStillCurrent(customerId, sessionId) || safeLatestInboundMessageId(customerId) !== scoringInboundId) return null;
      if (fallback) {
        const fallbackPayload = parseScorePayload(fallback.text, { tagFramework: tagFrameworkNow, discRetired: Boolean(salesPolicy) });
        if (fallbackPayload) {
          result = fallback;
          payload = fallbackPayload;
          payload.scorer_fallback = {
            reason: fallbackReason,
            model: fallback.model,
            reasoning_effort: config.hermesScorerFallbackReasoningEffort || null,
          };
        }
      }
    }
    if (!payload) {
      logger.debug?.("scorer: primary/fallback response ใช้ไม่ได้ — คงคะแนนเดิมและไม่สร้าง side effect");
      return null;
    }
    if (!sessionStillCurrent(customerId, sessionId) || safeLatestInboundMessageId(customerId) !== scoringInboundId) return null;
    payload = normalizeScoreEvidence(payload, scoreEvidence, { lastScore: customer.last_score });
    // Server-owned lineage: an older assessment must never become evidence in a
    // new session, even if a provider response arrived after the new turn.
    payload.score_assessment = { ...payload.score_assessment, session_id: sessionId, source_inbound_id: scoringInboundId };
    // Also discard unsolicited fields / advice from a call already in flight
    // when the owner switched off. The score and customer memory remain intact.
    if (!suggestionsEnabled || !scorerSuggestionsEnabled(db)) payload = withoutScorerSuggestions(payload);
    const customerEvidenceText = turns
      .filter((turn) => turn.role === "user" && (!turn.msg_type || turn.msg_type === "text"))
      .map((turn) => String(turn.content || ""))
      .join("\n");
    const latestCustomerText = latestInboundTurnText(turns);
    const salesSignals = normalizeSalesSignals(payload.sales_signals, salesPolicy, previousSalesState, {
      customerText: customerEvidenceText,
      latestCustomerText,
      verifiedLearning: verifiedLearningFor(customerId),
    });
    payload.salesState = salesSignals;
    // Raw model candidates are intentionally ephemeral. Persist only the bounded,
    // policy-normalized state so console/retention never carries arbitrary nested JSON.
    delete payload.sales_signals;
    db.recordScore(customerId, payload.score, JSON.stringify(payload));
    try {
      jevShadow.enqueue({ customer, sessionId, scoreId: db.latestScoreRow(customerId).id,
        transcript: scoreEvidence.transcript, assessment: scoreEvidence.assessment,
        primaryScore: payload.score, primaryModel: payload.scorer_fallback?.model || result?.model || config.hermesScorerModel });
    } catch { logger.warn?.("jev-shadow: could not schedule observation"); }

    // B4: scorer จับชื่อจริงได้ + ช่องชื่อยังว่าง -> บันทึกเป็น ai_auto
    // (แอดมินแก้จาก console ชนะเสมอ — ai_auto ห้ามทับค่าที่ไม่ว่าง)
    // v1.4.8 (เคสคุณมนตรี): เช็คบริบทบุคคลที่สามจากข้อความฝั่งลูกค้าจริงก่อนเขียนเสมอ —
    // scorer เห็น "ให้คุณมนตรีมาเรียน" แล้วคืนชื่อนั้นได้ตามตัวอักษร การ์ดต้องอยู่ฝั่งเรา
    if (payload.known_name) {
      try {
        const inboundContext = db.recentTurns(customerId, 20)
          .filter((turn) => turn.role === "user")
          .map((turn) => String(turn.content || ""))
          .join("\n");
        const fresh = db.getCustomer(customerId);
        if (fresh && !fresh.known_name && !nameLooksThirdParty(payload.known_name, inboundContext)) {
          db.setKnownName(customerId, payload.known_name);
          db.addAudit({
            operator: "ai_auto", action: "name_auto", target: customerId,
            detail: `scorer จับชื่อจากบทสนทนา: "${payload.known_name}"`,
          });
        }
      } catch (err) {
        logger.debug?.(`scorer: บันทึก known_name อัตโนมัติไม่สำเร็จ (${err?.message || err})`);
      }
    }

    // B6: สรุปสถานะล่าสุด -> โน้ต ai_auto แถวเดียว (แทนของเก่า โน้ตคนไม่แตะ)
    if (payload.context_summary) {
      try {
        db.upsertAiAutoNote(customerId, payload.context_summary);
      } catch (err) {
        logger.debug?.(`scorer: อัปเดตโน้ต ai_auto ไม่สำเร็จ (${err?.message || err})`);
      }
    }

    // v1.1 (item 7): ป้าย intent จาก scorer — เขียนทับชุด 'ai' ทั้งชุด (อ่านสดทุกรอบ)
    // ป้าย rfm/human ไม่โดนแตะ; ล้มเหลว = เงียบ
    try {
      const current = db.listTags(customerId);
      const previousAi = current.filter((t) => t.source === "ai").map((t) => t.tag);
      if (tagFrameworkNow) {
        // กรอบป้ายชุดเดียว: รวมกับป้ายเดิมตามกติกาแต่ละมิติ (สะสม/เดินหน้า/ค่าล่าสุด)
        // ป้ายข้อความอิสระรุ่นเก่าในห้องนี้ถูกแปลงเข้ากรอบครั้งแรกที่ scorer แตะห้อง
        const merged = mergeFrameworkTags({
          framework: tagFrameworkNow,
          previous: previousAi,
          next: payload.tags || [],
          humanTags: current.filter((t) => t.source === "human").map((t) => t.tag),
          personaType: payload.persona_type,
          facts: tagFactsFor(customerId),
        });
        if (merged.length || previousAi.length) db.replaceSourceTags(customerId, "ai", merged);
      } else if (payload.tags?.length || previousAi.length) {
        db.replaceSourceTags(customerId, "ai", payload.tags || []);
      }
    } catch (err) {
      logger.debug?.(`scorer: บันทึกป้าย intent ไม่สำเร็จ (${err?.message || err})`);
    }

    // G6 (P2): scorer จับคำสั่งซื้อที่ตกลงชัดเจน + score >= 8 -> สร้างออเดอร์ร่างให้แอดมิน
    // admin-facing เท่านั้น — ไม่มีข้อความไปหาลูกค้า; เงื่อนไข/ราคา/กันซ้ำอยู่ใน orders.mjs
    maybeCaptureDraftOrder({ db, customerId, payload, logger });
    if (jevReview.enabled && (salesSignals?.opportunity?.handoffReady || payload.out_of_band_reply === true)) {
      const isCurrent = () => sessionStillCurrent(customerId, sessionId)
        && safeLatestInboundMessageId(customerId) === scoringInboundId;
      await reviewJevForWorkflow(jevReview, { customerId, sessionId, turnId: scoringInboundId,
        stage: "handoff", customer, history: turns,
        latestText: turns.filter(turn => turn.role === "user").at(-1)?.content || "",
        knowledge: renderSalesPolicyReplySummary(salesPolicy),
        proposedAction: payload.out_of_band_reply ? "out_of_band_handoff" : "project_handoff",
        isCurrent });
      if (jevReview.mode === "enforce" && !isCurrent()) return payload;
      // Slot/OOB detectors have facts outside the short conversation window.
      // Until those facts have a validated judge contract, this is advisory:
      // an "information" verdict cannot cancel a required project handoff.
    }
    maybeHandoffOpportunity(customerId, salesSignals);
    maybeHandleOutOfBand(customerId, payload,
      turns.filter((turn) => turn?.role === "user").slice(-5).map((turn) => String(turn.content || "")));
    return payload;
  }

  // facts ที่กรอบป้ายอาจให้ชนะคำเดาของ scorer (ตอนนี้ใช้เฉพาะ ai_level ที่คนยืนยัน — ดู factSources)
  function tagFactsFor(customerId) {
    try {
      const fact = db.getCustomerFact?.(customerId, "ai_level");
      return fact ? { ai_level: { value: Number(fact.value), source: fact.source } } : {};
    } catch {
      return {};
    }
  }

  // Public API remains scoreBurst(customerId), but duplicate callers share one
  // in-flight run. A later caller after completion starts a new, serialized run.
  function scoreBurst(customerId) {
    const key = String(customerId);
    const current = scoringRuns.get(key);
    if (current) return current;
    const run = scoringQueue.run(key, () => scoreBurstImpl(customerId));
    const queuedAt = Date.now();
    scoringRuns.set(key, run);
    run.finally(() => {
      if (scoringRuns.get(key) === run) scoringRuns.delete(key);
      if (trailingScheduledScores.delete(key)) startScheduledScore(customerId);
      projectPromises.settle(customerId, queuedAt);
    }).catch(() => {});
    return run;
  }

  function startScheduledScore(customerId) {
    scoreBurst(customerId).catch((err) => {
      logger.debug?.(`scorer: ล้มเหลว (${err?.message || err}) — ไม่มีผลกับแชท`);
    });
  }

  // G7.2: จัดการสัญญาณ out-of-band — คืน true เมื่อ trigger จริง; ทุกความล้มเหลว = เงียบ
  // (advisory — ห้ามกระทบแชท) ลำดับ: cooldown 24 ชม. -> mark -> pause -> audit -> โน้ต -> ธง
  function maybeHandleOutOfBand(customerId, payload, recentCustomerTexts = []) {
    if (payload?.out_of_band_reply !== true) return false;
    if (String(customerId).startsWith("canary:")) return false;
    try {
      if (mentionsOwnerEventReference(recentCustomerTexts)) {
        db.addAudit({
          operator: "system", action: "out_of_band_skipped_event", target: customerId,
          detail: "scorer สงสัยแอดมินตอบนอกระบบ แต่ลูกค้าเล่าถึงสิ่งที่เจ้าของพูดในงาน/สัมมนา/คลาส/ไลฟ์ — ไม่พัก AI (F14)",
        });
        return false;
      }
      const last = Number(db.getSetting(oobLastKey(customerId)));
      if (Number.isFinite(last) && Date.now() - last < OUT_OF_BAND_COOLDOWN_MS) return false;
      db.setSetting(oobLastKey(customerId), String(Date.now()));
      db.setOperatorActiveUntil(customerId, Date.now() + OUT_OF_BAND_PAUSE_MS);
      db.addAudit({
        operator: "system", action: "out_of_band_pause", target: customerId,
        detail: `สงสัยแอดมินตอบนอกระบบ (OA Manager) — AI พัก ${OUT_OF_BAND_PAUSE_MS / 60_000} นาที`,
      });
      db.addHandoffNote({ customerId, author: "ai_auto", text: OUT_OF_BAND_NOTE });
      db.setNeedsHuman(customerId, "out_of_band",
        "ลูกค้าอ้างถึงคำตอบแอดมินที่ไม่อยู่ในประวัติระบบ — อาจคุยกันใน OA Manager/โทรศัพท์");
      logger.warn?.(`pipeline: สงสัยแอดมินตอบนอกระบบ customer=${customerId} — AI พัก ${OUT_OF_BAND_PAUSE_MS / 60_000} นาที`);
      return true;
    } catch (err) {
      logger.error?.(`pipeline: out-of-band handling ล้มเหลว (${err?.message || err})`);
      return false;
    }
  }

  // ยิง scorer แบบ fire-and-forget หลังตอบลูกค้าเสร็จ — ใช้ macrotask (setTimeout 0)
  // เพื่อให้เส้นทาง reply + งาน microtask ที่ค้างอยู่จบก่อนเสมอ ห้ามหน่วง/ห้ามล้ม reply
  function scheduleScoring(customerId) {
    if (String(customerId).startsWith("canary:")) return; // ลูกค้าสังเคราะห์ไม่ต้อง score
    setTimeout(() => {
      const key = String(customerId);
      if (scoringRuns.has(key)) {
        // A direct call still shares the current promise; only a newly scheduled
        // inbound turn marks the transcript dirty and earns a trailing rerun.
        trailingScheduledScores.add(key);
        return;
      }
      startScheduledScore(customerId);
    }, 0);
  }

  // จุดเข้าอีเวนต์จาก webhook (inbound ถูก log ใน DB แล้วจากชั้น server)
  // W3: ctx.channelId มาจาก channel ที่ verify HMAC สำเร็จ — customer key ต่อสาขา
  // (ไม่ส่ง ctx = โหมด legacy channel เดียว: key = raw user id เหมือนเดิม)
  async function handleEvent(event, ctx = {}) {
    if (event?.type !== "message") return { skipped: "not_message" };
    const userId = event.source?.userId;
    if (!userId) return { skipped: "no_user" };
    const message = event.message || {};
    const customerId = ctx.channelId ? customerKey(ctx.channelId, userId) : userId;
    if (ctx.expectedSessionId && !sessionStillCurrent(customerId, ctx.expectedSessionId)) {
      return { suppressed: "session_rotated_before_pipeline" };
    }

    if (message.type === "text") {
      return handleInboundText({
        customerId,
        text: message.text || "",
        replyToken: event.replyToken || "",
        // v1.2.1 (feedback พี่ง้วง): เก็บ quoteToken ไว้ให้ reply ของบอท quote ข้อความลูกค้า
        quoteToken: message.quoteToken || "",
        expectedSessionId: ctx.expectedSessionId || null,
        turnId: ctx.turnId || null,
      });
    }
    if (message.type === "image") {
      // v1.4.48 (คำสั่งเจ้าของ 2026-08-29): จำแนกรูปก่อน — ของจริงลูกค้าส่งรูปโพสต์มาถาม
      // ว่า "สอนอันนี้ไหม" บ่อยกว่าส่งสลิป การตีเป็นเรื่องเงินทุกใบทำให้ลีดดีที่สุดตายเงียบ
      // และห้องติดธงเงินถาวรที่ปลดได้ทางเดียวคือลบบทสนทนาทั้งห้อง (db.mjs resetCustomer)
      //
      // fail closed เคร่งครัด: ต้องได้ kind === "other" จากการจำแนกที่สำเร็จเท่านั้น
      // ตัวจำแนกโยน error / คืนค่าเพี้ยน / สวิตช์ปิด -> ตกกลับเส้นเดิมทั้งหมด
      // ผลจำแนกต้องมองเห็นได้ "นอก" บล็อกนี้ด้วย — บล็อกเส้นเงินข้างล่างใช้มันตัดสินว่า
      // จะปักธงเงินถาวรหรือไม่ (เคสจริง 2026-09-05: ธงเงินจากรูปที่จำแนกไม่ได้ วางยาห้องถาวร)
      let verdict = null;
      if (imageClassify?.enabled) {
        // F6 (ตรวจย้อนหลัง ก.ย. 2026): no_file = ไฟล์ยังดาวน์โหลดไม่เสร็จในหน้าต่างรอ (รูปจากมือถือบนเน็ตช้า
        // หลุดหน้าต่างบ่อย) — ลองอีกครั้งเดียวก่อนตัดสิน ตัวจำแนกรอเองอีกหนึ่งหน้าต่างและปลุกตัวดาวน์โหลดให้
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            verdict = await imageClassify.classify({ customerId, messageId: String(message.id || "") });
          } catch (err) {
            logger.warn?.("pipeline: จำแนกรูปล้ม (" + (err?.message || err) + ") — ถือเป็นเรื่องเงินไว้ก่อน customer=" + customerId);
            // ตัวจำแนกโยน error = "ลองดูรูปแล้วแต่ล้ม" ไม่ใช่ "ไม่เคยแตะรูป" — ต่างกันที่ธงเงิน
            verdict = { kind: "unknown", description: "", reason: `ตัวจำแนกโยน error: ${err?.message || err}`, reasonCode: "model_error" };
          }
          if (verdict?.reasonCode !== "no_file") break;
        }
      }
      // Observation only: this must happen once after the classifier attempt
      // (including disabled/failed attempts) and must never affect routing,
      // flags, sends, or model calls.
      try {
        inboundImageOutcome?.record?.({
          customerId,
          messageId: String(ctx.turnId || ""),
          providerMessageId: String(message.id || ""),
          verdict,
          classifierEnabled: imageClassify?.enabled === true,
        });
      } catch {
        logger.warn?.("pipeline: image outcome observation unavailable");
      }
      if (imageClassify?.enabled) {
        if (verdict && verdict.kind === "other") {
          logger.debug?.("pipeline: รูปไม่ใช่เรื่องเงิน — คุยต่อตามปกติ customer=" + customerId);
          const desc = String(verdict.description || "").trim();
          return handleInboundText({
            customerId,
            text: desc ? "(ลูกค้าส่งรูปมา: " + desc + ")" : "(ลูกค้าส่งรูปมา ไม่เกี่ยวกับการชำระเงิน)",
            replyToken: event.replyToken || "",
            expectedSessionId: ctx.expectedSessionId || null,
            // turnId ต้องเดินทางมาถึงที่นี่ด้วย ไม่งั้นเทิร์นนี้ไม่มีวันขึ้นสถานะ 'sending'
            // -> ตายกลางส่งแล้วถูกจำแนกเป็น "ยังไม่มีใครตอบ" ทั้งที่ลูกค้าได้ข้อความไปแล้ว
            // -> แอดมินอ่านธงนั้นแล้วพิมพ์ซ้ำ ลูกค้าได้คำตอบสองรอบ
            turnId: ctx.turnId || null,
          });
        }
      }
      // ---- เคสจริง 2026-09-05 (พี่ง้วงแจ้งเอง): ธงเงินจากรูปที่ "ไม่รู้ว่าอะไร" ----
      //
      // IMAGE_CLASSIFY_ENABLED ไม่เคยถูกตั้งในโปรดักชันจนถึงคืนนี้ รูปขาเข้าทุกใบจึงเดินเส้นเงิน
      // เต็มรูปแบบ: ปิด AI + ปักธง money_seen_at ถาวร ผลคือ 14 ห้องปิดตายใน 7 วัน และเมื่อเอา
      // รูปทั้ง 14 ใบมาจำแนกย้อนหลังด้วยตัวจำแนกจริง ได้ "other" 9 ใบ สลิปจริงใบเดียว
      // (อีก 3 ใบเกตเวย์ตอบ HTTP 400 เพราะรูป 1,067,264 ไบต์ใหญ่เกิน ดู MAX_CLASSIFY_BYTES)
      //
      // ธงเงินคือสิ่งที่แย่ที่สุดในสามอย่าง เพราะปลดไม่ได้ด้วยมือ (ต้องลบบทสนทนาทั้งห้อง) และ
      // paymentStartedFor อ่านมันตลอดไป -> ทุกคำว่า "ใบเสร็จ/ใบกำกับ/สลิป" หลังจากนั้นถูกปัด
      // ด้วยแม่แบบเอกสารการชำระเงิน คือวงจรที่พี่ง้วงเห็นในห้องจริงวันนี้
      //
      // แยกสองอย่างออกจากกัน:
      //   ปิด AI + ปักธงรอคนตรวจ = ยังทำทุกใบเหมือนเดิม (fail-closed ทางเงินยังอยู่ครบ)
      //   ปักธงเงินถาวร          = เฉพาะเมื่อ "รู้ว่าเป็นเรื่องเงินจริง" (ตัวจำแนกบอกว่า
      //                            slip/document) หรือห้องนี้มีเรื่องเงินค้างอยู่แล้ว
      // และเขียนเหตุผลลง audit ให้ ops แยกออกว่า "เกตเวย์ปฏิเสธรูป 1MB" ต่างจาก "สวิตช์ยังปิด"
      const imageMoneyKind = isMoneyImageKind(verdict?.kind);
      // "เคยเห็นไบต์ของรูปแล้วแต่จำแนกไม่ออก" ยังนับเป็นบริบทเงิน (ดู IMAGE_NO_ATTEMPT_CODES)
      const imageClassifyTried = Boolean(verdict) && !IMAGE_NO_ATTEMPT_CODES.has(String(verdict.reasonCode || ""));
      const imageMoneyContext = imageMoneyKind || imageClassifyTried || paymentStartedFor(customerId);
      const imageWhy = imageMoneyKind
        ? `ตัวจำแนกบอกว่าเป็น ${verdict.kind}`
        : `จำแนกไม่ได้ (${String(verdict?.reason || "").trim() || (imageClassify?.enabled ? "ไม่ทราบสาเหตุ" : "สวิตช์จำแนกรูปปิดอยู่")})`
          + (imageClassifyTried ? " แต่ระบบเห็นไบต์ของรูปแล้ว จึงยังเป็นสลิปได้" : "")
          + (imageMoneyContext ? " · ห้องนี้ถือเป็นบริบทเงิน" : " และห้องนี้ยังไม่เคยมีเรื่องเงิน");

      // สลิป/เอกสาร -> human review เท่านั้น ห้าม OCR ห้ามตอบยอด (บทเรียน Fern)
      const imageReviewSummary = verdict?.reasonCode === "no_file"
        ? "ระบบยังรับไฟล์รูปไม่สำเร็จ — กรุณาตรวจรูปในช่องทางต้นทาง; ยังไม่ได้จำแนกว่าเป็นสลิปหรือเอกสาร"
        : "ลูกค้าส่งรูป (อาจเป็นสลิป/เอกสาร) — รอคนตรวจ";
      const imageReviewPersisted = escalate(customerId, "image_review", imageReviewSummary, { markMoney: imageMoneyContext });
      // v1.5.2 (probe-money-02 ตกจริง 2026-08-30): เดิมสลิปเข้าแล้ว "ติดธงแต่ AI ยังเปิด"
      // ลูกค้าจี้ถามยอดต่อ บอทก็ตอบ template เงินวนซ้ำ — จังหวะเงินต้องเป็นของคนจริง 100%
      // ปิด AI ทันทีแบบเดียวกับเส้นแจ้งโอนด้วยข้อความ (sticky, เปิดคืนได้จากคอนโซล)
      // จุดนี้อยู่ "หลัง" ตัวจำแนกรูปตัดสินแล้ว — รูปที่จำแนกได้ว่าไม่ใช่เรื่องเงินไม่มาถึงบรรทัดนี้
      // F6 (ตรวจย้อนหลัง ก.ย. 2026 — D666, D775): รูปที่ "ยังไม่รู้ว่าอะไร" ในห้องที่ไม่มีเรื่องเงินเลย
      // เคยปิด AI ถาวรเหมือนสลิป — ปิด AI เฉพาะเมื่อเป็นบริบทเงินเท่านั้น (ธงรอคน + push ยังเหมือนเดิม)
      try {
        const imgCustomer = db.getCustomer(customerId);
        if (imgCustomer && imgCustomer.ai_enabled === 1 && imageMoneyContext) {
          db.setAiEnabled(customerId, false, "money_line");
          // ธงเงินถาวรเฉพาะเมื่อรู้จริงว่าเป็นเรื่องเงิน — รูปที่จำแนกไม่ได้ในห้องที่ไม่มีเงิน
          // ต้องปลดได้ด้วยการกดเปิด AI คืนในคอนโซล ไม่ใช่ต้องลบบทสนทนาทั้งห้อง
          if (imageMoneyContext) markMoneySeen(customerId, "money_line");
          db.addAudit({
            operator: "system", action: "ai_off_payment_image", target: customerId,
            detail: `ลูกค้าส่งรูป — ปิด AI รอคนตรวจ (เปิดคืนได้ในคอนโซล) · ${imageWhy}`
              + ` · ธงเงินถาวร=${imageMoneyContext ? "ปัก" : "ไม่ปัก"}`,
          });
        } else if (isNotQualifiedRow(imgCustomer) && imageMoneyContext) {
          // 5 ต.ค. 2026: รูปเส้นเงินในห้องสีเหลือง = ห้องเงินของคน ไม่ใช่ห้องที่ตัวกวาดเปิด/ปิดได้อีก
          // สลับเหตุเป็น money_line แบบเดียวกับ bank_sent ด้านล่าง + ปักธงเงิน (เหลืองไม่เคยมีเรื่องเงินมาก่อน)
          db.setAiEnabled(customerId, false, "money_line");
          markMoneySeen(customerId, "money_line");
          db.addAudit({
            operator: "system", action: "ai_off_payment_image", target: customerId,
            detail: `ลูกค้าส่งรูปในห้องสีเหลือง (not_qualified) — สลับเป็นเส้นเงิน รอคนตรวจ · ${imageWhy}`,
          });
        } else if (imgCustomer?.ai_enabled === 0 && imgCustomer.ai_off_reason === "bank_sent") {
          // v1.4.11b: รูปเข้าหลังส่งเลขบัญชี — สลับเหตุปิดเป็น money_line
          // (2026-09-05: FU หยุดตั้งแต่ AI ปิดอยู่แล้ว การสลับเหตุตอนนี้จึงมีไว้เพื่อปักธงเงิน
          //  ให้ paymentHold/คอนโซลอ่านออก ไม่ใช่เพื่อหยุด FU อีกต่อไป)
          db.setAiEnabled(customerId, false, "money_line");
          db.addAudit({ operator: "system", action: "payment_slip_while_ai_off", target: customerId, detail: "รูปเข้าหลังส่งเลขบัญชี — FU หยุดทวงโอน รอคนตรวจสลิป" });
        } else if (imgCustomer?.ai_enabled === 1) {
          db.addAudit({
            operator: "system", action: "image_review_ai_on", target: customerId,
            detail: `ลูกค้าส่งรูปในห้องที่ยังไม่มีเรื่องเงิน — AI คุยต่อ + ส่งข้อความตอบรับ รอคนตรวจรูป · ${imageWhy}`,
          });
        }
      } catch (err) {
        logger.error?.(`pipeline: ปิด AI หลังรับรูปเส้นเงินล้มเหลว (${err?.message || err})`);
      }
      if (imageReviewPersisted) {
        const reviewCustomer = db.getCustomer(customerId);
        notifier?.fireLater({ customerId, channelId: reviewCustomer?.channel_id || "default",
          reason: "image_review", customerName: reviewCustomer?.known_name || reviewCustomer?.display_name || "" });
      }
      // G3: pre-check สลิปให้แอดมิน (fire-and-forget) — เส้นทางตอบลูกค้าไม่เปลี่ยนทุกกรณี
      if (slipCheck?.enabled) {
        const { accessToken } = outboundFor(customerId);
        setTimeout(() => {
          slipCheck.checkImage({ customerId, messageId: message.id || "", accessToken }).catch((err) => {
            logger.debug?.(`slipCheck: ล้มเหลว (${err?.message || err}) — ไม่มีผลกับแชท`);
          });
        }, 0);
      }
      // F6: ห้องที่ AI ยังคุยต่อ = ตอบรับหนึ่งบรรทัด (ห้องเงินยังเงียบรอคนตามกติกาเดิม)
      if (!imageMoneyContext) {
        const ack = await sendMediaAck({
          customerId, replyToken: event.replyToken || "", turnId: ctx.turnId || null,
          text: brandText(IMAGE_ACK_TEMPLATE), route: "media_review",
        });
        if (!ack.suppressed) return ack;
        if (ack.suppressed === "media_ack_repeat") return { suppressed: "image_ack_repeat", route: "media_review" };
      }
      // Internal handoff is not a delivered customer reply.
      return { suppressed: "media_review", route: "media_review" };
    }
    if (message.type === "file") {
      // Files/PDFs are not images: do not OCR, infer payment from a filename,
      // or silently skip them while automated replies/follow-ups continue.
      const customer = db.getCustomer(customerId);
      if (!customer) return { skipped: "no_customer" };
      // F5 (ตรวจย้อนหลัง ก.ย. 2026): ไฟล์ทุกไฟล์เคยปิดห้องถาวร + push โดยบอทไม่พูดอะไร — ลีดสายคอนเทนต์
      // ส่งคลิป/ไฟล์งานระหว่างคุย 5 ใน 8 ห้องไม่เคยมีคนตอบ · 4 เคสที่ถูกคือห้องที่ทีมคุยอยู่แล้ว (ลูกค้าที่จ่ายแล้ว
      // ส่งใบหัก ณ ที่จ่าย/ห้อง in-house ของทีม) ซึ่ง 2 ใน 4 ห้อง "ไม่มีธงเงินใน DB" (จ่ายนอกสายตาระบบ)
      // แต่มีคนจริงตอบในห้องมาก่อนทุกห้อง
      // ส่วนห้องที่ผิดเป็นห้องลีดที่ลูกแพรคุยคนเดียวล้วน ๆ — จึงคงพฤติกรรมเดิมไว้ทั้งห้องเงินและห้องที่คนจริง
      // เคยตอบ (ห้องของทีม) เปลี่ยนเฉพาะห้องลีดที่ AI ดูแลเองซึ่งไม่เคยมีเรื่องเงิน
      const humanManaged = Number(db.lastOperatorOutboundAt?.(customerId) || 0) > 0;
      const staffRoom = paymentStartedFor(customerId) || humanManaged;
      const persisted = escalate(customerId, "file_review", staffRoom
        ? "ลูกค้าส่งไฟล์แนบ — รอทีมเปิดตรวจในแชท ยังไม่ได้ยืนยันว่าเป็นเอกสารชำระเงิน"
        : "ลูกค้าส่งไฟล์แนบในห้องที่ยังไม่มีเรื่องเงิน — AI คุยต่อ ทีมเปิดดูไฟล์ในแชทเมื่อสะดวก",
        { markMoney: false });
      if (staffRoom) {
        // รีวิวปรปักษ์ 5 ต.ค. #2/#19: ห้องสีเหลืองของทีมก็ต้องเป็น file_review (เหตุของคน sticky) — เดิมข้ามเพราะ ai_enabled=0
        // ห้องจึงค้าง not_qualified + NEEDS_HUMAN หลุดคิวรอตอบ แล้วคำถามราคาถัดไปเปิดเขียวให้ AI ตอบทับห้องที่รอทีมตรวจไฟล์
        // (แบบเดียวกับรูปเส้นเงินในห้องเหลืองที่สลับเป็น money_line)
        if (customer.ai_enabled === 1 || isNotQualifiedRow(customer)) db.setAiEnabled(customerId, false, "file_review");
        db.addAudit({ operator: "system", action: "file_review", target: customerId,
          detail: "ไฟล์แนบส่งเข้าคิวคนตรวจ · AI ปิด · ไม่ปักธงเงินจากชนิดไฟล์" });
        if (persisted) notifier?.fireLater({ customerId, channelId: customer.channel_id || "default",
          reason: "file_review", customerName: customer.known_name || customer.display_name || "" });
        return { suppressed: "file_review", route: "file_review" };
      }
      // ห้องลีดที่ยังไม่มีเรื่องเงินและยังไม่มีคนจริงเข้ามา: AI คุยต่อ · ธงคิวรอคนอยู่ครบ · ไม่ปลุกทีม · โน้ตให้ทีมเห็น · ตอบรับหนึ่งบรรทัด
      db.addAudit({ operator: "system", action: "file_review", target: customerId,
        detail: "ไฟล์แนบในห้องที่ยังไม่มีเรื่องเงิน · AI คุยต่อ + ข้อความตอบรับ · ไม่ปลุกทีม (ธงคิวรอคนยังอยู่)" });
      try {
        db.addHandoffNote({ customerId, author: "ai_auto",
          text: brandText(`${FILE_REVIEW_NOTE_PREFIX} (ห้องนี้ยังไม่มีเรื่องเงิน) — เปิดดูไฟล์ในแชทเมื่อสะดวก · ลูกแพรตอบรับแล้วและยังคุยต่อ`) });
      } catch (err) {
        logger.warn?.(`pipeline: เขียนโน้ตไฟล์แนบไม่สำเร็จ (${err?.message || err})`);
      }
      const ack = await sendMediaAck({
        customerId, replyToken: event.replyToken || "", turnId: ctx.turnId || null,
        text: brandText(FILE_ACK_TEMPLATE), route: "file_review",
      });
      // รีวิวเคสจริง 6–7 ต.ค.: ไฟล์ที่ตามมาในชุดเดียวกัน = เงียบโดยเจตนาพร้อมเหตุที่อ่านออก (บัญชีเทิร์นจด silent_by_design · file_ack_repeat)
      if (ack.suppressed === "media_ack_repeat") return { suppressed: "file_ack_repeat", route: "file_review" };
      return ack.suppressed ? { suppressed: "file_review", route: "file_review" } : ack;
    }
    if (message.type === "audio") {
      // B3: ข้อความเสียง -> ถอดความแล้ววิ่ง pipeline ปกติ / พังทุกกรณี = template + รอคน
      return handleInboundAudio({
        customerId,
        messageId: message.id || "",
        replyToken: event.replyToken || "",
        expectedSessionId: ctx.expectedSessionId || null,
        turnId: ctx.turnId || null,
      });
    }
    // sticker/อื่น ๆ: log อย่างเดียว (ชั้น server) ไม่ตอบอัตโนมัติใน G1a
    return { skipped: message.type };
  }

  // ---- B3: เส้นทางข้อความเสียง ----
  // สำเร็จ = log transcript เป็น inbound แล้วเข้าทาง text ปกติ (burst/queue ของเดิม)
  // ล้มเหลวทุกแบบ (ปิดฟีเจอร์/โหลดพัง/ถอดพัง/ว่างเปล่า) = ธง audio_review + template สุภาพ
  function handleInboundAudio({ customerId, messageId, replyToken = "", expectedSessionId = null, turnId = null }) {
    // Reserve the same queue before the first transcriber await. Otherwise an
    // immediately following /reset could rotate+ACK while this older audio was
    // still being decoded, then let its reply escape into the new session.
    return queue.run(customerId, () => processInboundAudio({
      customerId, messageId, replyToken, expectedSessionId, turnId,
    }));
  }

  async function processInboundAudio({ customerId, messageId, replyToken, expectedSessionId, turnId = null }) {
    db.upsertCustomer(customerId, {});
    if (expectedSessionId && !sessionStillCurrent(customerId, expectedSessionId)) {
      return { suppressed: "session_rotated_before_pipeline" };
    }
    let result = { ok: false, reason: "transcriber_missing" };
    if (transcriber) {
      try {
        // W3: ดาวน์โหลดเสียงด้วย token ของสาขาที่ลูกค้าคนนี้สังกัด
        result = await transcriber.transcribe({ messageId, accessToken: outboundFor(customerId).accessToken });
      } catch (err) {
        logger.warn?.(`pipeline: transcriber พัง (${err?.message || err})`);
        result = { ok: false, reason: "transcriber_error" };
      }
    }
    if (result.ok) {
      db.insertMessage({
        customerId,
        direction: "in",
        msgType: "text",
        content: `[เสียงถอดความ] ${result.text}`,
      });
      return respondToBurst({ customerId, text: result.text, replyToken, expectedSessionId, turnId });
    }

    // ธงรอคนติดเสมอ — เสียงต้นฉบับต้องมีคนฟังใน LINE (เราไม่เก็บ binary)
    const handoffPersisted = escalate(
      customerId,
      "audio_review",
      `ถอดความเสียงไม่สำเร็จ (${result.reason}) — ให้คนฟังต้นฉบับใน LINE`,
    );
    return sendAudioFallback({ customerId, replyToken, reason: result.reason, handoffPersisted, turnId });
  }

  async function sendAudioFallback({ customerId, replyToken, reason, handoffPersisted, turnId = null }) {
    // เคารพ gate เดิมทุกชั้น: AI ปิด = เงียบ (แอดมินเห็นธง audio_review อยู่แล้ว)
    if (aiPausedNow({ db, config })) return { suppressed: "ai_paused", route: "audio_fallback", reason };
    const gate = controlGate.open(customerId);
    if (!gate.allowedToThink) return { suppressed: "ai_disabled", route: "audio_fallback", reason };
    // B2: แอดมินกำลังดูแลอยู่ = ไม่ต้องส่ง template แทรก
    const customer = db.getCustomer(customerId);
    if ((Number(customer?.operator_active_until) || 0) > Date.now()) {
      return { suppressed: "operator_active", route: "audio_fallback", reason };
    }
    // Schedule Gate: นอกเวลาทำการ = ไม่ส่ง template แทรก (ธง audio_review ติดแล้ว)
    const sched = scheduleState({ db });
    if (sched.enabled && !sched.active) {
      return { suppressed: "schedule_off", route: "audio_fallback", reason };
    }
    if (!gate.confirmBeforeSend()) return { suppressed: "ai_disabled_before_send", route: "audio_fallback", reason };

    const fallbackText = brandText(handoffPersisted
      ? AUDIO_FALLBACK_TEMPLATE
      : "ขออภัยค่ะ ยังฟังข้อความเสียงไม่ชัด รบกวนพิมพ์สั้น ๆ ได้ไหมคะ");
    const bubbles = [{ text: fallbackText }];
    const { lineCh, to } = outboundFor(customerId, customer);
    // ขอบเขตที่ template ก้อนนี้ครอบ = ข้อความล่าสุดของลูกค้า ณ ก่อนยิง (เหตุผลเดียวกับเส้นหลัก)
    const inboundBasisAt = db.lastInboundAt(customerId) || 0;
    // เส้นนี้ก็ส่งถึงลูกค้าจริง จึงต้องคอมมิต 'sending' ก่อนไบต์แรกเหมือนเส้นหลัก
    // ไม่งั้นตายกลางส่งแล้วบูตใหม่จะบอกแอดมินว่า "ยังไม่มีใครตอบ" ทั้งที่ template ออกไปแล้ว
    markSendingIfNeeded(turnId);
    const sendResult = await lineCh.sendBubbles({ to, replyToken, bubbles, images: [], purpose: SEND_PURPOSE.customerReply });
    if (sendResult.ok) {
      // เส้นนี้ก็เป็นคำตอบของเทิร์นจริง — ต้องรู้ว่าเกิดใต้สมองรุ่นไหนเหมือนเส้นหลัก
      const audioBrain = resolveBrain(customerId, customer?.channel_id ?? null);
      db.insertMessage({
        customerId, direction: "out", msgType: "text",
        content: fallbackText, messageClass: "reactive", agentMode: "ai",
        settleTurnsUpTo: inboundBasisAt,
        brainVersionId: audioBrain?.versionId ?? null,
        freeclassPatterns: audioBrain ? audioBrain.bundle.rules.freeclassPatterns : null,
      });
    } else if (!sendResult.blocked) {
      escalate(customerId, "send_failed", `LINE ส่งไม่สำเร็จ (${sendResult.status ?? "?"})`);
    }
    // ส่ง sendResult กลับไปด้วย เพื่อให้บัญชีเทิร์นแยก "ถูกปิดกั้นโดยกติกาเรา"
    // ออกจาก "ยิงแล้วล้มจริง" ได้ — ไม่งั้นทั้งสองอย่างถูกจดเป็นความล้มเหลวเหมือนกันหมด
    return { sent: sendResult.ok === true, sendResult, route: "audio_fallback", deterministic: true, reason };
  }

  // รีวิวเคสจริง 6–7 ต.ค. (ไฟล์ 7 ไฟล์ = ข้อความตอบรับเดิม 7 ครั้ง): ข้อความล่าสุดของห้อง (ข้ามไฟล์/รูป/สติกเกอร์ที่ลูกค้าส่งตามมา)
  // คือข้อความตอบรับเดียวกันที่ส่งภายใน MEDIA_ACK_REPEAT_WINDOW_MS = ไม่ส่งซ้ำ · มีใครพิมพ์อะไรคั่น (ลูกค้าพิมพ์ ลูกแพร/ทีมตอบ) = ตอบรับใหม่ได้
  // อ่านพัง = ส่งตามเดิม (ข้อความซ้ำดีกว่าลูกค้าเงียบ)
  // รอบรีวิว 8 (C7): ไฟล์ รูป ไฟล์ รูป สลับกัน ได้ข้อความตอบรับ 4 ครั้ง (นับเฉพาะแม่แบบเดียวกัน) — ข้อความตอบรับไฟล์หรือรูปตัวใดก็นับ
  const MEDIA_ACK_TEXTS = new Set([FILE_ACK_TEMPLATE, IMAGE_ACK_TEMPLATE, brandText(FILE_ACK_TEMPLATE), brandText(IMAGE_ACK_TEMPLATE)]);
  function mediaAckRepeats(customerId, text) {
    try {
      const rows = db.messagesFor(customerId, 30);
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row.direction === "in") {
          if ((row.msg_type || "text") === "text") return false;
          continue;
        }
        const sent = String(row.content || "");
        return (row.msg_type || "text") === "text" && (sent === String(text) || (MEDIA_ACK_TEXTS.has(sent) && MEDIA_ACK_TEXTS.has(String(text))))
          && Date.now() - Number(row.created_at || 0) <= MEDIA_ACK_REPEAT_WINDOW_MS;
      }
    } catch (err) {
      logger.debug?.(`pipeline: อ่านข้อความล่าสุดก่อนตอบรับไฟล์ไม่สำเร็จ (${err?.message || err}) — ส่งตามเดิม`);
    }
    return false;
  }

  // F5/F6 (ตรวจย้อนหลัง ก.ย. 2026): ข้อความตอบรับไฟล์/รูปในห้องที่ AI ยังคุยต่อ
  // เคารพด่านเดิมทุกชั้นแบบเดียวกับแม่แบบเสียง: พักทั้งระบบ / AI ปิด / แอดมินกำลังตอบ / นอกเวลา = ไม่ส่ง
  // วิ่งในคิวของลูกค้าคนนั้น (ลำดับเดียวกับคำตอบข้อความ) และผ่านด่าน compliance เหมือนข้อความระบบอื่น
  function sendMediaAck({ customerId, replyToken = "", turnId = null, text, route }) {
    return queue.run(customerId, async () => {
      if (aiPausedForReactiveCustomer({ db, config, customerId })) return { suppressed: "ai_paused", route };
      const gate = controlGate.open(customerId);
      if (!gate.allowedToThink) return { suppressed: "ai_disabled", route };
      const customer = db.getCustomer(customerId);
      if ((Number(customer?.operator_active_until) || 0) > Date.now()) return { suppressed: "operator_active", route };
      const sched = scheduleState({ db });
      if (sched.enabled && !sched.active) return { suppressed: "schedule_off", route };
      if (mediaAckRepeats(customerId, text)) return { suppressed: "media_ack_repeat", route };
      const brain = resolveBrain(customerId, customer?.channel_id ?? null);
      if (!guard.checkOutbound(text, guardScope(brain)).ok) {
        logger.warn?.("pipeline: ข้อความตอบรับไฟล์/รูปไม่ผ่าน compliance guard — ไม่ส่ง");
        return { suppressed: "media_ack_guard", route };
      }
      if (!gate.confirmBeforeSend()) return { suppressed: "ai_disabled_before_send", route };
      const { lineCh, to } = outboundFor(customerId, customer);
      const inboundBasisAt = db.lastInboundAt(customerId) || 0;
      markSendingIfNeeded(turnId);
      const sendResult = await lineCh.sendBubbles({ to, replyToken, bubbles: [{ text }], images: [], purpose: SEND_PURPOSE.customerReply });
      if (sendResult.ok) {
        db.insertMessage({
          customerId, direction: "out", msgType: "text",
          content: text, messageClass: "reactive", agentMode: "ai",
          settleTurnsUpTo: inboundBasisAt,
          brainVersionId: brain?.versionId ?? null,
          freeclassPatterns: brain ? brain.bundle.rules.freeclassPatterns : null,
        });
      } else if (!sendResult.blocked) {
        escalate(customerId, "send_failed", `LINE ส่งไม่สำเร็จ (${sendResult.status ?? "?"})`);
      }
      return { sent: sendResult.ok === true, sendResult, route, deterministic: true };
    });
  }

  // หมุด "ขอเช็คคิวก่อน" (followup_state.defer_json) — พังห้ามกระทบการตอบลูกค้า
  function recordScheduleCheckMarker(customerId, text) {
    try {
      if (!scheduleCheckFollowupEnabled(db)) return;
      const atMs = db.lastInboundAt(customerId) || Date.now();
      const next = nextScheduleCheckMarker({ markerJson: db.getFollowupState(customerId)?.defer_json, text, atMs });
      if (next === undefined) return;
      db.setFollowupDefer(customerId, next ? JSON.stringify(next) : "");
      if (next) {
        db.addAudit({
          operator: "system", action: "schedule_check_deferral", target: customerId,
          detail: next.hint ? `ลูกค้าขอเช็คคิว/วันก่อน บอกว่าจะแจ้งกลับ ${next.hint}` : "ลูกค้าขอเช็คคิว/วันก่อน",
        });
      }
    } catch (err) {
      logger.debug?.(`pipeline: จดหมุดขอเช็คคิวไม่สำเร็จ (${err?.message || err}) — ไม่มีผลกับการตอบ`);
    }
  }

  // heldParts (รีวิวปรปักษ์ 5 ต.ค. #9): ข้อความที่ลูกค้าพิมพ์ระหว่างห้องเหลืองซึ่งยังไม่มีใครตอบ — ผู้เรียกที่ส่ง
  // ข้อความค้างเข้าเส้นตอบอีกครั้ง (qualifyAnswerPending: ตัวกวาดเปิดเขียว / คนกดเปิด AI ทับห้องเหลือง) ส่งมาให้นำหน้าเทิร์น
  // ไม่ส่ง = เทิร์นเดิมทุกไบต์
  function handleInboundText({ customerId, text, replyToken = "", quoteToken = "", expectedSessionId = null, turnId = null, heldParts = [] }) {
    // v1.4.12 (คำสั่งพี่ง้วง 2026-08-18): นักเรียนเล่นกิจกรรมพิมพ์คีย์เวิร์ดขึ้นต้นด้วย #
    // (เช่น #horeca) — LINE OA มี auto-response ตอบคีย์เวิร์ดอยู่แล้ว ลูกแพรต้องเงียบ
    // "เฉพาะข้อความนั้น" (ไม่เข้า burst จึงไม่ปนกับเทิร์นอื่น) ข้อความถัดไปคุยปกติทันที
    // — ข้อความถูก log ที่ webhook ก่อนถึงจุดนี้แล้ว ประวัติ/ตัวจับเวลา FU ไม่หาย
    const rawText = String(text || "");
    if (expectedSessionId && capturedSession(customerId) !== expectedSessionId) {
      return Promise.resolve({ suppressed: "session_rotated_before_pipeline" });
    }
    // Resolve configured keywords before the ordinary-text gates. Bare campaign
    // codes do not match CAMPAIGN_KEYWORD by design, so regex-only gating would
    // misclassify their seed as a real customer instruction. Consent and safety
    // still win when an owner accidentally configures a reserved phrase such as "unsubscribe".
    const ingressBrain = resolveBrain(customerId);
    let seededKeyword = resolveBusinessHashtag(
      rawText, hashtagBusinessKeywords({ db, config, brain: ingressBrain }),
    );
    if (seededKeyword && !/^[#@]/u.test(seededKeyword.tag)) {
      const rawRoute = routeMessage({
        text: rawText, extraRules: safetyRules, identityTemplate, paymentTemplate,
        paymentStarted: paymentStartedFor(customerId),
        botAskedDocQuestion: botAskedDocQuestionFor(customerId),
      });
      if (rawRoute?.optOut || rawRoute?.route === "quiet_stop" || isPrioritySafetyRoute(rawRoute)) {
        seededKeyword = null;
      }
    }
    const configuredCampaign = Boolean(seededKeyword);
    const campaignKeyword = CAMPAIGN_KEYWORD.test(rawText);
    if (config.serviceBoundaryEnabled && !campaignKeyword && !configuredCampaign) {
      db.upsertCustomer(customerId, {});
      const before = db.getCustomer(customerId);
      const intent = classifyServiceIntent(rawText, before, { preset: isPresetButtonTap(rawText, presetButtonPhrases({ db })) });
      if (intent) db.setServiceBoundaryState(customerId, nextServiceState(before, intent));
    }
    // Stop scheduled sales follow-up synchronously, including when reactive AI is
    // already off or a follow-up draft is awaiting its provider. Only the actual
    // customer text counts: campaign seed text is not a customer instruction.
    if (config.customerFollowupSuppressionEnabled && !campaignKeyword && !configuredCampaign) {
      db.upsertCustomer(customerId, {});
      const sessionId = capturedSession(customerId);
      if (sessionId && (!expectedSessionId || expectedSessionId === sessionId)) {
        const signal = classifyFollowupSuppression(rawText);
        if (signal) {
          const before = db.getCustomer(customerId);
          db.suppressFollowupsForCustomer(customerId, signal.reason);
          if (before.followup_enabled !== 0 || before.followup_suppression_reason !== signal.reason) {
            db.addAudit({ operator: "system", target: customerId, action: "followup_suppressed", detail: signal.reason });
          }
        }
      }
    }
    // 2026-09-28 (คำสั่งพี่ง้วง "ขอเช็คคิวก่อน"): หมุดของห้อง = ทักหนึ่งครั้งแทนบันไดปกติ — เดินทุกข้อความลูกค้า
    // (ตัวเดิน/เหตุผลอยู่ที่ scheduleCheck.mjs · สวิตช์ settings.schedule_check_followup ปิด = ไม่เขียนอะไร)
    if (!campaignKeyword && !configuredCampaign) recordScheduleCheckMarker(customerId, rawText);
    // ข้อ 8 ของพี่ง้วง (28 ก.ย. 2026): คีย์เวิร์ดที่เจ้าของติ๊กไว้ = ติดป้าย ของแจก:/กิจกรรม: ให้ทันที
    // ทั้งคำที่ลูกแพรตอบเองและคำที่ปล่อยให้ LINE OA ตอบ (ไม่มีกติกา/กรอบปิด = ไม่ทำอะไร · ล้มเหลว = เงียบ)
    if (campaignKeyword) {
      applyHashtagTagRule({ db, customerId, text: rawText, framework: activeTagFramework(db, tagFramework), logger });
    }
    // 11 ต.ค. 2026 แคมเปญ #AIAGENT: เฉพาะข้อความที่ "ขึ้นต้น" ด้วยคีย์เวิร์ดของแคมเปญที่เปิดอยู่ — รับคำขอ + ตอบรับครั้งเดียว
    // แทนความเงียบของ # (คำตอบ AI ปกติไม่เกิดกับข้อความนี้) · match อ่านอย่างเดียว คืน null = เส้นเดิมทุกไบต์
    const blueprintHit = campaignKeyword && blueprintCampaign ? blueprintCampaign.match({ customerId, text: rawText }) : null;
    if (blueprintHit) {
      return queue.run(customerId, () => blueprintCampaign.intake({ ...blueprintHit, customerId, text: rawText, replyToken, turnId, expectedSessionId }));
    }
    // v1.4.46: แยกสองเส้นให้ชัด — # เป็นของ LINE OA auto-response (ไม่รู้จัก = เงียบ ห้ามตอบซ้อน)
    // ส่วน @ ไม่มีใครตอบแทน (ไม่รู้จัก = คุยปกติ) การลอกพฤติกรรม # มาใช้กับ @ จะทำให้
    // ลูกค้าที่พิมพ์คำนอกรายการเงียบหาย ซึ่งเป็นอาการที่ตรวจเจอจริงเมื่อ 24-27 ส.ค.
    let campaignDelivery = "";
    if (seededKeyword) {
      logger.debug?.(`pipeline: คีย์เวิร์ดกิจกรรมในรายการอนุญาต (${seededKeyword.tag}) — คุยต่อตามปกติ customer=${customerId}`);
      text = seededKeyword.text;
      campaignDelivery = seededKeyword.deliveryText || "";
      // โน้ตกิจกรรม — ลูกค้าที่ทักมาด้วยคีย์เวิร์ดมักพิมพ์คำเดียวเป็นข้อความแรกสุด
      // ระบบจึงยังไม่รู้อะไรเลยเกี่ยวกับเขา โน้ตนี้คือสิ่งเดียวที่บอกได้ว่ามาจากงานไหน
      const campaignNote = seededKeyword.note ||
        (config.businessId === "pngoung-tidkradum" && seededKeyword.tag.startsWith("#")
          ? `ที่มา: กิจกรรม ${seededKeyword.tag} ที่ตั้งค่าไว้` : "");
      if (campaignNote) {
        // v1.4.46: ต้องมีแถวลูกค้าก่อน — setHashtagNote เป็น UPDATE ล้วน ถ้ายังไม่มีแถว
        // โน้ตจะหายเงียบ ๆ ซึ่งคือ **ทุกคนที่พิมพ์คีย์เวิร์ดเป็นข้อความแรก** = กรณีหลัก
        // ที่ฟีเจอร์นี้ถูกสร้างมารองรับ (ของจริงบันทึกได้แค่ 1 คน ตรวจเมื่อ 2026-08-28)
        db.upsertCustomer(customerId, {});
        db.setHashtagNote?.(customerId, campaignNote);
      }
    } else if (hashtagSilenceEnabled({ db, config, brain: ingressBrain }) && HASHTAG_KEYWORD.test(rawText)) {
      logger.debug?.(`pipeline: ข้าม hashtag keyword (auto-response ของ LINE OA ตอบเอง) customer=${customerId}`);
      return Promise.resolve({ suppressed: "hashtag_auto_response" });
    }
    // v1.4.47: ขอคน/ฉุกเฉิน/ร้องเรียน/เงินเป็น deterministic template อยู่แล้ว —
    // อย่ารอ debounce หรือ draft ปกติที่เริ่มก่อนหน้า. จองคิว safety ก่อน แล้ว abort
    // เฉพาะ Hermes call เก่า; queue เดิมยังเป็นเจ้าของ DB + LINE send เพียงเส้นเดียว.
    const ingressRoute = routeMessage({
      text, extraRules: safetyRules, identityTemplate, paymentTemplate,
      paymentStarted: paymentStartedFor(customerId),
      botAskedDocQuestion: botAskedDocQuestionFor(customerId),
    });
    if (isPrioritySafetyRoute(ingressRoute)) {
      bumpPrioritySafety(customerId, +1);
      carryParts.delete(customerId);
      const safetyRun = queue.run(customerId, async () => {
        try {
          return await respondToBurst({
            customerId,
            text,
            replyToken,
            quoteToken,
            expectedSessionId,
            turnId,
            parts: [String(text || "")],
            prioritySafety: true,
          });
        } finally {
          bumpPrioritySafety(customerId, -1);
        }
      });
      activeReplyDrafts.get(customerId)?.abort(new Error("priority safety message arrived"));
      burst.flush(customerId);
      return safetyRun;
    }
    if (campaignDelivery) {
      return queue.run(customerId, () => respondToBurst({
        customerId, text, replyToken, quoteToken, expectedSessionId, turnId,
        parts: [String(text || "")], campaignDelivery,
      }));
    }
    // Start burst coalescing now, but reserve the customer queue synchronously
    // before awaiting debounce. This makes webhook order authoritative: a reset
    // invoked on the next line cannot jump ahead of this ordinary event.
    // รีวิวปรปักษ์ 5 ต.ค. #9: ข้อความค้างระหว่างเหลืองฝากไว้ในชุด "ยกไปรวม" (carry) ไม่ผูกกับก้อนนี้ — ถ้าลูกค้าพิมพ์ต่อ
    // จนก้อนนี้ถูกรวมเข้าก้อนใหม่ ก้อนที่ได้ตอบจริงยังเห็นครบ · ชุดค้างระหว่างพัก (pauseHeld) ตัดส่วนที่ซ้ำกับ carry ให้เอง
    const yellowHeldParts = (Array.isArray(heldParts) ? heldParts : [])
      .map((part) => String(part ?? "").trim()).filter(Boolean).slice(-10);
    if (yellowHeldParts.length) {
      carryParts.set(customerId, { parts: [...(carryParts.get(customerId)?.parts || []), ...yellowHeldParts], at: Date.now() });
    }
    const burstResult = burst.push({ key: customerId, text, quoteToken });
    bumpWaiting(customerId, +1);
    return queue.run(customerId, async () => {
      bumpWaiting(customerId, -1);
      const resolved = await burstResult;
      if (resolved.role === "absorbed") {
        // ข้อความก่อนหน้าใน burst — ไม่มี reply ของตัวเอง
        return { absorbed: true };
      }
      // v1.4.46: ข้อความที่ก้อนก่อนหน้าพักไว้ (เพราะเห็นว่าเรากำลังพิมพ์ต่อ) รวมเข้าก้อนนี้
      const carried = takeCarry(customerId);
      const incoming = [...carried, ...(resolved.parts || [])];
      // 2026-09-28: ข้อความที่พิมพ์ระหว่าง AI พัก (คนเพิ่งตอบ) แล้วไม่มีใครตอบ ต้องอยู่ในเทิร์นนี้ด้วย —
      // ประวัติที่โมเดลเห็นตัดแถวลูกค้าท้ายห้องทิ้งหมด ชุดนั้นจึงเคยหายเงียบ (pauseHeld.mjs; ว่าง = เทิร์นเดิมทุกไบต์)
      const held = heldPausePartsForTurn(db, {
        customerId, incoming, isMoneyRoom: paymentStartedFromRow, isCampaignText: (value) => CAMPAIGN_KEYWORD.test(value), logger,
      });
      const parts = [...held, ...incoming];
      return respondToBurst({
        customerId, text: carried.length || held.length ? parts.join("\n") : resolved.combinedText, replyToken, expectedSessionId, turnId,
        // quote ข้อความล่าสุดใน burst — ลูกค้าเห็นชัดว่าบอทตอบข้อความไหน
        quoteToken: resolved.quoteToken || "",
        // v1.4.45: ข้อความแยกรายบอลลูน — ให้โมเดลเห็นว่าเป็นคนละข้อความ ไม่ใช่ก้อนเดียว
        parts,
      });
    });
  }

  // 20 ต.ค. 2026 (ขั้นที่ 3 ของแผน soul): ทั้งเทิร์นของห้องนี้ (ร่าง ด่าน ส่ง จด meta) ใช้ soul รุ่นของห้อง — ตัดสินครั้งเดียวต่อเทิร์น
  function respondToBurst(args) {
    return withRoomSoul(args?.customerId, () => respondToBurstInRoom(args));
  }

  async function respondToBurstInRoom({ customerId, text: inboundText, replyToken, quoteToken = "", expectedSessionId = null, parts: inboundParts = [], prioritySafety = false, turnId = null, campaignDelivery = "" }) {
    // 2026-09-04 (เคสจริง Facebook 12:14 UTC): ลูกค้ากดปุ่มคำถามสำเร็จรูป "คิดค่าบริการเท่าไหร่"
    // สามครั้งในสองวินาที burst รวมมาเป็นสามบรรทัดเหมือนกัน โมเดลอ่านเป็นการทวงแล้วเทราคา
    // ใส่คนแปลกหน้า — ยุบ "การกดปุ่ม" ตั้งแต่ตรงนี้ ก่อนที่ข้อความจะไปถึง route / ด่านขาเข้า /
    // คำตัดสินจังหวะราคา / พรอมต์: กดปุ่มเดียวสามครั้ง = หนึ่งบรรทัด · กดสี่ปุ่มติดกัน = หนึ่งเทิร์น
    // ที่ไล่ทุกเจตนา · ข้อความที่พิมพ์เองผ่านไปทุกไบต์เหมือนเดิม
    // แถว messages ที่ webhook เขียนไว้แล้วไม่ถูกแตะ (ความจริงของ audit) — นี่คือมุมมองของเทิร์นนี้
    // รายการปุ่มอ่านครั้งเดียวต่อเทิร์น ใช้ทั้งกับก้อนนี้และกับมุมมองประวัติข้างล่าง
    const presetPhrases = presetButtonPhrases({ db });
    const inboundView = collapseInboundBurst({ text: inboundText, parts: inboundParts, list: presetPhrases });
    const { text, parts } = inboundView;
    // กันเคสเรียกตรงโดยยังไม่มีแถวลูกค้า (default TRUE/AI_ACTIVE ตาม Fern)
    db.upsertCustomer(customerId, {});
    const sessionId = capturedSession(customerId);
    if (!sessionId || (expectedSessionId && sessionId !== expectedSessionId)) {
      return { suppressed: "session_rotated_before_pipeline" };
    }
    // Capture the canonical inbound turn before any drafting await. A burst is
    // represented by its final local inbound row; that links the whole room
    // without claiming this last message is the customer's entire question.
    const correctionInboundMessageId = String(turnId || safeLatestInboundMessageId(customerId) || "");
    // ฐานเทียบของด่านกันตอบทับ (ล่างสุดก่อนส่ง): ข้อความล่าสุดของลูกค้า ณ ตอนเริ่มคิด
    // webhook เขียน inbound ลง DB ก่อนเรียก pipeline เสมอ ค่านี้จึงนับข้อความก้อนนี้ไปแล้ว
    const inboundBasisAt = db.lastInboundAt(customerId) || 0;

    // ---- F2: ดึงชื่อจริงจากข้อความ (deterministic, ก่อน gate — บันทึกแม้ AI ปิด) ----
    const extractedName = extractKnownName(text);
    // v1.4.8 (เคสคุณมนตรี): ชื่อในบริบทบุคคลที่สาม (ส่งทีมงานมาเรียน/ผู้ติดต่อ) ห้ามเขียน
    // และห้ามทับชื่อเดิมที่ไม่ว่างด้วยชื่อใหม่ที่ต่างกัน (แอดมิน/ค่าที่ยืนยันแล้วชนะ)
    if (extractedName && !nameLooksThirdParty(extractedName, text)) {
      try {
        const existing = String(db.getCustomer(customerId)?.known_name || "");
        if (!existing || existing === extractedName) db.setKnownName(customerId, extractedName);
      } catch (err) {
        logger.warn?.(`pipeline: บันทึก known_name ไม่สำเร็จ (${err?.message || err})`);
      }
    }

    // ---- v1.4 Lifecycle shadow: จับ facts + เลื่อนสถานะย่อยฝั่งขาย (ก่อน gate —
    // จับได้แม้ AI ปิด เพราะคนคุยอยู่ข้อมูลลูกค้าก็ยังเดิน) — พังห้ามกระทบแชท ----
    try {
      lifecycle.applyInbound({ customerId, text });
    } catch (err) {
      logger.warn?.(`pipeline: lifecycle ขาเข้าล้มเหลว (${err?.message || err}) — ไม่มีผลกับแชท`);
    }

    // ---- v1.4.48 (cutover แผน B 2026-08-23): โยงกับห้องระบบเก่าด้วยชื่อโปรไฟล์ ครั้งเดียวต่อคน ----
    // ต้องอยู่ "ก่อน" ด่านป้าย customer ข้างล่าง เพราะผลการโยงคือสิ่งที่ติดป้าย customer ให้
    // ลูกค้าเก่า — ถ้าโยงทีหลัง บอทจะตอบลูกค้าเก่าไปหนึ่งเทิร์นก่อนเงียบ
    // โปรไฟล์ถูกดึงแบบ fire-and-forget ที่ webhook (F1) และ burst รอ 10 วิ ก่อนถึงจุดนี้
    // ชื่อจึงมาถึงก่อนเสมอในทางปฏิบัติ — ถ้ายังไม่มีชื่อ (no_name) จะไม่ตัดสิน แล้วลองใหม่เทิร์นหน้า
    // (จงใจไม่ดึงโปรไฟล์ซ้ำตรงนี้ เพื่อไม่ให้มี profile call ซ้อนกับของ webhook)
    try {
      const current = db.getCustomer(customerId);
      if (current && !current.legacy_link) {
        // F7 (ตรวจย้อนหลัง ก.ย. 2026): ตัดสินป้าย customer อัตโนมัติจาก "ข้อความที่ลูกค้าพิมพ์เอง" ในห้องนี้
        // (แถวใน DB คือข้อความดิบ — ไม่ใช่ประโยค seed ของคีย์เวิร์ดกิจกรรมที่ไปป์ไลน์แทนให้)
        const typedSoFar = db.recentTurns(customerId, 6).filter((turn) => turn.role === "user").map((turn) => turn.content);
        const link = linkLegacyByName({
          db, customerId, displayName: current.display_name || "", logger, notifier,
          inboundTexts: typedSoFar.length ? typedSoFar : [text],
        });
        if (link.state === "candidate") {
          db.addAudit({
            operator: "system", action: "legacy_link_candidate_by_name", target: customerId,
            detail: "ชื่อตรงหนึ่งห้อง — คุยต่อแบบลูกค้าใหม่ (ห้ามอ้างประวัติ) รอพนักงานยืนยันก่อนคัดลอกป้าย",
          });
        }
      }
    } catch (err) {
      logger.warn?.(`pipeline: โยงระบบเก่าด้วยชื่อไม่สำเร็จ (${err?.message || err}) — ไปต่อแบบไม่โยง`);
    }

    // ---- v1.4.30 (พี่ง้วงกำหนด 2026-08-19): ป้าย "customer" = ชมพู่รับช่วงคุยเองยาว ๆ ----
    // เฟสนี้ตั้งใจให้คนดูแลลูกค้าที่ซื้อแล้วเต็มตัว บอทต้องเงียบสนิท ไม่ใช่แค่ตอบน้อยลง
    // ทำผ่านสวิตช์ ai_enabled เดิมเพราะทุกอย่างที่ต้องหยุดถูกผูกไว้กับมันหมดแล้ว
    // (follow-up ทุกชนิด, scorer, การทักตามสเตจ) — สร้างทางเงียบเส้นใหม่จะหลุดสักอย่างแน่
    //
    // ตรวจทุกเทิร์นแทนที่จะเชื่อตอนกดป้ายอย่างเดียว: ป้ายเข้ามาได้หลายทาง (คอนโซล/sync)
    // ถ้าเช็คแค่ตอนกด แล้ววันหนึ่งมีเส้นทางใหม่ บอทจะกลับมาคุยกับลูกค้าเก่าโดยไม่มีใครรู้
    // ข้อความขาเข้ายังถูกบันทึกตามปกติ (ด่านล่างทิ้งเฉพาะการตอบ) ประวัติจึงไม่ขาดตอน
    try {
      const silentTag = db.listTags(customerId)
        .map((row) => String(row.tag))
        .find((tag) => silentTagReason(tag));
      const reason = silentTag ? silentTagReason(silentTag) : null;
      const customerNow = reason ? db.getCustomer(customerId) : null;
      // 5 ต.ค. 2026: ห้องสีเหลืองก็ถูกป้ายทับ — ป้ายที่คนติดชนะการตัดสินของตัวกวาด (ไม่งั้นตัวกวาดเปิดเขียวคืนเองได้)
      if (customerNow?.ai_enabled === 1 || isNotQualifiedRow(customerNow)) {
        db.setAiEnabled(customerId, false, reason);
        db.addAudit({
          operator: "system", action: "ai_off_customer_handover", target: customerId,
          detail: `ป้าย "${silentTag}" — บอทเงียบถาวรจนกว่าจะปลดป้ายและเปิด AI ในคอนโซล`,
        });
      }
    } catch (err) {
      // อ่านป้ายพังต้องไม่ทำให้แชททั้งเส้นล้ม — แต่ต้องดังพอให้เห็น เพราะถ้าเงียบ
      // บอทจะกลับไปคุยกับลูกค้าที่ทีมงานดูแลอยู่
      logger.error?.(`pipeline: อ่านป้ายลูกค้าไม่สำเร็จ (${err?.message || err}) — บอทอาจตอบลูกค้าที่ทีมงานดูแลอยู่`);
    }

    // Route is text-driven plus one durable read (paymentStartedFor) — resolve it before
    // reply preemption so durable inbound consent (opt-out/DND) is never lost just because
    // a newer safety reply wins. audit 2026-08-24: อ่านสถานะเงิน "ก่อน" side-effect ของเทิร์นนี้
    // เสมอ เพื่อให้ ingress กับเส้นหลักตัดสินด้วยข้อมูลชุดเดียวกัน
    let route = routeMessage({
      text, extraRules: safetyRules, identityTemplate, paymentTemplate,
      paymentStarted: paymentStartedFor(customerId),
      botAskedDocQuestion: botAskedDocQuestionFor(customerId),
    });
    // ---- คำสั่งพี่ง้วง 2026-09-05 (ออกแบบรอบสอง): กุญแจดอกที่ 1 ----
    //
    // รอบแรกใช้ regex บนข้อความลูกค้าเป็น "คำตัดสิน" เดี่ยว ๆ แล้วมันปิดห้องใส่คนที่แค่ถาม
    // ("ขอถามเรื่องจองหน่อยค่ะ") และพลาดคนที่ตัดสินใจจริง ("จอง 1 ที่ครับ") — regex อ่าน
    // ความตั้งใจในภาษาไทยไม่ออก รอบนี้มันจึงเป็นแค่ "ใบ้" ที่บอกลูกแพรว่าเรื่องนี้กำลังคุยกันอยู่
    // ส่วนคนที่ตัดสินว่า "ส่งไม้ต่อจริงหรือยัง" คือลูกแพรเอง ผ่านคำตอบที่เธอส่งถึงลูกค้า
    // (กุญแจดอกที่ 2 อยู่ในบล็อกหลังส่งสำเร็จ) — ห้องจะปิดก็ต่อเมื่อครบสองดอก
    //
    // เส้นทาง deterministic (urgent/complaint/payment/identity/optout/human_handoff) เป็น
    // เจ้าของ flow ของตัวเองครบอยู่แล้ว ทั้งถ้อยคำและการปิด AI — ใบ้นี้จึงเดินเฉพาะเทิร์น
    // ที่ลูกแพรเป็นคนคิดคำตอบเอง (route.template = null) ห้ามแทรกกลางเส้นอื่นเด็ดขาด
    //
    // ปุ่มสำเร็จรูปล้วน ๆ ไม่ใช่การตัดสินใจ ("จองคิวได้ไหม" คือปุ่มมาตรฐานของ Facebook) —
    // ถ้าในก้อนเดียวกันมีข้อความที่ลูกค้าพิมพ์เองปนอยู่ด้วย ให้ตัดสินจากข้อความจริงตามปกติ
    const turnButtons = presetButtonFact(inboundView.view);
    const handoffHint = route.template
      ? null
      : detectHandoffHint(text, {
        presetButton: turnButtons.fromPresetButton === true && turnButtons.typedAlongside !== true,
        previousTexts: recentInboundTexts(customerId, { currentText: text }),
      });
    // งาน project มี flow ส่งต่อของตัวเองครบแล้ว (เก็บ slot -> maybeHandoffOpportunity)
    // ปล่อยให้สองกลไกทับกัน = พรอมต์สั่งสวนกัน + ห้องปิดก่อนทีมได้ slot (ดู isClosingHandoffTurn)
    const handoffProject = resolveProjectOpportunity({
      currentText: text, salesPolicy, salesState: latestSalesState(customerId),
    });
    // สองคำถามคนละคำถาม (R6): พรอมต์ควรเปลี่ยนทรงไหม (handoffIntent) กับ ปิดห้องได้ไหม
    // (handoffClosure) — งาน project ตอบ "ไม่" ให้ข้อแรกเสมอ แต่คำขอติดต่อทีมงานปิดได้
    const handoffIntent = isClosingHandoffTurn(handoffHint, handoffProject) ? handoffHint : null;
    const handoffClosure = handoffClosureIntent(handoffHint, handoffProject);

    if (route.optOut) {
      try {
        db.setDoNotDisturb(customerId, true);
        const cancelled = db.cancelPendingFollowups(customerId, "customer_optout");
        db.addAudit({
          operator: "system", action: "followup_optout", target: customerId,
          detail: `ลูกค้าขอหยุดการทักไป — ยกเลิกนัดค้าง ${cancelled} รายการ`,
        });
      } catch (err) {
        logger.error?.(`pipeline: จัดการ opt-out ล้มเหลว (${err?.message || err})`);
      }
    }

    // Safety ingress has already reserved the next queue slot. Anything older
    // that has not crossed the LINE provider boundary yields now, including a
    // deterministic identity/opt-out template that never called Hermes. The
    // opt-out consent mutation above remains durable; only its stale copy yields.
    if (!prioritySafety && prioritySafetyPending(customerId)) {
      return { suppressed: "safety_preempted", stage: "before_route" };
    }

    // ---- v1.4.47: สวิตช์หยุด AI ทั้งระบบ (cutover) — ข้อมูลถูกบันทึก/ดึงชื่อ/จับ facts แล้ว
    // และ safety state ถูก persist แล้ว แต่จากนี้ไม่คิด ไม่ตอบ ไม่เสียเงินจนกว่าจะ kick off ----
    if (aiPausedForReactiveCustomer({ db, config, customerId })) {
      // โหมดร่างอย่างเดียว (2026-08-24): ปล่อยให้คิดตามเส้นปกติทุกด่าน แล้วไปสกัดที่
      // "ประตูส่ง" ท้ายทางซึ่งเช็ค pause ซ้ำอยู่แล้ว — ร่างสุดท้ายถูกเก็บเข้า Correction
      // Loop แทนการส่ง; escalation/sticky-off จะเกิดตามเส้นปกติ ไม่ทำซ้ำตรงนี้
      if (!aiPausedDraftModeOn({ db, config })) {
        const { stickyAiOffReason } = persistRouteEscalation(customerId, route, text);
        applyStickyAiOff(customerId, stickyAiOffReason);
        if (route.route === "quiet_stop") return finishQuietStop(customerId, text);
        logger.debug?.(`pipeline: AI paused ทั้งระบบ — บันทึกแล้วไม่ตอบ customer=${customerId}`);
        return { suppressed: "ai_paused", route: route.route };
      }
      logger.debug?.(`pipeline: AI paused + โหมดร่าง — คิดเพื่อเก็บร่างให้แอดมิน (ไม่ส่ง) customer=${customerId}`);
    }

    // ---- 5 ต.ค. 2026 (คำสั่งพี่ง้วง): ห้องสีเหลือง "AI off (not qualify)" ที่ตัวกวาดคัดกรองปิดเอง ----
    // ต้องอยู่ "ก่อน" ประตู AI: ประตูอ่าน ai_enabled ครั้งเดียวต่อเทิร์น (false แล้ว sticky ทั้งเทิร์น)
    //   · เรื่องด่วน/ร้องเรียน/ขอคุยกับคน/ขอหยุด หรือสัญญาณซื้อ (จอง เงิน สมัคร รอบเรียน) = เปิดเขียวทันที
    //     แล้วเดินเส้นปกติในเทิร์นนี้เลย — ห้องเหลืองต้องไม่กลืนคำร้องเรียนหรือคนที่พร้อมจ่าย
    //   · ข้อความอื่น = ยังเหลือง ปักกุญแจให้ตัวกวาดตรวจซ้ำภายในไม่กี่นาที แล้วเงียบตามเดิม
    // ห้องที่ปิดด้วยเหตุอื่น (คน/เงิน/ส่งต่อ ...) ไม่ผ่านบล็อกนี้เลย — เหมือนเดิมทุกไบต์
    // รีวิวปรปักษ์ 5 ต.ค. #7: งานทีม/in-house อ่านจากตัวจับ project ของระบบ (เฉพาะข้อความนี้ ไม่ใช่หมุดเก่าใน sales state)
    // รีวิวปรปักษ์ 5 ต.ค. #9: เปิดเขียวแล้ว ข้อความที่ลูกค้าพิมพ์ระหว่างเหลืองต้องอยู่ในเทิร์นนี้ด้วย (yellowHeld)
    //   ประวัติที่โมเดลเห็นตัดแถวลูกค้าท้ายห้องทิ้งหมด — เดิมโมเดลเห็นแค่ข้อความล่าสุดแล้วตอบผิดบริบท
    let yellowHeld = [];
    let yellowReclaimed = false;
    try {
      const yellowTurn = handleNotQualifiedTurn({
        db, customerId, customer: db.getCustomer(customerId), logger,
        messageId: correctionInboundMessageId,
        incoming: inboundParts.length ? inboundParts : [String(inboundText || "")],
        signalInput: {
          route, prioritySafetyRoute: isPrioritySafetyRoute(route), handoffHint, text,
          projectOpportunity: salesPolicy ? detectDirectOpportunityType(text, salesPolicy) : null,
          // 12 ต.ค. 2026: ห้องที่ตีจบนอกเรื่องแล้ว — ข้อความที่ยังนอกเรื่องไม่เปิดเขียวทันที (อ่านเฉพาะห้องนั้น)
          ...(offtopicCloser?.cueOf ? { offtopicCueOf: () => offtopicCloser.cueOf(text) } : {}),
        },
      });
      if (yellowTurn.reclaimed && yellowTurn.heldParts?.length) yellowHeld = yellowTurn.heldParts;
      yellowReclaimed = yellowTurn.reclaimed === true;
    } catch (err) {
      logger.warn?.(`pipeline: ตรวจห้องสีเหลืองไม่สำเร็จ (${err?.message || err}) — ห้องคงสถานะเดิม`);
    }
    // มุมมองของโมเดลในเทิร์นนี้ (ว่าง = เหมือนเดิมทุกไบต์) · route/ด่านราคาตัดสินจากข้อความเทิร์นนี้ไปแล้ว ไม่เปลี่ยน text
    const turnParts = yellowHeld.length ? [...yellowHeld, ...(parts.length ? parts : [text])] : parts;

    // ---- control gate อ่านครั้งที่ 1: ก่อนคิด ----
    const gate = controlGate.open(customerId);
    if (!gate.allowedToThink) {
      // v1.4.11b (audit จับ): "โอนแล้วค่ะ" ตอน AI ปิด (เช่นหลังส่งเลขบัญชี) ห้ามตกหลุมเงียบ
      // — bot ยังไม่ตอบตามคำสั่ง แต่ต้อง (1) push แจ้งแอดมินด่วน (2) เขียน payment_review
      // ลง handoff (paymentHold ของ FU อ่านบรรทัดนี้) (3) สลับเหตุปิดเป็น money_line เพื่อ
      // ปักธงเงินให้ paymentHold/คอนโซลอ่านออก (2026-09-05: FU หยุดตั้งแต่ AI ปิดแล้ว
      // การสลับเหตุจึงไม่ได้มีไว้หยุด FU อีกต่อไป แต่ยังจำเป็นสำหรับธงเงิน)
      try {
        if (isPaymentActionText(text)) {
          const customerNow = db.getCustomer(customerId);
          if (customerNow && customerNow.ai_off_reason !== "money_line") {
            db.setNeedsHuman(customerId, "payment_review", "ลูกค้าแจ้งโอนระหว่าง AI ปิด — คนตรวจยอดด่วน");
            markMoneySeen(customerId, "money_line");
            db.setAiEnabled(customerId, false, "money_line");
            db.addAudit({
              operator: "system", action: "payment_declared_while_ai_off", target: customerId,
              detail: `เหตุปิดเดิม=${customerNow.ai_off_reason || "manual"} — push แจ้งทีม + FU หยุดทวงโอน`,
            });
            notifier?.fireLater({
              customerId,
              channelId: customerNow.channel_id || "default",
              reason: "payment_review",
              customerName: customerNow.known_name || customerNow.display_name || "",
              force: true,
            });
          }
        }
      } catch (err) {
        logger.error?.(`pipeline: จัดการแจ้งโอนตอน AI ปิดล้มเหลว (${err?.message || err})`);
      }
      // v1.5.x: ห้องที่เพิ่งส่งต่องาน project — ข้อความแรกที่ตามมาคือคำตอบของคำถามที่บอท
      // ถามค้างไว้ (ส่วนใหญ่คือเบอร์) ต้องปลุกทีมงานทันที ไม่ใช่รอให้ใครเปิดคิวเจอเอง
      maybeNotifyHandoffReply(customerId, text);
      // ปิดอยู่ = ทิ้งเงียบ (ข้อความถูก log แล้ว) — เปิดใหม่ไม่ replay ของเก่า
      return { suppressed: "ai_disabled" };
    }

    const reviewCurrent = () => sessionStillCurrent(customerId, sessionId)
      && db.getCustomer(customerId)?.ai_enabled === 1
      && !aiPausedForReactiveCustomer({ db, config, customerId })
      && (db.lastInboundAt(customerId) || 0) <= inboundBasisAt
      && (!correctionInboundMessageId || safeLatestInboundMessageId(customerId) === correctionInboundMessageId);
    let jevRouteReview = null;
    if (jevReview.enabled && !campaignDelivery) {
      jevRouteReview = await reviewJevForWorkflow(jevReview, {
        customerId, sessionId, turnId: correctionInboundMessageId, stage: "route",
        customer: db.getCustomer(customerId), latestText: text,
        history: historyBeforeCurrentInbound(db.recentTurns(customerId, config.historyTurns)),
        workflowPolicy: "การถามข้อมูลทั่วไปหรือทวงคำตอบที่ยังไม่ตอบ ให้ AI แก้คำตอบจากความรู้ได้ การขอคนจริง ตรวจยอดโอน คืนเงิน หรือยืนยันที่นั่งต้องให้คนรับผิดชอบ",
        proposedAction: route.escalate ? "human_review" : "allow", isCurrent: reviewCurrent,
      });
      if (jevReview.mode === "enforce" && !reviewCurrent()) return { suppressed: "jev_stale_route" };
      // Only a semantic complaint candidate can be overruled here. Money,
      // explicit human requests, identity transparency and urgent routes retain
      // their deterministic protections regardless of the judge's confidence.
      if (jevRouteReview.mode === "enforce" && route.route === "complaint"
          && jevRouteReview.action === "allow"
          && shouldContinueJev(jevRouteReview)) {
        route = { route: "normal", intent: "general", template: null };
        markJevApplied(jevRouteReview);
      }
    }

    // Keep the original active-runtime ordering: per-customer takeover wins.
    // Only the global-pause branch above persists safety state before this gate.
    const { routeEscalationPersisted, stickyAiOffReason } = persistRouteEscalation(customerId, route, text);
    // F4b: หยุดเงียบต้องเกิดก่อนด่านแอดมินกำลังตอบ/นอกเวลา — ไม่มีอะไรจะส่ง แต่การหยุดต้องถาวร
    if (route.route === "quiet_stop") {
      applyStickyAiOff(customerId, stickyAiOffReason);
      return finishQuietStop(customerId, text);
    }

    // ---- safety router: เส้นทาง deterministic ----
    let draftText;
    let approvedOutlineUrls = null;
    const mirrorIds = [];
    let deterministic = false;

    // อ่านสถานะลูกค้าหลังบันทึกชื่อ — ใช้ทั้ง context ชื่อ (F2) และกติกา/post-check score (F4)
    const customer = db.getCustomer(customerId);

    // ---- เคสจริง 2026-09-05: คำถามเอกสารก่อนซื้อ ต้องไม่หายไปจากสายตาทีมงาน ----
    // เส้นทางนี้จงใจไม่ปักธง NEEDS_HUMAN และไม่ปิด AI (นั่นคือความเสียหายที่พี่ง้วงแจ้ง)
    // แต่ "คนที่ถามเรื่องใบกำกับ/ใบเสร็จก่อนซื้อ" คือลีดร้อนที่ทีมควรตามต่อ จึงทิ้งโน้ตไว้ให้
    // มีคูลดาวน์ เพราะคำถามเอกสารมักมาติดกันหลายเทิร์น — โน้ตซ้ำจะดัน handoff_summary ของจริงตกขอบ
    if (route.intent === "document_presale") {
      try {
        const recentDocNote = db.listHandoffNotes(customerId, 10).some((note) => note.author === "ai_auto"
          && String(note.text || "").startsWith(DOC_PRESALE_NOTE_PREFIX)
          && Date.now() - Number(note.created_at || 0) < DOC_PRESALE_NOTE_COOLDOWN_MS);
        if (!recentDocNote) {
          db.addHandoffNote({
            customerId,
            author: "ai_auto",
            text: `${DOC_PRESALE_NOTE_PREFIX} (ระบบยังไม่พบรายการชำระเงินในห้องนี้) — ลูกค้าถามว่า: `
              + `"${String(text || "").replace(/\s+/gu, " ").trim().slice(0, 120)}"\n`
              + brandText("ลูกแพรตอบข้อมูลทั่วไปให้แล้ว (AI ยังเปิด) — ถ้าเขาสมัคร ทีมงานต้องออกเอกสารจริงให้"),
          });
        }
      } catch (err) {
        logger.warn?.(`pipeline: เขียนโน้ตคำถามเอกสารก่อนซื้อไม่สำเร็จ (${err?.message || err})`);
      }
    }
    const lastScore = Number.isInteger(customer?.last_score) ? customer.last_score : null;

    // ---- P2: สมองรุ่นของเทิร์นนี้ (ต้องอยู่ก่อนแยกเส้น template/AI) ----
    // เพราะ guard วิ่งกับ **ทั้งสอง** เส้น: template ที่พังเองก็ต้องเจอชุดตัวเลขชุดเดียวกัน
    // กับที่ prompt เห็น ไม่งั้นห้องฝั่ง canary จะถูกตัดด้วยตารางของ live (แบบแปลน §7)
    const brain = resolveBrain(customerId, customer?.channel_id ?? null);
    const brainVersionId = brain?.versionId ?? null;
    const guardTurn = guardScope(brain);
    const brainRows = brain ? { brainVersionId, freeclassPatterns: brain.bundle.rules.freeclassPatterns } : {};
    noteBrainVersionSwitch(customerId, brain, customer);

    // ---- B2: แอดมินเพิ่งตอบเองจาก console -> AI พักชั่วคราว (สองเสียงห้ามชนกัน) ----
    // เส้นทาง deterministic ที่ escalate (urgent/complaint/payment/กฎเฉพาะธุรกิจ) ยังยิงตามปกติ
    // side effect ก่อนหน้า (opt-out, ธง NEEDS_HUMAN) เกิดไปแล้ว — suppress เฉพาะ "การตอบ"
    const operatorActive = (Number(customer?.operator_active_until) || 0) > Date.now();
    if (operatorActive && !(route.template && route.escalate)) {
      notePausedHandoffRequest(customerId, handoffHint, customer);
      return { suppressed: "operator_active", route: route.route };
    }

    // ---- รีวิวเคสจริงทั้งวัน 5 ต.ค. (สวิตช์ v3 เท่านั้น): ลูกแพรลาแล้ว ลูกค้าตอบแค่คำรับ/อีโมจิ = ไม่คิด ไม่ส่ง ไม่โชว์กำลังพิมพ์ ----
    // เคสจริง: "ค่ะ" แล้ว "👍" หลังคำลาได้คำลาซ้ำอีกสองรอบ (เสียโมเดลสองยก) · คำขอบคุณหลังคำลาในเลนดูแลใจได้ "ยินดีค่ะ 😊"
    // อยู่หลังด่าน opt-out / ปิด AI / แอดมินกำลังตอบ (เหตุเงียบเดิมคงไว้) และก่อนข้อความนอกเวลา การแจ้งทีม กำลังพิมพ์ เลน และโมเดล
    // ไม่ดูเลนโดยเจตนา (ไม่มีถ้อยคำให้เป็นเจ้าของ) · ห้องที่เริ่มจ่ายเงินแล้วไม่ผ่านทางนี้ · บัญชีเทิร์นจดเป็นตั้งใจเงียบ
    if (!route.template && !campaignDelivery && !config.trainingMockMode && replyEngineMode(db) === "v3" && !paymentStartedFor(customerId)
      && silentAckTurn({ text, parts: turnParts.length ? turnParts : [text],
        history: historyBeforeCurrentInbound(db.recentTurns(customerId, config.historyTurns)) })) {
      logger.info?.(`reply_engine_silent ${JSON.stringify({ reason: "ack_after_farewell", customerId })}`);
      return { suppressed: "v3_silent_ack", route: route.route };
    }

    // ---- Schedule Gate: นอกเวลาทำการ = AI พัก (เช็คท้ายสุด — takeover/operator ชนะเสมอ) ----
    // ข้อความลูกค้าถูก log ครบแล้วจากชั้น webhook; เส้นทางฉุกเฉิน (template+escalate)
    // ยังยิงตามปกติ; ack อัตโนมัติ (ถ้าตั้ง template) ส่งครั้งเดียวต่อลูกค้าต่อช่วงปิด
    const sched = scheduleState({ db });
    if (sched.enabled && !sched.active && !(route.template && route.escalate)) {
      await maybeSendScheduleAck({ customerId, gate, sched, replyToken, guardTurn, brainRows });
      return { suppressed: "schedule_off", route: route.route };
    }

    // v1.1 (bug 5): push แจ้งทีมตามเหตุ — identity/complaint/urgent (+กฎเฉพาะธุรกิจ)
    // REVIEW FIX: ต้องอยู่หลังด่าน operator_active + schedule gate — ข้อความแจ้งทีมบอกว่า
    // "ระบบตอบเปิดเผยแล้ว" จึงยิงเฉพาะเมื่อเส้นทางตอบเดินจริง (identity ที่โดน suppress
    // = แอดมินกำลังดูแล/นอกเวลา ไม่มี reply ก็ไม่มีอะไรให้แจ้ง); fire-and-forget เสมอ;
    // v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): payment_review แจ้งด้วยแล้ว — จังหวะโอนเงิน
    // ต้องมีคนจริงรับช่วงเร็วที่สุด (มี cooldown 10 นาที/ลูกค้า กันแจ้งรัวอยู่แล้ว)
    if (notifier) {
      // 2026-09-28: identity ไม่ปลุกทีมแล้ว (ตอบความจริงแล้วคุยต่อ) — ขอคนจริงเมื่อไหร่ เส้น human_handoff แจ้งเอง
      const notifyReason = route.escalate?.reason;
      if (notifyReason) {
        const isCustomUrgent = route.route === "urgent"
          && notifyReason !== "urgent_medical"
          && notifyReason !== "urgent_mental";
        notifier.fireLater({
          customerId,
          channelId: customer?.channel_id || "default",
          reason: notifyReason,
          customerName: customer?.known_name || customer?.display_name || "",
          reasonTextOverride: isCustomUrgent
            ? `เข้ากฎฉุกเฉินเฉพาะธุรกิจ (${notifyReason}) — ต้องมีคนดูแลทันที`
            : "",
        });
      }
    }

    // ---- burst จบ + กำลังเริ่มคิด (AI/template) -> โชว์ "กำลังพิมพ์..." ฝั่งลูกค้า ----
    // fire-and-forget: best-effort ล้วน ๆ — ช้า/พังแค่ไหนห้ามหน่วงหรือล้มเส้นทางตอบ
    // W3: client/ปลายทางตามสาขาของลูกค้า (โหมด legacy = ของเดิมเป๊ะ)
    const outbound = outboundFor(customerId, customer);
    // โหมดร่าง: ลูกค้าต้องไม่เห็น "กำลังพิมพ์..." เพราะจะไม่มีคำตอบตามมา
    if (!aiPausedForReactiveCustomer({ db, config, customerId })) {
      outbound.lineCh.startLoading({ to: outbound.to, seconds: LOADING_SECONDS }).catch(() => {});
    }

    // ---- B1: key รูปที่ส่งไปแล้วใน 7 วัน "ของ session นี้" — บอก model + กรองก่อนส่ง
    // (v1.4.1: จำกัดต่อ session — รูปจาก session เทรนเก่าเคยบล็อกบทสนทนาใหม่ทั้ง 7 วัน) ----
    let sentImageKeys = [];
    try {
      sentImageKeys = db.recentImageKeys(customerId, Date.now() - IMAGE_DEDUPE_WINDOW_MS, sessionId);
    } catch (err) {
      logger.debug?.(`pipeline: อ่าน recentImageKeys ไม่สำเร็จ (${err?.message || err})`);
    }
    // v1.4.9: รูปบรรยากาศดูแบบ all-time ข้ามทุก session (evergreen มีแค่ 2 ใบ) เพื่อให้
    // reactive กับ staged FU กันซ้ำใบเดียวกันได้จริง แม้ข้าม session boundary (/reset)
    let sentAtmosphereKeys = [];
    try {
      sentAtmosphereKeys = db.recentImageKeys(customerId, 0).filter((key) => ATMOSPHERE_IMAGES.includes(key));
    } catch (err) {
      logger.debug?.(`pipeline: อ่าน atmosphere all-time ไม่สำเร็จ (${err?.message || err})`);
    }

    // v1.4.3 (เคสจริง 2026-08-15 ตี 2): history เคยประกาศไว้ในบล็อก AI path เท่านั้น
    // แต่ด่านกันแก้ราคาขึ้น (นอกบล็อก) กับตัวกันนกแก้วอ้างถึงด้วย — ReferenceError
    // "history is not defined" ทุกเทิร์น ทำให้ด่านราคาตายเงียบมาตลอด — hoist ขึ้นมา
    let history = [];
    let redraftWithExtraRule = null;
    let knowledgeSelection = null;
    let ownerLessonIds = []; // บทเรียนที่เจ้าของสอนซึ่งใส่ในพรอมต์เทิร์นนี้ (ownerLessons.mjs)
    // เครื่องตอบ v3 ร่างเทิร์นนี้ = ร่องรอยสำหรับแผง "ทำไมตอบแบบนี้" และรายงานแยกเครื่อง (null = เครื่องเดิม)
    // จดแม้ข้อความสุดท้ายถูกด่านแทนเป็นแม่แบบ — อัตราแม่แบบของเทิร์น v3 คือเกณฑ์ถอยกลับข้อหนึ่ง
    let replyEngineMeta = null;
    let previousReplyMeta = null;
    // 12 ต.ค. 2026: แผนตีจบของเทิร์นนี้ (ครบกุญแจสองดอกแล้ว) + ข้อความลาที่ส่งจริง — ปิดเหลืองหลังส่งครบเท่านั้น
    let offtopicPlan = null;
    let offtopicText = "";
    let offtopicOutcome = "";
    // พี่ง้วง 12 ต.ค.: ด่านคำชวนทดลองเรียนฟรี (จำกัดสิทธิ์ต่อวันจริง) ของเทิร์น v3 — จองสิทธิ์ก่อนร่าง แล้วนับ/คืนตามสิ่งที่ส่งถึงจริง
    let v3TrialGate = null;
    let jevKnowledge = "";
    // จังหวะราคา: คำตัดสินของเทิร์นนี้ + ตารางราคาที่ใช้ตัดสิน ต้องมองเห็นได้จากบล็อก
    // "หลังส่งสำเร็จ" ด้วย เพราะหมุดถาวรทั้งสองตัวถูกเขียนที่นั่น ไม่ใช่ตอนประกอบพรอมต์
    let priceDisclosure = null;
    // 2026-09-28 (audit ก.ย. §6.3): เทิร์นนี้ทำให้งาน project ถูกส่งต่อหลังตอบหรือไม่ (ใช้ทั้งพรอมต์และด่านก่อนส่ง)
    let projectHandoff = null;
    let approvedAmounts = null;
    let approvedOfferRows = [];
    const checkBankOffer = value => checkPriceBeforeBank({
      text: value, approvedAmounts, approvedPrices: approvedOfferRows,
      courses: salesPolicy?.courses || [], latestText: text, history,
    });
    const serviceReply = config.serviceBoundaryEnabled && !route.template
      ? serviceBoundaryReply(classifyServiceIntent(text, customer, { preset: isPresetButtonTap(text, presetPhrases) }), customer)
      : null;
    // ---- 18 ต.ค. 2026 (audit ลูกแพร): รู้ประเภทเอกสารแล้ว = ระบบส่งสรุป + บัญชี + ฟอร์มเองในข้อความเดียว ----
    // ต้นเหตุที่ต้องทำ: PRICE_BEFORE_BANK_RULE ทำให้โมเดลเลิกส่งบล็อกบัญชีตั้งแต่ 27 ก.ย. (ดู paymentStep.mjs)
    // เส้น template/แคมเปญ/ขอบเขตบริการ/ความปลอดภัย/ขอคน ชนะเสมอ · ชุดชำระเงินไม่ครบ = paymentKit null = เส้นเดิม
    // paymentKit = กติกาใหม่ของโมเดล (ห้ามพิมพ์บัญชีเอง) · paymentTurn = ระบบตัดสิน/ประกอบเอง (ไม่ทำในเทิร์นด่วน/ขอคน)
    const paymentKit = route.template || campaignDelivery || serviceReply
      || (config.brainRetrievalEnabled === true && !brain) ? null : paymentKitFor({ brain, customer });
    const paymentTurn = paymentKit && !prioritySafety && !route.escalate
      ? planPaymentTurn({ customerId, customer, text, parts: turnParts, sessionId, brain, kit: paymentKit }) : null;
    const paymentCompose = paymentTurn?.plan.action === "compose" ? paymentTurn.plan : null;
    const paymentRule = paymentKit ? SYSTEM_PAYMENT_RULE : PRICE_BEFORE_BANK_RULE;
    if (route.template) {
      draftText = templateAfterEscalation(route.template, routeEscalationPersisted !== false);
      // 20 ต.ค. 2026 (คำตอบ C4 ข้อ 12): แจ้งโอน/ส่งสลิป = ขอข้อมูลลงทะเบียนไปด้วยในข้อความเดียว ถ้าห้องนี้ยังไม่เคยกรอก
      // ฟอร์มจากการ์ดของเจ้าของ (ชุดเดียวกับขั้นชำระเงิน) · ไม่มีการ์ด/ตัวประกอบปิด/อ่านพัง = ข้อความเดิม
      if (route.askRegistration) {
        try {
          draftText = withRegistrationAsk(draftText, { kit: paymentKitFor({ brain, customer }), history: db.recentTurns(customerId, config.historyTurns) });
        } catch (err) {
          logger.warn?.(`pipeline: แนบฟอร์มลงทะเบียนกับข้อความแจ้งโอนไม่สำเร็จ (${err?.message || err}) — ส่งข้อความเดิม`);
        }
      }
      deterministic = true;
    } else if (campaignDelivery) {
      draftText = campaignDelivery;
      deterministic = true;
    } else if (serviceReply) {
      draftText = serviceReply.text;
      deterministic = true;
    } else if (paymentCompose) {
      if (laterTextPending(customerId)) return mergeForward(customerId, turnParts.length ? turnParts : [text], "before_payment_step");
      // ด่านเงินหลังร่าง (ราคาก่อนบัญชี · ตารางราคา · หมุดราคา) อ่านตัวแปรชุดเดียวกับเส้น AI
      history = paymentTurn.history;
      approvedOfferRows = paymentTurn.priceRows;
      approvedAmounts = paymentTurn.amounts;
      draftText = paymentCompose.message.text;
      deterministic = true;
    } else {
      // ---- AI path: Hermes stateless พร้อม context จาก DB ----
      // A missing/held approved version must not restore the legacy all-facts prompt.
      if (config.brainRetrievalEnabled === true && !brain) {
        return holdBrainKnowledge(customerId, "no_ready_brain");
      }
      const inbound = guard.checkInbound(text);
      // 2026-09-04: มุมมองประวัติก็ยุบการกดปุ่มด้วยกติกาเดียวกับก้อนปัจจุบัน — ไม่งั้น burst
      // ปุ่มเมื่อสิบนาทีก่อนจะโผล่กลับมาเป็น "คำถามสามข้อ" ในประวัติที่โมเดลเห็น
      // ยุบที่นี่ที่เดียว (จุดเดียวที่ประวัติถูกประกอบ) db.recentTurns และแถวที่เก็บไว้ไม่เปลี่ยน
      // แถวจาก recentTurns ไม่มีเวลา การติดกันจึงตัดสินแทนหน้าต่างเวลา (ดู presetButtons.mjs)
      history = collapsePresetBurst(
        historyBeforeCurrentInbound(db.recentTurns(customerId, config.historyTurns)),
        { list: presetPhrases },
      );
      // ข้อเท็จจริงเรื่องปุ่มของเทิร์นนี้ (กดกี่ครั้ง / ปุ่มไหนบ้าง / ลูกค้าเคยพิมพ์เองบ้างไหม)
      // ใช้ก้อนเดียวกันทั้งคำตัดสินจังหวะราคา หมุดบริบทลูกค้า และตัวประกอบพรอมต์
      const presetButton = presetButtonFact(inboundView.view, history);
      // F2 (handoff 2026-08-12): คำรับสั้นต้องอ่านเทียบกับข้อเสนอที่ค้างในเทิร์นก่อนหน้า
      // — hint นี้เลือกการ์ดความรู้ที่อนุมัติ (fallbackQuery) + เติมกติกาเจาะจงใน prompt
      const continuation = resolveContinuation({ latestText: text, history });
      // B6: บันทึกส่งต่อจากทีมงาน (ล่าสุด 10 เก่า -> ใหม่) เข้า prompt ทุก draft
      const handoffNotes = safeHandoffNotesFor(customerId, 10);
      // v1.1 (item 7): ป้ายลูกค้า + กติกาสินค้า — อ่านพัง = ไม่มีป้าย (ห้ามลาก reply ล้ม)
      let customerTags = [];
      let productRules = "";
      try {
        customerTags = db.listTags(customerId);
        // P2: กติกาสินค้าเป็นการ์ด `policy:product_rules` — ส่ง "สตริงดิบ" เข้าตัวประกอบ
        // ตัวเดิม (composeTagRules) พร้อมป้ายของลูกค้าคนนี้ ไม่ใช่เอาบรรทัดสำเร็จรูปจาก
        // bundle มาแปะ เพราะบรรทัดใน bundle ประกอบด้วย tags:[] เสมอ (ใช้เทียบ parity)
        productRules = (brain ? brain.bundle.rules.productRules : db.getSetting(PRODUCT_RULES_KEY)) || "";
      } catch (err) {
        logger.debug?.(`pipeline: อ่าน tags/กติกาสินค้าไม่สำเร็จ (${err?.message || err})`);
      }
      // ข้อเท็จจริงเรื่องเงิน/รอบเรียนถือว่า "มีจริง" เมื่อมีตารางราคาที่อนุมัติแล้วเท่านั้น —
      // ตารางว่าง = กลับไป fail-closed ตามเดิม (อ่านไม่ได้ก็ถือว่าไม่มี)
      let hasApprovedFacts = false;
      try {
        const priceRows = brain ? brain.bundle.guardTables.approvedPrices : (db.approvedPrices() ?? []);
        hasApprovedFacts = priceRows.length > 0;
        approvedOfferRows = priceRows;
        // "ราคาต่อหัวที่อนุมัติ" — นิยามเดียวกับตัวกันราคา (complianceGuard.multipliableAmounts)
        // จังหวะราคาใช้ชุดนี้ทั้งอ่านย้อนหลัง ("เคยพิมพ์ราคาไปแล้วหรือยัง") และปักหมุดหลังส่ง
        approvedAmounts = approvedClassAmounts(priceRows);
      } catch (err) {
        logger.debug?.(`pipeline: อ่านตารางราคาไม่สำเร็จ (${err?.message || err})`);
      }
      if (!prioritySafety && prioritySafetyPending(customerId)) {
        return { suppressed: "safety_preempted", stage: "before_draft" };
      }
      // v1.4.46: ก่อนเสียเงินคิด — ถ้าลูกค้าพิมพ์ก้อนใหม่มารออยู่แล้ว ยกข้อความไปรวมเลย
      if (laterTextPending(customerId)) {
        return mergeForward(customerId, turnParts.length ? turnParts : [text], "before_draft");
      }
      // จังหวะราคา: ตัดสินครั้งเดียวต่อเทิร์นตรงนี้ แล้วใช้ก้อนเดียวกันทั้งการปักหมุดถาวร
      // และการประกอบพรอมต์ — ถ้าแยกกันคำนวณ สองที่จะเพี้ยนออกจากกันในวันที่ยุ่งที่สุด
      const scoreSignals = latestScoreSignals(customerId);
      // งาน project ตัดสินที่เดียวแล้วใช้ร่วมกันทั้งคำตัดสินและโหมดคัดกรองก่อนเสนอใน baseRules
      const salesStateNow = latestSalesState(customerId);
      projectHandoff = predictProjectHandoff({ salesPolicy, salesState: salesStateNow, text, history });
      priceDisclosure = decidePriceDisclosure({
        text,
        history,
        score: Number.isInteger(customer?.last_score) ? customer.last_score : null,
        knownName: customer?.known_name || "",
        customer,
        inboundFlags: inbound.flags,
        approvedAmounts,
        scoreSignals,
        projectOpportunity: resolveProjectOpportunity({ currentText: text, salesPolicy, salesState: salesStateNow }),
        presetButton,
        // คำสั่งพี่ง้วง 2026-09-05: คนที่กำลังจะจองต้องได้คำตอบเรื่องเงินในข้อความสุดท้ายนี้
        // (เหตุผลเต็มอยู่ใน decidePriceDisclosure — พรอมต์ก้อนเดียวกันแบน "ถามคัดกรองเพิ่ม")
        //
        // R1: รอบสองส่งคีย์ชื่อ `bookingCommit` ซึ่ง decidePriceDisclosure ไม่รู้จัก — ประตูนี้
        // จึงไม่เคยเปิดเลยสักครั้งในโปรดักชัน และ baseRules ก็ใช้ก้อนที่คำนวณตรงนี้ต่อ
        // (ส่งเป็น priceDisclosure) ความผิดพลาดจึงเดินทางไปทั้งพรอมต์ ไม่ใช่แค่บรรทัดเดียว
        // ชื่อคีย์ต้องเป็น closingTurn ตัวเดียวกับที่ baseRules/ตัวประกอบทุกตัวใช้
        closingTurn: Boolean(handoffIntent) || Boolean(projectHandoff),
      });
      // ---- 12 ต.ค. 2026 (คำสั่งพี่ง้วง): คุยไปเรื่อยในเรื่องที่ไม่พาไปสู่การเรียน = ตีจบอย่างให้เกียรติ ----
      // กุญแจสองดอก (offtopicClose.mjs): ตัวจับคำบนข้อความนี้ + Luna ยืนยันจากบทสนทนา — ล้ม/ไม่แน่ใจ = ตอบตามปกติ
      // ไม่ใช่เทิร์นเส้นปลอดภัย/ด่วน/ส่งต่อ/งาน project/เพิ่งเปิดเขียว/โหมดร่าง (ด่านห้องอยู่ใน offtopicClose.blockReason)
      if (offtopicCloser && !prioritySafety && !config.trainingMockMode && !yellowReclaimed && !handoffHint && !handoffProject
        && !projectHandoff && !route.escalate && !route.optOut && !isPrioritySafetyRoute(route)
        && !aiPausedForReactiveCustomer({ db, config, customerId })) {
        offtopicPlan = await offtopicCloser.assess({ customerId, text, history: [...history] });
      }
      // หมุด "เราขอถามคัดกรองไปแล้ว" ย้ายไปเขียน **หลังส่งสำเร็จ** (ดูบล็อก sendResult.ok)
      //
      // ของเดิมเขียนตรงนี้ ก่อนเรียกโมเดล ด้วยเหตุผลว่า "ล้มกลางทางแล้วรอบหน้าจะแจ้งราคา
      // ซึ่งปลอดภัยกว่า" — แต่เส้นที่เกิดจริงบ่อยที่สุดคือ mergeForward ก่อนส่ง (ลูกค้าพิมพ์
      // ต่อระหว่างเราคิด) ซึ่ง "ทิ้งดราฟต์ทั้งก้อน" ผลคือห้องถูกทำเครื่องหมายว่าคัดกรองแล้ว
      // ทั้งที่ลูกค้าไม่เคยได้รับอะไรเลย แล้วคำตอบแรกที่ถึงมือคนแปลกหน้าคือราคา = บั๊กเดิมเป๊ะ ๆ
      // หมุดต้องหมายถึง "เราถามเขาไปแล้วจริง" เท่านั้น เหมือนแถว audit ที่เขียนหลังส่ง

      // ลูกค้าเล่าบริบทของตัวเองแล้ว = ปักหมุดถาวรทันที (ไม่ต้องรอส่ง — นี่คือสิ่งที่
      // "ลูกค้าพูด" ไม่ใช่สิ่งที่ "เราตอบ") สัญญาณพวกนี้อ่านจากหน้าต่างประวัติที่เลื่อนได้
      // ห้องที่คุยยาวจึงเคยกลับไปเป็นคนแปลกหน้าแล้วโดนคัดกรองใหม่ · ดันไปทาง quote ทางเดียว
      try {
        if (!Number(customer?.known_context_at) && knowsSomethingAboutCustomer({
          knownName: customer?.known_name || "", customer, scoreSignals,
          // ผลคัดกรอง (ระดับการใช้ AI / จำนวนผู้เรียน) ต้องปักหมุดด้วย — มันอ่านจากหน้าต่าง
          // ประวัติที่เลื่อนได้ ห้องที่คุยยาวจึงเคยกลับไปเป็นคนแปลกหน้าแล้วโดนคัดกรองใหม่
          // ทั้งที่เขาตอบบันไดของเราไปแล้วเมื่อสิบเทิร์นก่อน (เหตุผลเดียวกับที่หมุดนี้เกิดมา)
          screening: resolveClassRouting({ text, history }),
          // ห้องที่มีแต่การกดปุ่ม = สัญญาณ scorer ไม่นับ (ไม่งั้นหมุดถาวรจะถูกปักจากข้อความปุ่ม
          // แล้วคนแปลกหน้าคนนั้นจะได้ราคาตั้งแต่ปุ่มแรกตลอดไป)
          presetButton,
        })) {
          db.markCustomerContextKnown(customerId);
        }
      } catch (err) {
        logger.debug?.(`pipeline: ปักหมุดบริบทลูกค้าไม่สำเร็จ (${err?.message || err})`);
      }
      if (config.brainRetrievalEnabled === true) {
        try {
          knowledgeSelection = selectBrainKnowledgeForTurn({
            bundle: brain.bundle, db, channelId: customer?.channel_id || "default",
            queryText: text, recentContext: history,
          });
        } catch {
          // Diagnostics retain no query/card content or arbitrary exception text.
          return holdBrainKnowledge(customerId, "selection_failed");
        }
        if (!knowledgeSelection.ok) return holdBrainKnowledge(customerId, "knowledge_budget_or_scope");
      }
      const approvedKnowledge = applyKnownFactsOverride(knowledgeSelection ? knowledgeSelection.knowledge : brain
        ? knowledgeBlockFor(brain.bundle, db, customer?.channel_id || "default")
        : composeKnowledgeForChannel({ db, channelId: customer?.channel_id || "default", logger }),
      { hasApprovedFacts, trainingMockMode: config.trainingMockMode, logger });
      // White-label: แผนส่ง outline คอร์สเป็นของธุรกิจคอร์สเท่านั้น — generic = แผนว่าง (ไม่ส่ง)
      const outlinePlan = isGenericProfile(activeBrand())
        ? { course: null, deliver: false, explicit: false, reason: "generic_profile", rules: "" }
        : planCourseOutline({ text, history, score: customer?.last_score,
          knowledge: approvedKnowledge, presetButton,
          sentCourses: db.sentCourseOutlines?.(customerId) ?? new Set(),
          closingTurn: Boolean(handoffIntent) || Boolean(projectHandoff), careMode: priceDisclosure?.careMode });
      const reviewContext = { text, history, score: customer?.last_score, presetButton, personaType: scoreSignals?.personaType || "", sentUrls: db.sentReviewUrls?.(customerId) ?? new Set(), closingTurn: Boolean(handoffIntent) || Boolean(projectHandoff), careMode: priceDisclosure?.careMode, proactive: outlinePlan.deliver, nurture: naturalVoiceMode(db) === "on" };
      // น้ำเสียงใหม่: รีวิวที่เลือกต่อเทิร์นย้ายไปอยู่ท้ายกติกา ก้อนความรู้จึงเหมือนกันทุกเทิร์นและแคชได้ทั้งก้อน (ดู splitReviewKnowledge)
      // 19 ต.ค. 2026: คลังรีวิวนอกพรอมต์ (สวิตช์ review_catalog_in_prompt ≠ on) = ตัดหัวกลุ่มที่ไม่มีรายการเลือกด้วย
      // รายการที่ไม่ถูกเลือกถูกตัดอยู่แล้วตั้งแต่ก่อนหน้า (focus/split) — on = ข้อความเดิมทุกไบต์
      const reviewPrompt = { pruneHeadings: catalogOutOfPrompt(db) };
      const reviewSplit = reviewContext.nurture ? splitReviewKnowledge(approvedKnowledge, reviewContext, reviewPrompt) : null;
      // สไตล์การพิมพ์จริงของลูกค้าแทน DISC (4 ต.ค. 2026) — ยังไม่มีสัญญาณพอ = "" = กติกาไม่เปลี่ยน
      const chatStyleLine = reviewContext.nurture && salesPolicy
        ? chatStyleRule(readChatStyle(history, presetButton ? "" : text, { presetPhrases: presetButtonPhrases({ db }) })) : "";
      const draftArgs = {
        persona: scopedPersona(persona),
        // G3: ความรู้จากทีมงาน (เฉพาะ active, เพดาน KNOWLEDGE_MAX_CHARS) ต่อท้าย brand pack —
        // เป็นบริบทเท่านั้น ราคายังคุมด้วย approved_prices + guard เสมอ
        // G6 (P1): ประกอบตามสมองของสาขาลูกค้า — shared = กลาง (เดิมเป๊ะ) /
        // separate = brand pack กลาง + addendum สาขา + ความรู้เฉพาะสาขา
        // Flag off preserves the original block. Opt-in retrieval selects whole
        // approved fact cards while keeping mandatory pins intact.
        // P2: ก้อนความรู้มาจากรุ่นสมองของห้องนี้ — `knowledgeBlockFor` ทำซ้ำเงื่อนไข
        // brain_mode ของสาขาทุกข้อ และเรียก buildKnowledgeSection ตัวเดียวกับทางเดิม
        knowledge: reviewSplit ? reviewSplit.knowledge : focusReviewKnowledge(approvedKnowledge, reviewContext, reviewPrompt),
        brandPack: selectRelevantBrandPack(applyKnownFactsOverride(composeBrandPackOnly({
          db, brandPack, channelId: customer?.channel_id || "default",
        }), { hasApprovedFacts, trainingMockMode: config.trainingMockMode, logger }), continuation?.action === "answer_previous_question" && continuation.retrievalText ? continuation.retrievalText : text, {
          // recentTurns is already scoped by DB to the active /reset session.
          // Keep retrieval context smaller than the reply history and bounded
          // per item; ordinary non-LuKprae packs still return byte-for-byte.
          recentContext: history.slice(-4).map((turn) => ({
            role: turn.role,
            content: String(turn.content || "").slice(0, 300),
          })),
          approvedImageKeys,
          // จังหวะที่ภาพช่วยขายจริง: ลูกค้าถามถึงเนื้อหา/ความเหมาะ/ราคา/รูปแบบคลาส
          // ไม่ใช่ทุกเทิร์น — คำรับสั้น ๆ หรือคุยเรื่องเอกสารไม่ต้องมีภาพ
          offerImages: IMAGE_WORTHY_TURN.test(text),
          fallbackQuery: continuation?.retrievalText || "",
        }),
        // 2026-09-02: ห้องที่ชื่อตรงห้องระบบเก่าแต่ยังไม่มีคนยืนยันตัวตน ได้กติกาเพิ่มบรรทัดเดียว
        // (คุยต่อได้เหมือนลูกค้าใหม่ แต่ห้ามอ้างประวัติของคนที่อาจไม่ใช่คนเดียวกัน)
        rules: baseRules(route.intent, inbound.flags, { customer, currentText: text, continuation, askedQuestions: recentAskedQuestions(history), history, trainingMockMode: config.trainingMockMode, burstCount: Math.max(1, (turnParts || []).length), sentImageKeys, sentAtmosphereKeys, handoffNotes, customerTags, productRules, salesPolicy, salesState: salesStateNow, approvedImageKeys, hasApprovedFacts, ...currentRoundsRules(brain), priceDisclosure, approvedAmounts, presetButton, handoffIntent, closingQuestion: replyClosingQuestionEnabled(db), adWelcomeQuestion: adWelcomeQuestionFor({ db, customer }), nurtureImages: naturalVoiceMode(db) === "on", reviewsShared: reviewLinkShared(history, db.sentReviewUrls?.(customerId)), orderMode: orderModeOf(db), arrivalNote: legacyArrivalNote({ brain, db, customer, text, history, approvedKnowledge }) })
          + (legacyIdentityPending(customer) ? `\n${LEGACY_PENDING_RULE}` : "")
          + (outlinePlan.rules ? `\n${outlinePlan.rules}` : "")
          + (reviewSplit?.focus ? `\n${reviewSplit.focus}` : "")
          + (chatStyleLine ? `\n${chatStyleLine}` : ""),
        history,
        // v1.4.45: หลายบอลลูน = แสดงเป็นรายการให้โมเดลเห็นว่าเป็นคนละข้อความ
        userText: renderBurstForModel(text, turnParts),
        // P2: คีย์ cache ของเกตเวย์เป็น `<tenant>-<versionId>` เมื่ออ่านสมองที่มีเวอร์ชัน
        // — รุ่นใหม่หมุนคีย์ครั้งเดียวตอนเผยแพร่ ค่าว่าง = คีย์เดิมทุกไบต์
        brainVersionId: brainVersionId ?? "",
        mirrorRoomId: !config.trainingMockMode && /^(?:facebook:\d+|(?:[a-z0-9_-]+:)?U[0-9a-f]{32})$/.test(customerId)
          && !/^(?:canary|sandbox|training)[-:]/.test(customerId) ? customerId : "",
      };
      // รีวิวที่แยกออกไปท้ายกติกายังเป็นของที่อนุมัติ — ชุดลิงก์จึงเท่ากับตอนที่รีวิวอยู่ในก้อนความรู้
      const approvedKnowledgeText = reviewSplit?.focus ? `${draftArgs.knowledge}\n${reviewSplit.focus}` : draftArgs.knowledge;
      if (outlinePlan.deliver) approvedOutlineUrls = assetUrls(`${approvedKnowledgeText}\n${draftArgs.brandPack}`);
      if (config.serviceBoundaryEnabled) draftArgs.rules += `\n${SERVICE_SCOPE_RULE}`;
      if (config.salesDecisionGuardEnabled) {
        // 18 ต.ค. 2026: การ์ดมีชุดชำระเงินครบ = ระบบส่งเอง (SYSTEM_PAYMENT_RULE) · ไม่ครบ = กติกาเดิมทุกไบต์
        draftArgs.rules += `\n${paymentRule}`;
        // ชุดชำระเงินเปิด: "ได้บัญชีแล้ว" ต้องมีหลักฐานจริง — ห้องที่ lifecycle ตั้งรอชำระตอนเลือกรอบยังไม่เคยได้บัญชี
        if (isBankInfoConversation(customer) && (!paymentKit || !paymentTurn || paymentTurn.delivered)) draftArgs.rules += `\n${BANK_INFO_RULE}`;
        if (paymentTurn?.plan.action === "pin") {
          draftArgs.rules += `\n- ลูกค้าแจ้งประเภทเอกสารแล้ว (${DOC_TYPE_LABEL[paymentTurn.plan.docType] || paymentTurn.plan.docType}) — ห้ามถามประเภทเอกสารซ้ำ ตอบเรื่องที่ลูกค้าถามล่าสุดให้ครบ`
            + (paymentTurn.plan.manual ? " ส่วนสรุปค่าเรียนและช่องทางชำระ ทีมงานจะส่งให้ในแชทนี้" : " เมื่อลูกค้าพร้อม ระบบจะส่งสรุปค่าเรียนและช่องทางชำระให้เอง");
        }
      }
      // คำสั่งพี่ง้วง 2026-09-28: เบรกการสอนยาวแล้วพาไปขาย — คืน "" = พรอมต์เดิมทุกไบต์
      // (ตัวตัดสินและถ้อยคำทั้งหมดอยู่ใน coachingBrake.mjs · สวิตช์ settings.coaching_brake_mode)
      const coachingBrake = coachingBrakeDirective({
        db, customerId, logger, text, history, continuation, presetButton, intent: route.intent,
        closingTurn: Boolean(handoffIntent), careMode: priceDisclosure?.careMode,
        projectOpportunity: handoffProject, paymentSeen: Number(customer?.money_seen_at) > 0,
      });
      if (coachingBrake) draftArgs.rules += `\n${coachingBrake}`;
      // คำสั่งพี่ง้วง 2026-09-28: ลูกค้าขอเช็คคิว/วันก่อน = ให้รอบที่เปิดจริง · ไม่ต้องรีบ · ไม่ปิดท้ายด้วยคำถาม
      // คืน "" = พรอมต์เดิมทุกไบต์ (ตัวจับ/ถ้อยคำใน scheduleCheck.mjs · รอบอ่านเฉพาะเทิร์นที่จับได้)
      const scheduleCheckRule = scheduleCheckReplyDirective({
        enabled: scheduleCheckFollowupEnabled(db), text,
        rounds: () => currentUpcomingRounds({ db, config, bundle: brain?.bundle ?? null, todayIso: todayInBangkok(), logger }),
      });
      if (scheduleCheckRule) draftArgs.rules += `\n${scheduleCheckRule}`;
      jevKnowledge = [approvedKnowledgeText, draftArgs.brandPack].filter(Boolean).join("\n");
      draftArgs.rules = withCampaignReceiptPolicy(draftArgs.rules, config);
      // 2026-09-28: บทเรียนจากแผง "ทำไมตอบแบบนี้" ต่อท้ายกติกาทุกข้อ — ไม่มีบทเรียน = ไม่แตะอะไรเลย
      // คำสั่งพี่ง้วง 2026-10-04: น้ำเสียงคนคุยแชท (สวิตช์ natural_voice_mode · ไม่มีแถว = off = พรอมต์เดิมทุกไบต์)
      // ก่อนบทเรียนเจ้าของ — บทเรียนจากแผงยังเป็นคำสุดท้ายของพรอมต์เสมอ
      if (naturalVoiceMode(db) === "on") Object.assign(draftArgs, naturalVoiceArgs(draftArgs));
      const rulesBeforeLessons = draftArgs.rules;
      ownerLessonIds = applyOwnerLessons({ db, draftArgs, channelId: customer?.channel_id || "default", text, history, logger });
      // 2026-10-04 เครื่องตอบ v3 (spec v3.1 §A3): สวิตช์ไม่ใช่ "v3" = ไม่แตะ draftArgs เลย (พรอมต์เดิมทุกไบต์)
      // คำตัดสินราคาที่ v3 แปลงแล้ว (ข้อ 6) — ใช้ปักหมุดได้เฉพาะเมื่อ v3 เขียนคำตอบเองจริง
      let v3Disclosure = null;
      if (!config.trainingMockMode && replyEngineMode(db) === "v3") {
        let v3SkipReason = "";
        try {
          const lane = chooseLane({ text, parts, history, customer, intent: route.intent, priceDisclosure,
            handoffIntent, projectHandoff, handoffProject, salesState: salesStateNow, salesPolicy, outlinePlan, hasApprovedFacts,
            inboundFlags: inbound.flags, projectOpportunity: resolveProjectOpportunity({ currentText: text, salesPolicy, salesState: salesStateNow }) });
          // ข้อความลาตายตัว (ลวนลาม — offtopicClose.FIXED_CLOSE_CATEGORIES) ไม่ประกอบเทิร์น v3 ไม่ร่างด้วยโมเดล
          if (offtopicPlan?.fixed) v3SkipReason = "offtopic_fixed_close";
          else if (lane.engine === "v3" || offtopicPlan) {
            const knowledgeEntries = knowledgeEntriesFor({ brain, db, channelId: customer?.channel_id || "default" });
            let customerFacts = [];
            try { customerFacts = db.getCustomerFacts?.(customerId) || []; }
            catch { logger.debug?.("reply-v3: human customer facts unavailable; retaining current-session context"); }
            let allowLegacyOfferBootstrap = false;
            // พี่ง้วง 12 ต.ค.: รูปในก้อนล่าสุดของลูกแพร — เว้นจังหวะรูปบรรยากาศ (ไม่ส่งใบที่สองติดกัน)
            let lastBurstImages = [];
            try {
              const deliveredRows = db.messagesFor?.(customerId, 100) || [];
              previousReplyMeta = latestCommittedReplyMeta(deliveredRows);
              allowLegacyOfferBootstrap = legacyOfferBootstrapAllowed(deliveredRows);
              lastBurstImages = lastBurstImageKeys(deliveredRows);
            }
            catch { logger.debug?.("reply-v3: previous delivered context unavailable; retaining current-session text"); }
            const contextEnvelope = buildReplyContextEnvelope({ persona: scopedPersona(persona), knowledgeEntries,
              brainVersionId: draftArgs.brainVersionId, customerFacts, previousReplyMeta,
              legacyOfferBootstrapAllowed: allowLegacyOfferBootstrap,
              legacyIdentityUnverified: legacyIdentityPending(customer) });
            v3TrialGate = trialInviteGate({ db, customerId, nowMs: Date.now(), entries: knowledgeEntries, logger });
            const built = buildTurnFacts({ text, parts, history, customer, inboundFlags: inbound.flags,
              contextEnvelope,
              disclosure: priceDisclosure, salesState: salesStateNow, scoreSignals, presetButton, continuation,
              approvedAmounts, approvedImageKeys, sentImageKeys, sentAtmosphereKeys, reviewContext, approvedKnowledge,
              knowledgeEntries,
              rounds: currentUpcomingRounds({ db, config, bundle: brain?.bundle ?? null, todayIso: todayInBangkok(), logger }),
              todayIso: todayInBangkok(), handoffNotes, customerTags, productRules,
              adWelcomeQuestion: adWelcomeQuestionFor({ db, customer }), coachingBrake, scheduleCheckRule,
              overlap: v3OverlapFor(customerId),
              nurture: naturalVoiceMode(db) === "on", ownerLessonText: draftArgs.rules.slice(rulesBeforeLessons.length).trim(),
              userText: draftArgs.userText, guardTurn, customerId, brainVersionId: draftArgs.brainVersionId,
              mirrorRoomId: draftArgs.mirrorRoomId, sentCourseOutlines: db.sentCourseOutlines?.(customerId) ?? new Set(),
              // ข้อเท็จจริงระยะยาว (คำแอดมิน เครื่องมือที่เล่า สิ่งที่ส่งแล้ว) อ่านจากทั้ง session ไม่ใช่แค่หน้าต่างประวัติ
              factHistory: collapsePresetBurst(historyBeforeCurrentInbound(db.recentTurns(customerId, V3_FACT_HISTORY_TURNS)), { list: presetPhrases }),
              // เทิร์นตีจบ (offtopicPlan) ห้ามชวนทดลองเรียน/จองสิทธิ์ — คำลาไม่มีลิงก์และไม่มีช่องเติม
              trialInvite: { available: !offtopicPlan && v3TrialGate.available, url: v3TrialGate.url }, lastBurstImageKeys: lastBurstImages,
              deps: { decideImageOffer, reviewLinkShared, promptSafeHandoffNotes, customerAsksForImage,
                checkOutbound: (value) => guard.checkOutbound(value, guardTurn), reserveTrialInvite: () => (offtopicPlan ? { ok: false, reason: "offtopic_close" } : v3TrialGate.reserve()) } });
            // รีวิว 12 ต.ค.: v3 ตัดสินว่าเป็นจังหวะดูแลใจ (เดือดร้อน/ถูกกดดัน/รอคนตัดสินใจ) = จังหวะนั้นชนะการตีจบเสมอ
            // (เทิร์นนี้เดินเหมือนไม่มีแผนตีจบ: เลน v3 = คำตอบดูแลใจของ v3 · เลนเครื่องเดิม = เครื่องเดิม)
            if (built.ok && offtopicPlan && built.decision?.reason === "care_moment") {
              logger.info?.(`offtopic_check ${JSON.stringify({ customerId, cue: offtopicPlan.cue, outcome: `skipped:care_${built.decision.care || "moment"}` })}`);
              offtopicPlan = null;
            }
            if (built.ok && offtopicPlan) {
              // ตีจบ: คำตัดสินของเทิร์นเป็น GOODBYE/offtopic_close (ไม่มีราคา/รูป/ช่องเติม) — ไม่แปลงคำตัดสินราคา ไม่ปักหมุดราคา
              draftArgs.v3 = withOfftopicClose(built, offtopicPlan.category);
            } else if (built.ok && lane.engine === "v3") {
              draftArgs.v3 = built;
              // ข้อ 6 (12 ต.ค.): v3 แปลงคำตัดสินเป็น "แบ่งรับด้วยคุณค่า" (priceDisclosure.withValueHedge) — หมุดหลังส่งต้องอ่านคำตัดสินที่ v3 ใช้จริง
              // (เครื่องเดิม/เลนเครื่องเดิมยังใช้คำตัดสินเดิมทุกไบต์ · ตัวเดิม = ไม่ได้แปลง) — รับมาใช้หลังร่างเท่านั้น (ดูข้างล่าง)
              if (built.facts?.disclosure?.mode && built.facts.disclosure !== priceDisclosure) v3Disclosure = built.facts.disclosure;
            } else v3SkipReason = built.ok ? lane.reason : built.reason;
          } else v3SkipReason = lane.reason;
        } catch (err) {
          v3SkipReason = "build_failed";
          logger.warn?.(`reply-v3: build failed → legacy (${err?.message || err})`);
        }
        if (v3SkipReason) logger.info?.(`reply_engine_skip ${JSON.stringify({ reason: v3SkipReason, customerId })}`);
      }
      // ตีจบแต่เครื่อง v3 ไม่ได้รับเทิร์นนี้ (สวิตช์ไม่ใช่ v3/สร้างข้อเท็จจริงไม่ได้) = ข้อความลาสำรอง ไม่เสียเงินร่างคำตอบขายทิ้ง
      // หมวดข้อความลาตายตัว = ไม่เรียกโมเดลเลย (คำลาถึงคนที่ลวนลามต้องเหมือนเดิมทุกครั้ง)
      const result = offtopicPlan && (offtopicPlan.fixed || !draftArgs.v3) ? null : await draftReplyForCustomer(customerId, draftArgs);
      replyEngineMeta = result?.v3Meta ?? null;
      // ข้อ 6 รอบรีวิว 2: หมุดแบ่งรับ = "เราแบ่งรับจริง" — รับคำตัดสินของ v3 เฉพาะเมื่อร่างนี้มาจาก v3 (มี v3Meta และไม่ได้ถอยไปเครื่องเดิม)
      // ร่างที่ถอยไปเครื่องเดิมเขียนด้วยคำตัดสินเดิม (แจ้งราคา) จึงปักหมุดตามคำตัดสินเดิม
      if (v3Disclosure && result?.v3Meta && result.v3Meta.fallback !== "legacy") priceDisclosure = v3Disclosure;
      // สมองล่มระหว่างเทิร์น v3 ต้องนับเป็นของ v3 ได้ (เกณฑ์ถอยกลับ "hermes_down ที่เกิดจาก v3")
      if (!result && draftArgs.v3) {
        replyEngineMeta = { engine: "v3", stage: draftArgs.v3.decision?.stage || "", stageReason: draftArgs.v3.decision?.reason || "", providerDown: true };
      }
      if (result?.mirrorId) mirrorIds.push(result.mirrorId);
      // The provider has already charged even if safety/session changes discard
      // this draft below. Accounting must precede every early return.
      recordUsage(customerId, "draft", result, brainVersionId);
      if (!prioritySafety && prioritySafetyPending(customerId)) {
        return { suppressed: "safety_preempted", stage: "after_draft" };
      }
      // v1.4.3: draft โดนแบนแค่ "คำ" (เช่น ดีที่สุด) ไม่ควรตายทั้งคำตอบ — เก็บช่องทาง
      // redraft ไว้ให้ด่านข้างล่างสั่งแก้คำแล้วลองใหม่หนึ่งครั้ง (เคสจริง 2026-08-15:
      // คำชมเครื่องมือของลูกค้าโดนตัดทั้งก้อน แล้ว fallback ที่ส่งแทนอ่านไม่รู้เรื่อง)
      redraftWithExtraRule = async (extraRule) => {
        const redraft = await draftReplyForCustomer(customerId, { ...draftArgs, rules: `${draftArgs.rules}\n${extraRule}`,
          ...(draftArgs.v3 ? { repair: extraRule } : {}) });
        if (redraft?.mirrorId) mirrorIds.push(redraft.mirrorId);
        if (redraft?.v3Meta) replyEngineMeta = { ...redraft.v3Meta, guardRedrafts: (replyEngineMeta?.guardRedrafts || 0) + 1 };
        return redraft;
      };
      if (!sessionStillCurrent(customerId, sessionId)) {
        logger.warn?.(`pipeline: ทิ้งเทิร์นเพราะ session ถูกหมุนระหว่าง draft customer=${customerId}`);
        return { suppressed: "session_rotated_during_draft" };
      }
      // ถูกสั่งหยุดคิดเพราะระบบกำลังปิด — ห้ามตกลงไปเส้น fallback ด้านล่าง
      // ไม่งั้นลูกค้าจะได้ "ขอเวลาลูกแพรตรวจข้อมูลให้สักครู่นะคะ" แล้วโปรเซสตาย
      // = คำสัญญาที่ไม่มีใครทำต่อ ซึ่งแย่กว่าความเงียบที่มีธงคนดูแลติดอยู่
      if (drainAborted.delete(customerId)) {
        escalate(customerId, "drain_interrupted",
          "ระบบถูกปิดระหว่างคิดคำตอบ — ยังไม่ได้ส่งอะไรถึงลูกค้า คนต้องรับต่อ");
        return { suppressed: "drain_aborted_before_send" };
      }
      if (offtopicPlan) {
        // คำลาของ v3 ใช้ได้เฉพาะเมื่อเขียนด้วยจังหวะตีจบจริง (ไม่ถอยเครื่องเดิม) และไม่มีคำถาม ลิงก์ ราคา และผ่าน guard
        // ไม่งั้น (v3 ปิด/สมองล่ม/ร่างไม่ผ่าน) = ข้อความลาสั้นตามหมวด · ห้าม redraft เทิร์นนี้ (ด่านคำแบนจะพาไปเป็นคำตอบขาย)
        const v3Close = Boolean(result?.text) && result?.v3Meta?.stageReason === OFFTOPIC_CLOSE_REASON
          && result.v3Meta.fallback !== "legacy" && offtopicCloser.textOk(result.text, offtopicPlan.category)
          && guard.checkOutbound(result.text, guardTurn).ok;
        offtopicText = v3Close ? result.text : offtopicCloser.fallbackText(offtopicPlan.category,
          { firstReply: !history.some((turn) => turn?.role === "assistant") });
        draftText = offtopicText;
        deterministic = !v3Close;
        redraftWithExtraRule = null;
        // ข้อความลาไม่ใช่คำถามคัดกรอง/การแจ้งราคา — หมุดจังหวะราคาหลังส่งต้องไม่ถูกปัก
        priceDisclosure = null;
        if (!v3Close && replyEngineMeta) {
          // ข้อความลาสำรองไม่มีรูป/รีวิว/คำชวน — ห้ามจดของแนบที่ร่าง v3 วางแผนไว้ (ตัววัดผลรายวันจะนับผิด)
          const { providerDown: _providerDown, socialProof: _socialProof, ...attempted } = replyEngineMeta;
          replyEngineMeta = { ...attempted, stage: "GOODBYE", stageReason: OFFTOPIC_CLOSE_REASON,
            followupStop: OFFTOPIC_FOLLOWUP_STOP, offtopicFallback: true };
        }
      } else if (!result) {
        // Hermes ล่ม/timeout -> rule fallback + mark human review (SPEC hermesBridge row)
        const outageFlagKey = HERMES_DOWN_FLAG_PREFIX + customerId;
        const outageOwnsFlag = db.getCustomer(customerId)?.state !== "NEEDS_HUMAN"
          || Number(db.getSetting(outageFlagKey) || 0) > 0;
        const handoffPersisted = escalate(
          customerId,
          "hermes_down",
          "Hermes ไม่ตอบ — ส่ง fallback แล้ว รอคนจริงตามต่อ",
        );
        if (handoffPersisted && outageOwnsFlag && !(Number(db.getSetting(outageFlagKey) || 0) > 0)) {
          const raisedAt = personReasonRaisedAt(db.getCustomer(customerId), "hermes_down");
          if (raisedAt > 0) db.setSetting(outageFlagKey, String(raisedAt));
        }
        // v1.4.45: ปลุกคนด้วย ไม่ใช่แค่ปักธง — "ops:hermes" ทำให้เป็นเหตุระดับระบบ
        // และได้ cooldown รวมก้อนเดียว (lastSent คีย์ด้วย customerId) ล่มยกชุดจึงเด้งครั้งเดียว
        notifier?.fireLater?.({
          customerId: "ops:hermes",
          channelId: customer?.channel_id || "default",
          reason: "hermes_down",
        });
        // v1.4.2 (เคสจริง 2026-08-16): template เดิมถูกส่งซ้ำ 3 เทิร์นติด — ลูกค้าเจอ
        // นกแก้วซึ่งแย่กว่าความเงียบที่มีธงคนดูแลติดอยู่แล้ว: ครั้งสองเปลี่ยนถ้อยคำ
        // เป็นขอโทษตรง ๆ ครั้งถัดไปเงียบ (NEEDS_HUMAN ติดตั้งแต่ครั้งแรก คนจริงต้องรับ)
        const recentOutbound = history
          .filter((turn) => turn?.role === "assistant")
          .map((turn) => String(turn.content || ""));
        const stallTexts = new Set([HERMES_DOWN_TEMPLATE, HERMES_DOWN_RETRY_TEMPLATE, ...LEGACY_HERMES_DOWN_RETRY_TEXTS,
          "ขอเวลาลูกแพรตรวจข้อมูลให้สักครู่นะคะ"].map((t) => brandText(t)));
        const lastWasStall = stallTexts.has(recentOutbound.at(-1) || "");
        if (lastWasStall && stallTexts.has(recentOutbound.at(-2) || "")) {
          logger.warn?.(`pipeline: hermes ล่มติดกันเกินสองเทิร์น — เงียบพร้อมธงคนดูแล customer=${customerId}`);
          return { suppressed: "hermes_down_repeated" };
        }
        draftText = brandText(lastWasStall
          ? HERMES_DOWN_RETRY_TEMPLATE
          : (handoffPersisted ? HERMES_DOWN_TEMPLATE : "ขอเวลาลูกแพรตรวจข้อมูลให้สักครู่นะคะ"));
        deterministic = true;
      } else {
        draftText = result.text;
      }
    }

    // ---- กันกลับคำเรื่องราคาให้แพงขึ้น (ก่อน guard เพราะเป็นคนละคำถาม) ----
    // guard ตอบว่า "เลขนี้อยู่ในตารางไหม" ส่วนตรงนี้ตอบว่า "เลขนี้ขัดกับที่เราบอกไปแล้วไหม"
    // การแก้ให้ถูกลงปล่อยผ่าน การแก้ให้แพงขึ้นต้องให้คนจริงตัดสินเสมอ
    try {
      const priorOutbound = history
        .filter((turn) => turn?.role === "assistant")
        .map((turn) => String(turn.content || ""));
      const revision = detectUpwardPriceRevision(draftText, priorOutbound);
      if (revision.raised) {
        escalate(customerId, "price_revision_upward",
          `แก้ราคาขึ้นจาก ${revision.previous.toLocaleString("th-TH")} เป็น ${revision.next.toLocaleString("th-TH")} บาท`);
        db.addCorrection({
          customerId, aiDraft: draftText, humanFinal: "",
          sourceReason: formatSystemCorrectionSource("system:price_revision_upward"),
          inboundMessageId: correctionInboundMessageId,
        });
        logger.warn?.(`pipeline: บล็อกการแก้ราคาขึ้น ${revision.previous} -> ${revision.next} customer=${customerId}`);
        draftText = brandText(PRICE_REVIEW_TEMPLATE);
        deterministic = true;
      }
    } catch (err) {
      // ตรวจความสอดคล้องพังห้ามล้มการตอบ — guard ด้านล่างยังทำงานตามปกติ
      logger.debug?.(`pipeline: ตรวจการกลับคำราคาไม่สำเร็จ (${err?.message || err})`);
    }

    // 18 ต.ค. 2026: การ์ดมีชุดชำระเงินครบ = โมเดลห้ามพิมพ์บัญชี/ฟอร์มเอง (ระบบเป็นคนส่งจากข้อมูลจริงเท่านั้น)
    if (paymentKit && !deterministic && paymentInstructionsIndex(draftText) >= 0) {
      db.addAudit({ operator: "system", action: PAYMENT_STEP_AUDIT.modelBlocked, target: customerId,
        detail: "Model drafted payment instructions; the system composes payment details itself" });
      if (redraftWithExtraRule) {
        try {
          const repaired = await redraftWithExtraRule(SYSTEM_PAYMENT_RULE);
          recordUsage(customerId, "draft", repaired, brainVersionId);
          if (repaired?.text) draftText = repaired.text;
        } catch { logger.warn?.("pipeline: payment-step repair unavailable"); }
      }
      if (paymentInstructionsIndex(draftText) >= 0) {
        const stripped = stripPaymentInstructions(draftText);
        if (stripped && paymentInstructionsIndex(stripped) < 0) draftText = stripped;
        else {
          // ตัวประกอบล้ม (paymentTurn null) = ไม่รู้สถานะห้อง ห้ามถามเอกสารซ้ำ — ส่งให้ทีม
          const toTeam = !paymentTurn || Boolean(paymentTurn.plan.docType);
          draftText = toTeam ? "ลูกแพรขอให้ทีมงานตรวจรายละเอียดการชำระให้ก่อนนะคะ แล้วจะแจ้งในแชทนี้ค่ะ" : DOC_TYPE_QUESTION;
          if (toTeam) escalate(customerId, "payment_step_manual", "โมเดลพยายามพิมพ์ช่องทางชำระเอง — รบกวนทีมส่งสรุปค่าเรียนและช่องทางชำระ", { markMoney: false });
          deterministic = true;
        }
      }
    }

    if (config.salesDecisionGuardEnabled && !checkBankOffer(draftText).ok) {
      db.addAudit({ operator: "system", action: "price_before_bank_blocked", target: customerId,
        detail: "Payment instructions withheld: this offer did not state an approved tuition first" });
      if (redraftWithExtraRule) {
        try {
          const repaired = await redraftWithExtraRule(paymentRule);
          recordUsage(customerId, "draft", repaired, brainVersionId);
          if (repaired?.text) draftText = repaired.text;
        } catch { logger.warn?.("pipeline: price-before-bank repair unavailable"); }
      }
      if (!checkBankOffer(draftText).ok) {
        const held = escalate(customerId, "price_before_bank", "ต้องยืนยันค่าเรียนก่อนให้ช่องทางชำระเงิน — AI ยังตอบข้อมูลทั่วไปได้");
        draftText = held
          ? "ขออภัยค่ะ ค่าเรียนสำหรับรายการนี้ยังยืนยันไม่ครบ จึงบันทึกให้ทีมตรวจสอบก่อนแจ้งช่องทางชำระเงินค่ะ"
          : "ขออภัยค่ะ ค่าเรียนสำหรับรายการนี้ยังยืนยันไม่ครบ จึงยังแจ้งช่องทางชำระเงินไม่ได้ค่ะ";
        deterministic = true;
      }
    }

    // ---- compliance guard หลัง model (template ก็ผ่านด่านนี้ กัน template พังเอง) ----
    let check = guard.checkOutbound(draftText, guardTurn);
    let blockedDraft = false;
    // v1.4.3: โดนแบนแค่ "คำ" ล้วน ๆ (ไม่มีเรื่องเงินปน) = สั่งโมเดลเลี่ยงคำนั้นแล้วลองใหม่
    // หนึ่งครั้ง — คำตอบดี ๆ ทั้งก้อนไม่ควรตายเพราะคำเดียว (เคสจริง "ดีที่สุด" 2026-08-15)
    if (!check.ok && redraftWithExtraRule && check.violations.every((violation) => violation.type === "banned_word")) {
      const bannedWords = check.violations.map((violation) => violation.detail).filter(Boolean).join(", ");
      logger.warn?.(`pipeline: draft โดนแบนคำ (${bannedWords}) — redraft หนึ่งครั้งพร้อมกติกาเลี่ยงคำ customer=${customerId}`);
      try {
        const retry = await redraftWithExtraRule(
          `- ห้ามใช้คำต่อไปนี้เด็ดขาด (เป็นคำเคลมเกินจริงที่ระบบไม่อนุญาต): ${bannedWords} — ` +
          "สื่อความหมายเดิมด้วยคำที่พอดี ไม่เคลมเกินจริง"
        );
        recordUsage(customerId, "draft", retry, brainVersionId);
        if (!prioritySafety && prioritySafetyPending(customerId)) {
          return { suppressed: "safety_preempted", stage: "after_redraft" };
        }
        if (retry?.text && sessionStillCurrent(customerId, sessionId)) {
          const recheck = guard.checkOutbound(retry.text, guardTurn);
          if (recheck.ok) {
            draftText = retry.text;
            check = recheck;
            logger.warn?.(`pipeline: redraft เลี่ยงคำแบนสำเร็จ customer=${customerId}`);
          }
        }
      } catch (err) {
        logger.warn?.(`pipeline: redraft เลี่ยงคำแบนล้มเหลว (${err?.message || err}) — ใช้เส้นทาง block ปกติ`);
      }
    }
    if (!check.ok) {
      const summary = check.violations.map((v) => `${v.type}:${v.detail ?? ""}`).join(", ");
      const handoffPersisted = escalate(customerId, "compliance_block", summary);
      // เก็บ draft ที่โดนบล็อกเป็น correction candidate ให้รอบรีวิวรายสัปดาห์
      db.addCorrection({
        customerId, aiDraft: draftText, humanFinal: "",
        sourceReason: formatSystemCorrectionSource("system:compliance_block", check.violations),
        inboundMessageId: correctionInboundMessageId,
      });
      // กู้ส่วนที่ปลอดภัยก่อนยอมทิ้งทั้งก้อน — ประโยคปิดการขายที่ถูกต้องมักอยู่ในดราฟต์เดียวกัน
      const salvaged = stripViolatingSentences(draftText, (part) => guard.checkOutbound(part, guardTurn));
      // v1.4.6 (เคสจริง 2026-08-15): prefix "ขอเช็คตัวเลข" ต้องใช้เฉพาะบล็อกเรื่องเงิน —
      // เดิมแปะกับทุกชนิดบล็อก ทำให้ลูกค้าถามหารีวิวแล้วได้ "ขอเช็คตัวเลขนะคะ มีค่ะ..."
      // ซึ่งย้อนแย้งและไม่เกี่ยวกับคำถามเลย
      const moneyStripped = check.violations.some((violation) => /price|amount|surcharge/iu.test(String(violation.type)));
      if (salvaged) {
        // เก็บส่วนที่ปลอดภัยไว้ แต่ต้องบอกด้วยว่ามีข้อมูลที่ยังยืนยันไม่ได้ ไม่งั้นคำตอบจะกลาย
        // เป็นการเมินคำถามลูกค้า (เขาถามราคา แล้วได้ "สนใจจองเลยไหมคะ" เฉย ๆ)
        logger.warn?.(`pipeline: บล็อก reply (${summary}) customer=${customerId} — ตัดทิ้ง ${salvaged.droppedCount} ประโยค ส่งส่วนที่เหลือ`);
        // v1.4.11 (เคสจริงลูกค้า A 2026-08-18: ลูกค้าขอ "รายละเอียดคลาส" แต่ได้
        // "ขอเช็คตัวเลขกับทีมงาน" นำหน้า จนลูกค้าถามกลับว่าเช็คอะไร): prefix ใช้เฉพาะ
        // เมื่อลูกค้าถามเรื่องเงินจริง — ตัดเงียบเมื่อคำถามไม่เกี่ยวกับตัวเลข
        // v1.4.11b (audit จับ): asksAboutPrice แคบเกิน (ไม่ครอบ ส่วนลด/โปร/ผ่อน/มัดจำ/
        // ใบเสนอราคา) — คำถามเงินพวกนั้นถ้าโดน strip เงียบ = คำตอบดูเมินคำถาม
        const MONEY_TOPIC = /ส่วนลด|โปรโมชั่น|โปร\b|ผ่อน|มัดจำ|ใบเสนอราคา|ค่าใช้จ่าย|ค่าเรียน|ชำระ|กี่บาท/iu;
        const customerAskedPrice = asksAboutPrice(String(text || "")) || MONEY_TOPIC.test(String(text || ""));
        // ต่อรองขอถูกกว่าตาราง = คำตอบคือ "ดีที่สุดแล้ว" ไม่ใช่ "ขอไปเช็คก่อน"
        const prefix = brandText(asksForExtraDiscount(String(text || "")) ? PRICE_FINAL_PREFIX : PARTIAL_BLOCK_PREFIX);
        draftText = moneyStripped && customerAskedPrice ? `${prefix} ${salvaged.text}` : salvaged.text;
      } else {
        logger.warn?.(`pipeline: บล็อก reply (${summary}) customer=${customerId} — ส่ง fallback แทน`);
        // draft ห้ามหลุด แต่ลูกค้าต้องไม่เจอความเงียบ — ส่ง fallback ปลอดภัยแทน
        // v1.4.3: fallback ต้องเข้ากับชนิดการบล็อก — บล็อกเรื่องเงิน/ตัวเลขใช้ประโยค
        // "ขอเช็คข้อมูล" ได้ แต่บล็อกเชิงถ้อยคำ (banned_word ฯลฯ) ใช้ประโยคนั้นแล้ว
        // อ่านไม่รู้เรื่อง (เคสจริง: ลูกค้าบอกว่าใช้ ChatGPT แล้วบอทตอบ "ข้อมูลยังยืนยันไม่ได้")
        const moneyBlocked = check.violations.some((violation) => /price|amount|surcharge/iu.test(String(violation.type)));
        draftText = brandText(moneyBlocked
          ? (handoffPersisted ? BLOCKED_FALLBACK_TEMPLATE : BLOCKED_FALLBACK_UNTRACKED_TEMPLATE)
          : STYLE_BLOCK_TEMPLATE);
      }
      // R5 (คำสั่งพี่ง้วง 2026-09-05 รอบสาม — ตัดสินใจไว้ตรงนี้โดยเจตนา):
      // บรรทัดนี้ทำให้ "ดราฟต์ที่ถูกกู้บางส่วน" (guard ตัดบางประโยคทิ้ง แล้วส่งที่เหลือ)
      // กลายเป็น deterministic ด้วย ผลคือบล็อกปิดห้องด้วยกุญแจสองดอกจะไม่ทำงานกับเทิร์นนั้น
      // แม้ประโยคส่งไม้ต่อจะรอดมาถึงมือลูกค้าครบก็ตาม — ห้องจึงยังเปิดและบอทคุยต่อ
      //
      // ยอมรับสภาพนี้ไว้ก่อน ไม่แก้ในรอบนี้ เพราะมันปลอดภัยข้างที่ถูก: คำตอบที่ถูกด่านตัด
      // ไปแล้วอาจไม่ครบความหมาย ("ราคา 7,777" หายไปทั้งประโยค) การปิดห้องถาวรบนคำตอบ
      // ที่ไม่ครบคือความเสียหายที่กู้ยากกว่าการปล่อยให้เทิร์นหน้าเป็นคนปิด
      // (เทสต์ booking-handoff ล็อกพฤติกรรมนี้ไว้ทั้งสองเส้น: fallback ล้วน และกู้บางส่วน)
      deterministic = true;
      blockedDraft = true;
      check = guard.checkOutbound(draftText, guardTurn);
      if (!check.ok) return { blocked: true, violations: check.violations };
    }

    // ---- image markers: หลัง guard ผ่านเท่านั้น (guard ตรวจ raw draft รวม marker) ----
    // draft ที่โดนบล็อกถูกแทนด้วย fallback ไปแล้ว (ไม่มี marker) — รูปของ draft
    // ที่โดนบล็อกจึงไม่มีทางหลุดตามไป; key แปลกหน้าถูกทิ้งใน extractImageMarkers
    const { text: cleanText, images: markerImages } = extractImageMarkers(draftText, {
      catalog: imageCatalogByKey,
      maxImages: config.imageMaxPerReply ?? 6,
      logger,
    });

    // ---- 2026-10-03: โปสเตอร์บริการภาคบังคับที่โมเดลลืมแนบ — ระบบแนบให้เอง ----
    // พี่ง้วงทดลอง "สนใจ Private Class" แล้วได้แต่ข้อความ · วัดของจริง 30 วัน โปสเตอร์ที่พรอมต์สั่งให้ใส่
    // ถูกแนบจริงแค่ 2 ใน 4 — เฉพาะดราฟต์ปกติของโมเดล (ไม่ใช่ template/fallback/แคมเปญ) ที่ลูกค้าเอ่ยชื่อบริการเอง
    // ตัดสินด้วย decideImageOffer ตัวเดียวกับพรอมต์ แล้วยังผ่านตัวกันรูปซ้ำ เพดานรูป และนโยบายส่งตามเดิม
    let systemPosterKey = "";
    if (!deterministic && !offtopicPlan && markerImages.length < (config.imageMaxPerReply ?? 6)) {
      const required = decideImageOffer({
        currentText: text, history, allowedImages: approvedImageKeys, sentImageKeys, sentAtmosphereKeys,
        closingTurn: Boolean(handoffIntent) || Boolean(projectHandoff), careMode: priceDisclosure?.careMode,
      });
      const entry = required?.servicePoster ? imageCatalogByKey.get(required.key) : null;
      if (entry && entry.needsVerification !== true && !markerImages.some((image) => image.key === entry.key)) {
        markerImages.push({ key: entry.key, url: entry.url, previewUrl: entry.previewUrl || entry.url });
        // audit จดหลังส่งสำเร็จเท่านั้น (ด่านถัดไปยังตัดรูปได้: กันซ้ำ/เพดาน/นโยบายส่ง/Jev)
        systemPosterKey = entry.key;
      }
    }

    // ---- B1: กันรูปซ้ำ — key ที่ส่งไปแล้วใน 7 วันถูกตัดทิ้ง (เหลือ text อย่างเดียวได้) ----
    // v1.2.1: ลูกค้า "ขอรูปเอง" ในข้อความนี้ = ปลด dedupe ทั้งเทิร์น (ตัวกรองมีไว้กันบอท
    // ยัดรูปซ้ำฝ่ายเดียว ไม่ใช่ปฏิเสธคำขอตรง ๆ ของลูกค้า — เคสจริงลูกแพร 2026-08-12)
    const explicitImageAsk = customerAsksForImage(text);
    const sentKeySet = new Set(sentImageKeys);
    // ตีจบ = ข้อความลาอย่างเดียว ไม่มีรูปใดติดไป
    let images = offtopicPlan ? [] : explicitImageAsk ? markerImages : markerImages.filter((image) => !sentKeySet.has(image.key));
    if (images.length < markerImages.length) {
      const dupes = markerImages.filter((image) => sentKeySet.has(image.key)).map((image) => image.key);
      logger.debug?.(`pipeline: ตัดรูปซ้ำใน 7 วัน (${dupes.join(", ")}) customer=${customerId}`);
    }

    // ---- 2026-09-28 (audit ก.ย. §4.2): ด่านชื่อหลังร่าง — ชื่อเต็ม/handle → ชื่อต้น, เรียกไม่ถี่ ----
    const addressPlan = planCustomerAddress({
      knownName: customer?.known_name || "", displayName: customer?.display_name || "", history,
    });
    // ---- humanizer: 1-3 bubbles + opener ไม่ซ้ำ + pacing (marker ถูกลอกออกแล้ว) ----
    // 2026-10-03: ร่างของโมเดลในห้องที่ไม่มีชื่อเรียกได้ — ตัด "คุณลูกค้า" (template ตายตัวไม่แตะ)
    const addressedText = enforceCustomerAddress(cleanText, addressPlan);
    // 5 ต.ค. 2026: ด่านคำลงท้ายผู้หญิง (เปิดเฉพาะ PERSONA_PARTICLES=female) ห้ามแก้คำในชื่อลูกค้า — ปิดอยู่ = ไม่ถูกใช้
    const particleProtect = [customer?.known_name, customer?.display_name].filter((name) => typeof name === "string" && name.trim());
    // 18 ต.ค. 2026: ข้อความชำระเงินที่ระบบประกอบ (ผ่านด่านมาครบไม่ถูกแก้) ส่งตามบอลลูนที่จัดไว้เป๊ะ —
    // humanizer ยุบ/ซอยบอลลูนได้ ซึ่งจะผ่าบล็อกบัญชีหรือฟอร์มที่เจ้าของสั่งให้ส่ง "ตามตัวอักษรทั้งก้อน"
    const paymentComposed = Boolean(paymentCompose) && draftText === paymentCompose.message.text;
    const bubbles = paymentComposed
      ? paymentCompose.message.bubbles.map((bubbleText, index) => ({ text: bubbleText, pauseSec: pauseSecondsForBubble(bubbleText, index) }))
      : humanizer.humanize({
        customerId, text: deterministic ? addressedText : dropGenericAddress(addressedText, addressPlan), protect: particleProtect,
      });
    if (!bubbles.length && !images.length) {
      // เครื่องตอบ v3 ยอมถอยเพราะลูกค้าพิมพ์ต่อ (ร่างที่ตัดประโยคผิดแล้วอาจว่าง) = ยกข้อความไปรวมก้อนใหม่ ไม่ทิ้งเงียบ
      if (replyEngineMeta && laterTextPending(customerId)) return mergeForward(customerId, parts.length ? parts : [text], "empty_draft");
      logger.warn?.(`pipeline: humanize แล้วไม่เหลืออะไรให้ส่ง customer=${customerId}`);
      return { blocked: true, reason: "empty_after_humanize" };
    }

    // Optional instance policy: unlike the legacy prompt hint, this is an
    // enforcement boundary. Do not rewrite a customer-facing question: strip
    // media, preserve a safe fallback, and require a human review instead.
    const deliveryContext = {
      policy: replyDeliveryPolicy,
      route: route.route,
      intent: route.intent,
      reason: route.escalate?.reason || "",
    };

    // v1.2.5 (ตรวจอิสระ 2026-08-13): กติกาชุดนี้ (จำนวนคำถาม/บับเบิล/รูปต้องมีคำถามปิด)
    // เป็นเรื่องรูปแบบ ไม่ใช่ความปลอดภัย — ด่านความปลอดภัยจริงคือ compliance guard ที่ผ่าน
    // มาแล้วก่อนหน้านี้. การทิ้งคำตอบที่ถูกต้องทั้งก้อนแล้วส่ง template ทำให้ลูกค้าเจอทางตัน
    // ซึ่งเสียหายกว่าข้อความที่รูปแบบไม่เป๊ะมาก จึงลดทอนแบบ "ลบอย่างเดียว" แล้วส่งต่อเสมอ
    // ข้อความชำระเงินของระบบมีรูปแบบตายตัว (บัญชี/ฟอร์มตามการ์ด + ตำแหน่งรูป) — ห้ามนโยบายรูปแบบยุบบอลลูน
    const degraded = paymentComposed ? { bubbles, images, applied: [], ok: true }
      : degradeToDeliverable({ ...deliveryContext, bubbles, images });
    if (degraded.applied.length || !degraded.ok) {
      const note = degraded.applied.length ? degraded.applied.join(",") : "style_violation_accepted";
      logger.warn?.(`pipeline: reply delivery degraded (${note}) customer=${customerId}`);
      // System delivery adjustments are diagnostics, never a human correction.
      db.addAudit({ operator: "system", action: "reply_delivery_adjusted", target: customerId, detail: note });
    }
    bubbles.splice(0, bubbles.length, ...degraded.bubbles);
    images = degraded.images;

    // ---- 2026-09-28 (audit ก.ย. §6.3 / บัญชีคำติ #4 #43): เทิร์นส่งไม้ต่อต้องจบด้วยสิ่งที่จะเกิดต่อ ----
    // ห้องที่ปิดแน่หลังข้อความนี้ = งาน project ที่ scorer จะส่งต่อ หรือจอง/ติดต่อทีมงานที่ลูกแพรส่งไม้ต่อแล้ว
    // ในบอลลูนชุดนี้ (กุญแจดอกที่ 2) — คำถามที่ค้างจะไม่มีใครตอบ จึงตัดทิ้งและเติมประโยคขั้นถัดไปถ้าไม่มี
    // ไม่เปลี่ยนว่าใคร/เมื่อไหร่ส่งต่อ: การตัดประโยคไม่ทำให้ห้องที่ไม่ปิดกลายเป็นปิด (กุญแจดอกที่ 2 คงผลเดิม)
    const closingKind = deterministic ? null
      : projectHandoff ? "project"
        : handoffClosure && looksLikeHandoverReply(bubbles) ? handoffClosure.kind : null;
    if (closingKind) {
      const closed = enforceHandoffClosing(bubbles, { kind: closingKind, phoneKnown: projectHandoff?.phoneKnown === true });
      if (closed.changed && guard.checkOutbound(closed.bubbles.map((bubble) => bubble.text || "").join("\n"), guardTurn).ok) {
        bubbles.splice(0, bubbles.length, ...closed.bubbles);
        db.addAudit({
          operator: "system", action: "handoff_closing_repaired", target: customerId,
          detail: `${closingKind}: ตัดคำถาม ${closed.removed} ประโยค${closed.appended ? " + เติมประโยคขั้นถัดไป" : ""}`,
        });
      }
    }

    // Check the actual post-guard/humanized payload before any provider effect.
    // A repair passes the same money/style/media controls and a fresh judge.
    let jevFinalReview = null;
    let jevNotifyAfterDelivery = false;
    let jevStopAfterDelivery = false;
    let jevFinalConsumed = false;
    const finalText = () => [bubbles.map(b => b.text || "").join("\n"),
      ...images.map(image => `[IMAGE:${image.key}]`)].join("\n");
    const replaceReviewedReply = (replacement) => {
      if (!guard.checkOutbound(replacement, guardTurn).ok) return false;
      if (config.salesDecisionGuardEnabled && !checkBankOffer(replacement).ok) return false;
      const parsed = extractImageMarkers(replacement, { catalog: imageCatalogByKey, maxImages: config.imageMaxPerReply ?? 6, logger });
      const candidate = degradeToDeliverable({ ...deliveryContext,
        bubbles: humanizer.humanize({
          customerId, text: dropGenericAddress(enforceCustomerAddress(parsed.text, addressPlan), addressPlan), protect: particleProtect,
        }),
        images: explicitImageAsk ? parsed.images : parsed.images.filter(image => !sentKeySet.has(image.key)),
      });
      if (!candidate.bubbles.length && !candidate.images.length) return false;
      bubbles.splice(0, bubbles.length, ...candidate.bubbles);
      images = candidate.images;
      draftText = replacement;
      return true;
    };
    if (jevReview.enabled && !campaignDelivery) {
      const runFinalReview = () => reviewJevForWorkflow(jevReview, {
        customerId, sessionId, turnId: correctionInboundMessageId, stage: "draft", customer,
        latestText: text, history, knowledge: jevKnowledge, draftText: finalText(),
        workflowPolicy: config.salesDecisionGuardEnabled
          ? paymentRule + (isBankInfoConversation(customer) && (!paymentKit || !paymentTurn || paymentTurn.delivered) ? "\n" + BANK_INFO_RULE : "") : "",
        proposedAction: "allow", brainVersionId: brainVersionId || "", isCurrent: reviewCurrent,
      });
      jevFinalReview = await runFinalReview();
      if (jevReview.mode === "enforce" && !reviewCurrent()) return { suppressed: "jev_stale_draft" };
      const protectedReply = Boolean(route.template && ["urgent", "payment", "human_handoff", "identity", "optout"].includes(route.route))
        || paymentComposed;
      if (jevFinalReview.mode === "enforce" && !protectedReply) {
        if (jevFinalReview.action === "rewrite" && redraftWithExtraRule) {
          const reason = jevFinalReview.reason || "answer_quality";
          const revised = await redraftWithExtraRule(
            `ผู้ตรวจพบประเด็น ${reason}: ตอบทุกคำถามล่าสุดให้ตรง ใช้ข้อเท็จจริงจากความรู้เท่านั้น หากหลักฐานไม่พอให้ถามเจาะจง ห้ามอ้างว่าคนกำลังทำงานแล้วโดยไม่มีหลักฐาน\n${config.salesDecisionGuardEnabled ? paymentRule : ""}`);
          recordUsage(customerId, "draft", revised, brainVersionId);
          if (jevReview.mode === "enforce" && !reviewCurrent()) return { suppressed: "jev_stale_rewrite" };
          if (revised?.text && replaceReviewedReply(revised.text)) jevFinalReview = await runFinalReview();
        }
        if (jevReview.mode === "enforce" && !reviewCurrent()) return { suppressed: "jev_stale_final" };
        const verifiedHandoff = Boolean(handoffClosure && looksLikeHandoverReply(bubbles)
          && shouldStopJev(jevFinalReview, config.jevReviewThreshold)
          && jevFinalReview.checks?.answer_quality?.choice === "pass"
          && jevFinalReview.checks.answer_quality.confidence >= .8);
        if (jevFinalReview.action !== "allow" && !verifiedHandoff) {
          // A judge outage or uncertainty is a drafting problem, not evidence
          // that a person must be paged.  Send a bounded safe reply and defer
          // every customer-impacting side effect to explicit, high-confidence
          // stop/notify checks below.
          const fallback = shouldStopJev(jevFinalReview, config.jevReviewThreshold)
            ? brandText("ขอเวลาลูกแพรตรวจข้อมูลกับทีมให้เรียบร้อยก่อนนะคะ แล้วจะกลับมาตอบต่อค่ะ")
            : /^(?:ขอ|ขอดู|อยากได้|อยากทราบ|สนใจ|รบกวนขอ)?\s*(?:รายละเอียด|ข้อมูล)(?:เพิ่มเติม|หน่อย|ด้วย)?\s*(?:ครับ|ค่ะ|คะ|คับ|นะครับ|นะคะ)?[.!?\s]*$/u.test(String(text || "").trim())
              ? (isGenericProfile(config.brand)
                ? "ได้เลยค่ะ สนใจรายละเอียดด้านไหนเป็นพิเศษคะ เช่น สินค้า บริการ หรือราคา"
                : "ได้เลยค่ะ สนใจรายละเอียดด้านไหนเป็นพิเศษคะ เช่น เนื้อหาคอร์ส รูปแบบเรียน หรือราคา")
            : brandText(JEV_HOLD_FALLBACK_TEMPLATE);
          if (!replaceReviewedReply(fallback)) return { blocked: true, reason: "jev_fallback_guard" };
          deterministic = true;
        }
        // Record the verdict now, but never make an externally visible state
        // change until the reply has actually reached the customer and the
        // conversation is still current.
        jevNotifyAfterDelivery = shouldNotifyJev(jevFinalReview, config.jevReviewThreshold);
        jevStopAfterDelivery = shouldStopJev(jevFinalReview, config.jevReviewThreshold);
        jevFinalConsumed = true;
      }
    }
    if (config.salesDecisionGuardEnabled && !checkBankOffer(finalText()).ok) {
      // Delivery policy may have removed the price bubble. Never send the bank
      // image/number just because a pre-humanization draft had a valid quote.
      escalate(customerId, "price_before_bank", "รูปแบบส่งตัดราคาก่อนบัญชี — ต้องตรวจคำตอบใหม่");
      return { blocked: true, reason: "price_before_bank_after_delivery_policy" };
    }

    if (!prioritySafety && prioritySafetyPending(customerId)) {
      return { suppressed: "safety_preempted", stage: "before_send" };
    }
    // v1.4.46: ลูกค้าพิมพ์ต่อระหว่างเรากำลังคิด — คำตอบนี้จะออกช้าและดูตอบผิดคิว
    // ทิ้งดราฟต์นี้แล้วยกข้อความไปรวมกับก้อนใหม่ (เฉพาะเส้น AI; template ความปลอดภัยส่งเสมอ)
    if ((!deterministic || serviceReply || offtopicPlan) && laterTextPending(customerId)) {
      return mergeForward(customerId, turnParts.length ? turnParts : [text], "before_send");
    }

    // Validate the actual final payload, including any reviewer rewrite, before provider I/O.
    if (approvedOutlineUrls && hasUnapprovedAssetUrl(finalText(), approvedOutlineUrls)) {
      db.addAudit({ operator: "system", action: "outline_url_blocked", target: customerId,
        detail: "unapproved_asset_url" });
      escalate(customerId, "compliance_block", "Outline มีลิงก์นอกแหล่งอนุมัติ — ระงับข้อความให้ทีมตรวจ");
      return { suppressed: "outline_url_unapproved" };
    }

    // ---- control gate อ่านครั้งที่ 2: ก่อนส่ง (กัน takeover race) ----
    if (!gate.confirmBeforeSend()) {
      logger.warn?.(`pipeline: AI ถูกปิดระหว่างคิด — ไม่ส่ง customer=${customerId}`);
      return { suppressed: "ai_disabled_before_send" };
    }
    if (!sessionStillCurrent(customerId, sessionId)) {
      logger.warn?.(`pipeline: session ถูกหมุนก่อนส่ง — ไม่ส่ง customer=${customerId}`);
      return { suppressed: "session_rotated_before_send" };
    }
    if (aiPausedForReactiveCustomer({ db, config, customerId })) {
      if (aiPausedDraftModeOn({ db, config })) {
        // ร่างสุดท้ายผ่าน guard/humanizer/degrade ครบแล้ว = สิ่งที่ระบบ "จะส่ง" เป๊ะ ๆ
        // เก็บเข้า Correction Loop -> การ์ด "ร่างของลูกแพร" เหนือช่องพิมพ์ + หน้าคำแก้
        // รูปแนบเป็น [IMAGE:key] ซึ่งเส้นส่งของ operator แปลงเป็นรูปจริงอยู่แล้ว
        // พี่ง้วง 12 ต.ค. (ผู้ตรวจ): ร่างนี้ไม่ผ่านบัญชีคำชวนทดลองเรียน — แอดมินกดส่งเอง = ชวนนอกเพดานของวัน
        // จึงเอาคำชวน (ประโยคที่โค้ดเขียน + ลิงก์) ออกจากร่าง แล้วคืนสิทธิ์ที่เทิร์นนี้จองไว้
        const trialHeld = Boolean(v3TrialGate?.reserved());
        const draftText = bubbles.map((bubble) => bubble.text ?? "").filter(Boolean).join("\n");
        const draftForOperator = [
          trialHeld ? stripTrialInvite(draftText, v3TrialGate.url) : draftText,
          ...images.map((image) => `[IMAGE:${image.key}]`),
        ].filter(Boolean).join("\n");
        if (trialHeld) v3TrialGate.release();
        if (draftForOperator) db.addCorrection({
          customerId, aiDraft: draftForOperator, humanFinal: "",
          sourceReason: formatSystemCorrectionSource("system:ai_paused_draft"),
          inboundMessageId: correctionInboundMessageId,
        });
        logger.info?.(`pipeline: AI paused (โหมดร่าง) — เก็บร่างให้แอดมินแล้ว ไม่ส่ง customer=${customerId}`);
        return { suppressed: "ai_paused_draft_queued", route: route.route };
      }
      logger.warn?.(`pipeline: AI ถูก pause ระหว่างคิด — ไม่ส่ง customer=${customerId}`);
      return { suppressed: "ai_paused_before_send" };
    }

    // ด่านที่ 2 ของการกันตอบทับ: ด่านแรกเช็คก่อนเริ่มส่ง ด่านนี้เช็คซ้ำระหว่างทยอยส่ง
    // เพราะเราหน่วงจังหวะพิมพ์ระหว่างบอลลูน (~6 วิ/บอลลูน) รวมแล้วเปิดช่องไว้ราว 12 วินาที
    // ที่ลูกค้าพิมพ์แทรกได้โดยไม่มีใครเช็ค — คือรูที่เคสจริง 1 ก.ย. 2026 หลุดออกไป
    //
    // template ความปลอดภัย (เงิน/ฉุกเฉิน/ขอคน) ไม่เข้าด่านนี้ ต้องส่งครบเสมอ
    // ด่านอายุคำตอบ — ปิดไว้เป็นค่าเริ่มต้นโดยเจตนา (REPLY_MAX_AGE_MS=0)
    //
    // ตรวจซ้ำ 2026-09-01 พบว่าค่าเริ่มต้นเดิม 90 วินาทีสร้าง "ห้องเงียบ" แบบใหม่ที่เมื่อก่อน
    // ไม่มี: hermesBridge ยิงจริงได้ 2 ยก ยกละไม่เกิน HERMES_TIMEOUT_MS (ค่าเริ่มต้น 90 วิ)
    // และยังมี redraft ตอนดราฟต์ติดคำต้องห้ามอีกหนึ่งเรียก เส้นที่ "คิดสำเร็จแต่ช้า" จึงเกิน
    // 90 วินาทีได้ในการทำงานปกติ แล้วคำตอบที่ถูกต้องถูกทิ้งทั้งก้อน = ลูกค้าได้ความเงียบ
    //
    // สัญญาณ "บริบทเปลี่ยนแล้ว" ตัวจริงคือลูกค้าพิมพ์ต่อ ซึ่งมีด่านของตัวเองครบสามชั้นแล้ว
    // (laterTextPending ก่อนส่ง, stillRelevant ระหว่างทยอยส่ง, mergeForward) ถ้าลูกค้า
    // "ไม่ได้" พิมพ์อะไรเพิ่ม แปลว่าเขายังนั่งรออยู่ — คำตอบช้ายังมีค่ากว่าความเงียบเสมอ
    // ด่านนี้จึงเหลือไว้เป็นสวิตช์ให้ผู้ดูแลเปิดเองเมื่อเจอเคสค้างผิดปกติจริง ๆ เท่านั้น
    //
    // เปิดเมื่อไหร่ต้องครอบ template ปลอบใจ (deterministic) ด้วย — ของเดิมยกเว้นไว้ซึ่งกลับหัว
    // จากเจตนา: "ขอเวลาตรวจให้สักครู่" ที่มาถึงช้ากว่ากำหนดคือข้อความที่ไร้ค่าที่สุด
    // ส่วน template ความปลอดภัย (เงิน/ฉุกเฉิน/ขอคน) ยกเว้นเสมอ ต้องถึงมือลูกค้าทุกกรณี
    const replyMaxAgeMs = Number(config.replyMaxAgeMs);
    if (!prioritySafety
        && Number.isFinite(replyMaxAgeMs) && replyMaxAgeMs > 0 && inboundBasisAt > 0
        && Date.now() - inboundBasisAt > replyMaxAgeMs) {
      escalate(customerId, "reply_too_old", "คำตอบค้างนานเกินกำหนด — ไม่ส่ง ให้คนรับต่อ");
      return { suppressed: "reply_too_old" };
    }

    // คอมมิต 'sending' ลงดิสก์ก่อนไบต์แรกถึง LINE เสมอ
    // หลังบรรทัดนี้ เทิร์นนี้ห้ามถูกยกเลิก ห้ามลองใหม่ ต้องปล่อยให้จบและบันทึก
    // ถ้าโปรเซสตายหลังจากนี้ boot จะเห็น 'sending' แล้วจำแนกเป็นกำกวมให้คนตัดสิน
    markSendingIfNeeded(turnId);

    const sendResult = await outbound.lineCh.sendBubbles({
      to: outbound.to, replyToken, quoteToken, bubbles, images,
      // ข้อความชำระเงินของระบบ: สรุป → บล็อกบัญชี → รูปช่องทางชำระ → ฟอร์ม
      ...(paymentComposed && paymentCompose.message.imageAfter ? { imageAfter: paymentCompose.message.imageAfter } : {}),
      // บัญชีการส่ง LINE: reply = ฟรี · ไม่มี token/token หมดอายุ/เกิน 5 ก้อน = push นับโควตา (lineClient แยกให้เอง)
      purpose: SEND_PURPOSE.customerReply,
      // ระหว่าง drain ส่งเป็นก้อนเดียว: ตัดหน่วงจังหวะพิมพ์ 2-5 วิ/บอลลูน และลบคลาส
      // ความผิดพลาด "ลูกค้าได้บอลลูนครึ่งชุด" ทิ้ง (lineClient เขียนไว้เองว่าโหมดนี้
      // ถ้าล้มก็ล้มทั้งชุด ไม่มีกรณีลูกค้าได้ข้อความครึ่งเดียว)
      batch: draining && config.shutdownFastSend === true,
      stillRelevant: ((deterministic && !serviceReply) || prioritySafety || draining)
        ? null
        : () => (db.lastInboundAt(customerId) || 0) <= inboundBasisAt,
    });
    // ส่งไม่ครบ = ต้องบันทึกเฉพาะที่ถึงมือลูกค้าจริง ไม่งั้นประวัติแชท ค่า KPI ความเร็ว
    // และ lifecycle (price_sent/class_recommended) จะอ้างข้อความที่ไม่เคยถูกส่ง
    const deliveredMsgs = sendResult.stoppedEarly ? (sendResult.delivered || []) : null;
    const sentBubbles = deliveredMsgs
      ? bubbles.slice(0, deliveredMsgs.filter((m) => m.type === "text").length)
      : bubbles;
    const sentImages = deliveredMsgs
      ? images.slice(0, deliveredMsgs.filter((m) => m.type === "image").length)
      : images;
    // Observation only: no awaiting, no retries and no change to customer state.
    const mirrorDelivered = sendResult.ok ? sentBubbles.map((b) => b.text).filter(Boolean)
      : (sendResult.delivered || []).filter((m) => m.type === "text").map((m) => m.text).filter(Boolean);
    for (const [index, id] of mirrorIds.entries()) {
      try {
        const last = index === mirrorIds.length - 1;
        void Promise.resolve(hermes.recordMirrorDelivery?.({ id,
          status: !last ? "superseded" : sendResult.ok && !sendResult.stoppedEarly ? "delivered" : mirrorDelivered.length ? "partial" : "blocked",
          texts: last ? mirrorDelivered : [], transportStatus: sendResult.status,
          imageCount: last ? (sendResult.ok ? sentImages.length : (sendResult.delivered || []).filter((m) => m.type === "image").length) : 0,
        })).catch(() => {});
      } catch { /* Reporting must never interrupt delivery accounting. */ }
    }
    if (deliveredMsgs) {
      logger.info?.(`pipeline: ลูกค้าพิมพ์แทรกระหว่างส่ง — หยุดที่ ${sentBubbles.length}/${bubbles.length} บอลลูน รอบถัดไปตอบคำถามล่าสุด customer=${customerId}`);
    }
    if (!sessionStillCurrent(customerId, sessionId)) {
      // ข้อความอาจถึงมือลูกค้าแล้วแต่จะไม่ถูกบันทึก — ต้องดังที่สุด ห้ามหายเงียบ
      logger.error?.(`pipeline: session ถูกหมุนระหว่างส่ง — ข้อความอาจส่งแล้วแต่ไม่ถูกบันทึก customer=${customerId} sendOk=${sendResult?.ok}`);
      return { suppressed: "session_rotated_during_send", sendResult };
    }

    // ---- จังหวะราคา: หมุดถาวรทั้งสามตัวเขียนจาก "ข้อความที่ถึงมือลูกค้าจริง" เท่านั้น ----
    //
    // เขียนจากข้อความที่ส่งสำเร็จ ไม่ใช่จากดราฟต์ — เส้นที่ลูกค้าพิมพ์แทรกกลางการทยอยส่ง
    // จะหยุดที่บอลลูนที่ถึงจริง และหมุดต้องนับตามนั้นเหมือนประวัติแชทกับ lifecycle
    // ทุก UPDATE เป็น "เขียนครั้งแรกชนะ" จึงเรียกซ้ำได้ปลอดภัยเมื่อเทิร์นเดิมถูก redraft
    //
    // ตรวจปรปักษ์ 2026-09-04 (รอบที่หก): บล็อกนี้เคยนั่งอยู่ใน `if (sendResult.ok)` ก้อนเดียว
    // ทั้งที่สาขา `else if (!sendResult.blocked)` ข้างล่างมีอยู่เพราะ push ล้มกลางลูปได้
    // (เหตุจริง 429 วันที่ 2026-08-15) **หลังบอลลูนบางส่วนถึงมือลูกค้าไปแล้ว** — สาขานั้น
    // บันทึกข้อความที่ส่งได้ลง messages ครบ แต่ข้ามหมุดทั้งชุด ผลคือคำถามคัดกรองที่ลูกค้า
    // อ่านไปแล้วจริง ๆ ทิ้ง price_deferred_at = 0 ไว้ แล้วคำถามราคาครั้งถัดไปของเขาถูก
    // คัดกรอง "รอบที่สอง" ซึ่งคือความล้มเหลวที่พี่ง้วงชี้ชื่อไว้ตรง ๆ
    // ปักหมุดจากสิ่งที่ส่งถึงจริงทั้งสองสาขา ไม่ใช่จากผลลัพธ์ของ provider เป็นก้อน
    //
    // ข้อความรูปไม่มี .text จึงถูกกรองทิ้งเอง — ส่งได้แต่รูปแล้วล้ม = ลูกค้าไม่เคยเห็น
    // คำถามคัดกรอง ห้ามปักหมุด
    const recordPricePins = (deliveredTexts) => {
      const texts = (Array.isArray(deliveredTexts) ? deliveredTexts : [])
        .map((value) => String(value ?? "")).filter(Boolean);
      if (!texts.length) return;
      try {
        if (shouldRecordPriceDeferral(priceDisclosure)) db.markPriceDeferred(customerId);
        // การเลี่ยงด้วยคำถาม "สอนสดหรือออนไลน์" มีโควตาครั้งเดียวเช่นกัน — ไม่งั้นห้องเดียวกัน
        // ถูกถามคำถามเดิมได้ตลอดกาล แม้ลูกค้าจะตอบไปแล้ว (ตรวจปรปักษ์ 2026-09-04)
        if (shouldRecordOnlinePivotDeferral(priceDisclosure)) db.markOnlinePivotDeferred?.(customerId);
        // "ราคาถึงมือเขาแล้ว" ต้องเป็นสถานะถาวร ไม่ใช่การอ่านย้อนหลังจากสำนวนของโมเดล
        // (ร่างผ่าน humanizer ก่อนถึงลูกค้า และหน้าต่างประวัติเลื่อนหลุดได้)
        // จับเฉพาะราคาต่อหัวที่อนุมัติจริง — เลขจำนวนคน/ที่นั่ง/ค่าจอดรถห้ามนับเป็นการแจ้งราคา
        if (outboundCarriesClassPrice(texts.join("\n"), approvedAmounts)) db.markPriceQuoted(customerId);
      } catch (err) {
        logger.warn?.(`pipeline: ปักหมุดจังหวะราคาไม่สำเร็จ (${err?.message || err}) — ไม่มีผลกับแชทเทิร์นนี้`);
      }
    };
    if (serviceReply && !blockedDraft && sessionStillCurrent(customerId, sessionId)
      && (sendResult.ok || (sendResult.delivered ?? []).some(message => message.type === "text"))) {
      try {
        const freshState = serviceBoundaryState(db.getCustomer(customerId));
        // Do not overwrite a newer inbound's pause/resume decision while sending.
        db.setServiceBoundaryState(customerId, { ...freshState, used: { ...freshState.used, [serviceReply.topic]: true } });
      } catch {
        // Delivery already happened: never lose its transcript/receipt because
        // an auxiliary example-budget write failed.
        logger.error?.("pipeline: service example budget could not be recorded after delivery");
      }
    }
    if (sendResult.ok) {
      if (replyEngineMeta?.engine === "v3" && replyEngineMeta.providerDown !== true) {
        const complete = sendResult.stoppedEarly !== true;
        replyEngineMeta = committedReplyMeta(replyEngineMeta, {
          deliveredText: sentBubbles.map(bubble => bubble.text || "").join("\n"), complete, previousMeta: previousReplyMeta,
        });
        replyEngineMeta.contextContinuity = { ...replyEngineMeta.contextContinuity,
          sourceInboundId: correctionInboundMessageId };
      }
      const deliveredOutlines = sendResult.stoppedEarly === true ? [] : [...detectDeliveredCourseOutlines([
        { role: "assistant", content: sentBubbles.map(bubble => bubble.text || "").join("\n") },
      ])];
      const jevAppliedAfterDelivery = jevFinalConsumed && sendResult.stoppedEarly !== true
        && reviewCurrent() && markJevApplied(jevFinalReview);
      for (const bubble of sentBubbles) {
        db.insertMessage(withReplyEngineMeta({
          customerId,
          direction: "out",
          msgType: "text",
          content: bubble.text,
          messageClass: "reactive", // proactive มีเฉพาะ follow-up engine (followupEngine.mjs)
          agentMode: "ai", // B7d: AI ตอบเอง
          // คำตอบก้อนนี้ครอบข้อความลูกค้าถึง inboundBasisAt เท่านั้น — ข้อความที่พิมพ์แทรก
          // เข้ามาระหว่างทยอยส่ง (ช่องกว้าง ~12 วิ) ยังไม่มีใครตอบ ห้ามปิดเป็น 'answered'
          settleTurnsUpTo: inboundBasisAt,
          // P2: รุ่นสมองของเทิร์นที่ผลิตข้อความนี้ (null = อ่านตารางเดิม)
          brainVersionId,
          ...(knowledgeSelection && !deterministic ? { metadata: { brainRetrieval: knowledgeSelection.trace } } : {}),
          ...ownerLessonMetadata(ownerLessonIds, { deterministic, brainRetrieval: knowledgeSelection?.trace }),
          ...(deliveredOutlines.length ? { metadata: {
            ...(knowledgeSelection && !deterministic ? { brainRetrieval: knowledgeSelection.trace } : {}),
            ...(ownerLessonMetadata(ownerLessonIds, { deterministic, brainRetrieval: knowledgeSelection?.trace }).metadata || {}),
            courseOutlines: deliveredOutlines,
          } } : {}),
          // ลิงก์คลาสฟรีของรุ่นเดียวกัน — ป้ายอัตโนมัติต้องตัดสินด้วยกติกาชุดที่ห้องนี้ใช้
          freeclassPatterns: brain ? brain.bundle.rules.freeclassPatterns : null,
        }, replyEngineMeta));
      }
      for (const image of sentImages) {
        db.insertMessage(withReplyEngineMeta({
          customerId,
          direction: "out",
          msgType: "image",
          content: `[image:${image.key}] ${image.url}`,
          messageClass: "reactive",
          agentMode: "ai",
          settleTurnsUpTo: inboundBasisAt,
          brainVersionId,
          ...(knowledgeSelection && !deterministic ? { metadata: { brainRetrieval: knowledgeSelection.trace } } : {}),
          ...ownerLessonMetadata(ownerLessonIds, { deterministic, brainRetrieval: knowledgeSelection?.trace }),
          freeclassPatterns: brain ? brain.bundle.rules.freeclassPatterns : null,
        }, replyEngineMeta));
      }
      // รีวิวเคสจริงทั้งวัน 5 ต.ค.: คำตอบที่ถึงมือลูกค้าแล้วปิดเรื่องค้างของเทิร์นก่อน · เทิร์น v3 ที่ลูกค้าพิมพ์แทรกระหว่างส่ง
      // (หยุดกลางชุด หรือพิมพ์มาระหว่าง reply call) จดไว้ให้เทิร์น v3 ถัดไป — เทิร์นเครื่องเดิม replyEngineMeta = null ไม่เข้าเงื่อนไข
      v3Overlaps.delete(customerId);
      if (replyEngineMeta?.engine === "v3" && (sendResult.stoppedEarly === true || (db.lastInboundAt(customerId) || 0) > inboundBasisAt)) {
        v3Overlaps.set(customerId, { at: Date.now(), stage: replyEngineMeta.stage || "",
          delivered: sentBubbles.map((bubble) => bubble.text || "").filter(Boolean),
          undelivered: sendResult.stoppedEarly === true ? bubbles.slice(sentBubbles.length).map((bubble) => bubble.text || "").filter(Boolean) : [] });
      }

      // ---- v1.4 Lifecycle shadow ขาออก: price_sent/class_recommended จากข้อความที่
      // "ส่งสำเร็จแล้ว" เท่านั้น (ผ่าน price guard มาแล้ว = สัญญาณสะอาดสุดในระบบ) ----
      try {
        lifecycle.applyOutbound({ customerId, text: sentBubbles.map((bubble) => bubble.text).join("\n") });
      } catch (err) {
        logger.warn?.(`pipeline: lifecycle ขาออกล้มเหลว (${err?.message || err}) — ไม่มีผลกับแชท`);
      }

      recordPricePins(sentBubbles.map((bubble) => bubble.text || ""));
      recordOwnerLessonUse(db, ownerLessonIds, { deterministic, logger });

      // ---- v1.4.11 (คำสั่งพี่ง้วง 2026-08-18): ส่งเลขบัญชีแล้ว = จบหน้าที่ bot หลัก ----
      // ปิด AI ทันที + ตั้งดีล awaiting_payment + push แอดมินเข้ามาเก็บเคส — ลูกค้าพิมพ์
      // อะไรมาต่อ bot หลักเงียบ
      // 2026-09-05 (คำสั่งพี่ง้วง): ข้อยกเว้น "FU ทวงโอนยังเดิน" ของ v1.4.11 ถูกยกเลิกแล้ว —
      // ห้องที่ส่งให้ชมพู่แล้วต้องไม่มีข้อความอัตโนมัติตามไปอีกเลย
      // ตรวจด้วยป้ายโครงสร้าง "เลขที่บัญชี" ในบล็อกปิดการขาย — ห้าม hardcode เลขบัญชีจริงในโค้ด
      try {
        const outText = [...sentBubbles.map((bubble) => bubble.text || ""),
          ...sentImages.map(image => `[IMAGE:${image.key}]`)].join("\n");
        // v1.4.11b (audit จับ): ต้องเป็นบล็อกบัญชีจริง (มีตัวเลขตาม) — แค่ "เอ่ยถึง"
        // เลขที่บัญชี ("เดี๋ยวส่งเลขที่บัญชีให้นะคะ") ห้ามปิด AI; รองรับสะกด เลขบัญชี/พร้อมเพย์
        if (config.salesDecisionGuardEnabled ? checkBankOffer(outText).bank
          : /(?:เลข(?:ที่)?บัญชี|พร้อมเพย์)\s*[:：]?\s*[0-9]/u.test(outText)) {
          const customerNow = db.getCustomer(customerId);
          if (customerNow?.ai_enabled === 1) {
            if (!config.salesDecisionGuardEnabled) db.setAiEnabled(customerId, false, "bank_sent");
            else db.setFollowupEnabled(customerId, false);
            db.setDealStatus(customerId, "awaiting_payment");
            markMoneySeen(customerId, "bank_sent");
            // 2026-09-05 (คำสั่งพี่ง้วง): ถ้อยคำเดิมบอกทีมว่า "FU ทวงโอนยังเดิน" ซึ่งไม่จริงแล้ว
            db.setNeedsHuman(customerId, "bank_sent", config.salesDecisionGuardEnabled
              ? "ส่งช่องทางชำระเงินแล้ว — คนตรวจยอดจริง; AI ตอบข้อมูลทั่วไปต่อได้ และหยุด follow-up"
              : "ส่งเลขบัญชี/สรุปยอดแล้ว — แอดมินเก็บเคสต่อ (bot หลักเงียบ, follow-up หยุดแล้ว)");
            db.addAudit({
              operator: "system", action: config.salesDecisionGuardEnabled ? "bank_sent_info_continues" : "ai_off_bank_sent", target: customerId,
              detail: config.salesDecisionGuardEnabled ? "Delivered payment instructions; human verifies payment; reactive information remains enabled; follow-up stopped"
                : "ส่งเลขบัญชีให้ลูกค้าแล้ว — ปิด AI ถาวร (เปิดคืนได้ใน console); follow-up หยุดแล้ว ชมพู่ดูแลต่อ",
            });
            notifier?.fireLater({
              customerId,
              channelId: customerNow?.channel_id || "default",
              reason: "bank_sent",
              customerName: customerNow?.known_name || customerNow?.display_name || "",
              // 18 ต.ค. 2026: ข้อความเริ่มต้นของ bank_sent บอกว่า "AI หยุดตอบถาวร" ซึ่งไม่จริงเมื่อด่านเงินเปิด
              // (ปิดตัวประกอบ = ข้อความเดิมทุกไบต์)
              ...(config.salesDecisionGuardEnabled && paymentComposed ? { reasonTextOverride:
                "ระบบส่งสรุปคลาส/รอบ/ค่าเรียน + เลขบัญชี + ฟอร์มลงทะเบียนให้ลูกค้าแล้ว — รอทีมตรวจยอดโอนจริง (AI ยังตอบคำถามทั่วไปได้ ไม่ทวงโอน · follow-up หยุดแล้ว)" } : {}),
              force: true,
            });
          }
          if (paymentComposed) {
            const offer = paymentCompose.offer;
            db.addAudit({ operator: "system", action: PAYMENT_STEP_AUDIT.composed, target: customerId,
              detail: `doc=${paymentCompose.docType} course=${offer.displayName} amount=${offer.amount} price=${offer.priceSource}`
                + ` round=${offer.round?.date || (offer.roundOptions?.length ? "ask" : "none")}${paymentCompose.fromPin ? " from=pin" : ""}` });
            db.setSetting(paymentTurn.pinKey, "");
          }
        }
      } catch (err) {
        logger.error?.(`pipeline: ปิด AI หลังส่งเลขบัญชีล้มเหลว (${err?.message || err})`);
      }

      // ---- คำสั่งพี่ง้วง 2026-09-05: จอง/สมัคร หรือขอติดต่อทีมงาน = ข้อความสุดท้ายของลูกแพร ----
      //
      // "ให้สุดท้าย ลูกแพร คุยได้ และ ส่งต่อให้ชมพู่ (อันนี้ทำอยู่แล้วดีมาก)
      //  แต่ให้ ปิด AI ตัวนั้นไปเลยครับ ไม่ต้อง follow up เพราะส่งให้ ชมพู่ handle ต่อเอง"
      //
      // ของจริง 14 วันก่อนคำสั่งนี้: ลูกแพรรับปากว่า "ทีมงานจะติดต่อกลับ" 16 ครั้งใน 15 ห้อง
      // แต่ 8 ห้องยังเปิด AI อยู่ — บอทคุยต่อและ follow-up ยังทักซ้ำหลังส่งต่อไปแล้ว
      //
      // ---- กุญแจสองดอก (ออกแบบรอบสอง หลังตรวจปรปักษ์เจอ 30 ข้อในรอบแรก) ----
      // รอบแรกปิดห้องด้วย regex บนข้อความลูกค้าดอกเดียว ผลคือปิดใส่คนที่แค่ถามเรื่องจอง
      // ("ขอถามเรื่องจองหน่อยค่ะ") และพลาดคนที่จองจริง ("จอง 1 ที่ครับ") รอบนี้ต้องครบสองดอก:
      //   ดอกที่ 1 (handoffIntent) = ลูกค้าเอ่ยเรื่องจอง/ติดต่อทีมงาน ในเทิร์นนี้หรือสองเทิร์นก่อน
      //   ดอกที่ 2 (handedOver)    = ลูกแพร "รับปากว่าทีมงาน/ตัวเองจะจัดการต่อ" ในข้อความที่
      //                              ถึงมือลูกค้าจริงแล้ว — ตัวจับเดียวกับ v1.4.26 ซึ่งวัดกับ
      //                              ข้อความบอทจริง 1,202 บรรทัดมาแล้ว
      // ดอกที่ 2 คือคำพิพากษา เพราะลูกแพรอ่านความตั้งใจในภาษาไทยออก ส่วน regex อ่านไม่ออก
      // ดอกที่ 1 หลุดเกินได้โดยมีราคาแค่หนึ่งเทิร์นที่ไม่ถามคัดกรอง ไม่ใช่ห้องที่ถูกปิดถาวร
      //
      // เงื่อนไขที่เหลือมาจากข้อที่ตรวจปรปักษ์เจอทั้งหมด:
      //   · ต้องเป็นเส้นที่ลูกแพรคิดเอง (ไม่ใช่ template) — เส้น deterministic มี flow ของตัวเอง
      //   · ต้องส่งถึงลูกค้า "ครบทั้งชุด" — ลูกค้าพิมพ์แทรกกลางการทยอยส่ง (stoppedEarly)
      //     แปลว่าบอลลูนที่มีประโยคส่งไม้ต่ออาจไม่เคยถึงเขาเลย แล้วคำถามที่เขาเพิ่งพิมพ์
      //     จะถูกกลืนเป็น ai_disabled โดยไม่มีใครรู้ (ข้อ 27)
      //   · ai_enabled === 1 เท่านั้น ไม่ดู state — ธง NEEDS_HUMAN ค้างได้เป็นวันจาก
      //     hermes_down / send_failed / compliance_block โดยที่ AI ยังเปิดและบอทยังคุยอยู่
      //     ซึ่งคือประชากรที่เจ้าของบ่นถึงตรง ๆ ถ้าเช็ค state ห้องพวกนี้จะไม่มีวันถูกปิด (ข้อ 13/25)
      //
      // ต้องอยู่ "หลัง" บล็อกเลขบัญชี เพราะถ้าเทิร์นเดียวกันมีทั้งการจองและเลขบัญชี
      // เหตุปิดที่ถูกต้องคือ bank_sent (เป็นจังหวะเงิน มีของที่ต้องตรวจจริง) และห้อง
      // ถูกปิดไปแล้วตรงนั้น เงื่อนไข ai_enabled === 1 ข้างล่างจึงเป็นเท็จเอง = push ใบเดียว
      // และต้องอยู่ "ก่อน" บล็อกคำรับปาก เพื่อให้ alreadyHandled ของบล็อกนั้นเป็นจริง
      // (ห้องถูกส่งต่อแล้ว โน้ต ai_promise + push ใบที่สองจึงเป็นการปลุกทีมซ้ำเปล่า ๆ)
      try {
        if (handoffClosure && !deterministic) {
          // อ่านจาก "บอลลูนที่ถึงมือลูกค้าจริง" ไม่ใช่ดราฟต์ทั้งก้อน (เหตุผลเดียวกับหมุดราคา)
          // R2: ตัวจับเฉพาะทางของการปิดห้อง ไม่ใช่ตัวจับใบสั่งงาน v1.4.26 ที่ตั้งใจหลวมไว้
          const handedOver = looksLikeHandoverReply(sentBubbles);
          const fullyDelivered = sendResult.ok === true && sendResult.stoppedEarly !== true;
          const customerNow = db.getCustomer(customerId);
          const reviewedClosure = jevReview.mode !== "enforce"
            || (jevAppliedAfterDelivery && shouldStopJev(jevFinalReview, config.jevReviewThreshold));
          if (handedOver && fullyDelivered && customerNow?.ai_enabled === 1
              && !(config.salesDecisionGuardEnabled && isBankInfoConversation(customerNow))
              && reviewedClosure && (jevReview.mode !== "enforce" || reviewCurrent())) {
            const handoffIntentClosing = handoffClosure;
            const reason = handoffIntentClosing.kind === "booking" ? "booking_handoff" : "human_requested";
            const summary = brandText(handoffIntentClosing.kind === "booking"
              ? (isGenericProfile(activeBrand())
                ? "ลูกค้าขอสั่งซื้อ/จองแล้ว — ลูกแพรตอบรับแล้วปิด AI ถาวร รอทีมงานยืนยันรายการ"
                : "ลูกค้าขอจอง/สมัครแล้ว — ลูกแพรตอบรับแล้วปิด AI ถาวร รอชมพู่ยืนยันที่นั่ง (คำสั่งพี่ง้วง 2026-09-05)")
              : "ลูกค้าขอติดต่อทีมงาน — ลูกแพรตอบรับแล้วปิด AI ถาวร รอทีมงานเข้ามาคุยต่อ");
            escalate(customerId, reason, summary);
            notifier?.fireLater({
              customerId,
              channelId: customerNow?.channel_id || "default",
              reason,
              customerName: customerNow?.known_name || customerNow?.display_name || "",
              // ห้ามให้ cooldown 10 นาทีกลืน — คนกำลังรอที่นั่งอยู่จริง
              force: true,
            });
            applyStickyAiOff(customerId, reason);
            // ผู้ตรวจรอบสาม (ข้อ 6): เปิด "ตั๋วปลุกทีมงานหนึ่งใบ" แบบเดียวกับงาน project
            // ห้องจองคือห้องที่ลูกค้าพิมพ์ชื่อ/รอบ/วันโอนตามมาในนาทีถัดไปเป็นปกติ ถ้าไม่มีตั๋ว
            // ข้อความนั้นจะถูกกลืนเป็น ai_disabled เงียบ ๆ จนกว่าจะมีคนเปิดคิว NEEDS_HUMAN เอง
            // (เพดานเดิมคงไว้ทุกประการ: ปลุกตอนตอบครั้งแรก + อีกครั้งเดียวตอนเบอร์โผล่)
            db.setSetting(handoffReplyKey(customerId), JSON.stringify({
              createdAt: Date.now(), notified: false, phoneNotified: false, phones: [],
            }));
            // แถว audit ที่บอก "อะไรทำให้ห้องนี้ถูกปิด" — คนที่มาสอบทีหลังต้องตรวจได้ว่า
            // กุญแจดอกไหนไข และวลีไหนของลูกค้าเป็นตัวจุด โดยไม่ต้องเปิดห้องแชท (วลีสั้น ๆ)
            db.addAudit({
              operator: "system", action: "booking_handoff", target: customerId,
              detail: `${handoffIntentClosing.kind} — กุญแจ 1 (${handoffIntentClosing.from === "recent" ? "ข้อความก่อนหน้า" : "เทิร์นนี้"}) `
                + `จับได้จาก "${String(handoffIntentClosing.matched || "").slice(0, 80)}" `
                + brandText("· กุญแจ 2 (ลูกแพรส่งไม้ต่อให้คนจริงแบบไม่มีเงื่อนไขในข้อความที่ถึงมือลูกค้าแล้ว) ")
                + "(ตอบไปหนึ่งข้อความแล้วปิด AI ถาวร ไม่มี follow-up ตามอีก)",
            });
          }
        }
      } catch (err) {
        logger.error?.(`pipeline: ปิดห้องหลังลูกค้าขอจอง/ติดต่อทีมงานล้มเหลว (${err?.message || err})`);
      }

      // ---- v1.4.26 (คำสั่งพี่ง้วง 2026-08-19): บอทรับปากว่าทีมงานจะดูแล = ต้องมีคนรู้จริง ----
      // พี่ง้วงเลือกทรง "สร้างโน้ต + push แอดมิน แต่ AI คุยต่อ" — ไม่ตัดบทลูกค้า high-end
      // กลางประโยค เพราะบทสนทนายังเดินหน้าขายได้ แต่คำสัญญาต้องไม่ตกหล่น
      // เงื่อนไข: ยังไม่มี handoff จริง (ถ้ามีแล้วทีมเห็นอยู่แล้ว ไม่ต้องซ้ำ)
      try {
        const outText = bubbles.map((bubble) => bubble.text || "").join("\n");
        const customerNow = db.getCustomer(customerId);
        const alreadyHandled = customerNow?.state === "NEEDS_HUMAN" || customerNow?.ai_enabled === 0;
        const teamPromise = looksLikeTeamPromise(outText);
        const selfPromise = looksLikeSelfPromise(outText);
        if (!alreadyHandled && (teamPromise || selfPromise)) {
          // กันโน้ตซ้ำจากบทสนทนาเดียวกัน — ดูจาก DB ไม่ใช่ตัวแปรในหน่วยความจำ
          // เพราะ restart ต้องไม่ทำให้ยิงซ้ำทั้งชุด
          const recent = db.listHandoffNotes(customerId, 10)
            .filter((note) => note.author === PROMISE_NOTE_AUTHOR)
            .some((note) => Date.now() - Number(note.created_at || 0) < PROMISE_NOTE_COOLDOWN_MS);
          if (!recent) {
            const askedFor = String(text || "").replace(/\s+/gu, " ").trim().slice(0, 120);
            // คำสัญญาในนามตัวเองเร่งด่วนกว่า จึงยกขึ้นเป็นหัวโน้ตเมื่อเจอทั้งสองแบบ
            const matcher = selfPromise ? selfPromiseRe() : TEAM_PROMISE_RE;
            const promised = outText.split(/\n+/u).find((line) => matcher.test(line)) || "";
            const headline = brandText(selfPromise
              ? "⚠️ ลูกแพรรับปากว่า *ตัวเอง* จะจัดการให้ — แต่ระบบไม่มีการล็อกที่นั่ง/ออกใบเสนอราคาอัตโนมัติ\n"
                + "ต้องมีคนจริงทำเรื่องนี้ให้จบ ไม่งั้นลูกค้ารอเก้อ"
              : "⚠️ ลูกแพรรับปากลูกค้าว่าทีมงานจะดูแลต่อ — ต้องมีคนจริงตามเรื่องนี้ให้จบ");
            db.addHandoffNote({
              customerId,
              author: PROMISE_NOTE_AUTHOR,
              text: `${headline}\n`
                + `ลูกค้าถาม: "${askedFor}"\n`
                + `${activeBrand().agentName}ตอบ: "${promised.replace(/\s+/gu, " ").trim().slice(0, 160)}"\n`
                + "(AI ยังคุยต่อให้อยู่ — โน้ตนี้ไม่ได้ปิดแชท)",
            });
            // F8 (ตรวจย้อนหลัง ก.ย. 2026): push เฉพาะเมื่อมีงานที่คนต้องทำจริง — ฝั่งลูกค้าขอ/ให้สิ่งที่
            // คนต้องทำ (เบอร์ ลิงก์ ใบเสนอราคา สิทธิ์ นัดคุย โอน) หรือบอทรับปากนัดพร้อมเบอร์/เวลา
            // คำรับปากแทนคำตอบความรู้ ("ขอให้ทีมงานยืนยันรายละเอียด") = โน้ตอย่างเดียว (28/65 push เดิมเป็นแบบนี้)
            // คำสัญญาในนามตัวเอง (ล็อกที่นั่ง/ออกใบเสนอราคา) ไม่มีระบบรองรับ ปลุกคนทุกครั้งเหมือนเดิม
            const pushWorthy = selfPromise || promiseNeedsPush({
              customerTexts: [text, ...recentInboundTexts(customerId, { currentText: text })],
              promiseLine: promised,
            });
            db.addAudit({
              operator: "system",
              action: selfPromise ? "promise_self_action" : (pushWorthy ? "promise_team_followup" : "promise_team_note"),
              target: customerId,
              detail: selfPromise
                ? "บอทรับปากว่าตัวเองจะล็อกที่นั่ง/ออกใบเสนอราคา — ไม่มีระบบรองรับ ต้องมีคนทำ"
                : pushWorthy
                  ? "บอทรับปากว่าทีมงานจะดูแล — สร้างโน้ต + push แจ้งแอดมิน (AI ยังเปิด)"
                  : "บอทรับปากว่าทีมงานจะดูแล แต่ไม่มีงานที่คนต้องทำชัดเจน — สร้างโน้ตอย่างเดียว ไม่ push (AI ยังเปิด)",
            });
            if (pushWorthy) {
              notifier?.fireLater({
                customerId,
                channelId: customerNow?.channel_id || "default",
                reason: selfPromise ? "promise_self_action" : "promise_team_followup",
                customerName: customerNow?.known_name || customerNow?.display_name || "",
              });
            }
          }
        }
      } catch (err) {
        logger.error?.(`pipeline: บันทึกคำรับปากทีมงานล้มเหลว (${err?.message || err}) — ไม่มีผลกับแชท`);
      }

      // JEV can ask for an operator notification without taking the bot away
      // from an ordinary information conversation.  Conversely, a stop creates
      // a visible local handoff even when notification is not requested.  Both
      // effects happen only after a complete delivery, after the deterministic
      // payment/booking paths above, and after one final freshness check.
      if (jevAppliedAfterDelivery && (jevNotifyAfterDelivery || jevStopAfterDelivery) && reviewCurrent()) {
        const current = db.getCustomer(customerId);
        if (current?.ai_enabled === 1) {
          const reason = jevStopAfterDelivery ? "jev_review_stop" : "jev_review_notify";
          const summary = jevStopAfterDelivery
            ? "JEV ตรวจพบว่าควรให้คนรับช่วงต่อหลังส่งคำตอบที่ปลอดภัยแล้ว"
            : "JEV แนะนำให้ทีมติดตาม แต่ AI ยังตอบข้อมูลทั่วไปต่อได้";
          // Keep a pre-existing queue entry. It may be days old and is not
          // delivery proof for this verdict; the notifier's per-recipient
          // cooldown/in-flight guard deduplicates actual notifications.
          const needsJevQueue = current.state !== "NEEDS_HUMAN";
          const queued = needsJevQueue
            ? escalate(customerId, reason, summary, { markMoney: false })
            : true;
          if (jevStopAfterDelivery) {
            db.setAiEnabled(customerId, false, reason);
            db.addAudit({ operator: "system", action: "ai_off_jev_review", target: customerId,
              detail: "JEV stop verdict ผ่านเกณฑ์ความมั่นใจหลังส่งข้อความครบแล้ว" });
          }
          if (jevNotifyAfterDelivery && queued) {
            notifier?.fireLater({ customerId, channelId: current.channel_id || "default", reason,
              customerName: current.known_name || current.display_name || "",
              reasonTextOverride: "JEV แนะนำให้ทีมตรวจห้องแชทนี้" });
          }
        }
      }

      // ---- 12 ต.ค. 2026: ตีจบแชทนอกเรื่อง — คำลาถึงมือลูกค้าครบแล้วจึงปิดห้องเป็นสีเหลืองแบบเดียวกับตัวกวาด ----
      // ข้อความที่ส่งต้องเป็นคำลาของเทิร์นนี้จริง (ด่านใดแทนข้อความไปแล้ว = ไม่ปิด) · ด่านห้องตรวจซ้ำใน applyClose
      if (offtopicPlan && draftText === offtopicText && sendResult.stoppedEarly !== true && sessionStillCurrent(customerId, sessionId)) {
        offtopicOutcome = offtopicCloser.applyClose({ customerId, plan: offtopicPlan, inboundId: correctionInboundMessageId }).outcome;
      }
      // F11: สมองคิดคำตอบเองและส่งถึงลูกค้าครบแล้ว = สมองกลับมาแล้ว ปลดธงรอคนที่สมองล่มตั้งเอง
      if (!deterministic) releaseOutageFlag(customerId);
      // 2026-09-28: เทิร์นส่งต่องาน project — ถ้า scorer ไม่ส่งต่อจริง ต้องมีคนรู้ (handoffClosing.mjs)
      if (closingKind === "project") projectPromises.mark(customerId, inboundBasisAt);
      // ---- F3: ยิง scorer หลังตอบเสร็จ (fire-and-forget เฉพาะ AI path) ----
      if (!deterministic) scheduleScoring(customerId);
    } else if (!sendResult.blocked) {
      // (sticky off ด้านล่างยังทำงานแม้ส่งล้ม — จังหวะเงินต้องเป็นของคนจริงเสมอ)
      logger.error?.(`pipeline: LINE ส่งไม่สำเร็จ (mode=${sendResult.mode ?? "?"} status=${sendResult.status ?? "?"} reason=${sendResult.reason ?? "?"}) customer=${customerId}`);
      // v1.4.3: push ล้มกลางลูป (เช่นโควตาหมด 429) — ข้อความที่ออกไปแล้วต้องถูกบันทึก
      // ไม่งั้น DB ขาดทั้งที่ลูกค้าเห็นข้อความจริง (เกิดจริง 2026-08-15: "ผิดจังหวะ")
      for (const delivered of sendResult.delivered ?? []) {
        try {
          db.insertMessage(withReplyEngineMeta({
            customerId,
            direction: "out",
            msgType: delivered.type === "image" ? "image" : "text",
            content: delivered.type === "image" ? `[image] ${delivered.originalContentUrl ?? ""}` : String(delivered.text ?? ""),
            messageClass: "reactive",
            agentMode: "ai",
            // ส่งล้มกลางคัน = ลูกค้าได้ไม่ครบ ห้ามให้แถวขาออกนี้ปิดหนี้เป็น "ตอบแล้ว"
            // บัญชีเทิร์นต้องจบเป็น stranded_error(send_failed) เพื่อให้ยังเห็นว่ามีคนตกค้าง
            settleTurnsUpTo: 0,
            ...(knowledgeSelection && !deterministic ? {
              brainVersionId,
              metadata: { brainRetrieval: knowledgeSelection.trace },
            } : {}),
            ...ownerLessonMetadata(ownerLessonIds, { deterministic, brainRetrieval: knowledgeSelection?.trace }),
          }, replyEngineMeta));
        } catch (err) {
          logger.error?.(`pipeline: บันทึกข้อความที่ส่งบางส่วนไม่สำเร็จ (${err?.message || err})`);
        }
      }
      // ลูกค้าอ่านบอลลูนที่ออกไปแล้วจริง — หมุดต้องตามสิ่งที่เขาได้รับ ไม่ใช่ตามว่า
      // เทิร์นนี้จบสวยหรือเปล่า (ดูเหตุผลเต็มที่ recordPricePins)
      recordPricePins((sendResult.delivered ?? []).map((delivered) => delivered?.text ?? ""));
      if ((sendResult.delivered ?? []).length) recordOwnerLessonUse(db, ownerLessonIds, { deterministic, logger });
      escalate(customerId, "send_failed", `LINE ส่งไม่สำเร็จ (${sendResult.status ?? "?"})`);
    } else {
      logger.warn?.(`pipeline: การส่งถูกปิดกั้น (${sendResult.reason ?? "?"}) customer=${customerId}`);
    }

    // พี่ง้วง 12 ต.ค.: คำชวนทดลองเรียนฟรีที่จองสิทธิ์ไว้ — ลิงก์ถึงมือลูกค้าแล้ว = นับเป็นคำชวนของวันนี้ · ไม่ถึง/ถูกด่านแทน = คืนสิทธิ์
    // ผลส่งกำกวม (reply/push ได้ 0 หรือ 5xx — LINE อาจรับไปแล้ว) = ถือว่าคำชวนอาจถึงแล้ว ไม่คืนสิทธิ์ (กันชวนห้องเดิมซ้ำ)
    if (v3TrialGate?.reserved()) {
      v3TrialGate.settle(sendResult.ok ? sentBubbles.map((bubble) => bubble.text || "").join("\n")
        : trialDeliveredText({ sendResult, delivered: (sendResult.delivered ?? []).map((delivered) => delivered?.text ?? ""),
          intended: bubbles.map((bubble) => bubble.text ?? "") }));
    }
    // v1.4.8 (คำสั่งพี่ง้วง 2026-08-16): จังหวะเงิน — template เทิร์นนี้ออกไปแล้ว
    // จากนี้ AI เงียบถาวรสำหรับลูกค้าคนนี้ จนกว่าแอดมินจะเปิดคืนจาก console
    // 2026-09-02: identity/opt-out ก็เข้ากติกาเดียวกัน แต่ต้อง "ส่งสำเร็จ" ก่อน —
    // ส่งไม่ถึงลูกค้าแล้วยังปิดห้อง = เงียบซ้ำสองโดยไม่มีใครได้คำตอบเลย
    applyStickyAiOff(customerId, stickyAiOffReason
      || (sendResult.ok === true ? templateStickyAiOffReason(route) : ""));

    // 2026-10-03: โปสเตอร์ที่ระบบแนบให้เอง — จดเฉพาะเมื่อถึงมือลูกค้าจริง (ตัวนับนี้ใช้วัดว่าโมเดลลืมรูปบ่อยแค่ไหน)
    // sentImages = รูปที่ส่งออกไปจริง (ลูกค้าพิมพ์แทรกกลางการส่ง = รูปท้ายชุดอาจไม่ได้ออก)
    if (systemPosterKey && sendResult.ok === true && sentImages.some((image) => image.key === systemPosterKey)) {
      db.addAudit({ operator: "system", action: "service_poster_attached", target: customerId, detail: systemPosterKey });
    }

    return {
      sent: sendResult.ok === true,
      sendResult,
      route: route.route,
      intent: route.intent,
      deterministic,
      blockedDraft,
      bubbles: bubbles.length,
      imageKeys: images.map((image) => image.key),
      ...(offtopicPlan ? { offtopicClose: offtopicOutcome || "not_applied" } : {}),
    };
  }

  // Training controls share the exact customer queue held through LINE send.
  // Callers must perform both rotation and ACK inside work(), never beforehand.
  function runExclusive(customerId, work) {
    return queue.run(customerId, () => withRoomSoul(customerId, work));
  }

  return { handleEvent, handleInboundText, handleInboundAudio, respondToBurst, scoreBurst, runExclusive,
           beginDrain, abortDraftsNotSending, idle };
}
