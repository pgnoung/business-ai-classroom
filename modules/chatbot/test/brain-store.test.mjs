// brain-store.test.mjs — ตารางสมองเฟส 1a: append-only, pointer, และความ idempotent ของตัวนำเข้า
//
// สิ่งที่เทสต์นี้ต้องกันไว้ให้ได้:
//   - "แก้ประวัติ" ทำไม่ได้ ต่อให้เขียน SQL ตรง ๆ หรือใช้ INSERT OR REPLACE
//   - รันตัวนำเข้าซ้ำแล้วสมองไม่บวมและไม่เกิดเวอร์ชันหลอก แต่ "เปลี่ยนจริง" ต้องเห็น
//   - pointer เป็นคำสัญญาว่า "รุ่นนี้ผ่านด่านแล้ว" ไม่ใช่ตัวแปรที่ตั้งเป็นอะไรก็ได้
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, BRAIN_CODE_CONTRACT } from "../src/brain/import.mjs";
import { collectCurrentSourceCards } from "../src/brain/sources.mjs";
import { treeSha256, createTransactionRunner } from "../src/brain/store.mjs";
import { FREECLASS_PATTERNS_KEY } from "../src/db.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

const CLOCK = 1_700_000_000_000;
const QUIET = { warn() {}, debug() {}, log() {} };

function seed(db) {
  db.addKnowledge({ title: "แคตตาล็อกคลาส", content: "คลาส AI Agent for Business", updatedBy: "owner" });
  db.addKnowledge({ title: "วิธีสมัคร", content: "ทักแชทแล้วทีมงานส่งลิงก์ให้", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setApprovedPrice("Early Bird", 12900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["https://line.me/freeclass"]));
  db.setSetting("hashtag_business_keywords", JSON.stringify({ "#online": "สนใจคลาสเรียนออนไลน์" }));
  db.setSetting("hashtag_silence", "1");
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบสอนสด มกราคม", product: "AI Agent for Business", status: "open", capacity: 15 },
  ]));
}

// เวอร์ชันที่ "ผ่านด่านแล้ว" — pointer ตั้งได้เฉพาะแบบนี้ (ดู assertPointable)
function passedVersion(db, revIds, at = CLOCK) {
  const version = db.createBrainVersion({
    revIds, codeContract: BRAIN_CODE_CONTRACT, createdBy: "owner", createdAt: at,
    gateReport: { verdict: "pass", kind: "test", findings: [] },
  });
  db.setBrainVersionStatus(version.version_id, "validated", { at });
  return db.getBrainVersion(version.version_id);
}

test("revision แก้ไม่ได้และลบไม่ได้ แม้เขียน SQL ตรงเข้าไปเอง", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({
    itemId: "fact:1", kind: "fact", key: "fact:1",
    body: { title: "ก", content: "ข" }, createdBy: "owner", createdAt: CLOCK,
  });

  assert.throws(
    () => db.raw.exec(`UPDATE brain_item_revs SET body_json = '{"title":"แก้แล้ว"}' WHERE rev_id = '${rev.rev_id}'`),
    /append-only/u,
  );
  assert.throws(() => db.raw.exec(`DELETE FROM brain_item_revs WHERE rev_id = '${rev.rev_id}'`), /append-only/u);
  assert.equal(db.getBrainRev(rev.rev_id).body_sha256, rev.body_sha256);

  // API ไม่มีทางเขียนทับให้เรียกเลย — มีแต่ append กับ redact
  assert.equal(typeof db.updateBrainRev, "undefined");
  assert.equal(typeof db.deleteBrainRev, "undefined");
  db.close();
});

test("INSERT OR REPLACE / REPLACE INTO แทรกทับ revision เดิมไม่ได้", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({
    itemId: "fact:1", kind: "fact", key: "fact:1",
    body: { title: "ก", content: "ข" }, createdBy: "owner", createdAt: CLOCK,
  });
  const columns = "(rev_id,item_id,kind,key,body_json,body_sha256,created_by,created_at)";
  const values = `('${rev.rev_id}','fact:1','fact','fact:1','{"title":"ปลอม"}','deadbeef','attacker',${CLOCK})`;

  assert.throws(() => db.raw.exec(`INSERT OR REPLACE INTO brain_item_revs ${columns} VALUES ${values}`), /append-only/u);
  assert.throws(() => db.raw.exec(`REPLACE INTO brain_item_revs ${columns} VALUES ${values}`), /append-only/u);

  const after = db.getBrainRev(rev.rev_id);
  assert.equal(after.body_sha256, rev.body_sha256);
  assert.equal(after.created_by, "owner");
  assert.equal(db.countBrainRevs(), 1);
  db.close();
});

test("trigger ตรึงทุกคอลัมน์ ไม่ใช่แค่คอลัมน์ที่นึกออก — แอบเปลี่ยน scope/inject พร้อม redact ไม่ได้", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({
    itemId: "fact:1", kind: "fact", key: "fact:1", scope: { channel: "central" },
    body: { title: "ก" }, createdBy: "owner", createdAt: CLOCK,
  });
  for (const smuggled of [
    "scope_json = '{\"channel\":[\"facebook\"]}'",
    "inject = 'never'",
    "priority = 99",
    "locked = 1",
    "confidence = 'seen_once'",
    "valid_until = 1",
    "supersedes_rev = 'x'",
    "created_by = 'attacker'",
    "provenance_json = '{\"source\":\"ปลอม\"}'",
  ]) {
    assert.throws(
      () => db.raw.exec(`UPDATE brain_item_revs SET redacted = 1, body_json = '{}', ${smuggled} WHERE rev_id = '${rev.rev_id}'`),
      /append-only/u,
      `ต้องปฏิเสธการลักลอบเปลี่ยน: ${smuggled}`,
    );
  }
  db.close();
});

test("redaction (PDPA) ลบเนื้อได้แต่ sha ต้นฉบับไม่ขยับ และล้าง provenance ต่อได้อีกครั้งเดียว", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({
    itemId: "fact:1", kind: "fact", key: "fact:1",
    body: { title: "ก", content: "ข" }, provenance: { source: "correction:1", customer_hash: "abc" },
    createdBy: "owner", createdAt: CLOCK,
  });
  assert.equal(db.redactBrainRev(rev.rev_id, { customerHash: "abc", reason: "คำขอลูกค้า", at: CLOCK }), true);
  const after = db.getBrainRev(rev.rev_id);
  assert.equal(after.redacted, 1);
  assert.equal(after.body_sha256, rev.body_sha256);
  assert.match(after.body_json, /tombstone/u);

  const ledger = db.raw.prepare("SELECT * FROM redactions WHERE rev_id = ?").get(rev.rev_id);
  assert.equal(ledger.customer_hash, "abc");
  assert.equal(ledger.redacted_at, CLOCK);

  // ทางที่สอง: ลบร่องรอยที่มา (customer_hash) หลัง redact แล้ว
  assert.equal(db.scrubBrainRevProvenance(rev.rev_id, { source: "correction:1" }), true);
  assert.equal(db.getBrainRev(rev.rev_id).provenance_json.includes("customer_hash"), false);
  // แต่ยังแก้เนื้อไม่ได้อยู่ดี
  assert.throws(
    () => db.raw.exec(`UPDATE brain_item_revs SET body_json = '{"กลับมา":1}' WHERE rev_id = '${rev.rev_id}'`),
    /append-only/u,
  );
  db.close();
});

test("แก้การ์ด = revision ใหม่ที่ชี้ว่าแทนที่ใบไหน ไม่ใช่เขียนทับใบเดิม", () => {
  const db = memoryDb();
  const first = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });
  const second = db.appendBrainRev({
    itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 2 },
    supersedesRev: first.rev_id, createdBy: "owner", createdAt: CLOCK + 1,
  });
  assert.equal(db.countBrainRevs(), 2);
  assert.equal(second.supersedes_rev, first.rev_id);
  assert.deepEqual(db.latestBrainRevs().map((r) => r.rev_id), [second.rev_id]);
  assert.equal(db.currentBrainRev("fact:1").rev_id, second.rev_id);
  db.close();
});

test("revision ที่เวลาเท่ากันเป๊ะ: 'ใบปัจจุบัน' คือใบที่เขียนทีหลัง ไม่ใช่ใบที่บังเอิญเจอก่อน", () => {
  const db = memoryDb();
  const first = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });
  const second = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 2 }, createdBy: "owner", createdAt: CLOCK });
  assert.notEqual(first.rev_id, second.rev_id);
  assert.equal(db.currentBrainRev("fact:1").rev_id, second.rev_id);
  assert.deepEqual(db.latestBrainRevs().map((r) => r.rev_id), [second.rev_id]);
  db.close();
});

test("tree_sha256 คิดจากเนื้อหา ไม่ใช่ uuid — เนื้อชุดเดียวกันบนสองเครื่องได้ค่าเท่ากัน", () => {
  const build = () => {
    const db = memoryDb();
    const revs = ["ก", "ข"].map((title, index) => db.appendBrainRev({
      itemId: `fact:${index}`, kind: "fact", key: `fact:${index}`,
      body: { title }, createdBy: "owner", createdAt: CLOCK,
    }));
    const tree = treeSha256(revs);
    const reversed = treeSha256([...revs].reverse());
    db.close();
    return { tree, reversed };
  };
  const a = build();
  const b = build();
  assert.equal(a.tree, b.tree, "สองเครื่อง เนื้อเดียวกัน ต้องได้ tree เดียวกัน");
  assert.equal(a.tree, a.reversed, "ลำดับไม่มีผล");
});

test("pointer live มีได้แถวเดียว รุ่นที่หลุดถูกปลดระวาง และการสลับถูกบันทึกใน admin_audit", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });
  const v1 = passedVersion(db, [rev.rev_id], CLOCK);
  const v2 = passedVersion(db, [rev.rev_id], CLOCK + 1);

  db.setBrainPointer("live", v1.version_id, { changedBy: "owner", at: CLOCK });
  db.setBrainPointer("live", v2.version_id, { changedBy: "owner", at: CLOCK + 1 });

  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM brain_versions WHERE pointer = 'live'").get().n, 1);
  assert.equal(db.getBrainPointer("live").version_id, v2.version_id);
  // รุ่นเดิมไม่ใช่ "live ที่ไม่มี pointer" — ต้องถูกปลดระวางพร้อมเวลา
  const retired = db.getBrainVersion(v1.version_id);
  assert.equal(retired.status, "retired");
  assert.equal(retired.retired_at, CLOCK + 1);

  const audits = db.listAudit(50).filter((row) => row.action.startsWith("brain_pointer_"));
  assert.equal(audits.length, 2);
  db.close();
});

test("เวอร์ชันเดียวถือสองบทบาทไม่ได้ — canary ที่ชี้ใบเดียวกับ live คือการทดลองที่ไม่มีอยู่จริง", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });
  const v1 = passedVersion(db, [rev.rev_id], CLOCK);
  const v2 = passedVersion(db, [rev.rev_id], CLOCK + 1);
  db.setBrainPointer("live", v1.version_id, { changedBy: "owner", at: CLOCK });

  assert.throws(() => db.setBrainPointer("canary", v1.version_id, { changedBy: "owner", at: CLOCK }), /สองบทบาท/u);
  db.setBrainPointer("canary", v2.version_id, { changedBy: "owner", at: CLOCK + 2 });
  assert.equal(db.getBrainPointer("canary").version_id, v2.version_id);
  assert.equal(db.getBrainPointer("live").version_id, v1.version_id);
  db.close();
});

test("pointer ตั้งให้เวอร์ชันที่ยังไม่ผ่านด่านไม่ได้ (สถานะ หรือผลด่านไม่ผ่าน)", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });

  const draft = db.createBrainVersion({
    revIds: [rev.rev_id], codeContract: BRAIN_CODE_CONTRACT, createdBy: "owner", createdAt: CLOCK,
    gateReport: { verdict: "pass" },
  });
  assert.throws(() => db.setBrainPointer("live", draft.version_id, { at: CLOCK }), /สถานะ "draft"/u);

  const noGate = db.createBrainVersion({ revIds: [rev.rev_id], codeContract: BRAIN_CODE_CONTRACT, createdBy: "owner", createdAt: CLOCK });
  db.setBrainVersionStatus(noGate.version_id, "validated", { at: CLOCK });
  assert.throws(() => db.setBrainPointer("live", noGate.version_id, { at: CLOCK }), /ผลด่าน/u);

  db.setBrainVersionGateReport(noGate.version_id, { verdict: "block", findings: [] });
  assert.throws(() => db.setBrainPointer("live", noGate.version_id, { at: CLOCK }), /"block"/u);

  // needs_ack ที่ยังไม่มีใครรับทราบ = "ผ่านแบบเงียบ ๆ" ซึ่งคือสิ่งที่ ack ถูกคิดมาเพื่อกัน
  db.setBrainVersionGateReport(noGate.version_id, { verdict: "needs_ack", findings: [] });
  assert.throws(() => db.setBrainPointer("live", noGate.version_id, { at: CLOCK }), /ยังไม่มีใครรับทราบ/u);

  db.setBrainVersionGateAcks(noGate.version_id, [{ by: "owner", reason: "รับทราบแล้ว", at: CLOCK }]);
  assert.equal(db.setBrainPointer("live", noGate.version_id, { at: CLOCK }).pointer, "live");
  db.close();
});

test("เลื่อนขั้น canary -> live ได้ในธุรกรรมเดียว และถูกบันทึกว่าเป็นการเลื่อนขั้น", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });
  const liveV = passedVersion(db, [rev.rev_id], CLOCK);
  const trial = passedVersion(db, [rev.rev_id], CLOCK + 1);
  db.setBrainPointer("live", liveV.version_id, { changedBy: "owner", at: CLOCK });
  db.setBrainPointer("canary", trial.version_id, { changedBy: "owner", at: CLOCK + 1 });

  // ทางเดินปกติของแบบแปลน: ทดลองแล้วสัญญาณปกติ -> ยกเป็นตัวจริง
  const promoted = db.setBrainPointer("live", trial.version_id, { changedBy: "owner", at: CLOCK + 2 });
  assert.equal(promoted.pointer, "live");
  assert.equal(db.getBrainPointer("canary"), null, "ต้องปล่อย canary ในธุรกรรมเดียวกัน");
  assert.equal(db.getBrainVersion(liveV.version_id).status, "retired");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM brain_versions WHERE pointer IS NOT NULL").get().n, 1);

  const actions = db.listAudit(50).map((row) => row.action);
  assert.ok(actions.includes("brain_pointer_promote"), "การเลื่อนขั้นต้องถูกบันทึกแยกจากการตั้ง pointer ธรรมดา");
  db.close();
});

test("ตั้ง canary ให้เวอร์ชันที่เป็น live อยู่ ยังถูกปฏิเสธเหมือนเดิม", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });
  const liveV = passedVersion(db, [rev.rev_id], CLOCK);
  db.setBrainPointer("live", liveV.version_id, { changedBy: "owner", at: CLOCK });
  assert.throws(() => db.setBrainPointer("canary", liveV.version_id, { at: CLOCK + 1 }), /สองบทบาท/u);
  db.close();
});

test("ธุรกรรมทำงานได้แม้ Node ไม่มี db.isTransaction (ทางสำรองด้วย SAVEPOINT)", () => {
  const db = memoryDb();
  // จำลอง Node < 22.16: ซ่อน isTransaction ออกจาก handle ที่ตัวรันธุรกรรมเห็น
  const legacy = new Proxy(db.raw, {
    get(target, prop, receiver) {
      if (prop === "isTransaction") return undefined;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const atomically = createTransactionRunner(legacy);

  const insert = (id) => db.raw
    .prepare(`INSERT INTO brain_item_revs (rev_id,item_id,kind,key,body_json,body_sha256,created_by,created_at)
              VALUES (?, 'i', 'fact', 'k', '{}', 's', 'owner', 1)`)
    .run(id);

  assert.equal(atomically(() => { insert("ok-1"); return "done"; }), "done");
  assert.equal(db.countBrainRevs(), 1);

  assert.throws(() => atomically(() => { insert("rolled-back"); throw new Error("ล้ม"); }), /ล้ม/u);
  assert.equal(db.countBrainRevs(), 1, "SAVEPOINT ต้องม้วนกลับให้เหมือน BEGIN/ROLLBACK");

  // ซ้อนได้ด้วย (ตัวในเข้าร่วมของตัวนอก ไม่เปิดธุรกรรมใหม่)
  atomically(() => { atomically(() => insert("ok-2")); });
  assert.equal(db.countBrainRevs(), 2);
  db.close();
});

test("seq ของเวอร์ชันซ้ำกันไม่ได้ — ประวัติที่มีสองรุ่นที่ 3 อ่านไม่ออก", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });
  const v1 = passedVersion(db, [rev.rev_id], CLOCK);
  assert.throws(
    () => db.raw.exec(`INSERT INTO brain_versions (version_id,seq,status,manifest_json,tree_sha256,code_contract,created_by,created_at)
                       VALUES ('dup', ${v1.seq}, 'draft', '{}', 'x', 'y', 'z', 1)`),
    /UNIQUE/u,
  );
  db.close();
});

test("สร้างเวอร์ชันที่อ้างการ์ดซึ่งถูกลบตามคำขอลูกค้าไม่ได้ตั้งแต่แรก", () => {
  const db = memoryDb();
  const rev = db.appendBrainRev({ itemId: "fact:1", kind: "fact", key: "fact:1", body: { v: 1 }, createdBy: "owner", createdAt: CLOCK });
  db.redactBrainRev(rev.rev_id, { reason: "คำขอลูกค้า", at: CLOCK });
  assert.throws(
    () => db.createBrainVersion({ revIds: [rev.rev_id], codeContract: BRAIN_CODE_CONTRACT, createdBy: "owner", createdAt: CLOCK }),
    /ถูกลบตามคำขอลูกค้า/u,
  );
  db.close();
});

/* ------------------------------- ตัวนำเข้า ------------------------------- */

test("นำเข้าเวอร์ชันแรก: การ์ดครบทั้ง 5 ชนิด pointer live ชี้เวอร์ชันที่สร้าง และมีรายงานด่าน", () => {
  const db = memoryDb({ now: () => CLOCK });
  seed(db);
  const result = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, createdBy: "import", logger: QUIET });

  assert.equal(result.created, true);
  assert.equal(result.reason, "first");
  assert.deepEqual(result.counts, { fact: 2, price: 2, product: 1, policy: 3, schedule: 1 });
  const live = db.getBrainPointer("live");
  assert.equal(live.version_id, result.versionId);
  assert.equal(live.status, "live");
  assert.equal(live.code_contract, BRAIN_CODE_CONTRACT);
  assert.ok(live.compiled_sha256, "ต้องเก็บ checksum ของ bundle ที่คอมไพล์แล้ว");

  const gate = JSON.parse(live.gate_report_json);
  assert.equal(gate.verdict, "pass");
  assert.equal(gate.kind, "import");
  assert.ok(Array.isArray(gate.findings));
  db.close();
});

test("รันตัวนำเข้าซ้ำโดยแหล่งไม่เปลี่ยน = ไม่มีการ์ดใหม่ ไม่มีเวอร์ชันใหม่", () => {
  const db = memoryDb({ now: () => CLOCK });
  seed(db);
  const first = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });
  const revsAfterFirst = db.countBrainRevs();

  const second = importCurrentSourcesAsVersion1(db, { now: () => CLOCK + 60_000, logger: QUIET });
  assert.equal(second.created, false);
  assert.equal(second.reason, "unchanged");
  assert.equal(second.versionId, first.versionId);
  assert.equal(second.appended, 0);
  assert.equal(db.countBrainRevs(), revsAfterFirst);
  assert.equal(db.listBrainVersions(10).length, 1);
  db.close();
});

test("ปิด/เปิดสวิตช์ความรู้ = สมองเปลี่ยนจริง ไม่ใช่ 'ไม่เปลี่ยน' (เนื้อเท่าเดิม แต่ prompt คนละก้อน)", () => {
  const db = memoryDb({ now: () => CLOCK });
  const row = db.addKnowledge({ title: "แคตตาล็อก", content: "รายละเอียดคลาส", updatedBy: "owner" });
  db.addKnowledge({ title: "อีกใบ", content: "เนื้อหาอื่น", updatedBy: "owner" });
  const first = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });

  db.updateKnowledge(row.id, { active: false, updatedBy: "owner" });
  const off = importCurrentSourcesAsVersion1(db, { now: () => CLOCK + 1, logger: QUIET });
  assert.equal(off.created, true, "ปิดสวิตช์แล้วต้องเกิดเวอร์ชันใหม่");
  assert.equal(off.appended, 1);
  assert.notEqual(off.versionId, first.versionId);
  assert.equal(db.currentBrainRev(`fact:${row.id}`).inject, "never");

  db.updateKnowledge(row.id, { active: true, updatedBy: "owner" });
  const on = importCurrentSourcesAsVersion1(db, { now: () => CLOCK + 2, logger: QUIET });
  assert.equal(on.created, true, "เปิดกลับก็ต้องเกิดเวอร์ชันใหม่");
  assert.equal(db.currentBrainRev(`fact:${row.id}`).inject, "pin");
  db.close();
});

test("การ์ดที่ถูกลบตามคำขอลูกค้าไม่ถูกดึงกลับเข้า manifest ใหม่ — นำเข้าใหม่แล้วคอมไพล์ได้", async () => {
  const { compileBrain } = await import("../src/brain/compile.mjs");
  const db = memoryDb({ now: () => CLOCK });
  const row = db.addKnowledge({ title: "ก", content: "ข", updatedBy: "owner" });
  const first = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });
  const revId = JSON.parse(db.getBrainVersion(first.versionId).manifest_json).revIds[0];

  db.redactBrainRev(revId, { reason: "คำขอลูกค้า", at: CLOCK });
  assert.throws(() => compileBrain(db, first.versionId, { logger: QUIET }), /ถูกลบตามคำขอลูกค้า/u);

  const again = importCurrentSourcesAsVersion1(db, { now: () => CLOCK + 1, logger: QUIET });
  assert.equal(again.created, true);
  assert.equal(again.appended, 1, "ต้องเขียน revision ใบใหม่ ไม่ใช่ใช้ใบที่ถูกลบเนื้อไปแล้วซ้ำ");
  const reused = JSON.parse(db.getBrainVersion(again.versionId).manifest_json).revIds;
  assert.equal(reused.includes(revId), false);
  assert.ok(compileBrain(db, again.versionId, { logger: QUIET }).checksum);
  assert.equal(db.currentBrainRev(`fact:${row.id}`).redacted, 0);
  db.close();
});

test("แหล่งเปลี่ยนหนึ่งจุด = revision ใหม่ใบเดียว + เวอร์ชันใหม่ที่ผูกกับเวอร์ชันเดิม", () => {
  const db = memoryDb({ now: () => CLOCK });
  seed(db);
  const first = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });
  const before = db.countBrainRevs();

  db.setApprovedPrice("Early Bird", 11900);
  const second = importCurrentSourcesAsVersion1(db, { now: () => CLOCK + 1, logger: QUIET });

  assert.equal(second.created, true);
  assert.equal(second.appended, 1);
  assert.equal(db.countBrainRevs(), before + 1);
  assert.equal(db.getBrainVersion(second.versionId).parent_id, first.versionId);
  assert.equal(db.getBrainPointer("live").version_id, second.versionId);
  db.close();
});

test("แหล่งพัง (รอบซ้ำกันทุกฟิลด์) = ตัวนำเข้าปฏิเสธตั้งแต่ตรวจ ไม่เขียนอะไรเลย", () => {
  const db = memoryDb({ now: () => CLOCK });
  seed(db);
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบเดียวกัน", product: "x", status: "open", capacity: 10 },
    { date: "2099-01-10", classKey: "onsite", label: "รอบเดียวกัน", product: "x", status: "open", capacity: 20 },
  ]));
  assert.throws(() => importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET }), /รอบเรียนซ้ำกันทุกฟิลด์/u);
  assert.equal(db.countBrainRevs(), 0);
  assert.equal(db.listBrainVersions(10).length, 0);
  db.close();
});

test("ตัวนำเข้าเป็นก้อนเดียว: ล้ม 'หลังเขียนการ์ดไปแล้ว' ก็ต้องไม่เหลืออะไรค้าง", () => {
  const db = memoryDb({ now: () => CLOCK });
  seed(db);
  // จุดล้มต้องอยู่ **หลัง** การเขียนจริง ไม่งั้นเทสต์พิสูจน์แค่ว่า "ยังไม่ได้เริ่มก็ไม่มีอะไร"
  // ซึ่งเป็นจริงอยู่แล้วโดยไม่ต้องมีธุรกรรม — ตัดตอนตรงขั้นเก็บ checksum ที่เกิดหลัง
  // append revision ครบและสร้างแถวเวอร์ชันแล้ว
  const original = db.setBrainVersionCompiledSha.bind(db);
  db.setBrainVersionCompiledSha = () => { throw new Error("ล้มกลางคัน (จำลอง)"); };
  assert.throws(() => importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET }), /ล้มกลางคัน/u);
  db.setBrainVersionCompiledSha = original;

  assert.equal(db.countBrainRevs(), 0, "revision ที่เขียนไปแล้วต้องถูกม้วนกลับ");
  assert.equal(db.listBrainVersions(10).length, 0, "แถวเวอร์ชันที่สร้างไปแล้วต้องถูกม้วนกลับ");
  assert.equal(db.getBrainPointer("live"), null);

  // และฐานต้องยังใช้งานต่อได้ตามปกติ (ธุรกรรมถูกปิดเรียบร้อย ไม่ค้าง)
  const after = importCurrentSourcesAsVersion1(db, { now: () => CLOCK + 1, logger: QUIET });
  assert.equal(after.created, true);
  assert.ok(db.getBrainPointer("live"));
  db.close();
});

test("PRAGMA recursive_triggers เปิดอยู่จริงบนทุก connection — append-only พึ่งมัน", () => {
  const db = memoryDb();
  assert.equal(db.raw.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 1);
  db.close();
});

test("tree_sha256 แยกการ์ดคนละใบที่เนื้อเหมือนกัน และไม่สนใจ rev_id/inject/scope", () => {
  // สอง item ที่บังเอิญมีเนื้อเหมือนกันเป๊ะ ต้องได้ tree ต่างกัน ไม่งั้นการย้ายเนื้อ
  // จากการ์ดใบหนึ่งไปอีกใบจะไม่ทำให้เวอร์ชันเปลี่ยน
  assert.notEqual(
    treeSha256([{ item_id: "a", body_sha256: "s" }]),
    treeSha256([{ item_id: "b", body_sha256: "s" }]),
  );
  // ฟิลด์ที่ไม่ใช่เนื้อหาต้องไม่มีผลต่อ tree (tree คือ "เนื้อของสมอง" ไม่ใช่ metadata)
  assert.equal(
    treeSha256([{ item_id: "a", body_sha256: "s", rev_id: "uuid-1", inject: "pin", scope_json: "{}" }]),
    treeSha256([{ item_id: "a", body_sha256: "s", rev_id: "uuid-2", inject: "never", scope_json: '{"channel":"x"}' }]),
  );
});

test("รอบเรียนสองใบวันเดียวกันคลาสเดียวกันแต่คนละชื่อ = คนละการ์ด ไม่ใช่การแก้ใบแรก", () => {
  const db = memoryDb();
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบเช้า", product: "x", status: "open", capacity: 10 },
    { date: "2099-01-10", classKey: "onsite", label: "รอบบ่าย", product: "x", status: "almost_full", capacity: 10 },
  ]));
  const cards = collectCurrentSourceCards(db).filter((card) => card.kind === "schedule");
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].itemId, cards[1].itemId);
  // สถานะเดิมถูกเก็บไว้ทั้งคู่: ค่าดิบสำหรับ projection + คำศัพท์ปิดของแบบแปลน
  const almost = cards.find((card) => card.body.status === "almost_full");
  assert.equal(almost.body.status_design, "open");
  db.close();
});

test("ความรู้ที่ปิดสวิตช์เข้ามาเป็นการ์ด inject='never' ไม่ใช่หายไปเฉย ๆ", () => {
  const db = memoryDb();
  const row = db.addKnowledge({ title: "เก่า", content: "ข้อมูลเก่า", updatedBy: "owner" });
  db.updateKnowledge(row.id, { active: false, updatedBy: "owner" });
  const card = collectCurrentSourceCards(db).find((c) => c.itemId === `fact:${row.id}`);
  assert.equal(card.inject, "never");
  db.close();
});

test("ความรู้ที่ลบแล้ว (deleted_at) ไม่เข้าสมองเลย", () => {
  const db = memoryDb();
  const row = db.addKnowledge({ title: "ลบทิ้ง", content: "x", updatedBy: "owner" });
  db.deleteKnowledge(row.id);
  assert.equal(collectCurrentSourceCards(db).length, 0);
  db.close();
});

test("ราคาถูกยกเข้ามาเท่าที่ตารางเดิมมีจริง ไม่มีการเดานโยบายให้เจ้าของ", () => {
  const db = memoryDb();
  db.setApprovedPrice("คลาส", 19900);
  const card = collectCurrentSourceCards(db).find((c) => c.kind === "price");
  assert.deepEqual(Object.keys(card.body).sort(), ["amount", "kind", "label_th"]);
  assert.equal(card.confidence, "needs_owner_confirm", "ช่องที่เหลือยังรอเจ้าของเติม ต้องบอกตรง ๆ");
  db.close();
});

test("ชนิดการ์ดนอก 5 ชนิดที่เปิดตัว เขียนเข้าไม่ได้", () => {
  const db = memoryDb();
  assert.throws(
    () => db.appendBrainRev({ itemId: "p:1", kind: "persona_section", key: "p:1", body: {}, createdBy: "owner" }),
    /ยังไม่เปิดใช้ในเฟสนี้/u,
  );
  db.close();
});

test("ตารางสมองไม่มีคอลัมน์ที่ผูกกับลูกค้า — จึงอยู่นอกขอบเขต resetCustomer โดยโครงสร้าง", () => {
  const db = memoryDb();
  for (const table of ["brain_item_revs", "brain_versions", "redactions"]) {
    const columns = db.raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const forbidden of ["customer_id", "line_user_id", "message_id", "message_ref"]) {
      assert.equal(columns.includes(forbidden), false, `${table} ต้องไม่มีคอลัมน์ ${forbidden}`);
    }
  }
  db.close();
});
