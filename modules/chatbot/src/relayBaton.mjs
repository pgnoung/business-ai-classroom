// relayBaton.mjs — "ไม้ต่อจากลูกแพร": ลูกแพรคุยจบแล้ว ชมพู่ต้องเข้าไปคุยต่อ (คำสั่งพี่ง้วง 3 พ.ย. 2026)
//
// พี่ง้วง: "AI ลูกแพร คือผู้ช่วย แต่ ชมพู่ แอดมินจริง คือคนหลัก แปลว่า สุดท้าย AI พิมพ์จบแล้ว ชมพู่ ใน 3-6 ชม
//          ชมพู่ ควรไปตอบต่อจาก AI" · เคาะ 3 พ.ย.: ทุกห้อง · นับเวลาทำการ จันทร์–เสาร์ (workClock.mjs)
//          · เริ่มนับว่าคุยจบเมื่อลูกค้าเงียบ 2 ชม. ในเวลาทำการ
// สืบทอดจาก hotFollowupRate.mjs (29 ก.ย. — ของจริง: ทีมทักต่อหลังลูกแพรจบแค่ 5%) แต่ต่างกันสามข้อ:
//   ทุกห้อง (เดิมคะแนน 8+) · เปิดไม้หลัง 2 ชม.ทำการ (เดิม 1 วันนาฬิกาจริง) · มีเป้า 3 ชม. และเส้นตาย 6 ชม.
//
// นิยาม (ทุกตัวเลขวัดเป็น "เวลาทำการ" นับจากข้อความสุดท้ายของลูกแพรในรอบนั้น = aiEnd):
//   รอบ     = ลูกค้าพูดเรื่องจริง (ไม่นับ ขอบคุณ/สติกเกอร์/แฮชแท็ก) → คนแรกที่ตอบคือลูกแพร (ข้อความทวง/บรอดแคสต์ไม่นับว่าตอบ)
//   เปิดไม้  = aiEnd + 2 ชม. โดยลูกค้ายังไม่พูดเรื่องใหม่ (ลูกค้าพูดต่อก่อนนั้น = บทสนทนายังเดิน ไม่ใช่ไม้)
//   ปิดไม้  = คนจริงพิมพ์ในห้อง (คอนโซล / Business Suite / YOLO) — กดเสร็จสิ้นไม่นับ (กติกาเดียวกับ 30 ก.ย.)
//            คนพิมพ์ก่อนครบ 2 ชม. = ไม้ยังไม่เปิด ไม่นับเป็นไม้ · ลูกค้าพิมพ์รัว ๆ ก่อนมีคำตอบ = รอบเดียว
//   ผล      within3 ต่อภายใน 3 ชม. · within6 ภายใน 6 ชม. · late ต่อแต่เกิน 6 ชม.
//           cameBack ลูกค้ากลับมาเองก่อนเส้นตาย (ไม่นับเป็นพลาด) · missed เลยเส้นตายแล้วยังไม่มีคน
//           lost Facebook เลย 7 วัน ตอบไม่ได้อีก · pending เปิดแล้วยังไม่ถึงเส้นตาย
// ไม่มีเนื้อความลูกค้าในผลลัพธ์ — มีแค่จำนวน
import { isAckOnlyInbound } from "./waitingRooms.mjs";
import { addWorkMs, workMsBetween } from "./workClock.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const RELAY_OPEN_WORK_MS = 2 * HOUR;
export const RELAY_TARGET_WORK_MS = 3 * HOUR;
export const RELAY_DEADLINE_WORK_MS = 6 * HOUR;
export const RELAY_RATE_WINDOW_MS = 7 * DAY;
// รายการบนจอ: ห้องที่ลูกแพรจบเกิน 7 วันแล้วหลุดจากรายการ (ยกเว้นคะแนน 8+ ที่ค้างจนกว่าคนจะทัก — พี่ง้วง 29 ก.ย.)
export const RELAY_LIST_MAX_AGE_MS = 7 * DAY;
export const RELAY_KEEP_SCORE = 8;
export const RELAY_FB_WINDOW_MS = 7 * DAY;
// 3 พ.ย. 2026 (พี่ง้วง "นับตั้งแต่วันเปิดใช้"): รายการบนจอ/push เปิดไม้เฉพาะรอบที่ลูกแพรจบหลังเวลานี้ (ms)
// — กองค้างก่อนวันเปิดไม่ขึ้นรายการ แต่ยังอยู่ในตัวเลขหน้าผลงานครบ · ห้องคะแนน 8+ ค้างต่อตามกติกา 29 ก.ย. เหมือนเดิม
// ตัวปล่อยเขียนค่านี้ตอนขึ้นระบบ · ไม่มีแถว/ค่าเพี้ยน = ไม่ตัด (เห็นเกินดีกว่าซ่อนห้อง)
export const RELAY_START_KEY = "relay_start_at";
export function readRelayStartAt(db) {
  try {
    const value = Math.trunc(Number(db.getSetting(RELAY_START_KEY)));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}
// ลูกแพรตอบในไม่กี่วินาที — ข้อความที่เพิ่งเข้าไม่ถึง 3 นาทียังไม่ใช่ "ไม่มีใครตอบ" (กติกาเดียวกับคิวรอตอบ)
const REPLY_GRACE_MS = 3 * MIN;

/** สถานะไม้จากเวลาทำการที่ผ่านไปหลังลูกแพรจบ — ontrack ≤ 3 ชม. < due ≤ 6 ชม. < overdue (ขอบเดียวกับผล within3/within6) */
export function relayStatus(workElapsedMs) {
  const ms = Number(workElapsedMs) || 0;
  if (ms > RELAY_DEADLINE_WORK_MS) return "overdue";
  if (ms > RELAY_TARGET_WORK_MS) return "due";
  return "ontrack";
}

function isAck(message) {
  let emojis = null;
  try { emojis = message.emojis_json ? JSON.parse(message.emojis_json) : null; } catch { emojis = null; }
  return isAckOnlyInbound({ type: message.type || "text", text: message.text || "", emojis });
}

const isHuman = (m) => Number(m.human) === 1;
const isAiReply = (m) => !isHuman(m) && Number(m.reactive) === 1;

/**
 * แยกห้องเป็นรอบ ๆ — คืนทุกรอบที่ลูกค้าพูดเรื่องจริง (ใช้ทั้งอัตราตอบและไม้ต่อ)
 * msgs เรียงเวลาแล้ว: { direction, created_at, human, reactive, type?, text?, emojis_json? }
 */
export function conversationTurns(msgs = []) {
  const turns = [];
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (m.direction !== "in" || isAck(m)) continue;
    let nextIn = null;
    let lastAnyIn = Number(m.created_at); // ขอบคุณ/สติกเกอร์ก็ต่อเวลาตอบของ Facebook
    const outs = [];
    for (let j = i + 1; j < msgs.length; j += 1) {
      const x = msgs[j];
      if (x.direction === "in") {
        if (!isAck(x)) { nextIn = Number(x.created_at); break; }
        lastAnyIn = Number(x.created_at);
      } else outs.push(x);
    }
    // รีวิว 3 พ.ย.: ลูกค้าพิมพ์รัว ๆ หลายข้อความแล้วลูกแพรตอบครั้งเดียว = รอบเดียว ไม่ใช่ "ไม่มีใครตอบ" หลายรอบ
    const prev = turns[turns.length - 1];
    if (prev && !prev.outs.length && prev.nextIn === Number(m.created_at)) {
      turns[turns.length - 1] = { inAt: prev.inAt, nextIn, lastAnyIn, outs };
      continue;
    }
    turns.push({ inAt: Number(m.created_at), nextIn, lastAnyIn, outs });
  }
  return turns;
}

/**
 * ไม้ของรอบหนึ่ง — null = รอบนี้ไม่ใช่ไม้ (คนตอบเองตั้งแต่แรก / ยังไม่มีใครตอบ / ลูกค้าคุยต่อก่อนครบ 2 ชม. / ยังไม่ถึงเวลาเปิด)
 */
export function relayEpisode(turn, { now, offDays = new Set(), isFacebook = false } = {}) {
  const first = turn.outs.find((o) => isHuman(o) || Number(o.reactive) === 1);
  if (!first || isHuman(first)) return null;
  const touch = turn.outs.find(isHuman) || null;
  const touchAt = touch ? Number(touch.created_at) : null;
  const aiOuts = turn.outs.filter((o) => isAiReply(o) && (touchAt == null || Number(o.created_at) <= touchAt));
  const aiEnd = Math.max(...aiOuts.map((o) => Number(o.created_at)));
  const openAt = addWorkMs(aiEnd, RELAY_OPEN_WORK_MS, { offDays });
  const deadlineAt = addWorkMs(aiEnd, RELAY_DEADLINE_WORK_MS, { offDays });
  const base = { aiEnd, openAt, deadlineAt };
  if (touch) {
    // รีวิว 3 พ.ย.: คนเข้ามาคุยก่อนครบ 2 ชม. = ลูกค้ายังไม่ได้เงียบ ไม้ยังไม่เคยเปิด — ไม่นับเป็น "ต่อทัน" ฟรี ๆ
    if (touchAt < openAt) return null;
    const lagWorkMs = workMsBetween(aiEnd, touchAt, { offDays });
    const outcome = lagWorkMs <= RELAY_TARGET_WORK_MS ? "within3" : lagWorkMs <= RELAY_DEADLINE_WORK_MS ? "within6" : "late";
    return { ...base, outcome, lagWorkMs, eventAt: Math.min(openAt, touchAt) };
  }
  const { nextIn } = turn;
  if (nextIn != null && nextIn < openAt) return null; // ลูกค้ายังคุยกับลูกแพรอยู่
  if (nextIn != null) return { ...base, outcome: nextIn <= deadlineAt ? "cameBack" : "missed", lagWorkMs: null, eventAt: openAt };
  if (openAt > now) return null;
  if (now <= deadlineAt) return { ...base, outcome: "pending", lagWorkMs: null, eventAt: openAt };
  const fbClosed = isFacebook && turn.lastAnyIn + RELAY_FB_WINDOW_MS <= now;
  return { ...base, outcome: fbClosed ? "lost" : "missed", lagWorkMs: null, eventAt: openAt };
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const id = String(row[key]);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

/**
 * ตัวชี้วัดไม้ต่อ + อัตราตอบ + ห้องที่ลูกแพรคุยคนเดียว ในช่วง windowMs ล่าสุด
 * data = { rooms: [{ id, channel_id, ever_human, quiet_yellow }], messages: [...เรียง customer_id, created_at] }
 */
export function summarizeRelay({ rooms = [], messages = [] } = {}, {
  now = Date.now(), windowMs = RELAY_RATE_WINDOW_MS, offDays = new Set(),
} = {}) {
  const byRoom = groupBy(messages, "customer_id");
  const from = now - windowMs;
  const relay = { within3: 0, within6: 0, late: 0, cameBack: 0, missed: 0, lost: 0, pending: 0 };
  const lags = [];
  const reply = { turns: 0, byAi: 0, byHuman: 0, unanswered: 0 };
  const aiAlone = { rooms: 0, roomsWithAi: 0 };
  for (const room of rooms) {
    // ห้องเหลืองนิ่ง = ตั้งใจไม่ตามต่อ (พี่ง้วง 5 ต.ค.) — ไม่ขึ้นรายการไม้ จึงไม่นับในอัตราด้วย
    if (Number(room.quiet_yellow) === 1) continue;
    const msgs = byRoom.get(String(room.id)) || [];
    const isFacebook = String(room.channel_id || "") === "facebook";
    let aiRepliedInWindow = false;
    for (const turn of conversationTurns(msgs)) {
      if (turn.inAt >= from && turn.inAt <= now - REPLY_GRACE_MS) {
        const first = turn.outs.find((o) => isHuman(o) || Number(o.reactive) === 1);
        reply.turns += 1;
        if (!first) reply.unanswered += 1;
        else if (isHuman(first)) reply.byHuman += 1;
        else reply.byAi += 1;
      }
      if (turn.outs.some((o) => isAiReply(o) && Number(o.created_at) >= from)) aiRepliedInWindow = true;
      const episode = relayEpisode(turn, { now, offDays, isFacebook });
      if (!episode || episode.eventAt < from || episode.eventAt > now) continue;
      relay[episode.outcome] += 1;
      if (episode.lagWorkMs != null) lags.push(episode.lagWorkMs);
    }
    if (aiRepliedInWindow) {
      aiAlone.roomsWithAi += 1;
      if (Number(room.ever_human) !== 1) aiAlone.rooms += 1;
    }
  }
  const touched = relay.within3 + relay.within6 + relay.late;
  // ตัวหาร = ไม้ที่ตัดสินแล้ว · ลูกค้ากลับมาเองก่อนเส้นตาย และไม้ที่ยังไม่ถึงเส้นตาย ไม่นับ (แต่โชว์จำนวนเสมอ)
  const decided = touched + relay.missed + relay.lost;
  return {
    windowDays: Math.round(windowMs / DAY),
    relay: {
      ...relay,
      opened: decided + relay.cameBack + relay.pending,
      decided,
      touched,
      within3Pct: pct(relay.within3, decided),
      within6Pct: pct(relay.within3 + relay.within6, decided),
      medianLagWorkMs: median(lags),
    },
    reply: {
      ...reply,
      answeredPct: pct(reply.turns - reply.unanswered, reply.turns),
      humanFirstPct: pct(reply.byHuman, reply.turns - reply.unanswered),
    },
    aiAlone,
  };
}
