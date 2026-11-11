// consoleTriageApi.mjs — คัดห้องในคอนโซล: คิว "รอตอบ" ในหน้าแชท + ปุ่ม "สแปม" (28 ก.ย. 2026)
//
// คำขอพี่ง้วง (28 ก.ย.): "อยากให้ทำระบบ spam ลูกค้า เพื่อ screen คนออกจาก inbox" · "spam = null chat tag"
// · "tab รอตอบนานกว่า 24 ชม. (tab นี้กับหน้านี้ให้เหมือนกัน)" · เวลากดเข้าแชทค้างแล้วต้อง back กลับมาเอง
// ทุกครั้ง ไม่สะดวก — ไฟล์นี้คือฝั่งเซิร์ฟเวอร์ของสามเรื่อง:
//   1) หน้าแชทแบบ "รอตอบ"/"ค้าง >24 ชม." ใช้รายการจาก waitingRooms.listWaitingRooms ตัวเดียวกับหน้าภาพรวม
//      (ลำดับและตัวเลขเหมือนกันเป๊ะ) แล้วค่อยดึงแถวเต็มของหน้าแชท + ส่งลำดับทั้งคิวไปให้ปุ่ม "ห้องถัดไป"
//   2) POST /console/api/customers/:id/spam { spam: true|false } — ติด/ถอนป้าย null ผ่าน
//      customerTagActions.mjs เส้นเดียวกับแผงป้าย (AI ปิดเหตุ not_a_customer · follow-up หยุด) + audit
//      spam_marked / spam_unmarked · ถอนสแปมไม่เปิด AI คืน (คนต้องกดเปิดเอง — บอกในข้อความตอบ)
//   3) ข้อมูลหัวห้องแชท: รอตอบไหม/นานเท่าไร · สแปมไหม · AI ปิดเพราะใคร · Facebook เกิน 24 ชม. แล้วหรือยัง
import { businessSuiteInboxUrl } from "./businessSuiteLink.mjs";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { aiOffInfo, notQualifiedReasonFor, notQualifiedTeamBlocked } from "./aiOffActor.mjs";
import { FB_REPLY_WINDOW_MS, listWaitingRooms, waitingRoomFor } from "./waitingRooms.mjs";
import { SPAM_TAG, isSpamTag } from "./spamTag.mjs";
import { addCustomerTag, removeCustomerTag, safeListTags } from "./customerTagActions.mjs";

export const WAITING_SEGMENTS = Object.freeze(["waiting", "waiting24"]);
const WAITING_SET = new Set(WAITING_SEGMENTS);
// 30 ก.ย. 2026 (พี่ง้วง: ปุ่ม "ไล่ทักทีละห้อง" แบบคิวรอตอบ): คิวลูกค้าร้อนรอทีมทักต่อในหน้าแชท
// รายการ/ลำดับ/จำนวนชุดเดียวกับการ์ดหน้าภาพรวมและ push แจ้งทีม (consoleAttentionApi.relayList — ไม้ต่อ ตั้งแต่ 3 พ.ย. 2026)
export const HOT_FOLLOW_SEGMENT = "hotfollow";
// listConversations มีเพดาน 200 แถวต่อครั้ง — ค้นหาในคิวยาวจึงดึงเป็นก้อน
const ID_CHUNK = 200;

export function isWaitingSegment(segment) {
  return WAITING_SET.has(String(segment || ""));
}

// ข้อมูลรอตอบที่ติดไปกับแถวในหน้าแชท (ป้ายเวลารอ/มูลค่า/Facebook ตอบไม่ได้แล้ว)
function waitingBadge(room) {
  return {
    since: room.since, waitMs: room.waitMs, over24: room.over24, value: room.value, score: room.score,
    fbReplyClosed: room.fbReplyClosed, preview: room.preview, aiPaused: room.aiPaused,
  };
}

// หน้าหนึ่งของคิวในหน้าแชท — ลำดับจากคิว (ไม่ใช่ความเคลื่อนไหวล่าสุด) · badgeOf(room) = ข้อมูลที่ติดไปกับแถว
// คิวของทั้งทีม (ไม่กรองตามผู้รับผิดชอบ) — ค้นหาในคิว = ลำดับที่ส่งกลับก็ต้องเป็นลำดับหลังค้น
// ("ห้อง N จาก M" และ "ห้องถัดไป" เดินตามผลค้นที่เห็นอยู่ ไม่กระโดดไปห้องนอกผลค้น — จับได้ในรีวิวโค้ด 28 ก.ย.)
function queueInboxPage({ db, ranked, badgeKey, badgeOf, q = "", deep = false, limit = 30, offset = 0 }) {
  const byId = new Map(ranked.map((room) => [room.id, room]));
  let order = ranked.map((room) => room.id);
  if (q) {
    const hit = new Set();
    for (let i = 0; i < order.length; i += ID_CHUNK) {
      const ids = order.slice(i, i + ID_CHUNK);
      for (const row of db.listConversations({ ids, q, deep, limit: ids.length })) hit.add(row.line_user_id);
    }
    order = order.filter((id) => hit.has(id));
  }
  const pageIds = order.slice(offset, offset + limit);
  const rowsById = new Map(db.listConversations({ ids: pageIds, limit: Math.max(1, pageIds.length) })
    .map((row) => [row.line_user_id, row]));
  const rows = pageIds
    .map((id) => rowsById.get(id))
    .filter(Boolean)
    .map((row) => ({ ...row, [badgeKey]: badgeOf(byId.get(row.line_user_id)) }));
  return { rows, hasMore: order.length > offset + limit, order };
}

/**
 * หน้าหนึ่งของคิวรอตอบในหน้าแชท
 * @returns {{ rows: object[], hasMore: boolean, order: string[] }}
 */
export function waitingInboxPage({ db, waiting, segment, q = "", deep = false, limit = 30, offset = 0 }) {
  const ranked = segment === "waiting24" ? waiting.rooms.filter((room) => room.over24) : waiting.rooms;
  return queueInboxPage({ db, ranked, badgeKey: "waiting", badgeOf: waitingBadge, q, deep, limit, offset });
}

// ข้อมูลที่ติดไปกับแถวคิวรอทีมทักต่อ: เงียบนานเท่าไร · ลูกแพรส่งไปกี่ข้อความ · เคยคุยกับทีมไหม · เส้นตาย Facebook
function hotFollowBadge(room) {
  return {
    lastInAt: room.lastInAt, silentMs: room.silentMs, aiReplies: room.aiReplies, teamTalkedBefore: room.teamTalkedBefore,
    fbHumanUntil: room.fbHumanUntil, value: room.value, score: room.score, preview: room.preview,
    // ไม้ต่อ (3 พ.ย. 2026): สถานะตามเวลาทำการหลังลูกแพรจบ + เส้นตาย 6 ชม.
    relayStatus: room.relayStatus, workElapsedMs: room.workElapsedMs, deadlineAt: room.deadlineAt,
  };
}

/** หน้าหนึ่งของคิว "ไม้ต่อจากลูกแพร" — hot = ผลของ relayList (ทุกห้อง ไม่ตัดจำนวน) */
export function hotFollowInboxPage({ db, hot, q = "", deep = false, limit = 30, offset = 0 }) {
  return queueInboxPage({ db, ranked: hot.rooms, badgeKey: "hot_follow", badgeOf: hotFollowBadge, q, deep, limit, offset });
}

/** ข้อมูลหัวห้องแชทของห้องเดียว — ทุกฟิลด์มาจากนิยามเดียวกับรายการ */
export function roomTriage({ db, customer, now = Date.now(), channelLabel = (id) => id, facebookPageId = "" }) {
  const customerId = String(customer?.line_user_id || "");
  const isFacebook = String(customer?.channel_id || "") === "facebook";
  let flags = null;
  try { flags = db.triageFlags(customerId); } catch { flags = null; }
  let waiting = null;
  try { waiting = waitingRoomFor({ db, customerId, now, channelLabel }); } catch { waiting = null; }
  const lastInAt = Number(flags?.last_in_at) || 0;
  return {
    spam: Number(flags?.is_spam) === 1,
    // รีวิวปรปักษ์รอบ 3 5 ต.ค.: ห้องเหลืองที่มีแต่ทีมปลดได้ ขึ้นข้อความ "รอทีมดู" แทน "ตัวกวาดเปิดคืนเอง"
    aiOff: aiOffInfo({ ...customer, ai_off_system_tag: flags?.ai_off_system_tag }, {
      qualifyReason: notQualifiedReasonFor(db, customer), teamBlocked: notQualifiedTeamBlocked(db, customer),
    }),
    waiting: waiting ? waitingBadge(waiting) : null,
    // เปิดห้องไหนก็ต้องรู้ก่อนพิมพ์ — ไม่ใช่เฉพาะห้องในคิวรอตอบ
    fbReplyClosed: isFacebook && lastInAt > 0 && now - lastInAt >= FB_REPLY_WINDOW_MS,
    // 28 ก.ย. 2026 (พี่ง้วง): เปิดกล่องข้อความของเพจใน Meta Business Suite — ตอบได้ถึง 7 วันเมื่อคอนโซลตอบไม่ได้แล้ว
    businessSuiteUrl: isFacebook ? businessSuiteInboxUrl(facebookPageId) : "",
    lastInboundAt: lastInAt || null,
  };
}

/** ติดป้ายสแปม (null) ผ่านเส้นเดียวกับแผงป้าย — ห้องที่เป็นสแปมอยู่แล้ว (ป้ายตัวพิมพ์ไหนก็ได้) ไม่ทำซ้ำ */
export function markSpam({ db, customerId, operator }) {
  if (safeListTags(db, customerId).some((row) => isSpamTag(row.tag))) return { ok: true, spam: true, already: true };
  const before = db.getCustomer(customerId);
  const added = addCustomerTag({ db, customerId, tag: SPAM_TAG, operator });
  if (!added.ok) return added;
  db.addAudit({
    operator, action: "spam_marked", target: customerId,
    detail: added.aiSilenced
      ? "ย้ายไปสแปม (ป้าย null) — ปิด AI เหตุ not_a_customer หยุดทักตาม ห้องหายจากทุกคิว"
      : `ย้ายไปสแปม (ป้าย null) — AI ปิดอยู่แล้ว (${before?.ai_off_reason || "ไม่ทราบเหตุ"}) หยุดทักตาม ห้องหายจากทุกคิว`,
  });
  return { ok: true, spam: true, aiSilenced: added.aiSilenced };
}

/** ถอนสแปม = ถอดป้าย null ทุกตัวพิมพ์ · AI ไม่เปิดคืนเอง */
export function unmarkSpam({ db, customerId, operator }) {
  const variants = safeListTags(db, customerId).filter((row) => isSpamTag(row.tag));
  if (!variants.length) return { ok: true, spam: false, already: true, aiEnabled: db.getCustomer(customerId)?.ai_enabled === 1 };
  for (const row of variants) {
    const removed = removeCustomerTag({ db, customerId, tag: row.tag, operator });
    if (!removed.ok) return removed;
  }
  const aiEnabled = db.getCustomer(customerId)?.ai_enabled === 1;
  db.addAudit({
    operator, action: "spam_unmarked", target: customerId,
    detail: aiEnabled ? "ไม่ใช่สแปม — ถอดป้าย null (AI เปิดอยู่)" : "ไม่ใช่สแปม — ถอดป้าย null · AI ยังปิดอยู่จนกว่าจะมีคนกดเปิด",
  });
  return { ok: true, spam: false, aiEnabled };
}

export function createConsoleTriageRoutes({ db, now = Date.now, channelLabel = (id) => id, facebookPageIdFor = () => "" }) {
  async function handle(req, res, url, route, ctx) {
    if (!(route[0] === "customers" && route[2] === "spam" && route.length === 3)) return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    if (!hasOperatorCapability(operator, "operations.use")) {
      json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้" });
      return true;
    }
    const customerId = decodeURIComponent(route[1]);
    if (!db.getCustomer(customerId)) {
      json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      return true;
    }
    const body = await readJson(req);
    if (typeof body.spam !== "boolean") {
      json(res, 400, { ok: false, error: "spam ต้องเป็น boolean" });
      return true;
    }
    const result = body.spam
      ? markSpam({ db, customerId, operator: username })
      : unmarkSpam({ db, customerId, operator: username });
    if (!result.ok) {
      json(res, result.status || 400, { ok: false, error: result.error });
      return true;
    }
    const customer = db.getCustomer(customerId);
    json(res, 200, {
      ...result,
      tags: safeListTags(db, customerId),
      triage: roomTriage({ db, customer, now: now(), channelLabel, facebookPageId: facebookPageIdFor(customer) }),
    });
    return true;
  }
  return { handle };
}

export { listWaitingRooms };
