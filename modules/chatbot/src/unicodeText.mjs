// Unicode boundary helpers for model prompts.  JavaScript string indexes are
// UTF-16 code units, so String#slice can split an emoji surrogate pair and
// leave invalid JSON text for strict upstream providers.

export function wellFormedText(value) {
  return String(value ?? "").toWellFormed();
}

export function codePointLength(value) {
  return [...wellFormedText(value)].length;
}

export function truncateCodePoints(value, maxCodePoints) {
  const limit = Number.isFinite(maxCodePoints) ? Math.max(0, Math.floor(maxCodePoints)) : 0;
  return [...wellFormedText(value)].slice(0, limit).join("");
}

// Final defensive boundary for any chat-completions message shape accepted by
// the bridge.  Keep metadata untouched; only provider-visible text is repaired.
export function wellFormedMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    ...message,
    content: Array.isArray(message?.content)
      ? message.content.map((block) => {
        if (typeof block === "string") return wellFormedText(block);
        if (block && typeof block === "object" && "text" in block) return { ...block, text: wellFormedText(block.text) };
        return block;
      })
      : wellFormedText(message?.content),
  }));
}
