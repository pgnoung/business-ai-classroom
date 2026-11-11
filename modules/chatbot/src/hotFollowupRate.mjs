// hotFollowupRate.mjs — ตัวชี้วัด "ทีมทักต่อลูกค้าร้อนกี่ %" (29 ก.ย. 2026)
//
// พี่ง้วง: "ปรับ logic ให้เข้มข้น ว่าแอดมินจริง ๆ ได้ขุดลูกค้าบ่อยมั้ย % rate กี่ % ... อยากให้แอดมินมีส่วนร่วมในแชทด้วย"
// ตรวจของจริง 29 ก.ย. (30 วัน): ห้อง HOT ที่ทีมเคยพิมพ์ "สักครั้ง" มี 50% ดูเหมือนดี แต่ตอนที่ลูกแพรตอบแล้ว
// ลูกค้าเงียบเกินวัน ทีมกลับไปทักต่อแค่ 7 จาก 152 ครั้ง (5%) — ตัวเลขแรกจึงหลอก ตัวชี้วัดต้องวัด "หลัง AI จบ"
//
// นิยามเดียวกับรายการ "ลูกค้าร้อนรอทีมทักต่อ" (dbAttention.attentionHotQuietCandidates) แต่นับย้อนหลังเป็นกระแส:
//   เข้ารายการ = ลูกค้าพูด (ไม่นับ ขอบคุณ/สติกเกอร์/แฮชแท็ก) → คำตอบจริงข้อแรกเป็นของลูกแพร (ข้อความทวง/บรอดแคสต์
//                ไม่นับว่าตอบ) → ครบ 1 วันโดยลูกค้าไม่ถามต่อและยังไม่มีคนทัก (กดเสร็จสิ้นไม่มีผล — พี่ง้วง 30 ก.ย.)
//                ตอนนั้นคะแนนของห้องเป็น 8+ และยังไม่ได้ติดป้าย customer (ซื้อแล้วคนละงาน)
//   ห้องที่ยังค้างแต่ตอนนี้หลุดจากรายการไปแล้ว (คะแนนลดต่ำกว่า 8 / ซื้อแล้ว) ไม่นับ — ไม่ใช่ห้องที่ทีมพลาด
//   ผลของห้องที่เข้ารายการในช่วง windowMs (นับห้องละครั้ง ใช้รอบล่าสุดในช่วง):
//     touched  = คนจริงทักต่อก่อนลูกค้าจะกลับมาเอง   ← ตัวตั้งของ %
//     cameBack = ลูกค้ากลับมาพูดเองก่อนมีใครทัก
//     lost     = Facebook เลย 7 วันแล้ว ตอบไม่ได้อีก
//     pending  = ยังค้างอยู่ในรายการ
// ไม่มีเนื้อความลูกค้าในข้อมูลที่รับเข้า — มีแค่เวลา ทิศทาง และ "คนหรือไม่"
import { isAckOnlyInbound } from "./waitingRooms.mjs";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const HOT_FOLLOWUP_ENTRY_MS = DAY;
export const HOT_FOLLOWUP_RATE_WINDOW_MS = 7 * DAY;
export const HOT_FOLLOWUP_FB_WINDOW_MS = 7 * DAY;

function scoreAt(list, t, fallback) {
  let score = null;
  for (const row of list) {
    if (Number(row.created_at) <= t + HOUR) score = Number(row.score);
    else break;
  }
  return score ?? (Number.isFinite(Number(fallback)) ? Number(fallback) : null);
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

function isAck(message) {
  let emojis = null;
  try { emojis = message.emojis_json ? JSON.parse(message.emojis_json) : null; } catch { emojis = null; }
  return isAckOnlyInbound({ type: message.type || "text", text: message.text || "", emojis });
}

const isBuyerNow = (room, inAt) => ["paid", "won"].includes(String(room.deal_status || ""))
  || (Number(room.customer_tag_at) || 0) > inAt;

// รอบล่าสุดของห้องนี้ที่ "เข้ารายการ" ภายในช่วง [from, now] — null = ไม่มี
function latestEpisode(room, msgs, scores, { now, from, minScore }) {
  let found = null;
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (m.direction !== "in" || isAck(m)) continue;
    const inAt = Number(m.created_at);
    let nextIn = null;
    let lastAnyIn = inAt; // ขอบคุณ/สติกเกอร์ก็ต่อเวลาตอบของ Facebook
    const outs = [];
    for (let j = i + 1; j < msgs.length; j += 1) {
      const x = msgs[j];
      if (x.direction === "in") {
        if (!isAck(x)) { nextIn = Number(x.created_at); break; }
        lastAnyIn = Number(x.created_at);
      } else outs.push(x);
    }
    const first = outs.find((o) => Number(o.human) === 1 || Number(o.reactive) === 1);
    if (!first || Number(first.human) === 1) continue; // คนตอบเองตั้งแต่แรก / ยังไม่มีใครตอบ (= คิวรอตอบ)
    const enteredAt = Number(first.created_at) + HOT_FOLLOWUP_ENTRY_MS;
    if (enteredAt > now || enteredAt < from) continue;
    if (nextIn !== null && nextIn <= enteredAt) continue; // ลูกค้าถามต่อภายในวันนั้น
    if (outs.some((o) => Number(o.human) === 1 && Number(o.created_at) <= enteredAt)) continue; // คนเข้ามาทันในวันนั้น
    if ((scoreAt(scores, inAt, room.last_score) ?? 0) < minScore) continue;
    const tagAt = Number(room.customer_tag_at) || 0;
    if (tagAt > 0 && tagAt <= inAt) continue; // ซื้อแล้วก่อนหน้า — ดูแลลูกค้าเก่าเป็นอีกงาน
    const touch = outs.find((o) => Number(o.human) === 1 && Number(o.created_at) > enteredAt);
    const isFacebook = String(room.channel_id || "") === "facebook";
    let outcome = "pending";
    if (touch) outcome = "touched";
    else if (nextIn !== null) outcome = "cameBack";
    else if (isFacebook && lastAnyIn + HOT_FOLLOWUP_FB_WINDOW_MS <= now) outcome = "lost";
    // ยังค้างแต่ตอนนี้หลุดรายการแล้ว (คะแนนลด/ซื้อแล้ว) = ไม่ใช่ห้องที่ทีมพลาด ไม่นับทั้งตัวตั้งตัวหาร
    else if ((Number(room.last_score) || 0) < minScore || isBuyerNow(room, inAt)) continue;
    found = { enteredAt, outcome, touchLagMs: touch ? Number(touch.created_at) - enteredAt : null };
  }
  return found;
}

export function summarizeHotFollowupRate({ rooms = [], messages = [], scores = [] } = {}, {
  now = Date.now(), windowMs = HOT_FOLLOWUP_RATE_WINDOW_MS, minScore = 8,
} = {}) {
  const byRoomMsgs = groupBy(messages, "customer_id");
  const byRoomScores = groupBy(scores, "customer_id");
  const from = now - windowMs;
  const out = { windowDays: Math.round(windowMs / DAY), entered: 0, touched: 0, cameBack: 0, lost: 0, pending: 0, ratePct: null };
  for (const room of rooms) {
    const episode = latestEpisode(room, byRoomMsgs.get(String(room.id)) || [], byRoomScores.get(String(room.id)) || [], { now, from, minScore });
    if (!episode) continue;
    out.entered += 1;
    out[episode.outcome] += 1;
  }
  out.ratePct = out.entered ? Math.round((out.touched / out.entered) * 100) : null;
  return out;
}
