import test from "node:test";
import assert from "node:assert/strict";
import { refreshExistingWebPushBinding } from "../public/console/webPushUi.mjs";

function replaceGlobal(t, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  });
}

function supportedBrowser(t, endpoint = "https://updates.push.services.mozilla.com/wpush/v2/test-device") {
  const notification = { permission: "granted" };
  replaceGlobal(t, "window", { PushManager: class PushManager {}, Notification: notification });
  replaceGlobal(t, "Notification", notification);
  replaceGlobal(t, "navigator", {
    serviceWorker: {
      async getRegistration() {
        return { pushManager: { async getSubscription() { return { endpoint }; } } };
      },
    },
  });
}

test("Web Push rebind follows the server capability: admin rebinds after login", async (t) => {
  supportedBrowser(t);
  const calls = [];
  const rebound = await refreshExistingWebPushBinding({
    state: { me: { role: "admin" }, features: { webPush: true } },
    api: async (path, options) => { calls.push({ path, options }); return {}; },
  });

  assert.equal(rebound, true);
  assert.deepEqual(calls, [{
    path: "/console/api/push/subscribe",
    options: {
      method: "POST",
      body: { endpoint: "https://updates.push.services.mozilla.com/wpush/v2/test-device" },
    },
  }]);
});

test("Web Push rebind is a no-op when the server omits the capability for staff", async (t) => {
  supportedBrowser(t);
  let calls = 0;
  const rebound = await refreshExistingWebPushBinding({
    state: { me: { role: "operator" }, features: { webPush: false } },
    api: async () => { calls += 1; },
  });

  assert.equal(rebound, false);
  assert.equal(calls, 0);
});
