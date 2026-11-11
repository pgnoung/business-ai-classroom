import { BRAIN_MODE_SEPARATE, brainModeOf, catalogOutOfPrompt, isReviewCatalogTitle } from "../knowledgePack.mjs";
import { KNOWLEDGE_HEADER, KNOWLEDGE_MAX_CHARS } from "../knowledgePack.mjs";
import { compareSqliteText } from "./text.mjs";
import { hasKnowledgeMetadata, knowledgeMetadataFromCard } from "./knowledgeMetadata.mjs";

const DEFAULT_MAX_CHARS = KNOWLEDGE_MAX_CHARS;
const DEFAULT_TOP_K = 8;

function normalize(text) {
  return String(text ?? "").normalize("NFKC").replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/gu, "").toLowerCase();
}

function cardText(card) {
  return `[${String(card.body?.title ?? "-")}]\n${String(card.body?.content ?? "")}`;
}

function charLength(text) { return [...String(text)].length; }

function activeAt(card, atMs) {
  const from = timeValue(card?.validFrom);
  const until = timeValue(card?.validUntil);
  if (Number.isNaN(from) || Number.isNaN(until)) return false;
  return !(Number.isFinite(from) && atMs < from) && !(Number.isFinite(until) && atMs >= until);
}

function timeValue(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function scopeAllows(card, { separate, channelId }) {
  const scope = card?.scope?.channel;
  if (scope === undefined || scope === "*") return true;
  if (!separate) return scope === "central";
  return Array.isArray(scope) && scope.map(String).includes(channelId);
}

function channelCards(bundle, db, channelId) {
  const id = String(channelId || "default");
  const separate = brainModeOf(db, id) === BRAIN_MODE_SEPARATE;
  return (bundle?.cards ?? []).filter((card) => card?.kind === "fact" && card.inject !== "never" && (card.body?.title || card.body?.content) && (
    (separate ? String(card?.body?.channel_id ?? "") === id : card?.body?.channel_id === null)
      && scopeAllows(card, { separate, channelId: id })
  ));
}

function asciiTokenOffsets(phrase) {
  return [...phrase.matchAll(/[a-z0-9]+/gu)].map((match) => ({ token: match[0], offset: Number(match.index) }));
}

function phraseMatches(text, keyword) {
  const phrase = normalize(keyword);
  if (!phrase) return false;
  for (let start = text.indexOf(phrase); start >= 0; start = text.indexOf(phrase, start + 1)) {
    if (asciiTokenOffsets(phrase).every(({ token, offset }) => tokenHasBoundary(text, token, offset, start))) return true;
  }
  return false;
}

function tokenHasBoundary(text, token, offset, start) {
  const before = text[start + offset - 1] ?? "";
  const after = text[start + offset + token.length] ?? "";
  return !/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after);
}

function relevance(card, text) {
  const metadata = knowledgeMetadataFromCard(card);
  if (!metadata || metadata.mode !== "retrieve") return 0;
  return metadata.keywords.reduce((score, keyword) => score + (phraseMatches(text, keyword) ? 1 : 0), 0);
}

function candidateScore(card, text) {
  const group = groupOf(card);
  return relevance(card, text)
    + (group.domain && phraseMatches(text, group.domain) ? 1 : 0)
    + (group.offering && phraseMatches(text, group.offering) ? 2 : 0);
}

function groupOf(card) {
  const metadata = knowledgeMetadataFromCard(card);
  return { domain: metadata?.domain ?? "", offering: metadata?.offering ?? "" };
}

function groupKey(group) { return `${normalize(group.domain)}\u0000${normalize(group.offering)}`; }

function keywordOwners(cards) {
  const owners = new Map();
  for (const card of cards) {
    const key = groupKey(groupOf(card));
    for (const keyword of knowledgeMetadataFromCard(card).keywords) {
      const normalized = normalize(keyword);
      if (!owners.has(normalized)) owners.set(normalized, new Set());
      owners.get(normalized).add(key);
    }
  }
  return owners;
}

function offeringOwners(cards) {
  const owners = new Map();
  for (const card of cards) {
    const group = groupOf(card);
    const offering = normalize(group.offering);
    if (!offering) continue;
    if (!owners.has(offering)) owners.set(offering, new Set());
    owners.get(offering).add(groupKey(group));
  }
  return owners;
}

function matchingKeywords(card, text) {
  return knowledgeMetadataFromCard(card).keywords.filter((keyword) => phraseMatches(text, keyword));
}

// A shared keyword never selects an offering by itself. A selected offering may retain
// matching domain-general facts (offering="") for its domain, but cannot pull sibling offerings.
function selectGroups(candidates, allRetrieve, text) {
  const owners = keywordOwners(allRetrieve);
  const offerings = offeringOwners(allRetrieve);
  const selected = new Set();
  const selectedDomains = new Set();
  for (const candidate of candidates) {
    const group = groupOf(candidate.card);
    const key = groupKey(group);
    const explicitOffering = group.offering && phraseMatches(text, group.offering);
    const explicitDomain = group.domain && phraseMatches(text, group.domain);
    const uniqueKeyword = matchingKeywords(candidate.card, text)
      .some((keyword) => owners.get(normalize(keyword))?.size === 1);
    const offeringUnique = offerings.get(normalize(group.offering))?.size === 1;
    if ((explicitOffering && (offeringUnique || explicitDomain)) || uniqueKeyword || (explicitDomain && !group.offering)) {
      selected.add(key);
      selectedDomains.add(group.domain);
    }
  }
  const rows = candidates.filter((candidate) => {
    const group = groupOf(candidate.card);
    return selected.has(groupKey(group)) || (!group.offering && selectedDomains.has(group.domain));
  });
  return { rows, ambiguous: candidates.length > 0 && rows.length === 0 };
}

function byPriorityRelevanceId(a, b) {
  return (Number(b.card.priority) - Number(a.card.priority)) || (b.score - a.score)
    || compareSqliteText(String(a.card.revId ?? a.card.itemId), String(b.card.revId ?? b.card.itemId));
}

function boundedUserContext(recentContext) {
  return (Array.isArray(recentContext) ? recentContext : [])
    .filter((item) => item?.role === "user")
    .slice(-2)
    .map((item) => [...String(item.content ?? "")].slice(0, 300).join(""));
}

function safeIds(rows) {
  const ids = rows.slice(0, 32).map(({ card }) => String(card.revId ?? card.itemId));
  return { ids, omittedCount: Math.max(0, rows.length - ids.length) };
}

/**
 * Selects an already-versioned fact subset. The caller owns feature flags and prompt composition.
 * No query, customer text, or keyword is retained in trace.
 */
export function selectBrainKnowledgeForTurn({
  bundle, db, channelId = "default", queryText = "", recentContext = [], maxChars = DEFAULT_MAX_CHARS,
  topK = DEFAULT_TOP_K, atMs = Date.now(),
} = {}) {
  const limit = Math.max(0, Number(maxChars) || 0);
  const maxRetrieved = Math.max(0, Math.min(DEFAULT_TOP_K, Number(topK) || 0));
  const eligible = channelCards(bundle, db, channelId).filter((card) => activeAt(card, Number(atMs)));
  const pins = eligible
    .filter((card) => card.inject === "pin" && (!hasKnowledgeMetadata(card?.body?.provenance) || knowledgeMetadataFromCard(card)?.mode === "pin"))
    .map((card) => ({ card, score: 0 }))
    .sort(byPriorityRelevanceId);
  const configuredRetrieve = eligible
    .filter((card) => card.inject === "retrieve" && knowledgeMetadataFromCard(card)?.mode === "retrieve");

  const current = normalize(queryText);
  let candidates = configuredRetrieve.map((card) => ({ card, score: candidateScore(card, current) })).filter((row) => row.score > 0);
  let chosen = selectGroups(candidates, configuredRetrieve, current);
  if (!candidates.length) {
    const context = normalize(boundedUserContext(recentContext).join("\n"));
    if (context) {
      candidates = configuredRetrieve.map((card) => ({ card, score: candidateScore(card, context) })).filter((row) => row.score > 0);
      chosen = selectGroups(candidates, configuredRetrieve, context);
    }
  }
  candidates = chosen.rows;
  candidates.sort(byPriorityRelevanceId);

  const pinnedIds = safeIds(pins);
  const trace = {
    versionId: String(bundle?.versionId ?? ""),
    pinned: { count: pins.length, ...pinnedIds },
    retrieved: { count: 0, ids: [], omittedCount: 0 },
    ambiguous: chosen.ambiguous, maxChars: limit, usedChars: 0,
  };
  const pinBlocks = pins.map(({ card }) => cardText(card));
  const pinKnowledge = pinBlocks.length ? `${KNOWLEDGE_HEADER}\n${pinBlocks.join("\n\n")}` : "";
  // 19 ต.ค. 2026 (คลังรีวิวนอกพรอมต์ · สวิตช์ review_catalog_in_prompt ≠ on): การ์ดคลังรีวิวมีงบของตัวเอง
  // (คอนโซลคุม 40,000) — ไม่นับในเพดานนี้ ไม่งั้นคลังรีวิวที่โตตามงบใหม่จะทำให้ทุกเทิร์นถูก hold
  // (ข้อความเต็มยังอยู่ใน knowledge ให้โค้ดเลือกรีวิว · ตัดรายการก่อนเข้าโมเดลที่ปลายทาง)
  const catalogCard = catalogOutOfPrompt(db) ? pins.find(({ card }) => isReviewCatalogTitle(card.body?.title))?.card : null;
  const catalogChars = catalogCard ? charLength(cardText(catalogCard)) + 2 : 0;
  const pinnedChars = Math.max(0, charLength(pinKnowledge) - catalogChars);
  if (pinnedChars > limit) return { ok: false, knowledge: "", trace: { ...trace, usedChars: pinnedChars }, reason: "pinned_knowledge_over_budget" };

  const selected = [...pinBlocks];
  let used = pinnedChars;
  const budgetOf = (text) => Math.max(0, charLength(text) - catalogChars);
  const retrieved = [];
  for (const candidate of candidates) {
    if (retrieved.length >= maxRetrieved) break;
    const block = cardText(candidate.card);
    const next = budgetOf(selected.length ? `${KNOWLEDGE_HEADER}\n${[...selected, block].join("\n\n")}` : `${KNOWLEDGE_HEADER}\n${block}`);
    if (next > limit) continue;
    selected.push(block);
    used = next;
    retrieved.push(candidate);
  }
  return {
    ok: true,
    knowledge: selected.length ? `${KNOWLEDGE_HEADER}\n${selected.join("\n\n")}` : "",
    trace: { ...trace, retrieved: { count: retrieved.length, ...safeIds(retrieved) }, usedChars: used },
  };
}
