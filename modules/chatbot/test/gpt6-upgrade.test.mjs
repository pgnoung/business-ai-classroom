import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelPricing, pricingById, usageCostUsd, summarizeUsage } from '../src/modelPricing.mjs';
import { usageFields } from '../src/llmUsageFields.mjs';
import { createHermesBridge } from '../src/hermesBridge.mjs';
import { memoryDb, testConfig, hermesFetchStub, poisonGlobalFetch } from './helpers.mjs';
poisonGlobalFetch();
const prices = pricingById(loadModelPricing(new URL('../config/model-pricing.json', import.meta.url)));
test('GPT6 rates: ordinary, cached and writes are disjoint; history unchanged', () => {
  assert.equal(usageCostUsd({model:'gpt-6-sol',tokensIn:100000,cachedIn:50000,cacheWriteIn:20000,tokensOut:1000},prices),0.13);
  assert.equal(usageCostUsd({model:'gpt-6-luna',tokensIn:100000,cachedIn:50000,cacheWriteIn:20000,tokensOut:1000},prices),0.0065);
  assert.equal(usageCostUsd({model:'gpt-5.6-sol',tokensIn:100000,tokensOut:1000},prices),0.42);
  assert.equal(usageCostUsd({model:'unknown',tokensIn:1000},prices),null);
});
test('GPT6 long context threshold applies to one request, never daily summed input', () => {
  assert.equal(usageCostUsd({model:'gpt-6-sol',tokensIn:272000},prices),0.544);
  assert.equal(usageCostUsd({model:'gpt-6-sol',tokensIn:300000,cachedIn:100000,cacheWriteIn:100000,tokensOut:1000},prices),0.955);
  const db=memoryDb();
  try {
    db.upsertCustomer('gpt6-test',{});
    for(let i=0;i<10;i++)db.addLlmUsage({customerId:'gpt6-test',kind:'draft',model:'gpt-6-sol',tokensIn:100000,cachedIn:50000,cacheWriteIn:20000,tokensOut:1000});
    db.addLlmUsage({customerId:'gpt6-test',kind:'draft',model:'gpt-6-sol',tokensIn:300000,cachedIn:100000,cacheWriteIn:100000,tokensOut:1000});
    for(const rows of [db.llmUsageSummary(),db.llmUsageForCustomer('gpt6-test')]) {
      assert.equal(rows.length,2);
      assert.equal(Number(summarizeUsage(rows,prices).usd.toFixed(6)),2.255);
      assert.equal(rows.reduce((n,r)=>n+r.cache_write_in,0),300000);
    }
  } finally {db.close();}
});
test('provider cache writes reach the ledger without double counting or guessing missing receipts',()=>{
  for(const usage of [
    {prompt_tokens:100,prompt_tokens_details:{cached_tokens:60,cache_write_tokens:30}},
    {input_tokens:100,input_tokens_details:{cached_tokens:60,cache_write_tokens:30}}
  ])assert.deepEqual(usageFields(usage),{tokensIn:100,tokensOut:0,cachedIn:60,cacheWriteIn:30});
  assert.equal(usageFields({input_tokens:100,input_tokens_details:{cached_tokens:90,cache_write_tokens:500}}).cacheWriteIn,10);
  assert.equal(Object.hasOwn(usageFields({input_tokens:100}),'cacheWriteIn'),false);
});
test('all chat roles ignore stale 5.6 overrides; scoring stays Luna and fallback stays Sol',async()=>{
  const fetch=hermesFetchStub();
  const config=testConfig({HERMES_MODEL:'gpt-6-sol',HERMES_SCORER_MODEL:'gpt-6-luna',HERMES_SCORER_FALLBACK_MODEL:'gpt-6-sol',HERMES_ALLOWED_MODELS:'gpt-6-sol,gpt-6-luna',HERMES_REPLY_ALLOWED_MODELS:'gpt-6-sol',HERMES_SCORER_ALLOWED_MODELS:'gpt-6-luna'});
  const bridge=createHermesBridge({config,fetchImpl:fetch,getReplyModel:()=> 'gpt-5.6-sol',getScorerModel:()=> 'gpt-5.6-luna',getFollowupModel:()=> 'gpt-5.6-sol'});
  await bridge.draftReply({userText:'test'});
  await bridge.draftReply({userText:'test',role:'followup'});
  await bridge.scoreCustomer({transcript:'test'});
  assert.deepEqual(fetch.calls.map(c=>c.body.model),['gpt-6-sol','gpt-6-sol','gpt-6-luna']);
});

test('a 6.1-only instance coerces stale role overrides and an explicit empty scorer fallback makes no call',async()=>{
  const fetch=hermesFetchStub();
  const config=testConfig({
    HERMES_MODEL:'gpt-6.1-sol', HERMES_SCORER_MODEL:'gpt-6.1-sol',
    HERMES_SCORER_FALLBACK_MODEL:'',
    HERMES_ALLOWED_MODELS:'gpt-6.1-sol,gpt-5.6-terra,claude-sonnet-5-5',
    HERMES_REPLY_ALLOWED_MODELS:'gpt-6.1-sol',
    HERMES_FOLLOWUP_MODEL:'gpt-6.1-sol', HERMES_FOLLOWUP_ALLOWED_MODELS:'gpt-6.1-sol',
    HERMES_SCORER_ALLOWED_MODELS:'gpt-6.1-sol',
  });
  const bridge=createHermesBridge({config,fetchImpl:fetch,
    getReplyModel:()=> 'claude-sonnet-5-5',getScorerModel:()=> 'claude-sonnet-5-5',getFollowupModel:()=> 'gpt-5.6-terra'});
  await bridge.draftReply({userText:'test'});
  await bridge.draftReply({userText:'test',role:'followup'});
  await bridge.scoreCustomer({transcript:'test'});
  assert.equal(await bridge.scoreCustomerFallback({transcript:'test'}),null);
  assert.deepEqual(fetch.calls.map(c=>c.body.model),['gpt-6.1-sol','gpt-6.1-sol','gpt-6.1-sol']);
});

test('emergency rollback ignores stale GPT6 settings for replies, followups and scoring',async()=>{
  const fetch=hermesFetchStub();
  const config=testConfig({
    HERMES_MODEL:'gpt-5.6-sol', HERMES_SCORER_MODEL:'gpt-5.6-luna',
    HERMES_SCORER_FALLBACK_MODEL:'gpt-5.6-terra',
    HERMES_ALLOWED_MODELS:'gpt-5.6-sol,gpt-5.6-luna,gpt-5.6-terra',
    HERMES_REPLY_ALLOWED_MODELS:'gpt-5.6-sol',
    HERMES_FOLLOWUP_MODEL:'gpt-5.6-sol', HERMES_FOLLOWUP_ALLOWED_MODELS:'gpt-5.6-sol',
    HERMES_SCORER_ALLOWED_MODELS:'gpt-5.6-luna',
  });
  const bridge=createHermesBridge({config,fetchImpl:fetch,
    getReplyModel:()=> 'gpt-6-sol',getScorerModel:()=> 'gpt-6-luna',getFollowupModel:()=> 'gpt-6-sol'});
  await bridge.draftReply({userText:'synthetic rollback test'});
  await bridge.draftReply({userText:'synthetic rollback test',role:'followup'});
  await bridge.scoreCustomer({transcript:'synthetic rollback test'});
  assert.deepEqual(fetch.calls.map(c=>c.body.model),['gpt-5.6-sol','gpt-5.6-sol','gpt-5.6-luna']);
});
