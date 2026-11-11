// soul v1.1 C6 (20 ต.ค. 2026): ลูกค้าที่มาด้วยเรื่อง LINE / Facebook / ที่ปรึกษา / วางระบบ ไม่ได้บันไดระดับการใช้ AI
// และเครื่องตอบ v3 (ที่รู้จักแค่ 2 คลาส AI) ส่งเทิร์นนั้นให้เครื่องเดิมที่เห็นการ์ดทุกบริการ
// พี่ง้วงยืนยัน 20 ต.ค.: สาย LINE / Facebook = Private Class ราคาเดียวกัน แล้วส่งแบบฟอร์มให้ทีม · ประโยคทั้งหมดสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { mentionsNonAiService, NON_AI_SERVICE_TOPIC } from "../src/serviceTopic.mjs";
import { chooseLane } from "../src/replyEngineV3/lanes.mjs";
import { baseRules } from "../src/pipeline.mjs";

const WANTS = [
  "สนใจเรียน LINE OA ค่ะ", "อยากให้ LINE OA ของร้านตอบลูกค้าได้ดีกว่านี้ค่ะ", "มีคลาสสอน Facebook Ads ไหมคะ",
  "สนใจคอร์ส LINE Ads", "LINE OA มีคอร์สไหม", "อยากได้ที่ปรึกษาเรื่อง AI ในบริษัท", "รับทำแชทบอทให้ร้านไหมคะ",
  "ขอปรึกษาเรื่องยิงแอดเฟสหน่อย", "สนใจ consult รายเดือนครับ",
];
// เล่างานของตัวเอง/ช่องทางที่ทักมา/อยากสร้างเอง = คลาส AI ตามปกติ
const ORDINARY = [
  "ขายของผ่าน LINE OA ค่ะ", "ทักมาจาก LINE ค่ะ", "ร้านยิงแอดเองอยู่ค่ะ", "เห็นโฆษณาในเฟสค่ะ", "อยากทำแชทบอทเองค่ะ",
  "วิทยากรคือใครคะ", "ขอปรึกษาหน่อยค่ะ", "อยากเรียน AI ค่ะ", "ทำร้านกาแฟค่ะ อยากให้ AI ช่วยทำโพสต์",
];

test("ตัวจับ: อยากเรียน/อยากได้บริการสาย LINE · Facebook · ที่ปรึกษา · วางระบบ = ใช่ · เล่างาน/ช่องทาง/สร้างเอง = ไม่ใช่", () => {
  for (const text of WANTS) assert.ok(NON_AI_SERVICE_TOPIC.test(text), text);
  for (const text of ORDINARY) assert.ok(!NON_AI_SERVICE_TOPIC.test(text), text);
  assert.equal(mentionsNonAiService(["สวัสดีค่ะ", "สนใจเรียน LINE OA ค่ะ"]), true);
  assert.equal(mentionsNonAiService([]), false);
});

const lane = (text, history = []) => chooseLane({
  text, parts: [], history, customer: { ai_enabled: 1, deal_status: "new" }, intent: "general",
  priceDisclosure: { mode: "defer", reason: "defer_cold_no_money_ask" }, handoffIntent: null, projectHandoff: null,
  handoffProject: null, projectOpportunity: null, outlinePlan: { deliver: false }, hasApprovedFacts: true, inboundFlags: [],
});

test("v3: เทิร์นสาย LINE / Facebook / ที่ปรึกษา ไปเครื่องเดิม (service_topic) · เทิร์นคลาส AI ปกติยังเป็น v3 · เรื่องในหน้าต่างล่าสุดยังนับ", () => {
  for (const text of WANTS) assert.deepEqual(lane(text), { engine: "legacy", reason: "service_topic" }, text);
  for (const text of ORDINARY) assert.notEqual(lane(text).reason, "service_topic", text);
  const later = lane("ราคาเท่าไหร่คะ", [{ role: "user", content: "สนใจเรียน LINE OA ค่ะ" }, { role: "assistant", content: "ได้เลยค่ะ" }]);
  assert.equal(later.reason, "service_topic");
});

test("เครื่องเดิม: ข้อความแรกสาย LINE / Facebook / ที่ปรึกษา ไม่มีกติกาแนบบันได · ข้อความแรกเรื่อง AI ยังได้บันไดเหมือนเดิม", () => {
  const LADDER_RULE = /ข้อความแรกเท่านั้น: แนบรูปบันได 7 Stage/u;
  const allowLadder = { approvedImageKeys: new Set(["ai-stage-ladder"]) };
  for (const text of WANTS) assert.doesNotMatch(baseRules("general", [], { currentText: text, history: [], ...allowLadder }), LADDER_RULE, text);
  for (const text of ["สนใจ", "สวัสดีค่ะ สนใจคลาส AI", "ขายของผ่าน LINE OA ค่ะ"]) {
    assert.match(baseRules("general", [], { currentText: text, history: [], ...allowLadder }), LADDER_RULE, text);
  }
});
