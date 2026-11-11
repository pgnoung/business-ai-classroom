// hotFollowupPush.mjs — push แจ้งทีม "ไม้ต่อจากลูกแพร" วันละ 3 รอบ (29 ก.ย. 2026 · เนื้อหาเป็นไม้ต่อตั้งแต่ 3 พ.ย. 2026)
//
// 3 พ.ย. 2026 (พี่ง้วง): รายการเปลี่ยนจาก "ลูกค้าสนใจสูงที่ลูกแพรตอบเกิน 1 วัน" เป็นไม้ต่อทุกห้อง (relayBaton.mjs)
// และส่งเฉพาะรอบที่ตรงกับเวลาทำการของทีม (จ.–ส. ไม่ใช่วันที่อยู่ในรายการวันหยุด — workClock.mjs)
//
// พี่ง้วง: "ระหว่างขึ้น ให้ push message เข้าแอดมินทุกคน เหมือนเดิม ... สรุปมาว่ามีกี่ห้องที่ HOT แล้ว รอแอดมินไปตอบ ไปขุด
// อัพเดท 09:10, 13:10 และ 18:10 พร้อมทั้งพิมพ์ gentle reminder ให้รู้ว่ารีบคุยน๊า ในตอนที่ลูกค้ากำลังสนใจสุด ๆ
// (ให้รู้ว่าเตือน แต่เอาแบบนุ่มนวล)"
//
// กติกา
// - รายการชุดเดียวกับการ์ดหน้าภาพรวม (consoleAttentionApi.relayList) — ตัวเลขใน push = ตัวเลขบนจอเสมอ
// - ผู้รับ = รายชื่อแจ้งเตือนทีมชุดเดิมทุกสาขา (escalate_notify:*) รวมกันไม่ซ้ำคน ยิงทาง LINE OA หลัก
//   (ห้อง Facebook ก็แจ้งทาง LINE เหมือนแจ้งเตือนอื่น) · 1 ข้อความต่อคนต่อรอบ = นับโควตา push ทีละคน (team_alert)
// - ไม่มีห้องค้าง = ไม่ส่ง (ไม่เปลืองโควตากับข่าวว่าง) · สวิตช์ hot_followup_push_mode = off ปิดทันที (ไม่มีแถว = เปิด)
// - รอบละครั้งเดียว (กุญแจ slot ในตาราง settings — รีสตาร์ทไม่ส่งซ้ำ) และส่งช้าได้ไม่เกิน 30 นาที:
//   เครื่องล่ม/deploy ข้ามรอบไป = ข้ามรอบนั้นเลย ไม่ใช่ส่ง "รอบ 09:10" ตอนบ่ายโมง
// - ข้อความถึงทีม ไม่ใช่ลูกค้า — ไม่บันทึกลงตาราง messages · ร่องรอย = audit hot_followup_push
import { brandText } from "./brand.mjs";
import { createLock } from "./locks.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { DEFAULT_CHANNEL_ID } from "./channels.mjs";
import { notifyIdsFor } from "./notify.mjs";
import { latestSlotMs, parseDigestTimes, bangkokHHMM } from "./digest.mjs";
import { relayList, relayTeamRate } from "./consoleAttentionApi.mjs";
import { isWorkDayAt, readOffDays } from "./workClock.mjs";

export const HOT_FOLLOWUP_PUSH_MODE_KEY = "hot_followup_push_mode";
export const HOT_FOLLOWUP_PUSH_LAST_SLOT_KEY = "hot_followup_push_last_slot";
export const HOT_FOLLOWUP_PUSH_MAX_LATE_MS = 30 * 60_000;
export const HOT_FOLLOWUP_PUSH_LIST_MAX = 8;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NAME_MAX = 30;

export function hotFollowupPushMode(db) {
  try {
    return db.getSetting(HOT_FOLLOWUP_PUSH_MODE_KEY) === "off" ? "off" : "on";
  } catch {
    return "off"; // อ่านไม่ได้ = ไม่ยิง (push เสียโควตาจริง)
  }
}

// ผู้รับทุกสาขารวมกันไม่ซ้ำ — อ่านด้วย notifyIdsFor ตัวเดียวกับแจ้งเตือนทีม (settings ต่อสาขาชนะ env · พัง = ไม่มีผู้รับ)
export function hotFollowupRecipients(db, config = {}, channelIds = []) {
  const ids = new Set();
  for (const channelId of new Set([DEFAULT_CHANNEL_ID, "facebook", ...channelIds.map(String)])) {
    for (const id of notifyIdsFor(db, channelId, config)) ids.add(id);
  }
  return [...ids];
}

// ชื่อที่ลูกค้าตั้งเอง: ตัดอักขระควบคุม/ตัวจัดรูป (เช่น กลับทิศข้อความ) ยุบช่องว่าง/บรรทัดใหม่ แล้วจำกัดความยาว
// — ห้ามปลอมเป็นบรรทัดของระบบในข้อความถึงทีม
const cleanName = (room) => {
  const raw = String(room?.name || "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const name = Array.from(raw).slice(0, NAME_MAX).join("");
  return name || `ลูกค้า …${String(room?.id || "").slice(-4)}`;
};

function span(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < HOUR) return `${Math.max(1, Math.round(value / 60_000))} นาที`;
  if (value < DAY) return `${Math.round(value / HOUR)} ชม.`;
  return `${Math.floor(value / DAY)} วัน`;
}

// ถ้อยคำเตือนนุ่ม ๆ ตามรอบ — เช้าชวนเริ่ม · บ่ายชวนแวะ · เย็นชวนก่อนปิดวัน (อ่านทุกวันต้องไม่ซ้ำคำเดียวทั้งวัน)
export function gentleReminder(slotMs) {
  const hour = new Date(Number(slotMs) + 7 * HOUR).getUTCHours();
  // 30 ก.ย. 2026 (พี่ง้วง): ไม่ใช้คำ เย็น/อุ่น/ร้อน กับลูกค้า — พูดเรื่อง "ความสนใจ" แทน
  if (hour < 12) return "☀️ เช้านี้รีบทักหน่อยน้า ตอนนี้แหละที่ลูกค้ากำลังสนใจสุด ๆ ทักสักประโยคก่อนความสนใจจะลดลงนะคะ 💛";
  if (hour < 17) return "🌤 บ่ายนี้ว่างเมื่อไหร่ แวะทักต่อให้หน่อยน้า ลูกค้ายังสนใจอยู่เลย ได้ยินเสียงคนจริงแล้วจะมั่นใจขึ้นค่ะ ☺️";
  return "🌙 ก่อนปิดวัน ฝากทักต่ออีกนิดนะคะ อย่าปล่อยให้ความสนใจของลูกค้าจางลงข้ามคืนเลยน้า 💛";
}

const RELAY_WORD = { overdue: "เกินเวลา", due: "ควรต่อแล้ว", ontrack: "ยังทัน" };

function roomLine(room, { now, baseUrl }) {
  const fbSoon = room.fbHumanUntil != null && room.fbHumanUntil - now < DAY;
  const where = fbSoon
    ? `FB ตอบได้อีก ${span(room.fbHumanUntil - now)}`
    : room.relayStatus
      ? `${room.channelName || "LINE"} · ${RELAY_WORD[room.relayStatus]} ${span(room.workElapsedMs)}`
      : `${room.channelName || "LINE"} · เงียบ ${span(room.silentMs)}`;
  // เปิดจากลิงก์ = อยู่ในคิว "ไม้ต่อ" เลย พิมพ์คุยเสร็จห้องถัดไปเปิดเอง
  const link = baseUrl ? `\n   👉 ${baseUrl}/#/chat/hotfollow/${encodeURIComponent(String(room.id))}` : "";
  return `· คุณ${cleanName(room)} (${where})${link}`;
}

function rateLine(rate) {
  const r = rate?.relay;
  if (!r || !(r.decided > 0)) return null;
  return `📈 ${rate.windowDays} วันที่ผ่านมา ทีมต่อทันใน 6 ชม. ${r.within6Pct}% · ทันใน 3 ชม. ${r.within3Pct}% (ต่อแล้ว ${r.touched} จาก ${r.decided} ไม้)`;
}

// ข้อความเดียวต่อรอบ (pure — เทสต์ตรงได้) · ≤ 8 ห้องพร้อมลิงก์ ที่เหลือบอกจำนวน
// 30 ก.ย. 2026 (พี่ง้วง): คำเตือน + วิธีทำ + ตัวเลข 7 วัน + ลิงก์ไล่ทักทีละห้อง ขึ้นก่อน แล้วค่อยรายชื่อแต่ละห้องด้านล่าง
// 3 พ.ย. 2026: แบ่งกลุ่ม Facebook ใกล้หมดเวลา → เกินเวลา/ควรต่อแล้ว → ยังทัน (ลำดับเดียวกับรายการบนจอ)
export function buildHotFollowupPushText({ hot, rate = null, slotMs, now = Date.now(), baseUrl = "" }) {
  const rooms = (hot?.rooms || []).slice(0, HOT_FOLLOWUP_PUSH_LIST_MAX);
  const urgent = rooms.filter((room) => room.fbHumanUntil != null && room.fbHumanUntil - now < DAY);
  const late = rooms.filter((room) => !urgent.includes(room) && (room.relayStatus === "overdue" || room.relayStatus === "due"));
  const others = rooms.filter((room) => !urgent.includes(room) && !late.includes(room));
  const counts = hot.overdue != null ? ` (เกินเวลา ${hot.overdue} · ควรต่อแล้ว ${hot.due} · ยังทัน ${hot.ontrack})` : "";
  const lines = [
    brandText(`🤝 ไม้ต่อจากลูกแพร ${hot.total} ห้อง${counts} · รอบ ${bangkokHHMM(slotMs)}`),
    brandText("ลูกแพรคุยจบแล้ว ลูกค้าเงียบมาเกิน 2 ชม. และยังไม่มีทีมเข้าไปคุยต่อค่ะ · เป้าต่อภายใน 3 ชม. เส้นตาย 6 ชม. (เวลาทำการ)"),
    "",
    gentleReminder(slotMs),
    "พิมพ์คุยกับลูกค้าแล้วห้องจะหายจากรายการเอง (คอนโซล / Business Suite / YOLO ก็นับ · กดเสร็จสิ้นไม่นับนะคะ)",
  ];
  const rateText = rateLine(rate);
  if (rateText) lines.push(rateText);
  if (baseUrl) lines.push(`ไล่ต่อทีละห้อง 👉 ${baseUrl}/#/chat/hotfollow`);
  const group = (title, list) => {
    if (!list.length) return;
    lines.push("", title);
    for (const room of list) lines.push(roomLine(room, { now, baseUrl }));
  };
  group("⏳ Facebook ใกล้หมดเวลาตอบ (ตอบใน Business Suite ได้อีกไม่ถึง 1 วัน)", urgent);
  group("⏰ ถึงเวลาต่อแล้ว", late);
  group(urgent.length || late.length ? "ห้องอื่น ๆ" : "รายชื่อ", others);
  if (hot.total > rooms.length) lines.push(`…และอีก ${hot.total - rooms.length} ห้อง`);
  return lines.join("\n");
}

export function createHotFollowupPush({
  config, db, lineRegistry, logger = console, now = Date.now, intervalMs = config?.hotFollowupPushTickMs ?? 60_000,
}) {
  const lock = createLock();
  let timer = null;

  async function runDue() {
    if (!lock.tryAcquire()) return { skipped: true, reason: "run_in_flight" };
    try {
      if (hotFollowupPushMode(db) === "off") return { skipped: true, reason: "switch_off" };
      const times = parseDigestTimes(config.hotFollowupPushTimes);
      if (!times.length) return { skipped: true, reason: "no_valid_times" };
      const t = now();
      const slot = latestSlotMs(t, times);
      let lastSlot = 0;
      try {
        lastSlot = Number(db.getSetting(HOT_FOLLOWUP_PUSH_LAST_SLOT_KEY)) || 0;
      } catch {
        return { skipped: true, reason: "db_error" }; // อ่านสถานะไม่ได้ — ไม่เสี่ยงส่งซ้ำ
      }
      if (slot <= lastSlot) return { skipped: true, reason: "not_due" };
      // วันอาทิตย์/วันหยุด/วันที่ชมพู่ไม่มา (รายการวันหยุดหน้าผลงาน) = ไม่ปลุกทีม · ไม่จองรอบ (ไม่มีอะไรให้กันส่งซ้ำ)
      // รีวิว 3 พ.ย.: ดู "วันทำงาน" ไม่ใช่ "เวลาทำการ" — รอบ 18:10 ก่อนปิดวันอยู่หลัง 18:00 แต่ต้องส่ง
      if (!isWorkDayAt(slot, { offDays: readOffDays(db) })) return { skipped: true, reason: "off_day", slot };
      // จองรอบก่อนทำอะไรต่อ (at-most-once): ล้มกลางทางแล้วลองใหม่ทุกนาที = ทีมได้ข้อความซ้ำ ซึ่งแย่กว่าพลาดรอบเดียว
      db.setSetting(HOT_FOLLOWUP_PUSH_LAST_SLOT_KEY, String(slot));
      if (t - slot > HOT_FOLLOWUP_PUSH_MAX_LATE_MS) {
        logger.log?.(`[hot-followup-push] ข้ามรอบ ${bangkokHHMM(slot)} — เลยเวลามา ${Math.round((t - slot) / 60_000)} นาที (เครื่องเพิ่งเริ่ม/deploy)`);
        return { skipped: true, reason: "too_late", slot };
      }
      const channelLabel = (id) => lineRegistry?.channels?.find((ch) => ch.id === id)?.name || (id === "facebook" ? "Facebook" : "LINE");
      const hot = relayList(db, { now: t, limit: HOT_FOLLOWUP_PUSH_LIST_MAX, channelLabel });
      if (!hot.total) return { skipped: true, reason: "no_rooms", slot };
      const recipients = hotFollowupRecipients(db, config, (lineRegistry?.channels || []).map((ch) => ch.id));
      if (!recipients.length) return { skipped: true, reason: "no_recipients", slot };
      let rate = null;
      try { rate = relayTeamRate(db, { now: t }); } catch { rate = null; }
      const text = buildHotFollowupPushText({ hot, rate, slotMs: slot, now: t, baseUrl: config.consolePublicBaseUrl || "" });
      const lineCh = lineRegistry?.forChannel?.(DEFAULT_CHANNEL_ID);
      if (!lineCh) return { skipped: true, reason: "no_line_client", slot };
      let sent = 0;
      for (const to of recipients) {
        try {
          const result = await lineCh.sendBubbles({ to, bubbles: [{ text }], images: [], purpose: SEND_PURPOSE.teamAlert });
          if (result?.ok) sent += 1;
        } catch (err) {
          // คนหนึ่งส่งไม่ถึงต้องไม่ลากคนอื่น · ไม่ log payload/URL ที่อาจมีข้อมูลส่วนตัว
          logger.debug?.(`hot-followup-push: ส่งถึงผู้รับหนึ่งคนไม่สำเร็จ (${err?.name || "Error"})`);
        }
      }
      try {
        db.addAudit({
          operator: "system", action: "hot_followup_push", target: "ops:hot-followup",
          detail: `รอบ ${bangkokHHMM(slot)} · ไม้ต่อ ${hot.total} ห้อง (เกินเวลา ${hot.overdue || 0} · FB ใกล้หมดเวลา ${hot.urgent || 0}) · ส่งถึงทีม ${sent}/${recipients.length} คน`
            + (rate?.relay?.decided ? ` · ${rate.windowDays} วัน ต่อทัน 6 ชม. ${rate.relay.within6Pct}%` : ""),
        });
      } catch (err) {
        logger.debug?.(`hot-followup-push: บันทึก audit ไม่สำเร็จ (${err?.message || err})`);
      }
      logger.log?.(`[hot-followup-push] รอบ ${bangkokHHMM(slot)} ห้องค้าง ${hot.total} · ส่ง ${sent}/${recipients.length} คน`);
      return { sent, recipients: recipients.length, rooms: hot.total, slot };
    } finally {
      lock.release();
    }
  }

  function start() {
    if (timer || !(intervalMs > 0)) return false;
    timer = setInterval(() => {
      runDue().catch((err) => logger.error?.(`hot-followup-push: ${err?.message || err}`));
    }, intervalMs);
    timer.unref?.();
    logger.log?.(`[hot-followup-push] เดินทุก ${intervalMs}ms (เวลา ${config.hotFollowupPushTimes} — สวิตช์ ${HOT_FOLLOWUP_PUSH_MODE_KEY} เช็คสดทุกรอบ)`);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runDue, start, stop, get running() { return timer !== null; } };
}
