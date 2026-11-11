// learningDigest.mjs — bounded, proposal-only daily learning.
// Stage A is deterministic and local. Optional Stage B is injected explicitly,
// budgeted before the call, and can only create review proposals. An authenticated
// owner decision remains the only path that can write knowledge.
import { createHash } from "node:crypto";
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import { createLock } from "./locks.mjs";
import { KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_TITLE_MAX } from "./dbExtra.mjs";
import { brainModeOf, BRAIN_MODE_SEPARATE } from "./knowledgePack.mjs";
import { loadModelPricing, pricingById, summarizeUsage } from "./modelPricing.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { normalizeKnowledgeMetadata } from "./brain/knowledgeMetadata.mjs";
import { normalizeThai } from "./brain/text.mjs";
import { trainingIntakeEntryHash } from "./trainingIntakeIdentity.mjs";

const DAY_MS = 86_400_000;
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DEFAULT_BOOT_DELAY_MS = 5 * 60_000;
const PROBE_HASH_DOMAIN = "lukprae-learning-probe-v1\0";
const HEDGE_RE = /(?:ข้อมูล(?:นี้)?ยัง(?:ไม่)?ยืนยัน|ยังตรวจสอบไม่ได้|ขอเช[็็ค]ก|ขอตรวจสอบ|ข้อมูลตัวอย่าง|mock)/iu;
const QUESTION_RE = /(?:\?|ไหม|มั้ย|หรือไม่|อย่างไร|ยังไง|เท่าไหร่|เมื่อไหร่|ที่ไหน|อะไร|ใคร|ขอ(?:ทราบ|สอบถาม))/iu;
const SAFE_MODEL_KINDS = new Set(["new_question", "unanswered", "correction_pattern", "conflict", "style"]);

export const LEARNING_ENABLED_KEY = "learning_digest_enabled";
export const LEARNING_LAST_RUN_KEY = "learning_digest_last_run_at";

const RISK_RULES = Object.freeze([
  ["money", /(?:฿|บาท|ราคา|ยอด|มัดจำ|ชำระ|โอน|เลขบัญชี|พร้อมเพย์|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}\b)/iu],
  ["promotion_or_terms", /(?:%|เปอร์เซ็นต์|ส่วนลด|โปรโมชั่น|โปร\b|ผ่อน|ดอกเบี้ย|ค่าธรรมเนียม|หัก\s*ณ\s*ที่จ่าย)/iu],
  ["schedule_or_capacity", /(?:ที่นั่ง|เหลือ\s*\d+|รอบเรียน|วันเรียน|กำหนด|deadline|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b)/iu],
  ["policy_or_promise", /(?:นโยบาย|คืนเงิน|เลื่อนคลาส|ยกเลิก|รับประกัน|การันตี|สัญญา|ยืนยันว่า|แน่นอน|ตลอดชีพ)/iu],
  ["personal_or_financial_data", /(?:เลขประจำตัวผู้เสียภาษี|บัตรประชาชน|เลขบัญชี|ที่อยู่|อีเมล|e-?mail|เบอร์(?:โทร)?|โทรศัพท์|@|\b0\d{8,9}\b)/iu],
  ["regulated_or_safety", /(?:วินิจฉัย|รักษา|ยา|อาการป่วย|กฎหมาย|ทนาย|ภาษี|อันตราย|ฉุกเฉิน|ฆ่าตัวตาย)/iu],
  ["system_policy", /(?:system prompt|persona|brain pack|prompt หลัก|safety rule|webhook|credential|api key|token)/iu],
]);

function parseArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const INTAKE_ORIGINS = new Set(["team_notes", "line_oa_curated"]);
const INTAKE_EVIDENCE_KEYS = new Set(["type", "schema", "origin", "batchHash", "entryHash", "submittedBy", "knowledgeMetadata"]);
const HASH_RE = /^[a-f0-9]{64}$/u;

function closedObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.has(key));
}

// This deliberately does not import consoleTeachApi: console teach already
// depends on learning helpers through brain/teach, so the runtime gate belongs
// in the persistence-side decision path as a tiny closed predicate.
function intakeRetrievalReady({ db, config }) {
  return config.trainingIntakeEnabled === true
    && config.teachEnabled === true
    && config.brainRetrievalEnabled === true
    && config.knowledgeVersioned === true
    && config.brainRead === "versioned"
    && Boolean(db.getBrainPointer?.("live")?.version_id);
}

function intakeEvidence(row) {
  if (String(row?.kind) !== "cluster" || !String(row?.cluster_key || "").startsWith("training-intake:")) return null;
  const items = parseArray(row.evidence_json);
  if (items.length !== 1 || !closedObject(items[0], INTAKE_EVIDENCE_KEYS)) return null;
  const item = items[0];
  if (item.type !== "training_intake" || item.schema !== "training-intake-v1" || !INTAKE_ORIGINS.has(item.origin)
    || typeof item.batchHash !== "string" || !HASH_RE.test(item.batchHash)
    || typeof item.entryHash !== "string" || !HASH_RE.test(item.entryHash)
    || typeof item.submittedBy !== "string" || !item.submittedBy || item.submittedBy.length > 120
    || String(row.cluster_key) !== `training-intake:${item.entryHash}`
    || String(row.run_id) !== `training-intake:${item.batchHash}`) return null;
  try {
    const knowledgeMetadata = normalizeKnowledgeMetadata(item.knowledgeMetadata);
    if (knowledgeMetadata.mode !== "retrieve") return null;
    return { ...item, knowledgeMetadata };
  } catch {
    return null;
  }
}

function claimsTrainingIntake(row) {
  return String(row?.cluster_key || "").startsWith("training-intake:")
    || parseArray(row?.evidence_json).some((item) => item?.type === "training_intake");
}

function intakeEntryHashMatches(row, intake) {
  const scope = row.channel_id == null ? null : String(row.channel_id);
  return trainingIntakeEntryHash({
    content: String(row.proposed_content), origin: intake.origin, scope,
    knowledgeMetadata: intake.knowledgeMetadata,
  }) === intake.entryHash;
}

function intakeValidation({ row, db, config, channels }) {
  const intake = intakeEvidence(row);
  if (claimsTrainingIntake(row) && !intake) return { code: "intake_evidence_invalid" };
  if (!intake) return { intake: null };
  if (!intakeRetrievalReady({ db, config })) return { code: "intake_not_ready" };
  const scope = row.channel_id == null ? null : String(row.channel_id);
  if (scope !== null) {
    const configured = (Array.isArray(channels) ? channels : [])
      .some((channel) => channel?.id === scope && channel.active !== false);
    if (!configured || brainModeOf(db, scope) !== BRAIN_MODE_SEPARATE) return { code: "intake_scope_stale" };
  }
  // The intake never has a customer identity to compare, therefore the same
  // conservative privacy scanner used for persistence is the applicable refusal.
  const riskFlags = learningRiskFlags(...[
    row.title, row.proposed_content,
    intake.knowledgeMetadata.domain, intake.knowledgeMetadata.offering, ...intake.knowledgeMetadata.keywords,
  ].map(normalizeThai));
  if (riskFlags.length) return { code: "intake_risk_blocked", riskFlags };
  if (!intakeEntryHashMatches(row, intake)) return { code: "intake_entry_hash_mismatch" };
  return { intake };
}

function dayKey(timestamp) {
  return new Date(Number(timestamp) + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
}

function stableHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeShortHash(value) {
  return stableHash(value).slice(0, 8).replace(/[0-9]/gu, (digit) => String.fromCharCode(97 + Number(digit)));
}

function normalizedQuestion(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}


function parseModelClusters(text, maxClusters) {
  let parsed;
  try { parsed = JSON.parse(String(text || "")); }
  catch { return null; }
  const rows = Array.isArray(parsed) ? parsed : parsed?.clusters;
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, maxClusters).map((row) => ({
    kind: SAFE_MODEL_KINDS.has(String(row?.kind || "")) ? String(row.kind) : "unanswered",
    title: String(row?.title || "").trim().slice(0, KNOWLEDGE_TITLE_MAX),
    proposedContent: String(row?.proposed_content || "").trim().slice(0, KNOWLEDGE_CONTENT_MAX),
    evidenceRefs: [...new Set((Array.isArray(row?.evidence_refs) ? row.evidence_refs : []).map(String))].slice(0, 50),
  })).filter((row) => row.title && row.proposedContent && row.evidenceRefs.length);
}

export function learningRiskFlags(...parts) {
  const text = parts.map((part) => String(part || "")).join("\n");
  return RISK_RULES.filter(([, rule]) => rule.test(text)).map(([name]) => name);
}

export function knowledgeDigest(db) {
  const rows = db.knowledgeRowsForDigest().map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    channelId: row.channel_id ?? null,
    source: row.source,
    version: row.version,
    updatedAt: row.updated_at,
    // Retrieval metadata is part of what a future answer may see.  Including
    // provenance makes pending proposals explicitly stale when that routing
    // meaning changes, rather than approving against an older brain view.
    provenance: row.provenance_json ?? null,
  }));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function learningDigestGlobalEnabled({ db, config }) {
  try {
    const stored = db.getSetting(LEARNING_ENABLED_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    return false;
  }
  return config.learningDigestEnabled === true;
}

function publicCandidate(row) {
  return {
    ...row,
    evidence: parseArray(row.evidence_json),
    conflicts: parseArray(row.conflict_json),
    riskFlags: parseArray(row.risk_flags_json),
    evidence_json: undefined,
    conflict_json: undefined,
    risk_flags_json: undefined,
  };
}

function stageASignals(data) {
  const signals = [];
  for (const row of data.corrections) {
    signals.push({
      ref: `correction:${row.id}`,
      type: "operator_override",
      sourceId: row.id,
      channelId: row.channel_id || "default",
      text: String(row.human_final || "").trim(),
      at: row.decided_at,
    });
  }
  const aiMessages = data.messages.filter((row) => row.direction === "out" && row.agent_mode === "ai");
  for (const row of aiMessages) {
    if (!HEDGE_RE.test(String(row.content || ""))) continue;
    signals.push({
      ref: `message:${row.id}`,
      type: "hedge",
      sourceId: row.id,
      channelId: row.channel_id || "default",
      text: String(row.content || "").trim(),
      at: row.created_at,
    });
  }
  for (const row of data.promiseNotes) {
    signals.push({
      ref: `promise:${row.id}`,
      type: "promise_note",
      sourceId: row.id,
      channelId: row.channel_id || "default",
      text: "AI promise required human follow-up",
      at: row.created_at,
    });
  }

  const repeated = new Map();
  for (const row of data.messages) {
    if (row.direction !== "in") continue;
    const normalized = normalizedQuestion(row.content);
    if (!normalized || !QUESTION_RE.test(normalized)) continue;
    const key = `${row.customer_id}\0${normalized}`;
    const group = repeated.get(key) || [];
    group.push(row);
    repeated.set(key, group);
  }
  for (const rows of repeated.values()) {
    if (rows.length < 2) continue;
    const first = rows[0];
    signals.push({
      ref: `repeated:${stableHash(rows.map((row) => row.id).join("\0"))}`,
      type: "repeated_question",
      sourceId: first.id,
      evidenceIds: rows.map((row) => row.id),
      channelId: first.channel_id || "default",
      text: String(first.content || "").trim(),
      at: first.created_at,
    });
  }

  const previousByCustomer = new Map();
  for (const row of data.scoreRows) {
    const previous = previousByCustomer.get(row.customer_id);
    if (previous && Number(previous.score) - Number(row.score) >= 3) {
      signals.push({
        ref: `score:${row.id}`,
        type: "score_drop",
        sourceId: row.id,
        channelId: row.channel_id || "default",
        text: "Interest score dropped by at least three points after a turn",
        at: row.created_at,
      });
    }
    previousByCustomer.set(row.customer_id, row);
  }
  return { signals, aiMessages };
}

function probeSet(data, { generatedAt, targetDayKey }) {
  const seen = new Set();
  const probes = [];
  for (const row of data.messages) {
    if (row.direction !== "in") continue;
    const text = String(row.content || "").trim();
    const normalized = normalizedQuestion(text);
    if (!normalized || !QUESTION_RE.test(normalized) || seen.has(normalized)) continue;
    const privacyRisks = learningRiskFlags(text).filter((risk) => risk === "personal_or_financial_data");
    if (privacyRisks.length) continue;
    seen.add(normalized);
    probes.push({
      id: stableHash(`${PROBE_HASH_DOMAIN}${row.id}`),
      kind: "customer_question",
      question: text.slice(0, 500),
    });
    if (probes.length >= 200) break;
  }
  return { schemaVersion: 1, dayKey: targetDayKey, generatedAt, probes };
}

function learningMetrics({ data, aiMessages, db, probes, startMs, endMs }) {
  const aiTurns = aiMessages.length;
  const hedgeCount = aiMessages.filter((row) => HEDGE_RE.test(String(row.content || ""))).length;
  const usage = db.learningUsageStats({ startMs, endMs });
  const tokensIn = Math.max(0, Number(usage.tokens_in) || 0);
  return {
    hedgeRate: aiTurns ? hedgeCount / aiTurns : 0,
    promiseNotesPer100: aiTurns ? (data.promiseNotes.length * 100) / aiTurns : 0,
    operatorOverridePer100: aiTurns ? (data.corrections.length * 100) / aiTurns : 0,
    knowledgeChars: Math.max(0, Number(db.learningKnowledgeStats().knowledge_chars) || 0),
    cacheHitRate: tokensIn ? Math.min(1, Math.max(0, Number(usage.cached_in) || 0) / tokensIn) : 0,
    probeCount: probes.probes.length,
  };
}

export function createLearningDigest({
  config, db, logger = console, now = Date.now,
  intervalMs = null, bootDelayMs = DEFAULT_BOOT_DELAY_MS,
  scorer = null, modelPricing = null, channels = [],
} = {}) {
  const lock = createLock();
  // Zero is an explicit fail-closed setting that disarms the scheduler; do not
  // coerce it to the daily default with `||`.
  const tickMs = intervalMs == null ? Number(config.learningDigestIntervalMs ?? DAY_MS) : Number(intervalMs);
  const pricingMap = pricingById(modelPricing ?? loadModelPricing(config.modelPricingFile, { logger }));
  let timer = null;
  let bootTimer = null;

  function currentMode() {
    if (config.learningModelEnabled !== true) return "deterministic_fallback:model_disabled";
    if (typeof scorer !== "function") return "deterministic_fallback:model_unavailable";
    return "model_assisted";
  }

  // Keep the small operational state separate from the console payload.  /health
  // must remain safe even if the database is already unavailable, whereas the
  // full console snapshot intentionally reads candidate and run tables.
  function healthSnapshot() {
    let lastRunAt = null;
    let lastRunMode = null;
    let lastRunStatus = null;
    try { lastRunAt = Number(db.getSetting(LEARNING_LAST_RUN_KEY)) || null; }
    catch { /* the enclosing /health response reports db=down */ }
    try {
      const latest = db.listLearningRuns(1)?.[0] || null;
      lastRunMode = latest?.mode ? String(latest.mode) : null;
      lastRunStatus = latest?.status ? String(latest.status) : null;
    } catch { /* health stays available while db failure is reported separately */ }
    const configuredMode = currentMode();
    return {
      enabled: learningDigestGlobalEnabled({ db, config }),
      modelEnabled: config.learningModelEnabled === true,
      configuredMode,
      // Effective mode is the latest persisted outcome when one exists. This
      // prevents a configured model scorer from hiding a real fallback/failure.
      mode: lastRunMode || configuredMode,
      lastRunMode,
      lastRunStatus,
      // "armed" describes the configured interval. "running" distinguishes
      // a process that has actually started the scheduler from a constructed
      // app instance (for example a test or a pre-listen health probe).
      armed: tickMs > 0,
      running: timer !== null || bootTimer !== null,
      intervalMs: Math.max(0, Number.isFinite(tickMs) ? tickMs : 0),
      lastRunAt,
    };
  }

  function snapshot() {
    return {
      ...healthSnapshot(),
      budgetUsd: Number(config.learningDailyUsdCap ?? 0.5),
      maxClusters: Math.min(10, Math.max(1, Number(config.learningMaxClusters) || 10)),
      maxTokensOut: Math.min(1500, Math.max(1, Number(config.learningMaxTokensOut) || 1500)),
      candidates: db.listLearningCandidates({ limit: 100 }).map(publicCandidate),
      runs: db.listLearningRuns(20),
    };
  }

  async function runOnce() {
    if (!lock.tryAcquire()) return { skipped: true, reason: "run_in_flight" };
    let run = null;
    let mode = currentMode();
    try {
      if (!learningDigestGlobalEnabled({ db, config })) {
        return { skipped: true, reason: "learning_disabled" };
      }
      const t = now();
      const endMs = bangkokDayStartMs(t);
      const startMs = endMs - DAY_MS;
      const targetDayKey = dayKey(startMs);
      const priorRun = db.getCompletedLearningRunForDay(targetDayKey, mode);
      if (priorRun) return { skipped: true, reason: "day_already_processed", run: priorRun, candidatesCreated: 0 };
      const digest = knowledgeDigest(db);
      run = db.createLearningRun({ dayKey: targetDayKey, knowledgeDigest: digest, mode });
      const data = db.learningStageAData({
        startMs, endMs,
        excludedChannelIds: config.trainingCommandChannels || [],
      });
      const stageA = stageASignals(data);
      const probes = probeSet(data, { generatedAt: t, targetDayKey });
      const metrics = learningMetrics({ data, aiMessages: stageA.aiMessages, db, probes, startMs, endMs });
      const signals = stageA.signals;
      let created = 0;
      let clusters = 0;
      let llmCalls = 0;
      let tokensIn = 0;
      let tokensOut = 0;
      let usd = 0;

      const createFromSignal = ({ signal, title, content, kind = "correction", clusterKey }) => {
        if (!content) return false;
        const channelId = brainModeOf(db, signal.channelId || "default") === BRAIN_MODE_SEPARATE
          ? String(signal.channelId || "default")
          : null;
        const conflicts = db.findActiveKnowledgeMatches({
          title, content, channelId,
        }).map((row) => ({ id: row.id, source: row.source, sameContent: row.content === content }));
        if (conflicts.some((row) => row.sameContent)) return false;
        const candidate = db.createLearningCandidate({
          runId: run.id,
          dayKey: targetDayKey,
          clusterKey,
          channelId,
          kind,
          title,
          proposedContent: content,
          evidence: [{
            type: signal.type,
            id: signal.sourceId,
            ...(signal.evidenceIds ? { ids: signal.evidenceIds } : {}),
            at: signal.at,
          }],
          conflicts,
          riskFlags: learningRiskFlags(title, content),
          knowledgeDigest: digest,
        });
        return Boolean(candidate);
      };

      if (signals.length && mode === "model_assisted") {
        const maxClusters = Math.min(10, Math.max(1, Number(config.learningMaxClusters) || 10));
        const maxTokensOut = Math.min(1500, Math.max(1, Number(config.learningMaxTokensOut) || 1500));
        const model = String(config.learningModel || "").trim();
        // Provider privacy boundary: signal text always remains local. The
        // optional model sees only non-identifying structural features and refs;
        // even a name/address pattern unknown to RISK_RULES cannot cross this
        // boundary. Risk filtering is an additional conservative exclusion.
        const modelInputSignals = signals
          .filter((signal) => learningRiskFlags(signal.text).length === 0)
          .slice(0, 200);
        if (!modelInputSignals.length) {
          mode = "deterministic_fallback:risk_filtered";
          db.addAudit({
            operator: "system", action: "learning_model_input_filtered", target: targetDayKey,
            detail: JSON.stringify({ filtered: signals.length, safe: 0 }),
          });
        } else {
          const scorerSignals = modelInputSignals.map((signal, index) => ({
            ref: `s${index + 1}`,
            type: signal.type,
            length_band: String(signal.text || "").length < 80 ? "short"
              : (String(signal.text || "").length < 240 ? "medium" : "long"),
            question_like: QUESTION_RE.test(String(signal.text || "")),
            evidence_count: Math.max(1, signal.evidenceIds?.length || 1),
          }));
          const refMap = new Map(scorerSignals.map((item, index) => [item.ref, modelInputSignals[index]]));
          const system = "Cluster de-identified structural learning features. Return JSON only: {clusters:[{kind,title,proposed_content,evidence_refs}]}. kind must be new_question, unanswered, correction_pattern, conflict, or style. Proposed content must be generic process guidance based only on signal kind. Never infer or invent customer details, prices, dates, policies, or promises.";
          const transcript = JSON.stringify({ maxClusters, signals: scorerSignals });
          const estimatedTokensIn = Buffer.byteLength(`${system}\n${transcript}`, "utf8");
          // Budget follows the day the provider call is made, not the prior-day
          // evidence window being analyzed.
          const existing = db.llmUsageSummary(endMs).filter((row) => row.kind === "learning");
          const projected = summarizeUsage([
            ...existing,
            { model, kind: "learning", tokens_in: estimatedTokensIn, tokens_out: maxTokensOut },
          ], pricingMap);
          const cap = Math.min(0.5, Math.max(0, Number(config.learningDailyUsdCap) || 0));
          if (!model || projected.unknownTokens > 0 || projected.usd > cap) {
            const reason = !model ? "model_missing" : projected.unknownTokens > 0 ? "pricing_unknown" : "daily_cap";
            mode = `deterministic_fallback:budget_stop_${reason}`;
            db.addAudit({
              operator: "system", action: "learning_budget_stop", target: targetDayKey,
              detail: JSON.stringify({ reason, capUsd: cap, projectedCalls: 1 }),
            });
          } else {
            let response = null;
            llmCalls = 1;
            try {
              response = await scorer({ system, transcript, model, maxCompletionTokens: maxTokensOut });
            } catch {
              response = null;
            }
            if (!response) {
              mode = "deterministic_fallback:model_failed";
              db.addAudit({ operator: "system", action: "learning_model_failure", target: targetDayKey, detail: "no_usable_response" });
            } else {
              const usage = usageFields(response.usage);
              tokensIn = usage.tokensIn;
              tokensOut = usage.tokensOut;
              db.addLlmUsage({ customerId: "", kind: "learning", model: response.model || model, ...usage });
              const actual = summarizeUsage([{
                model: response.model || model, kind: "learning",
                tokens_in: usage.tokensIn, tokens_out: usage.tokensOut,
                cached_in: usage.cachedIn, cache_write_in: usage.cacheWriteIn,
              }], pricingMap);
              usd = actual.unknownTokens ? 0 : actual.usd;
              const parsed = usage.tokensOut > maxTokensOut ? null : parseModelClusters(response.text, maxClusters);
              if (!parsed) {
                mode = usage.tokensOut > maxTokensOut
                  ? "deterministic_fallback:model_output_over_limit"
                  : "deterministic_fallback:model_output_invalid";
              } else {
                for (const cluster of parsed) {
                  const evidenceSignals = cluster.evidenceRefs.map((ref) => refMap.get(ref)).filter(Boolean);
                  if (!evidenceSignals.length) continue;
                  const signal = evidenceSignals[0];
                  const channelIds = new Set(evidenceSignals.map((item) => item.channelId));
                  // Never widen a mixed-OA cluster into shared knowledge.
                  if (channelIds.size !== 1) continue;
                  const evidenceKey = evidenceSignals.map((item) => item.ref).sort().join("\0");
                  const didCreate = createFromSignal({
                    signal: {
                      ...signal,
                      type: cluster.kind,
                      evidenceIds: evidenceSignals.flatMap((item) => item.evidenceIds || [item.sourceId]),
                    },
                    title: cluster.title,
                    content: cluster.proposedContent,
                    kind: "cluster",
                    clusterKey: `cluster:${targetDayKey}:${stableHash(`${evidenceKey}\0${cluster.kind}\0${cluster.title}\0${cluster.proposedContent}`)}`,
                  });
                  if (didCreate) created += 1;
                }
                clusters = parsed.length;
              }
            }
          }
        }
      }

      if (mode !== "model_assisted" || created === 0) {
        for (const signal of signals.filter((item) => item.type === "operator_override")) {
          const content = String(signal.text || "").trim();
          // Keep the deterministic disambiguator letter-only so the money-risk
          // scanner cannot mistake a random run of hash digits for an amount.
          const title = `คำตอบที่ทีมยืนยัน #${safeShortHash(signal.sourceId)}`;
          const didCreate = createFromSignal({
            signal, title, content,
            clusterKey: `correction:${signal.sourceId}`,
          });
          if (didCreate) created += 1;
        }
      }
      const status = signals.length === 0 ? "skipped_no_activity" : "complete";
      const finished = db.finishLearningRun(run.id, {
        status,
        signalsFound: signals.length,
        clusters,
        llmCalls,
        tokensIn,
        tokensOut,
        usd,
        candidatesCreated: created,
        detail: `${mode};dashboard_key_excluded=${data.excludedDashboardKey}`,
        mode,
        ...metrics,
      });
      db.setSetting(LEARNING_LAST_RUN_KEY, String(t));
      logger.log?.(`[learning] status=${status} mode=${mode} signals=${signals.length} candidates=${created} llm_calls=${llmCalls}`);
      return { ok: true, run: finished, candidatesCreated: created, probeCount: probes.probes.length };
    } catch (error) {
      if (run?.id) {
        try { db.finishLearningRun(run.id, { status: "failed", detail: error?.message || String(error), mode }); }
        catch { /* original error wins */ }
      }
      throw error;
    } finally {
      lock.release();
    }
  }

  function editCandidate(id, { title, content } = {}) {
    const row = db.getLearningCandidate(id);
    if (!row || row.status !== "proposed") return { ok: false, code: "not_proposed" };
    const intakeCheck = intakeValidation({ row, db, config, channels });
    if (intakeCheck.code) return { ok: false, code: intakeCheck.code, ...(intakeCheck.riskFlags ? { riskFlags: intakeCheck.riskFlags } : {}) };
    const nextTitle = String(title ?? row.title).trim();
    const nextContent = String(content ?? row.proposed_content).trim();
    if (!nextTitle || nextTitle.length > KNOWLEDGE_TITLE_MAX) return { ok: false, code: "invalid_title" };
    if (!nextContent || nextContent.length > KNOWLEDGE_CONTENT_MAX) return { ok: false, code: "invalid_content" };
    if (intakeCheck.intake && (nextTitle !== row.title || nextContent !== row.proposed_content)) {
      return { ok: false, code: "intake_recreate_required" };
    }
    const digest = knowledgeDigest(db);
    const conflicts = db.findActiveKnowledgeMatches({
      title: nextTitle, content: nextContent, channelId: row.channel_id ?? null,
    }).map((entry) => ({ id: entry.id, source: entry.source, sameContent: entry.content === nextContent }));
    const updated = db.updateLearningCandidateProposal(id, {
      title: nextTitle,
      proposedContent: nextContent,
      riskFlags: learningRiskFlags(nextTitle, nextContent),
      conflicts,
      knowledgeDigest: digest,
    });
    return updated ? { ok: true, candidate: publicCandidate(updated) } : { ok: false, code: "not_proposed" };
  }

  function decideCandidate(id, { action, operator, title, content, supersedesId = "" } = {}) {
    if (action === "edit") return editCandidate(id, { title, content });
    const row = db.getLearningCandidate(id);
    if (!row || row.status !== "proposed") return { ok: false, code: "not_proposed" };
    if (action === "reject") {
      const rejected = db.rejectLearningCandidate(id, { decidedBy: operator });
      return rejected ? { ok: true, candidate: publicCandidate(rejected) } : { ok: false, code: "not_proposed" };
    }
    if (action !== "approve" && action !== "supersede") return { ok: false, code: "invalid_action" };

    const intakeCheck = intakeValidation({ row, db, config, channels });
    if (intakeCheck.code) return { ok: false, code: intakeCheck.code, ...(intakeCheck.riskFlags ? { riskFlags: intakeCheck.riskFlags } : {}) };
    const intake = intakeCheck.intake;

    const digest = knowledgeDigest(db);
    if (digest !== row.knowledge_digest) return { ok: false, code: "stale_knowledge" };
    const risks = learningRiskFlags(row.title, row.proposed_content);
    if (risks.length) return { ok: false, code: "risk_blocked", riskFlags: risks };

    const matches = db.findActiveKnowledgeMatches({
      title: row.title, content: row.proposed_content, channelId: row.channel_id ?? null,
    });
    const exact = matches.find((entry) => entry.content === row.proposed_content);
    const titleConflict = matches.find((entry) => entry.title === row.title && entry.content !== row.proposed_content);
    if (titleConflict && titleConflict.source !== "learning_digest") {
      return { ok: false, code: "human_source_conflict", conflictId: titleConflict.id };
    }
    if (titleConflict && action !== "supersede") {
      return { ok: false, code: "supersede_required", conflictId: titleConflict.id };
    }
    if (action === "supersede" && (!titleConflict || String(supersedesId) !== String(titleConflict.id))) {
      return { ok: false, code: "invalid_supersede_target" };
    }

    // Generic daily candidates may reuse an exact learned card.  An intake
    // proposal carries retrieval metadata, and reusing a content-only match
    // would silently lose it, so require the owner to reconcile it explicitly.
    if (intake && exact) return { ok: false, code: "existing_knowledge_conflict", conflictId: exact.id };

    const evidence = parseArray(row.evidence_json);
    const applied = db.applyLearningCandidate(id, {
      decidedBy: operator,
      existingEntryId: exact?.id || "",
      supersedesId: exact ? "" : (action === "supersede" ? String(supersedesId) : ""),
      provenance: intake
        ? {
            type: "training_intake", schema: intake.schema, origin: intake.origin,
            batchHash: intake.batchHash, entryHash: intake.entryHash, submittedBy: intake.submittedBy,
            knowledge: intake.knowledgeMetadata, candidateId: row.id, approvedBy: String(operator),
          }
        : {
            type: "daily_learning",
            candidateId: row.id,
            runId: row.run_id,
            evidence,
            approvedBy: String(operator),
          },
    });
    return applied
      ? { ok: true, candidate: publicCandidate(applied.candidate), entry: applied.entry, deduplicated: Boolean(exact) }
      : { ok: false, code: "not_proposed" };
  }

  function rollbackWeek({ operator } = {}) {
    const since = bangkokDayStartMs(now()) - 6 * DAY_MS;
    return { ok: true, deactivated: db.rollbackLearnedKnowledgeSince(since, { updatedBy: operator }), since };
  }

  function exportProbeSet() {
    const t = now();
    const endMs = bangkokDayStartMs(t);
    const startMs = endMs - DAY_MS;
    const data = db.learningStageAData({
      startMs, endMs,
      excludedChannelIds: config.trainingCommandChannels || [],
    });
    return probeSet(data, { generatedAt: t, targetDayKey: dayKey(startMs) });
  }

  function start() {
    if (timer || bootTimer || !(tickMs > 0)) return false;
    const tick = async () => {
      try { await runOnce(); }
      catch (error) { logger.error?.(`learning: ${error?.message || error}`); }
    };
    bootTimer = setTimeout(() => {
      bootTimer = null;
      tick();
    }, Math.max(0, Number(bootDelayMs) || 0));
    bootTimer.unref?.();
    timer = setInterval(tick, tickMs);
    timer.unref?.();
    logger.log?.(`[learning] scheduler armed every ${tickMs}ms (enabled=${learningDigestGlobalEnabled({ db, config })})`);
    return true;
  }

  function stop() {
    if (bootTimer) clearTimeout(bootTimer);
    if (timer) clearInterval(timer);
    bootTimer = null;
    timer = null;
  }

  return {
    healthSnapshot,
    snapshot,
    runOnce,
    editCandidate,
    decideCandidate,
    rollbackWeek,
    exportProbeSet,
    start,
    stop,
    get busy() { return lock.held; },
    get running() { return timer !== null || bootTimer !== null; },
  };
}
