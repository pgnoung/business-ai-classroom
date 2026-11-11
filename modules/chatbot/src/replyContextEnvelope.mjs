// Source boundaries for v3 context. Shadow model/detector facts are deliberately
// not promoted: their first-write-wins storage can contain stale inferences.
const HUMAN_FACT_LABELS = Object.freeze({
  ai_level: 'ระดับ AI ที่ทีมงานยืนยัน', headcount: 'จำนวนผู้เรียนที่ทีมงานยืนยัน',
  business_context: 'บริบทธุรกิจ', goal_pain: 'เป้าหมายและโจทย์งาน',
  decision_role: 'บทบาทในการตัดสินใจ', company_name: 'บริษัท',
  recommended_product: 'คลาสที่ทีมงานเคยแนะนำ', chosen_round: 'รอบที่ทีมงานบันทึกไว้',
  concern: 'ข้อกังวลที่แจ้งไว้', budget_timeframe: 'ข้อจำกัดเรื่องงบและเวลา',
});

const COURSE_KEYS = new Set(['business', 'workflow']);
const OFFER_TYPES = new Set(['registration', 'rounds', 'review', 'content', 'class', 'other']);

// Caller supplies current-session rows in chronological order. Do not search
// past a human/legacy/newer reply to resurrect an older AI promise.
export function latestCommittedReplyMeta(rows = []) {
  const latest = (Array.isArray(rows) ? rows : []).findLast(row => row?.direction === 'out');
  if (!latest || latest.agent_mode !== 'ai' || (latest.operator && latest.operator !== 'system')) return null;
  try {
    const meta = JSON.parse(latest.metadata_json || '{}').replyEngine;
    const continuity = meta?.contextContinuity;
    if (meta?.engine !== 'v3' || continuity?.schema !== 1 || continuity.committed !== true || continuity.deliveryComplete !== true) return null;
    return { ...meta, contextContinuity: { ...continuity, sourceOutboundId: String(latest.id || '') } };
  } catch { return null; }
}

// Older delivered rows have no continuity receipt. Permit only a narrow
// informational-offer bootstrap from the latest actual AI reply, never past a
// human response or an explicitly partial/provider-down v3 delivery.
export function legacyOfferBootstrapAllowed(rows = []) {
  const latest = (Array.isArray(rows) ? rows : []).findLast(row => row?.direction === 'out');
  if (!latest || latest.agent_mode !== 'ai' || latest.message_class === 'proactive'
    || (latest.operator && latest.operator !== 'system')) return false;
  try {
    const meta = JSON.parse(latest.metadata_json || '{}').replyEngine;
    return meta?.providerDown !== true && (!meta || !Object.hasOwn(meta, 'contextContinuity'));
  } catch { return false; }
}

export function buildReplyContextEnvelope({ persona = '', knowledgeEntries = [], brainVersionId = '',
  customerFacts = [], legacyIdentityUnverified = false, previousReplyMeta = null,
  legacyOfferBootstrapAllowed: bootstrapAllowed = false } = {}) {
  const durableFacts = legacyIdentityUnverified ? [] : (Array.isArray(customerFacts) ? customerFacts : [])
    .filter(fact => fact?.source === 'human' && Object.hasOwn(HUMAN_FACT_LABELS, fact.fact_key))
    .filter(fact => String(fact.value || '').trim())
    .map(fact => ({ key: fact.fact_key, label: HUMAN_FACT_LABELS[fact.fact_key],
      value: String(fact.value).slice(0, 500), source: 'human', confidence: 'confirmed',
      ...(Number.isFinite(Number(fact.updated_at)) ? { updatedAt: Number(fact.updated_at) } : {}),
    }));
  const continuity = previousReplyMeta?.contextContinuity;
  const trusted = continuity?.schema === 1 && continuity.committed === true && continuity.deliveryComplete === true;
  const offer = trusted && continuity.pendingOffer;
  return {
    personaText: String(persona || ''),
    businessKnowledgeEntries: Array.isArray(knowledgeEntries) ? knowledgeEntries : [],
    legacyOfferBootstrapAllowed: !legacyIdentityUnverified && bootstrapAllowed === true,
    durableFacts,
    ...(trusted && continuity.activeCourseSource === 'customer' && COURSE_KEYS.has(continuity.activeCourse)
      ? { activeCourse: { key: continuity.activeCourse, source: 'deterministic', confidence: 'verified' } } : {}),
    ...(offer?.status === 'pending' && OFFER_TYPES.has(offer.type) ? { pendingOffer: {
      type: offer.type, status: 'pending', source: 'deterministic', confidence: 'verified',
      ...(COURSE_KEYS.has(offer.courseKey) ? { courseKey: offer.courseKey } : {}),
      ...(offer.roundLabel ? { roundLabel: String(offer.roundLabel).slice(0, 160) } : {}),
      sourceOutboundId: String(continuity.sourceOutboundId || ''), sourceInboundId: String(continuity.sourceInboundId || ''),
    } } : {}),
    provenance: { approved: true, brainVersionId: String(brainVersionId || ''),
      sources: [brainVersionId ? 'approved_brain_version' : 'active_channel_knowledge', 'human_confirmed_customer_facts'], conflicts: [] },
  };
}

/** A saved name/preset/source id alone is not proof of assessed buying intent. */
export function hasVerifiedPriorAssessment(row, session) {
  if (!row || !session || !Number.isFinite(Number(row.created_at))
    || !Number.isFinite(Number(session.created_at)) || Number(row.created_at) < Number(session.created_at)) return false;
  try {
    const assessment = JSON.parse(row.payload_json || '{}').score_assessment;
    if (assessment?.status !== 'assessed' || !session.id || assessment.session_id !== session.id
      || typeof assessment.source_inbound_id !== 'string' || !assessment.source_inbound_id.trim()) return false;
    const sourced = Array.isArray(assessment.source_message_ids) && assessment.source_message_ids.some(id => typeof id === 'string' && id.trim());
    return Boolean((sourced && (Number(assessment.typed_customer_count) > 0 || Number(assessment.human_text_count) > 0))
      || Number(assessment.human_note_count) > 0);
  } catch { return false; }
}
