import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createLineClient } from "../src/lineClient.mjs";
import { createConfig } from "../src/config.mjs";
import { attachmentContentDisposition, createPrivateMediaStore, hasPrivateMediaCapacity, normalizeHttpsOrigin } from "../src/messageMedia.mjs";

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function crc32(buffer) { let crc = 0xffffffff; for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const name = Buffer.from(type, "ascii"); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, checksum]); }
function pngWithDimensions(width, height) { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0]))), pngChunk("IEND", Buffer.alloc(0))]); }
function tempStore(t, options = {}) { const dir = mkdtempSync(join(tmpdir(), "lukprae-media-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return createPrivateMediaStore({ dir, minFreeBytes: 0, ...options }); }

function streamResponse(chunks, { length = null } = {}) {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
    cancel() { cancelled = true; },
  });
  return {
    response: new Response(stream, { status: 200, headers: length == null ? {} : { "content-length": String(length), "content-type": "application/pdf" } }),
    cancelled: () => cancelled,
  };
}

test("LINE content rejects declared oversized body before reading", async () => {
  const fake = streamResponse([new Uint8Array([1])], { length: 99 });
  const client = createLineClient({ config: { lineMockUrl: "", lineLiveSend: true, lineChannelAccessToken: "x", lineTimeoutMs: 1000 }, fetchImpl: async () => fake.response });
  const result = await client.getMessageContent("valid-id", { maxBytes: 10 });
  assert.equal(result.reason, "content_too_large");
});

test("LINE content cancels chunked response once hard limit is crossed", async () => {
  const fake = streamResponse([new Uint8Array(8), new Uint8Array(8)]);
  const client = createLineClient({ config: { lineMockUrl: "", lineLiveSend: true, lineChannelAccessToken: "x", lineTimeoutMs: 1000 }, fetchImpl: async () => fake.response });
  const result = await client.getMessageContent("valid-id", { maxBytes: 10 });
  assert.equal(result.reason, "content_too_large");
});

test("LINE content accepts a bounded chunked response without Content-Length", async () => {
  const fake = streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])]);
  const client = createLineClient({ config: { lineMockUrl: "", lineLiveSend: true, lineChannelAccessToken: "x", lineTimeoutMs: 1000 }, fetchImpl: async () => fake.response });
  const result = await client.getMessageContent("valid-id", { maxBytes: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.bytes], [1, 2, 3]);
});

test("private media safely stores opaque inbound bytes but rejects opaque operator bytes", (t) => {
  const store = tempStore(t);
  const saved = store.save({ buffer: Buffer.from([0x01, 0x02, 0x03]), mime: "application/octet-stream", name: "legacy.dat", origin: "line" });
  assert.match(saved.storageKey, /^[a-f0-9-]{36}\.bin$/);
  assert.equal(saved.opaque, true);
  const opened = store.open(saved.storageKey);
  assert.equal(opened.stat.size, 3);
  opened.close();
  assert.equal(store.remove(saved.storageKey), true);
  assert.equal(store.remove(saved.storageKey), false);
  assert.throws(() => store.save({ buffer: Buffer.from([1, 2, 3]), name: "run.exe", origin: "operator" }), /unsupported/);
  assert.throws(() => store.save({ buffer: Buffer.from([1, 2, 3]), name: "unknown.bin", origin: "operator" }), /unsupported/);
});

test("LINE document kind stays attachment-only even when its bytes are playable media", (t) => {
  const store = tempStore(t);
  const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const saved = store.save({ buffer: mp4, name: "clip.mp4", kind: "file", origin: "line" });
  assert.equal(saved.kind, "file");
  assert.equal(saved.mime, "video/mp4");
});

test("content disposition supports Thai names without unsafe header bytes", () => {
  const header = attachmentContentDisposition('ใบเสนอราคา "ลูกค้า".pdf');
  assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/u);
  assert.doesNotMatch(header, /[\r\n]/u);
  assert.match(header, /%E0%B9%83/u);
});

test("private media validates image dimensions before storage", (t) => {
  const store = tempStore(t, { imageMaxBytes: 10 * 1024 * 1024, imageMaxWidth: 8192, imageMaxHeight: 8192, imageMaxPixels: 20_000_000 });
  assert.throws(() => store.save({ buffer: pngWithDimensions(9000, 9000), mime: "image/png", name: "bomb.png", origin: "line" }), /invalid private image/);
  const ok = store.save({ buffer: PNG_1X1, mime: "image/png", name: "ok.png", origin: "line" });
  assert.equal(ok.kind, "image");
});

test("operator file allowlist requires matching safe bytes", (t) => {
  const store = tempStore(t);
  assert.equal(store.save({ buffer: Buffer.from("%PDF-1.4\n"), name: "invoice.pdf", origin: "operator" }).kind, "file");
  assert.equal(store.save({ buffer: Buffer.from('{"ok":true}'), name: "data.json", origin: "operator" }).mime, "application/json");
  assert.equal(store.save({ buffer: Buffer.from("PK\x03\x04"), name: "slides.pptx", origin: "operator" }).kind, "file");
  assert.throws(() => store.save({ buffer: Buffer.from("<svg></svg>"), name: "bad.svg", origin: "operator" }), /unsupported/);
  assert.throws(() => store.save({ buffer: Buffer.from("<script>x</script>"), name: "notes.txt", origin: "operator" }), /unsupported/);
});

test("private media refuses symlink roots and low disk reserve", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "lukprae-media-root-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const real = join(parent, "real"); const link = join(parent, "link");
  // mkdir is performed by the real store first, then the symlink target exists.
  const realStore = createPrivateMediaStore({ dir: real, minFreeBytes: 0 }); realStore.ensureRoot(); symlinkSync(real, link);
  const symlinkStore = createPrivateMediaStore({ dir: link, minFreeBytes: 0 });
  assert.throws(() => symlinkStore.save({ buffer: PNG_1X1, name: "x.png", origin: "line" }), /real directory/);
  const constrained = tempStore(t, { statfs: () => ({ bavail: 1, bsize: 1 }), minFreeBytes: 100 });
  assert.throws(() => constrained.save({ buffer: PNG_1X1, name: "x.png", origin: "line" }), /disk space/);
  assert.equal(hasPrivateMediaCapacity("/unused", 1, 1, () => ({ bavail: 2, bsize: 1 })), true);
});

test("outbound public origin is a strict HTTPS origin and config clamps media ceilings", () => {
  assert.equal(normalizeHttpsOrigin("https://files.example.test"), "https://files.example.test");
  for (const bad of ["http://files.example.test", "https://u:p@files.example.test", "https://files.example.test/x", "https://files.example.test:8443", "https://files.example.test/?x=1"]) assert.equal(normalizeHttpsOrigin(bad), "");
  const config = createConfig({ OUTBOUND_FILE_PUBLIC_BASE_URL: "https://files.example.test/", MESSAGE_MEDIA_MAX_BYTES: String(999 * 1024 * 1024), MESSAGE_MEDIA_IMAGE_MAX_BYTES: "1", OUTBOUND_IMAGE_LINK_TTL_MS: String(99 * 60 * 1000), OUTBOUND_FILE_LINK_TTL_MS: String(99 * 60 * 60 * 1000) });
  assert.equal(config.outboundFilePublicBaseUrl, "https://files.example.test");
  assert.equal(config.messageMediaMaxBytes, 128 * 1024 * 1024);
  assert.equal(config.messageMediaImageMaxBytes, 1 * 1024 * 1024);
  // 2026-08-27: เดิมล็อกไว้ 15 นาที/24 ชม. ตามสมมติฐานว่า LINE ดึงรูปครั้งเดียวแล้วจบ
  // ของจริงเครื่องลูกค้าดึงซ้ำเมื่อเลื่อนดูแชทเก่า รูปจึงพังเป็นกรอบดำภายในวันเดียว
  // ตอนนี้ยาว 10 ปีทั้งคู่ (ดูเหตุผลเต็มใน config.mjs) แต่ยังต้องเป็นค่าจำกัดเสมอ
  // เพราะกลไกเพิกถอนตาม PDPA พึ่งคอลัมน์ expires_at
  const TEN_YEARS = 10 * 365 * 24 * 60 * 60 * 1000;
  // ค่าที่ต่ำกว่าเพดานผ่านมาได้ตามที่ตั้ง (99 นาที / 99 ชม.) — เดิมถูกกดลงเหลือ 15 นาที
  assert.equal(config.outboundImageLinkTtlMs, 99 * 60 * 1000);
  assert.equal(config.outboundFileLinkTtlMs, 99 * 60 * 60 * 1000);
  // เกินเพดานต้องถูกกดลง และต้องเป็นค่าจำกัดเสมอ ห้ามกลายเป็นไม่มีวันหมดอายุ
  const over = createConfig({ OUTBOUND_IMAGE_LINK_TTL_MS: String(TEN_YEARS * 5), OUTBOUND_FILE_LINK_TTL_MS: String(TEN_YEARS * 5) });
  assert.equal(over.outboundImageLinkTtlMs, TEN_YEARS);
  assert.equal(over.outboundFileLinkTtlMs, TEN_YEARS);
  assert.ok(Number.isFinite(over.outboundImageLinkTtlMs), "ห้ามเป็น Infinity");
  // ไม่ตั้ง env = ได้ค่ายาวเป็นปีโดยอัตโนมัติ (นี่คือค่าที่ production ใช้จริง)
  const fallback = createConfig({});
  assert.equal(fallback.outboundImageLinkTtlMs, TEN_YEARS);
  assert.equal(config.messageMediaMaxConcurrentUploads, 4);
  assert.equal(config.messageMediaMaxConcurrentPerOperator, 2);
});
