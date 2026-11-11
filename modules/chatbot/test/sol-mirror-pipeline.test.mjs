import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/server.mjs';
import {poisonGlobalFetch,testConfig,memoryDb,hermesFetchStub,lineFetchStub,waitFor} from './helpers.mjs';
poisonGlobalFetch();
const id='23456789-1234-4123-8123-123456789012';
test('mirror links actual delivered bubbles; does not send shadow text or change production model',async t=>{
  const db=memoryDb();t.after(()=>db.close());db.setApprovedPrice('fixture',2500);
  const deliveries=[],drafts=[],stub=hermesFetchStub('สวัสดีค่ะ ยินดีดูแลนะคะ');
  const app=createApp({db,config:testConfig({HERMES_API_KEY:'local-fixture'}),logger:{log(){},warn(){},error(){}},overrides:{sleep:async()=>{},lineFetch:lineFetchStub(),
    hermesFetch:async(url,opts)=>{
      if(url.endsWith('/mirror/delivery')){deliveries.push(JSON.parse(opts.body));return {ok:true,json:async()=>({recorded:true})};}
      drafts.push(opts);const r=await stub(url,opts);r.headers={get:key=>key==='x-lukprae-mirror-id'?id:null};return r;
    }}});
  const customerId=`U${'a'.repeat(32)}`;
  const result=await app.pipeline.handleInboundText({customerId,text:'สวัสดีค่ะ สนใจเรียน',replyToken:'rt'});
  assert.equal(result.sent,true);await waitFor(()=>deliveries.length===1);
  assert.equal(deliveries[0].status,'delivered');
  assert.deepEqual(deliveries[0].texts,db.messagesFor(customerId).filter(m=>m.direction==='out').map(m=>m.content));
  assert.match(drafts[0].headers['x-lukprae-room-hash'],/^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(drafts[0].body).model,'gpt-5.6-sol');
});
test('mirror acknowledgement failure does not fail customer send',async t=>{
  const db=memoryDb();t.after(()=>db.close());const stub=hermesFetchStub();let attempted=false;
  const app=createApp({db,config:testConfig(),logger:{log(){},warn(){},error(){}},overrides:{sleep:async()=>{},lineFetch:lineFetchStub(),hermesFetch:async(url,opts)=>{
    if(url.endsWith('/mirror/delivery')){attempted=true;throw new Error('offline observation');}
    const r=await stub(url,opts);r.headers={get:()=>id};return r;
  }}});
  const result=await app.pipeline.handleInboundText({customerId:`U${'b'.repeat(32)}`,text:'สวัสดีค่ะ',replyToken:'rt'});
  assert.equal(result.sent,true);await waitFor(()=>attempted);
});
