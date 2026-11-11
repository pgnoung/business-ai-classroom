import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { BACKUP_MAX_AGE_MS, backupStatusFromDb } from "../src/backupStatus.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const NOW = Date.UTC(2026, 7, 24, 3, 30, 0);
const PASSWORD = "backup-status-pass-123";

async function login(server, username) {
  const response = await httpRequest(server, {
    method: "POST",
    path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 200, response.text);
  return (response.headers["set-cookie"]?.[0] || "").split(";")[0];
}

test("backup status reports missing, fresh, and stale evidence without inferring scheduler state", () => {
  // นาฬิกาเดียว: อายุแบ็กอัปวัดจาก NOW ตัวเดียวกับที่ db ใช้เขียนแถว
  const db = memoryDb({ now: () => NOW });
  try {
    assert.deepEqual(backupStatusFromDb(db, { now: NOW }), {
      status: "missing",
      lastSuccessAt: null,
      ageMs: null,
      maxAgeMs: BACKUP_MAX_AGE_MS,
      lastRestoreDrillAt: null,
      encrypted: true,
      retention: { daily: 14, weekly: 8, monthly: 12, yearly: 3 },
      scheduler: "external_unverified",
    });
    db.setSetting("backup_last_success_at", String(NOW - 60_000));
    assert.equal(backupStatusFromDb(db, { now: NOW }).status, "ok");
    db.setSetting("backup_last_success_at", String(NOW - BACKUP_MAX_AGE_MS - 1));
    assert.equal(backupStatusFromDb(db, { now: NOW }).status, "stale");
  } finally {
    db.close();
  }
});

test("backup status API is authenticated and owner-only", async (t) => {
  const db = memoryDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "owner", passHash, displayName: "Owner", role: "owner" });
  db.createOperator({ username: "admin", passHash, displayName: "Admin", role: "admin" });
  db.setSetting("backup_last_success_at", String(NOW));
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "backup-status-test-secret-0123456789" }),
    db,
    logger: silent,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  assert.equal((await httpRequest(app.server, { path: "/console/api/backup-status" })).status, 401);
  const ownerCookie = await login(app.server, "owner");
  const owner = await httpRequest(app.server, {
    path: "/console/api/backup-status", headers: { cookie: ownerCookie },
  });
  assert.equal(owner.status, 200, owner.text);
  assert.equal(owner.json.backup.encrypted, true);
  assert.equal(owner.json.backup.scheduler, "external_unverified");

  const adminCookie = await login(app.server, "admin");
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/backup-status", headers: { cookie: adminCookie },
  })).status, 403);
});
