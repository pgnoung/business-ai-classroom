export const BACKUP_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const BACKUP_RETENTION_POLICY = Object.freeze({ daily: 14, weekly: 8, monthly: 12, yearly: 3 });

function timestamp(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function backupStatusFromDb(db, { now = Date.now(), maxAgeMs = BACKUP_MAX_AGE_MS } = {}) {
  const lastSuccessAt = timestamp(db.getSetting("backup_last_success_at"));
  const lastRestoreDrillAt = timestamp(db.getSetting("backup_last_restore_drill_at"));
  const ageMs = lastSuccessAt === null ? null : Math.max(0, Number(now) - lastSuccessAt);
  return {
    status: lastSuccessAt === null ? "missing" : ageMs > maxAgeMs ? "stale" : "ok",
    lastSuccessAt,
    ageMs,
    maxAgeMs,
    lastRestoreDrillAt,
    encrypted: true,
    retention: BACKUP_RETENTION_POLICY,
    scheduler: "external_unverified",
  };
}
