// reply-teacher-task.test.mjs — งานของเทิร์นแบบครู (การ์ดเปิดเท่านั้น): ระดับที่เพิ่งตอบ · ประโยคผลลัพธ์ไม่ใช่การบ้าน · จังหวะราคา · จุดคุ้มค่าที่เพิ่งพูด
import test from "node:test";
import assert from "node:assert/strict";
import { interestWording, ladderLevelAnswer, LEVEL_TEACHER, teacherPlan } from "../src/replyEngineV3/teacherTask.mjs";
import { SCREEN_VALUE_LINE } from "../src/replyEngineV3/stageTasks.mjs";

const LADDER = "1️⃣ ยังไม่เคยใช้เลย (แต่สนใจมากๆ อยากรู้ว่าใช้ยังไง)\n\n2️⃣ เคยลองเล่นนิดหน่อย";
const plan = (text, band = [170, 280]) => ({ thai: "งาน", band, closingShort: "ปิด", text: `## งาน\nความยาว: ราว ${band[0]}–${band[1]} ตัวอักษร (ไม่นับช่องเติม)\n${text}` });

test("ระดับที่เพิ่งตอบ: 'ข้อ N แปลว่า…' กลายเป็นความหมายแบบครูของระดับนั้น ไม่ทวนตัวเลือก", () => {
  const out = interestWording({ text: "1. ปฏิกิริยาสั้น ๆ แล้วพูดถึงรายละเอียดของเขาต่อในประโยคเดียวกัน — เขาตอบระดับ 1 ร้อยเข้ากับประโยค เช่น \"ข้อ 1 แปลว่า…\"" }).text;
  assert.match(out, /เขาเพิ่งตอบระดับ 1 — ร้อยเข้ากับประโยคแรกแบบครู/u);
  assert.match(out, /ไม่ทวนชื่อตัวเลือกว่า "ข้อ 1 คือ…"/u);
  assert.ok(out.includes(LEVEL_TEACHER[1]));
  assert.ok(!out.includes("ร้อยเข้ากับประโยค เช่น"));
  for (const level of [1, 2, 3, 4, 5]) assert.ok(LEVEL_TEACHER[level] && !/\d/u.test(LEVEL_TEACHER[level].replace("Custom GPT", "")), `ระดับ ${level}`);
});

test("อ่านระดับจากคำตอบบันได: ตัวเลขในประโยคนับเมื่อข้อความก่อนหน้ามีบันได · ไม่มีบันได = ไม่เดา", () => {
  assert.equal(ladderLevelAnswer("ใช้ระดับ 4 ค่ะ", LADDER), 4);
  assert.equal(ladderLevelAnswer("เคยใช้บ้างครับ\n3", LADDER), 3);
  assert.equal(ladderLevelAnswer("2 ค่ะ", LADDER), 2);
  assert.equal(ladderLevelAnswer("ใช้ระดับ 4 ค่ะ", "ทำงานด้านไหนอยู่คะ"), null);
  assert.equal(ladderLevelAnswer("มีลูกน้อง 12 คน", LADDER), null);
  assert.equal(ladderLevelAnswer("ระดับ 7", LADDER), null);
});

test("teacherPlan: ระดับที่อ่านได้จากบันไดเพิ่มบรรทัดระดับครั้งเดียว · ช่วงความยาว ×1.25 ทั้งช่องและข้อความ", () => {
  const history = [{ role: "assistant", content: LADDER }];
  const out = teacherPlan(plan("1. ปฏิกิริยาสั้น ๆ"), { decision: { stage: "DISCOVERY" }, facts: {}, history, userText: "ใช้ระดับ 4 ค่ะ" });
  assert.equal(out.text.split("เขาเพิ่งตอบระดับ 4").length - 1, 1);
  assert.ok(out.text.includes(LEVEL_TEACHER[4]));
  assert.deepEqual(out.band, [210, 350]);
  assert.match(out.text, /ความยาว: ราว 210–350 ตัวอักษร/u);
  const noLadder = teacherPlan(plan("1. ปฏิกิริยาสั้น ๆ"), { decision: { stage: "DISCOVERY" }, facts: {}, history: [{ role: "assistant", content: "สวัสดีค่ะ" }], userText: "ระดับ 4" });
  assert.ok(!noLadder.text.includes("เขาเพิ่งตอบระดับ"));
});

test("teacherPlan: ระบบอ่านระดับเองแล้ว (answeredLevel) ไม่ซ้อนบรรทัดระดับกับบรรทัดเดิมที่แปลงแล้ว", () => {
  const text = "1. ปฏิกิริยาสั้น ๆ — เขาตอบระดับ 2 ร้อยเข้ากับประโยค เช่น \"ข้อ 2 แปลว่า…\"";
  const out = teacherPlan(plan(text), { decision: { stage: "DISCOVERY" }, facts: { answeredLevel: 2 }, history: [{ role: "assistant", content: LADDER }], userText: "2" });
  assert.equal(out.text.split("เขาเพิ่งตอบระดับ 2").length - 1, 1);
});

test("ประโยคผลลัพธ์ไม่ใช่การบ้าน · คำถามต่อจากคำที่เขาเพิ่งตอบก่อนถามประเภทธุรกิจ", () => {
  const out = interestWording({ text: "2. ประโยคผลลัพธ์หนึ่งประโยค: สิ่งที่เขาทำได้ต่อจากจุดที่อยู่ ใส่ \"เช่น\"\n3. ถามคำถามเดียวเรื่องงานหรือธุรกิจที่ทำ หรืองานที่อยากให้ AI ช่วยเป็นอย่างแรก พร้อมตัวเลือก" }).text;
  assert.match(out, /ไม่สั่งหรือชวนให้เขา "ลอง…" เอง/u);
  assert.match(out, /ถามคำถามเดียวที่ต่อจากคำที่เขาเพิ่งตอบ/u);
  assert.match(out, /ถ้ายังไม่รู้อะไรเลย ให้ถามเรื่องงานหรือธุรกิจที่ทำ/u);
});

test("จังหวะราคา: ไม่ขึ้นประโยคด้วย 'ค่าเรียนนี้ได้…' · ประโยคคุณค่าเต็มประโยคเห็นภาพ · ตัวเลือกระดับผูกกับงานของเขา", () => {
  const out = interestWording({ text: [
    "บอกว่าค่าเรียนนี้ได้อะไรและคุ้มยังไง ผูกกับเรื่องที่เขาเล่ามา: x — ครึ่งประโยคถึงหนึ่งประโยค ด้วยคำของลูกแพรเอง ไม่ไล่หลายข้อ ไม่เอ่ยชื่อ",
    SCREEN_VALUE_LINE,
    "บอกเหตุผลหนึ่งประโยคว่า \"เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน\"",
    "ถามคำถามคัดกรองหนึ่งข้อว่าเคยใช้ AI มาประมาณแค่ไหน พร้อมตัวเลือก 3–4 อย่าง เขียนคำถาม",
    "หนึ่งประโยค: ผูกค่าเรียนกับสิ่งที่เขาจะได้และเหตุผลที่คุ้ม: หยิบจุดคุ้มค่า",
  ].join("\n") }).text.split("\n");
  assert.match(out[0], /^เล่าว่าคลาสนี้ได้อะไรและคุ้มยังไง \(ไม่ขึ้นประโยคด้วย "ค่าเรียนนี้ได้…"/u);
  assert.match(out[0], /เป็นหนึ่งประโยคเต็มที่เห็นภาพ/u);
  assert.match(out[1], /เป็นหนึ่งประโยคเต็มที่เห็นภาพ/u);
  assert.ok(!out[1].includes("ครึ่งประโยค"));
  assert.match(out[0], /ขึ้นด้วย "คลาสของพี่ง้วงเป็นคลาสสอนสดที่…"/u);
  assert.match(out[2], /ลูกแพรขอทราบพื้นฐานการใช้ AI อีกนิด/u);
  assert.match(out[2], /"เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน"$/u);
  assert.match(out[3], /ถ้ารู้งานของเขาแล้ว ให้ตัวเลือกเป็นงานแบบของเขา/u);
  assert.match(out[4], /"ค่าเรียนนี้คุ้มตรงที่…"/u);
});

test("แบ่งรับราคา: เหตุผลก่อนคำถาม (มาเองหรือมากับทีม) บังคับ ไม่ใช่ทางเลือก · อธิบายสิ่งที่ถามรับคำเขาก่อนและไม่พูดเกินว่ามีคลาส", () => {
  const out = interestWording({ text: [
    "ถามคำถามสั้น ๆ หนึ่งข้อว่ามาเรียนเองหรือมากับทีม ตอบง่ายในคำเดียว บอกเหตุผลได้ครึ่งประโยคว่าจะได้แนะนำแบบที่เหมาะและคุ้มกับเขาที่สุด ไม่ถามเรื่องที่เขาเล่าไว้แล้ว",
    "ตอบสิ่งที่เขาถามตรง ๆ ด้วยภาษาง่ายหนึ่งถึงสองประโยค",
  ].join("\n") }).text.split("\n");
  assert.match(out[0], /ก่อนคำถามต้องมีประโยคเหตุผลสั้น ๆ หนึ่งประโยค เช่น "ลูกแพรจะได้แนะนำแบบที่เหมาะและคุ้มที่สุดนะคะ"/u);
  assert.match(out[0], /แต่ห้ามข้าม/u);
  assert.match(out[0], / ไม่ถามเรื่องที่เขาเล่าไว้แล้ว$/u);
  assert.match(out[1], /^ถ้าข้อความเขามีคำตอบหรือเรื่องของเขาเองด้วย/u);
  assert.match(out[1], /ไม่พูดให้เข้าใจว่ามีคลาสเรื่องนั้น\)$/u);
});

test("teacherPlan ไม่เพิ่มบรรทัด 'จุดคุ้มค่าที่เพิ่งพูด' (ลองแล้วแย่ลง 8 พ.ย.)", () => {
  const history = [{ role: "assistant", content: "ในคลาสจะได้ทำ Workshop โดยมีทีม TA ช่วยดูแลอย่างใกล้ชิดค่ะ" }];
  const screen = teacherPlan(plan("1. x"), { facts: {}, history, userText: "ราคาเท่าไหร่" });
  assert.ok(!screen.text.includes("เพิ่งพูดเรื่อง"));
});

test("teacherPlan ไม่แก้ของเดิม และรับงานที่ไม่มีข้อความได้", () => {
  const base = plan("1. x");
  const copy = JSON.parse(JSON.stringify(base));
  teacherPlan(base, { history: [{ role: "assistant", content: "ทีม TA" }] });
  assert.deepEqual(base, copy);
  assert.equal(teacherPlan(null), null);
});

test("ทักตามแบบครู: สวิตช์ followup_teacher_rules ไม่มีแถว/ค่าแปลก = off = กติกาเดิมทุกไบต์ · on = ต่อกติกาท้ายสุด ไม่มีตัวเลข", async () => {
  const { FOLLOWUP_TEACHER_KEY, FOLLOWUP_TEACHER_RULES, followupTeacherMode, withFollowupTeacher } = await import("../src/replyStyle/followupTeacher.mjs");
  const { BEHAVIOR_SWITCHES } = await import("../src/consoleBehaviorSwitchesApi.mjs");
  const db = (v) => ({ getSetting: (k) => (k === FOLLOWUP_TEACHER_KEY ? v : null) });
  assert.equal(followupTeacherMode(db(null)), "off");
  assert.equal(followupTeacherMode(db("yes")), "off");
  assert.equal(followupTeacherMode({ getSetting() { throw new Error("db"); } }), "off");
  assert.equal(withFollowupTeacher("กติกาเดิม", db(null)), "กติกาเดิม");
  const on = withFollowupTeacher("กติกาเดิม", db(" ON "));
  assert.ok(on.startsWith("กติกาเดิม\n\nแบบครู"));
  assert.ok(!/\d/u.test(FOLLOWUP_TEACHER_RULES.join("")));
  assert.deepEqual([...BEHAVIOR_SWITCHES.find((entry) => entry.key === FOLLOWUP_TEACHER_KEY).values], ["on", "off"]);
});

test("เลือกหลายระดับ: หยิบครบทุกข้อ + บรรทัดระดับของข้อสูงสุด · ตัวเลขอื่น (จำนวนคน) ไม่นับ", async () => {
  const { ladderLevelsAnswer } = await import("../src/replyEngineV3/teacherTask.mjs");
  assert.deepEqual(ladderLevelsAnswer("4 และ 5", LADDER), [4, 5]);
  assert.deepEqual(ladderLevelsAnswer("ข้อ 4,5 ค่ะ", LADDER), [4, 5]);
  assert.deepEqual(ladderLevelsAnswer("4", LADDER), []);
  assert.deepEqual(ladderLevelsAnswer("มี 2 คน", LADDER), []);
  assert.deepEqual(ladderLevelsAnswer("4 และ 5", "ทำงานด้านไหนคะ"), []);
  const out = teacherPlan(plan("1. x"), { facts: {}, history: [{ role: "assistant", content: LADDER }], userText: "4 และ 5" });
  assert.match(out.text, /เขาเลือกหลายข้อ \(4 และ 5\) — หยิบมาครบทุกข้อ/u);
  assert.ok(out.text.includes(LEVEL_TEACHER[5]));
});

test("ตอบสั้นว่า 'ยัง' ต่อคำถามสำรวจ = เปิดด้วยไม่เป็นไรเลยค่ะ · 'ยังครับ' ต่อข้อเสนอ = ไม่ใช่บรรทัดนี้", async () => {
  const { NOT_YET_LINE } = await import("../src/replyEngineV3/teacherTask.mjs");
  const ask = teacherPlan(plan("1. x"), { history: [{ role: "assistant", content: "ไม่ทราบว่ามีงานพิมพ์ข้อความหรืองานสรุปบ่อยกว่ากันคะ?" }], userText: "ยัง" });
  assert.ok(ask.text.includes(NOT_YET_LINE));
  const offer = teacherPlan(plan("1. x"), { history: [{ role: "assistant", content: "ไม่ทราบว่าคุณสนใจดูรอบเรียนที่เปิดอยู่ไหมคะ ลูกแพรส่งให้ค่ะ" }], userText: "ยังครับ" });
  assert.ok(!offer.text.includes(NOT_YET_LINE));
  const long = teacherPlan(plan("1. x"), { history: [{ role: "assistant", content: "ทำงานด้านไหนคะ?" }], userText: "ยังไม่ได้ทำงานค่ะ ตอนนี้เรียนอยู่ปีสาม อยากลองใช้ AI ทำรายงาน" });
  assert.ok(!long.text.includes(NOT_YET_LINE), "ข้อความยาวที่เล่าเรื่องตัวเอง ไม่ใช่คำตอบสั้น");
});

test("ส่งหัวข้อที่ขอ: ใช้ชื่อหัวข้อและเครื่องมือจริง · คำถามสำรวจ: ยังไม่รู้ธุรกิจ = ถามธุรกิจผูกกับคำของเขาก่อน", () => {
  const out = interestWording({ text: [
    "1. \"ได้เลยค่ะ\" แล้วส่งสิ่งที่เขาขอให้ครบ เป็นหัวข้อนำด้วย emoji ไม่เกิน 3 หัว",
    "3. ถามคำถามเดียวเรื่องงานหรือธุรกิจที่ทำ หรืองานที่อยากให้ AI ช่วยเป็นอย่างแรก พร้อมตัวเลือก",
  ].join("\n") }).text.split("\n");
  assert.match(out[0], /ใช้ชื่อหัวข้อและเครื่องมือจริงจากข้อมูลคลาสที่มีในคำสั่งนี้/u);
  assert.match(out[0], /ไม่บอกว่าจะประสานทีมหรือส่งฉบับเต็มทีหลัง/u);
  assert.match(out[0], / เป็นหัวข้อนำด้วย emoji ไม่เกิน 3 หัว$/u);
  assert.match(out[1], /ถ้ายังไม่รู้ว่าเขาทำธุรกิจหรืองานแบบไหน ให้ถามเรื่องนั้นโดยผูกกับคำของเขา/u);
});

test("ขอพื้นฐานก่อนราคา: สูตรครู (ผลที่ได้กลับไป + 😊) เฉพาะจังหวะนี้ · ข้อความแรกใช้ 'สั้น ๆ ก่อน' ไม่ใช่ 'อีกนิด'", async () => {
  const { SCREEN_TEACHER_LINE } = await import("../src/replyEngineV3/teacherTask.mjs");
  const reason = "3. บอกเหตุผลหนึ่งประโยคว่า \"เพื่อให้เลือกคลาสที่เหมาะสมและได้ประโยชน์สูงสุดต่อผู้เรียน\"";
  const first = teacherPlan(plan(`1. ทักทาย "สวัสดีค่ะ" (นี่คือข้อความแรกของลูกแพรในห้องนี้)\n${reason}`), { decision: { stage: "SCREEN_PRICE" }, history: [], userText: "ราคาเท่าไหร่" });
  assert.match(first.text, /ลูกแพรขอทราบพื้นฐานการใช้ AI สั้น ๆ ก่อนนะคะ/u);
  assert.ok(!first.text.includes("อีกนิด"));
  assert.ok(first.text.includes(SCREEN_TEACHER_LINE));
  const later = teacherPlan(plan(reason), { decision: { stage: "SCREEN_PRICE" }, history: [{ role: "assistant", content: "ทำงานด้านไหนคะ" }], userText: "ราคาเท่าไหร่" });
  assert.match(later.text, /ลูกแพรขอทราบพื้นฐานการใช้ AI อีกนิด/u);
  assert.match(later.text, /คลาสมีหลายระดับตามพื้นฐาน/u);
  const other = teacherPlan(plan("1. x"), { decision: { stage: "DISCOVERY" }, history: [], userText: "งานขาย" });
  assert.ok(!other.text.includes(SCREEN_TEACHER_LINE));
});
