// บอทรับปากลูกค้าว่า "ทีมงานจะติดต่อกลับ" แล้วต้องมีใครสักคนเห็น
//
// เหตุการณ์จริง 2026-08-28: ลูกแพรรับปากลูกค้าไว้สองห้อง (15 และ 19 ชม.ก่อน)
// ทั้งสองห้องยังเป็น AI_ACTIVE จึงไม่เคยโผล่ในตัวกรอง "รอคน" ที่ทีมงานเปิดดู
// คำสัญญาที่ระบบให้ลูกค้าไว้เองแล้วผิดคำพูด เสียหายกว่าห้องที่ไม่มีใครสัญญาอะไร
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

async function startConsole(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.createOperator({ username: "chom", passHash: hashPassword(PASSWORD), displayName: "ชมพู่" });
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
    body: JSON.stringify({ username: "chom", password: PASSWORD }),
  });
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  return (res.headers["set-cookie"]?.[0] || "").split(";")[0];
}

// ห้องที่บอทตอบปกติ AI ยังเปิด แล้วบอทรับปากว่าทีมงานจะติดต่อกลับ
function seedPromise(db, id = "U-promise") {
  db.upsertCustomer(id, { displayName: "ลูกค้าที่ถูกสัญญาไว้" });
  db.insertMessage({ customerId: id, direction: "in", content: "ขอคุยกับเจ้าหน้าที่หน่อยค่ะ" });
  db.insertMessage({ customerId: id, direction: "out", content: "เดี๋ยวทีมงานติดต่อกลับนะคะ" }); // operator ว่าง = บอท
  db.addHandoffNote({ customerId: id, author: "ai_promise", text: "รับปากว่าทีมงานจะติดต่อกลับ" });
  return id;
}

const needsIds = async (app, cookie) => {
  const res = await httpRequest(app.server, { path: "/console/api/inbox?segment=needs", headers: { cookie } });
  assert.equal(res.status, 200);
  return { ids: res.json.conversations.map((c) => c.line_user_id), count: res.json.counts.needs };
};

test("ห้องที่บอทรับปากไว้ ต้องโผล่ในคิว รอคน ถึงห้องจะยังเป็น AI_ACTIVE", async (t) => {
  const { app, db } = await startConsole(t);
  const id = seedPromise(db);
  assert.equal(db.raw.prepare("SELECT state FROM customers WHERE line_user_id=?").get(id).state,
    "AI_ACTIVE", "ตั้งต้นต้องไม่ใช่ NEEDS_HUMAN ไม่งั้นเทสต์ไม่ได้พิสูจน์อะไร");
  const cookie = await login(app.server);

  const { ids, count } = await needsIds(app, cookie);
  assert.deepEqual(ids, [id], "ต้องเห็นห้องที่ถูกสัญญาไว้");
  assert.equal(count, 1, "เลขบนป้ายต้องตรงกับรายการ");
});

test("บอทตอบเองต่อ ไม่นับว่าทีมงานทำตามสัญญา", async (t) => {
  const { app, db } = await startConsole(t);
  const id = seedPromise(db);
  db.insertMessage({ customerId: id, direction: "out", content: "ระหว่างนี้ดูข้อมูลเพิ่มได้ค่ะ" });
  const cookie = await login(app.server);

  const { ids } = await needsIds(app, cookie);
  assert.deepEqual(ids, [id], "บอทพูดเองไม่ปลดคิว");
});

test("คนตอบจริงแล้ว ห้องต้องหลุดจากคิว", async (t) => {
  const { app, db } = await startConsole(t);
  const id = seedPromise(db);
  db.insertMessage({ customerId: id, direction: "out", content: "สวัสดีค่ะ ชมพู่ดูแลต่อเองนะคะ", operator: "chom" });
  const cookie = await login(app.server);

  const { ids, count } = await needsIds(app, cookie);
  assert.deepEqual(ids, [], "คนตอบแล้วต้องไม่ค้างอยู่ในคิว");
  assert.equal(count, 0);
});

test("คนเขียนโน้ตแล้ว ห้องต้องหลุดจากคิวเช่นกัน", async (t) => {
  const { app, db } = await startConsole(t);
  const id = seedPromise(db);
  db.addHandoffNote({ customerId: id, author: "chom", text: "โทรหาลูกค้าแล้ว นัดวันเรียนไว้" });
  const cookie = await login(app.server);

  const { ids } = await needsIds(app, cookie);
  assert.deepEqual(ids, [], "คนสรุปงานแล้วถือว่าทำตามสัญญาแล้ว");
});

test("ประวัติเก่าที่ย้ายมาจาก LINE OA ไม่นับว่ามีคนทำตามสัญญาวันนี้", async (t) => {
  const { app, db } = await startConsole(t);
  const id = seedPromise(db);
  db.insertMessage({
    customerId: id, direction: "out", content: "ข้อความเก่าจากระบบเดิม",
    operator: "LINE OA (ย้ายข้อมูล)",
  });
  const cookie = await login(app.server);

  const { ids } = await needsIds(app, cookie);
  assert.deepEqual(ids, [id], "ข้อความที่ย้ายมาไม่ใช่การกระทำของคนในระบบนี้");
});

test("ห้อง NEEDS_HUMAN เดิมยังอยู่ในคิวเหมือนเดิม ไม่ถูกกลบ", async (t) => {
  const { app, db } = await startConsole(t);
  const promised = seedPromise(db);
  db.upsertCustomer("U-needs", { displayName: "ห้องรอคนแบบเดิม" });
  db.insertMessage({ customerId: "U-needs", direction: "in", content: "สอบถามค่ะ" });
  db.raw.prepare("UPDATE customers SET state='NEEDS_HUMAN' WHERE line_user_id=?").run("U-needs");
  const cookie = await login(app.server);

  const { ids, count } = await needsIds(app, cookie);
  assert.equal(ids.length, 2, "ต้องเห็นทั้งสองแบบ");
  assert.ok(ids.includes(promised) && ids.includes("U-needs"));
  assert.equal(count, 2, "เลขบนป้ายต้องนับด้วยเงื่อนไขเดียวกับรายการ");
});
