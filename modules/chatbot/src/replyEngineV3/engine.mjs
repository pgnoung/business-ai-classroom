// engine.mjs — เครื่องตอบแชท v3: ร่างหนึ่งครั้ง ตรวจด้วยโค้ด ซ่อมได้หนึ่งครั้ง ถอยไปเครื่องเดิมเฉพาะเนื้อหาผิดด่านแข็ง (spec v3.1 §A7/§F)
// งบเวลา: ไม่ซ่อมถ้าเกิน 15 วิ · ไม่ถอยไปเครื่องเดิมถ้าเกิน 30 วิ (ตัดประโยคที่ผิดแทน เหลือ < 40 ตัวอักษรค่อยถอย)
// สมองล่ม/หมดเวลาในยกแรก = null ทันทีเหมือนเดิม (เส้น "Hermes down" เดิม) — ไม่มีการรอสองต่อ
// redraft จากด่านของไปป์ไลน์ (ราคาก่อนบัญชี / คำแบน / Jev) = ยิงหนึ่งครั้งพร้อมข้อกำกับ ไม่ซ่อมเอง ไม่ถอยเอง
import { buildV3Messages, heldRoundLabels, instructionText, promptHash, V3_PROMPT_VERSION } from "./prompt.mjs";
import { followupStopOf, offerSentence, questionPolicy, stageTask } from "./stage.mjs";
import { bandFor } from "./stageTasks.mjs";
import { selectCards } from "./cards.mjs";
import { exemplarReply, pickExemplars, renderExemplars } from "./exemplars.mjs";
import { exemplarOwnText, finalizeDraft, repairNote, stripHard } from "./postCheck.mjs";
import { approvedTrialLink, hasAuthoritativeBusinessContext, normalizeContextEnvelope } from "./contextEnvelope.mjs";
import { STYLE_CARD_SHA, STYLE_CARD_VERSION } from "../replyStyle/styleCard.mjs";
import { renderStyleExamples, selectStyleExamples } from "../replyStyle/styleBank.mjs";
import { teacherBand, teacherPlan } from "./teacherTask.mjs";

export const V3_REPAIR_BUDGET_MS = 15_000;
export const V3_FALLBACK_BUDGET_MS = 30_000;
export const V3_MIN_STRIPPED_CHARS = 40;

const add = (a, b) => (a == null && b == null ? undefined : (Number(a) || 0) + (Number(b) || 0));

/** รวม usage ทุกยก (ยอดเดียวต่อเทิร์นใน llm_usage) — ทุกยกไม่มี usage = null */
export function sumUsage(items = []) {
  const list = items.map((item) => item?.usage).filter((usage) => usage && typeof usage === "object");
  if (!list.length) return null;
  return list.reduce((sum, usage) => {
    const out = {
      prompt_tokens: add(sum.prompt_tokens, usage.prompt_tokens),
      completion_tokens: add(sum.completion_tokens, usage.completion_tokens),
      total_tokens: add(sum.total_tokens, usage.total_tokens),
    };
    const cached = add(sum.prompt_tokens_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens);
    const written = add(sum.prompt_tokens_details?.cache_write_tokens, usage.prompt_tokens_details?.cache_write_tokens);
    const reasoning = add(sum.completion_tokens_details?.reasoning_tokens, usage.completion_tokens_details?.reasoning_tokens);
    if (cached !== undefined || written !== undefined) {
      out.prompt_tokens_details = { ...(cached !== undefined ? { cached_tokens: cached } : {}), ...(written !== undefined ? { cache_write_tokens: written } : {}) };
    }
    if (reasoning !== undefined) out.completion_tokens_details = { reasoning_tokens: reasoning };
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
    return out;
  }, {});
}

/** แถวข้อความขาออก: เติม metadata.replyEngine เฉพาะเทิร์นที่ v3 เขียน — เทิร์นเครื่องเดิมได้แถวเดิมทุกไบต์ */
export function withReplyEngineMeta(row, meta) {
  if (!meta) return row;
  return { ...row, metadata: { ...(row?.metadata || {}), replyEngine: meta } };
}

const isoKey = (iso) => {
  const [, month, day] = String(iso || "").split("-").map(Number);
  return month && day ? `${day}-${month}` : "";
};

function checkContext(input, picked, { predicates, outputFormat, told = "", contextEnvelope = {}, bankTexts = [] }) {
  const { facts, decision, slots } = input;
  const ladderSlot = decision.stage === "FIRST_CONTACT" || (decision.stage === "SCREEN_PRICE" && decision.ladder);
  // พี่ง้วง 12 ต.ค.: รูปบรรยากาศคลาสจริงที่ตัวตัดสินของเทิร์นเลือก (socialProof) แทนรูปที่โมเดลเลือกแนบเองได้ และระบบแนบให้ถ้าโมเดลลืม
  const socialImage = facts.socialProof?.image?.key || "";
  const offered = socialImage || facts.imageOffer?.key || "";
  return {
    stage: decision.stage, decision, policy: questionPolicy(decision),
    openSlots: slots.open, required: slots.required, slotValues: slots.values,
    // ปิดอย่างสุภาพไม่แนบรูปใด ๆ (รีวิวเคสจริงทั้งวัน 5 ต.ค.)
    imageKey: (ladderSlot && offered === "ai-stage-ladder") || decision.stage === "EXIT" ? "" : offered,
    imageRequired: Boolean(socialImage) && !ladderSlot && decision.stage !== "EXIT",
    // คำชวนทดลองเรียนฟรี: ประโยคที่อ้างจำนวนสิทธิ์/ที่นั่งที่ไม่ได้มาจากตัวนับถูกตัดทิ้ง
    trialInvite: Boolean(facts.socialProof?.trial),
    // รีวิวเคสจริงทั้งวัน 5 ต.ค.: ลูกค้าถามวันที่ที่ไม่มีรอบ — บอกได้ตรง ๆ ว่าวันนั้นไม่มี (ด่านหลังร่างบังคับให้ประโยคนั้นปฏิเสธ)
    // และรอบที่เสนอแทนคือรอบของคลาสนี้ที่ใกล้วันนั้นที่สุด
    allowedDates: new Set([...(facts.allRounds || []).map((round) => isoKey(round.date)), isoKey(facts.todayIso),
      isoKey(facts.requestedDate?.iso)].filter(Boolean)),
    // รีวิว 12 ต.ค.: ยังไม่รู้คลาส = รอบที่เปิดของทุกคลาส (ตรงกับบล็อกข้อเท็จจริง) เพื่อให้ H11 จับ "ยังยืนยันรอบไม่ได้" ได้ด้วย
    // (ตัวเติมก้าวถัดไปไม่ชวนเลือกรอบจากชุดรวมนี้ — ดู classKnown)
    roundLabels: (decision.logistics === "date" && facts.requestedDate?.nearest?.length ? facts.requestedDate.nearest : heldRoundLabels(facts)) || [],
    requestedDate: facts.requestedDate || null, predicates, guardTurn: input.guardTurn,
    userText: facts.text, prevUserText: facts.prevUserText,
    level: Number.isInteger(facts.answeredLevel) ? facts.answeredLevel : facts.routing?.level ?? null,
    className: facts.className, band: input.styleCard === true ? teacherBand(bandFor(decision)) : bandFor(decision),
    // ตัวตรวจลอกตัวอย่าง (S7) เทียบเฉพาะถ้อยคำของตัวอย่างเอง — ส่วนที่งานของเทิร์นสั่งให้พูดอยู่แล้วไม่นับ
    exemplarTexts: picked.map(({ exemplar }) => exemplarOwnText(exemplarReply(exemplar, facts), told)),
    // 7 พ.ย. 2026: คำตอบของครูจากคลังห้ามลอกเกินหนึ่งประโยค (ด่าน S7 ใช้ช่วงยาวกว่าตัวอย่างเดิม)
    bankTexts: (bankTexts || []).map((text) => exemplarOwnText(text, told)),
    address: facts.address, outputFormat, priceQuoted: Boolean(facts.priceQuoted),
    // ข้อความล่าสุดของลูกแพร: ด่านหลังร่างไม่ปิดด้วยประโยคแทนที่เพิ่งใช้ไป (เคสจริง 5 ต.ค. — สองเทิร์นติดกันจบด้วยประโยคเดียวกัน)
    recentBotText: facts.lastBotText || "",
    // รีวิวเคสจริง 5 ต.ค.: ก้าวถัดไปที่ด่านหลังร่างเติมเองในจังหวะร้อน ไม่ชวนดูหัวข้อซ้ำถ้าส่งหัวข้อไปแล้ว
    outlineSent: Boolean(facts.outlineSent),
    // รีวิวเคสจริงทั้งวัน 5 ต.ค.: หลังราคาแล้วถามเรื่องงานซ้ำ นับเฉพาะตอนรู้คลาสแล้ว · บับเบิลที่ลูกค้าเพิ่งเห็นตอนพิมพ์แทรก (ตัดย่อหน้าที่ทวนซ้ำ)
    classKnown: Boolean(facts.classKey),
    // รีวิวเคสจริง 6–7 ต.ค.: การ์ดราคาเทิร์นนี้มีสองคลาส = ยังไม่ได้เลือกคลาส (บันทึกซ่อม S11 ชวนเลือกคลาส ไม่ใช่เลือกรอบ)
    bothClassCards: decision.stage === "PRICE" && String(facts.priceClassNames || "").includes(" และ "),
    overlapDelivered: facts.overlap?.delivered || [],
    prepSaid: Boolean(facts.prepSaid),
    trialLinkRequested: Boolean(facts.trialLinkRequested),
    approvedTrialUrl: facts.trialLinkRequested ? approvedTrialLink(contextEnvelope) : "",
  };
}

const better = (next, current) => next.hard.length < current.hard.length
  || (next.hard.length === current.hard.length && next.soft.length <= current.soft.length);
const ids = (items = []) => [...new Set(items.map((item) => item.id))];

function textCarriesCourse(key, evidence) {
  if (key === "business" && /AI Agent for Business|คลาส(?:สอนสด)?พื้นฐาน/u.test(evidence)) return key;
  if (key === "workflow" && /AI Agent Workflow Automation|Workflow Automation|คลาส(?:สอนสด)?ต่อยอด/iu.test(evidence)) return key;
  return "";
}

function discussedCourseOf(text) {
  const keys = ["business", "workflow"].filter((key) => textCarriesCourse(key, String(text || "")));
  return keys.length === 1 ? keys[0] : "";
}

function customerSelectedCourseOf(input, text) {
  const explicit = input.facts?.customerSelectedClassKey
    || (input.facts?.classWished === true ? input.facts?.classKey : "");
  const previous = input.contextEnvelope?.activeCourse?.key || input.facts?.contextEnvelope?.activeCourse?.key || "";
  if (explicit) return explicit;
  return textCarriesCourse(previous, String(text || ""));
}

function offerTypeOf(text) {
  if (/รายละเอียดการสมัคร|ขั้นตอนสมัคร|วิธีสมัคร|ลงทะเบียน/u.test(text)) return "registration";
  if (/รอบเรียน|รอบที่เปิด|วันเรียน/u.test(text)) return "rounds";
  if (/รีวิว|เคสผู้เรียน/u.test(text)) return "review";
  if (/หัวข้อ|เนื้อหา|outline|รายละเอียด/u.test(text)) return "content";
  if (/คลาส/u.test(text)) return "class";
  return "other";
}

// เขียน continuity จากข้อความที่ส่งจริง/slot ที่ใช้จริงเท่านั้น — root อ่านเฉพาะ metadata ของ active session ล่าสุด
export function contextContinuity(input, actualText) {
  const continuity = { schema: 1, committed: false, deliveryComplete: false };
  const discussedCourse = discussedCourseOf(actualText);
  const customerSelectedCourse = customerSelectedCourseOf(input, actualText);
  if (discussedCourse) continuity.discussedCourse = discussedCourse;
  if (customerSelectedCourse) {
    continuity.customerSelectedCourse = customerSelectedCourse;
    continuity.activeCourse = customerSelectedCourse;
    continuity.activeCourseSource = "customer";
  }
  const previous = input.contextEnvelope?.pendingOffer || input.facts?.contextEnvelope?.pendingOffer || null;
  const fulfilled = previous?.accepted && /accepted_|list_request/u.test(String(input.decision?.reason || ""));
  const sentence = offerSentence(String(actualText || ""));
  if (sentence) {
    continuity.pendingOffer = { type: offerTypeOf(sentence), ...(discussedCourse ? { courseKey: discussedCourse } : {}),
      ...(input.facts?.pickedRound ? { roundLabel: input.facts.pickedRound } : {}), status: "pending" };
  } else if (fulfilled) {
    continuity.pendingOffer = { type: previous.type, ...(previous.courseKey ? { courseKey: previous.courseKey } : {}),
      ...(previous.roundLabel ? { roundLabel: previous.roundLabel } : {}), status: "fulfilled" };
  } else if (previous?.status === "pending" && !input.decision?.offerDeclined && !input.decision?.classDeclined
    && !input.decision?.softDecline && !input.decision?.notReady && !["EXIT", "GOODBYE", "SILENT"].includes(input.decision?.stage)) {
    continuity.pendingOffer = { type: previous.type, ...(previous.courseKey ? { courseKey: previous.courseKey } : {}),
      ...(previous.roundLabel ? { roundLabel: previous.roundLabel } : {}), status: "pending", carried: true };
  }
  return continuity;
}

const continuityOf = (meta) => meta?.contextContinuity?.schema === 1 ? meta.contextContinuity
  : meta?.v3Meta?.contextContinuity?.schema === 1 ? meta.v3Meta.contextContinuity : null;

function fulfillmentSupported(type, text) {
  const value = String(text || "");
  if (type === "review") return /รีวิว|เคสผู้เรียน|https?:\/\//iu.test(value);
  if (type === "rounds") return /รอบเรียน|(?:เสาร์|อาทิตย์|จันทร์|อังคาร|พุธ|พฤหัสบดี|ศุกร์)\s*\d{1,2}/u.test(value);
  if (type === "content") return /หัวข้อ|เนื้อหา|สิ่งที่จะได้|รายละเอียด/u.test(value) && [...value].length >= 60;
  if (type === "class") return /AI Agent for Business|Workflow Automation|คลาส(?:พื้นฐาน|ต่อยอด)/iu.test(value);
  if (type === "registration") return /ขั้นตอนสมัคร|วิธีสมัคร|ลงทะเบียน/u.test(value);
  return [...value].length >= 60;
}

/**
 * Recompute continuity from bubbles actually delivered. Root calls this immediately before persisting outbound metadata.
 * Durable continuity is emitted only for a complete delivery. Partial bubbles stay visible in conversation history,
 * but cannot promote a course or offer into the next-turn envelope.
 */
export function committedReplyMeta(meta = {}, { deliveredText = "", complete = false, previousMeta = null } = {}) {
  const text = String(deliveredText || "").trim();
  const candidate = continuityOf(meta) || { schema: 1 };
  const previous = continuityOf(previousMeta);
  const deliveryComplete = Boolean(text && complete);
  const committed = { schema: 1, deliveryComplete, committed: Boolean(text) };
  if (!deliveryComplete) return { ...meta, contextContinuity: committed };
  const customerSelectedCourse = candidate.customerSelectedCourse
    || (previous?.committed === true && previous?.deliveryComplete === true && previous?.activeCourseSource === "customer"
      ? previous.activeCourse : "");
  if (customerSelectedCourse) {
    committed.activeCourse = customerSelectedCourse;
    committed.activeCourseSource = "customer";
  }
  const sentence = offerSentence(text);
  if (sentence) {
    const discussedCourse = discussedCourseOf(text);
    committed.pendingOffer = { type: offerTypeOf(sentence), ...(discussedCourse ? { courseKey: discussedCourse } : {}), status: "pending" };
  } else if (candidate.pendingOffer?.status === "fulfilled") {
    // คำตัดสินว่า “รับข้อเสนอแล้ว” ยังไม่ใช่หลักฐานว่าส่งของที่รับจริง หาก guard/partial path
    // เหลือเพียงคำเกริ่น ให้คง promise เดิมเป็น pending เพื่อส่งให้ครบในเทิร์นถัดไป
    const status = fulfillmentSupported(candidate.pendingOffer.type, text) ? "fulfilled" : "pending";
    committed.pendingOffer = { type: candidate.pendingOffer.type,
      ...(candidate.pendingOffer.courseKey ? { courseKey: candidate.pendingOffer.courseKey } : {}),
      ...(candidate.pendingOffer.roundLabel ? { roundLabel: candidate.pendingOffer.roundLabel } : {}), status };
  } else if (candidate.pendingOffer?.status === "pending" && candidate.pendingOffer.carried === true) {
    committed.pendingOffer = { type: candidate.pendingOffer.type,
      ...(candidate.pendingOffer.courseKey ? { courseKey: candidate.pendingOffer.courseKey } : {}),
      ...(candidate.pendingOffer.roundLabel ? { roundLabel: candidate.pendingOffer.roundLabel } : {}), status: "pending" };
  } else if (previous?.committed === true && previous?.deliveryComplete === true
    && previous?.pendingOffer?.status === "pending" && fulfillmentSupported(previous.pendingOffer.type, text)) {
    committed.pendingOffer = { type: previous.pendingOffer.type,
      ...(previous.pendingOffer.courseKey ? { courseKey: previous.pendingOffer.courseKey } : {}),
      ...(previous.pendingOffer.roundLabel ? { roundLabel: previous.pendingOffer.roundLabel } : {}), status: "fulfilled" };
  }
  return { ...meta, contextContinuity: committed };
}

const SAFE_SOURCE_PROVENANCE_KEYS = new Set(["source", "approved", "brainVersionId", "source_created_at", "source_rowid", "entry_version", "revisionHash", "hash"]);
function contextSourcesOf(envelope = {}) {
  return {
    businessStatus: String(envelope.businessStatus || "missing"),
    selectionTrace: (Array.isArray(envelope.selectionTrace) ? envelope.selectionTrace : []).map((item) => ({
      title: String(item.title || ""), reason: String(item.reason || ""), id: String(item.id || ""), revId: String(item.revId || ""),
      source_created_at: item.source_created_at ?? null, source_rowid: item.source_rowid ?? null, entry_version: item.entry_version ?? null,
      provenance: Object.fromEntries(Object.entries(item.provenance && typeof item.provenance === "object" ? item.provenance : {})
        .filter(([key]) => SAFE_SOURCE_PROVENANCE_KEYS.has(key))),
    })),
  };
}

// พี่ง้วง 12 ต.ค.: ของที่ตัวตัดสินแนบในเทิร์นนี้ (วัดผลรายวัน: รีวิว/รูป/คำชวนทดลองเรียน) — ไม่มีอะไรแนบ = ไม่ใส่คีย์
function socialProofMeta(sp, best, fallback) {
  if (!sp || fallback || (!sp.review && !sp.image && !sp.trial)) return {};
  const used = new Set(best?.slotsUsed || []);
  const out = {
    ...(sp.review && used.has("รีวิว") ? { review: sp.reviewTrigger || "review" } : {}),
    ...(sp.image && String(best?.text || "").includes(`[IMAGE:${sp.image.key}]`) ? { image: sp.image.key } : {}),
    ...(sp.trial && used.has("ทดลองเรียน") ? { trial: sp.trialTrigger || "trial" } : {}),
  };
  return Object.keys(out).length ? { socialProof: out } : {};
}

export function createReplyEngineV3({ hermes, predicates = {}, logger = console, now = Date.now, outputFormat = "plan_reply" } = {}) {
  const driftLogged = new Set();

  function lintDrift(input) {
    const key = String(input.brainVersionId || "tables");
    if (driftLogged.has(key)) return;
    const envelope = normalizeContextEnvelope(input.contextEnvelope || input.facts?.contextEnvelope,
      { facts: input.facts, decision: input.decision, userText: input.userText || input.facts?.text });
    const conflicts = envelope.provenance.conflicts;
    const missing = envelope.provided && envelope.provenance.approved && !hasAuthoritativeBusinessContext(envelope);
    if (!conflicts.length && !missing) return;
    driftLogged.add(key);
    logger.warn?.(`v3_context_source_${conflicts.length ? "conflict" : "missing"} ${JSON.stringify({ brainVersionId: input.brainVersionId || null,
      conflicts, sources: envelope.provenance.sources })}`);
  }

  function prepare(input) {
    const { facts, decision, slots } = input;
    const history = Array.isArray(input.history) ? input.history : [];
    const userTurns = history.filter((turn) => turn?.role === "user").length + 1;
    const contextEnvelope = normalizeContextEnvelope(input.contextEnvelope || facts.contextEnvelope, { facts, decision, userText: input.userText || facts.text });
    const cards = hasAuthoritativeBusinessContext(contextEnvelope) ? [] : selectCards(input.knowledgeEntries || [], facts, decision);
    const picked = pickExemplars({ stage: decision.stage, facts, seed: `${input.customerId || ""}:${userTurns}`,
      excludeCaseIds: input.excludeCaseIds || [], openSlots: slots.open, ladder: decision.ladder === true });
    const basePlan = stageTask(decision, facts, { openSlots: slots.open, guardRepair: String(input.guardRepair || "") });
    // 7 พ.ย. 2026: การ์ดสไตล์เปิด → งานของเทิร์นใช้ "ข้อเสนอแบบถามความสนใจ" แทน "แบบขออนุญาต" (คำนี้พาให้เขียน "อนุญาตให้ลูกแพร…")
    // การ์ดปิด = ถ้อยคำเดิมทุกไบต์ (golden soul-parity)
    const plan = input.styleCard === true
      ? teacherPlan(basePlan, { decision, facts, history, userText: input.userText || facts.text || "" }) : basePlan;
    const sections = { facts, decision, plan, cards, contextEnvelope, ownerLessonText: input.ownerLessonText, outputFormat,
      styleCard: input.styleCard === true, closingPolicy: questionPolicy(decision) };
    // 7 พ.ย. 2026: สวิตช์ reply_style_bank — คำตอบจริงของครูที่คล้ายเทิร์นนี้ วางต่อจากตัวอย่างเดิมในบล็อกต่อเทิร์น (ไม่มีคลัง = พรอมต์เดิมทุกไบต์)
    const prevBot = [...history].reverse().find((turn) => turn?.role === "assistant")?.content || "";
    const bankPicked = Array.isArray(input.styleBank) && input.styleBank.length
      ? selectStyleExamples(input.styleBank, { stage: decision.stage, userText: input.userText || facts.text || "", prevBot }) : [];
    const exemplarBlock = [renderExemplars(picked, facts), renderStyleExamples(bankPicked)].filter(Boolean).join("\n\n");
    const messages = buildV3Messages({ ...sections, businessCacheLayer: input.businessCacheLayer === true,
      exemplars: exemplarBlock, history, userText: input.userText });
    const told = instructionText(sections);
    return { cards, contextEnvelope, picked, plan, messages, styleBankIds: bankPicked.map((item) => (item.strong ? `${item.id}*` : item.id)),
      ctx: checkContext(input, picked, { predicates, outputFormat, told, contextEnvelope, bankTexts: bankPicked.filter((item) => !item.strong).map((item) => item.reply) }) };
  }

  function meta(input, prep, best, { repaired, fallback, calls, yielded = false, firstDraft = null }) {
    // รีวิวเคสจริง 6–7 ต.ค.: ตัวทักตามอ่านว่าเทิร์นนี้ปิดห้อง/ลูกค้าปฏิเสธ/เงินตึง/ดูแลใจหรือเปล่า จากแถวข้อความนี้เอง ("" = ไม่ใส่คีย์)
    // · ขอเวลาคิด/รอปรึกษาในเทิร์นลา = ทักครั้งเดียว (อ่านจากข้อความลูกค้าของเทิร์นนี้)
    const followupStop = followupStopOf(input.decision, input.facts?.text);
    return {
      engine: "v3", promptVersion: V3_PROMPT_VERSION, promptHash: promptHash(outputFormat),
      // 5 พ.ย. 2026: เทิร์นที่ใช้การ์ดสไตล์ — ห้องตรวจแยกผลของการ์ดได้ (ปิดสวิตช์ = ไม่ใส่คีย์)
      ...(input.styleCard === true ? { styleCard: `${STYLE_CARD_VERSION}:${STYLE_CARD_SHA}` } : {}),
      // 7 พ.ย. 2026: ตัวอย่างของครูที่หยิบมาให้เทิร์นนี้ (ปิดสวิตช์/ไม่มีคลัง = ไม่ใส่คีย์)
      ...(prep?.styleBankIds?.length ? { styleBank: prep.styleBankIds } : {}),
      ...(followupStop ? { followupStop } : {}),
      stage: input.decision.stage, stageReason: input.decision.reason, modifiers: input.decision.modifiers || [],
      // เหตุที่ไม่แบ่งรับราคา (story_known · luna_earned · …) — ห้องตรวจ/คอนโซลเห็นว่าใครตัดสิน
      ...(input.facts?.valueHedgeExempt ? { priceHedgeSkip: input.facts.valueHedgeExempt } : {}),
      exemplars: prep.picked.map(({ exemplar }) => exemplar.id), cards: prep.cards.map((card) => card.title),
      contextSources: contextSourcesOf(prep.contextEnvelope),
      contextContinuity: contextContinuity(input, best?.text || ""),
      slots: best?.slotsUsed || [], repaired, violations: { hard: ids(best?.hard), soft: ids(best?.soft) },
      // 7 พ.ย. 2026: เหตุที่ร่างแรกไม่ผ่าน — violations เก็บแค่ร่างสุดท้าย จึงเคยไม่รู้ว่ายกที่สองถูกยิงเพราะกฎข้อไหน
      ...(firstDraft && (firstDraft.hard.length || firstDraft.soft.length) ? { firstDraft } : {}),
      ...(input.businessCacheLayer === true ? { cacheLayer: "business" } : {}),
      ...socialProofMeta(input.facts?.socialProof, best, fallback),
      fallback, calls, ...(input.guardRepair ? { guardRepair: true } : {}), ...(yielded ? { yielded: true } : {}),
    };
  }

  async function legacyDraft(input) {
    return hermes.draftReply({ ...(input.legacyArgs || {}), signal: input.signal });
  }

  // ผลลัพธ์รูปเดียวกับ draftReply: {text, usage, model, attempt, mirrorId, v3Meta}
  function result(text, source, calls, attempt, v3Meta) {
    return { text, usage: sumUsage(calls), model: source?.model || "", attempt,
      ...(source?.mirrorId ? { mirrorId: source.mirrorId } : {}), v3Meta };
  }

  async function resolveHard(input, prep, best, calls, started, yieldNow) {
    const stripped = stripHard(best, prep.ctx);
    if (input.guardRepair) return { text: stripped.text, source: best.source, attempt: best.attempt, fallback: null, final: stripped };
    // ลูกค้าพิมพ์ต่อแล้ว: ส่งร่างที่ตัดประโยคผิดออกกลับไป (อาจว่าง) — ไปป์ไลน์ยกข้อความไปรวมก้อนใหม่ก่อนส่ง
    if (yieldNow()) return { text: stripped.text, source: best.source, attempt: best.attempt, fallback: null, final: stripped, yielded: true };
    const tooShort = [...stripped.text].length < V3_MIN_STRIPPED_CHARS;
    if (now() - started > V3_FALLBACK_BUDGET_MS && !tooShort) return { text: stripped.text, source: best.source, attempt: best.attempt, fallback: null, final: stripped };
    const legacy = await legacyDraft(input);
    if (legacy) {
      calls.push(legacy);
      return { text: legacy.text, source: legacy, attempt: "v3_fallback_legacy", fallback: "legacy", final: best };
    }
    return tooShort ? null : { text: stripped.text, source: best.source, attempt: best.attempt, fallback: null, final: stripped };
  }

  async function run(input, calls) {
    const started = now();
    const yieldNow = () => { try { return Boolean(input.shouldYield?.()); } catch { return false; } };
    lintDrift(input);
    const prep = prepare(input);
    const call = async (messages, attempt) => {
      const reply = await hermes.draftReplyV3({ messages, signal: input.signal, brainVersionId: input.brainVersionId || "",
        mirrorRoomId: input.mirrorRoomId || "", attempt });
      if (reply) calls.push(reply);
      return reply;
    };
    const first = await call(prep.messages, "v3");
    if (!first) return null;
    let best = { ...finalizeDraft(first.text, prep.ctx), attempt: "v3", source: first };
    const firstDraft = { hard: ids(best.hard), soft: ids(best.soft) };
    let repaired = false;
    if (!input.guardRepair && (best.hard.length || best.soft.length) && now() - started <= V3_REPAIR_BUDGET_MS && !yieldNow()) {
      const second = await call([...prep.messages, { role: "assistant", content: first.text },
        { role: "user", content: repairNote(best, prep.ctx) }], "v3_repair");
      if (second) {
        const next = { ...finalizeDraft(second.text, prep.ctx), attempt: "v3_repair", source: second };
        if (better(next, best)) { best = next; repaired = true; }
      }
    }
    if (best.soft.length && !best.hard.length) logger.debug?.(`reply-v3: ส่งพร้อมข้อสังเกต ${ids(best.soft).join(",")}`);
    if (!best.hard.length) return result(best.text, best.source, calls, best.attempt, meta(input, prep, best, { repaired, fallback: null, calls: calls.length, firstDraft }));
    const resolved = await resolveHard(input, prep, best, calls, started, yieldNow);
    if (!resolved) return null;
    return result(resolved.text, resolved.source, calls, resolved.attempt,
      meta(input, prep, resolved.final, { repaired, fallback: resolved.fallback, calls: calls.length, yielded: resolved.yielded === true, firstDraft }));
  }

  async function draft(input = {}) {
    if (typeof hermes?.draftReplyV3 !== "function") {
      logger.warn?.("reply-v3: สมองไม่มีทาง draftReplyV3 — ใช้เครื่องเดิม");
      return legacyDraft(input);
    }
    const calls = [];
    try {
      return await run(input, calls);
    } catch (err) {
      // บั๊กของเครื่องใหม่ต้องไม่ทำให้ลูกค้าเงียบ — ถอยไปเครื่องเดิมหนึ่งครั้ง (ยกที่ยิงไปแล้วยังนับรวมใน usage)
      logger.warn?.(`reply-v3: ผิดพลาดภายใน (${err?.message || err}) — ใช้เครื่องเดิม`);
      if (input.signal?.aborted) return null;
      const legacy = await legacyDraft(input);
      return legacy && calls.length ? { ...legacy, usage: sumUsage([...calls, legacy]), attempt: "v3_fallback_legacy" } : legacy;
    }
  }

  return { draft };
}

// ถ้อยคำงานแบบครู + ช่วงความยาว ×1.25 (การ์ดเปิดเท่านั้น) อยู่ที่ teacherTask.mjs — ส่งออกต่อจากที่นี่ให้โค้ด/เทสต์เดิม
export { interestWording, teacherBand } from "./teacherTask.mjs";
