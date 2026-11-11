// line-send-ledger — บัญชี "ระบบยิง LINE ไปทำอะไร" (28 ก.ย. 2026)
// พี่ง้วงถามว่า push มาจากแจ้งเตือนทีม บรอดแคสต์ หรือส่งหาลูกค้าจริง — ตัวเลขต้องแยกได้ตั้งแต่ต้นทาง
// เทสต์นี้ยืนยัน: reply (ฟรี) กับ push (นับโควตา) ไม่ปนกัน · คำตอบที่หลุดเป็น push บอกเหตุได้ · บันทึกพังไม่กระทบการส่ง
import test from "node:test";
import assert from "node:assert/strict";
import { createLineClient, createLineRegistry } from "../src/lineClient.mjs";
import {
  SEND_PURPOSE, SEND_PURPOSES, bangkokDay, countsTowardQuota, createLineSendRecorder, fallbackPurpose,
  normalizeSendDetail, normalizeSendPurpose,
} from "../src/lineSendLedger.mjs";
import { createEscalationNotifier } from "../src/notify.mjs";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const DAY_MS = 86_400_000;

// stub LINE: ตอบตาม path — ค่าเริ่มต้น 200 ทุกคำขอ
function lineStub({ reply = 200, pushStatuses = [] } = {}) {
  const calls = [];
  let pushIndex = 0;
  const fn = async (url, opts = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: opts.body ? JSON.parse(opts.body) : null });
    let status = 200;
    if (path.endsWith("/reply")) status = reply;
    if (path.endsWith("/push")) { status = pushStatuses[pushIndex] ?? 200; pushIndex += 1; }
    return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

function ledgerClient({ fetchImpl = lineStub(), onSend, config = testConfig() } = {}) {
  const db = memoryDb();
  const recorder = onSend ?? createLineSendRecorder({ db, logger: silent });
  const client = createLineClient({ config, fetchImpl, sleep: async () => {}, logger: silent, onSend: recorder });
  return { db, client, fetchImpl, rows: () => db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" }) };
}

const plain = (rows) => rows.map((row) => ({ ...row }));
const pick = (rows, fields) => rows.map((row) => Object.fromEntries(fields.map((f) => [f, row[f]])));
const bubbles = (n) => Array.from({ length: n }, (_, i) => ({ text: `ข้อความที่ ${i + 1}` }));

/* ------------------------------ กติกากลาง ------------------------------ */

test("กติกากลาง: เหตุผลที่ไม่รู้จัก = other · reply เท่านั้นที่ไม่นับโควตา · ตอบลูกค้าที่ออก push เปลี่ยนชื่อเหตุผล", () => {
  assert.ok(SEND_PURPOSES.includes("team_alert") && SEND_PURPOSES.includes("customer_reply_fallback"));
  assert.equal(normalizeSendPurpose("team_alert"), "team_alert");
  assert.equal(normalizeSendPurpose("hack'; DROP"), "other");
  assert.equal(normalizeSendPurpose(undefined), "other");
  assert.equal(normalizeSendDetail("over_five"), "over_five");
  assert.equal(normalizeSendDetail("anything"), "");
  assert.equal(countsTowardQuota("reply"), false);
  for (const method of ["push", "multicast", "narrowcast", "broadcast"]) assert.equal(countsTowardQuota(method), true, method);
  assert.equal(countsTowardQuota("nonsense"), false);
  assert.equal(fallbackPurpose("customer_reply"), "customer_reply_fallback");
  assert.equal(fallbackPurpose("team_alert"), "team_alert");
});

test("วันของบัญชี = วันเวลาไทย (เที่ยงคืนไทย = 17:00 UTC ของวันก่อน)", () => {
  assert.equal(bangkokDay(Date.UTC(2026, 8, 30, 16, 59, 59)), "2026-09-30");
  assert.equal(bangkokDay(Date.UTC(2026, 8, 30, 17, 0, 0)), "2026-10-01");
});

test("ตัวบันทึก: รวมเป็นแถวเดียวต่อวัน×OA×วิธี×เหตุผล และบวกสะสม", () => {
  let t = Date.UTC(2026, 8, 28, 3, 0, 0);
  const db = memoryDb({ now: () => t });
  const record = createLineSendRecorder({ db, now: () => t, logger: silent });
  assert.equal(record({ channelId: "default", method: "push", purpose: "team_alert", sends: 1, recipients: 1, messageObjects: 1 }), true);
  t += 60_000;
  assert.equal(record({ channelId: "default", method: "push", purpose: "team_alert", sends: 1, recipients: 1, messageObjects: 1 }), true);
  assert.equal(record({ channelId: "default", method: "carrier-pigeon", purpose: "team_alert" }), false, "วิธีส่งที่ไม่รู้จักไม่ถูกบันทึก");
  const rows = plain(db.lineSendRows({ fromDay: "2026-09-01", toDay: "2026-09-30" }));
  assert.equal(rows.length, 1);
  assert.deepEqual(pick(rows, ["day", "method", "purpose", "counts_quota", "sends", "requests", "recipients", "message_objects"]), [
    { day: "2026-09-28", method: "push", purpose: "team_alert", counts_quota: 1, sends: 2, requests: 2, recipients: 2, message_objects: 2 },
  ]);
  assert.equal(rows[0].first_at, Date.UTC(2026, 8, 28, 3, 0, 0));
  assert.equal(rows[0].last_at, Date.UTC(2026, 8, 28, 3, 1, 0));
  assert.equal(db.lineSendLedgerStart(), Date.UTC(2026, 8, 28, 3, 0, 0));
});

test("ตัวบันทึก: ฐานพังไม่โยน error และเตือนใน log ครั้งเดียวต่อช่วง (ไม่ถล่ม log)", () => {
  const warnings = [];
  const brokenDb = { addLineSend() { throw new Error("database is locked"); } };
  const record = createLineSendRecorder({ db: brokenDb, logger: { warn: (m) => warnings.push(m) } });
  for (let i = 0; i < 5; i += 1) assert.equal(record({ method: "push", purpose: "operator" }), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ไม่ได้รับผลกระทบ/u);
});

/* --------------------------- lineClient × บัญชี --------------------------- */

test("ตอบด้วย reply token สำเร็จ = แถว reply ฟรี 1 คำขอ (บอลลูนทั้งชุดอยู่ในคำขอเดียว)", async () => {
  const { client, rows } = ledgerClient();
  const result = await client.sendBubbles({ to: "Ucustomer", replyToken: "rt-1", bubbles: bubbles(3), purpose: SEND_PURPOSE.customerReply });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "reply");
  assert.deepEqual(pick(rows(), ["method", "purpose", "detail", "counts_quota", "sends", "requests", "recipients", "message_objects"]), [
    { method: "reply", purpose: "customer_reply", detail: "", counts_quota: 0, sends: 1, requests: 1, recipients: 1, message_objects: 3 },
  ]);
});

test("reply token ถูกปฏิเสธ (400) → push ทีละบอลลูน = นับโควตาบอลลูนละหนึ่ง เหตุ reply_rejected", async () => {
  const { client, rows, fetchImpl } = ledgerClient({ fetchImpl: lineStub({ reply: 400 }) });
  const result = await client.sendBubbles({ to: "Ucustomer", replyToken: "rt-old", bubbles: bubbles(3), purpose: SEND_PURPOSE.customerReply });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "push");
  assert.equal(fetchImpl.calls.filter((c) => c.path.endsWith("/push")).length, 3);
  assert.deepEqual(pick(rows(), ["method", "purpose", "detail", "counts_quota", "sends", "requests", "recipients", "message_objects"]), [
    { method: "push", purpose: "customer_reply_fallback", detail: "reply_rejected", counts_quota: 1, sends: 1, requests: 3, recipients: 3, message_objects: 3 },
  ], "reply ที่ถูกปฏิเสธไม่ถูกนับ และ push สามคำขอ = สามข้อความที่ LINE นับ แต่ส่งครั้งเดียว");
});

test("reply ผลกำกวม (500/timeout) ไม่ push ซ้ำ และไม่มีอะไรถูกนับ", async () => {
  const { client, rows } = ledgerClient({ fetchImpl: lineStub({ reply: 500 }) });
  const result = await client.sendBubbles({ to: "Ucustomer", replyToken: "rt-2", bubbles: bubbles(2), purpose: SEND_PURPOSE.customerReply });
  assert.equal(result.ok, false);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(rows(), []);
});

test("ตอบลูกค้าโดยไม่มี reply token = push เหตุ no_reply_token · เกิน 5 ก้อน = push เหตุ over_five", async () => {
  const { client, rows } = ledgerClient();
  await client.sendBubbles({ to: "Ucustomer", replyToken: "", bubbles: bubbles(1), purpose: SEND_PURPOSE.customerReply });
  await client.sendBubbles({ to: "Ucustomer", replyToken: "rt-3", bubbles: bubbles(6), purpose: SEND_PURPOSE.customerReply });
  const got = pick(rows(), ["purpose", "detail", "requests", "sends", "recipients"]);
  assert.deepEqual(got.sort((a, b) => a.detail.localeCompare(b.detail)), [
    { purpose: "customer_reply_fallback", detail: "no_reply_token", requests: 1, sends: 1, recipients: 1 },
    { purpose: "customer_reply_fallback", detail: "over_five", requests: 6, sends: 1, recipients: 6 },
  ]);
});

test("ทักตามแบบ batch: 7 บอลลูน = 2 คำขอ (5+2) นับ 2 ข้อความ ส่งครั้งเดียว", async () => {
  const { client, rows } = ledgerClient();
  const result = await client.sendBubbles({ to: "Ucustomer", bubbles: bubbles(7), batch: true, purpose: SEND_PURPOSE.followup });
  assert.equal(result.ok, true);
  assert.deepEqual(pick(rows(), ["method", "purpose", "detail", "sends", "requests", "recipients", "message_objects"]), [
    { method: "push", purpose: "followup", detail: "", sends: 1, requests: 2, recipients: 2, message_objects: 7 },
  ]);
});

test("push ล้มกลางชุด (โควตาหมด 429) = นับเฉพาะคำขอที่ LINE รับไปแล้ว", async () => {
  const { client, rows } = ledgerClient({ fetchImpl: lineStub({ pushStatuses: [200, 429] }) });
  const result = await client.sendBubbles({ to: "Uteam", bubbles: bubbles(3), purpose: SEND_PURPOSE.operator });
  assert.equal(result.ok, false);
  assert.deepEqual(pick(rows(), ["purpose", "requests", "recipients"]), [{ purpose: "operator", requests: 1, recipients: 1 }]);
});

test("multicast บรอดแคสต์ = นับตามจำนวนผู้รับ (ข้อความหลายก้อนในคำขอเดียวไม่เพิ่มยอด)", async () => {
  const { client, rows } = ledgerClient();
  const to = Array.from({ length: 120 }, (_, i) => `U${String(i).padStart(32, "0")}`);
  const result = await client.multicast({ to, messages: [{ type: "text", text: "a" }, { type: "text", text: "b" }], purpose: SEND_PURPOSE.broadcast });
  assert.equal(result.ok, true);
  assert.deepEqual(pick(rows(), ["method", "purpose", "counts_quota", "sends", "requests", "recipients", "message_objects"]), [
    { method: "multicast", purpose: "broadcast", counts_quota: 1, sends: 1, requests: 1, recipients: 120, message_objects: 2 },
  ]);
});

test("ไม่ระบุเหตุผล = other · LINE_LIVE_SEND ปิด = ไม่ยิงและไม่นับ", async () => {
  const { client, rows } = ledgerClient();
  await client.sendBubbles({ to: "Usomeone", bubbles: bubbles(1) });
  assert.deepEqual(pick(rows(), ["purpose"]), [{ purpose: "other" }]);
  const closed = ledgerClient({ config: testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "false" }) });
  const blocked = await closed.client.sendBubbles({ to: "Usomeone", bubbles: bubbles(1), purpose: SEND_PURPOSE.teamAlert });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(closed.rows(), []);
});

test("ตัวบันทึกโยน error เอง = การส่งยังสำเร็จครบ ผลลัพธ์ไม่เปลี่ยน", async () => {
  const { client, fetchImpl } = ledgerClient({ onSend: () => { throw new Error("ledger exploded"); } });
  const reply = await client.sendBubbles({ to: "U1", replyToken: "rt-9", bubbles: bubbles(2), purpose: SEND_PURPOSE.customerReply });
  assert.equal(reply.ok, true);
  assert.equal(reply.mode, "reply");
  const push = await client.sendBubbles({ to: "U1", bubbles: bubbles(2), purpose: SEND_PURPOSE.operator });
  assert.equal(push.ok, true);
  assert.equal(push.calls, 2);
  assert.equal(fetchImpl.calls.length, 3);
});

test("registry: client ของ LINE ได้ตัวบันทึก · channel ถูกจดตาม OA ที่ส่งจริง", async () => {
  const db = memoryDb();
  const registry = createLineRegistry({
    config: testConfig(),
    channels: [
      { id: "default", channelAccessToken: "tok-a", active: true },
      { id: "branch2", channelAccessToken: "tok-b", active: true },
    ],
    fetchImpl: lineStub(), sleep: async () => {}, logger: silent,
    onSend: createLineSendRecorder({ db, logger: silent }),
  });
  await registry.forChannel("branch2").sendBubbles({ to: "Ux", bubbles: bubbles(1), purpose: SEND_PURPOSE.yolo });
  const rows = db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" });
  assert.deepEqual(pick(rows, ["channel_id", "purpose"]), [{ channel_id: "branch2", purpose: "yolo" }]);
});

/* ------------------------------ ผู้เรียกจริง ------------------------------ */

test("notify: แจ้งเตือนทีม = push team_alert หนึ่งข้อความต่อผู้รับหนึ่งคน", async () => {
  const db = memoryDb();
  db.setSetting("escalate_notify:default", JSON.stringify([`U${"a".repeat(32)}`, `U${"b".repeat(32)}`]));
  db.upsertCustomer("Ucustomer-alert", { displayName: "ลูกค้าทดสอบ" });
  const registry = createLineRegistry({
    config: testConfig(), channels: [{ id: "default", channelAccessToken: "tok", active: true }],
    fetchImpl: lineStub(), sleep: async () => {}, logger: silent,
    onSend: createLineSendRecorder({ db, logger: silent }),
  });
  const notifier = createEscalationNotifier({ db, config: {}, lineRegistry: registry, logger: silent });
  const result = await notifier.fire({ customerId: "Ucustomer-alert", reason: "complaint", customerName: "ลูกค้าทดสอบ" });
  assert.equal(result.sent, 2);
  const rows = db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" });
  assert.deepEqual(pick(rows, ["method", "purpose", "counts_quota", "sends", "requests", "recipients"]), [
    { method: "push", purpose: "team_alert", counts_quota: 1, sends: 2, requests: 2, recipients: 2 },
  ]);
});

// ทุกจุดที่ยิง LINE ต้องบอกเหตุผลเองแบบชัด ๆ — ลืมใส่ = ตัวเลขไปกองที่ "อื่น ๆ" เงียบ ๆ
// (อ่านซอร์สตรง ๆ: เส้นทางเหล่านี้หลายเส้นต้องตั้งฉากใหญ่ถึงจะวิ่งได้ ส่วนเส้นหลักมีเทสต์พฤติกรรมข้างบน/ข้างล่างแล้ว)
test("ทุกจุดที่เรียก sendBubbles/multicast/pushMessages/replyMessages/broadcastMessages/narrowcast ระบุ purpose ตรงกับงานของไฟล์นั้น", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url);
  const expected = {
    "notify.mjs": ["teamAlert"],
    "digest.mjs": ["ownerDigest"],
    "hotFollowupPush.mjs": ["teamAlert"], // 29 ก.ย. 2026: สรุปลูกค้าร้อนรอทีมทักต่อ 3 รอบ/วัน = แจ้งทีม
    "pipeline.mjs": ["customerReply", "customerReply", "customerReply", "customerReply"],
    "stagedFollowups.mjs": ["followup"],
    "followupEngine.mjs": ["followup"],
    "paymentGentleNudge.mjs": ["followup"],
    "yoloDelivery.mjs": ["yolo"],
    "yoloHandoff.mjs": ["yolo"],
    "consoleApi.mjs": ["operator"],
    "broadcast.mjs": ["broadcast", "broadcast"],
    // 28 ก.ย. 2026 สตูดิโอบรอดแคสต์: ส่งถึงเพื่อนทุกคน (broadcast) + กลุ่มเป้าหมาย (narrowcast) + ส่งทดสอบถึงตัวเอง (push)
    "broadcastStudio.mjs": ["broadcast", "broadcast"],
    "stepMessages.mjs": ["stepMessage"],
    "consoleBroadcastStudioApi.mjs": ["broadcast"],
    "server.mjs": ["other"],
    "trainingCommands.mjs": ["other"],
    // 28 ก.ย. 2026: ลิงก์ต่อแชท LINE ที่ทีมกดส่งในห้อง Facebook (operator) + ตอบรับการเชื่อมใน LINE ด้วย reply token
    "identityLink.mjs": ["operator", "customerReply"],
    // 11 ต.ค. 2026 แคมเปญ #AIAGENT: ตอบรับคำขอด้วย reply token (customerReply) + ส่งการวางระบบ AI Agent ตามเวลา (campaign)
    // ใบตอบรับที่ LINE ปฏิเสธ 400 ลองซ้ำเป็นข้อความอย่างเดียว (customerReply) · การ์ดที่ถูกปฏิเสธ 400 ส่งซ้ำเป็นข้อความ (campaign)
    "blueprintCampaign.mjs": ["campaign", "customerReply"],
    "blueprintSender.mjs": ["campaign", "campaign"],
    // 12 ต.ค. 2026 ค่ำ: คำลาหลังทีมกดยืนยันปิดห้องที่ AI เสนอ (ห้องตรวจของพี่ง้วง)
    "ownerCloseService.mjs": ["ownerClose"],
  };
  const seen = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
    if (file === "lineClient.mjs" || file === "facebookClient.mjs") continue;
    const src = readFileSync(new URL(file, dir), "utf8");
    for (const match of src.matchAll(/\.(sendBubbles|multicast|pushMessages|replyMessages|broadcastMessages|narrowcast)\(\{/gu)) {
      // วงเล็บปีกกาของอาร์กิวเมนต์ — นับคู่จนปิด
      let depth = 0;
      let end = match.index + match[0].length - 1;
      for (; end < src.length; end += 1) {
        if (src[end] === "{") depth += 1;
        if (src[end] === "}") { depth -= 1; if (depth === 0) break; }
      }
      const args = src.slice(match.index, end + 1);
      const purpose = args.match(/purpose:\s*SEND_PURPOSE\.([A-Za-z]+)/u)?.[1] || "(ไม่มี)";
      (seen[file] ||= []).push(purpose);
    }
  }
  assert.deepEqual(seen, expected);
});

/* ------------------------------ เส้นทางตอบลูกค้าจริง ------------------------------ */

test("webhook → ลูกแพรตอบทัน = reply ฟรี · token หมดอายุ = customer_reply_fallback นับโควตา", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { hermesFetchStub, httpRequest, listen, signLine, waitFor } = await import("./helpers.mjs");
  for (const [label, replyStatus, expected] of [
    ["ทัน", 200, { method: "reply", purpose: "customer_reply", detail: "", counts_quota: 0 }],
    ["หมดอายุ", 400, { method: "push", purpose: "customer_reply_fallback", detail: "reply_rejected", counts_quota: 1 }],
  ]) {
    const db = memoryDb();
    const lineFetch = lineStub({ reply: replyStatus });
    const app = createApp({
      config: testConfig(), db, logger: silent,
      overrides: { hermesFetch: hermesFetchStub("ยินดีค่ะ ลูกแพรขอเล่าสั้น ๆ นะคะ"), lineFetch, sleep: async () => {} },
    });
    await listen(app.server);
    t.after(() => { app.server.close(); db.close(); });
    const raw = JSON.stringify({ events: [{
      type: "message", webhookEventId: `w-${label}`, replyToken: `rt-${label}`,
      source: { type: "user", userId: `Uledger${replyStatus}` }, message: { id: `m-${replyStatus}`, type: "text", text: "สนใจคลาสค่ะ" },
    }] });
    const res = await httpRequest(app.server, {
      method: "POST", path: "/webhooks/line",
      headers: { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") }, body: raw,
    });
    assert.equal(res.status, 200);
    await waitFor(() => db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" }).length > 0);
    const rows = db.lineSendRows({ fromDay: "2000-01-01", toDay: "2999-12-31" });
    assert.deepEqual(pick(rows, ["method", "purpose", "detail", "counts_quota"]), [expected], label);
    assert.equal(rows[0].sends, 1, label);
  }
});

test("บัญชีไม่มี id ลูกค้าหรือผู้รับเลย (อยู่นอก PDPA cascade โดยเจตนา)", () => {
  const db = memoryDb();
  for (const table of ["line_send_ledger", "line_delivery_insights"]) {
    const columns = db.raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    assert.ok(columns.length > 0, table);
    for (const forbidden of ["customer_id", "line_user_id", "to", "recipient_id", "message_id"]) {
      assert.ok(!columns.includes(forbidden), `${table}.${forbidden}`);
    }
  }
  assert.equal(DAY_MS, 86_400_000);
});
