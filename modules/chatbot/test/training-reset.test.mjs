import test from "node:test";
import assert from "node:assert/strict";
import { createConfig } from "../src/config.mjs";
import { createApp } from "../src/server.mjs";
import { deliverTrainingResetAcknowledgement, isTrainingResetCommand, normalizeTrainingCommand, parseTrainingResetCommand, TRAINING_RESET_ACK } from "../src/trainingCommands.mjs";
import { AUDIO_FALLBACK_TEMPLATE } from "../src/pipeline.mjs";
import { hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, signLine, sleep, testConfig, waitFor } from "./helpers.mjs";

poisonGlobalFetch();
const secret = "test-line-secret";
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function payload({ id = "reset-1", userId = "U-reset", text = "/reset" } = {}) {
  return JSON.stringify({ events: [{
    type: "message", webhookEventId: `w-${id}`, replyToken: `rt-${id}`,
    source: { type: "user", userId }, message: { id, type: "text", text },
  }] });
}

async function start(t, configOverrides = {}) {
  const db = memoryDb();
  const lineFetch = lineFetchStub();
  const hermes = hermesFetchStub("สวัสดีค่ะ อยากเรียนเรื่องไหนเป็นพิเศษคะ");
  const app = createApp({ config: testConfig(configOverrides), db, overrides: { lineFetch, hermesFetch: hermes, sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, lineFetch, hermes };
}

async function post(app, raw) {
  return httpRequest(app.server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, secret) }, body: raw,
  });
}

// v1.2.6 (คำสั่งพี่ง้วง 2026-08-13): ผู้ทดสอบพิมพ์ feedback ต่อท้าย /reset ได้แล้ว
// แต่กติกาความปลอดภัยเดิมยังอยู่ครบ — ต้องขึ้นต้นด้วย "/reset" เท่านั้น
test("training reset command normalization is outer-only and anchored at the start", () => {
  assert.equal(normalizeTrainingCommand(" \u200B/reset\uFEFF "), "/reset");
  assert.equal(isTrainingResetCommand("\t /reset \n"), true);
  for (const value of ["/reset/", "/ reset", "hello /reset", "/reset\u200Bmore", "ขอ /reset หน่อย"]) {
    assert.equal(isTrainingResetCommand(value), false, value);
  }
  assert.deepEqual(parseTrainingResetCommand("/reset ตอบช้าไป ไม่เรียกชื่อ"), {
    isReset: true, feedback: "ตอบช้าไป ไม่เรียกชื่อ",
  });
  assert.deepEqual(parseTrainingResetCommand("/reset"), { isReset: true, feedback: "" });
  assert.equal(isTrainingResetCommand("/RESET"), true);
  assert.equal(isTrainingResetCommand("/Reset"), true);
  assert.equal(isTrainingResetCommand("\u200C/reset\u200D"), true);
});

test("TRAINING_COMMANDS_CHANNELS is a validated, fail-closed channel allowlist", () => {
  const defaults = createConfig({});
  assert.deepEqual(defaults.trainingCommandChannels, []);
  assert.equal(defaults.retentionDays.trainingCandidate, 90, "temporary training artifacts follow the owner-approved 90-day policy");
  assert.deepEqual(createConfig({ TRAINING_COMMANDS_CHANNELS: " default,training-only,canary,bad id,default " }).trainingCommandChannels,
    ["default", "training-only"]);
});

test("/reset และ /fb นอก TRAINING_COMMANDS_CHANNELS เป็นข้อความลูกค้าปกติและห้ามแตะ training state", async (t) => {
  const { app, db } = await start(t, { TRAINING_COMMANDS_CHANNELS: "training-only" });
  const userId = "U-live-command";
  db.upsertCustomer(userId, { displayName: "ผู้ใช้ทดสอบ", channelId: "default" });
  db.insertMessage({ customerId: userId, direction: "in", content: "บริบทเดิม" });
  const sessionBefore = db.activeConversationSession(userId).id;

  const resetResponse = await post(app, payload({ id: "live-reset", userId, text: "/reset ห้ามหมุน" }));
  assert.equal(resetResponse.status, 200);
  const feedbackResponse = await post(app, payload({ id: "live-feedback", userId, text: "/fb ห้ามเก็บ" }));
  assert.equal(feedbackResponse.status, 200);
  await waitFor(() => db.messagesFor(userId).filter((row) => row.direction === "in").some((row) => row.content === "/fb ห้ามเก็บ"));

  assert.equal(db.activeConversationSession(userId).id, sessionBefore, "คำสั่งจาก OA จริงต้องไม่ rotate session");
  assert.equal(db.listTrainingCandidates().length, 0, "ห้ามสร้าง training candidate");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM training_feedback WHERE customer_id = ?").get(userId).n, 0,
    "ห้ามบันทึก feedback จาก OA ที่ไม่ได้ allowlist");
  assert.ok(db.messagesFor(userId).some((row) => row.direction === "in" && row.content === "/reset ห้ามหมุน"));
});

test("/reset rotates the active session, stores an owner-pending snapshot, and never calls model", async (t) => {
  const { app, db, lineFetch, hermes } = await start(t);
  db.upsertCustomer("U-reset", { displayName: "คุณพิม", channelId: "default" });
  db.setDoNotDisturb("U-reset", true);
  db.setKnownName("U-reset", "พิม");
  db.setAiEnabled("U-reset", false);
  db.insertMessage({ customerId: "U-reset", direction: "in", content: "สนใจ AI agent ค่ะ" });
  db.insertMessage({ customerId: "U-reset", direction: "out", content: "ได้เลยค่ะ ตอนนี้ทำธุรกิจอะไรอยู่คะ" });
  db.recordScore("U-reset", 9, "{}");
  db.setNeedsHuman("U-reset", "test");
  db.addHandoffNote({ customerId: "U-reset", author: "operator", text: "กำลังรับช่วง" });
  db.createFollowup({ customerId: "U-reset", scheduledAt: Date.now() + 60_000, note: "ติดตาม" });
  db.setOperatorActiveUntil("U-reset", Date.now() + 60_000);
  // จังหวะราคา: ห้องนี้ผ่านทั้งการคัดกรอง การแจ้งราคา และการเลี่ยงด้วยคำถามสอนสด/ออนไลน์มาแล้ว
  db.markPriceDeferred("U-reset");
  db.markPriceQuoted("U-reset");
  db.markCustomerContextKnown("U-reset");
  db.markOnlinePivotDeferred("U-reset");
  db.markMoneySeen?.("U-reset");
  const old = db.activeConversationSession("U-reset");

  const response = await post(app, payload());
  assert.equal(response.status, 200);
  assert.equal(response.json.accepted, 0, "control does not enter normal pipeline queue");
  await waitFor(() => lineFetch.sends.length === 1);
  assert.equal(lineFetch.sends[0].body.messages[0].text, TRAINING_RESET_ACK);
  assert.equal(hermes.calls.length, 0, "reset must not call Sol/Luna");
  assert.equal(db.messagesFor("U-reset").some((row) => row.content === "/reset"), false);

  const candidate = db.listTrainingCandidates({ status: "pending_owner_confirmation" })[0];
  assert.equal(candidate.status, "pending_owner_confirmation");
  assert.equal(candidate.ack_status, "sent");
  assert.equal(candidate.message_count, 2);
  assert.deepEqual(JSON.parse(candidate.transcript_json).map((row) => row.content), ["สนใจ AI agent ค่ะ", "ได้เลยค่ะ ตอนนี้ทำธุรกิจอะไรอยู่คะ"]);
  const oldSession = db.raw.prepare("SELECT * FROM conversation_sessions WHERE id = ?").get(old.id);
  assert.equal(oldSession.status, "rotated");
  const next = db.activeConversationSession("U-reset");
  assert.notEqual(next.id, old.id);
  assert.deepEqual(db.recentTurns("U-reset"), [], "new prompt context never sees the prior training session or control ack");
  db.insertMessage({ customerId: "U-reset", direction: "in", content: "เริ่มเรื่องใหม่ค่ะ" });
  assert.deepEqual(db.recentTurns("U-reset").map((turn) => turn.content), ["เริ่มเรื่องใหม่ค่ะ"]);
  const customer = db.getCustomer("U-reset");
  assert.equal(customer.ai_enabled, 0, "human-owned AI-off state must survive a training boundary");
  assert.equal(customer.state, "NEEDS_HUMAN", "handoff ownership must survive a training boundary");
  assert.ok(customer.operator_active_until > 0, "operator window must survive a training boundary");
  assert.equal(customer.last_score, null);
  assert.equal(customer.do_not_disturb, 1, "business consent/DND remains untouched");
  assert.equal(customer.known_name, "พิม", "known identity remains available");
  assert.equal(db.listHandoffNotes("U-reset").length, 1, "handoff note remains available to the team");
  assert.equal(db.listFollowupsFor("U-reset").length, 1, "follow-up remains available to the team");

  // ตรวจปรปักษ์ 2026-09-04 (Mandate 3): /reset หมุน session ให้เป็นบทสนทนาใหม่ แต่หมุด
  // จังหวะราคาทั้งชุดเคยค้างอยู่ — ห้องที่ "เพิ่งเริ่มใหม่" จึงถูกอ่านว่าเคยคัดกรอง/เคยได้ราคา
  // แล้วเทราคาใส่ข้อความแรกของรอบเทรน ทีมงานจึงไม่มีทางทดสอบเส้นทางคนแปลกหน้าได้เลย
  assert.equal(Number(customer.price_deferred_at), 0, "โควตาคัดกรองต้องคืนมาพร้อมบทสนทนาใหม่");
  assert.equal(Number(customer.price_quoted_at), 0, "หมุด 'ราคาถึงมือแล้ว' ต้องไม่ข้ามบทสนทนา");
  assert.equal(Number(customer.known_context_at), 0, "หมุดบริบทมาจาก scorer ซึ่งถูกล้างไปพร้อมกัน");
  assert.equal(Number(customer.price_pivot_deferred_at), 0, "โควตาเลี่ยงสอนสด/ออนไลน์ต้องคืนมาด้วย");
});

test("AI paused: /reset และ /fb ถูกเก็บเป็น inbound ปกติแต่ห้ามส่ง ACK/เรียกโมเดล", async (t) => {
  const db = memoryDb();
  const lineFetch = lineFetchStub();
  const hermes = hermesFetchStub();
  const app = createApp({
    config: testConfig({ AI_PAUSED: "true" }), db,
    overrides: { lineFetch, hermesFetch: hermes, sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const raw = JSON.stringify({ events: [
    { type: "message", webhookEventId: "w-paused-reset", replyToken: "rt-paused-reset", source: { type: "user", userId: "U-paused-command" }, message: { id: "paused-reset", type: "text", text: "/reset" } },
    { type: "message", webhookEventId: "w-paused-fb", replyToken: "rt-paused-fb", source: { type: "user", userId: "U-paused-command" }, message: { id: "paused-fb", type: "text", text: "/fb ทดสอบ" } },
  ] });
  const response = await post(app, raw);
  assert.equal(response.status, 200);
  await waitFor(() => db.messagesFor("U-paused-command").filter((row) => row.direction === "in").length === 2);
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(hermes.calls.length, 0);
  assert.equal(db.listTrainingCandidates().length, 0);
  assert.deepEqual(
    db.messagesFor("U-paused-command").filter((row) => row.direction === "in").map((row) => row.content).sort(),
    ["/fb ทดสอบ", "/reset"],
  );
});

test("AI pause ระหว่าง /reset รอคิว -> เก็บเป็น inbound แต่ไม่ rotate/ส่ง ACK", async (t) => {
  let releaseOldSend;
  const oldSendGate = new Promise((resolve) => { releaseOldSend = resolve; });
  const sentTexts = [];
  const lineFetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/v2/bot/chat/loading/")) return { ok: true, status: 200, json: async () => ({}) };
    if (target.includes("/v2/bot/profile/")) return { ok: false, status: 404, json: async () => ({}) };
    const body = options.body ? JSON.parse(options.body) : {};
    const text = body?.messages?.[0]?.text || "";
    sentTexts.push(text);
    if (text.startsWith("งานเก่าที่กำลังส่ง")) {
      await oldSendGate;
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const db = memoryDb();
  const app = createApp({
    config: testConfig(), db,
    overrides: { lineFetch, hermesFetch: hermesFetchStub("งานเก่าที่กำลังส่ง"), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  db.upsertCustomer("U-reset", { displayName: "ผู้ทดสอบ" });
  const oldSession = db.activeConversationSession("U-reset");
  const oldReply = app.pipeline.handleInboundText({ customerId: "U-reset", text: "เริ่มงานเก่า", replyToken: "rt-old" });
  await waitFor(() => sentTexts.some((text) => text.startsWith("งานเก่าที่กำลังส่ง")));

  const resetRequest = post(app, payload({ id: "pause-while-queued-reset" }));
  await sleep(15);
  db.setSetting("ai_paused", "1");
  releaseOldSend();
  assert.equal((await oldReply).sent, true);
  assert.equal((await resetRequest).status, 200);

  assert.equal(sentTexts.length, 1, "pause หลัง admission ต้องกัน reset ACK ที่ final queue boundary");
  assert.match(sentTexts[0], /^งานเก่าที่กำลังส่ง/u);
  assert.equal(db.listTrainingCandidates().length, 0);
  assert.equal(db.activeConversationSession("U-reset").id, oldSession.id, "paused reset ไม่หมุน session");
  assert.ok(db.messagesFor("U-reset").some((row) => row.direction === "in" && row.content === "/reset"));
});

test("paused reset persistence: insert ล้มต้อง rollback dedupe แล้ว redelivery บันทึกได้", () => {
  const db = memoryDb();
  const originalInsert = db.insertMessage;
  db.insertMessage = () => { throw new Error("forced inbound failure"); };
  assert.throws(
    () => db.persistPausedInbound({
      dedupeKey: "atomic-paused-reset",
      customerId: "U-atomic-reset",
      channelId: "default",
      msgType: "text",
      content: "/reset",
    }),
    /forced inbound failure/u,
  );
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM events_dedupe WHERE message_id = ?").get("atomic-paused-reset").n, 0);
  assert.equal(db.getCustomer("U-atomic-reset"), null, "customer upsert ต้อง rollback พร้อม dedupe");

  db.insertMessage = originalInsert;
  assert.deepEqual(db.persistPausedInbound({
    dedupeKey: "atomic-paused-reset",
    customerId: "U-atomic-reset",
    channelId: "default",
    msgType: "text",
    content: "/reset",
  }), { stored: true, reason: "new" });
  assert.ok(db.messagesFor("U-atomic-reset").some((row) => row.content === "/reset"));
  assert.deepEqual(db.persistPausedInbound({
    dedupeKey: "atomic-paused-reset",
    customerId: "U-atomic-reset",
    channelId: "default",
    msgType: "text",
    content: "/reset",
  }), { stored: false, reason: "duplicate" });
  db.close();
});

test("ordinary message reads are active-session-only; archive requires an explicit internal flag", () => {
  const db = memoryDb();
  db.upsertCustomer("U-archive", {});
  db.insertMessage({ customerId: "U-archive", direction: "in", content: "บทสนทนาเก่า" });
  db.rotateTrainingSession({ customerId: "U-archive", resetEventId: "archive-reset" });
  db.insertMessage({ customerId: "U-archive", direction: "in", content: "บทสนทนาใหม่" });

  assert.deepEqual(db.messagesFor("U-archive").map((row) => row.content), ["บทสนทนาใหม่"]);
  assert.deepEqual(
    db.messagesFor("U-archive", 20, { includeArchived: true }).map((row) => row.content),
    ["บทสนทนาเก่า", "บทสนทนาใหม่"],
  );
  db.close();
});

test("/reset redelivery is idempotent and approved/rejected candidates stay inert", async (t) => {
  const { app, db, lineFetch, hermes } = await start(t);
  db.upsertCustomer("U-reset", {});
  db.insertMessage({ customerId: "U-reset", direction: "in", content: "ข้อความเก่า" });
  const raw = payload({ id: "same-reset" });
  await post(app, raw);
  await waitFor(() => lineFetch.sends.length === 1);
  await post(app, raw);
  await sleep(25);
  assert.equal(lineFetch.sends.length, 1);
  assert.equal(db.listTrainingCandidates().length, 1);
  assert.equal(hermes.calls.length, 0);
  const candidate = db.listTrainingCandidates()[0];
  assert.equal(db.decideTrainingCandidate(candidate.id, { approved: true, decidedBy: "owner" }).status, "approved");
  assert.equal(db.decideTrainingCandidate(candidate.id, { approved: false, decidedBy: "owner" }), null, "owner review is one-way state only");
  assert.deepEqual(db.recentTurns("U-reset"), []);
});

test("owner ACK resolution wins before queued delivery and crosses no LINE boundary", async () => {
  const db = memoryDb();
  db.upsertCustomer("U-owner-resolved", {});
  db.insertMessage({ customerId: "U-owner-resolved", direction: "in", content: "บทสนทนา" });
  const rotation = db.rotateTrainingSession({ customerId: "U-owner-resolved", resetEventId: "owner-resolved-reset" });
  db.resolveTrainingCandidateAck(rotation.candidate.id, { resolvedBy: "owner" });
  let providerCalls = 0;
  const result = await deliverTrainingResetAcknowledgement({
    db,
    lineRegistry: { forChannel: () => ({ sendBubbles: async () => { providerCalls += 1; return { ok: true, status: 200 }; } }) },
    channelId: "default",
    customerId: "U-owner-resolved",
    event: { source: { userId: "U-owner-resolved" }, replyToken: "unused" },
    rotation,
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, "owner_resolved_without_send");
  assert.equal(providerCalls, 0);
  assert.equal(db.getTrainingCandidate(rotation.candidate.id).ack_resolution, "owner_no_send");
  db.close();
});

test("/reset DB rollback leaves no dedupe tombstone, so the same LINE redelivery rotates exactly once", async (t) => {
  const { app, db, lineFetch, hermes } = await start(t);
  db.upsertCustomer("U-reset-rollback", {});
  db.insertMessage({ customerId: "U-reset-rollback", direction: "in", content: "ก่อน reset" });
  // Force the candidate insert to abort inside rotateTrainingSession's BEGIN.
  // This exercises the real SQLite rollback rather than a mocked helper throw.
  db.raw.exec(`CREATE TRIGGER fail_training_reset_once
    BEFORE INSERT ON training_candidates
    BEGIN SELECT RAISE(ABORT, 'injected training reset failure'); END;`);
  const raw = payload({ id: "rollback-reset", userId: "U-reset-rollback" });
  const failed = await post(app, raw);
  assert.equal(failed.status, 500);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM events_dedupe WHERE message_id = ?").get("rollback-reset").n, 0);
  assert.equal(db.listTrainingCandidates().length, 0);
  db.raw.exec("DROP TRIGGER fail_training_reset_once");

  const retried = await post(app, raw);
  assert.equal(retried.status, 200);
  await waitFor(() => lineFetch.sends.length === 1);
  assert.equal(db.listTrainingCandidates().length, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM events_dedupe WHERE message_id = ?").get("rollback-reset").n, 1);
  assert.equal(hermes.calls.length, 0);

  await post(app, raw);
  await sleep(25);
  assert.equal(db.listTrainingCandidates().length, 1, "successful redelivery is idempotent");
  assert.equal(lineFetch.sends.length, 1, "successful redelivery does not send another ack");
});

test("/reset waits behind an outbound already in LINE send, then rotates and ACKs in exact order", async (t) => {
  let signalOldSendStarted;
  const oldSendStarted = new Promise((resolve) => { signalOldSendStarted = resolve; });
  let releaseOldSend;
  const oldSendGate = new Promise((resolve) => { releaseOldSend = resolve; });
  const sendOrder = [];
  const lineFetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes("/v2/bot/chat/loading/")) return { ok: true, status: 200, json: async () => ({}) };
    if (target.includes("/v2/bot/profile/")) return { ok: false, status: 404, json: async () => ({}) };
    const body = options.body ? JSON.parse(options.body) : {};
    const text = body?.messages?.[0]?.text || "";
    sendOrder.push(text);
    if (text === "ข้อความเก่าที่ส่งค้างอยู่") {
      signalOldSendStarted();
      await oldSendGate;
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const db = memoryDb();
  const hermes = hermesFetchStub("ข้อความเก่าที่ส่งค้างอยู่");
  const app = createApp({ config: testConfig(), db, overrides: { lineFetch, hermesFetch: hermes, sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  db.upsertCustomer("U-reset", { displayName: "ผู้ทดสอบ" });
  db.insertMessage({ customerId: "U-reset", direction: "in", content: "ข้อความก่อน reset" });
  const oldSession = db.activeConversationSession("U-reset");
  const oldReply = app.pipeline.handleInboundText({ customerId: "U-reset", text: "รอส่งอยู่", replyToken: "rt-old" });
  await oldSendStarted;

  let resetResolved = false;
  const resetRequest = post(app, payload({ id: "race-reset" })).then((response) => {
    resetResolved = true;
    return response;
  });
  await sleep(15);
  assert.equal(resetResolved, false, "webhook 200 waits for the ordered reset critical section");
  assert.equal(db.activeConversationSession("U-reset").id, oldSession.id, "session does not rotate while the old LINE send is in flight");
  assert.equal(db.listTrainingCandidates().length, 0);

  releaseOldSend();
  assert.equal((await oldReply).sent, true);
  const response = await resetRequest;
  assert.equal(response.status, 200);
  assert.deepEqual(sendOrder, ["ข้อความเก่าที่ส่งค้างอยู่", TRAINING_RESET_ACK]);
  const candidate = db.listTrainingCandidates()[0];
  assert.equal(candidate.ack_status, "sent");
  assert.notEqual(db.activeConversationSession("U-reset").id, oldSession.id);
  assert.deepEqual(
    JSON.parse(candidate.transcript_json).map((row) => row.content),
    ["ข้อความก่อน reset", "ข้อความเก่าที่ส่งค้างอยู่"],
    "the completed old reply stays wholly inside the archived session",
  );
  assert.deepEqual(db.recentTurns("U-reset"), [], "no old reply appears after the ACK/new-session boundary");
});

test("ordinary event preceding /reset in one webhook never enters the new session", async (t) => {
  const { app, db, lineFetch, hermes } = await start(t);
  const raw = JSON.stringify({ events: [
    { type: "message", webhookEventId: "w-first", replyToken: "rt-first", source: { type: "user", userId: "U-reset" }, message: { id: "first", type: "text", text: "ข้อความก่อน reset ใน batch" } },
    { type: "message", webhookEventId: "w-reset-batch", replyToken: "rt-reset", source: { type: "user", userId: "U-reset" }, message: { id: "reset-batch", type: "text", text: "/reset" } },
  ] });
  const response = await post(app, raw);
  assert.equal(response.status, 200);
  assert.equal(lineFetch.sends.length, 2);
  // v1.3.3: คำถามปิดท้ายแยกเป็นบอลลูนของตัวเอง (เดิมติดอยู่ในก้อนเดียวคั่นด้วย \n)
  assert.deepEqual(
    lineFetch.sends[0].body.messages.map((message) => message.text),
    ["สวัสดีค่ะ", "อยากเรียนเรื่องไหนเป็นพิเศษคะ?"],
  );
  assert.equal(lineFetch.sends[1].body.messages[0].text, TRAINING_RESET_ACK);
  assert.ok(hermes.calls.length >= 1, "the ordinary event is processed before reset in literal webhook order");
  assert.deepEqual(db.recentTurns("U-reset"), []);
  const candidate = db.listTrainingCandidates()[0];
  assert.deepEqual(
    JSON.parse(candidate.transcript_json).map((row) => row.content),
    // transcript เก็บ "ตามที่ลูกค้าเห็นจริง" — คำถามที่แยกบอลลูนจึงเป็นอีกแถวหนึ่ง
    ["ข้อความก่อน reset ใน batch", "สวัสดีค่ะ", "อยากเรียนเรื่องไหนเป็นพิเศษคะ?"],
  );
});

test("audio processing also reserves the customer queue before a following /reset", async (t) => {
  const { app, db, lineFetch } = await start(t);
  const raw = JSON.stringify({ events: [
    { type: "message", webhookEventId: "w-audio", replyToken: "rt-audio", source: { type: "user", userId: "U-reset" }, message: { id: "audio-before-reset", type: "audio" } },
    { type: "message", webhookEventId: "w-audio-reset", replyToken: "rt-audio-reset", source: { type: "user", userId: "U-reset" }, message: { id: "audio-reset", type: "text", text: "/reset" } },
  ] });
  const response = await post(app, raw);
  assert.equal(response.status, 200);
  assert.equal(lineFetch.sends.length, 2);
  assert.equal(lineFetch.sends[0].body.messages[0].text, AUDIO_FALLBACK_TEMPLATE);
  assert.equal(lineFetch.sends[1].body.messages[0].text, TRAINING_RESET_ACK);
  assert.deepEqual(db.recentTurns("U-reset"), []);
  const archived = JSON.parse(db.listTrainingCandidates()[0].transcript_json).map((row) => row.content);
  assert.deepEqual(archived, [AUDIO_FALLBACK_TEMPLATE]);
});

test("PDPA reset deletes training sessions and locally retained candidate snapshots", () => {
  const db = memoryDb();
  db.upsertCustomer("U-pdpa", {});
  db.insertMessage({ customerId: "U-pdpa", direction: "in", content: "เก็บไว้ก่อน" });
  db.rotateTrainingSession({ customerId: "U-pdpa", resetEventId: "pdpa-reset-event" });
  assert.equal(db.listTrainingCandidates().length, 1);
  db.resetCustomer("U-pdpa");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM training_candidates WHERE customer_id = ?").get("U-pdpa").n, 0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_sessions WHERE customer_id = ?").get("U-pdpa").n, 0);
  db.close();
});

// ---- v1.2.6 (คำสั่งพี่ง้วง 2026-08-13): เก็บ feedback ของผู้ทดสอบคู่กับบทสนทนา ----
// เป้าหมาย: ผู้ทดสอบจบรอบ -> /reset พร้อมความเห็น -> คุยต่อได้ทันที และทีมอ่านย้อนได้

test("v1.2.6: /reset พร้อม feedback เก็บความเห็นผูกกับ session ที่เพิ่งปิด", async (t) => {
  const { app, db } = await start(t);
  const userId = "U-fb-reset";
  db.upsertCustomer(userId, { displayName: "ผู้ทดสอบ" });
  const before = db.ensureActiveConversationSession(userId);
  db.insertMessage({ customerId: userId, direction: "in", content: "สวัสดีครับ", sessionId: before.id });

  const rotation = db.rotateTrainingSession({
    customerId: userId, resetEventId: "fb-reset-1", feedback: "ตอบช้าไป และไม่เรียกชื่อลูกค้า",
  });
  assert.equal(rotation.feedbackSaved, true);

  const saved = db.trainingFeedbackForSession(before.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].content, "ตอบช้าไป และไม่เรียกชื่อลูกค้า");
  assert.equal(saved[0].session_id, before.id, "ความเห็นต้องผูกกับรอบที่เพิ่งปิด ไม่ใช่รอบใหม่");

  // เทสต์ต่อเนื่องได้ทันที: session ใหม่ active และแยกจากของเดิม
  const next = db.activeConversationSession(userId);
  assert.notEqual(next.id, before.id);
  assert.equal(next.status, "active");
  assert.equal(db.trainingFeedbackForSession(next.id).length, 0);
  assert.ok(app);
});

test("v1.2.6: /fb ระหว่างรอบเก็บความเห็นโดยไม่ตัดบทสนทนา", async (t) => {
  const { db } = await start(t);
  const userId = "U-fb-mid";
  db.upsertCustomer(userId, { displayName: "ผู้ทดสอบ" });
  const session = db.ensureActiveConversationSession(userId);

  const first = db.addTrainingFeedback({ customerId: userId, content: "ตรงนี้ควรเสนอราคาแล้ว" });
  const second = db.addTrainingFeedback({ customerId: userId, content: "ยังไม่เรียกชื่อ" });
  assert.ok(first && second);
  assert.equal(db.activeConversationSession(userId).id, session.id, "/fb ต้องไม่หมุน session");

  const rows = db.trainingFeedbackForSession(session.id);
  assert.deepEqual(rows.map((row) => row.content), ["ตรงนี้ควรเสนอราคาแล้ว", "ยังไม่เรียกชื่อ"]);
  assert.equal(db.addTrainingFeedback({ customerId: userId, content: "   " }), null, "ข้อความว่างไม่บันทึก");
});

test("v1.2.6: บทสนทนาที่ /reset ไปแล้วต้องไม่ถูกลบเมื่อตั้งค่าเก็บถาวร", async (t) => {
  const { db } = await start(t);
  const userId = "U-forever";
  db.upsertCustomer(userId, { displayName: "ผู้ทดสอบ" });
  const session = db.ensureActiveConversationSession(userId);
  db.insertMessage({ customerId: userId, direction: "in", content: "ข้อความเก่า", sessionId: session.id });
  db.rotateTrainingSession({ customerId: userId, resetEventId: "forever-1", feedback: "รอบแรก" });

  // ย้อนเวลาให้เก่ากว่ากรอบ 30 วันเดิม แล้วสั่ง prune แบบเก็บถาวร (0)
  const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000;
  db.raw.prepare("UPDATE training_candidates SET created_at = ? WHERE customer_id = ?").run(ancient, userId);
  const kept = db.pruneRetention({ now: Date.now(), days: { trainingCandidate: 0 } });
  assert.equal(kept.trainingCandidate, 0, "0 = เก็บถาวร ห้ามลบ");
  assert.equal(db.listTrainingCandidates({ limit: 10 }).length, 1);
  assert.equal(db.trainingFeedbackForSession(session.id).length, 1, "feedback ต้องอยู่ครบ");

  // ค่าปกติ (30 วัน) ยังลบของเก่าได้เหมือนเดิมสำหรับ instance อื่น
  const pruned = db.pruneRetention({ now: Date.now(), days: { trainingCandidate: 30 } });
  assert.equal(pruned.trainingCandidate, 1);
});

// ---- v1.2.6 ผลตรวจอิสระ 2026-08-13: ปิดช่องของคำสั่งใหม่ทั้งหมด ----

test("v1.2.6: /fb ที่ LINE ส่งซ้ำ ต้องไม่บันทึกซ้ำและไม่ตอบซ้ำ", async (t) => {
  const { app, db, lineFetch } = await start(t);
  db.upsertCustomer("U-fb-dupe", {});
  const raw = payload({ id: "fb-dupe-1", userId: "U-fb-dupe", text: "/fb ตอบช้าไป" });

  assert.equal((await post(app, raw)).status, 200);
  assert.equal((await post(app, raw)).status, 200);
  assert.equal((await post(app, raw)).status, 200);

  const session = db.activeConversationSession("U-fb-dupe");
  assert.equal(db.trainingFeedbackForSession(session.id).length, 1, "ความเห็นต้องมีแถวเดียว");
  assert.equal(lineFetch.sends.length, 1, "ผู้ทดสอบต้องได้ข้อความตอบกลับครั้งเดียว");
});

test("v1.2.6: บันทึก feedback ไม่สำเร็จ ต้องบอกตามจริงและทิ้งร่องรอยให้ตามได้", async (t) => {
  const { app, db, lineFetch } = await start(t);
  db.upsertCustomer("U-fb-fail", {});
  db.raw.exec(`CREATE TRIGGER fail_feedback_write
    BEFORE INSERT ON training_feedback
    BEGIN SELECT RAISE(ABORT, 'injected feedback failure'); END;`);
  t.after(() => { try { db.raw.exec("DROP TRIGGER IF EXISTS fail_feedback_write"); } catch { /* ปิดแล้ว */ } });

  await post(app, payload({ id: "fb-fail-1", userId: "U-fb-fail", text: "/fb ราคาที่บอกลูกค้าผิด ต้องแก้ด่วน" }));
  const delivered = lineFetch.sends.at(-1).body.messages[0].text;
  assert.match(delivered, /บันทึก feedback ไม่สำเร็จ/u, "ห้ามบอกผู้ทดสอบว่าพิมพ์ไม่ครบ");
  assert.doesNotMatch(delivered, /พิมพ์ feedback ต่อท้าย/u);
  const audits = db.raw.prepare("SELECT * FROM admin_audit WHERE action = 'training_feedback_write_failed'").all();
  assert.equal(audits.length, 1, "ต้องมี audit ให้เจ้าของตามย้อนได้");
});

test("v1.2.6: /fb เปล่า ๆ ยังบอกวิธีใช้ตามเดิม", async (t) => {
  const { app, db, lineFetch } = await start(t);
  db.upsertCustomer("U-fb-empty", {});
  await post(app, payload({ id: "fb-empty-1", userId: "U-fb-empty", text: "/fb" }));
  const delivered = lineFetch.sends.at(-1).body.messages[0].text;
  assert.match(delivered, /พิมพ์ feedback ต่อท้าย/u);
});

test("v1.2.6: prune หมดอายุเฉพาะ training artifact แต่เก็บ conversation session ถาวร", async (t) => {
  const { db } = await start(t);
  db.upsertCustomer("U-orphan", {});
  const session = db.ensureActiveConversationSession("U-orphan");
  db.addTrainingFeedback({ customerId: "U-orphan", content: "ลูกค้าคุณสมชาย เบอร์ 0812345678" });
  db.rotateTrainingSession({ customerId: "U-orphan", resetEventId: "orphan-1" });
  db.raw.prepare("UPDATE training_candidates SET created_at = ? WHERE customer_id = ?")
    .run(Date.now() - 400 * 24 * 60 * 60 * 1000, "U-orphan");

  const pruned = db.pruneRetention({ now: Date.now(), days: { trainingCandidate: 30 } });
  assert.equal(pruned.trainingCandidate, 1);
  assert.equal(db.trainingFeedbackForSession(session.id).length, 0, "ความเห็นฝึกต้องหายไปพร้อม candidate");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_sessions WHERE id = ?").get(session.id).n, 1, "rotated customer session ต้องอยู่ถาวร");
  const leftovers = db.raw.prepare("SELECT COUNT(*) AS n FROM training_feedback").get().n;
  assert.equal(leftovers, 0, "training feedback ที่หมดอายุแล้วต้องไม่ค้าง");
});
