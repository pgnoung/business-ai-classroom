#!/usr/bin/env node
// Learner launcher. No paid probes, customer data, or production credentials at startup.
import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOpenAiStatelessGateway, verifyProviderModels, ANTHROPIC_MODELS } from './openai-stateless-gateway.mjs';
import { installAudioRoute } from './audio.mjs';

export function configuredModels(env = process.env) {
  const roster = JSON.parse(readFileSync(new URL('../config/model-pricing.json', import.meta.url), 'utf8'));
  const raw = env.GATEWAY_ALLOWED_MODELS || roster.map(row => row.id).join(',');
  const ids = [...new Set(raw.split(',').map(id => id.trim()).filter(Boolean))];
  if (!ids.length || ids.some(id => !/^[a-zA-Z0-9._:-]{1,100}$/.test(id))) throw new Error('invalid_model_catalog');
  return ids;
}

export async function createStudentGateway({ env = process.env, fetchImpl = fetch } = {}) {
  const localBearerToken = env.GATEWAY_LOCAL_TOKEN || '';
  if (!/^[a-f0-9]{48,128}$/.test(localBearerToken)) throw new Error('gateway_local_token_required');
  if (!env.OPENAI_API_KEY) {
    // Installation can finish before the owner enters keys. Never forward a fake key.
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${localBearerToken}`) {
        res.writeHead(401); return res.end(JSON.stringify({ error: 'local_auth_required' }));
      }
      if (req.method === 'GET' && req.url === '/v1/models/health') {
        return res.end(JSON.stringify({ ok: false, configured: false, providerModelsVerified: false,
          providerInferenceReady: false, models: [], modelReadiness: {}, openaiKeys: [], anthropicKeys: [] }));
      }
      res.writeHead(503); res.end(JSON.stringify({ error: 'provider_not_configured' }));
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    return {
      server,
      async listen({ host = '127.0.0.1', port = 8650 } = {}) {
        if (host !== '127.0.0.1') throw new Error('loopback_only');
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
        return server.address();
      },
      async close() { if (server.listening) await new Promise(resolve => server.close(resolve)); },
    };
  }
  const allowedModels = configuredModels(env);
  let providerModelsVerified = false;
  // Listing models is not an inference test. Do not turn it into a false readiness claim.
  for (const key of [env.OPENAI_API_KEY, env.OPENAI_API_KEY_2].filter(Boolean)) {
    try {
      const verified = await verifyProviderModels({ upstreamApiKey: key, fetchImpl,
        allowedModels: allowedModels.filter(id => !ANTHROPIC_MODELS.includes(id)) });
      providerModelsVerified = verified.models.length > 0; break;
    } catch { /* The owner can fix keys and restart; generation remains fail-closed. */ }
  }
  const gateway = createOpenAiStatelessGateway({
    upstreamApiKey: env.OPENAI_API_KEY, upstreamApiKey2: env.OPENAI_API_KEY_2 || '', localBearerToken,
    anthropicApiKey: env.ANTHROPIC_API_KEY || '', anthropicApiKey2: env.ANTHROPIC_API_KEY_2 || '',
    anthropicWorkspaceId: env.ANTHROPIC_WORKSPACE_ID || '', anthropicWorkspaceId2: env.ANTHROPIC_WORKSPACE_ID_2 || '',
    allowedModels, fetchImpl, providerModelsVerified, providerInferenceVerified: false,
    readinessModels: allowedModels, requireAnthropicKey: true,
  });
  return installAudioRoute(gateway, { token: localBearerToken,
    keys: [env.OPENAI_API_KEY, env.OPENAI_API_KEY_2].filter(Boolean), fetchImpl });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const gateway = await createStudentGateway();
    await gateway.listen();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => gateway.close().then(() => process.exit(0)));
    console.log('AI Gateway listening on loopback; check status and run an approved model test before go-live.');
  } catch { console.error('AI Gateway startup failed; check the protected configuration.'); process.exitCode = 1; }
}
