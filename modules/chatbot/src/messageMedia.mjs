// Private attachment primitives. This deliberately does not know about HTTP or
// LINE credentials, which keeps provider fetching and operator uploads bounded.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { link as linkAsync, lstat as lstatAsync, open as openAsync, readdir as readdirAsync, unlink as unlinkAsync } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { inspectBroadcastImage } from "./broadcastMedia.mjs";

const MiB = 1024 * 1024;
const KEY_EXTENSIONS = new Set(["jpg", "png", "pdf", "mp4", "m4a", "mp3", "wav", "bin", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt", "md", "json", "zip", "mov"]);
const OPERATOR_EXTENSIONS = new Set(["jpg", "jpeg", "png", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt", "md", "json", "zip", "mp4", "mov", "m4a", "mp3"]);
const BLOCKED_EXTENSIONS = new Set(["exe", "dmg", "app", "pkg", "msi", "bat", "cmd", "com", "scr", "sh", "ps1", "js", "mjs", "cjs", "html", "htm", "svg", "xml", "php", "py", "rb", "jar", "dll", "so"]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export const PRIVATE_MEDIA_TYPES = Object.freeze({
  "image/jpeg": { ext: "jpg", kind: "image" }, "image/png": { ext: "png", kind: "image" },
  "application/pdf": { ext: "pdf", kind: "file" }, "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" }, "audio/mp4": { ext: "m4a", kind: "audio" },
  "audio/mpeg": { ext: "mp3", kind: "audio" }, "audio/wav": { ext: "wav", kind: "audio" },
});

function normalizedMime(value) { return String(value || "").split(";", 1)[0].trim().toLowerCase(); }
function extensionFor(name) { return extname(String(name || "")).slice(1).toLowerCase(); }
function isZip(bytes) { return bytes.length >= 4 && (bytes.subarray(0, 4).equals(Buffer.from("PK\x03\x04")) || bytes.subarray(0, 4).equals(Buffer.from("PK\x05\x06")) || bytes.subarray(0, 4).equals(Buffer.from("PK\x07\x08"))); }
function isOle(bytes) { return bytes.length >= OLE_SIGNATURE.length && bytes.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE); }
function mediaBox(bytes) {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") return null;
  const brand = bytes.subarray(8, 12).toString("ascii");
  if (brand === "qt  ") return { mime: "video/quicktime", ext: "mov", kind: "video" };
  if (["M4A ", "M4B ", "M4P "].includes(brand)) return { mime: "audio/mp4", ext: "m4a", kind: "audio" };
  if (["isom", "iso2", "avc1", "mp41", "mp42", "M4V ", "3gp4"].includes(brand)) return { mime: "video/mp4", ext: "mp4", kind: "video" };
  return null;
}
function detectedStrongType(bytes) {
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: "image/jpeg", ...PRIVATE_MEDIA_TYPES["image/jpeg"] };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ...PRIVATE_MEDIA_TYPES["image/png"] };
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return { mime: "application/pdf", ...PRIVATE_MEDIA_TYPES["application/pdf"] };
  const box = mediaBox(bytes); if (box) return box;
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return { mime: "audio/wav", ...PRIVATE_MEDIA_TYPES["audio/wav"] };
  if ((bytes.length >= 3 && bytes.subarray(0, 3).toString("ascii") === "ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { mime: "audio/mpeg", ...PRIVATE_MEDIA_TYPES["audio/mpeg"] };
  return null;
}

export function allowedPrivateMedia(mime) { return PRIVATE_MEDIA_TYPES[normalizedMime(mime)] || null; }
// MIME headers never turn unknown bytes into active content. The actual bytes win.
export function detectPrivateMedia(buffer, declaredMime = "") {
  const detected = detectedStrongType(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || ""));
  return detected ? { ...detected, declaredMime: normalizedMime(declaredMime) } : null;
}
export function safeAttachmentName(name, fallback = "attachment") {
  const base = String(name || fallback).normalize("NFC").replace(/[\\/\u0000-\u001f\u007f]/g, "_").trim();
  return (base || fallback).slice(0, 120);
}
export function attachmentContentDisposition(name, disposition = "attachment") {
  const safe = safeAttachmentName(name);
  const ascii = safe.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/g, "_") || "attachment";
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition === "inline" ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
export function normalizeHttpsOrigin(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/") || url.port) return "";
    return url.origin;
  } catch { return ""; }
}
function textLooksSafe(bytes, ext) {
  if (!bytes.length || bytes.includes(0)) return false;
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return false; }
  if (/<!doctype|<html|<script|<svg|<\?xml/i.test(text)) return false;
  if (ext === "json") try { JSON.parse(text); } catch { return false; }
  return true;
}
function operatorType(bytes, name) {
  const ext = extensionFor(name);
  if (!OPERATOR_EXTENSIONS.has(ext) || BLOCKED_EXTENSIONS.has(ext)) return null;
  const strong = detectedStrongType(bytes);
  if (["jpg", "jpeg", "png"].includes(ext)) {
    const expected = ext === "png" ? "image/png" : "image/jpeg";
    return strong?.mime === expected ? strong : null;
  }
  if (ext === "pdf") return strong?.mime === "application/pdf" ? { ...strong, kind: "file" } : null;
  if (["doc", "xls", "ppt"].includes(ext)) return isOle(bytes) ? { mime: "application/vnd.ms-office", ext, kind: "file" } : null;
  if (["docx", "xlsx", "pptx", "zip"].includes(ext)) return isZip(bytes) ? { mime: ext === "zip" ? "application/zip" : "application/vnd.openxmlformats-officedocument", ext, kind: "file" } : null;
  if (["csv", "txt", "md", "json"].includes(ext)) return textLooksSafe(bytes, ext) ? { mime: ext === "json" ? "application/json" : "text/plain; charset=utf-8", ext, kind: "file" } : null;
  if (["mp4", "mov", "m4a", "mp3"].includes(ext)) {
    const expected = { mp4: "video/mp4", mov: "video/quicktime", m4a: "audio/mp4", mp3: "audio/mpeg" }[ext];
    return strong?.mime === expected ? { ...strong, ext } : null;
  }
  return null;
}
function inboundType(bytes) { return detectedStrongType(bytes) || { mime: "application/octet-stream", ext: "bin", kind: "file", opaque: true }; }
function assertSafeRoot(root, { create = false } = {}) {
  if (!root) throw new Error("private media store disabled");
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("private media root must be a real directory");
  return stat;
}

// statfs is advisory and unavailable on some older Node/filesystem providers.
// If it is available, insufficient free space is an explicit fail-closed error.
export function hasPrivateMediaCapacity(root, byteSize, minFreeBytes, statfs = statfsSync) {
  try {
    const stats = statfs(root);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(free) && free - Number(byteSize) >= Number(minFreeBytes);
  } catch (error) {
    if (error?.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" || error?.code === "ENOSYS") return true;
    // Unknown filesystem-capacity failures must not turn a failed probe into a
    // bypass. A truly absent statfs is the one explicit compatibility exception.
    if (typeof statfs !== "function") return true;
    return false;
  }
}

// ไฟล์ที่ "ลูกค้าส่งเข้ามาจากผู้ให้บริการแชท" ตรวจชนิดจากไบต์ล้วน (ไม่มีชื่อไฟล์ให้เชื่อ)
// ต่างจากไฟล์ที่แอดมินอัปโหลดเองซึ่งตรวจนามสกุลประกอบ — Facebook อยู่กลุ่มเดียวกับ LINE
const INBOUND_MEDIA_ORIGINS = new Set(["line", "facebook"]);

export function createPrivateMediaStore({ dir, maxBytes = 64 * MiB, imageMaxBytes = 10 * MiB, imageMaxWidth = 8192, imageMaxHeight = 8192, imageMaxPixels = 20_000_000, minFreeBytes = 1 * 1024 * MiB, statfs = statfsSync } = {}) {
  const root = dir ? resolve(dir) : "";
  function enabled() { return Boolean(root); }
  function ensureRoot() { return assertSafeRoot(root, { create: true }); }
  function keyPath(key) {
    if (!/^[a-f0-9-]{36}\.[a-z0-9]{1,8}$/u.test(String(key))) throw new Error("invalid private media key");
    const ext = String(key).split(".").at(-1); if (!KEY_EXTENSIONS.has(ext)) throw new Error("invalid private media key");
    const target = resolve(root, key); if (!root || !target.startsWith(`${root}/`)) throw new Error("unsafe private media path");
    return target;
  }
  function open(key) {
    ensureRoot(); const path = keyPath(key); const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error("unsafe private media file"); return { fd, stat, path, close: () => closeSync(fd) }; }
    catch (error) { try { closeSync(fd); } catch { /* noop */ } throw error; }
  }
  function remove(key) {
    ensureRoot(); try { unlinkSync(keyPath(key)); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  }
  function save({ buffer, mime, name, kind, origin = "operator" } = {}) {
    if (!enabled()) throw new Error("private media store disabled");
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    if (!bytes.length || bytes.length > maxBytes) throw new Error("invalid private media size");
    const safeName = safeAttachmentName(name); const source = INBOUND_MEDIA_ORIGINS.has(origin) ? "line" : "operator";
    let detected = source === "line" ? inboundType(bytes) : operatorType(bytes, safeName);
    if (!detected) throw new Error("unsupported private media type");
    if (source === "line" && kind === "file") {
      // LINE's webhook kind is authoritative for presentation: an MP4 sent as
      // a document remains download-only even when its bytes are recognisable.
      detected = { ...detected, kind: "file" };
    } else if (kind && kind !== detected.kind) {
      throw new Error("private media kind does not match bytes");
    }
    if (detected.kind === "image") {
      try { inspectBroadcastImage(bytes, detected.mime, { mediaUploadMaxBytes: imageMaxBytes, mediaUploadMaxWidth: imageMaxWidth, mediaUploadMaxHeight: imageMaxHeight, mediaUploadMaxPixels: imageMaxPixels, privateMediaImageMaxBytes: imageMaxBytes }); }
      catch (error) { throw new Error(`invalid private image: ${error?.code || "invalid"}`); }
    }
    ensureRoot();
    if (!hasPrivateMediaCapacity(root, bytes.length, minFreeBytes, statfs)) throw new Error("insufficient private media disk space");
    const key = `${randomUUID()}.${detected.ext}`; const finalPath = keyPath(key); const tempPath = keyPath(`${randomUUID()}.${detected.ext}`); let fd = null;
    try {
      fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = null;
      // link publishes atomically without allowing a UUID collision to overwrite data.
      linkSync(tempPath, finalPath); unlinkSync(tempPath);
      const rootFd = openSync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
    } catch (error) {
      if (fd !== null) try { closeSync(fd); } catch { /* noop */ }
      try { unlinkSync(tempPath); } catch { /* noop */ }
      try { unlinkSync(finalPath); } catch { /* noop */ }
      throw error;
    }
    return { storageKey: key, mime: detected.mime, kind: detected.kind, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), originalName: safeName, opaque: Boolean(detected.opaque) };
  }
  // HTTP/provider ingestion uses the asynchronous writer so a large fsync does
  // not block signed webhook handling or every Console request in this process.
  // The synchronous save remains only for small offline/test utilities.
  async function saveAsync({ buffer, mime, name, kind, origin = "operator" } = {}) {
    if (!enabled()) throw new Error("private media store disabled");
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
    if (!bytes.length || bytes.length > maxBytes) throw new Error("invalid private media size");
    const safeName = safeAttachmentName(name); const source = INBOUND_MEDIA_ORIGINS.has(origin) ? "line" : "operator";
    let detected = source === "line" ? inboundType(bytes) : operatorType(bytes, safeName);
    if (!detected) throw new Error("unsupported private media type");
    if (source === "line" && kind === "file") detected = { ...detected, kind: "file" };
    else if (kind && kind !== detected.kind) throw new Error("private media kind does not match bytes");
    if (detected.kind === "image") {
      try { inspectBroadcastImage(bytes, detected.mime, { mediaUploadMaxBytes: imageMaxBytes, mediaUploadMaxWidth: imageMaxWidth, mediaUploadMaxHeight: imageMaxHeight, mediaUploadMaxPixels: imageMaxPixels, privateMediaImageMaxBytes: imageMaxBytes }); }
      catch (error) { throw new Error(`invalid private image: ${error?.code || "invalid"}`); }
    }
    ensureRoot();
    if (!hasPrivateMediaCapacity(root, bytes.length, minFreeBytes, statfs)) throw new Error("insufficient private media disk space");
    const key = `${randomUUID()}.${detected.ext}`; const finalPath = keyPath(key); const tempPath = keyPath(`${randomUUID()}.${detected.ext}`); let handle = null;
    try {
      handle = await openAsync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await linkAsync(tempPath, finalPath); await unlinkAsync(tempPath);
      const rootHandle = await openAsync(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      try { await rootHandle.sync(); } finally { await rootHandle.close(); }
    } catch (error) {
      if (handle) try { await handle.close(); } catch { /* noop */ }
      try { await unlinkAsync(tempPath); } catch { /* noop */ }
      try { await unlinkAsync(finalPath); } catch { /* noop */ }
      throw error;
    }
    return { storageKey: key, mime: detected.mime, kind: detected.kind, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), originalName: safeName, opaque: Boolean(detected.opaque) };
  }
  async function listStoredKeysOlderThan(beforeMs) {
    if (!enabled()) return [];
    ensureRoot();
    const entries = await readdirAsync(root, { withFileTypes: true });
    const keys = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const path = keyPath(entry.name);
        const details = await lstatAsync(path);
        if (details.isFile() && !details.isSymbolicLink() && details.mtimeMs <= Number(beforeMs)) keys.push(entry.name);
      } catch { /* Ignore names outside the opaque private-media grammar. */ }
    }
    return keys;
  }
  return { enabled, ensureRoot, keyPath, open, remove, save, saveAsync, listStoredKeysOlderThan, maxBytes, imageMaxBytes };
}

// ชุดสติกเกอร์ที่แอดมินส่งได้ — คัดมือ ดูภาพจริงทีละตัวแล้วทุกตัว
//
// คำสั่งพี่ง้วง 2026-08-26: "เราส่งให้ลูกค้า องค์กร และ CEO / อยากให้มี cony, brown
// ปกติด้วยครับ (ไม่ดูตลก)"
//
// ประวัติที่ต้องบันทึกไว้: ก่อนหน้านี้ชุดนี้เป็น package 446 ซึ่งคือชุด "Moon"
// (ตัวหน้าขาว) ที่เป็นมุกตลกเกินจริง — เมา โยนเงิน ร้องไห้ โมโห — และที่แย่กว่านั้นคือ
// ป้ายชื่อสามตัวเดิมไม่ตรงกับภาพเลยแม้แต่ตัวเดียว:
//   446:1988 เขียน "โอเค"   ภาพจริง = Moon ถือกล้องถ่ายรูป
//   446:1990 เขียน "ขอบคุณ" ภาพจริง = Moon แร็ปหน้าเครื่องเสียง
//   446:1992 เขียน "รับทราบ" ภาพจริง = Moon ยกแก้วเบียร์
// เดิมหน้าเว็บแสดงแต่ตัวหนังสือจึงไม่มีใครเห็น พอเปิดให้แสดงภาพจริงแล้ว
// การกด "รับทราบ" จะกลายเป็นการส่งรูปคนดื่มเบียร์ให้ลูกค้าองค์กร
//
// ชุดใหม่มาจาก package 11537 (Brown & Cony ลายทางการของ LINE) ยืนยัน packageId
// จากสติกเกอร์ที่ลูกค้าเราส่งเข้ามาจริงในฐานข้อมูล ไม่ได้เดา
// ทุกตัวถูกเปิดดูภาพก่อนใส่ และป้ายชื่อเขียนตามสิ่งที่เห็นในภาพจริงเท่านั้น
// สองชุดที่ใช้ ทั้งคู่เป็นชุดทางการของ LINE และยืนยัน packageId ได้จากสติกเกอร์
// ที่ลูกค้าเราส่งเข้ามาจริงในฐานข้อมูล ไม่ได้เดาจากช่วงตัวเลข
const PACK_BROWN_CONY = "11537";  // Brown / Cony / Sally ลายทางการ
const PACK_RJ = "11539";          // RJ น้องแกะขนฟู (ชุด BT21) — มีท่าโค้งคำนับที่หาไม่ได้ในชุดอื่น

export const BASIC_STICKERS = Object.freeze([
  // ---- Brown (หมีน้ำตาล) — ตัวหลักสำหรับงานประจำวัน ----
  // ยืนเฉย ๆ สีหน้าปกติ ตัวกลางที่สุด ใช้ได้ทุกสถานการณ์
  { packageId: PACK_BROWN_CONY, stickerId: "52002739", label: "รับทราบ", symbol: "🐻" },
  // ชูป้าย OKAY!
  { packageId: PACK_BROWN_CONY, stickerId: "52002740", label: "โอเค", symbol: "👌" },
  // กอดอก มี "..." เหนือหัว
  { packageId: PACK_BROWN_CONY, stickerId: "52002754", label: "กำลังตรวจสอบ", symbol: "🔎" },
  // นั่งโต๊ะ ท่าคิด
  { packageId: PACK_BROWN_CONY, stickerId: "52002746", label: "กำลังพิจารณา", symbol: "🤔" },
  // มี "??" สองอันเหนือหัว
  { packageId: PACK_BROWN_CONY, stickerId: "52002744", label: "ขอสอบถามเพิ่ม", symbol: "❓" },
  // ประสานมือ มีเหงื่อ ท่าเกรงใจ
  { packageId: PACK_BROWN_CONY, stickerId: "52002770", label: "ขอโทษด้วยค่ะ", symbol: "🙇" },
  // ยิงลูกโป่งฉลอง มีกระดาษสี
  { packageId: PACK_BROWN_CONY, stickerId: "52002734", label: "ยินดีด้วยค่ะ", symbol: "🎉" },

  // ---- Cony (กระต่ายขาว) ----
  // ยกนิ้วโป้ง
  { packageId: PACK_BROWN_CONY, stickerId: "52002735", label: "เยี่ยมเลยค่ะ", symbol: "👍" },
  // ดีใจ มีดอกไม้รอบตัว
  { packageId: PACK_BROWN_CONY, stickerId: "52002745", label: "ดีใจด้วยค่ะ", symbol: "🌸" },
  // ประสานมือ ตาเป็นประกาย
  { packageId: PACK_BROWN_CONY, stickerId: "52002752", label: "ตื่นเต้นแทนเลยค่ะ", symbol: "✨" },

  // ---- Sally (เป็ดเหลือง) ----
  // ยืนร่าเริง มีประกายเล็ก ๆ
  { packageId: PACK_BROWN_CONY, stickerId: "52002741", label: "สวัสดีค่ะ", symbol: "🐤" },

  // ---- RJ (น้องแกะ) — ท่าโค้งคำนับที่พี่ง้วงขอ ----
  // ยืนพนมมือระดับอก ก้มหน้าเล็กน้อย
  { packageId: PACK_RJ, stickerId: "52114110", label: "ขอบคุณค่ะ", symbol: "🙏" },
  // โค้งคำนับเต็มตัว พนมมือ หลับตา
  { packageId: PACK_RJ, stickerId: "52114115", label: "ขอบพระคุณค่ะ", symbol: "🙇" },
]);
export function validBasicSticker(input) { const packageId = String(input?.packageId || ""); const stickerId = String(input?.stickerId || ""); return BASIC_STICKERS.find((sticker) => sticker.packageId === packageId && sticker.stickerId === stickerId) || null; }
