import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { installAudioRoute, AUDIO_LIMIT } from '../audio.mjs';
const token = 'a'.repeat(64);
async function setup(t, fetchImpl) {
  const server = createServer((_req, res) => { res.end('chat route retained'); });
  installAudioRoute({ server }, { token, keys: ['fake-primary', 'fake-secondary'], fetchImpl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function form(model = 'whisper-1') {
  const body = new FormData(); body.set('model', model); body.set('language', 'th');
  body.set('file', new Blob(['synthetic audio']), 'test.m4a'); return body;
}
const headers = { authorization: `Bearer ${token}` };
test('audio auth, method, multipart fields and model reject before any provider call; chat unchanged', async t => {
  const base = await setup(t, () => { throw new Error('must not call provider'); });
  assert.equal((await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form() })).status, 401);
  assert.equal((await fetch(`${base}/v1/audio/transcriptions`, { headers })).status, 405);
  assert.equal((await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers, body: form('unapproved') })).status, 400);
  const body = form(); body.set('url', 'https://example.invalid');
  assert.equal((await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers, body })).status, 400);
  assert.equal(await (await fetch(`${base}/v1/chat/completions`)).text(), 'chat route retained');
});
test('audio forwards only fixed endpoint/provider key; key rejection retries without leaking provider payload', async t => {
  const calls = [];
  const base = await setup(t, async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return Response.json({ error: 'private provider error' }, { status: 429 });
    return Response.json({ text: 'ข้อความทดสอบ', internal: 'not exposed' });
  });
  const response = await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', headers, body: form() });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { text: 'ข้อความทดสอบ' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[1].init.headers.authorization, 'Bearer fake-secondary');
  assert.equal(calls[1].init.redirect, 'error');
  assert.deepEqual([...calls[1].init.body.keys()], ['model', 'language', 'file']);
});
test('chunked upload is bounded without a Content-Length header', async t => {
  let called = false;
  const base = await setup(t, () => { called = true; throw new Error('must not call'); });
  const status = await new Promise((resolve, reject) => {
    const req = request(`${base}/v1/audio/transcriptions`, { method: 'POST', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(Buffer.alloc(AUDIO_LIMIT)); req.end(Buffer.alloc(1));
  });
  assert.equal(status, 413); assert.equal(called, false);
});
