// broadcast-media.test.mjs — operator upload + immutable public serving (scratch only)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { inspectBroadcastImage } from "../src/broadcastMedia.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);
// รูป PNG 1x1 จริง (ไม่แตะ network)
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_WITHOUT_IDAT = Buffer.concat([PNG_1X1.subarray(0, 33), PNG_1X1.subarray(56)]);
const JPEG_SOF_WITHOUT_SOS = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

const PNG_EMPTY_SCANLINES = Buffer.concat([
  PNG_1X1.subarray(0, 33),
  pngChunk("IDAT", deflateSync(Buffer.alloc(0))),
  PNG_1X1.subarray(56),
]);

async function startMediaConsole(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "afl-media-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = testConfig({
    CONSOLE_SESSION_SECRET: CONSOLE_SECRET,
    MEDIA_UPLOAD_ENABLED: "true",
    MEDIA_DIR: dir,
    MEDIA_PUBLIC_BASE_URL: "https://media.example.test",
    ...overrides,
  });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, dir };
}

async function login(server) {
  const response = await httpRequest(server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: PASSWORD }),
  });
  assert.equal(response.status, 200, response.text);
  return {
    cookie: (response.headers["set-cookie"]?.[0] || "").split(";")[0],
    csrf: response.json.csrf,
  };
}

function upload(server, { cookie, csrf, body = PNG_1X1, type = "image/png", size = body.length } = {}) {
  return httpRequest(server, {
    method: "POST",
    path: "/console/api/broadcast/media?label=%E0%B9%82%E0%B8%9B%E0%B8%A3%E0%B8%AA%E0%B8%B4%E0%B8%99%E0%B8%84%E0%B9%89%E0%B8%B2.png",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      "x-media-size": String(size),
      "content-length": String(body.length),
      "content-type": type,
    },
    body,
  });
}

test("media validation: PNG จริงผ่าน; MIME/CRC/trailing payload/เกิน 1 MB ถูกปฏิเสธ", () => {
  const inspected = inspectBroadcastImage(PNG_1X1, "image/png");
  assert.deepEqual({ mime: inspected.mime, width: inspected.width, height: inspected.height },
    { mime: "image/png", width: 1, height: 1 });
  assert.throws(() => inspectBroadcastImage(PNG_1X1, "image/jpeg"), /magic bytes/);
  const badCrc = Buffer.from(PNG_1X1);
  badCrc[42] ^= 1;
  assert.throws(() => inspectBroadcastImage(badCrc, "image/png"), /checksum/);
  assert.throws(() => inspectBroadcastImage(PNG_WITHOUT_IDAT, "image/png"), /IDAT/);
  assert.throws(() => inspectBroadcastImage(PNG_EMPTY_SCANLINES, "image/png"), /scanline|IDAT/);
  assert.throws(() => inspectBroadcastImage(JPEG_SOF_WITHOUT_SOS, "image/jpeg"), /SOS/);
  assert.throws(() => inspectBroadcastImage(Buffer.concat([PNG_1X1, Buffer.from("<script>")]), "image/png"), /ต่อท้าย/);
  assert.throws(() => inspectBroadcastImage(Buffer.alloc(1_000_001), "image/png"), /ไม่เกิน/);
});

test("media upload: client ตัด connection กลาง body ไม่ค้าง handler และ request ถัดไปยังทำงาน", async (t) => {
  const { app } = await startMediaConsole(t);
  const auth = await login(app.server);
  const { port } = app.server.address();
  await new Promise((resolve) => {
    const req = httpClientRequest({
      host: "127.0.0.1", port, method: "POST",
      path: "/console/api/broadcast/media?label=aborted.png",
      headers: {
        cookie: auth.cookie,
        "x-csrf-token": auth.csrf,
        "x-media-size": String(PNG_1X1.length),
        "content-length": String(PNG_1X1.length),
        "content-type": "image/png",
      },
    });
    req.on("error", resolve);
    req.on("socket", (socket) => {
      const cutMidBody = () => {
        req.write(PNG_1X1.subarray(0, 12));
        setImmediate(() => req.destroy());
      };
      if (socket.connecting) socket.once("connect", cutMidBody);
      else cutMidBody();
    });
    req.flushHeaders();
    setTimeout(resolve, 50).unref?.();
  });
  const healthy = await httpRequest(app.server, { path: "/health" });
  assert.equal(healthy.status, 200);
  assert.equal((await upload(app.server, auth)).status, 201);
});

test("media upload: session+CSRF บังคับ และ feature flag ปิด = 503", async (t) => {
  const { app } = await startMediaConsole(t, { MEDIA_UPLOAD_ENABLED: "false" });
  const unauth = await upload(app.server, {});
  assert.equal(unauth.status, 401);
  const auth = await login(app.server);
  const noCsrf = await upload(app.server, { cookie: auth.cookie });
  assert.equal(noCsrf.status, 403);
  const disabled = await upload(app.server, auth);
  assert.equal(disabled.status, 503);
});

test("media upload: บันทึก allowlist แล้วเห็นใน broadcast meta ทันที + public stream/ETag", async (t) => {
  const { app, db, dir } = await startMediaConsole(t);
  const auth = await login(app.server);
  const uploaded = await upload(app.server, auth);
  assert.equal(uploaded.status, 201, uploaded.text);
  assert.equal(uploaded.json.media.label, "โปรสินค้า.png");
  assert.equal(uploaded.json.media.width, 1);
  assert.match(uploaded.json.media.key, /^upload_[0-9a-f]{32}$/);
  assert.match(uploaded.json.media.url, /^https:\/\/media\.example\.test\/media\//);

  const rows = db.listMediaAssets({ status: "active" });
  assert.equal(rows.length, 1);
  assert.deepEqual(readFileSync(join(dir, rows[0].filename)), PNG_1X1);
  assert.ok(db.listAudit().some((row) => row.action === "broadcast_media_upload"));

  const meta = await httpRequest(app.server, {
    path: "/console/api/broadcast/meta?channel=default", headers: { cookie: auth.cookie },
  });
  assert.equal(meta.status, 200);
  assert.equal(meta.json.mediaUpload.enabled, true);
  assert.ok(meta.json.images.some((image) => image.key === uploaded.json.media.key && image.uploaded === true));

  const publicImage = await httpRequest(app.server, { path: uploaded.json.media.consoleUrl });
  assert.equal(publicImage.status, 200);
  assert.equal(publicImage.headers["content-type"], "image/png");
  assert.deepEqual(publicImage.buffer, PNG_1X1);
  assert.match(publicImage.headers["cache-control"], /immutable/);
  assert.equal(publicImage.headers["x-content-type-options"], "nosniff");
  const cached = await httpRequest(app.server, {
    path: uploaded.json.media.consoleUrl,
    headers: { "if-none-match": publicImage.headers.etag },
  });
  assert.equal(cached.status, 304);
});

test("media upload: SHA ซ้ำ dedupe และขนาด/header/MIME ปลอมไม่ทิ้งแถวเพิ่ม", async (t) => {
  const { app, db } = await startMediaConsole(t);
  const auth = await login(app.server);
  assert.equal((await upload(app.server, auth)).status, 201);
  const duplicate = await upload(app.server, auth);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.json.deduplicated, true);
  assert.equal(db.listMediaAssets({ status: "active" }).length, 1);

  const wrongSize = await upload(app.server, { ...auth, size: PNG_1X1.length + 1 });
  assert.equal(wrongSize.status, 400);
  const fake = await upload(app.server, { ...auth, body: Buffer.from("<svg></svg>"), type: "image/png" });
  assert.equal(fake.status, 415);
  assert.equal(db.listMediaAssets({ status: "active" }).length, 1);
});

test("media upload: บังคับ Content-Length และนับ attempt ไฟล์เสียก่อน parse", async (t) => {
  const { app } = await startMediaConsole(t);
  const auth = await login(app.server);
  const missingLength = await httpRequest(app.server, {
    method: "POST", path: "/console/api/broadcast/media?label=chunked.png",
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
      "x-media-size": String(PNG_1X1.length),
      "content-type": "image/png",
    },
    body: PNG_1X1,
  });
  assert.equal(missingLength.status, 411);

  for (let attempt = 1; attempt < 20; attempt += 1) {
    const invalid = await upload(app.server, {
      ...auth, body: Buffer.from("not-a-png"), type: "image/png",
    });
    assert.equal(invalid.status, 415, `attempt ${attempt}`);
  }
  assert.equal((await upload(app.server, auth)).status, 429);
});
