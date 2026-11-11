// starter-import.test.mjs — ตัวนำเข้า business pack ของนักเรียน (tools/starter-import.mjs)
//
// สิ่งที่ต้องจริงเสมอ: ตรวจไม่ผ่าน = ไม่เขียนอะไร · ซ้อม = ไม่เขียนอะไร · เขียนผ่านทางเดียวกับคอนโซล
// · นำเข้าซ้ำไม่ซ้ำแถว · สินค้าที่หายไป = ปิด ไม่ลบ · แตะเฉพาะแถวของ starter-import
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { poisonGlobalFetch } from "./helpers.mjs";
import { openDb } from "../src/db.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { brainParityReport } from "../src/brain/parity.mjs";
import { loadImageCatalog } from "../src/imageCatalog.mjs";
import {
  loadPack, validatePack, planImport, applyImport, main, STARTER_SOURCE, personaMarkdown,
} from "../tools/starter-import.mjs";

poisonGlobalFetch();

const FIXTURE = fileURLToPath(new URL("./fixtures/starter-pack", import.meta.url));
const QUIET = { log() {}, warn() {}, error() {}, debug() {} };
const BRAND_WORDS = ["ลูกแพร", "พี่ง้วง", "Pngoung", "pngoung", "ติดกระดุม", "Airdog"];

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "starter-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = join(root, "pack");
  cpSync(FIXTURE, pack, { recursive: true });
  return { root, pack, dbFile: join(root, "chassis.sqlite") };
}

const editJson = (pack, name, fn) => {
  const file = join(pack, name);
  writeFileSync(file, JSON.stringify(fn(JSON.parse(readFileSync(file, "utf8"))), null, 2));
};

function run(argv, deps = {}) {
  const out = [], err = [];
  const code = main(argv, {
    stdout: (s) => out.push(s), stderr: (s) => err.push(s),
    config: { knowledgeVersioned: false }, logger: QUIET, bannedWords: [], safetyRules: [], ...deps,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function counts(dbFile) {
  if (!existsSync(dbFile)) return { knowledge: 0, prices: 0 };
  const db = openDb({ file: dbFile });
  try {
    return {
      knowledge: db.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_entries").get().n,
      prices: db.approvedPrices().length,
    };
  } finally { db.close(); }
}

function prepared(packDir) {
  const pack = loadPack(packDir);
  const { errors, images } = validatePack(pack);
  assert.deepEqual(errors, [], "fixture ต้องผ่านการตรวจ");
  return { pack, images };
}

test("ตรวจไม่ผ่าน: รายงานทุกข้อพร้อมชื่อไฟล์+ฟิลด์ และไม่เขียนอะไรเลย", (t) => {
  // Arrange
  const { root, pack, dbFile } = workspace(t);
  editJson(pack, "business.json", (b) => ({ ...b, businessId: "Bad Slug!" }));
  editJson(pack, "products.json", (list) => [
    { ...list[0], id: "BAD_ID" },
    { ...list[1], price: -5 },
    { ...list[1], name: "อีกชื่อ", image: "images/missing.png" },
    { id: "escape", name: "หลุด", price: 1, image: "../outside.png" },
  ]);
  writeFileSync(join(root, "outside.png"), "x");
  writeFileSync(join(pack, "faq.json"), "{ not json");
  const personaOut = join(root, "persona.md");

  // Act
  const res = run(["--pack", pack, "--db", dbFile, "--apply", "--persona-out", personaOut]);

  // Assert
  assert.equal(res.code, 1);
  assert.match(res.err, /business\.json\.businessId: ต้องเป็น slug/u);
  assert.match(res.err, /products\.json\[0\]\.id: ต้องเป็น slug/u);
  assert.match(res.err, /products\.json\[1\]\.price: ต้องเป็นตัวเลขมากกว่าหรือเท่ากับ 0/u);
  assert.match(res.err, /products\.json\[2\]\.id: "drip-bag" ซ้ำ/u);
  assert.match(res.err, /products\.json\[2\]\.image: ไม่พบไฟล์/u);
  assert.match(res.err, /products\.json\[3\]\.image: path ต้องอยู่ในโฟลเดอร์ pack/u);
  assert.match(res.err, /faq\.json: อ่าน JSON ไม่ได้/u);
  assert.equal(existsSync(dbFile), false, "ห้ามสร้าง/เขียนฐาน");
  assert.equal(existsSync(personaOut), false, "ห้ามเขียนไฟล์ขาออก");
});

test("ตรวจไม่ผ่าน: symlink ที่ชี้ออกนอก pack และไฟล์ที่ไม่ใช่รูปจริงถูกปฏิเสธ", (t) => {
  // Arrange
  const { root, pack } = workspace(t);
  writeFileSync(join(root, "secret.png"), Buffer.from("89504e470d0a1a0a0000", "hex"));
  symlinkSync(join(root, "secret.png"), join(pack, "images", "link.png"));
  writeFileSync(join(pack, "images", "fake.jpg"), "not an image");
  editJson(pack, "products.json", (list) => [
    { ...list[0], image: "images/link.png" },
    { ...list[1], image: "images/fake.jpg" },
  ]);

  // Act
  const { errors } = validatePack(loadPack(pack));

  // Assert
  assert.ok(errors.some((e) => /products\.json\[0\]\.image: .*symlink/u.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /products\.json\[1\]\.image: เนื้อไฟล์ไม่ใช่รูป jpg/u.test(e)), errors.join("\n"));
});

test("ซ้อม (ค่าตั้งต้น): พิมพ์แผนแต่ไม่แตะฐานและไม่เขียนไฟล์ขาออก", (t) => {
  // Arrange
  const { root, pack, dbFile } = workspace(t);
  openDb({ file: dbFile }).close();
  const before = counts(dbFile);
  const outs = ["persona.md", "starter.env", "catalog.json"].map((f) => join(root, f));

  // Act
  const res = run([
    "--pack", pack, "--db", dbFile, "--image-dir", join(root, "img"), "--public-base", "https://shop.example.com",
    "--persona-out", outs[0], "--env-out", outs[1], "--catalog-out", outs[2],
  ]);

  // Assert
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /ซ้อม/u);
  assert.match(res.out, /การ์ดความรู้: เพิ่ม 7/u); // ร้าน 1 + สินค้า 3 + FAQ 2 + ไฟล์ความรู้ 1
  assert.match(res.out, /ตารางราคา: เพิ่ม 3/u);
  assert.deepEqual(counts(dbFile), before);
  for (const f of [...outs, join(root, "img")]) assert.equal(existsSync(f), false, `${f} ต้องยังไม่ถูกเขียน`);
});

test("--apply: เขียนการ์ดสินค้า/FAQ/ความรู้/ข้อมูลร้าน + ราคา โดยติด source starter-import", (t) => {
  // Arrange
  const { pack, dbFile } = workspace(t);

  // Act
  const res = run(["--pack", pack, "--db", dbFile, "--apply"]);

  // Assert
  assert.equal(res.code, 0, res.err);
  const db = openDb({ file: dbFile });
  t.after(() => db.close());
  const rows = db.listKnowledge();
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.source === STARTER_SOURCE && r.updated_by === STARTER_SOURCE && r.active === 1));
  const blend = rows.find((r) => r.title === "สินค้า: เมล็ดกาแฟเฮาส์เบลนด์");
  assert.match(blend.content, /ราคา: 290 บาท \/ ถุง 250 กรัม/u);
  assert.match(blend.content, /house blend/u);
  assert.match(blend.content, /หมวด: เมล็ดกาแฟ/u);
  assert.ok(rows.some((r) => r.title === "คำถามที่พบบ่อย: บดให้ได้ไหม" && /ตอบ: บดให้ฟรี/u.test(r.content)));
  assert.ok(rows.some((r) => r.title === "วิธีชงแนะนำ" && /15 กรัม/u.test(r.content)));
  const shop = rows.find((r) => r.title === "ข้อมูลร้าน บ้านสวนคอฟฟี่");
  assert.match(shop.content, /ช่องทางชำระเงิน: โอนธนาคาร, บัตร/u);
  assert.match(shop.content, /ค่าจัดส่ง: 50 บาท/u);
  const prices = Object.fromEntries(db.approvedPrices().map((r) => [r.label, r.amount]));
  assert.deepEqual(prices, { "กาแฟดริปซอง": 150, "เมล็ดกาแฟเฮาส์เบลนด์": 290, "โคลด์บรูว์ขวด": 89 });
  assert.ok(db.raw.prepare("SELECT 1 FROM admin_audit WHERE action = 'starter_import'").get(), "ต้องมีแถว audit");
});

test("นำเข้าซ้ำ: ไม่มีแถวซ้ำ และแผนรอบสองเป็นศูนย์", (t) => {
  // Arrange
  const { pack, dbFile } = workspace(t);
  assert.equal(run(["--pack", pack, "--db", dbFile, "--apply"]).code, 0);
  const first = counts(dbFile);

  // Act
  const second = run(["--pack", pack, "--db", dbFile, "--apply"]);

  // Assert
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /เพิ่ม 0 · แก้ 0 · ปิด 0 · เหมือนเดิม 7/u);
  assert.match(second.out, /ผล: unchanged/u);
  assert.deepEqual(counts(dbFile), first);
  const db = openDb({ file: dbFile });
  t.after(() => db.close());
  const { pack: p, images } = prepared(pack);
  assert.equal(planImport(db, p, images).changes, 0);
});

test("ลบสินค้าออก/active:false: ปิดการ์ดและถอดราคา (ไม่ลบแถวความรู้) แถวของคนอื่นไม่ถูกแตะ", (t) => {
  // Arrange
  const { pack, dbFile } = workspace(t);
  assert.equal(run(["--pack", pack, "--db", dbFile, "--apply"]).code, 0);
  const seed = openDb({ file: dbFile });
  seed.addKnowledge({ title: "ความรู้ที่เจ้าของเพิ่มเอง", content: "เปิดร้านวันหยุด", updatedBy: "owner" });
  seed.setApprovedPrice("ราคาที่เจ้าของตั้งเอง", 500);
  seed.close();
  editJson(pack, "products.json", (list) => [list[0], { ...list[1], active: false }]); // ตัด cold-brew ทิ้ง + ปิด drip-bag

  // Act
  const res = run(["--pack", pack, "--db", dbFile, "--apply"]);

  // Assert
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /ปิด 2/u);
  const db = openDb({ file: dbFile });
  t.after(() => db.close());
  const byTitle = new Map(db.listKnowledge().map((r) => [r.title, r]));
  assert.equal(byTitle.get("สินค้า: โคลด์บรูว์ขวด").active, 0);
  assert.equal(byTitle.get("สินค้า: กาแฟดริปซอง").active, 0);
  assert.equal(byTitle.get("สินค้า: เมล็ดกาแฟเฮาส์เบลนด์").active, 1);
  assert.equal(byTitle.get("ความรู้ที่เจ้าของเพิ่มเอง").active, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM knowledge_entries WHERE deleted_at IS NOT NULL").get().n, 0);
  assert.deepEqual(db.approvedPrices().map((r) => r.label).sort(), ["ราคาที่เจ้าของตั้งเอง", "เมล็ดกาแฟเฮาส์เบลนด์"].sort());

  // นำเข้ารอบถัดไปด้วย pack เดิม = ไม่มีอะไรต้องทำ (ของที่ปิดแล้วไม่ถูกนับซ้ำ)
  const { pack: p, images } = prepared(pack);
  assert.equal(planImport(db, p, images).changes, 0);
});

test("ราคาชื่อเดียวกับที่เจ้าของตั้งเองอยู่แล้ว = ปฏิเสธ ไม่เขียนทับ", (t) => {
  // Arrange
  const { pack, dbFile } = workspace(t);
  const seed = openDb({ file: dbFile });
  seed.setApprovedPrice("โคลด์บรูว์ขวด", 120);
  seed.close();

  // Act
  const res = run(["--pack", pack, "--db", dbFile, "--apply"]);

  // Assert
  assert.equal(res.code, 1);
  assert.match(res.err, /ราคา "โคลด์บรูว์ขวด" มีอยู่แล้ว/u);
  assert.deepEqual(counts(dbFile), { knowledge: 0, prices: 1 });
});

// ด่านสมอง (lint L02 ตัวเลขนอกตารางราคา / L15 @handle) ใช้กับการนำเข้าเหมือนเจ้าของกดในคอนโซล
const lintCleanBusiness = (b) => ({
  ...b, contact: { ...b.contact, lineId: "" }, shipping: { ...b.shipping, fee: "คิดตามน้ำหนัก" },
});

function versionedDb(t, dbFile) {
  const db = openDb({ file: dbFile });
  t.after(() => db.close());
  const todayIso = todayInBangkok(Date.now());
  assert.equal(importCurrentSourcesAsVersion1(db, { createdBy: "owner", logger: QUIET, todayIso }).created, true);
  return { db, todayIso };
}

test("แฟล็กเปิด + ด่านสมองบล็อก: ไม่เขียนอะไร และการซ้อมบอกล่วงหน้า", (t) => {
  // Arrange
  const { pack, dbFile } = workspace(t);
  const { db } = versionedDb(t, dbFile);
  const seqBefore = db.getBrainPointer("live").seq;
  const { pack: p, images } = prepared(pack);

  // Act
  const result = applyImport(db, p, images, { config: { knowledgeVersioned: true }, logger: QUIET });
  const dry = run(["--pack", pack, "--db", dbFile], { config: { knowledgeVersioned: true } });

  // Assert
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "blocked");
  assert.match(result.error, /1,000/u);
  assert.equal(db.listKnowledge().length, 0, "ตารางเดิมต้องไม่ขยับ");
  assert.equal(db.approvedPrices().length, 0);
  assert.equal(db.getBrainPointer("live").seq, seqBefore);
  assert.equal(dry.code, 1);
  assert.match(dry.err, /ซ้อมเขียนบนสำเนาแล้วไม่ผ่าน/u);
});

test("แฟล็ก KNOWLEDGE_VERSIONED เปิด: นำเข้าเป็นรุ่นสมองใหม่ 1 รุ่น และ parity ยังตรง", (t) => {
  // Arrange
  const { pack, dbFile } = workspace(t);
  editJson(pack, "business.json", lintCleanBusiness);
  editJson(pack, "products.json", (list) => list.map((x) => ({ ...x, unit: "ถุง", description: "คั่วสดทุกสัปดาห์" })));
  writeFileSync(join(pack, "knowledge", "brewing.md"), "# วิธีชงแนะนำ\n\nใช้น้ำร้อนพอดี ไม่เดือดจัด\n");
  const { db, todayIso } = versionedDb(t, dbFile);
  const seqBefore = db.getBrainPointer("live").seq;
  const { pack: p, images } = prepared(pack);

  // Act
  const result = applyImport(db, p, images, { config: { knowledgeVersioned: true }, logger: QUIET });
  const again = applyImport(db, p, images, { config: { knowledgeVersioned: true }, logger: QUIET });

  // Assert
  assert.equal(result.ok, true, result.error);
  assert.equal(result.outcome, "live");
  assert.equal(db.getBrainPointer("live").seq, seqBefore + 1);
  const parity = brainParityReport(db, { todayIso, logger: QUIET });
  assert.equal(parity.ok, true, JSON.stringify(parity.mismatches));
  assert.equal(again.outcome, "unchanged");
  assert.equal(db.getBrainPointer("live").seq, seqBefore + 1, "รอบสองต้องไม่สร้างรุ่นใหม่");
});

test("ไฟล์ขาออก: persona/env/catalog/รูป มีเนื้อหาถูกต้องและไม่มีชื่อแบรนด์ของใคร", (t) => {
  // Arrange
  const { root, pack, dbFile } = workspace(t);
  const files = { persona: join(root, "out", "persona.md"), env: join(root, "out", "starter.env"), catalog: join(root, "out", "catalog.json") };
  const imgDir = join(root, "img");

  // Act
  const res = run([
    "--pack", pack, "--db", dbFile, "--apply", "--image-dir", imgDir, "--public-base", "https://shop.example.com/",
    "--persona-out", files.persona, "--env-out", files.env, "--catalog-out", files.catalog,
  ]);

  // Assert
  assert.equal(res.code, 0, res.err);
  const persona = readFileSync(files.persona, "utf8");
  assert.match(persona, /น้องมะลิ/u);
  assert.match(persona, /ค่ะ/u);
  assert.match(persona, /ห้ามใช้ ครับ/u);
  assert.match(persona, /เป็น AI ไหม.*ตอบตามจริงว่าเป็นผู้ช่วย AI ของ บ้านสวนคอฟฟี่/u);
  assert.match(persona, /ตารางราคาที่อนุมัติแล้วเท่านั้น/u);
  assert.match(persona, /ลูกค้าร้องเรียนเรื่องสินค้า/u);
  assert.match(persona, /ห้ามบอกว่ากาแฟรักษาโรค/u);
  for (const word of BRAND_WORDS) assert.equal(persona.includes(word), false, `persona ต้องไม่มี "${word}"`);

  const env = readFileSync(files.env, "utf8");
  assert.match(env, /^BUSINESS_PROFILE=generic$/mu);
  assert.match(env, /^BRAND_AGENT_NAME=น้องมะลิ$/mu);
  assert.match(env, /^PERSONA_PARTICLES=female$/mu);
  assert.match(env, /^CONSOLE_BRAND_THEME=starter$/mu);
  assert.match(env, new RegExp(`^PERSONA_FILE=${files.persona.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  assert.match(env, /^IMAGE_CATALOG_FILE=/mu);
  assert.equal(/["']/u.test(env.split("\n").slice(1).join("\n")), false, "ห้ามใส่เครื่องหมายคำพูด");

  const catalog = loadImageCatalog(files.catalog, { logger: QUIET });
  assert.deepEqual(catalog.map((c) => [c.key, c.url]), [
    ["house-blend", "https://shop.example.com/img/house-blend.png"],
    ["drip-bag", "https://shop.example.com/img/drip-bag.jpg"],
  ]);
  assert.equal(existsSync(join(imgDir, "house-blend.png")), true);
  assert.equal(existsSync(join(imgDir, "drip-bag.jpg")), true);
});

test("persona เพศชาย/กลาง ใช้คำลงท้ายตามเพศ และ env ไม่เปิด PERSONA_PARTICLES", (t) => {
  // Arrange
  const { root, pack, dbFile } = workspace(t);
  editJson(pack, "business.json", (b) => ({ ...b, agentGender: "male", agentName: "น้องภู" }));
  const envFile = join(root, "s.env");

  // Act
  const res = run(["--pack", pack, "--db", dbFile, "--apply", "--env-out", envFile]);
  const male = personaMarkdown({ ...loadPack(pack).business });
  const neutral = personaMarkdown({ ...loadPack(pack).business, agentGender: "neutral" });

  // Assert
  assert.equal(res.code, 0, res.err);
  assert.match(male, /ครับ \/ นะครับ/u);
  assert.match(neutral, /ไม่ระบุเพศ/u);
  assert.match(readFileSync(envFile, "utf8"), /^PERSONA_PARTICLES=$/mu);
});

test("CLI: --help พิมพ์วิธีใช้ ขาด argument = exit 1 และ --public-base ต้องเป็น https", () => {
  // Arrange / Act
  const help = run(["--help"]);
  const missing = run(["--pack", "x"]);
  const insecure = run(["--pack", "x", "--db", "y", "--public-base", "http://shop.example.com", "--catalog-out", "c.json"]);

  // Assert
  assert.equal(help.code, 0);
  assert.match(help.out, /--pack <dir> --db <sqlite>/u);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /--db: ต้องระบุ/u);
  assert.equal(insecure.code, 1);
  assert.match(insecure.err, /--public-base: ต้องเป็น https/u);
});

test("price: null = ไม่มีราคาตายตัว: เข้าการ์ดสินค้าแต่ไม่เข้าตารางราคา", (t) => {
  // Arrange
  const { pack, dbFile } = workspace(t);
  editJson(pack, "products.json", (list) => [...list, { id: "custom-roast", name: "คั่วตามสั่ง", price: null, description: "คั่วตามโปรไฟล์ที่ลูกค้าเลือก" }]);

  // Act
  const res = run(["--pack", pack, "--db", dbFile, "--apply"]);

  // Assert
  assert.equal(res.code, 0, res.err);
  const db = openDb({ file: dbFile });
  t.after(() => db.close());
  const card = db.listKnowledge().find((r) => r.title === "สินค้า: คั่วตามสั่ง");
  assert.match(card.content, /ไม่มีราคาตายตัว ทีมงานประเมินให้/u);
  assert.ok(!db.approvedPrices().some((r) => r.label === "คั่วตามสั่ง"));
});
