// F15 (ตรวจย้อนหลัง ก.ย. 2026): push ซ้ำตอนที่คนจริงกำลังตอบในห้องอยู่แล้ว (75 ครั้งก้ำกึ่ง)
//
// ของจริง: คำรับปากของบอท / ห้องรอเทียบตัวตนระบบเก่า / รูปในห้องที่ไม่มีเรื่องเงิน / ลูกค้าตอบหลังส่งต่อ
// ปลุกทีมทั้งที่ชมพู่เพิ่งพิมพ์ในห้องนั้นเมื่อไม่กี่นาทีก่อน — ทีมชินกับเสียงเตือนจนของสำคัญจมหาย
// กติกา: เหตุที่ไม่ใช่เรื่องเงิน ถ้าคนจริงส่งข้อความในห้องภายใน 10 นาที = ไม่ปลุกซ้ำ (บันทึก audit ไว้)
// เรื่องเงิน / สลิป / ร้องเรียน / ขอคุยกับคน / ฉุกเฉิน = ยิงเสมอเหมือนเดิม
import test from "node:test";
import assert from "node:assert/strict";
import { createEscalationNotifier, NOTIFY_KEY_PREFIX, HUMAN_ACTIVE_WINDOW_MS } from "../src/notify.mjs";
import { memoryDb } from "./helpers.mjs";

const UID = `U${"0".repeat(29)}f15`; // ผู้รับสังเคราะห์ (รูปแบบ LINE user id ที่ validNotifyIds รับ)

function setup() {
  const db = memoryDb();
  const calls = [];
  const line = { async sendBubbles(args) { calls.push(args); return { ok: true }; } };
  db.setSetting(NOTIFY_KEY_PREFIX + "default", JSON.stringify([UID]));
  const notifier = createEscalationNotifier({ db, config: {}, line, logger: { debug() {} } });
  return { db, calls, notifier };
}

function humanReplied(db, customerId, agoMs, operator = "chom") {
  db.upsertCustomer(customerId, { displayName: "ห้องทดสอบ" });
  const id = db.insertMessage({ customerId, direction: "out", content: "สวัสดีค่ะ ชมพู่ดูแลต่อนะคะ", operator });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(Date.now() - agoMs, id);
}

test("F15: คำรับปากของบอทขณะคนจริงเพิ่งตอบในห้อง = ไม่ปลุกซ้ำ + มี audit บอกเหตุผล", async (t) => {
  const { db, calls, notifier } = setup();
  t.after(() => db.close());
  humanReplied(db, "U-active", 3 * 60_000);
  const result = await notifier.fire({ customerId: "U-active", reason: "promise_team_followup" });
  assert.equal(result.skipped, "human_active");
  assert.equal(calls.length, 0);
  const audit = db.listAudit().find((a) => a.action === "escalate_notify_skipped" && a.target === "U-active");
  assert.ok(audit, "การไม่ปลุกต้องมีร่องรอยให้ตรวจย้อนหลัง");
  assert.match(audit.detail, /promise_team_followup/u);
});

test("F15: คนจริงตอบครั้งล่าสุดนานกว่า 10 นาที = ปลุกตามปกติ", async (t) => {
  const { db, calls, notifier } = setup();
  t.after(() => db.close());
  humanReplied(db, "U-idle", HUMAN_ACTIVE_WINDOW_MS + 5 * 60_000);
  const result = await notifier.fire({ customerId: "U-idle", reason: "promise_team_followup" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("F15: ข้อความของลูกแพร/ระบบไม่นับเป็นคนจริง", async (t) => {
  const { db, calls, notifier } = setup();
  t.after(() => db.close());
  humanReplied(db, "U-bot-only", 60_000, "");
  humanReplied(db, "U-system-only", 60_000, "system");
  await notifier.fire({ customerId: "U-bot-only", reason: "legacy_candidate" });
  await notifier.fire({ customerId: "U-system-only", reason: "legacy_candidate" });
  assert.equal(calls.length, 2);
});

test("F15: เรื่องเงิน/ร้องเรียน/ขอคน/ฉุกเฉิน ยิงเสมอแม้คนจริงเพิ่งตอบ", async (t) => {
  for (const reason of ["payment_review", "bank_sent", "complaint", "human_requested", "urgent_medical", "file_review", "booking_handoff"]) {
    const { db, calls, notifier } = setup();
    humanReplied(db, `U-${reason}`, 60_000);
    const result = await notifier.fire({ customerId: `U-${reason}`, reason });
    assert.equal(result.ok, true, reason);
    assert.equal(calls.length, 1, reason);
    db.close();
  }
});

test("F15: รูปในห้องที่ไม่มีเรื่องเงิน = ไม่ปลุกซ้ำ · รูปในห้องที่มีเรื่องเงิน (อาจเป็นสลิป) = ยิงเสมอ", async (t) => {
  const { db, calls, notifier } = setup();
  t.after(() => db.close());
  humanReplied(db, "U-img-plain", 2 * 60_000);
  humanReplied(db, "U-img-money", 2 * 60_000);
  db.markMoneySeen("U-img-money");
  const plain = await notifier.fire({ customerId: "U-img-plain", reason: "image_review" });
  const money = await notifier.fire({ customerId: "U-img-money", reason: "image_review" });
  assert.equal(plain.skipped, "human_active");
  assert.equal(money.ok, true);
  assert.equal(calls.length, 1);
});

test("F15: ลูกค้าตอบหลังส่งต่อ (force) ขณะคนจริงอยู่ในห้อง = ไม่ปลุกซ้ำ แม้เป็นเหตุยิงครั้งเดียว", async (t) => {
  const { db, calls, notifier } = setup();
  t.after(() => db.close());
  humanReplied(db, "U-opp", 4 * 60_000);
  const result = await notifier.fire({ customerId: "U-opp", reason: "opportunity_handoff_reply", force: true });
  assert.equal(result.skipped, "human_active");
  assert.equal(calls.length, 0);
});
