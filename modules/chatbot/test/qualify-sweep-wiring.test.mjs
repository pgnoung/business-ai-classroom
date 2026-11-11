// qualify-sweep-wiring — ตัวกวาดคัดกรองที่ต่อสายจริงใน createApp (คำสั่งพี่ง้วง 5 ต.ค. 2026)
//
// เส้นเต็มหนึ่งรอบ: สวิตช์ on → รอบชั่วโมงปิดเหลือง → ลูกค้าพิมพ์คุยเล่น (ยังเหลือง + กุญแจตรวจซ้ำ)
// → ตรวจซ้ำรอบนาทีถัดไปเห็นศักยภาพ → เปิดเขียว → ข้อความค้างได้คำตอบ (push เพราะ reply token หมดแล้ว)
// ทุกอย่างผ่านของจริงใน server.mjs: hermes bridge (gpt-6.1-sol), pipeline.runExclusive, burst, answerPending
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  AUDIT_AI_OFF_NOT_QUALIFIED, AUDIT_AI_ON_QUALIFIED, NOT_QUALIFIED_REASON, QUALIFY_AUDIT_OPERATOR,
  QUALIFY_SWEEP_MODE_KEY, qualifyRecheckKey, qualifyStateKey,
} from "../src/notQualified.mjs";
import { QUALIFY_MODEL } from "../src/hermesBridge.mjs";
import { QUALIFY_PENDING_AUDIT_ACTION } from "../src/qualifyAnswerPending.mjs";
import { YELLOW_HELD_AUDIT_ACTION } from "../src/qualifyFastReclaim.mjs";
import { setCustomerAiSwitch } from "../src/aiSwitch.mjs";
import { lineFetchStub, memoryDb, poisonGlobalFetch, testConfig, waitFor } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const MIN = 60_000;
// 10:05 เวลาไทย (รอบ 10:00 ยังไม่เลย 30 นาที) — VPS เป็น UTC ตัวกวาดคิดเวลาไทยเอง
const SLOT_TIME = Date.UTC(2026, 9, 5, 3, 5, 0);

function qualifyHermes() {
  const calls = [];
  let verdict = "not_qualified";
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    let content = "ยินดีค่ะ เดี๋ยวลูกแพรเล่ารายละเอียดคลาสให้นะคะ";
    if (body.prompt_cache_key === "lukprae-hermes-qualify") {
      const user = String(body.messages.at(-1).content);
      const refs = [...user.matchAll(/^\[(m\d+)\] ลูกค้า/gmu)].map((match) => match[1]);
      content = JSON.stringify(verdict === "not_qualified"
        ? { verdict, confidence: 0.92, category: "unemployed", evidence_ids: refs.slice(0, 2), reason: "ตกงานและหาแต่ช่องทางรายได้ ไม่มีงบเรียน" }
        : { verdict, confidence: 0.8, category: "has_business_or_job", evidence_ids: refs.slice(-1), reason: "เล่าว่ามีร้านของตัวเองและอยากใช้ AI ในงาน" });
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }) };
  };
  fn.calls = calls;
  fn.setVerdict = (value) => { verdict = value; };
  return fn;
}

test("e2e: เหลืองจากรอบชั่วโมง → คุยเล่นยังเหลือง → ตรวจซ้ำเปิดเขียว → ข้อความค้างได้คำตอบ", async () => {
  let clock = SLOT_TIME - 40 * MIN;
  const now = () => clock;
  const db = memoryDb({ now });
  const hermesFetch = qualifyHermes();
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {}, now },
    logger: silent,
  });
  const id = "U-sweep-e2e";
  db.upsertCustomer(id, { displayName: "คุณทดสอบ" });
  db.raw.prepare("UPDATE customers SET last_score = 2 WHERE line_user_id = ?").run(id); // 8 พ.ย. 2026: ปิดเหลืองเฉพาะคะแนนต่ำ
  db.insertMessage({ customerId: id, direction: "in", content: "อยากหารายได้เสริมค่ะ ตอนนี้ตกงานอยู่" });
  clock += MIN;
  db.insertMessage({ customerId: id, direction: "out", content: "ขอบคุณที่เล่าให้ฟังนะคะ", agentMode: "ai" });
  clock += MIN;
  db.insertMessage({ customerId: id, direction: "in", content: "มีงานให้ทำที่บ้านไหมคะ ไม่มีเงินเรียนค่ะ" });
  clock += MIN;
  db.insertMessage({ customerId: id, direction: "out", content: "เข้าใจค่ะ", agentMode: "ai" });

  // ไม่มีแถวสวิตช์ = ไม่เรียกโมเดลเลย
  clock = SLOT_TIME;
  assert.deepEqual(await app.qualifySweep.runDue(), { skipped: "switch_off" });
  assert.equal(hermesFetch.calls.length, 0);

  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  const first = await app.qualifySweep.runDue();
  assert.equal(first.slot.called, 1, JSON.stringify(first));
  const qualifyCall = hermesFetch.calls.find((body) => body.prompt_cache_key === "lukprae-hermes-qualify");
  assert.equal(qualifyCall.model, QUALIFY_MODEL, "ตัวกวาดใช้ gpt-6.1-sol เสมอ ไม่ใช่รุ่นของผู้ให้คะแนน");
  assert.ok(!JSON.stringify(qualifyCall.messages).includes("คุณทดสอบ"), "ชื่อลูกค้าถูกปิดก่อนส่งโมเดล");
  let room = db.getCustomer(id);
  assert.equal(room.ai_enabled, 0);
  assert.equal(room.ai_off_reason, NOT_QUALIFIED_REASON);
  const offAudit = db.listAudit().find((row) => row.action === AUDIT_AI_OFF_NOT_QUALIFIED && row.target === id);
  assert.equal(offAudit.operator, QUALIFY_AUDIT_OPERATOR);
  assert.ok(db.raw.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE kind = 'qualify'").get().n === 1, "ต้นทุนจดเป็น kind qualify");

  // ลูกค้าพิมพ์คุยเล่น = ยังเหลือง เงียบ + กุญแจตรวจซ้ำ
  clock += MIN;
  const sendsBefore = lineFetch.sends.length;
  db.insertMessage({ customerId: id, direction: "in", content: "ตอนนี้เปิดร้านกาแฟเล็ก ๆ อยู่ค่ะ อยากใช้ AI ช่วยตอบแชทลูกค้า" });
  const quiet = await app.pipeline.handleInboundText({ customerId: id, text: "ตอนนี้เปิดร้านกาแฟเล็ก ๆ อยู่ค่ะ อยากใช้ AI ช่วยตอบแชทลูกค้า", replyToken: "rt-old" });
  assert.equal(quiet.suppressed, "ai_disabled");
  assert.equal(lineFetch.sends.length, sendsBefore);
  assert.ok(db.getSetting(qualifyRecheckKey(id)));

  // ยังไม่ครบ 90 วิ = ยังไม่ตรวจ (รอให้ลูกค้าพิมพ์จบ)
  clock += 30_000;
  hermesFetch.setVerdict("potential");
  const tooSoon = await app.qualifySweep.runDue();
  assert.equal(tooSoon.rechecks.length, 0);

  clock += 2 * MIN;
  const second = await app.qualifySweep.runDue();
  assert.equal(second.rechecks[0]?.outcome, "green", JSON.stringify(second));
  room = db.getCustomer(id);
  assert.equal(room.ai_enabled, 1);
  assert.equal(room.ai_off_reason, "");
  assert.equal(db.getSetting(qualifyRecheckKey(id)), null, "ตรวจแล้วลบกุญแจ");
  assert.ok(db.listAudit().some((row) => row.action === AUDIT_AI_ON_QUALIFIED && row.target === id));
  assert.equal(JSON.parse(db.getSetting(qualifyStateKey(id))).verdict, "potential");
  // ข้อความค้างถูกส่งเข้าเส้นตอบเดิม (push — reply token เก่าหมดอายุแล้ว)
  await waitFor(() => lineFetch.sends.length > sendsBefore);
  const reply = lineFetch.sends.at(-1);
  assert.match(reply.url, /\/v2\/bot\/message\/push$/u);
  assert.ok(db.listAudit().some((row) => row.action === QUALIFY_PENDING_AUDIT_ACTION && row.target === id));
  const stats = app.qualifySweep.stats();
  assert.equal(stats.mode, "on");
  assert.equal(stats.today.yellow, 1);
  assert.equal(stats.today.green, 1);
  db.close();
});

test("e2e shadow: ตัดสินและจดสถานะ แต่ไม่ปิดห้องจริง และไม่มีอะไรถึงลูกค้า", async () => {
  let clock = SLOT_TIME - 10 * MIN;
  const now = () => clock;
  const db = memoryDb({ now });
  const hermesFetch = qualifyHermes();
  const lineFetch = lineFetchStub();
  const app = createApp({ config: testConfig(), db, overrides: { hermesFetch, lineFetch, sleep: async () => {}, now }, logger: silent });
  const id = "U-sweep-shadow";
  db.upsertCustomer(id, { displayName: "เงา" });
  db.raw.prepare("UPDATE customers SET last_score = 2 WHERE line_user_id = ?").run(id); // 8 พ.ย. 2026: ปิดเหลืองเฉพาะคะแนนต่ำ
  db.insertMessage({ customerId: id, direction: "in", content: "อยากหารายได้เสริมค่ะ ตอนนี้ตกงานอยู่" });
  clock += MIN;
  db.insertMessage({ customerId: id, direction: "in", content: "มีงานให้ทำที่บ้านไหมคะ ไม่มีเงินเรียนค่ะ" });
  clock += MIN;
  db.insertMessage({ customerId: id, direction: "out", content: "เข้าใจค่ะ", agentMode: "ai" });
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "shadow");
  clock = SLOT_TIME;
  await app.qualifySweep.runDue();
  assert.equal(db.getCustomer(id).ai_enabled, 1);
  const state = JSON.parse(db.getSetting(qualifyStateKey(id)));
  assert.equal(state.verdict, "not_qualified");
  assert.equal(state.mode, "shadow");
  assert.equal(lineFetch.sends.length, 0);
  assert.equal(db.listAudit().filter((row) => row.action === AUDIT_AI_OFF_NOT_QUALIFIED).length, 0);
  db.close();
});

// รีวิวปรปักษ์ 5 ต.ค. #9 (รวมงาน): ตัวกวาดจริงเปิดเขียวแล้วจดสถานะใหม่ "ไม่มี offAt" (ห้องไม่เหลืองแล้ว)
// answerPending จึงหาเวลาปิดเหลืองจาก audit ai_off_not_qualified แทน — เทสต์ของส่วนอื่นจำลองการเปิดเขียวด้วย UPDATE ตรง
// (สถานะยังมี offAt) จึงไม่เคยเดินรอยต่อนี้ · ที่นี่ใช้ตัวกวาด + ไปป์ไลน์ + answerPending ของจริงทั้งเส้น
test("e2e (#9): ตัวกวาดจริงเปิดเขียว → โมเดลตอบเห็นทุกข้อความที่ลูกค้าพิมพ์ระหว่างเหลือง ครั้งเดียว ไม่ซ้ำ", async () => {
  let clock = SLOT_TIME - 40 * MIN;
  const now = () => clock;
  const db = memoryDb({ now });
  const hermesFetch = qualifyHermes();
  const lineFetch = lineFetchStub();
  const app = createApp({ config: testConfig(), db, overrides: { hermesFetch, lineFetch, sleep: async () => {}, now }, logger: silent });
  const id = "U-sweep-held";
  db.upsertCustomer(id, { displayName: "คุณสะสม" });
  db.raw.prepare("UPDATE customers SET last_score = 2 WHERE line_user_id = ?").run(id); // 8 พ.ย. 2026: ปิดเหลืองเฉพาะคะแนนต่ำ
  db.insertMessage({ customerId: id, direction: "in", content: "อยากหารายได้เสริมค่ะ ตอนนี้ตกงานอยู่" });
  clock += MIN;
  db.insertMessage({ customerId: id, direction: "out", content: "ขอบคุณที่เล่าให้ฟังนะคะ", agentMode: "ai" });
  clock += MIN;
  db.insertMessage({ customerId: id, direction: "in", content: "มีงานให้ทำที่บ้านไหมคะ ไม่มีเงินเรียนค่ะ" });
  clock += MIN;
  db.insertMessage({ customerId: id, direction: "out", content: "เข้าใจค่ะ", agentMode: "ai" });
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  clock = SLOT_TIME;
  await app.qualifySweep.runDue();
  assert.equal(db.getCustomer(id).ai_off_reason, NOT_QUALIFIED_REASON);

  const held = ["ตอนนี้มีร้านกาแฟสองสาขาค่ะ", "ลูกค้าเยอะจนตอบแชทไม่ทันเลยค่ะ"];
  for (const text of held) {
    clock += MIN;
    db.insertMessage({ customerId: id, direction: "in", content: text });
    const turn = await app.pipeline.handleInboundText({ customerId: id, text, replyToken: "rt-old" });
    assert.equal(turn.suppressed, "ai_disabled", `${text} ต้องถูกกลืนระหว่างเหลือง`);
  }
  hermesFetch.setVerdict("potential");
  clock += 3 * MIN;
  const sendsBefore = lineFetch.sends.length;
  const recheck = await app.qualifySweep.runDue();
  assert.equal(recheck.rechecks[0]?.outcome, "green", JSON.stringify(recheck));
  assert.equal(JSON.parse(db.getSetting(qualifyStateKey(id))).offAt, undefined, "สถานะเขียวไม่เก็บ offAt (เส้นนี้ต้องพึ่ง audit)");
  await waitFor(() => lineFetch.sends.length > sendsBefore);
  const draft = hermesFetch.calls.find((body) => body.prompt_cache_key !== "lukprae-hermes-qualify"
    && String(body.messages.at(-1)?.content || "").includes(held[1]));
  assert.ok(draft, "มีคำขอร่างคำตอบของข้อความล่าสุด");
  const sent = JSON.stringify(draft);
  for (const text of held) assert.equal(sent.split(text).length - 1, 1, `${text} ต้องถึงโมเดลครั้งเดียว`);
  const merged = db.listAudit().find((row) => row.action === YELLOW_HELD_AUDIT_ACTION && row.target === id);
  assert.match(merged?.detail || "", /1 ข้อความ/u, "ข้อความก่อนหน้าระหว่างเหลือง 1 ข้อความ (ข้อความล่าสุดคือเทิร์นที่ส่งซ้ำ)");
  db.close();
});

// รีวิวปรปักษ์ 5 ต.ค. #5 (รวมงาน): หมุดคนเปิด AI เขียนโดย aiSwitch (ส่วนไปป์ไลน์) อ่านโดยตัวกวาด (อีกส่วน) — รูปแบบค่าต้องตรงกัน
// เดินของจริงทั้งเส้น: ห้องร้องเรียนที่ทีมคุยจบทางโทรศัพท์แล้วกดเปิด AI → รอบชั่วโมงถัดไปห้ามปิดเหลือง (ไม่เรียกโมเดลด้วย)
test("e2e (#5): คนกดเปิด AI คืนห้องร้องเรียน → รอบชั่วโมงไม่ปิดเหลืองห้องนั้น ไม่เรียกโมเดล · ห้องไม่มีคนแตะยังตัดสินตามปกติ", async () => {
  let clock = SLOT_TIME - 40 * MIN;
  const now = () => clock;
  const db = memoryDb({ now });
  const hermesFetch = qualifyHermes();
  const app = createApp({ config: testConfig(), db, overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {}, now }, logger: silent });
  for (const id of ["U-human-back", "U-untouched"]) {
    db.upsertCustomer(id, { displayName: "คุณทดสอบ" });
    db.raw.prepare("UPDATE customers SET last_score = 2 WHERE line_user_id = ?").run(id); // 8 พ.ย. 2026: ปิดเหลืองเฉพาะคะแนนต่ำ
    db.insertMessage({ customerId: id, direction: "in", content: "อยากหารายได้เสริมค่ะ ตอนนี้ตกงานอยู่" });
    clock += MIN;
    db.insertMessage({ customerId: id, direction: "out", content: "ขอบคุณที่เล่าให้ฟังนะคะ", agentMode: "ai" });
    clock += MIN;
    db.insertMessage({ customerId: id, direction: "in", content: "มีงานให้ทำที่บ้านไหมคะ ไม่มีเงินเรียนค่ะ" });
    clock += MIN;
    db.insertMessage({ customerId: id, direction: "out", content: "เข้าใจค่ะ", agentMode: "ai" });
  }
  db.setAiEnabled("U-human-back", false, "complaint");
  clock += MIN;
  setCustomerAiSwitch({ db, customerId: "U-human-back", enabled: true, operator: "nok", nowMs: clock, logger: silent });
  assert.equal(db.getCustomer("U-human-back").ai_enabled, 1);

  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  clock = SLOT_TIME;
  const result = await app.qualifySweep.runDue();
  assert.equal(result.slot.called, 1, JSON.stringify(result.slot));
  const byRoom = new Map(result.slot.results.map((entry) => [entry.customerId, entry.outcome]));
  assert.equal(byRoom.get("U-human-back"), "skipped:human_on", JSON.stringify(result.slot.results));
  assert.equal(byRoom.get("U-untouched"), "yellow");
  assert.equal(db.getCustomer("U-human-back").ai_enabled, 1, "คนคืนห้องให้ AI แล้ว ตัวกวาดห้ามปิดทับ");
  assert.equal(db.getCustomer("U-untouched").ai_off_reason, NOT_QUALIFIED_REASON);
  db.close();
});
