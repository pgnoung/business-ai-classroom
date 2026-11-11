// digest.mjs — G7.1: Owner Daily Digest — สรุปหน้าร้าน push ถึง "เจ้าของ" ทาง LINE
// (แบบแผนเดียวกับที่พิสูจน์แล้วในบริษัท: อาหวัง/Team Pulse ส่ง digest เข้า LINE เจ้าของ)
//
// กติกา:
// - scheduler แบบ canary (SPEC ข้อ 5): setInterval + unref + synchronous lock
//   (release ใน finally) — tick ละครั้งเช็คว่า "ถึงเวลารอบส่ง" หรือยัง
// - fail-closed หลายชั้น: ไม่มี DIGEST_LINE_USER_ID = ปิดสนิททุกกรณี;
//   DIGEST_ENABLED default false; สวิตช์ runtime ใน DB (digest_enabled) ชนะ env
// - เวลารอบส่ง DIGEST_TIMES (เวลาไทย, comma list HH:MM — default 08:30,20:00)
//   ส่งได้มากสุดครั้งเดียวต่อ slot (กุญแจ = epoch ของ slot ใน digest_last_slot)
// - เนื้อหา: ตัวเลขจาก DB เท่านั้น (ไม่มี LLM call) ภาษาไทยกระชับ <= 5 bubbles
//   ช่วงสรุป = ตั้งแต่ digest ที่ "ส่งจริง" ครั้งก่อน (setting digest_last_sent)
// - ไม่มีความเคลื่อนไหวเลยตั้งแต่รอบก่อน = ข้ามทั้งรอบ (log skipped_no_activity)
// - ข้อความถึง "เจ้าของ" ไม่ใช่ลูกค้า — ห้าม insert ตาราง messages; ร่องรอย =
//   settings digest_last_sent/digest_last_slot + audit row `digest_sent` เท่านั้น
// - ยิงด้วย client/token ของ channel ที่เลือก (DIGEST_CHANNEL_ID default "default")
import { createLock } from "./locks.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { scorerSuggestionsEnabled } from "./scorerSuggestions.mjs";
import { bangkokDayStartMs } from "./db.mjs";
import { loadModelPricing, pricingById, summarizeUsage } from "./modelPricing.mjs";
import { catalogOutOfPrompt, knowledgeUsage } from "./knowledgePack.mjs";

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const DEFAULT_TICK_MS = 60_000;
const MAX_BUBBLES = 5;
const NEXT_MOVE_MAX = 90;

export const DIGEST_ENABLED_KEY = "digest_enabled";
export const DIGEST_LAST_SENT_KEY = "digest_last_sent";
export const DIGEST_LAST_SLOT_KEY = "digest_last_slot";

// "08:30,20:00" -> [510, 1200] (นาทีของวันเวลาไทย, unique เรียงน้อย -> มาก)
// รายการที่รูปแบบผิดถูกข้าม — ไม่เหลือรายการดี = [] (digest ไม่เดิน)
export function parseDigestTimes(raw) {
  const minutes = new Set();
  for (const part of String(raw ?? "").split(",")) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(part.trim());
    if (m) minutes.add(Number(m[1]) * 60 + Number(m[2]));
  }
  return [...minutes].sort((a, b) => a - b);
}

function bangkokDayStart(tsMs) {
  return Math.floor((tsMs + BANGKOK_OFFSET_MS) / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS;
}

// epoch ms ของรอบส่งล่าสุดที่ "ถึงเวลาแล้ว" (<= nowMs) จากรายการเวลา — [] = null
export function latestSlotMs(nowMs, minutes) {
  if (!minutes?.length) return null;
  const dayStart = bangkokDayStart(nowMs);
  let latest = null;
  for (const m of minutes) {
    let occ = dayStart + m * MIN_MS;
    if (occ > nowMs) occ -= DAY_MS; // ยังไม่ถึงรอบนี้วันนี้ = รอบเดียวกันของเมื่อวาน
    if (latest === null || occ > latest) latest = occ;
  }
  return latest;
}

// รอบส่งก่อนหน้า slot ที่กำหนด — ใช้เป็นจุดเริ่มช่วงสรุปตอนยังไม่เคยส่งเลย
export function previousSlotMs(slotMs, minutes) {
  return latestSlotMs(slotMs - 1, minutes);
}

export function bangkokHHMM(tsMs) {
  const d = new Date(Number(tsMs) + BANGKOK_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// สวิตช์ 2 ชั้นแบบเดียวกับ follow-up: ค่า runtime ใน DB ชนะ env default
// อ่าน DB พัง = fail-closed (ปิด)
export function digestGlobalEnabled({ db, config }) {
  try {
    const stored = db.getSetting(DIGEST_ENABLED_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    return false;
  }
  return config.digestEnabled === true;
}

const nf = (n) => Number(n || 0).toLocaleString("th-TH");
const baht = (n) => `฿${Number(n || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 })}`;

// ประกอบ bubbles (pure — เทสต์ตรงได้) — การันตี <= 5 bubbles โดยโครงสร้าง
// สรุปเช้ากับสรุปค่ำทำหน้าที่ต่างกัน — ถ้าส่งตัวเลขชุดเดียวกันวันละสองรอบ
// อ่านสองวันก็เลิกอ่าน (คำสั่งเจ้าของ 2026-08-28 "2 อันควรเป็น useful insight จริง ๆ")
//
//   เช้า 08:30 = "วันนี้ต้องทำอะไร"  — เรื่องที่ค้างคาคนอื่นอยู่ ต้องมีคนลงมือ
//   ค่ำ 20:00  = "วันนี้เกิดอะไรขึ้น" — ผลลัพธ์ ความผิดปกติ และอะไรค้างข้ามคืน
//
// กติกาที่ทำให้มันยังน่าอ่านในเดือนที่สาม: บรรทัดไหนเป็นศูนย์และไม่ต้องทำอะไร ให้ตัดทิ้ง
// ทุกบรรทัดที่โผล่มาต้องแปลว่ามีอะไรจริง ไม่ใช่ช่องว่างที่ต้องเติมให้ครบฟอร์ม
function hoursAgo(ms, nowMs) {
  const h = (Number(nowMs) - Number(ms)) / 3_600_000;
  if (!Number.isFinite(h) || h < 0) return "";
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} นาที` : `${Math.round(h)} ชม.`;
}

function waitingBlock(waiting, nowMs, { heading }) {
  if (!waiting?.length) return null;
  const lines = waiting.slice(0, 3).map((w) => `· ${w.name} — รอ ${hoursAgo(w.lastInboundAt, nowMs)}`);
  if (waiting.length > 3) lines.push(`· และอีก ${waiting.length - 3} คน`);
  return { text: [`${heading} ${waiting.length} คน`, ...lines].join("\n") };
}

// สมองเงา (Phase 1a): ด่านคือ "ตรงติดกัน N คืน" ซึ่งไม่มีใครเห็นถ้าไม่เปิด /health เอง
// null = ฟีเจอร์ปิดอยู่ = ไม่มีบรรทัดนี้เลย (สรุปของเดิมต้องเหมือนเดิมทุกไบต์)
export function brainParityDigestLine(parity) {
  if (!parity || parity.parity === "none") return "";
  if (parity.parity === "drift") {
    const parts = (parity.mismatches ?? []).join(" · ") || "ไม่ทราบส่วน";
    return `🧠 สมองเงา: ไม่ตรง (ส่วน: ${parts})`;
  }
  return `🧠 สมองเงา: ตรง ${nf(parity.streakDays)} วันติด`;
}

export function buildDigestBubbles({
  stats, orders, costThb = null, quotaLines = [], hotLines = [],
  waiting = [], mode = "evening", sinceMs, nowMs, brainParity = null,
}) {
  const bubbles = [];
  const morning = mode === "morning";
  const brainLine = brainParityDigestLine(brainParity);

  if (morning) {
    // เช้า — นำด้วยสิ่งที่ค้างคาคนอื่นอยู่ เพราะเป็นสิ่งเดียวที่มีคนเสียหายถ้าไม่ทำ
    bubbles.push({ text: [`☀️ เช้านี้ต้องดู · ${bangkokHHMM(nowMs)}`, brainLine].filter(Boolean).join("\n") });
    // v1.4.49: ความรู้ตกขอบ = บอทตอบโดยไม่รู้เรื่องที่ตกไป (มักเป็นแคตตาล็อกราคา)
    // เสียหายเงียบและสะสม จึงเตือนดังทุกเช้าจนกว่าจะมีคนรวบคลัง
    if (stats.knowledgeDropped) bubbles.push({ text: `🧠 ความรู้ ${nf(stats.knowledgeDropped)} รายการเก่าสุดตกขอบจากหัวบอท — คลังเกินเพดาน ต้องรวบด่วน` });
    const wait = waitingBlock(waiting, nowMs, { heading: "⏳ ลูกค้ารอคำตอบ" });
    if (wait) bubbles.push(wait);
    if (hotLines.length) bubbles.push({ text: ["🔥 ควรตามต่อ", ...hotLines].join("\n") });
    const pending = [];
    if (stats.needsHuman) pending.push(`เคสรอคนดูแล ${nf(stats.needsHuman)}`);
    if (orders.created - orders.paid > 0) pending.push(`ออเดอร์ที่ยังไม่จ่าย ${nf(orders.created - orders.paid)}`);
    if (stats.suspectSlips) pending.push(`สลิปน่าสงสัย ${nf(stats.suspectSlips)}`);
    if (pending.length) bubbles.push({ text: ["🧾 ค้างอยู่", ...pending.map((l) => `· ${l}`)].join("\n") });
    if (bubbles.length === 1) bubbles.push({ text: "ไม่มีอะไรค้างครับ 🎉" });
    return bubbles.slice(0, MAX_BUBBLES);
  }

  // ค่ำ — ผลของวัน ตามด้วยสิ่งที่จะข้ามคืนไป
  //
  // ลำดับสำคัญ เพราะจำกัดที่ 5 ก้อน ตัวที่ถูกตัดต้องเป็นตัวที่เสียหายน้อยที่สุดเสมอ
  // เรียงจาก "มีคนเสียหายถ้าไม่รู้" ไปหา "รู้ก็ดี ไม่รู้ก็ไม่เป็นไร"
  const quotaText = quotaLines.length > 1
    ? ["โควตาคงเหลือ:", ...quotaLines.map((l) => `· ${l}`)].join("\n")
    : (quotaLines.length ? `โควตาคงเหลือ ${quotaLines[0]}` : "");
  bubbles.push({
    text: [
      `🌙 วันนี้เป็นยังไง · ${bangkokHHMM(sinceMs)}-${bangkokHHMM(nowMs)}`,
      `แชทเข้า ${nf(stats.inbound)} ข้อความ จาก ${nf(stats.inboundCustomers)} คน`
        + (stats.newCustomers ? ` · ลูกค้าใหม่ ${nf(stats.newCustomers)}` : ""),
      costThb == null ? "💰 ค่า AI วันนี้ — (คำนวณไม่ได้)" : `💰 ค่า AI วันนี้ ${baht(costThb)}`,
      quotaText,
      brainLine,
    ].filter(Boolean).join("\n"),
  });

  // เรื่องเงินที่น่าสงสัยมาก่อนเสมอ — เป็นความเสี่ยงจริง ห้ามให้ถูกตัดทิ้งเพราะเต็มโควตาก้อน
  if (stats.suspectSlips) bubbles.push({ text: `⚠️ สลิปน่าสงสัย ${nf(stats.suspectSlips)} รายการ — ตรวจก่อนยืนยันที่นั่ง` });
  if (stats.knowledgeDropped) bubbles.push({ text: `🧠 ความรู้ ${nf(stats.knowledgeDropped)} รายการเก่าสุดตกขอบจากหัวบอท — คลังเกินเพดาน ต้องรวบด่วน` });

  const sale = [];
  if (orders.paid) sale.push(`ปิดได้ ${nf(orders.paid)} ราย · ${baht(orders.revenue)}`);
  else if (orders.created || orders.confirmed) {
    sale.push(`ออเดอร์ใหม่ ${nf(orders.created)} · ยืนยันแล้ว ${nf(orders.confirmed)} · ยังไม่มีใครจ่ายวันนี้`);
  }
  if (sale.length) bubbles.push({ text: "🧾 " + sale.join("\n") });

  // สิ่งที่จะข้ามคืนไป — ถ้าไม่บอกตอนนี้ พรุ่งนี้เช้าก็จะยังค้างอยู่เหมือนเดิม
  const wait = waitingBlock(waiting, nowMs, { heading: "⏳ ค้างข้ามคืน — ลูกค้ารอคำตอบ" });
  if (wait) bubbles.push(wait);

  // ใครใกล้ปิด — ตอนค่ำความหมายคือ "พรุ่งนี้ตามใครก่อน" ไม่ใช่ "ทำเดี๋ยวนี้" แบบตอนเช้า
  if (hotLines.length) bubbles.push({ text: ["🔥 ควรตามต่อพรุ่งนี้", ...hotLines].join("\n") });


  return bubbles.slice(0, MAX_BUBBLES);
}

export function createDigest({
  config,
  db,
  lineRegistry,
  modelPricing = null, // เทสต์ inject ได้ — ไม่ส่ง = โหลดจากไฟล์ราคาเดียวกับ console
  fx = null,
  brainParity = null, // ตัวเฝ้าสมองเงา (src/brain/parityWatch.mjs) — ไม่ส่ง/ปิดอยู่ = ไม่มีบรรทัดนี้
  logger = console,
  now = Date.now,
  intervalMs = DEFAULT_TICK_MS,
}) {
  const lock = createLock();
  let timer = null;
  const pricingMap = pricingById(modelPricing ?? loadModelPricing(config.modelPricingFile, { logger }));

  // ค่าใช้จ่าย AI "วันนี้" (เวลาไทย) เป็นบาท — พังทุกกรณี = null (โชว์ "—")
  function costTodayThb() {
    try {
      const { usd } = summarizeUsage(db.llmUsageSummary(bangkokDayStartMs(now())), pricingMap);
      let rate = config.thbPerUsd;
      try {
        if (fx) rate = fx.current().thbPerUsd || rate;
      } catch { /* fx พัง — ใช้ env fallback */ }
      return usd * rate;
    } catch {
      return null;
    }
  }

  const fmtQuota = (q) => {
    if (!q) return "—";
    if (q.type === "none") return "ไม่จำกัด";
    return `${nf(Math.max(0, Number(q.value) - Number(q.totalUsage)))}/${nf(q.value)}`;
  };

  // โควตาคงเหลือ — หลายสาขา = บรรทัดต่อ OA; ทุกความล้มเหลว = "—" (ห้ามล้ม digest)
  async function quotaLines() {
    const active = (lineRegistry?.channels || []).filter((ch) => ch.active !== false);
    if (active.length > 1) {
      const lines = [];
      for (const ch of active) {
        let quota = null;
        try {
          quota = await lineRegistry.forChannel(ch.id).getQuota();
        } catch {
          quota = null;
        }
        lines.push(`${ch.name || ch.id}: ${fmtQuota(quota)}`);
      }
      return lines;
    }
    let quota = null;
    try {
      quota = await lineRegistry.forChannel(config.digestChannelId).getQuota();
    } catch {
      quota = null;
    }
    return [fmtQuota(quota)];
  }

  // 🔥 top 3: ชื่อ + score + next_move สั้น ๆ จากผล scorer ล่าสุด (parse พัง = ไม่มีคำแนะนำ)
  function hotLines(hotTop) {
    return (hotTop || []).map((c, i) => {
      let move = "";
      try {
        const row = db.latestScoreRow(c.line_user_id);
        move = scorerSuggestionsEnabled(db) && row?.payload_json ? String(JSON.parse(row.payload_json)?.next_move || "") : "";
      } catch {
        move = "";
      }
      const name = c.known_name || c.display_name || `ลูกค้า …${String(c.line_user_id).slice(-4)}`;
      return `${i + 1}. ${name} (${c.last_score}/10)${move ? ` — ${move.slice(0, NEXT_MOVE_MAX)}` : ""}`;
    });
  }

  async function runDue() {
    // lock แบบ synchronous — รอบก่อนยังไม่จบ = ข้ามรอบนี้ (แบบเดียวกับ canary)
    if (!lock.tryAcquire()) {
      return { skipped: true, reason: "run_in_flight" };
    }
    try {
      // ไม่มีปลายทาง = ปิดสนิทไม่ว่าสวิตช์จะว่าอะไร (fail-closed ชั้นแรก)
      if (!config.digestLineUserId) return { skipped: true, reason: "no_user" };
      if (!digestGlobalEnabled({ db, config })) return { skipped: true, reason: "digest_disabled" };
      const times = parseDigestTimes(config.digestTimes);
      if (!times.length) return { skipped: true, reason: "no_valid_times" };

      const t = now();
      const slot = latestSlotMs(t, times);
      let lastSlot = 0;
      try {
        lastSlot = Number(db.getSetting(DIGEST_LAST_SLOT_KEY)) || 0;
      } catch {
        return { skipped: true, reason: "db_error" }; // อ่านสถานะไม่ได้ — ไม่เสี่ยงส่งซ้ำ
      }
      if (slot <= lastSlot) return { skipped: true, reason: "not_due" };

      // ช่วงสรุป = ตั้งแต่ digest ที่ส่งจริงครั้งก่อน — ไม่เคยส่ง = ตั้งแต่รอบก่อนหน้า slot นี้
      const lastSent = Number(db.getSetting(DIGEST_LAST_SENT_KEY)) || 0;
      const sinceMs = lastSent > 0 ? lastSent : (previousSlotMs(slot, times) ?? slot - DAY_MS);

      const stats = db.digestStats(sinceMs);
      // v1.4.49: นับความรู้ตกขอบด้วยตัวนับเดียวกับตัวประกอบ prompt — พังแล้วเป็น 0 เงียบ ๆ
      // ดีกว่าทำ digest ทั้งใบล้ม (ตัวเลขนี้เป็นคำเตือน ไม่ใช่หัวใจของสรุป)
      try { stats.knowledgeDropped = knowledgeUsage(db.listActiveKnowledge(null), { separateCatalog: catalogOutOfPrompt(db) }).droppedCount; }
      catch { stats.knowledgeDropped = 0; }
      const orders = db.orderDigestStats(sinceMs);

      // ไม่มีความเคลื่อนไหวเลย = ข้าม slot นี้ทั้งรอบ (mark slot กันเช็คซ้ำทุก tick)
      const activity = stats.inbound + stats.newCustomers + stats.suspectSlips
        + orders.created + orders.confirmed + orders.paid;
      if (activity === 0) {
        db.setSetting(DIGEST_LAST_SLOT_KEY, String(slot));
        logger.log?.(`[digest] skipped_no_activity slot=${new Date(slot).toISOString()} (ไม่มีความเคลื่อนไหวตั้งแต่รอบก่อน)`);
        return { skipped: true, reason: "no_activity", slot };
      }

      // รอบก่อนเที่ยง = สรุปเช้า (สิ่งที่ต้องทำ) · หลังจากนั้น = สรุปค่ำ (สิ่งที่เกิดขึ้น)
      const slotHourBkk = Math.floor((((slot + 7 * 3_600_000) % DAY_MS) / 3_600_000));
      const mode = slotHourBkk < 12 ? "morning" : "evening";
      let waiting = [];
      try { waiting = db.digestWaitingRooms?.(5) ?? []; } catch { waiting = []; }

      // สมองเงาอ่านจากสิ่งที่ตัวเฝ้าจดไว้ ไม่ตรวจใหม่ตรงนี้ (digest ห้ามช้าหรือล้มเพราะเรื่องนี้)
      let brainSnapshot = null;
      try { brainSnapshot = brainParity?.snapshot?.() ?? null; } catch { brainSnapshot = null; }

      const bubbles = buildDigestBubbles({
        stats, orders,
        costThb: costTodayThb(),
        quotaLines: await quotaLines(),
        hotLines: hotLines(stats.hotTop),
        waiting, mode,
        sinceMs, nowMs: t,
        brainParity: brainSnapshot,
      });

      // ยิงด้วย client/token ของ channel ที่ตั้งไว้ — ปลายทางคือ raw LINE user id ของเจ้าของ
      const lineCh = lineRegistry.forChannel(config.digestChannelId);
      const sendResult = await lineCh.sendBubbles({
        to: config.digestLineUserId, replyToken: "", bubbles, images: [],
        purpose: SEND_PURPOSE.ownerDigest, // push ทีละบอลลูน = นับโควตาบอลลูนละหนึ่ง (บัญชี lineSendLedger)
      });

      // mark slot ทั้งสำเร็จและล้มเหลว (at-most-once): โหมด push ส่งทีละ bubble —
      // ล้มกลางทางแล้ว retry ทุก tick = เจ้าของได้ข้อความซ้ำ ซึ่งแย่กว่าพลาดรอบเดียว
      db.setSetting(DIGEST_LAST_SLOT_KEY, String(slot));
      if (!sendResult.ok) {
        logger.error?.(`[digest] ส่งไม่สำเร็จ (${sendResult.status ?? sendResult.reason ?? "?"}) slot=${new Date(slot).toISOString()}`);
        return { sent: false, slot, status: sendResult.status ?? null, reason: sendResult.reason ?? null };
      }
      db.setSetting(DIGEST_LAST_SENT_KEY, String(t));
      try {
        db.addAudit({
          operator: "system", action: "digest_sent",
          detail: `slot=${new Date(slot).toISOString()} bubbles=${bubbles.length} ช่วง=${bangkokHHMM(sinceMs)}-${bangkokHHMM(t)}`,
        });
      } catch (err) {
        logger.debug?.(`digest: บันทึก audit ไม่สำเร็จ (${err?.message || err})`);
      }
      logger.log?.(`[digest] ส่งสรุปถึงเจ้าของแล้ว (${bubbles.length} bubbles, slot=${new Date(slot).toISOString()})`);
      return { sent: true, slot, bubbles: bubbles.length };
    } finally {
      lock.release(); // ปล่อย lock เสมอ ไม่ว่าจะจบทางไหน
    }
  }

  // arm เฉพาะเมื่อมีปลายทาง — สวิตช์ global เช็คสดทุก tick ใน runDue (toggle ไม่ต้อง restart)
  function start() {
    if (timer || intervalMs <= 0 || !config.digestLineUserId) return false;
    timer = setInterval(() => {
      runDue().catch((err) => logger.error?.(`digest: ${err?.message || err}`));
    }, intervalMs);
    timer.unref?.(); // ไม่ค้ำ process ตอน shutdown
    logger.log?.(`[digest] scheduler เดินทุก ${intervalMs}ms (เวลา ${config.digestTimes} — สวิตช์เช็คสดทุกรอบ)`);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    runDue,
    start,
    stop,
    get busy() { return lock.held; },
    get running() { return timer !== null; },
  };
}
