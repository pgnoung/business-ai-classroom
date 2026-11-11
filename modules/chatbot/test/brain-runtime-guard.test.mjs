// brain-runtime-guard.test.mjs — เฟส 2 ฝั่งที่ต่อกับเส้นตอบลูกค้าจริง
//
// สี่เรื่องที่รีวิวจับได้ และแต่ละเรื่องมีเทสต์ที่ "แดงก่อนแก้" ของตัวเอง:
//   1. อ่านแถวลูกค้าเป็น argument = throw แบบ synchronous ในเส้น ingress (พังแม้ปิดแฟล็ก)
//   2. รุ่นทดลองที่เปลี่ยนราคา = ตั้งเป็น canary ไม่ได้ · ห้องที่คุยเรื่องเงินแล้วรุ่นเปลี่ยน = ต้องมีคนยืนยัน
//   3. ผู้ส่งอื่นในเทิร์นเดียวกัน (ack นอกเวลาทำการ) ต้องใช้ตารางราคาของเทิร์นนั้นด้วย
//   4. ตารางราคาเป็น "ต่อห้อง" ที่ตัว guard เอง ผู้ส่งทุกตัวจึงได้ของถูกโดยไม่ต้องเดินสายทีละจุด
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { SCHEDULE_ACK_KEY, SCHEDULE_ENABLED_KEY, SCHEDULE_HOURS_KEY } from "../src/scheduleGate.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
// นาฬิกาจริงหนึ่งตัวทั้งไฟล์ (ด่าน clock-hygiene): ประตูเวลาทำการกับ dedupe รูปอ่านเวลาจริง
const CLOCK = Date.now();
const EXPIRED_LABEL = "โปรหมดอายุ";
const EXPIRED_AMOUNT = 7700;
const VERSIONED_ENV = { BRAIN_READ: "versioned", KNOWLEDGE_VERSIONED: "true" };

function roundsFile() {
  const dir = mkdtempSync(join(tmpdir(), "brain-guard-"));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify({ seatsPerRound: 20, classes: {}, rounds: [] }), "utf8");
  return file;
}

function seed(db) {
  db.addKnowledge({ title: "วิธีสมัคร", content: "ทักแชทแล้วทีมงานส่งลิงก์ให้ค่ะ", updatedBy: "owner" });
  db.setApprovedPrice("คลาสหลัก", 19900);
  return db;
}

function newDb() {
  return seed(memoryDb({ now: () => CLOCK }));
}

// สร้างรุ่นใหม่จากรุ่น live ปัจจุบัน โดยสลับ revision ของการ์ดใบหนึ่ง แล้วตั้งเป็น pointer
function publishFrom(db, { replaceRevId = null, rev, role = "live", label = "รุ่นใหม่" }) {
  const live = db.getBrainPointer("live");
  const manifest = JSON.parse(live.manifest_json);
  // ต้องถอด revision ใบเก่าของการ์ดใบเดียวกันออก ไม่งั้น manifest จะถือสองใบพร้อมกัน
  // แล้วใบที่ยังไม่หมดอายุจะกลบใบที่หมดอายุ (เทสต์ผ่านโดยที่ไม่ได้ทดสอบอะไรเลย)
  const revIds = [...manifest.revIds.filter((id) => id !== replaceRevId), ...(rev ? [rev.rev_id] : [])];
  const version = db.createBrainVersion({
    parentId: live.version_id, label, status: "draft", revIds,
    pinnedFiles: manifest.pinnedFiles, lintAllowlist: manifest.lintAllowlist, counts: manifest.counts,
    codeContract: live.code_contract, createdBy: "test", createdAt: CLOCK,
  });
  db.setBrainVersionGateReport(version.version_id, { verdict: "pass", kind: "test", findings: [] });
  db.setBrainVersionStatus(version.version_id, "validated", { at: CLOCK });
  db.setBrainPointer(role, version.version_id, { changedBy: "test", at: CLOCK });
  return version;
}

/**
 * ทำให้ "ตารางของสมอง" กับ "ตารางกลาง" ต่างกันได้จริงโดยที่ด่าน parity ยังเขียว:
 * ราคาใบเดียวกันมี valid_until ที่ผ่านไปแล้ว — parity คอมไพล์แบบไม่ผูกเวลา จึงยังเห็นตรงกับ
 * ตารางเดิม ส่วน resolve ของเทิร์นจริงกรองมันทิ้งตามเวลา (แบบแปลน §5 "Validity ที่ runtime")
 */
function publishExpiredPrice(db) {
  db.setApprovedPrice(EXPIRED_LABEL, EXPIRED_AMOUNT);
  const imported = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: silent });
  const itemId = `price:${EXPIRED_LABEL}`;
  const previousRevId = db.currentBrainRev(itemId)?.rev_id ?? null;
  const rev = db.appendBrainRev({
    itemId, kind: "price", key: itemId,
    body: { label_th: EXPIRED_LABEL, amount: EXPIRED_AMOUNT, kind: "promo" },
    scope: { channel: "*" }, validUntil: CLOCK - 1_000,
    supersedesRev: previousRevId,
    provenance: { source: "test:expired" }, createdBy: "test", createdAt: CLOCK,
  });
  publishFrom(db, { replaceRevId: previousRevId, rev, label: "โปรที่หมดอายุแล้ว" });
  return imported;
}

/* ------------------- 1. ingress ห้ามระเบิดแบบ synchronous ------------------- */

// อ่าน db เป็น argument = อยู่นอก try ของ resolveBrain · handleInboundText ไม่ใช่ async และมี
// เส้นที่ถูกเรียกจาก setTimeout เปล่า ๆ ⇒ throw ตรงนี้คือโปรเซสตาย ไม่ใช่เทิร์นเดียวที่พลาด
function dbThatCannotReadCustomers() {
  const db = newDb();
  return {
    real: db,
    proxy: new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "getCustomer") return () => { throw new Error("อ่านแถวลูกค้าไม่ได้ (ดิสก์เต็ม)"); };
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
}

test("ปิดแฟล็ก: อ่านแถวลูกค้าไม่ได้ที่ ingress ต้องไม่ throw แบบ synchronous", async () => {
  const { real, proxy } = dbThatCannotReadCustomers();
  const app = createApp({
    config: testConfig({ CLASS_ROUNDS_FILE: roundsFile() }),
    db: proxy,
    overrides: { hermesFetch: hermesFetchStub("ได้ค่ะ"), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  let pending = null;
  assert.doesNotThrow(() => {
    pending = app.pipeline.handleInboundText({ customerId: "U-boom", text: "สวัสดีค่ะ", replyToken: "rt" });
  }, "DB ที่อ่านไม่ได้ต้องทำให้เทิร์นนี้พลาด ไม่ใช่ทำให้โปรเซสตาย");
  await Promise.resolve(pending).catch(() => {});
  real.close();
});

test("เปิดแฟล็ก: อ่านแถวลูกค้าไม่ได้ = เทิร์นนั้นใช้ทางเดิม ไม่ throw", async () => {
  const { real, proxy } = dbThatCannotReadCustomers();
  importCurrentSourcesAsVersion1(real, { now: () => CLOCK, logger: silent });
  const app = createApp({
    config: testConfig({ CLASS_ROUNDS_FILE: roundsFile(), ...VERSIONED_ENV }),
    db: proxy,
    overrides: { hermesFetch: hermesFetchStub("ได้ค่ะ"), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  let pending = null;
  assert.doesNotThrow(() => {
    pending = app.pipeline.handleInboundText({ customerId: "U-boom2", text: "สวัสดีค่ะ", replyToken: "rt" });
  });
  await Promise.resolve(pending).catch(() => {});
  real.close();
});

/* ---------------------- 2. canary: ชนิดที่ทดลองไม่ได้ ---------------------- */

test("รุ่นที่เปลี่ยนราคา ตั้งเป็น canary ไม่ได้ — ราคาต้องเป็นค่าเดียวต่อธุรกิจ", () => {
  const db = newDb();
  importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: silent });
  const rev = db.appendBrainRev({
    itemId: "price:โปรลับ", kind: "price", key: "price:โปรลับ",
    body: { label_th: "โปรลับ", amount: 8700, kind: "promo" },
    scope: { channel: "*" }, provenance: { source: "test" }, createdBy: "test", createdAt: CLOCK,
  });
  const live = db.getBrainPointer("live");
  const manifest = JSON.parse(live.manifest_json);
  const version = db.createBrainVersion({
    parentId: live.version_id, label: "รุ่นทดลองที่มีราคาใหม่", status: "draft",
    revIds: [...manifest.revIds, rev.rev_id], pinnedFiles: manifest.pinnedFiles,
    lintAllowlist: manifest.lintAllowlist, counts: manifest.counts,
    codeContract: live.code_contract, createdBy: "test", createdAt: CLOCK,
  });
  db.setBrainVersionGateReport(version.version_id, { verdict: "pass", kind: "test", findings: [] });
  db.setBrainVersionStatus(version.version_id, "validated", { at: CLOCK });

  assert.throws(
    () => db.setBrainPointer("canary", version.version_id, { changedBy: "test", at: CLOCK }),
    /canary_not_supported_for_kind/u,
  );
  assert.equal(db.getBrainPointer("canary"), null, "ปฏิเสธแล้วต้องไม่มี pointer ค้างไว้");
  db.close();
});

test("รุ่นที่เปลี่ยนแค่ข้อเท็จจริง ตั้งเป็น canary ได้ตามปกติ", () => {
  const db = newDb();
  importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: silent });
  const rev = db.appendBrainRev({
    itemId: "fact:ทดลอง", kind: "fact", key: "fact:ทดลอง",
    body: { kind: "fact", title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมงค่ะ", channel_id: null, source_created_at: CLOCK, source_rowid: 999 },
    scope: { channel: "central" }, provenance: { source: "test" }, createdBy: "test", createdAt: CLOCK,
  });
  const live = db.getBrainPointer("live");
  const manifest = JSON.parse(live.manifest_json);
  const version = db.createBrainVersion({
    parentId: live.version_id, label: "รุ่นทดลองน้ำเสียง", status: "draft",
    revIds: [...manifest.revIds, rev.rev_id], pinnedFiles: manifest.pinnedFiles,
    lintAllowlist: manifest.lintAllowlist, counts: manifest.counts,
    codeContract: live.code_contract, createdBy: "test", createdAt: CLOCK,
  });
  db.setBrainVersionGateReport(version.version_id, { verdict: "pass", kind: "test", findings: [] });
  db.setBrainVersionStatus(version.version_id, "validated", { at: CLOCK });
  db.setBrainPointer("canary", version.version_id, { changedBy: "test", at: CLOCK });
  assert.equal(db.getBrainPointer("canary")?.version_id, version.version_id);
  db.close();
});

/* ------------- 2b. ห้องที่คุยเรื่องเงินแล้วรุ่น (และราคา) เปลี่ยนใต้เท้า ------------- */

test("ห้องที่ได้ราคาไปแล้ว แล้วรุ่นเปลี่ยนพร้อมตารางราคา = ปักธงให้คนจริงยืนยัน", async () => {
  const db = newDb();
  const file = roundsFile();
  importCurrentSourcesAsVersion1(db, { now: () => CLOCK, classRoundsFile: file, logger: silent });
  const fired = [];
  const app = createApp({
    config: testConfig({ CLASS_ROUNDS_FILE: file, ...VERSIONED_ENV }),
    db,
    overrides: {
      hermesFetch: hermesFetchStub("ได้เลยค่ะ"), lineFetch: lineFetchStub(), sleep: async () => {},
      notifier: { fireLater: (payload) => fired.push(payload), fire: async () => ({}) },
    },
    logger: silent,
  });

  db.upsertCustomer("U-deal", {});
  await app.pipeline.handleInboundText({ customerId: "U-deal", text: "สนใจคลาสค่ะ", replyToken: "rt" });
  db.markMoneySeen("U-deal"); // ห้องนี้เข้าเส้นเงินแล้ว (ได้ราคาไปแล้ว)

  // เผยแพร่รุ่นใหม่ที่ตารางราคาไม่เหมือนเดิม (ทั้งสมองและตารางกลาง — ทางเดียวกับ P1b)
  db.setApprovedPrice("คอร์สใหม่", 24900);
  const rev = db.appendBrainRev({
    itemId: "price:คอร์สใหม่", kind: "price", key: "price:คอร์สใหม่",
    body: { label_th: "คอร์สใหม่", amount: 24900, kind: "normal" },
    scope: { channel: "*" }, provenance: { source: "test" }, createdBy: "test", createdAt: CLOCK,
  });
  const next = publishFrom(db, { rev, label: "ราคาใหม่" });

  await app.pipeline.handleInboundText({ customerId: "U-deal", text: "ตกลงค่ะ", replyToken: "rt2" });
  const customer = db.getCustomer("U-deal");
  assert.equal(customer.state, "NEEDS_HUMAN", "ตัวเลขที่เพิ่งเสนอไปอาจไม่มีอยู่แล้ว — ต้องมีคนยืนยัน");
  assert.match(String(customer.handoff_summary || ""), /brain_version_switch/u);
  assert.ok(fired.some((row) => row.reason === "brain_version_switch"));
  assert.equal(db.lastBrainVersionFor("U-deal"), next.version_id, "ปักธงแล้วต้องไม่ยิงซ้ำรอบถัดไป");
  db.close();
});

/* ---------------- 3. ผู้ส่งอื่นในเทิร์น: ack นอกเวลาทำการ ---------------- */

// ตั้งช่วงเวลาทำการให้ "ไม่ใช่ตอนนี้" แบบไม่ผูกกับเวลาจริงของเครื่อง (หน้าต่างหนึ่งนาที
// อีกสองชั่วโมงข้างหน้า) — ประตูเวลาทำการอ่านเวลาไทยจากนาฬิกาจริง
function offHoursWindow() {
  const bangkokNow = new Date(CLOCK).toLocaleTimeString("en-GB", { timeZone: "Asia/Bangkok", hour12: false });
  const [hh, mm] = bangkokNow.split(":").map(Number);
  const start = (hh * 60 + mm + 120) % 1440;
  const end = (start + 1) % 1440;
  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  return `${fmt(start)}-${fmt(end)}`;
}

async function ackSentWith(env) {
  const db = newDb();
  const file = roundsFile();
  publishExpiredPrice(db);
  db.setSetting(SCHEDULE_ENABLED_KEY, "1");
  db.setSetting(SCHEDULE_HOURS_KEY, offHoursWindow());
  db.setSetting(SCHEDULE_ACK_KEY, `นอกเวลาทำการค่ะ ตอนนี้ยังมีโปร ${EXPIRED_AMOUNT.toLocaleString("en-US")} บาทอยู่นะคะ`);
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig({ CLASS_ROUNDS_FILE: file, ...env }),
    db,
    overrides: { hermesFetch: hermesFetchStub("ได้ค่ะ"), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  db.upsertCustomer("U-ack", {});
  const result = await app.pipeline.handleInboundText({ customerId: "U-ack", text: "สนใจค่ะ", replyToken: "rt" });
  assert.equal(result.suppressed, "schedule_off", "เทสต์นี้ต้องเดินเข้าเส้น ack นอกเวลาทำการเท่านั้น");
  const sent = lineFetch.sends.length;
  db.close();
  return sent;
}

test("ack นอกเวลาทำการใช้ตารางราคาของเทิร์นนั้น — โปรที่หมดอายุแล้วห้ามหลุดออกไป", async () => {
  assert.equal(await ackSentWith({}), 1, "ทางเดิมยังส่งตามเดิม (ตารางกลางยังมีเลขนี้)");
  assert.equal(await ackSentWith(VERSIONED_ENV), 0, "เปิดแฟล็กแล้วต้องถูกด่านของเทิร์นนั้นจับ");
});

/* ---------------- 4. ตารางราคาเป็น "ต่อห้อง" ที่ตัว guard เอง ---------------- */

test("guard เลือกตารางราคาตามลำดับ: ที่ส่งมาเอง > ของห้องนี้ > ตารางกลาง", () => {
  const central = [{ label: "กลาง", amount: 19900 }];
  const room = [{ label: "ของห้องนี้", amount: 8700 }];
  const guard = createComplianceGuard({
    bannedWords: [], getApprovedPrices: () => central, logger: silent,
    getRoomPrices: (customerId) => (customerId === "U-room" ? room : null),
  });
  assert.equal(guard.checkOutbound("ราคา 8,700 บาทค่ะ").ok, false, "ไม่มีห้อง = ตารางกลาง");
  assert.equal(guard.checkOutbound("ราคา 8,700 บาทค่ะ", { customerId: "U-room" }).ok, true, "ตารางของห้องนี้");
  assert.equal(guard.checkOutbound("ราคา 19,900 บาทค่ะ", { customerId: "U-room" }).ok, false, "ห้องนี้ไม่มีเลขนี้");
  assert.equal(guard.checkOutbound("ราคา 19,900 บาทค่ะ", { customerId: "U-other" }).ok, true, "ห้องอื่น = ตารางกลาง");
  assert.equal(
    guard.checkOutbound("ราคา 12,345 บาทค่ะ", { approvedPrices: [{ label: "x", amount: 12345 }], customerId: "U-room" }).ok,
    true,
    "ที่ผู้เรียกส่งมาเองต้องชนะทุกอย่าง",
  );
});

test("อ่านสมองของห้องไม่ได้ = ตกไปตารางกลาง ไม่ใช่ชุดว่าง (ชุดว่าง = บล็อกยกชุด)", () => {
  const guard = createComplianceGuard({
    bannedWords: [], getApprovedPrices: () => [{ label: "กลาง", amount: 19900 }], logger: silent,
    getRoomPrices: () => { throw new Error("สมองสะดุด"); },
  });
  assert.equal(guard.checkOutbound("ราคา 19,900 บาทค่ะ", { customerId: "U-room" }).ok, true);
  assert.equal(guard.checkOutbound("ราคา 8,700 บาทค่ะ", { customerId: "U-room" }).ok, false);
});

test("guard ของแอปจริงผูกกับสมองของห้อง — ผู้ส่งอื่นจึงได้ตารางถูกโดยไม่ต้องเดินสายทีละจุด", () => {
  const db = newDb();
  const file = roundsFile();
  publishExpiredPrice(db);
  const app = createApp({
    config: testConfig({ CLASS_ROUNDS_FILE: file, ...VERSIONED_ENV }),
    db,
    overrides: { hermesFetch: hermesFetchStub("ได้ค่ะ"), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  const text = `ตอนนี้มีโปร ${EXPIRED_AMOUNT.toLocaleString("en-US")} บาทค่ะ`;
  assert.equal(app.guard.checkOutbound(text).ok, true, "ไม่มีห้อง (เช่นบรอดแคสต์) = ตารางกลางซึ่งยังมีเลขนี้");
  assert.equal(app.guard.checkOutbound(text, { customerId: "U-fu" }).ok, false, "follow-up ของห้องหนึ่ง = ตารางของห้องนั้น");
  db.close();
});
