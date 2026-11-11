// tag-framework-integration.test.mjs — กรอบป้ายชุดเดียวต่อเข้ากับ scorer / pipeline / เครื่องมือซ้อม
// กติกาเหล็ก: ไม่มีไฟล์กรอบ = พฤติกรรมเดิมทุกไบต์ · มีไฟล์กรอบ = ป้าย AI มาจากรายการปิดเท่านั้น
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/server.mjs";
import { openDb } from "../src/db.mjs";
import { buildScorerSystem, parseScorePayload } from "../src/scoring.mjs";
import { validateTagFramework } from "../src/tagFramework.mjs";
import { collectTagDryRun, renderTagDryRun } from "../tools/tag-framework-dry-run.mjs";
import { fixtureInput } from "./tagFrameworkFixture.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, promptText, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const fw = validateTagFramework(fixtureInput());

/* --------------------------------- scorer --------------------------------- */

test("tag framework scorer: without a framework file the prompt and parser behave exactly as before", () => {
  const plain = buildScorerSystem({ displayName: "ลูกค้า" });
  assert.ok(plain.includes("ป้ายพฤติกรรม/ความสนใจ 1-3 คำ"), "สัญญาเดิมของธุรกิจสินค้า");
  assert.ok(!plain.includes("รายการปิด"));
  assert.equal(buildScorerSystem({ displayName: "ลูกค้า", tagFramework: null }), plain);
  const raw = JSON.stringify({ score: 5, trend: "flat", tags: ["สนใจ X5 Pro", "ถามผ่อน 0%", "สนใจ X5 Pro"] });
  const parsed = parseScorePayload(raw);
  assert.deepEqual(parsed.tags, ["สนใจ X5 Pro", "ถามผ่อน 0%"]);
  assert.equal("tag_check" in parsed, false, "payload เดิมไม่มีฟิลด์ใหม่");
});

test("tag framework scorer: the closed list sits in the static prefix and replaces the free-text instruction", () => {
  const system = buildScorerSystem({ displayName: "ลูกค้าเอ", knownName: "เอ", lastScore: 4, tagFramework: fw });
  const list = system.indexOf('"สนใจ: AI Agent for Business"');
  const customer = system.indexOf("ข้อมูลลูกค้า:");
  assert.ok(list > 0 && customer > list, "รายการป้ายต้องมาก่อนข้อมูลที่เปลี่ยนตามห้อง (prompt caching)");
  assert.ok(system.includes("ป้ายจากรายการปิดด้านบนเท่านั้น"));
  assert.ok(!system.includes("ป้ายพฤติกรรม/ความสนใจ 1-3 คำ"));
  // ส่วนคงที่ต้องเหมือนกันทุกห้อง — ต่างกันได้เฉพาะหลังข้อมูลลูกค้า
  const other = buildScorerSystem({ displayName: "ลูกค้าบี", tagFramework: fw });
  assert.equal(system.slice(0, customer), other.slice(0, other.indexOf("ข้อมูลลูกค้า:")));
});

test("tag framework scorer: parser keeps closed values, rescues near misses and reports what it dropped", () => {
  const raw = JSON.stringify({
    score: 6, trend: "up",
    tags: ["สนใจ: AI Agent for Business", "ขั้น: ถามราคาคอร์ส", "สนใจ: เรียนทำขนม", "ขั้น: รอโอน", "อาชีพ: ร้านอาหาร/คาเฟ่"],
  });
  const parsed = parseScorePayload(raw, { tagFramework: fw });
  assert.deepEqual(parsed.tags, ["สนใจ: AI Agent for Business", "ขั้น: ถามราคา", "อาชีพ: ร้านอาหาร/คาเฟ่"]);
  assert.deepEqual(parsed.tag_check, { kept: 2, rescued: 1, dropped: 2 });
  assert.equal(parseScorePayload(JSON.stringify({ score: 11, tags: [] }), { tagFramework: fw }), null, "กติกาเดิมของ score ไม่เปลี่ยน");
});

/* -------------------------------- pipeline -------------------------------- */

function makeApp({ tagFramework = null, scorerTags = [], personaType = "unknown" } = {}) {
  const config = testConfig();
  const db = memoryDb();
  const hermesFetch = hermesFetchStub(JSON.stringify({
    score: 7, trend: "up", buying_signals: [], tags: scorerTags, persona_type: personaType,
    persona_read: { disc: "unknown", bank: "unknown", reason: "" },
  }));
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {}, ...(tagFramework ? { tagFramework } : {}) },
    logger: silent,
  });
  return { app, db, hermesFetch };
}

const aiTags = (db, id) => db.listTags(id).filter((t) => t.source === "ai").map((t) => t.tag).sort();

test("tag framework pipeline: no framework = scorer's free-text tags are written exactly as today", async () => {
  const { app, db } = makeApp({ scorerTags: ["ถามราคาคอร์ส", "สนใจ AI Agent"] });
  db.upsertCustomer("U-free", {});
  db.insertMessage({ customerId: "U-free", direction: "in", content: "คลาส AI Agent ราคาเท่าไหร่คะ" });
  await app.pipeline.scoreBurst("U-free");
  assert.deepEqual(aiTags(db, "U-free"), ["ถามราคาคอร์ส", "สนใจ AI Agent"]);
  db.close();
});

test("tag framework pipeline: scorer tags are merged into the closed framework before the write", async () => {
  const { app, db, hermesFetch } = makeApp({
    tagFramework: fw,
    scorerTags: ["สนใจ: AI Agent for Business", "สนใจ: เรียนทำขนม", "ขั้น: ถามรอบเรียน", "อาชีพ: ร้านอาหาร/คาเฟ่"],
    personaType: "restaurant_cafe",
  });
  const id = "U-framework";
  db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "in", content: "ร้านอาหารค่ะ อยากรู้รอบเรียนคลาส AI Agent" });
  // ป้ายเก่าแบบข้อความอิสระ + ป้ายระบบ + ป้ายที่ทีมติดเอง ก่อนเปิดกรอบ
  db.addTag(id, "ถามราคาคอร์ส", "ai");
  db.addTag(id, "Excel", "ai");
  db.addTag(id, "คลาสฟรี", "ai");
  db.addTag(id, "อาชีพ: เจ้าของกิจการ/SME", "human");
  db.addTag(id, "VIP", "human");

  await app.pipeline.scoreBurst(id);

  assert.deepEqual(aiTags(db, id), [
    "ขั้น: ถามรอบเรียน", // ป้ายเก่า "ถามราคาคอร์ส" แปลงเป็นถามราคา แล้วถูกขั้นใหม่ที่ไกลกว่าแทน
    "คลาสฟรี", // ป้ายบันทึกเหตุการณ์ (sticky) ไม่โดนล้าง
    "ใช้ทำ: ข้อมูล/Excel", // ป้ายเก่า "Excel" แปลงเข้ากรอบ ไม่หาย
    "สนใจ: AI Agent for Business",
  ].sort());
  const human = db.listTags(id).filter((t) => t.source === "human").map((t) => t.tag).sort();
  assert.deepEqual(human, ["VIP", "อาชีพ: เจ้าของกิจการ/SME"], "ป้ายของคนไม่โดนแตะ และ AI ไม่ติดอาชีพทับ");
  const scorerCall = hermesFetch.calls.find((call) => promptText(call.body.messages[0].content).includes("ป้ายลูกค้า (tags) = รายการปิด"));
  assert.ok(scorerCall, "scorer ต้องได้รายการปิด");
  db.close();
});

test("tag framework pipeline: an empty scorer answer keeps what the room already earned", async () => {
  const { app, db } = makeApp({ tagFramework: fw, scorerTags: [] });
  const id = "U-keep";
  db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "in", content: "ขอบคุณค่ะ" });
  db.addTag(id, "ขั้น: พร้อมสมัคร", "ai");
  db.addTag(id, "สนใจ: In-house", "ai");
  await app.pipeline.scoreBurst(id);
  assert.deepEqual(aiTags(db, id), ["ขั้น: พร้อมสมัคร", "สนใจ: In-house"]);
  db.close();
});

test("tag framework pipeline: BUSINESS_ID must match the framework's business", () => {
  assert.throws(() => createApp({
    config: testConfig({ BUSINESS_ID: "airdog" }),
    db: memoryDb(),
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), tagFramework: fw },
    logger: silent,
  }), /tag framework businessId/u);
});

/* ------------------------------ dry-run tool ------------------------------ */

function seedDryRunDb(file) {
  const db = openDb({ file });
  const at = Date.now();
  const rooms = [
    // [id, channel, tags(ai), tags(human)]
    ["U-line-1", "default", ["สนใจ AI Agent", "ถามราคา"], []],
    ["U-line-2", "default", ["เคยใช้ AI", "ถามระยะเวลาเรียน"], ["customer"]],
    ["U-line-3", "default", [], ["สนใจGEN AI Classroom"]],
    ["U-line-spam", "default", ["สนใจ AI Agent"], ["null"]],
    ["U-legacy", "default", [], ["ย้ายจาก LINE OA", "สนใจGEN AI Classroom"]],
    ["fb:psid-1", "facebook", ["สนใจ AI Agent", "ดูแลคนป่วย"], []],
  ];
  for (const [id, channel, ai, human] of rooms) {
    db.upsertCustomer(id, { channelId: channel });
    for (const tag of ai) db.addTag(id, tag, "ai");
    for (const tag of human) db.addTag(id, tag, "human");
  }
  db.raw.prepare("INSERT INTO score_history (id, customer_id, score, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("s1", "U-line-1", 6, JSON.stringify({ persona_type: "restaurant_cafe" }), at);
  db.setCustomerFact({ customerId: "U-line-2", factKey: "ai_level", value: "4", source: "human", evidence: "ทีมยืนยัน" });
  db.close();
}

test("tag framework dry-run: reads a copy without writing and reports only aggregates", () => {
  const dir = mkdtempSync(join(tmpdir(), "tag-dry-run-"));
  try {
    const file = join(dir, "copy.sqlite");
    seedDryRunDb(file);
    const before = createHash("sha256").update(readFileSync(file)).digest("hex");
    const sqlite = new DatabaseSync(file, { readOnly: true });
    const report = collectTagDryRun(sqlite, fw, { showRare: true });
    const text = renderTagDryRun(report, { showRare: true });
    const quiet = collectTagDryRun(sqlite, fw);
    assert.deepEqual(quiet.coverage.unmapped, [], "ป้ายที่ใช้ไม่ถึง 3 ห้องไม่ออกในรายงานปกติ (รวม --json)");
    assert.equal(quiet.coverage.unmappedTotal, report.coverage.unmappedTotal);
    sqlite.close();
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), before, "ไฟล์ฐานต้องไม่เปลี่ยนแม้แต่ไบต์เดียว");

    assert.deepEqual(report.customers, { total: 6, facebook: 1, legacyHistory: 1, reachableLine: 4, reachableNotSpam: 3 });
    const tagCount = (dimKey, tag) => report.after.dimensions.find((d) => d.key === dimKey).values.find((v) => v.tag === tag);
    assert.deepEqual(tagCount("สนใจ", "สนใจ: AI Agent for Business"), { tag: "สนใจ: AI Agent for Business", all: 3, reach: 2, facebook: 1 });
    assert.equal(tagCount("ระดับAI", "ระดับAI: 4 ใช้ประจำ").all, 1, "ระดับที่ทีมยืนยันชนะป้ายเก่า 'เคยใช้ AI'");
    assert.equal(tagCount("อาชีพ", "อาชีพ: ร้านอาหาร/คาเฟ่").all, 1, "persona เติมอาชีพให้");
    assert.equal(report.coverage.byDisposition.blocked, 1);
    const basic = report.segments.find((seg) => seg.id === "basic");
    assert.equal(basic.reachAi, 1, "คนซื้อแล้ว (customer) และสแปมไม่อยู่ในกลุ่ม");
    assert.equal(basic.reachWithHuman, 2, "ป้าย LINE OA เดิมที่รออนุมัติเพิ่มได้หนึ่งคน");
    assert.equal(basic.facebookAi, 1);

    for (const id of ["U-line-1", "U-line-2", "U-line-3", "U-line-spam", "U-legacy", "psid-1"]) {
      assert.ok(!text.includes(id), `รายงานห้ามมีรหัสลูกค้า ${id}`);
      assert.ok(!JSON.stringify(report).includes(id), `JSON ห้ามมีรหัสลูกค้า ${id}`);
    }
    assert.ok(!text.includes("ดูแลคนป่วย"), "ข้อมูลอ่อนไหวไม่ถูกพิมพ์แม้เป็นป้ายเก่า");
    assert.match(text, /บรอดแคสต์ LINE ส่งถึงจริง 4/u);
    assert.deepEqual(report.needsConfirmation, { values: [], humanMappings: 1 }, "fixture มีข้อเสนอแปลงป้ายเดิมที่รอยืนยัน 1 ข้อ");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
