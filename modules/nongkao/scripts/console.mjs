import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { digest } from './sync.mjs';

export function consoleOrigin(value, { localTest = false } = {}) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || !['/', '/console', '/console/'].includes(u.pathname)) throw new Error('console_origin_invalid');
  if (u.protocol !== 'https:' && !(localTest && u.protocol === 'http:' && u.hostname === '127.0.0.1')) throw new Error('console_requires_https');
  return u.origin;
}
export const consoleSessionPath = origin => resolve(homedir(), '.config/nongkao-knowledge-sync', 'console-' + digest(origin).slice(0, 20) + '.json');
export async function loadConsoleSession(origin) {
  const path = consoleSessionPath(consoleOrigin(origin));
  const st = await lstat(path).catch(() => { throw new Error('console_login_required'); });
  if (!st.isFile() || (st.mode & 0o077) || st.uid !== process.getuid?.()) throw new Error('console_session_permissions_invalid');
  const s = JSON.parse(await readFile(path, 'utf8'));
  if (s.origin !== origin || !/^chassis_session=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s.cookie) || !s.username) throw new Error('console_session_invalid');
  return s;
}
// Deliberately read-only. Student writes use their existing ai-admin import command.
export function consoleClient({ origin, cookie, fetchImpl = fetch, localTest = false }) {
  origin = consoleOrigin(origin, { localTest });
  return async path => {
    if (!['/me', '/knowledge', '/prices', '/brain'].includes(path)) throw new Error('console_read_path_not_allowed');
    let r, data;
    try { r = await fetchImpl(origin + '/console/api' + path, { headers: { cookie }, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('console_network_failed'); }
    try { data = await r.json(); } catch { throw new Error('console_invalid_response'); }
    if (!r.ok || data.ok !== true) throw new Error(`console_http_${r.status}`);
    return data;
  };
}
export async function consoleSnapshot(api, expected) {
  const me = await api('/me');
  if (me.operator?.username !== expected.username) throw new Error('console_actor_changed');
  const selectRows = response => {
    if (!Array.isArray(response.knowledge)) throw new Error('console_schema_not_supported');
    return response.knowledge.map(r => ({ id: r.id, title: r.title, content: r.content, active: r.active, channel_id: r.channel_id ?? null, source: r.source }));
  };
  const selectPrices = response => {
    if (!Array.isArray(response.prices)) throw new Error('console_schema_not_supported');
    return response.prices.map(p => ({ label: p.label, amount: p.amount }));
  };
  const rows = selectRows(await api('/knowledge'));
  const prices = selectPrices(await api('/prices'));
  // Runtime counters matter for readback; do not export persona, model config, contacts or image URLs.
  const brain = await api('/brain');
  const again = selectRows(await api('/knowledge'));
  const pricesAgain = selectPrices(await api('/prices'));
  if (digest(rows) !== digest(again) || digest(prices) !== digest(pricesAgain)) throw new Error('console_changed_during_export');
  const last = await api('/me');
  if (last.operator?.username !== expected.username) throw new Error('console_actor_changed');
  return { schema: 1, system: 'ai-admin-console', origin: expected.origin, username: expected.username,
    branding: { businessName: me.branding?.businessName, agentName: me.branding?.agentName }, knowledge: rows, prices, runtime: brain.knowledge };
}
