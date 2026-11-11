// shutdown-drain — ปิดให้จบเทิร์น (Drain-to-Finish)
//
// เพดาน 3 วินาทีเดิมสั้นกว่าหน้าต่าง burst เสมอ => deploy ทุกครั้งยิงกลาง debounce พอดี
// เทสต์ชุดนี้ค้ำสามอย่าง: flush burst แล้ว "ส่งครั้งเดียว", เส้นตายการคิดต้องไม่ปล่อย
// template ปลอบใจออกไป, และข้อความที่เข้ามาระหว่างปิดต้องถูกเก็บ + ปักธงให้คนรับ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createShutdownCoordinator } from "../src/shutdown.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  signLine, httpRequest, listen, waitFor, sleep,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {} };
const SECRET = "test-line-secret";

// hermes ที่ไม่มีวันตอบ จนกว่าจะถูก abort — ใช้ทดสอบ "เส้นตายของการคิด"
function hangingHermesFetch() {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url) });
    await new Promise((_resolve, reject) => {
      const signal = opts?.signal;
      if (signal?.aborted) { reject(new Error("aborted")); return; }
      signal?.addEventListener?.("abort", () => reject(new Error("aborted")), { once: true });
    });
    throw new Error("unreachable");
  };
  fn.calls = calls;
  return fn;
}

async function startServer(t, { configOverrides = {}, hermesFetch = null } = {}) {
  const config = testConfig({
    SHUTDOWN_DRAIN_MS: "4000",
    SHUTDOWN_DRAFT_ABORT_MS: "3000",
    SHUTDOWN_HARD_EXIT_MS: "6000",
    ...configOverrides,
  });
  const db = memoryDb();
  const hermes = hermesFetch ?? hermesFetchStub("ขอบคุณที่ทักมานะคะ");
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermes, lineFetch, sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.learning.stop(); app.server.close(); db.close(); });
  const exits = [];
  // db shim: ปิดฐานจริงตอนเทสต์แล้วอ่านผลไม่ได้ — เส้นทางอื่นเหมือนของจริงทุกตัวอักษร
  const dbForShutdown = { ...db, close: () => { exits.push("db-closed"); } };
  const coordinator = createShutdownCoordinator({
    app, db: dbForShutdown, config, logger: silent,
    processId: app.processId,
    setDraining: (value) => app.setDraining(value),
    exit: (code) => { exits.push(code); },
  });
  return { app, db, config, lineFetch, hermes, coordinator, exits };
}

function webhookBody(messageId, { text = "สวัสดีค่ะ", userId = "Udrain" } = {}) {
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

const turnOf = (db, id) => db.raw.prepare("SELECT * FROM inbound_turn_outcomes WHERE message_id = ?").get(id);

test("T-03 burst ค้างสองข้อความ -> drain แล้วส่งครั้งเดียวพอดี", async (t) => {
  const { app, db, lineFetch, coordinator } = await startServer(t, {
    configOverrides: { BURST_DEBOUNCE_MS: "5000", BURST_MAX_WAIT_MS: "20000" },
  });
  await post(app.server, webhookBody("m-drain-1", { text: "สนใจคอร์สค่ะ" }));
  await post(app.server, webhookBody("m-drain-2", { text: "ราคาเท่าไหร่คะ" }));
  await waitFor(() => app.burst.pendingSize("Udrain") >= 2);

  await coordinator.run("SIGTERM");

  assert.equal(lineFetch.sends.length, 1, "ทั้ง burst ต้องได้คำตอบเดียว");
  assert.equal(turnOf(db, "in:m-drain-1")?.status, "answered");
  assert.equal(turnOf(db, "in:m-drain-2")?.status, "answered");
});

test("T-04 คิดไม่ทันเส้นตาย -> ไม่ส่งอะไรเลย ปักธงให้คนรับ ไม่มี template ปลอบใจหลุดออก", async (t) => {
  const hermes = hangingHermesFetch();
  const { app, db, lineFetch, coordinator } = await startServer(t, {
    hermesFetch: hermes,
    configOverrides: {
      BURST_DEBOUNCE_MS: "0", SHUTDOWN_DRAFT_ABORT_MS: "30",
      SHUTDOWN_DRAIN_MS: "3000", SHUTDOWN_HARD_EXIT_MS: "5000",
    },
  });
  await post(app.server, webhookBody("m-drain-3", { text: "ขอรายละเอียดคอร์สหน่อยค่ะ" }));
  await waitFor(() => hermes.calls.length >= 1);

  await coordinator.run("SIGTERM");

  assert.equal(lineFetch.sends.length, 0, "ห้ามส่งอะไรถึงลูกค้าเลย");
  const outbound = db.messagesFor("Udrain").filter((m) => m.direction === "out");
  assert.equal(outbound.length, 0, "ห้ามมี template ปลอบใจถูกบันทึก/ส่ง");
  assert.equal(turnOf(db, "in:m-drain-3")?.status, "stranded_shutdown");
  assert.equal(db.getCustomer("Udrain")?.state, "NEEDS_HUMAN");
});

test("T-05 ข้อความเข้ามาระหว่างระบบกำลังปิด -> เก็บครบ ไม่ตอบ ปักธงให้คนรับ", async (t) => {
  const { app, db, lineFetch } = await startServer(t);
  app.setDraining(true);
  const res = await post(app.server, webhookBody("m-drain-4", { text: "สวัสดีค่ะ" }));
  assert.equal(res.status, 200);
  assert.ok(res.json.accepted >= 1);
  await sleep(50);
  assert.equal(lineFetch.sends.length, 0);
  const inbound = db.messagesFor("Udrain").filter((m) => m.direction === "in");
  assert.equal(inbound.length, 1, "ข้อความลูกค้าต้องอยู่ในฐานครบ");
  assert.equal(turnOf(db, "in:m-drain-4")?.status, "stranded_shutdown");
  assert.equal(db.getCustomer("Udrain")?.state, "NEEDS_HUMAN");
});

test("T-06 SIGTERM สองครั้ง -> drain รอบเดียว flush ครั้งเดียว ส่งครั้งเดียว", async (t) => {
  const { app, lineFetch, coordinator } = await startServer(t, {
    configOverrides: { BURST_DEBOUNCE_MS: "5000", BURST_MAX_WAIT_MS: "20000" },
  });
  let flushes = 0;
  const originalFlushAll = app.burst.flushAll.bind(app.burst);
  app.burst.flushAll = () => { flushes += 1; return originalFlushAll(); };

  await post(app.server, webhookBody("m-drain-5", { text: "สนใจค่ะ" }));
  await waitFor(() => app.burst.pendingSize("Udrain") >= 1);

  const first = coordinator.run("SIGTERM");
  const second = coordinator.run("SIGTERM");
  await Promise.all([first, second]);

  assert.equal(flushes, 1, "drain ต้องเริ่มรอบเดียว");
  assert.equal(lineFetch.sends.length, 1);
});

// hermes ที่ค้างไว้ได้ แล้ว "ปล่อย" ตอนจบเทสต์ — ต่างจาก hangingHermesFetch ตรงที่
// เส้น hard exit ไม่มีการ abort draft ให้ ถ้าไม่ปล่อยเอง คำขอจะค้างจนไฟล์เทสต์ไม่ยอมจบ
function releasableHermesFetch() {
  const calls = [];
  const pending = [];
  let released = false;
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url) });
    if (released) throw new Error("test teardown");
    return await new Promise((_resolve, reject) => {
      pending.push(reject);
      opts?.signal?.addEventListener?.("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  fn.calls = calls;
  fn.release = () => {
    released = true;
    while (pending.length) pending.pop()(new Error("test teardown"));
  };
  return fn;
}

// ตรวจอิสระ 2026-09-01: เส้น hard exit ปิดเทิร์นค้างเป็นสถานะสุดท้ายทันที แปลว่าตัวกวาด
// ตอนบูตรอบหน้า (ซึ่งมองเฉพาะ owed/sending) จะไม่มีวันเห็นแถวพวกนี้อีกเลย
// ถ้าไม่ปักธงตรงจุดนั้น เคสที่ฟีเจอร์นี้ถูกสร้างมาแก้พอดี — deploy แล้ว drain ไม่ทัน —
// จะจบลงด้วยแถวในตารางที่ไม่มีใครอ่าน เหมือนเดิมทุกประการ
test("T-19 drain ไม่ทันจนต้องบังคับปิด -> เทิร์นค้างถูกปักธงให้คนรับต่อทันที ไม่รอบูตรอบหน้า", async (t) => {
  const hermes = releasableHermesFetch();
  t.after(() => hermes.release());
  const { app, db, lineFetch, coordinator, exits } = await startServer(t, {
    hermesFetch: hermes,
    configOverrides: {
      BURST_DEBOUNCE_MS: "0",
      SHUTDOWN_DRAFT_ABORT_MS: "60000",   // ไม่ให้เส้น abort เข้ามาช่วย — บังคับใช้เส้น hard exit
      SHUTDOWN_DRAIN_MS: "200",
      SHUTDOWN_HARD_EXIT_MS: "5000",
    },
  });
  await post(app.server, webhookBody("m-drain-6", { text: "ขอรายละเอียดคอร์สหน่อยค่ะ" }));
  await waitFor(() => hermes.calls.length >= 1);

  await coordinator.run("SIGTERM");

  assert.equal(lineFetch.sends.length, 0, "ห้ามส่งอะไรถึงลูกค้าเลย");
  const turn = turnOf(db, "in:m-drain-6");
  assert.equal(turn.status, "stranded_shutdown");
  assert.equal(turn.reason, "hard_exit");
  assert.equal(db.getCustomer("Udrain")?.state, "NEEDS_HUMAN", "ต้องมีคนรู้ตั้งแต่ตอนปิดระบบ");
  assert.ok(exits.includes(0), "ต้องออกจริง ไม่ค้าง");
});

test("T-20 ห้องที่ปิด AI อยู่แล้ว -> hard exit บันทึกไว้เฉย ๆ ไม่ปลุกคนซ้ำ", async (t) => {
  const hermes = releasableHermesFetch();
  t.after(() => hermes.release());
  const { app, db, coordinator } = await startServer(t, {
    hermesFetch: hermes,
    configOverrides: {
      BURST_DEBOUNCE_MS: "0", SHUTDOWN_DRAFT_ABORT_MS: "60000",
      SHUTDOWN_DRAIN_MS: "200", SHUTDOWN_HARD_EXIT_MS: "5000",
    },
  });
  await post(app.server, webhookBody("m-drain-7", { text: "สนใจค่ะ" }));
  await waitFor(() => hermes.calls.length >= 1);
  // แอดมินรับช่วงคุยเองระหว่างนั้น (ห้องเป็นของคนจริงอยู่แล้ว)
  db.setAiEnabled("Udrain", false, "customer_handover");

  await coordinator.run("SIGTERM");

  assert.equal(turnOf(db, "in:m-drain-7").status, "stranded_shutdown");
  assert.notEqual(db.getCustomer("Udrain")?.state, "NEEDS_HUMAN", "ห้องของคนจริงไม่ต้องส่งเสียงซ้ำ");
});
