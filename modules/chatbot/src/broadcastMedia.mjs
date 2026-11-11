// broadcastMedia.mjs — คลังรูปที่ operator อัปโหลดสำหรับบรอดแคส (zero-dep)
//
// เส้นทางนี้ไม่รับ URL/ชื่อ path จากผู้ใช้: server สร้าง UUID, ตรวจ JPEG/PNG จริง,
// เก็บ metadata ใน SQLite และ public route เสิร์ฟเฉพาะไฟล์ที่ DB allowlist ว่า active
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, createReadStream, existsSync, fsyncSync, fstatSync, linkSync,
  lstatSync, mkdirSync, openSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const PNG_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);
const PNG_CHANNELS = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);
const ADAM7_PASSES = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];
const PNG_DECODED_MAX_BYTES = 40_000_000;

export class MediaUploadError extends Error {
  constructor(status, message, code = "media_upload_error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function imageLimits(config) {
  // Broadcast's historical 1 MiB hard ceiling remains its default. Private
  // conversation storage opts into a separately named ceiling only when its
  // caller explicitly supplies it.
  const configuredMaxBytes = Number(config.privateMediaImageMaxBytes ?? config.mediaUploadMaxBytes);
  const maxBytesCeiling = config.privateMediaImageMaxBytes === undefined ? 1_000_000 : 64 * 1024 * 1024;
  return {
    maxBytes: Math.min(maxBytesCeiling, Math.max(1, configuredMaxBytes || 1_000_000)),
    maxWidth: Math.max(1, Number(config.mediaUploadMaxWidth) || 8192),
    maxHeight: Math.max(1, Number(config.mediaUploadMaxHeight) || 8192),
    maxPixels: Math.max(1, Number(config.mediaUploadMaxPixels) || 20_000_000),
    maxActive: Math.max(1, Number(config.mediaUploadMaxActive) || 100),
    maxTotalBytes: Math.max(1, Number(config.mediaUploadTotalBytes) || 100_000_000),
    perOperatorHour: Math.max(1, Number(config.mediaUploadsPerOperatorHour) || 20),
  };
}

function validateDimensions(width, height, limits) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new MediaUploadError(400, "อ่านขนาดรูปไม่ได้ — ไฟล์อาจเสียหรือไม่ใช่รูปจริง", "invalid_dimensions");
  }
  if (width > limits.maxWidth || height > limits.maxHeight || width * height > limits.maxPixels) {
    throw new MediaUploadError(
      400,
      `รูปใหญ่เกินเพดาน (${limits.maxWidth}×${limits.maxHeight}px / ${limits.maxPixels.toLocaleString("en-US")} pixels)`,
      "image_dimensions_too_large",
    );
  }
  return { width, height };
}

function pngCrc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngScanLayout({ width, height, bitDepth, colorType, interlace }) {
  const bitsPerPixel = PNG_CHANNELS.get(colorType) * bitDepth;
  const passes = interlace === 0 ? [[0, 0, 1, 1]] : ADAM7_PASSES;
  const rowOffsets = [];
  let expectedBytes = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = width <= startX ? 0 : Math.ceil((width - startX) / stepX);
    const passHeight = height <= startY ? 0 : Math.ceil((height - startY) / stepY);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil((passWidth * bitsPerPixel) / 8);
    for (let row = 0; row < passHeight; row += 1) {
      rowOffsets.push(expectedBytes);
      expectedBytes += 1 + rowBytes; // filter byte + packed pixels
    }
  }
  if (expectedBytes < 1 || expectedBytes > PNG_DECODED_MAX_BYTES) {
    throw new MediaUploadError(400, "PNG มี decoded pixel data ใหญ่เกินเพดาน", "png_decoded_too_large");
  }
  return { expectedBytes, rowOffsets };
}

function inspectPng(buffer, limits) {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new MediaUploadError(400, "ไฟล์ PNG ไม่สมบูรณ์", "invalid_png");
  }
  let offset = 8;
  let dimensions = null;
  let chunkIndex = 0;
  let idatStarted = false;
  let idatEnded = false;
  let paletteEntries = 0;
  const idatChunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new MediaUploadError(400, "ไฟล์ PNG ถูกตัดไม่ครบ", "truncated_png");
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    if (pngCrc32(buffer, offset + 4, offset + 8 + length) !== expectedCrc) {
      throw new MediaUploadError(400, `PNG checksum ของ ${type || "chunk"} ไม่ถูกต้อง`, "invalid_png_crc");
    }
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      throw new MediaUploadError(400, "PNG ต้องเริ่มด้วย IHDR ที่ถูกต้อง", "invalid_png_header");
    }
    if (type === "IHDR") {
      if (dimensions) throw new MediaUploadError(400, "PNG มี IHDR ซ้ำ", "invalid_png_header");
      const size = validateDimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12), limits);
      const bitDepth = buffer[offset + 16];
      const colorType = buffer[offset + 17];
      const compression = buffer[offset + 18];
      const filter = buffer[offset + 19];
      const interlace = buffer[offset + 20];
      if (!PNG_DEPTHS.get(colorType)?.has(bitDepth) || compression !== 0 || filter !== 0 || interlace > 1) {
        throw new MediaUploadError(400, "PNG IHDR/สี/bit depth ไม่ถูกต้อง", "invalid_png_header");
      }
      dimensions = { ...size, bitDepth, colorType, interlace };
    }
    if (type === "PLTE") {
      if (!dimensions || idatStarted || length < 3 || length > 768 || length % 3 !== 0 ||
          dimensions.colorType === 0 || dimensions.colorType === 4) {
        throw new MediaUploadError(400, "PNG palette ไม่ถูกต้อง", "invalid_png_palette");
      }
      paletteEntries = length / 3;
      if (dimensions.colorType === 3 && paletteEntries > 2 ** dimensions.bitDepth) {
        throw new MediaUploadError(400, "PNG palette เกิน bit depth", "invalid_png_palette");
      }
    }
    if (type === "IDAT") {
      if (!dimensions || idatEnded) {
        throw new MediaUploadError(400, "ลำดับ PNG IDAT ไม่ถูกต้อง", "invalid_png_data");
      }
      idatStarted = true;
      idatChunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    } else if (idatStarted && type !== "IEND") {
      idatEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || end !== buffer.length) {
        throw new MediaUploadError(400, "PNG มีข้อมูลต่อท้ายหลัง IEND", "png_trailing_data");
      }
      if (!dimensions) throw new MediaUploadError(400, "PNG ไม่มีข้อมูลขนาดรูป", "invalid_png_header");
      if (!idatChunks.length || idatChunks.every((chunk) => chunk.length === 0)) {
        throw new MediaUploadError(400, "PNG ไม่มีข้อมูลภาพ IDAT", "invalid_png_data");
      }
      if (dimensions.colorType === 3 && !paletteEntries) {
        throw new MediaUploadError(400, "PNG แบบ indexed color ต้องมี palette", "invalid_png_palette");
      }
      const layout = pngScanLayout(dimensions);
      let decoded;
      try {
        decoded = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: layout.expectedBytes });
      } catch {
        throw new MediaUploadError(400, "ข้อมูลภาพ PNG/IDAT ไม่สมบูรณ์", "invalid_png_data");
      }
      if (decoded.length !== layout.expectedBytes || layout.rowOffsets.some((at) => decoded[at] > 4)) {
        throw new MediaUploadError(400, "PNG scanline/filter ไม่ตรงกับ IHDR", "invalid_png_scanlines");
      }
      return { mime: "image/png", ext: "png", width: dimensions.width, height: dimensions.height };
    }
    offset = end;
    chunkIndex += 1;
  }
  throw new MediaUploadError(400, "PNG ไม่มี IEND หรือไฟล์ถูกตัด", "truncated_png");
}

function inspectJpeg(buffer, limits) {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8 ||
      buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
    throw new MediaUploadError(400, "ไฟล์ JPEG ไม่สมบูรณ์", "invalid_jpeg");
  }
  let offset = 2;
  let dimensions = null;
  let hasImageData = false;
  while (offset < buffer.length - 2) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > buffer.length) throw new MediaUploadError(400, "JPEG ถูกตัดกลาง segment", "truncated_jpeg");
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      throw new MediaUploadError(400, "โครงสร้าง JPEG ไม่ถูกต้อง", "invalid_jpeg_segment");
    }
    if (JPEG_SOF.has(marker)) {
      if (length < 7) throw new MediaUploadError(400, "JPEG SOF ไม่สมบูรณ์", "invalid_jpeg_segment");
      dimensions = validateDimensions(buffer.readUInt16BE(offset + 3), buffer.readUInt16BE(offset + 5), limits);
    }
    // หลัง SOS เป็น entropy stream; ต้องมีอย่างน้อยหนึ่ง byte ก่อน EOI
    if (marker === 0xda) {
      if (!dimensions || length < 6 || offset + length >= buffer.length - 2) {
        throw new MediaUploadError(400, "JPEG ไม่มีข้อมูลภาพหลัง SOS", "invalid_jpeg_data");
      }
      hasImageData = true;
      break;
    }
    offset += length;
  }
  if (!dimensions) throw new MediaUploadError(400, "JPEG ไม่มี SOF/ขนาดรูปที่อ่านได้", "invalid_jpeg_dimensions");
  if (!hasImageData) throw new MediaUploadError(400, "JPEG ไม่มี SOS/ข้อมูลภาพ", "invalid_jpeg_data");
  return { mime: "image/jpeg", ext: "jpg", ...dimensions };
}

export function inspectBroadcastImage(buffer, declaredMime, config = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new MediaUploadError(400, "ไฟล์รูปว่าง", "empty_media");
  }
  const limits = imageLimits(config);
  if (buffer.length > limits.maxBytes) {
    throw new MediaUploadError(413, `รูปต้องไม่เกิน ${limits.maxBytes.toLocaleString("en-US")} bytes`, "media_too_large");
  }
  const mime = String(declaredMime || "").split(";", 1)[0].trim().toLowerCase();
  if (mime !== "image/jpeg" && mime !== "image/png") {
    throw new MediaUploadError(415, "รองรับเฉพาะ JPEG หรือ PNG", "unsupported_media_type");
  }
  const looksPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  const looksJpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if ((mime === "image/png" && !looksPng) || (mime === "image/jpeg" && !looksJpeg)) {
    throw new MediaUploadError(415, "ชนิดไฟล์ที่แจ้งไม่ตรงกับ magic bytes", "mime_magic_mismatch");
  }
  const inspected = mime === "image/png" ? inspectPng(buffer, limits) : inspectJpeg(buffer, limits);
  return inspected;
}

function publicBase(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        (url.pathname && url.pathname !== "/")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function cleanLabel(raw) {
  const leaf = basename(String(raw || "")).normalize("NFC");
  return leaf.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 120) || "รูปที่อัปโหลด";
}

function catalogEntry(row, baseUrl) {
  const url = `${baseUrl}/media/${row.filename}`;
  return {
    key: row.asset_key,
    label: row.label || row.asset_key,
    url,
    previewUrl: url,
    consoleUrl: `/media/${row.filename}`,
    mime: row.mime,
    bytes: row.byte_size,
    width: row.width,
    height: row.height,
    uploaded: true,
  };
}

export function createBroadcastMediaStore({ config, db, logger = console, now = Date.now, uuid = randomUUID } = {}) {
  const dir = resolve(String(config?.mediaDir || ""));
  const baseUrl = publicBase(config?.mediaPublicBaseUrl);
  const limits = imageLimits(config || {});
  const configured = Boolean(config?.mediaDir && baseUrl);
  const uploadEnabled = config?.mediaUploadEnabled === true && configured;

  function status() {
    let reason = "";
    if (config?.mediaUploadEnabled !== true) reason = "MEDIA_UPLOAD_ENABLED=false";
    else if (!config?.mediaDir) reason = "MEDIA_DIR ยังไม่ได้ตั้งค่า";
    else if (!baseUrl) reason = "MEDIA_PUBLIC_BASE_URL ต้องเป็น https origin ที่ถูกต้อง";
    return { enabled: uploadEnabled, configured, reason, ...limits, formats: ["image/jpeg", "image/png"] };
  }

  function list() {
    if (!configured) return [];
    return db.listMediaAssets({ status: "active", limit: limits.maxActive })
      .map((row) => catalogEntry(row, baseUrl));
  }

  function getByKey(key) {
    if (!configured) return null;
    const row = db.getMediaAssetByKey(key);
    return row?.status === "active" ? catalogEntry(row, baseUrl) : null;
  }

  function assertCapacity(operator, bytes) {
    const usage = db.mediaAssetUsage();
    if (Number(usage.active_count) >= limits.maxActive) {
      throw new MediaUploadError(409, `คลังรูปเต็ม (${limits.maxActive} รูป) — ต้อง archive รูปเก่าก่อน`, "media_count_limit");
    }
    if (Number(usage.total_bytes) + bytes > limits.maxTotalBytes) {
      throw new MediaUploadError(413, "พื้นที่คลังรูปถึงเพดานแล้ว", "media_storage_limit");
    }
    if (db.mediaUploadsByOperatorSince(operator, now() - 3_600_000) >= limits.perOperatorHour) {
      throw new MediaUploadError(429, `อัปโหลดได้ไม่เกิน ${limits.perOperatorHour} รูปต่อชั่วโมง`, "media_rate_limit");
    }
  }

  function ensureDirectory() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new MediaUploadError(503, "MEDIA_DIR ต้องเป็น directory จริง (ห้าม symlink)", "unsafe_media_dir");
    }
  }

  function save({ buffer, contentType, label, createdBy }) {
    if (!uploadEnabled) throw new MediaUploadError(503, status().reason || "media upload ปิดอยู่", "media_upload_disabled");
    const inspected = inspectBroadcastImage(buffer, contentType, config);
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const duplicate = db.getMediaAssetBySha(sha256);
    if (duplicate) {
      if (duplicate.status !== "active") {
        throw new MediaUploadError(409, "รูปนี้เคยถูก archive ไว้แล้ว", "media_archived_duplicate");
      }
      return { media: catalogEntry(duplicate, baseUrl), deduplicated: true };
    }
    assertCapacity(createdBy, buffer.length);
    ensureDirectory();

    const id = uuid();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new MediaUploadError(500, "สร้าง media id ไม่สำเร็จ", "invalid_generated_uuid");
    }
    const filename = `${id}.${inspected.ext}`;
    const assetKey = `upload_${id.replaceAll("-", "")}`;
    const tempPath = join(dir, `.tmp-${id}`);
    const finalPath = join(dir, filename);
    let fd = null;
    let linked = false;
    try {
      fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      let written = 0;
      while (written < buffer.length) {
        const count = writeSync(fd, buffer, written, buffer.length - written, written);
        if (count < 1) throw new Error("เขียน media file ไม่ครบ");
        written += count;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      // hard-link แบบ no-clobber: ถ้า UUID ชนไฟล์เดิมจะ fail แทนการ overwrite
      linkSync(tempPath, finalPath);
      linked = true;
      unlinkSync(tempPath);
      const row = db.createMediaAsset({
        id, assetKey, filename, label: cleanLabel(label), mime: inspected.mime,
        byteSize: buffer.length, width: inspected.width, height: inspected.height,
        sha256, createdBy,
      });
      return { media: catalogEntry(row, baseUrl), deduplicated: false };
    } catch (err) {
      if (fd !== null) try { closeSync(fd); } catch { /* no-op */ }
      if (existsSync(tempPath)) try { unlinkSync(tempPath); } catch { /* no-op */ }
      if (linked && existsSync(finalPath)) try { unlinkSync(finalPath); } catch { /* no-op */ }
      if (err instanceof MediaUploadError) throw err;
      logger.warn?.(`broadcast media: บันทึกไฟล์ไม่สำเร็จ (${err?.message || err})`);
      throw new MediaUploadError(500, "บันทึกรูปไม่สำเร็จ", "media_write_failed");
    }
  }

  function openPublic(pathname) {
    if (!configured) return null;
    const match = String(pathname || "").match(/^\/media\/([0-9a-f-]{36}\.(?:jpg|png))$/i);
    if (!match) return null;
    const row = db.getMediaAssetByFilename(match[1]);
    if (!row || row.status !== "active") return null;
    const path = join(dir, row.filename);
    let fd;
    try {
      const lst = lstatSync(path);
      if (!lst.isFile() || lst.isSymbolicLink() || lst.size !== row.byte_size) return null;
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const st = fstatSync(fd);
      if (!st.isFile() || st.size !== row.byte_size) {
        closeSync(fd);
        return null;
      }
      return {
        row,
        etag: `"${row.sha256}"`,
        stream: createReadStream(path, { fd, autoClose: true }),
      };
    } catch {
      if (fd !== undefined) try { closeSync(fd); } catch { /* no-op */ }
      return null;
    }
  }

  return { status, list, getByKey, save, openPublic };
}
