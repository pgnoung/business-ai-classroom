// purchaseHistory.mjs — "ซื้อครั้งที่" + "ซื้อล่าสุด" ต่อห้อง (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//
// พี่ง้วง: "อยากให้มี chat tag ซื้อครั้งที่เท่าไหร่ (ซื้อครั้งแรก ซื้อครั้งที่สอง...), (ซื้อเมื่อไหร่ , เดือน+ปี , Sep2026)
//  ไว้ด้วย และ 2 หมวดนี้ ให้ dynamic ตามรอบล่าสุดที่มาซื้อกับเรา จะได้ ทำ RFM ง่ายๆ"
//
// หลักฐานสองแหล่ง:
//   1. ออเดอร์ในระบบนี้ที่ "ซื้อจริง" (confirmed/paid/shipped/done — ชุดเดียวกับยอดขาย) เดือน = วันสร้างออเดอร์ (เวลาไทย)
//   2. ป้ายที่ทีมติดไว้ใน LINE OA เดิม (source human): ป้ายนับครั้ง "ซื้อครั้งแรก/ซื้อครั้งที่สอง…"
//      + ป้ายเดือน "ม.ค.2023" (พี่ง้วงยืนยัน = เดือน+ปีที่ซื้อ) — ข้อมูลจริง 28 ก.ย.: ทุกห้องมีป้ายนับครั้ง
//      ใบเดียวและป้ายเดือนใบเดียว = ระบบเดิมเปลี่ยนป้ายทุกครั้งที่ซื้อใหม่ ป้ายเดือนจึงเป็น "เดือนที่ซื้อล่าสุด"
//
// กติกากันนับซ้ำ (การซื้อหนึ่งครั้งที่อยู่ทั้งในป้ายเดิมและในออเดอร์):
//   H  = จำนวนครั้งจากป้ายเดิม = max(เลขในป้ายนับครั้ง, จำนวนเดือนที่ต่างกันในป้ายเดือน)
//   Mh = เดือนล่าสุดในป้ายเดือน (ไม่มี = ไม่รู้ว่าป้ายเดิมนับถึงเมื่อไหร่)
//   ออเดอร์ที่เดือน <= Mh ถือว่าอยู่ใน H แล้ว (สูงสุด H ออเดอร์) · ออเดอร์หลัง Mh นับเพิ่มทีละครั้ง
//   ครั้งที่ = H + ออเดอร์หลัง Mh + max(0, ออเดอร์ที่เดือน <= Mh − H)
//   ไม่มี Mh แต่มี H (มีแต่ป้ายนับครั้ง) = ถือว่าป้ายเดิมเก่ากว่าออเดอร์ทุกใบ → H + ออเดอร์ทั้งหมด (นับเป็นกรณีกำกวม)
//   ซื้อล่าสุด = เดือนที่ใหม่สุดระหว่าง Mh กับเดือนของออเดอร์ · ไม่มีทั้งคู่ = ไม่ติดป้ายซื้อล่าสุด
// flags บอกกรณีกำกวมให้เครื่องมือแปลงนับเป็นยอดรวม (ไม่มีผลกับตัวเลขที่ติด)
//
// โมดูลนี้บริสุทธิ์ (ไม่มี I/O) — tags.mjs ต่อเข้ากับฐาน, tools/tag-framework-convert.mjs ใช้ตัวเดียวกัน

import { cleanTagText, formatFrameworkTag } from "./tagFramework.mjs";

export const PURCHASED_ORDER_STATUSES = Object.freeze(["confirmed", "paid", "shipped", "done"]);
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const MONTHS_EN = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
// ป้ายเดือนไทยแบบย่อ (ตัดจุด/ช่องว่างก่อนเทียบ) — "ม.ค.2023" "ก.ค. 2026" "มค2023" ได้ทั้งหมด
const THAI_MONTHS = Object.freeze({ มค: 1, กพ: 2, มีค: 3, เมย: 4, พค: 5, มิย: 6, กค: 7, สค: 8, กย: 9, ตค: 10, พย: 11, ธค: 12 });
const THAI_MONTH_TAG = /^(มค|กพ|มีค|เมย|พค|มิย|กค|สค|กย|ตค|พย|ธค)(\d{4})$/u;
const DIGIT_COUNT_TAG = /^ซื้อครั้งที่\s*(\d{1,2})$/u;

/** เดือนตามเวลาไทยของ timestamp (ms) → "YYYY-MM" */
export function bangkokMonthKey(ms) {
  const date = new Date(Number(ms) + BANGKOK_OFFSET_MS);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "2026-09" → "Sep2026" (รูปแบบเดียวกับที่พี่ง้วงยกตัวอย่าง) */
export function formatPurchaseMonth(monthKey) {
  const match = /^(\d{4})-(\d{2})$/u.exec(String(monthKey || ""));
  if (!match) return "";
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${MONTHS_EN[month - 1]}${match[1]}` : "";
}

/** ป้ายเดือนไทยของ LINE OA เดิม → "YYYY-MM" หรือ "" (ปี พ.ศ. แปลงเป็น ค.ศ. ให้) */
export function parseThaiMonthTag(tag) {
  const compact = cleanTagText(tag).replace(/[.\s]/gu, "");
  const match = THAI_MONTH_TAG.exec(compact);
  if (!match) return "";
  let year = Number(match[2]);
  if (year >= 2400) year -= 543;
  if (year < 2000 || year > 2100) return "";
  return `${year}-${String(THAI_MONTHS[match[1]]).padStart(2, "0")}`;
}

/** ป้ายนับครั้งของ LINE OA เดิม ("ซื้อครั้งแรก" หรือ "ซื้อครั้งที่ 3") → เลข หรือ 0 */
export function parseCountTag(tag, countTags) {
  const clean = cleanTagText(tag);
  const mapped = countTags?.get?.(clean);
  if (mapped) return mapped;
  const digits = DIGIT_COUNT_TAG.exec(clean);
  const n = digits ? Number(digits[1]) : 0;
  return n >= 1 && n <= 99 ? n : 0;
}

/** ป้ายนี้บอกว่า "ซื้อแล้ว" แต่ไม่บอกจำนวนครั้ง — ป้ายคลาสที่เคยซื้อจาก LINE OA เดิม หรือ customer (28 ก.ย. 2026) */
export function isBuyerEvidenceTag(tag, purchase) {
  if (!purchase) return false;
  const clean = cleanTagText(tag);
  return (purchase.buyerExact || []).includes(clean) || (purchase.buyerTagRes || []).some((re) => re.test(clean));
}

/** ป้ายนี้เป็นหลักฐานการซื้อจากประวัติเดิมไหม (ใช้ตัดสินว่าต้องคำนวณใหม่หลังคนติด/ถอดป้าย) */
export function isPurchaseEvidenceTag(tag, purchase) {
  if (!purchase) return false;
  return parseCountTag(tag, purchase.countTags) > 0 || (purchase.legacyMonthTags && Boolean(parseThaiMonthTag(tag)))
    || isBuyerEvidenceTag(tag, purchase);
}

/**
 * สรุปการซื้อของห้องหนึ่ง
 * @param {{ orderTimes?: number[], humanTags?: string[], purchase: object }} input
 *   orderTimes = created_at ของออเดอร์ที่ซื้อจริงเท่านั้น (คัดสถานะมาแล้ว) · humanTags = ป้าย source human
 * @returns {{ count: number, lastMonth: string, historyCount: number, historyMonth: string, orders: number, flags: object }}
 */
export function summarizePurchases({ orderTimes = [], humanTags = [], purchase }) {
  let ordinal = 0;
  const months = new Set();
  for (const tag of humanTags) {
    ordinal = Math.max(ordinal, parseCountTag(tag, purchase?.countTags));
    const month = purchase?.legacyMonthTags ? parseThaiMonthTag(tag) : "";
    if (month) months.add(month);
  }
  const historyCount = Math.max(ordinal, months.size);
  const historyMonth = [...months].sort().at(-1) || "";
  // เวลาออเดอร์ผิดรูป/เป็น 0 = ข้าม (ห้ามกลายเป็นการซื้อเดือน ม.ค. 1970)
  const orderMonths = orderTimes.filter((t) => Number(t) > 0).map(bangkokMonthKey).filter(Boolean).sort();

  let atOrBefore = 0;
  let after = 0;
  for (const month of orderMonths) {
    if (historyMonth && month <= historyMonth) atOrBefore += 1;
    else after += 1;
  }
  const absorbed = Math.min(atOrBefore, historyCount);
  const counted = historyCount + after + (atOrBefore - absorbed);
  // พี่ง้วง 28 ก.ย. 2026: คนที่ซื้อแล้วต้องมี "ซื้อครั้งที่" เสมอ — มีแต่ป้ายคลาสที่ซื้อ/customer = อย่างน้อยครั้งที่ 1
  const markerOnly = counted === 0 && humanTags.some((tag) => isBuyerEvidenceTag(tag, purchase));
  const count = markerOnly ? 1 : counted;
  const lastMonth = [historyMonth, orderMonths.at(-1) || ""].filter(Boolean).sort().at(-1) || "";

  const nextMonth = (key) => {
    const [y, m] = key.split("-").map(Number);
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  };
  const flags = {
    // มีทั้งป้ายเดิมและออเดอร์ในห้องเดียวกัน
    bothSources: historyCount > 0 && orderMonths.length > 0,
    // ออเดอร์ที่ถูกนับรวมในป้ายเดิมแล้ว (เดือนเดียวกับหรือก่อนป้ายเดือน)
    absorbedOrders: absorbed,
    // ออเดอร์เดือนถัดจากป้ายเดือนพอดี — อาจเป็นการซื้อครั้งเดียวกันที่ลงระบบช้า (นับแยกตามกติกา)
    adjacentMonth: Boolean(historyMonth) && orderMonths.includes(nextMonth(historyMonth)),
    // มีป้ายนับครั้งแต่ไม่มีป้ายเดือนเลย และมีออเดอร์ด้วย — ไม่รู้ว่าป้ายเดิมนับออเดอร์ไปแล้วหรือยัง
    countWithoutMonthAndOrders: ordinal > 0 && !historyMonth && orderMonths.length > 0,
    // รู้ว่าซื้อแต่ไม่รู้เดือน (มีแต่ป้ายนับครั้ง) — ไม่ติดป้ายซื้อล่าสุด
    noDate: count > 0 && !lastMonth,
    // ป้ายเดือนมากกว่าเลขในป้ายนับครั้ง (ข้อมูลเดิมไม่ตรงกัน — ใช้ค่าที่มากกว่า)
    monthsExceedCount: ordinal > 0 && months.size > ordinal,
    // รู้แค่ว่าซื้อแล้ว (ป้ายคลาสที่ซื้อ/customer) ไม่มีเลขครั้ง/เดือน/ออเดอร์ = นับเป็นครั้งที่ 1 ไม่ติดซื้อล่าสุด
    markerOnly,
  };
  return { count, lastMonth, historyCount, historyMonth, orders: orderMonths.length, flags };
}

/** ป้ายของระบบจากสรุปการซื้อ — ค่าเดียวต่อมิติ ไม่มีการซื้อ = [] */
export function purchaseTagsFor(summary, purchase) {
  if (!purchase || !summary || summary.count < 1) return [];
  const tags = [formatFrameworkTag(purchase.countDimension, String(summary.count))];
  const month = formatPurchaseMonth(summary.lastMonth);
  if (month) tags.push(formatFrameworkTag(purchase.lastDimension, month));
  return tags;
}
