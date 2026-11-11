// แคมเปญ #AIAGENT — จุดเกี่ยวใน pipeline: รับคำขอก่อนด่าน # เงียบ, ตอบรับครั้งเดียว, ไม่มีคำตอบ AI ซ้อน
// และทุกข้อความอื่น (# อื่น, คีย์เวิร์ดกลางประโยค, #AIAGENTX, ห้อง Facebook) เดินเส้นเดิม
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { saveCampaign } from "../src/blueprintCampaignConfig.mjs";
import { readEntry } from "../src/blueprintStore.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, signLine, httpRequest, listen, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const DAY = 86_400_000;
const TEMPLATE = "#AIAGENT IESA6\nธุรกิจ: ร้านกาแฟสองสาขา\nอยากให้ผู้ช่วย AI ทำก่อน: ตอบแชทลูกค้าเรื่องเมนู\n(ขอรับไอเดียการวางระบบ AI Agent ภายใน 24 ชม.)";

function isoBangkok(ms) {
  return `${new Date(ms + 7 * 3_600_000).toISOString().slice(0, 19)}+07:00`;
}

function fixture(t, { campaign = {}, configOverrides = {}, listenServer = false } = {}) {
  const db = memoryDb();
  const line = lineFetchStub();
  const hermes = hermesFetchStub("รับทราบค่ะ ยินดีดูแลนะคะ");
  const clock = Date.now();
  saveCampaign(db, {
    campaignId: "IESA6", keyword: "#AIAGENT", title: "IESA S-Curve MBA รุ่น 6",
    sendAt: isoBangkok(clock + DAY), followupOffDays: 7, enabled: true, ...campaign,
  });
  const app = createApp({
    config: testConfig(configOverrides), db,
    overrides: { lineFetch: line, hermesFetch: hermes, sleep: async () => {} }, logger: silent,
  });
  t.after(() => { app.learning.stop(); app.server.close(); db.close(); });
  return { app, db, line, hermes, clock, listen: listenServer ? listen(app.server) : null };
}

const replyCalls = (line) => line.sends.filter((c) => c.url.endsWith("/v2/bot/message/reply"));
const audits = (db, action) => db.listAudit().filter((a) => a.action === action);

test("ข้อความตามแบบฟอร์ม → รับคำขอ + ตอบรับครั้งเดียว (text + ใบรับ) · ไม่เรียกโมเดลตอบแชท", async (t) => {
  const { app, db, line, hermes } = fixture(t);
  db.upsertCustomer("U-bp-1", {});
  const verdict = await app.pipeline.handleInboundText({ customerId: "U-bp-1", text: TEMPLATE, replyToken: "rt-1" });
  assert.equal(verdict.sent, true);
  assert.equal(verdict.route, "blueprint_campaign");
  assert.equal(hermes.calls.length, 0, "ไม่มีคำตอบ AI ปกติสำหรับข้อความนี้");
  const replies = replyCalls(line);
  assert.equal(replies.length, 1, "ตอบรับครั้งเดียว");
  assert.equal(replies[0].body.replyToken, "rt-1");
  assert.deepEqual(replies[0].body.messages.map((m) => m.type), ["text", "flex"]);
  assert.match(replies[0].body.messages[0].text, /ร้านกาแฟสองสาขา/u);
  const entry = readEntry(db, "IESA6", "U-bp-1");
  assert.equal(entry.status, "pending");
  assert.equal(entry.business, "ร้านกาแฟสองสาขา");
  assert.equal(entry.answer, "ตอบแชทลูกค้าเรื่องเมนู");
  assert.equal(entry.submissions, 1);
  assert.ok(entry.ackedAt > 0);
  // ป้ายของทีม + โน้ตที่มา + พัก FU เฉพาะคนนี้
  assert.ok(db.listTags("U-bp-1").some((tag) => tag.tag === "ที่มา: IESA6 · AI Agent" && tag.source === "human"));
  assert.match(db.getCustomer("U-bp-1").hashtag_note, /IESA S-Curve MBA รุ่น 6/u);
  assert.equal(db.getCustomer("U-bp-1").followup_enabled, 0);
  assert.equal(db.getCustomer("U-bp-1").followup_choice_by_human, 1);
  assert.equal(entry.hold.applied, true);
  assert.deepEqual(entry.hold.prior, { enabled: 1, choice: 0 });
  // ประวัติแชทเห็นสิ่งที่ส่งจริง
  const out = db.raw.prepare("SELECT content, agent_mode, message_class FROM messages WHERE customer_id = ? AND direction = 'out'").all("U-bp-1");
  assert.equal(out.length, 2);
  assert.ok(out.every((row) => row.agent_mode === "blueprint" && row.message_class === "reactive"));
  for (const action of ["blueprint_intake", "blueprint_followup_hold", "blueprint_tag", "blueprint_ack"]) {
    assert.equal(audits(db, action).length, 1, action);
  }
  assert.doesNotMatch(JSON.stringify(db.listAudit()), /ร้านกาแฟ|เมนู/u, "audit ไม่เก็บสิ่งที่ลูกค้าพิมพ์");
});

test("ข้อความถัดไปที่ไม่ใช่คีย์เวิร์ด = ลูกแพรตอบตามปกติ", async (t) => {
  const { app, db, hermes, line } = fixture(t);
  db.upsertCustomer("U-bp-2", {});
  await app.pipeline.handleInboundText({ customerId: "U-bp-2", text: TEMPLATE, replyToken: "rt-a" });
  const verdict = await app.pipeline.handleInboundText({ customerId: "U-bp-2", text: "คลาสถัดไปเรียนวันไหนคะ", replyToken: "rt-b" });
  assert.equal(verdict.sent, true);
  assert.ok(hermes.calls.length >= 1, "ข้อความปกติต้องไปถึงโมเดลตอบแชท");
  assert.equal(replyCalls(line).length, 2);
});

test("# อื่นยังเงียบ · #AIAGENTX เงียบ · คีย์เวิร์ดไม่อยู่ต้นข้อความ/ไม่มี # = คุยปกติ", async (t) => {
  const { app, db, hermes } = fixture(t);
  for (const [id, text] of [["U-h1", "#horeca"], ["U-h2", "#AIAGENTX สวัสดี"]]) {
    db.upsertCustomer(id, {});
    const verdict = await app.pipeline.handleInboundText({ customerId: id, text, replyToken: `rt-${id}` });
    assert.equal(verdict.suppressed, "hashtag_auto_response", text);
    assert.equal(readEntry(db, "IESA6", id), null);
  }
  assert.equal(hermes.calls.length, 0);
  for (const [id, text] of [["U-n1", "AIAGENT ธุรกิจ: ร้านอาหาร"], ["U-n2", "สนใจ #AIAGENT ค่ะ"]]) {
    db.upsertCustomer(id, {});
    const before = hermes.calls.length;
    const verdict = await app.pipeline.handleInboundText({ customerId: id, text, replyToken: `rt-${id}` });
    assert.equal(verdict.sent, true, text);
    assert.ok(hermes.calls.length > before, text);
    assert.equal(readEntry(db, "IESA6", id), null);
    assert.equal(db.getCustomer(id).followup_enabled, 1, "FU ของคนอื่นไม่ถูกแตะ");
  }
});

test("แคมเปญปิด / หมดช่วงแคมเปญ = #AIAGENT เงียบแบบเดิม ไม่เก็บอะไร", async (t) => {
  for (const campaign of [{ enabled: false }, { sendAt: isoBangkok(Date.now() - 9 * DAY) }]) {
    const { app, db, line } = fixture(t, { campaign });
    db.upsertCustomer("U-off", {});
    const verdict = await app.pipeline.handleInboundText({ customerId: "U-off", text: TEMPLATE, replyToken: "rt" });
    assert.equal(verdict.suppressed, "hashtag_auto_response");
    assert.equal(readEntry(db, "IESA6", "U-off"), null);
    assert.equal(line.sends.length, 0);
    assert.equal(db.getCustomer("U-off").followup_enabled, 1);
  }
});

test("ส่งซ้ำ = ล่าสุดชนะ ตอบรับทุกครั้ง · ข้อความเดิม (turn เดิม) เล่นซ้ำ = ไม่นับซ้ำ ไม่ตอบซ้ำ", async (t) => {
  const { app, db, line } = fixture(t);
  db.upsertCustomer("U-re", {});
  await app.pipeline.handleInboundText({ customerId: "U-re", text: TEMPLATE, replyToken: "rt-1", turnId: "in:t1" });
  const again = TEMPLATE.replace("ร้านกาแฟสองสาขา", "โรงแรมบูทีค");
  await app.pipeline.handleInboundText({ customerId: "U-re", text: again, replyToken: "rt-2", turnId: "in:t2" });
  const replay = await app.pipeline.handleInboundText({ customerId: "U-re", text: again, replyToken: "rt-3", turnId: "in:t2" });
  assert.equal(replay.suppressed, "blueprint_duplicate");
  const entry = readEntry(db, "IESA6", "U-re");
  assert.equal(entry.business, "โรงแรมบูทีค");
  assert.equal(entry.submissions, 2);
  assert.equal(replyCalls(line).length, 2);
  assert.equal(audits(db, "blueprint_followup_hold").length, 1, "พัก FU ครั้งเดียว จำค่าเดิมครั้งแรกไว้");
  assert.deepEqual(entry.hold.prior, { enabled: 1, choice: 0 });
});

test("พักทั้งระบบ / ห้องเงียบ = เก็บคำขอไว้ ไม่ส่งอะไร · ไม่มี reply token = ตอบรับด้วย push · ห้อง AI ปิด = ยังตอบรับ", async (t) => {
  const { app, db, line } = fixture(t);
  db.upsertCustomer("U-paused", {});
  db.setSetting("ai_paused", "1");
  const paused = await app.pipeline.handleInboundText({ customerId: "U-paused", text: TEMPLATE, replyToken: "rt" });
  assert.equal(paused.suppressed, "blueprint_recorded_ai_paused");
  assert.equal(readEntry(db, "IESA6", "U-paused").status, "pending");
  db.setSetting("ai_paused", "0");
  db.upsertCustomer("U-noreply", {});
  const noToken = await app.pipeline.handleInboundText({ customerId: "U-noreply", text: TEMPLATE });
  assert.equal(noToken.sent, true, "ไม่มี reply token (ทดสอบจริง 11 ต.ค.) = ส่งใบตอบรับเป็น push แทนการเงียบ");
  const pushSends = line.sends.length;
  assert.ok(pushSends >= 1, "มี push ใบตอบรับ");
  db.upsertCustomer("U-spam", {});
  db.addTag("U-spam", "null", "human");
  const spam = await app.pipeline.handleInboundText({ customerId: "U-spam", text: TEMPLATE, replyToken: "rt-s" });
  assert.equal(spam.suppressed, "blueprint_recorded_silenced_room");
  assert.equal(line.sends.length, pushSends, "ห้องเงียบ/สแปมไม่ได้อะไรเพิ่ม");
  assert.ok(audits(db, "blueprint_ack_skipped").length >= 2, "ไม่ส่งใบตอบรับ = มีร่องรอยใน audit");
  db.upsertCustomer("U-aioff", {});
  db.setAiEnabled("U-aioff", false, "human_requested");
  const aiOff = await app.pipeline.handleInboundText({ customerId: "U-aioff", text: TEMPLATE, replyToken: "rt-o" });
  assert.equal(aiOff.sent, true, "ของที่ลูกค้าขอเองผ่านคีย์เวิร์ด = ตอบรับแบบเดียวกับ auto-response ของ OA");
  assert.equal(db.getCustomer("U-aioff").ai_enabled, 0, "ไม่เปิด AI ของห้องให้เอง");
});

test("FU ที่ปิดอยู่แล้วไม่ถูกแตะ (ไม่จำ ไม่คืน)", async (t) => {
  const { app, db } = fixture(t);
  db.upsertCustomer("U-fuoff", {});
  db.setFollowupEnabled("U-fuoff", false);
  await app.pipeline.handleInboundText({ customerId: "U-fuoff", text: TEMPLATE, replyToken: "rt" });
  const entry = readEntry(db, "IESA6", "U-fuoff");
  assert.equal(entry.hold.applied, false);
  assert.equal(entry.hold.reason, "already_off");
});

test("ห้อง Facebook ไม่ถูกแตะ (เส้นเดิม)", async (t) => {
  const { app, db, line } = fixture(t);
  db.upsertCustomer("facebook:PSID1", { channelId: "facebook" });
  const verdict = await app.pipeline.handleInboundText({ customerId: "facebook:PSID1", text: TEMPLATE, replyToken: "" });
  assert.equal(verdict.suppressed, "hashtag_auto_response");
  assert.equal(readEntry(db, "IESA6", "facebook:PSID1"), null);
  assert.equal(line.sends.length, 0);
});

test("ได้ครบจำนวนที่แคมเปญให้แล้ว → กลับไปเส้นเดิม (ไม่รับปากซ้ำ)", async (t) => {
  const { app, db } = fixture(t, { campaign: { maxSendsPerPerson: 1 } });
  db.upsertCustomer("U-done", {});
  await app.pipeline.handleInboundText({ customerId: "U-done", text: TEMPLATE, replyToken: "rt" });
  const key = "blueprint_req:IESA6:U-done";
  db.setSetting(key, JSON.stringify({ ...JSON.parse(db.getSetting(key)), status: "sent", sendCount: 1 }));
  const verdict = await app.pipeline.handleInboundText({ customerId: "U-done", text: TEMPLATE, replyToken: "rt2" });
  assert.equal(verdict.suppressed, "hashtag_auto_response");
});

test("webhook จริง (ลายเซ็น LINE): บัญชีเทิร์น = answered · ข้อความถัดไปคุยปกติ", async (t) => {
  const fx = fixture(t, { listenServer: true });
  await fx.listen;
  const post = (id, text) => {
    const raw = JSON.stringify({ events: [{
      type: "message", webhookEventId: `w-${id}`, replyToken: `rt-${id}`,
      source: { type: "user", userId: "U-hook" }, message: { id, type: "text", text },
    }] });
    return httpRequest(fx.app.server, {
      method: "POST", path: "/webhooks/line",
      headers: { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") }, body: raw,
    });
  };
  const turn = (id) => fx.db.raw.prepare("SELECT status, reason FROM inbound_turn_outcomes WHERE message_id = ?").get(`in:${id}`);
  assert.equal((await post("m1", TEMPLATE)).status, 200);
  await waitFor(() => ["answered", "silent_by_design", "stranded_error"].includes(turn("m1")?.status));
  assert.equal(turn("m1").status, "answered");
  assert.equal(readEntry(fx.db, "IESA6", "U-hook").status, "pending");
  assert.equal((await post("m2", "ขอบคุณค่ะ")).status, 200);
  await waitFor(() => turn("m2")?.status && turn("m2").status !== "owed" && turn("m2").status !== "sending");
  assert.equal(turn("m2").status, "answered");
  assert.ok(fx.hermes.calls.length >= 1);
});
