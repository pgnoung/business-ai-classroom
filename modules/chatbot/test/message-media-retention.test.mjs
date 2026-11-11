import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.mjs";
import { createConfig } from "../src/config.mjs";
import { createPrivateMediaStore } from "../src/messageMedia.mjs";
import { drainMessageMediaDeletionQueue, reconcileMessageMediaOrphans } from "../src/messageMediaDeletion.mjs";
import { createRetention } from "../src/retention.mjs";

const DAY_MS = 86_400_000;
// เวลาอ้างอิงคงที่ของไฟล์นี้ — ทุกเทสต์ฉีดนาฬิกาตัวนี้ให้ db แล้วเดินเอง
// (เดิมอายุ token คิดจากเวลาเครื่องจริง ขณะที่ db/retention เดินบนนาฬิกาที่ตรึงไว้
//  = สองนาฬิกา แล้วเทสต์จะพลิกผลเองเมื่อวันจริงเดินผ่านวันที่ตรึงไว้)
const T0 = Date.UTC(2026, 7, 10);
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function storeFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-retention-media-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createPrivateMediaStore({ dir, minFreeBytes: 0 });
}

function seedExpiredArchivedMedia({ db, store, customerId = "U-retention", nowMs }) {
  db.upsertCustomer(customerId, {});
  const messageId = db.insertMessage({ customerId, direction: "in", content: "attachment" });
  const saved = store.save({ buffer: Buffer.from("%PDF-1.4\nretention"), name: "private.pdf", origin: "operator" });
  const attachmentId = db.addMessageAttachment({
    messageId, customerId, direction: "in", kind: "file", status: "ready", source: "line",
    originalName: "private.pdf", mime: saved.mime, byteSize: saved.byteSize, sha256: saved.sha256, storageKey: saved.storageKey,
  });
  db.createAttachmentDownloadToken({ tokenHash: `hash-${customerId}`, attachmentId, expiresAt: nowMs + DAY_MS });
  const rotated = db.rotateTrainingSession({ customerId, resetEventId: `reset-${customerId}` });
  return { attachmentId, messageId, storageKey: saved.storageKey, sessionId: rotated.candidate.session_id };
}

test("training retention expires review artifacts but preserves permanent chat media", (t) => {
  let clock = T0;
  const db = openDb({ file: ":memory:", now: () => clock });
  t.after(() => db.close());
  const store = storeFor(t);
  const seeded = seedExpiredArchivedMedia({ db, store, nowMs: clock });
  assert.doesNotThrow(() => store.open(seeded.storageKey).close());
  clock += 31 * DAY_MS;

  const retention = createRetention({
    config: createConfig({ RETENTION_TRAINING_CANDIDATE_DAYS: "30" }), db, now: () => clock, logger: silent,
    mediaDeletion: () => drainMessageMediaDeletionQueue({ db, privateMedia: store, logger: silent }),
  });
  const result = retention.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.pruned.trainingCandidate, 1);
  assert.equal(result.pruned.messageAttachments, 0, "training expiry must not delete permanent attachments");
  assert.equal(result.pruned.attachmentDownloadTokens, 1, "the independently expired download grant is revoked");
  assert.equal(result.pruned.queuedMediaDeletes, 0, "training expiry must not queue permanent bytes for deletion");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE id=?").get(seeded.messageId).n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_sessions WHERE id=?").get(seeded.sessionId).n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM message_attachments WHERE id=?").get(seeded.attachmentId).n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM attachment_download_tokens").get().n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM message_media_deletion_queue").get().n, 0);
  assert.equal(result.mediaDeletion.deleted, 0);
  assert.doesNotThrow(() => store.open(seeded.storageKey).close(), "physical customer media remains readable");
});

test("durable deletion queue keeps failed erasure for retry without exposing storage key", (t) => {
  const db = openDb({ file: ":memory:", now: () => T0 });
  t.after(() => db.close());
  const store = storeFor(t);
  const seeded = seedExpiredArchivedMedia({ db, store, customerId: "U-retry", nowMs: T0 });
  db.queueCustomerMediaDeletion("U-retry", "test");
  const disabled = drainMessageMediaDeletionQueue({ db, privateMedia: { enabled: () => false }, logger: silent });
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.pending, 1, "disabled storage must still report durable work waiting");
  const warning = [];
  const brokenStore = { enabled: () => true, remove: () => { throw Object.assign(new Error("disk unavailable"), { code: "EIO" }); } };
  const first = drainMessageMediaDeletionQueue({ db, privateMedia: brokenStore, logger: { warn: (line) => warning.push(line) } });
  assert.equal(first.failed, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM message_media_deletion_queue").get().n, 1);
  assert.equal(db.raw.prepare("SELECT attempts FROM message_media_deletion_queue").get().attempts, 1);
  assert.equal(warning.join(" ").includes(seeded.storageKey), false, "logs must never expose private storage key");
  const second = drainMessageMediaDeletionQueue({ db, privateMedia: store, logger: silent });
  assert.equal(second.deleted, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM message_media_deletion_queue").get().n, 0);
  assert.throws(() => store.open(seeded.storageKey), /ENOENT/);
});

test("crash-orphaned private bytes are reconciled into the durable deletion queue", async (t) => {
  // นาฬิกาเดียวของเทสต์นี้คือนาฬิกาไฟล์จริง: ตัวกวาดอ่าน mtime ของไฟล์บนดิสก์
  // ห้ามฉีดนาฬิกาสมมติเข้ามาปน ไม่งั้นไฟล์ที่เพิ่งเขียนจะไม่มีวันเก่าพอให้ถูกกวาด
  const db = openDb({ file: ":memory:" });
  t.after(() => db.close());
  const store = storeFor(t);
  const saved = await store.saveAsync({ buffer: Buffer.from("%PDF-1.4\ncrash-orphan"), name: "orphan.pdf", origin: "operator" });
  const result = await reconcileMessageMediaOrphans({ db, privateMedia: store, beforeMs: Date.now() + 1_000, logger: silent });
  assert.equal(result.queued, 1);
  assert.equal(db.listMessageMediaDeletionQueue().length, 1);
  assert.equal(drainMessageMediaDeletionQueue({ db, privateMedia: store, logger: silent }).deleted, 1);
  assert.throws(() => store.open(saved.storageKey), /ENOENT/);
});

test("PDPA reset refuses orphanable bytes and succeeds only after durable deletion drains", (t) => {
  const db = openDb({ file: ":memory:", now: () => T0 });
  t.after(() => db.close());
  const store = storeFor(t);
  const customerId = "U-pdpa-media";
  db.upsertCustomer(customerId, {});
  const messageId = db.insertMessage({ customerId, direction: "in", content: "private attachment" });
  const saved = store.save({ buffer: Buffer.from("%PDF-1.4\npdpa"), name: "erase.pdf", origin: "operator" });
  const attachmentId = db.addMessageAttachment({
    messageId, customerId, direction: "in", source: "line", kind: "file", status: "ready",
    originalName: saved.originalName, mime: saved.mime, byteSize: saved.byteSize, storageKey: saved.storageKey,
  });
  db.createAttachmentDownloadToken({ tokenHash: "pdpa-token-hash", attachmentId, expiresAt: T0 + DAY_MS });
  assert.throws(() => db.resetCustomer(customerId), /media deletion is incomplete/u, "direct DB reset must fail before bytes are durably queued");
  db.queueCustomerMediaDeletion(customerId, "customer_reset");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM attachment_download_tokens").get().n, 0);
  const drained = drainMessageMediaDeletionQueue({ db, privateMedia: store, customerId, logger: silent });
  assert.equal(drained.deleted, 1);
  assert.doesNotThrow(() => db.resetCustomer(customerId));
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM message_attachments WHERE customer_id=?").get(customerId).n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id=?").get(customerId).n, 0);
  assert.throws(() => store.open(saved.storageKey), /ENOENT/);
});

test("retention removes an abandoned operator upload after its bounded staging window", (t) => {
  let clock = T0;
  const db = openDb({ file: ":memory:", now: () => clock });
  t.after(() => db.close());
  const store = storeFor(t);
  db.upsertCustomer("U-orphan-upload", {});
  const saved = store.save({ buffer: Buffer.from("%PDF-1.4\norphan"), name: "unused.pdf", origin: "operator" });
  const attachmentId = db.addMessageAttachment({
    customerId: "U-orphan-upload", direction: "out", source: "operator_upload", kind: "file", status: "ready",
    originalName: saved.originalName, mime: saved.mime, byteSize: saved.byteSize, storageKey: saved.storageKey, createdBy: "admin",
  });
  db.createAttachmentDownloadToken({ tokenHash: "orphan-token-hash", attachmentId, expiresAt: clock + DAY_MS });
  clock += DAY_MS + 1;
  const retention = createRetention({
    config: createConfig({ RETENTION_MESSAGE_MEDIA_ORPHAN_DAYS: "1" }), db, now: () => clock, logger: silent,
    mediaDeletion: () => drainMessageMediaDeletionQueue({ db, privateMedia: store, logger: silent }),
  });
  const result = retention.runOnce();
  assert.equal(result.pruned.orphanMessageAttachments, 1);
  assert.equal(result.pruned.attachmentDownloadTokens, 1);
  assert.equal(result.mediaDeletion.deleted, 1);
  assert.equal(db.getMessageAttachment(attachmentId), undefined);
  assert.throws(() => store.open(saved.storageKey), /ENOENT/);
});

// คำสั่งพี่ง้วง 2026-08-25: ไบต์สื่อของลูกค้าที่สั่ง "ลืมข้อมูล" ให้เก็บไว้เป็นข้อมูลอ้างอิง
// สิ่งที่ต้องจริงพร้อมกัน: ไฟล์ไม่ถูกลบ · คิวไม่ค้างเป็น "ลบไม่สำเร็จ" ตลอดไป ·
// มี audit ให้ตอบย้อนหลังได้ว่าเก็บไว้เพราะนโยบาย ไม่ใช่เพราะระบบพัง
test("นโยบาย retain_reference: เก็บไบต์ไว้ ล้างคิว และเขียน audit ให้ตรวจสอบได้", () => {
  const db = openDb({ file: ":memory:", now: () => T0 });
  const removed = [];
  const privateMedia = { enabled: () => true, remove: (key) => { removed.push(key); return true; } };
  db.upsertCustomer("U-retain", { displayName: "อ้างอิง" });
  db.queueUnreferencedMessageMediaDeletions(["11111111-1111-1111-1111-111111111111.jpg"], "pdpa_forget");

  const result = drainMessageMediaDeletionQueue({ db, privateMedia, policy: "retain_reference", logger: { info() {}, warn() {}, error() {}, debug() {} } });
  assert.equal(result.policy, "retain_reference");
  assert.equal(result.retained, 1, "ต้องนับว่าเก็บไว้ 1 รายการ");
  assert.equal(result.deleted, 0);
  assert.deepEqual(removed, [], "ห้ามลบไฟล์ในโหมดเก็บอ้างอิง");
  assert.equal(result.pending, 0, "คิวต้องไม่ค้างเป็น 'ลบไม่สำเร็จ' ตลอดไป");
  assert.ok(
    db.listAudit().some((row) => row.action === "erased_media_retained"),
    "ต้องมีร่องรอยว่าเก็บไว้เพราะนโยบาย",
  );
  db.close();
});

test("นโยบาย delete: ยังลบไบต์จริงเหมือนเดิมทุกประการ", () => {
  const db = openDb({ file: ":memory:", now: () => T0 });
  const removed = [];
  const privateMedia = { enabled: () => true, remove: (key) => { removed.push(key); return true; } };
  db.upsertCustomer("U-delete", { displayName: "ลบจริง" });
  db.queueUnreferencedMessageMediaDeletions(["22222222-2222-2222-2222-222222222222.jpg"], "pdpa_forget");

  const result = drainMessageMediaDeletionQueue({ db, privateMedia, policy: "delete", logger: { info() {}, warn() {}, error() {}, debug() {} } });
  assert.equal(result.deleted, 1);
  assert.equal(result.retained, 0);
  assert.equal(removed.length, 1, "โหมดลบต้องลบไฟล์จริง");
  db.close();
});
