// ตัวเฝ้าขั้นชำระเงิน (audit ลูกแพร 18 ต.ค. 2026): ห้องตอบเรื่องออกเอกสารแล้ว แต่ระบบส่งบัญชี 0 ครั้งใน 2 วัน = แจ้งเจ้าของ
// เหตุจริง: บล็อกบัญชีหายไป 27 ก.ย.–18 ต.ค. โดยไม่มีอะไรเตือน · ข้อความในไฟล์นี้เป็นประโยคสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { checkPaymentStepAndWarn, decidePaymentStepAlert, PAYMENT_WATCH_COOLDOWN_MS, PAYMENT_WATCH_KEY } from "../src/paymentStepWatch.mjs";
import { DOC_TYPE_QUESTION } from "../src/paymentStep.mjs";
import { createRetention } from "../src/retention.mjs";

const H = 3_600_000;
const T0 = Date.parse("2026-10-16T03:00:00Z");

function world() {
  let clock = T0;
  const db = memoryDb({ now: () => clock });
  const notices = [];
  return { db, notices, notifier: { fireLater(notice) { notices.push(notice); } }, at: (ms) => { clock = ms; }, now: () => clock };
}
function room(w, id, turns, name = "") {
  w.db.upsertCustomer?.({ lineUserId: id, displayName: name });
  for (const [hoursAfter, direction, content] of turns) {
    w.at(T0 + hoursAfter * H);
    w.db.insertMessage({ customerId: id, direction, msgType: "text", content });
  }
}

test("ตอบประเภทเอกสารแล้ว 2 ห้อง ระบบส่งบัญชี 0 ครั้งใน 48 ชม. -> แจ้งเจ้าของครั้งเดียว (บอกจำนวน + ห้องที่ยังไม่มีใครส่งบัญชี)", (t) => {
  const w = world();
  t.after(() => w.db.close());
  room(w, "U-watch-a", [[0, "out", DOC_TYPE_QUESTION], [1, "in", "บุคคลธรรมดาค่ะ"], [1.1, "out", "ได้เลยค่ะ"]]);
  room(w, "U-watch-b", [[2, "out", "ก่อนส่งข้อมูลชำระ รบกวนแจ้งว่าต้องการออกเอกสารในนามบุคคลธรรมดาหรือบริษัทคะ?"], [3, "in", "บริษัทครับ"],
    [4, "out", "สามารถโอนชำระได้ที่บัญชีนี้นะคะ\nเลขที่บัญชี : 000-0-00000-0"]]); // ทีมส่งเอง — นับว่าห้องนี้ไม่ค้าง แต่ระบบยังส่ง 0
  room(w, "U-watch-c", [[5, "out", DOC_TYPE_QUESTION], [6, "in", "ขอคิดก่อนนะคะ"]]); // ไม่ใช่คำตอบ
  w.at(T0 + 30 * H);
  const result = checkPaymentStepAndWarn({ db: w.db, notifier: w.notifier, now: w.now });
  assert.equal(result.warned, true);
  assert.equal(result.answered, 2);
  assert.equal(result.waiting, 1);
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].reason, "payment_step_stalled");
  assert.match(w.notices[0].reasonTextOverride, /ตอบเรื่องออกเอกสารแล้ว 2 ห้อง แต่ระบบส่งช่องทางชำระ 0 ครั้ง/u);
  assert.ok(w.db.listAudit().some((a) => a.action === "payment_step_stalled"));
  // วันถัดไป (ยังอยู่ในช่วงพัก 48 ชม.) ไม่เตือนซ้ำ
  w.at(T0 + 54 * H);
  assert.equal(checkPaymentStepAndWarn({ db: w.db, notifier: w.notifier, now: w.now }).warned, false);
  assert.equal(w.notices.length, 1);
});

test("ระบบส่งบัญชีอย่างน้อยครั้งเดียวในหน้าต่าง = ไม่เตือน · ไม่มีใครตอบเรื่องเอกสาร = ไม่เตือน", (t) => {
  const w = world();
  t.after(() => w.db.close());
  assert.equal(checkPaymentStepAndWarn({ db: w.db, notifier: w.notifier, now: w.now }).reason, "no_answers");
  room(w, "U-watch-ok", [[0, "out", DOC_TYPE_QUESTION], [1, "in", "นามบุคคลค่ะ"]]);
  w.at(T0 + 1.2 * H);
  w.db.addAudit({ operator: "system", action: "bank_sent_info_continues", target: "U-watch-ok", detail: "x" });
  w.at(T0 + 20 * H);
  const result = checkPaymentStepAndWarn({ db: w.db, notifier: w.notifier, now: w.now });
  assert.equal(result.warned, false);
  assert.equal(result.reason, "bank_sent_in_window");
  assert.equal(w.notices.length, 0);
});

test("คำตอบที่เก่ากว่า 48 ชม. ไม่นับ (หน้าต่างเลื่อน)", (t) => {
  const w = world();
  t.after(() => w.db.close());
  room(w, "U-watch-old", [[0, "out", DOC_TYPE_QUESTION], [1, "in", "บุคคลธรรมดา"]]);
  w.at(T0 + 60 * H);
  assert.equal(checkPaymentStepAndWarn({ db: w.db, notifier: w.notifier, now: w.now }).reason, "no_answers");
});

test("ทีมถามชื่อออกใบเสร็จหลังลูกค้าได้บัญชี/โอนไปแล้ว = ไม่ใช่ห้องค้าง (ผลตรวจโค้ด 18 ต.ค.)", (t) => {
  const w = world();
  t.after(() => w.db.close());
  room(w, "U-watch-receipt", [[0, "out", "สามารถโอนชำระได้ที่บัญชีนี้นะคะ\nเลขที่บัญชี : 000-0-00000-0"], [5, "in", "โอนแล้วค่ะ"],
    [6, "out", "ขอบคุณค่ะ ต้องการออกใบเสร็จในนามบุคคลธรรมดาหรือบริษัทคะ?"], [7, "in", "บุคคลธรรมดาค่ะ"]]);
  w.at(T0 + 30 * H);
  assert.equal(checkPaymentStepAndWarn({ db: w.db, notifier: w.notifier, now: w.now }).reason, "all_rooms_served");
});

test("ทีมส่งบัญชีให้ครบทุกห้องแล้ว (เช่น ใบเสนอราคา/หลายที่นั่ง) = ไม่เตือน ถึงระบบจะส่ง 0 ครั้ง", (t) => {
  const w = world();
  t.after(() => w.db.close());
  room(w, "U-watch-served", [[0, "out", DOC_TYPE_QUESTION], [1, "in", "บริษัทครับ"], [3, "out", "สามารถโอนชำระได้ที่บัญชีนี้นะคะ\nเลขที่บัญชี : 000-0-00000-0"]]);
  w.at(T0 + 20 * H);
  assert.equal(checkPaymentStepAndWarn({ db: w.db, notifier: w.notifier, now: w.now }).reason, "all_rooms_served");
  assert.equal(w.notices.length, 0);
});

test("ตัดสินล้วน: ช่วงพักเตือน 48 ชม.", () => {
  const rooms = [{ customerId: "a", name: "", delivered: false }];
  assert.equal(decidePaymentStepAlert({ rooms, sends: 0, lastWarnAt: T0, now: T0 + PAYMENT_WATCH_COOLDOWN_MS - 1 }).reason, "cooldown");
  assert.equal(decidePaymentStepAlert({ rooms, sends: 0, lastWarnAt: T0, now: T0 + PAYMENT_WATCH_COOLDOWN_MS }).warn, true);
});

test("ตัวเฝ้าเกาะรอบ retention รายวัน — ล้มเหลวไม่กระทบงานลบข้อมูล", (t) => {
  const w = world();
  t.after(() => w.db.close());
  room(w, "U-watch-ret", [[0, "out", DOC_TYPE_QUESTION], [1, "in", "บุคคลธรรมดาค่ะ"]]);
  w.at(T0 + 10 * H);
  const off = createRetention({ config: { retentionEnabled: true, retentionDays: {} }, db: w.db, notifier: w.notifier,
    logger: { log() {}, warn() {}, debug() {}, error() {} }, now: w.now });
  assert.equal(off.runOnce().paymentStep.skipped, "disabled", "ด่านเงินปิด (ธุรกิจอื่น) = ไม่เฝ้า");
  const retention = createRetention({ config: { retentionEnabled: true, retentionDays: {}, salesDecisionGuardEnabled: true }, db: w.db, notifier: w.notifier,
    logger: { log() {}, warn() {}, debug() {}, error() {} }, now: w.now });
  const result = retention.runOnce();
  assert.equal(result.ok, true);
  assert.equal(result.paymentStep.warned, true);
  assert.ok(Number(w.db.getSetting(PAYMENT_WATCH_KEY)) > 0);
  const broken = createRetention({ config: { retentionEnabled: true, retentionDays: {}, salesDecisionGuardEnabled: true },
    db: { ...w.db, pruneRetention: w.db.pruneRetention.bind(w.db), setSetting: w.db.setSetting.bind(w.db), getSetting: w.db.getSetting.bind(w.db),
      addAudit: w.db.addAudit.bind(w.db), listDocTypeAskCandidates() { throw new Error("boom"); } },
    logger: { log() {}, warn() {}, debug() {}, error() {} }, now: w.now });
  assert.equal(broken.runOnce().ok, true);
});
