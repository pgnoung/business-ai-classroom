// หน้า "ที่นั่ง" แก้/ลบรอบหนึ่ง ต้องไม่ทำให้รอบอื่นเสียสถานะ (พบ 2026-09-28)
// เดิม handler เขียนผลของ readManualRounds (ช่อง fileStatus) กลับตรง ๆ ช่อง status จึงหาย
// แล้วรอบที่ตั้งเป็น "เต็ม" หรือ "ปิดรับ" ไว้ เด้งกลับเป็น "เปิดรับ" ทุกครั้งที่มีคนแก้รอบอื่น
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "rounds-status-pass-1234";

async function boot(t) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2026-08-22", classKey: "basic", label: "รอบที่จบไปแล้ว", product: "AI Agent for Business", status: "closed", capacity: 15 },
    // รอบที่ผ่านไปแล้วแต่ยังเขียนว่าเปิดรับ — บันทึกครั้งถัดไปต้องปิดให้เอง (28 ก.ย.)
    { date: "2026-09-05", classKey: "basic", label: "รอบที่ผ่านแต่ยังเปิด", product: "AI Agent for Business", status: "open", capacity: 15 },
    { date: "2099-01-10", classKey: "basic", label: "รอบเต็มแล้ว", product: "AI Agent for Business", status: "full", capacity: 15 },
    { date: "2099-02-14", classKey: "online", label: "คลาสออนไลน์", product: "AI Workflow Automation", status: "almost_full", capacity: null },
  ]));
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "rounds-status-console-secret-0123456789" }),
    db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ngoung", password: PASSWORD }),
  });
  assert.equal(login.status, 200, login.text);
  const headers = {
    "content-type": "application/json",
    cookie: (login.headers["set-cookie"]?.[0] || "").split(";")[0],
    "x-csrf-token": login.json.csrf,
  };
  const post = (path, body) => httpRequest(app.server, { method: "POST", path, headers, body: JSON.stringify(body) });
  const stored = () => Object.fromEntries(JSON.parse(db.getSetting("class_rounds_manual"))
    .map((r) => [r.date, r.capacity === null ? `${r.status}/ไม่จำกัด` : r.status]));
  return { post, stored };
}

test("เพิ่มรอบใหม่ต้องไม่ทำให้รอบเต็ม/ปิดรับที่มีอยู่เด้งกลับเป็นเปิดรับ", async (t) => {
  const { post, stored } = await boot(t);
  const res = await post("/console/api/class-rounds/round",
    { date: "2099-03-07", label: "รอบใหม่", product: "AI Agent for Business", capacity: 15 });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(stored(), {
    "2026-08-22": "closed", "2026-09-05": "closed", "2099-01-10": "full", "2099-02-14": "almost_full/ไม่จำกัด", "2099-03-07": "open",
  });
});

test("ลบรอบหนึ่งต้องไม่ทำให้รอบอื่นเสียสถานะ", async (t) => {
  const { post, stored } = await boot(t);
  assert.equal((await post("/console/api/class-rounds/round",
    { date: "2099-03-07", label: "รอบใหม่", capacity: 15 })).status, 200);
  const res = await post("/console/api/class-rounds/round-delete", { date: "2099-03-07" });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(stored(), { "2026-08-22": "closed", "2026-09-05": "closed", "2099-01-10": "full", "2099-02-14": "almost_full/ไม่จำกัด" });
});
