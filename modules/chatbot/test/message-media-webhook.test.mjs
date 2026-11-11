// Signed LINE media ingress contract. Every network boundary is injected; this
// test never contacts LINE or any external service.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { createPrivateMediaStore } from "../src/messageMedia.mjs";
import { hermesFetchStub, httpRequest, listen, memoryDb, poisonGlobalFetch, signLine, testConfig, waitFor } from "./helpers.mjs";

poisonGlobalFetch();

const SECRET = "test-line-secret";
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function mediaWebhook(messageId, { userId = "U-media-webhook", type = "image" } = {}) {
  return JSON.stringify({
    events: [{
      type: "message",
      webhookEventId: `event-${messageId}`,
      replyToken: `reply-${messageId}`,
      source: { type: "user", userId },
      message: { id: messageId, type, contentProvider: { type: "line" } },
    }],
  });
}

function postWebhook(server, raw) {
  return httpRequest(server, {
    method: "POST",
    path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, SECRET) },
    body: raw,
  });
}

function tempMediaDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-webhook-media-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("signed webhook persists metadata, fetches exact LINE content, and stores private bytes", async (t) => {
  const dir = tempMediaDir(t);
  const db = memoryDb();
  const contentCalls = [];
  const lineFetch = async (url) => {
    const target = String(url);
    if (target.includes("api-data.line.me/v2/bot/message/")) {
      contentCalls.push(target);
      return new Response(PNG_1X1, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG_1X1.length) } });
    }
    if (target.includes("/v2/bot/profile/")) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const config = testConfig({
    LINE_MOCK_URL: "",
    LINE_LIVE_SEND: "true",
    LINE_CHANNEL_ACCESS_TOKEN: "test-access-token",
    MESSAGE_MEDIA_ENABLED: "true",
    INBOUND_LINE_CONTENT_CAPTURE: "true",
    MESSAGE_MEDIA_DIR: dir,
    MESSAGE_MEDIA_MIN_FREE_BYTES: "104857600",
  });
  const app = createApp({ config, db, overrides: { lineFetch, hermesFetch: hermesFetchStub("x"), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const raw = mediaWebhook("media-content-1");
  const response = await postWebhook(app.server, raw);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.accepted, 1);
  const attachment = await waitFor(() => db.listMessageAttachmentsForCustomer("U-media-webhook").find((row) => row.status === "ready"));
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.mime, "image/png");
  assert.equal(attachment.byte_size, PNG_1X1.length);
  assert.equal(contentCalls.length, 1);
  const store = createPrivateMediaStore({ dir, minFreeBytes: 0 });
  const opened = store.open(attachment.storage_key);
  assert.equal(opened.stat.size, PNG_1X1.length);
  opened.close();
});

test("attachment persistence failure rolls back dedupe so the same LINE redelivery succeeds", async (t) => {
  const db = memoryDb();
  const config = testConfig({ MESSAGE_MEDIA_ENABLED: "true", INBOUND_LINE_CONTENT_CAPTURE: "false" });
  const app = createApp({ config, db, overrides: { hermesFetch: hermesFetchStub("x"), lineFetch: async () => new Response("{}", { status: 200 }), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const originalAddAttachment = db.addMessageAttachment.bind(db);
  db.addMessageAttachment = () => { throw new Error("forced attachment persistence failure"); };
  const raw = mediaWebhook("media-rollback-1", { userId: "U-media-rollback" });
  const failed = await postWebhook(app.server, raw);
  assert.equal(failed.status, 500, failed.text);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM events_dedupe WHERE message_id=?").get("media-rollback-1").n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id=?").get("U-media-rollback").n, 0);

  db.addMessageAttachment = originalAddAttachment;
  const retried = await postWebhook(app.server, raw);
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.json.accepted, 1);
  // นับเฉพาะแถวขาเข้า — F6 (ก.ย. 2026) ห้องที่ยังไม่มีเรื่องเงินได้ข้อความตอบรับรูปเป็นแถวขาออกเพิ่ม
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id=? AND direction='in'").get("U-media-rollback").n, 1);
  assert.equal(db.listMessageAttachmentsForCustomer("U-media-rollback").length, 1);
});

test("signed inbound media cap keeps the message and records an honest unavailable state", async (t) => {
  const db = memoryDb();
  db.upsertCustomer("U-existing-media", {});
  db.addMessageAttachment({ customerId: "U-existing-media", direction: "in", source: "line", kind: "image", status: "unavailable" });
  const config = testConfig({ MESSAGE_MEDIA_ENABLED: "true", INBOUND_LINE_CONTENT_CAPTURE: "false", MESSAGE_MEDIA_MAX_ACTIVE: "1" });
  const app = createApp({ config, db, overrides: { hermesFetch: hermesFetchStub("x"), lineFetch: async () => new Response("{}", { status: 200 }), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const raw = mediaWebhook("media-cap-1", { userId: "U-media-cap" });
  const response = await postWebhook(app.server, raw);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.accepted, 1);
  assert.equal(db.listMessageAttachmentsForCustomer("U-media-cap").length, 0, "cap must bound attachment rows and retries");
  const stored = db.raw.prepare("SELECT metadata_json FROM messages WHERE customer_id=?").get("U-media-cap");
  const metadata = JSON.parse(stored.metadata_json);
  assert.equal(metadata.mediaAttachmentSkipped, true);
  assert.equal(metadata.mediaUnavailableReason, "คลังสื่อถึงเพดาน");
});

test("signed inbound sticker keeps bounded keywords and text for custom-sticker fallback", async (t) => {
  const db = memoryDb();
  const config = testConfig({ MESSAGE_MEDIA_ENABLED: "false", INBOUND_LINE_CONTENT_CAPTURE: "false" });
  const app = createApp({ config, db, overrides: { hermesFetch: hermesFetchStub("x"), lineFetch: async () => new Response("{}", { status: 200 }), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const raw = JSON.stringify({ events: [{
    type: "message", webhookEventId: "event-sticker-meta", replyToken: "reply-sticker-meta",
    source: { type: "user", userId: "U-sticker-meta" },
    message: {
      id: "sticker-meta-1", type: "sticker", packageId: "999", stickerId: "628569911308583033",
      stickerResourceType: "STATIC", keywords: ["ขอบคุณ", "ดีใจ", ...Array.from({ length: 20 }, (_, i) => `k${i}`)], text: "ข้อความอธิบาย",
    },
  }] });
  const response = await postWebhook(app.server, raw);
  assert.equal(response.status, 200, response.text);
  const attachment = db.listMessageAttachmentsForCustomer("U-sticker-meta")[0];
  const meta = JSON.parse(attachment.provider_meta_json);
  assert.deepEqual(meta.keywords.slice(0, 2), ["ขอบคุณ", "ดีใจ"]);
  assert.equal(meta.keywords.length, 15);
  assert.equal(meta.text, "ข้อความอธิบาย");
});
