import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, apply, merge, normalize, issues, client, privateWrite, ORIGIN, exportNongkao } from '../scripts/sync.mjs';

const target = { accountId: 'account-demo', actor: 'learner@example.com', platform: 'line', oaId: 'oa-demo', shopName: 'ร้านตัวอย่าง' };
const card = { kind: 'faq', tag: '', title: 'การเก็บ', content: 'เก็บให้พ้นแสงแดด', source: 'ผู้เรียนยืนยัน', reviewedOn: '2026-01-01', validUntil: '' };
const empty = () => ({ businessName: '', assistantName: 'น้องเก้า', tone: 'สุภาพ', businessType: 'other', businessTypeCustom: '', cards: [] });
const input = () => ({ target: { ...target }, metadata: { businessName: target.shopName }, cards: [{ ...card }] });
export function mock() {
  const state = { revision: 0, activeVersion: null, draft: empty() }, versions = new Map(), writes = [];
  const who = { accountId: target.accountId, actor: target.actor, caps: ['teach'], shops: [{ platform: 'line', oaId: 'oa-demo', name: target.shopName }] };
  const api = async (path, b) => {
    if (path === '/me') return { ok: true, account: { id: who.accountId, email: who.actor }, shops: who.shops, team: { caps: who.caps } };
    if (path === '/team') return { ok: true, me: { email: who.actor } };
    if (path.endsWith('knowledge-read')) return { ok: true, knowledge: structuredClone(state) };
    if (path.endsWith('knowledge-version')) return { ok: true, knowledge: { draft: structuredClone(versions.get(b.versionId)) } };
    if (b.revision !== state.revision) throw new Error('revision_conflict');
    if (path.endsWith('knowledge-save')) { writes.push('save'); state.draft = normalize(b.draft); state.revision++; }
    else if (path.endsWith('knowledge-publish')) {
      assert.equal(b.confirmed, true); assert.deepEqual(issues(state.draft), []);
      writes.push('publish'); state.revision++; state.activeVersion = 'v' + state.revision; versions.set(state.activeVersion, structuredClone(state.draft));
    } else throw new Error('unknown_mock_path');
    return { ok: true, knowledge: structuredClone(state) };
  };
  return { api, state, versions, writes, who };
}

test('planning reads only; draft save preserves active version', async () => {
  const m = mock(), p = await plan(m.api, input(), 'draft');
  assert.deepEqual(m.writes, []);
  const r = await apply(m.api, p, p.id);
  assert.equal(r.state, 'draft_readback_verified'); assert.equal(r.activeVersion, null); assert.deepEqual(m.writes, ['save']);
});
test('live save and publish verified; identical sync is no-op', async () => {
  const m = mock(), p = await plan(m.api, input(), 'live');
  const first = await apply(m.api, p, p.id);
  assert.equal(first.state, 'published_readback_verified'); assert.equal(first.cards, 1);
  const p2 = await plan(m.api, input(), 'live');
  const second = await apply(m.api, p2, p2.id);
  assert.equal(second.activeVersion, first.activeVersion); assert.deepEqual(m.writes, ['save', 'publish']);
});
test('merge keeps unrelated knowledge and persona; conflicts need named replacement', () => {
  const base = { ...empty(), businessName: 'เดิม', assistantName: 'มะลิ', cards: [card] };
  const additional = { ...card, title: 'การจัดส่ง', content: 'ส่งวันจันทร์' };
  const out = merge(base, { cards: [additional] });
  assert.equal(out.draft.cards.length, 2); assert.equal(out.draft.assistantName, 'มะลิ');
  const changed = { ...card, content: 'เก็บในที่แห้ง' };
  assert.throws(() => merge(base, { cards: [changed] }), /conflicting/);
  assert.equal(merge(base, { cards: [changed], replace: [{ kind: card.kind, tag: '', title: card.title }] }).draft.cards[0].content, changed.content);
});
test('price/schedule without expiry can remain draft but cannot go live', async () => {
  const m = mock(), i = input(); i.cards[0].kind = 'price';
  const p = await plan(m.api, i, 'draft'); assert.ok(p.issues.includes('price_schedule_expiry_required'));
  await assert.rejects(plan(m.api, i, 'live'), /publish_blocked/); assert.deepEqual(m.writes, []);
});
test('invalid calendar dates, future review and expired cards are rejected', () => {
  const d = normalize({ ...empty(), businessName: 'x', cards: [{ ...card, reviewedOn: '2026-02-30' }] });
  assert.ok(issues(d, '2026-10-09').includes('invalid_review_date'));
  d.cards[0].reviewedOn = '2099-01-01'; assert.ok(issues(d, '2026-10-09').includes('invalid_review_date'));
  d.cards[0].reviewedOn = '2026-01-01'; d.cards[0].validUntil = '2026-02-01'; assert.ok(issues(d, '2026-10-09').includes('invalid_expiry'));
});
test('existing unpublished work requires explicit review', async () => {
  const m = mock(); m.state.draft = { ...empty(), businessName: 'x', cards: [card] };
  await assert.rejects(plan(m.api, input(), 'live'), /existing_unpublished/);
  const p = await plan(m.api, { ...input(), includeExistingDraft: true }, 'live'); assert.equal(p.existingUnpublished, true);
});
test('stale revision and tampered plan never write', async () => {
  const m = mock(), p = await plan(m.api, input(), 'live');
  await assert.rejects(apply(m.api, { ...p, mode: 'draft' }, p.id), /approved_plan_mismatch/);
  await assert.rejects(apply(m.api, p, 'wrong'), /approved_plan_mismatch/);
  m.state.revision++; await assert.rejects(apply(m.api, p, p.id), /stale_plan/); assert.deepEqual(m.writes, []);
});
test('changed actor, workspace, missing shop or teach permission fail before knowledge mutation', async () => {
  for (const mutation of [m => m.who.actor = 'another@example.com', m => m.who.accountId = 'other', m => m.who.shops = [], m => m.who.caps = []]) {
    const m = mock(), p = await plan(m.api, input(), 'live'); mutation(m);
    await assert.rejects(apply(m.api, p, p.id)); assert.deepEqual(m.writes, []);
  }
});
test('unknown target cannot trigger implicit shop binding through knowledge-read', async () => {
  const m = mock(); let knowledgeReads = 0;
  const api = (path, body) => { if (path.includes('knowledge')) knowledgeReads++; return m.api(path, body); };
  await assert.rejects(plan(api, { ...input(), target: { ...target, oaId: 'guessed' } })); assert.equal(knowledgeReads, 0);
});
test('first training works for a linked channel with no name after explicit channel selection', async () => {
  const m = mock(); m.who.shops[0].name = '';
  const i = input(); i.target.shopName = 'line:oa-demo';
  const p = await plan(m.api, i, 'live');
  assert.equal((await apply(m.api, p, p.id)).state, 'published_readback_verified');
});
test('save readback mismatch stops publish', async () => {
  const m = mock(), p = await plan(m.api, input(), 'live');
  const api = async (path, body) => { const result = await m.api(path, body); if (path.endsWith('knowledge-save')) m.state.draft.cards[0].content = 'unexpected'; return result; };
  await assert.rejects(apply(api, p, p.id), /saved_state_changed/); assert.deepEqual(m.writes, ['save']);
});
test('network failure after save is not retried or published', async () => {
  const m = mock(), p = await plan(m.api, input(), 'live');
  const api = async (path, body) => { const result = await m.api(path, body); if (path.endsWith('knowledge-save')) throw new Error('network_outcome_unknown_read_back_before_retry'); return result; };
  await assert.rejects(apply(api, p, p.id), /network_outcome_unknown/); assert.deepEqual(m.writes, ['save']);
});
test('publish verifies active payload, not only HTTP success or version ID', async () => {
  const m = mock(), p = await plan(m.api, input(), 'live');
  const api = async (path, body) => { const result = await m.api(path, body); if (path.endsWith('knowledge-publish')) m.versions.get(m.state.activeVersion).cards[0].content = 'wrong'; return result; };
  await assert.rejects(apply(api, p, p.id), /published_readback_mismatch/);
});
test('last read detects concurrent edit even on an unchanged sync', async () => {
  const m = mock(), p = await plan(m.api, input(), 'live'); await apply(m.api, p, p.id);
  const p2 = await plan(m.api, input(), 'live'); let reads = 0;
  const api = async (path, body) => { if (path.endsWith('knowledge-read') && ++reads === 2) m.state.revision++; return m.api(path, body); };
  await assert.rejects(apply(api, p2, p2.id), /final_state_changed/);
});
test('card limits and ambiguous duplicates do not silently truncate', () => {
  assert.throws(() => merge(empty(), { cards: [card, card] }), /duplicate_input/);
  assert.throws(() => merge({ ...empty(), cards: [card, card] }, { cards: [card] }), /ambiguous/);
  assert.throws(() => normalize({ ...empty(), cards: Array(61).fill(card) }), /limit/);
  assert.throws(() => normalize({ ...empty(), cards: [{ ...card, content: 'x'.repeat(5001) }] }), /invalid_field/);
});
test('transport blocks alternate destination and redirects; errors cannot echo tokens', async () => {
  assert.throws(() => client({ origin: 'https://example.com' }), /untrusted_origin/);
  let options;
  const api = client({ token: 'private-value', fetchImpl: async (url, o) => { assert.ok(url.startsWith(ORIGIN)); options = o; return { ok: false, status: 401, json: async () => ({ error: 'private-value' }) }; } });
  await assert.rejects(api('/me'), /^Error: api_401_failed$/); assert.equal(options.redirect, 'error');
});
test('private outputs are owner-only and never overwrite an existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nk-sync-test-'));
  try { const file = join(dir, 'out.json'); await privateWrite(file, { safe: true }); assert.equal((await stat(file)).mode & 0o777, 0o600); await assert.rejects(privateWrite(file, { safe: false }), /EEXIST/); assert.equal(JSON.parse(await readFile(file, 'utf8')).safe, true); }
  finally { await rm(dir, { recursive: true }); }
});
test('Nongkao export uses published data, not an unfinished draft', async () => {
  const m = mock(); await assert.rejects(exportNongkao(m.api, target), /no_active_version/);
  const p = await plan(m.api, input(), 'live'); await apply(m.api, p, p.id);
  m.state.draft.cards[0].content = 'ยังไม่ได้เปิดใช้'; m.state.revision++;
  const exported = await exportNongkao(m.api, target);
  assert.equal(exported.draft.cards[0].content, card.content);
});
test('Nongkao export refuses a source changed during capture', async () => {
  const m = mock(), p = await plan(m.api, input(), 'live'); await apply(m.api, p, p.id);
  const api = async (path, body) => { const r = await m.api(path, body); if (path.endsWith('knowledge-version')) m.state.revision++; return r; };
  await assert.rejects(exportNongkao(api, target), /source_changed_during_export/);
});
