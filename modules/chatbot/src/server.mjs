// server.mjs — HTTP entry ของ AI Front Line Chassis (default :4850)
//
// เส้นทาง:
//   POST /webhooks/line  ตรวจ HMAC จาก raw body ก่อน parse, dedupe message.id,
//                        ตอบ 200 เร็ว, งานหนักทำใน queueMicrotask,
//                        DB write fail -> 500 ให้ LINE redeliver
//   GET  /health         schemaVersion + ok + components (ไม่ต้อง auth)
//   /api/*               ต้องมี x-dashboard-key (timing-safe) — ไม่มี key ตั้งไว้ = 503
import { createFacebookPageIdResolver } from "./businessSuiteLink.mjs";
import { createServer } from "node:http";
import { brandText, setActiveBrand } from "./brand.mjs";
import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, createReadStream, fstatSync, lstatSync, openSync } from "node:fs";
import { join as joinPath } from "node:path";
import { pathToFileURL } from "node:url";
import { createConfig, loadPersona, startupReport } from "./config.mjs";
import { activeSoul, candidateSoul, installCandidateSoul, installSoul, loadSoul, setSoulSelector, soulBlock } from "./soul/index.mjs";
import { createSoulSelector, SOUL_CANDIDATE_MODE_KEY, soulCandidateMode } from "./soulRollout.mjs";
import { openDb } from "./db.mjs";
import { createBurstBuffer } from "./burstBuffer.mjs";
import { createControlGate } from "./controlGate.mjs";
import { createHermesBridge } from "./hermesBridge.mjs";
import { createComplianceGuard, loadBannedWords } from "./complianceGuard.mjs";
import { createInboundImageClassifier } from "./inboundImageClassifier.mjs";
import { createInboundImageOutcome } from "./inboundImageOutcome.mjs";
import { loadImageCatalog } from "./imageCatalog.mjs";
import { loadImageHostingManifest } from "./imageHostingManifest.mjs";
import { loadSafetyRules, resolveIdentityTemplate } from "./safetyRouter.mjs";
import { createHumanizer } from "./humanizer.mjs";
import { createLineRegistry, verifyLineSignature } from "./lineClient.mjs";
import { loadChannels, customerKey, DEFAULT_CHANNEL_ID, FACEBOOK_CHANNEL_ID, facebookChannel } from "./channels.mjs";
import { createFacebookWebhook } from "./facebookWebhook.mjs";
import { createAdThumbKeeper } from "./adThumbs.mjs";
import { createMetaCapi } from "./metaCapi.mjs";
import { createTranscriber } from "./transcribe.mjs";
import { createSlipChecker } from "./slipCheck.mjs";
import { createOrderWebhook } from "./orders.mjs";
import { createPipeline } from "./pipeline.mjs";
import { createJevDecisionReview } from "./jevDecisionReview.mjs";
import { flagNeedsHumanForTurn, stampInboundOutcome, strandedHandoffMessage } from "./inboundOutcome.mjs";
import { createProcessId, ownerStillRunning } from "./processIdentity.mjs";
import { createShutdownCoordinator } from "./shutdown.mjs";
import { createOperatorApi } from "./operatorApi.mjs";
import { createConsoleApi } from "./consoleApi.mjs";
import { createWebPushService } from "./webPush.mjs";
import { createIdentityLink } from "./identityLink.mjs";
// คาบตัวกวาดแจ้งเตือน: ถี่พอให้เคสที่ส่งพลาดตามทันภายในไม่กี่นาที
// แต่ห่างพอที่จะไม่กวนแบตเครื่องที่ปกติดีอยู่แล้ว
const WEB_PUSH_SWEEP_MS = 3 * 60_000;
import { createFxRate } from "./fxRate.mjs";
import { seedOperators } from "./auth.mjs";
import { createCanary } from "./canary.mjs";
import { createFollowupEngine } from "./followupEngine.mjs";
import { createStagedFollowups, parseReviewCatalog } from "./stagedFollowups.mjs";
import { createPaymentGentleNudge } from "./paymentGentleNudge.mjs";
import { createYolo } from "./yolo.mjs";
import { createTelegramControl } from "./telegramControl.mjs";
import { createOwnerChat } from "./ownerChat.mjs";
import { createOwnerChatLessons } from "./ownerChatLessons.mjs";
import { createRetention } from "./retention.mjs";
import { runNeedsHumanSla } from "./needsHumanSla.mjs";
import { createPauseResumeSweep } from "./pauseResume.mjs";
import { createBrainParityWatch } from "./brain/parityWatch.mjs";
import { assertBrainReadConfig, createBrainRuntime } from "./brain/runtime.mjs";
import { createLock } from "./locks.mjs";
import { createDigest } from "./digest.mjs";
import { createHotFollowupPush } from "./hotFollowupPush.mjs";
// 5 ต.ค. 2026 (คำสั่งพี่ง้วง): ตัวกวาดคัดกรองรายชั่วโมง (ห้องสีเหลือง "AI off (not qualify)") + ด่านคำลงท้ายผู้หญิง
import { createQualifySweep } from "./qualifySweep.mjs";
// 12 ต.ค. 2026 (คำสั่งพี่ง้วง "คุยไปเรื่อย ... ให้คุณตีจบได้เลย"): ตีจบแชทนอกเรื่อง — กุญแจสองดอก แล้วปิดเหลืองแบบตัวกวาด
import { createOfftopicCloser } from "./offtopicClose.mjs";
// 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง — รอบตรวจ 09/12/15/19 เสนอปิดห้อง + คนกดยืนยันในคอนโซล
import { createOwnerCloseService } from "./ownerCloseService.mjs";
import { createOwnerReviewScheduler } from "./ownerReviewScheduler.mjs";
import { createQualifyAnswerPending } from "./qualifyAnswerPending.mjs";
import { createParticleFixAudit } from "./personaParticleAudit.mjs";
import { createIdentityLanding, isIdentityLandingPath } from "./identityLinkLanding.mjs";
import { createIdentityLinkHints } from "./identityLinkHints.mjs";
import { createLearningDigest, learningDigestGlobalEnabled } from "./learningDigest.mjs";
import { createEscalationNotifier } from "./notify.mjs";
import { SEND_PURPOSE, createLineSendRecorder } from "./lineSendLedger.mjs";
import { createLineInsightSync } from "./lineInsight.mjs";
import { createBroadcastEngine } from "./broadcast.mjs";
import { createBroadcastScheduler } from "./broadcastSchedule.mjs";
import { createBroadcastMediaStore } from "./broadcastMedia.mjs";
import { createBroadcastStudio } from "./broadcastStudio.mjs";
import { createLinkRedirect } from "./linkRedirect.mjs";
import { createStepMessages } from "./stepMessages.mjs";
import { createBlueprintCampaign } from "./blueprintCampaign.mjs";
import { seedCampaigns } from "./blueprintCampaignConfig.mjs";
import { createBlueprintSender } from "./blueprintSender.mjs";
import { createAdsIngest } from "./adsIngest.mjs";
import { loadReplyDeliveryPolicy } from "./replyDeliveryPolicy.mjs";
import { loadSalesPolicy } from "./salesPolicy.mjs";
import { loadTagFramework } from "./tagFramework.mjs";
import { createPilotGate } from "./pilotGate.mjs";
import { aiPausedNow } from "./aiPause.mjs";
import { attachmentContentDisposition, createPrivateMediaStore } from "./messageMedia.mjs";
import { drainMessageMediaDeletionQueue, reconcileMessageMediaOrphans } from "./messageMediaDeletion.mjs";
import {
  TRAINING_FEEDBACK_ACK,
  TRAINING_FEEDBACK_FAILED_ACK,
  TRAINING_FEEDBACK_EMPTY_ACK,
  deliverTrainingResetAcknowledgement,
  parseTrainingFeedbackCommand,
  parseTrainingResetCommand,
  prepareTrainingResetCommand,
} from "./trainingCommands.mjs";

/* --------------------------------- helpers -------------------------------- */

function securityHeaders() {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "no-store",
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...securityHeaders() });
  res.end(JSON.stringify(body));
}

const DOWNLOAD_BRIDGE_JS = `(() => {
  const token = location.hash.slice(1);
  history.replaceState(null, "", "/download");
  const status = document.getElementById("status");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    status.textContent = "ลิงก์ดาวน์โหลดไม่ถูกต้องหรือหมดอายุแล้ว";
    return;
  }
  status.textContent = "กำลังเตรียมไฟล์ดาวน์โหลด…";
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/download";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "token";
  input.value = token;
  form.append(input);
  document.body.append(form);
  form.submit();
})();\n`;
const DOWNLOAD_BRIDGE_HTML = `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ดาวน์โหลดไฟล์จากลูกแพร</title><body><p id="status">กำลังตรวจลิงก์ดาวน์โหลด…</p><noscript>กรุณาเปิด JavaScript เพื่อดาวน์โหลดไฟล์นี้</noscript><script src="/download-bridge.js" defer></script></body></html>`;

function readBody(req, limit = 2_000_000, { timeoutMs = 0, destroyOnOverflow = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const fail = (message, { destroy = false } = {}) => {
      settle(reject, message instanceof Error ? message : new Error(String(message)));
      if (destroy && !req.destroyed) req.destroy();
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0; // drain ต่อแต่ไม่เก็บ payload เพิ่มใน memory
        if (destroyOnOverflow) fail("payload ใหญ่เกินไป", { destroy: true });
        return;
      }
      if (!overflow) chunks.push(chunk);
    };
    const onEnd = () => overflow
      ? fail("payload ใหญ่เกินไป")
      : settle(resolve, Buffer.concat(chunks));
    const onError = (err) => fail(err);
    const onAborted = () => fail("request ถูกยกเลิกก่อนรับ body ครบ");
    const onClose = () => {
      if (!req.complete) onAborted();
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => fail("รับ request body นานเกินกำหนด", { destroy: true }), Number(timeoutMs));
      timer.unref?.();
    }
  });
}

async function readJson(req) {
  const raw = (await readBody(req)).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// เทียบ key แบบ timing-safe — hash ก่อนเทียบ กันทั้ง timing leak และ length leak
function dashboardKeyMatches(provided, expected) {
  if (!expected) return false;
  const a = createHash("sha256").update(String(provided || "")).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

// เหตุ 27 ก.ย. 2026: เครดิต OpenAI หมด 40 นาที แต่ /health บอกแค่ "hermes: degraded"
// ตัวเฝ้าจึงแจ้งได้แค่ "บริการล่ม HTTP 503" — ตีความรายงานของ gateway เป็นเหตุที่แน่ใจได้เท่านั้น
// /health เปิดสาธารณะ: ออกได้แค่ enum ของเรา ห้ามสะท้อนค่าจาก gateway ออกไปตรง ๆ
const PROVIDER_CREDIT_ERROR_IDS = new Set(["insufficient_quota", "credit_balance_exhausted"]);

function hermesDegradedReason(gatewayHealth) {
  // อ่านจากรายการค้างรายโมเดล ไม่ใช่ lastUpstreamError ช่องเดียว (รีวิว 27 ก.ย.: เรื่องอื่นของโมเดลอื่น
  // ที่ล้มตามมาจะทับประวัติล่าสุด แล้วเหตุเครดิตของโมเดลที่ยังค้างจะหายไปจากสายตา)
  const failures = gatewayHealth?.modelFailures;
  if (!failures || typeof failures !== "object" || Array.isArray(failures)) return null;
  const creditDown = Object.entries(failures).some(([model, failure]) =>
    // โมเดลต้องยังไม่ฟื้นจริง — กันรายงานที่ขัดกันเองจาก gateway
    gatewayHealth?.modelReadiness?.[model] === false
    && (PROVIDER_CREDIT_ERROR_IDS.has(failure?.type) || PROVIDER_CREDIT_ERROR_IDS.has(failure?.code)));
  return creditDown ? "provider_credit_exhausted" : null;
}

/* ---------------------------------- app ----------------------------------- */

// ประกอบระบบทั้งหมด — เทสต์ inject overrides (fetch stub ฯลฯ) ได้ทุกจุด
// รอผลงานพื้นหลังแบบมีเพดานเวลา — หมดเวลาแล้วเดินต่อ งานเบื้องหลังยังทำจนจบเอง
const TRAINING_BARRIER_TIMEOUT_MS = 900;

// ความล้มเหลวต้องยังทะลุออกไปเป็น 500 เสมอ เพื่อให้ LINE ส่งซ้ำแล้วงานได้ทำจริง —
// เพดานเวลานี้แก้เฉพาะกรณี "ช้า" ไม่ใช่กรณี "พัง"
async function waitBounded(promise, timeoutMs, { onTimeout, onLateFailure } = {}) {
  let timer = null;
  const settled = promise.then(
    () => ({ state: "done" }),
    (error) => ({ state: "failed", error }),
  );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: "timeout" }), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([settled, timeout]);
    if (outcome.state === "failed") throw outcome.error;
    if (outcome.state === "timeout") {
      onTimeout?.();
      settled.then((late) => {
        if (late.state === "failed") onLateFailure?.(late.error);
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createApp({ config, db, overrides = {}, logger = console }) {
  // White-label: โมดูลที่ไม่มี config ในมือ (template ข้อความ ฯลฯ) อ่านแบรนด์จากตรงนี้
  // ไม่ตั้ง env แบรนด์ = แบรนด์เริ่มต้น = ข้อความเดิมทุกตัวอักษร
  setActiveBrand(config.brand);
  // process id ของโปรเซสนี้ — บอกได้ว่าแถวที่ค้างอยู่เป็นของโปรเซสที่ตายไปแล้วหรือของเราเอง
  // ฝัง hostname + pid จริงไว้ด้วย เพื่อให้ตัวกวาดตอนบูต "ถามได้" ว่าเจ้าของแถวยังหายใจอยู่ไหม
  // (แยกด้วย process_id เฉย ๆ ไม่พอ — สองโปรเซสทับกันเมื่อไหร่ ตัวใหม่จะปักธงทับงานที่
  //  ตัวเก่ากำลังตอบอยู่จริง แล้วแอดมินอ่านธงนั้นไปตอบซ้ำ)
  const processId = overrides.processId ?? createProcessId();
  // ระบบกำลังปิด: รับข้อความไว้ให้ครบแต่ไม่เริ่มคิด (งบเวลาที่เหลือไม่พอ)
  let draining = false;
  const isDraining = () => draining;
  const setDraining = (value) => { draining = Boolean(value); };
  const privateMedia = overrides.privateMedia ?? createPrivateMediaStore({
    dir: config.messageMediaDir,
    maxBytes: config.messageMediaMaxBytes,
    imageMaxBytes: config.messageMediaImageMaxBytes,
    minFreeBytes: config.messageMediaMinFreeBytes,
    imageMaxWidth: config.mediaUploadMaxWidth,
    imageMaxHeight: config.mediaUploadMaxHeight,
    imageMaxPixels: config.mediaUploadMaxPixels,
  });
  // 18 ต.ค. 2026 (ขั้นที่ 1 ของแผน soul): ตัวตนของร้านมาจาก SOUL_FILE ที่เดียว — ติดตั้งก่อนสร้างทุกเส้นที่ประกอบพรอมต์
  // ตั้ง SOUL_FILE แล้วอ่านไม่ได้/hash ไม่ตรง/สัญญาไม่ผ่าน = บูตไม่ขึ้น · ไม่ตั้ง = ค่ากลางของ chassis (fork ที่ยังไม่มี soul)
  const soul = overrides.soul !== undefined ? overrides.soul : loadSoul({ file: config.soulFile, expectedSha256: config.soulSha256 });
  installSoul(soul);
  // persona ของทักตาม/YOLO/followupEngine/เครื่องเก่า = soul เส้น followup · ไม่มี soul = ไฟล์ persona ของ instance (PERSONA_FILE)
  const persona = overrides.persona ?? soulBlock("followup", { fallback: () => loadPersona(config) });
  // 20 ต.ค. 2026 (ขั้นที่ 3): รุ่นทดลองติดตั้ง "หลัง" อ่าน persona ตอนบูต — persona ที่บูตไว้เป็นของรุ่นหลักเสมอ
  // ไม่มีรุ่นทดลอง = ไม่มีตัวเลือก = ทุกเส้นได้รุ่นหลักตรงตัว (เหมือนขั้นที่ 1 ทุกไบต์)
  const soulCandidate = overrides.soulCandidate !== undefined ? overrides.soulCandidate
    : (soul ? loadSoul({ file: config.soulCandidateFile, expectedSha256: config.soulCandidateSha256 }) : null);
  installCandidateSoul(soulCandidate);
  setSoulSelector(soulCandidate ? createSoulSelector({ db }) : null);
  const bannedWords = overrides.bannedWords ?? loadBannedWords(config.bannedWordsFile, { logger });
  const safetyRules = overrides.safetyRules ?? loadSafetyRules(config.safetyRulesFile, { logger });
  const identityTemplate = resolveIdentityTemplate(overrides.identityTemplate ?? config.identityTemplate);
  const imageCatalog = overrides.imageCatalog ?? loadImageCatalog(config.imageCatalogFile, { logger });
  const imageHostingManifest = overrides.imageHostingManifest
    ?? loadImageHostingManifest(config.imageHostingManifestFile, { imageDir: config.imageDir });
  const replyDeliveryPolicy = overrides.replyDeliveryPolicy ?? loadReplyDeliveryPolicy(config.replyDeliveryPolicyFile);
  const salesPolicy = overrides.salesPolicy ?? loadSalesPolicy(config.salesPolicyFile);
  // Sales routing is a business boundary. A copied policy must not silently
  // qualify or hand off customers under a different business/OA instance.
  if (salesPolicy && config.businessId !== salesPolicy.businessId) {
    throw new Error("BUSINESS_ID must exactly match sales policy businessId when sales policy is configured");
  }
  // กรอบป้ายเป็นคำศัพท์ของธุรกิจเดียว — ไฟล์ของธุรกิจอื่นห้ามติดป้ายให้ลูกค้าที่นี่
  const tagFramework = overrides.tagFramework ?? loadTagFramework(config.tagFrameworkFile);
  if (tagFramework && config.businessId !== tagFramework.businessId) {
    throw new Error("BUSINESS_ID must exactly match tag framework businessId when a tag framework is configured");
  }
  const broadcastMedia = overrides.broadcastMedia
    ?? createBroadcastMediaStore({ config, db, logger });
  const pilotGate = overrides.pilotGate ?? createPilotGate({ config, logger });

  // B8.2: โมเดล runtime อ่านสดจาก DB settings ทุก call — ค่าว่าง = config.hermesModel
  // v1.4.9: followup_model ค่าว่าง = ตามตัวหลัก (bridge จะ resolve reply model ให้เอง)
  const hermes = createHermesBridge({
    config,
    fetchImpl: overrides.hermesFetch,
    logger,
    getReplyModel: () => db.getSetting("reply_model") || config.hermesModel,
    getScorerModel: () => db.getSetting("scorer_model") || config.hermesScorerModel || config.hermesModel,
    getFollowupModel: () => db.getSetting("followup_model") || "",
  });
  // W3 (multi-OA): โหลดรายการ channel — ไม่มี CHANNELS_FILE = channel เดียว "default"
  // จาก env เดิม (registry จะ resolve เป็น client ตัวเดียวกับ line ด้านล่าง)
  const channels = overrides.channels ?? loadChannels(config, { logger });
  // v1.5: Facebook เข้า registry/console เมื่อ FB_ENABLED — ไม่มี channelSecret ของ LINE
  // โดยตั้งใจ จึงไม่ติด activeChannels/verify ของ LINE ด้านล่างแม้แต่บรรทัดเดียว
  if (config.fbEnabled && !channels.some((ch) => ch.id === FACEBOOK_CHANNEL_ID)) {
    channels.push(facebookChannel(config, db));
    logger.log?.("[channels] Facebook channel เปิดใช้งาน (FB_ENABLED)");
  }
  const activeChannels = channels.filter((ch) => ch.active && ch.channelSecret);
  const trainingCommandChannels = new Set(config.trainingCommandChannels || []);
  // fail-closed: ไม่มี channel ไหนมี secret เลย = /webhooks/line ตอบ 503
  const lineWebhookDegraded = activeChannels.length === 0;
  const lineRegistry = createLineRegistry({
    config, channels,
    fetchImpl: overrides.lineFetch,
    sleep: overrides.sleep,
    logger,
    outboundAllowed: (recipient) => pilotGate.allowOutbound(recipient),
    // 28 ก.ย. 2026: ทุกคำขอที่ LINE รับ = หนึ่งแถวในบัญชีการส่ง (ส่งเพื่ออะไร · reply/push) — พังไม่กระทบการส่ง
    onSend: overrides.lineSendRecorder ?? createLineSendRecorder({ db, logger }),
  });
  // 28 ก.ย. 2026: สถิติทางการรายวันของ LINE (บรอดแคสต์จาก OA Manager ฯลฯ) — arm เฉพาะ instance ที่ยิง LINE จริง
  const lineInsight = overrides.lineInsight ?? createLineInsightSync({ config, db, lineRegistry, channels, logger });
  // client ของ channel default — เส้นทาง legacy (canary ฯลฯ) ใช้ตัวนี้เหมือนเดิม
  const line = lineRegistry.forChannel(DEFAULT_CHANNEL_ID);
  // B3: ถอดความข้อความเสียง — ปิดตัวเองเมื่อไม่มี OPENAI_API_KEY (transcribeEnabled)
  const transcriber = overrides.transcriber
    ?? createTranscriber({ config, fetchImpl: overrides.transcribeFetch, logger });
  // G3: ตรวจสลิปอัตโนมัติ (pre-check ให้แอดมิน) — ไม่มี SLIP_CHECK_URL = ปิดสนิท
  const slipCheck = overrides.slipCheck
    ?? createSlipChecker({ config, db, fetchImpl: overrides.slipFetch, logger });
  // v1.4.48: ตัวจำแนกรูป — ปิดโดยค่าเริ่มต้น เปิดด้วย IMAGE_CLASSIFY_ENABLED=true
  // ปิดอยู่ = เส้นทางรูปเดิมทุกตัวอักษร ไม่มีการเรียกโมเดลและไม่มีรูปออกนอกเครื่อง
  const imageClassify = overrides.imageClassify
    ?? createInboundImageClassifier({ config, db, privateMedia, hermes, logger,
      requestMediaIngest: () => queueMicrotask(runMediaIngest) });
  const inboundImageOutcome = createInboundImageOutcome({ db, logger });
  // 5 ต.ค. 2026 (พี่ง้วง "เพิ่มด่านกันคำว่าครับให้หน่อย"): เปิดเฉพาะ PERSONA_PARTICLES=female (ลูกแพร)
  // ปิดอยู่ = createHumanizer() แบบเดิมทุกไบต์ · แก้แล้วจด audit เป็นชนิด+จำนวน ไม่เก็บข้อความ
  const humanizer = createHumanizer({
    femaleParticles: config.personaParticles === "female",
    onParticleFix: createParticleFixAudit({ db, logger }),
    logger,
  });
  const burst = createBurstBuffer({
    debounceMs: config.burstDebounceMs,
    maxWaitMs: config.burstMaxWaitMs,
  });
  const controlGate = createControlGate({
    isAiEnabled: (customerId) => db.getCustomer(customerId)?.ai_enabled === 1,
    logger,
  });
  // v1.1 (bug 5): push แจ้งทีมงานเมื่อลูกค้าต้องการคน — ผู้รับตั้งใน console ต่อสาขา
  const notifier = overrides.notifier
    ?? createEscalationNotifier({ db, config, line, lineRegistry, logger });
  const webPush = overrides.webPush
    ?? createWebPushService({ db, config, fetchImpl: overrides.webPushFetch ?? globalThis.fetch, logger });
  // P2: ทางอ่านสมองที่มีเวอร์ชัน
  // ด่าน "ตั้งค่าผิด" fatal (แก้ได้ที่ไฟล์ env เท่านั้น) · ด่าน "ข้อมูลยังไม่พร้อม"
  // ไม่ fatal: createBrainRuntime จะดังให้สุดแล้ววิ่งทางเดิมต่อ (mode = legacy_forced)
  // — ไม่ยอมบูตเพราะยังไม่มีรุ่น live = ลูกค้าทั้งระบบไม่ได้รับคำตอบ ซึ่งแย่กว่าเสมอ
  assertBrainReadConfig({ config });
  const brainRuntime = overrides.brainRuntime
    ?? createBrainRuntime({ db, config, notifier, logger });

  const guard = createComplianceGuard({
    bannedWords,
    getApprovedPrices: () => db.approvedPrices(),
    // v1.4.6b: บรรทัดชื่อ-ตำแหน่งผู้รีวิวจากคลังความรู้ = quote ที่เจ้าของอนุมัติ —
    // คำแบนข้างใน (ดีที่สุด/อันดับ 1 ในชื่อธุรกิจ) ต้องไม่ทำให้รีวิวส่งไม่ได้
    getApprovedQuotes: () => parseReviewCatalog(db.listKnowledge()).map((review) => review.who),
    // P2: ตารางราคา "ต่อห้อง" — ผู้ส่งทุกตัว (reply, follow-up, staged FU, schedule ack)
    // จึงตัดสินด้วยชุดตัวเลขของสมองรุ่นที่ห้องนั้นใช้ โดยไม่ต้องไปเดินสายที่ทุก call site
    // ไม่มี customerId (เช่นบรอดแคสต์ = หนึ่งข้อความถึงทุกคน) -> ตารางกลาง = รุ่น live ซึ่งถูกแล้ว
    getRoomPrices: (customerId, channelId) => {
      const brain = brainRuntime.resolve(customerId, channelId || "default", Date.now());
      return brain ? brain.bundle.guardTables.approvedPrices : null;
    },
    trainingMockMode: config.trainingMockMode,
    logger,
  });

  const decisionReview = createJevDecisionReview({ config, db, fetchImpl: overrides.jevFetch,
    now: overrides.now || Date.now, logger });
  // 11 ต.ค. 2026 แคมเปญ #AIAGENT (คลาส IESA6): ขาเข้าที่ pipeline เรียก — ไม่มีแคมเปญที่เปิดอยู่ในฐาน = ไม่ทำอะไร
  const blueprintCampaign = overrides.blueprintCampaign !== undefined
    ? overrides.blueprintCampaign
    : createBlueprintCampaign({ db, config, lineRegistry, line, guard, tagFramework, processId, logger, now: overrides.now || Date.now });
  // ตีจบแชทนอกเรื่อง: ทำงานเฉพาะเมื่อ qualify_sweep_mode = on และ offtopic_close_mode ไม่ใช่ off (อ่านสดทุกข้อความ)
  // fx สร้างทีหลัง pipeline — อ่านผ่านฟังก์ชันตอนเรียกจริง (หลัง createApp คืนค่าแล้ว)
  const offtopicCloser = overrides.offtopicCloser !== undefined
    ? overrides.offtopicCloser
    : createOfftopicCloser({ config, db, hermes, logger, now: overrides.now || Date.now,
      thbPerUsd: () => fx?.current?.()?.thbPerUsd });
  const pipeline = createPipeline({
    config, db, hermes, line, lineRegistry, humanizer, guard, burst, controlGate, transcriber, slipCheck,
    jevFetch: overrides.jevFetch,
    decisionReview,
    now: overrides.now || Date.now,
    imageClassify, inboundImageOutcome,
    notifier,
    brainRuntime,
    persona,
    brandPack: config.brandPack,
    safetyRules,
    identityTemplate,
    paymentTemplate: overrides.paymentTemplate ?? config.paymentTemplate,
    imageCatalog,
    replyDeliveryPolicy,
    salesPolicy,
    tagFramework,
    processId,
    blueprintCampaign,
    offtopicCloser,
    logger,
  });
  // 28 ก.ย. 2026: ลูกค้าคนเดียวกันข้าม Facebook ↔ LINE — ตัวเดียวใช้ร่วมทั้ง webhook (รับรหัส) และคอนโซล (ส่งลิงก์/เชื่อมมือ)
  const identityLink = overrides.identityLink ?? createIdentityLink({
    config, db, lineRegistry, pipeline, notifier, logger, now: overrides.now || Date.now,
  });
  // 30 ก.ย. 2026: ลูกค้าแอดไลน์แล้วไม่ส่งรหัส → แจ้งทีมพร้อมห้อง Facebook ที่ลิงก์เชิญยังไม่ใช้ในช่วงนั้น (ไม่เชื่อมเอง)
  const identityHints = overrides.identityHints ?? createIdentityLinkHints({ db, notifier, logger, now: overrides.now || Date.now });
  // A reset is a per-customer ingress barrier. While it is queued/running,
  // later webhook requests for that customer wait before persisting inbound
  // rows, so they cannot be attached to the session that is about to close.
  const pendingTrainingResets = new Map();

  function persistPausedTrainingReset({ customerId, channelId, event, dedupeKey }) {
    const message = event?.message || {};
    const persisted = db.persistPausedInbound({
      dedupeKey,
      customerId,
      msgType: message.type || "unknown",
      channelId,
      content: message.type === "text" ? message.text || "" : `[${message.type}] id=${message.id || ""}`,
    });
    return { suppressed: "ai_paused_before_reset", ...persisted };
  }

  function enqueueTrainingReset({ customerId, channelId, event, dedupeKey, feedback = "" }) {
    const key = String(customerId);
    const run = pipeline.runExclusive(key, async () => {
      // Admission-time pause checks are insufficient: this command can wait
      // behind an in-flight LINE send. Recheck after acquiring the customer
      // queue; while paused, retain the command as ordinary inbound and never
      // rotate the training session or cross the provider boundary.
      if (aiPausedNow({ db, config })) {
        return persistPausedTrainingReset({ customerId: key, channelId, event, dedupeKey });
      }
      // Rotation and acknowledgement are one ordered critical section. Any
      // draft already inside sendBubbles finishes before this starts.
      const rotation = prepareTrainingResetCommand({
        db, channelId, customerId: key, dedupeKey, feedback,
      });
      return deliverTrainingResetAcknowledgement({
        db, lineRegistry, channelId, customerId: key, event, rotation,
      });
    });
    pendingTrainingResets.set(key, run);
    run.finally(() => {
      if (pendingTrainingResets.get(key) === run) pendingTrainingResets.delete(key);
    }).catch(() => {});
    return run;
  }
  // B8: อัตรา USD->THB สด (cache ใน DB, refresh เบื้องหลัง) — เทสต์ inject fxFetch
  const fx = overrides.fx ?? createFxRate({ config, db, fetchImpl: overrides.fxFetch, logger });
  const operatorApi = createOperatorApi({ db, lineRegistry });
  // G6 (P2): integration hook ระบบออเดอร์ — ไม่มี ORDER_WEBHOOK_URL = ปิดสนิท
  const orderWebhook = overrides.orderWebhook
    ?? createOrderWebhook({ config, fetchImpl: overrides.orderWebhookFetch, logger });
  // v1.2: เครื่องส่งบรอดแคส — ใช้ guard ตัวเดียวกับ pipeline (ราคาต้องตรงตาราง approve)
  const broadcastEngine = overrides.broadcastEngine
    ?? (config.broadcastEnabled
      ? createBroadcastEngine({ db, config, guard, line, lineRegistry, logger })
      : null);
  // 28 ก.ย. 2026: สตูดิโอบรอดแคสต์ — ส่งถึงเพื่อนทุกคน/กลุ่มเป้าหมาย LINE/ข้อมูลประชากร + ผลจาก LINE (broadcastStudio.mjs)
  const broadcastStudio = overrides.broadcastStudio
    ?? (broadcastEngine ? createBroadcastStudio({ db, config, engine: broadcastEngine, lineRegistry, logger }) : null);
  const studioImageCatalogByKey = () => {
    const merged = new Map(imageCatalog.filter((entry) => entry?.needsVerification !== true).map((entry) => [entry.key, entry]));
    for (const entry of broadcastMedia?.list?.() || []) {
      if (!merged.has(entry.key)) merged.set(entry.key, entry);
    }
    return merged;
  };
  // 28 ก.ย. 2026: ข้อความตามขั้น (Step messages) — ต้องเปิดบรอดแคสต์ (ใช้ตัวกันราคา/โควตาตัวเดียวกัน)
  // นาฬิกาเดียวของข้อความตามขั้น (เทสต์ตรึงเวลาได้) — webhook ใช้ตัวนี้ตัดสินว่า "เข้ามาหลังเปิดใช้ลำดับ" ไหม
  const stepClock = typeof overrides.stepNow === "function" ? overrides.stepNow : Date.now;
  const stepMessages = overrides.stepMessages
    ?? (broadcastEngine
      ? createStepMessages({
          db, config, engine: broadcastEngine, lineRegistry, getImageCatalogByKey: studioImageCatalogByKey, logger,
          now: stepClock,
        })
      : null);
  const broadcastScheduler = overrides.broadcastScheduler
    ?? (broadcastEngine
      ? createBroadcastScheduler({
          db, config, engine: broadcastEngine, studio: broadcastStudio, logger,
          getImageCatalogByKey: () => {
            const merged = new Map(
              imageCatalog
                .filter((entry) => entry?.needsVerification !== true)
                .map((entry) => [entry.key, entry]),
            );
            for (const entry of broadcastMedia?.list?.() || []) {
              if (!merged.has(entry.key)) merged.set(entry.key, entry);
            }
            return merged;
          },
        })
      : null);
  async function ingestQueuedAttachment(attachment) {
    if (!config.messageMediaEnabled || !config.inboundLineContentCapture || !privateMedia.enabled()) return;
    if (!attachment?.provider_message_id || attachment.kind === "sticker") return;
    // Facebook แนบไฟล์มาเป็น URL ใน webhook (ไม่ใช่ content API) — ตัวอ้างอิงที่ส่งให้ client
    // จึงต่างกันตามช่อง: LINE ใช้ message id ส่วน FB ใช้ URL ที่เก็บไว้ใน providerMeta
    let fetchRef = attachment.provider_message_id;
    try {
      const meta = JSON.parse(attachment.provider_meta_json || "{}");
      const provider = typeof meta.contentProvider === "object" ? meta.contentProvider?.type : meta.contentProvider;
      if (provider === "facebook" || attachment.source === "facebook") {
        if (!meta.url) return db.updateMessageAttachment(attachment.id, { status: "failed", unavailableReason: "ไม่มีลิงก์ไฟล์จาก Facebook" });
        fetchRef = String(meta.url);
      } else if (provider && provider !== "line") {
        return db.updateMessageAttachment(attachment.id, { status: "unavailable", unavailableReason: "external provider content is not fetched" });
      }
    } catch { /* legacy metadata can still use LINE id */ }
    const customer = db.getCustomer(attachment.customer_id);
    const client = lineRegistry.forChannel(customer?.channel_id || DEFAULT_CHANNEL_ID);
    const content = await client.getMessageContent(fetchRef, { maxBytes: config.messageMediaMaxBytes });
    if (!content.ok) {
      const transient = content.status === 0 || content.status === 202 || content.status === 429 || content.status >= 500;
      if (transient && attachment.attempts < config.messageMediaIngestMaxAttempts) {
        const delay = Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, attachment.attempts - 1)));
        return db.rescheduleMessageAttachment(attachment.id, { nextAttemptAt: Date.now() + delay, reason: `LINE content retry (${content.status || 0})` });
      }
      return db.updateMessageAttachment(attachment.id, { status: "failed", unavailableReason: `LINE content unavailable (${content.status || 0})` });
    }
    const usage = db.messageMediaUsage();
    if (usage.count >= config.messageMediaMaxActive || usage.bytes + content.bytes.length > config.messageMediaTotalBytes) {
      return db.updateMessageAttachment(attachment.id, { status: "failed", unavailableReason: "คลังสื่อถึงเพดาน" });
    }
    let saved = null;
    try {
      const origin = attachment.source === "facebook" ? "facebook" : "line";
      saved = await privateMedia.saveAsync({ buffer: content.bytes, mime: content.mime, name: attachment.original_name || `${origin}-${attachment.provider_message_id}`, kind: attachment.kind, origin });
      try {
        return db.updateMessageAttachment(attachment.id, { status: "ready", mime: saved.mime, byteSize: saved.byteSize, sha256: saved.sha256, storageKey: saved.storageKey, unavailableReason: "" });
      } catch (error) {
        privateMedia.remove(saved.storageKey);
        saved = null;
        throw error;
      }
    } catch {
      if (saved?.storageKey) try { privateMedia.remove(saved.storageKey); } catch { /* best effort after a failed save/update */ }
      try { return db.updateMessageAttachment(attachment.id, { status: "failed", unavailableReason: "ชนิดหรือขนาดไฟล์ไม่อยู่ในขอบเขตที่อนุมัติ" }); }
      catch (error) { logger.warn?.(`message media status update failed: ${error?.message || error}`); return null; }
    }
  }
  // Restart recovery: queued rows are the durable source of truth. A failed
  // provider fetch remains visibly failed; it is never retried blindly forever.
  let mediaIngestRunning = false;
  const runMediaIngest = async () => {
    if (mediaIngestRunning || !config.messageMediaEnabled || !config.inboundLineContentCapture || !privateMedia.enabled()) return;
    mediaIngestRunning = true;
    try {
      const due = db.claimDueMessageAttachments({ limit: config.messageMediaIngestBatch, maxAttempts: config.messageMediaIngestMaxAttempts });
      for (const attachment of due) await ingestQueuedAttachment(attachment);
    } catch (error) { logger.warn?.(`message media recovery failed: ${error?.message || error}`); }
    finally { mediaIngestRunning = false; }
  };
  let mediaIngestTimer = null;
  if (config.messageMediaEnabled && config.inboundLineContentCapture && privateMedia.enabled()) {
    queueMicrotask(runMediaIngest);
    mediaIngestTimer = setInterval(runMediaIngest, config.messageMediaIngestIntervalMs);
    mediaIngestTimer.unref?.();
  }
  // Daily learning remains proposal-only. Stage A is local; optional Stage B
  // crosses the existing stateless scorer boundary only when its dedicated
  // switch is enabled. A later authenticated owner decision is still the sole
  // path that can write knowledge.
  const learning = overrides.learningDigest ?? createLearningDigest({
    config, db, logger, channels,
    scorer: config.learningModelEnabled === true ? (args) => hermes.scoreLearning(args) : null,
  });
  // 2026-09-28 (คำสั่งพี่ง้วง): YOLO = ลูกแพรทักห้องนี้ต่อ 1 ครั้งตามคำสั่งคน — ใช้ร่าง/ด่าน/ช่องส่ง
  // ชุดเดียวกับ follow-up ทุกชิ้น · ร่างนอกคิว แล้ว "ช่วงส่ง" ต่อคิวเดียวกับเส้นตอบลูกค้า (pipeline.runExclusive)
  const yolo = overrides.yolo ?? createYolo({
    config, db, hermes, lineRegistry, guard, humanizer,
    persona, brandPack: config.brandPack, brainRuntime, imageCatalog, replyDeliveryPolicy,
    pipeline, notifier, logger, now: overrides.now || Date.now,
  });
  // ช่องสั่งงานทาง Telegram — เริ่มรับข้อความใน startServer เท่านั้น (เทสต์ createApp ไม่เปิด long poll)
  // และทำงานจริงเมื่อมีโทเคนที่เจ้าของกรอกในคอนโซลแล้วเท่านั้น
  // 28 ก.ย. 2026 (คำสั่งพี่ง้วง): "คุยกับลูกแพร" — ข้อความที่ไม่ใช่คำสั่งคุยกับสมองแชทของเจ้าของ
  // (ownerChat.mjs · สั่งระบบไม่ได้) + สอนบทเรียนผ่านด่านเดียวกับคอนโซล (ownerChatLessons.mjs)
  // สวิตช์ settings.owner_chat_mode อ่านสดทุกข้อความ — ปิด = Telegram รับเฉพาะคำสั่งแบบเดิม
  const ownerChat = overrides.ownerChat ?? createOwnerChat({ config, db, hermes, brainRuntime, fx, logger, now: overrides.now || Date.now });
  const telegramControl = overrides.telegramControl ?? createTelegramControl({
    config, db, yolo, hermes, fetchImpl: overrides.telegramFetch, logger,
    ownerChat, chatLessons: createOwnerChatLessons({ config, db, notifier, logger }),
    now: overrides.now || Date.now, sleep: overrides.telegramSleep ?? null,
  });
  // 28 ก.ย. 2026: รหัสเพจ Facebook ตัวเดียวทั้งระบบ — webhook สอนให้ (entry.id) · คอนโซลถาม Graph เมื่อยังไม่รู้
  const facebookPage = createFacebookPageIdResolver({ getClient: () => lineRegistry.forChannel(FACEBOOK_CHANNEL_ID), logger });
  // 6 ต.ค. 2026 ค่ำ: สำเนารูปแอดในฐานข้อมูล — ลิงก์ CDN ของ Meta หมดอายุในไม่กี่วัน (adThumbs.mjs)
  const adThumbs = createAdThumbKeeper({ db, fetchImpl: overrides.adThumbFetch ?? globalThis.fetch, logger });
  // รูปของห้องที่จดไว้ก่อนรีลีสนี้ / ก่อนรีสตาร์ท — ไล่เก็บหนึ่งรอบหลังบูต (timer ไม่รั้ง process)
  setTimeout(() => adThumbs.kick({ force: true }), 15_000).unref?.();
  // 7 ต.ค. 2026: Purchase → Meta Conversions API ตอนออเดอร์ชำระแล้ว (metaCapi.mjs · สวิตช์ meta_capi_mode ค่าเริ่มต้นปิด)
  const metaCapi = createMetaCapi({
    db, logger,
    fetchImpl: overrides.capiFetch ?? ((...args) => globalThis.fetch(...args)),
    graphBase: config.fbMockUrl || `https://graph.facebook.com/${config.fbApiVersion || "v24.0"}`,
    getPageToken: () => {
      try { return lineRegistry.channels.find((c) => c.id === FACEBOOK_CHANNEL_ID)?.credentials?.()?.pageAccessToken || ""; } catch { return ""; }
    },
    getPageId: () => facebookPage.resolve(),
  });
  // ลองส่งออเดอร์ที่ยังไม่สำเร็จทุก 30 นาที (สวิตช์ปิด = ไม่ทำอะไร) · timer ไม่รั้ง process
  setInterval(() => { void metaCapi.sweep(); }, 30 * 60_000).unref?.();
  setTimeout(() => { void metaCapi.sweep(); }, 60_000).unref?.();
  // 11 ต.ค. 2026 แคมเปญ #AIAGENT: สร้าง/ส่ง "การวางระบบ AI Agent" ตามสวิตช์ blueprint_send_mode (ไม่มีแถว = off)
  const blueprintSender = overrides.blueprintSender ?? createBlueprintSender({
    db, config, hermes, lineRegistry, line, guard, notifier, fx, processId, logger, isDraining,
    now: overrides.now || Date.now,
    ...(overrides.blueprintSleep ? { sleep: overrides.blueprintSleep } : {}),
  });
  // 12 ต.ค. 2026 ค่ำ (พี่ง้วง: "ไม่มีอะไรปิดเองอีกแล้ว"): คนกดยืนยันห้องที่ AI เสนอ → คำลาตายตัว + ห้องเหลือง (คิวเดียวกับเส้นตอบ)
  // ไม่มีตัวตีจบ (เทสต์ที่ส่ง offtopicCloser: null) = ไม่มีบริการยืนยัน · รอบตรวจสร้างหลังตัวกวาด (ต้องรอตัวกวาดเดินจบ)
  const ownerCloseService = overrides.ownerCloseService !== undefined
    ? overrides.ownerCloseService
    : (offtopicCloser ? createOwnerCloseService({ config, db, closer: offtopicCloser, pipeline, lineRegistry, logger, now: overrides.now || Date.now }) : null);
  let ownerReviewScheduler = null;
  const consoleApi = createConsoleApi({
    ownerReview: { closeService: ownerCloseService, stats: () => ownerReviewScheduler?.stats?.() ?? null },
    facebookPage, adThumbs, metaCapi,
    // เฟส 3: ด่าน G5 ต้องตรวจด้วย 'คำต้องห้ามและกฎฉุกเฉินตัวจริงที่ runtime ใช้อยู่'
    // ไม่ใช่ลิสต์ว่าง — ด่านที่รายงานว่าสะอาดเพราะไม่มีใครส่งอะไรให้ตรวจ คือด่านที่โกหก
    bannedWords, safetyRules,
    config, db, line, lineRegistry, channels, imageCatalog, broadcastMedia, logger, fx, orderWebhook,
    broadcastEngine, broadcastScheduler, broadcastStudio, stepMessages, learning, webPush,
    // 2026-09-02: คอนโซลต้องสั่งตอบ "ข้อความที่ค้าง" ได้เมื่อยืนยันตัวตนลูกค้าเก่าเสร็จ
    pipeline, notifier, identityLink,
    yolo, telegram: telegramControl,
    // G4: หน้า "ความรู้" โชว์ของที่ AI โหลดจริง — ค่าเดียวกับที่ pipeline ใช้เป๊ะ
    brain: { persona, brandPack: config.brandPack, safetyRules },
    // 28 ก.ย. 2026: แผงป้าย/ตัวตรวจป้ายที่คนติด/RFM ใช้กรอบเดียวกับ scorer (สวิตช์ tag_framework_mode)
    tagFramework,
    blueprint: blueprintSender,
  });

  // G2a (F5): follow-up engine — scheduler แบบ canary (sync lock + interval + unref)
  const followups = createFollowupEngine({
    config, db, hermes, line, lineRegistry, guard, humanizer,
    decisionReview, notifier,
    persona, brandPack: config.brandPack, logger, brainRuntime,
  });

  // v1.4.6: staged follow-up — sub-agent ตามสเตจลูกค้า (คำสั่งพี่ง้วง 2026-08-16)
  // 2026-09-28: ทักเบา ๆ หนึ่งครั้งหลังส่งบัญชี เดินในรอบเดียวกัน (สวิตช์ settings.payment_gentle_nudge)
  const stagedFollowups = overrides.stagedFollowups ?? createStagedFollowups({
    config, db, hermes, lineRegistry, guard, humanizer,
    decisionReview, notifier,
    persona, brandPack: config.brandPack, logger, brainRuntime,
    paymentNudge: createPaymentGentleNudge({ config, db, lineRegistry, guard, humanizer, decisionReview, notifier, logger }),
  });

  // M4: retention pruning รายวัน (แบบแผน canary: interval + unref + sync lock)
  const drainPrivateMedia = (customerId = null) => drainMessageMediaDeletionQueue({
    db, privateMedia, customerId, limit: 250, logger, policy: config.erasedMediaPolicy,
  });
  const retention = overrides.retention ?? createRetention({
    config, db, notifier, logger,
    mediaDeletion: () => drainPrivateMedia(),
  });

  // 2026-09-02: นาฬิกา SLA ของคิว "รอคน" (แบบแผน canary/retention: interval + unref
  // + sync lock ปล่อยใน finally) — ห้ามยิงข้อความหาลูกค้า ปลุกเฉพาะทีมงานเท่านั้น
  // ล้มเหลวในรอบใดต้อง log แล้วจบในตัว ห้ามโยน error ออกมาถึงเส้นทางแชท
  const needsHumanSla = overrides.needsHumanSla ?? (() => {
    const lock = createLock();
    let timer = null;
    const runOnce = () => {
      if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
      try {
        return runNeedsHumanSla({ db, notifier, config, logger });
      } catch (err) {
        logger.error?.(`needsHumanSla: ${err?.message || err}`);
        return { skipped: "error" };
      } finally {
        lock.release();
      }
    };
    return {
      runOnce,
      start() {
        if (timer || config.needsHumanSlaEnabled !== true || !(config.needsHumanSlaTickMs > 0)) return false;
        timer = setInterval(runOnce, config.needsHumanSlaTickMs);
        timer.unref?.(); // ไม่ค้ำ process ตอน shutdown
        return true;
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = null;
      },
      get running() { return timer !== null; },
    };
  })();
  // 2026-09-28: ข้อความที่ลูกค้าพิมพ์ระหว่าง AI พัก (คนเพิ่งตอบ) แล้วไม่มีใครตอบ — ตอบครั้งเดียว
  // เมื่อหมดเวลาพัก (pauseResume.mjs) สวิตช์อยู่ใน settings pause_resume_answer (ค่าเริ่มต้นเปิด)
  const pauseResume = overrides.pauseResume ?? createPauseResumeSweep({ db, config, pipeline, logger, isDraining });
  // Phase 1a (3 ก.ย. 2026): ตัวเฝ้าสมองเงา — ตรวจ parity ซ้ำระหว่างวันแล้วจดผล/ตัวนับ
  // "ตรงกี่วันติด" ลง settings เพื่อให้ด่าน "diff = 0 ติดกัน N คืน" มีคนนับให้จริง
  // ใช้สวิตช์เดิม BRAIN_SHADOW_PARITY (ไม่มีสวิตช์ใหม่) — ปิดอยู่ = ไม่ arm และไม่แตะฐาน
  const brainParity = overrides.brainParity ?? createBrainParityWatch({ db, config, notifier, logger, brainRuntime });

  // A provider-accepted message whose history transaction failed is repaired
  // from its bearer-free intent. A process interruption during the provider
  // boundary is quarantined as ambiguous and is never retried automatically.
  queueMicrotask(() => {
    try {
      const recovered = db.recoverAcceptedOperatorOutboundAttempts?.(100);
      const ambiguous = db.quarantineInterruptedOperatorOutboundAttempts?.() || 0;
      if (recovered?.failed || ambiguous) logger.warn?.(`operator outbound recovery: recovered=${recovered?.recovered || 0} failed=${recovered?.failed || 0} ambiguous=${ambiguous}`);
    } catch { /* durable rows remain for the next boot */ }
  });
  // เทิร์นค้างจากโปรเซสก่อน — ปักธงให้คนรู้ ไม่มีการส่งข้อความใด ๆ ทั้งสิ้น
  // แบบแผนเดียวกับ quarantineInterruptedOperatorOutboundAttempts ด้านบน:
  // ของกำกวมส่งต่อให้คนตัดสิน ไม่ให้ระบบเดา — และ "ห้ามส่งซ้ำ" จึงเป็นคุณสมบัติ
  // เชิงโครงสร้าง ไม่ใช่กติกาที่ต้องระวัง (บล็อกนี้ทำได้แค่ UPDATE + ปักธง + audit + push)
  queueMicrotask(() => {
    try {
      let answeredLate = 0;
      let stranded = 0;
      let escalated = 0;
      let skippedLiveOwner = 0;
      // เทิร์นที่ "ยังสด" ของโปรเซสที่ยังหายใจอยู่ = งานที่เขากำลังตอบจริง ห้ามแตะ
      // เกินหน้าต่างนี้ถือว่าถูกทิ้งค้างแน่นอน (เทิร์นจริงไม่มีทางเปิดค้างนานกว่างบเวลาปิดระบบ)
      // เผื่อกรณี pid ถูกใช้ซ้ำโดยโปรเซสอื่นที่ไม่เกี่ยวกันด้วย
      const liveOwnerGraceMs = (Number(config.shutdownHardExitMs) || 25_000) + 60_000;
      for (const turn of db.listPreviousProcessOpenTurns?.(processId, 200) || []) {
        // 0) เจ้าของแถวยังทำงานอยู่จริง (เครื่องเดียวกัน pid ยังมีชีวิต) และแถวยังสด
        //    -> เขากำลังคิด/กำลังส่งอยู่ ถ้าเราปักธงตอนนี้ แอดมินจะไปตอบซ้ำทับคำตอบเขา
        if (Date.now() - Number(turn.updated_at || turn.created_at) <= liveOwnerGraceMs
            && ownerStillRunning(turn.process_id)) {
          skippedLiveOwner += 1;
          continue;
        }
        // 1) ส่งสำเร็จแล้วตายก่อน UPDATE จะ commit -> ปิดเงียบ ห้ามปลุกใคร
        if (db.hasReactiveOutboundSince(turn.customer_id, turn.created_at)) {
          db.closeInboundTurn(turn.message_id, { status: "answered", reason: "late_outbound" });
          answeredLate += 1;
          continue;
        }
        const status = turn.status === "sending" ? "stranded_ambiguous" : "stranded_crash";
        db.closeInboundTurn(turn.message_id, { status, reason: "process_died" });
        stranded += 1;

        // 2) ปลุกคนเฉพาะแถวที่ยังสด และห้องที่ AI ยังเปิดอยู่
        //    ห้องที่ปิด AI อยู่แล้ว (money_line/bank_sent/ป้ายลูกค้า/fb_legacy) เป็นของคนจริงอยู่แล้ว
        //    บันทึกไว้เฉย ๆ ไม่ต้องส่งเสียง — กันเสียงรบกวนที่ทำให้คนเลิกสนใจธง
        const age = Date.now() - Number(turn.created_at);
        const flagged = age <= config.strandedEscalateWithinMs
          && flagNeedsHumanForTurn(db, turn.customer_id, {
            reason: status, message: strandedHandoffMessage(status), logger,
          });
        if (flagged) {
          db.addAudit({
            operator: "system", action: `inbound_turn_${status}`,
            target: turn.customer_id, detail: "เทิร์นค้างจากโปรเซสที่ตายไปแล้ว",
          });
          try {
            webPush?.fireLater?.({
              customerId: turn.customer_id, channelId: turn.channel_id, reason: status, force: true,
            });
          } catch { /* แจ้งเตือนล้มไม่กระทบธงที่ปักไว้แล้ว */ }
          escalated += 1;
        }
      }
      if (stranded || answeredLate || skippedLiveOwner) {
        logger.warn?.(`[chassis] boot: เทิร์นค้าง ${stranded} (ปลุกคน ${escalated}), ปิดเพราะมีคำตอบตามมาแล้ว ${answeredLate}, ข้ามเพราะเจ้าของยังทำงานอยู่ ${skippedLiveOwner}`);
      }
      // ผู้อ่านของ strandedTurns(): สรุปให้เห็นใน journalctl ทุกครั้งที่ deploy ว่า 24 ชม.
      // ที่ผ่านมามีเทิร์นตกค้างกี่ก้อน — รวมก้อนที่ถูกปิดตอน hard exit ซึ่งตัวกวาดไม่เห็นแล้ว
      // (แถวพวกนั้นปักธง NEEDS_HUMAN ไว้ตั้งแต่ตอนปิดระบบ ตัวเลขนี้เป็นภาพรวมให้คนดูแล)
      try {
        const recent = db.strandedTurns?.({ sinceMs: Date.now() - 24 * 60 * 60_000, limit: 500 }) || [];
        if (recent.length) logger.warn?.(`[chassis] boot: 24 ชม.ที่ผ่านมามีเทิร์นตกค้างรวม ${recent.length} ก้อน`);
      } catch { /* สรุปไม่ได้ก็ไม่กระทบธงที่ปักไว้แล้ว */ }
    } catch { /* แถวถาวรยังอยู่ boot ครั้งหน้าเก็บได้ */ }
  });
  // Retry crash-surviving erasures promptly at boot instead of waiting for the
  // first retention interval. This performs no provider/customer action.
  if (config.messageMediaEnabled && privateMedia.enabled()) {
    const reconcileAndDrain = async () => {
      await reconcileMessageMediaOrphans({ db, privateMedia, beforeMs: Date.now() - 60 * 60_000, logger });
      try { drainPrivateMedia(); } catch { /* durable queue retries later */ }
    };
    queueMicrotask(() => {
      reconcileAndDrain().catch(() => { /* next boot/retention retries */ });
    });
    // audit 2026-08-25: เดิมเป็น setTimeout ครั้งเดียว — ไบต์ที่กำพร้าหลัง 65 นาทีแรก
    // ค้างบนดิสก์จนกว่าจะ restart ครั้งถัดไป เปลี่ยนเป็นรอบซ้ำที่คาบเดิม
    const orphanGraceTimer = setInterval(() => {
      reconcileAndDrain().catch(() => { /* next tick/boot retries */ });
    }, 65 * 60_000);
    orphanGraceTimer.unref?.();
  }

  // audit 2026-08-25: การส่งแจ้งเตือนที่ล้มเหลว (502/503/หมดเวลา) ไม่มีอะไรลองใหม่ให้
  // ลูกค้าที่ทักตอนดึกแล้วบังเอิญเจอผู้ให้บริการสะดุดครั้งเดียว จะเงียบจนกว่าจะมีคนอื่นทัก
  // ตัวกวาดนี้ปลุกซ้ำเฉพาะเครื่องที่ยังไม่เคยส่งสำเร็จหลังข้อความที่เก่าที่สุดที่ยังไม่มีคนตอบ
  // ไม่มีคนรอ = ไม่ทำอะไร จึงไม่กินอะไรเลยในวันปกติ
  if (webPush?.sweep) {
    const pushSweepTimer = setInterval(() => {
      webPush.sweep().catch(() => { /* next tick retries */ });
    }, WEB_PUSH_SWEEP_MS);
    pushSweepTimer.unref?.();
  }

  // G7.1: Owner Daily Digest — สรุปหน้าร้าน push ถึงเจ้าของทาง LINE (แบบแผน canary)
  // fail-closed: ไม่มี DIGEST_LINE_USER_ID = ไม่ arm; สวิตช์ runtime เช็คสดทุก tick
  const digest = overrides.digest ?? createDigest({ config, db, lineRegistry, fx, brainParity, logger });
  // 29 ก.ย. 2026 (คำสั่งพี่ง้วง): push แจ้งทีม "ลูกค้าร้อนรอทีมทักต่อ" 09:10 / 13:10 / 18:10 (สวิตช์ hot_followup_push_mode)
  const hotFollowupPush = overrides.hotFollowupPush ?? createHotFollowupPush({ config, db, lineRegistry, logger });
  // 5 ต.ค. 2026 (คำสั่งพี่ง้วง "ทุกชั่วโมง (เวลาทำการ) ให้มี AI อีกตัวคอยกวาดแชทของวันนั้น"): ตัวกวาดคัดกรอง
  // สวิตช์ qualify_sweep_mode เช็คสดทุกนาที — ไม่มีแถว = off = ไม่เรียกโมเดล ไม่แตะห้องใด (ร้านอื่นไม่เห็นอะไรเปลี่ยน)
  // เปิดเขียวแล้วข้อความค้าง = ส่งเข้าเส้นตอบเดิม (ห้อง Facebook ต้องยังอยู่ในหน้าต่าง 24 ชม.)
  const qualifySweep = overrides.qualifySweep ?? createQualifySweep({
    config, db, hermes, pipeline, burst, logger, isDraining, fx,
    now: overrides.now || Date.now,
    answerPending: createQualifyAnswerPending({ db, pipeline, notifier, logger, now: overrides.now || Date.now }),
  });
  // 12 ต.ค. 2026 ค่ำ: รอบตรวจของพี่ง้วง 09:00/12:00/15:00/19:00 — เสนอห้องที่ท่าทีไม่พาไปสู่การเรียน ให้พี่ง้วง/ชมพู่ยืนยัน
  // สวิตช์ owner_review_mode ไม่มีแถว = on (ปลุกมือถือเจ้าของคนเดียวเมื่อมีข้อเสนอใหม่) · รอตัวกวาดคัดกรองเดินจบก่อนทุกห้อง
  ownerReviewScheduler = overrides.ownerReviewScheduler !== undefined
    ? overrides.ownerReviewScheduler
    : (offtopicCloser ? createOwnerReviewScheduler({
      config, db, closer: offtopicCloser, hermes, webPush, closeService: ownerCloseService, logger, isDraining, fx,
      now: overrides.now || Date.now,
      sweepBusy: () => { try { return qualifySweep?.stats?.()?.inFlight === true; } catch { return false; } },
    }) : null);

  // canary probe = ยิงข้อความสังเคราะห์ผ่าน pipeline เต็มเส้น แล้วเช็คว่า reply ออกถึง LINE จริง
  // arm เฉพาะเมื่อเปิด CANARY_INTERVAL_MS (หรือเทสต์ inject probe เอง) — fail-closed
  const canaryProbe =
    overrides.canaryProbe ??
    (config.canaryIntervalMs > 0
      ? async () => {
          const result = await pipeline.handleInboundText({
            customerId: config.canaryUserId,
            text: `[canary] ping ${new Date().toISOString()}`,
            replyToken: "",
          });
          return result?.sent === true;
        }
      : null);
  const canary = createCanary({
    db,
    probeFn: canaryProbe,
    intervalMs: config.canaryIntervalMs,
    timeoutMs: config.canaryTimeoutMs,
    alertWebhookUrl: config.canaryAlertWebhookUrl,
    fetchImpl: overrides.canaryFetch,
    logger,
  });

  /* ------------------------------ LINE webhook ----------------------------- */

  // W3: เส้นทางเดียว POST /webhooks/line รับได้ทุก channel — ลำดับ verify:
  // 1. อ่าน destination (bot user id) จาก body แบบ "ยังไม่เชื่อ" เพื่อเลือก secret
  //    ที่เคย map ไว้ก่อน (JSON.parse ล้วน ๆ ไม่มี side effect — ไม่ใช่การเชื่อม body)
  // 2. verify HMAC จาก raw ด้วย secret ของ channel นั้น — ผ่านคือจบ
  // 3. ไม่ผ่าน/ไม่เคย map = ไล่ลอง secret ของทุก active channel (จำนวน channel น้อย)
  // 4. persist mapping destination -> channel only after an accepted event
  // event ทุกตัวถูก tag ด้วย channel ที่ verify แล้วเท่านั้น
  // 28 ก.ย. 2026: สถานะเพื่อนจาก webhook follow/unfollow — ที่เดียวที่เขียน (ตัดคนบล็อก + ทริกเกอร์ข้อความตามขั้น)
  function noteFollowEvent({ channelId, customerId, followed, unblocked, at }) {
    db.recordLineFollow({ customerId, channelId, followed, unblocked, at });
    stepMessages?.onFollowEvent({ channelId, customerId, followed, unblocked, at });
    if (followed) identityHints.noteNewLineContact({ channelId, customerId, at, source: "follow" });
  }

  async function handleLineWebhook(req, res) {
    let raw;
    try {
      raw = await readBody(req, 2_000_000, {
        timeoutMs: config.lineWebhookBodyTimeoutMs,
        destroyOnOverflow: true,
      });
    } catch (err) {
      const message = String(err.message || err);
      return json(res, message.includes("นานเกินกำหนด") ? 408 : 413, { ok: false, error: message });
    }

    // fail-closed: ไม่มี channel ไหนมี secret = ไม่รับ webhook เลย
    if (lineWebhookDegraded) {
      return json(res, 503, { ok: false, error: "LINE_CHANNEL_SECRET / CHANNELS_FILE ยังไม่ได้ตั้งค่า" });
    }

    const signature = req.headers["x-line-signature"];
    let destination = null;
    try {
      const peeked = JSON.parse(raw.toString("utf8"));
      if (typeof peeked?.destination === "string" && peeked.destination) destination = peeked.destination;
    } catch {
      // body ไม่ใช่ JSON — เดี๋ยว verify แบบไล่ลองแล้วตอบ 400 ด้านล่างตามเดิม
    }

    let channel = null;
    if (destination) {
      try {
        const mappedId = db.getSetting(`line_dest:${destination}`);
        const mapped = mappedId && activeChannels.find((ch) => ch.id === mappedId);
        if (mapped && verifyLineSignature(raw, signature, mapped.channelSecret)) channel = mapped;
      } catch {
        channel = null; // mapping อ่านไม่ได้ — ตกไปไล่ลองทุก channel
      }
    }
    if (!channel) {
      channel = activeChannels.find((ch) => verifyLineSignature(raw, signature, ch.channelSecret)) ?? null;
    }
    if (!channel) {
      return json(res, 403, { ok: false, error: "signature ไม่ถูกต้อง" });
    }
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, { ok: false, error: "body ไม่ใช่ JSON" });
    }
    const events = Array.isArray(body?.events) ? body.events : [];

    let accepted = 0;
    try {
      for (const event of events) {
        // Pilot gate precedes dedupe/customer/message writes. Unenrolled users
        // still receive a 200 from LINE, but leave no ordinary customer trace.
        const pilot = pilotGate.authorizeInbound({ channelId: channel.id, event });
        if (!pilot.allowed) continue;
        // dedupe ด้วย message.id (fallback webhookEventId สำหรับ event ไม่มี message)
        const dedupeKey = event?.message?.id || event?.webhookEventId;
        if (!dedupeKey) continue;
        // Training control runs after pilot authorization but before ordinary
        // dedupe. Its DB method commits event dedupe and session rotation as a
        // single transaction, so a rollback still permits LINE redelivery.
        const userId = event?.source?.userId;
        const message = event?.message || {};
        // LINE unsend has no customer text. Queue erasure and revoke grants in
        // one DB transaction, then drain private bytes idempotently. A crash or
        // filesystem error leaves a durable retry row, never an orphaned grant.
        if (event?.type === "unsend" && event?.unsend?.messageId) {
          const unsentId = String(event.unsend.messageId);
          db.queueProviderMessageMediaDeletion(unsentId, "line_unsend");
          const cleanup = drainPrivateMedia();
          if (cleanup.failed) {
            logger.warn?.("webhook unsend: private media deletion deferred");
          }
          // Mark dedupe only after the durable queue transaction. Repeating the
          // queue step after a crash is safe; skipping an unqueued erasure is not.
          if (!db.markDedupe(String(dedupeKey))) continue;
          accepted += 1;
          continue;
        }
        const trainingCommandsAllowed = trainingCommandChannels.has(channel.id);
        const resetCommand = trainingCommandsAllowed && userId && event.type === "message" && message.type === "text"
          ? parseTrainingResetCommand(message.text)
          : { isReset: false, feedback: "" };
        if (resetCommand.isReset && !aiPausedNow({ db, config })) {
          const customerId = customerKey(channel.id, userId);
          // Enqueue in literal webhook order and await through provider outcome
          // before 200. Rotation itself stays behind any old in-flight send.
          const rotationRun = enqueueTrainingReset({
            customerId, channelId: channel.id, event, dedupeKey: String(dedupeKey),
            feedback: resetCommand.feedback,
          });
          // ตอบ LINE ให้ทันงบเวลา แล้วปล่อยงานที่เหลือทำต่อในคิวเดิม (idempotent ด้วย
          // reset_event_id) — ของเดิมรอจนจบเสมอ จึงค้างเท่าหน้าต่าง burst ทุกครั้ง
          await waitBounded(rotationRun, TRAINING_BARRIER_TIMEOUT_MS, {
            onTimeout: () => logger.warn?.("training reset: ตอบ webhook ก่อนหมุน session เสร็จ (งานยังเดินต่อในคิว)"),
            onLateFailure: (error) => logger.warn?.(`training reset: หมุน session ล้มหลังตอบ webhook ไปแล้ว (${error?.message || error}) — ผู้ทดสอบต้องส่ง /reset ใหม่`),
          });
          continue;
        }

        // v1.2.6 (คำสั่งพี่ง้วง): ผู้ทดสอบส่ง /fb ระหว่างรอบได้ โดยไม่ต้องตัดบทสนทนา
        // — เก็บผูกกับ session ที่กำลังคุยอยู่ ไม่ผ่าน AI และไม่กระทบสถานะใด ๆ
        const feedbackCommand = trainingCommandsAllowed && userId && event.type === "message" && message.type === "text"
          ? parseTrainingFeedbackCommand(message.text)
          : { isFeedback: false, feedback: "" };
        if (feedbackCommand.isFeedback && !aiPausedNow({ db, config })) {
          const customerId = customerKey(channel.id, userId);
          // ตรวจอิสระ 2026-08-13: เส้นทางนี้เคยเป็นทางเดียวใน webhook ที่ไม่ผ่าน dedupe
          // LINE ส่งซ้ำเมื่อไหร่ = ความเห็นถูกบันทึกซ้ำและผู้ทดสอบได้ข้อความตอบกลับสองรอบ
          if (!db.markDedupe(String(dedupeKey))) continue;
          let saved = null;
          let writeFailed = false;
          try {
            saved = db.addTrainingFeedback({
              customerId, content: feedbackCommand.feedback, channelId: channel.id,
            });
            // ข้อความมีจริงแต่บันทึกไม่ได้ = ความล้มเหลว ไม่ใช่ "ผู้ใช้พิมพ์ไม่ครบ"
            writeFailed = Boolean(feedbackCommand.feedback) && !saved;
          } catch (error) {
            writeFailed = true;
            logger.warn?.(`training feedback: บันทึกไม่สำเร็จ (${error?.message || error})`);
          }
          if (writeFailed) {
            // เจ้าของต้องตามย้อนได้ว่าความเห็นหายตอนไหน ไม่ใช่มีแค่บรรทัด log ที่ไม่มีใครอ่าน
            try {
              db.addAudit({
                operator: "system", action: "training_feedback_write_failed",
                target: String(customerId), detail: "feedback ของผู้ทดสอบบันทึกไม่สำเร็จ",
              });
            } catch { /* audit ล้มด้วยก็ยังต้องตอบผู้ทดสอบตามจริง */ }
          }
          const ackText = saved
            ? TRAINING_FEEDBACK_ACK
            : (writeFailed ? TRAINING_FEEDBACK_FAILED_ACK : TRAINING_FEEDBACK_EMPTY_ACK);
          await lineRegistry.forChannel(channel.id).sendBubbles({
            to: userId,
            replyToken: event?.replyToken || "",
            bubbles: [{ text: ackText }],
            images: [],
            purpose: SEND_PURPOSE.other, // ตอบรับโหมดเทรน (ผู้ทดสอบ ไม่ใช่ลูกค้า)
          });
          continue;
        }

        // A reset from another concurrent webhook may already own the queue.
        // Wait for its rotation+ack before assigning this inbound to a session.
        if (userId && event.type === "message") {
          const custKey = customerKey(channel.id, userId);
          const barrier = pendingTrainingResets.get(String(custKey));
          // ตรวจอิสระ 2026-08-13: การรอแบบไม่มีเพดานทำให้ webhook ค้างได้ถึง 20 วินาที
          // (เท่าหน้าต่าง burst) ซึ่งเกินงบ ~1 วินาทีของ LINE — ข้อความลูกค้าที่ยังไม่ถูก
          // เขียนลง DB ระหว่างนั้นจะหายถาวรถ้าโปรเซสตายพอดี. รอเท่าที่คุ้ม แล้วเดินต่อ
          // (การหมุน session เป็น idempotent อยู่แล้ว งานที่ค้างจึงทำต่อได้อย่างปลอดภัย)
          if (barrier) {
            await waitBounded(barrier, TRAINING_BARRIER_TIMEOUT_MS, {
              onTimeout: () => logger.warn?.(`training reset barrier: รอเกิน ${TRAINING_BARRIER_TIMEOUT_MS}ms — เขียนข้อความลูกค้าลง DB ก่อนเพื่อไม่ให้หาย`),
            }).catch(() => { /* การหมุน session ล้ม = ข้อความนี้ยังต้องถูกรับไว้ตามปกติ */ });
          }
        }

        // log inbound ก่อนถึง AI gate เสมอ (บทเรียน Fern: ประวัติต้องครบแม้ AI ปิด)
        // W3: customer key ต่อสาขา — ลูกค้าคนเดียวทัก 2 OA = 2 แถว (ดู channels.mjs)
        if (userId && event.type === "message") {
          const custKey = customerKey(channel.id, userId);
          const existing = db.getCustomer(custKey);
          const message = event.message || {};
          const metadata = message.type === "text" && Array.isArray(message.emojis)
            ? { emojis: message.emojis.slice(0, 100).map((emoji) => ({ index: Number(emoji.index) || 0, length: Number(emoji.length) || 0, productId: String(emoji.productId || "").slice(0, 64), emojiId: String(emoji.emojiId || "").slice(0, 64) })) }
            : {};
          let attachment = null;
          let shouldIngest = false;
          if (message.type !== "text") {
            const type = ["image", "file", "sticker", "audio", "video"].includes(message.type) ? message.type : "unknown";
            const providerMeta = type === "sticker"
              ? {
                  packageId: String(message.packageId || "").slice(0, 32),
                  stickerId: String(message.stickerId || "").slice(0, 32),
                  stickerResourceType: String(message.stickerResourceType || "").slice(0, 48),
                  keywords: Array.isArray(message.keywords)
                    ? message.keywords.map((value) => String(value || "").trim().slice(0, 80)).filter(Boolean).slice(0, 15)
                    : [],
                  text: String(message.text || "").slice(0, 200),
                }
              : { contentProvider: String(message.contentProvider?.type || "").slice(0, 24), fileName: String(message.fileName || "").slice(0, 255), fileSize: Number(message.fileSize) || null };
            attachment = {
              source: "line", kind: type,
              status: type === "sticker" || !["image", "file", "audio", "video"].includes(type) || message.contentProvider?.type !== "line" ? "unavailable" : (config.messageMediaEnabled && config.inboundLineContentCapture ? "queued" : "unavailable"),
              originalName: String(message.fileName || ""), byteSize: Number(message.fileSize) || null,
              providerMessageId: String(message.id || ""), providerMeta,
              unavailableReason: type === "sticker" ? "LINE ไม่ให้ดาวน์โหลดภาพสติกเกอร์ผ่าน content API" : (!['image','file','audio','video'].includes(type) ? "ชนิดสื่อนี้ยังไม่รองรับ" : (message.contentProvider?.type !== "line" ? "external provider content is not fetched" : (config.messageMediaEnabled && config.inboundLineContentCapture ? "รอดาวน์โหลดจาก LINE" : "ยังไม่ได้เปิดเก็บไฟล์จาก LINE"))),
            };
            shouldIngest = type !== "sticker" && config.messageMediaEnabled && config.inboundLineContentCapture && privateMedia.enabled() && message.contentProvider?.type === "line";
          }

          // Dedupe, customer, message and optional attachment are a single DB
          // commit. Any failure rolls dedupe back so LINE redelivery can retry.
          const persisted = db.persistLineInbound({
            dedupeKey: String(dedupeKey),
            customerId: custKey,
            channelId: channel.id,
            msgType: message.type || "unknown",
            content: message.type === "text" ? message.text || "" : `[${message.type}]`,
            metadata,
            attachment,
            mediaMaxCount: config.messageMediaMaxActive,
            mediaMaxBytes: config.messageMediaTotalBytes,
            // หนี้คำตอบต้อง commit พร้อมข้อความเสมอ — เฉพาะ event ที่จะเดินต่อเข้า pipeline
            owesReply: true,
            channelKind: "line",
            processId,
          });
          if (!persisted.stored) {
            // ซ้ำ = งานถูกจดไปแล้วรอบก่อน (เช่นเราตายหลัง COMMIT ก่อนเขียน 200 ลง socket)
            // ต้องนับว่าสำเร็จ ไม่งั้น destination mapping ไม่ถูกเขียนและ provider เห็นเป็นความล้มเหลว
            if (persisted.reason === "duplicate") accepted += 1;
            continue;
          }
          if (persisted.attachmentSkipped) logger.warn?.("webhook media: attachment inventory cap reached; binary capture skipped");
          // B-12: operator self-test destination can bind only from this signed,
          // durably persisted inbound text. The DB compares a one-time hash;
          // never log the raw LINE id or challenge text here.
          let selfTestMatched = false;
          if (message.type === "text") {
            try {
              const selfTest = db.consumeBroadcastSelfTestChallenge({
                channelId: channel.id,
                lineUserId: userId,
                text: message.text || "",
              });
              if (selfTest.matched) {
                selfTestMatched = true;
                db.addAudit({
                  operator: selfTest.operatorUsername,
                  action: "broadcast_self_test_destination_verified",
                  target: channel.id,
                  detail: "ยืนยันปลายทางส่งทดสอบจาก LINE OA แล้ว",
                });
              }
            } catch {
              // Regular inbound persistence must retain its normal behavior even
              // if this optional control-plane state cannot be updated.
              logger.warn?.("broadcast self-test: ยืนยันปลายทางไม่สำเร็จ");
            }
          }
          // A challenge is a Console control message, not customer intent. It is
          // retained durably for traceability but must never reach the AI reply
          // pipeline or create a Web Push notification. The only outbound action
          // remains the later, separately confirmed one-recipient self-test.
          if (selfTestMatched) {
            try {
              db.closeInboundTurn(persisted.messageId, { status: "silent_by_design", reason: "broadcast_self_test" });
            } catch { /* บัญชีผลลัพธ์เป็นของแถม — ห้ามทำให้การรับ event ล้ม */ }
            accepted += 1;
            continue;
          }
          // ระบบกำลังปิด — รับข้อความไว้ให้ครบและมองเห็นได้ในคอนโซล แต่ไม่เริ่มคิด
          // เพราะงบเวลาที่เหลือไม่พอ และงานที่เริ่มไม่ทันจะถูก abort อยู่ดี
          // แบบนี้ผลลัพธ์แน่นอนกว่าเสี่ยงคิดครึ่งทางแล้วตาย
          if (draining) {
            try {
              db.closeInboundTurn(persisted.messageId, { status: "stranded_shutdown", reason: "arrived_during_drain" });
            } catch (err) {
              logger.warn?.(`webhook: จดสถานะข้อความช่วงปิดระบบไม่สำเร็จ (${err?.message || err})`);
            }
            // กติกาเดียวกับตัวกวาดตอนบูต: ห้องที่ปิด AI อยู่แล้วเป็นของคนจริงอยู่แล้ว
            // และห้ามปักธงซ้ำทุกข้อความจน handoff_summary ของจริงถูกดันตกขอบ
            flagNeedsHumanForTurn(db, custKey, {
              reason: "drain_interrupted",
              message: "ข้อความเข้ามาตอนระบบกำลังปิด — บอทไม่ได้ตอบ ต้องมีคนรับต่อ",
              skipIfFlagged: true, logger,
            });
            accepted += 1;
            try { webPush.fireLater({ customerId: custKey, channelId: channel.id, reason: "inbound" }); }
            catch (err) { logger.warn?.(`webhook: แจ้งเตือนไม่สำเร็จ (${err?.message || err})`); }
            continue;
          }
          // หลัง COMMIT แล้ว — จุดนี้ย้อนไม่ได้อีก แถว dedupe อยู่ในฐานแล้ว
          // การโยน error ขึ้นไปให้ outer catch ตอบ 500 = LINE ส่งซ้ำมาแล้วถูก dedupe ทิ้ง
          // = ข้อความหายถาวร ทั้งที่โปรเซสยังไม่ตายด้วยซ้ำ (บั๊กเดิม server.mjs:813)
          try {
            if (persisted.attachmentStored && shouldIngest) queueMicrotask(runMediaIngest);
          } catch (err) {
            logger.warn?.(`webhook: ตั้งคิวดูดสื่อไม่สำเร็จ (${err?.message || err}) — ตัวกวาดรอบถัดไปเก็บให้`);
          }
          let sessionId = null;
          try {
            sessionId = db.activeConversationSession(custKey)?.id || null;
          } catch (err) {
            logger.warn?.(`webhook: อ่าน session ไม่สำเร็จ (${err?.message || err}) — เดินต่อด้วย session ว่าง`);
          }
          // F1: ลูกค้าใหม่/ยังไม่มี display_name -> ดึงโปรไฟล์ LINE แบบ fire-and-forget
          // ล้มเหลว = ใช้ fallback "ลูกค้า <ท้าย id>" เดิม — ห้าม block/ห้ามล้ม pipeline
          // (โปรไฟล์ต้องดึงด้วย token ของสาขาที่ event นี้เข้ามา)
          if (!existing?.display_name) {
            queueMicrotask(() => {
              lineRegistry.forChannel(channel.id).getProfile({ userId })
                .then((profile) => {
                  if (profile) db.setProfile(custKey, profile);
                })
                .catch(() => {});
            });
          }
          // 28 ก.ย. 2026: รหัสเชื่อมแชทจาก Facebook (identityLink.mjs) — ไม่มีรหัส = เส้นเดิมทุกไบต์
          // เจอรหัส = เชื่อม/ปฏิเสธที่นี่ แล้ว (ก) จบเทิร์นเลยถ้ามีแค่ข้อความสำเร็จรูป หรือ (ข) ส่งส่วนที่เหลือ
          // ให้ลูกแพรแบบตัดรหัสออก — ลูกแพรไม่เคยเห็นรหัส (รหัสไม่ใช่คำสั่งถึง AI)
          let pipelineEvent = event;
          // แชท 1:1 เท่านั้น — รหัสที่โพสต์ในกลุ่ม/ห้องรวมไม่ใช่การยืนยันตัวตนของห้องแชทส่วนตัว (และตอบรับจะไปโผล่ในกลุ่ม)
          const oneToOne = !event?.source?.type || event.source.type === "user";
          if (message.type === "text" && oneToOne) {
            let linkTurn = { matched: false };
            try {
              linkTurn = identityLink.handleLineText({
                channelId: channel.id, customerId: custKey, text: message.text || "",
                messageId: persisted.messageId, replyToken: event?.replyToken || "",
              });
            } catch (err) {
              logger.warn?.(`webhook: ตรวจรหัสเชื่อมแชทไม่สำเร็จ (${err?.message || err}) — เดินเส้นปกติ`);
            }
            if (linkTurn.matched && linkTurn.done) {
              accepted += 1;
              try { webPush.fireLater({ customerId: custKey, channelId: channel.id, reason: "inbound" }); }
              catch (err) { logger.warn?.(`webhook: แจ้งเตือนไม่สำเร็จ (${err?.message || err})`); }
              continue;
            }
            if (linkTurn.matched) pipelineEvent = { ...event, message: { ...message, text: linkTurn.text || "" } };
            // ทักไลน์ครั้งแรกโดยไม่มีรหัส (เพื่อนเก่าที่ไม่เกิด follow ก็นับ) → ดูว่ามีลิงก์เชิญจาก Facebook ค้างอยู่ช่วงนี้ไหม
            if (!linkTurn.matched) {
              try {
                if (db.countMessagesFor(custKey) === 1) identityHints.noteNewLineContact({ channelId: channel.id, customerId: custKey, source: "first_message" });
              } catch (err) {
                logger.warn?.(`webhook: ตรวจคู่ห้องจากเวลาไม่สำเร็จ (${err?.message || err})`);
              }
            }
          }
          accepted += 1;
          try {
            webPush.fireLater({ customerId: custKey, channelId: channel.id, reason: "inbound" });
          } catch (err) {
            logger.warn?.(`webhook: แจ้งเตือนไม่สำเร็จ (${err?.message || err}) — ข้อความยังถูกรับไว้ครบ`);
          }
          // 28 ก.ย. 2026: ข้อความตามขั้น — ลูกค้าตอบ = หยุดลำดับที่เลือกไว้ · พิมพ์ #คีย์เวิร์ด = เข้าลำดับ (พังห้ามล้ม webhook)
          try {
            stepMessages?.onInboundMessage({
              channelId: channel.id, customerId: custKey, text: message.type === "text" ? String(message.text || "") : "", at: stepClock(),
            });
          } catch (err) {
            logger.warn?.(`webhook: ข้อความตามขั้นรับข้อความไม่สำเร็จ (${err?.message || err})`);
          }
          // handleInboundText reserves the shared per-customer queue before it
          // awaits burst debounce, so a following /reset cannot overtake it.
          // fire-and-settle: คำตัดสินของ pipeline ต้องกลายเป็นข้อเท็จจริงบนดิสก์เสมอ
          pipeline.handleEvent(pipelineEvent, {
            channelId: channel.id, expectedSessionId: sessionId, turnId: persisted.messageId,
          })
            .then((verdict) => stampInboundOutcome(db, persisted.messageId, verdict, logger))
            .catch((err) => {
              logger.error?.(`pipeline: ${err?.message || err}`);
              stampInboundOutcome(db, persisted.messageId, { error: err }, logger);
            });
        } else {
          // Non-message events have no chat/attachment persistence boundary.
          if (!db.markDedupe(String(dedupeKey))) continue;
          // 28 ก.ย. 2026: เพิ่มเพื่อน/บล็อก (webhook ที่ตรวจลายเซ็นแล้ว) → สถานะเพื่อนล่าสุด
          // ใช้ตัดคนที่บล็อกออกจากบรอดแคสต์ + ทริกเกอร์ "เพิ่มเพื่อน" ของข้อความตามขั้น · พังห้ามล้ม webhook
          if (userId && (event.type === "follow" || event.type === "unfollow")) {
            try {
              noteFollowEvent({
                channelId: channel.id, customerId: customerKey(channel.id, userId),
                followed: event.type === "follow", unblocked: event?.follow?.isUnblocked === true,
                at: Number(event.timestamp) > 0 ? Math.min(Number(event.timestamp), stepClock()) : stepClock(),
              });
            } catch (err) {
              logger.warn?.(`webhook: บันทึกสถานะเพื่อนไม่สำเร็จ (${err?.message || err})`);
            }
          }
        }
      }
    } catch (err) {
      // DB เขียนไม่ได้ = ตอบ 500 ให้ LINE ส่งซ้ำ (ห้ามกลืนเงียบ)
      logger.error?.(`webhook: DB ล้มเหลว (${err?.message || err})`);
      return json(res, 500, { ok: false, error: "บันทึกข้อมูลไม่สำเร็จ" });
    }

    // A valid signature alone must not persist a destination mapping: a
    // blocked-first pilot event leaves no customer-facing trace.  Map only
    // after at least one event has passed the pilot gate and been accepted.
    if (destination && accepted > 0) {
      try {
        if (db.getSetting(`line_dest:${destination}`) !== channel.id) {
          db.setSetting(`line_dest:${destination}`, channel.id);
        }
      } catch (err) {
        logger.debug?.(`webhook: บันทึก destination mapping ไม่สำเร็จ (${err?.message || err})`);
      }
    }

    // Ordinary traffic remains 200-fast after durable inbound persistence.
    // A webhook containing /reset reaches here only after rotation + ACK finish.
    json(res, 200, { ok: true, received: events.length, accepted });
  }

  /* --------------------------------- health -------------------------------- */

  async function handleHealth(res) {
    let dbOk = false;
    try {
      dbOk = db.ping();
    } catch {
      dbOk = false;
    }
    // สถานะ canary ล่าสุด — บอทเงียบต้องเห็นได้จาก /health ข้ามเครื่อง
    let canaryState = null;
    try {
      canaryState = db.getCanary("line-webhook");
    } catch {
      canaryState = null;
    }
    let hermesOk = !config.degraded.hermes;
    let hermesReason = null;
    if (hermesOk && config.hermesHealthPath) {
      try {
        const healthFetch = overrides.hermesHealthFetch ?? globalThis.fetch;
        const response = await healthFetch(`${config.hermesBase.replace(/\/+$/, "")}${config.hermesHealthPath}`, {
          method: "GET",
          headers: config.hermesApiKey ? { authorization: `Bearer ${config.hermesApiKey}` } : {},
          redirect: "error",
          signal: AbortSignal.timeout(750),
        });
        const declared = Number(response?.headers?.get?.("content-length"));
        if (!response?.ok || (Number.isFinite(declared) && declared > 16 * 1024)) {
          hermesOk = false;
        } else {
          const body = await response.json();
          hermesOk = body?.ok === true
            && body?.providerModelsVerified === true
            && body?.providerInferenceReady === true
            && [config.hermesModel, config.hermesScorerModel, config.hermesScorerFallbackModel]
              .filter(Boolean).every(model => body?.modelReadiness?.[model] === true);
          if (!hermesOk) hermesReason = hermesDegradedReason(body);
        }
      } catch {
        hermesOk = false;
      }
    }
    const healthy = dbOk && hermesOk;
    // Use the digest's own state model. This prevents /health from claiming
    // deterministic mode while a model-assisted digest has explicitly been
    // configured, and keeps the response safe if the DB is already down.
    const learningStatus = typeof learning.healthSnapshot === "function"
      ? learning.healthSnapshot()
      : {
          enabled: learningDigestGlobalEnabled({ db, config }),
          modelEnabled: config.learningModelEnabled === true,
          configuredMode: config.learningModelEnabled === true ? "deterministic_fallback:model_unavailable" : "deterministic_fallback:model_disabled",
          mode: config.learningModelEnabled === true ? "deterministic_fallback:model_unavailable" : "deterministic_fallback:model_disabled",
          lastRunMode: null,
          lastRunStatus: null,
          armed: Number(config.learningDigestIntervalMs) > 0,
          running: false,
          intervalMs: Math.max(0, Number(config.learningDigestIntervalMs) || 0),
          lastRunAt: null,
        };
    // ตัวกวาดคัดกรองพังห้ามลาก /health ล้ม (สวิตช์ deploy ดูแค่ ok) — อ่านครั้งเดียวต่อคำขอ
    let qualifyStats = null;
    try { qualifyStats = qualifySweep.stats?.() ?? null; } catch { qualifyStats = null; }
    let blueprintStats = null;
    try { blueprintStats = blueprintSender?.stats?.() ?? null; } catch { blueprintStats = null; }
    let ownerReviewStats = null;
    try { ownerReviewStats = ownerReviewScheduler?.stats?.() ?? null; } catch { ownerReviewStats = null; }
    json(res, healthy ? 200 : 503, {
      ok: healthy,
      schemaVersion: config.schemaVersion,
      // สคริปต์ deploy ต้องเห็นว่าโปรเซสนี้กำลังปิดอยู่ (รับข้อความไว้แต่ไม่เริ่มคิดแล้ว)
      draining: isDraining(),
      // audit 2026-08-26: เวลาที่ลูกค้าคนล่าสุดทักเข้ามา — ตัวเดียวที่บอกได้ว่า
      // "ระบบยังรับข้อความอยู่จริงไหม" เพราะทุกช่องแจ้งเตือนอื่นถูกปิดหมด
      lastInboundAt: (() => {
        try { return db.lastInboundAtAny?.() ?? null; } catch { return null; }
      })(),
      components: {
        db: dbOk ? "ok" : "down",
        // W3: degraded เมื่อไม่มี channel ไหนมี secret (ครอบทั้ง env เดิมและ CHANNELS_FILE)
        lineWebhook: lineWebhookDegraded ? "degraded" : "ok",
        channels: activeChannels.length,
        dashboard: config.degraded.dashboard ? "degraded" : "ok",
        hermes: hermesOk ? "ok" : "degraded",
        // มีเฉพาะตอน degraded และรู้เหตุแน่ชัด (ตอนนี้: "provider_credit_exhausted")
        ...(hermesReason ? { hermesReason } : {}),
        console: config.degraded.console ? "degraded" : "ok",
        liveSend: config.lineLiveSend ? "live" : "off",
        canary: config.canaryIntervalMs > 0 ? "armed" : "off",
        followups: config.followupIntervalMs > 0 ? "armed" : "off",
        stagedFollowups: config.stagedFollowupTickMs > 0 ? "armed" : "off",
        retention: config.retentionEnabled ? "armed" : "off",
        digest: config.digestLineUserId ? "armed" : "off",
        learning: learningStatus.enabled && learningStatus.armed ? "armed" : "off",
        pilot: pilotGate.enabled ? (pilotGate.status().ok ? "armed" : "degraded") : "off",
        broadcastMedia: broadcastMedia.status().enabled
          ? "ready"
          : (broadcastMedia.status().configured ? "upload-off" : "off"),
        broadcastSchedule: broadcastScheduler?.healthSnapshot?.().armed ? "armed" : "off",
        webPush: webPush.status().available
          ? "ready"
          : (config.webPushEnabled ? "degraded" : "off"),
        lineInsight: lineInsight.armed() ? "armed" : "off",
        // 5 ต.ค. 2026: ตัวกวาดคัดกรอง — off/shadow/on ตามสวิตช์ (ตัวเลขรวมอยู่ที่ qualify ด้านล่าง)
        qualify: qualifyStats?.mode || "off",
        // 11 ต.ค. 2026: แคมเปญ #AIAGENT — off/pregenerate/on (ตัวเลขรวมอยู่ที่ blueprint ด้านล่าง)
        blueprint: blueprintStats?.mode || "off",
        // 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง — off/shadow/on (ตัวเลขรวมอยู่ที่ ownerReview ด้านล่าง)
        ownerReview: ownerReviewStats?.mode || "off",
      },
      // รอบตรวจล่าสุด + ข้อเสนอที่รอยืนยัน + ค่า AI วันนี้ — ตัวเลขรวมเท่านั้น ไม่มีรหัสห้อง ไม่มีเนื้อหาแชท
      ownerReview: ownerReviewStats,
      // จำนวนคำขอตามสถานะ + ค่าโมเดลวันนี้ — ไม่มีรหัสลูกค้า ไม่มีเนื้อหา
      blueprint: blueprintStats,
      // ตัวเลขรวมของวันนี้เท่านั้น (ตรวจกี่ห้อง เหลือง/เขียวกี่ห้อง ค่าใช้จ่าย) — ไม่มีรหัสห้อง ไม่มีเนื้อหาแชท
      qualify: qualifyStats,
      // M4: เวลา prune ล่าสุด (null = ยังไม่เคยเดิน) — ตารางโตผิดปกติต้องเห็นจาก /health
      retention: { enabled: config.retentionEnabled === true, lastPruneAt: retention.lastPruneAt() },
      // Phase 1a: ด่านคือ "สมองเงาตรงกับตารางจริงติดกัน N คืน" — ตัวนับต้องมองเห็นจาก
      // ข้างนอกได้ ไม่งั้นไม่มีใครรู้ว่าเดินมาถึงไหน หรือรีเซ็ตไปตั้งแต่เมื่อไร
      // parity: "none" = ปิดอยู่/ยังไม่มีเวอร์ชันสมอง · "ok" = ตรง · "drift" = ไม่ตรง
      // read (P2) = ทางอ่านของ runtime จริง ๆ: โหมด, รุ่นที่เพิ่งใช้, จำนวนครั้งที่ตกกลับ
      // ทางเดิม และหน้าต่างเฝ้าดูหลังสลับรุ่น — สามค่านี้คือสิ่งที่ผู้ดูแลต้องเห็นตอน deploy
      // สองก้อนอิสระกันโดยเจตนา: "สมองเงาตรงไหม" (parity) กับ "เทิร์นจริงอ่านจากไหน" (read)
      // ถ้าใช้ try เดียวร่วมกัน parity ที่พังจะลบสถานะ read ทิ้ง แล้วผู้ดูแลจะมองไม่เห็น
      // เลยว่าทางอ่านกำลังตกกลับทางเดิมอยู่ — ซึ่งเป็นสิ่งเดียวที่ /health มีไว้บอก
      brain: {
        ...(() => {
          try {
            const snap = brainParity.snapshot();
            return { parity: snap.parity, streakDays: snap.streakDays, lastAt: snap.lastAt, version: snap.version };
          } catch {
            return { parity: "unknown", streakDays: 0, lastAt: null, version: null };
          }
        })(),
        read: (() => {
          try {
            return brainRuntime.snapshot();
          } catch {
            return { mode: config.brainRead === "versioned" ? "legacy_forced" : "legacy", ok: false, holdReason: "snapshot_failed" };
          }
        })(),
      },
      // audit 2026-08-25 (verifier จับ): PDPA erasure จัดคิวลบไบต์ไว้เสมอ แต่ตัวระบายคิว
      // ต้องการ privateMedia.enabled() ซึ่งเป็นเท็จตลอดขณะ MESSAGE_MEDIA_ENABLED=false
      // (launcher บังคับ MESSAGE_MEDIA_DIR ว่าง) => ไบต์ของลูกค้าที่สั่ง "ลืม" แล้วยังคาดิสก์
      // และเดิมไม่มีที่ไหนมองเห็นเลย ทำให้ตอบคำขอ PDPA ไม่ได้ว่าลบจริงหรือยัง
      decisionReview: {
        mode: decisionReview.mode,
        enabled: decisionReview.enabled,
        providerConfigured: decisionReview.configured,
        minimumConfidence10: config.jevReviewThreshold,
        ownerLearningEnabled: config.jevOwnerLearningEnabled === true,
        policy: "lukprae-decision-review-v2",
        salesDecisionGuardEnabled: config.salesDecisionGuardEnabled === true,
      },
      privateMediaErasure: (() => {
        try {
          const pending = db.listMessageMediaDeletionQueue(1000).length;
          const retaining = config.erasedMediaPolicy === "retain_reference";
          return {
            policy: config.erasedMediaPolicy,
            drainable: retaining || privateMedia.enabled() === true,
            pending,
            // retain_reference = เก็บไว้โดยเจตนาของเจ้าของ (ไม่ใช่ "ลบไม่สำเร็จ")
            // blocked = ตั้งใจจะลบแต่ลบไม่ได้ ซึ่งต้องแก้ก่อนตอบคำขอ PDPA
            blocked: !retaining && pending > 0 && privateMedia.enabled() !== true,
          };
        } catch {
          return { policy: config.erasedMediaPolicy, drainable: null, pending: null, blocked: null };
        }
      })(),
      learning: learningStatus,
      broadcastSchedule: broadcastScheduler?.healthSnapshot?.() || {
        enabled: false, armed: false, running: false,
        tickMs: Math.max(15_000, Number(config.broadcastScheduleTickMs) || 30_000),
        timezone: "Asia/Bangkok", quietHours: "21:00-09:00",
        lastRunAt: null, lastOutcome: "unavailable",
      },
      canary: canaryState
        ? {
            status: canaryState.status,
            lastProbeAt: canaryState.last_probe_at,
            lastOkAt: canaryState.last_ok_at,
            roundTripMs: canaryState.round_trip_ms,
            detail: canaryState.detail,
          }
        : null,
    });
  }

  /* --------------------------------- router -------------------------------- */

  // v1.5: webhook Facebook — สร้างเมื่อเปิด FB_ENABLED เท่านั้น (ปิด = 404 เหมือนไม่มี)
  const fbWebhook = config.fbEnabled
    ? createFacebookWebhook({ config, db, pipeline, lineRegistry, notifier, webPush, readBody, json, logger, processId, isDraining, requestMediaIngest: runMediaIngest,
      learnPageId: (id) => facebookPage.learn(id), onAdReferralCaptured: () => adThumbs.kick({ force: true }) })
    : null;

  // ปลายทางรับค่าแอด Meta รายวันจาก Make (ยิงทุกเช้า 05:00) — นอก session คอนโซล
  // fail-closed: ยังไม่ตั้งกุญแจใน settings = ตอบ 503 ไม่รับใคร
  const adsIngest = createAdsIngest({ db, json, readJson, logger });
  // 28 ก.ย. 2026: ลิงก์นับคลิกของบรอดแคสต์/ข้อความตามขั้น (สาธารณะ — ลูกค้ากดจาก LINE · นับรวมเท่านั้น)
  const trackedLink = createLinkRedirect({ db, logger });
  // 30 ก.ย. 2026: หน้า "เปิด LINE แล้วส่งรหัส" ของลิงก์เชิญจาก Facebook (พาออกจากเบราว์เซอร์ในแอป Messenger) — ไม่อ่านฐานข้อมูล
  const identityLanding = createIdentityLanding({
    getLineId: () => identityLink?.targetLineChannel?.()?.basicId || "",
    getBaseUrl: () => identityLink?.landingBase?.() || "",
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/webhooks/line") {
        return await handleLineWebhook(req, res);
      }
      if (fbWebhook && url.pathname === "/webhooks/facebook") {
        if (req.method === "GET") return fbWebhook.handleVerify(req, res, url);
        if (req.method === "POST") return await fbWebhook.handleWebhook(req, res);
      }
      if (url.pathname === "/webhooks/ads-spend") {
        return await adsIngest.handle(req, res);
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return handleHealth(res);
      }
      if ((req.method === "GET" || req.method === "HEAD") && isIdentityLandingPath(url.pathname)) {
        return identityLanding(req, res, url.pathname);
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/r/")) {
        return trackedLink(req, res, url);
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/media/")) {
        const asset = broadcastMedia.openPublic(url.pathname);
        if (!asset) return json(res, 404, { ok: false, error: "ไม่พบรูป" });
        const headers = {
          "content-type": asset.row.mime,
          "content-length": asset.row.byte_size,
          "cache-control": "public, max-age=31536000, immutable",
          etag: asset.etag,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
        };
        if (req.headers["if-none-match"] === asset.etag) {
          asset.stream.destroy();
          res.writeHead(304, { ...headers, "content-length": 0 });
          res.end();
          return;
        }
        res.writeHead(200, headers);
        if (req.method === "HEAD") {
          asset.stream.destroy();
          res.end();
          return;
        }
        asset.stream.on("error", () => res.destroy());
        asset.stream.pipe(res);
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/img/")) {
        // รูป self-host สาธารณะ (approved marketing images) — ชื่อไฟล์ allowlist กัน traversal
        if (!config.imageDir) return json(res, 404, { ok: false, error: "image hosting ปิดอยู่" });
        const name = url.pathname.slice(5);
        const match = /^([a-z0-9_-]+)\.(jpg|png)$/.exec(name);
        if (!match) return json(res, 404, { ok: false, error: "ไม่พบรูป" });
        const pinned = imageHostingManifest?.get(name) || null;
        if (imageHostingManifest && !pinned) return json(res, 404, { ok: false, error: "ไม่พบรูป" });
        if (pinned) {
          const headers = {
            "content-type": pinned.mime,
            "content-length": pinned.bytes,
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            etag: pinned.etag,
          };
          if (req.headers["if-none-match"] === pinned.etag) {
            res.writeHead(304, { ...headers, "content-length": 0 });
            return res.end();
          }
          res.writeHead(200, headers);
          if (req.method === "HEAD") return res.end();
          return res.end(pinned.content);
        }
        let fd = null;
        try {
          const baseDetails = lstatSync(config.imageDir);
          if (!baseDetails.isDirectory() || baseDetails.isSymbolicLink()) throw new Error("unsafe image directory");
          const requested = joinPath(config.imageDir, name);
          fd = openSync(requested, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          const details = fstatSync(fd);
          if (!details.isFile() || details.size <= 0 || details.size > 10 * 1024 * 1024) throw new Error("unsafe image asset");
          res.writeHead(200, {
            "content-type": match[2] === "png" ? "image/png" : "image/jpeg",
            "content-length": details.size,
            "cache-control": "public, max-age=86400",
            "x-content-type-options": "nosniff",
          });
          if (req.method === "HEAD") {
            closeSync(fd);
            fd = null;
            return res.end();
          }
          const stream = createReadStream(requested, { fd, autoClose: true });
          fd = null;
          stream.on("error", () => res.destroy());
          stream.pipe(res);
        } catch {
          if (fd !== null) {
            try { closeSync(fd); } catch { /* already closed */ }
          }
          return json(res, 404, { ok: false, error: "ไม่พบรูป" });
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/download-bridge.js") {
        if (!config.outboundFileLinkEnabled || !config.messageMediaEnabled) return json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": Buffer.byteLength(DOWNLOAD_BRIDGE_JS),
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'",
          "x-content-type-options": "nosniff",
        });
        return res.end(DOWNLOAD_BRIDGE_JS);
      }
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/line-media/")) {
        // LINE requires an HTTPS-fetchable image URL. This opaque capability is
        // recipient-scoped through message_attachments, stored only as a hash,
        // expires automatically, and is revoked before PDPA erasure succeeds.
        if (!config.outboundFileLinkEnabled || !config.messageMediaEnabled || !privateMedia.enabled()) return json(res, 404, { ok: false, error: "ไม่พบรูป" });
        const token = url.pathname.slice("/line-media/".length);
        if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return json(res, 404, { ok: false, error: "ไม่พบรูป" });
        const grant = db.activeAttachmentDownloadToken(createHash("sha256").update(token).digest("hex"));
        const attachment = grant ? db.getMessageAttachment(grant.attachment_id) : null;
        if (!attachment || attachment.status !== "ready" || attachment.kind !== "image" || attachment.direction !== "out" || attachment.source !== "operator_upload" || !attachment.storage_key || !/^image\/(?:jpeg|png)$/u.test(attachment.mime)) return json(res, 404, { ok: false, error: "ไม่พบรูป" });
        let opened = null;
        try {
          opened = privateMedia.open(attachment.storage_key);
          const headers = {
            "content-type": attachment.mime,
            "content-length": opened.stat.size,
            "content-disposition": attachmentContentDisposition(attachment.original_name || "image", "inline"),
            "cache-control": "private, no-store",
            "referrer-policy": "no-referrer",
            "content-security-policy": "default-src 'none'; sandbox",
            "x-content-type-options": "nosniff",
          };
          res.writeHead(200, headers);
          if (req.method === "HEAD") { opened.close(); opened = null; return res.end(); }
          const body = createReadStream(opened.path, { fd: opened.fd, autoClose: true });
          opened = null;
          body.on("error", () => res.destroy()); body.pipe(res); return;
        } catch { if (opened) try { opened.close(); } catch {} return json(res, 404, { ok: false, error: "ไม่พบรูป" }); }
      }
      if (req.method === "GET" && url.pathname === "/download") {
        // The bearer stays in location.hash and therefore never reaches proxy,
        // CDN or application request logs. A same-origin bridge clears the
        // fragment and submits it in a bounded POST body.
        if (!config.outboundFileLinkEnabled || !config.messageMediaEnabled || !privateMedia.enabled()) return json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
        // White-label: หัวหน้าเพจที่ลูกค้าเห็นใช้ชื่อแอดมิน AI ของร้าน (ค่าเริ่มต้น = หน้าเดิมทุกไบต์)
        const bridgeHtml = brandText(DOWNLOAD_BRIDGE_HTML, config.brand).replace(/&(?![a-z#0-9]+;)/giu, "&amp;");
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(bridgeHtml),
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        });
        return res.end(bridgeHtml);
      }
      if (req.method === "POST" && url.pathname === "/download") {
        // Capability, not session. The token is deliberately accepted only in
        // the body so ordinary reverse-proxy access logs cannot capture it.
        if (!config.outboundFileLinkEnabled || !config.messageMediaEnabled || !privateMedia.enabled()) return json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
        if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
        let token = "";
        try {
          const body = await readBody(req, 128, { timeoutMs: 5_000, destroyOnOverflow: true });
          token = String(new URLSearchParams(body.toString("utf8")).get("token") || "");
        } catch { return json(res, 404, { ok: false, error: "ไม่พบไฟล์" }); }
        if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
        const grant = db.activeAttachmentDownloadToken(createHash("sha256").update(token).digest("hex"));
        const attachment = grant ? db.getMessageAttachment(grant.attachment_id) : null;
        if (!attachment || attachment.status !== "ready" || !["file", "audio", "video"].includes(attachment.kind) || attachment.direction !== "out" || attachment.source !== "operator_upload" || !attachment.storage_key) return json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
        let opened = null;
        try {
          opened = privateMedia.open(attachment.storage_key);
          const headers = { "content-type": "application/octet-stream", "content-length": opened.stat.size, "content-disposition": attachmentContentDisposition(attachment.original_name || "attachment"), "cache-control": "private, no-store", "referrer-policy": "no-referrer", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" };
          res.writeHead(200, headers);
          if (req.method === "HEAD") { opened.close(); opened = null; return res.end(); }
          const body = createReadStream(opened.path, { fd: opened.fd, autoClose: true });
          opened = null;
          body.on("error", () => res.destroy()); body.pipe(res); return;
        } catch { if (opened) try { opened.close(); } catch {} return json(res, 404, { ok: false, error: "ไม่พบไฟล์" }); }
      }
      if (url.pathname === "/" && req.method === "GET") {
        // หน้า root ไม่มีเนื้อหา — พาไป console (มี login fail-closed ของตัวเองอยู่แล้ว)
        res.writeHead(302, { location: "/console/", ...securityHeaders() });
        res.end();
        return;
      }
      if (url.pathname === "/console" || url.pathname.startsWith("/console/")) {
        // auth ทั้งหมด (session/CSRF/degraded 503) จัดการใน consoleApi — fail-closed
        const handled = await consoleApi.handle(req, res, url, { readJson, readBody, json });
        if (handled) return;
      }
      if (url.pathname.startsWith("/api/")) {
        // fail-closed: ไม่มี AUTH secret = ไม่เสิร์ฟ API เลย
        if (config.degraded.dashboard) {
          return json(res, 503, { ok: false, error: "DASHBOARD_API_KEY ยังไม่ได้ตั้งค่า" });
        }
        if (!dashboardKeyMatches(req.headers["x-dashboard-key"], config.dashboardApiKey)) {
          return json(res, 401, { ok: false, error: "ไม่ได้รับอนุญาต" });
        }
        const handled = await operatorApi.handle(req, res, url, { readJson, json });
        if (handled) return;
      }
      json(res, 404, { ok: false, error: "ไม่พบเส้นทางนี้" });
    } catch (err) {
      logger.error?.(`server: ${err?.message || err}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: "ข้อผิดพลาดภายใน" });
    }
  });
  server.requestTimeout = Math.max(1_000, Number(config.httpRequestTimeoutMs) || 60_000);
  server.headersTimeout = Math.min(
    server.requestTimeout,
    Math.max(1_000, Number(config.httpHeadersTimeoutMs) || 15_000),
  );

  return { server, pipeline, yolo, telegramControl, lineInsight, identityLink, stepMessages, broadcastStudio, canary, followups, stagedFollowups, retention, needsHumanSla, pauseResume, brainParity, brainRuntime, digest, hotFollowupPush, qualifySweep, ownerReviewScheduler, ownerCloseService, blueprintSender, adThumbs, metaCapi, learning, broadcastScheduler, burst, line, lineRegistry, channels, guard, humanizer, consoleApi, slipCheck, orderWebhook, broadcastMedia, pilotGate, webPush, processId, isDraining, setDraining };
}

/* ---------------------------------- main ----------------------------------- */

// Brain เฟส 1a: บรรทัดเดียวตอนบูตว่า "สมองที่คอมไพล์แล้ว ตรงกับตารางที่ระบบใช้จริงไหม"
//
// ทั้งฟังก์ชันนี้เป็น read-only และ **ไม่มีทาง** ทำให้บูตล้ม: ปิดโดยค่าเริ่มต้น, โหลดโมดูล
// แบบ dynamic (ไม่มีเวอร์ชันสมอง = ไม่มีอะไรถูกโหลดเลย), และ error ทุกชนิดถูกกลืนเป็น log
// ไม่แตะ prompt ไม่แตะ guard ไม่เขียน DB — ดู outputs/.../brain/parity.mjs
function logBrainShadowParity({ config, db, logger }) {
  if (config.brainShadowParity !== true) return;
  import("./brain/parity.mjs")
    .then(({ brainParityReport, brainParityLogLine }) => {
      const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
      const report = brainParityReport(db, { todayIso, classRoundsFile: config.classRoundsFile });
      logger.log(brainParityLogLine(report));
    })
    .catch((err) => logger.warn?.(`[chassis] brain parity: ตรวจไม่สำเร็จ (${err?.message || err})`));
}


export function startServer() {
  const config = createConfig();
  const logger = console;
  for (const lineText of startupReport(config)) logger.log(`[chassis] ${lineText}`);

  // teachHashSecret: กุญแจของ hash ลูกค้าใน teach_json — ใช้ secret ของ console ที่มีอยู่แล้ว
  // (ไม่มี secret = ตกกลับเป็น sha256 + domain เหมือน tombstone ไม่ใช่ล้มตอนบูต)
  const db = openDb({ file: config.dbFile, teachHashSecret: config.consoleSessionSecret });
  // bootstrap บัญชี operator จาก OPERATOR_SEED (hash ทันที ไม่เก็บ/ไม่ log plaintext)
  seedOperators({ db, seed: config.operatorSeed, logger });
  const app = createApp({ config, db, logger });
  logBrainShadowParity({ config, db, logger });
  // บรรทัดเดียวบอกว่าโปรเซสนี้ใช้ตัวตนรุ่นไหน (ตรวจหลังสลับ release ได้จาก journal ทันที)
  // (รุ่นหลักเสมอ — รุ่นทดลองพิมพ์อีกบรรทัดพร้อมโหมดของสวิตช์ตอนบูต)
  const soulNow = activeSoul();
  logger.log(`[chassis] soul: ${soulNow ? `${soulNow.soulId}@${soulNow.version} sha ${soulNow.sha256.slice(0, 12)}` : "ไม่มี SOUL_FILE — ใช้ค่ากลางของ chassis"}`);
  const soulNext = candidateSoul();
  if (soulNext) logger.log(`[chassis] soul candidate: ${soulNext.soulId}@${soulNext.version} sha ${soulNext.sha256.slice(0, 12)} · ${SOUL_CANDIDATE_MODE_KEY}=${soulCandidateMode(db)}`);

  const onListening = () => {
    const displayHost = config.bindHost || "localhost";
    logger.log(`[chassis] G2a พร้อมที่ http://${displayHost}:${config.port} (console: /console)`);
    app.canary.start(); // ยิงเฉพาะเมื่อ CANARY_INTERVAL_MS > 0
    app.followups.start(); // เดินเฉพาะเมื่อ FOLLOWUP_INTERVAL_MS > 0 (สวิตช์ global เช็คสดทุกรอบ)
    app.stagedFollowups.start(); // v1.4.6: เดินเฉพาะเมื่อ STAGED_FOLLOWUP_TICK_MS > 0
    app.retention.start(); // M4: ลบข้อมูลเก่ารายวัน (สวิตช์ RETENTION_ENABLED เช็คสดทุกรอบ)
    app.needsHumanSla.start(); // 2026-09-02: ทวงห้องที่รอคน (arm เฉพาะ NEEDS_HUMAN_SLA_ENABLED=true)
    app.pauseResume.start(); // 2026-09-28: ตอบข้อความค้างระหว่างพักเมื่อหมดเวลา (สวิตช์ pause_resume_answer เช็คสดทุกรอบ)
    app.brainParity.start(); // Phase 1a: เฝ้าสมองเงา (arm เฉพาะ BRAIN_SHADOW_PARITY=true และ tick > 0)
    app.digest.start(); // G7.1: arm เฉพาะเมื่อตั้ง DIGEST_LINE_USER_ID (สวิตช์เช็คสดทุกรอบ)
    app.hotFollowupPush.start(); // 29 ก.ย. 2026: ลูกค้าร้อนรอทีมทักต่อ 3 รอบ/วัน (ไม่มีห้องค้าง = ไม่ส่ง)
    app.qualifySweep?.start(); // 5 ต.ค. 2026: ตัวกวาดคัดกรองรายชั่วโมง (8 พ.ย.: ทุกชั่วโมง 24 ชม.) (สวิตช์ qualify_sweep_mode เช็คสดทุกนาที · ไม่มีแถว = off)
    app.ownerReviewScheduler?.start(); // 12 ต.ค. 2026 ค่ำ: รอบตรวจของพี่ง้วง 09/12/15/19 (สวิตช์ owner_review_mode เช็คสดทุกนาที · ไม่มีแถว = on)
    app.learning.start(); // proposal-only; default OFF และไม่เรียก provider
    app.broadcastScheduler?.start(); // B-13: arm เฉพาะ BROADCAST_SCHEDULE_ENABLED=true
    app.telegramControl.start(); // 2026-09-28: รับคำสั่งพี่ง้วงทาง Telegram (ทำงานจริงเมื่อมีโทเคนในคอนโซล)
    app.lineInsight.start(); // 28 ก.ย. 2026: สถิติรายวันของ LINE (arm เฉพาะยิง LINE จริง · LINE_INSIGHT_TICK_MS=0 ปิด)
    // 28 ก.ย. 2026: LINE ID ของ OA สำหรับลิงก์เชิญจาก Facebook — ถาม LINE ครั้งเดียวตอนบูต (ไม่ได้ตั้ง LINE_BASIC_ID ก็ใช้ได้)
    void app.identityLink?.resolveBasicIds?.();
    app.stepMessages?.start(); // 28 ก.ย. 2026: ข้อความตามขั้น (ส่งเฉพาะลำดับที่เปิดใช้ + สวิตช์ step_messages_mode)
    // 11 ต.ค. 2026 แคมเปญ #AIAGENT: ลงค่าตั้งต้นครั้งแรก (เฉพาะเครื่องลูกแพร · มีแถวแล้วไม่แตะ) + ตัวเดินรอบทุกนาที
    // สวิตช์ blueprint_send_mode ไม่มีแถว = off = ไม่เรียกโมเดล ไม่ส่งอะไร (คืน FU ที่ครบกำหนดอย่างเดียว)
    try {
      const seeded = seedCampaigns(db, { businessId: config.businessId, nowMs: Date.now() });
      if (seeded.length) logger.log(`[chassis] แคมเปญ AI Agent ลงค่าตั้งต้น: ${seeded.join(", ")}`);
    } catch (err) {
      logger.warn?.(`[chassis] ลงค่าตั้งต้นแคมเปญ AI Agent ไม่สำเร็จ (${err?.message || err})`);
    }
    app.blueprintSender?.start();
  };
  if (config.bindHost) app.server.listen(config.port, config.bindHost, onListening);
  else app.server.listen(config.port, onListening);

  // Drain-to-Finish แทนเพดาน 3 วินาทีเดิม (ซึ่งสั้นกว่าหน้าต่าง burst เสมอ จึงตัด
  // กลาง debounce ทุกครั้งที่ deploy = สาเหตุจริงของ "ห้องเงียบถาวร" ทั้งสองครั้ง)
  const shutdownCoordinator = createShutdownCoordinator({
    app, db, config, logger,
    processId: app.processId,
    setDraining: (value) => app.setDraining(value),
  });
  process.on("SIGINT", () => { shutdownCoordinator.run("SIGINT").catch(() => process.exit(0)); });
  process.on("SIGTERM", () => { shutdownCoordinator.run("SIGTERM").catch(() => process.exit(0)); });

  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
