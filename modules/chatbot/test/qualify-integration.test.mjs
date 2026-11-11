// qualify-integration — ต่อสายตัวกวาดคัดกรอง "AI off (not qualify)" + ด่านคำลงท้ายผู้หญิง (คำสั่งพี่ง้วง 5 ต.ค. 2026)
//
// สิ่งที่ไฟล์นี้คุม (Part D):
//   · คนกดเปิด AI ทับห้องสีเหลือง = ปักหมุด qualify_release (ตัวกวาดห้ามปิดซ้ำ) + audit "on · override:not_qualified"
//     ทั้งเส้นคอนโซล/Telegram (aiSwitch) และคีย์แดชบอร์ด (operatorApi) — ห้องเหตุอื่นเหมือนเดิมทุกไบต์
//   · ป้ายที่คนติด (customer/null) และการเชื่อมผู้ซื้อ FB→LINE ชนะห้องสีเหลือง
//   · ห้องสีเหลืองไม่อยู่ในคิวรอตอบ / ลีดร้อนรอทีม / backlog KPI (ตั้งใจไม่ตามต่อ)
//   · server: สวิตช์ PERSONA_PARTICLES · /health qualify · ตัวกวาดอยู่ใน app · answerPending เคารพหน้าต่าง 24 ชม. FB
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { setCustomerAiSwitch, NOT_QUALIFIED_OVERRIDE_AUDIT_SUFFIX, NOT_QUALIFIED_HUMAN_ON_PENDING_MAX_AGE_MS } from "../src/aiSwitch.mjs";
import { addCustomerTag } from "../src/customerTagActions.mjs";
import { createIdentityLink } from "../src/identityLink.mjs";
import { listWaitingRooms } from "../src/waitingRooms.mjs";
import { hotFollowupList } from "../src/consoleAttentionApi.mjs";
import { summarizeKpi } from "../src/kpi.mjs";
import { NOT_QUALIFIED_WAITING_TEAM_TEXT, aiOffInfo, notQualifiedReasonFor } from "../src/aiOffActor.mjs";
import { personaParticleAuditDetail, PERSONA_PARTICLE_AUDIT_ACTION } from "../src/personaParticleAudit.mjs";
import { createQualifyAnswerPending, QUALIFY_PENDING_AUDIT_ACTION } from "../src/qualifyAnswerPending.mjs";
import { REVIEW_RECLAIM_PHRASES, STAY_YELLOW_PHRASES } from "./fixtures/qualify-reclaim-phrases.mjs";
import {
  FAST_VERDICT_CONFIDENCE, QUALIFY_ANSWER_SKIPPED_FIELD, YELLOW_HELD_AUDIT_ACTION, YELLOW_HELD_MAX_PARTS,
  collectYellowHeldParts, fastReclaimSignal, fastVerdictFor, handleNotQualifiedTurn, isSafetyReclaimSignal,
  reclaimNotQualified, yellowOffAtFor,
} from "../src/qualifyFastReclaim.mjs";
import {
  NOT_QUALIFIED_REASON, NOT_QUALIFIED_REASON_TEXT, QUALIFY_SWEEP_MODE_KEY, qualifyHoldKey, qualifyHumanOnKey,
  qualifyReleaseKey, qualifyStateKey,
} from "../src/notQualified.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const KEY_HEADER = { "x-dashboard-key": "test-dashboard-key", "content-type": "application/json" };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function yellow(db, id, extra = {}) {
  db.upsertCustomer(id, { displayName: extra.name || id, channelId: extra.channelId || "default" });
  db.setAiEnabled(id, false, NOT_QUALIFIED_REASON);
  return db.getCustomer(id);
}

/* ------------------------- คนเปิดทับห้องสีเหลือง = ปักหมุด ------------------------- */

test("aiSwitch: เปิด AI ทับห้องสีเหลือง = หมุด qualify_release {at,by} + audit on · override · ห้องเหตุอื่น/การปิด ไม่ปักหมุด", () => {
  const db = memoryDb();
  yellow(db, "U-y");
  const customer = setCustomerAiSwitch({ db, customerId: "U-y", enabled: true, operator: "nok", nowMs: 1234 });
  assert.equal(customer.ai_enabled, 1);
  assert.equal(customer.ai_off_reason, "");
  assert.deepEqual(JSON.parse(db.getSetting(qualifyReleaseKey("U-y"))), { at: 1234, by: "nok" });
  const audit = db.listAudit().find((row) => row.action === "ai_toggle" && row.target === "U-y");
  assert.equal(audit.detail, `on${NOT_QUALIFIED_OVERRIDE_AUDIT_SUFFIX}`);
  assert.ok(audit.detail.startsWith("on"), "ตัวอ่านเดิม (ownerChatSnapshot) ใช้ startsWith('on')");

  // Telegram: ต่อท้ายที่มาก่อน override
  yellow(db, "U-y2");
  setCustomerAiSwitch({ db, customerId: "U-y2", enabled: true, operator: "telegram:1", source: "telegram" });
  assert.equal(db.listAudit().find((row) => row.target === "U-y2" && row.action === "ai_toggle").detail, "on · telegram · override:not_qualified");

  // ห้องปิดด้วยมือ / ห้องเงิน = เหมือนเดิมทุกไบต์
  for (const reason of ["manual", "money_line", "booking_handoff"]) {
    const id = `U-${reason}`;
    db.upsertCustomer(id, {});
    db.setAiEnabled(id, false, reason);
    setCustomerAiSwitch({ db, customerId: id, enabled: true, operator: "nok" });
    assert.equal(db.getSetting(qualifyReleaseKey(id)), null, reason);
    assert.equal(db.listAudit().find((row) => row.target === id && row.action === "ai_toggle").detail, "on", reason);
  }
  // ปิดห้องสีเหลืองด้วยมือ = เหตุ manual (คนชนะ) ไม่ใช่การปลดหมุด
  yellow(db, "U-y3");
  setCustomerAiSwitch({ db, customerId: "U-y3", enabled: false, operator: "nok" });
  assert.equal(db.getCustomer("U-y3").ai_off_reason, "manual");
  assert.equal(db.getSetting(qualifyReleaseKey("U-y3")), null);
  assert.equal(db.listAudit().find((row) => row.target === "U-y3" && row.action === "ai_toggle").detail, "off");
  db.close();
});

test("aiSwitch: เขียนหมุดไม่ได้ = เตือน แต่การเปิด AI ต้องสำเร็จ", () => {
  const db = memoryDb();
  yellow(db, "U-y");
  const warnings = [];
  const setSetting = db.setSetting.bind(db);
  db.setSetting = (key, value) => {
    if (key === qualifyReleaseKey("U-y")) throw new Error("disk full");
    return setSetting(key, value);
  };
  const customer = setCustomerAiSwitch({ db, customerId: "U-y", enabled: true, operator: "nok", logger: { warn: (m) => warnings.push(m), log() {}, error() {} } });
  assert.equal(customer.ai_enabled, 1);
  assert.equal(warnings.length, 1);
  db.close();
});

test("dashboard key: เปิดทับห้องสีเหลือง = หมุด + audit on · override · ห้องปิดด้วยมือ detail 'on' เดิม", async (t) => {
  const db = memoryDb();
  const app = createApp({ config: testConfig(), db, overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  yellow(db, "U-dk");
  db.upsertCustomer("U-dk-manual", {});
  db.setAiEnabled("U-dk-manual", false, "manual");
  for (const id of ["U-dk", "U-dk-manual"]) {
    const res = await httpRequest(app.server, { method: "POST", path: `/api/customers/${id}/ai`, headers: KEY_HEADER, body: JSON.stringify({ enabled: true }) });
    assert.equal(res.status, 200);
  }
  assert.ok(JSON.parse(db.getSetting(qualifyReleaseKey("U-dk"))).at > 0);
  assert.equal(JSON.parse(db.getSetting(qualifyReleaseKey("U-dk"))).by, "dashboard-key");
  assert.equal(db.getSetting(qualifyReleaseKey("U-dk-manual")), null);
  const detail = (id) => db.listAudit().find((row) => row.target === id && row.action === "ai_toggle").detail;
  assert.equal(detail("U-dk"), "on · override:not_qualified");
  assert.equal(detail("U-dk-manual"), "on");
  // รีวิวปรปักษ์ 5 ต.ค. #5: คีย์แดชบอร์ดก็ประทับเวลาคนเปิด AI ทุกเหตุ
  for (const id of ["U-dk", "U-dk-manual"]) assert.ok(Number(db.getSetting(qualifyHumanOnKey(id))) > 0, id);
  // #21: เส้นนี้ไม่มี pipeline — ไม่ตอบข้อความค้างแทนคน (ห้องกลับเข้าคิวรอตอบให้คนเห็นเอง)
  yellow(db, "U-dk-pending");
  db.insertMessage({ customerId: "U-dk-pending", direction: "in", content: "ตอนนี้เปิดร้านกาแฟค่ะ" });
  const res = await httpRequest(app.server, { method: "POST", path: "/api/customers/U-dk-pending/ai", headers: KEY_HEADER, body: JSON.stringify({ enabled: true }) });
  assert.equal(res.status, 200);
  assert.equal(db.listAudit().filter((row) => row.action === QUALIFY_PENDING_AUDIT_ACTION).length, 0);
  // ปิดด้วยคีย์ = ไม่ประทับ
  db.upsertCustomer("U-dk-off", {});
  await httpRequest(app.server, { method: "POST", path: "/api/customers/U-dk-off/ai", headers: KEY_HEADER, body: JSON.stringify({ enabled: false }) });
  assert.equal(db.getSetting(qualifyHumanOnKey("U-dk-off")), null);
});

// รีวิวปรปักษ์ 5 ต.ค. #5: ห้องร้องเรียน/ขอคุยกับคน/ปิดด้วยมือ/ไม่ใช่ลูกค้า ที่คนคุยจบแล้วกดเปิดคืน เคยไม่มีหมุดใด
// ตัวกวาดจึงปิดเหลืองได้ในรอบชั่วโมงถัดไป — ทุกการเปิดของคน (คอนโซล · Telegram · YOLO) ต้องประทับเวลา
test("aiSwitch (#5): คนเปิด AI ทุกเหตุ = ประทับ qualify_human_on:<id> = เวลาที่กด · ปิด = ไม่ประทับ · เขียนไม่ได้ = การเปิดยังสำเร็จ", () => {
  const db = memoryDb();
  const reasons = ["complaint", "human_requested", "manual", "not_a_customer", "file_review", NOT_QUALIFIED_REASON];
  for (const [index, reason] of reasons.entries()) {
    const id = `U-on-${reason}`;
    db.upsertCustomer(id, {});
    db.setAiEnabled(id, false, reason);
    const source = ["console", "telegram", "yolo·line"][index % 3];
    setCustomerAiSwitch({ db, customerId: id, enabled: true, operator: "nok", source, nowMs: 5000 + index });
    assert.equal(db.getSetting(qualifyHumanOnKey(id)), String(5000 + index), `${reason} via ${source}`);
  }
  // เปิดห้องที่เปิดอยู่แล้วซ้ำ = คนยืนยันอีกครั้ง → เวลาใหม่
  setCustomerAiSwitch({ db, customerId: "U-on-manual", enabled: true, operator: "nok", nowMs: 9000 });
  assert.equal(db.getSetting(qualifyHumanOnKey("U-on-manual")), "9000");
  // ห้องเหลืองยังได้หมุดห้ามปิดซ้ำเดิมด้วย
  assert.ok(db.getSetting(qualifyReleaseKey(`U-on-${NOT_QUALIFIED_REASON}`)));
  assert.equal(db.getSetting(qualifyReleaseKey("U-on-complaint")), null);
  // ปิด = ไม่ประทับ
  db.upsertCustomer("U-off", {});
  setCustomerAiSwitch({ db, customerId: "U-off", enabled: false, operator: "nok", nowMs: 7000 });
  assert.equal(db.getSetting(qualifyHumanOnKey("U-off")), null);
  // เขียนไม่ได้ = เตือน แต่ AI ต้องเปิด
  db.upsertCustomer("U-broken", {});
  db.setAiEnabled("U-broken", false, "complaint");
  const setSetting = db.setSetting.bind(db);
  db.setSetting = (key, value) => {
    if (key === qualifyHumanOnKey("U-broken")) throw new Error("disk full");
    return setSetting(key, value);
  };
  const warnings = [];
  const row = setCustomerAiSwitch({ db, customerId: "U-broken", enabled: true, operator: "nok", logger: { warn: (m) => warnings.push(m), log() {}, error() {} } });
  assert.equal(row.ai_enabled, 1);
  assert.equal(warnings.length, 1);
  db.close();
});

// รีวิวปรปักษ์ 5 ต.ค. #21: คนกดเปิดทับห้องสีเหลือง (= เห็นว่าคุยต่อได้) ต้องได้คำตอบข้อความที่ค้าง เหมือนตัวกวาดเปิดเขียวเอง
test("aiSwitch (#21): เปิดทับห้องเหลืองที่มีข้อความค้าง = ส่งเข้าเส้นตอบครั้งเดียวพร้อมข้อความระหว่างเหลือง · FB นอกหน้าต่าง/ไม่มี pipeline/ห้องเหตุอื่น = ไม่ส่ง", async () => {
  const T = Date.UTC(2026, 9, 5, 5, 0, 0);
  let clock = T;
  const db = memoryDb({ now: () => clock });
  const calls = [];
  const pipeline = { handleInboundText: async (args) => { calls.push(args); return { sent: true }; } };
  yellow(db, "U-h");
  db.insertMessage({ customerId: "U-h", direction: "in", content: "ตกงานอยู่ค่ะ" });
  db.insertMessage({ customerId: "U-h", direction: "out", content: "เข้าใจค่ะ", agentMode: "ai" });
  db.setSetting(qualifyStateKey("U-h"), JSON.stringify({ verdict: "not_qualified", offAt: T + MIN }));
  clock = T + 2 * MIN;
  db.insertMessage({ customerId: "U-h", direction: "in", content: "ตอนนี้เปิดร้านกาแฟสองสาขาแล้วค่ะ" });
  clock = T + 3 * MIN;
  db.insertMessage({ customerId: "U-h", direction: "in", content: "ลูกค้าทักเยอะจนตอบแชทไม่ทันเลยค่ะ" });
  clock = T + 10 * MIN;
  setCustomerAiSwitch({ db, customerId: "U-h", enabled: true, operator: "nok", nowMs: clock, pipeline, logger: silent });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].customerId, "U-h");
  assert.equal(calls[0].text, "ลูกค้าทักเยอะจนตอบแชทไม่ทันเลยค่ะ");
  assert.equal(calls[0].replyToken, "");
  assert.deepEqual(calls[0].heldParts, ["ตอนนี้เปิดร้านกาแฟสองสาขาแล้วค่ะ"], "ข้อความก่อนหน้าระหว่างเหลืองนำหน้า ไม่รวมข้อความที่ตอบแล้ว");
  const pendingAudit = db.listAudit().filter((row) => row.action === QUALIFY_PENDING_AUDIT_ACTION && row.target === "U-h");
  assert.equal(pendingAudit.length, 1);
  assert.match(pendingAudit[0].detail, /คนกดเปิด AI ทับห้องสีเหลือง/u);
  assert.equal(db.listAudit().filter((row) => row.action === YELLOW_HELD_AUDIT_ACTION && row.target === "U-h").length, 1);

  // Facebook นอกหน้าต่าง 24 ชม. = ไม่ส่ง (กฎ Meta) แต่ห้องเปิดแล้ว
  yellow(db, "facebook:h", { channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:h", direction: "in", channelId: "facebook", content: "สนใจค่ะ" });
  clock += 25 * HOUR;
  setCustomerAiSwitch({ db, customerId: "facebook:h", enabled: true, operator: "nok", nowMs: clock, pipeline, logger: silent });
  // ไม่มี pipeline (Telegram/YOLO) = ไม่ตอบแทนคน · ห้องปิดด้วยมือ = พฤติกรรมเดิม (ไม่ replay)
  yellow(db, "U-h-nopipe");
  db.insertMessage({ customerId: "U-h-nopipe", direction: "in", content: "ขอข้อมูลหน่อยค่ะ" });
  setCustomerAiSwitch({ db, customerId: "U-h-nopipe", enabled: true, operator: "telegram:1", source: "telegram", nowMs: clock });
  db.upsertCustomer("U-h-manual", {});
  db.insertMessage({ customerId: "U-h-manual", direction: "in", content: "ขอข้อมูลหน่อยค่ะ" });
  db.setAiEnabled("U-h-manual", false, "manual");
  setCustomerAiSwitch({ db, customerId: "U-h-manual", enabled: true, operator: "nok", nowMs: clock, pipeline, logger: silent });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1, "ส่งเฉพาะห้องเหลือง LINE ที่มีข้อความค้าง");
  assert.equal(db.getCustomer("facebook:h").ai_enabled, 1);
  assert.equal(db.getCustomer("U-h-nopipe").state, "AI_ACTIVE", "ไม่มี pipeline = ไม่ปักธงแทน (ห้องกลับเข้าคิวรอตอบเอง)");
  db.close();
});

/* --------------------------- ป้าย/การเชื่อมของคน ชนะห้องเหลือง --------------------------- */

test("ติดป้าย customer/null ในห้องสีเหลือง = เหตุของป้ายทับทันที (คนชนะ AI) · เหตุหนักกว่าเดิมห้ามทับ", () => {
  const db = memoryDb();
  yellow(db, "U-tag-c");
  yellow(db, "U-tag-n");
  db.upsertCustomer("U-urgent", {});
  db.setAiEnabled("U-urgent", false, "urgent_mental");
  assert.equal(addCustomerTag({ db, customerId: "U-tag-c", tag: "customer", operator: "nok" }).aiSilenced, true);
  assert.equal(db.getCustomer("U-tag-c").ai_off_reason, "customer_handover");
  assert.equal(addCustomerTag({ db, customerId: "U-tag-n", tag: "null", operator: "nok" }).aiSilenced, true);
  assert.equal(db.getCustomer("U-tag-n").ai_off_reason, "not_a_customer");
  assert.equal(addCustomerTag({ db, customerId: "U-urgent", tag: "customer", operator: "nok" }).aiSilenced, false);
  assert.equal(db.getCustomer("U-urgent").ai_off_reason, "urgent_mental");
  // ป้ายธรรมดาไม่แตะห้องเหลือง
  yellow(db, "U-tag-plain");
  addCustomerTag({ db, customerId: "U-tag-plain", tag: "VIP", operator: "nok" });
  assert.equal(db.getCustomer("U-tag-plain").ai_off_reason, NOT_QUALIFIED_REASON);
  db.close();
});

test("เชื่อมผู้ซื้อ Facebook → ห้อง LINE สีเหลือง = customer_handover + ป้าย customer (ตัวกวาดเปิดคืนเองไม่ได้)", () => {
  const db = memoryDb();
  const FB = "facebook:psid-777";
  const LINE = "U0123456789abcdef0123456789abcd77";
  db.upsertCustomer(FB, { displayName: "สมหญิง", channelId: "facebook" });
  db.insertMessage({ customerId: FB, direction: "in", channelId: "facebook", content: "สนใจค่ะ" });
  db.addTag(FB, "customer", "human");
  yellow(db, LINE, { name: "LINE คน" });
  const link = createIdentityLink({
    config: { consoleSessionSecret: ["qualify", "link", "key"].join("-") }, db,
    lineRegistry: { channels: [{ id: "default", active: true }, { id: "facebook", provider: "facebook", active: true }], forChannel: () => ({ sendAllowed: () => true, sendBubbles: async () => ({ ok: true }) }), rawUserId: (k) => k },
    pipeline: { runExclusive: (id, work) => work() },
    notifier: { fireLater() {} }, logger: silent,
  });
  assert.equal(link.linkByTeam({ customerId: LINE, otherId: FB, operator: "nok" }).state, "linked");
  const room = db.getCustomer(LINE);
  assert.equal(room.ai_enabled, 0);
  assert.equal(room.ai_off_reason, "customer_handover");
  assert.ok(db.listTags(LINE).some((row) => row.tag === "customer"));
  db.close();
});

/* ------------------------ คิวรอตอบ / ลีดร้อน / KPI ไม่นับห้องเหลือง ------------------------ */

function clockDb() {
  let fixed = null;
  const db = memoryDb({ now: () => fixed ?? Date.now() });
  const at = (ms, fn) => { fixed = ms; try { return fn(); } finally { fixed = null; } };
  return { db, at };
}

// รีวิวปรปักษ์ 5 ต.ค. #20: ซ่อนเฉพาะ "เหลืองนิ่งที่ตัวกวาดยืนยันแล้ว" (AI_ACTIVE + qualify_hold ≥ ข้อความลูกค้าล่าสุด)
test("คิวรอตอบ + ลีดร้อนรอทีม: ห้องเหลืองนิ่งที่ยืนยันแล้วไม่ขึ้น · ห้องปิดด้วยมือยังขึ้นตามเดิม", () => {
  const { db, at } = clockDb();
  const now = Date.now();
  const room = (id, score = null) => {
    at(now - 20 * DAY, () => db.upsertCustomer(id, { displayName: id }));
    if (score != null) at(now - 20 * DAY + MIN, () => db.recordScore(id, score, "{}"));
  };
  const msg = (id, direction, ago, content, extra = {}) => at(now - ago, () => db.insertMessage({ customerId: id, direction, content, ...extra }));
  room("W-yellow");
  msg("W-yellow", "in", 2 * HOUR, "ขอรายละเอียดหน่อยค่ะ");
  db.setAiEnabled("W-yellow", false, NOT_QUALIFIED_REASON);
  db.setSetting(qualifyHoldKey("W-yellow"), String(now - 2 * HOUR)); // ตัวกวาดยืนยันถึงข้อความนี้แล้ว
  room("W-manual");
  msg("W-manual", "in", 2 * HOUR, "ขอรายละเอียดหน่อยค่ะ");
  db.setAiEnabled("W-manual", false, "manual");
  room("H-yellow", 9);
  msg("H-yellow", "in", 3 * DAY + HOUR, "สนใจคลาสค่ะ");
  msg("H-yellow", "out", 3 * DAY, "มีรอบปลายเดือนค่ะ", { agentMode: "ai" });
  db.setAiEnabled("H-yellow", false, NOT_QUALIFIED_REASON);
  db.setSetting(qualifyHoldKey("H-yellow"), String(now - 3 * DAY - HOUR));
  room("H-on", 9);
  msg("H-on", "in", 3 * DAY + HOUR, "สนใจคลาสค่ะ");
  msg("H-on", "out", 3 * DAY, "มีรอบปลายเดือนค่ะ", { agentMode: "ai" });

  const waiting = listWaitingRooms({ db, now }).rooms.map((r) => r.id);
  assert.ok(waiting.includes("W-manual"), "ห้องที่คนปิดยังรอคนตอบ");
  assert.ok(!waiting.includes("W-yellow"), "ห้องเหลืองนิ่งที่ยืนยันแล้ว = ตั้งใจไม่ตามต่อ");
  const hot = hotFollowupList(db, { now }).rooms.map((r) => r.id);
  assert.ok(hot.includes("H-on"));
  assert.ok(!hot.includes("H-yellow"), "คะแนนค้างจากก่อนปิดเหลือง ไม่ใช่ลีดร้อนที่ต้อง push");
  // เปิดคืน = กลับเข้าคิวตามปกติ
  db.setAiEnabled("W-yellow", true);
  assert.ok(listWaitingRooms({ db, now }).rooms.some((r) => r.id === "W-yellow"));
  db.close();
});

test("คิวรอตอบ/ลีดร้อน (#20): ห้องเหลืองที่รอคน · ปิดเคสแล้วทักกลับ · ข้อความใหม่ที่ตัวกวาดยังไม่ยืนยัน · ไม่มีหมุด = ขึ้นคิว", () => {
  const { db, at } = clockDb();
  const now = Date.now();
  const yellowRoom = (id, { ago = 2 * HOUR, text = "ได้งานใหม่แล้วค่ะ อยากเรียนคอร์สให้ทีม", hold = undefined } = {}) => {
    at(now - 20 * DAY, () => db.upsertCustomer(id, { displayName: id }));
    at(now - ago, () => db.insertMessage({ customerId: id, direction: "in", content: text }));
    db.setAiEnabled(id, false, NOT_QUALIFIED_REASON);
    if (hold !== undefined) db.setSetting(qualifyHoldKey(id), String(hold));
  };
  // (ก) รอทีมตรวจไฟล์ (NEEDS_HUMAN) — หมุดครอบข้อความแล้วก็ยังต้องขึ้น เพราะห้องรอคน
  yellowRoom("Y-needs", { hold: now });
  db.setNeedsHuman("Y-needs", "file_review", "ลูกค้าส่งไฟล์แนบ");
  // (ข) กดเสร็จสิ้นแล้วลูกค้าทักกลับมา (state RESOLVED · resolved_at ก่อนข้อความ)
  yellowRoom("Y-resolved", { ago: HOUR, hold: now - 5 * HOUR });
  at(now - 3 * HOUR, () => db.setConversationResolved("Y-resolved", true));
  // (ค) หมุดเก่ากว่าข้อความล่าสุด = ตัวกวาดยังไม่ได้ยืนยันข้อความใหม่ (ตรวจซ้ำล้ม/unclear/ชนเพดาน/สวิตช์ไม่ใช่ on)
  yellowRoom("Y-stale-hold", { hold: now - 3 * HOUR });
  // (ง) ไม่มีหมุดเลย / ค่าหมุดเพี้ยน
  yellowRoom("Y-no-hold");
  yellowRoom("Y-junk-hold", { hold: "{\"at\":1}" });
  // ควบคุม: เหลืองนิ่งที่ยืนยันแล้ว
  yellowRoom("Y-quiet", { hold: now - 2 * HOUR });

  const waiting = listWaitingRooms({ db, now }).rooms.map((r) => r.id);
  for (const id of ["Y-needs", "Y-resolved", "Y-stale-hold", "Y-no-hold", "Y-junk-hold"]) {
    assert.ok(waiting.includes(id), `${id} ต้องอยู่ในคิวรอตอบ`);
  }
  assert.ok(!waiting.includes("Y-quiet"));
  // แถวในคิวยังบอกว่า AI ปิดเพราะคัดกรอง (ป้ายเหลือง) ให้ทีมรู้ที่มา
  const needs = listWaitingRooms({ db, now }).rooms.find((r) => r.id === "Y-needs");
  assert.equal(needs.aiOff?.by, "qualify");
  // รีวิวปรปักษ์รอบ 2 5 ต.ค.: ห้องเหลืองที่รอทีม ห้ามบอกว่า "เปิดคืนเอง" (ตัวกวาดเปิดห้องสถานะนี้ไม่ได้) — บอกว่ารอทีม
  assert.equal(needs.aiOff?.reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT);
  assert.doesNotMatch(needs.aiOff.reasonText, /เปิดคืนเองเมื่อเห็นศักยภาพ/u);
  const stale = listWaitingRooms({ db, now }).rooms.find((r) => r.id === "Y-stale-hold");
  assert.equal(stale.aiOff?.reasonText, NOT_QUALIFIED_REASON_TEXT, "ห้องเหลือง AI_ACTIVE ยังเปิดคืนเองได้ = ถ้อยคำเดิม");
  const resolved = listWaitingRooms({ db, now }).rooms.find((r) => r.id === "Y-resolved");
  assert.equal(resolved.aiOff?.reasonText, NOT_QUALIFIED_REASON_TEXT, "ปิดเคสแล้วทักกลับ = ตัวกวาดเปิดได้ (RESOLVED)");

  // ลีดร้อน: กติกาเดียวกัน — เหลืองที่หมุดเก่ากว่าข้อความล่าสุดยังขึ้น
  const hotRoom = (id, hold) => {
    at(now - 20 * DAY, () => db.upsertCustomer(id, { displayName: id }));
    at(now - 20 * DAY + MIN, () => db.recordScore(id, 9, "{}"));
    at(now - 3 * DAY - HOUR, () => db.insertMessage({ customerId: id, direction: "in", content: "สนใจคลาสค่ะ" }));
    at(now - 3 * DAY, () => db.insertMessage({ customerId: id, direction: "out", content: "มีรอบปลายเดือนค่ะ", agentMode: "ai" }));
    db.setAiEnabled(id, false, NOT_QUALIFIED_REASON);
    if (hold !== undefined) db.setSetting(qualifyHoldKey(id), String(hold));
  };
  hotRoom("HY-stale", now - 4 * DAY);
  hotRoom("HY-quiet", now - 3 * DAY);
  const hot = hotFollowupList(db, { now }).rooms.map((r) => r.id);
  assert.ok(hot.includes("HY-stale"), "หมุดเก่ากว่าข้อความ = ยังไม่ยืนยัน → ขึ้น");
  assert.ok(!hot.includes("HY-quiet"));
  db.close();
});

test("KPI (#20): ตัดเฉพาะห้องเหลืองนิ่งที่ยืนยันแล้ว · ห้องเหลืองรอคน/ข้อความใหม่/ไม่มีหมุด = backlog ของทีม", () => {
  const nowMs = Date.UTC(2026, 9, 5, 5, 0, 0);
  const inbound = { direction: "in", created_at: nowMs - HOUR };
  const yellowRow = (id, extra = {}) => ({ line_user_id: id, ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON, state: "AI_ACTIVE", ...extra });
  const holds = new Map([["u-y", nowMs - HOUR], ["u-y-needs", nowMs], ["u-y-stale", nowMs - 2 * HOUR]]);
  const kpi = summarizeKpi({
    nowMs,
    qualifyHoldOf: (id) => holds.get(id),
    rooms: [
      { customer: yellowRow("u-y"), messages: [inbound] },
      { customer: yellowRow("u-y-needs", { state: "NEEDS_HUMAN" }), messages: [inbound] },
      { customer: yellowRow("u-y-stale"), messages: [inbound] },
      { customer: yellowRow("u-y-nohold"), messages: [inbound] },
      { customer: yellowRow("u-y-col", { qualify_hold_at: nowMs - HOUR }), messages: [inbound] },
      { customer: { line_user_id: "u-m", ai_enabled: 0, ai_off_reason: "manual" }, messages: [inbound] },
      { customer: { line_user_id: "u-on", ai_enabled: 1 }, messages: [inbound] },
    ],
  });
  assert.equal(kpi.backlog.excluded.notQualifiedRooms, 2, "u-y (callback) + u-y-col (คอลัมน์)");
  assert.equal(kpi.backlog.total, 5);
  const top = kpi.backlog.top.map((item) => item.customerId);
  for (const id of ["u-y-needs", "u-y-stale", "u-y-nohold", "u-m", "u-on"]) assert.ok(top.includes(id), id);
  assert.ok(!top.includes("u-y") && !top.includes("u-y-col"));
  assert.equal(kpi.backlog.waitingForHuman, 4, "ห้องเหลืองที่ยังไม่ยืนยันนับเป็นงานของคน");
  // ไม่ส่งหมุดมาเลย = ไม่ตัดห้องเหลืองใด (fail open) · callback พัง = ไม่ตัด
  const open = summarizeKpi({ nowMs, rooms: [{ customer: yellowRow("u-y"), messages: [inbound] }] });
  assert.equal(open.backlog.total, 1);
  const broken = summarizeKpi({ nowMs, qualifyHoldOf: () => { throw new Error("db down"); }, rooms: [{ customer: yellowRow("u-y"), messages: [inbound] }] });
  assert.equal(broken.backlog.total, 1);
});

/* ------------------------------- คอนโซล: เหตุของคำตัดสิน ------------------------------- */

test("notQualifiedReasonFor: เฉพาะห้องเหลืองที่คำตัดสินล่าสุดเป็น not_qualified · ห้องอื่นไม่อ่าน settings", () => {
  const db = memoryDb();
  const row = yellow(db, "U-r");
  assert.equal(notQualifiedReasonFor(db, row), "");
  db.setSetting(qualifyStateKey("U-r"), JSON.stringify({ verdict: "not_qualified", reason: "ตกงานและหาแต่ช่องทางรายได้ฟรี" }));
  assert.equal(notQualifiedReasonFor(db, row), "ตกงานและหาแต่ช่องทางรายได้ฟรี");
  assert.equal(aiOffInfo(row, { qualifyReason: notQualifiedReasonFor(db, row) }).reasonText, "ตกงานและหาแต่ช่องทางรายได้ฟรี");
  db.setSetting(qualifyStateKey("U-r"), JSON.stringify({ verdict: "unclear", reason: "ข้อมูลยังน้อย" }));
  assert.equal(notQualifiedReasonFor(db, row), "", "คำตัดสินภายหลังไม่ใช่เหตุที่ปิดห้อง");
  assert.equal(aiOffInfo(row, { qualifyReason: notQualifiedReasonFor(db, row) }).reasonText, NOT_QUALIFIED_REASON_TEXT);
  // รีวิวปรปักษ์รอบ 2 5 ต.ค.: ห้องเหลืองที่รอทีม (NEEDS_HUMAN) = ถ้อยคำรอทีม แทนทั้งคำอธิบายกลางและเหตุของคำตัดสิน
  db.setSetting(qualifyStateKey("U-r"), JSON.stringify({ verdict: "not_qualified", reason: "ตกงาน" }));
  db.setNeedsHuman("U-r", "image_review", "ลูกค้าส่งรูป");
  const waitingRow = db.getCustomer("U-r");
  assert.equal(waitingRow.state, "NEEDS_HUMAN");
  assert.equal(aiOffInfo(waitingRow, { qualifyReason: notQualifiedReasonFor(db, waitingRow) }).reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT);
  assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON, state: "AI_ACTIVE" }, { qualifyReason: "ตกงาน" }).reasonText, "ตกงาน");
  assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: "file_review", state: "NEEDS_HUMAN" }).reasonText === NOT_QUALIFIED_WAITING_TEAM_TEXT, false, "ห้องเหตุอื่นถ้อยคำเดิม");
  let reads = 0;
  const spy = { getSetting: () => { reads += 1; return null; } };
  assert.equal(notQualifiedReasonFor(spy, { line_user_id: "x", ai_enabled: 0, ai_off_reason: "manual" }), "");
  assert.equal(notQualifiedReasonFor(spy, { line_user_id: "x", ai_enabled: 1 }), "");
  assert.equal(reads, 0);
  db.close();
});

/* --------------------------------- สัญญาณเปิดเขียวทันที --------------------------------- */

test("fastReclaimSignal: ความปลอดภัยมาก่อน · สัญญาณซื้อจากตัวจับเดิม · คุยเล่น/อยากหารายได้ = ไม่มีสัญญาณ", () => {
  assert.equal(fastReclaimSignal({ prioritySafetyRoute: true, route: { escalate: {} } }), "safety");
  assert.equal(fastReclaimSignal({ route: { escalate: { reason: "x" } } }), "escalate");
  assert.equal(fastReclaimSignal({ route: { optOut: true } }), "optout");
  assert.equal(fastReclaimSignal({ route: { route: "quiet_stop" } }), "quiet_stop");
  assert.equal(fastReclaimSignal({ handoffHint: { kind: "booking", from: "current" }, text: "ขอบคุณค่ะ" }), "handoff");
  assert.equal(fastReclaimSignal({ handoffHint: { kind: "booking", from: "recent" }, text: "ขอบคุณค่ะ" }), "", "ใบ้เก่าตัวกวาดเห็นแล้ว");
  assert.equal(fastReclaimSignal({ text: "โอนแล้วค่ะ" }), "payment_action");
  assert.equal(fastReclaimSignal({ text: "ราคาเท่าไหร่คะ" }), "money_ask");
  assert.equal(fastReclaimSignal({ text: "จะสมัครค่ะ" }), "enroll");
  assert.equal(fastReclaimSignal({ text: "รอบหน้าเรียนวันไหนคะ" }), "schedule");
  for (const text of ["สวัสดีค่ะ", "ขอบคุณค่ะ 555", "อยากหารายได้เสริมค่ะ ตกงานอยู่", "มีงานให้ทำไหมคะ", "", "   "]) {
    assert.equal(fastReclaimSignal({ text }), "", text);
  }
  assert.equal(fastReclaimSignal(), "");
});

test("fastReclaimSignal (#3/#7): ทุกวลีจากรีวิวมีสัญญาณ · คำหางาน/หารายได้/คุยเล่นไม่มี · งาน project จากตัวจับของระบบ", () => {
  for (const text of REVIEW_RECLAIM_PHRASES) assert.notEqual(fastReclaimSignal({ text }), "", text);
  for (const text of STAY_YELLOW_PHRASES) assert.equal(fastReclaimSignal({ text }), "", text);
  // ชื่อสัญญาณตรงชนิด (audit fast:<signal> อ่านออก)
  assert.equal(fastReclaimSignal({ text: "ขอเลขบัญชีค่ะ" }), "payment_intent");
  assert.equal(fastReclaimSignal({ text: "จ่ายผ่านบัตรได้ไหม" }), "payment_intent");
  assert.equal(fastReclaimSignal({ text: "โกงหรือเปล่า" }), "frustration");
  assert.equal(fastReclaimSignal({ text: "อยากพาพนักงานมาเรียน 5 คน" }), "team");
  assert.equal(fastReclaimSignal({ text: "คลาสหน้าเมื่อไหร่ครับ" }), "class_ask");
  assert.equal(fastReclaimSignal({ text: "สนใจคลาสค่ะ" }), "interest");
  assert.equal(fastReclaimSignal({ text: "เรียนที่ไหนคะ" }), "location");
  assert.equal(fastReclaimSignal({ text: "หมดเขตเมื่อไหร่คะ" }), "promotion");
  // ผลตัวจับงาน project ของไปป์ไลน์ (detectDirectOpportunityType) = team แม้ถ้อยคำไม่อยู่ในชุดสำรอง
  assert.equal(fastReclaimSignal({ text: "ขอคุยเรื่องงานพิเศษหน่อยค่ะ", projectOpportunity: "speaker_engagement" }), "team");
  // ความปลอดภัยเท่านั้นที่ทะลุด่านห้องรอคน
  for (const signal of ["safety", "escalate", "optout", "quiet_stop"]) assert.equal(isSafetyReclaimSignal(signal), true, signal);
  for (const signal of ["money_ask", "payment_intent", "frustration", "team", "interest", "handoff", ""]) assert.equal(isSafetyReclaimSignal(signal), false, signal);
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ด่าน NEEDS_HUMAN ของรอบแรกถอดออก — ห้องเหลืองที่รอคนแต่ยัง not_qualified (ไฟล์/รูป/เสียงของลีด)
// ได้คำตอบเหมือนห้องเขียว · ห้องที่ทีมต้องดูจริงเปลี่ยนเหตุไปแล้ว (file_review/money_line) CAS จึงแพ้ที่เหตุ
test("reclaimNotQualified (รอบ 2): ห้องเหลือง NEEDS_HUMAN ที่ยัง not_qualified เปิดได้ทุกสัญญาณ · ห้องที่เปลี่ยนเหตุแล้ว/เหตุอื่น ไม่แตะ", () => {
  const db = memoryDb();
  for (const id of ["U-n-buy", "U-n-frus", "U-n-safe", "U-ok", "U-resolved", "U-file-review"]) yellow(db, id);
  for (const id of ["U-n-buy", "U-n-frus", "U-n-safe"]) db.setNeedsHuman(id, "image_review", "ลูกค้าส่งรูป");
  db.setConversationResolved("U-resolved", true);
  assert.equal(reclaimNotQualified({ db, customerId: "U-n-buy", signal: "money_ask", logger: silent }), true, "ลีดถามราคาหลังส่งรูป = ตอบเหมือนห้องเขียว");
  assert.equal(reclaimNotQualified({ db, customerId: "U-n-frus", signal: "frustration", logger: silent }), true);
  assert.equal(db.getCustomer("U-n-buy").ai_enabled, 1);
  assert.equal(db.getCustomer("U-n-buy").state, "NEEDS_HUMAN", "ธงรอคนยังอยู่ (ทีมยังเห็นในคิว) — แค่ AI ไม่เงียบใส่ลีด");
  assert.equal(reclaimNotQualified({ db, customerId: "U-n-safe", signal: "safety", logger: silent }), true, "ร้องเรียนต้องไม่ถูกกลืน");
  assert.equal(reclaimNotQualified({ db, customerId: "U-ok", signal: "money_ask", logger: silent }), true);
  assert.equal(reclaimNotQualified({ db, customerId: "U-resolved", signal: "class_ask", logger: silent }), true, "ปิดเคสแล้วทักกลับมาซื้อ = เปิดได้");
  // ไฟล์ในห้องที่ทีมคุยอยู่ = ไปป์ไลน์เปลี่ยนเหตุเป็น file_review แล้ว — ทางลัดแตะไม่ได้ (ห้องของคน)
  db.setNeedsHuman("U-file-review", "file_review", "ลูกค้าส่งไฟล์");
  db.setAiEnabled("U-file-review", false, "file_review");
  assert.equal(reclaimNotQualified({ db, customerId: "U-file-review", signal: "money_ask", logger: silent }), false);
  assert.equal(db.getCustomer("U-file-review").ai_off_reason, "file_review");
  // ทวงคำตอบไม่ใช่หลักฐานว่าจะซื้อ
  yellow(db, "U-frus");
  reclaimNotQualified({ db, customerId: "U-frus", signal: "frustration", logger: silent });
  assert.equal(JSON.parse(db.getSetting(qualifyStateKey("U-frus"))).verdict, "unclear");
  db.upsertCustomer("U-manual", {});
  db.setAiEnabled("U-manual", false, "manual");
  assert.equal(reclaimNotQualified({ db, customerId: "U-manual", signal: "safety", logger: silent }), false);
  db.close();
});

// รีวิวปรปักษ์ 5 ต.ค. #20 (รวมงาน): หมุด qualify_hold อยู่ได้เฉพาะตอนเหลือง — ทางลัดเปิดเขียวลบเหมือนตัวกวาด
// เปิดไม่สำเร็จ (ห้องที่เหตุไม่ใช่ not_qualified แล้ว) = หมุดเดิมอยู่ต่อ
test("reclaimNotQualified: เปิดเขียวสำเร็จ = ลบหมุด qualify_hold · เปิดไม่สำเร็จ = ไม่แตะหมุด", () => {
  const db = memoryDb();
  for (const id of ["U-hold-ok", "U-hold-lost"]) {
    yellow(db, id);
    db.setSetting(qualifyHoldKey(id), "12345");
  }
  db.setAiEnabled("U-hold-lost", false, "file_review");
  assert.equal(reclaimNotQualified({ db, customerId: "U-hold-ok", signal: "money_ask", logger: silent }), true);
  assert.equal(db.getSetting(qualifyHoldKey("U-hold-ok")), null);
  assert.equal(reclaimNotQualified({ db, customerId: "U-hold-lost", signal: "money_ask", logger: silent }), false);
  assert.equal(db.getSetting(qualifyHoldKey("U-hold-lost")), "12345");
  db.close();
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ทางลัดเคยจดทุกสัญญาณเป็น potential/buying_intent มั่นใจ 1.0 (แม้ "สนใจค่ะ" คำเดียว)
test("fastVerdictFor (รอบ 2): ไม่มีสัญญาณไหนจดมั่นใจ 1.0 · category เข้าคู่กับ verdict · น้ำหนักตามสัญญาณ", () => {
  const all = ["safety", "escalate", "optout", "quiet_stop", "handoff", "payment_action", "money_ask", "payment_intent", "frustration",
    "enroll", "schedule", "price", "promotion", "team", "class_ask", "interest", "location"];
  const PAIRS = { potential: ["buying_intent", "has_business_or_job"], unclear: ["insufficient"] };
  for (const signal of all) {
    const v = fastVerdictFor(signal);
    assert.ok(v.confidence < 1 && v.confidence >= 0.5, `${signal} ${v.confidence}`);
    assert.ok(PAIRS[v.verdict]?.includes(v.category), `${signal} ${v.verdict}/${v.category}`);
  }
  for (const signal of ["safety", "escalate", "optout", "quiet_stop", "frustration"]) assert.equal(fastVerdictFor(signal).verdict, "unclear", signal);
  assert.equal(fastVerdictFor("payment_intent").confidence, FAST_VERDICT_CONFIDENCE.strong);
  assert.equal(fastVerdictFor("schedule").confidence, FAST_VERDICT_CONFIDENCE.medium);
  assert.equal(fastVerdictFor("interest").confidence, FAST_VERDICT_CONFIDENCE.soft);
  assert.ok(fastVerdictFor("interest").confidence < fastVerdictFor("money_ask").confidence, "สนใจคำเดียวเบากว่าถามราคา");
  // สถานะจริงที่ทางลัดเขียน
  const db = memoryDb();
  yellow(db, "U-int");
  reclaimNotQualified({ db, customerId: "U-int", signal: "interest", lastInboundId: "m1", logger: silent });
  const state = JSON.parse(db.getSetting(qualifyStateKey("U-int")));
  assert.deepEqual([state.verdict, state.category, state.confidence, state.strength, state.mode, state.fast],
    ["potential", "buying_intent", FAST_VERDICT_CONFIDENCE.soft, "soft", "fast", "interest"]);
  db.close();
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: คำปฏิเสธ · ของฟรี · หางาน · "ด่วน/หลอก" ลอย ๆ — ทุกวลีของผู้ตรวจอยู่ใน STAY_YELLOW_PHRASES แล้ว
// ที่นี่ล็อกชื่อสัญญาณของฝั่งผู้ซื้อที่ต้องไม่ถูกด่านใหม่กิน (audit fast:<signal> อ่านออก)
test("fastReclaimSignal (รอบ 2): ปฏิเสธ/ของฟรี/หางาน/หาเงินด่วน = ไม่มีสัญญาณ · ผู้ซื้อที่มีคำเหล่านี้ปน = ยังได้สัญญาณที่ถูกชนิด", () => {
  for (const text of ["ไม่สนใจค่ะ", "ยังไม่สนใจค่ะ ขอบคุณค่ะ", "ไม่อยากเรียนแล้วค่ะ", "ไม่ได้สนใจค่ะ", "ไม่ค่อยสนใจ", "ไม่น่าสนใจเลย",
    "อยากเรียนฟรีค่ะ", "มีคลาสฟรีไหมคะ", "อยากเรียน free ค่ะ", "สนใจทำงานออนไลน์ค่ะ", "อยากสมัครเป็นพนักงานค่ะ เพิ่งเรียนจบ",
    "รับพนักงานไหมคะ เรียนจบ ปวส", "อยากทำงานเป็นทีมงานของพี่ง้วงค่ะ ไม่ต้องเรียนได้ไหม", "ที่บ้านมี 4 คน ไม่มีใครมีงานทำ อยากเรียนฟรี",
    "อยากได้เงินด่วนค่ะ", "หาเงินด่วนค่ะ ตกงานอยู่", "มีงานด่วนไหมคะ", "หาเงินด่วนมากค่ะ", "ไม่ได้หลอกนะคะ", "รับสมัครไหมคะ"]) {
    assert.equal(fastReclaimSignal({ text }), "", text);
  }
  const expect = {
    "ไม่เอาออนไลน์ อยากเรียนที่ห้อง": "interest", "เป็นฟรีแลนซ์ค่ะ สนใจคลาส": "interest",
    "ร้านรับพนักงานใหม่ 5 คน อยากให้มาเรียน AI": "team", "ทำงานกับทีม 10 คน อยากให้ทีมเรียน AI": "team",
    "ผมเป็นทีมงานฝ่ายการตลาด บริษัทอยากส่งพนักงานมาเรียน": "team", "ยังไม่สนใจออนไลน์ค่ะ แต่มีคลาสที่ห้องเดือนหน้าไหมคะ": "class_ask",
    "ไม่ได้หลอกใช่ไหมคะ": "frustration", "หลอกลวง": "frustration", "ด่วนค่ะ": "frustration", "เรื่องด่วนค่ะ": "frustration",
    "ด่วนมากค่ะ": "frustration", "รบกวนตอบด่วนค่ะ": "frustration", "ขอด่วนนะคะ": "frustration",
    "เปิดรับสมัครรอบหน้าเมื่อไหร่คะ": "schedule", "ไม่สนใจโปร แต่ราคาเท่าไหร่คะ": "money_ask",
  };
  for (const [text, signal] of Object.entries(expect)) assert.equal(fastReclaimSignal({ text }), signal, text);
  // ผลตัวจับ project ของระบบใช้ได้เมื่อไม่มีวลีปฏิเสธ — "ไม่สนใจ inhouse" ต้องไม่เป็นทีม
  assert.equal(fastReclaimSignal({ text: "ขอคุยเรื่องงานพิเศษหน่อยค่ะ", projectOpportunity: "speaker_engagement" }), "team");
  assert.equal(fastReclaimSignal({ text: "ไม่สนใจinhouseค่ะ", projectOpportunity: "in_house_training" }), "");
  assert.equal(fastReclaimSignal({ text: "รับพนักงานไหมคะ", projectOpportunity: "in_house_training" }), "", "หางานชนะผลตัวจับ project");
});

// รีวิวปรปักษ์รอบ 3 5 ต.ค.: ทุกวลีของผู้ตรวจอยู่ใน STAY_YELLOW_PHRASES (ไปป์ไลน์จริงเทสต์ใน qualify-pipeline) — ที่นี่ล็อกชนิดสัญญาณ
test("fastReclaimSignal (รอบ 3): ปฏิเสธ จอง/สมัคร/ลงเรียน/ซื้อ · ถามค่าตอบแทน = ไม่มีสัญญาณ · คำถามราคา/จ่ายของผู้ซื้อยังได้ชนิดเดิม", () => {
  for (const text of ["ไม่สมัครค่ะ", "ไม่จองค่ะ", "ยังไม่จองนะคะ", "ยังไม่สมัครค่ะ ขอคิดก่อน", "คงไม่ได้สมัครค่ะ", "ยังไม่อยากจองค่ะ",
    "ไม่ได้อยากจองค่ะ", "ไม่ต้องจองให้นะคะ", "ไม่ลงเรียนค่ะ", "ไม่ซื้อคอร์สค่ะ", "เลิกสนใจแล้ว", "อยากได้ของแจกค่ะ", "สนใจงานค่ะ",
    "สนใจทำงานค่ะ", "เงินเดือนเท่าไหร่คะ", "ได้เงินวันละเท่าไหร่คะ", "ค่าจ้างเท่าไหร่คะ", "รายได้ต่อเดือนประมาณเท่าไหร่คะ",
    "ทำแล้วได้เงินเท่าไหร่", "โอนเงินเดือนให้ทุกวันไหม", "รับเงินผ่านบัญชีไหนคะ", "ค่าคอมเท่าไหร่คะ"]) {
    assert.equal(fastReclaimSignal({ text }), "", text);
  }
  const expect = {
    "คอร์สราคาเท่าไหร่คะ": "money_ask", "ขอเลขบัญชีค่ะ จะโอนค่าเรียน": "money_ask", "ค่าเรียนเท่าไหร่": "money_ask",
    "ต้องลงทุนเท่าไหร่": "money_ask", "ลงเรียนค่ะ": "class_ask", "ขอเลขบัญชีค่ะ": "payment_intent",
    // ท่อนหลังที่เป็นสัญญาณจริงยังเห็น (ตัดถึงช่องว่าง/แต่) · ทวงคำตอบชนะคำเงิน · จองชนะคำเงินเดือน
    "ไม่ต้องลงทะเบียนก่อนใช่ไหม ลงเรียนเลยได้ไหมคะ": "class_ask", "ไม่ซื้อคอร์สออนไลน์ แต่อยากลงเรียนที่ห้องค่ะ": "class_ask",
    "ทำไมไม่ตอบ เงินเดือนเท่าไหร่": "frustration", "เงินเดือนออกแล้วจะจองค่ะ": "enroll",
    // แจกแจง = อธิบาย ไม่ใช่ของแจก · สนใจงาน + ชื่องาน = งานอีเวนต์ ไม่ใช่หางาน
    "ช่วยแจกแจงรายละเอียดคลาสหน่อยค่ะ": "class_ask", "สนใจงานสัมมนาค่ะ": "interest",
  };
  for (const [text, signal] of Object.entries(expect)) assert.equal(fastReclaimSignal({ text }), signal, text);
});

// รีวิวปรปักษ์ 5 ต.ค. #9: ข้อความที่พิมพ์ระหว่างเหลือง = หลังคำตอบล่าสุด · ตั้งแต่ปิดเหลือง · ≤10 · ไม่ซ้ำกับเทิร์นปัจจุบัน
test("collectYellowHeldParts (#9): ขอบล่าง offAt + คำตอบล่าสุด · ข้อความเท่านั้น · ตัดเทิร์นปัจจุบัน (ข้อความ/ป้ายถอดเสียง/รหัส) · ไม่เกิน 10", () => {
  const T = Date.UTC(2026, 9, 5, 3, 0, 0);
  let clock = T;
  const db = memoryDb({ now: () => clock });
  const at = (ms, row) => { clock = ms; return db.insertMessage(row); };
  db.upsertCustomer("U-c", {});
  at(T, { customerId: "U-c", direction: "in", content: "ก่อนคำตอบ (ตอบแล้ว)" });
  at(T + MIN, { customerId: "U-c", direction: "out", content: "รับทราบค่ะ", agentMode: "ai" });
  at(T + 2 * MIN, { customerId: "U-c", direction: "in", content: "ก่อนปิดเหลือง" });
  const offAt = T + 3 * MIN;
  at(T + 4 * MIN, { customerId: "U-c", direction: "in", content: "ระหว่างเหลือง 1" });
  at(T + 5 * MIN, { customerId: "U-c", direction: "in", msgType: "image", content: "[image] id=x" });
  at(T + 6 * MIN, { customerId: "U-c", direction: "in", content: "ระหว่างเหลือง 2" });
  const current = at(T + 7 * MIN, { customerId: "U-c", direction: "in", content: "ราคาเท่าไหร่คะ" });
  assert.deepEqual(collectYellowHeldParts(db, "U-c", { offAt, incoming: ["ราคาเท่าไหร่คะ"] }), ["ระหว่างเหลือง 1", "ระหว่างเหลือง 2"]);
  // ไม่รู้ offAt = ถึงคำตอบล่าสุด (ข้อความก่อนคำตอบไม่ถูกดึง)
  assert.deepEqual(collectYellowHeldParts(db, "U-c", { incoming: ["ราคาเท่าไหร่คะ"] }), ["ก่อนปิดเหลือง", "ระหว่างเหลือง 1", "ระหว่างเหลือง 2"]);
  // ก้อนหลายข้อความ (burst) ตัดทั้งก้อน · เทียบไม่ติด = ตัดด้วยรหัสแถว
  assert.deepEqual(collectYellowHeldParts(db, "U-c", { offAt, incoming: ["ระหว่างเหลือง 2", "ราคาเท่าไหร่คะ"] }), ["ระหว่างเหลือง 1"]);
  assert.deepEqual(collectYellowHeldParts(db, "U-c", { offAt, incoming: ["(ข้อความ seed)"], currentId: String(current.id ?? current) }), ["ระหว่างเหลือง 1", "ระหว่างเหลือง 2"]);
  // ถอดเสียง: แถวใน DB มีป้าย [เสียงถอดความ] ที่ก้อนไม่มี
  at(T + 8 * MIN, { customerId: "U-c", direction: "in", content: "[เสียงถอดความ] สนใจคลาสค่ะ" });
  assert.deepEqual(collectYellowHeldParts(db, "U-c", { offAt, incoming: ["สนใจคลาสค่ะ"] }), ["ระหว่างเหลือง 1", "ระหว่างเหลือง 2", "ราคาเท่าไหร่คะ"]);
  // เพดาน 10 ข้อความล่าสุด
  db.upsertCustomer("U-many", {});
  for (let i = 0; i < 14; i += 1) at(T + 10 * MIN + i * MIN, { customerId: "U-many", direction: "in", content: `ข้อความ ${i}` });
  const many = collectYellowHeldParts(db, "U-many", { incoming: ["ข้อความ 13"] });
  assert.equal(many.length, YELLOW_HELD_MAX_PARTS);
  assert.equal(many.at(-1), "ข้อความ 12");
  // คนตอบระหว่างเหลือง = ข้อความก่อนหน้านั้นได้คำตอบแล้ว
  at(T + 30 * MIN, { customerId: "U-c", direction: "out", content: "ทีมขอตอบเองนะคะ", operator: "staff1" });
  at(T + 31 * MIN, { customerId: "U-c", direction: "in", content: "ขอบคุณค่ะ" });
  assert.deepEqual(collectYellowHeldParts(db, "U-c", { offAt, incoming: ["ขอบคุณค่ะ"] }), []);
  // offAt: คำตัดสินก่อน → audit ปิดเหลือง → 0 · อ่านพัง = ว่าง ไม่โยน
  db.setSetting(qualifyStateKey("U-c"), JSON.stringify({ verdict: "not_qualified", offAt }));
  assert.equal(yellowOffAtFor(db, "U-c"), offAt);
  assert.equal(yellowOffAtFor(db, "U-none"), 0);
  clock = T + 40 * MIN;
  db.addAudit({ operator: "system:qualify", action: "ai_off_not_qualified", target: "U-audit", detail: "x" });
  assert.equal(yellowOffAtFor(db, "U-audit"), T + 40 * MIN);
  assert.deepEqual(collectYellowHeldParts({ raw: { prepare() { throw new Error("db down"); } } }, "U-c", { logger: silent }), []);
  db.close();
});

/* ----------------------------- answerPending หลังเปิดเขียว ----------------------------- */

test("answerPending (#9): ส่งข้อความล่าสุด + heldParts = ข้อความระหว่างเหลืองก่อนหน้า (ไม่ซ้ำ) · ไม่มีข้อความค้างอื่น = รูปแบบเดิม", async () => {
  const T = Date.UTC(2026, 9, 5, 5, 0, 0);
  let clock = T;
  const db = memoryDb({ now: () => clock });
  const calls = [];
  const pipeline = { handleInboundText: async (args) => { calls.push(args); return { sent: true }; } };
  const answerPending = createQualifyAnswerPending({ db, pipeline, logger: silent, now: () => clock });
  db.upsertCustomer("U-g", {});
  db.insertMessage({ customerId: "U-g", direction: "in", content: "ตกงานอยู่ค่ะ" });
  db.insertMessage({ customerId: "U-g", direction: "out", content: "เข้าใจค่ะ", agentMode: "ai" });
  db.setSetting(qualifyStateKey("U-g"), JSON.stringify({ verdict: "potential", offAt: T + MIN }));
  clock = T + 2 * MIN;
  db.insertMessage({ customerId: "U-g", direction: "in", content: "ตอนนี้เปิดร้านกาแฟสองสาขาแล้วค่ะ" });
  clock = T + 3 * MIN;
  db.insertMessage({ customerId: "U-g", direction: "in", content: "ลูกค้าทักเยอะจนตอบแชทไม่ทันเลยค่ะ" });
  assert.equal(answerPending({ customerId: "U-g" }).redispatched, true);
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].text, "ลูกค้าทักเยอะจนตอบแชทไม่ทันเลยค่ะ");
  assert.deepEqual(calls[0].heldParts, ["ตอนนี้เปิดร้านกาแฟสองสาขาแล้วค่ะ"]);
  assert.equal(db.listAudit().filter((row) => row.action === YELLOW_HELD_AUDIT_ACTION).length, 1);
  db.close();
});

test("answerPending: Facebook นอกหน้าต่าง 24 ชม. = ไม่ส่ง ไม่ audit · ในหน้าต่าง/LINE = ส่งข้อความค้างเข้าเส้นตอบ", async () => {
  const T = Date.UTC(2026, 9, 5, 5, 0, 0);
  let clock = T;
  const db = memoryDb({ now: () => clock });
  const calls = [];
  const pipeline = { handleInboundText: async (args) => { calls.push(args); return { sent: true }; } };
  const answerPending = createQualifyAnswerPending({ db, pipeline, logger: silent, now: () => clock });
  db.upsertCustomer("facebook:old", { channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:old", direction: "in", channelId: "facebook", content: "ราคาเท่าไหร่คะ" });
  clock = T + 25 * HOUR;
  assert.deepEqual(answerPending({ customerId: "facebook:old" }), { skipped: "fb_window_closed" });
  assert.equal(db.listAudit().filter((row) => row.action === QUALIFY_PENDING_AUDIT_ACTION).length, 0);

  db.upsertCustomer("facebook:new", { channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:new", direction: "in", channelId: "facebook", content: "ขอรอบเรียนหน่อยค่ะ" });
  clock += MIN;
  assert.equal(answerPending({ customerId: "facebook:new" }).redispatched, true);
  db.upsertCustomer("U-line", {});
  db.insertMessage({ customerId: "U-line", direction: "in", content: "สนใจคลาสค่ะ" });
  clock += 30 * HOUR; // LINE ไม่มีหน้าต่าง 24 ชม.
  assert.equal(answerPending({ customerId: "U-line" }).redispatched, true);
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls.map((c) => [c.customerId, c.text, c.replyToken]), [["facebook:new", "ขอรอบเรียนหน่อยค่ะ", ""], ["U-line", "สนใจคลาสค่ะ", ""]]);
  assert.equal(db.listAudit().filter((row) => row.action === QUALIFY_PENDING_AUDIT_ACTION).length, 2);
  // ห้องยังปิด (ตัวกวาดแพ้ CAS ไปแล้ว ฯลฯ) = ไม่ส่ง
  yellow(db, "U-still-off");
  db.insertMessage({ customerId: "U-still-off", direction: "in", content: "สนใจค่ะ" });
  assert.deepEqual(answerPending({ customerId: "U-still-off" }), { skipped: "ai_off" });
  assert.deepEqual(answerPending({ customerId: "U-missing" }), { skipped: "no_customer" });
  db.close();
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: คนกดเปิด AI ทับห้องเหลืองเคยตอบ "ค่ะ" ที่ค้างมา 5 วันทันที และตอบซ้ำข้อความที่ทีมตอบไปแล้ว
test("answerPending maxPendingAgeMs (รอบ 2): เก่ากว่าเกณฑ์ = stale_pending · ข้อความล่าสุดเป็นขาออก = already_answered · ไม่ส่ง ไม่ audit", async () => {
  const T = Date.UTC(2026, 9, 5, 5, 0, 0);
  let clock = T;
  const db = memoryDb({ now: () => clock });
  const calls = [];
  const pipeline = { handleInboundText: async (args) => { calls.push(args); return { sent: true }; } };
  const answerPending = createQualifyAnswerPending({ db, pipeline, logger: silent, now: () => clock, maxPendingAgeMs: DAY });
  db.upsertCustomer("U-old", {});
  db.insertMessage({ customerId: "U-old", direction: "in", content: "ค่ะ" });
  clock = T + 5 * DAY;
  assert.deepEqual(answerPending({ customerId: "U-old" }), { skipped: "stale_pending" });
  // ทีมตอบแล้ว (แถวขาออกของคนหรือ AI) = ไม่ตอบซ้ำ แม้ข้อความลูกค้าใหม่
  db.upsertCustomer("U-answered", {});
  db.insertMessage({ customerId: "U-answered", direction: "in", content: "สนใจค่ะ" });
  clock += MIN;
  db.insertMessage({ customerId: "U-answered", direction: "out", content: "ยินดีค่ะ", operator: "staff1" });
  assert.deepEqual(answerPending({ customerId: "U-answered" }), { skipped: "already_answered" });
  // ใหม่กว่าเกณฑ์ = ตอบตามเดิม
  db.upsertCustomer("U-fresh", {});
  db.insertMessage({ customerId: "U-fresh", direction: "in", content: "ตอนนี้เปิดร้านแล้วค่ะ" });
  clock += 23 * HOUR;
  assert.equal(answerPending({ customerId: "U-fresh" }).redispatched, true);
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].customerId, "U-fresh");
  assert.equal(db.listAudit().filter((row) => row.action === QUALIFY_PENDING_AUDIT_ACTION).length, 1);
  // อ่านข้อความล่าสุดไม่ได้ = ไม่ส่ง
  const broken = createQualifyAnswerPending({ db: { getCustomer: () => ({ channel_id: "default", ai_enabled: 1 }), raw: { prepare() { throw new Error("db down"); } } }, pipeline, logger: silent, now: () => clock, maxPendingAgeMs: DAY });
  assert.deepEqual(broken({ customerId: "x" }), { skipped: "db_error" });
  // ไม่ส่งเกณฑ์ (ตัวกวาด) = ไม่จำกัดอายุ เหมือนเดิม
  assert.equal(createQualifyAnswerPending({ db, pipeline, logger: silent, now: () => clock })({ customerId: "U-old" }).redispatched, true);
  db.close();
});

test("aiSwitch (รอบ 2): เปิดทับห้องเหลืองที่ข้อความค้างเก่ากว่า 24 ชม. / ทีมตอบแล้ว = ไม่ตอบย้อนหลัง (ขึ้นคิวรอตอบ) · ภายใน 24 ชม. = ตอบ", async () => {
  assert.equal(NOT_QUALIFIED_HUMAN_ON_PENDING_MAX_AGE_MS, DAY);
  const T = Date.UTC(2026, 9, 5, 5, 0, 0);
  let clock = T;
  const db = memoryDb({ now: () => clock });
  const calls = [];
  const pipeline = { handleInboundText: async (args) => { calls.push(args); return { sent: true }; } };
  yellow(db, "U-stale");
  db.insertMessage({ customerId: "U-stale", direction: "in", content: "ขอรายละเอียดหน่อยค่ะ" });
  yellow(db, "U-staff");
  db.insertMessage({ customerId: "U-staff", direction: "in", content: "ขอข้อมูลหน่อยค่ะ" });
  clock = T + HOUR;
  db.insertMessage({ customerId: "U-staff", direction: "out", content: "ทีมส่งรายละเอียดให้แล้วนะคะ", operator: "staff1" });
  clock = T + 5 * DAY;
  setCustomerAiSwitch({ db, customerId: "U-stale", enabled: true, operator: "nok", nowMs: clock, pipeline, logger: silent });
  setCustomerAiSwitch({ db, customerId: "U-staff", enabled: true, operator: "nok", nowMs: clock, pipeline, logger: silent });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0, "ข้อความเก่า 5 วัน/ทีมตอบแล้ว ไม่ตอบย้อนหลัง");
  assert.equal(db.getCustomer("U-stale").ai_enabled, 1, "การเปิด AI ยังสำเร็จ");
  assert.ok(db.getSetting(qualifyReleaseKey("U-stale")), "หมุดห้ามปิดซ้ำยังปักตามเดิม");
  assert.equal(db.listAudit().filter((row) => row.action === QUALIFY_PENDING_AUDIT_ACTION).length, 0);
  assert.ok(listWaitingRooms({ db, now: clock }).rooms.some((r) => r.id === "U-stale"), "ข้อความค้างขึ้นคิวรอตอบให้ทีม");
  // ข้อความ 23 ชม. = ยังตอบ
  yellow(db, "U-recent");
  db.insertMessage({ customerId: "U-recent", direction: "in", content: "ตอนนี้เปิดร้านกาแฟแล้วค่ะ" });
  clock += 23 * HOUR;
  setCustomerAiSwitch({ db, customerId: "U-recent", enabled: true, operator: "nok", nowMs: clock, pipeline, logger: silent });
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].customerId, "U-recent");
  db.close();
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค. (รอยต่อกับตัวกวาด): ตัวกวาดเปิดเขียวแล้วข้าม answerPending จด answerSkipped ในสถานะ —
// เทิร์นแรกของลูกค้าหลังจากนั้นต้องได้ข้อความที่พิมพ์ระหว่างเหลือง (เดิมห้องเขียวแล้วจึงไม่รวม) แล้วลบธงครั้งเดียว
test("handleNotQualifiedTurn (รอบ 2): ห้องเขียวที่มีธง answerSkipped = รวมข้อความค้างครั้งเดียวแล้วลบธง · ไม่มีธง/AI ปิดเหตุอื่น = ไม่อ่านเพิ่ม", () => {
  const T = Date.UTC(2026, 9, 5, 13, 0, 0);
  let clock = T;
  const db = memoryDb({ now: () => clock });
  const at = (ms, row) => { clock = ms; return db.insertMessage(row); };
  db.upsertCustomer("U-skip", {});
  at(T, { customerId: "U-skip", direction: "in", content: "ตกงานอยู่ค่ะ" });
  at(T + MIN, { customerId: "U-skip", direction: "out", content: "เข้าใจค่ะ", agentMode: "ai" });
  const offAt = T + 2 * MIN;
  at(T + 60 * MIN, { customerId: "U-skip", direction: "in", content: "ตอนนี้มีร้านกาแฟสองสาขาค่ะ" });
  at(T + 61 * MIN, { customerId: "U-skip", direction: "in", content: "ลูกค้าเยอะจนตอบแชทไม่ทันเลยค่ะ" });
  // ตัวกวาดเปิดเขียว (ai_enabled=1) + จดธง ตามรูปที่ qualifySweep.applyGreen เขียน (offAt ของรอบเหลือง)
  db.setSetting(qualifyStateKey("U-skip"), JSON.stringify({ verdict: "potential", category: "has_business_or_job", confidence: 0.8, mode: "on", lastInboundId: "x", at: T + 65 * MIN, offAt, [QUALIFY_ANSWER_SKIPPED_FIELD]: true }));
  const current = at(T + 20 * HOUR, { customerId: "U-skip", direction: "in", content: "ว่าไงคะ" });
  const turn = (id, msg, text) => handleNotQualifiedTurn({ db, customerId: id, customer: db.getCustomer(id), messageId: String(msg?.id ?? msg ?? ""), incoming: [text], logger: silent });
  const first = turn("U-skip", current, "ว่าไงคะ");
  assert.deepEqual(first, { yellow: false, reclaimed: true, signal: "answer_skipped", heldParts: ["ตอนนี้มีร้านกาแฟสองสาขาค่ะ", "ลูกค้าเยอะจนตอบแชทไม่ทันเลยค่ะ"] });
  const state = JSON.parse(db.getSetting(qualifyStateKey("U-skip")));
  assert.equal(state[QUALIFY_ANSWER_SKIPPED_FIELD], undefined, "ลบธงแล้ว");
  assert.equal(state.verdict, "potential", "ช่องอื่นของคำตัดสินอยู่ครบ");
  assert.equal(state.offAt, offAt);
  assert.equal(db.listAudit().filter((row) => row.action === YELLOW_HELD_AUDIT_ACTION && row.target === "U-skip").length, 1);
  // เทิร์นถัดไป = ไม่มีธงแล้ว ไม่รวมซ้ำ
  const again = at(T + 20 * HOUR + MIN, { customerId: "U-skip", direction: "in", content: "ฮัลโหล" });
  assert.deepEqual(turn("U-skip", again, "ฮัลโหล"), { yellow: false });
  // ธงอยู่แต่ทีมตอบไปแล้ว = ไม่มีข้อความค้าง → ลบธง ไม่ audit
  db.upsertCustomer("U-skip-staff", {});
  at(T + 61 * MIN, { customerId: "U-skip-staff", direction: "in", content: "มีร้านค่ะ" });
  at(T + 62 * MIN, { customerId: "U-skip-staff", direction: "out", content: "ทีมตอบให้แล้วค่ะ", operator: "staff1" });
  db.setSetting(qualifyStateKey("U-skip-staff"), JSON.stringify({ verdict: "potential", offAt, [QUALIFY_ANSWER_SKIPPED_FIELD]: true }));
  const staffTurn = at(T + 63 * MIN, { customerId: "U-skip-staff", direction: "in", content: "ขอบคุณค่ะ" });
  assert.deepEqual(turn("U-skip-staff", staffTurn, "ขอบคุณค่ะ"), { yellow: false });
  assert.equal(JSON.parse(db.getSetting(qualifyStateKey("U-skip-staff")))[QUALIFY_ANSWER_SKIPPED_FIELD], undefined);
  // ห้อง AI ปิดด้วยเหตุอื่น = ไม่อ่าน settings เลย ธงรอเทิร์นที่ตอบจริง
  db.upsertCustomer("U-skip-manual", {});
  db.setSetting(qualifyStateKey("U-skip-manual"), JSON.stringify({ verdict: "potential", offAt, [QUALIFY_ANSWER_SKIPPED_FIELD]: true }));
  db.setAiEnabled("U-skip-manual", false, "manual");
  let reads = 0;
  const spy = { getSetting: () => { reads += 1; return null; }, raw: { prepare() { reads += 1; throw new Error("ห้ามอ่าน"); } } };
  assert.deepEqual(handleNotQualifiedTurn({ db: spy, customerId: "U-skip-manual", customer: db.getCustomer("U-skip-manual"), incoming: ["x"], logger: silent }), { yellow: false });
  assert.equal(reads, 0);
  assert.equal(JSON.parse(db.getSetting(qualifyStateKey("U-skip-manual")))[QUALIFY_ANSWER_SKIPPED_FIELD], true);
  db.close();
});

/* ----------------------------------------- server ----------------------------------------- */

test("server: ตัวกวาดอยู่ใน app · /health บอกโหมดและตัวเลขรวม (ไม่มีรหัสห้อง) · ไม่ arm timer ใน createApp", async (t) => {
  const db = memoryDb();
  const app = createApp({ config: testConfig(), db, overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  assert.equal(typeof app.qualifySweep?.runDue, "function");
  assert.equal(app.qualifySweep.running, false, "createApp ไม่ start (startServer เท่านั้น)");
  const before = await httpRequest(app.server, { path: "/health" });
  assert.equal(before.json.components.qualify, "off");
  assert.equal(before.json.qualify.mode, "off");
  assert.deepEqual(Object.keys(before.json.qualify.today).sort(), ["capped", "checked", "green", "thb", "unclear", "yellow"]);
  assert.equal(before.json.qualify.inFlight, false, "รีวิวปรปักษ์รอบ 3 5 ต.ค.: runbook ก่อน rollback รอจน false");
  assert.deepEqual(await app.qualifySweep.runDue(), { skipped: "switch_off" }, "ไม่มีแถวสวิตช์ = ไม่ทำอะไรเลย");
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "shadow");
  const after = await httpRequest(app.server, { path: "/health" });
  assert.equal(after.json.components.qualify, "shadow");
  assert.ok(!JSON.stringify(after.json.qualify).includes("U"), "ตัวเลขรวมเท่านั้น");
});

function particleApp({ env = {}, reply }) {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const lineFetch = lineFetchStub();
  const hermesFetch = hermesFetchStub(reply);
  const app = createApp({ config: testConfig(env), db, overrides: { hermesFetch, lineFetch, sleep: async () => {} }, logger: silent });
  return { app, db, lineFetch };
}
const sentTexts = (lineFetch) => lineFetch.sends.flatMap((call) => (call.body?.messages || []).map((m) => m.text || ""));

test("PERSONA_PARTICLES ไม่ตั้ง = ข้อความขาออกเหมือนเดิมทุกไบต์ (ครับยังอยู่) และไม่มี audit", async () => {
  const { app, db, lineFetch } = particleApp({ reply: "ได้เลยครับ สนใจรอบไหนครับ" });
  const result = await app.pipeline.handleInboundText({ customerId: "U-p0", text: "สนใจคลาสค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.match(sentTexts(lineFetch).join("\n"), /ครับ/u);
  assert.equal(db.listAudit().filter((row) => row.action === PERSONA_PARTICLE_AUDIT_ACTION).length, 0);
  db.close();
});

test("PERSONA_PARTICLES=female: ครับ → ค่ะ/คะ ก่อนส่ง + audit ชนิด/จำนวน (ไม่มีเนื้อความ) · ค่าอื่น = ปิด", async () => {
  const { app, db, lineFetch } = particleApp({ env: { PERSONA_PARTICLES: "female" }, reply: "ได้เลยครับ สนใจรอบไหนครับ" });
  const result = await app.pipeline.handleInboundText({ customerId: "U-p1", text: "สนใจคลาสค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  const out = sentTexts(lineFetch).join("\n");
  assert.ok(!/ครับ/u.test(out), out);
  assert.match(out, /ค่ะ|คะ/u);
  const audits = db.listAudit().filter((row) => row.action === PERSONA_PARTICLE_AUDIT_ACTION);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operator, "system");
  assert.equal(audits[0].target, "U-p1");
  assert.match(audits[0].detail, /^fixes: [a-z_]+×\d/u);
  assert.ok(!/[ก-๙]/u.test(audits[0].detail), "audit ห้ามมีเนื้อความภาษาไทยของข้อความ");
  db.close();
  for (const value of ["male", "on", "true"]) {
    const off = particleApp({ env: { PERSONA_PARTICLES: value }, reply: "ได้เลยครับ" });
    assert.equal(off.app.humanizer.humanize({ customerId: "x", text: "ได้เลยครับ" }).map((b) => b.text).join(""), "ได้เลยครับ", value);
    off.db.close();
  }
});

test("personaParticleAuditDetail: นับชนิด · ชนิดแปลก = other · ไม่มีอะไร = fixes: none", () => {
  assert.equal(personaParticleAuditDetail([{ kind: "khrap", from: "ครับ", to: "ค่ะ" }, { kind: "khrap" }, { kind: "na_khrap" }], [{ kind: "male_pronoun", sample: "ผม" }]),
    "fixes: khrap×2, na_khrap×1 · residual: male_pronoun×1");
  assert.equal(personaParticleAuditDetail([{ kind: "ครับ<script>" }], null), "fixes: other×1");
  assert.equal(personaParticleAuditDetail([], []), "fixes: none");
  assert.equal(personaParticleAuditDetail(undefined, undefined), "fixes: none");
});

test("ป้าย 'รอสรุปจาก LINE OA': ห้องสีเหลืองไม่ติด (ไม่มีทีมรับช่วง) · ห้องปิดด้วยมือติดเหมือนเดิม · มีป้าย customer ยังติด", async () => {
  const { lineOaContextState } = await import("../src/lineOaContext.mjs");
  const nowMs = Date.UTC(2026, 9, 5, 5, 0, 0);
  const base = { last_inbound_at: nowMs - HOUR };
  assert.equal(lineOaContextState({ ...base, ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON }, nowMs), null);
  assert.equal(lineOaContextState({ ...base, ai_enabled: 0, ai_off_reason: "manual" }, nowMs)?.reason, "pending");
  assert.equal(lineOaContextState({ ...base, ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON, customer_tag_at: nowMs - DAY }, nowMs)?.reason, "pending");
});
