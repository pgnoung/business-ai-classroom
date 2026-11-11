// Owner feedback for retrospective reports. Closed labels feed the optional
// live Jev learning bridge; notes remain local and outside admin_audit.
const LABELS = new Set(["correct", "incorrect", null]);
export function normalizeAuditFeedback(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const stop = input.stop === undefined ? null : input.stop;
  const notify = input.notify === undefined ? null : input.notify;
  const note = input.note === undefined ? "" : input.note;
  const revision = input.expectedRevision;
  if (!LABELS.has(stop) || !LABELS.has(notify) || typeof note !== "string" || note.length > 1000 || !Number.isSafeInteger(revision) || revision < 0 || (!stop && !notify)) return null;
  return { stop, notify, note: note.trim(), expectedRevision: revision };
}
export function readAuditFeedback(db, batchId, caseIds) {
  if (!caseIds.length) return new Map();
  const rows = [];
  for (let index = 0; index < caseIds.length; index += 500) {
    const ids = caseIds.slice(index, index + 500);
    rows.push(...db.raw.prepare(`SELECT batch_id,case_id,evidence_hash,stop_label,notify_label,note,reviewer,reviewed_at,revision FROM jev_audit_feedback WHERE batch_id=? AND case_id IN (${ids.map(() => "?").join(",")})`).all(batchId, ...ids));
  }
  return new Map(rows.map(row => [`${row.case_id}:${row.evidence_hash}`, row]));
}
export function writeAuditFeedback({ db, batchId, caseRow, reviewer, input, now = Date.now }) {
  const value = normalizeAuditFeedback(input); if (!value) return { ok: false, code: "invalid_feedback" };
  const existing = db.raw.prepare("SELECT revision FROM jev_audit_feedback WHERE batch_id=? AND case_id=? AND evidence_hash=?").get(batchId, caseRow.id, caseRow.evidenceHash);
  const expected = value.expectedRevision;
  if ((existing?.revision || 0) !== expected) return { ok: false, code: "review_conflict", currentRevision: existing?.revision || 0 };
  const revision = expected + 1;
  const comparison = { stop: String(caseRow.comparison?.stop || "unknown"), notify: String(caseRow.comparison?.notify || "unknown") };
  const kinds = Array.isArray(caseRow.eventKinds) ? caseRow.eventKinds.map(value => String(value).slice(0, 100)).slice(0, 40) : [];
  db.raw.prepare(`INSERT INTO jev_audit_feedback (batch_id,case_id,evidence_hash,customer_id,stop_label,notify_label,note,reviewer,reviewed_at,revision,event_at,model,channel_id,anchor_message_id,stop_choice,notify_choice,original_stop,original_notify,stop_confidence_10,notify_confidence_10,complaint_choice,complaint_confidence_10,reason_choice,comparison_json,event_kinds_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,case_id,evidence_hash) DO UPDATE SET stop_label=excluded.stop_label,notify_label=excluded.notify_label,note=excluded.note,reviewer=excluded.reviewer,reviewed_at=excluded.reviewed_at,revision=excluded.revision WHERE jev_audit_feedback.revision=?`).run(batchId, caseRow.id, caseRow.evidenceHash, caseRow.customerId, value.stop, value.notify, value.note, reviewer, now(), revision, Number(caseRow.atMs) || 0, String(caseRow.jev?.model || "").slice(0, 100), String(caseRow.channelId || "default").slice(0, 100), String(caseRow.anchorMessageId || "").slice(0, 300), String(caseRow.jev?.stop?.choice || "").slice(0, 30), String(caseRow.jev?.notify?.choice || "").slice(0, 30), String(caseRow.original?.stop || "unknown").slice(0, 30), String(caseRow.original?.notify || "unknown").slice(0, 30), Number.isFinite(caseRow.jev?.stop?.confidence10) ? caseRow.jev.stop.confidence10 : null, Number.isFinite(caseRow.jev?.notify?.confidence10) ? caseRow.jev.notify.confidence10 : null, String(caseRow.jev?.complaint?.choice || "").slice(0, 30), Number.isFinite(caseRow.jev?.complaint?.confidence10) ? caseRow.jev.complaint.confidence10 : null, String(caseRow.jev?.reason?.choice || "").slice(0, 100), JSON.stringify(comparison), JSON.stringify(kinds), expected);
  const row = db.raw.prepare("SELECT stop_label,notify_label,note,reviewer,reviewed_at,revision FROM jev_audit_feedback WHERE batch_id=? AND case_id=? AND evidence_hash=?").get(batchId, caseRow.id, caseRow.evidenceHash);
  return row?.revision === revision ? { ok: true, row } : { ok: false, code: "review_conflict", currentRevision: row?.revision || 0 };
}
