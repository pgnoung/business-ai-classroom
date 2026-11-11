// owner-lessons.test.mjs — ตรรกะของ "สอนลูกแพรจากแผง 'ทำไมตอบแบบนี้'" (src/ownerLessons.mjs)
//
// สิ่งที่ไฟล์นี้กัน (ข้อมูลสังเคราะห์ทั้งหมด ไม่มีชื่อ/แชทลูกค้าจริง):
//   1. เลือกบทเรียนตามคำที่ลูกค้าเพิ่งพูด (ตัดคำไทย) ไม่ใช่สุ่มหรือเอาทั้งคลัง
//   2. งบตัวอักษรต่อเทิร์นต้องไม่ถูกเกิน — เรื่องที่ใหญ่เกินถูกข้าม ไม่ใช่ตัดครึ่ง
//   3. ไม่มีบทเรียน/หยุดไว้ = ไม่แตะ draftArgs เลย (พรอมต์เดิมทุกไบต์)
//   4. หัวข้อในพรอมต์ประกาศลำดับชั้นตรง ๆ: ใต้กติกาเงิน/การส่งต่อ เหนือกติกาการเขียน
//   5. ด่านความเป็นส่วนตัวกัน "ค่า" (เบอร์/อีเมล/เลขยาว/ชื่อลูกค้าห้องนั้น) ไม่ใช่ "คำ"
import test from "node:test";
import assert from "node:assert/strict";
import {
  OWNER_LESSON_LIMITS, OWNER_LESSON_MONEY_REMINDER, OWNER_LESSON_RULES, OWNER_LESSONS_PAUSED_KEY, OWNER_LESSONS_TITLE,
  applyOwnerLessons, buildOwnerLessonsSection, cleanLessonText, lessonPrivacyRefusal, lessonTeachingKey, lessonTerms,
  lessonTitle, oneLine, ownerLessonMetadata, pickOwnerLessons, recordOwnerLessonUse, suggestLessonTopic,
} from "../src/ownerLessons.mjs";
import { withPriceDirectiveCapture, classifyPriceDirectives } from "../src/priceDirectives.mjs";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

let seq = 0;
function lesson(overrides = {}) {
  seq += 1;
  return {
    id: `lesson-${seq}`, status: "active", topic: "", customer_text: "", ai_text: "", teaching: "ตอบให้สั้นและสุภาพ",
    decided_at: 1_000 + seq, created_at: 1_000 + seq, updated_at: 1_000 + seq, ...overrides,
  };
}

/* ------------------------------- เลือกบทเรียน ------------------------------- */

test("เลือกบทเรียน: เรื่องที่คำตรงกับสิ่งที่ลูกค้าเพิ่งพูดขึ้นก่อน ไม่ใช่เรื่องใหม่สุด", () => {
  const parking = lesson({ topic: "ที่จอดรถ", customer_text: "มีที่จอดรถไหมคะ", teaching: "บอกว่าจอดรถได้ที่อาคารเรียน แล้วถามว่ามากี่คน", decided_at: 10 });
  const online = lesson({ topic: "คลาสออนไลน์", customer_text: "เรียนออนไลน์ได้ไหม", teaching: "ชวนดูรอบออนไลน์ก่อน", decided_at: 20 });
  const tone = lesson({ topic: "น้ำเสียง", teaching: "ห้ามใช้คำว่าจัดให้", decided_at: 30 });
  const chosen = pickOwnerLessons([tone, online, parking], { text: "จอดรถได้ที่ไหนคะ", history: [] });
  assert.equal(chosen[0].id, parking.id, "เรื่องที่จอดรถต้องมาก่อน");
  assert.ok(chosen.some((row) => row.id === tone.id), "เรื่องล่าสุดหนึ่งเรื่องติดไปด้วยเสมอ (ถ้ายังไม่ถูกเลือก)");
  assert.ok(!chosen.some((row) => row.id === online.id), "เรื่องที่ไม่เกี่ยวและไม่ใช่เรื่องล่าสุดต้องไม่ติดมา");
});

test("เลือกบทเรียน: ดูสามข้อความล่าสุดของลูกค้า (ประวัติสองข้อ + ข้อความตอนนี้) ไม่ใช่ข้อความของบอท", () => {
  const refund = lesson({ topic: "คืนเงิน", teaching: "เรื่องคืนเงินให้ส่งต่อทีมงาน", decided_at: 1 });
  const newest = lesson({ topic: "ทักทาย", teaching: "ทักด้วยชื่อเล่นถ้าลูกค้าบอกชื่อแล้ว", decided_at: 99 });
  const history = [
    { role: "user", content: "สมัครแล้วขอคืนเงินได้ไหม" },
    { role: "assistant", content: "ทักทาย ยินดีค่ะ" },
    { role: "user", content: "ถามไว้ก่อนค่ะ" },
  ];
  const chosen = pickOwnerLessons([newest, refund], { text: "โอเคค่ะ", history });
  assert.equal(chosen[0].id, refund.id, "คำว่าคืนเงินในประวัติของลูกค้าต้องดึงบทเรียนเรื่องคืนเงินได้");
  const botOnly = pickOwnerLessons([refund], { text: "โอเค", history: [{ role: "assistant", content: "เรื่องคืนเงินค่ะ" }] });
  assert.deepEqual(botOnly.map((row) => row.id), [refund.id], "ข้อความบอทไม่นับเป็นคำลูกค้า — ติดมาเพราะเป็นเรื่องล่าสุดเท่านั้น");
});

test("เลือกบทเรียน: ใกล้เรื่องสูงสุด 3 + เรื่องล่าสุดอีก 1 และเฉพาะที่ใช้อยู่", () => {
  const rows = Array.from({ length: 6 }, (_, i) => lesson({ topic: `รอบเรียน ${i}`, teaching: `รอบเรียนตอบแบบที่ ${i}`, decided_at: i }));
  const pending = lesson({ status: "pending", topic: "รอบเรียน", teaching: "รอบเรียนรออนุมัติ", decided_at: 100 });
  const newest = lesson({ topic: "เรื่องอื่น", teaching: "ปิดท้ายด้วยคำถามเดียว", decided_at: 50 });
  const chosen = pickOwnerLessons([pending, newest, ...rows], { text: "รอบเรียนถัดไปวันไหน" });
  assert.equal(chosen.length, 4);
  assert.equal(chosen.filter((row) => row.topic.startsWith("รอบเรียน")).length, 3);
  assert.equal(chosen[3].id, newest.id, "เรื่องล่าสุดตามมาเป็นลำดับสุดท้าย");
  assert.ok(!chosen.some((row) => row.status !== "active"), "บทเรียนที่รออนุมัติห้ามเข้าพรอมต์");
});

test("เลือกบทเรียน: งบตัวอักษรต่อเทิร์นไม่ถูกเกิน — เรื่องที่ใหญ่เกินงบถูกข้าม ไม่ใช่ตัดครึ่ง", () => {
  // คำสอนยาวเต็มเพดานที่เก็บได้จริง (600) — ยาวกว่านี้บันทึกไม่ได้ตั้งแต่ต้น
  const long = "ก".repeat(OWNER_LESSON_LIMITS.teaching - 1);
  const rows = Array.from({ length: 5 }, (_, i) => lesson({
    topic: `ราคา${i}`, customer_text: "ราคาเท่าไหร่ ".repeat(20), ai_text: "คำตอบเดิม ".repeat(30), teaching: `${long}${i}`,
  }));
  const small = lesson({ topic: "ราคาสั้น", teaching: "ตอบราคาตามตารางเท่านั้น", decided_at: 1 });
  const chosen = pickOwnerLessons([...rows, small], { text: "ราคาเท่าไหร่" });
  const section = buildOwnerLessonsSection(chosen);
  const body = section.text.split("\n").filter((line) => !line.startsWith("- ") && line !== OWNER_LESSONS_TITLE).join("\n");
  assert.ok(body.length <= OWNER_LESSON_LIMITS.budget, `เนื้อบทเรียนต้องไม่เกินงบ (${body.length})`);
  assert.ok(chosen.length >= 1 && chosen.length < rows.length + 1, "ต้องมีบางเรื่องถูกข้ามเพราะงบ");
  assert.ok(chosen.every((row) => section.text.includes(row.teaching)), "เรื่องที่ถูกเลือกต้องเข้าเต็มทั้งคำสอน");
});

test("เลือกบทเรียน: ข้อความที่ไม่มีคำให้จับ (สติกเกอร์/รูป) ได้แค่เรื่องล่าสุด", () => {
  const a = lesson({ topic: "ที่จอดรถ", teaching: "จอดที่อาคาร", decided_at: 1 });
  const b = lesson({ topic: "น้ำเสียง", teaching: "สุภาพ อบอุ่น", decided_at: 2 });
  assert.deepEqual(pickOwnerLessons([a, b], { text: "" }).map((row) => row.id), [b.id]);
  assert.deepEqual(pickOwnerLessons([], { text: "จอดรถ" }), []);
});

test("ตัดคำ: ทิ้งคำลงท้าย/คำเล็กที่ไม่บอกเรื่อง", () => {
  const terms = lessonTerms("มีที่จอดรถไหมคะ ราคาเท่าไหร่ครับ");
  assert.ok(terms.has("จอด") && terms.has("ราคา"));
  for (const noise of ["คะ", "ครับ", "ไหม", "มี", "ที่"]) assert.ok(!terms.has(noise), `ต้องทิ้ง "${noise}"`);
});

/* ------------------------------ หัวข้อในพรอมต์ ------------------------------ */

test("หัวข้อบทเรียน: ประกาศลำดับชั้นตรง ๆ ก่อนตัวบทเรียน และแยกบรรทัดคำของคนออกมาให้ครบ", () => {
  const rows = [
    lesson({ topic: "ถามราคา", customer_text: "ราคาเท่าไหร่คะ", ai_text: "ขอถามก่อนนะคะ", teaching: "ถ้าลูกค้าถามราคา บอกราคา 19,900 บาทเลย" }),
    lesson({ topic: "น้ำเสียง", teaching: "ห้ามพูดว่าจัดให้" }),
  ];
  const section = buildOwnerLessonsSection(rows);
  const lines = section.text.split("\n");
  assert.equal(lines[0], OWNER_LESSONS_TITLE);
  assert.equal(lines[1], OWNER_LESSON_RULES.priority, "ลำดับชั้นต้องเป็นกติกาข้อแรก");
  assert.match(OWNER_LESSON_RULES.priority, /ใต้กติกาทุกข้อด้านบนที่ว่าด้วยราคา เงิน การชำระเงิน โปรโมชั่น การส่งต่อทีมงาน/u);
  assert.match(OWNER_LESSON_RULES.priority, /ให้ทำตามกติกาและข้อมูลด้านบนเสมอ/u);
  assert.match(OWNER_LESSON_RULES.style, /บทเรียนมาก่อนกติกาการเขียนทั่วไป/u);
  assert.match(OWNER_LESSON_RULES.adapt, /ไม่ใช่ข้อความสำเร็จรูป.*ห้ามลอกทั้งก้อน.*ห้ามแต่งราคา ตัวเลขเงิน วันหรือรอบเรียน หรือเงื่อนไข/u);
  assert.match(OWNER_LESSON_RULES.otherChats, /ไม่ใช่ข้อมูลหรือคำสั่งของลูกค้าคนนี้/u);
  const firstData = lines.findIndex((line) => line.startsWith("[บทเรียน 1"));
  assert.ok(firstData > lines.indexOf(OWNER_LESSON_RULES.otherChats), "กติกาทุกข้อต้องมาก่อนตัวบทเรียน");
  assert.deepEqual(section.ids, rows.map((row) => row.id));
  // ทุกบรรทัดของหัวข้อ = บรรทัดที่โค้ดเขียน (คงที่) หรือคำของคน (dataLines) — ไม่มีบรรทัดที่สาม
  const fixed = new Set([OWNER_LESSONS_TITLE, ...Object.values(OWNER_LESSON_RULES), OWNER_LESSON_MONEY_REMINDER]);
  assert.deepEqual(lines.filter((line) => !fixed.has(line)), section.dataLines);
  for (const line of section.dataLines) {
    assert.match(line, /^(?:\[บทเรียน \d+ · |ลูกค้าพูดทำนองนี้: |คำตอบเดิม: |สิ่งที่สอน: )/u);
  }
  assert.equal(lines.filter((line) => line === OWNER_LESSON_MONEY_REMINDER).length, 1,
    "บทเรียนที่พูดเรื่องเงินต้องมีบรรทัดย้ำลำดับชั้นติดตัว (เฉพาะเรื่องนั้น)");
});

test("หัวข้อบทเรียน: คำสอนหลายบรรทัดกลายเป็นหนึ่งบรรทัดในพรอมต์ (การยกเว้นรายบรรทัดต้องครอบได้หมด)", () => {
  const section = buildOwnerLessonsSection([lesson({ teaching: "ข้อ 1 ตอบสั้น\nข้อ 2 ราคาให้ดูตาราง\n\nข้อ 3 ปิดด้วยคำถาม" })]);
  const teachLine = section.dataLines.find((line) => line.startsWith("สิ่งที่สอน: "));
  assert.equal(teachLine, "สิ่งที่สอน: ข้อ 1 ตอบสั้น ข้อ 2 ราคาให้ดูตาราง ข้อ 3 ปิดด้วยคำถาม");
  const captured = withPriceDirectiveCapture(() => buildOwnerLessonsSection([lesson({ teaching: "ราคาให้ดูตาราง\nบอกโปรได้" })]).text);
  const withoutIgnore = classifyPriceDirectives(captured);
  assert.ok(withoutIgnore.unclassified.some((line) => line.startsWith("สิ่งที่สอน: ")),
    "ถ้าไม่ยกเว้น คำสอนเรื่องราคาต้องถูกจับว่าไม่มีข้าง — พิสูจน์ว่าการยกเว้นมีผลจริงและเจาะจง");
  assert.deepEqual(withoutIgnore.bySide.quote, []);
  assert.deepEqual(withoutIgnore.bySide.defer, []);
  assert.ok(withoutIgnore.bySide.neutral.length >= 2, "บรรทัดกติกาที่เอ่ยเรื่องเงินประกาศข้าง neutral");
});

test("หัวข้อบทเรียน: ไม่มีบทเรียน = สตริงว่าง", () => {
  assert.deepEqual(buildOwnerLessonsSection([]), { text: "", ids: [], dataLines: [] });
});

/* --------------------------------- runtime --------------------------------- */

test("runtime: ไม่มีบทเรียนที่ใช้อยู่ = ไม่แตะ draftArgs เลยแม้แต่ไบต์เดียว", () => {
  const db = memoryDb();
  const rules = "กติกาที่ห้ามละเมิดเด็ดขาด:\n- ตอบสั้น";
  const draftArgs = { rules, knowledge: "k", persona: "p" };
  assert.deepEqual(applyOwnerLessons({ db, draftArgs, text: "จอดรถ" }), []);
  assert.equal(draftArgs.rules, rules);
  // มีแต่แถวที่รออนุมัติ/ปิดไว้ ก็ยังต้องไม่แตะ
  db.addOwnerLesson({ teaching: "จอดรถที่อาคาร", teachingKey: "a", status: "pending", createdBy: "chompoo" });
  const disabled = db.addOwnerLesson({ teaching: "จอดรถฟรี", teachingKey: "b", status: "active", createdBy: "ngoung" });
  db.setOwnerLessonEnabled(disabled.id, false, "ngoung");
  assert.deepEqual(applyOwnerLessons({ db, draftArgs, text: "จอดรถ" }), []);
  assert.equal(draftArgs.rules, rules);
  db.close();
});

test("runtime: มีบทเรียน = ต่อท้ายกติกาทุกข้อ และคืน id ที่ใช้ · กดหยุดไว้ = ไม่แตะ", () => {
  const db = memoryDb();
  const row = db.addOwnerLesson({ teaching: "บอกที่จอดรถอาคาร B", teachingKey: "parking", topic: "ที่จอดรถ", status: "active", createdBy: "ngoung" });
  const draftArgs = { rules: "กติกา" };
  assert.deepEqual(applyOwnerLessons({ db, draftArgs, text: "จอดรถตรงไหน" }), [row.id]);
  assert.ok(draftArgs.rules.startsWith("กติกา\n" + OWNER_LESSONS_TITLE), "หัวข้อต้องต่อท้ายกติกาเดิมตรง ๆ");
  db.setSetting(OWNER_LESSONS_PAUSED_KEY, "1");
  const paused = { rules: "กติกา" };
  assert.deepEqual(applyOwnerLessons({ db, draftArgs: paused, text: "จอดรถตรงไหน" }), []);
  assert.equal(paused.rules, "กติกา");
  db.close();
});

test("runtime: ขอบเขตช่องทาง — บทเรียนของสาขาหนึ่งไม่ข้ามไปอีกสาขา แต่บทเรียนกลางใช้ได้ทุกที่", () => {
  const db = memoryDb();
  const shared = db.addOwnerLesson({ teaching: "จอดรถอาคาร B", teachingKey: "s", status: "active", createdBy: "ngoung" });
  const branch = db.addOwnerLesson({ teaching: "จอดรถสาขาเชียงใหม่", teachingKey: "c", channelId: "cnx", status: "active", createdBy: "ngoung" });
  const onDefault = { rules: "r" };
  applyOwnerLessons({ db, draftArgs: onDefault, channelId: "default", text: "จอดรถ" });
  assert.ok(onDefault.rules.includes(shared.teaching));
  assert.ok(!onDefault.rules.includes(branch.teaching));
  const onBranch = { rules: "r" };
  applyOwnerLessons({ db, draftArgs: onBranch, channelId: "cnx", text: "จอดรถ" });
  assert.ok(onBranch.rules.includes(shared.teaching) && onBranch.rules.includes(branch.teaching));
  db.close();
});

test("runtime: ฐานข้อมูลพัง = ตอบต่อโดยไม่มีบทเรียน (ห้ามลากเส้นตอบลูกค้าล้ม)", () => {
  const draftArgs = { rules: "r" };
  const broken = { activeOwnerLessons() { throw new Error("disk"); }, getSetting: () => null };
  assert.deepEqual(applyOwnerLessons({ db: broken, draftArgs, text: "x", logger: { debug() {} } }), []);
  assert.equal(draftArgs.rules, "r");
});

test("metadata/นับการใช้: จดเฉพาะเทิร์นที่ข้อความมาจากโมเดลจริง และรวมกับ brainRetrieval เดิม", () => {
  assert.deepEqual(ownerLessonMetadata([], {}), {});
  assert.deepEqual(ownerLessonMetadata(["a"], { deterministic: true }), {});
  assert.deepEqual(ownerLessonMetadata(["a", "b"], {}), { metadata: { ownerLessons: ["a", "b"] } });
  assert.deepEqual(ownerLessonMetadata(["a"], { brainRetrieval: { selected: 2 } }),
    { metadata: { brainRetrieval: { selected: 2 }, ownerLessons: ["a"] } });
  const db = memoryDb();
  const row = db.addOwnerLesson({ teaching: "ตอบสั้น", teachingKey: "k", status: "active", createdBy: "ngoung" });
  assert.equal(recordOwnerLessonUse(db, [row.id], { deterministic: true }), 0);
  assert.equal(recordOwnerLessonUse(db, [row.id]), 1);
  assert.equal(db.getOwnerLesson(row.id).use_count, 1);
  assert.ok(db.getOwnerLesson(row.id).last_used_at > 0);
  db.close();
});

/* ------------------------------ ข้อความและความเป็นส่วนตัว ------------------------------ */

test("ความเป็นส่วนตัว: กันค่าที่ระบุตัวคน แต่ไม่กันคำที่พูดถึงเรื่องนั้น", () => {
  const names = ["สมศรีทดสอบ", "Fixture Name"];
  for (const bad of [
    "ส่งอีเมล fixture@example.com ให้ลูกค้า", "โทร 081-234-5678 ได้เลย", "เบอร์ร้าน 02 123 4567",
    "โอนเข้าบัญชี 123-4-56789-0", "ลูกค้าชื่อสมศรีทดสอบชอบคลาสเย็น", "fixture name ถามบ่อย",
    "ส่งไปที่ U0123456789abcdef0123456789abcdef",
  ]) {
    assert.ok(lessonPrivacyRefusal(bad, names), `ต้องกัน: ${bad}`);
  }
  for (const fine of [
    "ถ้าลูกค้าขอเบอร์ ให้บอกว่าคุยในแชทนี้ได้เลย", "ที่อยู่ของคลาสให้ตอบตามความรู้", "ราคา 19,900 บาทให้ยึดตาราง",
    "ส่งลิงก์ https://example.com/class ให้ดู", "ปิดรับสมัครวันที่ 10/12", "พี่ง้วงสอนเอง",
  ]) {
    assert.equal(lessonPrivacyRefusal(fine, names), "", `ต้องผ่าน: ${fine}`);
  }
});

test("ข้อความ: ตัดช่องว่าง ตัดความยาวแบบไม่ผ่ากลางตัวอักษร และหัวข้อสำรองมาจากคำสอน", () => {
  assert.equal(oneLine("  ก  ข\nค  ", 10), "ก ข ค");
  assert.equal(oneLine("กขคงจฉชซฌญ", 5), "กขคง…");
  assert.equal(cleanLessonText("ข้อ 1\r\n\r\n\r\nข้อ 2   ต่อ", 100), "ข้อ 1\n\nข้อ 2 ต่อ");
  assert.equal(lessonTitle({ topic: "", teaching: "ตอบสั้นๆ ก่อน แล้วค่อยถาม" }), "ตอบสั้นๆ ก่อน แล้วค่อยถาม");
  assert.equal(lessonTitle({ topic: "ที่จอดรถ", teaching: "x" }), "ที่จอดรถ");
});

test("กุญแจกันซ้ำ: ต่างแค่ช่องว่าง/จุดท้าย/ตัวพิมพ์ = เรื่องเดียวกัน", () => {
  assert.equal(lessonTeachingKey("ตอบสั้น ๆ  ก่อน."), lessonTeachingKey("ตอบสั้น ๆ ก่อน"));
  assert.equal(lessonTeachingKey("Reply SHORT!"), lessonTeachingKey("reply short"));
  assert.notEqual(lessonTeachingKey("ตอบสั้น"), lessonTeachingKey("ตอบยาว"));
});

test("หัวข้อที่เดาให้: มาจากคำถามล่าสุดของลูกค้า ตัดคำลงท้าย และยาวไม่เกิน 40 ตัวอักษร", () => {
  assert.equal(suggestLessonTopic(["สวัสดีค่ะ", "มีที่จอดรถไหมคะ?"]), "มีที่จอดรถไหม");
  const long = suggestLessonTopic(["อยากทราบรายละเอียดคลาสออนไลน์ที่สอนการใช้ AI กับงานบัญชีของบริษัทขนาดเล็กค่ะ"]);
  assert.ok([...long].length <= 40 && long.length > 0, long);
  assert.equal(suggestLessonTopic(["มีที่จอดรถไหมคะ มากันสามคนค่ะ"]), "มีที่จอดรถไหม", "หยิบวลีคำถาม ไม่ใช่ทั้งประโยค");
  assert.equal(suggestLessonTopic(["ราคาคลาสออนไลน์เท่าไหร่คะ", "ค่ะ"]), "ราคาคลาสออนไลน์เท่าไหร่",
    "ข้อความล่าสุดที่เหลือแต่คำลงท้าย ให้ถอยไปดูข้อความก่อนหน้า");
  assert.equal(suggestLessonTopic(["โทร [contact-number] ได้ค่ะ"]), "โทร ได้", "ส่วนที่ถูกลบข้อมูลระบุตัวไม่ติดมาในหัวข้อ");
  assert.equal(suggestLessonTopic([]), "");
});
