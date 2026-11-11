import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createStudentGateway, configuredModels } from '../serve.mjs';
import { configureGateway, readEnv } from '../../starter/remote/configure-gateway.mjs';
import { makeReceipt, receiptValid, selectedModels, testModels } from '../../starter/remote/provider-check.mjs';

const token = 'a'.repeat(64);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const roster = new URL('../../config/model-pricing.json', import.meta.url);

test('fresh installation: no provider call, unauthenticated rejected, authenticated status is honestly unconfigured', async t => {
  const gateway = await createStudentGateway({ env: { GATEWAY_LOCAL_TOKEN: token }, fetchImpl: () => { throw new Error('network forbidden'); } });
  const addr = await gateway.listen({ port: 0 }); t.after(() => gateway.close());
  const base = `http://127.0.0.1:${addr.port}`;
  assert.equal((await fetch(`${base}/v1/models/health`)).status, 401);
  const health = await (await fetch(`${base}/v1/models/health`, { headers })).json();
  assert.equal(health.configured, false); assert.equal(health.ok, false);
  assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: '{}' })).status, 503);
  await assert.rejects(gateway.listen({ host: '0.0.0.0', port: 0 }), /loopback/);
});

test('two own OpenAI keys pass into live gateway, metadata does not claim inference, failover reports slots only', async t => {
  const calls = [];
  const gateway = await createStudentGateway({ env: { GATEWAY_LOCAL_TOKEN: token, OPENAI_API_KEY: 'fake-first', OPENAI_API_KEY_2: 'fake-second', GATEWAY_ALLOWED_MODELS: 'gpt-6.1-sol' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
      if (init.headers.authorization === 'Bearer fake-first') return Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 });
      return Response.json({ model: 'gpt-6.1-sol', choices: [{ message: { content: 'OK' } }] });
    } });
  assert.equal(calls.length, 1); assert.equal(calls[0].init.method, 'GET');
  const addr = await gateway.listen({ port: 0 }); t.after(() => gateway.close());
  const base = `http://127.0.0.1:${addr.port}`;
  let health = await (await fetch(`${base}/v1/models/health`, { headers })).json();
  assert.equal(health.providerInferenceReady, false);
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'synthetic test' }] }) });
  assert.equal(res.status, 200);
  health = await (await fetch(`${base}/v1/models/health`, { headers })).json();
  assert.equal(health.providerInferenceReady, true);
  assert.equal(health.openaiKeys.find(k => k.slot === 2).active, true);
  assert.doesNotMatch(JSON.stringify(health), /fake-first|fake-second/);
});

test('direct-API upgrade preserves key/brand/models, separates gateway token, is idempotent and rejects custom gateway before changes', t => {
  const etc = mkdtempSync(join(tmpdir(), 'gateway-install-')); t.after(() => rmSync(etc, { recursive: true, force: true }));
  writeFileSync(join(etc, 'env'), 'OPENAI_API_KEY=fake-owner-key\nHERMES_BASE=https://api.openai.com/v1\nHERMES_API_KEY=fake-owner-key\nHERMES_MODEL=gpt-5.6-sol\nBRAND_BUSINESS_NAME=ร้านตัวอย่าง\n');
  configureGateway({ etc, catalogFile: roster });
  const app = readEnv(join(etc, 'env')), gateway = readEnv(join(etc, 'gateway.env'));
  assert.equal(app.HERMES_BASE, 'http://127.0.0.1:8650/v1');
  assert.equal(app.HERMES_API_KEY, gateway.GATEWAY_LOCAL_TOKEN); assert.equal(app.OPENAI_API_KEY, gateway.GATEWAY_LOCAL_TOKEN); assert.equal(app.OPENAI_BASE, app.HERMES_BASE); assert.notEqual(app.OPENAI_API_KEY, gateway.OPENAI_API_KEY);
  assert.equal(gateway.OPENAI_API_KEY, 'fake-owner-key'); assert.equal(app.HERMES_MODEL, 'gpt-5.6-sol');
  assert.equal(app.BRAND_BUSINESS_NAME, 'ร้านตัวอย่าง'); assert.equal(statSync(join(etc, 'gateway.env')).mode & 0o777, 0o600);
  const before = readFileSync(join(etc, 'env'), 'utf8'); configureGateway({ etc, catalogFile: roster });
  assert.equal(readFileSync(join(etc, 'env'), 'utf8'), before);
  writeFileSync(join(etc, 'env'), 'HERMES_BASE=https://custom.example/v1\n');
  assert.throws(() => configureGateway({ etc, catalogFile: roster }), /custom_gateway/);
  assert.equal(readFileSync(join(etc, 'env'), 'utf8'), 'HERMES_BASE=https://custom.example/v1\n');
});

test('selected models follow saved Console overrides and signed receipt expires/rejects changed models or token', () => {
  const values = { reply_model: 'claude-sonnet-5-5', scorer_model: 'gpt-5.6-luna', followup_model: '' };
  const models = selectedModels({ HERMES_MODEL: 'gpt-6.1-sol', HERMES_ALLOWED_MODELS: 'claude-sonnet-5-5,gpt-5.6-luna,gpt-6.1-sol' }, k => values[k]);
  assert.deepEqual(models, ['claude-sonnet-5-5', 'gpt-5.6-luna', 'gpt-6.1-sol']);
  const receipt = makeReceipt(models, token, 100);
  assert.equal(receiptValid(receipt, models, token, 101), true);
  assert.equal(receiptValid(receipt, models, token, 100 + 7 * 86400000), false);
  assert.equal(receiptValid(receipt, ['gpt-6.1-sol'], token, 101), false);
  assert.equal(receiptValid(receipt, models, 'other', 101), false);
});

test('explicit model test sends only synthetic text and rejects fallback/failed inference', async () => {
  const requests = [];
  await testModels({ models: ['gpt-6.1-sol'], base: 'http://127.0.0.1:8650/v1', token,
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return Response.json({ model: 'gpt-6.1-sol', choices: [{ message: { content: 'OK' } }] }); } });
  assert.equal(requests[0].messages.length, 1); assert.match(requests[0].messages[0].content, /Synthetic setup test/);
  await assert.rejects(testModels({ models: ['claude-sonnet-5-5'], base: 'http://127.0.0.1:8650/v1', token,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: 'OK' } }] }, { headers: { 'x-lukprae-fallback-from': 'claude-sonnet-5-5' } }) }), /not_verified/);
});

test('launcher executes through an actual release symlink; invalid secret fails without disclosing it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-symlink-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = new URL('../serve.mjs', import.meta.url); symlinkSync(target, join(dir, 'serve.mjs'));
  const child = spawn(process.execPath, [join(dir, 'serve.mjs')], { env: { PATH: process.env.PATH, GATEWAY_LOCAL_TOKEN: 'fake-secret-marker' } });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 1); assert.match(stderr, /startup failed/); assert.doesNotMatch(stderr, /fake-secret-marker/);
});

test('Claude-only without a Claude key never reports ready or spends on an unselected fallback', async t => {
  const calls = [];
  const gateway = await createStudentGateway({ env: { GATEWAY_LOCAL_TOKEN: token, OPENAI_API_KEY: 'fake', GATEWAY_ALLOWED_MODELS: 'claude-sonnet-5-5' },
    fetchImpl: async (url, init) => { calls.push({url, init}); return Response.json({ data: [] }); } });
  const addr = await gateway.listen({port:0}); t.after(() => gateway.close()); const base=`http://127.0.0.1:${addr.port}/v1`;
  const health = await (await fetch(`${base}/models/health`, {headers})).json();
  assert.equal(health.ok,false); assert.equal(health.providerInferenceReady,false); assert.equal(health.providerModelsVerified,false);
  const response=await fetch(`${base}/chat/completions`,{method:'POST',headers,body:JSON.stringify({model:'claude-sonnet-5-5',messages:[{role:'user',content:'synthetic'}]})});
  assert.equal(response.status,503); assert.equal(calls.filter(c=>c.init.method==='POST').length,0);
});
test('selected Console roles route Claude requests, but an excluded fallback is never invoked', async t => {
  const calls=[];
  const env={GATEWAY_LOCAL_TOKEN:token,OPENAI_API_KEY:'fake-openai',ANTHROPIC_API_KEY:'fake-claude',GATEWAY_ALLOWED_MODELS:'claude-sonnet-5-5'};
  const gateway=await createStudentGateway({env,fetchImpl:async(url,init)=>{
    calls.push({url,init}); if(url.endsWith('/models'))return Response.json({data:[]});
    return Response.json({error:{type:'overloaded_error'}},{status:529});
  }});
  const addr=await gateway.listen({port:0});t.after(()=>gateway.close());
  const models=selectedModels({HERMES_MODEL:'claude-sonnet-5-5',HERMES_ALLOWED_MODELS:env.GATEWAY_ALLOWED_MODELS},()=> 'claude-sonnet-5-5');
  assert.deepEqual(models,['claude-sonnet-5-5']);
  const response=await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`,{method:'POST',headers,body:JSON.stringify({model:models[0],messages:[{role:'user',content:'synthetic'}]})});
  assert.equal(response.status,503);
  assert.ok(calls.some(c=>c.url==='https://api.anthropic.com/v1/messages'));
  assert.equal(calls.filter(c=>c.url==='https://api.openai.com/v1/chat/completions').length,0);
});
test('a lost gateway file never promotes a chassis local token to an upstream API key', t=>{
  const etc=mkdtempSync(join(tmpdir(),'gateway-recover-'));t.after(()=>rmSync(etc,{recursive:true,force:true}));
  writeFileSync(join(etc,'env'),`HERMES_BASE=http://127.0.0.1:8650/v1\nOPENAI_API_KEY=${token}\nHERMES_API_KEY=${token}\n`);
  configureGateway({etc,catalogFile:roster});assert.equal(readEnv(join(etc,'gateway.env')).OPENAI_API_KEY,undefined);
});
