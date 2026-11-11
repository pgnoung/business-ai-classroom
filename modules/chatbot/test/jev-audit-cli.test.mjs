import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { enumerateRetrospectiveCases, finalizeManifest, RETROSPECTIVE_QUESTIONS, compareRetrospectiveDecision } from "../src/jevRetrospectiveAudit.mjs";
import { filterRetainedCases } from "../scripts/audit-jev-stops.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-cli-"));
  const file = join(dir, "fixture.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE admin_audit (id TEXT,action TEXT,target TEXT,detail TEXT,created_at INTEGER);
    CREATE TABLE customers (line_user_id TEXT,display_name TEXT,known_name TEXT,channel_id TEXT);
    CREATE TABLE messages (id TEXT,customer_id TEXT,direction TEXT,channel TEXT,msg_type TEXT,content TEXT,message_class TEXT,operator TEXT,session_id TEXT,created_at INTEGER,channel_id TEXT);
    CREATE TABLE inbound_turn_outcomes (message_id TEXT,customer_id TEXT,channel_id TEXT,status TEXT,reason TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO customers VALUES ('fixture','Fixture','','default');
    INSERT INTO messages VALUES ('inbound','fixture','in','line','text','ขอราคา','','',NULL,90,'default');
    INSERT INTO admin_audit VALUES ('a','ai_off_bank_sent','fixture','',100);`);
  t.after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { db, dir, file };
}
function verdict() {
  const selected = { stop: "continue", notify: "notify", complaint: "none", reason: "bank_details_only" };
  return { status: "reviewed", model: "jev-1.13.0", ...Object.fromEntries(Object.entries(RETROSPECTIVE_QUESTIONS).map(([key, question]) => [key, {
    choice: selected[key], confidence: .9, confidence10: 9,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === selected[key] ? 1 : 0])),
  }])) };
}

test("real CLI --resume validates verdict and recomputes comparison from fresh events with zero provider calls", t => {
  const f = fixture(t);
  const cases = enumerateRetrospectiveCases(f.db, { startMs: 0, cutoffMs: 200 });
  cases[0].jev = verdict();
  cases[0].original.stop = "none";
  cases[0].comparison = { stop: "agree", notify: "agree" };
  const prior = finalizeManifest({ batchId: "resume-test", startMs: 0, cutoffMs: 200, cases });
  const out = join(f.dir, "reports");
  mkdirSync(out);
  const saved = join(out, "resume-test.json"); writeFileSync(saved, JSON.stringify(prior));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/audit-jev-stops.mjs", import.meta.url)),
    "--db", f.file, "--output-dir", out, "--start-ms", "0", "--cutoff-ms", "200", "--resume", saved, "--execute", "--max-calls", "1"],
  { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const current = JSON.parse(readFileSync(saved));
  assert.equal(current.runtime.calls, 0);
  assert.equal(current.cases[0].original.stop, "permanent");
  assert.equal(current.cases[0].comparison.stop, "disagree");
  assert.equal(current.counts.coverage.detectedCases, 1);
});


test("retention filtering accounts for lost history and keeps non-identifying coverage", t => {
  const f = fixture(t);
  const cases = [
    { customerId: "fixture", anchorMessageId: "inbound", atMs: 100 },
    { customerId: "fixture", anchorMessageId: null, atMs: 100 },
    { customerId: "forgotten", anchorMessageId: null, atMs: 100 },
  ];
  Object.defineProperty(cases, "coverage", { value: { manualEventsExcluded: 4 } });
  const retained = filterRetainedCases(f.db, cases);
  assert.equal(retained.length, 2);
  assert.deepEqual(retained.coverage, { manualEventsExcluded: 4, detectedCases: 3, unreviewableMissingInbound: 2, retentionFilteredCurrentHistory: 1 });
  assert.doesNotMatch(JSON.stringify(retained), /forgotten/u);
});

test("all stranded outcomes finalized in window include prior inbound and no future evidence", t => {
  const f = fixture(t);
  f.db.exec("DELETE FROM admin_audit");
  for (const [i, status] of ["stranded_error", "stranded_shutdown", "stranded_ambiguous", "stranded_crash"].entries()) {
    const id = `case-${i}`;
    f.db.prepare("INSERT INTO messages VALUES (?,?,'in','line','text','ก่อนเหตุการณ์','','',NULL,90,'default')").run(id, id);
    f.db.prepare("INSERT INTO messages VALUES (?,?,'in','line','text','future evidence','','',NULL,201,'default')").run(`future-${i}`, id);
    f.db.prepare("INSERT INTO inbound_turn_outcomes VALUES (?,?,'default',?,'process_died',90,150)").run(id, id, status);
  }
  const cases = enumerateRetrospectiveCases(f.db, { startMs: 100, cutoffMs: 200 });
  assert.equal(cases.length, 4);
  assert.ok(cases.every(item => item.atMs === 150 && !JSON.stringify(item._state).includes("future evidence")));
});

test("an unclear stop decision does not suppress a clear notify disagreement", () => {
  const result = compareRetrospectiveDecision({ stop: "unknown", notify: "provider_accepted" },
    { status: "reviewed", stop: { choice: "unclear" }, notify: { choice: "not_needed" } });
  assert.deepEqual(result, { stop: "unknown", notify: "disagree" });
});
