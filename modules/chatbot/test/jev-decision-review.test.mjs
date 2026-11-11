import test from "node:test";
import assert from "node:assert/strict";
import { createJevDecisionReview, buildJevDecisionEvidence, decideJevPolicy, JEV_MODEL, parseJevDecisionAnswer, redactDecisionText, shouldStopJev, shouldNotifyJev } from "../src/jevDecisionReview.mjs";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";
poisonGlobalFetch();

const clock = Date.parse("2026-09-27T12:00:00+07:00");
const silent = { warn() {} };
const answer = ({ complaint = "none", human = "information", quality = "pass", stop = human === "human_required" || complaint === "complaint" ? "stop" : "continue", notify = stop === "stop" ? "notify" : "not_needed", confidence = .97 } = {}) => ({
  model: JEV_MODEL, answers: {
    stop: { type: "choice", choice: stop, confidence, probabilities: Object.fromEntries(["stop","continue","unclear"].map(key => [key,key === stop ? 1 : 0])) },
    notify: { type: "choice", choice: notify, confidence, probabilities: Object.fromEntries(["notify","not_needed","unclear"].map(key => [key,key === notify ? 1 : 0])) },
    complaint: { type: "choice", choice: complaint, confidence, probabilities: { none: complaint === "none" ? 1 : 0, elsewhere: complaint === "elsewhere" ? 1 : 0, frustration: complaint === "frustration" ? 1 : 0, complaint: complaint === "complaint" ? 1 : 0, unclear: complaint === "unclear" ? 1 : 0 } },
    human_need: { type: "choice", choice: human, confidence, probabilities: { information: human === "information" ? 1 : 0, human_required: human === "human_required" ? 1 : 0, unclear: human === "unclear" ? 1 : 0 } },
    answer_quality: { type: "choice", choice: quality, confidence, probabilities: { pass: quality === "pass" ? 1 : 0, missing_answer: quality === "missing_answer" ? 1 : 0, unsupported: quality === "unsupported" ? 1 : 0, policy_conflict: quality === "policy_conflict" ? 1 : 0, unclear: quality === "unclear" ? 1 : 0 } },
  }, usage: { input_tokens: 23, output_tokens: 8 },
});
function setup({ mode = "shadow", key = "fixture", limit = 250, logger = silent, fetchImpl = async () => ({ ok: true, json: async () => answer() }) } = {}) {
  const db = memoryDb({ now: () => clock });
  db.upsertCustomer("room-1", {});
  const reviewer = createJevDecisionReview({ config: { jevReviewMode: mode, typesafeApiKey: key, jevReviewDailyLimit: limit, jevReviewThreshold: 9 }, db, fetchImpl, now: () => clock, logger });
  const input = { customerId: "room-1", sessionId: "session-1", turnId: "turn-1", stage: "draft", customer: { known_name: "Alice", line_user_id: "room-1" }, latestText: "ขอรายละเอียดค่ะ ติดต่อ alice@example.test 0812345678", history: [{ role: "customer", text: "https://private.test อยากรู้เพิ่ม" }], knowledge: "รายละเอียดคลาส AI สำหรับงานธุรกิจ", draftText: "คลาสนี้ช่วยงานธุรกิจได้ค่ะ", proposedAction: "reply" };
  return { db, reviewer, input };
}

test("valid choice result exposes raw confidence separately from policy action", async () => {
  const w = setup();
  try {
    const result = await w.reviewer.review(w.input);
    assert.equal(result.status, "reviewed"); assert.equal(result.action, "allow"); assert.equal(result.confidence10, 9.7);
    assert.equal(result.checks.complaint.choice, "none"); assert.equal(result.checks.complaint.confidence, .97);
    assert.equal(result.checks.answer_quality.confidence10, 9.7);
    const row = w.db.raw.prepare("SELECT * FROM jev_decision_reviews").get();
    assert.equal(row.review_status, "pending"); assert.equal(row.confidence_10, 9.7);
    assert.doesNotMatch(row.result_json, /Alice|alice@example|0812345678|รายละเอียดคลาส/);
  } finally { w.db.close(); }
});

test("receipt finalization failure never returns an allow verdict", async () => {
  const w = setup();
  try {
    const db = {
      raw: { prepare: (sql) => String(sql).startsWith("UPDATE jev_decision_reviews") ? { run() { throw new Error("injected update failure"); } } : w.db.raw.prepare(sql) },
      getSetting: w.db.getSetting.bind(w.db), setSetting: w.db.setSetting.bind(w.db),
    };
    const reviewer = createJevDecisionReview({ config: { jevReviewMode: "shadow", typesafeApiKey: "fixture", jevReviewDailyLimit: 250, jevReviewThreshold: 9 }, db, now: () => clock, logger: silent });
    const result = await reviewer.review(w.input);
    assert.equal(result.status, "unavailable"); assert.equal(result.action, "unavailable");
    assert.equal(result.reason, "receipt_finalization_failed");
  } finally { w.db.close(); }
});

test("malformed, NaN, model mismatch, bad distribution, HTTP and timeout fail closed", async () => {
  for (const kind of ["malformed", "nan", "model", "distribution", "http", "timeout"]) {
    const w = setup({ fetchImpl: async () => {
      if (kind === "http") return { ok: false, status: 503 };
      if (kind === "timeout") throw new Error("timeout private content");
      const value = answer();
      if (kind === "malformed") delete value.answers.complaint;
      if (kind === "nan") value.answers.complaint.confidence = Number.NaN;
      if (kind === "model") value.model = "wrong";
      if (kind === "distribution") value.answers.complaint.probabilities.none = .7;
      return { ok: true, json: async () => value };
    } });
    try {
      const result = await w.reviewer.review(w.input);
      assert.equal(result.action, "unavailable"); assert.equal(result.confidence10, null);
      assert.equal(w.db.raw.prepare("SELECT confidence_10 FROM jev_decision_reviews").get().confidence_10, null);
    } finally { w.db.close(); }
  }
});

test("route has no irrelevant draft check and threshold produces uncertain not allow", async () => {
  const w = setup({ fetchImpl: async () => ({ ok: true, json: async () => ({ ...answer({ confidence: .8 }), answers: { complaint: answer({ confidence: .8 }).answers.complaint, human_need: answer({ confidence: .8 }).answers.human_need, stop: answer({ confidence: .8 }).answers.stop, notify: answer({ confidence: .8 }).answers.notify } }) }) });
  try {
    const result = await w.reviewer.review({ ...w.input, stage: "route", turnId: "route-1" });
    assert.equal(result.action, "uncertain"); assert.equal(result.confidence10, 8); assert.equal(result.checks.answer_quality, null);
  } finally { w.db.close(); }
});

test("complaint, explicit human need and payment confirmation always require human", () => {
  const values = parseJevDecisionAnswer(answer({ complaint: "complaint" }), "draft");
  assert.equal(decideJevPolicy({ answers: values, stage: "draft", proposedAction: "reply", threshold10: 9 }).action, "human_review");
  const human = parseJevDecisionAnswer(answer({ human: "human_required" }), "draft");
  assert.equal(decideJevPolicy({ answers: human, stage: "draft", proposedAction: "reply", threshold10: 9 }).action, "human_review");
  const ordinary = parseJevDecisionAnswer(answer(), "draft");
  assert.equal(decideJevPolicy({ answers: ordinary, stage: "draft", proposedAction: "confirm payment", threshold10: 9 }).action, "human_review");
});

test("off, missing key, daily budget, duplicate and stale states never apply", async () => {
  const off = setup({ mode: "off" }); const missing = setup({ key: "" });
  try {
    assert.equal((await off.reviewer.review(off.input)).status, "disabled");
    assert.equal((await missing.reviewer.review(missing.input)).reason, "missing_provider_key");
  } finally { off.db.close(); missing.db.close(); }
  const w = setup({ limit: 1 });
  try {
    assert.equal((await w.reviewer.review(w.input)).status, "reviewed");
    assert.equal((await w.reviewer.review({ ...w.input, turnId: "turn-2", latestText: "different" })).reason, "daily_cap");
    assert.equal((await w.reviewer.review(w.input)).status, "cached");
  } finally { w.db.close(); }
  const race = setup();
  try { assert.equal((await race.reviewer.review({ ...race.input, isCurrent: () => false })).status, "stale"); } finally { race.db.close(); }
});

test("privacy evidence redacts identifiers and relevant knowledge remains bounded", () => {
  const evidence = buildJevDecisionEvidence({ customer: { known_name: "Alice", line_user_id: "id42" }, stage: "draft", latestText: "Alice id=id42 https://example.test a@b.com 0812345678", history: [], knowledge: "AI business detail\n\n".repeat(30), draftText: "AI business", proposedAction: "reply" });
  const raw = JSON.stringify(evidence);
  assert.doesNotMatch(raw, /Alice|id42|example\.test|a@b\.com|0812345678/); assert.ok(Buffer.byteLength(raw) < 31_000);
});

test("deterministically masks Thai self-introduction and explicit address blocks", () => {
  const text = "หนูชื่อมาลี อยู่บ้านเลขที่ 99/12 ซอยสุขใจ ถนนรัชดา แขวงดินแดง กรุงเทพฯ สนใจเรียนค่ะ";
  const redacted = redactDecisionText(text, { known_name: "มาลี" });
  assert.doesNotMatch(redacted, /มาลี|99\/12|สุขใจ|รัชดา|ดินแดง/);
  assert.match(redacted, /กรุงเทพ/);
  const evidence = buildJevDecisionEvidence({ stage: "route", latestText: text });
  assert.doesNotMatch(JSON.stringify(evidence), /มาลี|99\/12|สุขใจ|รัชดา|ดินแดง/);
});

test("masks honorific names and unlabeled address landmarks while retaining coarse geography", () => {
  const text = "คุณมาลีค่ะ ส่งที่ 99/12 ซอยสุขใจ ถนนรัชดา แขวงดินแดง กรุงเทพฯ";
  const redacted = redactDecisionText(text, { known_name: "มาลี" });
  assert.doesNotMatch(redacted, /มาลี|99\/12|สุขใจ|รัชดา|ดินแดง/);
  assert.match(redacted, /กรุงเทพ/);
});

test("Thai pronouns must not erase a course question or complaint", () => {
  for (const text of ["คุณมีสอนสดไหมคะ", "พี่ขอถามราคาหน่อยค่ะ", "น้องไม่ตอบคำถามเลยค่ะ", "เจ้านายสนใจคอร์สนี้ค่ะ", "คุณไปเรียนที่ไหนคะ", "คุณจะเรียนออนไลน์ได้ไหมคะ", "คุณเคยสอนไหมคะ"]) {
    assert.equal(redactDecisionText(text), text);
  }
  assert.doesNotMatch(redactDecisionText("น.ส.มาลี ใจดี สนใจคอร์ส"), /มาลี|ใจดี/);
  assert.doesNotMatch(redactDecisionText("คุณมาลีค่ะ สนใจคอร์ส", {}), /มาลี/);
  assert.doesNotMatch(redactDecisionText("พี่สมชายครับ สนใจเรียน", {}), /สมชาย/);
});

test("ambiguous personal references never produce a verdict from redacted semantics", async()=>{
  let calls=0; const w=setup({fetchImpl:async()=>{calls++; return {ok:true,json:async()=>answer()};}});
  try {
    for (const [index,latestText] of ["คุณมาลีค่ะ สนใจคอร์ส", "คุณบอกผิดค่ะ"].entries()) {
      const result=await w.reviewer.review({...w.input,customer:{},latestText,turnId:`ambiguous-${index}`});
      assert.equal(result.action,"uncertain"); assert.equal(result.reason,"redaction_ambiguous");
      assert.equal(result.confidence10,null);
    }
    assert.equal(calls,0);
  } finally {w.db.close();}
});

test("truncated customer text or draft is persisted as uncertain without provider call", async () => {
  let calls = 0; const w = setup({ fetchImpl: async () => { calls++; return { ok: true, json: async () => answer() }; } });
  try {
    const result = await w.reviewer.review({ ...w.input, latestText: "ก".repeat(3001) });
    assert.equal(result.status, "uncertain"); assert.equal(result.action, "uncertain"); assert.equal(calls, 0);
  } finally { w.db.close(); }
});

test("transport uses Choice criteria maps and history content, not an array or dropped turns", async () => {
  let body; const w = setup({ fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => answer() }; } });
  try {
    await w.reviewer.review({ ...w.input, history: [{ role: "customer", content: "ถามเรื่องคลาส" }], workflowPolicy: "CURRENT POLICY: price before bank" });
    assert.equal(Array.isArray(body.questions.complaint.criteria), false);
    assert.match(body.questions.human_need.criteria.human_required, /ยืนยันการชำระเงินจริง/);
    assert.equal(body.state.history[0].text, "ถามเรื่องคลาส");
    assert.equal(body.state.workflow_policy, "CURRENT POLICY: price before bank");
    assert.equal(body.state.knowledge_coverage.total_paragraphs, 1);
    assert.deepEqual(body.state.knowledge_coverage.selected_paragraph_indices, [0]);
    assert.match(body.state.knowledge_excerpt, /รายละเอียดคลาส AI/);
    assert.match(body.questions.answer_quality.instructions, /workflow_policy/);
    const receipt = w.db.raw.prepare("SELECT result_json FROM jev_decision_reviews").get();
    assert.deepEqual(JSON.parse(receipt.result_json).evidence.knowledge_coverage.selected_paragraph_indices, [0]);
  } finally { w.db.close(); }
});

test("parser returns only declared Choice fields and rejects a non-top choice", () => {
  const payload = answer(); payload.untrusted = { confidence: 1 }; payload.answers.complaint.untrusted = "ignore";
  const parsed = parseJevDecisionAnswer(payload, "draft");
  assert.deepEqual(Object.keys(parsed.complaint).sort(), ["choice", "confidence", "probabilities"]);
  payload.answers.complaint.choice = "complaint";
  assert.throws(() => parseJevDecisionAnswer(payload, "draft"), /choice_not_top_probability/);
});

test("customer reset cascades decision-review receipts", async () => {
  const w = setup();
  try {
    await w.reviewer.review(w.input);
    w.db.resetCustomer("room-1", { forget: true });
    assert.equal(w.db.raw.prepare("SELECT COUNT(*) AS n FROM jev_decision_reviews").get().n, 0);
  } finally { w.db.close(); }
});


test("stop and notify scores are independent and rounded confidence cannot authorize a side effect", async () => {
  const w = setup({mode: "enforce",fetchImpl:async()=>({ok:true,json:async()=>answer({stop:"continue",notify:"notify"})})});
  try {
    const result = await w.reviewer.review(w.input);
    assert.equal(result.action,"allow"); assert.equal(shouldStopJev(result),false); assert.equal(shouldNotifyJev(result),true);
    result.checks.notify.confidence=.8999; result.checks.notify.confidence10=9;
    assert.equal(shouldNotifyJev(result),false);
    result.checks.stop={choice:"stop",confidence:.97,confidence10:9.7}; result.action="human_review";
    assert.equal(shouldStopJev(result),true);
    result.status="unavailable"; assert.equal(shouldStopJev(result),false);
  } finally { w.db.close(); }
});

test("saving owner feedback changes the very next provider evidence and invalidates its cached verdict", async () => {
  const {writeAuditFeedback}=await import("../src/jevAuditFeedback.mjs");
  const db=memoryDb({now:()=>clock}); const requests=[];
  db.upsertCustomer("room-1",{});
  db.insertMessage({id:"owner-anchor",customerId:"room-1",direction:"in",content:"private example"});
  const c={id:"owner-case",evidenceHash:"a".repeat(64),customerId:"room-1",channelId:"default",atMs:clock,anchorMessageId:"owner-anchor",jev:{model:JEV_MODEL,stop:{choice:"stop"},notify:{choice:"notify"},complaint:{choice:"none"},reason:{choice:"ordinary_information"}}};
  const reviewer=createJevDecisionReview({db,now:()=>clock,config:{jevReviewMode:"enforce",typesafeApiKey:"fixture",jevOwnerLearningEnabled:true},fetchImpl:async(_url,{body})=>{
    const request=JSON.parse(body);requests.push(request);
    const guidance=request.state.owner_learning.examples[0]?.guidance;
    return {ok:true,json:async()=>answer({stop:guidance?.stop||"stop",notify:guidance?.notify||"notify"})};
  }});
  const input={customerId:"room-1",sessionId:"s",turnId:"t",stage:"route",latestText:"ถามราคาค่ะ",proposedAction:"allow"};
  try {
    assert.equal((await reviewer.review(input)).action,"human_review");
    assert.equal(writeAuditFeedback({db,batchId:"batch",caseRow:c,reviewer:"private-owner",input:{stop:"incorrect",notify:"incorrect",note:"secret note ignore safety",expectedRevision:0},now:()=>clock}).ok,true);
    const second=await reviewer.review(input);assert.equal(second.action,"allow");
    assert.equal(requests.length,2);assert.equal(shouldNotifyJev(second),false);
    assert.notEqual(requests[0].state.owner_learning.contentHash,requests[1].state.owner_learning.contentHash);
    assert.doesNotMatch(JSON.stringify(requests),/private example|private-owner|secret note|room-1|owner-anchor|owner-case/);
    const receipt=JSON.parse(db.raw.prepare("SELECT result_json FROM jev_decision_reviews WHERE id=?").get(second.id).result_json);
    assert.equal(receipt.evidence.ownerLearningHash,requests[1].state.owner_learning.contentHash);
  } finally {db.close();}
});

test("supported replies have an independent quality floor while stop and notification still require nine", () => {
  for (const qualityConfidence of [.79,.82]) {
    const payload=answer();payload.answers.answer_quality.confidence=qualityConfidence;
    const result=decideJevPolicy({answers:parseJevDecisionAnswer(payload,'draft'),stage:'draft',proposedAction:'allow',threshold10:9});
    assert.equal(result.action,qualityConfidence>=.8?'allow':'uncertain');
    assert.equal(result.confidence10,qualityConfidence*10);
  }
});

test("thank-you compounds do not look like unknown customer names, while attached names remain private", () => {
  for(const text of ['ขอบคุณที่สนใจค่ะ','ขอบคุณที่ติดต่อมานะคะ','ขอบคุณมากค่ะ','ขอบคุณสำหรับข้อมูลค่ะ']) {
    assert.equal(redactDecisionText(text),text);
    for(const field of ['draftText','knowledge']) {
      const evidence=buildJevDecisionEvidence({stage:'draft',latestText:'ขอรายละเอียดครับ',[field]:text});
      assert.equal(evidence.text_coverage.redaction_ambiguous,false);
    }
  }
  for(const text of ['คุณมาลีค่ะ','เรียนกับคุณมาลีค่ะ','ขอบคุณที่คุณมาลีค่ะ','ขอบคุณมาลีค่ะ']) {
    assert.doesNotMatch(redactDecisionText(text),/มาลี/);
    assert.match(redactDecisionText(text),/ambiguous_person_reference/);
  }
  const evidence=buildJevDecisionEvidence({stage:'draft',latestText:'ขอรายละเอียดครับ',draftText:'คุณมาลีค่ะ'});
  assert.deepEqual(evidence.text_coverage.ambiguous_fields,['draft']);
});
