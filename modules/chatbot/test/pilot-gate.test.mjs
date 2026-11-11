import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { createPilotInvite } from "../src/pilotGate.mjs";
import { testConfig, memoryDb, hermesFetchStub, httpRequest, lineFetchStub, listen, poisonGlobalFetch, signLine, sleep, waitFor } from "./helpers.mjs";

poisonGlobalFetch();
const secret = "test-line-secret";
const silent = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const codeHash = (value) => createHash("sha256").update(value).digest("hex");
const pilotIdentityHash = `sha256:${"a".repeat(64)}`;
const pilotBindingHash = createHash("sha256").update(`line-pilot-binding-v1\u0000pngoung-tidkradum\u0000${pilotIdentityHash}`).digest("hex");

function privateState(initial = { version: 2, businessId: "pngoung-tidkradum", lineIdentityHash: pilotIdentityHash, bindingSha256: pilotBindingHash, allowedSubjectHashes: [], enrollmentUsedAt: null, audit: [{ event: "provider_identity_bound", businessId: "pngoung-tidkradum", identityHash: pilotIdentityHash, bindingSha256: pilotBindingHash }] }, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "chassis-pilot-"));
  const file = join(dir, "allowlist.json");
  writeFileSync(file, JSON.stringify(initial), { mode });
  chmodSync(file, mode);
  return file;
}

function pilotConfig(state, code = "pilot-secret") {
  return { LINE_PILOT_MODE: "true", LINE_PILOT_ALLOWLIST_FILE: state, LINE_PILOT_BOOTSTRAP_CODE_SHA256: codeHash(code), LINE_PILOT_BUSINESS_ID: "pngoung-tidkradum", LINE_PILOT_IDENTITY_HASH: pilotIdentityHash };
}

function body(id, userId, text, { destination = "" } = {}) {
  return JSON.stringify({
    ...(destination ? { destination } : {}),
    events: [{ type: "message", webhookEventId: `w-${id}`, replyToken: `rt-${id}`, source: { type: "user", userId }, message: { id, type: "text", text } }],
  });
}

async function started(t, configOverrides = {}) {
  const db = memoryDb();
  const lineFetch = lineFetchStub();
  const hermesFetch = hermesFetchStub();
  const app = createApp({ config: testConfig(configOverrides), db, overrides: { hermesFetch, lineFetch, sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, hermesFetch, lineFetch };
}

async function post(app, raw) {
  return httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers: { "content-type": "application/json", "x-line-signature": signLine(raw, secret) }, body: raw });
}

test("pilot off accepts multiple validly signed LINE users without an enrollment state", async (t) => {
  const { app, db, lineFetch, hermesFetch } = await started(t);
  const unsignedRaw = body("unsigned", "U-unsigned", "สวัสดีค่ะ");
  const unsigned = await httpRequest(app.server, { method: "POST", path: "/webhooks/line", headers: { "content-type": "application/json" }, body: unsignedRaw });
  assert.equal(unsigned.status, 403);
  assert.equal(db.getCustomer("U-unsigned"), null);
  const first = await post(app, body("off-1", "U-normal-1", "สวัสดีค่ะ"));
  const second = await post(app, body("off-2", "U-normal-2", "ขอรายละเอียดค่ะ"));
  assert.equal(first.status, 200);
  assert.equal(first.json.accepted, 1);
  assert.equal(second.status, 200);
  assert.equal(second.json.accepted, 1);
  await waitFor(() => lineFetch.sends.length >= 2 && hermesFetch.calls.length >= 2, 6000);
  assert.equal(db.getCustomer("U-normal-1")?.line_user_id, "U-normal-1");
  assert.equal(db.getCustomer("U-normal-2")?.line_user_id, "U-normal-2");
});

test("pilot nonallowlisted event is acknowledged without DB, profile, pipeline, or LINE send", async (t) => {
  const ownerHash = createHash("sha256").update("line-pilot-v1\u0000default\u0000U-owner").digest("hex");
  const state = privateState({
    version: 3, businessId: "pngoung-tidkradum", lineIdentityHash: pilotIdentityHash, bindingSha256: pilotBindingHash,
    allowedSubjectHashes: [ownerHash], enrollmentUsedAt: 1, invites: [],
    audit: [
      { event: "provider_identity_bound", businessId: "pngoung-tidkradum", identityHash: pilotIdentityHash, bindingSha256: pilotBindingHash },
      { event: "owner_subject_preprovisioned", at: 1, subjectHash: ownerHash },
    ],
  });
  const exactState = readFileSync(state, "utf8");
  const { app, db, hermesFetch, lineFetch } = await started(t, pilotConfig(state));
  const destination = "U-bot-destination";
  const blocked = await post(app, body("blocked", "U-blocked", "สอบถามค่ะ", { destination }));
  assert.equal(blocked.status, 200);
  assert.equal(blocked.json.accepted, 0);
  await sleep(30);
  assert.equal(db.getCustomer("U-blocked"), null);
  assert.equal(db.getSetting(`line_dest:${destination}`), null, "blocked-first event must not persist destination mapping");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS count FROM events_dedupe").get().count, 0);
  assert.equal(lineFetch.profileCalls.length, 0);
  assert.equal(hermesFetch.calls.length, 0);
  assert.equal(lineFetch.calls.length, 0);
  assert.equal(readFileSync(state, "utf8"), exactState, "blocked subject must not mutate the closed allowlist");

  const owner = await post(app, body("owner", "U-owner", "สวัสดีค่ะ", { destination }));
  assert.equal(owner.status, 200);
  assert.equal(owner.json.accepted, 1, "pre-provisioned owner must pass a signed webhook");
  assert.equal(db.getSetting(`line_dest:${destination}`), "default");
  await waitFor(() => hermesFetch.calls.length >= 1 && lineFetch.sends.length >= 1);
  assert.equal(db.getCustomer("U-owner")?.line_user_id, "U-owner");
  assert.equal(readFileSync(state, "utf8"), exactState, "authorized traffic must not widen the allowlist");
});

test("pilot exact one-time enrollment locks first user; later user message replies; other users remain blocked", async (t) => {
  const state = privateState();
  const config = pilotConfig(state);
  const { app, db, lineFetch } = await started(t, config);
  const enrolled = await post(app, body("enroll", "U-first", "/pilot pilot-secret"));
  assert.equal(enrolled.status, 200);
  assert.equal(enrolled.json.accepted, 0);
  assert.equal(db.getCustomer("U-first"), null, "bootstrap command is not customer content");
  const stateRead = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(stateRead.allowedSubjectHashes.length, 1);
  assert.equal(stateRead.audit[0].event, "provider_identity_bound");
  assert.equal(stateRead.audit[1].event, "first_user_enrolled");
  assert.equal(Object.hasOwn(stateRead.audit[1], "bootstrapCodeHash"), false, "audit keeps no reusable enrollment material");
  const allowed = await post(app, body("allowed", "U-first", "สวัสดีค่ะ"));
  assert.equal(allowed.json.accepted, 1);
  await waitFor(() => lineFetch.sends.length === 1);
  assert.ok(db.getCustomer("U-first"));
  const repeated = await post(app, body("repeat-enroll", "U-first", "/pilot pilot-secret"));
  assert.equal(repeated.json.accepted, 0);
  await sleep(20);
  assert.equal(db.messagesFor("U-first", 20).some((message) => String(message.content).startsWith("/pilot")), false);
  assert.equal(lineFetch.sends.length, 1);
  const later = await post(app, body("other", "U-other", "/pilot pilot-secret"));
  assert.equal(later.json.accepted, 0);
  await sleep(20);
  assert.equal(db.getCustomer("U-other"), null);
  assert.equal(lineFetch.sends.length, 1);
});

test("pilot central outbound guard blocks push, multicast, and loading to other recipients", async (t) => {
  const state = privateState();
  const { app, lineFetch } = await started(t, pilotConfig(state));
  await post(app, body("enroll2", "U-first", "/pilot pilot-secret"));
  const client = app.lineRegistry.forChannel("default");
  assert.equal((await client.sendBubbles({ to: "U-other", bubbles: ["hello"] })).reason, "pilot_not_allowlisted");
  assert.equal((await client.multicast({ to: ["U-first", "U-other"], messages: [{ type: "text", text: "hello" }] })).reason, "pilot_not_allowlisted");
  assert.equal((await client.startLoading({ to: "U-other" })).reason, "pilot_not_allowlisted");
  assert.equal(lineFetch.calls.length, 0);
});

test("pilot malformed or nonprivate configuration fails closed", async (t) => {
  const malformed = privateState({ invalid: true });
  const { app, db, lineFetch } = await started(t, pilotConfig(malformed));
  const res = await post(app, body("bad-state", "U-blocked", "สวัสดีค่ะ"));
  assert.equal(res.status, 200);
  assert.equal(res.json.accepted, 0);
  assert.equal(db.getCustomer("U-blocked"), null);
  assert.equal(lineFetch.calls.length, 0);
  const nonprivate = privateState(undefined, 0o644);
  const second = await started(t, pilotConfig(nonprivate));
  const blocked = await post(second.app, body("not-private", "U-nope", "สวัสดีค่ะ"));
  assert.equal(blocked.json.accepted, 0);
  assert.equal(second.db.getCustomer("U-nope"), null);
  const missing = await started(t, pilotConfig("/tmp/does-not-exist-pilot-state.json"));
  const missingResult = await post(missing.app, body("missing-state", "U-missing", "สวัสดีค่ะ"));
  assert.equal(missingResult.json.accepted, 0);
  assert.equal(missing.db.getCustomer("U-missing"), null);

  const tooMany = privateState({ version: 2, businessId: "pngoung-tidkradum", lineIdentityHash: pilotIdentityHash, bindingSha256: pilotBindingHash, allowedSubjectHashes: ["a".repeat(64), "b".repeat(64)], enrollmentUsedAt: null, audit: [{ event: "provider_identity_bound", businessId: "pngoung-tidkradum", identityHash: pilotIdentityHash, bindingSha256: pilotBindingHash }] });
  const third = await started(t, pilotConfig(tooMany));
  const multiResult = await post(third.app, body("too-many", "U-third", "สวัสดีค่ะ"));
  assert.equal(multiResult.json.accepted, 0);
  assert.equal(third.db.getCustomer("U-third"), null);
});

test("pilot state fails closed when its binding or filesystem target changes", async (t) => {
  const state = privateState();
  const { app, db } = await started(t, { ...pilotConfig(state), LINE_PILOT_IDENTITY_HASH: `sha256:${"b".repeat(64)}` });
  const mismatch = await post(app, body("identity-mismatch", "U-blocked", "สวัสดีค่ะ"));
  assert.equal(mismatch.json.accepted, 0);
  assert.equal(db.getCustomer("U-blocked"), null);
  const link = `${state}.link`;
  symlinkSync(state, link);
  const linked = await started(t, pilotConfig(link));
  const linkedResult = await post(linked.app, body("symlink", "U-blocked-2", "สวัสดีค่ะ"));
  assert.equal(linkedResult.json.accepted, 0);
  assert.equal(linked.db.getCustomer("U-blocked-2"), null);
});

test("staff invites are unique, one-time, bounded, and preserve the enrolled owner", async (t) => {
  const ownerHash = createHash("sha256").update("line-pilot-v1\u0000default\u0000U-owner").digest("hex");
  const state = privateState({
    version: 2, businessId: "pngoung-tidkradum", lineIdentityHash: pilotIdentityHash, bindingSha256: pilotBindingHash,
    allowedSubjectHashes: [ownerHash], enrollmentUsedAt: 1,
    audit: [{ event: "provider_identity_bound", businessId: "pngoung-tidkradum", identityHash: pilotIdentityHash, bindingSha256: pilotBindingHash }, { event: "first_user_enrolled", at: 1, subjectHash: ownerHash, bootstrapCodeHash: codeHash("pilot-secret") }],
  });
  const config = { linePilotAllowlistFile: state, linePilotBusinessId: "pngoung-tidkradum", linePilotIdentityHash: pilotIdentityHash, linePilotMaxEnrolledSubjects: 2 };
  const invite = createPilotInvite({ config, now: () => 10, randomBytesImpl: () => Buffer.alloc(32, 7) });
  assert.match(invite.command, /^\/pilot [A-Za-z0-9_-]{40,}$/u);
  const migrated = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.allowedSubjectHashes, [ownerHash]);
  assert.equal(migrated.invites.length, 1);
  assert.equal(JSON.stringify(migrated).includes(invite.command.slice(7)), false);

  const { app, db, lineFetch } = await started(t, { ...pilotConfig(state), LINE_PILOT_MAX_ENROLLED_SUBJECTS: "2" });
  const enrolled = await post(app, body("staff-enroll", "U-staff", invite.command));
  assert.equal(enrolled.json.accepted, 0);
  await sleep(10);
  const after = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(after.allowedSubjectHashes.length, 2);
  assert.ok(after.invites[0].consumedAt);
  assert.equal(after.invites[0].consumedSubjectHash.length, 64);
  const redelivery = await post(app, body("staff-redelivery", "U-staff", invite.command));
  assert.equal(redelivery.json.accepted, 0);
  assert.equal(db.getCustomer("U-staff"), null);
  assert.equal(lineFetch.calls.length, 0);
  assert.throws(() => createPilotInvite({ config, randomBytesImpl: () => Buffer.alloc(32, 9) }), /cap_reached/u);
});

test("staff invite audit remains provider-bound after its bounded history fills", () => {
  const ownerHash = createHash("sha256").update("line-pilot-v1\u0000default\u0000U-owner").digest("hex");
  const audit = [
    { event: "provider_identity_bound", businessId: "pngoung-tidkradum", identityHash: pilotIdentityHash, bindingSha256: pilotBindingHash },
    ...Array.from({ length: 63 }, (_, index) => ({ event: "staff_invite_created", at: index + 1 })),
  ];
  const state = privateState({
    version: 3, businessId: "pngoung-tidkradum", lineIdentityHash: pilotIdentityHash, bindingSha256: pilotBindingHash,
    allowedSubjectHashes: [ownerHash], enrollmentUsedAt: 1, invites: [], audit,
  });
  const config = { linePilotAllowlistFile: state, linePilotBusinessId: "pngoung-tidkradum", linePilotIdentityHash: pilotIdentityHash, linePilotMaxEnrolledSubjects: 25 };
  createPilotInvite({ config, now: () => 100, randomBytesImpl: () => Buffer.alloc(32, 3) });
  const after = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(after.audit.length, 64);
  assert.equal(after.audit[0].event, "provider_identity_bound");
  assert.equal(after.audit.at(-1).event, "staff_invite_created");
  assert.doesNotThrow(() => createPilotInvite({ config, now: () => 101, randomBytesImpl: () => Buffer.alloc(32, 4) }));
});

test("staff invite writer fails closed while another process owns the state lock", () => {
  const state = privateState({
    version: 3, businessId: "pngoung-tidkradum", lineIdentityHash: pilotIdentityHash, bindingSha256: pilotBindingHash,
    allowedSubjectHashes: [], enrollmentUsedAt: null, invites: [],
    audit: [{ event: "provider_identity_bound", businessId: "pngoung-tidkradum", identityHash: pilotIdentityHash, bindingSha256: pilotBindingHash }],
  });
  const lock = join(join(state, ".."), `.${state.split("/").at(-1)}.lock`);
  writeFileSync(lock, "", { mode: 0o600 });
  const config = { linePilotAllowlistFile: state, linePilotBusinessId: "pngoung-tidkradum", linePilotIdentityHash: pilotIdentityHash };
  assert.throws(() => createPilotInvite({ config }), /pilot_state_locked/u);
});

/* ---------------- v1.4.7: open enrollment (คำสั่งพี่ง้วง 2026-08-16) ---------------- */

test("open enrollment: คนใหม่ทักครั้งแรก = ลงทะเบียนอัตโนมัติ + ได้คำตอบทันที + ขาออกเปิดให้", async (t) => {
  const state = privateState();
  const { app, db, lineFetch } = await started(t, { ...pilotConfig(state), LINE_PILOT_OPEN_ENROLLMENT: "true" });
  const res = await post(app, body("open1", "U-stranger", "สวัสดีครับ สนใจเรียน AI"));
  assert.equal(res.status, 200);
  await waitFor(() => lineFetch.sends.length >= 1, 3000);
  assert.equal(db.getCustomer("U-stranger")?.line_user_id, "U-stranger", "ข้อความแรกต้องเข้า pipeline เลย");
  const saved = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(saved.allowedSubjectHashes.length, 1, "ต้องถูกบันทึกเข้า allowlist");
  assert.ok(saved.audit.some((entry) => entry.event === "open_enrollment"), "ต้องมี audit");

  // คนที่สอง — ลงทะเบียนเพิ่มได้ (หลายคนช่วยเทรน)
  await post(app, body("open2", "U-stranger-2", "ขอรายละเอียดคลาสค่ะ"));
  await waitFor(() => db.getCustomer("U-stranger-2") != null, 3000);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).allowedSubjectHashes.length, 2);
});

test("open enrollment: เพดานเต็ม = คนใหม่ถูกกันเงียบ (fail-closed) + /pilot ยังไม่ปนกับข้อความปกติ", async (t) => {
  const state = privateState();
  const { app, db, lineFetch } = await started(t, {
    ...pilotConfig(state), LINE_PILOT_OPEN_ENROLLMENT: "true", LINE_PILOT_MAX_ENROLLED_SUBJECTS: "1",
  });
  await post(app, body("cap1", "U-one", "สวัสดีครับ"));
  await waitFor(() => db.getCustomer("U-one") != null, 3000);
  const res = await post(app, body("cap2", "U-two", "สวัสดีค่ะ"));
  assert.equal(res.status, 200);
  assert.equal(res.json.accepted, 0, "เกินเพดาน = ack แต่ไม่รับ");
  await sleep(30);
  assert.equal(db.getCustomer("U-two"), null);
  // ข้อความ /pilot จากคนแปลกหน้าห้าม auto-enroll (ยังเป็น control-plane)
  const pilotMsg = await post(app, body("cap3", "U-three", "/pilot bogus-code"));
  assert.equal(pilotMsg.json.accepted, 0);
  assert.equal(db.getCustomer("U-three"), null);
});

test("open enrollment ปิด (default) = พฤติกรรมเดิมทุกอย่าง", async (t) => {
  const state = privateState();
  const { app, db } = await started(t, pilotConfig(state));
  const res = await post(app, body("closed", "U-x", "สวัสดีครับ"));
  assert.equal(res.json.accepted, 0);
  await sleep(30);
  assert.equal(db.getCustomer("U-x"), null);
});
