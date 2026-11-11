import { createHash } from "node:crypto";

// Title is presentation; this exact identity is shared by proposal creation
// and approval. Callers must validate and normalize metadata before hashing.
export function trainingIntakeEntryHash({ content, origin, scope = null, knowledgeMetadata }) {
  return createHash("sha256").update(JSON.stringify({ content, origin, scope, knowledgeMetadata })).digest("hex");
}
