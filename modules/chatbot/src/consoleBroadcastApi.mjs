// consoleBroadcastApi.mjs — เส้นทาง /console/api/broadcast* (v1.2)
// แยกจาก consoleApi.mjs เพื่อคุมขนาดไฟล์ <800 — session ถูกตรวจก่อนถึงตรงนี้แล้ว
// ทุก mutation: CSRF + audit; การส่งจริงต้องมี confirm: true จาก UI (สอง gate ฝั่งคน)
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { buildBroadcastMessages, BROADCAST_CLAIM_LEASE_MS, BROADCAST_MAX_BUBBLES } from "./broadcast.mjs";
import {
  BROADCAST_SCHEDULE_AUDIENCE_CAP,
  broadcastAudienceFingerprint,
  validFutureBangkokSchedule,
} from "./broadcastSchedule.mjs";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { createBroadcastStudioRoutes } from "./consoleBroadcastStudioApi.mjs";
import { createStepMessageRoutes } from "./consoleStepMessagesApi.mjs";
import { isLineSideFingerprint } from "./dbBroadcastStudio.mjs";

const TAG_FILTER_MAX = 20;
const UPLOAD_ATTEMPTS_PER_WINDOW = 20;
const UPLOAD_ATTEMPT_WINDOW_MS = 5 * 60_000;
const UPLOAD_BODY_TIMEOUT_MS = 15_000;
const UPLOAD_MAX_CONCURRENT = 4;
// REVIEW FIX: กันมือลั่นส่งรัว — เว้นอย่างน้อย 60 วิ ต่อสาขา ระหว่างบรอดแคสสองครั้ง
const SEND_COOLDOWN_MS = 60_000;
const BROADCAST_AUDIENCE_CAP = BROADCAST_SCHEDULE_AUDIENCE_CAP;
// ต้องสั้นกว่า cooldown 60 วิ เพื่อให้ token จากงานก่อน replay หลัง cooldown ไม่ได้
const AUDIENCE_CONFIRM_TTL_MS = 45_000;
const SELF_TEST_CHALLENGE_TTL_MS = 5 * 60_000;

function safeQuotaNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function quotaPayload(quota, estimatedUse) {
  if (quota?.type === "limited") {
    const limit = safeQuotaNumber(quota.value);
    const used = safeQuotaNumber(quota.totalUsage);
    if (limit === null || used === null) return { type: "unknown", limit: null, used: null, remaining: null, estimatedUse, remainingAfter: null };
    const remaining = limit - used;
    return { type: "limited", limit, used, remaining, estimatedUse, remainingAfter: remaining - estimatedUse };
  }
  if (quota?.type === "none") {
    if (safeQuotaNumber(quota.totalUsage) === null) return { type: "unknown", limit: null, used: null, remaining: null, estimatedUse, remainingAfter: null };
    return { type: "unlimited", limit: null, used: null, remaining: null, estimatedUse, remainingAfter: null };
  }
  return { type: "unknown", limit: null, used: null, remaining: null, estimatedUse, remainingAfter: null };
}

export function quotaError(quota) {
  if (quota.type === "unknown") return "อ่านโควตา LINE ไม่ได้หรือข้อมูลไม่สมบูรณ์ — ระบบยังไม่รับงานส่ง";
  if (quota.type === "limited" && quota.remainingAfter < 0) {
    return `โควตา LINE คงเหลือ ${quota.remaining} ไม่พอสำหรับการส่งครั้งนี้ (${quota.estimatedUse})`;
  }
  return "";
}

function audienceFingerprint(audience) {
  return createHash("sha256")
    .update(audience.map((customer) => String(customer.line_user_id)).sort().join("\n"))
    .digest("base64url");
}

function confirmationPayload({ sessionId, channelId, includeTags, excludeTags, fingerprint, issuedAt, nonce }) {
  return JSON.stringify({
    v: 1, sid: sessionId, channelId,
    includeTags: [...includeTags].sort(), excludeTags: [...excludeTags].sort(),
    fingerprint, issuedAt, nonce,
  });
}

function makeAudienceConfirmation({ secret, sessionId, channelId, includeTags, excludeTags, audience, now }) {
  const issuedAt = now();
  const nonce = randomBytes(16).toString("base64url");
  const payload = confirmationPayload({
    sessionId, channelId, includeTags, excludeTags, fingerprint: audienceFingerprint(audience), issuedAt, nonce,
  });
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${issuedAt}.${nonce}.${signature}`;
}

function confirmationMatches({ token, secret, sessionId, channelId, includeTags, excludeTags, audience, now }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{22}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return false;
  const issuedAt = Number(parts[0]);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now() + 5_000 || now() - issuedAt > AUDIENCE_CONFIRM_TTL_MS) return false;
  const payload = confirmationPayload({
    sessionId, channelId, includeTags, excludeTags, fingerprint: audienceFingerprint(audience), issuedAt, nonce: parts[1],
  });
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const actual = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function scheduleConfirmationPayload({ sessionId, channelId, includeTags, excludeTags, fingerprint, messages, scheduledAt, issuedAt, nonce }) {
  return JSON.stringify({
    v: 2,
    sid: sessionId,
    channelId,
    includeTags: [...includeTags].sort(),
    excludeTags: [...excludeTags].sort(),
    fingerprint,
    messages,
    scheduledAt,
    issuedAt,
    nonce,
  });
}

export function makeScheduleConfirmation({ secret, sessionId, channelId, includeTags, excludeTags, audience, messages, scheduledAt, now }) {
  const issuedAt = now();
  const nonce = randomBytes(16).toString("base64url");
  const payload = scheduleConfirmationPayload({
    sessionId, channelId, includeTags, excludeTags,
    fingerprint: broadcastAudienceFingerprint(audience), messages, scheduledAt, issuedAt, nonce,
  });
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${issuedAt}.${nonce}.${signature}`;
}

export function scheduleConfirmationMatches({ token, secret, sessionId, channelId, includeTags, excludeTags, audience, messages, scheduledAt, now }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !/^\d{13}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{22}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return false;
  const issuedAt = Number(parts[0]);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now() + 5_000 || now() - issuedAt > AUDIENCE_CONFIRM_TTL_MS) return false;
  const payload = scheduleConfirmationPayload({
    sessionId, channelId, includeTags, excludeTags,
    fingerprint: broadcastAudienceFingerprint(audience), messages, scheduledAt, issuedAt, nonce: parts[1],
  });
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const actual = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expected);
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function quarantineResolutionConfirmationText(id, resolution) {
  return `RESOLVE:${String(id || "")}:${String(resolution || "")}`;
}

export function sessionBinding(secret, sessionId) {
  return createHmac("sha256", secret).update(String(sessionId || "")).digest("hex");
}

function makeSelfTestChallenge() {
  // Unambiguous ASCII avoids LINE normalization/emoji surprises. This exact
  // string is disclosed only to the current logged-in operator to paste into OA.
  return `LKP-SELF-${randomBytes(18).toString("base64url")}`;
}

export function cleanTags(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const tags = [...new Set(raw.map((t) => String(t || "").trim()).filter(Boolean))];
  return tags.length > TAG_FILTER_MAX ? null : tags;
}

function createUploadAttemptLimiter(now) {
  const buckets = new Map();
  const activeByOperator = new Map();
  let activeTotal = 0;

  function begin(rawKey) {
    const key = String(rawKey || "unknown");
    const at = now();
    let bucket = buckets.get(key);
    if (!bucket || at - bucket.startedAt >= UPLOAD_ATTEMPT_WINDOW_MS) {
      bucket = { startedAt: at, attempts: 0 };
      buckets.set(key, bucket);
    }
    if (bucket.attempts >= UPLOAD_ATTEMPTS_PER_WINDOW) {
      return { ok: false, retryAfterMs: Math.max(0, bucket.startedAt + UPLOAD_ATTEMPT_WINDOW_MS - at) };
    }
    bucket.attempts += 1; // นับทุก attempt รวมไฟล์เสีย/ซ้ำ — กัน parser abuse
    if (activeTotal >= UPLOAD_MAX_CONCURRENT || (activeByOperator.get(key) || 0) >= 1) {
      return { ok: false, retryAfterMs: 1_000 };
    }
    activeTotal += 1;
    activeByOperator.set(key, 1);
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        activeTotal = Math.max(0, activeTotal - 1);
        activeByOperator.delete(key);
      },
    };
  }

  return { begin };
}

export function createBroadcastRoutes({ db, config, engine, scheduler = null, channels = [], channelLabel = (id) => String(id || "default"), imageCatalog = [], broadcastMedia = null, logger = console, now = Date.now, studio = null, stepMessages = null, lineRegistry = null }) {
  // needsVerification=true ยังไม่ใช่รูปอนุมัติ — ห้ามโผล่ใน picker และห้ามส่งแม้รู้ key
  const verifiedCatalog = imageCatalog.filter((entry) => entry?.needsVerification !== true);
  const activeChannelIds = () => (channels.length ? channels.filter((c) => c.active).map((c) => c.id) : ["default"]);
  const authorizedChannelIds = (username, role) => {
    const active = activeChannelIds();
    if (active.length <= 1 || role === "owner" || role === "admin") return active;
    const grants = new Set(db.listOperatorChannels(username));
    return active.filter((id) => grants.has(id));
  };
  const mediaStatus = () => broadcastMedia?.status?.() || {
    enabled: false, reason: "media upload ยังไม่ได้ตั้งค่า", maxBytes: 1_000_000,
    formats: ["image/jpeg", "image/png"],
  };
  const uploadAttempts = createUploadAttemptLimiter(now);
  const catalogEntries = () => {
    const merged = new Map(verifiedCatalog.map((entry) => [entry.key, entry]));
    for (const entry of broadcastMedia?.list?.() || []) {
      if (!merged.has(entry.key)) merged.set(entry.key, entry);
    }
    return [...merged.values()];
  };
  const schedulingStatus = () => {
    const snapshot = scheduler?.healthSnapshot?.() || null;
    const enabled = config.broadcastScheduleEnabled === true && Boolean(scheduler);
    return {
      enabled,
      armed: enabled && snapshot?.armed === true,
      tickMs: enabled ? (snapshot?.tickMs || config.broadcastScheduleTickMs) : null,
      timezone: "Asia/Bangkok",
      quietHours: "21:00-09:00",
      reason: enabled
        ? "ตั้งเวลาได้เฉพาะ 09:00–21:00 Asia/Bangkok และจะตรวจกลุ่ม/โควตาใหม่ก่อนส่งจริง"
        // audit 2026-08-25: ข้อความเดิมสั่งให้แก้ env ซึ่งทำไม่ได้จริง — phase-7 launcher
        // ตรึง BROADCAST_SCHEDULE_ENABLED=false ไว้ในสภาพแวดล้อมที่สร้างขึ้น การแก้ไฟล์ env
        // จึงไม่มีผลและไม่มี error ให้เห็น ต้องออก release ใหม่เท่านั้น
        : "ยังไม่เปิดตั้งเวลา — ต้องออก immutable release ใหม่ (แก้ไฟล์ env ไม่มีผล เพราะ launcher ตรึงค่าไว้)",
    };
  };
  const publicSchedule = (row) => ({
    id: row.id,
    channel_id: row.channel_id,
    messages_json: row.messages_json,
    include_tags_json: row.include_tags_json,
    exclude_tags_json: row.exclude_tags_json,
    scheduled_at: row.scheduled_at,
    preview_count: row.preview_count,
    status: row.status,
    broadcast_id: row.broadcast_id || null,
    broadcast_status: row.broadcast_status || null,
    broadcast_sent_count: row.broadcast_sent_count ?? null,
    broadcast_failed_count: row.broadcast_failed_count ?? null,
    broadcast_audience_count: row.broadcast_audience_count ?? null,
    broadcast_last_error: row.broadcast_last_error || "",
    quiet_deferred_count: row.quiet_deferred_count,
    last_quiet_deferred_at: row.last_quiet_deferred_at,
    last_failure_phase: row.last_failure_phase,
    last_error: row.last_error,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    dispatched_at: row.dispatched_at,
    cancelled_at: row.cancelled_at,
    failed_at: row.failed_at,
  });
  // 28 ก.ย. 2026: สตูดิโอ (/broadcast/studio/*) + ข้อความตามขั้น (/broadcast/steps/*) ใช้สิทธิ์ OA ชุดเดียวกับหน้านี้
  const studioRoutes = studio
    ? createBroadcastStudioRoutes({
        db, config, engine, studio, channelLabel, catalogEntries, mediaStatus, schedulingStatus, lineRegistry, logger, now,
      })
    : null;
  const stepRoutes = stepMessages
    ? createStepMessageRoutes({
        db, config, engine, stepMessages, studio, channelLabel, catalogEntries, lineRegistry, logger, now,
      })
    : null;
  const publicQuarantine = (row) => {
    const outcomeCategory = {
      status_0: "provider_response_missing",
      server_error: "provider_server_error",
      exception: "network_or_client_exception",
      ambiguous: "provider_ambiguous",
    }[row.failure_kind] || "provider_ambiguous";
    return {
      id: row.id,
      channelId: row.channel_id,
      channelName: channelLabel(row.channel_id),
      status: row.resolved_at ? "resolved" : "unresolved",
      recipientCount: Number(row.recipient_count ?? row.attempted_count) || 0,
      // ส่งฝั่ง LINE (เพื่อนทุกคน/กลุ่มเป้าหมาย) ไม่มีรายชื่อ — ตัวเลขเป็นค่าประมาณ และกันทั้ง OA
      lineSide: isLineSideFingerprint(row.audience_fingerprint),
      outcomeCategory,
      createdAt: Number(row.created_at) || 0,
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
      resolution: row.resolution || null,
    };
  };
  const permissionPayload = () => {
    const active = activeChannelIds();
    return {
      channels: active.map((id) => ({ id, name: channelLabel(id) })),
      operators: db.listOperatorsForPermissions().map((entry) => ({
        username: entry.username,
        displayName: entry.display_name,
        role: entry.role,
        disabled: entry.disabled === 1,
        channels: entry.role === "owner" || entry.role === "admin"
          ? active
          : db.listOperatorChannels(entry.username).filter((id) => active.includes(id)),
      })),
    };
  };

  async function validateSchedulePayload(body, { channelIds }) {
    const channelId = String(body.channelId || "default");
    if (!channelIds.includes(channelId)) return { status: 403, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" };
    const scheduledAt = Number(body.scheduledAt);
    const timeCheck = validFutureBangkokSchedule(scheduledAt, now());
    if (!timeCheck.ok) return { status: 400, error: timeCheck.error };
    const includeTags = cleanTags(body.includeTags);
    const excludeTags = cleanTags(body.excludeTags);
    if (includeTags === null || excludeTags === null) {
      return { status: 400, error: `tag filter ต้องเป็นลิสต์ไม่เกิน ${TAG_FILTER_MAX} ป้าย` };
    }
    if (!includeTags.length) return { status: 400, error: "ต้องเลือกป้ายลูกค้าอย่างน้อย 1 ป้ายก่อนตั้งเวลา" };
    const built = buildBroadcastMessages(body.messages, {
      imageCatalogByKey: new Map(catalogEntries().map((entry) => [entry.key, entry])),
    });
    if (built.error) return { status: 400, error: built.error };
    const guarded = engine.guardCheck(built.messages);
    if (!guarded.ok) return { status: 400, error: guarded.error };
    const audience = db.broadcastAudience({ channelId, includeTags, excludeTags });
    if (!audience.length) return { status: 400, error: "audience ว่าง — ไม่มีลูกค้าตรงเงื่อนไข" };
    if (audience.length > BROADCAST_AUDIENCE_CAP) {
      return { status: 400, error: `กลุ่มมี ${audience.length} คน เกินเพดาน ${BROADCAST_AUDIENCE_CAP} คนต่อครั้ง` };
    }
    const quota = quotaPayload(await engine.quotaFor(channelId, { fresh: true }), audience.length);
    const quotaProblem = quotaError(quota);
    if (quotaProblem) return { status: 400, error: quotaProblem };
    return {
      channelId, scheduledAt, includeTags, excludeTags,
      built, audience, quota,
      fingerprint: broadcastAudienceFingerprint(audience),
    };
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "broadcast") return false;
    const { readJson, json, username, sessionId, operator, requireCsrf } = ctx;
    const channelIds = authorizedChannelIds(username, operator?.role);
    if (!channelIds.length) {
      json(res, 403, { ok: false, error: "บัญชีนี้ยังไม่ได้รับสิทธิ์ Broadcast ของ LINE OA ใด" });
      return true;
    }
    if (route[1] === "studio" || route[1] === "steps") {
      const routes = route[1] === "studio" ? studioRoutes : stepRoutes;
      if (!routes) {
        json(res, 404, { ok: false, error: "ส่วนนี้ยังไม่เปิดใช้งาน" });
        return true;
      }
      const handled = await routes.handle(req, res, url, route, { ...ctx, channelIds });
      if (!handled) json(res, 404, { ok: false, error: "ไม่พบเส้นทางนี้" });
      return true;
    }

    /* ---- B-12: one-person real Push self-test destination ---- */
    if (route[1] === "self-test" && (route.length === 2 || route.length === 3)) {
      const currentSessionHash = sessionBinding(config.consoleSessionSecret, sessionId);
      const requested = url.searchParams.get("channel") || null;
      if (req.method === "GET") {
        if (requested && !channelIds.includes(requested)) {
          json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
          return true;
        }
        const channelId = requested || channelIds[0];
        json(res, 200, {
          ok: true,
          channelId,
          destination: db.broadcastSelfTestStatus({ operatorUsername: username, sessionHash: currentSessionHash, channelId }),
          notice: "การส่งทดสอบจะเป็น LINE Push จริง 1 ข้อความถึงบัญชีที่ยืนยันไว้เท่านั้น",
        });
        return true;
      }
      if (route.length !== 3 || !requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      if (!hasOperatorCapability(operator, "broadcast.send")) {
        json(res, 403, { ok: false, error: "เฉพาะ Owner/Admin ที่มีสิทธิ์ส่งจึงจัดการการส่งทดสอบได้" });
        return true;
      }
      const body = await readJson(req);
      const channelId = String(body.channelId || "default");
      if (!channelIds.includes(channelId)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      if (route[2] === "challenge" && req.method === "POST" && route.length === 3) {
        const challenge = makeSelfTestChallenge();
        const expiresAt = now() + SELF_TEST_CHALLENGE_TTL_MS;
        try {
          db.createBroadcastSelfTestChallenge({
            operatorUsername: username,
            sessionHash: currentSessionHash,
            channelId,
            challenge,
            expiresAt,
          });
          db.addAudit({
            operator: username, action: "broadcast_self_test_challenge_created", target: channelId,
            detail: "รอข้อความยืนยันจาก OA ภายใน 5 นาที",
          });
          json(res, 201, {
            ok: true, channelId, challenge, expiresAt,
            instruction: "ส่งข้อความนี้เข้ามาที่ LINE OA เดียวกันแบบตรงตัวภายใน 5 นาที เพื่อยืนยันปลายทางส่วนตัว",
          });
        } catch {
          json(res, 503, { ok: false, error: "สร้างรหัสยืนยันไม่สำเร็จ — กรุณาลองใหม่" });
        }
        return true;
      }
      if (route[2] === "remove" && req.method === "POST" && route.length === 3) {
        const removed = db.removeBroadcastSelfTestDestination({ operatorUsername: username, sessionHash: currentSessionHash, channelId });
        db.addAudit({
          operator: username, action: "broadcast_self_test_destination_removed", target: channelId,
          detail: removed ? "ลบปลายทางทดสอบส่วนตัวแล้ว" : "ไม่มีปลายทางทดสอบให้ลบ",
        });
        json(res, 200, { ok: true, removed });
        return true;
      }
      if (route[2] === "send" && req.method === "POST" && route.length === 3) {
        if (body.confirm !== true) {
          json(res, 400, { ok: false, error: "ต้องยืนยันการส่งทดสอบจริง (confirm)" });
          return true;
        }
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 1000 || body.messages !== undefined || body.to !== undefined || body.recipient !== undefined) {
          json(res, 400, { ok: false, error: "ส่งทดสอบได้เฉพาะข้อความ text 1 บับเบิล และกำหนดผู้รับเองไม่ได้" });
          return true;
        }
        const destination = db.getBroadcastSelfTestDestination({ operatorUsername: username, sessionHash: currentSessionHash, channelId });
        if (!destination) {
          json(res, 409, { ok: false, error: "ยังไม่ได้ยืนยัน LINE ปลายทางสำหรับ OA นี้" });
          return true;
        }
        const ready = engine.sendReady(channelId);
        if (!ready.ok) {
          json(res, 502, { ok: false, error: ready.error });
          return true;
        }
        const guarded = engine.guardCheck([{ type: "text", text }]);
        if (!guarded.ok) {
          json(res, 400, { ok: false, error: guarded.error });
          return true;
        }
        const quota = quotaPayload(await engine.quotaFor(channelId, { fresh: true }), 1);
        const unavailableQuota = quotaError(quota);
        if (unavailableQuota) {
          json(res, 400, { ok: false, error: unavailableQuota });
          return true;
        }
        const result = await engine.sendSelfTest({ channelId, lineUserId: destination.line_user_id, text });
        // The provider boundary has already been crossed. An observability write
        // must never turn an accepted/unknown Push into HTTP 500 and invite an
        // operator retry that sends a duplicate real message.
        try {
          db.addAudit({
            operator: username, action: "broadcast_self_test_push", target: channelId,
            detail: `provider=${result.state}; text_chars=${text.length}`,
          });
        } catch (error) {
          logger.error?.(`broadcast: self-test audit failed after provider result=${result.state} (${error?.message || error})`);
        }
        json(res, result.state === "accepted" ? 200 : (result.state === "unknown" ? 202 : 502), {
          ok: result.state === "accepted", state: result.state,
          notice: result.state === "accepted"
            ? "LINE รับคำขอ Push แล้ว (ยังไม่ใช่หลักฐานว่าเปิดอ่าน)"
            : (result.error || "LINE ปฏิเสธหรือยังยืนยันผลไม่ได้"),
        });
        return true;
      }
    }

    /* ---- owner-only permission admin — ห้ามแตะ SQLite ตรงนอก single writer ---- */
    if (route[1] === "permissions" && route.length === 2) {
      if (operator?.role !== "owner") {
        json(res, 403, { ok: false, error: "เฉพาะ owner จัดการสิทธิ์ Broadcast ได้" });
        return true;
      }
      if (req.method === "GET") {
        json(res, 200, { ok: true, ...permissionPayload() });
        return true;
      }
      if (req.method === "POST") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const targetUsername = String(body.username || "").trim();
        const channelId = String(body.channelId || "").trim();
        const target = db.getOperator(targetUsername);
        if (!target || target.disabled) {
          json(res, 404, { ok: false, error: "ไม่พบบัญชี operator ที่เปิดใช้งาน" });
          return true;
        }
        if (!activeChannelIds().includes(channelId) || typeof body.allowed !== "boolean") {
          json(res, 400, { ok: false, error: "channelId/allowed ไม่ถูกต้อง" });
          return true;
        }
        if (target.role === "owner" || target.role === "admin") {
          json(res, 400, { ok: false, error: "owner/admin มีสิทธิ์ทุก OA อยู่แล้ว" });
          return true;
        }
        if (body.allowed) db.grantOperatorChannel(targetUsername, channelId);
        else db.revokeOperatorChannel(targetUsername, channelId);
        db.addAudit({
          operator: username,
          action: body.allowed ? "operator_channel_grant" : "operator_channel_revoke",
          target: targetUsername,
          detail: channelId,
        });
        json(res, 200, { ok: true, ...permissionPayload() });
        return true;
      }
    }

    /* ---- B-13: provider-unknown quarantine review (never calls provider) ---- */
    if (route[1] === "quarantines") {
      if (!hasOperatorCapability(operator, "broadcast.send")) {
        json(res, 403, { ok: false, error: "เฉพาะ Owner/Admin ที่มีสิทธิ์ส่งจึงตรวจและ resolve quarantine ได้" });
        return true;
      }
      if (req.method === "GET" && route.length === 2) {
        const requested = url.searchParams.get("channel") || null;
        if (requested && !channelIds.includes(requested)) {
          json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
          return true;
        }
        const channelId = requested || channelIds[0];
        json(res, 200, {
          ok: true,
          quarantines: db.listUnresolvedBroadcastDeliveryQuarantines({ channel: channelId, limit: 50 })
            .map(publicQuarantine),
          notice: "รายการนี้คือผลส่งที่ provider ยังยืนยันไม่ได้ ไม่ใช่หลักฐานว่าส่งถึงหรืออ่านแล้ว",
        });
        return true;
      }
      if (req.method === "POST" && route.length === 4 && route[3] === "resolve") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const existing = db.getBroadcastDeliveryQuarantine(route[2]);
        if (!existing) {
          json(res, 404, { ok: false, error: "ไม่พบ quarantine นี้" });
          return true;
        }
        if (!channelIds.includes(existing.channel_id)) {
          json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
          return true;
        }
        const body = await readJson(req);
        const resolution = String(body.resolution || "");
        if (!new Set(["confirmed_delivered", "confirmed_not_delivered"]).has(resolution)) {
          json(res, 400, { ok: false, error: "resolution ไม่ถูกต้อง" });
          return true;
        }
        const reason = String(body.reason || "").trim();
        if (reason.length < 5 || reason.length > 300) {
          json(res, 400, { ok: false, error: "ต้องระบุเหตุผล 5-300 ตัวอักษร" });
          return true;
        }
        const expectedConfirmation = quarantineResolutionConfirmationText(existing.id, resolution);
        if (String(body.confirmation || "") !== expectedConfirmation) {
          json(res, 400, { ok: false, error: `คำยืนยันไม่ตรง — ต้องพิมพ์ ${expectedConfirmation}` });
          return true;
        }
        // 28 ก.ย. 2026: ส่งฝั่ง LINE ไม่มีบัญชีผู้รับรายคน — ปิดงานตามคำตัดสินตรง ๆ (ไม่นับจากตาราง recipients)
        const resolveQuarantine = isLineSideFingerprint(existing.audience_fingerprint)
          ? db.resolveLineSideQuarantine.bind(db)
          : db.resolveBroadcastDeliveryQuarantine.bind(db);
        const result = resolveQuarantine({
          id: existing.id,
          channelId: existing.channel_id,
          resolvedBy: username,
          resolution,
          reason,
        });
        if (result.outcome === "missing") {
          json(res, 404, { ok: false, error: "ไม่พบ quarantine นี้" });
          return true;
        }
        if (result.outcome === "already_resolved") {
          json(res, 409, { ok: false, error: "quarantine นี้ถูก resolve ไปแล้ว — โหลดรายการใหม่ก่อนค่ะ" });
          return true;
        }
        if (result.outcome === "delivery_active") {
          json(res, 409, { ok: false, error: "งานส่งนี้ยังถือ live delivery lease อยู่ — รอให้จบหรือหมด lease ก่อนตรวจผล" });
          return true;
        }
        json(res, 200, {
          ok: true,
          outcome: "resolved",
          quarantine: publicQuarantine(result.row),
          notice: "บันทึกผลตรวจแล้ว ไม่มีการส่ง LINE และไม่มีการ retry อัตโนมัติ",
        });
        return true;
      }
    }

    /* ---- B-13: future schedule intent (provider send is impossible here) ---- */
    if (route[1] === "schedule") {
      if (!hasOperatorCapability(operator, "broadcast.send")) {
        json(res, 403, { ok: false, error: "เฉพาะ Owner/Admin ที่มีสิทธิ์ส่งจึงตั้งเวลาบรอดแคสได้" });
        return true;
      }

      if (req.method === "GET" && route.length === 2) {
        const requested = url.searchParams.get("channel") || null;
        if (requested && !channelIds.includes(requested)) {
          json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
          return true;
        }
        const channelId = requested || channelIds[0];
        json(res, 200, {
          ok: true,
          scheduling: schedulingStatus(),
          schedules: db.listBroadcastSchedules({ channel: channelId, limit: 50 }).map(publicSchedule),
        });
        return true;
      }

      if (req.method === "POST" && route.length === 3 && route[2] === "preview") {
        if (config.broadcastScheduleEnabled !== true || !scheduler) {
          json(res, 503, { ok: false, error: "ระบบตั้งเวลาบรอดแคสยังปิดอยู่" });
          return true;
        }
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        const prepared = await validateSchedulePayload(body, { channelIds });
        if (prepared.error) {
          json(res, prepared.status, { ok: false, error: prepared.error });
          return true;
        }
        const scheduleConfirmation = makeScheduleConfirmation({
          secret: config.consoleSessionSecret,
          sessionId,
          channelId: prepared.channelId,
          includeTags: prepared.includeTags,
          excludeTags: prepared.excludeTags,
          audience: prepared.audience,
          messages: prepared.built.stored,
          scheduledAt: prepared.scheduledAt,
          now,
        });
        json(res, 200, {
          ok: true,
          count: prepared.audience.length,
          quota: prepared.quota,
          scheduledAt: prepared.scheduledAt,
          timezone: "Asia/Bangkok",
          quietHours: "21:00-09:00",
          scheduleConfirmation,
          confirmationExpiresAt: now() + AUDIENCE_CONFIRM_TTL_MS,
        });
        return true;
      }

      if (req.method === "POST" && route.length === 2) {
        if (config.broadcastScheduleEnabled !== true || !scheduler) {
          json(res, 503, { ok: false, error: "ระบบตั้งเวลาบรอดแคสยังปิดอยู่" });
          return true;
        }
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await readJson(req);
        if (body.confirm !== true) {
          json(res, 400, { ok: false, error: "ต้องยืนยันก่อนตั้งเวลาบรอดแคส" });
          return true;
        }
        const prepared = await validateSchedulePayload(body, { channelIds });
        if (prepared.error) {
          json(res, prepared.status, { ok: false, error: prepared.error });
          return true;
        }
        if (!Number.isSafeInteger(body.confirmCount) || body.confirmCount !== prepared.audience.length) {
          json(res, 400, { ok: false, error: "จำนวนที่พิมพ์ยืนยันไม่ตรงกับจำนวนผู้รับล่าสุด" });
          return true;
        }
        if (!scheduleConfirmationMatches({
          token: body.scheduleConfirmation,
          secret: config.consoleSessionSecret,
          sessionId,
          channelId: prepared.channelId,
          includeTags: prepared.includeTags,
          excludeTags: prepared.excludeTags,
          audience: prepared.audience,
          messages: prepared.built.stored,
          scheduledAt: prepared.scheduledAt,
          now,
        })) {
          json(res, 400, { ok: false, error: "ใบยืนยันตั้งเวลาหมดอายุหรือไม่ตรงกับข้อความ/กลุ่ม/เวลาล่าสุด — กรุณา preview ใหม่" });
          return true;
        }
        const confirmationIssuedAt = Number(String(body.scheduleConfirmation).split(".")[0]);
        let row;
        try {
          row = db.createBroadcastSchedule({
            channelId: prepared.channelId,
            messages: prepared.built.stored,
            includeTags: prepared.includeTags,
            excludeTags: prepared.excludeTags,
            scheduledAt: prepared.scheduledAt,
            previewCount: prepared.audience.length,
            audienceFingerprint: prepared.fingerprint,
            confirmationHash: createHash("sha256").update(String(body.scheduleConfirmation)).digest("hex"),
            confirmationExpiresAt: confirmationIssuedAt + AUDIENCE_CONFIRM_TTL_MS,
            createdBy: username,
          });
        } catch (error) {
          if (error?.code === "BROADCAST_SCHEDULE_CONFIRMATION_REPLAY") {
            json(res, 409, { ok: false, error: "ใบยืนยันตั้งเวลานี้ถูกใช้ไปแล้ว — กรุณา preview ใหม่" });
            return true;
          }
          throw error;
        }
        db.addAudit({
          operator: username,
          action: "broadcast_schedule_created",
          target: prepared.channelId,
          detail: `schedule=${row.id}; at=${prepared.scheduledAt}; audience=${prepared.audience.length}; include=${prepared.includeTags.join("|")}`.slice(0, 200),
        });
        json(res, 201, { ok: true, schedule: publicSchedule(row) });
        return true;
      }

      if (req.method === "POST" && route.length === 4 && route[3] === "cancel") {
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const existing = db.getBroadcastSchedule(route[2]);
        if (!existing) {
          json(res, 404, { ok: false, error: "ไม่พบงานตั้งเวลานี้" });
          return true;
        }
        if (!channelIds.includes(existing.channel_id)) {
          json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
          return true;
        }
        const result = db.cancelBroadcastSchedule(existing.id, username);
        if (result.outcome === "cancelled") {
          db.addAudit({ operator: username, action: "broadcast_schedule_cancelled", target: existing.channel_id, detail: `schedule=${existing.id}; before_provider=true` });
          json(res, 200, { ok: true, outcome: "cancelled", schedule: publicSchedule(result.row) });
          return true;
        }
        if (result.outcome === "dispatched" && result.row?.broadcast_id) {
          const broadcast = db.getBroadcast(result.row.broadcast_id);
          if (!broadcast || broadcast.status !== "sending") {
            json(res, 409, { ok: false, error: "งานนี้เริ่มส่งและจบแล้ว จึงยกเลิกย้อนหลังไม่ได้", schedule: publicSchedule(result.row) });
            return true;
          }
          const updated = broadcast.cancel_requested_at ? broadcast : db.requestBroadcastCancel(broadcast.id, username);
          if (!updated) {
            json(res, 409, { ok: false, error: "สถานะการส่งเปลี่ยนระหว่างกด — โหลดใหม่ก่อนค่ะ" });
            return true;
          }
          db.addAudit({ operator: username, action: "broadcast_schedule_cancel_requested", target: existing.channel_id, detail: `schedule=${existing.id}; broadcast=${broadcast.id}; batch_boundary=true` });
          json(res, 200, { ok: true, outcome: "broadcast_cancel_requested", schedule: publicSchedule(db.getBroadcastSchedule(existing.id)), broadcast: updated });
          return true;
        }
        json(res, 409, { ok: false, error: "งานตั้งเวลานี้จบแล้วหรือถูกยกเลิกไปแล้ว", schedule: result.row ? publicSchedule(result.row) : null });
        return true;
      }
    }

    /* ---- GET /broadcast/meta — ป้ายของสาขาที่เลือก + สาขา + รูปแคตตาล็อก ---- */
    // REVIEW FIX: ?channel= ให้ตัวเลขบนชิปเป็นของสาขานั้นจริง (ตรงกับ audience ring)
    if (req.method === "GET" && route[1] === "meta" && route.length === 2) {
      const channel = url.searchParams.get("channel") || null;
      if (channel && !channelIds.includes(channel)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      const selectedChannel = channel || channelIds[0];
      json(res, 200, {
        ok: true,
        channels: channelIds.map((id) => ({ id, name: channelLabel(id) })),
        tags: db.tagSummary({ channel: selectedChannel, limit: 500 }),
        images: catalogEntries().map((entry) => ({
          key: entry.key,
          url: entry.url,
          previewSrc: entry.consoleUrl || entry.url,
          label: entry.label || entry.key,
          uploaded: entry.uploaded === true,
        })),
        mediaUpload: mediaStatus(),
        maxBubbles: BROADCAST_MAX_BUBBLES,
        canSend: hasOperatorCapability(operator, "broadcast.send"),
        scheduling: schedulingStatus(),
      });
      return true;
    }

    /* ---- POST /broadcast/media — binary JPEG/PNG, auth+CSRF, default OFF ---- */
    if (req.method === "POST" && route[1] === "media" && route.length === 2) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      // audit 2026-08-25: เส้นนี้เคยมีแค่ CSRF — staff (broadcast.use แต่ไม่มี broadcast.send)
      // อัปโหลดรูปเข้าคลัง broadcast สาธารณะได้ ทั้งที่ส่งไม่ได้ ปิดให้ตรงกับเส้นส่งทดสอบ (:350)
      if (!hasOperatorCapability(operator, "broadcast.send")) {
        json(res, 403, { ok: false, error: "เฉพาะ Owner/Admin ที่มีสิทธิ์ส่งจึงอัปโหลดรูป broadcast ได้" });
        return true;
      }
      const status = mediaStatus();
      if (!status.enabled || !broadcastMedia || typeof ctx.readBody !== "function") {
        json(res, 503, { ok: false, error: status.reason || "media upload ปิดอยู่" });
        return true;
      }
      const lease = uploadAttempts.begin(username);
      if (!lease.ok) {
        json(res, 429, { ok: false, error: "อัปโหลดถี่หรือมีงานอัปโหลดค้างอยู่ — กรุณารอสักครู่", retryAfterMs: lease.retryAfterMs });
        return true;
      }
      try {
        const declaredSize = Number(req.headers["x-media-size"]);
        if (!Number.isInteger(declaredSize) || declaredSize < 1 || declaredSize > status.maxBytes) {
          json(res, declaredSize > status.maxBytes ? 413 : 400, {
            ok: false,
            error: `ขนาดรูปต้องเป็น 1-${status.maxBytes.toLocaleString("en-US")} bytes`,
          });
          return true;
        }
        if (req.headers["content-length"] === undefined) {
          json(res, 411, { ok: false, error: "อัปโหลดรูปต้องส่ง Content-Length" });
          return true;
        }
        const contentLength = Number(req.headers["content-length"]);
        if (!Number.isInteger(contentLength) || contentLength !== declaredSize) {
          json(res, 400, { ok: false, error: "ขนาดไฟล์ที่ส่งมาไม่ตรงกับ header" });
          return true;
        }
        let buffer;
        try {
          buffer = await ctx.readBody(req, status.maxBytes, {
            timeoutMs: UPLOAD_BODY_TIMEOUT_MS,
            destroyOnOverflow: true,
          });
        } catch {
          if (req.destroyed || res.destroyed) return true;
          json(res, 400, { ok: false, error: "รับไฟล์ไม่ครบ ถูกยกเลิก หรือใหญ่เกินเพดาน" });
          return true;
        }
        if (buffer.length !== declaredSize) {
          json(res, 400, { ok: false, error: "ขนาดไฟล์จริงไม่ตรงกับที่แจ้ง" });
          return true;
        }
        const saved = broadcastMedia.save({
          buffer,
          contentType: req.headers["content-type"],
          label: url.searchParams.get("label") || "",
          createdBy: username,
        });
        db.addAudit({
          operator: username,
          action: "broadcast_media_upload",
          target: saved.media.key,
          detail: `${saved.media.label} · ${saved.media.bytes} bytes · ${saved.media.width}x${saved.media.height}`,
        });
        json(res, saved.deduplicated ? 200 : 201, { ok: true, ...saved });
      } catch (err) {
        json(res, Number(err?.status) || 500, { ok: false, error: err?.message || "อัปโหลดรูปไม่สำเร็จ" });
      } finally {
        lease.release();
      }
      return true;
    }

    /* ---- POST /broadcast/preview — นับ audience สด (ไม่ส่งอะไร ไม่มี side effect) ---- */
    if (req.method === "POST" && route[1] === "preview" && route.length === 2) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const body = await readJson(req);
      const channelId = String(body.channelId || "default");
      if (!channelIds.includes(channelId)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      const includeTags = cleanTags(body.includeTags);
      const excludeTags = cleanTags(body.excludeTags);
      if (includeTags === null || excludeTags === null) {
        json(res, 400, { ok: false, error: `tag filter ต้องเป็นลิสต์ไม่เกิน ${TAG_FILTER_MAX} ป้าย` });
        return true;
      }
      if (!includeTags.length) {
        json(res, 400, { ok: false, error: "ต้องเลือกป้ายลูกค้าอย่างน้อย 1 ป้ายก่อนบรอดแคส" });
        return true;
      }
      const audience = db.broadcastAudience({ channelId, includeTags, excludeTags });
      // LINE quota is per recipient per multicast request. All bubbles in this
      // console action ride in the same request (max 5), so do not multiply by
      // bubble count and overstate quota consumption.
      const estimatedUse = audience.length;
      const quota = quotaPayload(await engine.quotaFor(channelId), estimatedUse);
      const total = db.broadcastAudienceCount({ channelId }); // COUNT จริง ไม่ติดเพดาน query audience
      json(res, 200, {
        ok: true,
        count: audience.length,
        total,
        // DB defensive limit is 10,000; sending safety cap is lower and has no bypass.
        capped: audience.length >= 10_000,
        overAudienceCap: audience.length > BROADCAST_AUDIENCE_CAP,
        audienceCap: BROADCAST_AUDIENCE_CAP,
        sample: audience.slice(0, 8).map((c, index) => c.known_name || c.display_name || `ลูกค้าในกลุ่ม ${index + 1}`),
        quota,
        audienceConfirmation: makeAudienceConfirmation({
          secret: config.consoleSessionSecret, sessionId, channelId, includeTags, excludeTags, audience, now,
        }),
      });
      return true;
    }

    /* ---- POST /broadcast/send — ส่งจริง (confirm จาก UI + guard ทุกข้อความ) ---- */
    if (req.method === "POST" && route[1] === "send" && route.length === 2) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      if (!hasOperatorCapability(operator, "broadcast.send")) {
        json(res, 403, { ok: false, error: "บัญชี Staff ดูกลุ่มและร่างข้อความได้ แต่ส่งบรอดแคสจริงไม่ได้" });
        return true;
      }
      const body = await readJson(req);
      if (body.confirm !== true) {
        json(res, 400, { ok: false, error: "ต้องยืนยันก่อนส่ง (confirm)" });
        return true;
      }
      const channelId = String(body.channelId || "default");
      if (!channelIds.includes(channelId)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      const includeTags = cleanTags(body.includeTags);
      const excludeTags = cleanTags(body.excludeTags);
      if (includeTags === null || excludeTags === null) {
        json(res, 400, { ok: false, error: `tag filter ต้องเป็นลิสต์ไม่เกิน ${TAG_FILTER_MAX} ป้าย` });
        return true;
      }
      if (!includeTags.length) {
        json(res, 400, { ok: false, error: "ต้องเลือกป้ายลูกค้าอย่างน้อย 1 ป้ายก่อนบรอดแคส" });
        return true;
      }
      const dueSchedule = db.dueBroadcastScheduleForChannel(channelId, now());
      if (dueSchedule) {
        json(res, 409, { ok: false, error: "OA นี้มีบรอดแคสตั้งเวลาที่ถึงกำหนดแล้ว — รอให้ scheduler จัดการหรือยกเลิกงานนั้นก่อน" });
        return true;
      }
      // REVIEW FIX (fail-closed): ช่องส่งไม่พร้อม = ปฏิเสธตั้งแต่ตอนกด (แบบเดียวกับ reply route)
      const ready = engine.sendReady(channelId);
      if (!ready.ok) {
        json(res, 502, { ok: false, error: ready.error });
        return true;
      }
      const imageCatalogByKey = new Map(catalogEntries().map((entry) => [entry.key, entry]));
      const built = buildBroadcastMessages(body.messages, { imageCatalogByKey });
      if (built.error) {
        json(res, 400, { ok: false, error: built.error });
        return true;
      }
      const guarded = engine.guardCheck(built.messages);
      if (!guarded.ok) {
        json(res, 400, { ok: false, error: guarded.error });
        return true;
      }
      const audience = db.broadcastAudience({ channelId, includeTags, excludeTags });
      if (!audience.length) {
        json(res, 400, { ok: false, error: "audience ว่าง — ไม่มีลูกค้าตรงเงื่อนไข (หรือทุกคนขอหยุดการทักไป)" });
        return true;
      }
      if (audience.length > BROADCAST_AUDIENCE_CAP) {
        json(res, 400, { ok: false, error: `กลุ่มมี ${audience.length} คน เกินเพดาน ${BROADCAST_AUDIENCE_CAP} คนต่อครั้ง` });
        return true;
      }
      if (!Number.isSafeInteger(body.confirmCount) || body.confirmCount !== audience.length) {
        json(res, 400, { ok: false, error: "จำนวนที่พิมพ์ยืนยันไม่ตรงกับจำนวนผู้รับที่ระบบคำนวณ" });
        return true;
      }
      if (!confirmationMatches({
        token: body.audienceConfirmation, secret: config.consoleSessionSecret, sessionId, channelId,
        includeTags, excludeTags, audience, now,
      })) {
        json(res, 400, { ok: false, error: "ใบยืนยันกลุ่มผู้รับหมดอายุหรือไม่ตรงกับข้อมูลล่าสุด — กรุณา preview ใหม่" });
        return true;
      }
      const quota = quotaPayload(await engine.quotaFor(channelId, { fresh: true }), audience.length);
      const unavailableQuota = quotaError(quota);
      if (unavailableQuota) {
        json(res, 400, { ok: false, error: unavailableQuota });
        return true;
      }
      let claim;
      try {
        claim = db.claimBroadcast({
          channelId, messages: built.stored, includeTags, excludeTags, audience,
          createdBy: username, cooldownMs: SEND_COOLDOWN_MS,
          ownerToken: engine.broadcastOwnerToken, leaseDurationMs: BROADCAST_CLAIM_LEASE_MS,
          manual: true,
        });
      } catch (error) {
        logger.warn?.(`broadcast: claim ไม่สำเร็จ (${error?.message || error})`);
        json(res, 503, { ok: false, error: "จองคิวบรอดแคสไม่สำเร็จ — กรุณาลองใหม่อีกครั้ง" });
        return true;
      }
      if (!claim.ok) {
        if (claim.reason === "schedule_due") {
          json(res, 409, { ok: false, error: "มีบรอดแคสตั้งเวลาถึงกำหนดของ OA นี้ — ระบบไม่ให้การส่งมือแซงคิว" });
        } else if (claim.reason === "delivery_quarantined") {
          json(res, 409, { ok: false, error: "ผลส่งครั้งก่อนของกลุ่มนี้ยังยืนยันไม่ได้ — ห้ามส่งซ้ำจนผู้ดูแลตรวจและ resolve quarantine" });
        } else if (claim.reason === "active") {
          json(res, 409, { ok: false, error: claim.active
            ? `บรอดแคส #${claim.active.broadcast_no} ของสาขานี้กำลังส่งอยู่ — รอให้จบก่อน`
            : "สาขานี้มีบรอดแคสกำลังส่งอยู่ — รอให้จบก่อน" });
        } else {
          json(res, 429, { ok: false, error: `เพิ่งส่งบรอดแคสไป ${Math.round(claim.sinceLast / 1000)} วิ — เว้นอย่างน้อย 60 วิ กันส่งซ้ำโดยไม่ตั้งใจ` });
        }
        return true;
      }
      const row = claim.row;
      db.addAudit({
        operator: username, action: "broadcast_send", target: channelId,
        detail: `#${row.broadcast_no} -> ${audience.length} คน; include=${includeTags.join("|")}; exclude=${excludeTags.join("|")}`.slice(0, 200),
      });
      // ส่งจริงเบื้องหลัง — ตอบ UI ทันที ให้ตาม progress จาก history
      setTimeout(() => {
        engine.runSend({
          broadcastId: row.id, channelId, audience,
          messages: built.messages, storedMessages: built.stored, operator: username,
          includeTags, excludeTags, claimOwnerToken: engine.broadcastOwnerToken,
        }).catch((err) => logger.error?.(`broadcast: runSend ล้มเหลว (${err?.message || err})`));
      }, 0);
      json(res, 200, { ok: true, broadcast: row, audienceCount: audience.length });
      return true;
    }

    /* ---- POST /broadcast/cancel/:id — ขอหยุดที่ขอบ batch ถัดไป ---- */
    if (req.method === "POST" && route[1] === "cancel" && route.length === 3) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      if (!hasOperatorCapability(operator, "broadcast.send")) {
        json(res, 403, { ok: false, error: "เฉพาะ Owner/Admin ที่มีสิทธิ์ส่งจึงยกเลิกบรอดแคสได้" });
        return true;
      }
      const row = db.getBroadcast(route[2]);
      if (!row) {
        json(res, 404, { ok: false, error: "ไม่พบบรอดแคสนี้" });
        return true;
      }
      if (!channelIds.includes(row.channel_id)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      if (row.status !== "sending") {
        json(res, 409, { ok: false, error: "บรอดแคสนี้จบแล้ว จึงยกเลิกย้อนหลังไม่ได้" });
        return true;
      }
      const updated = row.cancel_requested_at ? row : db.requestBroadcastCancel(row.id, username);
      if (!updated) {
        json(res, 409, { ok: false, error: "สถานะเปลี่ยนระหว่างกด — โหลดประวัติใหม่ก่อนค่ะ" });
        return true;
      }
      db.addAudit({
        operator: username, action: "broadcast_cancel_requested", target: row.channel_id,
        detail: `#${row.broadcast_no}; หยุดที่ขอบ batch ถัดไป`,
      });
      json(res, 200, { ok: true, broadcast: updated });
      return true;
    }

    /* ---- GET /broadcast/history — บรอดแคสล่าสุด + สถานะ ---- */
    if (req.method === "GET" && route[1] === "history" && route.length === 2) {
      const channel = url.searchParams.get("channel") || null;
      if (channel && !channelIds.includes(channel)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      const selectedChannel = channel || channelIds[0];
      json(res, 200, {
        ok: true,
        broadcasts: db.listBroadcasts({ channel: selectedChannel, limit: 20 }).map((b) => ({
          ...b,
          channelName: channelLabel(b.channel_id),
          recipientSummary: db.broadcastRecipientSummary(b.id),
        })),
      });
      return true;
    }

    return false;
  }

  return { handle };
}
