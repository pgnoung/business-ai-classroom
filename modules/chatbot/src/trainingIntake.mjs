// Curated training intake: deterministic, proposal-only, and deliberately
// separate from any provider transcript or customer record.
import { createHash } from "node:crypto";
import { trainingIntakeEntryHash } from "./trainingIntakeIdentity.mjs";
import { learningRiskFlags, knowledgeDigest } from "./learningDigest.mjs";
import { teachPrivacyRefusal } from "./brain/teach.mjs";
import { normalizeKnowledgeMetadata } from "./brain/knowledgeMetadata.mjs";
import { brainModeOf, BRAIN_MODE_SEPARATE } from "./knowledgePack.mjs";

export const TRAINING_INTAKE_MAX = Object.freeze({ entries: 40, title: 200, question: 2000, answer: 8000, total: 200000 });
const ORIGINS = new Set(["team_notes", "line_oa_curated"]);
const TOP_KEYS = new Set(["origin", "channelId", "knowledgeMetadata", "entries"]);
const ENTRY_KEYS = new Set(["title", "question", "answer"]);

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const stable = (value) => JSON.stringify(value);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const singleLineText = (value, max) => {
  if (typeof value !== "string") throw new IntakeError("invalid_input");
  const out = value.normalize("NFKC").trim();
  if (!out || [...out].length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(out)) throw new IntakeError("invalid_input");
  return out;
};
// CSV cells may carry a quoted, multi-line question or answer.  Normalize the
// two newline spellings before hashing so a Windows export cannot create a
// second proposal, while keeping titles single-line for the existing console.
const multiLineText = (value, max) => {
  if (typeof value !== "string") throw new IntakeError("invalid_input");
  const out = value.normalize("NFKC").replace(/\r\n?|\n/gu, "\n").trim();
  // LF and tab are intentional cell formatting; every other control remains
  // forbidden, including bare CR (which the normalization above removes).
  if (!out || [...out].length > max || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(out)) {
    throw new IntakeError("invalid_input");
  }
  return out;
};
const sorted = (items) => [...items].sort((a, b) => a.entryHash.localeCompare(b.entryHash));
const bangkokDay = (at) => new Date(Number(at) + 7 * 3_600_000).toISOString().slice(0, 10);

export class IntakeError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function closedObject(value, allowed) {
  return plain(value) && Object.keys(value).every((key) => allowed.has(key));
}

function resolveScope({ db, channels = [], channelId }) {
  if (channelId === null || channelId === undefined || channelId === "") return null;
  if (typeof channelId !== "string") throw new IntakeError("invalid_scope");
  const id = channelId.normalize("NFKC").trim();
  const channel = channels.find((item) => item?.id === id && item.active !== false);
  if (!channel || brainModeOf(db, id) !== BRAIN_MODE_SEPARATE) throw new IntakeError("invalid_scope");
  return id;
}

function validateRows(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > TRAINING_INTAKE_MAX.entries) throw new IntakeError("invalid_entries");
  let chars = 0;
  const rows = entries.map((entry, index) => {
    if (!closedObject(entry, ENTRY_KEYS) || !Object.hasOwn(entry, "title") || !Object.hasOwn(entry, "question") || !Object.hasOwn(entry, "answer")) throw new IntakeError("invalid_entry");
    const title = singleLineText(entry.title, TRAINING_INTAKE_MAX.title);
    const question = multiLineText(entry.question, TRAINING_INTAKE_MAX.question);
    const answer = multiLineText(entry.answer, TRAINING_INTAKE_MAX.answer);
    chars += [...title].length + [...question].length + [...answer].length;
    if (chars > TRAINING_INTAKE_MAX.total) throw new IntakeError("too_large");
    const content = `คำถาม: ${question}\nคำตอบ: ${answer}`;
    const flags = learningRiskFlags(title, question, answer);
    const privacy = teachPrivacyRefusal({ cardText: `${title}\n${content}` });
    const issueCodes = [...new Set([...flags, ...(privacy ? ["privacy_refusal"] : [])])];
    return { index, title, question, answer, content, riskFlags: [...new Set(flags)], issueCodes, blocked: issueCodes.length > 0 };
  });
  return rows;
}

/** Parse and canonicalize an intake body. No untrusted scope or hash survives. */
export function validateTrainingIntake({ db, config = {}, channels = [], body }) {
  // Keep the service fail-closed even if a future console route forgets its
  // outer flag checks.  This is an authoring capability, never a generic DB API.
  if (config.trainingIntakeEnabled !== true || config.teachEnabled !== true) {
    throw new IntakeError("intake_disabled", 404);
  }
  if (!closedObject(body, TOP_KEYS)
    || !Object.hasOwn(body, "origin") || !Object.hasOwn(body, "channelId")
    || !Object.hasOwn(body, "knowledgeMetadata") || !Object.hasOwn(body, "entries")) throw new IntakeError("invalid_input");
  if (typeof body.origin !== "string") throw new IntakeError("invalid_origin");
  const origin = body.origin;
  if (!ORIGINS.has(origin)) throw new IntakeError("invalid_origin");
  let knowledgeMetadata;
  try { knowledgeMetadata = normalizeKnowledgeMetadata(body.knowledgeMetadata); }
  catch { throw new IntakeError("invalid_metadata"); }
  if (knowledgeMetadata.mode !== "retrieve") throw new IntakeError("invalid_metadata");
  const metadataText = [knowledgeMetadata.domain, knowledgeMetadata.offering, ...knowledgeMetadata.keywords].join("\n");
  if (learningRiskFlags(metadataText).length || teachPrivacyRefusal({ cardText: metadataText })) {
    // Metadata is persisted with every resulting fact.  It must clear the same
    // privacy/risk boundary as the proposed content, without echoing it back.
    throw new IntakeError("risk_rejected");
  }
  const scope = resolveScope({ db, channels, channelId: body.channelId });
  const rows = validateRows(body.entries);
  const knowledgeDigestValue = knowledgeDigest(db);
  const canonicalRows = rows.map(({ index, title, content, riskFlags, issueCodes, blocked }) => ({
    index, title, content, riskFlags, issueCodes, blocked,
  }));
  const entryRows = canonicalRows.map((row) => ({
    ...row,
    // Title is presentation, not the knowledge identity.  Two teams can title
    // the same answer differently without creating duplicate proposed facts.
    entryHash: trainingIntakeEntryHash({ content: row.content, origin, scope, knowledgeMetadata }),
  }));
  const batchHash = hash(stable({ origin, scope, knowledgeMetadata, entries: sorted(entryRows).map(({ title, content, entryHash }) => ({ title, content, entryHash })), knowledgeDigest: knowledgeDigestValue }));
  return { origin, scope, knowledgeMetadata, rows: entryRows, knowledgeDigest: knowledgeDigestValue, batchHash };
}

function publicRow(row, duplicate, conflicts) {
  // A risky row must not reflect its submitted text back to the browser.  The
  // caller can use the index to edit it, while the API exposes only issue codes.
  if (row.blocked) return { index: row.index, issueCodes: row.issueCodes };
  return {
    index: row.index, title: row.title, content: row.content,
    riskFlags: row.riskFlags, conflictCount: conflicts, duplicate,
  };
}

export function createTrainingIntakeService({ db, config = {}, channels = [], now = () => Date.now() } = {}) {
  function preview(body) {
    const proposal = validateTrainingIntake({ db, config, channels, body });
    const rows = proposal.rows.map((row) => {
      const duplicate = typeof db.getLearningCandidateByCluster === "function"
        && Boolean(db.getLearningCandidateByCluster(`training-intake:${row.entryHash}`));
      const conflicts = typeof db.findActiveKnowledgeMatches === "function"
        ? db.findActiveKnowledgeMatches({ title: row.title, content: row.content, channelId: proposal.scope }).length : 0;
      return publicRow(row, duplicate, conflicts);
    });
    const blocked = rows.filter((row) => Array.isArray(row.issueCodes)).length;
    const duplicates = rows.filter((row) => row.duplicate).length;
    return {
      ok: true, previewHash: proposal.batchHash, knowledgeDigest: proposal.knowledgeDigest,
      origin: proposal.origin, channelId: proposal.scope, knowledgeMetadata: proposal.knowledgeMetadata,
      rows, summary: { total: rows.length, ready: rows.length - blocked - duplicates, blocked, duplicates },
      canCommit: blocked === 0,
    };
  }

  function commit({ body, previewHash, submittedBy = "" }) {
    const proposal = validateTrainingIntake({ db, config, channels, body });
    if (String(previewHash || "") !== proposal.batchHash) throw new IntakeError("stale_preview", 409);
    if (proposal.rows.some((row) => row.blocked)) throw new IntakeError("risk_rejected");
    const created = []; const duplicates = []; const at = now();
    const write = () => {
      // Recheck under the same transaction as all candidate and audit writes.
      if (validateTrainingIntake({ db, config, channels, body }).batchHash !== proposal.batchHash) {
        throw new IntakeError("stale_preview", 409);
      }
      for (const row of sorted(proposal.rows)) {
        const clusterKey = `training-intake:${row.entryHash}`;
        const existing = db.getLearningCandidateByCluster?.(clusterKey);
        if (existing) { duplicates.push(existing.id); continue; }
        const candidate = db.createLearningCandidate({
          runId: `training-intake:${proposal.batchHash}`, dayKey: bangkokDay(at), clusterKey,
          channelId: proposal.scope, kind: "cluster", title: row.title, proposedContent: row.content,
          evidence: [{ type: "training_intake", schema: "training-intake-v1", origin: proposal.origin,
            batchHash: proposal.batchHash, entryHash: row.entryHash, submittedBy: String(submittedBy), knowledgeMetadata: proposal.knowledgeMetadata }],
          conflicts: [], riskFlags: [], knowledgeDigest: proposal.knowledgeDigest,
        });
        if (!candidate) throw new Error("training intake candidate write failed");
        created.push(candidate.id);
      }
      db.addAudit({ operator: String(submittedBy), action: "training_intake_commit", target: "learning_candidates",
        detail: JSON.stringify({ batchHash: proposal.batchHash, total: proposal.rows.length, created: created.length, duplicates: duplicates.length }) });
    };
    if (typeof db.brainTransaction !== "function") throw new Error("training intake requires atomic persistence");
    db.brainTransaction(write);
    return { ok: true, created: created.length, duplicates: duplicates.length, candidateIds: created, previewHash: proposal.batchHash, published: false };
  }
  return { preview, commit };
}
