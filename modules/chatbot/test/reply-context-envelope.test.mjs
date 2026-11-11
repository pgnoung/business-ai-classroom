import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyContextEnvelope, hasVerifiedPriorAssessment, latestCommittedReplyMeta, legacyOfferBootstrapAllowed } from '../src/replyContextEnvelope.mjs';

test('durable reply context promotes only human-confirmed non-sensitive facts', () => {
  const result = buildReplyContextEnvelope({ brainVersionId: 'test-brain', persona: 'voice', knowledgeEntries: [{ title: 'trial', content: 'available' }],
    customerFacts: [
      { fact_key: 'business_context', value: 'โรงงาน', source: 'human', evidence: 'ทีมงานโทรยืนยัน' },
      { fact_key: 'ai_level', value: '5', source: 'scorer' },
      { fact_key: 'chosen_round', value: '12 ต.ค.', source: 'deterministic' },
      { fact_key: 'contact_phone', value: 'synthetic-private-phone', source: 'human' },
    ] });
  assert.deepEqual(result.durableFacts.map(f => f.key), ['business_context']);
  assert.equal(result.durableFacts[0].confidence, 'confirmed');
  assert.equal(result.businessKnowledgeEntries[0].content, 'available');
  assert.equal(result.provenance.brainVersionId, 'test-brain');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-phone/);
});

test('unverified legacy identity receives no cross-session customer facts', () => {
  const result = buildReplyContextEnvelope({ legacyIdentityUnverified: true,
    customerFacts: [{ fact_key: 'business_context', value: 'historical company', source: 'human' }] });
  assert.deepEqual(result.durableFacts, []);
});

test('a name, timestamp, or preset source IDs do not become prior buying evidence', () => {
  for (const assessment of [null, {}, { status: 'assessed', source_message_ids: ['preset'], preset_count: 1 },
    { status: 'insufficient_evidence', source_message_ids: ['x'], typed_customer_count: 1 }]) {
    assert.equal(hasVerifiedPriorAssessment({ payload_json: JSON.stringify({ score_assessment: assessment }), created_at: 20 }, { created_at: 10 }), false);
  }
});

test('verified prior assessment needs source evidence and belongs to the active session', () => {
  const row = { created_at: 20, payload_json: JSON.stringify({ score_assessment: {
    status: 'assessed', typed_customer_count: 2, source_message_ids: ['synthetic-inbound'],
    session_id: 'synthetic-session', source_inbound_id: 'synthetic-inbound',
  } }) };
  assert.equal(hasVerifiedPriorAssessment(row, { id: 'synthetic-session', created_at: 10 }), true);
  assert.equal(hasVerifiedPriorAssessment(row, { id: 'synthetic-session', created_at: 30 }), false);
  assert.equal(hasVerifiedPriorAssessment(row, { id: 'other-session', created_at: 10 }), false);
  assert.equal(hasVerifiedPriorAssessment({ ...row, payload_json: 'bad-json' }, { id: 'synthetic-session', created_at: 10 }), false);
});

test('only latest committed complete AI outbound can carry a pending offer', () => {
  const meta = { engine: 'v3', contextContinuity: { schema: 1, committed: true, deliveryComplete: true,
    activeCourse: 'workflow', pendingOffer: { type: 'rounds', status: 'pending', courseKey: 'workflow' } } };
  const row = { id: 'synthetic-out', direction: 'out', agent_mode: 'ai', metadata_json: JSON.stringify({ replyEngine: meta }) };
  const restored = latestCommittedReplyMeta([row, { direction: 'in', content: 'ขอดูค่ะ' }]);
  assert.equal(restored.contextContinuity.sourceOutboundId, 'synthetic-out');
  const envelope = buildReplyContextEnvelope({ previousReplyMeta: restored });
  assert.equal(envelope.pendingOffer.type, 'rounds');
  assert.equal(envelope.pendingOffer.source, 'deterministic');
  assert.equal(latestCommittedReplyMeta([row, { direction: 'out', operator: 'team', content: 'เปลี่ยนข้อตกลงแล้ว' }]), null);
  assert.equal(latestCommittedReplyMeta([{ ...row, metadata_json: JSON.stringify({ replyEngine: { ...meta,
    contextContinuity: { ...meta.contextContinuity, deliveryComplete: false } } }) }]), null);
  assert.equal(latestCommittedReplyMeta([{ ...row, metadata_json: '{}' }]), null);
});

test('legacy informational offers bootstrap only from the latest delivered AI boundary', () => {
  const old = { direction: 'out', agent_mode: 'ai', operator: 'system', metadata_json: JSON.stringify({ replyEngine: { engine: 'v3', promptVersion: 'v3.7' } }) };
  assert.equal(legacyOfferBootstrapAllowed([old]), true);
  assert.equal(legacyOfferBootstrapAllowed([{ ...old, metadata_json: '{}' }]), true);
  for (const row of [
    { ...old, agent_mode: 'human' },
    { ...old, message_class: 'proactive' },
    { ...old, operator: 'team' },
    { ...old, metadata_json: 'bad-json' },
    { ...old, metadata_json: JSON.stringify({ replyEngine: { engine: 'v3', providerDown: true } }) },
    { ...old, metadata_json: JSON.stringify({ replyEngine: { engine: 'v3', contextContinuity: { schema: 1, committed: false, deliveryComplete: false } } }) },
    { ...old, metadata_json: JSON.stringify({ replyEngine: { engine: 'v3', contextContinuity: { schema: 1, committed: true, deliveryComplete: true } } }) },
  ]) assert.equal(legacyOfferBootstrapAllowed([old, row]), false);
  assert.equal(buildReplyContextEnvelope({ legacyOfferBootstrapAllowed: true }).legacyOfferBootstrapAllowed, true);
  assert.equal(buildReplyContextEnvelope({ legacyOfferBootstrapAllowed: true, legacyIdentityUnverified: true }).legacyOfferBootstrapAllowed, false);
});
