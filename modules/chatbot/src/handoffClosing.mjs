// handoffClosing.mjs — เทิร์นส่งไม้ต่อต้องจบด้วย "สิ่งที่จะเกิดต่อ" ไม่ใช่คำถาม
// (audit ก.ย. 2026 §6.3 · บัญชีคำติ #4 #43 · fix-spec F13)
//
// เคสจริง: ลีด in-house 12 คนให้ชื่อบริษัท + เบอร์ตอนตี 3 วันอาทิตย์ ลูกแพรตอบ "…สะดวกให้ทีมผู้ดูแล
// ติดต่อกลับช่วงวันและเวลาใดคะ?" แล้ว AI ปิดทันที (handoff_private_inhouse) — คำตอบของลูกค้าไม่มีใคร
// รับ 19 ชม. เทิร์นส่งต่องาน project มีคำถามค้าง 5 ใน 6 ครั้งของเดือน ก.ย. เพราะนโยบาย handoffAnyOf
// ส่งต่อทันทีที่ได้ข้อมูลอย่างใดอย่างหนึ่ง แต่พรอมต์ของเทิร์นนั้นยังสั่ง "เก็บข้อมูลทีละหนึ่งคำถาม"
//
// ไฟล์นี้ไม่เปลี่ยน "ใคร/เมื่อไหร่ส่งต่อ" (นโยบายของเจ้าของ) และไม่เปิด AI คืน — ทำแค่สองอย่าง:
//   predictProjectHandoff = รู้ก่อนร่างว่าเทิร์นนี้จะถูกส่งต่อ โดยใช้ตัว normalize + ตัวสกัด slot
//                           แบบ deterministic ชุดเดียวกับที่ scorer ใช้ตัดสินหลังส่ง
//   enforceHandoffClosing = ด่านก่อนส่ง: ตัดประโยคคำถามทิ้ง และถ้าไม่มีประโยคบอกขั้นถัดไป ให้เติม
//                           ประโยคมาตรฐาน (ทีมงานจะติดต่อกลับ + ฝากรายละเอียดในแชทนี้ได้ตลอด)
import { brandText } from "./brand.mjs";
import { normalizeSalesSignals, PROJECT_OPPORTUNITY_TYPES } from "./salesPolicy.mjs";
import { countQuestions, mergeSentenceFragments } from "./replyDeliveryPolicy.mjs";
import { pauseSecondsForBubble } from "./humanizer.mjs";
import { latestQuestion } from "./conversationFocus.mjs";

// ช่องที่ทำให้ส่งต่อได้ (handoffAnyOf ของลูกแพร) — ใช้จำลอง "โมเดลของ scorer ยกข้อความทั้งท่อนเป็นหลักฐาน"
const HANDOFF_EVIDENCE_SLOTS = Object.freeze(["company_name", "contact_phone", "preferred_contact_time"]);
// คำตอบสั้นต่อคำถามเก็บข้อมูลของเรา ("บริษัท ฟอร์ด ขอนแก่นสหชัย") — ยาวกว่านี้คือการเล่าโจทย์
// ซึ่งการเดาจากคำว่า "บริษัท" กลางย่อหน้าจะปิดบทสนทนาทั้งที่ลูกค้ายังเล่าไม่จบ
const SHORT_ANSWER_MAX = 60;
// คำถามล่าสุดของเราขอช่องที่ทำให้ส่งต่อได้ — คำตอบสั้นถัดมาจึงน่าจะเป็นช่องนั้น (ไม่ใช่ "ทั้งองค์กร" ที่ตอบคำถามอื่น)
const ASKED_FOR_HANDOFF_SLOT = /ชื่อ(?:บริษัท|แบรนด์|ร้าน|องค์กร|หน่วยงาน|ผู้ติดต่อ|กิจการ)|เบอร์|วันเวลา|ช่วง(?:วัน|เวลา)|เวลาที่สะดวก|สะดวกให้\S{0,16}ติดต่อ/u;

function projectHandoffFrom(signals) {
  const opportunity = signals?.opportunity;
  if (!opportunity?.handoffOnComplete || !opportunity.handoffReady) return null;
  if (!PROJECT_OPPORTUNITY_TYPES.has(opportunity.type)) return null;
  return { type: opportunity.type, phoneKnown: Boolean(opportunity.slots?.contact_phone) };
}

/**
 * เทิร์นนี้คือเทิร์นส่งต่องาน project หรือเปล่า — scorer ตัดสินหลังตอบเสมอ จึงต้องทำนายก่อนร่าง
 *
 * บทเรียน 3 ก.ย. (13e233152 ถอนตัวทำนายรุ่นแรก): ทำนายพลาดได้ทั้งสองทาง — ตอบ "ไม่" กับชื่อบริษัท
 * แบบเปล่า ("บริษัท <ชื่อ>" ไม่มีคำจุดชนวนของตัวสกัด deterministic) และตอบ "ใช่" ทั้งที่ scorer ไม่ส่งต่อ
 * รุ่นนี้จึง (1) ใช้ normalizeSalesSignals ตัวเดียวกับ scorer ชั้น deterministic ก่อน (2) คำตอบสั้นที่
 * ไม่ใช่คำถาม ลองจำลองโมเดลยกข้อความทั้งท่อนเป็นหลักฐาน ผ่านตัวตรวจหลักฐานชุดเดียวกัน (ขอบบนของสิ่งที่
 * scorer ทำได้) และ (3) ไม่ปิดตาข่ายคำรับปาก — ทำนาย "ใช่" ผิดครั้งใด ทีมงานยังได้ใบงานจากคำว่า
 * "ทีมงานจะติดต่อกลับ" ตามเดิม ความผิดพลาดจึงไม่แย่กว่าบั๊กเดิม คืน null = เทิร์นปกติ
 */
export function predictProjectHandoff({ salesPolicy = null, salesState = null, text = "", history = [] } = {}) {
  const value = String(text || "").trim();
  if (!salesPolicy || !value) return null;
  try {
    const options = { customerText: value, latestCustomerText: value };
    const exact = projectHandoffFrom(normalizeSalesSignals({}, salesPolicy, salesState, options));
    if (exact || [...value].length > SHORT_ANSWER_MAX || isClosingQuestion(value)) return exact;
    if (!ASKED_FOR_HANDOFF_SLOT.test(latestQuestion(history)?.question || "")) return null;
    const quoted = Object.fromEntries(HANDOFF_EVIDENCE_SLOTS.map((slot) => [slot, { value, evidence: value }]));
    return projectHandoffFrom(normalizeSalesSignals({ opportunity: { slots: quoted } }, salesPolicy, salesState, options));
  } catch {
    return null;
  }
}

const NEXT_STEP = /(?:ทีมงาน|ทีมผู้ดูแล|ทีมดูแล|คุณชมพู่|ชมพู่)[^\n]{0,60}?(?:ติดต่อกลับ|ติดต่อ|ดูแลต่อ|เข้ามาดูแล|ยืนยันที่นั่ง|โทร)/u;
const URLISH = /(?:https?:\/\/|www\.)\S+/giu;
// "…ไหนคะ" "…เวลาใดคะ" "…หรือบ่ายคะ" — คะ (เสียงสูง) ท้ายประโยคคือคำถาม ส่วน "นะคะ" คือคำบอกเล่า
const QUESTION_KA_END = /(?<!นะ|น้า)คะ$/u;
const TRAILING_DECORATION = /[\s\p{Extended_Pictographic}️‍\p{Emoji_Modifier}.!…)]+$/u;

export function isClosingQuestion(sentence) {
  const text = String(sentence || "").replace(URLISH, " ").trim();
  if (!text) return false;
  if (/[?？]/u.test(text)) return true;
  if (countQuestions(text) > 0) return true;
  return QUESTION_KA_END.test(text.replace(TRAILING_DECORATION, ""));
}

// ตัดประโยคไทยตามคำลงท้าย/เครื่องหมาย แล้วเอาเศษที่ไม่มีตัวอักษร (emoji ท้ายประโยค) ไปต่อท้ายประโยคก่อน
function sentencesOf(line) {
  const parts = mergeSentenceFragments(String(line)
    .split(/(?<=(?:ค่ะ|นะคะ|ค่า|คะ|ครับ|นะครับ|[?？!])[\s)]*)\s+/u)
    .map((part) => part.trim())
    .filter(Boolean));
  const merged = [];
  for (const part of parts) {
    if (merged.length && !/\p{L}/u.test(part)) merged[merged.length - 1] += ` ${part}`;
    else merged.push(part);
  }
  return merged;
}

export function closingStatement(kind, { phoneKnown = false } = {}) {
  if (kind === "booking") return brandText("ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ");
  if (kind === "contact_team") {
    return brandText("ลูกแพรส่งเรื่องให้ทีมงานคนจริงเข้ามาดูแลต่อในแชทนี้แล้วนะคะ ระหว่างนี้ฝากรายละเอียดไว้ในแชทนี้ได้ตลอดเลยค่ะ");
  }
  return `ทีมงานผู้ดูแลโดยตรงจะติดต่อกลับ${phoneKnown ? "ตามเบอร์ที่ให้ไว้" : "ในแชทนี้"}นะคะ `
    + "ระหว่างนี้ถ้ามีรายละเอียดเพิ่มเติม ฝากไว้ในแชทนี้ได้ตลอดเลยค่ะ 🙏🏻";
}

const bubbleText = (bubble) => (typeof bubble === "string" ? bubble : String(bubble?.text ?? ""));
const withText = (bubble, text) => (typeof bubble === "string" ? text : { ...bubble, text });

/**
 * ด่านสุดท้ายก่อนส่งของเทิร์นส่งไม้ต่อ — ลบอย่างเดียว (ประโยคคำถาม) แล้วเติมประโยคขั้นถัดไป
 * เฉพาะเมื่อไม่เหลือประโยคแบบนั้นเลย บอลลูนที่ไม่มีคำถามคงไว้ทุกไบต์
 * @returns {{bubbles: Array, changed: boolean, removed: number, appended: boolean}}
 */
export function enforceHandoffClosing(bubbles = [], { kind = "project", phoneKnown = false } = {}) {
  let removed = 0;
  const kept = [];
  for (const bubble of Array.isArray(bubbles) ? bubbles : []) {
    const text = bubbleText(bubble);
    const lines = text.split("\n").map((line) => {
      if (!line.trim()) return line;
      const sentences = sentencesOf(line);
      const survivors = sentences.filter((sentence) => !isClosingQuestion(sentence));
      removed += sentences.length - survivors.length;
      return survivors.length === sentences.length ? line : survivors.join(" ");
    });
    const next = lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
    if (next) kept.push(next === text ? bubble : withText(bubble, next));
  }
  let appended = false;
  if (!kept.some((bubble) => NEXT_STEP.test(bubbleText(bubble)))) {
    const statement = closingStatement(kind, { phoneKnown });
    const last = kept.at(-1);
    // ต่อท้ายบอลลูนสุดท้าย ไม่เพิ่มบอลลูนใหม่ (เพดานบอลลูนของ delivery policy ผ่านไปแล้ว)
    if (last !== undefined) kept[kept.length - 1] = withText(last, `${bubbleText(last)}\n\n${statement}`);
    else kept.push({ text: statement, pauseSec: pauseSecondsForBubble(statement, 0) });
    appended = true;
  }
  return { bubbles: kept, changed: removed > 0 || appended, removed, appended };
}

// พรอมต์ของเทิร์นส่งต่องาน project (ใช้แทนบรรทัด "เก็บข้อมูลทีละหนึ่งคำถาม" ในเทิร์นนั้นเท่านั้น)
export function projectHandoffClosingRule({ phoneKnown = false } = {}) {
  return brandText("- ลูกค้าให้ข้อมูลพอให้ทีมงานรับช่วงต่อแล้วในข้อความนี้ — ข้อความนี้คือข้อความสุดท้ายของลูกแพรก่อนทีมงาน"
    + "ผู้ดูแลโดยตรงรับช่วงต่อ: ขอบคุณและรับทราบข้อมูลที่ลูกค้าให้มาสั้น ๆ แล้วปิดท้ายด้วยการบอกว่าทีมงานผู้ดูแล"
    + `โดยตรงจะติดต่อกลับ${phoneKnown ? "ตามเบอร์ที่ให้ไว้" : "ในแชทนี้"} และระหว่างนี้ฝากรายละเอียดเพิ่มเติมไว้ในแชทนี้ได้ตลอด `
    + "· ข้อความนี้ต้องไม่มีคำถามเหลืออยู่เลย ไม่ขอข้อมูลเพิ่ม และไม่นัดวันเวลาโทรเอง เพราะหลังข้อความนี้ AI จะหยุดตอบ");
}

// ---- ตาข่ายหลังเทิร์นส่งต่องาน project (2026-09-28, eval กับสมองจริง) ----
// เทิร์นที่ทำนายว่าส่งต่อ ลูกค้าได้ยินแล้วว่า "ทีมงานผู้ดูแลจะติดต่อกลับ" แต่คนตัดสินส่งต่อจริงยังเป็น scorer
// หลังส่ง ถ้า scorer ล้ม (payload ใช้ไม่ได้ = ไม่ถึง maybeHandoffOpportunity) หรือตัดสินไม่ตรงกับที่ทำนาย
// ห้องจะไม่มีใครรู้ว่าต้องโทรกลับ — ตาข่ายคำรับปากเดิม (TEAM_PROMISE_RE) ก็พลาดได้: โมเดลเขียนจริงว่า
// "ทีมงานผู้ดูแล In-house Training โดยตรงจะติดต่อกลับ…" ซึ่งห่างเกินที่ตัวจับรู้จัก
// จึงตรวจ "หลัง scorer รอบที่เห็นเทิร์นนี้จบ" (สำเร็จหรือล้มก็ตาม): ส่งต่อแล้ว (NEEDS_HUMAN / AI ปิด) หรือ
// ตาข่ายเดิมเขียนโน้ตไปแล้ว = ไม่ทำอะไร · ไม่งั้น = โน้ต + audit promise_team_followup + push (เหตุเดียวกับตาข่ายเดิม)
export const PROJECT_PROMISE_NOTE = "⚠️ ลูกแพรบอกลูกค้าแล้วว่าทีมงานผู้ดูแลจะติดต่อกลับ (งาน in-house / private / บรรยาย) "
  + "แต่ระบบยังไม่ได้ส่งต่อให้ทีม — ต้องมีคนติดต่อกลับลูกค้ารายนี้\n(AI ยังคุยต่อให้อยู่ — โน้ตนี้ไม่ได้ปิดแชท)";

export function checkProjectPromise({ db, notifier = null, customerId, since = 0, noteAuthor = "ai_promise", logger = console } = {}) {
  try {
    const customer = db.getCustomer(customerId);
    if (!customer) return { skipped: "no_customer" };
    if (customer.state === "NEEDS_HUMAN" || customer.ai_enabled !== 1) return { skipped: "handed_off" };
    const noted = db.listHandoffNotes(customerId, 10)
      .some((note) => note.author === noteAuthor && Number(note.created_at) >= since);
    if (noted) return { skipped: "already_noted" };
    db.addHandoffNote({ customerId, author: noteAuthor, text: brandText(PROJECT_PROMISE_NOTE) });
    db.addAudit({
      operator: "system", action: "promise_team_followup", target: customerId,
      detail: "เทิร์นส่งต่องาน project บอกลูกค้าว่าทีมงานจะติดต่อกลับ แต่ scorer ไม่ได้ส่งต่อ — โน้ต + push",
    });
    notifier?.fireLater?.({
      customerId, channelId: customer.channel_id || "default", reason: "promise_team_followup",
      customerName: customer.known_name || customer.display_name || "",
    });
    return { alerted: true };
  } catch (err) {
    logger.error?.(`handoffClosing: ตรวจเทิร์นส่งต่องาน project ไม่สำเร็จ (${err?.message || err})`);
    return { skipped: "error" };
  }
}

// mark = ส่งเทิร์นส่งต่อสำเร็จแล้ว · settle = scorer รอบหนึ่งจบ (นับเฉพาะรอบที่เริ่มหลัง mark เท่านั้น
// รอบที่ค้างมาก่อนไม่ได้อ่านเทิร์นนี้) — เก็บในหน่วยความจำ: รีสตาร์ตกลางทางแล้วหายได้ (ตาข่ายชั้นสอง)
export function createProjectPromiseWatch({ db, notifier = null, noteAuthor = "ai_promise", logger = console, now = Date.now } = {}) {
  const pending = new Map();
  return {
    mark(customerId, since = now()) {
      pending.set(String(customerId), { markedAt: now(), since });
    },
    settle(customerId, runQueuedAt) {
      const key = String(customerId);
      const entry = pending.get(key);
      if (!entry || runQueuedAt < entry.markedAt) return { skipped: "not_due" };
      pending.delete(key);
      return checkProjectPromise({ db, notifier, customerId: key, since: entry.since, noteAuthor, logger });
    },
    get size() { return pending.size; },
  };
}
