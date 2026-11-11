import { createHash } from "node:crypto";

const TOMBSTONE_DOMAIN = "lukprae-customer-tombstone-v1\0";

// A restore ledger must never contain the provider identity itself. Domain
// separation also keeps this digest from being interchangeable with unrelated
// SHA-256 uses elsewhere in the product.
export function hashCustomerIdentity(lineUserId) {
  const id = String(lineUserId || "");
  if (!id) throw new Error("customer identity is required");
  return createHash("sha256").update(TOMBSTONE_DOMAIN).update(id).digest("hex");
}

export function normalizeTombstoneReason(value) {
  const reason = String(value || "pdpa_request").trim().replace(/[^a-z0-9:_-]+/giu, "_");
  return (reason.replace(/^_+|_+$/gu, "") || "pdpa_request").slice(0, 120);
}
