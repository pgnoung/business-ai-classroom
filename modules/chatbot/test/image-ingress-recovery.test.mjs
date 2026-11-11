// Regression coverage for the image ingress handoff.  These tests use a signed
// Facebook webhook and injected network stubs only; no customer data or model
// provider is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { createInboundImageClassifier } from "../src/inboundImageClassifier.mjs";
import { IMAGE_ACK_TEMPLATE } from "../src/pipeline.mjs";
import { createPrivateMediaStore } from "../src/messageMedia.mjs";
import { httpRequest, listen, memoryDb, poisonGlobalFetch, testConfig, waitFor } from "./helpers.mjs";

poisonGlobalFetch();

const APP_SECRET = "image-ingress-app-secret";
// Shared, validator-approved one-pixel PNG fixture.  Do not replace with a
// merely decodable base64 string: the private-media store validates PNG CRC.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function sign(raw) {
  return `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
}

function fbImageEvent({ psid = "psid-image", mid = "mid-image", attachment } = {}) {
  return {
    object: "page",
    entry: [{ messaging: [{
      sender: { id: psid }, recipient: { id: "page" }, timestamp: 1,
      message: { mid, attachments: [attachment ?? { type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/t1.15752-9/test.png" } }] },
    }] }],
  };
}

async function postSignedFacebook(server, payload) {
  const raw = JSON.stringify(payload);
  return httpRequest(server, {
    method: "POST", path: "/webhooks/facebook",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) }, body: raw,
  });
}

function temporaryDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-image-ingress-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFacebookApp(t, { capture = true, liveSend = false, fetchMedia = async () => new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) } }) } = {}) {
  const mediaDir = temporaryDir(t);
  const db = memoryDb();
  const mediaCalls = [];
  const classificationRequests = [];
  const config = testConfig({
    FB_ENABLED: "true", FB_APP_SECRET: APP_SECRET, FB_PAGE_ACCESS_TOKEN: "test-page-token",
    ...(liveSend ? { FB_LIVE_SEND: "true" } : {}),
    MESSAGE_MEDIA_ENABLED: capture ? "true" : "false",
    INBOUND_LINE_CONTENT_CAPTURE: capture ? "true" : "false",
    MESSAGE_MEDIA_DIR: mediaDir,
    IMAGE_CLASSIFY_ENABLED: "true",
    IMAGE_CLASSIFY_WAIT_MS: "500",
    MESSAGE_MEDIA_INGEST_INTERVAL_MS: "60000",
  });
  const sends = [];
  const lineFetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://scontent.")) {
      mediaCalls.push(target);
      return fetchMedia(target);
    }
    // F6 (ก.ย. 2026): ห้องที่ยังไม่มีเรื่องเงินได้ข้อความตอบรับรูป — ขาส่ง Messenger ตอบสำเร็จแบบ stub
    if (/\/me\/messages\?/u.test(target)) {
      sends.push(JSON.parse(options.body || "{}"));
      return new Response(JSON.stringify({ recipient_id: "psid", message_id: `mid.out.${sends.length}` }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected provider request: ${target}`);
  };
  const hermesFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const imageRequest = body.messages?.some((message) => Array.isArray(message.content)
      && message.content.some((part) => part?.type === "image_url"));
    if (imageRequest) classificationRequests.push(body);
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: imageRequest
        ? JSON.stringify({ kind: "other", description: "ภาพทั่วไป" })
        : "รับทราบค่ะ" } }], usage: {} }),
    };
  };
  const app = createApp({ config, db, overrides: { lineFetch, hermesFetch, sleep: async () => {} }, logger: silent });
  t.after(() => { try { app.server.close(); } catch { /* not listening */ } db.close(); });
  return { app, db, mediaCalls, classificationRequests, sends };
}

test("signed Facebook image downloads before classification without waiting for the periodic sweep", async (t) => {
  const { app, db, mediaCalls, classificationRequests } = makeFacebookApp(t);
  await listen(app.server);

  const response = await postSignedFacebook(app.server, fbImageEvent());
  assert.equal(response.status, 200);
  await waitFor(() => classificationRequests.length === 1, { timeout: 1500 });

  assert.equal(mediaCalls.length, 1, "ingress must request the persisted Facebook CDN URL once");
  assert.match(mediaCalls[0], /scontent\.xx\.fbcdn\.net/u);
  const imagePart = classificationRequests[0].messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((part) => part?.type === "image_url");
  assert.match(imagePart?.image_url?.url || "", /^data:image\/png;base64,/u, "classifier must receive downloaded private bytes");
  assert.equal(db.getMessageAttachment(db.raw.prepare("SELECT id FROM message_attachments WHERE customer_id=?").get("facebook:psid-image").id).status, "ready");
});

test("a duplicate signed Facebook delivery does not start a second media download", async (t) => {
  const { app, db, mediaCalls } = makeFacebookApp(t);
  await listen(app.server);
  const payload = fbImageEvent({ mid: "mid-duplicate" });
  await postSignedFacebook(app.server, payload);
  await postSignedFacebook(app.server, payload);

  await waitFor(() => db.raw.prepare("SELECT status FROM message_attachments WHERE provider_message_id=?").get("mid-duplicate")?.status === "ready", { timeout: 1500 });
  assert.equal(mediaCalls.length, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM message_attachments WHERE provider_message_id=?").get("mid-duplicate").n, 1);
});

test("sticker and capture-off Facebook payloads never fetch a CDN asset", async (t) => {
  const sticker = makeFacebookApp(t);
  await listen(sticker.app.server);
  await postSignedFacebook(sticker.app.server, fbImageEvent({
    mid: "mid-sticker",
    attachment: { type: "image", payload: { sticker_id: "123", url: "https://scontent.xx.fbcdn.net/v/t39.1997-6/sticker.png" } },
  }));
  assert.equal(sticker.mediaCalls.length, 0);
  assert.equal(sticker.db.raw.prepare("SELECT COUNT(*) AS n FROM message_attachments").get().n, 0);

  const disabled = makeFacebookApp(t, { capture: false });
  await listen(disabled.app.server);
  await postSignedFacebook(disabled.app.server, fbImageEvent({ mid: "mid-capture-off" }));
  assert.equal(disabled.mediaCalls.length, 0);
  assert.equal(disabled.db.raw.prepare("SELECT COUNT(*) AS n FROM message_attachments").get().n, 1, "history retains an unavailable marker without starting a fetch");
});

test("Facebook download unavailable is a truthful human-review result: no model reply and no money flag", async (t) => {
  const { app, db, mediaCalls, classificationRequests, sends } = makeFacebookApp(t, {
    liveSend: true,
    fetchMedia: async () => new Response("gone", { status: 404, headers: { "content-type": "text/plain" } }),
  });
  await listen(app.server);
  await postSignedFacebook(app.server, fbImageEvent({ mid: "mid-missing" }));

  await waitFor(() => db.getCustomer("facebook:psid-image")?.state === "NEEDS_HUMAN", { timeout: 1500 });
  const customer = db.getCustomer("facebook:psid-image");
  assert.equal(mediaCalls.length, 1);
  assert.equal(classificationRequests.length, 0, "there are no bytes to send to the classifier");
  // F6 (ตรวจย้อนหลัง ก.ย. 2026): ห้องที่ยังไม่มีเรื่องเงิน — AI คุยต่อ + ข้อความตอบรับตายตัวหนึ่งบรรทัด
  // (ไม่ใช่คำตอบจากโมเดล) และยังปักธงให้คนตรวจรูปเหมือนเดิม
  await waitFor(() => sends.length === 1, { timeout: 1500 });
  assert.equal(customer.ai_enabled, 1);
  assert.equal(Number(customer.money_seen_at || 0), 0, "unavailable file is not proof of payment");
  const outbound = db.raw.prepare("SELECT content FROM messages WHERE customer_id=? AND direction='out'").all("facebook:psid-image");
  assert.deepEqual(outbound.map((row) => row.content), [IMAGE_ACK_TEMPLATE]);
  const outcome = await waitFor(() => {
    const row = db.raw.prepare("SELECT status, reason FROM inbound_turn_outcomes WHERE customer_id=? ORDER BY created_at DESC LIMIT 1").get("facebook:psid-image");
    return row?.status === "answered" ? row : null;
  }, { timeout: 1500 });
  assert.equal(outcome.status, "answered");
});

test("classifier lookup is scoped to the inbound customer and provider message id", async (t) => {
  const dir = temporaryDir(t);
  const db = memoryDb();
  t.after(() => db.close());
  const privateMedia = createPrivateMediaStore({ dir, minFreeBytes: 0 });
  const saved = privateMedia.save({ buffer: PNG, mime: "image/png", name: "foreign.png", kind: "image", origin: "facebook" });
  db.upsertCustomer("facebook:owner", { channelId: "facebook" });
  db.upsertCustomer("facebook:other", { channelId: "facebook" });
  db.addMessageAttachment({ id: "a-owner", customerId: "facebook:owner", direction: "in", source: "facebook", kind: "image", status: "queued", providerMessageId: "shared-mid", providerMeta: { contentProvider: "facebook" } });
  db.addMessageAttachment({ id: "z-other", customerId: "facebook:other", direction: "in", source: "facebook", kind: "image", status: "ready", providerMessageId: "shared-mid", storageKey: saved.storageKey, mime: "image/png", providerMeta: { contentProvider: "facebook" } });
  let modelCalls = 0;
  const classifier = createInboundImageClassifier({
    config: { imageClassifyEnabled: true, imageClassifyWaitMs: 0 }, db, privateMedia,
    hermes: { classifyImageMessages: async () => { modelCalls += 1; return JSON.stringify({ kind: "other", description: "x" }); } }, logger: silent,
  });

  const verdict = await classifier.classify({ customerId: "facebook:owner", messageId: "shared-mid" });
  assert.equal(verdict.reasonCode, "no_file");
  assert.equal(modelCalls, 0, "a different customer's ready attachment must never be classified for this turn");
});

test("classifier nudges only a due queued row through the existing ingress callback, then stops after its deadline", async (t) => {
  const dir = temporaryDir(t);
  const db = memoryDb();
  t.after(() => db.close());
  const privateMedia = createPrivateMediaStore({ dir, minFreeBytes: 0 });
  const saved = privateMedia.save({ buffer: PNG, mime: "image/png", name: "retry.png", kind: "image", origin: "facebook" });
  db.upsertCustomer("facebook:retry", { channelId: "facebook" });
  const dueId = db.addMessageAttachment({
    customerId: "facebook:retry", direction: "in", source: "facebook", kind: "image", status: "queued",
    providerMessageId: "retry-due", providerMeta: { contentProvider: "facebook" },
  });
  db.rescheduleMessageAttachment(dueId, { nextAttemptAt: Date.now() - 1, reason: "transient" });
  let wakeCalls = 0;
  let modelCalls = 0;
  const classifier = createInboundImageClassifier({
    config: { imageClassifyEnabled: true, imageClassifyWaitMs: 300 }, db, privateMedia,
    hermes: { classifyImageMessages: async () => { modelCalls += 1; return JSON.stringify({ kind: "other", description: "x" }); } }, logger: silent,
    requestMediaIngest: () => {
      wakeCalls += 1;
      // Represents the existing leased worker completing a due row; the
      // classifier itself never receives a provider URL or performs a fetch.
      db.updateMessageAttachment(dueId, { status: "ready", storageKey: saved.storageKey, mime: "image/png", byteSize: PNG.length, unavailableReason: "" });
    },
  });
  const ready = await classifier.classify({ customerId: "facebook:retry", messageId: "retry-due" });
  assert.equal(ready.kind, "other");
  assert.equal(wakeCalls, 1, "one due row wakes the shared scheduler once");
  assert.equal(modelCalls, 1);

  const futureId = db.addMessageAttachment({
    customerId: "facebook:retry", direction: "in", source: "facebook", kind: "image", status: "queued",
    providerMessageId: "retry-future", providerMeta: { contentProvider: "facebook" },
  });
  db.rescheduleMessageAttachment(futureId, { nextAttemptAt: Date.now() + 60_000, reason: "backoff" });
  const beforeWakes = wakeCalls;
  const beforeModels = modelCalls;
  const timedOut = await classifier.classify({ customerId: "facebook:retry", messageId: "retry-future" });
  assert.equal(timedOut.reasonCode, "no_file");
  assert.equal(wakeCalls, beforeWakes, "not-yet-due backoff must not be bypassed");
  assert.equal(modelCalls, beforeModels, "no bytes means no classification request after deadline");
});
