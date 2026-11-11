// adSpendSummary.mjs — การ์ด "ค่าแอด" ใบใหญ่บนหน้าแรก (พี่ง้วง 7 ต.ค. 2026: "ปรับ dashboard ค่าแอดในหน้าแรก
// ให้เห็นชัดเจน ใหญ่ๆ ดูง่าย สะดุดตา")
//
// รวมตัวเลขที่เจ้าของต้องเห็นทุกเช้าไว้ในคำขอเดียว — อ่านอย่างเดียว:
//   ค่าแอดเมื่อวาน / 7 วัน / เดือนนี้ (ads_spend ที่ Make ยิงยอดของเมื่อวานทุกเช้า 05:00 — ไม่มียอด "วันนี้")
//   ห้องจากแอด 7 วัน → ถึงราคา/เลือกรอบ → จ่าย (dbAdReferrals.adReferralReport) · ต้นทุนต่อห้อง/ต่อคนจ่าย
//   ยอดขายเดือนนี้ ÷ ค่าแอดเดือนนี้ (ROAS ค่าแอดอย่างเดียว — ROAS เต็มที่หักทุกต้นทุนอยู่ในแผงทีม)
//   กราฟค่าแอดรายวัน 14 วัน
// ตัวเลขเงินทั้งหมด = ของเจ้าของเท่านั้น (เส้นนี้กันด้วย finance.view เหมือนหน้า ROAS)
import { bangkokDayStartMs, bangkokMonthStartMs } from "./bangkokTime.mjs";

const DAY_MS = 86_400_000;
const BKK_OFFSET_MS = 7 * 3_600_000;
export const AD_SPEND_SERIES_DAYS = 14;

const bangkokDay = (ms) => new Date(ms + BKK_OFFSET_MS).toISOString().slice(0, 10);
const round = (value) => Math.round(Number(value) || 0);

/** ช่วงวันแบบรวมปลาย [fromDay, toDay] — คืนยอด + มีข้อมูลครบทุกวันไหม */
function spendRange(db, fromDay, toDay, expectedDays) {
  if (expectedDays <= 0 || fromDay > toDay) return { thb: 0, days: 0, expectedDays: 0, complete: true };
  const { totalThb, days } = db.adsSpendBetween(fromDay, toDay);
  return { thb: round(totalThb), days, expectedDays, complete: days >= expectedDays };
}

export function buildAdSpendSummary(db, nowMs = Date.now()) {
  const yesterday = bangkokDay(nowMs - DAY_MS);
  const weekStart = bangkokDay(nowMs - 7 * DAY_MS);
  const monthStartMs = bangkokMonthStartMs(nowMs);
  const monthStart = bangkokDay(monthStartMs);
  // วันที่ 1 ของเดือน: ยังไม่มีวันเต็มของเดือนนี้ให้นับ
  const monthDays = Math.max(0, Math.round((Date.parse(`${yesterday}T00:00:00Z`) - Date.parse(`${monthStart}T00:00:00Z`)) / DAY_MS) + 1);

  const spend = {
    yesterday: { day: yesterday, ...spendRange(db, yesterday, yesterday, 1) },
    last7: { fromDay: weekStart, toDay: yesterday, ...spendRange(db, weekStart, yesterday, 7) },
    month: { fromDay: monthStart, toDay: yesterday, ...spendRange(db, monthStart, yesterday, monthDays) },
  };

  // กราฟ 14 วัน (เก่า → ใหม่) · วันที่ไม่มีข้อมูล = null (คนละความหมายกับ ฿0)
  const byDay = new Map(db.listAdsSpend(AD_SPEND_SERIES_DAYS + 5).map((row) => [row.day, row]));
  const series = [];
  for (let i = AD_SPEND_SERIES_DAYS; i >= 1; i -= 1) {
    const day = bangkokDay(nowMs - i * DAY_MS);
    const row = byDay.get(day);
    series.push({ day, thb: row ? round(row.spend_thb) : null });
  }
  const updatedAt = Math.max(0, ...[...byDay.values()].map((row) => Number(row.updated_at) || 0)) || null;

  // ห้องจากแอด 7 วัน (นับให้แอดตัวแรกของห้อง · ผลลัพธ์นับเฉพาะที่เกิดหลังคลิก — นิยามเดียวกับรายงานรายแอด)
  let funnel = null;
  try {
    const report = db.adReferralReport({ sinceMs: nowMs - 7 * DAY_MS, untilMs: nowMs });
    funnel = {
      rooms: report.totals.roomsOpened,
      newRooms: report.totals.newRooms,
      reachedPrice: report.totals.reachedPriceOrRound,
      paid: report.totals.paid,
      notQualified: report.totals.notQualified,
    };
  } catch {
    funnel = null;
  }
  const perRoom = funnel?.rooms && spend.last7.complete ? round(spend.last7.thb / funnel.rooms) : null;
  const perPaid = funnel?.paid && spend.last7.complete ? round(spend.last7.thb / funnel.paid) : null;

  // ยอดขายเดือนนี้ "ถึงเมื่อวาน" (ช่วงเดียวกับค่าแอด — รีวิว 7 ต.ค.) · นับเหมือนแผง ROAS: confirmed ขึ้นไป
  const revenueMonth = round((db.revenueByChannelSince(monthStartMs, bangkokDayStartMs(nowMs)) || []).reduce((sum, row) => sum + (Number(row.revenue) || 0), 0));
  const roasMonth = spend.month.complete && spend.month.thb > 0 ? Math.floor((revenueMonth / spend.month.thb) * 100) / 100 : null;

  return {
    spend, series, updatedAt, funnel,
    perRoom, perPaid,
    revenueMonth, roasMonth,
    hasData: db.hasAnyAdsSpend(),
  };
}
