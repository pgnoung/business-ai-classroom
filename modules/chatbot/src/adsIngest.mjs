// adsIngest.mjs — ปลายทางรับค่าแอด Meta รายวันจาก Make (คำสั่งพี่ง้วง 1 ก.ย. 2026)
//
// Make รันทุกเช้า 05:00 ดึงยอดของ "เมื่อวาน" แล้วยิงเข้ามาที่นี่ เก็บเป็นรายวัน
// หน้า ROAS จึงบวกเฉพาะวันที่อยู่ในช่วงที่เลือกได้ ไม่ว่าจะดูรายวัน 7 วัน หรือ 30 วัน
//
// เส้นนี้อยู่นอก session ของคอนโซล (เครื่องยิงเครื่อง) จึงใช้กุญแจลับใน header
// กติกาที่ตั้งใจ:
// - ยังไม่ตั้งกุญแจ = ปิดสนิท (503) ไม่ใช่เปิดรับทุกคน — fail-closed เสมอ
// - เทียบกุญแจแบบ timing-safe กัน brute force ทีละไบต์
// - วันเดียวกันยิงซ้ำ = ทับ ไม่ใช่บวกเพิ่ม (กัน Make retry แล้วยอดบาน)
import { timingSafeEqual } from "node:crypto";

export const ADS_KEY_SETTING = "ads_ingest_key";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function keyMatches(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  // ความยาวต่างกัน timingSafeEqual โยน error — เทียบความยาวก่อน (ความยาวไม่ใช่ความลับ)
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * ตรวจ payload ก่อนเขียน — คืน { ok, error, value }
 * ยอดติดลบ/ไม่ใช่ตัวเลข/วันที่ผิดรูป ต้องถูกปัดตั้งแต่ตรงนี้ ไม่ใช่ไปโผล่เป็นกำไรเพี้ยนบนหน้าจอ
 */
/** เมื่อวานตามเวลาไทย — ใช้เมื่อผู้ส่งไม่ได้ระบุวัน */
export function yesterdayBangkok(nowMs = Date.now()) {
  return new Date(nowMs + 7 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
}

export function parseAdsPayload(body = {}, nowMs = Date.now()) {
  // ไม่ส่ง day มา = เมื่อวานตามเวลาไทย ซึ่งตรงกับที่ Make ตั้งไว้ (รัน 05:00 ดึงยอดของเมื่อวาน)
  // ตั้งใจให้ฝั่งเซิร์ฟเวอร์คิดวันเอง เพราะสูตรจัดรูปแบบวันที่ใน Make ต้องใส่เครื่องหมายคำพูด
  // ซ้อนกันในบอดี้ JSON ซึ่งพังง่ายและพังแบบเงียบ ๆ (เจอจริงมาแล้วรอบหนึ่ง)
  const rawDay = String(body?.day ?? "").trim();
  const day = rawDay === "" ? yesterdayBangkok(nowMs) : rawDay;
  if (!DAY_PATTERN.test(day)) {
    return { ok: false, error: `day ต้องเป็นรูปแบบ YYYY-MM-DD (ได้รับ "${rawDay.slice(0, 40)}")` };
  }
  const raw = body?.spend ?? body?.spend_thb;
  if (raw === null || raw === undefined || raw === "") return { ok: false, error: "ต้องส่ง spend" };
  const spendThb = Number(raw);
  if (!Number.isFinite(spendThb)) return { ok: false, error: "spend ต้องเป็นตัวเลข" };
  if (spendThb < 0) return { ok: false, error: "spend ติดลบไม่ได้" };
  // กันพิมพ์ผิดหลักจน ROAS เพี้ยนทั้งเดือนโดยไม่มีใครสังเกต
  if (spendThb > 10_000_000) return { ok: false, error: "spend สูงผิดปกติ (เกิน 10 ล้านบาทต่อวัน)" };
  return {
    ok: true,
    value: {
      day,
      spendThb,
      accountId: String(body?.accountId ?? body?.account_id ?? "").slice(0, 64),
      source: String(body?.source ?? "make").slice(0, 32),
    },
  };
}

export function createAdsIngest({ db, json, readJson, logger = console }) {
  async function handle(req, res) {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method ไม่รองรับ" });
      return true;
    }
    const expected = String(db.getSetting(ADS_KEY_SETTING) || "");
    if (!expected) {
      // ยังไม่ตั้งกุญแจ = ยังไม่เปิดใช้ ไม่ใช่เปิดให้ใครก็ยิงได้
      json(res, 503, { ok: false, error: "ยังไม่ได้ตั้งกุญแจรับค่าแอด" });
      return true;
    }
    const provided = req.headers["x-ads-key"];
    if (!keyMatches(Array.isArray(provided) ? provided[0] : provided, expected)) {
      logger.warn?.("adsIngest: กุญแจไม่ถูกต้อง — ปฏิเสธ");
      json(res, 401, { ok: false, error: "กุญแจไม่ถูกต้อง" });
      return true;
    }
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      logger.warn?.(`adsIngest: อ่าน JSON ไม่ได้ — ${err?.message || err}`);
      json(res, 400, { ok: false, error: "อ่าน JSON ไม่ได้" });
      return true;
    }
    const parsed = parseAdsPayload(body, Date.now());
    if (!parsed.ok) {
      // เขียน log ตอนปัดด้วย — ของเดิมเงียบสนิท ทำให้ไล่ปัญหาจากฝั่งเราไม่ได้เลย
      // ว่าผู้ส่งยัดอะไรมา (log เฉพาะ body ไม่แตะ header เพราะกุญแจอยู่ในนั้น)
      logger.warn?.(`adsIngest: ปัดคำขอ — ${parsed.error} | body=${JSON.stringify(body).slice(0, 300)}`);
      json(res, 400, { ok: false, error: parsed.error });
      return true;
    }
    const row = db.upsertAdsSpend({ ...parsed.value, raw: JSON.stringify(body).slice(0, 4000) });
    db.addAudit({
      operator: "make", action: "ads_spend_ingest", target: parsed.value.day,
      detail: `฿${parsed.value.spendThb.toLocaleString("th-TH")} (${parsed.value.accountId || "ไม่ระบุบัญชี"})`,
    });
    logger.log?.(`adsIngest: รับค่าแอดวันที่ ${parsed.value.day} = ฿${parsed.value.spendThb}`);
    json(res, 200, { ok: true, day: row?.day, spendThb: row?.spend_thb });
    return true;
  }
  return { handle };
}
