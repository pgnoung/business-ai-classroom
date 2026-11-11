#!/usr/bin/env node
// Explicit synthetic inference only. Running --test costs provider credits.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, realpathSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ANTHROPIC_FALLBACK_MODEL } from '../../gateway/openai-stateless-gateway.mjs';

export function selectedModels(env, getSetting = () => '') {
  const reply = getSetting('reply_model') || env.HERMES_MODEL;
  const scorer = getSetting('scorer_model') || env.HERMES_SCORER_MODEL || reply;
  const followup = getSetting('followup_model') || env.HERMES_FOLLOWUP_MODEL || reply;
  const roles = [reply, scorer, followup, env.HERMES_SCORER_FALLBACK_MODEL].filter(Boolean);
  const allowed = new Set((env.HERMES_ALLOWED_MODELS || roles.join(',')).split(',').map(s => s.trim()));
  if (roles.some(model => model.startsWith('claude-')) && allowed.has(ANTHROPIC_FALLBACK_MODEL)) roles.push(ANTHROPIC_FALLBACK_MODEL);
  if (!roles.length || roles.some(model => !allowed.has(model))) throw new Error('selected_model_not_allowed');
  return [...new Set(roles)].sort();
}
function sign(value, secret) { return createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex'); }
export function makeReceipt(models, secret, now = Date.now()) {
  const data = { version: 1, models: [...models].sort(), testedAt: now, expiresAt: now + 7 * 86400000, syntheticOnly: true };
  return { ...data, signature: sign(data, secret) };
}
export function receiptValid(receipt, models, secret, now = Date.now()) {
  if (!receipt || !secret) return false;
  const { signature, ...data } = receipt;
  if (!/^[a-f0-9]{64}$/.test(signature || '') || data.version !== 1 || data.syntheticOnly !== true ||
    !Number.isSafeInteger(data.testedAt) || data.testedAt > now || data.expiresAt !== data.testedAt + 7 * 86400000 ||
    now >= data.expiresAt || JSON.stringify(data.models) !== JSON.stringify([...models].sort())) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(data, secret), 'hex'));
}
export async function testModels({ models, base, token, fetchImpl = fetch }) {
  if (base !== 'http://127.0.0.1:8650/v1') throw new Error('local_gateway_required');
  for (const model of models) {
    const response = await fetchImpl(`${base}/chat/completions`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Synthetic setup test: reply with OK only.' }],
        max_completion_tokens: 1000, store: false, stream: false }), signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error('model_test_failed');
    const data = await response.json();
    if (!data?.choices?.[0]?.message?.content?.trim() || response.headers.get('x-lukprae-fallback-from') ||
      (data.model && !String(data.model).startsWith(model))) throw new Error('requested_model_not_verified');
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  let db;
  try {
    const env = process.env;
    db = new DatabaseSync(env.DB_FILE, { readOnly: true });
    const get = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || '';
    const models = selectedModels(env, get);
    const file = join(env.DATA_DIR, 'provider-receipt.json');
    if (process.argv[2] === '--test') {
      console.log(`Testing ${models.length} selected/fallback models with synthetic messages; provider credits are used.`);
      await testModels({ models, base: env.HERMES_BASE, token: env.HERMES_API_KEY });
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify(makeReceipt(models, env.HERMES_API_KEY)), { mode: 0o600 });
      renameSync(temp, file);
      console.log('Selected models verified; receipt valid for 7 days unless keys or selections change.');
    } else if (process.argv[2] === '--verify') {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 16384 ||
        !receiptValid(JSON.parse(readFileSync(file, 'utf8')), models, env.HERMES_API_KEY)) throw new Error('receipt_invalid');
      console.log('Selected-model receipt verified.');
    } else throw new Error('expected_test_or_verify');
  } catch { console.error('Model verification unavailable or expired. Check selected models and keys; run model-test explicitly before go-live.'); process.exitCode = 1; }
  finally { db?.close(); }
}
