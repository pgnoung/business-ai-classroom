#!/usr/bin/env node
// Nongkao's existing session-authenticated API. No admin credentials or paid AI endpoint.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORIGIN = 'https://nongkao.tkd-crm.com';
export const SESSION = resolve(homedir(), '.config/nongkao-knowledge-sync/session.json');
const kinds = new Set(['general', 'price', 'schedule', 'policy', 'faq']);
const clone = v => structuredClone(v);
const stable = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
export const digest = v => createHash('sha256').update(stable(v)).digest('hex');
const same = (a, b) => digest(a) === digest(b);
const fail = message => { throw new Error(message); };
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const str = (v, max) => typeof v === 'string' && v.length <= max ? v.trim() : fail('invalid_field');
const key = c => [c.kind, c.tag, c.title].map(x => x.normalize('NFC').trim().toLowerCase()).join('\u0000');

export function normalize(value) {
  if (!value || !Array.isArray(value.cards) || value.cards.length > 60) fail('invalid_cards_limit_60');
  const d = {
    businessName: str(value.businessName, 150), assistantName: str(value.assistantName, 80),
    tone: str(value.tone, 800), businessType: str(value.businessType, 80),
    businessTypeCustom: str(value.businessTypeCustom ?? '', 80),
    cards: value.cards.map(c => {
      if (!c || !kinds.has(c.kind)) fail('invalid_card_kind');
      return { kind: c.kind, tag: str(c.tag ?? '', 60), title: str(c.title, 150), content: str(c.content, 5000),
        source: str(c.source, 500), reviewedOn: str(c.reviewedOn, 10), validUntil: str(c.validUntil ?? '', 10) };
    })
  };
  if (JSON.stringify(d).length > 150000) fail('knowledge_too_large');
  return d;
}
export function issues(d, today = day()) {
  const errors = [];
  if (!d.businessName || !d.cards.length) errors.push('missing_business_or_cards');
  for (const c of d.cards) {
    if (!c.title || !c.content || !c.source) errors.push('missing_card_fields');
    if (!validDate(c.reviewedOn) || c.reviewedOn > today) errors.push('invalid_review_date');
    if (['price', 'schedule'].includes(c.kind) && !c.validUntil) errors.push('price_schedule_expiry_required');
    if (c.validUntil && (!validDate(c.validUntil) || c.validUntil < today || c.validUntil < c.reviewedOn)) errors.push('invalid_expiry');
  }
  return [...new Set(errors)];
}
export function merge(base, input) {
  const d = clone(base), changes = [];
  const metadata = input.metadata ?? {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!['businessName', 'assistantName', 'tone', 'businessType', 'businessTypeCustom'].includes(k)) fail('invalid_metadata');
    if (d[k] !== v) { changes.push({ action: 'metadata', field: k }); d[k] = v; }
  }
  if (!Array.isArray(input.cards)) fail('cards_required');
  const incoming = normalize({ ...d, cards: input.cards }).cards;
  const seen = new Set();
  for (const c of incoming) {
    const k = key(c);
    if (seen.has(k)) fail('duplicate_input_key');
    seen.add(k);
    const matches = d.cards.map((x, i) => key({ ...x, tag: x.tag ?? '' }) === k ? i : -1).filter(i => i >= 0);
    if (matches.length > 1) fail('ambiguous_existing_card');
    if (!matches.length) { d.cards.push(c); changes.push({ action: 'add', title: c.title }); continue; }
    const i = matches[0], old = { ...d.cards[i], tag: d.cards[i].tag ?? '' };
    if (same(old, c)) continue;
    if (!(input.replace ?? []).some(x => key({ ...x, tag: x.tag ?? '' }) === k)) fail('conflicting_card_requires_explicit_replace');
    d.cards[i] = c; changes.push({ action: 'replace', title: c.title });
  }
  return { draft: normalize(d), changes };
}

export function client({ origin = ORIGIN, token = '', fetchImpl = fetch } = {}) {
  const u = new URL(origin);
  // The shipped CLI never accepts an alternative origin. Loopback is only for integration tests.
  if (origin !== ORIGIN && !(u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname) && u.pathname === '/' && !u.username && !u.password && !u.search && !u.hash)) fail('untrusted_origin');
  return async (path, body) => {
    let response;
    try {
      response = await fetchImpl(origin + path, { method: body === undefined ? 'GET' : 'POST',
        redirect: 'error', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { fail('network_outcome_unknown_read_back_before_retry'); }
    let data;
    try { data = await response.json(); } catch { fail('invalid_api_response'); }
    if (!response.ok || data.ok !== true) fail(`api_${response.status}_${/^[a-z_]{1,80}$/.test(data.error) ? data.error : 'failed'}`);
    return data;
  };
}
export async function identity(api) {
  const me = await api('/me');
  let actor = me.account.email;
  if (me.team) actor = (await api('/team')).me.email;
  return { accountId: me.account.id, actor,
    shops: me.shops.map(s => ({ ...s, displayName: s.name || s.taughtName || `${s.platform}:${s.oaId}` })),
    caps: me.team?.caps ?? ['teach'] };
}
async function checkedIdentity(api, t) {
  if (!t || !['line', 'facebook', 'tiktok'].includes(t.platform) || !/^[A-Za-z0-9_-]{1,128}$/.test(t.oaId ?? '') || !t.accountId || !t.actor || !t.shopName) fail('exact_target_required');
  const who = await identity(api);
  if (who.accountId !== t.accountId || who.actor.toLowerCase() !== t.actor.toLowerCase()) fail('account_or_actor_changed');
  if (!who.caps.includes('teach')) fail('teach_permission_required');
  const shop = who.shops.find(s => s.platform === t.platform && s.oaId === t.oaId);
  if (!shop || ![shop.name, shop.taughtName, shop.displayName].includes(t.shopName)) fail('shop_not_linked_or_name_changed');
  return who;
}
const targetBody = t => ({ platform: t.platform, oaId: t.oaId });
async function read(api, t) {
  const k = (await api('/knowledge/knowledge-read', targetBody(t))).knowledge;
  if (!Number.isInteger(k?.revision) || !k.draft) fail('invalid_knowledge_response');
  return k;
}
async function activeData(api, t, state) {
  if (!state.activeVersion) return null;
  return (await api('/knowledge/knowledge-version', { ...targetBody(t), versionId: state.activeVersion })).knowledge.draft;
}
export async function exportNongkao(api, target) {
  await checkedIdentity(api, target);
  const first = await read(api, target);
  if (!first.activeVersion) fail('source_has_no_active_version');
  const draft = normalize(await activeData(api, target, first));
  const after = await read(api, target);
  if (first.revision !== after.revision || first.activeVersion !== after.activeVersion) fail('source_changed_during_export');
  return { system: 'nongkao', target, activeVersion: first.activeVersion, revision: first.revision, draft };
}
export async function plan(api, input, mode = 'draft') {
  if (!['draft', 'live'].includes(mode)) fail('invalid_mode');
  await checkedIdentity(api, input.target);
  const before = await read(api, input.target), active = await activeData(api, input.target, before);
  const existingUnpublished = active ? !same(normalize(active), normalize(before.draft)) : before.draft.cards.length > 0;
  if (existingUnpublished && input.includeExistingDraft !== true) fail('existing_unpublished_draft_requires_review');
  const { draft, changes } = merge(before.draft, input);
  const errors = issues(draft);
  if (mode === 'live' && errors.length) fail('publish_blocked:' + errors.join(','));
  const p = { schema: 1, origin: ORIGIN, target: input.target, mode,
    before: { revision: before.revision, activeVersion: before.activeVersion, draft: before.draft },
    draft, changes, issues: errors, existingUnpublished, activeMatches: active ? same(normalize(active), draft) : false };
  return { ...p, id: digest(p) };
}
export async function apply(api, p, approvedId) {
  const { id, ...body } = p;
  if (p.schema !== 1 || p.origin !== ORIGIN || !['draft', 'live'].includes(p.mode) || id !== approvedId || digest(body) !== id) fail('approved_plan_mismatch');
  const candidate = normalize(p.draft);
  if (!same(candidate, p.draft)) fail('invalid_plan_draft');
  if (p.mode === 'live' && issues(candidate).length) fail('publish_checks_failed');
  await checkedIdentity(api, p.target);
  let current = await read(api, p.target);
  if (current.revision !== p.before.revision || current.activeVersion !== p.before.activeVersion || !same(current.draft, p.before.draft)) fail('stale_plan_rebuild_required');
  const originalVersion = current.activeVersion;
  const saved = !same(normalize(current.draft), candidate);
  if (saved) {
    await api('/knowledge/knowledge-save', { ...targetBody(p.target), revision: current.revision, draft: candidate });
    current = await read(api, p.target);
    if (current.revision !== p.before.revision + 1 || current.activeVersion !== originalVersion || !same(current.draft, candidate)) fail('saved_state_changed_stop');
  }
  if (p.mode === 'live') {
    const active = await activeData(api, p.target, current);
    if (!active || !same(normalize(active), candidate)) {
      // Revalidate identity after save; never publish in a switched workspace.
      await checkedIdentity(api, p.target);
      const published = (await api('/knowledge/knowledge-publish', { ...targetBody(p.target), revision: current.revision, confirmed: true })).knowledge;
      const after = await read(api, p.target);
      const live = await activeData(api, p.target, after);
      if (!published.activeVersion || after.activeVersion !== published.activeVersion || after.revision !== current.revision + 1 || !same(live, candidate) || !same(after.draft, candidate)) fail('published_readback_mismatch');
      current = after;
    }
  }
  const final = await read(api, p.target);
  if (final.revision !== current.revision || final.activeVersion !== current.activeVersion || !same(normalize(final.draft), candidate)) fail('final_state_changed_stop');
  return { state: p.mode === 'live' ? 'published_readback_verified' : 'draft_readback_verified',
    planId: id, revision: current.revision, activeVersion: current.activeVersion, previousActiveVersion: originalVersion,
    cards: candidate.cards.length, changedDraft: saved, shopName: p.target.shopName, platform: p.target.platform };
}

// Sensitive files stay outside the distributable and require owner-only permissions.
export async function privateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export async function sessionToken() {
  if (process.env.NONGKAO_SESSION_TOKEN) return process.env.NONGKAO_SESSION_TOKEN;
  const st = await lstat(SESSION).catch(() => fail('login_required'));
  if (!st.isFile() || (st.mode & 0o077) || st.uid !== process.getuid?.()) fail('session_file_permissions_invalid');
  const s = JSON.parse(await readFile(SESSION, 'utf8'));
  if (s.origin !== ORIGIN || !/^[a-f0-9]{64}$/.test(s.token ?? '')) fail('session_invalid');
  return s.token;
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help') {
    console.log('Nongkao Knowledge Sync (Node 22+)\n  login.mjs  — interactive email/OTP login\n  sync.mjs shops\n  sync.mjs plan INPUT.json draft|live PLAN.json\n  sync.mjs apply PLAN.json APPROVED_PLAN_ID RECEIPT.json\nTokens are never accepted as command-line arguments.'); return;
  }
  if (!['shops', 'plan', 'apply'].includes(cmd)) fail('unknown_command');
  const api = client({ token: await sessionToken() });
  if (cmd === 'shops') { console.log(JSON.stringify(await identity(api), null, 2)); return; }
  if (cmd === 'plan') {
    if (args.length !== 3) fail('usage_plan_INPUT_MODE_OUTPUT');
    const p = await plan(api, JSON.parse(await readFile(args[0], 'utf8')), args[1]);
    await privateWrite(resolve(args[2]), p);
    console.log(JSON.stringify({ id: p.id, mode: p.mode, shopName: p.target.shopName, changes: p.changes, issues: p.issues, cards: p.draft.cards.length }));
  } else {
    if (args.length !== 3) fail('usage_apply_PLAN_APPROVED_ID_RECEIPT');
    // Reserve receipt before any write so a repeated invocation cannot replay blindly.
    const receipt = resolve(args[2]);
    await privateWrite(receipt, { state: 'attempt_started' });
    try {
      const result = await apply(api, JSON.parse(await readFile(args[0], 'utf8')), args[1]);
      await writeFile(receipt, JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
    } catch (error) {
      await writeFile(receipt, JSON.stringify({ state: 'stopped_inspect_provider_before_retry', error: error.message }) + '\n'); throw error;
    }
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main().catch(e => { console.error(e instanceof SyntaxError ? 'invalid_json' : e.code ? `local_${e.code}` : e.message); process.exitCode = 1; });
