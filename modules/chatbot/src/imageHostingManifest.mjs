// Optional integrity boundary for public /img assets.
//
// A configured manifest is fail-closed: only files named by the reviewed
// manifest are served, and their bytes must match the pinned size + SHA-256 at
// application startup. The route serves the verified in-memory snapshot, so a
// later in-place overwrite cannot be emitted under the pinned ETag.
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SAFE_NAME = /^[a-z0-9_-]+\.(?:jpg|png)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function readPinnedFile(path, expectedBytes) {
  let fd = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_IMAGE_BYTES || stat.size !== expectedBytes) {
      throw new Error("manifest asset size is unsafe or drifted");
    }
    const bytes = readFileSync(fd);
    return { stat, bytes };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function normalizeAsset(item, role) {
  if (!item || typeof item !== "object") throw new Error(`image hosting manifest ${role} entry is missing`);
  const file = String(item.file || "").trim();
  const mime = String(item.mime || "").trim();
  const sha256 = String(item.sha256 || "").trim().toLowerCase();
  const bytes = Number(item.bytes);
  if (!SAFE_NAME.test(file)) throw new Error(`image hosting manifest has unsafe file: ${file}`);
  const expectedMime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  if (mime !== expectedMime) throw new Error(`image hosting manifest MIME mismatch for ${file}`);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_IMAGE_BYTES) {
    throw new Error(`image hosting manifest byte size is invalid for ${file}`);
  }
  if (!SHA256.test(sha256)) throw new Error(`image hosting manifest SHA-256 is invalid for ${file}`);
  return { file, mime, sha256, bytes };
}

export function loadImageHostingManifest(file, { imageDir } = {}) {
  if (!file) return null;
  if (!isAbsolute(file) || !imageDir || !isAbsolute(imageDir)) {
    throw new Error("IMAGE_HOSTING_MANIFEST_FILE and IMAGE_DIR must be absolute when integrity hosting is enabled");
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (parsed?.schema !== "pngoung-chat-media-source-v1" || !Array.isArray(parsed.assets)) {
    throw new Error("image hosting manifest schema is invalid");
  }
  const manifestDir = resolve(dirname(file));
  const expectedDir = resolve(imageDir);
  if (manifestDir !== expectedDir) throw new Error("image hosting manifest must live inside IMAGE_DIR");

  const entries = new Map();
  for (const asset of parsed.assets) {
    for (const [role, raw] of [["original", asset?.original], ["preview", asset?.preview]]) {
      const entry = normalizeAsset(raw, role);
      if (entries.has(entry.file)) throw new Error(`image hosting manifest has duplicate file: ${entry.file}`);
      const absolute = join(expectedDir, entry.file);
      const { stat, bytes } = readPinnedFile(absolute, entry.bytes);
      const actualSha256 = createHash("sha256").update(bytes).digest("hex");
      if (stat.size !== entry.bytes || actualSha256 !== entry.sha256) {
        throw new Error(`image hosting manifest drift detected for ${entry.file}`);
      }
      entries.set(entry.file, Object.freeze({
        ...entry,
        content: Buffer.from(bytes),
        etag: `"sha256-${entry.sha256}"`,
      }));
    }
  }
  if (entries.size === 0) throw new Error("image hosting manifest has no approved assets");
  return entries;
}
