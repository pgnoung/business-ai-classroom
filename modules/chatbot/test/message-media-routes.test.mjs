// Route-level contract for Console media.  All provider traffic stays on the
// injected LINE mock; this file must never make a network request.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { createPrivateMediaStore } from "../src/messageMedia.mjs";
import { hashPassword } from "../src/auth.mjs";
import { httpRequest, hermesFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);
const CONSOLE_SECRET = "test-console-secret-media-routes";
const PDF_A = Buffer.from("%PDF-1.4\nroute-test-a");
const PDF_B = Buffer.from("%PDF-1.4\nroute-test-b");
const TXT = Buffer.from("private course notes\n", "utf8");
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
const MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00]);

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, { method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function login(server, username = "nok") {
  const res = await postJson(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

function lineMock({ failPushAt = 0 } = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (!pathname.includes("/v2/bot/message/push")) return { ok: true, status: 200, json: async () => ({}) };
    calls.push(JSON.parse(options.body));
    const failed = failPushAt > 0 && calls.length === failPushAt;
    return { ok: !failed, status: failed ? 500 : 200, json: async () => ({}) };
  };
  return { fetch, calls };
}

async function startMediaConsole(t, { failPushAt = 0, overrides = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lukprae-media-routes-"));
  const line = lineMock({ failPushAt });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก", role: "admin" });
  db.upsertCustomer("U-route", { displayName: "Route customer" });
  const config = testConfig({
    CONSOLE_SESSION_SECRET: CONSOLE_SECRET,
    CONSOLE_COOKIE_SECURE: "false",
    MESSAGE_MEDIA_ENABLED: "true",
    OPERATOR_FILE_UPLOAD_ENABLED: "true",
    OUTBOUND_FILE_LINK_ENABLED: "true",
    STICKER_PICKER_ENABLED: "true",
    OUTBOUND_FILE_PUBLIC_BASE_URL: "https://console.test",
    MESSAGE_MEDIA_DIR: dir,
    MESSAGE_MEDIA_MIN_FREE_BYTES: "104857600",
    ...overrides,
  });
  const app = createApp({ config, db, overrides: { lineFetch: line.fetch, hermesFetch: hermesFetchStub("x"), sleep: async () => {}, ...overrides }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app, db, config, dir, line };
}

async function upload(server, { cookie, csrf, body, name, contentType = "application/pdf", contentLength = true, mediaSize } = {}) {
  return httpRequest(server, {
    method: "POST", path: `/console/api/conversations/U-route/attachments?name=${encodeURIComponent(name)}`,
    headers: {
      "content-type": contentType,
      ...(contentLength ? { "content-length": String(body.length) } : {}),
      ...(mediaSize !== undefined ? { "x-media-size": String(mediaSize) } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body,
  });
}

test("media routes: chunked uploads require a strict declared size and release failed reservations", async (t) => {
  const { app, db } = await startMediaConsole(t, { overrides: { MESSAGE_MEDIA_MAX_ACTIVE: "1" } });
  const auth = await login(app.server);

  await assert.rejects(
    upload(app.server, {
      ...auth, body: PDF_B, name: "under-declared.pdf", contentLength: false, mediaSize: PDF_B.length - 1,
    }),
    { code: "ECONNRESET" },
    "over-limit chunked bodies are cut off before buffering the undeclared bytes",
  );
  assert.equal(db.listMessageAttachmentsForCustomer("U-route").length, 0, "over-limit body must not create media");
  const mismatch = await upload(app.server, {
    ...auth, body: PDF_B, name: "mismatch.pdf", contentLength: false, mediaSize: PDF_B.length + 1,
  });
  assert.equal(mismatch.status, 400, mismatch.text);
  assert.equal(db.listMessageAttachmentsForCustomer("U-route").length, 0, "mismatched body must not create media");
  const chunked = await upload(app.server, {
    ...auth, body: TXT, name: "after-mismatch.txt", contentType: "text/plain", contentLength: false, mediaSize: TXT.length,
  });
  assert.equal(chunked.status, 201, chunked.text);

  const malformed = await upload(app.server, {
    ...auth, body: PDF_B, name: "malformed.pdf", contentLength: false, mediaSize: "1e3",
  });
  assert.equal(malformed.status, 411, malformed.text);
  const oversize = await upload(app.server, {
    ...auth, body: PDF_B, name: "oversize.pdf", contentLength: false, mediaSize: 128 * 1024 * 1024 + 1,
  });
  assert.equal(oversize.status, 413, oversize.text);
});

test("media routes: Content-Length uploads keep their existing behavior", async (t) => {
  const { app } = await startMediaConsole(t);
  const auth = await login(app.server);
  const uploaded = await upload(app.server, {
    ...auth, body: PDF_A, name: "content-length.pdf", mediaSize: PDF_A.length + 1,
  });
  assert.equal(uploaded.status, 201, uploaded.text);
});

function tokenFromText(text) {
  const matched = /\/download#([A-Za-z0-9_-]{43})/u.exec(String(text));
  assert.ok(matched, "provider mock must receive an opaque download capability");
  return matched[1];
}

function grantForToken(db, token) {
  return db.activeAttachmentDownloadToken(createHash("sha256").update(token).digest("hex"));
}

function redeemDownload(server, token) {
  const body = `token=${encodeURIComponent(token)}`;
  return httpRequest(server, {
    method: "POST", path: "/download",
    headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) },
    body,
  });
}

test("media routes: upload needs session + CSRF; private content needs session but no CSRF for read", async (t) => {
  const { app, db, dir } = await startMediaConsole(t);
  const anonymous = await upload(app.server, { body: PDF_A, name: "quote.pdf" });
  assert.equal(anonymous.status, 401);
  const { cookie, csrf } = await login(app.server);
  const noCsrf = await upload(app.server, { cookie, body: PDF_A, name: "quote.pdf" });
  assert.equal(noCsrf.status, 403);

  const store = createPrivateMediaStore({ dir, minFreeBytes: 0 });
  const saved = store.save({ buffer: PDF_A, name: "private.pdf", origin: "line", kind: "file" });
  const attachmentId = db.addMessageAttachment({ customerId: "U-route", direction: "in", kind: "file", status: "ready", originalName: "private.pdf", mime: saved.mime, byteSize: saved.byteSize, storageKey: saved.storageKey, sha256: saved.sha256 });
  const noSessionRead = await httpRequest(app.server, { path: `/console/api/attachments/${attachmentId}/content` });
  assert.equal(noSessionRead.status, 401);
  const sessionRead = await httpRequest(app.server, { path: `/console/api/attachments/${attachmentId}/content`, headers: { cookie } });
  assert.equal(sessionRead.status, 200, sessionRead.text);
  assert.equal(sessionRead.headers["content-disposition"].startsWith("attachment"), true);
  assert.equal(sessionRead.headers["cache-control"], "private, max-age=0, must-revalidate");
  assert.ok(sessionRead.headers.etag);
  const revalidated = await httpRequest(app.server, {
    path: `/console/api/attachments/${attachmentId}/content`,
    headers: { cookie, "if-none-match": sessionRead.headers.etag },
  });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers["cache-control"], "private, max-age=0, must-revalidate");
  assert.equal(csrf.length > 10, true);
});

test("media routes: staff reads, uploads and sends media after the 2026-08-25 role decision", async (t) => {
  const { app, db, dir } = await startMediaConsole(t, { overrides: { imageCatalog: [{ key: "staff-image", url: "https://cdn.example.test/staff-image.jpg" }] } });
  db.createOperator({ username: "staff", passHash: PASS_HASH, displayName: "ทีมงาน", role: "operator" });
  const auth = await login(app.server, "staff");

  const store = createPrivateMediaStore({ dir, minFreeBytes: 0 });
  const saved = store.save({ buffer: PDF_A, name: "staff-readable.pdf", origin: "line", kind: "file" });
  const attachmentId = db.addMessageAttachment({ customerId: "U-route", direction: "in", kind: "file", status: "ready", originalName: saved.originalName, mime: saved.mime, byteSize: saved.byteSize, storageKey: saved.storageKey });
  const read = await httpRequest(app.server, { path: `/console/api/attachments/${attachmentId}/content`, headers: { cookie: auth.cookie } });
  assert.equal(read.status, 200, read.text);

  // เจ้าของตัดสิน 2026-08-25: ชมพู่/พนักงานส่งรูป ไฟล์ และสติกเกอร์ได้เอง ไม่ต้องรอเจ้าของ
  const staffUpload = await upload(app.server, { ...auth, body: PDF_A, name: "staff-upload.pdf" });
  assert.equal(staffUpload.status, 201, staffUpload.text);
  const staffSticker = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    sticker: { packageId: "11537", stickerId: "52002739" },
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(staffSticker.status, 200, staffSticker.text);
  const staffImage = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    text: "[IMAGE:staff-image]",
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(staffImage.status, 200, staffImage.text);

  // ประตูที่ยังต้องปิดเสมอ: ไม่มี CSRF และไม่ได้ล็อกอิน
  const noCsrf = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    text: "[IMAGE:staff-image]",
  }, { cookie: auth.cookie });
  assert.equal(noCsrf.status, 403, "CSRF still enforced for staff media send");
  const anonymousUpload = await upload(app.server, { cookie: "", csrf: "", body: PDF_A, name: "anon.pdf" });
  assert.equal(anonymousUpload.status, 401, "ผู้ไม่ล็อกอินอัปโหลดไม่ได้");
});

test("console roles: admin cannot reset/forget; owner may reset and separately confirm PDPA forget", async (t) => {
  const { app, db } = await startMediaConsole(t);
  const admin = await login(app.server);
  const denied = await postJson(app.server, "/console/api/customers/U-route/reset", {}, { cookie: admin.cookie, "x-csrf-token": admin.csrf });
  assert.equal(denied.status, 403, denied.text);
  const deniedForget = await postJson(app.server, "/console/api/customers/U-route/forget", { confirm: "ลืมลูกค้า" }, { cookie: admin.cookie, "x-csrf-token": admin.csrf });
  assert.equal(deniedForget.status, 403, deniedForget.text);
  assert.ok(db.getCustomer("U-route"), "denied reset must not mutate the customer");
  db.createOperator({ username: "owner", passHash: PASS_HASH, displayName: "เจ้าของ", role: "owner" });
  const owner = await login(app.server, "owner");
  const allowed = await postJson(app.server, "/console/api/customers/U-route/reset", {}, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(allowed.status, 200, allowed.text);
  assert.ok(db.getCustomer("U-route"), "test reset intentionally keeps the identity row");
  const forgotten = await postJson(app.server, "/console/api/customers/U-route/forget", { confirm: "ลืมลูกค้า" }, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(forgotten.status, 200, forgotten.text);
  assert.equal(db.getCustomer("U-route"), null);
  assert.equal(db.listCustomerTombstones().length, 1);
});

test("PDPA forget: legacy public chat image blocks fail-closed without mutation", async (t) => {
  const { app, db } = await startMediaConsole(t);
  db.insertMessage({
    customerId: "U-route", direction: "out", msgType: "image",
    content: "[image:upload_0123456789abcdef] https://console.test/media/00000000-0000-4000-8000-000000000000.png",
  });
  db.createOperator({ username: "owner", passHash: PASS_HASH, displayName: "เจ้าของ", role: "owner" });
  const owner = await login(app.server, "owner");
  const blocked = await postJson(app.server, "/console/api/customers/U-route/forget", {
    confirm: "ลืมลูกค้า",
  }, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.json.code, "public_chat_media_manual_review_required");
  assert.ok(db.getCustomer("U-route"));
  assert.equal(db.messagesFor("U-route").length, 1);
  assert.equal(db.listCustomerTombstones().length, 0);
});

test("PDPA forget: a media preflight rejection preserves its JEV audit cases", async (t) => {
  const auditDir = mkdtempSync(join(tmpdir(), "lukprae-jev-final-"));
  const { app, db } = await startMediaConsole(t, { overrides: { JEV_AUDIT_DIR: auditDir } });
  writeFileSync(join(auditDir, "batch.json"), JSON.stringify({
    schemaVersion: 1, batchId: "batch", createdAt: Date.now(), completedAt: Date.now(),
    cases: [{ id: "case-1", customerId: "U-route" }],
  }), { mode: 0o600 });
  t.after(() => rmSync(auditDir, { recursive: true, force: true }));
  db.insertMessage({
    customerId: "U-route", direction: "out", msgType: "image",
    content: "[image:upload_0123456789abcdef] https://console.test/media/00000000-0000-4000-8000-000000000000.png",
  });
  db.createOperator({ username: "owner", passHash: PASS_HASH, displayName: "เจ้าของ", role: "owner" });
  const owner = await login(app.server, "owner");
  const blocked = await postJson(app.server, "/console/api/customers/U-route/forget", { confirm: "ลืมลูกค้า" }, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(blocked.status, 409, blocked.text);
  assert.deepEqual(JSON.parse(readFileSync(join(auditDir, "batch.json"), "utf8")).cases, [{ id: "case-1", customerId: "U-route" }]);
  assert.ok(db.getCustomer("U-route"));
});

test("media routes: configured global count limit is never raised to the operator hourly quota", async (t) => {
  const { app } = await startMediaConsole(t, { overrides: { MESSAGE_MEDIA_MAX_ACTIVE: "1", MESSAGE_MEDIA_UPLOADS_PER_OPERATOR_HOUR: "30" } });
  const auth = await login(app.server);
  assert.equal((await upload(app.server, { ...auth, body: PDF_A, name: "one.pdf" })).status, 201);
  const blocked = await upload(app.server, { ...auth, body: PDF_B, name: "two.pdf" });
  assert.equal(blocked.status, 507, blocked.text);
});

test("media routes: multiple uploads produce all links, generic files download as reusable attachments, and reply audit never records bearer URLs", async (t) => {
  const { app, db, config, line } = await startMediaConsole(t);
  const auth = await login(app.server);
  const first = await upload(app.server, { ...auth, body: PDF_A, name: "quote-a.pdf" });
  const second = await upload(app.server, { ...auth, body: TXT, name: "notes.txt", contentType: "text/plain" });
  assert.equal(first.status, 201, first.text);
  assert.equal(second.status, 201, second.text);
  const reply = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    text: "เอกสารสำหรับคุณค่ะ", attachmentIds: [first.json.attachment.id, second.json.attachment.id],
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(line.calls.length, 1);
  const outboundText = line.calls[0].messages[0].text;
  const tokens = [...String(outboundText).matchAll(/\/download#([A-Za-z0-9_-]{43})/gu)].map((match) => match[1]);
  assert.equal(tokens.length, 2, "all selected files need their own grant");
  const fileGrant = grantForToken(db, tokens[0]);
  assert.ok(fileGrant);
  assert.ok(fileGrant.expires_at - fileGrant.created_at <= config.outboundFileLinkTtlMs);
  assert.ok(fileGrant.expires_at - fileGrant.created_at >= config.outboundFileLinkTtlMs - 1_000);
  assert.equal(db.listAudit().some((entry) => entry.action === "reply" && /\/download[#/]/u.test(entry.detail)), false, "bearer grants must not leak to audit");
  const persisted = db.messagesFor("U-route").filter((message) => message.direction === "out");
  assert.equal(persisted.length, 1);
  assert.doesNotMatch(persisted[0].content, /\/download[#/]/u, "bearer grants must never enter chat history/export/training data");
  assert.match(persisted[0].content, /ส่งไฟล์แนบ 2 ไฟล์/u);
  assert.equal(db.attachmentsForMessages([persisted[0].id]).length, 2, "file cards must be linked to the persisted operator message");
  const history = await httpRequest(app.server, {
    path: "/console/api/conversations/U-route/messages?limit=20",
    headers: { cookie: auth.cookie },
  });
  assert.equal(history.status, 200, history.text);
  const sentMessage = history.json.messages.find((message) => message.id === persisted[0].id);
  assert.deepEqual(sentMessage.delivery_status, {
    state: "accepted",
    proof: "line_request_accepted",
    read_receipt_available: false,
  });
  assert.equal(sentMessage.metadata.operatorDelivery, undefined, "internal attempt id must stay server-side");

  db.insertMessage({ customerId: "U-route", direction: "in", content: "ได้รับไฟล์แล้วค่ะ" });
  const replyPage = await httpRequest(app.server, {
    path: "/console/api/conversations/U-route/messages?limit=1",
    headers: { cookie: auth.cookie },
  });
  assert.equal(replyPage.json.messages.length, 1);
  assert.equal(replyPage.json.messages[0].direction, "in");
  const replyCursor = replyPage.json.messages[0];
  const olderPage = await httpRequest(app.server, {
    path: `/console/api/conversations/U-route/messages?limit=1&beforeAt=${replyCursor.created_at}&beforeRid=${replyCursor.rid}`,
    headers: { cookie: auth.cookie },
  });
  const interacted = olderPage.json.messages.find((message) => message.id === persisted[0].id);
  assert.ok(interacted, "reply interaction must survive a pagination boundary");
  assert.equal(interacted.customer_interaction_after.type, "reply");
  assert.ok(interacted.customer_interaction_after.at > 0);
  assert.doesNotMatch(JSON.stringify(interacted), /อ่านแล้ว/u);
  const duplicateSend = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    attachmentIds: [first.json.attachment.id],
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(duplicateSend.status, 400, "an already-sent attachment cannot mint a second capability by retry");

  const landing = await httpRequest(app.server, { path: "/download" });
  assert.equal(landing.status, 200);
  assert.doesNotMatch(landing.text, new RegExp(tokens[1], "u"), "fragment bearer must never enter the access-log-visible landing response");
  const generic = await redeemDownload(app.server, tokens[1]);
  assert.equal(generic.status, 200, generic.text);
  assert.equal(generic.headers["content-type"], "application/octet-stream");
  assert.match(String(generic.headers["content-disposition"]), /^attachment;/u);
  assert.equal(generic.headers["cache-control"], "private, no-store");
  const genericAgain = await redeemDownload(app.server, tokens[1]);
  assert.equal(genericAgain.status, 200, "grants are reusable until expiry");
});

test("media routes: private operator image reaches LINE through an expiring capability and PDPA forget revokes it", async (t) => {
  const { app, db, config, line } = await startMediaConsole(t);
  const auth = await login(app.server);
  const uploaded = await upload(app.server, {
    ...auth, body: PNG_1X1, name: "private-chat.png", contentType: "image/png",
  });
  assert.equal(uploaded.status, 201, uploaded.text);
  assert.equal(uploaded.json.attachment.kind, "image");

  const reply = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    attachmentIds: [uploaded.json.attachment.id],
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.json.imagesSent, 1);
  const image = line.calls.flatMap((call) => call.messages || []).find((message) => message.type === "image");
  assert.ok(image);
  assert.equal(image.originalContentUrl, image.previewImageUrl);
  const mediaUrl = new URL(image.originalContentUrl);
  assert.equal(mediaUrl.origin, "https://console.test");
  assert.match(mediaUrl.pathname, /^\/line-media\/[A-Za-z0-9_-]{43}$/u);
  const imageToken = mediaUrl.pathname.slice("/line-media/".length);
  const imageGrant = grantForToken(db, imageToken);
  assert.ok(imageGrant);
  assert.ok(imageGrant.expires_at - imageGrant.created_at <= config.outboundImageLinkTtlMs);
  assert.ok(imageGrant.expires_at - imageGrant.created_at >= config.outboundImageLinkTtlMs - 1_000);
  // 2026-08-27: เดิมยืนยันว่า "อายุลิงก์รูปสั้นกว่าไฟล์" ตามการออกแบบเก่าที่คิดว่า
  // LINE ดึงรูปทันทีแล้วจบ — ตอนนี้ทั้งคู่ยาวเท่ากัน เพราะลูกค้าเลื่อนกลับมาดูรูปเก่าได้เสมอ
  // สิ่งที่ยังต้องจริงคือทั้งคู่ต้องเป็นค่าจำกัด เพื่อให้ PDPA forget เพิกถอนได้
  assert.ok(Number.isFinite(config.outboundImageLinkTtlMs));
  assert.ok(Number.isFinite(config.outboundFileLinkTtlMs));
  const beforeForget = await httpRequest(app.server, { path: mediaUrl.pathname });
  assert.equal(beforeForget.status, 200, beforeForget.text);
  assert.equal(beforeForget.headers["content-type"], "image/png");
  assert.equal(beforeForget.headers["cache-control"], "private, no-store");

  const message = db.messagesFor("U-route").find((row) => row.msg_type === "image");
  assert.ok(message);
  assert.equal(message.content, "[image]");
  assert.equal(db.attachmentsForMessages([message.id])[0].id, uploaded.json.attachment.id);
  assert.doesNotMatch(JSON.stringify(db.listOperatorOutboundAttempts()), /\/line-media\/[A-Za-z0-9_-]{20,}/u);
  assert.doesNotMatch(JSON.stringify(db.listAudit()), /\/line-media\/[A-Za-z0-9_-]{20,}/u);

  db.createOperator({ username: "owner", passHash: PASS_HASH, displayName: "เจ้าของ", role: "owner" });
  const owner = await login(app.server, "owner");
  const forgotten = await postJson(app.server, "/console/api/customers/U-route/forget", {
    confirm: "ลืมลูกค้า",
  }, { cookie: owner.cookie, "x-csrf-token": owner.csrf });
  assert.equal(forgotten.status, 200, forgotten.text);
  assert.equal(db.getCustomer("U-route"), null);
  assert.equal((await httpRequest(app.server, { path: mediaUrl.pathname })).status, 404);
});

test("media routes: partial private-image send keeps only accepted image and revokes the rejected capability", async (t) => {
  const { app, db, line } = await startMediaConsole(t, { failPushAt: 2 });
  const auth = await login(app.server);
  const first = await upload(app.server, { ...auth, body: PNG_1X1, name: "first.png", contentType: "image/png" });
  const second = await upload(app.server, { ...auth, body: PNG_1X1, name: "second.png", contentType: "image/png" });
  assert.equal(first.status, 201, first.text);
  assert.equal(second.status, 201, second.text);

  const result = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    attachmentIds: [first.json.attachment.id, second.json.attachment.id],
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(result.status, 502, result.text);
  assert.equal(result.json.partiallyDelivered, 1);
  const firstPath = new URL(line.calls[0].messages[0].originalContentUrl).pathname;
  const secondPath = new URL(line.calls[1].messages[0].originalContentUrl).pathname;
  assert.equal((await httpRequest(app.server, { path: firstPath })).status, 200);
  assert.equal((await httpRequest(app.server, { path: secondPath })).status, 404);

  const firstRow = db.getMessageAttachment(first.json.attachment.id);
  const secondRow = db.getMessageAttachment(second.json.attachment.id);
  assert.ok(firstRow.message_id, "provider-accepted image is linked to durable history");
  assert.equal(secondRow.message_id, null);
  assert.equal(secondRow.send_claim_id, "", "rejected image can be selected for a later explicit retry");
  assert.equal(db.messagesFor("U-route").filter((row) => row.msg_type === "image").length, 1);
});

test("media routes: delivery and reply chips follow LINE request order when a final question moves after media", async (t) => {
  const image = { key: "class-map", url: "https://cdn.example.test/class-map.jpg" };
  const { app, db, line } = await startMediaConsole(t, { overrides: { imageCatalog: [image] } });
  const auth = await login(app.server);
  const sent = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    text: "ดูแผนที่นี้แล้วสะดวกไหมคะ [IMAGE:class-map]",
    sticker: { packageId: "11537", stickerId: "52002739" },
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(line.calls.map((call) => call.messages[0].type), ["image", "sticker", "text"]);

  const persisted = db.messagesFor("U-route").filter((message) => message.direction === "out");
  assert.deepEqual(persisted.map((message) => message.msg_type), ["image", "sticker", "text"]);
  const history = await httpRequest(app.server, {
    path: "/console/api/conversations/U-route/messages?limit=20",
    headers: { cookie: auth.cookie },
  });
  const statuses = history.json.messages.filter((message) => message.delivery_status);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].msg_type, "text", "batch proof belongs under the last provider-ordered bubble");

  db.insertMessage({ customerId: "U-route", direction: "in", content: "สะดวกค่ะ" });
  const afterReply = await httpRequest(app.server, {
    path: "/console/api/conversations/U-route/messages?limit=20",
    headers: { cookie: auth.cookie },
  });
  const interaction = afterReply.json.messages.filter((message) => message.customer_interaction_after);
  assert.equal(interaction.length, 1);
  assert.equal(interaction[0].msg_type, "text", "reply interaction follows the last provider-ordered bubble");
  assert.doesNotMatch(JSON.stringify(interaction[0]), /อ่านแล้ว/u);
});

test("media routes: operator audio/video class uploads are delivered as expiring file links", async (t) => {
  const { app, db, line } = await startMediaConsole(t);
  const auth = await login(app.server);
  const uploaded = await upload(app.server, { ...auth, body: MP3, name: "voice.mp3", contentType: "audio/mpeg" });
  assert.equal(uploaded.status, 201, uploaded.text);
  assert.equal(uploaded.json.attachment.kind, "audio");
  const reply = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    text: "ไฟล์เสียงค่ะ", attachmentIds: [uploaded.json.attachment.id],
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(reply.status, 200, reply.text);
  const token = tokenFromText(line.calls[0].messages[0].text);
  const download = await redeemDownload(app.server, token);
  assert.equal(download.status, 200, download.text);
  assert.equal(download.headers["content-type"], "application/octet-stream");
  const message = db.messagesFor("U-route").find((row) => row.direction === "out");
  assert.equal(db.attachmentsForMessages([message.id])[0].kind, "audio");
});

test("media routes: expired and revoked public grants fail closed", async (t) => {
  const { app, db, dir } = await startMediaConsole(t);
  const store = createPrivateMediaStore({ dir, minFreeBytes: 0 });
  const saved = store.save({ buffer: PDF_A, name: "expired.pdf", origin: "operator" });
  const attachmentId = db.addMessageAttachment({ customerId: "U-route", direction: "out", source: "operator_upload", kind: "file", status: "ready", originalName: saved.originalName, mime: saved.mime, byteSize: saved.byteSize, storageKey: saved.storageKey });
  const expired = "a".repeat(43);
  const revoked = "b".repeat(43);
  const hash = (token) => createHash("sha256").update(token).digest("hex");
  db.createAttachmentDownloadToken({ tokenHash: hash(expired), attachmentId, expiresAt: Date.now() - 1 });
  db.createAttachmentDownloadToken({ tokenHash: hash(revoked), attachmentId, expiresAt: Date.now() + 60_000 });
  db.revokeAttachmentDownloadTokens([hash(revoked)]);
  assert.equal((await redeemDownload(app.server, expired)).status, 404);
  assert.equal((await redeemDownload(app.server, revoked)).status, 404);
});

test("media routes: download-grant batch rolls back atomically", async (t) => {
  const { db } = await startMediaConsole(t);
  const duplicate = "c".repeat(64);
  assert.throws(() => db.createAttachmentDownloadTokens([
    { tokenHash: duplicate, attachmentId: "a", expiresAt: Date.now() + 60_000 },
    { tokenHash: duplicate, attachmentId: "b", expiresAt: Date.now() + 60_000 },
  ]));
  assert.equal(db.activeAttachmentDownloadToken(duplicate), undefined);
});

test("media routes: attachment claim, grants, and outbound intent roll back as one unit", async (t) => {
  const { db, dir } = await startMediaConsole(t);
  const store = createPrivateMediaStore({ dir, minFreeBytes: 0 });
  const saved = store.save({ buffer: PDF_A, name: "atomic.pdf", origin: "operator" });
  const attachmentId = db.addMessageAttachment({ customerId: "U-route", direction: "out", source: "operator_upload", kind: "file", status: "ready", originalName: saved.originalName, mime: saved.mime, byteSize: saved.byteSize, storageKey: saved.storageKey });
  const duplicateHash = "d".repeat(64);
  db.createAttachmentDownloadToken({ tokenHash: duplicateHash, attachmentId: "existing", expiresAt: Date.now() + 60_000 });
  assert.throws(() => db.prepareOperatorOutboundAttempt({
    id: "atomic-attempt", customerId: "U-route", operator: "nok",
    attachmentIds: [attachmentId], claimId: "atomic-claim", claimExpiresAt: Date.now() + 60_000,
    downloadTokens: [{ tokenHash: duplicateHash, attachmentId, expiresAt: Date.now() + 60_000 }],
    payload: { historyRows: [] },
  }));
  const attachment = db.getMessageAttachment(attachmentId);
  assert.equal(attachment.send_claim_id, "", "failed grant/intent insert must roll the claim back");
  assert.equal(db.getOperatorOutboundAttempt("atomic-attempt"), null);
});

test("media routes: provider-accepted send survives history failure and recovers without a resend", async (t) => {
  const { app, db, line } = await startMediaConsole(t);
  const auth = await login(app.server);
  const uploaded = await upload(app.server, { ...auth, body: PDF_A, name: "recover.pdf" });
  assert.equal(uploaded.status, 201, uploaded.text);
  const originalFinalize = db.finalizeAcceptedOperatorOutboundAttempt;
  db.finalizeAcceptedOperatorOutboundAttempt = () => { throw new Error("forced history failure"); };
  const result = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    text: "ไฟล์ที่ขอค่ะ", attachmentIds: [uploaded.json.attachment.id],
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(result.status, 202, result.text);
  assert.equal(result.json.sent, true);
  assert.equal(result.json.historyPending, true);
  assert.equal(line.calls.length, 1, "provider is called exactly once");
  const pending = db.listOperatorOutboundAttempts("accepted_pending");
  assert.equal(pending.length, 1);
  assert.doesNotMatch(pending[0].payload_json, /\/download[#/]/u, "recovery intent must not persist the bearer link");
  const held = db.getMessageAttachment(uploaded.json.attachment.id);
  assert.ok(held.send_claim_id);
  assert.equal(held.message_id, null);

  db.finalizeAcceptedOperatorOutboundAttempt = originalFinalize;
  assert.deepEqual(db.recoverAcceptedOperatorOutboundAttempts(), { attempted: 1, recovered: 1, failed: 0 });
  const message = db.messagesFor("U-route").find((row) => row.direction === "out");
  assert.ok(message);
  assert.equal(db.attachmentsForMessages([message.id]).length, 1);
  assert.equal(db.getOperatorOutboundAttempt(pending[0].id).status, "accepted");
  assert.equal(line.calls.length, 1, "history recovery never crosses LINE again");
});

test("media routes: partial LINE push preserves accepted file link, redacts history, and pauses AI", async (t) => {
  const { app, db, line } = await startMediaConsole(t, { failPushAt: 2 });
  const auth = await login(app.server);
  const uploaded = await upload(app.server, { ...auth, body: PDF_A, name: "partial.pdf" });
  assert.equal(uploaded.status, 201, uploaded.text);
  const result = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    text: "ดาวน์โหลดได้ที่นี่", attachmentIds: [uploaded.json.attachment.id], sticker: { packageId: "11537", stickerId: "52002739" },
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(result.status, 502, result.text);
  assert.equal(result.json.partiallyDelivered, 1);
  const token = tokenFromText(line.calls[0].messages[0].text);
  const deliveredFile = await redeemDownload(app.server, token);
  assert.equal(deliveredFile.status, 200, "provider accepted the text before the sticker failed, so its grant must remain valid");
  const customer = db.getCustomer("U-route");
  assert.ok(customer.operator_active_until > Date.now(), "any accepted operator bubble must pause AI even when a later bubble fails");
  const persisted = db.messagesFor("U-route").filter((message) => message.direction === "out");
  assert.equal(persisted.length, 1);
  assert.doesNotMatch(persisted[0].content, /\/download[#/]/u);
  assert.equal(db.attachmentsForMessages([persisted[0].id]).length, 1);
  assert.ok(db.listAudit().some((entry) => entry.action === "reply_partial"));
  const history = await httpRequest(app.server, {
    path: "/console/api/conversations/U-route/messages?limit=20",
    headers: { cookie: auth.cookie },
  });
  const partial = history.json.messages.find((message) => message.id === persisted[0].id);
  assert.equal(partial.delivery_status.state, "partial");
  assert.equal(partial.delivery_status.read_receipt_available, false);
});

test("media routes: partial provider prefix is durable and recovers without another LINE call", async (t) => {
  const { app, db, line } = await startMediaConsole(t, { failPushAt: 2 });
  const auth = await login(app.server);
  const uploaded = await upload(app.server, { ...auth, body: PDF_A, name: "partial-recover.pdf" });
  const originalFinalize = db.finalizeAcceptedOperatorOutboundAttempt;
  db.finalizeAcceptedOperatorOutboundAttempt = () => { throw new Error("forced partial history failure"); };
  const result = await postJson(app.server, "/console/api/conversations/U-route/reply", {
    text: "ไฟล์ยืนยันค่ะ", attachmentIds: [uploaded.json.attachment.id], sticker: { packageId: "11537", stickerId: "52002739" },
  }, { cookie: auth.cookie, "x-csrf-token": auth.csrf });
  assert.equal(result.status, 502, result.text);
  assert.equal(result.json.partiallyDelivered, 1);
  assert.equal(result.json.historyPending, true);
  assert.equal(line.calls.length, 2, "one accepted text call plus one failed sticker call");
  const pending = db.listOperatorOutboundAttempts("partial_pending");
  assert.equal(pending.length, 1);
  assert.doesNotMatch(pending[0].payload_json, /\/download[#/]/u);
  assert.equal(db.messagesFor("U-route").filter((row) => row.direction === "out").length, 0);

  db.finalizeAcceptedOperatorOutboundAttempt = originalFinalize;
  assert.deepEqual(db.recoverAcceptedOperatorOutboundAttempts(), { attempted: 1, recovered: 1, failed: 0 });
  const recovered = db.messagesFor("U-route").filter((row) => row.direction === "out");
  assert.equal(recovered.length, 1, "only the confirmed text prefix is recovered");
  assert.equal(db.attachmentsForMessages([recovered[0].id]).length, 1);
  assert.equal(db.getOperatorOutboundAttempt(pending[0].id).status, "partial");
  assert.equal(line.calls.length, 2, "history recovery must never call LINE again");
});

test("media routes: authenticated audio/video content supports valid ranges and rejects malformed ranges", async (t) => {
  const { app, db, dir } = await startMediaConsole(t);
  const { cookie } = await login(app.server);
  const store = createPrivateMediaStore({ dir, minFreeBytes: 0 });
  const audio = store.save({ buffer: MP3, name: "voice.mp3", origin: "line", kind: "audio" });
  const video = store.save({ buffer: MP4, name: "clip.mp4", origin: "line", kind: "video" });
  const audioId = db.addMessageAttachment({ customerId: "U-route", direction: "in", kind: "audio", status: "ready", originalName: "voice.mp3", mime: audio.mime, byteSize: audio.byteSize, storageKey: audio.storageKey });
  const videoId = db.addMessageAttachment({ customerId: "U-route", direction: "in", kind: "video", status: "ready", originalName: "clip.mp4", mime: video.mime, byteSize: video.byteSize, storageKey: video.storageKey });
  for (const id of [audioId, videoId]) {
    const partial = await httpRequest(app.server, { path: `/console/api/attachments/${id}/content`, headers: { cookie, range: "bytes=0-2" } });
    assert.equal(partial.status, 206, partial.text);
    assert.equal(partial.buffer.length, 3);
    assert.equal(partial.headers["accept-ranges"], "bytes");
    const malformed = await httpRequest(app.server, { path: `/console/api/attachments/${id}/content`, headers: { cookie, range: "bytes=wat" } });
    assert.equal(malformed.status, 416);
  }
});
