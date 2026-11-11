// webhook-ack-boundary — เส้นแบ่ง 200/non-2xx ต้องตรงกับ COMMIT พอดี
//
// กติกาสองข้อที่เทสต์ไฟล์นี้ค้ำไว้:
//   1) ก่อน COMMIT พังอะไรก็ตาม -> ตอบ non-2xx (dedupe ถูก ROLLBACK ไปด้วย provider ส่งซ้ำได้)
//   2) หลัง COMMIT handler ห้ามคืน non-2xx สำหรับ event นั้นเด็ดขาด
//      เพราะแถว dedupe อยู่ในฐานแล้ว LINE ส่งซ้ำมาก็ถูกทิ้ง = ข้อความหายถาวร
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  signLine, httpRequest, listen, sleep,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {}, info: () => {} };
const SECRET = "test-line-secret";

async function startServer(t, { configOverrides = {}, beforeApp = null } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  if (beforeApp) beforeApp(db);
  const hermesFetch = hermesFetchStub("ขอบคุณที่ทักมานะคะ");
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.learning.stop(); app.server.close(); db.close(); });
  return { app, db, config, lineFetch };
}

function webhookBody(messageId, { text = "สวัสดีค่ะ", userId = "Uack" } = {}) {
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

test("T-01 อ่าน session ไม่สำเร็จหลัง COMMIT -> ยังตอบ 200 และแถวข้อความยังอยู่", async (t) => {
  let original = null;
  const { app, db } = await startServer(t, {
    beforeApp: (database) => {
      // จำลองความล้มเหลวหลัง COMMIT: จุดนี้เคยโยนขึ้น outer catch แล้วตอบ 500
      // ทั้งที่ dedupe commit ไปแล้ว (บั๊กเดิม server.mjs:813)
      original = database.activeConversationSession.bind(database);
      database.activeConversationSession = () => { throw new Error("session read failed"); };
    },
  });
  const raw = webhookBody("m-ack-1");
  const res = await post(app.server, raw);
  db.activeConversationSession = original;   // คืนของเดิมก่อนอ่านผลลัพธ์
  assert.equal(res.status, 200, "หลัง COMMIT ห้ามตอบ non-2xx");
  const inbound = db.messagesFor("Uack").filter((m) => m.direction === "in");
  assert.equal(inbound.length, 1, "ข้อความลูกค้าต้องอยู่ในฐานครบ");
  await sleep(20);
});

test("T-02 event ซ้ำ -> 200 และนับว่ารับแล้ว (idempotent ack)", async (t) => {
  const { app } = await startServer(t);
  const raw = webhookBody("m-ack-2");
  const first = await post(app.server, raw);
  assert.equal(first.status, 200);
  assert.ok(first.json.accepted >= 1);
  const second = await post(app.server, raw);
  assert.equal(second.status, 200);
  assert.ok(second.json.accepted >= 1, "ข้อความซ้ำ = งานถูกจดไปแล้ว ต้องนับว่าสำเร็จ");
  await sleep(20);
});
