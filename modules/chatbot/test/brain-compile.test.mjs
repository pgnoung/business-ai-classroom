// brain-compile.test.mjs — คอมไพเลอร์ต้อง deterministic และ lint ต้องจับของจริง
//
// "deterministic" ในที่นี้แปลว่า: การ์ดชุดเดิม + คอมไพเลอร์ตัวเดิม = checksum เดิม
// ไม่ว่าจะใส่การ์ดเข้าฐานตามลำดับไหน และไม่ว่าจะคอมไพล์กี่รอบ ถ้าข้อนี้ไม่จริง
// "เวอร์ชันเดิม" จะดูเหมือนเปลี่ยนเองแล้วทุกด่านหลังจากนี้จะเชื่อถือไม่ได้
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { compileBrain, COMPILER_VERSION } from "../src/brain/compile.mjs";
import { treeSha256 } from "../src/brain/store.mjs";
import { runBrainLints } from "../src/brain/lint.mjs";
import { normalizeThai, compareSqliteText, stableJson } from "../src/brain/text.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

const CLOCK = 1_700_000_000_000;
const QUIET = { warn() {}, debug() {}, log() {} };

function card(overrides = {}) {
  return {
    itemId: "fact:1", kind: "fact", key: "fact:1", scope: { channel: "central" },
    inject: "pin", priority: 50, locked: false, confidence: "confirmed",
    validFrom: null, validUntil: null, provenance: { source: "console" },
    body: { kind: "fact", title: "หัวข้อ", content: "เนื้อหา", channel_id: null, source_created_at: 1, source_rowid: 1 },
    ...overrides,
  };
}

test("คอมไพล์ซ้ำได้ checksum เดิมเสมอ", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.addKnowledge({ title: "ก", content: "ข", updatedBy: "owner" });
  db.setApprovedPrice("คลาส", 19900);
  const { versionId } = importCurrentSourcesAsVersion1(db, { now: () => CLOCK });

  const first = compileBrain(db, versionId, { logger: QUIET });
  const second = compileBrain(db, versionId, { logger: QUIET });
  assert.equal(first.checksum, second.checksum);
  assert.equal(first.compilerVersion, COMPILER_VERSION);
  db.close();
});

test("ลำดับที่ใส่การ์ด/ลำดับใน manifest ไม่มีผลต่อผลลัพธ์ — tree และเนื้อ bundle เท่ากัน", () => {
  const db = memoryDb();
  const revIds = [];
  for (const index of [2, 3, 1]) {   // จงใจใส่สลับลำดับ
    const rev = db.appendBrainRev({
      ...card({
        itemId: `fact:${index}`, key: `fact:${index}`,
        body: { kind: "fact", title: `หัวข้อ ${index}`, content: `เนื้อหา ${index}`, channel_id: null, source_created_at: index, source_rowid: index },
      }),
      createdBy: "owner", createdAt: CLOCK + index,
    });
    revIds.push(rev.rev_id);
  }
  const forward = db.createBrainVersion({ revIds: [...revIds], codeContract: "brain-compat-1", createdBy: "owner", createdAt: CLOCK });
  const backward = db.createBrainVersion({ revIds: [...revIds].reverse(), codeContract: "brain-compat-1", createdBy: "owner", createdAt: CLOCK });

  assert.equal(forward.tree_sha256, backward.tree_sha256, "tree ของ revision ชุดเดียวกันต้องไม่ขึ้นกับลำดับใน manifest");

  const a = compileBrain(db, forward.version_id, { logger: QUIET });
  const b = compileBrain(db, backward.version_id, { logger: QUIET });
  for (const part of ["promptBlocks", "guardTables", "rules", "consoleViews", "budget"]) {
    assert.equal(stableJson(a[part]), stableJson(b[part]), `${part} ต้องเหมือนกันทุกไบต์`);
  }
  // ความรู้ต้องเรียงตามลำดับของแหล่ง ไม่ใช่ตามลำดับที่บังเอิญใส่เข้าฐาน
  const order = [...a.promptBlocks.knowledge.central.matchAll(/\[หัวข้อ (\d)\]/gu)].map((m) => m[1]);
  assert.deepEqual(order, ["1", "2", "3"]);
  db.close();
});

test("compiled_sha256 ไม่ขึ้นกับ 'วันนี้วันไหน' แต่ projection ที่ผูกวันที่ขึ้น", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบมกราคม", product: "คลาส", status: "open", capacity: 10 },
  ]));
  db.setSetting("class_enrolled", JSON.stringify({ "2099-01-10": 3 }));
  const { versionId } = importCurrentSourcesAsVersion1(db, { now: () => CLOCK });

  const core = compileBrain(db, versionId, { logger: QUIET });
  const coreAgain = compileBrain(db, versionId, { todayIso: null, logger: QUIET });
  assert.equal(core.checksum, coreAgain.checksum);
  assert.deepEqual(core.rules.seatRuleLines, []);

  const dated = compileBrain(db, versionId, { todayIso: "2098-12-01", logger: QUIET });
  assert.ok(dated.rules.seatRuleLines.length > 0);
  assert.notEqual(dated.checksum, core.checksum, "checksum ต้องผูกกับ todayIso ที่ใส่เข้ามาอย่างชัดเจน");
  db.close();
});

test("เวอร์ชันที่มีการ์ดถูกลบตามคำขอลูกค้า คอมไพล์ไม่ได้ — ต้องบังคับให้ออกรุ่นใหม่", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.addKnowledge({ title: "ก", content: "ข", updatedBy: "owner" });
  const { versionId } = importCurrentSourcesAsVersion1(db, { now: () => CLOCK });
  const revId = JSON.parse(db.getBrainVersion(versionId).manifest_json).revIds[0];
  db.redactBrainRev(revId, { reason: "คำขอลูกค้า", at: CLOCK });

  assert.throws(() => compileBrain(db, versionId, { logger: QUIET }), /ต้องเผยแพร่รุ่นใหม่/u);
  db.close();
});

/* ---------------------------------- lint ---------------------------------- */

test("L01 จับการ์ดคีย์ซ้ำขอบเขตซ้อนที่ไม่บอกว่าใบไหนแทนใบไหน", () => {
  const findings = runBrainLints({ cards: [card(), card({ itemId: "fact:dup" })], bundle: {} });
  const l01 = findings.filter((f) => f.code === "L01");
  assert.equal(l01.length, 1);
  assert.equal(l01[0].severity, "block");
});

test("L02 จับตัวเลขเงินที่ไม่อยู่ในตารางราคา และปล่อยตัวเลขที่อนุมัติแล้ว", () => {
  const bundle = { guardTables: { approvedAmounts: [19900] } };
  const approved = runBrainLints({
    cards: [card({ body: { title: "ราคา", content: "คลาสนี้ 19,900 บาท" } })], bundle,
  }).filter((f) => f.code === "L02" && f.severity === "block");
  assert.equal(approved.length, 0);

  const rogue = runBrainLints({
    cards: [card({ body: { title: "ราคา", content: "จ่าย 59,000 บาทได้เลย" } })], bundle,
  }).filter((f) => f.code === "L02" && f.severity === "block");
  assert.equal(rogue.length, 1);
  assert.match(rogue[0].message, /59,000/u);
});

test("L02b ยกระดับการ์ดสีเขียวที่พูดเงื่อนไขเงิน (ส่วนลด/ผ่อน/%)", () => {
  const findings = runBrainLints({
    cards: [card({ body: { title: "ศิษย์เก่า", content: "ศิษย์เก่าลด 10 เปอร์เซ็นต์" } })],
    bundle: { guardTables: { approvedAmounts: [] } },
  });
  assert.ok(findings.some((f) => f.code === "L02" && /เงื่อนไขเงิน/u.test(f.message)));
});

test("L02/L03/L05 บนการ์ดที่นำเข้ามาและยังไม่เคยแก้ = เตือน ไม่ใช่บล็อก (กฎ grandfather)", () => {
  const imported = card({
    provenance: { source: "import:knowledge_entries:abc" },
    body: { title: "เก่า", content: "โปรเดิม 59,000 บาท" },
  });
  const findings = runBrainLints({ cards: [imported], bundle: { guardTables: { approvedAmounts: [] } } });
  const l02 = findings.filter((f) => f.code === "L02");
  assert.ok(l02.length > 0);
  for (const finding of l02) {
    assert.equal(finding.severity, "warn");
    assert.equal(finding.grandfathered, true);
  }
});

test("L03 จับรอบที่ผ่านไปแล้วแต่ยังเปิดรับ และสินค้าที่ไม่มีรอบข้างหน้า", () => {
  const schedule = card({
    itemId: "schedule:2020-01-01:onsite", kind: "schedule", key: "schedule:2020-01-01:onsite",
    provenance: { source: "console" },
    body: { date: "2020-01-01", round_key: "onsite", label_th: "รอบเก่า", product_key: "คลาส", status: "open", capacity: 10 },
  });
  const product = card({
    itemId: "product:คลาส", kind: "product", key: "product:คลาส", provenance: { source: "console" },
    body: { name_th: "คลาส", aliases: [], status: "selling" },
  });
  const findings = runBrainLints({ cards: [schedule, product], bundle: {}, todayIso: "2026-09-02" });
  assert.ok(findings.some((f) => f.code === "L03" && f.severity === "block" && /ผ่านไปแล้ว/u.test(f.message)));
  assert.ok(findings.some((f) => f.code === "L03" && f.severity === "warn" && /ไม่มีรอบที่เปิดรับ/u.test(f.message)));
});

test("L05 จับการ์ดที่อ้างสินค้าที่ไม่มีชื่อจริงในแคตตาล็อก", () => {
  const price = card({
    itemId: "price:x", kind: "price", key: "price:x", provenance: { source: "console" },
    body: { label_th: "x", amount: 1, product_key: "สินค้าที่ไม่มีจริง" },
  });
  const findings = runBrainLints({ cards: [price], bundle: { guardTables: { approvedAmounts: [1] } } });
  assert.ok(findings.some((f) => f.code === "L05" && f.severity === "block"));
});

test("L07 วัด 'ก่อนตัด' ไม่ใช่ 'หลังตัด' — ไม่งั้นมันเงียบพอดีในวันที่ความรู้เริ่มตกขอบ", () => {
  // หลังตัดจะไม่มีวันเกินเพดาน (ตัวประกอบตัดให้พอดีอยู่แล้ว) ถ้า L07 ดูตัวเลขนั้น
  // มันจะผ่านตลอดกาล — เคสนี้จึงตั้ง pinnedChars ให้ "พอดีเป๊ะ" แต่ usage บอกความจริง
  const findings = runBrainLints({
    cards: [],
    bundle: {
      budget: {
        knowledgeMaxChars: 100,
        pinnedChars: { central: 100, facebook: 40 },
        usage: {
          central: { totalChars: 260, entryCount: 3, droppedCount: 2 },
          facebook: { totalChars: 40, entryCount: 1, droppedCount: 0 },
        },
      },
    },
    mode: "strict",
  });
  const l07 = findings.filter((f) => f.code === "L07");
  assert.equal(l07.length, 1);
  assert.match(l07[0].message, /central/u);
  assert.match(l07[0].message, /2 รายการถูกตัดทิ้ง/u);
  assert.equal(l07[0].severity, "block");
});

test("โหมด compat ลด L07 เป็นคำเตือนเสมอ — เฟส 1a ต้องนำเข้าได้แม้คลังเดิมล้นอยู่ก่อนแล้ว", () => {
  const bundle = {
    budget: { knowledgeMaxChars: 100, usage: { central: { totalChars: 500, entryCount: 9, droppedCount: 4 } } },
  };
  const compat = runBrainLints({ cards: [], bundle }).find((f) => f.code === "L07");
  assert.equal(compat.severity, "warn");
  assert.equal(compat.grandfathered, true);
  assert.equal(runBrainLints({ cards: [], bundle, mode: "strict" }).find((f) => f.code === "L07").severity, "block");
});

test("L12 จับร่องรอยของโหมดทดสอบและบั๊กที่ห้ามไปถึงลูกค้า", () => {
  for (const sentinel of ["(Mock)", "undefined", "NaN", "โหมดเทรน"]) {
    const findings = runBrainLints({
      cards: [card({ body: { title: "t", content: `ราคา ${sentinel}` } })], bundle: {},
    });
    assert.ok(findings.some((f) => f.code === "L12"), `ต้องจับ ${sentinel}`);
  }
});

test("L15 จับข้อมูลส่วนบุคคลใน body การ์ด", () => {
  // "LINE id" ต้องมาพร้อมไอดีจริง ๆ ถึงจะเป็นข้อมูลที่ระบุตัวใครได้ — คำลอย ๆ ไม่ใช่
  // (เดิมแค่คำว่า "ไลน์ไอดี" ปรากฏก็ฟ้อง ทำให้การ์ด "ช่องทางติดต่อ" ของร้านแก้ไม่ได้ตลอดกาล
  //  แม้เจ้าของจะยกเว้นไอดีของร้านไปแล้ว เพราะสาขานั้นไม่เคยดู allowlist เลย)
  for (const text of ["โทร 0812345678", "อีเมล test@example.com", "LINE id: adminshop01"]) {
    const findings = runBrainLints({ cards: [card({ body: { title: "t", content: text } })], bundle: {} });
    assert.ok(findings.some((f) => f.code === "L15" && f.severity === "block"), `ต้องจับ: ${text}`);
    // การ์ดที่นำเข้ามาโดยยังไม่มีใครแตะ ได้เป็นคำเตือนแทน (โหมด compat)
    const imported = runBrainLints({
      cards: [card({ provenance: { source: "import:knowledge_entries:x" }, body: { title: "t", content: text } })],
      bundle: {},
    }).find((f) => f.code === "L15");
    assert.equal(imported.severity, "warn");
    assert.equal(imported.grandfathered, true);
  }
  const clean = runBrainLints({ cards: [card({ body: { title: "t", content: "คลาสสอนสดที่กรุงเทพ" } })], bundle: {} });
  assert.equal(clean.filter((f) => f.code === "L15").length, 0);

  // คำว่า LINE id ที่ไม่มีไอดีตามมา = ไม่มีอะไรให้ระบุตัวใคร ต้องไม่ฟ้อง
  const bareWord = runBrainLints({
    cards: [card({ body: { title: "t", content: "ขอ LINE id ของแอดมินได้ที่หน้าร้าน" } })], bundle: {},
  });
  assert.equal(bareWord.filter((f) => f.code === "L15").length, 0);

  // ไอดีของร้านเราเองที่เจ้าของยกเว้นไว้แล้ว ต้องไม่ฟ้อง (ไม่งั้นการ์ดนั้นแก้ไม่ได้ตลอดกาล)
  const owned = runBrainLints({
    cards: [card({ body: { title: "t", content: "ทัก LINE id: pngoungshop ได้เลย" } })],
    bundle: {}, allowlist: ["pngoungshop"],
  });
  assert.equal(owned.filter((f) => f.code === "L15").length, 0);
});

test("L16 จับอักขระที่ตัว normalize จะตัดทิ้ง (ความกว้างศูนย์ / เ เ แทน แ)", () => {
  const zeroWidth = runBrainLints({ cards: [card({ body: { title: "t", content: "ข​อใบกำกับ" } })], bundle: {} });
  assert.ok(zeroWidth.some((f) => f.code === "L16"));
  const doubleSara = runBrainLints({ cards: [card({ body: { title: "t", content: "จ่ายเงินเเล้วค่ะ" } })], bundle: {} });
  assert.ok(doubleSara.some((f) => f.code === "L16"));
  const clean = runBrainLints({ cards: [card({ body: { title: "t", content: "จ่ายเงินแล้วค่ะ" } })], bundle: {} });
  assert.equal(clean.filter((f) => f.code === "L16").length, 0);
});

test("lint ครบทั้ง 8 รหัสที่เปิดตัวตามแบบแปลน", () => {
  const source = ["L01", "L02", "L03", "L05", "L07", "L12", "L15", "L16"];
  const seen = new Set();
  const cards = [
    card({ itemId: "a", body: { title: "t", content: "โอน 59,000 บาท (Mock) โทร 0812345678 เเล้ว​" } }),
    card({ itemId: "b", key: "fact:1" }), card({ itemId: "c", key: "fact:1" }),
    card({
      itemId: "schedule:x", kind: "schedule", key: "schedule:x",
      body: { date: "2020-01-01", round_key: "r", label_th: "เก่า", product_key: "ไม่มีจริง", status: "open", capacity: 1 },
    }),
  ];
  for (const finding of runBrainLints({
    cards,
    bundle: {
      guardTables: { approvedAmounts: [] },
      budget: { knowledgeMaxChars: 10, usage: { central: { totalChars: 99, entryCount: 4, droppedCount: 3 } } },
    },
    todayIso: "2026-09-02",
  })) seen.add(finding.code);
  assert.deepEqual([...seen].sort(), source);
});

/* --------------------------------- ตัวช่วย --------------------------------- */

test("normalizeThai ของสมองให้ผลตรงกับตัวที่ safetyRouter ใช้จริง", async () => {
  // safetyRouter ยังไม่ export normalizeThai (แบบแปลนย้ายเป็น thaiText.mjs ตอน P0b)
  // จึงผูกด้วยพฤติกรรมที่สังเกตได้จากภายนอก: routeMessage ต้องจับ "โอนเเล้ว" ได้
  // เท่ากับ "โอนแล้ว" — ถ้าต้นฉบับเปลี่ยนกติกา เทสต์นี้จะแดงก่อนที่ lint จะเพี้ยนเงียบ ๆ
  const { isPaymentActionText } = await import("../src/safetyRouter.mjs");
  assert.equal(isPaymentActionText("โอนเเล้วค่ะ"), isPaymentActionText("โอนแล้วค่ะ"));
  assert.equal(normalizeThai("โอนเเล้ว​ค่ะ"), "โอนแล้วค่ะ");
});

test("compareSqliteText เรียงเหมือน ORDER BY ของ SQLite", () => {
  const db = memoryDb();
  for (const label of ["Zebra", "apple", "คลาส", "Early", "ก"]) db.setApprovedPrice(label, 1);
  const fromDb = db.approvedPrices().map((row) => row.label);
  const sorted = [...fromDb].sort(compareSqliteText);
  assert.deepEqual(sorted, fromDb);
  db.close();
});

test("กติกาสินค้าที่ว่าง ไม่สร้างการ์ด policy และไม่สร้างบรรทัดใน prompt", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.setSetting(PRODUCT_RULES_KEY, "");
  const { versionId } = importCurrentSourcesAsVersion1(db, { now: () => CLOCK });
  const bundle = compileBrain(db, versionId, { logger: QUIET });
  assert.equal(bundle.rules.productRules, "");
  assert.deepEqual(bundle.rules.productRulesLines, []);
  db.close();
});

/* --------------------------- ความครบถ้วนของเวอร์ชัน --------------------------- */

test("คอมไพล์ปฏิเสธเวอร์ชันที่ manifest อ้าง revision ที่หายไป", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.addKnowledge({ title: "ก", content: "ข", updatedBy: "owner" });
  const { versionId } = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });
  const manifest = JSON.parse(db.getBrainVersion(versionId).manifest_json);
  db.raw.prepare("UPDATE brain_versions SET manifest_json = ? WHERE version_id = ?")
    .run(JSON.stringify({ ...manifest, revIds: [...manifest.revIds, "rev-ที่ไม่มีจริง"] }), versionId);

  assert.throws(() => compileBrain(db, versionId, { logger: QUIET }), /หาเจอ/u);
  db.close();
});

test("คอมไพล์ปฏิเสธเวอร์ชันที่ tree ไม่ตรงกับ revision ที่อ้างถึง (มีคนแก้ฐานตรง ๆ)", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.addKnowledge({ title: "ก", content: "ข", updatedBy: "owner" });
  const { versionId } = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });
  db.raw.prepare("UPDATE brain_versions SET tree_sha256 = 'ปลอม' WHERE version_id = ?").run(versionId);

  assert.throws(() => compileBrain(db, versionId, { logger: QUIET }), /tree ของเวอร์ชัน/u);
  db.close();
});

test("คอมไพล์ปฏิเสธ revision ที่เนื้อไม่ตรงกับ sha ที่บันทึกไว้", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.addKnowledge({ title: "ก", content: "ข", updatedBy: "owner" });
  const { versionId } = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });
  const revId = JSON.parse(db.getBrainVersion(versionId).manifest_json).revIds[0];
  // ปิด trigger ชั่วคราวไม่ได้ (ตั้งใจ) — จำลอง "ฐานถูกแก้จากภายนอก" ด้วยการเขียน
  // body_sha256 ของเวอร์ชันให้ตรง แต่เนื้อของ rev ไม่ตรง ผ่านตารางเวอร์ชันแทน
  const tampered = db.getBrainRev(revId);
  db.raw.prepare("UPDATE brain_versions SET tree_sha256 = ? WHERE version_id = ?")
    .run(treeSha256([{ ...tampered, body_sha256: "ไม่ตรง" }]), versionId);
  db.raw.exec("PRAGMA writable_schema = ON");
  db.raw.exec("DROP TRIGGER brain_item_revs_append_only");
  db.raw.exec("PRAGMA writable_schema = OFF");
  db.raw.prepare("UPDATE brain_item_revs SET body_sha256 = 'ไม่ตรง' WHERE rev_id = ?").run(revId);

  assert.throws(() => compileBrain(db, versionId, { logger: QUIET }), /ไม่ตรงกับ sha ที่บันทึกไว้/u);
  db.close();
});

/* -------------------------- allowlist ของ L15 (PII) -------------------------- */

test("เบอร์/อีเมลของร้านเราเองที่อยู่ในไฟล์ที่ปักหมุด ไม่ถูก L15 ฟ้อง แต่ของคนอื่นยังถูกฟ้อง", () => {
  const shopPhone = "021234567";
  const findings = (allowlist) => runBrainLints({
    cards: [card({
      provenance: { source: "console" },
      body: { title: "ติดต่อ", content: `โทรหาทีมงานที่ ${shopPhone} หรือลูกค้าเบอร์ 0899999999` },
    })],
    bundle: {}, allowlist, mode: "strict",
  }).filter((f) => f.code === "L15");

  assert.equal(findings([]).length, 1, "ไม่มี allowlist = ฟ้อง");
  // เบอร์ร้านอยู่ใน allowlist แต่เบอร์ลูกค้ายังอยู่ → ยังต้องฟ้องอยู่
  assert.equal(findings([shopPhone]).length, 1, "เบอร์ลูกค้ายังต้องถูกจับแม้เบอร์ร้านจะได้รับยกเว้น");

  const onlyShop = runBrainLints({
    cards: [card({ provenance: { source: "console" }, body: { title: "ติดต่อ", content: `โทร ${shopPhone}` } })],
    bundle: {}, allowlist: [shopPhone], mode: "strict",
  }).filter((f) => f.code === "L15");
  assert.equal(onlyShop.length, 0, "เบอร์ของร้านเราเองล้วน ๆ ต้องไม่ถูกฟ้อง");
});

test("allowlist ถูกสกัดจากไฟล์ที่ปักหมุด + config ของ instance แล้วเก็บลง manifest", async () => {
  const { buildLintAllowlist, pinFiles } = await import("../src/brain/sources.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "brain-allowlist-"));
  const persona = join(dir, "persona.md");
  writeFileSync(persona, "ทีมงานติดต่อที่ 021234567 หรือ hello@pngoung.example\n");
  const allowFile = join(dir, "brain-lint-allowlist.json");
  writeFileSync(allowFile, JSON.stringify({ contacts: ["@pngoungOA"] }));

  // brand pack ปักหมุดด้วย แต่ต้อง **ไม่** ถูกกวาด: มันมีเนื้อการ์ดที่อ้างช่องทางติดต่อ
  // ของบุคคลที่สามได้ ถ้ากวาดหมด เบอร์ของคนอื่นจะกลายเป็น "ของเรา" แล้ว L15 จะเงียบ
  const brandPack = join(dir, "brain-pack-context.txt");
  writeFileSync(brandPack, "ลูกค้าองค์กรติดต่อคุณสมชาย 0891112222 partner@othercompany.example\n");

  const pinned = pinFiles({ persona, brandPack });
  assert.match(pinned.persona.sha256, /^[a-f0-9]{64}$/u);
  assert.match(pinned.brandPack.sha256, /^[a-f0-9]{64}$/u);

  const allowlist = buildLintAllowlist({ pinnedFiles: pinned, allowlistFile: allowFile });
  const values = allowlist.map((entry) => entry.value);
  assert.ok(values.includes("021234567"));
  assert.ok(values.includes("hello@pngoung.example"));
  assert.ok(values.includes("@pngoungoa"));
  assert.equal(values.includes("0891112222"), false, "เบอร์ของบุคคลที่สามใน brand pack ต้องไม่เข้า allowlist");
  assert.equal(values.includes("partner@othercompany.example"), false);

  // ที่มาต่อรายการต้องถูกบันทึกไว้ให้คนตรวจย้อนได้
  assert.equal(allowlist.find((e) => e.value === "021234567").source, "pinned:persona");
  assert.equal(allowlist.find((e) => e.value === "@pngoungoa").source, "config:brain-lint-allowlist");
});

test("accountNumbers ใน config ถูกเก็บเข้า allowlist พร้อมที่มาแยกจาก contacts", async () => {
  const { buildLintAllowlist } = await import("../src/brain/sources.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "brain-allowlist-acct-"));
  const allowFile = join(dir, "brain-lint-allowlist.json");
  writeFileSync(allowFile, JSON.stringify({ contacts: ["@pngoungOA"], accountNumbers: ["123-4-56789-0"] }));

  const allowlist = buildLintAllowlist({ allowlistFile: allowFile });
  const entry = allowlist.find((e) => e.value === "123-4-56789-0");
  assert.ok(entry, "เลขบัญชีของร้านต้องเข้า allowlist");
  assert.equal(entry.source, "config:brain-lint-allowlist:accountNumbers");
  assert.equal(allowlist.find((e) => e.value === "@pngoungoa").source, "config:brain-lint-allowlist");
});

test("L15: เลขบัญชีของร้านเราเองใน allowlist ไม่ถูกฟ้อง แต่เลขบัญชีอื่นยังถูกฟ้อง", () => {
  const ours = "123-4-56789-0";
  const findings = (content, allowlist) => runBrainLints({
    cards: [card({ provenance: { source: "console" }, body: { title: "การชำระเงิน", content } })],
    bundle: {}, allowlist, mode: "strict",
  }).filter((f) => f.code === "L15");

  assert.equal(findings(`โอนเข้าเลขบัญชี ${ours} ได้เลยค่ะ`, []).length, 1, "ไม่มี allowlist = ฟ้อง");
  assert.equal(findings(`โอนเข้าเลขบัญชี ${ours} ได้เลยค่ะ`, [ours]).length, 0, "เลขบัญชีของร้านเราเองต้องเงียบ");
  // เขียนคนละรูปแบบ (ไม่มีขีด) ต้องนับเป็นเลขเดียวกัน
  assert.equal(findings("โอนเข้าเลขบัญชี 1234567890 ได้เลยค่ะ", [ours]).length, 0, "ตัดขีดแล้วต้องตรงกัน");
  // เลขบัญชีของคนอื่นในการ์ดใบเดียวกัน = ยังต้องฟ้อง (ไม่ใช่ปิดกฎทั้งข้อ)
  assert.equal(
    findings(`เลขบัญชีร้าน ${ours} · เลขบัญชีลูกค้า 987-6-54321-0`, [ours]).length, 1,
    "เลขของคนอื่นยังต้องถูกจับ",
  );
  // เลขบัญชีที่ขึ้นต้นด้วย 0 หน้าตาเหมือนเบอร์มือถือ — ต้องไม่ถูกฟ้องเป็น "เบอร์โทร" แทน
  assert.equal(findings("โอนเข้าเลขบัญชี 012-3-456789 ได้เลยค่ะ", ["012-3-456789"]).length, 0, "เลขบัญชีขึ้นต้น 0 ก็ต้องเงียบ");
  // วันที่ไม่ใช่เลขบัญชี — ห้ามทำให้การ์ดที่มีแต่คำว่า "เลขบัญชี" หลุดกฎเพราะมีวันที่อยู่ด้วย
  assert.equal(
    findings("ส่งเลขบัญชีให้ลูกค้าเมื่อ 2026-09-03 เท่านั้น", [ours]).length, 1,
    "ไม่มีเลขบัญชีของเราในการ์ด = ยังฟ้องเหมือนเดิม",
  );
});

test("ผลด่านของเวอร์ชันที่นำเข้าเก็บคำเตือนไว้ครบ และไม่มีข้อไหนบล็อกการนำเข้า", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.addKnowledge({ title: "โปรเก่า", content: "ราคาพิเศษ 59,000 บาท โทร 0812345678", updatedBy: "owner" });
  const result = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });

  const gate = JSON.parse(db.getBrainVersion(result.versionId).gate_report_json);
  assert.equal(gate.verdict, "pass");
  const codes = new Set(gate.findings.map((f) => f.code));
  assert.ok(codes.has("L02"), "ตัวเลขนอกตารางราคาต้องถูกบันทึกไว้");
  assert.ok(codes.has("L15"), "เบอร์โทรต้องถูกบันทึกไว้");
  for (const finding of gate.findings) {
    assert.equal(finding.severity, "warn", `${finding.code} ต้องไม่บล็อกการนำเข้าในเฟส compat`);
  }
  db.close();
});

/* ----------------------- ผลด่านต้องมาจากสิ่งที่ตรวจเจอจริง ----------------------- */

test("มีข้อที่บล็อกจริง = verdict 'needs_ack' + บันทึกการรับทราบ ไม่ใช่เขียน 'pass' ตายตัว", () => {
  const db = memoryDb({ now: () => CLOCK });
  // "undefined" คือร่องรอยบั๊กที่ L12 บล็อก และเป็นข้อที่กฎ grandfather ไม่ยกเว้นให้
  db.addKnowledge({ title: "ราคาคลาส", content: "ค่าเรียน undefined บาท", updatedBy: "owner" });
  const result = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, todayIso: "2026-09-03", logger: QUIET });

  assert.equal(result.verdict, "needs_ack");
  const live = db.getBrainPointer("live");
  assert.ok(live, "เฟส 1a ยังต้องชี้ live เพื่อให้เทียบเงาได้");
  assert.equal(live.version_id, result.versionId);

  const gate = JSON.parse(live.gate_report_json);
  assert.equal(gate.verdict, "needs_ack");
  assert.equal(gate.todayIso, "2026-09-03");
  assert.ok(gate.findings.some((f) => f.code === "L12" && f.severity === "block"));

  const acks = JSON.parse(live.gate_acks_json);
  assert.equal(acks.length, 1);
  assert.equal(acks[0].by, "import");
  assert.equal(acks[0].reason, "compat-shadow");
  assert.ok(acks[0].codes.includes("L12"));
  db.close();
});

test("ไม่มีข้อที่บล็อก = verdict 'pass' และไม่มีการรับทราบให้ต้องบันทึก", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.addKnowledge({ title: "สถานที่", content: "สอนสดที่กรุงเทพ ใกล้ BTS", updatedBy: "owner" });
  const result = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });

  assert.equal(result.verdict, "pass");
  const live = db.getBrainPointer("live");
  assert.equal(JSON.parse(live.gate_report_json).verdict, "pass");
  assert.deepEqual(JSON.parse(live.gate_acks_json), []);
  db.close();
});

test("compiled_sha256 ที่เก็บไว้ไม่ผูกกับวันที่ แม้ผล lint จะคิดจาก 'วันนี้'", () => {
  const db = memoryDb({ now: () => CLOCK });
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบมกราคม", product: "คลาส", status: "open", capacity: 10 },
  ]));
  const a = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, todayIso: "2026-09-03", logger: QUIET });
  const storedA = db.getBrainVersion(a.versionId).compiled_sha256;
  assert.equal(storedA, compileBrain(db, a.versionId, { logger: QUIET }).checksum);
  assert.notEqual(storedA, compileBrain(db, a.versionId, { todayIso: "2026-09-03", logger: QUIET }).checksum);
  db.close();
});
