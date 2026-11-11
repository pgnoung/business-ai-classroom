// fxRate.mjs — B8: อัตราแลกเปลี่ยน USD -> THB สดจาก open.er-api.com (ฟรี ไม่ใช้ key)
//
// กติกา:
// - cache ใน DB settings: fx_thb_per_usd + fx_fetched_at (epoch ms)
// - อายุเกิน 12 ชม. -> refresh แบบ fire-and-forget ตอนมีคนอ่านค่า (lazy)
//   ห้าม block response เด็ดขาด — รอบนี้ใช้ค่าที่มีไปก่อน รอบหน้าได้ค่าใหม่
// - fetch พังทุกแบบ = เงียบ (log debug) แล้วไล่ fallback: cache -> env THB_PER_USD -> 36
// - FX_LIVE=false = escape hatch ใช้ env อย่างเดียว ไม่ยิง network เลย

const FX_URL = "https://open.er-api.com/v6/latest/USD";
const FX_TIMEOUT_MS = 10_000;
export const FX_MAX_AGE_MS = 12 * 3_600_000;
const FX_DEFAULT = 36;

export function createFxRate({
  config,
  db,
  fetchImpl = (...args) => globalThis.fetch(...args),
  logger = console,
  now = Date.now,
}) {
  let refreshing = false; // กันยิงซ้อนตอนหลาย request อ่านพร้อมกัน

  async function fetchLive() {
    let res;
    try {
      res = await fetchImpl(FX_URL, { method: "GET", signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
    } catch (err) {
      logger.debug?.(`fxRate: ดึงอัตราแลกเปลี่ยนล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return null;
    }
    if (!res?.ok) {
      logger.debug?.(`fxRate: endpoint ตอบ status ${res?.status ?? "?"}`);
      return null;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      return null;
    }
    const rate = Number(data?.rates?.THB);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return rate;
  }

  // ดึงสด + เขียน cache — คืน rate หรือ null (ไม่มี throw หลุด)
  async function refresh() {
    if (refreshing) return null;
    refreshing = true;
    try {
      const rate = await fetchLive();
      if (rate !== null) {
        try {
          db.setSetting("fx_thb_per_usd", String(rate));
          db.setSetting("fx_fetched_at", String(now()));
        } catch (err) {
          logger.debug?.(`fxRate: เขียน cache ไม่สำเร็จ (${err?.message || err})`);
        }
      }
      return rate;
    } finally {
      refreshing = false;
    }
  }

  // อ่านค่าปัจจุบันแบบ sync จาก cache — แก่เกิน 12 ชม./ไม่มีค่า = trigger refresh เบื้องหลัง
  // คืน { thbPerUsd, source: "live"|"env", fetchedAt }
  function current() {
    const envRate = Number(config.thbPerUsd) > 0 ? Number(config.thbPerUsd) : FX_DEFAULT;
    if (config.fxLive === false) {
      return { thbPerUsd: envRate, source: "env", fetchedAt: null };
    }

    let cached = null;
    let fetchedAt = null;
    try {
      cached = Number(db.getSetting("fx_thb_per_usd"));
      fetchedAt = Number(db.getSetting("fx_fetched_at"));
    } catch {
      cached = null;
    }
    const hasCache = Number.isFinite(cached) && cached > 0;
    const age = Number.isFinite(fetchedAt) && fetchedAt > 0 ? now() - fetchedAt : Infinity;
    if (!hasCache || age > FX_MAX_AGE_MS) {
      refresh().catch(() => {}); // fire-and-forget — response นี้ไม่รอ
    }
    if (hasCache) {
      return { thbPerUsd: cached, source: "live", fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null };
    }
    return { thbPerUsd: envRate, source: "env", fetchedAt: null };
  }

  return { current, refresh };
}
