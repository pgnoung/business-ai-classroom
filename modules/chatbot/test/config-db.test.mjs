// config + db — โครงพื้นฐานต้องแน่นก่อน
import test from "node:test";
import assert from "node:assert/strict";
import { createConfig } from "../src/config.mjs";
import { poisonGlobalFetch, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();

/* --------------------------------- config --------------------------------- */

test("config: ค่า default ปลอดภัย — port 4850, live send ปิด", () => {
  const config = createConfig({});
  assert.equal(config.port, 4850);
  assert.equal(config.lineLiveSend, false);
  assert.equal(config.hermesTimeoutMs, 90000);
  assert.equal(config.lineTimeoutMs, 15000);
  assert.equal(config.burstDebounceMs, 4000);
  assert.equal(config.burstMaxWaitMs, 12000);
});

test("config: ไม่มี DASHBOARD_API_KEY / LINE_CHANNEL_SECRET = degraded", () => {
  const config = createConfig({});
  assert.equal(config.degraded.dashboard, true);
  assert.equal(config.degraded.lineWebhook, true);
  assert.equal(config.degraded.hermes, true);
});

test("config: ใส่ key ครบ = ไม่ degraded", () => {
  const config = createConfig({
    DASHBOARD_API_KEY: "k",
    LINE_CHANNEL_SECRET: "s",
    HERMES_BASE: "http://x/v1",
  });
  assert.equal(config.degraded.dashboard, false);
  assert.equal(config.degraded.lineWebhook, false);
  assert.equal(config.degraded.hermes, false);
});

test("config: LINE_LIVE_SEND ต้องเป็น true/1 เท่านั้นถึงเปิด", () => {
  assert.equal(createConfig({ LINE_LIVE_SEND: "true" }).lineLiveSend, true);
  assert.equal(createConfig({ LINE_LIVE_SEND: "1" }).lineLiveSend, true);
  assert.equal(createConfig({ LINE_LIVE_SEND: "yes" }).lineLiveSend, false);
  assert.equal(createConfig({ LINE_LIVE_SEND: "TRUE" }).lineLiveSend, true);
});

test("config: customer follow-up suppression ปิดเป็นค่าเริ่มต้นและเปิดเฉพาะ flag ที่ยอมรับ", () => {
  assert.equal(createConfig({}).customerFollowupSuppressionEnabled, false);
  assert.equal(createConfig({ CUSTOMER_FOLLOWUP_SUPPRESSION_ENABLED: "true" }).customerFollowupSuppressionEnabled, true);
  assert.equal(createConfig({ CUSTOMER_FOLLOWUP_SUPPRESSION_ENABLED: "yes" }).customerFollowupSuppressionEnabled, false);
});

test("config: ตัวเลขขยะ fallback เป็น default", () => {
  const config = createConfig({ PORT: "ไม่ใช่เลข", HERMES_TIMEOUT_MS: "-5" });
  assert.equal(config.port, 4850);
  assert.equal(config.hermesTimeoutMs, 90000);
});

test("config: Web Push ปิดสนิทเป็นค่าเริ่มต้นและเก็บ VAPID แยก public/private", () => {
  const off = createConfig({});
  assert.equal(off.webPushEnabled, false);
  assert.equal(off.webPushVapidPublicKey, "");
  assert.equal(off.webPushVapidPrivateKey, "");
  assert.equal(off.webPushVapidSubject, "");

  const on = createConfig({
    WEB_PUSH_ENABLED: "true",
    WEB_PUSH_VAPID_PUBLIC_KEY: "public",
    WEB_PUSH_VAPID_PRIVATE_KEY: "private",
    WEB_PUSH_VAPID_SUBJECT: "https://console.example",
  });
  assert.equal(on.webPushEnabled, true);
  assert.equal(on.webPushVapidPublicKey, "public");
  assert.equal(on.webPushVapidPrivateKey, "private");
  assert.equal(on.webPushVapidSubject, "https://console.example");
});

/* ----------------------------------- db ----------------------------------- */

test("db: ลูกค้าใหม่ default ai_enabled=1 state=AI_ACTIVE (Fern)", () => {
  const db = memoryDb();
  const customer = db.upsertCustomer("U1", { displayName: "คุณเทส" });
  assert.equal(customer.ai_enabled, 1);
  assert.equal(customer.state, "AI_ACTIVE");
  assert.equal(customer.display_name, "คุณเทส");
  db.close();
});

test("db: upsert ซ้ำไม่ทับ display_name ด้วยค่าว่าง และไม่รีเซ็ต ai_enabled", () => {
  const db = memoryDb();
  db.upsertCustomer("U1", { displayName: "คุณเทส" });
  db.setAiEnabled("U1", false);
  const customer = db.upsertCustomer("U1", {});
  assert.equal(customer.display_name, "คุณเทส");
  assert.equal(customer.ai_enabled, 0);
  db.close();
});

test("db: markDedupe — ครั้งแรก true, redelivery false", () => {
  const db = memoryDb();
  assert.equal(db.markDedupe("m1"), true);
  assert.equal(db.markDedupe("m1"), false);
  assert.equal(db.markDedupe("m2"), true);
  db.close();
});

test("db: recentTurns คืน role ถูกฝั่ง เรียงเก่า->ใหม่ จำกัดจำนวน turn", () => {
  let tick = 0;
  const db = memoryDb();
  db.raw.exec("BEGIN"); // ใช้ created_at จาก now injection ไม่ได้ — ใส่ทีละแถวเรียงเวลาแทน
  db.raw.exec("COMMIT");
  const insert = (direction, content) => {
    tick += 1;
    db.raw
      .prepare(
        "INSERT INTO messages (id, customer_id, direction, channel, msg_type, content, message_class, created_at) VALUES (?, 'U1', ?, 'line', 'text', ?, 'reactive', ?)"
      )
      .run(`m${tick}`, direction, content, tick);
  };
  insert("in", "คำถาม 1");
  insert("out", "คำตอบ 1");
  insert("in", "คำถาม 2");
  insert("out", "คำตอบ 2");
  const turns = db.recentTurns("U1", 1); // 1 turn = 2 แถวล่าสุด
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0], { role: "user", content: "คำถาม 2" });
  assert.deepEqual(turns[1], { role: "assistant", content: "คำตอบ 2" });
  db.close();
});

test("db: setNeedsHuman ตั้ง state และต่อท้าย handoff summary", () => {
  const db = memoryDb();
  db.upsertCustomer("U1", {});
  db.setNeedsHuman("U1", "complaint", "ลูกค้าไม่พอใจ");
  const customer = db.setNeedsHuman("U1", "hermes_down", "สมองล่ม");
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.ok(customer.handoff_summary.includes("complaint"));
  assert.ok(customer.handoff_summary.includes("hermes_down"));
  db.close();
});

test("db: approved_prices upsert + อ่านกลับ", () => {
  const db = memoryDb();
  db.setApprovedPrice("คอร์สเลเซอร์", 2500);
  db.setApprovedPrice("คอร์สเลเซอร์", 2900); // ราคาใหม่ทับ label เดิม
  const prices = db.approvedPrices();
  assert.equal(prices.length, 1);
  assert.equal(prices[0].amount, 2900);
  db.close();
});

test("db: corrections เข้าเป็น candidate และ list ได้", () => {
  const db = memoryDb();
  db.addCorrection({ customerId: "U1", aiDraft: "ร่าง AI", humanFinal: "คำแก้คน" });
  const rows = db.listCorrections("candidate");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "candidate");
  assert.equal(rows[0].ai_draft, "ร่าง AI");
  db.close();
});

test("db: canary_state เก็บ/อ่านสถานะโครง probe ได้", () => {
  const db = memoryDb();
  db.setCanary("line-webhook", { status: "not_armed", detail: "รอ G1b", lastProbeAt: 123 });
  const row = db.getCanary("line-webhook");
  assert.equal(row.status, "not_armed");
  assert.equal(row.last_probe_at, 123);
  db.close();
});
