// ติดป้าย "customer" ในคอนโซล = บอทต้องเงียบทันที
//
// เหตุการณ์จริง 2026-08-28: ทีมงานติดป้าย customer ให้ห้องหนึ่งตอน 08-27 13:31
// เช้าวันรุ่งขึ้น 09:01 follow-up ยังทักลูกค้ารายนั้นอยู่ดี เจ้าของต้องมาปิด AI เอง
//
// สาเหตุ: การติดป้ายเพิ่มแถวในตาราง customer_tags อย่างเดียว ไม่แตะ ai_enabled เลย
// ตัวแปลง "ป้าย -> ปิด AI" มีอยู่ที่เดียวคือใน pipeline ซึ่งเดินเฉพาะตอนลูกค้าพิมพ์
// ข้อความเข้ามาใหม่ — แต่คนที่ซื้อจบแล้วมักไม่พิมพ์อะไรอีก ป้ายจึงไม่มีวันมีผล
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { CUSTOMER_HANDOVER_REASON } from "../src/pipeline.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";

async function startConsole(t) {
  const db = memoryDb();
  db.createOperator({ username: "chom", passHash: hashPassword(PASSWORD), displayName: "ชมพู่" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET }), db,
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
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

const addTag = (server, id, tag, auth) => httpRequest(server, {
  method: "POST", path: `/console/api/customers/${encodeURIComponent(id)}/tags`,
  headers: { "content-type": "application/json", cookie: auth.cookie, "x-csrf-token": auth.csrf },
  body: JSON.stringify({ add: tag }),
});

test("ติดป้าย customer แล้ว AI ต้องปิดทันที ไม่ต้องรอลูกค้าพิมพ์กลับมา", async (t) => {
  const { app, db } = await startConsole(t);
  const id = "U-bought";
  db.upsertCustomer(id, { displayName: "ลูกค้าที่ซื้อแล้ว" });
  assert.equal(db.getCustomer(id).ai_enabled, 1, "ตั้งต้น AI ต้องเปิดอยู่");
  const auth = await login(app.server);

  const res = await addTag(app.server, id, "customer", auth);
  assert.equal(res.status, 200, res.text);

  const after = db.getCustomer(id);
  assert.equal(after.ai_enabled, 0, "บอทต้องเงียบทันทีที่ติดป้าย");
  assert.equal(after.ai_off_reason, CUSTOMER_HANDOVER_REASON);
  const audit = db.raw.prepare("SELECT 1 h FROM admin_audit WHERE target=? AND action='ai_off_customer_handover'").get(id);
  assert.ok(audit, "ต้องมีร่องรอยใน audit ว่าใครทำให้บอทเงียบ");
});

test("ป้ายอื่นต้องไม่ไปปิด AI", async (t) => {
  const { app, db } = await startConsole(t);
  const id = "U-plain";
  db.upsertCustomer(id, { displayName: "ลูกค้าทั่วไป" });
  const auth = await login(app.server);

  await addTag(app.server, id, "สนใจรายละเอียดคลาส", auth);
  assert.equal(db.getCustomer(id).ai_enabled, 1, "ป้ายทั่วไปต้องไม่ทำให้บอทเงียบ");
});

test("ถ้า AI ปิดอยู่ก่อนแล้ว ต้องไม่ไปทับเหตุผลเดิม", async (t) => {
  const { app, db } = await startConsole(t);
  const id = "U-already-off";
  db.upsertCustomer(id, { displayName: "ห้องที่ปิด AI ไว้ก่อน" });
  db.setAiEnabled(id, false, "urgent_mental");
  const auth = await login(app.server);

  await addTag(app.server, id, "customer", auth);
  const after = db.getCustomer(id);
  assert.equal(after.ai_enabled, 0);
  assert.equal(after.ai_off_reason, "urgent_mental", "เหตุผลเดิมที่หนักกว่าต้องไม่ถูกเขียนทับ");
});
