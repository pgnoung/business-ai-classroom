// Loopback-only synthetic preview. No provider key, customer data or live send.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { testConfig, memoryDb, lineFetchStub, hermesFetchStub, poisonGlobalFetch } from "../test/helpers.mjs";

poisonGlobalFetch();
const db = memoryDb();
const auditDir = mkdtempSync(join(tmpdir(), "lukprae-history-preview-"));
db.createOperator({ username: "fixture-reviewer", passHash: hashPassword("fixture-reviewer-pass-123"), displayName: "ผู้ตรวจข้อมูลจำลอง", role: "owner" });
db.upsertCustomer("fixture-history", { displayName: "ลูกค้าตัวอย่าง — ข้อมูลจำลอง" });
const start = Date.parse("2026-09-01T00:00:00+07:00");
for (let i = 0; i < 165; i++) {
  db.raw.prepare("INSERT INTO messages (id,customer_id,direction,channel,content,created_at,session_id) VALUES (?,? ,?,'line',?,?,?)")
    .run(`fixture-message-${i}`, "fixture-history", i % 2 ? "out" : "in", i % 2 ? "คลาสตัวอย่างมีทั้งเนื้อหาและแบบฝึกหัดค่ะ" : `ข้อความจำลอง ${i + 1}: ขอข้อมูลคลาสและราคาเพิ่มเติมค่ะ`, start + i * 60_000, i < 30 ? "fixture-old-session" : "fixture-new-session");
}
const cases = [
  { id: "fixture-bank", atMs: start + 180_000, anchorMessageId: "fixture-message-2", original: { stop: "permanent", notify: "provider_accepted" }, jev: { status: "reviewed", model: "jev-1.13.0", stop: { choice: "continue", confidence10: 9.2 }, notify: { choice: "notify", confidence10: 9.7 }, complaint: { choice: "none", confidence10: 9.6 }, reason: { choice: "bank_details_only" } }, comparison: { stop: "disagree", notify: "agree" } },
  { id: "fixture-human", atMs: start + 240_000, anchorMessageId: "fixture-message-4", original: { stop: "temporary", notify: "not_observed" }, jev: { status: "reviewed", model: "jev-1.13.0", stop: { choice: "stop", confidence10: 9.8 }, notify: { choice: "not_needed", confidence10: 8.9 }, complaint: { choice: "none", confidence10: 9.5 }, reason: { choice: "active_human_reply" } }, comparison: { stop: "agree", notify: "unknown" } },
].map(row => ({ ...row, customerId: "fixture-history", channelId: "default", eventKinds: ["fixture"], evidenceCoverage: { messageCount: 4, omittedMessages: 0 } }));
for (const [suffix, comparison, status] of [["agree", "agree", "reviewed"], ["uncertain", "unknown", "uncertain"]]) {
  const customerId = `fixture-${suffix}`;
  db.upsertCustomer(customerId, { displayName: suffix === "agree" ? "ห้องจำลอง — JEV เห็นตรง" : "ห้องจำลอง — หลักฐานไม่พอ" });
  db.raw.prepare("INSERT INTO messages (id,customer_id,direction,channel,content,created_at,session_id) VALUES (?,?,'in','line',?,?,?)")
    .run(`${customerId}-message`, customerId, "ข้อความจำลองสำหรับตรวจการแสดงผลเท่านั้น", start + 300_000, `${customerId}-session`);
  cases.push({ ...cases[0], id: `${customerId}-case`, customerId, atMs: start + 360_000, anchorMessageId: `${customerId}-message`,
    original: { stop: "none", notify: "provider_accepted" }, comparison: { stop: comparison, notify: comparison },
    jev: { ...cases[0].jev, status, stop: { choice: status === "reviewed" ? "continue" : "unclear", confidence10: status === "reviewed" ? 9.2 : null }, notify: { choice: status === "reviewed" ? "notify" : "unclear", confidence10: status === "reviewed" ? 9.7 : null } } });
}
for (const [index, row] of cases.entries()) row.evidenceHash = String(index + 1).padStart(64, "0");
for (let index = 0; index < 32; index++) {
  cases.push({ ...cases[2], id: `fixture-paged-case-${index}`, atMs: start + 360_000 + index * 1000, evidenceHash: String(index + 10).padStart(64, "0") });
}
writeFileSync(join(auditDir, "fixture-september.json"), JSON.stringify({ schemaVersion: 1, batchId: "fixture-september", startMs: start, cutoffMs: start + 86_400_000, createdAt: Date.now(), completedAt: Date.now(), policy: "SYNTHETIC FIXTURE ONLY", cases }), { mode: 0o600 });
const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "fixture-console-secret-123456", CHAT_HISTORY_ENABLED: "true", JEV_AUDIT_DIR: auditDir }), db,
  logger: { log() {}, warn() {}, error() {}, debug() {} }, overrides: { lineFetch: lineFetchStub(), hermesFetch: hermesFetchStub(), sleep: async () => {} } });
app.server.listen(4897, "127.0.0.1", () => console.log("Synthetic history preview: http://127.0.0.1:4897/console/#/history"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.server.close(() => { db.close(); rmSync(auditDir, { recursive: true, force: true }); }));
