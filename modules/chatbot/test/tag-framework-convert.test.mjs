// tag-framework-convert.test.mjs — เครื่องมือแปลงป้ายทั้งฐานครั้งเดียว (ทดสอบกับฐานชั่วคราวเท่านั้น)
// ซ้อม = ไม่เขียนแม้แต่ไบต์เดียว · เขียนจริงต้องยืนยันจำนวนห้อง + ไฟล์ backup ใหม่ · ธุรกรรมเดียว · รันซ้ำไม่เปลี่ยนอะไร
// · ป้าย human ไม่ถูกแก้/ลบ · audit หนึ่งแถว · ถอยด้วย backup ได้ · รายงานไม่มีรหัส/ชื่อลูกค้า
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db.mjs";
import { validateTagFramework } from "../src/tagFramework.mjs";
import {
  BACKUP_KIND, dryRunConversion, parseArgs, renderConversion, restoreConversion, writeConversion,
} from "../tools/tag-framework-convert.mjs";
import { fixtureWithPurchase } from "./tagFrameworkFixture.mjs";

const fw = validateTagFramework(fixtureWithPurchase());
const SEP_2026 = Date.UTC(2026, 8, 12, 5);
const now = () => Date.UTC(2026, 8, 28, 12);

function seed(file) {
  let clock = SEP_2026;
  const db = openDb({ file, now: () => clock });
  // ห้อง LINE ที่ส่งถึง: ป้าย AI เก่า + ป้ายระบบ + ป้าย LINE OA เดิม + ออเดอร์จ่ายแล้วเดือน ก.ย. 2026
  db.upsertCustomer("U-live", { displayName: "ลูกค้าเอ" });
  for (const tag of ["ถามราคา", "สนใจ AI Agent", "ดีลร้อนค้าง", "คลาสฟรี", "Excel"]) db.addTag("U-live", tag, "ai");
  for (const tag of ["สนใจGEN AI Classroom", "ซื้อครั้งแรก", "ส.ค.2026", "รอโอน", "VIP"]) db.addTag("U-live", tag, "human");
  const order = db.createOrder({ customerId: "U-live", items: [{ name: "คลาส A", qty: 1, price: 4900 }], total: 4900 });
  db.setOrderStatus(order.id, "draft", "confirmed");
  db.setOrderStatus(order.id, "confirmed", "paid");
  db.addTag("U-live", "ซื้อแล้ว 1 ครั้ง (ลูกค้าใหม่)", "rfm");
  db.addTag("U-live", "ซื้อล่าสุดใน 30 วัน", "rfm");
  // ห้องประวัติ (ส่งไม่ถึง): มีแต่ป้ายนับครั้ง + เดือน — ป้ายความสนใจเดิมไม่ถูกแปลง (ไม่ใช่ห้องที่ส่งถึง)
  db.upsertCustomer("U-history", { displayName: "ลูกค้าบี" });
  for (const tag of ["ย้ายจาก LINE OA", "ซื้อครั้งที่สอง", "ม.ค.2023", "สนใจGEN AI Classroom"]) db.addTag("U-history", tag, "human");
  // Facebook: ป้าย AI เก่าเท่านั้น
  db.upsertCustomer("fb:psid-9", { displayName: "ลูกค้าซี", channelId: "facebook" });
  for (const tag of ["สนใจ Workflow", "คลิป TikTok"]) db.addTag("fb:psid-9", tag, "ai");
  // ห้องที่ไม่มีอะไรต้องแปลง (ป้ายทีมทั่วไป — ป้าย customer = ซื้อแล้ว ได้ ซื้อครั้งที่: 1 ตั้งแต่ 28 ก.ย. ดูเทสต์ท้ายไฟล์)
  db.upsertCustomer("U-quiet", { displayName: "ลูกค้าดี" });
  db.addTag("U-quiet", "VIP", "human");
  // ค่าที่ทีมพิมพ์เองในมิติเปิด ใช้ห้องเดียว (อาจเป็นชื่อเฉพาะคน) — ต้องไม่ออกรายงานในทุกรูปแบบ
  db.addTag("U-quiet", "ของแจก: สูตรลับคุณสมหญิง", "human");
  clock = SEP_2026 + 1000;
  db.close();
}

const hashOf = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const rows = (file) => {
  const sqlite = new DatabaseSync(file, { readOnly: true });
  try {
    return sqlite.prepare("SELECT customer_id, tag, source FROM customer_tags ORDER BY customer_id, source, tag").all()
      .map((row) => `${row.customer_id}|${row.source}|${row.tag}`);
  } finally {
    sqlite.close();
  }
};

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "tag-convert-"));
  try {
    const file = join(dir, "chassis.sqlite");
    seed(file);
    return fn({ dir, file });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("tag convert: dry-run is the default, never writes and reports aggregates only", () => withDb(({ file }) => {
  const before = hashOf(file);
  const report = dryRunConversion({ db: file, framework: fw, now });
  assert.equal(hashOf(file), before, "ไฟล์ฐานต้องไม่เปลี่ยนแม้แต่ไบต์เดียว");
  assert.deepEqual(parseArgs(["--db", file]).write, false);
  assert.deepEqual(report.customers, { total: 4, facebook: 1, legacyHistory: 1, reachableLine: 2, reachableNotSpam: 2 });
  assert.deepEqual([report.touched.rooms, report.touched.reachRooms, report.touched.aiChanged, report.touched.rfmChanged], [3, 1, 2, 2]);
  assert.deepEqual(report.touched.oldRfmReplaced, { "ซื้อแล้ว 1 ครั้ง (ลูกค้าใหม่)": 1, "ซื้อล่าสุดใน 30 วัน": 1 });
  const p = report.purchase;
  assert.deepEqual([p.count["2"], p.evidence.both, p.evidence.historyOnly], [{ all: 2, reach: 1 }, { all: 1, reach: 1 }, { all: 1, reach: 0 }]);
  assert.deepEqual([p.lastYear, p.lastYearReach], [{ 2023: 1, 2026: 1 }, { 2026: 1 }]);
  assert.deepEqual(p.ambiguous.adjacentMonth, { all: 1, reach: 1 }, "ป้ายเดือน ส.ค. + ออเดอร์ ก.ย. = นับแยกแต่ติดธงให้คนดู");
  assert.deepEqual(report.legacyHuman.projectedAdded, {}, "ป้าย AI เดิมให้ AI Agent for Business อยู่แล้ว — ป้ายทีมไม่ได้เพิ่มอะไร");
  assert.deepEqual(report.legacyHuman.teamOnly, { "ขั้น: รอโอน": 1 }, "ค่าของทีมไม่ถูกเขียนแทนคน");
  const text = renderConversion(report);
  const giveaway = report.dimensions.after.find((dim) => dim.key === "ของแจก");
  assert.deepEqual([giveaway.values, giveaway.hiddenRare, giveaway.rooms], [[], 1, { all: 1, reach: 1 }], "ค่าหายากถูกกรองตั้งแต่ข้อมูล เหลือแค่จำนวน");
  assert.match(text, /\[ของแจก\].*ค่าที่ใช้ไม่ถึง 3 ห้องอีก 1 ค่า \(ไม่แสดง\)/u);
  for (const secret of ["U-live", "U-history", "psid-9", "U-quiet", "ลูกค้าเอ", "ลูกค้าบี", "VIP", "สมหญิง"]) {
    assert.ok(!text.includes(secret) && !JSON.stringify(report).includes(secret), `ห้ามมี ${secret} ในรายงาน`);
  }
  assert.match(text, /--write --confirm-rooms 3 --backup/u);
  assert.match(text, /ซื้อครั้งที่ \(ทั้งหมด\/ส่งถึง\): 1 = 0\/0 · 2 = 2\/1/u);
}));

test("tag convert: --write needs the confirmed room count and a fresh backup file, or nothing happens", () => withDb(({ dir, file }) => {
  const before = hashOf(file);
  assert.throws(() => writeConversion({ db: file, framework: fw, confirmRooms: null, backup: join(dir, "b.json"), now }), /--confirm-rooms/u);
  assert.throws(() => writeConversion({ db: file, framework: fw, confirmRooms: 2, backup: join(dir, "b.json"), now }), /ไม่ตรงกับที่ยืนยัน 2/u);
  assert.throws(() => writeConversion({ db: file, framework: fw, confirmRooms: 3, backup: null, now }), /--backup/u);
  writeFileSync(join(dir, "taken.json"), "{}");
  assert.throws(() => writeConversion({ db: file, framework: fw, confirmRooms: 3, backup: join(dir, "taken.json"), now }), /ห้ามเขียนทับ/u);
  assert.equal(rows(file).length, 20);
  assert.equal(hashOf(file), before, "ไม่มีการเขียนจริงระหว่างคำขอที่ถูกปฏิเสธ");
}));

test("tag convert: one transaction rewrites ai tags, adds purchase tags, leaves human tags alone, audits once — and is idempotent", () => withDb(({ dir, file }) => {
  const humanBefore = rows(file).filter((row) => row.includes("|human|"));
  const backup = join(dir, "backup.json");
  const result = writeConversion({ db: file, framework: fw, confirmRooms: 3, backup, now });
  assert.equal(result.written, 3);
  const after = rows(file);
  assert.deepEqual(after.filter((row) => row.includes("|human|")), humanBefore, "ป้าย human เหมือนเดิมทุกแถว");
  assert.deepEqual(after.filter((row) => row.startsWith("U-live|ai|")), [
    "U-live|ai|ขั้น: ถามราคา", "U-live|ai|คลาสฟรี", "U-live|ai|ดีลร้อนค้าง", "U-live|ai|สนใจ: AI Agent for Business", "U-live|ai|ใช้ทำ: ข้อมูล/Excel",
  ], "ป้ายระบบ (ดีลร้อนค้าง/คลาสฟรี) คงไว้");
  assert.deepEqual(after.filter((row) => row.startsWith("U-live|rfm|")), [
    "U-live|rfm|AOV เริ่มต้น (ต่ำกว่า ฿5,000)", "U-live|rfm|ซื้อครั้งที่: 2", "U-live|rfm|ซื้อล่าสุด: Sep2026", "U-live|rfm|ซื้อแล้ว: คลาส A",
  ]);
  assert.deepEqual(after.filter((row) => row.startsWith("U-history|rfm|")), ["U-history|rfm|ซื้อครั้งที่: 2", "U-history|rfm|ซื้อล่าสุด: Jan2023"]);
  assert.ok(!after.some((row) => row.startsWith("U-history|ai|")), "ห้องประวัติไม่ได้ป้ายความสนใจจากป้ายทีม (ไม่ใช่ห้องที่ส่งถึง)");
  assert.deepEqual(after.filter((row) => row.startsWith("fb:psid-9|ai|")), [
    "fb:psid-9|ai|สนใจ: AI Workflow Automation", "fb:psid-9|ai|ใช้ทำ: รูป/วิดีโอ",
  ]);
  const sqlite = new DatabaseSync(file, { readOnly: true });
  const audits = sqlite.prepare("SELECT operator, action, target, detail FROM admin_audit WHERE action = 'tag_framework_convert'").all();
  const dirty = sqlite.prepare("SELECT line_user_id FROM customers WHERE tags_dirty_at = ? ORDER BY line_user_id").all(now()).map((row) => row.line_user_id);
  sqlite.close();
  assert.equal(audits.length, 1);
  assert.match(audits[0].detail, /rooms=3 .*backup=backup\.json/u);
  assert.deepEqual(dirty, ["U-history", "U-live", "fb:psid-9"], "ห้องที่ป้ายเปลี่ยนถูกตั้ง dirty เหมือนเส้นทางปกติ");

  const saved = JSON.parse(readFileSync(backup, "utf8"));
  assert.equal(saved.kind, BACKUP_KIND);
  assert.equal(statSync(backup).mode & 0o777, 0o600, "backup มีรหัสลูกค้า — อ่านได้เฉพาะเจ้าของไฟล์");
  assert.deepEqual(Object.keys(saved.rooms).sort(), ["U-history", "U-live", "fb:psid-9"]);
  assert.deepEqual(saved.rooms["U-live"].rfm.map((row) => row.tag).sort(), ["ซื้อล่าสุดใน 30 วัน", "ซื้อแล้ว 1 ครั้ง (ลูกค้าใหม่)"]);
  assert.ok(!("human" in saved.rooms["U-live"]), "backup เก็บเฉพาะแหล่งที่เครื่องมือแตะ");

  const again = dryRunConversion({ db: file, framework: fw, now });
  assert.equal(again.touched.rooms, 0, "รันซ้ำ = ไม่มีอะไรต้องเปลี่ยน");
  const hash = hashOf(file);
  assert.deepEqual(writeConversion({ db: file, framework: fw, confirmRooms: 0, backup: join(dir, "never.json"), now }), { report: again, written: 0, backup: null });
  assert.equal(hashOf(file), hash, "รันซ้ำไม่เขียนอะไรเลย (ไม่มี audit ใหม่ ไม่มีไฟล์ backup)");
}));

test("tag convert: a write that fails after the backup rolls back everything and removes the backup (retry with the same name works)", () => withDb(({ dir, file }) => {
  const sqlite = new DatabaseSync(file);
  sqlite.exec("ALTER TABLE admin_audit RENAME TO admin_audit_gone");
  sqlite.close();
  const before = rows(file);
  const backup = join(dir, "backup.json");
  assert.throws(() => writeConversion({ db: file, framework: fw, confirmRooms: 3, backup, now }), /admin_audit/u);
  assert.deepEqual(rows(file), before, "ธุรกรรมย้อนครบทุกแถว");
  assert.throws(() => statSync(backup), /ENOENT/u, "backup ของธุรกรรมที่ย้อนแล้วถูกลบ (มีรหัสลูกค้า ไม่มีประโยชน์)");
  const again = new DatabaseSync(file);
  again.exec("ALTER TABLE admin_audit_gone RENAME TO admin_audit");
  again.close();
  assert.equal(writeConversion({ db: file, framework: fw, confirmRooms: 3, backup, now }).written, 3, "รันซ้ำด้วยชื่อไฟล์เดิมได้");
}));

test("tag convert: --restore puts the ai/rfm rows back from the backup and never touches human tags", () => withDb(({ dir, file }) => {
  const original = rows(file);
  const backup = join(dir, "backup.json");
  writeConversion({ db: file, framework: fw, confirmRooms: 3, backup, now });
  assert.throws(() => restoreConversion({ db: file, file: backup, confirmRooms: 2, now }), /--confirm-rooms 3/u);
  assert.deepEqual(restoreConversion({ db: file, file: backup, confirmRooms: 3, now }), { restored: 3 });
  assert.deepEqual(rows(file), original, "กลับเป็นชุดเดิมทุกแถว");
  const sqlite = new DatabaseSync(file, { readOnly: true });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'tag_framework_convert_restore'").get().n, 1);
  sqlite.close();
  writeFileSync(join(dir, "other.json"), JSON.stringify({ kind: "something-else" }));
  assert.throws(() => restoreConversion({ db: file, file: join(dir, "other.json"), confirmRooms: 0, now }), /ไม่ใช่ backup/u);
}));

test("tag convert: ห้องที่มีแต่ป้าย customer ได้ ซื้อครั้งที่: 1 ไม่ติดซื้อล่าสุด (พี่ง้วง 28 ก.ย. 2026)", () => withDb(({ file }) => {
  const db = openDb({ file, now: () => SEP_2026 + 2000 });
  db.upsertCustomer("U-buyer", { displayName: "ลูกค้าอี" });
  db.addTag("U-buyer", "customer", "human");
  db.close();
  const report = dryRunConversion({ db: file, framework: fw, now });
  assert.deepEqual(report.purchase.ambiguous.markerOnly, { all: 1, reach: 1 });
  assert.deepEqual(report.purchase.count["1"], { all: 1, reach: 1 });
  assert.match(renderConversion(report), /นับเป็น ซื้อครั้งที่: 1 \(ไม่ติด ซื้อล่าสุด\)/u);
}));
