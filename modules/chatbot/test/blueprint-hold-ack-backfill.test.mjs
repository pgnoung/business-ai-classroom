// แคมเปญ #AIAGENT — รีวิวก่อนขึ้นจริง 11 ต.ค. 2026 (ฝั่งลูกแพร):
// พัก FU ห้องฐานเดิม (0/0) · ห้องรอโอนไม่แตะ · ทีมกดเองระหว่างพักชนะ · ใบตอบรับไม่ปิดคิวของทีม · 400 → ข้อความอย่างเดียว
// เล่นข้อความค้างซ้ำ (ไม่มี turnId) ไม่นับ · คีย์เวิร์ดเว้นวรรคได้ช่องเดียว · คีย์เวิร์ดชน # เดิมห้ามบันทึก
// เก็บคำขอก่อน deploy ย้อนหลัง (ไม่ตอบรับ) · ด่านก่อนถอย release · ไฟล์ตรวจกับ LINE validate
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { applyFollowupHold, createBlueprintCampaign, releaseFollowupHold } from "../src/blueprintCampaign.mjs";
import { campaignForText, keywordRegex, readCampaigns, saveCampaign } from "../src/blueprintCampaignConfig.mjs";
import { readEntry } from "../src/blueprintStore.mjs";
import { runCommand } from "../tools/blueprint-campaign.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";
import { SAMPLE_BLUEPRINT, isoBangkok } from "./blueprint-fixtures.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const DAY = 86_400_000;
const TEMPLATE = "#AIAGENT IESA6\nธุรกิจ: ร้านกาแฟสองสาขา\nอยากให้ผู้ช่วย AI ทำก่อน: ตอบแชทลูกค้าเรื่องเมนู\n(ขอรับไอเดียการวางระบบ AI Agent ภายใน 24 ชม.)";
const IESA6 = { campaignId: "IESA6", keyword: "#AIAGENT", title: "IESA S-Curve MBA รุ่น 6", followupOffDays: 7, enabled: true };

function appFixture(t) {
  const db = memoryDb();
  const line = lineFetchStub();
  const hermes = hermesFetchStub("รับทราบค่ะ ยินดีดูแลนะคะ");
  saveCampaign(db, { ...IESA6, sendAt: isoBangkok(Date.now() + DAY) });
  const app = createApp({ config: testConfig(), db, overrides: { lineFetch: line, hermesFetch: hermes, sleep: async () => {} }, logger: silent });
  t.after(() => { app.learning.stop(); app.server.close(); db.close(); });
  return { app, db, line, hermes };
}

const ackRows = (db, id) => db.raw.prepare(
  "SELECT message_class FROM messages WHERE customer_id = ? AND direction = 'out' AND agent_mode = 'blueprint'",
).all(id).map((row) => row.message_class);

test("ห้องฐานเดิม FU ปิดแบบยังไม่มีใครตัดสิน (0/0) → พักด้วยธงคนเลือก scorer ไม่เปิด FU ระหว่างพัก · คืนแล้วเป็น 0/0 ตามเดิม", async (t) => {
  const { app, db } = appFixture(t);
  db.upsertCustomer("U-legacy", {});
  db.raw.prepare("UPDATE customers SET followup_enabled = 0, followup_choice_by_human = 0 WHERE line_user_id = 'U-legacy'").run();
  await app.pipeline.handleInboundText({ customerId: "U-legacy", text: TEMPLATE, replyToken: "rt" });
  const entry = readEntry(db, "IESA6", "U-legacy");
  assert.equal(entry.hold.applied, true);
  assert.deepEqual(entry.hold.prior, { enabled: 0, choice: 0 });
  db.recordScore("U-legacy", 70, "{}"); // ลูกค้ากดปุ่ม "อยากคุยเรื่อง AI Agent ต่อ" แล้วคุยจนได้คะแนน
  assert.equal(db.getCustomer("U-legacy").followup_enabled, 0, "FU ต้องยังปิดตลอดช่วงพัก");
  assert.equal(releaseFollowupHold(db, "U-legacy", entry.hold, { at: Date.now() }), "restored");
  assert.equal(db.getCustomer("U-legacy").followup_enabled, 0);
  assert.equal(db.getCustomer("U-legacy").followup_choice_by_human, 0, "กลับเป็นห้องที่ยังไม่มีใครตัดสิน");
  db.recordScore("U-legacy", 70, "{}");
  assert.equal(db.getCustomer("U-legacy").followup_enabled, 1, "หลังคืน scorer เปิด FU ได้ตามกติกาเดิม");
});

test("ห้องรอโอน (awaiting_payment) ไม่ถูกพัก — FU ปกติปิด = ตัวทักเรื่องชำระเงินจะเริ่มทำงาน ซึ่งเปลี่ยนเส้นเดิม", () => {
  const db = memoryDb();
  db.upsertCustomer("U-pay", {});
  db.setDealStatus("U-pay", "awaiting_payment");
  const hold = applyFollowupHold(db, "U-pay", { until: Date.now() + DAY, at: Date.now() });
  assert.deepEqual({ applied: hold.applied, reason: hold.reason }, { applied: false, reason: "payment_flow" });
  assert.equal(db.getCustomer("U-pay").followup_enabled, 1);
  assert.equal(db.getCustomer("U-pay").followup_choice_by_human, 0);
  db.close();
});

test("ทีมกดสวิตช์ FU ของห้องเองระหว่างพัก (มี audit followup_toggle) = ไม่คืนทับ แม้แถวหน้าตาเหมือนที่เราพัก", () => {
  let clock = Date.parse("2026-10-11T15:10:00+07:00");
  const db = memoryDb({ now: () => clock });
  db.upsertCustomer("U-team", {});
  const hold = applyFollowupHold(db, "U-team", { until: clock + 8 * DAY, at: clock });
  assert.equal(hold.applied, true);
  clock += DAY;
  db.setFollowupEnabled("U-team", false); // ทีมกดปิดในคอนโซล (คอนโซลจด audit คู่กันเสมอ)
  db.addAudit({ operator: "chompoo", action: "followup_toggle", target: "U-team", detail: "ปิด" });
  clock += 7 * DAY;
  assert.equal(releaseFollowupHold(db, "U-team", hold, { at: clock }), "kept_human_toggle");
  assert.equal(db.getCustomer("U-team").followup_enabled, 0);
  // ห้องอื่นที่ทีมไม่ได้แตะ คืนตามปกติ (audit ก่อนเวลาพักไม่นับ)
  db.upsertCustomer("U-free", {});
  db.addAudit({ operator: "chompoo", action: "followup_toggle", target: "U-free", detail: "เปิด (ก่อนคลาส)" });
  clock += 1000;
  const freeHold = applyFollowupHold(db, "U-free", { until: clock + DAY, at: clock });
  assert.equal(releaseFollowupHold(db, "U-free", freeHold, { at: clock + DAY }), "restored");
  db.close();
});

test("ใบตอบรับในห้อง AI ปิด / แอดมินกำลังตอบ / มีข้อความค้างตอบ = proactive (ไม่ปิดเทิร์นเก่า ไม่ตัดเวลารอใน KPI) · ห้องปกติ = reactive", async (t) => {
  const { app, db } = appFixture(t);
  db.upsertCustomer("U-normal", {});
  await app.pipeline.handleInboundText({ customerId: "U-normal", text: TEMPLATE, replyToken: "rt-n" });
  assert.deepEqual(ackRows(db, "U-normal"), ["reactive", "reactive"]);

  db.upsertCustomer("U-aioff", {});
  db.setAiEnabled("U-aioff", false, "human_requested");
  const aiOff = await app.pipeline.handleInboundText({ customerId: "U-aioff", text: TEMPLATE, replyToken: "rt-o" });
  assert.equal(aiOff.sent, true, "ยังตอบรับคำขอที่ลูกค้าส่งเอง");
  assert.deepEqual(ackRows(db, "U-aioff"), ["proactive", "proactive"]);

  db.upsertCustomer("U-nh", {});
  db.setNeedsHuman("U-nh", "customer_asked_human", "ขอคุยกับคน");
  await app.pipeline.handleInboundText({ customerId: "U-nh", text: TEMPLATE, replyToken: "rt-nh" });
  assert.deepEqual(ackRows(db, "U-nh"), ["proactive", "proactive"]);

  db.upsertCustomer("U-op", {});
  db.raw.prepare("UPDATE customers SET operator_active_until = ? WHERE line_user_id = 'U-op'").run(Date.now() + 10 * 60_000);
  await app.pipeline.handleInboundText({ customerId: "U-op", text: TEMPLATE, replyToken: "rt-op" });
  assert.deepEqual(ackRows(db, "U-op"), ["proactive", "proactive"]);

  // ข้อความลูกค้าก่อนหน้ายังค้างตอบ (เทิร์น owed) — ใบตอบรับต้องไม่ปิดเป็น answered
  const earlier = db.persistLineInbound({ dedupeKey: "d-early", customerId: "U-owed", msgType: "text", content: "ราคาคลาสเท่าไหร่คะ", owesReply: true, channelKind: "line" });
  const current = db.persistLineInbound({ dedupeKey: "d-now", customerId: "U-owed", msgType: "text", content: TEMPLATE, owesReply: true, channelKind: "line" });
  await app.pipeline.handleInboundText({ customerId: "U-owed", text: TEMPLATE, replyToken: "rt-ow", turnId: current.messageId });
  assert.deepEqual(ackRows(db, "U-owed"), ["proactive", "proactive"]);
  const owed = db.raw.prepare("SELECT status FROM inbound_turn_outcomes WHERE message_id = ?").get(earlier.messageId);
  assert.equal(owed.status, "owed", "คำถามเดิมยังค้างให้ทีมเห็น");
});

test("LINE ปฏิเสธใบตอบรับ 400 (การ์ดผิดสเปก) → ลองซ้ำด้วยข้อความอย่างเดียวครั้งเดียว · ประวัติจดเฉพาะที่ส่งจริง", async () => {
  const db = memoryDb();
  saveCampaign(db, { ...IESA6, sendAt: isoBangkok(Date.now() + DAY) });
  db.upsertCustomer("U-400", {});
  const calls = [];
  const line = {
    replyMessages: async (args) => {
      calls.push(args.messages.map((m) => m.type));
      return args.messages.some((m) => m.type === "flex") ? { ok: false, mode: "push", status: 400 } : { ok: true, mode: "reply" };
    },
  };
  const intake = createBlueprintCampaign({ db, line, logger: silent });
  const verdict = await intake.intake({ ...intake.match({ customerId: "U-400", text: TEMPLATE }), customerId: "U-400", text: TEMPLATE, replyToken: "rt" });
  assert.equal(verdict.sent, true);
  assert.equal(verdict.sendResult.fallback, "text_only");
  assert.deepEqual(calls, [["text", "flex"], ["text"]]);
  assert.equal(ackRows(db, "U-400").length, 1);
  assert.match(db.listAudit().find((a) => a.action === "blueprint_ack").detail, /text_only/u);
  db.close();
});

test("เส้นเดิมเล่นข้อความค้างซ้ำ (ไม่มี turnId) = ไม่ใช่คำขอใหม่: ไม่นับ ไม่ทิ้งร่าง ไม่ตอบรับซ้ำ", async (t) => {
  const { app, db, line } = appFixture(t);
  db.upsertCustomer("U-replay", {});
  await app.pipeline.handleInboundText({ customerId: "U-replay", text: TEMPLATE, replyToken: "rt-1", turnId: "in:r1" });
  const key = "blueprint_req:IESA6:U-replay";
  db.setSetting(key, JSON.stringify({ ...JSON.parse(db.getSetting(key)), status: "ready", draft: { blueprint: SAMPLE_BLUEPRINT } }));
  const replay = await app.pipeline.handleInboundText({ customerId: "U-replay", text: TEMPLATE, replyToken: "" });
  assert.equal(replay.suppressed, "blueprint_duplicate");
  const entry = readEntry(db, "IESA6", "U-replay");
  assert.equal(entry.status, "ready");
  assert.equal(entry.submissions, 1);
  assert.ok(entry.draft);
  assert.equal(line.sends.filter((c) => c.url.endsWith("/v2/bot/message/reply")).length, 1);
});

test("คีย์เวิร์ด: เว้นวรรคแทรกได้ไม่เกินหนึ่งช่อง · # ต้องติดตัวอักษร", () => {
  const re = keywordRegex("#AIAGENT");
  for (const text of ["#AIAGENT", "#AI AGENT ร้าน", "#aiagent\nธุรกิจ: x"]) assert.ok(re.test(text), text);
  for (const text of ["#A I A G E N T", "#AI  AGENT", "# AIAGENT", "#A I AGENT"]) assert.ok(!re.test(text), text);
});

test("ตั้งแคมเปญด้วยคีย์เวิร์ดที่ชน # เดิม (รายการ # ธุรกิจ / กติกา # → ป้าย / แคมเปญอื่น) = ปฏิเสธ · แก้แคมเปญเดิมได้", () => {
  const db = memoryDb();
  db.setSetting("hashtag_business_keywords", JSON.stringify({ "#horeca": "สนใจคลาส", online: "เรียนออนไลน์" }));
  db.setSetting("hashtag_tag_rules", JSON.stringify({ "#make": { dimension: "ของแจก", value: "Make Cheat Sheet" } }));
  const base = { ...IESA6, sendAt: "2026-10-12T10:00:00+07:00" };
  for (const keyword of ["#HORECA", "#online", "#Make"]) {
    const saved = saveCampaign(db, { ...base, campaignId: "NEXT", keyword });
    assert.equal(saved.ok, false, keyword);
  }
  assert.equal(saveCampaign(db, base).ok, true);
  assert.equal(saveCampaign(db, { ...base, campaignId: "IESA7", keyword: "#aiagent" }).ok, false, "ชนแคมเปญที่มีอยู่");
  assert.equal(saveCampaign(db, { ...base, enabled: false }).ok, true, "เปิด/ปิดแคมเปญเดิมไม่ถูกขวาง");
  assert.equal(campaignForText("#AIAGENT", readCampaigns(db)), null);
  db.close();
});

test("เก็บคำขอก่อน deploy ย้อนหลัง: dry-run นับอย่างเดียว · --apply เก็บ+พัก FU+ป้าย ไม่ส่ง LINE · ทำซ้ำไม่นับซ้ำ · ข้าม Facebook/คนที่มีคำขอแล้ว", async () => {
  const live = Date.parse("2026-10-11T14:40:00+07:00");
  let clock = live;
  const db = memoryDb({ now: () => clock });
  saveCampaign(db, { ...IESA6, sendAt: "2026-10-12T10:00:00+07:00" });
  const inbound = (customerId, content, channelId = "default") => {
    clock += 60_000;
    return db.persistLineInbound({ dedupeKey: `d-${customerId}-${clock}`, customerId, channelId, msgType: "text", content, owesReply: true, channelKind: channelId === "facebook" ? "facebook" : "line" });
  };
  inbound("U-early", TEMPLATE); // ก่อนเวลาที่สั่ง --since → ไม่นับ
  const since = clock + 1;
  inbound("U-a", TEMPLATE);
  inbound("U-a", TEMPLATE.replace("ร้านกาแฟสองสาขา", "โรงแรมบูทีค")); // ล่าสุดชนะ
  inbound("U-b", "#AIAGENT\nอยากให้ผู้ช่วยตอบแชท");
  inbound("U-chat", "สวัสดีค่ะ");
  inbound("U-mid", "สนใจ #AIAGENT ค่ะ");
  inbound("facebook:P1", TEMPLATE, "facebook");
  inbound("U-live", TEMPLATE);
  const intake = createBlueprintCampaign({ db, line: { replyMessages: async () => ({ ok: true, mode: "reply" }) }, now: () => clock, logger: silent });
  await intake.intake({ ...intake.match({ customerId: "U-live", text: TEMPLATE }), customerId: "U-live", text: TEMPLATE, replyToken: "rt" });
  const sinceIso = new Date(since).toISOString();

  const dry = runCommand(db, { command: "backfill", args: ["IESA6", "--since", sinceIso], nowMs: clock });
  assert.equal(dry.ok, true);
  assert.equal(dry.changed, 2);
  assert.match(dry.message, /dry-run/u);
  assert.equal(readEntry(db, "IESA6", "U-a"), null);

  const done = runCommand(db, { command: "backfill", args: ["IESA6", "--since", sinceIso], apply: true, nowMs: clock });
  assert.equal(done.changed, 2);
  assert.match(done.message, /มีคำขออยู่แล้ว 1 · Facebook ข้าม 1/u);
  const a = readEntry(db, "IESA6", "U-a");
  assert.equal(a.business, "โรงแรมบูทีค");
  assert.equal(a.status, "pending");
  assert.equal(a.backfilled, true);
  assert.equal(a.hold.applied, true);
  assert.equal(db.getCustomer("U-a").followup_enabled, 0);
  assert.ok(db.listTags("U-a").some((tag) => tag.tag === "ที่มา: IESA6 · AI Agent"));
  assert.equal(readEntry(db, "IESA6", "U-b").answer, "อยากให้ผู้ช่วยตอบแชท");
  for (const id of ["U-early", "U-chat", "U-mid", "facebook:P1"]) assert.equal(readEntry(db, "IESA6", id), null, id);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND customer_id IN ('U-a','U-b')").get().n, 0, "ไม่ส่งใบตอบรับย้อนหลัง");
  assert.equal(runCommand(db, { command: "backfill", args: ["IESA6", "--since", sinceIso], apply: true, nowMs: clock }).changed, 0, "ทำซ้ำไม่นับซ้ำ");
  assert.equal(runCommand(db, { command: "backfill", args: ["IESA6", "--since", "yesterday"], nowMs: clock }).ok, false);
  assert.doesNotMatch(done.message, /U-a|โรงแรม/u, "ผลที่พิมพ์ไม่มีรหัส/เนื้อหาลูกค้า");
  db.close();
});

test("rollback-check: มีห้องพัก FU ค้าง = ไม่ผ่าน (บอกคำสั่งคืน) · คืนแล้ว = ผ่าน · render เขียนไฟล์ตรวจกับ LINE validate", async () => {
  const now = Date.parse("2026-10-11T15:10:00+07:00");
  const db = memoryDb({ now: () => now });
  saveCampaign(db, { ...IESA6, sendAt: "2026-10-12T10:00:00+07:00" });
  assert.equal(runCommand(db, { command: "rollback-check", nowMs: now }).ok, true);
  db.upsertCustomer("U-h", {});
  const intake = createBlueprintCampaign({ db, line: { replyMessages: async () => ({ ok: true, mode: "reply" }) }, now: () => now, logger: silent });
  await intake.intake({ ...intake.match({ customerId: "U-h", text: TEMPLATE }), customerId: "U-h", text: TEMPLATE, replyToken: "rt" });
  const blocked = runCommand(db, { command: "rollback-check", nowMs: now });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.changed, 1);
  assert.match(blocked.message, /release-holds IESA6 --apply/u);
  runCommand(db, { command: "release-holds", args: ["IESA6"], apply: true, nowMs: now });
  assert.equal(runCommand(db, { command: "rollback-check", nowMs: now }).ok, true);

  const dir = mkdtempSync(join(tmpdir(), "bp-render-"));
  const sample = join(dir, "sample.json");
  writeFileSync(sample, JSON.stringify(SAMPLE_BLUEPRINT));
  assert.equal(runCommand(db, { command: "render", args: ["IESA6", "--out", join(dir, "out")], nowMs: now }).ok, false, "ไม่มีร่างในฐานและไม่ใส่ตัวอย่าง");
  const rendered = runCommand(db, { command: "render", args: ["IESA6", "--out", join(dir, "out"), "--sample", sample], nowMs: now });
  assert.equal(rendered.ok, true, rendered.message);
  const ack = JSON.parse(readFileSync(join(dir, "out", "ack.json"), "utf8"));
  const delivery = JSON.parse(readFileSync(join(dir, "out", "delivery.json"), "utf8"));
  assert.ok(ack.messages.length >= 1 && ack.messages.length <= 5);
  assert.equal(delivery.messages[0].type, "flex");
  assert.ok(delivery.messages.length <= 5);
  db.close();
});

test("โมดูลเนื้อหา (src/blueprint/*) ต้องโหลดได้ในต้นไม้ที่จะปล่อย — หาย = แคมเปญปิดเงียบ ทั้งที่ฟอร์มส่งคนมาแล้ว", async () => {
  const { blueprintContent, blueprintContentError } = await import("../src/blueprintContent.mjs");
  assert.ok(blueprintContent(), `โหลดไม่ได้: ${blueprintContentError()}`);
  for (const fn of ["parseBlueprintText", "buildBlueprintMessages", "buildBlueprintFlex", "buildAckMessages", "blueprintToText"]) {
    assert.equal(typeof blueprintContent()[fn], "function", fn);
  }
});
