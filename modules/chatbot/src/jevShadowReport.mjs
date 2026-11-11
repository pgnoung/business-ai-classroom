// Aggregates only. Never export customer chat, names, contacts or provider keys.
import { loadModelPricing, pricingById, usageCostUsd } from './modelPricing.mjs';
export function shadowReport(db, day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Expected Bangkok date YYYY-MM-DD");
  const start = Date.parse(`${day}T00:00:00+07:00`), end = start + 86400000;
  if (!Number.isFinite(start)) throw new Error("Invalid report date");
  const rows = db.prepare("SELECT id, primary_model, primary_score, model, status, result_json, input_tokens, output_tokens, elapsed_ms FROM jev_shadow WHERE created_at>=? AND created_at<? ORDER BY created_at").all(start, end);
  const reviewCandidates = [];
  const statuses = {}, primaryModels = {};
  let compared = 0, sameBand = 0, absoluteDelta = 0, bigDifferences = 0, higher = 0, lower = 0, uncertain = 0;
  let inputTokens = 0, outputTokens = 0, missingUsage = 0, elapsed = 0, productionOnly = 0, budgetConstraint = 0;
  const band = score => score < 5 ? "cold" : score < 8 ? "warm" : "hot";
  for (const row of rows) {
    statuses[row.status] = (statuses[row.status] || 0) + 1;
    primaryModels[row.primary_model] = (primaryModels[row.primary_model] || 0) + 1;
    if (row.input_tokens === null || row.output_tokens === null || row.status === "model_mismatch") missingUsage++;
    inputTokens += row.input_tokens || 0; outputTokens += row.output_tokens || 0; elapsed += row.elapsed_ms || 0;
    const a = JSON.parse(row.result_json || "{}");
    if (a.productionOnly >= 0.65) productionOnly++;
    if (a.budgetConstraint >= 0.65) budgetConstraint++;
    if (row.status !== "compared") { if (row.status === "uncertain") uncertain++; continue; }
    compared++;
    const delta = a.score - row.primary_score;
    absoluteDelta += Math.abs(delta);
    if (Math.abs(delta) >= 3) bigDifferences++;
    if (Math.abs(delta) >= 3 && reviewCandidates.length < 5) reviewCandidates.push({ observationId: row.id, primaryScore: row.primary_score, jevScore: a.score, confidence: a.confidence });
    if (delta >= 3) higher++;
    if (delta <= -3) lower++;
    if (band(a.score) === band(row.primary_score)) sameBand++;
  }
  const primary = db.prepare("SELECT COUNT(*) AS assessments, COUNT(DISTINCT customer_id) AS rooms FROM score_history WHERE created_at>=? AND created_at<?").get(start, end);
  const pricing = pricingById(loadModelPricing(new URL('../config/model-pricing.json', import.meta.url), {logger:{}}));
  const scorerUsage = db.prepare("SELECT model, COUNT(*) AS calls, SUM(tokens_in) AS inputTokens, SUM(tokens_out) AS outputTokens, SUM(cached_in) AS cachedTokens, SUM(cache_write_in) AS cacheWriteTokens, SUM(CASE WHEN cache_write_known=0 AND tokens_in>0 THEN 1 ELSE 0 END) AS missingCacheWriteCalls, (tokens_in>272000) AS longContext FROM llm_usage WHERE kind='score' AND created_at>=? AND created_at<? GROUP BY model, (tokens_in>272000)").all(start, end).map(row => ({...row,
    estimatedUsd: usageCostUsd({model:row.model,tokensIn:row.inputTokens,tokensOut:row.outputTokens,cachedIn:row.cachedTokens,cacheWriteIn:row.cacheWriteTokens,longContext:Boolean(row.longContext)},pricing)
  }));
  return { day, timezone: "Asia/Bangkok", mode: "shadow_only", primary, attempted: rows.length, statuses, primaryModels,
    compared, uncertain, sameBand, reviewCandidates, agreementRate: compared ? sameBand / compared : null,
    meanAbsoluteDelta: compared ? absoluteDelta / compared : null, bigDifferences, jevHigherBy3: higher, jevLowerBy3: lower,
    productionOnly, budgetConstraint, inputTokens, outputTokens, missingUsage,
    estimatedKnownJevUsd: rows.filter(r => r.model === "jev-1.13.0" && r.status !== "model_mismatch").reduce((s, r) => s + (r.input_tokens || 0), 0) * 0.042 / 1000000,
    costComplete: missingUsage === 0, pricingDate: "2026-09-21", pricingSource: "https://docs.typesafe.ai/models",
    meanLatencyMs: rows.filter(r => r.elapsed_ms !== null).length ? Math.round(elapsed / rows.filter(r => r.elapsed_ms !== null).length) : null, scorerUsage,
    accuracy: "unmeasured_without_independent_human_labels",
    caveats: ["Agreement is not accuracy; Luna is not ground truth.", "JEV ordinal score is mapped from 0–5 to 0–10; confidence/insufficient evidence excluded from comparisons.", "Not an invoice; missing receipts may still have incurred charges.", "Budget/higher/lower do not identify customer value. No automatic model switch."] };
}
