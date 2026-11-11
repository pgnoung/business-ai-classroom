// consoleSettingsApi.mjs — เส้นทาง /console/api ส่วน "ตั้งค่า + โมเดล + คลังความรู้
// + สมองต่อสาขา (G6 P1) + คิวรีวิวคำแก้ (ย้ายมาจาก consoleApi.mjs — G6 คุมขนาดไฟล์)"
// แยกจาก consoleApi.mjs เพื่อคุมขนาดไฟล์ <800 บรรทัด — session/CSRF ยังคุมจาก consoleApi
// (ctx.requireCsrf ผูกกับ session ของ request นั้น ๆ) ทุก mutation มี audit row เสมอ
import { AI_PAUSE_SETTING, aiPausedNow, aiPausedDraftModeOn, AI_PAUSE_DRAFT_SETTING } from "./aiPause.mjs";
import { followupGlobalEnabled } from "./followupEngine.mjs";
import { SCORER_SUGGESTIONS_KEY, scorerSuggestionsEnabled } from "./scorerSuggestions.mjs";
import { hashtagBusinessDefaults, hashtagBusinessKeywords, hashtagSilenceEnabled, normalizeHashtagBusinessKeywords } from "./pipeline.mjs";
import {
  normalizePresetButtonPhrases, PRESET_BUTTON_DEFAULTS, PRESET_BUTTON_LIST_MAX, PRESET_BUTTON_PHRASES_KEY,
  presetButtonPhrases, presetButtonPhrasesConfigured,
} from "./presetButtons.mjs";
import { digestGlobalEnabled, DIGEST_ENABLED_KEY } from "./digest.mjs";
import { LEARNING_ENABLED_KEY } from "./learningDigest.mjs";
import {
  parseActiveHours, scheduleState,
  SCHEDULE_ENABLED_KEY, SCHEDULE_HOURS_KEY, SCHEDULE_ACK_KEY,
} from "./scheduleGate.mjs";
import { KNOWLEDGE_TITLE_MAX, KNOWLEDGE_CONTENT_MAX, knowledgeContentMaxFor } from "./dbExtra.mjs";
import { FREECLASS_PATTERNS_KEY } from "./db.mjs";
import { FB_KEY_PAGE_ACCESS, FB_KEY_APP, FB_KEY_VERIFY } from "./channels.mjs";
import {
  knowledgeSectionFromDb, knowledgeUsage, KNOWLEDGE_MAX_CHARS,
  catalogOutOfPrompt, REVIEW_CATALOG_MAX_CHARS,
  brainModeOf, brainModeKey, brainAddendumKey,
  BRAIN_MODE_SHARED, BRAIN_MODE_SEPARATE, BRAIN_ADDENDUM_MAX,
} from "./knowledgePack.mjs";
import { verifyPassword, hashPassword, sessionCookie } from "./auth.mjs";
import { stripCatalogItems } from "./reviewSelection.mjs";
import { NOTIFY_KEY_PREFIX, notifyIdsFor, validNotifyIds, NOTIFY_MAX_RECIPIENTS } from "./notify.mjs";
import { PRODUCT_RULES_KEY, PRODUCT_RULES_MAX } from "./tags.mjs";
import { ENROLLED_MAX, readEnrolled, readManualRounds, toStoredRound, upcomingRounds, writeEnrolled, writeManualRounds } from "./classRounds.mjs";
import {
  CLAUDE_EXPORT_TESTERS_KEY,
  CLAUDE_EXPORT_TESTERS_MAX,
  parseClaudeExportTesterIds,
  validClaudeExportTesterIds,
} from "./claudeChatExport.mjs";
import {
  parseReviewDoc, renderReviewDoc, validateReviewDoc, REVIEW_ENTRY_TITLE_MATCH,
} from "./reviewCatalogDoc.mjs";
import { summarizeKpi } from "./kpi.mjs";
import { relayTeamRate } from "./consoleAttentionApi.mjs";
import { OFF_DAYS_KEY, parseOffDays } from "./workClock.mjs";
import { qualifyHoldKey } from "./notQualified.mjs";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { soulInfo } from "./soul/index.mjs";
import { soulRolloutInfo } from "./soulRollout.mjs";
import {
  createPublishQueueRoutes, queuePublishRequest, PUBLISH_KINDS, PUBLISH_QUEUED_MESSAGE,
} from "./consolePublishQueueApi.mjs";
import {
  createBrainWriteHook, BrainWriteRefused, BRAIN_WRITE_KINDS, BRAIN_SILENT_OUTCOMES,
} from "./brain/writeHook.mjs";
import { createBrainVersionRoutes } from "./consoleBrainApi.mjs";
import { createLineOaCapabilityRoutes } from "./consoleLineOaApi.mjs";
import { createAdWelcomeRoutes } from "./consoleAdWelcomeApi.mjs";
import { createBehaviorSwitchRoutes } from "./consoleBehaviorSwitchesApi.mjs";
import { createTeachRoutes, knowledgeMetadataStatus, resolveTeachContext, stripClientHash } from "./consoleTeachApi.mjs";
import { createEvalRoutes } from "./consoleEvalApi.mjs";
import { createLessonRoutes } from "./consoleLessonsApi.mjs";
import { createTrainingIntakeRoutes, trainingIntakeReadiness } from "./consoleTrainingIntakeApi.mjs";
import { sanitizeTeachContext, normalizedPriceLabel } from "./brain/teach.mjs";
import { isTeachableCorrection } from "./correctionCapture.mjs";
import {
  knowledgeExpectedHash, knowledgeMetadataFromRow, mergeKnowledgeMetadata, normalizeKnowledgeMetadata,
} from "./brain/knowledgeMetadata.mjs";

// ข้อความปฏิเสธกลาง ๆ ตัวเดียวทั้งไฟล์ — ห้ามบอกใบ้ว่าของที่กันไว้คืออะไรหรือมีค่าเท่าไร
// (ต้องตรงกับข้อความในด่าน route ของ consoleApi.mjs เพื่อไม่ให้แยกได้ว่าโดนกันชั้นไหน)
const DENY_NO_PERMISSION = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";

// รอบเรียนรู้รายวันฉบับ "ไม่มีตัวเลขต้นทุน" — allowlist ของฟิลด์ที่หน้าเว็บใช้จริง
// จงใจไม่มี usd / llm_calls / tokens_in / tokens_out (ต้นทุนโมเดล = ของเจ้าของ)
const PUBLIC_LEARNING_RUN_FIELDS = Object.freeze([
  "id", "day_key", "mode", "status", "created_at", "completed_at",
  "signals_found", "clusters", "candidates_created",
  // สี่ตัวนี้คือ KPI คุณภาพคำตอบที่ learningControl พิมพ์ขึ้นจอ — เป็นอัตราส่วน ไม่ใช่เงิน
  "hedge_rate", "promise_notes_per_100", "operator_override_per_100", "probe_count",
]);

function publicLearningRun(row) {
  const out = {};
  for (const field of PUBLIC_LEARNING_RUN_FIELDS) {
    if (row && field in row) out[field] = row[field];
  }
  return out;
}

const ACK_TEMPLATE_MAX = 500;
// M1: ขั้นต่ำรหัสผ่านใหม่ (สูงกว่า seed เดิมที่ 8 — บัญชีที่ตั้งเองต้องแข็งแรงขึ้น)
// ค่าที่บอกว่า "ด่านความเป็นส่วนตัวของจอสอนไม่ผ่าน และตอบ 400 ไปแล้ว"
const TEACH_REFUSED = Symbol("teach_refused");
// หน้าต่างกันส่งซ้ำของจอสอน — สั้นพอที่คนแก้ของเดิมซ้ำในวันเดียวกันไม่โดนกัน
const TEACH_KEY_TTL_MS = 5 * 60_000;
const PASSWORD_MIN = 10;
// M5: ขอบเขต label ของ approved_prices
const PRICE_LABEL_MAX = 100;

export function createSettingsRoutes({ config, db, modelPricing, replyModelPricing = modelPricing, scorerModelPricing = modelPricing, followupModelPricing = modelPricing, knownModelIds, knownReplyModelIds = knownModelIds, knownScorerModelIds = knownModelIds, knownFollowupModelIds = knownModelIds, currentModels, fxNow, imageCatalog = [], brain = {}, channels = [], sessions = null, logger = console, learning = null, webPush = null, notifier = null, bannedWords = null, safetyRules = null, tagFramework = null }) {
  // Brain เฟส 1b: จุดคอขวดเดียวของทุกการเขียนที่เปลี่ยนสมอง (src/brain/writeHook.mjs)
  // ทั้งเส้นที่เจ้าของกดเอง และเส้นที่คิว Package K เล่นซ้ำ เดินผ่านตัวเดียวกันเพราะทั้งคู่
  // ยิงเข้า handle() ตัวนี้ — ไม่มีทางที่ทางใดทางหนึ่งจะข้ามด่านไปได้โดยไม่มีใครสังเกต
  const brainWriteHook = createBrainWriteHook({ db, config, logger, notifier, bannedWords, safetyRules });
  // กุญแจการส่งของจอสอนที่เพิ่งผ่านไป (key -> เวลาหมดอายุ) — อยู่ระดับ routes ไม่ใช่ต่อ request
  const recentTeachKeys = new Map();
  // ประวัติรุ่น / รับทราบ / เลื่อนขั้น canary / ย้อนกลับ / มอบสิทธิ์ — แยกไฟล์คุมขนาด
  const brainVersionRoutes = createBrainVersionRoutes({ db, config, logger, denyMessage: DENY_NO_PERMISSION, bannedWords, safetyRules });
  // เฟส 3: กล่องตรวจ + จอสอน + Step 0 — อ่านอย่างเดียวทั้งไฟล์ ไม่มีทางเขียนสมองของตัวเอง
  const teachRoutes = createTeachRoutes({ db, config, logger, notifier, denyMessage: DENY_NO_PERMISSION });
  const trainingIntakeRoutes = createTrainingIntakeRoutes({ db, config, channels, logger });
  const lineOaCapabilityRoutes = createLineOaCapabilityRoutes({ config, channels });
  const adWelcomeRoutes = createAdWelcomeRoutes({ db });
  // 28 ก.ย. 2026: สวิตช์พฤติกรรมใหม่ (เบรกสอนยาว · คำถามปิดท้าย · ตอบข้อความค้างหลังพัก) — เจ้าของกดเองได้
  const behaviorSwitchRoutes = createBehaviorSwitchRoutes({ db, tagFramework });
  // เฟส 3: "การเผยแพร่ถูกบล็อกเพราะบทสนทนาไหน" + ปุ่มปิดเกณฑ์ที่ล้าสมัยของเจ้าของ
  const evalRoutes = createEvalRoutes({ db, config, logger, notifier, denyMessage: DENY_NO_PERMISSION });
  // 2026-09-28: บทเรียนจากแผง "ทำไมตอบแบบนี้" — เส้นของตัวเอง ไม่ผ่านบันไดเผยแพร่การ์ด
  const lessonRoutes = createLessonRoutes({ db, config, channels, notifier, logger });

  // คืน true = จัดการ route แล้ว (ตอบ response เอง) / false = ไม่ใช่ของส่วนนี้
  async function handle(req, res, url, route, ctx) {
    const { readJson, json, username, operator, requireCsrf } = ctx;

    // เขียนตารางเดิม + สร้างเวอร์ชันสมอง + เดินด่าน + ย้าย pointer ในธุรกรรมเดียว
    // คืน null = ตอบ response ไปแล้ว (ด่านไม่ผ่าน) ผู้เรียกต้อง return true ทันที
    // teach = บริบทของจอสอน (เฟส 3) ถ้ามี — ผ่าน resolveTeachContext ก่อนเสมอ
    // (แฟล็กปิด/ไม่ได้ส่งมา = null แปลว่า teach_json ของรุ่นมีรูปเหมือนก่อนมีเฟส 3 ทุกไบต์)
    function brainWrite(kind, { audit, apply, teach = null }) {
      const outcome = brainWriteHook.apply({ kind, operator, username, audit, apply, teach });
      // ผูก "คำแก้ใบนี้ถูกสอนด้วยรุ่นไหน" ทุกผลที่ได้รุ่นจริง — รวมรุ่นที่ค้างรอรับทราบ
      // (409) ด้วย เพราะของถูกส่งไปแล้ว ถ้าไม่ผูก แถวจะยังชวนให้กดสอนซ้ำอีกใบ
      rememberTaught(teach, outcome);
      if (outcome.ok) return outcome;
      json(res, outcome.status ?? 409, {
        ok: false,
        error: outcome.error,
        brain: {
          outcome: outcome.outcome,
          ...(outcome.versionId ? { versionId: outcome.versionId, seq: outcome.seq } : {}),
          findings: (outcome.findings ?? []).map((f) => ({ code: f.code, message: f.message })),
        },
      });
      return null;
    }

    // ข้อมูลรุ่นสมองที่แนบไปกับ response 200 — หน้าเว็บใช้บอกว่า "ใช้งานจริงแล้ว" หรือ
    // "เป็นรุ่นทดลองที่ยังไม่ถึงลูกค้า" (ผลลัพธ์ที่เหลือใน payload คือตารางเดิมตามจริง)
    // undefined = ไม่มีคีย์ `brain` ใน response เลย (JSON.stringify ตัดทิ้งให้) — ตอนแฟล็กปิด
    // response ทุกเส้นต้องเป็นรูปเดิมเป๊ะ ไม่ใช่รูปเดิม+ฟิลด์ใหม่ ซึ่งคิว Package K จะเก็บ
    // ลง result_json ติดไปด้วย แล้วของที่บันทึกไว้คืนนี้กับก่อนหน้านี้จะเทียบกันไม่ได้
    // จอสอนส่ง teach มากับ body ของเส้นเขียนเดิม — ไม่มีเส้นเขียนใหม่ให้ด่านต้องไล่ตาม
    // hash ของลูกค้าถูกคำนวณฝั่งนี้จากแถวคำแก้เสมอ ค่าที่หน้าเว็บส่งมาถูกทิ้ง (ดู consoleTeachApi)
    //
    // คืน TEACH_REFUSED = ตอบ 400 ไปแล้ว (ด่านความเป็นส่วนตัวไม่ผ่าน) ผู้เรียกต้อง return true
    // `cardText` คือข้อความที่กำลังจะกลายเป็นการ์ดจริง ๆ — ด่านต้องดูของชิ้นนั้น ไม่ใช่แค่
    // ข้อความที่คนพิมพ์ในจอสอน (สองอย่างนี้ต่างกันได้ และของที่ถึงลูกค้าคือชิ้นแรก)
    // กันการส่งซ้ำของจอสอน: เน็ตอืดแล้วกดสองที = การ์ดสองใบที่ไม่มีใครตั้งใจ
    // เก็บในหน่วยความจำของ process ที่เสิร์ฟคอนโซลนี้เอง (หน้าต่างไม่กี่นาที) — ไม่ใช่ตารางใหม่
    // ข้ามการตรวจตอนเล่นซ้ำคำขอในคิว เพราะนั่นคือ "การส่งของใบเดิมโดยเจตนา" ของเจ้าของ
    const teachKeyOf = (body) => String(body?.teachKey || "").slice(0, 120);
    const duplicateTeach = (body) => {
      if (ctx.replaying === true) return false;
      const key = teachKeyOf(body);
      if (!key) return false;
      const at = Date.now();
      for (const [seen, expires] of recentTeachKeys) if (expires <= at) recentTeachKeys.delete(seen);
      if (recentTeachKeys.has(key)) return true;
      recentTeachKeys.set(key, at + TEACH_KEY_TTL_MS);
      return false;
    };
    // "คำแก้ใบนี้ถูกสอนแล้ว" ต้องอยู่บนแถวคำแก้ ไม่ใช่อนุมานจากรุ่นล่าสุดไม่กี่ใบ
    // ผูกทุกผลที่ได้รุ่นจริง (live / canary / รอรับทราบ) — ทั้งสามแบบแปลว่า "ส่งไปแล้ว"
    const rememberTaught = (teach, outcome) => {
      const ref = teach?.correction_ref;
      if (!ref || !outcome?.versionId) return;
      try { db.setCorrectionTaughtVersion(ref, outcome.versionId); }
      catch (err) { logger.debug?.(`teach: ผูกคำแก้กับรุ่นไม่สำเร็จ (${err?.message || err})`); }
    };

    const teachContext = (body, cardText = "") => {
      const resolved = resolveTeachContext(db, body?.teach, {
        teachEnabled: config.teachEnabled === true, cardText,
      });
      if (resolved?.error) {
        json(res, 400, { ok: false, error: resolved.error });
        return TEACH_REFUSED;
      }
      return resolved;
    };

    const brainInfo = (outcome) => (BRAIN_SILENT_OUTCOMES.includes(outcome.outcome) ? undefined : {
      outcome: outcome.outcome,
      ...(outcome.versionId ? { versionId: outcome.versionId } : {}),
      ...(outcome.seq ? { seq: outcome.seq } : {}),
    });

    // Body ที่ไม่มี knowledgeMetadata ต้องเดินเหมือนก่อนมีฟีเจอร์ทุกประการ.
    // ถ้าส่งมาแล้ว ต้องพร้อมใช้งานจริงก่อนและต้องผ่าน shape ปิด; ห้ามเก็บแล้วหวังว่า
    // runtime รอบหลังจะตีความให้ เพราะคิวอนุมัติจะเล่น body เดิมอีกครั้ง.
    const normalizeKnowledgeBody = (body) => {
      if (!body || typeof body !== "object" || !Object.hasOwn(body, "knowledgeMetadata")) return body;
      const status = knowledgeMetadataStatus({ config, db });
      if (!status.ready) {
        const err = new Error(status.message || "ยังไม่พร้อมเลือกความรู้ตามเรื่อง");
        err.status = 409;
        throw err;
      }
      return { ...body, knowledgeMetadata: normalizeKnowledgeMetadata(body.knowledgeMetadata) };
    };

    const provenanceObject = (row) => {
      try {
        const parsed = JSON.parse(String(row?.provenance_json || "{}"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch { return {}; }
    };

    const publicKnowledgeRow = (row) => row && {
      ...row,
      knowledgeMetadata: knowledgeMetadataFromRow(row),
      // ส่ง token ให้ทุกแถว: ใบเก่าที่กำลังจะเพิ่ม metadata ต้องมี precondition
      // ก่อนเขียนครั้งแรกเช่นกัน ไม่อย่างนั้น UI จะเจอ 409 โดยไม่มีทางส่ง hash ที่ถูกต้อง.
      expectedKnowledgeHash: knowledgeExpectedHash(row),
    };

    const featureKnowledgeEdit = (row, body) => Object.hasOwn(body || {}, "knowledgeMetadata")
      || knowledgeMetadataFromRow(row) !== null;

    // Staff never chooses the precondition: the server stamps the row as it existed
    // at queue time. A body-supplied value is discarded so an old request cannot pick
    // a newer owner's token and overwrite their later edit.
    const prepareQueuedKnowledgeEdit = (body, id) => {
      const normalized = normalizeKnowledgeBody(body);
      const { expectedKnowledgeHash: _untrustedExpected, ...withoutExpected } = normalized;
      const row = db.getKnowledge(id);
      if (!row) {
        const err = new Error("ไม่พบความรู้รายการนี้");
        err.status = 404;
        throw err;
      }
      return featureKnowledgeEdit(row, withoutExpected)
        ? { ...withoutExpected, expectedKnowledgeHash: knowledgeExpectedHash(row) }
        : withoutExpected;
    };

    // 2 ก.ย. 2026 (คำสั่งพี่ง้วง): ด่าน "เผยแพร่ของที่เปลี่ยนสมองลูกแพร" — เจ้าของเท่านั้น
    // Package K รอบเดียวกัน: คนที่ไม่มีสิทธิ์ไม่ได้ 403 เปล่า ๆ อีกแล้ว แต่ได้ "คิวขออนุมัติ"
    //
    // คืน true = ตอบ response ไปแล้ว (403 ปฏิเสธ หรือ 202 เข้าคิว) handler ต้อง return true ทันที
    // คืน false = คนนี้มีสิทธิ์เผยแพร่จริง เดินต่อไปทำของตามปกติ
    //
    // ลำดับด่านสำคัญมาก และต่างจากด่าน 403 เปล่า ๆ ของ Package C หนึ่งจุด:
    //   1. มีสิทธิ์เผยแพร่ -> ผ่าน
    //   2. ไม่มีแม้แต่สิทธิ์ "อ่าน" ของส่วนนี้ (หรือกำลังเล่นซ้ำคำขออยู่) -> 403 ข้อความกลาง
    //   3. มีสิทธิ์อ่าน -> ต้องผ่าน CSRF ก่อน แล้วจึงเก็บคำขอเข้าคิว
    // ข้อ 3 คือที่เปลี่ยนจาก Package C: เดิม staff ไม่มีทางผ่าน ด่าน CSRF จึงเป็นคำใบ้
    // ตอนนี้ staff ส่งคำขอได้จริง CSRF จึงกลายเป็นด่านจริงที่ต้องตอบตามตรง
    //
    // อ่าน body ตรงนี้เลยเพราะต้องเก็บลงคิว — เส้นที่เข้าคิวแล้วจะ return true ทันที
    // ไม่มีทางไปถึง readJson(req) รอบสองข้างล่าง (stream อ่านซ้ำไม่ได้)
    async function queueOrDeny(capability, kind, describe, { readCapability = "settings.manage", body: presetBody = null, prepareBody = null } = {}) {
      if (hasOperatorCapability(operator, capability)) return false;
      // เฟส 1b ไม่เปิดทางลัดข้ามคิวด้วยสิทธิ์ที่มอบมา (ดู DELEGATED_PUBLISH_ENABLED):
      // รุ่นทดลองยังไม่มีความหมายจนกว่า runtime จะอ่านสมองใน P2 ปล่อยให้ทีมงานกดแล้วได้
      // รุ่นทดลอง = บอกว่า "บันทึกแล้ว" กับของที่ไม่มีวันถึงลูกค้าเลย ทีมงานจึงเข้าคิวเหมือนเดิม
      // (ค่า brain_delegation ยังเก็บได้และกลไก canary ยังอยู่ครบ รอ P2 มาเปิด)
      // ระหว่างเล่นซ้ำคำขอ ตัวตนคือเจ้าของเสมอ — มาถึงตรงนี้ได้แปลว่าสิทธิ์เพี้ยน
      // ห้ามสร้างคำขอใหม่จากคำขอที่กำลังอนุมัติเด็ดขาด (คิวซ้อนคิวไม่รู้จบ)
      if (ctx.replaying === true || !hasOperatorCapability(operator, readCapability)) {
        json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
        return true;
      }
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      // presetBody = เส้นที่อ่าน body ไปแล้วก่อนถึงด่านนี้ (stream อ่านซ้ำไม่ได้) ส่งของเดิมเข้ามา
      // DELETE ของบ้านนี้ไม่รับ body (ดู test/owner-only-brain-publishing) — อ่านไปก็ได้ {}
      let body = presetBody ?? (req.method === "DELETE" ? {} : await readJson(req));
      if (prepareBody) {
        try { body = prepareBody(body); }
        catch (err) {
          json(res, Number(err?.status) || 400, { ok: false, error: err?.message || "ข้อมูลไม่ถูกต้อง" });
          return true;
        }
      }
      // teach ที่หน้าเว็บส่งมาถูกเก็บลง publish_requests.body_json แล้วอยู่ตลอดกาล —
      // กรองก่อนเขียนแถว ไม่ใช่ตอนเล่นซ้ำ ไม่งั้น id ดิบ/ชื่อลูกค้าที่ sanitize จะทิ้ง
      // จะถูกเก็บไว้ในคิวโดยไม่มีใครเห็นและไม่มีใครลบ
      const queuedBody = body?.teach && config.teachEnabled === true
        ? { ...body, teach: sanitizeTeachContext(stripClientHash(body.teach)) }
        : body;
      let request;
      try {
        request = queuePublishRequest({
          db, notifier, logger,
          kind, method: req.method, route, body: queuedBody,
          summary: describe(body), proposedBy: username,
        });
      } catch (err) {
        logger.warn?.(`publish queue: เก็บคำขอไม่สำเร็จ (${err?.message || err})`);
        json(res, 503, { ok: false, error: "ส่งคำขอไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
        return true;
      }
      json(res, 202, {
        ok: true, queued: true, requestId: request.id, message: PUBLISH_QUEUED_MESSAGE,
      });
      return true;
    }

    /* ---- Package K: คิวคำขอ — เจ้าของอนุมัติ/ปฏิเสธ · ทีมงานดูของตัวเอง ---- */
    if (await publishQueueRoutes.handle(req, res, url, route, ctx)) return true;

    /* ---- เฟส 1b: ประวัติรุ่นสมอง + ปุ่มของเจ้าของ (/console/api/brain/...) ---- */
    if (await brainVersionRoutes.handle(req, res, url, route, ctx)) return true;
    if (await lineOaCapabilityRoutes.handle(req, res, url, route, ctx)) return true;
    if (await adWelcomeRoutes.handle(req, res, url, route, ctx)) return true;
    if (await behaviorSwitchRoutes.handle(req, res, url, route, ctx)) return true;

    /* ---- เฟส 3: กล่องตรวจ/จอสอน/ทำไมตอบแบบนี้ (/console/api/teach/...) ---- */
    if (await trainingIntakeRoutes.handle(req, res, url, route, ctx)) return true;
    if (await teachRoutes.handle(req, res, url, route, ctx)) return true;
    if (await evalRoutes.handle(req, res, url, route, ctx)) return true;
    if (await lessonRoutes.handle(req, res, url, route, ctx)) return true;

    /* ---- Claude export tester allowlist — owner-only; audit stores count, never IDs ---- */
    if (route[0] === "settings" && route[1] === "claude-export-testers" && route.length === 2) {
      if (operator?.role !== "owner") {
        json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่จัดการรายชื่อผู้ทดสอบ Claude ได้" });
        return true;
      }
      if (req.method === "GET") {
        json(res, 200, {
          ok: true,
          ids: parseClaudeExportTesterIds(db.getSetting(CLAUDE_EXPORT_TESTERS_KEY)),
          max: CLAUDE_EXPORT_TESTERS_MAX,
        });
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const ids = validClaudeExportTesterIds(body.ids);
        if (ids === null) {
          json(res, 400, { ok: false, error: `ids ต้องเป็น LINE user ID ที่ถูกต้อง ไม่เกิน ${CLAUDE_EXPORT_TESTERS_MAX} คน` });
          return true;
        }
        db.setSetting(CLAUDE_EXPORT_TESTERS_KEY, JSON.stringify(ids));
        db.addAudit({
          operator: username,
          action: "claude_export_testers_set",
          target: CLAUDE_EXPORT_TESTERS_KEY,
          detail: JSON.stringify({ count: ids.length }),
        });
        json(res, 200, { ok: true, ids, max: CLAUDE_EXPORT_TESTERS_MAX });
        return true;
      }
    }

    /* ---- W3: GET /console/api/channels — รายการสาขา read-only (ไม่มี secret เด็ดขาด) ---- */
    // เพิ่ม/แก้สาขา = แก้ไฟล์ CHANNELS_FILE แล้ว restart process (จงใจ — ไฟล์ secret
    // อยู่นอก DB/นอก git; console ไม่มีสิทธิ์เขียน secret) — ดู docs/HANDOFF.md
    if (req.method === "GET" && route[0] === "channels" && route.length === 1) {
      // 1 ก.ย. 2026: ตัดเฉพาะฟิลด์ ไม่ปิดทั้งเส้น — ชมพู่ต้องใช้ id/ชื่อสาขาไปกรอง chip
      // ในหน้าภาพรวม แชท ออเดอร์ และเลือก OA ตอนบรอดแคส ปิดทั้งเส้น = chip พังทุกหน้า
      // แต่ hasSecret/hasToken/destination คือ "สถานะการต่อ webhook" ที่พี่ง้วงสั่งไม่ให้เห็น
      const canSeeWiring = hasOperatorCapability(operator, "integrations.manage");
      // destination (bot user id) ที่เคย verify แล้ว — map กลับให้เห็นว่า OA ไหนต่อสาขาไหน
      let destByChannel = new Map();
      if (canSeeWiring) {
        try {
          destByChannel = new Map(db.listDestinationMappings().map((m) => [m.channelId, m.destination]));
        } catch { /* อ่าน mapping พัง = โชว์ "—" ห้ามลากหน้าล้ม */ }
      }
      json(res, 200, {
        ok: true,
        channels: channels.map((ch) => ({
          id: ch.id,
          name: ch.name || "",
          active: ch.active !== false,
          ...(canSeeWiring ? {
            hasSecret: Boolean(ch.channelSecret),
            hasToken: Boolean(ch.channelAccessToken),
            destination: destByChannel.get(ch.id) || "",
          } : {}),
        })),
        multi: channels.length > 1,
      });
      return true;
    }

    /* ---- 18 ต.ค. 2026 (ขั้นที่ 2 ของแผน soul): GET /console/api/soul — ตัวตนที่ใช้จริง อ่านอย่างเดียว ---- */
    // รุ่น · hash · ข้อความที่แต่ละเส้นได้ · สัญญา C1/C2 · ลำดับชั้น — มีแต่ข้อความที่ส่งเข้าโมเดลอยู่แล้ว ไม่มีข้อมูลลูกค้า
    // สิทธิ์เดียวกับหน้าความรู้ (persona เดิมก็โชว์ที่นั่น) · การแก้ soul จากคอนโซลเป็นงานขั้นที่ 4 (soul.publish ของ owner)
    if (req.method === "GET" && route[0] === "soul" && route.length === 1) {
      if (!hasOperatorCapability(operator, "knowledge.manage")) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ดูตัวตนของ AI" });
        return true;
      }
      json(res, 200, { ok: true, ...soulInfo({ followupFallback: String(brain.persona || ""), rollout: soulRolloutInfo(db) }) });
      return true;
    }

    /* ---- G4 transparency: GET /console/api/brain — ทุกอย่างที่ AI โหลดเข้าหัวจริง ---- */
    // read-only สำหรับหน้า "ความรู้" (session คุมจาก consoleApi แล้ว — ถึงตรงนี้คือ auth ผ่าน)
    if (req.method === "GET" && route[0] === "brain" && route.length === 1) {
      let knowledge = { total: 0, active: 0, injectedChars: 0, maxChars: KNOWLEDGE_MAX_CHARS, approxTokens: 0, droppedEntries: 0 };
      try {
        const rows = db.listKnowledge();
        // v1.3.4: การตัดความรู้เคยเห็นได้แค่ใน log ซึ่งไม่มีใครเปิดดู — ทีมงานต้องเห็นบนหน้าจอ
        let dropped = 0;
        const section = knowledgeSectionFromDb(db, {
          logger: {
            ...logger,
            warn: (message) => {
              const matched = /ตัดรายการเก่าสุดทิ้ง (\d+) รายการ/u.exec(String(message));
              if (matched) dropped = Number(matched[1]);
              else if (/ยาวเกิน/u.test(String(message))) dropped = 1;
              logger.warn?.(message);
            },
          },
        });
        knowledge = {
          total: rows.length,
          active: rows.filter((r) => r.active === 1).length,
          injectedChars: section.length,
          droppedEntries: dropped,
          maxChars: KNOWLEDGE_MAX_CHARS,
          // ไทย ~3 ตัวอักษร/token โดยประมาณ — ป้ายบอกขนาด ไม่ใช่บิลจริง
          approxTokens: Math.ceil(section.length / 3),
        };
        // 19 ต.ค. 2026 (คลังรีวิวนอกพรอมต์): เมตรสองตัว — คลังความรู้ (งบ 80,000 ไม่นับคลังรีวิว) + คลังรีวิว (งบ 40,000)
        // ขนาดที่แนบต่อคำตอบ = ก้อนความรู้หลังตัดรายการรีวิว (คำตอบจริงบวกรายการที่โค้ดเลือกอีก 1–2 บรรทัด)
        if (catalogOutOfPrompt(db)) {
          const usage = knowledgeUsage(db.listActiveKnowledge(null), { separateCatalog: true });
          const attached = stripCatalogItems(section, []);
          knowledge = {
            ...knowledge,
            injectedChars: attached.length,
            approxTokens: Math.ceil(attached.length / 3),
            budgetChars: usage.totalChars,
            catalogChars: usage.catalogChars,
            catalogMaxChars: REVIEW_CATALOG_MAX_CHARS,
          };
        }
      } catch { /* DB พัง = โชว์ศูนย์ ห้ามลากหน้าล้ม */ }
      let approvedPrices = [];
      try {
        approvedPrices = db.approvedPrices();
      } catch {
        approvedPrices = [];
      }
      json(res, 200, {
        ok: true,
        brandPack: String(brain.brandPack || ""),
        persona: String(brain.persona || ""),
        safetyRules: (brain.safetyRules || []).map((r) => ({
          keywords: r.keywords || [], template: r.template || "", reason: r.reason || "",
        })),
        approvedPrices,
        images: (imageCatalog || []).map((e) => ({
          key: e.key, url: e.url, previewUrl: e.previewUrl || e.url,
          description: e.description || "", needsVerification: e.needsVerification === true,
        })),
        models: currentModels(),
        knowledge,
      });
      return true;
    }

    /* ---- G6 (P1): สมอง AI ต่อสาขา — โหมด shared/separate + addendum ต่อ channel ---- */
    // ความหมาย (ดู knowledgePack.mjs): separate = brand pack กลางเป็นฐาน + addendum
    // สาขา + ความรู้เฉพาะสาขา; ราคา/รูป/กฎความปลอดภัยใช้กลางร่วมกันเสมอทุกโหมด
    if (route[0] === "settings" && route[1] === "brain") {
      if (req.method === "GET" && route.length === 2) {
        json(res, 200, {
          ok: true,
          multi: channels.length > 1,
          channels: channels.map((ch) => ({
            id: ch.id,
            name: ch.name || "",
            active: ch.active !== false,
            mode: brainModeOf(db, ch.id),
            addendum: (() => {
              try {
                return db.getSetting(brainAddendumKey(ch.id)) || "";
              } catch {
                return "";
              }
            })(),
          })),
        });
        return true;
      }
      if (req.method === "POST" && route.length === 3) {
        if (await queueOrDeny("brain.publish", "brain_publish", (body) => {
          const target = decodeURIComponent(route[2]);
          const parts = [];
          if (body.mode !== undefined) parts.push(body.mode === "separate" ? "สมองแยกของสาขา" : "สมองกลาง");
          if (body.addendum !== undefined) parts.push(`ข้อความเสริม ${String(body.addendum).trim().length} ตัวอักษร`);
          return `สมอง AI ของ ${target}: ${parts.join(" · ") || "ไม่ระบุ"}`;
        })) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const channelId = decodeURIComponent(route[2]);
        if (!channels.some((ch) => ch.id === channelId)) {
          json(res, 404, { ok: false, error: "channel ไม่อยู่ในรายการสาขา" });
          return true;
        }
        const body = await readJson(req);
        if (body.mode !== undefined && body.mode !== BRAIN_MODE_SHARED && body.mode !== BRAIN_MODE_SEPARATE) {
          json(res, 400, { ok: false, error: "mode ต้องเป็น shared หรือ separate" });
          return true;
        }
        if (body.addendum !== undefined
          && (typeof body.addendum !== "string" || body.addendum.length > BRAIN_ADDENDUM_MAX)) {
          json(res, 400, { ok: false, error: `addendum ต้องเป็นข้อความไม่เกิน ${BRAIN_ADDENDUM_MAX.toLocaleString("th-TH")} ตัวอักษร` });
          return true;
        }
        if (body.mode === undefined && body.addendum === undefined) {
          json(res, 400, { ok: false, error: "ไม่มีข้อมูลให้บันทึก (ส่ง mode/addendum อย่างน้อย 1 อย่าง)" });
          return true;
        }
        // โหมดสมอง/ข้อความเสริมยังไม่ใช่การ์ดในเฟสนี้ (channel_addendum เปิดที่ P4) เส้นนี้จึง
        // จบที่ผล "สมองไม่เปลี่ยน" เสมอ — ที่เดินผ่าน hook เพราะกติกาของเฟสนี้คือ "ไม่มีทาง
        // เขียนไหนที่แตะข้อมูลตั้งต้นของ AI แล้วไม่ผ่านจุดคอขวดเดียวกัน" วันที่ addendum
        // กลายเป็นการ์ด เส้นนี้จะได้ด่านครบทันทีโดยไม่ต้องแก้อะไรตรงนี้
        const brainSettingWrite = brainWrite("brain_publish", {
          audit: null,
          apply: () => {
            if (body.mode !== undefined) {
              const before = brainModeOf(db, channelId);
              db.setSetting(brainModeKey(channelId), body.mode);
              if (before !== body.mode) {
                db.addAudit({
                  operator: username, action: "brain_mode_change", target: channelId,
                  detail: `${before} -> ${body.mode}`,
                });
              }
            }
            if (body.addendum !== undefined) {
              db.setSetting(brainAddendumKey(channelId), body.addendum.trim());
              db.addAudit({
                operator: username, action: "brain_addendum_edit", target: channelId,
                detail: `${body.addendum.trim().length} ตัวอักษร`,
              });
            }
          },
        });
        if (!brainSettingWrite) return true;
        json(res, 200, {
          ok: true,
          channelId,
          mode: brainModeOf(db, channelId),
          addendum: db.getSetting(brainAddendumKey(channelId)) || "",
          brain: brainInfo(brainSettingWrite),
        });
        return true;
      }
    }

    /* ---- คิวรีวิวคำแก้ (ย้ายจาก consoleApi.mjs — พฤติกรรม/เส้นทางเดิมทุกตัวอักษร) ---- */
    if (req.method === "GET" && route[0] === "corrections" && route.length === 1) {
      const status = url.searchParams.get("status") || "candidate";
      if (!["candidate", "approved", "rejected"].includes(status)) {
        json(res, 400, { ok: false, error: "status ต้องเป็น candidate, approved หรือ rejected" });
        return true;
      }
      const limit = Math.min(200, Number(url.searchParams.get("limit")) || 100);
      // ค่าเริ่มต้นคือคิวทำงาน: ตัดใบที่มีข้อความก่อน/หลังเหมือนกันออก แต่ไม่ลบ
      // หลักฐานเดิม ผู้ดูแลยังขออ่านประวัติครบได้ด้วย includeNoopHistory=true
      // (ไม่มี migration/cleanup ที่จะทำให้ดูคล้ายว่าระบบเคยสอนมันแล้ว)
      const includeNoopHistory = url.searchParams.get("includeNoopHistory") === "true";
      const working = status === "candidate" && !includeNoopHistory;
      const page = working ? db.listCorrectionWorkQueue(limit) : { corrections: db.listCorrections(status, limit), hiddenNoopCount: 0 };
      json(res, 200, {
        ok: true, corrections: page.corrections,
        hiddenNoopCount: page.hiddenNoopCount,
      });
      return true;
    }

    // ตัดสินคำแก้: อนุมัติเข้า Brain Pack rebuild รายสัปดาห์ / ปัดตก
    // อนุมัติ = DATA เท่านั้น — ไม่มี auto-prompt-mutation ที่นี่ (rebuild เป็นงานคนตามแผนแพลตฟอร์ม)
    if (req.method === "POST" && route[0] === "corrections" && route[2] === "decide" && route.length === 3) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const correctionId = decodeURIComponent(route[1]);
      const body = await readJson(req);
      const action = String(body.action || "");
      if (action !== "approve" && action !== "reject") {
        json(res, 400, { ok: false, error: "action ต้องเป็น approve หรือ reject" });
        return true;
      }
      const row = db.getCorrection(correctionId);
      if (!row) {
        json(res, 404, { ok: false, error: "ไม่พบคำแก้นี้" });
        return true;
      }
      if (row.status !== "candidate") {
        json(res, 409, { ok: false, error: `คำแก้นี้ถูกตัดสินไปแล้ว (${row.status})` });
        return true;
      }

      // "คำตอบที่ควรเป็น" (optional) — บันทึกลง human_final ก่อนอนุมัติ
      let humanFinal;
      if (action === "approve" && typeof body.humanFinal === "string" && body.humanFinal.trim()) {
        humanFinal = body.humanFinal.trim();
        if (humanFinal.length > 2000) {
          json(res, 400, { ok: false, error: "คำตอบที่ควรเป็นต้องไม่เกิน 2000 ตัวอักษร" });
          return true;
        }
      }
      // รายการเก่าที่ต่างกันเพียง marker/ช่องว่างอาจยังค้างเป็น candidate ได้
      // รักษาหลักฐานไว้ แต่ห้ามให้สถานะ "approve" ทำให้ดูเหมือนเป็นบทเรียน
      // ผู้ใช้ยังพิมพ์คำแก้ใหม่ที่ต่างจริงใน humanFinal แล้วอนุมัติได้ตามปกติ
      const teachFinal = humanFinal ?? String(row.human_final || "");
      if (action === "approve" && !isTeachableCorrection(row.ai_draft, teachFinal)) {
        json(res, 409, {
          ok: false,
          error: teachFinal.trim()
            ? "รายการนี้ไม่มีการแก้เนื้อความ จึงอนุมัติเป็นบทเรียนไม่ได้"
            : "กรอกคำตอบที่แก้จากร่างจริงก่อน จึงอนุมัติเป็นบทเรียนได้",
        });
        return true;
      }

      // เฟส 3 (กล่องตรวจ): ปุ่ม "ไม่ต้องสอน" ส่งเหตุผลมาด้วย — เขียนลงคอลัมน์ reason ที่มีอยู่แล้ว
      // ไม่ส่งมา = ไม่แตะคอลัมน์นั้น เส้นตัดสินเดิมจากหน้าคำแก้จึงเหมือนเดิมทุกไบต์
      const dismissReason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      const updated = db.updateCorrection(correctionId, {
        status: action === "approve" ? "approved" : "rejected",
        humanFinal,
        ...(dismissReason ? { reason: dismissReason } : {}),
        decidedBy: username,
      });
      if (!updated) {
        json(res, 409, { ok: false, error: "คำแก้นี้ถูกตัดสินไปแล้ว" });
        return true;
      }

      db.addAudit({
        operator: username,
        action: action === "approve" ? "correction_approve" : "correction_reject",
        target: correctionId,
        detail: `customer=${row.customer_id}${dismissReason ? ` · ${dismissReason}` : ""}`,
      });
      json(res, 200, { ok: true, correction: updated });
      return true;
    }

    /* ---- Daily learning: proposal-only, human-approved, default OFF ---- */
    if (route[0] === "learning") {
      if (!learning) {
        json(res, 503, { ok: false, error: "ระบบเรียนรู้รายวันยังไม่พร้อม" });
        return true;
      }

      if (req.method === "GET" && route.length === 1) {
        const snap = learning.snapshot();
        // ตัดทั้งเส้นไม่ได้ เพราะหน้า "เรียนรู้" ที่ชมพู่ใช้รีวิวคำแก้อ่าน snapshot ตัวนี้
        if (hasOperatorCapability(operator, "finance.view")) {
          json(res, 200, { ok: true, ...snap, trainingIntake: trainingIntakeReadiness({ config, db }) });
          return true;
        }
        // 2 ก.ย. 2026: ตัด budgetUsd อย่างเดียวไม่พอ — runs มาจาก SELECT * ของตาราง
        // learning_runs (dbLearning.listLearningRuns) จึงพา usd / llm_calls / tokens_in /
        // tokens_out ติดมาเต็ม ๆ ทั้งที่เป็นต้นทุนก้อนเดียวกับที่เพิ่งกันไปแล้วสองจุด
        // ใช้ allowlist ไม่ใช่ blocklist: วันหน้าเพิ่มคอลัมน์ต้นทุนใหม่ในตาราง มันจะไม่
        // หลุดออก API เองเงียบ ๆ (ฟิลด์ที่เหลือคือชุดที่ console.js learningControl ใช้จริง)
        const { budgetUsd, runs, ...rest } = snap;
        json(res, 200, { ok: true, ...rest, runs: (runs || []).map(publicLearningRun),
          trainingIntake: trainingIntakeReadiness({ config, db }) });
        return true;
      }

      if (req.method === "GET" && route[1] === "probes" && route.length === 2) {
        if (operator?.role !== "owner") {
          json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่ส่งออกชุดคำถามประเมินได้" });
          return true;
        }
        // The export deliberately contains no provider/customer identity. The
        // only identifiers are domain-separated hashes of message ids.
        json(res, 200, { ok: true, ...learning.exportProbeSet() });
        return true;
      }

      if (req.method === "POST" && route[1] === "toggle" && route.length === 2) {
        if (operator?.role !== "owner") {
          json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่เปิดระบบเรียนรู้รายวันได้" });
          return true;
        }
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") {
          json(res, 400, { ok: false, error: "enabled ต้องเป็น boolean" });
          return true;
        }
        db.setSetting(LEARNING_ENABLED_KEY, body.enabled ? "1" : "0");
        db.addAudit({
          operator: username,
          action: "learning_toggle",
          target: LEARNING_ENABLED_KEY,
          detail: body.enabled ? "on" : "off",
        });
        json(res, 200, { ok: true, ...learning.snapshot() });
        return true;
      }

      if (req.method === "POST" && route[1] === "run" && route.length === 2) {
        if (operator?.role !== "owner") {
          json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่สั่งประมวลผลได้" });
          return true;
        }
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const result = await learning.runOnce();
        db.addAudit({
          operator: username,
          action: "learning_run",
          detail: JSON.stringify({
            skipped: result?.skipped === true,
            reason: result?.reason || "",
            candidatesCreated: Number(result?.candidatesCreated || 0),
          }),
        });
        json(res, 200, { ok: true, result, ...learning.snapshot() });
        return true;
      }

      if (req.method === "POST" && route[1] === "rollback-week" && route.length === 2) {
        if (operator?.role !== "owner") {
          json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่ย้อนการเรียนรู้ได้" });
          return true;
        }
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (body.confirm !== "ROLLBACK") {
          json(res, 400, { ok: false, error: "ต้องยืนยันคำว่า ROLLBACK" });
          return true;
        }
        // ทางเขียนที่สามของตระกูลเดียวกับคลังรีวิว/ข้อเสนอการเรียนรู้: ปิดความรู้ที่ระบบ
        // เรียนมาทั้งสัปดาห์ (active=0 หลายแถวรวด) ถ้าไม่ผ่าน hook ตารางเดิมจะหดลงหนึ่งสัปดาห์
        // โดยที่รุ่นสมองไม่ขยับตาม แล้ว parity แตกเงียบ ๆ ตรงวินาทีที่เจ้าของกดวาล์วนิรภัย
        let result;
        const rolled = brainWrite("learning_rollback_week", {
          audit: null,
          apply: () => {
            result = learning.rollbackWeek({ operator: username });
            db.addAudit({
              operator: username,
              action: "learning_rollback_week",
              detail: JSON.stringify({ deactivated: result.deactivated, since: result.since }),
            });
            return result;
          },
        });
        if (!rolled) return true;
        json(res, 200, { ...result, brain: brainInfo(rolled) });
        return true;
      }

      if (req.method === "POST" && route[2] === "decide" && route.length === 3) {
        if (operator?.role !== "owner") {
          json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่ตัดสินข้อเสนอการเรียนรู้ได้" });
          return true;
        }
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const action = String(body.action || "");
        // อนุมัติข้อเสนอการเรียนรู้ = เขียน knowledge_entries เหมือนกัน จึงต้องเดินผ่าน hook
        // (ปัดตกไม่แตะคลังความรู้ จึงไม่ต้องออกรุ่น — hook จะตอบ unchanged ให้เองอยู่แล้ว)
        let result;
        const decision = brainWrite("learning_apply", {
          audit: null,
          apply: () => {
            result = learning.decideCandidate(decodeURIComponent(route[1]), {
              action,
              operator: username,
              title: body.title,
              content: body.content,
              supersedesId: body.supersedesId,
            });
            // ข้อเสนอที่ระบบปฏิเสธเอง ไม่ใช่การเขียนที่ด่านต้องตัดสิน — ปล่อยให้ตอบตามเดิม
            return result;
          },
        });
        if (!decision) return true;
        if (!result.ok) {
          const messages = {
            not_proposed: "ข้อเสนอนี้ถูกตัดสินไปแล้ว",
            invalid_action: "action ไม่ถูกต้อง",
            invalid_title: `หัวข้อต้องมี 1-${KNOWLEDGE_TITLE_MAX} ตัวอักษร`,
            invalid_content: `เนื้อหาต้องมี 1-${KNOWLEDGE_CONTENT_MAX.toLocaleString("th-TH")} ตัวอักษร`,
            stale_knowledge: "คลังความรู้เปลี่ยนหลังสร้างข้อเสนอ กรุณาแก้/ตรวจข้อเสนอใหม่ก่อนอนุมัติ",
            risk_blocked: "ข้อเสนอนี้มีข้อมูลเสี่ยง ต้องเพิ่มเข้าคลังความรู้ด้วยคนโดยตรง",
            human_source_conflict: "หัวข้อนี้ชนกับความรู้ที่คนเพิ่มไว้ ระบบจะไม่ทับข้อมูลของคน",
            supersede_required: "หัวข้อนี้ชนกับความรู้ที่ระบบเคยเรียน ต้องยืนยันแทนที่รายการเดิม",
            invalid_supersede_target: "รายการที่จะถูกแทนที่ไม่ตรงกับสถานะล่าสุด",
            intake_evidence_invalid: "ที่มาของข้อเสนอนำเข้าไม่ครบหรือไม่ถูกต้อง กรุณาสร้างข้อเสนอใหม่",
            intake_recreate_required: "ข้อความนำเข้าถูกล็อกเพื่อรักษาที่มา กรุณาปัดตกแล้วเสนอข้อความที่แก้แล้วใหม่",
            intake_entry_hash_mismatch: "ข้อความไม่ตรงกับหลักฐานที่นำเข้า กรุณาสร้างข้อเสนอใหม่",
            intake_risk_blocked: "ข้อเสนอนำเข้ามีข้อมูลเสี่ยง กรุณาสร้างข้อเสนอที่ตัดข้อมูลเสี่ยงแล้วใหม่",
            intake_not_ready: "ระบบยังไม่พร้อมรับความรู้ที่แยกตามคลาส กรุณาตรวจการตั้งค่าก่อน",
            intake_metadata_risk_blocked: "หมวดวิชาหรือชื่อคลาสมีข้อมูลเสี่ยง กรุณาสร้างข้อเสนอใหม่",
            intake_scope_stale: "สถานะสมองของช่องทางเปลี่ยนแล้ว กรุณาสร้างข้อเสนอใหม่",
            existing_knowledge_conflict: "มีข้อความนี้ในคลังแล้ว กรุณาตรวจหมวดวิชาและคลาสในหน้าความรู้ก่อน",
          };
          const status = ["invalid_action", "invalid_title", "invalid_content"].includes(result.code) ? 400 : 409;
          json(res, status, { ok: false, error: messages[result.code] || "ตัดสินข้อเสนอไม่สำเร็จ", ...result });
          return true;
        }
        db.addAudit({
          operator: username,
          action: `learning_${action}`,
          target: decodeURIComponent(route[1]),
          detail: `${result.entry?.id ? `knowledge=${result.entry.id}` : ""}`
            + `${decision.seq ? ` · รุ่นสมอง ${decision.seq}` : ""}`,
        });
        json(res, 200, { ...result, brain: brainInfo(decision) });
        return true;
      }
    }

    /* ---- M1: เปลี่ยนรหัสผ่านตัวเอง — bump token_version = ตัด session อื่นทุกใบทันที ---- */
    // ต้องยืนยันรหัสปัจจุบันก่อนเสมอ (session ที่ถูกขโมยเปลี่ยนรหัสไม่ได้ถ้าไม่รู้รหัสเดิม)
    // สำเร็จ = ออก cookie ใหม่ (เวอร์ชันใหม่) ให้เครื่องนี้ทำงานต่อ + csrf ใหม่ใน response
    if (req.method === "POST" && route[0] === "password" && route.length === 1) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const body = await readJson(req);
      const currentPassword = String(body.currentPassword ?? "");
      const newPassword = String(body.newPassword ?? "");
      if (newPassword.length < PASSWORD_MIN) {
        json(res, 400, { ok: false, error: `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${PASSWORD_MIN} ตัวอักษร` });
        return true;
      }
      const operator = db.getOperator(username);
      if (!operator || !verifyPassword(currentPassword, operator.pass_hash)) {
        json(res, 403, { ok: false, error: "รหัสผ่านปัจจุบันไม่ถูกต้อง" });
        return true;
      }
      db.changeOperatorPassword(username, hashPassword(newPassword));
      const fresh = db.getOperator(username);
      const issued = sessions.issue(username, { tokenVersion: fresh.token_version });
      res.setHeader("set-cookie", sessionCookie(issued.token, {
        ttlMs: sessions.ttlMs, secure: config.consoleCookieSecure,
      }));
      // เปลี่ยนรหัสแล้วต้องย้ายเครื่องที่เปิดแจ้งเตือนไว้มาผูกกับ session ใหม่ด้วย
      // ไม่งั้นแถวเดิมถือ token_version เก่า แล้วถูกคิวรีส่งจริงตัดทิ้งถาวร —
      // ผู้ใช้จะเห็นแค่ "เครื่องนี้ใช้งานต่อได้" ซึ่งจริงเฉพาะหน้าแชท ไม่จริงกับแจ้งเตือน
      webPush?.rebindSession?.({
        operatorUsername: username, sessionId: issued.sid,
        sessionExpiresAt: issued.exp, tokenVersion: fresh.token_version,
      });
      // audit ไม่มี detail — ห้ามมีรหัสผ่าน (แม้บางส่วน) หลุดเข้า log ทุกกรณี
      db.addAudit({ operator: username, action: "password_change" });
      json(res, 200, { ok: true, csrf: issued.csrf });
      return true;
    }

    /* ---- M5: ตารางราคา approved_prices (guard) — CRUD จาก console แทนการแก้ SQLite มือ ---- */
    // guard อ่านตารางสดทุก checkOutbound (closure getApprovedPrices) — แก้แล้วมีผลทันที ไม่ต้อง restart
    if (route[0] === "prices") {
      if (req.method === "GET" && route.length === 1) {
        json(res, 200, { ok: true, prices: db.approvedPrices() });
        return true;
      }
      if (req.method === "POST" && route.length === 1) {
        if (await queueOrDeny("prices.manage", "price_add",
          (body) => `เพิ่มราคา "${String(body.label ?? "").trim()}" = ${body.amount} บาท`)) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const label = typeof body.label === "string" ? body.label.trim() : "";
        const amount = Number(body.amount);
        if (!label || label.length > PRICE_LABEL_MAX) {
          json(res, 400, { ok: false, error: `ชื่อรายการต้องมี 1-${PRICE_LABEL_MAX} ตัวอักษร` });
          return true;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
          json(res, 400, { ok: false, error: "amount ต้องเป็นตัวเลขมากกว่า 0" });
          return true;
        }
        // ชื่อที่ต่างกันแค่ช่องว่าง/ตัวพิมพ์ คือชื่อเดียวกันสำหรับคนอ่าน แต่เป็นสองแถวสำหรับ
        // ตัวกรอง — ผลคือลูกแพรพูดราคาสองค่าได้พร้อมกันโดยไม่มีใครเห็นว่าเกิดขึ้นตอนไหน
        const existing = db.getApprovedPrice(label)
          ?? db.approvedPrices().find((row) => normalizedPriceLabel(row.label) === normalizedPriceLabel(label));
        if (existing) {
          json(res, 409, {
            ok: false,
            error: `มีรายการนี้อยู่แล้ว ("${existing.label}") — แก้ยอดในรายการเดิมแทน`,
            existingLabel: existing.label,
          });
          return true;
        }
        if (duplicateTeach(body)) {
          json(res, 409, { ok: false, error: "ส่งไปแล้วเมื่อครู่นี้ — ตรวจในตารางราคาก่อนส่งใหม่นะคะ" });
          return true;
        }
        const addPriceTeach = teachContext(body, label);
        if (addPriceTeach === TEACH_REFUSED) return true;
        const added = brainWrite("price_add", {
          audit: { action: "price_add", target: label, detail: String(amount) },
          teach: addPriceTeach,
          apply: () => db.setApprovedPrice(label, amount),
        });
        if (!added) return true;
        json(res, 200, { ok: true, prices: db.approvedPrices(), brain: brainInfo(added) });
        return true;
      }
      if (req.method === "POST" && route.length === 2) {
        if (await queueOrDeny("prices.manage", "price_edit",
          (body) => `แก้ยอด "${decodeURIComponent(route[1])}" เป็น ${body.amount} บาท`)) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const label = decodeURIComponent(route[1]);
        const row = db.getApprovedPrice(label);
        if (!row) {
          json(res, 404, { ok: false, error: "ไม่พบรายการราคานี้" });
          return true;
        }
        const body = await readJson(req);
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          json(res, 400, { ok: false, error: "amount ต้องเป็นตัวเลขมากกว่า 0" });
          return true;
        }
        if (duplicateTeach(body)) {
          json(res, 409, { ok: false, error: "ส่งไปแล้วเมื่อครู่นี้ — ตรวจในตารางราคาก่อนส่งใหม่นะคะ" });
          return true;
        }
        const editPriceTeach = teachContext(body, label);
        if (editPriceTeach === TEACH_REFUSED) return true;
        const edited = brainWrite("price_edit", {
          audit: { action: "price_edit", target: label, detail: `${row.amount} -> ${amount}` },
          teach: editPriceTeach,
          apply: () => db.setApprovedPrice(label, amount),
        });
        if (!edited) return true;
        json(res, 200, { ok: true, prices: db.approvedPrices(), brain: brainInfo(edited) });
        return true;
      }
      if (req.method === "DELETE" && route.length === 2) {
        if (await queueOrDeny("prices.manage", "price_delete",
          () => `ลบรายการราคา "${decodeURIComponent(route[1])}"`)) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const label = decodeURIComponent(route[1]);
        const row = db.getApprovedPrice(label);
        if (!row) {
          json(res, 404, { ok: false, error: "ไม่พบรายการราคานี้" });
          return true;
        }
        const removed = brainWrite("price_delete", {
          audit: { action: "price_delete", target: label, detail: String(row.amount) },
          apply: () => db.deleteApprovedPrice(label),
        });
        if (!removed) return true;
        json(res, 200, { ok: true, prices: db.approvedPrices(), brain: brainInfo(removed) });
        return true;
      }
    }

    // Advice costs output tokens in the scoring call. This switch controls
    // generation, not just visibility, and never changes scoring or replies.
    if (route[0] === "settings" && route[1] === "suggestions" && route.length === 2) {
      if (!hasOperatorCapability(operator, "integrations.manage")) {
        json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
        return true;
      }
      if (req.method === "GET") {
        json(res, 200, { ok: true, enabled: scorerSuggestionsEnabled(db) });
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (typeof body?.enabled !== "boolean") {
          json(res, 400, { ok: false, error: "enabled ต้องเป็น boolean" });
          return true;
        }
        db.setSetting(SCORER_SUGGESTIONS_KEY, body.enabled ? "1" : "0");
        db.addAudit({ operator: username, action: "scorer_suggestions_toggle", target: SCORER_SUGGESTIONS_KEY, detail: body.enabled ? "on" : "off" });
        json(res, 200, { ok: true, enabled: scorerSuggestionsEnabled(db) });
        return true;
      }
    }

    /* ---- G2b (B8): model picker — GET รายการ+ราคา / POST สลับโมเดล runtime ---- */
    if (route[0] === "models" && route.length === 1) {
      // ราคาต่อ 1M token + สวิตช์สลับโมเดล = การเชื่อมต่อผู้ให้บริการ + ตัวเลขต้นทุน
      if (!hasOperatorCapability(operator, "integrations.manage")) {
        json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
        return true;
      }
      if (req.method === "GET") {
        const rate = fxNow();
        json(res, 200, {
          ok: true,
          models: modelPricing,
          replyModels: replyModelPricing,
          scorerModels: scorerModelPricing,
          followupModels: followupModelPricing,
          suggestionsEnabled: scorerSuggestionsEnabled(db),
          defaultModel: config.hermesModel,
          scorerDefaultModel: config.hermesScorerModel || config.hermesModel,
          followupDefaultModel: config.hermesFollowupModel || "",
          thbPerUsd: rate.thbPerUsd,
          fxSource: rate.source,
          fxFetchedAt: rate.fetchedAt,
          ...currentModels(),
        });
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const target = String(body.target || "");
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (target !== "reply" && target !== "scorer" && target !== "followup") {
          json(res, 400, { ok: false, error: "target ต้องเป็น reply, scorer หรือ followup" });
          return true;
        }
        // v1.4.9: followup ยอมรับค่าว่าง = ล้าง override กลับไป "ตามตัวหลัก"
        const clearFollowupOverride = target === "followup" && model === "";
        // เลือกได้เฉพาะโมเดลในไฟล์ราคา (หรือ default จาก env) — กันพิมพ์ id มั่ว
        const targetModels = target === "reply" ? knownReplyModelIds
          : target === "scorer" ? knownScorerModelIds : knownFollowupModelIds;
        if (!clearFollowupOverride && (!model || !targetModels.has(model))) {
          json(res, 400, { ok: false, error: "model ไม่อยู่ในรายการที่ตั้งค่าไว้" });
          return true;
        }
        const key = target === "reply" ? "reply_model" : target === "scorer" ? "scorer_model" : "followup_model";
        const before = db.getSetting(key)
          || (target === "scorer" ? (config.hermesScorerModel || config.hermesModel)
            : target === "followup" ? (config.hermesFollowupModel || "ตามตัวหลัก") : config.hermesModel);
        db.setSetting(key, clearFollowupOverride ? "" : model);
        db.addAudit({
          operator: username, action: "model_change", target: key,
          // v1.4.9b: ล้าง override แล้วผลจริงคือ env default (ถ้าตั้ง) ไม่ใช่ "ตามตัวหลัก"
          // เสมอไป — audit ต้องบันทึกสถานะที่เกิดขึ้นจริง
          detail: `"${before}" -> "${clearFollowupOverride ? (config.hermesFollowupModel || "ตามตัวหลัก") : model}"`,
        });
        json(res, 200, { ok: true, ...currentModels() });
        return true;
      }
    }

    /* ---- G2a (F5): สวิตช์ follow-up global runtime (เก็บใน DB — ชนะ env) ---- */
    if (route[0] === "settings" && route[1] === "followup" && route.length === 2) {
      if (req.method === "GET") {
        // audit 2026-08-26 (วิกฤต): เดิมสวิตช์นี้เขียนและอ่านแค่ followup_enabled
        // ซึ่งเป็นของ followupEngine ตัวเก่าที่ "ไม่มีวันทำงาน" บนเครื่องนี้
        // เพราะ launcher ตรึง FOLLOWUP_INTERVAL_MS=0 ทำให้ start() ออกทันที
        // ตัวที่ส่งข้อความจริงคือ stagedFollowups ซึ่งอ่าน staged_followup_enabled
        // ผลคือหน้าเว็บขึ้น "เปิดอยู่" แต่คุมคนละเครื่องยนต์ = สวิตช์หลอก
        // ตอนนี้รายงานทั้งสองตัว และบอกด้วยว่าตัวไหน "ติดเครื่องอยู่จริง"
        json(res, 200, {
          ok: true,
          enabled: followupGlobalEnabled({ db, config }),
          envDefault: config.followupEnabled === true,
          runtimeOverride: db.getSetting("followup_enabled"),
          // ตัวจับเวลานัดหมายเดิมติดเครื่องอยู่ไหม (0 = ไม่มีวันทำงาน)
          appointmentArmed: Number(config.followupIntervalMs) > 0,
          // เครื่องยนต์ที่ส่งข้อความทักตามจริง
          stagedEnabled: db.getSetting("staged_followup_enabled") === "1"
            || (db.getSetting("staged_followup_enabled") !== "0" && config.stagedFollowupEnabled === true),
          stagedArmed: Number(config.stagedFollowupTickMs) > 0,
        });
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") {
          json(res, 400, { ok: false, error: "ต้องส่ง enabled เป็น boolean" });
          return true;
        }
        // เขียนทั้งสองกุญแจ เพื่อให้ปุ่มบนหน้าจอคุม "เครื่องยนต์ที่ส่งจริง" ด้วย
        // ไม่ใช่คุมแต่ตัวเก่าที่ตายแล้ว — นี่คือปุ่มหยุดฉุกเฉินที่คนต้องพึ่งได้จริง
        db.setSetting("followup_enabled", body.enabled ? "1" : "0");
        db.setSetting("staged_followup_enabled", body.enabled ? "1" : "0");
        db.addAudit({
          operator: username, action: "followup_global_toggle", detail: body.enabled ? "on" : "off",
        });
        json(res, 200, {
          ok: true,
          enabled: followupGlobalEnabled({ db, config }),
          stagedEnabled: body.enabled === true,
        });
        return true;
      }
    }

    /* ---- v1.4.47: สวิตช์หยุด AI ทั้งระบบ (cutover / kick off) — เก็บใน DB ชนะ env ---- */
    if (route[0] === "settings" && route[1] === "ai-pause" && route.length === 2) {
      if (req.method === "GET") {
        json(res, 200, {
          ok: true,
          paused: aiPausedNow({ db, config }),
          envDefault: config.aiPaused === true,
          runtimeOverride: db.getSetting(AI_PAUSE_SETTING),
          draftMode: aiPausedDraftModeOn({ db, config }),
          draftModeEnvDefault: config.aiPausedDraftMode === true,
        });
        return true;
      }
      if (req.method === "POST") {
        if (operator?.role !== "owner") {
          json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่หยุดหรือ kick off AI ทั้งระบบได้" });
          return true;
        }
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (typeof body.paused !== "boolean" && typeof body.draftMode !== "boolean") {
          json(res, 400, { ok: false, error: "ต้องส่ง paused หรือ draftMode เป็น boolean" });
          return true;
        }
        if (typeof body.paused === "boolean") {
          db.setSetting(AI_PAUSE_SETTING, body.paused ? "1" : "0");
          db.addAudit({
            operator: username, action: "ai_pause_toggle", detail: body.paused ? "paused" : "kick_off",
          });
        }
        if (typeof body.draftMode === "boolean") {
          db.setSetting(AI_PAUSE_DRAFT_SETTING, body.draftMode ? "1" : "0");
          db.addAudit({
            operator: username, action: "ai_pause_draft_toggle", detail: body.draftMode ? "draft_on" : "draft_off",
          });
        }
        json(res, 200, {
          ok: true,
          paused: aiPausedNow({ db, config }),
          draftMode: aiPausedDraftModeOn({ db, config }),
        });
        return true;
      }
    }

    /* ---- v1.4.49: ลิงก์คลาสฟรี — ส่งลิงก์นี้ในแชท = ติดป้าย "คลาสฟรี" อัตโนมัติ
       -> FU เว้น 7 วัน · ค่าว่าง = ระบบเฉย (เดาลิงก์ผิดเท่ากับกด FU เงียบใส่ลีดผิดคน) ---- */
    if (route[0] === "settings" && route[1] === "freeclass" && route.length === 2) {
      if (req.method === "GET") {
        let patterns = [];
        try { patterns = JSON.parse(db.getSetting(FREECLASS_PATTERNS_KEY) || "[]"); } catch { patterns = []; }
        json(res, 200, { ok: true, patterns: Array.isArray(patterns) ? patterns : [] });
        return true;
      }
      if (req.method === "POST") {
        if (await queueOrDeny("rules.manage", "freeclass_links", (body) => {
          const count = Array.isArray(body.patterns) ? body.patterns.filter(Boolean).length : 0;
          return count ? `ลิงก์คลาสฟรี ${count} ลิงก์` : "ล้างรายการลิงก์คลาสฟรี";
        })) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const raw = Array.isArray(body.patterns) ? body.patterns : null;
        if (!raw || raw.length > 10) {
          json(res, 400, { ok: false, error: "patterns ต้องเป็นรายการลิงก์ ไม่เกิน 10 รายการ" });
          return true;
        }
        const cleaned = [];
        for (const item of raw) {
          const value = typeof item === "string" ? item.trim() : "";
          if (!value) continue;
          if (value.length < 8 || value.length > 200) {
            json(res, 400, { ok: false, error: "แต่ละลิงก์ต้องยาว 8-200 ตัวอักษร (สั้นกว่านั้นเสี่ยงจับข้อความมั่ว)" });
            return true;
          }
          if (!cleaned.includes(value)) cleaned.push(value);
        }
        const freeclassWrite = brainWrite("freeclass_links", {
          audit: {
            action: "freeclass_links_update", target: "",
            detail: cleaned.length ? cleaned.join(" | ").slice(0, 200) : "(ล้างรายการ)",
          },
          apply: () => db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(cleaned)),
        });
        if (!freeclassWrite) return true;
        json(res, 200, { ok: true, patterns: cleaned, brain: brainInfo(freeclassWrite) });
        return true;
      }
    }

    /* ---- v1.5: Facebook Messenger — โทเคน/secret (write-only) + รายชื่อลูกค้าเก่า Lead Center ----
       โทเคนกรอกที่นี่เพื่อไม่ให้วิ่งผ่านแชท/อีเมล — GET ไม่คืนค่าจริงเด็ดขาด คืนแค่ "ตั้งแล้วหรือยัง"
       รายชื่อลูกค้าเก่า: คนในลิสต์นี้ทักมา = ปิด AI ให้ทีมดูแลตั้งแต่ยังไม่ทันตอบ (เกตใน facebookWebhook) */
    if (route[0] === "settings" && route[1] === "facebook" && route.length === 2) {
      // เส้นนี้ถือของสองประเภทที่คนละเจ้าของ — จึงกันเป็น "ฟิลด์" ไม่ใช่ "ทั้งเส้น"
      // (แบบเดียวกับ /channels ด้านบน):
      //   โทเคน/secret/verifyToken = การตั้ง webhook ตรงตัวที่สุดตามคำสั่งพี่ง้วง 1 ก.ย. 2026
      //     ก่อนแก้: พนักงานยิง POST เองได้ 200 เขียนทับ verifyToken/appSecret ได้จริง =
      //     คนเดียวตัดการเชื่อมต่อเพจ หรือชี้เพจไปเซิร์ฟเวอร์อื่นได้ในคลิกเดียว
      //   รายชื่อลูกค้าเก่า (Lead Center) = งานหน้างานของทีม ลูกค้าเก่าทักเข้าเพจแล้วต้อง
      //     ปิด AI ให้คนดูแลตั้งแต่ยังไม่ทันตอบ ถ้าปิดทั้งเส้น ชมพู่เติมชื่อไม่ได้ =
      //     บอทตอบลูกค้าเก่าแทนคนต่อไปจนกว่าพี่ง้วงจะว่างมาแก้เอง (2 ก.ย. 2026)
      // กันที่ handler ไม่ใช่ที่ allowlist เส้นทาง เพราะ admin ผ่าน allowlist ทุกเส้น
      const canManageFbWiring = hasOperatorCapability(operator, "integrations.manage");
      // คู่ [ชื่อ field ใน API, ชื่อแถวใน DB settings] — จงใจเป็น array ไม่ใช่ object:
      // ตัวสแกน release จับรูป `ชื่อลงท้าย token/secret: "literal"` แม้ค่าจะเป็นแค่ชื่อแถว
      const FB_SECRET_FIELDS = [
        ["pageAccessToken", FB_KEY_PAGE_ACCESS],
        ["appSecret", FB_KEY_APP],
        ["verifyToken", FB_KEY_VERIFY],
      ];
      if (req.method === "GET") {
        let known = [];
        try { known = JSON.parse(db.getSetting("fb_known_customers") || "[]"); } catch { known = []; }
        // has* คือ "ต่อสายแล้วหรือยัง" ของเพจ — สถานะการเชื่อมต่อ จึงไม่ส่งให้คนที่ไม่มีสิทธิ์
        // (ไม่ใช่ค่าจริงอยู่แล้ว แต่ตัดออกทั้งคีย์เพื่อไม่ให้หน้าเว็บวาดกล่องโทเคนที่กดไม่ได้)
        const configured = canManageFbWiring
          ? Object.fromEntries(FB_SECRET_FIELDS.map(([field, key]) => [
            `has${field[0].toUpperCase()}${field.slice(1)}`,
            Boolean(db.getSetting(key) || config[`fb${field[0].toUpperCase()}${field.slice(1)}`]),
          ]))
          : {};
        json(res, 200, {
          ok: true,
          enabled: config.fbEnabled === true,
          liveSend: config.fbLiveSend === true,
          // ห้ามคืนค่า secret — บอกแค่สถานะให้หน้า UI แสดง "ตั้งแล้ว/ยังไม่ตั้ง"
          ...configured,
          knownCustomers: Array.isArray(known) ? known : [],
        });
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        // ส่งฟิลด์โทเคนมาโดยไม่มีสิทธิ์ = ปฏิเสธทั้งคำขอ ห้ามบันทึกครึ่ง ๆ กลาง ๆ
        // (เช็คก่อนแตะ db เพื่อไม่ให้มีแถว audit จากคำขอที่ไม่ผ่าน)
        if (!canManageFbWiring && FB_SECRET_FIELDS.some(([field]) => body[field] !== undefined)) {
          json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
          return true;
        }
        const updated = [];
        for (const [field, settingKey] of FB_SECRET_FIELDS) {
          if (body[field] === undefined) continue;
          const value = typeof body[field] === "string" ? body[field].trim() : "";
          if (value.length > 1000) {
            json(res, 400, { ok: false, error: `${field} ยาวเกิน 1000 ตัวอักษร` });
            return true;
          }
          db.setSetting(settingKey, value);
          updated.push(field);
        }
        if (body.knownCustomers !== undefined) {
          const raw = Array.isArray(body.knownCustomers) ? body.knownCustomers : null;
          if (!raw || raw.length > 2000) {
            json(res, 400, { ok: false, error: "knownCustomers ต้องเป็นรายชื่อ ไม่เกิน 2,000 รายการ" });
            return true;
          }
          const cleaned = [];
          for (const item of raw) {
            const value = typeof item === "string" ? item.replace(/\s+/gu, " ").trim().slice(0, 120) : "";
            if (value && !cleaned.includes(value)) cleaned.push(value);
          }
          db.setSetting("fb_known_customers", JSON.stringify(cleaned));
          updated.push(`knownCustomers(${cleaned.length})`);
        }
        if (!updated.length) {
          json(res, 400, { ok: false, error: "ไม่มีข้อมูลให้บันทึก" });
          return true;
        }
        // audit บอกแค่ "ฟิลด์ไหนถูกแก้" — ห้ามมีค่า secret หรือชื่อลูกค้าใน audit เด็ดขาด
        db.addAudit({ operator: username, action: "fb_settings_update", detail: updated.join(", ") });
        json(res, 200, { ok: true, updated });
        return true;
      }
    }

    /* ---- v1.4.12b: สวิตช์คีย์เวิร์ดกิจกรรม # runtime (เก็บใน DB — ชนะ env) ---- */
    if (route[0] === "settings" && route[1] === "hashtag" && route.length === 2) {
      if (req.method === "GET") {
        json(res, 200, {
          ok: true,
          enabled: hashtagSilenceEnabled({ db, config }),
          envDefault: config.hashtagAutoResponseSilence === true,
          runtimeOverride: db.getSetting("hashtag_silence"),
          // v1.4.50: คีย์เวิร์ดธุรกิจที่ลูกแพรตอบเอง + ชุดมาตรฐานให้กดใช้ได้ทันที
          businessKeywords: hashtagBusinessKeywords({ db, config }),
          businessKeywordDefaults: hashtagBusinessDefaults(config?.brand),
          // 2026-09-04: วลีปุ่มคำถามสำเร็จรูป (Facebook / LINE rich menu) ที่ระบบต้องอ่านเป็น
          // "การกดปุ่ม" ไม่ใช่การพิมพ์ — อยู่เส้นเดียวกับคีย์เวิร์ด # เพราะเป็นของประเภทเดียวกัน:
          // ข้อความที่ไม่ได้ออกมาจากนิ้วลูกค้า · configured=false = ยังใช้ค่ามาตรฐานอยู่
          presetButtons: presetButtonPhrases({ db }),
          presetButtonDefaults: PRESET_BUTTON_DEFAULTS,
          presetButtonsConfigured: presetButtonPhrasesConfigured({ db }),
          presetButtonMax: PRESET_BUTTON_LIST_MAX,
        });
        return true;
      }
      if (req.method === "POST") {
        if (await queueOrDeny("rules.manage", "hashtag_rules", (body) => {
          const parts = [];
          if (typeof body.enabled === "boolean") parts.push(body.enabled ? "เปิดโหมดเงียบ #" : "ปิดโหมดเงียบ #");
          if (body.businessKeywords !== undefined) {
            parts.push(`คีย์เวิร์ดธุรกิจ ${Object.keys(body.businessKeywords || {}).length} คำ`);
          }
          if (body.presetButtons !== undefined) {
            parts.push(body.presetButtons === null
              ? "ปุ่มคำถามสำเร็จรูป: กลับไปใช้ค่ามาตรฐาน"
              : `ปุ่มคำถามสำเร็จรูป ${normalizePresetButtonPhrases(body.presetButtons).length} ข้อความ`);
          }
          return `คีย์เวิร์ดกิจกรรม #: ${parts.join(" · ") || "ไม่ระบุ"}`;
        })) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        // v1.4.50: รับได้ทั้งสวิตช์ # และรายการคีย์เวิร์ดธุรกิจ อย่างน้อยหนึ่งอย่าง
        // 2026-09-04: + รายการปุ่มคำถามสำเร็จรูป (อาร์เรย์ของสตริง · null = กลับไปใช้ค่ามาตรฐาน)
        if (typeof body.enabled !== "boolean" && body.businessKeywords === undefined && body.presetButtons === undefined) {
          json(res, 400, { ok: false, error: "ต้องส่ง enabled เป็น boolean หรือ businessKeywords หรือ presetButtons" });
          return true;
        }
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
          json(res, 400, { ok: false, error: "ต้องส่ง enabled เป็น boolean" });
          return true;
        }
        if (body.presetButtons !== undefined && body.presetButtons !== null && !Array.isArray(body.presetButtons)) {
          json(res, 400, { ok: false, error: `presetButtons ต้องเป็นรายการข้อความ (ไม่เกิน ${PRESET_BUTTON_LIST_MAX} รายการ) หรือ null เพื่อกลับไปใช้ค่ามาตรฐาน` });
          return true;
        }
        // ส่ง {} = ล้างรายการ กลับไปเป็นพฤติกรรม # เดิมทันที
        const cleanedKeywords = body.businessKeywords !== undefined
          ? normalizeHashtagBusinessKeywords(body.businessKeywords) : null;
        // ปุ่มสำเร็จรูป: อาร์เรย์ = เก็บรายการที่ทำสะอาดแล้ว ([] ที่ตั้งใจ = ปิดการจับปุ่ม) ·
        // null = ลบค่าที่ตั้งเอง (เก็บสตริงว่าง — ตัวอ่านถือว่า "ไม่มีแถว" แล้วใช้ค่ามาตรฐาน)
        const cleanedPresetButtons = Array.isArray(body.presetButtons)
          ? normalizePresetButtonPhrases(body.presetButtons) : null;
        const resetPresetButtons = body.presetButtons === null;
        // เส้นนี้เขียนได้สองแถวและมี audit สองใบ (คีย์เวิร์ด / สวิตช์เงียบ) จึงส่ง audit: null
        // แล้วเก็บ addAudit ไว้ข้างใน apply ตามเดิม — สองใบนั้นต้องเกิดหรือไม่เกิดพร้อมกับ
        // การเขียนจริงเสมอ ถ้าด่านไม่ผ่านแล้วธุรกรรมถูกยกเลิก audit ต้องหายไปด้วย
        const hashtagWrite = brainWrite("hashtag_rules", {
          audit: null,
          apply: () => {
            if (cleanedKeywords !== null) {
              db.setSetting("hashtag_business_keywords", JSON.stringify(cleanedKeywords));
              db.addAudit({
                operator: username, action: "hashtag_business_keywords_update",
                detail: Object.keys(cleanedKeywords).sort().join(",").slice(0, 200) || "(ล้างรายการ)",
              });
            }
            if (body.enabled !== undefined) {
              db.setSetting("hashtag_silence", body.enabled ? "1" : "0");
              db.addAudit({
                operator: username, action: "hashtag_silence_toggle", detail: body.enabled ? "on" : "off",
              });
            }
            if (cleanedPresetButtons !== null || resetPresetButtons) {
              db.setSetting(PRESET_BUTTON_PHRASES_KEY, resetPresetButtons ? "" : JSON.stringify(cleanedPresetButtons));
              // audit เก็บแค่วลีปุ่ม (ข้อความกลาง ๆ ของแพลตฟอร์ม) ไม่มีชื่อลูกค้าเข้ามาเกี่ยว
              db.addAudit({
                operator: username, action: "preset_buttons_update",
                detail: resetPresetButtons
                  ? "(กลับไปใช้ค่ามาตรฐาน)"
                  : cleanedPresetButtons.join(" | ").slice(0, 200) || "(ปิดการจับปุ่ม)",
              });
            }
          },
        });
        if (!hashtagWrite) return true;
        json(res, 200, {
          ok: true,
          enabled: hashtagSilenceEnabled({ db, config }),
          businessKeywords: hashtagBusinessKeywords({ db, config }),
          presetButtons: presetButtonPhrases({ db }),
          presetButtonsConfigured: presetButtonPhrasesConfigured({ db }),
          brain: brainInfo(hashtagWrite),
        });
        return true;
      }
    }

    /* ---- G7.1: สวิตช์ Owner Daily Digest runtime (เก็บใน DB — ชนะ env) ---- */
    // configured=false (ยังไม่ตั้ง DIGEST_LINE_USER_ID) = สวิตช์บันทึกได้แต่ engine ปิดสนิท
    if (route[0] === "settings" && route[1] === "digest" && route.length === 2) {
      // สรุปรายวันวิ่งเข้า LINE ของเจ้าของ — เป็นสายส่งออกที่พนักงานไม่ควรเห็นหรือปิดได้
      // กัน GET ด้วย ไม่ใช่แค่ POST: ถ้าปล่อย GET หน้าเว็บจะยังวาดสวิตช์ที่กดแล้วเด้ง 403
      if (!hasOperatorCapability(operator, "integrations.manage")) {
        json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
        return true;
      }
      const snapshot = () => ({
        ok: true,
        enabled: digestGlobalEnabled({ db, config }),
        envDefault: config.digestEnabled === true,
        runtimeOverride: db.getSetting(DIGEST_ENABLED_KEY),
        configured: Boolean(config.digestLineUserId),
        times: config.digestTimes,
        channelId: config.digestChannelId,
      });
      if (req.method === "GET") {
        json(res, 200, snapshot());
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") {
          json(res, 400, { ok: false, error: "ต้องส่ง enabled เป็น boolean" });
          return true;
        }
        db.setSetting(DIGEST_ENABLED_KEY, body.enabled ? "1" : "0");
        db.addAudit({
          operator: username, action: "digest_global_toggle", detail: body.enabled ? "on" : "off",
        });
        json(res, 200, snapshot());
        return true;
      }
    }

    /* ---- v1.1 (item 7): กติกาสินค้า — สอน AI ว่าสินค้าไหนควรคุยกับใคร ---- */
    // free text เข้า system prompt (ระดับเดียวกับคลังความรู้ — guard ราคายังคุมเสมอ)
    if (route[0] === "settings" && route[1] === "product-rules" && route.length === 2) {
      if (req.method === "GET") {
        json(res, 200, {
          ok: true,
          rules: db.getSetting(PRODUCT_RULES_KEY) || "",
          maxChars: PRODUCT_RULES_MAX,
          tagSummary: db.tagSummary({ limit: 50 }), // ป้ายที่มีอยู่จริง — ช่วยทีมเขียนกติกาให้ตรง
        });
        return true;
      }
      if (req.method === "POST") {
        if (await queueOrDeny("rules.manage", "product_rules",
          (body) => `กติกาสินค้า ${String(body.rules ?? "").trim().length} ตัวอักษร`)) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (typeof body.rules !== "string" || body.rules.length > PRODUCT_RULES_MAX) {
          json(res, 400, { ok: false, error: `rules ต้องเป็นข้อความไม่เกิน ${PRODUCT_RULES_MAX} ตัวอักษร` });
          return true;
        }
        const rulesWrite = brainWrite("product_rules", {
          audit: { action: "product_rules_edit", target: "", detail: `${body.rules.trim().length} ตัวอักษร` },
          apply: () => db.setSetting(PRODUCT_RULES_KEY, body.rules.trim()),
        });
        if (!rulesWrite) return true;
        json(res, 200, { ok: true, rules: db.getSetting(PRODUCT_RULES_KEY) || "", brain: brainInfo(rulesWrite) });
        return true;
      }
    }

    /* ---- v1.1 (bug 5): ผู้รับ push แจ้งทีมเมื่อลูกค้าต้องการคน — ต่อสาขา ---- */
    // ทุกการแจ้งนับเป็น push message 1 คน/1 ข้อความ (มีผลโควตา OA — UI ต้องบอกชัด)
    if (route[0] === "settings" && route[1] === "notify" && route.length === 2) {
      // 2 ก.ย. 2026: กลับมาใช้ notifications.manage ตามที่ /console/api/me ประกาศไว้อยู่แล้ว
      // นี่ไม่ใช่ "การตั้ง webhook" — เป็นรายชื่อคนในทีมที่จะได้แจ้งเตือนเมื่อลูกค้าขอคุยกับคน
      // ถ้ากันเป็นของเจ้าของคนเดียว วันที่มีน้องใหม่เข้าทีม/มีคนลาออก/ชมพู่เปลี่ยนบัญชี LINE
      // ลูกค้าที่กด "ขอคุยกับคน" จะนั่งรอจนกว่าพี่ง้วงจะว่างมาแก้ให้ (สิทธิ์ที่โฆษณากับ
      // สิทธิ์จริงต้องตรงกันด้วย — 2026-08-25 เคยเพี้ยนกันมาแล้วครั้งหนึ่ง ดู operatorRoles)
      if (!hasOperatorCapability(operator, "notifications.manage")) {
        json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
        return true;
      }
      const channelIds = channels.length ? channels.map((c) => c.id) : ["default"];
      if (req.method === "GET") {
        json(res, 200, {
          ok: true,
          channels: channelIds.map((id) => ({ id, ids: notifyIdsFor(db, id, config) })),
          envDefault: config.escalateNotifyIds || [],
          maxRecipients: NOTIFY_MAX_RECIPIENTS,
        });
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const channelId = String(body.channelId || "default");
        if (!channelIds.includes(channelId)) {
          json(res, 400, { ok: false, error: "channelId ไม่อยู่ในรายการสาขา" });
          return true;
        }
        const ids = validNotifyIds(body.ids);
        if (ids === null) {
          json(res, 400, {
            ok: false,
            error: `ids ต้องเป็นลิสต์ LINE user ID (ขึ้นต้น U + 32 ตัวอักษร) ไม่เกิน ${NOTIFY_MAX_RECIPIENTS} คน`,
          });
          return true;
        }
        db.setSetting(NOTIFY_KEY_PREFIX + channelId, JSON.stringify(ids));
        db.addAudit({
          operator: username, action: "escalate_notify_set", target: channelId,
          detail: `ผู้รับแจ้งเตือน ${ids.length} คน`,
        });
        json(res, 200, { ok: true, channelId, ids });
        return true;
      }
    }

    /* ---- Schedule Gate: เวลาทำการของบอท (default ปิด — fail-closed) ---- */
    if (route[0] === "settings" && route[1] === "schedule" && route.length === 2) {
      const snapshot = () => {
        const hoursRaw = db.getSetting(SCHEDULE_HOURS_KEY) || "";
        const state = scheduleState({ db });
        return {
          ok: true,
          enabled: db.getSetting(SCHEDULE_ENABLED_KEY) === "1",
          activeHours: hoursRaw,
          ackTemplate: db.getSetting(SCHEDULE_ACK_KEY) || "",
          valid: Boolean(parseActiveHours(hoursRaw)),
          // gate ทำงานจริงเท่านั้นถึงบอกได้ว่าตอนนี้ใน/นอกเวลา — ไม่ทำงาน = null
          activeNow: state.enabled ? state.active : null,
        };
      };
      if (req.method === "GET") {
        json(res, 200, snapshot());
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        // validate ให้ครบทุก field ก่อน แล้วค่อยเขียน — ห้ามบันทึกครึ่ง ๆ กลาง ๆ
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
          json(res, 400, { ok: false, error: "enabled ต้องเป็น boolean" });
          return true;
        }
        if (body.activeHours !== undefined
          && (typeof body.activeHours !== "string" || !parseActiveHours(body.activeHours))) {
          json(res, 400, {
            ok: false,
            error: "activeHours ต้องเป็นรูปแบบ HH:MM-HH:MM เช่น 09:00-21:00 (ข้ามคืนได้ เช่น 20:00-08:00)",
          });
          return true;
        }
        if (body.ackTemplate !== undefined
          && (typeof body.ackTemplate !== "string" || body.ackTemplate.length > ACK_TEMPLATE_MAX)) {
          json(res, 400, { ok: false, error: `ackTemplate ต้องเป็นข้อความไม่เกิน ${ACK_TEMPLATE_MAX} ตัวอักษร` });
          return true;
        }
        const changes = [];
        if (body.enabled !== undefined) {
          db.setSetting(SCHEDULE_ENABLED_KEY, body.enabled ? "1" : "0");
          changes.push(`enabled=${body.enabled ? "on" : "off"}`);
        }
        if (body.activeHours !== undefined) {
          db.setSetting(SCHEDULE_HOURS_KEY, body.activeHours.trim());
          changes.push(`hours=${body.activeHours.trim()}`);
        }
        if (body.ackTemplate !== undefined) {
          db.setSetting(SCHEDULE_ACK_KEY, body.ackTemplate.trim());
          changes.push("ack_template");
        }
        if (!changes.length) {
          json(res, 400, { ok: false, error: "ไม่มีข้อมูลให้บันทึก (ส่ง enabled/activeHours/ackTemplate อย่างน้อย 1 อย่าง)" });
          return true;
        }
        db.addAudit({ operator: username, action: "schedule_config", detail: changes.join(" ") });
        json(res, 200, snapshot());
        return true;
      }
    }

    /* ---- v1.4.31: ที่นั่งคงเหลือต่อรอบ — ทีมงานกรอกเอง มีผลกับลูกแพรทันที ---- */
    // วันที่มาจากไฟล์ (อ่านอย่างเดียว) ส่วนตัวเลขที่นั่งเก็บใน DB เพราะแก้บ่อยกว่ากันมาก
    // ไม่ตั้งไฟล์ = ไม่มี route นี้เลย (ธุรกิจที่ไม่มีรอบเรียนต้องไม่เห็นเมนู)
    if (route[0] === "class-rounds") {
      const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
      const snapshotRounds = () => ({
        ok: true,
        rounds: upcomingRounds({ file: config.classRoundsFile, db, todayIso, logger }),
      });
      // ฐานของการแก้ "ตัวรอบ": เริ่มจากที่กรอกไว้แล้ว ถ้ายังไม่เคยกรอกเลย ให้ยกไฟล์เดิมมาเป็นฐานก่อน
      // (ไม่งั้นการเพิ่มรอบแรกจะทำให้รอบทั้งหมดในไฟล์หายไปทันที) แล้วแปลงกลับเป็นรูปที่เก็บเสมอ —
      // เขียนผลของ readManualRounds กลับตรง ๆ = ช่อง status หาย รอบอื่นที่ตั้ง "เต็ม/ปิด" ไว้เด้งเป็นเปิดรับ
      // 28 ก.ย.: รอบที่ถึง/ผ่านวันนี้แล้วปิดรับเองตอนบันทึก (หน้าที่นั่งเป็นแหล่งเดียวของรายการรอบแล้ว
      // และรอบเก่าที่ยังเขียนว่า "เปิดรับ" ทำให้ด่านสมองถามให้รับทราบทุกครั้งที่มีคนแก้อะไรก็ตาม)
      const editableRounds = () => (readManualRounds(db).length
        ? readManualRounds(db)
        : upcomingRounds({ file: config.classRoundsFile, db, todayIso, logger }))
        .map(toStoredRound)
        .map((round) => (round.date <= todayIso && round.status !== "closed" ? { ...round, status: "closed" } : round));

      if (req.method === "GET" && route.length === 1) {
        json(res, 200, snapshotRounds());
        return true;
      }
      // จงใจไม่มีด่านสิทธิ์: "จำนวนคนที่ลงทะเบียนแล้ว" คือเลขที่ทีมรายงานกันในกลุ่ม LINE
      // ทุกวัน ชมพู่กรอกเองได้ตลอดตามคำสั่งเจ้าของ 2 ก.ย. 2026 (ของที่กันคือ "ตัวรอบ"
      // ข้างล่าง ไม่ใช่ตัวเลขที่นั่ง) — กันเกินตรงนี้ = ลูกค้าได้ที่นั่งผิดตอนงานยุ่ง
      if (req.method === "POST" && route.length === 1) {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const date = typeof body.date === "string" ? body.date.trim() : "";
        const known = upcomingRounds({ file: config.classRoundsFile, db, todayIso, logger });
        if (!known.some((round) => round.date === date)) {
          // ต้องเป็นรอบที่มีจริงเท่านั้น — กันเลขที่นั่งค้างของรอบที่ถูกยกเลิก/พิมพ์วันผิด
          json(res, 400, { ok: false, error: "ไม่มีรอบเรียนวันที่นี้ (หรือรอบผ่านไปแล้ว)" });
          return true;
        }
        // v1.4.35: รับ "จำนวนคนที่ลงทะเบียนแล้ว" ตรงกับที่ทีมงานรายงานในกลุ่ม LINE
        const enrolled = readEnrolled(db);
        const round = known.find((r) => r.date === date);
        let detail;
        if (body.enrolled === null || body.enrolled === "") {
          delete enrolled[date];
          detail = `${date} = ล้างค่า (กลับไปใช้ข้อความจำนวนจำกัด)`;
        } else {
          const value = Number(body.enrolled);
          if (!Number.isInteger(value) || value < 0 || value > ENROLLED_MAX) {
            json(res, 400, { ok: false, error: `จำนวนผู้ลงทะเบียนต้องเป็นจำนวนเต็ม 0-${ENROLLED_MAX}` });
            return true;
          }
          enrolled[date] = value;
          const left = Math.max(0, round.capacity - value);
          detail = `${date} = ลงทะเบียน ${value} คน (เหลือ ${left} ที่จาก ${round.capacity})`;
        }
        writeEnrolled(db, enrolled);
        // ตัวเลขนี้ไปถึงลูกค้าจริง จึงต้องรู้เสมอว่าใครแก้ตอนไหน
        db.addAudit({ operator: username, action: "class_enrolled_set", detail });
        json(res, 200, snapshotRounds());
        return true;
      }

      // ===== เพิ่ม/แก้/ลบ "ตัวรอบเรียน" เอง (คำสั่งพี่ง้วง 2026-08-26) =====
      // เดิมตารางรอบมาจากไฟล์ในตัว release ซึ่งเขียนไม่ได้ ต้องแก้ในเครื่องแล้วรอ release
      // ถัดไป และมีงานอัตโนมัติคอยซิงก์ให้ซึ่งล้มเงียบมานาน
      // ตอนนี้กรอกจากหน้า "ที่นั่ง" ได้เลย มีผลทันที อยู่ข้าม release และเข้าไฟล์สำรองด้วย
      // ตัว "รอบเรียน" เข้าไปเป็นข้อมูลตั้งต้นของลูกแพร (seatRuleLines ฉีดเข้า prompt)
      // ต่างจากช่องที่นั่งข้างบนซึ่งเป็นตัวเลขที่ทีมรายงานกันทุกวัน — จึงกันคนละชั้นกัน
      if (req.method === "POST" && route[1] === "round" && route.length === 2) {
        if (await queueOrDeny("rules.manage", "class_round_set", (body) => {
          const seats = body.capacity === null || body.capacity === "" || body.capacity === undefined
            ? "ไม่จำกัดที่นั่ง" : `${body.capacity} ที่`;
          return `เพิ่ม/แก้รอบเรียน ${String(body.date ?? "").trim()} "${String(body.label ?? "").trim()}" · ${seats}`;
        })) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const date = String(body.date || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
          json(res, 400, { ok: false, error: "วันเรียนต้องเป็นรูปแบบ YYYY-MM-DD" });
          return true;
        }
        const label = String(body.label || "").trim();
        if (!label || label.length > 80) {
          json(res, 400, { ok: false, error: "ชื่อคลาสต้องมี และยาวไม่เกิน 80 ตัวอักษร" });
          return true;
        }
        // capacity ว่าง/null = ไม่จำกัดที่นั่ง (คลาสออนไลน์)
        let capacity = null;
        if (body.capacity !== null && body.capacity !== "" && body.capacity !== undefined) {
          const value = Number(body.capacity);
          if (!Number.isInteger(value) || value < 1 || value > ENROLLED_MAX) {
            json(res, 400, { ok: false, error: `จำนวนที่นั่งต้องเป็นจำนวนเต็ม 1-${ENROLLED_MAX} หรือเว้นว่างถ้าไม่จำกัด` });
            return true;
          }
          capacity = value;
        }
        const status = ["open", "almost_full", "full", "closed"].includes(String(body.status))
          ? String(body.status) : "open";
        const base = editableRounds();
        const next = base.filter((round) => round.date !== date);
        next.push({
          date, classKey: String(body.classKey || "custom").slice(0, 40), label,
          product: String(body.product || "").trim().slice(0, 80), status, capacity,
        });
        next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        const roundWrite = brainWrite("class_round_set", {
          audit: {
            action: "class_round_set", target: "",
            detail: `${date} ${label} · ${capacity === null ? "ไม่จำกัดที่นั่ง" : `${capacity} ที่`} · ${status}`,
          },
          apply: () => writeManualRounds(db, next),
        });
        if (!roundWrite) return true;
        json(res, 200, { ...snapshotRounds(), brain: brainInfo(roundWrite) });
        return true;
      }

      if (req.method === "POST" && route[1] === "round-delete" && route.length === 2) {
        if (await queueOrDeny("rules.manage", "class_round_delete",
          (body) => `ลบรอบเรียนวันที่ ${String(body.date ?? "").trim()}`)) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const date = String(body.date || "").trim();
        const base = editableRounds();
        const next = base.filter((round) => round.date !== date);
        if (next.length === base.length) {
          json(res, 404, { ok: false, error: "ไม่พบรอบเรียนวันที่นี้" });
          return true;
        }
        const roundDelete = brainWrite("class_round_delete", {
          audit: { action: "class_round_delete", target: "", detail: date },
          apply: () => {
            writeManualRounds(db, next);
            // ล้างจำนวนผู้ลงทะเบียนของรอบที่ลบไปด้วย กันเลขค้างของรอบที่ไม่มีแล้ว
            const enrolled = readEnrolled(db);
            if (Object.hasOwn(enrolled, date)) {
              delete enrolled[date];
              writeEnrolled(db, enrolled);
            }
          },
        });
        if (!roundDelete) return true;
        json(res, 200, { ...snapshotRounds(), brain: brainInfo(roundDelete) });
        return true;
      }
    }

    /* ---- G3: คลังความรู้ (knowledge_entries) — CRUD + audit ครบ ---- */
    // v1.4.49: ด่านกันล้น — เดิมเกินเพดานแล้ว "ตัดรายการเก่าสุดทิ้งเงียบ ๆ" ซึ่งคือ
    // แคตตาล็อกคลาส+ราคา ตอนนี้ปฏิเสธตรง ๆ พร้อมบอกวิธีแก้ ให้คนเป็นคนเลือกว่ารวบอะไร
    // 19 ต.ค. 2026 (คลังรีวิวนอกพรอมต์ · สวิตช์ review_catalog_in_prompt ≠ on): การ์ด "รีวิวนักเรียนจริง" ไม่นับใน
    // 80,000 ของคลังความรู้ แต่มีงบของตัวเอง REVIEW_CATALOG_MAX_CHARS — กติกา "ห้ามแย่ลง" ใช้แยกกันทีละงบ
    // ตัวนับคือ knowledgeUsage ตัวเดียวกับตัวประกอบพรอมต์ · on = กติกาเดิมทุกตัวอักษร (คลังรีวิวนับรวม 80,000)
    function knowledgeCapError(scope, { addEntry = null, replaceId = null } = {}) {
      const separateCatalog = catalogOutOfPrompt(db);
      const current = db.listActiveKnowledge(scope);
      const rows = current.filter((row) => String(row.id) !== String(replaceId ?? ""));
      // แก้การ์ดเดิม = วางที่ตำแหน่งเดิม (ลำดับเก่า→ใหม่ตัดสินว่าใบไหนคือคลังรีวิวและใบไหนตกขอบ)
      if (addEntry) {
        const at = current.findIndex((row) => String(row.id) === String(replaceId ?? ""));
        if (at >= 0) rows.splice(at, 0, addEntry); else rows.push(addEntry);
      }
      const usage = knowledgeUsage(rows, { separateCatalog });
      const before = knowledgeUsage(current, { separateCatalog });
      // กติกา ห้ามแย่ลง: ถ้าคลังล้นอยู่แล้ว การแก้ที่ทำให้เล็กลง(หรือเท่าเดิม)ต้องผ่านเสมอ
      // ไม่งั้นจะเกิดกับดัก — รวบคลังไม่ได้เพราะทุกการแก้โดนด่านล้นบล็อก
      if (usage.totalChars > KNOWLEDGE_MAX_CHARS && usage.totalChars > before.totalChars) {
        const over = usage.totalChars - KNOWLEDGE_MAX_CHARS;
        return `คลังความรู้เต็ม (เกินเพดาน ${over.toLocaleString("th-TH")} ตัวอักษร จาก ${KNOWLEDGE_MAX_CHARS.toLocaleString("th-TH")}) — รวบหรือปิดรายการเดิมก่อน ระบบจะไม่ตัดของเก่าทิ้งเงียบ ๆ`;
      }
      if (separateCatalog && usage.catalogChars > REVIEW_CATALOG_MAX_CHARS && usage.catalogChars > before.catalogChars) {
        const over = usage.catalogChars - REVIEW_CATALOG_MAX_CHARS;
        return `คลังรีวิวเต็ม (เกินเพดาน ${over.toLocaleString("th-TH")} ตัวอักษร จาก ${REVIEW_CATALOG_MAX_CHARS.toLocaleString("th-TH")}) — ลบหรือรวบรายการที่ไม่ใช้แล้วก่อน คลังรีวิวมีงบของตัวเองแยกจากคลังความรู้ ระบบจะไม่ตัดรายการทิ้งเงียบ ๆ`;
      }
      return null;
    }
    /* ---- KPI: วัดผลการตอบแชท คน vs ลูกแพร (คำสั่งพี่ง้วง 1 ก.ย. 2026) ---- */
    // วันหยุดนักขัตฤกษ์ + วันที่ชมพู่ไม่มา — เก็บเป็น YYYY-MM-DD คั่นด้วยบรรทัด/จุลภาค
    // 3 พ.ย. 2026: รายการเดียวกันหยุดนาฬิกาไม้ต่อและงดแจ้งเตือนทีมวันนั้น (workClock.mjs อ่านคีย์เดียวกัน)
    const HOLIDAY_KEY = OFF_DAYS_KEY;
    const readHolidays = () => [...parseOffDays(db.getSetting(HOLIDAY_KEY))];

    if (route[0] === "kpi" && route[1] === "holidays" && route.length === 2) {
      if (req.method === "GET") {
        json(res, 200, { ok: true, holidays: readHolidays() });
        return true;
      }
      if (req.method === "PUT") {
        // 2 ก.ย. 2026: อ่านผลงานได้ทุกบทบาทตามคำสั่งเจ้าของ แต่ "เขียนเกณฑ์" ไม่ได้ —
        // วันที่ใส่ในช่องนี้จะกลายเป็น day.off (kpi.mjs) แล้วถูกตัดออกจาก speedWorkDays
        // ซึ่งเป็นชุดที่พี่ง้วงใช้ตัดสินผลงานทีมจริง ๆ ใส่วันที่ตอบช้าเข้าไป = ค่ามัธยฐาน
        // เวลาตอบดีขึ้นเองโดยไม่มีใครทำอะไรเพิ่ม (ร่องรอยมีแค่แถว audit ที่ไม่มีหน้าไหนวาด)
        // วางก่อน CSRF ตั้งใจ: คนไม่มีสิทธิ์ต้องได้ 403 เดียวกันเสมอ ไม่ใช่ "CSRF ไม่ถูกต้อง"
        // ซึ่งบอกใบ้ว่าถ้าแก้ CSRF ได้ก็จะผ่าน
        if (!hasOperatorCapability(operator, "kpi.manage")) {
          json(res, 403, { ok: false, error: DENY_NO_PERMISSION });
          return true;
        }
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const raw = Array.isArray(body?.holidays) ? body.holidays : String(body?.holidays ?? "").split(/[\s,]+/u);
        const bad = raw.map((s) => String(s).trim()).filter(Boolean).filter((s) => !/^\d{4}-\d{2}-\d{2}$/u.test(s));
        if (bad.length) {
          json(res, 400, { ok: false, error: `รูปแบบวันที่ต้องเป็น ปปปป-ดด-วว เช่น 2026-12-05 (ผิด: ${bad[0]})` });
          return true;
        }
        const list = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))].sort();
        db.setSetting(HOLIDAY_KEY, list.join("\n"));
        db.addAudit({ operator: username, action: "kpi_holidays_edit", target: HOLIDAY_KEY, detail: `${list.length} วัน` });
        json(res, 200, { ok: true, holidays: list });
        return true;
      }
    }

    if (route[0] === "kpi" && req.method === "GET" && route.length === 1) {
      const url = new URL(req.url, "http://localhost");
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 30));
      const channelId = url.searchParams.get("channel") || null;
      // โมดูลนี้ไม่ได้รับ now() มาเป็น dependency (ต่างจาก server.mjs) — เคยเขียน now()
      // ไว้แล้วพังเป็น 500 บนเครื่องจริงอยู่ 15 นาทีโดยหน้าเว็บกลืน error ทิ้ง
      const nowMs = Date.now();
      // ขอบล่างสองชั้น: ช่วงที่ผู้ใช้เลือก และวันที่บอทเริ่มติดป้ายว่าใครตอบ
      const attributionStart = db.kpiAttributionStartMs();
      const since = Math.max(nowMs - days * 86_400_000, attributionStart);
      const messages = db.kpiMessagesSince(since, channelId);
      const customers = new Map(db.kpiCustomers(channelId).map((row) => [row.line_user_id, row]));
      const byRoom = new Map();
      for (const message of messages) {
        const list = byRoom.get(message.customer_id) ?? [];
        if (!list.length) byRoom.set(message.customer_id, list);
        list.push(message);
      }
      const rooms = [...byRoom.entries()]
        .filter(([customerId]) => customers.has(customerId))
        .map(([customerId, list]) => ({ customerId, customer: customers.get(customerId), messages: list }));
      json(res, 200, {
        ok: true,
        window: { days, sinceMs: since, nowMs, attributionStartMs: attributionStart },
        holidays: readHolidays(),
        // รีวิวปรปักษ์ 5 ต.ค. #20: ตัดห้องสีเหลืองออกจาก backlog เฉพาะเมื่อตัวกวาดยืนยันแล้ว (หมุด qualify_hold)
        // kpi.mjs เรียกเฉพาะห้องเหลือง AI_ACTIVE — ไม่มีห้องเหลือง = ไม่อ่าน settings สักแถว (ผลเดิมทุกไบต์)
        ...summarizeKpi({ rooms, nowMs, holidays: new Set(readHolidays()), qualifyHoldOf: (id) => db.getSetting(qualifyHoldKey(id)) }),
        // 3 พ.ย. 2026 ไม้ต่อจากลูกแพร (relayBaton.mjs) — ช่วงเดียวกับที่เลือก · พังได้โดยไม่ลากทั้งหน้า (null = ไม่วาดส่วนนี้)
        relay: (() => {
          try { return relayTeamRate(db, { now: nowMs, windowMs: days * 86_400_000, channel: channelId }); } catch { return null; }
        })(),
      });
      return true;
    }

    /* ---- คลังรีวิว: ฟอร์มครอบหัวข้อ "รีวิวนักเรียนจริง" ในคลังความรู้ (1 ก.ย. 2026) ----
     * ชมพู่เพิ่มรีวิวเรื่อย ๆ แต่ของเดิมต้องแก้เป็นข้อความดิบทั้งก้อน พลาดรูปแบบทีเดียว
     * รีวิวใบนั้นหายจากคลังเงียบ ๆ — เส้นนี้จึงอ่าน/เขียนผ่านตัวแปลงที่มีเทสต์ round-trip คุม
     * และยังเก็บที่เดิม เพื่อให้ตัวเลือกรีวิวของ follow-up ไม่ต้องแก้แม้แต่บรรทัดเดียว
     */
    function reviewEntryRow() {
      return db.listKnowledge().find((row) => String(row.title || "").includes(REVIEW_ENTRY_TITLE_MATCH)) ?? null;
    }
    if (route[0] === "reviews") {
      const row = reviewEntryRow();
      if (!row) {
        json(res, 404, { ok: false, error: `ไม่พบหัวข้อที่มีคำว่า "${REVIEW_ENTRY_TITLE_MATCH}" ในคลังความรู้` });
        return true;
      }
      if (req.method === "GET" && route.length === 1) {
        const doc = parseReviewDoc(row.content);
        json(res, 200, {
          ok: true,
          entryId: row.id,
          title: row.title,
          active: row.active === 1,
          updatedBy: row.updated_by,
          updatedAt: row.updated_at,
          preamble: doc.preamble,
          sections: doc.sections.map((s) => ({ name: s.name, items: s.items })),
          total: doc.sections.reduce((n, s) => n + s.items.length, 0),
        });
        return true;
      }
      if (req.method === "PUT" && route.length === 1) {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (!Array.isArray(body?.sections)) {
          json(res, 400, { ok: false, error: "ต้องส่ง sections เป็น array" });
          return true;
        }
        const errors = validateReviewDoc({ sections: body.sections });
        if (errors.length) {
          json(res, 400, { ok: false, error: errors[0], errors });
          return true;
        }
        // ส่วนหัว (กติกาการใช้รีวิว) แก้จากหน้าคลังความรู้เท่านั้น ฟอร์มนี้ไม่แตะ
        const preamble = parseReviewDoc(row.content).preamble;
        const content = renderReviewDoc({ preamble, sections: body.sections });
        const capError = row.active === 1
          ? knowledgeCapError(row.channel_id ?? null, { addEntry: { title: row.title, content }, replaceId: row.id })
          : null;
        if (capError) {
          json(res, 409, { ok: false, error: capError });
          return true;
        }
        const before = parseReviewDoc(row.content).sections.reduce((n, s) => n + s.items.length, 0);
        const after = body.sections.reduce((n, s) => n + (s.items?.length || 0), 0);
        // คลังรีวิวเก็บเป็นแถวใน knowledge_entries = ข้อความที่ต่อตรงเข้า prompt เหมือนความรู้ใบอื่น
        // จึงต้องใช้ด่านสิทธิ์เดียวกัน (knowledge.publish) ไม่ใช่ knowledge.manage ที่ทุกบทบาทมี
        // เกตด้วยแฟล็ก: ตอนแฟล็กปิด เส้นนี้ต้องเป็นงานที่ทีมกรอกเองได้ตรง ๆ เหมือนเดิมทุกตัวอักษร
        if (brainWriteHook.enabled && await queueOrDeny("knowledge.publish", "review_catalog_edit",
          () => `คลังรีวิว ${before} -> ${after} รายการ`,
          { readCapability: "knowledge.manage", body })) return true;
        // คลังรีวิวเก็บเป็นแถวใน knowledge_entries เหมือนความรู้ใบอื่น — ถ้าเส้นนี้ไม่เดินผ่าน
        // hook ตารางเดิมจะขยับโดยที่รุ่นสมองไม่ขยับตาม แล้ว parity แตกเงียบ ๆ ตั้งแต่คนแรก
        // ที่กดบันทึกรีวิว (งานประจำวันของทีม ไม่ใช่เหตุการณ์นาน ๆ ครั้ง)
        const reviewWrite = brainWrite("review_catalog_edit", {
          audit: { action: "review_catalog_edit", target: row.id, detail: `รีวิว ${before} -> ${after} รายการ` },
          apply: () => db.updateKnowledge(row.id, { content, updatedBy: username }),
        });
        if (!reviewWrite) return true;
        json(res, 200, {
          ok: true, total: after,
          updatedAt: (reviewWrite.applied ?? db.getKnowledge(row.id))?.updated_at ?? null,
          brain: brainInfo(reviewWrite),
        });
        return true;
      }
      json(res, 405, { ok: false, error: "method ไม่รองรับ" });
      return true;
    }

    // Package K (คำสั่งพี่ง้วง 2 ก.ย. 2026): "คลังความรู้" ต่อตรงเข้า system prompt
    // (knowledgeSectionFromDb -> brand pack) ระดับเดียวกับกติกาสินค้า — การ "เปลี่ยน"
    // จึงเป็นของเจ้าของเหมือนกัน ส่วน GET ยังเปิดให้ทีมอ่านครบเหมือนเดิม
    // knowledge.manage = สิทธิ์ "เข้าหน้าความรู้/อ่าน" (ทุกบทบาทมี) — ใช้เป็นด่านอ่านของคิว
    if (route[0] === "knowledge") {
      if (req.method === "GET" && route.length === 1) {
        json(res, 200, {
          ok: true,
          knowledge: db.listKnowledge().map(publicKnowledgeRow),
          knowledgeMetadata: knowledgeMetadataStatus({ config, db }),
        });
        return true;
      }
      if (req.method === "POST" && route.length === 1) {
        if (await queueOrDeny("knowledge.publish", "knowledge_add",
          (body) => `เพิ่มความรู้ "${String(body.title ?? "").trim()}" (${String(body.content ?? "").length} ตัวอักษร)`,
          { readCapability: "knowledge.manage", prepareBody: normalizeKnowledgeBody })) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        let body;
        try { body = normalizeKnowledgeBody(await readJson(req)); }
        catch (err) { json(res, Number(err?.status) || 400, { ok: false, error: err?.message || "ข้อมูลไม่ถูกต้อง" }); return true; }
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const content = typeof body.content === "string" ? body.content : "";
        if (!title || title.length > KNOWLEDGE_TITLE_MAX) {
          json(res, 400, { ok: false, error: `หัวข้อต้องมี 1-${KNOWLEDGE_TITLE_MAX} ตัวอักษร` });
          return true;
        }
        if (!content.trim() || content.length > KNOWLEDGE_CONTENT_MAX) {
          json(res, 400, { ok: false, error: `เนื้อหาต้องมี 1-${KNOWLEDGE_CONTENT_MAX.toLocaleString("th-TH")} ตัวอักษร` });
          return true;
        }
        // G6 (P1): channelId = สร้างเข้า scope ของสาขา (สมองแยก) — ไม่ส่ง = สมองกลาง
        let channelId = null;
        if (body.channelId !== undefined && body.channelId !== null && body.channelId !== "") {
          if (typeof body.channelId !== "string" || !channels.some((ch) => ch.id === body.channelId)) {
            json(res, 400, { ok: false, error: "channelId ไม่อยู่ในรายการสาขา" });
            return true;
          }
          channelId = body.channelId;
        }
        const capError = knowledgeCapError(channelId ?? null, { addEntry: { title, content } });
        if (capError) {
          json(res, 409, { ok: false, error: capError });
          return true;
        }
        // audit.target ต้องเป็น id ของแถวที่เพิ่งเกิด ซึ่งรู้ได้หลัง apply เท่านั้น —
        // ส่ง object เดิมเข้าไปแล้วเติม target ตอนที่รู้ (hook เขียน audit หลังตัดสินผลด่าน)
        const addAudit = { action: "knowledge_add", target: "", detail: "" };
        if (duplicateTeach(body)) {
          json(res, 409, { ok: false, error: "ส่งไปแล้วเมื่อครู่นี้ — ตรวจในคลังความรู้ก่อนส่งใหม่นะคะ" });
          return true;
        }
        const addTeach = teachContext(body, `${title}\n${content}`);
        if (addTeach === TEACH_REFUSED) return true;
        const created = brainWrite("knowledge_add", {
          audit: addAudit,
          teach: addTeach,
          apply: () => {
            const row = db.addKnowledge({
              title, content, updatedBy: username, channelId,
              ...(body.knowledgeMetadata ? { provenance: mergeKnowledgeMetadata({}, body.knowledgeMetadata) } : {}),
            });
            addAudit.target = row.id;
            addAudit.detail = `${channelId ? `[${channelId}] ` : ""}${title}`.slice(0, 120);
            return row;
          },
        });
        if (!created) return true;
        json(res, 200, { ok: true, entry: publicKnowledgeRow(created.applied), brain: brainInfo(created) });
        return true;
      }
      if (req.method === "POST" && route.length === 2) {
        if (await queueOrDeny("knowledge.publish", "knowledge_edit", (body) => {
          const title = db.getKnowledge(decodeURIComponent(route[1]))?.title || decodeURIComponent(route[1]);
          if (body.active !== undefined && body.title === undefined && body.content === undefined) {
            return `${body.active ? "เปิดใช้" : "ปิด"}ความรู้ "${title}"`;
          }
          return `แก้ความรู้ "${title}"`;
        }, {
          readCapability: "knowledge.manage",
          prepareBody: (body) => prepareQueuedKnowledgeEdit(body, decodeURIComponent(route[1])),
        })) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const id = decodeURIComponent(route[1]);
        let body;
        try { body = normalizeKnowledgeBody(await readJson(req)); }
        catch (err) { json(res, Number(err?.status) || 400, { ok: false, error: err?.message || "ข้อมูลไม่ถูกต้อง" }); return true; }
        // readJson can wait for a slow client. Read the row only after it has
        // finished, otherwise an owner edit arriving during that wait can be
        // compared with an obsolete snapshot and be overwritten.
        const row = db.getKnowledge(id);
        if (!row) {
          json(res, 404, { ok: false, error: "ไม่พบความรู้รายการนี้" });
          return true;
        }
        if (featureKnowledgeEdit(row, body) && String(body.expectedKnowledgeHash || "") !== knowledgeExpectedHash(row)) {
          json(res, 409, {
            ok: false, staleKnowledge: true,
            error: "ความรู้นี้ถูกแก้ไขหลังเปิดฟอร์ม — โหลดรายการล่าสุดแล้วตรวจอีกครั้งก่อนบันทึก",
          });
          return true;
        }
        const patch = { updatedBy: username };
        if (body.title !== undefined) {
          if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > KNOWLEDGE_TITLE_MAX) {
            json(res, 400, { ok: false, error: `หัวข้อต้องมี 1-${KNOWLEDGE_TITLE_MAX} ตัวอักษร` });
            return true;
          }
          patch.title = body.title.trim();
        }
        if (body.content !== undefined) {
          // 19 ต.ค. 2026: การ์ดคลังรีวิวแก้กติกาการใช้จากหน้านี้ได้แม้คลังยาวเกิน 20,000 (งบคลังรีวิวคุมที่ knowledgeCapError)
          const contentMax = knowledgeContentMaxFor(patch.title ?? row.title);
          if (typeof body.content !== "string" || !body.content.trim() || body.content.length > contentMax) {
            json(res, 400, { ok: false, error: `เนื้อหาต้องมี 1-${contentMax.toLocaleString("th-TH")} ตัวอักษร` });
            return true;
          }
          patch.content = body.content;
        }
        if (body.active !== undefined) {
          if (typeof body.active !== "boolean") {
            json(res, 400, { ok: false, error: "active ต้องเป็น boolean" });
            return true;
          }
          patch.active = body.active;
        }
        if (body.knowledgeMetadata !== undefined) {
          patch.provenance = mergeKnowledgeMetadata(provenanceObject(row), body.knowledgeMetadata);
        }
        if (patch.title === undefined && patch.content === undefined && patch.active === undefined && patch.provenance === undefined) {
          json(res, 400, { ok: false, error: "ไม่มีข้อมูลให้บันทึก" });
          return true;
        }
        // v1.4.49: ตรวจล้นเฉพาะเมื่อผลลัพธ์ยัง active — ปิดรายการหรือแก้ให้เล็กลงผ่านเสมอ
        const willBeActive = patch.active !== undefined ? patch.active : row.active === 1;
        if (willBeActive) {
          const virtual = {
            title: patch.title !== undefined ? patch.title : row.title,
            content: patch.content !== undefined ? patch.content : row.content,
          };
          const capError = knowledgeCapError(row.channel_id ?? null, { addEntry: virtual, replaceId: id });
          if (capError) {
            json(res, 409, { ok: false, error: capError });
            return true;
          }
        }
        // แตะเฉพาะสวิตช์ = toggle / มีแก้เนื้อหา = edit — audit แยกให้ตามได้
        const onlyToggle = patch.active !== undefined && patch.title === undefined && patch.content === undefined;
        const editAudit = {
          action: onlyToggle ? "knowledge_toggle" : "knowledge_edit",
          target: id,
          detail: onlyToggle ? (patch.active ? "on" : "off") : String(patch.title ?? row.title).slice(0, 120),
        };
        if (duplicateTeach(body)) {
          json(res, 409, { ok: false, error: "ส่งไปแล้วเมื่อครู่นี้ — ตรวจในคลังความรู้ก่อนส่งใหม่นะคะ" });
          return true;
        }
        const editTeach = teachContext(body,
          `${patch.title ?? row.title}\n${patch.content ?? row.content}`);
        if (editTeach === TEACH_REFUSED) return true;
        const updated = brainWrite("knowledge_edit", {
          audit: editAudit,
          teach: editTeach,
          apply: () => {
            const entry = db.updateKnowledge(id, patch);
            // แถวหายไประหว่างทาง (มีคนลบทิ้งพอดี) = ไม่มีอะไรถูกแก้ ต้องตอบว่าไม่พบ
            // ไม่ใช่ 200 พร้อม entry ว่าง ๆ (ซึ่งอ่านเหมือนสำเร็จ) และต้องไม่ทิ้งแถว audit
            // ที่บอกว่าแก้แล้ว silent = ไม่มีใครทำอะไรผิด ไม่ต้องบันทึกว่าถูกด่านบล็อก
            if (!entry) {
              throw new BrainWriteRefused("ไม่พบความรู้รายการนี้", {
                outcome: "missing_row", status: 404, silent: true,
              });
            }
            return entry;
          },
        });
        if (!updated) return true;
        json(res, 200, { ok: true, entry: publicKnowledgeRow(updated.applied), brain: brainInfo(updated) });
        return true;
      }
      if (req.method === "DELETE" && route.length === 2) {
        if (await queueOrDeny("knowledge.publish", "knowledge_delete",
          () => `ลบความรู้ "${db.getKnowledge(decodeURIComponent(route[1]))?.title || decodeURIComponent(route[1])}"`,
          { readCapability: "knowledge.manage" })) return true;
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const id = decodeURIComponent(route[1]);
        const row = db.getKnowledge(id);
        if (!row) {
          json(res, 404, { ok: false, error: "ไม่พบความรู้รายการนี้" });
          return true;
        }
        const deleted = brainWrite("knowledge_delete", {
          audit: { action: "knowledge_delete", target: id, detail: String(row.title).slice(0, 120) },
          apply: () => db.deleteKnowledge(id),
        });
        if (!deleted) return true;
        json(res, 200, { ok: true, brain: brainInfo(deleted) });
        return true;
      }
    }

    return false;
  }

  /* ------------------- Package K: เล่นคำขอที่อนุมัติแล้วซ้ำ ------------------- */

  // อนุมัติ = ยิง request เดิมเข้า handle() ตัวเดียวกัน แต่เปลี่ยนตัวตนเป็นเจ้าของ
  // จงใจไม่เขียนตรรกะ "ทำจริง" ชุดที่สอง: ด่านตรวจ ข้อความ error ด่านคลังล้น และแถว
  // audit ต้องเป็นชุดเดียวกับตอนเจ้าของกดเองเป๊ะ ๆ ไม่งั้นคิวจะกลายเป็นทางลัดที่ข้ามด่าน
  //
  // res ที่ส่งเข้าไปเป็น null โดยตั้งใจ — ทุกเส้นในไฟล์นี้ตอบผ่าน json(res, ...) เท่านั้น
  // วันที่มีใครเขียน res.writeHead ตรง ๆ เส้นนั้นจะพังเสียงดังในเทสต์ ไม่ใช่เงียบใน production
  async function replayPublishRequest(row, { username: ownerUsername, operator: ownerOperator }) {
    const kindSpec = PUBLISH_KINDS[row.kind];
    let replayRoute = [];
    let replayBody = {};
    try {
      replayRoute = JSON.parse(row.route_json);
      replayBody = JSON.parse(row.body_json);
    } catch {
      return { ok: false, error: "คำขอนี้เสียหาย อ่านรายละเอียดไม่ได้" };
    }
    // ทะเบียนคือ allowlist ตอนเล่นซ้ำด้วย ไม่ใช่แค่ตอนเข้าคิว — แถวที่ method/เส้นทาง
    // ไม่ตรงทะเบียน (ของเก่าค้างจากเวอร์ชันก่อน หรือถูกแก้ใน DB) ต้องเล่นซ้ำไม่ได้เลย
    if (!kindSpec || !Array.isArray(replayRoute) || replayRoute.length === 0
      || String(row.method).toUpperCase() !== kindSpec.method || replayRoute[0] !== kindSpec.root) {
      return { ok: false, error: "คำขอนี้ไม่อยู่ในรายการที่อนุมัติได้" };
    }
    let captured = null;
    const handled = await handle(
      { method: kindSpec.method, headers: {} },
      null,
      new URL(`http://console.local/console/api/${replayRoute.join("/")}`),
      replayRoute,
      {
        readJson: async () => replayBody,
        json: (_res, status, payload) => { captured = { status, payload }; },
        username: ownerUsername,
        operator: ownerOperator,
        // CSRF ถูกตรวจไปแล้วตอนทีมงานส่งคำขอ และอีกครั้งตอนเจ้าของกดอนุมัติ
        requireCsrf: () => true,
        replaying: true,
      },
    );
    if (!handled || !captured) return { ok: false, error: "เส้นทางของคำขอนี้ไม่มีอยู่แล้ว" };
    const ok = captured.status >= 200 && captured.status < 300;
    return {
      ok,
      status: captured.status,
      payload: captured.payload ?? null,
      error: ok ? "" : String(captured.payload?.error || `ทำรายการไม่สำเร็จ (${captured.status})`),
    };
  }

  const publishQueueRoutes = createPublishQueueRoutes({
    db, logger, replay: replayPublishRequest, denyMessage: DENY_NO_PERMISSION,
  });

  return { handle };
}
