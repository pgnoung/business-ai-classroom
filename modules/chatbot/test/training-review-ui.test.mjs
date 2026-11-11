import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { memoryDb, testConfig, hermesFetchStub, lineFetchStub, httpRequest, listen } from "./helpers.mjs";

const ROOT = new URL("..", import.meta.url);
const silent = { log() {}, warn() {}, error() {} };

test("training review UI is an allowlisted module and makes promotion state explicit", async (t) => {
  const source = readFileSync(new URL("public/console/console.js", ROOT), "utf8");
  const page = readFileSync(new URL("public/console/training.mjs", ROOT), "utf8");
  assert.match(source, /capability:\s*"training\.review"/);
  assert.match(source, /createTrainingReviewPage/);
  assert.match(page, /promotionRequired|ยังไม่เปลี่ยน Persona, Brain หรือ Knowledge/);
  assert.match(page, /training-candidates/);
  assert.match(page, /ห้ามส่งซ้ำอัตโนมัติ/);
  assert.match(page, /resolve_without_send/);
  assert.match(page, /ปิด ACK โดยไม่ส่งซ้ำ/);
  assert.match(page, /status=all/);
  assert.doesNotMatch(page, /retryAck|retry_ack|ส่ง ACK ซ้ำ/u);

  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword("training-ui-password"), role: "owner" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "training-ui-secret" }), db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const response = await httpRequest(app.server, { path: "/console/static/training.mjs" });
  assert.equal(response.status, 200);
  assert.match(response.text, /createTrainingReviewPage/);
});
