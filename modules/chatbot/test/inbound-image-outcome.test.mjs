import test from "node:test";
import assert from "node:assert/strict";
import { openDb, normalizeCorrectionSourceReason } from "../src/db.mjs";
import { createInboundImageOutcome, normalizeInboundImageOutcome } from "../src/inboundImageOutcome.mjs";
import { messageEvidenceChips } from "../public/console/chat.mjs";

function seeded(db, { customerId = "U-image", messageId = "in:image-1", providerMessageId = "provider-image-1" } = {}) {
  db.upsertCustomer(customerId, {});
  db.insertMessage({ id: messageId, customerId, direction: "in", msgType: "image" });
  db.addMessageAttachment({ messageId, customerId, direction: "in", kind: "image", providerMessageId });
  return { customerId, messageId, providerMessageId };
}

test("image outcome normalizes only fixed outcomes and keeps route intent distinct from a send", () => {
  assert.deepEqual(normalizeInboundImageOutcome({ verdict: { kind: "other" } }), {
    classificationState: "classified", classifiedKind: "other", diagnosticCode: "valid", action: "text_pipeline",
  });
  assert.equal(normalizeInboundImageOutcome({ verdict: { kind: "unknown", reasonCode: "no_file" } }).classificationState, "download_unavailable");
  assert.equal(normalizeInboundImageOutcome({ verdict: { kind: "unknown", reasonCode: "model_error" } }).classificationState, "classifier_error");
  assert.equal(normalizeInboundImageOutcome({ classifierEnabled: false }).diagnosticCode, "disabled");
  const contradictory = normalizeInboundImageOutcome({ verdict: { kind: "other", reasonCode: "model_error" } });
  assert.equal(contradictory.action, "text_pipeline", "evidence must describe the unchanged kind-based pipeline branch");
});

test("image outcome is idempotent and rejects cross-customer/provider or non-image links", (t) => {
  const db = openDb(); t.after(() => db.close());
  const first = seeded(db, {});
  const outcome = createInboundImageOutcome({ db, logger: { warn() {} } });
  const recorded = outcome.record({ ...first, verdict: { kind: "other" } });
  assert.equal(recorded.action, "text_pipeline");
  assert.equal(outcome.record({ ...first, verdict: { kind: "slip" } }).classified_kind, "slip");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM inbound_image_classifications").get().n, 1);
  assert.equal(outcome.record({ ...first, customerId: "U-other", verdict: { kind: "other" } }), null);
  assert.equal(outcome.record({ ...first, providerMessageId: "provider-other", verdict: { kind: "other" } }), null);
  const missing = "in:no-attachment";
  db.insertMessage({ id: missing, customerId: first.customerId, direction: "in", msgType: "image" });
  const fallback = outcome.record({ customerId: first.customerId, messageId: missing, providerMessageId: "untrusted-provider", verdict: { kind: "unknown", reasonCode: "no_file" } });
  assert.equal(fallback.diagnostic_code, "no_file");
  assert.equal(db.raw.prepare("SELECT provider_message_id FROM inbound_image_classifications WHERE message_id=?").get(missing).provider_message_id, "");
});

test("image evidence is removed for withdrawal and customer reset", (t) => {
  const db = openDb(); t.after(() => db.close());
  const item = seeded(db, {});
  createInboundImageOutcome({ db }).record({ ...item, verdict: { kind: "other" } });
  db.queueProviderMessageMediaDeletion(item.providerMessageId, "line_unsend");
  assert.equal(db.getInboundImageClassification({ customerId: item.customerId, messageId: item.messageId }), null);
  assert.equal(createInboundImageOutcome({ db }).record({ ...item, verdict: { kind: "other" } }), null, "late classifier result must not recreate withdrawn evidence");
  const resetItem = seeded(db, { customerId: "U-image-reset", messageId: "in:image-reset", providerMessageId: "provider-image-reset" });
  createInboundImageOutcome({ db }).record({ ...resetItem, verdict: { kind: "other" } });
  db.resetCustomer(resetItem.customerId);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM inbound_image_classifications").get().n, 0);
});

test("correction provenance is closed and inbound evidence is customer scoped across rotation", (t) => {
  const db = openDb(); t.after(() => db.close());
  const item = seeded(db, {});
  const correctionId = db.addCorrection({ customerId: item.customerId, aiDraft: "a", sourceReason: "system:compliance_block:banned_word,price", inboundMessageId: item.messageId });
  assert.equal(db.getCorrectionInboundMessage({ customerId: item.customerId, correctionId }).id, item.messageId);
  assert.equal(normalizeCorrectionSourceReason("system:compliance_block:banned_word,price"), "system:compliance_block:banned_word,price");
  assert.throws(() => normalizeCorrectionSourceReason("system:compliance_block:secret"));
  assert.throws(() => db.addCorrection({ customerId: "U-other", inboundMessageId: item.messageId }));
});

test("chat chip exposes fixed observation and planned route without claiming delivery", () => {
  const chips = messageEvidenceChips({ direction: "in", imageClassification: { classification_state: "classified", classified_kind: "other", diagnostic_code: "valid", action: "text_pipeline" } });
  assert.match(chips[0].title, /ข้อมูลที่สังเกตได้/u);
  assert.match(chips[0].title, /ไม่ใช่สถานะส่งหรือตอบแล้ว/u);
  const noFile = messageEvidenceChips({ direction: "in", imageClassification: { classification_state: "download_unavailable", classified_kind: "unknown", diagnostic_code: "no_file", action: "human_review" } });
  assert.equal(noFile[0].label, "👁 ไม่พบไฟล์รูปให้ตรวจ");
  const failedOther = messageEvidenceChips({ direction: "in", imageClassification: { classification_state: "classifier_error", classified_kind: "other", diagnostic_code: "model_error", action: "text_pipeline" } });
  assert.match(failedOther[0].label, /ตรวจรูปไม่สำเร็จ/u);
  assert.match(failedOther[0].title, /ประมวลผลข้อความ/u);
});
