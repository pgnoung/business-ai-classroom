// เมทาดาทาของ fact ใช้เลือกความรู้ตอนตอบเท่านั้น: ไม่รับข้อความลูกค้าหรือ scope ที่ผู้ใช้ส่งมา
import { sha256, stableJson } from "./text.mjs";
const MAX_LABEL = 64;
const MAX_KEYWORDS = 20;
const MAX_PHRASE = 80;

function invalid() {
  throw new Error("รูปแบบเมทาดาทาความรู้ไม่ถูกต้อง");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function label(value) {
  if (typeof value !== "string") invalid();
  const normalized = value.normalize("NFKC").trim();
  if ([...normalized].length > MAX_LABEL || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) invalid();
  return normalized;
}

function phrase(value) {
  if (typeof value !== "string") invalid();
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || [...normalized].length > MAX_PHRASE || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) invalid();
  return normalized;
}

/** Validate and normalize the closed metadata shape persisted in provenance_json.knowledge. */
export function normalizeKnowledgeMetadata(value) {
  if (!plainObject(value)) invalid();
  const allowed = new Set(["mode", "domain", "offering", "keywords"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
  if (value.mode !== "pin" && value.mode !== "retrieve") invalid();
  if (!Object.hasOwn(value, "domain") || !Object.hasOwn(value, "offering") || !Object.hasOwn(value, "keywords")) invalid();
  if (!Array.isArray(value.keywords) || value.keywords.length > MAX_KEYWORDS) invalid();

  const keywords = [];
  const seen = new Set();
  for (const raw of value.keywords) {
    const item = phrase(raw);
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      keywords.push(item);
    }
  }
  if (value.mode === "retrieve" && !keywords.length) invalid();
  return Object.freeze({ mode: value.mode, domain: label(value.domain), offering: label(value.offering), keywords: Object.freeze(keywords) });
}

function metadataFromProvenance(provenance) {
  if (!plainObject(provenance) || !Object.hasOwn(provenance, "knowledge")) return null;
  try { return normalizeKnowledgeMetadata(provenance.knowledge); } catch { return null; }
}

/** Read optional metadata from a legacy knowledge_entries row; malformed configured values fail closed. */
export function knowledgeMetadataFromRow(row) {
  let provenance;
  try { provenance = JSON.parse(String(row?.provenance_json ?? "{}")); } catch { return null; }
  return metadataFromProvenance(provenance);
}

/** Read optional metadata carried by a compiled fact card. */
export function knowledgeMetadataFromCard(card) {
  return metadataFromProvenance(card?.body?.provenance);
}

export function hasKnowledgeMetadata(value) {
  return plainObject(value) && Object.hasOwn(value, "knowledge");
}

/** Preserve unrelated provenance namespaces while replacing the closed knowledge metadata. */
export function mergeKnowledgeMetadata(provenance, metadata) {
  const base = plainObject(provenance) ? provenance : {};
  return { ...base, knowledge: normalizeKnowledgeMetadata(metadata) };
}

/** Stable optimistic-concurrency token for the knowledge fields a queued edit can replace. */
export function knowledgeExpectedHash(row) {
  let provenance;
  try { provenance = JSON.parse(String(row?.provenance_json ?? "{}")); } catch { provenance = String(row?.provenance_json ?? ""); }
  return sha256(stableJson({
    title: String(row?.title ?? ""), content: String(row?.content ?? ""), active: Number(row?.active ?? 0),
    channel_id: row?.channel_id == null ? null : String(row.channel_id), provenance, version: Number(row?.version ?? 1),
  }));
}
