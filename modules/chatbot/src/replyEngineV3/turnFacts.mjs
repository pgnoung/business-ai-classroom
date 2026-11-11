// turnFacts.mjs — ข้อเท็จจริงของเทิร์นที่ระบบตัดสินแล้ว สำหรับเครื่องตอบ v3 (spec v3.1 §A6)
// baseRules ไม่ถูกแตะเลย: ทุกคำตัดสินคำนวณใหม่จากฟังก์ชันบริสุทธิ์ตัวเดียวกับเครื่องเดิมด้วยอินพุตชุดเดียวกัน
// ตัวตัดสินที่อยู่ใน pipeline.mjs (รูป / รีวิวเคยส่ง / โน้ตทีม / ลูกค้าขอรูป) รับผ่าน deps — ไฟล์นี้ห้าม import pipeline
import { asksAboutMoney, outboundCarriesClassPrice, withValueHedge } from "../priceDisclosure.mjs";
import { planCustomerAddress } from "../customerAddress.mjs";
import { isOpeningShortAnswer, learningGoal, resolveReplyFocus, roomHasBotQuestion } from "../conversationFocus.mjs";
import { detectAiLevel, hasRecentFatigue, resolveClassRouting, resolveSalesStage } from "../salesMotion.mjs";
import { customerHesitates } from "../conversationStyle.mjs";
import { CONFIDENCE_TURN } from "../reviewJourney.mjs";
import { parseCatalogText, selectJourneyEvidence } from "../reviewSelection.mjs";
import { isOpenRound, openRounds, roundShortThai, roundsMentionedIn, roundWeekdayThai } from "../openRounds.mjs";
import { composeTagRules } from "../tags.mjs";
import { NON_AI_SERVICE_TOPIC } from "../serviceTopic.mjs";
import { brainModeOf, BRAIN_MODE_SEPARATE } from "../knowledgePack.mjs";
import { FACEBOOK_CHANNEL_ID } from "../channels.mjs";
import { pickPriceRead } from "../scoring.mjs";
import { truncateCodePoints } from "../unicodeText.mjs";
import { normalizeContextEnvelope } from "./contextEnvelope.mjs";
import { AGENT_WELCOME_RE, AI_TERM_RE, bareNegativeOpening, CONFUSED_RE, CONFUSED_TOPIC_RE, decideStage, ENROLL_HANDOVER_REASONS, enrollIntentOf,
  followupStopSignal, GENERAL_AI_MENTION_RE, lastBotBurstOf, numericRoundPickOf, OPENING_NEVER_RE, OPENING_USED_RE, openSlotsFor, roundPickedIn,
  valueHedgeExemptOf } from "./stage.mjs";
import { planChatSocialProof, reviewCatalogOf, trialInviteBubble } from "./socialProof.mjs";
import { arrivalNoteFor } from "../showcaseArrival.mjs";
import { recentClosings, WORKSHOP_PREP_RE } from "./closings.mjs";
import { CLASS_NAMES, priceFactsFromKnowledge, renderDealSlot, renderPriceSlot } from "./priceFacts.mjs";
import { LADDER_IMAGE_KEY, renderLadder, renderReviewSlot } from "./slots.mjs";
import { BOTH_CLASSES_ASK, BUSINESS_DONE_RE, CLASS_DESCRIBED_RE, classInText, classWishIn, classWishWithTurn, dateFitOf, discoveryStreakOf, historyRangeLevel,
  hobbyNoWorkOf, recommendedClassOf, requestedDateOf, roundDayAskOf } from "./afterPrice.mjs";

const ADMIN_PREFIX = "[แอดมินทีมงานพิมพ์เอง]";
// ข้อเท็จจริงระยะยาวอ่านย้อนได้ 100 เทิร์นของ session (spec §A6 "จากประวัติทั้งหมด") — หน้าต่างพรอมต์ยังเป็น 16 ก้อนเหมือนเดิม
export const V3_FACT_HISTORY_TURNS = 100;
const KEYCAP_LINE = /^\s*[1-5]️?⃣/mu;
const COURSE_POSTERS = ["ai-agent-for-business", "ai-agent-workflow-automation"];
const COURSE_POSTER_KEY = Object.freeze({ business: "ai-agent-for-business", workflow: "ai-agent-workflow-automation" });
const SAME_COURSE_REFERENCE = /(?:คลาส|คอร์ส)(?:เดียวกัน|นี้|ที่(?:คุย|พูด|แนะนำ)(?:กัน)?|เมื่อกี้)|โปสเตอร์.{0,30}(?:เดียวกัน|ที่คุย|คลาสนี้)/u;
// คำถามสั้นที่อ้างย้อนถึงหัวข้อธุรกิจในก้อนล่าสุด เช่น “ถ้ามี ต้องเริ่มจากตรงไหนคะ”
// ใช้ก้อนนั้นบอกหัวข้อสนทนาเท่านั้น ข้อเท็จจริงของคำตอบยังต้องมาจาก approved context ใน cards.mjs
const BUSINESS_TOPIC_IN_BOT = /คลาส|คอร์ส|หลักสูตร|ทดลองเรียน|สมัคร|ลงทะเบียน|รอบเรียน|รีวิวผู้เรียน|หัวข้อที่สอน|workshop/iu;
const ANAPHORIC_BUSINESS_FOLLOWUP = /^(?:(?:ถ้ามี|ถ้าอย่างนั้น|แล้ว|อันนั้น|แบบนั้น|เรื่องนั้น|ที่(?:แจ้ง|บอก|พูด)ไว้)\s*)?(?:ต้อง)?เริ่ม(?:จาก)?(?:ตรงไหน|ยังไง)(?:\s*(?:คะ|ค่ะ|ครับ|คับ|นะ|หน่อย|[?？]))*$/iu;
const TRIAL_TOPIC = /คลาสทดลอง|ทดลองเรียน|ลองเรียน|เรียนฟรี/u;
const TRIAL_LINK_ANAPHORA = /^(?:ขอ|ส่ง)?\s*ลิงก์(?:นั้น|ที่(?:แจ้ง|บอก|พูด)ไว้)?(?:\s*(?:ให้|มา|หน่อย|ด้วย|คะ|ค่ะ|ครับ|คับ|นะ|[?？]))*$/iu;
const TRIAL_LINK_DIRECT_REQUEST = /(?:ขอ|ส่ง|อยากได้|รบกวน).{0,30}ลิงก์|ลิงก์.{0,30}(?:อยู่ไหน|ขอ|ส่ง|ได้ไหม|ได้มั้ย)|(?:คลาสทดลอง|ทดลองเรียน|ลองเรียน|เรียนฟรี).{0,40}(?:เริ่ม(?:จากตรงไหน|ยังไง|อย่างไร)|สมัคร(?:ยังไง|อย่างไร|ตรงไหน)|เข้าเรียน(?:ยังไง|อย่างไร|ตรงไหน))/iu;
// ช่องว่างสองช่วงรอบคำที่ไม่บังคับ ("ไม่ได้ขอ" + ช่องว่างยาว) เคยลองแบ่งช่องว่างทุกแบบ (ตกเกณฑ์ 50 ms เป็นพัก ๆ ตอนเทสต์ทั้งชุด)
// — ช่องว่างหลังคำที่ไม่บังคับย้ายเข้าไปอยู่ในกลุ่มเดียวกับคำนั้น (ผลเหมือนเดิมทุกข้อความ)
const TRIAL_LINK_REQUEST_DENIAL = /(?:ไม่ต้อง|อย่า(?:เพิ่ง)?|ห้าม|งด|ขอไม่(?:ให้)?)[ \t]*(?:ส่ง|ให้)[ \t]*ลิงก์|(?:ไม่ได้ขอ|ไม่(?:อยาก|เอา|ขอ|รับ))[ \t]*(?:(?:ดู|ได้|รับ)[ \t]*)?ลิงก์|ไม่(?:ส่ง|ให้)[ \t]*ลิงก์/u;
const TRIAL_LINK_CARRIED_DENIAL = /(?:ยัง)?ไม่ต้องส่ง|อย่า(?:เพิ่ง)?ส่ง|ห้ามส่ง|งดส่ง|ยกเลิก(?:การส่ง)?|เปลี่ยนใจ(?:แล้ว)?ไม่(?:เอา|รับ|ส่ง)(?:แล้ว)?|ไม่(?:เอา|รับ)แล้ว/u;
const TRIAL_LINK_OTHER_TARGET = /(?:คลาส|คอร์ส)(?:เสียเงิน|สอนสด|หลัก)|ค่า(?:ใช้จ่าย|เรียน)|ราคา|สมัคร|ลงทะเบียน|เงิน/u;
const ADMIN_TURN_RE = /^\[แอดมินทีมงานพิมพ์เอง\]/u;
const CLASS_PITCH_SEEN = /(?:AI Agent for Business|Workflow Automation)[^\n]{0,40}?(?:จะได้|ได้ลงมือ|ฝึก)/iu;
// ข้อเสนอส่ง/ดูหัวข้อที่สอน ที่ลูกแพรเคยถามไว้ (ประโยคข้อเสนอที่ลงท้ายด้วยคำถาม)
const OUTLINE_OFFER_SEEN = /(?:ส่ง|ดู)\S{0,12}?หัวข้อ[^?？\n]{0,160}[?？]/u;
const CONTINUITY_OFFER_TYPE = Object.freeze({ booking: "registration", rounds: "rounds", review: "review", outline: "content", price: "other" });
const LEGACY_CARRY_OFFER_TYPES = new Set(["review", "content"]);
const TOOL_NAMES = [
  [/chat\s*-?gpt|แชทจีพีที/iu, "ChatGPT"], [/gemini|เจมิไน/iu, "Gemini"], [/claude/iu, "Claude"], [/copilot/iu, "Copilot"],
  [/notebooklm/iu, "NotebookLM"], [/perplexity/iu, "Perplexity"], [/canva/iu, "Canva"], [/capcut/iu, "CapCut"], [/midjourney/iu, "Midjourney"],
];
const PRODUCT_CLASS = Object.freeze({ ai_agent_for_business: "business", workflow_automation_or_higher: "workflow" });
const CLASS_LABEL = Object.freeze({
  business: "AI Agent for Business (ระดับ 1–4)", workflow: "AI Agent Workflow Automation (ระดับ 5)",
});
// รีวิวเคสจริง 6–7 ต.ค.: ลูกค้าบอกเองว่าอยากเรียนคลาสไหน = ป้ายบอกว่าเขาเลือกเอง (ป้ายระดับทำให้โมเดลแย้งว่าระดับของเขาไม่ตรง)
const WISHED_LABEL = Object.freeze({
  business: "AI Agent for Business (ลูกค้าบอกเองว่าอยากเรียนคลาสนี้)", workflow: "AI Agent Workflow Automation (ลูกค้าบอกเองว่าอยากเรียนคลาสนี้)",
});
// รอบรีวิว 8 (U3): อยากเรียน Workflow แต่ระดับยังไม่ถึง 5 (ยังไม่เคยเรียนคลาสพื้นฐาน) = เริ่มจาก Business ก่อน — การ์ดสองคลาส Business ก่อน
const WISH_BEYOND_LABEL = "AI Agent for Business ก่อน (ลูกค้าอยากเรียน AI Agent Workflow Automation ซึ่งต่อยอดจากคลาสนี้)";

// รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 C1/U3): คลาสที่ลูกค้าอยากเรียน — ข้อความนี้ก่อน · ข้อความนี้เอ่ยถึงคลาสใด = ไม่ใช้คำบอกเก่า
// (เคย "สนใจคลาสพื้นฐานก่อน" แล้วถาม "ขอดูราคาคลาส Advance" ได้การ์ดพื้นฐานใบเดียว) · คำบอกเก่าที่ลูกค้าตอบระดับทีหลัง = ระดับชนะ
// · อยากเรียน Workflow ที่ระดับ ≤4 (ยังไม่เคยเรียนพื้นฐาน) = เริ่มจาก Business (beyondLevel)
function classWishOfRoom(s) {
  const now = classWishIn(s.text);
  const found = now ? { wish: now, current: true, levelAfter: false } : (classInText(s.text) ? null : classWishWithTurn(s.longHistory, s.text));
  if (!found || (!found.current && found.levelAfter)) return { wished: null, beyondLevel: false };
  const level = s.routing?.level;
  const doneBusiness = [...userTexts(s.longHistory), s.text].some((text) => BUSINESS_DONE_RE.test(text));
  const beyondLevel = found.wish === "workflow" && Number.isInteger(level) && level <= 4 && !doneBusiness;
  return { wished: found.wish, beyondLevel };
}

/** การ์ดความรู้ทั้งชุดของห้องนี้ (สมองรุ่น หรือคลังเดิม) — อ่านพัง = [] */
function provenanceOf(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function knowledgeMetadata(source = {}, body = {}) {
  const provenance = provenanceOf(source.provenance ?? source.provenance_json ?? body.provenance ?? body.provenance_json);
  return {
    id: String(source.id ?? source.itemId ?? source.item_id ?? body.id ?? ""),
    revId: String(source.revId ?? source.rev_id ?? body.revId ?? body.rev_id ?? ""),
    source_created_at: source.source_created_at ?? body.source_created_at ?? provenance.source_created_at
      ?? source.createdAt ?? source.created_at ?? null,
    source_rowid: source.source_rowid ?? body.source_rowid ?? provenance.source_rowid ?? source.rowid ?? null,
    entry_version: source.entry_version ?? body.entry_version ?? provenance.entry_version ?? source.version ?? null,
    provenance,
  };
}

function revisionComparable(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function knowledgeEntriesFor({ brain = null, db = null, channelId = "default" } = {}) {
  try {
    const separate = brainModeOf(db, channelId) === BRAIN_MODE_SEPARATE;
    if (Array.isArray(brain?.bundle?.cards)) {
      return brain.bundle.cards
        .filter((card) => card.kind === "fact" && card.inject !== "never")
        .filter((card) => (separate ? card.body?.channel_id === String(channelId) : card.body?.channel_id === null))
        .map((card) => ({ title: String(card.body.title || ""), content: String(card.body.content || ""),
          ...knowledgeMetadata(card, card.body) }))
        .sort((a, b) => revisionComparable(a.source_created_at) - revisionComparable(b.source_created_at)
          || revisionComparable(a.source_rowid) - revisionComparable(b.source_rowid)
          || revisionComparable(a.entry_version) - revisionComparable(b.entry_version));
    }
    return (db?.listActiveKnowledge?.(separate ? String(channelId) : null) || [])
      .map((row) => ({ title: String(row.title || ""), content: String(row.content || ""),
        ...knowledgeMetadata(row, row) }));
  } catch {
    return [];
  }
}

const userTexts = (history) => history.filter((turn) => turn?.role === "user").map((turn) => String(turn.content || ""));
const botTurns = (history) => history.filter((turn) => turn?.role === "assistant").map((turn) => String(turn.content || ""));

// เทิร์นลูกค้าหลังเทิร์นแรกที่อ่านระดับ AI ได้ (นับเทิร์นปัจจุบันด้วย)
function discoveryDepthOf(history, text) {
  const turns = [...history, { role: "user", content: text }];
  let first = -1;
  let depth = 0;
  turns.forEach((turn, i) => {
    if (turn?.role !== "user") return;
    if (first >= 0) { depth += 1; return; }
    if (detectAiLevel(String(turn.content || ""), { history: turns.slice(0, i) }) !== null) first = i;
  });
  return depth;
}

/**
 * ระดับที่ลูกค้าบอกแล้วหรือบอกเป็นนัย (v3 เท่านั้น — routing/คลาส/คำตัดสินราคาไม่ถูกแตะ)
 * รีวิวเคสจริงทั้งวัน 5 ต.ค.: ห้องที่ตอบคำถามต้อนรับในโฆษณาว่า ยังไม่เคย/ทำไม่เป็น/เคยบ้าง ได้บันไดถามระดับซ้ำ 6 ห้อง
 * detected = ตัวอ่านระดับของเครื่องเดิมอ่านได้ · opening_never / opening_used = คำตอบเปิดห้อง (ก่อนที่ลูกแพร/ทีมงานจะถามอะไร)
 * @returns {{level: number, source: string, at: number} | null} at = ตำแหน่งเทิร์นลูกค้าใน [...history, ข้อความนี้]
 */
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): ข้อความแรกบอกว่ายังไม่เคย แล้วเทิร์นต่อมาเล่าว่าใช้ ChatGPT ทุกวัน/ใช้เก่ง พรอมต์ยังบอกโมเดลว่า "ยังไม่เคยใช้"
// · ข้อความแรกบอกว่าสร้าง GPTs เองแล้ว แต่คำถามคัดกรองถามซ้ำว่าเคยสร้าง Custom AI หรือยัง
// — ระดับ/ที่มา = สิ่งที่ลูกค้าบอกล่าสุด · at = เทิร์นแรกที่บอก (ความลึกของการคุยนับจากตรงนั้นเหมือนเดิม)
const SAID_USED_RE = /(?<!ไม่(?:ได้|เคย|ค่อย)?\s?)(?:เคยใช้(?:แล้ว|มา|บ้าง)|ใช้(?:อยู่|ประจำ|ทุกวัน|เก่ง|คล่อง)|ใช้\s?(?:chat\s*-?gpt|gemini|claude|copilot))/iu;
const SAID_BUILT_RE = /(?<!ไม่(?:ได้|เคย)?\s?)สร้าง\s?\S{0,12}?\s?(?:gpts?|custom|ผู้ช่วย|บอท|bot|แชทบอท|ระบบอัตโนมัติ|automation|workflow|agent|เอเจน)[^\n?？]{0,14}?(?:แล้ว|ได้|เป็น(?!\s*(?:ไหม|มั้ย)))/iu;
// พี่ง้วง 12 ต.ค. (แชทจริง 11 ต.ค.: "สนใจค่ะตอนนี้ใช้ ChatGPT เขียนระบบ…" · "เคยแต่แต่งภาพ นิดหน่อยครับ" ได้บันได 5 ระดับ + รูป
// ที่มีข้อ "ยังไม่เคยใช้เลย") — ข้อความเปิดห้องที่เล่าว่าใช้ AI อยู่แล้ว แม้ไม่ได้ขึ้นต้นประโยคด้วยคำนั้น = บอกระดับแล้ว
// · ใช้ + ชื่อ AI ที่ไม่ใช่ความอยาก/คำถาม/การเรียน ("อยากใช้ ChatGPT" · "ใช้ AI ทำอะไรได้บ้าง" · "สอนใช้ Gemini ไหม" · "ใช้ AI ไม่เป็น" ไม่นับ)
// · เคย…นิดหน่อย/บ้าง/แล้ว ("เคยดูคลิป…" · "เคยเรียนที่อื่น" · "เคยสมัคร" ไม่นับ) — ตัวจับเป็นคำตายตัว + ช่วงสั้นที่มีขอบเขต
const AI_NAME = "(?:chat\\s?-?gpt|แชทจีพีที|gemini|เจมิไน|claude|copilot|\\bai\\b|เอไอ)";
const OPENING_USES_AI_RE = new RegExp(`(?<!ไม่(?:ได้|เคย|ค่อย)?\\s?|อยาก\\S{0,4}|จะ\\s?|ต้อง\\s?|ให้\\s?|การ|วิธี|สอน\\s?|เรียน\\s?|หัด\\s?)ใช้\\s?${AI_NAME}`
  + "|(?<!ไม่(?:ได้|เคย|ค่อย)?\\s?)ใช้(?:อยู่|ประจำ|ทุกวัน|เป็นประจำ|บ่อย|คล่อง)", "iu");
const OPENING_USE_NOT_SELF = /^[^\n]{0,24}?(?:ไหม|มั้ย|มั๊ย|ยังไง|อย่างไร|อะไร|ไหน|[?？]|ไม่(?:เป็น|ค่อย|เก่ง|ได้)|ได้(?:ไหม|มั้ย|บ้าง))/u;
// รอบรีวิว 12 ต.ค.: "เคยคุยกับแอดมินไปแล้วค่ะ" (เคยติดต่อเรา ไม่ใช่เคยใช้ AI) เคยนับเป็นบอกระดับ — เคย + คุย/ถาม/โทร/แชท/ส่ง/จอง/โอน ไม่นับ
const OPENING_TRIED_RE = /^\s*เคย(?!เรียน|มา|ติดต่อ|ได้รับ|ได้ยิน|ได้คุย|ทัก|สมัคร|ซื้อ|เห็น|ดู|ไป|ฟัง|อ่าน|ลง|คุย|ถาม|โทร|แชท|ส่ง|จอง|โอน|ปรึกษา|ไลน์|อินบ็อกซ์|inbox)[^\n?？]{0,30}?(?:นิดหน่อย|นิดนึง|บ้าง|แล้ว|ประจำ)/iu;
// รอบรีวิว 12 ต.ค.: "ลูกค้าใช้ AI…" (คนอื่นเป็นคนใช้) ไม่ใช่ระดับของเขา — ดูแค่ไม่กี่ตัวอักษรก่อนคำว่า ใช้
const OTHER_USER_RE = /(?:ลูกค้า|พนักงาน|ลูกน้อง|คนอื่น|คนใน\S{0,6}|ทีม(?:งาน)?|เพื่อน|คู่แข่ง|หลายคน|ใคร\s?ๆ|คนส่วนใหญ่|ร้านอื่น|ที่อื่น)\s?\S{0,10}?\s?$/u;
const OTHER_USER_LOOKBACK = 16;
function openingSaysUsed(line = "") {
  if (OPENING_TRIED_RE.test(line)) return true;
  const hit = OPENING_USES_AI_RE.exec(line);
  if (!hit || OTHER_USER_RE.test(line.slice(Math.max(0, hit.index - OTHER_USER_LOOKBACK), hit.index))) return false;
  return !OPENING_USE_NOT_SELF.test(line.slice(hit.index + hit[0].length));
}

// generalWelcome = คำถามต้อนรับในโฆษณาถามการใช้ AI ทั่วไป ("ยัง" = ยังไม่เคยใช้ AI) · ไม่ใช่/ไม่รู้ = ถามเรื่อง AI Agent (คำปฏิเสธเปล่า ๆ ยังไม่บอกระดับ)
export function impliedLevelOf(history = [], text = "", { generalWelcome = false } = {}) {
  const turns = [...(Array.isArray(history) ? history : []), { role: "user", content: String(text || "") }];
  let first = null;
  let latest = null;
  // คำตอบเปิดห้องแบบ "ยัง" ต่อคำถามเรื่อง AI Agent (ยังไม่บอกระดับ) — ถ้าเล่าทีหลังว่าใช้ AI อยู่ ความลึกยังนับจากข้อความแรก
  let ambiguousAt = null;
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i]?.role !== "user") continue;
    const value = String(turns[i].content || "");
    const before = turns.slice(0, i);
    const level = detectAiLevel(value, { history: before });
    let hit = level !== null ? { level, source: "detected", at: i } : null;
    if (!hit && !roomHasBotQuestion(before)) {
      // รอบรีวิว 12 ต.ค.: "ตอนนี้ใช้ ChatGPT ทุกวันค่ะ\nสร้าง GPTs ใช้เองแล้ว อยากต่อยอด" เคยหยุดที่บรรทัดแรก (ระดับ 2) — สร้างเองแล้ว (ระดับ 5)
      // ที่บรรทัดไหนก็ได้ของข้อความเปิดห้องชนะการอ่านทีละบรรทัด
      if (SAID_BUILT_RE.test(value)) hit = { level: 5, source: "opening_built", at: i };
      else for (const line of value.split(/\n+/u)) {
        if (SAID_BUILT_RE.test(line)) { hit = { level: 5, source: "opening_built", at: i }; break; }
        if (OPENING_NEVER_RE.test(line)) {
          if (ambiguousNegative(line, value, generalWelcome)) { ambiguousAt ??= i; continue; }
          hit = { level: 1, source: "opening_never", at: i }; break;
        }
        if (OPENING_USED_RE.test(line) || openingSaysUsed(line)) { hit = { level: 2, source: "opening_used", at: i }; break; }
      }
    } else if (!hit && (first || ambiguousAt !== null)) {
      if (SAID_BUILT_RE.test(value)) hit = { level: 5, source: "said_built", at: i };
      else if ((latest?.source === "opening_never" || (!latest && ambiguousAt !== null)) && SAID_USED_RE.test(value)) {
        hit = { level: 2, source: "said_used", at: i };
      }
    }
    if (!hit) continue;
    // ระดับที่ตอบใต้บันได (detected) นับความลึกจากเทิร์นนั้น · เล่าเองทีหลัง (said_*) นับจากข้อความแรกเหมือนเดิม
    first = first || (ambiguousAt !== null && hit.source.startsWith("said_") ? { ...hit, at: ambiguousAt } : hit);
    latest = hit;
  }
  return first ? { ...latest, at: first.at } : null;
}

// feedback ทีม 10 ต.ค.: "ยัง / ไม่เคย / ยังไม่ได้ใช้" ต่อคำถามโฆษณาเรื่อง AI Agent = ยังไม่รู้ว่าใช้ AI ทั่วไประดับไหน (ไม่ใช่ระดับ 1)
// รีวิวปรปักษ์ 10 ต.ค.: ข้อความที่เล่าเรื่องเงิน/ความกังวล/ทำไม่เป็นมาด้วย ("ยังครับ\nไม่มีเงิน ตกงานอยู่") อ่านตามเดิม (ดูแลใจ/ให้กำลังใจก่อน)
const OPENING_CONTEXT_RE = /ไม่มีเงิน|ตกงาน|ว่างงาน|ป่วย|ไม่สบาย|โรงพยาบาล|กลัว|ไม่มั่นใจ|ไม่ไหว|แพง|งบ|ยืมเงิน|เครียด|ตื๊อ|ไม่สนใจ|ไม่ต้องการ|ทักผิด|กดผิด|ไม่ได้ตั้งใจ|ไม่(?:ค่อย)?เป็น|มือใหม่/u;
const ambiguousNegative = (line, value, generalWelcome) => !generalWelcome && bareNegativeOpening(line)
  && !GENERAL_AI_MENTION_RE.test(line) && !OPENING_CONTEXT_RE.test(value);
/** ข้อความเปิดห้องที่ตอบคำถามโฆษณาเรื่อง AI Agent ว่ายัง/ไม่เคย (ยังไม่มีคำถามของลูกแพรหรือทีมงาน และยังไม่บอกระดับ) */
export function agentOpeningOf(history = [], text = "", { generalWelcome = false } = {}) {
  if (generalWelcome || roomHasBotQuestion(Array.isArray(history) ? history : [])) return false;
  if (impliedLevelOf(history, text, { generalWelcome })) return false;
  return String(text || "").split(/\n+/u).some((line) => OPENING_NEVER_RE.test(line) && ambiguousNegative(line, text, generalWelcome));
}

// feedback ทีม 10 ต.ค.: คำตอบที่เป็นแค่หมวดงานจากตัวเลือกของลูกแพร ("งานขายครับ" · "คอนเทน" + "ขาย" · "งานเอกสาร คอนเทนต์")
// ยังไม่บอกว่าทำธุรกิจอะไรหรืออยากให้ AI ช่วยส่วนไหน — ข้อความที่มีเรื่องของเขาเอง ("ขายเสื้อผ้าออนไลน์") ไม่นับ
const TASK_CATEGORY_RE = /ขาย|คอนเทน|content|เอกสาร|โพสต์|post|แชท|chat|ตอบ|ตลาด|marketing|สรุป|รูป|ภาพ|วิดีโอ|วีดีโอ|คลิป|รายงาน/iu;
const TASK_PICK_WORDS = /งาน|การ|ด้าน|ขาย|คอนเทนต์|คอนเทน|content|เอกสาร|โพสต์|post|ตอบ|แชท|chat|ลูกค้า|ตลาด|marketing|สรุป|รูป|ภาพ|วิดีโอ|วีดีโอ|คลิป|รายงาน|ทั้งหมด|ทุกอย่าง|ทั้ง|สอง|และ|กับ|หรือ|ด้วย|ก่อน|อันดับ|แรก|เรื่อง|ข้อ|อยาก|ให้|ช่วย|เป็นหลัก|หลัก|ครับผม|ครับ|คับ|ค่ะ|คะ|ค่า|จ้า|นะ|เลย/giu;
const TASK_PICK_MAX = 30;
export function bareTaskPickOf(text = "") {
  const raw = String(text || "").replace(/[\s,./!?()·•+&-]+/gu, "");
  if (!raw || [...raw].length > TASK_PICK_MAX || !TASK_CATEGORY_RE.test(raw)) return false;
  return [...raw.replace(TASK_PICK_WORDS, "")].length <= 2;
}

// ก้อนข้อความลูกค้าหลังก้อนที่บอกระดับเป็นนัย (นับก้อนปัจจุบันด้วย) — ความลึกของการคุยนับจากตรงนั้นเหมือนระดับที่ตรวจเจอ
// นับเป็นก้อน ไม่ใช่แถว: "ยัง" + บับเบิลขอข้อมูลต่อท้าย คือข้อความเปิดห้องก้อนเดียว (นับแถวทำให้เชื่อมเข้าคลาสก่อนถามสักข้อ)
function depthAfter(history, text, at) {
  if (!Number.isInteger(at)) return 0;
  const turns = [...history, { role: "user", content: text }];
  let depth = 0;
  for (let i = at + 1; i < turns.length; i += 1) {
    if (turns[i]?.role === "user" && turns[i - 1]?.role !== "user") depth += 1;
  }
  return depth;
}

// ลูกค้างงคำถามต้อนรับในโฆษณา (ยังไม่มีคำถามของเราในห้อง) — ข้อความที่มีชื่อ AI/คลาส คือถามแนวคิด
const confusedOpeningOf = (history, text) => !roomHasBotQuestion(history) && CONFUSED_RE.test(text) && !AI_TERM_RE.test(text)
  && !CONFUSED_TOPIC_RE.test(text);

function toolsOf(texts) {
  const joined = texts.join("\n");
  return TOOL_NAMES.filter(([test]) => test.test(joined)).map(([, name]) => name);
}

function roundLabel(round) {
  return `${roundWeekdayThai(round)} ${roundShortThai(round)}`;
}

function classRounds(rounds, classKey) {
  const name = CLASS_NAMES[classKey || "business"];
  const open = openRounds(rounds, { perClass: 3 });
  const own = open.filter((round) => String(round.product || round.label || "").includes(name)
    || (classKey !== "workflow" && round.classKey === "basic") || (classKey === "workflow" && round.classKey === "advance"));
  return own.slice(0, 3);
}

function adminLines(history) {
  return botTurns(history).filter((text) => text.startsWith(ADMIN_PREFIX))
    .map((text) => truncateCodePoints(text.slice(ADMIN_PREFIX.length).trim(), 300)).slice(-3);
}

function usedOpeners(history) {
  return botTurns(history).filter((text) => !text.startsWith(ADMIN_PREFIX) && text.trim())
    .slice(-3).map((text) => [...text.trim()].slice(0, 14).join(""));
}

function teamNotesOf(deps, handoffNotes) {
  const safe = typeof deps.promptSafeHandoffNotes === "function" ? deps.promptSafeHandoffNotes(handoffNotes) : [];
  return safe.slice(-3).map((note) => truncateCodePoints(`[${note.author || "ทีมงาน"}] ${note.text || ""}`, 300));
}

// ประวัติยาวของ session (ถ้ามี) — ใช้กับข้อเท็จจริงที่ต้องไม่หายเมื่อห้องคุยยาว: คำแอดมิน เครื่องมือ สิ่งที่ส่งแล้ว ความลึกของการคุย
// คำตัดสินที่ต้องตรงกับเครื่องเดิม (คลาส ระดับ เป้าหมาย บันได รูป รีวิว) ยังใช้ประวัติชุดเดียวกับเครื่องเดิม
function longHistoryOf(input, history) {
  const long = Array.isArray(input.factHistory) ? input.factHistory : [];
  return long.length > history.length ? long : history;
}

// รีวิวเคสจริงทั้งวัน 5 ต.ค.: ห้องร้อนตอบระดับใต้บันไดเป็นช่วง ("สองถึงสาม") ตัวอ่านระดับของเครื่องเดิมไม่รับ ระดับและคลาสเลยว่างทั้งห้อง
// (การ์ดราคาสองคลาส · ตัวนับความลึกไม่ทำงาน) — v3 อ่านช่วงเองเฉพาะตอนเครื่องเดิมอ่านระดับไม่ได้ · ไม่ตั้ง answeredLevel (งานไม่สั่ง "ข้อ N แปลว่า")
function withRangeLevel(routing, longHistory, text) {
  if (routing.level !== null) return routing;
  const range = historyRangeLevel(longHistory, text);
  if (!range) return routing;
  // ระดับเดียว ("stage 3") = ระดับนั้น ไม่ใช่ช่วง (พรอมต์บอก "ระดับ 3 ตามบันได")
  if (range.lo === range.hi) return { ...routing, level: range.lo, product: routing.product || range.product };
  return { ...routing, level: range.lo, levelRange: [range.lo, range.hi], product: routing.product || range.product };
}

// รีวิวเคสจริงทั้งวัน 5 ต.ค. (ห้อง LINE ช่วงค่ำ): ลูกค้าพิมพ์ข้อความนี้ระหว่างที่คำตอบก่อนหน้าของลูกแพรกำลังทยอยส่ง (ไปป์ไลน์จดไว้)
// delivered = บับเบิลที่ถึงมือเขาแล้ว · undelivered = ส่วนที่ด่านกันตอบทับหยุดไว้ (ว่าง = ส่งครบแต่เขาพิมพ์มาระหว่างส่ง)
const OVERLAP_MAX_BUBBLES = 6;
function overlapOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const clean = (list) => (Array.isArray(list) ? list : []).map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, OVERLAP_MAX_BUBBLES);
  const delivered = clean(raw.delivered);
  const undelivered = clean(raw.undelivered);
  if (!delivered.length) return null;
  return { stage: String(raw.stage || ""), delivered, undelivered, cut: undelivered.length > 0 };
}

function signalsOf(input) {
  const text = String(input.text || "");
  const history = Array.isArray(input.history) ? input.history : [];
  const longHistory = longHistoryOf(input, history);
  const disclosure = input.disclosure || {};
  const flags = Array.isArray(input.inboundFlags) ? input.inboundFlags : [];
  const focus = resolveReplyFocus({ text, history });
  const goal = learningGoal({ text, history, painPoint: input.scoreSignals?.painPoint || "" });
  const prevUserText = userTexts(history).at(-1) || "";
  const evidenceHead = goal?.evidence ? goal.evidence.slice(0, 40) : "";
  const answeredDigit = focus?.kind === "opening_short_answer" ? /^(?:ข้อ\s*|เลข\s*)?([1-5])(?!\d)/u.exec(focus.answer || "")?.[1] : null;
  // คำตอบเปิดห้องเป็นคำตอบของคำถามเรื่อง AI Agent เฉพาะเมื่อคำถามต้อนรับถามเรื่องนั้น หรือไม่ได้ตั้งไว้แต่ห้องมาจากโฆษณา Facebook
  // (ห้อง LINE ไม่เคยเห็นคำถามโฆษณา — "ยัง" อ่านตามเดิม)
  const welcome = String(input.adWelcomeQuestion || "").trim();
  const agentContext = welcome ? AGENT_WELCOME_RE.test(welcome) : String(input.customer?.channel_id || "") === FACEBOOK_CHANNEL_ID;
  const generalWelcome = !agentContext;
  const impliedLevel = impliedLevelOf(longHistory, text, { generalWelcome });
  const parts = Array.isArray(input.parts) && input.parts.length ? input.parts.map(String) : [text];
  const lastBotText = lastBotBurstOf(history);
  let directTrialLinkRequest = null;
  if (TRIAL_TOPIC.test(text)) for (const clause of text.split(/(?:แต่(?:ว่า|ก็)?|อย่างไรก็ตาม|ทว่า)|[\n.!?。！？]+|(?:ค่ะ|ครับ|คะ|ค่า)\s+/u)
    .map((item) => item.trim()).filter(Boolean)) {
    const mentionsLink = /ลิงก์/u.test(clause);
    const requestsLink = TRIAL_LINK_DIRECT_REQUEST.test(clause);
    if (mentionsLink) {
      if (TRIAL_LINK_REQUEST_DENIAL.test(clause)) directTrialLinkRequest = false;
      else if (requestsLink) directTrialLinkRequest = true;
      continue;
    }
    // ภาษาพูดละ target ใน clause หลังได้ เช่น “ขอลิงก์... แต่ยังไม่ต้องส่ง”
    // ย้อนทับได้เฉพาะเมื่อไม่มีเป้าหมายอื่นชัด (ค่าใช้จ่าย/คลาสเสียเงิน/สมัคร)
    if (directTrialLinkRequest !== null && !TRIAL_LINK_OTHER_TARGET.test(clause) && TRIAL_LINK_CARRIED_DENIAL.test(clause)) {
      directTrialLinkRequest = false;
    }
  }
  const trialLinkRequested = directTrialLinkRequest === true
    || (history.at(-1)?.role === "assistant" && TRIAL_TOPIC.test(lastBotText)
      && (ANAPHORIC_BUSINESS_FOLLOWUP.test(text.trim()) || TRIAL_LINK_ANAPHORA.test(text.trim())));
  const businessTopicFollowup = history.at(-1)?.role === "assistant" && BUSINESS_TOPIC_IN_BOT.test(lastBotText)
    && (ANAPHORIC_BUSINESS_FOLLOWUP.test(text.trim())
      || (TRIAL_TOPIC.test(lastBotText) && TRIAL_LINK_ANAPHORA.test(text.trim())));
  // “คลาสเดียวกัน/คลาสที่คุยกัน” ผูกกับคลาสเดียวที่เอ่ยในก้อนล่าสุดชั่วคราวเท่านั้น
  // ไม่ใช่หลักฐานว่าลูกค้าเลือกคลาสนั้น และก้อนที่เอ่ยสองคลาสยังคงไม่ชี้คลาส
  const discussedClassKey = SAME_COURSE_REFERENCE.test(text) ? classInText(lastBotText) : null;
  return {
    impliedLevel,
    agentOpening: agentOpeningOf(longHistory, text, { generalWelcome }),
    bareTaskPick: bareTaskPickOf(parts.join("\n")),
    // ข้อความนี้คือคำตอบเปิดห้องของคำถามต้อนรับในโฆษณา (รูปไหนก็ได้ ไม่ใช่แค่คำตอบคำเดียว)
    // รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "ยังไม่เคยใช้เลยค่ะ ทำไม่เป็น" ที่ตัวอ่านระดับของเครื่องเดิมอ่านได้เอง (ที่มา detected) ไม่เคยนับเป็นคำตอบเปิดห้อง
    // เลยเข้าตัวเบรกการสอนแล้วได้คำขายยาวเป็นข้อความแรก — นับทุกที่มา ขอแค่เป็นเทิร์นนี้และยังไม่มีคำถามของลูกแพร/ทีมงานในห้อง
    openingAnswer: Boolean(impliedLevel && impliedLevel.at === longHistory.length && !roomHasBotQuestion(longHistory)),
    // ข้อความแรกของลูกแพร/ทีมงานในห้องนี้ = ต้องทักทายและแนะนำตัว
    firstReply: !longHistory.some((turn) => turn?.role === "assistant"),
    userTurns: longHistory.filter((turn) => turn?.role === "user").length + 1,
    confusedOpening: confusedOpeningOf(history, text),
    text, history, longHistory, disclosure, inboundFlags: flags, focus, goal,
    parts,
    burstCount: Math.max(1, (input.parts || []).length),
    money: asksAboutMoney(text) || flags.includes("asks_discount") || Boolean(disclosure.acceptedPriceOffer),
    goalFresh: Boolean(goal && (goal.source === "scorer" || (evidenceHead && (text.includes(evidenceHead) || prevUserText.includes(evidenceHead))))),
    answeredLevel: Number.isInteger(focus?.level) ? focus.level : (answeredDigit ? Number(answeredDigit) : null),
    routing: withRangeLevel(resolveClassRouting({ text, history }), longHistory, text),
    openingShortAnswer: isOpeningShortAnswer({ text, history }),
    sales: resolveSalesStage({ text, history, leadScore: Number.isInteger(input.customer?.last_score) ? input.customer.last_score : null }),
    fatigue: hasRecentFatigue({ text, history }),
    hesitates: customerHesitates(text),
    confidence: CONFIDENCE_TURN.test(text),
    discoveryDepth: Math.max(discoveryDepthOf(longHistory, text), depthAfter(longHistory, text, impliedLevel?.at)),
    // รีวิวเคสจริงทั้งวัน 5 ต.ค.: คำถามทำความรู้จักที่ลูกแพรถามติดกัน (นับได้แม้ไม่รู้ระดับ) · คนทำเล่นที่ตอบว่าไม่มีงานจะใช้
    discoveryStreak: discoveryStreakOf(history),
    hobbyNoWork: hobbyNoWorkOf(longHistory, text),
    prevRole: history.at(-1)?.role || "",
    lastBotText, discussedClassKey, businessTopicFollowup, trialLinkRequested,
    // ตัวปิดของสองเทิร์นล่าสุดของลูกแพร (เคสจริง 5 ต.ค.: ชวนดูรอบซ้ำทุกเทิร์นทั้งที่ลูกค้าไม่ตอบ) — ตัวตัดสินจังหวะคัดตัวที่ลูกค้ารับแล้วออก
    recentClosings: recentClosings(history),
    prevUserText,
    continuation: input.continuation || null,
    coachingBrake: Boolean(String(input.coachingBrake || "").trim()),
    scheduleCheck: Boolean(String(input.scheduleCheckRule || "").trim()),
    overlap: overlapOf(input.overlap),
  };
}

// ห้องเก่าก่อน v3.8 ยังไม่มี continuity metadata: ยกเฉพาะข้อเสนอในก้อน assistant ล่าสุดจริง
// เข้าสู่ envelope ชั่วคราว เพื่อให้คำตอบเทิร์นนี้พกข้อเสนอที่ยังไม่จบต่อไปได้ ไม่ค้นย้อนข้ามคนหรือก้อนใหม่กว่า
function bootstrapPendingOffer(s) {
  if (s.prevRole !== "assistant") return null;
  const lastTurn = s.history.at(-1);
  if (lastTurn?.operator || String(lastTurn?.content || "").startsWith(ADMIN_PREFIX)) return null;
  const closing = s.recentClosings.find((item) => item.latest !== false && (item.types || []).length);
  const type = CONTINUITY_OFFER_TYPE[closing?.types?.[0]];
  // registration/round/price คงตัวอ่านและ handoff เดิมทุกไบต์; migration นี้มีไว้กัน informational promise หายหลังเทิร์นคั่น
  if (!closing || !LEGACY_CARRY_OFFER_TYPES.has(type)) return null;
  return {
    type, status: "pending", text: closing.text,
    ...(classInText(s.lastBotText) ? { courseKey: classInText(s.lastBotText) } : {}),
    source: "deterministic", confidence: "verified", current: true,
  };
}

function contextEnvelopeFor(input, s, decision = {}) {
  const normalized = normalizeContextEnvelope(input.contextEnvelope, { facts: s, decision, userText: s.text });
  if (normalized.pendingOffer) return normalized;
  // recentTurns ไม่มี delivery metadata จึงห้ามเดาว่า legacy bubble ส่งครบเอง;
  // caller เปิด migration ได้หลังตรวจ latest outbound row และขอบเขต session แล้วเท่านั้น
  if (input.contextEnvelope?.legacyOfferBootstrapAllowed !== true) return normalized;
  const pendingOffer = bootstrapPendingOffer(s);
  if (!pendingOffer) return normalized;
  return normalizeContextEnvelope({ ...(input.contextEnvelope || {}), pendingOffer }, { facts: s, decision, userText: s.text });
}

function assetsOf(input, s, deps) {
  const allowedImages = input.approvedImageKeys instanceof Set ? input.approvedImageKeys : new Set(input.approvedImageKeys || []);
  const sentImageKeys = Array.isArray(input.sentImageKeys) ? input.sentImageKeys : [];
  const sentUrls = input.reviewContext?.sentUrls instanceof Set ? input.reviewContext.sentUrls : new Set();
  const reviewsShared = typeof deps.reviewLinkShared === "function" ? deps.reviewLinkShared(s.history, sentUrls) : sentUrls.size > 0;
  // ladderRule = กติกาเดียวกับเครื่องเดิม (เทสต์ parity ล็อก) · ladderSkip = วิจารณญาณที่โมเดลของเครื่องเดิมใช้เอง ("ไม่ต้องส่งบันไดถามระดับซ้ำ")
  // ทำเป็นกติกาของ v3 — รีวิวเคสจริงทั้งวัน 5 ต.ค.: รู้ระดับเป็นนัยแล้ว / งงคำถามในโฆษณา / ห้องเคยได้ราคาแล้ว ยังได้เมนู 5 ระดับ + รูป
  // soul v1.1 C6 (20 ต.ค. 2026): ลูกค้าที่มาด้วยเรื่อง LINE / Facebook / ที่ปรึกษา ไม่ได้บันไดระดับการใช้ AI (ปกติเทิร์นแบบนี้ไปเครื่องเดิมอยู่แล้ว)
  const serviceTopic = NON_AI_SERVICE_TOPIC.test(String(s.text || ""));
  const ladderRule = s.history.length === 0 && !s.disclosure.careMode && allowedImages.has(LADDER_IMAGE_KEY) && !s.openingShortAnswer && !serviceTopic;
  const priceQuoted = Number(input.customer?.price_quoted_at || 0) > 0
    || botTurns(s.longHistory).some((text) => outboundCarriesClassPrice(text, input.approvedAmounts));
  const bots = botTurns(s.longHistory);
  const ladderShown = bots.some((text) => KEYCAP_LINE.test(text)) || sentImageKeys.includes(LADDER_IMAGE_KEY);
  // พี่ง้วง 12 ต.ค.: ข้อความเปิดห้อง (ยังไม่มีคำถามของลูกแพร/ทีมงาน ยังไม่ได้ราคา ยังไม่เคยส่งบันได) ที่บอกว่าจะสมัคร = ไม่ส่งบันได
  const enrollOpening = enrollIntentOf(s.text) && !priceQuoted && !ladderShown && !roomHasBotQuestion(s.longHistory) && !s.disclosure.careMode;
  const ladderSkip = Boolean(s.impliedLevel || s.confusedOpening || priceQuoted || enrollOpening);
  // feedback ทีม 10 ต.ค.: ตอบ "ยังครับ" ต่อคำถามโฆษณาเรื่อง AI Agent = ประเมินพื้นฐานการใช้ AI ทั่วไปด้วยบันไดก่อน (ทีมงานเองก็ส่งบันไดในห้องแบบนี้)
  const agentLadder = Boolean(s.agentOpening) && !s.disclosure.careMode && !priceQuoted && !ladderShown && !enrollOpening && !serviceTopic;
  const asksImage = typeof deps.customerAsksForImage === "function" ? deps.customerAsksForImage(s.text) : false;
  let imageOffer = typeof deps.decideImageOffer === "function" ? deps.decideImageOffer({
    currentText: s.text, history: s.history, allowedImages, sentImageKeys, sentAtmosphereKeys: input.sentAtmosphereKeys || [],
    closingTurn: false, careMode: s.disclosure.careMode, nurture: input.nurture === true, reviewsShared,
  }) : null;
  const referencedPoster = COURSE_POSTER_KEY[s.discussedClassKey];
  if (!imageOffer && asksImage && referencedPoster && allowedImages.has(referencedPoster) && !sentImageKeys.includes(referencedPoster)) {
    imageOffer = { key: referencedPoster, explicitAsk: true, mustAttach: true, servicePoster: false, reference: "latest_discussed_course" };
  }
  const catalog = parseCatalogText(input.approvedKnowledge || "");
  const review = catalog.length && input.reviewContext ? selectJourneyEvidence(catalog, input.reviewContext).selected[0] || null : null;
  return {
    allowedImages, sentImageKeys, ladderRule, ladderSkip, agentLadder, serviceTopic, enrollOpening, imageOffer, review, reviewsShared, sentReviewCount: sentUrls.size,
    ladderShown,
    // feedback ทีม 10 ต.ค.: บอกเรื่องเตรียมงาน/Laptop มาใช้ใน Workshop ไปแล้วในห้องนี้ (ไม่ทวนซ้ำ)
    prepSaid: bots.some((text) => WORKSHOP_PREP_RE.test(text)),
    posterSent: COURSE_POSTERS.some((key) => sentImageKeys.includes(key)),
    priceQuoted,
    asksImage,
    outlineSent: (input.sentCourseOutlines?.size || 0) > 0,
    // ตรวจคิว 13 ต.ค.: ลูกแพรเคยเสนอส่งหัวข้อในห้องนี้แล้ว (ทุกถ้อยคำ) — ไม่เสนอซ้ำ
    outlineOffered: bots.some((text) => OUTLINE_OFFER_SEEN.test(text)),
    // ตรวจคิว 13 ต.ค.: ประโยคขายคลาสเดิม ("คลาส … จะได้ลงมือวาง Flow…") ซ้ำทุกเทิร์นในห้องเดียว — เล่าไปแล้วในก้อนล่าสุด ๆ = ไม่เล่าซ้ำ
    classPitched: bots.slice(-6).some((text) => CLASS_PITCH_SEEN.test(text)),
    // ตรวจคิว 13 ต.ค.: ทีมงานคนจริงเพิ่งคุยในห้อง (ส่งลิงก์ Zoom/นัดคุยกับพี่ง้วง) ลูกค้าทักสวัสดี แล้วได้สคริปต์ขาย + ชวนเลือกรอบ
    // คนตอบล่าสุดในห้องคือทีมงาน (ยังไม่มีลูกแพรพูดต่อจากทีม) — ข้อเสนอที่ลูกแพรเพิ่งเสนอเองยังเดินตามปกติ
    adminRecent: ADMIN_TURN_RE.test(String((Array.isArray(s.longHistory) ? s.longHistory : []).filter((turn) => turn?.role === "assistant").at(-1)?.content || "")),
  };
}

function roomOf(input, s, contextEnvelope) {
  // รีวิวเคสจริงทั้งวัน 5 ต.ค.: ลูกแพรแนะนำคลาสเดียวไปแล้ว (ยังไม่รู้ระดับ) แต่การ์ดราคาโชว์สองคลาส แล้วปิดด้วยคำถามคัดกรองหลังราคา
  // — ระดับที่รู้ชนะเสมอ · ลูกค้าเอ่ยชื่อคลาสเอง · ไม่งั้นคลาสที่ลูกแพรเพิ่งแนะนำ
  // รีวิวเคสจริง 6–7 ต.ค.: ลูกค้าบอกเองว่าอยากเรียนคลาสไหน ("อยากลงคลาส Advance" หลังตอบระดับ 5) ชนะระดับ — การ์ดราคา รอบ ดีล และคำปิดเป็นของคลาสนั้น
  // รอบรีวิว 8: อยากเรียน Workflow ที่ระดับ ≤4 = เริ่มจาก Business (การ์ดสองคลาส Business ก่อน + บอกหนึ่งประโยคว่าต่อยอดกันอย่างไร)
  const { wished: wishedRaw, beyondLevel } = classWishOfRoom(s);
  const wished = beyondLevel ? null : wishedRaw;
  const currentClass = (beyondLevel ? "business" : wished) || classInText(s.text) || s.discussedClassKey || null;
  const activeClass = contextEnvelope?.activeCourse?.key || null;
  const classKey = currentClass || activeClass || PRODUCT_CLASS[s.routing.product] || recommendedClassOf(s.longHistory) || null;
  const allOpen = (Array.isArray(input.rounds) ? input.rounds : []).filter(isOpenRound);
  const own = classKey ? classRounds(allOpen, classKey) : [];
  const shownRounds = roundsMentionedIn(botTurns(s.longHistory), allOpen);
  const address = planCustomerAddress({ knownName: input.customer?.known_name || "", displayName: input.customer?.display_name || "", history: s.history });
  return {
    classKey, className: classKey ? CLASS_NAMES[classKey] : "",
    classLabel: (beyondLevel ? WISH_BEYOND_LABEL : wished ? WISHED_LABEL[wished]
      : activeClass && classKey === activeClass ? `${contextEnvelope.activeCourse.label || CLASS_NAMES[activeClass]} (เลือกไว้ก่อนหน้านี้)` : CLASS_LABEL[classKey]) || "",
    classWished: Boolean(wished), customerSelectedClassKey: wishedRaw || "", wishBeyondLevel: beyondLevel,
    address, todayIso: String(input.todayIso || ""),
    rounds: own, allRounds: allOpen, roundLabels: own.map(roundLabel),
    // พี่ง้วง 12 ต.ค.: ทักแรกที่ยังไม่รู้คลาสแต่ถามวันเรียน / บอกว่าจะสมัคร = ตอบด้วยรอบจริงของแต่ละคลาส (ไม่ใช่ "ยังยืนยันไม่ได้")
    openingRounds: { business: classRounds(allOpen, "business").map(roundLabel), workflow: classRounds(allOpen, "workflow").map(roundLabel) },
    // รีวิวเคสจริงทั้งวัน 5 ต.ค.: ถามวันที่ที่เป็นรอบของอีกคลาส/ไม่มีรอบ แล้วไม่มีข้อเท็จจริงของวันนั้นเลย (รอบที่โมเดลเห็นมีแค่สามรอบแรกของคลาสนี้)
    // รอบเต็ม/ปิดของวันนั้น = บอกตามจริงว่าเต็ม · รอบที่ใกล้ที่สุดเลือกจากรอบที่ยังไม่เคยบอก (รีวิวเคสจริงทั้งวัน 5 ต.ค. รอบรีวิว)
    requestedDate: dateFitOf(requestedDateOf(s.text, String(input.todayIso || "")), {
      allRounds: allOpen, classKey, shownDates: shownRounds.map((round) => round.date),
      closedRounds: (Array.isArray(input.rounds) ? input.rounds : []).filter((round) => round?.date && !isOpenRound(round)),
    }),
    roundsSent: shownRounds.length > 0,
    // รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "เสาร์ที่ 25 มีเรียนไหม" (25 ต.ค. เป็นวันอาทิตย์) ไม่เดาวันที่ = บอกรอบที่เปิดแล้วถามว่าสะดวกรอบไหน
    roundDayAsked: roundDayAskOf(s.text),
    tools: toolsOf([...userTexts(s.longHistory), s.text]),
    painPoint: String(input.scoreSignals?.painPoint || ""),
    // พี่ง้วง 12 ต.ค. (ข้อ 6 "scoring luna ต้องช่วยในเรื่องนี้ด้วย"): การอ่านความพร้อมรับราคาของ scorer รอบล่าสุด
    // ตรวจทรงซ้ำที่นี่ (รายการปิด) · ไม่มี/ทรงพัง = null = งานแบ่งรับ/แจ้งราคาแบบทั่วไป · ถ้อยคำของ scorer ไม่ถึงพรอมต์ (เหลือแค่คีย์)
    priceRead: pickPriceRead(input.scoreSignals?.priceRead),
    adminLines: adminLines(s.longHistory), usedOpeners: usedOpeners(s.history),
    hashtagNote: truncateCodePoints(String(input.customer?.hashtag_note || ""), 300),
    // 19 ต.ค. 2026: ลูกค้ากดปุ่มทักไลน์จากหน้าเคส/หน้ารีวิวบนเว็บ (รหัส เคส WF-… / รหัส RV-… ในข้อความ) — "" = ไม่ได้กดมา
    arrivalNote: arrivalNoteFor({ text: s.text, history: s.longHistory, entries: input.knowledgeEntries || [], knowledgeText: input.approvedKnowledge || "" }),
    adWelcomeQuestion: String(input.adWelcomeQuestion || "").trim(),
    tagRules: truncateCodePoints(composeTagRules({ tags: input.customerTags || [], productRules: input.productRules || "" }).join("\n"), 800),
  };
}

// รีวิวเคสจริง 6–7 ต.ค.: รอบที่ลูกค้าเลือกไว้ในห้องนี้ (ตัวจับเลือกรอบตัวเดียวกับเทิร์น อ่านย้อนจากใหม่ไปเก่า) — "" = ยังไม่เคยเลือก
// วันที่ที่ลูกค้าพิมพ์สั้น ๆ ("เสาร์ 17") จับคู่กับรอบที่ลูกแพรบอกไว้ก่อนหน้า (หรือรอบที่ลูกแพรทวนในก้อนถัดมา) และต้องยังเปิดอยู่
function pickedRoundOf(history = [], openList = []) {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role !== "user") continue;
    const before = turns.slice(0, i);
    const text = String(turns[i].content || "");
    if (!roundPickedIn({ text, lastBotText: lastBotBurstOf(before), prevRole: before.at(-1)?.role || "" })) continue;
    const after = [];
    for (let j = i + 1; j < turns.length && turns[j]?.role === "assistant"; j += 1) after.push(String(turns[j].content || ""));
    const offered = roundsMentionedIn([lastBotBurstOf(before)], openList);
    // วัน/เดือนแบบตัวเลข ("เสาร์14/11") = จับคู่ทั้งวันและเดือน (เลขเดือนไม่ถูกอ่านเป็นวันของอีกรอบ)
    const numeric = numericRoundPickOf(text, lastBotBurstOf(before));
    const days = new Set(numeric ? [numeric.day] : (text.match(/\d{1,2}/gu) || []).map(Number));
    const round = offered.find((item) => days.has(Number(String(item.date).slice(8, 10)))
      && (!numeric || Number(String(item.date).slice(5, 7)) === numeric.month))
      || (roundsMentionedIn(after, openList).length === 1 ? roundsMentionedIn(after, openList)[0] : null);
    return round ? roundLabel(round) : "";
  }
  return "";
}

// ลูกค้าขอดูทั้งสองคลาส/เทียบกัน หรือเอ่ยถึงอีกคลาสเอง = การ์ดสองคลาส
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): ยังไม่รู้ระดับ แล้วลูกค้าบรรยายคลาสที่ถาม ("อันที่สอน…" / "ตัวขั้นสูง") แต่ชี้คลาสเดียวไม่ได้
// = ไม่ตัดเหลือคลาสที่ลูกแพรเพิ่งแนะนำ (เคยได้การ์ดคลาสพื้นฐานทั้งที่ถามคลาสต่อยอด)
function priceProducts(classKey, text = "", { levelKnown = true, wished = false, beyondLevel = false, discussed = false } = {}) {
  if (!classKey || BOTH_CLASSES_ASK.test(String(text)) || beyondLevel) return ["business", "workflow"];
  const asked = classInText(text);
  // รีวิวเคสจริง 6–7 ต.ค.: ลูกค้าบอกเองว่าอยากเรียนคลาสไหน = การ์ดคลาสนั้นใบเดียว (คำบรรยาย "advance/automation" ไม่เปิดสองคลาส)
  // รอบรีวิว 8 (C1): ข้อความนี้เอ่ยถึงอีกคลาส = การ์ดสองคลาส (คำบอกไม่ทับคลาสที่ถามตอนนี้)
  if (wished) return asked && asked !== classKey ? ["business", "workflow"] : [classKey];
  if (!asked && !levelKnown && CLASS_DESCRIBED_RE.test(String(text)) && !discussed) return ["business", "workflow"];
  return asked && asked !== classKey ? ["business", "workflow"] : [classKey];
}

// พี่ง้วง 12 ต.ค.: ข้อความเปิดห้องที่บอกว่าจะสมัครแต่ยังไม่รู้คลาส = เริ่มจากคลาสพื้นฐาน (ระดับ 1–4 · ตอบ "ยัง" ต่อคำถามเรื่อง AI Agent ก็คือคลาสนี้)
// พร้อมรอบของคลาสนั้น เพื่อชวนเลือกรอบได้เลยโดยไม่ต้องผ่านบันได — งานของเทิร์นบอกว่ามีคลาสต่อยอดสำหรับคนที่สร้าง Custom AI เองแล้ว
function enrollOpeningClass(facts) {
  if (!facts.enrollOpening || facts.classKey) return {};
  // รอบที่ลูกค้าบอกมาเป็นรอบของคลาสต่อยอด = คลาสนั้น (เขาเลือกเอง) · ไม่ได้บอกรอบ = คลาสพื้นฐาน
  const key = facts.enrollRound && classRounds(facts.allRounds || [], "workflow").some((round) => round.date === facts.enrollRound.date)
    ? "workflow" : "business";
  const rounds = classRounds(facts.allRounds || [], key);
  return { classKey: key, className: CLASS_NAMES[key], classLabel: CLASS_LABEL[key], enrollClassDefaulted: !facts.enrollRound,
    rounds, roundLabels: rounds.map(roundLabel) };
}
// รอบที่เปิดอยู่ที่ข้อความเอ่ยถึง: วันที่ + เดือน ("รอบ 31 ต.ค.") หรือ "รอบ 31" ที่ตรงกับรอบที่เปิดรอบเดียว — ไม่เจอ/กำกวม = null
const ROUND_DAY_RE = /รอบ(?:\s*วัน)?(?:\s*(?:เสาร์|อาทิตย์))?(?:\s*ที่)?\s*(\d{1,2})(?!\s*(?:คน|ท่าน|ชั่วโมง|ชม|โมง|นาที|\d))/u;
function enrollRoundNamed(text = "", allRounds = []) {
  const named = roundsMentionedIn([text], allRounds);
  if (named.length === 1) return named[0];
  if (named.length > 1) return null;
  const day = ROUND_DAY_RE.exec(String(text || ""));
  const byDay = day ? (allRounds || []).filter((round) => Number(String(round.date).slice(8, 10)) === Number(day[1])) : [];
  return byDay.length === 1 ? byDay[0] : null;
}

// ช่อง {{ดีล}}: ข้อ 6 รอบรีวิว 2 — ราคาที่ค้างจากเทิร์นแบ่งรับแล้วลูกค้าตอบว่ามากันสองสามท่าน (DEAL_PAIR/price_owed) = เขายังไม่เคยเห็นราคาเลย
// จึงต้องเป็นราคาปกติและโปรโมชั่นต่อท่านก่อน แล้วจึงราคาคู่ (นโยบายข้อ 3 ห้ามนำด้วยส่วนลด) · ขาดตัวใดตัวหนึ่ง = null (กลับเครื่องเดิม)
function dealSlotValue(pf, decision, facts) {
  const deal = renderDealSlot(pf, { product: facts.classKey, n: facts.routing.headcount });
  if (!deal || decision.reason !== "price_owed") return deal;
  const normal = renderPriceSlot(pf, { products: [facts.classKey], withPromo: true });
  return normal ? `${normal}\n\n${deal}` : null;
}
// ดีลคู่ที่อนุมัติของคลาสนี้มีในคลังความรู้ไหม (ตัวตัดสินจังหวะใช้เลือกดีลคู่ให้ราคาที่ค้าง · งานข้อกังวลเรื่องงบใช้บอกทางมาเป็นคู่)
function pairDealAvailableFor(input, facts) {
  const pf = priceFactsFromKnowledge(input.knowledgeEntries || [], input.approvedAmounts);
  return Boolean(facts.classKey && pf.pair?.[facts.classKey]);
}

// ---- ข้อ 6 รอบรีวิว 2: ช่วงที่ลูกค้าบอกว่าจะเริ่มเรียน ("ยังไม่รีบครับ น่าจะต้นปีหน้า") ----
// งานแจ้งราคาที่ค้างจากเทิร์นแบ่งรับต้องไม่ชวนรอบที่เร็วกว่านั้น (เดิมปิดด้วย "สะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค.")
// คืน { label, from: "YYYY-MM" | "", roundLabels } เมื่อช่วงนั้นช้ากว่าเดือนนี้ · null = ไม่ได้บอก หรือบอกว่าเร็ว ๆ นี้/เดือนนี้
// roundLabels = รอบที่เปิดของคลาสนี้ตั้งแต่เดือนนั้น (ไม่รู้เดือน = ว่าง ไม่ชวนรอบไหนเลย) · ทุกตัวจับเป็นคำตายตัว ไม่มีตัวซ้ำ
const TIMING_SOON_RE = /เร็ว\s?ๆ\s?นี้|เดือนนี้|สัปดาห์นี้|อาทิตย์นี้|พร้อมเลย|ทันที|ยิ่งเร็วยิ่งดี|เร็วที่สุด|รอบ(?:ที่)?ใกล้/u;
const TIMING_NEXT_YEAR_RE = /ปีหน้า|ต้นปี|ปีใหม่|ไตรมาส\s?(?:1|แรก)/u;
const TIMING_NEXT_MONTH_RE = /เดือนหน้า/u;
const TIMING_IN_MONTHS_RE = /อีก\s?(\d{1,2})\s?(?:-\s?\d{1,2}\s?)?เดือน/u;
const TIMING_YEAR_END_RE = /ปลายปี|สิ้นปี|ท้ายปี/u;
const TIMING_VAGUE_LATER_RE = /ไม่รีบ|อีกสักพัก|อีกหลายเดือน|ยังไม่ใช่ช่วงนี้/u;
const TIMING_MONTH_RE = /(มกรา|กุมภา|มีนา|เมษา|พฤษภา|มิถุนา|กรกฎา|สิงหา|กันยา|ตุลา|พฤศจิกา|ธันวา)|(?<![ก-๙])(ม\.\s?ค|ก\.\s?พ|มี\.\s?ค|เม\.\s?ย|พ\.\s?ค|มิ\.\s?ย|ก\.\s?ค|ส\.\s?ค|ก\.\s?ย|ต\.\s?ค|พ\.\s?ย|ธ\.\s?ค)(?:\.|(?![ก-๙]))/u;
const MONTH_WORDS = ["มกรา", "กุมภา", "มีนา", "เมษา", "พฤษภา", "มิถุนา", "กรกฎา", "สิงหา", "กันยา", "ตุลา", "พฤศจิกา", "ธันวา"];
const MONTH_ABBRS = ["ม.ค", "ก.พ", "มี.ค", "เม.ย", "พ.ค", "มิ.ย", "ก.ค", "ส.ค", "ก.ย", "ต.ค", "พ.ย", "ธ.ค"];
const TIMING_LABEL_CHARS = 40;
const monthKey = (year, month) => `${year + Math.floor((month - 1) / 12)}-${String(((month - 1) % 12) + 1).padStart(2, "0")}`;
function timingFrom(text, todayIso) {
  const today = /^(\d{4})-(\d{2})-\d{2}$/u.exec(String(todayIso || ""));
  const [y, m] = today ? [Number(today[1]), Number(today[2])] : [null, null];
  const at = (month) => (y === null ? "" : monthKey(y, month));
  if (TIMING_NEXT_YEAR_RE.test(text)) return y === null ? "" : `${y + 1}-01`;
  if (TIMING_NEXT_MONTH_RE.test(text)) return at(m + 1);
  const inMonths = TIMING_IN_MONTHS_RE.exec(text);
  if (inMonths && Number(inMonths[1]) > 0) return at(m + Number(inMonths[1]));
  const named = TIMING_MONTH_RE.exec(text);
  if (named) {
    const idx = named[1] ? MONTH_WORDS.indexOf(named[1]) + 1 : MONTH_ABBRS.indexOf(named[2].replace(/\s/gu, "")) + 1;
    if (y === null) return "";
    if (idx === m) return null;
    return idx > m ? monthKey(y, idx) : monthKey(y + 1, idx);
  }
  if (TIMING_YEAR_END_RE.test(text)) return y === null || m >= 11 ? null : `${y}-11`;
  if (TIMING_SOON_RE.test(text)) return null;
  return TIMING_VAGUE_LATER_RE.test(text) ? "" : null;
}
// ตรวจซ้ำรอบสุดท้าย 12 ต.ค. (HIGH): "ใช้มาตั้งแต่ต้นปี" / "ตั้งแต่มีนา" / "เมื่อเดือนกันยา" เป็นอดีต ไม่ใช่ช่วงที่จะเริ่มเรียน
// = เจอคำบอกอดีตแม้คำเดียว ไม่นับ · และต้องมีคำบอกอนาคต (ปีหน้า/เดือนหน้า/อีก N เดือน/ไม่รีบ ฯลฯ) หรือคำบอกเจตนา
// (จะ/น่าจะ/สะดวก/ว่าง/เริ่ม/ช่วง…) หรือลูกแพรเพิ่งถามช่วงเวลาเอง — ไม่งั้นคงการชวนรอบตามเดิม (production)
const TIMING_PAST_RE = /ตั้งแต่|เมื่อ(?!ไหร่|ไร|ไหร|ใด)|มาแล้ว|ที่แล้ว|เพิ่ง|ใช้มา|ผ่านมา|ก่อนหน้า/u;
const TIMING_EXPLICIT_FUTURE_RE = /ปีหน้า|เดือนหน้า|อีก\s?\d{1,2}\s?(?:-\s?\d{1,2}\s?)?เดือน|ไม่รีบ|อีกสักพัก|อีกหลายเดือน|ยังไม่ใช่ช่วงนี้/u;
const TIMING_INTENT_RE = /จะ|น่าจะ|คง|ตั้งใจ|อยาก|สะดวก|พร้อม|ว่าง|เริ่ม|ไว้|ค่อย|ช่วง|ประมาณ|รอ(?!บ)/u;
const BOT_ASKED_TIMING_RE = /ช่วงไหน|เมื่อไหร่|เดือนไหน|เริ่ม(?:เรียน)?(?:ช่วง|ตอน|เมื่อ)|สะดวก(?:เริ่ม|เรียน)?(?:ช่วง|เดือน)/u;
function statedTimingOf(text, todayIso, rounds = [], labels = [], lastBotText = "") {
  const value = String(text || "");
  if (TIMING_PAST_RE.test(value)) return null;
  if (!TIMING_EXPLICIT_FUTURE_RE.test(value) && !TIMING_INTENT_RE.test(value) && !BOT_ASKED_TIMING_RE.test(String(lastBotText || ""))) return null;
  const from = timingFrom(value, todayIso);
  if (from === null) return null;
  const label = truncateCodePoints(value.replace(/\s+/gu, " ").trim(), TIMING_LABEL_CHARS);
  const roundLabels = from ? labels.filter((_, i) => String(rounds[i]?.date || "").slice(0, 7) >= from) : [];
  return { label, from, roundLabels };
}

// คำตัดสินราคาของเทิร์นที่ v3 เขียน (พี่ง้วง 12 ต.ค. ข้อ 6): คนที่รู้จักแล้วถามราคาตรง ๆ ครั้งแรก = แบ่งรับด้วยคุณค่า (priceDisclosure.withValueHedge)
// ตัดสินหลังรู้ข้อเท็จจริงของเทิร์นแล้ว เพราะข้อยกเว้นบางข้อต้องอ่านข้อเท็จจริงของ v3 (รับข้อเสนอในข้อความเดียวกัน · เลือกรอบ · รู้ครบแล้ว —
// stage.valueHedgeExemptOf) · ถามซ้ำตรวจจากประวัติยาวของ session · เครื่องเดิมใช้คำตัดสินเดิมทุกไบต์
// ไปป์ไลน์ใช้ facts.disclosure ปักหมุดแบ่งรับหลังส่ง (เฉพาะเมื่อ v3 เขียนคำตอบเองจริง)
function v3DisclosureOf(facts) {
  const original = facts.disclosure;
  const hedged = withValueHedge(original, { text: facts.text, history: facts.longHistory, inboundFlags: facts.inboundFlags });
  if (hedged === original) return original;
  const exempt = valueHedgeExemptOf(facts);
  if (!exempt) return hedged;
  facts.valueHedgeExempt = exempt;
  return original;
}

// ช่องเติมของเทิร์นนี้ — ตัวเลขทุกตัวผ่านชุดอนุมัติแล้ว · ขาดตัวไหน = เทิร์นนี้กลับเครื่องเดิม
function slotValuesFor(decision, facts, input, deps) {
  const values = {};
  if (decision.stage === "FIRST_CONTACT" || (decision.stage === "SCREEN_PRICE" && decision.ladder)) {
    const withImage = facts.allowedImages.has(LADDER_IMAGE_KEY) && (!facts.sentImageKeys.includes(LADDER_IMAGE_KEY) || facts.asksImage);
    values.บันได = renderLadder(facts.address, { withImage });
  }
  if (["PRICE", "DEAL_SINGLE", "DEAL_PAIR"].includes(decision.stage)) {
    const pf = priceFactsFromKnowledge(input.knowledgeEntries || [], input.approvedAmounts);
    const withPromo = facts.disclosure.withPromo === true;
    if (!pf.ok || (decision.stage !== "PRICE" && !withPromo)) return null;
    if (decision.stage === "DEAL_PAIR" && !facts.classKey) return null;
    if (decision.stage === "DEAL_PAIR") values.ดีล = dealSlotValue(pf, decision, facts);
    else values.ราคา = renderPriceSlot(pf, { products: priceProducts(facts.classKey, facts.text, { levelKnown: facts.routing?.level != null, wished: facts.classWished,
      beyondLevel: facts.wishBeyondLevel, discussed: Boolean(facts.discussedClassKey) }), withPromo });
    if (!values.ดีล && !values.ราคา) return null;
    const check = typeof deps.checkOutbound === "function" ? deps.checkOutbound(values.ดีล || values.ราคา) : { ok: true };
    if (check?.ok === false) return null;
  }
  // พี่ง้วง 12 ต.ค.: รีวิวคนจริงที่ตัวตัดสินของเทิร์นเลือก (socialProof) ก่อน — จังหวะให้กำลังใจ/ข้อกังวลยังใช้ตัวเลือกหลักฐานเดิมได้
  const review = facts.socialProof?.review || ((decision.stage === "REASSURE" || decision.stage === "OBJECTION") ? facts.review : null);
  if (review) values.รีวิว = renderReviewSlot(review);
  if (facts.socialProof?.trial?.url) values.ทดลองเรียน = trialInviteBubble(facts.socialProof.trial.url);
  return values;
}

// พี่ง้วง 12 ต.ค. (รูป/รีวิวคนจริงตามบทสนทนา + ชวนทดลองเรียนฟรีจำกัดสิทธิ์ต่อวัน) — ตัวตัดสินอยู่ที่ socialProof.mjs
// บัญชีของที่ห้องนี้ได้แล้ว: ลิงก์รีวิวทั้งหมดของห้อง (DB) · รูป 7 วันของ session + รูปบรรยากาศทุก session · คลังรีวิวจากการ์ดของสมองรุ่นที่ใช้อยู่
// · รูปในก้อนล่าสุดของลูกแพร (lastBurstImageKeys — เว้นจังหวะรูปบรรยากาศ)
function socialProofOf(input, facts, decision) {
  return planChatSocialProof({
    facts, decision,
    catalog: reviewCatalogOf({ entries: input.knowledgeEntries || [], knowledgeText: input.approvedKnowledge || "" }),
    sentUrls: input.reviewContext?.sentUrls instanceof Set ? input.reviewContext.sentUrls : new Set(),
    imageKeys: [...(facts.sentImageKeys || []), ...(Array.isArray(input.sentAtmosphereKeys) ? input.sentAtmosphereKeys : [])],
    allowedImages: facts.allowedImages, personaType: String(input.reviewContext?.personaType || ""),
    trialInvite: input.trialInvite || null, deferSaid: followupStopSignal(facts.text) === "defer",
    lastBurstImages: Array.isArray(input.lastBurstImageKeys) ? input.lastBurstImageKeys : [],
  });
}

/**
 * @returns {{ok: boolean, reason: string, facts?: object, decision?: object, slots?: object}}
 */
export function buildTurnFacts(input = {}) {
  const deps = input.deps || {};
  const s = signalsOf(input);
  let contextEnvelope = contextEnvelopeFor(input, s);
  const facts = { ...s, ...assetsOf(input, s, deps), ...roomOf(input, s, contextEnvelope), contextEnvelope,
    pendingOffer: contextEnvelope.pendingOffer };
  facts.priceClassNames = priceProducts(facts.classKey, facts.text, { levelKnown: facts.routing?.level != null, wished: facts.classWished,
    beyondLevel: facts.wishBeyondLevel, discussed: Boolean(facts.discussedClassKey) })
    .map((key) => CLASS_NAMES[key]).join(" และ ");
  facts.teamNotes = teamNotesOf(deps, input.handoffNotes);
  // ชื่อที่เรียกได้อยู่ในบันไดสองบรรทัดของ persona แล้ว — คำทักทายไม่เรียกซ้ำ (ด่านชื่อตัดครั้งที่สองทิ้งกลางบันได)
  facts.nameInGreeting = false;
  // รอบที่ลูกค้าเลือกไว้แล้วในห้องนี้ (ก่อนเทิร์นนี้) — feedback ทีม 10 ต.ค.: เลือกรอบแล้วยังถูกถามยืนยันรอบซ้ำ · บอกจะสมัครหลังเลือกรอบ = ขั้นสมัคร
  facts.pickedRound = pickedRoundOf(facts.longHistory, facts.allRounds);
  // รอบรีวิว 12 ต.ค.: ข้อความเปิดห้องที่จะสมัครแล้วบอกรอบมาด้วย ("สมัครเรียนค่ะ รอบ 31 ต.ค.") — รอบที่เปิดอยู่จริงเท่านั้น
  facts.enrollRound = facts.enrollOpening ? enrollRoundNamed(facts.text, facts.allRounds) : null;
  facts.statedTiming = statedTimingOf(facts.text, facts.todayIso, facts.rounds, facts.roundLabels, lastBotBurstOf(facts.history || []));
  // พี่ง้วง 12 ต.ค. ข้อ 6: คำตัดสินราคาของเทิร์นที่ v3 เขียน (แบ่งรับด้วยคุณค่า + ข้อยกเว้น) — ก่อนตัดสินจังหวะ
  facts.disclosure = v3DisclosureOf(facts);
  // ข้อ 6 รอบรีวิว 2: ราคาที่ค้าง + มากันสองสามท่าน = ดีลคู่ได้เฉพาะเมื่อมีดีลคู่ที่อนุมัติของคลาสนี้
  if (facts.disclosure?.owed && [2, 3].includes(facts.routing?.headcount)) facts.pairDealAvailable = pairDealAvailableFor(input, facts);
  const decision = decideStage(facts);
  // ข้อความเปิดห้องที่บอกว่าจะสมัคร (ไม่รู้คลาส) = คลาสพื้นฐานพร้อมรอบของคลาสนั้น (ตัดสินหลังจังหวะ — จังหวะนี้ไม่ได้ใช้คลาส)
  // · บอกรอบที่เปิดมาในข้อความเปิดห้อง = รอบนั้นคือรอบที่เลือก (งานรับรอบแล้วไปขั้นสมัคร ไม่ถามรอบซ้ำ)
  if (decision.enrollOpening) Object.assign(facts, enrollOpeningClass(facts));
  if (decision.reason === "enroll_opening_round") facts.pickedRound = facts.enrollRound ? roundLabel(facts.enrollRound) : facts.requestedDate?.label || "";
  contextEnvelope = contextEnvelopeFor(input, facts, decision);
  facts.contextEnvelope = contextEnvelope;
  facts.pendingOffer = contextEnvelope.pendingOffer;
  // ลูกค้ารับข้อเสนอส่งรายละเอียดการสมัคร / เลือกรอบแล้วบอกจะสมัคร = ขั้นตอนปิดการขายของเครื่องเดิม (v3 ไม่มีข้อมูลชำระเงิน/เอกสาร)
  if (ENROLL_HANDOVER_REASONS.includes(decision.reason)) return { ok: false, reason: "enroll_accept" };
  // รีวิวเคสจริงทั้งวัน 5 ต.ค.: คำรับหลังลาไปป์ไลน์ตัดจบก่อนถึงตรงนี้แล้ว (ไม่คิด ไม่ส่ง) — ถ้ามาถึง (ข้อความที่พักไว้ตอนห้องสีเหลือง
  // ทำให้ไปป์ไลน์เห็นข้อความมากกว่านี้) v3 ไม่ร่าง ให้เครื่องเดิมตอบข้อความที่พักไว้แทน (พลาดไปทางตอบ ไม่ใช่ทางเงียบ)
  if (decision.stage === "SILENT") return { ok: false, reason: "silent_ack" };
  // รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): มาคนเดียวแล้วบอกว่าค่าเรียนไม่ไหว = บอกทางมาเป็นคู่ได้เฉพาะตอนมีดีลคู่ที่อนุมัติในคลังความรู้
  if (decision.alone) facts.pairDealAvailable = pairDealAvailableFor(input, facts);
  // รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิวสอง): ไม่สนใจ "คลาสนี้" = เอ่ยถึงอีกคลาสได้เฉพาะตอนระดับที่รู้ชี้ไปที่อีกคลาส (ระดับ 5 = Workflow · 1–4 = Business)
  // ไม่รู้ระดับ = ไม่เดาว่าอีกคลาสเหมาะ
  if (decision.classDeclined) {
    const declined = classInText(facts.text) || recommendedClassOf(facts.longHistory) || facts.classKey || null;
    const other = declined ? (declined === "workflow" ? "business" : "workflow") : null;
    const level = facts.routing?.level ?? facts.impliedLevel?.level ?? null;
    const levelClass = Number.isInteger(level) ? (level >= 5 ? "workflow" : "business") : null;
    facts.otherClassFit = Boolean(other && levelClass === other);
    facts.otherClassName = other ? CLASS_NAMES[other] : "";
  }
  facts.nameInLadder = (decision.stage === "FIRST_CONTACT" || (decision.stage === "SCREEN_PRICE" && decision.ladder))
    && !facts.address.generic && facts.address.mayUseName;
  // ทักครั้งแรกที่ต้องแจ้งราคาเลย (ลูกค้าบอกชื่อ/บ่นถูกถามเยอะ) = ทั้งบันไดและราคา — เครื่องเดิมถือถ้อยคำนี้
  if (decision.stage === "FIRST_CONTACT" && facts.disclosure.mode === "quote" && facts.money) {
    return { ok: false, reason: "first_contact_quote" };
  }
  facts.socialProof = socialProofOf(input, facts, decision);
  const slotsOf = (sp) => openSlotsFor(decision, { hasReview: Boolean(facts.review), socialReview: Boolean(sp.review), trialInvite: Boolean(sp.trial) });
  let { open, required } = slotsOf(facts.socialProof);
  const values = slotValuesFor(decision, facts, input, deps);
  if (!values) return { ok: false, reason: "price_facts_missing" };
  // คำชวนทดลองเรียนฟรี: จองสิทธิ์ของวันนี้ก่อนร่าง (อะตอมมิก) — ไม่ได้สิทธิ์ (ครบเพดาน/ห้องได้ไปแล้ว) = เทิร์นนี้ไม่ชวน
  if (facts.socialProof.trial) {
    let reserved = null;
    try { reserved = typeof deps.reserveTrialInvite === "function" ? deps.reserveTrialInvite() : null; } catch { reserved = null; }
    if (reserved?.ok !== true) {
      facts.socialProof = { ...facts.socialProof, trial: null, trialTrigger: "", skipped: `trial_${reserved?.reason || "unavailable"}` };
      delete values.ทดลองเรียน;
      ({ open, required } = slotsOf(facts.socialProof));
    }
  }
  return {
    ok: true, reason: "v3", facts, decision,
    slots: { open, required, values },
    ownerLessonText: String(input.ownerLessonText || ""),
    userText: String(input.userText ?? s.text),
    history: Array.isArray(input.history) ? input.history : [],
    knowledgeEntries: input.knowledgeEntries || [],
    contextEnvelope,
    guardTurn: input.guardTurn,
    customerId: String(input.customerId || ""),
    brainVersionId: input.brainVersionId || "",
    mirrorRoomId: input.mirrorRoomId || "",
  };
}
