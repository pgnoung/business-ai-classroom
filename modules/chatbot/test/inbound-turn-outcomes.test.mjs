// inbound-turn-outcomes — บัญชีผลลัพธ์เทิร์นขาเข้า
//
// กฎเหล็กของตารางนี้: ห้ามมีโค้ดบรรทัดใดอ่านตารางนี้แล้วเรียก pipeline หรือ sendBubbles
// T-07 คือด่านที่บังคับกฎนั้นด้วยเครื่อง — ห้ามลบเทสต์นี้
import test from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { createApp } from "../src/server.mjs";
import { stampInboundOutcome } from "../src/inboundOutcome.mjs";
import { SCHEDULE_ENABLED_KEY, SCHEDULE_HOURS_KEY } from "../src/scheduleGate.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  signLine, httpRequest, listen, waitFor, sleep,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {} };
const SECRET = "test-line-secret";

const turnOf = (db, id) => db.raw.prepare("SELECT * FROM inbound_turn_outcomes WHERE message_id = ?").get(id);

function seedTurn(db, { messageId, customerId, status = "owed", processId = "process-เก่า", createdAt = Date.now() }) {
  db.raw.prepare(
    `INSERT INTO inbound_turn_outcomes
      (message_id, customer_id, channel_id, channel_kind, status, reason, process_id, created_at, updated_at)
     VALUES (?, ?, 'default', 'line', ?, '', ?, ?, ?)`
  ).run(String(messageId), String(customerId), String(status), String(processId), Number(createdAt), Number(createdAt));
}

async function buildApp(t, {
  configOverrides = {}, beforeApp = null, hermesText = "ขอบคุณที่ทักมานะคะ", listenServer = false,
  db: injectedDb = null, lineFetch: injectedLineFetch = null, extraOverrides = {},
} = {}) {
  const config = testConfig(configOverrides);
  const db = injectedDb ?? memoryDb();
  if (beforeApp) beforeApp(db);
  const hermesFetch = hermesFetchStub(hermesText);
  const lineFetch = injectedLineFetch ?? lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {}, ...extraOverrides },
    logger: silent,
  });
  if (listenServer) await listen(app.server);
  t.after(() => { app.learning.stop(); app.server.close(); db.close(); });
  return { app, db, config, lineFetch, hermesFetch };
}

function webhookBody(messageId, { text = "สวัสดีค่ะ", userId = "Uturn" } = {}) {
  return JSON.stringify({
    events: [{
      type: "message", webhookEventId: `w-${messageId}`, replyToken: `rt-${messageId}`,
      source: { type: "user", userId }, message: { id: messageId, type: "text", text },
    }],
  });
}

function post(server, raw) {
  return httpRequest(server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, SECRET) },
    body: raw,
  });
}

test("T-07 (กฎเหล็ก) บูตใหม่ที่มีเทิร์นค้างของโปรเซสอื่น -> ปักธงอย่างเดียว ไม่เรียก provider เลย", async (t) => {
  const { db, lineFetch } = await buildApp(t, {
    beforeApp: (database) => {
      database.upsertCustomer("Uturn-owed", { channelId: "default" });
      database.upsertCustomer("Uturn-sending", { channelId: "default" });
      seedTurn(database, { messageId: "in:old-owed", customerId: "Uturn-owed", status: "owed" });
      seedTurn(database, { messageId: "in:old-sending", customerId: "Uturn-sending", status: "sending" });
    },
  });
  await waitFor(() => turnOf(db, "in:old-owed")?.status !== "owed");
  assert.equal(turnOf(db, "in:old-owed").status, "stranded_crash");
  assert.equal(turnOf(db, "in:old-sending").status, "stranded_ambiguous");
  assert.equal(db.getCustomer("Uturn-owed")?.state, "NEEDS_HUMAN");
  await sleep(30);
  assert.equal(lineFetch.calls.length, 0, "ตัวกวาดตอน boot ห้ามยิง provider แม้แต่ครั้งเดียว");
});

test("T-08 เทิร์นค้างที่มีคำตอบตามหลังแล้ว -> ปิดเงียบ ไม่ปลุกใคร", async (t) => {
  const { db, lineFetch } = await buildApp(t, {
    beforeApp: (database) => {
      const createdAt = Date.now() - 60_000;
      database.upsertCustomer("Uturn-late", { channelId: "default" });
      // ลำดับนี้จำลอง "ส่งสำเร็จแล้วตายก่อนจะจดสถานะ": แถวขาออกมีอยู่จริง
      // แต่แถวบัญชีเทิร์นยังค้างเป็น sending ของโปรเซสที่ตายไปแล้ว
      database.insertMessage({
        customerId: "Uturn-late", direction: "out", content: "ตอบไปแล้วค่ะ",
        messageClass: "reactive", agentMode: "ai",
      });
      seedTurn(database, { messageId: "in:late", customerId: "Uturn-late", status: "sending", createdAt });
    },
  });
  await waitFor(() => turnOf(db, "in:late")?.status !== "sending");
  assert.equal(turnOf(db, "in:late").status, "answered");
  assert.equal(turnOf(db, "in:late").reason, "late_outbound");
  assert.notEqual(db.getCustomer("Uturn-late")?.state, "NEEDS_HUMAN");
  await sleep(30);
  assert.equal(lineFetch.calls.length, 0);
});

test("T-09 เทิร์นค้างในห้องที่ปิด AI อยู่แล้ว -> บันทึกไว้เฉย ๆ ไม่ปลุกใคร", async (t) => {
  const { db } = await buildApp(t, {
    beforeApp: (database) => {
      database.upsertCustomer("Uturn-off", { channelId: "default" });
      database.setAiEnabled("Uturn-off", false, "customer_handover");
      seedTurn(database, { messageId: "in:off", customerId: "Uturn-off", status: "owed" });
    },
  });
  await waitFor(() => turnOf(db, "in:off")?.status !== "owed");
  assert.equal(turnOf(db, "in:off").status, "stranded_crash");
  assert.notEqual(db.getCustomer("Uturn-off")?.state, "NEEDS_HUMAN");
});

test("T-10a ห้องที่ปิด AI -> silent_by_design:ai_disabled และไม่ส่งอะไร", async (t) => {
  const { app, db, lineFetch } = await buildApp(t, { listenServer: true });
  db.upsertCustomer("Uturn", { channelId: "default" });
  db.setAiEnabled("Uturn", false, "customer_handover");
  await post(app.server, webhookBody("m-t10a", { text: "สนใจคอร์สค่ะ" }));
  await waitFor(() => turnOf(db, "in:m-t10a")?.status !== "owed");
  assert.equal(turnOf(db, "in:m-t10a").status, "silent_by_design");
  assert.equal(turnOf(db, "in:m-t10a").reason, "ai_disabled");
  assert.equal(lineFetch.sends.length, 0);
});

test("T-10b ข้อความ hashtag -> silent_by_design:hashtag_auto_response", async (t) => {
  const { app, db, lineFetch } = await buildApp(t, { listenServer: true });
  await post(app.server, webhookBody("m-t10b", { text: "#horeca" }));
  await waitFor(() => turnOf(db, "in:m-t10b")?.status !== "owed");
  assert.equal(turnOf(db, "in:m-t10b").reason, "hashtag_auto_response");
  assert.equal(lineFetch.sends.length, 0);
});

test("T-10c นอกเวลาทำการ -> silent_by_design:schedule_off", async (t) => {
  const { app, db, lineFetch } = await buildApp(t, { listenServer: true });
  // หน้าต่างทำการหนึ่งนาทีที่อยู่คนละฝั่งกับเวลาปัจจุบันเสมอ (เวลาไทย ไม่มี DST)
  const bangkokMinute = Math.floor(((Date.now() + 7 * 3_600_000) % 86_400_000) / 60_000);
  const startMin = (bangkokMinute + 120) % 1440;
  const endMin = (startMin + 1) % 1440;
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  db.setSetting(SCHEDULE_ENABLED_KEY, "1");
  db.setSetting(SCHEDULE_HOURS_KEY, `${hhmm(startMin)}-${hhmm(endMin)}`);
  await post(app.server, webhookBody("m-t10c", { text: "สนใจคอร์สค่ะ" }));
  await waitFor(() => turnOf(db, "in:m-t10c")?.status !== "owed");
  assert.equal(turnOf(db, "in:m-t10c").reason, "schedule_off");
  assert.equal(lineFetch.sends.length, 0);
});

test("T-11 เทิร์นเก่าเกินกำหนด -> ไม่ส่ง และบันทึกเหตุ reply_too_old", async (t) => {
  const { app, db, lineFetch } = await buildApp(t, {
    listenServer: true, configOverrides: { REPLY_MAX_AGE_MS: "1" },
  });
  await post(app.server, webhookBody("m-t11", { text: "ขอรายละเอียดคอร์สหน่อยค่ะ" }));
  await waitFor(() => turnOf(db, "in:m-t11")?.status !== "owed");
  assert.equal(turnOf(db, "in:m-t11").status, "silent_by_design");
  assert.equal(turnOf(db, "in:m-t11").reason, "reply_too_old");
  assert.equal(lineFetch.sends.length, 0);
});

test("T-12 absorbed/merged_forward ยังค้าง owed แล้วถูกปิดเป็น answered เมื่อคำตอบออกจริง", async (t) => {
  const { db } = await buildApp(t);
  db.upsertCustomer("Uturn-carry", { channelId: "default" });
  seedTurn(db, { messageId: "in:carry-1", customerId: "Uturn-carry", status: "owed", createdAt: Date.now() - 5_000 });
  seedTurn(db, { messageId: "in:carry-2", customerId: "Uturn-carry", status: "owed", createdAt: Date.now() - 4_000 });

  stampInboundOutcome(db, "in:carry-1", { absorbed: true }, silent);
  stampInboundOutcome(db, "in:carry-2", { suppressed: "merged_forward", stage: "before_draft" }, silent);
  assert.equal(turnOf(db, "in:carry-1").status, "owed", "เทิร์นที่รอเทิร์นอื่นตอบให้ ห้าม settle");
  assert.equal(turnOf(db, "in:carry-2").status, "owed");

  db.insertMessage({
    customerId: "Uturn-carry", direction: "out", content: "ตอบครอบทุกข้อความค่ะ",
    messageClass: "reactive", agentMode: "ai",
  });
  assert.equal(turnOf(db, "in:carry-1").status, "answered");
  assert.equal(turnOf(db, "in:carry-2").status, "answered");
});

/* ------------------------------------------------------------------------- *
 * ชุด T-13..T-18 — กันบั๊กย้อนกลับจากการตรวจอิสระ 2026-09-01
 * ทุกข้อในชุดนี้คือช่องที่ "บัญชีเทิร์นบอกตรงข้ามกับความจริง" ซึ่งอันตรายกว่าไม่มีบัญชีเลย
 * เพราะแอดมินตัดสินใจพิมพ์ตอบ/ไม่พิมพ์ตอบ จากสิ่งที่บัญชีนี้บอก
 * ------------------------------------------------------------------------- */

test("T-13 ลูกค้าพิมพ์แทรกระหว่างบอทกำลังทยอยส่ง -> เทิร์นที่แทรกเข้ามาต้องไม่ถูกปิดเป็น answered", () => {
  const db = memoryDb();
  const basisAt = Date.now() - 10_000;      // ข้อความ A ที่บอทกำลังตอบอยู่
  db.upsertCustomer("Uinterleave", { channelId: "default" });
  seedTurn(db, { messageId: "in:A", customerId: "Uinterleave", createdAt: basisAt });
  // B พิมพ์แทรกเข้ามาระหว่างเว้นจังหวะพิมพ์ (ช่องกว้าง ~12 วิ) — ยังไม่มีใครตอบมัน
  seedTurn(db, { messageId: "in:B", customerId: "Uinterleave", createdAt: basisAt + 6_000 });

  // คำตอบของ A ถูกบันทึกขาออก พร้อมขอบเขตที่มันครอบจริง
  db.insertMessage({
    customerId: "Uinterleave", direction: "out", content: "คำตอบของข้อความ A ค่ะ",
    messageClass: "reactive", agentMode: "ai", settleTurnsUpTo: basisAt,
  });

  assert.equal(turnOf(db, "in:A").status, "answered");
  assert.equal(turnOf(db, "in:B").status, "owed", "ข้อความที่แทรกเข้ามาระหว่างส่ง ยังไม่มีใครตอบ ห้ามปิดบัญชี");
  db.close();
});

test("T-14 ส่งล้ม/ถูกปิดกั้น -> ห้ามจดว่า answered (ต้องยังเห็นว่าลูกค้าไม่ได้อะไรเลย)", () => {
  const db = memoryDb();
  db.upsertCustomer("Usend", { channelId: "default" });
  seedTurn(db, { messageId: "in:quota", customerId: "Usend" });
  seedTurn(db, { messageId: "in:blocked", customerId: "Usend", createdAt: Date.now() + 1_000 });

  // โควตา push รายเดือนหมด (เกิดจริง 2026-08-15) — ยิงแล้วล้มจริง
  stampInboundOutcome(db, "in:quota", { sent: false, sendResult: { ok: false, status: 429 } }, silent);
  assert.equal(turnOf(db, "in:quota").status, "stranded_error");
  assert.match(turnOf(db, "in:quota").reason, /^send_failed:429$/u);

  // ถูกปิดกั้นโดยกติกาของเราเอง — ตั้งใจไม่ส่ง แต่ต้องเห็นเหตุผลจริง
  stampInboundOutcome(db, "in:blocked",
    { sent: false, sendResult: { ok: false, blocked: true, reason: "pilot_not_allowlisted" } }, silent);
  assert.equal(turnOf(db, "in:blocked").status, "silent_by_design");
  assert.equal(turnOf(db, "in:blocked").reason, "send_blocked:pilot_not_allowlisted");
  db.close();
});

test("T-15 เทิร์นผู้นำ 'ตั้งใจเงียบ' -> แถวพี่น้องที่ถูก burst ดูดไปต้องปิดตามด้วย", () => {
  const db = memoryDb();
  const base = Date.now() - 5_000;
  db.upsertCustomer("Uburst", { channelId: "default" });
  seedTurn(db, { messageId: "in:b1", customerId: "Uburst", createdAt: base });
  seedTurn(db, { messageId: "in:b2", customerId: "Uburst", createdAt: base + 2_000 });

  stampInboundOutcome(db, "in:b1", { absorbed: true }, silent);      // ข้อความแรกถูกดูดเข้า burst
  stampInboundOutcome(db, "in:b2", { suppressed: "schedule_off" }, silent);  // leader เงียบถูกต้อง

  // ของเดิม in:b1 จะค้าง owed ข้ามคืน แล้วบูตครั้งหน้าปลุกคนด้วยข้อความเท็จว่า
  // "ระบบดับก่อนบอทได้ตอบ" ทั้งที่ระบบนอกเวลาทำการทำถูกทุกอย่าง
  assert.equal(turnOf(db, "in:b1").status, "silent_by_design");
  assert.equal(turnOf(db, "in:b2").status, "silent_by_design");
  db.close();
});

test("T-16 เส้นรูป (จำแนกว่าไม่ใช่เรื่องเงิน) ต้องขึ้นสถานะ 'sending' ก่อนไบต์แรกถึง LINE", async (t) => {
  const db = memoryDb();
  const base = lineFetchStub();
  let statusAtSend = null;
  const lineFetch = async (url, opts) => {
    // อ่านสถานะ ณ วินาทีที่กำลังยิงข้อความจริง — ถ้า turnId ไม่ถูกส่งต่อมาถึง respondToBurst
    // แถวจะยังเป็น 'owed' ตลอดการส่ง แล้วตายกลางส่งจะถูกจำแนกผิดเป็น "ยังไม่มีใครตอบ"
    if (String(url).includes("/v2/bot/message/") && statusAtSend === null) {
      statusAtSend = turnOf(db, "in:m-img")?.status ?? "ไม่มีแถว";
    }
    return base(url, opts);
  };
  lineFetch.calls = base.calls;
  Object.defineProperty(lineFetch, "sends", { get: () => base.sends });

  const { app } = await buildApp(t, {
    db, lineFetch, listenServer: true,
    extraOverrides: {
      imageClassify: { enabled: true, classify: async () => ({ kind: "other", description: "รูปโพสต์คลาส" }) },
    },
  });
  const raw = JSON.stringify({
    events: [{
      type: "message", webhookEventId: "w-m-img", replyToken: "rt-m-img",
      source: { type: "user", userId: "Uturn" }, message: { id: "m-img", type: "image" },
    }],
  });
  await post(app.server, raw);
  await waitFor(() => statusAtSend !== null);
  assert.equal(statusAtSend, "sending");
});

test("T-17 เส้นเสียง (ถอดความไม่สำเร็จ) ต้องขึ้นสถานะ 'sending' ก่อน template ถึงลูกค้า", async (t) => {
  const db = memoryDb();
  const base = lineFetchStub();
  let statusAtSend = null;
  const lineFetch = async (url, opts) => {
    if (String(url).includes("/v2/bot/message/") && statusAtSend === null) {
      statusAtSend = turnOf(db, "in:m-audio")?.status ?? "ไม่มีแถว";
    }
    return base(url, opts);
  };
  lineFetch.calls = base.calls;
  Object.defineProperty(lineFetch, "sends", { get: () => base.sends });

  const { app } = await buildApp(t, {
    db, lineFetch, listenServer: true,
    extraOverrides: { transcriber: { transcribe: async () => ({ ok: false, reason: "transcriber_error" }) } },
  });
  const raw = JSON.stringify({
    events: [{
      type: "message", webhookEventId: "w-m-audio", replyToken: "rt-m-audio",
      source: { type: "user", userId: "Uturn" }, message: { id: "m-audio", type: "audio" },
    }],
  });
  await post(app.server, raw);
  await waitFor(() => statusAtSend !== null);
  assert.equal(statusAtSend, "sending");
});

test("T-18 เทิร์นของโปรเซสอื่นที่ยังหายใจอยู่ -> ห้ามปักธงทับงานที่เขากำลังตอบ", async (t) => {
  // pid 1 (launchd/init) มีอยู่เสมอบน POSIX และเราไม่มีสิทธิ์ส่งสัญญาณ (EPERM = ยังมีชีวิต)
  // จึงใช้จำลอง "โปรเซสเจ้าของแถวยังทำงานอยู่" ได้แบบไม่ต้องสร้างโปรเซสจริง
  const liveOwner = `${hostname()}#1#feedface`;
  const { db } = await buildApp(t, {
    beforeApp: (database) => {
      database.upsertCustomer("Ulive", { channelId: "default" });
      database.upsertCustomer("Udead", { channelId: "default" });
      seedTurn(database, { messageId: "in:live", customerId: "Ulive", processId: liveOwner });
      seedTurn(database, { messageId: "in:dead", customerId: "Udead", processId: "process-ที่ตายแล้ว" });
    },
  });
  await waitFor(() => turnOf(db, "in:dead")?.status !== "owed");
  assert.equal(turnOf(db, "in:dead").status, "stranded_crash");
  assert.equal(turnOf(db, "in:live").status, "owed", "งานของโปรเซสที่ยังทำงานอยู่ ห้ามแตะ");
  assert.notEqual(db.getCustomer("Ulive")?.state, "NEEDS_HUMAN");
});
