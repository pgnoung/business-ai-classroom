// คิว "รอคน" ต้องเอาคนที่รอนานที่สุดขึ้นก่อน
//
// เหตุการณ์จริง 2026-08-28: มีห้องอยู่ในสถานะ NEEDS_HUMAN แปดห้อง สามห้องในนั้น
// ลูกค้าทักทิ้งไว้แล้วไม่มีใครตอบเลย 31, 58 และ 81 ชั่วโมง หนึ่งในนั้นคุยเรื่องเงิน
// ข้อมูลอยู่บนคอนโซลมาตลอด แต่ไม่มีใครเห็น เพราะคิวเรียงด้วย activity_at DESC
// ห้องที่เงียบนานที่สุด (= รอนานที่สุด) จึงจมอยู่ล่างสุดของรายการที่ควรเห็นมันก่อนใคร
//
// คิวที่รอคนบริการต้องเป็น FIFO — ใครมาก่อนได้ก่อน ไม่ใช่ใครเพิ่งขยับได้ก่อน
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const HOUR = 60 * 60 * 1000;

async function startConsole(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: hashPassword(PASSWORD), displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: PASSWORD }),
  });
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  return (res.headers["set-cookie"]?.[0] || "").split(";")[0];
}

// ลูกค้าที่ทักแล้วไม่มีใครตอบมา waitedHours ชั่วโมง และห้องรอคนอยู่
function seedWaiting(db, label, waitedHours) {
  const id = `U-wait-${label}`;
  const at = Date.now() - waitedHours * HOUR;
  db.upsertCustomer(id, { displayName: `รอ${waitedHours}ชม` });
  db.insertMessage({ customerId: id, direction: "in", content: "สอบถามหน่อยค่ะ" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(at, id);
  db.raw.prepare("UPDATE customers SET state = 'NEEDS_HUMAN', updated_at = ? WHERE line_user_id = ?")
    .run(at, id);
  return id;
}

const idsOf = (res) => res.json.conversations.map((c) => c.line_user_id);

test("รอคน: คนที่รอนานที่สุดต้องอยู่บนสุด", async (t) => {
  const { app, db } = await startConsole(t);
  // จงใจ seed สลับลำดับ เพื่อไม่ให้ผลลัพธ์บังเอิญถูกจากลำดับการ insert
  seedWaiting(db, "b", 58);
  seedWaiting(db, "c", 31);
  seedWaiting(db, "a", 81);
  const cookie = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/inbox?segment=needs", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(idsOf(res), ["U-wait-a", "U-wait-b", "U-wait-c"],
    "ต้องเรียง 81 → 58 → 31 ชม. ไม่ใช่เอาห้องที่เพิ่งขยับขึ้นก่อน");
});

test("รอคน: ห้องที่รอ 81 ชม. ต้องไม่จมอยู่ล่างสุดอีก (บั๊กเดิมตรง ๆ)", async (t) => {
  const { app, db } = await startConsole(t);
  const stale = seedWaiting(db, "stale", 81);
  for (let i = 0; i < 7; i += 1) seedWaiting(db, `fresh${i}`, i + 1); // ขยับใหม่กว่าทั้งหมด
  const cookie = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/inbox?segment=needs", headers: { cookie } });
  const ids = idsOf(res);
  assert.equal(ids.length, 8);
  assert.equal(ids[0], stale, "ห้องที่รอนานสุดต้องขึ้นบนสุด");
  assert.notEqual(ids[ids.length - 1], stale, "ต้องไม่ไปอยู่ล่างสุดแบบเดิม");
});

test("ส่วนอื่นต้องไม่เปลี่ยน: รายการทั้งหมดยังเอาที่ขยับล่าสุดขึ้นก่อน", async (t) => {
  const { app, db } = await startConsole(t);
  const old = seedWaiting(db, "old", 81);
  const recent = seedWaiting(db, "recent", 1);
  // ปลดสถานะรอคน เพื่อดูพฤติกรรมของรายการรวม ไม่ใช่ของคิวรอคน
  db.raw.prepare("UPDATE customers SET state = ?").run("AI_ACTIVE");
  const cookie = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  const ids = idsOf(res);
  assert.equal(ids[0], recent, "รายการรวมยังต้องเรียงใหม่สุดก่อนเหมือนเดิม");
  assert.equal(ids[ids.length - 1], old);
});

// ห้องที่แอดมินตอบไปแล้วแต่ยังไม่ปิดเคส — เงียบมานาน แต่ไม่มีใครรอคำตอบอยู่
function seedAnswered(db, label, silentHours) {
  const id = `U-ans-${label}`;
  const at = Date.now() - silentHours * HOUR;
  db.upsertCustomer(id, { displayName: `ตอบแล้ว${silentHours}ชม` });
  db.insertMessage({ customerId: id, direction: "in", content: "สอบถามหน่อยค่ะ" });
  db.insertMessage({ customerId: id, direction: "out", content: "ตอบแล้วค่ะ" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ? AND direction = ?")
    .run(at - HOUR, id, "in");
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ? AND direction = ?")
    .run(at, id, "out");
  db.raw.prepare("UPDATE customers SET state = 'NEEDS_HUMAN', updated_at = ? WHERE line_user_id = ?")
    .run(at, id);
  return id;
}

test("รอคน: คนที่ยังไม่ได้คำตอบ มาก่อนห้องที่ตอบไปแล้ว ถึงห้องนั้นจะเงียบนานกว่า", async (t) => {
  const { app, db } = await startConsole(t);
  // เคสจริง 2026-08-28: อิ๋ว-Chotika เงียบ 106 ชม. แต่แอดมินตอบไปแล้ว
  // ส่วน JP 2495 รอ 89 ชม. โดยยังไม่มีใครตอบ — คนหลังคือคนที่เสียหายจริง
  const answeredButStale = seedAnswered(db, "stale", 106);
  const stillWaiting = seedWaiting(db, "jp", 89);
  const cookie = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/inbox?segment=needs", headers: { cookie } });
  const ids = idsOf(res);
  assert.equal(ids[0], stillWaiting, "คนที่ยังรอคำตอบต้องขึ้นก่อน");
  assert.equal(ids[1], answeredButStale, "ห้องที่ตอบแล้วแต่ยังไม่ปิด ตามมาทีหลัง");
});

test("รอคน: ในกลุ่มที่ยังไม่ได้คำตอบ ยังเรียงคนรอนานสุดขึ้นก่อนเหมือนเดิม", async (t) => {
  const { app, db } = await startConsole(t);
  seedAnswered(db, "noise", 200);          // เงียบนานสุดแต่ตอบแล้ว ต้องไปอยู่ท้าย
  seedWaiting(db, "mid", 66);
  seedWaiting(db, "longest", 89);
  seedWaiting(db, "short", 39);
  const cookie = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/inbox?segment=needs", headers: { cookie } });
  assert.deepEqual(idsOf(res),
    ["U-wait-longest", "U-wait-mid", "U-wait-short", "U-ans-noise"],
    "ยังไม่ได้ตอบเรียง 89 → 66 → 39 แล้วค่อยตามด้วยห้องที่ตอบแล้ว");
});
