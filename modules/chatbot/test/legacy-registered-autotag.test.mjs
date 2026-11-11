// F7 (ตรวจย้อนหลัง ก.ย. 2026): ป้าย customer อัตโนมัติจาก "ชื่อ LINE ตรงนักเรียนเก่า" — 12 เคสผิด
//
// ของจริง: ลีดใหม่ที่ชื่อเล่นตรงกับนักเรียนเก่า (4 ใน 6 ห้องที่ผิดเป็นชื่อตรงหลายห้อง) ถูกติดป้าย customer
// แล้วบอทเงียบถาวร · สองห้องไม่เคยได้คำตอบเลย ("สนใจ คอนซัล") · ผู้เข้าร่วม #bootcamp 8 คนถูกปิดใน
// นาทีเดียว · และชมพู่กดเปิด AI คืนสามครั้งในห้องเดียว ป้ายก็ปิดห้องกลับทุกครั้ง
// ข้อความและชื่อในไฟล์นี้เป็นของสังเคราะห์ทั้งหมด
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  linkLegacyByName, LEGACY_SOURCE_TAG, LEGACY_REGISTERED_TAGS, LEGACY_AUTO_CUSTOMER_NOTE,
} from "../src/legacyLink.mjs";
import { legacyIdentityPending } from "../src/aiPausePolicy.mjs";
import { hashPassword } from "../src/auth.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const LEGACY = "U" + "c".repeat(32);
const LEGACY2 = "U" + "d".repeat(32);

function seedLegacy(db, id, { name, registered = false, tags = [] }) {
  db.upsertCustomer(id, { displayName: name });
  db.addTag(id, LEGACY_SOURCE_TAG, "human");
  if (registered) db.addTag(id, LEGACY_REGISTERED_TAGS[0], "human");
  for (const tag of tags) db.addTag(id, tag, "human");
}
const hasCustomerTag = (db, id) => db.listTags(id).some((row) => row.tag === "customer");

function makeApp(db, config = {}) {
  const notices = [];
  const hermesFetch = hermesFetchStub("ยินดีค่ะ เดี๋ยวลูกแพรเล่ารายละเอียดให้นะคะ");
  const line = lineFetchStub();
  const app = createApp({
    db, logger: silent, config: testConfig(config),
    overrides: { notifier: { fireLater: (n) => notices.push(n) }, hermesFetch, lineFetch: line, sleep: async () => {} },
  });
  return { app, notices, hermesFetch, line };
}

test("F7 ข้อ 1: ชื่อตรงหลายห้อง (กำกวม) แม้มีห้องที่ลงทะเบียนแล้ว = ห้ามติดป้าย AI คุยต่อ + แจ้งทีมเทียบ", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedLegacy(db, LEGACY, { name: "ปลา", registered: true });
  seedLegacy(db, LEGACY2, { name: "ปลา" });
  const { app, notices, hermesFetch } = makeApp(db);
  const real = "U-new-pla";
  db.upsertCustomer(real, { displayName: "ปลา" });
  const result = await app.pipeline.handleInboundText({ customerId: real, text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
  const row = db.getCustomer(real);
  assert.equal(result.sent, true, "ลีดใหม่ต้องได้คำตอบ ไม่ใช่ความเงียบ");
  assert.equal(row.ai_enabled, 1);
  assert.equal(hasCustomerTag(db, real), false);
  assert.match(row.legacy_link, /^ambiguous:2$/u);
  assert.equal(legacyIdentityPending(row), true, "ยังห้ามอ้างประวัติระบบเก่าจนกว่าคนเทียบ");
  assert.equal(notices.filter((n) => n.reason === "legacy_candidate").length, 1);
  assert.equal(notices.filter((n) => n.reason === "legacy_registered_customer").length, 0);
  assert.ok(hermesFetch.calls.length >= 1);
});

test("F7 ข้อ 2: ชื่อตรงห้องเดียวที่ลงทะเบียนแล้ว + ข้อความแรกเป็นคีย์เวิร์ด/ทักทาย = ติดป้ายเงียบเหมือนเดิม", () => {
  for (const [label, texts] of [["hashtag", ["#make"]], ["greeting", ["สวัสดีค่ะ"]], ["no texts (caller without context)", []]]) {
    const db = memoryDb();
    seedLegacy(db, LEGACY, { name: "ปลา", registered: true });
    const real = `U-returning-${label}`;
    db.upsertCustomer(real, { displayName: "ปลา" });
    const fired = [];
    const r = linkLegacyByName({ db, customerId: real, logger: silent, notifier: { fireLater: (n) => fired.push(n) }, inboundTexts: texts });
    assert.equal(r.existingCustomer, true, label);
    assert.equal(hasCustomerTag(db, real), true, label);
    assert.equal(db.getCustomer(real).ai_off_reason, "customer_handover", label);
    assert.equal(fired[0]?.reason, "legacy_registered_customer", label);
    db.close();
  }
});

test("F7 ข้อ 2: ชื่อตรงห้องเดียวที่ลงทะเบียนแล้ว แต่ข้อความแรกถามแบบลีดใหม่ = AI คุยต่อ + ให้คนยืนยัน", () => {
  for (const text of ["ขอรายละเอียดการเรียนครับ", "สนใจ คอนซัล", "3", "Stage 3 ครับ", "ยังไม่เคยใช้ AI เลยค่ะ"]) {
    const db = memoryDb();
    seedLegacy(db, LEGACY, { name: "ปลา", registered: true });
    const real = "U-new-lead-same-name";
    db.upsertCustomer(real, { displayName: "ปลา" });
    const fired = [];
    const r = linkLegacyByName({ db, customerId: real, logger: silent, notifier: { fireLater: (n) => fired.push(n) }, inboundTexts: [text] });
    const row = db.getCustomer(real);
    assert.equal(r.state, "candidate", text);
    assert.equal(hasCustomerTag(db, real), false, `${text}: ห้ามติดป้ายเงียบใส่ลีดใหม่`);
    assert.equal(row.ai_enabled, 1, text);
    assert.equal(legacyIdentityPending(row), true, `${text}: ยังห้ามอ้างประวัติจนกว่าคนยืนยัน`);
    assert.equal(fired.length, 1, text);
    assert.equal(fired[0].reason, "legacy_registered_customer", text);
    assert.doesNotMatch(fired[0].reasonTextOverride || "", /ปิด AI ให้แล้ว/u, `${text}: ข้อความแจ้งทีมต้องไม่อ้างว่าปิด AI แล้ว`);
    assert.match(fired[0].reasonTextOverride || "", /คุยต่อ/u, text);
    db.close();
  }
});

test("F7 ข้อ 3: คนกดเปิด AI คืนในห้องที่ระบบติดป้ายให้ = ถอนป้ายของระบบ แล้วข้อความถัดไปได้คำตอบ", async (t) => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "ปลา", registered: true });
  db.createOperator({ username: "chom", passHash: hashPassword("operator-pass-123"), displayName: "ชมพู่" });
  const { app, hermesFetch, line } = makeApp(db, { CONSOLE_SESSION_SECRET: "test-console-secret-0123456789" });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const real = "U-autotag-reopen";
  db.upsertCustomer(real, { displayName: "ปลา" });
  // (คีย์เวิร์ด # ถูก auto-response ของ OA ตอบเองจึงไม่ถึงไปป์ไลน์ — ใช้คำทักทายแทน)
  await app.pipeline.handleInboundText({ customerId: real, text: "สวัสดีค่ะ", replyToken: "rt-1" });
  assert.equal(hasCustomerTag(db, real), true, "ห้องนี้ถูกติดป้ายอัตโนมัติ");
  assert.ok(db.listHandoffNotes(real, 20).some((n) => n.text === LEGACY_AUTO_CUSTOMER_NOTE));

  const post = (path, body, headers = {}) => httpRequest(app.server, {
    method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const auth = await post("/console/api/login", { username: "chom", password: "operator-pass-123" });
  const head = { cookie: (auth.headers["set-cookie"]?.[0] || "").split(";")[0], "x-csrf-token": auth.json.csrf };
  const on = await post(`/console/api/customers/${real}/ai`, { enabled: true }, head);
  assert.equal(on.status, 200);
  assert.equal(hasCustomerTag(db, real), false, "ป้ายที่ระบบติดต้องถูกถอนเมื่อคนเปิด AI คืน");

  const before = hermesFetch.calls.length;
  const next = await app.pipeline.handleInboundText({ customerId: real, text: "คลาสถัดไปเรียนวันไหนคะ", replyToken: "rt-2" });
  assert.equal(next.sent, true, "ห้องต้องไม่ถูกปิดซ้ำด้วยป้ายเดิม");
  assert.equal(db.getCustomer(real).ai_enabled, 1);
  assert.ok(hermesFetch.calls.length >= before + 1, "ลูกแพรต้องได้คิดคำตอบ (scorer อาจเรียกต่ออีกหนึ่งครั้ง)");
  assert.ok(line.sends.length >= 1);
});

test("F7 ข้อ 3: ป้าย customer ที่คนติดเอง = เปิด AI คืนก็ไม่ถอน (พฤติกรรมเดิมของป้ายคน)", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "chom", passHash: hashPassword("operator-pass-123"), displayName: "ชมพู่" });
  const { app } = makeApp(db, { CONSOLE_SESSION_SECRET: "test-console-secret-0123456789" });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const real = "U-human-customer-tag";
  db.upsertCustomer(real, { displayName: "ต้น" });
  db.addTag(real, "customer", "human");
  db.setAiEnabled(real, false, "customer_handover");
  const post = (path, body, headers = {}) => httpRequest(app.server, {
    method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const auth = await post("/console/api/login", { username: "chom", password: "operator-pass-123" });
  const head = { cookie: (auth.headers["set-cookie"]?.[0] || "").split(";")[0], "x-csrf-token": auth.json.csrf };
  await post(`/console/api/customers/${real}/ai`, { enabled: true }, head);
  assert.equal(hasCustomerTag(db, real), true, "ป้ายที่คนติดห้ามแตะ");
});
