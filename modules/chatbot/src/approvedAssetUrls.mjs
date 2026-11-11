// Exact approved URLs only; do not trust URLs proposed by the reply model.
export function assetUrls(text = "") {
  const urls = new Set();
  for (const match of String(text).matchAll(/(?:https?:\/\/|www\.)[^\s<>"'()\[\]{}]+/giu)) {
    const raw = match[0].replace(/[.,!?:;]+$/u, "");
    try { urls.add(new URL(raw.startsWith("www.") ? `https://${raw}` : raw).href); }
    catch { urls.add(raw); } // malformed model URLs must also fail closed
  }
  return urls;
}

export function hasUnapprovedAssetUrl(text, approved) {
  return [...assetUrls(text)].some(url => !approved.has(url));
}
