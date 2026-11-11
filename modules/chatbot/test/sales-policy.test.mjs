import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDirectOpportunityType, extractContactPhoneQuote, loadSalesPolicy, normalizeSalesSignals, renderHandoffPing, renderSalesPolicyPrompt, staleOnSitePin, validateSalesPolicy } from "../src/salesPolicy.mjs";
import { validateReplyDeliveryPolicy } from "../src/replyDeliveryPolicy.mjs";
import { createApp } from "../src/server.mjs";
import { buildScorerSystem, parseScorePayload } from "../src/scoring.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig , promptText} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };

const policyInput = {
  schemaVersion: 1,
  businessId: "pngoung-tidkradum",
  customerJourneys: ["new_lead", "returning_student", "progression_candidate"],
  decisionRoles: ["owner", "ceo", "decision_maker"],
  routingPrior: { dominantInterest: "ai", share: 0.99, publicClaimAuthorized: false },
  courses: [
    { id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic", "AI for Business"], progressesTo: "ai-workflow-automation" },
    { id: "ai-workflow-automation", type: "group_live", name: "AI Workflow Automation", aliases: ["AI Advance", "M3", "Make Automation"] },
  ],
  opportunities: [
    { type: "course_progression", requiredSlots: ["current_course_id", "business_need"], optionalSlots: ["desired_outcome"], upsize: false, handoffOnComplete: false },
    { type: "private_class", requiredSlots: ["organization_context", "audience_size", "business_need"], optionalSlots: ["timeline"], upsize: true, handoffOnComplete: true },
    { type: "speaker_engagement", requiredSlots: ["organization_context", "audience_size", "business_need"], optionalSlots: ["timeline"], upsize: false, handoffOnComplete: true },
  ],
};

test("sales policy: valid catalog retains exact courses and emits constrained scorer prompt", () => {
  const policy = validateSalesPolicy(policyInput);
  assert.equal(policy.courses[0].name, "AI Agent for Business");
  assert.ok(renderSalesPolicyPrompt(policy).includes("AI Workflow Automation"));
  assert.match(renderSalesPolicyPrompt(policy), /Never infer course history/u);
});

test("course scoring: suggestion OFF omits advice while preserving course evidence policy", () => {
  const policy = validateSalesPolicy(policyInput);
  const off = buildScorerSystem({ salesPolicy: policy, suggestionsEnabled: false });
  const on = buildScorerSystem({ salesPolicy: policy, suggestionsEnabled: true });
  assert.doesNotMatch(off, /next_move|suggested_question|คำแนะนำต้องเห็นอกเห็นใจ/);
  assert.match(on, /next_move|suggested_question/);
  assert.match(off, /customer_journey/);
  assert.match(off, /AI Agent for Business/);
  assert.match(off, /always return order=null/);
  assert.ok(off.length < on.length);
});

test("sales policy: absent is disabled; configured invalid throws instead of silently falling back", (t) => {
  assert.equal(loadSalesPolicy(""), null);
  assert.throws(() => loadSalesPolicy("/definitely/not/a/policy.json"), /configured file does not exist/u);
  const dir = mkdtempSync(join(tmpdir(), "sales-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, '{"schemaVersion":1}');
  assert.throws(() => loadSalesPolicy(bad), /Invalid sales policy/u);
});

test("sales policy: no role is inferred from a title/name-like value", () => {
  const policy = validateSalesPolicy(policyInput);
  const result = normalizeSalesSignals({
    customer_journey: "new_lead",
    customer_journey_evidence: { type: "no_verified_learning_record", confidence: "high", evidence: "no verified record in approved local profile" },
    decision_role: { role: "ceo", explicit: false, confidence: "high", evidence: "profile says CEO" },
    opportunity: { type: "private_class", origin: "proactive_recommendation", slots: {
      organization_context: { value: "บริษัท", evidence: "บริษัท" },
      audience_size: { value: "20", evidence: "20 คน" },
      business_need: { value: "อยากให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
    } },
  }, policy, null, { customerText: "โปรไฟล์เขียนว่า CEO ของบริษัท มี 20 คน สนใจ private class และอยากให้ทีมใช้ AI" });
  assert.equal(result.decisionRole, null);
  assert.equal(result.opportunity.upsizeEligible, false);
});

test("sales policy: direct request can hand off; proactive upsize needs explicit high-confidence authority", () => {
  const policy = validateSalesPolicy(policyInput);
  const pending = normalizeSalesSignals({
    customer_journey: "new_lead",
    customer_journey_evidence: { type: "no_verified_learning_record", confidence: "high", evidence: "no verified record in approved local profile" },
    opportunity: { type: "private_class", origin: "direct_request", slots: {
      organization_context: { value: "บริษัท", evidence: "บริษัท" },
      business_need: { value: "อยากให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
    } },
  }, policy, null, { customerText: "อยากเรียน private class บริษัทอยากให้ทีมใช้ AI" });
  assert.deepEqual(pending.opportunity.missingSlots, ["audience_size"]);
  assert.equal(pending.opportunity.handoffReady, false);

  const ready = normalizeSalesSignals({
    customer_journey: "new_lead",
    customer_journey_evidence: { type: "no_verified_learning_record", confidence: "high", evidence: "no verified record in approved local profile" },
    decision_role: { role: "owner", explicit: true, confidence: "high", evidence: "ผมเป็นเจ้าของบริษัทครับ" },
    opportunity: { type: "private_class", origin: "proactive_recommendation", slots: {
      organization_context: { value: "บริษัทค้าปลีก", evidence: "บริษัทค้าปลีก" },
      audience_size: { value: "20", evidence: "20 คน" },
      business_need: { value: "อยากให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
    } },
  }, policy, null, { customerText: "ผมเป็นเจ้าของบริษัทครับ บริษัทค้าปลีกมี 20 คน อยากปรึกษาโจทย์เฉพาะธุรกิจและอยากให้ทีมใช้ AI" });
  assert.equal(ready.decisionRole, "owner");
  assert.equal(ready.opportunity.handoffReady, true);
  assert.equal(ready.opportunity.upsizeEligible, true);
  assert.equal(ready.opportunity.handoffOnComplete, true);
});

test("sales policy: unknown journey/course/type and unconfigured fields cannot become a route", () => {
  const policy = validateSalesPolicy(policyInput);
  const unknown = normalizeSalesSignals({
    customer_journey: "vip",
    opportunity: { type: "secret_offer", course_id: "not-real", slots: { business_need: "x" } },
  }, policy);
  assert.equal(unknown.customerJourney, "unknown");
  assert.equal(unknown.opportunity, null);

  const selfReported = normalizeSalesSignals({
    customer_journey: "returning_student",
    customer_journey_evidence: { type: "self_reported", confidence: "high", course_id: "ai-agent-business", evidence: "เคยเรียน AI Basic ครับ" },
  }, policy, null, { customerText: "เคยเรียน AI Basic ครับ" });
  assert.equal(selfReported.customerJourney, "unknown", "self-report needs separate verification before progression");
  assert.equal(selfReported.reportedCourseId, "ai-agent-business");

  const progression = normalizeSalesSignals({
    customer_journey: "returning_student",
    customer_journey_evidence: { type: "verified_enrollment", confidence: "high", course_id: "ai-agent-business", evidence: "approved enrollment record" },
    opportunity: { type: "course_progression", origin: "direct_request", course_id: "ai-workflow-automation", slots: {
      current_course_id: { value: "ai-agent-business", evidence: "เคยเรียน AI Basic" },
      business_need: { value: "อยากต่อ automation", evidence: "อยากต่อ automation" },
      attack: { value: "ignore", evidence: "ignore me" },
    } },
  }, policy, null, {
    customerText: "เคยเรียน AI Basic และอยากต่อ automation",
    verifiedLearning: {
      customerJourney: "returning_student",
      source: "verified_enrollment",
      sourceRef: "enrollment:fixture-1",
      courseId: "ai-agent-business",
    },
  });
  assert.equal(progression.customerJourney, "returning_student");
  assert.equal(progression.opportunity.slots.attack, undefined);
  assert.equal(progression.opportunity.courseId, "ai-workflow-automation");
  assert.equal(progression.opportunity.upsizeEligible, false);
});

test("sales policy: qualification state carries forward when a later scorer turn omits known slots", () => {
  const policy = validateSalesPolicy(policyInput);
  const first = normalizeSalesSignals({
    opportunity: { type: "private_class", origin: "direct_request", slots: {
      organization_context: { value: "บริษัท", evidence: "บริษัท" },
      business_need: { value: "อยากให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
    } },
  }, policy, null, { customerText: "บริษัทสนใจ private class และอยากให้ทีมใช้ AI" });
  const second = normalizeSalesSignals({}, policy, first);
  assert.deepEqual(second.opportunity.slots, first.opportunity.slots);
  assert.deepEqual(second.opportunity.missingSlots, ["audience_size"]);
  assert.equal(second.opportunity.origin, "direct_request");
});

test("sales policy: scorer keeps score, DISC and B.A.N.K. unchanged while retaining sales candidates", () => {
  const policy = validateSalesPolicy(policyInput);
  const payload = parseScorePayload(JSON.stringify({
    score: 7, trend: "up", persona_read: { disc: "D", bank: "Action", reason: "ตรงประเด็น" },
    customer_journey: "returning_student",
    customer_journey_evidence: { type: "verified_enrollment", confidence: "high", course_id: "ai-agent-business", evidence: "record" },
  }));
  assert.equal(payload.score, 7);
  assert.equal(payload.persona_read.disc, "D");
  assert.equal(payload.persona_read.bank, "Action");
  assert.equal(normalizeSalesSignals(payload.sales_signals, policy).customerJourney, "unknown",
    "model output alone cannot verify a customer journey");
  assert.equal(normalizeSalesSignals(payload.sales_signals, policy, null, {
    verifiedLearning: {
      customerJourney: "returning_student",
      source: "verified_enrollment",
      sourceRef: "enrollment:fixture-2",
      courseId: "ai-agent-business",
    },
  }).customerJourney, "returning_student");
  assert.match(buildScorerSystem({ salesPolicy: policy }), /Opportunity policy/u);
});

test("sales policy: fabricated role, journey, and slot values cannot create a handoff", () => {
  const policy = validateSalesPolicy(policyInput);
  const result = normalizeSalesSignals({
    customer_journey: "returning_student",
    customer_journey_evidence: {
      type: "verified_enrollment", confidence: "high", course_id: "ai-agent-business", evidence: "approved CRM record",
    },
    decision_role: { role: "ceo", explicit: true, confidence: "high", evidence: "ผมเป็น CEO" },
    opportunity: {
      type: "private_class", origin: "proactive_recommendation",
      slots: {
        organization_context: { value: "บริษัทใหญ่", evidence: "บริษัทใหญ่" },
        audience_size: { value: "500", evidence: "500 คน" },
        business_need: { value: "ซื้อทันที", evidence: "ซื้อทันที" },
      },
    },
  }, policy, null, { customerText: "ขอข้อมูลคลาส AI ครับ" });
  assert.equal(result.customerJourney, "unknown");
  assert.equal(result.decisionRole, null);
  assert.equal(result.opportunity, null, "model cannot create an opportunity route without deterministic customer intent");
});

test("sales policy: a real but irrelevant quote cannot satisfy every qualification slot", () => {
  const policy = validateSalesPolicy(policyInput);
  const quote = "ขอข้อมูล private class AI ครับ";
  const result = normalizeSalesSignals({
    opportunity: {
      type: "private_class",
      origin: "direct_request",
      slots: {
        organization_context: { value: quote, evidence: quote },
        audience_size: { value: quote, evidence: quote },
        business_need: { value: quote, evidence: quote },
      },
    },
  }, policy, null, { customerText: quote });
  assert.deepEqual(result.opportunity.slots, {});
  assert.deepEqual(result.opportunity.missingSlots, ["organization_context", "audience_size", "business_need"]);
  assert.equal(result.opportunity.handoffReady, false);
});

test("sales policy: a customer correction revokes prior decision authority", () => {
  const policy = validateSalesPolicy(policyInput);
  const first = normalizeSalesSignals({}, policy, null, { customerText: "ผมเป็น CEO ครับ" });
  assert.equal(first.decisionRole, "ceo");
  const corrected = normalizeSalesSignals({}, policy, first, {
    customerText: "เมื่อกี้พิมพ์ผิดครับ ผมเป็นพนักงาน ไม่มีอำนาจตัดสินใจ",
  });
  assert.equal(corrected.decisionRole, null);
  assert.equal(corrected.decisionRoleSource, null);
});

test("sales policy: denying prior study clears self-report and progression route", () => {
  const policy = validateSalesPolicy(policyInput);
  const first = normalizeSalesSignals({
    opportunity: { type: "course_progression", slots: {} },
  }, policy, null, { customerText: "เคยเรียน AI Basic ครับ อยากเรียนต่อ" });
  assert.equal(first.reportedCourseId, "ai-agent-business");
  assert.equal(first.opportunity.type, "course_progression");

  const corrected = normalizeSalesSignals({
    opportunity: { type: "course_progression", slots: {
      current_course_id: { value: "ai-agent-business", evidence: "เคยเรียน AI Basic" },
    } },
  }, policy, first, {
    customerText: "เคยเรียน AI Basic ครับ อยากเรียนต่อ\nเมื่อกี้พิมพ์ผิดค่ะ ยังไม่เคยเรียน AI Basic",
    latestCustomerText: "เมื่อกี้พิมพ์ผิดค่ะ ยังไม่เคยเรียน AI Basic",
  });
  assert.equal(corrected.reportedCourseId, null);
  assert.equal(corrected.opportunity, null);
});

test("sales policy: completed enquiry does not leak slots into a later direct request", () => {
  const policy = validateSalesPolicy(policyInput);
  const firstText = "อยากเรียน private class บริษัทค้าปลีกมี 20 คน อยากให้ทีมใช้ AI";
  const first = normalizeSalesSignals({
    opportunity: { type: "private_class", origin: "direct_request", slots: {
      organization_context: { value: "บริษัทค้าปลีก", evidence: "บริษัทค้าปลีก" },
      audience_size: { value: "20", evidence: "20 คน" },
      business_need: { value: "อยากให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
    } },
  }, policy, null, { customerText: firstText });
  assert.equal(first.opportunity.handoffReady, true);

  const second = normalizeSalesSignals({
    opportunity: { type: "private_class", origin: "direct_request", slots: {
      organization_context: { value: "กิจการครอบครัว", evidence: "กิจการครอบครัว" },
    } },
  }, policy, first, { customerText: "รอบนี้เป็นกิจการครอบครัว สนใจ private class ใหม่ค่ะ" });
  assert.deepEqual(second.opportunity.slots, { organization_context: "กิจการครอบครัว" });
  assert.deepEqual(second.opportunity.missingSlots, ["audience_size", "business_need"]);
  assert.equal(second.opportunity.handoffReady, false);

  const omittedOrigin = normalizeSalesSignals({
    opportunity: { type: "private_class", slots: {
      organization_context: { value: "กิจการใหม่", evidence: "กิจการใหม่" },
    } },
  }, policy, first, { customerText: "กิจการใหม่ขอเริ่มคุย private class อีกเรื่องค่ะ" });
  assert.deepEqual(omittedOrigin.opportunity.slots, { organization_context: "กิจการใหม่" },
    "missing model origin cannot revive completed requirements");
  assert.equal(omittedOrigin.opportunity.handoffReady, false);

  const unrelated = normalizeSalesSignals({}, policy, first, { customerText: "ขอถามเรื่อง LINE OA แทนครับ" });
  assert.equal(unrelated.opportunity, null, "completed opportunity is archived outside later reply context");

  const staleCandidate = normalizeSalesSignals({
    opportunity: { type: "private_class", origin: "direct_request", slots: {
      organization_context: { value: "บริษัทค้าปลีก", evidence: "บริษัทค้าปลีก" },
      audience_size: { value: "20 คน", evidence: "20 คน" },
      business_need: { value: "อยากให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
    } },
  }, policy, first, {
    customerText: `${firstText}\nขอเริ่ม private class เรื่องใหม่ค่ะ`,
    latestCustomerText: "ขอเริ่ม private class เรื่องใหม่ค่ะ",
  });
  assert.deepEqual(staleCandidate.opportunity.slots, {},
    "a new enquiry cannot reuse exact quotes from the completed session");
  assert.deepEqual(staleCandidate.opportunity.missingSlots,
    ["organization_context", "audience_size", "business_need"]);
  assert.equal(staleCandidate.opportunity.handoffReady, false);
});

test("sales policy: stale private request in evidence cannot route an unrelated latest turn", () => {
  const policy = validateSalesPolicy(policyInput);
  const oldPrivateRequest = "ขอเรียน private class สำหรับบริษัทค่ะ";
  const latestLineOaQuestion = "ขอถามเรื่อง LINE OA แทนครับ";
  const result = normalizeSalesSignals({
    opportunity: { type: "private_class", origin: "direct_request", slots: {
      organization_context: { value: "บริษัท", evidence: "บริษัท" },
    } },
  }, policy, null, {
    customerText: `${oldPrivateRequest}\n${latestLineOaQuestion}`,
    latestCustomerText: latestLineOaQuestion,
  });
  assert.equal(result.opportunity, null,
    "old exact evidence may remain available for validation but cannot reopen a route");
});

test("sales policy: pipeline routes from the latest customer turn while retaining full evidence", async (t) => {
  const policy = validateSalesPolicy(policyInput);
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-latest-route", {});
  db.insertMessage({ customerId: "U-latest-route", direction: "in", content: "ขอเรียน private class สำหรับบริษัทค่ะ" });
  db.insertMessage({ customerId: "U-latest-route", direction: "out", content: "รับทราบเรื่อง private class ค่ะ" });
  db.insertMessage({ customerId: "U-latest-route", direction: "in", content: "ขอถามเรื่อง LINE OA แทนครับ" });
  db.insertMessage({ customerId: "U-latest-route", direction: "out", content: "ได้เลยค่ะ" });
  const app = createApp({
    config: testConfig(), db,
    overrides: {
      salesPolicy: policy,
      hermesFetch: hermesFetchStub(JSON.stringify({
        score: 6, trend: "up",
        opportunity: { type: "private_class", origin: "direct_request", slots: {
          organization_context: { value: "บริษัท", evidence: "บริษัท" },
        } },
      })),
      lineFetch: lineFetchStub(), sleep: async () => {},
    },
    logger: silent,
  });

  const payload = await app.pipeline.scoreBurst("U-latest-route");
  assert.equal(payload.salesState.opportunity, null);
});

test("sales policy: contiguous LINE messages form one latest inbound burst for route and evidence", async (t) => {
  const policy = validateSalesPolicy(policyInput);
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-latest-burst", {});
  db.insertMessage({
    customerId: "U-latest-burst", direction: "in",
    content: "อยากเรียน private class บริษัทค้าปลีกมี 20 คน อยากให้ทีมใช้ AI",
  });
  db.insertMessage({ customerId: "U-latest-burst", direction: "in", content: "ค่ะ" });
  db.insertMessage({ customerId: "U-latest-burst", direction: "out", content: "แพรรับรายละเอียดแล้วค่ะ" });
  const app = createApp({
    config: testConfig(), db,
    overrides: {
      salesPolicy: policy,
      hermesFetch: hermesFetchStub(JSON.stringify({
        score: 6, trend: "up",
        opportunity: { type: "private_class", origin: "direct_request", slots: {
          organization_context: { value: "บริษัทค้าปลีก", evidence: "บริษัทค้าปลีก" },
          audience_size: { value: "20 คน", evidence: "20 คน" },
          business_need: { value: "อยากให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
        } },
      })),
      lineFetch: lineFetchStub(), sleep: async () => {},
    },
    logger: silent,
  });

  const payload = await app.pipeline.scoreBurst("U-latest-burst");
  assert.equal(payload.salesState.opportunity.type, "private_class");
  assert.equal(payload.salesState.opportunity.handoffReady, true);
  assert.deepEqual(payload.salesState.opportunity.slots, {
    organization_context: "บริษัทค้าปลีก",
    audience_size: "20 คน",
    business_need: "อยากให้ทีมใช้ AI",
  });
});

test("sales policy: malformed fresh type cannot erase an open qualification", () => {
  const policy = validateSalesPolicy(policyInput);
  const active = normalizeSalesSignals({
    opportunity: { type: "private_class", slots: {
      organization_context: { value: "บริษัทค้าปลีก", evidence: "บริษัทค้าปลีก" },
    } },
  }, policy, null, { customerText: "อยากเรียน private class สำหรับบริษัทค้าปลีก" });
  assert.equal(active.opportunity.type, "private_class");

  const next = normalizeSalesSignals({
    opportunity: { type: "private_clas_typo", slots: {
      audience_size: { value: "20 คน", evidence: "20 คน" },
    } },
  }, policy, active, { customerText: "มี 20 คนค่ะ" });
  assert.equal(next.opportunity.type, "private_class");
  assert.deepEqual(next.opportunity.slots, active.opportunity.slots,
    "unconfigured model type is ignored instead of switching or erasing state");
});

test("sales policy: scorer bounds nested sales candidates before normalization", () => {
  const payload = parseScorePayload(JSON.stringify({
    score: 5,
    opportunity: {
      type: "private_class",
      origin: "direct_request",
      ignored: { deeply: { nested: "x".repeat(10_000) } },
      slots: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
        `slot_${index}`,
        { value: "v".repeat(900), evidence: "e".repeat(900), extra: { nested: true } },
      ])),
    },
  }));
  assert.equal(Object.keys(payload.sales_signals.opportunity.slots).length, 20);
  assert.equal(payload.sales_signals.opportunity.slots.slot_0.value.length, 500);
  assert.equal(payload.sales_signals.opportunity.ignored, undefined);
});

test("sales policy: normalized ready handoff is stored, pauses AI once, and never changes score semantics", async (t) => {
  const policy = validateSalesPolicy(policyInput);
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-handoff", {});
  db.insertMessage({ customerId: "U-handoff", direction: "in", content: "อยากเรียน private class บริษัทค้าปลีกมีทีม 20 คน อยากให้ทีมใช้ AI" });
  const scorer = JSON.stringify({
    score: 6,
    trend: "up",
    persona_read: { disc: "S", bank: "Nurturing", reason: "ให้ข้อมูลอย่างใจเย็น" },
    opportunity: {
      type: "private_class",
      origin: "direct_request",
      slots: {
        organization_context: { value: "บริษัทค้าปลีก", evidence: "บริษัทค้าปลีก" },
        audience_size: { value: "20 คน", evidence: "20 คน" },
        business_need: { value: "ให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
      },
    },
    order: null,
  });
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch: hermesFetchStub(scorer), lineFetch: lineFetchStub(), salesPolicy: policy, sleep: async () => {} },
    logger: silent,
  });

  const payload = await app.pipeline.scoreBurst("U-handoff");
  assert.equal(payload.score, 6);
  // 4 ต.ค. 2026: ธุรกิจคอร์สเลิกใช้ DISC (อ่านไม่ออก 81% ใน ก.ย.) — B.A.N.K. และคะแนนยังเหมือนเดิม
  assert.equal(payload.persona_read.disc, "unknown");
  assert.equal(payload.disc_retired, true);
  assert.equal(payload.salesState.opportunity.handoffReady, true);
  assert.equal(db.getCustomer("U-handoff").state, "NEEDS_HUMAN");
  assert.equal(db.getCustomer("U-handoff").ai_enabled, 0, "completed opportunity is a sticky human takeover");
  assert.ok(db.getCustomer("U-handoff").operator_active_until > Date.now());
  assert.equal(db.listAudit(20).filter((row) => row.action === "opportunity_handoff_takeover").length, 1);
  const stored = JSON.parse(db.latestScoreRow("U-handoff").payload_json);
  assert.equal(stored.salesState.opportunity.type, "private_class");
  assert.equal(stored.sales_signals, undefined, "raw model candidates are never retained");

  await app.pipeline.scoreBurst("U-handoff");
  assert.equal(db.listAudit(20).filter((row) => row.action === "opportunity_handoff").length, 1);

  const handoffKey = "opportunity_handoff:U-handoff:private_class";
  assert.ok(db.getSetting(handoffKey));
  db.resetCustomer("U-handoff");
  assert.equal(db.getSetting(handoffKey), null, "PDPA reset removes customer-scoped handoff idempotence");
  assert.equal(db.getCustomer("U-handoff").ai_enabled, 1, "reset is the explicit clean-state release path");
  db.insertMessage({ customerId: "U-handoff", direction: "in", content: "อยากเรียน private class บริษัทค้าปลีกมีทีม 20 คน อยากให้ทีมใช้ AI" });
  await app.pipeline.scoreBurst("U-handoff");
  assert.equal(db.getCustomer("U-handoff").state, "NEEDS_HUMAN", "the same legitimate lead can hand off after reset");
  assert.ok(db.getSetting(handoffKey));
});

// v1.3.6 (คำสั่งพี่ง้วง 2026-08-14): งาน project ให้ชมพู่รับช่วง — ครบ slot ต้อง ping ทันที
test("sales policy: completed handoff pings the team once with a call-ready summary", async (t) => {
  const policy = validateSalesPolicy(policyInput);
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-ping", { displayName: "สมศักดิ์" });
  db.insertMessage({ customerId: "U-ping", direction: "in", content: "อยากเรียน private class บริษัทค้าปลีกมีทีม 20 คน อยากให้ทีมใช้ AI" });
  const scorer = JSON.stringify({
    score: 6,
    trend: "up",
    persona_read: { disc: "S", bank: "Nurturing", reason: "ให้ข้อมูลอย่างใจเย็น" },
    opportunity: {
      type: "private_class",
      origin: "direct_request",
      slots: {
        organization_context: { value: "บริษัทค้าปลีก", evidence: "บริษัทค้าปลีก" },
        audience_size: { value: "20 คน", evidence: "20 คน" },
        business_need: { value: "ให้ทีมใช้ AI", evidence: "อยากให้ทีมใช้ AI" },
      },
    },
    order: null,
  });
  const pings = [];
  const app = createApp({
    config: testConfig(), db,
    overrides: {
      hermesFetch: hermesFetchStub(scorer), lineFetch: lineFetchStub(), salesPolicy: policy,
      sleep: async () => {},
      notifier: { fireLater: (args) => pings.push(args), fire: async (args) => pings.push(args) },
    },
    logger: silent,
  });

  await app.pipeline.scoreBurst("U-ping");
  assert.equal(pings.length, 1, "ครบ slot = ping ทีมงานหนึ่งครั้ง");
  assert.equal(pings[0].reason, "opportunity_handoff");
  assert.equal(pings[0].force, true, "เหตุยิงครั้งเดียวตลอดชีพ ห้ามให้ cooldown กลืน");
  assert.match(pings[0].reasonTextOverride, /Private Class/u, "บอกประเภทงานเป็นภาษาคน");
  assert.match(pings[0].reasonTextOverride, /อยากให้ทีมใช้ AI/u, "สรุปมีคำพูดจริงของลูกค้า");
  assert.match(pings[0].reasonTextOverride, /organization_context/u, "slot นอกรายการ label ต้องไม่หายจากสรุป");
  assert.match(pings[0].reasonTextOverride, /AI หยุดตอบ/u, "บอกทีมว่าลูกค้าคนนี้รอคนจริง");
  assert.equal(pings[0].customerName, "สมศักดิ์");

  await app.pipeline.scoreBurst("U-ping");
  assert.equal(pings.length, 1, "fingerprint เดิมห้าม ping ซ้ำ");
});

test("sales policy: ai_auto opportunity UI note never re-enters the reply system prompt", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-prompt-note", {});
  db.addHandoffNote({
    customerId: "U-prompt-note", author: "ai_auto",
    text: "Opportunity private_class พร้อมส่งต่อทีมแล้ว: audience_size=20; business_need=อบรมทีม",
  });
  db.addHandoffNote({ customerId: "U-prompt-note", author: "admin-jane", text: "ลูกค้าขอคุยช่วงบ่าย" });
  let draftSystem = "";
  const hermesFetch = hermesFetchStub("รับทราบค่ะ เดี๋ยวช่วยดูให้นะคะ", {
    onCall: ({ body }) => {
      const system = promptText(body.messages.find((message) => message.role === "system")?.content);
      if (system.includes("บันทึกจากทีมงาน:")) draftSystem = system;
    },
  });
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });

  await app.pipeline.handleInboundText({ customerId: "U-prompt-note", text: "ขอรายละเอียดเพิ่มค่ะ", replyToken: "rt" });
  assert.match(draftSystem, /ลูกค้าขอคุยช่วงบ่าย/u);
  assert.doesNotMatch(draftSystem, /Opportunity private_class พร้อมส่งต่อทีมแล้ว/u);
});

test("sales policy: simultaneous scoreBurst callers coalesce into one scorer write", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-score-singleflight", {});
  db.insertMessage({ customerId: "U-score-singleflight", direction: "in", content: "สนใจเรียน AI ค่ะ" });
  let resolveScore;
  let calls = 0;
  const scorerFetch = async () => {
    calls += 1;
    await new Promise((resolve) => { resolveScore = resolve; });
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ score: 4, trend: "up" }) } }] }),
    };
  };
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch: scorerFetch, lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });

  const first = app.pipeline.scoreBurst("U-score-singleflight");
  const second = app.pipeline.scoreBurst("U-score-singleflight");
  assert.strictEqual(second, first, "scheduled/direct overlap shares a single in-flight score run");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  resolveScore();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(db.latestScoreRow("U-score-singleflight").score, 4);
});

test("sales policy: a new inbound turn during scheduled scoring triggers one trailing fresh score", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  let scoreCalls = 0;
  const scoreResolvers = [];
  const hermesFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = promptText(body.messages.find((message) => message.role === "system")?.content);
    if (system.includes("ระบบวิเคราะห์ความสนใจซื้อ")) {
      scoreCalls += 1;
      return new Promise((resolve) => scoreResolvers.push(resolve));
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "รับทราบค่ะ อยากเริ่มจากเรื่องไหนคะ" } }] }),
    };
  };
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  const scoreResponse = (score) => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ score, trend: "up" }) } }] }),
  });

  db.upsertCustomer("U-score-trailing", {});
  db.insertMessage({ customerId: "U-score-trailing", direction: "in", content: "สนใจ AI ค่ะ" });
  await app.pipeline.handleInboundText({ customerId: "U-score-trailing", text: "สนใจ AI ค่ะ", replyToken: "rt-1" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(scoreCalls, 1);

  db.insertMessage({ customerId: "U-score-trailing", direction: "in", content: "อยากให้ทีมลดงานซ้ำค่ะ" });
  await app.pipeline.handleInboundText({ customerId: "U-score-trailing", text: "อยากให้ทีมลดงานซ้ำค่ะ", replyToken: "rt-2" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(scoreCalls, 1, "second scheduled call marks dirty instead of starting an overlapping scorer");

  scoreResolvers.shift()(scoreResponse(3));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(scoreCalls, 2, "the dirty transcript is scored once more after the first run finishes");
  scoreResolvers.shift()(scoreResponse(6));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(db.latestScoreRow("U-score-trailing").score, 6);
});

// v1.2.5 (สเปคเปลี่ยนหลังตรวจอิสระ 2026-08-13): กติกาจำนวนรูป/คำถามเป็นเรื่องรูปแบบ
// การทิ้งคำตอบทั้งก้อนหรือริบรูปทั้งหมดทำให้ลูกค้าเจอทางตัน (เคสจริง: ขอใบเสร็จแล้ว
// ได้ "ข้อมูลตรงนี้ยังยืนยันไม่ได้ค่ะ" และไม่ได้รูป) — ระบบต้องลดทอนแล้วส่งต่อเสมอ
test("reply delivery policy: disabled preserves legacy image output; enabled trims to the cap and still delivers", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const catalog = [
    { key: "a", url: "https://img.test/a.jpg" }, { key: "b", url: "https://img.test/b.jpg" }, { key: "c", url: "https://img.test/c.jpg" },
  ];
  const disabledLine = lineFetchStub();
  const disabled = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch: hermesFetchStub("ดูรูปค่ะ [IMAGE:a] [IMAGE:b] [IMAGE:c]"), lineFetch: disabledLine, imageCatalog: catalog, sleep: async () => {} }, logger: silent,
  });
  const legacy = await disabled.pipeline.handleInboundText({ customerId: "U-disabled", text: "ขอรูป", replyToken: "rt" });
  assert.deepEqual(legacy.imageKeys, ["a", "b", "c"]);

  const db2 = memoryDb();
  t.after(() => db2.close());
  const line = lineFetchStub();
  const app = createApp({
    config: testConfig(), db: db2,
    overrides: {
      hermesFetch: hermesFetchStub("ดูรูปค่ะ [IMAGE:a] [IMAGE:b] [IMAGE:c]"), lineFetch: line, imageCatalog: catalog,
      replyDeliveryPolicy: validateReplyDeliveryPolicy({ enabled: true }), sleep: async () => {},
    }, logger: silent,
  });
  const delivered = await app.pipeline.handleInboundText({ customerId: "U-enabled", text: "ขอรูป", replyToken: "rt" });
  assert.equal(delivered.sent, true, "ลูกค้าต้องได้รับคำตอบ ไม่ใช่ทางตัน");
  assert.equal(delivered.imageKeys.length, 2, "เกินเพดานให้ตัดเหลือเท่าเพดาน ไม่ใช่ริบทั้งหมด");
  assert.equal(db2.getCustomer("U-enabled").state, "AI_ACTIVE", "ผิดรูปแบบไม่ใช่เหตุให้เรียกคนมารับเรื่อง");
  const outbound = db2.messagesFor("U-enabled").filter((message) => message.direction === "out");
  assert.ok(outbound.some((message) => /ดูรูปค่ะ/u.test(message.content)), "เนื้อความจริงต้องถึงลูกค้า");
});

// v1.4.1 (เคสจริง 2026-08-14): "แล้วให้ไปสอนที่บริษัท มีไหม" ต้องเข้าเส้น in-house
test("sales policy: Thai on-site teaching phrasing routes to in_house_training", () => {
  // fixture หลักของไฟล์นี้จงใจไม่มี in_house_training — สร้าง policy ที่มีครบสำหรับเทสต์เส้นทางนี้
  const policy = validateSalesPolicy({
    ...policyInput,
    opportunities: [
      ...policyInput.opportunities,
      { type: "in_house_training", requiredSlots: ["organization_context", "audience_size", "business_need"], optionalSlots: [], upsize: true, handoffOnComplete: true },
    ],
  });
  for (const text of [
    "แล้วให้ไปสอนที่บริษัท มีไหม",
    "สอนที่บริษัทได้ไหมครับ",
    "ไปสอนที่ออฟฟิศได้ไหม",
    "จัดอบรมให้ทีมหน่อยครับ",
    "อยากให้มาเทรนพนักงานที่โรงงาน",
    "สนใจ inhouse",
    "อยากได้ onsite ที่บริษัทค่ะ",
    "on site ให้พนักงาน 20 คน",
    "ออนไซต์ที่ออฟฟิศได้ไหม",
  ]) {
    assert.equal(detectDirectOpportunityType(text, policy), "in_house_training", `ต้องจับ: ${text}`);
  }
  // พี่ง้วง 13 ต.ค.: Classroom = On-site เช่นกัน — on-site เปล่า ๆ คือคลาสสอนสดที่ห้องเรียน ไม่ใช่งานองค์กร
  // (แชทจริง: ลูกแพรถาม "On-site หรือออนไลน์" ลูกค้าตอบ "On-site ค่ะ" แล้วถูกพาเข้าเส้น In-house)
  for (const text of ["On-site ค่ะ", "ขอรายละเอียดคลาส On-site เพิ่มเติมค่ะ", "เป็น on site หรือออนไลน์คะ", "อยากได้ onsite น้า", "เรียนออนไซต์ค่ะ"]) {
    assert.equal(detectDirectOpportunityType(text, policy), null, `ห้ามจับ: ${text}`);
  }
  // แชทจริง 13 ต.ค.: เชิญเราไปอบรม/สอนทีมเขา = งานองค์กร (เคยได้คำขายคลาสสด)
  for (const text of ["จะเชิญมาอบรม จากระดับ3 ไปให้ถึงระดับ 6", "อยากเชิญพี่ง้วงไปสอนที่บริษัท", "เชิญไปเทรนให้หน่อยครับ"]) {
    assert.equal(detectDirectOpportunityType(text, policy), "in_house_training", `ต้องจับ: ${text}`);
  }
  // หมุด in-house เก่าจาก on-site เปล่า ๆ = ล้าง · มีเจตนา in-house จริง หรือเก็บข้อมูลองค์กรไปแล้ว = คงหมุด
  const pin = { type: "in_house_training", origin: "direct_request", slots: {} };
  assert.equal(staleOnSitePin(pin, ["เป็น on site หรือออนไลน์คะ", "On-site ค่ะ"]), true);
  assert.equal(staleOnSitePin(pin, ["#inhouse"]), false);
  assert.equal(staleOnSitePin(pin, ["onsite ได้ไหม", "อยากให้มาสอนในองค์กรค่ะ"]), false);
  assert.equal(staleOnSitePin({ ...pin, slots: { audience_size: "20 คน" } }, ["onsite"]), false);
  assert.equal(staleOnSitePin({ ...pin, type: "private_class" }, ["onsite"]), false);
  // คำถามเรื่องสถานที่เรียน "ของเรา" หรือบริบททำงาน ห้ามติด
  for (const text of [
    "เรียนที่บริษัทพี่ง้วงใช่ไหมคะ",
    "ผมทำงานอยู่ที่บริษัทแห่งหนึ่ง",
    "สถาบันอยู่ที่ไหนครับ",
  ]) {
    assert.notEqual(detectDirectOpportunityType(text, policy), "in_house_training", `ห้ามจับ: ${text}`);
  }
  // วิทยากรยังชนะ (ตรวจก่อนตามลำดับ)
  assert.equal(detectDirectOpportunityType("เชิญไปบรรยายให้พนักงานที่บริษัทหน่อยครับ", policy), "speaker_engagement");
});

// ตรวจปรปักษ์ 2026-09-04 (รอบที่หก, ข้อ D): "บรรยาย" เดี่ยว ๆ เคยเป็นตัวเลือกเปล่าของ
// speaker_engagement — มันคือคำไทยธรรมดาที่แปลว่า "อธิบาย/เล่า" และมันขับแกนโปรโมชั่นอยู่
// ลูกค้าที่พิมพ์คำนี้ครั้งเดียวในห้อง จึงถูกตัดโปรโมชั่นทิ้งทั้งห้องแบบไม่มีวันกลับ
test("sales policy: 'บรรยาย' ที่แปลว่าอธิบาย ไม่ใช่การจ้างวิทยากร", () => {
  const policy = validateSalesPolicy(policyInput);
  for (const text of [
    "ช่วยบรรยายรายละเอียดคลาสหน่อยค่ะ",
    "รบกวนบรรยายเนื้อหาที่สอนหน่อยครับ",
    "อยากได้ AI ที่ช่วยบรรยายภาพสินค้าให้ครับ",
  ]) {
    assert.notEqual(detectDirectOpportunityType(text, policy), "speaker_engagement", `ห้ามจับ: ${text}`);
  }
  // เจตนาจ้างวิทยากรจริงยังต้องจับได้ครบเหมือนเดิม
  for (const text of [
    "เชิญไปบรรยายให้พนักงานหน่อยครับ",
    "อยากจ้างบรรยายในงานสัมมนาครับ",
    "ค่าตัวบรรยายเท่าไหร่ครับ",
    "รับบรรยายพิเศษไหมคะ",
    "ต้องการวิทยากรครับ",
  ]) {
    assert.equal(detectDirectOpportunityType(text, policy), "speaker_engagement", `ต้องจับ: ${text}`);
  }
});

// v1.4.1: เทิร์นแรกที่ลูกค้าเอ่ยงาน project กติกาคัดกรองต้องเข้า prompt ทันที
// (sales state จาก scorer ช้าหนึ่งเทิร์น — ห้ามรอ) และห้ามเทราคา/เอกสาร
test("sales policy: project intent in current text injects qualification-first rules into the reply prompt", async (t) => {
  const policy = validateSalesPolicy({
    ...policyInput,
    opportunities: [
      ...policyInput.opportunities,
      { type: "in_house_training", requiredSlots: ["organization_context", "audience_size", "business_need"], optionalSlots: [], upsize: true, handoffOnComplete: true },
    ],
  });
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-proj", {});
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), salesPolicy: policy, sleep: async () => {} },
    logger: silent,
  });

  await app.pipeline.handleInboundText({ customerId: "U-proj", text: "แล้วให้ไปสอนที่บริษัท มีไหมครับ", replyToken: "rt-1" });
  const system = promptText(hermesFetch.calls.find((call) => call.body?.model !== undefined)?.body?.messages?.[0]?.content);
  assert.match(system, /โหมดคัดกรองก่อนเสนอ/u, "กติกางาน project ต้องเข้า prompt ตั้งแต่เทิร์นแรก");
  assert.match(system, /ห้ามยกตารางราคา/u);
  assert.match(system, /ห้ามพูดเรื่องเอกสาร ใบเสนอราคา/u);
  assert.match(system, /In-house Training/u, "บอกประเภทงานเป็นภาษาคน");

  // ข้อความธรรมดาห้ามติดโหมดนี้
  hermesFetch.calls.length = 0;
  await app.pipeline.handleInboundText({ customerId: "U-proj2", text: "ราคาเท่าไหร่ครับ", replyToken: "rt-2" });
  const normalSystem = promptText(hermesFetch.calls[0]?.body?.messages?.[0]?.content);
  assert.doesNotMatch(normalSystem, /โหมดคัดกรองก่อนเสนอ/u, "คำถามราคาปกติไม่ใช่งาน project");
});

// v1.4.1: scorer โมเดลคืน slot ไม่สม่ำเสมอ — ชั้น deterministic ต้องเติมแกน 4 slot
// จากคำพูดจริงของลูกค้าเอง จน handoff พร้อมโดยไม่ต้องพึ่งดวงของโมเดล
test("sales policy: core slots fill deterministically from customer text when the model returns none", () => {
  const policy = validateSalesPolicy({
    ...policyInput,
    opportunities: [
      { type: "in_house_training", requiredSlots: ["business_need", "company_name", "contact_phone", "preferred_contact_time"], optionalSlots: ["participant_count"], upsize: true, handoffOnComplete: true },
    ],
  });
  const journey = {
    customer_journey: "new_lead",
    customer_journey_evidence: { type: "no_verified_learning_record", confidence: "high", evidence: "no verified record in approved local profile" },
  };
  // เทิร์น 1: เปิดเส้นทาง + โจทย์ธุรกิจ + จำนวนคน — โมเดลไม่คืน slot อะไรเลย
  const first = normalizeSalesSignals(journey, policy, null, {
    customerText: "อยากให้ไปสอนที่บริษัท ทีม 12 คน อยากให้ทีมใช้ AI ลดงานซ้ำ ๆ",
    latestCustomerText: "อยากให้ไปสอนที่บริษัท ทีม 12 คน อยากให้ทีมใช้ AI ลดงานซ้ำ ๆ",
  });
  assert.equal(first.opportunity.type, "in_house_training");
  assert.ok(first.opportunity.slots.business_need, "โจทย์ธุรกิจต้องถูกเก็บจากคำพูดจริง");
  // เคสจริง: "ให้ไปสอนที่บริษัท มีไหมครับ" เคยถูกเก็บเป็น "ชื่อบริษัท" — ห้ามเกิดอีก
  assert.equal(first.opportunity.slots.company_name, undefined, "คำว่า บริษัท เดี่ยว ๆ ไม่ใช่การบอกชื่อ");
  assert.ok(first.opportunity.slots.participant_count, "จำนวนคน (optional) ก็เก็บได้");
  assert.equal(first.opportunity.handoffReady, false);

  // เทิร์น 2: ชื่อบริษัท
  const second = normalizeSalesSignals(journey, policy, { salesState: first }.salesState ?? first, {
    customerText: "บริษัทชื่อ ทดสอบดี จำกัด ครับ",
    latestCustomerText: "บริษัทชื่อ ทดสอบดี จำกัด ครับ",
  });
  assert.ok(second.opportunity.slots.company_name);
  assert.equal(second.opportunity.handoffReady, false);

  // เทิร์น 3: เบอร์ + เวลาสะดวก = ครบแกน -> พร้อมส่งต่อ (ping ถึงทีมงาน)
  const third = normalizeSalesSignals(journey, policy, second, {
    customerText: "เบอร์ 0891234567 สะดวกช่วงบ่ายวันธรรมดาครับ",
    latestCustomerText: "เบอร์ 0891234567 สะดวกช่วงบ่ายวันธรรมดาครับ",
  });
  assert.ok(third.opportunity.slots.contact_phone);
  assert.ok(third.opportunity.slots.preferred_contact_time);
  assert.deepEqual(third.opportunity.missingSlots, []);
  assert.equal(third.opportunity.handoffReady, true, "ครบ 4 แกน = ส่งต่อชมพู่ได้");
});

/* ---------- v1.4.36: แยก "ต้องถามอะไร" ออกจาก "ต้องได้อะไรถึงจะส่งต่อ" ---------- */
// พี่ง้วง 2026-08-19: "เอาแค่ 3 อย่างพอ ชื่อบริษัท(หรือคนติดต่อ) เบอร์ เวลาสะดวก
// เพราะชมพู่เก็บต่อเอง (และอย่าลืมหยุดเคส หยุดการตอบ เพราะ handoff ต่อให้ชมพู่)"
//
// จุดตายที่เทสต์ชุดนี้กัน: ถ้าเอา business_need ออกจาก requiredSlots ตรง ๆ บอทจะเปิด
// บทสนทนาด้วย "ขอทราบชื่อบริษัท" ทันที ซึ่งผิดที่มากสำหรับ private class ที่เป็นบุคคล
// แต่ถ้าปล่อยให้ business_need ขวาง handoff ลีดจะค้างอยู่กับบอทเมื่อลูกค้าไม่พูดถึงโจทย์
// ด้วยคำที่ตัวตรวจหลักฐานรู้จัก

const projectPolicy = (extra = {}) => validateSalesPolicy({
  ...policyInput,
  opportunities: [{
    type: "in_house_training",
    requiredSlots: ["business_need", "company_name", "contact_phone", "preferred_contact_time"],
    handoffSlots: ["company_name", "contact_phone", "preferred_contact_time"],
    optionalSlots: ["participant_count"],
    upsize: true,
    handoffOnComplete: true,
    ...extra,
  }],
});

const newLead = {
  customer_journey: "new_lead",
  customer_journey_evidence: { type: "no_verified_learning_record", confidence: "high", evidence: "no verified record in approved local profile" },
};
const turn = (policy, previous, text) => normalizeSalesSignals(newLead, policy, previous, { customerText: text, latestCustomerText: text });

test("handoff slots: ลูกค้าให้ครบ 3 อย่างโดยไม่เอ่ยโจทย์ธุรกิจเลย = ส่งต่อได้", () => {
  const policy = projectPolicy();
  // ประโยคนี้ไม่มีคำว่า เป้าหมาย/ปัญหา/อยากให้ทีม เลย — business_need จึงไม่มีวันติด
  // เคสจริงของผู้บริหารที่ตอบสั้นและครบ: เดิมบอทจะวนถามโจทย์ต่อไปไม่รู้จบ
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัทครับ บริษัท ทดสอบดี จำกัด เบอร์ 0891234567 สะดวกบ่ายวันพุธครับ");
  assert.equal(lead.opportunity.slots.business_need, undefined, "ไม่มีคำบอกโจทย์ = ห้ามเดาให้");
  assert.deepEqual(lead.opportunity.missingSlots, ["business_need"], "ยังนับว่าขาด (ไว้ถามถ้ามีจังหวะ)");
  assert.equal(lead.opportunity.handoffReady, true, "แต่ห้ามขวางการส่งต่อ — 3 อย่างครบแล้ว");
});

test("handoff slots: ขาดข้อใดข้อหนึ่งใน 3 = ยังไม่ส่งต่อ", () => {
  const policy = projectPolicy();
  const noPhone = turn(policy, null, "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด สะดวกบ่ายวันพุธครับ");
  assert.equal(noPhone.opportunity.handoffReady, false, "ไม่มีเบอร์ = ชมพู่โทรกลับไม่ได้");
  const noTime = turn(policy, null, "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด เบอร์ 0891234567 ครับ");
  assert.equal(noTime.opportunity.handoffReady, false, "ไม่มีเวลาสะดวก = โทรผิดจังหวะ");
});

test("handoff slots: ไม่ตั้งค่า = ใช้ requiredSlots ทั้งชุดเหมือนเดิม (ธุรกิจอื่นต้องไม่เปลี่ยนพฤติกรรม)", () => {
  const policy = validateSalesPolicy({
    ...policyInput,
    opportunities: [{
      type: "in_house_training",
      requiredSlots: ["business_need", "company_name", "contact_phone", "preferred_contact_time"],
      optionalSlots: [],
      upsize: true,
      handoffOnComplete: true,
    }],
  });
  assert.deepEqual([...policy.opportunities[0].handoffSlots], [...policy.opportunities[0].requiredSlots]);
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด เบอร์ 0891234567 สะดวกบ่ายวันพุธครับ");
  assert.equal(lead.opportunity.handoffReady, false, "ไม่ได้ตั้ง handoffSlots = ต้องครบทุก slot เหมือนเดิม");
});

test("handoff slots: ต้องเป็นสับเซ็ตของสิ่งที่ถาม — รอ slot ที่ไม่มีใครถามคือรอตลอดกาล", () => {
  assert.throws(() => validateSalesPolicy({
    ...policyInput,
    opportunities: [{
      type: "in_house_training",
      requiredSlots: ["company_name"],
      handoffSlots: ["company_name", "contact_phone"],
      optionalSlots: [],
      upsize: true,
      handoffOnComplete: true,
    }],
  }), /handoffSlots must be a subset of requiredSlots \(contact_phone\)/u);
});

test("handoff slots: ครบ 3 แล้ว โหมดคัดกรองต้องหายไปจาก prompt (ไม่ไล่ถามต่อ)", async () => {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const policyRaw = {
    ...policyInput,
    opportunities: [{
      type: "in_house_training",
      requiredSlots: ["business_need", "company_name", "contact_phone", "preferred_contact_time"],
      handoffSlots: ["company_name", "contact_phone", "preferred_contact_time"],
      optionalSlots: ["participant_count"],
      upsize: true,
      handoffOnComplete: true,
    }],
  };
  const policyFile = join(mkdtempSync(join(tmpdir(), "policy-")), "sales-policy.json");
  writeFileSync(policyFile, JSON.stringify(policyRaw), "utf8");
  const app = createApp({
    config: testConfig({ SALES_POLICY_FILE: policyFile, BUSINESS_ID: "pngoung-tidkradum" }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });

  await app.pipeline.handleInboundText({ customerId: "U-slots", text: "อยากให้ไปสอนที่บริษัทครับ", replyToken: "" });
  const opening = promptText(hermesFetch.calls.at(-1).body.messages[0].content);
  assert.match(opening, /ตามลำดับที่ยังขาด: business_need/u, "เปิดด้วยการทำความเข้าใจโจทย์ ไม่ใช่ขอชื่อบริษัท");

  // สถานะ opportunity มาจาก scorer ซึ่งช้าหนึ่งเทิร์นเสมอ — สร้างสถานะจริงด้วยตัวปกติ
  // แล้วบันทึกเป็นผลรอบก่อน เพื่อวัดพฤติกรรมของเทิร์นถัดไป
  const covered = normalizeSalesSignals(newLead, validateSalesPolicy(policyRaw), null, {
    customerText: "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด เบอร์ 0891234567 สะดวกบ่ายวันพุธครับ",
    latestCustomerText: "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด เบอร์ 0891234567 สะดวกบ่ายวันพุธครับ",
  });
  assert.deepEqual(covered.opportunity.missingSlots, ["business_need"], "ตั้งต้นให้ตรงเคส: ครบ 3 แต่ไม่มีโจทย์");
  assert.equal(covered.opportunity.handoffReady, true);
  db.recordScore("U-slots", 50, JSON.stringify({ salesState: covered }));

  await app.pipeline.handleInboundText({ customerId: "U-slots", text: "ครับ", replyToken: "" });
  const after = promptText(hermesFetch.calls.at(-1).body.messages[0].content);
  // ส่งต่อแล้ว = จบโหมดคัดกรอง ไม่มีลิสต์ให้ไล่ถามอีก (เดิม business_need ที่ค้างอยู่
  // จะลากให้บอทถามต่อทั้งที่ข้อมูลติดต่อครบและชมพู่กำลังจะโทรกลับ)
  assert.doesNotMatch(after, /ตามลำดับที่ยังขาด/u, "ครบ 3 อย่าง = เลิกไล่เก็บข้อมูล");
  db.close();
});

/* ---------- v1.4.36: "ชื่อบริษัท(หรือคนติดต่อ)" — ครึ่งหลังของ v1.4.32 ที่ตกไป ---------- */
// v1.4.32 ขยายตัวสกัดให้จับ "ผมชื่อโต้งครับ" แล้ว แต่ไม่ได้ขยายตัวตรวจหลักฐาน
// ค่าที่สกัดได้จึงถูกทิ้งทุกครั้งอย่างเงียบ ๆ = ลูกค้าบอกชื่อตัวเองแล้วบอทยังวนถามชื่อบริษัท
test("ชื่อผู้ติดต่อ: ลูกค้าแนะนำตัวด้วยชื่อคน (ไม่มีชื่อบริษัท) ต้องนับเป็นชื่อผู้ติดต่อได้", () => {
  const policy = projectPolicy();
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัทครับ ผมชื่อโต้งครับ เบอร์ 0891234567 สะดวกบ่ายวันพุธครับ");
  assert.ok(lead.opportunity.slots.company_name, "ชื่อคนติดต่อใช้แทนชื่อบริษัทได้ (คำสั่งพี่ง้วง)");
  assert.equal(lead.opportunity.handoffReady, true);
});

test("ชื่อผู้ติดต่อ: ต้องเก็บแค่ชื่อ ไม่ลากเบอร์โทรเข้ามาด้วย (การ์ดลีดที่ชมพู่อ่าน)", () => {
  const policy = projectPolicy();
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัทครับ ผมชื่อโต้งครับ เบอร์ 0891234567 สะดวกบ่ายวันพุธครับ");
  assert.equal(lead.opportunity.slots.company_name, "ผมชื่อโต้งครับ");
  assert.doesNotMatch(lead.opportunity.slots.company_name, /\d/u, "ชื่อห้ามมีตัวเลขเบอร์ปน");
  // ป้ายในการ์ดต้องบอกว่าเป็นได้ทั้งสองอย่าง ไม่งั้นอ่านแล้วนึกว่าระบบเก็บผิดช่อง
  assert.match(renderHandoffPing(lead.opportunity), /บริษัท\/ผู้ติดต่อ: ผมชื่อโต้งครับ/u);
});

test("ชื่อผู้ติดต่อ: การถามชื่อของสิ่งอื่นต้องไม่ถูกเก็บเป็นชื่อผู้ติดต่อ", () => {
  const policy = projectPolicy();
  for (const text of [
    "อยากให้ไปสอนที่บริษัทครับ ไม่ทราบชื่อคลาสที่เปิดอยู่ตอนนี้ครับ",
    "อยากให้ไปสอนที่บริษัทครับ ขอทราบชื่ออะไรบ้างคะ",
  ]) {
    assert.equal(turn(policy, null, text).opportunity.slots.company_name, undefined, text);
  }
});

/* ---------- v1.4.36: จับเจตนา In-house ให้ทันภาษาที่ลูกค้าใช้จริง ---------- */
// เจอตอนพิสูจน์กับสมองจริง: "สนใจให้ไปจัดอบรม AI ให้ทีมที่บริษัทครับ" ไม่ถูกจับเลย
// (เพราะมี "AI" คั่นระหว่างกริยากับผู้รับ) ผลคือโหมดคัดกรองงาน project ไม่ทำงาน
// บอทกลับไปเทราคาทั้งชุดได้ (บั๊กเดิม v1.4.1) และ handoff ไม่มีวันเกิด
test("เจตนา in-house: จับทรงที่มี 'สิ่งที่สอน' คั่นระหว่างกริยากับผู้รับ", () => {
  const policy = projectPolicy(); // ต้องเป็นนโยบายที่มี in_house_training จริง ไม่งั้นตัวจับคืน null เสมอ
  for (const text of [
    "สนใจให้ไปจัดอบรม AI ให้ทีมที่บริษัทครับ",
    "อยากจัดอบรม AI ให้พนักงานครับ",
    "สนใจจัดคอร์ส AI ให้ทีมงานที่ออฟฟิศ",
    "อยากจัดเทรนนิ่ง AI ในองค์กรครับ",
    "อยากได้คนไปสอน AI ให้ทีมขายครับ",
  ]) {
    assert.equal(detectDirectOpportunityType(text, policy), "in_house_training", text);
  }
});

test("เจตนา in-house: คำถามเรื่องคลาสของเราต้องไม่ถูกนับเป็นงาน project", () => {
  const policy = projectPolicy();
  // false positive แพงกว่าการพลาด: ถูกจับผิด = บอทเข้าโหมดคัดกรอง ไม่ยอมบอกราคา
  // คลาสปกติ แล้วไล่ขอเบอร์จากคนที่แค่ถามว่าคลาสสอนอะไร
  for (const text of [
    "สอนแบบไหนคะ ที่บริษัทมีกี่รอบ",
    "สอนอะไรบ้างคะ ทีมงานตอบเร็วมาก",
    "เรียนที่บริษัทพี่ง้วงใช่ไหมคะ",
    "มีสอนที่ไหนบ้างคะ",
  ]) {
    assert.equal(detectDirectOpportunityType(text, policy), null, text);
  }
});


/* ---- handoffAnyOf: ได้อย่างใดอย่างหนึ่งก็ส่งต่อได้ (คำสั่งพี่ง้วง 1 ก.ย. 2026) ----
 *
 * "ถามเยอะเกิน strict เกิน จะพลาดลีดไป ... ให้ชมพู่ไปเก็บรายละเอียดที่เหลือเอง
 *  เพราะคนเก็บข้อมูลแบบนี้เก่งกว่าบอทมาก และการได้คุยเร็วสำคัญกว่าได้ข้อมูลครบ"
 *
 * หลักฐานจากของจริง 1 ก.ย. 2026: ในบรรดาห้องงาน in-house ที่มีสถานะ opportunity จริง
 * 3 ห้อง ไม่มีห้องไหนส่งต่อได้เลยสักห้องตลอดอายุระบบ (audit opportunity_handoff = 0)
 * สองห้องให้ "เบอร์โทร + เวลาที่สะดวก" มาแล้ว ติดแค่ชื่อบริษัทอย่างเดียว เบอร์ลูกค้า
 * จึงค้างอยู่ในบอทโดยไม่มีใครโทร — หนึ่งในนั้นเงียบไปสิบชั่วโมงโดย AI ปิดอยู่
 *
 * handoffSlots (ต้องครบทุกช่อง) ยังอยู่เหมือนเดิมสำหรับธุรกิจอื่นที่ตั้งไว้แล้ว
 */
const anyOfPolicy = (extra = {}) => validateSalesPolicy({
  ...policyInput,
  opportunities: [{
    type: "in_house_training",
    requiredSlots: ["business_need", "company_name", "contact_phone", "preferred_contact_time"],
    handoffSlots: [],
    handoffAnyOf: ["company_name", "contact_phone", "preferred_contact_time"],
    optionalSlots: ["participant_count"],
    upsize: true,
    handoffOnComplete: true,
    ...extra,
  }],
});

test("handoffAnyOf: ให้เบอร์มาอย่างเดียว (ไม่มีชื่อบริษัท) = ส่งต่อได้ทันที", () => {
  const policy = anyOfPolicy();
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัทครับ เบอร์ 0891234567");
  assert.equal(lead.opportunity.slots.contact_phone, "0891234567");
  assert.equal(lead.opportunity.slots.company_name, undefined, "ยังไม่รู้ชื่อบริษัท");
  assert.equal(lead.opportunity.handoffReady, true, "มีเบอร์แล้ว ชมพู่โทรได้ ห้ามขวาง");
});

test("handoffAnyOf: ให้ชื่อบริษัทมาอย่างเดียว (ไม่มีเบอร์) = ส่งต่อได้", () => {
  const policy = anyOfPolicy();
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด ครับ");
  assert.equal(lead.opportunity.handoffReady, true, "รู้ว่าเป็นบริษัทไหนก็ตามต่อได้แล้ว");
});

test("handoffAnyOf: ยังไม่ได้อะไรเลยสักอย่าง = ยังไม่ส่งต่อ (กันส่งลีดเปล่า)", () => {
  const policy = anyOfPolicy();
  const lead = turn(policy, null, "สนใจจัดอบรมในองค์กรครับ");
  assert.equal(lead.opportunity.handoffReady, false, "ไม่มีอะไรให้ชมพู่ทำต่อเลย = ยังไม่ต้องส่ง");
});

test("handoffAnyOf: ไม่ตั้งไว้ = พฤติกรรมเดิมทุกประการ (ธุรกิจอื่นห้ามกระทบ)", () => {
  const policy = projectPolicy();
  assert.deepEqual([...policy.opportunities[0].handoffAnyOf], [], "ไม่ตั้ง = ว่าง");
  const noPhone = turn(policy, null, "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด สะดวกบ่ายวันพุธครับ");
  assert.equal(noPhone.opportunity.handoffReady, false, "กติกาเดิมต้องครบ 3 อย่างเหมือนเดิม");
});

test("handoffAnyOf: ต้องเป็นสับเซ็ตของ requiredSlots — รอ slot ที่ไม่มีใครถามคือรอตลอดกาล", () => {
  assert.throws(() => validateSalesPolicy({
    ...policyInput,
    opportunities: [{
      type: "in_house_training",
      requiredSlots: ["business_need", "company_name"],
      handoffSlots: [],
      handoffAnyOf: ["company_name", "contact_phone"],
      optionalSlots: [], upsize: true, handoffOnComplete: true,
    }],
  }), /handoffAnyOf must be a subset of requiredSlots \(contact_phone\)/u);
});

/* ---- ping ถึงทีมงานต้องพูดความจริง (บั๊กจริง 3 ก.ย. 2026) -------------------
 *
 * ตั้งแต่กติกา 1 ก.ย. (handoffAnyOf) ห้องที่ให้ "ชื่อบริษัท" มาช่องเดียวก็ส่งต่อแล้ว
 * แต่บรรทัดแรกของ ping ยังเขียนว่า "ให้ข้อมูลครบแล้ว — รอทีมงานโทรกลับ" ทุกครั้ง
 * ทีมงานจึงอ่านว่าครบ เปิดหาเบอร์ แล้วไม่มีเบอร์ให้โทรสักตัว
 * ping ต้องบอกให้ได้ในบรรทัดเดียวว่า "ตามตัวได้ไหม" และประกาศช่องที่ยังไม่มีตรง ๆ
 * -------------------------------------------------------------------------- */

test("ping: ส่งต่อด้วยชื่อบริษัทอย่างเดียว — ห้ามอ้างว่าข้อมูลครบ และต้องบอกว่าขาดอะไร", () => {
  const policy = anyOfPolicy();
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด ครับ");
  const ping = renderHandoffPing(lead.opportunity);
  assert.doesNotMatch(ping, /ให้ข้อมูลครบแล้ว/u, "ไม่มีเบอร์แต่บอกว่าครบ = โกหกทีมงาน");
  assert.doesNotMatch(ping, /รอทีมงานโทรกลับ/u, "สั่งให้โทรทั้งที่ไม่มีเบอร์ให้โทร");
  assert.match(ping, /ยังไม่มีเบอร์ ต้องทักกลับในห้องแชท/u, "บรรทัดแรกต้องบอกว่าตามตัวยังไงได้");
  assert.match(ping, /^ยังไม่มี: .*เบอร์ติดต่อ/mu, "ต้องมีบรรทัดประกาศช่องที่ยังขาด");
  assert.match(ping, /เวลาที่สะดวก/u, "ขาดเวลาที่สะดวกด้วย ต้องอยู่ในบรรทัดเดียวกัน");
  assert.match(ping, /บริษัท\/ผู้ติดต่อ: .*ทดสอบดี จำกัด/u, "ช่องที่รู้แล้วยังต้องอยู่ครบเหมือนเดิม");
  assert.match(ping, /เปิดห้องแชทเพื่อคุยต่อ/u, "ต้องชี้ทางไปห้องแชท (ลิงก์จริงต่อท้ายโดย notify)");
  assert.doesNotMatch(ping, /https?:\/\//u, "ห้ามใส่ลิงก์ซ้ำกับที่ notify ต่อท้ายให้อยู่แล้ว");
  assert.ok(ping.split("\n").length <= 6, "ทีมงานอ่านบนมือถือ — ยาวเกินคือไม่มีใครอ่าน");
});

test("ping: มีเบอร์แล้ว = บอกให้โทรกลับได้เลย และไม่ต้องประกาศว่าขาดเบอร์", () => {
  const policy = anyOfPolicy();
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัทครับ เบอร์ 0891234567 สะดวกบ่ายวันพุธ");
  const ping = renderHandoffPing(lead.opportunity);
  assert.match(ping, /มีเบอร์แล้ว โทรกลับได้เลย/u);
  assert.match(ping, /เบอร์ติดต่อกลับ: 0891234567/u);
  assert.doesNotMatch(ping, /ยังไม่มี:.*เบอร์ติดต่อ/u, "มีเบอร์แล้วห้ามบอกว่าขาดเบอร์");
  assert.match(ping, /ยังไม่มี: ชื่อบริษัท\/ผู้ติดต่อ/u, "ยังไม่รู้ว่าเป็นบริษัทไหน ต้องบอกตามจริง");
});

// ผู้ตรวจ 3 ก.ย.: เวลาที่สะดวกไม่ใช่ช่องทางติดต่อ — บรรทัดสรุปมี "• เวลาที่สะดวก: บ่ายวันพุธ"
// อยู่ ทีมงานที่กวาดตาผ่านอาจอ่านเป็น "นัดโทรแล้ว" ทั้งที่ไม่มีเบอร์ให้โทรสักตัว
test("ping: รู้แค่เวลาที่สะดวก (ไม่มีเบอร์) — ห้ามชวนให้เข้าใจว่าตามตัวได้", () => {
  const policy = anyOfPolicy();
  const lead = turn(policy, null, "อยากให้ไปสอนที่บริษัทครับ สะดวกบ่ายวันพุธ");
  assert.equal(lead.opportunity.handoffReady, true, "เวลาที่สะดวกอย่างเดียวก็ส่งต่อได้ตามกติกา 1 ก.ย.");
  assert.equal(lead.opportunity.slots.contact_phone, undefined, "แต่ไม่มีเบอร์");
  const ping = renderHandoffPing(lead.opportunity);
  assert.doesNotMatch(ping, /โทรกลับได้เลย/u, "เวลาไม่ใช่ช่องทาง — ห้ามสั่งให้โทร");
  assert.match(ping, /รู้แค่เวลาที่สะดวก ยังไม่มีเบอร์ ต้องทักกลับในห้องแชท/u,
    "ต้องพูดออกมาตรง ๆ ว่ารู้แค่เวลา");
  assert.match(ping, /ยังไม่มี: เบอร์ติดต่อ/u);
});

test("ping: ได้ครบทั้งสามช่อง = ไม่มีบรรทัด 'ยังไม่มี' เลย", () => {
  const policy = anyOfPolicy();
  const lead = turn(policy, null, "ให้ไปสอนที่บริษัท ทดสอบดี จำกัด เบอร์ 0891234567 สะดวกบ่ายวันพุธครับ");
  const ping = renderHandoffPing(lead.opportunity);
  assert.match(ping, /มีเบอร์แล้ว โทรกลับได้เลย/u);
  assert.doesNotMatch(ping, /ยังไม่มี:/u);
  assert.match(ping, /AI หยุดตอบลูกค้าคนนี้แล้ว รอทีมงานรับช่วงต่อ/u);
});

test("extractContactPhoneQuote: ใช้ตัวสกัดชุดเดียวกับ slot contact_phone", () => {
  assert.equal(extractContactPhoneQuote("เบอร์ 0812345678 ค่ะ"), "0812345678");
  assert.equal(extractContactPhoneQuote("0812345678"), "0812345678");
  assert.equal(extractContactPhoneQuote("สะดวกบ่ายวันพุธค่ะ"), "", "ไม่มีเบอร์ = ว่าง");
  assert.equal(extractContactPhoneQuote("เลขที่ 0212345678"), "", "เบอร์บ้านไม่ใช่มือถือ = ไม่รับ");
});
