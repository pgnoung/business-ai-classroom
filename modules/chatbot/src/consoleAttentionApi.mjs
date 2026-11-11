// consoleAttentionApi.mjs — GET /console/api/overview/attention (28 ก.ย. 2026)
//
// "เงินรั่วตรงไหนตอนนี้" สองรายการบนสุดของหน้าภาพรวม (ข้อมูลจริงเดือนกันยายน):
//   waiting  = นิยาม "รอตอบ" ชุดเดียวของคอนโซล (waitingRooms.mjs) — ชิป "รอตอบ" หน้าแชทได้ชุดเดียวกัน
//   hotQuiet = ลูกค้าคะแนน 8+ ที่ลูกแพรตอบแล้วเกิน 1 วัน ลูกค้าเงียบ และหลังข้อความล่าสุดของลูกค้ายังไม่มีทีมทัก
//              (= ถึงตาทีมทักต่อ) · 29 ก.ย. 2026: ค้างจนกว่าคนจริงจะทัก ไม่มีเพดานวัน — ยกเว้น Facebook ที่ลูกค้าเงียบ
//              เกิน 7 วัน ตอบไม่ได้แล้วแม้ใน Business Suite = ไม่ขึ้นรายการ · teamRate = ทีมทักต่อกี่ % (hotFollowupRate.mjs)
// เรียงตาม "มูลค่า" ก่อน (เรื่องเงิน > ร้อน > อุ่น > อื่น ๆ) แล้วค่อยเวลารอ/เงียบนานสุด
//
// อ่านอย่างเดียว · ต้องมีสิทธิ์ operations.use (ทุกบทบาทงานประจำมีอยู่แล้ว) · ไม่มีตัวเลขเงินสักฟิลด์
// ข้อความลูกค้าส่งออกได้ไม่เกิน 40 ตัวอักษร (นับเป็นตัวอักษรที่มองเห็น ไม่ตัดกลางสระ/วรรณยุกต์)
// คิวรีมีเพดานทั้งผู้สมัคร (dbAttention.mjs) และรายการที่ส่งกลับ (สูงสุด 20 ห้องต่อรายการ)
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { aiOffInfo, notQualifiedTeamBlocked } from "./aiOffActor.mjs";
import {
  ATTENTION_PREVIEW_CHARS, WAITING_GRACE_MS, WAITING_WINDOW_MS, attentionPreview, attentionRoomBase, attentionValue,
  isAckOnlyInbound, summarizeWaiting,
} from "./waitingRooms.mjs";
import { HOT_FOLLOWUP_ENTRY_MS, HOT_FOLLOWUP_RATE_WINDOW_MS, summarizeHotFollowupRate } from "./hotFollowupRate.mjs";
import {
  RELAY_DEADLINE_WORK_MS, RELAY_KEEP_SCORE, RELAY_LIST_MAX_AGE_MS, RELAY_OPEN_WORK_MS, RELAY_RATE_WINDOW_MS, RELAY_TARGET_WORK_MS,
  readRelayStartAt, relayStatus, summarizeRelay,
} from "./relayBaton.mjs";
import { addWorkMs, readOffDays, workMsBetween } from "./workClock.mjs";

// 28 ก.ย. 2026: นิยาม "รอตอบ" ย้ายไปอยู่ waitingRooms.mjs ที่เดียว (ชิปหน้าแชท/Telegram ใช้ตัวเดียวกัน)
// ส่งต่อชื่อเดิมไว้ให้ผู้เรียกเดิม (ownerChatSnapshot.mjs + เทสต์) ไม่ต้องแก้ตาม
export { ATTENTION_PREVIEW_CHARS, attentionPreview, attentionValue, summarizeWaiting };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const ATTENTION_GRACE_MS = WAITING_GRACE_MS;
// ลูกแพรตอบแล้วครบกี่นานถึงนับว่า "ค้างให้ทีมทักต่อ" (พี่ง้วง 29 ก.ย.: "ai ตอบไปแล้ว เกิน 1 วัน")
export const HOT_QUIET_MIN_MS = HOT_FOLLOWUP_ENTRY_MS;
// ตัวชี้วัดทีมทักต่อคิดใหม่อย่างมากทุก 5 นาที — หน้าภาพรวมรีเฟรชถี่ แต่ตัวเลขนี้ขยับช้า
const TEAM_RATE_CACHE_MS = 5 * MIN;
export const ATTENTION_LIST_DEFAULT = 8;
export const ATTENTION_LIST_MAX = 20;

// Facebook: คนตอบใน Meta Business Suite ได้ถึง 7 วันหลังข้อความล่าสุดของลูกค้า (แท็ก HUMAN_AGENT) — ระบบทักเองได้แค่ 24 ชม.
export const FB_HUMAN_REPLY_MS = 7 * DAY;

// 29 ก.ย. 2026 (พี่ง้วง: "บางแชท AI ตอบไปแล้ว ทำไมถึงยังขึ้น" → "ขึ้นแบบนี้เยี่ยมเลย อยากให้ขึ้นค้างไว้"):
// รายการนี้คือ "ลูกค้าร้อนที่ลูกแพรตอบแล้ว ลูกค้าเงียบ และทีมยังไม่ได้ทักต่อ" — ค้างจนกว่าคนจริงจะทัก
// ส่ง aiReplies (ข้อความฝั่งเราหลังลูกค้าพูดล่าสุด) เส้นตายของ Facebook และ "เคยคุยกับทีมแล้วไหม" ไปให้หน้าจอบอกเหตุชัด ๆ
// เรียง: Facebook ที่ตอบได้อีกไม่ถึงวัน (ใกล้หลุดถาวร) → คะแนนมากก่อน → ลูกค้าพูดล่าสุดใหม่กว่าก่อน (ยังสนใจอยู่)
// ข้อความลูกค้าหลังคำตอบล่าสุดมีเรื่องให้ตอบไหม — มี = ห้องนี้อยู่คิวรอตอบ ไม่ใช่รายการนี้ (ไม่นับซ้ำสองที่)
// แค่ขอบคุณ/สติกเกอร์/แฮชแท็ก = ยังค้างให้ทีมทักต่อ (พี่ง้วง: ห้องหายเมื่อคนไปคุยเท่านั้น) · แถวไม่มีข้อมูลนี้ = ไม่มีคำถามค้าง
export function hotHasOpenQuestion(row = {}) {
  if (row.unanswered_json == null) return false;
  let items;
  try {
    items = JSON.parse(String(row.unanswered_json));
  } catch {
    return true; // อ่านไม่ออก = ไม่เดาว่าเงียบ ให้คิวรอตอบดูแล
  }
  if (!Array.isArray(items) || !items.length) return false;
  if (items.some((item) => !isAckOnlyInbound(item || {}))) return true;
  return (Number(row.unanswered_count) || items.length) > items.length;
}

// teamBlockedOf(row) = ห้องเหลืองที่มีแต่ทีมปลดได้ไหม — รีวิวปรปักษ์รอบ 3 5 ต.ค.: คิวรอตอบบนหน้าเดียวกันบอก "รอทีม" แล้ว
// การ์ดนี้ต้องบอกแบบเดียวกัน (ผู้เรียกที่มี DB ส่ง notQualifiedTeamBlocked · ไม่ส่ง = ถ้อยคำเดิม)
export function summarizeHotQuiet(rows = [], { now = Date.now(), limit = ATTENTION_LIST_DEFAULT, channelLabel = (id) => id, teamBlockedOf = () => false } = {}) {
  const ranked = rows
    .filter((row) => !hotHasOpenQuestion(row))
    .map((row) => {
      const lastInAt = Number(row.last_in_at) || 0;
      const isFacebook = String(row.channel_id || "") === "facebook";
      const fbHumanUntil = isFacebook ? (lastInAt > 0 ? lastInAt + FB_HUMAN_REPLY_MS : 0) : null;
      return { row, lastInAt, fbHumanUntil, urgent: fbHumanUntil !== null && fbHumanUntil - now < DAY };
    })
    // Facebook ที่เลย 7 วัน (หรือไม่รู้เวลาลูกค้าพูดล่าสุด) ส่งอะไรไม่ได้อีกแล้ว — ขึ้นรายการไปก็ทำอะไรไม่ได้
    .filter((item) => item.lastInAt > 0 && (item.fbHumanUntil === null || item.fbHumanUntil > now))
    .sort((a, b) => (Number(b.urgent) - Number(a.urgent))
      || (a.urgent && b.urgent ? a.fbHumanUntil - b.fbHumanUntil : 0)
      || ((Number(b.row.last_score) || 0) - (Number(a.row.last_score) || 0))
      || (b.lastInAt - a.lastInAt));
  return {
    total: ranked.length,
    urgent: ranked.filter((item) => item.urgent).length,
    rooms: ranked.slice(0, limit).map(({ row, lastInAt, fbHumanUntil }) => ({
      ...attentionRoomBase(row, channelLabel),
      lastAt: Number(row.last_at) || lastInAt,
      lastInAt,
      aiReplyAt: Number(row.ai_reply_at) || null,
      silentMs: Math.max(0, now - lastInAt),
      aiOff: aiOffInfo(row, { teamBlocked: teamBlockedOf(row) === true }),
      aiReplies: Math.max(0, Math.trunc(Number(row.outs_after_in) || 0)),
      teamTalkedBefore: Number(row.team_talked_before) === 1,
      fbHumanUntil,
    })),
  };
}

// ผู้สมัคร + สรุปรายการ "ลูกค้าร้อนรอทีมทักต่อ" — ใช้ร่วมกันระหว่างหน้าภาพรวมกับ push แจ้งทีม (hotFollowupPush.mjs)
export function hotFollowupList(db, { now = Date.now(), channel = null, limit = ATTENTION_LIST_DEFAULT, channelLabel = (id) => id } = {}) {
  const rows = db.attentionHotQuietCandidates({ channel, aiReplyBeforeMs: now - HOT_QUIET_MIN_MS });
  return summarizeHotQuiet(rows, { now, limit, channelLabel, teamBlockedOf: (row) => notQualifiedTeamBlocked(db, row) });
}

export function hotFollowupTeamRate(db, { now = Date.now(), windowMs = HOT_FOLLOWUP_RATE_WINDOW_MS, channel = null } = {}) {
  // ย้อนเผื่ออีก 3 วัน: ห้องที่ "เข้ารายการ" ต้นช่วง ลูกค้าพูดและลูกแพรตอบก่อนหน้านั้นหนึ่งวันขึ้นไป
  const data = db.hotFollowupKpiRows({ sinceMs: now - windowMs - 3 * DAY, channel });
  return summarizeHotFollowupRate(data, { now, windowMs });
}

// 3 พ.ย. 2026 "ไม้ต่อจากลูกแพร" (relayBaton.mjs) แทนที่ "ลูกค้าร้อนรอทีมทักต่อ" บนการ์ด/คิว/push ชุดเดิม:
// ทุกห้องที่ลูกแพรคุยจบ ลูกค้าเงียบครบ 2 ชม.ทำการ และยังไม่มีคนจริงทัก — สถานะตามเวลาทำการหลังลูกแพรจบ
// (ontrack < 3 ชม. · due 3–6 ชม. · overdue เกิน 6 ชม.) · กติกาค้าง/หาย/คำถามค้าง/Facebook 7 วัน เหมือนเดิมทุกข้อ
// เรียง: Facebook ใกล้หมดเวลา → เกินเวลา → ควรต่อแล้ว → ยังทัน → คะแนนมากก่อน → ลูกค้าพูดล่าสุดใหม่กว่าก่อน (ยังสนใจอยู่ — 29 ก.ย.)
const RELAY_STATUS_RANK = { overdue: 0, due: 1, ontrack: 2 };
export function summarizeRelayQuiet(rows = [], {
  now = Date.now(), limit = ATTENTION_LIST_DEFAULT, channelLabel = (id) => id, teamBlockedOf = () => false, offDays = new Set(),
} = {}) {
  const ranked = rows
    .filter((row) => !hotHasOpenQuestion(row))
    .map((row) => {
      const lastInAt = Number(row.last_in_at) || 0;
      const aiEndAt = Number(row.last_reply_at) || 0;
      const isFacebook = String(row.channel_id || "") === "facebook";
      const fbHumanUntil = isFacebook ? (lastInAt > 0 ? lastInAt + FB_HUMAN_REPLY_MS : 0) : null;
      const workElapsedMs = workMsBetween(aiEndAt, now, { offDays });
      return {
        row, lastInAt, aiEndAt, fbHumanUntil, workElapsedMs, status: relayStatus(workElapsedMs),
        urgent: fbHumanUntil !== null && fbHumanUntil - now < DAY,
      };
    })
    .filter((item) => item.lastInAt > 0 && item.aiEndAt > 0 && (item.fbHumanUntil === null || item.fbHumanUntil > now))
    .filter((item) => item.workElapsedMs >= RELAY_OPEN_WORK_MS)
    .sort((a, b) => (Number(b.urgent) - Number(a.urgent))
      || (a.urgent && b.urgent ? a.fbHumanUntil - b.fbHumanUntil : 0)
      || (RELAY_STATUS_RANK[a.status] - RELAY_STATUS_RANK[b.status])
      || ((Number(b.row.last_score) || 0) - (Number(a.row.last_score) || 0))
      || (b.lastInAt - a.lastInAt)
      || String(a.row.line_user_id).localeCompare(String(b.row.line_user_id)));
  const count = (status) => ranked.filter((item) => item.status === status).length;
  return {
    total: ranked.length,
    urgent: ranked.filter((item) => item.urgent).length,
    overdue: count("overdue"),
    due: count("due"),
    ontrack: count("ontrack"),
    targetHours: RELAY_TARGET_WORK_MS / HOUR,
    deadlineHours: RELAY_DEADLINE_WORK_MS / HOUR,
    rooms: ranked.slice(0, limit).map(({ row, lastInAt, aiEndAt, fbHumanUntil, workElapsedMs, status }) => ({
      ...attentionRoomBase(row, channelLabel),
      lastAt: Number(row.last_at) || lastInAt,
      lastInAt,
      aiReplyAt: Number(row.ai_reply_at) || null,
      aiEndAt,
      silentMs: Math.max(0, now - lastInAt),
      workElapsedMs,
      relayStatus: status,
      deadlineAt: addWorkMs(aiEndAt, RELAY_DEADLINE_WORK_MS, { offDays }),
      aiOff: aiOffInfo(row, { teamBlocked: teamBlockedOf(row) === true }),
      aiReplies: Math.max(0, Math.trunc(Number(row.outs_after_in) || 0)),
      teamTalkedBefore: Number(row.team_talked_before) === 1,
      fbHumanUntil,
    })),
  };
}

// ผู้สมัคร + สรุปรายการไม้ต่อ — ใช้ร่วมกันระหว่างหน้าภาพรวม คิวหน้าแชท ตัวนับ inbox และ push แจ้งทีม
export function relayList(db, { now = Date.now(), channel = null, limit = ATTENTION_LIST_DEFAULT, channelLabel = (id) => id } = {}) {
  const rows = db.relayCandidates({
    channel, aiEndBeforeMs: now - RELAY_OPEN_WORK_MS, keepScore: RELAY_KEEP_SCORE,
    minAiEndMs: Math.max(now - RELAY_LIST_MAX_AGE_MS, readRelayStartAt(db)),
  });
  return summarizeRelayQuiet(rows, {
    now, limit, channelLabel, offDays: readOffDays(db), teamBlockedOf: (row) => notQualifiedTeamBlocked(db, row),
  });
}

export function relayTeamRate(db, { now = Date.now(), windowMs = RELAY_RATE_WINDOW_MS, channel = null } = {}) {
  // ย้อนเผื่ออีก 7 วัน: ไม้ที่เปิดต้นช่วงอาจมาจากรอบที่ลูกค้าพูดก่อนหน้านั้นหลายวัน (วันหยุดยาว)
  const data = db.relayKpiRows({ sinceMs: now - windowMs - 7 * DAY, channel });
  return summarizeRelay(data, { now, windowMs, offDays: readOffDays(db) });
}

export function createConsoleAttentionRoutes({ db, now = Date.now, channelLabel = (id) => id }) {
  const rateCache = new Map(); // สาขา → { at, value } — หน้าภาพรวมกรองสาขาได้ ตัวเลขต้องตามสาขาที่ดู
  // ตัวชี้วัดพังได้โดยไม่ลากรายการล้ม (null = หน้าจอไม่โชว์บรรทัดนี้)
  function teamRate(t, channel = null) {
    const key = channel || "";
    const hit = rateCache.get(key);
    if (hit && t - hit.at < TEAM_RATE_CACHE_MS) return hit.value;
    try {
      const value = relayTeamRate(db, { now: t, channel });
      rateCache.set(key, { at: t, value });
      return value;
    } catch {
      return null;
    }
  }
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "overview" || route[1] !== "attention" || route.length !== 2) return false;
    const { json, operator, parseChannelParam } = ctx;
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!hasOperatorCapability(operator, "operations.use")) {
      json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้" });
      return true;
    }
    const chParam = parseChannelParam(url);
    if (!chParam.ok) {
      json(res, 400, { ok: false, error: "channel ไม่อยู่ในรายการสาขา" });
      return true;
    }
    const limit = Math.min(ATTENTION_LIST_MAX, Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || ATTENTION_LIST_DEFAULT));
    const t = now();
    try {
      // ผู้สมัครชุดเดียวกับชิป "รอตอบ" หน้าแชท (waitingRooms.listWaitingRooms) — ตัวเลข/ลำดับตรงกันเสมอ
      const waitingRows = db.attentionWaitingCandidates({
        channel: chParam.channel, sinceMs: t - WAITING_WINDOW_MS, beforeMs: t - ATTENTION_GRACE_MS,
      });
      // คีย์ hotQuiet คงชื่อเดิม (หน้าเว็บที่เปิดค้างอยู่อ่านคีย์นี้) — เนื้อในเป็นไม้ต่อตั้งแต่ 3 พ.ย. 2026
      const hotQuiet = relayList(db, { now: t, channel: chParam.channel, limit, channelLabel });
      json(res, 200, {
        ok: true,
        generatedAt: t,
        channel: chParam.channel,
        windowDays: Math.round(WAITING_WINDOW_MS / DAY),
        hotQuietMinDays: HOT_QUIET_MIN_MS / DAY,
        // รีวิวปรปักษ์รอบ 3 5 ต.ค.: ชิปรอตอบ (listWaitingRooms) ส่ง teamBlockedOf แล้ว — การ์ดนี้ต้องได้ข้อความเดียวกัน
        waiting: summarizeWaiting(waitingRows, { now: t, limit, channelLabel, teamBlockedOf: (row) => notQualifiedTeamBlocked(db, row) }),
        hotQuiet: { ...hotQuiet, teamRate: teamRate(t, chParam.channel) },
      });
    } catch {
      // หน้าภาพรวมคือหน้าแรกหลังล็อกอิน — พังตรงนี้ต้องบอกว่าพัง ไม่ใช่ลากทั้งหน้าล้ม
      json(res, 500, { ok: false, error: "อ่านรายการห้องที่ต้องดูแลไม่สำเร็จ" });
    }
    return true;
  }
  return { handle };
}
