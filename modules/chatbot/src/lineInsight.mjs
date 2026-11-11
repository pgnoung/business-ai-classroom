// lineInsight.mjs — ดึง "สถิติทางการของ LINE" รายวันมาเก็บ (28 ก.ย. 2026)
//
// ทำไม: ข้อความที่ส่งจาก LINE OA Manager (บรอดแคสต์ · ส่งแบบเลือกกลุ่ม · แชทแอดมิน) ไม่ผ่านระบบเราเลย
// ทางเดียวที่จะรู้ว่าโควตาไปกับบรอดแคสต์เท่าไร คือถาม LINE เอง — แผง ROAS เดิมทำได้แค่ "ยอดรวม − ข้อความบอท"
//
// endpoint: GET https://api.line.me/v2/bot/insight/message/delivery?date=YYYYMMDD
//   https://developers.line.biz/en/reference/messaging-api/#get-number-of-delivery-messages (ตรวจ 28 ก.ย. 2026)
//   - date เป็นวันตามเวลาญี่ปุ่น (UTC+9) · LINE นับเสร็จ "ประมาณหนึ่งวัน" หลังจบวัน (ระหว่างนั้นตอบ unready)
//   - จำกัด 60 คำขอ/ชม. ต่อ channel → รอบหนึ่งยิงไม่เกิน MAX_REQUESTS_PER_RUN ต่อ OA (รอบละชั่วโมง)
//   - ช่องที่ได้: broadcast · targeting · stepMessage · autoResponse · welcomeResponse · chat ·
//     apiBroadcast · apiPush · apiMulticast · apiNarrowcast · apiReply (+ ช่องของบริการเสริมบางตัว)
//
// จังหวะ: ทุก LINE_INSIGHT_TICK_MS (ค่าเริ่มต้นชั่วโมงละรอบ) หาวันที่ยังไม่ ready ของเดือนนี้ + 7 วันล่าสุด
// (เผื่อวันท้ายเดือนก่อนที่ยังไม่นิ่งตอนข้ามเดือน) ใหม่สุดก่อน · วันที่เพิ่งลองไม่ถึง RETRY_MS ข้ามไปก่อน
// บูตครั้งแรกจึงเติมทั้งเดือนภายในไม่กี่รอบ หลังจากนั้นเหลือวันละคำขอเดียว (เมื่อวาน)
// รอบเดียวกันเก็บภาพโควตาล่าสุด (quota + consumption) ลง settings ให้แชทเจ้าของอ่านได้โดยไม่ต้องยิง LINE เอง
//
// เงียบเสมอ: ยังไม่พร้อม/ล้ม = จดสถานะไว้ในแถวแล้วรอรอบหน้า ไม่ปลุกใคร ไม่มี error ถึงเส้นทางแชท
// arm เฉพาะ instance ที่ยิง LINE จริง (LINE_LIVE_SEND=true และไม่ใช่ mock) — ปิดได้ด้วย LINE_INSIGHT_TICK_MS=0
import { createLock } from "./locks.mjs";

const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;
export const INSIGHT_LOOKBACK_DAYS = 7;
// รอบละไม่เกิน 20 คำขอต่อ OA: บูตแรกเติมทั้งเดือนเสร็จในสองรอบ (~1 ชม.) และต่ำกว่าเพดาน 60/ชม. เสมอ
// (วันที่เดียวกันถูกลองซ้ำได้ไม่ถี่กว่า INSIGHT_RETRY_MS · เจอ 429 = พักทั้ง OA ชั่วโมงหนึ่ง)
export const MAX_REQUESTS_PER_RUN = 20;
export const INSIGHT_RETRY_MS = 3 * 3_600_000;
export const INSIGHT_MAX_ATTEMPTS = 12;
const RATE_LIMIT_PAUSE_MS = 60 * 60_000;
const AUTH_PAUSE_MS = 6 * 3_600_000;
const FIRST_RUN_DELAY_MS = 90_000;
export const QUOTA_SNAPSHOT_PREFIX = "line_quota_snapshot:";
const FINAL_STATUSES = new Set(["ready", "out_of_service"]);
// เหตุระดับการตั้งค่า (ไม่ใช่ปัญหาของวันนั้น) — ไม่จดลงแถว เลิกทั้ง OA ในรอบนี้
const CONFIG_REASONS = new Set(["live_send_disabled", "no_access_token", "not_line"]);

/** YYYYMMDD ตามเวลาญี่ปุ่น — รูปวันที่ LINE ใช้ */
export function jstDateKey(ms) {
  return new Date(Number(ms) + JST_OFFSET_MS).toISOString().slice(0, 10).replaceAll("-", "");
}

/** เวลาเริ่มวันของ LINE (เที่ยงคืนญี่ปุ่น) เป็น epoch ms */
export function jstDayStartMs(dateKey) {
  const text = String(dateKey);
  return Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8))) - JST_OFFSET_MS;
}

/**
 * วันที่ต้องยิงรอบนี้ (ใหม่สุดก่อน) — ฟังก์ชันบริสุทธิ์ ทดสอบได้โดยไม่มีนาฬิกาจริง
 * @param {{nowMs:number, rows:Array<{date:string,status:string,attempts:number,last_attempt_at:number}>}} input
 */
export function insightDatesToFetch({ nowMs, rows = [], lookbackDays = INSIGHT_LOOKBACK_DAYS,
  retryMs = INSIGHT_RETRY_MS, maxAttempts = INSIGHT_MAX_ATTEMPTS } = {}) {
  const byDate = new Map(rows.map((row) => [String(row.date), row]));
  const monthStart = `${jstDateKey(nowMs).slice(0, 6)}01`;
  const lookback = jstDateKey(nowMs - lookbackDays * DAY_MS);
  const oldest = monthStart < lookback ? monthStart : lookback;
  const due = [];
  for (let at = nowMs - DAY_MS; ; at -= DAY_MS) {
    const date = jstDateKey(at);
    if (date < oldest) break;
    const row = byDate.get(date);
    if (!row) { due.push(date); continue; }
    if (FINAL_STATUSES.has(row.status)) continue;
    if (Number(row.attempts) >= maxAttempts) continue;
    if (nowMs - Number(row.last_attempt_at || 0) < retryMs) continue;
    due.push(date);
  }
  return due;
}

// ช่อง LINE ของ instance (Facebook ไม่มีสถิตินี้) — channel ที่ไม่ได้ปิดไว้เท่านั้น
export function lineChannelsOf(channels = []) {
  return (Array.isArray(channels) ? channels : []).filter((ch) => ch && ch.provider !== "facebook" && ch.active !== false);
}

export function createLineInsightSync({ config, db, lineRegistry, channels = [], logger = console, now = Date.now } = {}) {
  const lock = createLock();
  const pausedUntil = new Map();
  let timer = null;
  let firstTimer = null;
  let lastRun = null;

  async function syncChannel(channel, summary) {
    const client = lineRegistry?.forChannel?.(channel.id);
    if (typeof client?.getDeliveryInsight !== "function") return;
    if ((pausedUntil.get(channel.id) || 0) > now()) { summary.paused += 1; return; }
    const t = now();
    const fromDate = jstDateKey(t - 62 * DAY_MS);
    const rows = db.lineInsightRows({ fromDate, toDate: jstDateKey(t), channelIds: [channel.id] });
    for (const date of insightDatesToFetch({ nowMs: t, rows }).slice(0, MAX_REQUESTS_PER_RUN)) {
      const result = await client.getDeliveryInsight({ date });
      if (result?.ok) {
        db.saveLineInsight({ channelId: channel.id, date, status: result.status, counts: result.counts, at: now() });
        summary[result.status === "ready" ? "ready" : "unready"] += 1;
        continue;
      }
      if (CONFIG_REASONS.has(result?.reason)) { summary.skipped += 1; break; }
      const httpStatus = Number(result?.httpStatus) || 0;
      db.saveLineInsight({
        channelId: channel.id, date, status: "error",
        error: `${result?.reason || "unknown"}${httpStatus ? `_${httpStatus}` : ""}`, at: now(),
      });
      summary.errors += 1;
      if (httpStatus === 429) { pausedUntil.set(channel.id, now() + RATE_LIMIT_PAUSE_MS); break; }
      if (httpStatus === 401 || httpStatus === 403) { pausedUntil.set(channel.id, now() + AUTH_PAUSE_MS); break; }
    }
    // ภาพโควตาล่าสุด — แชทเจ้าของ (Telegram) อ่านจากตรงนี้ เพราะตัวค้นของแชทเป็นแบบ synchronous
    const quota = typeof client.getQuota === "function" ? await client.getQuota({ force: true }) : null;
    if (quota && (quota.type === "limited" || quota.type === "none") && Number.isFinite(Number(quota.totalUsage))) {
      db.setSetting(`${QUOTA_SNAPSHOT_PREFIX}${channel.id}`, JSON.stringify({
        type: quota.type, value: quota.type === "limited" ? Number(quota.value) : null,
        totalUsage: Number(quota.totalUsage), at: now(),
      }));
      summary.quota += 1;
    }
  }

  /** หนึ่งรอบ — คืนสรุปสั้น ๆ ไม่โยน error (ล้มกลางทาง = log แล้วรอรอบหน้า) */
  async function runOnce() {
    if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
    const summary = { channels: 0, ready: 0, unready: 0, errors: 0, skipped: 0, paused: 0, quota: 0 };
    try {
      for (const channel of lineChannelsOf(channels)) {
        summary.channels += 1;
        try {
          await syncChannel(channel, summary);
        } catch (err) {
          summary.errors += 1;
          logger.warn?.(`lineInsight: ดึงสถิติ LINE ของ ${channel.id} ไม่สำเร็จ (${err?.message || err}) — รอรอบหน้า`);
        }
      }
      lastRun = { at: now(), ...summary };
      if (summary.ready || summary.errors) {
        logger.log?.(`[lineInsight] ได้สถิติ ${summary.ready} วัน · ยังไม่พร้อม ${summary.unready} · ล้ม ${summary.errors}`);
      }
      return summary;
    } finally {
      lock.release();
    }
  }

  function armed() {
    return Number(config?.lineInsightTickMs) > 0 && config?.lineLiveSend === true && !config?.lineMockUrl
      && lineChannelsOf(channels).length > 0;
  }

  function start() {
    if (timer || !armed()) return false;
    const tick = () => { runOnce().catch((err) => logger.error?.(`lineInsight: ${err?.message || err}`)); };
    firstTimer = setTimeout(tick, FIRST_RUN_DELAY_MS);
    firstTimer.unref?.();
    timer = setInterval(tick, Number(config.lineInsightTickMs));
    timer.unref?.(); // ไม่ค้ำ process ตอน shutdown
    return true;
  }

  function stop() {
    if (firstTimer) clearTimeout(firstTimer);
    if (timer) clearInterval(timer);
    firstTimer = null;
    timer = null;
  }

  return {
    runOnce, start, stop, armed,
    get running() { return timer !== null; },
    get lastRun() { return lastRun; },
  };
}
