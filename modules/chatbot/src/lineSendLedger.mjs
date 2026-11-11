// lineSendLedger.mjs — บัญชี "ระบบยิง LINE ไปทำอะไร" (28 ก.ย. 2026)
//
// พี่ง้วงถาม (28 ก.ย. 2026): "ต้นทุนของ LINE OA สามารถแยกได้ไหมว่า push นี้เป็นจากระบบพี่ง้วงส่งเข้าทีมงาน
// หรือเป็น broadcast จาก LINE OA หรือคือการส่ง message หาลูกค้าจริงๆ"
//
// ก่อนหน้านี้ตอบไม่ได้: ตาราง messages เก็บ "บอลลูน" ไม่ใช่ "คำขอที่ยิงไป LINE" ไม่มีช่องบอกว่าส่งแบบ reply
// (ฟรี) หรือ push (นับโควตา) และแจ้งเตือนทีมไม่อยู่ใน messages เลย (เช็กฐานจริง ก.ย.: แจ้งเตือน 242 ครั้ง
// = push ถึงทีม 480 ข้อความ ไม่โผล่ในตัวเลขหน้าไหน) ตัวเลขบรอดแคสต์ในแผง ROAS จึงเป็นแค่ "ยอดรวม − ข้อความบอท"
//
// ไฟล์นี้คือกติกากลางของบัญชี: ชื่อเหตุผลการส่งชุดปิด + วิธีส่งของ LINE + ตัวบันทึกที่ห้ามทำให้การส่งล้ม
// lineClient เรียก onSend หลัง LINE ตอบรับคำขอ (HTTP 2xx) เท่านั้น — คำขอที่ล้ม/กำกวมไม่ถูกนับ
// กติกานับของ LINE (developers.line.biz/en/docs/messaging-api/pricing/ ตรวจ 28 ก.ย. 2026):
//   นับตาม "จำนวนผู้รับ" ต่อคำขอ ไม่สนว่าในคำขอมีกี่บอลลูน · reply ไม่นับ · push/multicast/narrowcast/broadcast นับ
//   ข้อความถึงคนที่บล็อก OA LINE ไม่นับ แต่เรารู้ไม่ได้ว่าใครบล็อก — ตัวเลขทางการดูจากสถิติ LINE (lineInsight.mjs)
// ไม่มี id ลูกค้า/ผู้รับในบัญชีเลย (นับอย่างเดียว) จึงไม่เข้าเงื่อนไข PDPA cascade

// เหตุผลของการส่ง — ผู้เรียกทุกจุดส่งค่าจากชุดนี้เอง (ไม่ส่ง = other)
export const SEND_PURPOSE = Object.freeze({
  teamAlert: "team_alert", // 🔔 แจ้งจากระบบ Front Desk ถึงทีม (notify.mjs)
  ownerDigest: "owner_digest", // สรุปรายวันถึงเจ้าของ (digest.mjs)
  customerReply: "customer_reply", // ลูกแพรตอบลูกค้าด้วย reply token (ฟรี)
  customerReplyFallback: "customer_reply_fallback", // ลูกแพรตอบ แต่ต้องใช้ push (ตั้งโดย lineClient เท่านั้น)
  followup: "followup", // ทักตาม: บันไดตามสเตจ · นัดเช็กคิว · ทักเบา ๆ หลังส่งบัญชี · นัดเดิม
  yolo: "yolo", // YOLO ที่เจ้าของสั่ง (คอนโซล/Telegram)
  operator: "operator", // ทีมพิมพ์ตอบจากคอนโซล
  broadcast: "broadcast", // บรอดแคสต์ของคอนโซลลูกแพร (multicast/broadcast/narrowcast + ส่งทดสอบ)
  stepMessage: "step_message", // ข้อความตามขั้น (Step) ของคอนโซลลูกแพร — push ทีละคนตามลำดับขั้น (stepMessages.mjs)
  campaign: "campaign_delivery", // 11 ต.ค. 2026: ของที่ลูกค้าขอผ่านคีย์เวิร์ดแคมเปญ (#AIAGENT → แบบวางระบบ AI Agent — blueprintSender.mjs)
  ownerClose: "owner_close", // 12 ต.ค. 2026 ค่ำ: คำลาสุภาพหลังพี่ง้วง/ชมพู่กดยืนยันปิดห้องในคอนโซล (ownerCloseService.mjs — push)
  other: "other", // อื่น ๆ เช่น ข้อความตอบรับของโหมดเทรน
});
export const SEND_PURPOSES = Object.freeze(Object.values(SEND_PURPOSE));
const PURPOSE_SET = new Set(SEND_PURPOSES);

// วิธีส่งของ LINE Messaging API — reply อย่างเดียวที่ไม่นับโควตา
export const SEND_METHODS = Object.freeze(["reply", "push", "multicast", "narrowcast", "broadcast"]);
const METHOD_SET = new Set(SEND_METHODS);

// เหตุที่ "ตอบลูกค้า" ต้องกลายเป็น push — เจ้าของอยากรู้ว่า "ตอบช้าจนต้อง push" จริงไหม
//   reply_rejected = LINE ปฏิเสธ reply token (HTTP 400 — ส่วนใหญ่คือหมดอายุเพราะคิดนาน)
//   no_reply_token = ไม่มี reply token ให้ใช้ (เช่น ตอบข้อความค้างหลังหมดเวลาพัก)
//   over_five     = คำตอบยาวเกิน 5 ก้อนต่อคำขอ reply ส่งทั้งชุดทาง reply ไม่ได้
export const FALLBACK_DETAILS = Object.freeze(["reply_rejected", "no_reply_token", "over_five"]);
const DETAIL_SET = new Set(FALLBACK_DETAILS);

export function normalizeSendPurpose(value) {
  const text = String(value ?? "").trim();
  return PURPOSE_SET.has(text) ? text : SEND_PURPOSE.other;
}

export function normalizeSendDetail(value) {
  const text = String(value ?? "").trim();
  return DETAIL_SET.has(text) ? text : "";
}

export function countsTowardQuota(method) {
  return METHOD_SET.has(method) && method !== "reply";
}

// ตอบลูกค้าที่ออกทาง push = เหตุผลคนละแบบกับตอบด้วย reply (อันหนึ่งฟรี อีกอันนับโควตา)
export function fallbackPurpose(purpose) {
  const normalized = normalizeSendPurpose(purpose);
  return normalized === SEND_PURPOSE.customerReply ? SEND_PURPOSE.customerReplyFallback : normalized;
}

const BANGKOK_OFFSET_MS = 7 * 3_600_000;

/** วันเวลาไทย YYYY-MM-DD — กุญแจรายวันของบัญชี (ธุรกิจนับวันตามกรุงเทพ) */
export function bangkokDay(ms) {
  return new Date(Number(ms) + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

const count = (value, fallback = 0) => {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

// log เตือนได้ไม่เกินหนึ่งครั้งต่อช่วงนี้ — ฐานพังทีเดียว ทุกการส่งจะล้มบันทึกตาม ห้ามถล่ม log
const WARN_EVERY_MS = 10 * 60_000;

/**
 * ตัวบันทึกที่ lineClient เรียกหลังทุกคำขอที่ LINE ตอบรับ — ไม่มีวันโยน error และไม่ await อะไรเลย
 * (SQLite เขียนแบบ synchronous ใช้เวลาระดับไมโครวินาที) บันทึกไม่ได้ = การส่งยังสำเร็จตามเดิมเสมอ
 */
export function createLineSendRecorder({ db, now = Date.now, logger = console } = {}) {
  let lastWarnAt = 0;
  return function recordLineSend(event = {}) {
    try {
      const method = String(event.method || "");
      if (!METHOD_SET.has(method)) return false;
      const at = Number(now());
      // "ตอบลูกค้า" ที่นับโควตาได้ = หลุดเป็น push เสมอ (reply ฟรี) — กันผู้เรียกทางอื่นที่ลืมแปลงชื่อเหตุผล
      const purpose = countsTowardQuota(method) ? fallbackPurpose(event.purpose) : normalizeSendPurpose(event.purpose);
      db.addLineSend({
        day: bangkokDay(at),
        channelId: String(event.channelId || "default").slice(0, 64),
        method,
        purpose,
        detail: normalizeSendDetail(event.detail),
        countsQuota: countsTowardQuota(method),
        sends: event.sends ? 1 : 0,
        requests: count(event.requests, 1),
        recipients: count(event.recipients, 1),
        messageObjects: count(event.messageObjects, 0),
        at,
      });
      return true;
    } catch (err) {
      const at = Date.now();
      if (at - lastWarnAt >= WARN_EVERY_MS) {
        lastWarnAt = at;
        logger.warn?.(`lineSendLedger: บันทึกการส่งไม่สำเร็จ (${err?.message || err}) — การส่งถึง LINE ไม่ได้รับผลกระทบ`);
      }
      return false;
    }
  };
}
