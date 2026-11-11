// Local-only console fixture for browser inspection. It never loads instance
// credentials, starts a provider request, or sends a LINE message.
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { testConfig, memoryDb, lineFetchStub, hermesFetchStub } from "../test/helpers.mjs";

const port = Number(process.env.PORT || 4897);
const db = memoryDb();
db.createOperator({
  username: "fixture-reviewer",
  passHash: hashPassword("fixture-reviewer-pass-123"),
  displayName: "Fixture reviewer",
  role: "owner",
});
db.upsertCustomer("fixture-customer", {});
db.raw.prepare(`INSERT INTO jev_decision_reviews
  (id,customer_id,session_id,turn_id,stage,policy,model,brain_version_id,proposed_action,mode,action,status,confidence_10,result_json,evidence_hash,applied,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "fixture-jev-review", "fixture-customer", "fixture-session", "fixture-turn", "draft", "fixture", "jev-1.13.0", "",
  "draft_reply", "shadow", "rewrite", "reviewed", 7.5,
  JSON.stringify({ action: "rewrite", confidence10: 7.5, checks: { complaint: { choice: "none", confidence: 0.75, confidence10: 7.5, probabilities: { none: 1 } } } }),
  "fixture-hash", 0, Date.now(),
);
const app = createApp({
  config: testConfig({ CONSOLE_SESSION_SECRET: "fixture-console-secret-123456", JEV_REVIEW_MODE: "shadow" }),
  db,
  logger: { log() {}, warn() {}, error() {}, debug() {} },
  overrides: { lineFetch: lineFetchStub(), hermesFetch: hermesFetchStub(), sleep: async () => {} },
});
app.server.listen(port, "127.0.0.1", () => console.log(`mock console ready http://127.0.0.1:${port}/console`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.server.close(() => db.close()));
