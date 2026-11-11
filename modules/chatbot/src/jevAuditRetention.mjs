// Retention for final Jev retrospective manifests. These files contain durable
// customer identifiers, so they are never treated as harmless reports.
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const JEV_AUDIT_RETENTION_MS = 30 * 86_400_000;
const BATCH = /^[a-z0-9][a-z0-9_-]{0,79}\.json$/u;
const MAX_BYTES = 16 * 1024 * 1024;

function fail(code) { const error = new Error(code); error.code = code; throw error; }

function safeDirectory(directory) {
  if (!directory || !String(directory).trim()) return null;
  const requested = resolve(String(directory));
  let stat;
  try { stat = lstatSync(requested); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("jev_audit_directory_invalid");
  return realpathSync(requested);
}

function listFinalFiles(directory) {
  const entries = readdirSync(directory);
  // The configured directory is a final-manifest store, not a scratch area.
  // A stranded resume/checkpoint can contain the same customer data, so fail
  // closed until an operator resolves it rather than silently forgetting only
  // one copy.
  for (const name of entries) if (!BATCH.test(name)) fail("jev_audit_directory_contains_nonfinal_file");
  return entries;
}

function readManifest(directory, name) {
  const path = join(directory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail("jev_audit_manifest_invalid");
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, "utf8")); } catch { fail("jev_audit_manifest_invalid"); }
  if (manifest?.schemaVersion !== 1 || manifest?.batchId !== name.slice(0, -5) || !Array.isArray(manifest.cases) || manifest.cases.length > 20_000) fail("jev_audit_manifest_invalid");
  return { path, manifest };
}

function timestamp(manifest) {
  const at = Number(manifest.completedAt ?? manifest.createdAt);
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

export function isJevAuditExpired(manifest, { now = Date.now(), retentionMs = JEV_AUDIT_RETENTION_MS } = {}) {
  const completedAt = timestamp(manifest);
  return completedAt == null || now - completedAt >= retentionMs;
}

function writeAtomic(path, manifest) {
  const temp = `${path}.retention-${process.pid}-${Date.now()}`;
  try { writeFileSync(temp, JSON.stringify(manifest), { mode: 0o600, flag: "wx" }); renameSync(temp, path); }
  catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}

// Mutates only when explicitly called by an owner-authorized lifecycle/CLI.
// GET routes must never call this function.
export function purgeExpiredJevAuditManifests({ auditDir, now = Date.now(), retentionMs = JEV_AUDIT_RETENTION_MS } = {}) {
  const directory = safeDirectory(auditDir); if (!directory) return { scanned: 0, deleted: 0 };
  // Parse every report before unlinking any. A corrupt sibling must never
  // leave the store half-purged while an operator investigates it.
  const reports = listFinalFiles(directory).map(name => readManifest(directory, name));
  let deleted = 0;
  for (const { path, manifest } of reports) {
    if (isJevAuditExpired(manifest, { now, retentionMs })) { unlinkSync(path); deleted += 1; }
  }
  return { scanned: reports.length, deleted };
}

// Erase cases before the database row disappears. Any unsafe artifact causes a
// throw, allowing the caller to leave the customer's DB history untouched.
export function eraseCustomerFromJevAuditManifests({ auditDir, customerIds = [] } = {}) {
  const ids = new Set(customerIds.map(String).filter(Boolean));
  const directory = safeDirectory(auditDir); if (!directory || !ids.size) return { scanned: 0, rewritten: 0, deleted: 0, casesRemoved: 0 };
  // Validate the entire final store before changing even one report. This is
  // the transaction boundary paired with the later SQLite forget operation.
  const reports = listFinalFiles(directory).map(name => readManifest(directory, name));
  let rewritten = 0, deleted = 0, casesRemoved = 0;
  for (const { path, manifest } of reports) {
    const before = manifest.cases.length;
    manifest.cases = manifest.cases.filter((row) => !ids.has(String(row?.customerId || "")));
    const removed = before - manifest.cases.length;
    if (!removed) continue;
    casesRemoved += removed;
    if (!manifest.cases.length) { unlinkSync(path); deleted += 1; }
    else { writeAtomic(path, manifest); rewritten += 1; }
  }
  return { scanned: reports.length, rewritten, deleted, casesRemoved };
}
