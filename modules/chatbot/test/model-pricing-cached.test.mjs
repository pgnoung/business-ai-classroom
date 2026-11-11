// ต้นทุนต่อบทสนทนาต้องแม่น (คำสั่งพี่ง้วง 2026-08-31)
//
// สองเรื่องที่ทำให้ตัวเลขเดิมสูงเกินจริงเกือบเท่าตัว:
// 1. ราคา Sol ในไฟล์เป็นราคาลิสต์เก่า ($5/$30) ทั้งที่โปรโมชันจริงคือ $4/$20
// 2. เราส่ง "สมอง" ก้อนเดิมซ้ำทุกครั้ง OpenAI จึงคิดค่า input ที่ซ้ำในราคาแคช (ถูกกว่า 10 เท่า)
//    ฐานข้อมูลเก็บ cached_in ไว้อยู่แล้ว แต่ตัวคิดเงินไม่เคยหยิบมาใช้
//
// กติกาเดิมที่ต้องไม่พัง: โมเดลที่ไม่มีราคา = null ("—") ห้ามเดาราคาแทน
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadModelPricing, pricingById, usageCostUsd, summarizeUsage } from "../src/modelPricing.mjs";

function fileWith(entries) {
  const dir = mkdtempSync(join(tmpdir(), "pricing-"));
  const file = join(dir, "model-pricing.json");
  writeFileSync(file, JSON.stringify(entries));
  return file;
}

const SOL = {
  id: "gpt-5.6-sol", label: "Sol", provider: "openai",
  in_usd_per_m: 4, out_usd_per_m: 20, cached_in_usd_per_m: 0.4, verified: true,
};

test("ไฟล์ราคาอ่านช่องราคาแคชได้ (ไม่มีช่องนี้ = null ไม่ใช่ 0)", () => {
  const map = pricingById(loadModelPricing(fileWith([
    SOL,
    { id: "no-cache-field", in_usd_per_m: 1, out_usd_per_m: 2, verified: true },
  ])));
  assert.equal(map.get("gpt-5.6-sol").cachedInUsdPerM, 0.4);
  assert.equal(map.get("no-cache-field").cachedInUsdPerM, null,
    "ไม่ได้ระบุราคาแคช = ไม่รู้ ห้ามเดาเป็น 0 (จะทำให้ต้นทุนต่ำกว่าจริง)");
});

test("token ที่มาจากแคชต้องคิดราคาแคช ส่วนที่เหลือคิดราคาเต็ม", () => {
  const map = pricingById(loadModelPricing(fileWith([SOL])));
  // 1,000,000 in โดย 400,000 มาจากแคช + 100,000 out
  const cost = usageCostUsd({ model: "gpt-5.6-sol", tokensIn: 1_000_000, cachedIn: 400_000, tokensOut: 100_000 }, map);
  // (600,000*4 + 400,000*0.4 + 100,000*20) / 1e6 = 2.4 + 0.16 + 2 = 4.56
  assert.equal(Number(cost.toFixed(6)), 4.56);
});

test("ไม่มีแคชต้องได้เท่าเดิมทุกบาท (ของเก่าห้ามเพี้ยน)", () => {
  const map = pricingById(loadModelPricing(fileWith([SOL])));
  const withZero = usageCostUsd({ model: "gpt-5.6-sol", tokensIn: 1_000_000, cachedIn: 0, tokensOut: 100_000 }, map);
  const noField = usageCostUsd({ model: "gpt-5.6-sol", tokensIn: 1_000_000, tokensOut: 100_000 }, map);
  assert.equal(withZero, 6);
  assert.equal(noField, 6, "ผู้เรียกเก่าที่ไม่ส่ง cachedIn ต้องได้ผลเดิม");
});

test("โมเดลที่รู้ราคาปกติแต่ไม่รู้ราคาแคช ต้องคิดแบบไม่ลดราคา (ปลอดภัยไว้ก่อน)", () => {
  const map = pricingById(loadModelPricing(fileWith([
    { id: "m", in_usd_per_m: 10, out_usd_per_m: 20, verified: true },
  ])));
  const cost = usageCostUsd({ model: "m", tokensIn: 1_000_000, cachedIn: 500_000, tokensOut: 0 }, map);
  assert.equal(cost, 10, "ไม่รู้ราคาแคช = คิดเต็มทั้งก้อน ไม่ใช่ข้ามหรือเดา");
});

test("cachedIn ที่มากกว่า tokensIn หรือติดลบ ต้องไม่ทำให้ยอดเพี้ยน", () => {
  const map = pricingById(loadModelPricing(fileWith([SOL])));
  const over = usageCostUsd({ model: "gpt-5.6-sol", tokensIn: 100, cachedIn: 999_999, tokensOut: 0 }, map);
  assert.equal(Number(over.toFixed(8)), Number((100 * 0.4 / 1e6).toFixed(8)), "แคชเกินยอดจริง = ถือว่าแคชทั้งก้อน");
  const neg = usageCostUsd({ model: "gpt-5.6-sol", tokensIn: 1_000_000, cachedIn: -5, tokensOut: 0 }, map);
  assert.equal(neg, 4, "ค่าติดลบ = ถือว่าไม่มีแคช");
});

test("summarizeUsage ต้องส่ง cached_in จากฐานข้อมูลเข้าไปคิดด้วย", () => {
  const map = pricingById(loadModelPricing(fileWith([SOL])));
  const { usd, breakdown } = summarizeUsage([
    { model: "gpt-5.6-sol", kind: "reply", tokens_in: 1_000_000, cached_in: 400_000, tokens_out: 100_000 },
  ], map);
  assert.equal(Number(usd.toFixed(6)), 4.56);
  assert.equal(breakdown[0].cachedIn, 400_000, "breakdown ต้องบอกจำนวน token ที่ได้ราคาแคชด้วย");
});

test("ไฟล์ราคาจริงของระบบต้องตรงกับราคาที่ OpenAI ประกาศ (ตรวจ 2026-08-31)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("../config/model-pricing.json", import.meta.url));
  const byId = Object.fromEntries(JSON.parse(readFileSync(path, "utf8")).map((e) => [e.id, e]));
  assert.deepEqual(
    [byId["gpt-5.6-sol"].in_usd_per_m, byId["gpt-5.6-sol"].out_usd_per_m, byId["gpt-5.6-sol"].cached_in_usd_per_m],
    [4, 20, 0.4], "Sol โปรโมชัน $4/$20 แคช $0.40 (อย่างน้อยถึง 21 พ.ย. 2026)");
  assert.deepEqual(
    [byId["gpt-5.6-terra"].in_usd_per_m, byId["gpt-5.6-terra"].out_usd_per_m], [2, 12]);
  assert.deepEqual(
    [byId["gpt-5.6-luna"].in_usd_per_m, byId["gpt-5.6-luna"].out_usd_per_m], [0.2, 1.2]);
});

// 28 ก.ย. 2026 (ตรวจจากข้อมูลจริง ก.ย.): ราคาเขียนแคชของ gpt-5.6 ยังไม่ยืนยัน และสรุปของคอนโซลรวมทั้งเดือน
// เป็นก้อนเดียวต่อโมเดล/ชนิดงาน — การเขียนแคชแม้ครั้งเดียวทำให้ทั้งก้อนกลายเป็น "ไม่ทราบราคา" แล้วหายจากยอด
// คอนโซลโชว์ ก.ย. $8.42 ทั้งที่คิดทีละแถวได้ $315.93 (253 ล้าน token ถูกนับเป็นไม่ทราบราคา แต่ที่ไม่มีราคาจริงมีแค่ 6.35 ล้าน)
test("ก้อนที่มีการเขียนแคชแต่ไม่มีราคาเขียนแคช: คิดส่วนที่รู้ราคา แยกเฉพาะ token เขียนแคชเป็นไม่ทราบราคา", () => {
  const map = pricingById(loadModelPricing(fileWith([SOL])));
  const row = {
    model: "gpt-5.6-sol", kind: "draft",
    tokens_in: 1_000_000, cached_in: 400_000, cache_write_in: 100_000, tokens_out: 100_000, long_context: 0,
  };
  const summary = summarizeUsage([row], map);
  // ส่วนที่รู้ราคา: input เต็ม 500,000 × $4 + แคช 400,000 × $0.4 + output 100,000 × $20 = 2 + 0.16 + 2 = $4.16
  assert.ok(Math.abs(summary.usd - 4.16) < 1e-9, `usd ${summary.usd}`);
  assert.equal(summary.unknownTokens, 100_000, "ไม่ทราบราคาเฉพาะ token เขียนแคช ไม่ใช่ทั้งก้อน");
  assert.equal(summary.breakdown[0].unpricedCacheWriteIn, 100_000);
  assert.ok(Math.abs(summary.breakdown[0].usd - 4.16) < 1e-9);
  // ยอดของก้อนรวม = ผลรวมของการคิดทีละแถวเสมอ (ราคาเป็นเชิงเส้น) — เทียบกับสองแถวที่แยกกัน
  const perRow = summarizeUsage([
    { ...row, tokens_in: 600_000, cached_in: 400_000, cache_write_in: 0, tokens_out: 60_000 },
    { ...row, tokens_in: 400_000, cached_in: 0, cache_write_in: 100_000, tokens_out: 40_000 },
  ], map);
  assert.ok(Math.abs(perRow.usd - summary.usd) < 1e-9, `${perRow.usd} vs ${summary.usd}`);
  assert.equal(perRow.unknownTokens, summary.unknownTokens);
});

test("โมเดลที่ไม่มีราคาเลย ยังเป็นไม่ทราบราคาทั้งก้อนเหมือนเดิม (ห้ามเดาราคา)", () => {
  const map = pricingById(loadModelPricing(fileWith([SOL])));
  const summary = summarizeUsage([{ model: "unknown-model", kind: "draft", tokens_in: 1000, cached_in: 0, cache_write_in: 50, tokens_out: 10, long_context: 0 }], map);
  assert.equal(summary.usd, 0);
  assert.equal(summary.unknownTokens, 1010);
  assert.equal(summary.breakdown[0].usd, null);
});

// 28 ก.ย. 2026 (พี่ง้วง: "cache ให้ใช้เรท avg คร่าว ๆ ตามประกาศของ openai ได้ไหม อย่างน้อยจะเห็นต้นทุน"):
// คู่มือ prompt caching ของ OpenAI — GPT-5.6 ขึ้นไป เขียนแคช = 1.25 เท่าของราคา input ปกติ (อ่านแคช 0.1 เท่า)
// ไฟล์ราคาที่ส่งไปกับ release ต้องมีราคาเขียนแคชของ gpt-5.6 ทุกตัว และเป็น 1.25 เท่าของ input ของไฟล์เองเสมอ
test("ไฟล์ราคาจริง: gpt-5.6 ทุกตัวมีราคาเขียนแคช = 1.25 × input (กฎเดียวกับ gpt-6)", () => {
  const map = pricingById(loadModelPricing(new URL("../config/model-pricing.json", import.meta.url).pathname, { logger: { log() {}, warn() {} } }));
  for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"]) {
    const p = map.get(id);
    assert.ok(p, id);
    assert.ok(Math.abs(p.cacheWriteUsdPerM - p.inUsdPerM * 1.25) < 1e-9, `${id}: ${p.cacheWriteUsdPerM} vs ${p.inUsdPerM}`);
  }
  // ก้อนที่มีการเขียนแคชจึงคิดเงินครบ ไม่มี token "ไม่ทราบราคา" เหลือ
  const summary = summarizeUsage([{ model: "gpt-5.6-sol", kind: "draft", tokens_in: 1_000_000, cached_in: 400_000,
    cache_write_in: 100_000, tokens_out: 100_000, long_context: 0 }], map);
  assert.equal(summary.unknownTokens, 0);
  assert.ok(Math.abs(summary.usd - (4.16 + 0.1 * 5)) < 1e-9, `usd ${summary.usd}`);
});
