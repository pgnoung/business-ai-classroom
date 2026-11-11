import { selectBrainKnowledgeForTurn } from "./retrieval.mjs";

function userQueryAndContext(turns) {
  const users = (Array.isArray(turns) ? turns : []).filter((turn) => turn?.role === "user");
  const latest = users.at(-1);
  return {
    queryText: String(latest?.content ?? ""),
    recentContext: users.slice(0, -1).slice(-2).map((turn) => ({
      role: "user", content: [...String(turn.content ?? "")].slice(0, 300).join(""),
    })),
  };
}

/** A follow-up may use retrieval only from one ready immutable view; callers retain legacy behavior while off. */
export function selectFollowupKnowledge({ config, brainRuntime, db, customerId, channelId, turns, atMs = Date.now() } = {}) {
  if (config?.brainRetrievalEnabled !== true) return null;
  let brain;
  try { brain = brainRuntime?.resolve?.(customerId, channelId || "default", atMs); } catch { return { ok: false, reason: "brain_not_ready" }; }
  if (!brain) return { ok: false, reason: "brain_not_ready" };
  try {
    const selection = selectBrainKnowledgeForTurn({
      bundle: brain.bundle, db, channelId: channelId || "default", atMs,
      ...userQueryAndContext(turns ?? db.recentTurns(customerId, 6)),
    });
    if (!selection.ok) return { ok: false, reason: selection.reason || "knowledge_selection_failed" };
    return { ok: true, brain, selection };
  } catch {
    return { ok: false, reason: "knowledge_selection_failed" };
  }
}
