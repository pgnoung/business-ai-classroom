// HTTP regression coverage for the chat evidence and human-correction workflow.
// Every provider boundary is injected; these tests never use a real model, DB,
// network, or customer account.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb,
  poisonGlobalFetch, signLine, testConfig, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();

const PASSWORD = "chat-evidence-pass-123";
const SECRET = "chat-evidence-console-secret";
const LINE_SECRET = "test-line-secret";
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function signedImage(messageId, userId = "U-image-evidence") {
  return JSON.stringify({
    events: [{
      type: "message", webhookEventId: `event-${messageId}`, replyToken: `reply-${messageId}`,
      source: { type: "user", userId },
      message: { id: messageId, type: "image", contentProvider: { type: "line" } },
    }],
  });
}

function post(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server) {
  const result = await post(server, "/console/api/login", { username: "owner", password: PASSWORD });
  assert.equal(result.status, 200, result.text);
  return { cookie: result.headers["set-cookie"][0].split(";")[0], csrf: result.json.csrf };
}

function auth(session) { return { cookie: session.cookie, "x-csrf-token": session.csrf }; }

async function boot(t, { imageClassify = null, teach = false } = {}) {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), displayName: "Owner", role: "owner" });
  const lineFetch = lineFetchStub();
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SECRET, CONSOLE_COOKIE_SECURE: "false", TEACH_ENABLED: teach ? "true" : "false",
    // A signed image must be retained and observed, but this test must never
    // fetch provider content or send a reply.
    LINE_MOCK_URL: "", LINE_LIVE_SEND: "false",
  });
  const app = createApp({
    config, db,
    overrides: {
      lineFetch, hermesFetch: hermesFetchStub("ร่างทดสอบ"), sleep: async () => {},
      ...(imageClassify ? { imageClassify } : {}),
    }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, lineFetch };
}

async function sendSignedImage(server, messageId, userId) {
  const raw = signedImage(messageId, userId);
  return httpRequest(server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, LINE_SECRET) }, body: raw,
  });
}

test("signed inbound image persists fixed evidence and authorized conversation read exposes it without changing the observed route", async (t) => {
  const cases = [
    { label: "disabled", injected: null, state: "classifier_disabled", kind: "unknown", code: "disabled", action: "human_review" },
    { label: "no-file", injected: { enabled: true, classify: async () => ({ kind: "unknown", reasonCode: "no_file" }) }, state: "download_unavailable", kind: "unknown", code: "no_file", action: "human_review" },
    { label: "model-error", injected: { enabled: true, classify: async () => ({ kind: "unknown", reasonCode: "model_error" }) }, state: "classifier_error", kind: "unknown", code: "model_error", action: "human_review" },
    { label: "other", injected: { enabled: true, classify: async () => ({ kind: "other", description: "ภาพทั่วไป" }) }, state: "classified", kind: "other", code: "valid", action: "text_pipeline" },
  ];
  for (const item of cases) {
    const { app, db, lineFetch } = await boot(t, { imageClassify: item.injected });
    const customerId = `U-image-${item.label}`;
    const eventId = `image-${item.label}`;
    const accepted = await sendSignedImage(app.server, eventId, customerId);
    assert.equal(accepted.status, 200, `${item.label}: webhook must pass signature and persist`);
    // LINE dedupe/persistence is keyed by its canonical message.id.  The
    // webhookEventId is provider delivery metadata only and must not be used
    // to retrieve the durable inbound row.
    const storedId = `in:${eventId}`;
    await waitFor(() => db.getInboundImageClassification({ customerId, messageId: storedId }), { timeout: 1000 });

    const owner = await login(app.server);
    const conversation = await httpRequest(app.server, {
      path: `/console/api/conversations/${encodeURIComponent(customerId)}/messages`, headers: auth(owner),
    });
    assert.equal(conversation.status, 200, `${item.label}: authorized conversation must load`);
    const image = conversation.json.messages.find((message) => message.id === storedId);
    assert.deepEqual(image.imageClassification && {
      classification_state: image.imageClassification.classification_state,
      classified_kind: image.imageClassification.classified_kind,
      diagnostic_code: image.imageClassification.diagnostic_code,
      action: image.imageClassification.action,
    }, {
      classification_state: item.state, classified_kind: item.kind, diagnostic_code: item.code, action: item.action,
    });
    assert.equal(lineFetch.sends.length, 0, `${item.label}: evidence must not create an outbound provider request`);
    if (item.action === "human_review") {
      assert.equal(db.getCustomer(customerId).state, "NEEDS_HUMAN", `${item.label}: existing fail-closed branch remains`);
    } else {
      assert.notEqual(Number(db.getCustomer(customerId).money_seen_at || 0), 1, "other must not become a money proof");
    }
  }
});

test("teach correction-final accepts only a real candidate edit, keeps it unpublished, and returns linked same-customer context", async (t) => {
  const { app, db } = await boot(t, { teach: true });
  const customerId = "U-teach-evidence";
  const inboundId = db.insertMessage({ id: "in:teach-question", customerId, direction: "in", msgType: "text", content: "มีใบกำกับภาษีไหมคะ" });
  const correctionId = db.addCorrection({
    customerId, aiDraft: "มีค่ะ", humanFinal: "", inboundMessageId: inboundId,
    sourceReason: "system:compliance_block:banned_word,price",
  });
  assert.equal(db.getCorrection(correctionId).source_reason, "system:compliance_block:banned_word,price");
  const owner = await login(app.server);

  const before = await httpRequest(app.server, {
    path: `/console/api/teach/session?source=correction&ref=${encodeURIComponent(correctionId)}`, headers: auth(owner),
  });
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.inboundSource.available, true);
  assert.equal(before.json.inboundSource.messageId, inboundId);
  assert.equal(before.json.inboundSource.text, "มีใบกำกับภาษีไหมคะ", "authorized source must be the actual linked question");
  assert.equal(before.json.teachingBlocked, true, "a draft without a human edit remains blocked");

  const noCsrf = await post(app.server, "/console/api/teach/correction-final", {
    source: "correction", ref: correctionId, humanFinal: "มีค่ะ ออกให้หลังยืนยันการชำระเงินค่ะ",
  }, { cookie: owner.cookie });
  assert.equal(noCsrf.status, 403);
  const missing = await post(app.server, "/console/api/teach/correction-final", { source: "correction", ref: correctionId, humanFinal: "" }, auth(owner));
  assert.equal(missing.status, 400);
  const noop = await post(app.server, "/console/api/teach/correction-final", { source: "correction", ref: correctionId, humanFinal: "มีค่ะ" }, auth(owner));
  assert.equal(noop.status, 409);

  const knowledgeBefore = db.listKnowledge().length;
  const saved = await post(app.server, "/console/api/teach/correction-final", {
    source: "correction", ref: correctionId, humanFinal: "มีค่ะ ออกให้หลังยืนยันการชำระเงินค่ะ",
  }, auth(owner));
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.teachingBlocked, false, "session must become teachable only after a real edit is saved");
  assert.equal(db.getCorrection(correctionId).human_final, "มีค่ะ ออกให้หลังยืนยันการชำระเงินค่ะ");
  assert.equal(db.getCorrection(correctionId).status, "candidate", "saving a final is not approval or publication");
  assert.equal(db.getCorrection(correctionId).taught_version_id, "");
  assert.equal(db.listKnowledge().length, knowledgeBefore, "correction-final must never write knowledge");
  assert.equal(db.listAudit().filter((row) => row.action === "correction_human_final_saved").length, 1);
});

test("teach session refuses unauthenticated mutation and never resolves an unlinked or cross-customer original question", async (t) => {
  const { app, db } = await boot(t, { teach: true });
  const customerId = "U-teach-owner";
  const otherCustomer = "U-teach-other";
  db.upsertCustomer(customerId, {});
  const foreignInbound = db.insertMessage({ id: "in:foreign-question", customerId: otherCustomer, direction: "in", msgType: "text", content: "ข้อมูลคนอื่น" });
  const unlinked = db.addCorrection({ customerId, aiDraft: "ร่าง", humanFinal: "" });
  assert.throws(() => db.addCorrection({ customerId, aiDraft: "ร่าง", inboundMessageId: foreignInbound }), /inbound message/u);

  const unauth = await post(app.server, "/console/api/teach/correction-final", {
    source: "correction", ref: unlinked, humanFinal: "คำแก้จริง",
  });
  assert.equal(unauth.status, 401);
  const owner = await login(app.server);
  const session = await httpRequest(app.server, {
    path: `/console/api/teach/session?source=correction&ref=${encodeURIComponent(unlinked)}`, headers: auth(owner),
  });
  assert.equal(session.status, 200);
  assert.deepEqual(session.json.inboundSource, { available: false }, "legacy/no-link row must not be guessed from older room history");
});
