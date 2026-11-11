// consoleBroadcastStudioApi.mjs — เส้นทาง /console/api/broadcast/studio/* (28 ก.ย. 2026)
//
// สตูดิโอบรอดแคสต์ = หน้าจอสร้างข้อความแบบ LINE OA Manager + สิ่งที่ OA Manager ทำไม่ได้ (ป้ายของเรา, ตอบกลับ/ออเดอร์หลังส่ง)
// เรียกจาก consoleBroadcastApi.mjs (route[1] === "studio") หลังตรวจ session + สิทธิ์ OA แล้วเท่านั้น
// กติกาที่ต้องไม่เพี้ยน:
// - ทุก mutation: CSRF + สิทธิ์ broadcast.send + audit · การส่งจริงต้อง preview → ใบยืนยัน HMAC อายุ 45 วิ
//   ผูก session/OA/โหมด/เป้าหมาย/ข้อความ/ประมาณผู้รับ + พิมพ์ยืนยัน (ตัวเลขผู้รับ หรือคำว่า "ส่ง")
// - ข้อความทุกก้อนผ่านตัวกันราคา/คำต้องห้าม ทั้งตอน preview และหลังแปลงลิงก์นับคลิก
// - โควตา: อ่านสดก่อนรับงาน · อ่านไม่ได้ = ไม่รับงาน · narrowcast ส่งแบบ "ครบหรือไม่ส่งเลย" เสมอ
// - ส่งทดสอบถึงตัวเอง: เฉพาะ Owner/Admin และปลายทางคือ LINE ที่ยืนยันตัวตนผ่านรหัสจาก OA นี้แล้วเท่านั้น
// - ไม่มี id ลูกค้าในคำตอบใด ๆ (นับรวมเท่านั้น)
import { createHash, randomUUID } from "node:crypto";
import { buildBroadcastMessages, BROADCAST_CLAIM_LEASE_MS, BROADCAST_MAX_BUBBLES } from "./broadcast.mjs";
import {
  ALT_TEXT_MAX, BROADCAST_TEXT_MAX, CARD_BUTTON_MAX, CARD_LABEL_MAX, CARD_MAX, CARD_MESSAGE_TEXT_MAX,
  CARD_TEXT_MAX, CARD_TITLE_MAX,
} from "./broadcastMessages.mjs";
import {
  BROADCAST_SCHEDULE_AUDIENCE_CAP, broadcastAudienceFingerprint, isBangkokQuietHours, validFutureBangkokSchedule,
} from "./broadcastSchedule.mjs";
import {
  DEMOGRAPHIC_MIN_TARGET_REACH, DEMOGRAPHIC_OPTIONS, NARROWCAST_MIN_RECIPIENTS, STUDIO_CONFIRM_TTL_MS, THAI_AREA_LABELS,
  aggregationUnitFor, createLinkCollector, makeStudioConfirmation, normalizeStudioTarget, studioConfirmationMatches,
  quotaUseFor, studioHash,
} from "./broadcastStudio.mjs";
import { LINE_SIDE_MODES, STUDIO_MODES } from "./dbBroadcastStudio.mjs";
import { cleanTags, quotaError, quotaPayload, sessionBinding } from "./consoleBroadcastApi.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { BASIC_STICKERS } from "./messageMedia.mjs";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { isSpamTag } from "./spamTag.mjs";

const SEND_COOLDOWN_MS = 60_000;
const TEST_SENDS_PER_WINDOW = 6;
const TEST_WINDOW_MS = 10 * 60_000;
// ป้ายที่ไม่ควรโผล่ในตัวเลือก: สแปม (ตัดเสมออยู่แล้ว) + ห้องประวัติจาก LINE OA เดิม (ส่งไปก็ไม่ถึง)
const HIDDEN_TAGS = new Set(["ย้ายจาก LINE OA"]);
// ชื่อเรียกโหมดในข้อความ audit/คำตอบ
const MODE_LABEL = Object.freeze({
  tags: "ตามป้ายของเรา", all: "เพื่อนทุกคน", audience: "กลุ่มเป้าหมาย LINE", demographic: "ตามข้อมูลประชากร",
});
// ชนิดกลุ่มเป้าหมายของ LINE (#get-audience-groups-response) — ชื่อไทยสำหรับหน้าจอ
export const AUDIENCE_TYPE_LABELS = Object.freeze({
  UPLOAD: "อัปโหลดรายชื่อ", CLICK: "คนที่คลิกลิงก์ในข้อความ", IMP: "คนที่เปิดอ่านข้อความ",
  CHAT_TAG: "แท็กแชท (OA Manager)", FRIEND_PATH: "ช่องทางที่เพิ่มเพื่อน (OA Manager)", RESERVATION: "จองล่วงหน้า",
  APP_EVENT: "เหตุการณ์ในแอป", VIDEO_VIEW: "คนที่ดูวิดีโอ", WEBTRAFFIC: "คนที่เข้าเว็บ (LINE Tag)",
  TRACKINGTAG_WEBTRAFFIC: "คนที่เข้าเว็บ (Tracking Tag)", IMAGE_CLICK: "คนที่คลิกรูป",
  RICHMENU_IMP: "คนที่เห็นริชเมนู", RICHMENU_CLICK: "คนที่คลิกริชเมนู", POP_AD_IMP: "คนที่เห็นโฆษณา POP",
});
export const AUDIENCE_ROUTE_LABELS = Object.freeze({
  OA_MANAGER: "สร้างใน LINE OA Manager", MESSAGING_API: "สร้างผ่าน Messaging API",
  POINT_AD: "LINE Points Ads", AD_MANAGER: "LINE Ads",
});
// กลุ่มที่ LINE ยกเว้นจากเพดานขั้นต่ำ 50 คน (#send-narrowcast-message-restrictions)
const MIN_RECIPIENT_EXEMPT_TYPES = new Set(["UPLOAD", "CHAT_TAG"]);

// จัดกลุ่มป้ายตามมิติ "มิติ: ค่า" (กรอบป้ายใหม่) — ไม่ hard-code รายชื่อมิติ อ่านจากป้ายจริงเสมอ
export function groupTagsByDimension(tags = []) {
  const groups = new Map();
  for (const row of tags) {
    const tag = String(row?.tag || "");
    if (!tag || isSpamTag(tag) || HIDDEN_TAGS.has(tag)) continue;
    const match = /^([^:：]{1,24}?)\s*[:：]\s*(.+)$/u.exec(tag);
    const dimension = match ? match[1].trim() : "";
    const value = match ? match[2].trim() : tag;
    const key = dimension || "";
    if (!groups.has(key)) groups.set(key, { dimension: key, label: key || "ป้ายอื่น ๆ", tags: [] });
    groups.get(key).tags.push({
      tag, value, count: Number(row.customer_count) || 0, source: row.source || "human",
      purchased: tag.toLowerCase() === "customer",
    });
  }
  return [...groups.values()]
    .map((group) => ({ ...group, wildcard: group.dimension ? `${group.dimension}:*` : "", total: group.tags.reduce((s, t) => s + t.count, 0) }))
    .sort((a, b) => (a.dimension ? 0 : 1) - (b.dimension ? 0 : 1) || b.total - a.total || a.label.localeCompare(b.label, "th"));
}

// ชุดตัวกรองสำเร็จรูป — "ยังไม่ซื้อ" = ตัดป้าย customer และทุกค่าในมิติ "ซื้อครั้งที่"
export const TAG_PRESETS = Object.freeze([
  Object.freeze({
    key: "not_purchased", label: "ยังไม่ซื้อ",
    hint: "ตัดคนที่มีป้าย customer และป้าย ซื้อครั้งที่: (ทุกค่า) ออก",
    exclude: Object.freeze(["customer", "ซื้อครั้งที่:*"]),
  }),
]);

function createTestLimiter(now) {
  const buckets = new Map();
  return (key) => {
    const t = now();
    const recent = (buckets.get(key) || []).filter((at) => t - at < TEST_WINDOW_MS);
    if (recent.length >= TEST_SENDS_PER_WINDOW) {
      buckets.set(key, recent);
      return false;
    }
    recent.push(t);
    buckets.set(key, recent);
    return true;
  };
}

function lineHasSendPath(client) {
  try { return client?.sendAllowed?.() === true; } catch { return false; }
}

export function createBroadcastStudioRoutes({
  db, config, engine, studio, channelLabel = (id) => String(id || "default"), catalogEntries = () => [],
  mediaStatus = () => ({ enabled: false }), schedulingStatus = () => ({ enabled: false }), lineRegistry = null,
  logger = console, now = Date.now,
}) {
  const allowTestSend = createTestLimiter(now);
  const lineFor = (channelId) => lineRegistry?.forChannel?.(channelId) ?? null;
  const pilotBlocksLineSide = () => config?.linePilotMode === true;

  function catalogByKey() {
    return new Map(catalogEntries().map((entry) => [entry.key, entry]));
  }

  function quotaFresh(channelId, estimatedUse, { fresh = true } = {}) {
    return engine.quotaFor(channelId, { fresh }).then((quota) => quotaPayload(quota, estimatedUse));
  }

  // ตรวจทุกอย่างที่ preview/send/schedule ใช้ร่วมกัน — คืน { error, status } หรือชุดข้อมูลที่ตรวจแล้ว
  async function prepare(body, { channelIds, forSchedule = false }) {
    const channelId = String(body.channelId || "default");
    if (!channelIds.includes(channelId)) return { status: 403, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" };
    const mode = String(body.mode || "tags");
    if (!STUDIO_MODES.includes(mode)) return { status: 400, error: "โหมดผู้รับไม่ถูกต้อง" };
    const lineSide = LINE_SIDE_MODES.includes(mode);
    if (lineSide && pilotBlocksLineSide()) {
      return { status: 409, error: "โหมดนำร่อง (pilot) เปิดอยู่ — ส่งถึงเพื่อนทุกคน/กลุ่มเป้าหมาย LINE ไม่ได้ ใช้โหมดป้ายแทน" };
    }
    const normalized = normalizeStudioTarget(mode, body.target || {});
    if (normalized.error) return { status: 400, error: normalized.error };
    const target = normalized.target;
    let includeTags = [];
    let excludeTags = [];
    if (mode === "tags") {
      includeTags = cleanTags(body.includeTags);
      excludeTags = cleanTags(body.excludeTags);
      if (includeTags === null || excludeTags === null) return { status: 400, error: "ตัวกรองป้ายต้องเป็นลิสต์ไม่เกิน 20 ป้าย" };
      if (!includeTags.length) return { status: 400, error: "เลือกป้ายผู้รับอย่างน้อย 1 ป้าย (หรือ \"ทุกคนที่ระบบรู้จัก\")" };
    }
    const notificationDisabled = body.notificationDisabled === true;
    const trackClicks = body.trackClicks !== false;
    const built = buildBroadcastMessages(body.messages, { imageCatalogByKey: catalogByKey() });
    if (built.error) return { status: 400, error: built.error };
    const guarded = engine.guardCheck(built.messages);
    if (!guarded.ok) return { status: 400, error: guarded.error };
    let scheduledAt = null;
    if (forSchedule) {
      scheduledAt = Number(body.scheduledAt);
      const timeCheck = validFutureBangkokSchedule(scheduledAt, now());
      if (!timeCheck.ok) return { status: 400, error: timeCheck.error };
    }
    let audience = null;
    const warnings = [];
    if (mode === "tags") {
      audience = db.broadcastAudience({ channelId, includeTags, excludeTags });
      if (!audience.length) return { status: 400, error: "กลุ่มผู้รับว่าง — ไม่มีลูกค้าตรงเงื่อนไข (หรือทุกคนขอหยุดการทัก/ปฏิเสธการตลาด)" };
      if (audience.length > BROADCAST_SCHEDULE_AUDIENCE_CAP) {
        return { status: 400, error: `กลุ่มมี ${audience.length} คน เกินเพดาน ${BROADCAST_SCHEDULE_AUDIENCE_CAP} คนต่อครั้งของการส่งตามป้าย — ใช้โหมดเพื่อนทุกคน/กลุ่มเป้าหมายแทน` };
      }
    }
    const estimate = await studio.estimateFor(channelId, mode, target, { audience });
    if (mode === "all" && !Number.isSafeInteger(estimate.estimate)) {
      return { status: 409, error: "อ่านจำนวนเพื่อนจาก LINE ไม่ได้ตอนนี้ — ระบบไม่รับงานส่งถึงเพื่อนทุกคนจนกว่าจะรู้ว่าโควตาพอ (ลองใหม่ภายหลัง)" };
    }
    if (mode === "audience") {
      if (estimate.reason === "audience_unknown") return { status: 409, error: "ไม่พบกลุ่มเป้าหมายที่เลือกใน LINE แล้ว — โหลดรายการกลุ่มใหม่" };
      if (estimate.reason === "audience_not_ready") {
        return { status: 409, error: `กลุ่ม "${estimate.group?.description || estimate.group?.audienceGroupId}" ยังไม่พร้อม (สถานะ ${estimate.group?.status}) — LINE รับเฉพาะกลุ่มที่ READY` };
      }
      for (const group of estimate.groups || []) {
        if (!MIN_RECIPIENT_EXEMPT_TYPES.has(group.type) && Number.isSafeInteger(group.audienceCount) && group.audienceCount < NARROWCAST_MIN_RECIPIENTS) {
          warnings.push(`กลุ่ม "${group.description || group.audienceGroupId}" มีไม่ถึง ${NARROWCAST_MIN_RECIPIENTS} คน — LINE อาจรับงานแต่ไม่ส่งจริง`);
        }
      }
    }
    if (mode === "demographic") {
      if (Number.isSafeInteger(estimate.targetedReaches) && estimate.targetedReaches < DEMOGRAPHIC_MIN_TARGET_REACH) {
        return { status: 409, error: `เพื่อนที่ LINE ระบุข้อมูลประชากรได้มี ${estimate.targetedReaches} คน (ต้อง ≥ ${DEMOGRAPHIC_MIN_TARGET_REACH}) — LINE จะไม่ส่งแบบกรองข้อมูลประชากร` };
      }
      warnings.push("LINE คำนวณผู้รับตอนส่ง · ประเทศไทยตัดผู้ใช้อายุต่ำกว่า 20 ปีออกเสมอ · ผลลัพธ์น้อยกว่า 50 คน LINE จะไม่ส่ง");
    }
    // เพื่อนทุกคน = กันเผื่อเพื่อนใหม่หลังสถิติ (/broadcast ห้ามส่งไม่ครบไม่ได้) · โควตาไม่พอ = quotaError ด้านล่างไม่รับงาน
    const estimatedUse = quotaUseFor(mode, estimate.estimate);
    const quota = await quotaFresh(channelId, estimatedUse, { fresh: !forSchedule });
    const quotaProblem = quotaError(quota);
    if (quotaProblem && !forSchedule) return { status: 400, error: quotaProblem };
    if (lineSide && quota.type === "limited" && quota.remaining <= 0) {
      return { status: 400, error: "โควตา LINE เดือนนี้หมดแล้ว — ส่งไม่ได้" };
    }
    if (lineSide && estimatedUse && quota.type === "limited" && quota.remaining > 0 && estimatedUse > quota.remaining * 0.5) {
      warnings.push(mode === "all"
        ? "การส่งนี้ใช้โควตามากกว่าครึ่งของที่เหลือ — หลังส่ง ข้อความอื่นของเดือนนี้ (ลูกแพรตอบ/ทักตาม/ข้อความตามขั้น) เหลือโควตาน้อยลงมาก"
        : "การส่งนี้ใช้โควตามากกว่าครึ่งของที่เหลือ — LINE จองโควตาไว้ระหว่างส่ง ข้อความอื่น (เช่นลูกแพรตอบแบบ push) อาจถูกปฏิเสธชั่วคราว");
    }
    // LINE เป็นคนเลือกผู้รับในโหมดฝั่ง LINE — ห้องที่ปกติเราไม่ส่ง (ขอหยุดทัก/ปฏิเสธการตลาด/สแปม null) ตัดออกไม่ได้
    // ต้องบอกเป็นตัวเลขก่อนยืนยันทุกครั้ง (รีวิวโค้ด 28 ก.ย.: ห้ามให้คนกดส่งโดยไม่รู้)
    let unprotected = null;
    if (lineSide) {
      try { unprotected = db.lineSideUnprotectedCounts(channelId); } catch { unprotected = null; }
      warnings.push(unprotected && unprotected.total > 0
        ? `LINE เป็นคนเลือกผู้รับในโหมดนี้ — ห้องที่ปกติเราไม่ส่ง ${unprotected.total.toLocaleString("en-US")} ห้อง (ขอหยุดทัก ${unprotected.dnd} · ปฏิเสธการตลาด ${unprotected.optout} · สแปม null ${unprotected.spam}) จะได้รับด้วยถ้าอยู่ในกลุ่มนี้ · ถ้าต้องตัดออก ใช้โหมดตามป้าย`
        : "LINE เป็นคนเลือกผู้รับในโหมดนี้ — ระบบตัดห้องที่ขอหยุดทัก/ปฏิเสธการตลาด/สแปม ออกให้ไม่ได้ (ตอนนี้ยังไม่พบห้องแบบนั้นในระบบ)");
    }
    if (!forSchedule && isBangkokQuietHours(now())) {
      warnings.push("ตอนนี้อยู่ช่วง 21:00–09:00 — ลูกค้าจะได้รับทันที (แนะนำตั้งเวลาส่งตอนเช้า)");
    }
    const fingerprint = audience ? broadcastAudienceFingerprint(audience) : "";
    const tagFields = mode === "tags" ? { includeTags, excludeTags } : {};
    return {
      channelId, mode, target, includeTags, excludeTags, notificationDisabled, trackClicks, built, audience, estimate,
      quota, scheduledAt, warnings, fingerprint, lineSide, unprotected,
      targetHash: studioHash({ mode, target, ...tagFields, notificationDisabled, trackClicks }),
      messagesHash: studioHash(built.stored),
      expectedConfirmText: Number.isSafeInteger(estimate.estimate) ? String(estimate.estimate) : "ส่ง",
    };
  }

  function confirmationFields(prepared, sessionId) {
    return {
      sessionId, channelId: prepared.channelId, mode: prepared.mode, targetHash: prepared.targetHash,
      messagesHash: prepared.messagesHash, estimate: prepared.estimate.estimate, scheduledAt: prepared.scheduledAt,
      fingerprint: prepared.fingerprint,
    };
  }

  function summaryOf(prepared) {
    return {
      channelId: prepared.channelId,
      channelName: channelLabel(prepared.channelId),
      mode: prepared.mode,
      modeLabel: MODE_LABEL[prepared.mode],
      estimate: prepared.estimate.estimate,
      estimateKind: prepared.estimate.kind,
      estimateUpperBound: prepared.estimate.upperBound === true,
      targetedReaches: prepared.estimate.targetedReaches ?? null,
      followersDate: prepared.estimate.followers?.date || null,
      bubbles: prepared.built.stored.length,
      quota: prepared.quota,
      scheduledAt: prepared.scheduledAt,
      notificationDisabled: prepared.notificationDisabled,
      trackClicks: prepared.trackClicks,
      warnings: prepared.warnings,
      unprotected: prepared.unprotected,
      includeTags: prepared.includeTags,
      excludeTags: prepared.excludeTags,
      sample: prepared.audience
        ? prepared.audience.slice(0, 6).map((c, i) => c.known_name || c.display_name || `ลูกค้าในกลุ่ม ${i + 1}`)
        : [],
      expectedConfirmText: prepared.expectedConfirmText,
    };
  }

  // ประกอบข้อความจริงพร้อมลิงก์นับคลิก — ตรวจตัวกันราคาอีกรอบกับข้อความที่จะส่งจริง
  function finalMessages(prepared, { unitOwner = null } = {}) {
    const baseUrl = prepared.trackClicks ? studio.trackingBaseUrl() : "";
    const collector = createLinkCollector(baseUrl);
    const built = buildBroadcastMessages(prepared.built.stored, { imageCatalogByKey: catalogByKey(), linkTracker: collector.tracker });
    if (built.error) return { error: built.error };
    const guarded = engine.guardCheck(built.messages);
    if (!guarded.ok) return { error: guarded.error };
    return { built, links: collector.links, unitOwner };
  }

  function claimErrorResponse(json, res, claim) {
    if (claim.reason === "schedule_due") {
      return json(res, 409, { ok: false, error: "มีบรอดแคสต์ตั้งเวลาถึงกำหนดของ OA นี้ — ระบบไม่ให้การส่งมือแซงคิว" });
    }
    if (claim.reason === "delivery_quarantined") {
      return json(res, 409, { ok: false, error: "ผลส่งครั้งก่อนยังยืนยันไม่ได้ — ห้ามส่งซ้ำจนผู้ดูแลตรวจและบันทึกผล (ดูกล่อง \"ต้องตรวจผลส่ง\")" });
    }
    if (claim.reason === "active") {
      return json(res, 409, { ok: false, error: claim.active ? `บรอดแคสต์ #${claim.active.broadcast_no} ของ OA นี้กำลังส่งอยู่ — รอให้จบก่อน` : "OA นี้มีบรอดแคสต์กำลังส่งอยู่ — รอให้จบก่อน" });
    }
    return json(res, 429, { ok: false, error: `เพิ่งส่งบรอดแคสต์ไป ${Math.round((claim.sinceLast || 0) / 1000)} วิ — เว้นอย่างน้อย 60 วิ กันส่งซ้ำโดยไม่ตั้งใจ` });
  }

  function publicCampaign(row) {
    let messages = [];
    let target = {};
    let insight = null;
    try { messages = JSON.parse(row.messages_json || "[]"); } catch { messages = []; }
    try { target = JSON.parse(row.target_json || "{}"); } catch { target = {}; }
    try { insight = row.insight_json ? JSON.parse(row.insight_json) : null; } catch { insight = null; }
    const parseTags = (value) => { try { const v = JSON.parse(value || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
    return {
      id: row.id,
      broadcastNo: row.broadcast_no,
      channelId: row.channel_id,
      channelName: channelLabel(row.channel_id),
      mode: row.mode || "tags",
      modeLabel: MODE_LABEL[row.mode || "tags"],
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      messages: Array.isArray(messages) ? messages : [],
      target,
      includeTags: parseTags(row.include_tags_json),
      excludeTags: parseTags(row.exclude_tags_json),
      estimate: row.estimate ?? null,
      estimateKind: row.estimate_kind || "exact",
      audienceCount: row.audience_count,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      lastError: row.last_error || "",
      cancelRequested: Boolean(row.cancel_requested_at),
      notificationDisabled: Number(row.notification_disabled) === 1,
      clicks: Number(row.link_clicks) || 0,
      linkCount: Number(row.link_count) || 0,
      line: {
        requestIdPresent: Boolean(row.line_request_id),
        phase: row.line_phase || "",
        successCount: row.line_success_count ?? null,
        failureCount: row.line_failure_count ?? null,
        targetCount: row.line_target_count ?? null,
        error: row.line_error || "",
        progressAt: row.line_progress_at ?? null,
      },
      insight,
      insightAt: row.insight_at ?? null,
      recipientSummary: !row.mode || row.mode === "tags" ? db.broadcastRecipientSummary(row.id) : null,
    };
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "broadcast" || route[1] !== "studio") return false;
    const { readJson, json, username, sessionId, operator, requireCsrf, channelIds } = ctx;
    const canSend = hasOperatorCapability(operator, "broadcast.send");
    const requested = url.searchParams.get("channel") || null;
    if (requested && !channelIds.includes(requested)) {
      json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
      return true;
    }
    const selectedChannel = requested || channelIds[0];

    /* ---- GET studio/meta — ข้อมูลตั้งต้นของหน้าสตูดิโอ ---- */
    if (req.method === "GET" && route[2] === "meta" && route.length === 3) {
      const client = lineFor(selectedChannel);
      const followers = await studio.followersSnapshot(selectedChannel).catch(() => null);
      const quota = quotaPayload(await engine.quotaFor(selectedChannel).catch(() => null), 0);
      json(res, 200, {
        ok: true,
        channels: channelIds.map((id) => ({ id, name: channelLabel(id) })),
        channelId: selectedChannel,
        tagGroups: groupTagsByDimension(db.tagSummary({ channel: selectedChannel, limit: 500 })),
        presets: TAG_PRESETS,
        reachableKnown: db.broadcastAudienceCount({ channelId: selectedChannel, includeTags: ["*"] }),
        images: catalogEntries().map((entry) => ({
          key: entry.key, label: entry.label || entry.key, previewSrc: entry.consoleUrl || entry.url,
          uploaded: entry.uploaded === true, https: /^https:\/\//u.test(String(entry.url || "")),
        })),
        stickers: BASIC_STICKERS.map((sticker) => ({ ...sticker })),
        mediaUpload: mediaStatus(),
        limits: {
          maxBubbles: BROADCAST_MAX_BUBBLES, textMax: BROADCAST_TEXT_MAX, cardMax: CARD_MAX, cardTitleMax: CARD_TITLE_MAX,
          cardTextMax: CARD_TEXT_MAX, cardButtonMax: CARD_BUTTON_MAX, cardLabelMax: CARD_LABEL_MAX,
          cardMessageTextMax: CARD_MESSAGE_TEXT_MAX, altTextMax: ALT_TEXT_MAX, confirmTtlMs: STUDIO_CONFIRM_TTL_MS,
          narrowcastMinRecipients: NARROWCAST_MIN_RECIPIENTS, demographicMinTargetReach: DEMOGRAPHIC_MIN_TARGET_REACH,
          tagAudienceCap: BROADCAST_SCHEDULE_AUDIENCE_CAP,
        },
        canSend,
        canTestSend: canSend && ["owner", "admin"].includes(String(operator?.role || "")),
        scheduling: schedulingStatus(),
        tracking: { enabled: Boolean(studio.trackingBaseUrl()) },
        lineSide: {
          available: !pilotBlocksLineSide() && lineHasSendPath(client),
          reason: pilotBlocksLineSide() ? "pilot_mode" : (lineHasSendPath(client) ? "" : "live_send_off"),
        },
        followers: followers ? {
          date: followers.date, followers: followers.followers, blocks: followers.blocks,
          targetedReaches: followers.targetedReaches,
          reach: followers.followers === null ? null : Math.max(0, followers.followers - (followers.blocks || 0)),
        } : null,
        quota,
        demographic: { options: DEMOGRAPHIC_OPTIONS, areaLabels: THAI_AREA_LABELS },
      });
      return true;
    }

    /* ---- GET studio/audiences — กลุ่มเป้าหมายจาก LINE (รวมที่สร้างใน OA Manager) ---- */
    if (req.method === "GET" && route[2] === "audiences" && route.length === 3) {
      const result = await studio.audienceGroups(selectedChannel, { fresh: url.searchParams.get("fresh") === "1" });
      json(res, 200, {
        ok: true,
        available: result.ok === true,
        reason: result.ok ? "" : (result.reason || "unavailable"),
        truncated: result.truncated === true,
        groups: (result.groups || []).map((group) => ({
          ...group,
          typeLabel: AUDIENCE_TYPE_LABELS[group.type] || group.type,
          routeLabel: AUDIENCE_ROUTE_LABELS[group.createRoute] || group.createRoute,
          usable: group.status === "READY",
          minRecipientExempt: MIN_RECIPIENT_EXEMPT_TYPES.has(group.type),
        })),
        notice: "กลุ่มที่สร้างใน LINE OA Manager (เช่นแท็กแชท/ช่องทางเพิ่มเพื่อน) ใช้ส่งผ่าน API ได้ตามเอกสาร LINE · ระบบนี้สร้าง/แก้กลุ่มเหล่านี้ไม่ได้",
      });
      return true;
    }

    /* ---- GET studio/campaigns — ประวัติพร้อมผลลัพธ์ (ไม่ยิง LINE) ---- */
    if (req.method === "GET" && route[2] === "campaigns" && route.length === 3) {
      json(res, 200, {
        ok: true,
        campaigns: db.listBroadcastCampaigns({ channel: selectedChannel, limit: 30 }).map(publicCampaign),
      });
      return true;
    }

    /* ---- GET studio/campaigns/:id — รายละเอียด + อัปเดตผลจาก LINE (มีเพดานคำขอ) ---- */
    if (req.method === "GET" && route[2] === "campaigns" && route.length === 4) {
      const existing = db.getBroadcastCampaignRow(route[3]);
      if (!existing) {
        json(res, 404, { ok: false, error: "ไม่พบแคมเปญนี้" });
        return true;
      }
      if (!channelIds.includes(existing.channel_id)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      let row = existing;
      try {
        row = (await studio.refreshCampaign(existing.id, { force: url.searchParams.get("refresh") === "1" })) || existing;
      } catch (error) {
        logger.warn?.(`broadcastStudio: อัปเดตผลจาก LINE ไม่สำเร็จ (${error?.message || error})`);
      }
      const clicks = db.trackedLinks("broadcast", row.id);
      json(res, 200, {
        ok: true,
        campaign: {
          ...publicCampaign({ ...row, link_clicks: clicks.reduce((s, l) => s + Number(l.clicks || 0), 0), link_count: clicks.length }),
          links: clicks.map((link) => ({
            label: link.label, url: link.url, clicks: link.clicks, lastClickAt: link.last_click_at,
          })),
          outcomes: studio.campaignOutcomes(row),
        },
        notice: "คลิก = จำนวนครั้งที่ลิงก์ของเราถูกเปิด (ตัดบอทพรีวิวลิงก์ออกเท่าที่ทำได้) · ตอบกลับ/ออเดอร์ = เกิดขึ้นหลังส่ง ไม่ได้แปลว่าเกิดเพราะข้อความนี้",
      });
      return true;
    }

    /* ---------------------------- mutations ---------------------------- */
    if (req.method !== "POST") return false;
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }

    /* ---- POST studio/estimate — ตัวเลขผู้รับ + ผลกับโควตา (ไม่มีใบยืนยัน) ---- */
    if (route[2] === "estimate" && route.length === 3) {
      const body = await readJson(req);
      const channelId = String(body.channelId || "default");
      if (!channelIds.includes(channelId)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      const mode = String(body.mode || "tags");
      if (!STUDIO_MODES.includes(mode)) {
        json(res, 400, { ok: false, error: "โหมดผู้รับไม่ถูกต้อง" });
        return true;
      }
      if (mode === "tags") {
        const includeTags = cleanTags(body.includeTags);
        const excludeTags = cleanTags(body.excludeTags);
        if (includeTags === null || excludeTags === null) {
          json(res, 400, { ok: false, error: "ตัวกรองป้ายต้องเป็นลิสต์ไม่เกิน 20 ป้าย" });
          return true;
        }
        if (!includeTags.length) {
          json(res, 200, { ok: true, mode, estimate: 0, estimateKind: "exact", unselected: true, quota: await quotaFresh(channelId, 0, { fresh: false }) });
          return true;
        }
        const audience = db.broadcastAudience({ channelId, includeTags, excludeTags });
        json(res, 200, {
          ok: true, mode, estimate: audience.length, estimateKind: "exact",
          total: db.broadcastAudienceCount({ channelId, includeTags: ["*"] }),
          overCap: audience.length > BROADCAST_SCHEDULE_AUDIENCE_CAP,
          sample: audience.slice(0, 6).map((c, i) => c.known_name || c.display_name || `ลูกค้าในกลุ่ม ${i + 1}`),
          quota: await quotaFresh(channelId, audience.length, { fresh: false }),
        });
        return true;
      }
      const normalized = normalizeStudioTarget(mode, body.target || {});
      if (normalized.error) {
        json(res, 200, { ok: true, mode, estimate: null, estimateKind: "line_decides", invalid: normalized.error, quota: await quotaFresh(channelId, 0, { fresh: false }) });
        return true;
      }
      const estimate = await studio.estimateFor(channelId, mode, normalized.target);
      json(res, 200, {
        ok: true, mode, estimate: estimate.estimate, estimateKind: estimate.kind, reason: estimate.reason || "",
        upperBound: estimate.upperBound === true, targetedReaches: estimate.targetedReaches ?? null,
        followersDate: estimate.followers?.date || null,
        quota: await quotaFresh(channelId, Number.isSafeInteger(estimate.estimate) ? estimate.estimate : 0, { fresh: false }),
      });
      return true;
    }

    if (!canSend) {
      json(res, 403, { ok: false, error: "บัญชีนี้ร่างข้อความได้ แต่ส่ง/ตั้งเวลา/ทดสอบบรอดแคสต์จริงไม่ได้" });
      return true;
    }

    /* ---- POST studio/test — ส่งทดสอบถึงตัวเอง (Owner/Admin · LINE ที่ยืนยันตัวตนแล้วเท่านั้น) ---- */
    if (route[2] === "test" && route.length === 3) {
      if (!["owner", "admin"].includes(String(operator?.role || ""))) {
        json(res, 403, { ok: false, error: "ส่งทดสอบได้เฉพาะ Owner/Admin ที่ลงทะเบียน LINE ทดสอบไว้แล้ว" });
        return true;
      }
      const body = await readJson(req);
      if (body.confirm !== true || body.to !== undefined || body.recipient !== undefined) {
        json(res, 400, { ok: false, error: "ต้องยืนยันการส่งทดสอบ และกำหนดผู้รับเองไม่ได้" });
        return true;
      }
      const channelId = String(body.channelId || "default");
      if (!channelIds.includes(channelId)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      const destination = db.getBroadcastSelfTestDestination({
        operatorUsername: username, sessionHash: sessionBinding(config.consoleSessionSecret, sessionId), channelId,
      });
      if (!destination) {
        json(res, 409, { ok: false, error: "ยังไม่ได้ยืนยัน LINE ทดสอบของคุณกับ OA นี้ (ส่งรหัสยืนยันในกล่อง \"ส่งทดสอบถึงตัวเอง\" ก่อน)" });
        return true;
      }
      const ready = engine.sendReady(channelId);
      if (!ready.ok) {
        json(res, 502, { ok: false, error: ready.error });
        return true;
      }
      const built = buildBroadcastMessages(body.messages, { imageCatalogByKey: catalogByKey() });
      if (built.error) {
        json(res, 400, { ok: false, error: built.error });
        return true;
      }
      const guarded = engine.guardCheck(built.messages);
      if (!guarded.ok) {
        json(res, 400, { ok: false, error: guarded.error });
        return true;
      }
      if (!allowTestSend(username)) {
        json(res, 429, { ok: false, error: `ส่งทดสอบได้ไม่เกิน ${TEST_SENDS_PER_WINDOW} ครั้งต่อ 10 นาที` });
        return true;
      }
      const quota = quotaPayload(await engine.quotaFor(channelId, { fresh: true }), 1);
      const quotaProblem = quotaError(quota);
      if (quotaProblem) {
        json(res, 400, { ok: false, error: quotaProblem });
        return true;
      }
      const client = lineFor(channelId);
      const to = lineRegistry?.rawUserId ? lineRegistry.rawUserId(destination.line_user_id) : destination.line_user_id;
      let result;
      try {
        // retry key ต่อครั้งที่กด — ถ้า LINE ตอบไม่ชัดแล้วเครือข่ายส่งซ้ำ LINE จะไม่ส่งถึงเครื่องซ้ำ
        result = await client.pushMessages({ to, messages: built.messages, retryKey: randomUUID(), purpose: SEND_PURPOSE.broadcast });
      } catch {
        result = { ok: false, ambiguous: true };
      }
      const state = result?.ok ? "accepted" : (result?.ambiguous ? "unknown" : "rejected");
      try {
        db.addAudit({ operator: username, action: "broadcast_studio_test_push", target: channelId, detail: `provider=${state}; bubbles=${built.stored.length}` });
      } catch (error) {
        logger.error?.(`broadcastStudio: audit ส่งทดสอบไม่สำเร็จหลัง provider=${state} (${error?.message || error})`);
      }
      json(res, state === "accepted" ? 200 : (state === "unknown" ? 202 : 502), {
        ok: state === "accepted", state,
        notice: state === "accepted"
          ? "LINE รับคำขอส่งทดสอบแล้ว (ยังไม่ใช่หลักฐานว่าเปิดอ่าน)"
          : state === "unknown" ? "LINE ยังยืนยันผลไม่ได้ — ระบบไม่ส่งซ้ำอัตโนมัติ" : `LINE ปฏิเสธคำขอ${result?.status ? ` (HTTP ${result.status})` : ""}${result?.reason ? ` · ${result.reason}` : ""}`,
      });
      return true;
    }

    /* ---- POST studio/preview — ตรวจครบ + ใบยืนยัน 45 วิ (ยังไม่ส่งอะไร) ---- */
    if (route[2] === "preview" && route.length === 3) {
      const body = await readJson(req);
      const forSchedule = body.scheduledAt !== undefined && body.scheduledAt !== null && body.scheduledAt !== "";
      if (forSchedule && (config.broadcastScheduleEnabled !== true || !schedulingStatus().enabled)) {
        json(res, 503, { ok: false, error: "ระบบตั้งเวลาบรอดแคสต์ยังปิดอยู่" });
        return true;
      }
      const prepared = await prepare(body, { channelIds, forSchedule });
      if (prepared.error) {
        json(res, prepared.status, { ok: false, error: prepared.error });
        return true;
      }
      json(res, 200, {
        ok: true,
        summary: summaryOf(prepared),
        studioConfirmation: makeStudioConfirmation({
          secret: config.consoleSessionSecret, now, ...confirmationFields(prepared, sessionId),
        }),
        confirmationExpiresAt: now() + STUDIO_CONFIRM_TTL_MS,
      });
      return true;
    }

    /* ---- POST studio/send และ studio/schedule — ต้องมี preview ล่าสุด + พิมพ์ยืนยัน ---- */
    if ((route[2] === "send" || route[2] === "schedule") && route.length === 3) {
      const forSchedule = route[2] === "schedule";
      if (forSchedule && (config.broadcastScheduleEnabled !== true || !schedulingStatus().enabled)) {
        json(res, 503, { ok: false, error: "ระบบตั้งเวลาบรอดแคสต์ยังปิดอยู่" });
        return true;
      }
      const body = await readJson(req);
      if (body.confirm !== true) {
        json(res, 400, { ok: false, error: "ต้องยืนยันก่อนส่ง (confirm)" });
        return true;
      }
      const channelId = String(body.channelId || "default");
      if (!forSchedule && channelIds.includes(channelId) && db.dueBroadcastScheduleForChannel(channelId, now())) {
        json(res, 409, { ok: false, error: "OA นี้มีบรอดแคสต์ตั้งเวลาที่ถึงกำหนดแล้ว — รอให้ระบบจัดการหรือยกเลิกงานนั้นก่อน" });
        return true;
      }
      if (!forSchedule) {
        const ready = engine.sendReady(channelId);
        if (!ready.ok) {
          json(res, 502, { ok: false, error: ready.error });
          return true;
        }
      }
      const prepared = await prepare(body, { channelIds, forSchedule });
      if (prepared.error) {
        json(res, prepared.status, { ok: false, error: prepared.error });
        return true;
      }
      if (String(body.confirmText ?? "").trim() !== prepared.expectedConfirmText) {
        json(res, 400, { ok: false, error: `คำยืนยันไม่ตรง — ต้องพิมพ์ ${prepared.expectedConfirmText} (จำนวนผู้รับล่าสุดอาจเปลี่ยน ลองตรวจใหม่)` });
        return true;
      }
      if (!studioConfirmationMatches({
        token: body.studioConfirmation, secret: config.consoleSessionSecret, now, ...confirmationFields(prepared, sessionId),
      })) {
        json(res, 400, { ok: false, error: "ใบยืนยันหมดอายุหรือไม่ตรงกับข้อความ/ผู้รับล่าสุด — กดตรวจใหม่อีกครั้ง" });
        return true;
      }

      if (forSchedule) {
        let row;
        try {
          row = db.createStudioSchedule({
            channelId: prepared.channelId, messages: prepared.built.stored,
            includeTags: prepared.includeTags, excludeTags: prepared.excludeTags,
            scheduledAt: prepared.scheduledAt,
            previewCount: Number.isSafeInteger(prepared.estimate.estimate) ? prepared.estimate.estimate : 0,
            audienceFingerprint: prepared.mode === "tags" ? prepared.fingerprint : `line:${prepared.mode}`,
            confirmationHash: createHash("sha256").update(String(body.studioConfirmation)).digest("hex"),
            confirmationExpiresAt: Number(String(body.studioConfirmation).split(".")[0]) + STUDIO_CONFIRM_TTL_MS,
            createdBy: username, mode: prepared.mode, target: prepared.target,
            notificationDisabled: prepared.notificationDisabled, trackClicks: prepared.trackClicks,
          });
        } catch (error) {
          if (error?.code === "BROADCAST_SCHEDULE_CONFIRMATION_REPLAY") {
            json(res, 409, { ok: false, error: "ใบยืนยันนี้ถูกใช้ไปแล้ว — กดตรวจใหม่" });
            return true;
          }
          throw error;
        }
        db.addAudit({
          operator: username, action: "broadcast_schedule_created", target: prepared.channelId,
          detail: `schedule=${row.id}; mode=${prepared.mode}; at=${prepared.scheduledAt}; estimate=${prepared.estimate.estimate ?? "line"}`.slice(0, 200),
        });
        json(res, 201, { ok: true, schedule: { id: row.id, scheduledAt: row.scheduled_at, status: row.status } });
        return true;
      }

      const final = finalMessages(prepared);
      if (final.error) {
        json(res, 400, { ok: false, error: final.error });
        return true;
      }
      // โควตาอ่านสดอีกครั้งติดกับจังหวะจองคิว (preview อาจอ่านจาก cache 5 นาที)
      const estimatedUse = Number.isSafeInteger(prepared.estimate.estimate) ? prepared.estimate.estimate : 0;
      const quota = await quotaFresh(prepared.channelId, quotaUseFor(prepared.mode, prepared.estimate.estimate));
      const quotaProblem = quotaError(quota);
      if (quotaProblem) {
        json(res, 400, { ok: false, error: quotaProblem });
        return true;
      }
      let claim;
      try {
        claim = db.claimBroadcast({
          channelId: prepared.channelId, messages: prepared.built.stored,
          includeTags: prepared.includeTags, excludeTags: prepared.excludeTags,
          audience: prepared.mode === "tags" ? prepared.audience : null,
          audienceCount: estimatedUse,
          createdBy: username, cooldownMs: SEND_COOLDOWN_MS,
          ownerToken: engine.broadcastOwnerToken, leaseDurationMs: BROADCAST_CLAIM_LEASE_MS, manual: true,
        });
      } catch (error) {
        logger.warn?.(`broadcastStudio: claim ไม่สำเร็จ (${error?.message || error})`);
        json(res, 503, { ok: false, error: "จองคิวบรอดแคสต์ไม่สำเร็จ — กรุณาลองใหม่อีกครั้ง" });
        return true;
      }
      if (!claim.ok) {
        claimErrorResponse(json, res, claim);
        return true;
      }
      const broadcast = claim.row;
      const aggregationUnit = prepared.mode === "tags" ? aggregationUnitFor("broadcast", broadcast.id) : "";
      try {
        db.attachBroadcastCampaign({
          broadcastId: broadcast.id, channelId: prepared.channelId, mode: prepared.mode, target: prepared.target,
          estimate: Number.isSafeInteger(prepared.estimate.estimate) ? prepared.estimate.estimate : null,
          estimateKind: prepared.estimate.kind, notificationDisabled: prepared.notificationDisabled,
          aggregationUnit, links: final.links,
        });
      } catch (error) {
        logger.error?.(`broadcastStudio: บันทึกแคมเปญไม่สำเร็จ — ยกเลิกก่อนเรียก LINE (${error?.message || error})`);
        try {
          db.finalizeBroadcastClaim(prepared.channelId, broadcast.id, engine.broadcastOwnerToken, {
            status: "failed", lastError: "บันทึกแคมเปญไม่สำเร็จ — ไม่ได้เรียก LINE",
          });
        } catch { /* lease หมดเองตามกติกาเดิม */ }
        json(res, 503, { ok: false, error: "บันทึกแคมเปญไม่สำเร็จ — ยังไม่ได้ส่ง กรุณาลองใหม่" });
        return true;
      }
      db.addAudit({
        operator: username, action: "broadcast_send", target: prepared.channelId,
        detail: `#${broadcast.broadcast_no} ${prepared.mode} -> ${estimatedUse || "LINE คำนวณ"}; links=${final.links.length}`.slice(0, 200),
      });
      setTimeout(() => {
        const job = prepared.mode === "tags"
          ? engine.runSend({
              broadcastId: broadcast.id, channelId: prepared.channelId, audience: prepared.audience,
              messages: final.built.messages, storedMessages: final.built.stored, operator: username,
              includeTags: prepared.includeTags, excludeTags: prepared.excludeTags,
              claimOwnerToken: engine.broadcastOwnerToken, aggregationUnit,
            })
          : studio.runLineSideSend({
              broadcastId: broadcast.id, channelId: prepared.channelId, mode: prepared.mode, target: prepared.target,
              messages: final.built.messages, notificationDisabled: prepared.notificationDisabled, operator: username,
              claimOwnerToken: engine.broadcastOwnerToken, estimate: estimatedUse,
            });
        Promise.resolve(job).catch((error) => logger.error?.(`broadcastStudio: งานส่งล้มเหลว (${error?.message || error})`));
      }, 0);
      json(res, 200, {
        ok: true,
        broadcast: { id: broadcast.id, broadcastNo: broadcast.broadcast_no, status: broadcast.status },
        mode: prepared.mode,
        estimate: prepared.estimate.estimate,
      });
      return true;
    }

    return false;
  }

  return { handle };
}
