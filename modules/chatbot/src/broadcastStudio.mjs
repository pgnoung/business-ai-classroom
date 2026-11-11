// broadcastStudio.mjs — เครื่องยนต์ของสตูดิโอบรอดแคสต์ (28 ก.ย. 2026)
//
// พี่ง้วงขอ (28 ก.ย. 2026): "สำหรับ บรอดแคส ให้ทำ ระบบที่สร้างได้เหมือน LINE OA MANAGER เลย"
// โหมดผู้รับ 4 แบบ (ทุกแบบยังเป็นแถว broadcasts + OA claim/lease + quarantine ชุดเดิม):
//   tags        — ป้ายของเรา (multicast ถึงคนที่ระบบรู้จัก) → ใช้ engine.runSend เดิมทั้งเส้น
//   all         — เพื่อนทุกคนของ OA (POST /v2/bot/message/broadcast)
//   audience    — กลุ่มเป้าหมายของ LINE รวมกลุ่มที่สร้างใน OA Manager เช่นแท็กแชท/ช่องทางเพิ่มเพื่อน (narrowcast)
//   demographic — เพศ/อายุ/พื้นที่/ระบบ/อายุการเป็นเพื่อน (narrowcast)
// ข้อเท็จจริงที่ตรวจกับเอกสาร LINE แล้ว (developers.line.biz/en/reference/messaging-api/ · 28 ก.ย. 2026):
//   - broadcast ตอบ 200 · narrowcast ตอบ 202 แล้วส่งเบื้องหลัง · ทั้งคู่มี X-Line-Request-Id + รองรับ retry key
//   - narrowcast จองโควตาเท่า target reach — ส่งพร้อม limit.upToRemainingQuota + forbidPartialDelivery
//     = LINE ไม่ส่งแบบแหว่ง (ส่งทุกคนหรือไม่ส่งเลย) ถ้าโควตาเหลือไม่พอ
//   - กลุ่มเป้าหมายที่ผลลัพธ์ต่ำกว่า 50 คนจะไม่ถูกส่ง (ยกเว้นกลุ่มอัปโหลดรายชื่อและกลุ่มแท็กแชท)
//   - ใช้ข้อมูลประชากร: เพื่อนที่ LINE ระบุได้ (target reach) ต้อง ≥ 100 · ไทยตัดผู้ใช้อายุต่ำกว่า 20 ออกเสมอ
//   - followers (สถิติ) นับทุกคนที่เคยเพิ่ม ไม่ลดเมื่อบล็อก → ประมาณผู้รับบรอดแคสต์ = followers − blocks
import { createHmac, randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { SEND_PURPOSE, bangkokDay } from "./lineSendLedger.mjs";
import { jstDateKey } from "./lineInsight.mjs";
import { LINE_SIDE_MODES, STUDIO_MODES } from "./dbBroadcastStudio.mjs";
import { buildBroadcastMessages } from "./broadcastMessages.mjs";
import { BROADCAST_CLAIM_LEASE_MS } from "./broadcast.mjs";
import { BROADCAST_SCHEDULE_AUDIENCE_CAP, broadcastAudienceFingerprint } from "./broadcastSchedule.mjs";

const DAY_MS = 86_400_000;
export const STUDIO_CONFIRM_TTL_MS = 45_000; // สั้นกว่า cooldown 60 วิ — ใบยืนยันเก่า replay หลัง cooldown ไม่ได้
export const LINK_TOKEN_LENGTH = 12;
const LINK_TOKEN_RE = /^[A-Za-z]{12}$/u;
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"; // ไม่มีตัวเลข = ตัวกันราคาไม่สะดุด
const AUDIENCE_CACHE_MS = 10 * 60_000;
const FOLLOWERS_CACHE_MS = 6 * 3_600_000;
const PROGRESS_REFRESH_MS = 60_000;
const INSIGHT_REFRESH_MS = 30 * 60_000;
const INSIGHT_WINDOW_MS = 14 * DAY_MS; // LINE หยุดอัปเดตสถิติหลัง 14 วัน
const INSIGHT_CALLS_PER_HOUR = 40; // เพดาน LINE 60/ชม. ต่อ OA — เผื่อให้ส่วนอื่น
export const NARROWCAST_MIN_RECIPIENTS = 50;
// "เพื่อนทุกคน" ประมาณจากสถิติเพื่อนรายวันของ LINE (ข้อมูลเมื่อวาน) — /broadcast ไม่มีตัวเลือกห้ามส่งไม่ครบ
// จึงกันโควตาเผื่อเพื่อนใหม่ที่เพิ่มหลังสถิติ 2% (อย่างน้อย 20) ก่อนรับงาน
export const ALL_FRIENDS_QUOTA_HEADROOM = 0.02;
export function quotaUseFor(mode, estimate) {
  if (!Number.isSafeInteger(estimate) || estimate <= 0) return 0;
  return mode === "all" ? estimate + Math.max(20, Math.ceil(estimate * ALL_FRIENDS_QUOTA_HEADROOM)) : estimate;
}
export const DEMOGRAPHIC_MIN_TARGET_REACH = 100;
const AUDIENCE_TARGET_MAX = 10; // LINE รับกลุ่ม + requestId รวมกันไม่เกิน 10 ต่อคำขอ

export const DEMOGRAPHIC_OPTIONS = Object.freeze({
  gender: Object.freeze(["male", "female"]),
  age: Object.freeze(["age_15", "age_20", "age_25", "age_30", "age_35", "age_40", "age_45", "age_50",
    "age_55", "age_60", "age_65", "age_70"]),
  appType: Object.freeze(["ios", "android"]),
  area: Object.freeze(["th_01", "th_02", "th_03", "th_04", "th_05", "th_06", "th_07", "th_08"]),
  subscriptionPeriod: Object.freeze(["day_7", "day_30", "day_90", "day_180", "day_365"]),
});
// ชื่อพื้นที่ไทยตามเอกสาร LINE (#narrowcast-demographic-filter-region)
export const THAI_AREA_LABELS = Object.freeze({
  th_01: "กรุงเทพฯ", th_02: "พัทยา", th_03: "ภาคเหนือ", th_04: "ภาคกลาง",
  th_05: "ภาคใต้", th_06: "ภาคตะวันออก", th_07: "ภาคตะวันออกเฉียงเหนือ", th_08: "ภาคตะวันตก",
});

function randomLetters(length) {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // rejection sampling กันเอนเอียง: 52 × 4 = 208
      if (byte < 208) out += TOKEN_ALPHABET[byte % 52];
      if (out.length === length) break;
    }
  }
  return out;
}

export function isLinkToken(value) {
  return LINK_TOKEN_RE.test(String(value || ""));
}

/** ฐาน URL สาธารณะของลิงก์นับคลิก (https origin เท่านั้น) — ไม่มี = ส่งลิงก์ตามจริงโดยไม่นับคลิก */
export function trackingBaseUrl(config = {}) {
  for (const raw of [config.clickTrackBaseUrl, config.mediaPublicBaseUrl]) {
    try {
      const url = new URL(String(raw || ""));
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
          && (!url.pathname || url.pathname === "/")) return url.origin;
    } catch { /* ลองค่าถัดไป */ }
  }
  return "";
}

/** ตัวเก็บลิงก์ระหว่างประกอบข้อความ: ทุกลิงก์ได้ token ใหม่ (ลิงก์ซ้ำในข้อความเดียวนับแยกตามตำแหน่ง) */
export function createLinkCollector(baseUrl) {
  const links = [];
  const tracker = baseUrl
    ? ({ url, label = "" }) => {
        const token = randomLetters(LINK_TOKEN_LENGTH);
        links.push({ token, linkNo: links.length, url, label: String(label || "").slice(0, 40) });
        return `${baseUrl}/r/${token}`;
      }
    : null;
  return { tracker, links };
}

export function aggregationUnitFor(kind, id, stepNo = null) {
  const compact = String(id || "").replace(/[^A-Za-z0-9]/gu, "");
  return kind === "step"
    ? `lkp_s_${compact.slice(0, 16)}_${Number(stepNo) || 0}`
    : `lkp_b_${compact.slice(0, 20)}`;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function studioHash(value) {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

/* --------------------------- target validation --------------------------- */

// เป้าหมายของโหมดฝั่ง LINE → { target } (ทรงที่เก็บ) หรือ { error }
export function normalizeStudioTarget(mode, raw = {}) {
  if (!STUDIO_MODES.includes(mode)) return { error: "โหมดผู้รับไม่ถูกต้อง" };
  if (mode === "tags") return { target: {} }; // ป้ายตรวจแยกด้วยตัวกรองป้ายเดิม
  if (mode === "all") return { target: {} };
  if (mode === "audience") {
    const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0))];
    const include = ids(raw.include);
    const exclude = ids(raw.exclude).filter((id) => !include.includes(id));
    if (!include.length) return { error: "เลือกกลุ่มเป้าหมายอย่างน้อย 1 กลุ่ม" };
    if (include.length + exclude.length > AUDIENCE_TARGET_MAX) {
      return { error: `เลือกกลุ่มรวมกันได้ไม่เกิน ${AUDIENCE_TARGET_MAX} กลุ่มต่อครั้ง (กติกา LINE)` };
    }
    return { target: { include, exclude } };
  }
  // demographic
  const pickList = (values, allowed) => [...new Set((Array.isArray(values) ? values : []).map(String))]
    .filter((value) => allowed.includes(value));
  const target = {};
  const gender = pickList(raw.gender, DEMOGRAPHIC_OPTIONS.gender);
  if (gender.length && gender.length < DEMOGRAPHIC_OPTIONS.gender.length) target.gender = gender;
  const appType = pickList(raw.appType, DEMOGRAPHIC_OPTIONS.appType);
  if (appType.length && appType.length < DEMOGRAPHIC_OPTIONS.appType.length) target.appType = appType;
  const area = pickList(raw.area, DEMOGRAPHIC_OPTIONS.area);
  if (area.length) target.area = area;
  for (const key of ["age", "subscriptionPeriod"]) {
    const options = DEMOGRAPHIC_OPTIONS[key];
    const gte = options.includes(String(raw[key]?.gte || "")) ? String(raw[key].gte) : "";
    const lt = options.includes(String(raw[key]?.lt || "")) ? String(raw[key].lt) : "";
    if (gte && lt && options.indexOf(lt) <= options.indexOf(gte)) return { error: "ช่วงที่เลือกต้องจากน้อยไปมาก" };
    if (gte || lt) target[key] = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
  }
  if (!Object.keys(target).length) return { error: "เลือกเงื่อนไขข้อมูลประชากรอย่างน้อย 1 อย่าง (ถ้าจะส่งทุกคน ใช้โหมด เพื่อนทุกคน)" };
  return { target };
}

// ทรงคำขอ narrowcast ตามเอกสาร (#narrowcast-recipient, #narrowcast-demographic-filter, #send-narrowcast-limit)
export function narrowcastPayload(mode, target) {
  const limit = { upToRemainingQuota: true, forbidPartialDelivery: true };
  if (mode === "audience") {
    const include = target.include.map((id) => ({ type: "audience", audienceGroupId: id }));
    const inclusion = include.length === 1 ? include[0] : { type: "operator", or: include };
    const recipient = target.exclude?.length
      ? {
          type: "operator",
          and: [inclusion, ...target.exclude.map((id) => ({ type: "operator", not: { type: "audience", audienceGroupId: id } }))],
        }
      : inclusion;
    return { recipient, filter: null, limit };
  }
  const parts = [];
  if (target.gender) parts.push({ type: "gender", oneOf: target.gender });
  if (target.age) parts.push({ type: "age", ...target.age });
  if (target.appType) parts.push({ type: "appType", oneOf: target.appType });
  if (target.area) parts.push({ type: "area", oneOf: target.area });
  if (target.subscriptionPeriod) parts.push({ type: "subscriptionPeriod", ...target.subscriptionPeriod });
  const demographic = parts.length === 1 ? parts[0] : { type: "operator", and: parts };
  return { recipient: null, filter: { demographic }, limit };
}

/* ------------------------------ confirmation ------------------------------ */

function confirmationPayload({ sessionId, channelId, mode, targetHash, messagesHash, estimate, scheduledAt, fingerprint, issuedAt, nonce }) {
  return JSON.stringify({
    v: 3, sid: sessionId, channelId, mode, targetHash, messagesHash,
    estimate: Number.isSafeInteger(estimate) ? estimate : null,
    scheduledAt: Number.isSafeInteger(scheduledAt) ? scheduledAt : null,
    fingerprint: String(fingerprint || ""), issuedAt, nonce,
  });
}

export function makeStudioConfirmation({ secret, now, ...fields }) {
  const issuedAt = now();
  const nonce = randomBytes(16).toString("base64url");
  const signature = createHmac("sha256", secret).update(confirmationPayload({ ...fields, issuedAt, nonce })).digest("base64url");
  return `${issuedAt}.${nonce}.${signature}`;
}

export function studioConfirmationMatches({ token, secret, now, ...fields }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !/^\d{13}$/u.test(parts[0]) || !/^[A-Za-z0-9_-]{22}$/u.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/u.test(parts[2])) return false;
  const issuedAt = Number(parts[0]);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now() + 5_000 || now() - issuedAt > STUDIO_CONFIRM_TTL_MS) return false;
  const expected = createHmac("sha256", secret).update(confirmationPayload({ ...fields, issuedAt, nonce: parts[1] })).digest("base64url");
  const actual = Buffer.from(parts[2]);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/* --------------------------------- engine --------------------------------- */

export function createBroadcastStudio({ db, config, engine, lineRegistry = null, logger = console, now = Date.now } = {}) {
  const audienceCache = new Map(); // channelId → { at, groups, truncated }
  const insightCalls = new Map(); // channelId → [timestamps]

  const lineFor = (channelId) => lineRegistry?.forChannel?.(channelId) ?? null;

  function audit(operator, action, target, detail) {
    try {
      db.addAudit({ operator: operator || "system", action, target, detail: String(detail || "").slice(0, 200) });
    } catch (error) {
      logger.warn?.(`broadcastStudio: audit ไม่สำเร็จ (${error?.message || error})`);
    }
  }

  function insightBudget(channelId) {
    const t = now();
    const recent = (insightCalls.get(channelId) || []).filter((at) => t - at < 3_600_000);
    if (recent.length >= INSIGHT_CALLS_PER_HOUR) {
      insightCalls.set(channelId, recent);
      return false;
    }
    recent.push(t);
    insightCalls.set(channelId, recent);
    return true;
  }

  // กลุ่มเป้าหมายของ LINE (cache 10 นาที) — ทุกกลุ่มที่ LINE คืนมา ติดชนิด/ที่มาให้คนเลือกเอง
  async function audienceGroups(channelId, { fresh = false } = {}) {
    const cached = audienceCache.get(channelId);
    if (!fresh && cached && now() - cached.at < AUDIENCE_CACHE_MS) return cached;
    const client = lineFor(channelId);
    if (typeof client?.getAudienceGroups !== "function") return { ok: false, reason: "not_line", groups: [] };
    const result = await client.getAudienceGroups();
    if (!result?.ok) {
      return { ok: false, reason: result?.reason || "unavailable", httpStatus: result?.httpStatus || 0, groups: cached?.groups || [] };
    }
    const entry = { ok: true, at: now(), groups: result.groups, truncated: result.truncated === true };
    audienceCache.set(channelId, entry);
    return entry;
  }

  // จำนวนเพื่อนล่าสุดที่ LINE นับเสร็จแล้ว (เมื่อวาน/วานซืนตามเวลาญี่ปุ่น) — เก็บใน settings กันยิงซ้ำหลังรีสตาร์ต
  async function followersSnapshot(channelId, { fresh = false } = {}) {
    const key = `studio_followers:${channelId}`;
    let cached = null;
    try { cached = JSON.parse(db.getSetting(key) || "null"); } catch { cached = null; }
    if (!fresh && cached && now() - Number(cached.at || 0) < FOLLOWERS_CACHE_MS) return cached;
    const client = lineFor(channelId);
    if (typeof client?.getFollowersInsight !== "function") return cached;
    for (const daysBack of [1, 2, 3]) {
      const date = jstDateKey(now() - daysBack * DAY_MS);
      const result = await client.getFollowersInsight({ date });
      if (!result?.ok) return cached;
      if (result.status !== "ready") continue;
      const snapshot = {
        date, at: now(), followers: safeCount(result.followers), blocks: safeCount(result.blocks),
        targetedReaches: safeCount(result.targetedReaches),
      };
      try { db.setSetting(key, JSON.stringify(snapshot)); } catch { /* cache อย่างเดียว */ }
      return snapshot;
    }
    return cached;
  }

  function reachFromFollowers(snapshot) {
    if (!snapshot || snapshot.followers === null || snapshot.followers === undefined) return null;
    return Math.max(0, Number(snapshot.followers) - Number(snapshot.blocks || 0));
  }

  // ประมาณผู้รับ + ชนิดของตัวเลข: exact (นับจากฐานเรา) · line_estimate (สถิติ LINE) · line_decides (LINE คำนวณตอนส่ง)
  async function estimateFor(channelId, mode, target, { audience = null } = {}) {
    if (mode === "tags") return { estimate: audience?.length ?? 0, kind: "exact" };
    if (mode === "all") {
      const snapshot = await followersSnapshot(channelId);
      const reach = reachFromFollowers(snapshot);
      return reach === null
        ? { estimate: null, kind: "line_decides", reason: "followers_unavailable" }
        : { estimate: reach, kind: "line_estimate", followers: snapshot };
    }
    if (mode === "audience") {
      const groups = await audienceGroups(channelId);
      const byId = new Map((groups.groups || []).map((group) => [group.audienceGroupId, group]));
      const picked = target.include.map((id) => byId.get(id)).filter(Boolean);
      if (picked.length !== target.include.length) return { estimate: null, kind: "line_decides", reason: "audience_unknown" };
      const notReady = picked.find((group) => group.status !== "READY");
      if (notReady) return { estimate: null, kind: "line_decides", reason: "audience_not_ready", group: notReady };
      const counts = picked.map((group) => group.audienceCount);
      const sum = counts.every((count) => Number.isSafeInteger(count)) ? counts.reduce((a, b) => a + b, 0) : null;
      // รวมหลายกลุ่ม = เพดานบน (คนซ้ำหลายกลุ่มนับครั้งเดียวตอนส่ง) · กลุ่มยกเว้นทำให้น้อยลงอีก
      return sum === null ? { estimate: null, kind: "line_decides" } : { estimate: sum, kind: "line_estimate", upperBound: true, groups: picked };
    }
    const snapshot = await followersSnapshot(channelId);
    return {
      estimate: null, kind: "line_decides",
      targetedReaches: snapshot?.targetedReaches ?? null,
    };
  }

  // ส่งฝั่ง LINE หนึ่งคำขอ (broadcast หรือ narrowcast) — เรียกหลัง claimBroadcast + attachBroadcastCampaign เท่านั้น
  async function runLineSideSend({ broadcastId, channelId, mode, target, messages, notificationDisabled = false, operator = "system", claimOwnerToken, estimate = null }) {
    const client = lineFor(channelId);
    const retryKey = randomUUID();
    // ด่านกันส่งซ้ำต้องลงดิสก์ก่อนเรียก LINE — เขียนไม่ได้ (DB พัง) = ปิดงานเป็น failed ทันที ไม่ปล่อยให้ OA ค้างรอ lease หมด
    let guard = null;
    try {
      guard = db.armLineSideGuard(channelId, broadcastId, claimOwnerToken, { retryKey, estimate });
    } catch (error) {
      logger.error?.(`broadcastStudio: เขียนด่านก่อนส่งไม่สำเร็จ (${error?.message || error}) — ยังไม่เรียก LINE`);
      guard = null;
    }
    if (!guard?.id) {
      logger.warn?.("broadcastStudio: เตรียมด่านก่อนส่งไม่สำเร็จ — ยังไม่เรียก LINE");
      try {
        db.finalizeBroadcastClaim(channelId, broadcastId, claimOwnerToken, { status: "failed", lastError: "เตรียมด่านก่อนส่งไม่สำเร็จ — ไม่ได้เรียก LINE" });
      } catch { /* lease หมดเองตามกติกาเดิม */ }
      return { state: "not_started" };
    }
    let result;
    let threw = false;
    try {
      if (mode === "all") {
        result = await client.broadcastMessages({ messages, retryKey, notificationDisabled, purpose: SEND_PURPOSE.broadcast });
      } else {
        const payload = narrowcastPayload(mode, target);
        result = await client.narrowcast({ messages, ...payload, retryKey, notificationDisabled, purpose: SEND_PURPOSE.broadcast });
      }
    } catch (error) {
      threw = true;
      result = { ok: false, status: 0, error: String(error?.message || error) };
    }
    const status = Number(result?.status) || 0;
    const ambiguous = threw || result?.ambiguous === true || (!result?.ok && !result?.blocked && (status === 0 || status >= 500));
    if (ambiguous) {
      const kind = threw ? "exception" : status >= 500 ? "server_error" : status === 0 ? "status_0" : "ambiguous";
      const lastError = `ผลส่ง LINE ยังยืนยันไม่ได้ (${kind}${status ? ` HTTP ${status}` : ""}) — กันส่งซ้ำทั้ง OA จนผู้ดูแลตรวจผล`;
      try {
        db.quarantineLineSideSend(channelId, broadcastId, claimOwnerToken, {
          quarantineId: guard.id, providerStatus: status, failureKind: kind, lastError,
        });
      } catch (error) {
        logger.error?.(`broadcastStudio: บันทึก quarantine ไม่สำเร็จ (${error?.message || error}) — runtime_state_unknown`);
      }
      audit(operator, "broadcast_delivery_quarantined", channelId, `broadcast=${broadcastId}; mode=${mode}; line_side=true; operator_review=true`);
      return { state: "unknown" };
    }
    const accepted = result?.ok === true;
    const lastError = accepted ? "" : result?.blocked
      ? `ช่องส่งปิดอยู่ (${result.reason || "blocked"})`
      : status === 429 ? "LINE ตอบ HTTP 429 — ถึงเพดานคำขอหรือโควตาเดือนนี้หมด (ไม่ได้ส่ง)"
        : status === 403 ? "LINE ตอบ HTTP 403 — บัญชีนี้ยังใช้การส่งแบบนี้ไม่ได้ หรือเพื่อนที่ระบุข้อมูลได้น้อยกว่า 100 คน"
          : `LINE ปฏิเสธคำขอ (HTTP ${status || "?"})`;
    try {
      db.settleLineSideSend(channelId, broadcastId, claimOwnerToken, {
        quarantineId: guard.id, accepted, requestId: result?.requestId || "", lastError,
      });
    } catch (error) {
      // ปิดงานไม่สำเร็จ = แถว quarantine ค้าง → OA ถูกกันจนคนตรวจ (ทางปลอดภัย ไม่ใช่ส่งซ้ำ)
      logger.error?.(`broadcastStudio: ปิดงานหลัง LINE ตอบไม่สำเร็จ (${error?.message || error})`);
      return { state: accepted ? "accepted_unsettled" : "rejected_unsettled" };
    }
    audit(operator, accepted ? "broadcast_line_accepted" : "broadcast_line_rejected", channelId,
      `broadcast=${broadcastId}; mode=${mode}; http=${status}${result?.requestId ? "; request_id=yes" : ""}`);
    return { state: accepted ? "accepted" : "rejected", requestId: result?.requestId || "" };
  }

  // ปรับบัญชีการส่ง (ledger) ครั้งเดียวเมื่อ LINE บอกจำนวนผู้รับจริง — จดลงวันที่ส่ง ไม่ใช่วันที่มารู้
  function adjustLedger(row, recipients) {
    if (!Number.isSafeInteger(recipients) || recipients <= 0 || Number(row.ledger_adjusted) === 1) return;
    if (!db.markCampaignLedgerAdjusted(row.id)) return;
    try {
      db.addLineSend({
        day: bangkokDay(Number(row.created_at)), channelId: row.channel_id,
        method: row.mode === "all" ? "broadcast" : "narrowcast", purpose: SEND_PURPOSE.broadcast, detail: "",
        countsQuota: true, sends: 0, requests: 0, recipients, messageObjects: 0, at: now(),
      });
    } catch (error) {
      logger.warn?.(`broadcastStudio: ปรับบัญชีการส่งไม่สำเร็จ (${error?.message || error})`);
    }
  }

  // อัปเดตผลของแคมเปญฝั่ง LINE (ความคืบหน้า narrowcast + สถิติเปิดอ่าน/คลิก) — เรียกตอนเปิดดูผล มี cache/เพดาน
  async function refreshCampaign(broadcastId, { force = false } = {}) {
    let row = db.getBroadcastCampaignRow(broadcastId);
    if (!row?.mode) return row;
    const client = lineFor(row.channel_id);
    const t = now();
    const age = t - Number(row.created_at || t);
    if (row.mode !== "tags" && row.mode !== "all" && row.line_request_id
        && !["succeeded", "failed"].includes(row.line_phase) && age < INSIGHT_WINDOW_MS
        && (force || t - Number(row.line_progress_at || 0) >= PROGRESS_REFRESH_MS)
        && typeof client?.getNarrowcastProgress === "function") {
      const progress = await client.getNarrowcastProgress({ requestId: row.line_request_id });
      if (progress?.ok) {
        db.updateCampaignProgress(row.id, {
          phase: progress.phase, successCount: progress.successCount, failureCount: progress.failureCount,
          targetCount: progress.targetCount,
          error: progress.phase === "failed" ? `${progress.errorCode ?? ""} ${progress.failedDescription || ""}`.trim() : "",
          at: now(),
        });
        if (progress.phase === "succeeded") adjustLedger({ ...row }, progress.successCount);
      } else {
        db.updateCampaignProgress(row.id, { at: now() });
      }
      row = db.getBroadcastCampaignRow(broadcastId);
    }
    const hasTarget = (row.mode === "tags" ? Boolean(row.aggregation_unit) : Boolean(row.line_request_id));
    const insightFresh = row.insight_at && (t - Number(row.insight_at) < INSIGHT_REFRESH_MS
      || Number(row.insight_at) - Number(row.created_at) > INSIGHT_WINDOW_MS + 3_600_000);
    if (hasTarget && ["done", "partial"].includes(row.status) && (!insightFresh || force) && insightBudget(row.channel_id)) {
      let insight = null;
      if (row.mode === "tags" && typeof client?.getAggregationUnitInsight === "function") {
        const from = jstDateKey(Number(row.created_at));
        const to = jstDateKey(Math.min(t, Number(row.created_at) + 29 * DAY_MS));
        insight = await client.getAggregationUnitInsight({ unit: row.aggregation_unit, from, to });
      } else if (typeof client?.getMessageEventInsight === "function") {
        insight = await client.getMessageEventInsight({ requestId: row.line_request_id });
      }
      if (insight?.ok) {
        const { ok, ...data } = insight;
        db.saveCampaignInsight(row.id, { insight: data, at: now() });
        if (row.mode === "all") adjustLedger(row, safeCount(data.overview?.delivered));
      } else {
        // ถามไม่สำเร็จ = คงค่าเดิม แต่ขยับเวลาไว้ ไม่ให้ทุกการเปิดหน้ายิง LINE ซ้ำจนติดเพดาน 60/ชม.
        let previous = null;
        try { previous = row.insight_json ? JSON.parse(row.insight_json) : null; } catch { previous = null; }
        db.saveCampaignInsight(row.id, { insight: previous, at: now() });
      }
      row = db.getBroadcastCampaignRow(broadcastId);
    }
    return row;
  }

  // ตัวเลขผลลัพธ์ฝั่งเรา: ตอบกลับใน 72 ชม. + ออเดอร์ใน 14 วัน (เฉพาะผู้รับที่ระบบรู้จัก)
  function campaignOutcomes(row) {
    const sentAt = Number(row.created_at);
    const replyWindow = { fromMs: sentAt, toMs: sentAt + 72 * 3_600_000 };
    const orderWindow = { fromMs: sentAt, toMs: sentAt + 14 * DAY_MS };
    if (!row.mode || row.mode === "tags") {
      return {
        basis: "recipients",
        replied72h: db.campaignRecipientReplies(row.id, replyWindow),
        orders14d: db.campaignRecipientOrders(row.id, orderWindow),
      };
    }
    if (row.mode === "all" && row.status === "done") {
      return {
        basis: "known_customers",
        replied72h: db.channelKnownReplies({ channelId: row.channel_id, ...replyWindow }),
        orders14d: db.channelKnownOrders({ channelId: row.channel_id, ...orderWindow }),
      };
    }
    return { basis: "unknown_recipients", replied72h: null, orders14d: null };
  }

  // งานตั้งเวลาที่สร้างจากสตูดิโอ ถึงเวลาแล้ว (ตัวตั้งเวลาเดิม claim แถวเป็น preparing ให้แล้ว) —
  // ตรวจทุกอย่างใหม่ ณ เวลาส่งจริง: ข้อความ/ตัวกันราคา/สมาชิกกลุ่ม (ป้าย: ต้องตรงกับตอนยืนยันเป๊ะ)/โควตา/สิทธิ์ส่ง
  // คืน { state: "dispatched", broadcast } หรือ { error, phase } (ตัวตั้งเวลาปิดงานเป็น failed เอง) — ไม่มีการส่งซ้ำ
  async function dispatchScheduled({ row, target: targetRow, scheduleOwnerToken, getImageCatalogByKey = () => new Map() }) {
    const mode = String(targetRow?.mode || "");
    const parseList = (value) => { try { const v = JSON.parse(String(value || "[]")); return Array.isArray(v) ? v : null; } catch { return null; } };
    const stored = parseList(row.messages_json);
    const includeTags = parseList(row.include_tags_json);
    const excludeTags = parseList(row.exclude_tags_json);
    if (!STUDIO_MODES.includes(mode) || !stored || !includeTags || !excludeTags) {
      return { phase: "stored_payload", error: "ข้อมูลงานตั้งเวลาที่บันทึกไว้ไม่ถูกต้อง" };
    }
    const normalized = normalizeStudioTarget(mode, targetRow.target || {});
    if (normalized.error) return { phase: "stored_payload", error: normalized.error };
    const catalog = getImageCatalogByKey();
    const check = buildBroadcastMessages(stored, { imageCatalogByKey: catalog });
    if (check.error) return { phase: "message_rebuild", error: check.error };
    const guarded = engine.guardCheck(check.messages);
    if (!guarded.ok) return { phase: "message_guard", error: guarded.error };
    if (LINE_SIDE_MODES.includes(mode) && config?.linePilotMode === true) {
      return { phase: "pilot_mode", error: "โหมดนำร่องเปิดอยู่ — ส่งถึงเพื่อนทุกคน/กลุ่มเป้าหมาย LINE ไม่ได้" };
    }
    let audience = null;
    if (mode === "tags") {
      if (!includeTags.length) return { phase: "stored_payload", error: "งานตั้งเวลาไม่มีป้ายผู้รับ" };
      audience = db.broadcastAudience({ channelId: row.channel_id, includeTags, excludeTags });
      if (!audience.length) return { phase: "audience_drift", error: "กลุ่มผู้รับว่างในเวลาส่งจริง" };
      if (audience.length > BROADCAST_SCHEDULE_AUDIENCE_CAP) {
        return { phase: "audience_cap", error: `กลุ่มผู้รับ ${audience.length} คน เกินเพดาน ${BROADCAST_SCHEDULE_AUDIENCE_CAP}` };
      }
      if (audience.length !== Number(row.preview_count) || broadcastAudienceFingerprint(audience) !== row.audience_fingerprint) {
        return { phase: "audience_drift", error: "สมาชิกกลุ่มเปลี่ยนจากตอนยืนยัน — กรุณาตั้งเวลาใหม่" };
      }
    }
    const ready = engine.sendReady(row.channel_id);
    if (!ready.ok) return { phase: "send_ready", error: ready.error };
    const estimate = await estimateFor(row.channel_id, mode, normalized.target, { audience });
    if (mode === "all" && !Number.isSafeInteger(estimate.estimate)) {
      return { phase: "estimate", error: "อ่านจำนวนเพื่อนจาก LINE ไม่ได้ในเวลาส่ง — ไม่ส่ง (โควตาอาจไม่พอ)" };
    }
    if (mode === "audience" && estimate.reason) {
      return { phase: "audience_not_ready", error: "กลุ่มเป้าหมายที่เลือกไม่พร้อมหรือหายไปจาก LINE ในเวลาส่ง" };
    }
    const estimatedUse = quotaUseFor(mode, estimate.estimate);
    const quota = await engine.quotaFor(row.channel_id, { fresh: true });
    // การอ่านโควตาข้ามขอบ async — เจ้าของอาจกดยกเลิกระหว่างนั้น ต้องอ่านสถานะงานใหม่ก่อนตีความโควตา
    const current = db.getBroadcastSchedule(row.id);
    if (!current || current.status !== "preparing" || current.preparing_owner_token !== scheduleOwnerToken) {
      return { state: current?.status === "cancelled" ? "cancelled" : "state_changed" };
    }
    const limited = quota?.type === "limited" && Number.isSafeInteger(quota.value) && Number.isSafeInteger(quota.totalUsage);
    if (!(quota?.type === "none" && Number.isSafeInteger(quota.totalUsage)) && !limited) {
      return { phase: "quota", error: "อ่านโควตา LINE ไม่ได้หรือข้อมูลไม่สมบูรณ์" };
    }
    if (limited && quota.value - quota.totalUsage < Math.max(estimatedUse, 1)) {
      return { phase: "quota", error: `โควตา LINE คงเหลือ ${quota.value - quota.totalUsage} ไม่พอสำหรับการส่งครั้งนี้` };
    }
    const collector = createLinkCollector(Number(targetRow.track_clicks) === 0 ? "" : trackingBaseUrl(config));
    const built = buildBroadcastMessages(stored, { imageCatalogByKey: catalog, linkTracker: collector.tracker });
    if (built.error) return { phase: "message_rebuild", error: built.error };
    const finalGuard = engine.guardCheck(built.messages);
    if (!finalGuard.ok) return { phase: "message_guard", error: finalGuard.error };
    let claim;
    try {
      claim = db.claimBroadcast({
        channelId: row.channel_id, messages: built.stored, includeTags, excludeTags,
        audience: mode === "tags" ? audience : null, audienceCount: estimatedUse, createdBy: row.created_by,
        cooldownMs: 60_000, ownerToken: engine.broadcastOwnerToken, leaseDurationMs: BROADCAST_CLAIM_LEASE_MS,
        scheduleId: row.id, scheduleOwnerToken,
      });
    } catch (error) {
      return { phase: "broadcast_claim", error: String(error?.message || error) };
    }
    if (!claim.ok) {
      const reason = claim.reason === "active" ? "มีบรอดแคสต์ของ OA นี้กำลังส่งอยู่"
        : claim.reason === "cooldown" ? "OA นี้ยังอยู่ใน cooldown หลังบรอดแคสต์ก่อนหน้า"
          : claim.reason === "delivery_quarantined" ? "ผลส่งครั้งก่อนยังยืนยันไม่ได้ — ต้องให้ผู้ดูแลตรวจก่อน"
            : "สถานะงานตั้งเวลาเปลี่ยนก่อนเริ่มส่ง";
      return { phase: "broadcast_claim", error: reason };
    }
    const broadcast = claim.row;
    const aggregationUnit = mode === "tags" ? aggregationUnitFor("broadcast", broadcast.id) : "";
    try {
      db.attachBroadcastCampaign({
        broadcastId: broadcast.id, channelId: row.channel_id, mode, target: normalized.target,
        estimate: Number.isSafeInteger(estimate.estimate) ? estimate.estimate : null, estimateKind: estimate.kind,
        notificationDisabled: Number(targetRow.notification_disabled) === 1, aggregationUnit, scheduleId: row.id,
        links: collector.links,
      });
    } catch (error) {
      logger.error?.(`broadcastStudio: บันทึกแคมเปญตั้งเวลาไม่สำเร็จ — ยกเลิกก่อนเรียก LINE (${error?.message || error})`);
      try {
        db.finalizeBroadcastClaim(row.channel_id, broadcast.id, engine.broadcastOwnerToken, {
          status: "failed", lastError: "บันทึกแคมเปญไม่สำเร็จ — ไม่ได้เรียก LINE",
        });
      } catch { /* lease หมดเองตามกติกาเดิม */ }
      return { state: "dispatched", broadcast };
    }
    queueMicrotask(() => {
      const job = mode === "tags"
        ? engine.runSend({
            broadcastId: broadcast.id, channelId: row.channel_id, audience, messages: built.messages,
            storedMessages: built.stored, operator: row.created_by, includeTags, excludeTags,
            claimOwnerToken: engine.broadcastOwnerToken, aggregationUnit,
          })
        : runLineSideSend({
            broadcastId: broadcast.id, channelId: row.channel_id, mode, target: normalized.target,
            messages: built.messages, notificationDisabled: Number(targetRow.notification_disabled) === 1,
            operator: row.created_by, claimOwnerToken: engine.broadcastOwnerToken, estimate: estimatedUse,
          });
      Promise.resolve(job).catch((error) => logger.error?.(`broadcastStudio: งานส่งตามเวลาล้มเหลว (${error?.message || error})`));
    });
    return { state: "dispatched", broadcast };
  }

  return {
    audienceGroups, followersSnapshot, estimateFor, runLineSideSend, refreshCampaign, campaignOutcomes,
    dispatchScheduled,
    trackingBaseUrl: () => trackingBaseUrl(config),
    lineSideModes: LINE_SIDE_MODES,
  };
}
