// Audited owner-requested catalog refresh. Uses the same cap, permissions and Brain hook as Console.
import { createHash } from "node:crypto";
import { parseReviewDoc, renderReviewDoc, validateReviewDoc } from "./reviewCatalogDoc.mjs";
import { reviewUrlKey } from "./reviewSelection.mjs";
import { catalogOutOfPrompt, knowledgeUsage, KNOWLEDGE_MAX_CHARS, REVIEW_CATALOG_MAX_CHARS } from "./knowledgePack.mjs";
import { hasOperatorCapability } from "./operatorRoles.mjs";

export const catalogHash = value => createHash("sha256").update(String(value)).digest("hex");

export function prepareReviewCatalogUpdate(db, payload) {
  const current = db.getKnowledge(payload.entryId);
  if (!current || !current.active || !String(current.title).includes("รีวิวนักเรียนจริง")) throw new Error("catalog_target_mismatch");
  if (!String(payload.title).includes("รีวิวนักเรียนจริง")) throw new Error("catalog_title_mismatch");
  const errors = validateReviewDoc(payload.doc);
  if (errors.length) throw new Error(`catalog_invalid: ${errors.join("; ")}`);
  const before = parseReviewDoc(current.content);
  const doc = structuredClone(payload.doc);
  const incoming = new Set(doc.sections.flatMap(s => s.items.map(i => reviewUrlKey(i.url))));
  let preserved = 0;
  // A sheet refresh is not permission to delete a manually added review or note.
  for (const section of before.sections) {
    const missing = section.items.filter(i => !incoming.has(reviewUrlKey(i.url)));
    if (!missing.length && !section.extras?.length) continue;
    const name = section.name.replace(/(?: · รายการเดิมที่รักษาไว้)+$/u, "");
    doc.sections.push({ name: `${name} · รายการเดิมที่รักษาไว้`, items: missing, extras: section.extras || [] });
    for (const item of missing) incoming.add(reviewUrlKey(item.url));
    preserved += missing.length;
  }
  const content = renderReviewDoc(doc);
  const contentSha256 = catalogHash(content);
  const unchanged = current.content === content && current.title === payload.title;
  if (!unchanged && catalogHash(current.content) !== payload.expectedContentSha256) throw new Error("catalog_changed_since_review");
  const rows = db.listActiveKnowledge(current.channel_id ?? null);
  // 19 ต.ค. 2026: คลังรีวิวมีงบของตัวเอง (สวิตช์ review_catalog_in_prompt ≠ on) — ตัวนับเดียวกับคอนโซล
  const separateCatalog = catalogOutOfPrompt(db);
  const beforeUsage = knowledgeUsage(rows, { separateCatalog });
  const afterUsage = knowledgeUsage(rows.map(r => r.id === current.id ? { ...r, title: payload.title, content } : r), { separateCatalog });
  if (afterUsage.totalChars > KNOWLEDGE_MAX_CHARS && afterUsage.totalChars > beforeUsage.totalChars) throw new Error("knowledge_capacity_exceeded");
  if (separateCatalog && afterUsage.catalogChars > REVIEW_CATALOG_MAX_CHARS && afterUsage.catalogChars > beforeUsage.catalogChars) throw new Error("review_catalog_capacity_exceeded");
  return { current, content, contentSha256, unchanged, summary: {
    before: before.sections.reduce((n,s) => n + s.items.length, 0),
    after: doc.sections.reduce((n,s) => n + s.items.length, 0), preserved,
    beforeChars: beforeUsage.totalChars, afterChars: afterUsage.totalChars,
    ...(separateCatalog ? { catalogBeforeChars: beforeUsage.catalogChars, catalogAfterChars: afterUsage.catalogChars } : {}),
  } };
}

export function applyReviewCatalogUpdate({ db, hook, operator, payload, actor }) {
  if (!operator || operator.disabled || !hasOperatorCapability(operator, "knowledge.publish")) throw new Error("owner_publish_required");
  if (!actor) throw new Error("audit_actor_required");
  const prepared = prepareReviewCatalogUpdate(db, payload);
  if (prepared.unchanged) return { ok: true, outcome: "unchanged", ...prepared.summary, contentSha256: prepared.contentSha256 };
  const result = hook.apply({
    kind: "review_catalog_edit", operator, username: actor,
    audit: { action: "review_catalog_edit", target: payload.entryId,
      detail: `owner-requested sheet refresh; ${prepared.summary.before} -> ${prepared.summary.after}; preserved ${prepared.summary.preserved}; source ${payload.source}` },
    apply: () => {
      if (catalogHash(db.getKnowledge(payload.entryId)?.content) !== payload.expectedContentSha256) throw new Error("catalog_changed_since_review");
      return db.updateKnowledge(payload.entryId, { title: payload.title, content: prepared.content, updatedBy: actor });
    },
  });
  if (!result.ok) return { ok: false, outcome: result.outcome, error: result.error, versionId: result.versionId };
  const readback = db.getKnowledge(payload.entryId);
  return { ok: true, outcome: result.outcome, versionId: result.versionId, ...prepared.summary,
    contentSha256: prepared.contentSha256,
    applied: catalogHash(readback.content) === prepared.contentSha256 && readback.title === payload.title };
}
