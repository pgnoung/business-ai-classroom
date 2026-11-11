// brain-tools.test.mjs — ทางเข้าที่คนใช้จริง: tools/brain-import.mjs และ tools/brain-parity.mjs
//
// เฟส 1a ไม่มีอะไรในระบบเรียกตัวนำเข้าเอง (ตั้งใจ — การนำเข้าเป็นการตัดสินใจ ไม่ใช่
// ผลข้างเคียงของการบูต) สคริปต์สองตัวนี้จึงเป็นทางเข้าเดียว และต้องมีเทสต์ที่รันมันจริง
// ไม่ใช่เทสต์ที่ import ฟังก์ชันข้างในแล้วเชื่อว่าหน้าคำสั่งใช้ได้
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { openBrainReadOnly } from "../src/brain/readonly.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const IMPORT_TOOL = join(HERE, "..", "tools", "brain-import.mjs");
const PARITY_TOOL = join(HERE, "..", "tools", "brain-parity.mjs");
const PREVIEW_TOOL = join(HERE, "..", "tools", "brain-gate-preview.mjs");
const LINTS_TOOL = join(HERE, "..", "tools", "brain-lints.mjs");

// ไบต์และเวลาแก้ไขของไฟล์ฐานจริง
//
// จงใจไม่นับ -wal/-shm: การเปิดฐาน WAL แบบอ่านอย่างเดียวก็ยังสร้างสองไฟล์นี้ขึ้นมา
// (SQLite ต้องใช้ดัชนีในหน่วยความจำร่วมเพื่ออ่าน WAL) แต่ทั้งคู่ต้องว่างเปล่า —
// ถ้ามีไบต์อยู่ใน WAL แปลว่ามี transaction ถูก commit ลงไปจริง เทสต์จึงตรวจข้อนั้นแยก
function fingerprint(file) {
  return { sha: createHash("sha256").update(readFileSync(file)).digest("hex"), mtime: statSync(file).mtimeMs };
}

function walBytes(file) {
  try { return statSync(`${file}-wal`).size; } catch { return 0; }
}

function run(tool, args, { expectFail = false, env = process.env } = {}) {
  try {
    return execFileSync(process.execPath, [tool, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (!expectFail) throw new Error(`${tool} ล้ม: ${err.stderr || err.message}`);
    return `${err.stdout || ""}${err.stderr || ""}`;
  }
}

function seededDbFile() {
  const dir = mkdtempSync(join(tmpdir(), "brain-tools-"));
  const file = join(dir, "chassis.sqlite");
  const db = openDb({ file });
  db.addKnowledge({ title: "แคตตาล็อก", content: "คลาส AI Agent for Business", updatedBy: "owner" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงาน");
  db.close();
  return { dir, file };
}

test("brain-import ซ้อมอย่างเดียวโดยค่าตั้งต้น — ไม่เขียนอะไรลงฐานเลย", () => {
  const { file } = seededDbFile();
  const out = run(IMPORT_TOOL, ["--db", file]);
  assert.match(out, /ซ้อมอย่างเดียว/u);
  assert.match(out, /fact: 1/u);
  assert.match(out, /ใส่ --apply เพื่อเขียนจริง/u);

  const db = openDb({ file });
  assert.equal(db.countBrainRevs(), 0, "dry-run ต้องไม่เขียนการ์ดแม้แต่ใบเดียว");
  assert.equal(db.listBrainVersions(10).length, 0);
  db.close();
});

test("brain-import --apply สร้างเวอร์ชันจริง ตั้ง live และรายงานว่าตรงกับตารางเดิม", () => {
  const { file } = seededDbFile();
  const out = run(IMPORT_TOOL, ["--db", file, "--apply"]);
  assert.match(out, /สร้างเวอร์ชัน/u);
  assert.match(out, /brain parity: ตรง/u);

  const db = openDb({ file });
  const live = db.getBrainPointer("live");
  assert.ok(live);
  assert.equal(live.status, "live");
  assert.ok(live.compiled_sha256);
  db.close();

  // รันซ้ำ = ไม่มีเวอร์ชันใหม่
  const again = run(IMPORT_TOOL, ["--db", file, "--apply"]);
  assert.match(again, /แหล่งไม่เปลี่ยน/u);
});

test("brain-parity เป็นรายงานอย่างเดียว และคืน exit code ไม่ศูนย์เมื่อสมองล้าสมัย", () => {
  const { file } = seededDbFile();
  run(IMPORT_TOOL, ["--db", file, "--apply"]);
  assert.match(run(PARITY_TOOL, ["--db", file]), /brain parity: ตรง/u);

  const db = openDb({ file });
  db.setApprovedPrice("AI Agent for Business", 21900);
  const revsBefore = db.countBrainRevs();
  db.close();

  const drift = run(PARITY_TOOL, ["--db", file, "--verbose"], { expectFail: true });
  assert.match(drift, /brain parity: ไม่ตรง/u);
  assert.match(drift, /guardTables\.approvedPrices/u);

  const after = openDb({ file });
  assert.equal(after.countBrainRevs(), revsBefore, "รายงานต้องไม่เขียนอะไรลงฐาน");
  after.close();
});

test("brain-import ปฏิเสธเมื่อไม่ได้ระบุ --db หรือ --pinned ไม่ใช่ JSON", () => {
  assert.match(run(IMPORT_TOOL, [], { expectFail: true }), /ต้องระบุ --db/u);
  const { file } = seededDbFile();
  assert.match(run(IMPORT_TOOL, ["--db", file, "--pinned", "ไม่ใช่ json"], { expectFail: true }), /--pinned ต้องเป็น JSON/u);
});

test("brain-import รับไฟล์รอบเรียนและ allowlist แล้วเก็บ sha ลง manifest", () => {
  const { dir, file } = seededDbFile();
  const rounds = join(dir, "class-rounds.json");
  writeFileSync(rounds, JSON.stringify({
    seatsPerRound: 12,
    classes: { onsite: { label: "คลาสสอนสด", product: "AI Agent for Business" } },
    rounds: [{ date: "2099-05-10", class: "onsite", status: "open" }],
  }));
  const persona = join(dir, "persona.md");
  writeFileSync(persona, "ติดต่อทีมงาน 021234567\n");

  const out = run(IMPORT_TOOL, [
    "--db", file, "--apply", "--rounds", rounds, "--pinned", JSON.stringify({ persona }),
  ]);
  assert.match(out, /สร้างเวอร์ชัน/u);

  const db = openDb({ file });
  const manifest = JSON.parse(db.getBrainPointer("live").manifest_json);
  assert.match(manifest.pinnedFiles.persona.sha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest.pinnedFiles.classRounds.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    manifest.lintAllowlist.find((entry) => entry.value === "021234567"),
    { value: "021234567", source: "pinned:persona" },
    "เบอร์ในไฟล์ persona ต้องเข้า allowlist ของ L15 พร้อมที่มา",
  );
  assert.equal(manifest.counts.schedule, 1, "รอบจากไฟล์ต้องเข้าสมองด้วย");
  db.close();
});

test("ซ้อมและรายงานไม่แตะไฟล์ฐานเลย — ไบต์และเวลาแก้ไขต้องเท่าเดิม", () => {
  const { file } = seededDbFile();
  run(IMPORT_TOOL, ["--db", file, "--apply"]);       // มีสมองอยู่จริงก่อน แล้วค่อยวัด
  const before = fingerprint(file);

  run(IMPORT_TOOL, ["--db", file]);                   // ซ้อม
  assert.deepEqual(fingerprint(file), before, "dry-run ต้องไม่เปลี่ยนไฟล์ฐาน");
  assert.equal(walBytes(file), 0, "dry-run ต้องไม่ commit อะไรลง WAL");

  run(PARITY_TOOL, ["--db", file]);                   // รายงาน
  assert.deepEqual(fingerprint(file), before, "รายงานต้องไม่เปลี่ยนไฟล์ฐาน");
  assert.equal(walBytes(file), 0, "รายงานต้องไม่ commit อะไรลง WAL");

  // และพิสูจน์ว่ามันอ่านอย่างเดียวจริงในระดับ connection ไม่ใช่แค่ "บังเอิญไม่ได้เขียน"
  const ro = openBrainReadOnly(file);
  assert.throws(() => ro.raw.exec("CREATE TABLE ควรพัง (a)"), /readonly/iu);
  ro.close();

  // ทางที่เขียนจริงต้องสร้างไฟล์ขึ้นมาได้ (ยืนยันว่าเส้น openDb ยังต่างจากเส้นอ่านอย่างเดียว)
  const fresh = join(dirname(file), "fresh.sqlite");
  assert.equal(existsSync(fresh), false);
  openDb({ file: fresh }).close();
  assert.equal(existsSync(fresh), true, "openDb สร้าง/เขียนไฟล์ — คนละเส้นกับตัวอ่านอย่างเดียว");
});

test("ไม่ระบุ --rounds = ใช้ CLASS_ROUNDS_FILE เดียวกับที่แอปใช้ตอนรัน", () => {
  const { dir, file } = seededDbFile();
  const rounds = join(dir, "class-rounds.json");
  writeFileSync(rounds, JSON.stringify({
    seatsPerRound: 12,
    classes: { onsite: { label: "คลาสสอนสด", product: "AI Agent for Business" } },
    rounds: [{ date: "2099-06-10", class: "onsite", status: "open" }],
  }));
  const env = { ...process.env, CLASS_ROUNDS_FILE: rounds };

  const applied = run(IMPORT_TOOL, ["--db", file, "--apply"], { env });
  assert.match(applied, /รอบเรียน: จากไฟล์/u);
  assert.match(applied, /CLASS_ROUNDS_FILE/u);
  assert.match(applied, /brain parity: ตรง/u);

  const db = openDb({ file });
  const manifest = JSON.parse(db.getBrainPointer("live").manifest_json);
  assert.equal(manifest.counts.schedule, 1, "รอบจากไฟล์ต้องเข้าสมอง");
  assert.ok(manifest.pinnedFiles.classRounds, "ไฟล์ที่ถูกใช้จริงต้องถูกปักหมุด");
  db.close();

  // เครื่องมือรายงานต้องเห็นโลกใบเดียวกันโดยไม่ต้องบอกไฟล์ซ้ำ
  assert.match(run(PARITY_TOOL, ["--db", file], { env }), /brain parity: ตรง/u);
});

test("กรอกรอบในคอนโซลแล้ว = ไม่ปักหมุดไฟล์รอบเรียนที่ระบบไม่ได้อ่าน", () => {
  const { dir, file } = seededDbFile();
  const rounds = join(dir, "class-rounds.json");
  writeFileSync(rounds, JSON.stringify({
    seatsPerRound: 12, classes: { onsite: { label: "จากไฟล์", product: "x" } },
    rounds: [{ date: "2099-07-10", class: "onsite", status: "open" }],
  }));
  const db = openDb({ file });
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-08-10", classKey: "onsite", label: "จากคอนโซล", product: "AI Agent for Business", status: "open", capacity: 10 },
  ]));
  db.close();

  const out = run(IMPORT_TOOL, ["--db", file, "--apply", "--rounds", rounds]);
  assert.match(out, /รอบเรียน: จากคอนโซล/u);

  const after = openDb({ file });
  const manifest = JSON.parse(after.getBrainPointer("live").manifest_json);
  assert.equal(manifest.pinnedFiles.classRounds, undefined, "ไฟล์ที่ไม่ได้ถูกอ่านต้องไม่ถูกปักหมุด");
  after.close();
});

// เฟส 1b: ก่อนเปิด KNOWLEDGE_VERSIONED ต้องรู้ล่วงหน้าว่าข้อมูลจริงวันนี้จะติดอะไรบ้าง
// ไม่ใช่ไปเจอตอนพี่ง้วงกดบันทึกจากมือถือ (นั่นคือการทดลองบนคนที่กำลังทำงาน)
test("brain-gate-preview บอกล่วงหน้าว่าเปิดแฟล็กแล้วจะติดอะไร และไม่เขียนอะไรลงฐาน", () => {
  const { file } = seededDbFile();
  run(IMPORT_TOOL, ["--db", file, "--apply"]);
  const clean = run(PREVIEW_TOOL, ["--db", file]);
  assert.match(clean, /parity ตรง/u);
  assert.match(clean, /หนี้ที่ต้องกด "รับทราบ" ครั้งเดียว: 0 ข้อ/u);

  // ใส่หนี้ของจริงเข้าไป: ตัวเลขเงินที่ไม่อยู่ในตารางราคา แล้วยกเข้าสมองไปทั้งอย่างนั้น
  const db = openDb({ file });
  db.addKnowledge({ title: "โปรเก่า", content: "เคยลดเหลือ 9,500 บาท", updatedBy: "owner" });
  db.close();
  run(IMPORT_TOOL, ["--db", file, "--apply"]);

  const before = fingerprint(file);
  const dirty = run(PREVIEW_TOOL, ["--db", file, "--verbose"]);
  // ตัวเลขเดียวถูกจับสองชั้น: L02 (ดูการ์ดทีละใบ) และ G4 (ยิงด่านราคาจริงใส่ข้อความทั้งก้อน)
  assert.match(dirty, /หนี้ที่ต้องกด "รับทราบ" ครั้งเดียว: 2 ข้อ/u);
  assert.match(dirty, /\[รับทราบ\] L02/u);
  assert.match(dirty, /\[รับทราบ\] G4/u);
  // รายงานต้องเรียกการ์ดด้วยหัวข้อที่คนอ่านออก และบอกข้อความที่ติด เพื่อเคลียร์หนี้ได้ก่อนเปิดแฟล็ก
  assert.match(dirty, /\[บล็อก\] "โปรเก่า"/u, "ต้องบอกหัวข้อ ไม่ใช่ fact:<uuid>");
  assert.match(dirty, /L02 · ข้อความที่ติด: 9,500/u, "ต้องบอกข้อความที่ทำให้ติด");

  const after = fingerprint(file);
  assert.equal(after.sha, before.sha, "รายงานต้องไม่เขียนอะไรลงฐาน");
  assert.equal(walBytes(file), 0);
});

/* ------------------------------- brain-lints -------------------------------- */

test("brain-lints จัดกลุ่มผลด่านตามรหัสกฎ พร้อมชื่อการ์ด และไม่แตะไฟล์ฐาน", () => {
  const { file } = seededDbFile();
  const db = openDb({ file });
  // การ์ดที่จงใจให้ผิดหลายข้อพร้อมกัน: เบอร์ลูกค้า (L15) + ตัวเลขเงินนอกตารางราคา (L02)
  db.addKnowledge({ title: "โปรเก่า", content: "ราคาพิเศษ 59,000 บาท โทร 0812345678", updatedBy: "owner" });
  db.close();
  run(IMPORT_TOOL, ["--db", file, "--apply"]);
  const before = fingerprint(file);

  const out = run(LINTS_TOOL, ["--db", file]);
  assert.match(out, /ผลด่าน: pass/u);
  assert.match(out, /L15 — \d+ รายการ/u);
  assert.match(out, /— โปรเก่า/u, "ต้องบอกว่าเป็นการ์ดใบไหน ไม่ใช่ item id เปล่า ๆ");
  assert.match(out, /รวม \d+ รายการ/u);

  assert.deepEqual(fingerprint(file), before, "รายงานต้องไม่เปลี่ยนไฟล์ฐาน");
  assert.equal(walBytes(file), 0, "รายงานต้องไม่ commit อะไรลง WAL");

  // กรองเฉพาะกฎเดียวได้
  const only = run(LINTS_TOOL, ["--db", file, "--code", "L15"]);
  assert.match(only, /L15 —/u);
  assert.equal(/\nL02 —/u.test(only), false, "--code ต้องกรองกฎอื่นออก");
});

test("brain-lints บอกตรง ๆ เมื่อยังไม่มีสมอง และปฏิเสธเมื่อไม่ได้ระบุ --db", () => {
  const { file } = seededDbFile();
  assert.match(run(LINTS_TOOL, ["--db", file]), /ยังไม่มีเวอร์ชันสมองที่เป็น live/u);
  assert.match(run(LINTS_TOOL, [], { expectFail: true }), /ต้องระบุ --db/u);
});

test("brain-lints เทียบไฟล์รอบเรียนกับที่เวอร์ชันปักหมุดไว้", () => {
  const { dir, file } = seededDbFile();
  const rounds = join(dir, "class-rounds.json");
  writeFileSync(rounds, JSON.stringify({
    seatsPerRound: 12,
    classes: { onsite: { label: "คลาสสอนสด", product: "AI Agent for Business" } },
    rounds: [{ date: "2099-09-10", class: "onsite", status: "open" }],
  }));
  run(IMPORT_TOOL, ["--db", file, "--apply", "--rounds", rounds]);
  assert.match(run(LINTS_TOOL, ["--db", file, "--rounds", rounds]), /ตรงกับที่เวอร์ชันปักหมุดไว้/u);

  writeFileSync(rounds, JSON.stringify({
    seatsPerRound: 12,
    classes: { onsite: { label: "คลาสสอนสด", product: "AI Agent for Business" } },
    rounds: [{ date: "2099-10-10", class: "onsite", status: "open" }],
  }));
  assert.match(run(LINTS_TOOL, ["--db", file, "--rounds", rounds]), /ไม่ตรงกับที่เวอร์ชันปักหมุดไว้/u);
});

test("accountNumbers ใน config ทำให้ L15 เงียบกับเลขบัญชีของร้านเราเอง (ทั้งเส้นจากไฟล์ถึงรายงาน)", () => {
  const { dir, file } = seededDbFile();
  const db = openDb({ file });
  db.addKnowledge({ title: "วิธีชำระเงิน", content: "โอนเข้าเลขบัญชี 123-4-56789-0 ชื่อบัญชี บจก.ติดกระดุม", updatedBy: "owner" });
  db.close();

  // ยังไม่ได้ประกาศว่าเป็นเลขของเรา = ต้องถูกฟ้อง
  run(IMPORT_TOOL, ["--db", file, "--apply"]);
  assert.match(run(LINTS_TOOL, ["--db", file, "--code", "L15"]), /เลขบัญชี\/บัตรประชาชน/u);

  // ประกาศแล้วนำเข้าใหม่ = เงียบ (allowlist เปลี่ยน manifest จึงเกิดเวอร์ชันใหม่จริง)
  const allowFile = join(dir, "brain-lint-allowlist.json");
  writeFileSync(allowFile, JSON.stringify({ contacts: [], accountNumbers: ["123-4-56789-0"] }));
  run(IMPORT_TOOL, ["--db", file, "--apply", "--allowlist", allowFile]);

  const after = run(LINTS_TOOL, ["--db", file, "--code", "L15"]);
  assert.equal(/เลขบัญชี\/บัตรประชาชน/u.test(after), false, "เลขบัญชีของร้านเราเองต้องไม่ถูกฟ้องอีก");

  const check = openDb({ file });
  const manifest = JSON.parse(check.getBrainPointer("live").manifest_json);
  assert.deepEqual(
    manifest.lintAllowlist.find((entry) => entry.value === "123-4-56789-0"),
    { value: "123-4-56789-0", source: "config:brain-lint-allowlist:accountNumbers" },
    "ที่มาของเลขบัญชีต้องถูกบันทึกแยกจาก contacts",
  );
  check.close();
});
