// modelPricing.mjs — B8: ตาราง ราคา/1M token ของโมเดล Hermes + เครื่องคิดเงิน
//
// กติกา:
// - โหลดจาก config/model-pricing.json แบบ tolerant เหมือน config file อื่น:
//   ไฟล์หาย/พัง/รูปทรงผิด = [] (picker ยังโชว์โมเดลปัจจุบันได้ แต่ไม่มีราคา)
// - entry ที่ verified=false หรือราคา null เลือกใช้ได้ แต่ค่าใช้จ่ายโชว์ "—"
//   จนกว่าจะมีคนเติมราคาจริงในไฟล์ — ห้ามเดาราคาแทน
import { existsSync, readFileSync } from "node:fs";

const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function loadModelPricing(file, { logger = console } = {}) {
  if (!file || !existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    logger.warn?.(`modelPricing: อ่านไฟล์ราคาไม่ได้ (${err?.message || err}) — ใช้รายการว่าง`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn?.("modelPricing: ไฟล์ต้องเป็น JSON array — ใช้รายการว่าง");
    return [];
  }
  const entries = [];
  const seen = new Set();
  for (const item of parsed) {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== null && v !== "" ? Number(v) : null);
    entries.push({
      id,
      label: typeof item?.label === "string" && item.label ? item.label : id,
      // v1.4.9: โครงรองรับหลาย provider ในอนาคต — ไฟล์เก่าไม่มี field = openai
      provider: typeof item?.provider === "string" && item.provider.trim() ? item.provider.trim() : "openai",
      inUsdPerM: num(item?.in_usd_per_m),
      outUsdPerM: num(item?.out_usd_per_m),
      // ราคา input ที่ผู้ให้บริการคิดถูกลงเพราะเป็นก้อนเดิมที่แคชไว้ (prompt caching)
      // ไม่ระบุ = null = ไม่รู้ → คิดราคาเต็ม (ปลอดภัยไว้ก่อน ห้ามเดาเป็น 0)
      cachedInUsdPerM: num(item?.cached_in_usd_per_m),
      cacheWriteUsdPerM: num(item?.cache_write_usd_per_m),
      longContextThreshold: num(item?.long_context_threshold),
      longInputMultiplier: num(item?.long_input_multiplier) ?? 1,
      longOutputMultiplier: num(item?.long_output_multiplier) ?? 1,
      verified: item?.verified === true,
    });
  }
  logger.log?.(`modelPricing: โหลดราคาโมเดล ${entries.length} รายการจาก ${file}`);
  return entries;
}

export function pricingById(entries = []) {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

// คิดเงิน USD ของก้อน usage เดียว — โมเดลไม่มีราคา (ไม่รู้จัก/ยัง null) = null ("—")
//
// cachedIn = ส่วนของ input ที่ผู้ให้บริการคิดในราคาแคช (สมองก้อนเดิมที่ส่งซ้ำทุกครั้ง)
// สำคัญกับงานนี้มาก: 7 วันแรกของจริงมี input 3.06M เป็นแคชไปแล้ว 1.2M และราคาแคชถูกกว่า 10 เท่า
// ถ้าไม่นับ ตัวเลขต้นทุนจะสูงเกินจริงเกือบเท่าตัว
export function usageCostUsd({ model, tokensIn = 0, cachedIn = 0, cacheWriteIn = 0, tokensOut = 0, longContext = null }, pricingMap) {
  const p = pricingMap?.get?.(model);
  if (!p || p.verified === false || !Number.isFinite(p.inUsdPerM) || !Number.isFinite(p.outUsdPerM)
    || p.inUsdPerM < 0 || p.outUsdPerM < 0) return null;
  const totalIn = nonnegative(tokensIn);
  // ตัวเลขจาก provider เชื่อไม่ได้ 100% — กันค่าติดลบ/เกินยอดจริงไม่ให้ทำให้บิลเพี้ยน
  const cached = Number.isFinite(p.cachedInUsdPerM)
    ? Math.min(nonnegative(cachedIn), totalIn)
    : 0;
  const written = Math.min(nonnegative(cacheWriteIn), totalIn - cached);
  if (written > 0 && !Number.isFinite(p.cacheWriteUsdPerM)) return null;
  const fullIn = totalIn - cached - written;
  // Threshold belongs to ONE request. SQL aggregates must supply their tier explicitly.
  const isLong = longContext ?? (p.longContextThreshold != null && totalIn > p.longContextThreshold);
  const inMultiplier = isLong ? (p.longInputMultiplier ?? 1) : 1;
  const outMultiplier = isLong ? (p.longOutputMultiplier ?? 1) : 1;
  return (
    (fullIn * p.inUsdPerM
    + cached * (Number.isFinite(p.cachedInUsdPerM) ? p.cachedInUsdPerM : p.inUsdPerM)
    + written * (p.cacheWriteUsdPerM ?? 0)) * inMultiplier
    + nonnegative(tokensOut) * p.outUsdPerM * outMultiplier
  ) / 1_000_000;
}

// รวมแถวจาก db.llmUsageSummary เป็น { usd, unknownTokens, breakdown } — THB คูณฝั่ง caller
export function summarizeUsage(rows = [], pricingMap) {
  let usd = 0;
  let unknownTokens = 0;
  let unknownCacheWriteCalls = 0;
  const breakdown = [];
  for (const row of rows) {
    const tokensIn = nonnegative(row.tokens_in);
    unknownCacheWriteCalls += nonnegative(row.missing_cache_write_calls);
    const tokensOut = nonnegative(row.tokens_out);
    const cachedIn = Math.min(nonnegative(row.cached_in), tokensIn);
    const cacheWriteIn = Math.min(nonnegative(row.cache_write_in), tokensIn - cachedIn);
    const longContext = row.long_context == null ? null : Boolean(row.long_context);
    let cost = usageCostUsd({ model: row.model, tokensIn, cachedIn, cacheWriteIn, tokensOut, longContext }, pricingMap);
    // 28 ก.ย. 2026 (ตรวจจากข้อมูลจริง ก.ย.): ราคาเขียนแคชของ gpt-5.6 ยังไม่ยืนยัน และแถวที่เข้ามาคือผลรวมทั้งเดือน
    // ต่อโมเดล/ชนิดงาน — เขียนแคชแม้ครั้งเดียว ทั้งก้อนเคยกลายเป็น "ไม่ทราบราคา" แล้วหายจากยอด (คอนโซลโชว์ ก.ย.
    // $8.42 ทั้งที่คิดทีละแถวได้ $315.93) คิดส่วนที่รู้ราคาแน่ แล้วแยกเฉพาะ token เขียนแคชเป็น "ยังไม่มีราคา"
    // (ราคาเป็นเชิงเส้น = ผลรวมเท่ากับคิดทีละแถวเสมอ) โมเดลที่ไม่มีราคาเลยยังเป็น null ทั้งก้อนเหมือนเดิม
    let unpricedCacheWriteIn = 0;
    if (cost === null && cacheWriteIn > 0) {
      const known = usageCostUsd({
        model: row.model, tokensIn: tokensIn - cacheWriteIn, cachedIn, cacheWriteIn: 0, tokensOut, longContext,
      }, pricingMap);
      if (known !== null) {
        cost = known;
        unpricedCacheWriteIn = cacheWriteIn;
      }
    }
    breakdown.push({ model: row.model, kind: row.kind ?? "", tokensIn, cachedIn, cacheWriteIn, tokensOut, usd: cost, unpricedCacheWriteIn });
    if (cost === null) unknownTokens += tokensIn + tokensOut;
    else {
      usd += cost;
      unknownTokens += unpricedCacheWriteIn;
    }
  }
  return { usd, unknownTokens, unknownCacheWriteCalls, breakdown };
}
