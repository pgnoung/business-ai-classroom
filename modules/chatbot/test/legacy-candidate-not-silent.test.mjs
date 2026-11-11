// legacy candidate ต้องไม่เงียบ — คำสั่งเจ้าของ 2026-09-02
//
// ของจริงที่พัง: ชื่อโปรไฟล์ตรงกับห้องระบบเก่าหนึ่งห้อง ระบบเลยปิด AI ไว้รอคนกดยืนยัน
// ลูกค้า 11 คนจึงนั่งรอ 3–4.5 ชั่วโมงโดยไม่มีใครตอบ และตอนกดยืนยันระบบก็แค่เปิด AI คืน
// ไม่ได้ตอบข้อความที่ค้างอยู่ให้ด้วย
//
// นโยบายใหม่: ยังไม่ยืนยันตัวตน = คุยต่อได้ "แบบลูกค้าใหม่" (ห้ามอ้างประวัติของอีกคน)
// + แจ้งทีมหนึ่งครั้ง + ตอนยืนยันแล้วถ้ามีข้อความค้างต้องได้คำตอบ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  confirmLegacyLink, linkLegacyByName, rejectLegacyLink, manualLegacyLink,
  LEGACY_SOURCE_TAG, LEGACY_REGISTERED_TAGS, LEGACY_AUTO_CUSTOMER_NOTE, LEGACY_AUTO_CUSTOMER_AUDIT,
} from "../src/legacyLink.mjs";
import { LEGACY_PENDING_RULE, legacyIdentityPending, answerPendingInbound } from "../src/aiPausePolicy.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, waitFor } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const LEGACY = "U" + "a".repeat(32);
const LEGACY2 = "U" + "b".repeat(32);

function seedLegacy(db, id, { name, tags = [], buyer = false }) {
  db.upsertCustomer(id, { displayName: name });
  db.addTag(id, LEGACY_SOURCE_TAG, "human");
  for (const t of tags) db.addTag(id, t, "human");
  if (buyer) { db.addTag(id, "customer", "human"); db.setAiEnabled(id, false, "customer_handover"); }
  db.raw.prepare("UPDATE customers SET followup_enabled = 0 WHERE line_user_id = ?").run(id);
}

function makeApp(db, { hermesFetch, lineFetch } = {}) {
  const config = testConfig();
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetch ?? lineFetchStub();
  return {
    app: createApp({ config, db, overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} }, logger: silent }),
    hermesFetch: hermes, lineFetch: line,
  };
}

/* ------------------------- candidate: AI ต้องยังคุยต่อ ------------------------- */

test("candidate: ชื่อตรงหนึ่งห้อง -> ยังตั้ง candidate ไว้ แต่ห้ามปิด AI", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["ซื้อครั้งแรก"] }); // ไม่มีป้ายลูกค้า = ยังไม่ใช่ลูกค้าจริง
  const real = "U-real-tess";
  db.upsertCustomer(real, { displayName: "Tess" });
  const r = linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(r.state, "candidate");
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 1, "ลูกค้าห้ามถูกทิ้งให้เงียบระหว่างรอคนยืนยัน");
  assert.equal(c.ai_off_reason, "");
  assert.match(c.legacy_link, /^candidate:U/u, "สถานะรอยืนยันยังต้องถูกบันทึก");
  assert.deepEqual(db.listTags(real), [], "ชื่ออย่างเดียวยังห้ามพาข้อมูลอีกคนข้ามมา");
  assert.equal(legacyIdentityPending(c), true);
  db.close();
});

test("candidate: ชื่อซ้ำหลายห้อง (ambiguous) -> ก็ห้ามปิด AI เช่นกัน", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Nong", tags: ["สนใจคลาส"] });
  seedLegacy(db, LEGACY2, { name: "nong", tags: ["สนใจGEN AI Classroom"] });
  const real = "U-real-nong";
  db.upsertCustomer(real, { displayName: "Nong" });
  assert.equal(linkLegacyByName({ db, customerId: real, logger: silent }).state, "ambiguous");
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 1);
  assert.match(c.legacy_link, /^ambiguous:2$/u);
  assert.equal(legacyIdentityPending(c), true);
  db.close();
});

test("candidate: แจ้งทีมหนึ่งครั้ง (ไม่ใช่ปล่อยให้ห้องเงียบโดยไม่มีใครรู้)", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess" });
  const real = "U-notify";
  db.upsertCustomer(real, { displayName: "Tess" });
  const fired = [];
  linkLegacyByName({
    db, customerId: real, logger: silent,
    notifier: { fireLater: (payload) => fired.push(payload) },
  });
  assert.equal(fired.length, 1, "ต้องปลุกทีมหนึ่งครั้ง");
  assert.equal(fired[0].reason, "legacy_candidate");
  assert.equal(fired[0].customerId, real);
  db.close();
});

test("candidate: pipeline e2e -> ตอบลูกค้าจริง และแทรกกติกาห้ามอ้างประวัติระบบเก่า", async () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["ซื้อครั้งที่สอง"] });
  const { app, hermesFetch, lineFetch } = makeApp(db);
  const real = "U-webhook-tess2";
  db.upsertCustomer(real, { displayName: "Tess" });
  const result = await app.pipeline.handleInboundText({ customerId: real, text: "สวัสดีค่ะ สนใจคลาสใหม่", replyToken: "rt" });

  assert.equal(result.sent, true, "ลูกค้าต้องได้คำตอบ ไม่ใช่ความเงียบ 4 ชั่วโมง");
  assert.equal(lineFetch.sends.length, 1);
  assert.equal(hermesFetch.calls.length, 1);
  const prompt = JSON.stringify(hermesFetch.calls[0].body);
  assert.ok(prompt.includes(LEGACY_PENDING_RULE), "ต้องมีกติกาห้ามอ้างประวัติระบบเก่าในเทิร์นนี้");
  assert.equal(db.listTags(real).length, 0, "ยังห้ามคัดลอกป้ายจนกว่าคนยืนยัน");
  assert.ok(db.listAudit().some((a) => a.action === "legacy_link_candidate_by_name"));
  db.close();
});

test("candidate: ห้องที่ไม่ได้รอยืนยัน ต้องไม่มีกติกานี้ปนใน prompt", async () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", buyer: true });
  const { app, hermesFetch } = makeApp(db);
  db.upsertCustomer("U-fresh2", { displayName: "Somchai" });
  await app.pipeline.handleInboundText({ customerId: "U-fresh2", text: "สนใจคลาส AI ครับ", replyToken: "rt" });
  const prompt = JSON.stringify(hermesFetch.calls[0].body);
  assert.ok(!prompt.includes(LEGACY_PENDING_RULE), "กติกานี้ต้องแทรกเฉพาะห้องที่รอยืนยันเท่านั้น");
  db.close();
});

/* --------------------- ยืนยันแล้ว: ข้อความค้างต้องได้คำตอบ --------------------- */

test("confirm: ผู้ซื้อเก่า -> ยังปิด AI ให้ทีมดูแลเหมือนเดิม (เคสนี้ห้ามเปลี่ยน)", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["ซื้อครั้งแรก"], buyer: true });
  const real = "U-confirm-buyer";
  db.upsertCustomer(real, { displayName: "Tess" });
  linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(confirmLegacyLink({ db, customerId: real, operator: "owner" }).state, "linked");
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 0);
  assert.equal(c.ai_off_reason, "customer_handover");
  assert.ok(db.listTags(real).some((t) => t.tag === "ซื้อครั้งแรก"));
  db.close();
});

test("confirm/reject/manual: ห้องที่ไม่ใช่ผู้ซื้อเก่า -> AI ยังเปิด และเลิกรอยืนยันแล้ว", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["สนใจคลาส"] });
  const real = "U-confirm-lead";
  db.upsertCustomer(real, { displayName: "Tess" });
  linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(confirmLegacyLink({ db, customerId: real, operator: "owner" }).state, "linked");
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 1);
  assert.equal(legacyIdentityPending(c), false, "ยืนยันแล้วต้องถอดกติกา 'ห้ามอ้างประวัติ' ออก");

  const rejected = "U-reject-lead";
  db.upsertCustomer(rejected, { displayName: "Tess" });
  linkLegacyByName({ db, customerId: rejected, logger: silent });
  assert.equal(rejectLegacyLink({ db, customerId: rejected, operator: "owner" }).state, "rejected");
  assert.equal(db.getCustomer(rejected).ai_enabled, 1);
  assert.equal(legacyIdentityPending(db.getCustomer(rejected)), false);
  db.close();
});

test("manual link: ห้อง ambiguous ที่ทีมโยงมือ -> AI ยังเปิดและเลิกรอยืนยัน", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["ซื้อครั้งแรก"] });
  seedLegacy(db, LEGACY2, { name: "tess " });
  const real = "U-manual-lead";
  db.upsertCustomer(real, { displayName: "Tess" });
  assert.equal(linkLegacyByName({ db, customerId: real, logger: silent }).state, "ambiguous");
  assert.equal(manualLegacyLink({ db, customerId: real, legacyId: LEGACY, operator: "chompoo" }).state, "linked");
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 1);
  assert.equal(legacyIdentityPending(c), false);
  db.close();
});

// ห้องที่ค้างมาจากก่อน deploy: AI ถูกปิดไว้ ข้อความลูกค้าถูกกลืน ตอนคนกดยืนยัน
// ระบบต้องตอบข้อความที่ค้างให้ ไม่ใช่แค่เปิดสวิตช์แล้วรอให้ลูกค้าพิมพ์ใหม่
test("ข้อความค้าง: ยืนยันแล้วต้องตอบข้อความสุดท้ายของลูกค้าด้วย push", async () => {
  const db = memoryDb();
  const { app, lineFetch } = makeApp(db);
  const stuck = "U-stuck";
  db.upsertCustomer(stuck, { displayName: "Tess" });
  db.insertMessage({ customerId: stuck, direction: "in", msgType: "text", content: "รอบหน้าเรียนวันไหนคะ" });
  const sends = lineFetch.sends.length;

  const outcome = answerPendingInbound({ db, pipeline: app.pipeline, customerId: stuck, logger: silent });
  assert.equal(outcome.redispatched, true, "ต้องเอาข้อความที่ค้างวิ่งเข้าเส้นทางตอบเดิม");
  await waitFor(() => lineFetch.sends.length > sends, { timeout: 5000 });
  assert.ok(lineFetch.sends.at(-1).url.endsWith("/v2/bot/message/push"), "reply token หมดอายุแล้ว ต้องส่งแบบ push");
  db.close();
});

test("ข้อความค้าง: ตอบไปแล้ว/AI ปิดอยู่ -> ห้ามยิงซ้ำ", async () => {
  const db = memoryDb();
  const { app, lineFetch } = makeApp(db);
  const answered = "U-answered";
  db.upsertCustomer(answered, {});
  db.insertMessage({ customerId: answered, direction: "in", msgType: "text", content: "ราคาเท่าไหร่คะ" });
  db.insertMessage({ customerId: answered, direction: "out", msgType: "text", content: "2,500 บาทค่ะ" });
  const before = lineFetch.sends.length;
  assert.equal(answerPendingInbound({ db, pipeline: app.pipeline, customerId: answered, logger: silent }).skipped, "no_pending");

  const off = "U-off";
  db.upsertCustomer(off, {});
  db.insertMessage({ customerId: off, direction: "in", msgType: "text", content: "โอนแล้วค่ะ" });
  db.setAiEnabled(off, false, "money_line");
  assert.equal(answerPendingInbound({ db, pipeline: app.pipeline, customerId: off, logger: silent }).skipped, "ai_off");

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lineFetch.sends.length, before, "ห้ามมีข้อความหลุดออกไปเลย");
  db.close();
});

/* ---- ห้องระบบเก่าที่ "ลงทะเบียนแล้ว" = ลูกค้าจริง ต้องเงียบ (สเปครอบสอง 2026-09-02) ---- */
//
// ต่างจากเคสด้านบนตรงหลักฐาน: ที่นั่นมีแค่ชื่อตรงกัน ที่นี่ห้องเก่าบอกเองว่าคนนี้ซื้อจบแล้ว
// การให้บอทเดินหน้าขายต่อจึงแย่กว่าการรอทีมงาน — ปิดบอทและติดป้าย customer ให้เลย

test("registered: candidate ที่ห้องเก่ามีป้าย 'ลงทะเบียนแล้ว' -> ติดป้าย customer + ปิด AI", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: [LEGACY_REGISTERED_TAGS[0]] });
  const real = "U-registered";
  db.upsertCustomer(real, { displayName: "Tess" });
  const fired = [];
  const r = linkLegacyByName({
    db, customerId: real, logger: silent, notifier: { fireLater: (p) => fired.push(p) },
  });
  assert.equal(r.state, "candidate");
  assert.equal(r.existingCustomer, true);
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 0, "ลูกค้าที่ลงทะเบียนแล้ว บอทต้องไม่ขายซ้ำ");
  assert.equal(c.ai_off_reason, "customer_handover");
  assert.ok(db.listTags(real).some((t) => t.tag === "customer"), "ต้องติดป้าย customer ให้ทีมเห็น");
  assert.ok(db.listHandoffNotes(real, 20).some((n) => n.text === LEGACY_AUTO_CUSTOMER_NOTE));
  assert.ok(db.listAudit().some((a) => a.action === LEGACY_AUTO_CUSTOMER_AUDIT && a.target === real));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, "legacy_registered_customer");
  assert.match(c.legacy_link, /^candidate:U/u, "ยังต้องรอคนยืนยันการโยงอยู่ดี");
  db.close();
});

test("registered: ห้องเก่าที่มีป้าย customer อยู่แล้วก็นับเป็นลูกค้าจริงเหมือนกัน", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", buyer: true }); // buyer = ป้าย customer
  const real = "U-registered-buyer";
  db.upsertCustomer(real, { displayName: "Tess" });
  assert.equal(linkLegacyByName({ db, customerId: real, logger: silent }).existingCustomer, true);
  assert.equal(db.getCustomer(real).ai_off_reason, "customer_handover");
  db.close();
});

// F7 ข้อ 1 (ตรวจย้อนหลัง ก.ย. 2026): เดิมห้องกำกวมที่มีห้องหนึ่งลงทะเบียนแล้วถูก "เงียบไว้ก่อน" ผลจริงคือ
// ลีดใหม่ชื่อเล่นซ้ำนักเรียนเก่าไม่ได้คำตอบ 27–72 ชม. (7 เคสผิด) — ตอนนี้ไม่ติดป้าย AI คุยแบบลูกค้าใหม่
test("registered: ambiguous ที่มีห้องใดห้องหนึ่งลงทะเบียนแล้ว -> ไม่ติดป้าย AI คุยต่อ รอทีมเทียบ", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Nong", tags: ["สนใจคลาส"] });
  seedLegacy(db, LEGACY2, { name: "nong", tags: [LEGACY_REGISTERED_TAGS[0]] });
  const real = "U-ambig-registered";
  db.upsertCustomer(real, { displayName: "Nong" });
  const fired = [];
  const r = linkLegacyByName({ db, customerId: real, logger: silent, notifier: { fireLater: (p) => fired.push(p) } });
  assert.equal(r.state, "ambiguous");
  assert.equal(r.existingCustomer, true);
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 1);
  assert.ok(!db.listTags(real).some((t) => t.tag === "customer"));
  assert.equal(legacyIdentityPending(c), true);
  assert.deepEqual(fired.map((p) => p.reason), ["legacy_candidate"]);
  db.close();
});

test("registered: 'พร้อมลงทะเบียน' ไม่ใช่ลูกค้า -> AI ยังคุยต่อตามนโยบายไม่เงียบ", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["พร้อมลงทะเบียน"] });
  const real = "U-ready-only";
  db.upsertCustomer(real, { displayName: "Tess" });
  const r = linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(r.existingCustomer, false, "เทียบป้ายต้องเป็นแบบเท่ากันเป๊ะ ไม่ใช่ 'มีคำนี้อยู่ข้างใน'");
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 1);
  assert.ok(!db.listTags(real).some((t) => t.tag === "customer"));
  assert.equal(legacyIdentityPending(c), true);
  db.close();
});

test("registered: ปฏิเสธ candidate -> ถอนป้ายที่ระบบติดให้ และเปิด AI คืน", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: [LEGACY_REGISTERED_TAGS[0]] });
  const real = "U-registered-reject";
  db.upsertCustomer(real, { displayName: "Tess" });
  linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(db.getCustomer(real).ai_enabled, 0);

  assert.equal(rejectLegacyLink({ db, customerId: real, operator: "chompoo" }).state, "rejected");
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 1, "ตรวจแล้วไม่ใช่คนเดียวกัน = ต้องกลับมาคุยกับลูกค้าได้");
  assert.ok(!db.listTags(real).some((t) => t.tag === "customer"), "ป้ายที่ระบบติดต้องถูกถอน");
  db.close();
});

test("registered: ป้าย customer ที่คนติดเอง -> ปฏิเสธ candidate แล้วห้ามถอน และ AI ต้องปิดต่อ", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: [LEGACY_REGISTERED_TAGS[0]] });
  const real = "U-human-tagged";
  db.upsertCustomer(real, { displayName: "Tess" });
  db.addTag(real, "customer", "human");          // ทีมงานตัดสินเองก่อนระบบจะเห็น
  db.setAiEnabled(real, false, "customer_handover");
  linkLegacyByName({ db, customerId: real, logger: silent });

  assert.equal(rejectLegacyLink({ db, customerId: real, operator: "chompoo" }).state, "rejected");
  const c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 0, "คนตัดสินว่าเป็นลูกค้าแล้ว ระบบห้ามเปิด AI สวน");
  assert.ok(db.listTags(real).some((t) => t.tag === "customer"), "ป้ายที่คนติดห้ามถูกถอน");
  db.close();
});

test("registered: ต้องเงียบจริงในเส้นทาง pipeline ไม่ใช่แค่ในตาราง", async () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: [LEGACY_REGISTERED_TAGS[0]] });
  const { app, hermesFetch, lineFetch } = makeApp(db);
  const real = "U-registered-e2e";
  db.upsertCustomer(real, { displayName: "Tess" });
  const result = await app.pipeline.handleInboundText({ customerId: real, text: "สวัสดีค่ะ", replyToken: "rt" });
  assert.notEqual(result?.sent, true);
  assert.equal(hermesFetch.calls.length, 0, "ห้ามเสียเงินคิดให้ห้องที่ต้องเงียบ");
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(db.getCustomer(real).ai_off_reason, "customer_handover");
  db.close();
});
