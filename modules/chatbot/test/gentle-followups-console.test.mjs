// badge บนหน้ารายการแชท (28 ก.ย. 2026): ห้อง "ขอเช็คคิวก่อน" และห้องหลังส่งบัญชีต้องบอกเวลาทักครั้งเดียว
// ให้ตรงกับเส้นยิงจริง — ทีมเห็นก่อนว่าลูกแพรจะทักเมื่อไร จะได้ไม่พิมพ์ซ้อน (ลูกค้าสังเคราะห์)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { SCHEDULE_CHECK_FOLLOWUP_KEY } from "../src/scheduleCheck.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const PASSWORD = "gentle-pass-123456";
const silent = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
const HOUR = 3_600_000;

async function start(t) {
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), displayName: "เจ้าของ", role: "owner" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "gentle-secret", STAGED_FOLLOWUP_TICK_MS: "60000", STAGED_FOLLOWUP_ENABLED: "true", SALES_DECISION_GUARD_ENABLED: "true" }),
    db, overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const res = await httpRequest(app.server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: PASSWORD }) });
  const cookie = res.headers["set-cookie"][0].split(";")[0];
  const rows = async () => (await httpRequest(app.server, { path: "/console/api/inbox?limit=100", headers: { cookie } })).json.conversations;
  return { db, rows };
}

function backdate(db, id, ms) {
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(ms, id);
}

test("badge: ห้องขอเช็คคิว = 'เช็คคิว' เวลาทักครั้งเดียว · สวิตช์ปิด = บันไดปกติ · ห้องหลังส่งบัญชี = 'หลังส่งบัญชี'", async (t) => {
  const { db, rows } = await start(t);
  const now = Date.now();

  db.upsertCustomer("U-badge-sched", { displayName: "A" });
  db.setFollowupEnabled("U-badge-sched", true);
  db.recordScore("U-badge-sched", 9, "{}");
  db.insertMessage({ id: "in-s", customerId: "U-badge-sched", direction: "in", msgType: "text", content: "ขอเช็คคิวก่อนนะคะ" });
  db.insertMessage({ id: "out-s", customerId: "U-badge-sched", direction: "out", msgType: "text", content: "ไม่ต้องรีบนะคะ", agentMode: "ai" });
  backdate(db, "in-s", now - HOUR);
  backdate(db, "out-s", now - HOUR + 60_000);
  db.setFollowupDefer("U-badge-sched", JSON.stringify({ kind: "schedule_check", at: now - HOUR, hint: null }));

  db.upsertCustomer("U-badge-bank", { displayName: "B" });
  db.setDealStatus("U-badge-bank", "awaiting_payment");
  db.setFollowupEnabled("U-badge-bank", false);
  db.insertMessage({ id: "in-b", customerId: "U-badge-bank", direction: "in", msgType: "text", content: "ขอช่องทางชำระเงินค่ะ" });
  db.insertMessage({ id: "out-b", customerId: "U-badge-bank", direction: "out", msgType: "text", content: "ชำระผ่านช่องทางนี้ได้ค่ะ", agentMode: "ai" });
  db.addAudit({ operator: "system", action: "bank_sent_info_continues", target: "U-badge-bank", detail: "test" });

  const list = await rows();
  const sched = list.find((row) => row.line_user_id === "U-badge-sched").staged_followup_preview;
  assert.equal(sched.stage, "schedule_check");
  assert.ok(sched.dueAt - (now - HOUR) >= 30 * HOUR, "LINE: อย่างน้อยวันถัดไป (ไม่ใช่ hot 45 นาที)");
  const bank = list.find((row) => row.line_user_id === "U-badge-bank").staged_followup_preview;
  assert.equal(bank.stage, "payment_nudge");
  assert.ok(bank.dueAt - now >= 17 * HOUR);

  db.setSetting(SCHEDULE_CHECK_FOLLOWUP_KEY, "off");
  const off = (await rows()).find((row) => row.line_user_id === "U-badge-sched").staged_followup_preview;
  assert.equal(off.stage, "hot", "สวิตช์ปิด = badge กลับเป็นบันไดปกติ");
});
