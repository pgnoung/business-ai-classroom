import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { nongkaoBundle, consoleBundle, toNongkao, makeStarterPlan, inventory, stageStarter, checkStarter, verifyStarterSnapshot, commitStarter } from '../scripts/bridge.mjs';
import { consoleClient, consoleSnapshot, consoleOrigin } from '../scripts/console.mjs';

const card = { kind: 'faq', tag: '', title: 'เก็บสินค้า', content: 'เก็บให้พ้นแสงแดด', source: 'เจ้าของร้านยืนยัน', reviewedOn: '2026-01-01', validUntil: '' };
const bundle = (cards = [card]) => nongkaoBundle({ target: { accountId: 'demo', platform: 'line', oaId: 'demo', shopName: 'ร้านตัวอย่าง' }, activeVersion: 'v1', revision: 2, draft: { cards } });
const biz = { businessId: 'demo-shop', businessName: 'ร้านตัวอย่าง', agentName: 'มะลิ', ownerName: 'ทีมร้าน' };
const packFiles = () => new Map([['business.json', Buffer.from(JSON.stringify(biz))], ['products.json', Buffer.from(JSON.stringify([{ id: 'original', name: 'ของเดิม', price: 40, image: 'images/old.png' }]))], ['faq.json', Buffer.from('[{"question":"เดิม","answer":"คงไว้"}]')], ['images/old.png', Buffer.from('synthetic-image-bytes')]]);
const config = b => ({ businessId: biz.businessId, businessName: biz.businessName, consoleOrigin: 'https://shop.example.com', consoleUsername: 'owner', cardIds: b.cards.map(c => c.id), products: [] });
function snapshotOf(plan) {
  return { system: 'ai-admin-console', origin: plan.destination.origin, username: plan.destination.username, branding: { businessName: biz.businessName },
    knowledge: plan.expected.map((e, i) => ({ id: 'row-' + i, title: e.title, content: e.content, active: 1, channel_id: null })), prices: plan.expectedPrices,
    runtime: { droppedEntries: 0, injectedChars: 100 } };
}

test('starter staging preserves original products, images, FAQ and identity byte-for-byte', () => {
  const b = bundle(), original = packFiles(), out = makeStarterPlan(b, original, config(b));
  for (const [path, data] of original) assert.ok(out.files.get(path).equals(data));
  assert.equal(out.plan.changes.length, 1); assert.equal(out.plan.state, 'staged_not_imported');
});
test('repeat sync is idempotent; an edited destination note is not overwritten', () => {
  const b = bundle(), first = makeStarterPlan(b, packFiles(), config(b));
  const second = makeStarterPlan(b, first.files, config(b)); assert.equal(second.plan.changes.length, 0);
  const path = first.plan.expected[0].file; first.files.set(path, Buffer.from('# เก็บสินค้า\n\nผู้ใช้แก้เอง\n'));
  assert.throws(() => makeStarterPlan(b, first.files, config(b)), /destination_note_edited/);
});
test('price needs explicit product approval AND expiry limitation acceptance', () => {
  const b = bundle([{ ...card, kind: 'price', title: 'ชา', content: 'ชา 65 บาท', validUntil: '2099-12-31' }]), c = config(b);
  assert.throws(() => makeStarterPlan(b, packFiles(), c), /no_auto_expiry/);
  c.acceptManualExpiry = true;
  assert.throws(() => makeStarterPlan(b, packFiles(), c), /approved_product_mapping/);
  c.products = [{ cardId: b.cards[0].id, id: 'tea', name: 'ชา', price: 65, confirmed: true }];
  const out = makeStarterPlan(b, packFiles(), c);
  assert.deepEqual(out.plan.expectedPrices, [{ label: 'ชา', amount: 65 }]);
  assert.equal(JSON.parse(out.files.get('products.json')).length, 2);
  assert.equal(out.plan.manualExpiry.length, 1);
});
test('existing product and image are preserved unless exact replacement is approved', () => {
  const b = bundle([{ ...card, kind: 'price', content: 'ของเดิมราคา 55 บาท', validUntil: '2099-12-31' }]), c = { ...config(b), acceptManualExpiry: true,
    products: [{ cardId: b.cards[0].id, id: 'original', name: 'ของเดิม', price: 55, confirmed: true }] };
  assert.throws(() => makeStarterPlan(b, packFiles(), c), /existing_product_change/);
  const out = makeStarterPlan(b, packFiles(), { ...c, replaceProducts: ['original'] });
  assert.equal(JSON.parse(out.files.get('products.json'))[0].image, 'images/old.png');
});
test('an approved mapping cannot introduce a different numeric price from the source card', () => {
  const b = bundle([{ ...card, kind: 'price', content: 'ชา 65 บาท', validUntil: '2099-12-31' }]);
  const c = { ...config(b), acceptManualExpiry: true, products: [{ cardId: b.cards[0].id, id: 'tea', name: 'ชา', price: 75, confirmed: true }] };
  assert.throws(() => makeStarterPlan(b, packFiles(), c), /not_in_source/);
});
test('wrong business, nonselected price map, path escape and same-title collision are blocked', () => {
  const b = bundle(), c = config(b);
  assert.throws(() => makeStarterPlan(b, packFiles(), { ...c, businessId: 'other' }), /business_mismatch/);
  assert.throws(() => makeStarterPlan(b, packFiles(), { ...c, products: [{ cardId: 'not-selected' }] }), /outside_selected/);
  assert.throws(() => makeStarterPlan(b, packFiles(), { ...c, files: { [b.cards[0].id]: '../secrets.md' } }), /note_path/);
  const files = packFiles(); files.set('knowledge/old.md', Buffer.from('# เก็บสินค้า\n\nของเก่า'));
  assert.throws(() => makeStarterPlan(b, files, c), /same_title_elsewhere/);
});
test('two source cards cannot collide on one starter title or output file', () => {
  const duplicate = bundle([card, { ...card, kind: 'policy' }]);
  assert.throws(() => makeStarterPlan(duplicate, packFiles(), config(duplicate)), /collide/);
  const b = bundle([card, { ...card, title: 'อีกหัวข้อ' }]);
  const files = Object.fromEntries(b.cards.map(c => [c.id, 'knowledge/same.md']));
  assert.throws(() => makeStarterPlan(b, packFiles(), { ...config(b), files }), /collide/);
});
test('only selected active console rows in exact channel can cross; global prices are explicit', () => {
  const s = { system: 'ai-admin-console', origin: 'https://shop.example.com', username: 'owner', knowledge: [
    { id: 'a', title: card.title, content: card.content, channel_id: null, active: 1 },
    { id: 'b', title: 'private branch', content: 'other', channel_id: 'branch', active: 1 },
    { id: 'c', title: 'inactive', content: 'old', channel_id: null, active: 0 }], prices: [{ label: 'ชา', amount: 65 }] };
  const spec = { origin: s.origin, username: 'owner', label: 'ร้าน', channelId: null, rows: [{ ...card, id: 'a' }], prices: [] };
  assert.equal(consoleBundle(s, spec).cards.length, 1);
  for (const id of ['b', 'c']) assert.throws(() => consoleBundle(s, { ...spec, rows: [{ ...card, id }] }), /not_active_in_selected_scope/);
  assert.throws(() => consoleBundle(s, { ...spec, channelId: 'branch', rows: [], prices: [{ label: 'ชา' }] }), /global/);
});
test('Nongkao -> starter -> Nongkao round trip preserves exact content and metadata, without repeating footer', () => {
  const b = bundle(), stage = makeStarterPlan(b, packFiles(), config(b)), s = snapshotOf(stage.plan);
  const returned = consoleBundle(s, { origin: s.origin, username: s.username, channelId: null, label: 'ร้าน',
    rows: [{ id: s.knowledge[0].id }], prices: [], preserved: Object.values(JSON.parse(stage.files.get('brain-bridge-index.json')).entries) });
  const input = toNongkao(returned, { cardIds: returned.cards.map(c => c.id), target: { shopName: 'ปลายทาง' } });
  assert.deepEqual(input.cards, [card]); assert.deepEqual(input.metadata, {});
});
test('changed source text cannot reuse old metadata silently', () => {
  const b = bundle(), stage = makeStarterPlan(b, packFiles(), config(b)), s = snapshotOf(stage.plan);
  s.knowledge[0].content = 'changed';
  assert.throws(() => consoleBundle(s, { origin: s.origin, username: s.username, channelId: null, label: 'ร้าน', rows: [{ id: 'row-0' }], prices: [], preserved: stage.plan.expected }), /invalid_card_kind/);
});
test('tampered bundles and expired source knowledge cannot be imported', () => {
  const b = bundle(); b.cards[0].content = 'tamper';
  assert.throws(() => toNongkao(b, config(b)), /artifact_changed/);
  const expired = bundle([{ ...card, validUntil: '2020-01-01' }]);
  assert.throws(() => toNongkao(expired, config(expired)), /source_checks_failed/);
});
test('readback checks active content, approved prices, target and runtime truncation', () => {
  const b = bundle(), p = makeStarterPlan(b, packFiles(), config(b)).plan;
  assert.equal(verifyStarterSnapshot(snapshotOf(p), p).state, 'starter_store_readback_verified');
  for (const change of [s => s.knowledge[0].active = 0, s => s.knowledge[0].content = 'bad', s => s.branding.businessName = 'other', s => s.runtime.droppedEntries = 1]) {
    const s = snapshotOf(p); change(s); assert.throws(() => verifyStarterSnapshot(s, p));
  }
});
test('staging and commit require unchanged files and readback receipt; backup survives', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  try {
    const starter = join(tmp, 'starter'), business = join(starter, 'business'), stage = join(tmp, 'stage');
    await mkdir(business, { recursive: true }); await mkdir(join(starter, 'starter'));
    await writeFile(join(starter, 'starter/.state.json'), JSON.stringify({ host: 'shop.example.com', ip: '192.0.2.1' }));
    for (const [path, data] of packFiles()) { await mkdir(join(business, path.includes('/') ? path.split('/')[0] : ''), { recursive: true }); await writeFile(join(business, path), data); }
    const b = bundle(), p = await stageStarter(b, business, config(b), stage);
    assert.equal((await checkStarter(stage, starter)).state, 'local_target_and_pack_verified_not_imported');
    const receipt = verifyStarterSnapshot(snapshotOf(p), p);
    await assert.rejects(commitStarter(stage, business, { ...receipt, state: 'pretend' }), /artifact_changed/);
    const result = await commitStarter(stage, business, receipt);
    assert.equal((await readFile(join(result.backup, 'business.json'), 'utf8')), JSON.stringify(biz));
    await assert.rejects(checkStarter(stage, starter), /local_pack_changed/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('inventory rejects symlinks and unrecognized private files', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  try { await symlink('/etc/hosts', join(tmp, 'business.json')); await assert.rejects(inventory(tmp), /symlink/); }
  finally { await rm(tmp, { recursive: true, force: true }); }
});
test('console origin/transport is locked to explicit HTTPS destination and read paths', async () => {
  assert.equal(consoleOrigin('https://shop.example.com/console'), 'https://shop.example.com');
  assert.throws(() => consoleOrigin('http://shop.example.com'), /https/);
  assert.throws(() => consoleOrigin('https://user:pass@shop.example.com'), /invalid/);
  let calls = 0;
  const api = consoleClient({ origin: 'https://shop.example.com', cookie: 'secret', fetchImpl: async (url, options) => {
    calls++; assert.equal(options.redirect, 'error'); return { ok: true, json: async () => ({ ok: true }) };
  } });
  await api('/me'); await assert.rejects(api('/customers'), /not_allowed/); assert.equal(calls, 1);
});
test('console snapshot refuses wrong actor and changed knowledge during capture', async () => {
  const api = async p => p === '/me' ? { operator: { username: 'other' } } : {};
  await assert.rejects(consoleSnapshot(api, { username: 'owner' }), /actor_changed/);
  let reads = 0;
  const changing = async p => p === '/me' ? { operator: { username: 'owner' } } : p === '/knowledge' ? { knowledge: [{ id: ++reads }] } : p === '/prices' ? { prices: [] } : { knowledge: {} };
  await assert.rejects(consoleSnapshot(changing, { username: 'owner' }), /changed_during_export/);
});
test('console export strips auth, operator directory, persona and knowledge provenance', async () => {
  const api = async p => p === '/me' ? { operator: { username: 'owner' }, csrf: 'private', operators: [{ username: 'another' }], branding: { businessName: 'ร้าน', ownerName: 'private-owner' } }
    : p === '/knowledge' ? { knowledge: [{ id: 'a', title: 'หัวข้อ', content: 'ข้อเท็จจริง', active: 1, provenance_json: '{"customer":"private"}' }] }
      : p === '/prices' ? { prices: [] } : { knowledge: { droppedEntries: 0 }, persona: 'private-persona' };
  const out = await consoleSnapshot(api, { origin: 'https://shop.example.com', username: 'owner' });
  assert.ok(!JSON.stringify(out).includes('private')); assert.ok(!JSON.stringify(out).includes('another'));
});
test('CLI entrypoints run through symlink paths instead of silently exiting', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
  try {
    const source = fileURLToPath(new URL('..', import.meta.url)), linked = join(tmp, 'linked-skill');
    await symlink(source, linked, 'dir');
    const syncHelp = execFileSync(process.execPath, [join(linked, 'scripts/sync.mjs'), 'help'], { encoding: 'utf8', timeout: 10000 });
    const bridgeHelp = execFileSync(process.execPath, [join(linked, 'scripts/bridge.mjs'), 'help'], { encoding: 'utf8', timeout: 10000 });
    const installHelp = execFileSync(process.execPath, [join(linked, 'install.mjs')], { encoding: 'utf8', timeout: 10000 });
    assert.match(syncHelp, /Nongkao Knowledge Sync/); assert.match(bridgeHelp, /stage-starter/); assert.match(installHelp, /node install.mjs/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
