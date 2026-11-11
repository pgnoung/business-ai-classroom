// Durable, privacy-minimal observation of an inbound image classification.
// This module has no routing authority: callers must keep their existing image
// behavior regardless of whether recording succeeds.

const KIND = new Set(["slip", "document", "other"]);
const DIAGNOSTIC = new Set([
  "disabled", "no_file", "read_error", "no_bytes", "too_large", "bad_mime",
  "no_model", "model_error", "unparsable", "invalid_response", "unavailable",
]);

export function normalizeInboundImageOutcome({ verdict = null, classifierEnabled = true } = {}) {
  const kind = KIND.has(String(verdict?.kind || "")) ? String(verdict.kind) : "unknown";
  const code = DIAGNOSTIC.has(String(verdict?.reasonCode || ""))
    ? String(verdict.reasonCode)
    : (kind === "unknown" ? "invalid_response" : "valid");
  const classificationState = code === "disabled" || classifierEnabled === false
    ? "classifier_disabled"
    : (["no_file", "read_error", "unavailable"].includes(code)
      ? "download_unavailable"
      : (code === "valid" ? "classified" : "classifier_error"));
  return Object.freeze({
    classificationState,
    classifiedKind: kind,
    diagnosticCode: classifierEnabled === false ? "disabled" : code,
    // This says what the current image branch selected, never that a reply was sent.
    // The existing pipeline branches on `kind` alone. Preserve that observed
    // branch even if a malformed classifier return also carries an error code.
    action: kind === "other" ? "text_pipeline" : "human_review",
  });
}

export function createInboundImageOutcome({ db, logger = console } = {}) {
  return Object.freeze({
    record({ customerId = "", messageId = "", providerMessageId = "", verdict = null, classifierEnabled = true } = {}) {
      if (!db?.recordInboundImageClassification) return null;
      const normalized = normalizeInboundImageOutcome({ verdict, classifierEnabled });
      try {
        return db.recordInboundImageClassification({
          customerId, messageId, providerMessageId, ...normalized,
        });
      } catch {
        // Instrumentation is observational. It must not alter customer routing.
        logger.warn?.("inboundImageOutcome: record skipped");
        return null;
      }
    },
  });
}
