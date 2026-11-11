import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { validateSalesPolicy } from "../src/salesPolicy.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

const policy = validateSalesPolicy({
  schemaVersion: 1,
  businessId: "pngoung-tidkradum",
  customerJourneys: ["new_lead"],
  decisionRoles: ["owner"],
  routingPrior: { dominantInterest: "ai", share: 0.99, publicClaimAuthorized: false },
  courses: [
    { id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic"], progressesTo: null },
  ],
  opportunities: [
    { type: "private_class", requiredSlots: ["business_need"], optionalSlots: [], upsize: true, handoffOnComplete: true },
  ],
});

test("sales policy business identity: missing or different BUSINESS_ID fails closed", () => {
  for (const businessId of ["", "another-business"]) {
    const db = memoryDb();
    assert.throws(
      () => createApp({
        config: testConfig({ BUSINESS_ID: businessId }), db,
        overrides: { salesPolicy: policy, hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
        logger: silent,
      }),
      /BUSINESS_ID must exactly match sales policy businessId/u,
    );
    db.close();
  }
});

test("sales policy business identity: exact BUSINESS_ID permits local assembly", () => {
  const db = memoryDb();
  const app = createApp({
    config: testConfig({ BUSINESS_ID: "pngoung-tidkradum" }), db,
    overrides: { salesPolicy: policy, hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  assert.ok(app.server, "exact identity assembles the local application");
  db.close();
});

test("resetCustomer: removes only its namespaced opportunity handoff state", () => {
  const db = memoryDb();
  // % and _ prove the LIKE prefix is escaped, not interpreted as a wildcard.
  const customerId = "U_1%";
  db.upsertCustomer(customerId, {});
  db.setSetting(`opportunity_handoff:${customerId}:private_class`, JSON.stringify({ createdAt: Date.now() }));
  db.setSetting("opportunity_handoff:U_1X:private_class", JSON.stringify({ createdAt: Date.now() }));
  db.setSetting("opportunity_handoff:U-keep:private_class", JSON.stringify({ createdAt: Date.now() }));

  db.resetCustomer(customerId);
  assert.equal(db.getSetting(`opportunity_handoff:${customerId}:private_class`), null);
  assert.ok(db.getSetting("opportunity_handoff:U_1X:private_class"));
  assert.ok(db.getSetting("opportunity_handoff:U-keep:private_class"));
  db.close();
});
