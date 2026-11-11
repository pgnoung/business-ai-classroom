// brain/gate5bCost.mjs — ประมาณการค่าใช้จ่ายของ G5b **ก่อน** ยิงโมเดล ไม่ใช่หลัง
//
// ที่มาของทุกตัวเลขในไฟล์นี้คือ eval/COST.md ซึ่งวัดจากของจริง ไม่ใช่เดา
// (ประวัติ: ตัวเลขที่เดาเอาเองเคยผิด ~8 เท่า และเจ้าของเป็นคนจ่าย — กติกาที่ COST.md
// เขียนไว้คือ "ห้ามประเมินค่าใช้จ่ายด้วยการเดา วัดจาก llm_usage x model-pricing เสมอ
// แล้วบอกเป็นตัวเลขจริงก่อนรันงานใหญ่")
//
// รูปทรงต้นทุนของ G5b ต่างจากชุดทดสอบเต็ม จึงคิดแยกทีละส่วนตามที่ COST.md สั่งไว้
// ("อย่าเฉลี่ยรวม"):
//   - prompt ของเราคงที่ก้อนใหญ่ (ความรู้+persona ~13.6K tokens) + ท้ายที่เปลี่ยนทุกเทิร์น
//   - เทิร์นแรกของแต่ละรุ่น = cache miss เสมอ (prompt_cache_key ผูกกับ versionId)
//   - เทิร์นถัดไปของรุ่นเดียวกัน = cache hit (วัดจริงได้ 64-79%)
//   - G5b **ไม่รัน scorer** (ด่านไม่ต้องให้คะแนนความสุภาพ) จึงตัด request ไป 45%

/** ค่าที่วัดจริง 2026-08-19/28 — แก้ที่นี่ที่เดียวเมื่อวัดใหม่ แล้วอัปเดต eval/COST.md ให้ตรง */
import { loadModelPricing, pricingById } from '../modelPricing.mjs';
const price = pricingById(loadModelPricing(new URL('../../config/model-pricing.json', import.meta.url), {logger:{}})).get('gpt-6-sol');
export const MEASURED = Object.freeze({
  promptTokens: 16670,      // วัดจริง: prompt ของเทิร์นตอบลูกค้าหนึ่งครั้ง
  cacheableTokens: 13600,   // ส่วนคงที่ (ความรู้ + persona) ที่ cache จับได้ วัดได้ 13,603/13,617
  outputTokens: 600,        // ประมาณจากคำตอบ 2-4 บอลลูน
  draftInUsdPerM: price.inUsdPerM, // GPT-6 standard; same catalog as actual receipts
  draftOutUsdPerM: price.outUsdPerM,
  cacheWriteUsdPerM: price.cacheWriteUsdPerM,
  cachedInputDiscount: 0.1, // cached input ราคาราว 10% ของปกติ (ตัวเดียวกับที่ run-eval ใช้)
  thbPerUsd: 34, // Owner-selected accounting rate, 2026-09-23.
});

/** เพดานจำนวนเทิร์นของ G5b — เพดานคือสิ่งที่ทำให้ค่าใช้จ่ายคาดเดาได้ ไม่ใช่ความหวัง */
export const G5B_CAPS = Object.freeze({
  replayTurns: 3,   // (ก) เทิร์นจริง/golden ที่ scope ตรงกับการ์ดที่แก้
  probes: 2,        // (ค) คำถามจาก question_th ของการ์ดที่แก้ + probe ขัดแย้ง
  rerunPairs: 2,    // ทุกความต่างถูกรันซ้ำหนึ่งครั้งก่อนนับ (แบบแปลน §7 G5b)
  versions: 2,      // ต้องยิงทั้งรุ่น live และรุ่นใหม่ ไม่งั้นไม่มีอะไรให้เทียบ
});

export function usdPerPrompt({ cached }) {
  const m = MEASURED;
  const fresh = cached ? m.promptTokens - m.cacheableTokens : m.promptTokens;
  const cachedTokens = cached ? m.cacheableTokens : 0;
  return (fresh / 1e6) * m.draftInUsdPerM
    + (cached ? 0 : m.cacheableTokens / 1e6 * (m.cacheWriteUsdPerM - m.draftInUsdPerM))
    + (cachedTokens / 1e6) * m.draftInUsdPerM * m.cachedInputDiscount
    + (m.outputTokens / 1e6) * m.draftOutUsdPerM;
}

/**
 * ประมาณการต่อการเผยแพร่หนึ่งครั้ง — คืนทั้งตัวเลขและ "วิธีคิด" เพื่อให้คนตรวจทานได้
 *
 * @param {{replayTurns?: number, probes?: number, rerunPairs?: number}} plan จำนวนจริงที่จะยิง
 */
export function estimateG5bCost(plan = {}) {
  const caps = G5B_CAPS;
  const replay = clamp(plan.replayTurns, caps.replayTurns);
  const probes = clamp(plan.probes, caps.probes);
  const reruns = clamp(plan.rerunPairs, caps.rerunPairs);
  const perVersion = replay + probes;
  // เทิร์นแรกของแต่ละรุ่น miss เสมอ (คนละ prompt_cache_key) ที่เหลือ hit
  const missPrompts = perVersion > 0 ? caps.versions : 0;
  const hitPrompts = Math.max(0, perVersion * caps.versions - missPrompts) + reruns * caps.versions;
  const usd = missPrompts * usdPerPrompt({ cached: false }) + hitPrompts * usdPerPrompt({ cached: true });
  const thb = usd * MEASURED.thbPerUsd;
  return {
    prompts: missPrompts + hitPrompts,
    missPrompts,
    hitPrompts,
    usd: Number(usd.toFixed(4)),
    thb: Number(thb.toFixed(2)),
    // ข้อความที่ขึ้นหน้าจอ **ก่อน** ยิง — ไม่ใช่ใบเสร็จหลังจ่าย
    thaiSummary: `ด่านทดสอบกับโมเดลจริงรอบนี้จะยิง ${missPrompts + hitPrompts} คำขอ`
      + ` (รุ่นที่ใช้อยู่ ${perVersion + reruns} · รุ่นใหม่ ${perVersion + reruns})`
      + ` ประมาณ ${Math.round(thb)} บาท ใช้เวลาราว 1 นาที`,
    workings: [
      `เทิร์นที่เล่นซ้ำ ${replay} + probe ${probes} = ${perVersion} คำขอต่อรุ่น x ${caps.versions} รุ่น`,
      `รันซ้ำความต่าง ${reruns} คู่ = ${reruns * caps.versions} คำขอ`,
      `cache miss ${missPrompts} คำขอ x ${MEASURED.promptTokens.toLocaleString()} tokens`,
      `cache hit ${hitPrompts} คำขอ (จ่ายเต็มเฉพาะ ${(MEASURED.promptTokens - MEASURED.cacheableTokens).toLocaleString()} tokens)`,
      `รวม ${usd.toFixed(3)} USD x ${MEASURED.thbPerUsd} = ${thb.toFixed(2)} บาท`,
    ],
  };
}

function clamp(value, cap) {
  const n = Math.max(0, Math.trunc(Number(value) || 0));
  return Math.min(n, cap);
}
