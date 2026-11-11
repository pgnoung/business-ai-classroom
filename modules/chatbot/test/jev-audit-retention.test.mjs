import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseCustomerFromJevAuditManifests, isJevAuditExpired, JEV_AUDIT_RETENTION_MS, purgeExpiredJevAuditManifests } from "../src/jevAuditRetention.mjs";
import { createRetention } from "../src/retention.mjs";

function dir(t) { const root = mkdtempSync(join(tmpdir(), "jev-retention-")); chmodSync(root, 0o700); t.after(() => {}); return root; }
function manifest(id, completedAt, customerIds) { return { schemaVersion: 1, batchId: id, createdAt: completedAt, completedAt, cases: customerIds.map((customerId, n) => ({ id: `${id}-${n}`, customerId })) }; }
function save(root, value) { writeFileSync(join(root, `${value.batchId}.json`), JSON.stringify(value), { mode: 0o600 }); }

test("Jev final manifests expire after 30 days and malformed reports fail closed", (t) => {
  const root = dir(t), now = 2_000_000_000_000;
  save(root, manifest("old", now - JEV_AUDIT_RETENTION_MS, ["U-old"]));
  save(root, manifest("fresh", now - JEV_AUDIT_RETENTION_MS + 1, ["U-fresh"]));
  assert.equal(isJevAuditExpired(manifest("old", now - JEV_AUDIT_RETENTION_MS, []), { now }), true);
  assert.deepEqual(purgeExpiredJevAuditManifests({ auditDir: root, now }), { scanned: 2, deleted: 1 });
  assert.equal(JSON.parse(readFileSync(join(root, "fresh.json"))).batchId, "fresh");
  writeFileSync(join(root, "broken.json"), "{");
  assert.throws(() => purgeExpiredJevAuditManifests({ auditDir: root, now }), /jev_audit_manifest_invalid/u);
});

test("forget erases cases for current and legacy IDs before database deletion", (t) => {
  const root = dir(t), now = Date.now();
  save(root, manifest("batch", now, ["U-current", "U-legacy", "U-other"]));
  assert.deepEqual(eraseCustomerFromJevAuditManifests({ auditDir: root, customerIds: ["U-current", "U-legacy"] }), { scanned: 1, rewritten: 1, deleted: 0, casesRemoved: 2 });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "batch.json"))).cases.map(row => row.customerId), ["U-other"]);
  assert.deepEqual(eraseCustomerFromJevAuditManifests({ auditDir: root, customerIds: ["U-other"] }), { scanned: 1, rewritten: 0, deleted: 1, casesRemoved: 1 });
});

test("forget rejects symlinked or non-final artifact stores before touching a report", (t) => {
  const parent = dir(t), target = join(parent, "target"), link = join(parent, "link"); mkdirSync(target, { mode: 0o700 }); symlinkSync(target, link);
  assert.throws(() => eraseCustomerFromJevAuditManifests({ auditDir: link, customerIds: ["U"] }), /jev_audit_directory_invalid/u);
  const root = join(parent, "final"); mkdirSync(root, { mode: 0o700 }); writeFileSync(join(root, "resume.tmp"), "private checkpoint");
  assert.throws(() => eraseCustomerFromJevAuditManifests({ auditDir: root, customerIds: ["U"] }), /jev_audit_directory_contains_nonfinal_file/u);
});

test("forget validates every final report before changing any customer case", (t) => {
  const root = dir(t), now = Date.now();
  save(root, manifest("first", now, ["U"]));
  writeFileSync(join(root, "second.json"), "{");
  assert.throws(() => eraseCustomerFromJevAuditManifests({ auditDir: root, customerIds: ["U"] }), /jev_audit_manifest_invalid/u);
  assert.deepEqual(JSON.parse(readFileSync(join(root, "first.json"))).cases.map(row => row.customerId), ["U"]);
});

test("Jev audit expiry remains active when chassis-table retention is disabled", (t) => {
  const root = dir(t), now = 2_000_000_000_000;
  save(root, manifest("old", now - JEV_AUDIT_RETENTION_MS, ["U"]));
  const retention = createRetention({
    config: { retentionEnabled: false, jevAuditDir: root }, now: () => now,
    db: { pruneRetention() { throw new Error("must not prune chassis tables"); } },
    logger: { log() {}, warn() {} },
  });
  assert.deepEqual(retention.runOnce(), { skipped: true, reason: "retention_disabled", jevAudit: { scanned: 1, deleted: 1 } });
  assert.throws(() => readFileSync(join(root, "old.json")), /ENOENT/u);
});
