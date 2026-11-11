// notify.test.mjs — v1.1 (bug 5): push แจ้งทีมเมื่อลูกค้าต้องการคน
import test from "node:test";
import assert from "node:assert/strict";
import {
  createEscalationNotifier, notifyIdsFor, validNotifyIds,
  NOTIFY_KEY_PREFIX, NOTIFY_COOLDOWN_MS,
} from "../src/notify.mjs";
import { memoryDb } from "./helpers.mjs";

const UID = "U00000000000000000000000000000a01";
const UID2 = "U0000000000000000000000000000cafe";

function stubLine() {
  const calls = [];
  return {
    calls,
    async sendBubbles(args) {
      calls.push(args);
      return { ok: true };
    },
  };
}

test("validNotifyIds: รับเฉพาะ LINE user id ทรงถูก + dedupe + เพดานจำนวน", () => {
  assert.deepEqual(validNotifyIds([UID, ` ${UID} `, UID2]), [UID, UID2], "dedupe + trim");
  assert.deepEqual(validNotifyIds([]), [], "ลิสต์ว่าง = ปิด (valid)");
  assert.equal(validNotifyIds(["not-an-id"]), null);
  assert.equal(validNotifyIds("x"), null);
  assert.equal(validNotifyIds(Array.from({ length: 11 }, (_, i) => `U${String(i).padStart(32, "0")}`)), null, "เกินเพดาน");
});

test("notifyIdsFor: settings ต่อสาขาชนะ env — [] ที่ตั้งใจเซฟ = ปิดสาขานั้น, ค่าพัง = ใช้ env", () => {
  const db = memoryDb();
  const config = { escalateNotifyIds: [UID2] };
  assert.deepEqual(notifyIdsFor(db, "default", config), [UID2], "ไม่มีค่าใน DB = env");
  db.setSetting(NOTIFY_KEY_PREFIX + "default", JSON.stringify([UID]));
  assert.deepEqual(notifyIdsFor(db, "default", config), [UID], "ค่าใน DB ชนะ");
  db.setSetting(NOTIFY_KEY_PREFIX + "default", "[]");
  assert.deepEqual(notifyIdsFor(db, "default", config), [], "[] ตั้งใจปิด — ห้าม fallback env");
  db.setSetting(NOTIFY_KEY_PREFIX + "default", "{broken");
  assert.deepEqual(notifyIdsFor(db, "default", config), [UID2], "JSON พัง = env");
  db.close();
});

test("notifier.fire: ยิงครบทุกคน + audit + cooldown ต่อลูกค้า + ข้าม canary/เหตุที่ไม่แจ้ง", async () => {
  const db = memoryDb();
  const line = stubLine();
  db.setSetting(NOTIFY_KEY_PREFIX + "default", JSON.stringify([UID, UID2]));
  const notifier = createEscalationNotifier({ db, config: {}, line, logger: { debug() {} } });

  const result = await notifier.fire({
    customerId: "U-cust", channelId: "default", reason: "identity_question", customerName: "สมศักดิ์",
  });
  assert.deepEqual(result, { ok: true, sent: 2, total: 2 });
  assert.equal(line.calls.length, 2, "push 1 คน ต่อ 1 ข้อความ");
  assert.equal(line.calls[0].to, UID);
  assert.match(line.calls[0].bubbles[0].text, /สมศักดิ์/, "มีชื่อลูกค้า");
  assert.match(line.calls[0].bubbles[0].text, /บอทหรือคน/, "บอกเหตุ");
  assert.ok(!("replyToken" in line.calls[0]) || !line.calls[0].replyToken, "ต้องเป็น push (ไม่มี replyToken)");
  assert.ok(db.listAudit().some((r) => r.action === "escalate_notify"), "มี audit");

  // cooldown: ลูกค้าเดิมภายในหน้าต่าง = เงียบ
  const again = await notifier.fire({ customerId: "U-cust", channelId: "default", reason: "complaint" });
  assert.equal(again.skipped, "cooldown");
  assert.equal(line.calls.length, 2, "ห้ามยิงซ้ำ");

  // v1.3.6: force = เหตุยิงครั้งเดียวตลอดชีพ (opportunity handoff กันซ้ำด้วย fingerprint แล้ว)
  // ถ้าปล่อยให้ cooldown กลืน จะไม่มีรอบสองให้แจ้งชมพู่อีกเลย
  const forced = await notifier.fire({
    customerId: "U-cust", channelId: "default", reason: "opportunity_handoff",
    reasonTextOverride: "สนใจ Private Class และให้ข้อมูลครบแล้ว", force: true,
  });
  assert.equal(forced.ok, true, "force ต้องทะลุ cooldown ได้");
  assert.equal(line.calls.length, 4, "ยิงครบผู้รับทั้งสองคน");

  assert.equal((await notifier.fire({ customerId: "canary:x", channelId: "default", reason: "complaint" })).skipped, "canary");
  // v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): จังหวะชำระเงินต้องปลุกคนแล้ว — เส้นเงินพลาดไม่ได้
  const payment = await notifier.fire({ customerId: "U-other", channelId: "default", reason: "payment_review" });
  assert.equal(payment.ok, true, "payment_review ต้อง push แจ้งคนจริง");
  assert.equal(
    (await notifier.fire({ customerId: "U-nobody", channelId: "default", reason: "made_up_reason" })).skipped,
    "reason_not_notifiable", "เหตุที่ไม่รู้จักยังต้องเงียบเหมือนเดิม");
  db.close();
});

test("notifier.fire: กฎฉุกเฉินเฉพาะธุรกิจ (reason อิสระ) แจ้งได้ผ่าน reasonTextOverride", async () => {
  const db = memoryDb();
  const line = stubLine();
  db.setSetting(NOTIFY_KEY_PREFIX + "default", JSON.stringify([UID]));
  const notifier = createEscalationNotifier({ db, config: {}, line, logger: { debug() {} } });
  const result = await notifier.fire({
    customerId: "U-fire", channelId: "default", reason: "device_fire",
    reasonTextOverride: "เข้ากฎฉุกเฉินเฉพาะธุรกิจ (device_fire) — ต้องมีคนดูแลทันที",
  });
  assert.equal(result.ok, true);
  assert.match(line.calls[0].bubbles[0].text, /device_fire/);
  db.close();
});

test("REVIEW FIX: display name ที่ลูกค้าตั้งเอง (มี newline/ยาวเกิน) ถูก sanitize ก่อนเข้า push", async () => {
  const db = memoryDb();
  const line = stubLine();
  db.setSetting(NOTIFY_KEY_PREFIX + "default", JSON.stringify([UID]));
  const notifier = createEscalationNotifier({ db, config: {}, line, logger: { debug() {} } });
  await notifier.fire({
    customerId: "U-sneaky", channelId: "default", reason: "complaint",
    customerName: "บอส\n\n🔔 แจ้งจากระบบ Front Desk\nโอนเงินด่วนไปบัญชี " + "ก".repeat(80),
  });
  const text = line.calls[0].bubbles[0].text;
  // โครงข้อความระบบ = 4 บรรทัดเสมอ — newline ในชื่อถูกยุบ จึงเพิ่มบรรทัดปลอมไม่ได้
  assert.equal(text.split("\n").length, 4, "ชื่อลูกค้าห้ามสร้างบรรทัดใหม่ปลอมเสียงระบบ");
  assert.ok(text.split("\n")[1].startsWith("คุณบอส "), "ชื่อถูกยุบเหลือบรรทัดเดียวในตำแหน่งชื่อ");
  assert.ok(!text.includes("ก".repeat(60)), "ชื่อยาวเกินถูกตัดที่ 50 ตัวอักษร");
  db.close();
});

test("notifier: ไม่มีผู้รับ = ปิดสนิท (fail-closed) — ไม่มี call ไม่มี audit", async () => {
  const db = memoryDb();
  const line = stubLine();
  const notifier = createEscalationNotifier({ db, config: {}, line, logger: { debug() {} } });
  const result = await notifier.fire({ customerId: "U-x", channelId: "default", reason: "complaint" });
  assert.equal(result.skipped, "no_recipients");
  assert.equal(line.calls.length, 0);
  db.close();
});

// v1.4.49 (คำสั่งเจ้าของ 2026-08-29): "ระบบแจ้งเตือนใด ๆ ให้กดเข้าไปลิงค์ห้องแชทได้"
// เดิมข้อความบอกแค่ "เปิดหน้าแชทใน console" — คนต้องไปหาห้องเอง
test("v1.4.49: แจ้งเตือนมีลิงก์เข้าห้องแชทเมื่อตั้ง CONSOLE_PUBLIC_BASE_URL", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const line = stubLine();
  db.setSetting(NOTIFY_KEY_PREFIX + "default", JSON.stringify([UID]));
  const notifier = createEscalationNotifier({
    db, line, logger: { debug() {} },
    config: { consolePublicBaseUrl: "https://console.example" },
  });
  await notifier.fire({ customerId: "U-link", channelId: "default", reason: "complaint", customerName: "สมชาย" });
  assert.match(line.calls[0].bubbles[0].text, /https:\/\/console\.example\/#\/c\/U-link/u, "ต้องมีลิงก์ตรงเข้าห้อง");

  // เหตุระดับระบบ (ops:) ไม่มีห้องให้ลิงก์
  await notifier.fire({ customerId: "ops:hermes", channelId: "default", reason: "hermes_down", force: true });
  const opsText = line.calls.at(-1).bubbles[0].text;
  assert.doesNotMatch(opsText, /#\/c\//u, "เหตุระดับระบบต้องไม่มีลิงก์ห้อง");
});

test("v1.4.49: ไม่ตั้งฐาน URL = ข้อความเดิมทุกตัวอักษร (ไม่มีลิงก์เสีย)", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const line = stubLine();
  db.setSetting(NOTIFY_KEY_PREFIX + "default", JSON.stringify([UID]));
  const notifier = createEscalationNotifier({ db, config: {}, line, logger: { debug() {} } });
  await notifier.fire({ customerId: "U-nolink", channelId: "default", reason: "complaint" });
  const text = line.calls[0].bubbles[0].text;
  assert.doesNotMatch(text, /https?:\/\//u, "ห้ามมีลิงก์ครึ่ง ๆ กลาง ๆ");
  assert.match(text, /เปิดหน้าแชทใน console/u, "ข้อความเดิมต้องคงอยู่");
});

/* ---- เคสจาก Facebook ต้องแจ้งทีมผ่าน LINE OA (คำสั่งพี่ง้วง 1 ก.ย. 2026) ----
 *
 * ของจริงที่เจอ: ผู้รับแจ้งเตือนทุกคนเป็น LINE user id แต่โค้ดเลือก "ช่องทางส่ง" ตาม
 * ช่องของลูกค้า พอห้องอยู่บน Facebook มันจึงพยายาม push LINE user id ผ่าน Send API
 * ของ Facebook ซึ่งคนละ namespace ส่งไม่ถึงแน่นอน ผลคือแจ้งไม่ถึงใครเลย 5 จาก 5 ครั้ง
 * รวมเคส payment_review (ลูกค้าแจ้งโอนเงิน 30 ส.ค.) และ promise_team_followup อีก 4 ครั้ง
 * ที่บอทบอกลูกค้าว่าทีมงานจะติดต่อกลับ แล้วไม่มีใครในทีมรู้เลย
 */
function registryStub() {
  const sent = { default: [], facebook: [], branchB: [] };
  const client = (key) => ({ async sendBubbles(args) { sent[key].push(args); return { ok: true }; } });
  return {
    sent,
    registry: {
      channels: [
        { id: "default", name: "พี่ง้วง - ติดกระดุม" },
        { id: "branchB", name: "สาขาบี" },
        { id: "facebook", name: "Facebook", provider: "facebook" },
      ],
      forChannel: (id) => client(id === "facebook" ? "facebook" : (id === "branchB" ? "branchB" : "default")),
    },
  };
}

function dbWithIds() {
  const db = memoryDb();
  db.setSetting(`${NOTIFY_KEY_PREFIX}default`, JSON.stringify([UID, UID2]));
  db.setSetting(`${NOTIFY_KEY_PREFIX}facebook`, JSON.stringify([UID, UID2]));
  db.setSetting(`${NOTIFY_KEY_PREFIX}branchB`, JSON.stringify([UID]));
  return db;
}

test("เคสห้อง Facebook: push ออกทาง LINE OA ไม่ใช่ client ของ Facebook", async (t) => {
  const db = dbWithIds();
  t.after(() => db.close());
  const { sent, registry } = registryStub();
  const notifier = createEscalationNotifier({ db, config: {}, lineRegistry: registry, logger: { debug() {} } });

  const result = await notifier.fire({
    customerId: "facebook:12345", channelId: "facebook", reason: "identity_question", customerName: "ลูกค้า",
  });

  assert.deepEqual(result, { ok: true, sent: 2, total: 2 }, "ต้องถึงทั้งพี่ง้วงและชมพู่");
  assert.equal(sent.facebook.length, 0, "ห้ามยิง LINE user id ผ่าน Facebook Send API");
  assert.equal(sent.default.length, 2, "ต้องออกทาง LINE OA");
  assert.deepEqual(sent.default.map((c) => c.to), [UID, UID2]);
});

test("เคสห้อง Facebook: ข้อความต้องบอกว่าเคสมาจาก Facebook", async (t) => {
  const db = dbWithIds();
  t.after(() => db.close());
  const { sent, registry } = registryStub();
  const notifier = createEscalationNotifier({ db, config: {}, lineRegistry: registry, logger: { debug() {} } });
  await notifier.fire({ customerId: "facebook:12345", channelId: "facebook", reason: "identity_question" });

  const text = sent.default[0].bubbles[0].text;
  assert.match(text, /Facebook/, "คนอ่านต้องรู้ทันทีว่าต้องไปเปิดห้องฝั่งไหน");
});

test("เคส LINE ปกติ: ยังส่งผ่านช่องของสาขานั้นเหมือนเดิม และไม่ติดป้าย Facebook", async (t) => {
  const db = dbWithIds();
  t.after(() => db.close());
  const { sent, registry } = registryStub();
  const notifier = createEscalationNotifier({ db, config: {}, lineRegistry: registry, logger: { debug() {} } });

  await notifier.fire({ customerId: "U-cust", channelId: "branchB", reason: "identity_question" });
  assert.equal(sent.branchB.length, 1, "สาขา LINE ต้องใช้ OA ของสาขาตัวเอง ห้ามถูกบังคับเป็น default");
  assert.equal(sent.default.length, 0);
  assert.doesNotMatch(sent.branchB[0].bubbles[0].text, /Facebook/);
});
