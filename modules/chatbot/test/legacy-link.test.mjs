// v1.4.48: โยงลูกค้าจริงกับห้องอ้างอิงระบบเก่า "ด้วยชื่อ" — แผน B ของ cutover (2026-08-23)
//
// ที่มา: Codex พิสูจน์บน OA จริงว่า /bot/profile ของ userId เก่า = 404 (คนละ namespace)
// การ import ด้วย id จึงไม่มีวันตรงคน ชื่อโปรไฟล์คือสิ่งเดียวที่สองฝั่งมีเหมือนกัน
// ความเสี่ยงที่ต้องล็อก: โยงผิดคน (ชื่อซ้ำ) = ป้าย/สถานะของคนอื่นไปโผล่ในห้องลูกค้า
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  confirmLegacyLink, decideLegacyLink, linkLegacyByName, normalizeDisplayName,
  rejectLegacyLink, LEGACY_SOURCE_TAG, LEGACY_LINK_TAG,
} from "../src/legacyLink.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

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

test("normalize: ช่องว่าง/ตัวพิมพ์/NFC ไม่มีผล แต่ชื่อต่างตัวอักษรเดียวไม่เท่ากัน", () => {
  assert.equal(normalizeDisplayName("  Tess   Testlast "), "tess testlast");
  assert.equal(normalizeDisplayName("คุณเอ"), normalizeDisplayName("คุณเอ "));
  assert.notEqual(normalizeDisplayName("คุณเอ"), normalizeDisplayName("คุณเอ๋"));
});

test("decide: ชื่อตรงห้องเดียว = linked / หลายห้อง = ambiguous / ไม่มี = none / ไม่มีชื่อ = no_name", () => {
  const cands = [{ line_user_id: LEGACY, display_name: "Tess" }, { line_user_id: LEGACY2, display_name: "tess " }];
  assert.equal(decideLegacyLink({ displayName: "Tess", candidates: [cands[0]] }).state, "linked");
  assert.equal(decideLegacyLink({ displayName: "Tess", candidates: cands }).state, "ambiguous");
  assert.equal(decideLegacyLink({ displayName: "Somchai", candidates: cands }).state, "none");
  assert.equal(decideLegacyLink({ displayName: "", candidates: cands }).state, "no_name");
});

// 2026-09-02 (คำสั่งเจ้าของ): candidate ไม่พัก AI อีกแล้ว ยกเว้นห้องเก่าที่บอกว่าเป็นลูกค้าจริง
// (ป้าย customer / "ลงทะเบียนแล้ว") — ดู test/legacy-candidate-not-silent.test.mjs
test("link: ชื่อตรงห้องผู้ซื้อ -> สร้าง candidate แต่ยังไม่คัดลอกป้ายเดิมจนกว่าพนักงานยืนยัน", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["ซื้อครั้งแรก", "AI Class"], buyer: true });
  const real = "U-real-tess";
  db.upsertCustomer(real, { displayName: "Tess" });
  const r = linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(r.state, "candidate");
  assert.deepEqual(db.listTags(real).map((t) => t.tag), ["customer"],
    "ป้ายเดียวที่ยอมให้เกิดคือ customer ที่ระบบติดเองเพื่อให้บอทเงียบ — ประวัติของอีกคนห้ามข้ามมา");
  let c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 0, "ห้องเก่าบอกว่าซื้อจบแล้ว บอทต้องไม่ขายซ้ำ");
  assert.equal(c.ai_off_reason, "customer_handover");
  assert.match(c.legacy_link, /^candidate:U/u);
  assert.ok(db.listHandoffNotes(real, 5).some((n) => n.text.includes("ยังไม่คัดลอกป้าย")));
  assert.equal(linkLegacyByName({ db, customerId: real, logger: silent }).state, "already", "ไม่วนซ้ำ");

  const confirmed = confirmLegacyLink({ db, customerId: real, operator: "owner" });
  assert.equal(confirmed.state, "linked");
  const tags = db.listTags(real).map((t) => t.tag);
  for (const t of ["ซื้อครั้งแรก", "AI Class", "customer", LEGACY_LINK_TAG]) assert.ok(tags.includes(t), t);
  assert.ok(!tags.includes(LEGACY_SOURCE_TAG), "ห้องจริงต้องไม่ถูกตีเป็นห้องอ้างอิง");
  c = db.getCustomer(real);
  assert.equal(c.ai_enabled, 0); assert.equal(c.ai_off_reason, "customer_handover");
  assert.match(c.legacy_link, /^linked:U/u);
  db.close();
});

test("link: ชื่อซ้ำหลายห้อง -> ไม่โยง ไม่แตะ AI แต่เขียนโน้ตให้ชมพู่โยงมือ", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Nong", tags: ["สนใจคลาส"] });
  seedLegacy(db, LEGACY2, { name: "nong", tags: ["สนใจGEN AI Classroom"] });
  const real = "U-real-nong";
  db.upsertCustomer(real, { displayName: "Nong" });
  const r = linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(r.state, "ambiguous");
  // "ไม่แตะ AI" ตามชื่อเทสต์ = ไม่แตะจริง ๆ แล้วตั้งแต่ 2026-09-02 (เดิมโค้ดปิด AI สวนชื่อตัวเอง)
  assert.equal(db.getCustomer(real).ai_enabled, 1);
  assert.equal(db.getCustomer(real).ai_off_reason, "");
  assert.ok(!db.listTags(real).some((t) => t.tag === "customer"));
  assert.match(db.getCustomer(real).legacy_link, /^ambiguous:2$/u);
  assert.ok(db.listHandoffNotes(real, 5).some((n) => n.text.includes("2 ห้อง")));
  db.close();
});

test("link: ชื่อที่ต่างกันเฉพาะ internal whitespace ต้องเห็นครบทุก candidate และห้ามเลือกผิดห้อง", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess Testlast", tags: ["สนใจคลาส"] });
  seedLegacy(db, LEGACY2, { name: "Tess   Testlast", tags: ["AI Class"] });
  const real = "U-real-space";
  db.upsertCustomer(real, { displayName: " Tess Testlast " });
  const r = linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(r.state, "ambiguous");
  assert.equal(r.candidates.length, 2);
  assert.equal(db.listTags(real).length, 0);
  db.close();
});

test("link: พนักงานปฏิเสธ candidate -> ไม่คัดลอกป้ายและคืน AI ที่ระบบพักไว้", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", buyer: true });
  const real = "U-reject";
  db.upsertCustomer(real, { displayName: "Tess" });
  assert.equal(linkLegacyByName({ db, customerId: real, logger: silent }).state, "candidate");
  assert.equal(rejectLegacyLink({ db, customerId: real, operator: "owner" }).state, "rejected");
  assert.equal(db.getCustomer(real).ai_enabled, 1);
  assert.equal(db.getCustomer(real).legacy_link, "rejected");
  assert.equal(db.listTags(real).length, 0);
  db.close();
});

test("link: ลูกค้าใหม่ชื่อไม่ตรงใคร -> none และไม่สร้างอะไรเพิ่ม", () => {
  const db = memoryDb();
  seedLegacy(db, LEGACY, { name: "Tess", buyer: true });
  db.upsertCustomer("U-new", { displayName: "Somchai" });
  assert.equal(linkLegacyByName({ db, customerId: "U-new", logger: silent }).state, "none");
  assert.equal(db.listTags("U-new").length, 0);
  assert.equal(db.getCustomer("U-new").legacy_link, "none");
  db.close();
});

// 2026-09-02: เคสเดียวกันในนโยบายใหม่อยู่ที่ test/legacy-candidate-not-silent.test.mjs
// (AI ตอบต่อพร้อมกติกาห้ามอ้างประวัติ) — เทสต์นี้เหลือไว้ล็อกส่วนที่ "ห้ามเปลี่ยน":
// ป้ายของห้องเก่าห้ามข้ามมาก่อนคนยืนยัน และ audit ต้องมีร่องรอย
test("pipeline e2e: ชื่อตรงห้องผู้ซื้อ -> candidate ยังไม่ข้ามป้ายจนกว่าคนยืนยัน", async () => {
  const config = testConfig();
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["ซื้อครั้งที่สอง"], buyer: true });
  const hermesFetch = hermesFetchStub();
  const lineFetch = lineFetchStub();
  const app = createApp({ config, db, overrides: { hermesFetch, lineFetch, sleep: async () => {} }, logger: silent });
  const real = "U-webhook-tess";
  db.upsertCustomer(real, { displayName: "Tess" }); // ชื่อจากโปรไฟล์ LINE (webhook F1)
  // F7 (ตรวจย้อนหลัง ก.ย. 2026): ข้อความแรกแบบทักทาย = ยังติดป้ายเงียบเหมือนเดิม — ถ้าเปิดด้วยคำถามแบบ
  // ลีดใหม่ ("สนใจคลาสใหม่") บอทคุยต่อแบบลูกค้าใหม่ + ให้คนยืนยัน (test/legacy-registered-autotag.test.mjs)
  const result = await app.pipeline.handleInboundText({ customerId: real, text: "สวัสดีค่ะ", replyToken: "rt" });
  assert.notEqual(result?.sent, true, "ห้องเก่าบอกว่าเป็นผู้ซื้อแล้ว — บอทต้องเงียบให้ทีมงานคุย");
  assert.equal(hermesFetch.calls.length, 0);
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(db.getCustomer(real).ai_off_reason, "customer_handover");
  assert.deepEqual(db.listTags(real).map((t) => t.tag), ["customer"], "ป้ายประวัติของอีกคนยังห้ามข้ามมา");
  assert.ok(db.listAudit().some((a) => a.action === "legacy_link_candidate_by_name"));
  assert.equal(confirmLegacyLink({ db, customerId: real, operator: "owner" }).state, "linked");
  assert.ok(db.listTags(real).some((t) => t.tag === "ซื้อครั้งที่สอง"));
  db.close();
});

test("pipeline e2e: ลูกค้าใหม่ชื่อไม่ตรงใคร -> ตอบปกติ", async () => {
  const config = testConfig();
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  seedLegacy(db, LEGACY, { name: "Tess", buyer: true });
  const hermesFetch = hermesFetchStub();
  const lineFetch = lineFetchStub();
  const app = createApp({ config, db, overrides: { hermesFetch, lineFetch, sleep: async () => {} }, logger: silent });
  db.upsertCustomer("U-fresh", { displayName: "Somchai" });
  const result = await app.pipeline.handleInboundText({ customerId: "U-fresh", text: "สนใจคลาส AI ครับ", replyToken: "rt" });
  assert.equal(result?.sent, true);
  assert.equal(lineFetch.sends.length, 1);
  assert.equal(db.getCustomer("U-fresh").legacy_link, "none");
  db.close();
});

// ---- 2026-08-24: เส้นโยงมือ (ambiguous/none/rejected) — คนตัดสิน, server ตรวจซ้ำทุกชั้น ----
import { manualLegacyLink } from "../src/legacyLink.mjs";

test("manual link: ambiguous -> โยงมือได้ คัดลอกป้าย เปิด AI คืน และห้องเก่าห้ามถูกโยงซ้ำ", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedLegacy(db, LEGACY, { name: "Tess", tags: ["ซื้อครั้งแรก"] });
  seedLegacy(db, LEGACY2, { name: "tess " });
  const real = "U-real-manual";
  db.upsertCustomer(real, { displayName: "Tess" });
  const decision = linkLegacyByName({ db, customerId: real, logger: silent });
  assert.equal(decision.state, "ambiguous");
  assert.equal(db.getCustomer(real).ai_enabled, 1, "รอโยงมือ = ยังคุยกับลูกค้าต่อได้");

  const linked = manualLegacyLink({ db, customerId: real, legacyId: LEGACY, operator: "chompoo" });
  assert.equal(linked.state, "linked");
  assert.ok(db.listTags(real).some((row) => row.tag === "ซื้อครั้งแรก"), "คัดลอกป้ายจากห้องเก่า");
  assert.ok(db.listTags(real).some((row) => row.tag === LEGACY_LINK_TAG));
  const c = db.getCustomer(real);
  assert.equal(c.legacy_link, `linked:${LEGACY}`);
  assert.equal(c.ai_enabled, 1, "โยงมือเสร็จแล้ว AI ต้องยังคุยต่อได้");
  assert.ok(db.listHandoffNotes(real, 5).some((n) => n.text.includes("โยงมือ") && n.author === "chompoo"));

  // ห้องเก่าเดียวกันถูกลูกค้าอีกคนโยงซ้ำไม่ได้
  const real2 = "U-real-manual-2";
  db.upsertCustomer(real2, { displayName: "Tess" });
  assert.equal(manualLegacyLink({ db, customerId: real2, legacyId: LEGACY, operator: "chompoo" }).state, "legacy_taken");
  // แต่โยงอีกห้องที่ยังว่างได้
  assert.equal(manualLegacyLink({ db, customerId: real2, legacyId: LEGACY2, operator: "chompoo" }).state, "linked");
});

test("manual link: ปลายทางไม่ใช่ห้องอ้างอิง/ตัวเอง = ปฏิเสธ · ต้นทาง linked แล้ว = already_linked", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  seedLegacy(db, LEGACY, { name: "Tess" });
  const real = "U-real-guard";
  db.upsertCustomer(real, { displayName: "ใครก็ได้" });
  const notLegacy = "U-real-other";
  db.upsertCustomer(notLegacy, { displayName: "คนจริงอีกคน" });
  assert.equal(manualLegacyLink({ db, customerId: real, legacyId: notLegacy }).state, "not_reference");
  assert.equal(manualLegacyLink({ db, customerId: real, legacyId: "U-missing" }).state, "not_reference");
  assert.equal(manualLegacyLink({ db, customerId: real, legacyId: real }).state, "not_reference");
  assert.equal(manualLegacyLink({ db, customerId: real, legacyId: LEGACY }).state, "linked");
  assert.equal(manualLegacyLink({ db, customerId: real, legacyId: LEGACY }).state, "already_linked", "แก้ลิงก์เดิมต้องทำมือฝั่งระบบ");
});

test("legacy source tag: ถอดผ่าน removeTag ตรง ๆ ยังได้ (ชั้นล็อกอยู่ที่ API) — กติกาอยู่ใน consoleApi", (t) => {
  // เอกสารพฤติกรรม: ชั้น DB ไม่ล็อก (script ฝั่งระบบต้องแก้ได้) — API เป็นด่านของ operator
  const db = memoryDb();
  t.after(() => db.close());
  seedLegacy(db, LEGACY, { name: "Tess" });
  db.removeTag(LEGACY, LEGACY_SOURCE_TAG);
  assert.ok(!db.listTags(LEGACY).some((r) => r.tag === LEGACY_SOURCE_TAG));
});
