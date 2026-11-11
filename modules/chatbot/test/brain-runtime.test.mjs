// brain-runtime.test.mjs — พฤติกรรมของทางอ่านสมอง (เฟส 2) นอกเหนือจากด่าน parity
//
// ครอบเรื่องที่ "ถ้าไม่มีเทสต์ก็ไม่มีใครรู้ว่าพัง":
//   1. ด่านตอนบูต — ตั้งค่าผิดต้องไม่ขึ้น แต่ "ข้อมูลยังไม่พร้อม" ต้องขึ้นแล้ววิ่งทางเดิม
//   2. ฝั่ง canary ผูกกับ customer_id ล้วน — ห้องเดียวกันห้ามสลับฝั่งกลางบทสนทนา
//   3. อ่านไม่ได้ = ตกทางเดิม + นับแยกรายฝั่ง + ปลุกซ้ำได้เมื่อยังไม่หาย + ล้างธงเมื่อหาย
//   4. code_contract ไม่รองรับ = ถอยไปรุ่นที่โหลดได้ จำคำตอบ ดังครั้งเดียว
//   5. สมองไม่ตรงตารางจริง = หยุดเสิร์ฟสมอง (ไม่ใช่เสิร์ฟของล้าสมัย)
//   6. การ์ดที่หมดอายุหลุดจากชุดตัวเลขของ guard ตั้งแต่ตอน resolve
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, BRAIN_CODE_CONTRACT } from "../src/brain/import.mjs";
import { assertBrainReadConfig, createBrainRuntime, customerBucket, inCanaryCohort } from "../src/brain/runtime.mjs";
import { canaryKindConflicts } from "../src/brain/canary.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const CLOCK = 1_700_000_000_000;
const VERSIONED = { brainRead: "versioned", knowledgeVersioned: true };

function seedMinimal(db) {
  db.addKnowledge({ title: "วิธีสมัคร", content: "ทักแชทแล้วทีมงานส่งลิงก์ให้ค่ะ", updatedBy: "owner" });
  db.setApprovedPrice("คลาสหลัก", 19900);
}

function seededDb() {
  const db = memoryDb({ now: () => CLOCK });
  seedMinimal(db);
  return db;
}

/* -------------------------------- ด่านตอนบูต -------------------------------- */

test("ตั้งค่าผิด (versioned โดยไม่มี KNOWLEDGE_VERSIONED) = fatal — แก้ได้ที่ไฟล์ env เท่านั้น", () => {
  assert.throws(
    () => assertBrainReadConfig({ config: { brainRead: "versioned", knowledgeVersioned: false } }),
    /KNOWLEDGE_VERSIONED/u,
  );
  assert.deepEqual(assertBrainReadConfig({ config: {} }), { ok: true, reason: "legacy" });
});

test("ยังไม่มีรุ่น live = ห้ามล่ม — บูตขึ้น วิ่งทางเดิม รายงาน legacy_forced และปลุกทีม", () => {
  const db = seededDb();
  const fired = [];
  const runtime = createBrainRuntime({
    db, config: VERSIONED, logger: silent, now: () => CLOCK,
    notifier: { fireLater: (payload) => fired.push(payload) },
  });
  assert.equal(runtime.resolve("U-1", "default", CLOCK), null, "ไม่มีรุ่น live = ใช้ทางเดิม ไม่ใช่โยน");
  const snap = runtime.snapshot();
  assert.equal(snap.mode, "legacy_forced");
  assert.equal(snap.ok, false);
  assert.equal(snap.holdReason, "no_live_pointer");
  assert.equal(fired.length, 1);
  assert.equal(fired[0].reason, "brain_read_fallback");
  db.close();
});

test("นำเข้ารุ่นแรกหลังบูตแล้ว ระบบสลับมาอ่านสมองเองภายในหนึ่งนาที ไม่ต้องรีสตาร์ท", () => {
  const db = seededDb();
  let at = CLOCK;
  const runtime = createBrainRuntime({ db, config: VERSIONED, logger: silent, now: () => at });
  assert.equal(runtime.resolve("U-1", "default", at), null);

  const imported = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: silent });
  assert.equal(runtime.resolve("U-1", "default", at), null, "ยังไม่ถึงรอบตรวจซ้ำ = ยังทางเดิม");
  at = CLOCK + 61_000;
  const resolved = runtime.resolve("U-1", "default", at);
  assert.equal(resolved.versionId, imported.versionId, "ถึงรอบตรวจซ้ำแล้วต้องกลับมาอ่านสมองเอง");
  assert.equal(runtime.snapshot().mode, "versioned");
  db.close();
});

test("BRAIN_READ ที่พิมพ์ผิดต้องดัง และ versioned บังคับเปิดตัวเฝ้าสมองเงาให้เอง", async () => {
  const { brainReadMode, createConfig } = await import("../src/config.mjs");
  assert.equal(brainReadMode(""), "legacy");
  assert.equal(brainReadMode("Versioned"), "versioned");
  assert.throws(() => brainReadMode("true"), /BRAIN_READ/u);
  // ตัวเฝ้าคือตัวเดียวที่จับได้ว่าสมองเริ่มไม่ตรงตารางจริง — ปิดพร้อมเปิดทางอ่านไม่ได้
  assert.equal(createConfig({ BRAIN_READ: "versioned", BRAIN_SHADOW_PARITY: "false" }).brainShadowParity, true);
  assert.equal(createConfig({}).brainShadowParity, false);
});

/* ------------------------------- ฝั่ง canary ------------------------------- */

test("ฝั่ง canary ผูกกับ customer_id ล้วน — เวลาเปลี่ยนไม่ทำให้ห้องสลับฝั่ง", () => {
  const canary = { percent: 50 };
  const room = "U-somchai-0001";
  const first = inCanaryCohort(canary, { customerId: room, channelId: "default", atMs: CLOCK });
  for (const offset of [0, 1_000, 3_600_000, 86_400_000 * 30]) {
    assert.equal(
      inCanaryCohort(canary, { customerId: room, channelId: "default", atMs: CLOCK + offset }),
      first,
      "ห้องเดียวกันต้องได้ฝั่งเดิมเสมอ ไม่งั้นบทสนทนาจะสลับสมองกลางทาง",
    );
  }
  assert.ok(customerBucket(room) >= 0 && customerBucket(room) < 100);
});

test("tester_ids ชนะทุกเงื่อนไข · channels คัดห้องนอกช่องทางออก · percent 0 = ไม่มีใคร", () => {
  const base = { customerId: "U-x", channelId: "line", atMs: CLOCK };
  assert.equal(inCanaryCohort({ percent: 0, tester_ids: ["U-x"] }, base), true);
  assert.equal(inCanaryCohort({ percent: 100, channels: ["facebook"] }, base), false);
  assert.equal(inCanaryCohort({ percent: 100, channels: ["line"] }, base), true);
  assert.equal(inCanaryCohort({ percent: 0 }, base), false);
  assert.equal(inCanaryCohort({}, base), false);
  assert.equal(inCanaryCohort({ percent: 100, until: CLOCK - 1 }, base), false);
  assert.equal(inCanaryCohort({ percent: 100, until: CLOCK + 1 }, base), true);
});

test("ชนิดที่ทดลองไม่ได้: ราคา/สินค้า/รอบ/คำต้องห้าม/policy ที่บังคับใช้จริง", () => {
  const rev = (kind, key, sha, body = {}) => ({ kind, key, body_sha256: sha, body_json: JSON.stringify(body) });
  const live = [
    rev("price", "price:A", "a1"),
    rev("fact", "fact:1", "f1"),
    rev("policy", "policy:tone", "p1", { enforcement: { kind: "prompt_only" } }),
    rev("policy", "policy:route", "r1", { enforcement: { kind: "route" } }),
  ];
  assert.deepEqual(canaryKindConflicts(live, live), [], "เหมือนกันทุกใบ = ทดลองได้");
  // แก้ fact อย่างเดียว = ทดลองได้ (คำพูดคือสิ่งที่ canary มีไว้ทดลอง)
  const factOnly = live.map((r) => (r.key === "fact:1" ? { ...r, body_sha256: "f2" } : r));
  assert.deepEqual(canaryKindConflicts(factOnly, live), []);
  // แก้ policy แบบ prompt_only = ทดลองได้
  const toneOnly = live.map((r) => (r.key === "policy:tone" ? { ...r, body_sha256: "p2" } : r));
  assert.deepEqual(canaryKindConflicts(toneOnly, live), []);
  // ราคาเพิ่ม / ราคาแก้ / ราคาหาย / policy ที่บังคับใช้จริงแก้ = ทดลองไม่ได้ทั้งหมด
  assert.equal(canaryKindConflicts([...live, rev("price", "price:B", "b1")], live).length, 1);
  assert.equal(canaryKindConflicts(live.map((r) => (r.key === "price:A" ? { ...r, body_sha256: "a2" } : r)), live).length, 1);
  assert.equal(canaryKindConflicts(live.filter((r) => r.key !== "price:A"), live).length, 1);
  assert.equal(canaryKindConflicts(live.map((r) => (r.key === "policy:route" ? { ...r, body_sha256: "r2" } : r)), live).length, 1);
  // อ่าน enforcement ไม่ออก = ถือว่าบังคับใช้จริง (fail-closed)
  const broken = live.map((r) => (r.key === "policy:tone" ? { ...r, body_json: "{ พัง" } : r));
  assert.equal(canaryKindConflicts(broken, live).length, 1);
});

/* --------------------------- ตกทางเดิม + ปลุกทีม --------------------------- */

// pointer ชี้ไปยังเวอร์ชันที่อ้าง revision ที่ไม่มีอยู่จริง = คอมไพล์ไม่ผ่านทุกครั้ง
function brokenDb({ contract = BRAIN_CODE_CONTRACT, canary = null } = {}) {
  const live = {
    version_id: "v-broken", seq: 7, pointer: "live", tree_sha256: "tree-x",
    status: "live", code_contract: contract, manifest_json: JSON.stringify({ revIds: ["rev-หาย"] }),
  };
  return {
    audits: [], listVersionCalls: 0,
    getBrainPointer(role) { return role === "live" ? live : canary; },
    getBrainVersion(id) { return id === live.version_id ? live : canary; },
    listBrainVersions() { this.listVersionCalls += 1; return [live]; },
    listBrainRevs() { return []; },
    addAudit(row) { this.audits.push(row); },
  };
}

test("คอมไพล์ไม่ผ่าน = คืน null ให้ผู้เรียกใช้ทางเดิม และนับไว้ทุกครั้ง", () => {
  const runtime = createBrainRuntime({
    db: brokenDb(), config: { ...VERSIONED, brainFallbackAlertStreak: 3 }, logger: silent, now: () => CLOCK,
  });
  assert.equal(runtime.resolve("U-1", "default", CLOCK), null);
  assert.equal(runtime.resolve("U-2", "default", CLOCK), null);
  const snap = runtime.snapshot();
  assert.equal(snap.fallbacks, 2);
  assert.equal(snap.consecutive, 2);
  assert.equal(snap.ok, false);
  assert.equal(snap.lastFailureAt, CLOCK);
  assert.equal(snap.lastOkAt, null);
});

test("ตกติดกันครบเกณฑ์ = ปลุกครั้งเดียว · ยังไม่หายแล้วพ้น cooldown = ปลุกซ้ำได้", () => {
  const db = brokenDb();
  const fired = [];
  let at = CLOCK;
  const runtime = createBrainRuntime({
    db,
    config: { ...VERSIONED, brainFallbackAlertStreak: 3, brainFallbackAlertCooldownMs: 60_000 },
    notifier: { fireLater: (payload) => fired.push(payload) },
    logger: silent,
    now: () => at,
  });
  for (let i = 0; i < 6; i += 1) runtime.resolve(`U-${i}`, "default", at);
  assert.equal(fired.length, 1, "ปลุกซ้ำทุกเทิร์น = ทีมปิดเสียงทิ้ง");
  assert.equal(fired[0].reason, "brain_read_fallback");
  assert.equal(fired[0].customerId, "ops:brain");

  at = CLOCK + 61_000;
  runtime.resolve("U-later", "default", at);
  assert.equal(fired.length, 2, "outage ที่ยังไม่หายต้องดังซ้ำหลังพ้น cooldown");
  assert.equal(runtime.snapshot().fallbacks, 7);
});

test("อ่านสมองกลับมาได้ = ล้างธงปลุก อาการรอบถัดไปจึงดังได้อีก (ไม่ใช่เงียบตลอดกาล)", () => {
  const db = seededDb();
  const imported = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: silent });
  const fired = [];
  let broken = false; // บูตตอนปกติ แล้วค่อยพังระหว่างทาง — ทรงเดียวกับของจริง
  const original = db.getBrainPointer.bind(db);
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "getBrainPointer") {
        return (role) => { if (broken) throw new Error("อ่าน pointer ไม่ได้"); return original(role); };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const runtime = createBrainRuntime({
    db: proxy, config: { ...VERSIONED, brainFallbackAlertStreak: 2, brainFallbackAlertCooldownMs: 3_600_000 },
    notifier: { fireLater: (payload) => fired.push(payload) }, logger: silent, now: () => CLOCK,
  });
  broken = true;
  for (let i = 0; i < 3; i += 1) runtime.resolve(`U-${i}`, "default", CLOCK);
  assert.equal(fired.length, 1);

  broken = false;
  assert.equal(runtime.resolve("U-ok", "default", CLOCK).versionId, imported.versionId);
  assert.equal(runtime.snapshot().consecutive, 0);
  assert.equal(runtime.snapshot().ok, true);

  broken = true;
  for (let i = 0; i < 3; i += 1) runtime.resolve(`U-again-${i}`, "default", CLOCK);
  assert.equal(fired.length, 2, "หายแล้วกลับมาพังใหม่ = อาการใหม่ ต้องปลุกได้ทันทีโดยไม่รอ cooldown");
  db.close();
});

test("ปิดแฟล็ก = ไม่แตะตารางสมองเลย (resolve คืน null ทันที)", () => {
  const runtime = createBrainRuntime({ db: brokenDb(), config: {}, logger: silent, now: () => CLOCK });
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.resolve("U-1", "default", CLOCK), null);
  assert.equal(runtime.snapshot().fallbacks, 0, "ปิดอยู่ไม่ใช่ความล้มเหลว ห้ามนับ");
  assert.equal(runtime.snapshot().mode, "legacy");
  assert.equal(runtime.snapshot().ok, true);
});

/* --------------------------- contract ที่ยังไม่มีโค้ด --------------------------- */

test("contract ที่โค้ดนี้ยังไม่รองรับ: จำคำตอบไว้ ไม่ไล่ตารางทุกเทิร์น และดังครั้งเดียว", () => {
  const db = brokenDb({ contract: "brain-compat-99" });
  const fired = [];
  const runtime = createBrainRuntime({
    db, config: { ...VERSIONED, brainFallbackAlertStreak: 99 },
    notifier: { fireLater: (payload) => fired.push(payload) }, logger: silent, now: () => CLOCK,
  });
  for (let i = 0; i < 5; i += 1) runtime.resolve(`U-${i}`, "default", CLOCK);
  assert.equal(db.listVersionCalls, 1, "ไล่ 50 แถวทุกเทิร์น = จ่ายฟรีทุกเทิร์นตลอดกาล");
  assert.equal(fired.filter((row) => row.reason === "brain_contract_fallback").length, 1);
  assert.equal(db.audits.filter((row) => row.action === "brain_contract_fallback").length, 1);
  assert.equal(runtime.snapshot().contractFallbacks, 1);
});

/* ----------------------- สมองไม่ตรงตารางจริง = หยุดเสิร์ฟ ----------------------- */

test("parity drift ระหว่างทาง = หยุดอ่านสมอง (ไม่เสิร์ฟของล้าสมัย) แล้วกลับมาเองเมื่อตรง", () => {
  const db = seededDb();
  const imported = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: silent });
  const fired = [];
  const runtime = createBrainRuntime({
    db, config: VERSIONED, notifier: { fireLater: (payload) => fired.push(payload) },
    logger: silent, now: () => CLOCK,
  });
  assert.equal(runtime.resolve("U-1", "default", CLOCK).versionId, imported.versionId);

  runtime.noteParity({ ok: false, reason: "mismatch", mismatches: [{ part: "guardTables.approvedPrices" }] });
  assert.equal(runtime.resolve("U-1", "default", CLOCK), null, "รู้ว่าเพี้ยนแล้วยังเสิร์ฟต่อ = แย่กว่าทางเดิม");
  assert.equal(runtime.snapshot().mode, "legacy_forced");
  assert.equal(fired.at(-1).reason, "brain_read_fallback");

  runtime.noteParity({ ok: true, reason: "match", mismatches: [] });
  assert.equal(runtime.resolve("U-1", "default", CLOCK).versionId, imported.versionId);
  assert.equal(runtime.snapshot().mode, "versioned");
  db.close();
});

test("ยังไม่เคยนำเข้าสมอง = เหตุผลเงียบ ห้ามนับเป็น drift", () => {
  const db = seededDb();
  const runtime = createBrainRuntime({ db, config: VERSIONED, logger: silent, now: () => CLOCK });
  runtime.noteParity({ ok: false, reason: "no_brain_version", mismatches: [] });
  assert.notEqual(runtime.snapshot().holdReason, "no_brain_version");
  db.close();
});

/* ------------------------- validity ที่เวลา resolve ------------------------- */

test("ราคาที่หมดอายุแล้วหลุดออกจากชุดตัวเลขของ guard ตั้งแต่ตอน resolve", () => {
  const db = seededDb();
  const imported = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: silent });
  const live = db.getBrainVersion(imported.versionId);
  const manifest = JSON.parse(live.manifest_json);
  // ตารางเดิมต้องมีราคานี้ด้วย ไม่งั้นด่าน parity จะเห็นว่าสมองกับตารางคนละชุด (ถูกแล้ว)
  db.setApprovedPrice("โปรหมดอายุ", 7700);
  const rev = db.appendBrainRev({
    itemId: "price:โปรหมดอายุ", kind: "price", key: "price:โปรหมดอายุ",
    body: { label_th: "โปรหมดอายุ", amount: 7700, kind: "promo" },
    scope: { channel: "*" }, validUntil: CLOCK + 10_000,
    provenance: { source: "test:expiry" }, createdBy: "test", createdAt: CLOCK,
  });
  const next = db.createBrainVersion({
    parentId: live.version_id, label: "มีโปรที่มีวันหมดอายุ", status: "draft",
    revIds: [...manifest.revIds, rev.rev_id], pinnedFiles: manifest.pinnedFiles,
    lintAllowlist: manifest.lintAllowlist, counts: manifest.counts,
    codeContract: live.code_contract, createdBy: "test", createdAt: CLOCK,
  });
  db.setBrainVersionGateReport(next.version_id, { verdict: "pass", kind: "test", findings: [] });
  db.setBrainVersionStatus(next.version_id, "validated", { at: CLOCK });
  db.setBrainPointer("live", next.version_id, { changedBy: "test", at: CLOCK });

  const runtime = createBrainRuntime({ db, config: VERSIONED, logger: silent, now: () => CLOCK });
  const before = runtime.resolve("U-1", "default", CLOCK + 5_000);
  assert.ok(before.bundle.guardTables.approvedAmounts.includes(7700), "ยังไม่หมดอายุต้องยังอยู่");
  const after = runtime.resolve("U-1", "default", CLOCK + 20_000);
  assert.ok(!after.bundle.guardTables.approvedAmounts.includes(7700), "หมดอายุแล้วต้องหลุดทั้ง prompt และ guard");
  // ของที่ไม่หมดอายุยังเป็น bundle ก้อนเดิมใน cache (คอมไพล์ซ้ำทุกเทิร์น = จ่ายฟรี)
  assert.equal(runtime.resolve("U-2", "default", CLOCK + 6_000).bundle, before.bundle);
  // ตารางราคาต่างกัน = ต้องมองเห็นได้ (ใช้ตัดสินว่าห้องที่คุยเรื่องเงินถูกเปลี่ยนตัวเลขใต้เท้า)
  assert.equal(runtime.priceDriftBetween(imported.versionId, next.version_id, CLOCK + 5_000), true);
  assert.equal(runtime.priceDriftBetween(next.version_id, next.version_id, CLOCK), false);
  assert.equal(runtime.priceDriftBetween(imported.versionId, "ไม่มีจริง", CLOCK), null);
  db.close();
});

/* -------------- เครื่องคอมไพล์เครื่องเดียว: เส้นด่านตรวจต้องไม่ถูกกระทบ -------------- */

test("compileCards (เส้นด่าน ไม่มีแถวเวอร์ชัน ไม่มี activeAt) ได้ผลเท่ากับ compileBrain เป๊ะ", async () => {
  const { compileBrain, compileCards } = await import("../src/brain/compile.mjs");
  const db = seededDb();
  const imported = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: silent });
  const version = db.getBrainVersion(imported.versionId);
  const manifest = JSON.parse(version.manifest_json);

  const fromVersion = compileBrain(db, imported.versionId, { logger: silent });
  // เส้นด่าน G0-G4 คอมไพล์จากการ์ดตรง ๆ ก่อนตัดสินใจว่าจะบันทึกเวอร์ชันไหม
  const fromCards = compileCards({
    cards: fromVersion.cards,
    versionId: version.version_id, treeSha256: version.tree_sha256,
    codeContract: version.code_contract, pinnedFiles: manifest.pinnedFiles,
    lintAllowlist: manifest.lintAllowlist, db, logger: silent,
  });
  assert.equal(fromCards.checksum, fromVersion.checksum, "สองทางต้องได้ checksum เดียวกัน ไม่งั้นด่านตรวจของคนละสมอง");
  assert.equal(Object.hasOwn(fromCards, "expiredRevIds"), false, "เส้นด่านไม่มีเวลา จึงต้องไม่มีคีย์นี้เลย");

  // ส่ง activeAt แต่ไม่มีอะไรหมดอายุ = checksum ต้องไม่ขยับ (ไม่ใช่ sha ใหม่ทุกเทิร์น)
  const timed = compileBrain(db, imported.versionId, { activeAt: CLOCK + 86_400_000, logger: silent });
  assert.equal(timed.checksum, fromVersion.checksum);
  assert.equal(Object.hasOwn(timed, "expiredRevIds"), false);
  db.close();
});
