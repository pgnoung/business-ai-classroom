// owner-lessons-pipeline.test.mjs — บทเรียนที่เจ้าของสอน เดินทางเข้าเส้นตอบลูกค้าจริงอย่างไร
//
// สัญญาที่ทั้งฟีเจอร์ตั้งอยู่บน (ข้อมูลสังเคราะห์ ไม่มี LINE/Hermes จริง):
//   1. ไม่มีบทเรียนที่ใช้อยู่ (ไม่มีเลย / มีแต่รออนุมัติ-ปิดไว้ / กดหยุดไว้) = พรอมต์เดิมทุกไบต์
//   2. มีบทเรียน = ต่อท้าย "ส่วนที่เปลี่ยนทุกเทิร์น" ของ system prompt เท่านั้น — ส่วนคงที่ที่ปัก
//      cache breakpoint (ความรู้ + persona) ต้องไม่ขยับแม้แต่ไบต์เดียว ไม่งั้นค่า cache แตกทุกเทิร์น
//   3. ส่งถึงลูกค้าแล้วจึงจดว่าใช้บทเรียนไหน (แผงทำไมตอบแบบนี้อ่านจากตรงนี้) และนับการใช้
//   4. ข้อความสุดท้ายไม่ได้มาจากโมเดล (สมองล่ม → template) = ไม่จดและไม่นับ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  buildOwnerLessonsSection, OWNER_LESSON_FOLLOWUP_RULE, OWNER_LESSONS_PAUSED_KEY, OWNER_LESSONS_TITLE,
} from "../src/ownerLessons.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createStagedFollowups } from "../src/stagedFollowups.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, promptText, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const CUSTOMER = "U-lesson-pipeline-001";

function failingHermes() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: false, status: 503, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

async function runTurn(seed = () => {}, { hermesFetch = hermesFetchStub("จอดที่อาคารเรียนได้เลยค่ะ มากี่ท่านคะ") } = {}) {
  const db = memoryDb();
  const app = createApp({
    config: testConfig({}), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  db.upsertCustomer(CUSTOMER, {});
  db.insertMessage({ customerId: CUSTOMER, direction: "in", content: "สวัสดีค่ะ" });
  db.insertMessage({ customerId: CUSTOMER, direction: "out", content: "สวัสดีค่ะ ยินดีดูแลนะคะ", agentMode: "ai" });
  const seeded = seed(db) ?? {};
  await app.pipeline.handleInboundText({ customerId: CUSTOMER, text: "มีที่จอดรถไหมคะ", replyToken: "rt" });
  const body = hermesFetch.calls[0]?.body ?? null;
  // ข้ามคำทักทายที่ seed ไว้ (ขาออกแถวแรก) — ที่เหลือคือฟองของเทิร์นนี้ทั้งหมด
  const outbound = db.messagesFor(CUSTOMER).filter((row) => row.direction === "out").slice(1);
  return { db, body, outbound, seeded };
}

const parkingLesson = (overrides = {}) => ({
  teaching: "บอกว่าจอดรถได้ที่อาคารเรียน แล้วถามว่ามากี่ท่าน", teachingKey: "parking", topic: "ที่จอดรถ",
  customerText: "มีที่จอดรถไหมคะ", aiText: "มีค่ะ", status: "active", createdBy: "ngoung", ...overrides,
});

test("ไม่มีบทเรียนที่ใช้อยู่ = พรอมต์เดิมทุกไบต์ (ไม่มีเลย / รออนุมัติ-ปิดไว้ / กดหยุดไว้)", async () => {
  const baseline = await runTurn();
  assert.ok(baseline.body, "ต้องมีการเรียกสมองจริง ไม่งั้นเทียบอะไรไม่ได้");
  const baselineJson = JSON.stringify(baseline.body.messages);
  assert.ok(!promptText(baseline.body.messages[0].content).includes(OWNER_LESSONS_TITLE));
  baseline.db.close();

  const inactive = await runTurn((db) => {
    db.addOwnerLesson(parkingLesson({ status: "pending", createdBy: "chompoo" }));
    const off = db.addOwnerLesson(parkingLesson({ teachingKey: "parking-2", teaching: "จอดรถฟรีสองชั่วโมง" }));
    db.setOwnerLessonEnabled(off.id, false, "ngoung");
  });
  assert.equal(JSON.stringify(inactive.body.messages), baselineJson, "แถวที่รออนุมัติ/ปิดไว้ต้องไม่เปลี่ยนพรอมต์เลย");
  assert.equal(inactive.outbound[0].metadata_json, "{}", "ไม่ได้ใช้บทเรียน = ไม่จดอะไรเพิ่ม");
  inactive.db.close();

  const paused = await runTurn((db) => {
    db.addOwnerLesson(parkingLesson());
    db.setSetting(OWNER_LESSONS_PAUSED_KEY, "1");
  });
  assert.equal(JSON.stringify(paused.body.messages), baselineJson, "กดหยุดไว้ = พรอมต์เดิมทุกไบต์");
  paused.db.close();
});

test("มีบทเรียน: ต่อท้ายส่วนที่เปลี่ยนทุกเทิร์นเท่านั้น ส่วนคงที่ (cache) ไม่ขยับ และประวัติไม่ถูกแตะ", async () => {
  const baseline = await runTurn();
  const taught = await runTurn((db) => ({ lesson: db.addOwnerLesson(parkingLesson()) }));
  const [baseSystem, ...baseRest] = baseline.body.messages;
  const [system, ...rest] = taught.body.messages;
  assert.deepEqual(system.content[0], baseSystem.content[0], "บล็อกคงที่ (ความรู้ + persona + cache breakpoint) ต้องเหมือนเดิมเป๊ะ");
  const expected = buildOwnerLessonsSection([taught.db.getOwnerLesson(taught.seeded.lesson.id)]).text;
  assert.equal(system.content[1].text, `${baseSystem.content[1].text}\n${expected}`,
    "หัวข้อบทเรียนต้องต่อท้ายกติกาทุกข้อ (หลังนโยบายกิจกรรม #) และไม่มีอะไรอื่นเปลี่ยน");
  assert.match(expected, /สิ่งที่สอน: บอกว่าจอดรถได้ที่อาคารเรียน แล้วถามว่ามากี่ท่าน/u);
  assert.deepEqual(rest, baseRest, "ประวัติแชทและข้อความลูกค้าต้องไม่ถูกแตะ");
  baseline.db.close();
  taught.db.close();
});

test("ส่งถึงลูกค้าแล้ว = จดบทเรียนที่ใช้ใน metadata ของทุกฟอง และนับการใช้หนึ่งครั้งต่อเทิร์น", async () => {
  const run = await runTurn((db) => ({ lesson: db.addOwnerLesson(parkingLesson()) }));
  const id = run.seeded.lesson.id;
  assert.ok(run.outbound.length >= 1);
  for (const row of run.outbound) {
    assert.deepEqual(run.db.messageOwnerLessonIds(row.id), [id], "แผงทำไมตอบแบบนี้ต้องรู้ว่าฟองนี้ใช้บทเรียนไหน");
  }
  const after = run.db.getOwnerLesson(id);
  assert.equal(after.use_count, 1, "หนึ่งเทิร์นนับหนึ่งครั้ง ไม่ใช่ต่อฟอง");
  assert.ok(Number(after.last_used_at) > 0);
  run.db.close();
});

test("สมองล่มแล้วส่งข้อความสำเร็จรูปแทน = ไม่จดว่าใช้บทเรียน และไม่นับการใช้", async () => {
  const hermesFetch = failingHermes();
  const run = await runTurn((db) => ({ lesson: db.addOwnerLesson(parkingLesson()) }), { hermesFetch });
  assert.ok(hermesFetch.calls.length >= 1, "ต้องพยายามเรียกสมองจริงก่อน");
  assert.ok(promptText(hermesFetch.calls[0].body.messages[0].content).includes(OWNER_LESSONS_TITLE), "พรอมต์ที่ส่งไปมีบทเรียนอยู่");
  assert.ok(run.outbound.length >= 1, "ลูกค้ายังได้ข้อความสำเร็จรูป");
  for (const row of run.outbound) assert.deepEqual(run.db.messageOwnerLessonIds(row.id), []);
  assert.equal(run.db.getOwnerLesson(run.seeded.lesson.id).use_count, 0);
  run.db.close();
});

/* ------------------------- ข้อความทักตาม (stagedFollowups.mjs) ------------------------- */

// โลกจำลองแบบเดียวกับ test/staged-followups.test.mjs — นาฬิกาเดียวทั้ง db และ engine
const NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0);
function followupWorld(seed = () => {}) {
  const clock = { now: NOON_BKK };
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0" });
  const db = memoryDb({ now: () => clock.now });
  const requests = [];
  const hermes = createHermesBridge({
    config, logger: silent,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ยังสนใจเรื่องที่จอดรถอยู่ไหมคะ?" } }], usage: {} }) };
    },
  });
  const pushes = [];
  const engine = createStagedFollowups({
    config, db, hermes, logger: silent, now: () => clock.now, imageCatalog: [],
    lineRegistry: { forChannel: () => ({ sendBubbles: async (args) => { pushes.push(args); return { ok: true }; } }), rawUserId: (id) => id },
    guard: createComplianceGuard({ bannedWords: [], getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(),
  });
  const customerId = "U-lesson-followup";
  db.upsertCustomer(customerId, { displayName: "ลูกค้าสังเคราะห์" });
  db.setFollowupEnabled(customerId, true);
  db.recordScore(customerId, 3, "{}");
  for (const [direction, content, atMs] of [["in", "มีที่จอดรถไหมคะ", NOON_BKK - 25 * 3_600_000], ["out", "มีค่ะ", NOON_BKK - 25 * 3_600_000 + 1000]]) {
    const id = db.insertMessage({ customerId, direction, content });
    db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(atMs, id);
  }
  const seeded = seed(db) ?? {};
  return { db, engine, requests, pushes, customerId, seeded };
}

test("ข้อความทักตาม: ใช้บทเรียนชุดเดียวกัน + กติกาห้ามลากกลับไปตอบคำถามเก่า · ไม่มีบทเรียน = พรอมต์เดิม", async () => {
  const baseline = followupWorld((db) => { db.addOwnerLesson(parkingLesson({ status: "pending", createdBy: "chompoo" })); });
  await baseline.engine.runOnce();
  assert.ok(baseline.requests.length > 0, "ต้องถึงขั้นร่างข้อความทักตาม");
  assert.ok(!promptText(baseline.requests[0].messages[0].content).includes(OWNER_LESSONS_TITLE));

  const taught = followupWorld((db) => ({ lesson: db.addOwnerLesson(parkingLesson()) }));
  await taught.engine.runOnce();
  assert.ok(taught.pushes.length > 0, "ข้อความทักตามต้องถูกส่ง");
  const [baseSystem] = baseline.requests[0].messages;
  const [system] = taught.requests[0].messages;
  const text = promptText(system.content);
  assert.ok(text.startsWith(promptText(baseSystem.content)), "บทเรียนต่อท้ายเท่านั้น ของเดิมไม่ขยับ");
  assert.ok(text.includes(OWNER_LESSONS_TITLE) && text.includes(OWNER_LESSON_FOLLOWUP_RULE));
  const sent = taught.db.messagesFor(taught.customerId).filter((row) => row.message_class === "proactive");
  assert.ok(sent.length >= 1);
  for (const row of sent) assert.deepEqual(taught.db.messageOwnerLessonIds(row.id), [taught.seeded.lesson.id]);
  assert.equal(taught.db.getOwnerLesson(taught.seeded.lesson.id).use_count, 1);
  baseline.db.close();
  taught.db.close();
});
