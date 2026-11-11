// G2b Console — B2 (ต่ออายุ/ปลดหน้าต่าง operator-active), B6 (handoff notes API),
// B7d (agent_mode ฝั่ง operator), migration idempotency ของคอลัมน์/ตารางใหม่
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { openDb } from "../src/db.mjs";
import { hashPassword } from "../src/auth.mjs";
import { OPERATOR_ACTIVE_MS } from "../src/pipeline.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t, { configOverrides = {} } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, ...configOverrides });
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, config, lineFetch };
}

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server) {
  const res = await postJson(server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

/* ------------------------------- auth / CSRF -------------------------------- */

test("G2b endpoints: ไม่มี session = 401, มี session ไม่มี CSRF = 403", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U1", {});
  const paths = [
    ["/console/api/customers/U1/operator-clear", {}],
    ["/console/api/customers/U1/notes", { text: "โน้ต" }],
    ["/console/api/notes/x/delete", {}],
    ["/console/api/models", { target: "reply", model: "gpt-5.6-luna" }],
  ];
  for (const [path, body] of paths) {
    assert.equal((await postJson(app.server, path, body)).status, 401, `${path} ไม่มี session`);
  }
  assert.equal((await httpRequest(app.server, { path: "/console/api/models" })).status, 401);

  const { cookie } = await login(app.server);
  for (const [path, body] of paths) {
    assert.equal((await postJson(app.server, path, body, { cookie })).status, 403, `${path} ไม่มี CSRF`);
  }
});

/* --------------------------- B2: operator-active ---------------------------- */

test("B2: operator ตอบจาก console -> ตั้ง operator_active_until = now+15นาที และต่ออายุ", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-pause", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const before = Date.now();
  const res = await postJson(app.server, "/console/api/conversations/U-pause/reply", { text: "เดี๋ยวเช็คให้นะคะ" }, headers);
  assert.equal(res.status, 200);
  const first = db.getCustomer("U-pause").operator_active_until;
  assert.ok(first >= before + OPERATOR_ACTIVE_MS - 2000, "ต้อง ~ now+15min");
  assert.ok(first <= Date.now() + OPERATOR_ACTIVE_MS + 2000);

  // ตอบซ้ำ = ต่ออายุ (ค่าใหม่ >= ค่าเก่า)
  await postJson(app.server, "/console/api/conversations/U-pause/reply", { text: "ได้ข้อมูลแล้วค่ะ" }, headers);
  const second = db.getCustomer("U-pause").operator_active_until;
  assert.ok(second >= first, "ตอบใหม่ต้องต่ออายุหน้าต่าง");
});

test("B2: ปุ่ม 'ให้ AI ตอบต่อเลย' -> ล้างหน้าต่าง + audit; ลูกค้าไม่มีจริง = 404", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-clear", {});
  db.setOperatorActiveUntil("U-clear", Date.now() + 10 * 60_000);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const res = await postJson(app.server, "/console/api/customers/U-clear/operator-clear", {}, headers);
  assert.equal(res.status, 200);
  assert.equal(res.json.customer.operator_active_until, 0);
  assert.equal(db.getCustomer("U-clear").operator_active_until, 0);
  assert.ok(db.listAudit().some((a) => a.action === "operator_pause_clear" && a.target === "U-clear"));

  assert.equal((await postJson(app.server, "/console/api/customers/U-ghost/operator-clear", {}, headers)).status, 404);
});

test("B2 end-to-end: ตอบจาก console แล้ว AI เงียบ -> ปลดแล้ว AI กลับมาตอบ", async (t) => {
  const { app, db, lineFetch } = await startConsole(t);
  db.upsertCustomer("U-e2e", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  await postJson(app.server, "/console/api/conversations/U-e2e/reply", { text: "แอดมินตอบเองค่ะ" }, headers);
  const suppressed = await app.pipeline.handleInboundText({ customerId: "U-e2e", text: "ขอบคุณค่ะ", replyToken: "" });
  assert.equal(suppressed.suppressed, "operator_active");

  await postJson(app.server, "/console/api/customers/U-e2e/operator-clear", {}, headers);
  const sendsBefore = lineFetch.sends.length;
  const resumed = await app.pipeline.handleInboundText({ customerId: "U-e2e", text: "ถามต่อค่ะ", replyToken: "" });
  assert.equal(resumed.sent, true);
  assert.ok(lineFetch.sends.length > sendsBefore);
});

/* ----------------------------- B6: notes API -------------------------------- */

test("B6: เพิ่มโน้ต -> โผล่ใน messages endpoint + audit; validation ครบ", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-notes", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const res = await postJson(app.server, "/console/api/customers/U-notes/notes", { text: "ลูกค้ารอใบเสนอราคา" }, headers);
  assert.equal(res.status, 200);
  assert.equal(res.json.note.author, "nok");
  assert.equal(res.json.note.text, "ลูกค้ารอใบเสนอราคา");
  assert.equal(res.json.handoffNotes.length, 1);

  const msg = await httpRequest(app.server, { path: "/console/api/conversations/U-notes/messages", headers: { cookie } });
  assert.equal(msg.json.handoffNotes.length, 1);
  assert.equal(msg.json.handoffNotes[0].text, "ลูกค้ารอใบเสนอราคา");
  assert.ok(db.listAudit().some((a) => a.action === "note_add" && a.target === "U-notes"));

  assert.equal((await postJson(app.server, "/console/api/customers/U-notes/notes", { text: "" }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/customers/U-notes/notes", { text: "x".repeat(501) }, headers)).status, 400);
  assert.equal((await postJson(app.server, "/console/api/customers/U-ghost/notes", { text: "โน้ต" }, headers)).status, 404);
});

test("B6: ลบโน้ต -> หายจริง + audit; ลบซ้ำ/ไม่มีจริง = 404", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-del", {});
  const note = db.addHandoffNote({ customerId: "U-del", author: "nok", text: "โน้ตชั่วคราว" });
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const res = await postJson(app.server, `/console/api/notes/${note.id}/delete`, {}, headers);
  assert.equal(res.status, 200);
  assert.equal(db.listHandoffNotes("U-del").length, 0);
  assert.ok(db.listAudit().some((a) => a.action === "note_delete" && a.target === "U-del"));

  assert.equal((await postJson(app.server, `/console/api/notes/${note.id}/delete`, {}, headers)).status, 404);
});

/* --------------------------- B7d: operator agent_mode ----------------------- */

test("B7d: reply ตอน AI เปิด = operator_ai_on / ตอน AI ปิด = operator_ai_off", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-mode", {});
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  await postJson(app.server, "/console/api/conversations/U-mode/reply", { text: "ตอบตอน AI เปิด" }, headers);
  db.setAiEnabled("U-mode", false);
  await postJson(app.server, "/console/api/conversations/U-mode/reply", { text: "ตอบตอน AI ปิด" }, headers);

  const out = db.messagesFor("U-mode").filter((m) => m.direction === "out");
  assert.equal(out.length, 2);
  assert.equal(out[0].agent_mode, "operator_ai_on");
  assert.equal(out[1].agent_mode, "operator_ai_off");
});

/* --------------------------- B6+B2: reset ล้างของใหม่ ------------------------ */

test("F6+G2b: reset ล้าง handoff notes + llm_usage + operator_active_until", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-reset2", {});
  db.addHandoffNote({ customerId: "U-reset2", author: "nok", text: "โน้ต" });
  db.addLlmUsage({ customerId: "U-reset2", kind: "draft", model: "gpt-5.6-sol", tokensIn: 10, tokensOut: 5 });
  db.setOperatorActiveUntil("U-reset2", Date.now() + 10 * 60_000);
  const { cookie, csrf } = await login(app.server);

  const res = await postJson(app.server, "/console/api/customers/U-reset2/reset", {}, { cookie, "x-csrf-token": csrf });
  assert.equal(res.status, 200);
  assert.equal(res.json.customer.operator_active_until, 0);
  assert.equal(db.listHandoffNotes("U-reset2").length, 0);
  assert.equal(db.llmUsageForCustomer("U-reset2").length, 0);
});

/* --------------------------- migration idempotency -------------------------- */

test("G2b migration: เปิดไฟล์ DB เดิมซ้ำได้ ไม่พัง และคอลัมน์/ตารางใหม่ใช้งานได้", () => {
  const dir = mkdtempSync(join(tmpdir(), "chassis-g2b-"));
  const file = join(dir, "test.sqlite");
  try {
    // รอบแรก: สร้าง schema + เขียนข้อมูลที่ใช้ฟีเจอร์ใหม่
    const db1 = openDb({ file });
    db1.upsertCustomer("U-mig", {});
    db1.setOperatorActiveUntil("U-mig", 12345);
    db1.insertMessage({ customerId: "U-mig", direction: "out", content: "x", agentMode: "operator_ai_off" });
    db1.addHandoffNote({ customerId: "U-mig", author: "nok", text: "โน้ต" });
    db1.addLlmUsage({ customerId: "U-mig", kind: "score", model: "gpt-5.6-luna", tokensIn: 1, tokensOut: 2 });
    db1.close();

    // รอบสอง: เปิดซ้ำ (จำลอง restart บน DB live) — migration ต้อง idempotent
    const db2 = openDb({ file });
    assert.equal(db2.getCustomer("U-mig").operator_active_until, 12345);
    assert.equal(db2.messagesFor("U-mig")[0].agent_mode, "operator_ai_off");
    assert.equal(db2.listHandoffNotes("U-mig").length, 1);
    assert.equal(db2.llmUsageForCustomer("U-mig").length, 1);
    // แถวเก่าที่ไม่มี agent_mode (เขียนก่อน G2b) = null — UI ต้องเดาเองได้
    db2.insertMessage({ customerId: "U-mig", direction: "out", content: "y" });
    const rows = db2.messagesFor("U-mig");
    assert.equal(rows.at(-1).agent_mode, null);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
