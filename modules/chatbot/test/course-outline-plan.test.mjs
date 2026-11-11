import test from "node:test";
import assert from "node:assert/strict";
import { planCourseOutline } from "../src/courseOutlinePlan.mjs";
import { memoryDb } from "./helpers.mjs";

const user = content => ({ role: "user", content });
const bot = content => ({ role: "assistant", content });
const KNOWLEDGE = `
[Outline ทางการทั้งสองคลาส]
======== คลาสที่ 1 ========
Outline AI Agent for Business นะคะ
📑 หัวข้อที่สอน Prompting framework และ Workshop
======== คลาสที่ 2 ========
Outline AI Agent Workflow Automation
📑 หัวข้อที่สอน Logic ของ Workflow และ Workshop
`;
const plan = args => planCourseOutline({ knowledge: KNOWLEDGE, ...args });

test("screenshot-like warm business discussion sends the approved outline without asking again", () => {
  const result = plan({ text: "คลาสนี้เรียนอะไรบ้างครับ", score: 7, history: [user("สนใจคลาส AI Agent for Business ครับ อยากเรียนไปช่วยงาน") ] });
  assert.deepEqual({ course: result.course, deliver: result.deliver, explicit: result.explicit, reason: result.reason },
    { course: "agent_business", deliver: true, explicit: false, reason: "warm_current_or_recent_course_interest" });
  assert.match(result.rules, /ห้ามถามว่าลูกค้าอยากดู Outline/u);
  assert.match(result.rules, /ห้ามอ้างว่ามีไฟล์แนบหรือลิงก์/u);
});

test("an explicit outline request bypasses a cold or missing score", () => {
  const result = plan({ text: "ขอ Outline AI Agent Workflow Automation หน่อยค่ะ", score: 1 });
  assert.equal(result.deliver, true); assert.equal(result.course, "agent_workflow_automation");
  assert.equal(result.explicit, true);
});

test("score alone never causes an outline delivery", () => {
  assert.equal(plan({ text: "สวัสดีค่ะ", score: 9 }).deliver, false);
  assert.equal(plan({ text: "สนใจเรียนค่ะ", score: 9 }).reason, "course_ambiguous");
});

test("a generic class word does not turn Workflow into Business or both", () => {
  const result = plan({ text: "ขอ Outline คลาส AI Agent Workflow Automation ค่ะ", score: 1 });
  assert.equal(result.course, "agent_workflow_automation");
  assert.equal(result.deliver, true);
});

test("care, pause, and handoff win over a possible outline plan", () => {
  for (const args of [
    { text: "ขอ Outline AI Agent for Business แต่ไว้ก่อนนะคะ", score: 9 },
    { text: "ขอ Outline AI Agent for Business ค่ะ", score: 9, careMode: "handoff" },
    { text: "ขอ Outline AI Agent for Business ค่ะ", score: 9, closingTurn: true },
  ]) assert.equal(plan(args).reason, "care_or_handoff");
});

test("only recent customer-driven interest is usable; old or assistant upsell text is not", () => {
  const old = [user("สนใจ AI Agent for Business ค่ะ"), ...Array.from({ length: 7 }, (_, i) => user(`เรื่องอื่น ${i}`))];
  assert.equal(plan({ text: "ครับ", score: 8, history: old }).reason, "course_ambiguous");
  assert.equal(plan({ text: "ครับ", score: 8, history: [bot("สนใจ AI Agent for Business ไหมคะ")] }).reason, "course_ambiguous");
});

test("ambiguous course and unavailable canonical source never choose or invent an outline", () => {
  assert.equal(plan({ text: "ขอ Outline ค่ะ", score: 9 }).reason, "course_ambiguous");
  const noSource = plan({ text: "ขอ Outline AI Agent for Business ค่ะ", score: 9, knowledge: "Outline AI Agent for Business" });
  assert.equal(noSource.reason, "approved_outline_unavailable"); assert.equal(noSource.deliver, false);
  const emptyBusinessSection = KNOWLEDGE.replace("📑 หัวข้อที่สอน Prompting framework และ Workshop\n", "");
  assert.equal(plan({ text: "ขอ Outline AI Agent for Business ค่ะ", knowledge: emptyBusinessSection }).reason, "approved_outline_unavailable");
});

test("a previous offer is not a delivery, while a real delivered outline dedupes unless explicitly requested again", () => {
  const offer = [bot("อยากดู Outline ของคลาส AI Agent for Business ไหมคะ?")];
  assert.equal(plan({ text: "ครับ", score: 7, history: [user("สนใจ AI Agent for Business ค่ะ"), ...offer] }).deliver, true);
  const sent = [bot("Outline AI Agent for Business นะคะ\n📑 หัวข้อที่สอน Prompting framework และ Workshop")];
  const deduped = plan({ text: "ครับ", score: 7, history: [user("สนใจ AI Agent for Business ค่ะ"), ...sent] });
  assert.equal(deduped.reason, "outline_already_delivered");
  assert.match(deduped.rules, /ไม่ส่งซ้ำ/u);
  assert.equal(plan({ text: "ขอ Outline AI Agent for Business อีกครั้งค่ะ", score: 1, history: sent }).deliver, true);
  const newQuestion = plan({ text: "เนื้อหาคลาส AI Agent for Business มีอะไรบ้างคะ", score: 8, history: sent });
  assert.equal(newQuestion.explicit, false);
  assert.equal(newQuestion.reason, "outline_already_delivered");
  assert.equal(plan({ text: "ส่ง Outline AI Agent for Business ใหม่ได้ไหมคะ", score: 1, history: sent }).deliver, true);
});

test("lifetime successful outbound outline dedupes beyond recent turns, but an offer or failed draft does not", t => {
  const db = memoryDb(); t.after(() => db.close());
  const id = "U-outline-lifetime"; db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: "Outline AI Agent for Business นะคะ\n📑 หัวข้อที่สอน Prompting framework" });
  for (let i = 0; i < 12; i++) db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: `ข้อความใหม่ ${i}` });
  const sentCourses = db.sentCourseOutlines(id);
  assert.deepEqual([...sentCourses], ["agent_business"]);
  assert.equal(plan({ text: "คลาสนี้เรียนอะไรบ้างครับ", score: 8, history: [user("สนใจ AI Agent for Business ครับ")], sentCourses }).reason, "outline_already_delivered");
  const offerId = "U-outline-offer"; db.upsertCustomer(offerId, {});
  db.insertMessage({ customerId: offerId, direction: "out", msgType: "text", content: "อยากดู Outline AI Agent for Business ที่มี Workshop ไหมคะ?" });
  assert.equal(db.sentCourseOutlines(offerId).size, 0);
  const failedId = "U-outline-failed"; db.upsertCustomer(failedId, {});
  // Failed sends do not create an outbound messages row; no marker is possible.
  assert.equal(db.sentCourseOutlines(failedId).size, 0);
});

test("a successful multi-bubble receipt is durable, while invalid receipt metadata is ignored", t => {
  const db = memoryDb(); t.after(() => db.close());
  const id = "U-outline-receipt"; db.upsertCustomer(id, {});
  // The second bubble contains the substance; receipt records the accepted batch.
  db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: "Outline AI Agent for Business นะคะ",
    metadata: { courseOutlines: ["agent_business"] } });
  db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: "📑 หัวข้อที่สอน Prompting framework" });
  for (let i = 0; i < 12; i++) db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: `ข้อความใหม่ ${i}` });
  assert.deepEqual([...db.sentCourseOutlines(id)], ["agent_business"]);
  const invalidId = "U-outline-invalid-receipt"; db.upsertCustomer(invalidId, {});
  for (const metadata of [{ courseOutlines: ["both", "unknown"] }, { courseOutlines: "agent_business" }, { courseOutlines: { 0: "agent_business" } }]) {
    db.insertMessage({ customerId: invalidId, direction: "out", msgType: "text", content: "ข้อความส่งสำเร็จ", metadata });
  }
  assert.equal(db.sentCourseOutlines(invalidId).size, 0);
});

test("asking for both named classes preserves both rather than choosing one", () => {
  const result = plan({ text: "ขอ Outline AI Agent for Business กับ AI Agent Workflow Automation ค่ะ", score: 1 });
  assert.equal(result.course, "both"); assert.equal(result.deliver, true);
  assert.equal(plan({ text: "ขอ Outline ของทั้งสองคลาสค่ะ", score: 1 }).course, "both");
});

test("warm historical interest does not spill an outline into logistics, thanks, or a changed topic", () => {
  const history = [user("สนใจ AI Agent for Business ค่ะ อยากเรียนไปช่วยงาน")];
  for (const text of ["ที่จอดรถอยู่ไหนคะ", "ขอบคุณครับ", "แล้วคลาสออนไลน์มีไหมคะ"]) {
    assert.equal(plan({ text, score: 8, history }).deliver, false, text);
  }
});
