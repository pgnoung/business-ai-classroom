// identity-link-hints.test.mjs — เดาคู่ห้อง Facebook ↔ LINE จากจังหวะเวลา (30 ก.ย. 2026)
// พี่ง้วง: ลูกค้าแอดไลน์แล้วไม่ส่งรหัส + "Facebook กับ LINE ชื่อไม่ตรงกันเลย LINE ใช้ชื่อเล่น" → ใช้เวลาแทนชื่อ ไม่เชื่อมเอง
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { createIdentityLink } from "../src/identityLink.mjs";
import { IDENTITY_LINK_MODE_KEY } from "../src/identityLinkCodes.mjs";
import { IDENTITY_HINT_KEY_PREFIX, createIdentityLinkHints } from "../src/identityLinkHints.mjs";

const SECRET = ["identity", "hint", "test", "key"].join("-");
const FB = "facebook:psid-hint-1";
const FB_2 = "facebook:psid-hint-2";
const LINE = "U0123456789abcdef0123456789abcd11";
const MIN = 60_000;
const START = Date.UTC(2026, 8, 30, 2, 0, 0);

function harness({ mode = "manual" } = {}) {
  let clock = START;
  const now = () => clock;
  const db = memoryDb({ now });
  db.setSetting(IDENTITY_LINK_MODE_KEY, mode);
  const client = () => ({ sendAllowed: () => true, sendBubbles: async () => ({ ok: true, mode: "push" }) });
  const lineRegistry = {
    channels: [
      { id: "default", name: "พี่ง้วง", active: true, basicId: "@pngoung" },
      { id: "facebook", name: "Facebook", provider: "facebook", active: true },
    ],
    forChannel: client,
    rawUserId: (key) => String(key).replace(/^facebook:/u, ""),
  };
  const notifications = [];
  const notifier = { fireLater: (args) => notifications.push(args) };
  const logger = { warn() {}, debug() {}, error() {}, log() {} };
  const link = createIdentityLink({
    config: { consoleSessionSecret: SECRET }, db, lineRegistry, now, notifier, logger,
    pipeline: { runExclusive: (id, work) => work() },
  });
  const timers = [];
  const hints = createIdentityLinkHints({ db, notifier, logger, now, schedule: (fn, ms) => timers.push({ fn, ms }) });
  const fbRoom = (id, name) => {
    db.upsertCustomer(id, { displayName: name, channelId: "facebook" });
    db.insertMessage({ customerId: id, direction: "in", channelId: "facebook", content: "โอนแล้วค่ะ" });
  };
  return { db, link, hints, notifications, timers, now, advance: (ms) => { clock += ms; }, fbRoom };
}

test("แอดไลน์ใหม่ไม่มีรหัส หลังส่งลิงก์เชิญที่ยังไม่มีใครใช้ → รอ 3 นาที แล้วแจ้งทีมพร้อมห้อง Facebook + คลาส + เวลา (ครั้งเดียวต่อห้อง)", async () => {
  const h = harness();
  h.fbRoom(FB, "Somsak Testuser");
  assert.equal((await h.link.sendInvite({ customerId: FB, operator: "chompoo", classType: "live_business" })).ok, true);
  h.advance(12 * MIN);
  h.db.upsertCustomer(LINE, { displayName: "ง้วง", channelId: "default" });
  assert.equal(h.hints.noteNewLineContact({ customerId: LINE, channelId: "default", at: h.now(), source: "follow" }), true);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 3 * MIN, "รอก่อน เผื่อลูกค้ากำลังส่งรหัสตามมา");
  assert.equal(h.notifications.length, 0);
  h.advance(3 * MIN);
  h.timers[0].fn();
  assert.equal(h.notifications.length, 1);
  const [note] = h.notifications;
  assert.equal(note.customerId, LINE, "ลิงก์ในแจ้งเตือนพาเข้าห้อง LINE ที่ต้องกดเชื่อม");
  assert.equal(note.reason, "identity_link_candidate");
  assert.equal(note.customerName, "ง้วง");
  assert.match(note.reasonTextOverride, /คุณSomsak Testuser \(Classroom AI Agent for Business\) ส่งลิงก์ 15 นาทีก่อน/u);
  assert.match(note.reasonTextOverride, /ระบบไม่เชื่อมเองจากเวลา/u);
  assert.ok(h.db.getSetting(`${IDENTITY_HINT_KEY_PREFIX}${LINE}`), "จดไว้ว่าแจ้งห้องนี้แล้ว");
  assert.equal(h.hints.noteNewLineContact({ customerId: LINE, channelId: "default", at: h.now(), source: "first_message" }), false, "ทักครั้งแรกตามมา = ไม่แจ้งซ้ำ");
  assert.equal(h.db.listLinkedIdentities(LINE).length, 0, "ไม่เชื่อมเอง");
  h.db.close();
});

test("ไม่แจ้ง: ไม่มีลิงก์ค้าง · ลิงก์ถูกใช้ไปแล้ว/เชื่อมแล้วระหว่างรอ · สวิตช์ปิด · ห้อง Facebook · ลิงก์เก่ากว่า 24 ชม.", async () => {
  const none = harness();
  none.db.upsertCustomer(LINE, { displayName: "ใหม่", channelId: "default" });
  assert.equal(none.hints.noteNewLineContact({ customerId: LINE, channelId: "default", at: none.now() }), false, "ไม่มีลิงก์ค้าง = ไม่ตั้งเวลาเลย");
  assert.equal(none.timers.length, 0);
  none.db.close();

  const linked = harness();
  linked.fbRoom(FB, "สมหญิง");
  await linked.link.sendInvite({ customerId: FB, operator: "a", classType: "online" });
  linked.db.upsertCustomer(LINE, { displayName: "หญิง", channelId: "default" });
  linked.hints.noteNewLineContact({ customerId: LINE, channelId: "default", at: linked.now() });
  linked.link.linkByTeam({ customerId: LINE, otherId: FB, operator: "a" });
  assert.deepEqual(linked.timers[0] && linked.hints.check({ customerId: LINE, channelId: "default", anchorMs: linked.now() }), { skipped: "linked" });
  assert.equal(linked.notifications.filter((n) => n.reason === "identity_link_candidate").length, 0);
  linked.db.close();

  const off = harness({ mode: "off" });
  off.fbRoom(FB, "สมหญิง");
  off.db.raw.prepare("INSERT INTO identity_link_codes (code_hash, customer_id, status, issued_via, issued_by, created_at, expires_at, class_type) VALUES ('h1', ?, 'active', 'console', 'a', ?, ?, 'online')")
    .run(FB, off.now(), off.now() + 30 * 24 * 60 * MIN);
  off.db.upsertCustomer(LINE, { displayName: "หญิง", channelId: "default" });
  assert.equal(off.hints.noteNewLineContact({ customerId: LINE, channelId: "default", at: off.now() }), false);
  assert.equal(off.hints.noteNewLineContact({ customerId: FB, channelId: "facebook", at: off.now() }), false);
  off.db.close();

  const old = harness();
  old.fbRoom(FB, "สมหญิง");
  await old.link.sendInvite({ customerId: FB, operator: "a", classType: "online" });
  old.advance(25 * 60 * MIN);
  old.db.upsertCustomer(LINE, { displayName: "หญิง", channelId: "default" });
  assert.equal(old.hints.noteNewLineContact({ customerId: LINE, channelId: "default", at: old.now() }), false, "ลิงก์ส่งเกิน 24 ชม. ก่อน = ไม่เกี่ยว");
  old.db.close();
});

test("แผงแนะนำ: ห้อง LINE ใหม่เห็นห้อง Facebook ที่ลิงก์ยังไม่ใช้ (ห่างน้อยก่อน) · ห้อง Facebook เห็นห้อง LINE ที่แอดหลังส่งลิงก์", async () => {
  const h = harness();
  h.fbRoom(FB, "ลูกค้าคนแรก");
  h.fbRoom(FB_2, "ลูกค้าคนที่สอง");
  await h.link.sendInvite({ customerId: FB, operator: "a", classType: "live_business" });
  h.advance(40 * MIN);
  await h.link.sendInvite({ customerId: FB_2, operator: "a", classType: "online" });
  h.advance(5 * MIN);
  h.db.upsertCustomer(LINE, { displayName: "ชื่อเล่นไม่ตรงใคร", channelId: "default" });
  h.db.recordLineFollow({ customerId: LINE, channelId: "default", followed: true, at: h.now() });
  const fromLine = h.link.suggestions(LINE);
  assert.deepEqual(fromLine.map((row) => row.id), [FB_2, FB], "ห่าง 5 นาทีมาก่อนห่าง 45 นาที");
  assert.deepEqual(fromLine[0].reasons, ["invite"]);
  assert.equal(fromLine[0].timingMs, 5 * MIN);
  assert.equal(fromLine[0].strong, false, "เวลาไม่ใช่หลักฐาน — ต้องให้คนดูบริบท");
  const fromFacebook = h.link.suggestions(FB_2);
  assert.equal(fromFacebook[0].id, LINE);
  assert.deepEqual(fromFacebook[0].reasons, ["new_friend"]);
  h.db.close();
});
