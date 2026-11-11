import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { JEV_DECISION_QUESTIONS } from "../src/jevDecisionReview.mjs";
import { JEV_HOLD_FALLBACK_TEMPLATE } from "../src/pipeline.mjs";
import { poisonGlobalFetch, memoryDb, testConfig, hermesFetchStub, lineFetchStub } from "./helpers.mjs";
poisonGlobalFetch();
const silent = { log(){}, info(){}, warn(){}, error(){}, debug(){} };
function judge({ complaint="none", human_need="information", answer_quality="pass", stop="continue", notify="not_needed", confidence=.97, onCall } = {}) {
  const calls=[];
  const fn=async (_url, opts) => {
    const input=JSON.parse(opts.body); calls.push(input);
    await onCall?.(input);
    const answers={};
    for (const key of Object.keys(input.questions)) {
      const selected={complaint,human_need,answer_quality,stop,notify}[key];
      const rubric=JEV_DECISION_QUESTIONS[key].criteria;
      const options=Array.isArray(rubric)?rubric:Object.keys(rubric);
      answers[key]={type:"choice",choice:selected,confidence,
        probabilities:Object.fromEntries(options.map(option=>[option,option===selected?1:0]))};
    }
    return {ok:true,json:async()=>({model:"jev-1.13.0",answers,usage:{input_tokens:100,output_tokens:20}})};
  }; fn.calls=calls; return fn;
}
function fixture({ reply="ค่าเรียน 15,900 บาทค่ะ", mode="enforce", jevFetch=judge(), bankGuard=true, lineFetch=lineFetchStub(), notifier=null }={}) {
  const db=memoryDb(); db.setApprovedPrice("AI Agent Workflow Automation — Early Bird",15900);
  const hermesFetch=hermesFetchStub(reply);
  const pushes=[];
  const notify=notifier || { fireLater(payload) { pushes.push(payload); } };
  const app=createApp({db,config:testConfig({JEV_REVIEW_MODE:mode,TYPESAFE_API_KEY:"fixture",SALES_DECISION_GUARD_ENABLED:String(bankGuard)}),
    overrides:{jevFetch,hermesFetch,lineFetch,notifier:notify,sleep:async()=>{},salesPolicy:{businessId:"pngoung-tidkradum",decisionRoles:[],customerJourneys:[],courses:[{id:"workflow",name:"AI Agent Workflow Automation",aliases:[]}],opportunities:[]}},logger:silent});
  return {db,app,hermesFetch,lineFetch,jevFetch,pushes};
}
const sentText=w=>w.lineFetch.sends.flatMap(call=>call.body?.messages||[]).map(m=>m.text||"").join("\n");

test("review route and delivered draft with native confidence /10; no automatic training", async()=>{
  const w=fixture();
  const result=await w.app.pipeline.handleInboundText({customerId:"jev-pipeline",text:"ค่าเรียนเท่าไหร่คะ",replyToken:"r1"});
  assert.equal(result.sent,true); assert.match(sentText(w),/15,900/);
  const rows=w.db.raw.prepare("SELECT * FROM jev_decision_reviews ORDER BY created_at,rowid").all();
  assert.deepEqual(rows.map(r=>r.stage),["route","draft"]);
  assert.equal(rows[1].confidence_10,9.7); assert.equal(rows[1].applied,1);
  assert.doesNotMatch(w.jevFetch.calls.find(call=>call.state.stage==="draft").state.workflow_policy,/ห้องนี้ได้รับช่องทางชำระเงินแล้ว/);
  assert.equal(w.db.raw.prepare("SELECT count(*) n FROM corrections").get().n,0);
});
test("after-bank information review gets the payment-history rule only when actually awaiting payment",async()=>{
  const w=fixture(); w.db.upsertCustomer("after-bank",{}); w.db.setDealStatus("after-bank","awaiting_payment");
  const result=await w.app.pipeline.handleInboundText({customerId:"after-bank",text:"ขอทราบค่าเรียนอีกครั้งค่ะ",replyToken:"r"});
  assert.equal(result.sent,true); assert.match(sentText(w),/15,900/);
  assert.match(w.jevFetch.calls.find(call=>call.state.stage==="draft").state.workflow_policy,/ห้องนี้ได้รับช่องทางชำระเงินแล้ว/);
  assert.equal(w.db.getCustomer("after-bank").ai_enabled,1);
});
test("unquoted account cannot be sent even if Jev says pass", async()=>{
  const w=fixture({reply:"เลขบัญชี: 0000000000 ค่ะ"});
  await w.app.pipeline.handleInboundText({customerId:"bank-no-price",text:"นามบุคคลค่ะ",replyToken:"r1"});
  assert.doesNotMatch(sentText(w),/0000000000/);
  assert.equal(w.db.getCustomer("bank-no-price").ai_enabled,1);
});
test("delivered quote and bank preserves reactive information but stops follow-up", async()=>{
  const w=fixture({reply:"AI Agent Workflow Automation ค่าเรียน 15,900 บาทค่ะ\n\nเลขบัญชี: 0000000000"});
  await w.app.pipeline.handleInboundText({customerId:"bank-info",text:"ขอรายละเอียดสมัครค่ะ",replyToken:"r1"});
  assert.match(sentText(w),/0000000000/);
  const customer=w.db.getCustomer("bank-info");
  assert.equal(customer.ai_enabled,1); assert.equal(customer.followup_enabled,0);
  assert.equal(customer.deal_status,"awaiting_payment");
});
test("manual AI off cannot be reopened or judged into sending", async()=>{
  const w=fixture(); w.db.upsertCustomer("manual",{}); w.db.setAiEnabled("manual",false,"manual");
  await w.app.pipeline.handleInboundText({customerId:"manual",text:"ราคาเท่าไหร่",replyToken:"r1"});
  assert.equal(w.jevFetch.calls.length,0); assert.equal(w.lineFetch.sends.length,0);
  assert.equal(w.db.getCustomer("manual").ai_enabled,0);
});
test("provider outage sends only a safe fallback and does not create a JEV admin push or AI-off", async()=>{
  const w=fixture({jevFetch:async()=>{throw Error("provider secret");}});
  await w.app.pipeline.handleInboundText({customerId:"outage",text:"ค่าเรียนเท่าไหร่",replyToken:"r1"});
  assert.doesNotMatch(sentText(w),/15,900/);
  // พี่ง้วง 12 ต.ค. (ข้อ 3): ตัวตรวจล่มไม่ใช่ "ข้อมูลยืนยันไม่ได้" — ขอโทษที่สะดุดแล้วชวนพิมพ์มาอีกครั้ง ไม่อ้างทีมงาน (ไม่มีคนถูกปลุกจริง)
  assert.ok(sentText(w).includes(JEV_HOLD_FALLBACK_TEMPLATE),sentText(w));
  assert.doesNotMatch(sentText(w),/ยืนยันไม่ได้|ไม่มีข้อมูล|ทีมงาน/);
  assert.equal(w.pushes.length,0);
  assert.equal(w.db.getCustomer("outage").ai_enabled,1);
  const rows=w.db.raw.prepare("SELECT confidence_10,result_json FROM jev_decision_reviews").all();
  assert.ok(rows.length>0); assert.ok(rows.every(r=>r.confidence_10===null));
  assert.doesNotMatch(JSON.stringify(rows),/provider secret/);
});

test("high-confidence JEV notify can page the team while information AI stays enabled", async()=>{
  const w=fixture({jevFetch:judge({notify:"notify"})});
  const result=await w.app.pipeline.handleInboundText({customerId:"jev-notify",text:"ค่าเรียนเท่าไหร่",replyToken:"r"});
  assert.equal(result.sent,true);
  assert.match(sentText(w),/15,900/);
  assert.equal(w.db.getCustomer("jev-notify").ai_enabled,1);
  assert.equal(w.db.getCustomer("jev-notify").state,"NEEDS_HUMAN");
  assert.equal(w.pushes.length,1);
  assert.equal(w.pushes[0].reason,"jev_review_notify");
});

test("high-confidence JEV stop waits for safe delivery, then disables AI without forcing a push", async()=>{
  const w=fixture({jevFetch:judge({stop:"stop",notify:"not_needed"})});
  const result=await w.app.pipeline.handleInboundText({customerId:"jev-stop",text:"ค่าเรียนเท่าไหร่",replyToken:"r"});
  assert.equal(result.sent,true);
  assert.match(sentText(w),/ตรวจข้อมูลกับทีม/);
  assert.equal(w.db.getCustomer("jev-stop").ai_enabled,0);
  assert.equal(w.db.getCustomer("jev-stop").ai_off_reason,"jev_review_stop");
  assert.equal(w.pushes.length,0);
});

test("low-confidence stop or notify has no side effect", async()=>{
  const w=fixture({jevFetch:judge({stop:"stop",notify:"notify",confidence:.8})});
  const result=await w.app.pipeline.handleInboundText({customerId:"jev-low-confidence",text:"ค่าเรียนเท่าไหร่",replyToken:"r"});
  assert.equal(result.sent,true);
  assert.equal(w.db.getCustomer("jev-low-confidence").ai_enabled,1);
  assert.equal(w.pushes.length,0);
});
test("new inbound while Jev runs cannot apply stale result or send stale draft", async()=>{
  let w; const customerId="new-inbound";
  const jevFetch=judge({onCall:input=>{if(input.state.stage==="draft") w.db.insertMessage({customerId,direction:"in",msgType:"text",content:"เปลี่ยนคำถามค่ะ",createdAt:Date.now()+1});}});
  w=fixture({jevFetch});
  w.db.upsertCustomer(customerId,{});
  const r=await w.app.pipeline.handleInboundText({customerId,text:"ค่าเรียนเท่าไหร่",replyToken:"r1"});
  assert.match(r.suppressed,/stale/); assert.equal(w.lineFetch.sends.length,0);
});
test("shadow records disagreement without applying or teaching it",async()=>{
  const w=fixture({mode:"shadow",jevFetch:judge({answer_quality:"unsupported"})});
  const r=await w.app.pipeline.handleInboundText({customerId:"shadow-only",text:"ค่าเรียนเท่าไหร่",replyToken:"r1"});
  assert.equal(r.sent,true);
  const row=w.db.raw.prepare("SELECT applied,action FROM jev_decision_reviews WHERE stage='draft'").get();
  assert.equal(row.applied,0); assert.equal(row.action,"rewrite");
});

test("high-confidence review can correct a false complaint route without closing AI", async()=>{
  const w=fixture({jevFetch:judge({complaint:"frustration"})});
  const r=await w.app.pipeline.handleInboundText({customerId:"false-complaint",text:"ไม่พอใจเลยค่ะ ถามราคาแล้วยังไม่ได้คำตอบ ค่าเรียนเท่าไหร่",replyToken:"r"});
  assert.equal(r.sent,true); assert.match(sentText(w),/15,900/);
  assert.equal(w.db.getCustomer("false-complaint").ai_enabled,1);
  assert.equal(w.db.raw.prepare("SELECT applied FROM jev_decision_reviews WHERE stage='route'").get().applied,1);
});

test("explicit human request retains deterministic handoff even if reviewer disagrees", async()=>{
  const w=fixture();
  const r=await w.app.pipeline.handleInboundText({customerId:"ask-human",text:"ขอคุยกับแอดมินคนจริงค่ะ",replyToken:"r"});
  assert.equal(r.sent,true); assert.equal(w.db.getCustomer("ask-human").ai_enabled,0);
  assert.equal(w.db.getCustomer("ask-human").ai_off_reason,"human_requested");
});

test("a real complaint remains a human-owned case",async()=>{
  const w=fixture({jevFetch:judge({complaint:"complaint",human_need:"human_required"})});
  await w.app.pipeline.handleInboundText({customerId:"real-complaint",text:"ต้องการร้องเรียน บริการแย่มากค่ะ",replyToken:"r"});
  assert.equal(w.db.getCustomer("real-complaint").ai_enabled,0);
  assert.equal(w.db.getCustomer("real-complaint").ai_off_reason,"complaint");
});

test("operator takeover during final review prevents sending and cannot be reopened",async()=>{
  let w;
  w=fixture({jevFetch:judge({onCall:input=>{if(input.state.stage==="draft") w.db.setAiEnabled("takeover",false,"manual");}})});
  const r=await w.app.pipeline.handleInboundText({customerId:"takeover",text:"ค่าเรียนเท่าไหร่",replyToken:"r"});
  assert.match(r.suppressed,/stale/); assert.equal(w.lineFetch.sends.length,0);
  assert.equal(w.db.getCustomer("takeover").ai_enabled,0);
});

test("price delivered without the bank cannot mark bank_sent or stop follow-up",async()=>{
  const w=fixture({reply:"AI Agent Workflow Automation ค่าเรียน 15,900 บาทค่ะ\n\nเลขบัญชี: 0000000000"});
  w.app.humanizer.humanize=({text})=>text.split("\n\n").map(text=>({text,delayMs:0}));
  w.app.lineRegistry.forChannel("default").sendBubbles=async({bubbles})=>{
    assert.equal(bubbles.length,2); assert.doesNotMatch(bubbles[0].text,/0000000000/);
    return {ok:true,stoppedEarly:true,delivered:[{type:"text",text:bubbles[0].text}]};
  };
  await w.app.pipeline.handleInboundText({customerId:"partial-bank",text:"รายละเอียดสมัครค่ะ",replyToken:"r"});
  assert.notEqual(w.db.getCustomer("partial-bank").deal_status,"awaiting_payment");
  assert.equal(w.db.getCustomer("partial-bank").followup_enabled,1);
  assert.equal(w.db.getCustomer("partial-bank").ai_enabled,1);
});

test("bank delivery followed by a booking handoff phrase still permits information replies",async()=>{
  const w=fixture({mode:"shadow",reply:"AI Agent Workflow Automation ค่าเรียน 15,900 บาทค่ะ\n\nเลขบัญชี: 0000000000\n\nลูกแพรส่งเรื่องให้แอดมินดูแลต่อแล้วค่ะ"});
  await w.app.pipeline.handleInboundText({customerId:"bank-booking",text:"จอง AI Agent Workflow Automation หนึ่งที่ค่ะ",replyToken:"r"});
  assert.match(sentText(w),/0000000000/);
  assert.equal(w.db.getCustomer("bank-booking").deal_status,"awaiting_payment");
  assert.equal(w.db.getCustomer("bank-booking").ai_enabled,1);
});

test("hung shadow provider never delays delivery or changes the AI decision",async()=>{
  let release;
  const wait = new Promise(resolve => { release=resolve; });
  const w=fixture({mode:"shadow",jevFetch:judge({onCall:()=>wait})});
  const reply=w.app.pipeline.handleInboundText({customerId:"shadow-hang",text:"ค่าเรียนเท่าไหร่",replyToken:"r"});
  let timeout;
  try {
    const r=await Promise.race([reply,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("shadow blocked delivery")),500);})]);
    assert.equal(r.sent,true); assert.match(sentText(w),/15,900/);
    assert.equal(w.db.getCustomer("shadow-hang").ai_enabled,1);
  } finally { clearTimeout(timeout); release(); }
  await new Promise(resolve=>setImmediate(resolve));
  const rows=w.db.raw.prepare("SELECT applied,status FROM jev_decision_reviews").all();
  assert.equal(rows.length,2); assert.ok(rows.every(row=>row.applied===0 && row.status==="reviewed"));
});

test("an old human queue does not swallow a new JEV notification",async()=>{
  const w=fixture({jevFetch:judge({notify:"notify"})});
  w.db.upsertCustomer("old-queue",{});
  w.db.setNeedsHuman("old-queue","hermes_down","old queue");
  await w.app.pipeline.handleInboundText({customerId:"old-queue",text:"ค่าเรียนเท่าไหร่ค่ะ",replyToken:"r"});
  assert.equal(w.db.getCustomer("old-queue").ai_enabled,1);
  assert.equal(w.pushes.filter(p=>p.reason==="jev_review_notify").length,1);
});

test("partially delivered reply cannot apply JEV notification or shutdown",async()=>{
  const w=fixture({jevFetch:judge({stop:"stop",notify:"notify"})});
  w.app.lineRegistry.forChannel("default").sendBubbles=async()=>({ok:true,stoppedEarly:true,delivered:[]});
  await w.app.pipeline.handleInboundText({customerId:"jev-partial",text:"ค่าเรียนเท่าไหร่ค่ะ",replyToken:"r"});
  assert.equal(w.db.getCustomer("jev-partial").ai_enabled,1);
  assert.equal(w.pushes.filter(p=>String(p.reason).startsWith("jev_")).length,0);
  assert.equal(w.db.raw.prepare("SELECT applied FROM jev_decision_reviews WHERE stage='draft'").get().applied,0);
});

test("generic details request continues with a useful clarification when JEV cannot judge",async()=>{
  const w=fixture({jevFetch:async()=>{throw new Error('fixture unavailable');}});
  await w.app.pipeline.handleInboundText({customerId:'generic-details',text:'ขอรายละเอียดครับ',replyToken:'r'});
  assert.match(sentText(w),/สนใจรายละเอียดด้านไหน/);
  assert.doesNotMatch(sentText(w),/ยังยืนยันไม่ได้/);
  assert.equal(w.db.getCustomer('generic-details').ai_enabled,1);
  assert.equal(w.pushes.length,0);
});

test("a thank-you in the draft reaches JEV instead of triggering the privacy fallback",async()=>{
  const w=fixture({reply:'ขอบคุณที่สนใจค่ะ ค่าเรียน 15,900 บาทค่ะ'});
  await w.app.pipeline.handleInboundText({customerId:'thankyou-details',text:'ขอรายละเอียดครับ',replyToken:'r'});
  assert.equal(w.jevFetch.calls.filter(call=>call.state.stage==='draft').length,1);
  assert.match(sentText(w),/15,900/);
  assert.doesNotMatch(sentText(w),/ยังยืนยันไม่ได้/);
});
