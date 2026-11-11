// B-13 — durable broadcast scheduling, fail-closed and disabled by default.
// A schedule is only an approved future intent. The provider boundary begins
// after claimBroadcast atomically creates the ordinary broadcast + recipient
// ledger + OA lease and links this schedule to it. A dispatched schedule is
// never replayed automatically, even if its provider outcome is ambiguous.
import { createHash, randomUUID } from "node:crypto";
import {
  buildBroadcastMessages,
  BROADCAST_CLAIM_LEASE_MS,
} from "./broadcast.mjs";

export const BANGKOK_OFFSET_MS = 7 * 60 * 60_000;
export const BROADCAST_SCHEDULE_PREPARING_LEASE_MS = 60_000;
export const BROADCAST_SCHEDULE_AUDIENCE_CAP = 2_000;
const SEND_COOLDOWN_MS = 60_000;

function shiftedUtcParts(ms) {
  const date = new Date(Number(ms) + BANGKOK_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  };
}

export function isBangkokQuietHours(ms) {
  const { hour } = shiftedUtcParts(ms);
  return hour >= 21 || hour < 9;
}

export function nextBangkokNineMs(ms) {
  const at = Number(ms);
  const parts = shiftedUtcParts(at);
  const dayOffset = parts.hour >= 21 ? 1 : 0;
  return Date.UTC(parts.year, parts.month, parts.day + dayOffset, 9 - 7, 0, 0, 0);
}

export function validFutureBangkokSchedule(scheduledAt, nowMs) {
  const target = Number(scheduledAt);
  const current = Number(nowMs);
  if (!Number.isSafeInteger(target) || !Number.isSafeInteger(current) || target <= current) {
    return { ok: false, error: "เวลาส่งต้องเป็นเวลาในอนาคต" };
  }
  if (isBangkokQuietHours(target)) {
    return { ok: false, error: "ตั้งเวลาส่งไม่ได้ใน quiet hours 21:00–09:00 (Asia/Bangkok)" };
  }
  return { ok: true };
}

export function broadcastAudienceFingerprint(audience) {
  return createHash("sha256")
    .update((audience || []).map((row) => String(row?.line_user_id || "")).filter(Boolean).sort().join("\n"))
    .digest("base64url");
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function quotaError(quota, estimatedUse) {
  if (quota?.type === "none") {
    return Number.isSafeInteger(quota.totalUsage) && quota.totalUsage >= 0
      ? ""
      : "อ่านโควตา LINE ไม่ได้หรือข้อมูลไม่สมบูรณ์";
  }
  if (quota?.type === "limited") {
    const limit = Number(quota.value);
    const used = Number(quota.totalUsage);
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(used) || used < 0) {
      return "อ่านโควตา LINE ไม่ได้หรือข้อมูลไม่สมบูรณ์";
    }
    if (limit - used < estimatedUse) return `โควตา LINE คงเหลือ ${limit - used} ไม่พอสำหรับผู้รับ ${estimatedUse} คน`;
    return "";
  }
  return "อ่านโควตา LINE ไม่ได้หรือข้อมูลไม่สมบูรณ์";
}

export function createBroadcastScheduler({
  db,
  config,
  engine,
  getImageCatalogByKey = () => new Map(),
  logger = console,
  now = Date.now,
  ownerToken = randomUUID(),
  // 28 ก.ย. 2026: งานที่สร้างจากสตูดิโอ (มีแถว broadcast_schedule_targets) ให้สตูดิโอส่งแทน — ไม่มี = ไม่ส่ง (fail-closed)
  studio = null,
} = {}) {
  let timer = null;
  let running = false;
  let lastRunAt = null;
  let lastOutcome = "never";

  const enabled = () => config?.broadcastScheduleEnabled === true && Boolean(engine);

  function audit(action, target, detail) {
    try { db.addAudit({ operator: "system", action, target, detail: String(detail || "").slice(0, 200) }); }
    catch (error) { logger.warn?.(`broadcast schedule audit failed (${error?.message || error})`); }
  }

  function fail(row, phase, error) {
    const message = String(error?.message || error || "schedule pre-provider failure").slice(0, 300);
    const failed = db.failPreparingBroadcastSchedule(row.id, ownerToken, { phase, error: message, at: now() });
    if (failed) audit("broadcast_schedule_failed", row.channel_id, `schedule=${row.id}; phase=${phase}; ${message}`);
    return { state: failed ? "failed" : "state_changed", schedule: failed || db.getBroadcastSchedule(row.id), error: message };
  }

  async function processClaimed(row, at) {
    if (isBangkokQuietHours(at)) {
      const deferred = db.deferPreparingBroadcastSchedule(row.id, ownerToken, {
        scheduledAt: nextBangkokNineMs(at), reason: "quiet_hours", at,
      });
      if (deferred) audit("broadcast_schedule_quiet_deferred", row.channel_id, `schedule=${row.id}; next=${deferred.scheduled_at}`);
      return { state: deferred ? "deferred_quiet" : "state_changed", schedule: deferred || db.getBroadcastSchedule(row.id) };
    }

    // 28 ก.ย. 2026: งานของสตูดิโอ (ป้ายพร้อมลิงก์นับคลิก / เพื่อนทุกคน / กลุ่มเป้าหมาย LINE / ข้อมูลประชากร)
    const studioTarget = db.broadcastScheduleTarget?.(row.id) ?? null;
    if (studioTarget) {
      if (typeof studio?.dispatchScheduled !== "function") {
        return fail(row, "studio_unavailable", "สตูดิโอบรอดแคสต์ไม่พร้อมในโปรเซสนี้ — ไม่ส่ง");
      }
      const outcome = await studio.dispatchScheduled({
        row, target: studioTarget, scheduleOwnerToken: ownerToken, getImageCatalogByKey,
      });
      if (outcome?.error) return fail(row, outcome.phase || "studio_dispatch", outcome.error);
      if (outcome?.state !== "dispatched") {
        return { state: outcome?.state || "state_changed", schedule: db.getBroadcastSchedule(row.id) };
      }
      audit("broadcast_schedule_dispatched", row.channel_id,
        `schedule=${row.id}; broadcast=${outcome.broadcast?.id}; mode=${studioTarget.mode}`);
      return { state: "dispatched", schedule: db.getBroadcastSchedule(row.id), broadcast: outcome.broadcast };
    }

    const storedMessages = parseJsonArray(row.messages_json);
    const includeTags = parseJsonArray(row.include_tags_json);
    const excludeTags = parseJsonArray(row.exclude_tags_json);
    if (!storedMessages || !includeTags || !excludeTags || !includeTags.length) {
      return fail(row, "stored_payload", "ข้อมูลข้อความหรือกลุ่มผู้รับที่บันทึกไว้ไม่ถูกต้อง");
    }
    const built = buildBroadcastMessages(storedMessages, { imageCatalogByKey: getImageCatalogByKey() });
    if (built.error) return fail(row, "message_rebuild", built.error);
    const guarded = engine.guardCheck(built.messages);
    if (!guarded.ok) return fail(row, "message_guard", guarded.error);

    const audience = db.broadcastAudience({ channelId: row.channel_id, includeTags, excludeTags });
    if (!audience.length) return fail(row, "audience_drift", "กลุ่มผู้รับว่างในเวลาส่งจริง");
    if (audience.length > BROADCAST_SCHEDULE_AUDIENCE_CAP) {
      return fail(row, "audience_cap", `กลุ่มผู้รับ ${audience.length} คน เกินเพดาน ${BROADCAST_SCHEDULE_AUDIENCE_CAP}`);
    }
    const fingerprint = broadcastAudienceFingerprint(audience);
    if (audience.length !== Number(row.preview_count) || fingerprint !== row.audience_fingerprint) {
      return fail(row, "audience_drift", "สมาชิกกลุ่มเปลี่ยนจากตอนยืนยัน — กรุณาตั้งเวลาใหม่");
    }

    const ready = engine.sendReady(row.channel_id);
    if (!ready.ok) return fail(row, "send_ready", ready.error);
    const quota = await engine.quotaFor(row.channel_id, { fresh: true });
    // The quota read crosses an async boundary. An owner may cancel while that
    // request is in flight, so re-read durable state before interpreting quota
    // or attempting the atomic broadcast claim. claimBroadcast repeats this
    // check in its BEGIN IMMEDIATE transaction; this early check gives the UI a
    // truthful cancelled outcome and avoids creating any broadcast row.
    const afterQuota = db.getBroadcastSchedule(row.id);
    if (!afterQuota || afterQuota.status !== "preparing" || afterQuota.preparing_owner_token !== ownerToken) {
      return {
        state: afterQuota?.status === "cancelled" ? "cancelled" : "state_changed",
        schedule: afterQuota,
      };
    }
    const quotaProblem = quotaError(quota, audience.length);
    if (quotaProblem) return fail(row, "quota", quotaProblem);

    let claim;
    try {
      claim = db.claimBroadcast({
        channelId: row.channel_id,
        messages: built.stored,
        includeTags,
        excludeTags,
        audience,
        createdBy: row.created_by,
        cooldownMs: SEND_COOLDOWN_MS,
        ownerToken: engine.broadcastOwnerToken,
        leaseDurationMs: BROADCAST_CLAIM_LEASE_MS,
        scheduleId: row.id,
        scheduleOwnerToken: ownerToken,
      });
    } catch (error) {
      return fail(row, "broadcast_claim", error);
    }
    if (!claim.ok) {
      const reason = claim.reason === "active"
        ? "มีบรอดแคสของ OA นี้กำลังส่งอยู่"
        : claim.reason === "cooldown"
          ? "OA นี้ยังอยู่ใน cooldown หลังบรอดแคสก่อนหน้า"
          : claim.reason === "delivery_quarantined"
            ? "ผลส่งครั้งก่อนของกลุ่มนี้ยังยืนยันไม่ได้ — ต้องให้ผู้ดูแล resolve quarantine ก่อน"
          : "สถานะงานตั้งเวลาเปลี่ยนก่อนเริ่มส่ง";
      return fail(row, "broadcast_claim", reason);
    }

    const broadcast = claim.row;
    audit("broadcast_schedule_dispatched", row.channel_id, `schedule=${row.id}; broadcast=${broadcast.id}; audience=${audience.length}`);
    // Never await or retry here. From this point the ordinary broadcast ledger
    // owns truth. runSend handles accepted/unknown/cancel at provider boundaries;
    // a crash between dispatch and its first call remains dispatched, not replayed.
    queueMicrotask(() => {
      engine.runSend({
        broadcastId: broadcast.id,
        channelId: row.channel_id,
        audience,
        messages: built.messages,
        storedMessages: built.stored,
        operator: row.created_by,
        includeTags,
        excludeTags,
        claimOwnerToken: engine.broadcastOwnerToken,
      }).catch((error) => logger.error?.(`broadcast schedule runSend failed (${error?.message || error})`));
    });
    return { state: "dispatched", schedule: db.getBroadcastSchedule(row.id), broadcast };
  }

  async function runOnce() {
    if (!enabled()) return { state: "disabled" };
    if (running) return { state: "busy" };
    running = true;
    const at = now();
    lastRunAt = at;
    let claimedRow = null;
    try {
      const recovered = db.recoverStalePreparingBroadcastSchedules(at);
      if (recovered) audit("broadcast_schedule_stale_failed", "broadcast", `count=${recovered}`);
      const row = db.claimDueBroadcastSchedule({
        ownerToken,
        leaseDurationMs: BROADCAST_SCHEDULE_PREPARING_LEASE_MS,
        at,
      });
      if (!row) {
        lastOutcome = recovered ? "stale_failed" : "idle";
        return { state: lastOutcome, recovered };
      }
      claimedRow = row;
      const result = await processClaimed(row, at);
      lastOutcome = result.state;
      return result;
    } catch (error) {
      logger.error?.(`broadcast schedule tick failed (${error?.message || error})`);
      if (claimedRow) {
        try {
          const result = fail(claimedRow, "pre_provider_exception", error);
          lastOutcome = result.state;
          return result;
        } catch (failError) {
          logger.error?.(`broadcast schedule fail-close persistence failed (${failError?.message || failError})`);
        }
      }
      lastOutcome = "error";
      return { state: "error", error: String(error?.message || error) };
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled() || timer) return false;
    // Recover first; only expired preparing leases are terminalized, so a second
    // healthy chassis process cannot kill a live preparation owned elsewhere.
    try { db.recoverStalePreparingBroadcastSchedules(now()); }
    catch (error) { logger.error?.(`broadcast schedule startup recovery failed (${error?.message || error})`); }
    queueMicrotask(runOnce);
    timer = setInterval(runOnce, Math.max(15_000, Number(config.broadcastScheduleTickMs) || 30_000));
    timer.unref?.();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  function healthSnapshot() {
    return {
      enabled: enabled(),
      armed: Boolean(timer),
      running,
      tickMs: Math.max(15_000, Number(config?.broadcastScheduleTickMs) || 30_000),
      timezone: "Asia/Bangkok",
      quietHours: "21:00-09:00",
      lastRunAt,
      lastOutcome,
    };
  }

  return { start, stop, runOnce, healthSnapshot, ownerToken };
}
