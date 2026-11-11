// consoleApi.mjs — Operator Console (G1b): ทุกอย่างใต้ /console
//
// เส้นทางหลัก (หน้าเว็บ): GET /console (ไม่มี session -> 302 login), /console/login,
//   /console/static/<f> จาก allowlist ตายตัว (กัน path traversal)
// api หลักในไฟล์นี้: login/logout/me, inbox (G4: segment+q+limit/offset+counts),
//   conversations/:id/messages (G4: keyset pagination + mark seen), :id/reply,
//   customers/:id/{ai,name,reset,followup,followups,operator-clear,notes}, notes/:id/delete,
//   followups/:id/cancel, overview, audit
// แยกไฟล์: consoleSettingsApi.mjs (models/settings/brain-mode/knowledge/channels/corrections)
//   + consoleOrdersApi.mjs (orders — G6) + consoleExportApi.mjs (export CSV)
//
// Fail-closed: ไม่มี CONSOLE_SESSION_SECRET หรือไม่มีบัญชี operator = 503 ทุกเส้นทาง
// ทุก /console/api/* (นอกจาก login) ต้องมี session; mutating POST ต้องมี x-csrf-token
import { brandText, isGenericProfile } from "./brand.mjs";
import { createFacebookPageIdResolver } from "./businessSuiteLink.mjs";
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { aiPausedNow } from "./aiPause.mjs";
import { confirmLegacyLink, rejectLegacyLink, manualLegacyLink, normalizeDisplayName, LEGACY_SOURCE_TAG } from "./legacyLink.mjs";
import { answerPendingInbound } from "./aiPausePolicy.mjs";
import { setCustomerAiSwitch } from "./aiSwitch.mjs";
import { extractImageMarkers } from "./imageCatalog.mjs";
import { approvedClassAmounts, outboundCarriesClassPrice } from "./priceDisclosure.mjs";
import { isHumanEdit } from "./correctionCapture.mjs";
import { followupGlobalEnabled } from "./followupEngine.mjs";
import { followupThreadEnabled, followupThreadPickFor, previewStagedFollowup } from "./stagedFollowups.mjs";
import { currentUpcomingRounds } from "./roundsSource.mjs";
import { bangkokIsoDate } from "./followupTiming.mjs";
import { paymentNudgePreview } from "./paymentGentleNudge.mjs";
import { scheduleCheckFollowupEnabled } from "./scheduleCheck.mjs";
import { isBankInfoConversation } from "./salesDecisionGuard.mjs";
import {
  OPERATOR_ACTIVE_MS, OUT_OF_BAND_PAUSE_MS, oobLastKey,
} from "./pipeline.mjs";
import { bangkokDayStartMs, bangkokMonthStartMs } from "./db.mjs";
import { handleExportRoute } from "./consoleExportApi.mjs";
import { loadModelPricing, pricingById, summarizeUsage } from "./modelPricing.mjs";
import {
  computeRoas, splitLineUsage, lineCostForWindow, manualAdsForWindow,
  COST_KEYS, DEFAULT_LINE_RATE_THB,
} from "./roas.mjs";
import { ADS_KEY_SETTING } from "./adsIngest.mjs";
import { createSettingsRoutes } from "./consoleSettingsApi.mjs";
import { scorerSuggestionsEnabled, withoutScorerSuggestions } from "./scorerSuggestions.mjs";
import { createOrdersRoutes } from "./consoleOrdersApi.mjs";
import { createBroadcastRoutes } from "./consoleBroadcastApi.mjs";
import { createTrainingReviewRoutes } from "./consoleTrainingApi.mjs";
import { createOperatorAdminRoutes } from "./consoleOperatorAdminApi.mjs";
import { createConsolePushRoutes } from "./consolePushApi.mjs";
import { createConsoleJevReviewRoutes } from "./consoleJevReviewApi.mjs";
// 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง (#/owner-review) — ข้อเสนอปิดห้องรอคนยืนยัน (consoleOwnerReviewApi.mjs)
import { createConsoleOwnerReviewRoutes, ownerReviewAccess } from "./consoleOwnerReviewApi.mjs";
import { ownerReviewPushItems } from "./ownerReviewScheduler.mjs";
import { createConsoleHistoryRoutes } from "./consoleHistoryApi.mjs";
import { createConsoleJevAuditRoutes } from "./consoleJevAuditApi.mjs";
import { consoleIntroEnabled, consoleIntroMedia, createConsoleIntroRoutes, introMediaDirs, resolveIntroMediaFile } from "./consoleIntroApi.mjs";
import { createConsoleAttentionRoutes, relayList } from "./consoleAttentionApi.mjs";
import { createConsoleTeamReviewRoutes } from "./consoleTeamReviewApi.mjs";
import {
  HOT_FOLLOW_SEGMENT, createConsoleTriageRoutes, hotFollowInboxPage, isWaitingSegment, listWaitingRooms, roomTriage, waitingInboxPage,
} from "./consoleTriageApi.mjs";
import { aiOffInfo, notQualifiedReasonFor, notQualifiedTeamBlocked } from "./aiOffActor.mjs";
import { createConsoleYoloRoutes } from "./consoleYoloApi.mjs";
import { createConsoleLineUsageRoutes } from "./consoleLineUsageApi.mjs";
// 8 พ.ย. 2026: หน้า "Usage วันนี้" ของเจ้าของ (อ่านอย่างเดียว · finance.view · แคช 30 วิ)
import { createConsoleUsageRoutes } from "./consoleUsageApi.mjs";
import { QUALIFY_MODEL } from "./hermesBridge.mjs";
import { QUALIFY_DAILY_THB_CAP } from "./qualifySweep.mjs";
// 6 ต.ค. 2026: รายงานรายแอด "แอดตัวไหนพาคนแบบไหนมา" (อ่านอย่างเดียว · finance.view)
import { createConsoleAdReferralRoutes } from "./consoleAdReferralsApi.mjs";
import { createTagFrameworkRoutes } from "./consoleTagFrameworkApi.mjs";
import { createHashtagTagRoutes } from "./consoleHashtagTagsApi.mjs";
import { createConsoleBlueprintRoutes } from "./consoleBlueprintApi.mjs";
import { activeTagFramework } from "./tagFrameworkMode.mjs";
import { refreshRfmTags } from "./tags.mjs";
import { createConsoleIdentityLinkRoutes } from "./consoleIdentityLinkApi.mjs";
import { createIdentityLink } from "./identityLink.mjs";
import { canAccessConsoleRoute, hasOperatorCapability, operatorInfo } from "./operatorRoles.mjs";
// ข้อความปฏิเสธกลาง ๆ ตัวเดียว — ห้ามบอกใบ้ว่าของที่กันไว้คืออะไรหรือมีค่าเท่าไร
// ต้องเหมือนกันทั้งด่าน route และด่าน capability เพื่อไม่ให้แยกออกว่าโดนกันชั้นไหน
const DENY_NO_PERMISSION = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
// method ที่เปลี่ยนข้อมูล — ต้องผ่านด่าน Origin ก่อนเสมอ
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
import { CONSOLE_MEDIA_FILE_NAMES, GENERATED_MANIFEST_PATH, brandManifest, consoleMediaType, usesGeneratedManifest, sendConsoleHtml, serveConsolePage, serveConsoleStatic, serveConsoleWorker, serveRangeFile } from "./consoleStatic.mjs";
import { safeListOpenOrdersFor, safeOrderStats } from "./orders.mjs";
import { normalizeTag } from "./dbTags.mjs";
import { addCustomerTag, removeCustomerTag } from "./customerTagActions.mjs";
import { createReadStream } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { attachmentContentDisposition, BASIC_STICKERS, createPrivateMediaStore, normalizeHttpsOrigin, validBasicSticker } from "./messageMedia.mjs";
import { drainMessageMediaDeletionQueue } from "./messageMediaDeletion.mjs";
import { backupStatusFromDb } from "./backupStatus.mjs";
import { lineOaContextState } from "./lineOaContext.mjs";
import { eraseCustomerFromJevAuditManifests } from "./jevAuditRetention.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { adReferralCardView, adReferralChips } from "./adReferralView.mjs";
import { orderMode } from "./orderMode.mjs";

// v1.1 (item 7): ป้ายลูกค้าในแผงข้อมูล — พัง = [] (ห้ามลากหน้าแชทล้ม)
function safeListTags(db, customerId) {
  try {
    return db.listTags(customerId);
  } catch {
    return [];
  }
}
import {
  createSessions, createLoginLimiter, verifyPassword, hashPassword,
  parseCookies, sessionCookie, clearSessionCookie, SESSION_COOKIE,
} from "./auth.mjs";

// socket ที่เป็น loopback = คำขอมาผ่าน reverse proxy บนเครื่องเดียวกัน (cloudflared)
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// IP ลูกค้าจริง — หลัง cloudflared ทุกคนจะเป็น 127.0.0.1 ที่ระดับ socket ทำให้
// (ก) rate limit ผูกถัง ip เดียว = ล็อกทุกคนพร้อมกัน (DoS) (ข) audit ip ไร้ประโยชน์
// จึงอ่าน header ที่ proxy เติม: cf-connecting-ip ก่อน แล้ว x-forwarded-for ตัวแรก
// ต่อ direct (ไม่ใช่ loopback) = เชื่อ socket เท่านั้น กัน client ปลอม header
export function clientIp(req) {
  const socketIp = req.socket?.remoteAddress || "";
  if (!LOOPBACK_IPS.has(socketIp)) return socketIp || "unknown";
  const cf = String(req.headers?.["cf-connecting-ip"] || "").trim();
  if (cf) return cf;
  const xff = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  if (xff) return xff;
  return socketIp || "unknown";
}

// segment ที่ inbox กรองได้ (G4) — ต้องตรงกับ SEGMENT_WHERE ใน db.listConversations
// v1.4.33: customer = ห้องที่ติดป้าย "customer" (ลูกค้าที่ซื้อแล้ว ทีมงานดูแลเอง)
// แยกออกมาเป็นตัวกรองของตัวเองเพราะเป็นกลุ่มที่คนละโหมดกับที่เหลือทั้งหมด —
// ห้องพวกนี้บอทเงียบถาวร คนคุยเอง จึงไม่ควรปนอยู่ในรายการที่ใช้ไล่งานขายประจำวัน
// 28 ก.ย. 2026: waiting/waiting24 = คิวรอตอบชุดเดียวกับหน้าภาพรวม (consoleTriageApi.mjs) · spam = ห้องติดป้าย null
// 30 ก.ย. 2026: hotfollow = ลูกค้าร้อนรอทีมทักต่อ ชุดเดียวกับการ์ดหน้าภาพรวมและ push แจ้งทีม
// 5 ต.ค. 2026: notqualify = ห้องเหลือง "AI off (not qualify)" (ai_off_reason = not_qualified) — SQL อยู่ที่ db.mjs SEGMENT_WHERE
const INBOX_SEGMENTS = new Set(["hot", "warm", "cold", "needs", "aioff", "notqualify", "customer", "mine", "resolved", "waiting", "waiting24", "hotfollow", "spam"]);
const AMBIGUOUS_SEND_CLAIM_MS = 30 * 86_400_000;
const DEFAULT_QUICK_REPLIES = Object.freeze([
  { key: "/ราคา", label: "เช็กราคา/โปรล่าสุด", text: "ลูกแพรขอเช็กตารางราคาและโปรโมชั่นล่าสุดให้ก่อนนะคะ" },
  { key: "/บัญชี", label: "เช็กข้อมูลชำระเงิน", text: "ลูกแพรขอเช็กข้อมูลการชำระเงินล่าสุดก่อนส่งให้นะคะ" },
  { key: "/แผนที่", label: "เช็กแผนที่ล่าสุด", text: "ลูกแพรขอเช็กแผนที่และจุดสังเกตล่าสุดก่อนส่งให้นะคะ" },
  { key: "/ขอบคุณ", label: "ขอบคุณหลังได้รับข้อมูล", text: "ขอบพระคุณมากค่ะ 🙏" },
  { key: "/เตรียมตัว", label: "เช็กรายการเตรียมตัว", text: "ลูกแพรส่งรายการเตรียมตัวให้ได้ค่ะ ขอเช็กตามรอบที่ลงทะเบียนก่อนนะคะ" },
]);

// White-label: ข้อความสำเร็จรูปตั้งต้นใช้ชื่อแอดมิน AI ของร้าน · generic ไม่มี "/เตรียมตัว" (รอบเรียน)
function defaultQuickReplies(brand) {
  if (!isGenericProfile(brand) && !brand?.rewrites) return DEFAULT_QUICK_REPLIES;
  return DEFAULT_QUICK_REPLIES
    .filter((row) => !(isGenericProfile(brand) && row.key === "/เตรียมตัว"))
    .map((row) => ({ ...row, text: brandText(row.text, brand) }));
}

function normalizeQuickReplies(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(0, 20).map((row) => ({
    key: String(row?.key || "").trim().slice(0, 20),
    label: String(row?.label || "").trim().slice(0, 80),
    text: String(row?.text || "").trim().slice(0, 2000),
  })).filter((row) => /^\/\S{1,19}$/u.test(row.key) && row.text);
}

// hash หลอกสำหรับ username ที่ไม่มีจริง — ให้ login ผิด user กับผิดรหัส ใช้เวลาพอ ๆ กัน
const DUMMY_HASH = hashPassword("timing-equalizer-not-a-real-password");

// แถว inbox (listConversations แนบ fs_* มาแล้ว) → รูปเดียวกับ db.getFollowupState ที่เส้นยิงจริงอ่าน
// ห้องที่ยังไม่มีแถว followup_state = null (เหมือน getFollowupState) · badge กับเส้นยิงจริงต้องได้เวลาเดียวกัน
// 2026-09-28: เพิ่ม last_nudge_at — Facebook เว้นระยะไม้ถัดไปนับจากไม้ก่อนที่ส่งจริง ขาดตัวนี้ badge จะโชว์เวลาเดิมที่กองกันตอนเช้า
export function followupStateFromInboxRow(row) {
  if (!row?.fs_customer_id) return null;
  return {
    ladder_stage: row.fs_ladder_stage,
    stage_key: row.fs_stage_key,
    episode_anchor: row.fs_episode_anchor,
    episodes_today: row.fs_episodes_today,
    sent_today: row.fs_sent_today,
    today_key: row.fs_today_key,
    cold_sent_total: row.fs_cold_sent_total,
    defer_json: row.fs_defer_json,
    last_nudge_at: row.fs_last_nudge_at,
    // พรีวิวอ่านแค่ชนิดของไม้ล่าสุด (lastSendWasYolo) — ส่งเป็นประวัติหนึ่งแถวให้รูปเดียวกับ db.getFollowupState
    history_json: row.fs_last_send_kind ? JSON.stringify([{ kind: row.fs_last_send_kind }]) : "[]",
  };
}

// brain (G4): ของที่ AI โหลดจริงตอน start — โชว์แบบ read-only ในหน้าคลังความรู้
// { persona, brandPack, safetyRules } มาจาก createApp (ค่าเดียวกับที่ pipeline ใช้)
// W3: lineRegistry + channels — multi-OA (ไม่ส่งมา = โหมด legacy channel เดียว)
export function createConsoleApi({ config, db, line, lineRegistry = null, channels = [], imageCatalog = [], bannedWords = null, safetyRules = null, broadcastMedia = null, logger = console, now = Date.now, fx = null, brain = {}, orderWebhook = null, broadcastEngine = null, broadcastScheduler = null, learning = null, webPush = null, pipeline = null, notifier = null, yolo = null, telegram = null, tagFramework = null, identityLink = null, broadcastStudio = null, stepMessages = null, facebookPage: facebookPageResolver = null, adThumbs = null, metaCapi = null, blueprint = null, ownerReview = null }) {
  const branding = config.consoleBranding;
  const privateMedia = createPrivateMediaStore({
    dir: config.messageMediaDir,
    maxBytes: config.messageMediaMaxBytes,
    imageMaxBytes: config.messageMediaImageMaxBytes,
    minFreeBytes: config.messageMediaMinFreeBytes,
    imageMaxWidth: config.mediaUploadMaxWidth,
    imageMaxHeight: config.mediaUploadMaxHeight,
    imageMaxPixels: config.mediaUploadMaxPixels,
  });
  // สร้าง sessions เฉพาะเมื่อมี secret (fail-closed — ไม่มี secret = โหมด degraded)
  const sessions = config.consoleSessionSecret
    ? createSessions({ secret: config.consoleSessionSecret, ttlMs: config.consoleSessionTtlMs, now })
    : null;
  const limiter = createLoginLimiter({ now });
  // แคตตาล็อกรูปเดียวกับ AI path — operator ใช้ [IMAGE:key] ได้ ห้ามส่ง marker ดิบถึงลูกค้า
  const imageCatalogByKey = new Map((imageCatalog || []).map((entry) => [entry.key, entry]));

  const canMedia = (operator, capability) => hasOperatorCapability(operator, capability);
  const publicDownloadOrigin = () => normalizeHttpsOrigin(config.outboundFilePublicOrigin || config.outboundFilePublicBaseUrl || "");
  // ประตูส่งต้องรู้สถานะ private storage เหมือนประตูเสิร์ฟ — ไม่มี privateMedia ส่งมา
  // (เช่นเทสต์เก่า) ให้ถือว่าไม่พร้อม เพื่อคงทิศ fail-closed
  const privateMediaReady = () => privateMedia?.enabled?.() === true;

  // One-to-one chat accepts only the reviewed static catalog as markers.
  // Operator uploads use recipient-scoped message_attachments instead of the
  // global public broadcast-media library, so PDPA erasure can revoke bytes.
  function operatorMarkerCatalog() {
    return imageCatalogByKey;
  }

  // v1.4.8: preview follow-up ถัดไปสำหรับ badge — pure + อ่าน DB เบา ๆ; พังห้ามล้ม endpoint
  // perf 2026-08-24: เส้น inbox เคยยิง 3 query ต่อแถว (~90/รอบ poll) — listConversations
  // แนบ last_inbound_at/last_outbound_at/fs_* มาในแถวแล้ว จึงใช้ของที่มากับแถวก่อนเสมอ
  // (เส้น room-head ที่ customerRow มาจาก getCustomer ไม่มีคอลัมน์พวกนี้ ยัง fallback ยิงเอง)
  // รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 C3): ห้อง reply_engine = v3 — badge ใช้ตัวเลือกเรื่องค้างตัวเดียวกับเส้นยิงจริง
  // (เรียกเฉพาะแถวที่กำลังจะโชว์เวลาไม้ถัดไป · ประวัติไม้เต็มอ่านจาก followup_state เพราะแถว inbox แนบมาแค่ไม้ล่าสุด)
  // รอบที่ยังเปิดอ่านครั้งเดียวต่อนาที (หน้า inbox เรียกทุกแถวทุกรอบ poll)
  let threadRounds = { at: 0, day: "", rounds: [] };
  function roundsForThreads(nowMs) {
    const day = bangkokIsoDate(nowMs);
    if (threadRounds.day !== day || nowMs - threadRounds.at > 60_000) {
      threadRounds = { at: nowMs, day, rounds: currentUpcomingRounds({ db, config, todayIso: day, logger }) };
    }
    return threadRounds.rounds;
  }
  // ผลเลือกเรื่องค้างเก็บไว้ 60 วินาทีต่อห้อง (หน้า inbox poll ถี่ — อ่าน DB สี่ครั้งต่อห้องทุกรอบไม่จำเป็น) · ข้อความใหม่ทั้งสองทิศ = คีย์ใหม่
  const THREAD_PICK_TTL_MS = 60_000;
  const THREAD_PICK_MAX = 500;
  const threadPicks = new Map();
  function threadPickerFor(customerId, customerRow = null) {
    if (!followupThreadEnabled(db)) return null;
    return () => {
      const nowMs = now();
      const key = `${customerId}|${customerRow?.last_inbound_at ?? ""}|${customerRow?.last_outbound_at ?? ""}|${customerRow?.fs_ladder_stage ?? ""}`;
      const hit = customerRow ? threadPicks.get(key) : null;
      if (hit && nowMs - hit.at < THREAD_PICK_TTL_MS) return hit.pick;
      let history = [];
      try { history = JSON.parse(String(db.getFollowupState(customerId)?.history_json || "[]")); } catch { history = []; }
      const pick = followupThreadPickFor({ db, config, customer: { ...(db.getCustomer(customerId) || {}), line_user_id: customerId },
        history: Array.isArray(history) ? history : [], nowMs, rounds: roundsForThreads(nowMs), logger });
      if (customerRow) {
        if (threadPicks.size >= THREAD_PICK_MAX) threadPicks.clear();
        threadPicks.set(key, { at: nowMs, pick });
      }
      return pick;
    };
  }

  function stagedPreviewFor(customerId, customerRow) {
    try {
      if (!(config.stagedFollowupTickMs > 0)) return null;
      // 2026-09-28: ห้องรอชำระที่ AI เปิด (หลังส่งบัญชี) ไม่มีบันไดปกติ — badge บอกเวลาทักเบา ๆ ครั้งเดียวแทน
      // (ทีมเห็นก่อนว่าลูกแพรจะทักเมื่อไร จะได้ไม่พิมพ์ซ้อน) ตรรกะเดียวกับเส้นยิงจริงใน paymentGentleNudge.mjs
      if (customerRow && isBankInfoConversation(customerRow)) {
        const payment = paymentNudgePreview({ db, config, customer: { ...customerRow, line_user_id: customerId }, nowMs: now(), logger });
        if (payment) return payment;
      }
      const preloaded = customerRow && "last_inbound_at" in customerRow;
      const stateRow = preloaded ? followupStateFromInboxRow(customerRow) : db.getFollowupState(customerId);
      return previewStagedFollowup({
        customer: customerRow,
        state: stateRow,
        lastInboundAt: preloaded ? customerRow.last_inbound_at : db.lastInboundAt(customerId),
        lastOutboundAt: preloaded ? customerRow.last_outbound_at : db.lastOutboundAt(customerId),
        nowMs: now(),
        delays: {
          cold: config.stagedColdDelayMs ?? 3_600_000,
          warm: config.stagedWarmDelayMs ?? 1_800_000,
          hot: config.stagedHotDelayMs ?? 1_800_000,
        },
        // 2026-09-28: ลูกค้าขอเช็คคิวก่อน = badge บอกเวลาทักครั้งเดียว (สวิตช์ schedule_check_followup)
        scheduleCheck: scheduleCheckFollowupEnabled(db),
        threadPick: threadPickerFor(customerId, preloaded ? customerRow : null),
      });
    } catch {
      return null;
    }
  }

  // B8: ตารางราคาโมเดล — โหลดครั้งเดียวตอน start (แก้ไฟล์ = restart เหมือน config อื่น)
  const configuredAllowedModels = new Set(Array.isArray(config.hermesAllowedModels) ? config.hermesAllowedModels : []);
  const configuredReplyModels = new Set(Array.isArray(config.hermesReplyAllowedModels) && config.hermesReplyAllowedModels.length
    ? config.hermesReplyAllowedModels : configuredAllowedModels);
  const configuredScorerModels = new Set(Array.isArray(config.hermesScorerAllowedModels) && config.hermesScorerAllowedModels.length
    ? config.hermesScorerAllowedModels : configuredAllowedModels);
  const configuredFollowupModels = new Set(Array.isArray(config.hermesFollowupAllowedModels) && config.hermesFollowupAllowedModels.length
    ? config.hermesFollowupAllowedModels : configuredAllowedModels);
  const allModelPricing = loadModelPricing(config.modelPricingFile, { logger });
  const modelPricing = configuredAllowedModels.size
    ? allModelPricing.filter((entry) => configuredAllowedModels.has(entry.id))
    : allModelPricing;
  // Picker restrictions are not accounting restrictions: historical usage of
  // a retired model still has a known cost even when it can no longer be chosen.
  const pricingMap = pricingById(allModelPricing);
  const knownModelIds = new Set(modelPricing.map((entry) => entry.id));
  if (config.hermesModel && (!configuredAllowedModels.size || configuredAllowedModels.has(config.hermesModel))) knownModelIds.add(config.hermesModel);
  if (config.hermesScorerModel && (!configuredAllowedModels.size || configuredAllowedModels.has(config.hermesScorerModel))) knownModelIds.add(config.hermesScorerModel);
  if (config.hermesFollowupModel && (!configuredAllowedModels.size || configuredAllowedModels.has(config.hermesFollowupModel))) knownModelIds.add(config.hermesFollowupModel);
  const knownReplyModelIds = configuredReplyModels.size
    ? new Set([...knownModelIds].filter((id) => configuredReplyModels.has(id))) : new Set(knownModelIds);
  const knownScorerModelIds = configuredScorerModels.size
    ? new Set([...knownModelIds].filter((id) => configuredScorerModels.has(id))) : new Set(knownModelIds);
  const knownFollowupModelIds = configuredFollowupModels.size
    ? new Set([...knownModelIds].filter((id) => configuredFollowupModels.has(id))) : new Set(knownModelIds);
  const replyModelPricing = modelPricing.filter((entry) => knownReplyModelIds.has(entry.id));
  const scorerModelPricing = modelPricing.filter((entry) => knownScorerModelIds.has(entry.id));
  const followupModelPricing = modelPricing.filter((entry) => knownFollowupModelIds.has(entry.id));

  function allowedOrDefault(candidate, configuredDefault, roleAllowedModels) {
    if (!roleAllowedModels.size || roleAllowedModels.has(candidate)) return candidate;
    if (roleAllowedModels.has(configuredDefault)) return configuredDefault;
    return roleAllowedModels.values().next().value || configuredDefault;
  }

  function currentModels() {
    const replyModel = allowedOrDefault(db.getSetting("reply_model") || config.hermesModel, config.hermesModel, configuredReplyModels);
    // v1.4.9b (รีวิว 2026-08-17): ค่าที่โชว์ต้องเดินโซ่เดียวกับ hermesBridge.resolveModel
    // เป๊ะ (override -> config.hermesFollowupModel || replyModel -> config.hermesModel ->
    // ตัวแรกของ allowlist) — เดิมสาย inherit ข้าม followup allowlist ทำให้หน้าเว็บโชว์
    // โมเดลหนึ่งแต่ FU ยิงอีกโมเดล
    const resolveFollowupLike = (candidate) => {
      const chain = [candidate, config.hermesFollowupModel || replyModel, config.hermesModel];
      for (const value of chain) {
        if (value && (!configuredFollowupModels.size || configuredFollowupModels.has(value))) return value;
      }
      return configuredFollowupModels.values().next().value || (config.hermesFollowupModel || replyModel);
    };
    const followupOverride = String(db.getSetting("followup_model") || "").trim();
    return {
      replyModel,
      scorerModel: allowedOrDefault(db.getSetting("scorer_model") || config.hermesScorerModel || config.hermesModel, config.hermesScorerModel || config.hermesModel, configuredScorerModels),
      followupModel: resolveFollowupLike(followupOverride),
      followupFollowsReply: !followupOverride && !config.hermesFollowupModel,
      followupOverrideActive: Boolean(followupOverride),
      // ค่าที่ FU "จะ" ใช้ถ้าล้าง override — UI ใช้ทำ label ของ option "ตามตัวหลัก"
      followupInheritModel: resolveFollowupLike(""),
    };
  }

  // B8: rate สดจาก fxRate (cache DB + refresh เบื้องหลัง) — ไม่มี fx = env fallback
  function fxNow() {
    try {
      if (fx) return fx.current();
    } catch {
      // fx พัง — ตกไปใช้ env เงียบ ๆ (ตัวเลขต้องออกเสมอ)
    }
    return { thbPerUsd: config.thbPerUsd, source: "env", fetchedAt: null };
  }

  // สรุปค่าใช้จ่าย AI: USD จาก pricing + แปลง THB ด้วย rate ที่ส่งเข้ามา (THB-first)
  function costReport(rows, thbPerUsd) {
    const { usd, unknownTokens, unknownCacheWriteCalls, breakdown } = summarizeUsage(rows, pricingMap);
    return {
      usd,
      thb: usd * thbPerUsd,
      unknownTokens,
      unknownCacheWriteCalls,
      breakdown,
    };
  }

  // W3: ตัวช่วยต่อสาขา — channel id ที่รู้จัก + client/label ต่อ channel
  const channelById = new Map(channels.map((ch) => [ch.id, ch]));
  const isMultiChannel = channels.length > 1;
  const channelLabel = (id) => channelById.get(id)?.name || String(id || "default");
  const lineForCustomer = (row) =>
    (lineRegistry ? lineRegistry.forChannel(row?.channel_id || "default") : line);
  const rawUserId = (key) => (lineRegistry ? lineRegistry.rawUserId(key) : key);
  // channel param จาก query — { ok, channel } (ไม่ส่ง = null = ทุกสาขา)
  const parseChannelParam = (url) => {
    const value = url.searchParams.get("channel") || "";
    return value
      ? (channelById.has(value) ? { ok: true, channel: value } : { ok: false })
      : { ok: true, channel: null };
  };

  // เส้นทาง "ตั้งค่า + โมเดล + คลังความรู้ + brain + corrections" แยกไฟล์ (consoleSettingsApi.mjs)
  const settingsRoutes = createSettingsRoutes({
    config, db, modelPricing, replyModelPricing, scorerModelPricing, followupModelPricing,
    knownModelIds, knownReplyModelIds, knownScorerModelIds, knownFollowupModelIds, currentModels, fxNow,
    imageCatalog, brain, channels, sessions, logger, learning, webPush,
    // เฟส 3: ตารางตัวจริงของ runtime ที่ด่าน G5 ต้องใช้ตรวจ (ดู consoleSettingsApi)
    bannedWords, safetyRules,
    // Package K: คิวขออนุมัติต้องปลุกเจ้าของทาง LINE ตอนทีมงานส่งคำขอเข้ามา
    // ไม่ส่ง notifier = คำขอถูกเก็บเงียบ ๆ รอจนกว่าเจ้าของจะบังเอิญเปิดหน้าตั้งค่าเอง
    notifier,
    // 28 ก.ย. 2026: สวิตช์ tag_framework_mode โผล่ในแผงสวิตช์เฉพาะเมื่อมีไฟล์กรอบป้าย
    tagFramework,
  });
  // G6 (P2): เส้นทางออเดอร์ทั้งหมดแยกไฟล์ consoleOrdersApi.mjs — คุมขนาดไฟล์นี้ <800
  const ordersRoutes = createOrdersRoutes({ db, config, channelLabel, orderWebhook, now, logger, tagFramework, metaCapi });
  // v1.2: เส้นทางบรอดแคสแยกไฟล์ consoleBroadcastApi.mjs — engine มาจาก server (มี guard)
  // v1.5: Facebook ไม่มีบรอดแคสเด็ดขาด (นโยบายกันแบน) — กันตั้งแต่ picker ไม่ใช่แค่ตอนยิง
  // (facebookClient.multicast ก็ blocked อีกชั้น แต่ห้ามให้ทีมตั้งงานที่จะล้มแน่ ๆ ได้ตั้งแต่แรก)
  const broadcastRoutes = broadcastEngine
    ? createBroadcastRoutes({ db, config, engine: broadcastEngine, scheduler: broadcastScheduler, channels: channels.filter((ch) => ch.provider !== "facebook"), channelLabel, imageCatalog, broadcastMedia, logger,
      // 28 ก.ย. 2026: สตูดิโอบรอดแคสต์ + ข้อความตามขั้น อยู่ใต้ /broadcast/studio และ /broadcast/steps (สิทธิ์ OA ชุดเดียวกัน)
      studio: broadcastStudio, stepMessages, lineRegistry })
    : null;
  // `/reset` transcripts are intentionally isolated from normal operator data.
  // Only an owner can review or decide them, and a decision is not a brain write.
  const trainingReviewRoutes = createTrainingReviewRoutes({
    db,
    trainingCandidateDays: config.retentionDays?.trainingCandidate ?? 90,
  });
  const operatorAdminRoutes = createOperatorAdminRoutes({ db });
  // 12 ต.ค. 2026 ค่ำ: /push/pending ของบัญชี owner มีรายการ "รอยืนยันปิด N ห้อง" ต่อท้าย (นับอย่างเดียว ไม่มีข้อมูลลูกค้า)
  const pushRoutes = createConsolePushRoutes({ webPush, db,
    ownerItems: (operatorUsername) => ownerReviewPushItems({ db, operatorUsername, nowMs: now() }) });
  const jevReviewRoutes = createConsoleJevReviewRoutes({ db, channels, now });
  const ownerReviewRoutes = createConsoleOwnerReviewRoutes({ db, channels, now, channelLabel: (id) => channelLabel(id),
    closeService: ownerReview?.closeService ?? null, stats: () => ownerReview?.stats?.() ?? null, config, notifier, logger });
  const historyRoutes = createConsoleHistoryRoutes({ config, db, channels });
  const jevAuditRoutes = createConsoleJevAuditRoutes({ config, db, channels });
  // 28 ก.ย. 2026: เมนู Intro จักรวาลลูกแพร — ปิดเป็นค่าเริ่มต้น เจ้าของเปิดเอง (consoleIntroApi.mjs)
  const introRoutes = createConsoleIntroRoutes({ db, branding, config });
  // 28 ก.ย. 2026: "ลูกค้ารอคนตอบ" + "ลูกค้าร้อนเงียบไป รอทีมทักต่อ" บนหน้าภาพรวม (consoleAttentionApi.mjs)
  const attentionRoutes = createConsoleAttentionRoutes({ db, now, channelLabel: (id) => channelLabel(id) });
  const teamReviewRoutes = createConsoleTeamReviewRoutes({ db, now, channelLabel: (id) => channelLabel(id) });
  // 28 ก.ย. 2026: ปุ่ม "สแปม" + ข้อมูลคิวรอตอบของหน้าแชท (consoleTriageApi.mjs)
  // 28 ก.ย. 2026: รหัสเพจ Facebook สำหรับลิงก์ "เปิดห้องนี้ใน Business Suite" — ถามครั้งแรกที่เปิดห้อง Facebook แล้วจำไว้
  const facebookPage = facebookPageResolver ?? createFacebookPageIdResolver({ getClient: () => lineRegistry?.forChannel?.(FACEBOOK_CHANNEL_ID) ?? null, logger, now });
  const facebookPageIdFor = (customer) => {
    if (String(customer?.channel_id || "") !== FACEBOOK_CHANNEL_ID) return "";
    const id = facebookPage.current();
    if (!id) void facebookPage.resolve(); // ยังไม่รู้ = ถามเบื้องหลัง รอบ poll ถัดไปได้ลิงก์
    return id;
  };
  const triageRoutes = createConsoleTriageRoutes({ db, now, channelLabel: (id) => channelLabel(id), facebookPageIdFor });
  // 2026-09-28: YOLO + ตั้งค่า Telegram สั่งงานลูกแพร (ไฟล์ของตัวเอง — hook ในไฟล์นี้มีแค่สองจุด)
  const yoloRoutes = createConsoleYoloRoutes({ db, yolo, telegram });
  // 28 ก.ย. 2026: การ์ด "LINE OA เดือนนี้" — โควตาไปไหน (ทีม/บรอดแคสต์/ลูกค้า) + ราคาแพ็กเกจ (consoleLineUsageApi.mjs)
  const lineUsageRoutes = createConsoleLineUsageRoutes({ db, channels, lineRegistry, now, logger });
  const adReferralRoutes = createConsoleAdReferralRoutes({ db, now, logger });
  const usageRoutes = createConsoleUsageRoutes({
    db, now, costReport, fxNow, currentModels, qualifyModel: QUALIFY_MODEL, qualifyDailyCapThb: QUALIFY_DAILY_THB_CAP,
    gatewayBase: config.hermesBase, gatewayToken: config.hermesApiKey, logger,
  });
  const kickAdThumbs = () => { try { adThumbs?.kick?.(); } catch { /* ไม่มีรูปก็ยังเปิดห้องได้ */ } };
  // 28 ก.ย. 2026: กรอบป้ายชุดเดียว — แผงป้ายในห้องแชทจัดกลุ่มตามมิติ (consoleTagFrameworkApi.mjs)
  const tagFrameworkRoutes = createTagFrameworkRoutes({ db, tagFramework });
  // ข้อ 8: เจ้าของติ๊กเองว่าคีย์เวิร์ด # ไหนติดป้าย ของแจก:/กิจกรรม: (consoleHashtagTagsApi.mjs)
  const hashtagTagRoutes = createHashtagTagRoutes({ db, config, tagFramework, now });
  // 11 ต.ค. 2026: แคมเปญ #AIAGENT — Super Admin เท่านั้น (consoleBlueprintApi.mjs)
  const blueprintRoutes = createConsoleBlueprintRoutes({ db, sender: blueprint, now });
  // 28 ก.ย. 2026: ลูกค้าคนเดียวกันข้าม Facebook ↔ LINE — server ส่งตัวเดียวกับ webhook มาให้ (ไม่ส่ง = สร้างเอง)
  const identityLinks = identityLink ?? createIdentityLink({ config, db, lineRegistry, pipeline, notifier, logger, now });
  const identityLinkRoutes = createConsoleIdentityLinkRoutes({ db, identityLink: identityLinks });

  /* -------------------------------- helpers -------------------------------- */

  // เส้น API ของฟีเจอร์ที่ซ่อนในโปรไฟล์ generic (รอบเรียน/Intro/แอด-ROAS/Telegram-YOLO/เชื่อมตัวตน/รีวิว/ตัวทดสอบ Claude)
  function genericHiddenRoute(route) {
    const [a = "", b = "", c = ""] = route;
    if (["intro", "roas", "ad-thumbs", "reviews", "class-rounds"].includes(a)) return true;
    if (a === "settings" && ["telegram", "identity-link-templates", "fb-ad-welcome", "claude-export-testers", "freeclass"].includes(b)) return true;
    if (a === "customers" && (c === "yolo" || c === "identity")) return true;
    return false;
  }

  function redirect(res, location) {
    res.writeHead(302, { location, "cache-control": "no-store" });
    res.end();
  }

  // เงื่อนไข degraded เช็คทุก request: secret + ต้องมีบัญชี operator อย่างน้อย 1
  function degradedReason() {
    if (!sessions) return "CONSOLE_SESSION_SECRET ยังไม่ได้ตั้งค่า";
    try {
      if (db.countOperators() === 0) return "ยังไม่มีบัญชี operator (ตั้ง OPERATOR_SEED ตอน start)";
    } catch {
      return "อ่านตาราง operators ไม่ได้"; // DB พัง = fail-closed
    }
    return null;
  }

  // คืน session ที่ยืนยันแล้ว (cookie ลายเซ็นตรง + ไม่หมดอายุ + operator ยังมีจริง) หรือ null
  function currentSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const payload = sessions.verify(token);
    if (!payload) return null;
    const operator = db.getOperator(payload.u);
    if (!operator || operator.disabled) return null;
    // M1: เวอร์ชันใน token ต้องตรงกับแถว operator — เปลี่ยนรหัสผ่าน bump เวอร์ชัน = token เก่าทุกใบหลุด
    if ((Number(payload.v) || 1) !== (Number(operator.token_version) || 1)) return null;
    return { username: payload.u, sid: payload.sid, exp: payload.exp, operator };
  }

  function csrfOk(req, session) {
    return sessions.verifyCsrf(session.sid, req.headers["x-csrf-token"]);
  }

  // ที่มาที่อนุญาต: ฐาน URL ของคอนโซลที่ตั้งไว้ (ถ้ามี) + host ของคำขอเอง
  // host ของคำขอทำให้ dev/เทสต์/ตัว deploy ที่ยังไม่ได้ตั้ง CONSOLE_PUBLIC_BASE_URL ใช้งานได้
  function allowedOrigins(req) {
    const out = new Set();
    const configured = String(config.consolePublicBaseUrl || "").trim();
    if (configured) {
      try { out.add(new URL(configured).origin); } catch { /* ค่าเสีย = ไม่นับเป็นที่มาที่อนุญาต */ }
    }
    const host = String(req.headers.host || "").trim();
    if (host) {
      out.add(`https://${host}`);
      out.add(`http://${host}`);
    }
    return out;
  }

  // ด่านชั้นสองถัดจาก CSRF token — คุกกี้เป็น SameSite=Lax แล้ว จึงกัน POST ข้ามเว็บซ้ำอีกชั้น
  // ไม่มีหัว Origin = ผ่าน (client เก่า/เทสต์/เครื่องมือที่ไม่ใช่เบราว์เซอร์)
  // มีหัว Origin แต่ไม่ตรง (รวม "null" ของ iframe sandbox) = ตัดทิ้ง fail-closed
  function originOk(req) {
    const raw = req.headers.origin;
    if (raw === undefined) return true;
    let origin;
    try { origin = new URL(String(raw)).origin; } catch { return false; }
    return allowedOrigins(req).has(origin);
  }

  /* --------------------------------- login --------------------------------- */

  async function handleLogin(req, res, { readJson, json }) {
    const body = await readJson(req);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) {
      return json(res, 400, { ok: false, error: "ต้องใส่ชื่อผู้ใช้และรหัสผ่าน" });
    }

    const ip = clientIp(req);
    for (const key of [`u:${username}`, `ip:${ip}`]) {
      const lock = limiter.isLocked(key);
      if (lock.locked) {
        return json(res, 429, {
          ok: false,
          error: "ลองผิดหลายครั้งเกินไป กรุณารอสักครู่",
          retryAfterMs: lock.retryAfterMs,
        });
      }
    }

    const operator = db.getOperator(username);
    // verify เสมอแม้ไม่มี user — กัน timing บอกใบ้ว่า username ไหนมีจริง
    const passOk = verifyPassword(password, operator?.pass_hash ?? DUMMY_HASH);
    if (!operator || operator.disabled || !passOk) {
      limiter.fail(`u:${username}`);
      limiter.fail(`ip:${ip}`);
      db.addAudit({ operator: username, action: "login_failed", detail: `ip=${ip}` });
      return json(res, 401, { ok: false, error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
    }

    limiter.clear(`u:${username}`);
    limiter.clear(`ip:${ip}`);
    const session = sessions.issue(username, { tokenVersion: operator.token_version });
    db.addAudit({ operator: username, action: "login", detail: `ip=${ip}` });
    res.setHeader("set-cookie", sessionCookie(session.token, {
      ttlMs: sessions.ttlMs,
      secure: config.consoleCookieSecure,
    }));
    return json(res, 200, { ok: true, csrf: session.csrf, operator: operatorInfo(operator) });
  }

  /* ------------------------------- api routes ------------------------------ */

  async function handleApi(req, res, url, tools) {
    const { readJson, readBody, json } = tools;
    const parts = url.pathname.split("/").filter(Boolean); // ["console","api",...]
    const route = parts.slice(2); // หลัง /console/api

    // ด่าน Origin มาก่อน login/session/CSRF โดยตั้งใจ: คำขอที่เปลี่ยนข้อมูลและมาจากเว็บอื่น
    // ต้องตกตั้งแต่ต้นทาง ไม่ต้องบอกว่าตกเพราะอะไรในรายละเอียด
    if (MUTATING_METHODS.has(req.method) && !originOk(req)) {
      return json(res, 403, { ok: false, error: "คำขอนี้มาจากที่มาที่ไม่อนุญาต" });
    }

    if (req.method === "POST" && route[0] === "login" && route.length === 1) {
      return handleLogin(req, res, tools);
    }

    // ทุกอย่างหลังจากนี้ต้องมี session — ไม่มี = 401 เสมอ (deny by default)
    const session = currentSession(req);
    if (!session) {
      return json(res, 401, { ok: false, error: "ต้องเข้าสู่ระบบก่อน" });
    }
    const username = session.username;

    // White-label: โปรไฟล์ generic ไม่มีฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วง — 404 เหมือนเส้นที่ไม่มีอยู่
    if (isGenericProfile(config.brand) && genericHiddenRoute(route)) {
      return json(res, 404, { ok: false, error: "ไม่มีในแพ็กเกจของร้านนี้" });
    }

    if (req.method === "POST" && route[0] === "logout" && route.length === 1) {
      try { webPush?.disableSession({ operatorUsername: username, sessionId: session.sid }); } catch { /* cookie still clears */ }
      db.addAudit({ operator: username, action: "logout" });
      res.setHeader("set-cookie", clearSessionCookie({ secure: config.consoleCookieSecure }));
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && route[0] === "me" && route.length === 1) {
      return json(res, 200, {
        ok: true,
        operator: operatorInfo(session.operator),
        operators: db.listOperators()
          .filter((row) => Number(row.disabled) !== 1)
          .map((row) => ({ username: row.username, displayName: row.display_name, role: row.role })),
        csrf: sessions.csrfFor(session.sid),
        exp: session.exp,
        branding,
        features: {
          broadcast: Boolean(broadcastRoutes),
          // 7 ต.ค. 2026: โหมดออเดอร์ (shipping | class) — ป้ายสถานะ/ฟอร์มออเดอร์ทั้งคอนโซลอ่านจากตรงนี้
          orderMode: orderMode(db),
          // 2026-08-26: กรอกรอบเรียนเองจาก Console ได้แล้ว เมนูจึงต้องเปิดเสมอ
          // ไม่ผูกกับการมีไฟล์ในตัว release อีกต่อไป
          classRounds: !isGenericProfile(config.brand),
          imageUpload: Boolean(config.messageMediaEnabled && config.operatorFileUploadEnabled && config.outboundFileLinkEnabled && privateMedia.enabled()),
          fileUpload: Boolean(config.messageMediaEnabled && config.operatorFileUploadEnabled && config.outboundFileLinkEnabled && privateMedia.enabled()),
          stickers: Boolean(config.stickerPickerEnabled),
          webPush: webPush?.status().available === true
            && hasOperatorCapability(session.operator, "notifications.manage"),
          // เฟส 3: เมนู "กล่องตรวจ" + ปุ่ม "ทำไมตอบแบบนี้" ในห้องแชท
          // ปิดอยู่ = ไม่มีเมนู และเส้น /console/api/teach/* ตอบ 404 (ไม่ใช่ 403)
          teach: config.teachEnabled === true
            && hasOperatorCapability(session.operator, "corrections.review"),
          jevReview: config.jevReviewMode !== "off"
            && hasOperatorCapability(session.operator, "corrections.review"),
          chatHistory: config.chatHistoryEnabled === true
            && hasOperatorCapability(session.operator, "operations.use"),
          trainingIntake: config.trainingIntakeEnabled === true && config.teachEnabled === true
            && hasOperatorCapability(session.operator, "corrections.review"),
          // 2026-09-28: กล่องสอนในแผง "ทำไมตอบแบบนี้" + เมนูบทเรียน — อยู่ใต้แฟล็กจอสอนตัวเดียวกัน
          lessons: config.teachEnabled === true && hasOperatorCapability(session.operator, "lessons.teach"),
          // 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง (#/owner-review) — owner · admin · staff (closes.confirm)
          // ด่านเดียวกับ API: staff ที่ไม่ได้รับมอบสาขาไหนเลย (ร้านหลายสาขา) ไม่เห็นเมนูที่กดแล้ว 403
          ownerReview: ownerReviewAccess({ db, username, operator: session.operator, channels }),
          // เมนูขวาสุด "Intro" — ทุกบทบาทเห็นเมื่อเจ้าของเปิด (เฉพาะ instance ธีม lukprae)
          intro: !isGenericProfile(config.brand) && consoleIntroEnabled({ db, branding }),
        },
        // VAPID public key เป็นค่าสาธารณะโดยนิยาม (เบราว์เซอร์ต้องใช้ตอนสมัคร)
        // ส่งมาตั้งแต่ boot เพื่อให้หน้าเว็บสมัครใหม่เองได้เมื่อเบราว์เซอร์ทิ้งการสมัคร
        // หรือเมื่อหมุนกุญแจ โดยไม่ต้องรอให้ผู้ใช้เดินไปหน้าตั้งค่า
        webPushPublicKey: (webPush?.status().available === true
          && hasOperatorCapability(session.operator, "notifications.manage"))
          ? webPush.status().publicKey : "",
        // หน้า Intro เล่นวิดีโอเมื่อมีไฟล์จริงเท่านั้น (ไม่มี = กรอบรอ) — ตรวจเฉพาะตอนเปิดเมนูอยู่
        introMedia: consoleIntroEnabled({ db, branding }) ? consoleIntroMedia({ dirs: introMediaDirs(config) }) : { video: false, poster: false },
      });
    }

    if (req.method === "GET" && route[0] === "backup-status" && route.length === 1) {
      if (!hasOperatorCapability(session.operator, "backup.view")) {
        return json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่ดูสถานะสำรองข้อมูลได้" });
      }
      return json(res, 200, { ok: true, backup: backupStatusFromDb(db, { now: now() }) });
    }

    if (req.method === "GET" && route[0] === "quick-replies" && route.length === 1) {
      let stored = [];
      try { stored = normalizeQuickReplies(JSON.parse(db.getSetting("quick_replies_json") || "[]")); } catch { stored = []; }
      return json(res, 200, { ok: true, quickReplies: stored.length ? stored : defaultQuickReplies(config.brand) });
    }

    if (req.method === "POST" && route[0] === "quick-replies" && route.length === 1) {
      if (!hasOperatorCapability(session.operator, "settings.manage")) return json(res, 403, { ok: false, error: "เฉพาะ Super Admin หรือ Admin เท่านั้นที่แก้ข้อความสำเร็จรูปได้" });
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const body = await readJson(req);
      const rows = normalizeQuickReplies(body.quickReplies);
      if (!rows.length && Array.isArray(body.quickReplies) && body.quickReplies.length) return json(res, 400, { ok: false, error: "รูปแบบข้อความสำเร็จรูปไม่ถูกต้อง" });
      db.setSetting("quick_replies_json", JSON.stringify(rows));
      db.addAudit({ operator: username, action: "quick_replies_update", detail: `count=${rows.length}` });
      return json(res, 200, { ok: true, quickReplies: rows });
    }

    // Curated only: this list is the contract between UI and outbound LINE.
    if (req.method === "GET" && route[0] === "stickers" && route.length === 1) {
      if (!canMedia(session.operator, "media.send")) return json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ส่งสื่อ" });
      return json(res, 200, { ok: true, enabled: Boolean(config.stickerPickerEnabled), stickers: config.stickerPickerEnabled ? BASIC_STICKERS : [] });
    }

    // Console-session-only media read. No public URL is ever returned for
    // inbound/customer files. storage_key is server generated and constrained.
    if ((req.method === "GET" || req.method === "HEAD") && route[0] === "attachments" && route[2] === "content" && route.length === 3) {
      if (!canMedia(session.operator, "media.read")) return json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ดูสื่อ" });
      if (!config.messageMediaEnabled || !config.messageMediaDir) return json(res, 404, { ok: false, error: "คลังไฟล์ส่วนตัวปิดอยู่" });
      const attachment = db.getMessageAttachment(decodeURIComponent(route[1]));
      if (!attachment || attachment.status !== "ready" || !attachment.storage_key) return json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
      // perf 2026-08-24: ไฟล์แนบ immutable ต่อ id — เดิม no-store ทำให้เบราว์เซอร์โหลดรูป/สลิป
      // ซ้ำทุกครั้งที่ re-render (~ทุก 7-10 วิ) ทั้งแบนด์วิดท์และอาการกระพริบ
      // คง private (ห้าม shared cache เก็บ) + ETag จาก sha256 ที่บันทึกไว้แล้ว
      const attachmentEtag = attachment.sha256 ? `"${attachment.sha256}"` : "";
      // Revalidate the authenticated session before every reuse. The ETag still
      // avoids retransmitting the file body, while logout/session revocation
      // cannot leave customer media readable from a fresh cache hit for 24h.
      const ATTACHMENT_CACHE = "private, max-age=0, must-revalidate";
      if (attachmentEtag && String(req.headers["if-none-match"] || "") === attachmentEtag) {
        res.writeHead(304, { etag: attachmentEtag, "cache-control": ATTACHMENT_CACHE });
        return res.end();
      }
      let opened = null;
      try {
        opened = privateMedia.open(attachment.storage_key);
        const { stat, path } = opened;
        const safeInline = (attachment.kind === "image" && /^image\/(?:jpeg|png)$/u.test(attachment.mime))
          || (attachment.kind === "audio" && /^audio\/(?:mpeg|mp4|wav)$/u.test(attachment.mime))
          || (attachment.kind === "video" && /^video\/(?:mp4|quicktime)$/u.test(attachment.mime));
        const rangeHeader = safeInline ? String(req.headers.range || "") : "";
        let start = 0; let end = stat.size - 1; let partial = false;
        if (rangeHeader) {
          const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader);
          if (!match || (!match[1] && !match[2])) {
            opened.close(); opened = null;
            res.writeHead(416, { "content-range": `bytes */${stat.size}`, "cache-control": "private, no-store" });
            return res.end();
          }
          if (!match[1]) {
            const suffix = Number(match[2]);
            if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error("bad range");
            start = Math.max(0, stat.size - suffix);
          } else {
            start = Number(match[1]);
            end = match[2] ? Number(match[2]) : end;
          }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
            opened.close(); opened = null;
            res.writeHead(416, { "content-range": `bytes */${stat.size}`, "cache-control": "private, no-store" });
            return res.end();
          }
          end = Math.min(end, stat.size - 1); partial = true;
        }
        const headers = {
          "content-type": safeInline ? attachment.mime : "application/octet-stream",
          "content-length": end - start + 1,
          "content-disposition": attachmentContentDisposition(attachment.original_name || "attachment", safeInline ? "inline" : "attachment"),
          "cache-control": ATTACHMENT_CACHE,
          ...(attachmentEtag ? { etag: attachmentEtag } : {}),
          "x-content-type-options": "nosniff",
          ...(safeInline ? { "accept-ranges": "bytes" } : {}),
          ...(partial ? { "content-range": `bytes ${start}-${end}/${stat.size}` } : {}),
        };
        res.writeHead(partial ? 206 : 200, headers);
        if (req.method === "HEAD") { opened.close(); opened = null; return res.end(); }
        const stream = createReadStream(path, { fd: opened.fd, autoClose: true, start, end });
        opened = null;
        stream.on("error", () => res.destroy());
        stream.pipe(res);
        return;
      } catch {
        if (opened) try { opened.close(); } catch { /* noop */ }
        return json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
      }
    }

    // Raw binary upload is intentionally a separate endpoint from reply JSON.
    // Images, business documents, archives, audio and video pass byte-signature
    // validation; names are display metadata and never trusted as MIME proof.
    if (req.method === "POST" && route[0] === "conversations" && route[2] === "attachments" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      if (!canMedia(session.operator, "media.send")) return json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ส่งสื่อ" });
      // audit 2026-08-25 (verifier จับ): UI รายงานความสามารถเข้มกว่าเส้นอัปโหลดจริง (:396-397
      // รวม outboundFileLinkEnabled ด้วย) ผลคือถ้า outbound link ปิดแต่ upload เปิด
      // แอดมินอัปโหลดได้แต่ส่งไม่ได้ = สะสมไบต์กำพร้าบนดิสก์โดยไม่มีทางใช้
      // ปิดให้ตรงกับที่ UI รายงานและกับประตูส่ง
      if (!config.messageMediaEnabled || !config.operatorFileUploadEnabled || !config.outboundFileLinkEnabled || !privateMedia.enabled()) return json(res, 403, { ok: false, error: "การอัปโหลดไฟล์ยังไม่เปิด" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const declaredMime = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      const name = String(url.searchParams.get("name") || url.searchParams.get("label") || "attachment");
      // Browsers do not allow scripts to set Content-Length. A proxy can also
      // forward this raw upload as chunked, so accept the UI's declared size
      // only when Content-Length is absent. It reserves quota and hard-caps
      // the body read; the exact byte count is checked again afterward.
      const contentLength = req.headers["content-length"];
      const declaredSize = req.headers["x-media-size"];
      const declaredLength = contentLength == null
        ? (typeof declaredSize === "string" && /^(?:0|[1-9][0-9]*)$/u.test(declaredSize) ? Number(declaredSize) : NaN)
        : Number(contentLength);
      if (!Number.isFinite(declaredLength) || declaredLength <= 0) return json(res, 411, { ok: false, error: "ต้องระบุขนาดไฟล์ให้ถูกต้อง" });
      if (declaredLength > config.messageMediaMaxBytes) return json(res, 413, { ok: false, error: "ไฟล์ใหญ่เกินกำหนด" });
      const hourAgo = now() - 60 * 60_000;
      // Hourly limits are per operator. Durable capacity limits are global so
      // many accounts cannot each consume the full private-media allowance.
      // Reserve both bytes and a concurrency slot before awaiting the body;
      // otherwise parallel slow uploads could all pass a check-then-write gate.
      const hourlyCountLimit = Math.max(1, Number(config.messageMediaUploadsPerOperatorHour || 30));
      const hourlyBytesLimit = Math.max(config.messageMediaMaxBytes, Number(config.messageMediaOperatorHourlyBytes || config.messageMediaMaxBytes * 2));
      const totalCountLimit = Math.max(1, Number(config.messageMediaMaxActive || 10_000));
      const totalBytesLimit = Math.max(1, Number(config.messageMediaTotalBytes || 4 * 1024 * 1024 * 1024));
      let reservation;
      try {
        reservation = db.reserveMessageMediaUpload({
          operator: username,
          byteSize: declaredLength,
          sinceAt: hourAgo,
          expiresAt: now() + Math.max(120_000, Number(config.messageMediaUploadBodyTimeoutMs || 0) + 30_000),
          hourlyCountLimit,
          hourlyBytesLimit,
          totalCountLimit,
          totalBytesLimit,
          maxConcurrent: Math.max(1, Number(config.messageMediaMaxConcurrentUploads || 4)),
          maxConcurrentPerOperator: Math.max(1, Number(config.messageMediaMaxConcurrentPerOperator || 2)),
        });
      } catch {
        return json(res, 503, { ok: false, error: "ตรวจโควตาอัปโหลดไม่สำเร็จ กรุณาลองใหม่" });
      }
      if (!reservation.ok) {
        return reservation.reason === "global_quota"
          ? json(res, 507, { ok: false, error: "คลังสื่อถึงเพดาน กรุณาให้ผู้ดูแลตรวจพื้นที่" })
          : json(res, 429, { ok: false, error: reservation.reason === "concurrent" ? "มีไฟล์กำลังอัปโหลดเกินจำนวน กรุณารอให้รายการเดิมเสร็จก่อน" : "เกินโควตาอัปโหลดของบัญชีนี้" });
      }
      try {
        let buffer;
        try { buffer = await readBody(req, Math.min(config.messageMediaMaxBytes, declaredLength), { timeoutMs: config.messageMediaUploadBodyTimeoutMs, destroyOnOverflow: true }); } catch { return json(res, 413, { ok: false, error: "ไฟล์ใหญ่เกินกำหนด รับไม่ครบ หรือหมดเวลา" }); }
        if (buffer.length !== declaredLength) return json(res, 400, { ok: false, error: "ขนาดไฟล์ไม่ตรงกับที่ระบุ" });
        let saved;
        try {
          saved = await privateMedia.saveAsync({ buffer, mime: declaredMime, name, origin: "operator" });
        } catch {
          return json(res, 415, { ok: false, error: "รองรับ JPEG/PNG, PDF, Word, Excel, PowerPoint, CSV/TXT/MD/JSON, ZIP, MP4/MOV และ M4A/MP3 ที่ตรวจสอบชนิดไฟล์ได้" });
        }
        try {
          const id = db.addOperatorAttachmentWithAudit({
            attachment: { customerId, direction: "out", source: "operator_upload", kind: saved.kind, status: "ready", originalName: saved.originalName, mime: saved.mime, byteSize: saved.byteSize, sha256: saved.sha256, storageKey: saved.storageKey, createdBy: username },
            audit: { operator: username, action: "attachment_upload", target: customerId, detail: `${saved.kind}:${saved.byteSize}` },
          });
          return json(res, 201, { ok: true, attachment: { id, kind: saved.kind, original_name: saved.originalName, mime: saved.mime, byte_size: saved.byteSize, status: "ready" } });
        } catch {
          try { privateMedia.remove(saved.storageKey); } catch { /* DB/store cleanup is best-effort */ }
          return json(res, 503, { ok: false, error: "บันทึกไฟล์ไม่สำเร็จ ยังไม่ได้แนบไฟล์" });
        }
      } finally {
        try { db.releaseMessageMediaUploadReservation(reservation.id); } catch { /* expiry is the fail-safe */ }
      }
    }

    const handledByOperatorAdmin = await operatorAdminRoutes.handle(req, res, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByOperatorAdmin) return;

    const handledByPush = await pushRoutes.handle(req, res, route, {
      readJson, json, username, operator: session.operator, session,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByPush) return;

    const handledByHistory = await historyRoutes.handle(req, res, url, route, {
      json, username, operator: session.operator,
    });
    if (handledByHistory) return;

    if (config.chatHistoryEnabled === true) {
      const handledByJevAudit = await jevAuditRoutes.handle(req, res, url, route, {
        json, username, operator: session.operator, readJson,
        requireCsrf: () => csrfOk(req, session),
      });
      if (handledByJevAudit) return;
    }

    if (!canAccessConsoleRoute(session.operator, route)) {
      return json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
    }

    const handledByIntro = await introRoutes.handle(req, res, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByIntro) return;

    const handledByAttention = await attentionRoutes.handle(req, res, url, route, {
      json, operator: session.operator, parseChannelParam,
    });
    if (handledByAttention) return;
    // 3 พ.ย. 2026: ผลตรวจคำตอบของทีม — owner เท่านั้น (team_review.view)
    if (await teamReviewRoutes.handle(req, res, url, route, { json, operator: session.operator })) return;
    const handledByTriage = await triageRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByTriage) return;
    const handledByYolo = await yoloRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByYolo) return;
    const handledByLineUsage = await lineUsageRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByLineUsage) return;
    if (await adReferralRoutes.handle(req, res, url, route, { json, operator: session.operator })) return;
    if (await usageRoutes.handle(req, res, url, route, { json, operator: session.operator })) return;
    if (await tagFrameworkRoutes.handle(req, res, url, route, { json })) return;
    if (await hashtagTagRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    })) return;
    if (await blueprintRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    })) return;
    const handledByIdentityLink = await identityLinkRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByIdentityLink) return;

    // G4 volume-ready: limit/offset (default 30), q ค้นชื่อ/ชื่อจริง/ข้อความล่าสุด,
    // deep=1 ค้นทุกข้อความเก่าด้วย (ใช้เมื่อ q ยาวอย่างน้อย 2 ตัวอักษร กัน full-history scan ที่กว้างเกินไป),
    // segment=hot|warm|cold|needs|aioff — counts นับทั้งร้านเสมอ (chip ไม่สนคำค้น)
    if (req.method === "GET" && route[0] === "inbox" && route.length === 1) {
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 30));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
      const deepRaw = url.searchParams.get("deep");
      if (deepRaw != null && deepRaw !== "0" && deepRaw !== "1") {
        return json(res, 400, { ok: false, error: "deep ต้องเป็น 0 หรือ 1" });
      }
      const deep = deepRaw === "1" && q.length >= 2;
      const segment = url.searchParams.get("segment") || "";
      if (segment && !INBOX_SEGMENTS.has(segment)) {
        return json(res, 400, { ok: false, error: "segment ต้องเป็น hot, warm, cold, needs, aioff, notqualify, customer, mine, resolved, waiting, waiting24, hotfollow หรือ spam" });
      }
      // W3: กรองต่อสาขา — chip segment นับตามสาขาที่เลือกด้วย (สอดคล้องกับ list)
      const chParam = parseChannelParam(url);
      if (!chParam.ok) return json(res, 400, { ok: false, error: "channel ไม่อยู่ในรายการสาขา" });
      const t = now();
      // ตัวเลขบนชิป "รอตอบ"/"ค้าง >24 ชม." มาจากฟังก์ชันเดียวกับหน้าภาพรวม (ตรงกันเสมอ) — ~15ms ที่ 1,000 ห้อง/30 วัน
      const waiting = listWaitingRooms({ db, now: t, channel: chParam.channel, channelLabel });
      // ชิป "ไม้ต่อจากลูกแพร" (segment hotfollow ชื่อเดิม · 3 พ.ย. 2026) — อ่านพังต้องไม่ลากทั้งรายการแชทล้ม (ชิปเป็น 0 แทน)
      let hot = { total: 0, rooms: [] };
      try {
        hot = relayList(db, { now: t, channel: chParam.channel, limit: Number.POSITIVE_INFINITY, channelLabel });
      } catch { /* ตัวเลขชิปเป็น 0 — รายการอื่นยังใช้ได้ */ }
      let rows;
      let hasMore;
      let waitingOrder = null;
      if (isWaitingSegment(segment) || segment === HOT_FOLLOW_SEGMENT) {
        const page = segment === HOT_FOLLOW_SEGMENT
          ? hotFollowInboxPage({ db, hot, q, deep, limit, offset })
          : waitingInboxPage({ db, waiting, segment, q, deep, limit, offset });
        rows = page.rows;
        hasMore = page.hasMore;
        waitingOrder = page.order; // ชื่อเดิม: ลำดับทั้งคิวของชิปที่เป็นคิว (รอตอบ/รอทีมทักต่อ)
      } else {
        // ขอเกิน 1 แถวเพื่อรู้ว่ามีหน้าถัดไปไหม — ไม่ต้อง COUNT แยก
        const fetched = db.listConversations({ limit: limit + 1, offset, q, deep, segment: segment || null, channel: chParam.channel, owner: username });
        hasMore = fetched.length > limit;
        rows = hasMore ? fetched.slice(0, limit) : fetched;
      }
      // v1.4.8 (คำสั่งพี่ง้วง 2026-08-16): badge นับถอยหลัง follow-up บนแถวแชท —
      // dueAt เป็น epoch คงที่ ให้ signature dedupe ฝั่ง UI ไม่แตกทุก poll
      // 6 ต.ค. 2026 ค่ำ: ป้าย "มาจากโฆษณา" บนแถว — คิวรีเดียวทั้งหน้า (adReferralView.mjs) · ไม่ได้มาจากแอด = null
      const adChips = adReferralChips(db, rows.map((row) => row.line_user_id), { logger });
      const visibleRows = rows.map((row) => ({
        ...row,
        ad_referral: adChips.get(row.line_user_id) || null,
        staged_followup_preview: stagedPreviewFor(row.line_user_id, row),
        // ป้าย "สรุปจาก LINE OA" — คำนวณฝั่งเซิร์ฟเวอร์เพื่อให้กติกาอยู่ที่เดียว
        // (รายการซ้ายกับหัวห้องต้องไม่ตัดสินคนละแบบ) null = ห้องนี้ไม่ต้องติดป้าย
        // ห้องสแปมไม่มีเรื่องให้สรุปส่งต่อ — ป้าย "รอสรุป" บนห้องสแปมคือเสียงรบกวน
        line_oa_context: segment === "spam" ? null : lineOaContextState(row, t),
        // "AI ปิด · โดยคน/โดยระบบ" (aiOffActor.mjs) — null = AI เปิด
        // ห้องสีเหลือง: tooltip บอกเหตุจากคำตัดสินของตัวกวาด (ห้องอื่นไม่อ่านอะไรเพิ่ม)
        // รีวิวปรปักษ์รอบ 3 5 ต.ค.: หัวห้อง/คิวรอตอบบอก "รอทีม" เมื่อมีแต่ทีมปลดได้ (notQualifiedTeamBlocked) —
        // รายการซ้ายต้องบอกแบบเดียวกัน ไม่งั้นห้องเดียวขึ้นสองคำตอบ (อ่าน DB เฉพาะแถวเหลือง แถวอื่นคืน false ทันที)
        ai_off: aiOffInfo(row, { qualifyReason: notQualifiedReasonFor(db, row), teamBlocked: notQualifiedTeamBlocked(db, row) }),
      }));
      return json(res, 200, {
        ok: true,
        conversations: visibleRows,
        counts: { ...db.inboxCounts(chParam.channel, username), waiting: waiting.total, waiting24: waiting.over24, hotfollow: hot.total },
        hasMore, limit, offset,
        deepSearch: deep,
        channel: chParam.channel,
        // ลำดับทั้งคิว (ไม่ใช่แค่หน้านี้) ให้ปุ่ม "ห้องถัดไป" กับการเปิดห้องถัดไปอัตโนมัติ
        ...(waitingOrder ? { waitingOrder } : {}),
      });
    }

    // (G4: GET /console/api/brain — read-only "สมองทั้งใบ" อยู่ใน consoleSettingsApi.mjs)

    // สถิติหน้า "ภาพรวม" — ทุกตัวเลขมาจาก SQL ใน db.mjs (ไม่นับจาก list บางส่วนฝั่ง client)
    if (req.method === "GET" && route[0] === "overview" && route.length === 1) {
      // W3: channel param — สถิติ scoped ต่อสาขา (null = ทุกสาขา = ตัวเลขเดิม)
      const chParam = parseChannelParam(url);
      if (!chParam.ok) return json(res, 400, { ok: false, error: "channel ไม่อยู่ในรายการสาขา" });
      const canaryEnabled = (config.canaryIntervalMs ?? 0) > 0;
      const canaryRow = canaryEnabled ? db.getCanary("line-webhook") : null;
      // F7/W3: เริ่มอ่านโควตาพร้อมงาน SQL ด้านล่าง และหลาย OA ต้องขนานกัน
      // (เดิมเรียก default ซ้ำหนึ่งรอบ แล้ว await ทีละสาขา — OA ช้าตัวเดียวลากเวลารวมทุกตัว)
      const safeQuota = (client) => Promise.resolve().then(() => client.getQuota()).catch(() => null);
      const useMultiQuota = isMultiChannel && lineRegistry;
      const quotaTask = useMultiQuota
        ? Promise.all(
            channels
              .filter((c) => c.active && (!chParam.channel || c.id === chParam.channel))
              .map(async (ch) => ({
                channelId: ch.id,
                name: channelLabel(ch.id),
                quota: await safeQuota(lineRegistry.forChannel(ch.id)),
              })),
          )
        : safeQuota(line);
      // B8: ค่าใช้จ่าย AI วันนี้ + เดือนนี้ (ขอบเขตเวลาไทย) — พังห้ามลากหน้า overview ล้ม
      // 1 ก.ย. 2026: ต้นทุน AI เป็นตัวเลขต้นทุนบริษัท จึงคำนวณเฉพาะเมื่อผู้ดูมีสิทธิ์เห็น
      // ตัดเฉพาะฟิลด์ ไม่ปิดทั้งเส้น — เส้นนี้คือหน้าแรกหลังล็อกอินของชมพู่ ห้าม 403
      // (ผลพลอยได้: พนักงานไม่ต้องเรียก llmUsageSummary สองรอบ หน้าแรกจึงเร็วขึ้นด้วย)
      let aiCost = null;
      if (hasOperatorCapability(session.operator, "finance.view")) {
        try {
          const t = now();
          const rate = fxNow();
          aiCost = {
            thbPerUsd: rate.thbPerUsd,
            fxSource: rate.source,
            fxFetchedAt: rate.fetchedAt,
            // v1.2: ค่าใช้จ่าย AI ตามสาขาที่เลือก (null = รวมทุกสาขา — เลขเดิม)
            today: costReport(db.llmUsageSummary(bangkokDayStartMs(t), chParam.channel), rate.thbPerUsd),
            month: costReport(db.llmUsageSummary(bangkokMonthStartMs(t), chParam.channel), rate.thbPerUsd),
            ...currentModels(),
          };
        } catch {
          aiCost = null;
        }
      }
      // v1.2: อนุกรมรายวันสำหรับกราฟ — พัง = null (การ์ดกราฟไม่โชว์ ห้ามลากหน้าล้ม)
      let series = null;
      try {
        series = db.dailySeries({ channel: chParam.channel, days: 14 });
      } catch {
        series = null;
      }
      const quotaResult = await quotaTask;
      const quota = useMultiQuota ? null : quotaResult;
      const quotas = useMultiQuota ? quotaResult : null;
      return json(res, 200, {
        ok: true,
        stats: db.overviewStats(chParam.channel),
        orders: safeOrderStats(db, chParam.channel), // G6: การ์ดออเดอร์วันนี้/ยอดขายเดือนนี้
        quota,
        quotas,
        series,
        channel: chParam.channel,
        aiCost,
        followupGlobal: followupGlobalEnabled({ db, config }),
        // audit 2026-08-26: ตัวจับเวลานัดหมายเดิมถูกตรึงเป็น 0 บนเครื่องนี้ = ไม่มีวันทำงาน
        // หน้าเว็บต้องรู้ เพื่อไม่ให้ขึ้นว่า "เปิดอยู่" ทั้งที่นัดที่บันทึกไว้จะไม่ถูกส่งเลย
        followupAppointmentArmed: Number(config.followupIntervalMs) > 0,
        // ห้องที่ถูกปิด AI เองจากการจับคู่ชื่อกับระบบเก่า — เปิด AI ทั้งระบบแล้วก็ยังเงียบอยู่
        // ต้องเคลียร์ให้หมดก่อน ไม่งั้นลูกค้ากลุ่มนี้จะไม่มีใครตอบทั้งที่คิดว่าเปิดแล้ว
        roomsAwaitingLegacyConfirm: (() => {
          try { return db.countRoomsAwaitingLegacyConfirm(); } catch { return null; }
        })(),
        // v1.4.49: รายชื่อห้อง (สูงสุด 20) ให้แบนเนอร์กดเข้าห้องได้เลย
        roomsAwaitingLegacyConfirmList: (() => {
          try { return db.listRoomsAwaitingLegacyConfirm(20); } catch { return []; }
        })(),
        // เวลาที่ลูกค้าคนล่าสุดทักเข้ามา — ทำให้ "เงียบผิดปกติ" ต่างจาก "วันนี้ลูกค้าน้อย"
        lastInboundAt: (() => {
          try { return db.lastInboundAtAny(); } catch { return null; }
        })(),
        aiPaused: aiPausedNow({ db, config }), // v1.4.47
        canary: canaryEnabled
          ? {
              enabled: true,
              status: canaryRow?.status ?? "idle",
              roundTripMs: canaryRow?.round_trip_ms ?? null,
              lastProbeAt: canaryRow?.last_probe_at ?? null,
              lastOkAt: canaryRow?.last_ok_at ?? null,
              detail: canaryRow?.detail ?? "",
            }
          : { enabled: false, status: "off" },
      });
    }

    // (คิวรีวิวคำแก้ GET /corrections + /corrections/:id/decide ย้ายไป consoleSettingsApi.mjs — G6 คุมขนาดไฟล์)

    if (req.method === "GET" && route[0] === "conversations" && route[2] === "messages" && route.length === 3) {
      const customerId = decodeURIComponent(route[1]);
      // delta-audit fix: clamp ล่าง + trunc — เลขติดลบเคยทะลุเป็น LIMIT -1 (dump ทั้งประวัติ), เลขทศนิยมเคย throw
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 50));
      // G4: โหลดข้อความเก่ากว่า — beforeAt/beforeRid = cursor ของข้อความเก่าสุดที่โหลดแล้ว
      const beforeAtRaw = url.searchParams.get("beforeAt");
      const older = beforeAtRaw != null && beforeAtRaw !== ""
        ? { beforeAt: Number(beforeAtRaw), beforeRid: Number(url.searchParams.get("beforeRid")) || 0 }
        : null;
      if (older && !Number.isFinite(older.beforeAt)) {
        return json(res, 400, { ok: false, error: "beforeAt ต้องเป็น epoch ms" });
      }
      const customer = db.getCustomer(customerId);
      if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      // เปิดหัวห้อง (ไม่ใช่โหลดย้อนอดีต) = operator เห็นข้อความล่าสุดแล้ว -> จุด unread ดับ
      if (!older && url.searchParams.get("seen") !== "0") db.markConversationSeen(customerId);
      // ขอเกิน 1 แถว = รู้ว่ามีเก่ากว่านี้อีกไหม (แถวเกินคือตัวเก่าสุด — ตัดทิ้งก่อนตอบ)
      // v1.4.33 (feedback พี่ง้วง 2026-08-19): เดิมหน้าแชทเห็นเฉพาะ session ปัจจุบัน
      // พอ /reset ประวัติเก่าก็หายจากจอ (ข้อมูลไม่ได้หาย — ถูกกรองออก) ทีมงานจึงเห็น
      // เหมือนมีแค่ "วันนี้" คนดูแลลูกค้าต้องเห็นทุกอย่างที่เคยคุยกัน ไม่งั้นตอบซ้ำ
      // ตอบขัดกับที่เคยตกลง หรือถามสิ่งที่ลูกค้าบอกไปแล้ว
      // เส้นของ AI ใช้ recentTurns คนละฟังก์ชัน จึงยังถูกจำกัดที่ session เหมือนเดิม
      const batch = db.messagesFor(customerId, limit + 1, { ...(older || {}), includeArchived: true });
      const hasMoreOlder = batch.length > limit;
      const messages = hasMoreOlder ? batch.slice(1) : batch;
      // Batch load avoids an N+1 query for long imported histories.
      const byMessage = new Map();
      for (const attachment of db.attachmentsForMessages(messages.map((message) => message.id))) {
        const list = byMessage.get(attachment.message_id) || [];
        let providerMeta = {};
        try { providerMeta = JSON.parse(attachment.provider_meta_json || "{}"); } catch { /* invalid legacy metadata stays hidden */ }
        list.push({ ...attachment, provider_meta: providerMeta, provider_meta_json: undefined });
        byMessage.set(attachment.message_id, list);
      }
      for (const message of messages) {
        try { message.metadata = JSON.parse(message.metadata_json || "{}"); } catch { message.metadata = {}; }
        delete message.metadata_json;
        // Only expose proof the server actually owns. A LINE HTTP-success is
        // provider request acceptance, not device delivery and not a customer
        // read receipt. The internal attempt id stays server-side.
        const delivery = message.direction === "out" ? message.metadata?.operatorDelivery : null;
        if (delivery?.batchTail === true && ["accepted", "partial"].includes(String(delivery.state || ""))) {
          message.delivery_status = {
            state: String(delivery.state),
            proof: "line_request_accepted",
            read_receipt_available: false,
          };
        }
        if (message.metadata && typeof message.metadata === "object") delete message.metadata.operatorDelivery;
        message.attachments = byMessage.get(message.id) || [];
        // Fixed, read-only operational evidence. Scope through this already
        // authorized conversation; do not accept arbitrary message ids here.
        message.imageClassification = message.direction === "in" && message.msg_type === "image"
          ? (db.getInboundImageClassification?.({ customerId, messageId: message.id }) ?? null)
          : null;
      }
      // Resolve against the complete conversation so the signal survives a
      // keyset-pagination split between the outbound row and customer reply.
      // A reply remains interaction evidence only—not proof that one exact
      // bubble was read.
      const replyByMessage = new Map(
        db.customerReplyInteractionsForMessages(
          customerId,
          messages.filter((message) => message.direction === "out").map((message) => message.id),
        ).map((row) => [String(row.id), Number(row.replied_at)]),
      );
      for (const message of messages) {
        const repliedAt = replyByMessage.get(String(message.id));
        if (Number.isFinite(repliedAt) && repliedAt > 0) {
          message.customer_interaction_after = { type: "reply", at: repliedAt };
        }
      }
      if (older) {
        // โหลดย้อนอดีต: ตอบเบา ๆ พอ — โปรไฟล์/score/นัด ใช้ของที่หน้าโหลดไว้แล้ว
        return json(res, 200, { ok: true, messages, hasMoreOlder });
      }

      // G2a: score ล่าสุด (payload เก็บแบบ validate แล้ว — parse พังก็แค่ไม่มี panel)
      const scoreRow = db.latestScoreRow(customerId);
      let scorePayload = null;
      if (scoreRow?.payload_json) {
        try {
          scorePayload = JSON.parse(scoreRow.payload_json);
        } catch {
          scorePayload = null;
        }
      }
      // B8c: ค่าใช้จ่าย AI สะสมของลูกค้าคนนี้ (all-time) — พัง = null ("—" ฝั่ง UI)
      // 1 ก.ย. 2026: ต้นทุนรายลูกค้าเป็นตัวเลขต้นทุน จึงคิดเฉพาะเมื่อผู้ดูมีสิทธิ์เห็น
      // ตอบ 200 เสมอ ห้องแชทต้องเปิดได้ — ฝั่งหน้าเว็บมี if (!aiCost) return null อยู่แล้ว
      let aiCost = null;
      if (hasOperatorCapability(session.operator, "finance.view")) {
        try {
          const rate = fxNow();
          aiCost = {
            ...costReport(db.llmUsageForCustomer(customerId), rate.thbPerUsd),
            thbPerUsd: rate.thbPerUsd,
            fxSource: rate.source,
            fxFetchedAt: rate.fetchedAt,
          };
        } catch {
          aiCost = null;
        }
      }
      // G3: ผลตรวจสลิปล่าสุดของลูกค้าคนนี้ — พัง = [] (การ์ดสลิปแค่ไม่โชว์ ห้ามลากหน้าล้ม)
      let slipChecks = [];
      try {
        slipChecks = db.listSlipChecksFor(customerId, 20);
      } catch {
        slipChecks = [];
      }
      // G7.2: pause จาก out-of-band detection ยัง active อยู่ไหม — แบนเนอร์หน้าแชท
      // ใช้บอก "เหตุผล" ของการพัก (แยกจาก pause เพราะแอดมินตอบเองตามปกติ)
      let outOfBand = null;
      try {
        const detectedAt = Number(db.getSetting(oobLastKey(customerId)));
        if (Number.isFinite(detectedAt) && detectedAt > 0 && detectedAt + OUT_OF_BAND_PAUSE_MS > now()) {
          outOfBand = { detectedAt, until: detectedAt + OUT_OF_BAND_PAUSE_MS };
        }
      } catch {
        outOfBand = null;
      }
      // 28 ก.ย. 2026: หัวห้องแชท — รอตอบไหม/นานเท่าไร · สแปมไหม · AI ปิดเพราะใคร · FB เกิน 24 ชม.
      const triage = roomTriage({ db, customer, now: now(), channelLabel, facebookPageId: facebookPageIdFor(customer) });
      // โหลดครั้งเดียวแล้วใช้ซ้ำ — ทั้งตัว response และป้าย "สรุปจาก LINE OA" ต้องใช้ชุดเดียวกัน
      const customerTags = safeListTags(db, customerId); // v1.1 (item 7)
      const handoffNotes = db.listHandoffNotes(customerId, 50); // B6
      // หัวห้องและแผงขวาต้องรู้ว่าติดป้ายเงียบหรือยัง เพื่อโชว์ 🚫 — getCustomer ไม่มี
      // คอลัมน์รวมแบบรายการซ้าย จึงเติมจากป้ายที่โหลดมาแล้ว ไม่ต้องคิวรี่เพิ่ม
      const silencedTagAt = customerTags
        .filter((row) => ["customer", "null"].includes(String(row.tag).trim().toLowerCase()))
        .reduce((min, row) => (min == null ? row.created_at : Math.min(min, row.created_at)), null);
      return json(res, 200, {
        ok: true,
        customer: { ...customer, silenced_tag_at: silencedTagAt },
        stagedFollowupPreview: stagedPreviewFor(customerId, customer),
        messages,
        hasMoreOlder,
        pendingDraft: db.latestPendingDraft(customerId),
        suggestionsEnabled: scorerSuggestionsEnabled(db),
        score: scoreRow
          ? { score: scoreRow.score, at: scoreRow.created_at, payload: scorerSuggestionsEnabled(db) ? scorePayload : withoutScorerSuggestions(scorePayload) }
          : null,
        followups: db.listFollowupsFor(customerId, 10),
        followupGlobal: followupGlobalEnabled({ db, config }),
        // audit 2026-08-26: ตัวจับเวลานัดหมายเดิมถูกตรึงเป็น 0 บนเครื่องนี้ = ไม่มีวันทำงาน
        // หน้าเว็บต้องรู้ เพื่อไม่ให้ขึ้นว่า "เปิดอยู่" ทั้งที่นัดที่บันทึกไว้จะไม่ถูกส่งเลย
        followupAppointmentArmed: Number(config.followupIntervalMs) > 0,
        aiPaused: aiPausedNow({ db, config }), // v1.4.47
        handoffNotes,
        // ป้าย "สรุปจาก LINE OA" ในหัวห้อง — getCustomer ไม่มีคอลัมน์รวมแบบ inbox
        // จึงประกอบแถวเทียมขึ้นมา; ทุกค่าอ่านจาก DB ตรง ๆ ไม่ถอดจาก handoffNotes
        // ที่ถูกตัดด้วย LIMIT ไปแล้ว เพื่อให้ตัดสินเหมือนรายการซ้ายเป๊ะ ๆ
        lineOaContext: triage.spam ? null : lineOaContextState({
          ai_enabled: customer.ai_enabled,
          customer_tag_at: customerTags
            .find((row) => String(row.tag) === "customer")?.created_at ?? null,
          last_inbound_at: db.lastInboundAt(customerId),
          last_human_note_at: db.lastHumanHandoffNoteAt(customerId),
          last_operator_outbound_at: db.lastOperatorOutboundAt(customerId),
        }, now()),
        aiCost,
        slipChecks,
        orders: safeListOpenOrdersFor(db, customerId), // G6: ออเดอร์ค้างในแผงข้อมูล
        outOfBand, // G7.2: null = pause ปกติ/ไม่พัก
        tags: customerTags, // v1.1 (item 7): chat tags ในแผงข้อมูล
        lifecycle: db.getLifecycle(customerId),
        lifecycleEvents: db.listLifecycleEvents(customerId, 20),
        triage,
        // 6 ต.ค. 2026 ค่ำ: แถบ "มาจากโฆษณา" ใต้หัวห้อง (แบบกล่องข้อความ Meta) — null = ไม่ได้มาจากแอด/อ่านพัง
        adReferral: adReferralCardView(db, customerId, { operator: session.operator, logger, onMissingThumb: kickAdThumbs }),
        // 28 ก.ย. 2026: แผง "ช่องทางอื่นของลูกค้าคนนี้" (identityLink.mjs) — พังห้ามทำให้ห้องเปิดไม่ได้
        identityLinks: (() => {
          try { return identityLinks.panel(customerId, { operator: session.operator }); } catch { return null; }
        })(),
        legacyHistory: String(customer.legacy_link || "").startsWith("linked:")
          ? (() => {
              const legacyId = String(customer.legacy_link).slice("linked:".length);
              const legacy = db.getCustomer(legacyId);
              return legacy ? { id: legacyId, displayName: legacy.display_name || "ห้องระบบเก่า", count: db.countMessagesFor(legacyId) } : null;
            })()
          : null,
      });
    }

    // ---- mutating POSTs: ต้องผ่าน CSRF ก่อนเสมอ ----

    if (req.method === "POST" && route[0] === "conversations" && route[2] === "reply" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      const customerRow = db.getCustomer(customerId);
      if (!customerRow) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      if (safeListTags(db, customerId).some((row) => row.tag === LEGACY_SOURCE_TAG)) {
        return json(res, 409, { ok: false, error: "ห้องระบบเก่าเป็นประวัติอ้างอิงแบบอ่านอย่างเดียว กรุณาตอบในห้องจริงที่โยงแล้ว", code: "legacy_readonly" });
      }

      const body = await readJson(req);
      const operatorText = String(body.text || "").trim();
      const sticker = body.sticker && config.stickerPickerEnabled ? validBasicSticker(body.sticker) : null;
      const attachmentIds = Array.isArray(body.attachmentIds) ? [...new Set(body.attachmentIds.map(String).filter(Boolean))] : [];
      if (attachmentIds.length > 6) return json(res, 400, { ok: false, error: "ส่งไฟล์แนบได้ไม่เกิน 6 ไฟล์ต่อครั้ง" });
      if ((attachmentIds.length || body.sticker) && !canMedia(session.operator, "media.send")) return json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ส่งสื่อ" });
      const attachments = attachmentIds.map((id) => db.getMessageAttachment(id));
      if (attachments.some((item) => !item || item.customer_id !== customerId || item.direction !== "out" || item.source !== "operator_upload" || item.status !== "ready" || !["image", "file", "audio", "video"].includes(item.kind) || !item.storage_key || item.message_id || (item.send_claim_id && item.send_claim_expires_at > now()))) return json(res, 400, { ok: false, error: "ไฟล์แนบไม่พร้อม ถูกส่งแล้ว หรือไม่อยู่ในห้องนี้" });
      const downloadOrigin = publicDownloadOrigin();
      // audit 2026-08-25: ประตู "ส่ง" เคยเช็คน้อยกว่าประตู "เสิร์ฟ" (server.mjs /line-media
      // ต้องการ outboundFileLinkEnabled + messageMediaEnabled + privateMedia.enabled())
      // ผลคือ fail-OPEN: LINE ได้ URL ที่ 404 ลูกค้าเห็นรูปเสีย และเราไม่รู้ตัว
      // ตอนนี้ต้องผ่านชุดเดียวกันเป๊ะ ขาดข้อใดข้อหนึ่ง = ไม่ส่ง (fail-closed)
      if (attachments.length && (!config.outboundFileLinkEnabled || !config.messageMediaEnabled || !privateMediaReady() || !downloadOrigin)) {
        return json(res, 403, { ok: false, error: "การส่งไฟล์หรือรูปยังไม่เปิด" });
      }
      const imageAttachments = attachments.filter((item) => item.kind === "image");
      const fileAttachments = attachments.filter((item) => item.kind !== "image");

      // Static reviewed image markers remain available. New operator images are
      // recipient-scoped private attachments and never enter broadcast media.
      const { text: cleanText, images: catalogImages, dropped, overflow } = extractImageMarkers(operatorText, {
        catalog: operatorMarkerCatalog(),
        maxImages: Math.max(0, 6 - imageAttachments.length),
        logger,
      });
      if ((catalogImages.length || imageAttachments.length) && !canMedia(session.operator, "media.send")) {
        return json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ส่งสื่อ" });
      }
      if (body.sticker && !sticker) {
        return json(res, 400, { ok: false, error: "สติกเกอร์ยังไม่เปิดหรือไม่อยู่ในรายการที่อนุมัติ" });
      }
      if (!cleanText && !catalogImages.length && !attachments.length && !sticker) {
        return json(res, 400, {
          ok: false,
          error: dropped.length ? "ไม่เหลือข้อความหลังตัด marker และไม่มีรูปที่อยู่ในแคตตาล็อก" : "ข้อความหรือไฟล์แนบต้องไม่ว่าง",
          droppedImageKeys: dropped,
        });
      }

      const capabilityLinks = [];
      const pendingCapabilities = [];
      const privateImages = [];
      for (const attachment of attachments) {
        const token = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const capabilityTtlMs = attachment.kind === "image"
          ? config.outboundImageLinkTtlMs
          : config.outboundFileLinkTtlMs;
        pendingCapabilities.push({ tokenHash, attachmentId: attachment.id, expiresAt: now() + capabilityTtlMs });
        if (attachment.kind === "image") {
          // LINE must fetch image bytes over HTTPS. The opaque bearer is kept
          // only in memory/provider request and as a hash in SQLite; forget
          // revokes the grant and deletes the recipient-scoped bytes.
          const url = `${downloadOrigin}/line-media/${token}`;
          privateImages.push({ key: `attachment_${attachment.id}`, url, previewUrl: url, attachmentId: attachment.id });
        } else {
          // File bearer stays in the URL fragment so Caddy/access logs never
          // receive it. The landing page POSTs it after clearing history.
          capabilityLinks.push(`${downloadOrigin}/download#${token}`);
        }
      }
      const images = [...catalogImages, ...privateImages];
      const providerText = capabilityLinks.length
        ? `${cleanText ? `${cleanText}\n` : ""}ดาวน์โหลดไฟล์แนบ: ${capabilityLinks.join("\n")}`
        : cleanText;
      if (providerText.length > 2000) return json(res, 400, { ok: false, error: "ข้อความรวมลิงก์ไฟล์ต้องไม่เกิน 2000 ตัวอักษร" });
      const attachmentSummary = fileAttachments.length
        ? `[ส่งไฟล์แนบ ${fileAttachments.length} ไฟล์ · ลิงก์ดาวน์โหลดหมดอายุอัตโนมัติ]`
        : "";
      const persistedText = [cleanText, attachmentSummary].filter(Boolean).join("\n");
      // Claim, grants, and durable outbox are committed together below. A
      // process crash must never leave a 30-day file claim without an attempt
      // that startup recovery can inspect.
      const sendClaimId = attachments.length ? randomUUID() : "";

      // Static [IMAGE:key] entries still pass the reviewed catalog. Uploaded
      // images arrive only through private attachments. The combined operator
      // ceiling remains six images, independent from the AI image ceiling.
      const bubbles = providerText ? [{ text: providerText }] : [];
      if (bubbles.length + images.length + (sticker ? 1 : 0) === 0) {
        return json(res, 400, {
          ok: false,
          error: "ไม่เหลือข้อความหลังตัด marker และไม่มีรูปที่อยู่ในแคตตาล็อก",
          droppedImageKeys: dropped,
        });
      }
      // The intent contains only clean history rows—never capability URLs.
      // It is durable before the LINE boundary so an accepted provider result
      // can be recovered even if the subsequent history transaction fails.
      const agentMode = customerRow.ai_enabled === 1 ? "operator_ai_on" : "operator_ai_off";
      const operatorActiveUntil = now() + OPERATOR_ACTIVE_MS;
      const historyRows = [];
      let attachmentMessageId = "";
      const attachmentMessageIds = {};
      if (providerText) {
        attachmentMessageId = randomUUID();
        historyRows.push({
          id: attachmentMessageId, customerId, direction: "out", msgType: "text",
          content: persistedText, messageClass: "reactive", operator: username, agentMode,
        });
      }
      for (const image of images) {
        const row = {
          id: randomUUID(), customerId, direction: "out", msgType: "image",
          // Provider capability URLs are never durable. Private image bytes are
          // linked through message_attachments after LINE accepts the request.
          content: image.attachmentId ? "[image]" : `[image:${image.key}] ${image.url}`,
          messageClass: "reactive", operator: username, agentMode,
        };
        historyRows.push(row);
        if (image.attachmentId) attachmentMessageIds[image.attachmentId] = row.id;
      }
      for (const attachment of fileAttachments) attachmentMessageIds[attachment.id] = attachmentMessageId;
      if (sticker) {
        historyRows.push({
          id: randomUUID(), customerId, direction: "out", msgType: "sticker", content: "[sticker]",
          messageClass: "reactive", operator: username, agentMode,
          metadata: { packageId: sticker.packageId, stickerId: sticker.stickerId },
        });
      }

      // Map LINE's exact accepted request order back to the durable Console
      // rows. sendBubbles may deliberately move a final question after images
      // and stickers, so the batch status must follow provider order instead
      // of the original form-field order.
      const projectAcceptedHistoryRows = (providerMessages) => {
        const accepted = Array.isArray(providerMessages) ? providerMessages : [];
        const plannedText = historyRows.find((row) => row.msgType === "text") || null;
        const plannedSticker = historyRows.find((row) => row.msgType === "sticker") || null;
        const plannedImagesByUrl = new Map();
        const imageRows = historyRows.filter((item) => item.msgType === "image");
        for (const [index, image] of images.entries()) {
          const row = imageRows[index];
          if (!row) continue;
          const url = String(image.url || "");
          const queue = plannedImagesByUrl.get(url) || [];
          queue.push(row);
          plannedImagesByUrl.set(url, queue);
        }
        let textUsed = false;
        let stickerUsed = false;
        return accepted.map((message) => {
          if (message?.type === "text") {
            if (!textUsed && plannedText) { textUsed = true; return plannedText; }
            return null;
          }
          if (message?.type === "image") {
            const url = String(message.originalContentUrl || "");
            const planned = plannedImagesByUrl.get(url)?.shift();
            return planned || null;
          }
          if (message?.type === "sticker") {
            if (!stickerUsed && plannedSticker) { stickerUsed = true; return plannedSticker; }
            return null;
          }
          return null;
        }).filter(Boolean);
      };

      const acceptedAttachmentIdsForMessages = (providerMessages) => {
        const accepted = Array.isArray(providerMessages) ? providerMessages : [];
        const ids = new Set();
        if (accepted.some((message) => message?.type === "text")) {
          for (const attachment of fileAttachments) ids.add(attachment.id);
        }
        const privateIdByUrl = new Map(privateImages.map((image) => [image.url, image.attachmentId]));
        for (const message of accepted) {
          if (message?.type !== "image") continue;
          const attachmentId = privateIdByUrl.get(String(message.originalContentUrl || ""));
          if (attachmentId) ids.add(attachmentId);
        }
        return attachmentIds.filter((id) => ids.has(id));
      };

      const projectedAttachmentMessageIds = (ids) => Object.fromEntries(
        ids.map((id) => [id, attachmentMessageIds[id]]).filter(([, messageId]) => Boolean(messageId)),
      );

      // ---- จังหวะราคา: ข้อความของ operator ก็ปักหมุด price_quoted_at เหมือน AI ----
      //
      // การตัดสินใจนี้เคยถูกเลื่อนไว้หนึ่งรอบด้วยเหตุผลว่า "ข้อความ operator ไม่ผ่าน
      // complianceGuard" — operator พิมพ์ "ยอดโอน 12,900 ได้รับแล้วค่ะ" จะปักหมุดแล้ว
      // ล้าง owed ทิ้งถาวร เคาะรอบนี้ว่า **ปัก** ด้วยเหตุผลสามข้อ:
      //
      // 1. ไม่ปักแล้วเสียหายหนักกว่า และเป็นความเสียหายที่พี่ง้วงชี้ชื่อไว้: operator แจ้ง
      //    ราคาเอง -> ข้อความนั้นเลื่อนหลุดหน้าต่าง 12 แถว -> ลูกค้าถามราคาอีกครั้ง ->
      //    ระบบเห็นห้องที่ยังไม่เคยแจ้งราคาและยังไม่เคยคัดกรอง = ยิงคำถามคัดกรองใส่คนที่
      //    เพิ่งได้ราคาจากคนจริงไปเมื่อวาน (priceAlreadyStated อ่านตัวหนังสือ จึงกันได้แค่
      //    ตอนข้อความยังอยู่ในหน้าต่างเท่านั้น — ปัญหาเดียวกับที่หมุดถูกสร้างขึ้นมาแก้)
      // 2. หมุดตัวนี้ "เปิด" ประตูราคาอย่างเดียว ไม่เคยปิด — quotedBefore พาไปทาง quote
      //    ทุกเส้นในคำตัดสิน ผลของการปักผิดจึงตกฝั่ง "ลูกค้าได้ราคา" ซึ่งเป็นฝั่งที่ถูก
      //    ตามกติกาหัวไฟล์ priceDisclosure.mjs
      // 3. ตัวจับเทียบกับ "ราคาต่อหัวที่อนุมัติ" เท่านั้น (multipliableAmounts: ตัดแถว
      //    ส่วนลด/ค่าบริการเสริม และตัดเลขต่ำกว่า 4,000) เลข 12,900 ในตัวอย่างข้างบนคือ
      //    ราคาคลาสจริงที่ลูกค้าจ่ายไปแล้ว — เขารู้ราคาแน่นอน หมุดจึงพูดความจริง
      //
      // สิ่งเดียวที่ยอมแลกไปคือสาขา pivot: ห้องที่คัดกรองแล้ว + operator แจ้งราคา แล้วลูกค้า
      // pivot สอนสด->ออนไลน์ จะได้คำถาม "สอนสดหรือออนไลน์ดีคะ" หนึ่งครั้ง (owed หมดไป)
      // — ซึ่งเป็นพฤติกรรมเดียวกับห้องที่ AI แจ้งราคาเอง และ pivot มีโควตาของตัวเองครั้งเดียว
      const markOperatorPriceQuoted = (deliveredText) => {
        try {
          const value = String(deliveredText || "");
          if (!value) return;
          if (outboundCarriesClassPrice(value, approvedClassAmounts(db.approvedPrices() ?? []))) {
            db.markPriceQuoted(customerId);
          }
        } catch (error) {
          logger.warn?.(`console reply: ปักหมุดราคาจากข้อความ operator ไม่สำเร็จ (${error?.message || error}) — ไม่มีผลกับการส่ง`);
        }
      };

      const outboundAttemptId = randomUUID();
      try {
        db.prepareOperatorOutboundAttempt({
          id: outboundAttemptId,
          customerId,
          operator: username,
          attachmentIds,
          claimId: sendClaimId,
          claimExpiresAt: now() + AMBIGUOUS_SEND_CLAIM_MS,
          downloadTokens: pendingCapabilities,
          payload: { historyRows, attachmentMessageId, attachmentMessageIds, operatorActiveUntil },
        });
      } catch {
        return json(res, 409, { ok: false, error: "ไฟล์ไม่พร้อม ถูกจองไว้ หรือเตรียมบันทึกการส่งไม่สำเร็จ — ยังไม่ได้ส่ง LINE" });
      }

      // ส่งผ่านช่องทางเดียวกับ AI (LINE mock/live, fail-closed ตาม lineClient)
      // W3: token ของสาขาลูกค้าคนนี้ + ถอด raw user id จาก customer key ก่อนยิง
      let sendResult;
      try {
        sendResult = await lineForCustomer(customerRow)
          .sendBubbles({ to: rawUserId(customerId), replyToken: "", bubbles, images, stickers: sticker ? [sticker] : [], purpose: SEND_PURPOSE.operator });
      } catch {
        try { db.setOperatorOutboundAttemptStatus(outboundAttemptId, "ambiguous", 0); } catch { /* durable sending intent remains */ }
        try { db.addAudit({ operator: username, action: "reply_ambiguous", target: customerId, detail: `files=${attachments.length};transport=threw` }); } catch (error) { logger.error?.(`console reply: audit write failed (reply_ambiguous) (${error?.message || error}) — ข้อความอาจถึงลูกค้าแล้วแต่ไม่มีร่องรอย audit`); }
        return json(res, 502, { ok: false, ambiguous: true, error: "ผลการส่ง LINE ไม่แน่ชัด กรุณาตรวจห้องก่อนส่งซ้ำ" });
      }
      if (!sendResult.ok) {
        // v1.4.13 (audit จับ): โหมด push ส่งทีละบอลลูน — ล้มกลางลูป (เช่น 429 โควตาหมด)
        // แปลว่าลูกค้า "เห็นบางส่วนไปแล้ว" ต้องบันทึกเหมือน AI path (pipeline.mjs) ไม่งั้น
        // ประวัติแชทขาด + operator กดส่งซ้ำ = ลูกค้าได้ข้อความ/รูปสองชุด
        const delivered = Array.isArray(sendResult.delivered) ? sendResult.delivered : [];
        const status = Number(sendResult.status || 0);
        const ambiguousOutcome = !delivered.length && !sendResult.blocked && !(status >= 400 && status < 500);
        const why = sendResult.blocked
          ? "ช่องส่ง LINE ยังไม่พร้อม (LINE_LIVE_SEND=false และไม่มี LINE_MOCK_URL)"
          : delivered.length
            ? `LINE ส่งได้บางส่วน (${delivered.length} ข้อความถึงลูกค้าแล้ว, status ${sendResult.status ?? "?"}) — ตรวจในห้องแชทก่อนส่งซ้ำ`
            : ambiguousOutcome
              ? `ผลการส่ง LINE ไม่แน่ชัด (status ${sendResult.status ?? "?"}) — ตรวจในห้องแชทก่อนส่งซ้ำ`
              : `LINE ส่งไม่สำเร็จ (${sendResult.status ?? "?"})`;
        // A hard pre-delivery rejection leaves no recipient-visible link.
        // Keep grants on ambiguous/partial outcomes so any accepted message is
        // still usable until its documented expiry.
        const textDelivered = delivered.some((message) => message?.type === "text");
        const deliveredAttachmentIds = acceptedAttachmentIdsForMessages(delivered);
        const deliveredAttachmentSet = new Set(deliveredAttachmentIds);
        if (delivered.length) {
          db.revokeAttachmentDownloadTokens(
            pendingCapabilities.filter((item) => !deliveredAttachmentSet.has(item.attachmentId)).map((item) => item.tokenHash),
          );
        } else if (sendResult.blocked || (status >= 400 && status < 500)) {
          db.revokeAttachmentDownloadTokens(pendingCapabilities.map((item) => item.tokenHash));
          db.releaseMessageAttachmentsSendClaim(sendClaimId);
        }

        let historyPending = false;
        if (delivered.length) {
          // Persist only the exact provider-confirmed prefix. The planned
          // payload may contain later bubbles that LINE never accepted and
          // therefore must never be replayed into Console history.
          const deliveredRows = projectAcceptedHistoryRows(delivered);
          try {
            if (deliveredRows.length !== delivered.length) throw new Error("partial provider projection incomplete");
            if (!db.setPartialOperatorOutboundAttemptProjection(outboundAttemptId, {
              providerStatus: status,
              attachmentIds: deliveredAttachmentIds,
              payload: {
                historyRows: deliveredRows,
                attachmentMessageId: textDelivered ? String(attachmentMessageId || deliveredRows.find((row) => row.msgType === "text")?.id || "") : "",
                attachmentMessageIds: projectedAttachmentMessageIds(deliveredAttachmentIds),
                operatorActiveUntil,
              },
            })) throw new Error("partial provider projection persistence failed");
            db.finalizeAcceptedOperatorOutboundAttempt(outboundAttemptId);
            db.releaseMessageAttachmentsSendClaim(sendClaimId);
          } catch (error) {
            historyPending = true;
            // Keep AI out of the room even if SQLite history recovery has to
            // wait for the next boot. Never retry the provider call here.
            try { db.setOperatorActiveUntil(customerId, operatorActiveUntil); } catch { /* conservative attempt remains */ }
            logger.error?.(`console reply: partial LINE history recovery pending (${error?.message || error})`);
          }
        } else {
          const attemptStatus = (sendResult.blocked || (status >= 400 && status < 500)) ? "rejected" : "ambiguous";
          try { db.setOperatorOutboundAttemptStatus(outboundAttemptId, attemptStatus, status); } catch { /* sending intent remains conservative */ }
        }
        // ส่งได้บางส่วน: ปักหมุดเฉพาะเมื่อ "บอลลูนข้อความ" ถึงมือลูกค้าจริง
        // (ส่งได้แต่รูปแล้วล้ม = เขาไม่เคยเห็นตัวเลข)
        if (textDelivered) markOperatorPriceQuoted(persistedText);
        try {
          db.addAudit({ operator: username, action: historyPending ? "reply_partial_history_pending" : "reply_partial", target: customerId, detail: `delivered=${delivered.length};text=${textDelivered ? "yes" : "no"};files=${attachments.length};status=${status || "unknown"}` });
        } catch (error) { logger.error?.(`console reply: audit write failed (reply_partial) (${error?.message || error}) — ส่งได้บางส่วนแล้วแต่ไม่มีร่องรอย audit customer=${customerId}`); }
        return json(res, 502, { ok: false, error: why, partiallyDelivered: delivered.length, historyPending, ambiguous: ambiguousOutcome });
      }

      // Provider accepted the send. Mark that outcome durably first, then
      // finalize history + attachment links + human ownership in one DB
      // transaction. A transient history failure returns success-with-warning
      // and is recovered at boot; it must never become a retryable 500.
      let historyPending = false;
      try {
        const deliveredRows = projectAcceptedHistoryRows(sendResult.acceptedRequestMessages);
        if (deliveredRows.length !== historyRows.length) throw new Error("accepted provider projection incomplete");
        if (!db.setAcceptedOperatorOutboundAttemptProjection(outboundAttemptId, {
          providerStatus: Number(sendResult.status || 200),
          attachmentIds,
          payload: { historyRows: deliveredRows, attachmentMessageId, attachmentMessageIds, operatorActiveUntil },
        })) {
          throw new Error("accepted projection persistence failed");
        }
        db.finalizeAcceptedOperatorOutboundAttempt(outboundAttemptId);
      } catch (error) {
        historyPending = true;
        logger.error?.(`console reply: LINE accepted but history recovery is pending (${error?.message || error})`);
      }
      // provider รับครบแล้ว = ข้อความถึงมือลูกค้าจริง ปักหมุดนอก try ข้างบนเพื่อให้
      // history ที่ยังกู้ไม่เสร็จไม่ไปกลืนหมุดทิ้ง (หมุดเป็นเขียนครั้งแรกชนะ เรียกซ้ำได้)
      markOperatorPriceQuoted(persistedText);

      // Correction Loop: operator แก้/แทนร่าง AI -> เก็บเป็น candidate
      //
      // เทียบด้วย isHumanEdit ไม่ใช่ !== ดิบ ๆ: marker [IMAGE:key] ถูกถอดออกไปทำเป็นรูปก่อนส่ง
      // ข้อความที่ operator กดส่งจึงไม่มี marker ติดไป การ "กดส่งร่างเดิมทั้งดุ้น" จึงเคยถูกอ่าน
      // ว่าเป็นคำแก้ทุกครั้ง (ของจริง 3 ก.ย. 2026: 149 จาก 170 ใบในกล่องตรวจ) — อ่านกลับข้าง
      // จากความจริงที่ว่าคนเห็นด้วยกับบอท
      let correctionId = null;
      const draftId = String(body.draftId || "");
      const aiDraft = String(body.aiDraft || "").trim();
      try {
        if (draftId) {
          const row = db.getCorrection(draftId);
          if (row && row.customer_id === customerId && db.setCorrectionFinal(draftId, operatorText)) {
            // ส่งร่างเดิมโดยไม่แก้เนื้อความ = ไม่มีอะไรให้สอน ปิดใบทิ้งตรงนี้เลย
            // ไม่งั้นมันไปนั่งรอเจ้าของตัดสินในกล่องตรวจทั้งที่ไม่มีความต่างให้ตัดสิน
            if (isHumanEdit(row.ai_draft, operatorText)) correctionId = draftId;
            else db.updateCorrection(draftId, {
              status: "rejected", reason: "ส่งร่างเดิม ไม่ได้แก้เนื้อความ", decidedBy: "system:no-edit",
            });
          }
        } else if (isHumanEdit(aiDraft, operatorText)) {
          correctionId = db.addCorrection({ customerId, aiDraft, humanFinal: operatorText });
        }
      } catch (error) { logger.warn?.(`console reply: correction capture deferred (${error?.message || error})`); }

      // audit 2026-08-25: เดิมกลืนเงียบ = "ส่งแล้วแต่ไม่มี audit" ซึ่งมองไม่เห็นเลย
      // ผล provider ยังเป็นความจริงหลัก แต่ความล้มเหลวของ audit ต้องดังพอให้ตามได้
      try { db.addAudit({ operator: username, action: historyPending ? "reply_history_pending" : "reply", target: customerId, detail: `text=${operatorText ? "yes" : "no"};files=${attachments.length};images=${images.length};sticker=${sticker ? "yes" : "no"}` }); } catch (error) { logger.error?.(`console reply: audit write failed (${error?.message || error}) — ข้อความส่งไปแล้วแต่ไม่มีร่องรอย audit customer=${customerId}`); }
      return json(res, historyPending ? 202 : 200, {
        ok: true, sent: true, mode: sendResult.mode, correctionId,
        historyPending,
        imagesSent: images.length,
        droppedImageKeys: dropped, // key แปลกหน้าที่ถูกทิ้ง — ให้ UI toast บอก operator
        overflowImageKeys: overflow, // v1.4.13: เกินเพดาน 6 รูป/ครั้ง — ต้องเตือน ไม่ทิ้งเงียบ
      });
    }

    /* ---- ROAS รวมทั้งบริษัท (คำสั่งพี่ง้วง 1 ก.ย. 2026) ----
     * ยอดขายมาจากออเดอร์ที่ทีมกด · ค่า AI คิดเองอัตโนมัติ · ค่าแอดกับค่าแพ็กเกจ LINE
     * กรอก/ยิงเข้ามา เพราะอยู่นอกระบบนี้ · ค่าจิปาถะรวม chat package แล้วคิดเป็น % ของยอดขาย
     */
    /* ---- กุญแจให้ Make ยิงค่าแอดเข้ามา ----
     * สร้างใหม่ในเซิร์ฟเวอร์แล้วคืนค่าครั้งเดียวให้เบราว์เซอร์ของแอดมินที่ล็อกอินอยู่
     * ค่าเดิมดูย้อนหลังไม่ได้ (คืนแค่ว่ามีหรือยัง) — อยากได้ใหม่ต้องกดสร้างใหม่ ซึ่งจะทำให้
     * ของเก่าใช้ไม่ได้ทันที กันเคสกุญแจหลุดแล้วไม่รู้ว่าใครถืออยู่บ้าง
     */
    if (route[0] === "roas" && route[1] === "ingest-key" && route.length === 2) {
      // คำสั่งพี่ง้วง 1 ก.ย. 2026: "การตั้ง webhook ใดๆ ชมพู่ พนักงานไม่ควรเห็น"
      // กันที่ handler ไม่ใช่ที่ allowlist เส้นทาง เพราะ admin ผ่าน allowlist ทุกเส้น
      // (operatorRoles.mjs) วันที่พี่ง้วงเลื่อนใครเป็น Admin กุญแจนี้จะหลุดทันที
      // วางบนสุดก่อนแตะ db เพื่อไม่ให้แถว audit ads_ingest_key_* ถูกเขียนจากคนไม่มีสิทธิ์
      if (!hasOperatorCapability(session.operator, "integrations.manage")) {
        return json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
      }
      if (req.method === "GET") {
        // ?reveal=1 = ขอดูค่าจริง (แอดมินที่ล็อกอินแล้วเท่านั้น)
        // ชั่งน้ำหนักแล้วว่าให้ดูซ้ำได้คุ้มกว่าโชว์ครั้งเดียว: กุญแจนี้ให้สิทธิ์แค่ "เขียนตัวเลข
        // ค่าแอด" ไม่แตะข้อมูลลูกค้า และคนที่เห็นได้ต้องผ่านล็อกอินคอนโซลอยู่แล้ว
        // ส่วนที่โชว์ครั้งเดียวทำให้ต้องสร้างใหม่ทุกครั้งที่แก้ scenario ซึ่งพาไปสู่การจดกุญแจ
        // ไว้ที่อื่น ซึ่งอันตรายกว่า
        const url = new URL(req.url, "http://localhost");
        const stored = db.getSetting(ADS_KEY_SETTING) || "";
        if (url.searchParams.get("reveal") === "1" && stored) {
          db.addAudit({
            operator: username, action: "ads_ingest_key_reveal", target: "ads_spend",
            detail: "เปิดดูกุญแจจากคอนโซล",
          });
          return json(res, 200, { ok: true, configured: true, key: stored });
        }
        return json(res, 200, { ok: true, configured: Boolean(stored) });
      }
      if (req.method === "POST") {
        if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        const key = randomUUID().replace(/-/gu, "") + randomUUID().replace(/-/gu, "");
        db.setSetting(ADS_KEY_SETTING, key);
        db.addAudit({
          operator: username, action: "ads_ingest_key_rotate", target: "ads_spend",
          detail: "สร้างกุญแจใหม่ — ของเดิมใช้ไม่ได้ทันที",
        });
        // คืนค่าครั้งเดียวตรงนี้ที่เดียว ไม่เก็บซ้ำที่อื่นและไม่มี endpoint ให้ดูย้อนหลัง
        return json(res, 200, { ok: true, key });
      }
      return json(res, 405, { ok: false, error: "method ไม่รองรับ" });
    }

    if (route[0] === "roas" && route.length === 1) {
      // เงินทั้งก้อน (ค่าแอด กำไร ต้นทุน ยอดขายแยกช่องทาง) — เจ้าของคนเดียวตามคำสั่ง 1 ก.ย. 2026
      // PUT ก็ต้องกันด้วย เพราะแก้ตัวเลขต้นทุน = แก้ ROAS/กำไรที่เจ้าของเห็นทั้งเดือน
      // วางก่อน csrfOk ตั้งใจ: คนไม่มีสิทธิ์ต้องได้ 403 เดียวกันเสมอ ไม่ใช่ได้ "CSRF ไม่ถูกต้อง"
      // ซึ่งบอกใบ้ว่าถ้าแก้ CSRF ได้ก็จะผ่าน
      if (!hasOperatorCapability(session.operator, "finance.view")) {
        return json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
      }
      if (req.method === "PUT") {
        if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        const body = await readJson(req);
        const saved = {};
        for (const [field, key] of Object.entries(COST_KEYS)) {
          if (body[field] === undefined) continue;
          const raw = String(body[field]).trim();
          if (raw !== "" && !Number.isFinite(Number(raw))) {
            return json(res, 400, { ok: false, error: `ค่า ${field} ต้องเป็นตัวเลข` });
          }
          db.setSetting(key, raw);
          saved[field] = raw;
          if (field === "adsThb") db.setSetting(COST_KEYS.adsUpdatedAt, String(now()));
        }
        db.addAudit({ operator: username, action: "roas_costs_edit", target: "roas", detail: Object.keys(saved).join(",") });
        return json(res, 200, { ok: true, saved });
      }
      if (req.method !== "GET") return json(res, 405, { ok: false, error: "method ไม่รองรับ" });

      const url = new URL(req.url, "http://localhost");
      const nowMs = now();
      const setting = (key) => db.getSetting(key) ?? "";

      // ช่วงเวลา: ระบุวันเดียว (date=YYYY-MM-DD) หรือย้อนหลัง N วัน (days=7/30)
      // วันเดียวใช้ขอบวันเวลาไทย ไม่ใช่ 24 ชม.ย้อนหลัง — เจ้าของถาม "ยอดวันที่ 1" ไม่ใช่ "24 ชม.ที่ผ่านมา"
      const dayParam = String(url.searchParams.get("date") || "").trim();
      const singleDay = /^\d{4}-\d{2}-\d{2}$/u.test(dayParam) ? dayParam : null;
      let sinceMs;
      let untilMs;
      let days;
      if (singleDay) {
        sinceMs = Date.parse(`${singleDay}T00:00:00+07:00`);
        untilMs = sinceMs + 86_400_000;
        days = 1;
      } else {
        days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
        sinceMs = nowMs - days * 86_400_000;
        untilMs = null;
      }
      if (!Number.isFinite(sinceMs)) return json(res, 400, { ok: false, error: "วันที่ไม่ถูกต้อง" });

      const rows = db.revenueByChannelSince(sinceMs, untilMs);
      const revenueByChannel = Object.fromEntries(rows.map((r) => [r.channel_id, Number(r.revenue) || 0]));
      const revenueThb = rows.reduce((sum, r) => sum + (Number(r.revenue) || 0), 0);

      const fx = fxNow();
      const ai = costReport(db.llmUsageSummary(sinceMs, null, untilMs), fx.thbPerUsd);

      // อ่านโควตา LINE พังห้ามล้มทั้งรายงาน — ไม่มีตัวเลขก็ยังคืนส่วนที่เหลือได้
      const quota = await Promise.resolve().then(() => line.getQuota()).catch(() => null);
      const monthStart = bangkokMonthStartMs(nowMs);
      const monthDaysElapsed = Math.max(1, (nowMs - monthStart) / 86_400_000);
      const split = splitLineUsage({
        monthTotalUsage: quota?.totalUsage ?? null,
        monthAiMessages: db.lineOutboundCount(monthStart),
      });
      const lineCost = lineCostForWindow({
        split,
        ratePerMsg: setting(COST_KEYS.lineRateThb) || DEFAULT_LINE_RATE_THB,
        windowStartMs: sinceMs,
        windowEndMs: untilMs ?? nowMs,
        monthStartMs: monthStart,
        nowMs,
      });

      // ค่าแอด: ใช้ยอดรายวันที่ Make ยิงเข้ามาก่อนเสมอ (บวกเฉพาะวันในช่วงที่เลือก)
      // ยังไม่มีข้อมูลรายวันเลย = ตกไปใช้ตัวเลขก้อนเดียวที่กรอกมือไว้ เพื่อไม่ให้หน้าจอว่างเปล่า
      const dayKey = (ms) => new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10);
      const fromDay = dayKey(sinceMs);
      const toDay = dayKey((untilMs ?? nowMs) - 1);
      const dailyAds = db.adsSpendBetween(fromDay, toDay);
      // 2 ก.ย. 2026 (พี่ง้วงเจอเอง: เลือก "วันนี้" แล้วเห็น ฿3,344 ทั้งที่ Ads Manager ฿1,319):
      // เดิมมีข้อมูลวันเดียวก็เอามาเป็นค่าแอดของทั้งช่วง และไม่มีเลยก็ตกไปใช้ค่ากรอกมือ
      // ผิดสองทางพร้อมกัน — ช่วง 30 วันที่มีข้อมูลจริง 2 วันจะได้ต้นทุนต่ำเกินจริง
      // ทำให้ ROAS สูงเกินจริงหลายเท่า ซึ่งเป็นทิศที่อันตรายที่สุดเพราะเอาไปเพิ่มงบแอด
      //
      // กติกา: สรุปตัวเลขได้ต่อเมื่อมีข้อมูลครบทุกวันในช่วงเท่านั้น
      const adsFullyCovered = dailyAds.days >= days;
      // ท่ออัตโนมัติเดินแล้ว = ค่าที่กรอกมือไว้ตอนยังไม่มีระบบดึงถือว่าตกรุ่น ห้ามใช้อีก
      const adsPipelineLive = db.hasAnyAdsSpend?.() === true;
      const adsFromDaily = adsFullyCovered;
      // ยังไม่มีข้อมูลรายวัน = เฉลี่ยจากตัวเลขที่กรอกมือตามจำนวนวันของช่วงที่เลือก
      // ห้ามเอายอดก้อนเดียวไปหารทุกช่วง (ดู manualAdsForWindow ว่าทำไม)
      const manualAds = manualAdsForWindow({
        adsThb: setting(COST_KEYS.adsThb),
        adsWindowDays: setting(COST_KEYS.adsWindowDays) || 30,
        windowDays: days,
      });

      const summary = computeRoas({
        revenueThb, revenueByChannel,
        adsThb: adsFullyCovered
          ? dailyAds.totalThb
          : (adsPipelineLive ? null : manualAds.thb),
        aiThb: ai.thb,
        lineThb: lineCost.thb,
        miscThb: setting(COST_KEYS.miscThb),
      });
      return json(res, 200, {
        ok: true,
        window: { days, sinceMs, untilMs, date: singleDay, monthStartMs: monthStart },
        orders: Object.fromEntries(rows.map((r) => [r.channel_id, Number(r.orders) || 0])),
        line: {
          // ยอดของ LINE เป็นทั้งเดือนเสมอ (API ไม่มีรายวัน) — ฝั่งที่เรานับเองตรงช่วงที่เลือกได้
          coverage: lineCost.coverage,
          reason: lineCost.reason,
          monthTotalMsgs: split.totalMsgs,
          monthAiMsgs: split.aiMsgs,
          monthBroadcastMsgs: split.broadcastMsgs,
          aiExceedsTotal: split.aiExceedsTotal,
          windowAiMsgs: db.lineOutboundCount(sinceMs, untilMs),
          windowMsgsUsed: lineCost.windowMsgs,
          estimated: lineCost.estimated,
          ratePerMsg: lineCost.ratePerMsg ?? Number(setting(COST_KEYS.lineRateThb) || DEFAULT_LINE_RATE_THB),
        },
        ads: {
          // บอกที่มาให้ชัด เจ้าของจะได้รู้ว่าเลขนี้อัตโนมัติหรือกรอกมือ และครบทุกวันไหม
          source: adsFullyCovered ? "daily" : (adsPipelineLive ? "incomplete" : (setting(COST_KEYS.adsThb) ? "manual" : "none")),
          // เหตุผลต้องอ่านแล้วรู้ว่าต้องทำอะไรต่อ ไม่ใช่แค่บอกว่าไม่มีข้อมูล
          reason: adsFullyCovered
            ? ""
            : (adsPipelineLive
              ? (dailyAds.days > 0
                ? `มีค่าแอดจริง ${dailyAds.days} จาก ${days} วันในช่วงนี้ — ยังสรุปทั้งช่วงไม่ได้`
                : "ยังไม่มีค่าแอดของช่วงนี้ — Make ยิงยอดของเมื่อวานทุกวันตอน 05:00")
              : ""),
          daysWithData: dailyAds.days,
          estimated: adsFromDaily ? false : manualAds.estimated,
          manualBasisDays: manualAds.basisDays ?? null,
          daysInWindow: days,
          fromDay, toDay,
          recent: db.listAdsSpend(14),
          ingestReady: Boolean(db.getSetting("ads_ingest_key")),
          // บังคับ https เสมอ — กุญแจเดินทางไปกับ header ถ้าเป็น http จะวิ่งเปลือย
          // (คอนโซลเปิดผ่าน http บนโดเมนภายใน การใช้ location.origin ตรง ๆ จึงไม่ปลอดภัย)
          ingestUrl: `https://${String(req.headers.host || "").split(",")[0].trim()}/webhooks/ads-spend`,
        },
        adsUpdatedAt: Number(setting(COST_KEYS.adsUpdatedAt)) || null,
        adsWindowDays: setting(COST_KEYS.adsWindowDays) || "",
        settings: Object.fromEntries(Object.entries(COST_KEYS).map(([field, key]) => [field, setting(key)])),
        ...summary,
      });
    }

    if (req.method === "POST" && route[0] === "customers" && route[2] === "ai" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") {
        return json(res, 400, { ok: false, error: "ต้องส่ง enabled เป็น boolean" });
      }
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });

      // 2026-09-28: เส้นเดียวกับ "เปิด/ปิด AI" ทาง Telegram และ "แล้วคุยต่อ" ของ YOLO (aiSwitch.mjs)
      // (รวมงานตรวจย้อนหลัง F5/F7 ไว้ในเส้นนั้นแล้ว: ถอนป้ายระบบ + ตอบข้อความค้างหลังไฟล์แนบ)
      // รีวิวปรปักษ์ 5 ต.ค. #5/#21: เส้นนั้นประทับเวลาคนเปิด AI ทุกห้อง และเปิดทับห้องสีเหลือง = ตอบข้อความที่ค้าง
      // ผ่าน qualifyAnswerPending (เคารพหน้าต่าง 24 ชม. Facebook) — จึงต้องส่ง pipeline/notifier มาด้วยเสมอ
      const customer = setCustomerAiSwitch({ db, customerId, enabled: body.enabled, operator: username, pipeline, notifier, logger });
      return json(res, 200, { ok: true, customer });
    }

    // 2026-08-24: รายชื่อห้องระบบเก่าที่ชื่อ (normalize แล้ว) ตรงกับลูกค้าหรือคำค้น —
    // ให้แอดมินใช้เทียบก่อนโยงมือ; อ่านอย่างเดียว ไม่แตะสถานะใด ๆ
    if (req.method === "GET" && route[0] === "customers" && route[2] === "legacy-candidates" && route.length === 3) {
      const customerId = decodeURIComponent(route[1]);
      const customer = db.getCustomer(customerId);
      if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const url = new URL(req.url, "http://localhost");
      const q = String(url.searchParams.get("q") || customer.display_name || "").trim();
      const key = normalizeDisplayName(q);
      const rows = key
        ? db.findLegacyByDisplayName(q).filter((row) => normalizeDisplayName(row.display_name) === key).slice(0, 10)
        : [];
      return json(res, 200, {
        ok: true,
        q,
        candidates: rows.map((row) => ({
          id: row.line_user_id,
          displayName: row.display_name || "",
          messages: db.countMessagesFor(row.line_user_id),
          linkedBy: db.customerLinkedToLegacy(row.line_user_id)?.line_user_id || null,
        })),
      });
    }

    // Name matching is candidate discovery only. The authenticated operator
    // must explicitly confirm before any legacy tags/status cross customers.
    if (req.method === "POST" && route[0] === "customers" && route[2] === "legacy-link" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const body = await readJson(req);
      if (body.action !== "confirm" && body.action !== "reject" && body.action !== "link") {
        return json(res, 400, { ok: false, error: "action ต้องเป็น confirm, reject หรือ link" });
      }
      // 2026-08-24: action=link คือเส้นโยงมือ (เคส ambiguous/none/rejected ที่ระบบไม่เสนอเอง)
      // legacyId มาจากรายชื่อที่ server เสนอ แต่ต้องตรวจซ้ำใน manualLegacyLink เสมอ
      const result = body.action === "confirm"
        ? confirmLegacyLink({ db, customerId, operator: username })
        : body.action === "link"
          ? manualLegacyLink({ db, customerId, legacyId: String(body.legacyId || ""), operator: username })
          : rejectLegacyLink({ db, customerId, operator: username });
      if (result.state === "already_linked") {
        return json(res, 409, { ok: false, error: "ห้องนี้โยงแล้ว — แก้การโยงต้องให้ทีมระบบทำมือ" });
      }
      if (result.state === "not_reference") {
        return json(res, 409, { ok: false, error: "ห้องปลายทางไม่ใช่ห้องอ้างอิงระบบเก่า" });
      }
      if (result.state === "legacy_taken") {
        return json(res, 409, { ok: false, error: "ห้องระบบเก่านี้ถูกโยงกับลูกค้าคนอื่นแล้ว" });
      }
      if (result.state === "not_candidate") {
        return json(res, 409, { ok: false, error: "ห้องนี้ไม่มี candidate ที่รอยืนยัน" });
      }
      if (result.state === "invalid_candidate") {
        return json(res, 409, { ok: false, error: "candidate ไม่ผ่านการตรวจซ้ำ — ยังไม่ได้คัดลอกข้อมูล" });
      }
      // ป้ายประวัติการซื้อของห้องเก่าเพิ่งถูกคัดลอกมา = คำนวณ ซื้อครั้งที่/ซื้อล่าสุด ของห้องนี้ใหม่
      if (result.state === "linked") {
        refreshRfmTags(db, customerId, { logger, framework: activeTagFramework(db, tagFramework) });
      }
      db.addAudit({
        operator: username,
        action: body.action === "confirm" ? "legacy_link_confirm" : body.action === "link" ? "legacy_link_manual" : "legacy_link_reject",
        target: customerId,
        detail: body.action === "confirm"
          ? `ยืนยันแล้ว · คัดลอกป้าย ${result.copied?.length || 0}`
          : body.action === "link"
            ? `โยงมือแล้ว · คัดลอกป้าย ${result.copied?.length || 0}`
            : "ปฏิเสธ candidate",
      });
      // 2026-09-02: ห้องที่ค้างมาจากนโยบายเดิม (AI ถูกปิดไว้ ข้อความลูกค้าถูกกลืน) —
      // ยืนยันตัวตนแล้วต้องได้คำตอบ ไม่ใช่แค่เปิดสวิตช์คืนแล้วรอให้ลูกค้าพิมพ์ใหม่
      const pending = answerPendingInbound({ db, pipeline, notifier, customerId, logger });
      return json(res, 200, {
        ok: true,
        state: result.state,
        customer: db.getCustomer(customerId) || result.customer,
        pendingReply: pending.redispatched === true ? "redispatched" : (pending.flagged === true ? "needs_human" : ""),
        copied: result.copied || [],
        tags: safeListTags(db, customerId),
      });
    }

    // ---- G2a (F2): แก้ชื่อจริงลูกค้า (ค่าว่าง = ล้างชื่อ) ----
    // v1.1 (item 7): แอดมินเพิ่ม/ลบป้ายลูกค้า — ป้ายที่คนติดเป็น source 'human' ระบบไม่แตะ
    if (req.method === "POST" && route[0] === "customers" && route[2] === "tags" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const body = await readJson(req);
      const add = typeof body.add === "string" ? normalizeTag(body.add) : "";
      const remove = typeof body.remove === "string" ? body.remove.trim() : "";
      if (!add && !remove) return json(res, 400, { ok: false, error: "ต้องส่ง add หรือ remove อย่างน้อย 1 อย่าง" });
      // 28 ก.ย. 2026: ตรรกะป้าย (รวมป้ายเงียบ customer/null ที่ปิด AI ทันที) ย้ายไป customerTagActions.mjs
      // ให้ปุ่ม "สแปม" (consoleTriageApi.mjs) เดินเส้นเดียวกันทุกบรรทัด
      // กรอบป้ายชุดเดียว (เปิดอยู่): มิติที่มีรายการรับเฉพาะค่าในรายการ · มิติของระบบติดเองไม่ได้
      // ป้ายประวัติการซื้อเปลี่ยน = คำนวณ ซื้อครั้งที่/ซื้อล่าสุด ใหม่ทันที
      const framework = activeTagFramework(db, tagFramework);
      if (add) {
        const added = addCustomerTag({ db, customerId, tag: add, operator: session.username, framework });
        if (!added.ok) return json(res, added.status, { ok: false, error: added.error });
        // 28 ก.ย. 2026: ป้าย customer ในห้อง Facebook = ซื้อแล้ว → โหมด auto ส่งลิงก์ต่อแชท LINE ให้เองหนึ่งครั้ง
        if (added.tag.toLowerCase() === "customer") identityLinks.maybeAutoInvite({ customerId, trigger: "customer_tag", operator: session.username });
      }
      if (remove) {
        const removed = removeCustomerTag({ db, customerId, tag: remove, operator: session.username, framework });
        if (!removed.ok) return json(res, removed.status, { ok: false, error: removed.error });
      }
      return json(res, 200, { ok: true, tags: safeListTags(db, customerId) });
    }

    if (req.method === "POST" && route[0] === "customers" && route[2] === "name" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      const existing = db.getCustomer(customerId);
      if (!existing) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const body = await readJson(req);
      if (typeof body.knownName !== "string" || body.knownName.length > 60) {
        return json(res, 400, { ok: false, error: "knownName ต้องเป็นข้อความไม่เกิน 60 ตัวอักษร" });
      }
      const customer = db.setKnownName(customerId, body.knownName.trim());
      db.addAudit({
        operator: username, action: "name_edit", target: customerId,
        detail: `"${existing.known_name}" -> "${customer.known_name}"`,
      });
      return json(res, 200, { ok: true, customer });
    }

    if (req.method === "POST" && route[0] === "customers" && route[2] === "owner" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const body = await readJson(req);
      const owner = String(body.owner || "").trim();
      if (owner && !db.listOperators().some((row) => row.username === owner && Number(row.disabled) !== 1)) {
        return json(res, 400, { ok: false, error: "ไม่พบบัญชีผู้รับผิดชอบที่เปิดใช้งาน" });
      }
      const customer = db.setHumanOwner(customerId, owner);
      db.addAudit({ operator: username, action: "customer_owner_set", target: customerId, detail: owner || "unassigned" });
      return json(res, 200, { ok: true, customer });
    }

    if (req.method === "POST" && route[0] === "customers" && route[2] === "unread" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.markConversationUnread(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      db.addAudit({ operator: username, action: "conversation_mark_unread", target: customerId });
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && route[0] === "customers" && route[2] === "resolve" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      const body = await readJson(req);
      if (typeof body.resolved !== "boolean") return json(res, 400, { ok: false, error: "resolved ต้องเป็น boolean" });
      const customer = db.setConversationResolved(customerId, body.resolved);
      if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      db.addAudit({ operator: username, action: body.resolved ? "conversation_resolved" : "conversation_reopened", target: customerId });
      return json(res, 200, { ok: true, customer });
    }

    // A-18: เงินเข้าเป็นคำยืนยันของคนเท่านั้น. ใช้ lifecycle/event log เดิม ไม่สร้าง
    // payment engine หรือส่งข้อความถึงลูกค้า. การกดซ้ำหลังยืนยันแล้วเป็น no-op เพื่อให้
    // สองแท็บ/การ retry ของเบราว์เซอร์ไม่สร้างหลักฐานการยืนยันซ้ำ.
    if (req.method === "POST" && route[0] === "customers" && route[2] === "confirm-payment" && route.length === 3) {
      if (!hasOperatorCapability(session.operator, "payments.confirm")) {
        return json(res, 403, { ok: false, error: "เฉพาะ Super Admin หรือ Admin เท่านั้นที่ยืนยันยอดได้" });
      }
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      const body = await readJson(req);
      if (body.confirm !== true) return json(res, 400, { ok: false, error: "ต้องยืนยันการตรวจยอดก่อนบันทึก" });
      const lifecycle = db.confirmCustomerPayment({ customerId, confirmedBy: username });
      if (!lifecycle.found) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      if (!lifecycle.allowed) {
        return json(res, 409, { ok: false, error: "ยืนยันยอดได้เฉพาะดีลที่อยู่สถานะรอตรวจยอด" });
      }
      // 28 ก.ย. 2026: ทีมยืนยันยอดในห้อง Facebook → โหมด auto ส่งลิงก์ต่อแชท LINE ให้เองหนึ่งครั้ง
      if (lifecycle.changed) identityLinks.maybeAutoInvite({ customerId, trigger: "payment_confirmed", operator: username });
      return json(res, 200, {
        ok: true, changed: lifecycle.changed,
        lifecycle: { stage: lifecycle.stage, dealStatus: lifecycle.dealStatus },
        lifecycleEvents: db.listLifecycleEvents(customerId, 20),
      });
    }

    // ---- G2a (F6): ล้างประวัติลูกค้า (test phase) — ลบ messages/score/followups/corrections ----
    if (req.method === "POST" && route[0] === "customers" && route[2] === "reset" && route.length === 3) {
      if (!hasOperatorCapability(session.operator, "customers.reset")) return json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่ล้างข้อมูลลูกค้าได้" });
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      // Queue DB pointers + revoke grants first, then erase bytes idempotently.
      // History is deleted only after the durable queue is fully drained.
      try {
        const queuedKeys = db.queueCustomerMediaDeletion(customerId, "customer_reset");
        const cleanup = drainMessageMediaDeletionQueue({ db, privateMedia, customerId, limit: 500, logger });
        if (cleanup.failed || cleanup.pending || (queuedKeys.length && cleanup.skipped)) {
          return json(res, 503, { ok: false, error: "ล้างไฟล์ส่วนตัวไม่สำเร็จ ยังไม่ได้ลบประวัติ" });
        }
        const customer = db.resetCustomer(customerId);
        db.addAudit({
          operator: username, action: "reset_customer", target: customerId,
          detail: "test history reset: identity row and display name retained; no restore tombstone",
        });
        return json(res, 200, { ok: true, customer });
      } catch {
        return json(res, 503, { ok: false, error: "ล้างไฟล์ส่วนตัวไม่สำเร็จ ยังไม่ได้ลบประวัติ" });
      }
    }

    // Owner-only PDPA erasure. Unlike the test reset above, this removes the
    // raw identity and leaves a hash-only tombstone so restore cannot silently
    // resurrect a customer who asked to be forgotten.
    if (req.method === "POST" && route[0] === "customers" && route[2] === "forget" && route.length === 3) {
      if (!hasOperatorCapability(session.operator, "customers.forget")) return json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่ลืมลูกค้าได้" });
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const body = await readJson(req);
      if (body.confirm !== "ลืมลูกค้า") return json(res, 400, { ok: false, error: "พิมพ์คำยืนยันไม่ตรง จึงยังไม่ได้ลบข้อมูล" });
      // Determine every legacy-linked identity now. The final JEV erase waits
      // until all other reversible preflights and private-media cleanup pass,
      // so a rejected forget does not silently remove a report subset.
      const linkedIds = new Set([customerId]);
      const source = db.getCustomer(customerId);
      const linkedLegacy = String(source?.legacy_link || "").match(/^linked:(.+)$/u)?.[1];
      if (linkedLegacy) linkedIds.add(linkedLegacy);
      const linkedCurrent = db.customerLinkedToLegacy?.(customerId)?.line_user_id;
      if (linkedCurrent) linkedIds.add(linkedCurrent);
      const legacyPublicMedia = db.countLegacyPublicChatMedia(customerId);
      if (legacyPublicMedia > 0) {
        return json(res, 409, {
          ok: false,
          code: "public_chat_media_manual_review_required",
          error: `ห้องนี้มีรูปจากคลังสาธารณะเดิม ${legacyPublicMedia} รายการ ต้องให้ทีมระบบตรวจและ archive รูปก่อน จึงจะลืมลูกค้าได้`,
        });
      }
      try {
        const queuedKeys = db.queueCustomerMediaDeletion(customerId, "customer_forget");
        const cleanup = drainMessageMediaDeletionQueue({ db, privateMedia, customerId, limit: 500, logger });
        if (cleanup.failed || cleanup.pending || (queuedKeys.length && cleanup.skipped)) {
          return json(res, 503, { ok: false, error: "ล้างไฟล์ส่วนตัวไม่สำเร็จ ยังไม่ได้ลืมลูกค้า" });
        }
        // JEV manifests retain customer IDs outside SQLite. Their all-file
        // validation and erase must complete immediately before the DB reset.
        // A failure leaves the identity row intact and is visible to the owner.
        try {
          eraseCustomerFromJevAuditManifests({ auditDir: config.jevAuditDir, customerIds: [...linkedIds] });
          const ids = [...linkedIds];
          db.raw.prepare(`DELETE FROM jev_audit_feedback WHERE customer_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
        } catch {
          return json(res, 503, { ok: false, error: "ลบผลตรวจย้อนหลังไม่สำเร็จ จึงยังไม่ได้ลืมลูกค้า" });
        }
        db.resetCustomer(customerId, { forget: true, forgetReason: "owner_pdpa_request" });
        db.addAudit({
          operator: username,
          action: "forget_customer",
          detail: "PDPA forget complete; hash-only restore tombstone retained",
        });
        return json(res, 200, { ok: true, forgotten: true });
      } catch {
        return json(res, 503, { ok: false, error: "ล้างไฟล์ส่วนตัวไม่สำเร็จ ยังไม่ได้ลืมลูกค้า" });
      }
    }

    // ---- G2b (B2): "ให้ AI ตอบต่อเลย" — ล้างหน้าต่าง operator-active ทันที ----
    if (req.method === "POST" && route[0] === "customers" && route[2] === "operator-clear" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const customer = db.setOperatorActiveUntil(customerId, 0);
      db.addAudit({ operator: username, action: "operator_pause_clear", target: customerId });
      return json(res, 200, { ok: true, customer });
    }

    // ---- G2b (B6): เพิ่มบันทึกส่งต่อ ----
    if (req.method === "POST" && route[0] === "customers" && route[2] === "notes" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 500) {
        return json(res, 400, { ok: false, error: "บันทึกต้องมี 1-500 ตัวอักษร" });
      }
      const note = db.addHandoffNote({ customerId, author: username, text });
      db.addAudit({ operator: username, action: "note_add", target: customerId, detail: text.slice(0, 120) });
      return json(res, 200, { ok: true, note, handoffNotes: db.listHandoffNotes(customerId, 50) });
    }

    // ---- G2b (B6): ลบบันทึกส่งต่อ (ลบโน้ต ai_auto ได้ด้วย — รอบ score ถัดไปสร้างใหม่) ----
    if (req.method === "POST" && route[0] === "notes" && route[2] === "delete" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const noteId = decodeURIComponent(route[1]);
      const row = db.getHandoffNote(noteId);
      if (!row) return json(res, 404, { ok: false, error: "ไม่พบบันทึกนี้" });
      db.deleteHandoffNote(noteId);
      db.addAudit({
        operator: username, action: "note_delete", target: row.customer_id,
        detail: `[${row.author}] ${String(row.text).slice(0, 100)}`,
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && route[0] === "notes" && route[2] === "pin" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const noteId = decodeURIComponent(route[1]);
      const existing = db.getHandoffNote(noteId);
      if (!existing) return json(res, 404, { ok: false, error: "ไม่พบบันทึก" });
      const body = await readJson(req);
      if (typeof body.pinned !== "boolean") return json(res, 400, { ok: false, error: "pinned ต้องเป็น boolean" });
      const note = db.setHandoffNotePinned(noteId, body.pinned);
      db.addAudit({ operator: username, action: body.pinned ? "note_pin" : "note_unpin", target: existing.customer_id });
      return json(res, 200, { ok: true, note, handoffNotes: db.listHandoffNotes(existing.customer_id, 50) });
    }

    // ---- G2a (F5): toggle follow-up ต่อลูกค้า ----
    if (req.method === "POST" && route[0] === "customers" && route[2] === "followup" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") {
        return json(res, 400, { ok: false, error: "ต้องส่ง enabled เป็น boolean" });
      }
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      const customer = db.setFollowupEnabled(customerId, body.enabled);
      db.addAudit({
        operator: username, action: "followup_toggle", target: customerId,
        detail: body.enabled ? "on" : "off",
      });
      return json(res, 200, { ok: true, customer });
    }

    // ---- G2a (F5): สร้างนัด follow-up ----
    if (req.method === "POST" && route[0] === "customers" && route[2] === "followups" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const customerId = decodeURIComponent(route[1]);
      const body = await readJson(req);
      const scheduledAt = Number(body.scheduledAt);
      // กันตั้งนัดย้อนหลัง (เผื่อ clock skew มือถือเล็กน้อย 1 นาที)
      if (!Number.isFinite(scheduledAt) || scheduledAt < now() - 60_000) {
        return json(res, 400, { ok: false, error: "scheduledAt ต้องเป็นเวลาในอนาคต (epoch ms)" });
      }
      const note = typeof body.note === "string" ? body.note.trim() : "";
      if (note.length > 300) {
        return json(res, 400, { ok: false, error: "note ต้องไม่เกิน 300 ตัวอักษร" });
      }
      // readJson awaits the request body. Re-read immediately before the synchronous
      // DB write so a suppression recorded while that body was still arriving wins.
      const customer = db.getCustomer(customerId);
      if (!customer) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      if (customer.followup_suppression_reason && Number(customer.followup_enabled) === 0) {
        return json(res, 409, { ok: false, error: "ลูกค้ารายนี้ตั้งค่าไม่ต้องติดตามอยู่ กรุณาเปิด follow-up ก่อนจึงจะนัดได้" });
      }
      const followup = db.createFollowup({ customerId, scheduledAt, createdBy: username, note });
      db.addAudit({
        operator: username, action: "followup_create", target: customerId,
        detail: `นัด ${new Date(scheduledAt).toISOString()}${note ? ` — ${note.slice(0, 100)}` : ""}`,
      });
      return json(res, 200, { ok: true, followup });
    }

    // ---- G2a (F5): ยกเลิกนัดที่ยัง pending ----
    if (req.method === "POST" && route[0] === "followups" && route[2] === "cancel" && route.length === 3) {
      if (!csrfOk(req, session)) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      const followupId = decodeURIComponent(route[1]);
      const row = db.getFollowup(followupId);
      if (!row) return json(res, 404, { ok: false, error: "ไม่พบนัดนี้" });
      if (row.status !== "pending") {
        return json(res, 409, { ok: false, error: `นัดนี้ถูกปิดไปแล้ว (${row.status})` });
      }
      db.setFollowupStatus(followupId, "cancelled", { detail: `cancelled_by:${username}` });
      db.addAudit({
        operator: username, action: "followup_cancel", target: followupId,
        detail: `customer=${row.customer_id}`,
      });
      return json(res, 200, { ok: true, followup: db.getFollowup(followupId) });
    }

    // ---- ตั้งค่า/ความรู้/brain-mode/corrections — แยกไฟล์ consoleSettingsApi.mjs ----
    const handledBySettings = await settingsRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledBySettings) return;

    // ---- G6 (P2): ออเดอร์ — แยกไฟล์ consoleOrdersApi.mjs ----
    // กับดักที่ต้องรู้ (1 ก.ย. 2026): ctx ชุดนี้ "ไม่มี" operator เพราะรอบนี้ไม่ได้กันอะไร
    // ในออเดอร์เลย (งานประจำของชมพู่) — วันไหนจะเขียนด่านสิทธิ์ในไฟล์นั้น ต้องเติม
    // `operator: session.operator,` ตรงนี้ก่อนเสมอ ไม่งั้น hasOperatorCapability จะ
    // fail-closed กันทุกคน และ `operator?.role !== "owner"` จะกันแม้แต่พี่ง้วงเอง
    const handledByOrders = await ordersRoutes.handle(req, res, url, route, {
      readJson, json, username,
      requireCsrf: () => csrfOk(req, session),
      parseChannelParam,
    });
    if (handledByOrders) return;

    // ---- v1.2: บรอดแคส — แยกไฟล์ consoleBroadcastApi.mjs ----
    if (broadcastRoutes) {
      const handledByBroadcast = await broadcastRoutes.handle(req, res, url, route, {
        readJson, readBody: tools.readBody, json, username, sessionId: session.sid, operator: session.operator,
        requireCsrf: () => csrfOk(req, session),
      });
      if (handledByBroadcast) return;
    }

    const handledByTrainingReview = await trainingReviewRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByTrainingReview) return;

    const handledByJevReview = await jevReviewRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByJevReview) return;

    // ---- 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง — แยกไฟล์ consoleOwnerReviewApi.mjs (หลังด่าน canAccessConsoleRoute) ----
    const handledByOwnerReview = await ownerReviewRoutes.handle(req, res, url, route, {
      readJson, json, username, operator: session.operator,
      requireCsrf: () => csrfOk(req, session),
    });
    if (handledByOwnerReview) return;

    // ---- Export ประวัติแชทเป็น CSV — แยกไฟล์ consoleExportApi.mjs (คุมขนาดไฟล์นี้ <800) ----
    if (req.method === "GET" && route[0] === "export" && route.length === 1) {
      // กับดักเดียวกับออเดอร์: ctx นี้ยังไม่มี operator — จะกันสิทธิ์ในไฟล์นั้นเมื่อไร ต้องส่งเพิ่มก่อน
      return handleExportRoute(res, url, { json, username, db, now, parseChannelParam, channelLabel });
    }

    if (req.method === "GET" && route[0] === "audit" && route.length === 1) {
      // detail ของ action ads_spend_ingest มียอดค่าแอดรายวันเป็นบาทเต็ม ๆ (adsIngest.mjs)
      // ปิดหน้า ROAS แล้วแต่ยังอ่านค่าแอดทางนี้ได้ = ปิดไม่จริง
      if (!hasOperatorCapability(session.operator, "finance.view")) {
        return json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
      }
      const limit = Number(url.searchParams.get("limit")) || 100;
      return json(res, 200, { ok: true, audit: db.listAudit(limit) });
    }

    return json(res, 404, { ok: false, error: "ไม่พบ endpoint นี้" });
  }

  /* --------------------------------- router -------------------------------- */

  // คืน true = จัดการแล้ว / false = ไม่ใช่เส้นทาง /console
  async function handle(req, res, url, tools) {
    const { pathname } = url;
    if (pathname !== "/console" && !pathname.startsWith("/console/")) return false;

    // Login needs its instance identity before authentication. This endpoint is
    // intentionally public and returns the bounded presentation object only.
    if (pathname === "/console/api/branding" && req.method === "GET") {
      tools.json(res, 200, { ok: true, branding });
      return true;
    }

    // fail-closed ก่อนทุกอย่าง: ไม่มี secret หรือไม่มีบัญชี = 503
    const reason = degradedReason();
    if (reason) {
      if (pathname.startsWith("/console/api/")) {
        tools.json(res, 503, { ok: false, error: reason });
      } else {
        sendConsoleHtml(res, 503, `<!doctype html><html lang="th"><meta charset="utf-8"><body><h1>503</h1><p>${reason}</p></body></html>`);
      }
      return true;
    }

    if (pathname.startsWith("/console/api/")) {
      await handleApi(req, res, url, tools);
      return true;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      tools.json(res, 405, { ok: false, error: "method ไม่รองรับ" });
      return true;
    }

    if (pathname === "/console" || pathname === "/console/") {
      if (!currentSession(req)) redirect(res, "/console/login");
      else serveConsolePage(res, "index.html", logger, branding);
      return true;
    }
    if (pathname === "/console/login") {
      if (currentSession(req)) redirect(res, "/console");
      else serveConsolePage(res, "login.html", logger, branding);
      return true;
    }
    // v1.1 (item 7): คู่มือ chat tags + RFM — หลัง login เหมือนหน้า console อื่น
    if (pathname === "/console/guide-tags.html") {
      if (!currentSession(req)) redirect(res, "/console/login");
      else serveConsolePage(res, "guide-tags.html", logger, branding);
      return true;
    }
    if (pathname === "/console/sw.js") {
      serveConsoleWorker(req, res, logger);
      return true;
    }
    // White-label: manifest ที่สร้างจากแบรนด์ของร้าน (ไม่ต้องล็อกอิน เหมือนไฟล์ static) — ธีม lukprae/course เดิมไม่เปลี่ยน
    if (pathname === GENERATED_MANIFEST_PATH
        || (pathname === "/console/static/manifest.webmanifest" && usesGeneratedManifest(branding))) {
      res.writeHead(200, {
        "content-type": "application/manifest+json; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=0, must-revalidate",
      });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(brandManifest(branding)));
      return true;
    }
    if (pathname.startsWith("/console/static/")) {
      const name = pathname.slice("/console/static/".length);
      // 28 ก.ย. 2026: ไฟล์ static ทั่วไปต้องเปิดโดยไม่ล็อกอินเพราะหน้า login ใช้ แต่วิดีโอ Intro
      // เป็นของภายในที่เจ้าของยังไม่อนุมัติเผยแพร่ — รู้ URL อย่างเดียวต้องดูไม่ได้
      if (CONSOLE_MEDIA_FILE_NAMES.includes(name)) {
        if (!currentSession(req)) {
          tools.json(res, 401, { ok: false, error: "ต้องเข้าสู่ระบบก่อน" });
          return true;
        }
        // วิดีโอจริงอยู่ที่ <DATA_DIR>/console-media/ (นอก git/release) — หาไม่เจอ = 404 แบบเดิม
        const mediaPath = resolveIntroMediaFile(name.split("/").pop(), { dirs: introMediaDirs(config) });
        if (!mediaPath) tools.json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
        else serveRangeFile(req, res, { path: mediaPath, type: consoleMediaType(name) }, tools.json);
        return true;
      }
      serveConsoleStatic(req, res, name, tools.json);
      return true;
    }

    tools.json(res, 404, { ok: false, error: "ไม่พบเส้นทางนี้" });
    return true;
  }

  return { handle, _limiter: limiter, _sessions: sessions };
}
