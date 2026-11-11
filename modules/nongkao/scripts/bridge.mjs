#!/usr/bin/env node
// Portable business-fact bridge. Never writes directly to a running AI Admin database.
import { readFile, readdir, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, sessionToken, exportNongkao, digest, normalize, issues, privateWrite } from './sync.mjs';
import { consoleOrigin, loadConsoleSession, consoleClient, consoleSnapshot } from './console.mjs';

const stop = message => { throw new Error(message); };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const cardKey = c => digest([c.kind, c.tag ?? '', c.title]);
const INDEX = 'brain-bridge-index.json', PLAN = '.brain-bridge-plan.json';
function seal(data) { return { ...data, hash: digest(data) }; }
function unseal(value) { const { hash, ...data } = value; if (digest(data) !== hash) stop('bridge_artifact_changed'); return data; }
function normalizeCards(cards) {
  return normalize({ businessName: 'bridge', assistantName: '', tone: '', businessType: 'other', cards }).cards;
}
export function nongkaoBundle(snapshot) {
  return seal({ schema: 1, origin: { system: 'nongkao', id: digest([snapshot.target.accountId, snapshot.target.platform, snapshot.target.oaId]),
    label: snapshot.target.shopName, revision: snapshot.revision, activeVersion: snapshot.activeVersion },
    cards: snapshot.draft.cards.map(c => ({ ...c, id: cardKey(c) })) });
}
export function consoleBundle(snapshot, spec) {
  if (snapshot.system !== 'ai-admin-console' || snapshot.origin !== spec.origin || snapshot.username !== spec.username) stop('console_source_mismatch');
  if (!Object.hasOwn(spec, 'channelId') || !(spec.channelId === null || typeof spec.channelId === 'string')) stop('explicit_channel_scope_required');
  if (!Array.isArray(spec.rows) || !Array.isArray(spec.prices)) stop('explicit_source_selection_required');
  const cards = [], ids = new Set();
  for (const selected of spec.rows) {
    const row = snapshot.knowledge.find(r => r.id === selected.id);
    if (!row || row.active !== 1 || (row.channel_id ?? null) !== spec.channelId) stop('source_row_not_active_in_selected_scope');
    if (ids.has(row.id)) stop('duplicate_source_selection'); ids.add(row.id);
    // Optional local index restores exact kind/tag/source/date on a round trip. Match full content, never title alone.
    const preserved = spec.preserved?.find(x => x.title === row.title && x.content === row.content);
    const c = preserved ? { ...preserved.card } : { kind: selected.kind, tag: selected.tag ?? '', title: row.title, content: row.content,
      source: selected.source, reviewedOn: selected.reviewedOn, validUntil: selected.validUntil ?? '' };
    cards.push({ ...normalizeCards([c])[0], id: preserved?.card?.id ?? digest(['row', row.id]) });
  }
  if (spec.prices.length && spec.channelId !== null) stop('prices_are_global_require_explicit_central_scope');
  for (const selected of spec.prices) {
    const row = snapshot.prices.find(r => r.label === selected.label);
    if (!row || !Number.isFinite(row.amount) || row.amount <= 0) stop('selected_price_missing');
    const c = normalizeCards([{ kind: 'price', tag: selected.tag ?? '', title: selected.title ?? row.label,
      content: `${row.label}: ${row.amount} บาท`, source: selected.source, reviewedOn: selected.reviewedOn, validUntil: selected.validUntil ?? '' }])[0];
    cards.push({ ...c, id: digest(['price', row.label]) });
  }
  if (!cards.length) stop('nothing_selected');
  return seal({ schema: 1, origin: { system: 'ai-admin', id: digest([snapshot.origin, spec.channelId]), label: spec.label,
    snapshotHash: digest(snapshot) }, cards });
}
function selectedCards(bundle, config) {
  const b = unseal(bundle);
  if (b.schema !== 1 || !b.origin?.id || !Array.isArray(b.cards)) stop('bridge_schema_invalid');
  if (!Array.isArray(config.cardIds) || !config.cardIds.length || new Set(config.cardIds).size !== config.cardIds.length) stop('explicit_card_selection_required');
  const cards = config.cardIds.map(id => b.cards.find(c => c.id === id) ?? stop('source_card_missing'));
  for (const c of cards) {
    const errors = issues({ businessName: 'bridge', cards: normalizeCards([c]) });
    if (errors.length) stop('source_checks_failed:' + errors.join(','));
  }
  return { b, cards };
}
export function toNongkao(bundle, config) {
  const { cards } = selectedCards(bundle, config);
  const unique = new Set(cards.map(cardKey));
  if (unique.size !== cards.length) stop('duplicate_target_card_key');
  // Identity, assistant and tone always stay at destination unless the learner explicitly edits metadata.
  return { target: config.target, metadata: config.metadata ?? {}, cards: normalizeCards(cards),
    replace: config.replace ?? [], includeExistingDraft: config.includeExistingDraft === true };
}

export async function inventory(dir, { staged = false } = {}) {
  dir = resolve(dir); const root = await lstat(dir);
  if (!root.isDirectory() || root.isSymbolicLink()) stop('pack_must_be_real_directory');
  const files = new Map(); let size = 0;
  async function walk(path, rel = '') {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      const name = rel ? rel + '/' + entry.name : entry.name;
      if (!rel && staged && name === PLAN) continue;
      const st = await lstat(join(path, entry.name));
      if (st.isSymbolicLink()) stop('pack_symlink_forbidden');
      if (st.isDirectory()) {
        if (!['knowledge', 'images'].includes(name)) stop('pack_directory_not_supported');
        await walk(join(path, entry.name), name); continue;
      }
      if (!st.isFile() || !(/^(business|products|faq)\.json$/.test(name) || name === INDEX || /^knowledge\/[^/]+\.md$/.test(name) || /^images\/[^/]+\.(jpg|jpeg|png|webp)$/i.test(name))) stop('pack_file_not_supported');
      size += st.size; if (size > 150_000_000) stop('pack_too_large');
      files.set(name, await readFile(join(path, entry.name)));
    }
  }
  await walk(dir);
  if (!files.has('business.json') || !files.has('products.json')) stop('existing_business_pack_required');
  return files;
}
export const inventoryHash = files => digest([...files].map(([name, data]) => [name, digest(data.toString('base64'))]).sort(([a], [b]) => a.localeCompare(b)));
const parsed = (files, name, fallback) => files.has(name) ? JSON.parse(files.get(name).toString('utf8')) : fallback;
function note(text) {
  const lines = text.toString('utf8').replace(/\r\n?/g, '\n').split('\n'), i = lines.findIndex(x => /^# \S/.test(x));
  return i < 0 ? null : { title: lines[i].slice(2).trim(), content: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').trim() };
}
function rendered(c) {
  return c.content + `\n\nแหล่งข้อมูล: ${c.source}\nตรวจเมื่อ: ${c.reviewedOn}` + (c.validUntil ? `\nใช้ได้ถึง: ${c.validUntil} (ต้องทบทวนหรือปิดรายการเมื่อถึงกำหนด)` : '');
}
export function makeStarterPlan(bundle, files, config) {
  const { b, cards } = selectedCards(bundle, config);
  const business = parsed(files, 'business.json'), products = parsed(files, 'products.json');
  if (!business?.businessId || config.businessId !== business.businessId || config.businessName !== business.businessName || !Array.isArray(products)) stop('destination_business_mismatch');
  if (!config.consoleOrigin || !config.consoleUsername) stop('destination_console_identity_required');
  consoleOrigin(config.consoleOrigin);
  const previous = parsed(files, INDEX, { schema: 1, entries: {} });
  if (previous.schema !== 1 || !previous.entries) stop('bridge_index_invalid');
  const index = structuredClone(previous), after = new Map(files), expected = [], changes = [];
  const manualExpiry = cards.filter(c => c.validUntil).map(c => c.id);
  if (manualExpiry.length && config.acceptManualExpiry !== true) stop('destination_has_no_auto_expiry_confirmation_required');
  const mappings = config.products ?? [];
  if (mappings.some(p => !cards.some(c => c.id === p.cardId && c.kind === 'price'))) stop('price_mapping_outside_selected_price_cards');
  const mappedIds = new Set(), usedFiles = new Set(), usedTitles = new Set();
  for (const c of cards) {
    const managedId = digest([b.origin.id, c.id]);
    const prior = previous.entries[managedId];
    const file = config.files?.[c.id] ?? prior?.file ?? `knowledge/bridge-${managedId.slice(0, 20)}.md`;
    if (!/^knowledge\/[^/]+\.md$/.test(file)) stop('invalid_target_note_path');
    if (/[\r\n]/.test(c.title)) stop('note_title_must_be_single_line');
    if (usedFiles.has(file) || usedTitles.has(c.title)) stop('selected_cards_collide_in_starter');
    usedFiles.add(file); usedTitles.add(c.title);
    const content = rendered(c), text = `# ${c.title}\n\n${content}\n`;
    const old = files.get(file)?.toString('utf8');
    if (old !== undefined && old !== text && (!prior || digest(old) !== prior.fileHash) && !(config.replaceFiles ?? []).includes(file)) stop('destination_note_edited_review_required');
    for (const [other, data] of files) {
      if (!other.startsWith('knowledge/') || other === file) continue;
      if (note(data)?.title === c.title) stop('same_title_elsewhere_choose_existing_file');
    }
    if (old !== text) { after.set(file, Buffer.from(text)); changes.push({ action: old === undefined ? 'add_note' : 'update_note', file, title: c.title }); }
    expected.push({ title: c.title, content, card: c, file });
    index.entries[managedId] = { file, fileHash: digest(text), title: c.title, content, card: c };
    if (c.kind === 'price' && !mappings.some(p => p.cardId === c.id)) stop('price_card_needs_approved_product_mapping');
  }
  const updated = structuredClone(products), expectedPrices = [];
  for (const p of mappings) {
    if (mappedIds.has(p.id)) stop('duplicate_product_mapping'); mappedIds.add(p.id);
    if (p.confirmed !== true || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(p.id ?? '') || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100 || !Number.isFinite(p.price) || p.price <= 0 || p.price > 10_000_000) stop('approved_price_mapping_invalid');
    const sourceCard = cards.find(c => c.id === p.cardId);
    const numericFacts = (sourceCard.content.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
    if (Number(p.price.toFixed(2)) !== p.price || !numericFacts.includes(p.price)) stop('approved_price_not_in_source_card');
    const existing = updated.findIndex(x => x.id === p.id);
    if (updated.some(x => x.id !== p.id && x.name?.trim().toLowerCase() === p.name.trim().toLowerCase())) stop('product_name_already_exists_use_existing_id');
    const next = { ...(existing >= 0 ? updated[existing] : {}), id: p.id, name: p.name.trim(), price: p.price, active: true };
    for (const k of ['unit', 'description', 'category']) if (Object.hasOwn(p, k)) next[k] = p[k];
    if (existing >= 0 && digest(updated[existing]) !== digest(next) && !(config.replaceProducts ?? []).includes(p.id)) stop('existing_product_change_requires_confirmation');
    if (existing < 0) updated.push(next); else updated[existing] = next;
    if (existing < 0 || digest(products[existing]) !== digest(next)) changes.push({ action: existing < 0 ? 'add_product' : 'update_product', id: p.id, name: next.name, price: p.price });
    expectedPrices.push({ label: next.name, amount: next.price });
  }
  if (digest(updated) !== digest(products)) after.set('products.json', Buffer.from(JSON.stringify(updated, null, 2) + '\n'));
  if (digest(index) !== digest(previous)) after.set(INDEX, Buffer.from(JSON.stringify(index, null, 2) + '\n'));
  const plan = seal({ schema: 1, source: b.origin, bundleHash: bundle.hash, baseHash: inventoryHash(files), stagedHash: inventoryHash(after),
    destination: { businessId: business.businessId, businessName: business.businessName, origin: consoleOrigin(config.consoleOrigin), username: config.consoleUsername },
    expected, expectedPrices, changes, manualExpiry, preservedFileCount: files.size,
    state: 'staged_not_imported' });
  return { files: after, plan };
}
export async function stageStarter(bundle, businessDir, config, out) {
  businessDir = resolve(businessDir); out = resolve(out);
  if (out === businessDir || !relative(businessDir, out).startsWith('..') || !relative(out, businessDir).startsWith('..')) stop('staging_must_be_separate');
  const result = makeStarterPlan(bundle, await inventory(businessDir), config);
  await mkdir(out, { mode: 0o700 });
  for (const [name, data] of result.files) { await mkdir(dirname(join(out, name)), { recursive: true, mode: 0o700 }); await writeFile(join(out, name), data, { mode: 0o600, flag: 'wx' }); }
  await privateWrite(join(out, PLAN), result.plan);
  return result.plan;
}
export async function checkStarter(stagedDir, starterDir) {
  const plan = await json(join(stagedDir, PLAN)); unseal(plan);
  const state = await json(join(starterDir, 'starter/.state.json'));
  if (!state.host || `https://${state.host}` !== plan.destination.origin || !state.ip) stop('starter_vps_target_mismatch');
  const before = await inventory(join(starterDir, 'business')), after = await inventory(stagedDir, { staged: true });
  if (inventoryHash(before) !== plan.baseHash || inventoryHash(after) !== plan.stagedHash) stop('local_pack_changed_rebuild_required');
  return { state: 'local_target_and_pack_verified_not_imported', planHash: plan.hash, destination: plan.destination, changes: plan.changes, manualExpiry: plan.manualExpiry };
}
export function verifyStarterSnapshot(snapshot, plan) {
  unseal(plan);
  if (snapshot.origin !== plan.destination.origin || snapshot.username !== plan.destination.username || snapshot.branding?.businessName !== plan.destination.businessName) stop('readback_destination_mismatch');
  const missing = plan.expected.filter(e => !snapshot.knowledge.some(r => r.active === 1 && r.channel_id == null && r.title === e.title && r.content === e.content));
  if (missing.length || plan.expectedPrices.some(p => !snapshot.prices.some(q => q.label === p.label && q.amount === p.amount))) stop('starter_readback_missing_or_changed');
  if (!snapshot.runtime || snapshot.runtime.droppedEntries !== 0 || snapshot.runtime.injectedChars <= 0) stop('starter_runtime_knowledge_not_ready');
  return seal({ state: 'starter_store_readback_verified', planHash: plan.hash, destination: plan.destination,
    cards: plan.expected.length, prices: plan.expectedPrices.length, manualExpiry: plan.manualExpiry, snapshotHash: digest(snapshot) });
}
export async function commitStarter(stagedDir, businessDir, receipt) {
  const plan = await json(join(stagedDir, PLAN)); unseal(plan); unseal(receipt);
  if (receipt.state !== 'starter_store_readback_verified' || receipt.planHash !== plan.hash) stop('verified_import_receipt_required');
  const before = await inventory(businessDir), after = await inventory(stagedDir, { staged: true });
  if (inventoryHash(before) !== plan.baseHash || inventoryHash(after) !== plan.stagedHash) stop('local_pack_changed_reconcile_required');
  // No file removal. Keep a private preimage alongside the business folder before changing it.
  const backup = resolve(businessDir) + '.bridge-backup-' + plan.hash.slice(0, 12);
  await mkdir(backup, { mode: 0o700 });
  for (const [name, data] of before) { await mkdir(dirname(join(backup, name)), { recursive: true, mode: 0o700 }); await writeFile(join(backup, name), data, { mode: 0o600, flag: 'wx' }); }
  for (const [name, data] of after) {
    if (before.has(name) && before.get(name).equals(data)) continue;
    const dest = join(businessDir, name), tmp = dest + '.bridge-' + plan.hash.slice(0, 12);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 }); await writeFile(tmp, data, { mode: 0o600, flag: 'wx' }); await rename(tmp, dest);
  }
  if (inventoryHash(await inventory(businessDir)) !== plan.stagedHash) stop('local_commit_readback_failed');
  return { state: 'local_business_updated_after_provider_readback', backup };
}
async function main() {
  const [cmd, ...a] = process.argv.slice(2);
  if (!cmd || cmd === 'help') { console.log('bridge.mjs nongkao-export TARGET.json BUNDLE.json\n  console-snapshot ORIGIN SNAPSHOT.json\n  console-bundle SNAPSHOT.json SELECTION.json BUNDLE.json\n  to-nongkao BUNDLE.json CONFIG.json INPUT.json\n  stage-starter BUNDLE.json BUSINESS_DIR CONFIG.json NEW_STAGED_DIR\n  check-starter STAGED_DIR STARTER_DIR\n  verify-starter STAGED_DIR RECEIPT.json\n  commit-starter STAGED_DIR BUSINESS_DIR RECEIPT.json'); return; }
  const counts = { 'nongkao-export': 2, 'console-snapshot': 2, 'console-bundle': 3, 'to-nongkao': 3, 'stage-starter': 4, 'check-starter': 2, 'verify-starter': 2, 'commit-starter': 3 };
  if (counts[cmd] !== a.length) stop('bridge_usage_invalid');
  let result;
  if (cmd === 'nongkao-export') {
    const snapshot = await exportNongkao(client({ token: await sessionToken() }), await json(a[0]));
    result = nongkaoBundle(snapshot); await privateWrite(resolve(a[1]), result);
  } else if (cmd === 'console-snapshot') {
    const origin = consoleOrigin(a[0]), session = await loadConsoleSession(origin);
    result = await consoleSnapshot(consoleClient(session), session); await privateWrite(resolve(a[1]), result);
  } else if (cmd === 'console-bundle') { result = consoleBundle(await json(a[0]), await json(a[1])); await privateWrite(resolve(a[2]), result); }
  else if (cmd === 'to-nongkao') { result = toNongkao(await json(a[0]), await json(a[1])); await privateWrite(resolve(a[2]), result); }
  else if (cmd === 'stage-starter') result = await stageStarter(await json(a[0]), a[1], await json(a[2]), a[3]);
  else if (cmd === 'check-starter') result = await checkStarter(a[0], a[1]);
  else if (cmd === 'verify-starter') {
    const plan = await json(join(a[0], PLAN)); unseal(plan);
    if (inventoryHash(await inventory(a[0], { staged: true })) !== plan.stagedHash) stop('staged_pack_changed');
    const session = await loadConsoleSession(plan.destination.origin);
    result = verifyStarterSnapshot(await consoleSnapshot(consoleClient(session), session), plan); await privateWrite(resolve(a[1]), result);
  } else result = await commitStarter(a[0], a[1], await json(a[2]));
  console.log(JSON.stringify({ command: cmd, state: result.state ?? 'prepared_private_file', hash: result.hash, cards: Array.isArray(result.cards) ? result.cards.length : result.cards,
    changes: result.changes, manualExpiry: result.manualExpiry }));
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main().catch(e => { console.error(e instanceof SyntaxError ? 'invalid_json' : e.code ? `local_${e.code}` : e.message); process.exitCode = 1; });
