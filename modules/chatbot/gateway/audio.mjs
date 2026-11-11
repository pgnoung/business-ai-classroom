// Narrow transcription adapter. No arbitrary URL, model, files on disk or request logging.
export const AUDIO_LIMIT = 20 * 1024 * 1024;
const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const RETRY = new Set([401, 402, 403, 429]);
const fail = (res, status, error) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error })); };

export function installAudioRoute(gateway, { token, keys, fetchImpl = fetch }) {
  const original = gateway.server.listeners('request');
  gateway.server.removeAllListeners('request');
  let busy = 0;
  gateway.server.on('request', async (req, res) => {
    if (req.url !== '/v1/audio/transcriptions') { for (const handler of original) handler(req, res); return; }
    if (req.headers.authorization !== `Bearer ${token}`) return fail(res, 401, 'local_auth_required');
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed');
    if (!keys.length) return fail(res, 503, 'provider_not_configured');
    if (busy >= 2) return fail(res, 429, 'gateway_busy');
    if (!/^multipart\/form-data;\s*boundary=/i.test(req.headers['content-type'] || '')) return fail(res, 415, 'multipart_required');
    if (Number(req.headers['content-length']) > AUDIO_LIMIT) return fail(res, 413, 'audio_too_large');
    busy++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > AUDIO_LIMIT) return fail(res, 413, 'audio_too_large'); chunks.push(chunk); }
      const parsed = await new Request('http://localhost/transcribe', { method: 'POST',
        headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
      const names = [...parsed.keys()];
      if (names.some(name => !['model', 'language', 'file'].includes(name)) || new Set(names).size !== names.length ||
        parsed.get('model') !== 'whisper-1' || !['th', 'en', null].includes(parsed.get('language'))) return fail(res, 400, 'invalid_audio_fields');
      const file = parsed.get('file');
      if (!(file instanceof Blob) || !file.size || file.size > AUDIO_LIMIT) return fail(res, 400, 'invalid_audio_file');
      const body = new FormData(); body.set('model', 'whisper-1');
      if (parsed.get('language')) body.set('language', parsed.get('language'));
      body.set('file', file, 'voice.m4a');
      const signal = AbortSignal.timeout(25000);
      for (let i = 0; i < keys.length; i++) {
        const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${keys[i]}` }, body, signal });
        if (!response.ok) {
          await response.body?.cancel();
          if (RETRY.has(response.status) && i + 1 < keys.length) continue;
          return fail(res, 502, 'transcription_unavailable');
        }
        let bytes = 0; const output = [];
        for await (const chunk of response.body) {
          bytes += chunk.length; if (bytes > 128 * 1024) throw new Error('response_limit'); output.push(Buffer.from(chunk));
        }
        const result = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (typeof result.text !== 'string') throw new Error('response_invalid');
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: result.text })); return;
      }
    } catch { if (!res.headersSent) fail(res, 502, 'transcription_unavailable'); }
    finally { busy--; }
  });
  return gateway;
}
