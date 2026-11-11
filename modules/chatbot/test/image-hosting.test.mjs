// เส้นทาง /img/ self-host — เกิดจากเคสจริง Airdog: เว็บต้นทางบล็อก LINE fetcher ทั้ง 37 URL
// หมายเหตุ: httpRequest ใน helpers ถอด body เป็น utf8 — เทสต์ body ใช้เนื้อไฟล์ ASCII ล้วน
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, httpRequest, listen } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };

// สร้าง + listen + ปิดอัตโนมัติแม้เทสต์ fail — pattern เดียวกับ server.test.mjs
async function startServer(t, configOverrides = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  const app = createApp({ config, db, overrides: { sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return app;
}

const FAKE_JPG = "fake-jpeg-bytes-ascii-only";
const FAKE_PNG = "fake-png-bytes-ascii-only";

function writeManifest(dir, files) {
  const path = join(dir, "source-manifest.json");
  writeFileSync(path, JSON.stringify({ schema: "pngoung-chat-media-source-v1", assets: files }));
  return path;
}

function manifestEntry(file, mime, content) {
  return {
    file,
    mime,
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

test("img hosting: เสิร์ฟ jpg พร้อม cache header แบบ public", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "x3pro_sku_1.jpg"), FAKE_JPG);

  const app = await startServer(t, { IMAGE_DIR: dir });
  const res = await httpRequest(app.server, { path: "/img/x3pro_sku_1.jpg" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.ok(String(res.headers["cache-control"]).includes("public"), "รูปต้อง cache ได้ (ไม่ใช่ no-store)");
  assert.equal(Number(res.headers["content-length"]), FAKE_JPG.length);
  assert.equal(res.text, FAKE_JPG);
});

test("img hosting: เสิร์ฟ png ด้วย MIME ที่ตรง และ HEAD ไม่ส่ง body", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "ai-agent-course.png"), FAKE_PNG);

  const app = await startServer(t, { IMAGE_DIR: dir });
  const get = await httpRequest(app.server, { path: "/img/ai-agent-course.png" });
  assert.equal(get.status, 200);
  assert.equal(get.headers["content-type"], "image/png");
  assert.equal(Number(get.headers["content-length"]), FAKE_PNG.length);
  assert.equal(get.text, FAKE_PNG);

  const head = await httpRequest(app.server, { method: "HEAD", path: "/img/ai-agent-course.png" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "image/png");
  assert.equal(Number(head.headers["content-length"]), FAKE_PNG.length);
  assert.equal(head.text, "");
});

test("img hosting: ไฟล์ที่ไม่รู้จัก -> 404", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const app = await startServer(t, { IMAGE_DIR: dir });
  const res = await httpRequest(app.server, { path: "/img/unknown.jpg" });
  assert.equal(res.status, 404);
});

test("img hosting: กัน traversal / ตัวพิมพ์ใหญ่ / นามสกุลอื่น -> 404 ทั้งหมด", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "x3pro_sku_1.jpg"), FAKE_JPG);

  const app = await startServer(t, { IMAGE_DIR: dir });
  for (const bad of ["/img/../dev.env", "/img/..%2Fdev.env", "/img/a.webp", "/img/UPPER.jpg"]) {
    const res = await httpRequest(app.server, { path: bad });
    assert.equal(res.status, 404, `ต้องปฏิเสธ ${bad}`);
  }
});

test("img hosting: ปฏิเสธ symlink และไฟล์ใหญ่เกินเพดาน LINE 10 MB", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  const outside = join(tmpdir(), `afl-img-outside-${process.pid}-${Date.now()}.jpg`);
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { force: true }); });
  writeFileSync(outside, FAKE_JPG);
  symlinkSync(outside, join(dir, "linked.jpg"));
  writeFileSync(join(dir, "oversized.png"), Buffer.alloc(10 * 1024 * 1024 + 1));

  const app = await startServer(t, { IMAGE_DIR: dir });
  assert.equal((await httpRequest(app.server, { path: "/img/linked.jpg" })).status, 404);
  assert.equal((await httpRequest(app.server, { path: "/img/oversized.png" })).status, 404);
});

test("img hosting: ไม่ตั้ง IMAGE_DIR = ปิดฟีเจอร์ทั้งเส้นทาง", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "x3pro_sku_1.jpg"), FAKE_JPG);

  const app = await startServer(t); // ไม่มี IMAGE_DIR
  const res = await httpRequest(app.server, { path: "/img/x3pro_sku_1.jpg" });
  assert.equal(res.status, 404, "ไม่ตั้ง IMAGE_DIR = ปิดฟีเจอร์");
});

test("img hosting: configured manifest serves only pinned names and supports ETag", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "approved.png"), FAKE_PNG);
  writeFileSync(join(dir, "approved-preview.jpg"), FAKE_JPG);
  writeFileSync(join(dir, "unknown.png"), FAKE_PNG);
  const manifest = writeManifest(dir, [{
    original: manifestEntry("approved.png", "image/png", FAKE_PNG),
    preview: manifestEntry("approved-preview.jpg", "image/jpeg", FAKE_JPG),
  }]);

  const app = await startServer(t, { IMAGE_DIR: dir, IMAGE_HOSTING_MANIFEST_FILE: manifest });
  const first = await httpRequest(app.server, { path: "/img/approved.png" });
  assert.equal(first.status, 200);
  assert.match(String(first.headers.etag), /^"sha256-[a-f0-9]{64}"$/u);
  assert.match(String(first.headers["cache-control"]), /immutable/u);
  assert.equal((await httpRequest(app.server, { path: "/img/unknown.png" })).status, 404);
  const cached = await httpRequest(app.server, {
    path: "/img/approved.png",
    headers: { "if-none-match": first.headers.etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, "");
});

test("img hosting: configured manifest serves its verified startup snapshot after in-place drift", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "approved.png"), FAKE_PNG);
  writeFileSync(join(dir, "approved-preview.jpg"), FAKE_JPG);
  const manifest = writeManifest(dir, [{
    original: manifestEntry("approved.png", "image/png", FAKE_PNG),
    preview: manifestEntry("approved-preview.jpg", "image/jpeg", FAKE_JPG),
  }]);
  const app = await startServer(t, { IMAGE_DIR: dir, IMAGE_HOSTING_MANIFEST_FILE: manifest });
  writeFileSync(join(dir, "approved.png"), "x".repeat(Buffer.byteLength(FAKE_PNG)));
  const response = await httpRequest(app.server, { path: "/img/approved.png" });
  assert.equal(response.status, 200);
  assert.equal(response.text, FAKE_PNG);
});

test("img hosting: configured manifest fails closed on byte/hash drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  const db = memoryDb();
  try {
    writeFileSync(join(dir, "approved.png"), FAKE_PNG);
    writeFileSync(join(dir, "approved-preview.jpg"), FAKE_JPG);
    const original = manifestEntry("approved.png", "image/png", FAKE_PNG);
    original.sha256 = "0".repeat(64);
    const manifest = writeManifest(dir, [{
      original,
      preview: manifestEntry("approved-preview.jpg", "image/jpeg", FAKE_JPG),
    }]);
    assert.throws(() => createApp({
      config: testConfig({ IMAGE_DIR: dir, IMAGE_HOSTING_MANIFEST_FILE: manifest }),
      db,
      overrides: { sleep: async () => {} },
      logger: silent,
    }), /manifest drift detected/u);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("img hosting: configured manifest rejects oversized drift before serving", () => {
  const dir = mkdtempSync(join(tmpdir(), "afl-img-"));
  const db = memoryDb();
  try {
    writeFileSync(join(dir, "approved.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
    writeFileSync(join(dir, "approved-preview.jpg"), FAKE_JPG);
    const manifest = writeManifest(dir, [{
      original: manifestEntry("approved.png", "image/png", FAKE_PNG),
      preview: manifestEntry("approved-preview.jpg", "image/jpeg", FAKE_JPG),
    }]);
    assert.throws(() => createApp({
      config: testConfig({ IMAGE_DIR: dir, IMAGE_HOSTING_MANIFEST_FILE: manifest }),
      db,
      overrides: { sleep: async () => {} },
      logger: silent,
    }), /size is unsafe or drifted/u);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
