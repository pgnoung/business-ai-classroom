import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createBrainVersionRoutes } from "../src/consoleBrainApi.mjs";
import { hashPassword } from "../src/auth.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { memoryDb, testConfig, hermesFetchStub, httpRequest, lineFetchStub, listen, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

const SECRET = "brain-readiness-console-secret-0123456789";
const PASSWORD = "brain-readiness-pass-1234";
const QUIET = { warn() {}, debug() {}, log() {}, error() {} };

async function boot(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, KNOWLEDGE_VERSIONED: "false", BRAIN_READ: "legacy" });
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), role: "owner" });
  db.createOperator({ username: "staff", passHash: hashPassword(PASSWORD), role: "operator" });
  db.addKnowledge({ title: "ข้อมูลทดสอบ", content: "ราคา 19,900 บาท", updatedBy: "owner" });
  importCurrentSourcesAsVersion1(db, { createdBy: "owner", logger: QUIET, todayIso: todayInBangkok(Date.now()) });
  const app = createApp({ config, db, logger: QUIET, overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const result = await httpRequest(server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
  assert.equal(result.status, 200);
  return { cookie: (result.headers["set-cookie"]?.[0] || "").split(";")[0] };
}

const get = (server, path, session) => httpRequest(server, { path, headers: { cookie: session.cookie } });


test("readiness failure returns a safe 503 without treating unavailable data as clean", async () => {
  const routes = createBrainVersionRoutes({
    db: { getBrainPointer() { throw new Error("sensitive database failure"); } },
    config: testConfig({ KNOWLEDGE_VERSIONED: "false" }), logger: QUIET,
  });
  let result = null;
  const handled = await routes.handle({ method: "GET" }, {}, new URL("http://console.test/console/api/brain/readiness"), ["brain", "readiness"], {
    operator: { role: "owner" }, username: "owner", requireCsrf: () => true,
    json(_res, status, body) { result = { status, body }; },
  });
  assert.equal(handled, true);
  assert.deepEqual(result, { status: 503, body: { ok: false, error: "ยังตรวจความพร้อมสมองไม่ได้ กรุณาลองใหม่" } });
  assert.equal(JSON.stringify(result).includes("sensitive database failure"), false);
});

test("owner can read readiness while versioned mode is off; staff cannot and neither GET writes", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "owner");
  const staff = await login(app.server, "staff");
  const before = { audit: db.listAudit(), pointer: db.getBrainPointer("live")?.version_id, knowledge: db.listKnowledge().map((row) => row.content) };
  const ownerResult = await get(app.server, "/console/api/brain/readiness", owner);
  assert.equal(ownerResult.status, 200, ownerResult.text);
  assert.equal(ownerResult.json.readiness.flags.knowledgeVersioned, false);
  assert.equal(ownerResult.json.readiness.live.exists, true);
  assert.equal(ownerResult.json.readiness.activation.status, "not_evaluated");
  assert.equal(ownerResult.text.includes("19,900"), false);
  assert.equal(ownerResult.text.includes("ข้อมูลทดสอบ"), false);
  const denied = await get(app.server, "/console/api/brain/readiness", staff);
  assert.equal(denied.status, 403);
  assert.deepEqual({ audit: db.listAudit(), pointer: db.getBrainPointer("live")?.version_id, knowledge: db.listKnowledge().map((row) => row.content) }, before);
});
