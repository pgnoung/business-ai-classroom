// Safe, read-only Brain readiness summary for the owner console.  It deliberately
// exports counts and fixed identifiers only: details stay in the offline tool.
import { compileBrain } from "./compile.mjs";
import { runBrainGates } from "./gate.mjs";
import { brainParityReport } from "./parity.mjs";
import { BRAIN_PARITY_STREAK_KEY } from "./parityWatch.mjs";

const QUIET = Object.freeze({ warn() {}, debug() {}, log() {}, error() {} });
const DEBT_CODES = new Set(["G0", "G1", "G2", "G3", "G4", "G5", "G8", "L01", "L02", "L02b", "L03", "L05", "L07", "L11", "L12", "L15", "L16"]);
const PARITY_REASONS = new Set(["match", "mismatch", "no_brain_version", "no_live_pointer", "brain_tables_unavailable", "compile_failed"]);

function safeJson(text, fallback) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch { return fallback; }
}

function safeArray(text) {
  const parsed = safeJson(text, []);
  return Array.isArray(parsed) ? parsed : [];
}

function countsByCode(findings) {
  const counts = {};
  for (const finding of findings ?? []) {
    const code = String(finding?.code || "");
    if (DEBT_CODES.has(code)) counts[code] = (counts[code] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function parityReason(reason) {
  const value = String(reason || "");
  if (value.startsWith("compile_failed:")) return "compile_failed";
  return PARITY_REASONS.has(value) ? value : "unknown";
}

function storedStreakDays(db) {
  const stored = safeJson(db.getSetting?.(BRAIN_PARITY_STREAK_KEY), null);
  const days = Number(stored?.days);
  return Number.isFinite(days) ? Math.max(0, Math.trunc(days)) : 0;
}

/** Exact gate preview shared with the CLI; the console serializes only the safe summary below. */
export function previewGates(db, { todayIso, classRoundsFile = null } = {}) {
  const live = db.getBrainPointer("live");
  if (!live) return { ok: false, reason: "no_live_pointer" };
  const bundle = compileBrain(db, live.version_id, { todayIso, logger: QUIET });
  const allIds = bundle.cards.map((card) => card.itemId);
  const acks = safeArray(live.gate_acks_json);
  const manifest = safeJson(live.manifest_json, {});
  const shared = { cards: bundle.cards, bundle, todayIso, allowlist: manifest.lintAllowlist ?? [], previousBundle: bundle };
  return {
    ok: true,
    versionId: live.version_id,
    seq: live.seq,
    cards: allIds.length,
    parity: brainParityReport(db, { todayIso, classRoundsFile, logger: QUIET }),
    cardsById: new Map(bundle.cards.map((card) => [card.itemId, {
      title: String(card.body?.title ?? "").trim() || card.key, key: card.key,
    }])),
    debt: runBrainGates({ ...shared, touched: [], inheritedAcks: acks }),
    worst: runBrainGates({ ...shared, touched: allIds, inheritedAcks: acks }),
  };
}

export function brainReadiness({ db, config = {}, todayIso = null, classRoundsFile = null } = {}) {
  const live = db.getBrainPointer?.("live") ?? null;
  const flags = {
    knowledgeVersioned: config.knowledgeVersioned === true,
    brainRetrievalEnabled: config.brainRetrievalEnabled === true,
    brainRead: config.brainRead === "versioned" ? "versioned" : "legacy",
  };
  const preview = previewGates(db, { todayIso, classRoundsFile });
  const parity = preview.ok
    ? preview.parity
    : brainParityReport(db, { todayIso, classRoundsFile, logger: QUIET });
  const counts = preview.ok ? countsByCode(preview.debt.needsAck) : {};
  const seq = Number(live?.seq);
  return {
    live: { exists: Boolean(live), seq: Number.isSafeInteger(seq) ? seq : null },
    flags,
    parity: {
      ok: parity.ok === true,
      reason: parityReason(parity.reason),
      mismatchParts: (parity.mismatches ?? []).map((item) => String(item?.part || "")).filter(Boolean).sort(),
      streakDays: storedStreakDays(db),
    },
    debt: { pending: Object.keys(counts).length > 0, countsByCode: counts },
    selfEdit: { blockingCount: preview.ok ? (preview.worst.blocking?.length || 0) : 0 },
    // A clean preview never authorizes activation: a newly proposed version still
    // needs normal owner review; inherited debt separately requires acknowledgement.
    publication: { ownerReviewRequired: true, inheritedAckRequired: Object.keys(counts).length > 0 },
    activation: { status: "not_evaluated" },
  };
}
