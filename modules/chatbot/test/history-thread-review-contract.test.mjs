import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleJevAuditRoutes } from "../src/consoleJevAuditApi.mjs";
import { createConsoleHistoryRoutes } from "../src/consoleHistoryApi.mjs";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

function fixture(t) {
  const db = memoryDb();
  const dir = mkdtempSync(join(tmpdir(), "history-review-contract-"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = { chatHistoryEnabled: true, jevAuditDir: dir };
  const channels = [{ id: "default" }, { id: "other" }];
  const audit = createConsoleJevAuditRoutes({ config, db, channels });
  const history = createConsoleHistoryRoutes({ config, db, channels });
  const manifest = { schemaVersion: 1, batchId: "batch-test", startMs: 1, cutoffMs: 10000, completedAt: Date.now(), cases: [] };
  const file = join(dir, "batch-test.json");
  const save = () => writeFileSync(file, JSON.stringify(manifest));
  function message(customerId, id, at, content = "fixture") {
    db.upsertCustomer(customerId, { displayName: customerId });
    db.raw.prepare("INSERT INTO messages(id,customer_id,channel_id,direction,channel,content,created_at) VALUES (?,?,'default','in','line',?,?)").run(id, customerId, content, at);
  }
  function addCase(id, customerId = id, choices = {}) {
    message(customerId, `anchor-${id}`, 100);
    const row = { id, customerId, channelId: "default", atMs: 200, anchorMessageId: `anchor-${id}`, evidenceHash: "a".repeat(64), eventKinds: ["fixture"],
      original: { stop: "permanent", notify: "provider_accepted" }, comparison: { stop: "disagree", notify: "agree" },
      jev: { status: "reviewed", model: "jev-1.13.0", stop: { choice: "continue", confidence10: 9.2 }, notify: { choice: "notify", confidence10: 9.4 }, ...choices },
    };
    manifest.cases.push(row); return row;
  }
  async function request(path, options = {}) {
    const url = new URL(path, "http://fixture");
    let response;
    const ctx = { username: "reviewer", operator: { role: options.role || "owner" }, requireCsrf: () => options.csrf !== false,
      readJson: async () => options.body, json: (_res, status, body) => { response = { status, body }; } };
    const route = url.pathname.split("/").slice(3);
    await (route[0] === "history" ? history : audit).handle({ method: options.method || "GET" }, {}, url, route, ctx);
    return response;
  }
  const review = (id, body, options = {}) => request(`/console/api/jev-audits/batch-test/cases/${id}/review`, { method: "PUT", body, ...options });
  return { db, dir, file, manifest, save, message, addCase, request, review };
}

test("thread lists enforce 30-room pages and review filters reflect saved marks", async t => {
  const f = fixture(t);
  for (let i = 0; i < 35; i++) f.addCase(`room-${String(i).padStart(2, "0")}`);
  f.save();
  const first = await f.request("/console/api/jev-audits/batch-test/threads?limit=30");
  assert.equal(first.status, 200); assert.equal(first.body.threads.length, 30); assert.equal(first.body.hasMore, true);
  const second = await f.request(`/console/api/jev-audits/batch-test/threads?limit=30&cursor=${first.body.nextCursor}`);
  assert.equal(second.body.threads.length, 5);
  assert.equal(new Set([...first.body.threads, ...second.body.threads].map(row => row.customerId)).size, 35);
  assert.equal((await f.review("room-00", { stop: "incorrect", notify: "correct", note: "local fixture", expectedRevision: 0 })).status, 200);
  const reviewed = await f.request("/console/api/jev-audits/batch-test/threads?filter=reviewed");
  assert.deepEqual(reviewed.body.threads.map(row => row.customerId), ["room-00"]);
  assert.equal((await f.request("/console/api/jev-audits/batch-test/cases?filter=reviewed")).body.rows.length, 1);
});

test("review requires owner and CSRF, rejects invalid labels, and never overwrites a newer review", async t => {
  const f = fixture(t); f.addCase("case"); f.save();
  const value = { stop: "incorrect", notify: "correct", note: "private fixture note", expectedRevision: 0 };
  assert.equal((await f.review("case", value, { role: "admin" })).status, 403);
  assert.equal((await f.review("case", value, { csrf: false })).status, 403);
  assert.equal((await f.review("case", { ...value, expectedRevision: "0" })).status, 400);
  assert.equal((await f.review("case", { ...value, note: {} })).status, 400);
  assert.equal((await f.review("case", value)).status, 200);
  assert.equal((await f.review("case", { ...value, stop: "correct" })).status, 409);
  const data = await f.request("/console/api/jev-audits/batch-test/cases");
  assert.equal(data.body.rows[0].feedback.stop, "incorrect");
  assert.equal(data.body.rows[0].feedback.note, "private fixture note");
  assert.doesNotMatch(JSON.stringify(f.db.listAudit()), /private fixture note/);
});

test("human labels apply only to the native question that JEV actually answered", async t => {
  const f = fixture(t); f.addCase("partial", "partial", { notify: { choice: "unclear", confidence10: 0 } }); f.save();
  assert.equal((await f.review("partial", { stop: "correct", notify: "incorrect", expectedRevision: 0 })).status, 400);
  assert.equal((await f.review("partial", { stop: "correct", notify: null, expectedRevision: 0 })).status, 200);
});

test("saved feedback remains navigable after report expiry and disappears with erased evidence", async t => {
  const f = fixture(t); f.addCase("durable"); f.save();
  assert.equal((await f.review("durable", { stop: "incorrect", notify: "correct", note: "retained fixture", expectedRevision: 0 })).status, 200);
  f.manifest.completedAt = Date.now() - 31 * 86400000; f.save();
  for (const removeFile of [false, true]) {
    if (removeFile) rmSync(f.file);
    const batches = await f.request("/console/api/jev-audits");
    assert.equal(batches.body.batches.length, 1, "saved batch must remain reachable from selector");
    const threads = await f.request("/console/api/jev-audits/batch-test/threads?filter=reviewed");
    assert.equal(threads.status, 200); assert.equal(threads.body.threads.length, 1);
    const cases = await f.request("/console/api/jev-audits/batch-test/cases?customerId=durable&filter=reviewed");
    assert.equal(cases.status, 200); assert.equal(cases.body.rows[0].feedback.note, "retained fixture");
    assert.equal(cases.body.rows[0].original.stop, "permanent");
    assert.equal(cases.body.rows[0].jev.stop.confidence10, 9.2);
  }
  f.db.resetCustomer("durable", { forget: true });
  assert.equal(f.db.raw.prepare("SELECT count(*) AS n FROM jev_audit_feedback").get().n, 0);
  assert.equal((await f.request("/console/api/jev-audits")).body.batches.length, 0);
});

test("history finds older matching text and transcript pages go both ways in chronological order", async t => {
  const f = fixture(t);
  for (let i = 1; i <= 120; i++) f.message("history-room", `m-${i}`, i, i === 2 ? "needle-only-old-message" : `message ${i}`);
  const found = await f.request("/console/api/history/threads?q=needle-only-old-message");
  assert.equal(found.body.threads.length, 1);
  const page = await f.request("/console/api/history/transcript?customerId=history-room&atMs=80&limit=50");
  assert.deepEqual([page.body.rows[0].createdAt, page.body.rows.at(-1).createdAt], [31, 80]);
  assert.equal(page.body.hasOlder, true); assert.equal(page.body.hasNewer, true);
  const older = await f.request(`/console/api/history/transcript?customerId=history-room&limit=50&direction=older&cursor=${page.body.olderCursor}`);
  assert.deepEqual([older.body.rows[0].createdAt, older.body.rows.at(-1).createdAt], [1, 30]);
  const newer = await f.request(`/console/api/history/transcript?customerId=history-room&limit=50&direction=newer&cursor=${page.body.newerCursor}`);
  assert.deepEqual([newer.body.rows[0].createdAt, newer.body.rows.at(-1).createdAt], [81, 120]);
  assert.equal(newer.body.hasNewer, false);
  const latest = await f.request("/console/api/history/transcript?customerId=history-room&limit=50");
  assert.equal(latest.body.hasNewer, false, "latest page never offers a newer empty page");
  const atLatest = await f.request("/console/api/history/transcript?customerId=history-room&atMs=120&limit=50");
  assert.equal(atLatest.body.hasNewer, false);
});

test("thread cursor pages unique rooms after matching-message grouping", async t => {
  const f = fixture(t);
  f.message("room-a", "a1", 10, "matching"); f.message("room-a", "a2", 30, "matching");
  f.message("room-b", "b1", 20, "matching");
  const first = await f.request("/console/api/history/threads?q=matching&limit=1");
  const second = await f.request(`/console/api/history/threads?q=matching&limit=1&cursor=${first.body.nextCursor}`);
  assert.deepEqual([first.body.threads[0].customerId, second.body.threads[0].customerId], ["room-a", "room-b"]);
  assert.equal(second.body.hasMore, false, "older hit from room-a cannot become another thread");
});

test("retained snapshots obey customer/filter/pagination and advertise readonly review", async t => {
  const f = fixture(t);
  for (const id of ["one", "two", "three"]) f.addCase(id);
  f.save();
  for (const id of ["one", "two", "three"]) assert.equal((await f.review(id, { stop: "incorrect", expectedRevision: 0 })).status, 200);
  rmSync(f.file);
  const one = await f.request("/console/api/jev-audits/batch-test/cases?customerId=one&filter=reviewed&limit=1");
  assert.deepEqual(one.body.rows.map(row => row.customerId), ["one"]);
  assert.equal(one.body.rows[0].canReview, false);
  const none = await f.request("/console/api/jev-audits/batch-test/cases?filter=unreviewed");
  assert.equal(none.body.rows.length, 0);
  const first = await f.request("/console/api/jev-audits/batch-test/cases?limit=1");
  const next = await f.request(`/console/api/jev-audits/batch-test/cases?limit=1&cursor=${first.body.nextCursor}`);
  assert.equal(first.body.rows.length, 1); assert.equal(next.body.rows.length, 1);
  assert.notEqual(first.body.rows[0].id, next.body.rows[0].id);
  const otherChannel = await f.request("/console/api/jev-audits/batch-test/threads?channel=other");
  assert.equal(otherChannel.body.threads.length, 0);
});

test("an event with timestamp evidence but no anchor retains its saved review", async t => {
  const f = fixture(t), row = f.addCase("timestamp-only");
  delete row.anchorMessageId; f.save();
  assert.equal((await f.review(row.id, { stop: "correct", expectedRevision: 0 })).status, 200);
  rmSync(f.file);
  const saved = await f.request("/console/api/jev-audits/batch-test/cases");
  assert.equal(saved.body.rows.length, 1); assert.equal(saved.body.rows[0].feedback.stop, "correct");
  f.db.raw.prepare("DELETE FROM messages WHERE customer_id=?").run(row.customerId);
  assert.equal((await f.request("/console/api/jev-audits/batch-test/cases")).status, 404);
});
