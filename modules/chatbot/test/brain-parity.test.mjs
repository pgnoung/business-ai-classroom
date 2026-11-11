// brain-parity.test.mjs — หัวใจของเฟส 1a
//
// สมองที่คอมไพล์จากการ์ด ต้องประกอบของออกมา "ตรงทุกตัวอักษร" กับสิ่งที่เส้นเดิมประกอบ
// จากตารางเดิม ตัวเทียบคือฟังก์ชันเดิมของ runtime เองทุกตัว (composeKnowledgeForChannel,
// db.approvedPrices, composeTagRules, seatRuleLines∘upcomingRounds, hashtagBusinessKeywords)
// — ห้ามลอกตรรกะมาเขียนใหม่แล้วเทียบกับสำเนาของตัวเอง เพราะความผิดที่เหมือนกันสองฝั่ง
// จะไม่มีวันถูกจับได้ นั่นคือทั้งหมดที่เฟสนี้มีไว้พิสูจน์
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, testConfig } from "./helpers.mjs";
import { composeKnowledgeForChannel, KNOWLEDGE_HEADER, KNOWLEDGE_MAX_CHARS } from "../src/knowledgePack.mjs";
import { composeTagRules, PRODUCT_RULES_KEY } from "../src/tags.mjs";
import { seatRuleLines, upcomingRounds } from "../src/classRounds.mjs";
import { hashtagBusinessKeywords } from "../src/pipeline.mjs";
import { FREECLASS_PATTERNS_KEY } from "../src/db.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { compileBrain, knowledgeBlockFor } from "../src/brain/compile.mjs";
import { brainParityLogLine, brainParityReport } from "../src/brain/parity.mjs";
import { projectVersionToLegacy } from "../src/brain/project.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLOCK = 1_700_000_000_000;
const TODAY = "2098-12-01";
const QUIET = { warn() {}, debug() {}, log() {} };

// คลังจริงมีทั้งความรู้กลาง ความรู้เฉพาะสาขา ราคาหลายรายการ กติกาหลายบรรทัด
// รอบที่จำกัดที่นั่งและรอบที่ไม่จำกัด — เทสต์ต้องเหมือนของจริง ไม่ใช่เคสสวย ๆ ใบเดียว
function seedRealisticDb(db) {
  db.addKnowledge({ title: "แคตตาล็อกคลาสและราคา", content: "AI Agent for Business 19,900 บาท\nEarly Bird 12,900 บาท", updatedBy: "owner" });
  db.addKnowledge({ title: "วิธีสมัคร", content: "ทักแชทแล้วทีมงานส่งลิงก์ชำระเงินให้ค่ะ", updatedBy: "owner" });
  db.addKnowledge({ title: "สถานที่เรียน", content: "สอนสดที่กรุงเทพ ใกล้ BTS", updatedBy: "chomphu" });
  const off = db.addKnowledge({ title: "โปรเก่าที่ปิดแล้ว", content: "โปรปีที่แล้ว", updatedBy: "owner" });
  db.updateKnowledge(off.id, { active: false, updatedBy: "owner" });
  db.addKnowledge({ title: "สำนวนเฉพาะเฟซบุ๊ก", content: "ตอบสั้นและมี quick reply", updatedBy: "owner", channelId: "facebook" });
  db.addKnowledge({ title: "คำถามที่เจอบ่อยบนเฟซบุ๊ก", content: "ถามเรื่องหางาน ให้พาเข้าคลาสออนไลน์", updatedBy: "owner", channelId: "facebook" });

  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setApprovedPrice("Early Bird", 12900);
  db.setApprovedPrice("คลาสออนไลน์", 11900);

  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ\n- ห้ามเสนอส่วนลดเองทุกกรณี\nคลาสออนไลน์ไม่มีที่นั่งจำกัด");
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["https://line.me/freeclass", "https://pngoung.com/free"]));
  db.setSetting("hashtag_business_keywords", JSON.stringify({
    "#online": "สนใจคลาสเรียนออนไลน์",
    "#class": { seed: "สนใจคลาสสอนสด", note: "จากงานสัมมนา" },
    claude10x: {
      seed: "ขอรับไฟล์ Claude Project Setup",
      note: "ไฟล์ที่ผู้ดูแลยืนยัน",
      deliveryText: "รับไฟล์ได้ที่ https://drive.google.com/example",
    },
  }));
  db.setSetting("hashtag_silence", "0");
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "รอบสอนสด มกราคม", product: "AI Agent for Business", status: "open", capacity: 15 },
    { date: "2099-02-20", classKey: "onsite", label: "รอบสอนสด กุมภาพันธ์", product: "AI Agent for Business", status: "open", capacity: 20 },
    { date: "2099-03-05", classKey: "online", label: "รอบออนไลน์ มีนาคม", product: "AI Agent for Business", status: "open" },
  ]));
  db.setSetting("class_enrolled", JSON.stringify({ "2099-01-10": 15, "2099-02-20": 7 }));
}

function importAndCompile(db, options = {}) {
  const result = importCurrentSourcesAsVersion1(db, { now: () => CLOCK });
  return { result, bundle: compileBrain(db, result.versionId, { logger: QUIET, ...options }) };
}

test("บล็อกความรู้ที่คอมไพล์ออกมา ตรงทุกไบต์กับ composeKnowledgeForChannel ทุกช่องทาง", () => {
  const db = memoryDb();
  seedRealisticDb(db);
  const { bundle } = importAndCompile(db);

  // สาขา default (โหมด shared) = คลังกลาง
  assert.equal(
    knowledgeBlockFor(bundle, db, "default"),
    composeKnowledgeForChannel({ db, channelId: "default", logger: QUIET }),
  );
  // สาขา facebook ที่ยังเป็น shared = ต้องได้คลังกลางเหมือนกันเป๊ะ
  assert.equal(
    knowledgeBlockFor(bundle, db, "facebook"),
    composeKnowledgeForChannel({ db, channelId: "facebook", logger: QUIET }),
  );
  // สลับเป็นสมองแยก = ต้องได้คลังของสาขานั้นเท่านั้น และยังตรงทุกไบต์
  db.setSetting("brain_mode:facebook", "separate");
  assert.equal(
    knowledgeBlockFor(bundle, db, "facebook"),
    composeKnowledgeForChannel({ db, channelId: "facebook", logger: QUIET }),
  );
  assert.notEqual(knowledgeBlockFor(bundle, db, "facebook"), knowledgeBlockFor(bundle, db, "default"));
  db.close();
});

test("ตารางราคาที่ guard บริโภค ตรงกับ db.approvedPrices ทั้งค่าและลำดับ", () => {
  const db = memoryDb();
  seedRealisticDb(db);
  const { bundle } = importAndCompile(db);
  // node:sqlite คืนแถวเป็น object ที่ไม่มี prototype — ผ่าน JSON หนึ่งรอบเพื่อเทียบ
  // "คีย์ ลำดับ และค่า" ล้วน ๆ โดยไม่ติดรายละเอียดการสร้าง object ของไดรเวอร์
  const plain = (rows) => JSON.parse(JSON.stringify(rows));
  assert.deepEqual(bundle.guardTables.approvedPrices, plain(db.approvedPrices()));
  assert.equal(JSON.stringify(bundle.guardTables.approvedPrices), JSON.stringify(db.approvedPrices()));
  // guard สร้าง Set ของ amount จากตารางนี้ — ชุดยอดที่ยอมรับต้องเท่ากันด้วย
  assert.deepEqual(
    new Set(bundle.guardTables.approvedAmounts),
    new Set(db.approvedPrices().map((row) => Number(row.amount))),
  );
  db.close();
});

test("กติกาสินค้าตรงทั้งสตริงดิบและบรรทัดที่ถูกฉีดเข้า prompt", () => {
  const db = memoryDb();
  seedRealisticDb(db);
  const { bundle } = importAndCompile(db);
  const raw = db.getSetting(PRODUCT_RULES_KEY) || "";
  assert.equal(bundle.rules.productRules, raw);
  assert.deepEqual(bundle.rules.productRulesLines, composeTagRules({ tags: [], productRules: raw }));
  db.close();
});

test("บรรทัดที่นั่งตรงกับ seatRuleLines(upcomingRounds(...)) รวมรอบเต็ม รอบเหลือ และรอบไม่จำกัด", () => {
  const db = memoryDb();
  seedRealisticDb(db);
  const { bundle } = importAndCompile(db, { todayIso: TODAY });
  const expected = seatRuleLines(upcomingRounds({ file: null, db, todayIso: TODAY, logger: QUIET }));

  assert.deepEqual(bundle.rules.seatRuleLines, expected);
  // ยืนยันว่าเคสจริงถูกครอบจริง ไม่ใช่ทั้งสองฝั่งว่างเปล่าแล้วผ่าน
  assert.ok(expected.some((line) => line.includes("เต็มแล้ว")), "ต้องมีรอบที่เต็ม");
  assert.ok(expected.some((line) => line.includes("เหลือ 13 ที่นั่ง")), "ต้องมีรอบที่เหลือที่นั่ง");
  assert.ok(expected.some((line) => line.includes("ราคาพิเศษมีจำนวนจำกัด")), "ต้องมีรอบที่ไม่จำกัดที่นั่ง");
  db.close();
});

test("ลิงก์คลาสฟรีและคีย์เวิร์ด # ตรงกับสิ่งที่โค้ดเดิมอ่านจาก settings", () => {
  const db = memoryDb();
  seedRealisticDb(db);
  const { bundle } = importAndCompile(db);
  assert.deepEqual(bundle.rules.freeclassPatterns, JSON.parse(db.getSetting(FREECLASS_PATTERNS_KEY)));
  assert.deepEqual(
    bundle.rules.hashtag.businessKeywords,
    hashtagBusinessKeywords({ db, config: { hashtagBusinessKeywords: {} } }),
  );
  assert.equal(bundle.rules.hashtag.businessKeywords.claude10x.deliveryText,
    "รับไฟล์ได้ที่ https://drive.google.com/example", "structured delivery ต้องรอด source -> version -> compile");
  assert.equal(bundle.rules.hashtag.silence, db.getSetting("hashtag_silence"));
  db.close();
});

test("projection รุ่นสมองคืน structured campaign delivery ลง settings ครบทุกช่อง", () => {
  const db = memoryDb({ now: () => CLOCK });
  seedRealisticDb(db);
  const { result } = importAndCompile(db);
  db.setSetting("hashtag_business_keywords", JSON.stringify({ "#changed": "คนละค่า" }));
  db.brainTransaction(() => projectVersionToLegacy(db, result.versionId, { todayIso: TODAY }));
  const restored = JSON.parse(db.getSetting("hashtag_business_keywords"));
  assert.deepEqual(restored.claude10x, {
    seed: "ขอรับไฟล์ Claude Project Setup",
    note: "ไฟล์ที่ผู้ดูแลยืนยัน",
    deliveryText: "รับไฟล์ได้ที่ https://drive.google.com/example",
  });
  db.close();
});

test("brainParityReport บอกว่าตรงบน DB จริง และบอกชิ้นที่ต่างเมื่อแหล่งเปลี่ยนหลังคอมไพล์", () => {
  const db = memoryDb({ now: () => CLOCK });
  seedRealisticDb(db);
  importCurrentSourcesAsVersion1(db, { now: () => CLOCK });

  const ok = brainParityReport(db, { todayIso: TODAY, classRoundsFile: null });
  assert.equal(ok.ok, true, JSON.stringify(ok.mismatches));
  assert.equal(ok.reason, "match");

  // แก้ตารางเดิมโดยไม่นำเข้าใหม่ = สมองล้าสมัย รายงานต้องชี้ชิ้นที่ต่าง ไม่ใช่เงียบ
  db.setApprovedPrice("AI Agent for Business", 21900);
  db.setSetting(PRODUCT_RULES_KEY, "เปลี่ยนกติกาแล้ว");
  const drift = brainParityReport(db, { todayIso: TODAY, classRoundsFile: null });
  assert.equal(drift.ok, false);
  const parts = drift.mismatches.map((m) => m.part);
  assert.ok(parts.includes("guardTables.approvedPrices"));
  assert.ok(parts.includes("rules.productRules"));
  for (const mismatch of drift.mismatches) assert.notEqual(mismatch.expectedSha, mismatch.actualSha);

  // นำเข้าใหม่แล้วต้องกลับมาตรง
  importCurrentSourcesAsVersion1(db, { now: () => CLOCK + 1 });
  assert.equal(brainParityReport(db, { todayIso: TODAY, classRoundsFile: null }).ok, true);
  db.close();
});

test("ยังไม่เคยนำเข้า = รายงานตอบ no_brain_version ไม่ใช่ล้ม (บูตต้องไม่พังเพราะสมองว่าง)", () => {
  const db = memoryDb();
  seedRealisticDb(db);
  const report = brainParityReport(db, { todayIso: TODAY });
  assert.equal(report.ok, true);
  assert.equal(report.versionId, null);
  assert.equal(report.reason, "no_brain_version");
  db.close();
});

test("แหล่งว่างทั้งหมด: บล็อกความรู้เป็นสตริงว่างเท่ากันสองฝั่ง และ parity ยังตรง", () => {
  const db = memoryDb();
  const { bundle } = importAndCompile(db, { todayIso: TODAY });
  assert.equal(bundle.promptBlocks.knowledge.central, "");
  assert.equal(knowledgeBlockFor(bundle, db, "default"), composeKnowledgeForChannel({ db, channelId: "default", logger: QUIET }));
  assert.deepEqual(bundle.guardTables.approvedPrices, []);
  assert.equal(bundle.rules.productRules, "");
  assert.deepEqual(bundle.rules.productRulesLines, []);
  assert.deepEqual(bundle.rules.seatRuleLines, []);
  assert.deepEqual(bundle.rules.freeclassPatterns, []);
  assert.equal(brainParityReport(db, { todayIso: TODAY, classRoundsFile: null }).ok, true);
  db.close();
});

test("เพดาน 80,000 ตัวอักษร: การ์ดที่ถูกตัดต้องเป็นใบเดียวกับที่เส้นเดิมตัด", () => {
  const db = memoryDb();
  // ห้าใบเต็มเพดานต่อรายการ (KNOWLEDGE_CONTENT_MAX = 20,000) รวมกันเกิน 80,000
  // ตัวตัดของ buildKnowledgeSection ต้องทิ้ง "เก่าสุด" ก่อน — คอมไพเลอร์ต้องทิ้งใบเดียวกัน
  const big = "ก".repeat(20000);
  db.addKnowledge({ title: "เก่าสุด", content: big, updatedBy: "owner" });
  for (const title of ["ใบสอง", "ใบสาม", "ใบสี่"]) db.addKnowledge({ title, content: big, updatedBy: "owner" });
  db.addKnowledge({ title: "ใหม่สุด", content: big, updatedBy: "owner" });

  const { bundle } = importAndCompile(db);
  const expected = composeKnowledgeForChannel({ db, channelId: "default", logger: QUIET });
  assert.equal(knowledgeBlockFor(bundle, db, "default"), expected);
  assert.equal(expected.includes("[เก่าสุด]"), false, "ของเก่าสุดต้องถูกตัดจริง ๆ ไม่งั้นเทสต์นี้ไม่ได้ทดสอบอะไร");
  assert.ok(expected.includes("[ใหม่สุด]"));

  // ไบต์ยังตรงกับทางเดิมทุกตัวอักษร (เฟสนี้ห้ามแก้พฤติกรรมการตัด) แต่ L07 ต้อง "ดัง"
  // ว่ามีของตกขอบอยู่ ไม่ใช่เงียบเพราะไปวัดผลของการตัดเอง
  const l07 = bundle.lints.filter((finding) => finding.code === "L07");
  assert.equal(l07.length, 1, "คลังที่ล้นต้องมีคำเตือน L07");
  assert.match(l07[0].message, /รายการถูกตัดทิ้ง/u);
  assert.equal(bundle.budget.usage.central.droppedCount > 0, true);
  assert.ok(bundle.budget.usage.central.totalChars > bundle.budget.pinnedChars.central);
  db.close();
});

test("รายการเดียวที่ยาวเกินเพดาน: ทั้งสองฝั่งตัดที่จุดเดียวกัน", () => {
  const db = memoryDb();
  // addKnowledge ตัดที่ KNOWLEDGE_CONTENT_MAX อยู่แล้ว จึงเขียนแถวยาวเข้าไปตรง ๆ
  // (DB จริงมีแถวที่มาก่อนกติกานั้นได้ และตัวเทียบก็อ่านจากตารางเหมือนกัน)
  db.raw.prepare(
    `INSERT INTO knowledge_entries (id,title,content,active,updated_by,channel_id,source,
       provenance_json,supersedes_id,superseded_by,version,deleted_at,created_at,updated_at)
     VALUES ('legacy-big','ใบเดียวยาวมาก',?,1,'owner',NULL,'human_console','{}',NULL,NULL,1,NULL,1,1)`,
  ).run("ข".repeat(KNOWLEDGE_MAX_CHARS + 5000));
  const { bundle } = importAndCompile(db);
  const expected = composeKnowledgeForChannel({ db, channelId: "default", logger: QUIET });
  assert.equal(knowledgeBlockFor(bundle, db, "default"), expected);
  // header + "\n" + เนื้อที่ถูกตัดพอดีเพดาน — ยืนยันว่าการตัดเกิดขึ้นจริง
  assert.equal([...expected].length, [...KNOWLEDGE_HEADER].length + 1 + KNOWLEDGE_MAX_CHARS);
  db.close();
});

test("ลำดับความรู้ที่มี created_at เท่ากัน ตัดสินด้วย rowid เหมือน listActiveKnowledge", () => {
  const db = memoryDb();
  // memoryDb ใช้ now จริง — สามใบที่เพิ่มติดกันมักได้ created_at เท่ากัน จึงชน tie-break พอดี
  for (const title of ["ใบที่หนึ่ง", "ใบที่สอง", "ใบที่สาม"]) {
    db.addKnowledge({ title, content: `เนื้อหาของ${title}`, updatedBy: "owner" });
  }
  const { bundle } = importAndCompile(db);
  assert.equal(
    knowledgeBlockFor(bundle, db, "default"),
    composeKnowledgeForChannel({ db, channelId: "default", logger: QUIET }),
  );
  db.close();
});

test("สวิตช์ BRAIN_SHADOW_PARITY ปิดโดยค่าเริ่มต้น และเปิดได้จาก env เท่านั้น", () => {
  assert.equal(testConfig().brainShadowParity, false);
  assert.equal(testConfig({ BRAIN_SHADOW_PARITY: "true" }).brainShadowParity, true);
  assert.equal(testConfig({ BRAIN_SHADOW_PARITY: "false" }).brainShadowParity, false);
});

test("บรรทัด log ตอนบูตบอกผลตรง ๆ และไม่มีเนื้อหาความรู้หรือข้อมูลลูกค้าอยู่ในนั้น", () => {
  assert.match(brainParityLogLine({ ok: true, versionId: null, reason: "no_brain_version", mismatches: [] }), /ยังไม่มีเวอร์ชันสมอง/u);
  assert.match(brainParityLogLine({ ok: true, versionId: "v-1", reason: "match", mismatches: [] }), /ตรง version=v-1/u);
  const drift = brainParityLogLine({
    ok: false, versionId: "v-1", reason: "mismatch",
    mismatches: [{ part: "guardTables.approvedPrices", expectedSha: "a", actualSha: "b" }],
  });
  assert.match(drift, /ไม่ตรง/u);
  assert.match(drift, /guardTables\.approvedPrices/u);
  // sha ไม่ควรอยู่ใน log บรรทัดเดียว (ชื่อชิ้นพอให้ช่างไปดูต่อ)
  assert.equal(drift.includes("expectedSha"), false);
});

test("รอบเรียนที่ยังอยู่ในไฟล์ (ยังไม่เคยกรอกในคอนโซล) ต้องเข้าสมองด้วย ไม่งั้น parity ตาบอด", () => {
  const db = memoryDb({ now: () => CLOCK });
  seedRealisticDb(db);
  // ยังไม่เคยกรอกรอบในคอนโซล = upcomingRounds ตกไปอ่านไฟล์ (ลำดับความสำคัญของโค้ดเดิม)
  db.setSetting("class_rounds_manual", JSON.stringify([]));
  const dir = mkdtempSync(join(tmpdir(), "brain-rounds-"));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify({
    seatsPerRound: 12,
    classes: { onsite: { label: "คลาสสอนสด", product: "AI Agent for Business" } },
    rounds: [{ date: "2099-04-10", class: "onsite", status: "open" }],
  }));

  const result = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, classRoundsFile: file, logger: QUIET });
  const bundle = compileBrain(db, result.versionId, { todayIso: TODAY, logger: QUIET });

  assert.deepEqual(
    bundle.rules.seatRuleLines,
    seatRuleLines(upcomingRounds({ file, db, todayIso: TODAY, logger: QUIET })),
  );
  assert.equal(brainParityReport(db, { todayIso: TODAY, classRoundsFile: file }).ok, true);
  // sha ของไฟล์ที่ปักหมุดต้องถูกบันทึกไว้ในเวอร์ชัน
  const manifest = JSON.parse(db.getBrainVersion(result.versionId).manifest_json);
  assert.match(manifest.pinnedFiles.classRounds.sha256, /^[a-f0-9]{64}$/u);
  db.close();
});

test("มีเวอร์ชันอยู่แต่ไม่มีรุ่นไหนเป็น live = รายงานว่าไม่ตรง ไม่ใช่เงียบว่าไม่มีอะไรผิด", () => {
  const db = memoryDb({ now: () => CLOCK });
  seedRealisticDb(db);
  const result = importCurrentSourcesAsVersion1(db, { now: () => CLOCK, logger: QUIET });
  db.raw.prepare("UPDATE brain_versions SET pointer = NULL WHERE version_id = ?").run(result.versionId);

  const report = brainParityReport(db, { todayIso: TODAY, classRoundsFile: null });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "no_live_pointer");
  assert.match(brainParityLogLine(report), /ไม่มีรุ่นไหนถูกตั้งเป็น live/u);
  db.close();
});

test("รอบวันเดียวกันคนละชื่อ: บรรทัดที่นั่งต้องเรียงเหมือนแหล่ง ไม่ใช่เรียงตามชื่อการ์ด", () => {
  const db = memoryDb();
  // "ข" มาก่อน "ก" ในแหล่ง — ถ้าคอมไพเลอร์เรียงตามคีย์ (ซึ่งมีชื่อรอบอยู่ด้วย)
  // สองบรรทัดนี้จะสลับที่ = คนละไบต์ ทั้งที่เนื้อหาเหมือนกันทุกอย่าง
  db.setSetting("class_rounds_manual", JSON.stringify([
    { date: "2099-01-10", classKey: "onsite", label: "ขรอบบ่าย", product: "คลาส", status: "open", capacity: 10 },
    { date: "2099-01-10", classKey: "onsite", label: "กรอบเช้า", product: "คลาส", status: "open", capacity: 10 },
    { date: "2099-02-20", classKey: "onsite", label: "รอบถัดไป", product: "คลาส", status: "open", capacity: 10 },
  ]));
  db.setSetting("class_enrolled", JSON.stringify({ "2099-01-10": 3, "2099-02-20": 1 }));

  const { bundle } = importAndCompile(db, { todayIso: TODAY });
  const expected = seatRuleLines(upcomingRounds({ file: null, db, todayIso: TODAY, logger: QUIET }));
  assert.deepEqual(bundle.rules.seatRuleLines, expected);
  // ยืนยันว่าเคสนี้แยกความต่างได้จริง: บรรทัดของ "ขรอบบ่าย" ต้องมาก่อน "กรอบเช้า"
  const order = expected.filter((line) => line.includes("รอบ")).map((line) => line);
  assert.ok(order.findIndex((l) => l.includes("ขรอบบ่าย")) < order.findIndex((l) => l.includes("กรอบเช้า")));
  db.close();
});
