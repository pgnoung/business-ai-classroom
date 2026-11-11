// roas.mjs — คิด ROAS รวมทั้งบริษัท (คำสั่งพี่ง้วง 1 ก.ย. 2026)
//
// ROAS = ยอดขาย ÷ ต้นทุนรวม
// ต้นทุนรวม = ค่าแอด Meta + ค่า AI + ค่าส่งข้อความ LINE + ค่าใช้จ่ายอื่น ๆ
//
// สิ่งที่ตั้งใจไม่ทำ:
// - ไม่เดาตัวเลขที่ยังไม่ได้กรอก ข้อมูลไม่ครบคืน null แล้วบอกว่าขาดอะไร
// - ไม่ปัดตัวเลขให้สวย ตัวเลขกำไรที่ผิดอันตรายกว่าไม่มีตัวเลข เพราะถูกเอาไปตัดสินใจ
//   ว่าจะเพิ่มหรือลดงบแอด
export const DEFAULT_LINE_RATE_THB = 0.06;

export const COST_KEYS = Object.freeze({
  adsThb: "cost_ads_thb",
  adsWindowDays: "cost_ads_window_days",
  adsUpdatedAt: "cost_ads_updated_at",
  lineRateThb: "cost_line_rate_thb",
  miscThb: "cost_misc_thb",
});

// ระวัง: Number(null) === 0 และ Number("") === 0 — ถ้าไม่กันก่อน "ยังไม่ได้กรอก"
// จะกลายเป็น "ต้นทุนศูนย์บาท" ซึ่งทำให้ ROAS สูงเกินจริงแบบเงียบ ๆ
const num = (value, fallback = null) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * แยกว่าข้อความ LINE เดือนนี้เป็นบรอดแคสกี่ข้อความ เป็นของ AI กี่ข้อความ
 *
 * พี่ง้วงบรอดแคสจาก manager.line.biz เป็นหลัก ไม่ได้ทำผ่านคอนโซล แต่ใช้โควตาก้อนเดียวกัน
 * LINE บอกได้แค่ "ยอดใช้รวมทั้งเดือน" (totalUsage) จึงหาส่วนบรอดแคสด้วยการลบส่วนที่เรารู้ว่า
 * เป็นของเราออก:  บรอดแคส = ยอดรวมเดือนนี้ − ข้อความที่ระบบเราส่งเดือนนี้
 *
 * ⚠️ ข้อจำกัดที่ต้องบอกตรง ๆ: ระบบไม่ได้บันทึกว่าข้อความไหนส่งด้วย reply (LINE ไม่คิดเงิน)
 * หรือ push (คิดเงิน) ตัวเลข "AI ส่ง" จึงเป็นจำนวนข้อความที่บอทส่งจริง ซึ่งมากกว่าหรือเท่ากับ
 * จำนวนที่กินโควตาจริง ผลคือส่วนบรอดแคสที่คำนวณได้เป็นค่า "อย่างต่ำ" ไม่ใช่ค่าเป๊ะ
 */
export function splitLineUsage({ monthTotalUsage = null, monthAiMessages = 0 } = {}) {
  const total = num(monthTotalUsage);
  const ai = Math.max(0, num(monthAiMessages, 0));
  if (total == null) {
    return { totalMsgs: null, aiMsgs: ai, broadcastMsgs: null, aiExceedsTotal: false };
  }
  // AI มากกว่ายอดรวมได้จริง เพราะข้อความที่ตอบด้วย reply ไม่กินโควตา — ไม่ใช่ข้อมูลเพี้ยน
  const aiExceedsTotal = ai > total;
  return {
    totalMsgs: total,
    aiMsgs: ai,
    broadcastMsgs: Math.max(0, total - ai),
    aiExceedsTotal,
  };
}

/**
 * ค่าส่งข้อความ LINE ของช่วงที่เลือก
 *
 * ข้อมูลที่ LINE ให้มีแค่ "ยอดรวมตั้งแต่ต้นเดือนถึงตอนนี้" ก้อนเดียว ไม่มีรายวันและไม่มีย้อนเดือน
 * จึงคิดจากส่วนที่ช่วงที่เลือก "ทับ" กับช่วงที่เรามีข้อมูลเท่านั้น:
 * - ทับไม่โดนเลย (เช่นเลือกวันของเดือนก่อน) = ไม่รู้ ต้องคืน null ห้ามเอายอดเดือนนี้ไปตอบแทน
 * - ทับบางส่วน = เฉลี่ยรายวันจากยอดเดือนนี้ แล้วบอกด้วยว่าครอบคลุมช่วงที่เลือกกี่เปอร์เซ็นต์
 * - ตรงกันพอดีทั้งช่วง = ยอดจริง ไม่ต้องติดป้ายประมาณ
 */
export function lineCostForWindow({
  split, ratePerMsg = DEFAULT_LINE_RATE_THB,
  windowStartMs = null, windowEndMs = null, monthStartMs = null, nowMs = null,
} = {}) {
  const rate = Math.max(0, num(ratePerMsg, DEFAULT_LINE_RATE_THB));
  const blank = { thb: null, windowMsgs: null, estimated: false, coverage: 0, ratePerMsg: rate, reason: "" };
  if (!split || split.totalMsgs == null) return { ...blank, reason: "อ่านโควตา LINE ไม่ได้" };

  const wStart = num(windowStartMs);
  const wEnd = num(windowEndMs);
  const mStart = num(monthStartMs);
  const tNow = num(nowMs);
  if (wStart == null || wEnd == null || mStart == null || tNow == null) return { ...blank, reason: "ช่วงเวลาไม่ครบ" };

  const knownMs = Math.max(0, tNow - mStart);          // ช่วงที่ LINE มีข้อมูลให้ = ต้นเดือน -> ตอนนี้
  const windowMs = Math.max(0, wEnd - wStart);
  const overlapMs = Math.max(0, Math.min(wEnd, tNow) - Math.max(wStart, mStart));
  if (knownMs <= 0 || windowMs <= 0) return { ...blank, reason: "ช่วงเวลาสั้นเกินไป" };
  if (overlapMs <= 0) {
    // เลือกวันของเดือนก่อน — โควตาเดือนนี้ตอบแทนไม่ได้ และห้ามแกล้งตอบ
    return { ...blank, reason: "LINE ให้ยอดเฉพาะเดือนปัจจุบัน จึงไม่มีข้อมูลของช่วงนี้" };
  }

  const windowMsgs = split.totalMsgs * (overlapMs / knownMs);
  const coverage = overlapMs / windowMs;
  return {
    thb: windowMsgs * rate,
    windowMsgs,
    coverage,
    // ตรงกันพอดีทั้งสองด้านเท่านั้นถึงเรียกว่ายอดจริง
    estimated: !(overlapMs === windowMs && overlapMs === knownMs),
    ratePerMsg: rate,
    reason: coverage < 1 ? "มีข้อมูล LINE ไม่ครบช่วงที่เลือก" : "",
  };
}

/**
 * ค่าแอดของช่วงที่เลือก เมื่อยังไม่มีข้อมูลรายวันจาก Make
 *
 * ตัวเลขที่กรอกมือเป็น "ยอดรวมของกี่วัน" ก็ได้ (ค่าเริ่มต้น 30) ถ้าเอาไปหารตรง ๆ กับทุกช่วง
 * จะพังทันที: กรอกยอดทั้งเดือนแล้วเลือกดู "เมื่อวาน" = เอายอดแอดทั้งเดือนไปหารรายได้วันเดียว
 * ROAS ที่ได้ต่ำกว่าจริงหลายสิบเท่า และหน้าจอไม่ได้บอกว่ามันผิด
 *
 * จึงเฉลี่ยรายวันแล้วคูณจำนวนวันของช่วงที่เลือก พร้อมติดป้ายว่าเป็นค่าประมาณเสมอ
 */
export function manualAdsForWindow({ adsThb = null, adsWindowDays = 30, windowDays = 30 } = {}) {
  const total = num(adsThb);
  if (total == null) return { thb: null, estimated: false };
  const basis = Math.max(1, num(adsWindowDays, 30) || 30);
  const days = Math.max(0, num(windowDays, 30));
  return {
    thb: Math.max(0, total) * (days / basis),
    // ตรงกันพอดีเท่านั้นถึงไม่ใช่ค่าประมาณ
    estimated: days !== basis,
    basisDays: basis,
  };
}

/**
 * รวมทุกอย่างเป็นตัวเลขเดียว — ทุกช่องเป็นบาท
 * revenueByChannel ใช้แค่โชว์ในวงเล็บ ไม่ได้เอาไปหาร (พี่ง้วงขอ ROAS รวมทั้งบริษัท)
 */
export function computeRoas({
  revenueThb = 0,
  revenueByChannel = {},
  adsThb = null,
  aiThb = null,
  lineThb = null,
  miscThb = null,
} = {}) {
  const revenue = Math.max(0, num(revenueThb, 0));
  // ต้นทุนติดลบไม่มีอยู่จริง — พิมพ์ผิดหรือยอดคืนเงินจาก Meta จะทำให้ "กำไรมากกว่ายอดขาย"
  // ซึ่งอ่านแล้วดูเหมือนธุรกิจกำลังไปได้สวย ทั้งที่เป็นข้อมูลเสีย
  const nonNeg = (v) => (v == null ? null : Math.max(0, v));
  const ads = nonNeg(num(adsThb));
  const ai = Math.max(0, num(aiThb, 0));
  const line = nonNeg(num(lineThb));
  // ค่าใช้จ่ายอื่น ๆ ไม่ได้บังคับกรอก — ยังไม่กรอก = 0 และไม่นับว่าข้อมูลขาด
  const misc = Math.max(0, num(miscThb, 0));

  const missing = [];
  if (ads == null) missing.push("ค่าแอด");
  if (line == null) missing.push("ค่าส่งข้อความ LINE");

  const total = (ads ?? 0) + ai + (line ?? 0) + misc;
  const complete = missing.length === 0;
  return {
    revenueThb: revenue,
    revenueByChannel: Object.fromEntries(
      Object.entries(revenueByChannel).map(([key, value]) => [key, Math.max(0, num(value, 0))])
    ),
    costs: { adsThb: ads, aiThb: ai, lineThb: line, miscThb: misc },
    totalCostThb: complete ? total : null,
    // ข้อมูลไม่ครบ = null ไม่ใช่ตัวเลขที่ดูเหมือนใช้ได้ — ROAS ที่ขาดค่าแอดคือ ROAS ที่ผิด
    // ปัดลงเสมอ (ไม่ใช่ปัดใกล้สุด) เพื่อไม่ให้ 0.996 กลายเป็น "1.00x" ซึ่งอ่านว่าเสมอตัว
    // ทั้งที่ขาดทุนอยู่ — ตัวเลขนี้ผิดทางไหนก็ได้ ยกเว้นทางที่ทำให้ดูดีเกินจริง
    roas: complete && total > 0 ? Math.floor((revenue / total) * 100) / 100 : null,
    profitThb: complete ? revenue - total : null,
    // ต้นทุนเป็นศูนย์ = หารไม่ได้ ต้องบอกเหตุผลให้ตรง ไม่ใช่ปล่อยให้หน้าจอเดาว่า "ขาดข้อมูล"
    noCost: complete && total === 0,
    missing,
  };
}
