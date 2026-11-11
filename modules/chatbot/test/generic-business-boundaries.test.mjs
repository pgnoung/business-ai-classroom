import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { DEFAULT_BRAND, setActiveBrand } from "../src/brand.mjs";
import { memoryDb, testConfig, hermesFetchStub, lineFetchStub, poisonGlobalFetch } from "./helpers.mjs";
poisonGlobalFetch();
const generic = { BUSINESS_PROFILE: "generic", BUSINESS_ID: "sample-shop", BRAND_AGENT_NAME: "น้องมะลิ", BRAND_OWNER_NAME: "ทีมร้าน", BRAND_BUSINESS_NAME: "ร้านเสื้อผ้า" };
const silent = { log(){}, info(){}, warn(){}, error(){}, debug(){} };
function fixture(t, env = {}) {
  const db = memoryDb();
  const line = lineFetchStub();
  const config = testConfig({ ...generic, ...env });
  const app = createApp({ db, config, logger: silent, overrides: { hermesFetch: hermesFetchStub("ยินดีให้ข้อมูลสินค้าค่ะ"), lineFetch: line, jevFetch: async()=>({ok:false,status:503,json:async()=>({})}), sleep:async()=>{} } });
  t.after(()=>{app.server.close();db.close();setActiveBrand(DEFAULT_BRAND);});
  return { db, app, config, line };
}
const delivered = w => w.line.sends.flatMap(c=>c.body?.messages||[]).map(m=>m.text||"").join("\n");
test("generic business ignores course-only service boundary even when explicitly enabled", async t=>{
  const w=fixture(t,{SERVICE_BOUNDARY_ENABLED:"true"});
  assert.equal(w.config.serviceBoundaryEnabled,false);
  assert.equal(testConfig({SERVICE_BOUNDARY_ENABLED:"true"}).serviceBoundaryEnabled,true);
  const result=await w.app.pipeline.handleInboundText({customerId:"generic-scope",text:"ช่วยเขียนแคปชั่นให้หน่อย",replyToken:"synthetic"});
  assert.equal(result.sent,true);
  assert.doesNotMatch(delivered(w),/เลือกเรียน|ข้อมูลคลาส|เรียนวิธีทำ/u);
  assert.equal(w.db.getCustomer("generic-scope").followup_enabled,1);
});
for(const [input,expected] of [["รายละเอียด",/สินค้า บริการ หรือราคา/u],["มีอะไรแนะนำไหม",/น้องมะลิพร้อมดูแล/u]]) {
  test(`generic review outage fallback stays business-neutral: ${input}`,async t=>{
    const w=fixture(t,{JEV_REVIEW_MODE:"enforce",TYPESAFE_API_KEY:"synthetic"});
    const result=await w.app.pipeline.handleInboundText({customerId:"generic-fallback",text:input,replyToken:"synthetic"});
    assert.equal(result.sent,true);
    assert.match(delivered(w),expected);
    assert.doesNotMatch(delivered(w),/ลูกแพร|เนื้อหาคอร์ส|รูปแบบเรียน/u);
  });
}
