import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";

function queued(db, n, at = 1) {
  db.upsertCustomer("u");
  for (let i = 0; i < n; i += 1) db.addMessageAttachment({ id: `a-${i}`, customerId: "u", direction: "in", source: "legacy_import", kind: "image", status: "queued", providerMessageId: `m${i}`, providerMeta: { contentProvider: "line" } });
  // DB now() in this test is fixed, so all are due at at=1.
}

test("media scheduler DB lease drains batches above 25 without overlap", (ctx) => {
  let t = 1; const db = openDb({ now: () => t }); queued(db, 30);
  ctx.after(() => db.close());
  const one = db.claimDueMessageAttachments({ limit: 2, nowAt: t });
  const concurrent = db.claimDueMessageAttachments({ limit: 2, nowAt: t });
  assert.equal(one.length, 2); assert.equal(concurrent.length, 2);
  // Claimed rows are leased; a same scheduler tick cannot reclaim them.
  const ids = new Set([...one, ...concurrent].map((x) => x.id)); assert.equal(ids.size, 4);
  let total = 4;
  while (true) { const rows = db.claimDueMessageAttachments({ limit: 2, nowAt: t }); if (!rows.length) break; total += rows.length; }
  assert.equal(total, 30);
});

test("lease is restart-safe, and due time makes it claimable again", (ctx) => {
  let t = 1; const db = openDb({ now: () => t }); queued(db, 1);
  ctx.after(() => db.close());
  assert.equal(db.claimDueMessageAttachments({ nowAt: t }).length, 1);
  assert.equal(db.claimDueMessageAttachments({ nowAt: t }).length, 0);
  t += 60_001;
  assert.equal(db.claimDueMessageAttachments({ nowAt: t }).length, 1);
});

test("transient retry schedule and permanent failure state are explicit", (ctx) => {
  let t = 1; const db = openDb({ now: () => t }); queued(db, 1);
  ctx.after(() => db.close());
  const row = db.claimDueMessageAttachments({ nowAt: t })[0];
  db.rescheduleMessageAttachment(row.id, { nextAttemptAt: 100, reason: "202" });
  assert.equal(db.claimDueMessageAttachments({ nowAt: 99 }).length, 0);
  assert.equal(db.claimDueMessageAttachments({ nowAt: 100 }).length, 1);
  db.updateMessageAttachment(row.id, { status: "failed", unavailableReason: "404" });
  assert.equal(db.claimDueMessageAttachments({ nowAt: 999999 }).length, 0);
});

test("operator upload reservations enforce concurrency and byte quota atomically", () => {
  let t = 1_000;
  const db = openDb({ now: () => t });
  const limits = {
    sinceAt: 0,
    expiresAt: t + 120_000,
    hourlyCountLimit: 10,
    hourlyBytesLimit: 100,
    totalCountLimit: 10,
    totalBytesLimit: 100,
    maxConcurrent: 1,
    maxConcurrentPerOperator: 1,
  };
  const first = db.reserveMessageMediaUpload({ operator: "admin", byteSize: 60, ...limits });
  assert.equal(first.ok, true);
  const concurrent = db.reserveMessageMediaUpload({ operator: "admin", byteSize: 10, ...limits });
  assert.deepEqual(concurrent, { ok: false, reason: "concurrent" });
  assert.equal(db.releaseMessageMediaUploadReservation(first.id), true);
  const afterRelease = db.reserveMessageMediaUpload({ operator: "admin", byteSize: 60, ...limits });
  assert.equal(afterRelease.ok, true);
  db.releaseMessageMediaUploadReservation(afterRelease.id);
  db.upsertCustomer("u");
  db.addMessageAttachment({ customerId: "u", direction: "out", source: "operator_upload", kind: "file", status: "ready", byteSize: 70, storageKey: "opaque-key", createdBy: "admin" });
  const overGlobal = db.reserveMessageMediaUpload({ operator: "other", byteSize: 40, ...limits });
  assert.deepEqual(overGlobal, { ok: false, reason: "global_quota" });
  db.close();
});

test("outbound attachment send claims prevent two concurrent replies from minting duplicate links", () => {
  let t = 5_000;
  const db = openDb({ now: () => t });
  db.upsertCustomer("u");
  const attachmentId = db.addMessageAttachment({ customerId: "u", direction: "out", source: "operator_upload", kind: "file", status: "ready", storageKey: "opaque-key" });
  const first = db.claimMessageAttachmentsForSend({ attachmentIds: [attachmentId], customerId: "u", expiresAt: t + 60_000 });
  assert.equal(first.ok, true);
  const racing = db.claimMessageAttachmentsForSend({ attachmentIds: [attachmentId], customerId: "u", expiresAt: t + 60_000 });
  assert.equal(racing.ok, false);
  assert.equal(db.releaseMessageAttachmentsSendClaim(first.claimId), 1);
  const retried = db.claimMessageAttachmentsForSend({ attachmentIds: [attachmentId], customerId: "u", expiresAt: t + 60_000 });
  assert.equal(retried.ok, true);
  t += 60_001;
  const expiredClaimCanBeReplaced = db.claimMessageAttachmentsForSend({ attachmentIds: [attachmentId], customerId: "u", expiresAt: t + 60_000 });
  assert.equal(expiredClaimCanBeReplaced.ok, true);
  db.close();
});

test("crashed final lease becomes terminal failure after lease expiry", (ctx) => {
  let t = 1; const db = openDb({ now: () => t }); queued(db, 1);
  ctx.after(() => db.close());
  const row = db.getMessageAttachment("a-0");
  // Simulate process death after claiming attempt six: no worker writes result.
  for (let i = 0; i < 6; i += 1) {
    db.rescheduleMessageAttachment(row.id, { nextAttemptAt: t, reason: "retry" });
    db.claimDueMessageAttachments({ nowAt: t, maxAttempts: 6 });
    t += 60_001;
  }
  assert.equal(db.claimDueMessageAttachments({ nowAt: t, maxAttempts: 6 }).length, 0);
  assert.equal(db.getMessageAttachment(row.id).status, "failed");
});
