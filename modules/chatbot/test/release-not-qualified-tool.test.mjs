// release-not-qualified-tool — ขั้นก่อนถอยกลับ release (รีวิวปรปักษ์ 5 ต.ค. #4)
//
// release ก่อนตัวกวาด (a5005211) ไม่มีทางเปิดห้อง not_qualified คืน — ห้องเหลืองที่ค้างตอนถอยกลับจะเงียบตลอดไป
// สคริปต์ต้อง: dry-run ไม่เขียนอะไร · --apply ปิดสวิตช์ก่อนแล้วคืนเฉพาะห้องที่ด่าน/CAS ของตัวกวาดยอม
// · ห้องรอทีมตรวจ/มีเรื่องเงิน/คนรับห้องแล้ว คงปิดและเปลี่ยนเป็น manual (รีวิวปรปักษ์รอบ 2 5 ต.ค.)
//   release เก่าไม่รู้จัก not_qualified — ป้ายแดง "โดยระบบ" รหัสดิบ และไม่มีทางเปิดคืน · manual = ห้องของทีม
// · ห้องที่ปิดด้วยเหตุอื่นไม่ถูกแตะ
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { aiOffInfo } from "../src/aiOffActor.mjs";
import { AUDIT_AI_ON_QUALIFIED, NOT_QUALIFIED_REASON, QUALIFY_SWEEP_MODE_KEY, qualifyStateKey } from "../src/notQualified.mjs";
import {
  ROLLBACK_KEEP_AUDIT_ACTION, ROLLBACK_KEEP_AUDIT_DETAIL, applyNotQualifiedRelease, planNotQualifiedRelease,
} from "../tools/release-not-qualified.mjs";

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), "../tools/release-not-qualified.mjs");
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "release-nq-"));
  const file = join(dir, "chassis.sqlite");
  const db = openDb({ file });
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  const yellow = (id, sql = "") => {
    db.upsertCustomer(id, {});
    db.setAiEnabled(id, false, NOT_QUALIFIED_REASON);
    if (sql) db.raw.prepare(`UPDATE customers SET ${sql} WHERE line_user_id = ?`).run(id);
  };
  yellow("U-active");
  yellow("U-resolved", "state = 'RESOLVED'");
  yellow("U-needs", "state = 'NEEDS_HUMAN'");
  yellow("U-money", "money_seen_at = 123");
  db.upsertCustomer("U-manual", {});
  db.setAiEnabled("U-manual", false, "manual");
  return { db, dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const offReasons = (db) => Object.fromEntries(db.raw.prepare("SELECT line_user_id, ai_enabled, ai_off_reason FROM customers")
  .all().map((row) => [row.line_user_id, `${row.ai_enabled}:${row.ai_off_reason}`]));

test("plan: แยกห้องเหลืองเป็นคืนได้ / ให้คนดูแล ตามเงื่อนไข CAS ของตัวกวาด · อ่านอย่างเดียว", (t) => {
  const w = seed();
  t.after(() => { w.db.close(); w.cleanup(); });
  const before = offReasons(w.db);
  const plan = planNotQualifiedRelease(w.db);
  assert.equal(plan.mode, "on");
  assert.deepEqual(plan.releasable, ["U-active", "U-resolved"]);
  assert.deepEqual(plan.keep.map((k) => k.id), ["U-money", "U-needs"]);
  assert.match(plan.keep.find((k) => k.id === "U-needs").why, /NEEDS_HUMAN/u);
  assert.deepEqual(offReasons(w.db), before, "dry-run ห้ามเขียน");
  assert.equal(w.db.getSetting(QUALIFY_SWEEP_MODE_KEY), "on");
});

test("apply: ปิดสวิตช์ก่อน · คืนเฉพาะห้องที่ plan บอกว่าคืนได้ + audit release:rollback · ห้องอื่นไม่แตะ", (t) => {
  const w = seed();
  t.after(() => { w.db.close(); w.cleanup(); });
  const planned = planNotQualifiedRelease(w.db).releasable;
  const result = applyNotQualifiedRelease({ db: w.db, logger: silent });
  assert.equal(result.mode, "off");
  assert.equal(w.db.getSetting(QUALIFY_SWEEP_MODE_KEY), "off");
  assert.equal(result.released, planned.length, "จำนวนที่คืนจริงต้องเท่ากับ dry-run");
  assert.deepEqual(result.notReleased, []);
  assert.deepEqual(result.remaining.map((k) => k.id), ["U-money", "U-needs"]);
  const after = offReasons(w.db);
  assert.equal(after["U-active"], "1:");
  assert.equal(after["U-resolved"], "1:");
  // รีวิวปรปักษ์รอบ 2 5 ต.ค. (rv4_rollback): ห้องที่ให้คนดูแลเปลี่ยนเป็น manual — release เก่าเห็นเป็น "AI ปิด · โดยคน"
  assert.equal(after["U-needs"], "0:manual");
  assert.equal(after["U-money"], "0:manual");
  assert.equal(aiOffInfo(w.db.getCustomer("U-needs")).by, "human");
  assert.equal(after["U-manual"], "0:manual");
  const audits = w.db.listAudit(50).filter((row) => row.action === AUDIT_AI_ON_QUALIFIED);
  assert.deepEqual(audits.map((row) => row.target).sort(), ["U-active", "U-resolved"]);
  assert.ok(audits.every((row) => row.detail === "release:rollback"));
  const keepAudits = w.db.listAudit(50).filter((row) => row.action === ROLLBACK_KEEP_AUDIT_ACTION);
  assert.deepEqual(keepAudits.map((row) => row.target).sort(), ["U-money", "U-needs"], "หนึ่งแถวต่อห้อง · ไม่แตะ U-manual");
  assert.ok(keepAudits.every((row) => row.detail === ROLLBACK_KEEP_AUDIT_DETAIL));
  // รันซ้ำ = ไม่มีอะไรให้คืน/เปลี่ยนเพิ่ม (idempotent) · ไม่ audit ซ้ำ
  const again = applyNotQualifiedRelease({ db: w.db, logger: silent });
  assert.equal(again.released, 0);
  assert.deepEqual(again.remaining, []);
  assert.equal(w.db.listAudit(50).filter((row) => row.action === ROLLBACK_KEEP_AUDIT_ACTION).length, 2);
});

test("รีวิวปรปักษ์รอบ 2 5 ต.ค.: ห้องที่ทีมตอบ/เขียนโน้ตหลังเหลือง หรือมีคนรับห้อง/เริ่มจ่ายเงิน = ไม่เปิด AI ทับ (ด่านเดียวกับเปิดเขียว)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "release-nq-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { t: 1_000_000 };
  const db = openDb({ file: join(dir, "chassis.sqlite"), now: () => clock.t });
  t.after(() => db.close());
  const yellow = (id, sql = "") => {
    db.upsertCustomer(id, {});
    db.insertMessage({ customerId: id, direction: "in", content: "ตกงานอยู่ค่ะ" });
    db.setAiEnabled(id, false, NOT_QUALIFIED_REASON);
    db.setSetting(qualifyStateKey(id), JSON.stringify({ verdict: "not_qualified", offAt: 2_000_000, mode: "on" }));
    if (sql) db.raw.prepare(`UPDATE customers SET ${sql} WHERE line_user_id = ?`).run(id);
  };
  yellow("U-staff-before");
  yellow("U-staff-after");
  yellow("U-note-after");
  yellow("U-owner", "human_owner = 'chompoo'");
  yellow("U-paying", "deal_status = 'awaiting_payment'");
  clock.t = 1_500_000; // ก่อนห้องเป็นเหลือง (offAt 2_000_000)
  db.insertMessage({ customerId: "U-staff-before", direction: "out", content: "แอดมินค่ะ", operator: "chompoo" });
  clock.t = 2_500_000; // หลังห้องเป็นเหลือง
  db.insertMessage({ customerId: "U-staff-after", direction: "out", content: "แอดมินดูแลเองค่ะ", operator: "chompoo" });
  db.addHandoffNote({ customerId: "U-note-after", author: "chompoo", text: "โทรคุยแล้ว" });

  const plan = planNotQualifiedRelease(db);
  assert.deepEqual(plan.releasable, ["U-staff-before"]);
  assert.deepEqual(Object.fromEntries(plan.keep.map((k) => [k.id, k.why])), {
    "U-note-after": "ทีมตอบ/เขียนโน้ตหลังห้องเป็นเหลือง",
    "U-owner": "มีคนรับห้องนี้แล้ว (human_owner)",
    "U-paying": "ห้องนี้แตะเรื่องเงินแล้ว",
    "U-staff-after": "ทีมตอบ/เขียนโน้ตหลังห้องเป็นเหลือง",
  });
  const result = applyNotQualifiedRelease({ db, now: () => clock.t, logger: silent });
  assert.equal(result.released, 1, "จำนวนที่คืนจริงต้องเท่ากับ dry-run");
  assert.deepEqual(result.notReleased, []);
  const after = offReasons(db);
  assert.equal(after["U-staff-before"], "1:");
  for (const id of ["U-staff-after", "U-note-after", "U-owner", "U-paying"]) assert.equal(after[id], "0:manual", id);
});

test("CLI: ไม่ใส่ --db = exit 2 · dry-run ไม่เขียน · --apply เขียนจริงผ่านไฟล์ DB (ทางเดียวกับบนเครื่องจริง)", (t) => {
  const w = seed();
  w.db.close();
  t.after(w.cleanup);
  assert.equal(spawnSync(process.execPath, [TOOL], { encoding: "utf8" }).status, 2);
  const dry = spawnSync(process.execPath, [TOOL, "--db", w.file], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run/u);
  assert.match(dry.stdout, /จะเปิดคืน 2 · ให้คนดูแล 2/u);
  let db = openDb({ file: w.file });
  assert.equal(db.getCustomer("U-active").ai_enabled, 0, "dry-run ห้ามเขียน");
  db.close();
  const apply = spawnSync(process.execPath, [TOOL, "--db", w.file, "--apply"], { encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /เปิดคืนแล้ว 2 · ให้คนดูแล 2/u);
  assert.match(apply.stdout, /ตั้งเป็น manual ให้คนดูแล U-needs/u);
  assert.match(apply.stdout, /AI ไม่ตอบย้อนหลัง — ขึ้นคิวรอตอบ/u);
  db = openDb({ file: w.file });
  assert.equal(db.getCustomer("U-active").ai_enabled, 1);
  assert.equal(db.getCustomer("U-needs").ai_off_reason, "manual");
  assert.equal(db.getSetting(QUALIFY_SWEEP_MODE_KEY), "off");
  db.close();
  const rerun = spawnSync(process.execPath, [TOOL, "--db", w.file, "--apply"], { encoding: "utf8" });
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /เปิดคืนแล้ว 0 · ให้คนดูแล 0/u);
  assert.doesNotMatch(rerun.stdout, /ย้อนหลัง/u, "ไม่มีห้องเปลี่ยน = ไม่มีหมายเหตุข้อความค้าง");
});
