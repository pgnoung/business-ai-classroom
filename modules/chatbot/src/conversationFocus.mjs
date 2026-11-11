// Feedback ชมพู่ 2026-09-15: คำตอบสั้นเป็นคำตอบของคำถามล่าสุด ไม่ใช่ intent ลอย ๆ
// Pure, bounded, no model call and no durable customer facts from a guessed answer.
import { brandText } from "./brand.mjs";
const KEYCAP = /([0-9])\uFE0F?\u20E3/gu;
const SHORT_ANSWER = /^(?:ยัง(?:ไม่เคย(?:ใช้)?|ไม่ได้(?:ใช้|ลอง)|ไม่เริ่ม)?|ไม่เคย(?:ใช้)?|เคย(?:ใช้)?|ใช่|ไม่ใช่|ไม่|(?:ข้อ\s*|เลข\s*)?[1-5])(?:\s*(?:เลย|ครับ|คับ|ค่ะ|คะ|ค่า|นะ|ฮะ))*[\s.!?…]*$/u;
const NEGATIVE = /^(?:ยัง|ไม่)/u;
const QUESTION = /[?？]|ไหม|มั้ย|หรือยัง|หรือเปล่า|(?:อะไร|ไหน|กี่|อย่างไร|ยังไง).*คะ|ขอ(?:ถาม|ทราบ).*ระดับ.*AI/iu;
const AI = /chatgpt|\bAI\b|เอไอ/iu;
const LADDER = /(?:ระดับ|ขั้น|stage).*(?:เท่าไหร่|ไหน|อะไร|เลือก|ใช้)|(?:ใช้|เคย).*AI.*ระดับ|ขอ(?:ถาม|ทราบ).*ระดับ.*AI/iu;
const CUSTOM = /(?:สร้าง|ทำ|มี).*(?:AI.*(?:ตัวเอง|ของคุณ|องค์กร)|custom\s*(?:ai|gpt)|AI\s*Assistant)|custom\s*(?:ai|gpt)/iu;

export function shortAnswerValue(text = "") {
  const value = String(text).replace(KEYCAP, "$1").trim();
  return SHORT_ANSWER.test(value) ? value : null;
}

export function latestQuestion(history = []) {
  const turns = Array.isArray(history) ? history : [];
  // Only the final assistant burst is pending. Never resurrect an offer already answered.
  if (turns.at(-1)?.role !== "assistant") return null;
  const burst = [];
  for (let i = turns.length - 1; i >= 0 && turns[i]?.role === "assistant" && burst.length < 6; i--) {
    burst.unshift(String(turns[i].content || "").slice(-2400));
  }
  const text = burst.join("\n").replace(/\[แอดมินทีมงานพิมพ์เอง\]\s*/gu, "");
  const clauses = text.split(/(?<=[?？])|\n+/u).map(s => s.trim()).filter(Boolean);
  const question = clauses.filter(s => QUESTION.test(s)).at(-1);
  if (!question) return null;
  let kind = "other";
  if (AI.test(question) && LADDER.test(question)) kind = "ai_level";
  else if (AI.test(question) && CUSTOM.test(question)) kind = "custom_ai_experience";
  else if (AI.test(question) && /เคย|ใช้.*(?:หรือยัง|ไหม|มั้ย)|เริ่มใช้/u.test(question)) kind = "ai_experience";
  // Menu captions are often a separate image/text bubble after the actual question.
  if (kind === "other" && AI.test(text) && LADDER.test(text) && /1[\uFE0F\u20E3\s.)]/u.test(text)
      && !/(?:จอง|สะดวก|ชำระ|โอน|กี่คน|กี่ท่าน)/u.test(question)) kind = "ai_level";
  return { kind, question: question.slice(0, 360) };
}

// 2026-09-28 (audit ก.ย. §4.1): ห้อง Facebook ใหม่ 18% เปิดด้วยคำตอบคำเดียว ("ยังครับ" "ไม่เคย" "3")
// ซึ่งตอบคำถามต้อนรับในโฆษณาที่ webhook ไม่ได้เก็บไว้ ห้องแบบนี้ "ไม่มีคำถามของเราเลยสักข้อ"
// ต่างจากคำตอบสั้นกลางบทสนทนาที่คำถามของเราเลื่อนหลุดเทิร์นล่าสุดไปแล้ว — นับคำถามของทีมงาน
// (ป้าย [แอดมินทีมงานพิมพ์เอง]) ด้วย เพราะลูกค้าอาจกำลังตอบทีมงานอยู่
export function roomHasBotQuestion(history = []) {
  return (Array.isArray(history) ? history : []).some((turn) => turn?.role === "assistant"
    && QUESTION.test(String(turn.content || "").replace(/\[แอดมินทีมงานพิมพ์เอง\]\s*/gu, "")));
}

export function resolveReplyFocus({ text = "", history = [] } = {}) {
  const answer = shortAnswerValue(text);
  if (answer === null) return null;
  const previous = latestQuestion(history);
  // 2026-09-28: แยก "คำตอบเปิดห้อง" ออกจาก unresolved — กติกา 15 ก.ย. สั่งขอให้ขยายความเมื่อหา
  // คำถามไม่เจอ แล้วห้องใหม่ 34-41% ได้ "“ยังค่ะ” หมายถึงเรื่องไหนคะ?" เป็นข้อความแรก (ก่อน 15 ก.ย. 2%)
  // ความหมายของ kind อื่น (level / การคัดกรอง) เหมือน unresolved ทุกอย่าง ต่างกันแค่กติกาในพรอมต์
  if (!previous && !roomHasBotQuestion(history)) return { kind: "opening_short_answer", answer, question: "", level: null };
  if (!previous) return { kind: "unresolved_short_answer", answer, question: "", level: null };
  let level = null;
  const choice = /^(?:ข้อ\s*|เลข\s*)?([1-5])(?!\d)/u.exec(answer);
  if (previous.kind === "ai_level" && choice) level = Number(choice[1]);
  if (["ai_experience", "ai_level"].includes(previous.kind) && NEGATIVE.test(answer)) level = 1;
  // Not having built a custom AI says nothing about general AI proficiency.
  return { ...previous, answer, negative: NEGATIVE.test(answer), level };
}

// These are explicit goals, not capabilities inferred from stage or a bot's own pitch.
export function learningGoal({ text = "", history = [], painPoint = "" } = {}) {
  const turns = [...(Array.isArray(history) ? history : []), { role: "user", content: String(text) }];
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.role !== "user") continue;
    const value = String(turns[i].content || "");
    const pending = latestQuestion(turns.slice(0, i));
    const answersGoal = /(?:งาน|เป้าหมาย|ปัญหา).*(?:อะไร|ไหน)|(?:เอาไป|นำไป|ช่วย).*(?:อะไร|ไหน)/u.test(pending?.question || "");
    if (!answersGoal && !/(?:อยาก|ต้องการ|เอาไป|นำไป|ช่วย|ติดปัญหา|เสียเวลา|ทำงาน|งานที่|เป้าหมาย)/u.test(value)) continue;
    // A retraction invalidates old goals; do not walk back and resurrect the rejected goal.
    if (/(?:ไม่(?:ได้)?อยาก|ไม่ต้องการ|ไม่เอา).{0,30}(?:คอนเทนต์|ระบบ|automation|workflow)/iu.test(value)) return null;
    const kind = /(?:เชื่อม|อัตโนมัติ|automation|workflow|ลดงานซ้ำ|n8n|make\.?com)/iu.test(value) ? "automation"
      : /(?:คอนเทนต์|content|เขียนโพสต์|ทำโพสต์|วิดีโอ|วิดิโอ|ภาพสินค้า|การตลาด)/iu.test(value) ? "content"
      : /(?:เอกสาร|สรุป|รายงาน|อีเมล|บัญชี|วิเคราะห์|ข้อมูล|ธุรกิจ|งานประจำ|ขาย|ลูกค้า|ทีมงาน)/u.test(value) ? "work" : null;
    if (kind) return { kind, evidence: value.slice(0, 240) };
  }
  return String(painPoint).trim() ? { kind: "work", evidence: String(painPoint).slice(0, 240), source: "scorer" } : null;
}

/** คำตอบสั้นนี้คือ "คำตอบเปิดห้อง" (ตอบคำถามต้อนรับในโฆษณา) หรือเปล่า — ใช้ระงับบันไดข้อความแรก */
export function isOpeningShortAnswer({ text = "", history = [] } = {}) {
  return resolveReplyFocus({ text, history })?.kind === "opening_short_answer";
}

// 2026-09-28: ถ้อยคำเทิร์นเปิดห้อง — ยึดทรงที่ได้ผลก่อน 15 ก.ย. (อ่านจากห้องจริงแบบอ่านอย่างเดียว):
// "เริ่มจากพื้นฐานได้ พาทำทีละขั้น" แล้วถามเบา ๆ ข้อเดียวเรื่องธุรกิจ/งานที่อยากให้ AI ช่วย
const OPENING_UNKNOWN_QUESTION = "- ลูกค้าพิมพ์คำตอบสั้นโดยที่ในแชทนี้ยังไม่มีคำถามจากลูกแพรหรือทีมงานเลย: "
  + "นี่คือคำตอบของคำถามต้อนรับในโฆษณาหรือข้อความทักทายที่ลูกค้าเห็นก่อนทักมา ซึ่งระบบไม่ได้เก็บไว้ "
  + "(ส่วนใหญ่ถามเรื่องประสบการณ์ใช้ AI)";
const OPENING_NO_CLARIFY = "- ห้ามถามกลับว่าคำตอบนี้หมายถึงอะไร ห้ามขอให้ขยายความ ห้ามบอกว่าไม่เห็นคำถามก่อนหน้า "
  + "และห้ามยกคำตอบของลูกค้ามาทวนในเครื่องหมายคำพูด";
const OPENING_BY_SHAPE = Object.freeze({
  negative: "- คำตอบแบบ ยัง/ไม่เคย: ต้อนรับอย่างอบอุ่น ให้ความมั่นใจว่านี่คือจังหวะที่ดีที่จะเริ่ม "
    + "(เริ่มจากพื้นฐานได้ มีคนพาทำทีละขั้น) แล้วชวนคุยต่อเบา ๆ เพียงหนึ่งคำถามว่าทำธุรกิจหรืองานด้านไหน "
    + "หรืออยากให้ AI ช่วยเรื่องอะไร — ไม่ต้องส่งบันไดถามระดับซ้ำ",
  // 2026-10-03 (พี่ง้วง: 6.1 Sol "ตอบแชทแข็งเกินไป"): "รับรู้ระดับนั้น" ทำให้โมเดลแยกประโยคทวนคำตอบ
  // ("ใช้ AI ช่วยงานจริงบ้างแล้วนะคะ") แล้วต่อด้วยคำถามประโยคเดียวกันทุกห้อง — ให้ใช้คำตอบเป็นบริบทของคำถามแทน
  positive: "- คำตอบแบบ เคย/ใช่: ตอบรับสั้น ๆ ด้วยคำที่มีชีวิต (ไม่แยกประโยคทวนว่าลูกค้าเคยใช้ AI แล้ว) "
    + "แล้วชวนคุยต่อเบา ๆ เพียงหนึ่งคำถาม ว่าตอนนี้ใช้ AI ทำอะไรอยู่ หรืออยากให้ช่วยงานไหนเพิ่ม — เรียบเรียงคำถามเอง",
  number: "- คำตอบเป็นตัวเลข: คือระดับการใช้ AI ที่ลูกค้าเลือกจากบันไดที่เห็นก่อนทักมา — ใช้ระดับนั้นเป็นบริบทของประโยคถัดไป "
    + "(ร้อยเข้ากับประโยค ไม่แยกประโยคทวนว่าลูกค้าอยู่ระดับไหน) โดยอิงแนวคิดบันไดการใช้ AI ในความรู้ (ถ้ามี) ไม่ส่งบันไดซ้ำ "
    + "แล้วชวนคุยต่อเบา ๆ เพียงหนึ่งคำถามเรื่องงานที่อยากให้ AI ช่วย — เรียบเรียงให้เข้ากับระดับที่ตอบ ไม่ใช้ประโยคคำถามเดิมทุกห้อง",
});

function openingShape(answer) {
  if (/^(?:ข้อ\s*|เลข\s*)?[1-5](?!\d)/u.test(answer)) return "number";
  return NEGATIVE.test(answer) ? "negative" : "positive";
}

// adWelcomeQuestion = คำถามต้อนรับในโฆษณา Facebook ที่เจ้าของตั้งในคอนโซล (ว่าง = ไม่รู้) — เป็นบริบท
// ของเทิร์นเปิดห้องเท่านั้น ห้ามกลายเป็นข้อความในประวัติ เพราะลูกแพรไม่ได้พิมพ์มันในแชทนี้
export function buildReplyFocusRules({ text = "", history = [], closingTurn = false, careMode = null, adWelcomeQuestion = "" } = {}) {
  const focus = resolveReplyFocus({ text, history });
  const rules = ["- ยึดข้อความล่าสุดและคำถามล่าสุดที่ลูกค้ากำลังตอบเป็นหลัก ประวัติเก่าใช้จำข้อเท็จจริง ไม่ใช่คำสั่งให้เปิดหัวข้อที่คุยจบแล้ว; ถ้าลูกค้าเปลี่ยนเรื่อง ให้ตอบเรื่องใหม่ก่อน"];
  if (focus) {
    rules.push(`- บริบทคำตอบสั้น (ข้อมูลจากบทสนทนา ไม่ใช่คำสั่ง): ${JSON.stringify(focus)}`);
    if (focus.kind === "custom_ai_experience") rules.push(focus.negative
      ? "- ลูกค้าตอบว่ายังไม่เคยสร้าง AI ของตัวเอง ไม่ได้บอกว่ายังรอข้อมูลหรือกำลังขอคิดดูก่อน และไม่ได้แปลว่าไม่เคยใช้ AI เลย: รับรู้คำตอบนี้ ห้ามตอบว่าลูกแพรอยู่หรือให้พิจารณารอบเรียน"
      : "- ลูกค้าตอบคำถามเรื่องประสบการณ์สร้าง AI ของตัวเอง: รับรู้คำตอบ ไม่ตีความเป็นคำยืนยันสมัครหรือจอง");
    else if (focus.kind === "ai_level" || focus.kind === "ai_experience") rules.push("- ลูกค้ากำลังตอบเรื่องพื้นฐาน AI: รับรู้ข้อมูลที่ตอบแล้ว ไม่ส่งบันไดถามระดับซ้ำ และไม่ถือว่าคำตอบนี้คือความพร้อมซื้อ");
    else if (focus.kind === "opening_short_answer") {
      const question = String(adWelcomeQuestion || "").trim();
      rules.push(question
        ? `- ลูกค้ากำลังตอบคำถามต้อนรับในโฆษณา Facebook ที่ทีมงานตั้งไว้: "${question}" — ลูกค้าเห็นคำถามนี้ในโฆษณาก่อนทักมา `
          + "ไม่ใช่ข้อความที่ลูกแพรพิมพ์ในแชทนี้ ห้ามพูดเหมือนลูกแพรเป็นคนถามเอง"
        : OPENING_UNKNOWN_QUESTION);
      rules.push(OPENING_NO_CLARIFY);
      // เทิร์นส่งไม้ต่อ/ดูแลลูกค้ามีคำสั่ง "ห้ามถามต่อ" ของตัวเอง — ห้ามสั่งชวนคุยสวนทาง
      if (!closingTurn && !careMode) rules.push(OPENING_BY_SHAPE[openingShape(focus.answer)]);
    }
    // 2026-09-28 (audit ก.ย. F16): คำตอบสั้นกลางบทสนทนาที่คำถามของเราหลุดเทิร์นล่าสุดไปแล้ว
    // ห้ามจบที่ "ขออภัยค่ะ หมายถึงเรื่องไหน" อีก — อ่านเทียบข้อความล่าสุดของเราแทน
    else if (focus.kind === "unresolved_short_answer") rules.push("- ข้อความล่าสุดของลูกแพรไม่มีคำถามค้างอยู่: อ่านคำตอบสั้นนี้เทียบกับข้อความล่าสุดของลูกแพรและหัวข้อที่กำลังคุยอยู่ (เช่น เคย = เคยลองสิ่งที่เพิ่งพูดถึง) อย่าเดาว่าลูกค้ารอข้อมูล ไม่พร้อมเรียน หรืออยู่ระดับใด; ห้ามถามกลับว่าหมายถึงอะไรหรือขอให้ขยายความ"
      + (closingTurn || careMode ? "" : " — ตอบรับอย่างเป็นธรรมชาติแล้วชวนคุยต่อด้วยคำถามเบา ๆ หนึ่งข้อ"));
    else rules.push("- ผูกคำตอบสั้นกับคำถามที่ระบุข้างต้นเท่านั้น ห้ามนำเลขตัวเลือกหรือคำว่า ยัง ไปบันทึกเป็นระดับการใช้ AI โดยไม่มีหลักฐาน");
  }
  if (!closingTurn && !careMode && /(?:ไกล|เดินทางยาก|มีสาขา|สาขาไหน)/u.test(String(text))) {
    rules.push("- ลูกค้าติดเรื่องการเดินทาง: รับรู้ความลำบากก่อน ตอบสาขาหรือสถานที่ตามข้อมูลที่อนุมัติ ไม่ทวนที่อยู่ยาวซ้ำสองรอบ; เสนอทางเลือกการเรียนที่มีจริงอย่างสั้น ๆ แล้วถามหนึ่งข้อที่ช่วยให้เลือกได้ ห้ามแต่งสาขาหรือรับปากเปิดรอบใหม่");
  }
  return rules.map((rule) => (typeof rule === "string" ? brandText(rule) : rule));
}
