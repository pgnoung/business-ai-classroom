// consoleAdReferralsApi.mjs — GET /console/api/roas/ad-referrals (คำสั่งพี่ง้วง 6 ต.ค. 2026)
//
// "แอดตัวไหนพาคนแบบไหนมา": ต่อแอดหนึ่งตัวในช่วงวันที่ — ห้องเปิดจากแอด · ถูกคัดว่าไม่เข้าเกณฑ์ (สีเหลือง) ·
// ถึงขั้นราคา/เลือกรอบ · จ่าย/ลงเรียน (นิยามอยู่ที่ dbAdReferrals.mjs + test/ad-referral-report.test.mjs)
//
// ช่วงเวลา (ขอบวันเวลาไทย เหมือนหน้า ROAS):
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   รวมทั้งสองวัน · ยาวไม่เกิน 92 วัน
//   ?date=YYYY-MM-DD                 วันเดียว
//   ?days=N                          ย้อนหลัง N วันถึงตอนนี้ (1–92 · ไม่ส่งอะไร = 30)
// เพดาน 92 วัน: คิวรีรันแบบ synchronous บน event loop เดียวกับแชทลูกค้า (รีวิว 6 ต.ค.: ช่วง 365 วัน ~0.5–3 วิ)
//
// อ่านอย่างเดียว ไม่มีเส้นเขียน · สิทธิ์ finance.view (เจ้าของ) เท่าหน้า ROAS — ผลแอดเป็นตัวเลขธุรกิจของเจ้าของ
// root "roas" ไม่อยู่ใน allowlist ของทีมงาน (operatorRoles.mjs) จึงกันสองชั้นเหมือนเส้น ROAS เดิม
// คำตอบมีแต่ตัวเลขรวมต่อแอด — ไม่มี id ลูกค้า ชื่อ หรือข้อความแชท
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { adReferralCaptureMode } from "./adReferral.mjs";
import { buildAdSpendSummary } from "./adSpendSummary.mjs";

const DAY_MS = 86_400_000;
const BKK_OFFSET_MS = 7 * 3_600_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
export const AD_REFERRAL_MAX_DAYS = 92;
const DENY_VIEW = "เฉพาะเจ้าของเท่านั้นที่ดูผลลัพธ์รายแอดได้";

const bangkokDay = (ms) => new Date(ms + BKK_OFFSET_MS).toISOString().slice(0, 10);

/** เที่ยงคืนเวลาไทยของวันนั้น — วันที่ไม่มีจริง (2026-02-30, 2026-13-01) = null */
function bangkokMidnight(day) {
  if (!DAY_PATTERN.test(String(day || ""))) return null;
  const ms = Date.parse(`${day}T00:00:00+07:00`);
  if (!Number.isFinite(ms) || bangkokDay(ms) !== day) return null;
  return ms;
}

/** แปลง query เป็นช่วง [sinceMs, untilMs) — คืน { ok, error } เมื่อผิดรูป */
export function resolveAdReferralRange(params, nowMs = Date.now()) {
  const from = params.get("from");
  const to = params.get("to");
  const date = params.get("date");
  if (from !== null || to !== null || date !== null) {
    const fromDay = date ?? from;
    const toDay = date ?? to;
    const sinceMs = bangkokMidnight(fromDay);
    const lastDayMs = bangkokMidnight(toDay);
    if (sinceMs === null || lastDayMs === null) return { ok: false, error: "วันที่ต้องเป็น YYYY-MM-DD ที่มีอยู่จริง" };
    if (lastDayMs < sinceMs) return { ok: false, error: "วันเริ่มต้องไม่หลังวันสิ้นสุด" };
    const untilMs = lastDayMs + DAY_MS;
    if ((untilMs - sinceMs) / DAY_MS > AD_REFERRAL_MAX_DAYS) {
      return { ok: false, error: `เลือกช่วงได้ไม่เกิน ${AD_REFERRAL_MAX_DAYS} วัน` };
    }
    return { ok: true, from: fromDay, to: toDay, sinceMs, untilMs };
  }
  const rawDays = params.get("days");
  const days = rawDays === null || rawDays === "" ? 30 : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > AD_REFERRAL_MAX_DAYS) {
    return { ok: false, error: `ย้อนหลังได้ 1–${AD_REFERRAL_MAX_DAYS} วัน` };
  }
  const sinceMs = nowMs - days * DAY_MS;
  return { ok: true, from: bangkokDay(sinceMs), to: bangkokDay(nowMs), sinceMs, untilMs: nowMs };
}

export function createConsoleAdReferralRoutes({ db, now = Date.now, logger = console } = {}) {
  // 6 ต.ค. 2026 ค่ำ: สำเนารูปแอด (ad_thumbs) สำหรับแถบ "มาจากโฆษณา" — ทุกคนที่เปิดห้องแชทได้เห็นรูปแอดได้
  // รูปแอดของเพจเราเอง ไม่ใช่ไฟล์ลูกค้า · ต้องผ่าน session คอนโซลเหมือนเส้นอื่น (root อยู่ใน STAFF_ROUTE_ROOTS)
  function serveAdThumb(req, res, route, json) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { ok: false, error: "method ไม่รองรับ" });
      return true;
    }
    const adId = String(route[1] || "");
    const thumb = /^\d{1,32}$/u.test(adId) ? db.adThumbFor?.(adId) : null;
    if (!thumb) {
      json(res, 404, { ok: false, error: "ไม่พบรูปแอด" });
      return true;
    }
    const etag = `"${thumb.sha256}"`;
    const headers = {
      etag, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    if (String(req.headers["if-none-match"] || "") === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    const bytes = Buffer.from(thumb.bytes);
    res.writeHead(200, { ...headers, "content-type": thumb.content_type, "content-length": bytes.length });
    res.end(req.method === "HEAD" ? undefined : bytes);
    return true;
  }

  // 7 ต.ค. 2026: การ์ด "ค่าแอด" ใบใหญ่บนหน้าแรก (adSpendSummary.mjs) — ตัวเลขเงินของเจ้าของ กันเท่าหน้า ROAS
  function serveAdSummary(req, res, ctx) {
    const { json, operator } = ctx;
    if (!hasOperatorCapability(operator, "finance.view")) {
      json(res, 403, { ok: false, error: DENY_VIEW });
      return true;
    }
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method ไม่รองรับ" });
      return true;
    }
    try {
      json(res, 200, { ok: true, ...buildAdSpendSummary(db, now()) });
    } catch (err) {
      logger.warn?.(`ad-summary: ประกอบการ์ดค่าแอดไม่สำเร็จ (${err?.message || err})`);
      json(res, 500, { ok: false, error: "อ่านสรุปค่าแอดไม่สำเร็จ" });
    }
    return true;
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] === "ad-thumbs" && route.length === 2) return serveAdThumb(req, res, route, ctx.json);
    if (route[0] === "roas" && route[1] === "ad-summary" && route.length === 2) return serveAdSummary(req, res, ctx);
    if (route[0] !== "roas" || route[1] !== "ad-referrals" || route.length !== 2) return false;
    const { json, operator } = ctx;
    // ก่อนตรวจ method: คนไม่มีสิทธิ์ต้องได้ 403 เดียวกันเสมอ (แบบเดียวกับเส้น ROAS)
    if (!hasOperatorCapability(operator, "finance.view")) {
      json(res, 403, { ok: false, error: DENY_VIEW });
      return true;
    }
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method ไม่รองรับ" });
      return true;
    }
    const range = resolveAdReferralRange(url.searchParams, now());
    if (!range.ok) {
      json(res, 400, { ok: false, error: range.error });
      return true;
    }
    try {
      const report = db.adReferralReport({ sinceMs: range.sinceMs, untilMs: range.untilMs });
      json(res, 200, {
        ok: true,
        range: { from: range.from, to: range.to, sinceMs: range.sinceMs, untilMs: range.untilMs },
        captureMode: adReferralCaptureMode(db),
        report,
      });
    } catch (err) {
      logger.warn?.(`ad-referrals: ประกอบรายงานไม่สำเร็จ (${err?.message || err})`);
      json(res, 500, { ok: false, error: "อ่านรายงานรายแอดไม่สำเร็จ" });
    }
    return true;
  }
  return { handle };
}
