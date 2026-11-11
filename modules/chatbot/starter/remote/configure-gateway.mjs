#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function readEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(s => /^[A-Z_][A-Z0-9_]*=/.test(s))
    .map(s => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
}
export function writeEnv(file, values) {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const lines = Object.entries(values).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n"'\\$`]/.test(String(value))) throw new Error('unsupported_env_value');
    return `${key}=${value}`;
  });
  writeFileSync(temp, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, file); chmodSync(file, 0o600);
}

export function configureGateway({ etc = '/etc/ai-admin', catalogFile } = {}) {
  const appFile = join(etc, 'env'), gatewayFile = join(etc, 'gateway.env');
  const app = readEnv(appFile), gateway = readEnv(gatewayFile);
  const localBase = 'http://127.0.0.1:8650/v1';
  if (app.HERMES_BASE && !['https://api.openai.com/v1', localBase].includes(app.HERMES_BASE)) {
    throw new Error('custom_gateway_requires_manual_migration');
  }
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8')).map(row => row.id);
  const models = catalog.join(',');
  // Upgrade the direct-API starter without losing its owner-entered key or model choices.
  if (!gateway.OPENAI_API_KEY && app.HERMES_BASE !== localBase) {
    gateway.OPENAI_API_KEY = app.OPENAI_API_KEY || app.HERMES_API_KEY || '';
  }
  if (!gateway.GATEWAY_LOCAL_TOKEN) gateway.GATEWAY_LOCAL_TOKEN = randomBytes(32).toString('hex');
  if (!/^[a-f0-9]{64}$/.test(gateway.GATEWAY_LOCAL_TOKEN)) throw new Error('invalid_existing_local_token');
  gateway.GATEWAY_ALLOWED_MODELS ||= models;
  app.HERMES_BASE = localBase;
  app.HERMES_API_KEY = gateway.GATEWAY_LOCAL_TOKEN;
  // Existing transcription client uses these legacy names, but receives only a LOCAL credential.
  app.OPENAI_API_KEY = gateway.GATEWAY_LOCAL_TOKEN;
  app.OPENAI_BASE = localBase;
  app.HERMES_ALLOWED_MODELS = gateway.GATEWAY_ALLOWED_MODELS;
  for (const key of ['HERMES_REPLY_ALLOWED_MODELS', 'HERMES_SCORER_ALLOWED_MODELS', 'HERMES_FOLLOWUP_ALLOWED_MODELS']) {
    app[key] ||= gateway.GATEWAY_ALLOWED_MODELS;
  }
  // Do not mistake an installed service for provider inference verification.
  writeEnv(gatewayFile, gateway); writeEnv(appFile, app);
  return { configured: true, models: catalog.length, hasOpenAi: Boolean(gateway.OPENAI_API_KEY) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    configureGateway({ catalogFile: process.argv[2] });
    console.log('Gateway configuration prepared; provider keys were not printed.');
  } catch { console.error('Gateway configuration failed; existing custom endpoints require manual migration.'); process.exitCode = 1; }
}
