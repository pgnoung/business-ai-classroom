// Optional admin advice is not the score, customer memory, or chat reply.
// Fail closed: no setting / failed read means no advice generation or reuse.
export const SCORER_SUGGESTIONS_KEY = "scorer_suggestions_enabled";

export function scorerSuggestionsEnabled(db) {
  try { return db.getSetting(SCORER_SUGGESTIONS_KEY) === "1"; }
  catch { return false; }
}

export function withoutScorerSuggestions(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const { next_move, suggested_question, ...rest } = payload;
  return rest;
}
