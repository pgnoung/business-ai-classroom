#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RETROSPECTIVE_POLICY, auditRetrospectiveCases, compareRetrospectiveDecision,
  enumerateRetrospectiveCases, finalizeManifest, parseRetrospectiveAnswer,
} from "../src/jevRetrospectiveAudit.mjs";
import { purgeExpiredJevAuditManifests } from "../src/jevAuditRetention.mjs";

export function restoreReviewedCases(cases, prior, { startMs, cutoffMs }) {
  if (prior.schemaVersion !== 1 || prior.policy !== RETROSPECTIVE_POLICY
    || prior.startMs !== startMs || prior.cutoffMs !== cutoffMs || !Array.isArray(prior.cases)) {
    throw new Error("resume_scope_or_policy_mismatch");
  }
  const savedById = new Map(prior.cases.map(item => [item.id, item]));
  for (const item of cases) {
    const saved = savedById.get(item.id);
    if (saved?.evidenceHash !== item.evidenceHash || saved.jev?.status !== "reviewed") continue;
    try {
      const answers = Object.fromEntries(["stop", "notify", "complaint", "reason"].map(key => [key, { ...saved.jev[key], type: "choice" }]));
      const checked = parseRetrospectiveAnswer({ model: saved.jev.model, answers });
      item.jev = { status: "reviewed", model: saved.jev.model, ...checked };
      item.comparison = compareRetrospectiveDecision(item.original, item.jev);
    } catch { /* An invalid cache is rechecked, never displayed as a verdict. */ }
  }
}

export function filterRetainedCases(db, cases) {
  const customerExists = db.prepare("SELECT 1 FROM customers WHERE line_user_id=?");
  const anchorExists = db.prepare("SELECT 1 FROM messages WHERE id=? AND customer_id=?");
  const historyExists = db.prepare("SELECT 1 FROM messages WHERE customer_id=? AND created_at<=? LIMIT 1");
  const retained = cases.filter(item => customerExists.get(item.customerId)
    && (item.anchorMessageId ? anchorExists.get(item.anchorMessageId, item.customerId)
      : historyExists.get(item.customerId, item.atMs)));
  Object.defineProperty(retained, "coverage", { value: {
    ...cases.coverage,
    detectedCases: cases.length,
    unreviewableMissingInbound: cases.filter(item => !item.anchorMessageId).length,
    retentionFilteredCurrentHistory: cases.length - retained.length,
  }, enumerable: false });
  return retained;
}

export async function main(args = process.argv.slice(2)) {
  const value = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
  const dbFile = value("--db"), out = value("--output-dir"), resume = value("--resume");
  const execute = args.includes("--execute"), maxCalls = Number(value("--max-calls") || 0);
  const startMs = Number(value("--start-ms") || 1788195600000), cutoffMs = Number(value("--cutoff-ms"));
  if (!dbFile || !out) throw new Error("db_and_output_dir_required");
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(cutoffMs) || cutoffMs < startMs) throw new Error("invalid_time_window");
  if (execute && (!Number.isSafeInteger(maxCalls) || maxCalls < 1)) throw new Error("positive_max_calls_required");
  // Final reports share the runtime retention directory. Resuming in place
  // avoids leaving duplicate customer-linked manifests in a scratch directory.
  if (resume && resolve(resume) !== join(resolve(out), `${JSON.parse(readFileSync(resume, "utf8")).batchId}.json`)) {
    throw new Error("resume_must_be_in_final_directory");
  }
  const createdAt = Date.now();
  const db = new DatabaseSync(dbFile, { readOnly: true });
  let cases;
  try { cases = enumerateRetrospectiveCases(db, { startMs, cutoffMs }); } finally { db.close(); }
  const prior = resume ? JSON.parse(readFileSync(resume, "utf8")) : null;
  if (prior) restoreReviewedCases(cases, prior, { startMs, cutoffMs });
  let lastProgress = 0;
  const result = await auditRetrospectiveCases(cases, {
    apiKey: process.env.TYPESAFE_API_KEY || "", execute, maxCalls, maxConcurrent: 1,
    onProgress: ({ processed, total, calls, aborted }) => {
      const now = Date.now();
      if (processed % 50 === 0 || now - lastProgress >= 30_000 || processed === total) {
        lastProgress = now;
        process.stderr.write(JSON.stringify({ auditProgress: { processed, total, calls, aborted: Boolean(aborted) } }) + "\n");
      }
    },
  });
  // Current state is consulted only to avoid restoring erased data after a long
  // provider run. It never enters historical evidence, hashes, or JEV requests.
  const currentDb = new DatabaseSync(dbFile, { readOnly: true });
  try { cases = filterRetainedCases(currentDb, cases); } finally { currentDb.close(); }
  const manifest = finalizeManifest({
    ...(prior ? { batchId: prior.batchId } : {}), startMs, cutoffMs, cases, createdAt, completedAt: Date.now(),
  });
  manifest.runtime = {
    execute, calls: result.calls, aborted: result.aborted,
    cumulativeCalls: Number(prior?.runtime?.cumulativeCalls ?? prior?.runtime?.calls ?? 0) + result.calls,
    attempts: Number(prior?.runtime?.attempts || (prior ? 1 : 0)) + 1,
  };
  mkdirSync(out, { recursive: true, mode: 0o700 });
  purgeExpiredJevAuditManifests({ auditDir: out });
  const file = join(out, `${manifest.batchId}.json`), temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
  console.log(JSON.stringify({ batchId: manifest.batchId, file, counts: manifest.counts, runtime: manifest.runtime }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("audit_failed; no customer data logged"); process.exitCode = 1; });
}
