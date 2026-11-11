import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleJevAuditRoutes } from "../src/consoleJevAuditApi.mjs";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-audit-api-"));
  const db = memoryDb();
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const [id, channel] of [["one", "default"], ["two", "facebook"]]) {
    db.upsertCustomer(id, { channelId: channel, displayName: id });
    db.raw.prepare("INSERT INTO messages (id,customer_id,direction,channel,content,created_at) VALUES (?,?,'in','line','fixture',100)").run(`message-${id}`, id);
  }
  const row = (id, channel, suffix = "") => ({
    id: `${id}${suffix}`, customerId: id, channelId: channel, atMs: 200, anchorMessageId: `message-${id}`,
    eventKinds: ["ai_off_bank_sent"], original: { stop: "permanent", notify: "provider_accepted" },
    jev: { status: "reviewed", model: "jev-1.13.0", stop: { choice: "continue", confidence10: 9.3 }, notify: { choice: "notify", confidence10: 9.8 } },
    comparison: { stop: "disagree", notify: "agree" }, transcript: "MUST_NOT_ESCAPE",
  });
  const manifest = { schemaVersion: 1, batchId: "september", startMs: 1, cutoffMs: 300, completedAt: Date.now(), policy: "test", cases: [row("one", "default"), row("two", "facebook")] };
  const save = () => writeFileSync(join(dir, "september.json"), JSON.stringify(manifest), { mode: 0o600 }); save();
  const config = { chatHistoryEnabled: true, jevAuditDir: dir };
  const routes = createConsoleJevAuditRoutes({ config, db, channels: [{ id: "default" }, { id: "facebook" }] });
  async function get(path = "/console/api/jev-audits", { role = "owner", method = "GET" } = {}) {
    const url = new URL(path, "http://fixture");
    let answer;
    await routes.handle({ method }, {}, url, url.pathname.split("/").slice(3), { username: "tester", operator: { role }, json: (_res, status, body) => { answer = { status, body }; } });
    return answer;
  }
  return { db, dir, config, manifest, save, row, get };
}

test("retrospective results enforce live channel permissions and omit transcript fields", async t => {
  const f = fixture(t);
  const owner = await f.get("/console/api/jev-audits/september/cases");
  assert.equal(owner.status, 200); assert.equal(owner.body.rows.length, 2);
  assert.doesNotMatch(JSON.stringify(owner.body), /MUST_NOT_ESCAPE|transcript/u);
  f.db.listOperatorChannels = () => ["default"];
  const staff = await f.get("/console/api/jev-audits/september/cases", { role: "operator" });
  assert.equal(staff.body.rows.length, 1); assert.equal(staff.body.rows[0].customerId, "one");
  assert.equal(staff.body.batch.counts.cases, 1);
  const list = await f.get("/console/api/jev-audits", { role: "operator" });
  assert.equal(list.body.batches[0].counts.providerAccepted, 1);
  f.db.listOperatorChannels = () => [];
  assert.equal((await f.get("/console/api/jev-audits/september/cases", { role: "operator" })).status, 404);
});

test("reset or forgotten conversation evidence cannot reappear from a report", async t => {
  const f = fixture(t);
  f.db.raw.prepare("DELETE FROM messages WHERE customer_id='one'").run();
  const result = await f.get("/console/api/jev-audits/september/cases");
  assert.deepEqual(result.body.rows.map(row => row.customerId), ["two"]);
});

test("expired reports and dry runs are not presented as current JEV results", async t => {
  const f = fixture(t);
  f.manifest.runtime = { execute: false }; f.save();
  assert.equal((await f.get()).body.batches.length, 0);
  f.manifest.runtime.execute = true;
  f.manifest.completedAt = Date.now() - 31 * 86400000; f.save();
  assert.equal((await f.get("/console/api/jev-audits/september/cases")).status, 404);
  assert.equal((await f.get()).body.batches.length, 0);
});

test("audit pagination is deterministic across equal timestamps and filters", async t => {
  const f = fixture(t);
  f.manifest.cases = Array.from({ length: 61 }, (_, i) => f.row("one", "default", String(i).padStart(3, "0"))); f.save();
  const first = await f.get("/console/api/jev-audits/september/cases?filter=disagreement&limit=50");
  const next = await f.get(`/console/api/jev-audits/september/cases?filter=disagreement&limit=50&cursor=${first.body.nextCursor}`);
  assert.equal(new Set([...first.body.rows, ...next.body.rows].map(row => row.id)).size, 61);
  assert.equal(next.body.hasMore, false);
  assert.equal((await f.get("/console/api/jev-audits/september/cases?cursor=nope")).status, 400);
});

test("reports are read-only and reject symlinks, malformed JSON and disabled access", async t => {
  const f = fixture(t);
  assert.equal((await f.get("/console/api/jev-audits", { method: "POST" })).status, 405);
  symlinkSync(join(f.dir, "september.json"), join(f.dir, "linked.json"));
  assert.equal((await f.get("/console/api/jev-audits/linked/cases")).status, 503);
  writeFileSync(join(f.dir, "september.json"), "broken");
  assert.equal((await f.get("/console/api/jev-audits/september/cases")).status, 503);
  f.config.chatHistoryEnabled = false;
  assert.equal((await f.get()).status, 404);
});
