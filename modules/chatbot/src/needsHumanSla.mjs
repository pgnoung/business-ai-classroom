// needsHumanSla.mjs — ห้องที่ "รอคนจริง" ต้องถูกทวงซ้ำจนกว่าจะมีคนตอบ
//
// เหตุจริง 2026-09-02: ห้อง NEEDS_HUMAN 28 ห้อง — 11 ห้องไม่เคยมีคนตอบ สองห้องเส้นเงิน
// รออยู่ 30 ชม. และ 169 ชม. เพราะ escalate_notify ยิงครั้งเดียวตอนส่งต่อแล้วจบ
// ตัวนี้คือนาฬิกาจับเวลาของคิวนั้น: รอเกินกำหนดแล้วยังไม่มีคนตอบ = ทวงซ้ำสูงสุด 3 ครั้ง
//
// คำสั่งเจ้าของ 2026-09-02 (หลังเปิดใช้วันแรก): push เสียเงินจริงต่อข้อความ จึงทวงเฉพาะ
// ห้องที่ "ต้องใช้คน" (ร้องเรียน / ขอให้หยุดทัก / ขอคุยกับคนจริง / private class-in-house /
// opportunity ข้อมูลครบ / วิกฤตสุขภาพจิต) — ห้องรอคนทั่วไป (out_of_band, คำสัญญาค้าง,
// ถามว่าเป็นบอทไหม, เส้นเงินทุกชนิด) ไม่ push เลย ยังเห็นได้ในคิวคอนโซลและสรุปรายวัน
//
// กติกาที่ห้ามพลาด
// - ไม่ทักลูกค้าเด็ดขาด — ปลุกเฉพาะทีมงานผ่าน notifier เส้นเดิม
// - ตัวนับต้องอยู่ใน DB (settings) ไม่ใช่หน่วยความจำ: cooldown ของ notify.mjs เป็น
//   in-memory รีสตาร์ททีเดียวลืมหมด ถ้าตัวนับอยู่ในแรมด้วย ทุก deploy = ทวงใหม่ทั้งคิว
// - ตัวนับหมดอายุเมื่อลูกค้าพิมพ์เข้ามาใหม่หลังการเตือนครั้งล่าสุด: ข้อความใหม่ที่ยังไม่มี
//   ใครตอบต้องได้บันไดเตือนของตัวเอง ไม่งั้นห้องที่เคยทวงครบ 3 ครั้งจะเงียบตลอดชีพ
// - นอกเวลาทำการไม่ยิง (ใช้กติกาเดียวกับ scheduleGate — Asia/Bangkok รองรับข้ามคืน)
//   ห้องที่ครบกำหนดตอนดึกจะได้รับการทวงในรอบแรกที่เข้าเวลาทำการ ไม่ใช่ตี 3
import { inActiveWindow, parseActiveHours } from "./scheduleGate.mjs";
import { needsPersonReason, personReasonLabel, personReasonRaisedAt } from "./needsPersonReason.mjs";
import { normalizeThai } from "./safetyRouter.mjs";

export const NEEDS_HUMAN_REMINDER_KEY_PREFIX = "needs_human_reminder:";
export const NEEDS_HUMAN_SLA_DEFAULT_MINUTES = 30;
export const NEEDS_HUMAN_SLA_DEFAULT_MAX = 3;
export const NEEDS_HUMAN_SLA_DEFAULT_HOURS = "08:00-20:00";
// เพดานต่อรอบ: กันวันแรกที่มีห้องค้างพร้อมกันหลายสิบห้องยิงรัวจนทีมปิดการแจ้งเตือนทิ้ง
// (เรียงคนรอนานสุดก่อน แล้วทยอยไปทีละรอบ)
export const NEEDS_HUMAN_SLA_MAX_PER_TICK = 5;

// เพดานการอ่านคิวต่อรอบ (ใช้ร่วมกับ dbExtra.listNeedsHumanSlaCandidates)
export const NEEDS_HUMAN_SLA_SCAN_LIMIT = 200;

// เหตุ AI ปิดถาวรที่นับเป็น "คิวรอคน" บนคอนโซล — ใช้กับ isWaitingForHuman เท่านั้น
// (ความหมายของคิว) ไม่ใช่เงื่อนไขการ push
export const NEEDS_HUMAN_SLA_STICKY_REASONS = Object.freeze([
  "complaint",
  "optout",
  "identity_question",
  "handoff_private_inhouse",
  "human_requested",
  // คำสั่งพี่ง้วง 2026-09-05: ลูกค้าจอง/สมัครแล้ว AI ปิดถาวร = ห้องนี้อยู่ในคิวรอคน
  "booking_handoff",
  // F4b (ก.ย. 2026): ลูกค้าขอให้หยุดตอบ — อยู่ในคิวให้ทีมเห็น แต่จงใจ "ไม่" อยู่ใน
  // NEEDS_HUMAN_SLA_PERSON_REASONS: ลูกค้าบอกเองว่าไม่ต้องตอบ การทวงทีมทุก 30 นาทีให้รีบตอบ
  // คือการทำตรงข้ามกับที่เขาขอ (push ครั้งเดียวตอนหยุดพอ)
  "customer_asked_quiet",
]);
const STICKY = new Set(NEEDS_HUMAN_SLA_STICKY_REASONS);

const EMPTY_STATE = Object.freeze({ count: 0, lastAt: 0 });

// ---- F9 (ตรวจย้อนหลัง ก.ย. 2026): 24 จาก 29 push ของบันไดทวงเป็นเสียงรบกวน ----
// ข้อความใหม่ "ทุกข้อความ" เคยเริ่มบันได 3 push ใหม่ — รวมแฮชแท็กกิจกรรม สติกเกอร์ คำรับสั้น ๆ
// และคำตอบเมนูในห้องที่คนดูแลอยู่แล้ว · ตอนนี้บันไดผูกกับ "ข้อความที่ควรทวง" (anchor) เท่านั้น
const ACK_ONLY = /^(?:ค่ะ|คะ|ค่า|ครับ|คับ|ค้าบ|จ้า|จ้ะ|ฮะ|โอเค|โอเค่|ok|okay|oke|ได้|ได้เลย|รับทราบ|ทราบแล้ว|ขอบคุณ|ขอบคุณมาก|thx|thanks?|thank\s*you|นะ|ๆ)+$/iu;
/** ข้อความที่ไม่ควรเริ่มบันไดทวงใหม่: แฮชแท็ก/คีย์เวิร์ดล้วน สติกเกอร์ คำรับสั้น ๆ */
export function isNoiseInbound({ type = "text", text = "" } = {}) {
  if (String(type) === "sticker") return true;
  if (String(type) !== "text") return false; // รูป/ไฟล์/เสียง = มีเนื้อหาที่คนต้องดู
  const value = normalizeThai(String(text || "")).trim();
  if (!value) return true;
  if (/^[#@][^\s#@]+$/u.test(value)) return true; // "#bootcamp" ล้วน (ต่อท้ายด้วยข้อมูล = มีเนื้อหา)
  const core = value.replace(/[\s\p{P}\p{S}]+/gu, "");
  return !core || ACK_ONLY.test(core);
}
/** รูปคำถาม/คำขอ — ห้องที่คนดูแลแล้ว หรือบันไดวันนี้ครบแล้ว ทวงใหม่เฉพาะข้อความแบบนี้ */
const QUESTION_LIKE = /[?？]|ไหม|มั้ย|มั๊ย|ไม๊|หรือเปล่า|รึเปล่า|ป่าว|ป่ะ|หรอ|เหรอ|ยังไง|อย่างไร|เท่าไหร่|เท่าไร|กี่|เมื่อไหร่|เมื่อไร|ไหน|อะไร|ทำไม|ใคร|ถาม|สงสัย|อยากทราบ|อยากรู้|ขอ(?!บคุณ|โทษ)|รบกวน|ช่วย|ด่วน|ยังไม่(?:ได้|มี)|ไม่ได้รับ|เข้าไม่ได้|ติดต่อ/u;
export function isQuestionLikeInbound(text = "") {
  return QUESTION_LIKE.test(normalizeThai(String(text || "")));
}
// ข้อความที่ต้องมีคนตอบแน่ ๆ: คำถาม/คำขอ หรือไฟล์แนบ (รูป/ไฟล์/เสียง = สิ่งที่คนต้องเปิดดูเอง)
// ของจริง: ห้อง in-house ที่ทีมคุยอยู่ ลูกค้าส่งรูปตามมาแล้วไม่มีใครเปิด — ต้องยังทวง
const needsAnswer = (item) => String(item?.type || "text") !== "text" || isQuestionLikeInbound(item?.text);
function parseRecentInbound(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const list = JSON.parse(String(raw));
    if (!Array.isArray(list)) return null;
    return list
      .map((item) => ({ at: num(item?.at), type: String(item?.type || "text"), text: String(item?.text || "") }))
      .filter((item) => item.at > 0)
      .sort((a, b) => b.at - a.at);
  } catch {
    return null; // อ่านไม่ออก = พฤติกรรมเดิม (ทวงตามข้อความล่าสุด) — เงียบเพราะอ่านไม่ออกอันตรายกว่า
  }
}
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const bangkokDay = (ms) => Math.floor((num(ms) + BANGKOK_OFFSET_MS) / 86_400_000);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

// "<ครั้งที่ส่งแล้ว>|<เวลาส่งล่าสุด>" — ค่าพัง = เริ่มนับใหม่ (เงียบเพราะอ่านไม่ออก
// อันตรายกว่าทวงเกินหนึ่งครั้ง)
export function parseReminderState(raw) {
  const [countRaw, lastRaw] = String(raw ?? "").split("|");
  const count = Math.max(0, Math.trunc(num(countRaw)));
  const lastAt = Math.max(0, Math.trunc(num(lastRaw)));
  return { count, lastAt };
}

export function formatReminderState({ count, lastAt }) {
  return `${Math.max(0, Math.trunc(num(count)))}|${Math.max(0, Math.trunc(num(lastAt)))}`;
}

// ห้องนี้อยู่ใน "คิวรอคน" ของคอนโซลไหม (สถานะส่งต่อ / คำสัญญาค้าง / AI ปิดถาวรของคน)
// — ความหมายของคิว ไม่ใช่ด่าน push ซึ่งใช้ needsPersonReason
export function isWaitingForHuman(row) {
  if (!row) return false;
  if (String(row.state ?? "") === "NEEDS_HUMAN") return true;
  if (Number(row.unkept_promise) === 1) return true;
  return Number(row.ai_enabled) !== 1 && STICKY.has(String(row.ai_off_reason ?? "").trim());
}

// เรื่องเงินคือจังหวะที่พลาดแล้วเสียหายที่สุด — ต้องเห็นได้ตั้งแต่บรรทัดแจ้งเตือน
export function touchesMoney(row) {
  if (!row) return false;
  return Number(row.money_seen_at) > 0
    || String(row.ai_off_reason ?? "") === "bank_sent"
    || Boolean(String(row.last_slip_status ?? "").trim());
}

/**
 * เลือกห้องที่ถึงกำหนดทวง — บริสุทธิ์ ไม่มีผลข้างเคียง (ทดสอบได้โดยไม่ต้องมี DB)
 *
 * ถึงกำหนดเมื่อครบทุกข้อ:
 *   1) ห้องนี้ "ต้องใช้คน" จริง — needsPersonReason(row) ไม่เป็น null
 *      (คิว "รอคน" ทั่วไปยังอยู่บนคอนโซลเหมือนเดิม แค่ไม่เสียค่า push)
 *   2) ข้อความขาเข้าล่าสุดใหม่กว่าข้อความขาออกของ "คน" ล่าสุด (ยังไม่มีใครตอบ)
 *   3) รอมาแล้ว >= waitMs นับจากข้อความขาเข้าล่าสุด
 *   4) ทวงไปแล้วน้อยกว่า maxReminders ครั้ง และครั้งก่อนห่างมาแล้ว >= waitMs (ไม่งั้น
 *      tick ละ 5 นาทียิงครบ 3 ครั้งใน 15 นาที) — ตัวนับหมดอายุเมื่อลูกค้าพิมพ์มาใหม่
 *   5) อยู่ในเวลาทำการ (window = null คือไม่จำกัดเวลา)
 * เรียงคนรอนานสุดขึ้นก่อนเสมอ
 */
export function selectDueReminders(rows, {
  now = Date.now(),
  waitMs = NEEDS_HUMAN_SLA_DEFAULT_MINUTES * 60_000,
  maxReminders = NEEDS_HUMAN_SLA_DEFAULT_MAX,
  reminderState = () => EMPTY_STATE,
  window = null,
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (!inActiveWindow(now, window)) return [];
  const wait = Math.max(0, Number(waitMs) || 0);
  const max = Math.max(0, Math.trunc(Number(maxReminders) || 0));
  if (max === 0) return [];
  const due = [];
  for (const row of rows) {
    // ด่านค่าใช้จ่าย: ห้องที่ไม่ได้ "ต้องใช้คน" ไม่ push เลย (ยังอยู่ในคิวคอนโซล/สรุปรายวัน)
    const personReason = needsPersonReason(row);
    if (!personReason) continue;
    const lastOperator = num(row.last_operator_outbound_at);
    // F9 ข้อ 2: เหตุถูกยกเมื่อไร — คนเปิด AI คืนหลังจากนั้น = เหตุหมดอายุ (AI ตอบเองแล้ว ไม่ต้องปลุกคน)
    const reasonAt = personReasonRaisedAt(row, personReason);
    if (reasonAt > 0 && num(row.ai_reopened_at) >= reasonAt) continue;
    // คนตอบในห้องแล้วหลังเหตุ = ห้องของคน — ข้อความทั่วไป (ตอบเมนู/แฮชแท็ก) ไม่ใช่เหตุให้ปลุกทีม
    const humanTookOver = reasonAt > 0 && lastOperator > reasonAt;
    // F9 ข้อ 1: ข้อความที่ "ควรทวง" = ข้อความล่าสุดหลังคนตอบ ที่ไม่ใช่แฮชแท็ก/สติกเกอร์/คำรับสั้น ๆ
    // (ถ้าคนดูแลห้องแล้ว ต้องเป็นคำถาม/คำขอ/ไฟล์แนบ) · แถวที่ไม่มีข้อมูลข้อความ = ข้อความล่าสุดแบบเดิม
    const recent = parseRecentInbound(row.recent_inbound_json);
    let lastInbound = num(row.last_inbound_at);
    let anchorNeedsAnswer = null;
    if (recent) {
      const anchor = recent.find((item) => item.at > lastOperator && !isNoiseInbound(item)
        && (!humanTookOver || needsAnswer(item)));
      lastInbound = anchor ? anchor.at : 0;
      anchorNeedsAnswer = anchor ? needsAnswer(anchor) : null;
    }
    if (lastInbound <= 0) continue;
    if (lastInbound <= lastOperator) continue; // มีคนตอบหลังลูกค้าทักแล้ว
    const waitedMs = now - lastInbound;
    if (waitedMs < wait) continue;
    const stored = reminderState(row.line_user_id) || EMPTY_STATE;
    // ลูกค้าพิมพ์เข้ามาใหม่หลังการเตือนครั้งล่าสุด = เรื่องใหม่ ไม่ใช่เรื่องเดิมที่เคยทวงไปแล้ว
    // ตัวนับเก่าจึงหมดอายุ และบันได 30/60/90 เริ่มนับหนึ่งใหม่ — ถ้าไม่มีข้อนี้ ห้องที่เคย
    // ถูกทวงครบ 3 ครั้ง (หรือถูก backfill ปิดบันไดไว้) จะเงียบตลอดชีพ ต่อให้ลูกค้าคนนั้น
    // กลับมาถามใหม่อีกกี่ครั้งก็ตาม
    // F9 ข้อ 3: แต่ในวันเดียวกับบันไดก่อนหน้า เริ่มใหม่ได้เฉพาะเมื่อข้อความใหม่เป็นคำถาม/คำขอ/ไฟล์แนบ
    // (เพดานหนึ่งบันไดต่อวันต่อห้อง — ของจริงห้องเดียวโดนทวง 6 ครั้งในบ่ายเดียวจากคำตอบเมนู)
    const sameDayLadder = num(stored.lastAt) > 0 && bangkokDay(stored.lastAt) === bangkokDay(now);
    const staleState = lastInbound > num(stored.lastAt)
      && !(anchorNeedsAnswer === false && sameDayLadder);
    const count = staleState ? 0 : Math.max(0, Math.trunc(num(stored.count)));
    if (count >= max) continue;
    if (count > 0 && now - num(stored.lastAt) < wait) continue;
    due.push({ row, reminderNumber: count + 1, waitedMs, money: touchesMoney(row), reason: personReason });
  }
  return due.sort((a, b) => b.waitedMs - a.waitedMs);
}

export function waitLabel(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} นาที`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ชม.`;
  return `${Math.floor(hours / 24)} วัน`;
}

export function reminderText({ reason, reminderNumber, waitedMs, money }, maxReminders) {
  const label = personReasonLabel(reason);
  return `รอคนตอบมา ${waitLabel(waitedMs)} (เหตุ: ${label})`
    + `${money ? " 💰 ห้องนี้แตะเรื่องเงินแล้ว" : ""}`
    + ` — เตือนครั้งที่ ${reminderNumber}/${maxReminders}`;
}

// รอบทำงานจริง: อ่านผู้สมัครจาก DB -> เลือกด้วยตรรกะบริสุทธิ์ -> ปลุกทีม + จดตัวนับ
// ทุกอย่างห่อ try/catch: งานเฝ้าห้ามทำให้ tick หรือแชทหลักล้ม
export function runNeedsHumanSla({ db, notifier, config = {}, now = Date.now, logger = console } = {}) {
  if (config.needsHumanSlaEnabled !== true) return { skipped: "disabled" };
  if (!db || !notifier?.fireLater) return { skipped: "not_wired" };
  const at = typeof now === "function" ? now() : Number(now);
  // ช่วงเวลาที่ตั้งค่าผิดรูป = ใช้ค่ามาตรฐาน ไม่ใช่ "ยิงได้ทั้งวัน" — ตี 3 ห้ามมีเสียง
  const window = parseActiveHours(config.needsHumanSlaHours)
    ?? parseActiveHours(NEEDS_HUMAN_SLA_DEFAULT_HOURS);
  const maxReminders = Math.max(0, Math.trunc(Number(config.needsHumanSlaMaxReminders) || 0));
  const waitMs = Math.max(0, Number(config.needsHumanSlaMinutes) || 0) * 60_000;

  let rows = [];
  try {
    rows = db.listNeedsHumanSlaCandidates?.() ?? [];
  } catch (err) {
    logger.debug?.(`needsHumanSla: อ่านคิวรอคนไม่สำเร็จ (${err?.message || err})`);
    return { skipped: "read_failed" };
  }

  // เต็มเพดาน = อาจมีห้องตกสำรวจ (2026-09-02: ห้อง customer_handover 818 ห้องเคยกิน
  // โควตาการอ่านจนห้องจริงไม่เคยถูกเห็น — แก้ที่ SQL ของ listNeedsHumanSlaCandidates แล้ว)
  if (rows.length >= NEEDS_HUMAN_SLA_SCAN_LIMIT) {
    logger.warn?.(`[needsHumanSla] อ่านคิวเต็มเพดาน ${NEEDS_HUMAN_SLA_SCAN_LIMIT} ห้อง — อาจมีห้องตกสำรวจ`);
  }

  const readState = (customerId) => {
    try {
      return parseReminderState(db.getSetting(NEEDS_HUMAN_REMINDER_KEY_PREFIX + customerId));
    } catch {
      return EMPTY_STATE;
    }
  };
  const due = selectDueReminders(rows, { now: at, waitMs, maxReminders, reminderState: readState, window });
  if (!due.length) return { scanned: rows.length, due: 0, notified: 0 };

  let notified = 0;
  for (const item of due.slice(0, NEEDS_HUMAN_SLA_MAX_PER_TICK)) {
    const row = item.row;
    const customerId = row.line_user_id;
    try {
      // จดตัวนับก่อนยิงเสมอ: ยิงเป็น fire-and-forget ถ้าโปรเซสตายกลางทาง
      // "ทวงซ้ำรอบหน้า" เสียหายน้อยกว่า "ทวงซ้ำทุก tick เพราะตัวนับไม่ถูกจด"
      db.setSetting(
        NEEDS_HUMAN_REMINDER_KEY_PREFIX + customerId,
        formatReminderState({ count: item.reminderNumber, lastAt: at }),
      );
      notifier.fireLater({
        customerId,
        // ห้องฝั่ง Facebook ต้องส่ง channel จริงเข้าไป ไม่ใช่ "default" — notify.mjs
        // ใช้ค่านี้ติดป้าย "เคสจาก Facebook" ให้คนอ่านรู้ว่าต้องไปเปิดห้องฝั่งไหน
        channelId: row.channel_id || "default",
        reason: "needs_human_sla",
        customerName: row.known_name || row.display_name || "",
        reasonTextOverride: reminderText(item, maxReminders),
        force: true, // cooldown 10 นาทีของ notify คนละเรื่องกับนาฬิกา SLA ตัวนี้
      });
      db.addAudit({
        operator: "system",
        action: "needs_human_reminder",
        target: customerId,
        detail: `ครั้งที่ ${item.reminderNumber}/${maxReminders} — รอมาแล้ว ${waitLabel(item.waitedMs)}${item.money ? " (เส้นเงิน)" : ""}`,
      });
      notified += 1;
    } catch (err) {
      logger.debug?.(`needsHumanSla: เตือนห้อง ${customerId} ไม่สำเร็จ (${err?.message || err})`);
    }
  }
  if (notified) {
    logger.log?.(`[needsHumanSla] เตือนห้องที่รอคน ${notified} ห้อง (ค้างในคิว ${due.length} ห้อง)`);
  }
  return { scanned: rows.length, due: due.length, notified };
}
