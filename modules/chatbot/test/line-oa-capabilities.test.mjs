import test from "node:test";
import assert from "node:assert/strict";
import { lineOaCapabilityStatus } from "../src/lineOaCapabilities.mjs";
import { createLineOaCapabilityRoutes, OWNER_ONLY_MESSAGE } from "../src/consoleLineOaApi.mjs";

const config = Object.freeze({
  lineChannelSecret: "legacy-secret",
  trainingIntakeEnabled: true,
  teachEnabled: true,
});

function response() {
  const calls = [];
  return { calls, json: (_res, status, body) => calls.push({ status, body }) };
}

test("capability status separates configured signed inbound from a proven LINE connection", () => {
  const status = lineOaCapabilityStatus({
    config,
    channels: [
      { id: "main", name: "LINE หลัก", channelSecret: "main-secret", active: true },
      { id: "paused", name: "LINE พัก", channelSecret: "paused-secret", active: false },
      { id: "missing", name: "LINE ยังไม่ตั้ง", channelSecret: "", active: true },
    ],
  });
  assert.equal(status.scope, "one_business_per_instance");
  assert.deepEqual(status.channels.map((channel) => channel.id), ["main", "paused", "missing"]);
  assert.equal(status.channels[0].webhook.configured, true);
  assert.equal(status.channels[0].webhook.provenConnected, false);
  assert.equal(status.channels[0].webhook.status, "configured_unverified");
  assert.equal(status.channels[1].webhook.configured, false, "inactive OA cannot be called configured for receive");
  assert.equal(status.channels[2].webhook.status, "not_configured");
  assert.equal(status.channels[0].managerDirect.observed, false);
  assert.equal(status.channels[0].curatedQa.enabled, true);
  assert.equal(status.channels[0].curatedQa.href, "#/teach-intake");
  assert.equal(status.channels[0].nativeBackup.status, "schema_unverified");
  assert.equal(status.channels[0].nativePerChatTags.status, "not_available");
  assert.match(status.localTagSafety.message, /มีผลหยุด AI/u);
  assert.match(status.notices.join(" "), /ไม่ดึงประวัติแชท/u);
  assert.ok(!JSON.stringify(status).includes("main-secret"), "status must never expose a channel secret");
});

test("legacy single-channel state is represented without inferring provider connection", () => {
  const status = lineOaCapabilityStatus({ config, channels: [] });
  assert.equal(status.channels.length, 1);
  assert.equal(status.channels[0].id, "default");
  assert.equal(status.channels[0].webhook.configured, true);
  assert.equal(status.channels[0].webhook.provenConnected, false);
});

test("LINE OA status route is owner-only, GET-only, and leaves unrelated routes alone", async () => {
  const routes = createLineOaCapabilityRoutes({ config, channels: [{ id: "main", name: "LINE หลัก", channelSecret: "main-secret", active: true }] });
  const owner = response();
  assert.equal(await routes.handle({ method: "GET" }, {}, new URL("http://test/console/api/line-oa/status"), ["line-oa", "status"], {
    json: owner.json, operator: { role: "owner" },
  }), true);
  assert.equal(owner.calls[0].status, 200);
  assert.equal(owner.calls[0].body.ok, true);
  assert.equal(owner.calls[0].body.channels[0].webhook.provenConnected, false);

  const staff = response();
  await routes.handle({ method: "GET" }, {}, new URL("http://test/console/api/line-oa/status"), ["line-oa", "status"], {
    json: staff.json, operator: { role: "operator" },
  });
  assert.deepEqual(staff.calls[0], { status: 403, body: { ok: false, error: OWNER_ONLY_MESSAGE } });

  const method = response();
  await routes.handle({ method: "POST" }, {}, new URL("http://test/console/api/line-oa/status"), ["line-oa", "status"], {
    json: method.json, operator: { role: "owner" },
  });
  assert.equal(method.calls[0].status, 405);
  assert.equal(await routes.handle({ method: "GET" }, {}, new URL("http://test/console/api/other"), ["other"], {
    json: response().json, operator: { role: "owner" },
  }), false);
});
