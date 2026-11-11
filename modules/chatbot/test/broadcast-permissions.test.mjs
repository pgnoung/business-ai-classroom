// broadcast-permissions.test.mjs — multi-OA Broadcast ต้อง authorize ฝั่ง server
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "operator-pass-123";
const CHANNELS = [
  { id: "a", name: "OA A", channelSecret: "secret-a", channelAccessToken: "token-a", active: true },
  { id: "b", name: "OA B", channelSecret: "secret-b", channelAccessToken: "token-b", active: true },
];

async function login(server, username) {
  const response = await httpRequest(server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(response.status, 200, response.text);
  return {
    cookie: (response.headers["set-cookie"]?.[0] || "").split(";")[0],
    csrf: response.json.csrf,
  };
}

function post(server, path, auth, body) {
  return httpRequest(server, {
    method: "POST", path,
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("multi-OA Broadcast: operator เห็นเฉพาะ OA ที่ grant; owner เห็นทั้งหมด; revoke ปิดทันที", async (t) => {
  const db = memoryDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "staff", passHash, displayName: "ทีมงาน", role: "operator" });
  db.createOperator({ username: "owner", passHash, displayName: "เจ้าของ", role: "owner" });
  db.createOperator({ username: "admin", passHash, displayName: "แอดมิน", role: "admin" });
  db.grantOperatorChannel("staff", "a");
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "permission-test-console-secret-012345" }),
    db,
    overrides: {
      channels: CHANNELS,
      hermesFetch: hermesFetchStub(),
      lineFetch: lineFetchStub(),
      sleep: async () => {},
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const staff = await login(app.server, "staff");
  const owner = await login(app.server, "owner");
  const admin = await login(app.server, "admin");
  const staffMeta = await httpRequest(app.server, {
    path: "/console/api/broadcast/meta", headers: { cookie: staff.cookie },
  });
  assert.equal(staffMeta.status, 200);
  assert.deepEqual(staffMeta.json.channels.map((channel) => channel.id), ["a"]);
  // เจ้าของตัดสิน 2026-08-25: staff ส่ง broadcast ได้ ขอบเขตจึงเหลือ "OA ที่ได้รับสิทธิ์" อย่างเดียว
  assert.equal(staffMeta.json.canSend, true, "staff holds broadcast.send after the 2026-08-25 role decision");
  const staffSendOwnChannel = await post(app.server, "/console/api/broadcast/send", staff, {
    confirm: true, channelId: "a", includeTags: ["any"], excludeTags: [], messages: [{ type: "text", text: "test" }],
  });
  assert.notEqual(staffSendOwnChannel.status, 403, "granted channel is no longer refused for lack of capability");

  assert.equal((await httpRequest(app.server, {
    path: "/console/api/broadcast/meta?channel=b", headers: { cookie: staff.cookie },
  })).status, 403);
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/broadcast/history?channel=b", headers: { cookie: staff.cookie },
  })).status, 403);
  assert.equal((await post(app.server, "/console/api/broadcast/preview", staff, {
    channelId: "b", includeTags: [], excludeTags: [],
  })).status, 403);
  assert.equal((await post(app.server, "/console/api/broadcast/send", staff, {
    confirm: true, channelId: "b", includeTags: [], excludeTags: [], messages: [{ type: "text", text: "test" }],
  })).status, 403);

  const ownerMeta = await httpRequest(app.server, {
    path: "/console/api/broadcast/meta", headers: { cookie: owner.cookie },
  });
  assert.deepEqual(ownerMeta.json.channels.map((channel) => channel.id), ["a", "b"]);
  assert.equal(ownerMeta.json.canSend, true);

  assert.equal((await httpRequest(app.server, {
    path: "/console/api/broadcast/permissions", headers: { cookie: staff.cookie },
  })).status, 403);
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/broadcast/permissions", headers: { cookie: admin.cookie },
  })).status, 403);
  assert.equal((await post(app.server, "/console/api/broadcast/permissions", admin, {
    username: "staff", channelId: "b", allowed: true,
  })).status, 403);
  const permissions = await httpRequest(app.server, {
    path: "/console/api/broadcast/permissions", headers: { cookie: owner.cookie },
  });
  assert.equal(permissions.status, 200);
  assert.deepEqual(permissions.json.operators.find((entry) => entry.username === "staff").channels, ["a"]);

  assert.equal((await post(app.server, "/console/api/broadcast/permissions", owner, {
    username: "staff", channelId: "b", allowed: true,
  })).status, 200);
  const afterGrant = await httpRequest(app.server, {
    path: "/console/api/broadcast/meta", headers: { cookie: staff.cookie },
  });
  assert.deepEqual(afterGrant.json.channels.map((channel) => channel.id), ["a", "b"]);

  assert.equal((await post(app.server, "/console/api/broadcast/permissions", owner, {
    username: "staff", channelId: "a", allowed: false,
  })).status, 200);
  assert.equal((await post(app.server, "/console/api/broadcast/permissions", owner, {
    username: "staff", channelId: "b", allowed: false,
  })).status, 200);
  assert.equal((await httpRequest(app.server, {
    path: "/console/api/broadcast/meta", headers: { cookie: staff.cookie },
  })).status, 403);
  const auditActions = db.listAudit().map((row) => row.action);
  assert.ok(auditActions.includes("operator_channel_grant"));
  assert.ok(auditActions.includes("operator_channel_revoke"));
});
