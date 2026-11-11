// G2a Console API — auth/CSRF ของ endpoint ใหม่, name edit (F2), reset (F6),
// followup create/cancel/toggle + settings switch (F5), score ใน messages/inbox (F3),
// quota + hot customers ใน overview (F7/F3)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { LEGACY_SOURCE_TAG, linkLegacyByName } from "../src/legacyLink.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t, { configOverrides = {}, lineStubOptions = {} } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, ...configOverrides });
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const lineFetch = lineFetchStub(lineStubOptions);
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, config, lineFetch };
}

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server, username = "nok") {
  const res = await postJson(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

const GOOD_PAYLOAD = JSON.stringify({
  score: 8, trend: "up", buying_signals: ["ถามวิธีจ่าย"],
  persona_read: { disc: "D", bank: "Action", reason: "อยากปิดเร็ว" },
  next_move: "สรุปโปรที่ approve แล้วส่งลิงก์ชำระเงิน", suggested_question: "สะดวกรับของวันไหนคะ",
});

/* ------------------------------- auth / CSRF -------------------------------- */

test("G2a endpoints: ไม่มี session -> 401 ทุกตัว (deny by default)", async (t) => {
  const { app } = await startConsole(t);
  const posts = [
    "/console/api/customers/U1/name",
    "/console/api/customers/U1/reset",
    "/console/api/customers/U1/forget",
    "/console/api/customers/U1/legacy-link",
    "/console/api/customers/U1/followup",
    "/console/api/customers/U1/followups",
    "/console/api/followups/x/cancel",
    "/console/api/settings/followup",
  ];
  for (const path of posts) {
    const res = await postJson(app.server, path, {});
    assert.equal(res.status, 401, path);
  }
  const get = await httpRequest(app.server, { path: "/console/api/settings/followup" });
  assert.equal(get.status, 401);
});

test("G2a endpoints: มี session แต่ไม่มี CSRF -> 403 ทุก mutating POST", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U1", {});
  const { cookie } = await login(app.server);
  const posts = [
    ["/console/api/customers/U1/name", { knownName: "บี" }],
    ["/console/api/customers/U1/reset", {}],
    ["/console/api/customers/U1/forget", { confirm: "ลืมลูกค้า" }],
    ["/console/api/customers/U1/legacy-link", { action: "confirm" }],
    ["/console/api/customers/U1/followup", { enabled: false }],
    ["/console/api/customers/U1/followups", { scheduledAt: Date.now() + 3_600_000 }],
    ["/console/api/followups/x/cancel", {}],
    ["/console/api/settings/followup", { enabled: true }],
  ];
  for (const [path, body] of posts) {
    const res = await postJson(app.server, path, body, { cookie });
    assert.equal(res.status, 403, path);
  }
});

/* ----------------------- v1.4.48: legacy-link review ----------------------- */

test("v1.4.48: ยืนยัน/ปฏิเสธ legacy candidate ผ่าน console เท่านั้น + audit", async (t) => {
  const { app, db } = await startConsole(t);
  const legacyId = "U-legacy-ref";
  db.upsertCustomer(legacyId, { displayName: "Tess" });
  db.addTag(legacyId, LEGACY_SOURCE_TAG, "human");
  db.addTag(legacyId, "customer", "human");
  db.addTag(legacyId, "AI Class", "human");
  db.setAiEnabled(legacyId, false, "customer_handover");

  db.upsertCustomer("U-real", { displayName: "Tess" });
  assert.equal(linkLegacyByName({ db, customerId: "U-real", logger: silent }).state, "candidate");
  // 2026-09-02: ห้องเก่ามีป้าย customer = ลูกค้าจริง ระบบจึงติดป้าย customer + ปิดบอทให้เอง
  // แต่ป้ายประวัติของอีกคน ("AI Class") ยังห้ามข้ามมาจนกว่าคนจะกดยืนยัน
  assert.deepEqual(db.listTags("U-real").map((row) => row.tag), ["customer"], "ชื่ออย่างเดียวยังห้ามคัดลอกป้ายประวัติ");
  assert.equal(db.getCustomer("U-real").ai_off_reason, "customer_handover");

  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  const confirm = await postJson(
    app.server,
    "/console/api/customers/U-real/legacy-link",
    { action: "confirm" },
    headers,
  );
  assert.equal(confirm.status, 200, confirm.text);
  assert.equal(confirm.json.state, "linked");
  // "customer" ไม่ถูกนับว่าคัดลอก เพราะระบบติดให้ไปแล้วตอนเจอว่าห้องเก่าเป็นลูกค้าจริง
  assert.deepEqual(confirm.json.copied.sort(), ["AI Class"]);
  assert.ok(db.listTags("U-real").some((row) => row.tag === "customer"));
  assert.equal(db.getCustomer("U-real").ai_enabled, 0);
  assert.equal(db.getCustomer("U-real").ai_off_reason, "customer_handover");
  assert.ok(db.listAudit().some((row) => row.action === "legacy_link_confirm" && row.operator === "nok"));
  assert.equal((await postJson(
    app.server,
    "/console/api/customers/U-real/legacy-link",
    { action: "confirm" },
    headers,
  )).status, 409, "candidate ที่ใช้แล้วต้องยืนยันซ้ำไม่ได้");

  db.upsertCustomer("U-reject", { displayName: "Tess" });
  assert.equal(linkLegacyByName({ db, customerId: "U-reject", logger: silent }).state, "candidate");
  const reject = await postJson(
    app.server,
    "/console/api/customers/U-reject/legacy-link",
    { action: "reject" },
    headers,
  );
  assert.equal(reject.status, 200, reject.text);
  assert.equal(reject.json.state, "rejected");
  assert.equal(db.getCustomer("U-reject").ai_enabled, 1);
  assert.deepEqual(db.listTags("U-reject"), []);
  assert.ok(db.listAudit().some((row) => row.action === "legacy_link_reject" && row.operator === "nok"));

  assert.equal((await postJson(
    app.server,
    "/console/api/customers/U-reject/legacy-link",
    { action: "accept" },
    headers,
  )).status, 400);
  assert.equal((await postJson(
    app.server,
    "/console/api/customers/U-missing/legacy-link",
    { action: "confirm" },
    headers,
  )).status, 404);
});

test("console parity: ค้นและโยง legacy ด้วยมือได้ครั้งเดียว พร้อม audit ที่ตรงการกระทำ", async (t) => {
  const { app, db } = await startConsole(t);
  const legacyId = "U-legacy-manual";
  db.upsertCustomer(legacyId, { displayName: "ชื่อห้องเก่า" });
  db.addTag(legacyId, LEGACY_SOURCE_TAG, "human");
  db.addTag(legacyId, "AI Class", "human");
  db.upsertCustomer("U-manual", { displayName: "ชื่อห้องใหม่" });
  db.upsertCustomer("U-other", { displayName: "อีกห้องหนึ่ง" });

  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  const candidates = await httpRequest(app.server, {
    path: "/console/api/customers/U-manual/legacy-candidates?q=" + encodeURIComponent("ชื่อห้องเก่า"),
    headers: { cookie },
  });
  assert.equal(candidates.status, 200, candidates.text);
  assert.deepEqual(candidates.json.candidates.map((row) => row.id), [legacyId]);

  const linked = await postJson(app.server, "/console/api/customers/U-manual/legacy-link", {
    action: "link", legacyId,
  }, headers);
  assert.equal(linked.status, 200, linked.text);
  assert.equal(linked.json.state, "linked");
  assert.ok(linked.json.copied.includes("AI Class"));
  const audit = db.listAudit().find((row) => row.action === "legacy_link_manual");
  assert.equal(audit?.operator, "nok");
  assert.match(audit?.detail || "", /โยงมือแล้ว/u);
  assert.doesNotMatch(audit?.detail || "", /ปฏิเสธ/u);

  const duplicate = await postJson(app.server, "/console/api/customers/U-other/legacy-link", {
    action: "link", legacyId,
  }, headers);
  assert.equal(duplicate.status, 409, duplicate.text);
});

test("console parity: ห้อง legacy อ่านอย่างเดียวและห้องจริงมีลิงก์ประวัติเดิม", async (t) => {
  const { app, db, lineFetch } = await startConsole(t);
  const legacyId = "U-legacy-readonly";
  const realId = "U-real-linked";
  db.upsertCustomer(legacyId, { displayName: "ชื่อเดียวกัน" });
  db.addTag(legacyId, LEGACY_SOURCE_TAG, "human");
  db.insertMessage({ customerId: legacyId, direction: "in", content: "ข้อความเก่า" });
  db.upsertCustomer(realId, { displayName: "ชื่อเดียวกัน" });
  assert.equal(linkLegacyByName({ db, customerId: realId, logger: silent }).state, "candidate");
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  assert.equal((await postJson(app.server, `/console/api/customers/${realId}/legacy-link`, { action: "confirm" }, headers)).status, 200);

  const blocked = await postJson(app.server, `/console/api/conversations/${legacyId}/reply`, { text: "ห้ามส่ง" }, headers);
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.json.code, "legacy_readonly");
  assert.equal(lineFetch.sends.length, 0);

  const room = await httpRequest(app.server, { path: `/console/api/conversations/${realId}/messages`, headers: { cookie } });
  assert.equal(room.status, 200, room.text);
  assert.deepEqual(room.json.legacyHistory, { id: legacyId, displayName: "ชื่อเดียวกัน", count: 1 });
  const inbox = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  assert.ok(inbox.json.conversations.some((row) => row.line_user_id === realId));
  assert.ok(!inbox.json.conversations.some((row) => row.line_user_id === legacyId), "linked legacy reference must not duplicate the real room");
});

test("console parity: มอบหมายผู้รับผิดชอบ กรองของฉัน และทำเป็นยังไม่อ่านได้", async (t) => {
  const { app, db } = await startConsole(t);
  db.createOperator({ username: "chom", passHash: PASS_HASH, displayName: "ชมพู่", role: "operator" });
  db.upsertCustomer("U-owner", { displayName: "ลูกค้า" });
  db.insertMessage({ customerId: "U-owner", direction: "in", content: "ข้อความใหม่" });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const me = await httpRequest(app.server, { path: "/console/api/me", headers: { cookie } });
  assert.deepEqual(me.json.operators.map((row) => row.username).sort(), ["chom", "nok"]);
  const assigned = await postJson(app.server, "/console/api/customers/U-owner/owner", { owner: "nok" }, headers);
  assert.equal(assigned.status, 200, assigned.text);
  assert.equal(db.getCustomer("U-owner").human_owner, "nok");
  const mine = await httpRequest(app.server, { path: "/console/api/inbox?segment=mine", headers: { cookie } });
  assert.deepEqual(mine.json.conversations.map((row) => row.line_user_id), ["U-owner"]);
  assert.equal(mine.json.counts.mine, 1);

  const opened = await httpRequest(app.server, { path: "/console/api/conversations/U-owner/messages", headers: { cookie } });
  assert.equal(opened.status, 200);
  assert.equal((await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } })).json.conversations[0].unread, 0);
  assert.equal((await postJson(app.server, "/console/api/customers/U-owner/unread", {}, headers)).status, 200);
  assert.equal((await httpRequest(app.server, { path: "/console/api/conversations/U-owner/messages?seen=0", headers: { cookie } })).status, 200);
  assert.equal((await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } })).json.conversations[0].unread, 1);
  assert.ok(db.listAudit().some((row) => row.action === "customer_owner_set"));
  assert.ok(db.listAudit().some((row) => row.action === "conversation_mark_unread"));
});

test("console parity: quick replies เติมร่างเท่านั้นและ owner แก้ชุดได้แบบ audit", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const initial = await httpRequest(app.server, { path: "/console/api/quick-replies", headers: { cookie } });
  assert.equal(initial.status, 200);
  assert.ok(initial.json.quickReplies.some((row) => row.key === "/ขอบคุณ"));

  const custom = [{ key: "/ทดสอบ", label: "เติมร่าง", text: "ร่างนี้ยังไม่ถูกส่ง" }];
  const saved = await postJson(app.server, "/console/api/quick-replies", { quickReplies: custom }, { cookie, "x-csrf-token": csrf });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(JSON.parse(db.getSetting("quick_replies_json")), custom);
  assert.ok(db.listAudit().some((row) => row.action === "quick_replies_update"));
  assert.equal((await postJson(app.server, "/console/api/quick-replies", { quickReplies: [{ key: "bad", text: "x" }] }, { cookie, "x-csrf-token": csrf })).status, 400);
});

test("console parity: ปิดเคสและปักหมุดโน้ตเป็น state ที่ audit ได้", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-resolve", {});
  const note = db.addHandoffNote({ customerId: "U-resolve", author: "nok", text: "เรื่องสำคัญ" });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const resolved = await postJson(app.server, "/console/api/customers/U-resolve/resolve", { resolved: true }, headers);
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(db.getCustomer("U-resolve").state, "RESOLVED");
  const resolvedInbox = await httpRequest(app.server, { path: "/console/api/inbox?segment=resolved", headers: { cookie } });
  assert.deepEqual(resolvedInbox.json.conversations.map((row) => row.line_user_id), ["U-resolve"]);

  const pinned = await postJson(app.server, `/console/api/notes/${note.id}/pin`, { pinned: true }, headers);
  assert.equal(pinned.status, 200, pinned.text);
  assert.equal(db.getHandoffNote(note.id).pinned, 1);
  assert.ok(db.listAudit().some((row) => row.action === "conversation_resolved"));
  assert.ok(db.listAudit().some((row) => row.action === "note_pin"));
});

/* ------------------------------ F2: name edit ------------------------------- */

test("F2: แก้ชื่อจริงจาก console -> บันทึก + audit; validation ครบ", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-name", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const res = await postJson(app.server, "/console/api/customers/U-name/name", { knownName: "พี่บี" }, headers);
  assert.equal(res.status, 200);
  assert.equal(res.json.customer.known_name, "พี่บี");
  assert.equal(db.getCustomer("U-name").known_name, "พี่บี");
  const audit = db.listAudit().find((a) => a.action === "name_edit");
  assert.equal(audit.operator, "nok");
  assert.equal(audit.target, "U-name");

  // ล้างชื่อได้ (ส่งค่าว่าง)
  const clear = await postJson(app.server, "/console/api/customers/U-name/name", { knownName: "" }, headers);
  assert.equal(clear.status, 200);
  assert.equal(db.getCustomer("U-name").known_name, "");

  // validation
  assert.equal((await postJson(app.server, "/console/api/customers/U-name/name", { knownName: "x".repeat(61) }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/customers/U-name/name", { knownName: 123 }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/customers/U-ghost/name", { knownName: "บี" }, headers)).status, 404);
});

test("ป้ายซ้ำ: ตอบชัดว่าเคยมีแล้วและไม่เขียน audit ซ้ำ", async (t) => {
  const { app, db } = await startConsole(t);
  const customerId = "U-tag-duplicate";
  db.upsertCustomer(customerId, {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const first = await postJson(
    app.server,
    `/console/api/customers/${customerId}/tags`,
    { add: "customer" },
    headers,
  );
  assert.equal(first.status, 200, first.text);
  assert.equal(db.listTags(customerId).filter((row) => row.tag === "customer").length, 1);

  const duplicate = await postJson(
    app.server,
    `/console/api/customers/${customerId}/tags`,
    { add: "  customer  " },
    headers,
  );
  assert.equal(duplicate.status, 409, duplicate.text);
  assert.equal(duplicate.json.error, "ป้ายนี้มีอยู่แล้ว");
  assert.equal(db.listTags(customerId).filter((row) => row.tag === "customer").length, 1);
  assert.equal(
    db.listAudit().filter((row) => row.action === "tag_add" && row.target === customerId).length,
    1,
    "การกดป้ายซ้ำต้องไม่สร้าง audit ปลอม",
  );

  const caseSensitive = await postJson(
    app.server,
    `/console/api/customers/${customerId}/tags`,
    { add: "Customer" },
    headers,
  );
  assert.equal(caseSensitive.status, 200, caseSensitive.text);
  assert.ok(db.listTags(customerId).some((row) => row.tag === "Customer"));
});

/* --------------------------- F5: followup endpoints -------------------------- */

test("F5: สร้างนัด -> pending + audit; validation เวลา/โน้ต/ลูกค้า", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-fu", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  const at = Date.now() + 3_600_000;

  const res = await postJson(app.server, "/console/api/customers/U-fu/followups",
    { scheduledAt: at, note: "ลูกค้ารอเทียบรุ่น" }, headers);
  assert.equal(res.status, 200);
  assert.equal(res.json.followup.status, "pending");
  assert.equal(res.json.followup.scheduled_at, at);
  assert.equal(res.json.followup.note, "ลูกค้ารอเทียบรุ่น");
  assert.equal(res.json.followup.created_by, "nok");
  const audit = db.listAudit().find((a) => a.action === "followup_create");
  assert.equal(audit.target, "U-fu");

  // เวลาย้อนหลัง / โน้ตยาวเกิน / ลูกค้าไม่มีจริง
  assert.equal((await postJson(app.server, "/console/api/customers/U-fu/followups", { scheduledAt: Date.now() - 3_600_000 }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/customers/U-fu/followups", { scheduledAt: at, note: "x".repeat(301) }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/customers/U-ghost/followups", { scheduledAt: at }, headers)).status, 404);
});

test("F5: ยกเลิกนัด -> cancelled + audit; ซ้ำ = 409, ไม่มีจริง = 404", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-cancel", {});
  const fu = db.createFollowup({ customerId: "U-cancel", scheduledAt: Date.now() + 3_600_000, createdBy: "nok" });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const res = await postJson(app.server, `/console/api/followups/${fu.id}/cancel`, {}, headers);
  assert.equal(res.status, 200);
  assert.equal(res.json.followup.status, "cancelled");
  assert.ok(db.listAudit().some((a) => a.action === "followup_cancel" && a.target === fu.id));

  assert.equal((await postJson(app.server, `/console/api/followups/${fu.id}/cancel`, {}, headers)).status, 409);
  assert.equal((await postJson(app.server, "/console/api/followups/ghost/cancel", {}, headers)).status, 404);
});

test("F5: toggle follow-up ต่อลูกค้า + audit", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-toggle", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const off = await postJson(app.server, "/console/api/customers/U-toggle/followup", { enabled: false }, headers);
  assert.equal(off.status, 200);
  assert.equal(db.getCustomer("U-toggle").followup_enabled, 0);
  const on = await postJson(app.server, "/console/api/customers/U-toggle/followup", { enabled: true }, headers);
  assert.equal(on.status, 200);
  assert.equal(db.getCustomer("U-toggle").followup_enabled, 1);
  assert.equal((await postJson(app.server, "/console/api/customers/U-toggle/followup", { enabled: "yes" }, headers)).status, 400);
  assert.equal(db.listAudit().filter((a) => a.action === "followup_toggle").length, 2);
});

test("F5: สวิตช์ global runtime — GET สถานะ + POST สลับ เก็บใน DB + audit", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  // default: env FOLLOWUP_ENABLED ไม่ตั้ง = false, ไม่มี override
  const before = await httpRequest(app.server, { path: "/console/api/settings/followup", headers: { cookie } });
  assert.equal(before.status, 200);
  assert.equal(before.json.enabled, false);
  assert.equal(before.json.runtimeOverride, null);

  const flip = await postJson(app.server, "/console/api/settings/followup", { enabled: true }, headers);
  assert.equal(flip.status, 200);
  assert.equal(flip.json.enabled, true);
  assert.equal(db.getSetting("followup_enabled"), "1");
  assert.ok(db.listAudit().some((a) => a.action === "followup_global_toggle" && a.detail === "on"));

  const after = await httpRequest(app.server, { path: "/console/api/settings/followup", headers: { cookie } });
  assert.equal(after.json.enabled, true);
  assert.equal(after.json.runtimeOverride, "1");

  assert.equal((await postJson(app.server, "/console/api/settings/followup", { enabled: "on" }, headers)).status, 400);
});

/* --------------------------------- F6: reset -------------------------------- */

test("F6+M3: test reset ล้างประวัติแต่คง identity และไม่สร้าง restore tombstone", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-reset", { displayName: "คุณโบว์" });
  db.setKnownName("U-reset", "โบว์");
  db.setAiEnabled("U-reset", false);
  db.setNeedsHuman("U-reset", "test");
  db.insertMessage({ customerId: "U-reset", direction: "in", content: "เก่า" });
  db.recordScore("U-reset", 9, GOOD_PAYLOAD);
  db.createFollowup({ customerId: "U-reset", scheduledAt: Date.now() + 3_600_000 });
  db.addCorrection({ customerId: "U-reset", aiDraft: "ร่าง" });
  // M3: ร่องรอยที่อ้างถึงลูกค้าใน audit + สถานะ ack เวลาทำการ ต้องถูกลบด้วย (PDPA erasure)
  db.addAudit({ operator: "nok", action: "ai_toggle", target: "U-reset", detail: "off" });
  db.addAudit({ operator: "nok", action: "reply", target: "U-reset", detail: "ข้อความเดิม" });
  db.setSetting("schedule_ack:U-reset", "1723200000000");
  const { cookie, csrf } = await login(app.server);

  const res = await postJson(app.server, "/console/api/customers/U-reset/reset", {}, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  const c = res.json.customer;
  assert.equal(c.display_name, "คุณโบว์", "คง display_name");
  assert.equal(c.known_name, "");
  assert.equal(c.ai_enabled, 1);
  assert.equal(c.state, "AI_ACTIVE");
  assert.equal(c.last_score, null);
  assert.equal(db.messagesFor("U-reset").length, 0);
  assert.equal(db.latestScoreRow("U-reset"), null);
  assert.equal(db.listFollowupsFor("U-reset").length, 0);
  assert.equal(db.listCorrections("candidate").length, 0);
  // M3: audit ที่อ้างถึงลูกค้าเหลือแถวเดียว = reset_customer (หลักฐานการลบ ไม่มีเนื้อหาลูกค้า)
  const refs = db.listAudit().filter((a) => a.target === "U-reset" || String(a.detail).includes("U-reset"));
  assert.equal(refs.length, 1, "ต้องเหลือแถวอ้างถึงลูกค้าแถวเดียว");
  assert.equal(refs[0].action, "reset_customer");
  assert.equal(refs[0].operator, "nok");
  assert.ok(!refs[0].detail.includes("ข้อความเดิม"), "ห้ามมีเนื้อหาลูกค้าในแถวที่เหลือ");
  assert.equal(db.getSetting("schedule_ack:U-reset"), null, "สถานะ ack ต้องถูกลบ");
  assert.ok(db.listAudit().some((a) => a.action === "login"), "audit อื่นที่ไม่อ้างลูกค้ายังอยู่");

  assert.equal((await postJson(app.server, "/console/api/customers/U-ghost/reset", {}, { cookie, "x-csrf-token": csrf })).status, 404);
});

test("PDPA forget: ต้องยืนยันตรงคำ ลบ identity จริง และเหลือเฉพาะ tombstone/audit ที่ไม่เก็บ raw ID", async (t) => {
  const { app, db } = await startConsole(t);
  const customerId = "U-forget-from-console";
  db.upsertCustomer(customerId, { displayName: "ลูกค้าที่ขอให้ลืม" });
  db.setKnownName(customerId, "ชื่อจริงที่ต้องถูกลบ");
  db.setLegacyLink(customerId, "legacy:private-link");
  db.insertMessage({ customerId, direction: "in", content: "ข้อมูลส่วนตัว" });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const wrong = await postJson(app.server, `/console/api/customers/${customerId}/forget`, { confirm: "ผิด" }, headers);
  assert.equal(wrong.status, 400);
  assert.ok(db.getCustomer(customerId), "ยืนยันผิดต้องไม่ลบอะไร");
  assert.equal(db.listCustomerTombstones().length, 0);

  const forgotten = await postJson(app.server, `/console/api/customers/${customerId}/forget`, { confirm: "ลืมลูกค้า" }, headers);
  assert.equal(forgotten.status, 200, forgotten.text);
  assert.deepEqual(forgotten.json, { ok: true, forgotten: true });
  assert.equal(db.getCustomer(customerId), null);
  assert.equal(db.messagesFor(customerId, 10, { includeArchived: true }).length, 0);
  const tombstones = db.listCustomerTombstones();
  assert.equal(tombstones.length, 1);
  assert.equal(JSON.stringify(tombstones).includes(customerId), false, "tombstone ต้องมีแต่ hash");
  const audit = db.listAudit().find((row) => row.action === "forget_customer");
  assert.ok(audit);
  assert.equal(`${audit.target} ${audit.detail}`.includes(customerId), false, "audit หลังลืมห้ามคืน raw ID กลับมา");
});

/* ------------------------- F3: score ใน messages/inbox ----------------------- */

test("F3: messages endpoint แนบ score + followups + followupGlobal", async (t) => {
  const { app, db } = await startConsole(t);
  db.setSetting("scorer_suggestions_enabled", "1"); // This fixture explicitly requests advice.
  db.upsertCustomer("U-msg", {});
  db.insertMessage({ customerId: "U-msg", direction: "in", content: "สนใจค่ะ" });
  db.recordScore("U-msg", 8, GOOD_PAYLOAD);
  db.createFollowup({ customerId: "U-msg", scheduledAt: Date.now() + 3_600_000, createdBy: "nok", note: "ตามต่อ" });
  const { cookie } = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/conversations/U-msg/messages", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.score.score, 8);
  assert.equal(res.json.score.payload.persona_read.disc, "D");
  assert.equal(res.json.score.payload.suggested_question, "สะดวกรับของวันไหนคะ");
  assert.equal(res.json.followups.length, 1);
  assert.equal(res.json.followups[0].note, "ตามต่อ");
  assert.equal(res.json.followupGlobal, false);
  // ลูกค้าไม่มี score -> score = null (หน้าเว็บโชว์ "ยังไม่มี score")
  db.upsertCustomer("U-blank", {});
  const blank = await httpRequest(app.server, { path: "/console/api/conversations/U-blank/messages", headers: { cookie } });
  assert.equal(blank.json.score, null);
});

test("F3: inbox แนบ known_name + last_score + picture_url", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-inbox", { displayName: "คุณเอ" });
  db.setKnownName("U-inbox", "เอ");
  db.setProfile("U-inbox", { pictureUrl: "https://line.mock/a.jpg" });
  db.recordScore("U-inbox", 6, "{}");
  db.insertMessage({ customerId: "U-inbox", direction: "in", content: "ทัก" });
  const { cookie } = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  const row = res.json.conversations.find((c) => c.line_user_id === "U-inbox");
  assert.equal(row.known_name, "เอ");
  assert.equal(row.last_score, 6);
  assert.equal(row.picture_url, "https://line.mock/a.jpg");
});

/* ------------------------- F7 + F3: overview additions ----------------------- */

test("F7: overview แนบ quota (limited) + hot customers + followupGlobal", async (t) => {
  const { app, db } = await startConsole(t, {
    lineStubOptions: { quota: { type: "limited", value: 1000 }, consumption: { totalUsage: 720 } },
  });
  db.upsertCustomer("U-hot1", {});
  db.recordScore("U-hot1", 9, "{}");
  db.upsertCustomer("U-warm", {});
  db.recordScore("U-warm", 6, "{}");
  db.upsertCustomer("canary:synthetic", {});
  db.recordScore("canary:synthetic", 10, "{}");
  const { cookie } = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/overview", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.quota.type, "limited");
  assert.equal(res.json.quota.value, 1000);
  assert.equal(res.json.quota.totalUsage, 720);
  assert.equal(res.json.stats.hotCustomers, 1, "hot = score >= 8 ไม่นับ canary");
  assert.equal(res.json.followupGlobal, false);
});

test("F7: overview quota type none + quota พัง -> null โดยหน้า overview ยัง 200", async (t) => {
  const none = await startConsole(t, {
    lineStubOptions: { quota: { type: "none" }, consumption: { totalUsage: 5 } },
  });
  const noneLogin = await login(none.app.server);
  const noneRes = await httpRequest(none.app.server, { path: "/console/api/overview", headers: { cookie: noneLogin.cookie } });
  assert.equal(noneRes.json.quota.type, "none");
  assert.equal(noneRes.json.quota.value, null);

  const broken = await startConsole(t); // stub default = endpoint พัง
  const brokenLogin = await login(broken.app.server);
  const brokenRes = await httpRequest(broken.app.server, { path: "/console/api/overview", headers: { cookie: brokenLogin.cookie } });
  assert.equal(brokenRes.status, 200, "โควตาพังห้ามลากหน้า overview ล้ม");
  assert.equal(brokenRes.json.quota, null);
});

/* ------------------------ v1.4.47: สวิตช์หยุด AI ทั้งระบบ ------------------------ */

test("v1.4.47: /settings/ai-pause — ไม่มี session 401, ไม่มี CSRF 403, สลับได้ + audit + ชนะ env", async (t) => {
  const { app, db } = await startConsole(t);
  assert.equal((await httpRequest(app.server, { path: "/console/api/settings/ai-pause" })).status, 401);
  const { cookie, csrf } = await login(app.server);
  assert.equal((await postJson(app.server, "/console/api/settings/ai-pause", { paused: true }, { cookie })).status, 403);

  const headers = { cookie, "x-csrf-token": csrf };
  db.createOperator({ username: "admin-test", passHash: PASS_HASH, displayName: "แอดมิน", role: "admin" });
  const admin = await login(app.server, "admin-test");
  const adminHeaders = { cookie: admin.cookie, "x-csrf-token": admin.csrf };
  assert.equal((await httpRequest(app.server, { path: "/console/api/settings/ai-pause", headers: { cookie: admin.cookie } })).status, 200);
  assert.equal((await postJson(app.server, "/console/api/settings/ai-pause", { paused: false }, adminHeaders)).status, 403);
  assert.equal((await postJson(app.server, "/console/api/settings/ai-pause", { draftMode: true }, adminHeaders)).status, 403);
  const initial = await httpRequest(app.server, { path: "/console/api/settings/ai-pause", headers });
  assert.equal(initial.status, 200);
  assert.equal(initial.json.paused, false);
  assert.equal(initial.json.draftMode, false);

  const pause = await postJson(app.server, "/console/api/settings/ai-pause", { paused: true }, headers);
  assert.equal(pause.status, 200);
  assert.equal(pause.json.paused, true);
  assert.equal(db.getSetting("ai_paused"), "1");
  assert.ok(db.listAudit().some((a) => a.action === "ai_pause_toggle" && a.detail === "paused"));

  const draftOn = await postJson(app.server, "/console/api/settings/ai-pause", { draftMode: true }, headers);
  assert.equal(draftOn.status, 200);
  assert.equal(draftOn.json.paused, true);
  assert.equal(draftOn.json.draftMode, true);
  assert.equal(db.getSetting("ai_paused_draft_mode"), "1");
  assert.ok(db.listAudit().some((a) => a.action === "ai_pause_draft_toggle" && a.detail === "draft_on"));

  const draftReadback = await httpRequest(app.server, { path: "/console/api/settings/ai-pause", headers });
  assert.equal(draftReadback.status, 200);
  assert.equal(draftReadback.json.draftMode, true);

  const draftOff = await postJson(app.server, "/console/api/settings/ai-pause", { draftMode: false }, headers);
  assert.equal(draftOff.status, 200);
  assert.equal(draftOff.json.draftMode, false);
  assert.equal(db.getSetting("ai_paused_draft_mode"), "0");
  assert.ok(db.listAudit().some((a) => a.action === "ai_pause_draft_toggle" && a.detail === "draft_off"));

  const kick = await postJson(app.server, "/console/api/settings/ai-pause", { paused: false }, headers);
  assert.equal(kick.status, 200);
  assert.equal(kick.json.paused, false);
  assert.ok(db.listAudit().some((a) => a.action === "ai_pause_toggle" && a.detail === "kick_off"));

  const bad = await postJson(app.server, "/console/api/settings/ai-pause", { paused: "yes" }, headers);
  assert.equal(bad.status, 400);
  const badDraft = await postJson(app.server, "/console/api/settings/ai-pause", { draftMode: "yes" }, headers);
  assert.equal(badDraft.status, 400);
});

// audit 2026-08-26 (วิกฤต): สวิตช์ "Follow-up ทั้งระบบ" เคยเป็นสวิตช์หลอก
// มันเขียนแค่ followup_enabled ซึ่งเป็นของ followupEngine ตัวเก่าที่ไม่มีวันทำงาน
// บนเครื่องนี้ (launcher ตรึง FOLLOWUP_INTERVAL_MS=0)
// ตัวที่ส่งข้อความจริงคือ stagedFollowups ซึ่งอ่าน staged_followup_enabled
// ผลคือกดปิดแล้วเห็น "ปิดอยู่" แต่ข้อความยังถูกส่งออกไปเรื่อย ๆ
// นี่คือปุ่มหยุดฉุกเฉิน — ต้องหยุดของจริงได้
test("follow-up switch: ต้องคุมเครื่องยนต์ที่ส่งจริง ไม่ใช่แค่ตัวเก่าที่ตายแล้ว", async (t) => {
  const { app, db } = await startConsole(t);
  const auth = await login(app.server);

  const hdr = { cookie: auth.cookie, "x-csrf-token": auth.csrf };
  const on = await postJson(app.server, "/console/api/settings/followup", { enabled: true }, hdr);
  assert.equal(on.status, 200, on.text);
  assert.equal(db.getSetting("followup_enabled"), "1");
  assert.equal(db.getSetting("staged_followup_enabled"), "1", "ต้องเปิดเครื่องยนต์ที่ส่งจริงด้วย");

  const off = await postJson(app.server, "/console/api/settings/followup", { enabled: false }, hdr);
  assert.equal(off.status, 200, off.text);
  assert.equal(db.getSetting("followup_enabled"), "0");
  assert.equal(db.getSetting("staged_followup_enabled"), "0", "ปุ่มหยุดต้องหยุดของจริงได้");

  // และต้องรายงานตรง ๆ ว่าตัวจับเวลานัดหมายติดเครื่องอยู่หรือไม่
  const status = await httpRequest(app.server, {
    path: "/console/api/settings/followup", headers: { cookie: auth.cookie },
  });
  assert.equal(status.status, 200);
  assert.equal(typeof status.json.appointmentArmed, "boolean",
    "หน้าเว็บต้องรู้ว่านัดที่บันทึกไว้จะถูกส่งจริงไหม");
  assert.equal(typeof status.json.stagedEnabled, "boolean");
});
