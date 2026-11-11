// เพดานคลังความรู้ — จาก "ตัดเงียบ" เป็น "เตือนดัง" (คำสั่งเจ้าของ 2026-08-29)
//
// เหตุจริง: คลังใช้ไป 59,359/60,000 (99.0%) และพฤติกรรมตอนเกินคือตัดรายการเก่าสุดทิ้ง
// เงียบ ๆ ซึ่งรายการเก่าสุดคือแคตตาล็อกคลาส+ราคา — ของสำคัญที่สุดหายก่อนโดยไม่มีใครรู้
//
// การแก้สามชั้น:
//   1. ยกเพดาน 60,000 -> 80,000 (การยกเองไม่เสียเงิน — เงินเดินตามเนื้อหาที่ใส่จริง)
//   2. คอนโซลปฏิเสธการเพิ่ม/แก้ที่จะทำให้เกินเพดาน — บอกให้รวบก่อน แทนที่จะตัดของเก่าทิ้ง
//   3. สรุปรายวันเตือนดังเมื่อมีรายการตกขอบอยู่จริง (กันกรณีข้อมูลเก่าเกินมาก่อนการ์ดนี้)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { knowledgeUsage, KNOWLEDGE_MAX_CHARS } from "../src/knowledgePack.mjs";
import { buildDigestBubbles } from "../src/digest.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const PASSWORD = "correct horse battery staple";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: "c".repeat(64) });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}
const postJson = (server, path, body, headers = {}) => httpRequest(server, {
  method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
async function login(server) {
  const res = await postJson(server, "/console/api/login", { username: "nok", password: PASSWORD });
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

test("เพดานใหม่ต้องเป็น 80,000", () => {
  assert.equal(KNOWLEDGE_MAX_CHARS, 80_000);
});

test("knowledgeUsage: นับรวมแบบเดียวกับตัวประกอบ prompt และบอกจำนวนที่จะตกขอบ", () => {
  const entries = [
    { title: "เก่าสุด", content: "ก".repeat(5000) },
    { title: "กลาง", content: "ข".repeat(5000) },
    { title: "ใหม่สุด", content: "ค".repeat(5000) },
  ];
  const fit = knowledgeUsage(entries, { maxChars: 50_000 });
  assert.equal(fit.droppedCount, 0);
  assert.ok(fit.totalChars > 15_000, "ต้องนับรวมหัวข้อและตัวคั่นด้วย");
  const tight = knowledgeUsage(entries, { maxChars: 11_000 });
  assert.equal(tight.droppedCount, 1, "เกินเพดาน = รายการเก่าสุดตกขอบก่อน");
});

test("console: เพิ่มรายการที่ทำให้เกินเพดาน = 409 บอกให้รวบก่อน และห้ามมีรายการเดิมตกขอบ", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  // เติมให้เกือบเต็ม: 4 รายการ x 19,900 ≈ 79,700
  for (let i = 0; i < 4; i += 1) db.addKnowledge({ title: `ก้อน ${i + 1}`, content: "ก".repeat(19_900) });

  const over = await postJson(app.server, "/console/api/knowledge",
    { title: "รายการที่ล้น", content: "ข".repeat(2_000) }, headers);
  assert.equal(over.status, 409, "ต้องปฏิเสธ ไม่ใช่รับแล้วตัดของเก่าทิ้งเงียบ ๆ");
  assert.match(over.json.error, /เต็ม|รวบ/u, "ข้อความต้องบอกวิธีแก้");
  assert.equal(db.listKnowledge().length, 4, "รายการเดิมต้องอยู่ครบ");

  const fits = await postJson(app.server, "/console/api/knowledge",
    { title: "รายการเล็ก", content: "ค".repeat(100) }, headers);
  assert.equal(fits.status, 200, "ยังมีที่ = เพิ่มได้ปกติ");
});

test("console: แก้รายการให้บวมจนเกิน = 409 · แก้ให้เล็กลง = ผ่าน · เปิดใช้คืนแล้วล้น = 409", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  for (let i = 0; i < 4; i += 1) db.addKnowledge({ title: `ก้อน ${i + 1}`, content: "ก".repeat(19_900) });
  const small = db.addKnowledge({ title: "ตัวแก้", content: "ข".repeat(1_000) });

  const grow = await postJson(app.server, `/console/api/knowledge/${small.id}`, { content: "ค".repeat(5_000) }, headers);
  assert.equal(grow.status, 409, "แก้ให้บวมจนเกินต้องโดนปฏิเสธ");
  const shrink = await postJson(app.server, `/console/api/knowledge/${small.id}`, { content: "ง".repeat(50) }, headers);
  assert.equal(shrink.status, 200, "แก้ให้เล็กลงต้องผ่านเสมอ แม้คลังยังล้น — ไม่งั้นรวบคลังไม่ได้");

  const off = await postJson(app.server, `/console/api/knowledge/${small.id}`, { active: false }, headers);
  assert.equal(off.status, 200);
  db.addKnowledge({ title: "มาเสียบแทน", content: "จ".repeat(19_000) });
  const backOn = await postJson(app.server, `/console/api/knowledge/${small.id}`, { active: true, content: "ฉ".repeat(5_000) }, headers);
  assert.equal(backOn.status, 409, "เปิดใช้คืนแล้วล้นก็ต้องโดนปฏิเสธเหมือนกัน");
});

test("digest: มีรายการตกขอบ = เตือนดังทั้งเช้าและค่ำ", () => {
  const base = { inbound: 5, inboundCustomers: 3, newCustomers: 0, needsHuman: 0, suspectSlips: 0, hotTop: [], knowledgeDropped: 2 };
  for (const mode of ["morning", "evening"]) {
    const bubbles = buildDigestBubbles({ mode, stats: base, orders: { created: 0, paid: 0, confirmed: 0, revenue: 0 }, costThb: 0, quotaLines: [], hotLines: [], waiting: [], sinceMs: 0, nowMs: 0 });
    const all = bubbles.map((b) => b.text).join("\n");
    assert.match(all, /ความรู้.*ตกขอบ|ตกขอบ.*ความรู้/su, `${mode} ต้องเตือนเรื่องความรู้ตกขอบ`);
  }
});
