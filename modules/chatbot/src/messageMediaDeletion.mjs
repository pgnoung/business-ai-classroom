// Durable private-media erasure. DB mutations enqueue first; this worker may be
// retried safely after a crash or transient filesystem error. Do not log storage
// keys: they are opaque capabilities into a private customer-data directory.
export function drainMessageMediaDeletionQueue({ db, privateMedia, customerId = null, limit = 100, logger = console, policy = "delete" } = {}) {
  if (!db) return { attempted: 0, deleted: 0, missing: 0, failed: 0, pending: 0, retained: 0, skipped: true };
  // คำสั่งพี่ง้วง 2026-08-25: โหมด retain_reference = ตั้งใจเก็บไบต์ไว้เป็นข้อมูลอ้างอิง
  // ล้างเฉพาะ "คิวสั่งลบ" ออกพร้อมบันทึกว่าเก็บไว้โดยนโยบาย — เพื่อไม่ให้ค้างเป็น
  // "ลบไม่สำเร็จ" ตลอดไป และตอบคำถามย้อนหลังได้ว่าไฟล์ยังอยู่เพราะอะไร
  if (String(policy) === "retain_reference") {
    const rows = db.listMessageMediaDeletionQueue(limit, customerId);
    for (const row of rows) db.completeMessageMediaDeletion(row.storage_key);
    if (rows.length) {
      try {
        db.addAudit({
          operator: "system", action: "erased_media_retained",
          detail: `นโยบายเจ้าของ: เก็บไบต์ไว้เป็นข้อมูลอ้างอิง ${rows.length} รายการ (แถวในฐานข้อมูลถูกลบแล้ว)`,
        });
      } catch { /* audit ล้มห้ามทำให้เส้นลบล้ม */ }
      logger.info?.(`message media: เก็บไบต์ตามนโยบายเจ้าของ ${rows.length} รายการ (ไม่ลบไฟล์)`);
    }
    return {
      attempted: rows.length, deleted: 0, missing: 0, failed: 0,
      pending: db.listMessageMediaDeletionQueue(limit, customerId).length,
      retained: rows.length, skipped: false, policy: "retain_reference",
    };
  }
  if (!privateMedia?.enabled?.()) {
    const pending = db.listMessageMediaDeletionQueue(limit, customerId).length;
    return { attempted: 0, deleted: 0, missing: 0, failed: 0, pending, retained: 0, skipped: true };
  }
  const rows = db.listMessageMediaDeletionQueue(limit, customerId);
  const result = { attempted: 0, deleted: 0, missing: 0, failed: 0, pending: 0, retained: 0, skipped: false };
  for (const row of rows) {
    result.attempted += 1;
    try {
      const removed = privateMedia.remove(row.storage_key);
      db.completeMessageMediaDeletion(row.storage_key);
      if (removed) result.deleted += 1;
      else result.missing += 1; // ENOENT means an earlier attempt already erased it.
    } catch (error) {
      result.failed += 1;
      db.failMessageMediaDeletion(row.storage_key, error?.code || error?.message || "private_media_delete_failed");
      logger.warn?.("message media deletion deferred; will retry");
    }
  }
  result.pending = db.listMessageMediaDeletionQueue(limit, customerId).length;
  return result;
}

export async function reconcileMessageMediaOrphans({ db, privateMedia, beforeMs, logger = console } = {}) {
  if (!db || !privateMedia?.enabled?.() || typeof privateMedia.listStoredKeysOlderThan !== "function") {
    return { scanned: 0, queued: 0, skipped: true };
  }
  try {
    const candidates = await privateMedia.listStoredKeysOlderThan(Number(beforeMs));
    const queued = db.queueUnreferencedMessageMediaDeletions(candidates, "orphan_reconcile");
    return { scanned: candidates.length, queued, skipped: false };
  } catch (error) {
    logger.warn?.(`message media orphan reconciliation deferred (${error?.code || error?.message || "failed"})`);
    return { scanned: 0, queued: 0, skipped: true };
  }
}
